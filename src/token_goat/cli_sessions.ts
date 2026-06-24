/**
 * Session + compaction command implementations — the TS port of cli.py's
 * batch C1 commands (10 commands; the 11th, `compact-hint`, is deferred to
 * a separate C2 run because it carries a ~768-LOC body + a --watch poll loop).
 *
 * Faithful 1:1 port of these cli.py command bodies:
 *   - cache-audit       (2624–2670)  Advanced panel; no dedicated CLI test.
 *   - session-touched   (2671–2703)  Advanced panel; incidental CLI coverage.
 *   - session-summary   (2704–2853)  Advanced panel; dedicated CLI test.
 *   - session-mark      (2854–2869)  Advanced panel, HIDDEN.
 *   - decision          (5716–5852)  Core panel.
 *   - pinned            (5853–5976)  Core panel.
 *   - resume            (5977–6045)  Core panel.
 *   - recovery          (6046–6125)  Core panel.
 *   - sessions          (8114–8155)  Core panel; dedicated CLI test.
 *   - sessions-show     (8156–8284)  Core panel; dedicated CLI test.
 *
 * Plus the two helpers those commands share (defined inline in cli.py):
 *   - _format_relative_time   (8045–8053)
 *   - _load_session_summaries (8056–8111)
 *
 * Output seam (Python `typer.echo` / `raise typer.Exit` / `_error` / `_warn`)
 * routes through cli_common.ts (`_echo` / `CliExit` / `_error` / `_warn`) —
 * identical to read_commands.ts / cli_lookup.ts. `raise typer.Exit(n)` becomes
 * `throw new CliExit(n)`; `_emit_json(data)` (which throws CliExit(0) after
 * echoing compact JSON) becomes a direct `_echo(JSON.stringify(data))` +
 * `return` (these command bodies `return` after `_emit_json` rather than
 * relying on the thrown exit, matching the Python control flow).
 *
 * JSON parity: every JSON dump site uses bare `JSON.stringify(x)` — compact
 * (separators `,`/`:`) and no ASCII escape — matching Python's
 * `json.dumps(x, ensure_ascii=False, separators=(",", ":"))`. (The two Python
 * call sites that matter here — session-touched and sessions/sessions-show —
 * both pass `separators=(",", ":")` and `ensure_ascii=False`.)
 *
 * Helpers invoked from another function in this module go through `self.fn()`
 * (static `import * as self`) — the ESM live-binding analogue of Python module
 * attribute patching, so a test that `vi.spyOn`s these boundaries sees the
 * patched implementation (a documented gotcha: ESM named-import bindings are
 * read-only and bypass spies).
 *
 * `--session-id` validation: commands that take an explicit `--session-id`
 * (session-touched, session-mark) validate via the `validateSessionId` helper
 * below, which mirrors cli.ts `_validate_session_id` (wraps
 * `session.validate_session_id`, exits 1 on invalid). The decision/pinned/
 * resume/recovery commands resolve short-or-empty session ids by scanning the
 * sessions dir themselves (replicating cli.py's `_resolve_session_id` closures)
 * and do NOT call the validator (matching Python — those commands never invoke
 * `_validate_session_id`).
 */
import * as fs from "node:fs";
import * as path from "node:path";

import * as compact from "./compact.js";
import * as config from "./config.js";
import * as db from "./db.js";
import * as hooks_cli from "./hooks_cli.js";
import * as hooks_session from "./hooks_session.js";
import * as paths from "./paths.js";
import * as resume from "./resume.js";
import * as session from "./session.js";
import * as stats from "./stats.js";
import { runGit } from "./util.js";
import { CliExit, _echo, _error, _warn } from "./cli_common.js";
import { getLogger } from "./util.js";
import { _splitlinesKeepends, _unifiedDiff } from "./hints.js";
import { roundHalfEven } from "./skill_cache.js";

import * as self from "./cli_sessions.js";

const _LOG = getLogger("cli_sessions");

// ---------------------------------------------------------------------------
// Python-semantics parity helpers
// ---------------------------------------------------------------------------

/**
 * Reproduce Python `repr()` of a string for error messages (single-quote
 * preferred; escapes embedded quotes / control chars). Matches cli_lookup._pyRepr.
 */
function _pyRepr(s: string): string {
  const hasSingle = s.includes("'");
  const hasDouble = s.includes('"');
  let quote = "'";
  if (hasSingle && !hasDouble) {
    quote = '"';
  }
  let out = "";
  for (const ch of s) {
    if (ch === "\\") out += "\\\\";
    else if (ch === quote) out += "\\" + quote;
    else if (ch === "\n") out += "\\n";
    else if (ch === "\r") out += "\\r";
    else if (ch === "\t") out += "\\t";
    else out += ch;
  }
  return `${quote}${out}${quote}`;
}

/**
 * Validate a session id or exit(1). Mirrors cli.ts `_validate_session_id` —
 * duplicated here (rather than imported) to avoid a cli_sessions → cli import
 * cycle (cli.ts lazy-imports this module instead; same pattern as cli_lookup's
 * `_require_project`). Exported so the module-namespace `self.validateSessionId`
 * calls resolve (and a test can spy the boundary).
 */
export function validateSessionId(session_id: string): void {
  try {
    session.validate_session_id(session_id);
  } catch (exc) {
    _error(`invalid session ID: ${exc instanceof Error ? exc.message : String(exc)}`);
    throw new CliExit(1);
  }
}

/**
 * Return a compact human-readable age string (e.g. '5m', '2h', '3d').
 *
 * Port of cli.py `_format_relative_time` (8045–8053). Python uses int()
 * truncation (toward zero); for non-negative ages Math.floor matches.
 */
export function _format_relative_time(age_secs: number): string {
  if (age_secs < 60) return `${Math.floor(age_secs)}s`;
  if (age_secs < 3600) return `${Math.floor(age_secs / 60)}m`;
  if (age_secs < 86400) return `${Math.floor(age_secs / 3600)}h`;
  return `${Math.floor(age_secs / 86400)}d`;
}

/**
 * Scan the sessions directory and return summary dicts sorted by
 * last_activity_ts desc. Port of cli.py `_load_session_summaries` (8056–8111).
 *
 * Each row mirrors the Python dict shape (camelCase keys are NOT used — the
 * keys are emitted verbatim into the `sessions --json` payload, so they must
 * match Python's snake_case exactly).
 *
 * `project_filter` resolves both sides via fs.realpathSync (Python
 * `Path.resolve()`); a session whose cwd does not resolve identically is
 * skipped. realpath failures (ENOENT) fall back to the literal path string so
 * a filter against a non-existent project root still matches a session whose
 * cwd is also non-existent-but-equal.
 */
export function _load_session_summaries(
  limit: number,
  project_filter: string | null,
): Array<Record<string, unknown>> {
  const sessions_dir = paths.sessionsDir();
  if (!fs.existsSync(sessions_dir)) return [];

  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(sessions_dir, { withFileTypes: true });
  } catch {
    return [];
  }

  const rows: Array<Record<string, unknown>> = [];
  for (const entry of entries) {
    if (!entry.isFile() || entry.name.endsWith(".json") === false) continue;
    let raw: Record<string, unknown>;
    try {
      const text = fs.readFileSync(path.join(sessions_dir, entry.name), "utf8");
      const parsed = JSON.parse(text);
      raw = parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
        ? (parsed as Record<string, unknown>)
        : {};
    } catch {
      continue;
    }
    const fpath = path.join(sessions_dir, entry.name);
    let stat_mtime: number;
    try {
      stat_mtime = fs.statSync(fpath).mtimeMs / 1000;
    } catch {
      continue;
    }
    const sid = String(raw["session_id"] ?? entry.name.replace(/\.json$/, ""));
    const cwd = raw["cwd"] ?? "";
    const last_ts = Number(raw["last_activity_ts"] ?? stat_mtime);
    const started_ts = Number(raw["started_ts"] ?? last_ts);
    const files_val = raw["files"];
    const file_count =
      files_val !== null && typeof files_val === "object" && !Array.isArray(files_val)
        ? Object.keys(files_val as Record<string, unknown>).length
        : 0;
    const edited_val = raw["edited_files"];
    let edit_count = 0;
    if (edited_val !== null && typeof edited_val === "object" && !Array.isArray(edited_val)) {
      for (const v of Object.values(edited_val as Record<string, unknown>)) {
        edit_count += Number(v ?? 0) || 0;
      }
    }
    const hints_emitted = Number(raw["hints_emitted"] ?? 0) || 0;
    const bash_val = raw["bash_history"];
    const bash_count =
      bash_val !== null && typeof bash_val === "object" && !Array.isArray(bash_val)
        ? Object.keys(bash_val as Record<string, unknown>).length
        : 0;
    const web_val = raw["web_history"];
    const web_count =
      web_val !== null && typeof web_val === "object" && !Array.isArray(web_val)
        ? Object.keys(web_val as Record<string, unknown>).length
        : 0;

    let project_basename = "";
    if (cwd) {
      project_basename = path.basename(String(cwd));
    }

    if (project_filter) {
      const norm_filter = _realpathOrSelf(project_filter);
      const cwd_path = cwd ? _realpathOrSelf(String(cwd)) : null;
      if (cwd_path !== norm_filter) continue;
    }

    rows.push({
      session_id: sid,
      project: project_basename,
      cwd,
      last_activity_ts: last_ts,
      started_ts,
      file_count,
      edit_count,
      hints_emitted,
      bash_count,
      web_count,
    });
  }

  rows.sort(
    (a, b) => Number(b["last_activity_ts"]) - Number(a["last_activity_ts"]),
  );
  if (limit > 0) return rows.slice(0, limit);
  return rows;
}

/** fs.realpathSync with a string fallback (Python Path.resolve() never throws). */
function _realpathOrSelf(p: string): string {
  try {
    return fs.realpathSync(p);
  } catch {
    return p;
  }
}

// ===========================================================================
// cache-audit (cli.py:2624–2670)
// ===========================================================================

/**
 * Audit Claude Code config for patterns that bust the prompt cache.
 *
 * Reads settings.json (hook coverage) + CLAUDE.md (size + dynamic patterns).
 * Lazy-imports install.ts (mirrors Python's `from . import install`).
 */
export async function cache_audit(): Promise<void> {
  const { claude_settings_path, claude_md_path } = await import("./install.js");
  const issues: string[] = [];

  // settings.json hook coverage.
  const settings_path = claude_settings_path();
  if (fs.existsSync(settings_path)) {
    try {
      const cfg_text = fs.readFileSync(settings_path, "utf8");
      const cfg = JSON.parse(cfg_text) as Record<string, unknown>;
      const hooks = (cfg["hooks"] ?? {}) as Record<string, unknown>;
      const pre_hooks = Array.isArray(hooks["PreToolUse"]) ? hooks["PreToolUse"] : [];
      const post_hooks = Array.isArray(hooks["PostToolUse"]) ? hooks["PostToolUse"] : [];
      for (const h of pre_hooks as Array<Record<string, unknown>>) {
        const matchers = String(h["matcher"] ?? "");
        if (matchers.includes("Read") || matchers.includes("Bash") || matchers.includes("Grep")) {
          issues.push(
            `PreToolUse hook matches high-frequency tools (${_pyRepr(matchers)}): every call recomputes cache`,
          );
        }
      }
      for (const h of post_hooks as Array<Record<string, unknown>>) {
        const matchers = String(h["matcher"] ?? "");
        if (matchers.includes("Bash") || matchers.includes("WebFetch")) {
          issues.push(
            `PostToolUse hook on ${_pyRepr(matchers)}: may add dynamic content that busts cache`,
          );
        }
      }
    } catch {
      issues.push(`Could not parse ${settings_path}`);
    }
  } else {
    issues.push(`settings.json not found at ${settings_path}`);
  }

  // CLAUDE.md dynamic-content patterns.
  const claude_md = claude_md_path();
  if (claude_md && fs.existsSync(claude_md)) {
    const content = fs.readFileSync(claude_md, "utf8");
    const size_kb = Buffer.byteLength(content, "utf8") / 1024;
    if (size_kb > 50) {
      // Python f"{size_kb:.1f}KB" — one decimal place.
      issues.push(
        `CLAUDE.md is ${size_kb.toFixed(1)}KB — large system prompts bust cache on every token-count change`,
      );
    }
    const lower = content.toLowerCase();
    for (const pat of ["{{date}}", "{{time}}", "Date:", "Time:", "today is"]) {
      if (lower.includes(pat.toLowerCase())) {
        issues.push(
          `CLAUDE.md contains dynamic pattern ${_pyRepr(pat)} — changes every session, busting cache`,
        );
      }
    }
  }

  if (issues.length > 0) {
    const { render_list } = await import("./render/common.js");
    _echo("Cache-busting issues found:");
    _echo(render_list(issues, "", "-"));
  } else {
    _echo("No obvious cache-busting patterns detected.");
  }
}

// ===========================================================================
// session-touched (cli.py:2671–2703)
// ===========================================================================

/** List files already read in the given Claude session. */
export function session_touched(
  opts: { session_id: string; json_output?: boolean },
): void {
  self.validateSessionId(opts.session_id);

  const entries = session.list_touched(opts.session_id);
  if (opts.json_output) {
    const out = entries.map((e) => ({
      path: e.rel_or_abs,
      read_count: e.read_count,
      line_ranges: e.line_ranges,
      symbols_read: e.symbols_read,
      last_read_ts: e.last_read_ts,
    }));
    // Python: json.dumps(out, separators=(",", ":")) → compact, no ASCII escape.
    _echo(JSON.stringify(out));
    return;
  }
  if (entries.length === 0) {
    _echo("(no files touched in this session)");
    return;
  }
  for (const e of entries) {
    const ranges =
      e.line_ranges.map(([s, en]) => `${s}-${en}`).join(", ") || "(symbols only)";
    const symbols = e.symbols_read.length > 0 ? ` symbols=${e.symbols_read.join(",")}` : "";
    _echo(`${e.rel_or_abs}  reads=${e.read_count}  lines=${ranges}${symbols}`);
  }
}

// ===========================================================================
// session-summary (cli.py:2704–2853)
// ===========================================================================

/**
 * Compact one-liner about current session state for orchestrators.
 *
 * Session-id resolution order (matches cli.py exactly):
 *   1. explicit --session-id
 *   2. CLAUDE_SESSION_ID env var
 *   3. most-recently-modified *.json file in sessions/
 *
 * Token-savings estimate: tries stats.summarize(30).total_tokens_saved, falls
 * back to (files_read*1000)+(files_edited*200) on any error.
 */
export async function session_summary(
  opts: { session_id?: string | null; json_output?: boolean } = {},
): Promise<void> {
  const json_output = opts.json_output ?? false;
  let session_id = opts.session_id ?? null;

  // Detect session ID.
  if (session_id === null) {
    // Try env var first.
    const env_sid = process.env["CLAUDE_SESSION_ID"];
    if (env_sid) {
      session_id = env_sid;
    } else {
      const sessions_dir = paths.sessionsDir();
      if (!fs.existsSync(sessions_dir)) {
        _emit_no_active_session(json_output, null);
        return;
      }
      let session_files: fs.Dirent[];
      try {
        session_files = fs
          .readdirSync(sessions_dir, { withFileTypes: true })
          .filter((d) => d.isFile() && d.name.endsWith(".json"));
      } catch {
        _emit_no_active_session(json_output, null);
        return;
      }
      if (session_files.length === 0) {
        _emit_no_active_session(json_output, null);
        return;
      }
      // Most recently modified.
      let best: { mtime: number; stem: string } | null = null;
      for (const d of session_files) {
        try {
          const st = fs.statSync(path.join(sessions_dir, d.name));
          if (best === null || st.mtimeMs / 1000 > best.mtime) {
            best = { mtime: st.mtimeMs / 1000, stem: d.name.replace(/\.json$/, "") };
          }
        } catch {
          continue;
        }
      }
      if (best === null) {
        _emit_no_active_session(json_output, null);
        return;
      }
      session_id = best.stem;
    }
  }

  self.validateSessionId(session_id);

  // Check the session file exists before trying to load.
  const sess_path = paths.sessionCachePath(session_id);
  if (!fs.existsSync(sess_path)) {
    _emit_no_active_session(json_output, session_id, "Session not found");
    return;
  }

  // Load session cache.
  let sess: session.SessionCache;
  try {
    sess = session.load(session_id);
  } catch {
    _emit_no_active_session(json_output, session_id, "Session not found or corrupted");
    return;
  }

  const files_read = Object.keys(sess.files).length;
  const files_edited = Object.keys(sess.edited_files).length;

  // Commits since session start.
  let commits_count = 0;
  try {
    const started_iso = _utc_iso_from_epoch(sess.started_ts);
    const result = runGit(
      ["log", "--oneline", `--since=${started_iso}`],
      { cwd: sess.cwd || undefined, timeout: 5 },
    );
    if (result.returncode === 0) {
      commits_count = result.stdout
        .split("\n")
        .filter((line) => line.trim().length > 0).length;
    }
  } catch (exc) {
    _LOG.debug("session brief: git log failed (commits_count=0): %s", exc);
  }

  // Token-savings estimate.
  let tokens_saved_estimate = 0;
  try {
    const summary = stats.summarize(30);
    tokens_saved_estimate = Math.max(0, summary.total_tokens_saved);
  } catch {
    tokens_saved_estimate = files_read * 1000 + files_edited * 200;
  }

  const short_id = session_id.length > 12 ? session_id.slice(0, 12) : session_id;
  if (json_output) {
    _echo(
      JSON.stringify({
        session_id,
        files_read,
        files_edited,
        commits_this_session: commits_count,
        tokens_saved_estimate,
      }),
    );
  } else {
    // Python: f"... ~{tokens_saved_estimate // 1000}k tokens saved" — floor div.
    _echo(
      `Session ${short_id}: ${files_read} files read, ` +
        `${files_edited} edited, ${commits_count} commits, ~${Math.floor(tokens_saved_estimate / 1000)}k tokens saved`,
    );
  }
}

/**
 * Emit the "No active session" result (text or JSON) and return.
 *
 * Python's `_emit_json` throws typer.Exit(0) after echoing; here we just echo
 * + return because the caller (`session_summary`) returns immediately after.
 * The `message` field is included only when non-null (the "No active session"
 * path omits it, matching cli.py).
 */
function _emit_no_active_session(
  json_output: boolean,
  session_id: string | null,
  message?: string,
): void {
  if (json_output) {
    const payload: Record<string, unknown> = {
      session_id,
      files_read: 0,
      files_edited: 0,
      commits_this_session: 0,
      tokens_saved_estimate: 0,
    };
    if (message !== undefined) payload["message"] = message;
    _echo(JSON.stringify(payload));
  } else {
    _echo("No active session");
  }
}

/** Format an epoch-second timestamp as `YYYY-MM-DDTHH:MM:SSZ` (Python time.strftime(gmtime)). */
function _utc_iso_from_epoch(epoch: number): string {
  const d = new Date(epoch * 1000);
  const yyyy = d.getUTCFullYear();
  const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(d.getUTCDate()).padStart(2, "0");
  const hh = String(d.getUTCHours()).padStart(2, "0");
  const mi = String(d.getUTCMinutes()).padStart(2, "0");
  const ss = String(d.getUTCSeconds()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}T${hh}:${mi}:${ss}Z`;
}

// ===========================================================================
// session-mark (cli.py:2854–2869) — HIDDEN
// ===========================================================================

/**
 * Manually mark a file/range as read for the given session. (Mostly used by hooks.)
 *
 * `offset`/`limit` default to 0; Python passes `offset or None` / `limit or None`
 * so 0 becomes null (unlimited). session.mark_file_read interprets null offset
 * as "no offset" and null/0 limit as "unlimited".
 */
export function session_mark(
  opts: { file_path: string; session_id: string; offset?: number; limit?: number },
): void {
  const offset = opts.offset ?? 0;
  const limit = opts.limit ?? 0;
  self.validateSessionId(opts.session_id);
  session.mark_file_read(opts.session_id, opts.file_path, offset || null, limit || null);
  _echo("ok");
}

// ===========================================================================
// decision (cli.py:5716–5852)
// ===========================================================================

/**
 * Resolve full / short / empty session id against the on-disk cache.
 *
 * Port of the `_resolve_session_id` closure inline in cli.py:5785–5807
 * (duplicated in `pinned`). Shared here so both `decision` and `pinned`
 * resolve identically and a test can spy the single boundary.
 *
 *   - len >= 32 → returned as-is (full id).
 *   - non-empty short prefix → first sessions/<prefix>*.json stem.
 *   - empty → most-recently-modified sessions/*.json stem.
 *   - no match → null.
 */
export function _resolve_session_id(raw: string): string | null {
  const sessions_dir = paths.sessionsDir();
  if (raw && raw.length >= 32) return raw;
  if (raw) {
    if (fs.existsSync(sessions_dir)) {
      let entries: string[];
      try {
        entries = fs.readdirSync(sessions_dir);
      } catch {
        return null;
      }
      for (const name of entries) {
        if (name.endsWith(".json") && name.startsWith(raw)) {
          return name.replace(/\.json$/, "");
        }
      }
    }
    return null;
  }
  // No session id given → pick most recently modified cache file.
  if (!fs.existsSync(sessions_dir)) return null;
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(sessions_dir, { withFileTypes: true });
  } catch {
    return null;
  }
  const candidates: Array<{ mtime: number; stem: string }> = [];
  for (const d of entries) {
    if (!d.isFile() || !d.name.endsWith(".json")) continue;
    try {
      const st = fs.statSync(path.join(sessions_dir, d.name));
      candidates.push({ mtime: st.mtimeMs / 1000, stem: d.name.replace(/\.json$/, "") });
    } catch {
      continue;
    }
  }
  if (candidates.length === 0) return null;
  candidates.sort((a, b) => b.mtime - a.mtime);
  return candidates[0]!.stem;
}

/** Record or list opt-in decisions for the current session. */
export function decision(
  opts: {
    text: string;
    session_id?: string;
    tag?: string;
    list_log?: boolean;
    limit?: number;
  },
): void {
  const text = opts.text;
  const session_id = opts.session_id ?? "";
  const tag = opts.tag ?? "";
  const list_log = opts.list_log ?? false;
  const limit = opts.limit ?? 10;

  const sessions_dir = paths.sessionsDir();
  const resolved = self._resolve_session_id(session_id.trim());
  if (resolved === null) {
    if (session_id) {
      _error(`no session cache found for: ${_pyRepr(session_id)}`);
    } else {
      _error(
        `no session cache files present in ${sessions_dir} — start a Claude/Codex session first or pass --session-id`,
      );
    }
    throw new CliExit(1);
  }

  if (list_log) {
    const cache = session.safe_load(resolved);
    if (cache === null || cache.decisions.length === 0) {
      _echo(`(no decisions recorded for session ${resolved.slice(0, 8)})`);
      throw new CliExit(0);
    }
    // Newest-last, capped at `limit`.
    const shown = cache.decisions.slice(-limit);
    for (const entry of shown) {
      const tag_str = entry.tag ? `[${entry.tag}] ` : "";
      _echo(`${tag_str}${entry.text}`);
    }
    throw new CliExit(0);
  }

  if (!text || text.trim().length === 0) {
    _error(
      "decision text is empty — pass a non-empty string, or use --list to view the log",
    );
    throw new CliExit(1);
  }

  session.mark_decision(resolved, text, { tag });
  // Record stats so adoption is visible in `token-goat stats`. tokens_saved is
  // 0 (adoption signal, like resume_packet); bytes is the entry text length.
  db.recordStat(undefined, "decision_log", {
    bytesSaved: Buffer.byteLength(text, "utf8"),
    tokensSaved: 0,
    detail: resolved.slice(0, 32),
  });
  _echo(`recorded decision for session ${resolved.slice(0, 8)}`);
}

// ===========================================================================
// pinned (cli.py:5853–5976)
// ===========================================================================

/** Manage pinned symbols for the current session. */
export function pinned(
  opts: { action: string; spec?: string; session_id?: string },
): void {
  const action = (opts.action ?? "").toLowerCase().trim();
  const spec_raw = opts.spec ?? "";
  const session_id = opts.session_id ?? "";

  const sessions_dir = paths.sessionsDir();
  if (action !== "add" && action !== "remove" && action !== "list") {
    _error(`unknown action ${_pyRepr(action)}; expected 'add', 'remove', or 'list'`);
    throw new CliExit(1);
  }

  const resolved = self._resolve_session_id(session_id.trim());
  if (resolved === null) {
    if (session_id) {
      _error(`no session cache found for: ${_pyRepr(session_id)}`);
    } else {
      _error(
        `no session cache files present in ${sessions_dir} — start a Claude/Codex session first or pass --session-id`,
      );
    }
    throw new CliExit(1);
  }

  if (action === "list") {
    const cache = session.safe_load(resolved);
    if (cache === null || cache.pinned_symbols.length === 0) {
      _echo(`(no pinned symbols for session ${resolved.slice(0, 8)})`);
      throw new CliExit(0);
    }
    for (const entry of cache.pinned_symbols) {
      _echo(entry);
    }
    throw new CliExit(0);
  }

  // add or remove — spec required.
  const spec = spec_raw.trim();
  if (spec.length === 0) {
    _error(`spec is required for '${action}'; pass '<file>::<symbol>'`);
    throw new CliExit(1);
  }
  if (!spec.includes("::")) {
    _error(`invalid spec ${_pyRepr(spec)}; expected '<file>::<symbol>' (must contain '::')`);
    throw new CliExit(1);
  }

  const cache = session.safe_load(resolved);
  if (cache === null) {
    _error(`could not load session cache for ${resolved.slice(0, 8)}`);
    throw new CliExit(1);
  }

  if (action === "add") {
    try {
      cache.add_pinned(spec);
    } catch (exc) {
      _error(exc instanceof Error ? exc.message : String(exc));
      throw new CliExit(1);
    }
    session.save(cache);
    _echo(`pinned: ${spec} (session ${resolved.slice(0, 8)})`);
  } else {
    // remove
    const removed = cache.remove_pinned(spec);
    if (removed) {
      session.save(cache);
      _echo(`unpinned: ${spec} (session ${resolved.slice(0, 8)})`);
    } else {
      _echo(`(not pinned: ${spec})`);
    }
    throw new CliExit(0);
  }
}

// ===========================================================================
// resume (cli.py:5977–6045)
// ===========================================================================

/** Emit a single-command post-compact restoration packet. */
export function resume_cmd(session_id: string): void {
  // Resolve partial (short) session IDs by scanning the sessions directory.
  let resolved_id: string | null = null;
  if (session_id.length >= 32) {
    resolved_id = session_id;
  } else {
    const sessions_dir = paths.sessionsDir();
    try {
      let entries: string[];
      entries = fs.existsSync(sessions_dir) ? fs.readdirSync(sessions_dir) : [];
      for (const name of entries) {
        if (name.endsWith(".json") && name.startsWith(session_id)) {
          resolved_id = name.replace(/\.json$/, "");
          break;
        }
      }
    } catch (exc) {
      _LOG.debug("resume: failed to resolve short session id %s: %s", session_id, exc);
    }
    if (resolved_id === null) {
      _error(`no session found for short id: ${_pyRepr(session_id)}`);
      throw new CliExit(1);
    }
  }

  const packet = resume.build_resume_packet(resolved_id);
  if (!packet) {
    _warn(`session ${_pyRepr(session_id)} has no recoverable state (empty or unavailable)`);
    throw new CliExit(0);
  }

  // Record a stat so `token-goat stats` can show resume usage.
  db.recordStat(undefined, "resume_packet", {
    bytesSaved: 0,
    tokensSaved: 0,
    detail: resolved_id.slice(0, 32),
  });

  _echo(packet);
}

// ===========================================================================
// recovery (cli.py:6046–6125)
// ===========================================================================

/** Inspect the post-compact recovery hint for a session. */
export function recovery(session_id: string, opts: { pending?: boolean } = {}): void {
  const pending = opts.pending ?? false;

  // Resolve short session IDs the same way `resume` does.
  let resolved_id: string | null = null;
  if (session_id.length >= 32) {
    resolved_id = session_id;
  } else {
    const sessions_dir = paths.sessionsDir();
    try {
      const entries = fs.existsSync(sessions_dir) ? fs.readdirSync(sessions_dir) : [];
      for (const name of entries) {
        if (name.endsWith(".json") && name.startsWith(session_id)) {
          resolved_id = name.replace(/\.json$/, "");
          break;
        }
      }
    } catch (exc) {
      _LOG.debug("recovery-sidecar: failed to resolve short session id %s: %s", session_id, exc);
    }
    if (resolved_id === null) {
      _error(`no session found for short id: ${_pyRepr(session_id)}`);
      throw new CliExit(1);
    }
  }

  if (pending) {
    const sidecar = paths.recoveryPendingPath(resolved_id);
    if (!fs.existsSync(sidecar)) {
      _warn(
        `no deferred recovery sidecar for ${_pyRepr(resolved_id.slice(0, 16))} ` +
          "(either the SessionStart hook has not fired with source=compact, " +
          "or the next tool call already consumed it)",
      );
      throw new CliExit(0);
    }
    try {
      _echo(fs.readFileSync(sidecar, "utf8"));
    } catch (exc) {
      _error(`failed to read sidecar: ${exc instanceof Error ? exc.message : String(exc)}`);
      throw new CliExit(1);
    }
    return;
  }

  const hint = hooks_session._build_recovery_hint(resolved_id);
  if (!hint) {
    _warn(
      `session ${_pyRepr(resolved_id.slice(0, 16))} has no recoverable state ` +
        "(empty cache or no qualifying entries)",
    );
    throw new CliExit(0);
  }
  _echo(hint);
}

// ===========================================================================
// sessions (cli.py:8114–8155)
// ===========================================================================

/** List recent sessions with per-session stats. */
export function sessions(
  opts: { limit?: number; project?: string | null; json_output?: boolean } = {},
): void {
  const limit = opts.limit ?? 20;
  const project = opts.project ?? null;
  const json_output = opts.json_output ?? false;

  const rows = self._load_session_summaries(limit, project);

  if (json_output) {
    // Python: json.dumps(rows, ensure_ascii=False, separators=(",",":")).
    _echo(JSON.stringify(rows));
    return;
  }

  if (rows.length === 0) {
    _echo("(no sessions found)");
    return;
  }

  const now = Date.now() / 1000;
  // Header columns (matches Python f-string widths exactly).
  const header =
    `${"SESSION".padStart(26)}  ` +
    `${"PROJECT".padEnd(20)}  ` +
    `${"LAST ACTIVE".padStart(11)}  ` +
    `${"FILES".padStart(5)}  ` +
    `${"EDITS".padStart(5)}  ` +
    `${"HINTS".padStart(5)}  ` +
    `${"BASH".padStart(4)}  ` +
    `${"WEB".padStart(4)}`;
  _echo(header);
  _echo("-".repeat(header.length));
  for (const r of rows) {
    const sid = String(r["session_id"]);
    const sid_short = sid.length > 24 ? sid.slice(0, 24) : sid;
    const proj = String(r["project"]).slice(0, 20);
    const age = self._format_relative_time(now - Number(r["last_activity_ts"]));
    _echo(
      `${sid_short.padStart(26)}  ` +
        `${proj.padEnd(20)}  ` +
        `${age.padStart(11)}  ` +
        `${String(Number(r["file_count"])).padStart(5)}  ` +
        `${String(Number(r["edit_count"])).padStart(5)}  ` +
        `${String(Number(r["hints_emitted"])).padStart(5)}  ` +
        `${String(Number(r["bash_count"])).padStart(4)}  ` +
        `${String(Number(r["web_count"])).padStart(4)}`,
    );
  }
}

// ===========================================================================
// sessions-show (cli.py:8156–8284)
// ===========================================================================

/** Show full details for one session: edited files, bash history, and web history. */
export function sessions_show(
  session_id: string,
  opts: { json_output?: boolean } = {},
): void {
  const json_output = opts.json_output ?? false;

  const sessions_dir = paths.sessionsDir();
  if (!fs.existsSync(sessions_dir)) {
    _error("no sessions directory found");
    throw new CliExit(1);
  }

  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(sessions_dir, { withFileTypes: true });
  } catch {
    _error("no sessions directory found");
    throw new CliExit(1);
  }
  const matches: string[] = [];
  for (const d of entries) {
    if (!d.isFile() || !d.name.endsWith(".json")) continue;
    const stem = d.name.replace(/\.json$/, "");
    if (stem === session_id || stem.startsWith(session_id)) {
      matches.push(d.name);
    }
  }

  if (matches.length === 0) {
    _error(`no session found matching ${_pyRepr(session_id)}`);
    throw new CliExit(1);
  }
  if (matches.length > 1) {
    _error(
      `ambiguous prefix ${_pyRepr(session_id)} matches ${matches.length} sessions; be more specific`,
    );
    throw new CliExit(1);
  }

  const session_file = path.join(sessions_dir, matches[0]!);
  let raw: Record<string, unknown> = {};
  try {
    const text = fs.readFileSync(session_file, "utf8");
    const parsed = JSON.parse(text);
    raw = parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    // fall through — raw stays {}
  }

  if (Object.keys(raw).length === 0) {
    _error(`could not read session file: ${session_file}`);
    throw new CliExit(1);
  }

  if (json_output) {
    // Python: json.dumps(raw, ensure_ascii=False, separators=(",",":")).
    _echo(JSON.stringify(raw));
    return;
  }

  let stat_mtime = Date.now() / 1000;
  try {
    stat_mtime = fs.statSync(session_file).mtimeMs / 1000;
  } catch {
    // best-effort
  }
  const now = Date.now() / 1000;
  const sid = String(raw["session_id"] ?? path.basename(session_file, ".json"));
  const cwd = String(raw["cwd"] || "(unknown)");
  const last_ts =
    raw["last_activity_ts"] !== undefined && raw["last_activity_ts"] !== null
      ? Number(raw["last_activity_ts"])
      : stat_mtime;
  const started_ts =
    raw["started_ts"] !== undefined && raw["started_ts"] !== null
      ? Number(raw["started_ts"])
      : last_ts;
  const age = self._format_relative_time(now - last_ts);
  const duration_secs = last_ts - started_ts;
  const duration = duration_secs > 0 ? self._format_relative_time(duration_secs) : "0s";

  _echo(`session:     ${sid}`);
  _echo(`project:     ${cwd}`);
  _echo(`last active: ${age} ago`);
  _echo(`duration:    ${duration}`);
  const hints_e = Number(raw["hints_emitted"] ?? 0) || 0;
  const hints_i = Number(raw["hints_ignored"] ?? 0) || 0;
  _echo(`hints:       ${hints_e} emitted, ${hints_i} ignored`);

  // Edited files.
  const raw_edited = raw["edited_files"];
  const edited: Record<string, number> =
    raw_edited !== null && typeof raw_edited === "object" && !Array.isArray(raw_edited)
      ? Object.fromEntries(
          Object.entries(raw_edited as Record<string, unknown>).map(([k, v]) => [
            k,
            Number(v ?? 0) || 0,
          ]),
        )
      : {};
  if (Object.keys(edited).length > 0) {
    _echo(`\nEdited files (${Object.keys(edited).length}):`);
    const sorted_edited = Object.entries(edited).sort((a, b) => b[1] - a[1]);
    for (const [p, count] of sorted_edited) {
      _echo(`  ${String(count).padStart(3)}x  ${p}`);
    }
  } else {
    _echo("\nEdited files: (none)");
  }

  // Read files.
  const raw_files = raw["files"];
  const files: Record<string, unknown> =
    raw_files !== null && typeof raw_files === "object" && !Array.isArray(raw_files)
      ? (raw_files as Record<string, unknown>)
      : {};
  if (Object.keys(files).length > 0) {
    _echo(`\nRead files (${Object.keys(files).length}):`);
    const file_list = Object.entries(files)
      .filter(([, v]) => v !== null && typeof v === "object" && !Array.isArray(v))
      .sort((a, b) => {
        const a_ts = Number((a[1] as Record<string, unknown>)["last_read_ts"] ?? 0) || 0;
        const b_ts = Number((b[1] as Record<string, unknown>)["last_read_ts"] ?? 0) || 0;
        return b_ts - a_ts;
      });
    for (const [p, entry] of file_list.slice(0, 20)) {
      const rc = Number((entry as Record<string, unknown>)["read_count"] ?? 0) || 0;
      _echo(`  ${String(rc).padStart(3)}x  ${p}`);
    }
    if (Object.keys(files).length > 20) {
      _echo(`  ... and ${Object.keys(files).length - 20} more`);
    }
  }

  // Bash history.
  const raw_bash = raw["bash_history"];
  const bash_hist: Record<string, unknown> =
    raw_bash !== null && typeof raw_bash === "object" && !Array.isArray(raw_bash)
      ? (raw_bash as Record<string, unknown>)
      : {};
  if (Object.keys(bash_hist).length > 0) {
    _echo(`\nBash history (${Object.keys(bash_hist).length}):`);
    const bash_entries = Object.entries(bash_hist)
      .filter(([, v]) => v !== null && typeof v === "object" && !Array.isArray(v))
      .sort((a, b) => {
        const a_ts = Number((a[1] as Record<string, unknown>)["ts"] ?? 0) || 0;
        const b_ts = Number((b[1] as Record<string, unknown>)["ts"] ?? 0) || 0;
        return b_ts - a_ts;
      });
    for (const [, entry] of bash_entries.slice(0, 15)) {
      const e = entry as Record<string, unknown>;
      const preview = String(e["cmd_preview"] ?? "(no preview)").slice(0, 80);
      const rc = Number(e["run_count"] ?? 1) || 1;
      _echo(`  ${"x" + String(rc).padStart(4)}  ${preview}`);
    }
    if (Object.keys(bash_hist).length > 15) {
      _echo(`  ... and ${Object.keys(bash_hist).length - 15} more`);
    }
  }

  // Web history.
  const raw_web = raw["web_history"];
  const web_hist: Record<string, unknown> =
    raw_web !== null && typeof raw_web === "object" && !Array.isArray(raw_web)
      ? (raw_web as Record<string, unknown>)
      : {};
  if (Object.keys(web_hist).length > 0) {
    _echo(`\nWeb history (${Object.keys(web_hist).length}):`);
    const web_entries = Object.entries(web_hist)
      .filter(([, v]) => v !== null && typeof v === "object" && !Array.isArray(v))
      .sort((a, b) => {
        const a_ts = Number((a[1] as Record<string, unknown>)["ts"] ?? 0) || 0;
        const b_ts = Number((b[1] as Record<string, unknown>)["ts"] ?? 0) || 0;
        return b_ts - a_ts;
      });
    for (const [, entry] of web_entries.slice(0, 15)) {
      const preview = String((entry as Record<string, unknown>)["url_preview"] ?? "(no preview)").slice(0, 80);
      _echo(`  ${preview}`);
    }
    if (Object.keys(web_hist).length > 15) {
      _echo(`  ... and ${Object.keys(web_hist).length - 15} more`);
    }
  }
}

// ===========================================================================
// batch C2 — `compact-hint` command + its `--watch` poll loop.
//
// Port of cli.py's `compact_hint` (6789–7186) and `_compact_hint_watch`
// (6698–6787). Deferred from C1 because of the ~768-LOC body and the watch
// loop. Same output seam (`_echo`/`CliExit`) and the same `self.*` module-
// namespace dispatch for the spy boundaries (`_compact_hint_watch`, `sleep`,
// `validateSessionId`) the tests patch.
// ===========================================================================

/**
 * KeyboardInterrupt analogue. Python's `_compact_hint_watch` breaks its poll
 * loop on `KeyboardInterrupt`; in TS the real `sleep()` rejects with this on
 * SIGINT, and the watch tests throw it from a faked `sleep` to stop the loop.
 * The loop catches THIS class and re-throws anything else (matching the bare
 * `except KeyboardInterrupt` in cli.py).
 */
export class KeyboardInterrupt extends Error {
  constructor() {
    super("KeyboardInterrupt");
    this.name = "KeyboardInterrupt";
  }
}

/**
 * Mockable sleep boundary — the analogue of cli.py's `time.sleep(interval)`
 * (which the watch tests patch via `mock.patch("token_goat.cli.time.sleep")`).
 * The watch loop calls it through `self.sleep(...)` so `vi.spyOn(mod, "sleep")`
 * intercepts it. The real implementation resolves after `secs` seconds, or
 * rejects with `KeyboardInterrupt` if the user hits Ctrl+C (SIGINT) mid-wait —
 * giving the interactive watch loop its clean "Stopped watching." exit.
 */
export function sleep(secs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const cleanup = (): void => {
      clearTimeout(timer);
      process.off("SIGINT", onSigint);
    };
    const onSigint = (): void => {
      cleanup();
      reject(new KeyboardInterrupt());
    };
    const timer = setTimeout(() => {
      cleanup();
      resolve();
    }, secs * 1000);
    process.once("SIGINT", onSigint);
  });
}

/**
 * Render the current local time as `HH:MM:SS` — the analogue of cli.py's
 * `datetime.now().strftime("%H:%M:%S")` used in the watch cycle header.
 */
function _hhmmss(): string {
  const d = new Date();
  const pad = (n: number): string => String(n).padStart(2, "0");
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

/**
 * Python `f"{x:g}"` (general float format): up to 6 significant digits, trailing
 * zeros and any trailing `.` stripped. Used for the `auto boost ×{multiplier:g}`
 * note (multiplier is clamped to [1.0, 10.0], so the simple path covers it).
 */
function _pyG(n: number): string {
  if (n === 0) return "0";
  let s = n.toPrecision(6);
  if (s.includes(".")) {
    s = s.replace(/\.?0+$/, "");
  }
  return s;
}

/**
 * Python `repr(float)` as `json.dumps` emits it: an integer-valued float keeps a
 * trailing `.0` (`2.0` → `"2.0"`); otherwise JS's shortest round-trip repr
 * matches CPython's for the value ranges here.
 */
function _pyFloatRepr(n: number): string {
  if (!Number.isFinite(n)) return JSON.stringify(n);
  if (Number.isInteger(n)) return `${n}.0`;
  return String(n);
}

/**
 * Compact, ASCII-escaped JSON for a single value — `json.dumps(v, separators=
 * (",", ":"))` with the DEFAULT `ensure_ascii=True` (the compact-hint `--json`
 * dump, unlike the sibling commands, does NOT pass `ensure_ascii=False`, so
 * non-ASCII in the manifest is escaped to \\uXXXX). Floats are handled separately
 * via `_pyFloatRepr` at the two float key sites.
 */
function _jVal(v: unknown): string {
  const raw = JSON.stringify(v);
  let out = "";
  for (let i = 0; i < raw.length; i++) {
    const code = raw.charCodeAt(i);
    out += code >= 0x80 ? "\\u" + code.toString(16).padStart(4, "0") : raw[i];
  }
  return out;
}

/**
 * Poll manifest generation in a loop, printing a compact diff each cycle.
 *
 * Port of cli.py `_compact_hint_watch` (6698–6787). Separated from the main
 * command so it can be unit-tested with a mocked `sleep` and `build_manifest`.
 * `compact.build_manifest` is called through the module namespace so a test's
 * `vi.spyOn(compact, "build_manifest")` is honoured (ESM live-binding gotcha).
 */
export async function _compact_hint_watch(args: {
  session_id: string;
  auto: boolean;
  max_tokens: number;
  trigger: string;
  interval?: number;
}): Promise<void> {
  const { session_id, auto, max_tokens, trigger } = args;
  const interval = args.interval ?? 60;

  const _resolve_session = (): string => {
    const sid = session_id.trim();
    if (auto || sid.toLowerCase() === "auto" || !sid) {
      const detected = compact.find_latest_session_id();
      if (!detected) {
        _echo(
          "No session files found under token-goat data directory.  " +
            "Start a Claude Code session first, or pass --session-id explicitly.",
          { err: true },
        );
        throw new CliExit(1);
      }
      if (!sid || sid.toLowerCase() === "auto") {
        _echo(`(auto-detected session: ${detected})`);
      }
      return detected;
    }
    return sid;
  };

  const _build = (sid: string): string => {
    // config.load() always populates compact_assist (the type marks it optional,
    // but _buildConfig sets it unconditionally); Python accesses it directly. The
    // `?? 400` mirrors the config default so the optional-typed field is concrete.
    const cfg = config.load().compact_assist!;
    const base_tokens =
      max_tokens > 0 ? Math.trunc(max_tokens) : Math.trunc(cfg.max_manifest_tokens ?? 400);
    const multiplier = compact.get_auto_trigger_multiplier(cfg.auto_trigger_multiplier);
    const effective_tokens =
      trigger === "auto" && multiplier > 1.0
        ? Math.trunc(base_tokens * multiplier)
        : base_tokens;
    return compact.build_manifest(sid, { max_tokens: effective_tokens }) || "";
  };

  const _show_diff = (previous: string, current: string): void => {
    const prev_lines = _splitlinesKeepends(previous);
    const curr_lines = _splitlinesKeepends(current);
    const diff = _unifiedDiff(prev_lines, curr_lines, { lineterm: "", n: 1 });
    // Strip the @@ and --- / +++ header lines; emit compact +/- lines only.
    const changed = diff.filter(
      (ln) =>
        (ln.startsWith("+") || ln.startsWith("-") || ln.startsWith(" ")) &&
        !ln.startsWith("---") &&
        !ln.startsWith("+++"),
    );
    if (changed.length === 0) {
      _echo("  (no changes)");
      return;
    }
    for (const ln of changed) _echo(ln);
  };

  const resolved_sid = _resolve_session();
  let previous_manifest: string | null = null;

  _echo(`--- compact-hint watch [started, interval=${interval}s] ---`);
  _echo("Press Ctrl+C to stop.");
  _echo("");

  try {
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const ts = _hhmmss();
      _echo(`--- compact-hint watch [${ts}] ---`);
      const current_manifest = _build(resolved_sid);
      if (previous_manifest === null) {
        // First cycle: show full manifest.
        if (current_manifest) {
          _echo(current_manifest);
        } else {
          _echo("  (no manifest generated)");
        }
      } else {
        _show_diff(previous_manifest, current_manifest);
      }
      previous_manifest = current_manifest;
      _echo("");
      await self.sleep(interval);
    }
  } catch (e) {
    if (e instanceof KeyboardInterrupt) {
      _echo("");
      _echo("Stopped watching.");
    } else {
      throw e;
    }
  }
}

/**
 * Show the compaction manifest token-goat would inject for a session.
 *
 * Faithful port of cli.py `compact_hint` (6789–7186): applies the same gate
 * chain the live PreCompact hook applies and previews what would be emitted.
 * `--watch` dispatches to `_compact_hint_watch` (via `self.` so the test spy on
 * the boundary fires) before any expensive setup.
 */
export async function compact_hint(args: {
  session_id: string;
  auto: boolean;
  json_output: boolean;
  max_tokens: number;
  trigger: string;
  explain_skip: boolean;
  show_diff: boolean;
  show_sections: boolean;
  show_score: boolean;
  watch: boolean;
  watch_interval: number;
}): Promise<void> {
  const {
    session_id,
    auto,
    json_output,
    max_tokens,
    trigger,
    explain_skip,
    show_diff,
    show_sections,
    show_score,
    watch,
    watch_interval,
  } = args;

  // --- --watch: continuous poll loop ---------------------------------------
  // Dispatched early (before expensive setup) so --watch can control the loop.
  if (watch) {
    await self._compact_hint_watch({
      session_id,
      auto,
      max_tokens,
      trigger,
      interval: watch_interval,
    });
    return;
  }

  // --- Resolve session ID --------------------------------------------------
  let resolved_session_id = session_id.trim();
  if (auto || resolved_session_id.toLowerCase() === "auto" || !resolved_session_id) {
    const detected = compact.find_latest_session_id();
    if (!detected) {
      _echo(
        "No session files found under token-goat data directory.  " +
          "Start a Claude Code session first, or pass --session-id explicitly.",
        { err: true },
      );
      throw new CliExit(1);
    }
    if (!resolved_session_id || resolved_session_id.toLowerCase() === "auto") {
      _echo(`(auto-detected session: ${detected})`);
    }
    resolved_session_id = detected;
  }

  self.validateSessionId(resolved_session_id);

  // config.load() always populates compact_assist (the type marks it optional,
  // but _buildConfig sets it unconditionally); Python accesses it directly. The
  // per-field coalescing mirrors the config defaults (_buildConfig) so the
  // optional-typed fields resolve to concrete values for tsc.
  const cfg = config.load().compact_assist!;
  const enabled = cfg.enabled ?? true;
  const triggers = cfg.triggers ?? ["manual", "auto"];
  const min_events = cfg.min_events ?? 3;
  const max_manifest_tokens = cfg.max_manifest_tokens ?? 400;

  // --- Resolve the effective budget the live hook would use ----------------
  const base_tokens =
    max_tokens > 0 ? Math.trunc(max_tokens) : Math.trunc(max_manifest_tokens);
  const multiplier = compact.get_auto_trigger_multiplier(cfg.auto_trigger_multiplier);
  const effective_tokens =
    trigger === "auto" && multiplier > 1.0
      ? Math.trunc(base_tokens * multiplier)
      : base_tokens;

  // --- Apply hook-side gates so the preview matches reality ----------------
  const trigger_allowed = triggers.length > 0 && triggers.includes(trigger);
  // Use the detail variant so we can surface reason + age in --explain-skip.
  let sentinel_fast_path = false;
  let sentinel_reason = "";
  let sentinel_age = 0.0;
  try {
    const skip_detail = hooks_cli._check_compact_skip_sentinel_detail(resolved_session_id);
    sentinel_fast_path = skip_detail.should_skip;
    sentinel_reason = skip_detail.reason;
    sentinel_age = skip_detail.age_secs;
  } catch {
    sentinel_fast_path = false;
    sentinel_reason = "";
    sentinel_age = 0.0;
  }

  // Noop-session gate: mirror the pre_compact guard.
  let _is_noop = false;
  let _sc: session.SessionCache | null = null;
  try {
    _sc = session.safe_load(resolved_session_id, { caller: "compact-hint" });
    if (_sc !== null) {
      _is_noop = hooks_cli._is_noop_session(_sc);
    }
  } catch {
    _LOG.debug(
      "compact-hint: failed to load noop-session flag for %s",
      resolved_session_id,
    );
  }

  const n_events = compact.event_count(resolved_session_id);
  const events_sufficient = n_events >= min_events;

  // --- For --diff: capture the prior manifest text BEFORE build_manifest
  // writes a new text sidecar.
  let _prior_manifest_text: string | null = null;
  if (show_diff) {
    try {
      const text_sidecar = paths.manifestTextSidecarPath(resolved_session_id);
      if (fs.existsSync(text_sidecar)) {
        _prior_manifest_text = fs.readFileSync(text_sidecar, "utf-8");
      }
    } catch {
      _prior_manifest_text = null;
    }
  }

  // Render the manifest with the *effective* budget (matching the hook).
  const manifest = compact.build_manifest(resolved_session_id, {
    max_tokens: effective_tokens,
  });
  const is_cached_stub = manifest.startsWith(
    "## Token-Goat Manifest — unchanged since",
  );
  const quality_score = manifest ? compact._score_manifest([manifest]) : 0;
  const would_emit = Boolean(
    enabled &&
      trigger_allowed &&
      !sentinel_fast_path &&
      !_is_noop &&
      events_sufficient &&
      manifest,
  );

  if (json_output) {
    const jsonParts: string[] = [
      `"enabled":${_jVal(enabled)}`,
      `"triggers":${_jVal(triggers)}`,
      `"trigger_requested":${_jVal(trigger)}`,
      `"trigger_allowed":${_jVal(trigger_allowed)}`,
      `"min_events":${_jVal(min_events)}`,
      `"max_manifest_tokens":${_jVal(max_manifest_tokens)}`,
      `"auto_trigger_multiplier":${_pyFloatRepr(multiplier)}`,
      `"effective_max_tokens":${_jVal(effective_tokens)}`,
      `"event_count":${_jVal(n_events)}`,
      `"events_sufficient":${_jVal(events_sufficient)}`,
      `"sentinel_fast_path":${_jVal(sentinel_fast_path)}`,
      `"sentinel_reason":${_jVal(sentinel_reason)}`,
      `"sentinel_age_secs":${_pyFloatRepr(sentinel_age)}`,
      `"is_noop_session":${_jVal(_is_noop)}`,
      `"is_cached_stub":${_jVal(is_cached_stub)}`,
      `"quality_score":${_jVal(quality_score)}`,
      `"token_estimate":${_jVal(manifest ? compact.estimate_tokens(manifest) : 0)}`,
      `"char_count":${_jVal([...manifest].length)}`,
      `"would_emit":${_jVal(would_emit)}`,
      `"manifest":${_jVal(manifest)}`,
    ];
    _echo("{" + jsonParts.join(",") + "}");
    return;
  }

  // --- --sections: list section names + token counts -----------------------
  if (show_sections) {
    if (!manifest) {
      _echo("(no manifest to parse sections from)");
      return;
    }
    const sections_list = compact._parse_manifest_sections(manifest);
    const total_tokens = compact.estimate_tokens(manifest);
    _echo(`Manifest sections  (~${total_tokens} tokens total):`);
    _echo("");
    for (const [sec_name, sec_tokens, sec_empty] of sections_list) {
      const empty_tag = sec_empty ? "  [empty, would be dropped]" : "";
      const protected_tag =
        sec_name.includes("Edited") || sec_name.includes("MUST_PRESERVE")
          ? "  [protected]"
          : "";
      _echo(
        `  ${sec_name.padEnd(30)}  ${String(sec_tokens).padStart(4)} tokens${protected_tag}${empty_tag}`,
      );
    }
    return;
  }

  // --- --score: quality score breakdown ------------------------------------
  if (show_score) {
    const score_breakdown: Record<string, number> = manifest
      ? compact._score_manifest_breakdown([manifest])
      : {};
    const activity_score =
      !_is_noop && _sc !== null ? compact._session_activity_score(_sc) : 0;
    _echo(`Quality score: ${quality_score}`);
    _echo(`Noop fast-path would fire: ${_is_noop ? "True" : "False"}`);
    _echo(
      `Session activity score: ${activity_score}  (floor=${compact._ACTIVITY_FLOOR})`,
    );
    const entries = Object.entries(score_breakdown);
    if (entries.length > 0) {
      _echo("");
      _echo("Score breakdown by section:");
      // Python: sorted(items, key=lambda x: -x[1]) — stable descending by value.
      const sorted = entries.slice().sort((a, b) => b[1] - a[1]);
      for (const [sec, pts] of sorted) {
        _echo(`  ${sec.padEnd(30)}  +${pts}`);
      }
    } else {
      _echo("(no scored content in manifest)");
    }
    return;
  }

  // --- --diff: unified diff against last emitted manifest ------------------
  if (show_diff) {
    if (_prior_manifest_text === null) {
      _echo("No previous manifest to compare against.");
      _echo(
        "(The text sidecar is written the first time compact-hint or the " +
          "PreCompact hook renders a manifest for this session.)",
      );
      return;
    }

    const current_text = manifest || "";
    const prior_lines = _splitlinesKeepends(_prior_manifest_text);
    const current_lines = _splitlinesKeepends(current_text);
    const diff_lines = _unifiedDiff(prior_lines, current_lines, {
      fromfile: "previous manifest",
      tofile: "current manifest",
      lineterm: "",
    });
    if (diff_lines.length === 0) {
      _echo("Manifest unchanged from last emit (no diff).");
    } else {
      for (const dl of diff_lines) _echo(dl);
    }
    return;
  }

  // --- Human-readable preview with explicit gate chain ---------------------
  _echo(`compact-assist enabled: ${enabled ? "True" : "False"}`);
  _echo(`triggers: ${triggers.join(", ")}`);
  let boost_note = "";
  if (trigger === "auto" && multiplier > 1.0) {
    boost_note = `  (auto boost ×${_pyG(multiplier)}: ${base_tokens} → ${effective_tokens})`;
  }
  _echo(
    `trigger: ${trigger} ` +
      `(${trigger_allowed ? "allowed" : "BLOCKED — not in cfg.triggers"})`,
  );
  _echo(`budget: ${effective_tokens} tokens${boost_note}`);
  _echo(`min_events: ${min_events}  |  session events: ${n_events}`);
  const sentinel_state = sentinel_fast_path
    ? "FRESH — hook would short-circuit before reaching this manifest"
    : "absent or stale (hook would run normally)";
  _echo(`compact-skip sentinel: ${sentinel_state}`);

  if (explain_skip || sentinel_fast_path || _is_noop) {
    _echo("");
    _echo("--- skip gate breakdown ---");
    _echo(`  sentinel_fast_path : ${sentinel_fast_path ? "True" : "False"}`);
    if (sentinel_fast_path || sentinel_age > 0.0) {
      const reason_str = sentinel_reason ? sentinel_reason : "(none)";
      _echo(`  sentinel reason    : ${reason_str}`);
      _echo(`  sentinel age       : ${roundHalfEven(sentinel_age, 0)}s`);
      // Surface activity-floor counts when available.
      try {
        const _sent_path = paths.compactSkipSentinelPath(resolved_session_id);
        const [_s_edited, _s_bash] = hooks_cli._read_sentinel_counts(_sent_path);
        const [_c_edited, _c_bash] = hooks_cli._current_session_counts(resolved_session_id);
        if (_s_edited !== null) {
          _echo(`  sentinel counts    : edited=${_s_edited}, bash=${_s_bash}`);
          _echo(`  current counts     : edited=${_c_edited}, bash=${_c_bash}`);
        }
      } catch {
        _LOG.debug(
          "compact-hint: failed to read sentinel/current counts for debug output",
        );
      }
    }
    _echo(`  noop_session       : ${_is_noop ? "True" : "False"}`);
    _echo("");
  }

  // Gate chain — fail-fast in the order the live hook applies them.
  if (!enabled) {
    _echo("(disabled — set TOKEN_GOAT_COMPACT_ASSIST=1 or edit config.toml to enable)");
    return;
  }
  if (!trigger_allowed) {
    const triggers_repr = `[${triggers.map((t) => `'${t}'`).join(", ")}]`;
    _echo(
      `(no manifest: trigger '${trigger}' not in configured triggers ${triggers_repr})`,
    );
    return;
  }
  if (sentinel_fast_path) {
    _echo(
      "(no manifest: compact-skip sentinel is fresh — the hook would return " +
        "{continue:true} without building a manifest)",
    );
    return;
  }
  if (!events_sufficient) {
    _echo(`(no manifest: ${n_events} events < min_events ${min_events})`);
    return;
  }
  if (!manifest) {
    _echo("(no manifest: session cache empty or all-noise)");
    return;
  }

  _echo("--- manifest that would be injected as systemMessage ---");
  _echo(manifest);
  _echo("---");
  const est_tokens = compact.estimate_tokens(manifest);
  const stub_note = is_cached_stub ? "  [cached stub: sidecar fingerprint matched]" : "";
  _echo(`(${[...manifest].length} chars, ~${est_tokens} tokens)${stub_note}`);
}
