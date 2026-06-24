/**
 * Post-edit hook handler: session recording and incremental re-indexing.
 *
 * Faithful TypeScript port of src/token_goat/hooks_edit.py (Layer 5 handler
 * module). `post_edit` runs after every Write, Edit, and MultiEdit tool call.
 * It does two things:
 *
 * 1. Session recording — marks the edited file in the per-session JSON cache
 *    so the compaction manifest knows which files changed, and so post-compact
 *    recovery can highlight them.
 *
 * 2. Incremental re-indexing — resolves the file to a project, appends its
 *    relative path to queue/dirty.txt, and nudges the background worker if its
 *    heartbeat file is stale. The worker drains the queue every 2 s, SHA-checks
 *    each file, and re-runs tree-sitter extraction only for changed files —
 *    avoiding a full-project walk on every keystroke.
 *
 * Failures at any step are logged but never raised; the hook always returns
 * CONTINUE so a broken index pipeline cannot interrupt the agent.
 *
 * Parity notes (Python -> TS):
 *  - threading.Thread (the daemon predictive-snapshot worker) ports to a
 *    main-thread async seam (see hooks_cli's watchdog handling). Python returns
 *    the started Thread so tests can .join(); TS returns a Promise that callers
 *    (and tests) can await. Running the body on the main microtask queue keeps
 *    a test's vi.spyOn on session/snapshots visible (a worker_threads worker
 *    would not see the test's mocks).
 *  - The `worker` module is NOT YET PORTED. It is reached through a fail-soft
 *    injection seam (`_setWorkerModule`, registered with reset.ts). When absent
 *    the nudge/enqueue steps degrade to no-ops and the hook still returns
 *    CONTINUE, matching the Python fail-soft contract.
 *  - pathlib.Path operations -> node:path + node:fs. Path.relative_to/ValueError
 *    -> an explicit containment check that returns null (the ValueError branch).
 *  - All swallowed Python `except Exception`/`except OSError` blocks port to
 *    try/catch with the same fail-soft logging.
 */

import * as fs from "node:fs";
import * as nodePath from "node:path";

import { registerReset } from "./reset.js";
import {
  CONTINUE,
  LOG as _LOG,
  get_hook_context,
  get_tool_input,
  sanitize_log_str,
  update_session,
  validate_cwd,
} from "./hooks_common.js";
import * as paths from "./paths.js";
import * as project_mod from "./project.js";
import type { Project } from "./project.js";
import * as session from "./session.js";
import * as snapshots from "./snapshots.js";
import * as worker from "./worker.js";

import type { HookPayload, HookResponse } from "./types.js";
import type { SessionCache } from "./session.js";

export const __all__ = ["post_edit", "_edit_succeeded"] as const;

// ---------------------------------------------------------------------------
// Worker module fail-soft injection seam.
//
// hooks_edit reaches worker.ts through this seam so the staleness decision and
// enqueue can be stubbed in tests without forking a real worker daemon. The seam
// defaults to the real worker module; reset.ts restores that real default.
// Tests inject a stub via _setWorkerModule that implements the same surface.
// ---------------------------------------------------------------------------

/** The slice of the worker module surface that hooks_edit depends on. */
export interface WorkerModule {
  is_heartbeat_stale_for_nudge(): boolean;
  ensure_running(): number | null;
  enqueue_dirty(
    rel_path: string,
    project_hash?: string | null,
    opts?: { project_root?: string | null; project_marker?: string | null },
  ): void;
  WORKER_RESTART_THROTTLE_SECS?: number;
}

// worker.ts is ported; the seam defaults to the real module. reset.ts restores
// this default so a test that does not touch the seam gets real behavior, while
// one that calls _setWorkerModule(null) still exercises the fail-soft path.
const _workerDefault: WorkerModule = worker;

let _workerModule: WorkerModule | null = _workerDefault;

/** Register the worker module (fail-soft seam). Pass null to clear. */
export function _setWorkerModule(mod: WorkerModule | null): void {
  _workerModule = mod;
}

registerReset(() => {
  _workerModule = _workerDefault;
});

// Maximum age (seconds) of a file's mtime before we consider the edit "too old"
// to be from this tool call. In practice an Edit tool call completes in well
// under a second, so 10 seconds is a generous upper bound that still filters
// out files whose mtime predates the current session by a wide margin.
const _EDIT_FRESHNESS_SECS = 10.0;

/**
 * Return True when the edit actually modified the file on disk.
 *
 * Two complementary checks (both must pass for the edit to be recorded):
 *
 * 1. Tool-response error flag — If the payload's `tool_response` is a dict with
 *    `is_error: true` (Claude Code MCP wire format) or the response text starts
 *    with "Error:" / "Failed:" / "Permission denied" (plain-text harness
 *    error), the edit failed at the tool level and did not touch the file. We
 *    do not record it.
 *
 * 2. File mtime freshness — Even when no explicit error is present, the file
 *    must exist and have been modified within the last `_EDIT_FRESHNESS_SECS`
 *    seconds. This catches the case where the tool reports success but the file
 *    on disk was read-only or the path was wrong and no write occurred.
 *
 * Fail-soft: any OSError during the stat call is treated as "edit succeeded,
 * proceed normally" so a transient permission issue never silently drops a
 * legitimate edit from the session cache.
 */
export function _edit_succeeded(payload: HookPayload, file_path: string): boolean {
  // Check 1: explicit tool-level error in the response.
  const tool_resp: unknown =
    payload !== null && typeof payload === "object" && !Array.isArray(payload)
      ? (payload as HookPayload).tool_response
      : null;
  if (
    tool_resp !== null &&
    typeof tool_resp === "object" &&
    !Array.isArray(tool_resp) &&
    (tool_resp as Record<string, unknown>).is_error === true
  ) {
    // Claude Code MCP wire format: {"is_error": true, ...}
    _LOG.debug(
      "post-edit: skipping session record for %s (is_error=true in tool_response)",
      sanitize_log_str(file_path),
    );
    return false;
  }
  if (typeof tool_resp === "string") {
    const stripped = tool_resp.trim();
    if (
      stripped.startsWith("Error:") ||
      stripped.startsWith("Failed:") ||
      stripped.startsWith("Permission denied")
    ) {
      _LOG.debug(
        "post-edit: skipping session record for %s (error text in tool_response)",
        sanitize_log_str(file_path),
      );
      return false;
    }
  }

  // Check 2: mtime freshness — the file must exist and have been written recently.
  try {
    if (!fs.existsSync(file_path)) {
      // File does not exist — Write may have failed, but could also be a
      // deletion (MultiEdit of a non-existent file); be conservative and allow
      // the record so the manifest doesn't miss the intent.
      return true;
    }
    const mtime = fs.statSync(file_path).mtimeMs / 1000;
    const age = Date.now() / 1000 - mtime;
    if (age > _EDIT_FRESHNESS_SECS) {
      _LOG.debug(
        "post-edit: file %s mtime is %.1fs old (> %.1fs threshold); " +
          "edit may not have written to disk — skipping session record",
        sanitize_log_str(file_path),
        age,
        _EDIT_FRESHNESS_SECS,
      );
      return false;
    }
  } catch (exc) {
    // Transient stat error — fail open (record the edit) so a benign race
    // doesn't silently drop the entry from the compaction manifest.
    _LOG.debug(
      "post-edit: stat failed for %s (%s); assuming edit succeeded",
      sanitize_log_str(file_path),
      String(exc),
    );
  }
  return true;
}

/**
 * Respawn the background worker if its heartbeat file is stale.
 *
 * Delegates the staleness decision to worker.is_heartbeat_stale_for_nudge,
 * which derives the threshold from the heartbeat interval/grace — so this nudge
 * stays in lock-step with the watchdog's own freshness check.
 *
 * A restart throttle prevents tight restart loops if the worker is crashing
 * immediately. If a worker was nudged and respawned within the last
 * WORKER_RESTART_THROTTLE_SECS (30 s), this call skips the respawn and lets the
 * previous attempt settle.
 *
 * Failures are logged but not raised (fail-soft hook pattern).
 */
export function _nudge_worker_if_down(): void {
  try {
    const worker = _workerModule;
    if (worker === null) {
      return;
    }

    if (!worker.is_heartbeat_stale_for_nudge()) {
      return;
    }

    // Check restart throttle to prevent restart loops on persistent failures.
    const sentinel = nodePath.join(paths.sentinelsDir(), "last_worker_restart");
    const throttle_secs =
      typeof worker.WORKER_RESTART_THROTTLE_SECS === "number"
        ? worker.WORKER_RESTART_THROTTLE_SECS
        : 30.0;
    try {
      if (fs.existsSync(sentinel)) {
        const age = Date.now() / 1000 - fs.statSync(sentinel).mtimeMs / 1000;
        if (age < throttle_secs) {
          _LOG.debug(
            "worker restart throttle: skipping respawn (last attempt %.1f s ago, " +
              "throttle %.1f s)",
            age,
            throttle_secs,
          );
          return;
        }
      }
    } catch {
      // Ignore sentinel check errors; proceed with respawn attempt.
    }

    _LOG.info("worker heartbeat stale — attempting respawn");
    const pid = worker.ensure_running();
    if (pid) {
      _LOG.info("worker respawned: pid=%s", pid);
      // Update the restart sentinel to mark when the respawn happened.
      try {
        paths.ensureDir(nodePath.dirname(sentinel));
        paths.atomicWriteText(sentinel, "");
      } catch {
        // Sentinel update is best-effort.
      }
    } else {
      _LOG.warning(
        "worker nudge: ensure_running returned no pid (already running or failed)",
      );
    }
  } catch (exc) {
    // Python: _LOG.exception (error level + traceback). The console Logger has
    // no `.exception`; LOG.error is the faithful level mapping.
    _LOG.error("worker nudge failed: %s", String(exc));
  }
}

/**
 * Queue a file for background re-indexing after edit.
 *
 * Resolves the file path to an absolute path within a project, then enqueues it
 * to the dirty-file queue (queue/dirty.txt) so the background worker can
 * reindex it on the next cycle. If the file is outside any indexed project,
 * this is silently skipped (no error raised).
 */
export function _enqueue_for_reindex(file_path: string, cwd: string | null): void {
  let search_root: string;
  const isAbs = nodePath.isAbsolute(file_path);
  if (isAbs) {
    search_root = nodePath.dirname(file_path);
  } else {
    const cwd_path = validate_cwd(cwd, { caller: "post-edit" });
    if (cwd_path === null) {
      _LOG.debug(
        "post-edit: no valid cwd for relative file_path %s; skipping enqueue",
        sanitize_log_str(file_path),
      );
      return;
    }
    search_root = cwd_path;
  }
  const project: Project | null = project_mod.find_project(search_root);
  if (project === null) {
    _LOG.debug(
      "post-edit: %s is outside any indexed project; skipping reindex enqueue",
      sanitize_log_str(file_path),
    );
    return;
  }

  // Resolve to an absolute path. For relative paths, join against the project
  // root and resolve (the Python `(project.root / file_path).resolve()`).
  let abs_path: string;
  if (isAbs) {
    abs_path = file_path;
  } else {
    abs_path = nodePath.resolve(project.root, file_path);
  }

  // Path.relative_to(project.root) — ValueError when abs_path is outside the
  // project root. We compute the POSIX-style relative path and reject any
  // result that escapes the root (the ValueError branch -> return).
  const rel = _relativeTo(abs_path, project.root);
  if (rel === null) {
    return;
  }

  const worker = _workerModule;
  if (worker === null) {
    return;
  }
  try {
    worker.enqueue_dirty(rel, project.hash, {
      project_root: project.root,
      project_marker: project.marker,
    });
  } catch (e) {
    _LOG.warning("failed to enqueue %s for reindex: %s", rel, String(e));
  }
}

/**
 * Compute `child` relative to `root` as a POSIX path, or null when `child` is
 * not contained within `root` (the Python Path.relative_to ValueError case).
 */
function _relativeTo(child: string, root: string): string | null {
  const relNative = nodePath.relative(root, child);
  if (relNative === "") {
    // child === root: relative_to yields "." in Python; treat as a non-escape.
    return ".";
  }
  // A leading ".." (or an absolute result on Windows) means child escapes root.
  if (relNative === ".." || relNative.startsWith(".." + nodePath.sep) || nodePath.isAbsolute(relNative)) {
    return null;
  }
  // Normalise to POSIX separators (as_posix()).
  return relNative.split(nodePath.sep).join("/");
}

const _PREDICTIVE_SNAPSHOT_CAP = 3; // max pre-snapshots per post_edit call
const _IMPORT_SCAN_LINE_LIMIT = 200; // cap header scan so giant modules stay fast

/**
 * Parse top-of-file Python import statements and return resolved local file
 * paths.
 *
 * Scans the first `_IMPORT_SCAN_LINE_LIMIT` lines of *source* for `import X`
 * and `from X import Y` statements. Non-import lines (decorators, `try:`,
 * `if TYPE_CHECKING:`, class/function definitions) are skipped rather than
 * treated as a hard stop, so conditional imports below a try/if block are still
 * picked up. Multi-line parenthesized imports and backslash continuations are
 * joined before matching.
 *
 * Resolves relative imports (`from .foo import bar` -> `<parent>/foo.py`) and
 * top-level project imports. Returns at most `_PREDICTIVE_SNAPSHOT_CAP` unique
 * resolved absolute paths that actually exist on disk.
 *
 * Only `.py` files are considered; third-party/stdlib imports are silently
 * skipped when no matching file is found. Errors are swallowed (best-effort).
 */
export function _parse_local_imports(
  source: string,
  file_path: string,
  cwd: string | null,
): string[] {
  const results: string[] = [];
  const seen = new Set<string>();
  try {
    const src_path = nodePath.isAbsolute(file_path)
      ? file_path
      : cwd
        ? nodePath.join(cwd, file_path)
        : file_path;
    const src_dir = nodePath.dirname(src_path);

    // Python: ^(?:from\s+(\.{0,3}[\w.]*)\s+import\s+[\w*, ]+|import\s+([\w., ]+))\s*$
    const import_re =
      /^(?:from\s+(\.{0,3}[\w.]*)\s+import\s+[\w*, ]+|import\s+([\w., ]+))\s*$/;

    // Pre-pass: stitch multi-line parenthesized imports and backslash
    // continuations into single logical lines so the per-line regex can match
    // them. Cap the input to the first _IMPORT_SCAN_LINE_LIMIT raw lines.
    const raw_lines = source.split(/\r\n|\r|\n/).slice(0, _IMPORT_SCAN_LINE_LIMIT);
    const logical_lines: string[] = [];
    let i = 0;
    while (i < raw_lines.length) {
      const line = raw_lines[i] as string;
      const stripped = line.trim();
      // Handle `from foo import (` continuations: keep consuming until the
      // closing `)`.
      if (
        stripped.includes("(") &&
        _count(stripped, "(") > _count(stripped, ")") &&
        (stripped.startsWith("from ") || stripped.startsWith("import "))
      ) {
        const acc: string[] = [stripped];
        let depth = _count(stripped, "(") - _count(stripped, ")");
        i += 1;
        while (i < raw_lines.length && depth > 0) {
          const nxt = (raw_lines[i] as string).trim();
          acc.push(nxt);
          depth += _count(nxt, "(") - _count(nxt, ")");
          i += 1;
        }
        // Flatten the parenthesized list into `from foo import a, b, c`.
        let joined = acc.join(" ").split("(").join("").split(")").join("");
        // Collapse internal whitespace so the regex matches.
        joined = joined.split(/\s+/).filter((s) => s.length > 0).join(" ");
        logical_lines.push(joined);
        continue;
      }
      // Handle `import foo \` backslash continuations.
      if (stripped.endsWith("\\")) {
        const acc: string[] = [_rstrip(_rstripChar(stripped, "\\"))];
        i += 1;
        while (i < raw_lines.length) {
          const nxt = (raw_lines[i] as string).trim();
          if (nxt.endsWith("\\")) {
            acc.push(_rstrip(_rstripChar(nxt, "\\")));
            i += 1;
          } else {
            acc.push(nxt);
            i += 1;
            break;
          }
        }
        logical_lines.push(acc.join(" "));
        continue;
      }
      logical_lines.push(stripped);
      i += 1;
    }

    // Main pass: scan logical lines for import statements. Continue on
    // non-import lines instead of breaking, so imports below a try:/if
    // TYPE_CHECKING: gate or decorator stack are still discovered.
    for (const logical of logical_lines) {
      if (!logical || logical.startsWith("#")) {
        continue;
      }
      const m = import_re.exec(logical);
      if (!m) {
        // Not an import line — skip rather than abort the scan.
        continue;
      }

      const module_str = m[1] !== undefined ? m[1] : m[2];
      if (!module_str) {
        continue;
      }

      for (let mod of module_str.split(",")) {
        mod = mod.trim();
        if (!mod) {
          continue;
        }
        let candidate: string | null = null;
        if (mod.startsWith(".")) {
          // Relative import: resolve against src_dir.
          const dots = mod.length - _lstripChar(mod, ".").length;
          const mod_name = _lstripChar(mod, ".");
          let base = src_dir;
          for (let k = 0; k < dots - 1; k++) {
            base = nodePath.dirname(base);
          }
          if (mod_name) {
            candidate = nodePath.join(base, mod_name.split(".").join("/") + ".py");
          } else {
            candidate = nodePath.join(base, "__init__.py");
          }
          if (!fs.existsSync(candidate)) {
            candidate = null;
          }
        } else {
          // Absolute import: try direct path relative to cwd/project.
          const search_base = cwd ? cwd : src_dir;
          const c1 = nodePath.join(search_base, mod.split(".").join("/") + ".py");
          if (fs.existsSync(c1)) {
            candidate = c1;
          } else {
            // Try one level up (common for src-layout projects).
            const c2 = nodePath.join(
              nodePath.dirname(search_base),
              mod.split(".").join("/") + ".py",
            );
            if (fs.existsSync(c2)) {
              candidate = c2;
            }
          }
        }

        if (candidate !== null) {
          const resolved = candidate;
          if (!seen.has(resolved)) {
            seen.add(resolved);
            results.push(resolved);
            if (results.length >= _PREDICTIVE_SNAPSHOT_CAP) {
              return results.slice(0, _PREDICTIVE_SNAPSHOT_CAP);
            }
          }
        }
      }
    }
  } catch {
    _LOG.debug(
      "_resolve_import_candidates: unexpected error parsing %s (fail-soft)",
      file_path,
    );
  }

  return results.slice(0, _PREDICTIVE_SNAPSHOT_CAP);
}

/**
 * Read the edited .py file, parse its imports, and pre-snapshot imported files.
 *
 * Python ran this in a daemon thread and returned the Thread so tests could
 * .join(). The TS port runs the body on the main microtask queue and returns a
 * Promise so callers (and tests) can await completion. Running on the main
 * thread keeps a test's vi.spyOn on session/snapshots visible.
 *
 * Capped at `_PREDICTIVE_SNAPSHOT_CAP` snapshots to limit I/O cost. All errors
 * are logged at debug level and swallowed per the fail-soft hook pattern.
 */
export function _pre_snapshot_imports(
  session_id: string,
  file_path: string,
  cwd: string | null,
): Promise<void> {
  const work = async (): Promise<void> => {
    try {
      const fp = nodePath.isAbsolute(file_path)
        ? file_path
        : cwd
          ? nodePath.join(cwd, file_path)
          : file_path;
      if (!fs.existsSync(fp)) {
        return;
      }
      // read_text(encoding="utf-8", errors="replace")
      const source = fs.readFileSync(fp, { encoding: "utf-8" });
      const targets = _parse_local_imports(source, file_path, cwd);
      for (const target_path of targets) {
        try {
          const content = fs.readFileSync(target_path);
          // Tag the snapshot as "predictive" so a subsequent diff hint built
          // against it can be counted as a predictive prefetch hit in
          // `token-goat stats`. The default kind ("read") would lose the
          // attribution.
          const result = snapshots.store(session_id, target_path, content, {
            kind: "predictive",
          });
          if (result) {
            _LOG.debug(
              "predictive-snapshot: stored %s for %s",
              sanitize_log_str(target_path),
              sanitize_log_str(file_path),
            );
            // Persist the snapshot's content sha so a later diff hint can verify
            // integrity before firing. Best-effort.
            try {
              session.set_snapshot_sha(session_id, target_path, result.content_sha);
            } catch {
              _LOG.debug(
                "predictive-snapshot: sha persist failed for %s",
                sanitize_log_str(target_path),
              );
            }
          }
        } catch {
          _LOG.debug(
            "predictive-snapshot: failed for %s",
            sanitize_log_str(target_path),
          );
        }
      }
    } catch {
      _LOG.debug("predictive-snapshot: outer failure");
    }
  };

  return work();
}

/**
 * Return all file paths affected by an Edit, Write, or MultiEdit tool call.
 *
 * For Edit/Write tools the `tool_input` has a single `file_path` key. For
 * MultiEdit the `tool_input` has an `edits` list where each element is a dict
 * containing a `file_path` key (one per hunk). This helper normalises both
 * shapes into a flat list of unique, non-empty path strings.
 *
 * Returns an empty list when neither key is present (degenerate payload).
 */
export function _extract_edited_paths(tool_input: Record<string, unknown>): string[] {
  // Single-file tools: Edit and Write.
  const single = tool_input["file_path"];
  if (typeof single === "string" && single) {
    return [single];
  }

  // MultiEdit: edits is a list of {"file_path": ..., "old_string": ..., ...}.
  const edits = tool_input["edits"];
  if (Array.isArray(edits)) {
    const seen = new Set<string>();
    const out: string[] = [];
    for (const item of edits) {
      if (item === null || typeof item !== "object" || Array.isArray(item)) {
        continue;
      }
      const fp = (item as Record<string, unknown>)["file_path"];
      if (typeof fp === "string" && fp && !seen.has(fp)) {
        seen.add(fp);
        out.push(fp);
      }
    }
    return out;
  }

  return [];
}

/**
 * Post-edit hook: record edited files and queue for incremental re-indexing.
 *
 * Handles Edit, Write, and MultiEdit tool calls. For MultiEdit (which carries
 * an `edits` array with one entry per hunk), every unique file path is recorded
 * and enqueued, so the session cache and dirty-queue stay in sync even when a
 * single tool call touches several files.
 *
 * Three-part hook action:
 * 1. Records each edited file to the session cache.
 * 2. Enqueues each file to the dirty-queue and nudges the worker daemon if stale.
 * 3. For .py files, pre-snapshots locally imported modules in the background so
 *    the diff-aware re-read hint can fire immediately if those files are read next.
 *
 * Always returns CONTINUE() per the fail-soft hook pattern; failures are logged
 * but never raised.
 */
export function post_edit(payload: HookPayload): HookResponse {
  const [session_id, cwd] = get_hook_context(payload);
  const tool_input = get_tool_input(payload);
  const file_paths = _extract_edited_paths(tool_input);

  if (file_paths.length === 0) {
    _LOG.debug("post-edit: no file_path(s) in payload; nothing to enqueue");
    return CONTINUE();
  }

  for (const file_path of file_paths) {
    if (session_id) {
      if (_edit_succeeded(payload, file_path)) {
        const _record_edit = (cache: SessionCache): void => {
          session.mark_file_edited(session_id, file_path, { cache });
        };
        update_session(session_id, _record_edit);
      } else {
        _LOG.debug(
          "post-edit: file %s not recorded (edit did not succeed)",
          sanitize_log_str(file_path),
        );
      }
    }

    _LOG.debug("post-edit: enqueuing %s for reindex", sanitize_log_str(file_path));
    _enqueue_for_reindex(file_path, cwd);

    // Item 17: predictive pre-snapshot for Python imports.
    if (session_id && file_path.endsWith(".py")) {
      void _pre_snapshot_imports(session_id, file_path, cwd);
    }
  }

  _nudge_worker_if_down();
  return CONTINUE();
}

// ---------------------------------------------------------------------------
// Small string helpers mirroring Python str methods used above.
// ---------------------------------------------------------------------------

/** Count non-overlapping occurrences of *sub* in *s* (Python str.count). */
function _count(s: string, sub: string): number {
  let n = 0;
  let idx = s.indexOf(sub);
  while (idx !== -1) {
    n += 1;
    idx = s.indexOf(sub, idx + sub.length);
  }
  return n;
}

/** Strip trailing whitespace (Python str.rstrip with no arg). */
function _rstrip(s: string): string {
  return s.replace(/\s+$/, "");
}

/** Strip all trailing occurrences of *ch* (Python str.rstrip(ch)). */
function _rstripChar(s: string, ch: string): string {
  let end = s.length;
  while (end > 0 && s[end - 1] === ch) {
    end -= 1;
  }
  return s.slice(0, end);
}

/** Strip all leading occurrences of *ch* (Python str.lstrip(ch)). */
function _lstripChar(s: string, ch: string): string {
  let start = 0;
  while (start < s.length && s[start] === ch) {
    start += 1;
  }
  return s.slice(start);
}
