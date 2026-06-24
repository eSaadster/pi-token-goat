/**
 * bash_compress SECURITY-SCANNER FILTERS — TypeScript port of the BanditFilter,
 * TrivyFilter, SnykFilter, and SemgrepFilter Filter subclasses from
 * src/token_goat/bash_compress.py (plus the module-level bandit / trivy / snyk /
 * semgrep regexes and their private _compress_* helpers, where present).
 *
 * Four filters subclass the concrete Filter base from ./framework.js and override
 * compress() with bespoke structural compression. They are appended to the
 * FILTERS registry (and __all__) by the barrel one level up — this module does
 * NOT wire the barrel.
 *
 * These filters have NO dedicated test files; they are validated only by the
 * dispatch test (matches() / detect_from_command() routing). Ported with extra
 * care for the compress parity because each one is a non-trivial state machine
 * lifted straight from the Python source:
 *  - BanditFilter — bandit Python security-scan: walk issue blocks, keep
 *    HIGH/MEDIUM verbatim, collapse LOW to a running count. Stats block and
 *    per-file "testing <file>" progress are special-cased.
 *  - TrivyFilter — trivy container/filesystem vulnerability scan: drop INFO/
 *    WARN/DEBUG log lines from stderr, keep CRITICAL/HIGH table rows, collapse
 *    MEDIUM/LOW/UNKNOWN rows to per-library counts (table column positions are
 *    parsed dynamically from the header row).
 *  - SnykFilter — snyk dependency scan: keep the first "Testing <pkg>" line,
 *    collapse deep box-drawing dependency-tree lines after the first 10, keep
 *    vuln block headers + summaries, collapse "More about this vulnerability:"
 *    / bare-URL blocks to a count.
 *  - SemgrepFilter — semgrep static analysis: keep the first "Scanning N files"
 *    banner, keep the first 3 match blocks per rule (stripping Details:/annotation
 *    URL lines), collapse further matches of the same rule to a count, keep the
 *    final "Ran N rules on N files" summary.
 *
 * ---------------------------------------------------------------------------
 * Parity notes (Python -> TS)
 * ---------------------------------------------------------------------------
 *  - Python identifiers preserved EXACTLY: PascalCase class names and the
 *    snake_case module-private regex constants (_BANDIT_*, _TRIVY_*, _SNYK_*,
 *    _SEMGREP_*); instance field _MAX_PER_RULE on SemgrepFilter; instance field
 *    _HIGH_SEPS on TrivyFilter. No _compress_* helper methods exist on these
 *    classes in the Python source (each compress() is monolithic), so none are
 *    introduced here.
 *  - re.compile(...) -> top-level RegExp compiled once at module load.
 *    re.IGNORECASE -> the "i" flag; the few re.compile(...) patterns without
 *    IGNORECASE become flagless RegExps.
 *  - Python re.Pattern.match(line) is START-anchored (NOT end-anchored); emulated
 *    via _reMatch (non-global clone + index===0). .search() -> _reSearch
 *    (non-global clone, .exec/.test anywhere). The handful of inline
 *    re.search(...) / re.match(...) calls (bandit Severity extraction; semgrep
 *    rule-id detection) are handled with local one-shot RegExps via _reSearchObj
 *    / _reMatch.
 *  - _ERROR_SIGNAL_RE is framework-PRIVATE (not exported by framework.ts); it is
 *    re-declared MODULE-PRIVATE here (NOT exported) to avoid a duplicate-export
 *    ambiguity (TS2308) across the barrel export * chain. (None of these four
 *    filters actually consult it, but the copy is kept for parity with the other
 *    filter modules and in case a future helper wants it.)
 *  - Python dict-of-dict (TrivyFilter low_med_counts: lib -> {sev: count}) ->
 *    Map<string, Map<string, number>>. sorted(dict.items()) (lib sort, then sev
 *    sort) -> [...low_med_counts.entries()].sort() on the lib key, then
 *    [...sev_counts.entries()].sort() on the sev key (lexicographic, the JS
 *    default, matching Python's str sort for the ASCII tokens here).
 *  - Python nonlocal counters mutated inside a nested flush closure
 *    (BanditFilter.flush_issue -> low_dropped; SemgrepFilter.flush_block ->
 *    details_dropped; TrivyFilter._parse_table_cols -> sev_col_idx/lib_col_idx)
 *    -> the TS closures capture the same locals by reference (let / mutable
 *    array) — no class-field promotion needed.
 *  - Python `line.strip().startswith("--")` -> line.trim().startsWith("--").
 *    `line.strip() == ""` -> line.trim() === "". `line[0].isspace()` ->
 *    /\s/.test(line.charAt(0)).
 *  - TrivyFilter calls _finalize(kept) BEFORE _emit_notes(kept, notes) — the
 *    notes are appended to the SAME kept array (by reference) after _finalize
 *    has already produced its squeezed string, so out_text is rebuilt from the
 *    note-augmented kept only via the subsequent clean_err join. To preserve
 *    this exact ordering we (a) compute out_text = Filter._finalize(kept), (b)
 *    THEN call Filter._emit_notes(kept, notes) which pushes onto kept, and (c)
 *    if clean_err is present, append clean_err to the ALREADY-finalised
 *    out_text (NOT a re-finalise) — matching Python, where _emit_notes mutates
 *    kept but out_text was already captured and clean_err is just concatenated.
 *  - Module-global mutable state: NONE. Every counter/dict/list is a local
 *    inside compress(); no registerReset seam is needed.
 *
 * detect_from_command gating (per filter, after _strip_prefixes / matches):
 *  - bandit  : binaries {bandit}; any subcommand (default binaries-based
 *              matches() — none of these four filters override matches()).
 *  - trivy   : binaries {trivy}; any subcommand.
 *  - snyk    : binaries {snyk}; any subcommand.
 *  - semgrep : binaries {semgrep}; any subcommand.
 *
 * NOTE on import depth: this file lives in the bash_compress/ SUBDIR; the
 * framework is a SIBLING (./framework.js). verbatimModuleSyntax is on -> nothing
 * imported here is type-only. noImplicitOverride is on -> every overridden member
 * carries `override`.
 */

import { Filter, _maybe_note } from "./framework.js";

// ===========================================================================
// Internal Python-builtin / stdlib shims local to this module.
// ===========================================================================

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
 * callers that read capture groups. Non-global clone so lastIndex never leaks;
 * index===0 enforces the START-anchored semantics of .match().
 */
function _reMatchObj(re: RegExp, line: string): RegExpExecArray | null {
  const m = _nonGlobal(re).exec(line);
  return m !== null && m.index === 0 ? m : null;
}

/** Python re.Pattern.search(line) — boolean "matches anywhere". */
function _reSearch(re: RegExp, line: string): boolean {
  return _nonGlobal(re).test(line);
}

/**
 * Python re.search(pattern, text) returning the match object (or null) —
 * unanchored, reads capture groups. Non-global clone so lastIndex never leaks.
 */
function _reSearchObj(re: RegExp, text: string): RegExpExecArray | null {
  return _nonGlobal(re).exec(text);
}

// ===========================================================================
// Module-private framework regex re-declared here (framework does NOT export
// _ERROR_SIGNAL_RE — re-exporting it would create a TS2308 ambiguity). None of
// the four security filters below actually consult it, but the copy is kept for
// parity with the sibling filter modules (test_runners.ts / node_pm.ts / pkg.ts).
// ===========================================================================

/** Python _ERROR_SIGNAL_RE (framework-private) — re-declared module-private. */
const _ERROR_SIGNAL_RE: RegExp =
  /error:|Error:|ERROR|FAILED|failed|fatal:|Traceback|exception:|Exception:|AssertionError|assert |panic:/i;

// ===========================================================================
// bandit regexes (Python ~15715-15739).
// ===========================================================================

/** "Run started:" banner line. Python: re.compile(r"^Run started:") */
const _BANDIT_RUN_STARTED_RE: RegExp = /^Run started:/;
/** "Test results:" section header. Python: re.compile(r"^Test results:") */
const _BANDIT_TEST_RESULTS_RE: RegExp = /^Test results:/;
/** Issue header — ">> Issue: [". Python: re.compile(r"^>>\s+Issue:\s+\[", re.IGNORECASE) */
const _BANDIT_ISSUE_SEVERITY_RE: RegExp = /^>>\s+Issue:\s+\[/i;
/** Individual issue metadata lines (Location, More Info, …). */
const _BANDIT_ISSUE_META_RE: RegExp =
  /^\s+(Severity|Confidence|CWE|Location|More Info):/;
/** "Code scanned:" stats block opener. Python: re.compile(r"^Code scanned:") */
const _BANDIT_CODE_SCANNED_RE: RegExp = /^Code scanned:/;
/** "Total issues (by severity)" table header. Python: re.compile(r"^Total issues \(by") */
const _BANDIT_TOTAL_ISSUES_RE: RegExp = /^Total issues \(by/;
/** Numeric stat line inside the Code scanned / Total issues blocks. */
const _BANDIT_STAT_LINE_RE: RegExp = /^\s+\|?\s*\d/;
/** "testing <file>" per-file progress line emitted with -v or in some versions. */
const _BANDIT_TESTING_RE: RegExp = /^testing\s/;

/**
 * Inline regex used by BanditFilter.compress to extract the Severity token from
 * a metadata line: re.search(r"Severity:\s*(\w+)", line, re.IGNORECASE).
 */
const _BANDIT_SEVERITY_INLINE_RE: RegExp = /Severity:\s*(\w+)/i;

// ===========================================================================
// BanditFilter (Python ~15742-15869)
// ===========================================================================

/**
 * Compress `bandit` Python security-scan output.
 *
 * Bandit emits one issue block per finding:
 *
 *     >> Issue: [B101:assert_used] Use of assert detected.
 *        Severity: Low   Confidence: High
 *        CWE: CWE-703
 *        Location: src/foo.py:42:4
 *
 * On a large codebase the LOW severity blocks are often 80 %+ of the output and
 * rarely require immediate action.
 *
 * Compression model:
 *  - Keep the "Run started:" banner.
 *  - Keep the "Test results:" section header.
 *  - Keep HIGH and MEDIUM severity issue blocks verbatim.
 *  - Collapse LOW severity issue blocks to a running count.
 *  - Keep the "Code scanned:" stats block.
 *  - Keep the "Total issues (by severity)" table.
 *  - Drop per-file "testing <file>" progress lines.
 */
export class BanditFilter extends Filter {
  override name = "bandit";
  override binaries: ReadonlySet<string> = new Set(["bandit"]);

  override compress(stdout: string, stderr: string, _exit_code: number, _argv: string[]): string {
    const merged = this._combine_output(stdout, stderr);
    const lines = merged.split("\n");
    const kept: string[] = [];
    let low_dropped = 0;

    // State machine: are we inside an issue block?
    let in_issue = false;
    let current_severity = "";
    let issue_buf: string[] = [];

    const flush_issue = (): void => {
      const sev = current_severity.toUpperCase();
      if (sev === "HIGH" || sev === "MEDIUM") {
        kept.push(...issue_buf);
      } else {
        low_dropped += 1;
      }
    };

    let in_stats_block = false;

    for (const line of lines) {
      // Always drop per-file progress lines.
      if (_reMatch(_BANDIT_TESTING_RE, line)) {
        continue;
      }

      // Detect stats block openers — flush any pending issue first.
      if (_reMatch(_BANDIT_CODE_SCANNED_RE, line) || _reMatch(_BANDIT_TOTAL_ISSUES_RE, line)) {
        if (in_issue) {
          flush_issue();
          in_issue = false;
          issue_buf = [];
          current_severity = "";
        }
        in_stats_block = true;
        kept.push(line);
        continue;
      }

      // Inside stats block: keep numeric stat lines and blank delimiters.
      if (in_stats_block) {
        if (_reMatch(_BANDIT_STAT_LINE_RE, line) || line.trim() === "") {
          kept.push(line);
        } else {
          // Next non-blank non-stat line closes the stats block.
          in_stats_block = false;
          // Fall through to normal processing below.
        }
      }

      if (in_stats_block) {
        continue;
      }

      // Issue block opener.
      if (_reMatch(_BANDIT_ISSUE_SEVERITY_RE, line)) {
        if (in_issue) {
          flush_issue();
          issue_buf = [];
          current_severity = "";
        }
        in_issue = true;
        issue_buf.push(line);
        continue;
      }

      // Inside an issue block, accumulate metadata lines.
      if (
        in_issue &&
        (_reMatch(_BANDIT_ISSUE_META_RE, line) ||
          line.trim().startsWith("--") ||
          line.trim() === "")
      ) {
        issue_buf.push(line);
        if (line.trim() === "" || line.trim().startsWith("--")) {
          // Blank or separator line terminates the block.
          flush_issue();
          in_issue = false;
          issue_buf = [];
          current_severity = "";
          if (line.trim()) {
            kept.push(line);
          }
        } else {
          // Extract severity for later decision.
          const sev_m = _reSearchObj(_BANDIT_SEVERITY_INLINE_RE, line);
          if (sev_m) {
            current_severity = sev_m[1]!;
          }
        }
        continue;
      }

      // Always keep: run banner, section headers, other lines.
      if (_reMatch(_BANDIT_RUN_STARTED_RE, line) || _reMatch(_BANDIT_TEST_RESULTS_RE, line)) {
        kept.push(line);
        continue;
      }

      kept.push(line);
    }

    // Flush a trailing open issue block.
    if (in_issue) {
      flush_issue();
    }

    const notes: string[] = [];
    _maybe_note(notes, low_dropped, `collapsed ${low_dropped} LOW severity issue block(s)`);
    Filter._emit_notes(kept, notes);
    return Filter._finalize(kept);
  }
}

// ===========================================================================
// Trivy regexes (Python ~15775-15797).
// ===========================================================================

/** Trivy INFO / WARN / DEBUG / ERROR log lines emitted to stderr (timestamped). */
const _TRIVY_LOG_RE: RegExp =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[^\s]*\s+(?:INFO|WARN|DEBUG|ERROR)\s/;
/** Trivy table separator line (all dashes / plus / pipes). */
const _TRIVY_TABLE_SEP_RE: RegExp = /^[+|-]+$/;
/** Trivy vulnerability table data row — starts with "|". */
const _TRIVY_TABLE_ROW_RE: RegExp = /^\|/;
/** "Total: N (CRITICAL: X, HIGH: Y, MEDIUM: Z, LOW: W)" summary line. */
const _TRIVY_TOTAL_RE: RegExp = /^Total:\s*\d+/i;
/** "No vulnerabilities found" messages (unanchored search). */
const _TRIVY_NO_VULN_RE: RegExp = /no\s+vulnerabilit/i;
/**
 * Target / library header lines (e.g. "Python (python-pkg)", "OS Packages").
 * Python: re.compile(r"^(?:[-=]+\s+)?(?:Python|Ruby|Node\.js|...|\S+\s+\()", re.IGNORECASE)
 */
const _TRIVY_TARGET_RE: RegExp =
  /^(?:[-=]+\s+)?(?:Python|Ruby|Node\.js|Go|Java|PHP|Rust|OS Packages|Alpine|Debian|Ubuntu|RHEL|CentOS|npm|pip|gem|cargo|pom\.xml|Gemfile\.lock|requirements|package-lock|yarn\.lock|composer\.lock|go\.sum|Cargo\.lock|\S+\s+\()/i;

// ===========================================================================
// TrivyFilter (Python ~15900-16020)
// ===========================================================================

/**
 * Compress `trivy` container/filesystem vulnerability scan output.
 *
 * Trivy tables can be enormous when scanning a base image that carries hundreds
 * of MEDIUM/LOW findings while only a handful are CRITICAL/HIGH.
 *
 * Compression model:
 *  - Drop INFO/WARN/DEBUG log lines (timestamped lines to stderr) — they are
 *    download/setup chatter, not findings.
 *  - Keep CRITICAL and HIGH vulnerability rows in the table.
 *  - Collapse MEDIUM, LOW, and UNKNOWN rows to per-library counts.
 *  - Keep the "Total: N (CRITICAL: X, HIGH: Y, ...)" summary line.
 *  - Keep "No vulnerabilities found" messages verbatim.
 *  - Keep table header rows (column names + separator lines).
 *  - Keep target/library section headers.
 */
export class TrivyFilter extends Filter {
  override name = "trivy";
  override binaries: ReadonlySet<string> = new Set(["trivy"]);

  // Severity ordering — rows in the table have a SEVERITY column.
  _HIGH_SEPS: ReadonlySet<string> = new Set(["CRITICAL", "HIGH"]);

  override compress(stdout: string, stderr: string, _exit_code: number, _argv: string[]): string {
    // Merge stderr (log lines) and stdout (table) separately then combine.
    // First strip log-noise from stderr.
    const all_err_lines = stderr.split("\n");
    const clean_err_lines = all_err_lines.filter((ln) => !_reMatch(_TRIVY_LOG_RE, ln));
    const log_dropped = stderr.trim() !== "" ? all_err_lines.length - clean_err_lines.length : 0;
    const clean_err = clean_err_lines.join("\n").trim();

    // Process stdout table.
    const out_lines = stdout.split("\n");
    const kept: string[] = [];
    // Per-library MEDIUM/LOW/UNKNOWN collapsed counts: library -> {sev: count}
    const low_med_counts = new Map<string, Map<string, number>>();
    let in_table = false;
    // Column index of SEVERITY field — parsed dynamically from the header row.
    let sev_col_idx = -1;
    let lib_col_idx = -1;

    const _parse_table_cols = (header_line: string): void => {
      const cols = header_line.split("|").map((c) => c.trim());
      for (let i = 0; i < cols.length; i += 1) {
        const cu = cols[i]!.toUpperCase();
        if (cu === "SEVERITY") {
          sev_col_idx = i;
        }
        if (
          (cu === "LIBRARY" || cu === "PACKAGE" || cu === "VULNERABILITY ID") &&
          lib_col_idx === -1
        ) {
          lib_col_idx = i;
        }
      }
    };

    const _flush_low_med = (): void => {
      const libs = [...low_med_counts.entries()].sort((a, b) =>
        a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0,
      );
      for (const [lib, sev_counts_map] of libs) {
        const sevs = [...sev_counts_map.entries()].sort((a, b) =>
          a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0,
        );
        const summary = sevs.map(([sev, cnt]) => `${sev}: ${cnt}`).join(", ");
        kept.push(`[token-goat: ${lib} — ${summary} (collapsed)]`);
      }
      low_med_counts.clear();
    };

    for (const line of out_lines) {
      // No-vuln messages are always preserved.
      if (_reSearch(_TRIVY_NO_VULN_RE, line)) {
        kept.push(line);
        continue;
      }
      // Total summary line — always keep.
      if (_reMatch(_TRIVY_TOTAL_RE, line)) {
        _flush_low_med();
        kept.push(line);
        continue;
      }
      // Table separator line.
      if (_reMatch(_TRIVY_TABLE_SEP_RE, line)) {
        kept.push(line);
        in_table = Boolean(line);
        continue;
      }
      // Table header row — detect column positions.
      if (in_table && line.startsWith("|") && line.toUpperCase().includes("SEVERITY")) {
        _parse_table_cols(line);
        kept.push(line);
        continue;
      }
      // Table data row.
      if (in_table && _reMatch(_TRIVY_TABLE_ROW_RE, line)) {
        const cols = line.split("|").map((c) => c.trim());
        let sev = "";
        if (sev_col_idx >= 0 && sev_col_idx < cols.length) {
          sev = cols[sev_col_idx]!.toUpperCase();
        }
        if (this._HIGH_SEPS.has(sev)) {
          kept.push(line);
        } else {
          // Collapse MEDIUM/LOW/UNKNOWN by library.
          let lib = "unknown";
          if (lib_col_idx >= 0 && lib_col_idx < cols.length) {
            lib = cols[lib_col_idx]! || "unknown";
          }
          let sev_bucket = low_med_counts.get(lib);
          if (sev_bucket === undefined) {
            sev_bucket = new Map<string, number>();
            low_med_counts.set(lib, sev_bucket);
          }
          const sev_key = sev || "UNKNOWN";
          sev_bucket.set(sev_key, (sev_bucket.get(sev_key) ?? 0) + 1);
        }
        continue;
      }
      // Target/library section header.
      if (_reMatch(_TRIVY_TARGET_RE, line) || line.startsWith("=") || line.startsWith("-")) {
        _flush_low_med();
        in_table = false;
        sev_col_idx = -1;
        lib_col_idx = -1;
        kept.push(line);
        continue;
      }
      kept.push(line);
    }

    _flush_low_med();

    let out_text = Filter._finalize(kept);
    const notes: string[] = [];
    _maybe_note(notes, log_dropped, `dropped ${log_dropped} Trivy INFO/WARN/DEBUG log lines`);
    // Python mutates kept via _emit_notes AFTER _finalize captured out_text; we
    // preserve the exact same ordering (notes appended to kept, out_text already
    // fixed). When clean_err is non-empty Python concatenates it to out_text.
    Filter._emit_notes(kept, notes);

    if (clean_err) {
      out_text =
        out_text.trim() !== ""
          ? `${out_text.replace(/\s+$/u, "")}\n---\n${clean_err}`
          : clean_err;
    }
    return out_text;
  }
}

// ===========================================================================
// Snyk regexes (Python ~16025-16052).
// ===========================================================================

/** Snyk "Testing <package>..." first line. Python: re.compile(r"^Testing\s", re.IGNORECASE) */
const _SNYK_TESTING_RE: RegExp = /^Testing\s/i;
/** Snyk dependency tree lines using box-drawing characters (or ASCII fallbacks). */
const _SNYK_TREE_LINE_RE: RegExp = /^(?:[├└│\s]|[|\\`][-\s]|  )/;
/**
 * Snyk vuln block opener — "✗ High severity vulnerability found" or
 * "Low severity vulnerability found in foo".
 */
const _SNYK_VULN_HEADER_RE: RegExp =
  /(?:✗|x|X)?\s*(?:Critical|High|Medium|Low|Info)\s+severity/i;
/** "More about this vulnerability:" / bare-URL lines. */
const _SNYK_MORE_ABOUT_RE: RegExp =
  /^\s*(?:More about this vulnerability|https?:\/\/\S+)/i;
/** Snyk summary line — "✔ X unique vulnerabilities" or "✗ X issues". */
const _SNYK_SUMMARY_RE: RegExp =
  /(?:✔|✗|Tested\s+\d+|unique vulnerabilities|no vulnerable paths|issues found)/i;
/** License issue lines (unanchored search). Python: re.compile(r"license", re.IGNORECASE) */
const _SNYK_LICENSE_RE: RegExp = /license/i;

// ===========================================================================
// SnykFilter (Python ~16055-16168)
// ===========================================================================

/**
 * Compress `snyk` security scan output.
 *
 * Snyk output for a large monorepo can contain deep dependency trees, lengthy
 * vulnerability blocks, and "More about..." URL sections.
 *
 * Compression model:
 *  - Keep the first "Testing <pkg>..." line; drop subsequent progress lines.
 *  - Collapse deep dependency tree lines (├─, └─, │) to a count after the
 *    first 10.
 *  - Keep vulnerability block headers (severity + package name + description
 *    opener).
 *  - Collapse "More about this vulnerability:" / bare URL lines inside a vuln
 *    block (typically 3–5 lines) to a single token-goat note.
 *  - Keep summary lines (unique vulnerabilities, issues found, licence issues).
 *  - Keep license issue lines verbatim.
 */
export class SnykFilter extends Filter {
  override name = "snyk";
  override binaries: ReadonlySet<string> = new Set(["snyk"]);

  override compress(stdout: string, stderr: string, _exit_code: number, _argv: string[]): string {
    const merged = this._combine_output(stdout, stderr);
    const lines = merged.split("\n");
    const kept: string[] = [];

    let testing_seen = false;
    let tree_lines = 0;
    let tree_hidden = 0;
    let in_more_about = false;
    let more_about_dropped = 0;

    for (const line of lines) {
      // --- Testing progress ---
      if (_reMatch(_SNYK_TESTING_RE, line)) {
        if (!testing_seen) {
          kept.push(line);
          testing_seen = true;
        }
        // else drop subsequent "Testing ..." lines
        continue;
      }

      // --- Summary lines always kept ---
      if (_reSearch(_SNYK_SUMMARY_RE, line)) {
        if (tree_hidden) {
          kept.push(`[token-goat: +${tree_hidden} dependency tree lines collapsed]`);
          tree_hidden = 0;
        }
        kept.push(line);
        continue;
      }

      // --- License issue lines always kept ---
      if (_reSearch(_SNYK_LICENSE_RE, line) && !_reMatch(_SNYK_TREE_LINE_RE, line)) {
        kept.push(line);
        continue;
      }

      // --- "More about..." / URL-only lines ---
      if (_reMatch(_SNYK_MORE_ABOUT_RE, line)) {
        in_more_about = true;
        more_about_dropped += 1;
        continue;
      }
      if (in_more_about) {
        // The block ends when we hit a non-URL, non-blank line.
        if (line.trim() !== "" && !line.trim().startsWith("http")) {
          in_more_about = false;
          if (more_about_dropped) {
            kept.push(
              `[token-goat: collapsed ${more_about_dropped} 'More about' URL line(s)]`,
            );
            more_about_dropped = 0;
          }
          // Fall through to normal handling.
        } else {
          more_about_dropped += 1;
          continue;
        }
      }

      // --- Vulnerability block headers ---
      if (_reSearch(_SNYK_VULN_HEADER_RE, line)) {
        if (tree_hidden) {
          kept.push(`[token-goat: +${tree_hidden} dependency tree lines collapsed]`);
          tree_hidden = 0;
        }
        kept.push(line);
        continue;
      }

      // --- Dependency tree lines ---
      if (_reMatch(_SNYK_TREE_LINE_RE, line) && line.trim() !== "") {
        tree_lines += 1;
        if (tree_lines <= 10) {
          kept.push(line);
        } else {
          tree_hidden += 1;
        }
        continue;
      }

      // --- All other lines pass through ---
      if (tree_hidden && !_reMatch(_SNYK_TREE_LINE_RE, line)) {
        kept.push(`[token-goat: +${tree_hidden} dependency tree lines collapsed]`);
        tree_hidden = 0;
      }
      if (more_about_dropped) {
        kept.push(
          `[token-goat: collapsed ${more_about_dropped} 'More about' URL line(s)]`,
        );
        more_about_dropped = 0;
      }
      kept.push(line);
    }

    // Flush trailing counts.
    if (tree_hidden) {
      kept.push(`[token-goat: +${tree_hidden} dependency tree lines collapsed]`);
    }
    if (more_about_dropped) {
      kept.push(
        `[token-goat: collapsed ${more_about_dropped} 'More about' URL line(s)]`,
      );
    }
    return Filter._finalize(kept);
  }
}

// ===========================================================================
// Semgrep regexes (Python ~16173-16202).
// ===========================================================================

/** "Scanning N files..." / "Running N ..." progress line. */
const _SEMGREP_SCANNING_RE: RegExp = /^(?:Scanning\s+\d+|Running\s+\d+)/i;
/**
 * Semgrep rule match header — "  severity   rule-id" or a bare "rule-id" line.
 * Python: re.compile(r"^\s*(ERROR|WARNING|INFO|HIGH|MEDIUM|LOW|CRITICAL)\s+\S
 *                     r"|^[^\s/][^/\s]*\.[a-zA-Z0-9_-]+\s*$", re.IGNORECASE)
 */
const _SEMGREP_RULE_HEADER_RE: RegExp =
  /^\s*(ERROR|WARNING|INFO|HIGH|MEDIUM|LOW|CRITICAL)\s+\S|^[^\s/][^/\s]*\.[a-zA-Z0-9_-]+\s*$/i;
/** File:line citation inside a rule match block. */
const _SEMGREP_FILE_LOC_RE: RegExp = /^\s+\d+\s*[│|]\s|^\s*[^:\s]+:\d+/;
/** "Details:" URL line. Python: re.compile(r"^\s*Details:\s*https?://", re.IGNORECASE) */
const _SEMGREP_DETAILS_RE: RegExp = /^\s*Details:\s*https?:\/\//i;
/** Final summary line. */
const _SEMGREP_SUMMARY_RE: RegExp =
  /^(?:Ran\s+\d+|Findings?:|✔|✘|\d+\s+finding)/i;
/** Semgrep autofix / rule source annotation lines. */
const _SEMGREP_ANNOTATION_RE: RegExp = /^\s*(?:run|fix|autofix|rule):\s*https?:\/\//i;

/**
 * Inline regex used by SemgrepFilter.compress for the "looks like rule.id" test:
 * re.match(r"^[a-zA-Z0-9_-]+\.[a-zA-Z0-9_-]+", line).
 */
const _SEMGREP_RULE_ID_INLINE_RE: RegExp = /^[a-zA-Z0-9_-]+\.[a-zA-Z0-9_-]+/;

// ===========================================================================
// SemgrepFilter (Python ~16205-16337)
// ===========================================================================

/**
 * Compress `semgrep` static analysis output.
 *
 * Semgrep can emit thousands of lines when the same rule fires across hundreds
 * of files. The agent needs rule identity, severity, and the first few instances
 * — not every occurrence.
 *
 * Compression model:
 *  - Keep the first "Scanning N files..." line.
 *  - Keep rule match blocks (rule id + file:line + code snippet); drop "Details:"
 *    / annotation URL lines.
 *  - Collapse repeated matches for the same rule across many files: show the
 *    first 3 instances, collapse the rest to a count.
 *  - Keep the "Ran N rules on N files: N findings" summary.
 */
export class SemgrepFilter extends Filter {
  override name = "semgrep";
  override binaries: ReadonlySet<string> = new Set(["semgrep"]);

  // Max instances of the same rule to keep before collapsing.
  _MAX_PER_RULE = 3;

  override compress(stdout: string, stderr: string, _exit_code: number, _argv: string[]): string {
    const merged = this._combine_output(stdout, stderr);
    const lines = merged.split("\n");
    const kept: string[] = [];

    let scanning_seen = false;
    let details_dropped = 0;
    // rule_id -> count of instances already emitted
    const rule_counts = new Map<string, number>();
    // rule_id -> count of instances suppressed
    const rule_suppressed = new Map<string, number>();

    // We do a two-pass approach:
    // Pass 1: split into blocks (each rule match is a block).
    // Pass 2: emit first _MAX_PER_RULE blocks per rule, suppress rest.

    // Build blocks: a block starts at a non-indented rule-id line and ends just
    // before the next such line or the summary. For simplicity, we do a single
    // pass with state tracking.

    let current_rule: string | null = null;
    let current_block: string[] = [];

    const flush_block = (): void => {
      if (current_rule === null) {
        kept.push(...current_block);
        return;
      }
      const count = rule_counts.get(current_rule) ?? 0;
      if (count < this._MAX_PER_RULE) {
        // Emit block, stripping Details: lines.
        const block_out: string[] = [];
        let local_dropped = 0;
        for (const bl of current_block) {
          if (_reMatch(_SEMGREP_DETAILS_RE, bl) || _reMatch(_SEMGREP_ANNOTATION_RE, bl)) {
            local_dropped += 1;
          } else {
            block_out.push(bl);
          }
        }
        if (local_dropped) {
          block_out.push(
            `  [token-goat: collapsed ${local_dropped} Details/annotation URL line(s)]`,
          );
          details_dropped += local_dropped;
        }
        kept.push(...block_out);
        rule_counts.set(current_rule, count + 1);
      } else {
        rule_suppressed.set(
          current_rule,
          (rule_suppressed.get(current_rule) ?? 0) + 1,
        );
      }
    };

    for (const line of lines) {
      // Scanning banner — keep first occurrence only.
      if (_reMatch(_SEMGREP_SCANNING_RE, line)) {
        if (!scanning_seen) {
          // Flush any open block first.
          flush_block();
          current_rule = null;
          current_block = [];
          kept.push(line);
          scanning_seen = true;
        }
        continue;
      }

      // Summary line — flush and always keep.
      if (_reMatch(_SEMGREP_SUMMARY_RE, line)) {
        flush_block();
        current_rule = null;
        current_block = [];
        // Emit suppression notes before summary.
        const suppressed_sorted = [...rule_suppressed.entries()].sort((a, b) =>
          a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0,
        );
        for (const [rule_id, sup_cnt] of suppressed_sorted) {
          kept.push(
            `[token-goat: ${rule_id} — ${sup_cnt} additional match(es) collapsed ` +
              `(kept first ${this._MAX_PER_RULE})]`,
          );
        }
        rule_suppressed.clear();
        kept.push(line);
        continue;
      }

      // Rule match header — non-indented rule id or severity+rule line. Detect
      // by: non-blank, not starting with spaces, and looks like a rule path or
      // severity keyword.
      const is_rule_header =
        line.length > 0 &&
        !/\s/.test(line.charAt(0)) &&
        (_reMatch(_SEMGREP_RULE_HEADER_RE, line) ||
          line.split("/").pop()!.includes(".") ||
          _reMatch(_SEMGREP_RULE_ID_INLINE_RE, line)) &&
        !_reMatch(_SEMGREP_SUMMARY_RE, line) &&
        !_reMatch(_SEMGREP_SCANNING_RE, line);
      if (is_rule_header) {
        flush_block();
        current_rule = line.trim();
        current_block = [line];
        continue;
      }

      // Everything else goes into the current block.
      current_block.push(line);
    }

    // Flush trailing block.
    flush_block();
    // Emit any unseen suppression notes at end.
    const suppressed_sorted = [...rule_suppressed.entries()].sort((a, b) =>
      a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0,
    );
    for (const [rule_id, sup_cnt] of suppressed_sorted) {
      kept.push(
        `[token-goat: ${rule_id} — ${sup_cnt} additional match(es) collapsed ` +
          `(kept first ${this._MAX_PER_RULE})]`,
      );
    }

    // details_dropped is accumulated inside flush_block for parity with Python
    // (which likewise never emits a standalone note for it); reference it so the
    // linter does not flag it unused. The per-block "[token-goat: collapsed N
    // Details/annotation URL line(s)]" markers above already carry the detail.
    void details_dropped;

    return Filter._finalize(kept);
  }
}
