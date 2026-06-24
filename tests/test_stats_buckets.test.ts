/**
 * Tests for the kind to source bucket mapping additions.
 *
 * Port of tests/test_stats_buckets.py. Pure mapping assertions on
 * stats.kind_to_source / stats._KIND_TO_SOURCE — no DB, no clock, no tmp dir.
 *
 * Parity notes:
 *  - Python `stats.kind_to_source("x") == stats.SOURCE_HINT` maps 1:1 to
 *    `expect(stats.kind_to_source("x")).toBe(stats.SOURCE_HINT)`.
 *  - Python `_overhead`-suffix routing is implemented in stats.ts; the static
 *    map holds only base kinds, so the "no _overhead in static map" guard ports
 *    directly against stats._KIND_TO_SOURCE.
 */
import { describe, expect, it } from "vitest";

import * as stats from "../src/token_goat/stats.js";

// ===========================================================================
// TestSourceBucketMapping
// ===========================================================================

describe("TestSourceBucketMapping", () => {
  it("test_diff_hint_lands_in_hint_bucket", () => {
    expect(stats.kind_to_source("diff_hint")).toBe(stats.SOURCE_HINT);
    expect(stats.kind_to_source("diff_hint_overhead")).toBe(stats.SOURCE_HINT);
  });

  it("test_bash_dedup_lands_in_bash_bucket", () => {
    expect(stats.kind_to_source("bash_dedup_hint")).toBe(stats.SOURCE_BASH);
    expect(stats.kind_to_source("bash_dedup_hint_overhead")).toBe(stats.SOURCE_BASH);
  });

  it("test_web_dedup_lands_in_web_bucket", () => {
    expect(stats.kind_to_source("web_dedup_hint")).toBe(stats.SOURCE_WEB);
    expect(stats.kind_to_source("web_dedup_hint_overhead")).toBe(stats.SOURCE_WEB);
  });

  it("test_bash_output_cached_lands_in_bash_bucket", () => {
    expect(stats.kind_to_source("bash_output_cached")).toBe(stats.SOURCE_BASH);
  });

  it("test_compact_recovery_lands_in_compact_bucket", () => {
    // compact_recovery and its overhead must be attributed to SOURCE_COMPACT,
    // not SOURCE_OTHER. They were previously missing from _KIND_TO_SOURCE.
    expect(stats.kind_to_source("compact_recovery")).toBe(stats.SOURCE_COMPACT);
    expect(stats.kind_to_source("compact_recovery_overhead")).toBe(stats.SOURCE_COMPACT);
  });

  it("test_unknown_kind_falls_back_to_other", () => {
    expect(stats.kind_to_source("future_unknown_kind")).toBe(stats.SOURCE_OTHER);
  });

  it("test_existing_buckets_unchanged", () => {
    // Regression: the pre-existing source mapping must not have shifted.
    expect(stats.kind_to_source("image_shrink")).toBe(stats.SOURCE_IMAGE);
    expect(stats.kind_to_source("session_hint")).toBe(stats.SOURCE_HINT);
    expect(stats.kind_to_source("read_replacement")).toBe(stats.SOURCE_READ);
    expect(stats.kind_to_source("compact_manifest")).toBe(stats.SOURCE_COMPACT);
  });

  it("test_overhead_suffix_inherits_from_base", () => {
    // Any <base>_overhead kind resolves via the base lookup. kind_to_source()
    // strips the suffix and re-queries the static dict, so the table only holds
    // the base kinds and the pair is impossible to drift out of sync.
    expect(stats.kind_to_source("session_hint_overhead")).toBe(stats.SOURCE_HINT);
    const cases: Array<[string, string]> = [
      ["session_hint_overhead", stats.SOURCE_HINT],
      ["diff_hint_overhead", stats.SOURCE_HINT],
      ["structured_file_hint_overhead", stats.SOURCE_HINT],
      ["grep_dedup_hint_overhead", stats.SOURCE_HINT],
      ["compact_recovery_overhead", stats.SOURCE_COMPACT],
      ["bash_dedup_hint_overhead", stats.SOURCE_BASH],
      ["web_dedup_hint_overhead", stats.SOURCE_WEB],
    ];
    for (const [overheadKind, expected] of cases) {
      expect(
        stats.kind_to_source(overheadKind),
        `${overheadKind} did not inherit from its base`,
      ).toBe(expected);
    }
    // Hypothetical future overhead pair (no entry in the static map).
    expect(
      stats.kind_to_source("nonexistent_kind_overhead"),
      "overhead suffix must not promote unknown bases out of SOURCE_OTHER",
    ).toBe(stats.SOURCE_OTHER);
  });

  it("test_overhead_not_listed_in_static_map", () => {
    // Guard against re-introducing _overhead entries to the static map. The
    // whole point of the suffix routing is to eliminate the mechanical
    // pair-duplication; any "x_overhead": SOURCE_* entry would silently bypass
    // the suffix path and re-introduce drift risk.
    const offenders = Object.keys(stats._KIND_TO_SOURCE).filter((k) =>
      k.endsWith("_overhead"),
    );
    expect(
      offenders,
      `_overhead kinds must be routed by suffix, not by static entry; found: ${JSON.stringify(offenders)}`,
    ).toEqual([]);
  });
});
