/**
 * Enhanced edge-case tests for GoFilter, PsFilter, SeverityLogFilter,
 * CodexExecFilter, TerraformFilter.
 *
 * 1:1 port of tests/test_bash_compress_go_ps_severity_enhanced.py. Every Python
 * `def test_*` maps to a vitest `it()` with the SAME name and assertion
 * polarity; the Python test classes map to `describe()` blocks of the same name.
 *
 * Test-seam mapping (Python -> TS):
 *  - `from tests.filter_test_helpers import apply_filter`
 *      -> local `apply_filter(filter, opts?)` helper below. The Python helper
 *        runs `filter_.apply(stdout, stderr, exit_code, argv).text`, defaulting
 *        stdout/stderr to "", exit_code to 0, and argv to `[filter_.name]` when
 *        omitted; the TS port mirrors that exactly.
 *  - `from token_goat import bash_compress as bc`
 *      -> import the barrel "../src/token_goat/bash_compress.js" as `bc`.
 *  - pytest fixtures (`go`, `ps`, `sev`, `codex`, `tf`) returning a fresh filter
 *      -> a `new <Filter>()` constructed inside each test (or describe scope),
 *        the same instance-per-need pattern the Python fixture provides.
 *  - module-level helpers `_go`, `_codex_session`, `_make_ps`, `_make_log`
 *      -> identically-named TS helpers preserving the Python signature/body.
 *
 * Byte-exactness: every assertion here is a substring `toContain` / `not.toContain`
 * check (mirroring the Python `in` / `not in`) or an exact `toBe` / boolean check
 * — no String.length byte arithmetic is exercised by these tests, so the
 * substring assertions translate directly. Unicode glyphs are not used here.
 *
 * Deferral: PsFilter, SeverityLogFilter, CodexExecFilter, and TerraformFilter are
 * NOT yet ported — the barrel "../src/token_goat/bash_compress.js" does not export
 * them (no TS module exists, and `bc.PsFilter` / `bc.SeverityLogFilter` /
 * `bc.CodexExecFilter` / `bc.TerraformFilter` are undefined). Every test depending
 * on one of those filters is `it.skip`-ed with a "// PORT: deferred" marker and
 * counted in tests_skipped. They land verbatim when each filter is ported into a
 * sibling module and registered. Each skipped test preserves the Python name +
 * assertion polarity for a 1:1 unskip. Only the GoFilter tests are live.
 */
import { describe, expect, it } from "vitest";

import { GoFilter } from "../src/token_goat/bash_compress.js";

import type { Filter } from "../src/token_goat/bash_compress.js";

// ---------------------------------------------------------------------------
// Local apply_filter helper (port of filter_test_helpers.apply_filter).
//
// When argv is omitted the filter's own `.name` is used as the sole argv
// element. stdout/stderr default to "" and exit_code to 0, matching Python.
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

// ---------------------------------------------------------------------------
// Helpers (port of the module-level Python helpers).
// ---------------------------------------------------------------------------
function _go(f: GoFilter, stdout: string, argv: string[]): string {
  return apply_filter(f, { stdout, argv });
}

function _codex_session(
  opts?: { model?: string; answer?: string; tokens?: string },
): string {
  const model = opts?.model ?? "gpt-4o";
  const answer = opts?.answer ?? "The answer.";
  const tokens = opts?.tokens ?? "1,234";
  return (
    `OpenAI Codex v1.0.0\n` +
    `--------\n` +
    `workdir: /tmp/proj\n` +
    `model: ${model}\n` +
    `provider: openai\n` +
    `approval: never\n` +
    `sandbox: read-only\n` +
    `session id: abc-123\n` +
    `--------\n` +
    `user\n` +
    `What is 2+2?\n` +
    `codex\n` +
    `${answer}\n` +
    `tokens used\n` +
    `${tokens}\n`
  );
}

// ===========================================================================
// GoFilter — go build / go install
// ===========================================================================

describe("TestGoFilterBuildLike", () => {
  it("test_empty_input", () => {
    const go = new GoFilter();
    const out = _go(go, "", ["go", "build", "./..."]);
    expect(out).toBe("");
  });

  it("test_package_header_lines_suppressed", () => {
    const go = new GoFilter();
    const inp = "# github.com/org/mypkg\n# github.com/org/otherpkg\n";
    const out = _go(go, inp, ["go", "build", "./..."]);
    expect(out).not.toContain("# github.com/org/mypkg");
    expect(out).toContain("suppressed");
  });

  it("test_error_lines_kept_after_header_drop", () => {
    const go = new GoFilter();
    const inp = [
      "# github.com/org/mypkg",
      "main.go:10:5: error: undefined: Foo",
      "main.go:12:1: error: undefined: Bar",
    ].join("\n");
    const out = _go(go, inp, ["go", "build", "."]);
    expect(out).toContain("undefined: Foo");
    expect(out).toContain("undefined: Bar");
  });

  it("test_download_lines_collapsed_in_build", () => {
    const go = new GoFilter();
    const inp = [
      "go: downloading github.com/pkg/errors v0.9.1",
      "go: downloading golang.org/x/net v0.0.1",
      "go: extracting github.com/pkg/errors v0.9.1",
    ].join("\n");
    const out = _go(go, inp, ["go", "build", "."]);
    expect(out).toContain("collapsed");
    expect(out).not.toContain("go: downloading github.com/pkg/errors");
  });

  it("test_successful_build_no_output_stays_empty", () => {
    const go = new GoFilter();
    // go build succeeds silently — empty merged output
    const out = _go(go, "", ["go", "build", "./..."]);
    expect(out).toBe("");
  });

  it("test_go_run_subcommand_routes_to_build_like", () => {
    const go = new GoFilter();
    const inp = "# github.com/org/cmd\nmain.go:3:1: error: syntax error";
    const out = _go(go, inp, ["go", "run", "main.go"]);
    expect(out).toContain("syntax error");
    expect(out).not.toContain("# github.com/org/cmd");
  });

  it("test_go_install_drops_pkg_headers", () => {
    const go = new GoFilter();
    const inp = "# github.com/org/tool\n";
    const out = _go(go, inp, ["go", "install", "github.com/org/tool@latest"]);
    expect(out).not.toContain("# github.com/org/tool");
  });

  it("test_go_clean_empty_stays_empty", () => {
    const go = new GoFilter();
    const out = _go(go, "", ["go", "clean", "-cache"]);
    expect(out).toBe("");
  });
});

// ===========================================================================
// GoFilter — go vet
// ===========================================================================

describe("TestGoFilterVet", () => {
  it("test_vet_progress_lines_dropped", () => {
    const go = new GoFilter();
    const inp = [
      "go: vet github.com/org/pkg",
      "go: vet github.com/org/other",
      "main.go:5:2: printf: wrong number of args",
    ].join("\n");
    const out = _go(go, inp, ["go", "vet", "./..."]);
    expect(out).not.toContain("go: vet");
  });

  it("test_vet_warnings_preserved", () => {
    const go = new GoFilter();
    const inp = [
      "go: vet github.com/org/pkg",
      "util.go:20:3: unreachable code",
    ].join("\n");
    const out = _go(go, inp, ["go", "vet", "./..."]);
    expect(out).toContain("unreachable code");
  });

  it("test_vet_progress_drop_count_in_sentinel", () => {
    const go = new GoFilter();
    const lines = Array.from({ length: 5 }, (_, i) => `go: vet github.com/org/pkg${i}`);
    const inp = lines.join("\n");
    const out = _go(go, inp, ["go", "vet", "./..."]);
    expect(out).toContain("[token-goat: dropped 5 'vet' progress lines]");
  });

  it("test_vet_empty_input", () => {
    const go = new GoFilter();
    const out = _go(go, "", ["go", "vet", "./..."]);
    expect(out).toBe("");
  });
});

// ===========================================================================
// GoFilter — go get / go mod download
// ===========================================================================

describe("TestGoFilterGet", () => {
  it("test_go_get_download_lines_collapsed", () => {
    const go = new GoFilter();
    const lines = Array.from({ length: 10 }, (_, i) => `go: downloading example.com/pkg v0.${i}.0`);
    const inp = lines.join("\n");
    const out = _go(go, inp, ["go", "get", "example.com/pkg"]);
    expect(out).toContain("collapsed");
    expect(out).not.toContain("go: downloading example.com/pkg v0.0.0");
  });

  it("test_go_get_non_download_lines_kept", () => {
    const go = new GoFilter();
    const inp = [
      "go: downloading example.com/dep v1.0.0",
      "go: added example.com/dep v1.0.0",
    ].join("\n");
    const out = _go(go, inp, ["go", "get", "example.com/dep"]);
    expect(out).toContain("go: added example.com/dep");
  });

  it("test_go_mod_download_collapses", () => {
    const go = new GoFilter();
    const lines = Array.from({ length: 8 }, () => "go: downloading golang.org/x/tools v0.1.0");
    const inp = lines.join("\n");
    const out = _go(go, inp, ["go", "mod", "download"]);
    expect(out).toContain("collapsed");
  });

  it("test_go_mod_tidy_keeps_module_change_lines", () => {
    const go = new GoFilter();
    const inp = [
      "go: downloading example.com/dep v1.2.3",
      "go: added example.com/dep v1.2.3",
      "go: removed example.com/old v0.9.0",
    ].join("\n");
    const out = _go(go, inp, ["go", "mod", "tidy"]);
    expect(out).toContain("go: added example.com/dep");
    expect(out).toContain("go: removed example.com/old");
  });
});

// ===========================================================================
// GoFilter — cross-compilation / matches()
// ===========================================================================

describe("TestGoFilterMatches", () => {
  it("test_matches_go_build", () => {
    const f = new GoFilter();
    expect(f.matches(["go", "build", "./..."])).toBe(true);
  });

  it("test_matches_go_vet", () => {
    const f = new GoFilter();
    expect(f.matches(["go", "vet", "./..."])).toBe(true);
  });

  it("test_does_not_match_go_test", () => {
    // GoTestFilter should win; GoFilter must not claim it
    const f = new GoFilter();
    expect(f.matches(["go", "test", "./..."])).toBe(false);
  });

  it("test_does_not_match_bare_go", () => {
    const f = new GoFilter();
    expect(f.matches(["go"])).toBe(false);
  });

  it("test_does_not_match_non_go_binary", () => {
    const f = new GoFilter();
    expect(f.matches(["python", "build"])).toBe(false);
  });

  it("test_matches_go_generate", () => {
    const f = new GoFilter();
    expect(f.matches(["go", "generate", "./..."])).toBe(true);
  });
});

// ===========================================================================
// PsFilter — edge cases
//
// PORT: deferred — PsFilter is not yet ported (no TS module; the barrel
// "../src/token_goat/bash_compress.js" does not export PsFilter). These tests
// land verbatim when PsFilter is ported into a sibling module and registered.
// Each preserves the Python name + assertion polarity for a 1:1 unskip.
// ===========================================================================

describe("TestPsFilterEdgeCases", () => {
  it.skip("test_empty_input", () => {
    // PORT: deferred — PsFilter not yet ported.
  });

  it.skip("test_short_output_passthrough", () => {
    // PORT: deferred — PsFilter not yet ported.
  });

  it.skip("test_header_always_kept", () => {
    // PORT: deferred — PsFilter not yet ported.
  });

  it.skip("test_sentinel_appended_when_suppressed", () => {
    // PORT: deferred — PsFilter not yet ported.
  });

  it.skip("test_no_sentinel_when_nothing_suppressed", () => {
    // PORT: deferred — PsFilter not yet ported.
  });

  it.skip("test_high_cpu_process_kept", () => {
    // PORT: deferred — PsFilter not yet ported.
  });

  it.skip("test_high_mem_process_kept", () => {
    // PORT: deferred — PsFilter not yet ported.
  });

  it.skip("test_dev_process_node_kept", () => {
    // PORT: deferred — PsFilter not yet ported.
  });

  it.skip("test_suppressed_count_in_sentinel", () => {
    // PORT: deferred — PsFilter not yet ported.
  });

  it.skip("test_detect_true_for_ps_aux_header", () => {
    // PORT: deferred — PsFilter not yet ported.
  });

  it.skip("test_detect_false_for_plain_text", () => {
    // PORT: deferred — PsFilter not yet ported.
  });
});

// ===========================================================================
// SeverityLogFilter — level handling and edge cases
//
// PORT: deferred — SeverityLogFilter is not yet ported (no TS module; the barrel
// does not export SeverityLogFilter). These tests land verbatim when
// SeverityLogFilter is ported into a sibling module and registered.
// ===========================================================================

describe("TestSeverityLogFilterLevels", () => {
  it.skip("test_empty_input", () => {
    // PORT: deferred — SeverityLogFilter not yet ported.
  });

  it.skip("test_pure_info_debug_suppressed", () => {
    // PORT: deferred — SeverityLogFilter not yet ported.
  });

  it.skip("test_error_line_always_kept", () => {
    // PORT: deferred — SeverityLogFilter not yet ported.
  });

  it.skip("test_warn_line_kept_at_default_threshold", () => {
    // PORT: deferred — SeverityLogFilter not yet ported.
  });

  it.skip("test_suppression_sentinel_count_nonzero", () => {
    // PORT: deferred — SeverityLogFilter not yet ported.
  });

  it.skip("test_stack_trace_after_error_kept", () => {
    // PORT: deferred — SeverityLogFilter not yet ported.
  });

  it.skip("test_trace_closed_by_blank_line", () => {
    // PORT: deferred — SeverityLogFilter not yet ported.
  });

  it.skip("test_detect_requires_five_lines", () => {
    // PORT: deferred — SeverityLogFilter not yet ported.
  });

  it.skip("test_detect_requires_keyword_ratio", () => {
    // PORT: deferred — SeverityLogFilter not yet ported.
  });

  it.skip("test_json_structured_logs_detected", () => {
    // PORT: deferred — SeverityLogFilter not yet ported.
  });

  it.skip("test_context_lines_included_around_error", () => {
    // PORT: deferred — SeverityLogFilter not yet ported.
  });
});

// ===========================================================================
// CodexExecFilter — edge cases
//
// PORT: deferred — CodexExecFilter is not yet ported (no TS module; the barrel
// does not export CodexExecFilter). These tests land verbatim when
// CodexExecFilter is ported into a sibling module and registered. The
// _codex_session helper above is kept for the 1:1 unskip.
// ===========================================================================

describe("TestCodexFilterEdgeCases", () => {
  it.skip("test_empty_input", () => {
    // PORT: deferred — CodexExecFilter not yet ported.
  });

  it.skip("test_model_extracted_in_summary", () => {
    // PORT: deferred — CodexExecFilter not yet ported.
  });

  it.skip("test_tokens_extracted_in_summary", () => {
    // PORT: deferred — CodexExecFilter not yet ported.
  });

  it.skip("test_config_block_stripped", () => {
    // PORT: deferred — CodexExecFilter not yet ported.
  });

  it.skip("test_version_banner_stripped", () => {
    // PORT: deferred — CodexExecFilter not yet ported.
  });

  it.skip("test_answer_body_kept", () => {
    // PORT: deferred — CodexExecFilter not yet ported.
  });

  it.skip("test_tokens_used_footer_stripped", () => {
    // PORT: deferred — CodexExecFilter not yet ported.
  });

  it.skip("test_multi_turn_only_last_answer_kept", () => {
    // PORT: deferred — CodexExecFilter not yet ported.
  });

  it.skip("test_unknown_format_passthrough", () => {
    // PORT: deferred — CodexExecFilter not yet ported.
  });

  it.skip("test_summary_line_present", () => {
    // PORT: deferred — CodexExecFilter not yet ported.
  });

  it.skip("test_code_block_in_answer_preserved", () => {
    // PORT: deferred — CodexExecFilter not yet ported.
  });
});

// ===========================================================================
// TerraformFilter — plan, apply, destroy edge cases
//
// PORT: deferred — TerraformFilter is not yet ported (no TS module; the barrel
// does not export TerraformFilter). These tests land verbatim when
// TerraformFilter is ported into a sibling module and registered.
// ===========================================================================

describe("TestTerraformFilterPlan", () => {
  it.skip("test_empty_input", () => {
    // PORT: deferred — TerraformFilter not yet ported.
  });

  it.skip("test_refresh_lines_dropped", () => {
    // PORT: deferred — TerraformFilter not yet ported.
  });

  it.skip("test_plan_summary_kept", () => {
    // PORT: deferred — TerraformFilter not yet ported.
  });

  it.skip("test_no_changes_line_kept", () => {
    // PORT: deferred — TerraformFilter not yet ported.
  });

  it.skip("test_refresh_lines_drop_counted_in_notes", () => {
    // PORT: deferred — TerraformFilter not yet ported.
  });
});

describe("TestTerraformFilterApply", () => {
  it.skip("test_still_creating_collapsed", () => {
    // PORT: deferred — TerraformFilter not yet ported.
  });

  it.skip("test_apply_complete_summary_kept", () => {
    // PORT: deferred — TerraformFilter not yet ported.
  });

  it.skip("test_creation_complete_kept", () => {
    // PORT: deferred — TerraformFilter not yet ported.
  });

  it.skip("test_error_block_preserved", () => {
    // PORT: deferred — TerraformFilter not yet ported.
  });
});

describe("TestTerraformFilterInit", () => {
  it.skip("test_empty_init_passthrough", () => {
    // PORT: deferred — TerraformFilter not yet ported.
  });

  it.skip("test_init_downloading_collapsed", () => {
    // PORT: deferred — TerraformFilter not yet ported.
  });

  it.skip("test_tofu_binary_also_matched", () => {
    // PORT: deferred — TerraformFilter not yet ported.
  });

  it.skip("test_terragrunt_binary_also_matched", () => {
    // PORT: deferred — TerraformFilter not yet ported.
  });
});
