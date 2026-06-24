/**
 * bash_compress CARGO FILTER — TypeScript port of the CargoFilter Filter subclass
 * from src/token_goat/bash_compress.py (Python lines 3242-3471, plus the shared
 * `_CARGO_*` regexes at ~2986-3022 that CargoFilter consumes).
 *
 * CargoFilter compresses `cargo build / check / test / clippy / run / bench`
 * output: it drops the per-crate `Compiling foo v0.1.0` progress, the
 * `Downloading`/`Fetching`/`Updating` lines, and passing `test ... ok` lines,
 * while keeping every `warning:`/`error:` block, every `FAILED` line, the
 * `Finished` summary, and bench result lines verbatim.
 *
 * The filter subclasses the concrete Filter base from ./framework.js and overrides
 * compress() (NOT _compress_body) with per-subcommand structural compression. It
 * is appended to the FILTERS registry (and the public surface) by the barrel one
 * level up — this module does NOT touch the barrel.
 *
 * ---------------------------------------------------------------------------
 * Parity notes (Python -> TS)
 * ---------------------------------------------------------------------------
 *  - Python identifiers preserved EXACTLY: the PascalCase class name (CargoFilter)
 *    and the snake_case module-private regex names (_CARGO_COMPILING_RE,
 *    _CARGO_PROGRESS_RE, _CARGO_CHECKING_RE, _CARGO_FINISHED_RE, _CARGO_TEST_PASS_RE,
 *    _CARGO_TEST_FAIL_RE, _CARGO_TEST_RESULT_RE, _CARGO_TEST_RUNNING_RE,
 *    _CARGO_ERROR_CODE_RE, _CARGO_BENCH_RESULT_RE, _CARGO_BENCH_RUNNING_RE,
 *    _CARGO_FINISHED_PREAMBLE_RE). Method names (_compress_build / _compress_test /
 *    _compress_clippy / _compress_bench) preserved.
 *  - re.compile(...) -> top-level RegExp compiled once at module load. None of the
 *    Python `_CARGO_*` patterns set IGNORECASE / MULTILINE; every one is used only
 *    with re.Pattern.match(line) (per-line, anchored at start). JS has no anchored
 *    match primitive, so _reMatch clones the pattern without g/y flags and checks
 *    m.index === 0, exactly as the shipped framework/test_runners modules do.
 *  - detect_from_command/matches: NOT overridden. CargoFilter sets `name = "cargo"`
 *    and `binaries = {"cargo"}` with NO `subcommands`, so it inherits the base
 *    Filter.detect_from_command -> matches() dispatch (binary stem "cargo", any
 *    subcommand). compress() itself branches on the first positional argument.
 *  - compress() OVERRIDES the base Filter.compress (CargoFilter does not use
 *    error_passthrough; it handles failures structurally), so the base
 *    error-passthrough guard never runs for cargo — matching Python, where
 *    CargoFilter defines `compress` directly.
 *  - _combine_output is an INSTANCE method on Filter; _finalize / _emit_notes are
 *    STATIC methods on Filter (called as Filter._finalize / Filter._emit_notes,
 *    mirroring test_runners.ts). _positional_args / _maybe_note are module-level
 *    framework exports, imported here — not re-implemented.
 *  - Python list slicing kept[_ci + 1:] / compiled[:2] / compiled[-2:] -> Array
 *    .slice with the noUncheckedIndexedAccess-safe `!` on confirmed-present reads.
 *    Python f-strings -> template literals; the count sentinels reproduce the exact
 *    strings ("[compiling N crates…]" with U+2026 HORIZONTAL ELLIPSIS, "[N tests
 *    passed]", the "collapsed N 'Compiling …' lines" marker, etc.) byte-for-byte.
 *  - Module-global mutable state: NONE. The `_CARGO_*` regexes are immutable for
 *    the process lifetime (compiled once), so there is nothing to wipe and no
 *    registerReset is wired here (mirrors test_runners.ts, which also registers
 *    nothing).
 *
 * NOTE on import depth: this file lives in the bash_compress/ SUBDIR; the framework
 * is a SIBLING (./framework.js). verbatimModuleSyntax is on -> nothing imported
 * here is type-only. noImplicitOverride is on -> every overridden member carries
 * `override`.
 */

import { Filter, _maybe_note, _positional_args } from "./framework.js";

// ===========================================================================
// Internal Python-builtin shims local to this module.
// ===========================================================================

/** Return a clone of re without the global/sticky flags (for one-shot .exec). */
function _nonGlobal(re: RegExp): RegExp {
  const flags = re.flags.replace(/[gy]/g, "");
  return new RegExp(re.source, flags);
}

/**
 * Python re.Pattern.match(line) — anchored at the START (NOT end-anchored). JS has
 * no anchored-match primitive; emulate via a non-global clone and an index===0
 * check.
 */
function _reMatch(re: RegExp, line: string): boolean {
  const r = _nonGlobal(re);
  const m = r.exec(line);
  return m !== null && m.index === 0;
}

/** Python str.strip() — strip leading and trailing whitespace. */
function _strip(s: string): string {
  return s.replace(/^\s+/u, "").replace(/\s+$/u, "");
}

/** Python str.rstrip() — strip trailing whitespace. */
function _rstrip(s: string): string {
  return s.replace(/\s+$/u, "");
}

// ===========================================================================
// Cargo regexes (Python ~2986-3022). Compiled once at module load.
// None set IGNORECASE/MULTILINE; all are consumed only via .match(line).
// ===========================================================================

// Python: re.compile(r"^\s*Compiling\s+\S+\s+v\S+")
const _CARGO_COMPILING_RE: RegExp = /^\s*Compiling\s+\S+\s+v\S+/;
// Python: re.compile(r"^\s*(Downloading|Downloaded|Fetching|Updating|Documenting|Building)\s+\S")
const _CARGO_PROGRESS_RE: RegExp =
  /^\s*(Downloading|Downloaded|Fetching|Updating|Documenting|Building)\s+\S/;
// Python: re.compile(r"^\s*Checking\s+\S+\s+v\S+")
const _CARGO_CHECKING_RE: RegExp = /^\s*Checking\s+\S+\s+v\S+/;
// Python: re.compile(r"^\s*Finished\s+(dev|release|test)")
const _CARGO_FINISHED_RE: RegExp = /^\s*Finished\s+(dev|release|test)/;
// Python: re.compile(r"^test\s+\S.*\s\.\.\.\s+ok\s*$")
const _CARGO_TEST_PASS_RE: RegExp = /^test\s+\S.*\s\.\.\.\s+ok\s*$/;
// Python: re.compile(r"^test\s+\S.*\s\.\.\.\s+FAILED\s*$")
const _CARGO_TEST_FAIL_RE: RegExp = /^test\s+\S.*\s\.\.\.\s+FAILED\s*$/;
// Python: re.compile(r"^test result:")
const _CARGO_TEST_RESULT_RE: RegExp = /^test result:/;
// Python: re.compile(r"^\s*Running\s+(?:unittests|tests/|target/)")
const _CARGO_TEST_RUNNING_RE: RegExp = /^\s*Running\s+(?:unittests|tests\/|target\/)/;
// Python: re.compile(r"^error\[E\d+\]")
const _CARGO_ERROR_CODE_RE: RegExp = /^error\[E\d+\]/;
// cargo bench result line: "test bench_foo ... bench: 1,234 ns/iter (+/- 56)"
// Python: re.compile(r"^test\s+\S+.*\s\.\.\.\s+bench:")
const _CARGO_BENCH_RESULT_RE: RegExp = /^test\s+\S+.*\s\.\.\.\s+bench:/;
// cargo bench "running N tests" section header
// Python: re.compile(r"^\s*running \d+ test")
const _CARGO_BENCH_RUNNING_RE: RegExp = /^\s*running \d+ test/;
// Pass C: Finished preamble lines suppressible when no failure follows
// Python: re.compile(r"^\s*Finished (?:dev|release|bench|custom)\s")
const _CARGO_FINISHED_PREAMBLE_RE: RegExp = /^\s*Finished (?:dev|release|bench|custom)\s/;

export {
  _CARGO_COMPILING_RE,
  _CARGO_PROGRESS_RE,
  _CARGO_CHECKING_RE,
  _CARGO_FINISHED_RE,
  _CARGO_TEST_PASS_RE,
  _CARGO_TEST_FAIL_RE,
  _CARGO_TEST_RESULT_RE,
  _CARGO_TEST_RUNNING_RE,
  _CARGO_ERROR_CODE_RE,
  _CARGO_BENCH_RESULT_RE,
  _CARGO_BENCH_RUNNING_RE,
  _CARGO_FINISHED_PREAMBLE_RE,
};

// ===========================================================================
// CargoFilter
// ===========================================================================

/**
 * Compress cargo build / check / test / clippy / run / bench output.
 *
 * Cargo emits a `Compiling foo v0.1.0` line per crate (often dozens), plus
 * optional `Downloading`, `Fetching`, `Updating` lines. These are noise unless
 * they fail.
 *
 * Compression model:
 *  - build / check: drop `Compiling` lines beyond a head + tail sample (keep first
 *    2 and last 2); drop `Downloading`/`Fetching`/`Updating` progress; keep every
 *    `warning:`/`error:` block and the `Finished` summary line.
 *  - test: drop passing `test foo ... ok` lines (count them); keep every `FAILED`
 *    line, failure details, and the final `test result:` summary.
 *  - clippy: suppress `Checking crate v...` progress lines; keep every
 *    `warning:`/`error:` diagnostic and the final summary.
 *  - bench: collapse the compiler progress via `_compress_build`; keep every
 *    benchmark result line (`test foo ... bench: N ns/iter`) verbatim; collapse the
 *    `Finished` line but drop redundant `running N tests` headers when there is
 *    only one bench harness section.
 *  - run: pass through — script output is load-bearing.
 */
export class CargoFilter extends Filter {
  override name = "cargo";
  override binaries: ReadonlySet<string> = new Set(["cargo"]);

  override compress(stdout: string, stderr: string, _exit_code: number, argv: string[]): string {
    const positionals = _positional_args(argv.slice(1));
    const subcommand = positionals.length > 0 ? positionals[0]! : "";

    if (subcommand === "test") {
      return this._compress_test(stdout, stderr);
    }
    if (subcommand === "clippy") {
      return this._compress_clippy(stdout, stderr);
    }
    if (subcommand === "bench") {
      return this._compress_bench(stdout, stderr);
    }
    if (subcommand === "run") {
      return this._combine_output(stdout, stderr);
    }
    return this._compress_build(stdout, stderr);
  }

  _compress_build(stdout: string, stderr: string, opts?: { suppress_finished?: boolean }): string {
    const suppress_finished = opts?.suppress_finished ?? true;
    // Note: reversed order — cargo's useful diagnostics come on stderr; stdout
    // typically contains only build script output that is secondary context.
    const merged = this._combine_output(stderr, stdout);
    const lines = merged.split("\n");
    const compiled: string[] = [];
    let kept: string[] = [];
    let dropped_progress = 0;
    for (const line of lines) {
      if (_reMatch(_CARGO_COMPILING_RE, line)) {
        compiled.push(line);
        continue;
      }
      if (_reMatch(_CARGO_CHECKING_RE, line) || _reMatch(_CARGO_PROGRESS_RE, line)) {
        dropped_progress += 1;
        continue;
      }
      kept.push(line);
    }
    if (compiled.length > 0) {
      if (compiled.length < 3) {
        kept = [...compiled, ...kept];
      } else {
        // Pass A: ≥3 Compiling lines → single count sentinel
        kept = [`[compiling ${compiled.length} crates…]`, ...kept];
      }
    }
    // Pass C: suppress Finished preambles on clean builds (only when Pass A fired
    // and the caller wants it — not for test/bench subcommands that need it as context).
    if (suppress_finished && compiled.length >= 3) {
      const _cc_kept: string[] = [];
      for (let _ci = 0; _ci < kept.length; _ci += 1) {
        const _cl = kept[_ci]!;
        if (_reMatch(_CARGO_FINISHED_PREAMBLE_RE, _cl)) {
          let _cn = "";
          for (let _j = _ci + 1; _j < kept.length; _j += 1) {
            if (_strip(kept[_j]!) !== "") {
              _cn = kept[_j]!;
              break;
            }
          }
          if (_cn.includes("FAILED") || _cn.includes("error[")) {
            _cc_kept.push(_cl);
          }
        } else {
          _cc_kept.push(_cl);
        }
      }
      kept = _cc_kept;
    }
    if (dropped_progress) {
      kept.push(`[token-goat: dropped ${dropped_progress} cargo progress lines]`);
    }
    return Filter._finalize(kept);
  }

  _compress_test(stdout: string, stderr: string): string {
    // cargo test: stderr has compiler progress, stdout has test output.
    // Merge compiler noise first, then test results.
    let build_part =
      _strip(stderr) !== "" ? this._compress_build("", stderr, { suppress_finished: false }) : "";
    const test_lines = stdout.split("\n");
    let kept: string[] = [];
    let pass_count = 0;
    const fail_names: string[] = [];
    for (const line of test_lines) {
      if (_reMatch(_CARGO_TEST_PASS_RE, line)) {
        pass_count += 1;
        continue;
      }
      if (_reMatch(_CARGO_TEST_FAIL_RE, line)) {
        fail_names.push(line);
        kept.push(line);
        continue;
      }
      if (_reMatch(_CARGO_TEST_RUNNING_RE, line)) {
        // "Running unittests/tests/..." — keep as section marker.
        kept.push(line);
        continue;
      }
      kept.push(line);
    }
    // Pass B: inject per-binary pass count sentinels at binary boundaries
    const _tb_pass: number[] = [];
    let _tb_cur = 0;
    let _tb_seen = false;
    for (const _tl of test_lines) {
      if (_reMatch(_CARGO_TEST_PASS_RE, _tl)) {
        _tb_cur += 1;
      } else if (_reMatch(_CARGO_TEST_RUNNING_RE, _tl)) {
        if (_tb_seen) {
          _tb_pass.push(_tb_cur);
        }
        _tb_cur = 0;
        _tb_seen = true;
      }
    }
    _tb_pass.push(_tb_cur);
    if (_tb_pass.length > 0) {
      let _tb_i = 0;
      let _tb_first = false;
      const _tb_new: string[] = [];
      for (const _tl2 of kept) {
        if (_reMatch(_CARGO_TEST_RUNNING_RE, _tl2)) {
          if (_tb_first && _tb_i < _tb_pass.length && _tb_pass[_tb_i]) {
            _tb_new.push(`[${_tb_pass[_tb_i]} tests passed]`);
            _tb_i += 1;
          }
          _tb_first = true;
        }
        _tb_new.push(_tl2);
      }
      if (_tb_i < _tb_pass.length && _tb_pass[_tb_i]) {
        _tb_new.push(`[${_tb_pass[_tb_i]} tests passed]`);
      }
      kept = _tb_new;
    }
    // Strip "Running unittests/tests" banner from build preamble on a clean pass.
    if (fail_names.length === 0 && build_part) {
      build_part = build_part
        .split("\n")
        .filter((ln) => !_reMatch(_CARGO_TEST_RUNNING_RE, ln))
        .join("\n");
    }
    const notes: string[] = [];
    _maybe_note(notes, pass_count, `collapsed ${pass_count} passing test lines`);
    Filter._emit_notes(kept, notes);
    const test_out = Filter._finalize(kept);
    if (_strip(build_part) !== "" && _strip(test_out) !== "") {
      return _rstrip(build_part) + "\n---\n" + test_out;
    }
    return _strip(build_part) !== "" ? build_part : test_out;
  }

  _compress_clippy(stdout: string, stderr: string): string {
    // Note: reversed order — same rationale as _compress_build above.
    const merged = this._combine_output(stderr, stdout);
    const lines = merged.split("\n");
    const compiled: string[] = [];
    let kept: string[] = [];
    let dropped_checking = 0;
    let dropped_progress = 0;
    for (const line of lines) {
      if (_reMatch(_CARGO_COMPILING_RE, line)) {
        compiled.push(line);
        continue;
      }
      if (_reMatch(_CARGO_CHECKING_RE, line)) {
        dropped_checking += 1;
        continue;
      }
      if (_reMatch(_CARGO_PROGRESS_RE, line)) {
        dropped_progress += 1;
        continue;
      }
      kept.push(line);
    }
    if (compiled.length > 0) {
      if (compiled.length <= 4) {
        kept = [...compiled, ...kept];
      } else {
        kept = [
          ...compiled.slice(0, 2),
          `[token-goat: collapsed ${compiled.length - 4} 'Compiling …' lines]`,
          ...compiled.slice(compiled.length - 2),
          ...kept,
        ];
      }
    }
    const notes: string[] = [];
    _maybe_note(notes, dropped_checking, `dropped ${dropped_checking} 'Checking …' lines`);
    _maybe_note(notes, dropped_progress, `dropped ${dropped_progress} cargo progress lines`);
    Filter._emit_notes(kept, notes);
    return Filter._finalize(kept);
  }

  _compress_bench(stdout: string, stderr: string): string {
    // cargo bench: collapse compiler progress; keep all bench result lines.
    //
    // Bench output shape (stdout):
    //   running 3 tests
    //   test bench_foo ... bench:       1,234 ns/iter (+/- 56)
    //   test bench_bar ... bench:       5,678 ns/iter (+/- 89)
    //   test bench_baz ... bench:         123 ns/iter (+/-  4)
    //
    //   test result: ok. 0 passed; 0 failed; 0 ignored; 3 measured; 0 filtered
    //
    // The compiler emits noise to stderr (same as build). This method:
    //  - Strips compiler progress (Compiling, Downloading, Checking) via the
    //    existing _compress_build helper.
    //  - Passes all "test ... bench: N ns/iter" result lines through verbatim —
    //    they are the signal.
    //  - When there is only one "running N tests" section, collapses the header
    //    since the count is already implicit in the result lines.
    //  - Keeps "test result:" summary lines verbatim.

    // Build phase on stderr — collapse compiler noise, keep errors/warnings.
    const build_part =
      _strip(stderr) !== "" ? this._compress_build("", stderr, { suppress_finished: false }) : "";

    const bench_lines = stdout.split("\n");
    let kept: string[] = [];
    const running_headers: string[] = [];

    for (const line of bench_lines) {
      if (_reMatch(_CARGO_BENCH_RUNNING_RE, line)) {
        running_headers.push(line);
        // Defer adding until we know if there is more than one section.
        continue;
      }
      kept.push(line);
    }

    // Only one "running N tests" section → drop it (redundant with result lines).
    // More than one → keep all (multiple bench harnesses, e.g. criterion suites).
    if (running_headers.length > 1) {
      // Re-insert headers before their associated bench lines.
      // Because we stripped them, just prepend the list.
      kept = [...running_headers, ...kept];
    }

    const notes: string[] = [];
    if (running_headers.length === 1) {
      notes.push("dropped 1 'running N tests' header (single bench suite)");
    }
    const bench_out_lines = [...kept];
    Filter._emit_notes(bench_out_lines, notes);
    const bench_out = Filter._finalize(bench_out_lines);

    if (_strip(build_part) !== "" && _strip(bench_out) !== "") {
      return _rstrip(build_part) + "\n---\n" + bench_out;
    }
    return _strip(build_part) !== "" ? build_part : bench_out;
  }
}
