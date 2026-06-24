/**
 * Enhanced edge-case tests for GhFilter, RgFilter, TailTruncFilter, ClineFilter,
 * WindsurfFilter, and MakeFilter.
 *
 * 1:1 port of tests/test_bash_compress_gh_rg_make_cline_enhanced.py. Every
 * Python `def test_*` maps to a vitest `it()` with the SAME name and assertion
 * polarity; the Python test classes map to `describe()` blocks of the same name.
 *
 * Test-seam mapping (Python -> TS):
 *  - `from tests.filter_test_helpers import apply_filter`
 *      -> local `apply_filter(filter, stdout, opts?)` helper below. The Python
 *        helper runs `filter_.apply(stdout, stderr, exit_code, argv).text`,
 *        defaulting argv to `[filter_.name]`; this mirrors it exactly.
 *  - `from token_goat.bash_compress import (...)`
 *      -> import the barrel "../src/token_goat/bash_compress.js"
 *        (re-exports the framework + ported filter classes + the module-level
 *        helper `_redact_gh_base64_content`).
 *  - `setup_method` building `self.flt = XFilter()` plus `self._run(...)` /
 *    `self._apply(...)` / `self._compress(...)` -> a fresh `new XFilter()`
 *    per `it()` and an inline call to the local apply_filter helper.
 *  - `base64.b64encode(text.encode()).decode()` -> `Buffer.from(text, "utf8")
 *    .toString("base64")`. `_b64()` appends a trailing newline like the Python
 *    helper.
 *  - `json.dumps(payload)` (CPython, no indent) -> `JSON.stringify(payload)`.
 *    The payloads here are flat dicts / arrays of flat dicts of scalar values;
 *    JSON.stringify reproduces the compact form `_redact_gh_base64_content`
 *    round-trips through JSON.parse/stringify, so the parsed-field assertions
 *    translate directly.
 *
 * Deferred filters: TailTruncFilter, ClineFilter, and WindsurfFilter are NOT
 * yet ported (no class exists in the barrel), so every test in
 * TestTailTruncFilterBoundary, TestClineFilterEdgeCases, and
 * TestWindsurfFilterEdgeCases is `it.skip` with a PORT note. They land with
 * their respective filter runs.
 *
 * Byte-exactness: the live fixtures are pure ASCII (base64 alphabet, gh/rg/make
 * line markers), so code-unit length equals byte length and the substring /
 * `in` / `not in` assertions translate directly; no Buffer arithmetic is needed
 * beyond the base64 encoding itself.
 */
import { describe, expect, it } from "vitest";

import {
  GhFilter,
  MakeFilter,
  RgFilter,
  _redact_gh_base64_content,
} from "../src/token_goat/bash_compress.js";

import type { Filter } from "../src/token_goat/bash_compress.js";

// ---------------------------------------------------------------------------
// Local apply_filter helper (port of tests/filter_test_helpers.apply_filter).
//
// When argv is omitted the filter's own `.name` is used as the sole argv
// element, exactly like the Python helper's default.
// ---------------------------------------------------------------------------
function apply_filter(
  filter_: Filter,
  stdout = "",
  opts?: { stderr?: string; exit_code?: number; argv?: string[] },
): string {
  const stderr = opts?.stderr ?? "";
  const exit_code = opts?.exit_code ?? 0;
  const argv = opts?.argv ?? [filter_.name];
  return filter_.apply(stdout, stderr, exit_code, argv).text;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Return GitHub-style base64-encoded string (with trailing newline). */
function _b64(text: string): string {
  return Buffer.from(text, "utf8").toString("base64") + "\n";
}

// A definitively long base64 value (well over 200 chars) and a short one.
const _LONG_B64 = _b64("x".repeat(300)); // base64 of 300 bytes >> 200 chars
const _SHORT_B64 = Buffer.from("hi", "utf8").toString("base64") + "\n"; // "aGk=\n" — 5 chars, well under 200
void _SHORT_B64; // present in Python module scope; unused by the live tests here

// ===========================================================================
// GhFilter — base64 detection boundary
// ===========================================================================

describe("TestGhBase64Boundary", () => {
  it("test_content_exactly_at_threshold_not_redacted", () => {
    // The filter uses len(val) > 200, so a value of exactly 200 chars is NOT
    // redacted. Build a string of exactly 200 valid base64 chars (no trailing
    // newline so len==200).
    const val = "A".repeat(200);
    expect(val.length).toBe(200);
    const payload = { content: val };
    const result = _redact_gh_base64_content(JSON.stringify(payload));
    const parsed = JSON.parse(result) as { content: unknown };
    expect(parsed.content).toBe(val);
  });

  it("test_content_one_over_threshold_but_non_b64_not_redacted", () => {
    // 201-char string that is NOT valid base64 must pass through.
    const val = "not-base64!!" + "x".repeat(190);
    const payload = { content: val };
    const result = _redact_gh_base64_content(JSON.stringify(payload));
    const parsed = JSON.parse(result) as { content: unknown };
    expect(parsed.content).toBe(val);
  });

  it("test_long_valid_b64_redacted_and_byte_count_present", () => {
    const raw = Buffer.from("binary blob ".repeat(25), "utf8"); // long enough
    const encoded = raw.toString("base64") + "\n";
    expect(encoded.length).toBeGreaterThan(200);
    const payload = { content: encoded };
    const result = _redact_gh_base64_content(JSON.stringify(payload));
    const parsed = JSON.parse(result) as { content: string };
    expect(parsed.content).toContain("<base64 content:");
    expect(parsed.content).toContain(`${raw.length} bytes decoded`);
  });

  it("test_nested_array_of_objects_all_redacted", () => {
    const items = Array.from({ length: 5 }, (_, i) => ({
      path: `f${i}.py`,
      content: _LONG_B64,
    }));
    const result = _redact_gh_base64_content(JSON.stringify(items));
    const parsed = JSON.parse(result) as Array<{ content: string }>;
    expect(parsed.every((item) => item.content.includes("<base64 content:"))).toBe(true);
  });

  it("test_empty_string_input", () => {
    expect(_redact_gh_base64_content("")).toBe("");
  });

  it("test_whitespace_only_input_passthrough", () => {
    const ws = "   \n\t  ";
    expect(_redact_gh_base64_content(ws)).toBe(ws);
  });

  it("test_plain_number_content_not_redacted", () => {
    // content field holding a number (non-string) must pass through without error.
    const payload = { content: 12345 };
    const stdout = JSON.stringify(payload);
    const result = _redact_gh_base64_content(stdout);
    expect(result).toBe(stdout);
  });
});

// ===========================================================================
// GhFilter — gh run view and gh pr/run/issue list
// ===========================================================================

describe("TestGhFilterRunView", () => {
  function _run(flt: GhFilter, stdout: string): string {
    return apply_filter(flt, stdout, { argv: ["gh", "run", "view", "123"] });
  }

  it("test_passing_steps_collapsed", () => {
    const flt = new GhFilter();
    const stdout =
      "✓ Set up job\n" +
      "  Run actions/checkout@v4\n" +
      "  Run actions/setup-python@v5\n" +
      "✗ Run tests\n" +
      "  pytest failed with exit code 1\n";
    const out = _run(flt, stdout);
    // Passing step preamble lines should be dropped
    expect(out).not.toContain("Run actions/checkout@v4");
    // Failing step body must survive
    expect(out).toContain("pytest failed");
  });

  it("test_no_passing_steps_passes_through", () => {
    const flt = new GhFilter();
    const stdout = "✗ Build\n  cargo build failed\n";
    const out = _run(flt, stdout);
    expect(out).toContain("cargo build failed");
  });

  it("test_empty_run_view_output", () => {
    const flt = new GhFilter();
    const out = _run(flt, "");
    expect(out).toBe("");
  });
});

describe("TestGhFilterList", () => {
  function _pr_list(n_rows: number): string {
    const header = "NUMBER  TITLE             BRANCH      STATE";
    const rows: string[] = [];
    for (let i = 1; i <= n_rows; i++) {
      rows.push(`${i}  PR title ${i}  branch-${i}  open`);
    }
    return header + "\n" + rows.join("\n") + "\n";
  }

  it("test_under_30_rows_not_truncated", () => {
    const flt = new GhFilter();
    const stdout = _pr_list(10);
    const out = apply_filter(flt, stdout, { argv: ["gh", "pr", "list"] });
    expect(out).not.toContain("showing first 30");
    expect(out).toContain("PR title 10");
  });

  it("test_over_30_rows_truncated_with_note", () => {
    const flt = new GhFilter();
    const stdout = _pr_list(50);
    const out = apply_filter(flt, stdout, { argv: ["gh", "pr", "list"] });
    expect(out).toContain("showing first 30 of 50 prs");
    // Row 31 onwards should be absent
    expect(out).not.toContain("PR title 31");
  });

  it("test_run_list_note_uses_correct_subcommand", () => {
    const flt = new GhFilter();
    const header = "STATUS  NAME        ID";
    const rows: string[] = [];
    for (let i = 0; i < 40; i++) {
      rows.push(`completed  run-${i}  ${10000 + i}`);
    }
    const stdout = header + "\n" + rows.join("\n") + "\n";
    const out = apply_filter(flt, stdout, { argv: ["gh", "run", "list"] });
    expect(out).toContain("runs"); // subcommand suffix in note
  });

  it("test_issue_list_note_uses_correct_subcommand", () => {
    const flt = new GhFilter();
    const header = "NUMBER  TITLE  STATE";
    const rows: string[] = [];
    for (let i = 0; i < 40; i++) {
      rows.push(`${i}  Issue ${i}  open`);
    }
    const stdout = header + "\n" + rows.join("\n") + "\n";
    const out = apply_filter(flt, stdout, { argv: ["gh", "issue", "list"] });
    expect(out).toContain("issues");
  });
});

// ===========================================================================
// RgFilter — edge cases
// ===========================================================================

/** Build one rg -C 1 output block with separator. */
function _rg_ctx_block(match: string, before = "ctx-before", after = "ctx-after"): string {
  return `file.py-10-${before}\nfile.py:11:${match}\nfile.py-12-${after}\n--\n`;
}

describe("TestRgFilterEdgeCases", () => {
  function _apply(flt: RgFilter, stdout: string, argv?: string[]): string {
    return apply_filter(flt, stdout, { argv: argv ?? ["rg", "-C", "1", "pattern"] });
  }

  it("test_empty_input", () => {
    const flt = new RgFilter();
    expect(_apply(flt, "")).toBe("");
  });

  it("test_small_output_passes_through_unchanged", () => {
    // Only a few context lines — no suppression
    const flt = new RgFilter();
    const stdout = _rg_ctx_block("def foo():");
    const out = _apply(flt, stdout);
    // Short output: no suppression note, content preserved
    expect(out).not.toContain("token-goat");
    expect(out).toContain("def foo():");
  });

  it("test_large_context_output_strips_ctx_lines", () => {
    // Use exactly 8 groups (<= _RG_GROUP_THRESHOLD=10) so context-strip path
    // fires. Each block has 31+ lines total; 8 x 4 lines = 32 lines >
    // _RG_CONTEXT_THRESHOLD=30.
    const flt = new RgFilter();
    let blocks = "";
    for (let i = 0; i < 8; i++) {
      blocks += _rg_ctx_block(`match${i}`, `before${i}`, `after${i}`);
    }
    const out = _apply(flt, blocks);
    expect(out).toContain("context lines suppressed");
  });

  it("test_match_lines_preserved_after_context_strip", () => {
    // With <=10 groups and output > threshold, match lines survive context-strip.
    const flt = new RgFilter();
    let blocks = "";
    for (let i = 0; i < 8; i++) {
      blocks += _rg_ctx_block(`KEEP_${i}`);
    }
    const out = _apply(flt, blocks);
    expect(out).toContain("KEEP_0");
    expect(out).toContain("KEEP_7");
  });

  it("test_many_groups_use_match_group_sentinel", () => {
    // > _RG_GROUP_THRESHOLD=10 groups -> _compress_groups() fires, top 5 kept.
    const flt = new RgFilter();
    let blocks = "";
    for (let i = 0; i < 15; i++) {
      blocks += _rg_ctx_block(`m${i}`);
    }
    const out = _apply(flt, blocks);
    expect(out).toContain("match groups suppressed");
  });

  it("test_hint_mentions_rerun_options", () => {
    // Both compression paths mention -l or rerun in their sentinel text.
    const flt = new RgFilter();
    let blocks = "";
    for (let i = 0; i < 8; i++) {
      blocks += _rg_ctx_block(`m${i}`);
    }
    const out = _apply(flt, blocks);
    expect(out).toContain("rerun");
    expect(out).toContain("-l");
  });

  it("test_grep_binary_same_compression_as_rg", () => {
    // grep dispatches to RgFilter just like rg; both produce context-strip note.
    const flt = new RgFilter();
    let blocks = "";
    for (let i = 0; i < 8; i++) {
      blocks += _rg_ctx_block(`m${i}`);
    }
    const out_rg = apply_filter(flt, blocks, { argv: ["rg", "-C", "1", "m"] });
    const out_grep = apply_filter(flt, blocks, { argv: ["grep", "-C", "1", "m"] });
    expect(out_rg).toContain("context lines suppressed");
    expect(out_grep).toContain("context lines suppressed");
  });

  it("test_plain_match_only_output_no_suppression", () => {
    // Output with only match lines and no context lines -> no suppression
    const flt = new RgFilter();
    const lines: string[] = [];
    for (let i = 1; i < 60; i++) {
      lines.push(`file.py:${i}:match`);
    }
    const out = _apply(flt, lines.join("\n"));
    // No context lines to strip, note should not appear
    expect(out).not.toContain("context lines suppressed");
  });
});

// ===========================================================================
// TailTruncFilter — N-line boundary and sentinel details
// ===========================================================================

describe("TestTailTruncFilterBoundary", () => {
  // PORT: deferred — TailTruncFilter is not yet ported (no class in the barrel).
  it.skip("test_500_lines_passes_through", () => {});
  it.skip("test_501_lines_triggers_truncation", () => {});
  it.skip("test_sentinel_contains_disable_hint", () => {});
  it.skip("test_suppressed_count_accurate_for_600_lines", () => {});
  it.skip("test_head_50_preserved", () => {});
  it.skip("test_tail_50_preserved", () => {});
  it.skip("test_middle_lines_absent", () => {});
  it.skip("test_empty_input", () => {});
  it.skip("test_matches_any_argv", () => {});
});

// ===========================================================================
// ClineFilter — deduplication and noise drops
// ===========================================================================

describe("TestClineFilterEdgeCases", () => {
  // PORT: deferred — ClineFilter is not yet ported (no class in the barrel).
  it.skip("test_empty_input", () => {});
  it.skip("test_version_banner_dropped", () => {});
  it.skip("test_spinner_lines_dropped", () => {});
  it.skip("test_token_cost_note_present", () => {});
  it.skip("test_response_content_preserved", () => {});
  it.skip("test_error_on_nonzero_exit_preserved", () => {});
  it.skip("test_mcp_noise_dropped", () => {});
  it.skip("test_no_crash_on_binary_like_content", () => {});
});

// ===========================================================================
// WindsurfFilter — startup noise and cascade tool calls
// ===========================================================================

describe("TestWindsurfFilterEdgeCases", () => {
  // PORT: deferred — WindsurfFilter is not yet ported (no class in the barrel).
  it.skip("test_empty_input", () => {});
  it.skip("test_codeium_activation_dropped", () => {});
  it.skip("test_response_content_survives", () => {});
  it.skip("test_error_passthrough_on_nonzero_exit", () => {});
});

// ===========================================================================
// MakeFilter — recipe, multi-target, directory change lines
// ===========================================================================

describe("TestMakeFilterEdgeCases", () => {
  function _compress(flt: MakeFilter, stdout: string, argv?: string[]): string {
    return apply_filter(flt, stdout, { argv: argv ?? ["make"] });
  }

  it("test_empty_input", () => {
    const flt = new MakeFilter();
    expect(_compress(flt, "")).toBe("");
  });

  it("test_entering_directory_noise_suppressed", () => {
    const flt = new MakeFilter();
    const stdout = "make[1]: Entering directory '/tmp/build'\nBuild complete\n";
    const out = _compress(flt, stdout);
    expect(out).not.toContain("Entering directory");
  });

  it("test_leaving_directory_noise_suppressed", () => {
    const flt = new MakeFilter();
    const stdout = "make[1]: Leaving directory '/tmp/build'\nBuild complete\n";
    const out = _compress(flt, stdout);
    expect(out).not.toContain("Leaving directory '/tmp/build'");
  });

  it("test_nothing_to_be_done_suppressed", () => {
    const flt = new MakeFilter();
    const stdout = "make[1]: Nothing to be done for 'all'.\n";
    const out = _compress(flt, stdout);
    expect(out).not.toContain("Nothing to be done");
  });

  it("test_error_line_always_preserved", () => {
    const flt = new MakeFilter();
    const stdout =
      "make[1]: Entering directory '/tmp'\n" +
      "src/main.c:42:5: error: undeclared identifier 'x'\n" +
      "make[1]: Leaving directory '/tmp'\n";
    const out = _compress(flt, stdout);
    expect(out).toContain("error: undeclared identifier");
  });

  it("test_warning_line_always_preserved", () => {
    const flt = new MakeFilter();
    const stdout =
      "make[1]: Entering directory '/build'\n" +
      "src/util.c:7:1: warning: unused variable 'tmp'\n";
    const out = _compress(flt, stdout);
    expect(out).toContain("warning: unused variable");
  });

  it("test_star_error_marker_preserved", () => {
    const flt = new MakeFilter();
    const stdout =
      "make[1]: Entering directory '/build'\n" +
      "make[1]: *** [Makefile:10] Error 2\n";
    const out = _compress(flt, stdout);
    expect(out).toContain("*** [Makefile:10] Error 2");
  });

  it("test_gcc_compiler_echo_suppressed", () => {
    // Plain gcc invocation line with no following error is dropped
    const flt = new MakeFilter();
    const progress: string[] = [];
    for (let i = 0; i < 40; i++) {
      progress.push(`[${String(i + 1).padStart(3, " ")}%] Building CXX src/f${i}.cpp.o`);
    }
    const stdout = progress.join("\n") + "\ngcc -O2 -c src/foo.c -o src/foo.o\n";
    const out = _compress(flt, stdout);
    expect(out).not.toContain("gcc -O2");
  });

  it("test_ninja_binary_matches", () => {
    const flt = new MakeFilter();
    expect(flt.matches(["ninja", "-j4"])).toBe(true);
  });

  it("test_go_build_binary_matches", () => {
    const flt = new MakeFilter();
    expect(flt.matches(["go", "build", "./..."])).toBe(true);
  });

  it("test_short_output_passes_through", () => {
    const flt = new MakeFilter();
    const stdout = "Build complete\n";
    const out = _compress(flt, stdout);
    expect(out).toContain("Build complete");
  });

  it("test_go_generate_trigger_suppressed", () => {
    const flt = new MakeFilter();
    const stdout = "go:generate go run cmd/gen/main.go\ngenerated ok\n";
    const out = _compress(flt, stdout, ["go", "generate", "./..."]);
    // The go:generate trigger line should be suppressed with a note
    expect(out).not.toContain("go:generate go run");
    expect(out).toContain("dropped");
    expect(out).toContain("[token-goat:");
  });

  it("test_multi_target_errors_all_preserved", () => {
    const flt = new MakeFilter();
    const stdout =
      "[  1%] Building CXX src/a.cpp.o\n" +
      "src/a.cpp:3:1: error: bad syntax\n" +
      "[  2%] Building CXX src/b.cpp.o\n" +
      "src/b.cpp:9:5: error: type mismatch\n";
    const out = _compress(flt, stdout);
    expect(out).toContain("src/a.cpp:3:1: error");
    expect(out).toContain("src/b.cpp:9:5: error");
  });
});
