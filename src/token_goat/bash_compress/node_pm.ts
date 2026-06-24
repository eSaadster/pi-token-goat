/**
 * bash_compress NODE PACKAGE-MANAGER + NODE-EVAL FILTERS — TypeScript port of the
 * NpmInstallFilter, PnpmFilter, YarnFilter, BunFilter, NodePackageFilter, and
 * NodeFilter Filter subclasses from src/token_goat/bash_compress.py (plus the
 * module-level npm / pnpm / yarn / bun / node regexes and the two npm-audit
 * compression helpers _compress_npm_audit_json / _compress_npm_audit_human).
 *
 * The filters subclass the concrete Filter base from ./framework.js and override
 * matches()/compress() (and the private _compress_* helpers) with per-tool
 * structural compression. They are appended to the FILTERS registry (and __all__)
 * by the barrel one level up — this module does NOT wire the barrel.
 *
 * These filters have NO dedicated test files; they are validated only by the
 * dispatch test (matches() / detect_from_command() routing). Ported with extra
 * care for the detect_from_command + compress parity:
 *  - NodeFilter fires ONLY on eval/print flags (node -e / --eval / -p / --print),
 *    stopping the scan at the first non-flag arg (the script filename) so that
 *    `node script.js -e arg` does not false-positive.
 *  - NodePackageFilter handles npm / pnpm / yarn / bun via the default
 *    binaries-based matches(); its compress() branches on the `audit` subcommand
 *    and the `--json` flag.
 *  - NpmInstallFilter / PnpmFilter / YarnFilter / BunFilter each override
 *    matches() with bespoke subcommand routing.
 *
 * ---------------------------------------------------------------------------
 * Parity notes (Python -> TS)
 * ---------------------------------------------------------------------------
 *  - Python identifiers are preserved EXACTLY: PascalCase class names and the
 *    snake_case module-private regex/helper names (_NPM_*, _PNPM_*, _YARN_*,
 *    _BUN_*, _NODE_*, _compress_npm_audit_json, _compress_npm_audit_human).
 *  - re.compile(...) -> top-level RegExp compiled once at module load. IGNORECASE
 *    -> "i"; MULTILINE -> "m" (only YarnFilter's berry-detection re.search uses
 *    the "m" flag for ^ at every line start). Per-line .match(line) goes through
 *    _reMatch (index===0 on a non-global clone) so the "m" flag is irrelevant for
 *    those calls; .search(line) goes through _reSearch (unanchored).
 *  - Python re.search(pattern, line) inline calls (yarn classic/berry, pnpm
 *    lockfile) -> _reSearch with a literal regex.
 *  - _ERROR_SIGNAL_RE is a framework-module-private const (NOT exported), so it
 *    is re-declared here VERBATIM (same source/flags as framework.ts line 667)
 *    and wrapped by _searchErrorSignal — mirroring the local-shim style of
 *    test_runners.ts. It is exported so any dispatch test that asserts on it can
 *    import it.
 *  - json.loads / json.dumps(indent=2) -> JSON.parse / JSON.stringify(.., null, 2).
 *    Python's json.dumps(indent=2) separates dict items with ",\n" and key/value
 *    with ": " — JSON.stringify(value, null, 2) produces the identical layout for
 *    the object shapes npm audit emits (no NaN/Infinity, which npm never emits).
 *    A non-object / non-array top level or a parse error -> return text unchanged
 *    (Python catches ValueError/TypeError).
 *  - Path(s.replace("\\","/")).stem.lower() -> _pathStem (local), matching the
 *    framework's _pathStem semantics (final component, last suffix removed).
 *  - str.rstrip() -> _rstrip; str.strip() -> _strip; "x" in line.lower() ->
 *    line.toLowerCase().includes("x").
 *  - sorted(dict)[:5] -> [...map.keys()].sort().slice(0,5) (lexicographic, the
 *    JS default sort matching Python's str sort for the ASCII package names here).
 *  - Byte/line caps and blank-line squeezing are delegated to the framework
 *    helpers (Filter._finalize / Filter._emit_notes / _maybe_note / cap_tokens /
 *    _head_tail_compress / _dedup_lines / _squeeze_blank_lines) — no framework
 *    helper is re-implemented here.
 *
 * MODULE-GLOBAL STATE: none. Every filter is stateless; the only module-level
 * values are the compiled regexes (immutable for the process lifetime). No
 * registerReset is wired (mirrors test_runners.ts).
 *
 * NOTE on import depth: this file lives in the bash_compress/ SUBDIR; the
 * framework is a SIBLING (./framework.js) and the package-level deps go UP one
 * level (../). verbatimModuleSyntax is on -> nothing imported here is type-only.
 * noImplicitOverride is on -> every overridden member carries `override`.
 */

import {
  Filter,
  _maybe_note,
  _positional_args,
  _dedup_lines,
  _head_tail_compress,
  _squeeze_blank_lines,
  cap_tokens,
} from "./framework.js";

// ===========================================================================
// Internal Python-builtin shims local to this module.
// ===========================================================================

/** Python str.strip() — strip leading and trailing whitespace. */
function _strip(s: string): string {
  return s.replace(/^\s+/u, "").replace(/\s+$/u, "");
}

/** Python str.rstrip() — strip trailing whitespace. */
function _rstrip(s: string): string {
  return s.replace(/\s+$/u, "");
}

/** Return a clone of re without the global/sticky flags (one-shot .exec/.test). */
function _nonGlobal(re: RegExp): RegExp {
  const flags = re.flags.replace(/[gy]/g, "");
  return new RegExp(re.source, flags);
}

/**
 * Python re.Pattern.match(line) — anchored at the START (NOT end-anchored). JS
 * has no anchored-match primitive; emulate via a non-global clone and an
 * index===0 check.
 */
function _reMatch(re: RegExp, line: string): boolean {
  const r = _nonGlobal(re);
  const m = r.exec(line);
  return m !== null && m.index === 0;
}

/**
 * Python re.Pattern.match(line) returning the match object (or null), for the
 * callers that read capture groups. Non-global clone so lastIndex never leaks.
 */
function _reMatchObj(re: RegExp, line: string): RegExpExecArray | null {
  const r = _nonGlobal(re);
  const m = r.exec(line);
  return m !== null && m.index === 0 ? m : null;
}

/** Python re.search(...) — unanchored search anywhere in the string. */
function _reSearch(re: RegExp, text: string): boolean {
  return _nonGlobal(re).test(text);
}

/**
 * Python re.search(...) returning the match object (or null) — unanchored,
 * reads capture groups. Non-global clone so lastIndex never leaks.
 */
function _reSearchObj(re: RegExp, text: string): RegExpExecArray | null {
  return _nonGlobal(re).exec(text);
}

/**
 * pathlib.Path(s.replace("\\","/")).stem.lower() — the lowercased final path
 * component with its LAST suffix removed. Matches framework._pathStem semantics
 * (a leading-dot dotfile keeps its name; a trailing dot is not a suffix).
 */
function _pathStemLower(s: string): string {
  const norm = s.replace(/\\/g, "/");
  const trimmed = norm.replace(/\/+$/, "");
  const idx = trimmed.lastIndexOf("/");
  const name = idx >= 0 ? trimmed.slice(idx + 1) : trimmed;
  const dot = name.lastIndexOf(".");
  let stem: string;
  if (dot <= 0 || dot === name.length - 1) {
    stem = name;
  } else {
    stem = name.slice(0, dot);
  }
  return stem.toLowerCase();
}

// ===========================================================================
// Shared error-signal regex (framework-module-private; re-declared verbatim).
// ===========================================================================

// Patterns that signal an error or failure line worth preserving. Copied
// VERBATIM from framework.ts (line 667) — the framework does NOT export this
// const, so the node-pm filters carry their own identical copy.
// Python: re.compile(r"error:|Error:|ERROR|FAILED|failed|fatal:|Traceback
//   |exception:|Exception:|AssertionError|assert |panic:", re.IGNORECASE)
const _ERROR_SIGNAL_RE: RegExp =
  /error:|Error:|ERROR|FAILED|failed|fatal:|Traceback|exception:|Exception:|AssertionError|assert |panic:/i;

/** Python _ERROR_SIGNAL_RE.search(line) — boolean "contains error signal". */
function _searchErrorSignal(line: string): boolean {
  return _reSearch(_ERROR_SIGNAL_RE, line);
}

// _ERROR_SIGNAL_RE is module-private (a verbatim copy of framework's, since
// framework does not export it). NOT re-exported: each filter module that needs
// it keeps its own private copy, so the barrel's `export *` chain stays free of
// duplicate `_ERROR_SIGNAL_RE` exports (which would be a TS2308 ambiguity).

// ===========================================================================
// Node package managers (npm / pnpm / yarn / bun) — NodePackageFilter regexes
// (Python lines ~3476-3495).
// ===========================================================================

// Python: re.compile(r"^\s*(⠋|⠙|⠹|⠸|⠼|⠴|⠦|⠧|⠇|⠏)\s")
export const _NPM_PROGRESS_RE: RegExp =
  /^\s*(⠋|⠙|⠹|⠸|⠼|⠴|⠦|⠧|⠇|⠏)\s/;
// Python: re.compile(r"^\s*npm warn deprecated|^\s*WARN deprecated", re.IGNORECASE)
export const _NPM_DEPRECATED_RE: RegExp =
  /^\s*npm warn deprecated|^\s*WARN deprecated/i;
// Python: re.compile(r"^\s*[a-z0-9@._/-]+\s+(low|moderate|high|critical)\s", re.IGNORECASE)
export const _NPM_AUDIT_PKG_RE: RegExp =
  /^\s*[a-z0-9@._/-]+\s+(low|moderate|high|critical)\s/i;
// Python: re.compile(r"^\s*npm (?:ERR!|error)\s|^\s*ERROR\s", re.IGNORECASE)
export const _NPM_ERR_RE: RegExp = /^\s*npm (?:ERR!|error)\s|^\s*ERROR\s/i;
// Matches the start of a human-mode npm audit advisory block header:
// "# <package-name>\n  Severity: moderate\n  ..." repeated per advisory.
// Python: re.compile(r"^# [a-z0-9@._/-]", re.IGNORECASE)
export const _NPM_AUDIT_ADVISORY_HDR_RE: RegExp = /^# [a-z0-9@._/-]/i;
// Python: re.compile(r"^\s*Severity:\s+(low|moderate|high|critical)\s*$", re.IGNORECASE)
export const _NPM_AUDIT_SEVERITY_RE: RegExp =
  /^\s*Severity:\s+(low|moderate|high|critical)\s*$/i;
// Python: re.compile(r"^found \d+|^Severity:|^==|^-{3,}", re.IGNORECASE)
export const _NPM_AUDIT_SUMMARY_RE: RegExp = /^found \d+|^Severity:|^==|^-{3,}/i;

// Inline regex used by NodePackageFilter.compress for the deprecation-package
// grouping: re.search(r"\b([a-z0-9@._/-]+)@[\d.]+", line).
const _NPM_DEPRECATED_PKG_RE: RegExp = /\b([a-z0-9@._/-]+)@[\d.]+/;

// ===========================================================================
// NodePackageFilter (Python lines ~3500-3572)
// ===========================================================================

/**
 * Compress npm / pnpm / yarn / bun package-manager output.
 *
 * Drops spinner/progress lines, collapses deprecation warnings to one summary
 * line per unique package, keeps every `npm ERR!` / `npm error` block verbatim,
 * and collapses per-package audit detail. `npm audit --json` collapses the
 * vulnerabilities object when it has >10 entries; `npm audit` (human mode)
 * collapses duplicate advisory blocks. See the Python docstring for the full
 * model.
 */
export class NodePackageFilter extends Filter {
  override name = "npm";
  override binaries: ReadonlySet<string> = new Set(["npm", "pnpm", "yarn", "bun"]);

  override compress(stdout: string, stderr: string, _exit_code: number, argv: string[]): string {
    const merged = this._combine_output(stdout, stderr);

    // Detect npm audit subcommand.
    const positionals = _positional_args(argv.slice(1));
    const is_audit = positionals.includes("audit");

    if (is_audit) {
      // JSON mode: `npm audit --json` or `npm audit --json --audit-level=...`
      if (argv.includes("--json")) {
        return _compress_npm_audit_json(merged);
      }
      // Human mode: collapse duplicate advisory blocks.
      return _compress_npm_audit_human(merged);
    }

    const lines = merged.split("\n");
    const kept: string[] = [];
    const deprecated_pkgs = new Map<string, number>();
    let audit_lines_dropped = 0;
    for (const line of lines) {
      if (_reMatch(_NPM_PROGRESS_RE, line)) {
        continue;
      }
      if (_reMatch(_NPM_DEPRECATED_RE, line)) {
        // Extract the package name (`foo@1.2.3:`) for grouping.
        const m = _reSearchObj(_NPM_DEPRECATED_PKG_RE, line);
        const pkg = m ? m[1]! : "<unknown>";
        deprecated_pkgs.set(pkg, (deprecated_pkgs.get(pkg) ?? 0) + 1);
        continue;
      }
      if (_reMatch(_NPM_AUDIT_PKG_RE, line) && !_reMatch(_NPM_ERR_RE, line)) {
        audit_lines_dropped += 1;
        continue;
      }
      kept.push(line);
    }
    if (deprecated_pkgs.size > 0) {
      let total = 0;
      for (const v of deprecated_pkgs.values()) {
        total += v;
      }
      const sorted_pkgs = [...deprecated_pkgs.keys()].sort();
      kept.push(
        `[token-goat: collapsed ${total} deprecation ` +
          `warnings across ${deprecated_pkgs.size} packages: ` +
          `${sorted_pkgs.slice(0, 5).join(", ")}` +
          (deprecated_pkgs.size > 5 ? "…" : "") +
          "]",
      );
    }
    if (audit_lines_dropped) {
      kept.push(
        `[token-goat: dropped ${audit_lines_dropped} per-package audit lines; ` +
          "run `npm audit` for detail]",
      );
    }
    return Filter._finalize(kept);
  }
}

/**
 * Compress `npm audit --json` output.
 *
 * When the `vulnerabilities` object has more than 10 entries, keep only
 * critical/high severity entries and replace the rest with a count sentinel. The
 * `metadata` block (totals) is always preserved.
 */
export function _compress_npm_audit_json(text: string): string {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    return text; // Not valid JSON — pass through unchanged.
  }
  // Python json.loads of a non-object top level is valid; .get fails with
  // AttributeError -> caught? No: Python only catches ValueError/TypeError, but
  // a JSON scalar (e.g. "5") .get would raise AttributeError. In practice npm
  // audit --json always emits an object; guard defensively by passing through
  // any non-plain-object top level (matching the "not a dict" vulns branch).
  if (typeof data !== "object" || data === null || Array.isArray(data)) {
    return text;
  }
  const obj = data as Record<string, unknown>;
  const vulns = obj["vulnerabilities"];
  if (typeof vulns !== "object" || vulns === null || Array.isArray(vulns)) {
    return text;
  }
  const vulnsObj = vulns as Record<string, unknown>;
  if (Object.keys(vulnsObj).length <= 10) {
    return text; // Short enough — no compression needed.
  }

  // Partition by severity: keep critical/high; summarise the rest.
  const keep: Record<string, unknown> = {};
  let collapsed_count = 0;
  const collapsed_severities = new Map<string, number>();
  for (const pkg of Object.keys(vulnsObj)) {
    const info = vulnsObj[pkg];
    let severity = "";
    if (typeof info === "object" && info !== null && !Array.isArray(info)) {
      const sevVal = (info as Record<string, unknown>)["severity"];
      severity = String(sevVal ?? "").toLowerCase();
    }
    if (severity === "critical" || severity === "high") {
      keep[pkg] = info;
    } else {
      collapsed_count += 1;
      collapsed_severities.set(severity, (collapsed_severities.get(severity) ?? 0) + 1);
    }
  }

  if (collapsed_count) {
    const sev_summary = [...collapsed_severities.keys()]
      .sort()
      .map((k) => `${collapsed_severities.get(k)!} ${k}`)
      .join(", ");
    keep["__token_goat__"] =
      `${collapsed_count} lower-severity entries collapsed (${sev_summary}); ` +
      "run `npm audit --json` for full output";
  }
  obj["vulnerabilities"] = keep;
  return JSON.stringify(obj, null, 2);
}

/**
 * Compress human-mode `npm audit` output.
 *
 * Advisory blocks share a common format ("# <package>\n  Severity: <sev>\n ...").
 * When more than 10 advisory blocks exist for any single severity level, keep
 * only the first 10 for that severity and emit a count summary. The final
 * `found N vulnerabilities` summary line is always preserved.
 */
export function _compress_npm_audit_human(text: string): string {
  const lines = text.split("\n");
  // Identify advisory block boundaries (lines starting with "# <pkg>").
  // (start_idx, end_idx, severity)
  const blocks: Array<[number, number, string]> = [];
  let i = 0;
  while (i < lines.length) {
    if (_reMatch(_NPM_AUDIT_ADVISORY_HDR_RE, lines[i]!)) {
      const start = i;
      let severity = "unknown";
      // Peek ahead up to 5 lines for "Severity: ..." to classify.
      for (let j = i + 1; j < Math.min(i + 6, lines.length); j += 1) {
        const m = _reMatchObj(_NPM_AUDIT_SEVERITY_RE, lines[j]!);
        if (m) {
          severity = m[1]!.toLowerCase();
          break;
        }
      }
      // Find the end of this block (next header, summary line, or EOF).
      let end = i + 1;
      while (end < lines.length) {
        const ln = lines[end]!;
        if (_reMatch(_NPM_AUDIT_ADVISORY_HDR_RE, ln)) {
          break;
        }
        if (_reMatch(_NPM_AUDIT_SUMMARY_RE, ln)) {
          break;
        }
        end += 1;
      }
      blocks.push([start, end, severity]);
      i = end;
    } else {
      i += 1;
    }
  }

  if (blocks.length === 0) {
    return text; // No advisory blocks found — pass through.
  }

  // Group blocks by severity; keep the first 10 per severity.
  const MAX_PER_SEV = 10;
  const sev_count = new Map<string, number>();
  const keep_blocks = new Set<number>();
  for (let idx = 0; idx < blocks.length; idx += 1) {
    const sev = blocks[idx]![2];
    sev_count.set(sev, (sev_count.get(sev) ?? 0) + 1);
    if (sev_count.get(sev)! <= MAX_PER_SEV) {
      keep_blocks.add(idx);
    }
  }

  // Build a set of line indices to drop.
  const drop_lines = new Set<number>();
  const collapsed_sev = new Map<string, number>();
  for (let idx = 0; idx < blocks.length; idx += 1) {
    const [start, end, sev] = blocks[idx]!;
    if (!keep_blocks.has(idx)) {
      for (let li = start; li < end; li += 1) {
        drop_lines.add(li);
      }
      collapsed_sev.set(sev, (collapsed_sev.get(sev) ?? 0) + 1);
    }
  }

  if (drop_lines.size === 0) {
    return text; // Nothing to collapse.
  }

  const kept: string[] = [];
  for (let idx = 0; idx < lines.length; idx += 1) {
    if (!drop_lines.has(idx)) {
      kept.push(lines[idx]!);
    }
  }
  const notes: string[] = [];
  for (const sev of [...collapsed_sev.keys()].sort()) {
    notes.push(`collapsed ${collapsed_sev.get(sev)!} duplicate ${sev} advisories`);
  }
  Filter._emit_notes(kept, notes);
  return _squeeze_blank_lines(kept.join("\n"));
}

// ===========================================================================
// node (eval / print probes) — NodeFilter regexes (Python lines ~3704-3718).
// ===========================================================================

// Node.js stack frame prefix: "    at "
// Python: re.compile(r"^\s{4}at\s")
export const _NODE_FRAME_RE: RegExp = /^\s{4}at\s/;
// Node.js internal module frame — two forms:
//   "    at node:internal/..." (anonymous / direct reference)
//   "    at SomeFunction (node:internal/...)" (named frame, node: in parens)
// Python: re.compile(r"^\s{4}at\s+(?:node:|.+\s+\(node:)")
export const _NODE_INTERNAL_FRAME_RE: RegExp = /^\s{4}at\s+(?:node:|.+\s+\(node:)/;
// Frame from a node_modules package: "    at ... (/…/node_modules/…)" or
// "    at /…/node_modules/…" (anonymous frame). Covers POSIX and Windows paths.
// Python: re.compile(r"^\s{4}at\s+.*[/\\]node_modules[/\\]")
export const _NODE_MODULES_FRAME_RE: RegExp = /^\s{4}at\s+.*[/\\]node_modules[/\\]/;

// NodeFilter eval/print flags (Python: frozenset(["-e", "--eval", "-p", "--print"])).
const _NODE_EVAL_FLAGS: ReadonlySet<string> = new Set(["-e", "--eval", "-p", "--print"]);

// ===========================================================================
// NodeFilter (Python lines ~3721-3825)
// ===========================================================================

/**
 * Compress `node -e` / `node -p` inline eval probe output.
 *
 * Success (exit_code === 0): pass through with a light token cap. Failure
 * (exit_code !== 0): collapse consecutive node_modules / node:internal stack
 * frames to count placeholders, preserve user-code frames and non-frame lines
 * verbatim, then cap to ~1000 tokens. Only fires for eval probes (-e / --eval /
 * -p / --print); regular `node script.js` runs pass through to GenericFilter.
 */
export class NodeFilter extends Filter {
  override name = "node";
  override binaries: ReadonlySet<string> = new Set(["node", "nodejs"]);

  // Python: _EVAL_FLAGS: frozenset[str] = frozenset(["-e", "--eval", "-p", "--print"])
  _EVAL_FLAGS: ReadonlySet<string> = _NODE_EVAL_FLAGS;

  override matches(argv: string[]): boolean {
    if (argv.length === 0) {
      return false;
    }
    const stem = _pathStemLower(argv[0]!);
    if (!this.binaries.has(stem)) {
      return false;
    }
    // Only intercept eval / print probes; leave script runs alone. Stop scanning
    // at the first non-flag argument (the script filename) so that
    // 'node script.js -e arg' does not false-positive.
    for (const arg of argv.slice(1)) {
      if (!arg.startsWith("-")) {
        return false; // hit script filename; remaining args are script args
      }
      if (this._EVAL_FLAGS.has(arg)) {
        return true;
      }
    }
    return false;
  }

  override compress(stdout: string, stderr: string, exit_code: number, _argv: string[]): string {
    // Success: eval result is tiny; pass through with a light token cap.
    if (exit_code === 0) {
      const combined = this._combine_output(stdout, stderr);
      return cap_tokens(combined, 500);
    }

    // Failure: Node.js writes the stack trace to stderr.
    let text = _strip(stderr) !== "" ? stderr : stdout;
    if (_strip(stderr) !== "" && _strip(stdout) !== "") {
      text = _rstrip(stderr) + "\n" + _rstrip(stdout);
    }
    if (_strip(text) === "") {
      return text;
    }

    const lines = text.split("\n");
    const result = this._compact_trace(lines);
    return cap_tokens(result.join("\n"), 1000);
  }

  /** Collapse node_modules and node:internal frames, keep user frames. */
  _compact_trace(lines: string[]): string[] {
    const out: string[] = [];
    let nm_run = 0; // consecutive node_modules frame count
    let int_run = 0; // consecutive node:internal frame count

    const _flush_nm = (): void => {
      if (nm_run) {
        out.push(`    [token-goat: ${nm_run} node_modules frame(s) omitted]`);
        nm_run = 0;
      }
    };

    const _flush_int = (): void => {
      if (int_run) {
        out.push(`    [token-goat: ${int_run} Node.js internal frame(s) omitted]`);
        int_run = 0;
      }
    };

    for (const line of lines) {
      if (_reMatch(_NODE_MODULES_FRAME_RE, line)) {
        _flush_int();
        nm_run += 1;
      } else if (_reMatch(_NODE_INTERNAL_FRAME_RE, line)) {
        _flush_nm();
        int_run += 1;
      } else {
        _flush_nm();
        _flush_int();
        out.push(line);
      }
    }

    _flush_nm();
    _flush_int();
    return out;
  }
}

// ===========================================================================
// npm install / yarn install / pnpm install — NpmInstallFilter regexes
// (Python lines ~11010-11054).
// ===========================================================================

// npm warn deprecated lines (keep first 3, suppress the rest).
// Python: re.compile(r"^npm warn deprecated\b", re.IGNORECASE)
export const _NPM_INST_DEPRECATED_RE: RegExp = /^npm warn deprecated\b/i;
// npm notice lines — generic suppression gate.
// Python: re.compile(r"^npm notice\b", re.IGNORECASE)
export const _NPM_INST_NOTICE_RE: RegExp = /^npm notice\b/i;
// npm notice lockfile — actionable, keep.
// Python: re.compile(r"^npm notice.*lock", re.IGNORECASE)
export const _NPM_INST_NOTICE_LOCKFILE_RE: RegExp = /^npm notice.*lock/i;
// "found 0 vulnerabilities" — suppress; nonzero falls through and is kept.
// Python: re.compile(r"^found 0 vulnerabilities\b", re.IGNORECASE)
export const _NPM_INST_ZERO_VULN_RE: RegExp = /^found 0 vulnerabilities\b/i;
// "N packages are looking for funding" — suppress.
// Python: re.compile(r"^\d+\s+packages? are looking for funding\b", re.IGNORECASE)
export const _NPM_INST_FUNDING_RE: RegExp = /^\d+\s+packages? are looking for funding\b/i;
// "run `npm fund`" advisory — suppress.
// Python: re.compile(r"^\s*run `npm fund`", re.IGNORECASE)
export const _NPM_INST_FUND_RUN_RE: RegExp = /^\s*run `npm fund`/i;
// General npm WARN (non-deprecated) — keep first 3, collapse the rest.
// Python: re.compile(r"^npm warn\b", re.IGNORECASE)
export const _NPM_INST_WARN_RE: RegExp = /^npm warn\b/i;
// npm verbose/debug lines (timing, sill, http, verb) — suppress entirely.
// Python: re.compile(r"^npm (?:timing|sill|http fetch|http request|http finish|verb)\b", re.IGNORECASE)
export const _NPM_INST_VERBOSE_RE: RegExp =
  /^npm (?:timing|sill|http fetch|http request|http finish|verb)\b/i;
// npm spinner/reify progress lines (braille spinner chars) — suppress.
// Python: re.compile(r"^[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]\s")
export const _NPM_INST_REIFY_RE: RegExp = /^[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]\s/;
// yarn peer-dependency warning lines — suppress.
// Python: re.compile(r'^warning ".+ > .+" has (?:unmet|incorrect) peer dependency', re.IGNORECASE)
export const _YARN_INST_PEER_DEP_RE: RegExp =
  /^warning ".+ > .+" has (?:unmet|incorrect) peer dependency/i;
// yarn classic phase headers [N/N] — suppress.
// Python: re.compile(r"^\[\d+/\d+\]")
export const _YARN_INST_PHASE_RE: RegExp = /^\[\d+\/\d+\]/;
// yarn info lines — suppress. Python: re.compile(r"^info\b", re.IGNORECASE)
export const _YARN_INST_INFO_RE: RegExp = /^info\b/i;
// yarn success lines — suppress. Python: re.compile(r"^success\b", re.IGNORECASE)
export const _YARN_INST_SUCCESS_RE: RegExp = /^success\b/i;
// pnpm +++ progress bars — suppress. Python: re.compile(r"^\++\s*$")
export const _PNPM_INST_PLUS_BAR_RE: RegExp = /^\++\s*$/;
// pnpm Progress: line — keep if "done" at end, suppress otherwise.
// Python: re.compile(r"^Progress:", re.IGNORECASE)
export const _PNPM_INST_PROGRESS_RE: RegExp = /^Progress:/i;

// ===========================================================================
// NpmInstallFilter (Python lines ~11057-11249)
// ===========================================================================

/**
 * Compress `npm install` / `yarn install` / `pnpm install` output.
 *
 * Drops install noise (deprecated/peer-dep warnings, progress bars, phase
 * headers) while keeping error lines, the first 3 deprecation/warn lines, the
 * package-count and nonzero-vulnerability summaries, and lockfile notices. See
 * the Python docstring for the per-tool model.
 */
export class NpmInstallFilter extends Filter {
  override name = "npm_install";
  override binaries: ReadonlySet<string> = new Set(["npm"]);

  _NPM_SUBCMDS: ReadonlySet<string> = new Set(["install", "i", "ci"]);
  _YARN_SUBCMDS: ReadonlySet<string> = new Set(["install", "add", ""]);
  _PNPM_SUBCMDS: ReadonlySet<string> = new Set(["install", "add", "i"]);

  override matches(argv: string[]): boolean {
    if (argv.length === 0) {
      return false;
    }
    const stem = _pathStemLower(argv[0]!);
    const positionals = argv.slice(1).filter((a) => !a.startsWith("-"));
    const subcmd = positionals.length > 0 ? positionals[0]!.toLowerCase() : "";

    if (stem === "npm") {
      return this._NPM_SUBCMDS.has(subcmd);
    }
    if (stem === "yarn") {
      return this._YARN_SUBCMDS.has(subcmd);
    }
    if (stem === "pnpm") {
      return this._PNPM_SUBCMDS.has(subcmd);
    }
    return false;
  }

  override compress(stdout: string, stderr: string, _exit_code: number, argv: string[]): string {
    const stem = argv.length > 0 ? _pathStemLower(argv[0]!) : "";
    const merged = this._combine_output(stdout, stderr);

    if (stem === "npm") {
      return this._compress_npm(merged);
    }
    if (stem === "yarn") {
      return this._compress_yarn(merged);
    }
    if (stem === "pnpm") {
      return this._compress_pnpm(merged);
    }
    return Filter._finalize(merged.split("\n"));
  }

  _compress_npm(text: string): string {
    const lines = text.split("\n");
    const kept: string[] = [];
    let deprecated_count = 0;
    let deprecated_suppressed = 0;
    let warn_count = 0;
    let warn_suppressed = 0;
    let verbose_suppressed = 0;

    for (const line of lines) {
      if (_searchErrorSignal(line)) {
        kept.push(line);
        continue;
      }
      if (_reMatch(_NPM_INST_DEPRECATED_RE, line)) {
        deprecated_count += 1;
        if (deprecated_count <= 3) {
          kept.push(line);
        } else {
          deprecated_suppressed += 1;
        }
        continue;
      }
      // General npm WARN (non-deprecated): keep first 3, collapse the rest.
      if (_reMatch(_NPM_INST_WARN_RE, line)) {
        warn_count += 1;
        if (warn_count <= 3) {
          kept.push(line);
        } else {
          warn_suppressed += 1;
        }
        continue;
      }
      // Suppress verbose/debug lines (timing, sill, http, verb).
      if (_reMatch(_NPM_INST_VERBOSE_RE, line)) {
        verbose_suppressed += 1;
        continue;
      }
      // Suppress spinner/reify progress lines.
      if (_reMatch(_NPM_INST_REIFY_RE, line)) {
        verbose_suppressed += 1;
        continue;
      }
      if (_reMatch(_NPM_INST_NOTICE_RE, line)) {
        if (_reSearch(_NPM_INST_NOTICE_LOCKFILE_RE, line)) {
          kept.push(line);
        }
        continue;
      }
      if (_reMatch(_NPM_INST_ZERO_VULN_RE, line)) {
        continue;
      }
      if (_reMatch(_NPM_INST_FUNDING_RE, line)) {
        continue;
      }
      if (_reMatch(_NPM_INST_FUND_RUN_RE, line)) {
        continue;
      }
      kept.push(line);
    }

    const notes: string[] = [];
    if (deprecated_suppressed) {
      notes.push(
        `suppressed ${deprecated_suppressed} additional deprecated` +
          ` warnings (showed first 3 of ${deprecated_count})`,
      );
    }
    if (warn_suppressed) {
      notes.push(
        `suppressed ${warn_suppressed} additional npm warn lines` +
          ` (showed first 3 of ${warn_count})`,
      );
    }
    _maybe_note(notes, verbose_suppressed, `suppressed ${verbose_suppressed} verbose/progress lines`);
    NpmInstallFilter._emit_notes(kept, notes);
    return Filter._finalize(kept);
  }

  _compress_yarn(text: string): string {
    const lines = text.split("\n");
    const kept: string[] = [];
    let noise_suppressed = 0;

    for (const line of lines) {
      if (_searchErrorSignal(line)) {
        kept.push(line);
        continue;
      }
      if (_reMatch(_YARN_INST_PEER_DEP_RE, line)) {
        noise_suppressed += 1;
        continue;
      }
      if (_reMatch(_YARN_INST_PHASE_RE, line)) {
        noise_suppressed += 1;
        continue;
      }
      if (_reMatch(_YARN_INST_INFO_RE, line)) {
        noise_suppressed += 1;
        continue;
      }
      if (_reMatch(_YARN_INST_SUCCESS_RE, line)) {
        noise_suppressed += 1;
        continue;
      }
      kept.push(line);
    }

    const notes: string[] = [];
    _maybe_note(notes, noise_suppressed, `suppressed ${noise_suppressed} yarn install progress/noise lines`);
    NpmInstallFilter._emit_notes(kept, notes);
    return Filter._finalize(kept);
  }

  _compress_pnpm(text: string): string {
    const lines = text.split("\n");
    const kept: string[] = [];
    let progress_suppressed = 0;

    for (const line of lines) {
      if (_searchErrorSignal(line)) {
        kept.push(line);
        continue;
      }
      if (_reMatch(_PNPM_INST_PLUS_BAR_RE, line)) {
        progress_suppressed += 1;
        continue;
      }
      if (_reMatch(_PNPM_INST_PROGRESS_RE, line)) {
        if (line.toLowerCase().includes("done")) {
          kept.push(line);
        } else {
          progress_suppressed += 1;
        }
        continue;
      }
      kept.push(line);
    }

    const notes: string[] = [];
    _maybe_note(notes, progress_suppressed, `suppressed ${progress_suppressed} pnpm progress lines`);
    NpmInstallFilter._emit_notes(kept, notes);
    return Filter._finalize(kept);
  }
}

// ===========================================================================
// pnpm — PnpmFilter regexes (Python lines ~11255-11263).
// ===========================================================================

// pnpm per-package download/fetch progress lines.
// Python: re.compile(r"^\s*(?:Resolving|Downloading|Fetching)[:\s].*\d+/\d+"
//                     r"|\s+\d+\s+packages?\s+(?:fetched|resolved|downloaded|linked)")
export const _PNPM_PROGRESS_RE: RegExp =
  /^\s*(?:Resolving|Downloading|Fetching)[:\s].*\d+\/\d+|\s+\d+\s+packages?\s+(?:fetched|resolved|downloaded|linked)/;
// pnpm lockfile/packages summary lines to keep.
// Python: re.compile(r"^(?:Packages:|Already up to date|Progress:|WARN|ERR!|added|removed|changed)", re.IGNORECASE)
export const _PNPM_SUMMARY_RE: RegExp =
  /^(?:Packages:|Already up to date|Progress:|WARN|ERR!|added|removed|changed)/i;

// Inline regex used by PnpmFilter._compress_install for lockfile/workspace notices:
// re.match(r"^\s*(?:Lockfile|Saved|node_modules|symlink)", line, re.IGNORECASE).
const _PNPM_LOCKFILE_RE: RegExp = /^\s*(?:Lockfile|Saved|node_modules|symlink)/i;

// ===========================================================================
// PnpmFilter (Python lines ~11266-11354)
// ===========================================================================

/**
 * Compress `pnpm install` / `pnpm add` / `pnpm run` output.
 *
 * For install/add: keep summary, "Already up to date", and lockfile change
 * lines; collapse per-package download/fetch progress; keep every warn/error
 * line verbatim. For `pnpm run <script>`: prepend a "pnpm run <script>: " label
 * to the first non-empty output line. exec/dlx pass through unchanged. See the
 * Python docstring for the full model.
 */
export class PnpmFilter extends Filter {
  override name = "pnpm";
  override binaries: ReadonlySet<string> = new Set(["pnpm"]);

  override matches(argv: string[]): boolean {
    if (argv.length === 0) {
      return false;
    }
    const stem = _pathStemLower(argv[0]!);
    return stem === "pnpm";
  }

  override compress(stdout: string, stderr: string, _exit_code: number, argv: string[]): string {
    const positionals = argv.slice(1).filter((tok) => !tok.startsWith("-"));
    const subcmd = positionals.length > 0 ? positionals[0]! : "";

    const merged = this._combine_output(stdout, stderr);

    if (subcmd === "run" && positionals.length >= 2) {
      return this._compress_run(merged, positionals[1]!);
    }

    if (subcmd === "exec" || subcmd === "dlx") {
      // exec/dlx run an arbitrary binary; pass output through unchanged.
      return merged;
    }

    // install / add / remove / update / import
    return this._compress_install(merged);
  }

  _compress_install(text: string): string {
    const lines = text.split("\n");
    const kept: string[] = [];
    let progress_dropped = 0;

    for (const line of lines) {
      if (_searchErrorSignal(line)) {
        kept.push(line);
        continue;
      }
      // Keep summary/status lines verbatim.
      if (_reMatch(_PNPM_SUMMARY_RE, line)) {
        kept.push(line);
        continue;
      }
      // Lockfile / workspace notices.
      if (_reMatch(_PNPM_LOCKFILE_RE, line)) {
        kept.push(line);
        continue;
      }
      // Collapse resolver/download progress.
      if (_reSearch(_PNPM_PROGRESS_RE, line)) {
        progress_dropped += 1;
        continue;
      }
      kept.push(line);
    }

    const notes: string[] = [];
    _maybe_note(notes, progress_dropped, `collapsed ${progress_dropped} resolver/download progress lines`);
    PnpmFilter._emit_notes(kept, notes);
    return Filter._finalize(kept);
  }

  /** Prepend 'pnpm run <script>: ' to the first non-empty output line. */
  _compress_run(text: string, script: string): string {
    const lines = text.split("\n");
    const out: string[] = [];
    let labelled = false;
    for (const line of lines) {
      if (!labelled && _strip(line)) {
        out.push(`pnpm run ${script}: ${line}`);
        labelled = true;
      } else {
        out.push(line);
      }
    }
    return Filter._finalize(out);
  }
}

// ===========================================================================
// yarn — YarnFilter regexes (Python lines ~11360-11376).
// ===========================================================================

// Yarn classic fetch individual package lines.
// Python: re.compile(r"^\s*(?:Fetching|Saving|Linking)\s+dependency\s+graph"
//                     r"|\[2/4\]\s+Fetching\s+packages\.\.\.\s*$"
//                     r"|\s{2,}Fetching\s+\S")
export const _YARN_CLASSIC_FETCH_RE: RegExp =
  /^\s*(?:Fetching|Saving|Linking)\s+dependency\s+graph|\[2\/4\]\s+Fetching\s+packages\.\.\.\s*$|\s{2,}Fetching\s+\S/;
// Yarn classic warning dedup key (normalize warning message).
// Python: re.compile(r"^warning\s+", re.IGNORECASE)
export const _YARN_WARNING_RE: RegExp = /^warning\s+/i;
// Yarn berry (v2+) resolution/fetch progress.
// Python: re.compile(r"^➤\s+YN\d{4}:\s+(?:[│└]\s+)?\S.*(?:\d+/\d+|\d+\.\d+\s*[KMG]?B)")
export const _YARN_BERRY_PROGRESS_RE: RegExp =
  /^➤\s+YN\d{4}:\s+(?:[│└]\s+)?\S.*(?:\d+\/\d+|\d+\.\d+\s*[KMG]?B)/;
// Yarn berry "Done" summary line.
// Python: re.compile(r"^➤\s+YN0000:\s+·\s+Done")
export const _YARN_BERRY_DONE_RE: RegExp = /^➤\s+YN0000:\s+·\s+Done/;

// Inline regexes used by YarnFilter (Python re.search / re.match literals).
const _YARN_BERRY_DETECT_RE: RegExp = /^➤\s+YN\d{4}:/m; // re.search(..., re.MULTILINE)
const _YARN_CLASSIC_FETCH_PHASE_RE: RegExp = /^\[2\/4\]/;
const _YARN_CLASSIC_ANY_PHASE_RE: RegExp = /^\[\d\/\d\]/;
const _YARN_CLASSIC_BRACKET_RE: RegExp = /^\[/;
const _YARN_BERRY_ERR_RE: RegExp = /^➤\s+YN0001:/;

// ===========================================================================
// YarnFilter (Python lines ~11379-11493)
// ===========================================================================

/**
 * Compress `yarn install` output for both classic (v1) and berry (v2+).
 *
 * Classic: keep banner/phase headers and "Done in Xs."; collapse the [2/4]
 * fetch-phase body to a count; deduplicate warning lines (first occurrence per
 * 60-char key). Berry: keep resolution/Done/error (YN0001) lines; collapse
 * per-package fetch progress to a count. See the Python docstring for the full
 * model.
 */
export class YarnFilter extends Filter {
  override name = "yarn";
  override binaries: ReadonlySet<string> = new Set(["yarn"]);

  override matches(argv: string[]): boolean {
    if (argv.length === 0) {
      return false;
    }
    const stem = _pathStemLower(argv[0]!);
    return stem === "yarn";
  }

  override compress(stdout: string, stderr: string, _exit_code: number, _argv: string[]): string {
    const merged = this._combine_output(stdout, stderr);
    // Detect berry by presence of YN#### prefixes.
    if (_reSearch(_YARN_BERRY_DETECT_RE, merged)) {
      return this._compress_berry(merged);
    }
    return this._compress_classic(merged);
  }

  /** Compress yarn classic (v1) install output. */
  _compress_classic(text: string): string {
    const lines = text.split("\n");
    const kept: string[] = [];
    let fetch_dropped = 0;
    const warning_lines: string[] = [];
    let in_fetch_phase = false;

    for (const line of lines) {
      if (_searchErrorSignal(line)) {
        kept.push(line);
        in_fetch_phase = false;
        continue;
      }
      // Collect warning lines for deduplication below.
      if (_reMatch(_YARN_WARNING_RE, line)) {
        warning_lines.push(line);
        continue;
      }
      // Detect fetch phase start: "[2/4] Fetching packages..."
      if (_reMatch(_YARN_CLASSIC_FETCH_PHASE_RE, line)) {
        in_fetch_phase = true;
        kept.push(line);
        continue;
      }
      // Any other phase header ends the fetch phase.
      if (_reMatch(_YARN_CLASSIC_ANY_PHASE_RE, line)) {
        in_fetch_phase = false;
        kept.push(line);
        continue;
      }
      // In fetch phase: collapse individual package fetch lines.
      if (in_fetch_phase && _strip(line) && !_reMatch(_YARN_CLASSIC_BRACKET_RE, line)) {
        fetch_dropped += 1;
        continue;
      }
      kept.push(line);
    }

    // Deduplicate warning lines (key on first 60 chars) and append after body.
    let dup_warnings = 0;
    if (warning_lines.length > 0) {
      const [deduped, dups] = _dedup_lines(warning_lines, 1, {
        key_fn: (ln: string): string => ln.slice(0, 60),
      });
      dup_warnings = dups;
      kept.push(...deduped);
    }

    const notes: string[] = [];
    _maybe_note(notes, fetch_dropped, `collapsed ${fetch_dropped} individual fetch lines`);
    _maybe_note(notes, dup_warnings, `deduplicated ${dup_warnings} repeated warning lines`);
    YarnFilter._emit_notes(kept, notes);
    return Filter._finalize(kept);
  }

  /** Compress yarn berry (v2+) install output. */
  _compress_berry(text: string): string {
    const lines = text.split("\n");
    const kept: string[] = [];
    let fetch_dropped = 0;

    for (const line of lines) {
      if (_searchErrorSignal(line)) {
        kept.push(line);
        continue;
      }
      // Always keep error YN codes (YN0001) and done line.
      if (_reMatch(_YARN_BERRY_ERR_RE, line) || _reMatch(_YARN_BERRY_DONE_RE, line)) {
        kept.push(line);
        continue;
      }
      // Collapse per-package fetch progress (lines with byte counts or N/M).
      if (_reMatch(_YARN_BERRY_PROGRESS_RE, line)) {
        fetch_dropped += 1;
        continue;
      }
      kept.push(line);
    }

    const notes: string[] = [];
    _maybe_note(notes, fetch_dropped, `collapsed ${fetch_dropped} per-package fetch/progress lines`);
    YarnFilter._emit_notes(kept, notes);
    return Filter._finalize(kept);
  }
}

// ===========================================================================
// bun — BunFilter regexes (Python lines ~18100-18139).
// ===========================================================================

// bun install per-package download progress: "  foo@1.0.0 ↕ 100 kB".
// Python: re.compile(r"^\s+\S+@\S+\s+(?:↕|↑|↓|\[downloading\]|\[installed\]|\[cached\])", re.IGNORECASE)
export const _BUN_DOWNLOAD_RE: RegExp =
  /^\s+\S+@\S+\s+(?:↕|↑|↓|\[downloading\]|\[installed\]|\[cached\])/i;
// bun install lockfile / summary lines to always keep.
// Python: re.compile(r"^\s*(?:Saved\s+lockfile|No\s+changes|"
//                     r"installed|packages\s+installed|Resolving|Resolved|"
//                     r"\d+\s+package[s]?\s+(?:installed|removed|updated|added)|"
//                     r"bun\s+install\s+v)", re.IGNORECASE)
export const _BUN_INSTALL_SUMMARY_RE: RegExp =
  /^\s*(?:Saved\s+lockfile|No\s+changes|installed|packages\s+installed|Resolving|Resolved|\d+\s+package[s]?\s+(?:installed|removed|updated|added)|bun\s+install\s+v)/i;
// bun test result header per file: "bun test v1.0.0 (hash)" and timing.
// Python: re.compile(r"^bun\s+test\s+v\d|^---+\s*$|^\s*\d+\s+tests?\s+(?:passed|failed|skipped)"
//                     r"|\d+\s+(?:pass|fail|skip)", re.IGNORECASE)
export const _BUN_TEST_HEADER_RE: RegExp =
  /^bun\s+test\s+v\d|^---+\s*$|^\s*\d+\s+tests?\s+(?:passed|failed|skipped)|\d+\s+(?:pass|fail|skip)/i;
// bun test individual PASS line: " ✓ test name (N ms)".
// Python: re.compile(r"^\s*✓\s+")
export const _BUN_TEST_PASS_RE: RegExp = /^\s*✓\s+/;
// bun test individual FAIL line: " ✗ test name" (keep always).
// Python: re.compile(r"^\s*(?:✗|×|FAIL|✕)\s+", re.IGNORECASE)
export const _BUN_TEST_FAIL_RE: RegExp = /^\s*(?:✗|×|FAIL|✕)\s+/i;
// bun build asset lines: "chunk … (N kB)".
// Python: re.compile(r"^\s+(?:chunk|asset|dist/|build/|\./)\S+\s+[\d.]+\s+(?:kB|MB|B)", re.IGNORECASE)
export const _BUN_BUILD_ASSET_RE: RegExp =
  /^\s+(?:chunk|asset|dist\/|build\/|\.\/)\S+\s+[\d.]+\s+(?:kB|MB|B)/i;
// bun build summary: "[N files] (N kB)".
// Python: re.compile(r"^\s*\[\d+\]\s+\[[\d.]+\s*(?:kB|MB|B)\]"
//                     r"|^\s*\d+\s+file[s]?\s+built"
//                     r"|Done in|Build succeeded|Build failed", re.IGNORECASE)
export const _BUN_BUILD_SUMMARY_RE: RegExp =
  /^\s*\[\d+\]\s+\[[\d.]+\s*(?:kB|MB|B)\]|^\s*\d+\s+file[s]?\s+built|Done in|Build succeeded|Build failed/i;

// ===========================================================================
// BunFilter (Python lines ~18142-18294)
// ===========================================================================

/**
 * Compress `bun install` / `bun test` / `bun build` output.
 *
 * install/add/remove: drop per-package download/resolution progress; keep
 * lockfile/summary/version and error/warn lines. test: drop ✓ PASS lines, keep
 * FAIL/header/error lines (pass-through when ≤30 lines). build: collapse >10
 * asset/chunk lines per flush to a count, keep summary and error lines. Other
 * subcommands pass through (head/tail when >80 lines). See the Python docstring.
 */
export class BunFilter extends Filter {
  override name = "bun";
  override binaries: ReadonlySet<string> = new Set(["bun", "bunx"]);

  override matches(argv: string[]): boolean {
    if (argv.length === 0) {
      return false;
    }
    const stem = _pathStemLower(argv[0]!);
    return this.binaries.has(stem);
  }

  override compress(stdout: string, stderr: string, _exit_code: number, argv: string[]): string {
    const positionals = argv.slice(1).filter((tok) => !tok.startsWith("-"));
    const subcmd = positionals.length > 0 ? positionals[0]!.toLowerCase() : "";

    const merged = this._combine_output(stdout, stderr);

    if (subcmd === "install" || subcmd === "add" || subcmd === "remove" || subcmd === "i") {
      return this._compress_install(merged);
    }
    if (subcmd === "test") {
      return this._compress_test(merged);
    }
    if (subcmd === "build") {
      return this._compress_build(merged);
    }

    // Generic pass-through for bun run, bun x, etc.
    const lines = merged.split("\n");
    const non_empty = lines.filter((ln) => _strip(ln) !== "");
    if (non_empty.length <= 80) {
      return _rstrip(merged);
    }
    return _rstrip(_head_tail_compress(non_empty, 60, 20, "lines"));
  }

  _compress_install(text: string): string {
    const lines = text.split("\n");
    const kept: string[] = [];
    let progress_dropped = 0;

    for (const line of lines) {
      if (_searchErrorSignal(line)) {
        kept.push(line);
        continue;
      }
      if (_reSearch(_BUN_INSTALL_SUMMARY_RE, line)) {
        kept.push(line);
        continue;
      }
      if (_reMatch(_BUN_DOWNLOAD_RE, line)) {
        progress_dropped += 1;
        continue;
      }
      kept.push(line);
    }

    const notes: string[] = [];
    _maybe_note(notes, progress_dropped, `collapsed ${progress_dropped} per-package download/resolution lines`);
    BunFilter._emit_notes(kept, notes);
    return Filter._finalize(kept);
  }

  _compress_test(text: string): string {
    const lines = text.split("\n");
    const non_empty = lines.filter((ln) => _strip(ln) !== "");

    // Already compact — pass through.
    if (non_empty.length <= 30) {
      return _rstrip(text);
    }

    const kept: string[] = [];
    let passes_dropped = 0;

    for (const line of lines) {
      if (_searchErrorSignal(line)) {
        kept.push(line);
        continue;
      }
      if (_reMatch(_BUN_TEST_FAIL_RE, line)) {
        kept.push(line);
        continue;
      }
      if (_reMatch(_BUN_TEST_HEADER_RE, line)) {
        kept.push(line);
        continue;
      }
      if (_reMatch(_BUN_TEST_PASS_RE, line)) {
        passes_dropped += 1;
        continue;
      }
      kept.push(line);
    }

    const notes: string[] = [];
    _maybe_note(notes, passes_dropped, `collapsed ${passes_dropped} passing test lines (✓)`);
    BunFilter._emit_notes(kept, notes);
    return Filter._finalize(kept);
  }

  _compress_build(text: string): string {
    const lines = text.split("\n");
    const kept: string[] = [];
    let asset_lines: string[] = [];

    for (const line of lines) {
      if (_searchErrorSignal(line)) {
        // Flush asset buffer first.
        if (asset_lines.length > 0) {
          BunFilter._flush_assets(kept, asset_lines);
          asset_lines = [];
        }
        kept.push(line);
        continue;
      }
      if (_reSearch(_BUN_BUILD_SUMMARY_RE, line)) {
        if (asset_lines.length > 0) {
          BunFilter._flush_assets(kept, asset_lines);
          asset_lines = [];
        }
        kept.push(line);
        continue;
      }
      if (_reMatch(_BUN_BUILD_ASSET_RE, line)) {
        asset_lines.push(line);
        continue;
      }
      kept.push(line);
    }

    // Flush any trailing asset lines.
    if (asset_lines.length > 0) {
      BunFilter._flush_assets(kept, asset_lines);
    }

    return Filter._finalize(kept);
  }

  static _flush_assets(kept: string[], asset_lines: string[]): void {
    const _THRESHOLD = 10;
    if (asset_lines.length <= _THRESHOLD) {
      kept.push(...asset_lines);
    } else {
      kept.push(...asset_lines.slice(0, _THRESHOLD));
      const remaining = asset_lines.length - _THRESHOLD;
      kept.push(
        `[token-goat: ${remaining} more asset/chunk lines elided; ` +
          "run `bun build` for full output]",
      );
    }
  }
}
