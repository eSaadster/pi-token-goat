/**
 * Tests for RgFilter: context-line suppression for rg/grep -C/-A/-B output.
 *
 * 1:1 port of tests/test_bash_compress_rg_filter.py. Every Python `def test_*`
 * maps to a vitest `it()` with the SAME name and assertion polarity.
 *
 * Test-seam mapping (Python -> TS):
 *  - `from filter_test_helpers import apply_filter`
 *      -> local `apply_filter(filter, opts?)` helper below (port of
 *        filter_test_helpers.apply_filter: runs `filter_.apply(...).text`,
 *        defaulting argv to `[filter_.name]`).
 *  - `from token_goat import bash_compress as bc`
 *      -> import the barrel "../src/token_goat/bash_compress.js" (re-exports the
 *        framework + RgFilter).
 *  - Module-level `_F = bc.RgFilter()` -> `const _F = new RgFilter()`.
 *  - `_F.binaries` / `_F.name` are instance fields, accessed directly.
 *
 * Byte-exactness: the fixtures are pure ASCII, so substring / equality checks
 * translate directly; no Buffer/utf8 arithmetic is needed.
 */
import { describe, expect, it } from "vitest";

import { RgFilter } from "../src/token_goat/bash_compress.js";

import type { Filter } from "../src/token_goat/bash_compress.js";

const _F = new RgFilter();

// ---------------------------------------------------------------------------
// Local apply_filter helper (port of filter_test_helpers.apply_filter).
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

function _plain_rg_output(n_lines = 50): string {
  // Build plain rg output (match lines only, no context separators).
  return Array.from({ length: n_lines }, (_v, i) => `src/foo.py:${i}:match content here`).join(
    "\n",
  );
}

// ---------------------------------------------------------------------------
// Short output passes through unchanged
// ---------------------------------------------------------------------------

describe("test_bash_compress_rg_filter", () => {
  it("test_short_output_passthrough", () => {
    // Output with ≤30 lines passes through even when -- separators exist.
    const text = "src/a.py:1:match\n--\nsrc/a.py-2-context\nsrc/a.py:3:match";
    const result = apply_filter(_F, { stdout: text, argv: ["rg"] });
    expect(result).toBe(text);
  });

  it("test_empty_output_passthrough", () => {
    const result = apply_filter(_F, { stdout: "", argv: ["rg"] });
    expect(result).toBe("");
  });

  // -------------------------------------------------------------------------
  // No context separator → passthrough regardless of size
  // -------------------------------------------------------------------------

  it("test_no_separator_large_output_passthrough", () => {
    // Large rg output without -- separators is not modified.
    const text = _plain_rg_output(60);
    const result = apply_filter(_F, { stdout: text, argv: ["rg"] });
    expect(result).toBe(text);
  });

  it("test_no_separator_grep_plain_passthrough", () => {
    // Plain grep output (no -C) passes through unchanged.
    const text = Array.from({ length: 40 }, (_v, i) => `file${i}.py:10:found`).join("\n");
    const result = apply_filter(_F, { stdout: text, argv: ["grep"] });
    expect(result).toBe(text);
  });

  // -------------------------------------------------------------------------
  // Context lines stripped when output > 30 lines
  // -------------------------------------------------------------------------

  it("test_context_lines_stripped_large_output", () => {
    // Context lines and -- separators removed when output exceeds threshold.
    const text = _rg_context_block(6, 3);
    const result = apply_filter(_F, { stdout: text, argv: ["rg", "-C", "3", "MATCH", "src/"] });
    expect(result.split("\n").includes("--")).toBe(false);
    // context lines (dash-linenum-dash pattern) are gone.
    //
    // Python:
    //   assert not any(
    //       line and not line.startswith("[")
    //       and "-" in line
    //       and ":" not in line.split("-")[1] if "-" in line else False
    //       for line in result.split("\n")
    //   )
    // The conditional expression binds the whole boolean chain as the truthy
    // branch and `False` as the else; the guard is `"-" in line`. line.split("-")
    // (no maxsplit) -> array; index [1] is the second element. Python `and`
    // returns the last truthy operand / first falsy operand, but `any()` only
    // cares about truthiness, so a strict boolean reproduction is faithful.
    const any = result.split("\n").some((line) => {
      if (line.includes("-")) {
        return (
          Boolean(line) &&
          !line.startsWith("[") &&
          line.includes("-") &&
          !line.split("-")[1]!.includes(":")
        );
      }
      return false;
    });
    expect(any).toBe(false);
  });

  it("test_match_lines_preserved", () => {
    // Match lines (path:linenum:content) are kept after stripping.
    const text = _rg_context_block(6, 3);
    const result = apply_filter(_F, { stdout: text, argv: ["rg", "-C", "3"] });
    const match_lines = result.split("\n").filter((ln) => ln.includes("MATCH line"));
    expect(match_lines.length).toBe(6);
  });

  it("test_separator_lines_removed", () => {
    // -- group separator lines are removed from output.
    const text = _rg_context_block(6, 3);
    const result = apply_filter(_F, { stdout: text, argv: ["rg", "-C", "3"] });
    expect(result.split("\n").includes("--")).toBe(false);
  });

  it("test_suppressed_count_in_marker", () => {
    // Marker reports the correct number of suppressed lines.
    const text = _rg_context_block(5, 3);
    const result = apply_filter(_F, { stdout: text, argv: ["rg", "-C", "3"] });
    const marker = result.split("\n").find((ln) => ln.includes("token-goat"))!;
    // 5 groups × 6 context lines + 4 -- separators between groups = 34 suppressed
    expect(marker).toContain("34 context lines suppressed");
  });

  it("test_marker_format_contains_hint", () => {
    // Marker includes actionable hint about -l and -C/-A/-B flags.
    const text = _rg_context_block(6, 3);
    const result = apply_filter(_F, { stdout: text, argv: ["rg", "-C", "3"] });
    expect(result).toContain("-l");
    expect(result).toContain("-C/-A/-B");
  });

  // -------------------------------------------------------------------------
  // grep binary dispatch
  // -------------------------------------------------------------------------

  it("test_grep_binary_dispatches_to_rg_filter", () => {
    // grep is handled by RgFilter (binaries includes grep).
    expect(_F.binaries.has("grep")).toBe(true);
  });

  it("test_grep_context_output_stripped", () => {
    // grep -C output is stripped the same way as rg -C output.
    const text = _rg_context_block(6, 3);
    const result = apply_filter(_F, { stdout: text, argv: ["grep", "-C", "3", "MATCH"] });
    expect(result).toContain("token-goat");
    expect(result.split("\n").includes("--")).toBe(false);
  });

  // -------------------------------------------------------------------------
  // Edge cases
  // -------------------------------------------------------------------------

  it("test_rg_binary_in_filter_binaries", () => {
    // rg is in RgFilter.binaries.
    expect(_F.binaries.has("rg")).toBe(true);
  });

  it("test_filter_name_is_rg", () => {
    expect(_F.name).toBe("rg");
  });

  it("test_no_suppression_when_only_match_lines_and_separator", () => {
    // If -- separators present but no context lines, nothing suppressed.
    // Build output where all non-separator lines are match lines
    const lines: string[] = [];
    for (let i = 0; i < 15; i += 1) {
      lines.push("src/a.py:1:match", "--", "src/b.py:1:match");
    }
    const text = lines.join("\n");
    const result = apply_filter(_F, { stdout: text, argv: ["rg", "-C", "0"] });
    // separators still get stripped (they're caught by the sep branch)
    expect(result.includes("token-goat") || result === text).toBe(true);
  });
});
