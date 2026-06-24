/**
 * bash_compress JVM / BUILD-TOOL FILTERS — TypeScript port of the
 * Make / Gradle / Ant / Bazel / Maven / Javac / Sbt Filter subclasses from
 * src/token_goat/bash_compress.py.
 *
 * Seven filters subclass the concrete Filter base from ./framework.js:
 *   - MakeFilter    — `make` / `gmake` / `ninja` / `gradle` / `mvn` / `bazel` /
 *                     `buck` / `go` / `goimports` plus `./configure` (autotools).
 *                     Overrides matches() (adds configure-stem matching) and
 *                     compress() (go-subcommand + configure dispatch). Uses raw
 *                     f-string notes (", " join, "dropped" prefix) — NOT
 *                     Filter._emit_notes.
 *   - GradleFilter  — `gradle` / `gradlew` build/test/check/... + dependencies/
 *                     tasks. Overrides matches() (lower-cases camelCase tokens)
 *                     and compress(); _compress_build state machine.
 *   - AntFilter     — `ant` (bracketed-task collapse, [javac] diagnostics kept).
 *   - BazelFilter   — `bazel` / `bazelisk` (INFO collapse, test-pass count).
 *   - MavenFilter   — `mvn` / `mvnw` / `./mvnw` (boilerplate/[INFO] collapse,
 *                     dependency:tree + install head/tail, failure tail+errors).
 *   - JavacFilter   — `javac` (Note: collapse, diagnostic-block keep).
 *   - SbtFilter     — `sbt` (loading/test-progress collapse, per-category [warn]
 *                     dedup). Overrides matches() (stem|name in binaries).
 *
 * ---------------------------------------------------------------------------
 * Parity notes (Python -> TS)
 * ---------------------------------------------------------------------------
 *  - Python identifiers preserved EXACTLY: PascalCase class names; snake_case
 *    methods/fields (matches, compress, _compress_build, _compress_configure,
 *    _compress_go_build, _compress_go_mod, _compress_go_vet, _compress_go_generate,
 *    _compress_test); snake_case module-private regex constants (_MAKE_*, _GO_*,
 *    _CONFIGURE_*, _GRADLE_*, _ANT_*, _BAZEL_*, _MAVEN_*, _JAVAC_*, _SBT_*); and
 *    the _MakeFilter._CONFIGURE_STEMS / _SBT_MAX_WARN_PER_CATEGORY constants.
 *  - re.compile(...) -> top-level RegExp compiled once. re.IGNORECASE -> "i".
 *  - Python re.Pattern.match(line) is START-anchored (NOT end-anchored); emulated
 *    via _reMatch (non-global clone + index===0). .search() -> _reSearch /
 *    _reSearchObj (non-global clone, .exec anywhere); capture groups read off the
 *    RegExpExecArray.
 *  - _ERROR_SIGNAL_RE is framework-PRIVATE (not exported by framework.ts); it is
 *    re-declared MODULE-PRIVATE here (NOT exported) to avoid a duplicate-export
 *    ambiguity (TS2308) across the barrel export* chain. _MAKE_PRESERVE_SIGNAL_RE
 *    IS exported (a test imports it).
 *  - Path(argv[0]).stem.lower() / .name.lower() -> local _pathStemLower /
 *    _pathNameLower (final component after backslash-norm, last suffix stripped for
 *    stem, lowercased) — matching framework _pathStem/_pathName.
 *  - _positional_args / _head_tail_compress / _maybe_note / _preserve_stderr_on_error
 *    are framework-PUBLIC and imported. _combine_output is an INSTANCE method;
 *    _finalize / _emit_notes are STATIC methods on Filter.
 *  - MakeFilter emits its summary line directly (", " join, "[token-goat: dropped …]")
 *    rather than via _emit_notes — replicated verbatim. _compress_configure uses
 *    the standard "; " join with each fragment already carrying its own "dropped".
 *  - Python str.rstrip("\r\n") (Gradle per-line) strips ONLY trailing \r / \n —
 *    reproduced by _rstripCrLf (NOT the full-whitespace rstrip).
 *  - Module-global mutable state: NONE. Every counter/dict/list is a local inside
 *    compress()/helpers; no registerReset seam is needed.
 *
 * NOTE on import depth: this file lives in the bash_compress/ SUBDIR; the
 * framework is a SIBLING (./framework.js). verbatimModuleSyntax is on -> nothing
 * imported here is type-only. noImplicitOverride is on -> every overridden member
 * carries `override`.
 */

import {
  Filter,
  _head_tail_compress,
  _maybe_note,
  _positional_args,
  _preserve_stderr_on_error,
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

/** Python str.rstrip("\r\n") — strip ONLY trailing carriage-returns / newlines. */
function _rstripCrLf(s: string): string {
  return s.replace(/[\r\n]+$/, "");
}

// ===========================================================================
// Module-private framework regexes re-declared here (framework does NOT export
// _ERROR_SIGNAL_RE — re-exporting it would create a TS2308 ambiguity).
// ===========================================================================

/** Python _ERROR_SIGNAL_RE (framework-private) — re-declared module-private. */
const _ERROR_SIGNAL_RE: RegExp =
  /error:|Error:|ERROR|FAILED|failed|fatal:|Traceback|exception:|Exception:|AssertionError|assert |panic:/i;

// ===========================================================================
// Go subcommand regexes (Python ~7833-7848) used by MakeFilter.
// ===========================================================================

const _GO_BUILD_PKG_HEADER_RE: RegExp = /^#\s+[a-zA-Z0-9./\-]+/;
const _GO_MOD_DOWNLOADING_RE: RegExp = /^go: (downloading|extracting) /;
const _GO_VET_PROGRESS_RE: RegExp = /^go: vet /;
const _GO_GENERATE_TRIGGER_RE: RegExp = /^go:generate /;
/** Generic go error pattern: file:line:col: error|warning message. */
const _GO_ERROR_RE: RegExp = /^[^:\s]+:\d+:\d+:\s+(?:error|warning):/;

// ===========================================================================
// Make / Ninja / Gradle / Maven / Go build/mod/vet/generate regexes (~8399-8427).
// ===========================================================================

const _MAKE_RECURSE_RE: RegExp = /^make\[\d+\]: (Entering|Leaving) directory/;
const _MAKE_ECHO_RE: RegExp = /^(echo |cc |gcc |clang |g\+\+ )/;
/**
 * autotools `./configure` probe lines — "checking for X ... yes/no/...".
 * A typical configure run produces 200–600 such lines (pure noise unless it fails).
 */
const _CONFIGURE_CHECKING_RE: RegExp =
  /^checking\s+(?:for|whether|if|the|how|size|version|build|host|target|\w)/i;
/** autotools `configure:` info lines — "configure: creating ..." etc. */
const _CONFIGURE_INFO_RE: RegExp = /^configure:\s+(?:creating|loading|running)\b/i;
/**
 * Parallel make (-j) progress lines from Make 4.x:
 * "[  12%] Building CXX object …" or "[100%] Linking …" (CMake wrapper style).
 */
const _MAKE_PERCENT_RE: RegExp =
  /^\[\s*\d+%\]\s+(?:Building|Linking|Scanning|Generating|Installing|Compiling)/;
/** Pass A: extended compiler invocations not covered by _MAKE_ECHO_RE. */
const _MAKE_COMPILER_EXT_RE: RegExp = /^(?:clang[+][+] |ld |ar |as |nasm |ninja )/;
/** Pass C: nothing-to-do noise lines. */
const _MAKE_NOTHING_TO_DO_RE: RegExp = /^make\[\d+\]: Nothing to be done/;
/**
 * Preserve rule: keep lines with Error/error:/warning:/undefined reference; bare
 * Error catches make[N]: *** Error N and compiler lines embedding the word.
 *
 * Exported — a test imports it.
 */
export const _MAKE_PRESERVE_SIGNAL_RE: RegExp =
  /\bError\b|error:|warning:|undefined reference|undefined symbol/i;

// ===========================================================================
// MakeFilter
// ===========================================================================

export class MakeFilter extends Filter {
  override name = "make";
  override binaries: ReadonlySet<string> = new Set([
    "make", "gmake", "ninja", "gradle", "mvn", "maven", "bazel", "buck",
    "go", "goimports",
  ]);

  /** Additional configure script stems handled by this filter. */
  static readonly _CONFIGURE_STEMS: ReadonlySet<string> = new Set(["configure", "config"]);

  override matches(argv: string[]): boolean {
    if (argv.length === 0) {
      return false;
    }
    const stem = _pathStemLower(argv[0]!);
    // Match registered binaries as usual.
    if (this.binaries.has(stem)) {
      return true;
    }
    // Also match ./configure, ./config, or any path ending in configure
    // (e.g. ../configure, /usr/src/proj/configure).
    return MakeFilter._CONFIGURE_STEMS.has(stem);
  }

  override compress(stdout: string, stderr: string, _exit_code: number, argv: string[]): string {
    // Detect go subcommands (build, mod, vet, generate) for specialized handling.
    const positionals = _positional_args(argv);
    const binary_stem = argv.length > 0 ? _pathStemLower(argv[0]!) : "";
    let go_subcommand = "";
    if (positionals.length > 0 && _pathStemLower(positionals[0]!) === "go") {
      go_subcommand = positionals.length > 1 ? positionals[1]! : "";
    }

    const merged = this._combine_output(stdout, stderr);
    const lines = merged.split("\n");

    // autotools ./configure — dedicated path.
    if (MakeFilter._CONFIGURE_STEMS.has(binary_stem)) {
      return this._compress_configure(lines);
    }

    if (go_subcommand === "build") {
      return this._compress_go_build(lines);
    }
    if (go_subcommand === "mod") {
      return this._compress_go_mod(lines);
    }
    if (go_subcommand === "vet") {
      return this._compress_go_vet(lines);
    }
    if (go_subcommand === "generate") {
      return this._compress_go_generate(lines);
    }

    // Generic make/ninja/gradle compression.
    const kept: string[] = [];
    let dropped_recurse = 0;
    let dropped_echo = 0;
    let dropped_go_download = 0;
    let dropped_percent = 0;
    let dropped_nothing_to_do = 0;
    // Pass A pre-scan: identify compiler lines followed by an error (force-keep).
    const _mk_force_keep = new Set<number>();
    for (let _mki = 0; _mki < lines.length; _mki++) {
      const _mkl = lines[_mki]!;
      if (
        (_reMatch(_MAKE_ECHO_RE, _mkl) || _reMatch(_MAKE_COMPILER_EXT_RE, _mkl)) &&
        !_reSearch(_MAKE_PRESERVE_SIGNAL_RE, _mkl)
      ) {
        let _mk_next = "";
        for (let j = _mki + 1; j < lines.length; j++) {
          if (lines[j]!.trim() !== "") {
            _mk_next = lines[j]!;
            break;
          }
        }
        if (_reSearch(_MAKE_PRESERVE_SIGNAL_RE, _mk_next)) {
          _mk_force_keep.add(_mki);
        }
      }
    }
    for (let _mii = 0; _mii < lines.length; _mii++) {
      const line = lines[_mii]!;
      if (_reMatch(_MAKE_RECURSE_RE, line)) {
        dropped_recurse += 1;
        continue;
      }
      if (line.startsWith("go: downloading")) {
        dropped_go_download += 1;
        continue;
      }
      if (
        _reMatch(_MAKE_PERCENT_RE, line) &&
        !line.toLowerCase().includes("error") &&
        !line.toLowerCase().includes("warning")
      ) {
        dropped_percent += 1;
        continue;
      }
      if (
        _reMatch(_MAKE_ECHO_RE, line) &&
        !line.toLowerCase().includes("error") &&
        !line.toLowerCase().includes("warning") &&
        !_mk_force_keep.has(_mii)
      ) {
        dropped_echo += 1;
        continue;
      }
      // Pass A: suppress extended compiler invocations with look-ahead.
      if (
        _reMatch(_MAKE_COMPILER_EXT_RE, line) &&
        !_reSearch(_MAKE_PRESERVE_SIGNAL_RE, line) &&
        !_mk_force_keep.has(_mii)
      ) {
        dropped_echo += 1;
        continue;
      }
      // Pass C: suppress nothing-to-do lines.
      if (_reMatch(_MAKE_NOTHING_TO_DO_RE, line) && !_reSearch(_MAKE_PRESERVE_SIGNAL_RE, line)) {
        dropped_nothing_to_do += 1;
        continue;
      }
      kept.push(line);
    }
    const notes: string[] = [];
    _maybe_note(notes, dropped_recurse, `${dropped_recurse} 'Entering/Leaving directory' lines`);
    _maybe_note(notes, dropped_echo, `${dropped_echo} compiler-invocation echoes`);
    _maybe_note(notes, dropped_go_download, `${dropped_go_download} 'go: downloading' lines`);
    _maybe_note(notes, dropped_percent, `${dropped_percent} '[N%] Building …' progress lines`);
    _maybe_note(notes, dropped_nothing_to_do, `${dropped_nothing_to_do} 'nothing to be done' lines`);
    // MakeFilter uses ", " join + "dropped" prefix (verbatim grammar match)
    // rather than the standard ";" join, since all entries share the
    // "dropped X" verb.
    if (notes.length > 0) {
      kept.push(`[token-goat: dropped ${notes.join(", ")}]`);
    }
    return Filter._finalize(kept);
  }

  _compress_configure(lines: string[]): string {
    const kept: string[] = [];
    let dropped_checking = 0;
    let dropped_info = 0;

    for (const line of lines) {
      // Always keep error/warning lines regardless of prefix.
      if (_reSearch(_ERROR_SIGNAL_RE, line)) {
        kept.push(line);
        continue;
      }
      // configure: WARNING: is not matched by _ERROR_SIGNAL_RE (which only
      // covers "error:" keywords) — keep it explicitly.
      if (line.toLowerCase().startsWith("configure:") && line.toLowerCase().includes("warning")) {
        kept.push(line);
        continue;
      }
      // configure: creating .../configure: loading ... are benign info.
      if (_reMatch(_CONFIGURE_INFO_RE, line)) {
        // Error/warning checks already passed; this branch fires only for
        // benign info lines (creating, loading, running).
        dropped_info += 1;
        continue;
      }
      // "checking for X ... yes" — pure probe noise.
      if (_reMatch(_CONFIGURE_CHECKING_RE, line)) {
        dropped_checking += 1;
        continue;
      }
      kept.push(line);
    }

    const notes: string[] = [];
    _maybe_note(notes, dropped_checking, `dropped ${dropped_checking} 'checking …' probe lines`);
    _maybe_note(notes, dropped_info, `dropped ${dropped_info} 'configure: creating/loading' lines`);
    if (notes.length > 0) {
      kept.push(`[token-goat: ${notes.join("; ")}]`);
    }
    return Filter._finalize(kept);
  }

  _compress_go_build(lines: string[]): string {
    const kept: string[] = [];
    let dropped_headers = 0;

    for (const line of lines) {
      if (line.startsWith("go: downloading")) {
        // Suppress download progress lines.
        continue;
      }
      if (_reMatch(_GO_BUILD_PKG_HEADER_RE, line)) {
        // Suppress "# package/path" headers.
        dropped_headers += 1;
        continue;
      }
      // Always keep error and warning lines.
      if (_reMatch(_GO_ERROR_RE, line)) {
        kept.push(line);
        continue;
      }
      // Keep build summary lines and blank lines.
      kept.push(line);
    }

    if (dropped_headers) {
      kept.push(
        `[token-goat: suppressed ${dropped_headers} package header lines; ` +
          `compile succeeded]`,
      );
    }
    return Filter._finalize(kept);
  }

  _compress_go_mod(lines: string[]): string {
    const kept: string[] = [];
    let dropped_downloads = 0;

    for (const line of lines) {
      if (_reMatch(_GO_MOD_DOWNLOADING_RE, line)) {
        dropped_downloads += 1;
        continue;
      }
      kept.push(line);
    }

    if (dropped_downloads) {
      kept.push(
        `[token-goat: dropped ${dropped_downloads} 'go: downloading/extracting' lines]`,
      );
    }
    return Filter._finalize(kept);
  }

  _compress_go_vet(lines: string[]): string {
    const kept: string[] = [];
    let dropped_progress = 0;

    for (const line of lines) {
      if (_reMatch(_GO_VET_PROGRESS_RE, line)) {
        dropped_progress += 1;
        continue;
      }
      kept.push(line);
    }

    if (dropped_progress) {
      kept.push(`[token-goat: dropped ${dropped_progress} 'go: vet' progress lines]`);
    }
    return Filter._finalize(kept);
  }

  _compress_go_generate(lines: string[]): string {
    const kept: string[] = [];
    let dropped_triggers = 0;

    for (const line of lines) {
      if (_reMatch(_GO_GENERATE_TRIGGER_RE, line)) {
        dropped_triggers += 1;
        continue;
      }
      kept.push(line);
    }

    if (dropped_triggers) {
      kept.push(
        `[token-goat: dropped ${dropped_triggers} 'go:generate' trigger lines]`,
      );
    }
    return Filter._finalize(kept);
  }
}

// ===========================================================================
// Gradle regexes (Python ~12595-12649).
// ===========================================================================

/** Gradle task progress: "> Task :foo:bar" or "> Configure project". */
const _GRADLE_TASK_PROGRESS_RE: RegExp = /^>\s+(?:Task :|Configure project|Run tasks)/;
/** Gradle build result: "BUILD SUCCESSFUL" or "BUILD FAILED". */
const _GRADLE_BUILD_RESULT_RE: RegExp = /^BUILD (?:SUCCESSFUL|FAILED)/;
/** Gradle failure section: "* What went wrong:". */
const _GRADLE_FAILURE_SECTION_RE: RegExp = /^\* What went wrong:/;
/** Gradle test summary: "X tests passed" or similar. */
const _GRADLE_TEST_SUMMARY_RE: RegExp = /^.*tests? (?:passed|failed)/;
/** Gradle download progress: "Download https://..." or "Downloading https://...". */
const _GRADLE_DOWNLOAD_RE: RegExp = /^(?:Download|Downloading)\s+https?:\/\//;
/** Gradle daemon startup messages. */
const _GRADLE_DAEMON_RE: RegExp = /^(?:Starting Gradle Daemon|Gradle Daemon|Daemon started)/;
/** Gradle build scan lines. */
const _GRADLE_BUILD_SCAN_RE: RegExp =
  /^(?:Publishing build scan\.\.\.|https:\/\/scans\.gradle\.com\/)/;
/** Gradle deprecation warnings and linked doc lines. */
const _GRADLE_DEPRECATION_RE: RegExp =
  /^(?:> [A-Za-z].*\bhas been deprecated\b|See https:\/\/docs\.gradle\.org\/)/;
/** Test method lines that passed or were skipped (noise to drop). */
const _GRADLE_TEST_METHOD_NOISE_RE: RegExp = /^\S.*\s+>\s+\S.*\s+(?:PASSED|SKIPPED)\s*$/;
/** Gradle FAILURE: header line. */
const _GRADLE_FAILURE_HEADER_RE: RegExp = /^FAILURE:/;
/** Task FAILED line: "> Task :foo FAILED". */
const _GRADLE_TASK_FAILED_RE: RegExp = /^> Task :\S+ FAILED\s*$/;
/** Stack frame lines: "    at com.example.Foo.bar(Foo.java:42)". */
const _GRADLE_STACK_FRAME_RE: RegExp = /^\s+at /;
const _GRADLE_EXCEPTION_CLASS_RE: RegExp =
  /^(?:(?:[\w.]+\.)?[A-Z]\w*(?:Exception|Error|Throwable)|Caused by:)/;
/** Test completion summary: "N tests completed, M failed". */
const _GRADLE_TEST_COMPLETION_RE: RegExp = /^\d+ tests? completed/;
/** Maven-style test run progress (appears in some Gradle+Surefire setups). */
const _GRADLE_TEST_RUN_PROGRESS_RE: RegExp = /^Tests run: \d+, Failures: \d+/;

// ===========================================================================
// GradleFilter
// ===========================================================================

export class GradleFilter extends Filter {
  override name = "gradle";
  // ./gradlew reduces to stem "gradlew".
  override binaries: ReadonlySet<string> = new Set(["gradle", "gradlew"]);
  override subcommands: ReadonlySet<string> = new Set([
    "build", "test", "check", "assemble", "verify",
    "clean", "run", "jar", "war", "bootjar", "bootrun",
    "dependencies", "deps", "tasks",
  ]);

  override matches(argv: string[]): boolean {
    if (argv.length === 0) {
      return false;
    }
    const stem = _pathStemLower(argv[0]!);
    const name = _pathNameLower(argv[0]!);
    if (!this.binaries.has(stem) && !this.binaries.has(name)) {
      return false;
    }
    if (this.subcommands.size === 0) {
      return true;
    }
    return _positional_args(argv.slice(1))
      .slice(0, 3)
      .some((tok) => this.subcommands.has(tok.toLowerCase()));
  }

  override compress(stdout: string, stderr: string, exit_code: number, argv: string[]): string {
    const positionals = _positional_args(argv.slice(1));
    const subcommand = positionals.length > 0 ? positionals[0]!.toLowerCase() : "";

    const merged = this._combine_output(stdout, stderr);
    const lines = merged.split("\n");

    // Subcommand-specific compression.
    if (subcommand === "dependencies" || subcommand === "deps") {
      return _head_tail_compress(lines, 10, 10, "lines");
    }
    if (subcommand === "tasks") {
      return _head_tail_compress(lines, 20, 5, "lines");
    }
    if (
      [
        "build", "test", "check", "assemble", "verify",
        "clean", "run", "jar", "war", "bootjar", "bootrun",
      ].includes(subcommand)
    ) {
      return this._compress_build(lines);
    }

    // Default: on failure keep last 20 lines; on success head/tail.
    if (exit_code !== 0) {
      const last_lines = lines.slice(-20).join("\n");
      const err_output = _preserve_stderr_on_error(last_lines, stderr, exit_code);
      if (err_output !== null) {
        return err_output;
      }
      return last_lines;
    }
    return _head_tail_compress(lines, 10, 10, "lines");
  }

  _compress_build(lines: string[]): string {
    const kept: string[] = [];
    let dropped_progress = 0;
    let dropped_downloads = 0;
    let dropped_daemon = 0;
    let dropped_test_methods = 0;
    let dropped_maven_progress = 0;
    let dropped_build_scan = 0;
    let dropped_deprecation = 0;
    let dropped_stack_frames = 0;

    let in_failure_block = false;
    let in_stack_trace = false;
    let stack_frames_kept = 0;

    for (const line of lines) {
      const stripped = _rstripCrLf(line);

      // --- Always-keep rules (evaluated before drop rules) ---

      // BUILD SUCCESSFUL / BUILD FAILED
      if (_reMatch(_GRADLE_BUILD_RESULT_RE, stripped)) {
        kept.push(line);
        in_failure_block = false;
        in_stack_trace = false;
        continue;
      }

      // FAILURE: block header
      if (_reMatch(_GRADLE_FAILURE_HEADER_RE, stripped)) {
        in_failure_block = true;
        in_stack_trace = false;
        kept.push(line);
        continue;
      }

      // "* What went wrong:" (failure detail section)
      if (_reMatch(_GRADLE_FAILURE_SECTION_RE, stripped)) {
        in_failure_block = true;
        in_stack_trace = false;
        kept.push(line);
        continue;
      }

      // > Task :foo FAILED -- task-level failure line
      if (_reMatch(_GRADLE_TASK_FAILED_RE, stripped)) {
        in_failure_block = true;
        in_stack_trace = true;
        stack_frames_kept = 0;
        kept.push(line);
        continue;
      }

      // Exception class name or Caused-by intro starts/continues a trace.
      // Use anchored regex so task names like :handleException are not caught.
      if (_reMatch(_GRADLE_EXCEPTION_CLASS_RE, stripped)) {
        in_stack_trace = true;
        stack_frames_kept = 0;
        kept.push(line);
        continue;
      }

      // Compile error lines
      if (stripped.toLowerCase().includes("error:")) {
        kept.push(line);
        continue;
      }

      // Stack frames: keep first 10 per trace, drop the rest.
      // Auto-arm in_stack_trace on the first "at " frame so the cap also
      // applies when frames arrive after a blank line (no exception header).
      if (_reMatch(_GRADLE_STACK_FRAME_RE, line)) {
        if (!in_stack_trace) {
          in_stack_trace = true;
          stack_frames_kept = 0;
        }
        if (stack_frames_kept < 10) {
          kept.push(line);
          stack_frames_kept += 1;
        } else {
          dropped_stack_frames += 1;
        }
        continue;
      }

      // Inside a failure block: keep everything until a blank line resets it
      if (in_failure_block) {
        if (stripped === "") {
          in_failure_block = false;
          in_stack_trace = false;
        }
        kept.push(line);
        continue;
      }

      // Blank line outside a failure block resets stack-trace state so a
      // subsequent trace in a separate failure section gets a fresh budget.
      if (stripped === "" && in_stack_trace) {
        in_stack_trace = false;
        stack_frames_kept = 0;
        kept.push(line);
        continue;
      }

      // Test completion summary: always keep
      if (_reMatch(_GRADLE_TEST_COMPLETION_RE, stripped)) {
        kept.push(line);
        continue;
      }
      if (_reMatch(_GRADLE_TEST_SUMMARY_RE, stripped)) {
        kept.push(line);
        continue;
      }

      // --- Always-drop rules ---

      // Task/configure progress (> Task :X without FAILED, > Configure project)
      if (_reMatch(_GRADLE_TASK_PROGRESS_RE, stripped)) {
        dropped_progress += 1;
        continue;
      }

      // Download progress
      if (_reMatch(_GRADLE_DOWNLOAD_RE, stripped)) {
        dropped_downloads += 1;
        continue;
      }

      // Gradle Daemon startup messages
      if (_reMatch(_GRADLE_DAEMON_RE, stripped)) {
        dropped_daemon += 1;
        continue;
      }

      // Build scan lines
      if (_reMatch(_GRADLE_BUILD_SCAN_RE, stripped)) {
        dropped_build_scan += 1;
        continue;
      }

      // Deprecation warnings and See-docs lines
      if (_reMatch(_GRADLE_DEPRECATION_RE, stripped)) {
        dropped_deprecation += 1;
        continue;
      }

      // Maven-style test run progress (some Gradle+Surefire setups emit these)
      if (_reMatch(_GRADLE_TEST_RUN_PROGRESS_RE, stripped)) {
        dropped_maven_progress += 1;
        continue;
      }

      // Test method PASSED/SKIPPED lines (individual test results -- noise)
      if (_reMatch(_GRADLE_TEST_METHOD_NOISE_RE, stripped)) {
        dropped_test_methods += 1;
        continue;
      }

      kept.push(line);
    }

    const notes: string[] = [];
    _maybe_note(notes, dropped_progress, `dropped ${dropped_progress} task-progress lines`);
    _maybe_note(notes, dropped_downloads, `collapsed ${dropped_downloads} dependency download lines`);
    _maybe_note(notes, dropped_daemon, `dropped ${dropped_daemon} Gradle Daemon startup lines`);
    _maybe_note(notes, dropped_maven_progress, `dropped ${dropped_maven_progress} Maven test-run progress lines`);
    _maybe_note(notes, dropped_test_methods, `dropped ${dropped_test_methods} test PASSED/SKIPPED lines`);
    _maybe_note(notes, dropped_build_scan, `dropped ${dropped_build_scan} build scan lines`);
    _maybe_note(notes, dropped_deprecation, `dropped ${dropped_deprecation} deprecation warning lines`);
    _maybe_note(notes, dropped_stack_frames, `dropped ${dropped_stack_frames} excess stack-trace frames`);

    Filter._emit_notes(kept, notes);
    return Filter._finalize(kept);
  }
}

// ===========================================================================
// Ant regexes (Python ~12896-12911).
// ===========================================================================

/** Ant task output lines: "[echo] ..." / "[mkdir] ..." / "[copy] ..." / "[javac] ...". */
const _ANT_TASK_LINE_RE: RegExp = /^\s*\[([a-zA-Z0-9_-]+)\]\s/;
/** Ant build result banners. */
const _ANT_BUILD_RESULT_RE: RegExp = /^BUILD (?:SUCCESSFUL|FAILED)/;
/**
 * Ant javac error/warning lines: "[javac] /path/to/File.java:N: error: ..."
 * or "[javac] error:" or "[javac] warning:".
 */
const _ANT_JAVAC_DIAG_RE: RegExp = /^\s*\[javac\]\s+(?:.*:\s+)?(?:error|warning):/;
/** Pure-noise task types: echo, mkdir, copy, delete, move -- collapsed to counts. */
const _ANT_COLLAPSIBLE_TASKS: ReadonlySet<string> = new Set([
  "echo", "mkdir", "copy", "delete", "move", "chmod", "touch", "get",
]);

// ===========================================================================
// AntFilter
// ===========================================================================

export class AntFilter extends Filter {
  override name = "ant";
  override binaries: ReadonlySet<string> = new Set(["ant"]);

  override compress(stdout: string, stderr: string, _exit_code: number, _argv: string[]): string {
    const merged = this._combine_output(stdout, stderr);
    const lines = merged.split("\n");
    const kept: string[] = [];
    // task_type -> count of lines collapsed in the current run.
    const task_counts = new Map<string, number>();

    const flush_task_counts = (): void => {
      // Python iterates sorted(task_counts.items()) — sort keys ascending.
      const keys = [...task_counts.keys()].sort();
      for (const task_type of keys) {
        const count = task_counts.get(task_type)!;
        kept.push(`[token-goat: [${task_type}] ×${count} lines collapsed]`);
      }
      task_counts.clear();
    };

    for (const line of lines) {
      // Always preserve diagnostics from [javac] (errors, warnings).
      if (_reMatch(_ANT_JAVAC_DIAG_RE, line)) {
        flush_task_counts();
        kept.push(line);
        continue;
      }
      // Always preserve build result banners.
      if (_reMatch(_ANT_BUILD_RESULT_RE, line)) {
        flush_task_counts();
        kept.push(line);
        continue;
      }
      const m = _reMatchObj(_ANT_TASK_LINE_RE, line);
      if (m) {
        const task_type = m[1]!.toLowerCase();
        if (_ANT_COLLAPSIBLE_TASKS.has(task_type)) {
          task_counts.set(task_type, (task_counts.get(task_type) ?? 0) + 1);
          continue;
        } else {
          // Non-collapsible task: flush pending counts, then keep.
          flush_task_counts();
          kept.push(line);
          continue;
        }
      }
      // Non-task line (timestamps, blank lines, etc.).
      flush_task_counts();
      kept.push(line);
    }

    flush_task_counts();
    return Filter._finalize(kept);
  }
}

// ===========================================================================
// Bazel regexes (Python ~12981-13004).
// ===========================================================================

/** Bazel INFO lines worth keeping: analyzed/found targets, elapsed time. */
const _BAZEL_INFO_KEEP_RE: RegExp = /^INFO:\s+(?:Analyzed|Found)\s+\d+/;
/** Bazel INFO "From Compiling ..." lines — collapse to count. */
const _BAZEL_INFO_COMPILE_RE: RegExp =
  /^INFO:\s+(?:From Compiling|From Generating|From Linking|From ProtoCompile|From [A-Za-z]+ src\/)/;
/** Generic INFO progress lines to collapse (e.g. "INFO: Build option ..."). */
const _BAZEL_INFO_PROGRESS_RE: RegExp = /^INFO:\s/;
/** Bazel test result lines: "//pkg:target    PASSED in Xs" or "FAILED in Xs". */
const _BAZEL_TEST_RESULT_RE: RegExp = /^\/\/\S+\s+(PASSED|FAILED|TIMEOUT|NO STATUS)\b/;
/** Bazel elapsed time: "Elapsed time: X.Xs". */
const _BAZEL_ELAPSED_RE: RegExp = /^Elapsed time:\s+\d/;
/** Bazel build failure banner. */
const _BAZEL_FAIL_BANNER_RE: RegExp = /^(?:FAILED:|ERROR:|FAIL:|Build did NOT complete|Target \/\/)/;
/** Bazel "Build completed successfully" summary. */
const _BAZEL_BUILD_OK_RE: RegExp = /^(?:Build completed successfully|INFO: Build completed)/;

// ===========================================================================
// BazelFilter
// ===========================================================================

export class BazelFilter extends Filter {
  override name = "bazel";
  override binaries: ReadonlySet<string> = new Set(["bazel", "bazelisk"]);

  override compress(stdout: string, stderr: string, _exit_code: number, _argv: string[]): string {
    const merged = this._combine_output(stdout, stderr);
    const lines = merged.split("\n");
    const kept: string[] = [];
    let compile_count = 0;
    let info_progress_count = 0;
    let test_pass_count = 0;

    for (const line of lines) {
      // Always keep elapsed time and build result banners.
      if (_reMatch(_BAZEL_ELAPSED_RE, line) || _reMatch(_BAZEL_FAIL_BANNER_RE, line)) {
        kept.push(line);
        continue;
      }
      // Always keep build success summaries.
      if (_reMatch(_BAZEL_BUILD_OK_RE, line)) {
        kept.push(line);
        continue;
      }
      // Keep "Analyzed / Found N targets" INFO lines.
      if (_reMatch(_BAZEL_INFO_KEEP_RE, line)) {
        kept.push(line);
        continue;
      }
      // Collapse "From Compiling …" and similar action-progress INFO lines.
      if (_reMatch(_BAZEL_INFO_COMPILE_RE, line)) {
        compile_count += 1;
        continue;
      }
      // Test result lines: keep failures verbatim, count passes.
      if (_reMatch(_BAZEL_TEST_RESULT_RE, line)) {
        const m = _reMatchObj(_BAZEL_TEST_RESULT_RE, line);
        const status = m ? m[1]! : "";
        if (status === "PASSED") {
          test_pass_count += 1;
        } else {
          // FAILED / TIMEOUT / NO STATUS — always keep.
          kept.push(line);
        }
        continue;
      }
      // Remaining INFO: lines — collapse to count.
      if (_reMatch(_BAZEL_INFO_PROGRESS_RE, line)) {
        info_progress_count += 1;
        continue;
      }
      // Everything else: keep.
      kept.push(line);
    }

    const notes: string[] = [];
    _maybe_note(notes, compile_count, `collapsed ${compile_count} 'INFO: From …' compile-action lines`);
    _maybe_note(notes, info_progress_count, `collapsed ${info_progress_count} INFO: progress lines`);
    _maybe_note(notes, test_pass_count, `collapsed ${test_pass_count} PASSED test targets`);
    Filter._emit_notes(kept, notes);
    return Filter._finalize(kept);
  }
}

// ===========================================================================
// Maven regexes (Python ~13086-13126).
// ===========================================================================

/** Maven test summary: "Tests run: X". */
const _MAVEN_TEST_SUMMARY_RE: RegExp = /^(?:\[INFO\]\s+)?Tests run:/;
/** Maven download progress: "Downloading:" or "Downloaded:". */
const _MAVEN_DOWNLOAD_RE: RegExp = /^(?:\[INFO\]\s+)?(?:Downloading|Downloaded):/;
/** Maven build result: "BUILD SUCCESS" or "BUILD FAILURE". */
const _MAVEN_BUILD_RESULT_RE: RegExp = /^\[INFO\]\s+BUILD (?:SUCCESS|FAILURE)/;
/** Maven failure block start. */
const _MAVEN_FAILURE_RE: RegExp = /^\[ERROR\]/;
/**
 * Maven [INFO] separator lines: "[INFO] --------...--------".
 * These are decorative dashes emitted before/after each module build and
 * between lifecycle phase transitions — pure noise (dozens per build).
 */
const _MAVEN_SEPARATOR_RE: RegExp = /^\[INFO\]\s*-{10,}/;
/**
 * Maven [INFO] boilerplate lines that carry zero actionable information:
 * "Scanning for projects...", "Building X 1.2.3", "--- plugin:version ---",
 * "BUILD SUCCESS" is NOT included here (it is kept verbatim).
 */
const _MAVEN_INFO_BOILERPLATE_RE: RegExp = new RegExp(
  "^\\[INFO\\]\\s+(?:" +
    "Scanning for projects\\.\\.\\." +
    "|Building\\s+\\S" + // "[INFO] Building my-artifact 1.0-SNAPSHOT"
    "|--- " + // "[INFO] --- maven-compiler-plugin:3.11.0:compile ..."
    "|skip non existing " + // "[INFO] skip non existing resourceDirectory ..."
    "|No sources to compile" +
    "|Nothing to compile" +
    "|Compiling \\d+ source" + // "[INFO] Compiling 42 source files"
    "|Changes detected" +
    "|Not compiling" +
    ")",
);
/** Maven [INFO] reactor lines: "Reactor Build Order:", "Reactor Summary for...". */
const _MAVEN_REACTOR_RE: RegExp = /^\[INFO\]\s+Reactor (?:Build Order|Summary)/;

// ===========================================================================
// MavenFilter
// ===========================================================================

export class MavenFilter extends Filter {
  override name = "maven";
  override binaries: ReadonlySet<string> = new Set(["mvn", "mvnw", "./mvnw"]);

  override compress(stdout: string, stderr: string, exit_code: number, argv: string[]): string {
    const positionals = _positional_args(argv.slice(1));
    const subcommand = positionals.length > 0 ? positionals[0]!.toLowerCase() : "";

    const merged = this._combine_output(stdout, stderr);
    const lines = merged.split("\n");

    // On failure, preserve all errors.
    if (exit_code !== 0) {
      const error_lines = lines.filter((line) => _reMatch(_MAVEN_FAILURE_RE, line));
      if (error_lines.length > 0) {
        const tail_output = lines.slice(-20).join("\n");
        const errors_output = error_lines.join("\n");
        return tail_output + "\n---\n" + errors_output;
      }
      return lines.slice(-20).join("\n");
    }

    // Subcommand-specific compression.
    if (subcommand.includes("dependency") && subcommand.includes("tree")) {
      return _head_tail_compress(lines, 10, 10, "lines");
    }
    if (subcommand === "install") {
      return _head_tail_compress(lines.slice(-30), 30, 10, "lines");
    }
    if (subcommand === "test" || subcommand === "verify" || subcommand === "package") {
      return this._compress_test(lines);
    }

    // Default: use head/tail for unknown subcommands.
    return _head_tail_compress(lines, 10, 10, "lines");
  }

  _compress_test(lines: string[]): string {
    const kept: string[] = [];
    let dropped_downloads = 0;
    let dropped_separators = 0;
    let dropped_boilerplate = 0;
    let dropped_reactor = 0;

    for (const line of lines) {
      // Always keep [WARN] and [ERROR] lines.
      if (
        line.startsWith("[WARNING]") ||
        line.startsWith("[WARN]") ||
        line.startsWith("[ERROR]")
      ) {
        kept.push(line);
        continue;
      }
      // Always keep test summary lines and BUILD result lines.
      if (_reMatch(_MAVEN_TEST_SUMMARY_RE, line) || _reMatch(_MAVEN_BUILD_RESULT_RE, line)) {
        kept.push(line);
        continue;
      }
      // Drop download progress lines.
      if (_reMatch(_MAVEN_DOWNLOAD_RE, line)) {
        dropped_downloads += 1;
        continue;
      }
      // Drop "[INFO] --------…--------" separator lines.
      if (_reMatch(_MAVEN_SEPARATOR_RE, line)) {
        dropped_separators += 1;
        continue;
      }
      // Drop "[INFO] Building X", "[INFO] Scanning for projects…", etc.
      if (_reMatch(_MAVEN_INFO_BOILERPLATE_RE, line)) {
        dropped_boilerplate += 1;
        continue;
      }
      // Drop Reactor header lines (multi-module build noise).
      if (_reMatch(_MAVEN_REACTOR_RE, line)) {
        dropped_reactor += 1;
        continue;
      }
      kept.push(line);
    }

    const notes: string[] = [];
    _maybe_note(notes, dropped_downloads, `dropped ${dropped_downloads} download-progress lines`);
    const total_info_dropped = dropped_separators + dropped_boilerplate + dropped_reactor;
    _maybe_note(notes, total_info_dropped, `collapsed ${total_info_dropped} [INFO] boilerplate/separator lines`);

    Filter._emit_notes(kept, notes);
    return Filter._finalize(kept);
  }
}

// ===========================================================================
// Javac regexes (Python ~13242-13266).
// ===========================================================================

/** javac "Note: file.java uses unchecked or unsafe operations" lines. */
const _JAVAC_NOTE_RE: RegExp =
  /^Note:\s+\S.*\.java\s+uses (unchecked or unsafe|preview language|deprecated)/;
/** javac "Note: Some input files use unchecked or unsafe operations." (summary note). */
const _JAVAC_NOTE_SUMMARY_RE: RegExp = /^Note:\s+(?:Some input files use|Recompile with -Xlint)/;
/** javac error line: "File.java:N: error: ..." or "error: N error(s)". */
const _JAVAC_ERROR_RE: RegExp = /^(?:\S.*\.java:\d+:|error:|Error\s+\(|\d+ error)/;
/** javac warning line: "File.java:N: warning: ..." or "warning: N warning(s)". */
const _JAVAC_WARNING_RE: RegExp = /^(?:\S.*\.java:\d+: warning:|warning:|\d+ warning)/;
/** javac summary line: "N error(s)" or "N warning(s)". */
const _JAVAC_SUMMARY_RE: RegExp = /^\d+ (?:error|warning)s?/;
/** javac "^" caret pointer lines (diagnostic context). */
const _JAVAC_CARET_RE: RegExp = /^\s*\^\s*$/;
/**
 * javac source-context line embedded in error block: looks like source code.
 * These are lines immediately after "file:N: error:" that show the source snippet.
 */
const _JAVAC_SOURCE_SNIPPET_RE: RegExp = /^(?:\s{4,}|\t)/;

// ===========================================================================
// JavacFilter
// ===========================================================================

export class JavacFilter extends Filter {
  override name = "javac";
  override binaries: ReadonlySet<string> = new Set(["javac"]);

  override compress(stdout: string, stderr: string, _exit_code: number, _argv: string[]): string {
    const merged = this._combine_output(stdout, stderr);
    const lines = merged.split("\n");
    const kept: string[] = [];
    let dropped_notes = 0;
    let in_diag_block = false; // True while inside an error/warning block.

    for (const line of lines) {
      // Collapse per-file Note: lines.
      if (_reMatch(_JAVAC_NOTE_RE, line)) {
        dropped_notes += 1;
        continue;
      }
      // Drop summary note lines (redundant).
      if (_reMatch(_JAVAC_NOTE_SUMMARY_RE, line)) {
        continue;
      }
      // Always keep error and warning diagnostic lines; they open a block.
      if (_reMatch(_JAVAC_ERROR_RE, line) || _reMatch(_JAVAC_WARNING_RE, line)) {
        in_diag_block = true;
        kept.push(line);
        continue;
      }
      // Keep N error(s) / N warning(s) summary lines.
      if (_reMatch(_JAVAC_SUMMARY_RE, line)) {
        in_diag_block = false;
        kept.push(line);
        continue;
      }
      // Inside a diagnostic block keep source snippets and caret lines.
      if (
        in_diag_block &&
        (_reMatch(_JAVAC_CARET_RE, line) ||
          _reMatch(_JAVAC_SOURCE_SNIPPET_RE, line) ||
          line.trim() !== "") // any non-blank continuation
      ) {
        if (line.trim() === "") {
          // Blank line ends the block; drop it to reduce noise.
          in_diag_block = false;
        } else {
          kept.push(line);
        }
        continue;
      }
      // Blank lines outside a block: drop.
      if (line.trim() === "") {
        continue;
      }
      // Anything else (e.g. "1 error" summary not matched above): keep.
      in_diag_block = false;
      kept.push(line);
    }

    const notes: string[] = [];
    if (dropped_notes) {
      notes.push(`collapsed ${dropped_notes} 'Note: … uses unchecked/unsafe' lines`);
    }
    Filter._emit_notes(kept, notes);
    return Filter._finalize(kept);
  }
}

// ===========================================================================
// Sbt regexes (Python ~13352-13396).
// ===========================================================================

/** sbt [info] lines worth keeping: compilation start and done. */
const _SBT_INFO_COMPILING_RE: RegExp = /^\[info\]\s+Compiling\s+\d+/;
const _SBT_INFO_DONE_RE: RegExp = /^\[info\]\s+Done (?:compiling|packaging)\./;
/** sbt [info] loading / project-resolution lines: collapse to count. */
const _SBT_INFO_LOADING_RE: RegExp = new RegExp(
  "^\\[info\\]\\s+(?:Loading |Set current project|Resolving |Fetching |" +
    "Download|Updating|Wrote |Packaging |" +
    "Main Scala API documentation|Making\\s)",
);
/** sbt [warn] lines. */
const _SBT_WARN_RE: RegExp = /^\[warn\]\s/;
/** sbt [error] lines (always keep). */
const _SBT_ERROR_RE: RegExp = /^\[error\]\s/;
/** sbt test-run ScalaTest/MUnit/JUnit dot-progress (dots and letters on their own line). */
const _SBT_TEST_PROGRESS_RE: RegExp = /^\[info\]\s+[.FEI!]+\s*$/;
/**
 * ScalaTest / Specs2 verbose passing-test lines: "[info]   - test name (N ms)"
 * or "[info]   + test name" (Specs2) or "[info]   ✓ test name" (MUnit). These are
 * collapsed when there are many; failures ("[info]   - *** FAILED ***") are kept.
 */
const _SBT_SCALATEST_PASS_RE: RegExp =
  /^\[info\]\s+(?:- (?!.*\*\*\* FAILED \*\*\*)|[+✓]\s)\S/;
/** sbt "Total time: Xs" summary. */
const _SBT_TOTAL_TIME_RE: RegExp = /^\[(?:success|info)\]\s+Total time:/;
/** sbt "[success] Total time: ..." or "BUILD SUCCESS". */
const _SBT_SUCCESS_RE: RegExp = /^\[success\]\s/;
/** sbt "Failed tests:" error block header. */
const _SBT_FAILED_TESTS_RE: RegExp = /^\[error\]\s+Failed tests:/;
void _SBT_FAILED_TESTS_RE; // defined in Python but unused in compress(); kept for parity.
/** sbt test result summary: "[info] Tests: succeeded X, failed Y". */
const _SBT_TEST_SUMMARY_RE: RegExp =
  /^\[info\]\s+(?:Tests: succeeded|All tests passed|Test run (?:finished|failed))/;

/** Maximum [warn] lines per unique category prefix to keep (first N kept, rest collapsed). */
const _SBT_MAX_WARN_PER_CATEGORY = 5;

// ===========================================================================
// SbtFilter
// ===========================================================================

export class SbtFilter extends Filter {
  override name = "sbt";
  override binaries: ReadonlySet<string> = new Set(["sbt"]);

  override matches(argv: string[]): boolean {
    if (argv.length === 0) {
      return false;
    }
    const stem = _pathStemLower(argv[0]!);
    const name = _pathNameLower(argv[0]!);
    // Match "sbt" and "./sbt" (common wrapper script invocation).
    return this.binaries.has(stem) || this.binaries.has(name);
  }

  override compress(stdout: string, stderr: string, _exit_code: number, _argv: string[]): string {
    const merged = this._combine_output(stdout, stderr);
    const lines = merged.split("\n");
    const kept: string[] = [];
    let dropped_loading = 0;
    let dropped_test_progress = 0;
    let dropped_passing_tests = 0;
    // Track [warn] lines per category; category = first ~60 chars of text.
    const warn_counts = new Map<string, number>();
    let dropped_warn_extra = 0;

    for (const line of lines) {
      // Always keep [error] lines.
      if (_reMatch(_SBT_ERROR_RE, line)) {
        kept.push(line);
        continue;
      }
      // Always keep compilation start / done messages.
      if (_reMatch(_SBT_INFO_COMPILING_RE, line) || _reMatch(_SBT_INFO_DONE_RE, line)) {
        kept.push(line);
        continue;
      }
      // Always keep test summary lines.
      if (_reMatch(_SBT_TEST_SUMMARY_RE, line)) {
        kept.push(line);
        continue;
      }
      // Always keep total-time / success lines.
      if (_reMatch(_SBT_TOTAL_TIME_RE, line) || _reMatch(_SBT_SUCCESS_RE, line)) {
        kept.push(line);
        continue;
      }
      // Collapse loading / resolution [info] noise.
      if (_reMatch(_SBT_INFO_LOADING_RE, line)) {
        dropped_loading += 1;
        continue;
      }
      // Collapse test dot-progress [info] lines.
      if (_reMatch(_SBT_TEST_PROGRESS_RE, line)) {
        dropped_test_progress += 1;
        continue;
      }
      // Collapse ScalaTest/Specs2/MUnit verbose passing-test lines
      // ("[info]   - test name (N ms)", "[info]   + test name").
      // The regex already excludes "*** FAILED ***" lines.
      if (_reMatch(_SBT_SCALATEST_PASS_RE, line)) {
        dropped_passing_tests += 1;
        continue;
      }
      // Deduplicate [warn] lines per category.
      if (_reMatch(_SBT_WARN_RE, line)) {
        // Use the first 60 chars as the category key (strips variable
        // file/line suffixes but preserves the warning type).
        const category = line.slice(0, 60).trim();
        const count = warn_counts.get(category) ?? 0;
        warn_counts.set(category, count + 1);
        if (count < _SBT_MAX_WARN_PER_CATEGORY) {
          kept.push(line);
        } else {
          dropped_warn_extra += 1;
        }
        continue;
      }
      // Anything else: keep.
      kept.push(line);
    }

    const notes: string[] = [];
    _maybe_note(notes, dropped_loading, `collapsed ${dropped_loading} [info] loading/resolution lines`);
    _maybe_note(notes, dropped_test_progress, `collapsed ${dropped_test_progress} test dot-progress lines`);
    _maybe_note(notes, dropped_passing_tests, `collapsed ${dropped_passing_tests} verbose passing-test lines`);
    _maybe_note(notes, dropped_warn_extra, `collapsed ${dropped_warn_extra} duplicate [warn] lines`);
    Filter._emit_notes(kept, notes);
    return Filter._finalize(kept);
  }
}
