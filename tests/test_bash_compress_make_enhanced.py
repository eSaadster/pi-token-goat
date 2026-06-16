"""Tests for MakeFilter compression passes (iteration-117 enhancements).

Covers all four compression passes:
1. Command-echo suppression — cc/gcc/g++/clang/clang++/ld/ar/as/nasm/ninja
2. Directory noise — make[N]: Entering/Leaving directory
3. Nothing-to-do — make[N]: Nothing to be done for '...'
4. Preserve all lines containing Error, error:, warning:, or undefined reference
"""
from __future__ import annotations

import pytest

from token_goat.bash_compress import MakeFilter


def _compress(inp: str, argv: list[str] | None = None) -> str:
    return MakeFilter().compress(inp, "", 0, argv or ["make", "all"])


# ---------------------------------------------------------------------------
# 1. Command-echo suppression
# ---------------------------------------------------------------------------

class TestCommandEchoSuppression:
    @pytest.mark.parametrize("cmd", [
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
    ])
    def test_compiler_suppressed_clean_build(self, cmd: str) -> None:
        # Clean build: no error follows, so compiler line must be dropped
        inp = "\n".join([cmd, "Build complete."])
        out = _compress(inp)
        assert cmd not in out

    def test_cc_kept_when_next_line_is_error(self) -> None:
        inp = "cc -O2 foo.c -o foo\nfoo.c:1:1: error: undeclared identifier 'x'"
        out = _compress(inp)
        assert "cc -O2 foo.c -o foo" in out

    def test_gcc_kept_when_next_line_is_error(self) -> None:
        inp = "gcc -O2 foo.c -o foo\nfoo.c:10:5: error: 'bar' undeclared"
        out = _compress(inp)
        assert "gcc -O2 foo.c -o foo" in out

    def test_gxx_kept_when_next_line_is_error(self) -> None:
        inp = "g++ -std=c++17 foo.cpp -o foo\nfoo.cpp:3:1: error: expected ';'"
        out = _compress(inp)
        assert "g++ -std=c++17 foo.cpp -o foo" in out

    def test_clang_kept_when_next_line_is_error(self) -> None:
        inp = "clang -O2 foo.c -o foo\nfoo.c:7:3: error: expected expression"
        out = _compress(inp)
        assert "clang -O2 foo.c -o foo" in out

    def test_clang_plus_plus_kept_when_next_line_is_error(self) -> None:
        inp = "clang++ -std=c++17 foo.cpp -o foo\nfoo.cpp:5:3: error: use of undeclared identifier 'x'"
        out = _compress(inp)
        assert "clang++ -std=c++17 foo.cpp -o foo" in out

    def test_ld_kept_when_next_line_is_error(self) -> None:
        inp = "ld -o foo foo.o bar.o\nld: foo.o: undefined reference to `main'"
        out = _compress(inp)
        assert "ld -o foo foo.o bar.o" in out

    def test_ar_suppressed_in_clean_build(self) -> None:
        # Multiple ar lines with no errors — all dropped
        inp = "\n".join([
            "ar rcs libfoo.a alpha.o beta.o",
            "ar rcs libbar.a gamma.o",
            "Build finished.",
        ])
        out = _compress(inp)
        assert "ar rcs libfoo.a" not in out
        assert "ar rcs libbar.a" not in out
        assert "Build finished." in out

    def test_as_kept_when_next_line_is_error(self) -> None:
        inp = "as -o foo.o foo.s\nfoo.s:10: Error: unknown mnemonic 'movx'"
        out = _compress(inp)
        assert "as -o foo.o foo.s" in out

    def test_nasm_suppressed_clean(self) -> None:
        inp = "nasm -f elf64 foo.asm -o foo.o\nfoo.o created."
        out = _compress(inp)
        assert "nasm -f elf64 foo.asm" not in out

    def test_nasm_kept_when_next_line_is_error(self) -> None:
        inp = "nasm -f elf64 foo.asm -o foo.o\nfoo.asm:3: error: invalid combination of opcode and operands"
        out = _compress(inp)
        assert "nasm -f elf64 foo.asm" in out


# ---------------------------------------------------------------------------
# 2. Directory noise suppression
# ---------------------------------------------------------------------------

class TestDirectoryNoise:
    def test_entering_directory_dropped(self) -> None:
        inp = "make[2]: Entering directory '/home/user/project/src'"
        out = _compress(inp)
        assert "Entering directory" not in out

    def test_leaving_directory_dropped(self) -> None:
        inp = "make[2]: Leaving directory '/home/user/project/src'"
        out = _compress(inp)
        # Check the actual make line is gone (the note mentions "Leaving directory" too)
        assert "make[2]: Leaving directory" not in out

    def test_make_depth_1_entering_dropped(self) -> None:
        inp = "make[1]: Entering directory '/src'"
        out = _compress(inp)
        assert "Entering directory" not in out

    def test_deep_nesting_entering_dropped(self) -> None:
        inp = "make[5]: Entering directory '/a/b/c/d/e'"
        out = _compress(inp)
        assert "Entering directory" not in out

    def test_directory_lines_dropped_but_diagnostics_kept(self) -> None:
        # Real build output between directory lines must survive
        inp = "\n".join([
            "make[1]: Entering directory '/src'",
            "foo.c:3:1: warning: unused variable 'x'",
            "make[1]: Leaving directory '/src'",
        ])
        out = _compress(inp)
        assert "warning: unused variable 'x'" in out
        assert "make[1]: Entering directory" not in out
        assert "make[1]: Leaving directory" not in out

    def test_entering_suppression_note_emitted(self) -> None:
        # Suppression of directory lines emits a token-goat note
        inp = "\n".join([
            "make[1]: Entering directory '/src'",
            "make[1]: Leaving directory '/src'",
        ])
        out = _compress(inp)
        assert "token-goat" in out


# ---------------------------------------------------------------------------
# 3. Nothing-to-do suppression
# ---------------------------------------------------------------------------

class TestNothingToDo:
    def test_nothing_to_do_for_all_dropped(self) -> None:
        inp = "make[1]: Nothing to be done for 'all'."
        out = _compress(inp)
        assert "Nothing to be done" not in out

    def test_nothing_to_do_for_named_target(self) -> None:
        inp = "make[3]: Nothing to be done for 'install'."
        out = _compress(inp)
        assert "Nothing to be done" not in out

    def test_nothing_to_do_depth_0_dropped(self) -> None:
        inp = "make[0]: Nothing to be done for 'test'."
        out = _compress(inp)
        assert "Nothing to be done" not in out

    def test_nothing_to_do_suppression_note_emitted(self) -> None:
        inp = "make[1]: Nothing to be done for 'all'."
        out = _compress(inp)
        assert "token-goat" in out

    def test_nothing_to_do_suppressed_but_error_line_kept(self) -> None:
        # A separate error line in the same output must survive
        inp = "\n".join([
            "make[1]: Nothing to be done for 'all'.",
            "Makefile:12: *** missing separator.  Stop.",
        ])
        out = _compress(inp)
        assert "missing separator" in out


# ---------------------------------------------------------------------------
# 4. Preserve: Error, error:, warning:, undefined reference
# ---------------------------------------------------------------------------

class TestPreserveSignals:
    def test_error_colon_lowercase_kept(self) -> None:
        # error: (lowercase, with colon) — diagnostic from compiler
        inp = "foo.c:1:1: error: implicit declaration of function 'bar'"
        out = _compress(inp)
        assert "error: implicit declaration" in out

    def test_error_capital_no_colon_kept(self) -> None:
        # Error (capital E, no colon) — make end-of-build summary
        inp = "make[1]: *** [Makefile:20: foo] Error 2"
        out = _compress(inp)
        assert "Error 2" in out

    def test_warning_colon_kept(self) -> None:
        # warning: — compiler diagnostic
        inp = "foo.c:5:3: warning: comparison between signed and unsigned"
        out = _compress(inp)
        assert "warning: comparison" in out

    def test_undefined_reference_kept(self) -> None:
        # undefined reference — linker diagnostic
        inp = "foo.o: undefined reference to `main'"
        out = _compress(inp)
        assert "undefined reference" in out

    def test_compiler_ext_line_with_bare_Error_not_dropped(self) -> None:
        # clang++ invocation that itself embeds the word "Error" (no colon)
        # must NOT be dropped even without a following error line.
        # This exercises the _MAKE_PRESERVE_SIGNAL_RE \bError\b branch.
        inp = "clang++ -o app Error.o helper.o"
        out = _compress(inp)
        assert "clang++ -o app Error.o helper.o" in out

    def test_ld_line_with_bare_Error_not_dropped(self) -> None:
        # ld invocation embedding "Error" as a word in a filename
        inp = "ld -o app main.o Error.o -lfoo"
        out = _compress(inp)
        assert "ld -o app main.o Error.o" in out

    def test_warning_in_gcc_line_not_dropped(self) -> None:
        # A gcc invocation that itself contains "warning:" must be kept
        inp = "gcc: warning: foo.c: linker input file unused because linking not done"
        out = _compress(inp)
        assert "warning: foo.c" in out

    def test_undefined_reference_in_ld_line_not_dropped(self) -> None:
        # ld output line with "undefined reference" must survive
        inp = "libfoo.a(bar.o): undefined reference to `init'"
        out = _compress(inp)
        assert "undefined reference" in out

    def test_error_colon_case_insensitive_kept(self) -> None:
        # ERROR: (all-caps, with colon) — must also be preserved
        inp = "ld: ERROR: cannot find -lstdc++"
        out = _compress(inp)
        assert "ERROR: cannot find" in out
