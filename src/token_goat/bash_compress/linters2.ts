/**
 * bash_compress LINTER FILTERS (group 2) — TypeScript port of three linter
 * Filter subclasses from src/token_goat/bash_compress.py (Python lines
 * ~17836-18657): OxlintFilter, PylintFilter, BiomeFilter, plus the module-level
 * regexes they share and the _pylint_code_name free helper.
 *
 * Three filters subclass the concrete Filter base from ./framework.js and
 * override compress() (Oxlint/Pylint) or matches()+compress() (Biome) with
 * per-tool structural compression:
 *   - OxlintFilter  — `oxlint src/` (per-rule dedup within each file; drop
 *                     location-pointer lines for suppressed issues; keep
 *                     summary + error-signal lines).
 *   - PylintFilter  — `pylint src/` (per-message-code dedup; always keep E/F
 *                     severity; drop orphan module headers, separators, and
 *                     config-loading noise; keep the rating line).
 *   - BiomeFilter   — `biome check` / `lint` / `format` (group diagnostics by
 *                     rule, keep 3 stanzas per rule, cap source-excerpt lines,
 *                     drop hints/annotations; keep summary + error lines).
 *
 * These live in a LATER region of bash_compress.py near Bun/Nx/Deno (already
 * ported elsewhere — NOT re-ported here). The barrel one level up wires the
 * FILTERS registry ordering and select_filter dispatch; that is out of scope.
 *
 * ---------------------------------------------------------------------------
 * Parity notes (Python -> TS)
 * ---------------------------------------------------------------------------
 *  - Python identifiers are preserved EXACTLY: PascalCase class names
 *    (OxlintFilter, PylintFilter, BiomeFilter), snake_case methods/fields
 *    (matches, compress, name, binaries, _pylint_code_name), the snake_case
 *    class-var counters (_KEEP_PER_RULE, _KEEP_PER_CODE), and the module-private
 *    regex constants (_OXLINT_*, _PYLINT_*, _BIOME_*).
 *  - re.compile(...) -> top-level RegExp compiled once at module load. IGNORECASE
 *    -> "i". The regexes carry no DOTALL/MULTILINE that affects per-line use.
 *  - Python re.Pattern.match(line) is anchored at the START (NOT end-anchored);
 *    emulated via _reMatch (non-global clone + index===0). re.Pattern.search ->
 *    a non-global clone + .exec for a free match anywhere in the line
 *    (_reSearch returns the match object so callers can read capture groups).
 *  - _ERROR_SIGNAL_RE is framework-PRIVATE (not exported by framework.ts). It is
 *    re-declared here as a MODULE-PRIVATE const (NOT exported — a duplicate
 *    export across the barrel export* chain would be a TS2308 ambiguity). The
 *    source bytes are copied verbatim from framework.ts.
 *  - Path(argv[0]).stem.lower() (BiomeFilter.matches) -> _pathStemLower, the same
 *    helper the shipped go.ts module uses: final path component after
 *    normalising backslashes, last extension stripped, lowercased.
 *  - Byte/line caps and blank-line squeezing are delegated to the framework via
 *    Filter._finalize / Filter._emit_notes / _maybe_note / _combine_output — no
 *    framework helper is re-implemented here.
 *  - f-string `{rule!r}` (OxlintFilter) -> Python repr() of a str, which for the
 *    rule names that reach this branch ([a-zA-Z0-9/_-]+, no quotes/backslashes)
 *    is `'` + value + `'`. Reproduced with _pyRepr.
 *  - Module-global mutable state: NONE. All per-call counters/dicts are locals
 *    inside compress(); no registerReset seam is needed.
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
 * Python re.Pattern.search(line) — first match anywhere in the line, returned as
 * the match object (or null) so callers can read capture groups. Non-global
 * clone so lastIndex never leaks across calls.
 */
function _reSearch(re: RegExp, line: string): RegExpExecArray | null {
  return _nonGlobal(re).exec(line);
}

/** Python re.Pattern.search(line) returning a boolean (contains-match). */
function _reSearchBool(re: RegExp, line: string): boolean {
  return _nonGlobal(re).test(line);
}

/**
 * Python repr() of a str for the rule names that reach the OxlintFilter dedup
 * marker. Those rules are captured by [a-zA-Z0-9/_-]+ so they contain no quotes,
 * backslashes, or control chars; Python's repr() wraps such a string in single
 * quotes with no escaping. Reproduced for the `{rule!r}` f-string only.
 */
function _pyRepr(s: string): string {
  return `'${s}'`;
}

/**
 * Path(argv[0]).stem.lower() — final path component after normalising
 * backslashes, last extension stripped, lowercased. Matches the framework's
 * _pathStem semantics: a leading-dot dotfile keeps its name and a trailing dot
 * is not a suffix. Same helper as the shipped go.ts module.
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

// ===========================================================================
// Framework-private signal regex, re-declared MODULE-PRIVATE (NOT exported).
// Copied verbatim from framework.ts _ERROR_SIGNAL_RE (do NOT export — a
// duplicate export across the barrel export* chain is a TS2308 ambiguity).
// Python: re.compile(r"error:|Error:|ERROR|FAILED|failed|fatal:|Traceback
//   |exception:|Exception:|AssertionError|assert |panic:", re.IGNORECASE)
// ===========================================================================
const _ERROR_SIGNAL_RE: RegExp =
  /error:|Error:|ERROR|FAILED|failed|fatal:|Traceback|exception:|Exception:|AssertionError|assert |panic:/i;

// ===========================================================================
// oxlint regexes (Python lines ~17840-17860).
// ===========================================================================

// oxlint file header: "  src/foo.ts" (indented path with extension)
// Python: re.compile(r"^\s{2,}\S+\.\w{1,10}\s*$")
const _OXLINT_FILE_HEADER_RE: RegExp = /^\s{2,}\S+\.\w{1,10}\s*$/;
// oxlint issue line: "    × Expect … (rule-name) …"  or  "    ✖ …"
// Python: re.compile(r"^\s{4,}[×✖✗!]\s")
const _OXLINT_ISSUE_RE: RegExp = /^\s{4,}[×✖✗!]\s/;
// oxlint location pointer line: "      ╭─[…:line:col]"  or  "   │ …"
// Python: re.compile(r"^\s*(?:╭─\[|│\s|╰─)")
const _OXLINT_LOCATION_RE: RegExp = /^\s*(?:╭─\[|│\s|╰─)/;
// oxlint summary: "Found N warnings and M errors."
// Python: re.compile(r"^\s*(?:Found \d+|Finished in \d+|oxlint v\d)", re.IGNORECASE)
const _OXLINT_SUMMARY_RE: RegExp = /^\s*(?:Found \d+|Finished in \d+|oxlint v\d)/i;
// oxlint rule name: last token inside parentheses at end of issue line
// Python: re.compile(r"\(([a-zA-Z0-9/_-]+)\)\s*$")
const _OXLINT_RULE_RE: RegExp = /\(([a-zA-Z0-9/_-]+)\)\s*$/;

/**
 * Compress oxlint JavaScript/TypeScript linter output.
 *
 * `oxlint src/` emits per-file issue blocks with Unicode box-drawing location
 * pointers and a final summary. On a medium codebase this is hundreds of lines,
 * most of which repeat a handful of rules across many files.
 *
 * Compression model:
 *  - Deduplicate by rule: within each file, keep the first 3 occurrences of each
 *    rule code; collapse the rest to "(+N more)".
 *  - Drop location-pointer lines (╭─[…] / │ / ╰─) for deduplicated issues — they
 *    only add visual noise once deduplicated.
 *  - Keep all summary lines (Found N warnings and M errors).
 *  - Keep any line matching _ERROR_SIGNAL_RE.
 */
export class OxlintFilter extends Filter {
  override name = "oxlint";
  override binaries: ReadonlySet<string> = new Set(["oxlint", "oxc_linter"]);

  /** keep up to N occurrences per rule per file */
  _KEEP_PER_RULE = 3;

  override compress(stdout: string, stderr: string, _exit_code: number, _argv: string[]): string {
    const combined = this._combine_output(stdout, stderr);
    const lines = combined.split("\n");
    const kept: string[] = [];
    let deduplicated = 0;
    let dropped_location = 0;
    let current_file: string | null = null;
    // Maps rule_name -> count seen in current file
    let rule_counts = new Map<string, number>();
    // Whether the current issue block should be kept or suppressed
    let suppress_block = false;

    for (const line of lines) {
      // Always keep error signals
      if (_reSearchBool(_ERROR_SIGNAL_RE, line)) {
        kept.push(line);
        suppress_block = false;
        continue;
      }
      // Summary line — always keep; reset file context
      if (_reMatch(_OXLINT_SUMMARY_RE, line)) {
        kept.push(line);
        current_file = null;
        rule_counts = new Map<string, number>();
        continue;
      }
      // File header line
      if (_reMatch(_OXLINT_FILE_HEADER_RE, line)) {
        current_file = line.trim();
        rule_counts = new Map<string, number>();
        suppress_block = false;
        kept.push(line);
        continue;
      }
      // Issue line — check rule dedup
      if (_reMatch(_OXLINT_ISSUE_RE, line)) {
        const m = _reSearch(_OXLINT_RULE_RE, line);
        const rule = m ? m[1]! : "__unknown__";
        const next = (rule_counts.get(rule) ?? 0) + 1;
        rule_counts.set(rule, next);
        if (next <= this._KEEP_PER_RULE) {
          kept.push(line);
          suppress_block = false;
        } else {
          if (next === this._KEEP_PER_RULE + 1) {
            kept.push(
              `  [token-goat: +? more ${_pyRepr(rule)} in ${current_file ?? "file"}; ` +
                "disable via TOKEN_GOAT_BASH_COMPRESS for full list]",
            );
          }
          deduplicated += 1;
          suppress_block = true;
        }
        continue;
      }
      // Location pointer lines — drop when suppressing
      if (_reMatch(_OXLINT_LOCATION_RE, line)) {
        if (suppress_block) {
          dropped_location += 1;
          continue;
        }
        kept.push(line);
        continue;
      }
      kept.push(line);
    }

    const notes: string[] = [];
    _maybe_note(notes, deduplicated, `deduplicated ${deduplicated} repeated-rule issue lines`);
    _maybe_note(
      notes,
      dropped_location,
      `dropped ${dropped_location} location-pointer lines for deduped issues`,
    );
    Filter._emit_notes(kept, notes);
    return Filter._finalize(kept);
  }
}

// ===========================================================================
// pylint regexes (Python lines ~17956-17980).
// ===========================================================================

// pylint module header: "************* Module foo.bar"
// Python: re.compile(r"^\*{10,}\s+Module\s")
const _PYLINT_MODULE_RE: RegExp = /^\*{10,}\s+Module\s/;
// pylint issue line: "src/foo.py:10:4: C0301 (line-too-long) Line too long..."
// Python: re.compile(r"^[^\s].*:\d+:\d+:\s+[CWEFR]\d{4}")
const _PYLINT_ISSUE_RE: RegExp = /^[^\s].*:\d+:\d+:\s+[CWEFR]\d{4}/;
// pylint message code capture: e.g. "C0301", "W0611"
// Python: re.compile(r"\s([CWEFR]\d{4})\s")
const _PYLINT_CODE_RE: RegExp = /\s([CWEFR]\d{4})\s/;
// pylint rating line: "Your code has been rated at 8.50/10 ..."
// Python: re.compile(r"^Your code has been rated at")
const _PYLINT_RATING_RE: RegExp = /^Your code has been rated at/;
// pylint section separator / header noise
// Python: re.compile(r"^-{10,}$")
const _PYLINT_SEPARATOR_RE: RegExp = /^-{10,}$/;
// pylint "Using config file" / "Loading plugin" header lines
// Python: re.compile(r"^(?:Using config file|Loading plugin|No config file found)")
const _PYLINT_CONFIG_RE: RegExp = /^(?:Using config file|Loading plugin|No config file found)/;

// pylint symbolic-name capture inside parentheses, e.g. "(line-too-long)".
// Python: re.search(r"\(([a-z][a-z0-9-]+)\)", line)
const _PYLINT_CODE_NAME_RE: RegExp = /\(([a-z][a-z0-9-]+)\)/;

/**
 * Compress pylint static analysis output.
 *
 * `pylint src/` emits per-module headers, one issue line per violation, a
 * separator, and a final rating. On a large codebase with common issues (e.g.
 * C0301 line-too-long, W0611 unused-import) the same message code fires hundreds
 * of times across files, drowning out rarer/higher-severity messages.
 *
 * Compression model:
 *  - Deduplicate by message code: keep the first 3 occurrences of each message
 *    code (e.g. C0301); collapse the rest to "(+N more)".
 *  - Always keep Error (E) and Fatal (F) severity lines regardless of dedup
 *    count — they signal crashes / syntax errors, never noise.
 *  - Drop "************* Module foo.bar" headers when the module has no kept
 *    issue lines (avoids orphan headers).
 *  - Drop separator lines (------), config-loading noise.
 *  - Always keep the final rating line (Your code has been rated at …).
 */
export class PylintFilter extends Filter {
  override name = "pylint";
  override binaries: ReadonlySet<string> = new Set(["pylint"]);

  _KEEP_PER_CODE = 3;

  override compress(stdout: string, stderr: string, _exit_code: number, _argv: string[]): string {
    const combined = this._combine_output(stdout, stderr);
    const lines = combined.split("\n");
    const kept: string[] = [];
    const code_counts = new Map<string, number>();
    let deduplicated = 0;
    let dropped_separators = 0;
    let dropped_config = 0;
    let pending_module: string | null = null;
    let module_has_kept_issue = false;

    for (const line of lines) {
      // Rating line — always keep
      if (_reMatch(_PYLINT_RATING_RE, line)) {
        kept.push(line);
        continue;
      }
      // Separator lines — drop
      if (_reMatch(_PYLINT_SEPARATOR_RE, line)) {
        dropped_separators += 1;
        continue;
      }
      // Config loading noise — drop
      if (_reMatch(_PYLINT_CONFIG_RE, line)) {
        dropped_config += 1;
        continue;
      }
      // Module header — hold pending until we know if it has kept issues
      if (_reMatch(_PYLINT_MODULE_RE, line)) {
        // Flush previous pending header only if it had kept issues
        if (pending_module !== null && module_has_kept_issue) {
          kept.push(pending_module);
        } else if (pending_module !== null) {
          // orphan header dropped
        }
        pending_module = line;
        module_has_kept_issue = false;
        continue;
      }
      // Issue line — dedup by message code, always keep E/F severity
      if (_reMatch(_PYLINT_ISSUE_RE, line)) {
        const m = _reSearch(_PYLINT_CODE_RE, line);
        const code = m ? m[1]! : "__unknown__";
        const severity = code ? code[0]! : "?";
        const next = (code_counts.get(code) ?? 0) + 1;
        code_counts.set(code, next);
        const always_keep = severity === "E" || severity === "F";
        if (always_keep || next <= this._KEEP_PER_CODE) {
          // Flush pending module header before first kept issue
          if (pending_module !== null) {
            kept.push(pending_module);
            pending_module = null;
          }
          module_has_kept_issue = true;
          kept.push(line);
        } else {
          if (next === this._KEEP_PER_CODE + 1) {
            if (pending_module !== null) {
              kept.push(pending_module);
              pending_module = null;
            }
            module_has_kept_issue = true;
            kept.push(
              `  [token-goat: +? more ${code} (${_pylint_code_name(line)}); ` +
                "disable via TOKEN_GOAT_BASH_COMPRESS for full list]",
            );
          }
          deduplicated += 1;
        }
        continue;
      }
      // Error signals — always keep
      if (_reSearchBool(_ERROR_SIGNAL_RE, line)) {
        if (pending_module !== null) {
          kept.push(pending_module);
          pending_module = null;
        }
        kept.push(line);
        continue;
      }
      kept.push(line);
    }

    // Flush trailing pending module header if it had kept issues
    if (pending_module !== null && module_has_kept_issue) {
      kept.push(pending_module);
    }

    const notes: string[] = [];
    _maybe_note(notes, deduplicated, `deduplicated ${deduplicated} repeated-code issue lines`);
    _maybe_note(notes, dropped_separators, `dropped ${dropped_separators} separator lines`);
    _maybe_note(notes, dropped_config, `dropped ${dropped_config} config-loading lines`);
    Filter._emit_notes(kept, notes);
    return Filter._finalize(kept);
  }
}

/** Extract the symbolic name from a pylint issue line, e.g. 'line-too-long'. */
export function _pylint_code_name(line: string): string {
  const m = _reSearch(_PYLINT_CODE_NAME_RE, line);
  return m ? m[1]! : "?";
}

// ===========================================================================
// Biome regexes (Python lines ~18502-18530).
// ===========================================================================

// Biome diagnostic file header: "/path/to/file.ts graphql/noUndefinedVariables"
// or just "file.ts" with a rule on the next line.
// Python: re.compile(
//   r"^(?:/|[A-Za-z]:\\|\.{1,2}/)\S+\.[a-z]+\s*$"
//   r"|^[^\s/]+\.[a-z]+\s+(?:lint/|format/|assists/)\S+", re.IGNORECASE)
const _BIOME_FILE_HEADER_RE: RegExp =
  /^(?:\/|[A-Za-z]:\\|\.{1,2}\/)\S+\.[a-z]+\s*$|^[^\s/]+\.[a-z]+\s+(?:lint\/|format\/|assists\/)\S+/i;
// Biome diagnostic location: "  NN │ code snippet"
// Python: re.compile(r"^\s+\d+\s+[│|]\s")
const _BIOME_SOURCE_LINE_RE: RegExp = /^\s+\d+\s+[│|]\s/;
// Biome action hint: "  i Use X instead."  or  "  ℹ Note:"
// Python: re.compile(r"^\s+(?:[iℹ]|ℹ️|Note:)\s+")
const _BIOME_HINT_RE: RegExp = /^\s+(?:[iℹ]|ℹ️|Note:)\s+/;
// Biome rule violation line: "  × some/rule/name ━━━"
// Python: re.compile(r"^\s+[×✖✕]\s+\S+/\S+\s+(?:━+|─+)")
const _BIOME_RULE_LINE_RE: RegExp = /^\s+[×✖✕]\s+\S+\/\S+\s+(?:━+|─+)/;
// Biome summary line: "Found N diagnostics in N files in Xms"
// Python: re.compile(
//   r"^Found\s+\d+\s+diagnostic|^Checked\s+\d+\s+file|^Formatted\s+\d+\s+file"
//   r"|^\d+\s+(?:error|warning|info)", re.IGNORECASE)
const _BIOME_SUMMARY_RE: RegExp =
  /^Found\s+\d+\s+diagnostic|^Checked\s+\d+\s+file|^Formatted\s+\d+\s+file|^\d+\s+(?:error|warning|info)/i;
// Biome "Caution" / "note:" context annotation lines
// Python: re.compile(r"^\s+(?:Caution:|note:|help:|suggestion:)\s+", re.IGNORECASE)
const _BIOME_ANNOTATION_RE: RegExp = /^\s+(?:Caution:|note:|help:|suggestion:)\s+/i;

// Biome rule-name capture: first "tok/tok" pair in a rule-violation line.
// Python: re.search(r"(\S+/\S+)", line)
const _BIOME_RULE_NAME_RE: RegExp = /(\S+\/\S+)/;

/**
 * Compress biome check / biome lint / biome format output.
 *
 * Biome (formerly Rome) is a fast JS/TS linter and formatter. It emits verbose
 * per-file diagnostic stanzas with source excerpts, rule names, and action
 * hints. On a large project these stanzas easily run to hundreds of lines for
 * the same handful of rules.
 *
 * Compression model:
 *  - Group diagnostics by rule name across all files.
 *  - Keep up to 3 diagnostic stanzas per rule (file header + rule violation line
 *    + up to 2 source excerpt lines). Additional stanzas for the same rule are
 *    collapsed to a single count note.
 *  - Drop source-excerpt lines (NN │ code) beyond the first 2 per stanza — they
 *    are context that the agent does not need repeated.
 *  - Drop per-stanza action hint lines (i Use X instead.) — the rule name
 *    carries the fix information.
 *  - Keep the "Found N diagnostics" summary line verbatim.
 *  - Keep all error: / Error lines verbatim.
 *  - Pass-through when output <= 40 lines (already compact).
 */
export class BiomeFilter extends Filter {
  override name = "biome";
  override binaries: ReadonlySet<string> = new Set(["biome", "@biomejs/biome"]);

  override matches(argv: string[]): boolean {
    if (argv.length === 0) {
      return false;
    }
    const stem = _pathStemLower(argv[0]!);
    // Handle "npx biome" and "pnpx biome". "bunx biome" is intentionally NOT
    // claimed here: `bunx` is claimed by BunFilter which appears earlier in
    // FILTERS; bunx commands that don't match a specific bun subcommand fall
    // through to BunFilter's generic pass-through.
    if ((stem === "npx" || stem === "pnpx") && argv.length > 1) {
      const second = argv[1]!.toLowerCase();
      return second === "biome" || second === "@biomejs/biome";
    }
    return stem === "biome";
  }

  override compress(stdout: string, stderr: string, _exit_code: number, _argv: string[]): string {
    const merged = this._combine_output(stdout, stderr);
    const lines = merged.split("\n");
    const non_empty = lines.filter((ln) => ln.trim() !== "");

    if (non_empty.length <= 40) {
      return _rstrip(merged);
    }

    // Walk stanzas: each stanza is bounded by a file-header-like line or
    // rule-violation line. We group by rule code and keep the first 3 complete
    // stanzas per rule.
    const kept: string[] = [];
    const rule_count = new Map<string, number>(); // rule -> stanzas kept
    const rule_collapsed = new Map<string, number>(); // rule -> stanzas collapsed
    let in_stanza = false;
    let current_rule = "";
    let stanza_lines: string[] = [];
    let source_lines_in_stanza = 0;
    const _MAX_STANZAS_PER_RULE = 3;
    const _MAX_SOURCE_LINES = 2;

    const flush_stanza = (): void => {
      if (stanza_lines.length === 0) {
        return;
      }
      const rule = current_rule;
      const kept_count = rule_count.get(rule) ?? 0;
      if (kept_count < _MAX_STANZAS_PER_RULE) {
        rule_count.set(rule, kept_count + 1);
        kept.push(...stanza_lines);
      } else {
        rule_collapsed.set(rule, (rule_collapsed.get(rule) ?? 0) + 1);
      }
      stanza_lines = [];
      source_lines_in_stanza = 0;
    };

    for (const line of lines) {
      // Summary lines always pass through.
      if (_reMatch(_BIOME_SUMMARY_RE, line)) {
        flush_stanza();
        in_stanza = false;
        kept.push(line);
        continue;
      }
      // Error signals always pass through.
      if (_reSearchBool(_ERROR_SIGNAL_RE, line) && !_reMatch(_BIOME_SOURCE_LINE_RE, line)) {
        flush_stanza();
        in_stanza = false;
        kept.push(line);
        continue;
      }
      // Rule violation line starts a new stanza.
      if (_reMatch(_BIOME_RULE_LINE_RE, line)) {
        flush_stanza();
        const m = _reSearch(_BIOME_RULE_NAME_RE, line);
        current_rule = m ? m[1]! : "unknown";
        in_stanza = true;
        stanza_lines = [line];
        source_lines_in_stanza = 0;
        continue;
      }
      if (!in_stanza) {
        kept.push(line);
        continue;
      }
      // Inside a stanza: apply per-line rules.
      if (_reMatch(_BIOME_HINT_RE, line) || _reMatch(_BIOME_ANNOTATION_RE, line)) {
        // Drop action hints and annotations.
        continue;
      }
      if (_reMatch(_BIOME_SOURCE_LINE_RE, line)) {
        if (source_lines_in_stanza < _MAX_SOURCE_LINES) {
          stanza_lines.push(line);
          source_lines_in_stanza += 1;
        }
        // Else drop: we already have enough context.
        continue;
      }
      stanza_lines.push(line);
    }

    flush_stanza();

    // Emit collapse notes for rules that had stanzas dropped.
    if (rule_collapsed.size > 0) {
      for (const rule of [...rule_collapsed.keys()].sort()) {
        const cnt = rule_collapsed.get(rule)!;
        kept.push(
          `[token-goat: +${cnt} more ${rule} diagnostic(s) elided; ` +
            "run `biome check` for full output]",
        );
      }
    }

    return Filter._finalize(kept);
  }
}

/** Python str.rstrip() — strip trailing whitespace (the only place needed here). */
function _rstrip(s: string): string {
  return s.replace(/\s+$/u, "");
}
