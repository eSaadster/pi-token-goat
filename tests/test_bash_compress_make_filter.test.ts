/**
 * Tests for MakeFilter compression in bash_compress.py.
 *
 * Covers compiler-echo suppression (direct compress), error/warning
 * preservation, star-error markers, and short-passthrough.
 *
 * Compiler-echo tests call MakeFilter.compress() directly because that path
 * is exercised via the pre-hook command-wrap pipeline. Star-error and hook
 * tests verify hook-pipeline behavior for compiler output.
 *
 * 1:1 port of tests/test_bash_compress_make_filter.py. Every Python
 * `def test_*` maps to a vitest `it()` with the SAME name and assertion
 * polarity; the Python test classes map to `describe()` blocks of the same name.
 *
 * Test-seam mapping (Python -> TS):
 *  - `from token_goat.bash_compress import MakeFilter`
 *      -> import MakeFilter from the barrel "../src/token_goat/bash_compress.js".
 *  - The module-level `_FILTER = MakeFilter()` singleton + `_compress(stdout, cmd)`
 *    helper run `_FILTER.compress(stdout, "", 0, [cmd])`; ported to the same
 *    module-level singleton + helper.
 *  - `_run_hook(...)` drives `token_goat.hooks_read.post_bash(...)`. That module
 *    is NOT yet ported to TS (no hooks_read on disk), so every test that calls
 *    `_run_hook` is deferred (it.skip) and counted; the `_compress`-based tests
 *    port directly.
 *
 * Fixtures here are pure ASCII, so substring `in`/`not in` checks map directly
 * to `String.includes` without Buffer arithmetic.
 */
import { describe, expect, it } from "vitest";

import { MakeFilter } from "../src/token_goat/bash_compress.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

// Compression only fires in the hook pipeline once stdout reaches this many lines.
const _MIN_LINES = 40;

const _FILTER = new MakeFilter();

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function _compress(stdout: string, cmd = "make"): string {
  // Run MakeFilter.compress() directly with minimal argv.
  return _FILTER.compress(stdout, "", 0, [cmd]);
}

// ---------------------------------------------------------------------------
// Compiler-echo suppression (MakeFilter.compress directly)
// ---------------------------------------------------------------------------

describe("TestMakeFilterCompilerEchoes", () => {
  function _pad_echoes(...echo_lines: string[]): string {
    // 40 progress lines + echo lines so compress has content to work with.
    const progress: string[] = [];
    for (let i = 0; i < 40; i++) {
      progress.push(`[${String(i + 1).padStart(3, " ")}%] Building CXX object src/f${i}.cpp.o`);
    }
    return progress.concat(echo_lines).join("\n") + "\n";
  }

  it("test_cc_invocation_suppressed", () => {
    // Lines starting with 'cc ' are stripped by MakeFilter.
    const out = _compress(_pad_echoes("cc -O2 -o src/foo.o src/foo.c"));
    expect(out.includes("cc -O2")).toBe(false);
  });

  it("test_gcc_invocation_suppressed", () => {
    // Lines starting with 'gcc ' are stripped by MakeFilter.
    const out = _compress(_pad_echoes("gcc -Wall -c src/bar.c -o src/bar.o"));
    expect(out.includes("gcc -Wall")).toBe(false);
  });

  it("test_clang_invocation_suppressed", () => {
    // Lines starting with 'clang ' are stripped by MakeFilter.
    const out = _compress(_pad_echoes("clang -std=c11 -c src/baz.c -o src/baz.o"));
    expect(out.includes("clang -std=c11")).toBe(false);
  });

  it("test_gpp_invocation_suppressed", () => {
    // Lines starting with 'g++ ' are stripped by MakeFilter.
    const out = _compress(_pad_echoes("g++ -std=c++17 -c src/main.cpp -o src/main.o"));
    expect(out.includes("g++ -std=c++17")).toBe(false);
  });

  it("test_compiler_echo_with_error_kept", () => {
    // A compiler-echo line containing 'error' survives — error guard fires first.
    const out = _compress(_pad_echoes("cc -o out/bad.o src/bad.c: error: no such file"));
    expect(out.includes("error: no such file")).toBe(true);
  });

  it("test_echo_suppression_noted", () => {
    // Suppression note must mention compiler-invocation echoes.
    const out = _compress(_pad_echoes("gcc -c src/a.c -o src/a.o"));
    expect(out.includes("compiler-invocation")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Error / warning preservation and star-error markers
// ---------------------------------------------------------------------------

describe("TestMakeFilterErrorPreservation", () => {
  // PORT: deferred — hooks_read.post_bash not yet ported to TS.
  it.skip("test_star_error_marker_kept_via_hook", () => {
    // make[N]: *** [...] Error lines are not suppressed by the hook pipeline.
  });

  it("test_star_error_marker_kept_direct", () => {
    // MakeFilter.compress keeps *** Error lines even in recursive noise.
    const progress: string[] = [];
    for (let i = 0; i < 40; i++) {
      progress.push(`[${String(i + 1).padStart(3, " ")}%] Building CXX object src/f${i}.cpp.o`);
    }
    const lines = progress.concat([
      "make[1]: Entering directory '/tmp/build'",
      "make[1]: *** [Makefile] Error 2",
    ]);
    const out = _compress(lines.join("\n") + "\n");
    expect(out.includes("*** [Makefile] Error 2")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Short-output passthrough
// ---------------------------------------------------------------------------

describe("TestMakeFilterPassthrough", () => {
  // PORT: deferred — hooks_read.post_bash not yet ported to TS.
  it.skip("test_short_output_not_compressed", () => {
    // Output with fewer than _MIN_LINES lines passes through the hook unchanged.
    void _MIN_LINES;
  });

  // PORT: deferred — hooks_read.post_bash not yet ported to TS.
  it.skip("test_large_build_only_errors_survive", () => {
    // In a large mixed build, only error/warning diagnostics survive the hook.
  });

  // PORT: deferred — hooks_read.post_bash not yet ported to TS.
  it.skip("test_compiler_echo_mixed_with_progress_via_hook", () => {
    // Compiler echoes in large make output survive the hook
    // (only direct compress suppresses them).
  });
});
