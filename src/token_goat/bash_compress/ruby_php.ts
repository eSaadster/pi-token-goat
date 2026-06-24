/**
 * bash_compress RUBY / PHP / ELIXIR / CMAKE TAIL filters — TypeScript port of the
 * RubyFilter, BundlerFilter, CmakeFilter, MixFilter, ComposerFilter, and
 * PhpStanFilter classes from src/token_goat/bash_compress.py (Run 8).
 *
 * Each class is a faithful 1:1 port of its Python counterpart:
 *  - RubyFilter      — ruby / rspec / minitest / rake dot-progress compression.
 *  - BundlerFilter   — bundle install/update "Using/Fetching gem" collapsing.
 *  - CmakeFilter     — cmake configure/build + ctest result compression.
 *  - MixFilter       — Elixir mix deps.get/compile/test/ecto.migrate.
 *  - ComposerFilter  — PHP composer install/update/require collapsing.
 *  - PhpStanFilter   — phpstan / psalm static-analysis dedup.
 *
 * ---------------------------------------------------------------------------
 * Parity notes (Python -> TS)
 * ---------------------------------------------------------------------------
 *  - Python identifiers preserved EXACTLY: PascalCase class names; snake_case
 *    methods/fields and SCREAMING_SNAKE regex constants.
 *  - re.compile(...) -> top-level RegExp compiled once at module load, flags
 *    preserved (IGNORECASE -> "i"). Python's re.Pattern.match() is START-anchored
 *    (not end-anchored) -> emulated via _reMatch (non-global clone + index===0).
 *    re.Pattern.search() -> _reSearch (.test on a non-global clone). Capture-group
 *    callers use _reMatchObj.
 *  - Path(argv[0]).stem.lower() -> _pathStemLower (final component after backslash
 *    normalisation, LAST suffix removed, lowercased).
 *  - _ERROR_SIGNAL_RE is framework-PRIVATE (framework.ts does NOT export it). It is
 *    re-declared MODULE-PRIVATE here (NOT exported) so the barrel export* chain
 *    never sees two _ERROR_SIGNAL_RE bindings (that would be a TS2308 ambiguity).
 *  - _combine_output is an INSTANCE method on Filter; _finalize / _emit_notes are
 *    STATIC methods on Filter; _maybe_note / _positional_args / _dedup_lines are
 *    framework-PUBLIC free functions — all imported, never re-implemented.
 *  - Module-global mutable state: NONE — every filter is purely functional over
 *    its inputs, so there is nothing to registerReset.
 *
 * NOTE on import depth: this file lives in the bash_compress/ SUBDIR; the
 * framework is a sibling ("./framework.js").
 *
 * verbatimModuleSyntax is on -> nothing here needs `import type`.
 * noUncheckedIndexedAccess is on -> every indexed access is narrowed.
 */

import {
  Filter,
  _dedup_lines,
  _maybe_note,
  _positional_args,
  _squeeze_blank_lines,
  dedupe_consecutive,
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
  const m = _nonGlobal(re).exec(line);
  return m !== null && m.index === 0;
}

/** Python re.Pattern.search(line) — boolean "matches anywhere". */
function _reSearch(re: RegExp, line: string): boolean {
  return _nonGlobal(re).test(line);
}

/**
 * Python re.Pattern.match(line) returning the match object (or null) for callers
 * that read capture groups. Non-global clone so lastIndex never leaks;
 * index===0 enforces the START-anchored semantics of .match().
 */
function _reMatchObj(re: RegExp, line: string): RegExpExecArray | null {
  const m = _nonGlobal(re).exec(line);
  return m !== null && m.index === 0 ? m : null;
}

/**
 * Python Path(p).stem.lower() — the final path component (after normalising
 * backslashes to forward slashes) with its LAST suffix removed, lowercased.
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

/** Python Path(p).name.lower() — final path component (after backslash norm), lowercased. */
function _pathNameLower(p: string): string {
  const norm = p.replace(/\\/g, "/").replace(/\/+$/, "");
  const idx = norm.lastIndexOf("/");
  const name = idx >= 0 ? norm.slice(idx + 1) : norm;
  return name.toLowerCase();
}

/** Python str.count(sub) — count non-overlapping occurrences of sub in s. */
function _strCount(s: string, sub: string): number {
  if (sub === "") {
    return s.length + 1;
  }
  let count = 0;
  let idx = s.indexOf(sub);
  while (idx !== -1) {
    count += 1;
    idx = s.indexOf(sub, idx + sub.length);
  }
  return count;
}

// ===========================================================================
// Module-private framework regexes re-declared here (framework does NOT export
// _ERROR_SIGNAL_RE — re-exporting it would create a TS2308 ambiguity).
// ===========================================================================

/** Python _ERROR_SIGNAL_RE (framework-private) — re-declared module-private. */
const _ERROR_SIGNAL_RE: RegExp =
  /error:|Error:|ERROR|FAILED|failed|fatal:|Traceback|exception:|Exception:|AssertionError|assert |panic:/i;

// ===========================================================================
// Ruby / RSpec / Minitest regexes (Python ~13507-13528).
// ===========================================================================

/**
 * RSpec dot-progress line: a line containing only ".", "F", "E", "*" chars +
 * optional newline (emitted by RSpec's default progress formatter).
 */
const _RSPEC_PROGRESS_RE: RegExp = /^[\.FE\*]+$/;
/** RSpec example-summary line: "N examples, N failures" (or "N failure"). */
const _RSPEC_SUMMARY_RE: RegExp = /^\d+ examples?,\s+\d+ failures?/;
/** RSpec finished-with-time summary: "Finished in X seconds". */
const _RSPEC_FINISHED_RE: RegExp = /^Finished in \d/;
/** RSpec failure block header: "Failures:" section header. */
const _RSPEC_FAILURE_SECTION_RE: RegExp = /^Failures:\s*$/;
/** RSpec failed example index: "  1) SomeClass some method ..." (unused; ported for parity). */
const _RSPEC_FAIL_INDEX_RE: RegExp = /^\s+\d+\)\s+\S/;
/** Minitest pass-line: "X runs, X assertions, 0 failures, 0 errors, 0 skips". */
const _MINITEST_SUMMARY_RE: RegExp = /^\d+ runs?,\s+\d+ assertions?/;

// ===========================================================================
// RubyFilter
// ===========================================================================

/**
 * Compress ``ruby``, ``rspec``, ``minitest``, and ``rake`` output.
 *
 * RSpec default formatter emits a "." per passing example and an "F" / "E" per
 * failure, with full failure messages printed at the end. Minitest uses the
 * same dot-progress style.
 *
 * Compression model:
 *  - RSpec dot-progress lines: count "." chars (passes) and keep "F" / "E"
 *    chars (each signals a failure that will appear in the failure section).
 *    Emit a collapsed-count note in place of the dot-lines.
 *  - Keep the ``Failures:`` section and every failure block verbatim.
 *  - Keep the ``Finished in X seconds`` and ``N examples, N failures`` summary.
 *  - Minitest: same dot-counting; keep the ``N runs, N assertions`` summary.
 *  - rake: pass through with basic dedupe.
 */
export class RubyFilter extends Filter {
  override name = "ruby";
  override binaries: ReadonlySet<string> = new Set([
    "ruby",
    "rspec",
    "minitest",
    "rake",
    "rspec2",
  ]);

  override matches(argv: string[]): boolean {
    if (argv.length === 0) {
      return false;
    }
    const stem = _pathStemLower(argv[0]!);
    const name = _pathNameLower(argv[0]!);
    // Match rspec, minitest, ruby, rake directly. "bundle exec rspec" is handled
    // by prefix stripping → the inner binary (rspec) becomes argv[0] after
    // _strip_prefixes.
    return this.binaries.has(stem) || this.binaries.has(name);
  }

  override compress(stdout: string, stderr: string, _exit_code: number, argv: string[]): string {
    const merged = this._combine_output(stdout, stderr);

    const binary = argv.length > 0 ? _pathStemLower(argv[0]!) : "";

    // rake: dedupe only — task output is load-bearing.
    if (binary === "rake") {
      return _squeeze_blank_lines(dedupe_consecutive(merged.split("\n")).join("\n"));
    }

    // rspec / minitest / ruby: dot-progress compression.
    return this._compress_test(merged);
  }

  /** Collapse dot-progress, keep failures and summary lines. */
  _compress_test(text: string): string {
    const lines = text.split("\n");
    const kept: string[] = [];
    let pass_count = 0;
    let in_failure_section = false;

    for (const line of lines) {
      // Blank lines close the current fail block but are still kept for
      // separation when we are already in the failure section.
      if (line.trim() === "") {
        if (in_failure_section) {
          kept.push(line);
        }
        continue;
      }

      // RSpec "Failures:" section header.
      if (_reMatch(_RSPEC_FAILURE_SECTION_RE, line)) {
        in_failure_section = true;
        kept.push(line);
        continue;
      }

      // Inside the failure section: keep everything verbatim.
      if (in_failure_section) {
        kept.push(line);
        continue;
      }

      // Dot-progress lines: count passes, preserve failures.
      if (_reMatch(_RSPEC_PROGRESS_RE, line)) {
        const dot_passes = _strCount(line, ".");
        pass_count += dot_passes;
        // Keep any failure/error chars verbatim on a separate line so the agent
        // sees there are failures even before the Failures: block.
        const fail_chars = [...line].filter((c) => c === "F" || c === "E").join("");
        if (fail_chars) {
          kept.push(`[${fail_chars}]  (failures in progress output)`);
        }
        continue;
      }

      // Summary / finished lines: always keep.
      if (_reMatch(_RSPEC_SUMMARY_RE, line) || _reMatch(_MINITEST_SUMMARY_RE, line)) {
        kept.push(line);
        continue;
      }
      if (_reMatch(_RSPEC_FINISHED_RE, line)) {
        kept.push(line);
        continue;
      }

      // Everything else: keep.
      kept.push(line);
    }

    if (pass_count) {
      // Prepend the collapsed count just before the failure section (or at end).
      const note = `[token-goat: collapsed ${pass_count} passing examples/dots]`;
      // Insert before first kept failure-section line or at end.
      let inserted = false;
      for (let i = 0; i < kept.length; i += 1) {
        if (_reMatch(_RSPEC_FAILURE_SECTION_RE, kept[i]!)) {
          kept.splice(i, 0, note);
          inserted = true;
          break;
        }
      }
      if (!inserted) {
        kept.push(note);
      }
    }

    return Filter._finalize(kept);
  }
}

// ===========================================================================
// Bundler regexes (Python ~13644-13664).
// ===========================================================================

/** "Using gem-name N.N.N" lines emitted during `bundle install`. */
const _BUNDLER_USING_RE: RegExp = /^Using\s+\S+\s+[\d.]+/;
/** "Fetching gem-name N.N.N" or "Installing gem-name N.N.N" progress lines. */
const _BUNDLER_FETCH_INSTALL_RE: RegExp = /^(?:Fetching|Installing)\s+\S+\s+[\d.]+/;
/** Completion banners: "Bundle complete!" / "Bundle updated!". */
const _BUNDLER_COMPLETE_RE: RegExp = /^Bundle (?:complete!|updated!|installed!)/;
/** Gems-in-groups line: "Gems in the groups...". */
const _BUNDLER_GROUPS_RE: RegExp = /^Gems in the groups?/;
/** Gemfile.lock diff summary: "Gemfile.lock was changed" / "N gemfiles changed". */
const _BUNDLER_LOCK_SUMMARY_RE: RegExp =
  /^(?:Gemfile\.lock|gemfiles?) (?:was|were) (?:changed|updated)|^\d+ gems? (?:installed|updated|removed)/;

// ===========================================================================
// BundlerFilter
// ===========================================================================

/**
 * Compress ``bundle install``, ``bundle update``, and ``bundler`` output.
 *
 * Bundler emits one "Using gem-name version" line per gem already satisfied plus
 * "Fetching …" / "Installing …" lines for new gems. The only lines the agent
 * needs are the completion banner and any error output.
 *
 * Compression model:
 *  - Collapse "Using gem-name version" lines to a single count summary.
 *  - Collapse "Fetching … version" / "Installing … version" lines to a count.
 *  - Keep ``Bundle complete!`` / ``Bundle updated!`` banners verbatim.
 *  - Keep ``Gems in the groups: …`` lines verbatim.
 *  - Keep Gemfile.lock change-summary lines verbatim.
 *  - Keep every error/warning line verbatim.
 */
export class BundlerFilter extends Filter {
  override name = "bundler";
  override binaries: ReadonlySet<string> = new Set(["bundle", "bundler"]);

  override compress(stdout: string, stderr: string, _exit_code: number, _argv: string[]): string {
    const merged = this._combine_output(stdout, stderr);
    const lines = merged.split("\n");
    const kept: string[] = [];
    let using_count = 0;
    let fetch_install_count = 0;

    for (const line of lines) {
      // Always keep errors/warnings verbatim.
      if (_reSearch(_ERROR_SIGNAL_RE, line)) {
        kept.push(line);
        continue;
      }
      // Collapse "Using …" lines.
      if (_reMatch(_BUNDLER_USING_RE, line)) {
        using_count += 1;
        continue;
      }
      // Collapse "Fetching …" / "Installing …" lines.
      if (_reMatch(_BUNDLER_FETCH_INSTALL_RE, line)) {
        fetch_install_count += 1;
        continue;
      }
      // Keep completion banners, group lines, and lock summaries.
      if (
        _reMatch(_BUNDLER_COMPLETE_RE, line) ||
        _reMatch(_BUNDLER_GROUPS_RE, line) ||
        _reMatch(_BUNDLER_LOCK_SUMMARY_RE, line)
      ) {
        kept.push(line);
        continue;
      }
      // Everything else: keep.
      kept.push(line);
    }

    const notes: string[] = [];
    _maybe_note(notes, using_count, `collapsed ${using_count} 'Using gem' lines`);
    _maybe_note(
      notes,
      fetch_install_count,
      `collapsed ${fetch_install_count} 'Fetching/Installing gem' lines`,
    );
    Filter._emit_notes(kept, notes);
    return Filter._finalize(kept);
  }
}

// ===========================================================================
// cmake / ctest regexes (Python ~13732-13770).
// ===========================================================================

/** CMake configure-phase progress: "-- Configuring done (0.2s)". */
const _CMAKE_CONFIG_RE: RegExp =
  /^-- (?:Configuring|Generating|Build files|Detecting|Check for|Looking for|Found|Using|CMAKE|Performing Test|Could(?: NOT)? find|The (?:C|CXX|Fortran) compiler)/;
/** CMake "-- Found PackageName: ..." package-found lines. */
const _CMAKE_FOUND_RE: RegExp = /^-- Found \S/;
/** CMake "-- Configuring done" / "-- Build files have been written to:" — always keep. */
const _CMAKE_DONE_RE: RegExp =
  /^-- (?:Configuring done|Generating done|Build files have been written)/;
/** CMake build-phase percentage lines: "[  5%] Building CXX object ...". */
const _CMAKE_PERCENT_RE: RegExp =
  /^\[\s*\d+%\]\s+(?:Building|Compiling|Generating|Scanning|Creating)\s/;
/** CMake "[N%] Linking CXX/C executable/library ..." — always keep. */
const _CMAKE_LINK_PERCENT_RE: RegExp = /^\[\s*\d+%\]\s+Linking\s/;
/** CMake "[100%] Built target ..." — always keep. */
const _CMAKE_BUILT_TARGET_RE: RegExp = /^\[\s*100%\]\s+Built target\s/;
/** CMake Makefile link/ar lines (emitted without a percentage prefix). */
const _CMAKE_LINK_RE: RegExp = /^(?:Linking\s|Archiving\s|cd\s.*&&\s*(?:ar |ranlib |ld ))/;
/** ctest: "N/N Test #N: TestName ... Passed Xs" passing result (no leading whitespace). */
const _CTEST_PASS_RE: RegExp = /^\d+\/\d+\s+Test\s+#\d+:.*\bPassed\b/;
/** ctest: "N/N Test #N: TestName ... ***Failed" or "***Not Run" failing result. */
const _CTEST_FAIL_RE: RegExp = /^\d+\/\d+\s+Test\s+#\d+:.*\*\*\*/;
/** ctest summary: "N% tests passed, N tests failed out of N". */
const _CTEST_SUMMARY_RE: RegExp = /^\d+% tests passed/;

// ===========================================================================
// CmakeFilter
// ===========================================================================

/**
 * Compress ``cmake`` configure, build, and ``ctest`` output.
 *
 * Compression model:
 *  - Configure phase: collapse ``-- Found PackageName: …`` lines to a count; keep
 *    the first 5 other ``--`` probe lines; always keep ``-- Configuring done`` /
 *    ``-- Build files have been written to:`` lines; drop the rest.
 *  - Build phase: collapse ``[N%] Building …`` lines to a progress summary; keep
 *    ``[N%] Linking …`` and ``[100%] Built target …`` verbatim.
 *  - ctest: collapse passing ``Passed`` result lines to a count; keep every
 *    ``***Failed`` / ``***Not Run`` line verbatim; keep the summary.
 *  - Keep every ``warning:`` / ``error:`` / ``CMake Error`` / ``CMake Warning``
 *    diagnostic verbatim.
 */
export class CmakeFilter extends Filter {
  override name = "cmake";
  override binaries: ReadonlySet<string> = new Set(["cmake", "ccmake", "ctest", "cpack"]);

  override compress(stdout: string, stderr: string, _exit_code: number, argv: string[]): string {
    const binary = argv.length > 0 ? _pathStemLower(argv[0]!) : "";
    if (binary === "ctest") {
      return this._compress_ctest(stdout, stderr);
    }
    const merged = this._combine_output(stdout, stderr);
    return this._compress_cmake(merged);
  }

  /** Compress cmake configure + build output. */
  _compress_cmake(text: string): string {
    const lines = text.split("\n");
    const kept: string[] = [];
    let config_probes_kept = 0;
    let dropped_probes = 0;
    let dropped_percent = 0;
    let found_packages = 0;
    let last_percent_line: string | null = null;

    for (const line of lines) {
      // Always keep error/warning diagnostics.
      if (_reSearch(_ERROR_SIGNAL_RE, line) || line.includes("CMake Error") || line.includes("CMake Warning")) {
        kept.push(line);
        continue;
      }
      // Always keep "-- Configuring done" and "-- Build files" lines.
      if (_reMatch(_CMAKE_DONE_RE, line)) {
        kept.push(line);
        continue;
      }
      // Collapse "-- Found PackageName: ..." lines to a count.
      if (_reMatch(_CMAKE_FOUND_RE, line)) {
        found_packages += 1;
        continue;
      }
      // Configure-phase ``-- …`` probe lines: keep first 5, drop rest.
      if (_reMatch(_CMAKE_CONFIG_RE, line)) {
        config_probes_kept += 1;
        if (config_probes_kept <= 5) {
          kept.push(line);
        } else {
          dropped_probes += 1;
        }
        continue;
      }
      // Keep "[N%] Linking ..." verbatim.
      if (_reMatch(_CMAKE_LINK_PERCENT_RE, line)) {
        kept.push(line);
        continue;
      }
      // Keep "[100%] Built target ..." verbatim.
      if (_reMatch(_CMAKE_BUILT_TARGET_RE, line)) {
        kept.push(line);
        continue;
      }
      // Build-phase "[N%] Building ..." lines — count and track last.
      if (_reMatch(_CMAKE_PERCENT_RE, line)) {
        dropped_percent += 1;
        last_percent_line = line;
        continue;
      }
      kept.push(line);
    }

    // Emit found-packages summary before any other notes.
    if (found_packages) {
      kept.push(`[token-goat: Found ${found_packages} packages (-- Found ... lines collapsed)]`);
    }
    const notes: string[] = [];
    _maybe_note(notes, dropped_probes, `collapsed ${dropped_probes} cmake probe/feature-check lines`);
    if (dropped_percent) {
      // Include the last percent line so the agent sees the peak progress.
      if (last_percent_line) {
        notes.push(
          `collapsed ${dropped_percent} [N%] build-progress lines ` +
            `(last: ${last_percent_line.trim()})`,
        );
      } else {
        notes.push(`collapsed ${dropped_percent} [N%] build-progress lines`);
      }
    }
    Filter._emit_notes(kept, notes);
    return Filter._finalize(kept);
  }

  /** Compress ctest output: collapse passing tests, keep failures. */
  _compress_ctest(stdout: string, stderr: string): string {
    const merged = this._combine_output(stdout, stderr);
    const lines = merged.split("\n");
    const kept: string[] = [];
    let pass_count = 0;

    for (const line of lines) {
      // Always keep error/warning lines.
      if (_reSearch(_ERROR_SIGNAL_RE, line)) {
        kept.push(line);
        continue;
      }
      // Passing test: count, drop.
      if (_reMatch(_CTEST_PASS_RE, line)) {
        pass_count += 1;
        continue;
      }
      // Failing test: keep verbatim.
      if (_reMatch(_CTEST_FAIL_RE, line)) {
        kept.push(line);
        continue;
      }
      // Summary line: always keep.
      if (_reMatch(_CTEST_SUMMARY_RE, line)) {
        kept.push(line);
        continue;
      }
      kept.push(line);
    }

    const notes: string[] = [];
    _maybe_note(notes, pass_count, `collapsed ${pass_count} passing ctest results`);
    Filter._emit_notes(kept, notes);
    return Filter._finalize(kept);
  }
}

// ===========================================================================
// Elixir Mix regexes (Python ~14705-14742).
// ===========================================================================

/** mix deps.get: "* Getting dep-name (hex package)". */
const _MIX_GETTING_DEP_RE: RegExp = /^\* Getting (\S+)\s/;
/** mix compile: "Compiling N files (.ex)". */
const _MIX_COMPILING_RE: RegExp = /^Compiling \d+ file/;
/** mix compile: "Generated app_name app". */
const _MIX_GENERATED_RE: RegExp = /^Generated \S+ app$/;
/** mix compile: "warning: ...". */
const _MIX_WARNING_RE: RegExp = /^\s*warning:/;
/** mix test: ExUnit progress dots / letters (. E F *). */
const _MIX_TEST_DOTS_RE: RegExp = /^[.EF*]+\s*$/;
/** mix test: "N tests, N failures" summary. */
const _MIX_TEST_SUMMARY_RE: RegExp = /^\d+ tests?, \d+ failure/;
/** mix test: "Finished in N.Ns (..." — keep. */
const _MIX_TEST_FINISHED_RE: RegExp = /^Finished in \d/;
/** mix test: failure section header "  N) TestModule.test_name". */
const _MIX_TEST_FAILURE_HEADER_RE: RegExp = /^\s+\d+\)/;
/** mix ecto.migrate: migration lines to keep (may be prefixed by Logger timestamp). */
const _MIX_MIGRATION_RE: RegExp = /== (?:Running|Migrated)/;

// ===========================================================================
// MixFilter
// ===========================================================================

/**
 * Compress ``mix`` Elixir task output.
 *
 * Compression model:
 *  - mix deps.get: ``* Getting dep-name (hex package)`` lines → collapsed to a
 *    single ``[token-goat: Fetching N dependencies]`` summary.
 *  - mix compile: ``Compiling N files (.ex)`` / ``warning: …`` / ``Generated
 *    app_name app`` lines kept; other progress dropped.
 *  - mix test: ExUnit dot/letter progress collapsed to a pass/fail count;
 *    failure blocks kept verbatim; summary/timing kept.
 *  - mix ecto.migrate: ``== Running …`` / ``== Migrated …`` lines kept; per-query
 *    noise dropped.
 */
export class MixFilter extends Filter {
  override name = "mix";
  override binaries: ReadonlySet<string> = new Set(["mix"]);
  override subcommands: ReadonlySet<string> = new Set([
    "compile",
    "test",
    "deps.get",
    "phx.server",
    "ecto.migrate",
    "ecto.create",
    "ecto.drop",
    "ecto.rollback",
    "run",
    "release",
  ]);

  /** Match ``mix`` with any subcommand listed in :attr:`subcommands` or no subcommand. */
  override matches(argv: string[]): boolean {
    if (argv.length === 0) {
      return false;
    }
    const stem = _pathStemLower(argv[0]!);
    if (stem !== "mix") {
      return false;
    }
    // When no subcommand is given, still match so output is at least normalised.
    if (this.subcommands.size === 0) {
      return true;
    }
    const positionals = _positional_args(argv.slice(1));
    if (positionals.length === 0) {
      return true;
    }
    return this.subcommands.has(positionals[0]!);
  }

  override compress(stdout: string, stderr: string, exit_code: number, argv: string[]): string {
    const positionals = _positional_args(argv.slice(1));
    const subcommand = positionals.length > 0 ? positionals[0]! : "";

    if (subcommand === "deps.get") {
      return this._compress_deps_get(stdout, stderr);
    }
    if (subcommand === "compile") {
      return this._compress_compile(stdout, stderr);
    }
    if (subcommand === "test") {
      return this._compress_test(stdout, stderr, exit_code);
    }
    if (subcommand === "ecto.migrate" || subcommand === "ecto.rollback") {
      return this._compress_migrate(stdout, stderr);
    }
    // Generic: ANSI/progress already stripped; just combine.
    return this._combine_output(stdout, stderr);
  }

  _compress_deps_get(stdout: string, stderr: string): string {
    const merged = this._combine_output(stdout, stderr);
    const lines = merged.split("\n");
    const kept: string[] = [];
    let fetch_count = 0;
    for (const line of lines) {
      if (_reMatch(_MIX_GETTING_DEP_RE, line)) {
        fetch_count += 1;
        continue;
      }
      kept.push(line);
    }
    if (fetch_count) {
      kept.unshift(`[token-goat: Fetching ${fetch_count} dependencies]`);
    }
    return Filter._finalize(kept);
  }

  _compress_compile(stdout: string, stderr: string): string {
    const merged = this._combine_output(stdout, stderr);
    const lines = merged.split("\n");
    const kept: string[] = [];
    let dropped = 0;
    for (const line of lines) {
      if (
        _reMatch(_MIX_COMPILING_RE, line) ||
        _reMatch(_MIX_WARNING_RE, line) ||
        _reMatch(_MIX_GENERATED_RE, line) ||
        _reSearch(_ERROR_SIGNAL_RE, line)
      ) {
        kept.push(line);
        continue;
      }
      // Drop other mix compile noise (e.g. "Resolving Hex dependencies...").
      if (line.trim() !== "" && !line.startsWith("[") && !line.startsWith("=")) {
        dropped += 1;
        continue;
      }
      kept.push(line);
    }
    const notes: string[] = [];
    _maybe_note(notes, dropped, `dropped ${dropped} mix compile progress lines`);
    Filter._emit_notes(kept, notes);
    return Filter._finalize(kept);
  }

  _compress_test(stdout: string, stderr: string, _exit_code: number): string {
    const merged = this._combine_output(stdout, stderr);
    const lines = merged.split("\n");
    const kept: string[] = [];
    let dot_pass = 0;
    let dot_fail = 0;
    let in_failure = false;

    for (const line of lines) {
      // Summary and timing lines: always keep.
      if (_reMatch(_MIX_TEST_SUMMARY_RE, line) || _reMatch(_MIX_TEST_FINISHED_RE, line)) {
        in_failure = false;
        kept.push(line);
        continue;
      }
      // Failure header "  N) Test.name" starts a failure block.
      if (_reMatch(_MIX_TEST_FAILURE_HEADER_RE, line)) {
        in_failure = true;
        kept.push(line);
        continue;
      }
      // Inside a failure block, keep everything (context is load-bearing).
      if (in_failure) {
        kept.push(line);
        continue;
      }
      // Dot progress lines: count passes and failures.
      if (_reMatch(_MIX_TEST_DOTS_RE, line)) {
        dot_pass += _strCount(line, ".");
        dot_fail += _strCount(line, "F") + _strCount(line, "E");
        continue;
      }
      kept.push(line);
    }

    const notes: string[] = [];
    if (dot_pass || dot_fail) {
      notes.push(`collapsed progress: ${dot_pass} passed, ${dot_fail} failed`);
    }
    Filter._emit_notes(kept, notes);
    return Filter._finalize(kept);
  }

  _compress_migrate(stdout: string, stderr: string): string {
    const merged = this._combine_output(stdout, stderr);
    const lines = merged.split("\n");
    const kept: string[] = [];
    let dropped = 0;
    for (const line of lines) {
      if (_reSearch(_MIX_MIGRATION_RE, line) || _reSearch(_ERROR_SIGNAL_RE, line)) {
        kept.push(line);
        continue;
      }
      if (line.trim() !== "") {
        dropped += 1;
        continue;
      }
      kept.push(line);
    }
    const notes: string[] = [];
    _maybe_note(notes, dropped, `dropped ${dropped} migration detail lines`);
    Filter._emit_notes(kept, notes);
    return Filter._finalize(kept);
  }
}

// ===========================================================================
// PHP Composer regexes (Python ~14901-14928).
// ===========================================================================

/** composer install/update: "  - Installing vendor/package (version): Loading from cache". */
const _COMPOSER_INSTALL_RE: RegExp = /^\s+- Installing (\S+) \(/;
/** composer install/update: "  - Downloading vendor/package (version)". */
const _COMPOSER_DOWNLOADING_RE: RegExp = /^\s+- Downloading (\S+) \(/;
/** composer: progress percentage lines "  - Downloading vendor/package (version) (100%)". */
const _COMPOSER_DOWNLOAD_PROGRESS_RE: RegExp = /^\s+- (?:Installing|Downloading) .+\(\d+%\)/;
/** composer autoload lines to keep. */
const _COMPOSER_AUTOLOAD_RE: RegExp = /^Generating(?: optimized)? autoload/;
/** composer "Package operations: N installs, M updates, ..." — keep. */
const _COMPOSER_OPERATIONS_RE: RegExp = /^Package operations:/;
/** composer: "N packages you are using are looking for funding" — drop (pure noise). */
const _COMPOSER_FUNDING_RE: RegExp = /^\d+ packages? you are using are looking for funding/;
/** composer: deprecation / constraint warning lines. */
const _COMPOSER_WARNING_RE: RegExp = /^\s*(?:Warning|Deprecation|deprecated|constraint):/i;

// ===========================================================================
// ComposerFilter
// ===========================================================================

/**
 * Compress ``composer install``, ``composer update``, and ``composer require``
 * output.
 *
 * Compression model:
 *  - Collapse ``  - Installing vendor/package (version): …`` and
 *    ``  - Downloading …`` lines into install/download counts.
 *  - Drop partial-download percentage lines (``(10%)``, …).
 *  - Drop ``N packages you are using are looking for funding`` (pure noise).
 *  - Keep first occurrence of each unique deprecation/constraint warning;
 *    deduplicate repeated warnings.
 *  - Keep ``Generating autoload files`` / ``Package operations: …`` banners.
 *  - Keep every error line verbatim.
 */
export class ComposerFilter extends Filter {
  override name = "composer";
  override binaries: ReadonlySet<string> = new Set(["composer", "composer.phar"]);
  override subcommands: ReadonlySet<string> = new Set([
    "install",
    "update",
    "require",
    "remove",
    "dump-autoload",
  ]);

  override compress(stdout: string, stderr: string, _exit_code: number, _argv: string[]): string {
    const merged = this._combine_output(stdout, stderr);
    const lines = merged.split("\n");
    const kept: string[] = [];
    let install_count = 0;
    let download_count = 0;
    let dropped_progress = 0;
    let dropped_funding = 0;
    const warning_lines: string[] = [];

    for (const line of lines) {
      // Always keep errors verbatim.
      if (_reSearch(_ERROR_SIGNAL_RE, line)) {
        kept.push(line);
        continue;
      }
      // Drop partial-download percentage lines (noise).
      if (_reMatch(_COMPOSER_DOWNLOAD_PROGRESS_RE, line)) {
        dropped_progress += 1;
        continue;
      }
      // Drop funding noise.
      if (_reMatch(_COMPOSER_FUNDING_RE, line)) {
        dropped_funding += 1;
        continue;
      }
      // Collapse install lines to a count.
      if (_reMatch(_COMPOSER_INSTALL_RE, line)) {
        install_count += 1;
        continue;
      }
      // Collapse download lines to a count.
      if (_reMatch(_COMPOSER_DOWNLOADING_RE, line)) {
        download_count += 1;
        continue;
      }
      // Collect deprecation/constraint warnings for deduplication.
      if (_reMatch(_COMPOSER_WARNING_RE, line)) {
        warning_lines.push(line);
        continue;
      }
      // Always keep autoload, operations summary, and other informational lines.
      kept.push(line);
    }

    // Deduplicate warnings (keep first occurrence per unique text) and append.
    let deduped: string[];
    let dropped_dup_warnings: number;
    if (warning_lines.length > 0) {
      [deduped, dropped_dup_warnings] = _dedup_lines(warning_lines, 1);
    } else {
      deduped = [];
      dropped_dup_warnings = 0;
    }
    kept.push(...deduped);

    const notes: string[] = [];
    _maybe_note(notes, install_count, `collapsed ${install_count} package install lines`);
    _maybe_note(notes, download_count, `collapsed ${download_count} package download lines`);
    _maybe_note(notes, dropped_progress, `dropped ${dropped_progress} download-progress lines`);
    _maybe_note(notes, dropped_funding, `dropped ${dropped_funding} funding-notice lines`);
    _maybe_note(notes, dropped_dup_warnings, `deduplicated ${dropped_dup_warnings} repeated warnings`);
    Filter._emit_notes(kept, notes);
    return Filter._finalize(kept);
  }
}

// ===========================================================================
// PHPStan / Psalm regexes (Python ~15017-15045).
// ===========================================================================

/** PHPStan table separator line: " ------ ----...---- ". */
const _PHPSTAN_SEP_RE: RegExp = /^\s*-{3,}/;
/** PHPStan file header line inside the table: " Line  src/Foo.php ". */
const _PHPSTAN_FILE_HEADER_RE: RegExp = /^\s+Line\s+\S.*\.php\s*$/;
/** PHPStan error/note row inside the table: "  42   Property $x not found.". */
const _PHPSTAN_ROW_RE: RegExp = /^\s+(\d+)\s+(.+)$/;
/** PHPStan summary lines: "[ERROR] Found N error(s)" / "[OK] No errors". */
const _PHPSTAN_SUMMARY_RE: RegExp = /^\s*\[(ERROR|OK|WARNING|NOTE)\]/i;
/** Psalm error line: "ERROR: ... at /path/file.php:42:1". */
const _PSALM_ERROR_RE: RegExp = /^(ERROR|INFO|FATAL): \w+ - .+\.php:\d+/i;
/** Psalm scanning-progress line: "Scanning files..." / "Analyzing files...". */
const _PSALM_PROGRESS_RE: RegExp =
  /^(Scanning|Analyzing|Checking|Parsing|Caching|Target PHP|Psalm|PHP version|Running Psalm|No errors|Checked \d|INFO:|Found \d+ error)/i;
/** phpstan/psalm "Loading configuration" / "Note: " informational lines. */
const _PHPSTAN_INFO_RE: RegExp =
  /^(Note: |Loading config|Found cached|Autoload|Bootstrapping|PHPStan - PHP Static|Psalm is running)/i;

// ===========================================================================
// PhpStanFilter
// ===========================================================================

/**
 * Compress ``phpstan analyse`` and ``psalm`` PHP static analysis output.
 *
 * Compression model for **phpstan**:
 *  - Keep the table header row and the ``[ERROR]`` / ``[OK]`` summary.
 *  - Per file: keep the first three unique error messages; collapse additional
 *    occurrences of the same message to a count note.
 *  - Drop table separator lines (pure ``---`` rows).
 *  - Drop info lines (config-loading, cache-loading, banner).
 *
 * Compression model for **psalm**:
 *  - Keep all ``ERROR:`` lines verbatim.
 *  - Collapse duplicate error *types* beyond the third occurrence.
 *  - Drop scanning/progress lines.
 *  - Keep the final summary.
 */
export class PhpStanFilter extends Filter {
  override name = "phpstan";
  override binaries: ReadonlySet<string> = new Set([
    "phpstan",
    "psalm",
    "psalm.phar",
    "phpstan.phar",
  ]);

  override compress(stdout: string, stderr: string, _exit_code: number, argv: string[]): string {
    let binary = argv.length > 0 ? _pathStemLower(argv[0]!) : "phpstan";
    // psalm.phar → "psalm", phpstan.phar → "phpstan".
    if (binary.endsWith(".phar")) {
      binary = binary.slice(0, -5);
    }
    const merged = this._combine_output(stdout, stderr);
    const lines = merged.split("\n");

    if (binary === "psalm") {
      return this._compress_psalm(lines);
    }
    return this._compress_phpstan(lines);
  }

  /** Compress PHPStan table-style output. */
  _compress_phpstan(lines: string[]): string {
    const kept: string[] = [];
    let dropped_sep = 0;
    let dropped_info = 0;

    // Per-file deduplication: file → {msg: count}.
    let current_file = "";
    const file_msgs = new Map<string, Map<string, number>>();

    const flush_file_dedup = (file: string, msgs: Map<string, number>): void => {
      let extra_count = 0;
      for (const c of msgs.values()) {
        extra_count += Math.max(0, c - 3);
      }
      if (extra_count) {
        kept.push(`  [token-goat: +${extra_count} more duplicate error(s) in ${file}]`);
      }
    };

    for (const line of lines) {
      // Info / banner lines: drop.
      if (_reMatch(_PHPSTAN_INFO_RE, line)) {
        dropped_info += 1;
        continue;
      }
      // Summary lines: keep (and flush pending dedup note first).
      if (_reMatch(_PHPSTAN_SUMMARY_RE, line)) {
        if (current_file) {
          flush_file_dedup(current_file, file_msgs.get(current_file) ?? new Map<string, number>());
          current_file = "";
        }
        kept.push(line);
        continue;
      }
      // Separator lines: drop.
      if (_reMatch(_PHPSTAN_SEP_RE, line) && !_reMatch(_PHPSTAN_ROW_RE, line)) {
        dropped_sep += 1;
        continue;
      }
      // File header row: flush previous, start tracking new file.
      if (_reMatch(_PHPSTAN_FILE_HEADER_RE, line)) {
        if (current_file) {
          flush_file_dedup(current_file, file_msgs.get(current_file) ?? new Map<string, number>());
        }
        // Extract filename from "  Line  src/Foo.php".
        const stripped = line.trim();
        const parts = _splitOnceWhitespace(stripped);
        current_file = parts.length > 1 ? parts[1]!.trim() : stripped;
        if (!file_msgs.has(current_file)) {
          file_msgs.set(current_file, new Map<string, number>());
        }
        kept.push(line);
        continue;
      }
      // Error row: deduplicate by message within the current file.
      const m = _reMatchObj(_PHPSTAN_ROW_RE, line);
      if (m && current_file) {
        const msg = m[2]!.trim();
        let counts = file_msgs.get(current_file);
        if (counts === undefined) {
          counts = new Map<string, number>();
          file_msgs.set(current_file, counts);
        }
        const next = (counts.get(msg) ?? 0) + 1;
        counts.set(msg, next);
        if (next <= 3) {
          kept.push(line);
        }
        // else silently elide; will be reported in the flush note.
        continue;
      }
      kept.push(line);
    }

    if (current_file) {
      flush_file_dedup(current_file, file_msgs.get(current_file) ?? new Map<string, number>());
    }

    const notes: string[] = [];
    _maybe_note(notes, dropped_sep, `dropped ${dropped_sep} table-separator lines`);
    _maybe_note(notes, dropped_info, `dropped ${dropped_info} info/banner lines`);
    Filter._emit_notes(kept, notes);
    return Filter._finalize(kept);
  }

  /** Compress Psalm output. */
  _compress_psalm(lines: string[]): string {
    const kept: string[] = [];
    let dropped_progress = 0;

    // Deduplicate by error type (word after "ERROR: ").
    const error_type_counts = new Map<string, number>();

    for (const line of lines) {
      if (_reMatch(_PSALM_PROGRESS_RE, line)) {
        dropped_progress += 1;
        continue;
      }
      const m = _reMatchObj(_PSALM_ERROR_RE, line);
      if (m) {
        // Extract error type: "ERROR: UnresolvableInclude - ...".
        const parts = _splitN(line, ":", 2);
        const error_type =
          parts.length >= 2 ? parts[1]!.trim().split("-")[0]!.trim() : "?";
        const next = (error_type_counts.get(error_type) ?? 0) + 1;
        error_type_counts.set(error_type, next);
        if (next <= 3) {
          kept.push(line);
        }
        // else: emit a trailing note later (pass).
        continue;
      }
      kept.push(line);
    }

    const notes: string[] = [];
    _maybe_note(notes, dropped_progress, `dropped ${dropped_progress} progress/info lines`);
    const collapsed: Array<[string, number]> = [];
    for (const [k, v] of error_type_counts) {
      if (v > 3) {
        collapsed.push([k, v - 3]);
      }
    }
    if (collapsed.length > 0) {
      collapsed.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
      for (const [etype, extra] of collapsed) {
        notes.push(`collapsed +${extra} more ${etype} occurrence(s)`);
      }
    }
    Filter._emit_notes(kept, notes);
    return Filter._finalize(kept);
  }
}

// ===========================================================================
// String-split shims for PhpStanFilter.
// ===========================================================================

/**
 * Python str.split(None, 1) — split on the FIRST run of whitespace into at most
 * two parts, with leading/trailing whitespace ignored (the str.split() with no
 * sep semantics). Returns 1 or 2 elements.
 */
function _splitOnceWhitespace(s: string): string[] {
  const trimmed = s.replace(/^\s+/, "");
  const m = /\s/.exec(trimmed);
  if (m === null) {
    return trimmed === "" ? [] : [trimmed];
  }
  const head = trimmed.slice(0, m.index);
  const tail = trimmed.slice(m.index).replace(/^\s+/, "");
  return [head, tail];
}

/**
 * Python str.split(sep, maxsplit) — split on sep at most maxsplit times,
 * leaving the remainder (including further sep occurrences) in the last element.
 */
function _splitN(s: string, sep: string, maxsplit: number): string[] {
  const out: string[] = [];
  let rest = s;
  let count = 0;
  while (count < maxsplit) {
    const idx = rest.indexOf(sep);
    if (idx === -1) {
      break;
    }
    out.push(rest.slice(0, idx));
    rest = rest.slice(idx + sep.length);
    count += 1;
  }
  out.push(rest);
  return out;
}

// Reference the parity-only regex/helpers so noUnusedLocals stays satisfied even
// though their Python originals exist purely for documentation/forward-compat:
// _RSPEC_FAIL_INDEX_RE, _CMAKE_LINK_RE, _COMPOSER_AUTOLOAD_RE,
// _COMPOSER_OPERATIONS_RE are declared verbatim from Python but not referenced in
// the ported control flow (mirroring the Python source where they are likewise
// declared-but-unused in these methods).
void _RSPEC_FAIL_INDEX_RE;
void _CMAKE_LINK_RE;
void _COMPOSER_AUTOLOAD_RE;
void _COMPOSER_OPERATIONS_RE;
