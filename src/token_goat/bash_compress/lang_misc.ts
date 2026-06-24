/**
 * bash_compress LANG / MISC FILTERS — TypeScript port of the KtlintFilter,
 * ZigFilter, SassFilter, ElmFilter, JuliaFilter, ToxFilter, NoxFilter, and
 * CrystalFilter subclasses from src/token_goat/bash_compress.py (plus the
 * module-level ktlint / zig / sass / less / elm / julia / tox / nox / crystal
 * regex constants referenced by each compressor).
 *
 * The filters subclass the concrete Filter base from ./framework.js. Six of
 * the eight (Elm/Julia/Tox/Nox/Crystal plus the legacy Sass path) set
 * error_passthrough = true and override _compress_body (so the framework's
 * compress() template method short-circuits to raw stderr on non-zero exit);
 * the remaining two (Ktlint, Zig) and the main Sass branch override compress
 * directly because they handle errors structurally (keep error lines verbatim
 * inside the line-walk rather than passing the whole stderr through). Sass
 * also overrides matches() to accept binaries whose name contains a hyphen
 * (node-sass) — the base matches() already checks both stem and full name
 * against this.binaries, so the override is behaviourally identical to the
 * default; it is ported verbatim for parity.
 *
 * ---------------------------------------------------------------------------
 * Parity notes (Python -> TS)
 * ---------------------------------------------------------------------------
 *  - Python identifiers preserved EXACTLY: PascalCase class names; snake_case
 *    methods/fields (compress, _compress_body, matches; snake_case
 *    module-private regex constants _KTLINT_*, _ZIG_*, _SASS_*, _LESS_*,
 *    _ELM_*, _JULIA_*, _TOX_*, _NOX_*, _CRYSTAL_*; snake_case class fields
 *    _KEEP_PER_RULE, _STEP_SAMPLE, _WRITE_SAMPLE, _KEEP_PER_DEPRECATION,
 *    error_passthrough, subcommands).
 *  - re.compile(...) -> top-level RegExp compiled once at module load.
 *    re.IGNORECASE -> "i" flag. Python re.Pattern.match(line) is
 *    START-anchored (NOT end-anchored); emulated via _reMatch (non-global
 *    clone + index===0). .search() -> _reSearch (unanchored). Capture
 *    groups read via _reMatchObj (Python (?P<name>...) -> TS (?<name>...)).
 *  - _ERROR_SIGNAL_RE is framework-PRIVATE (not exported by framework.ts); it
 *    is re-declared MODULE-PRIVATE here (NOT exported) to avoid a duplicate-
 *    export ambiguity (TS2308) across the barrel export* chain. Verbatim
 *    copy of framework.ts line ~667.
 *  - PythonPath(argv[0]).stem.lower() / .name.lower() -> local _pathStem /
 *    _pathName helpers (final component, last suffix stripped for stem).
 *  - str.strip() -> _strip; str.rstrip() -> _rstrip; str.startswith("</") ->
 *    .trimStart().startsWith("</"); line.strip()[:60] -> _strip().slice(0,60).
 *  - Python list literal `list(step_sample)` -> [...step_sample] (shallow
 *    copy); `out.extend(kept)` -> out.push(...kept).
 *  - error_passthrough filters: the Python class attribute is mirrored as a TS
 *    instance field initialised to true; the framework's compress() reads
 *    this.error_passthrough and routes to _compress_body. noImplicitOverride
 *    is on -> compress/_compress_body/matches overrides carry `override`;
 *    error_passthrough and the _SAMPLE/_KEEP constants are declared fields
 *    (not overrides of a base member) so they take no `override` keyword.
 *  - _maybe_note / _positional_args are framework-PUBLIC and imported.
 *    _combine_output is an INSTANCE method; _finalize / _emit_notes are STATIC
 *    methods on Filter.
 *  - Python `dedup_deprecations.get(key, 0) + 1` -> (map.get(key) ?? 0) + 1.
 *  - Module-global mutable state: NONE. Every counter/dict/list is a local
 *    inside compress()/helpers; no registerReset seam is needed.
 *
 * detect_from_command gating (per filter, after _strip_prefixes / matches):
 *  - ktlint  : binaries {ktlint}; any subcommand.
 *  - zig     : binaries {zig}; any subcommand.
 *  - sass    : binaries {sass, scss, lessc, node-sass}; matches() accepts
 *              both stem and full filename (so node-sass lands here).
 *  - elm     : binaries {elm}; subcommands in {make, install, reactor,
 *              publish, diff, bump, init}; bare `elm` also matches.
 *  - julia   : binaries {julia}; any subcommand (error_passthrough).
 *  - tox     : binaries {tox}; any subcommand (error_passthrough).
 *  - nox     : binaries {nox}; any subcommand (error_passthrough).
 *  - crystal : binaries {crystal, shards}; any subcommand (error_passthrough).
 *
 * NOTE on import depth: this file lives in the bash_compress/ SUBDIR; the
 * framework is a SIBLING (./framework.js). verbatimModuleSyntax is on ->
 * nothing imported here is type-only. noImplicitOverride is on -> every
 * overridden member carries `override`.
 */

import { Filter, _maybe_note, _positional_args } from "./framework.js";

// ===========================================================================
// Internal Python-builtin / stdlib shims local to this module.
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
  const m = _nonGlobal(re).exec(line);
  return m !== null && m.index === 0 ? m : null;
}

/** Python re.Pattern.search(line) — boolean "matches anywhere". */
function _reSearch(re: RegExp, line: string): boolean {
  return _nonGlobal(re).test(line);
}

/**
 * pathlib.Path(s).stem — final path component with its LAST suffix removed.
 * Mirrors framework._pathStem semantics (a leading-dot dotfile keeps its name;
 * a trailing dot is not a suffix).
 */
function _pathStem(p: string): string {
  const norm = p.replace(/\\/g, "/").replace(/\/+$/, "");
  const idx = norm.lastIndexOf("/");
  const name = idx >= 0 ? norm.slice(idx + 1) : norm;
  const dot = name.lastIndexOf(".");
  if (dot <= 0 || dot === name.length - 1) {
    return name;
  }
  return name.slice(0, dot);
}

/** pathlib.Path(s).name — final path component (suffix preserved). */
function _pathName(p: string): string {
  const norm = p.replace(/\\/g, "/").replace(/\/+$/, "");
  const idx = norm.lastIndexOf("/");
  return idx >= 0 ? norm.slice(idx + 1) : norm;
}

// ===========================================================================
// Module-private framework regexes re-declared here (framework does NOT export
// _ERROR_SIGNAL_RE — re-exporting it would create a TS2308 ambiguity).
// ===========================================================================

/** Python _ERROR_SIGNAL_RE (framework-private) — re-declared module-private. */
const _ERROR_SIGNAL_RE: RegExp =
  /error:|Error:|ERROR|FAILED|failed|fatal:|Traceback|exception:|Exception:|AssertionError|assert |panic:/i;

// ===========================================================================
// ktlint (Kotlin linter) regexes (Python ~18664-18689).
// ===========================================================================

/**
 * ktlint plain-text issue line: "path/to/File.kt:12:5: error: ... (rule-id)".
 * Python: re.compile(r"^(.+\.kt):(\d+):(\d+):\s+(error|warning):\s+(.+)\s+\(([^)]+)\)$", re.IGNORECASE)
 */
const _KTLINT_ISSUE_RE: RegExp =
  /^(.+\.kt):(\d+):(\d+):\s+(error|warning):\s+(.+)\s+\(([^)]+)\)$/i;
/**
 * ktlint checkstyle XML wrapper lines — drop (only keep inner <error> lines).
 * Python: re.compile(r"^\s*<(?:\?xml|checkstyle|file)\b", re.IGNORECASE)
 */
const _KTLINT_CHECKSTYLE_TAG_RE: RegExp = /^\s*<(?:\?xml|checkstyle|file)\b/i;
/**
 * ktlint checkstyle <error> line: `<error line="1" column="5" severity="error" message="..." source="rule"/>`.
 * Python: re.compile(r'^\s*<error\b.*\bsource="([^"]+)"', re.IGNORECASE)
 */
const _KTLINT_CHECKSTYLE_ERROR_RE: RegExp = /^\s*<error\b.*\bsource="([^"]+)"/i;
/**
 * ktlint summary / footer lines — always keep.
 * Python: re.compile(r"^\s*(?:\d+\s+lint\s+error|ktlint\s+\d+\.\d+|Kotlin\s+style\s+guide"
 *                     r"|No\s+lint\s+errors|Resolving|Checking|Formatting)", re.IGNORECASE)
 */
const _KTLINT_SUMMARY_RE: RegExp =
  /^\s*(?:\d+\s+lint\s+error|ktlint\s+\d+\.\d+|Kotlin\s+style\s+guide|No\s+lint\s+errors|Resolving|Checking|Formatting)/i;
/**
 * ktlint per-rule-set header when running grouped mode.
 * Python: re.compile(r"^\s*\[ktlint(?::\S+)?\]", re.IGNORECASE)
 */
const _KTLINT_RULESET_HEADER_RE: RegExp = /^\s*\[ktlint(?::\S+)?\]/i;

// ===========================================================================
// KtlintFilter (Python ~18691-18842)
// ===========================================================================

/**
 * Compress `ktlint` Kotlin linter output.
 *
 * ktlint emits one line per violation (``path/file.kt:L:C: error: msg (rule-id)``).
 * On a large codebase or after an initial adoption, the same rule fires
 * hundreds of times across many files, drowning out rarer / higher-severity
 * issues.
 *
 * Deduplicates by rule-id (keep the first _KEEP_PER_RULE occurrences of each
 * rule, collapse the rest); always keeps `error`-severity lines; drops
 * checkstyle XML wrapper tags but keeps dedup'd `<error>` entries; always
 * keeps summary/footer/version-header lines; passes through everything else.
 */
export class KtlintFilter extends Filter {
  override name = "ktlint";
  override binaries: ReadonlySet<string> = new Set(["ktlint"]);

  _KEEP_PER_RULE: number = 3;

  override compress(stdout: string, stderr: string, _exit_code: number, _argv: string[]): string {
    const combined = this._combine_output(stdout, stderr);
    const lines = combined.split("\n");
    const kept: string[] = [];
    const rule_counts = new Map<string, number>();
    let deduplicated = 0;
    let dropped_xml_tags = 0;

    for (const line of lines) {
      // Summary / footer — always keep (check before error-signal so ktlint
      // version headers and clean-run messages are not mistaken for errors).
      if (_reMatch(_KTLINT_SUMMARY_RE, line) || _reMatch(_KTLINT_RULESET_HEADER_RE, line)) {
        kept.push(line);
        continue;
      }
      // Checkstyle XML wrapper tags (opening/self-closing) — drop.
      // Check BEFORE _ERROR_SIGNAL_RE because <checkstyle> / <file> tags
      // contain no actionable info and their text never matches known patterns.
      if (_reMatch(_KTLINT_CHECKSTYLE_TAG_RE, line)) {
        dropped_xml_tags += 1;
        continue;
      }
      // Closing XML tags (</file>, </checkstyle>) — drop silently.
      if (line.trim().startsWith("</")) {
        dropped_xml_tags += 1;
        continue;
      }
      // Checkstyle <error> line — must precede _ERROR_SIGNAL_RE check because
      // `<error ...>` text contains "error" which would fire the generic signal,
      // bypassing dedup logic.  Deduplicate by source/rule attribute.
      const m_cs = _reMatchObj(_KTLINT_CHECKSTYLE_ERROR_RE, line);
      if (m_cs) {
        const rule = m_cs[1]!;
        rule_counts.set(rule, (rule_counts.get(rule) ?? 0) + 1);
        const cnt = rule_counts.get(rule)!;
        // In checkstyle format there is no explicit severity field easy to
        // parse; treat all as dedup-eligible (error-severity entries are
        // typically unique so the 3-limit still preserves them in practice).
        if (cnt <= this._KEEP_PER_RULE) {
          kept.push(line);
        } else {
          if (cnt === this._KEEP_PER_RULE + 1) {
            kept.push(
              `  [token-goat: +? more ${rule} violations; ` +
                `disable via TOKEN_GOAT_BASH_COMPRESS for full list]`,
            );
          }
          deduplicated += 1;
        }
        continue;
      }
      // Plain-text issue line — dedup by rule-id; always keep error severity.
      // Must also precede _ERROR_SIGNAL_RE so that the file:line:col format is
      // checked first and severity is extracted cleanly.
      const m = _reMatchObj(_KTLINT_ISSUE_RE, line);
      if (m) {
        const severity = m[4]!.toLowerCase();
        const rule = m[6]!;
        rule_counts.set(rule, (rule_counts.get(rule) ?? 0) + 1);
        const cnt = rule_counts.get(rule)!;
        const always_keep = severity === "error";
        if (always_keep || cnt <= this._KEEP_PER_RULE) {
          kept.push(line);
        } else {
          if (cnt === this._KEEP_PER_RULE + 1) {
            kept.push(
              `[token-goat: +? more ${rule} warnings; ` +
                `disable via TOKEN_GOAT_BASH_COMPRESS for full list]`,
            );
          }
          deduplicated += 1;
        }
        continue;
      }
      // Error signal — always keep (generic fallback for unexpected formats).
      if (_reSearch(_ERROR_SIGNAL_RE, line)) {
        kept.push(line);
        continue;
      }
      kept.push(line);
    }

    const notes: string[] = [];
    _maybe_note(notes, deduplicated, `deduplicated ${deduplicated} repeated-rule violation lines`);
    _maybe_note(notes, dropped_xml_tags, `dropped ${dropped_xml_tags} checkstyle XML wrapper tags`);
    Filter._emit_notes(kept, notes);
    return Filter._finalize(kept);
  }
}

// ===========================================================================
// Zig build system regexes (Python ~18948-18984).
// ===========================================================================

/** Zig build step progress lines: "[N/M] zig build-exe ..." or "Building...". */
const _ZIG_BUILD_STEP_RE: RegExp = /^\s*\[\d+\/\d+\]\s+/;
/** Zig build summary on success: "Build Summary: N/M steps succeeded". */
const _ZIG_BUILD_SUMMARY_RE: RegExp =
  /^\s*Build\s+Summary:|^\s*\d+\s+step[s]?\s+(?:succeeded|failed)/i;
/** Zig compile error/note line: "path/file.zig:L:C: error: ...". */
const _ZIG_DIAG_RE: RegExp = /^(.+\.zig):(\d+):(\d+):\s+(error|note|warning):\s+/i;
/** Zig test result lines: 'test "name"... ' + result. */
const _ZIG_TEST_LINE_RE: RegExp = /^\s*test\s+"[^"]*"\.\.\./i;
/** Zig test pass — individual test line ending with "ok". */
const _ZIG_TEST_PASS_RE: RegExp = /\.\.\.\s+OK\s*$/i;
/** Zig test summary: "All N tests passed." or "N passed; M failed.". */
const _ZIG_TEST_SUMMARY_RE: RegExp =
  /^\s*(?:All \d+ tests? passed|Tests run:\s*\d|\d+ passed|\d+ test[s]? (?:passed|failed)|FAIL \()/i;
/** Zig fetch/dependency lines: "fetch ...  [checksum]". */
const _ZIG_FETCH_RE: RegExp =
  /^\s*(?:fetching|fetch\s+https?:\/\/|info:\s+Found\s+cached)|\bzig\s+fetch\b/i;
/** Zig "info: " prefix lines that are purely informational noise. */
const _ZIG_INFO_NOISE_RE: RegExp =
  /^\s*info:\s+(?:Resolving|Downloading|Checking|Extracting|Cached)\b/i;

// ===========================================================================
// ZigFilter (Python ~18844-18984)
// ===========================================================================

/**
 * Compress `zig build` / `zig test` output.
 *
 * Zig's build system emits `[N/M] step` progress lines for every compilation
 * unit (very verbose on large projects); the test runner emits one line per
 * passing test.
 *
 * Samples the first _STEP_SAMPLE build-step lines and collapses the rest;
 * counts passing tests (only failing/skipped preserved verbatim); always keeps
 * build/test summaries and diagnostic lines; collapses fetch/dependency noise;
 * drops informational `info:` noise on success (exit_code === 0).
 */
export class ZigFilter extends Filter {
  override name = "zig";
  override binaries: ReadonlySet<string> = new Set(["zig"]);

  _STEP_SAMPLE: number = 5;

  override compress(stdout: string, stderr: string, exit_code: number, _argv: string[]): string {
    const combined = this._combine_output(stdout, stderr);
    const lines = combined.split("\n");
    const kept: string[] = [];
    const step_sample: string[] = [];
    let step_extra = 0;
    let tests_passed = 0;
    let fetch_count = 0;
    let dropped_info = 0;

    for (const line of lines) {
      // Error signals — always keep
      if (_reSearch(_ERROR_SIGNAL_RE, line)) {
        kept.push(line);
        continue;
      }
      // Build / test summary — always keep
      if (_reMatch(_ZIG_BUILD_SUMMARY_RE, line) || _reMatch(_ZIG_TEST_SUMMARY_RE, line)) {
        kept.push(line);
        continue;
      }
      // Diagnostic lines — always keep
      if (_reMatch(_ZIG_DIAG_RE, line)) {
        kept.push(line);
        continue;
      }
      // Build step progress — sample
      if (_reMatch(_ZIG_BUILD_STEP_RE, line)) {
        if (step_sample.length < this._STEP_SAMPLE) {
          step_sample.push(line);
        } else {
          step_extra += 1;
        }
        continue;
      }
      // Test pass lines — count only
      if (_reMatch(_ZIG_TEST_LINE_RE, line) && _reSearch(_ZIG_TEST_PASS_RE, line)) {
        tests_passed += 1;
        continue;
      }
      // Fetch / dependency noise — count
      if (_reMatch(_ZIG_FETCH_RE, line)) {
        fetch_count += 1;
        continue;
      }
      // Informational noise — drop on success
      if (_reMatch(_ZIG_INFO_NOISE_RE, line) && exit_code === 0) {
        dropped_info += 1;
        continue;
      }
      kept.push(line);
    }

    // Emit step sample before the rest of kept
    const out: string[] = [...step_sample];
    if (step_extra) {
      out.push(
        `[token-goat: +${step_extra} more build steps; ` +
          `disable via TOKEN_GOAT_BASH_COMPRESS for full list]`,
      );
    }
    out.push(...kept);

    const notes: string[] = [];
    _maybe_note(notes, tests_passed, `collapsed ${tests_passed} passing test lines`);
    _maybe_note(notes, fetch_count, `collapsed ${fetch_count} fetch/dependency lines`);
    _maybe_note(notes, dropped_info, `dropped ${dropped_info} informational noise lines`);
    Filter._emit_notes(out, notes);
    return Filter._finalize(out);
  }
}

// ===========================================================================
// Sass / SCSS / Less CSS preprocessors regexes (Python ~18990-19440).
// ===========================================================================

/**
 * Sass/SCSS rendering progress line: "Rendering Complete, saving .css file...".
 * Python: re.compile(r"^\s*Rendering Complete|^\s*Wrote CSS to\b|^\s*Compiled\s+\S+\s+to\s+\S+"
 *                     r"|^\s*\S+\.(?:scss|sass|less)\s*→\s*\S+\.css", re.IGNORECASE)
 *
 * NOTE: the U+2192 arrow is a literal non-ASCII char in the Python source; we
 * keep it as a literal UTF-8 char inside the RegExp (it is not a U+2028/2029
 * line terminator, so it is safe inside a JS string).
 */
const _SASS_RENDERING_RE: RegExp =
  /^\s*Rendering Complete|^\s*Wrote CSS to\b|^\s*Compiled\s+\S+\s+to\s+\S+|^\s*\S+\.(?:scss|sass|less)\s*→\s*\S+\.css/i;
/** Sass individual file-write line: "      write dist/main.css". */
const _SASS_WRITE_RE: RegExp = /^\s+(?:write|wrote|output|compiled|created|Compiled)\s+\S+\.css/i;
/** Sass source-map write line: "      write dist/main.css.map". */
const _SASS_MAP_WRITE_RE: RegExp = /^\s+(?:write|wrote)\s+\S+\.(?:css\.map|map)\s*$/i;
/** Sass deprecation warning — flag first occurrence per message, collapse rest. */
const _SASS_DEPRECATION_RE: RegExp =
  /^\s*(?:Deprecation\s+Warning|DEPRECATION\s+WARNING|DeprecationWarning)\b/i;
/** Sass error line: "Error: ..." or "   on line N of path/file.scss". */
const _SASS_ERROR_RE: RegExp = /^\s*(?:Error:|on\s+line\s+\d+\s+of\b)/i;
/**
 * Sass/node-sass compilation summary.
 * Python: re.compile(r"^\s*(?:Compilation\s+(?:complete|failed)|sass\s+\d+\.\d+|"
 *                     r"\d+\s+file[s]?\s+(?:compiled|written|processed)|"
 *                     r"Finished\s+'sass'|Done\s+compiling\s+sass|"
 *                     r"No\s+changes,?\s+done|done\s+in\s+[\d.]+)", re.IGNORECASE)
 */
const _SASS_SUMMARY_RE: RegExp =
  /^\s*(?:Compilation\s+(?:complete|failed)|sass\s+\d+\.\d+|\d+\s+file[s]?\s+(?:compiled|written|processed)|Finished\s+'sass'|Done\s+compiling\s+sass|No\s+changes,?\s+done|done\s+in\s+[\d.]+)/i;
/** Less.js per-file compile line: "lessc input.less output.css". */
const _LESS_COMPILE_LINE_RE: RegExp = /^\s*lessc\s+\S+\.less\s+\S+\.css/i;
/** Less.js parse error: "ParseError: ...". */
const _LESS_ERROR_RE: RegExp = /^\s*(?:ParseError|NameError|FileError):\s/i;

// ===========================================================================
// SassFilter (Python ~19471-19620)
// ===========================================================================

/**
 * Compress `sass` / `scss` / `lessc` CSS preprocessor output.
 *
 * Both Sass (Dart Sass, node-sass) and Less emit one line per compiled output
 * file plus optional source-map writes.  On a large project this is dozens of
 * lines before any summary.
 *
 * Keeps the first _WRITE_SAMPLE file-write lines (collapses the rest);
 * always drops source-map writes; deduplicates deprecation warnings (first
 * _KEEP_PER_DEPRECATION occurrences per ~60-char key, rest collapsed);
 * always keeps error lines (Error: + `on line N of` context) and
 * summary/completion lines.
 */
export class SassFilter extends Filter {
  override name = "sass";
  override binaries: ReadonlySet<string> = new Set(["sass", "scss", "lessc", "node-sass"]);

  override matches(argv: string[]): boolean {
    if (argv.length === 0) {
      return false;
    }
    const stem = _pathStem(argv[0]!).toLowerCase();
    const name = _pathName(argv[0]!).toLowerCase();
    return this.binaries.has(stem) || this.binaries.has(name);
  }

  _WRITE_SAMPLE: number = 5;
  _KEEP_PER_DEPRECATION: number = 2;

  override compress(stdout: string, stderr: string, _exit_code: number, _argv: string[]): string {
    const combined = this._combine_output(stdout, stderr);
    const lines = combined.split("\n");
    const kept: string[] = [];
    const write_sample: string[] = [];
    let write_extra = 0;
    let dropped_map = 0;
    const dedup_deprecations = new Map<string, number>();
    let collapsed_deprecations = 0;

    for (const line of lines) {
      // Error signals — always keep
      if (_reSearch(_ERROR_SIGNAL_RE, line) || _reMatch(_SASS_ERROR_RE, line) || _reMatch(_LESS_ERROR_RE, line)) {
        kept.push(line);
        continue;
      }
      // Summary / completion lines — always keep
      if (_reMatch(_SASS_SUMMARY_RE, line) || _reMatch(_SASS_RENDERING_RE, line)) {
        kept.push(line);
        continue;
      }
      // Source-map write lines — always drop
      if (_reMatch(_SASS_MAP_WRITE_RE, line)) {
        dropped_map += 1;
        continue;
      }
      // Deprecation warnings — dedup by first ~60 chars as key
      if (_reMatch(_SASS_DEPRECATION_RE, line)) {
        const key = _strip(line).slice(0, 60);
        dedup_deprecations.set(key, (dedup_deprecations.get(key) ?? 0) + 1);
        if (dedup_deprecations.get(key)! <= this._KEEP_PER_DEPRECATION) {
          kept.push(line);
        } else {
          collapsed_deprecations += 1;
        }
        continue;
      }
      // File-write lines — sample
      if (_reMatch(_SASS_WRITE_RE, line)) {
        if (write_sample.length < this._WRITE_SAMPLE) {
          write_sample.push(line);
        } else {
          write_extra += 1;
        }
        continue;
      }
      kept.push(line);
    }

    const out: string[] = [...write_sample];
    if (write_extra) {
      out.push(
        `[token-goat: +${write_extra} more compiled CSS files; ` +
          `disable via TOKEN_GOAT_BASH_COMPRESS for full list]`,
      );
    }
    out.push(...kept);

    const notes: string[] = [];
    _maybe_note(notes, dropped_map, `dropped ${dropped_map} source-map write lines`);
    _maybe_note(notes, collapsed_deprecations, `collapsed ${collapsed_deprecations} duplicate deprecation warnings`);
    Filter._emit_notes(out, notes);
    return Filter._finalize(out);
  }
}

// ===========================================================================
// Elm compiler / reactor regexes (Python ~19447-19471).
// ===========================================================================

/** Elm compilation progress: "Starting downloads..." / "Downloading ..." lines. */
const _ELM_DOWNLOADING_RE: RegExp =
  /^\s*(?:Starting downloads\.\.\.|Downloading\s+\S+\s+\(\d+\.\d+\.\d+\))/i;
/** Elm dependency fetch counts: "Success! Fetched N packages." */
const _ELM_FETCH_SUCCESS_RE: RegExp =
  /^\s*(?:Success!\s+Fetched\s+\d+\s+package|Packages\s+configured\s+successfully)/i;
/** Elm compilation progress dot line: "....." (spinner/progress chars only). */
const _ELM_DOT_PROGRESS_RE: RegExp = /^\s*[\.]+\s*$/;
/** Elm "Building dependencies" or "Verifying dependencies". */
const _ELM_DEPS_PROGRESS_RE: RegExp =
  /^\s*(?:Building dependencies|Verifying\s+(?:dependencies|packages)|Updating\s+package\s+catalog|Solving\s+dependencies)/i;
/** Elm "Compiling file.elm" progress line. */
const _ELM_COMPILING_RE: RegExp = /^\s*(?:Compiling\s+\S+\.elm|Starting\s+compilation)/i;
/** Elm success: "Successfully generated output.js" or "Success! Compiled N modules". */
const _ELM_SUCCESS_RE: RegExp =
  /^\s*(?:Success!|Successfully\s+generated|Compilation\s+complete|Done!\s+Compiled\s+\d+)/i;
/** Elm error block headers: "-- TYPE MISMATCH ----" or "-- MISSING PATTERNS --". */
const _ELM_ERROR_HEADER_RE: RegExp =
  /^\s*--\s+[A-Z][A-Z0-9 _]+[A-Z0-9]\s*(?:-+|in\s+\S+)?\s*$/;
/** Elm "Detected N errors" or final "I ran into N problems" summary. */
const _ELM_ERROR_SUMMARY_RE: RegExp =
  /^\s*(?:Detected\s+\d+\s+error|I\s+ran\s+into\s+\d+\s+problem|\d+\s+error[s]?\s+found)/i;

// ===========================================================================
// ElmFilter (Python ~19471-19620)
// ===========================================================================

/**
 * Compress `elm make` / `elm reactor` / `elm install` output.
 *
 * Elm emits verbose dependency-resolution and compilation lines that carry
 * little signal for the model.
 *
 * Collapses downloading/fetching and `Compiling file.elm` lines to counts;
 * drops `Building dependencies` / `Verifying packages` / dot-only progress;
 * always keeps success summaries, error block headers, error details, and
 * diagnostic context. error_passthrough preserves raw stderr on non-zero exit.
 */
export class ElmFilter extends Filter {
  override error_passthrough = true;

  override name = "elm";
  override binaries: ReadonlySet<string> = new Set(["elm"]);
  override subcommands: ReadonlySet<string> = new Set([
    "make",
    "install",
    "reactor",
    "publish",
    "diff",
    "bump",
    "init",
  ]);

  override matches(argv: string[]): boolean {
    if (argv.length === 0) {
      return false;
    }
    const stem = _pathStem(argv[0]!).toLowerCase();
    if (stem !== "elm") {
      return false;
    }
    const positionals = _positional_args(argv.slice(1));
    if (positionals.length === 0) {
      return true;
    }
    return this.subcommands.has(positionals[0]!);
  }

  override _compress_body(stdout: string, stderr: string, _exit_code: number, _argv: string[]): string {
    const combined = this._combine_output(stdout, stderr);
    const lines = combined.split("\n");
    const kept: string[] = [];
    let downloading_count = 0;
    let compiling_count = 0;
    let dropped_noise = 0;

    for (const line of lines) {
      // Error signals and headers — always keep.
      if (_reSearch(_ERROR_SIGNAL_RE, line) || _reMatch(_ELM_ERROR_HEADER_RE, line)) {
        kept.push(line);
        continue;
      }
      // Summary lines — always keep.
      if (_reMatch(_ELM_SUCCESS_RE, line) || _reMatch(_ELM_ERROR_SUMMARY_RE, line)) {
        kept.push(line);
        continue;
      }
      // Downloading dependency lines — count.
      if (_reMatch(_ELM_DOWNLOADING_RE, line)) {
        downloading_count += 1;
        continue;
      }
      // Fetch success ("Fetched N packages") — keep.
      if (_reMatch(_ELM_FETCH_SUCCESS_RE, line)) {
        kept.push(line);
        continue;
      }
      // Dep-resolution noise — drop.
      if (_reMatch(_ELM_DEPS_PROGRESS_RE, line)) {
        dropped_noise += 1;
        continue;
      }
      // Dot-only progress — drop.
      if (_reMatch(_ELM_DOT_PROGRESS_RE, line)) {
        dropped_noise += 1;
        continue;
      }
      // "Compiling file.elm" lines — count.
      if (_reMatch(_ELM_COMPILING_RE, line)) {
        compiling_count += 1;
        continue;
      }
      kept.push(line);
    }

    const out: string[] = [];
    if (downloading_count) {
      out.push(
        `[token-goat: Downloaded ${downloading_count} Elm package(s); ` +
          `disable via TOKEN_GOAT_BASH_COMPRESS for full list]`,
      );
    }
    if (compiling_count) {
      out.push(`[token-goat: Compiled ${compiling_count} Elm module(s)]`);
    }
    out.push(...kept);

    const notes: string[] = [];
    _maybe_note(notes, dropped_noise, `dropped ${dropped_noise} Elm dependency-resolution progress lines`);
    Filter._emit_notes(out, notes);
    return Filter._finalize(out);
  }
}

// ===========================================================================
// Julia package manager / test runner regexes (Python ~19558-19620).
// ===========================================================================

/**
 * Julia Pkg "Resolving package versions..." or "Updating registry".
 * The leading (?:\x1b\[[0-9;]*m)? is an optional ANSI colour escape.
 * Python: re.compile(r"^\s*(?:\x1b\[[0-9;]*m)?\s*(?:Resolving|Updating|Fetching|Precompiling|"
 *                     r"Downgrading|Upgranding|Cloning|Archiving)\s+", re.IGNORECASE)
 */
const _JULIA_PKG_RESOLVING_RE: RegExp =
  /^\s*(?:\x1b\[[0-9;]*m)?\s*(?:Resolving|Updating|Fetching|Precompiling|Downgrading|Upgranding|Cloning|Archiving)\s+/i;
/**
 * Julia Pkg progress line with checkmark/arrow:
 *   "  [38d3cb4b] + CairoMakie v0.10.0"  or
 *   "  [7876af07] ↑ Example v0.5.0 ⇒ v0.5.1"
 * Python: re.compile(r"^\s*(?:\x1b\[[0-9;]*m)?\s*\[[0-9a-f]{8}\]\s+(?:[+\-↑↓~→⇒✓]|\w)")
 */
const _JULIA_PKG_DEP_LINE_RE: RegExp =
  /^\s*(?:\x1b\[[0-9;]*m)?\s*\[[0-9a-f]{8}\]\s+(?:[+\-↑↓~→⇒✓]|\w)/;
/** Julia Pkg "Installed PackageName ─────── v1.2.3". */
const _JULIA_PKG_INSTALLED_RE: RegExp = /^\s*(?:\x1b\[[0-9;]*m)?\s*Installed\s+\S+\s+/i;
/** Julia Pkg "Building PackageName → ..." build log line. */
const _JULIA_PKG_BUILDING_RE: RegExp =
  /^\s*(?:\x1b\[[0-9;]*m)?\s*Building\s+\S+\s*(?:→|->|─+)?\s*/i;
/** Julia Pkg status summary: "Status `Project.toml`" or "Updating `Manifest.toml`". */
const _JULIA_PKG_STATUS_RE: RegExp = /^\s*(?:\x1b\[[0-9;]*m)?\s*Status\s+`/i;
/** Julia test pass lines: "Test Summary: | Pass  Fail  Error  Total". */
const _JULIA_TEST_SUMMARY_RE: RegExp =
  /^\s*(?:Test\s+Summary:|Tests\s+run:|\d+\s+test[s]?\s+(?:passed|failed)|ALL_TESTS_PASS|Testing\s+\S+\s+done|No\s+tests\s+failed)/i;
/** Julia test pass line (individual): "  ✓ test name" or "Test Passed: ...". */
const _JULIA_TEST_PASS_RE: RegExp = /^\s*(?:✓|PASS:|Test\s+Passed)\s+/i;
/** Julia "Testing PackageName" header — always keep. */
const _JULIA_TESTING_HEADER_RE: RegExp = /^\s*(?:\x1b\[[0-9;]*m)?\s*Testing\s+\S+/i;
/** Julia "Precompiling X packages..." lines (noise). */
const _JULIA_PRECOMPILE_RE: RegExp =
  /^\s*(?:\x1b\[[0-9;]*m)?\s*\d+\s+(?:package[s]?\s+being\s+precompiled|dependency\s+precompil)/i;

// ===========================================================================
// JuliaFilter (Python ~19620-19804)
// ===========================================================================

/**
 * Compress Julia `Pkg` operations and `Pkg.test` / `julia --project test` output.
 *
 * Julia's package manager (Pkg) emits one line per dependency during add,
 * update, resolve, and precompile (routinely 50-200 lines); the test runner
 * outputs one pass line per passing test.
 *
 * Collapses Pkg dependency/installed/progress-banner lines to counts; always
 * keeps Pkg Building lines (build logs carry signal on failure), Status header,
 * test summary, Testing header, and failure/error lines. Counts individual
 * passing test lines. error_passthrough preserves raw stderr on non-zero exit.
 */
export class JuliaFilter extends Filter {
  override error_passthrough = true;

  override name = "julia";
  override binaries: ReadonlySet<string> = new Set(["julia"]);

  override _compress_body(stdout: string, stderr: string, _exit_code: number, _argv: string[]): string {
    const combined = this._combine_output(stdout, stderr);
    const lines = combined.split("\n");
    const kept: string[] = [];
    let dep_count = 0;
    let pass_count = 0;
    let progress_count = 0;

    for (const line of lines) {
      // Error signals — always keep.
      if (_reSearch(_ERROR_SIGNAL_RE, line)) {
        kept.push(line);
        continue;
      }
      // Test summary and testing header — always keep.
      if (_reMatch(_JULIA_TEST_SUMMARY_RE, line) || _reMatch(_JULIA_TESTING_HEADER_RE, line)) {
        kept.push(line);
        continue;
      }
      // Pkg status header — always keep (documents env state).
      if (_reMatch(_JULIA_PKG_STATUS_RE, line)) {
        kept.push(line);
        continue;
      }
      // Pkg building lines — always keep (build output has error signal).
      if (_reMatch(_JULIA_PKG_BUILDING_RE, line)) {
        kept.push(line);
        continue;
      }
      // Pkg dependency change lines ([uuid] +/-/↑ PkgName v1.0) — count.
      if (_reMatch(_JULIA_PKG_DEP_LINE_RE, line)) {
        dep_count += 1;
        continue;
      }
      // Pkg installed lines — fold into dep count.
      if (_reMatch(_JULIA_PKG_INSTALLED_RE, line)) {
        dep_count += 1;
        continue;
      }
      // Pkg progress banners (Resolving/Updating/Fetching) — count.
      if (_reMatch(_JULIA_PKG_RESOLVING_RE, line) || _reMatch(_JULIA_PRECOMPILE_RE, line)) {
        progress_count += 1;
        continue;
      }
      // Individual passing test lines — count.
      if (_reMatch(_JULIA_TEST_PASS_RE, line)) {
        pass_count += 1;
        continue;
      }
      kept.push(line);
    }

    const out: string[] = [];
    if (dep_count) {
      out.push(
        `[token-goat: ${dep_count} Julia package operation(s) (add/update/install); ` +
          `disable via TOKEN_GOAT_BASH_COMPRESS for full list]`,
      );
    }
    if (progress_count) {
      out.push(
        `[token-goat: collapsed ${progress_count} Pkg progress banner(s) ` +
          `(Resolving/Updating/Fetching/Precompiling)]`,
      );
    }
    out.push(...kept);

    const notes: string[] = [];
    _maybe_note(notes, pass_count, `collapsed ${pass_count} passing Julia test lines`);
    Filter._emit_notes(out, notes);
    return Filter._finalize(out);
  }
}

// ===========================================================================
// Python tox multi-environment test runner regexes (Python ~19813-19804).
// ===========================================================================

/**
 * tox environment creation / recreation progress:
 *   ".pkg create: ..." / "py311: create" / "py311: install_deps"
 */
const _TOX_ENV_CREATE_RE: RegExp =
  /^\s*(?:\S+:\s+create(?:virtualenv)?|\S+:\s+install(?:pkg|_deps|_package)?\s*$|\.pkg\s+(?:create|install|build-wheel|_check_passed))/i;
/** tox session header: "tox run -e py311,py312" or "ROOT: ..." or "default environments". */
const _TOX_SESSION_HEADER_RE: RegExp =
  /^\s*(?:tox\s+run\b|ROOT:|default\s+environments:|configured\s+environments:|additional\s+environments:|run-test(?:-pre)?:\s|GLOB\s+sdist\s*[-–])/i;
/** tox "PASSED" environment line: "  py311: commands succeeded". */
const _TOX_PASSED_RE: RegExp = /^\s*(?:\S+:\s+)?commands\s+succeeded\s*$/i;
/** tox "FAILED" environment line: "  py311: commands failed" or "ERROR: ...". */
const _TOX_FAILED_RE: RegExp =
  /^\s*(?:\S+:\s+)?commands\s+failed\s*$|^\s*ERROR:\s+/i;
/** tox final summary: "congratulations :)" / "x passed, y skipped" / "N error(s)". */
const _TOX_FINAL_SUMMARY_RE: RegExp =
  /^\s*(?:congratulations\s*[:)]+|\d+\s+(?:passed|failed|error).*in\s+[\d.]+s|(?:all\s+)?\d+\s+test[s]?\s+(?:passed|failed)|={3,}\s+\d+\s+(?:passed|failed))/i;
/** tox individual env result summary line: "  py311: OK (Ns)" or "  py311: FAIL". */
const _TOX_ENV_RESULT_RE: RegExp =
  /^\s*(?:\S+\s+)+(?:OK|FAIL(?:ED)?|PASSED|skipped)\s*(?:\(\d+[\d.]*s\))?\s*$/i;
/** tox package install progress inside an env: "  .pkg: install …" / "  .pkg: wheel-editable". */
const _TOX_PKG_INSTALL_RE: RegExp =
  /^\s*\.pkg:\s+(?:inst|install|build-wheel|wheel-editable|_check_passed)\b/i;
/** tox "run-test-pre" / "run-test:" label line — transitional noise. */
const _TOX_RUN_LABEL_RE: RegExp =
  /^\s*\S+:\s+(?:run-test-pre|run-test|create|recreate|inst(?:all(?:pkg|deps)?)?)\s*$/i;
/** tox environment header when it starts executing. */
const _TOX_ENV_HEADER_RE: RegExp = /^\s*\S+\s+(?:run-test(?:-pre)?|recreate|install(?:pkg|deps)?):\s+/;
/**
 * pip progress inside tox environments (no env prefix — raw pip output).
 * "Successfully installed ..." is intentionally NOT matched so the summary is kept.
 */
const _TOX_PIP_PROGRESS_RE: RegExp =
  /^\s*(?:Collecting\s|Downloading\s|Using\s+cached\s|Installing\s+collected\s+packages|Building\s+wheel\s+for|Created\s+wheel\s+for|Preparing\s+metadata|Obtaining\s+file:\/\/|Getting\s+requirements\s+to\s+build)/;
/** pip >= 22 Unicode download progress bar inside tox environments. */
const _TOX_PIP_BAR_RE: RegExp = /^\s*━+\s+[\d.]+\/[\d.]/;
/** "Requirement already satisfied: <pkg>…" lines inside tox environments. */
const _TOX_REQ_SATISFIED_RE: RegExp = /^\s*Requirement\s+already\s+satisfied:/;
/** tox 4 visual separator lines between env sections. */
const _TOX_SEPARATOR_RE: RegExp = /^\s*━{5,}\s+\S+\s+━{5,}\s*$/;
/** tox 4 parallel-runner polling lines emitted during `tox run-parallel`. */
const _TOX_STILL_RUNNING_RE: RegExp = /^\s*\S+:\s+still\s+running\b/i;

// ===========================================================================
// ToxFilter (Python ~19804-19947)
// ===========================================================================

/**
 * Compress Python `tox` multi-environment test-runner output.
 *
 * tox orchestrates isolated virtualenv creation, package installation, and
 * test execution across multiple Python versions. A typical `tox -e
 * py311,py312,py313` run emits dozens of virtualenv-creation and
 * package-installation lines that carry no failure signal.
 *
 * Collapses env-create/install/label/pip-progress/req-satisfied/separator/
 * polling noise to counts; always keeps session headers, FAILED/ERROR lines,
 * final summaries, per-env result lines, env execution headers, and
 * `Successfully installed` (pytest output inside each env passes through to
 * PytestFilter in the call chain). error_passthrough preserves raw stderr on
 * non-zero exit.
 */
export class ToxFilter extends Filter {
  override error_passthrough = true;

  override name = "tox";
  override binaries: ReadonlySet<string> = new Set(["tox"]);

  override _compress_body(stdout: string, stderr: string, _exit_code: number, _argv: string[]): string {
    const combined = this._combine_output(stdout, stderr);
    const lines = combined.split("\n");
    const kept: string[] = [];
    let dropped_create = 0;
    let dropped_pip = 0;
    let dropped_req_satisfied = 0;
    let dropped_separators = 0;
    let dropped_polling = 0;

    for (const line of lines) {
      // Error signals — always keep.
      if (_reSearch(_ERROR_SIGNAL_RE, line) || _reMatch(_TOX_FAILED_RE, line)) {
        kept.push(line);
        continue;
      }
      // Session-level headers and final summaries — always keep.
      if (
        _reMatch(_TOX_SESSION_HEADER_RE, line) ||
        _reMatch(_TOX_FINAL_SUMMARY_RE, line) ||
        _reMatch(_TOX_ENV_RESULT_RE, line) ||
        _reMatch(_TOX_PASSED_RE, line)
      ) {
        kept.push(line);
        continue;
      }
      // Env execution header (e.g. "py311 run-test: pytest tests/") — keep.
      if (_reMatch(_TOX_ENV_HEADER_RE, line)) {
        kept.push(line);
        continue;
      }
      // Env creation / install / pkg-build noise — count.
      if (
        _reMatch(_TOX_ENV_CREATE_RE, line) ||
        _reMatch(_TOX_PKG_INSTALL_RE, line) ||
        _reMatch(_TOX_RUN_LABEL_RE, line)
      ) {
        dropped_create += 1;
        continue;
      }
      // pip progress (Collecting / Downloading / Using cached / …) and
      // Unicode download progress bars — accumulate separately.
      if (_reMatch(_TOX_PIP_PROGRESS_RE, line) || _reMatch(_TOX_PIP_BAR_RE, line)) {
        dropped_pip += 1;
        continue;
      }
      // "Requirement already satisfied:" — very numerous on env reuse.
      if (_reMatch(_TOX_REQ_SATISFIED_RE, line)) {
        dropped_req_satisfied += 1;
        continue;
      }
      // tox 4 visual separator lines (━━━━━━ py3.11 ━━━━━━) — pure noise.
      if (_reMatch(_TOX_SEPARATOR_RE, line)) {
        dropped_separators += 1;
        continue;
      }
      // tox 4 parallel-runner polling lines (py311: still running ...).
      if (_reMatch(_TOX_STILL_RUNNING_RE, line)) {
        dropped_polling += 1;
        continue;
      }
      kept.push(line);
    }

    const notes: string[] = [];
    if (dropped_create) {
      notes.push(`collapsed ${dropped_create} tox env-create/install progress lines`);
    }
    _maybe_note(notes, dropped_pip, `collapsed ${dropped_pip} pip install progress lines`);
    _maybe_note(notes, dropped_req_satisfied, `collapsed ${dropped_req_satisfied} 'Requirement already satisfied' lines`);
    _maybe_note(notes, dropped_separators, `dropped ${dropped_separators} tox separator lines`);
    _maybe_note(notes, dropped_polling, `dropped ${dropped_polling} tox parallel-runner polling lines`);
    Filter._emit_notes(kept, notes);
    return Filter._finalize(kept);
  }
}

// ===========================================================================
// Python nox task automation regexes (Python ~19948-19967).
// ===========================================================================

/**
 * nox "Creating virtual environment..." line — env setup noise.
 * Example: "nox > Creating virtual environment (virtualenv) using python3.12 in .nox/tests-3-12"
 */
const _NOX_CREATE_VENV_RE: RegExp = /^nox\s+>\s+Creating\s+virtual\s+environment\b/i;
/** nox "Re-using existing virtual environment..." — reuse notice (setup noise). */
const _NOX_REUSE_VENV_RE: RegExp = /^nox\s+>\s+Re-?using\s+existing\s+virtual\s+environment\b/i;
/** pip "Requirement already satisfied: <pkg>..." lines inside nox sessions. */
const _NOX_REQ_SATISFIED_RE: RegExp = /^Requirement already satisfied:/;
/**
 * pip progress inside nox sessions: Collecting / Downloading / Using cached /
 * Building wheel / Prepared metadata / Installing collected / Obtaining file://.
 * "Successfully installed ..." is intentionally NOT matched so the install summary is kept.
 */
const _NOX_PIP_PROGRESS_RE: RegExp =
  /^\s*(?:Collecting\s|Downloading\s|Using\s+cached\s|Installing\s+collected\s+packages|Building\s+wheel\s+for|Created\s+wheel\s+for|Preparing\s+metadata|Obtaining\s+file:\/\/|Getting\s+requirements\s+to\s+build)/i;
/** pip >= 22 Unicode download progress bar. */
const _NOX_PIP_BAR_RE: RegExp = /^\s*━+\s+[\d.]/;

// ===========================================================================
// NoxFilter (Python ~19947-20067)
// ===========================================================================

/**
 * Compress Python `nox` task-automation output.
 *
 * nox orchestrates isolated virtualenv creation, dependency installation, and
 * arbitrary session commands (tests, linting, type-checking) across multiple
 * Python versions. A typical `nox -s tests lint` run emits virtualenv-creation
 * lines, pip download/install progress, and the session command output — only
 * the last category carries signal.
 *
 * Collapses env create/reuse, pip progress (Collecting/Downloading/Using
 * cached/Unicode bars/Installing collected/Building wheel/Preparing metadata),
 * and `Requirement already satisfied` lines to counts. All other lines
 * (session run/result, Successfully installed, test output, errors) pass
 * through. error_passthrough preserves raw stderr on non-zero exit.
 */
export class NoxFilter extends Filter {
  override error_passthrough = true;

  override name = "nox";
  override binaries: ReadonlySet<string> = new Set(["nox"]);

  override _compress_body(stdout: string, stderr: string, _exit_code: number, _argv: string[]): string {
    const combined = this._combine_output(stdout, stderr);
    const lines = combined.split("\n");
    const kept: string[] = [];
    let env_noise = 0;
    let pip_noise = 0;
    let req_satisfied = 0;

    for (const line of lines) {
      // Error signals — always keep regardless of source.
      if (_reSearch(_ERROR_SIGNAL_RE, line)) {
        kept.push(line);
        continue;
      }
      // nox env create / reuse setup noise.
      if (_reMatch(_NOX_CREATE_VENV_RE, line) || _reMatch(_NOX_REUSE_VENV_RE, line)) {
        env_noise += 1;
        continue;
      }
      // pip progress lines within nox sessions (Collecting, Downloading, …).
      if (_reMatch(_NOX_PIP_PROGRESS_RE, line)) {
        pip_noise += 1;
        continue;
      }
      // pip >= 22 Unicode download progress bar (e.g. "   ━━━━ 343.3/343.3 kB …").
      // Uses anchored regex to avoid catching rich/pytest section separators.
      if (_reMatch(_NOX_PIP_BAR_RE, line)) {
        pip_noise += 1;
        continue;
      }
      // "Requirement already satisfied: <pkg>" — very numerous on env reuse.
      if (_reMatch(_NOX_REQ_SATISFIED_RE, line)) {
        req_satisfied += 1;
        continue;
      }
      kept.push(line);
    }

    const notes: string[] = [];
    _maybe_note(notes, env_noise, `collapsed ${env_noise} nox env-create/reuse lines`);
    _maybe_note(notes, pip_noise, `collapsed ${pip_noise} pip install progress lines`);
    _maybe_note(notes, req_satisfied, `collapsed ${req_satisfied} 'Requirement already satisfied' lines`);
    Filter._emit_notes(kept, notes);
    return Filter._finalize(kept);
  }
}

// ===========================================================================
// Crystal language spec runner / shards dependency manager regexes
// (Python ~19985-20067).
// ===========================================================================

/** Crystal spec "Compiling <file>" or "Linking crystal spec" progress lines. */
const _CRYSTAL_COMPILING_RE: RegExp =
  /^\s*(?:Compiling\s+\S+|Linking\s+crystal\s+spec|crystal\s+spec\s+\S+\.cr\b)/i;
/** Crystal spec individual pass line: "  ✓ description (Xms)" or dot run. */
const _CRYSTAL_SPEC_PASS_RE: RegExp = /^\s*(?:\.\s*)+$|^\s*✓\s+.+\(\d+/i;
/** Crystal spec dot-only progress line (when running without verbose). */
const _CRYSTAL_DOT_PROGRESS_RE: RegExp = /^\s*[.]+\s*$/;
/** Crystal spec summary: "Finished in X seconds" / "N examples, M failures". */
const _CRYSTAL_SUMMARY_RE: RegExp =
  /^\s*(?:Finished\s+in\s+[\d.]+\s+(?:second|millisecond)|\d+\s+example[s]?[,\s]|Pending:\s+\d+|\d+\s+failure[s]?|(?:All\s+)?\d+\s+spec[s]?\s+(?:passed|failed))/i;
/** Crystal spec failure block header: "Failures:" or "  1) DescriptionPath". */
const _CRYSTAL_FAILURE_HEADER_RE: RegExp = /^\s*(?:Failures:|Errors:|\d+\)\s+\S)/i;
/** Crystal "shards install" / "shards update" progress lines. */
const _CRYSTAL_SHARDS_PROGRESS_RE: RegExp =
  /^\s*(?:Using\s+\S+\s+\(|Writing\s+shard\.lock|Fetching\s+https?:\/\/|Cloning\s+\S+|Resolving\s+\S+|Updating\s+\S+\s+\(|Installed\s+\S+|Installing\s+\S+)/i;
/** Crystal "shards install" final summary: "Shards are up to date." / "N shards installed". */
const _CRYSTAL_SHARDS_DONE_RE: RegExp =
  /^\s*(?:Shards\s+are\s+up\s+to\s+date|\d+\s+shard[s]?\s+(?:installed|updated)|Dependencies\s+installed)/i;

// ===========================================================================
// CrystalFilter (Python ~20067-...)
// ===========================================================================

/**
 * Compress Crystal language `crystal spec` / `shards` output.
 *
 * Crystal's spec runner (its built-in test framework, inspired by RSpec) and
 * the `shards` dependency manager both produce noisy output: compilation
 * progress lines, dot-per-test pass lines, and shard installation chatter.
 *
 * Collapses compilation/linking, individual passing spec, and shards
 * install/update progress lines to counts; drops dot-only progress; always
 * keeps spec summaries, shards-done lines, failure block headers, and error
 * lines (full failure detail follows verbatim). error_passthrough preserves
 * raw stderr on non-zero exit.
 */
export class CrystalFilter extends Filter {
  override error_passthrough = true;

  override name = "crystal";
  override binaries: ReadonlySet<string> = new Set(["crystal", "shards"]);

  override _compress_body(stdout: string, stderr: string, _exit_code: number, _argv: string[]): string {
    const combined = this._combine_output(stdout, stderr);
    const lines = combined.split("\n");
    const kept: string[] = [];
    let compiling_count = 0;
    let pass_count = 0;
    let shard_progress_count = 0;
    let dot_count = 0;

    for (const line of lines) {
      // Error signals and failure headers — always keep.
      if (_reSearch(_ERROR_SIGNAL_RE, line) || _reMatch(_CRYSTAL_FAILURE_HEADER_RE, line)) {
        kept.push(line);
        continue;
      }
      // Spec summary and shards-done lines — always keep.
      if (_reMatch(_CRYSTAL_SUMMARY_RE, line) || _reMatch(_CRYSTAL_SHARDS_DONE_RE, line)) {
        kept.push(line);
        continue;
      }
      // Compilation / linking progress — count.
      if (_reMatch(_CRYSTAL_COMPILING_RE, line)) {
        compiling_count += 1;
        continue;
      }
      // Dot-only progress lines — drop.
      if (_reMatch(_CRYSTAL_DOT_PROGRESS_RE, line)) {
        dot_count += 1;
        continue;
      }
      // Individual passing spec lines — count.
      if (_reMatch(_CRYSTAL_SPEC_PASS_RE, line)) {
        pass_count += 1;
        continue;
      }
      // Shards install/update progress — count.
      if (_reMatch(_CRYSTAL_SHARDS_PROGRESS_RE, line)) {
        shard_progress_count += 1;
        continue;
      }
      kept.push(line);
    }

    const out: string[] = [];
    if (compiling_count) {
      out.push(
        `[token-goat: collapsed ${compiling_count} Crystal compilation/linking line(s); ` +
          `disable via TOKEN_GOAT_BASH_COMPRESS for full output]`,
      );
    }
    if (shard_progress_count) {
      out.push(
        `[token-goat: ${shard_progress_count} shard dependency action(s) ` +
          `(Using/Fetching/Installing); disable via TOKEN_GOAT_BASH_COMPRESS for full list]`,
      );
    }
    out.push(...kept);

    const notes: string[] = [];
    _maybe_note(notes, pass_count, `collapsed ${pass_count} passing Crystal spec line(s)`);
    _maybe_note(notes, dot_count, `dropped ${dot_count} dot-progress line(s)`);
    Filter._emit_notes(out, notes);
    return Filter._finalize(out);
  }
}
