/**
 * The `map` command (cli batch B).
 *
 * Faithful 1:1 TypeScript port of src/token_goat/cli.py `cmd_map`
 * (lines 1778–2054) and its helper `_build_map_skills_footer`
 * (lines 2057–2123).
 *
 * `map` generates a PageRank-ranked, token-budgeted overview of the current
 * project. It has 6 output branches selected by flags, applied in this order
 * (matching Python exactly — each early-returns):
 *
 *   1. --top N            → compact "path (rank: score)" for the top N files
 *   2. --since <ref>      → build_map_since (changed files only)
 *   3. --since-minutes N  → files modified within the last N minutes (by mtime)
 *   4. --format json      → build_map_json (compact JSON)
 *   5. --format mermaid   → build_map_mermaid
 *   6. text (default)     → build_map (+ optional --filter post-filter +
 *                            Active-skills footer)
 *
 * All shared helpers (cli_lookup._require_project / _record_lookup_stat /
 * _total_project_bytes / _fnmatchCase) and the repomap renderers are invoked
 * through MODULE NAMESPACES so tests can `vi.spyOn` these boundaries (ESM
 * named-import bindings are read-only and bypass spies — a documented gotcha).
 * Output routes through the cli_common seam (`_echo`/`_error`/`CliExit`).
 */
import * as fs from "node:fs";
import * as path from "node:path";

import type { Project } from "./project.js";
import * as cliLookup from "./cli_lookup.js";
import * as compact from "./compact.js";
import * as repomap from "./repomap.js";
import * as session from "./session.js";
import * as skill_cache from "./skill_cache.js";
import { _echo, _error, CliExit } from "./cli_common.js";
import { getLogger } from "./util.js";

import * as self from "./cli_map.js";

const _LOG = getLogger("cli_map");

// ---------------------------------------------------------------------------
// Python-semantics parity helpers
// ---------------------------------------------------------------------------

/** Byte length of a string as UTF-8 (Python `len(s.encode())`). */
function _byteLen(s: string): number {
  return Buffer.byteLength(s, "utf8");
}

/**
 * Reproduce Python `str.splitlines()`: split on universal newlines and DROP a
 * trailing empty element (a final "\n" does NOT yield a trailing "").
 */
function _splitlines(s: string): string[] {
  if (s === "") return [];
  const parts = s.split(/\r\n|\r|\n|\v|\f|\x1c|\x1d|\x1e|\x85|\u2028|\u2029/);
  if (parts.length > 0 && parts[parts.length - 1] === "") parts.pop();
  return parts;
}

/**
 * Reproduce Python `str.splitlines(keepends=True)`: split on universal newlines
 * but KEEP the line terminator attached to each element. A trailing newline on
 * the final line yields a final empty element ONLY if the input ends with a
 * newline that follows another newline (i.e. the empty line itself is kept with
 * its terminator). The `--filter` walk uses this so non-file lines are passed
 * through verbatim (with their newline) and file lines are matched on their
 * first whitespace token.
 *
 * JS has no built-in keepends split; emulate with a global regex that captures
 * each line together with its trailing newline (or end-of-string). `^.*` is
 * greedy up to (but not including) the newline, so `(\r?\n|$)` captures the
 * terminator. This mirrors CPython's universal-newline handling for the common
 * `\n` case (the repomap text never contains the exotic vertical-tab line
 * breaks in practice).
 */
function _splitlinesKeepends(s: string): string[] {
  if (s === "") return [];
  // Match each line: any chars (greedy, not crossing \n) then a newline or EOS.
  const out = s.match(/^.*(\r\n|\r|\n|$)/gm);
  return out ?? [];
}

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

/** Options shape for the `map` command (mirrors the Python typer flags). */
export interface MapOpts {
  budget?: number;
  json_output?: boolean;
  fmt?: string;
  compact?: boolean;
  full?: boolean;
  top?: number | null;
  top_n?: number;
  since?: string | null;
  filter_glob?: string | null;
  since_minutes?: number | null;
}

// ---------------------------------------------------------------------------
// Command implementation
// ---------------------------------------------------------------------------

/**
 * Generate a PageRank-ranked, token-budgeted overview of the current project.
 *
 * Port of cli.py `cmd_map` (1778–2054). Emits via the shared cli_common seam
 * and throws CliExit(code) where Python does `raise typer.Exit(code)`.
 */
export async function map(opts: MapOpts = {}): Promise<void> {
  const budget = opts.budget ?? 4000;
  const json_output = opts.json_output ?? false;
  let fmt = opts.fmt ?? "text";
  const compact_flag = opts.compact ?? false;
  const full = opts.full ?? false;
  const top = opts.top ?? null;
  const top_n = opts.top_n ?? 20;
  const since = opts.since ?? null;
  const filter_glob = opts.filter_glob ?? null;
  const since_minutes = opts.since_minutes ?? null;

  const proj = await cliLookup._require_project(
    "no project detected (no .git, package.json, etc. found). " +
      "Run from a project directory.",
  );

  // --json flag is a legacy alias for --format json
  if (json_output && fmt === "text") {
    fmt = "json";
  }

  const _valid_formats = new Set(["text", "json", "mermaid"]);
  if (!_valid_formats.has(fmt)) {
    const sorted = Array.from(_valid_formats).sort();
    _error(
      `unknown format ${JSON.stringify(fmt)}. Choose one of: ${sorted.join(", ")}`,
    );
    throw new CliExit(1);
  }

  const projName = path.basename(proj.root);
  _LOG.info(
    "map start: project=%s budget=%d format=%s compact=%s full=%s top=%s since=%s filter=%s since_minutes=%s",
    projName,
    budget,
    fmt,
    compact_flag,
    full,
    String(top),
    String(since),
    String(filter_glob),
    String(since_minutes),
  );
  const t0 = Date.now();
  // Savings baseline: total indexed source bytes in the project. Queried once
  // outside each branch so all map modes share the same denominator.
  // Best-effort: _total_project_bytes returns 0 on any error.
  const _map_proj_total = cliLookup._total_project_bytes(proj.hash);

  try {
    // --top: show only top N files by PageRank
    if (top !== null) {
      if (top <= 0) {
        _error("--top must be a positive integer");
        throw new CliExit(1);
      }
      const text = repomap.build_map(proj, {
        budget_tokens: budget,
        top_n: top,
      });
      const elapsed = Date.now() - t0;
      _LOG.info("map complete: project=%s top=%d dur=%.3fs", projName, top, elapsed / 1000);
      const top_count = _splitlines(text).filter((line) => line.includes("rank:")).length;
      cliLookup._record_lookup_stat(
        "map_lookup",
        `budget=${budget},mode=top,top=${top}`,
        top_count,
        {
          scope: "project",
          project_hash: proj.hash,
          bytes_saved: Math.max(0, _map_proj_total - _byteLen(text)),
        },
      );
      _echo(text);
      return;
    }

    // --since: show only changed files, regardless of format
    if (since !== null) {
      const text = repomap.build_map_since(proj, since, {
        budget_tokens: budget,
        compact: compact_flag ? true : null,
        full,
      });
      const elapsed = Date.now() - t0;
      _LOG.info("map complete: project=%s since=%s dur=%.3fs", projName, since, elapsed / 1000);
      const changed_lines = _splitlines(text).filter((line) => line.includes("[changed]")).length;
      cliLookup._record_lookup_stat(
        "map_lookup",
        `budget=${budget},mode=since,ref=${since}`,
        changed_lines,
        {
          scope: "project",
          project_hash: proj.hash,
          bytes_saved: Math.max(0, _map_proj_total - _byteLen(text)),
        },
      );
      _echo(text);
      return;
    }

    // --since-minutes: show only files modified in the last N minutes by mtime
    if (since_minutes !== null) {
      if (since_minutes <= 0) {
        _error("--since-minutes must be a positive integer");
        throw new CliExit(1);
      }
      const cutoff = Date.now() / 1000 - since_minutes * 60;
      const recent_files: string[] = [];
      try {
        const ranked_data = repomap._load_and_rank(proj);
        const ranked = ranked_data ? ranked_data.ranked : [];
        for (const [rel_path_str] of ranked) {
          const abs_path = path.join(proj.root, rel_path_str);
          let mtime: number;
          try {
            mtime = fs.statSync(abs_path).mtimeMs / 1000;
          } catch {
            continue;
          }
          if (
            mtime >= cutoff &&
            (filter_glob === null || cliLookup._fnmatchCase(rel_path_str, filter_glob))
          ) {
            recent_files.push(rel_path_str);
          }
        }
      } catch {
        // pass — best-effort
      }
      const elapsed = Date.now() - t0;
      _LOG.info(
        "map complete: project=%s since_minutes=%d files=%d dur=%.3fs",
        projName,
        since_minutes,
        recent_files.length,
        elapsed / 1000,
      );
      let header = `# ${projName} — ${recent_files.length} file(s) modified in last ${since_minutes}m`;
      if (filter_glob) {
        header += ` (filter: ${filter_glob})`;
      }
      header += "\n";
      let body: string;
      if (recent_files.length > 0) {
        body = header + recent_files.map((p) => `  ${p}\n`).join("");
      } else {
        body = header + "(no recently modified files found)\n";
      }
      cliLookup._record_lookup_stat(
        "map_lookup",
        `budget=${budget},mode=since_minutes,minutes=${since_minutes}`,
        recent_files.length,
        {
          scope: "project",
          project_hash: proj.hash,
          bytes_saved: Math.max(0, _map_proj_total - _byteLen(body)),
        },
      );
      _echo(body);
      return;
    }

    if (fmt === "json") {
      const data = repomap.build_map_json(proj);
      const elapsed = Date.now() - t0;
      _LOG.info(
        "map complete: project=%s files=%d dur=%.3fs",
        projName,
        data.length,
        elapsed / 1000,
      );
      const json_str = JSON.stringify(data);
      cliLookup._record_lookup_stat(
        "map_lookup",
        `budget=${budget},mode=json,compact=${compact_flag ? "True" : "False"},full=${full ? "True" : "False"}`,
        data.length,
        {
          scope: "project",
          project_hash: proj.hash,
          bytes_saved: Math.max(0, _map_proj_total - _byteLen(json_str)),
        },
      );
      _echo(json_str);
      return;
    }

    if (fmt === "mermaid") {
      const diagram = repomap.build_map_mermaid(proj, { top_n });
      const elapsed = Date.now() - t0;
      _LOG.info(
        "map complete: project=%s format=mermaid dur=%.3fs",
        projName,
        elapsed / 1000,
      );
      cliLookup._record_lookup_stat(
        "map_lookup",
        `budget=${budget},mode=mermaid,top_n=${top_n}`,
        top_n,
        {
          scope: "project",
          project_hash: proj.hash,
          bytes_saved: Math.max(0, _map_proj_total - _byteLen(diagram)),
        },
      );
      _echo(diagram);
      return;
    }

    // Pass compact=true only if the user opted in; null lets build_map
    // auto-engage the compact path when the budget is below the threshold.
    let text = repomap.build_map(proj, {
      budget_tokens: budget,
      compact: compact_flag ? true : null,
      full,
    });

    // --filter GLOB: post-filter output lines to only include lines whose
    // path matches the glob pattern. Lines without a recognizable path
    // (headers, blank lines, footers) are kept verbatim so the output
    // retains its structure.
    if (filter_glob !== null) {
      const filtered_lines: string[] = [];
      for (const ln of _splitlinesKeepends(text)) {
        const stripped = ln.trim();
        // Keep non-file lines (headers start with #, blank lines, etc.)
        if (
          stripped === "" ||
          stripped.startsWith("#") ||
          stripped.startsWith("[token-goat")
        ) {
          filtered_lines.push(ln);
          continue;
        }
        // Extract relative path: first whitespace-delimited token on
        // file-entry lines (the path is always the first word).
        const tokens = stripped.split(/\s+/);
        const candidate = tokens.length > 0 ? tokens[0]! : "";
        if (cliLookup._fnmatchCase(candidate, filter_glob)) {
          filtered_lines.push(ln);
        }
      }
      text = filtered_lines.join("");
    }

    const elapsed = Date.now() - t0;
    _LOG.info(
      "map complete: project=%s dur=%.3fs filter=%s",
      projName,
      elapsed / 1000,
      String(filter_glob),
    );
    // Adoption telemetry: count map calls so token-goat stats can show
    // how often agents reach for the ranked overview instead of recursive
    // ls + multiple Reads. result_count = number of file-entry lines
    // actually emitted (approximate, but stable across compact / full).
    const file_lines = _splitlines(text).filter((line) => line.includes("[")).length;
    cliLookup._record_lookup_stat(
      "map_lookup",
      `budget=${budget},mode=text,compact=${compact_flag ? "True" : "False"},full=${full ? "True" : "False"},filter=${filter_glob ?? "None"}`,
      file_lines,
      {
        scope: "project",
        project_hash: proj.hash,
        bytes_saved: Math.max(0, _map_proj_total - _byteLen(text)),
      },
    );
    _echo(text);
    // Active skills footer: append a brief "Active skills" section when the
    // current session has cached skills. Appears after the repo overview so
    // agents orienting in a new codebase immediately see which skills are
    // loaded and recoverable. Suppressed when there are no skills (the
    // typical case for a fresh session) to avoid cluttering the output.
    const _map_skills_footer = self._build_map_skills_footer();
    if (_map_skills_footer) {
      _echo(_map_skills_footer);
    }
  } catch (exc) {
    if (exc instanceof CliExit) throw exc;
    _error(
      `failed to build repo map: ${exc instanceof Error ? exc.message : String(exc)}. ` +
        "Try `token-goat index --full` to rebuild the index.",
    );
    throw new CliExit(1);
  }
}

// ---------------------------------------------------------------------------
// _build_map_skills_footer (cli.py:2057–2123)
// ---------------------------------------------------------------------------

/**
 * Build a brief "Active skills" footer for `token-goat map` text output.
 *
 * Returns an empty string when no session exists or no skills are cached, so
 * the caller can test with a simple truthiness check. Failures are swallowed —
 * a broken session cache must never abort the map command.
 *
 * Session resolution: uses the most-recently modified session that has cached
 * skills (same heuristic as `token-goat skill-list`), so the footer reflects
 * the session the agent is currently running in without requiring an explicit
 * `--session-id` argument on the map command.
 *
 * Port of cli.py `_build_map_skills_footer` (2057–2123). Em-dash (U+2014) and
 * multiplication sign (U+00D7) are used verbatim — they appear in normal
 * string output, not in regex/comment positions, so raw unicode is safe.
 */
export function _build_map_skills_footer(): string {
  try {
    // Find the most recent session that has skill entries.
    const outputs = skill_cache.list_outputs();
    if (outputs.length === 0) return "";
    const first_oid = outputs[0]!.output_id ?? "";
    const sid = first_oid.length >= 16 ? first_oid.slice(0, 16) : first_oid;
    if (sid === "") return "";

    const skill_history = session.get_skill_history(sid);
    if (!skill_history) return "";

    let _session_started_ts = 0.0;
    try {
      const _cache = session.safe_load(sid);
      _session_started_ts = Number(_cache?.started_ts ?? 0.0) || 0.0;
    } catch (exc) {
      _LOG.debug(
        "skill-sections: failed to load session timestamp for %s (using 0.0)",
        sid,
        exc,
      );
    }

    const entries = compact._select_top_skill_entries(skill_history, {
      session_started_ts: _session_started_ts,
    });
    if (entries.length === 0) return "";

    const skill_names: string[] = [];
    for (const e of entries) {
      const sname = String((e as { skill_name?: unknown }).skill_name ?? "");
      if (sname) skill_names.push(sname);
    }
    if (skill_names.length === 0) return "";

    const lines = ["", "## Active skills"];
    for (const sname of skill_names) {
      const entry = skill_history[sname];
      let run_count = 1;
      if (entry) {
        const rc = (entry as { run_count?: unknown }).run_count;
        run_count = typeof rc === "number" ? rc : 1;
      }
      let compact_note = "";
      try {
        const ct = skill_cache.get_compact(sid, sname);
        if (ct) {
          compact_note = ` (compact: ~${compact.estimate_tokens(ct)} tok)`;
        }
      } catch (exc) {
        _LOG.debug(
          "skill-sections: failed to get compact info for %r (skip)",
          sname,
          exc,
        );
      }
      const run_note = run_count > 1 ? ` ×${run_count}` : "";
      lines.push(`- ${sname}${run_note}${compact_note} — \`token-goat skill-body ${sname}\``);
    }
    return lines.join("\n");
  } catch {
    return "";
  }
}
