from __future__ import annotations

import token_goat.bash_compress as bc
from tests.filter_test_helpers import apply_filter  # type: ignore[import]

_ARGV = ["pre-commit", "run", "--all-files"]


def _compress(stdout: str, *, exit_code: int = 0) -> str:
    return apply_filter(bc.PreCommitFilter(), stdout=stdout, stderr="", exit_code=exit_code, argv=_ARGV)


def test_passed_hooks_collapsed() -> None:
    # Multiple Passed result lines should collapse into a single sentinel.
    out = "\n".join([
        "check yaml.....Passed",
        "check json.....Passed",
        "check toml.....Passed",
        "All checks passed.",
    ])
    result = _compress(out)
    assert "collapsed 3 Passed, 0 Skipped hook(s)" in result
    assert "check yaml.....Passed" not in result
    assert "check json.....Passed" not in result
    assert "All checks passed." in result


def test_failed_hook_block_kept_verbatim() -> None:
    # A Failed hook line and its indented error block must be preserved exactly.
    out = "\n".join([
        "check yaml.....Passed",
        "flake8.....Failed",
        "- hook id: flake8",
        "- exit code: 1",
        "",
        "src/auth.py:10: E302 expected 2 blank lines, found 1",
    ])
    result = _compress(out, exit_code=1)
    assert "check yaml.....Passed" not in result
    assert "flake8.....Failed" in result
    assert "- hook id: flake8" in result
    assert "- exit code: 1" in result
    assert "src/auth.py:10: E302" in result


def test_info_lines_dropped() -> None:
    # [INFO] lifecycle lines after the first should be suppressed.
    out = "\n".join([
        "[INFO] Initializing environment for git",
        "[INFO] Installing environment for git",
        "[INFO] Restored environment from cache",
        "check yaml.....Passed",
        "All checks passed.",
    ])
    result = _compress(out)
    assert "[INFO] Installing environment for git" not in result
    assert "[INFO] Restored environment from cache" not in result


def test_info_count_in_sentinel() -> None:
    # The count of dropped INFO lines appears in the dropped-INFO sentinel.
    out = "\n".join([
        "[INFO] Initializing environment for git",
        "[INFO] Installing environment for git",
        "[INFO] Restored environment from cache",
        "check yaml.....Passed",
        "All checks passed.",
    ])
    result = _compress(out)
    assert "dropped 2 pre-commit [INFO] env-setup lines" in result


def test_first_info_always_kept() -> None:
    # The very first [INFO] line is always kept regardless of how many follow.
    out = "\n".join([
        "[INFO] Initializing environment for git",
        "[INFO] Installing environment for git",
        "[INFO] Cloning environment for git",
        "check yaml.....Passed",
        "All checks passed.",
    ])
    result = _compress(out)
    assert "[INFO] Initializing environment for git" in result
    assert "[INFO] Installing environment for git" not in result
    assert "[INFO] Cloning environment for git" not in result


def test_first_info_kept_on_run_failure() -> None:
    # The first INFO line is kept even when the run exits non-zero.
    out = "\n".join([
        "[INFO] Initializing environment for git",
        "[INFO] Installing environment for git",
        "flake8.....Failed",
        "- hook id: flake8",
        "",
        "src/main.py:1: E302",
    ])
    result = _compress(out, exit_code=1)
    assert "[INFO] Initializing environment for git" in result
    assert "dropped 1 pre-commit [INFO] env-setup lines" in result


def test_mixed_pass_and_fail() -> None:
    # Pass count before a failure is correct; fail block content is preserved.
    out = "\n".join([
        "check yaml.....Passed",
        "check json.....Passed",
        "flake8.....Failed",
        "- hook id: flake8",
        "- exit code: 1",
        "",
        "src/foo.py:1: E302",
    ])
    result = _compress(out, exit_code=1)
    assert "collapsed 2 Passed, 0 Skipped" in result
    assert "flake8.....Failed" in result
    assert "src/foo.py:1: E302" in result


def test_all_checks_passed_summary_preserved() -> None:
    # The final summary line is a non-result line and must always be kept.
    out = "\n".join([
        "check yaml.....Passed",
        "All checks passed.",
    ])
    result = _compress(out)
    assert "All checks passed." in result


def test_skipped_hooks_counted() -> None:
    # Skipped hooks go into the skipped counter and appear in the sentinel.
    out = "\n".join([
        "check yaml.....Passed",
        "check json.....(no files to check)Skipped",
        "check toml.....Passed",
        "All checks passed.",
    ])
    result = _compress(out)
    assert "collapsed 2 Passed, 1 Skipped hook(s)" in result
    assert "check json.....(no files to check)Skipped" not in result


def test_empty_output_no_crash() -> None:
    # Empty stdout must not raise and the result should be empty.
    result = _compress("")
    assert result == ""


def test_single_passing_hook() -> None:
    # A single Passed hook still produces the collapsed sentinel with count 1.
    out = "\n".join([
        "check yaml.....Passed",
        "All checks passed.",
    ])
    result = _compress(out)
    assert "collapsed 1 Passed, 0 Skipped hook(s)" in result


def test_multiple_failure_blocks() -> None:
    # Two separate failed hooks must each have their block kept in full.
    out = "\n".join([
        "check yaml.....Passed",
        "flake8.....Failed",
        "- hook id: flake8",
        "",
        "src/a.py:1: E302",
        "",
        "black.....Failed",
        "- hook id: black",
        "",
        "src/b.py: would reformat",
    ])
    result = _compress(out, exit_code=1)
    assert "check yaml.....Passed" not in result
    assert "flake8.....Failed" in result
    assert "black.....Failed" in result
    assert "src/a.py:1: E302" in result
    assert "src/b.py: would reformat" in result


def test_pass_count_resets_before_each_fail() -> None:
    # Pass counts reset at each failure; two independent sentinels are emitted.
    out = "\n".join([
        "check yaml.....Passed",
        "check json.....Passed",
        "flake8.....Failed",
        "- hook id: flake8",
        "",
        "check toml.....Passed",
        "black.....Failed",
        "- hook id: black",
    ])
    result = _compress(out, exit_code=1)
    assert "collapsed 2 Passed, 0 Skipped" in result
    assert "collapsed 1 Passed, 0 Skipped" in result


def test_diff_content_in_fail_block_kept() -> None:
    # Unified diff content inside a fail block must be preserved verbatim.
    out = "\n".join([
        "isort.....Failed",
        "- hook id: isort",
        "- exit code: 1",
        "",
        "--- a/src/main.py",
        "+++ b/src/main.py",
        "@@ -1,3 +1,3 @@",
        "+import os",
        " import sys",
        "-import os",
    ])
    result = _compress(out, exit_code=1)
    assert "+import os" in result
    assert "-import os" in result
    assert "--- a/src/main.py" in result


def test_no_info_no_dropped_sentinel() -> None:
    # When no [INFO] lines are present, no info-dropped sentinel should appear.
    out = "\n".join([
        "check yaml.....Passed",
        "check json.....Passed",
        "All checks passed.",
    ])
    result = _compress(out)
    assert "dropped" not in result
    assert "[INFO]" not in result


def test_hook_name_preserved_in_failed_line() -> None:
    # The hook name in the Failed result line must be visible in output.
    out = "\n".join([
        "my-special-linter.....Failed",
        "- hook id: my-special-linter",
        "",
        "some error",
    ])
    result = _compress(out, exit_code=1)
    assert "my-special-linter.....Failed" in result


def test_large_pass_run() -> None:
    # Thirty-five passing hooks should produce exactly one compact sentinel.
    lines = [f"hook-{i:02d}.....Passed" for i in range(35)]
    lines.append("All checks passed.")
    out = "\n".join(lines)
    result = _compress(out)
    assert "collapsed 35 Passed, 0 Skipped hook(s)" in result
    assert result.count("[token-goat:") == 1
    for i in range(35):
        assert f"hook-{i:02d}.....Passed" not in result


def test_exit_code_zero_all_passed_summary_kept() -> None:
    # With exit_code=0 the summary is preserved and no failure content leaks in.
    out = "\n".join([
        "check yaml.....Passed",
        "check json.....Passed",
        "All checks passed.",
    ])
    result = _compress(out, exit_code=0)
    assert "All checks passed." in result
    assert "Failed" not in result


def test_only_skipped_hooks_produce_sentinel() -> None:
    # When all hooks are skipped with no passes, the sentinel still fires.
    out = "\n".join([
        "check yaml.....(no files to check)Skipped",
        "check json.....(no files to check)Skipped",
        "All checks passed.",
    ])
    result = _compress(out)
    assert "collapsed 0 Passed, 2 Skipped hook(s)" in result


def test_pass_count_not_shared_across_calls() -> None:
    # State must not bleed between two independent calls.
    out = "check yaml.....Passed\nAll checks passed."
    r1 = _compress(out)
    r2 = _compress(out)
    assert "collapsed 1 Passed" in r1
    assert "collapsed 1 Passed" in r2
    assert "collapsed 2 Passed" not in r1
    assert "collapsed 2 Passed" not in r2


def test_non_hook_lines_always_kept() -> None:
    # Lines that match neither result-RE nor INFO-RE are always preserved.
    out = "\n".join([
        "An error occurred in the pre-commit runner.",
        "Traceback (most recent call last):",
        "  File 'run.py', line 42",
        "RuntimeError: hook config invalid",
    ])
    result = _compress(out, exit_code=1)
    assert "An error occurred in the pre-commit runner." in result
    assert "RuntimeError: hook config invalid" in result


def test_pre_commit_hook_failed_status_treated_as_failure() -> None:
    # Status "Pre-commit hook failed" (config error) triggers the failure path.
    out = "\n".join([
        "check yaml.....Passed",
        "bad-hook.....Pre-commit hook failed",
        "- hook id: bad-hook",
        "",
        "An unexpected error occurred",
    ])
    result = _compress(out, exit_code=1)
    assert "collapsed 1 Passed" in result
    assert "bad-hook.....Pre-commit hook failed" in result
    assert "An unexpected error occurred" in result

def test_failed_hook_no_error_output() -> None:
    # A hook that fails with no error lines; the Failed line is still kept.
    out = "\n".join([
        "check yaml.....Passed",
        "trailing-whitespace.....Failed",
        "All checks passed.",
    ])
    result = _compress(out, exit_code=1)
    assert "trailing-whitespace.....Failed" in result
    assert "check yaml.....Passed" not in result
