/**
 * Tests for MypyFilter's enhanced error/note deduplication behaviour.
 *
 * 1:1 port of tests/test_bash_compress_mypy_enhanced.py. Every Python
 * `def test_*` maps to a vitest `it()` with the SAME name and assertion
 * polarity. The Python module is flat (no test classes), so all tests live in a
 * single top-level `describe()`.
 *
 * Test-seam mapping (Python -> TS):
 *  - `import token_goat.bash_compress as bc`
 *      -> import the barrel "../src/token_goat/bash_compress.js" as `bc`
 *        (re-exports the framework + MypyFilter + select_filter).
 *  - Module-level `_F = bc.MypyFilter()` -> a `const _F = new MypyFilter()`.
 *  - Module-level `_ARGV = ["mypy", "src/"]` -> the same array literal.
 *  - The `_compress(stdout, *, exit_code=1)` helper calls
 *    `_F.compress(stdout, "", exit_code, _ARGV)` DIRECTLY (not `.apply()`); the
 *    TS port mirrors that exactly — `Filter.compress` returns the body string.
 *  - `_error(file, line, msg)` / `_note(file, line, msg)` build mypy diagnostic
 *    lines `"{file}:{line}: error|note: {msg}"`; ported verbatim.
 *
 * Counting: Python `str.count(sub)` is NON-overlapping; the TS `_count` helper
 * below reproduces that exactly (`String.prototype.split(sub).length - 1`).
 * Substring `in` / `not in` checks map to `toContain` / `not.toContain`.
 *
 * Byte-exactness: these assertions are substring / non-overlapping-count checks
 * on the returned string, matching the Python `in` / `.count()` checks; no
 * String.length byte arithmetic is needed, so they translate directly. The
 * Unicode ellipsis used by the filter's normaliser is internal and never
 * asserted here.
 */
import { describe, expect, it } from "vitest";

import * as bc from "../src/token_goat/bash_compress.js";
import { MypyFilter } from "../src/token_goat/bash_compress.js";

const _F = new MypyFilter();
const _ARGV = ["mypy", "src/"];

// ---------------------------------------------------------------------------
// _compress: port of the module-level helper. Calls compress() directly with a
// fixed empty stderr and the shared argv; exit_code defaults to 1 (matching the
// Python keyword default).
// ---------------------------------------------------------------------------
function _compress(stdout: string, opts?: { exit_code?: number }): string {
  const exit_code = opts?.exit_code ?? 1;
  return _F.compress(stdout, "", exit_code, _ARGV);
}

function _error(file: string, line: number, msg: string): string {
  return `${file}:${line}: error: ${msg}`;
}

function _note(file: string, line: number, msg: string): string {
  return `${file}:${line}: note: ${msg}`;
}

// Non-overlapping substring count, matching Python str.count semantics.
function _count(haystack: string, needle: string): number {
  if (needle === "") {
    return haystack.length + 1;
  }
  return haystack.split(needle).length - 1;
}

describe("test_bash_compress_mypy_enhanced", () => {
  it("test_exactly_three_errors_all_kept", () => {
    // 3 identical errors should all be kept with no suppression note
    const stdout = [
      _error("src/foo.py", 10, "Incompatible type"),
      _error("src/foo.py", 10, "Incompatible type"),
      _error("src/foo.py", 10, "Incompatible type"),
    ].join("\n");
    const out = _compress(stdout);
    expect(_count(out, "Incompatible type")).toBe(3);
    expect(out.toLowerCase()).not.toContain("suppressed");
  });

  it("test_fourth_error_produces_suppression_note", () => {
    // 4 identical errors: first 3 kept, 4th dropped, suppression note says "1"
    const stdout = [
      _error("src/foo.py", 10, "Incompatible type"),
      _error("src/foo.py", 10, "Incompatible type"),
      _error("src/foo.py", 10, "Incompatible type"),
      _error("src/foo.py", 10, "Incompatible type"),
    ].join("\n");
    const out = _compress(stdout);
    expect(_count(out, "Incompatible type")).toBe(3);
    expect(out.toLowerCase()).toContain("suppressed 1");
  });

  it("test_suppression_note_count_matches_dropped", () => {
    // 7 identical errors: 3 kept, 4 dropped -> suppression note mentions "4"
    const stdout = Array.from({ length: 7 }, () =>
      _error("src/foo.py", 10, 'Argument of type "int"'),
    ).join("\n");
    const out = _compress(stdout);
    expect(_count(out, "Argument of type")).toBe(3);
    // Suppression note should mention 4 dropped
    expect(out).toContain("4");
    expect(out.toLowerCase()).toContain("suppressed");
  });

  it("test_quote_normalization_groups_errors", () => {
    // Different quoted values in same structural message should group separately
    // "Incompatible type "int"" and "Incompatible type "bool"" normalize to same key
    const stdout = [
      _error("src/a.py", 1, 'Incompatible type "int"'),
      _error("src/a.py", 2, 'Incompatible type "int"'),
      _error("src/a.py", 3, 'Incompatible type "int"'),
      _error("src/a.py", 4, 'Incompatible type "bool"'),
    ].join("\n");
    const out = _compress(stdout);
    // First 3 of the "int" variant kept, the "bool" variant dropped (different quoted string)
    // but all normalize the same after quote replacement, so 4th is dropped
    expect(_count(out, 'Incompatible type "int"') + _count(out, 'Incompatible type "bool"')).toBe(3);
    expect(out.toLowerCase()).toContain("suppressed");
  });

  it("test_warning_lines_kept", () => {
    // warning: lines pass through unchanged
    const stdout = "src/foo.py:1: warning: some warning";
    const out = _compress(stdout, { exit_code: 0 });
    expect(out).toContain("some warning");
  });

  it("test_blank_lines_pass_through", () => {
    // Blank lines between diagnostics are kept
    const stdout = [
      _error("src/foo.py", 10, "Error 1"),
      "",
      _error("src/foo.py", 20, "Error 2"),
    ].join("\n");
    const out = _compress(stdout);
    expect(_count(out, "\n\n") > 0 || out.includes("\n\n") || _count(out, "\n") > 2).toBe(true);
  });

  it("test_dmypy_dispatches_to_filter", () => {
    // dmypy binary name should dispatch to MypyFilter
    const f = bc.select_filter(["dmypy", "run"]);
    expect(f).not.toBeNull();
    expect(f!.name).toBe("mypy");
  });

  it("test_suppression_note_at_end_of_output", () => {
    // Suppression note appears after diagnostic lines, not interleaved
    const stdout = Array.from({ length: 4 }, () =>
      _error("src/foo.py", 10, "Error A"),
    ).join("\n");
    const out = _compress(stdout);
    // Find position of suppression note
    if (out.toLowerCase().includes("suppressed")) {
      const last_error_pos = out.lastIndexOf("Error A");
      const suppression_pos = out.toLowerCase().indexOf("suppressed");
      expect(suppression_pos, "Suppression note should appear after errors").toBeGreaterThan(
        last_error_pos,
      );
    }
  });

  it("test_exactly_three_notes_all_kept", () => {
    // 3 identical notes should all be kept with no dropped-notes suppression note
    const stdout = [
      _note("src/foo.py", 10, "See https://mypy.readthedocs.io/en/latest/"),
      _note("src/foo.py", 10, "See https://mypy.readthedocs.io/en/latest/"),
      _note("src/foo.py", 10, "See https://mypy.readthedocs.io/en/latest/"),
    ].join("\n");
    const out = _compress(stdout, { exit_code: 0 });
    // See https:// lines are dropped, so this should have 0 surviving
    expect(out).not.toContain("mypy.readthedocs.io");
  });

  it("test_fourth_note_produces_suppression_note", () => {
    // 4 identical non-reference notes: 3 kept, 4th dropped, suppression note present
    const stdout = [
      _note("src/foo.py", 10, "Suggestion: consider typing"),
      _note("src/foo.py", 10, "Suggestion: consider typing"),
      _note("src/foo.py", 10, "Suggestion: consider typing"),
      _note("src/foo.py", 10, "Suggestion: consider typing"),
    ].join("\n");
    const out = _compress(stdout, { exit_code: 0 });
    expect(_count(out, "Suggestion: consider typing")).toBe(3);
    expect(out.toLowerCase()).toContain("suppressed");
  });

  it("test_both_error_and_note_suppression_notes_present", () => {
    // When both errors and notes are suppressed, both suppression messages appear
    const error_lines = Array.from({ length: 4 }, () =>
      _error("src/foo.py", 10, "Error msg"),
    ).join("\n");
    const note_lines = Array.from({ length: 4 }, () =>
      _note("src/foo.py", 10, "Note msg"),
    ).join("\n");
    const stdout = error_lines + "\n" + note_lines;
    const out = _compress(stdout);
    // Should have 2 suppression notes (one for errors, one for notes)
    const suppression_count = _count(out.toLowerCase(), "suppressed");
    expect(suppression_count).toBe(2);
  });

  it("test_success_message_not_classified_as_error", () => {
    // "Success: no issues found" passes through, no suppression note
    const stdout = "Success: no issues found";
    const out = _compress(stdout, { exit_code: 0 });
    expect(out).toContain("Success: no issues found");
    expect(out.toLowerCase()).not.toContain("suppressed");
  });

  it("test_summary_line_always_kept", () => {
    // Summary line matching "Found N error(s) in M file(s)" always kept
    let stdout = Array.from({ length: 5 }, () =>
      _error("src/foo.py", 10, "Error A"),
    ).join("\n");
    stdout += "\nFound 5 errors in 1 file";
    const out = _compress(stdout);
    expect(out).toContain("Found 5 errors in 1 file");
  });

  it("test_errors_prevented_further_checking_dropped", () => {
    // "(errors prevented further checking)" messages are dropped
    const stdout = [
      _error("src/foo.py", 10, "Error before check"),
      "src/foo.py:11: error: (errors prevented further checking)",
    ].join("\n");
    const out = _compress(stdout);
    expect(out).not.toContain("errors prevented further checking");
  });

  it("test_context_display_notes_first_occurrence_preserved", () => {
    // First occurrence of a context-display note (e.g., indented detail) is preserved
    const stdout = [
      _error("src/foo.py", 10, "Main error"),
      _note("src/foo.py", 10, "Context about error"),
    ].join("\n");
    const out = _compress(stdout);
    // Both should be present
    expect(out).toContain("Main error");
    expect(out).toContain("Context about error");
  });

  it("test_context_display_notes_deduplicated_across_errors", () => {
    // Duplicate context notes deduplicated (keep first 3, drop rest)
    const stdout = [
      _error("src/foo.py", 10, "Error 1"),
      _note("src/foo.py", 10, "Context note"),
      _error("src/foo.py", 20, "Error 2"),
      _note("src/foo.py", 20, "Context note"),
      _error("src/foo.py", 30, "Error 3"),
      _note("src/foo.py", 30, "Context note"),
      _error("src/foo.py", 40, "Error 4"),
      _note("src/foo.py", 40, "Context note"),
    ].join("\n");
    const out = _compress(stdout);
    // First 3 context notes kept, 4th dropped
    expect(_count(out, "Context note")).toBe(3);
  });
});
