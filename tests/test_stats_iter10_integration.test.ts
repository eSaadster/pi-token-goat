/**
 * End-to-end integration tests for stats accounting improvements added in the
 * improvement loop (iterations 1-9). Port of
 * tests/test_stats_iter10_integration.py.
 *
 * Verifies that the stat kinds added throughout the loop — skill_cached,
 * bash_output_cached, web_output_cached, compact_recovery, symbol_lookup,
 * map_lookup, semantic_search, and session_hint_suppressed — are:
 *  1. Recorded to the global DB with non-zero bytes_saved / tokens_saved.
 *  2. Surfaced in stats.summarize() by_kind output.
 *  3. Assigned to the correct category group by _kind_group_label.
 *  4. Present in the rendered stats output (render_text).
 *
 * The tmp data dir + cache reset are applied by tests/setup.ts's beforeEach, so
 * the Python `tmp_data_dir` fixture parameter has no TS counterpart.
 *
 * Parity notes:
 *  - db.record_stat(None, kind, bytes_saved=.., tokens_saved=..) maps to
 *    db.recordStat(undefined, kind, { bytesSaved, tokensSaved }).
 *  - stats.summarize(window_days=30) maps to stats.summarize(30).
 *  - summary.by_kind[kind]["bytes_saved"] maps to summary.by_kind[kind]!.bytes_saved.
 *  - data.by_kind is a list of items with a .kind attribute (KindStat) in both.
 *
 * TestCategoryGrouping imports `render/stats_renderer._kind_group_label`
 * (exported by the leaf batch), so the group-label parametrized cases run live.
 */
import { describe, expect, it } from "vitest";

import * as db from "../src/token_goat/db.js";
import * as stats from "../src/token_goat/stats.js";
import { _kind_group_label } from "../src/token_goat/render/stats_renderer.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Record one event for each kind added during the improvement loop. */
function _recordLoopKinds(bytesEach = 500, tokensEach = 125): void {
  for (const kind of [
    "skill_cached",
    "bash_output_cached",
    "web_output_cached",
    "compact_recovery",
    "symbol_lookup",
    "map_lookup",
    "semantic_search",
    "session_hint_suppressed",
  ]) {
    db.recordStat(undefined, kind, { bytesSaved: bytesEach, tokensSaved: tokensEach });
  }
}

// ---------------------------------------------------------------------------
// Core accounting test
// ---------------------------------------------------------------------------

describe("TestLoopKindAccounting", () => {
  it("test_skill_cached_shows_nonzero_savings", () => {
    db.recordStat(undefined, "skill_cached", { bytesSaved: 4096, tokensSaved: 1024 });
    const summary = stats.summarize(30);
    expect("skill_cached" in summary.by_kind).toBe(true);
    expect(summary.by_kind["skill_cached"]!.bytes_saved).toBe(4096);
    expect(summary.by_kind["skill_cached"]!.tokens_saved).toBe(1024);
    expect(summary.by_kind["skill_cached"]!.events).toBe(1);
  });

  it("test_bash_output_cached_shows_nonzero_savings", () => {
    db.recordStat(undefined, "bash_output_cached", { bytesSaved: 8192, tokensSaved: 2048 });
    const summary = stats.summarize(30);
    expect("bash_output_cached" in summary.by_kind).toBe(true);
    expect(summary.by_kind["bash_output_cached"]!.bytes_saved).toBe(8192);
  });

  it("test_web_output_cached_shows_nonzero_savings", () => {
    db.recordStat(undefined, "web_output_cached", { bytesSaved: 16384, tokensSaved: 4096 });
    const summary = stats.summarize(30);
    expect("web_output_cached" in summary.by_kind).toBe(true);
    expect(summary.by_kind["web_output_cached"]!.bytes_saved).toBe(16384);
  });

  it("test_compact_recovery_shows_nonzero_savings", () => {
    db.recordStat(undefined, "compact_recovery", { bytesSaved: 2048, tokensSaved: 512 });
    const summary = stats.summarize(30);
    expect("compact_recovery" in summary.by_kind).toBe(true);
    expect(summary.by_kind["compact_recovery"]!.bytes_saved).toBe(2048);
  });

  it("test_symbol_lookup_shows_nonzero_savings", () => {
    db.recordStat(undefined, "symbol_lookup", { bytesSaved: 6000, tokensSaved: 1500 });
    const summary = stats.summarize(30);
    expect("symbol_lookup" in summary.by_kind).toBe(true);
    expect(summary.by_kind["symbol_lookup"]!.bytes_saved).toBe(6000);
  });

  it("test_map_lookup_shows_nonzero_savings", () => {
    db.recordStat(undefined, "map_lookup", { bytesSaved: 3000, tokensSaved: 750 });
    const summary = stats.summarize(30);
    expect("map_lookup" in summary.by_kind).toBe(true);
    expect(summary.by_kind["map_lookup"]!.bytes_saved).toBe(3000);
  });

  it("test_semantic_search_shows_nonzero_savings", () => {
    db.recordStat(undefined, "semantic_search", { bytesSaved: 2500, tokensSaved: 625 });
    const summary = stats.summarize(30);
    expect("semantic_search" in summary.by_kind).toBe(true);
    expect(summary.by_kind["semantic_search"]!.bytes_saved).toBe(2500);
  });
});

// ---------------------------------------------------------------------------
// At-least-three categories simultaneously
// ---------------------------------------------------------------------------

describe("TestMultiCategoryAccounting", () => {
  it("test_three_categories_nonzero_simultaneously", () => {
    // skill_cached, bash_output_cached, and symbol_lookup all record savings.
    db.recordStat(undefined, "skill_cached", { bytesSaved: 1000, tokensSaved: 250 });
    db.recordStat(undefined, "bash_output_cached", { bytesSaved: 2000, tokensSaved: 500 });
    db.recordStat(undefined, "symbol_lookup", { bytesSaved: 3000, tokensSaved: 750 });

    const summary = stats.summarize(30);

    // All three must be present and non-zero.
    const cases: Array<[string, number]> = [
      ["skill_cached", 1000],
      ["bash_output_cached", 2000],
      ["symbol_lookup", 3000],
    ];
    for (const [kind, expectedBytes] of cases) {
      expect(kind in summary.by_kind, `${kind} missing from by_kind`).toBe(true);
      expect(
        summary.by_kind[kind]!.bytes_saved,
        `${kind}: expected ${expectedBytes}, got ${summary.by_kind[kind]!.bytes_saved}`,
      ).toBe(expectedBytes);
    }
  });

  it("test_total_accumulates_across_all_loop_kinds", () => {
    // Total bytes/tokens accumulate correctly when all loop kinds are present.
    _recordLoopKinds(500, 125);

    const summary = stats.summarize(30);

    // 8 kinds x 500 bytes each = 4000 total bytes.
    expect(summary.total_bytes_saved).toBe(4000);
    expect(summary.total_tokens_saved).toBe(1000);
    expect(summary.total_events).toBe(8);
  });
});

// ---------------------------------------------------------------------------
// Category grouping verification
// ---------------------------------------------------------------------------

describe("TestCategoryGrouping", () => {
  // Loop kinds land in the right _KIND_GROUPS category. _kind_group_label is
  // exported by the leaf batch, so these run live (was it.skip'd while it was
  // module-private).
  const groupCases: Array<[string, string]> = [
    ["skill_cached", "Compact / Skills"],
    ["compact_recovery", "Compact / Skills"],
    ["bash_output_cached", "Bash"],
    ["web_output_cached", "Web"],
    ["symbol_lookup", "Lookups"],
    ["map_lookup", "Lookups"],
    ["semantic_search", "Lookups"],
  ];
  for (const [kind, expectedGroup] of groupCases) {
    it(`test_kind_assigned_to_correct_group[${kind}-${expectedGroup}]`, () => {
      expect(_kind_group_label(kind)).toBe(expectedGroup);
    });
  }
});

// ---------------------------------------------------------------------------
// Render integration
// ---------------------------------------------------------------------------

describe("TestRenderIntegration", () => {
  it("test_render_text_includes_skill_cached", () => {
    db.recordStat(undefined, "skill_cached", { bytesSaved: 1000, tokensSaved: 250 });
    const summary = stats.summarize(30);
    const output = stats.render_text(summary);
    expect(output).toContain("skill_cached");
  });

  it("test_render_text_includes_bash_output_cached", () => {
    db.recordStat(undefined, "bash_output_cached", { bytesSaved: 2000, tokensSaved: 500 });
    const summary = stats.summarize(30);
    const output = stats.render_text(summary);
    expect(output).toContain("bash_output_cached");
  });

  it("test_render_text_includes_symbol_lookup", () => {
    db.recordStat(undefined, "symbol_lookup", { bytesSaved: 3000, tokensSaved: 750 });
    const summary = stats.summarize(30);
    const output = stats.render_text(summary);
    expect(output).toContain("symbol_lookup");
  });

  it("test_render_text_all_loop_kinds_present", () => {
    // All eight loop-improvement kinds appear in a combined render_text output.
    _recordLoopKinds(500, 125);
    const summary = stats.summarize(30);
    const output = stats.render_text(summary);

    // Every kind that records non-zero savings should appear in the output.
    for (const kind of [
      "skill_cached",
      "bash_output_cached",
      "web_output_cached",
      "compact_recovery",
      "symbol_lookup",
      "map_lookup",
      "semantic_search",
    ]) {
      expect(output, `kind=${kind} is missing from render_text output`).toContain(kind);
    }
  });

  it("test_by_kind_in_stats_data", () => {
    // _to_stats_data includes loop kinds in its by_kind list.
    db.recordStat(undefined, "skill_cached", { bytesSaved: 1000, tokensSaved: 250 });
    db.recordStat(undefined, "symbol_lookup", { bytesSaved: 2000, tokensSaved: 500 });
    db.recordStat(undefined, "bash_output_cached", { bytesSaved: 3000, tokensSaved: 750 });

    const summary = stats.summarize(30);
    const data = stats._to_stats_data(summary);

    const kindNames = new Set(data.by_kind.map((k) => k.kind));
    expect(kindNames.has("skill_cached")).toBe(true);
    expect(kindNames.has("symbol_lookup")).toBe(true);
    expect(kindNames.has("bash_output_cached")).toBe(true);
  });
});
