"""Tests for worker.adaptive_poll_interval — boundary, ramp, and cap behavior."""
from __future__ import annotations

import token_goat.worker as worker


def test_adaptive_poll_at_zero_returns_base():
    """Zero consecutive empty drains returns the base POLL_INTERVAL."""
    assert worker.adaptive_poll_interval(0) == worker.POLL_INTERVAL


def test_adaptive_poll_below_threshold_stays_at_base():
    """Every value strictly below IDLE_BACKOFF_AFTER_EMPTY_DRAINS returns POLL_INTERVAL."""
    threshold = worker.IDLE_BACKOFF_AFTER_EMPTY_DRAINS
    for n in range(threshold):
        result = worker.adaptive_poll_interval(n)
        assert result == worker.POLL_INTERVAL, f"expected base at n={n}, got {result}"


def test_adaptive_poll_exactly_at_threshold_steps_above_base():
    """At exactly IDLE_BACKOFF_AFTER_EMPTY_DRAINS the interval must exceed POLL_INTERVAL.

    The docstring says the +1 in the formula ensures the first eligible drain
    steps *strictly* above the base — this test pins that guarantee.
    """
    threshold = worker.IDLE_BACKOFF_AFTER_EMPTY_DRAINS
    result = worker.adaptive_poll_interval(threshold)
    assert result > worker.POLL_INTERVAL, (
        f"expected interval > {worker.POLL_INTERVAL} at threshold {threshold}, got {result}"
    )


def test_adaptive_poll_grows_linearly():
    """Each additional empty drain beyond the threshold adds exactly one POLL_INTERVAL step."""
    threshold = worker.IDLE_BACKOFF_AFTER_EMPTY_DRAINS
    v0 = worker.adaptive_poll_interval(threshold)
    v1 = worker.adaptive_poll_interval(threshold + 1)
    v2 = worker.adaptive_poll_interval(threshold + 2)
    # Linear ramp: each step increases by exactly POLL_INTERVAL.
    step = worker.POLL_INTERVAL
    assert abs((v1 - v0) - step) < 1e-9, f"expected linear step {step} from v0={v0} to v1={v1}"
    assert abs((v2 - v1) - step) < 1e-9, f"expected linear step {step} from v1={v1} to v2={v2}"


def test_adaptive_poll_caps_at_max():
    """Very large idle counts must not exceed POLL_INTERVAL_MAX."""
    result = worker.adaptive_poll_interval(10_000)
    assert result == worker.POLL_INTERVAL_MAX


def test_adaptive_poll_max_exceeds_base():
    """Sanity: POLL_INTERVAL_MAX must be strictly greater than POLL_INTERVAL."""
    assert worker.POLL_INTERVAL_MAX > worker.POLL_INTERVAL


def test_adaptive_poll_just_before_cap():
    """The value just before the cap formula saturates returns exactly POLL_INTERVAL_MAX."""
    # Work out how many steps are needed to hit the cap.
    # cap = POLL_INTERVAL + extra * POLL_INTERVAL  =>  extra = (MAX - BASE) / BASE
    base = worker.POLL_INTERVAL
    cap = worker.POLL_INTERVAL_MAX
    # extra such that POLL_INTERVAL + extra * POLL_INTERVAL >= POLL_INTERVAL_MAX
    import math
    extra_needed = math.ceil((cap - base) / base)
    n_at_cap = worker.IDLE_BACKOFF_AFTER_EMPTY_DRAINS + extra_needed - 1
    # One step before cap: may be < MAX
    result_before = worker.adaptive_poll_interval(n_at_cap)
    result_at = worker.adaptive_poll_interval(n_at_cap + 1)
    # At or after cap: must equal MAX
    assert result_at == cap, f"expected {cap} at n={n_at_cap + 1}, got {result_at}"
    # Before cap: must be positive and <= MAX (could equal MAX if extra_needed is exact)
    assert 0 < result_before <= cap
