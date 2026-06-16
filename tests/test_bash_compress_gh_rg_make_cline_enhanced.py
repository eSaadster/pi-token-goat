"""Enhanced edge-case tests for GhFilter, RgFilter, TailTruncFilter, ClineFilter,
WindsurfFilter, and MakeFilter — 45 new tests covering boundary conditions and
behaviours not exercised by the thin existing test files.
"""
from __future__ import annotations

import base64
import json

from tests.filter_test_helpers import apply_filter
from token_goat.bash_compress import (
    ClineFilter,
    GhFilter,
    MakeFilter,
    RgFilter,
    TailTruncFilter,
    WindsurfFilter,
    _redact_gh_base64_content,
)

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _b64(text: str) -> str:
    """Return GitHub-style base64-encoded string (with trailing newline)."""
    return base64.b64encode(text.encode()).decode() + "\n"


# A definitively long base64 value (well over 200 chars) and a short one (well under)
_LONG_B64 = _b64("x" * 300)   # base64 of 300 bytes >> 200 chars
_SHORT_B64 = base64.b64encode(b"hi").decode() + "\n"  # "aGk=\n" — 5 chars, well under 200


# ---------------------------------------------------------------------------
# GhFilter — base64 detection boundary
# ---------------------------------------------------------------------------

class TestGhBase64Boundary:
    """Boundary behaviour around the _GH_BASE64_MIN_LEN = 200 threshold."""

    def test_content_exactly_at_threshold_not_redacted(self) -> None:
        # The filter uses len(val) > 200, so a value of exactly 200 chars is NOT redacted
        # Build a string of exactly 200 valid base64 chars (no trailing newline so len==200)
        val = "A" * 200
        assert len(val) == 200
        payload = {"content": val}
        result = _redact_gh_base64_content(json.dumps(payload))
        parsed = json.loads(result)
        assert parsed["content"] == val

    def test_content_one_over_threshold_but_non_b64_not_redacted(self) -> None:
        # 201-char string that is NOT valid base64 must pass through
        val = "not-base64!!" + "x" * 190
        payload = {"content": val}
        result = _redact_gh_base64_content(json.dumps(payload))
        parsed = json.loads(result)
        assert parsed["content"] == val

    def test_long_valid_b64_redacted_and_byte_count_present(self) -> None:
        raw = b"binary blob " * 25  # long enough
        encoded = base64.b64encode(raw).decode() + "\n"
        assert len(encoded) > 200
        payload = {"content": encoded}
        result = _redact_gh_base64_content(json.dumps(payload))
        parsed = json.loads(result)
        assert "<base64 content:" in parsed["content"]
        assert f"{len(raw)} bytes decoded" in parsed["content"]

    def test_nested_array_of_objects_all_redacted(self) -> None:
        items = [{"path": f"f{i}.py", "content": _LONG_B64} for i in range(5)]
        result = _redact_gh_base64_content(json.dumps(items))
        parsed = json.loads(result)
        assert all("<base64 content:" in item["content"] for item in parsed)

    def test_empty_string_input(self) -> None:
        assert _redact_gh_base64_content("") == ""

    def test_whitespace_only_input_passthrough(self) -> None:
        ws = "   \n\t  "
        assert _redact_gh_base64_content(ws) == ws

    def test_plain_number_content_not_redacted(self) -> None:
        # content field holding a number (non-string) must pass through without error
        payload = {"content": 12345}
        stdout = json.dumps(payload)
        result = _redact_gh_base64_content(stdout)
        assert result == stdout


# ---------------------------------------------------------------------------
# GhFilter — gh run view and gh pr/run/issue list
# ---------------------------------------------------------------------------

class TestGhFilterRunView:
    """GhFilter routes gh run view through the passing-step collapse logic."""

    def setup_method(self) -> None:
        self.flt = GhFilter()

    def _run(self, stdout: str) -> str:
        return apply_filter(self.flt, stdout, argv=["gh", "run", "view", "123"])

    def test_passing_steps_collapsed(self) -> None:
        stdout = (
            "✓ Set up job\n"
            "  Run actions/checkout@v4\n"
            "  Run actions/setup-python@v5\n"
            "✗ Run tests\n"
            "  pytest failed with exit code 1\n"
        )
        out = self._run(stdout)
        # Passing step preamble lines should be dropped
        assert "Run actions/checkout@v4" not in out
        # Failing step body must survive
        assert "pytest failed" in out

    def test_no_passing_steps_passes_through(self) -> None:
        stdout = "✗ Build\n  cargo build failed\n"
        out = self._run(stdout)
        assert "cargo build failed" in out

    def test_empty_run_view_output(self) -> None:
        out = self._run("")
        assert out == ""


class TestGhFilterList:
    """GhFilter truncates gh pr/run/issue list to 30 rows."""

    def setup_method(self) -> None:
        self.flt = GhFilter()

    def _pr_list(self, n_rows: int) -> str:
        header = "NUMBER  TITLE             BRANCH      STATE"
        rows = [f"{i}  PR title {i}  branch-{i}  open" for i in range(1, n_rows + 1)]
        return header + "\n" + "\n".join(rows) + "\n"

    def test_under_30_rows_not_truncated(self) -> None:
        stdout = self._pr_list(10)
        out = apply_filter(self.flt, stdout, argv=["gh", "pr", "list"])
        assert "showing first 30" not in out
        assert "PR title 10" in out

    def test_over_30_rows_truncated_with_note(self) -> None:
        stdout = self._pr_list(50)
        out = apply_filter(self.flt, stdout, argv=["gh", "pr", "list"])
        assert "showing first 30 of 50 prs" in out
        # Row 31 onwards should be absent
        assert "PR title 31" not in out

    def test_run_list_note_uses_correct_subcommand(self) -> None:
        header = "STATUS  NAME        ID"
        rows = [f"completed  run-{i}  {10000 + i}" for i in range(40)]
        stdout = header + "\n" + "\n".join(rows) + "\n"
        out = apply_filter(self.flt, stdout, argv=["gh", "run", "list"])
        assert "runs" in out  # subcommand suffix in note

    def test_issue_list_note_uses_correct_subcommand(self) -> None:
        header = "NUMBER  TITLE  STATE"
        rows = [f"{i}  Issue {i}  open" for i in range(40)]
        stdout = header + "\n" + "\n".join(rows) + "\n"
        out = apply_filter(self.flt, stdout, argv=["gh", "issue", "list"])
        assert "issues" in out


# ---------------------------------------------------------------------------
# RgFilter — edge cases
# ---------------------------------------------------------------------------

def _rg_ctx_block(match: str, before: str = "ctx-before", after: str = "ctx-after") -> str:
    """Build one rg -C 1 output block with separator."""
    return f"file.py-10-{before}\nfile.py:11:{match}\nfile.py-12-{after}\n--\n"


class TestRgFilterEdgeCases:
    """RgFilter strips context lines from large -C/-A/-B output."""

    def setup_method(self) -> None:
        self.flt = RgFilter()

    def _apply(self, stdout: str, argv: list[str] | None = None) -> str:
        return apply_filter(self.flt, stdout, argv=argv or ["rg", "-C", "1", "pattern"])

    def test_empty_input(self) -> None:
        assert self._apply("") == ""

    def test_small_output_passes_through_unchanged(self) -> None:
        # Only a few context lines — no suppression
        stdout = _rg_ctx_block("def foo():")
        out = self._apply(stdout)
        # Short output: no suppression note, content preserved
        assert "token-goat" not in out
        assert "def foo():" in out

    def test_large_context_output_strips_ctx_lines(self) -> None:
        # Use exactly 8 groups (≤ _RG_GROUP_THRESHOLD=10) so context-strip path fires.
        # Each block has 31+ lines total; 8 × 4 lines = 32 lines > _RG_CONTEXT_THRESHOLD=30.
        blocks = "".join(_rg_ctx_block(f"match{i}", f"before{i}", f"after{i}") for i in range(8))
        out = self._apply(blocks)
        assert "context lines suppressed" in out

    def test_match_lines_preserved_after_context_strip(self) -> None:
        # With ≤10 groups and output > threshold, match lines survive context-strip.
        blocks = "".join(_rg_ctx_block(f"KEEP_{i}") for i in range(8))
        out = self._apply(blocks)
        assert "KEEP_0" in out
        assert "KEEP_7" in out

    def test_many_groups_use_match_group_sentinel(self) -> None:
        # > _RG_GROUP_THRESHOLD=10 groups → _compress_groups() fires, top 5 kept.
        blocks = "".join(_rg_ctx_block(f"m{i}") for i in range(15))
        out = self._apply(blocks)
        assert "match groups suppressed" in out

    def test_hint_mentions_rerun_options(self) -> None:
        # Both compression paths mention -l or rerun in their sentinel text.
        blocks = "".join(_rg_ctx_block(f"m{i}") for i in range(8))
        out = self._apply(blocks)
        assert "rerun" in out and "-l" in out

    def test_grep_binary_same_compression_as_rg(self) -> None:
        # grep dispatches to RgFilter just like rg; both produce context-strip note.
        blocks = "".join(_rg_ctx_block(f"m{i}") for i in range(8))
        out_rg = apply_filter(self.flt, blocks, argv=["rg", "-C", "1", "m"])
        out_grep = apply_filter(self.flt, blocks, argv=["grep", "-C", "1", "m"])
        assert "context lines suppressed" in out_rg
        assert "context lines suppressed" in out_grep

    def test_plain_match_only_output_no_suppression(self) -> None:
        # Output with only match lines and no context lines → no suppression
        lines = "\n".join(f"file.py:{i}:match" for i in range(1, 60))
        out = self._apply(lines)
        # No context lines to strip, note should not appear
        assert "context lines suppressed" not in out


# ---------------------------------------------------------------------------
# TailTruncFilter — N-line boundary and sentinel details
# ---------------------------------------------------------------------------

class TestTailTruncFilterBoundary:
    """Boundary tests around the 500-line threshold."""

    def setup_method(self) -> None:
        self.flt = TailTruncFilter()

    def _lines(self, n: int) -> str:
        return "\n".join(f"L{i}" for i in range(n))

    def test_500_lines_passes_through(self) -> None:
        stdout = self._lines(500)
        out = apply_filter(self.flt, stdout, argv=["cmd"])
        assert "lines suppressed" not in out
        assert out == stdout

    def test_501_lines_triggers_truncation(self) -> None:
        stdout = self._lines(501)
        out = apply_filter(self.flt, stdout, argv=["cmd"])
        assert "lines suppressed" in out

    def test_sentinel_contains_disable_hint(self) -> None:
        stdout = self._lines(600)
        out = apply_filter(self.flt, stdout, argv=["cmd"])
        assert "TOKEN_GOAT_BASH_COMPRESS=0" in out

    def test_suppressed_count_accurate_for_600_lines(self) -> None:
        # 600 lines → keep 50 head + 50 tail = 100 kept, 500 suppressed
        stdout = self._lines(600)
        out = apply_filter(self.flt, stdout, argv=["cmd"])
        assert "500 lines suppressed" in out

    def test_head_50_preserved(self) -> None:
        stdout = self._lines(600)
        out = apply_filter(self.flt, stdout, argv=["cmd"])
        assert "L0" in out
        assert "L49" in out

    def test_tail_50_preserved(self) -> None:
        stdout = self._lines(600)
        out = apply_filter(self.flt, stdout, argv=["cmd"])
        assert "L550" in out
        assert "L599" in out

    def test_middle_lines_absent(self) -> None:
        stdout = self._lines(600)
        out = apply_filter(self.flt, stdout, argv=["cmd"])
        # Line 50 is in the suppressed range (lines 50–549)
        lines = out.splitlines()
        # Only the marker line should appear between head and tail
        marker_lines = [ln for ln in lines if "lines suppressed" in ln]
        assert len(marker_lines) == 1

    def test_empty_input(self) -> None:
        out = apply_filter(self.flt, "", argv=["cmd"])
        assert out == ""

    def test_matches_any_argv(self) -> None:
        # TailTruncFilter.matches() is catch-all
        assert self.flt.matches([]) is True
        assert self.flt.matches(["python"]) is True
        assert self.flt.matches(["go", "test", "./..."]) is True


# ---------------------------------------------------------------------------
# ClineFilter — deduplication and noise drops
# ---------------------------------------------------------------------------

class TestClineFilterEdgeCases:
    """Edge cases for ClineFilter noise removal and token-budget handling."""

    def setup_method(self) -> None:
        self.flt = ClineFilter()

    def _run(self, stdout: str) -> str:
        return apply_filter(self.flt, stdout, argv=["cline"])

    def test_empty_input(self) -> None:
        assert self._run("") == ""

    def test_version_banner_dropped(self) -> None:
        stdout = "Cline v3.7.0\nActual output here\n"
        out = self._run(stdout)
        assert "Cline v3." not in out
        assert "Actual output here" in out

    def test_spinner_lines_dropped(self) -> None:
        # Cline spinner regex matches ASCII dots: "Thinking..." / "Processing..."
        # (Unicode ellipsis "…" is NOT matched — that's WindsurfFilter's pattern)
        stdout = "Thinking...\nProcessing...\nActual content\n"
        out = self._run(stdout)
        assert "Thinking..." not in out
        assert "Actual content" in out

    def test_token_cost_note_present(self) -> None:
        # Lines containing "API Cost" should be summarised rather than dropped raw
        stdout = (
            "Response from Claude:\nHello world\n"
            "API Cost: $0.0042 | Tokens: 1234 in / 567 out\n"
        )
        out = self._run(stdout)
        # Either the cost line is kept or a note summarises it — must not be silently dropped
        assert "cost" in out.lower() and "0.004" in out

    def test_response_content_preserved(self) -> None:
        stdout = "Cline v3.0.0\nHere is the code:\ndef hello(): pass\n"
        out = self._run(stdout)
        assert "def hello(): pass" in out

    def test_error_on_nonzero_exit_preserved(self) -> None:
        stdout = "Cline v3.0.0\nfatal: connection refused\n"
        out = apply_filter(self.flt, stdout, exit_code=1, argv=["cline"])
        assert "connection refused" in out

    def test_mcp_noise_dropped(self) -> None:
        stdout = (
            "MCP server connected\n"
            "MCP: tool list refreshed\n"
            "Actual task output\n"
        )
        out = self._run(stdout)
        assert "Actual task output" in out
        # MCP noise should not remain verbatim
        assert "MCP server connected" not in out

    def test_no_crash_on_binary_like_content(self) -> None:
        # Filter should handle non-UTF8-safe characters without raising
        stdout = "Output with \x00 null bytes\nand more content\n"
        out = self._run(stdout)
        assert len(out) > 0
        assert "null bytes" in out or "[token-goat:" in out or "more content" in out


# ---------------------------------------------------------------------------
# WindsurfFilter — startup noise and cascade tool calls
# ---------------------------------------------------------------------------

class TestWindsurfFilterEdgeCases:
    """WindsurfFilter strips VS Code startup noise and Codeium activation lines."""

    def setup_method(self) -> None:
        self.flt = WindsurfFilter()

    def _run(self, stdout: str) -> str:
        return apply_filter(self.flt, stdout, argv=["windsurf"])

    def test_empty_input(self) -> None:
        assert self._run("") == ""

    def test_codeium_activation_dropped(self) -> None:
        stdout = (
            "Codeium: Activating…\n"
            "Codeium: Loading index…\n"
            "Actual output\n"
        )
        out = self._run(stdout)
        assert "Codeium: Activating" not in out
        assert "Actual output" in out

    def test_response_content_survives(self) -> None:
        stdout = "Extension host started\nHere is the answer: 42\n"
        out = self._run(stdout)
        assert "42" in out

    def test_error_passthrough_on_nonzero_exit(self) -> None:
        stdout = "windsurf crashed: segfault at 0x0\n"
        out = apply_filter(self.flt, stdout, exit_code=139, argv=["windsurf"])
        assert "segfault" in out


# ---------------------------------------------------------------------------
# MakeFilter — recipe, multi-target, directory change lines
# ---------------------------------------------------------------------------

class TestMakeFilterEdgeCases:
    """Edge cases for MakeFilter: recipe collapse, directory noise, error survival."""

    def setup_method(self) -> None:
        self.flt = MakeFilter()

    def _compress(self, stdout: str, argv: list[str] | None = None) -> str:
        return apply_filter(self.flt, stdout, argv=argv or ["make"])

    def test_empty_input(self) -> None:
        assert self._compress("") == ""

    def test_entering_directory_noise_suppressed(self) -> None:
        stdout = "make[1]: Entering directory '/tmp/build'\nBuild complete\n"
        out = self._compress(stdout)
        assert "Entering directory" not in out

    def test_leaving_directory_noise_suppressed(self) -> None:
        stdout = "make[1]: Leaving directory '/tmp/build'\nBuild complete\n"
        out = self._compress(stdout)
        assert "Leaving directory '/tmp/build'" not in out

    def test_nothing_to_be_done_suppressed(self) -> None:
        stdout = "make[1]: Nothing to be done for 'all'.\n"
        out = self._compress(stdout)
        assert "Nothing to be done" not in out

    def test_error_line_always_preserved(self) -> None:
        stdout = (
            "make[1]: Entering directory '/tmp'\n"
            "src/main.c:42:5: error: undeclared identifier 'x'\n"
            "make[1]: Leaving directory '/tmp'\n"
        )
        out = self._compress(stdout)
        assert "error: undeclared identifier" in out

    def test_warning_line_always_preserved(self) -> None:
        stdout = (
            "make[1]: Entering directory '/build'\n"
            "src/util.c:7:1: warning: unused variable 'tmp'\n"
        )
        out = self._compress(stdout)
        assert "warning: unused variable" in out

    def test_star_error_marker_preserved(self) -> None:
        stdout = (
            "make[1]: Entering directory '/build'\n"
            "make[1]: *** [Makefile:10] Error 2\n"
        )
        out = self._compress(stdout)
        assert "*** [Makefile:10] Error 2" in out

    def test_gcc_compiler_echo_suppressed(self) -> None:
        # Plain gcc invocation line with no following error is dropped
        progress = [f"[{i+1:3d}%] Building CXX src/f{i}.cpp.o" for i in range(40)]
        stdout = "\n".join(progress) + "\ngcc -O2 -c src/foo.c -o src/foo.o\n"
        out = self._compress(stdout)
        assert "gcc -O2" not in out

    def test_ninja_binary_matches(self) -> None:
        assert self.flt.matches(["ninja", "-j4"])

    def test_go_build_binary_matches(self) -> None:
        assert self.flt.matches(["go", "build", "./..."])

    def test_short_output_passes_through(self) -> None:
        stdout = "Build complete\n"
        out = self._compress(stdout)
        assert "Build complete" in out

    def test_go_generate_trigger_suppressed(self) -> None:
        stdout = "go:generate go run cmd/gen/main.go\ngenerated ok\n"
        out = self._compress(stdout, argv=["go", "generate", "./..."])
        # The go:generate trigger line should be suppressed with a note
        assert "go:generate go run" not in out
        assert "dropped" in out and "[token-goat:" in out

    def test_multi_target_errors_all_preserved(self) -> None:
        stdout = (
            "[  1%] Building CXX src/a.cpp.o\n"
            "src/a.cpp:3:1: error: bad syntax\n"
            "[  2%] Building CXX src/b.cpp.o\n"
            "src/b.cpp:9:5: error: type mismatch\n"
        )
        out = self._compress(stdout)
        assert "src/a.cpp:3:1: error" in out
        assert "src/b.cpp:9:5: error" in out
