/**
 * 1:1 port of tests/test_bash_compress_gh_enhanced.py.
 *
 * Test-seam mapping (Python -> TS):
 *  - `import token_goat.bash_compress as bc`
 *      -> import the barrel "../src/token_goat/bash_compress.js" as `bc`.
 *  - Module-level `_F = bc.GhFilter()` + the `_run_view` / `_gh_list` / `_other`
 *    / `_make_list_output` module helpers -> top-level `const`/`function`
 *    equivalents below. They call `_F.compress(stdout, stderr, exit_code, argv)`
 *    directly (the Python tests bypass apply() and call compress()).
 *  - `bc.select_filter(...).name` -> `bc.select_filter(...)!.name`.
 *
 * Byte-exactness: every assertion is a substring `in`/`not in` check on the
 * compress() return; the fixtures are pure ASCII apart from the ✓/√/✗ status
 * glyphs (same Unicode codepoints as the Python source), so substring checks
 * translate directly with no Buffer arithmetic.
 */
import { expect, it } from "vitest";

import * as bc from "../src/token_goat/bash_compress.js";

const _F = new bc.GhFilter();

function _run_view(stdout: string, exit_code = 0): string {
  return _F.compress(stdout, "", exit_code, ["gh", "run", "view", "1234"]);
}

function _gh_list(stdout: string, subcommand: string): string {
  return _F.compress(stdout, "", 0, ["gh", subcommand, "list"]);
}

function _other(stdout: string, subcommand = "api"): string {
  return _F.compress(stdout, "", 0, ["gh", subcommand]);
}

function _make_list_output(n_rows: number): string {
  const header = "NUMBER  TITLE              BRANCH";
  const rows: string[] = [];
  for (let i = 1; i <= n_rows; i += 1) {
    rows.push(`${i}      PR title #${i}   feature/branch-${i}`);
  }
  return [header, ...rows].join("\n");
}

// Dispatch
it("test_filter_name_is_gh", () => {
  expect(bc.select_filter(["gh", "run", "view"])!.name).toBe("gh");
});

it("test_gh_pr_view_passthrough", () => {
  // gh pr without "list" action routes through _squeeze_blank_lines — no note emitted
  const out = _other("Title: foo\nBody: bar", "pr");
  expect(out).toContain("Title: foo");
  expect(out).toContain("Body: bar");
  expect(out).not.toContain("[token-goat:");
});

it("test_gh_api_passthrough", () => {
  // gh api routes through _squeeze_blank_lines — content passes through unchanged
  const content = '{"id": 1, "name": "test"}';
  const out = _other(content);
  expect(out).toContain(content);
  expect(out).not.toContain("[token-goat:");
});

// _compress_gh_run_view — pass-step collapse
it("test_pass_step_tick_removed", () => {
  // ✓ line is dropped by the pass-step collector
  const out = _run_view("✓ Set up job\nJob succeeded");
  expect(out).not.toContain("✓ Set up job");
});

it("test_pass_step_count_in_note", () => {
  // three ✓ lines produce a count note
  const out = _run_view("✓ Step 1\n✓ Step 2\n✓ Step 3\nJob succeeded");
  expect(out).toContain("collapsed 3 passing step headers");
});

it("test_pass_indented_children_dropped", () => {
  // indented child line after ✓ is dropped as action-preamble noise
  const out = _run_view("✓ Set up job\n  Run actions/checkout@v4\nJob succeeded");
  expect(out).not.toContain("Run actions/checkout@v4");
});

it("test_preamble_drop_count_in_note", () => {
  // two indented lines after ✓ produce a dropped-preamble count note
  const out = _run_view(
    "✓ Set up job\n  Run actions/checkout@v4\n  Run actions/setup-python@v4\nJob succeeded",
  );
  expect(out).toContain("dropped 2 action-preamble lines");
});

it("test_non_indented_line_not_dropped_in_pass_block", () => {
  // a non-indented line closes the pass block and is kept verbatim
  const out = _run_view("✓ Set up job\nNon-indented content\nMore content");
  expect(out).toContain("Non-indented content");
});

it("test_sqrt_symbol_triggers_pass_collapse", () => {
  // √ (U+221A SQUARE ROOT) also matches the pass-step regex
  const out = _run_view("√ Build\nJob succeeded");
  expect(out).not.toContain("√ Build");
  expect(out).toContain("collapsed 1 passing step headers");
});

it("test_empty_run_view_no_crash", () => {
  expect(_run_view("")).toBe("");
});

it("test_all_passing_produces_note_only", () => {
  // when every line is a ✓ step, output is just the collapsed-count note
  const linesArr: string[] = [];
  for (let i = 1; i <= 5; i += 1) {
    linesArr.push(`✓ Step ${i}`);
  }
  const lines = linesArr.join("\n");
  const out = _run_view(lines);
  expect(out).toContain("collapsed 5 passing step headers");
  expect(out).not.toContain("✓");
});

// _compress_gh_run_view — fail-step preservation
it("test_fail_step_cross_kept", () => {
  // ✗ line is kept verbatim (fail-step path)
  const out = _run_view("✗ Run linters\nJob failed");
  expect(out).toContain("✗ Run linters");
});

it("test_fail_block_indented_children_kept", () => {
  // indented lines after a ✗ step are kept because in_pass_block is False
  const out = _run_view(
    "✗ Run linters\n  Process completed with exit code 1.\n  ##[error]linter failed",
  );
  expect(out).toContain("Process completed with exit code 1.");
  expect(out).toContain("##[error]linter failed");
});

it("test_failed_prefix_triggers_fail_path", () => {
  // FAILED: matches ^\s*FAIL(:|ED|URE)\b — line kept
  const out = _run_view("FAILED: something went wrong");
  expect(out).toContain("FAILED: something went wrong");
});

it("test_failure_prefix_triggers_fail_path", () => {
  // FAILURE: matches ^\s*FAIL(:|ED|URE)\b — line kept
  const out = _run_view("FAILURE: something went wrong");
  expect(out).toContain("FAILURE: something went wrong");
});

it("test_error_prefix_triggers_fail_path", () => {
  // Error: matches ^\s*Error:\s — line kept
  const out = _run_view("Error: something went wrong");
  expect(out).toContain("Error: something went wrong");
});

it("test_pass_then_fail_mix", () => {
  // ✓ block collapsed (with note), ✗ line and its indented children kept
  const out = _run_view(
    [
      "✓ Set up job",
      "  Run actions/checkout@v4",
      "✗ Run linters",
      "  Process completed with exit code 1.",
      "Job failed",
    ].join("\n"),
  );
  expect(out).toContain("collapsed 1 passing step headers");
  expect(out).toContain("✗ Run linters");
  expect(out).toContain("Process completed with exit code 1.");
  expect(out).not.toContain("✓ Set up job");
});

// _compress_gh_list — truncation
it("test_list_30_rows_passthrough", () => {
  // exactly 30 data rows stays below the threshold — no truncation note
  const out = _gh_list(_make_list_output(30), "pr");
  expect(out).not.toContain("showing first");
});

it("test_list_31_rows_truncated", () => {
  // 31 data rows exceeds 30 — truncation note with exact counts
  const out = _gh_list(_make_list_output(31), "pr");
  expect(out).toContain("showing first 30 of 31 prs");
});

it("test_list_header_preserved_after_truncation", () => {
  // header row survives even when data rows are truncated
  const out = _gh_list(_make_list_output(31), "pr");
  expect(out).toContain("NUMBER  TITLE              BRANCH");
});

it("test_list_31st_row_absent", () => {
  // the 31st data row is cut off by the 30-row cap
  const out = _gh_list(_make_list_output(31), "pr");
  expect(out).not.toContain("PR title #31");
});

it("test_list_subcommand_name_in_note", () => {
  // note pluralises the subcommand name — "runs" for "run", "issues" for "issue"
  const run_out = _gh_list(_make_list_output(31), "run");
  expect(run_out).toContain("31 runs");
  const issue_out = _gh_list(_make_list_output(31), "issue");
  expect(issue_out).toContain("issues");
});
