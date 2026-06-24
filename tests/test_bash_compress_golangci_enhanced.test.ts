/**
 * Enhanced tests for GolangciLintFilter — per-(file,linter) dedup, noise
 * suppression, placeholders.
 *
 * 1:1 port of tests/test_bash_compress_golangci_enhanced.py. Every Python
 * `def test_*` maps to a vitest `it()` with the SAME name and assertion
 * polarity. The Python module had no test classes (flat function tests), so the
 * TS port keeps the tests in module scope without a describe() wrapper.
 *
 * Test-seam mapping (Python -> TS):
 *  - `from tests.filter_test_helpers import apply_filter, savings_ratio`
 *      -> local `apply_filter` / `savings_ratio` helpers below, ported 1:1 from
 *        tests/filter_test_helpers.py. apply_filter runs
 *        `filter_.apply(stdout, stderr, exit_code, argv).text`; savings_ratio
 *        returns `filter_.apply(...).percent_saved / 100.0`.
 *  - `from token_goat import bash_compress as bc`
 *      -> import the barrel "../src/token_goat/bash_compress.js" as `bc`
 *        (re-exports the framework + GolangciLintFilter + select_filter).
 *  - module-level `_F = bc.GolangciLintFilter()` -> `const _F = new GolangciLintFilter()`.
 *  - module-level `_ARGV = [...]` and `_apply(...)` helper -> the same module-level
 *    const + local `_apply` closure binding _F / _ARGV.
 *
 * Byte-exactness: GolangciLintFilter operates on whole lines; the assertions
 * here are substring `in` / `not in` checks (toContain / not.toContain) and two
 * savings-ratio bounds, matching the Python checks directly. The savings_ratio
 * helper reads percent_saved, whose underlying byte math is UTF-8 inside the
 * framework — no String.length arithmetic is performed in this test file.
 */
import { expect, it } from "vitest";

import * as bc from "../src/token_goat/bash_compress.js";
import { GolangciLintFilter } from "../src/token_goat/bash_compress.js";

import type { Filter } from "../src/token_goat/bash_compress.js";

// ---------------------------------------------------------------------------
// Local apply_filter / savings_ratio helpers (port of
// tests/filter_test_helpers.py — apply_filter / savings_ratio).
//
// When argv is omitted the filter's own `.name` is used as the sole argv
// element. These standalone copies keep this test file self-contained.
// ---------------------------------------------------------------------------
function apply_filter(
  filter_: Filter,
  opts?: { stdout?: string; stderr?: string; exit_code?: number; argv?: string[] },
): string {
  const stdout = opts?.stdout ?? "";
  const stderr = opts?.stderr ?? "";
  const exit_code = opts?.exit_code ?? 0;
  const argv = opts?.argv ?? [filter_.name];
  return filter_.apply(stdout, stderr, exit_code, argv).text;
}

function savings_ratio(
  filter_: Filter,
  opts: { stdout: string; stderr?: string; argv?: string[] },
): number {
  const stdout = opts.stdout;
  const stderr = opts.stderr ?? "";
  const argv = opts.argv ?? [filter_.name];
  return filter_.apply(stdout, stderr, 0, argv).percent_saved / 100.0;
}

const _F = new GolangciLintFilter();
const _ARGV = ["golangci-lint", "run", "./..."];

function _apply(stdout: string, stderr = "", exit_code = 0): string {
  return apply_filter(_F, { stdout, stderr, exit_code, argv: _ARGV });
}

// ---------------------------------------------------------------------------
// Dispatch / match
// ---------------------------------------------------------------------------

it("test_matches_direct_run", () => {
  expect(_F.matches(["golangci-lint", "run", "./..."])).toBe(true);
});

it("test_matches_bare_binary", () => {
  expect(_F.matches(["golangci-lint"])).toBe(true);
});

it("test_matches_exe_extension", () => {
  expect(_F.matches(["golangci-lint.exe", "run", "./..."])).toBe(true);
});

it("test_matches_npx_invocation", () => {
  expect(_F.matches(["npx", "golangci-lint", "run", "./..."])).toBe(true);
});

it("test_matches_pnpx_invocation", () => {
  expect(_F.matches(["pnpx", "golangci-lint", "run"])).toBe(true);
});

it("test_no_match_go_vet", () => {
  expect(_F.matches(["go", "vet", "./..."])).toBe(false);
});

it("test_no_match_revive", () => {
  expect(_F.matches(["revive", "./..."])).toBe(false);
});

it("test_no_match_empty_argv", () => {
  expect(_F.matches([])).toBe(false);
});

it("test_dispatch_routes_to_golangci", () => {
  const f = bc.select_filter(["golangci-lint", "run", "./..."]);
  expect(f).not.toBeNull();
  expect(f!.name).toBe("golangci-lint");
});

it("test_dispatch_routes_bare_golangci", () => {
  const f = bc.select_filter(["golangci-lint"]);
  expect(f).not.toBeNull();
  expect(f!.name).toBe("golangci-lint");
});

it("test_golangci_in_all_exports", () => {
  expect(bc.__all__).toContain("GolangciLintFilter");
});

// ---------------------------------------------------------------------------
// Noise suppression
// ---------------------------------------------------------------------------

const _NOISE_BLOCK =
  "golangci-lint version 1.57.2 built from ...\n" +
  'time=2026-05-31T10:00:00Z level=info msg="Running linters"\n' +
  'time=2026-05-31T10:00:00Z level=debug msg="Starting linter: unused"\n' +
  'time=2026-05-31T10:00:01Z level=info msg="Finishing linting"\n';

it("test_version_line_dropped", () => {
  const out = _apply(_NOISE_BLOCK);
  expect(out).not.toContain("golangci-lint version");
});

it("test_info_log_lines_dropped", () => {
  const out = _apply(_NOISE_BLOCK);
  expect(out).not.toContain("level=info");
});

it("test_debug_log_lines_dropped", () => {
  const out = _apply(_NOISE_BLOCK);
  expect(out).not.toContain("level=debug");
});

it("test_noise_drop_note_emitted", () => {
  const out = _apply(_NOISE_BLOCK);
  // Four noise lines; token-goat should emit a drop note.
  expect(out).toContain("token-goat");
});

// ---------------------------------------------------------------------------
// Signal preservation
// ---------------------------------------------------------------------------

const _SIGNAL_BLOCK =
  'time=2026-05-31T10:00:00Z level=info msg="Running linters"\n' +
  "ERRO [loader] could not load package: pkg/missing\n" +
  "WARN [runner] linter timeout: revive\n" +
  "pkg/util/util.go:8:3: exported function Baz without comment (revive)\n" +
  "Run with --fix to fix some of the issues\n" +
  "Found 3 issues.\n";

it("test_erro_line_kept", () => {
  const out = _apply(_SIGNAL_BLOCK);
  expect(out).toContain("ERRO [loader]");
});

it("test_warn_line_kept", () => {
  const out = _apply(_SIGNAL_BLOCK);
  expect(out).toContain("WARN [runner]");
});

it("test_issue_line_kept", () => {
  const out = _apply(_SIGNAL_BLOCK);
  expect(out).toContain("pkg/util/util.go:8:3");
});

it("test_run_with_fix_summary_kept", () => {
  const out = _apply(_SIGNAL_BLOCK);
  expect(out).toContain("Run with --fix");
});

it("test_found_n_issues_summary_kept", () => {
  const out = _apply(_SIGNAL_BLOCK);
  expect(out).toContain("Found 3 issues.");
});

it("test_error_exit_stderr_preserved", () => {
  const stderr = "golangci-lint: fatal: could not parse config\n";
  const out = apply_filter(_F, { stdout: "", stderr, exit_code: 1, argv: _ARGV });
  expect(out).toContain("fatal");
});

// ---------------------------------------------------------------------------
// Per-(file, linter) deduplication — boundary cases
// ---------------------------------------------------------------------------

function _make_issues(n: number, file = "pkg/big/big.go", linter = "unused"): string {
  const out: string[] = [];
  for (let i = 1; i <= n; i += 1) {
    out.push(`${file}:${i}:1: variable \`x${i}\` is unused (${linter})`);
  }
  return out.join("\n");
}

it("test_exactly_keep_first_n_issues_all_kept", () => {
  // _KEEP_FIRST_N = 3; exactly 3 issues -> all kept, no placeholder.
  const out = _apply(_make_issues(3));
  expect(out).toContain("pkg/big/big.go:1:1");
  expect(out).toContain("pkg/big/big.go:2:1");
  expect(out).toContain("pkg/big/big.go:3:1");
  expect(out).not.toContain("omitted");
  expect(out).not.toContain("__placeholder__");
});

it("test_one_over_keep_first_n_emits_placeholder", () => {
  // 4 issues: first 3 kept, 4th triggers placeholder.
  const out = _apply(_make_issues(4));
  expect(out).toContain("pkg/big/big.go:1:1");
  expect(out).toContain("pkg/big/big.go:2:1");
  expect(out).toContain("pkg/big/big.go:3:1");
  expect(out).not.toContain("pkg/big/big.go:4:1");
  expect(out).toContain("omitted");
});

it("test_placeholder_count_is_accurate", () => {
  // 7 issues, keep 3 -> 4 omitted; collapse note says "4" somewhere.
  const out = _apply(_make_issues(7));
  expect(out).toContain("4");
  expect(out.includes("omitted") || out.includes("collapsed")).toBe(true);
});

it("test_placeholder_names_linter", () => {
  const out = _apply(_make_issues(5, "pkg/big/big.go", "errcheck"));
  expect(out).toContain("errcheck");
});

it("test_placeholder_names_file", () => {
  const out = _apply(_make_issues(5, "internal/server/server.go"));
  expect(out).toContain("internal/server/server.go");
});

it("test_max_issues_boundary_exactly_10_no_collapse", () => {
  // _MAX_ISSUES_PER_FILE_LINTER = 10; exactly 10 issues -> 7 beyond _KEEP_FIRST_N=3.
  const out = _apply(_make_issues(10));
  expect(out).toContain("7");
  expect(out.includes("omitted") || out.includes("collapsed")).toBe(true);
});

it("test_issues_beyond_max_all_omitted_in_placeholder", () => {
  // 20 issues -> first 3 kept, remainder noted in collapse message.
  const out = _apply(_make_issues(20));
  expect(out).toContain("pkg/big/big.go:1:1");
  expect(out).not.toContain("pkg/big/big.go:4:1");
  expect(out.includes("collapsed") || out.includes("omitted")).toBe(true);
});

it("test_raw_placeholder_string_never_in_output", () => {
  // The internal __placeholder__ sentinel must never leak.
  const out = _apply(_make_issues(10));
  expect(out).not.toContain("__placeholder__");
});

// ---------------------------------------------------------------------------
// Multiple (file, linter) groups — independence
// ---------------------------------------------------------------------------

const _MULTI_GROUP =
  "pkg/a/a.go:1:1: unused var (unused)\n" +
  "pkg/a/a.go:2:1: unused var (unused)\n" +
  "pkg/a/a.go:3:1: unused var (unused)\n" +
  "pkg/a/a.go:4:1: unused var (unused)\n" +
  "pkg/b/b.go:1:1: error return not checked (errcheck)\n" +
  "pkg/b/b.go:2:1: error return not checked (errcheck)\n" +
  "pkg/b/b.go:3:1: error return not checked (errcheck)\n" +
  "pkg/b/b.go:4:1: error return not checked (errcheck)\n";

it("test_two_groups_each_get_independent_placeholder", () => {
  const out = _apply(_MULTI_GROUP);
  // Both groups collapse -> two placeholder notes.
  expect(out).toContain("pkg/a/a.go");
  expect(out).toContain("pkg/b/b.go");
  expect(out).toContain("unused");
  expect(out).toContain("errcheck");
});

it("test_same_file_different_linters_tracked_independently", () => {
  // Same file, two linters; each group has its own counter.
  const lines: string[] = [];
  for (const linter of ["unused", "errcheck"]) {
    for (let i = 1; i <= 4; i += 1) {
      lines.push(`pkg/x/x.go:${i}:1: msg (${linter})`);
    }
  }
  const out = _apply(lines.join("\n"));
  expect(out).toContain("unused");
  expect(out).toContain("errcheck");
});

it("test_same_linter_different_files_tracked_independently", () => {
  // Same linter, two files; each file gets its own counter.
  const lines: string[] = [];
  for (const pkg of ["alpha", "beta"]) {
    for (let i = 1; i <= 4; i += 1) {
      lines.push(`pkg/${pkg}/f.go:${i}:1: msg (unused)`);
    }
  }
  const out = _apply(lines.join("\n"));
  expect(out).toContain("alpha/f.go");
  expect(out).toContain("beta/f.go");
});

// ---------------------------------------------------------------------------
// Collapse note wording
// ---------------------------------------------------------------------------

it("test_collapse_note_mentions_collapsed_count", () => {
  const out = _apply(_make_issues(15));
  expect(out.includes("collapsed") || out.includes("omitted")).toBe(true);
});

it("test_collapse_note_mentions_linter", () => {
  const out = _apply(_make_issues(10, "pkg/big/big.go", "staticcheck"));
  expect(out).toContain("staticcheck");
});

// ---------------------------------------------------------------------------
// Empty and edge-case inputs
// ---------------------------------------------------------------------------

it("test_empty_stdout_no_crash", () => {
  const out = _apply("");
  expect(typeof out).toBe("string");
});

it("test_empty_stdout_empty_stderr_no_crash", () => {
  const out = apply_filter(_F, { stdout: "", stderr: "", exit_code: 0, argv: _ARGV });
  expect(typeof out).toBe("string");
});

it("test_single_issue_kept_verbatim", () => {
  const line = "cmd/main.go:10:3: exported type Foo without comment (revive)\n";
  const out = _apply(line);
  expect(out).toContain("cmd/main.go:10:3");
});

it("test_non_go_looking_lines_pass_through", () => {
  // Lines that don't match the issue regex should pass through unchanged.
  const misc = "Configuration loaded from .golangci.yml\nRunning 5 linters in parallel\n";
  const out = _apply(misc);
  expect(out).toContain("Configuration loaded");
});

it("test_issues_summary_line_is_preserved", () => {
  const body = _make_issues(2) + "\nFound 2 issues.\n";
  const out = _apply(body);
  expect(out).toContain("Found 2 issues.");
});

// ---------------------------------------------------------------------------
// Savings ratio
// ---------------------------------------------------------------------------

it("test_significant_savings_on_100_same_file_issues", () => {
  const out_big = _make_issues(100);
  const ratio = savings_ratio(_F, { stdout: out_big, argv: _ARGV });
  expect(ratio).toBeGreaterThanOrEqual(0.7);
});

it("test_no_savings_on_clean_noise_free_output", () => {
  // A single issue with no noise -> savings should be near zero.
  const line = "cmd/main.go:10:3: exported type Foo without comment (revive)\n";
  const ratio = savings_ratio(_F, { stdout: line, argv: _ARGV });
  expect(ratio).toBeLessThan(0.3);
});
