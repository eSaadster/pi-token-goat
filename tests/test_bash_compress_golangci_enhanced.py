"""Enhanced tests for GolangciLintFilter — per-(file,linter) dedup, noise suppression, placeholders."""
from __future__ import annotations

from tests.filter_test_helpers import apply_filter, savings_ratio
from token_goat import bash_compress as bc

_F = bc.GolangciLintFilter()
_ARGV = ["golangci-lint", "run", "./..."]


def _apply(stdout: str, stderr: str = "", exit_code: int = 0) -> str:
    return apply_filter(_F, stdout=stdout, stderr=stderr, exit_code=exit_code, argv=_ARGV)


# ---------------------------------------------------------------------------
# Dispatch / match
# ---------------------------------------------------------------------------


def test_matches_direct_run() -> None:
    assert _F.matches(["golangci-lint", "run", "./..."])


def test_matches_bare_binary() -> None:
    assert _F.matches(["golangci-lint"])


def test_matches_exe_extension() -> None:
    assert _F.matches(["golangci-lint.exe", "run", "./..."])


def test_matches_npx_invocation() -> None:
    assert _F.matches(["npx", "golangci-lint", "run", "./..."])


def test_matches_pnpx_invocation() -> None:
    assert _F.matches(["pnpx", "golangci-lint", "run"])


def test_no_match_go_vet() -> None:
    assert not _F.matches(["go", "vet", "./..."])


def test_no_match_revive() -> None:
    assert not _F.matches(["revive", "./..."])


def test_no_match_empty_argv() -> None:
    assert not _F.matches([])


def test_dispatch_routes_to_golangci() -> None:
    f = bc.select_filter(["golangci-lint", "run", "./..."])
    assert f is not None and f.name == "golangci-lint"


def test_dispatch_routes_bare_golangci() -> None:
    f = bc.select_filter(["golangci-lint"])
    assert f is not None and f.name == "golangci-lint"


def test_golangci_in_all_exports() -> None:
    assert "GolangciLintFilter" in bc.__all__


# ---------------------------------------------------------------------------
# Noise suppression
# ---------------------------------------------------------------------------

_NOISE_BLOCK = """\
golangci-lint version 1.57.2 built from ...
time=2026-05-31T10:00:00Z level=info msg="Running linters"
time=2026-05-31T10:00:00Z level=debug msg="Starting linter: unused"
time=2026-05-31T10:00:01Z level=info msg="Finishing linting"
"""


def test_version_line_dropped() -> None:
    out = _apply(_NOISE_BLOCK)
    assert "golangci-lint version" not in out


def test_info_log_lines_dropped() -> None:
    out = _apply(_NOISE_BLOCK)
    assert "level=info" not in out


def test_debug_log_lines_dropped() -> None:
    out = _apply(_NOISE_BLOCK)
    assert "level=debug" not in out


def test_noise_drop_note_emitted() -> None:
    out = _apply(_NOISE_BLOCK)
    # Four noise lines; token-goat should emit a drop note.
    assert "token-goat" in out


# ---------------------------------------------------------------------------
# Signal preservation
# ---------------------------------------------------------------------------

_SIGNAL_BLOCK = """\
time=2026-05-31T10:00:00Z level=info msg="Running linters"
ERRO [loader] could not load package: pkg/missing
WARN [runner] linter timeout: revive
pkg/util/util.go:8:3: exported function Baz without comment (revive)
Run with --fix to fix some of the issues
Found 3 issues.
"""


def test_erro_line_kept() -> None:
    out = _apply(_SIGNAL_BLOCK)
    assert "ERRO [loader]" in out


def test_warn_line_kept() -> None:
    out = _apply(_SIGNAL_BLOCK)
    assert "WARN [runner]" in out


def test_issue_line_kept() -> None:
    out = _apply(_SIGNAL_BLOCK)
    assert "pkg/util/util.go:8:3" in out


def test_run_with_fix_summary_kept() -> None:
    out = _apply(_SIGNAL_BLOCK)
    assert "Run with --fix" in out


def test_found_n_issues_summary_kept() -> None:
    out = _apply(_SIGNAL_BLOCK)
    assert "Found 3 issues." in out


def test_error_exit_stderr_preserved() -> None:
    stderr = "golangci-lint: fatal: could not parse config\n"
    out = apply_filter(_F, stdout="", stderr=stderr, exit_code=1, argv=_ARGV)
    assert "fatal" in out


# ---------------------------------------------------------------------------
# Per-(file, linter) deduplication — boundary cases
# ---------------------------------------------------------------------------

def _make_issues(n: int, file: str = "pkg/big/big.go", linter: str = "unused") -> str:
    return "\n".join(
        f"{file}:{i}:1: variable `x{i}` is unused ({linter})"
        for i in range(1, n + 1)
    )


def test_exactly_keep_first_n_issues_all_kept() -> None:
    # _KEEP_FIRST_N = 3; exactly 3 issues → all kept, no placeholder.
    out = _apply(_make_issues(3))
    assert "pkg/big/big.go:1:1" in out
    assert "pkg/big/big.go:2:1" in out
    assert "pkg/big/big.go:3:1" in out
    assert "omitted" not in out
    assert "__placeholder__" not in out


def test_one_over_keep_first_n_emits_placeholder() -> None:
    # 4 issues: first 3 kept, 4th triggers placeholder.
    out = _apply(_make_issues(4))
    assert "pkg/big/big.go:1:1" in out
    assert "pkg/big/big.go:2:1" in out
    assert "pkg/big/big.go:3:1" in out
    assert "pkg/big/big.go:4:1" not in out
    assert "omitted" in out


def test_placeholder_count_is_accurate() -> None:
    # 7 issues, keep 3 → 4 omitted; collapse note says "4" somewhere.
    out = _apply(_make_issues(7))
    assert "4" in out
    assert "omitted" in out or "collapsed" in out


def test_placeholder_names_linter() -> None:
    out = _apply(_make_issues(5, linter="errcheck"))
    assert "errcheck" in out


def test_placeholder_names_file() -> None:
    out = _apply(_make_issues(5, file="internal/server/server.go"))
    assert "internal/server/server.go" in out


def test_max_issues_boundary_exactly_10_no_collapse() -> None:
    # _MAX_ISSUES_PER_FILE_LINTER = 10; exactly 10 issues → 7 beyond _KEEP_FIRST_N=3.
    out = _apply(_make_issues(10))
    assert "7" in out
    assert "omitted" in out or "collapsed" in out


def test_issues_beyond_max_all_omitted_in_placeholder() -> None:
    # 20 issues → first 3 kept, remainder noted in collapse message.
    out = _apply(_make_issues(20))
    assert "pkg/big/big.go:1:1" in out
    assert "pkg/big/big.go:4:1" not in out
    assert "collapsed" in out or "omitted" in out


def test_raw_placeholder_string_never_in_output() -> None:
    # The internal __placeholder__ sentinel must never leak.
    out = _apply(_make_issues(10))
    assert "__placeholder__" not in out


# ---------------------------------------------------------------------------
# Multiple (file, linter) groups — independence
# ---------------------------------------------------------------------------

_MULTI_GROUP = """\
pkg/a/a.go:1:1: unused var (unused)
pkg/a/a.go:2:1: unused var (unused)
pkg/a/a.go:3:1: unused var (unused)
pkg/a/a.go:4:1: unused var (unused)
pkg/b/b.go:1:1: error return not checked (errcheck)
pkg/b/b.go:2:1: error return not checked (errcheck)
pkg/b/b.go:3:1: error return not checked (errcheck)
pkg/b/b.go:4:1: error return not checked (errcheck)
"""


def test_two_groups_each_get_independent_placeholder() -> None:
    out = _apply(_MULTI_GROUP)
    # Both groups collapse → two placeholder notes.
    assert "pkg/a/a.go" in out
    assert "pkg/b/b.go" in out
    assert "unused" in out
    assert "errcheck" in out


def test_same_file_different_linters_tracked_independently() -> None:
    # Same file, two linters; each group has its own counter.
    issues = "\n".join(
        f"pkg/x/x.go:{i}:1: msg ({linter})"
        for linter in ("unused", "errcheck")
        for i in range(1, 5)
    )
    out = _apply(issues)
    assert "unused" in out
    assert "errcheck" in out


def test_same_linter_different_files_tracked_independently() -> None:
    # Same linter, two files; each file gets its own counter.
    issues = "\n".join(
        f"pkg/{pkg}/f.go:{i}:1: msg (unused)"
        for pkg in ("alpha", "beta")
        for i in range(1, 5)
    )
    out = _apply(issues)
    assert "alpha/f.go" in out
    assert "beta/f.go" in out


# ---------------------------------------------------------------------------
# Collapse note wording
# ---------------------------------------------------------------------------


def test_collapse_note_mentions_collapsed_count() -> None:
    out = _apply(_make_issues(15))
    assert "collapsed" in out or "omitted" in out


def test_collapse_note_mentions_linter() -> None:
    out = _apply(_make_issues(10, linter="staticcheck"))
    assert "staticcheck" in out


# ---------------------------------------------------------------------------
# Empty and edge-case inputs
# ---------------------------------------------------------------------------


def test_empty_stdout_no_crash() -> None:
    out = _apply("")
    assert isinstance(out, str)


def test_empty_stdout_empty_stderr_no_crash() -> None:
    out = apply_filter(_F, stdout="", stderr="", exit_code=0, argv=_ARGV)
    assert isinstance(out, str)


def test_single_issue_kept_verbatim() -> None:
    line = "cmd/main.go:10:3: exported type Foo without comment (revive)\n"
    out = _apply(line)
    assert "cmd/main.go:10:3" in out


def test_non_go_looking_lines_pass_through() -> None:
    # Lines that don't match the issue regex should pass through unchanged.
    misc = "Configuration loaded from .golangci.yml\nRunning 5 linters in parallel\n"
    out = _apply(misc)
    assert "Configuration loaded" in out


def test_issues_summary_line_is_preserved() -> None:
    body = _make_issues(2) + "\nFound 2 issues.\n"
    out = _apply(body)
    assert "Found 2 issues." in out


# ---------------------------------------------------------------------------
# Savings ratio
# ---------------------------------------------------------------------------


def test_significant_savings_on_100_same_file_issues() -> None:
    out_big = _make_issues(100)
    ratio = savings_ratio(_F, stdout=out_big, argv=_ARGV)
    assert ratio >= 0.70, f"Expected >= 70% savings, got {ratio:.0%}"


def test_no_savings_on_clean_noise_free_output() -> None:
    # A single issue with no noise → savings should be near zero.
    line = "cmd/main.go:10:3: exported type Foo without comment (revive)\n"
    ratio = savings_ratio(_F, stdout=line, argv=_ARGV)
    assert ratio < 0.30, f"Expected near-zero savings on trivial input, got {ratio:.0%}"
