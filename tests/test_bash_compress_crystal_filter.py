"""Tests for CrystalFilter (crystal spec / shards output compression)."""
from __future__ import annotations

from filter_test_helpers import FilterTestMixin

import token_goat.bash_compress as bc
from token_goat.bash_compress import select_filter

# ---------------------------------------------------------------------------
# Shared helper
# ---------------------------------------------------------------------------


def _compress(
    stdout: str = "",
    stderr: str = "",
    exit_code: int = 0,
    argv: list[str] | None = None,
) -> str:
    f = bc.CrystalFilter()
    if argv is None:
        argv = ["crystal", "spec"]
    return f.apply(stdout, stderr, exit_code, argv).text


# ---------------------------------------------------------------------------
# Fixture data
# ---------------------------------------------------------------------------

_SPEC_SUCCESS = """\
Compiling src/myapp.cr (crystal)
Compiling src/myapp/server.cr (crystal)
Linking crystal spec ./spec/spec
....
  MyApp
    ✓ starts the server (2ms)
    ✓ handles requests (1ms)
    ✓ shuts down cleanly (0ms)
  MyApp::Server
    ✓ accepts connections (5ms)
    ✓ rejects bad requests (1ms)

Finished in 1.23 seconds
10 examples, 0 failures
"""

_SPEC_WITH_FAILURE = """\
Compiling src/myapp.cr (crystal)
Linking crystal spec ./spec/spec
....
  MyApp
    ✓ starts the server (2ms)
    ✗ fails on bad input (1ms)

Failures:

  1) MyApp fails on bad input
     Expected: 200
       Actual: 500

3 examples, 1 failures
Finished in 0.50 seconds
"""

_SHARDS_INSTALL = """\
Resolving dependencies
Fetching https://github.com/crystal-lang/crystal-db.git
Using crystal-db (0.13.1)
Installing crystal-db (0.13.1)
Writing shard.lock
Shards are up to date
"""

_LARGE_SPEC = (
    "Compiling src/app.cr (crystal)\n"
    "Linking crystal spec ./spec/spec\n"
    + ("....\n" * 50)
    + "".join(f"  ✓ test case {i} (1ms)\n" for i in range(200))
    + "\nFinished in 3.21 seconds\n200 examples, 0 failures\n"
)


# ---------------------------------------------------------------------------
# Main test class
# ---------------------------------------------------------------------------


class TestCrystalFilter(FilterTestMixin):
    F = bc.CrystalFilter()

    # --- matches -------------------------------------------------------------

    def test_matches_crystal_spec(self) -> None:
        assert self.F.matches(["crystal", "spec"])

    def test_matches_crystal_binary_alone(self) -> None:
        assert self.F.matches(["crystal"])

    def test_matches_shards(self) -> None:
        assert self.F.matches(["shards"])

    def test_matches_shards_install(self) -> None:
        assert self.F.matches(["shards", "install"])

    def test_matches_shards_update(self) -> None:
        assert self.F.matches(["shards", "update"])

    def test_no_match_mix(self) -> None:
        assert not self.F.matches(["mix", "test"])

    def test_no_match_ruby(self) -> None:
        assert not self.F.matches(["ruby", "spec"])

    def test_no_match_rspec(self) -> None:
        assert not self.F.matches(["rspec"])

    # --- select_filter -------------------------------------------------------

    def test_select_crystal_spec(self) -> None:
        assert isinstance(select_filter(["crystal", "spec"]), bc.CrystalFilter)

    def test_select_shards(self) -> None:
        assert isinstance(select_filter(["shards", "install"]), bc.CrystalFilter)

    # --- compilation lines collapsed ----------------------------------------

    def test_compilation_lines_collapsed(self) -> None:
        out = _compress(_SPEC_SUCCESS)
        assert "collapsed" in out and "compilation" in out

    def test_compiling_src_not_verbatim(self) -> None:
        out = _compress(_SPEC_SUCCESS)
        assert "Compiling src/myapp.cr" not in out

    def test_linking_line_not_verbatim(self) -> None:
        out = _compress(_SPEC_SUCCESS)
        assert "Linking crystal spec" not in out

    # --- dot-only progress lines dropped ------------------------------------

    def test_dot_progress_lines_dropped(self) -> None:
        out = _compress(_SPEC_SUCCESS)
        assert "dropped" in out and "dot-progress" in out

    def test_dot_line_not_verbatim(self) -> None:
        stdout = "....\n....\n10 examples, 0 failures\n"
        out = _compress(stdout)
        assert "...." not in out

    # --- passing spec lines collapsed ----------------------------------------

    def test_passing_spec_lines_collapsed(self) -> None:
        out = _compress(_SPEC_SUCCESS)
        assert "collapsed" in out and "passing Crystal spec" in out

    def test_individual_pass_line_not_verbatim(self) -> None:
        out = _compress(_SPEC_SUCCESS)
        assert "✓ starts the server" not in out
        assert "✓ handles requests" not in out

    # --- spec summary kept --------------------------------------------------

    def test_finished_in_line_kept(self) -> None:
        out = _compress(_SPEC_SUCCESS)
        assert "Finished in 1.23 seconds" in out

    def test_examples_summary_kept(self) -> None:
        out = _compress(_SPEC_SUCCESS)
        assert "10 examples, 0 failures" in out

    # --- failures kept verbatim ---------------------------------------------

    def test_failure_header_kept(self) -> None:
        out = _compress(_SPEC_WITH_FAILURE)
        assert "Failures:" in out

    def test_failure_detail_kept(self) -> None:
        out = _compress(_SPEC_WITH_FAILURE)
        assert "Expected: 200" in out
        assert "Actual: 500" in out

    def test_failure_summary_kept(self) -> None:
        out = _compress(_SPEC_WITH_FAILURE)
        assert "3 examples, 1 failures" in out

    # --- error lines kept ---------------------------------------------------

    def test_error_line_always_kept(self) -> None:
        stdout = "Compiling src/app.cr (crystal)\nError: undefined method 'foo'\n"
        out = _compress(stdout)
        assert "undefined method 'foo'" in out

    # --- shards progress collapsed ------------------------------------------

    def test_shards_progress_lines_collapsed(self) -> None:
        out = _compress(_SHARDS_INSTALL, argv=["shards", "install"])
        assert "shard dependency action" in out

    def test_fetching_line_not_verbatim(self) -> None:
        out = _compress(_SHARDS_INSTALL, argv=["shards", "install"])
        assert "Fetching https://" not in out

    def test_using_line_not_verbatim(self) -> None:
        out = _compress(_SHARDS_INSTALL, argv=["shards", "install"])
        assert "Using crystal-db" not in out

    # --- shards final summary kept ------------------------------------------

    def test_shards_done_line_kept(self) -> None:
        out = _compress(_SHARDS_INSTALL, argv=["shards", "install"])
        assert "Shards are up to date" in out

    # --- error passthrough on non-zero exit ---------------------------------

    def test_error_passthrough_nonzero(self) -> None:
        stderr = "Error in /src/app.cr:5: undefined constant Foo"
        out = _compress(stdout="", stderr=stderr, exit_code=1)
        assert stderr in out

    def test_error_passthrough_compiling_not_suppressed(self) -> None:
        stdout = "Compiling src/app.cr (crystal)\n"
        stderr = "Error in /src/app.cr:5: undefined constant Foo"
        out = _compress(stdout=stdout, stderr=stderr, exit_code=1)
        assert stderr in out

    # --- short output passthrough (no compression for tiny output) ----------

    def test_short_output_passthrough(self) -> None:
        short = "10 examples, 0 failures\nFinished in 0.01 seconds\n"
        out = _compress(short)
        assert "10 examples, 0 failures" in out
        assert "Finished in 0.01 seconds" in out

    # --- compression ratio --------------------------------------------------

    def test_large_output_compresses_significantly(self) -> None:
        out = _compress(_LARGE_SPEC)
        ratio = len(out) / len(_LARGE_SPEC)
        assert ratio < 0.25, f"Expected <25% of original size, got {ratio:.1%}"
