/**
 * history + output-recall command implementations — the TS port of cli.py's
 * batch F (7 commands): bash-output, web-output, mcp-output, bash-history,
 * web-history, mcp-history, history.
 *
 * Faithful 1:1 port of cli.py command bodies + the cli.py-LOCAL helpers this
 * batch is the first to need:
 *   - _extract_body_section        (cli.py:3507)  + _parse_body_section_ordinal
 *   - _apply_head_tail             (cli.py:3641)
 *   - _apply_grep_cap              (cli.py:3655)
 *   - _format_age                  (cli.py:3676)
 *   - _parse_since_duration        (cli.py:4290)
 *   - _run_output_recall_command   (cli.py:3691) — the ~200 LOC recall pipeline
 *
 * Reused (already ported in cli_skills.ts, batch D):
 *   - _run_history_listing_command (EXPORTED for this batch)
 *   - _compile_grep_pattern        (now EXPORTED — shared by skill-body + recall)
 *   - _apply_smart_default         (now EXPORTED — same)
 *
 * Output seam: Python `typer.echo` / `raise typer.Exit` / `_error` route through
 * cli_common.ts (`_echo` / `CliExit` / `_error`), identical to the other cli_
 * modules. JSON dumps use `json.dumps(ensure_ascii=False, separators=(",",":"))`
 * → bare `JSON.stringify` (the batch-D ensure_ascii=False convention); the ONE
 * exception is `history --json` which Python emits with `indent=2` → JSON.stringify
 * (null, 2).
 *
 * Spy-ability gotcha: every cache / session / db / overflow fn the tests patch
 * is called via the `import * as` namespace (ESM live-binding analogue of
 * Python `patch.object`).
 *
 * Python-semantics parity:
 *  - body.splitlines() (NO keepends) → local `_splitlines` (trailing empty dropped).
 *  - len(body.encode()) → Buffer.byteLength(body, "utf8").
 *  - vars(sidecar) (the instance __dict__) → spread `{...sidecar}` (the TS
 *    sidecars are class instances whose own enumerable props are exactly the
 *    data fields, so this is the faithful equivalent).
 *  - f"{n:,}" thousands → `_comma`; f"{n:>10,}" / f"{age:>6}" right-align width
 *    → `_comma` then `padStart`.
 */
import * as bash_cache from "./bash_cache.js";
import * as cache_common from "./cache_common.js";
import * as db from "./db.js";
import * as mcp_cache from "./mcp_cache.js";
import * as overflow_guard from "./overflow_guard.js";
import * as session from "./session.js";
import * as web_cache from "./web_cache.js";
import type { OutputStatDict } from "./types.js";
import { CliExit, _echo, _error } from "./cli_common.js";
import {
  _apply_smart_default,
  _compile_grep_pattern,
  _run_history_listing_command,
} from "./cli_skills.js";
import { _unifiedDiff } from "./hints.js";

// ---------------------------------------------------------------------------
// Constants (cli.py:3477-3481)
// ---------------------------------------------------------------------------
const _HEAD_TAIL_LINES = 20;
const _HEAD_TAIL_THRESHOLD = _HEAD_TAIL_LINES * 2; // no-op when body <= this many lines
export const _GREP_MAX_DEFAULT = 20;

/** ATX heading pattern (cli.py `_BODY_ATX_RE`): 1-6 `#`, whitespace, heading text. */
const _BODY_ATX_RE = /^(#{1,6})\s+(.+?)\s*#*\s*$/;

// ---------------------------------------------------------------------------
// Python-semantics parity helpers
// ---------------------------------------------------------------------------

/** Python `str.splitlines()` (NO keepends): drop newlines + the trailing empty. */
function _splitlines(s: string): string[] {
  if (s === "") return [];
  const out = s.split(/\r\n|\r|\n/);
  if (out.length > 0 && out[out.length - 1] === "") out.pop();
  return out;
}

/** UTF-8 byte length — Python `len(s.encode())`. */
function _byteLen(s: string): number {
  return Buffer.byteLength(s, "utf8");
}

/** Insert thousands separators — Python `f"{n:,}"` for a non-negative integer. */
function _comma(n: number): string {
  return String(Math.trunc(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

// ---------------------------------------------------------------------------
// Section extraction (cli.py:3507 / 3554)
// ---------------------------------------------------------------------------

/** Split ``Heading#N`` into ``[base, ordinal|null]`` (cli.py:3554). */
function _parse_body_section_ordinal(heading: string): [string, number | null] {
  if (!heading.includes("#")) return [heading, null];
  const idx = heading.lastIndexOf("#");
  const base = heading.slice(0, idx);
  const ordinalStr = heading.slice(idx + 1);
  if (!base || !ordinalStr) return [heading, null];
  const ordinal = Number(ordinalStr);
  if (!Number.isInteger(ordinal) || ordinal < 1) return [heading, null];
  return [base, ordinal];
}

/** Extract a markdown section by heading from a raw text body (cli.py:3507). */
export function _extract_body_section(body: string, heading: string): string | null {
  const [baseHeading, ordinal] = _parse_body_section_ordinal(heading);
  const targetLower = baseHeading.toLowerCase();

  const lines = _splitlines(body);
  // Collect (line_index, level) for every ATX heading matching the target.
  const matches: Array<[number, number]> = [];
  for (let idx = 0; idx < lines.length; idx++) {
    const m = _BODY_ATX_RE.exec(lines[idx]!);
    if (m && m[2]!.trim().toLowerCase() === targetLower) {
      matches.push([idx, m[1]!.length]);
    }
  }
  if (matches.length === 0) return null;

  const occ = (ordinal ?? 1) - 1; // 0-based
  if (occ >= matches.length) return null;
  const [startIdx, level] = matches[occ]!;

  let endIdx = lines.length;
  for (let idx = startIdx + 1; idx < lines.length; idx++) {
    const m = _BODY_ATX_RE.exec(lines[idx]!);
    if (m && m[1]!.length <= level) {
      endIdx = idx;
      break;
    }
  }
  return lines.slice(startIdx, endIdx).join("\n");
}

// ---------------------------------------------------------------------------
// Recall-line helpers (cli.py:3641 / 3655 / 3676)
// ---------------------------------------------------------------------------

/** First + last _HEAD_TAIL_LINES lines with an omission marker (cli.py:3641). */
function _apply_head_tail(lines: string[]): string[] {
  const total = lines.length;
  if (total <= _HEAD_TAIL_THRESHOLD) return lines;
  const omitted = total - _HEAD_TAIL_LINES * 2;
  const marker = `--- ${omitted} lines omitted ---`;
  return [...lines.slice(0, _HEAD_TAIL_LINES), marker, ...lines.slice(-_HEAD_TAIL_LINES)];
}

/** Cap grep results + return a footer when truncated (cli.py:3655). */
export function _apply_grep_cap(matchedLines: string[], grepMax: number): [string[], string] {
  const total = matchedLines.length;
  if (grepMax <= 0 || total <= grepMax) return [matchedLines, ""];
  const footer = `(use --grep-max 0 for all ${total} matches)`;
  return [matchedLines.slice(0, grepMax), footer];
}

/** Human-readable age string (cli.py:3676): ``3s ago`` / ``4m ago`` / ``2h ago`` / ``1d ago``. */
function _format_age(ageSecs: number): string {
  const secs = Math.trunc(ageSecs);
  if (secs < 60) return `${secs}s ago`;
  if (secs < 3600) return `${Math.floor(secs / 60)}m ago`;
  if (secs < 86400) return `${Math.floor(secs / 3600)}h ago`;
  return `${Math.floor(secs / 86400)}d ago`;
}

/** Parse a human duration string (cli.py:4290): '30m'/'2h'/'1d' → seconds, else null. */
function _parse_since_duration(since: string): number | null {
  const s = since.trim().toLowerCase();
  const multipliers: Record<string, number> = { s: 1.0, m: 60.0, h: 3600.0, d: 86400.0 };
  const suffix = s.length > 0 ? s[s.length - 1]! : "";
  const multiplier = multipliers[suffix];
  if (multiplier !== undefined) {
    const n = Number(s.slice(0, -1));
    if (!Number.isFinite(n)) return null;
    return n * multiplier;
  }
  const n = Number(s);
  if (!Number.isFinite(n)) return null;
  return n;
}

// ---------------------------------------------------------------------------
// _run_output_recall_command (cli.py:3691)
// ---------------------------------------------------------------------------

/** Structural shape a cache module must satisfy for the recall pipeline. */
interface _RecallCacheModule {
  load_output: (outputId: string) => string | null;
  load_output_meta: (outputId: string) => Record<string, unknown> | null;
  read_sidecar: (outputId: string) => Record<string, unknown> | null;
}

/**
 * Shared implementation for bash-output / web-output / mcp-output recall. Port
 * of cli.py `_run_output_recall_command` (cli.py:3691). Exported for direct
 * unit-testing (tests/test_cli_output_recall.test.ts).
 */
export function _run_output_recall_command(args: {
  output_id: string;
  head: number;
  tail: number;
  grep: string | null;
  full: boolean;
  json_output: boolean;
  cache_module: _RecallCacheModule;
  stat_kind: string;
  not_found_msg: string;
  head_tail?: boolean;
  grep_max?: number;
  case_sensitive?: boolean;
  section?: string | null;
}): void {
  const {
    output_id,
    head,
    tail,
    grep,
    full,
    json_output,
    cache_module,
    stat_kind,
    not_found_msg,
  } = args;
  const head_tail = args.head_tail ?? false;
  const grep_max = args.grep_max ?? _GREP_MAX_DEFAULT;
  const case_sensitive = args.case_sensitive ?? false;
  const sectionHeading = args.section ?? null;

  let body = cache_module.load_output(output_id);
  if (body === null) {
    // Adoption-telemetry: recall miss (evicted/mistyped/other session).
    try {
      db.recordStat(undefined, `${stat_kind}_miss`, {
        bytesSaved: 0,
        tokensSaved: 0,
        detail: output_id.slice(0, 64),
      });
    } catch {
      // broad suppress — telemetry must never block the error path
    }
    _error(not_found_msg);
    throw new CliExit(1);
  }

  // --section: narrow the body to one markdown section before any other filter.
  if (sectionHeading) {
    const extracted = _extract_body_section(body, sectionHeading);
    if (extracted === null) {
      _error(`section not found in cached output: ${JSON.stringify(sectionHeading)}`);
      throw new CliExit(1);
    }
    body = extracted;
  }

  // Compile the grep regex once (literal fallback on invalid syntax).
  const grepPat = grep ? _compile_grep_pattern(grep, case_sensitive) : null;
  const grepMatches = (line: string): boolean => {
    if (grepPat === null) return true;
    return grepPat.test(line);
  };

  let lines = _splitlines(body);
  const slicingRequested = Boolean(grep) || head > 0 || tail > 0 || head_tail;
  let grepFooter = "";
  let matchCount = 0;
  if (grep) {
    let matched = lines.filter(grepMatches);
    matchCount = matched.length;
    [matched, grepFooter] = _apply_grep_cap(matched, grep_max);
    lines = matched;
    if (matchCount > 0) {
      lines = [`Match count: ${matchCount}`, ...lines];
    }
  }
  if (head > 0) lines = lines.slice(0, head);
  if (tail > 0) lines = lines.slice(-tail);
  if (head_tail && !grep) lines = _apply_head_tail(lines);
  if (!slicingRequested && !full) lines = _apply_smart_default(lines);
  if (grepFooter) lines = [...lines, grepFooter];
  const sliced = lines.join("\n");

  // Record a recall stat: saving = full cached body − what was returned.
  const bodyBytes = _byteLen(body);
  const returnedBytes = _byteLen(sliced);
  const savedBytes = Math.max(0, bodyBytes - returnedBytes);
  db.recordStat(undefined, stat_kind, {
    bytesSaved: savedBytes,
    tokensSaved: savedBytes > 0 ? Math.max(1, Math.floor(savedBytes / 3) + 1) : 0,
    detail: output_id.slice(0, 64),
  });

  if (json_output) {
    const meta = cache_module.load_output_meta(output_id) ?? {};
    const sidecar = cache_module.read_sidecar(output_id);
    const originalLines = _splitlines(body);
    const originalIndex: Record<string, number> = {};
    originalLines.forEach((ln, i) => {
      if (!(ln in originalIndex)) originalIndex[ln] = i + 1;
    });
    const jsonLines = lines.filter(
      (ln) => !ln.startsWith("Match count: ") && ln !== grepFooter,
    );
    const numbered = jsonLines.map((ln) => ({
      lineno: originalIndex[ln] ?? 0,
      text: ln,
    }));
    const payload: Record<string, unknown> = {
      output_id,
      text: sliced,
      lines: jsonLines.length,
      numbered_lines: numbered,
      total_lines: originalLines.length,
    };
    if (sectionHeading) payload["section"] = sectionHeading;
    if (grep) payload["match_count"] = originalLines.filter(grepMatches).length;
    Object.assign(payload, meta);
    if (sidecar !== null) Object.assign(payload, sidecar);
    _echo(JSON.stringify(payload));
    return;
  }

  // Text mode: one-line metadata header (cache age + key sidecar fields).
  const headerParts: string[] = [];
  _fillSidecarHeader(output_id, cache_module, headerParts);
  if (headerParts.length > 0) _echo("# " + headerParts.join("  "));

  // Safety net: cap an unbounded --full recall.
  const cmdLabel = stat_kind.replace("_output_recall", "-output");
  _echo(overflow_guard.guard(sliced, { command: cmdLabel }));
}

/**
 * Build the text-mode metadata header parts for a recall (cli.py:3864-3886).
 * Pushes onto *parts* (no-op when there is no sidecar).
 */
function _fillSidecarHeader(
  outputId: string,
  cacheModule: _RecallCacheModule,
  parts: string[],
): void {
  const sidecar = cacheModule.read_sidecar(outputId);
  if (sidecar === null) return;
  const metaStat = cacheModule.load_output_meta(outputId);
  if (metaStat !== null && metaStat["mtime"] !== undefined) {
    const age = Date.now() / 1000 - Number(metaStat["mtime"]);
    parts.push(`cached ${_format_age(age)}`);
  }
  // bash sidecar fields
  const exitCode = sidecar["exit_code"];
  if (exitCode !== undefined && exitCode !== null) parts.push(`exit=${exitCode}`);
  const cmd = sidecar["cmd_preview"];
  if (cmd) parts.push(`$ ${cmd}`);
  // web sidecar fields
  const status = sidecar["status_code"];
  if (status !== undefined && status !== null) parts.push(`status=${status}`);
  const url = sidecar["url_preview"];
  if (url) parts.push(String(url));
}

// ---------------------------------------------------------------------------
// bash-output (cli.py:3895)
// ---------------------------------------------------------------------------

export function bash_output(args: {
  output_id: string;
  head: number;
  tail: number;
  grep: string | null;
  grep_max: number;
  case_sensitive: boolean;
  full: boolean;
  head_tail: boolean;
  section: string | null;
  json_output: boolean;
  diff: boolean;
}): void {
  const { output_id, head, tail, grep, grep_max, case_sensitive, full, head_tail, section, json_output, diff } = args;

  if (full && diff) {
    _error("Use --full or --diff, not both.");
    throw new CliExit(1);
  }

  if (diff) {
    const body = bash_cache.load_output(output_id);
    if (body === null) {
      _error(`no cached output for id: ${output_id}`);
      throw new CliExit(1);
    }
    const fullLines = _splitlines(body);
    const compressedLines = _apply_smart_default(fullLines);
    // Python: difflib.unified_diff(compressed, full, fromfile="compressed",
    // tofile="full", lineterm="") then "\n".join(lines).
    const diffLines = _unifiedDiff(compressedLines, fullLines, {
      fromfile: "compressed",
      tofile: "full",
      lineterm: "",
    });
    if (diffLines.length > 0) {
      _echo(diffLines.join("\n"));
    } else {
      _echo("(no diff: output is short enough that trimming was not applied)");
    }
    return;
  }

  _run_output_recall_command({
    output_id,
    head,
    tail,
    grep,
    full,
    json_output,
    cache_module: bash_cache as unknown as _RecallCacheModule,
    stat_kind: "bash_output_recall",
    not_found_msg: `no cached output for id: ${output_id}`,
    head_tail,
    grep_max,
    case_sensitive,
    section,
  });
}

// ---------------------------------------------------------------------------
// web-output (cli.py:3976)
// ---------------------------------------------------------------------------

export function web_output(args: {
  output_id: string | null;
  head: number;
  tail: number;
  grep: string | null;
  grep_max: number;
  case_sensitive: boolean;
  full: boolean;
  head_tail: boolean;
  section: string | null;
  json_output: boolean;
  from_session: string | null;
  list_all: boolean;
}): void {
  const {
    output_id,
    head,
    tail,
    grep,
    grep_max,
    case_sensitive,
    full,
    head_tail,
    section,
    json_output,
    from_session,
    list_all,
  } = args;

  if (list_all) {
    const allEntries = web_cache.list_outputs();
    if (allEntries.length === 0) {
      _echo("(no web outputs cached)");
      return;
    }
    if (json_output) {
      _echo(JSON.stringify(_webListRows(allEntries)));
      return;
    }
    _webListText(allEntries, false);
    return;
  }

  if (from_session !== null) {
    const sessPrefix = `${cache_common.safe_session_fragment(from_session)}-`;
    const allEntries = web_cache.list_outputs();
    const entries = allEntries.filter((e) =>
      String(e.output_id ?? "").startsWith(sessPrefix),
    );
    if (entries.length === 0) {
      _echo(`(no web outputs cached for session: ${from_session})`);
      return;
    }
    if (json_output) {
      _echo(JSON.stringify(_webListRows(entries)));
      return;
    }
    _webListText(entries, true); // --from-session: "{age:>6}s ago" format
    return;
  }

  if (output_id === null) {
    _error("output_id is required unless --from-session or --list is specified");
    throw new CliExit(2);
  }

  _run_output_recall_command({
    output_id,
    head,
    tail,
    grep,
    full,
    json_output,
    cache_module: web_cache as unknown as _RecallCacheModule,
    stat_kind: "web_output_recall",
    not_found_msg: `no cached web output for id: ${output_id}`,
    head_tail,
    grep_max,
    case_sensitive,
    section,
  });
}

/** Build the JSON rows for web --list / --from-session (merges url_preview/status_code). */
function _webListRows(entries: OutputStatDict[]): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = [];
  for (const e of entries) {
    const row: Record<string, unknown> = { ...e };
    const sidecar = web_cache.read_sidecar(String(e.output_id ?? ""));
    if (sidecar !== null) {
      row["url_preview"] = sidecar.url_preview;
      row["status_code"] = sidecar.status_code;
    }
    out.push(row);
  }
  return out;
}

/** Human-readable web listing. *fromSession* selects the age format: false =
 *  `_format_age` (--list), true = `{age:>6}s ago` (--from-session). */
function _webListText(entries: OutputStatDict[], fromSession: boolean): void {
  const now = Date.now() / 1000;
  for (const e of entries) {
    const oid = String(e.output_id ?? "");
    const size = Math.trunc(Number(e.size_bytes ?? 0));
    const age = Math.trunc(now - Number(e.mtime ?? now));
    const sidecar = web_cache.read_sidecar(oid);
    const urlStr = sidecar !== null ? sidecar.url_preview : "(no sidecar)";
    const statusStr =
      sidecar !== null && sidecar.status_code !== null && sidecar.status_code !== undefined
        ? ` status=${sidecar.status_code}`
        : "";
    const sizeStr = `${_comma(size).padStart(10)}B`; // "{size:>10,}B": comma number width 10 + B
    const ageStr = fromSession ? `${String(age).padStart(6)}s ago` : _format_age(age);
    _echo(`${oid}  ${sizeStr}  ${ageStr}${statusStr}  ${urlStr}`);
  }
}

// ---------------------------------------------------------------------------
// mcp-output (cli.py:4202)
// ---------------------------------------------------------------------------

export function mcp_output(args: {
  output_id: string;
  head: number;
  tail: number;
  grep: string | null;
  grep_max: number;
  case_sensitive: boolean;
  full: boolean;
  head_tail: boolean;
  section: string | null;
  json_output: boolean;
}): void {
  const { output_id, head, tail, grep, grep_max, case_sensitive, full, head_tail, section, json_output } = args;
  _run_output_recall_command({
    output_id,
    head,
    tail,
    grep,
    full,
    json_output,
    cache_module: mcp_cache as unknown as _RecallCacheModule,
    stat_kind: "mcp_output_recall",
    not_found_msg: `no cached MCP output for id: ${output_id}`,
    head_tail,
    grep_max,
    case_sensitive,
    section,
  });
}

// ---------------------------------------------------------------------------
// web-history (cli.py:4171) / mcp-history (cli.py:4250) / bash-history (cli.py:4319)
// ---------------------------------------------------------------------------

export function web_history(args: { json_output: boolean; limit: number }): void {
  _run_history_listing_command(web_cache as unknown as Parameters<typeof _run_history_listing_command>[0], {
    json_output: args.json_output,
    limit: args.limit,
    empty_msg: "(no cached WebFetch responses)",
    json_sidecar_fields: (s) => {
      const sc = s as { url_preview: string; status_code: number | null; truncated: boolean; content_type: string | null };
      return {
        url_preview: sc.url_preview,
        status_code: sc.status_code,
        truncated: sc.truncated,
        content_type: sc.content_type,
      };
    },
    format_entry: (oid, size, age, s) => {
      const sc = s as { url_preview: string; status_code: number | null } | null;
      const urlStr = sc !== null ? sc.url_preview : "(no sidecar)";
      const statusStr =
        sc !== null && sc.status_code !== null && sc.status_code !== undefined
          ? ` status=${sc.status_code}`
          : "";
      return `${oid}  ${_comma(size).padStart(10)}B  ${String(age).padStart(6)}s ago${statusStr}  ${urlStr}`;
    },
  });
}

export function mcp_history(args: { json_output: boolean; limit: number }): void {
  _run_history_listing_command(mcp_cache as unknown as Parameters<typeof _run_history_listing_command>[0], {
    json_output: args.json_output,
    limit: args.limit,
    empty_msg: "(no cached MCP results)",
    json_sidecar_fields: (s) => {
      const sc = s as { tool_name: string; input_preview: string; result_bytes: number };
      return {
        tool_name: sc.tool_name,
        input_preview: sc.input_preview,
        result_bytes: sc.result_bytes,
      };
    },
    format_entry: (oid, size, age, s) => {
      const sc = s as { tool_name: string; input_preview: string } | null;
      let tool: string;
      let previewStr: string;
      if (sc !== null) {
        tool = sc.tool_name || "(unknown)";
        const preview = sc.input_preview || "";
        previewStr = preview ? `  ${preview.slice(0, 60)}` : "";
      } else {
        tool = "(no sidecar)";
        previewStr = "";
      }
      return `${oid}  ${_comma(size).padStart(10)}B  ${String(age).padStart(6)}s ago  ${tool}${previewStr}`;
    },
  });
}

export function bash_history(args: {
  json_output: boolean;
  limit: number;
  since: string | null;
}): void {
  const { json_output, limit, since } = args;
  let sinceSecs: number | null = null;
  if (since !== null) {
    sinceSecs = _parse_since_duration(since);
    if (sinceSecs === null) {
      _error(`unrecognised --since value: ${JSON.stringify(since)}  (expected e.g. '30m', '2h', '1d')`);
      throw new CliExit(2);
    }
  }
  _run_history_listing_command(bash_cache as unknown as Parameters<typeof _run_history_listing_command>[0], {
    json_output,
    limit,
    empty_msg: "(no cached Bash outputs)",
    json_sidecar_fields: (s) => {
      const sc = s as { cmd_preview: string; exit_code: number | null; truncated: boolean };
      return {
        cmd_preview: sc.cmd_preview,
        exit_code: sc.exit_code,
        truncated: sc.truncated,
      };
    },
    format_entry: (oid, size, age, s) => {
      const sc = s as { cmd_preview: string; exit_code: number | null } | null;
      let preview: string;
      let exitStr: string;
      if (sc !== null) {
        preview = sc.cmd_preview;
        if (preview.length > 100) preview = `${preview.slice(0, 100)}…`;
        exitStr = sc.exit_code !== null && sc.exit_code !== undefined ? ` [exit:${sc.exit_code}]` : "";
      } else {
        preview = "(no sidecar)";
        exitStr = "";
      }
      return `${oid}  ${_comma(size).padStart(10)}B  ${String(age).padStart(6)}s ago${exitStr}  ${preview}`;
    },
    since_secs: sinceSecs,
  });
}

// ---------------------------------------------------------------------------
// history (cli.py:4375) — session access history
// ---------------------------------------------------------------------------

export function history(args: {
  session_id: string | null;
  bash: boolean;
  web: boolean;
  grep: boolean;
  limit: number;
  json_output: boolean;
}): void {
  const { session_id, bash: onlyBash, web: onlyWeb, grep: onlyGrep, limit, json_output } = args;

  if (session_id) {
    try {
      session.validate_session_id(session_id);
    } catch (exc) {
      _error(`invalid session ID: ${exc instanceof Error ? exc.message : String(exc)}`);
      throw new CliExit(1);
    }
  } else {
    _error("--session-id is required");
    throw new CliExit(1);
  }

  const cache = session.safe_load(session_id);
  if (cache === null || cache.unavailable) {
    _error(`Session cache unavailable: ${session_id}`);
    throw new CliExit(1);
  }

  const showBash = onlyBash || (!onlyBash && !onlyWeb && !onlyGrep);
  const showWeb = onlyWeb || (!onlyBash && !onlyWeb && !onlyGrep);
  const showGrep = onlyGrep || (!onlyBash && !onlyWeb && !onlyGrep);

  const currentTime = Date.now() / 1000;

  if (json_output) {
    const output: Record<string, unknown> = {};
    if (showBash && !cache.is_bash_history_empty()) {
      const entries: Array<Record<string, unknown>> = [];
      for (const [, entry] of Object.entries(cache.bash_history).slice(-limit)) {
        const ageSecs = Math.trunc(currentTime - entry.ts);
        const cached = entry.output_id ? "yes" : "no";
        entries.push({
          command: entry.cmd_preview,
          exit_code: entry.exit_code,
          cached,
          size_bytes: entry.stdout_bytes + entry.stderr_bytes,
          age_seconds: ageSecs,
          run_count: entry.run_count,
        });
      }
      output["bash"] = entries;
    }
    if (showWeb && !cache.is_web_history_empty()) {
      const entries: Array<Record<string, unknown>> = [];
      for (const [, entry] of Object.entries(cache.web_history).slice(-limit)) {
        const ageSecs = Math.trunc(currentTime - entry.ts);
        const cached = entry.output_id ? "yes" : "no";
        entries.push({
          url: entry.url_preview,
          cached,
          size_kb: Math.floor(entry.body_bytes / 1024),
          status_code: entry.status_code,
          age_seconds: ageSecs,
        });
      }
      output["web"] = entries;
    }
    if (showGrep && !cache.is_greps_empty()) {
      const entries: Array<Record<string, unknown>> = [];
      for (const grepEntry of cache.greps.slice(-limit)) {
        const ageSecs = Math.trunc(currentTime - grepEntry.ts);
        entries.push({
          pattern: grepEntry.pattern,
          path: grepEntry.path,
          result_count: grepEntry.result_count,
          age_seconds: ageSecs,
        });
      }
      output["grep"] = entries;
    }
    _echo(JSON.stringify(output, null, 2));
    return;
  }

  // Text output.
  let hadOutput = false;

  if (showBash) {
    if (!cache.is_bash_history_empty()) {
      _echo("## Bash History (most recent first)");
      for (const [, entry] of Object.entries(cache.bash_history).slice(-limit)) {
        const ageSecs = Math.trunc(currentTime - entry.ts);
        const exitStr = entry.exit_code !== null && entry.exit_code !== undefined ? ` exit=${entry.exit_code}` : "";
        const cachedStr = entry.output_id ? "cached" : "not cached";
        const totalBytes = entry.stdout_bytes + entry.stderr_bytes;
        const sizeMb = totalBytes / (1024 * 1024);
        let sizeStr: string;
        if (sizeMb >= 1) {
          sizeStr = `${sizeMb.toFixed(1)} MB`;
        } else {
          sizeStr = `${_comma(totalBytes)} B`;
        }
        _echo(
          `  ${_comma(ageSecs).padStart(6)}s ago ${exitStr.padStart(8)} [${cachedStr.padStart(12)}] ${sizeStr.padStart(12)}  ${entry.cmd_preview}`,
        );
      }
      hadOutput = true;
    } else {
      _echo("## Bash History");
      _echo("  (no entries)");
      hadOutput = true;
    }
  }

  if (showWeb) {
    if (hadOutput) _echo("");
    if (!cache.is_web_history_empty()) {
      _echo("## Web History (most recent first)");
      for (const [, entry] of Object.entries(cache.web_history).slice(-limit)) {
        const ageSecs = Math.trunc(currentTime - entry.ts);
        const cachedStr = entry.output_id ? "cached" : "not cached";
        const sizeKb = Math.floor(entry.body_bytes / 1024);
        const statusStr =
          entry.status_code !== null && entry.status_code !== undefined ? ` status=${entry.status_code}` : "";
        _echo(
          `  ${_comma(ageSecs).padStart(6)}s ago ${statusStr.padStart(9)} [${cachedStr.padStart(12)}] ${String(sizeKb).padStart(8)} KB  ${entry.url_preview}`,
        );
      }
      hadOutput = true;
    } else {
      _echo("## Web History");
      _echo("  (no entries)");
      hadOutput = true;
    }
  }

  if (showGrep) {
    if (hadOutput) _echo("");
    if (!cache.is_greps_empty()) {
      _echo("## Grep History (most recent first)");
      for (const grepEntry of cache.greps.slice(-limit)) {
        const ageSecs = Math.trunc(currentTime - grepEntry.ts);
        const pathStr = grepEntry.path ? ` in ${grepEntry.path}` : " (global)";
        const resultStr =
          grepEntry.result_count !== null && grepEntry.result_count !== undefined
            ? ` → ${grepEntry.result_count} matches`
            : "";
        _echo(`  ${_comma(ageSecs).padStart(6)}s ago  ${grepEntry.pattern}${pathStr}${resultStr}`);
      }
    } else {
      _echo("## Grep History");
      _echo("  (no entries)");
    }
  }
}
