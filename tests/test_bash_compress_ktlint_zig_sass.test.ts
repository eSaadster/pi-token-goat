/**
 * Tests for KtlintFilter, ZigFilter, and SassFilter in token_goat.bash_compress.
 *
 * 1:1 port of tests/test_bash_compress_ktlint_zig_sass.py. Every Python
 * `def test_*` maps to a vitest `it()` with the SAME name and assertion
 * polarity; the Python test classes (TestKtlintFilter, TestZigFilter,
 * TestSassFilter) map to `describe()` blocks of the same name. The Python
 * FilterTestMixin's two shared tests (test_empty_input, test_empty_output)
 * are inlined into each describe block — the mixin is not expressible in TS.
 *
 * Test-seam mapping (Python -> TS):
 *  - `from token_goat import bash_compress as bc`
 *      -> import the barrel "../src/token_goat/bash_compress.js" (re-exports
 *        KtlintFilter / ZigFilter / SassFilter + select_filter).
 *  - `from filter_test_helpers import apply_filter as _compress`
 *      -> local `_compress(filter_, opts?)` helper below; runs
 *         `filter_.apply(stdout, stderr, exit_code, argv).text`, defaulting
 *         argv to `[filter_.name]` when omitted (matching the Python helper).
 *
 * Byte-exactness: assertions are substring `in` / `not in` checks and
 * `.count()` checks on the returned text. The fixtures are pure ASCII so
 * Python `len` (code points) equals JS `.length` equals the UTF-8 byte count
 * — no Buffer arithmetic is needed for these inputs.
 */
import { describe, expect, it } from "vitest";

import {
  KtlintFilter,
  SassFilter,
  ZigFilter,
  select_filter,
} from "../src/token_goat/bash_compress.js";

import type { Filter } from "../src/token_goat/bash_compress.js";

// ---------------------------------------------------------------------------
// Local apply_filter helper (port of filter_test_helpers.apply_filter, aliased
// as `_compress` at the Python import site). When argv is omitted the filter's
// own `.name` is used as the sole argv element.
// ---------------------------------------------------------------------------
function _compress(
  filter_: Filter,
  opts?: { stdout?: string; stderr?: string; exit_code?: number; argv?: string[] },
): string {
  const stdout = opts?.stdout ?? "";
  const stderr = opts?.stderr ?? "";
  const exit_code = opts?.exit_code ?? 0;
  const argv = opts?.argv ?? [filter_.name];
  return filter_.apply(stdout, stderr, exit_code, argv).text;
}

/** Python str.count(sub) — count of non-overlapping occurrences. */
function _count(haystack: string, needle: string): number {
  if (needle === "") {
    return haystack.length + 1;
  }
  let n = 0;
  let idx = haystack.indexOf(needle);
  while (idx !== -1) {
    n += 1;
    idx = haystack.indexOf(needle, idx + needle.length);
  }
  return n;
}

// ===========================================================================
// KtlintFilter
// ===========================================================================

const _KTLINT_PLAIN = `src/main/kotlin/Foo.kt:10:5: error: Imports must be ordered alphabetically (import-ordering)
src/main/kotlin/Bar.kt:5:3: warning: Redundant curly braces (curly-spacing)
src/main/kotlin/Bar.kt:12:3: warning: Redundant curly braces (curly-spacing)
src/main/kotlin/Bar.kt:18:3: warning: Redundant curly braces (curly-spacing)
src/main/kotlin/Bar.kt:25:3: warning: Redundant curly braces (curly-spacing)
src/main/kotlin/Baz.kt:7:1: warning: Unnecessary trailing whitespace (trailing-whitespace)
`;

const _KTLINT_CLEAN = `No lint errors found.
`;

const _KTLINT_CHECKSTYLE = `<?xml version="1.0" encoding="UTF-8"?>
<checkstyle version="8.0">
<file name="src/main/kotlin/Foo.kt">
<error line="10" column="5" severity="error" message="Imports must be ordered alphabetically" source="import-ordering"/>
</file>
<file name="src/main/kotlin/Bar.kt">
<error line="5" column="3" severity="warning" message="Redundant curly braces" source="curly-spacing"/>
<error line="12" column="3" severity="warning" message="Redundant curly braces" source="curly-spacing"/>
<error line="18" column="3" severity="warning" message="Redundant curly braces" source="curly-spacing"/>
<error line="22" column="3" severity="warning" message="Redundant curly braces" source="curly-spacing"/>
</file>
</checkstyle>
`;

describe("TestKtlintFilter", () => {
  // --- matches -----------------------------------------------------------

  it("test_matches_ktlint", () => {
    const f = new KtlintFilter();
    expect(f.matches(["ktlint", "src/"])).toBeTruthy();
  });

  it("test_no_match_pylint", () => {
    const f = new KtlintFilter();
    expect(f.matches(["pylint", "src/"])).toBeFalsy();
  });

  it("test_no_match_eslint", () => {
    const f = new KtlintFilter();
    expect(f.matches(["eslint", "src/"])).toBeFalsy();
  });

  // --- select -----------------------------------------------------------

  it("test_select_filter", () => {
    const f = select_filter(["ktlint", "src/"]);
    expect(f instanceof KtlintFilter).toBe(true);
  });

  // --- compress: plain text dedup ----------------------------------------

  it("test_error_always_kept", () => {
    const f = new KtlintFilter();
    const out = _compress(f, { stdout: _KTLINT_PLAIN });
    // error severity line always kept
    expect(out).toContain("import-ordering");
    expect(out).toContain("10:5");
  });

  it("test_first_three_rule_occurrences_kept", () => {
    const f = new KtlintFilter();
    const out = _compress(f, { stdout: _KTLINT_PLAIN });
    // curly-spacing appears 4 times in Bar.kt — first 3 should be kept
    expect(out).toContain("Bar.kt:5:3");
    expect(out).toContain("Bar.kt:12:3");
    expect(out).toContain("Bar.kt:18:3");
  });

  it("test_fourth_occurrence_deduplicated", () => {
    const f = new KtlintFilter();
    const out = _compress(f, { stdout: _KTLINT_PLAIN });
    // Bar.kt:25:3 is the 4th curly-spacing — should not appear verbatim
    expect(out).not.toContain("Bar.kt:25:3");
  });

  it("test_different_rule_not_suppressed", () => {
    const f = new KtlintFilter();
    const out = _compress(f, { stdout: _KTLINT_PLAIN });
    expect(out).toContain("trailing-whitespace");
  });

  it("test_clean_output_preserved", () => {
    const f = new KtlintFilter();
    const out = _compress(f, { stdout: _KTLINT_CLEAN });
    expect(out).toContain("No lint errors");
  });

  it("test_dedup_fires_on_fourth", () => {
    const f = new KtlintFilter();
    // Build output that has 4 warnings of the same rule
    const many_same = Array.from(
      { length: 5 },
      (_v, i) => `src/Foo.kt:${i + 1}:1: warning: Redundant curly braces (curly-spacing)`,
    ).join("\n");
    const out = _compress(f, { stdout: many_same });
    // First 3 kept, 4th and 5th collapsed
    expect(out).toContain("1:1");
    expect(out).toContain("2:1");
    expect(out).toContain("3:1");
    expect(out).not.toContain("4:1");
    expect(
      out.toLowerCase().includes("more") ||
        out.toLowerCase().includes("deduplicated") ||
        out.includes("token-goat"),
    ).toBe(true);
  });

  // --- compress: checkstyle XML format -----------------------------------

  it("test_checkstyle_xml_tags_dropped", () => {
    const f = new KtlintFilter();
    const out = _compress(f, { stdout: _KTLINT_CHECKSTYLE });
    expect(out).not.toContain("<checkstyle");
    expect(out).not.toContain("<?xml");
    expect(out).not.toContain("<file name");
  });

  it("test_checkstyle_error_line_kept", () => {
    const f = new KtlintFilter();
    const out = _compress(f, { stdout: _KTLINT_CHECKSTYLE });
    expect(out).toContain("import-ordering");
  });

  it("test_checkstyle_dedup_by_source", () => {
    const f = new KtlintFilter();
    const out = _compress(f, { stdout: _KTLINT_CHECKSTYLE });
    // 4 curly-spacing <error> entries: first 3 kept, 4th collapsed
    expect(out).toContain("curly-spacing");
    // 4th entry (line="22") should be absent or replaced by a note
    expect(out).not.toContain('line="22"');
  });

  // --- compress: empty input (FilterTestMixin.test_empty_input) ----------

  it("test_empty_input", () => {
    const f = new KtlintFilter();
    const out = _compress(f, { stdout: "" });
    expect(typeof out).toBe("string");
  });

  // --- compress: empty output (FilterTestMixin.test_empty_output) --------

  it("test_empty_output", () => {
    const f = new KtlintFilter();
    const out = _compress(f, { stdout: "" });
    expect(typeof out).toBe("string");
  });
});

// ===========================================================================
// ZigFilter
// ===========================================================================

const _ZIG_BUILD_SUCCESS = `[1/7] Compiling foo.zig
[2/7] Compiling bar.zig
[3/7] Compiling baz.zig
[4/7] Compiling qux.zig
[5/7] Compiling quux.zig
[6/7] Linking lib.a
[7/7] Linking zig-out/bin/myapp
Build Summary: 7/7 steps succeeded
`;

const _ZIG_BUILD_FAIL = `[1/3] Compiling main.zig
src/main.zig:15:5: error: expected type 'u32', found 'bool'
src/main.zig:15:5: note: operand must be an integer
Build Summary: 1/3 steps succeeded; 2 failed
`;

const _ZIG_TEST_SUCCESS = `[1/1] test
test "addition works"... OK
test "subtraction works"... OK
test "multiplication works"... OK
All 3 tests passed.
`;

const _ZIG_TEST_FAIL = `[1/1] test
test "addition works"... OK
test "bad division"... FAIL (DivisionByZero)
1 passed; 1 failed.
`;

const _ZIG_FETCH = `info: Found cached package /home/user/.cache/zig/p/foo-1.2.3
fetch https://example.com/bar-2.0.tar.gz
[1/2] Compiling lib.zig
[2/2] Linking zig-out/lib/mylib.a
Build Summary: 2/2 steps succeeded
`;

describe("TestZigFilter", () => {
  // --- matches -----------------------------------------------------------

  it("test_matches_zig", () => {
    const f = new ZigFilter();
    expect(f.matches(["zig", "build"])).toBeTruthy();
  });

  it("test_matches_zig_test", () => {
    const f = new ZigFilter();
    expect(f.matches(["zig", "test", "src/"])).toBeTruthy();
  });

  it("test_no_match_zsh", () => {
    const f = new ZigFilter();
    expect(f.matches(["zsh", "-c", "echo hi"])).toBeFalsy();
  });

  it("test_no_match_zip", () => {
    const f = new ZigFilter();
    expect(f.matches(["zip", "archive.zip"])).toBeFalsy();
  });

  // --- select -----------------------------------------------------------

  it("test_select_filter", () => {
    const f = select_filter(["zig", "build"]);
    expect(f instanceof ZigFilter).toBe(true);
  });

  // --- compress: build success ------------------------------------------

  it("test_build_step_sample_kept", () => {
    const f = new ZigFilter();
    const out = _compress(f, { stdout: _ZIG_BUILD_SUCCESS });
    // First 5 steps kept
    expect(out).toContain("[1/7]");
    expect(out).toContain("[5/7]");
  });

  it("test_build_step_extra_collapsed", () => {
    const f = new ZigFilter();
    const out = _compress(f, { stdout: _ZIG_BUILD_SUCCESS });
    // [6/7] and [7/7] are beyond the 5-step sample
    expect(out).not.toContain("[6/7]");
    expect(out).not.toContain("[7/7]");
    expect(out.toLowerCase().includes("more") || out.includes("token-goat")).toBe(true);
  });

  it("test_build_summary_kept", () => {
    const f = new ZigFilter();
    const out = _compress(f, { stdout: _ZIG_BUILD_SUCCESS });
    expect(out).toContain("Build Summary");
    expect(out).toContain("7/7 steps succeeded");
  });

  // --- compress: build failure ------------------------------------------

  it("test_error_diagnostic_kept", () => {
    const f = new ZigFilter();
    const out = _compress(f, { stdout: _ZIG_BUILD_FAIL, exit_code: 1 });
    expect(out).toContain("error:");
    expect(out).toContain("expected type 'u32'");
  });

  it("test_note_diagnostic_kept", () => {
    const f = new ZigFilter();
    const out = _compress(f, { stdout: _ZIG_BUILD_FAIL, exit_code: 1 });
    expect(out).toContain("note:");
  });

  it("test_fail_summary_kept", () => {
    const f = new ZigFilter();
    const out = _compress(f, { stdout: _ZIG_BUILD_FAIL, exit_code: 1 });
    expect(out).toContain("Build Summary");
    expect(out).toContain("2 failed");
  });

  // --- compress: test success -------------------------------------------

  it("test_passing_tests_collapsed", () => {
    const f = new ZigFilter();
    const out = _compress(f, { stdout: _ZIG_TEST_SUCCESS });
    // "OK" test lines should be collapsed, not kept verbatim
    expect(out).not.toContain("addition works");
    expect(out).not.toContain("subtraction works");
  });

  it("test_passing_tests_collapse_note", () => {
    const f = new ZigFilter();
    const out = _compress(f, { stdout: _ZIG_TEST_SUCCESS });
    expect(out.includes("collapsed") || out.includes("token-goat")).toBe(true);
  });

  it("test_test_summary_kept", () => {
    const f = new ZigFilter();
    const out = _compress(f, { stdout: _ZIG_TEST_SUCCESS });
    expect(out).toContain("All 3 tests passed");
  });

  // --- compress: test failure -------------------------------------------

  it("test_failing_test_kept", () => {
    const f = new ZigFilter();
    const out = _compress(f, { stdout: _ZIG_TEST_FAIL, exit_code: 1 });
    expect(out).toContain("bad division");
    expect(out).toContain("FAIL");
  });

  it("test_test_fail_summary_kept", () => {
    const f = new ZigFilter();
    const out = _compress(f, { stdout: _ZIG_TEST_FAIL, exit_code: 1 });
    expect(out).toContain("1 passed");
    expect(out).toContain("1 failed");
  });

  // --- compress: fetch lines -------------------------------------------

  it("test_fetch_lines_collapsed", () => {
    const f = new ZigFilter();
    const out = _compress(f, { stdout: _ZIG_FETCH });
    expect(out).not.toContain("fetch https://");
    expect(out).not.toContain("Found cached");
    // Collapse note should appear
    expect(out.toLowerCase().includes("fetch") || out.includes("token-goat")).toBe(true);
  });

  // --- compress: empty input (FilterTestMixin.test_empty_input) ----------

  it("test_empty_input", () => {
    const f = new ZigFilter();
    const out = _compress(f, { stdout: "" });
    expect(typeof out).toBe("string");
  });

  // --- compress: empty output (FilterTestMixin.test_empty_output) --------

  it("test_empty_output", () => {
    const f = new ZigFilter();
    const out = _compress(f, { stdout: "" });
    expect(typeof out).toBe("string");
  });
});

// ===========================================================================
// SassFilter
// ===========================================================================

const _SASS_OUTPUT = `      write dist/main.css
      write dist/main.css.map
      write dist/components/button.css
      write dist/components/button.css.map
      write dist/components/form.css
      write dist/components/form.css.map
      write dist/components/modal.css
      write dist/components/modal.css.map
      write dist/pages/home.css
      write dist/pages/home.css.map
      write dist/pages/about.css
      write dist/pages/about.css.map
      write dist/pages/contact.css
      write dist/pages/contact.css.map
Compilation complete.
`;

const _SASS_DEPRECATION = `Deprecation Warning: Using / for division is deprecated and will be removed in Dart Sass 2.0.
More info: https://sass-lang.com/d/slash-div
    │
1   │   .icon { width: $size/2; }
    │                  ──────
    │
  styles/mixins.scss 1:20  mixin icon()
  styles/main.scss 5:3     @import

Deprecation Warning: Using / for division is deprecated and will be removed in Dart Sass 2.0.
More info: https://sass-lang.com/d/slash-div
    │
2   │   .btn { height: $h/4; }
    │
  styles/buttons.scss 2:10  mixin btn()

Deprecation Warning: Using / for division is deprecated and will be removed in Dart Sass 2.0.
More info: https://sass-lang.com/d/slash-div
    │
3   │   .card { padding: $p/3; }
    │
  styles/cards.scss 3:12   rule card

      write dist/app.css
Compilation complete.
`;

const _SASS_ERROR = `Error: Expected expression.
  │
3 │   color: ;
  │          ^
  │
  src/styles/main.scss 3:10  root stylesheet
`;

const _LESS_OUTPUT = `      write dist/main.css
      write dist/vendor.css
      write dist/print.css
Done compiling sass.
`;

describe("TestSassFilter", () => {
  // --- matches -----------------------------------------------------------

  it("test_matches_sass", () => {
    const f = new SassFilter();
    expect(f.matches(["sass", "src/", "dist/"])).toBeTruthy();
  });

  it("test_matches_scss", () => {
    const f = new SassFilter();
    expect(f.matches(["scss", "input.scss", "output.css"])).toBeTruthy();
  });

  it("test_matches_lessc", () => {
    const f = new SassFilter();
    expect(f.matches(["lessc", "input.less", "output.css"])).toBeTruthy();
  });

  it("test_matches_node_sass", () => {
    const f = new SassFilter();
    expect(f.matches(["node-sass", "--output-style", "compressed"])).toBeTruthy();
  });

  it("test_no_match_tsc", () => {
    const f = new SassFilter();
    expect(f.matches(["tsc", "--build"])).toBeFalsy();
  });

  it("test_no_match_ruff", () => {
    const f = new SassFilter();
    expect(f.matches(["ruff", "check"])).toBeFalsy();
  });

  // --- select -----------------------------------------------------------

  it("test_select_sass", () => {
    const f = select_filter(["sass", "styles/", "dist/"]);
    expect(f instanceof SassFilter).toBe(true);
  });

  it("test_select_lessc", () => {
    const f = select_filter(["lessc", "input.less"]);
    expect(f instanceof SassFilter).toBe(true);
  });

  // --- compress: file-write sample --------------------------------------

  it("test_first_five_write_lines_kept", () => {
    const f = new SassFilter();
    const out = _compress(f, { stdout: _SASS_OUTPUT });
    expect(out).toContain("dist/main.css");
    expect(out).toContain("dist/components/button.css");
    expect(out).toContain("dist/components/form.css");
  });

  it("test_write_extra_collapsed", () => {
    const f = new SassFilter();
    const out = _compress(f, { stdout: _SASS_OUTPUT });
    // 7 CSS files in fixture, only 5 fit in sample; 6th and 7th are collapsed
    expect(out).not.toContain("dist/pages/contact.css");
    expect(out.includes("token-goat") || out.toLowerCase().includes("more")).toBe(true);
  });

  it("test_source_map_lines_dropped", () => {
    const f = new SassFilter();
    const out = _compress(f, { stdout: _SASS_OUTPUT });
    expect(out).not.toContain(".css.map");
  });

  it("test_source_map_drop_note", () => {
    const f = new SassFilter();
    const out = _compress(f, { stdout: _SASS_OUTPUT });
    expect(out.includes("source-map") || out.includes("token-goat")).toBe(true);
  });

  it("test_summary_kept", () => {
    const f = new SassFilter();
    const out = _compress(f, { stdout: _SASS_OUTPUT });
    expect(out).toContain("Compilation complete");
  });

  // --- compress: deprecation dedup --------------------------------------

  it("test_first_two_deprecations_kept", () => {
    const f = new SassFilter();
    const out = _compress(f, { stdout: _SASS_DEPRECATION });
    // The first two deprecation warning headers should appear
    const deprecation_count = _count(out, "Deprecation Warning");
    expect(deprecation_count).toBeGreaterThanOrEqual(2);
  });

  it("test_third_deprecation_collapsed", () => {
    const f = new SassFilter();
    const out = _compress(f, { stdout: _SASS_DEPRECATION });
    // There are 3 identical deprecation warnings; third should be collapsed
    const deprecation_count = _count(out, "Deprecation Warning");
    // Should be 2 (kept) and a note, not 3
    expect(deprecation_count <= 2 || out.includes("collapsed") || out.includes("token-goat")).toBe(
      true,
    );
  });

  it("test_deprecation_note_emitted", () => {
    const f = new SassFilter();
    const out = _compress(f, { stdout: _SASS_DEPRECATION });
    expect(out.includes("collapsed") || out.includes("token-goat")).toBe(true);
  });

  it("test_compile_summary_kept_with_deprecations", () => {
    const f = new SassFilter();
    const out = _compress(f, { stdout: _SASS_DEPRECATION });
    expect(out).toContain("Compilation complete");
  });

  // --- compress: error output -------------------------------------------

  it("test_error_kept", () => {
    const f = new SassFilter();
    const out = _compress(f, { stdout: _SASS_ERROR, exit_code: 1 });
    expect(out).toContain("Error:");
    expect(out).toContain("Expected expression");
  });

  it("test_error_context_kept", () => {
    const f = new SassFilter();
    const out = _compress(f, { stdout: _SASS_ERROR, exit_code: 1 });
    expect(out).toContain("main.scss");
  });

  // --- compress: Less output -------------------------------------------

  it("test_less_write_lines_sampled", () => {
    const f = new SassFilter();
    const out = _compress(f, { stdout: _LESS_OUTPUT });
    expect(out).toContain("dist/main.css");
  });

  it("test_less_summary_kept", () => {
    const f = new SassFilter();
    const out = _compress(f, { stdout: _LESS_OUTPUT });
    expect(out).toContain("Done compiling sass");
  });

  // --- compress: empty input (FilterTestMixin.test_empty_input) ----------

  it("test_empty_input", () => {
    const f = new SassFilter();
    const out = _compress(f, { stdout: "" });
    expect(typeof out).toBe("string");
  });

  // --- compress: empty output (FilterTestMixin.test_empty_output) --------

  it("test_empty_output", () => {
    const f = new SassFilter();
    const out = _compress(f, { stdout: "" });
    expect(typeof out).toBe("string");
  });
});
