/**
 * bash_compress LINTER FILTERS — TypeScript port of the linter Filter subclasses
 * from src/token_goat/bash_compress.py (Python lines ~5442-6188): the
 * ruff/eslint/mypy/generic-linter quartet plus the module-level regexes and
 * helpers they share.
 *
 * Four filters subclass the concrete Filter base from ./framework.js and override
 * compress() (and, for the generic catch-all, dispatch via binary stem) with
 * per-tool structural compression:
 *   - RuffFilter   — `ruff check` (rule-code summarisation) and `ruff format`
 *                    (per-file Reformatted/Would-reformat collapsing).
 *   - ESLintFilter — ESLint per-file stanza format (zero-issue stanza dropping,
 *                    error passthrough, per-rule warning dedup, summary keep).
 *   - LinterFilter — the GENERIC linter catch-all (pyright/pylint via
 *                    dedupe_by_key; stylelint/rome via the ESLint-stanza helper).
 *                    Registered LAST among linters so the specific filters win.
 *   - MypyFilter   — `mypy` / `dmypy` (error-message dedup, note dedup,
 *                    cross-reference note drop, trailing error-code normalising).
 *
 * TscFilter (the TypeScript compiler) is ALSO in this region of the Python source
 * but is already ported in node_tools.ts; it is deliberately NOT re-ported here.
 *
 * ---------------------------------------------------------------------------
 * Parity notes (Python -> TS)
 * ---------------------------------------------------------------------------
 *  - Python identifiers preserved EXACTLY: PascalCase class names (RuffFilter,
 *    ESLintFilter, LinterFilter, MypyFilter), snake_case methods/fields
 *    (compress, _compress_format, _DIAG_KEY_RE, name, binaries), the module-level
 *    helpers (_compress_eslint_stanza, _emit_eslint_rules), and the module-private
 *    regex constants (_RUFF_*, _ESLINT_*, _MYPY_*).
 *  - re.compile(...) -> top-level RegExp compiled once at module load. The named
 *    groups in _RUFF_LINE_RE / _MYPY_LINE_RE are ported as JS named groups
 *    (?<code>...) so m.groups.code etc. read 1:1.
 *  - Python re.Pattern.match(line) is anchored at the START (NOT end-anchored);
 *    emulated via _reMatch (non-global clone + index===0). re.match returning a
 *    match object (where capture groups are read) goes through _reMatchObj.
 *  - re.sub: the two name-quoting substitutions ('"[^"]*"' -> '"…"' and
 *    "'[^']*'" -> "'…'") replace ALL non-overlapping matches, so they use a
 *    GLOBAL clone. _MYPY_TRAILING_ERROR_CODE_RE.sub("") is `$`-anchored (at most
 *    one match) and uses a non-global clone.
 *  - Path(argv[0]).stem.lower() -> _pathStemLower (final path component after
 *    normalising backslashes, last extension stripped, lowercased), matching the
 *    framework _pathStem semantics for the binaries the linter matches() exercise.
 *  - dedupe_by_key / _maybe_note / _combine_output / _emit_notes / _finalize are
 *    imported from ./framework.js (or used as Filter statics) — no framework
 *    helper is re-implemented here.
 *  - Module-global mutable state: NONE. All per-call counters/dicts are locals
 *    inside compress()/_compress_format()/_compress_eslint_stanza(); no
 *    registerReset seam is needed.
 *
 * NOTE on import depth: this file lives in the bash_compress/ SUBDIR; the
 * framework is a SIBLING (./framework.js). verbatimModuleSyntax is on -> nothing
 * imported here is type-only. noImplicitOverride is on -> every overridden member
 * carries `override`.
 */

import {
  Filter,
  dedupe_by_key,
  _maybe_note,
  _squeeze_blank_lines,
  _positional_args,
} from "./framework.js";

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
 * filters that read capture groups. Non-global clone so lastIndex never leaks.
 */
function _reMatchObj(re: RegExp, line: string): RegExpExecArray | null {
  const r = _nonGlobal(re);
  const m = r.exec(line);
  return m !== null && m.index === 0 ? m : null;
}

/**
 * Python Path(p).stem.lower() — the final path component (after normalising
 * backslashes to forward slashes) with its LAST suffix removed, lowercased.
 * Mirrors the framework's _pathStem: a leading-dot dotfile keeps its name and a
 * trailing dot is not a suffix.
 */
function _pathStemLower(p: string): string {
  const norm = p.replace(/\\/g, "/").replace(/\/+$/, "");
  const idx = norm.lastIndexOf("/");
  const name = idx >= 0 ? norm.slice(idx + 1) : norm;
  const dot = name.lastIndexOf(".");
  if (dot <= 0 || dot === name.length - 1) {
    return name.toLowerCase();
  }
  return name.slice(0, dot).toLowerCase();
}

/** Python str.rsplit(None, 1)[-1].strip() — the last whitespace-delimited token. */
function _lastWsToken(line: string): string {
  const parts = line.split(/\s+/).filter((t) => t.length > 0);
  return parts.length > 0 ? parts[parts.length - 1]!.trim() : "";
}

// ===========================================================================
// Ruff regexes (Python lines ~5404-5436).
// ===========================================================================

// Python: re.compile(r"^\s+\d+:\d+\s+(error|warning|info)\s")
const _ESLINT_LOC_RE: RegExp = /^\s+\d+:\d+\s+(error|warning|info)\s/;
// Python: re.compile(r"^(?:/|[A-Z]:|[a-zA-Z0-9_./-]+\.(?:js|jsx|ts|tsx|mjs|cjs|vue))")
const _ESLINT_FILE_RE: RegExp =
  /^(?:\/|[A-Z]:|[a-zA-Z0-9_./-]+\.(?:js|jsx|ts|tsx|mjs|cjs|vue))/;
// Python: re.compile(r"^(?P<file>.+?):(?P<line>\d+):(?P<col>\d+):\s+(?P<code>[A-Z]+\d+)\s")
const _RUFF_LINE_RE: RegExp =
  /^(?<file>.+?):(?<line>\d+):(?<col>\d+):\s+(?<code>[A-Z]+\d+)\s/;
// Python: re.compile(r"^Found \d+ error")
const _RUFF_FOOTER_RE: RegExp = /^Found \d+ error/;
// Ruff success banner: "All checks passed!" (or the older "No errors found.")
// The agent infers success from exit code 0; the text is pure noise.
// Python: re.compile(r"^(?:All checks passed!|No errors found\.?)\s*$")
const _RUFF_SUCCESS_RE: RegExp = /^(?:All checks passed!|No errors found\.?)\s*$/;
// ruff format per-file lines: "Reformatted path/to/file.py"
// (emitted for every file that was modified; only the summary counts).
// Python: re.compile(r"^Reformatted\s+\S")
const _RUFF_FORMAT_REFORMATTED_RE: RegExp = /^Reformatted\s+\S/;
// ruff format --check per-file lines: "Would reformat: path/to/file.py"
// Python: re.compile(r"^Would reformat:\s+\S")
const _RUFF_FORMAT_WOULD_REFORMAT_RE: RegExp = /^Would reformat:\s+\S/;
// ruff format summary lines:
//   "N files reformatted, N files left unchanged"
//   "N files already formatted."
//   "N files would be reformatted, N files would be left unchanged."
// Python: re.compile(r"^\d+ file")
// (Defined in the Python source for completeness; not referenced by the
// compression logic, so it ships module-private here too.)
const _RUFF_FORMAT_SUMMARY_RE: RegExp = /^\d+ file/;
// Python: re.compile(r"^(?P<file>.+?):(?P<line>\d+):(?:\d+:)?\s+(?P<level>error|note|warning):")
const _MYPY_LINE_RE: RegExp =
  /^(?<file>.+?):(?<line>\d+):(?:\d+:)?\s+(?<level>error|note|warning):/;

// ===========================================================================
// RuffFilter (Python lines ~5442-5591).
// ===========================================================================

/**
 * Compress `ruff` linter output.
 *
 * Ruff on a large codebase often fires the same rule (e.g. E501 line-too-long)
 * hundreds of times across dozens of files. The agent gains nothing from seeing
 * the 51st occurrence.
 *
 * Compression model (`ruff check`):
 *
 *  - Rule with >= 3 occurrences across >= 2 files: collapse to a single summary
 *    line `RULE_CODE: N occurrences in M files (example: <first line>)`.
 *  - Rule with < 3 occurrences (or all in one file): keep all lines verbatim.
 *  - Always keep the `Found N errors` footer line.
 *  - Always keep non-violation lines (blank lines, section headers, etc.).
 *  - On clean exit (exit_code 0, no violations): return empty string — the agent
 *    infers success from the exit code and does not need the
 *    "All checks passed!" banner.
 *
 * Compression model (`ruff format`):
 *
 *  - Drop per-file `Reformatted path/to/file.py` lines — collapse to count.
 *  - Drop per-file `Would reformat: path/to/file.py` lines (`--check` mode) —
 *    collapse to count.
 *  - Keep the final `N files reformatted, N files left unchanged` summary.
 *  - On clean exit (`ruff format` with no changes): return empty string.
 */
export class RuffFilter extends Filter {
  override name = "ruff";
  override binaries: ReadonlySet<string> = new Set(["ruff"]);

  override compress(stdout: string, stderr: string, exit_code: number, argv: string[]): string {
    const merged = this._combine_output(stdout, stderr);

    // Dispatch: ruff format vs ruff check (default).
    const positionals = _positional_args(argv.slice(1));
    const subcommand = positionals.length > 0 ? positionals[0]!.toLowerCase() : "check";
    if (subcommand === "format") {
      return this._compress_format(merged, exit_code);
    }

    // --- ruff check (default) ---

    // Fast path: clean run — strip the success banner entirely. The agent infers
    // pass/fail from the exit code; the "All checks passed!" string is pure noise
    // (~4 tokens per invocation).
    if (exit_code === 0) {
      const lines_stripped = merged
        .split("\n")
        .filter((ln) => !_reMatch(_RUFF_SUCCESS_RE, ln));
      // If nothing remains after stripping the success banner (and any
      // surrounding blank lines), return empty — don't emit whitespace.
      const cleaned = lines_stripped.join("\n").trim();
      // Only suppress when the remaining content is also empty (i.e. ruff printed
      // *only* the success banner). If there is other output on a clean run (e.g.
      // auto-fix summary from `ruff check --fix`), keep it.
      if (!cleaned) {
        return "";
      }
    }

    const lines = merged.split("\n");

    // First pass: collect violation lines grouped by rule code.
    // code -> list of [file, full_line]
    const by_code = new Map<string, Array<[string, string]>>();
    const footer_lines: string[] = [];
    const indexed: Array<[boolean, string]> = []; // [is_violation, line]

    for (const line of lines) {
      if (_reMatch(_RUFF_FOOTER_RE, line)) {
        footer_lines.push(line);
        indexed.push([false, line]);
        continue;
      }
      const m = _reMatchObj(_RUFF_LINE_RE, line);
      if (m) {
        const code = m.groups!["code"]!;
        const file_ = m.groups!["file"]!;
        const bucket = by_code.get(code) ?? [];
        bucket.push([file_, line]);
        by_code.set(code, bucket);
        indexed.push([true, line]);
      } else {
        indexed.push([false, line]);
      }
    }

    // Decide which codes get summarised (>= 3 occurrences across >= 2 files).
    const summarised = new Map<string, string>();
    for (const [code, entries] of by_code) {
      const files = new Set(entries.map(([f]) => f));
      if (entries.length >= 3 && files.size >= 2) {
        const example = entries[0]![1];
        summarised.set(
          code,
          `${code}: ${entries.length} occurrences in ${files.size} files` +
            ` (example: ${example})`,
        );
      }
    }

    // Second pass: emit lines.
    const out: string[] = [];
    const emitted_summary = new Set<string>();
    for (const [is_viol, line] of indexed) {
      if (_reMatch(_RUFF_FOOTER_RE, line)) {
        // Defer footers to end.
        continue;
      }
      if (!is_viol) {
        out.push(line);
        continue;
      }
      const m = _reMatchObj(_RUFF_LINE_RE, line);
      const code = m ? m.groups!["code"]! : "";
      if (summarised.has(code)) {
        if (!emitted_summary.has(code)) {
          out.push(summarised.get(code)!);
          emitted_summary.add(code);
        }
        // else: skip — already summarised
      } else {
        out.push(line);
      }
    }

    out.push(...footer_lines);
    return _squeeze_blank_lines(out.join("\n"));
  }

  /**
   * Compress `ruff format` output.
   *
   * `ruff format` emits one `Reformatted path/to/file.py` line per modified file
   * then a summary like `12 files reformatted, 5 files left unchanged`. `ruff
   * format --check` uses `Would reformat:` lines instead. The per-file lines are
   * pure noise — only the summary counts.
   */
  _compress_format(merged: string, exit_code: number): string {
    const lines = merged.split("\n");
    const kept: string[] = [];
    let dropped_reformatted = 0;
    let dropped_would_reformat = 0;

    for (const line of lines) {
      if (_reMatch(_RUFF_FORMAT_REFORMATTED_RE, line)) {
        dropped_reformatted += 1;
        continue;
      }
      if (_reMatch(_RUFF_FORMAT_WOULD_REFORMAT_RE, line)) {
        dropped_would_reformat += 1;
        continue;
      }
      // Keep summary lines, blank lines, errors, etc.
      kept.push(line);
    }

    const notes: string[] = [];
    _maybe_note(notes, dropped_reformatted, `collapsed ${dropped_reformatted} 'Reformatted …' per-file lines`);
    _maybe_note(notes, dropped_would_reformat, `collapsed ${dropped_would_reformat} 'Would reformat:' per-file lines`);
    RuffFilter._emit_notes(kept, notes);
    const result = _squeeze_blank_lines(kept.join("\n")).trim();

    // On a clean exit with no remaining content (e.g. "ruff format" with all
    // files already formatted and only the success banner present), return empty.
    if (exit_code === 0 && !result) {
      return "";
    }
    return result;
  }
}

// ===========================================================================
// LinterFilter (Python lines ~5803-5849) + the ESLint-stanza helpers it uses.
// ===========================================================================

/**
 * Compress linter output: group by file, dedupe by rule.
 *
 * Linters often report the same rule fires 50+ times across a brownfield
 * codebase; the agent learns nothing new from the 51st occurrence. Group by
 * `file` and within each file group by `rule_code`, keeping the first three line
 * numbers as examples and appending `(+N more)`.
 *
 * Filters dispatched:
 *
 *  - pyright: `src/foo.py:3: error: incompatible type`
 *  - pylint: similar: falls through to dedupe_by_key.
 *  - stylelint / rome: stanza-style (like ESLint).
 *
 * Note: `eslint` is handled by the more specific ESLintFilter which is registered
 * before this filter in FILTERS.
 * Note: `biome` is handled by the more specific BiomeFilter which is registered
 * before this filter in FILTERS.
 * Note: `tsc` is handled by the more specific TscFilter which is registered
 * before this filter in FILTERS.
 */
export class LinterFilter extends Filter {
  override name = "linter";
  override binaries: ReadonlySet<string> = new Set([
    "pyright", "pylint",
    "stylelint", "rome",
  ]);

  // Matches diagnostic codes and severity keywords in pyright/pylint output.
  // Python: re.compile(r"\b([A-Z][A-Z0-9]+\d+|error|warning|note)\b")
  static readonly _DIAG_KEY_RE: RegExp = /\b([A-Z][A-Z0-9]+\d+|error|warning|note)\b/;

  override compress(stdout: string, stderr: string, _exit_code: number, argv: string[]): string {
    const merged = this._combine_output(stdout, stderr);
    const binary = argv.length > 0 ? _pathStemLower(argv[0]!) : "";
    if (binary === "pyright" || binary === "pylint") {
      const compressed = dedupe_by_key(
        merged.split("\n"),
        LinterFilter._DIAG_KEY_RE,
        {
          keep_first_n: 3,
          fmt: "[token-goat: +{count} more matching {key_value}]",
        },
      );
      return _squeeze_blank_lines(compressed.join("\n"));
    }
    // stylelint / biome / rome: stanza-style like ESLint.
    return _compress_eslint_stanza(merged);
  }
}

/**
 * Compress ESLint's per-file stanza format.
 *
 * Format:
 *
 *     path/to/file.js
 *       12:8  error    'foo' is defined but never used  no-unused-vars
 *       15:1  warning  Missing semicolon                semi
 *     ...
 *     ✖ 47 problems (12 errors, 35 warnings)
 *
 * Strategy: within each file stanza, dedupe by rule name (last token on each
 * issue line) keeping up to three examples; preserve the final ✖ summary.
 */
export function _compress_eslint_stanza(text: string): string {
  const lines = text.split("\n");
  const out: string[] = [];
  let current_file: string[] = [];

  const flush_file = (): void => {
    if (current_file.length === 0) {
      return;
    }
    const header = current_file[0]!;
    const body = current_file.slice(1);
    let per_rule = new Map<string, string[]>();
    for (const line of body) {
      const m = _reMatchObj(_ESLINT_LOC_RE, line);
      if (!m) {
        // Not an issue line, flush as-is.
        if (per_rule.size > 0) {
          out.push(..._emit_eslint_rules(per_rule));
          per_rule = new Map<string, string[]>();
        }
        out.push(line);
        continue;
      }
      const rule = _lastWsToken(line);
      const bucket = per_rule.get(rule) ?? [];
      bucket.push(line);
      per_rule.set(rule, bucket);
    }
    out.push(header);
    out.push(..._emit_eslint_rules(per_rule));
  };

  for (const line of lines) {
    if (_reMatch(_ESLINT_FILE_RE, line)) {
      flush_file();
      current_file = [line];
    } else if (current_file.length > 0) {
      current_file.push(line);
    } else {
      out.push(line);
    }
  }
  flush_file();
  return _squeeze_blank_lines(out.join("\n"));
}

/** Emit grouped eslint issues: up to 3 examples per rule plus a count. */
export function _emit_eslint_rules(per_rule: Map<string, string[]>): string[] {
  const out: string[] = [];
  for (const rule of [...per_rule.keys()].sort()) {
    const entries = per_rule.get(rule)!;
    const keep = entries.slice(0, 3);
    out.push(...keep);
    if (entries.length > 3) {
      out.push(`  [token-goat: +${entries.length - 3} more ${rule} violations]`);
    }
  }
  return out;
}

// ===========================================================================
// ESLint regexes (Python lines ~5917-5923).
// ===========================================================================

// ESLint summary footer: "✖ 47 problems (12 errors, 35 warnings)"
// Python: re.compile(r"^[✖✗✘x×]\s+\d+\s+problem")
const _ESLINT_SUMMARY_RE: RegExp = /^[✖✗✘x×]\s+\d+\s+problem/;
// ESLint issue line: "  12:8  error   'foo' is defined…   no-unused-vars"
// Python: re.compile(r"^\s+\d+:\d+\s+(error|warning|info)\s+.+\S\s+\S+$")
const _ESLINT_ISSUE_RE: RegExp = /^\s+\d+:\d+\s+(error|warning|info)\s+.+\S\s+\S+$/;

// ===========================================================================
// ESLintFilter (Python lines ~5926-6036).
// ===========================================================================

/**
 * Compress ESLint output.
 *
 * ESLint's default formatter emits a stanza per file:
 *
 *     path/to/file.js
 *       12:8  error    'foo' is not defined   no-undef
 *       15:1  warning  Missing semicolon       semi
 *     ...
 *     ✖ 47 problems (12 errors, 35 warnings)
 *
 * Compression model:
 *
 *  - Fast path: exit 0 → collapse to `ESLint: no errors`.
 *  - Drop file stanzas that contain zero issue lines (blank/no-problem files that
 *    appear only because they were linted).
 *  - Keep all `error` severity issue lines verbatim.
 *  - Deduplicate `warning` lines: keep up to 3 per rule per file, then summarise
 *    `+N more <rule> warnings`.
 *  - Keep the final `✖ N problems (N errors, N warnings)` summary.
 */
export class ESLintFilter extends Filter {
  override name = "eslint";
  override binaries: ReadonlySet<string> = new Set(["eslint"]);

  override compress(stdout: string, stderr: string, exit_code: number, _argv: string[]): string {
    const merged = this._combine_output(stdout, stderr);

    // Fast path: clean exit — all we need to communicate is "no errors".
    if (exit_code === 0) {
      // Look for a summary line; if none present (quiet mode), emit terse.
      const lines = merged.split("\n");
      const summary = lines.find((ln) => _reMatch(_ESLINT_SUMMARY_RE, ln.trim()));
      return summary !== undefined ? summary : "ESLint: no errors";
    }

    const lines = merged.split("\n");
    const out: string[] = [];
    let current_file_header: string | null = null;
    // Actual issue lines (matching _ESLINT_ISSUE_RE) for the current file.
    let current_issues: string[] = [];
    // Has the current stanza seen at least one line matching _ESLINT_ISSUE_RE?
    let current_has_issues = false;

    const _flush_file = (): void => {
      if (current_file_header === null) {
        current_issues = [];
        current_has_issues = false;
        return;
      }
      // Drop entire stanza when no actual issue lines were collected.
      if (!current_has_issues) {
        current_file_header = null;
        current_issues = [];
        current_has_issues = false;
        return;
      }
      out.push(current_file_header);
      // Group warnings by rule for deduplication; errors are always kept.
      const warn_by_rule = new Map<string, string[]>();
      for (const issue of current_issues) {
        const m = _reMatchObj(_ESLINT_ISSUE_RE, issue);
        if (m && m[1] === "warning") {
          const rule = _lastWsToken(issue);
          const bucket = warn_by_rule.get(rule) ?? [];
          bucket.push(issue);
          warn_by_rule.set(rule, bucket);
        } else {
          // Non-warning (error / info / unrecognised): keep as-is.
          out.push(issue);
        }
      }
      // Emit deduplicated warnings.
      for (const rule of [...warn_by_rule.keys()].sort()) {
        const entries = warn_by_rule.get(rule)!;
        out.push(...entries.slice(0, 3));
        if (entries.length > 3) {
          out.push(`  [token-goat: +${entries.length - 3} more ${rule} warnings]`);
        }
      }
      current_file_header = null;
      current_issues = [];
      current_has_issues = false;
    };

    for (const line of lines) {
      // Summary footer — always keep.
      if (_reMatch(_ESLINT_SUMMARY_RE, line.trim())) {
        _flush_file();
        out.push(line);
        continue;
      }
      // File header line.
      if (_reMatch(_ESLINT_FILE_RE, line)) {
        _flush_file();
        current_file_header = line;
        current_issues = [];
        current_has_issues = false;
        continue;
      }
      // Issue line inside a stanza.
      if (current_file_header !== null && _reMatch(_ESLINT_ISSUE_RE, line)) {
        current_issues.push(line);
        current_has_issues = true;
        continue;
      }
      // Any other line (blank, etc.) outside a stanza or between stanzas.
      if (current_file_header === null) {
        out.push(line);
      } else {
        // Non-issue line inside a stanza (e.g. blank separator). Collect in
        // issues list; only emitted if stanza has real issues.
        current_issues.push(line);
      }
    }

    _flush_file();
    return _squeeze_blank_lines(out.join("\n"));
  }
}

// ===========================================================================
// mypy regexes (Python lines ~6041-6059).
// ===========================================================================

// Python: re.compile(r"^Found \d+ error")
const _MYPY_SUMMARY_RE: RegExp = /^Found \d+ error/;
// Python: re.compile(r"^(?P<file>.+?):(?P<line>\d+):(?:\d+:)?\s+note:")
// (Defined in the Python source for completeness; not referenced by the
// compression logic, so it ships module-private here too.)
const _MYPY_NOTE_CONTINUATION_RE: RegExp = /^(?<file>.+?):(?<line>\d+):(?:\d+:)?\s+note:/;
// Standalone `  [error-code]` suffix lines emitted by mypy when
// `--show-error-codes` is active alongside multi-line note output.
// They look like:  `  [assignment]` or `  [attr-defined]` on their own line.
// Python: re.compile(r"^\s+\[[a-z][a-z0-9-]*\]\s*$")
const _MYPY_STANDALONE_ERROR_CODE_RE: RegExp = /^\s+\[[a-z][a-z0-9-]*\]\s*$/;
// Trailing `  [error-code]` appended to error-message text (`--show-error-codes`).
// Strip this before normalising so that structurally identical errors with
// different codes group correctly: "Incompatible type [assignment]" and
// "Incompatible type [attr-defined]" describe the same structural pattern.
// Python: re.compile(r"\s+\[[a-z][a-z0-9-]*\]\s*$")
const _MYPY_TRAILING_ERROR_CODE_RE: RegExp = /\s+\[[a-z][a-z0-9-]*\]\s*$/;

// Name-normalising substitution patterns (Python re.sub inline literals).
// Both replace ALL non-overlapping matches, so they carry the global flag.
const _MYPY_DQUOTE_NAME_RE: RegExp = /"[^"]*"/g;
const _MYPY_SQUOTE_NAME_RE: RegExp = /'[^']*'/g;

// ===========================================================================
// MypyFilter (Python lines ~6062-6187).
// ===========================================================================

/**
 * Compress `mypy` type-check output.
 *
 * Mypy on a large codebase can emit hundreds or thousands of diagnostics. The
 * agent needs to see the *variety* of errors and the final tally, not every
 * individual occurrence.
 *
 * Compression model:
 *
 *  - Keep all `error:` lines — each is a distinct type violation.
 *  - Keep up to 3 `note:` lines per unique note *message* (notes that differ only
 *    in the cited line number are the same conceptual hint).
 *  - Dedupe errors with identical message text: keep the first 3 occurrences of
 *    each unique error message and append `(+N more)` for the rest. This prevents
 *    a single widespread error (e.g. `Incompatible return value type`) from
 *    drowning out rarer ones.
 *  - Always keep the final `Found N errors in M files` summary line.
 *  - Drop `note:` lines that are merely "see: [error-codes]" cross-references
 *    (`note: See https://mypy.readthedocs.io/…`).
 *  - Drop `(errors prevented further checking)` annotations — they add noise
 *    without actionable information.
 *  - Normalise away trailing `[error-code]` suffixes (produced by
 *    `--show-error-codes` / `--show-error-end`) before deduplication so
 *    `"Incompatible type [assignment]"` and `"Incompatible type [attr-defined]"`
 *    are grouped as the same structural error. The original line (with the code)
 *    is still emitted verbatim.
 *  - Drop standalone `  [error-code]` lines (a bare error-code annotation on its
 *    own line, also a `--show-error-codes` artefact).
 *
 * On a 2 000-line mypy run with 300 errors the output typically shrinks to 30–60
 * lines while preserving all unique error messages.
 */
export class MypyFilter extends Filter {
  override name = "mypy";
  override binaries: ReadonlySet<string> = new Set(["mypy", "dmypy"]);

  override compress(stdout: string, stderr: string, _exit_code: number, _argv: string[]): string {
    const merged = this._combine_output(stdout, stderr);
    const lines = merged.split("\n");

    const kept: string[] = [];
    // Map from normalised error message → count of occurrences kept so far.
    const error_msg_counts = new Map<string, number>();
    // Map from normalised note message → count of occurrences kept so far.
    const note_msg_counts = new Map<string, number>();
    let dropped_errors = 0;
    let dropped_notes = 0;

    for (const line of lines) {
      // Always keep the final summary line.
      if (_reMatch(_MYPY_SUMMARY_RE, line)) {
        kept.push(line);
        continue;
      }

      // Drop standalone `  [error-code]` lines (a --show-error-codes artefact:
      // mypy sometimes emits the error code on its own line as a continuation of
      // the previous diagnostic).
      if (_reMatch(_MYPY_STANDALONE_ERROR_CODE_RE, line)) {
        dropped_notes += 1;
        continue;
      }

      const m = _reMatchObj(_MYPY_LINE_RE, line);
      if (m === null) {
        // Not a diagnostic line — keep as-is (could be a blank line, a "Success:
        // no issues found" message, etc.).
        kept.push(line);
        continue;
      }

      const level = m.groups!["level"]!;

      if (level === "error") {
        // Normalise the error message (everything after "error: ").
        const msg_start = line.indexOf("error:") + "error:".length;
        const msg = line.slice(msg_start).trim();
        // Strip "(errors prevented further checking)" annotations.
        if (msg.startsWith("(errors prevented further checking)")) {
          continue;
        }
        // Normalise away file-local identifiers like quoted names and line/column
        // refs so structurally identical errors group together.
        let normalised = msg.replace(_MYPY_DQUOTE_NAME_RE, '"…"');
        normalised = normalised.replace(_MYPY_SQUOTE_NAME_RE, "'…'");
        // Strip trailing `[error-code]` suffix (--show-error-codes) so that
        // "Incompatible type [assignment]" and "Incompatible type [attr-defined]"
        // normalise to the same key.
        normalised = normalised.replace(_nonGlobal(_MYPY_TRAILING_ERROR_CODE_RE), "").trim();
        const count = error_msg_counts.get(normalised) ?? 0;
        error_msg_counts.set(normalised, count + 1);
        if (count < 3) {
          kept.push(line);
        } else {
          dropped_errors += 1;
        }
      } else if (level === "note") {
        // Drop see-also cross-reference notes (noisy, rarely actionable).
        if (line.includes("See https://") || line.includes("See http://")) {
          dropped_notes += 1;
          continue;
        }
        const msg_start = line.indexOf("note:") + "note:".length;
        const msg = line.slice(msg_start).trim();
        let normalised = msg.replace(_MYPY_DQUOTE_NAME_RE, '"…"');
        normalised = normalised.replace(_MYPY_SQUOTE_NAME_RE, "'…'");
        const count = note_msg_counts.get(normalised) ?? 0;
        note_msg_counts.set(normalised, count + 1);
        if (count < 3) {
          kept.push(line);
        } else {
          dropped_notes += 1;
        }
      } else {
        // warning: or any other level — keep.
        kept.push(line);
      }
    }

    if (dropped_errors) {
      kept.push(
        `[token-goat: suppressed ${dropped_errors} duplicate error lines ` +
          `(kept first 3 per unique message); disable via TOKEN_GOAT_BASH_COMPRESS ` +
          `for the full list]`,
      );
    }
    if (dropped_notes) {
      kept.push(
        `[token-goat: suppressed ${dropped_notes} duplicate/cross-reference note lines]`,
      );
    }

    return MypyFilter._finalize(kept);
  }
}

// Re-exports of the module-private regex constants for the Python __all__ /
// test-import surface. They carry a leading underscore in Python (module-private)
// but are exposed here so a later barrel phase / white-box test can reference them
// by their exact Python name without re-deriving the pattern. (The two name-
// normalising substitution patterns are TS-only implementation details and are
// intentionally NOT re-exported.)
export {
  _ESLINT_LOC_RE,
  _ESLINT_FILE_RE,
  _RUFF_LINE_RE,
  _RUFF_FOOTER_RE,
  _RUFF_SUCCESS_RE,
  _RUFF_FORMAT_REFORMATTED_RE,
  _RUFF_FORMAT_WOULD_REFORMAT_RE,
  _RUFF_FORMAT_SUMMARY_RE,
  _MYPY_LINE_RE,
  _ESLINT_SUMMARY_RE,
  _ESLINT_ISSUE_RE,
  _MYPY_SUMMARY_RE,
  _MYPY_NOTE_CONTINUATION_RE,
  _MYPY_STANDALONE_ERROR_CODE_RE,
  _MYPY_TRAILING_ERROR_CODE_RE,
};
