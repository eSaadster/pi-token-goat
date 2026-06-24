/**
 * Tests for MakeFilter iteration-105 enhancements.
 *
 * 1:1 port of tests/test_bash_compress_make_enhancements.py. Every Python
 * `def test_*` maps to a vitest `it()` with the SAME name and assertion
 * polarity; the Python test classes map to `describe()` blocks of the same name.
 *
 * Test-seam mapping (Python -> TS):
 *  - `from token_goat.bash_compress import MakeFilter`
 *      -> import MakeFilter from the barrel "../src/token_goat/bash_compress.js"
 *        (re-exported from bash_compress/jvm.ts).
 *  - The module-level `_compress(inp, argv=None)` helper runs
 *    `MakeFilter().compress(inp, "", 0, argv or ["make", "all"])`; ported to the
 *    same local helper constructing a fresh MakeFilter each call.
 *
 * Fixtures here are pure ASCII, so substring `in`/`not in` checks map directly
 * to `String.includes` without Buffer arithmetic.
 */
import { describe, expect, it } from "vitest";

import { MakeFilter } from "../src/token_goat/bash_compress.js";

function _compress(inp: string, argv: string[] | null = null): string {
  return new MakeFilter().compress(inp, "", 0, argv ?? ["make", "all"]);
}

// ---------------------------------------------------------------------------
// Compiler echo suppression
// ---------------------------------------------------------------------------

describe("TestMakeCompilerEchoSuppression", () => {
  it("test_gcc_command_suppressed", () => {
    // Plain compiler invocation with no following error is dropped
    const inp = [
      "gcc -O2 foo.c -o foo",
      "echo Build done",
      "Build done",
    ].join("\n");
    const out = _compress(inp);
    expect(out.includes("gcc -O2 foo.c -o foo")).toBe(false);
  });

  it("test_gcc_kept_before_error", () => {
    // Compiler line followed by an error diagnostic must be kept
    const inp = [
      "gcc -O2 foo.c -o foo",
      "foo.c:10:5: error: undeclared identifier",
    ].join("\n");
    const out = _compress(inp);
    expect(out.includes("gcc -O2 foo.c -o foo")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Directory noise suppression
// ---------------------------------------------------------------------------

describe("TestMakeDirectoryNoise", () => {
  it("test_entering_directory_suppressed", () => {
    const inp = "make[2]: Entering directory '/src'";
    const out = _compress(inp);
    expect(out.includes("Entering directory")).toBe(false);
  });

  it("test_leaving_directory_suppressed", () => {
    const inp = "make[2]: Leaving directory '/src'";
    const out = _compress(inp);
    // Note line contains "Leaving directory"; assert the actual make line is gone
    expect(out.split("\n").some((line) => line.includes("Leaving directory '/src'"))).toBe(false);
  });

  it("test_nothing_to_do_suppressed", () => {
    const inp = "make[1]: Nothing to be done for 'all'.";
    const out = _compress(inp);
    expect(out.includes("Nothing to be done")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Error and warning lines always kept
// ---------------------------------------------------------------------------

describe("TestMakeDiagnosticsKept", () => {
  it("test_error_line_always_kept", () => {
    const inp = "foo.c:10:5: error: undeclared identifier 'foo'";
    const out = _compress(inp);
    expect(out.includes("error: undeclared identifier 'foo'")).toBe(true);
  });

  it("test_warning_line_always_kept", () => {
    const inp = "foo.c:3:1: warning: implicit declaration of function 'bar'";
    const out = _compress(inp);
    expect(out.includes("warning: implicit declaration")).toBe(true);
  });
});
