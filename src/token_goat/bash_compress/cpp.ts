/**
 * bash_compress LANG / C++ FILTERS — TypeScript port of the ConanFilter,
 * VcpkgFilter, CppcheckFilter, and ClangTidyFilter Filter subclasses from
 * src/token_goat/bash_compress.py (plus the module-level _CONAN_* / _VCPKG_* /
 * _CPPCHECK_* / _CLANG_TIDY_* regexes each references).
 *
 * Four filters subclass the concrete Filter base from ./framework.js:
 *   - ConanFilter     — `conan` / `conan2` install/create/build (collapse
 *                       per-package lifecycle + download-progress lines; keep
 *                       Requirements/Packages resolution blocks, Install
 *                       finished/Package created summaries, error diagnostics).
 *                       Sets error_passthrough = true and overrides
 *                       _compress_body (NOT compress).
 *   - VcpkgFilter     — `vcpkg` install/upgrade (collapse Building/Installing
 *                       <port>:triplet + sub-step lines; drop Elapsed time /
 *                       Detecting compiler hash; keep plan summary + done
 *                       lines + error diagnostics). Sets error_passthrough =
 *                       true and overrides _compress_body (NOT compress).
 *   - CppcheckFilter  — `cppcheck` static analysis (collapse Checking <file>
 *                       progress + N/M files checked percentage lines + config
 *                       verbose lines; keep [file:N]: (severity) diagnostics,
 *                       summary lines, error signals). error_passthrough stays
 *                       false (default); overrides compress directly.
 *   - ClangTidyFilter — `clang-tidy` / `run-clang-tidy` / `run-clang-tidy.py`
 *                       linter (keep diagnostic headers + note: fix-it lines +
 *                       first context block per diagnostic; collapse extra
 *                       caret/source-context lines, "In file included from"
 *                       chains, "N warnings generated." per-file progress;
 *                       keep summary lines + error signals). error_passthrough
 *                       stays false (default); overrides compress directly.
 *
 * ---------------------------------------------------------------------------
 * Parity notes (Python -> TS)
 * ---------------------------------------------------------------------------
 *  - Python identifiers preserved EXACTLY: PascalCase class names; snake_case
 *    methods/fields (matches via the inherited default, _compress_body for the
 *    two error_passthrough filters, compress for the other two); snake_case
 *    module-private regex constants (_CONAN_*, _VCPKG_*, _CPPCHECK_*,
 *    _CLANG_TIDY_*).
 *  - re.compile(...) -> top-level RegExp compiled once at module load.
 *    re.IGNORECASE -> "i". Python re.Pattern.match(line) is START-anchored (NOT
 *    end-anchored); emulated via _reMatch (non-global clone + index===0).
 *    .search() -> _reSearch (non-global clone, .test anywhere).
 *  - The inline ``re.match(r"^(\d+)", line)`` call inside ClangTidyFilter
 *    (Python line ~21369) reads capture group 1 from a START-anchored match;
 *    ported via _reMatchObj on a local _LEADING_DIGITS_RE and Number(m[1]).
 *  - _ERROR_SIGNAL_RE is framework-PRIVATE (not exported by framework.ts); it
 *    is re-declared MODULE-PRIVATE here (NOT exported) to avoid a duplicate-
 *    export ambiguity (TS2308) across the barrel export* chain. Every filter
 *    module that needs it carries its own identical private copy.
 *  - error_passthrough semantics: ConanFilter and VcpkgFilter set
 *    ``error_passthrough = True`` in Python (a ClassVar). In TS the framework
 *    declares it as an instance field defaulting to false; the override
 *    ``override error_passthrough = true`` on the subclass is observably
 *    identical for the ``this.error_passthrough`` read in Filter.compress().
 *    The two filters therefore override ``_compress_body`` (the template-method
 *    hook) rather than ``compress`` itself — the inherited Filter.compress
 *    short-circuits to raw error output (via _preserve_stderr_on_error) on a
 *    non-zero exit with non-empty stderr BEFORE _compress_body runs. The
 *    Cppcheck / ClangTidy filters leave error_passthrough = false and override
 *    ``compress`` directly (they keep error lines structurally during the
 *    line-walk, so the short-circuit is unwanted).
 *  - _combine_output is an INSTANCE method on Filter; _finalize / _emit_notes
 *    are STATIC methods (invoked as Filter._finalize / Filter._emit_notes, or
 *    via the subclass name — both resolve to the same static). _maybe_note is a
 *    framework-PUBLIC function imported here.
 *  - Python f-string counts (e.g. ``f"{building_count} Building"``) -> template
 *    literals; ``", ".join(parts)`` -> parts.join(", ").
 *  - Module-global mutable state: NONE. Every counter/list is a local inside
 *    compress()/_compress_body; no registerReset seam is needed.
 *
 * detect_from_command gating (per filter, after _strip_prefixes / matches):
 *  - conan       : binaries {conan, conan2}; any subcommand (default
 *                  binaries-based matches()).
 *  - vcpkg       : binaries {vcpkg}; any subcommand (default binaries-based
 *                  matches()).
 *  - cppcheck    : binaries {cppcheck}; any subcommand (default binaries-based
 *                  matches()).
 *  - clang-tidy  : binaries {clang-tidy, run-clang-tidy, run-clang-tidy.py};
 *                  any subcommand (default binaries-based matches()).
 *
 * NOTE on import depth: this file lives in the bash_compress/ SUBDIR; the
 * framework is a SIBLING (./framework.js). verbatimModuleSyntax is on ->
 * nothing imported here is type-only. noImplicitOverride is on -> every
 * overridden member carries `override`.
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

/** Python re.Pattern.search(line) — boolean "matches anywhere". */
function _reSearch(re: RegExp, line: string): boolean {
  return _nonGlobal(re).test(line);
}

/**
 * Python re.Pattern.match(line) returning the match object (or null) for the
 * callers that read capture groups. Non-global clone so lastIndex never leaks;
 * index===0 enforces the START-anchored semantics of .match().
 */
function _reMatchObj(re: RegExp, line: string): RegExpExecArray | null {
  const m = _nonGlobal(re).exec(line);
  return m !== null && m.index === 0 ? m : null;
}

// ===========================================================================
// Module-private framework regex re-declared here (framework does NOT export
// _ERROR_SIGNAL_RE — re-exporting it would create a TS2308 ambiguity).
// ===========================================================================

/**
 * Python _ERROR_SIGNAL_RE (framework-private) — re-declared MODULE-PRIVATE.
 * Verbatim copy of framework.ts line 667 source/flags.
 */
const _ERROR_SIGNAL_RE: RegExp =
  /error:|Error:|ERROR|FAILED|failed|fatal:|Traceback|exception:|Exception:|AssertionError|assert |panic:/i;

// ===========================================================================
// Conan regexes (Python ~20909-20945).
// ===========================================================================

/**
 * Conan install/create per-package lifecycle lines:
 * ``package/1.0: Calling build()`` / ``package/1.0: Package 'abc123' created``.
 */
const _CONAN_PKG_PROGRESS_RE: RegExp =
  /^[\w.+-]+\/[\w.+:-]+(?:@[\w/]+)?\s*:\s+(?:Package\s+'[0-9a-f]+'\s+(?:created|already exists|built)|Calling\s+(?:build|package|package_info|config_options|configure|requirements|package_id|validate|generate|layout)\(\)|Exporting\s+package|Copying|Generating\s+(?:the\s+)?(?:package|generators)|Building\s+(?:the\s+)?package|Decompressing\s+|Downloading|WARN:\s+Build\s+folder\s+is\s+different)/;
/** Conan ``Requirement`` / ``Packages:`` dependency-resolution summary lines. */
const _CONAN_REQUIREMENT_RE: RegExp =
  /^(?:Requirement|Graph\s+root|Requirements?:|Packages:|Build\s+requirements?:)/i;
/** Conan ``Install finished`` / ``Package installed`` summary — always keep. */
const _CONAN_DONE_RE: RegExp =
  /^(?:Install\s+finished|Conan\s+profile:|Cross\s+build\s+from|Package\s+(?:installed|created))/i;
/** Conan download-progress lines (``Downloading conan_sources.tgz``). */
const _CONAN_DOWNLOAD_RE: RegExp =
  /^(?:Downloading\s+conan_|Checking\s+checksum|\d+\/\d+\s+bytes\s+downloaded)/i;

// ===========================================================================
// ConanFilter (Python ~20948-21013)
// ===========================================================================

/**
 * Compress ``conan install`` / ``conan create`` / ``conan build`` output.
 *
 * Conan C/C++ package manager emits verbose per-package lifecycle lines for
 * every dependency. On a project with 20+ transitive dependencies, the output
 * can easily run to 500+ lines even though nothing failed.
 *
 * Per-package lifecycle lines and download-progress lines are collapsed to a
 * count summary; ``Requirements:`` / ``Packages:`` resolution blocks,
 * ``Install finished`` / ``Package created`` summaries, and error/warning
 * diagnostics are always kept.
 */
export class ConanFilter extends Filter {
  override error_passthrough = true;

  override name = "conan";
  override binaries: ReadonlySet<string> = new Set(["conan", "conan2"]);

  override _compress_body(
    stdout: string,
    stderr: string,
    _exit_code: number,
    _argv: string[],
  ): string {
    const combined = this._combine_output(stdout, stderr);
    const lines = combined.split("\n");
    const kept: string[] = [];
    let pkg_progress_count = 0;
    let download_count = 0;

    for (const line of lines) {
      // Always keep error/warning diagnostics.
      if (_reSearch(_ERROR_SIGNAL_RE, line)) {
        kept.push(line);
        continue;
      }
      // Always keep summary/done lines.
      if (_reMatch(_CONAN_DONE_RE, line)) {
        kept.push(line);
        continue;
      }
      // Keep dependency resolution summary blocks.
      if (_reMatch(_CONAN_REQUIREMENT_RE, line)) {
        kept.push(line);
        continue;
      }
      // Collapse per-package lifecycle lines.
      if (_reMatch(_CONAN_PKG_PROGRESS_RE, line)) {
        pkg_progress_count += 1;
        continue;
      }
      // Collapse download-progress lines.
      if (_reMatch(_CONAN_DOWNLOAD_RE, line)) {
        download_count += 1;
        continue;
      }
      kept.push(line);
    }

    const notes: string[] = [];
    const total_dropped = pkg_progress_count + download_count;
    if (total_dropped) {
      const parts: string[] = [];
      if (pkg_progress_count) {
        parts.push(`${pkg_progress_count} package lifecycle`);
      }
      if (download_count) {
        parts.push(`${download_count} download`);
      }
      notes.push(`collapsed ${total_dropped} conan progress lines (${parts.join(", ")})`);
    }
    Filter._emit_notes(kept, notes);
    return Filter._finalize(kept);
  }
}

// ===========================================================================
// vcpkg regexes (Python ~21019-21063).
// ===========================================================================

/** vcpkg ``Building <port>:x64-linux...`` progress line. */
const _VCPKG_BUILDING_RE: RegExp = /^Building\s+\S+:\S+\.\.\./;
/** vcpkg ``Installing <port>:x64-linux...`` progress line. */
const _VCPKG_INSTALLING_RE: RegExp = /^Installing\s+\S+:\S+\.\.\./;
/** vcpkg ``Detecting compiler hash for triplet ...`` line. */
const _VCPKG_DETECTING_RE: RegExp = /^Detecting\s+compiler\s+hash/;
/**
 * vcpkg ``The following packages will be built and installed:`` or
 * ``Additional packages ( * ) will be modified to complete this operation.``
 */
const _VCPKG_PLAN_RE: RegExp =
  /^(?:The\s+following\s+packages\s+will\s+be|Additional\s+packages\s+\(\*\))/i;
/** vcpkg ``Elapsed time for package <name>: N.Nms`` — timing noise. */
const _VCPKG_ELAPSED_RE: RegExp = /^Elapsed\s+time\s+for\s+package\s+\S+:\s+\d/;
/** vcpkg success / done summary lines. */
const _VCPKG_DONE_RE: RegExp =
  /^(?:Total\s+install\s+time:|CMake\s+projects\s+should\s+use|All\s+requested\s+packages\s+are\s+currently\s+installed|Package\s+\S+:\S+\s+is\s+already\s+installed)/i;
/** vcpkg per-file extraction: ``  -- Extracting source ...`` sub-step lines. */
const _VCPKG_EXTRACTING_RE: RegExp =
  /^\s*--\s+(?:Extracting\s+source|Applying\s+patch|Using\s+cached\s+archive|Downloading\s+https?:\/\/|Fetching\s+\S+|Stored\s+binaries\s+in\s+)/i;

// ===========================================================================
// VcpkgFilter (Python ~21066-21141)
// ===========================================================================

/**
 * Compress ``vcpkg install`` / ``vcpkg upgrade`` output.
 *
 * vcpkg emits one ``Building <port>:triplet...`` and ``Installing <port>:triplet...``
 * line per port, plus sub-step lines for source extraction, patch application,
 * and binary caching. A project with 30 transitive dependencies generates 60+
 * progress lines before any compiler output appears.
 *
 * Building/Installing lines and per-step sub-lines are collapsed to counts;
 * Elapsed-time and compiler-hash-detection lines are dropped; the plan summary
 * and done/completion lines are kept; error/warning diagnostics are kept
 * verbatim.
 */
export class VcpkgFilter extends Filter {
  override error_passthrough = true;

  override name = "vcpkg";
  override binaries: ReadonlySet<string> = new Set(["vcpkg"]);

  override _compress_body(
    stdout: string,
    stderr: string,
    _exit_code: number,
    _argv: string[],
  ): string {
    const combined = this._combine_output(stdout, stderr);
    const lines = combined.split("\n");
    const kept: string[] = [];
    let building_count = 0;
    let installing_count = 0;
    let substep_count = 0;
    let timing_count = 0;

    for (const line of lines) {
      // Always keep error/warning diagnostics.
      if (_reSearch(_ERROR_SIGNAL_RE, line)) {
        kept.push(line);
        continue;
      }
      // Always keep plan and completion lines.
      if (_reMatch(_VCPKG_PLAN_RE, line) || _reMatch(_VCPKG_DONE_RE, line)) {
        kept.push(line);
        continue;
      }
      // Collapse "Building <port>:triplet..." lines.
      if (_reMatch(_VCPKG_BUILDING_RE, line)) {
        building_count += 1;
        continue;
      }
      // Collapse "Installing <port>:triplet..." lines.
      if (_reMatch(_VCPKG_INSTALLING_RE, line)) {
        installing_count += 1;
        continue;
      }
      // Collapse sub-step lines (extracting, patching, downloading).
      if (_reMatch(_VCPKG_EXTRACTING_RE, line)) {
        substep_count += 1;
        continue;
      }
      // Drop elapsed-time and compiler-hash-detection noise.
      if (_reMatch(_VCPKG_ELAPSED_RE, line) || _reMatch(_VCPKG_DETECTING_RE, line)) {
        timing_count += 1;
        continue;
      }
      kept.push(line);
    }

    const notes: string[] = [];
    if (building_count || installing_count) {
      const parts: string[] = [];
      if (building_count) {
        parts.push(`${building_count} Building`);
      }
      if (installing_count) {
        parts.push(`${installing_count} Installing`);
      }
      notes.push(
        `collapsed ${building_count + installing_count} vcpkg port lines (${parts.join(", ")})`,
      );
    }
    _maybe_note(notes, substep_count, `collapsed ${substep_count} vcpkg sub-step lines`);
    _maybe_note(notes, timing_count, `dropped ${timing_count} vcpkg timing/detection lines`);
    Filter._emit_notes(kept, notes);
    return Filter._finalize(kept);
  }
}

// ===========================================================================
// cppcheck regexes (Python ~21147-21184).
// ===========================================================================

/** cppcheck ``Checking <file>...`` progress line. */
const _CPPCHECK_CHECKING_RE: RegExp = /^Checking\s+\S.*\.\.\./;
/** cppcheck ``N/M files checked N% done`` progress line. */
const _CPPCHECK_PROGRESS_RE: RegExp = /^\d+\/\d+\s+files\s+checked\s+\d+%\s+done/;
/**
 * cppcheck diagnostic line:
 * ``[file.cpp:N]: (error|warning|style|...) message``.
 */
const _CPPCHECK_DIAGNOSTIC_RE: RegExp =
  /^\[.+\.(?:c|cpp|cxx|cc|h|hpp|hxx):\d+\]:/;
/** cppcheck ``[file]: (error|warning|...) message`` variant (no line number). */
const _CPPCHECK_DIAG_NOLINE_RE: RegExp =
  /^\[.+\]:\s*\((?:error|warning|style|performance|portability|information)\)/i;
/** cppcheck ``Checking configuration`` verbose-mode lines. */
const _CPPCHECK_CONFIG_RE: RegExp =
  /^(?:Checking\s+configuration|Active\s+checkers:|Enabled\s+checkers:|cppcheck:\s+(?:error:|warning:|note:))/i;
/** cppcheck ``N errors`` / ``N warnings`` summary line. */
const _CPPCHECK_SUMMARY_RE: RegExp =
  /^(?:\d+\s+(?:error|warning|style|performance|portability)s?(?:\s+(?:found|detected))?|No\s+errors\s+found|Done\s+processing|cppcheck:\s+.*(?:done|finished)|\d+\s+unique\s+error)/i;

// ===========================================================================
// CppcheckFilter (Python ~21187-21254)
// ===========================================================================

/**
 * Compress ``cppcheck`` C/C++ static analysis output.
 *
 * cppcheck emits one ``Checking <file>...`` progress line per translation unit
 * and (in verbose/progress mode) one ``N/M files checked N% done`` line per
 * batch. On a project with hundreds of files these are pure noise unless a
 * diagnostic follows.
 *
 * Diagnostic lines and summary lines are always kept verbatim; Checking and
 * verbose config lines are collapsed to counts; file-progress percentage lines
 * are dropped; error/warning signals in any other line are always kept.
 *
 * cppcheck sends most output (including diagnostics) to stderr by default, so
 * both streams are combined so nothing is lost.
 */
export class CppcheckFilter extends Filter {
  override name = "cppcheck";
  override binaries: ReadonlySet<string> = new Set(["cppcheck"]);

  override compress(
    stdout: string,
    stderr: string,
    _exit_code: number,
    _argv: string[],
  ): string {
    // cppcheck sends most output (including diagnostics) to stderr by default.
    // Combine both streams so nothing is lost.
    const combined = this._combine_output(stdout, stderr);
    const lines = combined.split("\n");
    const kept: string[] = [];
    let checking_count = 0;
    let progress_count = 0;
    let config_count = 0;

    for (const line of lines) {
      // Always keep diagnostic lines — these are the primary output.
      if (_reMatch(_CPPCHECK_DIAGNOSTIC_RE, line) || _reMatch(_CPPCHECK_DIAG_NOLINE_RE, line)) {
        kept.push(line);
        continue;
      }
      // Always keep generic error/warning signals.
      if (_reSearch(_ERROR_SIGNAL_RE, line)) {
        kept.push(line);
        continue;
      }
      // Always keep summary lines.
      if (_reMatch(_CPPCHECK_SUMMARY_RE, line)) {
        kept.push(line);
        continue;
      }
      // Collapse "Checking <file>..." progress.
      if (_reMatch(_CPPCHECK_CHECKING_RE, line)) {
        checking_count += 1;
        continue;
      }
      // Drop "N/M files checked N% done" lines — captured by count above.
      if (_reMatch(_CPPCHECK_PROGRESS_RE, line)) {
        progress_count += 1;
        continue;
      }
      // Collapse verbose "Checking configuration..." lines.
      if (_reMatch(_CPPCHECK_CONFIG_RE, line)) {
        config_count += 1;
        continue;
      }
      kept.push(line);
    }

    const notes: string[] = [];
    _maybe_note(notes, checking_count, `collapsed ${checking_count} 'Checking <file>...' progress lines`);
    _maybe_note(notes, progress_count, `dropped ${progress_count} file-progress percentage lines`);
    _maybe_note(notes, config_count, `collapsed ${config_count} configuration-check lines`);
    Filter._emit_notes(kept, notes);
    return Filter._finalize(kept);
  }
}

// ===========================================================================
// clang-tidy regexes (Python ~21260-21299).
// ===========================================================================

/** clang-tidy per-file progress: ``N warnings generated.`` */
const _CLANG_TIDY_WARNINGS_GENERATED_RE: RegExp = /^\d+\s+warning(?:s)?\s+generated\./;
/** clang-tidy ``clang-tidy: Processing N files...`` (only shown with -p). */
const _CLANG_TIDY_PROCESSING_RE: RegExp = /^clang-tidy:\s+Processing\s+\d+/i;
/** clang-tidy diagnostic header: ``file.cpp:N:N: warning: message [check-name]``. */
const _CLANG_TIDY_DIAG_RE: RegExp =
  /^.+\.(?:c|cpp|cxx|cc|h|hpp|hxx):\d+:\d+:\s+(?:error|warning|note|remark):/;
/** clang-tidy ``note: did you mean ...`` detail line (diagnostic context). */
const _CLANG_TIDY_NOTE_RE: RegExp = /^.+:\d+:\d+:\s+note:/;
/**
 * clang-tidy code-context lines: the source excerpt and caret line that appear
 * under each diagnostic. Highly verbose — 2 lines per diagnostic per include
 * chain. Collapsed after keeping the first.
 *
 * NOTE: the Python pattern uses two top-level alternatives each starting with
 * ``^`` (``r"^\s+(?:\^[~\^]*|~+)\s*$|^   {4,}\S"``); JS RegExp treats the
 * embedded ``^`` as a literal-inside-the-alternation that still means
 * start-of-string for the second branch, matching the Python re.match
 * semantics for both branches.
 */
const _CLANG_TIDY_CONTEXT_RE: RegExp = /^\s+(?:\^[~^]*|~+)\s*$|^\s{4,}\S/;
/** clang-tidy ``In file included from ...`` expansion lines. */
const _CLANG_TIDY_INCLUDE_RE: RegExp = /^In\s+file\s+included\s+from\s+/;
/** clang-tidy ``clang-tidy: N warnings treated as errors`` summary. */
const _CLANG_TIDY_SUMMARY_RE: RegExp =
  /^(?:clang-tidy:\s+\d+|Suppressed\s+\d+|\d+\s+warning[s]?\s+(?:treated\s+as\s+error|and\s+\d+\s+error))/i;

/**
 * Local clone of the inline ``re.match(r"^(\d+)", line)`` Python call inside
 * ClangTidyFilter (Python line ~21369) — START-anchored, captures leading
 * digits so the warnings total can be summed.
 */
const _LEADING_DIGITS_RE: RegExp = /^(\d+)/;

// ===========================================================================
// ClangTidyFilter (Python ~21302-21398)
// ===========================================================================

/**
 * Compress ``clang-tidy`` C/C++ linter output.
 *
 * clang-tidy emits a structured diagnostic per check violation, but surrounds
 * each diagnostic with verbose source-context lines (the offending source text
 * plus caret underlines) and ``In file included from`` expansion chains. On
 * large codebases each actual violation can generate 10-30 context lines,
 * inflating 20 real findings to 200+ output lines.
 *
 * Diagnostic headers are always kept verbatim; ``note:`` lines following a
 * diagnostic are kept (fix-it hints); source-context lines keep at most one
 * block per diagnostic and the rest are dropped; ``In file included from``
 * chains and ``N warnings generated.`` progress lines are collapsed to counts;
 * summary lines and error/warning signals in any other line are always kept.
 *
 * clang-tidy sends diagnostics to stdout and progress to stderr, so both
 * streams are combined.
 */
export class ClangTidyFilter extends Filter {
  override name = "clang-tidy";
  override binaries: ReadonlySet<string> = new Set([
    "clang-tidy",
    "run-clang-tidy",
    "run-clang-tidy.py",
  ]);

  override compress(
    stdout: string,
    stderr: string,
    _exit_code: number,
    _argv: string[],
  ): string {
    // clang-tidy sends diagnostics to stdout and progress to stderr.
    const combined = this._combine_output(stdout, stderr);
    const lines = combined.split("\n");
    const kept: string[] = [];
    let warnings_generated = 0;
    let include_chains = 0;
    let context_dropped = 0;
    // Track whether we are inside the context block of a diagnostic.
    let in_diag_context = false;
    let context_kept_for_current = false;

    for (const line of lines) {
      // Summary lines — always keep.
      if (_reMatch(_CLANG_TIDY_SUMMARY_RE, line)) {
        kept.push(line);
        in_diag_context = false;
        context_kept_for_current = false;
        continue;
      }
      // Diagnostic headers — always keep; begin a new context block.
      if (_reMatch(_CLANG_TIDY_DIAG_RE, line)) {
        kept.push(line);
        in_diag_context = true;
        context_kept_for_current = false;
        continue;
      }
      // Note lines following a diagnostic — always keep (fix-it hints).
      if (_reMatch(_CLANG_TIDY_NOTE_RE, line) && in_diag_context) {
        kept.push(line);
        continue;
      }
      // Error/warning signals outside of the structured diagnostic format.
      if (_reSearch(_ERROR_SIGNAL_RE, line)) {
        kept.push(line);
        in_diag_context = false;
        continue;
      }
      // "N warnings generated." per-file progress — count.
      if (_reMatch(_CLANG_TIDY_WARNINGS_GENERATED_RE, line)) {
        // Python: m = re.match(r"^(\d+)", line); warnings_generated += int(m.group(1))
        const m = _reMatchObj(_LEADING_DIGITS_RE, line);
        if (m) {
          warnings_generated += Number(m[1]);
        }
        continue;
      }
      // "clang-tidy: Processing N files..." progress.
      if (_reMatch(_CLANG_TIDY_PROCESSING_RE, line)) {
        continue;
      }
      // "In file included from ..." — count.
      if (_reMatch(_CLANG_TIDY_INCLUDE_RE, line)) {
        include_chains += 1;
        continue;
      }
      // Source-context / caret lines: keep at most one block per diagnostic.
      if (_reMatch(_CLANG_TIDY_CONTEXT_RE, line) && in_diag_context) {
        if (!context_kept_for_current) {
          kept.push(line);
          context_kept_for_current = true;
        } else {
          context_dropped += 1;
        }
        continue;
      }
      // Any other line resets the in-context state.
      in_diag_context = false;
      context_kept_for_current = false;
      kept.push(line);
    }

    const notes: string[] = [];
    _maybe_note(
      notes,
      warnings_generated,
      `collapsed ${warnings_generated} total 'N warnings generated' progress lines`,
    );
    _maybe_note(notes, include_chains, `collapsed ${include_chains} 'In file included from' chains`);
    _maybe_note(
      notes,
      context_dropped,
      `dropped ${context_dropped} redundant source-context/caret lines`,
    );
    Filter._emit_notes(kept, notes);
    return Filter._finalize(kept);
  }
}
