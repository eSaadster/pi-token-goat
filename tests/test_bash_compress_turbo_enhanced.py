"""Enhanced tests for TurboFilter — Turborepo build output compression."""
from __future__ import annotations

from tests.filter_test_helpers import apply_filter, savings_ratio
from token_goat import bash_compress as bc

_F = bc.TurboFilter()
_ARGV = ["turbo", "run", "build"]


def _apply(stdout: str, stderr: str = "", exit_code: int = 0) -> str:
    return apply_filter(_F, stdout=stdout, stderr=stderr, exit_code=exit_code, argv=_ARGV)


# ---------------------------------------------------------------------------
# Sample outputs
# ---------------------------------------------------------------------------

# Large run with many cache hits — the main compression target.
_BIG_SUCCESS = """\
• Packages in scope: app, docs, web, api, shared
• Running build in 5 packages

  app:build: cache miss, executing abcdef123456
  app:build: > webpack --config webpack.config.js
  app:build: asset main.js 1.23 MiB [emitted]
  app:build: asset vendor.js 800 KiB [emitted]
  app:build: webpack compiled successfully

  docs:build: cache hit, replaying output 111111111111
  docs:build: > next build
  docs:build: Creating an optimized production build...
  docs:build: ✓ Compiled successfully
  docs:build: Route (pages)
  docs:build: ┌ ○ /index
  docs:build: └ ○ /404

  web:build: cache hit, replaying output 222222222222
  web:build: > vite build
  web:build: info  - Generating static pages (3/3)
  web:build: Built in 2.1s

  api:build: cache hit, replaying output 333333333333
  api:build: > tsc --noEmit
  api:build: Done in 1.2s

  shared:build: cache miss, executing ccccddddeeee
  shared:build: > rollup -c
  shared:build: created dist/index.esm.js in 0.3s

 Tasks:    5 successful, 5 total
 Cached:   3 cached, 5 total
 Time:     6.789s
"""

_ALL_CACHE_MISS = """\
• Packages in scope: alpha, beta
• Running build in 2 packages

  alpha:build: cache miss, executing aaaa0000
  alpha:build: > tsc --project tsconfig.json
  alpha:build: Done in 1.5s

  beta:build: cache miss, executing bbbb1111
  beta:build: > rollup -c rollup.config.js
  beta:build: created dist/index.js

 Tasks:    2 successful, 2 total
 Cached:   0 cached, 2 total
 Time:     3.200s
"""

_SEPARATOR_NOISE = """\
• Running build in 1 packages
──────────────────────────────
>>> FULL TURBO
  pkg:build: cache miss, executing ffffaaaa
  pkg:build: compiled ok
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 Tasks:    1 successful, 1 total
 Time:     1.000s
"""

# Cache-hit task whose replayed output contains an error line.
_CACHE_HIT_WITH_ERROR = """\
• Running test in 2 packages

  good:test: cache hit, replaying output aabbccdd
  good:test: > jest
  good:test: PASS src/math.test.ts
  good:test: All tests passed

  broken:test: cache hit, replaying output 11223344
  broken:test: > jest
  broken:test: FAIL src/auth.test.ts
  broken:test: Error: expected 200 but got 401

 Tasks:    1 successful, 1 failed, 2 total
 Time:     2.500s
"""

_FAIL_RUN = """\
• Running test in 2 packages

  api:test: cache miss, executing aabbccdd1122
  api:test: FAIL src/auth.test.ts
  api:test: TypeError: Cannot read property 'token' of undefined

  ui:test: cache hit, replaying output 33445566
  ui:test: > jest --passWithNoTests

 Tasks:    1 successful, 1 failed, 2 total
 Time:     8.500s
"""


# ---------------------------------------------------------------------------
# Dispatch / match
# ---------------------------------------------------------------------------


def test_matches_bare_turbo() -> None:
    assert _F.matches(["turbo"])


def test_matches_turbo_run_build() -> None:
    assert _F.matches(["turbo", "run", "build"])


def test_matches_turbo_run_test() -> None:
    assert _F.matches(["turbo", "run", "test"])


def test_matches_npx_turbo() -> None:
    assert _F.matches(["npx", "turbo", "run", "build"])


def test_matches_pnpx_turbo() -> None:
    assert _F.matches(["pnpx", "turbo", "run", "lint"])


def test_matches_turbo_exe() -> None:
    assert _F.matches(["turbo.exe", "run", "build"])


def test_no_match_npm() -> None:
    assert not _F.matches(["npm", "run", "build"])


def test_no_match_npx_webpack() -> None:
    assert not _F.matches(["npx", "webpack"])


def test_no_match_pnpx_vite() -> None:
    assert not _F.matches(["pnpx", "vite"])


def test_no_match_empty_argv() -> None:
    assert not _F.matches([])


def test_dispatch_routes_to_turbo() -> None:
    assert isinstance(bc.select_filter(["turbo", "run", "build"]), bc.TurboFilter)


def test_dispatch_routes_npx_turbo() -> None:
    assert isinstance(bc.select_filter(["npx", "turbo", "run", "build"]), bc.TurboFilter)


def test_dispatch_routes_pnpx_turbo() -> None:
    assert isinstance(bc.select_filter(["pnpx", "turbo", "run", "test"]), bc.TurboFilter)


def test_turbo_in_all_exports() -> None:
    assert "TurboFilter" in bc.__all__


# ---------------------------------------------------------------------------
# Always-kept lines
# ---------------------------------------------------------------------------


def test_scope_header_kept() -> None:
    out = _apply(_BIG_SUCCESS)
    assert "Packages in scope" in out


def test_running_header_kept() -> None:
    out = _apply(_BIG_SUCCESS)
    assert "Running build in 5 packages" in out


def test_summary_tasks_line_kept() -> None:
    out = _apply(_BIG_SUCCESS)
    assert "Tasks:" in out


def test_summary_cached_line_kept() -> None:
    out = _apply(_BIG_SUCCESS)
    assert "Cached:" in out


def test_summary_time_line_kept() -> None:
    out = _apply(_BIG_SUCCESS)
    assert "Time:" in out


def test_cache_miss_header_kept() -> None:
    out = _apply(_BIG_SUCCESS)
    assert "cache miss" in out


def test_cache_miss_body_kept() -> None:
    # Non-trivial body lines from a cache-miss task must be preserved.
    out = _apply(_BIG_SUCCESS)
    assert "webpack compiled successfully" in out


# ---------------------------------------------------------------------------
# Cache-hit suppression
# ---------------------------------------------------------------------------


def test_cache_hit_replay_line_dropped() -> None:
    out = _apply(_BIG_SUCCESS)
    assert "replaying output" not in out


def test_cache_hit_body_lines_dropped() -> None:
    # Body lines from cache-hit tasks (docs:build, web:build, api:build) must go.
    out = _apply(_BIG_SUCCESS)
    assert "next build" not in out
    assert "Generating static pages" not in out
    assert "vite build" not in out


def test_compression_note_mentions_cache_hit() -> None:
    out = _apply(_BIG_SUCCESS)
    assert "cache-hit" in out


def test_compression_note_mentions_task_body_lines() -> None:
    # There are 9 body lines from cache-hit tasks in _BIG_SUCCESS.
    out = _apply(_BIG_SUCCESS)
    assert "task body line" in out


# ---------------------------------------------------------------------------
# All-cache-miss run — nothing should be dropped
# ---------------------------------------------------------------------------


def test_all_cache_miss_no_suppression_note() -> None:
    out = _apply(_ALL_CACHE_MISS)
    assert "cache-hit" not in out


def test_all_cache_miss_body_lines_kept() -> None:
    out = _apply(_ALL_CACHE_MISS)
    assert "tsc --project tsconfig.json" in out
    assert "rollup -c rollup.config.js" in out


# ---------------------------------------------------------------------------
# Separator lines
# ---------------------------------------------------------------------------


def test_separator_dashes_dropped() -> None:
    out = _apply(_SEPARATOR_NOISE)
    assert "──────" not in out


def test_separator_full_turbo_dropped() -> None:
    out = _apply(_SEPARATOR_NOISE)
    assert "FULL TURBO" not in out


def test_separator_heavy_dashes_dropped() -> None:
    out = _apply(_SEPARATOR_NOISE)
    assert "━━━━━━" not in out


def test_separator_drop_does_not_affect_content() -> None:
    out = _apply(_SEPARATOR_NOISE)
    assert "compiled ok" in out
    assert "Tasks:" in out


# ---------------------------------------------------------------------------
# Error-signal surfacing from cache-hit tasks
# ---------------------------------------------------------------------------


def test_error_line_in_cache_hit_task_surfaced() -> None:
    # An "Error:" line inside a cache-hit task's body must break through.
    out = _apply(_CACHE_HIT_WITH_ERROR, exit_code=1)
    assert "Error: expected 200 but got 401" in out


def test_fail_line_in_cache_hit_task_not_surfaced_without_keyword() -> None:
    # "FAIL src/auth.test.ts" does not contain an _ERROR_SIGNAL_RE keyword
    # (FAILED has the D; bare FAIL does not), so it stays suppressed.
    out = _apply(_CACHE_HIT_WITH_ERROR, exit_code=1)
    assert "FAIL src/auth.test.ts" not in out


def test_passing_cache_hit_body_still_dropped_when_error_in_other_task() -> None:
    # Passing body lines from good:test should still be dropped.
    out = _apply(_CACHE_HIT_WITH_ERROR, exit_code=1)
    assert "PASS src/math.test.ts" not in out


# ---------------------------------------------------------------------------
# Failure run
# ---------------------------------------------------------------------------


def test_fail_run_error_line_kept() -> None:
    out = _apply(_FAIL_RUN, exit_code=1)
    assert "TypeError" in out


def test_fail_run_fail_header_kept() -> None:
    out = _apply(_FAIL_RUN, exit_code=1)
    assert "FAIL src/auth.test.ts" in out


def test_fail_run_summary_kept() -> None:
    out = _apply(_FAIL_RUN, exit_code=1)
    assert "1 failed" in out


# ---------------------------------------------------------------------------
# Compression ratio
# ---------------------------------------------------------------------------


def test_savings_ratio_big_success() -> None:
    ratio = savings_ratio(_F, stdout=_BIG_SUCCESS)
    assert ratio >= 0.30, f"TurboFilter savings {ratio:.0%} < 30% on big success run"


# ---------------------------------------------------------------------------
# Edge cases
# ---------------------------------------------------------------------------


def test_empty_input_no_crash() -> None:
    out = _apply("")
    assert out == ""


def test_no_task_lines_passthrough() -> None:
    # Plain text with no turbo-shaped lines should survive unchanged.
    plain = "some other output\nnothing turbo here\n"
    out = _apply(plain)
    assert "some other output" in out


def test_stderr_combined_with_stdout() -> None:
    # stderr errors must appear in the output even when stdout carries the task lines.
    out = apply_filter(_F, stdout=_BIG_SUCCESS, stderr="Error: build daemon crashed", exit_code=1)
    assert "build daemon crashed" in out
