/**
 * Tests for hunk density scoring and capping in diff filters.
 *
 * 1:1 port of tests/test_bash_compress_diff_scoring.py. Covers
 * _score_and_cap_hunks directly plus integration with DiffFilter and
 * _compress_git_diff_body for files that exceed max_hunks_per_file.
 *
 * Each Python `def test_*` maps to a vitest `it()` with the SAME name and
 * assertion polarity; each Python test class maps to a `describe()` of the same
 * name.
 *
 * Test-seam mapping (Python -> TS):
 *  - `import token_goat.bash_compress as bc` -> import the barrel
 *    "../src/token_goat/bash_compress.js" as `bc`. The barrel re-exports
 *    git_diff.js, so bc._score_and_cap_hunks and bc._compress_git_diff_body
 *    resolve to the ported free functions.
 *  - `from tests.filter_test_helpers import apply_filter` -> local `apply_filter`
 *    helper below (runs filter_.apply(...).text).
 *  - `unittest.mock.patch.object(config, "load", return_value=mock_cfg)` ->
 *    `vi.spyOn(config, "load").mockReturnValue(merged)` returning the real
 *    default config with bash_diff overridden (mirrors the Python MagicMock that
 *    sets bash_diff.hunk_density_cap / bash_diff.max_hunks_per_file explicitly).
 *
 * Deferral: DiffFilter (the NON-git unified-diff filter) is not yet ported — the
 * barrel exports GitDiffFilter but not DiffFilter, and there is no TS module for
 * it. The two TestDiffFilterDensityIntegration tests that construct
 * `bc.DiffFilter()` are therefore `it.skip`-ed with a "// PORT: deferred" marker
 * and counted in tests_skipped. They land verbatim when DiffFilter is ported.
 */
import { describe, expect, it, vi } from "vitest";

import * as bc from "../src/token_goat/bash_compress.js";
import * as config from "../src/token_goat/config.js";

// ---------------------------------------------------------------------------
// Helpers (ports of the module-level helpers in the Python test).
// ---------------------------------------------------------------------------

const _DENSITY_DEFAULT = 10;
void _DENSITY_DEFAULT; // parity: defined in the Python module; unused by tests.

/** Build lines for a single hunk with the given context/changed ratio. */
function _make_hunk(n_context: number, n_changed: number, index = 0): string[] {
  const lines = [
    `@@ -${index * 30 + 1},${n_context + n_changed} +${index * 30 + 1},${n_context + n_changed} @@`,
  ];
  for (let j = 0; j < n_context; j += 1) {
    lines.push(` context_${index}_${j}`);
  }
  for (let j = 0; j < Math.floor(n_changed / 2); j += 1) {
    lines.push(`-removed_${index}_${j}`);
    lines.push(`+added_${index}_${j}`);
  }
  return lines;
}

/** Wrap a set of hunk line-lists into a unified diff file block. */
function _make_file_block(filename: string, hunks: string[][]): string[] {
  const header = [`--- a/${filename}`, `+++ b/${filename}`];
  const out = [...header];
  for (const h of hunks) {
    out.push(...h);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Unit tests for _score_and_cap_hunks
// ---------------------------------------------------------------------------

describe("TestScoreAndCapHunks", () => {
  it("test_fewer_than_max_hunks_untouched", () => {
    // File with <= max_hunks leaves output unchanged.
    const hunks = Array.from({ length: 5 }, (_, i) => _make_hunk(8, 2, i));
    const block = _make_file_block("foo.py", hunks);
    const result = bc._score_and_cap_hunks(block, 10);
    expect(result).toEqual(block);
  });

  it("test_exactly_max_hunks_untouched", () => {
    // Exactly max_hunks hunks: no sentinel emitted.
    const hunks = Array.from({ length: 10 }, (_, i) => _make_hunk(8, 2, i));
    const block = _make_file_block("foo.py", hunks);
    const result = bc._score_and_cap_hunks(block, 10);
    expect(result).toEqual(block);
    expect(result.some((ln) => ln.includes("more hunks"))).toBe(false);
  });

  it("test_15_hunks_keeps_top_10", () => {
    // 15 hunks -> 10 emitted, 5 dropped.
    const hunks = Array.from({ length: 15 }, (_, i) => _make_hunk(8, 2, i));
    const block = _make_file_block("foo.py", hunks);
    const result = bc._score_and_cap_hunks(block, 10);
    const hunk_headers = result.filter((ln) => ln.startsWith("@@ "));
    expect(hunk_headers.length).toBe(10);
  });

  it("test_dropped_hunks_produce_single_sentinel", () => {
    // Dropped hunks are replaced by exactly one sentinel line.
    const hunks = Array.from({ length: 15 }, (_, i) => _make_hunk(8, 2, i));
    const block = _make_file_block("foo.py", hunks);
    const result = bc._score_and_cap_hunks(block, 10);
    const sentinels = result.filter((ln) => ln.includes("more hunks"));
    expect(sentinels.length).toBe(1);
  });

  it("test_sentinel_contains_count", () => {
    // Sentinel reports exactly how many hunks were dropped.
    const hunks = Array.from({ length: 15 }, (_, i) => _make_hunk(8, 2, i));
    const block = _make_file_block("foo.py", hunks);
    const result = bc._score_and_cap_hunks(block, 10);
    const sentinel = result.find((ln) => ln.includes("more hunks"))!;
    expect(sentinel).toContain("5 more hunks");
  });

  it("test_sentinel_contains_avg_density_rounded_2dp", () => {
    // Sentinel avg density is a 2-decimal float.
    const hunks = Array.from({ length: 15 }, (_, i) => _make_hunk(8, 2, i));
    const block = _make_file_block("foo.py", hunks);
    const result = bc._score_and_cap_hunks(block, 10);
    const sentinel = result.find((ln) => ln.includes("more hunks"))!;
    // density value must appear as X.XX
    expect(/avg density \d+\.\d{2}/.test(sentinel)).toBe(true);
  });

  it("test_high_density_hunk_kept_over_low_density", () => {
    // Hunk with 18/20 changed lines scores higher than one with 1/20 changed.
    const high_density = _make_hunk(2, 18, 0);
    const low_density = _make_hunk(19, 1, 1);
    // Build a file where only 1 slot is available, one hunk must drop
    const block = _make_file_block("foo.py", [high_density, low_density]);
    const result = bc._score_and_cap_hunks(block, 1);
    const kept = result.filter((ln) => ln.startsWith("@@ ") && ln.includes("0"));
    const dropped_sentinel = result.filter((ln) => ln.includes("more hunks"));
    expect(kept.length).toBeGreaterThan(0); // high-density hunk should be kept
    expect(dropped_sentinel.length).toBeGreaterThan(0); // low-density hunk should produce sentinel
    // Confirm the dropped hunk's low-density context makes it into the sentinel avg
    expect(dropped_sentinel[0]!).toContain("1 more hunks");
  });

  it("test_max_hunks_zero_keeps_all", () => {
    // max_hunks=0 disables the cap entirely — all hunks pass through.
    const hunks = Array.from({ length: 15 }, (_, i) => _make_hunk(8, 2, i));
    const block = _make_file_block("foo.py", hunks);
    const result = bc._score_and_cap_hunks(block, 0);
    expect(result).toEqual(block);
  });

  it("test_density_in_sentinel_is_2dp_float", () => {
    // Density is always formatted to exactly 2 decimal places.
    // Construct hunks with density exactly 1/3 to trigger non-integer rounding
    // 1 changed + 2 context = density 0.33...
    const hunks = Array.from({ length: 12 }, (_, i) => _make_hunk(18, 2, i));
    const block = _make_file_block("foo.py", hunks);
    const result = bc._score_and_cap_hunks(block, 10);
    const sentinel = result.find((ln) => ln.includes("more hunks")) ?? null;
    expect(sentinel).not.toBeNull();
    const m = /avg density (\d+\.\d+)/.exec(sentinel!);
    expect(m).not.toBeNull();
    // Must be exactly 2 decimal places
    expect(m![1]!.split(".")[1]!.length).toBe(2);
  });

  it("test_pure_whitespace_hunk_dropped_before_mixed", () => {
    // Hunk with density 0.05 is dropped before hunk with density 0.6.
    // density ~0.05: 1 changed / 20 total content lines
    const sparse = _make_hunk(19, 2, 0); // 2/21 content ~ 0.095
    // density ~0.6: 12 changed / 20 total content
    const dense = _make_hunk(8, 12, 1); // 12/20 = 0.6
    // Need 12 fillers at medium density so there are 14 hunks total
    const fillers = Array.from({ length: 12 }, (_, i) => _make_hunk(4, 6, i + 2)); // 6/10 = 0.6
    const block = _make_file_block("foo.py", [sparse, dense, ...fillers]);
    // keep 13 -> the 'sparse' hunk (lowest density) should drop
    const result = bc._score_and_cap_hunks(block, 13);
    // sparse hunk header contains 'index=0' context marker context_0_0
    const kept_sparse = result.some((ln) => ln.includes("context_0_0"));
    expect(kept_sparse).toBe(false); // pure-whitespace hunk should be dropped
  });

  it("test_kept_hunks_maintain_original_order", () => {
    // Kept hunks appear in original file order, not density order.
    // Alternating density: high(0), low(1), high(2), low(3) ... 12 total
    const hunks: string[][] = [];
    for (let i = 0; i < 12; i += 1) {
      if (i % 2 === 0) {
        hunks.push(_make_hunk(1, 9, i)); // high density
      } else {
        hunks.push(_make_hunk(9, 1, i)); // low density
      }
    }
    const block = _make_file_block("foo.py", hunks);
    const result = bc._score_and_cap_hunks(block, 10);
    const hunk_indices = result
      .filter((ln) => ln.startsWith(" context_") && ln.includes("_0"))
      .map((ln) => parseInt(ln.split("context_")[1]!.split("_")[0]!, 10));
    // Must be ascending (original order preserved)
    expect(hunk_indices).toEqual([...hunk_indices].sort((a, b) => a - b));
  });
});

// ---------------------------------------------------------------------------
// Integration: DiffFilter
//
// PORT: deferred — DiffFilter (the non-git unified-diff filter) is not yet
// ported. The barrel "../src/token_goat/bash_compress.js" exports GitDiffFilter
// but NOT DiffFilter, and there is no TS module for it. These tests construct
// `bc.DiffFilter()` and land verbatim once DiffFilter is ported and registered.
// Each preserves the Python name + assertion polarity for a 1:1 unskip.
// ---------------------------------------------------------------------------

describe("TestDiffFilterDensityIntegration", () => {
  it.skip("test_file_with_10_or_fewer_hunks_untouched", () => {
    // PORT: deferred — DiffFilter not yet ported.
  });

  it.skip("test_file_with_15_hunks_triggers_density_cap", () => {
    // PORT: deferred — DiffFilter not yet ported.
  });
});

// ---------------------------------------------------------------------------
// Integration: _compress_git_diff_body (GitDiffFilter path)
// ---------------------------------------------------------------------------

/** Build a git diff with n_hunks small hunks for one file. */
function _git_diff_block(n_hunks: number): string {
  const lines = ["diff --git a/foo.py b/foo.py", "--- a/foo.py", "+++ b/foo.py"];
  for (let i = 0; i < n_hunks; i += 1) {
    const start = i * 30 + 1;
    lines.push(`@@ -${start},10 +${start},10 @@`);
    for (let j = 0; j < 8; j += 1) {
      lines.push(` ctx_${i}_${j}`);
    }
    lines.push(`-old_${i}`);
    lines.push(`+new_${i}`);
  }
  return lines.join("\n");
}

describe("TestGitDiffFilterDensityIntegration", () => {
  it("test_git_diff_with_11_hunks_triggers_density_cap", () => {
    const diff = _git_diff_block(11);
    const result = bc._compress_git_diff_body(diff, "");
    expect(result).toContain("more hunks, avg density");
  });

  it("test_git_diff_with_10_hunks_untouched", () => {
    const diff = _git_diff_block(10);
    const result = bc._compress_git_diff_body(diff, "");
    expect(result).not.toContain("more hunks, avg density");
  });

  it("test_diff_with_15_hunks_not_capped_when_hunk_density_cap_disabled", () => {
    // When hunk_density_cap=False in config, 15 hunks are NOT reduced to 10.
    const diff = _git_diff_block(15);
    // Mock config.load() to return a config with hunk_density_cap=False
    const base = config.load();
    const merged = {
      ...base,
      bash_diff: {
        ...(base.bash_diff ?? {}),
        hunk_density_cap: false,
        max_hunks_per_file: 10,
      },
    };
    const spy = vi.spyOn(config, "load").mockReturnValue(merged);
    let result: string;
    try {
      result = bc._compress_git_diff_body(diff, "");
    } finally {
      spy.mockRestore();
    }
    // With hunk_density_cap=False, the density cap is skipped; result should have all 15 hunks
    const hunk_headers = result.split("\n").filter((ln) => ln.startsWith("@@ "));
    expect(hunk_headers.length).toBe(15);
    expect(result).not.toContain("more hunks, avg density");
  });
});
