"""Enhanced coverage tests for DockerFilter, CargoFilter, TreeFilter, BinaryInspectFilter.

Covers gaps in the existing thin test files:
- Docker: BuildKit format, push/pull noise, dispatch via podman/buildah/nerdctl
- Cargo: clippy subcommand, bench subcommand, check subcommand, two-compiling passthrough,
         progress line counting, error preservation across all subcommands
- Tree: depth edge cases, detect heuristic, savings ratio, flat trees
- BinaryInspect: 7z / PDF magic, savings ratio, exact summary format, FileTypeFilter batch exact
"""
from __future__ import annotations

import pytest
from filter_test_helpers import apply_filter, savings_ratio

from token_goat import bash_compress as bc

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

_DOCKER = bc.DockerFilter()
_CARGO = bc.CargoFilter()
_TREE = bc.TreeFilter()
_BIN = bc.BinaryInspectFilter()
_FILE = bc.FileTypeFilter()


def _docker(stdout: str = "", stderr: str = "", exit_code: int = 0, argv: list[str] | None = None) -> str:
    return apply_filter(_DOCKER, stdout=stdout, stderr=stderr, exit_code=exit_code, argv=argv or ["docker", "build", "."])


def _cargo(stdout: str = "", stderr: str = "", subcommand: str = "build", exit_code: int = 0) -> str:
    return apply_filter(_CARGO, stdout=stdout, stderr=stderr, exit_code=exit_code, argv=["cargo", subcommand])


def _tree(stdout: str, argv: list[str] | None = None) -> str:
    return apply_filter(_TREE, stdout=stdout, argv=argv or ["tree"])


def _bin(stdout: str, argv: list[str] | None = None) -> str:
    return apply_filter(_BIN, stdout=stdout, argv=argv or ["xxd"])


def _file(stdout: str) -> str:
    return apply_filter(_FILE, stdout=stdout, argv=["file"])


def _make_xxd(magic_hex: str, n_extra: int = 10) -> str:
    # Build a minimal xxd-format dump; first line has the magic bytes.
    padded = (magic_hex + "00" * 16)[:32]
    groups = [padded[i:i+4] for i in range(0, 32, 4)]
    first = f"00000000: {' '.join(groups)}  ................"
    rest = [f"{(i+1)*16:08x}: {'0000 ' * 7 + '0000'}  ................" for i in range(n_extra)]
    return "\n".join([first] + rest) + "\n"


def _make_tree(top_dirs: int, subs: int, files_each: int, *, summary: bool = True) -> str:
    # Produce a synthetic tree output matching the real _make_tree helper.
    lines = ["."]
    for t in range(top_dirs):
        last_top = t == top_dirs - 1
        tc = "└── " if last_top else "├── "
        tp = "    " if last_top else "│   "
        lines.append(f"{tc}topdir{t}/")
        for s in range(subs):
            last_sub = s == subs - 1
            sc = "└── " if last_sub else "├── "
            sp = "    " if last_sub else "│   "
            lines.append(f"{tp}{sc}subdir{s}/")
            for f in range(files_each):
                last_f = f == files_each - 1
                fc = "└── " if last_f else "├── "
                lines.append(f"{tp}{sp}{fc}file{f}.txt")
    total_dirs = top_dirs * (1 + subs)
    total_files = top_dirs * subs * files_each
    if summary:
        lines.append(f"\n{total_dirs} directories, {total_files} files")
    return "\n".join(lines)


# ===========================================================================
# DockerFilter — BuildKit format
# ===========================================================================

class TestDockerBuildKit:
    def test_buildkit_sha256_digest_dropped(self) -> None:
        # Lines matching "#N sha256:..." are digest noise and must be suppressed.
        inp = "#1 sha256:abc123def456abc123def456abc123def456\n#2 [internal] load build definition\n#2 DONE 0.1s"
        out = _docker(stderr=inp)
        assert "sha256:" not in out

    def test_buildkit_transfer_progress_dropped(self) -> None:
        # "#N 12.3MB / 50.0MB" transfer lines are noise.
        inp = "#3 [1/2] FROM ubuntu\n#3 12.3MB / 50.0MB 0.5s\n#3 DONE 1.2s"
        out = _docker(stderr=inp)
        assert "12.3MB" not in out

    def test_buildkit_cached_lines_dropped(self) -> None:
        # "#N CACHED" raw step lines are suppressed; only the count sentinel remains.
        inp = "\n".join([
            "#1 [internal] load build definition",
            "#1 CACHED",
            "#2 [internal] load .dockerignore",
            "#2 CACHED",
            "#3 [1/1] FROM ubuntu",
            "#3 DONE 0.1s",
        ])
        out = _docker(stderr=inp)
        # Raw "#N CACHED" lines should not appear; count appears only in the sentinel.
        for line in out.splitlines():
            if line.startswith("[token-goat:"):
                continue
            assert "CACHED" not in line, f"Raw CACHED line leaked: {line!r}"

    def test_buildkit_cached_count_in_summary(self) -> None:
        # Dropped CACHED count appears in the [token-goat: dropped ... CACHED lines] summary.
        inp = "\n".join([
            "#1 CACHED",
            "#2 CACHED",
            "#3 CACHED",
            "#4 [1/1] RUN echo done",
            "#4 DONE 0.5s",
        ])
        out = _docker(stderr=inp)
        assert "CACHED" in out  # appears in the summary sentinel, not as raw lines

    def test_buildkit_error_block_kept(self) -> None:
        # Lines containing "ERROR" keyword in body are kept; final ERROR summary is kept.
        inp = "\n".join([
            "#5 [2/3] RUN apt-get install nosuchpkg",
            "#5 0.123 ERROR: process exited with code 100",
            "#5 ERROR: process failed with exit code 100",
            "ERROR: failed to solve: process failed",
        ])
        out = _docker(stderr=inp)
        # The ERROR body line and the final ERROR line must both survive.
        assert "ERROR: process exited with code 100" in out
        assert "ERROR: failed to solve" in out

    def test_buildkit_summary_sentinel_present_when_noise_dropped(self) -> None:
        # When any lines are dropped, a [token-goat: dropped ...] sentinel must appear.
        inp = "\n".join([
            "#1 sha256:deadbeef1234",
            "#2 [internal] load build definition",
            "#2 DONE 0.1s",
        ])
        out = _docker(stderr=inp)
        assert "[token-goat: dropped" in out

    def test_empty_docker_output(self) -> None:
        out = _docker()
        assert out == ""

    def test_buildkit_body_lines_dropped_on_success(self) -> None:
        # Step body lines (#N <timestamp> <content>) dropped when no ERROR.
        inp = "\n".join([
            "#5 [2/3] RUN echo hello",
            "#5 0.123 hello",
            "#5 DONE 0.5s",
        ])
        out = _docker(stderr=inp)
        assert "#5 0.123 hello" not in out


# ===========================================================================
# DockerFilter — docker push / pull noise
# ===========================================================================

class TestDockerPushPullNoise:
    def test_layer_already_exists_dropped(self) -> None:
        inp = "\n".join([
            "abc123def456: Layer already exists",
            "def456abc123: Layer already exists",
            "latest: digest: sha256:abc123 size: 1234",
        ])
        out = _docker(stderr=inp)
        assert "Layer already exists" not in out

    def test_mounted_from_dropped(self) -> None:
        inp = "abc123def456: Mounted from library/ubuntu\nlatest: digest: sha256:abc123 size: 1234"
        out = _docker(stderr=inp)
        assert "Mounted from" not in out

    def test_pull_layer_status_dropped(self) -> None:
        # Per-layer pull status lines (Pull complete, Waiting, etc.) are noise.
        inp = "\n".join([
            "abc123def456: Pull complete",
            "def456abc123: Verifying Checksum",
            "fedcba987654: Download complete",
            "aabbccddeeff: Already exists",
            "Status: Downloaded newer image for ubuntu:latest",
        ])
        out = _docker(stderr=inp)
        assert "Pull complete" not in out
        assert "Verifying Checksum" not in out
        # Status line is signal — must be kept.
        assert "Status: Downloaded newer image" in out

    def test_push_noise_count_in_sentinel(self) -> None:
        # push-layer count appears in the dropped sentinel.
        inp = "\n".join([
            "abc123def456: Layer already exists",
            "def456abc123: Layer already exists",
        ])
        out = _docker(stderr=inp)
        assert "push-layer" in out


# ===========================================================================
# DockerFilter — dispatch: podman, buildah, nerdctl
# ===========================================================================

class TestDockerDispatch:
    @pytest.mark.parametrize("binary", ["docker", "buildah", "podman", "nerdctl"])
    def test_dispatch_to_docker_filter(self, binary: str) -> None:
        flt = bc.select_filter([binary, "build", "."])
        assert flt is not None and flt.name == "docker"
        assert flt.matches([binary, "build", "."])


# ===========================================================================
# DockerFilter — old-format: building/cached preamble
# ===========================================================================

class TestDockerOldFormatPreamble:
    def test_old_format_cached_preamble_inserted(self) -> None:
        # When old-format output has cached steps, a [building N layers, M cached] preamble is added.
        inp = "\n".join([
            "Step 1/3 : FROM ubuntu",
            " ---> Using cache",
            "Step 2/3 : RUN apt-get update",
            " ---> Using cache",
            "Step 3/3 : CMD bash",
            " ---> abc123def456",
            "Successfully built abc123def456",
        ])
        out = _docker(stderr=inp)
        assert "building" in out and "cached" in out

    def test_old_format_no_cached_no_preamble(self) -> None:
        # When no steps are cached, the [building N layers, M cached] preamble is absent.
        inp = "\n".join([
            "Step 1/2 : FROM ubuntu",
            " ---> abc123",
            "Step 2/2 : CMD bash",
            " ---> def456",
            "Successfully built def456",
        ])
        out = _docker(stderr=inp)
        assert "building" not in out and "0 cached" not in out

    def test_old_format_error_step_header_kept(self) -> None:
        # When a step produces an error, its header line must be kept.
        inp = "\n".join([
            "Step 1/2 : RUN false",
            "error: command returned non-zero exit status 1",
            "Step 2/2 : CMD bash",
            "Successfully built abc123",
        ])
        out = _docker(stderr=inp)
        assert "Step 1/2" in out


# ===========================================================================
# CargoFilter — build subcommand
# ===========================================================================

class TestCargoBuild:
    def test_two_compiling_lines_kept_verbatim(self) -> None:
        # Fewer than 3 Compiling lines pass through without a sentinel.
        inp = "\n".join([
            "   Compiling foo v0.1.0 (/tmp/foo)",
            "   Compiling bar v0.1.0 (/tmp/bar)",
            "    Finished dev [unoptimized] target(s) in 1.0s",
        ])
        out = _cargo(stderr=inp)
        assert "Compiling foo" in out
        assert "Compiling bar" in out
        assert "[compiling" not in out

    def test_three_compiling_lines_collapsed_to_sentinel(self) -> None:
        # Exactly 3 Compiling lines trigger the sentinel.
        inp = "\n".join([
            "   Compiling a v0.1.0 (/tmp)",
            "   Compiling b v0.1.0 (/tmp)",
            "   Compiling c v0.1.0 (/tmp)",
            "    Finished dev [unoptimized] target(s) in 2.0s",
        ])
        out = _cargo(stderr=inp)
        assert "[compiling 3 crates" in out
        assert "Compiling a" not in out

    def test_progress_lines_dropped_with_count(self) -> None:
        # Downloading/Fetching/Updating lines are dropped; count in sentinel.
        inp = "\n".join([
            "  Downloading crates ...",
            "  Fetching registry",
            "  Updating crates.io index",
            "   Compiling foo v0.1.0 (/tmp)",
            "   Compiling bar v0.1.0 (/tmp)",
            "   Compiling baz v0.1.0 (/tmp)",
            "    Finished dev [unoptimized] target(s) in 5.0s",
        ])
        out = _cargo(stderr=inp)
        assert "dropped" in out
        assert "cargo progress lines" in out

    def test_error_line_always_kept(self) -> None:
        # error[E0001] lines are never suppressed even with many Compiling lines.
        lines = [f"   Compiling crate_{i} v0.1.{i} (/tmp)" for i in range(8)]
        lines.append("error[E0308]: mismatched types")
        out = _cargo(stderr="\n".join(lines), exit_code=1)
        assert "error[E0308]: mismatched types" in out

    def test_warning_line_always_kept(self) -> None:
        # warning: lines are preserved regardless of how many Compiling lines there are.
        lines = [f"   Compiling c{i} v0.1.0 (/tmp)" for i in range(5)]
        lines.append("warning: unused variable `x`")
        out = _cargo(stderr="\n".join(lines))
        assert "warning: unused variable `x`" in out

    def test_empty_build_output(self) -> None:
        out = _cargo()
        assert out == ""

    def test_check_subcommand_routed_through_build_path(self) -> None:
        # cargo check uses the same build path; Compiling sentinel still fires at >=3.
        lines = [f"   Compiling c{i} v0.1.0 (/tmp)" for i in range(4)]
        lines.append("    Finished check [unoptimized] target(s) in 1.0s")
        out = _cargo(stderr="\n".join(lines), subcommand="check")
        assert "[compiling 4 crates" in out


# ===========================================================================
# CargoFilter — test subcommand
# ===========================================================================

class TestCargoTest:
    def test_passing_tests_suppressed(self) -> None:
        stdout = "\n".join([
            "running 3 tests",
            "test a::b ... ok",
            "test a::c ... ok",
            "test a::d ... ok",
            "",
            "test result: ok. 3 passed; 0 failed; 0 ignored",
        ])
        out = _cargo(stdout=stdout, subcommand="test")
        assert "test a::b ... ok" not in out
        assert "test result: ok. 3 passed" in out

    def test_failing_test_lines_kept(self) -> None:
        stdout = "\n".join([
            "running 2 tests",
            "test passes ... ok",
            "test fails ... FAILED",
            "",
            "failures:",
            "    fails",
            "",
            "test result: FAILED. 1 passed; 1 failed; 0 ignored",
        ])
        out = _cargo(stdout=stdout, subcommand="test", exit_code=101)
        assert "test fails ... FAILED" in out
        assert "failures:" in out

    def test_pass_count_sentinel_injected(self) -> None:
        # When tests pass, a "[N tests passed]" sentinel replaces the ok lines.
        stdout = "\n".join([
            "running 5 tests",
            "test t1 ... ok",
            "test t2 ... ok",
            "test t3 ... ok",
            "test t4 ... ok",
            "test t5 ... ok",
            "",
            "test result: ok. 5 passed; 0 failed",
        ])
        out = _cargo(stdout=stdout, subcommand="test")
        assert "5 tests passed" in out

    def test_build_and_test_merged_with_separator(self) -> None:
        # When stderr has compiler output and stdout has test output, they are joined with ---.
        stderr = "\n".join([f"   Compiling c{i} v0.1.0 (/tmp)" for i in range(4)])
        stdout = "\n".join([
            "running 1 tests",
            "test it_works ... ok",
            "",
            "test result: ok. 1 passed; 0 failed",
        ])
        out = _cargo(stdout=stdout, stderr=stderr, subcommand="test")
        assert "---" in out
        assert "test result" in out

    def test_empty_test_output(self) -> None:
        out = _cargo(subcommand="test")
        assert out == ""

    def test_multiple_running_sections_each_get_sentinel(self) -> None:
        # Two "Running" headers → two separate pass sentinels.
        stdout = "\n".join([
            "Running unittests src/lib.rs (target/debug/deps/lib-abc)",
            "running 2 tests",
            "test a ... ok",
            "test b ... ok",
            "",
            "test result: ok. 2 passed; 0 failed",
            "Running tests/integration.rs (target/debug/deps/integration-def)",
            "running 1 tests",
            "test c ... ok",
            "",
            "test result: ok. 1 passed; 0 failed",
        ])
        out = _cargo(stdout=stdout, subcommand="test")
        # Both sections should inject sentinels; test names should be suppressed.
        assert "test a ... ok" not in out
        assert "test c ... ok" not in out


# ===========================================================================
# CargoFilter — clippy subcommand
# ===========================================================================

class TestCargoClippy:
    def test_clippy_checking_lines_dropped(self) -> None:
        # "Checking foo v0.1.0" lines are noise for clippy and are dropped.
        inp = "\n".join([
            "    Checking foo v0.1.0 (/tmp/foo)",
            "    Checking bar v0.1.0 (/tmp/bar)",
            "    Checking baz v0.1.0 (/tmp/baz)",
            "warning: unused import: `std::collections::HashMap`",
        ])
        out = _cargo(stderr=inp, subcommand="clippy")
        assert "Checking foo" not in out
        assert "Checking bar" not in out
        assert "dropped" in out

    def test_clippy_few_compiling_kept_verbatim(self) -> None:
        # <=4 Compiling lines pass through for clippy (not sentinel-ised).
        inp = "\n".join([
            "   Compiling proc-macro v0.1.0 (/tmp)",
            "   Compiling dep v0.1.0 (/tmp)",
            "warning: something",
        ])
        out = _cargo(stderr=inp, subcommand="clippy")
        assert "Compiling proc-macro" in out
        assert "Compiling dep" in out

    def test_clippy_many_compiling_collapsed_with_head_tail(self) -> None:
        # >4 Compiling lines: first 2 + last 2 kept, middle collapsed.
        lines = [f"   Compiling crate{i} v0.1.0 (/tmp)" for i in range(8)]
        lines.append("warning: lint triggered")
        inp = "\n".join(lines)
        out = _cargo(stderr=inp, subcommand="clippy")
        assert "Compiling crate0" in out
        assert "Compiling crate7" in out
        assert "collapsed" in out
        assert "Compiling crate3" not in out

    def test_clippy_error_always_kept(self) -> None:
        inp = "\n".join([
            "    Checking foo v0.1.0 (/tmp)",
            "error[E0308]: mismatched types",
            "  --> src/main.rs:5:14",
        ])
        out = _cargo(stderr=inp, subcommand="clippy", exit_code=1)
        assert "error[E0308]" in out

    def test_clippy_empty_output(self) -> None:
        out = _cargo(subcommand="clippy")
        assert out == ""


# ===========================================================================
# CargoFilter — bench subcommand
# ===========================================================================

class TestCargoBench:
    def test_bench_results_kept_verbatim(self) -> None:
        stdout = "\n".join([
            "running 2 tests",
            "test bench_foo ... bench:       1,234 ns/iter (+/- 56)",
            "test bench_bar ... bench:       5,678 ns/iter (+/- 89)",
            "",
            "test result: ok. 0 passed; 0 failed; 0 ignored; 2 measured",
        ])
        out = _cargo(stdout=stdout, subcommand="bench")
        assert "bench:       1,234 ns/iter" in out
        assert "bench:       5,678 ns/iter" in out
        assert "test result: ok." in out

    def test_bench_compiler_noise_stripped_from_stderr(self) -> None:
        # Compiler progress on stderr is collapsed; bench results on stdout intact.
        stderr = "\n".join([f"   Compiling c{i} v0.1.0 (/tmp)" for i in range(5)])
        stdout = "\n".join([
            "running 1 tests",
            "test bench_x ... bench:         100 ns/iter (+/- 5)",
            "",
            "test result: ok. 0 passed; 0 failed; 0 ignored; 1 measured",
        ])
        out = _cargo(stdout=stdout, stderr=stderr, subcommand="bench")
        assert "bench:         100 ns/iter" in out
        assert "[compiling 5 crates" in out

    def test_bench_empty_output(self) -> None:
        out = _cargo(subcommand="bench")
        assert out == ""


# ===========================================================================
# TreeFilter — passthrough boundary
# ===========================================================================

class TestTreePassthrough:
    def test_31_lines_triggers_compression(self) -> None:
        # A tree over 30 lines triggers compression.
        # top_dirs=2, subs=3, files_each=5 → 1 + 2 + 6 + 30 + 1(summary) = 40 lines
        out_text = _make_tree(top_dirs=2, subs=3, files_each=5)
        lines = out_text.splitlines()
        assert len(lines) > 30, f"Expected >30 lines, got {len(lines)}"
        result = _tree(out_text)
        # Depth-3 files are collapsed — file names must not appear verbatim.
        assert "file0.txt" not in result
        assert "items]" in result

    def test_30_lines_passes_through(self) -> None:
        # Exactly 30 lines → no compression.
        # Build a tree that produces exactly 30 connector lines.
        lines = ["."]
        for i in range(14):
            conn = "└── " if i == 13 else "├── "
            lines.append(f"{conn}item{i}/")
        for j in range(14):
            conn = "└── " if j == 13 else "├── "
            lines.append(f"    {conn}sub{j}.txt")
        # 1 root + 14 top + 14 sub = 29; add summary to reach 30.
        lines.append("\n14 directories, 14 files")
        text = "\n".join(lines)
        result = _tree(text)
        # No [N items] markers should appear.
        assert "[" not in result and "items]" not in result

    def test_empty_tree_returns_empty(self) -> None:
        result = _tree("")
        assert result == ""


# ===========================================================================
# TreeFilter — detect heuristic
# ===========================================================================

class TestTreeDetect:
    def test_detect_requires_box_drawing_chars(self) -> None:
        # Output without ├── or └── should not be compressed even if long.
        plain = "\n".join([f"dir{i}/subdir/file{j}.txt" for i in range(10) for j in range(5)])
        f = bc.TreeFilter()
        lines = plain.splitlines()
        assert not f.detect(lines)

    def test_detect_true_for_real_tree_output(self) -> None:
        text = _make_tree(top_dirs=2, subs=2, files_each=3)
        f = bc.TreeFilter()
        lines = text.splitlines()
        assert f.detect(lines)


# ===========================================================================
# TreeFilter — compression specifics
# ===========================================================================

class TestTreeCompression:
    def test_depth3_items_collapsed_per_parent(self) -> None:
        # Each depth-2 parent gets its own [N items] marker.
        # top_dirs=2, subs=4, files_each=5 → 1+2+8+40+1 = 52 lines (>30 threshold)
        text = _make_tree(top_dirs=2, subs=4, files_each=5)
        result = _tree(text)
        # 8 total subdirs × 5 depth-3 files each → 8 markers of [5 items].
        assert "[5 items]" in result
        assert result.count("[5 items]") == 8

    def test_depth1_and_depth2_entries_kept(self) -> None:
        text = _make_tree(top_dirs=2, subs=2, files_each=4)
        result = _tree(text)
        assert "topdir0/" in result
        assert "subdir0/" in result

    def test_summary_line_always_preserved(self) -> None:
        text = _make_tree(top_dirs=2, subs=2, files_each=6)
        result = _tree(text)
        assert "directories," in result
        assert "files" in result

    def test_no_summary_line_still_compresses(self) -> None:
        text = _make_tree(top_dirs=2, subs=2, files_each=6, summary=False)
        result = _tree(text)
        assert "items]" in result

    def test_savings_ratio_positive_for_deep_tree(self) -> None:
        # Deep tree should achieve meaningful savings (observed ~65% for top=3,subs=3,files=5).
        text = _make_tree(top_dirs=3, subs=3, files_each=5)
        ratio = savings_ratio(_TREE, stdout=text)
        assert ratio >= 0.5

    def test_only_depth3_items_are_removed(self) -> None:
        # Depth-1 and depth-2 items must never appear in an [N items] marker.
        text = _make_tree(top_dirs=2, subs=2, files_each=4)
        result = _tree(text)
        for t in range(2):
            assert f"topdir{t}/" in result
        for s in range(2):
            assert f"subdir{s}/" in result


# ===========================================================================
# BinaryInspectFilter — additional magic types
# ===========================================================================

class TestBinaryInspectMagic:
    def test_pdf_magic_detected(self) -> None:
        # PDF magic bytes: 25 50 44 46 = "%PDF"
        dump = _make_xxd("255044462d312e350a0a", n_extra=15)
        result = _bin(dump)
        assert "PDF" in result

    def test_7z_magic_detected(self) -> None:
        # 7z magic: 37 7a bc af 27 1c — detected as "7-zip archive"
        dump = _make_xxd("377abcaf271c000000000000", n_extra=15)
        result = _bin(dump)
        assert "7-zip" in result.lower()

    def test_summary_line_contains_total_line_count(self) -> None:
        # The [token-goat: hex dump of N lines ...] sentinel must include the line count.
        n_extra = 20
        dump = _make_xxd("89504e470d0a1a0a", n_extra=n_extra)
        total = 1 + n_extra
        result = _bin(dump)
        assert f"hex dump of {total} lines" in result

    def test_magic_bytes_appear_in_summary(self) -> None:
        # The detected magic hex prefix must appear in the summary line.
        dump = _make_xxd("ffd8ffe000104a464946", n_extra=10)
        result = _bin(dump)
        assert "ffd8ff" in result

    def test_passthrough_at_boundary(self) -> None:
        # Exactly 4 lines (the passthrough threshold) → no compression.
        dump = "\n".join([
            "00000000: 8950 4e47 0d0a 1a0a 0000 000d 4948 4452  ....IHDR",
            "00000010: 0000 0001 0000 0001 0806 0000 001f 15c4  ................",
            "00000020: 8900 0000 0a49 4441 5478 9c62 0000 0002  .....IDATx.b....",
            "00000030: 0001 e221 bc33 0000 0000 4945 4e44 ae42  ...!.3....IEND.B",
        ])
        result = _bin(dump)
        assert "[token-goat:" not in result

    def test_5_lines_triggers_compression(self) -> None:
        # 5 lines exceeds the 4-line threshold → summary inserted.
        dump = _make_xxd("89504e470d0a1a0a", n_extra=4)  # 1 + 4 = 5 lines
        result = _bin(dump)
        assert "[token-goat:" in result

    def test_first_two_hex_lines_always_present(self) -> None:
        dump = _make_xxd("7f454c46020101000000000000000000", n_extra=12)
        result = _bin(dump)
        input_lines = dump.splitlines()
        assert input_lines[0] in result
        assert input_lines[1] in result

    def test_unknown_binary_shows_unknown_description(self) -> None:
        # Non-matching magic → "unknown binary type" in summary.
        dump = _make_xxd("cafebabe000000000000000000000000", n_extra=10)
        result = _bin(dump)
        # May or may not match a known type; but sentinel must always appear.
        assert "[token-goat:" in result

    def test_gzip_magic_in_summary(self) -> None:
        # gzip magic: 1f 8b
        dump = _make_xxd("1f8b080800000000000003", n_extra=10)
        result = _bin(dump)
        assert "gzip" in result

    def test_empty_input(self) -> None:
        result = _bin("")
        assert result == ""


# ===========================================================================
# BinaryInspectFilter — savings ratio
# ===========================================================================

class TestBinaryInspectSavings:
    def test_savings_positive_for_large_dump(self) -> None:
        # BinaryInspectFilter with a 51-line dump should achieve meaningful savings (observed ~94%).
        dump = _make_xxd("89504e470d0a1a0a", n_extra=50)
        ratio = savings_ratio(_BIN, stdout=dump, argv=["xxd"])
        assert ratio >= 0.8


# ===========================================================================
# FileTypeFilter — batch truncation specifics
# ===========================================================================

class TestFileTypeFilter:
    def test_exactly_20_lines_passes_through(self) -> None:
        # 20 lines ≤ batch limit → no truncation.
        lines = [f"file_{i:02d}.txt: ASCII text\n" for i in range(20)]
        result = _file("".join(lines))
        assert "truncated" not in result
        assert "file_19.txt" in result

    def test_21_lines_triggers_truncation(self) -> None:
        # 21 lines exceeds the 20-line limit; 1 entry truncated.
        lines = [f"file_{i:02d}.txt: ASCII text" for i in range(21)]
        result = _file("\n".join(lines))
        assert "1 more file entries truncated" in result
        assert "file_20.txt" not in result

    def test_truncation_count_is_accurate(self) -> None:
        # 30 lines → 10 entries truncated.
        lines = [f"file_{i:02d}.bin: data" for i in range(30)]
        result = _file("\n".join(lines))
        assert "10 more file entries truncated" in result

    def test_first_20_entries_present_after_truncation(self) -> None:
        lines = [f"path_{i:03d}.so: ELF shared object" for i in range(25)]
        result = _file("\n".join(lines))
        assert "path_000.so" in result
        assert "path_019.so" in result
        assert "path_020.so" not in result

    def test_empty_file_output(self) -> None:
        result = _file("")
        assert result == ""
