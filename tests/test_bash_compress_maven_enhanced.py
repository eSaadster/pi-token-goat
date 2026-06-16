"""Enhanced MavenFilter tests covering compression behaviours not in the baseline suite.

Gap areas closed:
  - [INFO] separator lines (dashes) are dropped and counted in the boilerplate note
  - [INFO] boilerplate lines (Scanning, Building, plugin headers, compiler progress) dropped
  - [INFO] Reactor Build Order / Reactor Summary lines dropped
  - [WARNING] lines kept (in addition to [WARN])
  - Combined note is emitted when INFO boilerplate is dropped
  - Realistic multi-module build output compresses well
  - Compression ratio on large output
"""
from __future__ import annotations

from filter_test_helpers import FilterTestMixin
from filter_test_helpers import apply_filter as _apply

from token_goat import bash_compress as bc

# ---------------------------------------------------------------------------
# Shared fixture
# ---------------------------------------------------------------------------

F = bc.MavenFilter()


def _compress(stdout: str, stderr: str = "", exit_code: int = 0, subcmd: str = "test") -> str:
    return _apply(F, stdout=stdout, stderr=stderr, exit_code=exit_code, argv=["mvn", subcmd])


# ---------------------------------------------------------------------------
# Separator lines
# ---------------------------------------------------------------------------


_SEPARATOR_LINES = """\
[INFO] ------------------------------------------------------------------------
[INFO] Building my-app 1.0-SNAPSHOT
[INFO] ------------------------------------------------------------------------
[INFO] BUILD SUCCESS
[INFO] ------------------------------------------------------------------------
"""


class TestMavenSeparatorLines(FilterTestMixin):
    """[INFO] separator dash lines are dropped, not passed through."""

    F = bc.MavenFilter()

    def test_separator_lines_not_in_output(self) -> None:
        out = _compress(_SEPARATOR_LINES)
        assert "--------" not in out

    def test_build_success_kept_when_separators_dropped(self) -> None:
        out = _compress(_SEPARATOR_LINES)
        assert "BUILD SUCCESS" in out

    def test_boilerplate_note_emitted(self) -> None:
        out = _compress(_SEPARATOR_LINES)
        assert "[INFO] boilerplate/separator lines" in out

    def test_separator_count_in_note(self) -> None:
        out = _compress(_SEPARATOR_LINES)
        # 4 separator + 1 Building boilerplate = 5 noise lines; filter groups them as 4 collapsed
        assert "collapsed 4" in out


# ---------------------------------------------------------------------------
# INFO boilerplate lines
# ---------------------------------------------------------------------------


_BOILERPLATE_LINES = """\
[INFO] Scanning for projects...
[INFO] Building mylib 2.3.0
[INFO] --- maven-compiler-plugin:3.11.0:compile (default-compile) @ mylib ---
[INFO] skip non existing resourceDirectory /src/main/resources
[INFO] Compiling 12 source files to /target/classes
[INFO] No sources to compile
[INFO] Nothing to compile - all classes are up to date
[INFO] Changes detected - recompiling the module!
[INFO] BUILD SUCCESS
"""


class TestMavenBoilerplateLines(FilterTestMixin):
    """[INFO] boilerplate lines are dropped."""

    F = bc.MavenFilter()

    def test_scanning_dropped(self) -> None:
        out = _compress(_BOILERPLATE_LINES)
        assert "Scanning for projects" not in out

    def test_building_artifact_dropped(self) -> None:
        out = _compress(_BOILERPLATE_LINES)
        assert "Building mylib" not in out

    def test_plugin_header_dropped(self) -> None:
        out = _compress(_BOILERPLATE_LINES)
        assert "maven-compiler-plugin" not in out

    def test_skip_non_existing_dropped(self) -> None:
        out = _compress(_BOILERPLATE_LINES)
        assert "skip non existing" not in out

    def test_compiling_n_source_files_dropped(self) -> None:
        out = _compress(_BOILERPLATE_LINES)
        assert "Compiling 12 source files" not in out

    def test_no_sources_dropped(self) -> None:
        out = _compress(_BOILERPLATE_LINES)
        assert "No sources to compile" not in out

    def test_nothing_to_compile_dropped(self) -> None:
        out = _compress(_BOILERPLATE_LINES)
        assert "Nothing to compile" not in out

    def test_changes_detected_dropped(self) -> None:
        out = _compress(_BOILERPLATE_LINES)
        assert "Changes detected" not in out

    def test_build_success_still_kept(self) -> None:
        out = _compress(_BOILERPLATE_LINES)
        assert "BUILD SUCCESS" in out

    def test_boilerplate_note_emitted(self) -> None:
        out = _compress(_BOILERPLATE_LINES)
        assert "[INFO] boilerplate/separator lines" in out


# ---------------------------------------------------------------------------
# Reactor lines (multi-module build)
# ---------------------------------------------------------------------------


_REACTOR_LINES = """\
[INFO] Reactor Build Order:
[INFO]   module-a
[INFO]   module-b
[INFO]
[INFO] BUILD SUCCESS
[INFO] Reactor Summary for myproject 1.0:
[INFO] module-a ........ SUCCESS [  1.234 s]
[INFO] module-b ........ SUCCESS [  2.567 s]
"""


class TestMavenReactorLines(FilterTestMixin):
    """Reactor Build Order and Reactor Summary sections are dropped as noise."""

    F = bc.MavenFilter()

    def test_reactor_build_order_dropped(self) -> None:
        out = _compress(_REACTOR_LINES)
        assert "Reactor Build Order" not in out

    def test_reactor_summary_dropped(self) -> None:
        out = _compress(_REACTOR_LINES)
        assert "Reactor Summary" not in out

    def test_build_success_kept_with_reactor(self) -> None:
        out = _compress(_REACTOR_LINES)
        assert "BUILD SUCCESS" in out

    def test_note_emitted_for_reactor_drop(self) -> None:
        out = _compress(_REACTOR_LINES)
        assert "collapsed" in out


# ---------------------------------------------------------------------------
# [WARNING] lines kept (not only [WARN])
# ---------------------------------------------------------------------------


_WARNING_LINES = """\
[INFO] Scanning for projects...
[WARNING] The POM for com.example:foo:jar:1.0 is invalid
[WARNING] 'build.plugins.plugin.version' for org.apache.maven.plugins:maven-jar-plugin
[WARN] Using platform encoding (UTF-8 actually) to copy filtered resources
[INFO] BUILD SUCCESS
"""


class TestMavenWarningLines(FilterTestMixin):
    """Both [WARNING] and [WARN] lines are preserved verbatim."""

    F = bc.MavenFilter()

    def test_warning_prefix_kept(self) -> None:
        out = _compress(_WARNING_LINES)
        assert "The POM for com.example:foo:jar:1.0 is invalid" in out

    def test_second_warning_kept(self) -> None:
        out = _compress(_WARNING_LINES)
        assert "build.plugins.plugin.version" in out

    def test_warn_prefix_kept(self) -> None:
        out = _compress(_WARNING_LINES)
        assert "Using platform encoding" in out

    def test_scanning_noise_still_dropped(self) -> None:
        out = _compress(_WARNING_LINES)
        assert "Scanning for projects" not in out


# ---------------------------------------------------------------------------
# Realistic multi-module build (integration scenario)
# ---------------------------------------------------------------------------


_MULTIMODULE_BUILD = """\
[INFO] Scanning for projects...
[INFO] ------------------------------------------------------------------------
[INFO] Reactor Build Order:
[INFO]   core
[INFO]   api
[INFO]   app
[INFO] ------------------------------------------------------------------------
[INFO] Building core 1.0-SNAPSHOT
[INFO] ------------------------------------------------------------------------
[INFO] --- maven-resources-plugin:3.3.0:resources ---
[INFO] Downloading: https://repo1.maven.org/maven2/commons-lang3/3.12.0.jar
[INFO] Downloaded: https://repo1.maven.org/maven2/commons-lang3/3.12.0.jar
[INFO] --- maven-compiler-plugin:3.11.0:compile ---
[INFO] Compiling 42 source files to /core/target/classes
[INFO] --- maven-surefire-plugin:3.0.0:test ---
[INFO] Tests run: 18, Failures: 0, Errors: 0, Skipped: 0, Time elapsed: 1.23 s
[INFO] Building api 1.0-SNAPSHOT
[INFO] ------------------------------------------------------------------------
[INFO] Compiling 15 source files to /api/target/classes
[INFO] Tests run: 7, Failures: 0, Errors: 0, Skipped: 0, Time elapsed: 0.45 s
[INFO] Building app 1.0-SNAPSHOT
[INFO] ------------------------------------------------------------------------
[INFO] Tests run: 32, Failures: 0, Errors: 0, Skipped: 0, Time elapsed: 3.11 s
[INFO] ------------------------------------------------------------------------
[INFO] Reactor Summary for myproject 1.0:
[INFO] core ..... SUCCESS [  2.5 s]
[INFO] api ...... SUCCESS [  1.2 s]
[INFO] app ...... SUCCESS [  4.3 s]
[INFO] ------------------------------------------------------------------------
[INFO] BUILD SUCCESS
[INFO] ------------------------------------------------------------------------
"""


class TestMavenMultiModuleBuild(FilterTestMixin):
    """Realistic multi-module build compresses aggressively while keeping summaries."""

    F = bc.MavenFilter()

    def test_all_test_summaries_kept(self) -> None:
        out = _compress(_MULTIMODULE_BUILD)
        assert "Tests run: 18" in out
        assert "Tests run: 7" in out
        assert "Tests run: 32" in out

    def test_build_success_kept(self) -> None:
        out = _compress(_MULTIMODULE_BUILD)
        assert "BUILD SUCCESS" in out

    def test_separator_lines_removed(self) -> None:
        out = _compress(_MULTIMODULE_BUILD)
        assert "--------" not in out

    def test_download_lines_removed(self) -> None:
        out = _compress(_MULTIMODULE_BUILD)
        assert "Downloading:" not in out
        assert "Downloaded:" not in out

    def test_boilerplate_lines_removed(self) -> None:
        out = _compress(_MULTIMODULE_BUILD)
        assert "Scanning for projects" not in out
        assert "maven-compiler-plugin" not in out

    def test_reactor_lines_removed(self) -> None:
        out = _compress(_MULTIMODULE_BUILD)
        assert "Reactor Build Order" not in out
        assert "Reactor Summary" not in out

    def test_output_shorter_than_input(self) -> None:
        out = _compress(_MULTIMODULE_BUILD)
        assert len(out) < len(_MULTIMODULE_BUILD)

    def test_compression_note_emitted(self) -> None:
        out = _compress(_MULTIMODULE_BUILD)
        assert "[token-goat:" in out and "collapsed" in out


# ---------------------------------------------------------------------------
# Compression ratio
# ---------------------------------------------------------------------------


def _savings_ratio(stdout: str, subcmd: str = "test") -> float:
    out = _compress(stdout, subcmd=subcmd)
    if not stdout:
        return 0.0
    return 1.0 - len(out) / len(stdout)


class TestMavenCompressionRatio(FilterTestMixin):
    """MavenFilter achieves meaningful savings on realistic output."""

    F = bc.MavenFilter()

    def test_ratio_on_noisy_build(self) -> None:
        # Build output dominated by separators, boilerplate, and downloads.
        lines: list[str] = []
        for i in range(10):
            lines.append("[INFO] ------------------------------------------------------------------------")
            lines.append(f"[INFO] Building module-{i} 1.0-SNAPSHOT")
            lines.append("[INFO] --- maven-compiler-plugin:3.11.0:compile ---")
            lines.append(f"[INFO] Downloading: https://repo1.example.com/dep-{i}.jar")
            lines.append(f"[INFO] Downloaded: https://repo1.example.com/dep-{i}.jar")
            lines.append(f"[INFO] Tests run: {i + 1}, Failures: 0, Errors: 0, Skipped: 0")
        lines.append("[INFO] BUILD SUCCESS")
        text = "\n".join(lines)
        ratio = _savings_ratio(text)
        assert ratio >= 0.60, f"Expected >= 60% savings on noisy Maven build, got {ratio:.0%}"

    def test_ratio_on_separator_heavy_output(self) -> None:
        # Every other line is a separator — should compress heavily.
        lines: list[str] = []
        for i in range(30):
            lines.append("[INFO] ------------------------------------------------------------------------")
            lines.append(f"[INFO] --- some-plugin:goal @ module-{i} ---")
        lines.append("[INFO] BUILD SUCCESS")
        text = "\n".join(lines)
        ratio = _savings_ratio(text)
        assert ratio >= 0.90, f"Expected >= 90% savings on separator-heavy output, got {ratio:.0%}"
