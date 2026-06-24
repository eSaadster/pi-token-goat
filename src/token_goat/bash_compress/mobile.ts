/**
 * bash_compress MOBILE / APPLE / DART FILTERS — TypeScript port of the
 * Flutter / Dart / Pub / Swift / Xcode / SwiftLint Filter subclasses from
 * src/token_goat/bash_compress.py.
 *
 * Six filters subclass the concrete Filter base from ./framework.js:
 *   - FlutterFilter   — `flutter` build/test/run/pub. Dispatches on the first
 *                       positional: test -> _compress_test, pub -> _compress_pub,
 *                       else _compress_build.
 *   - DartFilter      — `dart` compile/test/pub/analyze/run/format. Dispatches:
 *                       analyze, test, pub, else generic.
 *   - PubFilter       — `pub` get/upgrade/publish/add/remove (Dart/Flutter pub).
 *   - SwiftFilter     — `swift` build/test/run/package. test -> _compress_test,
 *                       else _compress_build.
 *   - XcodeFilter     — `xcodebuild` (no subcommands).
 *   - SwiftLintFilter — `swiftlint` (no subcommands; per-rule warning dedup).
 *
 * ---------------------------------------------------------------------------
 * Parity notes (Python -> TS)
 * ---------------------------------------------------------------------------
 *  - Python identifiers preserved EXACTLY: PascalCase class names; snake_case
 *    methods/fields (matches, compress, _compress_build, _compress_test,
 *    _compress_pub, _compress_analyze, _compress_generic); snake_case
 *    module-private regex constants (_FLUTTER_*, _DART_*, _PUB_*, _SWIFT_*,
 *    _XCODE_*, _SWIFTLINT_*).
 *  - re.compile(...) -> top-level RegExp compiled once. re.IGNORECASE -> "i".
 *  - Python re.Pattern.match(line) is START-anchored (NOT end-anchored); emulated
 *    via _reMatch (non-global clone + index===0). .search() -> _reSearch /
 *    _reMatchObj (non-global clone, .exec); capture groups read off the
 *    RegExpExecArray. The Flutter/Dart/Swift test-summary regexes are used with
 *    .search() (match anywhere), the progress/build regexes with .match()
 *    (start-anchored) — reproduced exactly.
 *  - _ERROR_SIGNAL_RE is framework-PRIVATE (not exported by framework.ts); it is
 *    re-declared MODULE-PRIVATE here (NOT exported) to avoid a duplicate-export
 *    ambiguity (TS2308) across the barrel export* chain.
 *  - _positional_args / _maybe_note are framework-PUBLIC and imported.
 *    _combine_output is an INSTANCE method; _finalize / _emit_notes are STATIC
 *    methods on Filter (called as Filter._finalize / Filter._emit_notes).
 *  - DartFilter._compress_pub reuses the standalone _PUB_* regexes (NOT the
 *    _FLUTTER_PUB_* ones) — matching the Python delegation.
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
  _maybe_note,
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
// Module-private framework regexes re-declared here (framework does NOT export
// _ERROR_SIGNAL_RE — re-exporting it would create a TS2308 ambiguity).
// ===========================================================================

/** Python _ERROR_SIGNAL_RE (framework-private) — re-declared module-private. */
const _ERROR_SIGNAL_RE: RegExp =
  /error:|Error:|ERROR|FAILED|failed|fatal:|Traceback|exception:|Exception:|AssertionError|assert |panic:/i;

// ===========================================================================
// Flutter regexes (Python ~14086-14118).
// ===========================================================================

/** Flutter build compilation lines: "Compiling lib/..." noise. */
const _FLUTTER_COMPILING_RE: RegExp = /^Compiling\s+lib\//;
/** Flutter build success line: "✓ Built build/..." — always keep. */
const _FLUTTER_BUILT_RE: RegExp = /^[✓✔]\s+Built\s+\S/;
/** Flutter font asset lines: "Font asset ...". */
const _FLUTTER_FONT_ASSET_RE: RegExp = /^Font asset\s/;
/** Flutter "Running Gradle task" — always keep. */
const _FLUTTER_GRADLE_RE: RegExp = /^Running Gradle task\s/;
/** Flutter test progress lines: "00:XX +N:" or "00:XX +N -M:". */
const _FLUTTER_TEST_PROGRESS_RE: RegExp = /^\d{2}:\d{2}\s+[+\d]/;
/** Flutter test summary: "All tests passed!" / "N tests passed" / "N tests failed". */
const _FLUTTER_TEST_SUMMARY_RE: RegExp =
  /(?:All tests passed!|\d+\s+test[s]?\s+(?:passed|failed))/;
/** Flutter pub dependency resolution/change lines to keep. */
const _FLUTTER_PUB_KEEP_RE: RegExp =
  /^(?:Resolving dependencies|Changed \d+|No dependencies changed|Got dependencies|Downloading packages|Building package executable|Package\s+\w+\s+is)/;
/** Flutter pub new package lines: "+ package_name version" — collapse to count. */
const _FLUTTER_PUB_PKG_LINE_RE: RegExp = /^\+\s+\S+\s+\S+/;

// ===========================================================================
// FlutterFilter
// ===========================================================================

export class FlutterFilter extends Filter {
  override name = "flutter";
  override binaries: ReadonlySet<string> = new Set(["flutter"]);
  override subcommands: ReadonlySet<string> = new Set(["build", "test", "run", "pub"]);

  override compress(stdout: string, stderr: string, _exit_code: number, argv: string[]): string {
    const positionals = _positional_args(argv.slice(1));
    const subcommand = positionals.length > 0 ? positionals[0]! : "";
    if (subcommand === "test") {
      return this._compress_test(stdout, stderr);
    }
    if (subcommand === "pub") {
      return this._compress_pub(stdout, stderr);
    }
    // build / run and anything else
    return this._compress_build(stdout, stderr);
  }

  _compress_build(stdout: string, stderr: string): string {
    const merged = this._combine_output(stdout, stderr);
    const lines = merged.split("\n");
    const kept: string[] = [];
    let compile_count = 0;
    let font_count = 0;
    for (const line of lines) {
      if (_reSearch(_ERROR_SIGNAL_RE, line)) {
        kept.push(line);
        continue;
      }
      if (_reMatch(_FLUTTER_GRADLE_RE, line) || _reMatch(_FLUTTER_BUILT_RE, line)) {
        kept.push(line);
        continue;
      }
      if (_reMatch(_FLUTTER_COMPILING_RE, line)) {
        compile_count += 1;
        continue;
      }
      if (_reMatch(_FLUTTER_FONT_ASSET_RE, line)) {
        font_count += 1;
        continue;
      }
      kept.push(line);
    }
    const notes: string[] = [];
    _maybe_note(notes, compile_count, `collapsed ${compile_count} 'Compiling lib/' lines`);
    _maybe_note(notes, font_count, `collapsed ${font_count} font asset lines`);
    Filter._emit_notes(kept, notes);
    return Filter._finalize(kept);
  }

  _compress_test(stdout: string, stderr: string): string {
    const merged = this._combine_output(stdout, stderr);
    const lines = merged.split("\n");
    const kept: string[] = [];
    let progress_count = 0;
    let in_failure = false;
    for (const line of lines) {
      if (_reSearch(_ERROR_SIGNAL_RE, line)) {
        in_failure = true;
        kept.push(line);
        continue;
      }
      // Check summary before progress — "00:XX +N: All tests passed!" is both.
      if (_reSearch(_FLUTTER_TEST_SUMMARY_RE, line)) {
        in_failure = false;
        kept.push(line);
        continue;
      }
      if (in_failure) {
        // Keep indented failure body until a blank or progress line.
        if (line.trim() === "" || _reMatch(_FLUTTER_TEST_PROGRESS_RE, line)) {
          in_failure = false;
          if (line.trim() === "") {
            kept.push(line);
          } else {
            progress_count += 1;
          }
        } else {
          kept.push(line);
        }
        continue;
      }
      if (_reMatch(_FLUTTER_TEST_PROGRESS_RE, line)) {
        progress_count += 1;
        continue;
      }
      kept.push(line);
    }
    const notes: string[] = [];
    _maybe_note(notes, progress_count, `collapsed ${progress_count} test progress lines`);
    Filter._emit_notes(kept, notes);
    return Filter._finalize(kept);
  }

  _compress_pub(stdout: string, stderr: string): string {
    const merged = this._combine_output(stdout, stderr);
    const lines = merged.split("\n");
    const kept: string[] = [];
    let pkg_count = 0;
    for (const line of lines) {
      if (_reSearch(_ERROR_SIGNAL_RE, line)) {
        kept.push(line);
        continue;
      }
      if (_reMatch(_FLUTTER_PUB_KEEP_RE, line)) {
        kept.push(line);
        continue;
      }
      if (_reMatch(_FLUTTER_PUB_PKG_LINE_RE, line)) {
        pkg_count += 1;
        continue;
      }
      kept.push(line);
    }
    const notes: string[] = [];
    _maybe_note(notes, pkg_count, `collapsed ${pkg_count} package dependency lines`);
    Filter._emit_notes(kept, notes);
    return Filter._finalize(kept);
  }
}

// ===========================================================================
// Dart regexes (Python ~14254-14272).
// ===========================================================================

/** dart analyze: "Analyzing ..." header. */
const _DART_ANALYZING_RE: RegExp = /^Analyzing\s/;
/** dart analyze result lines to always keep. */
const _DART_ANALYZE_RESULT_RE: RegExp =
  /^(?:No issues found!|\d+ issue[s]? found\.|warning -|error -|info -|hint -)/;
/** dart test progress: dots or "00:XX +N" style progress lines. */
const _DART_TEST_PROGRESS_RE: RegExp = /^\d{2}:\d{2}\s+[+\d]|^[.]+$/;
/** dart compile completion line. */
const _DART_COMPILE_DONE_RE: RegExp = /^(?:Generated:\s|Compiling\s)/;
/** dart test summary: "All tests passed" / "N tests failed". */
const _DART_TEST_SUMMARY_RE: RegExp =
  /(?:All tests passed\.?|\d+\s+test[s]?\s+(?:passed|failed))/;

// ===========================================================================
// DartFilter
// ===========================================================================

export class DartFilter extends Filter {
  override name = "dart";
  override binaries: ReadonlySet<string> = new Set(["dart"]);
  override subcommands: ReadonlySet<string> = new Set([
    "compile", "test", "pub", "analyze", "run", "format",
  ]);

  override compress(stdout: string, stderr: string, _exit_code: number, argv: string[]): string {
    const positionals = _positional_args(argv.slice(1));
    const subcommand = positionals.length > 0 ? positionals[0]! : "";
    if (subcommand === "analyze") {
      return this._compress_analyze(stdout, stderr);
    }
    if (subcommand === "test") {
      return this._compress_test(stdout, stderr);
    }
    if (subcommand === "pub") {
      return this._compress_pub(stdout, stderr);
    }
    // compile, run, format: light compression — keep everything except noise
    return this._compress_generic(stdout, stderr);
  }

  _compress_analyze(stdout: string, stderr: string): string {
    // dart analyze output is already compact; mostly pass through.
    const merged = this._combine_output(stdout, stderr);
    const lines = merged.split("\n");
    const kept: string[] = [];
    for (const line of lines) {
      // Keep all analyze output — it's already compact and high-signal.
      if (
        _reMatch(_DART_ANALYZING_RE, line) ||
        _reMatch(_DART_ANALYZE_RESULT_RE, line) ||
        _reSearch(_ERROR_SIGNAL_RE, line) ||
        line.trim() !== ""
      ) {
        kept.push(line);
      }
    }
    return Filter._finalize(kept);
  }

  _compress_test(stdout: string, stderr: string): string {
    const merged = this._combine_output(stdout, stderr);
    const lines = merged.split("\n");
    const kept: string[] = [];
    let progress_count = 0;
    let in_failure = false;
    for (const line of lines) {
      if (_reSearch(_ERROR_SIGNAL_RE, line)) {
        in_failure = true;
        kept.push(line);
        continue;
      }
      // Check summary before progress — "00:XX +N: All tests passed." is both.
      if (_reSearch(_DART_TEST_SUMMARY_RE, line)) {
        in_failure = false;
        kept.push(line);
        continue;
      }
      if (in_failure) {
        if (line.trim() === "" || _reMatch(_DART_TEST_PROGRESS_RE, line)) {
          in_failure = false;
          if (line.trim() === "") {
            kept.push(line);
          } else {
            progress_count += 1;
          }
        } else {
          kept.push(line);
        }
        continue;
      }
      if (_reMatch(_DART_TEST_PROGRESS_RE, line)) {
        progress_count += 1;
        continue;
      }
      kept.push(line);
    }
    const notes: string[] = [];
    _maybe_note(notes, progress_count, `collapsed ${progress_count} test progress lines`);
    Filter._emit_notes(kept, notes);
    return Filter._finalize(kept);
  }

  _compress_pub(stdout: string, stderr: string): string {
    // Delegate to pub-style compression.
    const merged = this._combine_output(stdout, stderr);
    const lines = merged.split("\n");
    const kept: string[] = [];
    let pkg_count = 0;
    let download_count = 0;
    for (const line of lines) {
      if (_reSearch(_ERROR_SIGNAL_RE, line)) {
        kept.push(line);
        continue;
      }
      if (_reMatch(_PUB_KEEP_RE, line)) {
        kept.push(line);
        continue;
      }
      if (_reMatch(_PUB_PKG_LINE_RE, line)) {
        pkg_count += 1;
        continue;
      }
      if (_reMatch(_PUB_DOWNLOADING_RE, line)) {
        download_count += 1;
        continue;
      }
      kept.push(line);
    }
    const notes: string[] = [];
    _maybe_note(notes, pkg_count, `collapsed ${pkg_count} package lines`);
    _maybe_note(notes, download_count, `collapsed ${download_count} download lines`);
    Filter._emit_notes(kept, notes);
    return Filter._finalize(kept);
  }

  _compress_generic(stdout: string, stderr: string): string {
    const merged = this._combine_output(stdout, stderr);
    const lines = merged.split("\n");
    const kept: string[] = [];
    for (const line of lines) {
      if (_reMatch(_DART_COMPILE_DONE_RE, line) || _reSearch(_ERROR_SIGNAL_RE, line)) {
        kept.push(line);
        continue;
      }
      kept.push(line);
    }
    return Filter._finalize(kept);
  }
}

// ===========================================================================
// pub (standalone) regexes (Python ~14414-14424).
// ===========================================================================

/** pub keep lines: resolution headers and change summaries. */
const _PUB_KEEP_RE: RegExp =
  /^(?:Resolving dependencies|Changed \d+|No dependencies changed|Got dependencies|Downloading packages|Building package executable)/;
/** pub new/changed package lines: "+ package_name version" or "> package_name version". */
const _PUB_PKG_LINE_RE: RegExp = /^[+>!]\s+\S+\s+\S+/;
/** pub downloading lines: "Downloading package_name version...". */
const _PUB_DOWNLOADING_RE: RegExp = /^Downloading\s+\S+\s+\S+/;

// ===========================================================================
// PubFilter
// ===========================================================================

export class PubFilter extends Filter {
  override name = "pub";
  override binaries: ReadonlySet<string> = new Set(["pub"]);
  override subcommands: ReadonlySet<string> = new Set([
    "get", "upgrade", "publish", "add", "remove",
  ]);

  override compress(stdout: string, stderr: string, _exit_code: number, _argv: string[]): string {
    const merged = this._combine_output(stdout, stderr);
    const lines = merged.split("\n");
    const kept: string[] = [];
    let pkg_count = 0;
    let download_count = 0;
    for (const line of lines) {
      if (_reSearch(_ERROR_SIGNAL_RE, line)) {
        kept.push(line);
        continue;
      }
      if (_reMatch(_PUB_KEEP_RE, line)) {
        kept.push(line);
        continue;
      }
      if (_reMatch(_PUB_PKG_LINE_RE, line)) {
        pkg_count += 1;
        continue;
      }
      if (_reMatch(_PUB_DOWNLOADING_RE, line)) {
        download_count += 1;
        continue;
      }
      kept.push(line);
    }
    const notes: string[] = [];
    _maybe_note(notes, pkg_count, `collapsed ${pkg_count} package lines`);
    _maybe_note(notes, download_count, `collapsed ${download_count} download lines`);
    Filter._emit_notes(kept, notes);
    return Filter._finalize(kept);
  }
}

// ===========================================================================
// Swift regexes (Python ~14482-14517).
// ===========================================================================

/** Swift compiler build-phase lines: "CompileSwift normal arm64 path/to/File.swift". */
const _SWIFT_COMPILE_RE: RegExp =
  /^\s*(CompileSwift|CompileSwiftSources|MergeSwiftModule|PhaseScriptExecution|CpResource|CpHeader|ProcessInfoPlistFile|Ld\s|CodeSign\s|Touch\s|note:\s+compile\s+Swift\s+module)\s/;
/** Swift test result lines: "Test Case '-[Module.TestClass testMethod]' passed". */
const _SWIFT_TEST_PASS_RE: RegExp = /^Test Case\s+.+\s+passed\s+\(/;
/** Swift test case "started" lines — pure noise, always dropped. */
const _SWIFT_TEST_START_RE: RegExp = /^Test Case\s+.+\s+started\.$/;
/** Swift test failure lines. */
const _SWIFT_TEST_FAIL_RE: RegExp = /^Test Case\s+.+\s+failed\s+\(/;
/** Swift test suite summary: "Test Suite '…' passed" / "Test Suite '…' failed". */
const _SWIFT_SUITE_RE: RegExp = /^Test Suite\s+.+\s+(passed|failed)\s+at\b/;
/** Swift overall test results: "Executed N tests, with N failures". */
const _SWIFT_RESULTS_RE: RegExp = /^Executed \d+ test/;
/** Swift build completion line. */
const _SWIFT_BUILD_COMPLETE_RE: RegExp =
  /^\*\*\s*BUILD SUCCEEDED\s*\*\*|^\*\*\s*BUILD FAILED\s*\*\*|^Build complete!/;
/** Swift warning/error lines (file:line:col: warning/error: message). */
const _SWIFT_DIAG_RE: RegExp = /^.*:\d+:\d+:\s+(warning|error):\s/;

// ===========================================================================
// SwiftFilter
// ===========================================================================

export class SwiftFilter extends Filter {
  override name = "swift";
  override binaries: ReadonlySet<string> = new Set(["swift"]);
  override subcommands: ReadonlySet<string> = new Set(["build", "test", "run", "package"]);

  override compress(stdout: string, stderr: string, _exit_code: number, argv: string[]): string {
    const positionals = _positional_args(argv.slice(1));
    const subcommand = positionals.length > 0 ? positionals[0]! : "";
    if (subcommand === "test") {
      return this._compress_test(stdout, stderr);
    }
    return this._compress_build(stdout, stderr);
  }

  _compress_build(stdout: string, stderr: string): string {
    const merged = this._combine_output(stdout, stderr);
    const lines = merged.split("\n");
    const kept: string[] = [];
    let compile_count = 0;
    for (const line of lines) {
      // Always keep diagnostics (warnings, errors) and completion lines.
      if (_reMatch(_SWIFT_DIAG_RE, line) || _reMatch(_SWIFT_BUILD_COMPLETE_RE, line)) {
        kept.push(line);
        continue;
      }
      // Collapse verbose build-phase lines.
      if (_reMatch(_SWIFT_COMPILE_RE, line)) {
        compile_count += 1;
        continue;
      }
      kept.push(line);
    }
    const notes: string[] = [];
    _maybe_note(notes, compile_count, `collapsed ${compile_count} Swift build-phase lines`);
    Filter._emit_notes(kept, notes);
    return Filter._finalize(kept);
  }

  _compress_test(stdout: string, stderr: string): string {
    const merged = this._combine_output(stdout, stderr);
    const lines = merged.split("\n");
    const kept: string[] = [];
    let pass_count = 0;
    let in_fail_block = false;
    for (const line of lines) {
      // "Test Case '…' started." — always noise, drop silently.
      if (_reMatch(_SWIFT_TEST_START_RE, line)) {
        continue;
      }
      // Passing test: count, drop.
      if (_reMatch(_SWIFT_TEST_PASS_RE, line)) {
        in_fail_block = false;
        pass_count += 1;
        continue;
      }
      // Failing test: keep and open fail block.
      if (_reMatch(_SWIFT_TEST_FAIL_RE, line)) {
        in_fail_block = true;
        kept.push(line);
        continue;
      }
      // Suite summaries and overall results are always kept.
      if (_reMatch(_SWIFT_SUITE_RE, line) || _reMatch(_SWIFT_RESULTS_RE, line)) {
        in_fail_block = false;
        kept.push(line);
        continue;
      }
      // Indented failure body lines inside a fail block.
      if (in_fail_block && (line.startsWith("  ") || line.startsWith("\t") || line.trim() === "")) {
        kept.push(line);
        continue;
      }
      // Any other non-indented line exits the fail block.
      in_fail_block = false;
      // Also keep build-phase output that may appear before the tests.
      if (_reMatch(_SWIFT_COMPILE_RE, line)) {
        // Silently drop compile lines during test run.
        continue;
      }
      kept.push(line);
    }
    const notes: string[] = [];
    _maybe_note(notes, pass_count, `collapsed ${pass_count} passing Swift test cases`);
    Filter._emit_notes(kept, notes);
    return Filter._finalize(kept);
  }
}

// ===========================================================================
// Xcode regexes (Python ~14623-14648).
// ===========================================================================

/** xcodebuild section banner: "=== BUILD TARGET Foo OF PROJECT Bar WITH CONFIGURATION Debug ===". */
const _XCODE_SECTION_RE: RegExp = /^=== .+ ===$/;
/** xcodebuild build-phase compilation lines (the most voluminous output). */
const _XCODE_COMPILE_RE: RegExp =
  /^\s*(CompileSwiftSources|CompileSwift|CompileC|CpHeader|ProcessInfoPlistFile|CopySwiftLibs|GenerateDSYMFile|Ld\s|CodeSign\s|Touch\s|PhaseScriptExecution\s|MergeSwiftModule\s|CompileAssetCatalog\s|RegisterWithLaunchServices\s|Validate\s|CreateBuildDirectory\s)\s*/;
/** xcodebuild final status banner. */
const _XCODE_STATUS_RE: RegExp =
  /^\*\*\s*BUILD (SUCCEEDED|FAILED)\s*\*\*|^\*\*\s*TEST (SUCCEEDED|FAILED)\s*\*\*|^\*\*\s*RUN (SUCCEEDED|FAILED)\s*\*\*/;
/** xcodebuild warning/error diagnostics (file:line:col: warning/error). */
const _XCODE_DIAG_RE: RegExp = /^.+:\d+:\d+:\s+(warning|error):\s/;
/** xcodebuild sub-task lines with a leading timestamp/progress number. */
const _XCODE_TASK_BODY_RE: RegExp = /^\s{4,}/;

// ===========================================================================
// XcodeFilter
// ===========================================================================

export class XcodeFilter extends Filter {
  override name = "xcode";
  override binaries: ReadonlySet<string> = new Set(["xcodebuild"]);

  override compress(stdout: string, stderr: string, _exit_code: number, _argv: string[]): string {
    const merged = this._combine_output(stdout, stderr);
    const lines = merged.split("\n");
    const kept: string[] = [];
    let compile_count = 0;
    for (const line of lines) {
      // Always keep section headers, status banners, and diagnostics.
      if (
        _reMatch(_XCODE_SECTION_RE, line) ||
        _reMatch(_XCODE_STATUS_RE, line) ||
        _reMatch(_XCODE_DIAG_RE, line)
      ) {
        kept.push(line);
        continue;
      }
      // Collapse verbose build-phase task lines.
      if (_reMatch(_XCODE_COMPILE_RE, line)) {
        compile_count += 1;
        continue;
      }
      // Deeply indented task-body lines (sub-output of a build phase):
      // drop when the parent phase is already collapsed.
      if (_reMatch(_XCODE_TASK_BODY_RE, line)) {
        compile_count += 1;
        continue;
      }
      kept.push(line);
    }
    const notes: string[] = [];
    _maybe_note(notes, compile_count, `collapsed ${compile_count} xcodebuild build-phase lines`);
    Filter._emit_notes(kept, notes);
    return Filter._finalize(kept);
  }
}

// ===========================================================================
// SwiftLint regexes (Python ~15194-15208).
// ===========================================================================

/**
 * SwiftLint violation line: "/path/to/File.swift:10:1: warning: ..." or compact
 * format "File.swift:10: warning: ...".
 */
const _SWIFTLINT_VIOLATION_RE: RegExp =
  /^(.+\.swift):(\d+)(?::\d+)?: (warning|error|serious): (.+?) \(([a-z_]+)\)\s*$/i;
/** SwiftLint progress/info lines. */
const _SWIFTLINT_PROGRESS_RE: RegExp =
  /^(Linting Swift files|Loading configuration|Linting '|Done linting!|Resolved \d|warning: .+ is deprecated|Ignoring '.+' in '|^\s*$)/i;
/**
 * SwiftLint summary line: "Done linting! The lint checker found N violations, M
 * serious in K files.".
 */
const _SWIFTLINT_SUMMARY_RE: RegExp = /^Done linting!/i;

// ===========================================================================
// SwiftLintFilter
// ===========================================================================

export class SwiftLintFilter extends Filter {
  override name = "swiftlint";
  override binaries: ReadonlySet<string> = new Set(["swiftlint"]);

  override compress(stdout: string, stderr: string, _exit_code: number, _argv: string[]): string {
    const merged = this._combine_output(stdout, stderr);
    const lines = merged.split("\n");
    const kept: string[] = [];
    let dropped_progress = 0;
    // rule_id -> count of warning violations seen so far
    const warning_rule_counts = new Map<string, number>();
    let summary_line = "";

    for (const line of lines) {
      // Always keep the summary line (set aside, emit last).
      if (_reMatch(_SWIFTLINT_SUMMARY_RE, line)) {
        summary_line = line;
        continue;
      }
      // Progress lines: drop
      if (_reMatch(_SWIFTLINT_PROGRESS_RE, line)) {
        dropped_progress += 1;
        continue;
      }
      const m = _reMatchObj(_SWIFTLINT_VIOLATION_RE, line);
      if (m) {
        const severity = m[3]!.toLowerCase();
        const rule_id = m[5]!.toLowerCase();
        if (severity === "error" || severity === "serious") {
          kept.push(line);
        } else {
          // warning: keep first 3 per rule
          warning_rule_counts.set(rule_id, (warning_rule_counts.get(rule_id) ?? 0) + 1);
          if (warning_rule_counts.get(rule_id)! <= 3) {
            kept.push(line);
          }
        }
        continue;
      }
      kept.push(line);
    }

    // Emit per-rule collapse notes before the summary.
    for (const rule_id of [...warning_rule_counts.keys()].sort()) {
      const count = warning_rule_counts.get(rule_id)!;
      if (count > 3) {
        kept.push(`[token-goat: +${count - 3} more ${rule_id} warning(s) elided]`);
      }
    }

    if (summary_line) {
      kept.push(summary_line);
    }

    const notes: string[] = [];
    _maybe_note(notes, dropped_progress, `dropped ${dropped_progress} progress/info lines`);
    Filter._emit_notes(kept, notes);
    return Filter._finalize(kept);
  }
}
