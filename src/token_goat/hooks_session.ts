/**
 * Session lifecycle hook handlers: session-start and post-compaction recovery.
 *
 * Faithful TypeScript port of src/token_goat/hooks_session.py (2019 LOC).
 *
 * Exports the three hook handlers resolved lazily by hooks_cli._resolve_handler
 * via import("./hooks_session.js"): session_start, user_prompt_submit,
 * subagent_stop. Each takes a normalized HookPayload and returns a HookResponse.
 *
 * Parity notes (Python -> TS):
 *  - Python `subprocess.run` (via util.run_git) -> the ported util.runGit. The
 *    test suite drives git by vi.spyOn(util, "runGit"); this module calls runGit
 *    through a STATIC `import * as util` so the spy is observed. The Python tests
 *    mocked subprocess.run with branch/status/log side-effects — the TS tests
 *    instead spy on util.runGit and synthesize the same CompletedProcess shapes.
 *  - time.monotonic() -> performance.now() / 1000 (seconds, monotonic). The
 *    brief TTL + deadline math is preserved in seconds.
 *  - time.time() -> Date.now() / 1000 (unix seconds).
 *  - Modules NOT yet ported (compact internals, bash_cache, worker, baseline)
 *    are reached through FAIL-SOFT injection seams (_setCompactModule, etc.) so
 *    the recovery/advisory paths degrade gracefully (return null / skip section)
 *    when absent — exactly as the Python lazy imports degrade in a stripped
 *    environment. Ported deps (session, paths, project, project_memory, db,
 *    config, memory_prune, cache_common, util._humanizeBytes) are STATIC imports.
 *  - Module-level mutable state (_brief_cache + the injection-seam overrides) is
 *    registered with reset.ts so tests/setup.ts's per-file clearModuleCaches()
 *    returns it to the freshly-imported baseline (Python: each fresh process).
 *
 * `verbatimModuleSyntax` + `exactOptionalPropertyTypes` + `noUncheckedIndexedAccess`
 * are on.
 */

import * as fs from "node:fs";
import * as nodePath from "node:path";

import {
  CONTINUE,
  get_session_context,
  sanitize_opt,
  validate_cwd,
  LOG as _LOG,
} from "./hooks_common.js";
import type { HookPayload, HookResponse } from "./hooks_common.js";

import { registerReset } from "./reset.js";
import * as util from "./util.js";
import { runGit as _run_git } from "./util.js";
import * as session from "./session.js";
import * as paths from "./paths.js";
import * as project from "./project.js";
import * as project_memory from "./project_memory.js";
import * as db from "./db.js";
import * as config from "./config.js";
import * as memory_prune from "./memory_prune.js";
import * as snapshots from "./snapshots.js";
import * as bash_cache from "./bash_cache.js";
import * as baseline from "./baseline.js";
import * as worker from "./worker.js";
import { short_output_id as _short_id } from "./cache_common.js";

import type { Project } from "./project.js";
import type { BashEntry, FileEntry, SessionCache, SkillEntry, WebEntry } from "./session.js";

// Self-namespace import so internal calls to helpers the tests spy on
// (_build_session_brief / _detect / _try_recovery_response) route through the
// live module binding — the TS analogue of Python's dynamic module-attribute
// lookup that mock.patch("token_goat.hooks_session._x") relies on. A direct
// local call would capture the original function and bypass vi.spyOn.
import * as self from "./hooks_session.js";

// ---------------------------------------------------------------------------
// Fail-soft injection seams for modules not yet ported (or whose needed surface
// is not yet exported). Each degrades to its Python fallback when absent.
// ---------------------------------------------------------------------------

/** Subset of the compact module surface the recovery / advisory paths call. */
interface _CompactModule {
  _select_failed_bash_entries(bash_history: unknown, now_ts: number): unknown[];
  _format_blocker_entry(entry: unknown): string;
  infer_session_goal(cache: unknown, max_tokens?: number): string;
  _load_task_list(session_id: string): Array<Record<string, string>>;
  _render_tasks_section(
    raw_tasks: Array<Record<string, string>>,
    opts: { edited_paths?: Set<string> },
  ): string[];
  get_context_pressure(session_id: string | null, opts?: { cache?: unknown }): { fill_fraction: number };
}

/** Subset of the bash_cache module surface used by the pending-work section. */
interface _BashCacheModule {
  load_output(output_id: string): string | null;
}

/** Subset of the worker module surface used by session_start. */
interface _WorkerModule {
  spawn_index_detached(root: string, project_hash: string): number | null;
  ensure_running(): number | null;
}

/** Subset of the baseline module surface used by the baseline advisory. */
interface _BaselineModule {
  collect_baseline(base: string, session_id: string): { fixed_tokens: number };
}

// bash_cache, baseline and worker are ported, so their seams default to the real
// module. compact is NOT yet ported, so it stays null-by-default until it lands.
// baseline.ts exports `collectBaseline` (camelCase); adapt it to the snake_case
// `collect_baseline` surface the advisory calls. reset.ts restores the ported
// seams to their real defaults (a test that does not touch them gets real
// behavior; one that calls _setXModule(null) still exercises fail-soft).
const _bashCacheDefault: _BashCacheModule = bash_cache;
const _baselineDefault: _BaselineModule = {
  collect_baseline: (base, session_id) => baseline.collectBaseline(base, session_id),
};
const _workerDefault: _WorkerModule = worker;

let _compactModule: _CompactModule | null = null;
let _bashCacheModule: _BashCacheModule | null = _bashCacheDefault;
let _workerModule: _WorkerModule | null = _workerDefault;
let _baselineModule: _BaselineModule | null = _baselineDefault;

/** Test/late-layer seam: inject a compact implementation (or null to clear). */
export function _setCompactModule(mod: _CompactModule | null): void {
  _compactModule = mod;
}
/**
 * Test/late-layer seam: inject a bash_cache implementation. Pass `null` to force
 * the fail-soft path; reset.ts restores the real default.
 */
export function _setBashCacheModule(mod: _BashCacheModule | null): void {
  _bashCacheModule = mod;
}
/** Test/late-layer seam: inject a worker implementation (or null to clear). */
export function _setWorkerModule(mod: _WorkerModule | null): void {
  _workerModule = mod;
}
/**
 * Test/late-layer seam: inject a baseline implementation. Pass `null` to force
 * the fail-soft path; reset.ts restores the real default.
 */
export function _setBaselineModule(mod: _BaselineModule | null): void {
  _baselineModule = mod;
}

registerReset(() => {
  _brief_cache.clear();
  _compactModule = null;
  // Restore the real-module defaults for the ported seams.
  _bashCacheModule = _bashCacheDefault;
  _workerModule = _workerDefault;
  _baselineModule = _baselineDefault;
});

// ---------------------------------------------------------------------------
// Memory-index pruning throttle
// ---------------------------------------------------------------------------

const _MEMORY_PRUNE_THROTTLE_H = 24.0;

/**
 * Best-effort, throttled, never-raises: prune dead + dup entries from MEMORY.md.
 *
 * Runs at most once per project per _MEMORY_PRUNE_THROTTLE_H hours via a sentinel
 * file. Atomic rewrite via paths.atomicWriteText.
 */
export function _prune_memory_index(session_id: string | null, cwd: string | null): void {
  try {
    // Resolve the project slug dir from the session transcript.
    let proj_dir: string | null = null;
    if (session_id) {
      proj_dir = paths.claudeSessionProjectDir(session_id) ?? null;
    }

    if (proj_dir === null && cwd) {
      // Fallback: scan projects dir for the slug matching cwd.
      const cwd_path = nodePath.resolve(cwd);
      const slug = cwd_path.replace(/[^A-Za-z0-9]/g, "-").replace(/^-+|-+$/g, "");
      const candidate = nodePath.join(paths.claudeProjectsDir(), slug);
      try {
        if (fs.statSync(candidate).isDirectory()) {
          proj_dir = candidate;
        }
      } catch {
        // not a dir
      }
    }

    if (proj_dir === null) {
      return;
    }

    const memory_dir = nodePath.join(proj_dir, "memory");
    try {
      if (!fs.statSync(memory_dir).isDirectory()) {
        return;
      }
    } catch {
      return;
    }

    // Throttle: skip if sentinel mtime < throttle window.
    const sentinel_dir = paths.ensureDir(nodePath.join(paths.dataDir(), "memory_prune"));
    const proj_name = nodePath.basename(proj_dir);
    const sentinel = nodePath.join(sentinel_dir, `${proj_name}.last`);
    const now = Date.now() / 1000;
    try {
      const st = fs.statSync(sentinel);
      if (now - st.mtimeMs / 1000 < _MEMORY_PRUNE_THROTTLE_H * 3600) {
        return;
      }
    } catch {
      // sentinel absent — proceed
    }

    const result = memory_prune.prune_index(memory_dir);
    if (result.changed) {
      _LOG.info(
        "memory-prune: removed %d dead + %d dup entries from %s (~%d tokens saved)",
        result.removed_dead.length,
        result.removed_dup.length,
        proj_name,
        result.tokens_saved,
      );
    }

    try {
      // Update sentinel to suppress reruns; ignore write failures.
      paths.atomicWriteText(sentinel, String(now));
    } catch {
      // ignore
    }
  } catch {
    _LOG.debug("memory-prune: failed (non-fatal)");
  }
}

// ---------------------------------------------------------------------------
// Session-brief TTL cache (item 5)
// ---------------------------------------------------------------------------

// Module-level cache for _build_session_brief results.
// Key: cwd (str)
// Value: [brief, mtime_editmsg, mtime_index, mono_ts]
// TTL is 60 s (primary expiry). Two mtime fields form a cheap git-state
// fingerprint: if either changes the cache is invalidated on the next call.
const _BRIEF_CACHE_TTL_SECS = 60.0;
export const _brief_cache = new Map<string, [string | null, number, number, number]>();

// ---------------------------------------------------------------------------
// Pytest-collapse helpers for the recovery hint bash section
// ---------------------------------------------------------------------------

// Case-insensitive prefix patterns that identify a pytest invocation.
const _PYTEST_PREFIXES: readonly string[] = ["pytest", "uv run pytest", "python -m pytest"];

/**
 * Return True when *entry* is a successful pytest run.
 *
 * exit_code == 0 AND cmd_preview starts with one of _PYTEST_PREFIXES
 * (case-insensitive, after stripping leading whitespace).
 */
export function _is_green_pytest(entry: BashEntry): boolean {
  if (entry.exit_code !== 0) {
    return false;
  }
  const preview = entry.cmd_preview.trim().toLowerCase();
  return _PYTEST_PREFIXES.some((p) => preview.startsWith(p));
}

/**
 * Reset session cache for /clear and fresh-start events.
 *
 * Intentionally NOT called for source == "compact" — we want the pre-compaction
 * state to survive into the new context window so the recovery hint has
 * something to point at.
 */
export function _reset_session_cache(session_id: string | null): void {
  if (!session_id) {
    return;
  }
  session.reset_session(session_id);
}

// Recovery hint slot budget.
const _RECOVERY_MAX_FILES = 6; // floor
const _RECOVERY_MAX_BASH = 4; // floor
const _RECOVERY_MAX_WEB = 4; // floor
const _RECOVERY_MAX_SKILL = 4; // floor
const _RECOVERY_TOTAL_ITEMS = 18; // global budget = sum of floors
const _RECOVERY_FILES_CEILING = 12;
const _RECOVERY_BASH_CEILING = 10;
const _RECOVERY_WEB_CEILING = 10;
const _RECOVERY_SKILL_CEILING = 8;
// Minimum byte size before a cached output is worth listing in the recovery hint.
const _RECOVERY_MIN_BYTES = 400;

/**
 * Allocate recovery-hint slots across files / bash / web / skill sections.
 *
 * Two-pass greedy allocator: floor pass then priority-ordered reallocation
 * (Skills -> Files -> Bash -> Web). Returns exact slice sizes.
 */
export function _allocate_recovery_slots(
  files_n: number,
  bash_n: number,
  web_n: number,
  skill_n = 0,
): [number, number, number, number] {
  let files_keep = Math.min(files_n, _RECOVERY_MAX_FILES);
  let bash_keep = Math.min(bash_n, _RECOVERY_MAX_BASH);
  let web_keep = Math.min(web_n, _RECOVERY_MAX_WEB);
  let skill_keep = Math.min(skill_n, _RECOVERY_MAX_SKILL);

  let remaining = _RECOVERY_TOTAL_ITEMS - (files_keep + bash_keep + web_keep + skill_keep);
  if (remaining <= 0) {
    return [files_keep, bash_keep, web_keep, skill_keep];
  }

  const passes: Array<[string, number, number]> = [
    ["skill", skill_n, _RECOVERY_SKILL_CEILING],
    ["files", files_n, _RECOVERY_FILES_CEILING],
    ["bash", bash_n, _RECOVERY_BASH_CEILING],
    ["web", web_n, _RECOVERY_WEB_CEILING],
  ];
  for (const [current, total, ceiling] of passes) {
    if (remaining <= 0) {
      break;
    }
    const kept: Record<string, number> = {
      files: files_keep,
      bash: bash_keep,
      web: web_keep,
      skill: skill_keep,
    };
    const headroom = Math.min(ceiling, total) - (kept[current] ?? 0);
    if (headroom <= 0) {
      continue;
    }
    const grant = Math.min(headroom, remaining);
    if (current === "files") {
      files_keep += grant;
    } else if (current === "bash") {
      bash_keep += grant;
    } else if (current === "web") {
      web_keep += grant;
    } else {
      skill_keep += grant;
    }
    remaining -= grant;
  }

  return [files_keep, bash_keep, web_keep, skill_keep];
}

/**
 * Return the RESUME anchor string for the recovery hint header.
 *
 * Returns the top-edited basename ("auth.py") when edits exist, else "".
 * The *cache* parameter is accepted but unused (symmetry with compact.py).
 */
export function _resume_anchor_for_recovery(
  raw_edited: Record<string, number>,
  _cache: unknown,
): string {
  if (Object.keys(raw_edited).length === 0) {
    return "";
  }
  try {
    // Reuse _BY_EDIT_COUNT semantics: sort by count desc, then by path so the
    // choice is deterministic on ties. Python max(items, key=(count, path)).
    let top: [string, number] | null = null;
    for (const [k, v] of Object.entries(raw_edited)) {
      if (top === null || v > top[1] || (v === top[1] && k > top[0])) {
        top = [k, v];
      }
    }
    if (top === null) {
      return "";
    }
    const basename = nodePath.basename(top[0]) || top[0];
    if (basename) {
      return util.sanitizeSurrogates(basename).slice(0, 40);
    }
  } catch {
    // fail-soft
  }
  return "";
}

/**
 * Return [section_text, anchor_word] for the Blockers part of the hint.
 *
 * Uses the compact module's blocker helpers (via the fail-soft seam) so the
 * recovery hint stays in lockstep with the pre-compact manifest. Fail-soft: any
 * error (or missing compact module) returns ["", ""].
 */
export function _build_blocker_section(cache: unknown): [string, string] {
  try {
    const compact = _compactModule;
    if (compact === null) {
      return ["", ""];
    }
    const bash_hist = _getAttr(cache, "bash_history");
    if (!_isPlainDict(bash_hist) || Object.keys(bash_hist).length === 0) {
      return ["", ""];
    }
    const now_ts = Date.now() / 1000;
    const blockers = compact._select_failed_bash_entries(bash_hist, now_ts);
    if (!blockers || blockers.length === 0) {
      return ["", ""];
    }
    const lines = ["**Blockers**:"];
    let anchor = "";
    for (const entry of blockers) {
      lines.push(compact._format_blocker_entry(entry));
    }
    try {
      let latest: unknown = null;
      let latest_ts = -Infinity;
      for (const e of blockers) {
        const ts = _getNumberAttr(e, "ts", 0.0);
        if (ts >= latest_ts) {
          latest_ts = ts;
          latest = e;
        }
      }
      const cmd = String(_getAttr(latest, "cmd_preview") ?? "");
      for (const tok of cmd.split(/\s+/).filter((t) => t.length > 0)) {
        if (!tok.includes("=") && !tok.startsWith("-")) {
          anchor = tok.slice(0, 30);
          break;
        }
      }
    } catch {
      // ignore
    }
    lines.push("- _retrieve full output via `token-goat bash-output <id>`_");
    return [lines.join("\n"), anchor];
  } catch {
    return ["", ""];
  }
}

/**
 * Return a "### Pending Work" section string, or empty string.
 *
 * Scans bash_history for failed pytest, uncommitted edits, and non-zero uv run.
 * At most 3 bullets. Fail-soft.
 */
export function _build_pending_work_section(
  cache: unknown,
  raw_edited: Record<string, number>,
  _bash_entries_in_hint: Set<string>,
): string {
  try {
    const bash_hist = (_getAttr(cache, "bash_history") as Record<string, unknown> | undefined) ?? {};
    const now = Date.now() / 1000;
    const cutoff_2h = now - 7200; // 2-hour window
    const items: string[] = [];

    // --- 1. Failed pytest ---
    const pytest_failures: unknown[] = [];
    for (const be of Object.values(bash_hist)) {
      const preview = String(_getAttr(be, "cmd_preview") ?? "").trim().toLowerCase();
      if (!_PYTEST_PREFIXES.some((p) => preview.startsWith(p))) {
        continue;
      }
      const exit_code = _getAttr(be, "exit_code");
      if (typeof exit_code === "number" && Number.isInteger(exit_code) && exit_code !== 0) {
        const ts = _getNumberAttr(be, "ts", 0.0);
        if (ts >= cutoff_2h) {
          pytest_failures.push(be);
        }
      }
    }
    if (pytest_failures.length > 0) {
      const latest_fail = _maxBy(pytest_failures, (e) => _getNumberAttr(e, "ts", 0.0));
      const age_secs = now - _getNumberAttr(latest_fail, "ts", now);
      let age_str: string;
      if (age_secs < 60) {
        age_str = `${Math.trunc(age_secs)}s ago`;
      } else if (age_secs < 3600) {
        age_str = `${Math.trunc(age_secs / 60)}m ago`;
      } else {
        age_str = `${Math.trunc(age_secs / 3600)}h ago`;
      }
      let fail_count_str = "";
      try {
        const bc = _bashCacheModule;
        const output_id = String(_getAttr(latest_fail, "output_id") ?? "");
        if (bc !== null && output_id) {
          const text = bc.load_output(output_id);
          if (text) {
            const m = /(\d+)\s+failed/.exec(text);
            if (m !== null) {
              const n = Number(m[1]);
              fail_count_str = `: ${n} failure${n !== 1 ? "s" : ""}`;
            }
          }
        }
      } catch {
        // ignore
      }
      items.push(`pytest failed${fail_count_str} (last run ${age_str})`);
    }

    // --- 2. Uncommitted edits ---
    if (Object.keys(raw_edited).length > 0) {
      let latest_edit_ts = 0.0;
      try {
        const files = _getAttr(cache, "files") as Record<string, unknown> | undefined;
        for (const _ep of Object.keys(raw_edited)) {
          const fe = files?.[_ep];
          if (fe === undefined || fe === null) {
            continue;
          }
          const let_ = _getNumberAttr(fe, "last_edit_ts", 0.0);
          if (let_ > latest_edit_ts) {
            latest_edit_ts = let_;
          }
        }
      } catch {
        latest_edit_ts = now;
      }

      let last_commit_ts = 0.0;
      for (const be of Object.values(bash_hist)) {
        const preview = String(_getAttr(be, "cmd_preview") ?? "").trim().toLowerCase();
        if (preview.startsWith("git commit")) {
          const ec = _getAttr(be, "exit_code");
          if (ec === 0) {
            const ts = _getNumberAttr(be, "ts", 0.0);
            if (ts > last_commit_ts) {
              last_commit_ts = ts;
            }
          }
        }
      }

      if (latest_edit_ts === 0.0 || last_commit_ts < latest_edit_ts) {
        const edited_names: string[] = [];
        const sorted_eps = Object.keys(raw_edited).sort(
          (a, b) => (raw_edited[b] ?? 0) - (raw_edited[a] ?? 0),
        );
        for (const _ep of sorted_eps.slice(0, 4)) {
          try {
            const bn = nodePath.basename(_ep);
            edited_names.push(bn || _ep);
          } catch {
            // ignore
          }
        }
        if (edited_names.length > 0) {
          const remaining = Object.keys(raw_edited).length - edited_names.length;
          const suffix = remaining > 0 ? `, +${remaining} more` : "";
          items.push(`Uncommitted edits: ${edited_names.join(", ")}${suffix}`);
        }
      }
    }

    // --- 3. Non-zero uv run (non-pytest) ---
    if (items.length < 3) {
      const uv_failures: unknown[] = [];
      for (const be of Object.values(bash_hist)) {
        const preview = String(_getAttr(be, "cmd_preview") ?? "").trim().toLowerCase();
        if (_PYTEST_PREFIXES.some((p) => preview.startsWith(p))) {
          continue;
        }
        if (!preview.startsWith("uv run")) {
          continue;
        }
        const exit_code = _getAttr(be, "exit_code");
        if (typeof exit_code === "number" && Number.isInteger(exit_code) && exit_code !== 0) {
          const ts = _getNumberAttr(be, "ts", 0.0);
          if (ts >= cutoff_2h) {
            uv_failures.push(be);
          }
        }
      }
      if (uv_failures.length > 0) {
        const latest_uv = _maxBy(uv_failures, (e) => _getNumberAttr(e, "ts", 0.0));
        const age_secs = now - _getNumberAttr(latest_uv, "ts", now);
        const age_str =
          age_secs < 60
            ? `${Math.trunc(age_secs)}s ago`
            : age_secs < 3600
              ? `${Math.trunc(age_secs / 60)}m ago`
              : `${Math.trunc(age_secs / 3600)}h ago`;
        const cmd_preview = String(_getAttr(latest_uv, "cmd_preview") ?? "uv run …").slice(0, 50);
        const ec = _getAttr(latest_uv, "exit_code") ?? "?";
        items.push(`\`${cmd_preview}\` exited ${String(ec)} (${age_str})`);
      }
    }

    if (items.length === 0) {
      return "";
    }
    const lines = ["### Pending Work"];
    for (const item of items.slice(0, 3)) {
      lines.push(`- ${item}`);
    }
    return lines.join("\n");
  } catch {
    return "";
  }
}

/**
 * Return a "### Key Commands" section with 3-5 relevant token-goat commands.
 * Always non-empty.
 */
export function _build_key_commands_section(
  has_edited_python: boolean,
  has_pytest: boolean,
  has_web: boolean,
): string {
  const lines = ["### Key Commands"];
  if (has_edited_python) {
    lines.push("- `token-goat symbol <name>` — find a function or class");
    lines.push('- `token-goat read "file.py::FuncName"` — read one function');
  }
  if (has_pytest) {
    lines.push("- `token-goat bash-output <id> --tail 50` — see last test failure");
  }
  if (has_web) {
    lines.push("- `token-goat web-output <id>` — re-read fetched page");
  }
  lines.push("- `token-goat map --compact` — oriented repo overview (300-token budget)");
  return lines.join("\n");
}

/**
 * Return [added, removed] line counts between snapshot and current file, or null.
 *
 * Loads the snapshot stored at pre-edit time for *file_path*, reads the current
 * file from disk, computes unified-diff line stats. Fail-soft -> null.
 */
export function _diff_stats_for_file(
  session_id: string,
  file_path: string,
): [number, number] | null {
  try {
    let snap_bytes = snapshots.load(session_id, file_path);
    if (snap_bytes === null) {
      const _candidates: string[] = [];
      const _bs = file_path.replace(/\//g, "\\");
      if (_bs !== file_path) {
        _candidates.push(_bs);
      }
      for (const _fp of [file_path, _bs]) {
        const _up = _fp.replace(/^([a-z]):[/\\]/, (_m, d: string) => `${d.toUpperCase()}:\\`);
        if (_up !== _fp) {
          _candidates.push(_up);
        }
      }
      for (const _alt of _candidates) {
        const _ab = snapshots.load(session_id, _alt);
        if (_ab !== null) {
          snap_bytes = _ab;
          break;
        }
      }
    }
    if (snap_bytes === null) {
      return null;
    }
    let snap_text: string;
    try {
      snap_text = Buffer.from(snap_bytes).toString("utf-8");
    } catch {
      return null;
    }
    let current_text: string;
    try {
      const current_bytes = fs.readFileSync(file_path);
      current_text = current_bytes.toString("utf-8");
    } catch {
      return null;
    }
    const snap_lines = _splitlinesKeepends(snap_text);
    const current_lines = _splitlinesKeepends(current_text);
    const probe = _unifiedDiff(snap_lines, current_lines);
    let added = 0;
    let removed = 0;
    for (const ln of probe) {
      if (ln.slice(0, 1) === "+" && !ln.startsWith("+++")) {
        added += 1;
      } else if (ln.slice(0, 1) === "-" && !ln.startsWith("---")) {
        removed += 1;
      }
    }
    return [added, removed];
  } catch {
    return null;
  }
}

// Approximate chars-per-token ratio used by the recovery hint size guard.
const _RECOVERY_CHARS_PER_TOKEN = 4;

/**
 * Truncate *text* to at most *max_tokens* by dropping lower-priority sections.
 *
 * Drops in ascending priority: "### Key Commands", "### Pending Work",
 * "**Symbols**". Whole sections only. Final hard-truncate with ellipsis.
 */
export function _truncate_recovery_hint(text: string, max_tokens = 400): string {
  const budget_chars = max_tokens * _RECOVERY_CHARS_PER_TOKEN;
  if (text.length <= budget_chars) {
    return text;
  }

  const _drop_section = (body: string, heading_prefix: string): string => {
    const pat = new RegExp(
      "(?:^|\\n\\n)" + _escapeRegExp(heading_prefix) + "[^\\n]*\\n(?:[^\\n].*\\n?)*",
      "m",
    );
    return body.replace(pat, "").replace(/^\n+/, "");
  };

  for (const marker of ["### Key Commands", "### Pending Work", "**Symbols**"]) {
    if (text.length <= budget_chars) {
      break;
    }
    const new_text = _drop_section(text, marker);
    if (new_text !== text) {
      text = new_text;
    }
  }

  if (text.length > budget_chars) {
    text = text.slice(0, budget_chars - 3) + "...";
  }

  return text;
}

/**
 * Return a compact recovery hint summarising pre-compaction state, or null.
 */
export function _build_recovery_hint(session_id: string): string | null {
  let cache: SessionCache;
  try {
    cache = session.load(session_id);
  } catch (exc) {
    _LOG.debug("recovery hint: failed to load session %s: %s", session_id.slice(0, 16), String(exc));
    return null;
  }
  if (cache.unavailable) {
    return null;
  }

  const files_values = Object.values(cache.files);
  const files_all =
    files_values.length > 0
      ? [...files_values].sort((a, b) => b.last_read_ts - a.last_read_ts)
      : [];
  const bash_all =
    Object.keys(cache.bash_history).length > 0
      ? Object.values(cache.bash_history)
          .filter((be) => be.stdout_bytes + be.stderr_bytes >= _RECOVERY_MIN_BYTES)
          .sort((a, b) => b.ts - a.ts)
      : [];
  const web_all =
    Object.keys(cache.web_history).length > 0
      ? Object.values(cache.web_history)
          .filter((we) => we.body_bytes >= _RECOVERY_MIN_BYTES)
          .sort((a, b) => b.ts - a.ts)
      : [];
  const skill_hist = cache.skill_history ?? {};
  const skill_all =
    Object.keys(skill_hist).length > 0
      ? Object.values(skill_hist).sort(
          (a, b) => _getNumberAttr(b, "ts", 0.0) - _getNumberAttr(a, "ts", 0.0),
        )
      : [];

  const [files_n, bash_n, web_n, skill_n] = _allocate_recovery_slots(
    files_all.length,
    bash_all.length,
    web_all.length,
    skill_all.length,
  );
  const files_keep = files_all.slice(0, files_n);
  const bash_entries = bash_all.slice(0, bash_n);
  const web_entries = web_all.slice(0, web_n);
  const skill_entries = skill_all.slice(0, skill_n);

  const sections: string[] = [];

  const raw_edited: Record<string, number> = _isPlainDict(cache.edited_files)
    ? (cache.edited_files as Record<string, number>)
    : {};
  const edit_count_by_norm: Record<string, number> = {};
  const edit_count_by_basename: Record<string, number> = {};
  for (const [_ep, _ec] of Object.entries(raw_edited)) {
    try {
      edit_count_by_norm[paths.normalizeKey(_ep).toLowerCase()] = _ec;
    } catch {
      // ignore
    }
    try {
      const _bn = nodePath.basename(_ep).toLowerCase();
      if (_bn) {
        edit_count_by_basename[_bn] = Math.max(edit_count_by_basename[_bn] ?? 0, _ec);
      }
    } catch {
      // ignore
    }
  }

  const _edit_count_for = (entry: FileEntry): number => {
    try {
      const key = _getAttr(entry, "key") || _getAttr(entry, "rel_or_abs");
      if (key) {
        const norm = paths.normalizeKey(String(key)).toLowerCase();
        if (norm in edit_count_by_norm) {
          return edit_count_by_norm[norm] ?? 0;
        }
      }
      const rel = _getAttr(entry, "rel_or_abs");
      if (rel) {
        const bn = nodePath.basename(String(rel)).toLowerCase();
        if (bn && bn in edit_count_by_basename) {
          return edit_count_by_basename[bn] ?? 0;
        }
      }
    } catch {
      // ignore
    }
    return 0;
  };

  let resume_anchor = _resume_anchor_for_recovery(raw_edited, cache);

  // -1. Edited files
  if (Object.keys(raw_edited).length > 0) {
    const edited_sorted = Object.entries(raw_edited).sort((a, b) => {
      if (b[1] !== a[1]) {
        return b[1] - a[1];
      }
      return b[0] < a[0] ? -1 : b[0] > a[0] ? 1 : 0;
    });
    const edited_lines = ["**Edited**:"];
    for (const [_ep, _ec] of edited_sorted.slice(0, 5)) {
      let _snap_path = _ep;
      try {
        const _fe = cache.files[_ep];
        if (_fe !== undefined && _getAttr(_fe, "rel_or_abs")) {
          _snap_path = String(_fe.rel_or_abs);
        }
      } catch {
        // ignore
      }
      let _diff = _diff_stats_for_file(session_id, _snap_path);
      if (_diff === null && _snap_path !== _ep) {
        _diff = _diff_stats_for_file(session_id, _ep);
      }
      let _diff_str = "";
      if (_diff !== null) {
        const [_added, _removed] = _diff;
        _diff_str = ` (+${_added}/-${_removed})`;
      }
      let _basename = _ep;
      try {
        _basename = nodePath.basename(_ep) || _ep;
      } catch {
        // ignore
      }
      edited_lines.push(`- ${_basename} ✎×${_ec}${_diff_str}`);
    }
    const dropped_edited = Object.keys(raw_edited).length - edited_sorted.slice(0, 5).length;
    if (dropped_edited > 0) {
      edited_lines.push(`- +${dropped_edited} more`);
    }
    sections.push(edited_lines.join("\n"));
  }

  // -0.5. Last bash commands
  const _has_meaningful_bash =
    Object.keys(raw_edited).length > 0 || Object.keys(cache.bash_history).length >= 2;
  if (Object.keys(cache.bash_history).length > 0 && _has_meaningful_bash) {
    const _bash_entry_ids = new Set(bash_entries.map((be) => be.output_id));
    const _small_cmds = Object.values(cache.bash_history)
      .filter((be) => !_bash_entry_ids.has(be.output_id))
      .sort((a, b) => b.ts - a.ts)
      .slice(0, 3);
    if (_small_cmds.length > 0) {
      const cmd_lines = ["**Last commands**:"];
      for (const _be of _small_cmds) {
        const _ts_str = _formatHHMM(_be.ts);
        const _exit_str = _be.exit_code === null ? "" : ` exit=${_be.exit_code}`;
        cmd_lines.push(`- \`${_be.cmd_preview}\`${_exit_str} @ ${_ts_str}`);
      }
      sections.push(cmd_lines.join("\n"));
    }
  }

  // 0. Loaded skills
  if (skill_entries.length > 0) {
    const now = Date.now() / 1000;
    const stale_threshold = 6 * 3600;

    const all_unique_names = new Set<string>();
    for (const se of skill_all) {
      const sn = String(_getAttr(se, "skill_name") ?? "");
      if (sn) {
        all_unique_names.add(sn);
      }
    }
    const deduped_skills = new Map<string, SkillEntry>();
    for (const se of skill_entries) {
      const sname = String(_getAttr(se, "skill_name") ?? "");
      const ts = _getNumberAttr(se, "ts", 0.0);
      const existing = deduped_skills.get(sname);
      if (sname && (existing === undefined || ts > _getNumberAttr(existing, "ts", 0.0))) {
        deduped_skills.set(sname, se);
      }
    }

    const sorted_skills = [...deduped_skills.values()].sort(
      (a, b) => _getNumberAttr(b, "ts", 0.0) - _getNumberAttr(a, "ts", 0.0),
    );
    const skill_parts: string[] = [];
    for (const se of sorted_skills.slice(0, 8)) {
      const sname = String(_getAttr(se, "skill_name") ?? "?");
      const ts = _getNumberAttr(se, "ts", 0.0);
      const age_secs = now - ts;
      let stale_marker = "";
      if (age_secs > stale_threshold) {
        const age_hours = Math.trunc(age_secs / 3600);
        stale_marker = ` (stale: ${age_hours}h)`;
      }
      skill_parts.push(`${sname}${stale_marker}`);
    }

    const shown_names = new Set<string>(
      sorted_skills.slice(0, 8).map((se) => String(_getAttr(se, "skill_name") ?? "")),
    );
    let dropped = 0;
    for (const n of all_unique_names) {
      if (!shown_names.has(n)) {
        dropped += 1;
      }
    }
    const suffix = dropped > 0 ? `, +${dropped} more` : "";
    const skill_str = skill_parts.join(", ") + suffix;
    const skill_header = "### Active Skills";
    const line = `${skill_header}: ${skill_str} (recall via \`token-goat skill-body <name>\`)`;
    sections.push(line);
  }

  // 0.25. Active task list (compact._load_task_list + _render_tasks_section)
  try {
    const compact = _compactModule;
    if (compact !== null) {
      const _raw_tasks = compact._load_task_list(session_id);
      if (_raw_tasks && _raw_tasks.length > 0) {
        const _task_lines = compact._render_tasks_section(_raw_tasks, {
          edited_paths: new Set(Object.keys(raw_edited)),
        });
        if (_task_lines && _task_lines.length > 0) {
          sections.push(_task_lines.join("\n"));
        }
      }
    }
  } catch {
    // never break the hint on task errors
  }

  // 0.5. Active blockers
  const [blocker_section, blocker_anchor] = _build_blocker_section(cache);
  if (blocker_section) {
    sections.push(blocker_section);
    if (!resume_anchor && blocker_anchor) {
      resume_anchor = `re-run ${blocker_anchor}`;
    }
  }

  // 1. Recently-touched files
  if (files_keep.length > 0) {
    const lines = ["### Edited Files"];
    for (const entry of files_keep) {
      const sym_count = entry.symbols_read.length;
      let sym_str: string;
      if (sym_count > 3) {
        sym_str = ` syms=${entry.symbols_read.slice(0, 3).join(",")}+${sym_count - 3}`;
      } else if (sym_count) {
        sym_str = ` syms=${entry.symbols_read.join(",")}`;
      } else {
        sym_str = "";
      }
      const ec = _edit_count_for(entry);
      const edit_str = ec >= 1 ? ` ✎×${ec}` : "";
      lines.push(`- ${entry.rel_or_abs}${edit_str}${sym_str}`);
    }
    const dropped = files_all.length - files_keep.length;
    if (dropped > 0) {
      lines.push(`- +${dropped} more`);
    }
    sections.push(lines.join("\n"));
  }

  // 1.5. Symbol cross-references
  const _MAX_SYMBOLS_RECOVERY = 10;
  const _symbol_entries: Array<[number, string, string, number]> = [];
  for (const _fe of Object.values(cache.files)) {
    const _rel = _getAttr(_fe, "rel_or_abs") ? String(_fe.rel_or_abs) : "";
    const _syms = _fe.symbols_read ?? [];
    const _sym_ts = _fe.symbols_ts ?? {};
    const _file_ts = _getNumberAttr(_fe, "last_read_ts", 0.0);
    for (const _sym of _syms) {
      const _ts = _sym in _sym_ts ? (_sym_ts[_sym] ?? _file_ts) : _file_ts;
      _symbol_entries.push([_ts, _sym, _rel, 0]);
    }
  }

  if (_symbol_entries.length > 0) {
    _symbol_entries.sort((a, b) => {
      if (b[0] !== a[0]) {
        return b[0] - a[0];
      }
      return a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0;
    });
    const _seen_syms = new Set<string>();
    const _deduped_syms: Array<[number, string, string, number]> = [];
    for (const _entry of _symbol_entries) {
      if (!_seen_syms.has(_entry[1])) {
        _seen_syms.add(_entry[1]);
        _deduped_syms.push(_entry);
      }
    }
    const _top_syms = _deduped_syms.slice(0, _MAX_SYMBOLS_RECOVERY);
    if (_top_syms.length > 0) {
      const sym_lines = ["**Symbols**:"];
      for (const [, _sym, _rel] of _top_syms) {
        const _basename = _rel ? nodePath.basename(_rel) : "?";
        sym_lines.push(`- ${_sym} (${_basename})`);
      }
      sections.push(sym_lines.join("\n"));
    }
  }

  // 2. Recent Bash output IDs
  if (bash_entries.length > 0) {
    const has_edits = Object.keys(cache.edited_files ?? {}).length > 0;
    const lines = ["**Bash**:"];
    for (const be of bash_entries) {
      if (_is_green_pytest(be) && has_edits) {
        const ts_str = _formatHHMM(be.ts);
        lines.push(
          `- ✓ pytest passed @ ${ts_str}` +
            ` (token-goat bash-output ${_short_id(be.output_id)} for details)`,
        );
      } else {
        const exit_str = be.exit_code === null ? "" : ` exit=${be.exit_code}`;
        const total = be.stdout_bytes + be.stderr_bytes;
        lines.push(
          `- \`${be.cmd_preview}\` (${util._humanizeBytes(total)}${exit_str}) \`${_short_id(be.output_id)}\``,
        );
      }
    }
    const dropped = bash_all.length - bash_entries.length;
    if (dropped > 0) {
      lines.push(`- +${dropped} more`);
    }
    sections.push(lines.join("\n"));
  }

  // 3. Recent WebFetch outputs
  if (web_entries.length > 0) {
    const lines = ["**Web**:"];
    for (const we of web_entries) {
      const status_str = we.status_code === null ? "" : ` status=${we.status_code}`;
      lines.push(
        `- \`${we.url_preview}\` (${util._humanizeBytes(we.body_bytes)}${status_str}) \`${_short_id(we.output_id)}\``,
      );
    }
    const dropped = web_all.length - web_entries.length;
    if (dropped > 0) {
      lines.push(`- +${dropped} more`);
    }
    sections.push(lines.join("\n"));
  }

  if (sections.length === 0) {
    return null;
  }

  // 4. Pending work
  const _bash_in_hint_ids = new Set(bash_entries.map((be) => be.output_id));
  const pending_section = _build_pending_work_section(cache, raw_edited, _bash_in_hint_ids);
  if (pending_section) {
    sections.push(pending_section);
  }

  // 5. Key commands
  const _has_edited_python =
    files_keep.some((entry) => (_getAttr(entry, "rel_or_abs") || "").toString().endsWith(".py")) ||
    Object.keys(raw_edited).some((ep) => String(ep).endsWith(".py"));
  const _has_pytest_in_hint =
    bash_entries.some((be) =>
      _PYTEST_PREFIXES.some((p) => String(_getAttr(be, "cmd_preview") ?? "").trim().toLowerCase().startsWith(p)),
    ) ||
    Object.values(cache.bash_history ?? {}).some((be) =>
      _PYTEST_PREFIXES.some((p) => String(_getAttr(be, "cmd_preview") ?? "").trim().toLowerCase().startsWith(p)),
    );
  const _has_web_in_hint = web_entries.length > 0;
  const key_cmds_section = _build_key_commands_section(
    _has_edited_python,
    _has_pytest_in_hint,
    _has_web_in_hint,
  );
  sections.push(key_cmds_section);

  const parts = ["## Post-Compact Recovery"];

  // Session goal inference (compact.infer_session_goal)
  try {
    const compact = _compactModule;
    if (compact !== null) {
      const session_goal = compact.infer_session_goal(cache);
      if (session_goal) {
        parts.push(`**Session goal:** ${session_goal}`);
      }
    }
  } catch {
    // fail-soft
  }

  if (resume_anchor) {
    parts.push(`🎯 **RESUME**: ${resume_anchor}`);
  }
  parts.push(`**Quick restore:** \`token-goat resume ${session_id.slice(0, 8)}\``);
  const recall: string[] = [];
  if (skill_entries.length > 0) {
    recall.push("`token-goat skill-body <name>`");
  }
  if (bash_entries.length > 0) {
    recall.push("`token-goat bash-output <id>`");
  }
  if (web_entries.length > 0) {
    recall.push("`token-goat web-output <id>`");
  }
  if (recall.length > 0) {
    parts.push("Recall: " + recall.join(" / ") + ".");
  }
  if (skill_entries.length > 0) {
    parts.push(
      "_Tip: use `token-goat skill-body <name> --section DoD` to fetch only one section._",
    );
  }
  parts.push(...sections);
  const hint_text = parts.join("\n\n");
  return _truncate_recovery_hint(hint_text);
}

/**
 * Return the bytes_estimate from the most recently written precompact estimate
 * sentinel (written within the last 5 minutes), then delete it. Fail-soft -> 0.
 */
export function _read_precompact_estimate(): number {
  try {
    const sentinels = paths.sentinelsDir();
    try {
      if (!fs.statSync(sentinels).isDirectory()) {
        return 0;
      }
    } catch {
      return 0;
    }
    const cutoff = Date.now() / 1000 - 300.0;
    const candidates: Array<[number, string]> = [];
    let names: string[];
    try {
      names = fs.readdirSync(sentinels);
    } catch {
      return 0;
    }
    for (const name of names) {
      if (!name.startsWith("precompact_estimate_") || !name.endsWith(".json")) {
        continue;
      }
      const p = nodePath.join(sentinels, name);
      try {
        const mtime = fs.statSync(p).mtimeMs / 1000;
        if (mtime >= cutoff) {
          candidates.push([mtime, p]);
        }
      } catch {
        continue;
      }
    }
    if (candidates.length === 0) {
      return 0;
    }
    candidates.sort((a, b) => b[0] - a[0]);
    const best = candidates[0]![1];
    let estimate = 0;
    try {
      const data = JSON.parse(fs.readFileSync(best, "utf-8")) as Record<string, unknown>;
      const raw = data["bytes_estimate"];
      estimate = typeof raw === "number" ? Math.trunc(raw) : Number.parseInt(String(raw ?? 0), 10) || 0;
    } catch {
      estimate = 0;
    }
    try {
      fs.rmSync(best, { force: true });
    } catch {
      // ignore
    }
    _LOG.debug(
      "session-start: read precompact estimate %d bytes from %s",
      estimate,
      nodePath.basename(best),
    );
    return Math.max(0, estimate);
  } catch {
    return 0;
  }
}

/**
 * Defer a recovery hint by writing a sidecar when *source* is "compact".
 *
 * Returns null in all cases so the caller always falls through to the normal
 * session-start flow.
 */
export function _try_recovery_response(
  session_id: string | null,
  source: string,
): HookResponse | null {
  if (source !== "compact" || !session_id) {
    return null;
  }
  const hint = _build_recovery_hint(session_id);
  if (!hint) {
    return null;
  }

  const bytes_estimate = _read_precompact_estimate();

  try {
    const payload = JSON.stringify({ hint, bytes_estimate });
    const sidecar = paths.recoveryPendingPath(session_id);
    paths.atomicWriteText(sidecar, payload);
    _LOG.info(
      "session-start: compact-recovery hint deferred to sidecar for session=%s" +
        " (%d chars, bytes_estimate=%d)",
      session_id.slice(0, 16),
      hint.length,
      bytes_estimate,
    );
  } catch {
    _LOG.debug("recovery hint: sidecar write failed");
  }

  return null;
}

/**
 * Parse the NUL-separated output of `git status -z -b`.
 *
 * Returns [branch, status_lines, total_count]; status_lines capped at 50.
 */
export function _parse_status_z_b(output: string): [string, string[], number] {
  if (!output) {
    return ["unknown", [], 0];
  }

  const fields = output.split("\0");

  let branch = "unknown";
  const status_lines: string[] = [];
  let total_count = 0;
  let skip_next = false;

  for (const field of fields) {
    if (!field) {
      continue;
    }
    if (skip_next) {
      skip_next = false;
      continue;
    }
    if (field.startsWith("## ")) {
      const header = field.slice(3); // strip "## "
      let local = (header.split("...")[0] ?? "").trim();
      if (local.startsWith("No commits yet on ")) {
        local = local.slice("No commits yet on ".length).trim();
      }
      if (local && local !== "HEAD (no branch)" && local !== "HEAD") {
        branch = local;
      } else if (local === "HEAD (no branch)" || local === "HEAD") {
        branch = "HEAD";
      }
    } else if (field.length >= 3 && field[2] === " ") {
      const xy = field.slice(0, 2);
      if (xy[0] === "R" || xy[0] === "C" || xy[1] === "R" || xy[1] === "C") {
        skip_next = true;
      }
      total_count += 1;
      if (status_lines.length < 50) {
        status_lines.push(field);
      }
    }
  }

  return [branch, status_lines, total_count];
}

/**
 * Build a compact git orientation brief for the session start context.
 *
 * Returns a single-line summary (under 80 tokens) or null. The git subprocesses
 * share one wall-clock deadline.
 */
export function _build_session_brief(cwd: string): string | null {
  // Feature gate: env var override (checked first, cheapest)
  const env_val = (process.env["TOKEN_GOAT_SESSION_BRIEF"] ?? "").trim().toLowerCase();
  if (["0", "false", "no", "off"].includes(env_val)) {
    return null;
  }

  // Feature gate: config file
  try {
    const cfg = config.load();
    if (!(cfg.session_brief?.enabled ?? true)) {
      return null;
    }
  } catch {
    // fail-open: config load errors don't suppress the brief
  }

  try {
    if (!fs.statSync(cwd).isDirectory()) {
      return null;
    }
  } catch {
    return null;
  }

  // --- Git-state fingerprint (two stat calls) ---
  const _git_dir = nodePath.join(cwd, ".git");
  let _mtime_editmsg = 0.0;
  let _mtime_index = 0.0;
  try {
    _mtime_editmsg = fs.statSync(nodePath.join(_git_dir, "COMMIT_EDITMSG")).mtimeMs / 1000;
  } catch {
    // ignore
  }
  try {
    _mtime_index = fs.statSync(nodePath.join(_git_dir, "index")).mtimeMs / 1000;
  } catch {
    // ignore
  }

  // --- TTL + fingerprint cache check ---
  const _now_mono = _monotonicSecs();
  const _cached = _brief_cache.get(cwd);
  if (_cached !== undefined) {
    const [_cached_brief, _cached_em, _cached_idx, _cached_ts] = _cached;
    const _age = _now_mono - _cached_ts;
    if (
      _age < _BRIEF_CACHE_TTL_SECS &&
      _mtime_editmsg === _cached_em &&
      _mtime_index === _cached_idx
    ) {
      _LOG.debug("session-start: brief cache hit for %s (age=%.1fs)", cwd, _age);
      return _cached_brief;
    }
  }

  // Whole-brief wall-clock budget.
  const deadline = _monotonicSecs() + 2.5;
  const _remaining = (): number => deadline - _monotonicSecs();

  // Single-call: `git --no-optional-locks status -z -b`.
  let branch = "unknown";
  let status_lines: string[] = [];
  let _status_total = 0;
  try {
    const sz = _run_git(["status", "-z", "-b"], {
      cwd,
      timeout: Math.max(0.1, Math.min(2.0, _remaining())),
    });
    if (sz.returncode === 128) {
      _brief_cache.set(cwd, [null, _mtime_editmsg, _mtime_index, _now_mono]);
      return null;
    }
    if (sz.returncode === 0) {
      [branch, status_lines, _status_total] = _parse_status_z_b(sz.stdout);
    } else if (sz.returncode === -1) {
      // Spawn failure (git not found / timeout folded into returncode -1).
      return null;
    }
  } catch {
    return null;
  }

  // git log --oneline (adaptive count)
  let log_lines: string[] = [];
  let _skip_log = false;
  let _log_count = 5;
  if (["main", "master", "develop"].includes(branch) && status_lines.length === 0) {
    const _log_skip_budget = _remaining();
    if (_log_skip_budget > 0.1) {
      try {
        const _rl = _run_git(
          ["rev-list", "--left-right", "--count", `HEAD...origin/${branch}`],
          { cwd, timeout: Math.max(0.1, Math.min(0.8, _log_skip_budget)) },
        );
        if (_rl.returncode === 0) {
          const _parts = _rl.stdout.trim().split(/\s+/).filter((s) => s.length > 0);
          if (_parts.length === 2) {
            const [_ahead, _behind] = _parts;
            if (_ahead === "0" && _behind === "0") {
              _skip_log = true;
            } else if (_ahead === "0") {
              _log_count = 2;
            }
          }
        }
      } catch {
        // fail-open
      }
    }
  }

  const log_budget = _remaining();
  if (log_budget > 0.1 && !_skip_log) {
    try {
      const lg = _run_git(["log", "--oneline", `-${_log_count}`], { cwd, timeout: log_budget });
      if (lg.returncode === 0) {
        log_lines = lg.stdout
          .split(/\r?\n/)
          .map((line) => line.trim())
          .filter((line) => line.length > 0);
      }
    } catch {
      // ignore
    }
  }

  if (status_lines.length === 0 && log_lines.length === 0) {
    if (_skip_log && ["main", "master", "develop"].includes(branch)) {
      const brief = `${branch} (clean)`;
      _brief_cache.set(cwd, [brief, _mtime_editmsg, _mtime_index, _now_mono]);
      return brief;
    }
    _brief_cache.set(cwd, [null, _mtime_editmsg, _mtime_index, _now_mono]);
    return null;
  }

  // Build single-line brief: branch [| status] [— commits]
  const parts: string[] = [branch];

  if (status_lines.length > 0) {
    const staged = status_lines.filter(
      (line) => ![" ", "?", "!"].includes(line.slice(0, 1)),
    ).length;
    const modified = status_lines.filter((line) => line.slice(1, 2) === "M").length;
    const untracked = status_lines.filter((line) => line.startsWith("??")).length;
    const counts: string[] = [];
    if (staged) {
      counts.push(`${staged} staged`);
    }
    if (modified) {
      counts.push(`${modified} modified`);
    }
    if (untracked) {
      counts.push(`${untracked} untracked`);
    }
    let status_str = counts.length > 0 ? counts.join(", ") : "changes";
    const truncated = _status_total - status_lines.length;
    if (truncated > 0) {
      status_str += ` (+${_status_total - status_lines.length} more files)`;
    }
    parts.push(`| ${status_str}`);
  }

  if (log_lines.length > 0) {
    const short_commits: string[] = [];
    for (const entry of log_lines.slice(0, 5)) {
      const idx = entry.indexOf(" ");
      if (idx !== -1) {
        const h = entry.slice(0, idx);
        const msg = entry.slice(idx + 1).slice(0, 40);
        short_commits.push(`${h} ${msg}`);
      } else {
        short_commits.push(entry.slice(0, 50));
      }
    }
    parts.push("— " + short_commits.join(" | "));
  }

  const brief = parts.join(" ");
  _LOG.debug("session-start: orientation brief built (%d chars)", brief.length);
  _brief_cache.set(cwd, [brief, _mtime_editmsg, _mtime_index, _now_mono]);
  return brief;
}

/**
 * Detect the current project from cwd. Returns null if not in a project root.
 */
export function _detect(payload: HookPayload): Project | null {
  const cwd_path = validate_cwd(payload["cwd"], { caller: "session-start" });
  if (cwd_path === null) {
    return null;
  }
  return project.find_project(cwd_path);
}

/** Auto-index unindexed projects on first contact. */
export function _auto_index_if_needed(proj: Project): void {
  try {
    const worker = _workerModule;
    if (!db.projectHasFiles(proj.hash)) {
      const pid = worker !== null ? worker.spawn_index_detached(proj.root, proj.hash) : null;
      if (pid) {
        _LOG.info("session-start: auto-indexing %s in background (pid=%s)", proj.root, String(pid));
      } else {
        _LOG.warning(
          "session-start: auto-index spawn returned no PID for %s; " +
            "indexing may be already active or spawn failed; " +
            "check index-spawn.log for details",
          proj.root,
        );
      }
    } else {
      _LOG.debug("session-start: project %s already indexed; skipping auto-index", proj.hash.slice(0, 8));
    }
  } catch {
    _LOG.error("auto-index spawn failed");
  }
}

// How old (in seconds) the index must be before we emit a stale-index hint.
const _INDEX_STALE_SECS = 3600;

/**
 * Return a stale-index hint string when the project index is more than
 * _INDEX_STALE_SECS seconds old, or null. Fail-soft -> null.
 */
export function _index_stale_hint(proj: Project): string | null {
  let stale_secs = _INDEX_STALE_SECS;
  const raw_env = process.env["TOKEN_GOAT_INDEX_STALE_SECS"];
  if (raw_env !== undefined) {
    const parsed = Number.parseInt(raw_env, 10);
    if (Number.isFinite(parsed)) {
      stale_secs = parsed;
    }
  }

  try {
    const last_ts = db.projectLastIndexedTs(proj.hash);
    if (last_ts === 0.0) {
      return null;
    }
    const age = Date.now() / 1000 - last_ts;
    if (age <= stale_secs) {
      return null;
    }

    let age_str: string;
    if (age < 3600) {
      age_str = `${Math.trunc(age / 60)}m ago`;
    } else if (age < 86400) {
      age_str = `${Math.trunc(age / 3600)}h ago`;
    } else {
      age_str = `${Math.trunc(age / 86400)}d ago`;
    }

    return `Index may be stale (last indexed ${age_str})` + " — run `token-goat index` to refresh.";
  } catch {
    return null;
  }
}

/**
 * Build additionalContext from project memory for the session-start response.
 * Returns null when the project has no stored memory entries.
 */
export function _build_startup_context(proj: Project): string | null {
  try {
    return project_memory.build_injection(proj.hash);
  } catch {
    _LOG.debug("session-start: project memory injection failed");
    return null;
  }
}

/** Watchdog: start or verify worker daemon is alive. */
export function _ensure_worker_running(): void {
  try {
    const worker = _workerModule;
    const pid = worker !== null ? worker.ensure_running() : null;
    if (pid) {
      _LOG.info("session-start: worker pid=%s", String(pid));
    }
  } catch {
    _LOG.error("watchdog failed");
  }
}

/**
 * Return the SessionStart `source` field, defaulting to "startup".
 */
export function _read_source(payload: HookPayload): string {
  const raw = payload["source"];
  if (typeof raw === "string") {
    return raw;
  }
  return "startup";
}

/**
 * Return a one-line environmental-baseline advisory, or null. Fail-soft.
 */
export function _maybe_baseline_advisory(
  session_id: string | null,
  cwd: string | null,
): string | null {
  if (!session_id) {
    return null;
  }
  let budget: number;
  try {
    budget = config.load().hints?.baseline_budget_tokens ?? 0;
  } catch {
    return null;
  }
  if (budget <= 0) {
    return null;
  }
  let sentinel: string;
  try {
    sentinel = paths.baselineAdvisorySentPath(session_id);
    try {
      fs.statSync(sentinel);
      return null; // exists
    } catch {
      // absent — proceed
    }
  } catch {
    return null;
  }
  let fixed: number;
  try {
    const baseline = _baselineModule;
    if (baseline === null) {
      return null;
    }
    const base = cwd ? cwd : process.cwd();
    fixed = baseline.collect_baseline(base, session_id).fixed_tokens;
  } catch {
    return null;
  }
  if (fixed <= budget) {
    return null;
  }
  try {
    paths.atomicWriteText(sentinel, "1");
  } catch {
    _LOG.debug("session-start: baseline advisory sentinel write failed");
  }
  return (
    `[token-goat] Environmental baseline is ~${_thousands(fixed)} fixed tokens ` +
    `(over the ${_thousands(budget)}-token budget). Run \`token-goat baseline\` to see ` +
    "which sources cost the most and how to trim them."
  );
}

/**
 * Run the appropriate session-lifecycle action for the inbound source.
 */
export function session_start(payload: HookPayload): HookResponse {
  const [session_id, cwd] = get_session_context(payload);
  const source = _read_source(payload);
  _LOG.info(
    "session-start: session_id=%s cwd=%s source=%s",
    sanitize_opt(session_id),
    sanitize_opt(cwd),
    sanitize_opt(source),
  );

  // Best-effort stale session cleanup (>7 days).
  try {
    const _cleaned = session.cleanup_stale(168.0);
    if (_cleaned) {
      _LOG.info("session-start: cleaned up %d stale session file(s) (>7d)", _cleaned);
    }
  } catch {
    _LOG.debug("session-start: stale session cleanup failed (non-fatal)");
  }

  self._try_recovery_response(session_id, source);
  const proj = self._detect(payload);
  if (proj) {
    _LOG.info("session-start: detected project %s (%s)", proj.root, proj.hash.slice(0, 8));
    db.touchProjectLastSeen(proj.hash);
    _auto_index_if_needed(proj);
  }
  _ensure_worker_running();

  if (source === "compact") {
    return CONTINUE();
  }

  // Non-compact branch: cache reset.
  _reset_session_cache(session_id);

  // Best-effort MEMORY.md prune (throttled 24 h).
  _prune_memory_index(session_id, cwd);

  // Git orientation brief.
  let brief: string | null = null;
  if (cwd) {
    try {
      brief = self._build_session_brief(cwd);
    } catch {
      _LOG.debug("session-start: brief build failed");
    }
  }

  let mem_ctx: string | null = null;
  let stale_hint: string | null = null;
  if (proj !== null) {
    mem_ctx = _build_startup_context(proj);
    stale_hint = _index_stale_hint(proj);
  }

  const additional_ctx_parts: string[] = [];
  if (mem_ctx) {
    additional_ctx_parts.push(mem_ctx);
  }
  if (stale_hint) {
    additional_ctx_parts.push(stale_hint);
  }
  const baseline_advisory = _maybe_baseline_advisory(session_id, cwd);
  if (baseline_advisory) {
    additional_ctx_parts.push(baseline_advisory);
  }
  const combined_mem: string | null =
    additional_ctx_parts.length > 0 ? additional_ctx_parts.join("\n\n") : null;

  if (brief || combined_mem) {
    const resp: HookResponse = {
      continue: true,
      hookSpecificOutput: {
        hookEventName: "SessionStart",
      },
    };
    if (brief) {
      resp.systemMessage = brief;
    }
    if (combined_mem) {
      const hso = resp.hookSpecificOutput;
      if (_isPlainDict(hso)) {
        (hso as Record<string, unknown>)["additionalContext"] = combined_mem;
      }
    }
    return resp;
  }

  return CONTINUE();
}

// ---------------------------------------------------------------------------
// UserPromptSubmit: inject 1-line session-context summary
// ---------------------------------------------------------------------------

/**
 * UserPromptSubmit hook: inject a 1-line session-context summary.
 *
 * Format: [branch: main | edits: 3 | last_exit: 0]
 */
export function user_prompt_submit(payload: HookPayload): HookResponse {
  // Short-circuit for trivial prompts (< 8 chars after strip).
  const _raw_prompt = payload["prompt"] ?? "";
  if (typeof _raw_prompt === "string" && _raw_prompt.trim().length < 8) {
    return CONTINUE();
  }

  const [session_id, cwd] = get_session_context(payload);
  if (!session_id) {
    return CONTINUE();
  }

  const parts: string[] = [];

  // Git branch.
  if (cwd) {
    try {
      const r = _run_git(["-C", cwd, "rev-parse", "--abbrev-ref", "HEAD"], { timeout: 3 });
      const branch = r.stdout.trim();
      if (branch) {
        parts.push(`branch: ${branch}`);
      }
    } catch {
      // ignore
    }
  }

  // Edit count and last bash exit from session cache.
  let cache: SessionCache | null = null;
  try {
    cache = session.safe_load(session_id, { caller: "user-prompt-submit" });
    if (cache !== null) {
      const edit_count = Object.keys(_getAttr(cache, "edited_files") ?? {}).length;
      parts.push(`edits: ${edit_count}`);
    }
  } catch {
    // ignore
  }

  // Last Bash exit code from session cache bash history.
  try {
    if (cache !== null) {
      const bash_hist = (_getAttr(cache, "bash_history") as Record<string, unknown> | undefined) ?? {};
      const values = Object.values(bash_hist);
      if (values.length > 0) {
        const latest = _maxBy(values, (e) => _getNumberAttr(e, "ts", 0));
        if (latest !== null && latest !== undefined) {
          const exit_code = _getAttr(latest, "exit_code");
          if (exit_code !== null && exit_code !== undefined) {
            parts.push(`last_exit: ${String(exit_code)}`);
          }
        }
      }
    }
  } catch {
    // ignore
  }

  // Context threshold advisory.
  let _ctx_advisory_prefix: string | null = null;
  try {
    const _hints_cfg = config.load().hints;
    const compact = _compactModule;
    if (_hints_cfg?.context_threshold_advisory && cache !== null && compact !== null) {
      cache.turns_since_last_compact = (_getNumberAttr(cache, "turns_since_last_compact", 0)) + 1;

      const _pressure = compact.get_context_pressure(_getAttr(cache, "session_id") as string | null, {
        cache,
      });
      const _ctx_pct = _pressure.fill_fraction;
      const _pct_int = Math.trunc(_ctx_pct * 100);
      const _last_thr = _getAttr(cache, "last_context_advisory_threshold");

      if (_ctx_pct >= 0.85) {
        _ctx_advisory_prefix = `CONTEXT ~${_pct_int}% full. /compact now. `;
      } else if (_ctx_pct >= 0.7 && _last_thr !== 70) {
        cache.last_context_advisory_threshold = 70;
        _ctx_advisory_prefix = `CONTEXT ~${_pct_int}% full. Consider /compact soon. `;
      } else if (_ctx_pct >= 0.5 && (_last_thr === null || _last_thr === undefined)) {
        cache.last_context_advisory_threshold = 50;
        parts.push(`ctx: ~${_pct_int}% — context approaching midpoint`);
      }

      session.save(cache);
    }
  } catch {
    // ignore
  }

  // Keyword-triggered hints.
  const _keyword_hints: string[] = [];
  try {
    const _triggers = config.load().hints?.prompt_triggers;
    if (
      _triggers &&
      _triggers.length > 0 &&
      typeof _raw_prompt === "string" &&
      _raw_prompt.trim()
    ) {
      const _prompt_words = new Set(
        _raw_prompt
          .toLowerCase()
          .replace(/[^a-z0-9]/g, " ")
          .split(/\s+/)
          .filter((w) => w.length > 0),
      );
      for (const _trig of _triggers) {
        if (_trig.keywords.some((kw) => _prompt_words.has(kw))) {
          _keyword_hints.push(_trig.hint);
        }
      }
    }
  } catch {
    // ignore
  }

  if (parts.length === 0 && _ctx_advisory_prefix === null && _keyword_hints.length === 0) {
    return CONTINUE();
  }

  const _summary_parts = [...parts];
  for (const _kh of _keyword_hints) {
    _summary_parts.push(`hint: ${_kh}`);
  }

  let summary: string;
  if (_ctx_advisory_prefix !== null) {
    summary = "[" + _ctx_advisory_prefix + _summary_parts.join(" | ") + "]";
  } else {
    summary = "[" + _summary_parts.join(" | ") + "]";
  }
  _LOG.debug("user-prompt-submit: injecting context summary: %s", summary);
  return {
    continue: true,
    hookSpecificOutput: {
      hookEventName: "UserPromptSubmit",
      additionalContext: summary,
    },
  };
}

// ---------------------------------------------------------------------------
// SubagentStop: detect subagent hallucination (claimed work but no disk changes)
// ---------------------------------------------------------------------------

// Sidecar filename written inside sessions_dir() when a suspicious stop fires.
export const _SUBAGENT_HALLUCINATION_SIDECAR = "subagent_hallucination_flags.jsonl";

/**
 * SubagentStop hook: detect when a subagent claimed work but left no disk changes.
 */
export function subagent_stop(payload: HookPayload): HookResponse {
  const [session_id, cwd] = get_session_context(payload);
  if (!session_id || !cwd) {
    return CONTINUE();
  }

  const cache = session.safe_load(session_id, { caller: "subagent-stop" });
  if (cache === null) {
    return CONTINUE();
  }
  const edited = (_getAttr(cache, "edited_files") as Record<string, number> | undefined) ?? {};
  if (_isEmptyEdited(edited)) {
    return CONTINUE();
  }

  // Run git status --porcelain.
  const r = _run_git(["-C", cwd, "status", "--porcelain"], { timeout: 5 });
  const git_output = r.stdout.trim();

  if (git_output) {
    return CONTINUE();
  }

  _LOG.warning(
    "subagent-stop: possible hallucination — session=%s recorded %d edit(s) but git status is clean",
    sanitize_opt(session_id),
    _editedLen(edited),
  );
  try {
    const sidecar_dir = paths.ensureDir(paths.sessionsDir());
    const sidecar_path = nodePath.join(sidecar_dir, _SUBAGENT_HALLUCINATION_SIDECAR);
    const record = JSON.stringify({
      ts: Date.now() / 1000,
      session_id,
      cwd,
      trigger: "SubagentStop",
    });
    fs.appendFileSync(sidecar_path, record + "\n", { encoding: "utf-8" });
  } catch {
    // ignore
  }

  return CONTINUE();
}

// ---------------------------------------------------------------------------
// Internal helpers (no Python analogue — narrowing shims / stdlib analogues).
// ---------------------------------------------------------------------------

/** True for a plain (non-array, non-null) object. */
function _isPlainDict(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Python getattr(obj, name) -> value or undefined. Handles MagicMock-like dicts. */
function _getAttr(obj: unknown, name: string): unknown {
  if (obj === null || obj === undefined) {
    return undefined;
  }
  if (typeof obj === "object" || typeof obj === "function") {
    return (obj as Record<string, unknown>)[name];
  }
  return undefined;
}

/** Python getattr(obj, name, fallback) for a numeric attribute. */
function _getNumberAttr(obj: unknown, name: string, fallback: number): number {
  const v = _getAttr(obj, name);
  return typeof v === "number" && Number.isFinite(v) ? v : fallback;
}

/** Python max(iterable, key=fn). Returns null for an empty list. */
function _maxBy<T>(items: T[], key: (item: T) => number): T | null {
  if (items.length === 0) {
    return null;
  }
  let best = items[0]!;
  let bestKey = key(best);
  for (let i = 1; i < items.length; i += 1) {
    const k = key(items[i]!);
    if (k > bestKey) {
      bestKey = k;
      best = items[i]!;
    }
  }
  return best;
}

/** datetime.fromtimestamp(ts).strftime("%H:%M") — local time. */
function _formatHHMM(ts: number): string {
  const d = new Date(ts * 1000);
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  return `${hh}:${mm}`;
}

/** time.monotonic() in seconds. */
function _monotonicSecs(): number {
  return performance.now() / 1000;
}

/** Python re.escape. */
function _escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Python f"{n:,}" — thousands separator. */
function _thousands(n: number): string {
  return n.toLocaleString("en-US");
}

/** Python str.splitlines(keepends=True) — keep the line terminator on each line. */
function _splitlinesKeepends(text: string): string[] {
  const out: string[] = [];
  // Match a run of non-terminator chars followed by an optional terminator.
  const re = /[^\r\n]*(?:\r\n|\r|\n)?/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    if (m[0] === "" && m.index >= text.length) {
      break;
    }
    out.push(m[0]);
    if (m.index === re.lastIndex) {
      re.lastIndex += 1;
    }
  }
  return out;
}

/**
 * Minimal unified-diff prefix emitter sufficient for the +/- line counting in
 * _diff_stats_for_file. Python uses difflib.unified_diff(snap, current, n=0).
 * We only need the count of "+"-prefixed and "-"-prefixed body lines, which
 * equals the number of removed lines (in a only) and added lines (in b only)
 * per the LCS diff. Implemented via a standard LCS over the two line arrays.
 */
function _unifiedDiff(a: string[], b: string[]): string[] {
  const n = a.length;
  const m = b.length;
  // LCS length table.
  const lcs: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i -= 1) {
    for (let j = m - 1; j >= 0; j -= 1) {
      if (a[i] === b[j]) {
        lcs[i]![j] = lcs[i + 1]![j + 1]! + 1;
      } else {
        lcs[i]![j] = Math.max(lcs[i + 1]![j]!, lcs[i]![j + 1]!);
      }
    }
  }
  const out: string[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      i += 1;
      j += 1;
    } else if (lcs[i + 1]![j]! >= lcs[i]![j + 1]!) {
      out.push("-" + a[i]!);
      i += 1;
    } else {
      out.push("+" + b[j]!);
      j += 1;
    }
  }
  while (i < n) {
    out.push("-" + a[i]!);
    i += 1;
  }
  while (j < m) {
    out.push("+" + b[j]!);
    j += 1;
  }
  return out;
}

/** edited_files may be a dict (real cache) or a Set (MagicMock test). Emptiness check. */
function _isEmptyEdited(edited: unknown): boolean {
  if (edited instanceof Set) {
    return edited.size === 0;
  }
  if (_isPlainDict(edited)) {
    return Object.keys(edited).length === 0;
  }
  if (Array.isArray(edited)) {
    return edited.length === 0;
  }
  return !edited;
}

/** Length of edited_files for logging (Set or dict). */
function _editedLen(edited: unknown): number {
  if (edited instanceof Set) {
    return edited.size;
  }
  if (_isPlainDict(edited)) {
    return Object.keys(edited).length;
  }
  if (Array.isArray(edited)) {
    return edited.length;
  }
  return 0;
}
