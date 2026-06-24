/**
 * Tests for CargoFilter iteration-105 enhancements: Pass A, B, C.
 *
 * 1:1 port of tests/test_bash_compress_cargo_enhancements.py. Each Python test
 * class maps to a vitest `describe()` of the same name; each `def test_*` maps
 * to an `it()` with the SAME name and assertion polarity.
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

// ---------------------------------------------------------------------------
// Pass A: >=3 Compiling lines collapsed to single sentinel
// ---------------------------------------------------------------------------

describe("TestCargoPassACompilingSentinel", () => {
  it("test_three_compiling_lines_collapsed", () => {
    const inp = [
      "   Compiling foo v0.1.0 (/tmp/foo)",
      "   Compiling bar v0.2.0 (/tmp/bar)",
      "   Compiling baz v0.3.0 (/tmp/baz)",
    ].join("\n");
    const out = _compress(inp);
    expect(out).toContain("[compiling 3 crates");
    expect(out).not.toContain("Compiling foo");
  });

  it("test_two_compiling_lines_kept_verbatim", () => {
    const inp = [
      "   Compiling foo v0.1.0 (/tmp/foo)",
      "   Compiling bar v0.2.0 (/tmp/bar)",
    ].join("\n");
    const out = _compress(inp);
    expect(out).toContain("Compiling foo");
    expect(out).toContain("Compiling bar");
    expect(out).not.toContain("[compiling");
  });

  it("test_sentinel_count_matches_line_count", () => {
    const lines = Array.from({ length: 7 }, (_, i) => `   Compiling crate_${i} v0.1.${i} (/tmp)`);
    const out = _compress(lines.join("\n"));
    expect(out).toContain("[compiling 7 crates");
  });
});

// ---------------------------------------------------------------------------
// Pass B: per-binary test sentinels (cargo test subcommand)
// ---------------------------------------------------------------------------

describe("TestCargoPassBTestSentinels", () => {
  it("test_passing_test_lines_suppressed_with_sentinel", () => {
    const stdout = [
      "running 3 tests",
      "test foo::a ... ok",
      "test foo::b ... ok",
      "test foo::c ... ok",
      "",
      "test result: ok. 3 passed; 0 failed; 0 ignored",
    ].join("\n");
    const out = _compress(stdout, "", "test");
    expect(out).not.toContain("test foo::a ... ok");
    expect(out).toContain("test result: ok.");
  });

  it("test_failing_test_lines_always_kept", () => {
    const stdout = [
      "running 2 tests",
      "test foo::a ... ok",
      "test foo::b ... FAILED",
      "",
      "test result: FAILED. 1 passed; 1 failed; 0 ignored",
    ].join("\n");
    const out = _compress(stdout, "", "test", 1);
    expect(out).toContain("test foo::b ... FAILED");
    expect(out).not.toContain("test foo::a ... ok");
  });
});

// ---------------------------------------------------------------------------
// Pass C: Finished preamble suppression in _compress_build
// ---------------------------------------------------------------------------

describe("TestCargoPassCPreambleSuppression", () => {
  it("test_finished_line_suppressed_on_clean_build", () => {
    const lines = Array.from({ length: 5 }, (_, i) => `   Compiling crate_${i} v0.1.0 (/tmp)`);
    lines.push("    Finished dev [unoptimized + debuginfo] target(s) in 3.5s");
    const out = _compress(lines.join("\n"));
    expect(out).toContain("[compiling 5 crates");
    expect(out).not.toContain("Finished dev");
  });

  it("test_finished_kept_when_followed_by_error", () => {
    const lines = [
      "   Compiling foo v0.1.0 (/tmp)",
      "   Compiling bar v0.1.0 (/tmp)",
      "   Compiling baz v0.1.0 (/tmp)",
      "    Finished dev [unoptimized] target(s) in 1.0s",
      "error[E0001]: something broke",
    ];
    const out = _compress(lines.join("\n"), "", "build", 1);
    expect(out).toContain("Finished dev");
    expect(out).toContain("error[E0001]");
  });

  it("test_running_unittests_suppressed_in_passing_run", () => {
    const stderr = [
      ...Array.from({ length: 4 }, (_, i) => `   Compiling dep_${i} v0.1.0 (/tmp)`),
      "    Finished test [unoptimized + debuginfo] target(s) in 2s",
      "     Running unittests src/lib.rs (target/debug/deps/mylib-abc123)",
    ].join("\n");
    const stdout = [
      "running 1 tests",
      "test it_works ... ok",
      "",
      "test result: ok. 1 passed; 0 failed; 0 ignored",
    ].join("\n");
    const out = _compress(stdout, stderr, "test");
    expect(out).not.toContain("Running unittests");
    expect(out).toContain("test result: ok.");
  });

  it("test_finished_release_suppressed", () => {
    const lines = Array.from({ length: 3 }, (_, i) => `   Compiling crate_${i} v0.1.0 (/tmp)`);
    lines.push("    Finished release [optimized] target(s) in 10.5s");
    const out = _compress(lines.join("\n"));
    expect(out).not.toContain("Finished release");
  });

  it("test_finished_kept_with_fewer_than_three_compiling", () => {
    // suppress_finished is gated on len(compiled) >= 3; fewer compiling lines -> kept
    const lines = [
      "   Compiling foo v0.1.0 (/tmp)",
      "    Finished dev [unoptimized] target(s) in 0.5s",
    ];
    const out = _compress(lines.join("\n"));
    expect(out).toContain("Finished dev");
  });
});
