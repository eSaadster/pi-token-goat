/**
 * Large-scale and edge-case tests for CargoFilter's three compression passes.
 *
 * 1:1 port of tests/test_bash_compress_cargo_enhanced.py. Each Python test class
 * maps to a vitest `describe()` of the same name; each `def test_*` maps to an
 * `it()` with the SAME name and assertion polarity.
 *
 * Test-seam mapping (Python -> TS):
 *   - `from token_goat.bash_compress import CargoFilter`
 *       -> import { CargoFilter } from the barrel "../src/token_goat/bash_compress.js".
 *   - `_compress(stdout, stderr, subcommand, exit_code)`
 *       -> the same helper; Python's
 *         `CargoFilter().compress(stdout, stderr, exit_code, ["cargo", subcommand])`
 *         maps directly onto the TS `compress(stdout, stderr, exit_code, argv)`
 *         signature.
 */
import { describe, expect, it } from "vitest";

import { CargoFilter } from "../src/token_goat/bash_compress.js";

function _compress(
  stdout: string,
  stderr = "",
  subcommand = "build",
  exit_code = 0,
): string {
  return new CargoFilter().compress(stdout, stderr, exit_code, ["cargo", subcommand]);
}

describe("TestCompilingSentinelLargeScale", () => {
  // Pass A: >=3 Compiling lines collapse to a single sentinel.

  it("test_50_compiling_lines_produce_single_sentinel", () => {
    const lines = Array.from(
      { length: 50 },
      (_, i) => `   Compiling crate_${i} v0.1.${i} (/tmp/crate_${i})`,
    );
    const out = _compress(lines.join("\n"));
    expect(out).toContain("[compiling 50 crates");
    // No individual Compiling line should survive
    expect(out).not.toContain("Compiling crate_0");
    expect(out).not.toContain("Compiling crate_49");
  });

  it("test_sentinel_count_exact_for_50", () => {
    const lines = Array.from(
      { length: 50 },
      (_, i) => `   Compiling dep_${i} v0.2.${i} (/home/user)`,
    );
    const out = _compress(lines.join("\n"));
    expect(out).toContain("[compiling 50 crates");
    expect(out).not.toContain("[compiling 49");
    expect(out).not.toContain("[compiling 51");
  });

  it("test_sentinel_appears_before_other_output", () => {
    const lines = Array.from(
      { length: 50 },
      (_, i) => `   Compiling crate_${i} v0.1.0 (/tmp)`,
    );
    lines.push("error[E0001]: something went wrong");
    const out = _compress(lines.join("\n"), "", "build", 1);
    const sentinel_pos = out.indexOf("[compiling 50 crates");
    const error_pos = out.indexOf("error[E0001]");
    expect(sentinel_pos).toBeLessThan(error_pos);
  });
});

describe("TestTestPassSentinelLargeScale", () => {
  // Pass B: 'test ... ok' lines collapse to per-binary [N tests passed] sentinel.

  it("test_198_passing_plus_2_failing_produces_sentinel_and_keeps_failures", () => {
    const lines = Array.from({ length: 198 }, (_, i) => `test module::test_${i} ... ok`);
    lines.push("test module::fail_a ... FAILED");
    lines.push("test module::fail_b ... FAILED");
    const stdout = lines.join("\n");
    const out = _compress(stdout, "", "test", 1);
    // Failures are always kept
    expect(out).toContain("test module::fail_a ... FAILED");
    expect(out).toContain("test module::fail_b ... FAILED");
    // Pass sentinel present
    expect(out).toContain("[198 tests passed]");
    // No individual passing line should survive
    expect(out).not.toContain("test module::test_0 ... ok");
    expect(out).not.toContain("test module::test_197 ... ok");
  });

  it("test_200_passing_no_failures_produces_sentinel", () => {
    const lines = Array.from({ length: 200 }, (_, i) => `test ns::test_${i} ... ok`);
    const stdout = lines.join("\n");
    const out = _compress(stdout, "", "test");
    expect(out).toContain("[200 tests passed]");
    expect(out).not.toContain("test ns::test_0 ... ok");
  });

  it("test_only_failures_no_sentinel_appended_when_zero_pass", () => {
    const lines = ["test a::b ... FAILED", "test a::c ... FAILED"];
    const stdout = lines.join("\n");
    const out = _compress(stdout, "", "test", 1);
    expect(out).toContain("test a::b ... FAILED");
    expect(out).toContain("test a::c ... FAILED");
    expect(out).not.toContain("tests passed]");
  });
});

describe("TestFinishedPreambleSuppression", () => {
  // Pass C: 'Finished ...' suppressed on clean build; kept before a failure line.

  it("test_finished_at_end_of_clean_build_suppressed", () => {
    const lines = Array.from({ length: 5 }, (_, i) => `   Compiling crate_${i} v0.1.0 (/tmp)`);
    lines.push("    Finished dev [unoptimized + debuginfo] target(s) in 4.2s");
    const out = _compress(lines.join("\n"));
    expect(out).not.toContain("Finished dev");
    expect(out).toContain("[compiling 5 crates");
  });

  it("test_finished_before_failure_line_is_kept", () => {
    const lines = Array.from({ length: 4 }, (_, i) => `   Compiling crate_${i} v0.1.0 (/tmp)`);
    lines.push(
      "    Finished dev [unoptimized + debuginfo] target(s) in 2.1s",
      "error[E0308]: mismatched types",
    );
    const out = _compress(lines.join("\n"), "", "build", 1);
    expect(out).toContain("Finished dev");
    expect(out).toContain("error[E0308]");
  });

  it("test_finished_before_aborting_line_is_kept", () => {
    const lines = Array.from({ length: 3 }, (_, i) => `   Compiling c_${i} v0.1.0 (/tmp)`);
    lines.push(
      "    Finished release [optimized] target(s) in 10.0s",
      "error[E0505]: FAILED something",
    );
    const out = _compress(lines.join("\n"), "", "build", 1);
    expect(out).toContain("Finished release");
  });

  it("test_finished_release_suppressed_on_clean_build", () => {
    const lines = Array.from(
      { length: 6 },
      (_, i) => `   Compiling pkg_${i} v1.0.${i} (/workspace)`,
    );
    lines.push("    Finished release [optimized] target(s) in 30.0s");
    const out = _compress(lines.join("\n"));
    expect(out).not.toContain("Finished release");
  });
});

describe("TestRunningUnitTestsPreambleSuppression", () => {
  // 'Running unittests ...' kept before failure; suppressed on clean pass.

  it("test_running_unittests_suppressed_in_passing_test_run", () => {
    const stderr = [
      ...Array.from({ length: 4 }, (_, i) => `   Compiling dep_${i} v0.1.0 (/tmp)`),
      "    Finished test [unoptimized + debuginfo] target(s) in 2s",
      "     Running unittests src/lib.rs (target/debug/deps/mylib-abc123)",
    ].join("\n");
    const stdout = [
      "running 3 tests",
      "test util::a ... ok",
      "test util::b ... ok",
      "test util::c ... ok",
      "",
      "test result: ok. 3 passed; 0 failed; 0 ignored",
    ].join("\n");
    const out = _compress(stdout, stderr, "test");
    expect(out).not.toContain("Running unittests");
    expect(out).toContain("test result: ok.");
  });

  it("test_running_unittests_kept_when_test_fails", () => {
    const stderr = [
      ...Array.from({ length: 4 }, (_, i) => `   Compiling dep_${i} v0.1.0 (/tmp)`),
      "    Finished test [unoptimized + debuginfo] target(s) in 2s",
      "     Running unittests src/lib.rs (target/debug/deps/mylib-abc123)",
    ].join("\n");
    const stdout = [
      "running 2 tests",
      "test util::pass_case ... ok",
      "test util::fail_case ... FAILED",
      "",
      "test result: FAILED. 1 passed; 1 failed; 0 ignored",
    ].join("\n");
    const out = _compress(stdout, stderr, "test", 1);
    expect(out).toContain("Running unittests");
    expect(out).toContain("test util::fail_case ... FAILED");
  });
});
