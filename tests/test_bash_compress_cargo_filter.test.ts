/**
 * Tests for CargoFilter in bash_compress.
 *
 * 1:1 port of tests/test_bash_compress_cargo_filter.py. Every Python `def
 * test_*` maps to a vitest `it()` with the SAME name and assertion polarity.
 *
 * Covers:
 *   - Compiling lines (<=4) kept in full at the start
 *   - Compiling lines (>4) collapsed to head+marker+tail
 *   - Collapse marker contains the suppressed count
 *   - warning:/error: lines preserved through build compression
 *   - Finished line preserved
 *   - Downloading/Updating/Fetching progress lines dropped with note
 *   - test pass lines suppressed, count in note
 *   - test fail lines always kept
 *   - test result: summary line kept
 *   - No-Compiling output passes through unchanged
 *   - cargo test flow: build stderr + test stdout sections joined with ---
 *   - cargo dispatch: build vs test vs clippy vs passthrough
 *   - clippy: Checking lines dropped, warnings kept
 *
 * Test-seam mapping (Python -> TS):
 *   - `from token_goat.bash_compress import CargoFilter`
 *       -> import { CargoFilter } from the barrel "../src/token_goat/bash_compress.js".
 *   - `_cf()` -> `_cf()` returning `new CargoFilter()`.
 *   - `_compress(stdout, stderr, subcommand, exit_code)` -> the same helper;
 *     Python's `_cf().compress(stdout, stderr, exit_code, ["cargo", subcommand])`
 *     maps directly onto the TS `compress(stdout, stderr, exit_code, argv)`
 *     signature.
 */
import { describe, expect, it } from "vitest";

import { CargoFilter } from "../src/token_goat/bash_compress.js";

function _cf(): CargoFilter {
  return new CargoFilter();
}

function _compress(
  stdout: string,
  stderr = "",
  subcommand = "build",
  exit_code = 0,
): string {
  return _cf().compress(stdout, stderr, exit_code, ["cargo", subcommand]);
}

// ---------------------------------------------------------------------------
// Build: Compiling line handling
// ---------------------------------------------------------------------------

describe("test_bash_compress_cargo_filter", () => {
  it("test_few_compiling_lines_kept_verbatim", () => {
    // 4 compiling lines or fewer are kept in full (no collapse).
    const out = [
      "   Compiling foo v0.1.0 (/tmp/foo)",
      "   Compiling bar v0.2.0 (/tmp/bar)",
      "    Finished dev [unoptimized + debuginfo] target(s) in 1.2s",
    ].join("\n");
    const result = _compress(out);
    expect(result).toContain("Compiling foo");
    expect(result).toContain("Compiling bar");
    expect(result).toContain("Finished");
    expect(result).not.toContain("collapsed");
  });

  it("test_many_compiling_lines_collapsed", () => {
    // >=3 Compiling lines -> single [compiling N crates...] sentinel (Pass A).
    const lines = Array.from(
      { length: 10 },
      (_, i) => `   Compiling crate_${i} v0.1.${i} (/tmp/c${i})`,
    );
    lines.push("    Finished dev [unoptimized] target(s) in 3.0s");
    const result = _compress(lines.join("\n"));
    expect(result).toContain("[compiling 10 crates");
    expect(result).not.toContain("Compiling crate_0");
    expect(result).not.toContain("Compiling crate_5");
  });

  it("test_collapse_marker_count_matches_suppressed", () => {
    const lines = Array.from(
      { length: 8 },
      (_, i) => `   Compiling crate_${i} v0.1.0 (/tmp)`,
    );
    const result = _compress(lines.join("\n"));
    // >=3 Compiling -> single sentinel (Pass A).
    expect(result).toContain("[compiling 8 crates");
    expect(result).not.toContain("Compiling crate_0");
  });

  // -------------------------------------------------------------------------
  // Build: warning / error / Finished lines preserved
  // -------------------------------------------------------------------------

  it("test_warning_lines_preserved", () => {
    const lines = [
      ...Array.from({ length: 6 }, (_, i) => `   Compiling crate_${i} v0.1.0 (/tmp)`),
      "warning: unused variable `x`",
      "  --> src/main.rs:5:9",
      "    Finished dev [unoptimized] target(s) in 2.1s",
    ];
    const result = _compress(lines.join("\n"), "", "build");
    expect(result).toContain("warning: unused variable");
    expect(result).toContain("--> src/main.rs:5:9");
  });

  it("test_error_lines_preserved", () => {
    const lines = [
      "   Compiling myapp v0.1.0 (/tmp/myapp)",
      "   Compiling myapp v0.1.0 (/tmp/myapp)",
      "   Compiling myapp v0.1.0 (/tmp/myapp)",
      "   Compiling myapp v0.1.0 (/tmp/myapp)",
      "   Compiling myapp v0.1.0 (/tmp/myapp)",
      "error[E0282]: type annotations needed",
      "  --> src/lib.rs:3:9",
      "error: aborting due to previous error",
    ];
    const result = _compress(lines.join("\n"), "", "build", 1);
    expect(result).toContain("error[E0282]");
    expect(result).toContain("aborting due to previous error");
  });

  it("test_finished_line_suppressed_without_error", () => {
    // Pass A collapses >=3 Compiling; Pass C suppresses clean Finished preambles.
    const lines = [
      "   Compiling foo v0.1.0 (/tmp/foo)",
      "   Compiling bar v0.1.0 (/tmp/bar)",
      "   Compiling baz v0.1.0 (/tmp/baz)",
      "   Compiling qux v0.1.0 (/tmp/qux)",
      "   Compiling quux v0.1.0 (/tmp/quux)",
      "    Finished release [optimized] target(s) in 10.5s",
    ];
    const result = _compress(lines.join("\n"));
    expect(result).toContain("[compiling 5 crates");
    expect(result).not.toContain("Finished release");
  });

  // -------------------------------------------------------------------------
  // Build: progress lines (Downloading / Updating / Fetching) dropped
  // -------------------------------------------------------------------------

  it("test_progress_lines_dropped_with_note", () => {
    const lines = [
      "    Updating crates.io index",
      "  Downloading crates ...",
      "  Downloaded serde v1.0.0 (registry+...)",
      "   Compiling serde v1.0.0",
      "    Finished dev [unoptimized] target(s) in 5s",
    ];
    const result = _compress(lines.join("\n"));
    expect(result).not.toContain("Updating");
    expect(result).not.toContain("Downloading");
    expect(!result.toLowerCase().includes("downloaded") || result.includes("dropped")).toBe(true);
    expect(result).toContain("dropped");
  });

  // -------------------------------------------------------------------------
  // No-Compiling passthrough
  // -------------------------------------------------------------------------

  it("test_no_compiling_lines_passes_through_unchanged", () => {
    // Pure non-cargo output (no Compiling, no test ok) should not be modified.
    const out = "Hello, world!\nDone in 0ms.\n";
    const result = _compress(out);
    expect(result).toContain("Hello, world!");
    expect(result).toContain("Done in 0ms.");
    expect(result).not.toContain("token-goat");
  });

  // -------------------------------------------------------------------------
  // cargo test: pass / fail / summary
  // -------------------------------------------------------------------------

  it("test_test_pass_lines_suppressed_with_count", () => {
    const stdout = [
      "running 3 tests",
      "test foo::bar ... ok",
      "test foo::baz ... ok",
      "test foo::qux ... ok",
      "",
      "test result: ok. 3 passed; 0 failed; 0 ignored; 0 measured",
    ].join("\n");
    const result = _compress(stdout, "", "test");
    expect(result).not.toContain("test foo::bar ... ok");
    expect(result).toContain("collapsed 3");
    expect(result).toContain("test result: ok. 3 passed");
  });

  it("test_test_fail_lines_always_kept", () => {
    const stdout = [
      "running 4 tests",
      "test foo::a ... ok",
      "test foo::b ... ok",
      "test foo::c ... FAILED",
      "test foo::d ... ok",
      "",
      "test result: FAILED. 3 passed; 1 failed; 0 ignored",
    ].join("\n");
    const result = _compress(stdout, "", "test");
    expect(result).toContain("test foo::c ... FAILED");
    expect(result).not.toContain("test foo::a ... ok");
    expect(result).toContain("test result: FAILED");
  });

  it("test_test_summary_line_kept", () => {
    const stdout = [
      "test alpha ... ok",
      "test result: ok. 1 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out",
    ].join("\n");
    const result = _compress(stdout, "", "test");
    expect(result).toContain("test result: ok.");
  });

  // -------------------------------------------------------------------------
  // cargo test: build stderr + test stdout joined
  // -------------------------------------------------------------------------

  it("test_cargo_test_build_stderr_and_test_stdout_joined", () => {
    // Build noise on stderr, test output on stdout; they should be separated by ---.
    const stderr = [
      ...Array.from({ length: 6 }, (_, i) => `   Compiling dep_${i} v0.1.0 (/tmp)`),
      "    Finished test [unoptimized] target(s) in 2s",
    ].join("\n");
    const stdout = [
      "running 1 tests",
      "test my_test ... ok",
      "",
      "test result: ok. 1 passed; 0 failed; 0 ignored",
    ].join("\n");
    const result = _compress(stdout, stderr, "test");
    expect(result).toContain("---");
    expect(result).toContain("Finished test");
    expect(result).toContain("test result: ok.");
  });

  // -------------------------------------------------------------------------
  // cargo clippy: Checking lines dropped, warnings kept
  // -------------------------------------------------------------------------

  it("test_clippy_checking_lines_dropped", () => {
    const stderr = [
      "   Checking myapp v0.1.0 (/tmp/myapp)",
      "   Checking dep v0.2.0 (/tmp/dep)",
      "warning: clippy::needless_return",
      "  --> src/main.rs:10:5",
      "    Finished dev [unoptimized] target(s) in 0.5s",
    ].join("\n");
    const result = _cf().compress("", stderr, 0, ["cargo", "clippy"]);
    expect(result).not.toContain("Checking myapp");
    expect(result).not.toContain("Checking dep");
    expect(result).toContain("needless_return");
    expect(result).toContain("Finished");
  });

  // -------------------------------------------------------------------------
  // Dispatch: cargo run passes through
  // -------------------------------------------------------------------------

  it("test_cargo_run_passthrough", () => {
    // cargo run output is the script's own output -- don't suppress it.
    const stdout = "Hello from my binary!\nExiting with code 0.\n";
    const result = _cf().compress(stdout, "", 0, ["cargo", "run"]);
    expect(result).toContain("Hello from my binary!");
  });
});
