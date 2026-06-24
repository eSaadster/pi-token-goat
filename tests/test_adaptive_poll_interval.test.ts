/**
 * Tests for worker.adaptive_poll_interval — boundary, ramp, and cap behavior.
 *
 * 1:1 port of tests/test_adaptive_poll_interval.py.
 *
 * worker.ts is now ported (Layer 6), so these cases drive the real
 * worker.adaptive_poll_interval / worker.POLL_INTERVAL /
 * worker.IDLE_BACKOFF_AFTER_EMPTY_DRAINS / worker.POLL_INTERVAL_MAX.
 *
 * Every Python `def test_*` maps to a vitest `it()` with the same name and
 * assertion polarity; the Python file has no classes, so the module-level
 * functions are grouped under a single describe().
 */
import { describe, expect, it } from "vitest";

import * as worker from "../src/token_goat/worker.js";

describe("adaptive_poll_interval", () => {
  it("test_adaptive_poll_at_zero_returns_base", () => {
    // Zero consecutive empty drains returns the base POLL_INTERVAL.
    expect(worker.adaptive_poll_interval(0)).toBe(worker.POLL_INTERVAL);
  });

  it("test_adaptive_poll_below_threshold_stays_at_base", () => {
    // Every value strictly below IDLE_BACKOFF_AFTER_EMPTY_DRAINS returns POLL_INTERVAL.
    const threshold = worker.IDLE_BACKOFF_AFTER_EMPTY_DRAINS;
    for (let n = 0; n < threshold; n++) {
      const result = worker.adaptive_poll_interval(n);
      expect(result, `expected base at n=${n}, got ${result}`).toBe(worker.POLL_INTERVAL);
    }
  });

  it("test_adaptive_poll_exactly_at_threshold_steps_above_base", () => {
    // At exactly IDLE_BACKOFF_AFTER_EMPTY_DRAINS the interval must exceed POLL_INTERVAL.
    const threshold = worker.IDLE_BACKOFF_AFTER_EMPTY_DRAINS;
    const result = worker.adaptive_poll_interval(threshold);
    expect(
      result,
      `expected interval > ${worker.POLL_INTERVAL} at threshold ${threshold}, got ${result}`,
    ).toBeGreaterThan(worker.POLL_INTERVAL);
  });

  it("test_adaptive_poll_grows_linearly", () => {
    // Each additional empty drain beyond the threshold adds exactly one POLL_INTERVAL step.
    const threshold = worker.IDLE_BACKOFF_AFTER_EMPTY_DRAINS;
    const v0 = worker.adaptive_poll_interval(threshold);
    const v1 = worker.adaptive_poll_interval(threshold + 1);
    const v2 = worker.adaptive_poll_interval(threshold + 2);
    // Linear ramp: each step increases by exactly POLL_INTERVAL.
    const step = worker.POLL_INTERVAL;
    expect(Math.abs(v1 - v0 - step)).toBeLessThan(1e-9);
    expect(Math.abs(v2 - v1 - step)).toBeLessThan(1e-9);
  });

  it("test_adaptive_poll_caps_at_max", () => {
    // Very large idle counts must not exceed POLL_INTERVAL_MAX.
    const result = worker.adaptive_poll_interval(10_000);
    expect(result).toBe(worker.POLL_INTERVAL_MAX);
  });

  it("test_adaptive_poll_max_exceeds_base", () => {
    // Sanity: POLL_INTERVAL_MAX must be strictly greater than POLL_INTERVAL.
    expect(worker.POLL_INTERVAL_MAX).toBeGreaterThan(worker.POLL_INTERVAL);
  });

  it("test_adaptive_poll_just_before_cap", () => {
    // The value just before the cap formula saturates returns exactly POLL_INTERVAL_MAX.
    const base = worker.POLL_INTERVAL;
    const cap = worker.POLL_INTERVAL_MAX;
    // extra such that POLL_INTERVAL + extra * POLL_INTERVAL >= POLL_INTERVAL_MAX
    const extra_needed = Math.ceil((cap - base) / base);
    const n_at_cap = worker.IDLE_BACKOFF_AFTER_EMPTY_DRAINS + extra_needed - 1;
    // One step before cap: may be < MAX
    const result_before = worker.adaptive_poll_interval(n_at_cap);
    const result_at = worker.adaptive_poll_interval(n_at_cap + 1);
    // At or after cap: must equal MAX
    expect(result_at, `expected ${cap} at n=${n_at_cap + 1}, got ${result_at}`).toBe(cap);
    // Before cap: must be positive and <= MAX (could equal MAX if extra_needed is exact)
    expect(result_before).toBeGreaterThan(0);
    expect(result_before).toBeLessThanOrEqual(cap);
  });
});
