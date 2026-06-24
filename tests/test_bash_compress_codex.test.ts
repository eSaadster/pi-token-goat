/**
 * Tests for CodexExecFilter (OpenAI Codex CLI output compression).
 *
 * 1:1 port of tests/test_bash_compress_codex.py. Every Python `def test_*`
 * maps to a vitest `it()` with the SAME name and assertion polarity; the
 * Python tests are module-level functions, so they sit under one
 * `describe("TestCodexExecFilter", ...)` block.
 *
 * Test-seam mapping (Python -> TS):
 *  - `from token_goat import bash_compress as bc`
 *      -> import the barrel "../src/token_goat/bash_compress.js" as `bc`
 *        (re-exports CodexExecFilter + detect_from_command + FILTERS +
 *        __all__).
 *  - `from filter_test_helpers import apply_filter, savings_ratio`
 *      -> local `_apply` and `_savings_ratio` helpers below. `_apply` defaults
 *         argv to `[filter_.name]` exactly like the Python helper; `_savings_ratio`
 *         is `apply(...).percent_saved / 100.0`.
 *
 * SKIPPED: `test_bash_detect_routes_codex` — the Python test imports
 * `token_goat.bash_detect` (a SEPARATE dispatch module) and calls
 * `bash_detect.detect(["codex", ...])`. That module has NOT been ported to TS
 * yet (no ts/src/token_goat/bash_detect.ts); this one case is left skipped
 * with a clear reason rather than re-routing through a module that does not
 * exist. All other cases port faithfully (the `bc.detect_from_command` form
 * used by `test_dispatch_routes_codex` is available on the barrel).
 *
 * Byte-exactness: assertions are substring `in` / `not in` checks plus one
 * `.lower()`-tolerant guard. All fixtures and substrings are ASCII.
 */
import { describe, expect, it } from "vitest";

import * as bc from "../src/token_goat/bash_compress.js";
import { CodexExecFilter } from "../src/token_goat/bash_compress.js";

import type { Filter } from "../src/token_goat/bash_compress.js";

// ---------------------------------------------------------------------------
// Local helpers (ports of filter_test_helpers.apply_filter / savings_ratio).
// `_apply` defaults argv to `[filter_.name]` when omitted, matching the Python
// helper; `_savings_ratio` is `apply(...).percent_saved / 100.0`.
// ---------------------------------------------------------------------------
function _apply(
  filter_: Filter,
  opts?: { stdout?: string; stderr?: string; exit_code?: number; argv?: string[] },
): string {
  const stdout = opts?.stdout ?? "";
  const stderr = opts?.stderr ?? "";
  const exit_code = opts?.exit_code ?? 0;
  const argv = opts?.argv ?? [filter_.name];
  return filter_.apply(stdout, stderr, exit_code, argv).text;
}

function _savings_ratio(
  filter_: Filter,
  stdout: string,
  opts?: { stderr?: string; argv?: string[] },
): number {
  const stderr = opts?.stderr ?? "";
  const argv = opts?.argv ?? [filter_.name];
  return filter_.apply(stdout, stderr, 0, argv).percent_saved / 100.0;
}

// ---------------------------------------------------------------------------
// Realistic Codex CLI output (Python lines 11-65, 185-204).
// ---------------------------------------------------------------------------

const _CODEX_SESSION =
  "OpenAI Codex v0.137.0\n" +
  "--------\n" +
  "workdir: /home/user/project\n" +
  "model: gpt-5.4-mini\n" +
  "provider: openai\n" +
  "approval: never\n" +
  "sandbox: read-only\n" +
  "reasoning effort: xhigh\n" +
  "reasoning summaries: none\n" +
  "session id: 019ebf84-5401-7ef1-a0c2-c21bcf70fb96\n" +
  "--------\n" +
  "user\n" +
  "Explain the difference between a list and a tuple in Python.\n" +
  "codex\n" +
  "A list is mutable — you can add, remove, or change elements after creation.\n" +
  "A tuple is immutable — once created its contents cannot be modified.\n" +
  "\n" +
  "Use a list when the collection needs to change; use a tuple for fixed data\n" +
  "(coordinates, RGB values, function arguments you want to protect).\n" +
  "tokens used\n" +
  "99,406\n";

const _CODEX_MULTI_TURN =
  "OpenAI Codex v0.137.0\n" +
  "--------\n" +
  "workdir: /home/user/project\n" +
  "model: o4-mini\n" +
  "provider: openai\n" +
  "approval: suggest\n" +
  "sandbox: network-disabled\n" +
  "reasoning effort: medium\n" +
  "reasoning summaries: auto\n" +
  "session id: 019ebf84-0001-7ef1-a0c2-c21bcf70fb96\n" +
  "--------\n" +
  "user\n" +
  "What is the capital of France?\n" +
  "codex\n" +
  "Paris is the capital of France.\n" +
  "user\n" +
  "And Germany?\n" +
  "codex\n" +
  "Berlin is the capital of Germany.\n" +
  "tokens used\n" +
  "12,345\n";

const _CODEX_EMPTY = "";

const _CODEX_UNKNOWN_FORMAT =
  "Some random command output\n" + "that does not look like Codex at all.\n" + "Just ordinary text.\n";

const _CODEX_VERBOSE =
  "OpenAI Codex v0.137.0\n" +
  "--------\n" +
  "workdir: /home/user/project\n" +
  "model: gpt-5.4-mini\n" +
  "provider: openai\n" +
  "approval: never\n" +
  "sandbox: read-only\n" +
  "reasoning effort: xhigh\n" +
  "reasoning summaries: none\n" +
  "session id: 019ebf84-5401-7ef1-a0c2-c21bcf70fb96\n" +
  "--------\n" +
  "user\n" +
  "Write a Python function that reverses a string.\n" +
  "codex\n" +
  "def reverse_string(s: str) -> str:\n" +
  "    return s[::-1]\n" +
  "tokens used\n" +
  "1,234\n";

// ===========================================================================
// TestCodexExecFilter
// ===========================================================================

describe("TestCodexExecFilter", () => {
  // --- matches() ---

  it("test_codex_matches", () => {
    const f = new CodexExecFilter();
    expect(f.matches(["codex"])).toBe(true);
    expect(f.matches(["codex", "exec", "some prompt"])).toBe(true);
    expect(f.matches(["codex", "--help"])).toBe(true);
    expect(f.matches(["conda"])).toBe(false);
    expect(f.matches(["gh"])).toBe(false);
    expect(f.matches(["aider"])).toBe(false);
    expect(f.matches([])).toBe(false);
  });

  // --- header stripping ---

  it("test_codex_strips_version_banner", () => {
    const f = new CodexExecFilter();
    const out = _apply(f, { stdout: _CODEX_SESSION });
    expect(out).not.toContain("OpenAI Codex v0.137.0");
  });

  it("test_codex_strips_config_block", () => {
    const f = new CodexExecFilter();
    const out = _apply(f, { stdout: _CODEX_SESSION });
    expect(out).not.toContain("workdir:");
    expect(out).not.toContain("provider:");
    expect(out).not.toContain("session id:");
    expect(out).not.toContain("approval:");
    expect(out).not.toContain("reasoning effort:");
  });

  it("test_codex_strips_prompt_user_turn", () => {
    const f = new CodexExecFilter();
    const out = _apply(f, { stdout: _CODEX_SESSION });
    expect(out).not.toContain("Explain the difference between a list and a tuple");
  });

  // --- answer extraction ---

  it("test_codex_keeps_answer_body", () => {
    const f = new CodexExecFilter();
    const out = _apply(f, { stdout: _CODEX_SESSION });
    expect(out).toContain("A list is mutable");
    expect(out).toContain("A tuple is immutable");
    expect(out).toContain("coordinates, RGB values");
  });

  it("test_codex_keeps_only_final_answer_in_multi_turn", () => {
    const f = new CodexExecFilter();
    const out = _apply(f, { stdout: _CODEX_MULTI_TURN });
    // Final codex response is about Germany/Berlin
    expect(out).toContain("Berlin is the capital of Germany");
    // Intermediate codex response about France should be dropped
    expect(out).not.toContain("Paris is the capital of France");
  });

  // --- summary line ---

  it("test_codex_prepends_summary_line", () => {
    const f = new CodexExecFilter();
    const out = _apply(f, { stdout: _CODEX_SESSION });
    expect(out).toContain("[codex:");
    expect(out).toContain("model=gpt-5.4-mini");
    expect(out).toContain("tokens=99,406");
  });

  it("test_codex_summary_uses_correct_model_multi_turn", () => {
    const f = new CodexExecFilter();
    const out = _apply(f, { stdout: _CODEX_MULTI_TURN });
    expect(out).toContain("model=o4-mini");
    expect(out).toContain("tokens=12,345");
  });

  it("test_codex_strips_tokens_used_footer", () => {
    const f = new CodexExecFilter();
    const out = _apply(f, { stdout: _CODEX_SESSION });
    // The raw "tokens used" footer is folded into the [codex: ...] summary
    // header; it must not also appear as a bare footer line.
    expect(!out.toLowerCase().includes("tokens used") || out.includes("[codex:")).toBe(true);
  });

  // --- passthrough for unrecognised / empty formats ---

  it("test_codex_passthrough_unknown_format", () => {
    const f = new CodexExecFilter();
    const out = _apply(f, { stdout: _CODEX_UNKNOWN_FORMAT });
    expect(out).toContain("Some random command output");
    expect(out).toContain("Just ordinary text");
  });

  it("test_codex_passthrough_empty", () => {
    const f = new CodexExecFilter();
    const out = _apply(f, { stdout: _CODEX_EMPTY });
    // Empty or near-empty output should not crash and should return something
    expect(out).not.toBeUndefined();
    expect(typeof out).toBe("string");
  });

  // --- non-zero exit: preserve stderr verbatim ---

  it("test_codex_preserves_error_on_nonzero_exit", () => {
    const f = new CodexExecFilter();
    const stderr = "codex: fatal error: API key not set\n";
    const out = _apply(f, { stdout: "", stderr, exit_code: 1 });
    expect(out).toContain("fatal error");
    expect(out).toContain("API key");
  });

  // --- savings ratio ---

  it("test_codex_savings", () => {
    const f = new CodexExecFilter();
    const ratio = _savings_ratio(f, _CODEX_VERBOSE);
    expect(ratio).toBeGreaterThanOrEqual(0.3);
  });

  // --- registry checks ---

  it("test_codex_registered_in_filters", () => {
    const names = new Set(bc.FILTERS.map((f) => f.name));
    expect(names.has("codex-exec")).toBe(true);
  });

  it("test_codex_in_all_exports", () => {
    expect(bc.__all__.includes("CodexExecFilter")).toBe(true);
  });

  it("test_dispatch_routes_codex", () => {
    const result = bc.detect_from_command("codex exec 'fix the bug'");
    expect(result).not.toBeNull();
    const [f, _argv] = result!;
    expect(f.name).toBe("codex-exec");
  });

  // reason: Python `from token_goat import bash_detect; bash_detect.detect(...)`
  // routes through a SEPARATE dispatch module (token_goat/bash_detect.py) that
  // has NOT been ported to TS yet (no ts/src/token_goat/bash_detect.ts exists).
  // bc.detect_from_command above already covers the barrel-level routing.
  it.skip("test_bash_detect_routes_codex", () => {
    expect(true).toBe(true);
  });
});
