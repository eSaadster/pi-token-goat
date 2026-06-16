"""Tests for PlaywrightFilter and CypressFilter bash_compress filters."""
from __future__ import annotations

import token_goat.bash_compress as bc
from tests.filter_test_helpers import apply_filter  # type: ignore[import]

# ---------------------------------------------------------------------------
# Shared filter instances
# ---------------------------------------------------------------------------

_PW = bc.PlaywrightFilter()
_CY = bc.CypressFilter()

# ---------------------------------------------------------------------------
# PlaywrightFilter helpers
# ---------------------------------------------------------------------------

_PW_ARGV = ["playwright", "test"]
_PW_NPX_ARGV = ["npx", "playwright", "test"]


def _pw(stdout: str, *, stderr: str = "", exit_code: int = 0, argv: list[str] | None = None) -> str:
    return apply_filter(_PW, stdout=stdout, stderr=stderr, exit_code=exit_code, argv=argv or _PW_ARGV)


# ---------------------------------------------------------------------------
# Cypress helpers and fixtures
# ---------------------------------------------------------------------------

_CY_ARGV = ["cypress", "run"]


def _cy(stdout: str, *, stderr: str = "", exit_code: int = 0, argv: list[str] | None = None) -> str:
    return apply_filter(_CY, stdout=stdout, stderr=stderr, exit_code=exit_code, argv=argv or _CY_ARGV)


# Box-drawing building blocks (match what Cypress actually emits)
_BOX_TOP = "  ┌" + "─" * 36 + "┐\n"
_BOX_BOTTOM = "  └" + "─" * 36 + "┘\n"
_BOX_SIDE = "  │"
_SEP_DASH = "─" * 40 + "\n"
_SEP_EQ = "=" * 40 + "\n"

_PASS_MARK = "✓"   # ✓
_FAIL_MARK = "✗"   # ✗

_RUN_STARTING_BLOCK = (
    _SEP_EQ
    + "\n"
    + "  (Run Starting)\n"
    + "\n"
    + _BOX_TOP
    + _BOX_SIDE + " Cypress:        13.6.0                     │\n"
    + _BOX_SIDE + " Browser:        Electron 114 (headless)    │\n"
    + _BOX_SIDE + " Specs:          1 found (login.cy.ts)      │\n"
    + _BOX_BOTTOM
    + "\n"
)

_PER_SPEC_HEADER = (
    "\n"
    + _SEP_DASH
    + "                              Running:  login.cy.ts    (1 of 1)\n"
    + _SEP_DASH
    + "\n"
)

_TESTS_ALL_PASS = (
    "  Login Tests\n"
     f"    {_PASS_MARK} displays login form (234ms)\n"
     f"    {_PASS_MARK} validates email input (456ms)\n"
     "\n"
     "  2 passing (1s)\n"
     "\n"
)

_TESTS_WITH_FAILURE = (
    "  Login Tests\n"
     f"    {_PASS_MARK} displays login form (234ms)\n"
     f"    {_FAIL_MARK} fails on network error (500ms)\n"
     "\n"
     "  1 passing (1s)\n"
     "  1 failing\n"
     "\n"
     "  1) Login Tests\n"
     "       fails on network error:\n"
     "     AssertionError: expected 500 to equal 200\n"
     "\n"
)

_RESULTS_BOX = (
    "  (Results)\n"
     "\n"
    + _BOX_TOP
    + _BOX_SIDE + " Tests:        2   │\n"
    + _BOX_SIDE + " Passing:      2   │\n"
    + _BOX_SIDE + " Failing:      0   │\n"
    + _BOX_BOTTOM
    + "\n"
)

_VIDEO_SECTION = (
    "  (Video)\n"
     "\n"
     "  -  Started processing:  Compressing to 32 CRF\n"
     "  -  Compression progress:  11%\n"
     "  -  Compression progress:  53%\n"
     "  -  Compression progress:  100%\n"
     "  -  Finished processing:  /path/to/login.cy.ts.mp4\n"
     "\n"
)

_RUN_FINISHED_BLOCK = (
    "\n"
    + _SEP_EQ
    + "\n"
    + "  (Run Finished)\n"
    + "\n"
    + "       Spec                   Tests  Passing  Failing\n"
    + _BOX_TOP
    + _BOX_SIDE + f" {_PASS_MARK}  login.cy.ts   00:01   2   2   -  │\n"
    + _BOX_BOTTOM
    + f"    {_PASS_MARK}  All specs passed!   00:01   2   2   -   -   -\n"
    + "\n"
    + _SEP_EQ
)

_FULL_SUCCESS_OUTPUT = (
    _RUN_STARTING_BLOCK
    + _PER_SPEC_HEADER
    + _TESTS_ALL_PASS
    + _RESULTS_BOX
    + _VIDEO_SECTION
    + _RUN_FINISHED_BLOCK
)

_FULL_FAILURE_OUTPUT = (
    _RUN_STARTING_BLOCK
    + _PER_SPEC_HEADER
    + _TESTS_WITH_FAILURE
    + _RESULTS_BOX
    + _VIDEO_SECTION
    + _RUN_FINISHED_BLOCK
)


# ===========================================================================
# PlaywrightFilter — matches()
# ===========================================================================


class TestPlaywrightFilterMatches:
    def test_playwright_test(self) -> None:
        assert _PW.matches(["playwright", "test"])

    def test_playwright_install(self) -> None:
        assert _PW.matches(["playwright", "install"])

    def test_playwright_codegen(self) -> None:
        assert _PW.matches(["playwright", "codegen"])

    def test_playwright_screenshot(self) -> None:
        assert _PW.matches(["playwright", "screenshot"])

    def test_playwright_show_trace(self) -> None:
        assert _PW.matches(["playwright", "show-trace"])

    def test_playwright_pdf(self) -> None:
        assert _PW.matches(["playwright", "pdf"])

    def test_playwright_bare(self) -> None:
        # bare playwright with no subcmd matches (no argv[1])
        assert _PW.matches(["playwright"])

    def test_playwright_unknown_subcmd_no_match(self) -> None:
        assert not _PW.matches(["playwright", "unknown-cmd"])

    def test_npx_playwright_test(self) -> None:
        assert _PW.matches(["npx", "playwright", "test"])

    def test_npx_y_playwright_test(self) -> None:
        assert _PW.matches(["npx", "-y", "playwright", "test"])

    def test_bunx_playwright_test(self) -> None:
        assert _PW.matches(["bunx", "playwright", "test"])

    def test_pnpx_playwright_test(self) -> None:
        assert _PW.matches(["pnpx", "playwright", "test"])

    def test_empty_argv_no_match(self) -> None:
        assert not _PW.matches([])

    def test_jest_no_match(self) -> None:
        assert not _PW.matches(["jest"])

    def test_cypress_no_match(self) -> None:
        assert not _PW.matches(["cypress", "run"])

    def test_npx_unknown_tool_no_match(self) -> None:
        assert not _PW.matches(["npx", "vitest"])


# ===========================================================================
# PlaywrightFilter — passed-test line suppression
# ===========================================================================


class TestPlaywrightPassedLines:
    def test_check_mark_pass_line_suppressed(self) -> None:
        out = _pw("  ✓ should render home page (234ms)\n")
        assert "should render home page" not in out

    def test_heavy_check_mark_pass_line_suppressed(self) -> None:
        # ✔ (U+2714 HEAVY CHECK MARK) variant
        out = _pw("  ✔ submits the form (100ms)\n")
        assert "submits the form" not in out

    def test_suppressed_count_note_emitted(self) -> None:
        stdout = (
            "  ✓ test one (10ms)\n"
            "  ✓ test two (20ms)\n"
        )
        out = _pw(stdout)
        assert "suppressed 2 passed-test / install-progress lines" in out

    def test_no_note_when_nothing_suppressed(self) -> None:
        out = _pw("Running 0 tests using 1 worker\n")
        assert "Running 0 tests using 1 worker" in out
        assert "[token-goat:" not in out

    def test_failure_line_kept(self) -> None:
        out = _pw("  ✗ login fails gracefully (500ms)\n")
        assert "login fails gracefully" in out

    def test_error_message_kept(self) -> None:
        out = _pw("    Error: expected 200, got 404\n")
        assert "Error: expected 200, got 404" in out

    def test_summary_line_kept(self) -> None:
        out = _pw("  5 passed (12s)\n")
        assert "5 passed (12s)" in out

    def test_failed_summary_line_kept(self) -> None:
        out = _pw("  2 failed\n")
        assert "2 failed" in out

    def test_header_line_kept(self) -> None:
        out = _pw("Running 10 tests using 3 workers\n")
        assert "Running 10 tests using 3 workers" in out

    def test_mixed_pass_fail_only_fail_remains(self) -> None:
        stdout = (
            "  ✓ passes fine (10ms)\n"
            "  ✗ breaks badly (50ms)\n"
            "  ✓ also passes (20ms)\n"
        )
        out = _pw(stdout)
        assert "passes fine" not in out
        assert "also passes" not in out
        assert "breaks badly" in out


# ===========================================================================
# PlaywrightFilter — download/install progress suppression
# ===========================================================================


class TestPlaywrightDownloadLines:
    def test_downloading_chromium_suppressed(self) -> None:
        out = _pw("Downloading Chromium 123456\n")
        assert "Downloading Chromium" not in out

    def test_downloaded_suppressed(self) -> None:
        out = _pw("Downloaded Chromium r1234\n")
        assert "Downloaded" not in out

    def test_installing_suppressed(self) -> None:
        out = _pw("Installing dependencies\n")
        assert "Installing" not in out

    def test_progress_bar_line_suppressed(self) -> None:
        # matches: ^\s*[\d.]+\s+[KMG]b\s+\[
        out = _pw("  111.2 Mb [=====>    ] 60%\n")
        assert "Mb [" not in out

    def test_kb_progress_bar_suppressed(self) -> None:
        out = _pw("  512.0 Kb [==========] 100%\n")
        assert "Kb [" not in out

    def test_download_note_emitted(self) -> None:
        out = _pw("Downloading Chromium r123\n")
        assert "suppressed" in out

    def test_regular_line_not_affected_by_download_filter(self) -> None:
        out = _pw("Browser started: chromium\n")
        assert "Browser started: chromium" in out

    def test_stderr_download_lines_suppressed(self) -> None:
        out = _pw("", stderr="Downloading Firefox r99\n")
        assert "Downloading Firefox" not in out


# ===========================================================================
# PlaywrightFilter — npx/bunx/pnpx wrapper dispatch
# ===========================================================================


class TestPlaywrightWrapperDispatch:
    def test_npx_wrapper_compresses(self) -> None:
        stdout = "  ✓ test one (10ms)\n  ✓ test two (20ms)\n"
        out = _pw(stdout, argv=["npx", "playwright", "test"])
        assert "test one" not in out
        assert "test two" not in out

    def test_bunx_wrapper_compresses(self) -> None:
        stdout = "  ✓ test alpha (10ms)\n"
        out = _pw(stdout, argv=["bunx", "playwright", "test"])
        assert "test alpha" not in out

    def test_pnpx_wrapper_compresses(self) -> None:
        stdout = "  ✓ test beta (10ms)\n"
        out = _pw(stdout, argv=["pnpx", "playwright", "test"])
        assert "test beta" not in out

    def test_empty_input_no_crash(self) -> None:
        out = _pw("")
        assert isinstance(out, str)

    def test_stderr_merged_into_output(self) -> None:
        out = _pw("", stderr="Error: browser not found\n")
        assert "Error: browser not found" in out


# ===========================================================================
# CypressFilter — matches()
# ===========================================================================


class TestCypressFilterMatches:
    def test_cypress_run(self) -> None:
        assert _CY.matches(["cypress", "run"])

    def test_cypress_open(self) -> None:
        assert _CY.matches(["cypress", "open"])

    def test_cypress_bare(self) -> None:
        # bare cypress with no subcommand matches
        assert _CY.matches(["cypress"])

    def test_cypress_run_with_flags(self) -> None:
        assert _CY.matches(["cypress", "run", "--headless", "--browser", "chrome"])

    def test_cypress_exe(self) -> None:
        assert _CY.matches(["cypress.exe", "run"])

    def test_npx_cypress_run(self) -> None:
        assert _CY.matches(["npx", "cypress", "run"])

    def test_npx_flag_cypress_run(self) -> None:
        assert _CY.matches(["npx", "--yes", "cypress", "run"])

    def test_bunx_cypress_run(self) -> None:
        assert _CY.matches(["bunx", "cypress", "run"])

    def test_pnpx_cypress_run(self) -> None:
        assert _CY.matches(["pnpx", "cypress", "run"])

    def test_cypress_verify_no_match(self) -> None:
        # verify is not in SUBCMDS
        assert not _CY.matches(["cypress", "verify"])

    def test_cypress_install_no_match(self) -> None:
        # install is not in SUBCMDS
        assert not _CY.matches(["cypress", "install"])

    def test_empty_argv_no_match(self) -> None:
        assert not _CY.matches([])

    def test_playwright_not_matched(self) -> None:
        assert not _CY.matches(["playwright", "test"])

    def test_jest_not_matched(self) -> None:
        assert not _CY.matches(["jest"])


# ===========================================================================
# CypressFilter — banner / Run Starting box suppression
# ===========================================================================


class TestCypressRunStartingSuppression:
    def test_run_starting_header_suppressed(self) -> None:
        out = _cy(_RUN_STARTING_BLOCK)
        assert "(Run Starting)" not in out

    def test_box_metadata_suppressed(self) -> None:
        out = _cy(_RUN_STARTING_BLOCK)
        assert "Cypress:        13.6.0" not in out

    def test_browser_metadata_suppressed(self) -> None:
        out = _cy(_RUN_STARTING_BLOCK)
        assert "Electron 114 (headless)" not in out

    def test_box_top_suppressed(self) -> None:
        out = _cy(_RUN_STARTING_BLOCK)
        assert "Specs:          1 found" not in out

    def test_banner_note_emitted(self) -> None:
        out = _cy(_RUN_STARTING_BLOCK)
        assert "cypress header/results box lines" in out


# ===========================================================================
# CypressFilter — separator line suppression
# ===========================================================================


class TestCypressSeparatorSuppression:
    def test_dash_separator_suppressed(self) -> None:
        out = _cy(_SEP_DASH + "  some content\n")
        assert "─" * 30 not in out

    def test_equals_separator_suppressed(self) -> None:
        out = _cy(_SEP_EQ + "  some content\n")
        assert "=" * 40 not in out

    def test_content_after_separator_kept(self) -> None:
        out = _cy(_SEP_DASH + "  real content\n")
        assert "real content" in out

    def test_running_spec_header_kept(self) -> None:
        out = _cy(_PER_SPEC_HEADER)
        assert "Running:  login.cy.ts" in out

    def test_separator_note_emitted(self) -> None:
        out = _cy(_PER_SPEC_HEADER)
        assert "separator lines" in out


# ===========================================================================
# CypressFilter — Results box suppression
# ===========================================================================


class TestCypressResultsBoxSuppression:
    def test_results_header_suppressed(self) -> None:
        out = _cy(_RESULTS_BOX)
        assert "(Results)" not in out

    def test_results_tests_count_suppressed(self) -> None:
        out = _cy(_RESULTS_BOX)
        assert "Tests:        2" not in out

    def test_results_passing_count_suppressed(self) -> None:
        out = _cy(_RESULTS_BOX)
        assert "Passing:      2" not in out

    def test_results_box_note_emitted(self) -> None:
        out = _cy(_RESULTS_BOX)
        assert "cypress header/results box lines" in out

    def test_full_success_results_box_absent(self) -> None:
        out = _cy(_FULL_SUCCESS_OUTPUT)
        assert "(Results)" not in out


# ===========================================================================
# CypressFilter — Video section suppression
# ===========================================================================


class TestCypressVideoSuppression:
    def test_video_header_suppressed(self) -> None:
        out = _cy(_VIDEO_SECTION + _RUN_FINISHED_BLOCK)
        assert "(Video)" not in out

    def test_compression_progress_suppressed(self) -> None:
        out = _cy(_VIDEO_SECTION + _RUN_FINISHED_BLOCK)
        assert "Compression progress" not in out

    def test_started_processing_suppressed(self) -> None:
        out = _cy(_VIDEO_SECTION + _RUN_FINISHED_BLOCK)
        assert "Started processing" not in out

    def test_finished_processing_suppressed(self) -> None:
        out = _cy(_VIDEO_SECTION + _RUN_FINISHED_BLOCK)
        assert "Finished processing" not in out

    def test_video_note_emitted(self) -> None:
        out = _cy(_VIDEO_SECTION + _RUN_FINISHED_BLOCK)
        assert "video processing lines" in out

    def test_run_finished_kept_after_video(self) -> None:
        out = _cy(_VIDEO_SECTION + _RUN_FINISHED_BLOCK)
        assert "(Run Finished)" in out

    def test_summary_table_kept_after_video(self) -> None:
        out = _cy(_VIDEO_SECTION + _RUN_FINISHED_BLOCK)
        assert "All specs passed!" in out

    def test_error_in_video_section_kept(self) -> None:
        # error lines inside the video section must pass through
        out = _cy(
            "  (Video)\n"
            "  - Started processing: MySpec.cy.ts\n"
            "  Error: ffmpeg not found in PATH\n"
            "  (Run Finished)\n"
            "\n"
            "  All specs passed!\n"
        )
        assert "Error: ffmpeg not found" in out

    def test_truncated_video_section_emits_warning(self) -> None:
        # no (Run Finished) — simulate truncated output
        out = _cy(
            "  (Video)\n"
            "  - Started processing: MySpec.cy.ts\n"
            "  - Compression: 60%\n"
        )
        lower = out.lower()
        assert "truncated" in lower or "warning" in lower

    def test_no_video_section_ok(self) -> None:
        no_video = _FULL_SUCCESS_OUTPUT.replace(_VIDEO_SECTION, "")
        out = _cy(no_video)
        assert "(Run Finished)" in out
        assert "All specs passed!" in out


# ===========================================================================
# CypressFilter — passing test line suppression
# ===========================================================================


class TestCypressTestLineSuppression:
    def test_passing_tests_suppressed_on_success(self) -> None:
        out = _cy(_TESTS_ALL_PASS, exit_code=0)
        assert f"    {_PASS_MARK} displays login form (234ms)" not in out

    def test_passing_tests_kept_on_nonzero_exit(self) -> None:
        # when the run fails, passing lines must be kept for context
        out = _cy(_TESTS_ALL_PASS, exit_code=1)
        assert f"    {_PASS_MARK} displays login form (234ms)" in out

    def test_failing_test_always_kept(self) -> None:
        out = _cy(_TESTS_WITH_FAILURE, exit_code=1)
        assert f"    {_FAIL_MARK} fails on network error (500ms)" in out

    def test_failing_test_kept_even_with_zero_exit(self) -> None:
        # ✗ lines kept regardless of exit code
        out = _cy(_TESTS_WITH_FAILURE, exit_code=0)
        assert f"    {_FAIL_MARK} fails on network error (500ms)" in out

    def test_pass_summary_kept(self) -> None:
        out = _cy(_TESTS_ALL_PASS, exit_code=0)
        assert "2 passing (1s)" in out

    def test_fail_summary_kept(self) -> None:
        out = _cy(_TESTS_WITH_FAILURE, exit_code=1)
        assert "1 failing" in out

    def test_describe_block_name_kept(self) -> None:
        out = _cy(_TESTS_ALL_PASS, exit_code=0)
        assert "Login Tests" in out

    def test_error_message_kept_on_failure(self) -> None:
        out = _cy(_TESTS_WITH_FAILURE, exit_code=1)
        assert "AssertionError: expected 500 to equal 200" in out

    def test_passing_test_with_error_in_name_kept(self) -> None:
        # pass line whose name contains "error" must survive due to error guard
        tricky = f"    {_PASS_MARK} handles error responses gracefully (100ms)\n"
        out = _cy(tricky, exit_code=0)
        assert "handles error responses gracefully" in out

    def test_pass_note_emitted_on_success(self) -> None:
        out = _cy(_TESTS_ALL_PASS, exit_code=0)
        assert "suppressed" in out
        assert "passing test lines" in out

    def test_no_pass_note_when_exit_nonzero(self) -> None:
        # on a failed run no passing lines are suppressed so no note
        out = _cy(_TESTS_ALL_PASS, exit_code=1)
        assert "passing test lines" not in out


# ===========================================================================
# CypressFilter — Run Finished summary always kept
# ===========================================================================


class TestCypressRunFinishedKept:
    def test_run_finished_label_kept(self) -> None:
        out = _cy(_RUN_FINISHED_BLOCK)
        assert "(Run Finished)" in out

    def test_all_specs_passed_kept(self) -> None:
        out = _cy(_FULL_SUCCESS_OUTPUT)
        assert "All specs passed!" in out

    def test_spec_row_kept(self) -> None:
        out = _cy(_RUN_FINISHED_BLOCK)
        assert "login.cy.ts" in out

    def test_summary_box_borders_kept(self) -> None:
        # box-drawing borders inside the Run Finished table must survive
        out = _cy(_RUN_FINISHED_BLOCK)
        assert "┌" in out

    def test_full_failure_error_details_kept(self) -> None:
        out = _cy(_FULL_FAILURE_OUTPUT, exit_code=1)
        assert "AssertionError: expected 500 to equal 200" in out
        assert "fails on network error" in out

    def test_savings_ratio_full_success(self) -> None:
        # full-success output must achieve >= 40% line reduction
        result_text = _cy(_FULL_SUCCESS_OUTPUT, exit_code=0)
        original_lines = _FULL_SUCCESS_OUTPUT.count("\n")
        result_lines = result_text.count("\n")
        ratio = 1.0 - result_lines / max(original_lines, 1)
        assert ratio >= 0.40, f"Savings {ratio:.0%} < 40%"

    def test_empty_input_no_crash(self) -> None:
        out = _cy("")
        assert isinstance(out, str)

    def test_stderr_merged(self) -> None:
        out = _cy("", stderr="CypressError: No tests found\n", exit_code=1)
        assert "CypressError" in out

    def test_truncated_box_emits_warning(self) -> None:
        # box opened but never closed
        out = _cy(
            "  (Run Starting)\n"
            + _BOX_TOP
            + _BOX_SIDE + " Cypress: 13.6.0 │\n"
            # no box bottom
        )
        lower = out.lower()
        assert "truncated" in lower or "warning" in lower
