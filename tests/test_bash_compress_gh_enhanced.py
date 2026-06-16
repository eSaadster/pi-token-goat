from __future__ import annotations

import token_goat.bash_compress as bc

_F = bc.GhFilter()


def _run_view(stdout: str, *, exit_code: int = 0) -> str:
    return _F.compress(stdout, "", exit_code, ["gh", "run", "view", "1234"])


def _gh_list(stdout: str, subcommand: str) -> str:
    return _F.compress(stdout, "", 0, ["gh", subcommand, "list"])


def _other(stdout: str, subcommand: str = "api") -> str:
    return _F.compress(stdout, "", 0, ["gh", subcommand])


def _make_list_output(n_rows: int) -> str:
    header = "NUMBER  TITLE              BRANCH"
    rows = [f"{i}      PR title #{i}   feature/branch-{i}" for i in range(1, n_rows + 1)]
    return "\n".join([header] + rows)


# Dispatch
def test_filter_name_is_gh() -> None:
    assert bc.select_filter(["gh", "run", "view"]).name == "gh"


def test_gh_pr_view_passthrough() -> None:
    # gh pr without "list" action routes through _squeeze_blank_lines — no note emitted
    out = _other("Title: foo\nBody: bar", "pr")
    assert "Title: foo" in out
    assert "Body: bar" in out
    assert "[token-goat:" not in out


def test_gh_api_passthrough() -> None:
    # gh api routes through _squeeze_blank_lines — content passes through unchanged
    content = '{"id": 1, "name": "test"}'
    out = _other(content)
    assert content in out
    assert "[token-goat:" not in out


# _compress_gh_run_view — pass-step collapse
def test_pass_step_tick_removed() -> None:
    # ✓ line is dropped by the pass-step collector
    out = _run_view("✓ Set up job\nJob succeeded")
    assert "✓ Set up job" not in out


def test_pass_step_count_in_note() -> None:
    # three ✓ lines produce a count note
    out = _run_view("✓ Step 1\n✓ Step 2\n✓ Step 3\nJob succeeded")
    assert "collapsed 3 passing step headers" in out


def test_pass_indented_children_dropped() -> None:
    # indented child line after ✓ is dropped as action-preamble noise
    out = _run_view("✓ Set up job\n  Run actions/checkout@v4\nJob succeeded")
    assert "Run actions/checkout@v4" not in out


def test_preamble_drop_count_in_note() -> None:
    # two indented lines after ✓ produce a dropped-preamble count note
    out = _run_view("✓ Set up job\n  Run actions/checkout@v4\n  Run actions/setup-python@v4\nJob succeeded")
    assert "dropped 2 action-preamble lines" in out


def test_non_indented_line_not_dropped_in_pass_block() -> None:
    # a non-indented line closes the pass block and is kept verbatim
    out = _run_view("✓ Set up job\nNon-indented content\nMore content")
    assert "Non-indented content" in out


def test_sqrt_symbol_triggers_pass_collapse() -> None:
    # √ (U+221A SQUARE ROOT) also matches the pass-step regex
    out = _run_view("√ Build\nJob succeeded")
    assert "√ Build" not in out
    assert "collapsed 1 passing step headers" in out


def test_empty_run_view_no_crash() -> None:
    assert _run_view("") == ""


def test_all_passing_produces_note_only() -> None:
    # when every line is a ✓ step, output is just the collapsed-count note
    lines = "\n".join(f"✓ Step {i}" for i in range(1, 6))
    out = _run_view(lines)
    assert "collapsed 5 passing step headers" in out
    assert "✓" not in out


# _compress_gh_run_view — fail-step preservation
def test_fail_step_cross_kept() -> None:
    # ✗ line is kept verbatim (fail-step path)
    out = _run_view("✗ Run linters\nJob failed")
    assert "✗ Run linters" in out


def test_fail_block_indented_children_kept() -> None:
    # indented lines after a ✗ step are kept because in_pass_block is False
    out = _run_view("✗ Run linters\n  Process completed with exit code 1.\n  ##[error]linter failed")
    assert "Process completed with exit code 1." in out
    assert "##[error]linter failed" in out


def test_failed_prefix_triggers_fail_path() -> None:
    # FAILED: matches ^\s*FAIL(:|ED|URE)\b — line kept
    out = _run_view("FAILED: something went wrong")
    assert "FAILED: something went wrong" in out


def test_failure_prefix_triggers_fail_path() -> None:
    # FAILURE: matches ^\s*FAIL(:|ED|URE)\b — line kept
    out = _run_view("FAILURE: something went wrong")
    assert "FAILURE: something went wrong" in out


def test_error_prefix_triggers_fail_path() -> None:
    # Error: matches ^\s*Error:\s — line kept
    out = _run_view("Error: something went wrong")
    assert "Error: something went wrong" in out


def test_pass_then_fail_mix() -> None:
    # ✓ block collapsed (with note), ✗ line and its indented children kept
    out = _run_view("\n".join([
        "✓ Set up job",
        "  Run actions/checkout@v4",
        "✗ Run linters",
        "  Process completed with exit code 1.",
        "Job failed",
    ]))
    assert "collapsed 1 passing step headers" in out
    assert "✗ Run linters" in out
    assert "Process completed with exit code 1." in out
    assert "✓ Set up job" not in out


# _compress_gh_list — truncation
def test_list_30_rows_passthrough() -> None:
    # exactly 30 data rows stays below the threshold — no truncation note
    out = _gh_list(_make_list_output(30), "pr")
    assert "showing first" not in out


def test_list_31_rows_truncated() -> None:
    # 31 data rows exceeds 30 — truncation note with exact counts
    out = _gh_list(_make_list_output(31), "pr")
    assert "showing first 30 of 31 prs" in out


def test_list_header_preserved_after_truncation() -> None:
    # header row survives even when data rows are truncated
    out = _gh_list(_make_list_output(31), "pr")
    assert "NUMBER  TITLE              BRANCH" in out


def test_list_31st_row_absent() -> None:
    # the 31st data row is cut off by the 30-row cap
    out = _gh_list(_make_list_output(31), "pr")
    assert "PR title #31" not in out


def test_list_subcommand_name_in_note() -> None:
    # note pluralises the subcommand name — "runs" for "run", "issues" for "issue"
    run_out = _gh_list(_make_list_output(31), "run")
    assert "31 runs" in run_out
    issue_out = _gh_list(_make_list_output(31), "issue")
    assert "issues" in issue_out

