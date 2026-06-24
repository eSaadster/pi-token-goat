/**
 * Tests for MakeFilter compression passes (iteration-117 enhancements).
 *
 * Covers all four compression passes:
 * 1. Command-echo suppression — cc/gcc/g++/clang/clang++/ld/ar/as/nasm/ninja
 * 2. Directory noise — make[N]: Entering/Leaving directory
 * 3. Nothing-to-do — make[N]: Nothing to be done for '...'
 * 4. Preserve all lines containing Error, error:, warning:, or undefined reference
 *
 * 1:1 port of tests/test_bash_compress_make_enhanced.py. Every Python
 * `def test_*` maps to a vitest `it()` with the SAME name and assertion
 * polarity; the Python test classes map to `describe()` blocks of the same name.
 * `pytest.mark.parametrize("cmd", [...])` -> `it.each([...])`.
 *
 * Test-seam mapping (Python -> TS):
 *  - `from token_goat.bash_compress import MakeFilter`
 *      -> import MakeFilter from the barrel "../src/token_goat/bash_compress.js".
 *  - The module-level `_compress(inp, argv=None)` helper runs
 *    `MakeFilter().compress(inp, "", 0, argv or ["make", "all"])`.
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
// 1. Command-echo suppression
// ---------------------------------------------------------------------------

describe("TestCommandEchoSuppression", () => {
  it.each([
    "cc -O2 foo.c -o foo",
    "gcc -O2 foo.c -o foo",
    "g++ -O2 foo.cpp -o foo",
    "clang -O2 foo.c -o foo",
    "clang++ -O2 foo.cpp -o foo",
    "ld -o foo foo.o bar.o",
    "ar rcs libfoo.a foo.o",
    "as -o foo.o foo.s",
    "nasm -f elf64 foo.asm -o foo.o",
    "ninja -j4 foo.o",
  ])("test_compiler_suppressed_clean_build[%s]", (cmd: string) => {
    // Clean build: no error follows, so compiler line must be dropped
    const inp = [cmd, "Build complete."].join("\n");
    const out = _compress(inp);
    expect(out.includes(cmd)).toBe(false);
  });

  it("test_cc_kept_when_next_line_is_error", () => {
    const inp = "cc -O2 foo.c -o foo\nfoo.c:1:1: error: undeclared identifier 'x'";
    const out = _compress(inp);
    expect(out.includes("cc -O2 foo.c -o foo")).toBe(true);
  });

  it("test_gcc_kept_when_next_line_is_error", () => {
    const inp = "gcc -O2 foo.c -o foo\nfoo.c:10:5: error: 'bar' undeclared";
    const out = _compress(inp);
    expect(out.includes("gcc -O2 foo.c -o foo")).toBe(true);
  });

  it("test_gxx_kept_when_next_line_is_error", () => {
    const inp = "g++ -std=c++17 foo.cpp -o foo\nfoo.cpp:3:1: error: expected ';'";
    const out = _compress(inp);
    expect(out.includes("g++ -std=c++17 foo.cpp -o foo")).toBe(true);
  });

  it("test_clang_kept_when_next_line_is_error", () => {
    const inp = "clang -O2 foo.c -o foo\nfoo.c:7:3: error: expected expression";
    const out = _compress(inp);
    expect(out.includes("clang -O2 foo.c -o foo")).toBe(true);
  });

  it("test_clang_plus_plus_kept_when_next_line_is_error", () => {
    const inp = "clang++ -std=c++17 foo.cpp -o foo\nfoo.cpp:5:3: error: use of undeclared identifier 'x'";
    const out = _compress(inp);
    expect(out.includes("clang++ -std=c++17 foo.cpp -o foo")).toBe(true);
  });

  it("test_ld_kept_when_next_line_is_error", () => {
    const inp = "ld -o foo foo.o bar.o\nld: foo.o: undefined reference to `main'";
    const out = _compress(inp);
    expect(out.includes("ld -o foo foo.o bar.o")).toBe(true);
  });

  it("test_ar_suppressed_in_clean_build", () => {
    // Multiple ar lines with no errors — all dropped
    const inp = [
      "ar rcs libfoo.a alpha.o beta.o",
      "ar rcs libbar.a gamma.o",
      "Build finished.",
    ].join("\n");
    const out = _compress(inp);
    expect(out.includes("ar rcs libfoo.a")).toBe(false);
    expect(out.includes("ar rcs libbar.a")).toBe(false);
    expect(out.includes("Build finished.")).toBe(true);
  });

  it("test_as_kept_when_next_line_is_error", () => {
    const inp = "as -o foo.o foo.s\nfoo.s:10: Error: unknown mnemonic 'movx'";
    const out = _compress(inp);
    expect(out.includes("as -o foo.o foo.s")).toBe(true);
  });

  it("test_nasm_suppressed_clean", () => {
    const inp = "nasm -f elf64 foo.asm -o foo.o\nfoo.o created.";
    const out = _compress(inp);
    expect(out.includes("nasm -f elf64 foo.asm")).toBe(false);
  });

  it("test_nasm_kept_when_next_line_is_error", () => {
    const inp = "nasm -f elf64 foo.asm -o foo.o\nfoo.asm:3: error: invalid combination of opcode and operands";
    const out = _compress(inp);
    expect(out.includes("nasm -f elf64 foo.asm")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 2. Directory noise suppression
// ---------------------------------------------------------------------------

describe("TestDirectoryNoise", () => {
  it("test_entering_directory_dropped", () => {
    const inp = "make[2]: Entering directory '/home/user/project/src'";
    const out = _compress(inp);
    expect(out.includes("Entering directory")).toBe(false);
  });

  it("test_leaving_directory_dropped", () => {
    const inp = "make[2]: Leaving directory '/home/user/project/src'";
    const out = _compress(inp);
    // Check the actual make line is gone (the note mentions "Leaving directory" too)
    expect(out.includes("make[2]: Leaving directory")).toBe(false);
  });

  it("test_make_depth_1_entering_dropped", () => {
    const inp = "make[1]: Entering directory '/src'";
    const out = _compress(inp);
    expect(out.includes("Entering directory")).toBe(false);
  });

  it("test_deep_nesting_entering_dropped", () => {
    const inp = "make[5]: Entering directory '/a/b/c/d/e'";
    const out = _compress(inp);
    expect(out.includes("Entering directory")).toBe(false);
  });

  it("test_directory_lines_dropped_but_diagnostics_kept", () => {
    // Real build output between directory lines must survive
    const inp = [
      "make[1]: Entering directory '/src'",
      "foo.c:3:1: warning: unused variable 'x'",
      "make[1]: Leaving directory '/src'",
    ].join("\n");
    const out = _compress(inp);
    expect(out.includes("warning: unused variable 'x'")).toBe(true);
    expect(out.includes("make[1]: Entering directory")).toBe(false);
    expect(out.includes("make[1]: Leaving directory")).toBe(false);
  });

  it("test_entering_suppression_note_emitted", () => {
    // Suppression of directory lines emits a token-goat note
    const inp = [
      "make[1]: Entering directory '/src'",
      "make[1]: Leaving directory '/src'",
    ].join("\n");
    const out = _compress(inp);
    expect(out.includes("token-goat")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 3. Nothing-to-do suppression
// ---------------------------------------------------------------------------

describe("TestNothingToDo", () => {
  it("test_nothing_to_do_for_all_dropped", () => {
    const inp = "make[1]: Nothing to be done for 'all'.";
    const out = _compress(inp);
    expect(out.includes("Nothing to be done")).toBe(false);
  });

  it("test_nothing_to_do_for_named_target", () => {
    const inp = "make[3]: Nothing to be done for 'install'.";
    const out = _compress(inp);
    expect(out.includes("Nothing to be done")).toBe(false);
  });

  it("test_nothing_to_do_depth_0_dropped", () => {
    const inp = "make[0]: Nothing to be done for 'test'.";
    const out = _compress(inp);
    expect(out.includes("Nothing to be done")).toBe(false);
  });

  it("test_nothing_to_do_suppression_note_emitted", () => {
    const inp = "make[1]: Nothing to be done for 'all'.";
    const out = _compress(inp);
    expect(out.includes("token-goat")).toBe(true);
  });

  it("test_nothing_to_do_suppressed_but_error_line_kept", () => {
    // A separate error line in the same output must survive
    const inp = [
      "make[1]: Nothing to be done for 'all'.",
      "Makefile:12: *** missing separator.  Stop.",
    ].join("\n");
    const out = _compress(inp);
    expect(out.includes("missing separator")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 4. Preserve: Error, error:, warning:, undefined reference
// ---------------------------------------------------------------------------

describe("TestPreserveSignals", () => {
  it("test_error_colon_lowercase_kept", () => {
    // error: (lowercase, with colon) — diagnostic from compiler
    const inp = "foo.c:1:1: error: implicit declaration of function 'bar'";
    const out = _compress(inp);
    expect(out.includes("error: implicit declaration")).toBe(true);
  });

  it("test_error_capital_no_colon_kept", () => {
    // Error (capital E, no colon) — make end-of-build summary
    const inp = "make[1]: *** [Makefile:20: foo] Error 2";
    const out = _compress(inp);
    expect(out.includes("Error 2")).toBe(true);
  });

  it("test_warning_colon_kept", () => {
    // warning: — compiler diagnostic
    const inp = "foo.c:5:3: warning: comparison between signed and unsigned";
    const out = _compress(inp);
    expect(out.includes("warning: comparison")).toBe(true);
  });

  it("test_undefined_reference_kept", () => {
    // undefined reference — linker diagnostic
    const inp = "foo.o: undefined reference to `main'";
    const out = _compress(inp);
    expect(out.includes("undefined reference")).toBe(true);
  });

  it("test_compiler_ext_line_with_bare_Error_not_dropped", () => {
    // clang++ invocation that itself embeds the word "Error" (no colon)
    // must NOT be dropped even without a following error line.
    // This exercises the _MAKE_PRESERVE_SIGNAL_RE \bError\b branch.
    const inp = "clang++ -o app Error.o helper.o";
    const out = _compress(inp);
    expect(out.includes("clang++ -o app Error.o helper.o")).toBe(true);
  });

  it("test_ld_line_with_bare_Error_not_dropped", () => {
    // ld invocation embedding "Error" as a word in a filename
    const inp = "ld -o app main.o Error.o -lfoo";
    const out = _compress(inp);
    expect(out.includes("ld -o app main.o Error.o")).toBe(true);
  });

  it("test_warning_in_gcc_line_not_dropped", () => {
    // A gcc invocation that itself contains "warning:" must be kept
    const inp = "gcc: warning: foo.c: linker input file unused because linking not done";
    const out = _compress(inp);
    expect(out.includes("warning: foo.c")).toBe(true);
  });

  it("test_undefined_reference_in_ld_line_not_dropped", () => {
    // ld output line with "undefined reference" must survive
    const inp = "libfoo.a(bar.o): undefined reference to `init'";
    const out = _compress(inp);
    expect(out.includes("undefined reference")).toBe(true);
  });

  it("test_error_colon_case_insensitive_kept", () => {
    // ERROR: (all-caps, with colon) — must also be preserved
    const inp = "ld: ERROR: cannot find -lstdc++";
    const out = _compress(inp);
    expect(out.includes("ERROR: cannot find")).toBe(true);
  });
});
