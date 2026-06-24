/**
 * Stats / cost / diff CLI helpers — faithful 1:1 port of:
 *   - src/token_goat/cli_stats.py (the `stats` rendering lib: `stats`,
 *     `_write_raw`, `_render_top_session_files`), and
 *   - the cli.py command bodies for `stats` (the `--session-id`/`--global`
 *     focused-view branch), `cost`, and `diff` (`cmd_diff` +
 *     `_extract_diff_symbols` + `_show_symbols_for_paths`).
 *
 * The three command bodies live alongside the rendering lib so cli.ts can wire
 * them in a single import. Bodies call `self.stats(...)` /
 * `self._render_top_session_files(...)` / `self._extract_diff_symbols(...)` via
 * `import * as self` so tests can `vi.spyOn` them.
 */
import * as fs from "node:fs";
import * as nodePath from "node:path";

import * as self from "./cli_stats.js";
import * as stats_mod from "./stats.js";
import * as db from "./db.js";
import * as session from "./session.js";
import * as paths from "./paths.js";
import * as util from "./util.js";
import { colorStdout } from "./render/ansi.js";
import { roundHalfEven } from "./skill_cache.js";
import { _echo, _error, _emit_json, CliExit } from "./cli_common.js";
import { __version__ } from "./version.js";

// ---------------------------------------------------------------------------
// Small text helpers (Python builtins with no direct TS equivalent).
// ---------------------------------------------------------------------------

/**
 * str.splitlines() (no keepends): split on \r\n / \r / \n and drop a single
 * trailing "" if present. Python's str.splitlines() does NOT emit a trailing
 * empty element for a string ending in a newline.
 */
function _splitlines(s: string): string[] {
  const parts = s.split(/\r\n|\r|\n/);
  if (parts.length > 0 && parts[parts.length - 1] === "") {
    parts.pop();
  }
  return parts;
}

/** f"{n:,}" thousands separator for an integer. */
function _comma(n: number): string {
  return n.toLocaleString("en-US");
}

// ---------------------------------------------------------------------------
// cli_stats.py: _write_raw
// ---------------------------------------------------------------------------

/**
 * Write text with truecolor ANSI codes directly. The Python original
 * progressively unwraps colorama/Typer StreamWrapper objects to reach the raw
 * stdout buffer; in Node there is no colorama wrapping, so this is much
 * simpler: strip SGR codes when colour is off, then write to process.stdout.
 * (ESC is written as the regex `\x1b` escape — never a raw ESC byte.)
 */
export function _write_raw(text: string): void {
  if (!colorStdout()) {
    // eslint-disable-next-line no-control-regex
    text = text.replace(/\x1b\[[0-9;]*m/g, "");
  }
  process.stdout.write(text + "\n");
}

// ---------------------------------------------------------------------------
// cli_stats.py: stats (the rendering lib fn)
// ---------------------------------------------------------------------------

export interface StatsOptions {
  window?: number;
  json_output?: boolean;
  by_project?: boolean;
  by_command?: boolean;
  top?: number;
}

/** Show cumulative token savings. */
export function stats(opts: StatsOptions = {}): void {
  const window = opts.window ?? 30;
  const json_output = opts.json_output ?? false;
  const by_project = opts.by_project ?? false;
  const by_command = opts.by_command ?? false;
  const top = opts.top ?? 10;

  const summary = stats_mod.summarize(window);
  if (json_output) {
    _echo(
      JSON.stringify({
        version: __version__,
        total_events: summary.total_events,
        total_bytes_saved: summary.total_bytes_saved,
        total_tokens_saved: summary.total_tokens_saved,
        by_kind: summary.by_kind,
        by_day: summary.by_day,
        by_project: summary.by_project,
        by_command: summary.by_command,
        window_days: summary.window_days,
      }),
    );
    return;
  }
  if (by_project) {
    self._write_raw(stats_mod.render_by_project(summary, top));
    return;
  }
  if (by_command) {
    self._write_raw(stats_mod.render_by_command(summary));
    return;
  }
  self._write_raw(stats_mod.render_text(summary));
  const top_files_text = self._render_top_session_files(5);
  if (top_files_text) {
    self._write_raw(top_files_text);
  }
}

// ---------------------------------------------------------------------------
// cli_stats.py: _render_top_session_files
// ---------------------------------------------------------------------------

/**
 * Return a plain-text summary of the top N most-read files in the most recent
 * session. Loads the most recently modified session JSON and sorts
 * file_access_counts by count descending. Returns an empty string when no
 * session data is available or when no file has been accessed more than once.
 *
 * Fail-soft: any I/O or parse error returns an empty string so the stats
 * command never fails due to session-file issues.
 */
export function _render_top_session_files(top_n: number = 5): string {
  try {
    const sessions_dir = paths.sessionsDir();
    let isDir = false;
    try {
      isDir = fs.statSync(sessions_dir).isDirectory();
    } catch {
      isDir = false;
    }
    if (!isDir) {
      return "";
    }

    // Find the most recently modified session file.
    const entries = fs
      .readdirSync(sessions_dir)
      .filter((name) => name.endsWith(".json"))
      .map((name) => nodePath.join(sessions_dir, name));
    const session_files = entries
      .map((p) => ({ p, mtime: fs.statSync(p).mtimeMs }))
      .sort((a, b) => b.mtime - a.mtime)
      .map((x) => x.p);
    if (session_files.length === 0) {
      return "";
    }

    // Try files in order until one parses cleanly.
    let cache: session.SessionCache | null = null;
    for (const sf of session_files.slice(0, 3)) {
      // try at most 3 to keep startup fast
      try {
        const base = nodePath.basename(sf);
        const session_id = base.slice(0, base.length - ".json".length);
        session.validate_session_id(session_id);
        cache = session.safe_load(session_id);
        if (cache !== null && !cache.unavailable) {
          break;
        }
      } catch {
        continue;
      }
    }

    if (cache === null || cache.unavailable) {
      return "";
    }

    const counts = cache.file_access_counts ?? {};
    const items = Object.entries(counts);
    if (items.length === 0) {
      return "";
    }

    // Sort descending by count; skip files accessed only once (not informative).
    let ranked = items.slice().sort((a, b) => b[1] - a[1]);
    ranked = ranked.filter(([, v]) => v > 1).slice(0, top_n);
    if (ranked.length === 0) {
      return "";
    }

    const lines = ["Top files this session:"];
    for (const [filepath, count] of ranked) {
      const basename = nodePath.basename(filepath);
      lines.push(`  ${String(count).padStart(3)}x  ${basename}  (${filepath})`);
    }
    return lines.join("\n");
  } catch {
    // fail-soft
    return "";
  }
}

// ---------------------------------------------------------------------------
// cli.py: the `stats` COMMAND body (focused compression-metrics view)
// ---------------------------------------------------------------------------

export interface CmdStatsOptions {
  window?: number;
  json_output?: boolean;
  by_project?: boolean;
  by_command?: boolean;
  top?: number;
  since?: number | null;
  session_id?: string | null;
  global_?: boolean;
}

/**
 * Show cumulative token savings.
 *
 * With --session-id or --global, prints a focused compression summary instead
 * of the full rich table. Otherwise delegates to `self.stats(...)`.
 */
export function cmd_stats(opts: CmdStatsOptions = {}): void {
  const window = opts.window ?? 30;
  const json_output = opts.json_output ?? false;
  const by_project = opts.by_project ?? false;
  const by_command = opts.by_command ?? false;
  const top = opts.top ?? 10;
  const since = opts.since ?? null;
  const session_id = opts.session_id ?? null;
  const global_ = opts.global_ ?? false;

  // --session-id / --global trigger the focused compression metrics view.
  if (session_id !== null || global_) {
    const sid = global_ ? undefined : session_id ?? undefined;
    const label = global_
      ? "all-time"
      : `session ${session_id ? session_id.slice(0, 8) : ""}`;
    const data = db.getCompressionStats(sid);
    const _hook_timing = db.getHookTimingStats(7);
    if (json_output) {
      const payload: Record<string, unknown> = { ...data, hook_timing: _hook_timing };
      _echo(JSON.stringify(payload));
    } else {
      _echo(`Token savings (${label}):`);
      _echo(`  Bash outputs compressed : ${_comma(data.outputs_compressed)}`);
      _echo(`  Estimated tokens saved  : ${_comma(data.tokens_saved)}`);
      _echo(`  Reread denies           : ${_comma(data.reread_denies)}`);
      _echo(`  Images shrunk           : ${_comma(data.images_shrunk)}`);
      const timingEntries = Object.entries(_hook_timing);
      if (timingEntries.length > 0) {
        _echo("\nHook latency (last 7d):");
        // Python: sorted(..., key=lambda x: -x[1]["avg_ms"]) -> avg_ms descending.
        const sorted = timingEntries.sort((a, b) => b[1].avg_ms - a[1].avg_ms);
        for (const [_evt, _ht] of sorted) {
          _echo(
            `  ${_evt.padEnd(30)} N=${String(_ht.count).padStart(4)}  ` +
              `avg=${String(_ht.avg_ms).padStart(5)}ms  p95=${String(_ht.p95_ms).padStart(5)}ms  max=${String(_ht.max_ms).padStart(5)}ms`,
          );
        }
      }
    }
    return;
  }

  // --since is a friendlier alias for --window; it takes precedence when both
  // are specified.
  const effective_window = since !== null ? since : window;
  self.stats({
    window: effective_window,
    json_output,
    by_project,
    by_command,
    top,
  });
}

// ---------------------------------------------------------------------------
// cli.py: the `cost` command body
// ---------------------------------------------------------------------------

export interface CostOptions {
  session?: string | null;
}

/** Show estimated tokens saved (session or all-time). */
export function cost(opts: CostOptions = {}): void {
  const sessionArg = opts.session ?? null;

  const sessions_dir = paths.sessionsDir();

  if (sessionArg !== null) {
    // Resolve session ID (full, short, or most recent)
    const _resolve_session_id = (raw: string): string | null => {
      if (raw && raw.length >= 32) {
        return raw;
      }
      if (raw) {
        // Short prefix lookup.
        let existsDir = false;
        try {
          existsDir = fs.statSync(sessions_dir).isDirectory();
        } catch {
          existsDir = false;
        }
        if (existsDir) {
          const matches = fs
            .readdirSync(sessions_dir)
            .filter((name) => name.startsWith(raw) && name.endsWith(".json"));
          for (const f of matches) {
            return f.slice(0, f.length - ".json".length);
          }
        }
        return null;
      }
      return null;
    };

    const resolved = _resolve_session_id(sessionArg.trim());
    if (resolved === null) {
      _error(`no session cache found for: ${_pyRepr(sessionArg)}`);
      throw new CliExit(1);
    }

    const cache = session.safe_load(resolved);
    if (cache === null) {
      _error(`failed to load session cache: ${_pyRepr(resolved)}`);
      throw new CliExit(1);
    }

    // Compute session savings
    let tokens_saved = 0;
    let avoided_reads = 0;
    let dedup_hits = 0;

    // Count files read and estimate token savings
    for (const file_entry of Object.values(cache.files)) {
      // Estimate tokens saved per re-read.
      if (file_entry.read_count > 1) {
        avoided_reads += file_entry.read_count - 1;
      }
    }

    // Count dedup hits from grep/bash/web
    dedup_hits += cache.greps.filter((g) => g.ts > 0).length;
    dedup_hits += Object.keys(cache.bash_history).length;
    dedup_hits += Object.keys(cache.web_history).length;

    // Very rough estimate.
    tokens_saved = avoided_reads * 500 + dedup_hits * 200;

    const session_str = `Session ${resolved.slice(0, 8)}`;
    _echo(
      `${session_str}: ~${_comma(tokens_saved)} tokens saved via ${avoided_reads} cached reads + ${dedup_hits} dedup hits`,
    );
    throw new CliExit(0);
  }

  // All-time summary (no --session flag)
  const summary = stats_mod.summarize(0);

  const total_tokens = summary.total_tokens_saved;
  const total_bytes = summary.total_bytes_saved;

  // Top 3 sources by tokens saved
  const by_source = summary.by_source;
  let top_str = "";
  const sourceEntries = Object.entries(by_source);
  if (sourceEntries.length > 0) {
    const top_sources = sourceEntries
      .slice()
      .sort((a, b) => b[1].tokens_saved - a[1].tokens_saved)
      .slice(0, 3);
    top_str =
      " (" +
      top_sources
        .map(([src, data]) => `${src}: ${_comma(data.tokens_saved)}`)
        .join(", ") +
      ")";
  }

  const mb = roundHalfEven(total_bytes / 1024 / 1024, 1).toFixed(1);
  _echo(
    `All-time: ${_comma(total_tokens)} tokens saved, ${mb} MB data avoided${top_str}`,
  );
}

// ---------------------------------------------------------------------------
// cli.py: the `diff` command body
// ---------------------------------------------------------------------------

export interface CmdDiffOptions {
  since?: string;
  session_id?: string | null;
  symbols?: boolean;
  json_output?: boolean;
}

/** Show files changed since a git ref, with optional symbol-level context. */
export function cmd_diff(opts: CmdDiffOptions = {}): void {
  const since = opts.since ?? "HEAD~1";
  const session_id = opts.session_id ?? null;
  const symbols = opts.symbols ?? false;
  const json_output = opts.json_output ?? false;

  const cwd = process.cwd();

  // ---- session mode -------------------------------------------------------
  if (session_id !== null) {
    session.validate_session_id(session_id);

    const edited = session.list_edited(session_id);
    if (Object.keys(edited).length === 0) {
      if (json_output) {
        _emit_json({ mode: "session", session_id, files: [] });
      }
      _echo("(no files edited in this session)");
      return;
    }

    // Sort by edit count descending so the most-edited files appear first.
    const sorted_edited = Object.entries(edited)
      .slice()
      .sort((a, b) => b[1] - a[1]);

    if (json_output) {
      _emit_json({
        mode: "session",
        session_id,
        files: sorted_edited.map(([p, c]) => ({ path: p, edits: c })),
      });
    }

    _echo(`Files edited in session ${session_id.slice(0, 8)}:`);
    for (const [path, count] of sorted_edited) {
      const edit_label = `${count} edit${count !== 1 ? "s" : ""}`;
      _echo(`  ${path}  (${edit_label})`);
    }

    if (symbols) {
      // For session mode + --symbols: diff HEAD~1 for the edited files.
      const edited_paths = sorted_edited.map(([p]) => p);
      self._show_symbols_for_paths(edited_paths, since, cwd, { json_output: false });
    }
    return;
  }

  // ---- git diff mode -------------------------------------------------------
  // Verify this is a git repo and the ref exists.
  const check_ref = util.runGit(["rev-parse", "--verify", since], { cwd });
  if (check_ref.returncode !== 0) {
    _error(`git ref not found: ${_pyRepr(since)}`);
    throw new CliExit(1);
  }

  // Get the summary (file names + insertions/deletions).
  const stat_result = util.runGit(["diff", "--stat", `${since}..HEAD`], { cwd });
  if (stat_result.returncode !== 0) {
    _error(`git diff failed: ${stat_result.stderr.trim()}`);
    throw new CliExit(1);
  }

  // Parse changed file paths from --stat output.
  const stat_lines = _splitlines(stat_result.stdout);
  const file_lines = stat_lines.filter((ln) => ln.includes("|"));
  const changed_files: string[] = [];
  for (const ln of file_lines) {
    let path_part = (ln.split("|")[0] ?? "").trim();
    // Handle rename notation "a => b" — keep the right-hand side.
    if (path_part.includes("=>")) {
      const segs = path_part.split("=>");
      path_part = _rstrip((segs[segs.length - 1] ?? "").trim(), "}");
    }
    changed_files.push(path_part);
  }

  let summary_line = "";
  for (let i = stat_lines.length - 1; i >= 0; i--) {
    const ln = stat_lines[i] ?? "";
    if (ln.includes("changed")) {
      summary_line = ln;
      break;
    }
  }

  if (changed_files.length === 0) {
    if (json_output) {
      _emit_json({ mode: "git", since, summary: summary_line.trim(), files: [] });
    }
    _echo(`No changes between ${_pyRepr(since)} and HEAD.`);
    return;
  }

  // Build symbol data if requested.
  let symbol_map: Record<string, string[]> = {};
  if (symbols) {
    symbol_map = self._extract_diff_symbols(since, cwd);
  }

  if (json_output) {
    const files_out: Array<Record<string, unknown>> = [];
    for (const f of changed_files) {
      const entry: Record<string, unknown> = { path: f };
      if (symbols) {
        entry.symbols = symbol_map[f] ?? [];
      }
      files_out.push(entry);
    }
    _emit_json({
      mode: "git",
      since,
      summary: summary_line.trim(),
      files: files_out,
    });
  }

  // Human-readable output.
  const use_colour = Boolean(process.stdout.isTTY);
  _echo(`Changes since ${_pyRepr(since)}:`);
  for (const ln of file_lines) {
    _echo(`  ${ln.trim()}`);
  }
  if (summary_line) {
    _echo(`  ${summary_line.trim()}`);
  }

  if (symbols && Object.keys(symbol_map).length > 0) {
    _echo("");
    _echo("Symbols changed:");
    for (const f of changed_files) {
      const syms = symbol_map[f];
      if (!syms || syms.length === 0) {
        continue;
      }
      // typer.style(f, bold=True) when use_colour, else plain.
      const label = use_colour ? `[1m${f}[0m` : f;
      _echo(`  ${label}`);
      for (const s of syms) {
        _echo(`    ${s}`);
      }
    }
  }
}

/**
 * Parse `git diff --unified=0 <since>..HEAD` hunk headers for symbol names.
 *
 * Each @@ header optionally ends with a function/class name after the fourth
 * @@. Returns a dict mapping relative file path → list of changed symbol names,
 * deduplicated and ordered by first appearance.
 */
export function _extract_diff_symbols(since: string, cwd: string): Record<string, string[]> {
  const result = util.runGit(["diff", "--unified=0", `${since}..HEAD`], { cwd, timeout: 30 });
  if (result.returncode !== 0) {
    return {};
  }

  const symbol_map: Record<string, string[]> = {};
  let current_file: string | null = null;
  const _HUNK_RE = /^@@ [^@]+ @@ ?(.+)$/;
  const _FILE_RE = /^\+\+\+ b\/(.+)$/;

  for (const line of _splitlines(result.stdout)) {
    const m_file = _FILE_RE.exec(line);
    if (m_file) {
      current_file = m_file[1] ?? null;
      continue;
    }
    if (current_file === null) {
      continue;
    }
    const m_hunk = _HUNK_RE.exec(line);
    if (m_hunk) {
      const raw = (m_hunk[1] ?? "").trim();
      if (!raw) {
        continue;
      }
      // Extract just the first identifier-like name (drop parameter list noise).
      let name_part = (raw.split("(")[0] ?? "").split("{")[0]!.trim();
      // Drop leading keywords.
      for (const kw of [
        "async def ",
        "def ",
        "func ",
        "function ",
        "class ",
        "fn ",
        "pub fn ",
        "pub async fn ",
      ]) {
        if (name_part.startsWith(kw)) {
          name_part = name_part.slice(kw.length);
          break;
        }
      }
      // Strip trailing colon and surrounding whitespace.
      name_part = _rstrip(name_part.trim(), ":");
      if (!name_part) {
        continue;
      }
      const syms = (symbol_map[current_file] ??= []);
      if (!syms.includes(name_part)) {
        syms.push(name_part);
      }
    }
  }

  return symbol_map;
}

/** Print symbol changes for the given file paths, filtering from a full diff. */
export function _show_symbols_for_paths(
  pathsArg: string[],
  since: string,
  cwd: string,
  opts: { json_output: boolean },
): void {
  // json_output is part of the signature for parity but unused (the Python
  // original calls this only with json_output=False from session mode).
  void opts;
  const symbol_map = self._extract_diff_symbols(since, cwd);
  if (Object.keys(symbol_map).length === 0) {
    return;
  }
  const pathSet = new Set(pathsArg);
  const filtered = Object.entries(symbol_map).filter(([p]) => pathSet.has(p));
  if (filtered.length === 0) {
    return;
  }
  _echo("");
  _echo("Symbols changed (vs HEAD~1):");
  for (const [f, syms] of filtered) {
    _echo(`  ${f}`);
    for (const s of syms) {
      _echo(`    ${s}`);
    }
  }
}

// ---------------------------------------------------------------------------
// Local helpers
// ---------------------------------------------------------------------------

/** Python str.rstrip(chars) for a set of trailing characters. */
function _rstrip(s: string, chars: string): string {
  let end = s.length;
  while (end > 0 && chars.includes(s[end - 1]!)) {
    end--;
  }
  return s.slice(0, end);
}

/**
 * Python repr() for a string (single-quoted), used by f"{x!r}" sites. Mirrors
 * the simple-string repr: single quotes, escaping backslashes and single
 * quotes. Sufficient for the session-id / git-ref strings these sites format.
 */
function _pyRepr(s: string): string {
  const hasSingle = s.includes("'");
  const hasDouble = s.includes('"');
  if (hasSingle && !hasDouble) {
    return '"' + s.replace(/\\/g, "\\\\") + '"';
  }
  return "'" + s.replace(/\\/g, "\\\\").replace(/'/g, "\\'") + "'";
}
