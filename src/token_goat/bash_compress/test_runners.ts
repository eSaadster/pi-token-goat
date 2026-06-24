/**
 * bash_compress TEST-RUNNER FILTERS — TypeScript port of the pytest / jest /
 * vitest / webpack Filter subclasses from src/token_goat/bash_compress.py
 * (Python lines ~2261-2982, plus the shared regexes at ~2154-2218 and the
 * _trim_repeated_prefix helper at ~15685).
 *
 * The four filters subclass the concrete Filter base from ./framework.js and
 * override compress() with per-tool structural compression. They are appended to
 * the FILTERS registry (and __all__) by the barrel one level up.
 *
 * ---------------------------------------------------------------------------
 * Parity notes (Python -> TS)
 * ---------------------------------------------------------------------------
 *  - Python identifiers are preserved EXACTLY: PascalCase class names
 *    (PytestFilter, JestFilter, VitestFilter, WebpackFilter) and the snake_case
 *    module-private regex/helper names (_PYTEST_*, _JEST_*, _VITEST_*, _WEBPACK_*,
 *    _VITE_*, _trim_repeated_prefix, _invokes_vite_build).
 *  - re.compile(...) -> top-level RegExp compiled once at module load. IGNORECASE
 *    -> "i", MULTILINE -> "m". Several Python patterns set re.MULTILINE because
 *    they are used with BOTH .match(line) (per-line, anchored) AND .search(merged)
 *    (whole-text). Per-line matching here goes through _reMatch (index===0 check on
 *    a non-global clone) so the "m" flag is irrelevant for those calls; for the
 *    whole-text .search(merged) calls we keep the "m" flag so ^ matches at every
 *    line start. _reTest mirrors Python re.search / re.Pattern.search (unanchored).
 *  - Python re.Pattern.sub(repl, line, count=1) -> a single replace with a
 *    non-global clone (count=1 == first match only; the patterns are ^-anchored so
 *    there is at most one match per line anyway).
 *  - str.split(None, 1)[0] (split on runs of whitespace) -> _firstWhitespaceToken.
 *  - line.rfind("Warning") -> line.lastIndexOf("Warning"). Python slice
 *    line[colon_idx:] -> line.slice(colon_idx); .strip() -> _strip.
 *  - char.isspace() (line[0]) -> a single-char whitespace test matching Python
 *    str.isspace (space, \t, \n, \r, \f, \v).
 *  - Byte/line caps and blank-line squeezing are delegated to the framework
 *    helpers via Filter._finalize / Filter._emit_notes / _maybe_note — no helper is
 *    re-implemented here.
 *
 * NOTE on import depth: this file lives in the bash_compress/ SUBDIR; the
 * framework is a SIBLING (./framework.js) and the package-level deps go UP one
 * level (../). verbatimModuleSyntax is on -> nothing imported here is type-only.
 * noImplicitOverride is on -> every overridden member carries `override`.
 */

import {
  Filter,
  _maybe_note,
} from "./framework.js";

// ===========================================================================
// Internal Python-builtin shims local to this module.
// ===========================================================================

/** Python str.strip() — strip leading and trailing whitespace. */
function _strip(s: string): string {
  return s.replace(/^\s+/u, "").replace(/\s+$/u, "");
}

/** Python str.lstrip() — strip leading whitespace. */
function _lstrip(s: string): string {
  return s.replace(/^\s+/u, "");
}

/** True when c is a single whitespace char per Python str.isspace. */
function _isSpaceChar(c: string): boolean {
  return c === " " || c === "\t" || c === "\n" || c === "\r" || c === "\f" || c === "\v";
}

/**
 * Python str.split(None, 1)[0] — the first whitespace-delimited token, skipping
 * leading whitespace. Returns "" only for an all-whitespace/empty string.
 */
function _firstWhitespaceToken(s: string): string {
  const m = /^\s*(\S+)/.exec(s);
  return m ? m[1]! : "";
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

/** Python re.search(...) — unanchored search anywhere in the string. */
function _reTest(re: RegExp, text: string): boolean {
  return _nonGlobal(re).test(text);
}

/**
 * Python re.Pattern.match(line) returning the match object (or null), for the
 * filters that read capture groups. Non-global clone so lastIndex never leaks.
 */
function _reMatchObj(re: RegExp, line: string): RegExpExecArray | null {
  const r = _nonGlobal(re);
  const m = r.exec(line);
  return m !== null && m.index === 0 ? m : null;
}

/**
 * Python re.Pattern.sub(repl, line, count=1) for a ^-anchored pattern — replace
 * only the first match. The clone strips the global/sticky flags.
 */
function _reSubOnce(re: RegExp, line: string, repl: string): string {
  return line.replace(_nonGlobal(re), repl);
}

/** Return a clone of re without the global/sticky flags (one-shot .exec/.test). */
function _nonGlobal(re: RegExp): RegExp {
  const flags = re.flags.replace(/[gy]/g, "");
  return new RegExp(re.source, flags);
}

// ===========================================================================
// pytest regexes (Python lines ~2154-2215) + _trim_repeated_prefix (~15685).
// ===========================================================================

// Python: re.compile(r"^[\.FxXEsS]+\s*(\[\s*\d+%\])?\s*$")
const _PYTEST_DOTS_RE: RegExp = /^[.FxXEsS]+\s*(\[\s*\d+%\])?\s*$/;
// Python: re.compile(r"^=+\s*(?:test session starts|FAILURES|ERRORS|short test summary info|"
//                     r"warnings summary|slowest \d+ durations|\d+ failed|\d+ passed|\d+ error)\b")
const _PYTEST_HEADER_RE: RegExp =
  /^=+\s*(?:test session starts|FAILURES|ERRORS|short test summary info|warnings summary|slowest \d+ durations|\d+ failed|\d+ passed|\d+ error)\b/;
// Python: re.compile(r"^(FAILED|ERROR|PASSED|SKIPPED|XFAIL|XPASS)\s+\S")
const _PYTEST_FAIL_LINE_RE: RegExp = /^(FAILED|ERROR|PASSED|SKIPPED|XFAIL|XPASS)\s+\S/;
// Python: re.compile(r"^collected \d+ items?")
const _PYTEST_COLLECT_RE: RegExp = /^collected \d+ items?/;
// Python: re.compile(r"^(?:platform\s|cachedir:\s|rootdir:\s|plugins:\s|configfile:\s|"
//                     r"bringing up\s|cacheprovider-)")
const _PYTEST_BANNER_RE: RegExp =
  /^(?:platform\s|cachedir:\s|rootdir:\s|plugins:\s|configfile:\s|bringing up\s|cacheprovider-)/;
// Python: re.compile(r"^\[gw\d+\]\s*(?:\[\s*\d+%\]\s*)?")
const _PYTEST_XDIST_PREFIX_RE: RegExp = /^\[gw\d+\]\s*(?:\[\s*\d+%\]\s*)?/;
// Python: re.compile(r"^(?:Name\s+Stmts|[-]+\s*$|TOTAL\s+\d|.+\s+\d+\s+\d+\s+\d+\s+\d+%\s*$)")
const _PYTEST_COV_TABLE_RE: RegExp =
  /^(?:Name\s+Stmts|[-]+\s*$|TOTAL\s+\d|.+\s+\d+\s+\d+\s+\d+\s+\d+%\s*$)/;
// Python: re.compile(r"^TOTAL\s+\d")
const _PYTEST_COV_TOTAL_RE: RegExp = /^TOTAL\s+\d/;
// Python: re.compile(r"^\d+\.\d+s\s+(?:call|setup|teardown)\s+\S")
const _PYTEST_SLOW_DURATION_RE: RegExp = /^\d+\.\d+s\s+(?:call|setup|teardown)\s+\S/;
// Python: re.compile(r"^collecting\s")
const _PYTEST_PREAMBLE_RE: RegExp = /^collecting\s/;
// Python: re.compile(r"^\s*--\s+Docs:\s+https?://")
const _PYTEST_WARN_DOCS_RE: RegExp = /^\s*--\s+Docs:\s+https?:\/\//;
// Python: re.compile(r"^\s+\S.*:\d+:\s+\S.*Warning\b")
const _PYTEST_WARN_MSG_RE: RegExp = /^\s+\S.*:\d+:\s+\S.*Warning\b/;
// Python: re.compile(r"^\S.+::\S+[ \t]+(PASSED|FAILED|ERROR|SKIPPED|XFAIL|XPASS)(?:[ \t]|\Z)")
// Python \Z (end of string) -> JS $ on a non-multiline pattern (no "m" flag) so
// $ anchors only at the absolute end, matching \Z for these per-line matches.
const _PYTEST_VERBOSE_LINE_RE: RegExp =
  /^\S.+::\S+[ \t]+(PASSED|FAILED|ERROR|SKIPPED|XFAIL|XPASS)(?:[ \t]|$)/;
// Python: re.compile(r"^[-=]+\s*$") — used inline in the cov-table branch.
const _PYTEST_COV_SEP_RE: RegExp = /^[-=]+\s*$/;
// Python: re.compile(r"^\S.*\s+\d+\s+\d+\s+\d+%?\s*$") — per-file cov row.
const _PYTEST_COV_ROW_RE: RegExp = /^\S.*\s+\d+\s+\d+\s+\d+%?\s*$/;

// Reference the cov-table regex so the (intentionally-ported-for-parity)
// constant is not flagged as unused; the active table detection uses inline
// startsWith/includes checks exactly as the Python compress does.
void _PYTEST_COV_TABLE_RE;

/**
 * Keep only the first *keep* lines matching *pattern*; drop the rest.
 *
 * Used to deduplicate spammy headers (pytest "collected N items") where the
 * count is more useful than the list. Port of Python's _trim_repeated_prefix.
 * The dropped-count marker echoes Python's `{pattern.pattern!r}` — the repr of
 * the regex SOURCE, single-quoted (Python's repr of a str). The TS port emits
 * the RegExp.source wrapped in single quotes to match Python's repr of the
 * pattern string.
 */
function _trim_repeated_prefix(
  lines: string[],
  pattern: RegExp,
  opts: { keep: number },
): string[] {
  const { keep } = opts;
  const out: string[] = [];
  let matched = 0;
  let dropped = 0;
  for (const line of lines) {
    if (_reMatch(pattern, line)) {
      matched += 1;
      if (matched <= keep) {
        out.push(line);
      } else {
        dropped += 1;
      }
    } else {
      out.push(line);
    }
  }
  if (dropped) {
    out.push(`[token-goat: +${dropped} more lines matching '${pattern.source}']`);
  }
  return out;
}

// ===========================================================================
// PytestFilter (Python lines ~2261-2477)
// ===========================================================================

/**
 * Compress pytest output: keep failures + summary, drop pass progress.
 *
 * See the Python docstring for the full compression model (header kept, FAILED /
 * ERROR / short-test-summary blocks kept verbatim, pass-progress dots dropped,
 * xdist worker prefix stripped, pytest-cov table collapsed to TOTAL, slowest-N
 * durations trimmed to 5, warnings-summary deduplicated, docs footers dropped).
 */
export class PytestFilter extends Filter {
  override name = "pytest";
  override binaries: ReadonlySet<string> = new Set(["pytest", "py.test"]);

  override compress(stdout: string, stderr: string, _exit_code: number, _argv: string[]): string {
    const text = this._combine_output(stdout, stderr);
    const lines = text.split("\n");
    let kept: string[] = [];
    let passed_count = 0;
    let in_failures = false;
    let in_errors = false;
    let in_slow_section = false;
    let in_warnings_section = false;
    let slow_kept = 0;
    let slow_dropped = 0;
    let in_cov_table = false;
    let cov_table_rows_dropped = 0;
    // Warnings deduplication: map normalised warning message -> count seen.
    const warn_msg_seen = new Map<string, number>();
    let warnings_dropped = 0;

    for (let line of lines) {
      // Strip pytest-xdist worker prefix ([gw0], [gw1], ...).
      if (_reMatch(_PYTEST_XDIST_PREFIX_RE, line)) {
        line = _reSubOnce(_PYTEST_XDIST_PREFIX_RE, line, "");
      }

      // Drop the dots/percent progress line entirely.
      if (_reMatch(_PYTEST_DOTS_RE, line)) {
        continue;
      }
      // Drop constant banner lines.
      if (_reMatch(_PYTEST_BANNER_RE, line)) {
        continue;
      }
      // Drop "collecting ..." preamble lines before the session starts.
      if (_reMatch(_PYTEST_PREAMBLE_RE, line)) {
        continue;
      }
      // Section transitions, re-evaluate which block we're in.
      if (_reMatch(_PYTEST_HEADER_RE, line)) {
        in_failures = line.includes("FAILURES");
        in_errors = line.includes("ERRORS") || line.includes("short test summary");
        in_slow_section = line.includes("slowest") && line.includes("durations");
        in_warnings_section = line.includes("warnings summary");
        in_cov_table = false;
        // Drop the constant "= test session starts =" header.
        if (line.includes("test session starts")) {
          continue;
        }
        kept.push(line);
        continue;
      }

      // --- pytest-cov coverage table ---
      if (line.startsWith("Name") && line.includes("Stmts") && line.includes("Miss")) {
        in_cov_table = true;
        kept.push(line);
        continue;
      }
      if (in_cov_table) {
        if (_reMatch(_PYTEST_COV_TOTAL_RE, line)) {
          if (cov_table_rows_dropped) {
            kept.push(
              `[token-goat: collapsed ${cov_table_rows_dropped} coverage table rows]`,
            );
            cov_table_rows_dropped = 0;
          }
          kept.push(line);
          in_cov_table = false;
          continue;
        }
        // Separator lines (--- or ===): keep
        if (_reMatch(_PYTEST_COV_SEP_RE, line)) {
          kept.push(line);
          continue;
        }
        // Per-file coverage row: drop (covered by TOTAL)
        if (_reMatch(_PYTEST_COV_ROW_RE, line)) {
          cov_table_rows_dropped += 1;
          continue;
        }
        // Anything else exits the table context
        in_cov_table = false;
      }

      // --- warnings summary section ---
      if (in_warnings_section) {
        // Docs-reference line: always drop.
        if (_reMatch(_PYTEST_WARN_DOCS_RE, line)) {
          warnings_dropped += 1;
          continue;
        }
        // Warning message line: deduplicate by normalised message text.
        if (_reMatch(_PYTEST_WARN_MSG_RE, line)) {
          const colon_idx = line.lastIndexOf("Warning");
          const norm_key = colon_idx >= 0 ? _strip(line.slice(colon_idx)) : _strip(line);
          const count = warn_msg_seen.get(norm_key) ?? 0;
          warn_msg_seen.set(norm_key, count + 1);
          if (count === 0) {
            kept.push(line);
          } else {
            warnings_dropped += 1;
          }
          continue;
        }
        // Everything else in the warnings section is kept verbatim (fall through).
      }

      // --- slowest durations section ---
      if (in_slow_section) {
        if (_reMatch(_PYTEST_SLOW_DURATION_RE, line)) {
          if (slow_kept < 5) {
            kept.push(line);
            slow_kept += 1;
          } else {
            slow_dropped += 1;
          }
          continue;
        }
        // Blank line or new section header exits the slow section.
        if (!_strip(line) || _reMatch(_PYTEST_HEADER_RE, line)) {
          if (slow_dropped) {
            kept.push(
              `[token-goat: collapsed ${slow_dropped} slow-test duration lines]`,
            );
            slow_dropped = 0;
          }
          in_slow_section = false;
          if (!_strip(line)) {
            continue; // drop blank — it's padding
          }
          // Fall through to process the new header line.
          if (_reMatch(_PYTEST_HEADER_RE, line)) {
            in_failures = line.includes("FAILURES");
            in_errors = line.includes("ERRORS") || line.includes("short test summary");
            in_warnings_section = line.includes("warnings summary");
            kept.push(line);
            continue;
          }
        } else {
          // Non-duration line inside slow section — keep as context.
          kept.push(line);
          continue;
        }
      }

      // PASSED entries: count, do not keep (only when not inside a fail/error block).
      if (!in_failures && !in_errors && _reMatch(_PYTEST_FAIL_LINE_RE, line)) {
        const tag = _firstWhitespaceToken(line);
        if (tag === "PASSED") {
          passed_count += 1;
          continue;
        }
        kept.push(line);
        continue;
      }
      // Verbose-mode progress lines: status AFTER the node ID.
      if (!in_failures && !in_errors) {
        const m = _reMatchObj(_PYTEST_VERBOSE_LINE_RE, line);
        if (m) {
          if (m[1] === "PASSED") {
            passed_count += 1;
            continue;
          }
          kept.push(line);
          continue;
        }
      }
      kept.push(line);
    }
    // Flush any trailing slow-section counter.
    if (slow_dropped) {
      kept.push(`[token-goat: collapsed ${slow_dropped} slow-test duration lines]`);
    }
    // Flush any trailing coverage table counter.
    if (cov_table_rows_dropped) {
      kept.push(`[token-goat: collapsed ${cov_table_rows_dropped} coverage table rows]`);
    }
    // Trim collected-files spam to first three.
    kept = _trim_repeated_prefix(kept, _PYTEST_COLLECT_RE, { keep: 3 });
    if (passed_count) {
      kept.push(`[token-goat: collapsed ${passed_count} PASSED lines]`);
    }
    if (warnings_dropped) {
      kept.push(`[token-goat: collapsed ${warnings_dropped} duplicate/docs warning lines]`);
    }
    // Drop runs of consecutive blank lines.
    return Filter._finalize(kept);
  }
}

// ===========================================================================
// Jest / Vitest / Mocha regexes (Python lines ~2482-2515)
// ===========================================================================

// File-level PASS header: `PASS  src/foo.test.js` OR a bare ✓/√ file header at
// column 0. Per-test ticks are indented and handled separately.
// Python: re.compile(r"^(?:\s*PASS\s+\S|[✓√]\s+\S)")
const _JEST_PASS_LINE_RE: RegExp = /^(?:\s*PASS\s+\S|[✓√]\s+\S)/;
// Python: re.compile(r"^\s*(?:FAIL|✗|×|✘)\s+\S")
const _JEST_FAIL_LINE_RE: RegExp = /^\s*(?:FAIL|✗|×|✘)\s+\S/;
// Python: re.compile(r"^(Test Suites|Tests|Snapshots|Time|Ran all test suites):")
const _JEST_SUMMARY_RE: RegExp = /^(Test Suites|Tests|Snapshots|Time|Ran all test suites):/;
// Python: re.compile(r"^\s*console\.(log|error|warn|info|debug)\s")
const _JEST_CONSOLE_HDR_RE: RegExp = /^\s*console\.(log|error|warn|info|debug)\s/;
// Python: re.compile(r"^\s+at\s+\S")
const _JEST_CONSOLE_AT_RE: RegExp = /^\s+at\s+\S/;
// Python: re.compile(r"^(\s*Failures:\s*$|  ● )")
const _JEST_FAILURES_SECTION_RE: RegExp = /^(\s*Failures:\s*$|  ● )/;
// Python: re.compile(r"^  ● ")
const _JEST_FAILURE_BULLET_RE: RegExp = /^  ● /;

// _JEST_CONSOLE_AT_RE / _JEST_FAILURES_SECTION_RE / _JEST_FAILURE_BULLET_RE are
// ported for parity (Python defines them as module constants) but the active
// compress logic uses the inline `line.strip() == "Failures:"` check and the
// _JEST_SUMMARY_RE boundary, mirroring the Python source verbatim. Reference
// them so they are not flagged unused.
void _JEST_CONSOLE_AT_RE;
void _JEST_FAILURES_SECTION_RE;
void _JEST_FAILURE_BULLET_RE;

// ===========================================================================
// JestFilter (Python lines ~2518-2645)
// ===========================================================================

/**
 * Compress Jest / Mocha / Ava / Tap output.
 *
 * Drops PASS file headers (collapse to count), keeps FAIL blocks verbatim, keeps
 * the final summary lines, collapses passing ticks and console.* blocks, and
 * drops the duplicate "Failures:" repeated-summary section emitted under
 * --verbose. See the Python docstring for the full model.
 */
export class JestFilter extends Filter {
  override name = "jest";
  override binaries: ReadonlySet<string> = new Set(["jest", "mocha", "ava", "tap"]);

  override compress(stdout: string, stderr: string, _exit_code: number, _argv: string[]): string {
    // Jest writes summaries to stderr by default.
    const merged = this._combine_output(stdout, stderr);
    const lines = merged.split("\n");
    const kept: string[] = [];
    let pass_count = 0;
    let tick_count = 0;
    let in_fail_block = false;
    let console_lines = 0; // lines accumulated in a console.* block
    let in_console_block = false;
    // Track the "Failures:" repeated-summary section at the end of --verbose output.
    let in_failures_section = false;
    let failures_section_dropped = 0;

    const _flush_console = (): void => {
      if (console_lines) {
        kept.push(
          `  [token-goat: collapsed ${console_lines} console output line${console_lines !== 1 ? "s" : ""}]`,
        );
      }
      console_lines = 0;
      in_console_block = false;
    };

    for (const line of lines) {
      // --- "Failures:" repeated-summary section ---
      if (_strip(line) === "Failures:") {
        _flush_console();
        in_fail_block = false;
        in_failures_section = true;
        failures_section_dropped += 1; // count the "Failures:" header itself
        continue;
      }
      if (in_failures_section) {
        if (_reMatch(_JEST_SUMMARY_RE, line)) {
          // Summary block: exit failures section and keep from here on.
          in_failures_section = false;
          kept.push(line);
        } else {
          failures_section_dropped += 1;
        }
        continue;
      }

      // --- PASS file header ---
      if (_reMatch(_JEST_PASS_LINE_RE, line) && !in_fail_block) {
        _flush_console();
        pass_count += 1;
        continue;
      }
      // --- FAIL file header ---
      if (_reMatch(_JEST_FAIL_LINE_RE, line)) {
        _flush_console();
        in_fail_block = true;
        kept.push(line);
        continue;
      }
      // Blank line ends a fail block.
      if (!_strip(line) && in_fail_block) {
        in_fail_block = false;
        kept.push(line);
        continue;
      }
      // Inside a FAIL block: pass everything through verbatim.
      if (in_fail_block) {
        kept.push(line);
        continue;
      }
      // --- console.* block handling (outside FAIL block only) ---
      if (_reMatch(_JEST_CONSOLE_HDR_RE, line)) {
        _flush_console();
        in_console_block = true;
        console_lines = 1; // count the header line itself
        continue;
      }
      if (in_console_block) {
        const stripped = _strip(line);
        // Empty line or a non-indented line ends the console block.
        if (!stripped || (line.length > 0 && !_isSpaceChar(line[0]!))) {
          _flush_console();
          // Fall through to handle this line normally.
        } else {
          console_lines += 1;
          continue;
        }
      }
      // --- per-test passing tick (✓ / √) ---
      const stripped = _lstrip(line);
      if (stripped.startsWith("✓") || stripped.startsWith("√")) {
        tick_count += 1;
        continue;
      }
      kept.push(line);
    }

    _flush_console();
    const notes: string[] = [];
    _maybe_note(notes, pass_count, `collapsed ${pass_count} PASS file${pass_count !== 1 ? "s" : ""}`);
    _maybe_note(notes, tick_count, `collapsed ${tick_count} passing tick${tick_count !== 1 ? "s" : ""}`);
    if (failures_section_dropped) {
      notes.push(
        `collapsed ${failures_section_dropped} line${failures_section_dropped !== 1 ? "s" : ""} ` +
          `from duplicate 'Failures:' section (already shown inline)`,
      );
    }
    JestFilter._emit_notes(kept, notes);
    return Filter._finalize(kept);
  }
}

// ===========================================================================
// Vitest regexes (Python lines ~2650-2666)
// ===========================================================================

// Python: re.compile(r"^\s*✓\s+\S.*\([\d.]+\s*\w+\)")
const _VITEST_FILE_PASS_RE: RegExp = /^\s*✓\s+\S.*\([\d.]+\s*\w+\)/;
// Python: re.compile(r"^\s*(?:×|FAIL|✗|✘)\s+\S")
const _VITEST_FILE_FAIL_RE: RegExp = /^\s*(?:×|FAIL|✗|✘)\s+\S/;
// Python: re.compile(r"^(Test Files|Tests|Modules|Duration|Start at)[\s:]+\d")
const _VITEST_SUMMARY_RE: RegExp = /^(Test Files|Tests|Modules|Duration|Start at)[\s:]+\d/;
// Python: re.compile(r"^\s{2,}✓\s")
const _VITEST_TEST_PASS_RE: RegExp = /^\s{2,}✓\s/;
// Python: re.compile(r"^\s*stdout\s*\|")
const _VITEST_STDOUT_HDR_RE: RegExp = /^\s*stdout\s*\|/;

// ===========================================================================
// VitestFilter (Python lines ~2669-2769)
// ===========================================================================

/**
 * Compress Vitest output.
 *
 * Drops file-level ✓ pass lines (collapse to count), keeps ×/FAIL blocks
 * verbatim, collapses indented per-test ✓ pass lines, keeps the Test Files /
 * Tests / Duration summary, and collapses stdout blocks. See the Python
 * docstring for the full model.
 */
export class VitestFilter extends Filter {
  override name = "vitest";
  override binaries: ReadonlySet<string> = new Set(["vitest"]);

  override compress(stdout: string, stderr: string, _exit_code: number, _argv: string[]): string {
    const merged = this._combine_output(stdout, stderr);
    const lines = merged.split("\n");
    const kept: string[] = [];
    let pass_file_count = 0;
    let pass_tick_count = 0;
    let in_fail_block = false;
    let stdout_lines = 0;
    let in_stdout_block = false;

    const _flush_stdout = (): void => {
      if (stdout_lines) {
        kept.push(
          `  [token-goat: collapsed ${stdout_lines} stdout line${stdout_lines !== 1 ? "s" : ""}]`,
        );
      }
      stdout_lines = 0;
      in_stdout_block = false;
    };

    for (const line of lines) {
      // File-level PASS header.
      if (_reMatch(_VITEST_FILE_PASS_RE, line) && !in_fail_block) {
        _flush_stdout();
        pass_file_count += 1;
        continue;
      }
      // File-level FAIL header.
      if (_reMatch(_VITEST_FILE_FAIL_RE, line)) {
        _flush_stdout();
        in_fail_block = true;
        kept.push(line);
        continue;
      }
      // Summary lines always kept.
      if (_reMatch(_VITEST_SUMMARY_RE, line)) {
        _flush_stdout();
        kept.push(line);
        continue;
      }
      // Blank line ends a fail block.
      if (!_strip(line) && in_fail_block) {
        in_fail_block = false;
        kept.push(line);
        continue;
      }
      // Inside a FAIL block: pass everything verbatim.
      if (in_fail_block) {
        kept.push(line);
        continue;
      }
      // stdout block handling.
      if (_reMatch(_VITEST_STDOUT_HDR_RE, line)) {
        _flush_stdout();
        in_stdout_block = true;
        stdout_lines = 1;
        continue;
      }
      if (in_stdout_block) {
        const stripped = _strip(line);
        if (!stripped || (line.length > 0 && !_isSpaceChar(line[0]!))) {
          _flush_stdout();
          // Fall through.
        } else {
          stdout_lines += 1;
          continue;
        }
      }
      // Per-test passing tick (indented ✓).
      if (_reMatch(_VITEST_TEST_PASS_RE, line)) {
        pass_tick_count += 1;
        continue;
      }
      kept.push(line);
    }

    _flush_stdout();
    const notes: string[] = [];
    if (pass_file_count) {
      notes.push(`collapsed ${pass_file_count} passing file${pass_file_count !== 1 ? "s" : ""}`);
    }
    if (pass_tick_count) {
      notes.push(`collapsed ${pass_tick_count} passing tick${pass_tick_count !== 1 ? "s" : ""}`);
    }
    VitestFilter._emit_notes(kept, notes);
    return Filter._finalize(kept);
  }
}

// ===========================================================================
// Webpack / Vite build / esbuild regexes (Python lines ~2774-2810)
// ===========================================================================

// Python: re.compile(r"^\s+\./node_modules/")
const _WEBPACK_MODULE_LINE_RE: RegExp = /^\s+\.\/node_modules\//;
// Python: re.compile(r"^\s*modules by path \./node_modules/", re.MULTILINE)
const _WEBPACK_MOD_PATH_NODMOD_RE: RegExp = /^\s*modules by path \.\/node_modules\//m;
// Python: re.compile(r"^\s+\+ \d+ modules?\s*$")
const _WEBPACK_PLUS_MODULES_RE: RegExp = /^\s+\+ \d+ modules?\s*$/;
// Python: re.compile(r"^\s*runtime modules\s")
const _WEBPACK_RUNTIME_RE: RegExp = /^\s*runtime modules\s/;
// Python: re.compile(r"^webpack\s+\d[\d.]+\s+compiled", re.MULTILINE)
const _WEBPACK_SUMMARY_RE: RegExp = /^webpack\s+\d[\d.]+\s+compiled/m;
// Python: re.compile(r"^\s*transforming\s*\(\d+\)|^\s*rendering chunks?\s*\(\d+\)"
//                     r"|^\s*computing gzip size\s*\(\d+\)", re.MULTILINE)
const _VITE_PROGRESS_RE: RegExp =
  /^\s*transforming\s*\(\d+\)|^\s*rendering chunks?\s*\(\d+\)|^\s*computing gzip size\s*\(\d+\)/m;
// Python: re.compile(r"^vite\s+v[\d.]+", re.MULTILINE)
const _VITE_HEADER_RE: RegExp = /^vite\s+v[\d.]+/m;
// Python: re.compile(r"^[✓√]\s+(?:built in|\d+\s+modules\s+transformed)", re.MULTILINE)
const _VITE_DONE_RE: RegExp = /^[✓√]\s+(?:built in|\d+\s+modules\s+transformed)/m;

/**
 * Return True when the args following the vite binary select the build
 * subcommand. Vite serves multiple roles (dev server, preview, build); this
 * predicate restricts interception to `vite build`.
 */
function _invokes_vite_build(args_after_vite: string[]): boolean {
  const positionals = _positional_args(args_after_vite);
  return positionals.length > 0 && positionals[0] === "build";
}

/**
 * Return positional arguments (skipping -x and --xyz flags). Local copy of the
 * framework's _positional_args semantics; mirrors Python's module-level
 * _positional_args used by _invokes_vite_build.
 */
function _positional_args(args: string[]): string[] {
  return args.filter((a) => !a.startsWith("-"));
}

// ===========================================================================
// WebpackFilter (Python lines ~2824-2982)
// ===========================================================================

/**
 * Compress webpack / esbuild / `vite build` output.
 *
 * Drops node_modules per-module entries, the modules-by-path section headers,
 * `+ N modules` continuation lines, and runtime-module metadata for webpack;
 * drops vite transform/render/gzip progress lines; passes esbuild through
 * unchanged. See the Python docstring for the full model.
 */
export class WebpackFilter extends Filter {
  override name = "webpack";
  override binaries: ReadonlySet<string> = new Set(["webpack", "webpack-cli", "vite", "esbuild"]);

  override matches(argv: string[]): boolean {
    if (argv.length === 0) {
      return false;
    }

    const _base = (s: string): string => {
      let b = s.replace(/\\/g, "/").split("/").pop()!.toLowerCase();
      for (const ext of [".exe", ".cmd"]) {
        if (b.endsWith(ext)) {
          b = b.slice(0, b.length - ext.length);
          break;
        }
      }
      return b;
    };

    const b0 = _base(argv[0]!);

    // Direct invocations
    if (b0 === "webpack" || b0 === "webpack-cli" || b0 === "esbuild") {
      return true;
    }
    if (b0 === "vite") {
      return _invokes_vite_build(argv.slice(1));
    }

    // npx / pnpx / bunx wrapper: scan past leading flags to find the tool name.
    if (b0 === "npx" || b0 === "pnpx" || b0 === "bunx") {
      let i = 1;
      // skip flag-like tokens (--yes, --package foo, -y …)
      while (i < argv.length) {
        const tok = argv[i]!;
        if (!tok.startsWith("-")) {
          break;
        }
        // flags that consume the next token as value
        if (tok === "--package" || tok === "-p") {
          i += 2;
        } else {
          i += 1;
        }
      }
      if (i >= argv.length) {
        return false;
      }
      const b1 = _base(argv[i]!);
      if (b1 === "webpack" || b1 === "webpack-cli" || b1 === "esbuild") {
        return true;
      }
      if (b1 === "vite") {
        return _invokes_vite_build(argv.slice(i + 1));
      }
    }

    return false;
  }

  override compress(stdout: string, stderr: string, _exit_code: number, _argv: string[]): string {
    const merged = this._combine_output(stdout, stderr);
    // Detect which tool's output we have.
    if (_reTest(_VITE_HEADER_RE, merged) || _reTest(_VITE_DONE_RE, merged)) {
      return this._compress_vite(merged);
    }
    if (_reTest(_WEBPACK_SUMMARY_RE, merged) || _reTest(_WEBPACK_MOD_PATH_NODMOD_RE, merged)) {
      return this._compress_webpack(merged);
    }
    // esbuild / unrecognised: pass through unchanged.
    return merged;
  }

  // ------------------------------------------------------------------
  // Tool-specific helpers
  // ------------------------------------------------------------------

  /** Drop vite build progress lines; keep asset table and summary. */
  _compress_vite(text: string): string {
    const lines = text.split("\n");
    const kept: string[] = [];
    let progress_dropped = 0;
    for (const line of lines) {
      if (_reMatch(_VITE_PROGRESS_RE, line)) {
        progress_dropped += 1;
      } else {
        kept.push(line);
      }
    }
    const notes: string[] = [];
    if (progress_dropped) {
      notes.push(
        `dropped ${progress_dropped} transform/render progress line${progress_dropped !== 1 ? "s" : ""}`,
      );
    }
    WebpackFilter._emit_notes(kept, notes);
    return Filter._finalize(kept);
  }

  /** Drop node_modules module entries; keep assets, app modules, errors. */
  _compress_webpack(text: string): string {
    const lines = text.split("\n");
    const kept: string[] = [];
    let nodmod_lines = 0;
    let plus_mod_lines = 0;
    let runtime_lines = 0;
    let in_nodmod_section = false;
    for (const line of lines) {
      // "modules by path ./node_modules/..." — suppress this section header.
      if (_reMatch(_WEBPACK_MOD_PATH_NODMOD_RE, line)) {
        nodmod_lines += 1;
        in_nodmod_section = true;
        continue;
      }
      // "modules by path ./src/..." — end node_modules section; keep.
      if (line.startsWith("modules by path ") && !line.includes("node_modules")) {
        in_nodmod_section = false;
        kept.push(line);
        continue;
      }
      // Individual node_modules module entries (indented).
      if (_reMatch(_WEBPACK_MODULE_LINE_RE, line) && !line.toLowerCase().includes("error")) {
        nodmod_lines += 1;
        continue;
      }
      // "+ N modules" continuation lines.
      if (_reMatch(_WEBPACK_PLUS_MODULES_RE, line)) {
        plus_mod_lines += 1;
        continue;
      }
      // "runtime modules N bytes N modules".
      if (_reMatch(_WEBPACK_RUNTIME_RE, line)) {
        runtime_lines += 1;
        continue;
      }
      // Inside a node_modules section: suppress indented sub-entries.
      if (in_nodmod_section && line.startsWith("  ") && !line.toLowerCase().includes("error")) {
        nodmod_lines += 1;
        continue;
      }
      // Any non-blank, non-indented line ends the node_modules section.
      if (line && !line.startsWith(" ")) {
        in_nodmod_section = false;
      }
      kept.push(line);
    }
    const notes: string[] = [];
    const total_dropped = nodmod_lines + plus_mod_lines + runtime_lines;
    if (nodmod_lines) {
      notes.push(`dropped ${nodmod_lines} node_modules module line${nodmod_lines !== 1 ? "s" : ""}`);
    }
    if (plus_mod_lines) {
      notes.push(`dropped ${plus_mod_lines} '+ N modules' line${plus_mod_lines !== 1 ? "s" : ""}`);
    }
    if (runtime_lines) {
      notes.push(`dropped ${runtime_lines} runtime-module metadata line${runtime_lines !== 1 ? "s" : ""}`);
    }
    if (total_dropped) {
      WebpackFilter._emit_notes(kept, notes);
    }
    return Filter._finalize(kept);
  }
}
