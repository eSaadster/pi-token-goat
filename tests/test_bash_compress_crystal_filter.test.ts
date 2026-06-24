/**
 * Tests for CrystalFilter (crystal spec / shards output compression).
 *
 * 1:1 port of tests/test_bash_compress_crystal_filter.py. Every Python
 * `def test_*` maps to a vitest `it()` with the SAME name and assertion
 * polarity; the Python `TestCrystalFilter` class maps to a `describe()`
 * block of the same name.
 *
 * Test-seam mapping (Python -> TS):
 *  - `import token_goat.bash_compress as bc`
 *      -> import the barrel "../src/token_goat/bash_compress.js" as `bc`
 *        (re-exports CrystalFilter + select_filter).
 *  - `from token_goat.bash_compress import select_filter`
 *      -> `select_filter` imported directly from the barrel.
 *  - The Python module-level `_compress(stdout, stderr, exit_code, argv)`
 *    helper -> local `_compress(...)` below that constructs a fresh
 *    CrystalFilter per call (matching the Python helper exactly, which did
 *    `f = bc.CrystalFilter()` inside the function) and returns `.text`.
 *  - `isinstance(result, bc.CrystalFilter)` -> `result instanceof CrystalFilter`.
 *
 * Byte-exactness: the assertions are substring `in` / `not in` checks plus a
 * `len(out) / len(input) < 0.25` ratio check. The fixtures are mostly ASCII;
 * the lone non-ASCII chars are the Crystal check/cross marks (U+2713, U+2717)
 * and the ellipsis dots. Python `len` counts code points; JS `.length` counts
 * UTF-16 code units. The check/cross marks are single code points in the BMP,
 * so code-point length equals code-unit length here; the ratio test therefore
 * compares `.length` to `.length` with no Buffer arithmetic needed.
 */
import { describe, expect, it } from "vitest";

import * as bc from "../src/token_goat/bash_compress.js";
import { CrystalFilter, select_filter } from "../src/token_goat/bash_compress.js";

// ---------------------------------------------------------------------------
// Local _compress helper (port of the Python module-level `_compress`). When
// argv is omitted it defaults to `["crystal", "spec"]` exactly as in Python.
// A fresh CrystalFilter is constructed per call.
// ---------------------------------------------------------------------------
function _compress(
  stdout: string = "",
  stderr: string = "",
  exit_code: number = 0,
  argv: string[] | null = null,
): string {
  const f = new CrystalFilter();
  const argv_ = argv ?? ["crystal", "spec"];
  return f.apply(stdout, stderr, exit_code, argv_).text;
}

// ===========================================================================
// Fixture data
// ===========================================================================

const _SPEC_SUCCESS =
  "Compiling src/myapp.cr (crystal)\n" +
  "Compiling src/myapp/server.cr (crystal)\n" +
  "Linking crystal spec ./spec/spec\n" +
  "....\n" +
  "  MyApp\n" +
  "    ✓ starts the server (2ms)\n" +
  "    ✓ handles requests (1ms)\n" +
  "    ✓ shuts down cleanly (0ms)\n" +
  "  MyApp::Server\n" +
  "    ✓ accepts connections (5ms)\n" +
  "    ✓ rejects bad requests (1ms)\n" +
  "\n" +
  "Finished in 1.23 seconds\n" +
  "10 examples, 0 failures\n";

const _SPEC_WITH_FAILURE =
  "Compiling src/myapp.cr (crystal)\n" +
  "Linking crystal spec ./spec/spec\n" +
  "....\n" +
  "  MyApp\n" +
  "    ✓ starts the server (2ms)\n" +
  "    ✗ fails on bad input (1ms)\n" +
  "\n" +
  "Failures:\n" +
  "\n" +
  "  1) MyApp fails on bad input\n" +
  "     Expected: 200\n" +
  "       Actual: 500\n" +
  "\n" +
  "3 examples, 1 failures\n" +
  "Finished in 0.50 seconds\n";

const _SHARDS_INSTALL =
  "Resolving dependencies\n" +
  "Fetching https://github.com/crystal-lang/crystal-db.git\n" +
  "Using crystal-db (0.13.1)\n" +
  "Installing crystal-db (0.13.1)\n" +
  "Writing shard.lock\n" +
  "Shards are up to date\n";

const _LARGE_SPEC =
  "Compiling src/app.cr (crystal)\n" +
  "Linking crystal spec ./spec/spec\n" +
  "....\n".repeat(50) +
  Array.from({ length: 200 }, (_v, i) => `  ✓ test case ${i} (1ms)`).join("\n") +
  "\n" +
  "\nFinished in 3.21 seconds\n" +
  "200 examples, 0 failures\n";

// ===========================================================================
// TestCrystalFilter
// ===========================================================================

describe("TestCrystalFilter", () => {
  // --- matches ------------------------------------------------------------

  it("test_matches_crystal_spec", () => {
    const f = new CrystalFilter();
    expect(f.matches(["crystal", "spec"])).toBe(true);
  });

  it("test_matches_crystal_binary_alone", () => {
    const f = new CrystalFilter();
    expect(f.matches(["crystal"])).toBe(true);
  });

  it("test_matches_shards", () => {
    const f = new CrystalFilter();
    expect(f.matches(["shards"])).toBe(true);
  });

  it("test_matches_shards_install", () => {
    const f = new CrystalFilter();
    expect(f.matches(["shards", "install"])).toBe(true);
  });

  it("test_matches_shards_update", () => {
    const f = new CrystalFilter();
    expect(f.matches(["shards", "update"])).toBe(true);
  });

  it("test_no_match_mix", () => {
    const f = new CrystalFilter();
    expect(f.matches(["mix", "test"])).toBe(false);
  });

  it("test_no_match_ruby", () => {
    const f = new CrystalFilter();
    expect(f.matches(["ruby", "spec"])).toBe(false);
  });

  it("test_no_match_rspec", () => {
    const f = new CrystalFilter();
    expect(f.matches(["rspec"])).toBe(false);
  });

  // --- select_filter -------------------------------------------------------

  it("test_select_crystal_spec", () => {
    expect(select_filter(["crystal", "spec"]) instanceof CrystalFilter).toBe(true);
  });

  it("test_select_shards", () => {
    expect(select_filter(["shards", "install"]) instanceof CrystalFilter).toBe(true);
  });

  // --- compilation lines collapsed ----------------------------------------

  it("test_compilation_lines_collapsed", () => {
    const out = _compress(_SPEC_SUCCESS);
    expect(out).toContain("collapsed");
    expect(out).toContain("compilation");
  });

  it("test_compiling_src_not_verbatim", () => {
    const out = _compress(_SPEC_SUCCESS);
    expect(out).not.toContain("Compiling src/myapp.cr");
  });

  it("test_linking_line_not_verbatim", () => {
    const out = _compress(_SPEC_SUCCESS);
    expect(out).not.toContain("Linking crystal spec");
  });

  // --- dot-only progress lines dropped ------------------------------------

  it("test_dot_progress_lines_dropped", () => {
    const out = _compress(_SPEC_SUCCESS);
    expect(out).toContain("dropped");
    expect(out).toContain("dot-progress");
  });

  it("test_dot_line_not_verbatim", () => {
    const stdout = "....\n....\n10 examples, 0 failures\n";
    const out = _compress(stdout);
    expect(out).not.toContain("....");
  });

  // --- passing spec lines collapsed ----------------------------------------

  it("test_passing_spec_lines_collapsed", () => {
    const out = _compress(_SPEC_SUCCESS);
    expect(out).toContain("collapsed");
    expect(out).toContain("passing Crystal spec");
  });

  it("test_individual_pass_line_not_verbatim", () => {
    const out = _compress(_SPEC_SUCCESS);
    expect(out).not.toContain("✓ starts the server");
    expect(out).not.toContain("✓ handles requests");
  });

  // --- spec summary kept --------------------------------------------------

  it("test_finished_in_line_kept", () => {
    const out = _compress(_SPEC_SUCCESS);
    expect(out).toContain("Finished in 1.23 seconds");
  });

  it("test_examples_summary_kept", () => {
    const out = _compress(_SPEC_SUCCESS);
    expect(out).toContain("10 examples, 0 failures");
  });

  // --- failures kept verbatim ---------------------------------------------

  it("test_failure_header_kept", () => {
    const out = _compress(_SPEC_WITH_FAILURE);
    expect(out).toContain("Failures:");
  });

  it("test_failure_detail_kept", () => {
    const out = _compress(_SPEC_WITH_FAILURE);
    expect(out).toContain("Expected: 200");
    expect(out).toContain("Actual: 500");
  });

  it("test_failure_summary_kept", () => {
    const out = _compress(_SPEC_WITH_FAILURE);
    expect(out).toContain("3 examples, 1 failures");
  });

  // --- error lines kept ---------------------------------------------------

  it("test_error_line_always_kept", () => {
    const stdout = "Compiling src/app.cr (crystal)\nError: undefined method 'foo'\n";
    const out = _compress(stdout);
    expect(out).toContain("undefined method 'foo'");
  });

  // --- shards progress collapsed ------------------------------------------

  it("test_shards_progress_lines_collapsed", () => {
    const out = _compress(_SHARDS_INSTALL, "", 0, ["shards", "install"]);
    expect(out).toContain("shard dependency action");
  });

  it("test_fetching_line_not_verbatim", () => {
    const out = _compress(_SHARDS_INSTALL, "", 0, ["shards", "install"]);
    expect(out).not.toContain("Fetching https://");
  });

  it("test_using_line_not_verbatim", () => {
    const out = _compress(_SHARDS_INSTALL, "", 0, ["shards", "install"]);
    expect(out).not.toContain("Using crystal-db");
  });

  // --- shards final summary kept ------------------------------------------

  it("test_shards_done_line_kept", () => {
    const out = _compress(_SHARDS_INSTALL, "", 0, ["shards", "install"]);
    expect(out).toContain("Shards are up to date");
  });

  // --- error passthrough on non-zero exit ---------------------------------

  it("test_error_passthrough_nonzero", () => {
    const stderr = "Error in /src/app.cr:5: undefined constant Foo";
    const out = _compress("", stderr, 1);
    expect(out).toContain(stderr);
  });

  it("test_error_passthrough_compiling_not_suppressed", () => {
    const stdout = "Compiling src/app.cr (crystal)\n";
    const stderr = "Error in /src/app.cr:5: undefined constant Foo";
    const out = _compress(stdout, stderr, 1);
    expect(out).toContain(stderr);
  });

  // --- short output passthrough (no compression for tiny output) ----------

  it("test_short_output_passthrough", () => {
    const short = "10 examples, 0 failures\nFinished in 0.01 seconds\n";
    const out = _compress(short);
    expect(out).toContain("10 examples, 0 failures");
    expect(out).toContain("Finished in 0.01 seconds");
  });

  // --- compression ratio --------------------------------------------------

  it("test_large_output_compresses_significantly", () => {
    const out = _compress(_LARGE_SPEC);
    const ratio = out.length / _LARGE_SPEC.length;
    expect(ratio).toBeLessThan(0.25);
  });
});
