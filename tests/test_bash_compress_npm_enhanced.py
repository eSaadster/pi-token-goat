"""Enhanced tests for NpmInstallFilter — warn collapse, verbose suppression, spinner suppression."""

from token_goat.bash_compress import NpmInstallFilter

_FILTER = NpmInstallFilter()


def _npm(stdout: str = "", stderr: str = "", argv: list[str] | None = None) -> str:
    if argv is None:
        argv = ["npm", "install"]
    return _FILTER.compress(stdout, stderr, 0, argv)


# ---------------------------------------------------------------------------
# General npm WARN (non-deprecated) collapse
# ---------------------------------------------------------------------------

class TestNpmWarnCollapse:
    """Non-deprecated npm WARN lines: keep first 3, collapse the rest."""

    def test_warn_optional_first_three_kept(self) -> None:
        lines = [
            "npm WARN optional SKIPPING OPTIONAL DEPENDENCY: fsevents@2.3.3",
            "npm WARN optional SKIPPING OPTIONAL DEPENDENCY: fsevents@1.2.9",
            "npm WARN optional SKIPPING OPTIONAL DEPENDENCY: bufferutil@4.0.7",
        ]
        out = _npm(stdout="\n".join(lines))
        for ln in lines:
            assert ln in out

    def test_warn_optional_fourth_suppressed(self) -> None:
        lines = [
            "npm WARN optional SKIPPING OPTIONAL DEPENDENCY: fsevents@2.3.3",
            "npm WARN optional SKIPPING OPTIONAL DEPENDENCY: fsevents@1.2.9",
            "npm WARN optional SKIPPING OPTIONAL DEPENDENCY: bufferutil@4.0.7",
            "npm WARN optional SKIPPING OPTIONAL DEPENDENCY: utf-8-validate@5.0.9",
            "npm WARN optional SKIPPING OPTIONAL DEPENDENCY: canvas@2.11.2",
        ]
        out = _npm(stdout="\n".join(lines))
        # First 3 kept, last 2 suppressed — note appears
        assert lines[0] in out
        assert lines[1] in out
        assert lines[2] in out
        assert "utf-8-validate" not in out
        assert "canvas" not in out
        assert "suppressed 2 additional npm warn lines" in out
        assert "showed first 3 of 5" in out

    def test_warn_notsup_collapsed(self) -> None:
        lines = [f"npm WARN notsup SKIPPING OPTIONAL DEPENDENCY: some-pkg@1.{i}" for i in range(10)]
        out = _npm(stdout="\n".join(lines))
        assert "suppressed 7 additional npm warn lines" in out

    def test_warn_case_insensitive(self) -> None:
        # npm emits "npm warn" (lowercase) on modern versions
        lines = [f"npm warn EBADPLATFORM something-{i}" for i in range(5)]
        out = _npm(stdout="\n".join(lines))
        assert "suppressed 2 additional npm warn lines" in out

    def test_warn_deprecated_unaffected_by_warn_counter(self) -> None:
        # deprecated warns use their own counter; general warns count separately
        deprecated = [f"npm warn deprecated old-pkg@1.{i}: use new-pkg" for i in range(5)]
        general = [f"npm WARN optional SKIPPING OPTIONAL DEPENDENCY: p@{i}" for i in range(5)]
        out = _npm(stdout="\n".join(deprecated + general))
        # deprecated: first 3 shown, 2 suppressed
        assert "showed first 3 of 5" in out
        # general warns: first 3 shown, 2 suppressed
        assert "suppressed 2 additional npm warn lines" in out

    def test_warn_three_exactly_no_note(self) -> None:
        lines = [
            "npm WARN optional SKIPPING OPTIONAL DEPENDENCY: a@1.0.0",
            "npm WARN optional SKIPPING OPTIONAL DEPENDENCY: b@1.0.0",
            "npm WARN optional SKIPPING OPTIONAL DEPENDENCY: c@1.0.0",
        ]
        out = _npm(stdout="\n".join(lines))
        assert "additional npm warn" not in out
        assert lines[0] in out


# ---------------------------------------------------------------------------
# npm verbose/debug line suppression
# ---------------------------------------------------------------------------

class TestNpmVerboseSuppression:
    """npm timing / sill / http lines are suppressed entirely."""

    def test_timing_suppressed(self) -> None:
        out = _npm(stdout="npm timing reifyNode Completed in 47ms\nadded 5 packages in 1s")
        assert "timing" not in out
        assert "added 5 packages" in out

    def test_sill_suppressed(self) -> None:
        out = _npm(stdout="npm sill idealTree buildDeps\nadded 5 packages in 1s")
        assert "sill" not in out
        assert "added 5 packages" in out

    def test_http_fetch_suppressed(self) -> None:
        out = _npm(stdout="npm http fetch GET 200 https://registry.npmjs.org/lodash\nadded 1 package")
        assert "http fetch" not in out
        assert "added 1 package" in out

    def test_http_request_suppressed(self) -> None:
        out = _npm(stdout="npm http request GET https://registry.npmjs.org/express\nadded 1 package")
        assert "http request" not in out

    def test_http_finish_suppressed(self) -> None:
        out = _npm(stdout="npm http finish GET 200 https://registry.npmjs.org/lodash\nadded 1 package")
        assert "http finish" not in out

    def test_verb_suppressed(self) -> None:
        out = _npm(stdout="npm verb fetch packed 'lodash@4.17.21'\nadded 1 package")
        assert "npm verb fetch" not in out

    def test_multiple_verbose_lines_note(self) -> None:
        lines = [
            "npm timing reifyNode Completed in 47ms",
            "npm sill idealTree buildDeps",
            "npm http fetch GET 200 https://registry.npmjs.org/lodash",
            "npm http request GET https://registry.npmjs.org/express",
            "added 5 packages in 1s",
        ]
        out = _npm(stdout="\n".join(lines))
        assert "suppressed 4 verbose/progress lines" in out
        assert "added 5 packages" in out

    def test_verbose_case_insensitive(self) -> None:
        out = _npm(stdout="NPM TIMING reifyNode Completed in 47ms\nadded 1 package")
        assert "TIMING" not in out


# ---------------------------------------------------------------------------
# npm spinner / reify progress line suppression
# ---------------------------------------------------------------------------

class TestNpmSpinnerSuppression:
    """Lines starting with braille spinner chars are suppressed."""

    def test_spinner_reify_suppressed(self) -> None:
        out = _npm(stdout="⠸ reify:lodash: timing reifyNode Completed in 47ms\nadded 1 package")
        assert "reify:lodash" not in out
        assert "added 1 package" in out

    def test_various_spinners_suppressed(self) -> None:
        spinners = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"]
        for sp in spinners:
            line = f"{sp} reify:express: some progress"
            out = _npm(stdout=f"{line}\nadded 1 package")
            assert "reify:express" not in out, f"spinner {sp!r} not suppressed"

    def test_spinner_counts_as_verbose_for_note(self) -> None:
        lines = [f"⠸ reify:pkg-{i}: timing reifyNode Completed" for i in range(3)]
        lines.append("added 10 packages in 2s")
        out = _npm(stdout="\n".join(lines))
        assert "suppressed 3 verbose/progress lines" in out

    def test_spinner_without_space_not_suppressed(self) -> None:
        # Only lines where spinner is followed by a space are suppressed
        out = _npm(stdout="⠸reify:lodash: timing stuff\nadded 1 package")
        assert "⠸reify" in out


# ---------------------------------------------------------------------------
# Summary lines always kept
# ---------------------------------------------------------------------------

class TestNpmSummaryKept:
    """Summary lines (added/removed/changed) are always kept."""

    def test_added_packages_kept(self) -> None:
        out = _npm(stdout="added 847 packages, and audited 848 packages in 34s")
        assert "added 847 packages" in out

    def test_removed_packages_kept(self) -> None:
        out = _npm(stdout="removed 5 packages, and audited 843 packages in 10s")
        assert "removed 5 packages" in out

    def test_changed_packages_kept(self) -> None:
        out = _npm(stdout="changed 3 packages, and audited 848 packages in 12s")
        assert "changed 3 packages" in out

    def test_summary_survives_warn_noise(self) -> None:
        lines = (
            [f"npm WARN optional SKIPPING OPTIONAL DEPENDENCY: pkg-{i}" for i in range(10)]
            + ["added 200 packages in 5s"]
        )
        out = _npm(stdout="\n".join(lines))
        assert "added 200 packages" in out
        assert "suppressed 7 additional npm warn lines" in out


# ---------------------------------------------------------------------------
# Error lines always kept (regression guard)
# ---------------------------------------------------------------------------

class TestNpmErrorLinesKept:
    """Error lines survive all compression passes."""

    def test_npm_err_kept_through_verbose_noise(self) -> None:
        lines = [
            "npm timing reifyNode Completed in 47ms",
            "npm ERR! code ENOTFOUND",
            "npm ERR! errno ENOTFOUND",
            "added 0 packages",
        ]
        out = _npm(stdout="\n".join(lines))
        assert "npm ERR! code ENOTFOUND" in out
        assert "npm ERR! errno ENOTFOUND" in out

    def test_npm_err_kept_through_warn_noise(self) -> None:
        lines = (
            [f"npm WARN optional SKIPPING: pkg-{i}" for i in range(10)]
            + ["npm ERR! peer dep issue"]
        )
        out = _npm(stdout="\n".join(lines))
        assert "npm ERR! peer dep issue" in out
