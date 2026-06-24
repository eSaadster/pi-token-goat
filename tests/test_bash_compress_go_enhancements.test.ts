/**
 * Tests for GoTestFilter iteration-105 enhancements.
 *
 * 1:1 port of tests/test_bash_compress_go_enhancements.py. Every Python
 * `def test_*` maps to a vitest `it()` with the SAME name and assertion polarity;
 * the Python test classes map to `describe()` blocks of the same name.
 *
 * Test-seam mapping (Python -> TS):
 *  - `from token_goat.bash_compress import GoTestFilter`
 *      -> import GoTestFilter from the barrel "../src/token_goat/bash_compress.js".
 *  - `_compress(inp, argv=None)` -> a local helper that builds a GoTestFilter and
 *    calls compress(inp, "", 0, argv ?? ["go", "test", "./..."]).
 *
 * Byte-exactness: GoTestFilter operates on whole lines; the assertions are
 * substring / startsWith / splitlines checks matching the Python `in` / `not in`
 * / `.startswith` / `.splitlines()` checks. Python `str.splitlines()` -> TS
 * `.split("\n")`. The tab-separated FAIL package line keeps the literal "\t".
 *
 * No deferral: GoTestFilter is ported and exported by the barrel.
 */
import { describe, expect, it } from "vitest";

import { GoTestFilter } from "../src/token_goat/bash_compress.js";

function _compress(inp: string, argv?: string[]): string {
  return new GoTestFilter().compress(inp, "", 0, argv ?? ["go", "test", "./..."]);
}

// ---------------------------------------------------------------------------
// === RUN / PAUSE / CONT suppression
// ---------------------------------------------------------------------------

describe("TestGoRunPauseContSuppression", () => {
  it("test_run_lines_suppressed", () => {
    const inp = [
      "=== RUN   TestFoo",
      "--- PASS: TestFoo (0.00s)",
      "ok  github.com/org/pkg  0.001s",
    ].join("\n");
    const out = _compress(inp);
    // Assert the actual RUN line is absent (note text contains "=== RUN" — check lines only)
    expect(out.split("\n").some((line) => line.startsWith("=== RUN"))).toBe(false);
  });

  it("test_pause_lines_suppressed", () => {
    const inp = [
      "=== RUN   TestBar",
      "=== PAUSE TestBar",
      "=== CONT  TestBar",
      "--- PASS: TestBar (0.00s)",
      "ok  github.com/org/pkg  0.001s",
    ].join("\n");
    const out = _compress(inp);
    expect(out.split("\n").some((line) => line.startsWith("=== PAUSE"))).toBe(false);
  });

  it("test_cont_lines_suppressed", () => {
    const inp = [
      "=== RUN   TestBaz",
      "=== PAUSE TestBaz",
      "=== CONT  TestBaz",
      "--- PASS: TestBaz (0.00s)",
      "ok  github.com/org/pkg  0.001s",
    ].join("\n");
    const out = _compress(inp);
    expect(out.split("\n").some((line) => line.startsWith("=== CONT"))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Package summary lines kept
// ---------------------------------------------------------------------------

describe("TestGoPackageSummaryLines", () => {
  it("test_ok_package_summary_kept", () => {
    const inp = [
      "=== RUN   TestFoo",
      "--- PASS: TestFoo (0.00s)",
      "ok  github.com/org/pkg  0.123s",
    ].join("\n");
    const out = _compress(inp);
    expect(out).toContain("ok  github.com/org/pkg  0.123s");
  });

  it("test_fail_package_line_kept", () => {
    const inp = [
      "=== RUN   TestFoo",
      "--- FAIL: TestFoo (0.01s)",
      "    foo_test.go:5: assertion failed",
      "FAIL\tgithub.com/org/pkg\t0.123s",
    ].join("\n");
    const out = _compress(inp);
    expect(out).toContain("FAIL\tgithub.com/org/pkg\t0.123s");
  });
});

// ---------------------------------------------------------------------------
// Aggregate summary for multi-package runs
// ---------------------------------------------------------------------------

describe("TestGoAggregateMultiPackage", () => {
  it("test_aggregate_summary_two_packages", () => {
    // Mixed pass/fail → aggregate line appended
    const inp = [
      "ok  github.com/org/pkga  0.1s",
      "FAIL\tgithub.com/org/pkgb\t0.2s",
      "FAIL",
    ].join("\n");
    const out = _compress(inp);
    expect(out).toContain("packages passed");
    expect(out).toContain("packages failed");
  });

  it("test_no_aggregate_single_package", () => {
    const inp = "ok  github.com/org/pkg  0.123s";
    const out = _compress(inp);
    expect(out).not.toContain("packages passed");
    expect(out).not.toContain("packages failed");
  });
});
