"""Tests for DockerFilter old-format (non-BuildKit) compression passes."""
from __future__ import annotations

from token_goat.bash_compress import DockerFilter


def _compress(inp: str, argv: list[str] | None = None) -> str:
    return DockerFilter().compress(inp, "", 0, argv or ["docker", "build", "."])


# ---------------------------------------------------------------------------
# Cache / ID line suppression
# ---------------------------------------------------------------------------

class TestCacheLineSuppression:
    def test_using_cache_removed_from_output(self) -> None:
        inp = "\n".join([
            "Step 1/3 : FROM python:3.12",
            " ---> Using cache",
            "Step 2/3 : COPY . /app",
            " ---> Using cache",
            "Step 3/3 : CMD python app.py",
            " ---> def456abc789",
            "Successfully built def456abc789",
        ])
        out = _compress(inp)
        assert "---> Using cache" not in out
        assert "Using cache" not in out

    def test_multiple_cache_lines_all_removed(self) -> None:
        inp = "\n".join([
            "Step 1/4 : FROM ubuntu:22.04",
            " ---> Using cache",
            "Step 2/4 : RUN apt-get update",
            " ---> Using cache",
            "Step 3/4 : RUN apt-get install -y curl",
            " ---> Using cache",
            "Step 4/4 : CMD bash",
            " ---> 111aaa222bbb",
            "Successfully built 111aaa222bbb",
        ])
        out = _compress(inp)
        assert "Using cache" not in out

    def test_sha256_id_line_removed(self) -> None:
        inp = "\n".join([
            "Step 1/2 : FROM node:20",
            " ---> sha256:aabbccddeeff00112233445566778899aabbccdd",
            "Step 2/2 : CMD node server.js",
            "Successfully built aabbccddeeff001",
        ])
        out = _compress(inp)
        assert "sha256:" not in out

    def test_sha256_short_hash_removed(self) -> None:
        inp = "\n".join([
            "Step 1/1 : FROM alpine",
            " ---> sha256:deadbeefcafe1234",
            "Successfully built deadbeefcafe",
        ])
        out = _compress(inp)
        assert "sha256:" not in out

    def test_cache_count_reflected_in_preamble(self) -> None:
        # 2 cache hits → preamble should say "2 cached"
        inp = "\n".join([
            "Step 1/3 : FROM ubuntu",
            " ---> Using cache",
            "Step 2/3 : RUN echo hello",
            " ---> Using cache",
            "Step 3/3 : CMD bash",
            " ---> 99aabb",
            "Successfully built 99aabb",
        ])
        out = _compress(inp)
        assert "2 cached" in out

    def test_cache_count_exact_in_preamble(self) -> None:
        # 3-step build, 3 cached → preamble: [building 3 layers, 3 cached]
        inp = "\n".join([
            "Step 1/3 : FROM python:3.12",
            " ---> Using cache",
            "Step 2/3 : COPY requirements.txt /",
            " ---> Using cache",
            "Step 3/3 : RUN pip install -r /requirements.txt",
            " ---> Using cache",
            "Successfully built abcdef123456",
        ])
        out = _compress(inp)
        assert "[building 3 layers, 3 cached]" in out


# ---------------------------------------------------------------------------
# Removing intermediate container suppression
# ---------------------------------------------------------------------------

class TestIntermediateContainerSuppression:
    def test_removing_intermediate_container_removed(self) -> None:
        inp = "\n".join([
            "Step 1/2 : RUN apt-get update",
            " ---> Running in a1b2c3d4e5f6",
            "Removing intermediate container a1b2c3d4e5f6",
            " ---> f6e5d4c3b2a1",
            "Step 2/2 : CMD bash",
            "Successfully built f6e5d4c3b2a1",
        ])
        out = _compress(inp)
        assert "Removing intermediate container" not in out

    def test_multiple_intermediate_containers_removed(self) -> None:
        inp = "\n".join([
            "Step 1/3 : RUN apt-get update",
            "Removing intermediate container aaa111",
            "Step 2/3 : RUN apt-get install curl",
            "Removing intermediate container bbb222",
            "Step 3/3 : CMD bash",
            "Successfully built ccc333",
        ])
        out = _compress(inp)
        assert "Removing intermediate container" not in out


# ---------------------------------------------------------------------------
# Step header suppression for clean steps
# ---------------------------------------------------------------------------

class TestStepHeaderSuppression:
    def test_clean_step_header_suppressed(self) -> None:
        inp = "\n".join([
            "Step 1/3 : FROM ubuntu",
            " ---> Using cache",
            "Step 2/3 : RUN echo ok",
            " ---> abc111",
            "Step 3/3 : CMD bash",
            " ---> def222",
            "Successfully built def222",
        ])
        out = _compress(inp)
        assert "Step 1/3" not in out
        assert "Step 2/3" not in out
        assert "Step 3/3" not in out

    def test_step_with_error_content_keeps_error_text(self) -> None:
        # Error content is kept even though the step header itself may be dropped
        inp = "\n".join([
            "Step 1/2 : RUN pip install nonexistent-pkg",
            "ERROR: Could not find a version that satisfies the requirement nonexistent-pkg",
            "Step 2/2 : CMD python app.py",
            "Successfully built abc123",
        ])
        out = _compress(inp)
        assert "Could not find a version" in out
        assert "Step 1/2" in out

    def test_clean_build_all_step_headers_dropped(self) -> None:
        # Pure cache hit build: all step headers dropped, only preamble + success kept
        inp = "\n".join([
            "Step 1/2 : FROM alpine",
            " ---> Using cache",
            "Step 2/2 : CMD sh",
            " ---> Using cache",
            "Successfully built xyz789",
        ])
        out = _compress(inp)
        assert "Step 1/2" not in out
        assert "Step 2/2" not in out
        assert "Successfully built" in out


# ---------------------------------------------------------------------------
# Successfully built always kept
# ---------------------------------------------------------------------------

class TestSuccessfullyBuiltAlwaysKept:
    def test_success_line_present_after_all_suppression(self) -> None:
        inp = "\n".join([
            "Step 1/1 : FROM scratch",
            " ---> Using cache",
            " ---> sha256:000111222333444555666777888999aaabbb",
            "Removing intermediate container 000111222",
            "Successfully built 000111222333",
        ])
        out = _compress(inp)
        assert "Successfully built 000111222333" in out

    def test_success_line_present_with_short_id(self) -> None:
        inp = "\n".join([
            "Step 1/1 : FROM ubuntu",
            " ---> abc123def456",
            "Successfully built abc123def456",
        ])
        out = _compress(inp)
        assert "Successfully built abc123def456" in out


# ---------------------------------------------------------------------------
# Preamble format
# ---------------------------------------------------------------------------

class TestBuildingPreamble:
    def test_preamble_format_layer_and_cached_counts(self) -> None:
        inp = "\n".join([
            "Step 1/4 : FROM python:3.11",
            " ---> Using cache",
            "Step 2/4 : WORKDIR /app",
            " ---> Using cache",
            "Step 3/4 : COPY . .",
            " ---> 1a2b3c",
            "Step 4/4 : CMD python main.py",
            " ---> 4d5e6f",
            "Successfully built 4d5e6f",
        ])
        out = _compress(inp)
        assert "[building 4 layers, 2 cached]" in out

    def test_no_preamble_when_no_cache_hits(self) -> None:
        # When there are no cache hits the preamble is not emitted
        inp = "\n".join([
            "Step 1/2 : FROM ubuntu",
            " ---> deadbeef1234",
            "Step 2/2 : CMD bash",
            " ---> cafebabe5678",
            "Successfully built cafebabe5678",
        ])
        out = _compress(inp)
        assert "[building" not in out

    def test_preamble_appears_before_other_content(self) -> None:
        inp = "\n".join([
            "Step 1/2 : FROM alpine",
            " ---> Using cache",
            "Step 2/2 : RUN echo hi",
            " ---> abc",
            "Successfully built abc",
        ])
        out = _compress(inp)
        preamble_pos = out.find("[building")
        success_pos = out.find("Successfully built")
        assert preamble_pos != -1
        assert preamble_pos < success_pos
