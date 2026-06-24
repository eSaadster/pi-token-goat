/**
 * Enhanced tests for RgFilter: -A/-B flags, files-only/count-only passthrough,
 * inter-match group compression.
 *
 * 1:1 port of tests/test_bash_compress_rg_enhanced.py. Every Python `def test_*`
 * maps to a vitest `it()` with the SAME name and assertion polarity.
 *
 * Test-seam mapping (Python -> TS):
 *  - `from filter_test_helpers import apply_filter`
 *      -> local `apply_filter(filter, opts?)` helper below. The Python helper
 *        runs `filter_.apply(stdout, stderr, exit_code, argv).text`, defaulting
 *        argv to `[filter_.name]`; the TS port mirrors that exactly.
 *  - `from token_goat import bash_compress as bc`
 *      -> import the barrel "../src/token_goat/bash_compress.js" as `bc`
 *        (re-exports the framework + RgFilter + select_filter).
 *  - Module-level `_F = bc.RgFilter()` -> `const _F = new RgFilter()`.
 *  - The Python tests call the helper methods `_F._parse_context_depth(...)`,
 *    `_F._is_files_only(...)`, `_F._is_count_only(...)` as instance methods; in
 *    the TS port these are STATIC methods on RgFilter (they take no `self`), so
 *    they are invoked as `RgFilter._parse_context_depth(...)` etc.
 *
 * Byte-exactness: the fixtures here are pure ASCII, so substring / equality
 * checks translate directly; no Buffer/utf8 arithmetic is needed.
 */
import { describe, expect, it } from "vitest";

import { RgFilter } from "../src/token_goat/bash_compress.js";

import type { Filter } from "../src/token_goat/bash_compress.js";

const _F = new RgFilter();

// ---------------------------------------------------------------------------
// Local apply_filter helper (port of filter_test_helpers.apply_filter).
//
// When argv is omitted the filter's own `.name` is used as the sole argv
// element — the minimum needed for most dispatch checks.
// ---------------------------------------------------------------------------
function apply_filter(
  filter_: Filter,
  opts?: { stdout?: string; stderr?: string; exit_code?: number; argv?: string[] },
): string {
  const stdout = opts?.stdout ?? "";
  const stderr = opts?.stderr ?? "";
  const exit_code = opts?.exit_code ?? 0;
  const argv = opts?.argv ?? [filter_.name];
  return filter_.apply(stdout, stderr, exit_code, argv).text;
}

/** Python str.count(sub) — count of non-overlapping occurrences. */
function _count(haystack: string, needle: string): number {
  if (needle === "") {
    return haystack.length + 1;
  }
  let n = 0;
  let idx = haystack.indexOf(needle);
  while (idx !== -1) {
    n += 1;
    idx = haystack.indexOf(needle, idx + needle.length);
  }
  return n;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function _rg_context_block(n_groups = 5, ctx_lines = 3): string {
  // Build synthetic rg -C output with match + context lines and -- separators.
  const groups: string[] = [];
  for (let g = 0; g < n_groups; g += 1) {
    const block: string[] = [];
    const base = g * 20;
    for (let i = 0; i < ctx_lines; i += 1) {
      block.push(`src/foo.py-${base + i}-context line ${i}`);
    }
    block.push(`src/foo.py:${base + ctx_lines}:MATCH line ${g}`);
    for (let i = 0; i < ctx_lines; i += 1) {
      block.push(`src/foo.py-${base + ctx_lines + 1 + i}-context line ${i}`);
    }
    groups.push(block.join("\n"));
  }
  return groups.join("\n--\n");
}

function _rg_match_groups(n_groups: number, matches_per_group = 1): string {
  // Build synthetic rg output with only match lines separated by -- (no context).
  const groups: string[] = [];
  for (let g = 0; g < n_groups; g += 1) {
    const block: string[] = [];
    for (let j = 0; j < matches_per_group; j += 1) {
      block.push(`src/file${g}.py:${g * 10 + j}:match ${g}-${j}`);
    }
    groups.push(block.join("\n"));
  }
  return groups.join("\n--\n");
}

// ---------------------------------------------------------------------------
// _parse_context_depth unit tests
// ---------------------------------------------------------------------------

describe("test_bash_compress_rg_enhanced", () => {
  it("test_parse_context_depth_A_flag", () => {
    // -A N should be parsed and returned.
    expect(RgFilter._parse_context_depth(["rg", "-A", "3", "pattern"])).toBe(3);
  });

  it("test_parse_context_depth_B_flag", () => {
    // -B N should be parsed and returned.
    expect(RgFilter._parse_context_depth(["rg", "-B", "5", "pattern"])).toBe(5);
  });

  it("test_parse_context_depth_C_flag", () => {
    expect(RgFilter._parse_context_depth(["rg", "-C", "2", "pattern"])).toBe(2);
  });

  it("test_parse_context_depth_combined_form", () => {
    // -A3 (no space) should also be parsed.
    expect(RgFilter._parse_context_depth(["rg", "-A3"])).toBe(3);
  });

  it("test_parse_context_depth_max_of_multiple", () => {
    // Returns max when multiple flags are present.
    expect(RgFilter._parse_context_depth(["rg", "-A", "2", "-B", "7"])).toBe(7);
  });

  it("test_parse_context_depth_none", () => {
    // Returns 0 when no context flags present.
    expect(RgFilter._parse_context_depth(["rg", "pattern", "src/"])).toBe(0);
  });

  it("test_parse_context_depth_long_flag", () => {
    expect(RgFilter._parse_context_depth(["rg", "--context", "4"])).toBe(4);
  });

  it("test_parse_context_depth_C_zero", () => {
    // -C 0 is valid; depth is 0.
    expect(RgFilter._parse_context_depth(["rg", "-C", "0"])).toBe(0);
  });

  // -------------------------------------------------------------------------
  // Files-only passthrough (-l / --files-with-matches)
  // -------------------------------------------------------------------------

  it("test_files_only_short_flag_no_compression", () => {
    // -l output (one filename per line) must pass through unchanged even when large.
    const text = Array.from({ length: 60 }, (_v, i) => `src/file${i}.py`).join("\n");
    const result = apply_filter(_F, { stdout: text, argv: ["rg", "-l", "pattern"] });
    expect(result).toBe(text);
  });

  it("test_files_only_long_flag_no_compression", () => {
    const text = Array.from({ length: 60 }, (_v, i) => `src/file${i}.py`).join("\n");
    const result = apply_filter(_F, {
      stdout: text,
      argv: ["rg", "--files-with-matches", "pattern"],
    });
    expect(result).toBe(text);
  });

  // -------------------------------------------------------------------------
  // Count-only passthrough (-c / --count)
  // -------------------------------------------------------------------------

  it("test_count_only_short_flag_no_compression", () => {
    // -c output (file:N per line) must pass through unchanged.
    const text = Array.from({ length: 60 }, (_v, i) => `src/file${i}.py:${i * 3}`).join("\n");
    const result = apply_filter(_F, { stdout: text, argv: ["rg", "-c", "pattern"] });
    expect(result).toBe(text);
  });

  it("test_count_only_long_flag_no_compression", () => {
    const text = Array.from({ length: 60 }, (_v, i) => `src/file${i}.py:${i}`).join("\n");
    const result = apply_filter(_F, { stdout: text, argv: ["rg", "--count", "pattern"] });
    expect(result).toBe(text);
  });

  // -------------------------------------------------------------------------
  // -A / -B flag triggers context compression on large output
  // -------------------------------------------------------------------------

  it("test_A_flag_context_compression_applied", () => {
    // -A 3 large output with -- separators → context lines stripped.
    const text = _rg_context_block(6, 3);
    const result = apply_filter(_F, { stdout: text, argv: ["rg", "-A", "3", "MATCH", "src/"] });
    expect(result).toContain("token-goat");
  });

  it("test_B_flag_context_compression_applied", () => {
    // -B 3 large output with -- separators → context lines stripped.
    const text = _rg_context_block(6, 3);
    const result = apply_filter(_F, { stdout: text, argv: ["rg", "-B", "3", "MATCH", "src/"] });
    expect(result).toContain("token-goat");
  });

  // -------------------------------------------------------------------------
  // Small output → no compression regardless of flags
  // -------------------------------------------------------------------------

  it("test_small_output_no_compression_with_A_flag", () => {
    // ≤30 lines always passes through unchanged even with -A flag.
    const text = "src/a.py:1:match\n--\nsrc/a.py-2-context";
    const result = apply_filter(_F, { stdout: text, argv: ["rg", "-A", "3"] });
    expect(result).toBe(text);
  });

  it("test_small_output_no_compression_with_B_flag", () => {
    const text = "src/a.py-0-context\n--\nsrc/a.py:1:match";
    const result = apply_filter(_F, { stdout: text, argv: ["rg", "-B", "2"] });
    expect(result).toBe(text);
  });

  // -------------------------------------------------------------------------
  // Inter-match group compression
  // -------------------------------------------------------------------------

  it("test_inter_match_15_groups_keeps_5", () => {
    // 15 groups → inter-match compression keeps only 5, suppresses 10.
    const text = _rg_match_groups(15, 2);
    const result = apply_filter(_F, { stdout: text, argv: ["rg", "-C", "0", "match"] });
    const lines = result.split("\n");
    const group_sep_count = lines.filter((ln) => ln === "--").length;
    // 5 kept groups → at most 4 separators between them
    expect(group_sep_count).toBeLessThanOrEqual(4);
    expect(result).toContain("token-goat");
  });

  it("test_inter_match_sentinel_correct_count", () => {
    // 15 groups × 3 matches = 59 lines > threshold; 5 kept → sentinel reports 10 suppressed.
    const text = _rg_match_groups(15, 3);
    const result = apply_filter(_F, { stdout: text, argv: ["rg", "match"] });
    expect(result).toContain("10 more match groups suppressed");
  });

  it("test_inter_match_top_groups_selected_by_match_count", () => {
    // Groups with more matches should be preferred.
    // Build 12 groups: first 5 have 3 matches each, rest have 1 match each.
    const heavy = Array.from({ length: 3 }, (_v, j) => `src/a.py:${j}:HEAVY match`).join("\n");
    const light = "src/b.py:0:light match";
    const groups = [
      ...Array.from({ length: 5 }, () => heavy),
      ...Array.from({ length: 7 }, () => light),
    ];
    const text = groups.join("\n--\n");
    const result = apply_filter(_F, { stdout: text, argv: ["rg", "match"] });
    // All 5 heavy groups should be in the result (they win on match count)
    expect(_count(result, "HEAVY match")).toBe(15); // 5 groups × 3 lines
  });

  it("test_inter_match_exactly_10_groups_no_compression", () => {
    // Exactly 10 groups → threshold not exceeded → context-line stripping path, not group compression.
    const text = _rg_context_block(10, 1);
    const result = apply_filter(_F, { stdout: text, argv: ["rg", "-C", "1"] });
    // Context-line path appends the standard context-lines-suppressed marker
    expect(result).toContain("context lines suppressed");
    expect(result).not.toContain("more match groups suppressed");
  });

  it("test_inter_match_11_groups_triggers_compression", () => {
    // 11 groups × 3 matches = 43 lines > threshold → inter-match group compression.
    const text = _rg_match_groups(11, 3);
    const result = apply_filter(_F, { stdout: text, argv: ["rg", "match"] });
    expect(result).toContain("more match groups suppressed");
  });

  // -------------------------------------------------------------------------
  // -C 0 edge case
  // -------------------------------------------------------------------------

  it("test_C_zero_match_only_output_no_crash", () => {
    // -C 0 with many groups still runs without error.
    const text = _rg_match_groups(15, 1);
    const result = apply_filter(_F, { stdout: text, argv: ["rg", "-C", "0", "match"] });
    expect(typeof result).toBe("string");
    expect(result.length).toBeGreaterThan(0);
  });

  it("test_C_zero_few_groups_passthrough_or_sep_strip", () => {
    // -C 0, only 4 groups (≤10), large output (many lines built manually) → no group compression.
    const many_matches = Array.from({ length: 50 }, (_v, i) => `src/f.py:${i}:match`).join("\n");
    const result = apply_filter(_F, { stdout: many_matches, argv: ["rg", "-C", "0"] });
    // No -- separators → passes through unchanged
    expect(result).toBe(many_matches);
  });

  // -------------------------------------------------------------------------
  // _is_files_only / _is_count_only unit tests
  // -------------------------------------------------------------------------

  it("test_is_files_only_true_short", () => {
    expect(RgFilter._is_files_only(["-l"])).toBe(true);
  });

  it("test_is_files_only_true_long", () => {
    expect(RgFilter._is_files_only(["--files-with-matches"])).toBe(true);
  });

  it("test_is_files_only_false", () => {
    expect(RgFilter._is_files_only(["rg", "-C", "3"])).toBe(false);
  });

  it("test_is_count_only_true_short", () => {
    expect(RgFilter._is_count_only(["-c"])).toBe(true);
  });

  it("test_is_count_only_true_long", () => {
    expect(RgFilter._is_count_only(["--count"])).toBe(true);
  });

  it("test_is_count_only_false", () => {
    expect(RgFilter._is_count_only(["rg", "pattern"])).toBe(false);
  });
});
