/**
 * Tests for TailTruncFilter — the safety-net last-resort tail truncation filter
 * that ships in the bash_compress FRAMEWORK (Run 9).
 *
 * 1:1 port of tests/test_bash_compress_tail_trunc.py. Every Python `def test_*`
 * maps to a vitest `it()` with the SAME name and assertion polarity; the single
 * Python test class TestTailTruncFilter maps to a `describe()` block of the same
 * name.
 *
 * Test-seam mapping (Python -> TS):
 *  - `from token_goat.bash_compress import FILTERS, TailTruncFilter`
 *      -> import { FILTERS, TailTruncFilter } from the barrel
 *         "../src/token_goat/bash_compress.js".
 *  - The Python `setup_method` builds `self.flt = TailTruncFilter()` once per
 *    test; ported to a fresh `const flt = new TailTruncFilter()` inside each
 *    `it()` (the filter instance is stateless across calls, so a fresh instance
 *    per test is byte-equivalent to the Python setup_method pattern and avoids
 *    any shared-mutation surprise).
 *  - The Python tests call `self.flt.compress(stdout, stderr, exit_code, argv)`
 *    directly and treat the return value as a STRING (the Python Filter.compress
 *    returns `str`, NOT a CompressedOutput wrapper). The TS Filter.compress()
 *    likewise returns `string` directly (see framework.ts TailTruncFilter.compress
 *    -> returns `string`). So we call `flt.compress(...)` directly and read the
 *    returned string — NO `.text` accessor here (that is only on apply()).
 *  - `isinstance(f, TailTruncFilter)` -> `f instanceof TailTruncFilter`.
 *  - `TailTruncFilter.binaries == frozenset()` ->
 *    `new TailTruncFilter().binaries.size === 0` (binaries is an empty
 *    ReadonlySet<string>; a Set with no entries is the frozenset() parity).
 *  - `FILTERS[-1]` -> `FILTERS[FILTERS.length - 1]`.
 *
 * Byte-exactness: the fixtures are pure ASCII (`"line {i}"` for i in range(n),
 * joined with "\n"). The filter splits its input on "\n" (NOT splitlines() — see
 * framework.ts TailTruncFilter.compress comment, which deliberately mirrors the
 * Python merged.split("\n")). _make_stdout joins with "\n", so Python `len(s)`
 * (code points) == JS `.length` == the line-splitting the filter performs. No
 * Buffer arithmetic or bare-CR handling is needed for these inputs.
 *
 * The 501/500/600/700-line boundary checks rely on the filter's hardcoded
 * `lines.length <= 500` threshold and the `lines.length - 100` suppressed count
 * (50 head + 1 marker + 50 tail = 101 emitted lines). These constants are the
 * single source of truth for TailTruncFilter and are asserted verbatim.
 */
import { describe, expect, it } from "vitest";

import { FILTERS, TailTruncFilter } from "../src/token_goat/bash_compress.js";

// ---------------------------------------------------------------------------
// _make_stdout(n_lines): port of the Python module-level helper of the same
// name. Produces n_lines lines "line 0".."line {n-1}" joined with "\n" (NO
// trailing newline — matches the Python "\n".join(...) exactly, so the line
// count after .split("\n") is exactly n_lines).
// ---------------------------------------------------------------------------
function _make_stdout(nLines: number): string {
  const lines: string[] = [];
  for (let i = 0; i < nLines; i++) {
    lines.push(`line ${i}`);
  }
  return lines.join("\n");
}

// ===========================================================================
// TestTailTruncFilter
// ===========================================================================

describe("TestTailTruncFilter", () => {
  it("test_over_500_lines_truncated", () => {
    const flt = new TailTruncFilter();
    const stdout = _make_stdout(600);
    const result = flt.compress(stdout, "", 0, ["somecommand"]);
    const lines = result.split("\n");
    expect(lines.some((ln) => ln.includes("lines suppressed"))).toBe(true);
    expect(result).toContain("TOKEN_GOAT_BASH_COMPRESS=0");
  });

  it("test_exactly_501_lines_truncated", () => {
    const flt = new TailTruncFilter();
    const stdout = _make_stdout(501);
    const result = flt.compress(stdout, "", 0, ["somecommand"]);
    expect(result).toContain("lines suppressed");
  });

  it("test_exactly_500_lines_passthrough", () => {
    const flt = new TailTruncFilter();
    const stdout = _make_stdout(500);
    const result = flt.compress(stdout, "", 0, ["somecommand"]);
    expect(result).not.toContain("lines suppressed");
    expect(result).toBe(stdout);
  });

  it("test_under_500_lines_passthrough", () => {
    const flt = new TailTruncFilter();
    const stdout = _make_stdout(100);
    const result = flt.compress(stdout, "", 0, ["somecommand"]);
    expect(result).toBe(stdout);
  });

  it("test_empty_stdout_passthrough", () => {
    const flt = new TailTruncFilter();
    const result = flt.compress("", "", 0, ["cmd"]);
    expect(result).toBe("");
  });

  it("test_suppressed_count_is_correct", () => {
    const flt = new TailTruncFilter();
    const n = 700;
    const stdout = _make_stdout(n);
    const result = flt.compress(stdout, "", 0, ["cmd"]);
    const expectedSuppressed = n - 100;
    expect(result).toContain(`${expectedSuppressed} lines suppressed`);
  });

  it("test_first_50_lines_preserved", () => {
    const flt = new TailTruncFilter();
    const stdout = _make_stdout(600);
    const result = flt.compress(stdout, "", 0, ["cmd"]);
    expect(result).toContain("line 0");
    expect(result).toContain("line 49");
  });

  it("test_last_50_lines_preserved", () => {
    const flt = new TailTruncFilter();
    const stdout = _make_stdout(600);
    const result = flt.compress(stdout, "", 0, ["cmd"]);
    expect(result).toContain("line 550");
    expect(result).toContain("line 599");
  });

  it("test_middle_lines_suppressed", () => {
    const flt = new TailTruncFilter();
    const stdout = _make_stdout(600);
    const result = flt.compress(stdout, "", 0, ["cmd"]);
    // before marker — the head section (before the first "[" of the marker)
    expect(result.split("[")[0]).not.toContain("line 50");
    // after marker — the tail section (after the last "]" of the marker)
    expect(result.split("]").slice(-1)[0]).not.toContain("line 549");
  });

  it("test_output_line_count_is_101", () => {
    // 50 head + 1 marker + 50 tail = 101 lines
    const flt = new TailTruncFilter();
    const stdout = _make_stdout(600);
    const result = flt.compress(stdout, "", 0, ["cmd"]);
    expect(result.split("\n").length).toBe(101);
  });

  it("test_matches_always_returns_true", () => {
    const flt = new TailTruncFilter();
    expect(flt.matches([])).toBe(true);
    expect(flt.matches(["anything"])).toBe(true);
    expect(flt.matches(["python", "-m", "pytest"])).toBe(true);
  });

  it("test_binaries_is_empty_frozenset", () => {
    expect(new TailTruncFilter().binaries.size).toBe(0);
  });

  it("test_is_last_in_filters", () => {
    expect(FILTERS[FILTERS.length - 1] instanceof TailTruncFilter).toBe(true);
  });

  it("test_only_one_tail_trunc_filter_in_filters", () => {
    const tailFilters = FILTERS.filter((f) => f instanceof TailTruncFilter);
    expect(tailFilters.length).toBe(1);
  });
});
