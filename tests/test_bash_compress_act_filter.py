"""Tests for ActFilter (local GitHub Actions runner output compression)."""
from __future__ import annotations

from tests.filter_test_helpers import apply_filter, savings_ratio
from token_goat import bash_compress as bc

# ---------------------------------------------------------------------------
# Realistic act session fixture
# ---------------------------------------------------------------------------

_ACT_RUN = """\
[Build/Checkout] | Using docker image node:20-bullseye-slim
[Build/Checkout] | Pulling from library/node
[Build/Checkout] | Waiting
[Build/Checkout] | Verifying Checksum
[Build/Checkout] | Pull complete
[Build/Checkout] | Digest: sha256:abc123def456
[Build/Checkout] | Status: Downloaded newer image
[Build/Checkout] | Checking out code...
[Build/Checkout] | git clone https://github.com/org/repo
[Build/Install] | npm install
[Build/Install] | added 312 packages in 4s
[Build/Test  ] | npm test
[Build/Test  ] | PASS src/__tests__/auth.test.js
[Build/Test  ] | PASS src/__tests__/api.test.js
[Build/Test  ] | Test Suites: 2 passed, 2 total
[Build/Test  ] | Tests:       15 passed, 15 total
[Build/Test  ] ✅ Build/Test
[Build/Build ] | npm run build
[Build/Build ] | Build complete in 3.2s
[Build/Build ] ✅ Build/Build
"""

_ACT_MATRIX_RUN = """\
[matrix: {"os": "ubuntu-latest", "node": "18"}] Matrix: os=ubuntu-latest node=18
[matrix: {"os": "ubuntu-latest", "node": "20"}] Matrix: os=ubuntu-latest node=20
[matrix: {"os": "windows-latest", "node": "18"}] Matrix: os=windows-latest node=18
[matrix: {"os": "windows-latest", "node": "20"}] Matrix: os=windows-latest node=20
[Test (ubuntu-latest, 18)/Run tests] | npm test
[Test (ubuntu-latest, 18)/Run tests] | Tests: 10 passed
[Test (ubuntu-latest, 18)/Run tests] ✅ Test (ubuntu-latest, 18)
[Test (ubuntu-latest, 20)/Run tests] ✅ Test (ubuntu-latest, 20)
"""

_ACT_FAILURE_RUN = """\
[Build/Test] | npm test
[Build/Test] | FAIL src/__tests__/auth.test.js
[Build/Test] | Error: expect(received).toBe(expected)
[Build/Test] | Tests: 1 failed, 14 passed
[Build/Test] | Process completed with exit code 1
[Build/Test] ❌ Build/Test
"""


# ---------------------------------------------------------------------------
# matches()
# ---------------------------------------------------------------------------


def test_act_matches() -> None:
    f = bc.ActFilter()
    assert f.matches(["act"])
    assert f.matches(["act", "-j", "build"])
    assert f.matches(["act", "--list"])
    assert f.matches(["act", "push"])


def test_act_no_match_other_binaries() -> None:
    f = bc.ActFilter()
    assert not f.matches(["gh"])
    assert not f.matches(["docker"])
    assert not f.matches(["npm"])
    assert not f.matches(["node"])
    assert not f.matches([])


def test_dispatch_routes_to_act() -> None:
    result = bc.select_filter(["act", "-j", "build"])
    assert isinstance(result, bc.ActFilter)


# ---------------------------------------------------------------------------
# Docker pull progress lines are collapsed
# ---------------------------------------------------------------------------


def test_docker_pull_lines_dropped() -> None:
    f = bc.ActFilter()
    out = apply_filter(f, stdout=_ACT_RUN, argv=["act"])
    assert "Pulling from" not in out
    assert "Waiting" not in out
    assert "Verifying Checksum" not in out
    assert "Pull complete" not in out
    assert "Digest:" not in out
    assert "Status: Downloaded" not in out


def test_docker_pull_note_emitted() -> None:
    f = bc.ActFilter()
    out = apply_filter(f, stdout=_ACT_RUN, argv=["act"])
    assert "docker-pull" in out


# ---------------------------------------------------------------------------
# Job/step prefix stripped from body lines
# ---------------------------------------------------------------------------


def test_job_prefix_stripped_from_body() -> None:
    f = bc.ActFilter()
    out = apply_filter(f, stdout=_ACT_RUN, argv=["act"])
    assert "[Build/Install] |" not in out
    assert "[Build/Test  ] |" not in out
    assert "npm install" in out


def test_body_content_kept_after_prefix_strip() -> None:
    f = bc.ActFilter()
    out = apply_filter(f, stdout=_ACT_RUN, argv=["act"])
    assert "Test Suites: 2 passed" in out
    assert "Tests:       15 passed" in out
    assert "npm run build" in out
    assert "Build complete in 3.2s" in out


# ---------------------------------------------------------------------------
# Status lines kept verbatim (with prefix)
# ---------------------------------------------------------------------------


def test_success_status_lines_kept() -> None:
    f = bc.ActFilter()
    out = apply_filter(f, stdout=_ACT_RUN, argv=["act"])
    assert "✅ Build/Test" in out
    assert "✅ Build/Build" in out


def test_failure_status_line_kept() -> None:
    f = bc.ActFilter()
    out = apply_filter(f, stdout=_ACT_FAILURE_RUN, argv=["act"])
    assert "❌ Build/Test" in out


# ---------------------------------------------------------------------------
# Matrix expansion lines collapsed
# ---------------------------------------------------------------------------


def test_matrix_expansion_lines_dropped() -> None:
    f = bc.ActFilter()
    out = apply_filter(f, stdout=_ACT_MATRIX_RUN, argv=["act"])
    assert '[matrix: {"os"' not in out


def test_matrix_expansion_note_emitted() -> None:
    f = bc.ActFilter()
    out = apply_filter(f, stdout=_ACT_MATRIX_RUN, argv=["act"])
    assert "matrix" in out.lower()


def test_matrix_expansion_content_kept() -> None:
    f = bc.ActFilter()
    out = apply_filter(f, stdout=_ACT_MATRIX_RUN, argv=["act"])
    assert "npm test" in out
    assert "Tests: 10 passed" in out


# ---------------------------------------------------------------------------
# Failure / error lines kept verbatim (stripped of prefix)
# ---------------------------------------------------------------------------


def test_error_lines_in_body_kept() -> None:
    f = bc.ActFilter()
    out = apply_filter(f, stdout=_ACT_FAILURE_RUN, argv=["act"])
    assert "FAIL src/__tests__/auth.test.js" in out
    assert "Error: expect(received).toBe(expected)" in out
    assert "Process completed with exit code 1" in out


def test_failure_body_prefix_stripped() -> None:
    f = bc.ActFilter()
    out = apply_filter(f, stdout=_ACT_FAILURE_RUN, argv=["act"])
    assert "[Build/Test] |" not in out


# ---------------------------------------------------------------------------
# Short / clean output passes through
# ---------------------------------------------------------------------------


def test_short_output_passes_through() -> None:
    short = "[Build/Test] | Tests: 5 passed\n[Build/Test] ✅ Build/Test\n"
    f = bc.ActFilter()
    out = apply_filter(f, stdout=short, argv=["act"])
    assert "Tests: 5 passed" in out
    assert "✅ Build/Test" in out


def test_empty_input() -> None:
    f = bc.ActFilter()
    out = apply_filter(f, stdout="", argv=["act"])
    assert out == ""


# ---------------------------------------------------------------------------
# Savings ratio
# ---------------------------------------------------------------------------


def test_savings_on_docker_heavy_run() -> None:
    ratio = savings_ratio(bc.ActFilter(), _ACT_RUN, argv=["act"])
    assert ratio > 0.20


# ---------------------------------------------------------------------------
# Registry
# ---------------------------------------------------------------------------


def test_act_filter_in_filters_registry() -> None:
    names = {f.name for f in bc.FILTERS}
    assert "act" in names


def test_act_filter_in_all_exports() -> None:
    assert "ActFilter" in bc.__all__
