/**
 * Tests for GoTestFilter enhanced compression (iteration-116).
 *
 * 1:1 port of tests/test_bash_compress_go_enhanced.py. Every Python `def test_*`
 * maps to a vitest `it()` with the SAME name and assertion polarity; the Python
 * test classes map to `describe()` blocks of the same name.
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
 * `.split("\n")` (the inputs use single "\n" only). Tab-separated FAIL package
 * lines preserve the literal "\t" byte exactly.
 *
 * No deferral: GoTestFilter is ported and exported by the barrel.
 */
import { describe, expect, it } from "vitest";

import { GoTestFilter } from "../src/token_goat/bash_compress.js";

function _compress(inp: string, argv?: string[]): string {
  return new GoTestFilter().compress(inp, "", 0, argv ?? ["go", "test", "./..."]);
}

// ---------------------------------------------------------------------------
// === RUN / PAUSE / CONT suppression (unconditional)
// ---------------------------------------------------------------------------

describe("TestRunPauseContSuppressed", () => {
  it("test_run_suppressed", () => {
    const inp = "=== RUN   TestAlpha\n--- PASS: TestAlpha (0.00s)\nok  github.com/x/pkg  0.001s";
    const lines = _compress(inp).split("\n");
    expect(lines.some((ln) => ln.startsWith("=== RUN"))).toBe(false);
  });

  it("test_pause_suppressed", () => {
    const inp =
      "=== RUN   TestBeta\n=== PAUSE TestBeta\n=== CONT  TestBeta\n--- PASS: TestBeta (0.00s)\nok  github.com/x/pkg  0.001s";
    const lines = _compress(inp).split("\n");
    expect(lines.some((ln) => ln.startsWith("=== PAUSE"))).toBe(false);
  });

  it("test_cont_suppressed", () => {
    const inp =
      "=== RUN   TestGamma\n=== PAUSE TestGamma\n=== CONT  TestGamma\n--- PASS: TestGamma (0.00s)\nok  github.com/x/pkg  0.001s";
    const lines = _compress(inp).split("\n");
    expect(lines.some((ln) => ln.startsWith("=== CONT"))).toBe(false);
  });

  it("test_rpc_suppressed_inside_failing_package", () => {
    // RUN/PAUSE/CONT must be suppressed even when surrounded by fail output
    const inp = [
      "=== RUN   TestFail",
      "=== PAUSE TestFail",
      "=== CONT  TestFail",
      "--- FAIL: TestFail (0.01s)",
      "    fail_test.go:10: boom",
      "FAIL\tgithub.com/x/pkg\t0.01s",
    ].join("\n");
    const lines = _compress(inp).split("\n");
    expect(
      lines.some(
        (ln) =>
          ln.startsWith("=== RUN") || ln.startsWith("=== PAUSE") || ln.startsWith("=== CONT"),
      ),
    ).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Package summary lines preserved
// ---------------------------------------------------------------------------

describe("TestPackageSummaryPreserved", () => {
  it("test_ok_summary_kept", () => {
    const inp = "=== RUN   TestX\n--- PASS: TestX (0.00s)\nok  github.com/org/pkg  0.3s";
    expect(_compress(inp)).toContain("ok  github.com/org/pkg  0.3s");
  });

  it("test_fail_pkg_line_kept", () => {
    const inp = [
      "=== RUN   TestX",
      "--- FAIL: TestX (0.01s)",
      "    x_test.go:5: oops",
      "FAIL\tgithub.com/org/pkg\t0.01s",
    ].join("\n");
    expect(_compress(inp)).toContain("FAIL\tgithub.com/org/pkg\t0.01s");
  });
});

// ---------------------------------------------------------------------------
// Failing package: keep --- FAIL + output, suppress --- PASS
// ---------------------------------------------------------------------------

describe("TestFailingPackageOutput", () => {
  it("test_fail_block_kept", () => {
    const inp = [
      "--- FAIL: TestBad (0.05s)",
      "    bad_test.go:12: expected true, got false",
      "FAIL\tgithub.com/x/pkg\t0.05s",
    ].join("\n");
    const out = _compress(inp);
    expect(out).toContain("--- FAIL: TestBad");
    expect(out).toContain("expected true, got false");
  });

  it("test_pass_suppressed_within_failing_package", () => {
    // A package with both passing and failing tests: --- PASS suppressed
    const inp = [
      "--- PASS: TestOk (0.00s)",
      "--- FAIL: TestBad (0.05s)",
      "    bad_test.go:12: boom",
      "FAIL\tgithub.com/x/pkg\t0.05s",
    ].join("\n");
    const out = _compress(inp);
    expect(out).not.toContain("--- PASS: TestOk");
    expect(out).toContain("--- FAIL: TestBad");
  });

  it("test_fail_output_lines_preserved", () => {
    const inp = [
      "--- FAIL: TestX (0.01s)",
      "    panic: nil pointer",
      "    goroutine 1 [running]:",
      "FAIL\tgithub.com/x/pkg\t0.01s",
    ].join("\n");
    const out = _compress(inp);
    expect(out).toContain("panic: nil pointer");
  });
});

// ---------------------------------------------------------------------------
// Aggregate summary: multi-package vs single-package
// ---------------------------------------------------------------------------

describe("TestAggregateMultiPackage", () => {
  it("test_mixed_pass_fail_aggregate", () => {
    const inp = ["ok  github.com/x/pkga  0.1s", "FAIL\tgithub.com/x/pkgb\t0.2s", "FAIL"].join("\n");
    const out = _compress(inp);
    expect(out).toContain("1 packages passed");
    expect(out).toContain("1 packages failed");
  });

  it("test_all_pass_multi_package_aggregate", () => {
    // All packages pass → aggregate still emitted for multi-package
    const inp = [
      "ok  github.com/x/pkga  0.1s",
      "ok  github.com/x/pkgb  0.2s",
      "ok  github.com/x/pkgc  0.3s",
    ].join("\n");
    const out = _compress(inp);
    expect(out).toContain("3 packages passed");
    expect(out).toContain("0 packages failed");
  });

  it("test_all_fail_multi_package_aggregate", () => {
    // All packages fail → aggregate emitted
    const inp = [
      "--- FAIL: TestA (0.01s)",
      "    a_test.go:1: err",
      "FAIL\tgithub.com/x/pkga\t0.01s",
      "--- FAIL: TestB (0.01s)",
      "    b_test.go:1: err",
      "FAIL\tgithub.com/x/pkgb\t0.01s",
      "FAIL",
    ].join("\n");
    const out = _compress(inp);
    expect(out).toContain("0 packages passed");
    expect(out).toContain("2 packages failed");
  });

  it("test_exactly_two_packages_aggregate", () => {
    const inp = ["ok  github.com/x/pkga  0.1s", "ok  github.com/x/pkgb  0.2s"].join("\n");
    const out = _compress(inp);
    expect(out).toContain("packages passed");
  });

  it("test_single_package_no_aggregate", () => {
    const inp = "ok  github.com/x/pkg  0.3s";
    const out = _compress(inp);
    expect(out).not.toContain("packages passed");
    expect(out).not.toContain("packages failed");
  });

  it("test_single_failing_package_no_aggregate", () => {
    const inp = [
      "--- FAIL: TestX (0.01s)",
      "    x_test.go:1: fail",
      "FAIL\tgithub.com/x/pkg\t0.01s",
      "FAIL",
    ].join("\n");
    const out = _compress(inp);
    expect(out).not.toContain("packages passed");
    expect(out).not.toContain("packages failed");
  });
});
