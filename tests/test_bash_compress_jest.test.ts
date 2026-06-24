/**
 * Tests for JestFilter, VitestFilter, and ESLintFilter.
 *
 * 1:1 port of tests/test_bash_compress_jest.py. Every Python `def test_*` maps
 * to a vitest `it()` with the SAME name and assertion polarity; the Python test
 * classes map to `describe()` blocks of the same name.
 *
 * Test-seam mapping (Python -> TS):
 *  - `from filter_test_helpers import apply_filter as _compress`
 *      -> local `_compress(filter, stdout, opts?)` helper below. The Python
 *        helper runs `filter_.apply(stdout, stderr, exit_code, argv).text`,
 *        defaulting argv to `[filter_.name]`; the TS port mirrors that exactly
 *        (apply() returns a CompressedOutput whose `.text` is the body).
 *  - `from token_goat import bash_compress as bc`
 *      -> import the barrel "../src/token_goat/bash_compress.js" as `bc`
 *        (re-exports the framework + the ported filter classes + select_filter).
 *  - Class-body `JEST = bc.JestFilter()` (a class attribute shared by the
 *    methods) -> a `const JEST = new JestFilter()` inside the describe block.
 *
 * ESLintFilter is now ported (bash_compress/linters.ts, re-exported via the
 * barrel), so every TestESLint* test is a live `it()` with the same name and
 * assertion polarity as its Python counterpart.
 *
 * Byte-exactness: the Jest/Vitest filters operate on whole lines and on UTF-8
 * marker glyphs (the check/cross marks). The assertions here are substring
 * checks on the returned string, matching the Python `in` / `not in` checks;
 * no String.length byte arithmetic is needed for these particular tests, so the
 * substring assertions translate directly. Where a glyph is asserted it is the
 * same Unicode codepoint as the Python source.
 */
import { describe, expect, it } from "vitest";

import * as bc from "../src/token_goat/bash_compress.js";
import { ESLintFilter, JestFilter, VitestFilter } from "../src/token_goat/bash_compress.js";

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
// JestFilter
// ===========================================================================

describe("TestJestFilterDispatch", () => {
  it("test_jest_direct", () => {
    expect(bc.select_filter(["jest"])).not.toBeNull();
    expect(bc.select_filter(["jest"])!.name).toBe("jest");
  });

  it("test_jest_via_npx", () => {
    const f = bc.select_filter(["npx", "jest"]);
    expect(f).not.toBeNull();
    expect(f!.name).toBe("jest");
  });

  it("test_mocha_dispatches_to_jest", () => {
    const f = bc.select_filter(["mocha", "tests/*.spec.js"]);
    expect(f).not.toBeNull();
    expect(f!.name).toBe("jest");
  });

  it("test_vitest_does_not_dispatch_to_jest", () => {
    // vitest now has its own VitestFilter; must not fall through to jest.
    const f = bc.select_filter(["vitest"]);
    expect(f).not.toBeNull();
    expect(f!.name).toBe("vitest");
  });
});

describe("TestJestFilterPassCollapse", () => {
  const JEST = new JestFilter();

  it("test_pass_lines_collapsed_to_count", () => {
    const lines = Array.from({ length: 8 }, (_, i) => `PASS  src/module${i}.test.js`);
    const text = lines.join("\n") + "\nTest Suites: 8 passed, 8 total\n";
    const result = _compress(JEST, text);
    expect(result).not.toContain("PASS  src/module0.test.js");
    expect(result).toContain("collapsed 8 PASS");
    expect(result).toContain("Test Suites: 8 passed");
  });

  it("test_single_pass_singular_label", () => {
    const result = _compress(JEST, "PASS  src/foo.test.js\n");
    expect(result).toContain("collapsed 1 PASS file");
  });

  it("test_pass_line_with_check_mark", () => {
    // check / sqrt file-level headers are also collapsed.
    const text = "✓ src/foo.test.js\n✓ src/bar.test.js\nTests: 2 passed\n";
    const result = _compress(JEST, text);
    expect(result).not.toContain("✓ src/foo.test.js");
    expect(result).toContain("collapsed 2 PASS file");
  });
});

describe("TestJestFilterFailBlock", () => {
  const JEST = new JestFilter();

  it("test_fail_block_kept_verbatim", () => {
    const text =
      "FAIL src/auth.test.js\n" +
      "  ● login › returns 401 for bad password\n" +
      "\n" +
      "    Expected: 401\n" +
      "    Received: 200\n" +
      "\n" +
      "Test Suites: 1 failed, 1 total\n";
    const result = _compress(JEST, text, { exit_code: 1 });
    expect(result).toContain("FAIL src/auth.test.js");
    expect(result).toContain("Expected: 401");
    expect(result).toContain("Received: 200");
  });

  it("test_mixed_pass_and_fail", () => {
    const text =
      "PASS src/a.test.js\n" +
      "PASS src/b.test.js\n" +
      "FAIL src/c.test.js\n" +
      "  ● bad thing\n" +
      "\n" +
      "Test Suites: 2 passed, 1 failed, 3 total\n";
    const result = _compress(JEST, text, { exit_code: 1 });
    expect(result).not.toContain("PASS src/a.test.js");
    expect(result).toContain("collapsed 2 PASS");
    expect(result).toContain("FAIL src/c.test.js");
    expect(result).toContain("bad thing");
  });
});

describe("TestJestFilterTickCollapse", () => {
  const JEST = new JestFilter();

  it("test_passing_ticks_collapsed", () => {
    const text =
      "PASS src/foo.test.js\n" +
      "  ✓ does something (3 ms)\n" +
      "  ✓ does another thing (5 ms)\n" +
      "Tests: 2 passed, 2 total\n";
    const result = _compress(JEST, text);
    expect(result).not.toContain("✓ does something");
    expect(result).toContain("collapsed 2 passing tick");
  });

  it("test_fail_block_ticks_kept", () => {
    // check lines inside a FAIL block must survive.
    const text =
      "FAIL src/foo.test.js\n" +
      "  ✓ passing test (2 ms)\n" +
      "  × failing test\n";
    const result = _compress(JEST, text, { exit_code: 1 });
    expect(result).toContain("✓ passing test");
  });
});

describe("TestJestFilterConsoleLogs", () => {
  const JEST = new JestFilter();

  it("test_console_log_block_collapsed", () => {
    const text =
      "PASS src/foo.test.js\n" +
      "  console.log src/util.js:12\n" +
      "    debug info line 1\n" +
      "    debug info line 2\n" +
      "    debug info line 3\n" +
      "Tests: 1 passed\n";
    const result = _compress(JEST, text);
    expect(result).not.toContain("debug info line 1");
    expect(result).toContain("collapsed");
    expect(result).toContain("console output line");
  });

  it("test_console_warn_collapsed", () => {
    const text =
      "  console.warn src/warn.js:5\n" +
      "    something deprecation\n" +
      "Tests: 1 passed\n";
    const result = _compress(JEST, text);
    expect(result).not.toContain("something deprecation");
    expect(result).toContain("console output line");
  });

  it("test_non_console_lines_kept", () => {
    const text = "PASS src/foo.test.js\nconsole in name but not pattern\nTests: 1 passed\n";
    const result = _compress(JEST, text);
    expect(result).toContain("console in name but not pattern");
  });
});

describe("TestJestFilterSummaryKept", () => {
  const JEST = new JestFilter();

  it("test_summary_lines_always_kept", () => {
    const text = [
      "PASS src/a.test.js",
      "PASS src/b.test.js",
      "Test Suites: 2 passed, 2 total",
      "Tests:       10 passed, 10 total",
      "Snapshots:   0 total",
      "Time:        3.214 s",
      "Ran all test suites.",
    ].join("\n");
    const result = _compress(JEST, text);
    expect(result).toContain("Test Suites: 2 passed");
    expect(result).toContain("Tests:       10 passed");
    expect(result).toContain("Time:        3.214 s");
  });
});

// ===========================================================================
// VitestFilter
// ===========================================================================

describe("TestVitestFilterDispatch", () => {
  it("test_vitest_direct", () => {
    const f = bc.select_filter(["vitest"]);
    expect(f).not.toBeNull();
    expect(f!.name).toBe("vitest");
  });

  it("test_vitest_via_npx", () => {
    const f = bc.select_filter(["npx", "vitest"]);
    expect(f).not.toBeNull();
    expect(f!.name).toBe("vitest");
  });

  it("test_vitest_run_subcommand", () => {
    const f = bc.select_filter(["vitest", "run"]);
    expect(f).not.toBeNull();
    expect(f!.name).toBe("vitest");
  });
});

describe("TestVitestFilterPassCollapse", () => {
  const VITEST = new VitestFilter();

  it("test_pass_file_lines_collapsed", () => {
    const text =
      " ✓ src/foo.test.ts (12.34 ms)\n" +
      " ✓ src/bar.test.ts (8.1 ms)\n" +
      "Test Files  2 passed (2)\n" +
      "Tests       15 passed (15)\n" +
      "Duration    0.52 s\n";
    const result = _compress(VITEST, text);
    expect(result).not.toContain("✓ src/foo.test.ts");
    expect(result).toContain("collapsed 2 passing file");
    expect(result).toContain("Test Files  2 passed");
    expect(result).toContain("Duration    0.52 s");
  });

  it("test_single_pass_singular_label", () => {
    const text = " ✓ src/only.test.ts (5 ms)\nTest Files  1 passed (1)\n";
    const result = _compress(VITEST, text);
    expect(result).toContain("collapsed 1 passing file");
  });
});

describe("TestVitestFilterFailBlock", () => {
  const VITEST = new VitestFilter();

  it("test_fail_file_kept_verbatim", () => {
    const text =
      " × src/broken.test.ts (100 ms)\n" +
      "   AssertionError: expected 1 to equal 2\n" +
      "   at Object.<anonymous> (src/broken.test.ts:10:5)\n" +
      "\n" +
      "Test Files  0 passed | 1 failed (1)\n";
    const result = _compress(VITEST, text, { exit_code: 1 });
    expect(result).toContain("× src/broken.test.ts");
    expect(result).toContain("AssertionError");
  });

  it("test_mixed_pass_and_fail", () => {
    const text =
      " ✓ src/good.test.ts (5 ms)\n" +
      " × src/bad.test.ts (50 ms)\n" +
      "   Error: something went wrong\n" +
      "\n" +
      "Test Files  1 passed | 1 failed (2)\n";
    const result = _compress(VITEST, text, { exit_code: 1 });
    expect(result).not.toContain("✓ src/good.test.ts");
    expect(result).toContain("collapsed 1 passing file");
    expect(result).toContain("× src/bad.test.ts");
    expect(result).toContain("Error: something went wrong");
  });
});

describe("TestVitestFilterTestTicks", () => {
  const VITEST = new VitestFilter();

  it("test_per_test_ticks_collapsed", () => {
    const text =
      " ✓ src/foo.test.ts (10 ms)\n" +
      "   ✓ renders correctly\n" +
      "   ✓ handles click\n" +
      "   ✓ shows error state\n" +
      "Test Files  1 passed (1)\n";
    const result = _compress(VITEST, text);
    expect(result).not.toContain("renders correctly");
    expect(result).toContain("collapsed 3 passing tick");
  });
});

describe("TestVitestFilterSummaryKept", () => {
  const VITEST = new VitestFilter();

  it("test_summary_lines_kept", () => {
    const text =
      " ✓ src/a.test.ts (3 ms)\n" +
      "Test Files  1 passed (1)\n" +
      "Tests       5 passed (5)\n" +
      "Duration    0.3 s\n";
    const result = _compress(VITEST, text);
    expect(result).toContain("Test Files  1 passed");
    expect(result).toContain("Tests       5 passed");
    expect(result).toContain("Duration    0.3 s");
  });
});

describe("TestVitestFilterStdoutCollapse", () => {
  const VITEST = new VitestFilter();

  it("test_stdout_block_collapsed", () => {
    const text =
      " stdout | src/foo.test.ts\n" +
      "   debug message 1\n" +
      "   debug message 2\n" +
      "Test Files  1 passed (1)\n";
    const result = _compress(VITEST, text);
    expect(result).not.toContain("debug message 1");
    expect(result).toContain("collapsed");
    expect(result).toContain("stdout line");
  });
});

// ===========================================================================
// ESLintFilter
// ===========================================================================

describe("TestESLintFilterDispatch", () => {
  it("test_eslint_direct", () => {
    const f = bc.select_filter(["eslint"]);
    expect(f).not.toBeNull();
    expect(f!.name).toBe("eslint");
  });

  it("test_eslint_via_npx", () => {
    const f = bc.select_filter(["npx", "eslint"]);
    expect(f).not.toBeNull();
    expect(f!.name).toBe("eslint");
  });

  it("test_eslint_not_handled_by_linter", () => {
    // ESLintFilter must win over LinterFilter for "eslint".
    const f = bc.select_filter(["eslint", "src/", "--ext", ".ts"]);
    expect(f).not.toBeNull();
    expect(f!.name).toBe("eslint");
  });
});

describe("TestESLintFilterCleanExit", () => {
  const ESLINT = new ESLintFilter();

  it("test_exit_0_collapses_to_terse", () => {
    const text = "src/foo.js\n" + "✖ 0 problems (0 errors, 0 warnings)\n";
    const result = _compress(ESLINT, text, { exit_code: 0 });
    // Should either return the summary line or a terse "no errors" message.
    expect(
      result.toLowerCase().includes("error") || result.toLowerCase().includes("problem"),
    ).toBe(true);
    // Must not retain individual file stanza lines for a clean run.
    expect(result).not.toContain("src/foo.js");
  });

  it("test_exit_0_no_output_returns_no_errors", () => {
    const result = _compress(ESLINT, "", { exit_code: 0 });
    expect(result.toLowerCase().includes("no errors") || result === "").toBe(true);
  });
});

describe("TestESLintFilterZeroProblemFiles", () => {
  const ESLINT = new ESLintFilter();

  it("test_zero_problem_files_dropped", () => {
    const text =
      "src/clean.js\n" +
      "\n" +
      "src/dirty.js\n" +
      "  3:1  error  'foo' is not defined  no-undef\n" +
      "\n" +
      "✖ 1 problem (1 error, 0 warnings)\n";
    const result = _compress(ESLINT, text, { exit_code: 1 });
    expect(result).not.toContain("src/clean.js");
    expect(result).toContain("src/dirty.js");
    expect(result).toContain("'foo' is not defined");
    expect(result).toContain("✖ 1 problem");
  });
});

describe("TestESLintFilterErrorsKept", () => {
  const ESLINT = new ESLintFilter();

  it("test_error_lines_always_kept", () => {
    const lines = Array.from(
      { length: 7 },
      (_, k) => `  ${k + 1}:1  error  'x${k + 1}' is not defined  no-undef`,
    );
    const text =
      "src/messy.js\n" + lines.join("\n") + "\n✖ 7 problems (7 errors, 0 warnings)\n";
    const result = _compress(ESLINT, text, { exit_code: 1 });
    // All error lines must survive (errors are never deduplicated).
    for (let i = 1; i < 8; i++) {
      expect(result).toContain(`x${i}' is not defined`);
    }
  });
});

describe("TestESLintFilterWarningDedup", () => {
  const ESLINT = new ESLintFilter();

  it("test_repeated_warnings_deduplicated", () => {
    const warn_lines = Array.from(
      { length: 8 },
      (_, k) => `  ${k + 1}:1  warning  Missing semicolon  semi`,
    );
    const text =
      "src/foo.js\n" + warn_lines.join("\n") + "\n✖ 8 problems (0 errors, 8 warnings)\n";
    const result = _compress(ESLINT, text, { exit_code: 1 });
    // At most 3 examples kept; remainder summarised.
    const semicolon_lines = result.split("\n").filter((ln) => ln.includes("Missing semicolon"));
    expect(semicolon_lines.length).toBe(3);
    expect(result).toContain("+5 more semi warnings");
  });

  it("test_warnings_with_few_occurrences_kept_verbatim", () => {
    const text =
      "src/foo.js\n" +
      "  1:1  warning  Use === instead of ==  eqeqeq\n" +
      "  2:1  warning  Use === instead of ==  eqeqeq\n" +
      "✖ 2 problems (0 errors, 2 warnings)\n";
    const result = _compress(ESLINT, text, { exit_code: 1 });
    const eqeqeq_lines = result
      .split("\n")
      .filter((ln) => ln.includes("eqeqeq") && ln.includes("warning"));
    expect(eqeqeq_lines.length).toBe(2);
  });

  it("test_summary_line_always_kept", () => {
    const text =
      "src/foo.js\n" +
      "  1:1  error  bad thing  rule-name\n" +
      "✖ 1 problem (1 error, 0 warnings)\n";
    const result = _compress(ESLINT, text, { exit_code: 1 });
    expect(result).toContain("✖ 1 problem");
  });

  it("test_mixed_errors_and_warnings", () => {
    const text =
      "src/app.js\n" +
      "  1:1  error    'React' must be in scope  react/react-in-jsx-scope\n" +
      Array.from({ length: 6 }, (_, k) => `  ${k + 2}:1  warning  Missing semicolon  semi`).join(
        "\n",
      ) +
      "\n✖ 7 problems (1 error, 6 warnings)\n";
    const result = _compress(ESLINT, text, { exit_code: 1 });
    // Error kept.
    expect(result).toContain("react/react-in-jsx-scope");
    // Warnings deduped: exactly 3 actual issue lines kept plus 1 summary note.
    const semi_issue_lines = result
      .split("\n")
      .filter((ln) => ln.includes("warning") && ln.includes("Missing semicolon"));
    expect(semi_issue_lines.length).toBe(3);
    expect(result).toContain("+3 more semi warnings");
  });
});

describe("TestESLintFilterMultipleFiles", () => {
  const ESLINT = new ESLintFilter();

  it("test_multiple_dirty_files_each_get_header", () => {
    const text =
      "src/a.js\n" +
      "  1:1  error  bad  rule-a\n" +
      "src/b.js\n" +
      "  1:1  error  bad  rule-b\n" +
      "✖ 2 problems (2 errors, 0 warnings)\n";
    const result = _compress(ESLINT, text, { exit_code: 1 });
    expect(result).toContain("src/a.js");
    expect(result).toContain("src/b.js");
  });

  it("test_clean_file_between_dirty_files_dropped", () => {
    const text =
      "src/dirty1.js\n" +
      "  1:1  error  bad  rule-x\n" +
      "src/clean.js\n" +
      "src/dirty2.js\n" +
      "  2:1  error  also bad  rule-y\n" +
      "✖ 2 problems (2 errors, 0 warnings)\n";
    const result = _compress(ESLINT, text, { exit_code: 1 });
    expect(result).toContain("src/dirty1.js");
    expect(result).not.toContain("src/clean.js");
    expect(result).toContain("src/dirty2.js");
  });
});
