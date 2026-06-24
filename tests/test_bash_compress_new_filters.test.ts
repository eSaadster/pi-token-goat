/**
 * Tests for TurboFilter, OxlintFilter, PylintFilter, CargoFilter (bench), and
 * MypyFilter.
 *
 * 1:1 port of tests/test_bash_compress_new_filters.py. Every Python `def test_*`
 * maps to a vitest `it()` with the SAME name and assertion polarity; the Python
 * test classes map to `describe()` blocks of the same name.
 *
 * Test-seam mapping (Python -> TS):
 *  - `from filter_test_helpers import apply_filter as _compress`
 *      -> local `_compress(filter, stdout, opts?)` helper below. The Python
 *        helper runs `filter_.apply(stdout, stderr, exit_code, argv).text`,
 *        defaulting argv to `[filter_.name]`; the TS port mirrors that exactly.
 *  - `from filter_test_helpers import FilterTestMixin`
 *      -> the mixin contributes two inherited methods (test_empty_input,
 *        test_empty_output) to every class that inherits it (TestTurboFilter,
 *        TestOxlintFilter, TestPylintFilter). They are ported inline into the
 *        corresponding describe() blocks, preserving name + polarity.
 *  - `from token_goat import bash_compress as bc`
 *      -> import the barrel "../src/token_goat/bash_compress.js" as `bc`
 *        (re-exports the framework + the ported filter classes + select_filter).
 *  - Class-body `F = bc.SomeFilter()` (a class attribute shared by the methods)
 *      -> a `const F = new SomeFilter()` inside the describe block.
 *  - The module-level `_compress_cargo_bench` / `_compress_mypy` helpers build a
 *    bespoke argv (["cargo","bench"] / ["mypy","src/"]) and call
 *    `f.apply(stdout, stderr, exit_code, argv).text`; ported verbatim below.
 *
 * Deferral: NONE. All five filters exercised here (TurboFilter, OxlintFilter,
 * PylintFilter, CargoFilter, MypyFilter) are ported into sibling modules and
 * registered in the barrel's FILTERS registry / re-exported, so every test
 * routes to a live filter.
 *
 * Byte-exactness: these filters operate on whole lines and on UTF-8 marker
 * glyphs (box-drawing chars, cross marks). The assertions are substring `in` /
 * `not in` checks on the returned string, matching the Python checks; no
 * String.length byte arithmetic is needed, so the substring assertions translate
 * directly. Where a glyph is asserted it is the same Unicode codepoint as the
 * Python source.
 */
import { describe, expect, it } from "vitest";

import * as bc from "../src/token_goat/bash_compress.js";
import {
  TurboFilter,
  OxlintFilter,
  PylintFilter,
  CargoFilter,
  MypyFilter,
} from "../src/token_goat/bash_compress.js";

import type { Filter } from "../src/token_goat/bash_compress.js";

// ---------------------------------------------------------------------------
// Local apply_filter helper (port of filter_test_helpers.apply_filter, aliased
// as `_compress` at the Python import site).
//
// When argv is omitted the filter's own `.name` is used as the sole argv
// element — the minimum needed for these structural-compression tests.
// ---------------------------------------------------------------------------
function _compress(
  filter_: Filter,
  stdout = "",
  opts?: { stderr?: string; exit_code?: number; argv?: string[] },
): string {
  const stderr = opts?.stderr ?? "";
  const exit_code = opts?.exit_code ?? 0;
  const argv = opts?.argv ?? [filter_.name];
  return filter_.apply(stdout, stderr, exit_code, argv).text;
}

// ===========================================================================
// TurboFilter
// ===========================================================================

const _TURBO_SUCCESS = `\
• Packages in scope: app, docs, web
• Running build in 3 packages
  app:build: cache miss, executing abcdef123456
  app:build: > webpack --config webpack.config.js
  app:build: asset main.js 1.23 MiB [emitted]
  app:build: webpack compiled successfully
  docs:build: cache hit, replaying output 111111111111
  docs:build: > next build
  docs:build: Creating an optimized production build...
  docs:build: ✓ Compiled successfully
  web:build: cache hit, replaying output 222222222222
  web:build: > next build
  web:build: info  - Generating static pages (3/3)

 Tasks:    3 successful, 3 total
 Cached:   2 cached, 3 total
 Time:     4.321s
`;

const _TURBO_FAIL = `\
• Running test in 2 packages
  api:test: cache miss, executing aabbccdd1122
  api:test: FAIL src/auth.test.ts
  api:test: TypeError: Cannot read property 'token' of undefined
  ui:test: cache hit, replaying output 33445566
  ui:test: > jest --passWithNoTests

 Tasks:    1 successful, 1 failed, 2 total
 Time:     8.500s
`;

describe("TestTurboFilter", () => {
  const F = new TurboFilter();

  // --- matches -----------------------------------------------------------

  it("test_matches_turbo", () => {
    expect(F.matches(["turbo", "run", "build"])).toBeTruthy();
  });

  it("test_matches_npx_turbo", () => {
    expect(F.matches(["npx", "turbo", "run", "build"])).toBeTruthy();
  });

  it("test_matches_pnpx_turbo", () => {
    expect(F.matches(["pnpx", "turbo", "run", "test"])).toBeTruthy();
  });

  it("test_no_match_npm", () => {
    expect(F.matches(["npm", "run", "build"])).toBeFalsy();
  });

  it("test_no_match_npx_other", () => {
    expect(F.matches(["npx", "webpack"])).toBeFalsy();
  });

  // --- select -----------------------------------------------------------

  it("test_select_filter", () => {
    expect(bc.select_filter(["turbo", "run", "build"])).toBeInstanceOf(TurboFilter);
  });

  it("test_select_npx_turbo", () => {
    expect(bc.select_filter(["npx", "turbo", "run", "build"])).toBeInstanceOf(TurboFilter);
  });

  // --- compress: success path -------------------------------------------

  it("test_scope_header_kept", () => {
    const out = _compress(F, _TURBO_SUCCESS);
    expect(out).toContain("Packages in scope");
  });

  it("test_running_header_kept", () => {
    const out = _compress(F, _TURBO_SUCCESS);
    expect(out).toContain("Running build in 3 packages");
  });

  it("test_summary_kept", () => {
    const out = _compress(F, _TURBO_SUCCESS);
    expect(out).toContain("Tasks:");
    expect(out).toContain("Cached:");
    expect(out).toContain("Time:");
  });

  it("test_cache_miss_task_header_kept", () => {
    const out = _compress(F, _TURBO_SUCCESS);
    expect(out).toContain("cache miss");
  });

  it("test_cache_hit_task_headers_dropped", () => {
    const out = _compress(F, _TURBO_SUCCESS);
    // "cache hit, replaying output" lines should be gone
    expect(out).not.toContain("replaying output");
  });

  it("test_cache_hit_body_lines_dropped", () => {
    const out = _compress(F, _TURBO_SUCCESS);
    // The next build lines from the cache-hit tasks should not appear
    expect(out).not.toContain("next build");
    expect(out).not.toContain("Generating static pages");
  });

  it("test_compression_note_present", () => {
    const out = _compress(F, _TURBO_SUCCESS);
    // Should mention dropped cache-hit entries
    expect(out).toContain("cache-hit");
  });

  // --- compress: failure path -------------------------------------------

  it("test_error_lines_kept_on_failure", () => {
    const out = _compress(F, _TURBO_FAIL, { exit_code: 1 });
    expect(out).toContain("TypeError");
  });

  it("test_fail_summary_kept", () => {
    const out = _compress(F, _TURBO_FAIL, { exit_code: 1 });
    expect(out).toContain("1 failed");
  });

  // --- compress: empty input (inherited from FilterTestMixin) -----------

  it("test_empty_input", () => {
    const out = _compress(F, "");
    expect(typeof out).toBe("string");
  });

  it("test_empty_output", () => {
    const result = _compress(F, "");
    expect(typeof result).toBe("string");
  });
});

// ===========================================================================
// OxlintFilter
// ===========================================================================

const _OXLINT_OUTPUT = `\
  src/auth.ts
    × Unexpected var, use let or const instead (no-var)
    ╭─[src/auth.ts:10:5]
    │  10 │   var x = 1;
    ·        ───
    ╰─
    × Unexpected var, use let or const instead (no-var)
    ╭─[src/auth.ts:15:1]
    │  15 │   var y = 2;
    ╰─
    × Unexpected var, use let or const instead (no-var)
    ╭─[src/auth.ts:20:1]
    │  20 │   var z = 3;
    ╰─
    × Unexpected var, use let or const instead (no-var)
    ╭─[src/auth.ts:25:1]
    │  25 │   var w = 4;
    ╰─
  src/utils.ts
    × 'foo' is defined but never used (no-unused-vars)
    ╭─[src/utils.ts:5:1]
    ╰─

Found 5 warnings and 0 errors.
Finished in 120ms on 2 files with 7 rules used.
`;

const _OXLINT_CLEAN = `\
Found 0 warnings and 0 errors.
Finished in 50ms on 2 files with 7 rules used.
`;

describe("TestOxlintFilter", () => {
  const F = new OxlintFilter();

  // --- matches -----------------------------------------------------------

  it("test_matches_oxlint", () => {
    expect(F.matches(["oxlint", "src/"])).toBeTruthy();
  });

  it("test_matches_oxc_linter", () => {
    expect(F.matches(["oxc_linter", "src/"])).toBeTruthy();
  });

  it("test_no_match_eslint", () => {
    expect(F.matches(["eslint", "src/"])).toBeFalsy();
  });

  // --- select -----------------------------------------------------------

  it("test_select_filter", () => {
    expect(bc.select_filter(["oxlint", "src/"])).toBeInstanceOf(OxlintFilter);
  });

  // --- compress: dedup ---------------------------------------------------

  it("test_first_three_occurrences_kept", () => {
    const out = _compress(F, _OXLINT_OUTPUT);
    // 3 no-var issues should be kept — their location boxes include line numbers
    expect(out).toContain("10:5");
    expect(out).toContain("15:1");
    expect(out).toContain("20:1");
  });

  it("test_fourth_occurrence_deduplicated", () => {
    const out = _compress(F, _OXLINT_OUTPUT);
    // The 4th no-var issue — its location box (25:1) should be suppressed
    expect(out).not.toContain("25:1");
  });

  it("test_dedup_note_emitted", () => {
    const out = _compress(F, _OXLINT_OUTPUT);
    expect(out.toLowerCase().includes("more") || out.toLowerCase().includes("deduplicated")).toBeTruthy();
  });

  it("test_different_rule_not_deduplicated", () => {
    const out = _compress(F, _OXLINT_OUTPUT);
    // no-unused-vars appears only once — should be kept
    expect(out).toContain("no-unused-vars");
  });

  it("test_summary_always_kept", () => {
    const out = _compress(F, _OXLINT_OUTPUT);
    expect(out).toContain("Found 5 warnings");
    expect(out).toContain("Finished in 120ms");
  });

  it("test_clean_output_preserved", () => {
    const out = _compress(F, _OXLINT_CLEAN);
    expect(out).toContain("Found 0 warnings");
  });

  // --- compress: empty input (inherited from FilterTestMixin) -----------

  it("test_empty_input", () => {
    const out = _compress(F, "");
    expect(typeof out).toBe("string");
  });

  it("test_empty_output", () => {
    const result = _compress(F, "");
    expect(typeof result).toBe("string");
  });
});

// ===========================================================================
// PylintFilter
// ===========================================================================

const _PYLINT_OUTPUT = `\
************* Module src.auth
src/auth.py:10:0: C0301 (line-too-long) Line too long (120/100)
src/auth.py:20:0: C0301 (line-too-long) Line too long (115/100)
src/auth.py:30:0: C0301 (line-too-long) Line too long (112/100)
src/auth.py:40:0: C0301 (line-too-long) Line too long (108/100)
src/auth.py:5:0: W0611 (unused-import) Unused import os
src/auth.py:6:0: W0611 (unused-import) Unused import sys
src/auth.py:7:0: W0611 (unused-import) Unused import re
src/auth.py:8:0: W0611 (unused-import) Unused import json
src/auth.py:50:4: E0001 (syntax-error) invalid syntax
************* Module src.utils
src/utils.py:1:0: C0114 (missing-module-docstring) Missing module docstring
src/utils.py:10:0: C0301 (line-too-long) Line too long (105/100)

------------------------------------------------------------------
Your code has been rated at 6.50/10 (previous run: 5.00/10, +1.50)
`;

const _PYLINT_CLEAN = `\
--------------------------------------------------------------------
Your code has been rated at 10.00/10 (previous run: 10.00/10, +0.00)
`;

describe("TestPylintFilter", () => {
  const F = new PylintFilter();

  // --- matches -----------------------------------------------------------

  it("test_matches_pylint", () => {
    expect(F.matches(["pylint", "src/"])).toBeTruthy();
  });

  it("test_no_match_pytest", () => {
    expect(F.matches(["pytest"])).toBeFalsy();
  });

  it("test_no_match_pyright", () => {
    // pyright still routes to LinterFilter
    expect(F.matches(["pyright", "src/"])).toBeFalsy();
  });

  // --- select: PylintFilter precedes LinterFilter ----------------------

  it("test_select_filter", () => {
    const f = bc.select_filter(["pylint", "src/"]);
    expect(f).toBeInstanceOf(PylintFilter);
  });

  // --- compress: dedup by message code ----------------------------------

  it("test_first_three_c0301_kept", () => {
    const out = _compress(F, _PYLINT_OUTPUT);
    // Lines at :10, :20, :30 should appear
    expect(out).toContain("10:0: C0301");
    expect(out).toContain("20:0: C0301");
    expect(out).toContain("30:0: C0301");
  });

  it("test_fourth_c0301_deduplicated", () => {
    const out = _compress(F, _PYLINT_OUTPUT);
    // Line at :40 is the 4th C0301 — should not appear verbatim
    expect(out).not.toContain("40:0: C0301");
  });

  it("test_dedup_note_for_c0301", () => {
    const out = _compress(F, _PYLINT_OUTPUT);
    expect(out).toContain("C0301"); // note should mention the code
  });

  it("test_error_lines_always_kept", () => {
    const out = _compress(F, _PYLINT_OUTPUT);
    // E0001 is severity=E — always kept regardless of dedup count
    expect(out).toContain("E0001");
  });

  it("test_rating_line_kept", () => {
    const out = _compress(F, _PYLINT_OUTPUT);
    expect(out).toContain("Your code has been rated at");
    expect(out).toContain("6.50/10");
  });

  it("test_separator_lines_dropped", () => {
    const out = _compress(F, _PYLINT_OUTPUT);
    // Long separator (---...) should not appear
    expect(out).not.toContain("---".repeat(5));
  });

  it("test_module_header_kept_when_has_issues", () => {
    const out = _compress(F, _PYLINT_OUTPUT);
    expect(out).toContain("Module src.auth");
  });

  it("test_clean_output_rating_kept", () => {
    const out = _compress(F, _PYLINT_CLEAN);
    expect(out).toContain("10.00/10");
  });

  it("test_w0611_third_occurrence_kept", () => {
    const out = _compress(F, _PYLINT_OUTPUT);
    // W0611 appears 4 times; first 3 should be kept
    expect(out).toContain("W0611");
  });

  it("test_w0611_fourth_occurrence_deduplicated", () => {
    const out = _compress(F, _PYLINT_OUTPUT);
    // json is the 4th W0611 — should not appear verbatim
    expect(out).not.toContain("Unused import json");
  });

  // --- compress: empty input (inherited from FilterTestMixin) -----------

  it("test_empty_input", () => {
    const out = _compress(F, "");
    expect(typeof out).toBe("string");
  });

  it("test_empty_output", () => {
    const result = _compress(F, "");
    expect(typeof result).toBe("string");
  });
});

// ===========================================================================
// CargoFilter — cargo bench subcommand
// ===========================================================================

const _CARGO_BENCH_SINGLE = `\
running 3 tests
test bench_hash ... bench:       1,234 ns/iter (+/- 56)
test bench_parse ... bench:       5,678 ns/iter (+/- 89)
test bench_sort ... bench:         123 ns/iter (+/-  4)

test result: ok. 0 passed; 0 failed; 0 ignored; 3 measured; 0 filtered out
`;

const _CARGO_BENCH_MULTI = `\
running 2 tests
test bench_a ... bench:         100 ns/iter (+/- 5)
test bench_b ... bench:         200 ns/iter (+/- 8)

test result: ok. 0 passed; 0 failed; 0 ignored; 2 measured; 0 filtered out

running 3 tests
test bench_x ... bench:       1,000 ns/iter (+/- 10)
test bench_y ... bench:       2,000 ns/iter (+/- 20)
test bench_z ... bench:       3,000 ns/iter (+/- 30)

test result: ok. 0 passed; 0 failed; 0 ignored; 3 measured; 0 filtered out
`;

const _CARGO_BENCH_STDERR_SMALL = `\
   Compiling mylib v0.1.0
   Compiling benchmark v0.1.0
    Finished bench [optimized] target(s)
`;

// More than 4 Compiling lines — triggers collapse (first 2 + last 2 kept)
const _CARGO_BENCH_STDERR_LARGE =
  Array.from({ length: 10 }, (_, i) => `   Compiling crate${i} v0.1.${i}`)
    .concat(["    Finished bench [optimized] target(s)"])
    .join("\n") + "\n";

function _compress_cargo_bench(stdout: string, stderr = "", exit_code = 0): string {
  const f = new CargoFilter();
  const argv = ["cargo", "bench"];
  const result = f.apply(stdout, stderr, exit_code, argv);
  return result.text;
}

describe("TestCargoFilterBench", () => {
  const F = new CargoFilter();

  it("test_matches_cargo_bench", () => {
    expect(F.matches(["cargo", "bench"])).toBeTruthy();
  });

  it("test_matches_cargo_bench_with_flags", () => {
    expect(F.matches(["cargo", "bench", "--", "bench_hash"])).toBeTruthy();
  });

  it("test_select_filter", () => {
    expect(bc.select_filter(["cargo", "bench"])).toBeInstanceOf(CargoFilter);
  });

  it("test_bench_result_lines_kept", () => {
    const out = _compress_cargo_bench(_CARGO_BENCH_SINGLE);
    expect(out).toContain("bench_hash");
    expect(out).toContain("bench_parse");
    expect(out).toContain("bench_sort");
    expect(out).toContain("ns/iter");
  });

  it("test_summary_line_kept", () => {
    const out = _compress_cargo_bench(_CARGO_BENCH_SINGLE);
    expect(out).toContain("test result: ok");
  });

  it("test_single_running_header_dropped", () => {
    // With one bench harness, 'running N tests' header is redundant.
    const out = _compress_cargo_bench(_CARGO_BENCH_SINGLE);
    expect(out).not.toContain("running 3 tests");
  });

  it("test_multiple_running_headers_kept", () => {
    // Multiple bench harnesses — 'running N tests' headers must be kept.
    const out = _compress_cargo_bench(_CARGO_BENCH_MULTI);
    expect(out).toContain("running 2 tests");
    expect(out).toContain("running 3 tests");
  });

  it("test_multiple_harness_results_all_kept", () => {
    const out = _compress_cargo_bench(_CARGO_BENCH_MULTI);
    expect(out).toContain("bench_a");
    expect(out).toContain("bench_z");
  });

  it("test_many_compiling_lines_collapsed", () => {
    // ≥3 Compiling lines → collapsed to a single [compiling N crates…] sentinel.
    const out = _compress_cargo_bench(_CARGO_BENCH_SINGLE, _CARGO_BENCH_STDERR_LARGE);
    expect(out).toContain("[compiling");
    expect(out).not.toContain("Compiling crate0");
  });

  it("test_finished_line_kept_when_build_present", () => {
    const out = _compress_cargo_bench(_CARGO_BENCH_SINGLE, _CARGO_BENCH_STDERR_SMALL);
    expect(out).toContain("Finished bench");
  });

  it("test_empty_input", () => {
    const out = _compress_cargo_bench("");
    expect(typeof out).toBe("string");
  });
});

// ===========================================================================
// MypyFilter — error dedup and context-note suppression
// ===========================================================================

const _MYPY_MANY_ERRORS =
  Array.from(
    { length: 10 },
    (_, i) =>
      `src/auth.py:${i + 10}:0: error: Incompatible return value type (got "str", expected "int")`,
  )
    .concat(["Found 10 errors in 1 file (checked 5 source files)"])
    .join("\n");

const _MYPY_MIXED = `\
src/auth.py:1:0: error: Module not found
src/auth.py:2:0: note: See https://mypy.readthedocs.io/en/stable/running_mypy.html#missing-imports
src/auth.py:3:0: note: Did you forget to install a stub package?
src/auth.py:4:0: note: Did you forget to install a stub package?
src/auth.py:5:0: note: Did you forget to install a stub package?
src/auth.py:6:0: note: Did you forget to install a stub package?
src/auth.py:7:0: error: (errors prevented further checking)
src/auth.py:8:0: error: Incompatible type [assignment]
  [assignment]
Found 3 errors in 1 file
`;

const _MYPY_CLEAN = "Success: no issues found in 5 source files\n";

function _compress_mypy(stdout: string, stderr = "", exit_code = 0): string {
  const f = new MypyFilter();
  const argv = ["mypy", "src/"];
  const result = f.apply(stdout, stderr, exit_code, argv);
  return result.text;
}

describe("TestMypyFilter", () => {
  const F = new MypyFilter();

  it("test_matches_mypy", () => {
    expect(F.matches(["mypy", "src/"])).toBeTruthy();
  });

  it("test_matches_dmypy", () => {
    expect(F.matches(["dmypy", "run", "--", "src/"])).toBeTruthy();
  });

  it("test_no_match_pytest", () => {
    expect(F.matches(["pytest"])).toBeFalsy();
  });

  it("test_select_filter", () => {
    expect(bc.select_filter(["mypy", "src/"])).toBeInstanceOf(MypyFilter);
  });

  it("test_first_three_identical_errors_kept", () => {
    const out = _compress_mypy(_MYPY_MANY_ERRORS);
    expect(out).toContain("src/auth.py:10:0: error:");
    expect(out).toContain("src/auth.py:11:0: error:");
    expect(out).toContain("src/auth.py:12:0: error:");
  });

  it("test_fourth_identical_error_dropped", () => {
    const out = _compress_mypy(_MYPY_MANY_ERRORS);
    expect(out).not.toContain("src/auth.py:13:0: error:");
  });

  it("test_dedup_note_emitted", () => {
    const out = _compress_mypy(_MYPY_MANY_ERRORS);
    expect(out.includes("suppressed") && out.includes("duplicate")).toBeTruthy();
  });

  it("test_summary_line_always_kept", () => {
    const out = _compress_mypy(_MYPY_MANY_ERRORS);
    expect(out).toContain("Found 10 errors");
  });

  it("test_see_https_note_dropped", () => {
    const out = _compress_mypy(_MYPY_MIXED);
    expect(out).not.toContain("mypy.readthedocs.io");
  });

  it("test_repeated_note_deduped_after_three", () => {
    const out = _compress_mypy(_MYPY_MIXED);
    const occurrences = out.split("Did you forget to install a stub package").length - 1;
    expect(occurrences).toBe(3);
  });

  it("test_errors_prevented_further_checking_dropped", () => {
    const out = _compress_mypy(_MYPY_MIXED);
    expect(out).not.toContain("(errors prevented further checking)");
  });

  it("test_standalone_error_code_line_dropped", () => {
    const out = _compress_mypy(_MYPY_MIXED);
    expect(out).not.toContain("  [assignment]");
  });

  it("test_clean_output_preserved", () => {
    const out = _compress_mypy(_MYPY_CLEAN);
    expect(out).toContain("no issues found");
  });

  it("test_empty_input", () => {
    const out = _compress_mypy("");
    expect(typeof out).toBe("string");
  });
});
