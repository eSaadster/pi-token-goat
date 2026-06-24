/**
 * Tests for the fancy ANSI stats renderer — port of
 * tests/test_stats_renderer.py.
 *
 * Focuses on the by-source rollup added on top of the existing kind/day/project
 * sections. Snapshot-style assertions strip ANSI escapes so the tests survive
 * palette tweaks while still verifying structural stability (column ordering,
 * row presence, ordering by share, backward-compat fallback).
 *
 * Parity notes:
 *  - Python's `date(2026, 1, 1)` for StatsData.period_start/period_end maps to
 *    the ISO date string the TS StatsData type carries ("2026-01-01"). The
 *    rendered output never surfaces these fields, so the exact representation
 *    does not affect any assertion.
 *  - Mutating `stats.version = "0.6.1"` in the Python tests maps to assigning
 *    the optional `version` field directly on the constructed object.
 */
import { describe, expect, it } from "vitest";

import { stripAnsi, C } from "../src/token_goat/render/ansi.js";
import {
  _render_by_day_section,
  _render_by_kind_section,
  _render_by_project_section,
  _render_by_source_section,
  _render_header,
  _source_color,
  render_stats,
} from "../src/token_goat/render/stats_renderer.js";
import type {
  DayStat,
  KindStat,
  ProjectStat,
  SourceStat,
  StatsData,
  TotalStats,
} from "../src/token_goat/render/types.js";

/** Return a minimal StatsData with optional by_source override. */
function _make_stats(by_source?: SourceStat[]): StatsData {
  return {
    period_start: "2026-01-01",
    period_end: "2026-01-31",
    totals: { events: 10, bytes: 10_000, tokens: 2_500 } as TotalStats,
    by_kind: [
      { kind: "image_shrink", bytes: 4_000, tokens: 0, events: 4, bytes_mode_only: true },
      { kind: "read_replacement", bytes: 3_000, tokens: 750, events: 3 },
      { kind: "session_hint", bytes: 2_000, tokens: 500, events: 2 },
      { kind: "compact_manifest", bytes: 1_000, tokens: 250, events: 1 },
    ] as KindStat[],
    by_day: [{ date: "2026-01-15", bytes: 10_000, tokens: 2_500, events: 10 }] as DayStat[],
    by_project: [
      {
        project: "example",
        hash: "abc12345",
        path: "/tmp/example",
        bytes: 10_000,
        tokens: 2_500,
        events: 10,
      },
    ] as ProjectStat[],
    by_source:
      by_source !== undefined
        ? by_source
        : ([
            { source: "image", bytes: 4_000, tokens: 0, events: 4 },
            { source: "read", bytes: 3_000, tokens: 750, events: 3 },
            { source: "hint", bytes: 2_000, tokens: 500, events: 2 },
            { source: "compact", bytes: 1_000, tokens: 250, events: 1 },
          ] as SourceStat[]),
  };
}

describe("TestBySourceRendering", () => {
  // The "By source" section appears with the expected rows and ordering.

  it("test_section_header_present", () => {
    const out = _render_by_source_section(_make_stats()).join("\n");
    const plain = stripAnsi(out);
    expect(plain).toContain("By source");
    expect(plain).toContain("source"); // table header column label
  });

  it("test_all_four_sources_render", () => {
    const out = _render_by_source_section(_make_stats()).join("\n");
    const plain = stripAnsi(out);
    for (const src of ["image", "hint", "read", "compact"]) {
      expect(plain, `source ${JSON.stringify(src)} missing from rendered output`).toContain(src);
    }
  });

  it("test_rows_sorted_desc_by_share", () => {
    // Highest-share source must appear before lower-share ones in the output.
    const out = _render_by_source_section(_make_stats()).join("\n");
    const plain = stripAnsi(out);
    // Share = tokens / token total: read 50% > hint 33% > compact 17% > image 0%
    const idx_read = plain.indexOf("read");
    const idx_hint = plain.indexOf("hint");
    const idx_compact = plain.indexOf("compact");
    const idx_image = plain.indexOf("image");
    expect(idx_read).toBeLessThan(idx_hint);
    expect(idx_hint).toBeLessThan(idx_compact);
    expect(idx_compact).toBeLessThan(idx_image);
  });

  it("test_column_layout_matches_other_tables", () => {
    // The header row must include data saved / tokens saved / share / events.
    const out = _render_by_source_section(_make_stats()).join("\n");
    const plain = stripAnsi(out);
    expect(plain).toContain("savings");
    expect(plain).toContain("data saved");
    expect(plain).toContain("tokens saved");
    expect(plain).toContain("share");
    expect(plain).toContain("events");
  });

  it("test_unknown_source_falls_back_to_muted", () => {
    // A future / unknown source name renders rather than crashing.
    expect(_source_color("future-bucket")).toEqual(C.TEXT_MUTED);
  });

  it("test_known_sources_get_distinct_colors", () => {
    // The four canonical sources each get a unique colour assignment.
    const colors = new Set([
      JSON.stringify(_source_color("image")),
      JSON.stringify(_source_color("hint")),
      JSON.stringify(_source_color("read")),
      JSON.stringify(_source_color("compact")),
    ]);
    expect(colors.size).toBe(4); // all four are visually distinct
  });
});

describe("TestBySourceBackwardCompat", () => {
  // Older StatsData snapshots without by_source must still render cleanly.

  it("test_empty_by_source_returns_no_lines", () => {
    // An empty by_source list produces no output lines (section is skipped).
    const stats = _make_stats([]);
    expect(_render_by_source_section(stats)).toEqual([]);
  });

  it("test_stats_data_constructs_without_by_source", () => {
    // StatsData must accept the legacy (no by_source) signature.
    const s: StatsData = {
      period_start: "2026-01-01",
      period_end: "2026-01-31",
      totals: { events: 0, bytes: 0, tokens: 0 } as TotalStats,
      by_kind: [],
      by_day: [],
      by_project: [],
    };
    // Python defaults by_source to []; the TS field is optional/undefined. The
    // renderer treats undefined as empty (see _render_by_source_section).
    expect(s.by_source ?? []).toEqual([]);
    expect(Array.isArray(s.by_source ?? [])).toBe(true);
  });

  it("test_render_stats_skips_section_when_empty", () => {
    // Full render with empty by_source must not crash and must omit the panel.
    const stats = _make_stats([]);
    const out = render_stats(stats);
    const plain = stripAnsi(out);
    // Other sections still render.
    expect(plain).toContain("By kind");
    // And the absent by_source panel does not leave a stray header.
    expect(plain).not.toContain("By source");
  });
});

describe("TestBySourceFullRender", () => {
  // End-to-end: render_stats glues the by_source panel into the output.

  it("test_by_source_appears_in_full_render", () => {
    // When by_source is populated the panel shows up after By kind.
    const out = render_stats(_make_stats());
    const plain = stripAnsi(out);
    expect(plain).toContain("By source");
    // Sanity: kind section must precede source section in the output.
    expect(plain.indexOf("By kind")).toBeLessThan(plain.indexOf("By source"));
  });

  it("test_snapshot_structure", () => {
    // Stable snapshot of the rendered by_source line count (ANSI-stripped).
    //
    // Section header emits: leading-blank + title + rule. Then 1 table-header
    // + 4 data rows. After ANSI-strip and counting non-blank lines we expect
    // title + rule + header + 4 rows = 7 lines.
    const out = _render_by_source_section(_make_stats()).join("\n");
    const plain = stripAnsi(out);
    const non_blank = plain.split("\n").filter((ln) => ln.trim() !== "");
    expect(non_blank.length).toBe(7);
  });

  it.each([
    ["image", "4.0 KB", 4],
    ["read", "3.0 KB", 3],
    ["hint", "2.0 KB", 2],
    ["compact", "1.0 KB", 1],
  ] as const)(
    "test_each_source_shows_correct_bytes[%s]",
    (source, expected_bytes, expected_events) => {
      // Bytes-saved magnitude string and event count render next to the source label.
      const out = _render_by_source_section(_make_stats()).join("\n");
      const plain = stripAnsi(out);
      for (const line of plain.split("\n")) {
        if (line.includes(source)) {
          expect(line, `expected ${JSON.stringify(expected_bytes)} in ${JSON.stringify(source)} row: ${JSON.stringify(line)}`).toContain(
            expected_bytes,
          );
          const lastTok = line.trim().split(/\s+/).slice(-1)[0] ?? "";
          expect(lastTok, `expected events column ${expected_events} at end of row: ${JSON.stringify(line)}`).toContain(
            `${expected_events}`,
          );
          return;
        }
      }
      throw new Error(`source ${JSON.stringify(source)} not found in output`);
    },
  );
});

describe("TestVersionHeader", () => {
  // render_stats surfaces the loaded token-goat version in a header line.

  it("test_render_header_with_version", () => {
    // _render_header shows the name followed by a v-prefixed version.
    const stats = _make_stats();
    stats.version = "0.6.1";
    const header = stripAnsi(_render_header(stats).join("\n"));
    expect(header.trim()).toBe("token-goat  v0.6.1");
  });

  it("test_render_header_without_version", () => {
    // An empty version (older StatsData payload) renders just the name.
    const stats = _make_stats(); // version defaults to undefined / ""
    expect(stats.version ?? "").toBe("");
    const header = stripAnsi(_render_header(stats).join("\n"));
    expect(header.trim()).toBe("token-goat");
  });

  it("test_full_render_includes_version", () => {
    // The version string appears in the complete render_stats output.
    const stats = _make_stats();
    stats.version = "9.9.9";
    const plain = stripAnsi(render_stats(stats));
    expect(plain).toContain("token-goat");
    expect(plain).toContain("v9.9.9");
  });

  it("test_header_precedes_all_sections", () => {
    // The header line is rendered before the first data section.
    const stats = _make_stats();
    stats.version = "9.9.9";
    const plain = stripAnsi(render_stats(stats));
    expect(plain.indexOf("token-goat")).toBeLessThan(plain.indexOf("By kind"));
  });
});

describe("TestShareOrdering", () => {
  // By kind / by day / by project rows render in descending share order.
  //
  // Regression: the rows were emitted in the caller's byte-sorted order while
  // the share column they display is token-derived, so the share column
  // zig-zagged whenever bytes and tokens ranked rows differently (an
  // image-heavy day saves bytes but ~0 tokens). Each section renderer now
  // orders its rows by the same share metric it displays.

  it("test_by_kind_rows_descending_share", () => {
    // read_replacement (50% token share) outranks image_shrink (40% byte share).
    const out = stripAnsi(_render_by_kind_section(_make_stats()).join("\n"));
    expect(out.indexOf("read_replacement")).toBeLessThan(out.indexOf("image_shrink"));
    expect(out.indexOf("image_shrink")).toBeLessThan(out.indexOf("session_hint"));
    expect(out.indexOf("session_hint")).toBeLessThan(out.indexOf("compact_manifest"));
  });

  it("test_by_day_rows_descending_share", () => {
    // A low-byte / high-token day outranks a high-byte / low-token day.
    const stats = _make_stats();
    stats.totals = { events: 20, bytes: 10_000, tokens: 1_000 } as TotalStats;
    stats.by_day = [
      { date: "2026-03-01", bytes: 8_000, tokens: 100, events: 10 },
      { date: "2026-03-02", bytes: 2_000, tokens: 900, events: 10 },
    ] as DayStat[];
    const out = stripAnsi(_render_by_day_section(stats).join("\n"));
    // 2026-03-02 = 90% token share despite fewer bytes — it renders first.
    expect(out.indexOf("2026-03-02")).toBeLessThan(out.indexOf("2026-03-01"));
  });

  it("test_by_project_rows_descending_share", () => {
    // A low-byte / high-token project outranks a high-byte / low-token one.
    const stats = _make_stats();
    stats.by_project = [
      {
        project: "big-bytes",
        hash: "aaaa1111",
        path: "/tmp/a",
        bytes: 8_000,
        tokens: 100,
        events: 10,
      },
      {
        project: "big-tokens",
        hash: "bbbb2222",
        path: "/tmp/b",
        bytes: 2_000,
        tokens: 900,
        events: 10,
      },
    ] as ProjectStat[];
    const out = stripAnsi(_render_by_project_section(stats).join("\n"));
    // big-tokens = 90% of the cross-project token total despite fewer bytes.
    expect(out.indexOf("big-tokens")).toBeLessThan(out.indexOf("big-bytes"));
  });
});
