/**
 * Unit tests for token_goat/overflow_guard. 1:1 port of
 * tests/test_overflow_guard.py.
 *
 * These are real regression tests: each over-budget / truncation case asserts on
 * both the stable marker substrings (the intentional contract) AND a bounded
 * output length, so removing the guard from the emit sites — or breaking the
 * truncation logic — fails the test rather than silently passing.
 *
 * All `guard()` calls pass explicit `enabled` / `max_tokens` kwargs so the unit
 * tests never depend on config or environment state. In the TS port the Python
 * keyword args become an options object: `guard(text, { max_tokens, enabled })`.
 *
 * Deliberately NOT ported: tests/test_overflow_guard_cli.py (CliRunner-based) —
 * that is a Layer 7 CLI test exercising `token-goat ...` through typer. It lands
 * with the CLI layer. (See parity_notes / known_gaps in the task report.)
 */
import { describe, expect, it } from "vitest";

import { estimate_tokens, guard } from "../src/token_goat/overflow_guard.js";

// Stable contract substrings the marker MUST contain. These are asserted
// verbatim by design (see task spec) — downstream tooling keys off them.
const _MARKER = "[token-goat: output capped";
const _PROTECT = "to protect context";

// ---------------------------------------------------------------------------
// estimate_tokens
// ---------------------------------------------------------------------------

describe("TestEstimateTokens", () => {
  it("test_empty_string_clamps_to_one", () => {
    // Empty input never returns 0 — the min clamp guarantees >= 1.
    expect(estimate_tokens("")).toBe(1);
  });

  it("test_three_chars_per_token_ratio", () => {
    // ~3 chars/token: 300 visible chars -> 300//3 + 1 == 101.
    expect(estimate_tokens("a".repeat(300))).toBe(101);
  });

  it("test_ansi_codes_stripped_before_counting", () => {
    // ANSI color escapes do not inflate the token count. A red-colored string
    // must estimate identically to its plain-text form, because color codes add
    // bytes but no model-visible tokens.
    const plain = "hello world this is a sample line";
    const colored = `\x1b[31m${plain}\x1b[0m`;
    expect(estimate_tokens(colored)).toBe(estimate_tokens(plain));
    // And the colored estimate must NOT reflect the longer raw length.
    expect(estimate_tokens(colored)).toBeLessThan(estimate_tokens(colored + "x".repeat(100)));
  });
});

// ---------------------------------------------------------------------------
// guard — no-op / identity paths
// ---------------------------------------------------------------------------

describe("TestGuardNoOp", () => {
  it("test_identity_under_budget", () => {
    // Text well under budget is returned unchanged (byte-identical).
    const text = "short body\nsecond line\n";
    expect(guard(text, { max_tokens: 10_000, enabled: true })).toBe(text);
  });

  it("test_disabled_returns_unchanged_even_when_huge", () => {
    // enabled=False short-circuits before any truncation.
    const big = Array.from({ length: 5_000 }, (_, i) => `line ${i}`).join("\n");
    const result = guard(big, { max_tokens: 10, enabled: false });
    expect(result).toBe(big);
    expect(result).not.toContain(_MARKER);
  });

  it("test_max_tokens_zero_never_caps", () => {
    // max_tokens <= 0 is the explicit 'never cap' sentinel.
    const big = Array.from({ length: 5_000 }, (_, i) => `line ${i}`).join("\n");
    const result = guard(big, { max_tokens: 0, enabled: true });
    expect(result).toBe(big);
    expect(result).not.toContain(_MARKER);
  });

  it("test_negative_max_tokens_never_caps", () => {
    const big = Array.from({ length: 5_000 }, (_, i) => `line ${i}`).join("\n");
    expect(guard(big, { max_tokens: -1, enabled: true })).toBe(big);
  });
});

// ---------------------------------------------------------------------------
// guard — over budget truncation
// ---------------------------------------------------------------------------

function _big_text(n = 5_000): string {
  return Array.from({ length: n }, (_, i) => `line ${i}`).join("\n");
}

describe("TestGuardOverBudget", () => {
  it("test_truncates_and_emits_marker", () => {
    const text = _big_text();
    const result = guard(text, { max_tokens: 200, enabled: true });

    // Bounded: result is strictly shorter than the input.
    expect(result.length).toBeLessThan(text.length);
    // Contract substrings present (asserted verbatim — see module docstring).
    expect(result).toContain(_MARKER);
    expect(result).toContain(_PROTECT);
  });

  it("test_kept_portion_is_head_prefix", () => {
    // Truncation keeps the HEAD of the input, not a tail or middle slice.
    const text = _big_text();
    const result = guard(text, { max_tokens: 200, enabled: true });

    // The very first line survives.
    expect(result).toContain("line 0");
    // A late line (well past any reasonable head budget) is dropped.
    expect(result).not.toContain("line 4999");
  });

  it("test_marker_reports_correct_total_line_count", () => {
    const n = 5_000;
    const text = _big_text(n);
    const result = guard(text, { max_tokens: 200, enabled: true });
    // "showing {shown} of {total} lines" — total must be the true line count.
    expect(result).toContain(`of ${n} lines`);
  });

  it("test_body_ends_on_complete_line_boundary", () => {
    // Everything before the marker is a sequence of WHOLE original lines.
    // No mid-line cut: each kept body line must be an exact line from the
    // original input (the multi-line branch keeps whole lines only).
    const text = _big_text();
    const result = guard(text, { max_tokens: 200, enabled: true });

    // Python's rpartition("\n") splits on the LAST newline: body before it,
    // marker after it.
    const lastNl = result.lastIndexOf("\n");
    const body = lastNl === -1 ? "" : result.slice(0, lastNl);
    const marker = lastNl === -1 ? result : result.slice(lastNl + 1);
    expect(marker.startsWith(_MARKER)).toBe(true);
    const original_lines = new Set(text.split("\n"));
    for (const body_line of body.split("\n")) {
      expect(original_lines.has(body_line)).toBe(true);
    }
  });

  it("test_result_within_token_ceiling", () => {
    // The reserved 64-token margin keeps marker+body within max_tokens.
    const text = _big_text();
    const max_tokens = 200;
    const result = guard(text, { max_tokens, enabled: true });
    expect(estimate_tokens(result)).toBeLessThanOrEqual(max_tokens);
  });

  it("test_single_giant_line_gets_marker", () => {
    // A single line with no early newline is hard-sliced and gets the marker.
    // The pathological case the guard exists to protect against: a minified
    // blob on one line. The truncation loop hard-slices the over-budget leading
    // line on the char budget so it cannot pass through whole.
    const giant = "x".repeat(100_000);
    const result = guard(giant, { max_tokens: 200, enabled: true });

    expect(result.startsWith("x")).toBe(true);
    expect(result).toContain(_MARKER);
    expect(result).toContain(_PROTECT);
  });

  it("test_single_giant_line_is_bounded", () => {
    // A single mega-line is bounded below the input and within the token ceiling.
    const giant = "x".repeat(100_000);
    const result = guard(giant, { max_tokens: 200, enabled: true });
    expect(result.length).toBeLessThan(giant.length);
    expect(estimate_tokens(result)).toBeLessThanOrEqual(200);
  });

  it("test_tiny_max_tokens_still_bounds_output", () => {
    // A pathologically small ceiling still produces bounded output, not
    // passthrough. With max_tokens=10 the reserved marker margin underflows the
    // body budget to its floor (body_budget clamps to 1), so the body is a
    // single sliced line plus the marker. The marker alone exceeds 10 tokens, so
    // an estimate_tokens(result) <= 10 assertion would be unsatisfiable — the
    // meaningful guarantee is that output stays bounded by a small constant
    // instead of dumping the 100k-char input.
    const result = guard("x".repeat(100_000), { max_tokens: 10, enabled: true });
    expect(result).toContain(_MARKER);
    // Marker + a tiny sliced body — comfortably under 200 tokens (~52 in practice).
    expect(estimate_tokens(result)).toBeLessThan(200);
    expect(result.length).toBeLessThan(100_000);
  });

  it("test_lone_surrogate_result_is_utf8_encodable", () => {
    // Over-budget text carrying a lone surrogate must not break typer.echo.
    // The emit sites call typer.echo (no fail-soft wrapper), which encodes on
    // the active codepage. A lone surrogate (U+DC80–U+DCFF) in the kept body
    // raises UnicodeEncodeError unless sanitize_surrogates replaced it first.
    // This fails on the pre-fix code and passes after the sanitize wrap.
    const text = "\udce9" + Array.from({ length: 5_000 }, (_, i) => `line ${i}`).join("\n");
    const result = guard(text, { max_tokens: 200, enabled: true });
    expect(result).toContain(_MARKER);
    // Must not raise — the lone surrogate has been replaced with U+FFFD. The TS
    // analogue of Python's result.encode("utf-8"): encoding the JS string to a
    // UTF-8 Buffer must not contain the unpaired surrogate. After
    // sanitizeSurrogates, no lone surrogate remains, so round-tripping is stable.
    expect(/[\uD800-\uDFFF]/.test(result)).toBe(false);
    Buffer.from(result, "utf8");
  });
});

// ---------------------------------------------------------------------------
// guard — command-specific remediation hints
// ---------------------------------------------------------------------------

function _marker(command: string): string {
  const text = Array.from({ length: 5_000 }, (_, i) => `line ${i}`).join("\n");
  const result = guard(text, { command, max_tokens: 200, enabled: true });
  expect(result).toContain(_MARKER);
  return result;
}

describe("TestGuardHintVariants", () => {
  it("test_symbol_hint_mentions_method_or_json", () => {
    const marker = _marker("symbol");
    expect(marker.includes("--json") || marker.includes("::")).toBe(true);
  });

  it("test_section_hint_mentions_sub_heading", () => {
    const marker = _marker("section");
    // section/heading hint points at a narrower sub-heading (e.g. 'doc.md::Section#2').
    expect(marker.includes("#2") || marker.toLowerCase().includes("sub-heading")).toBe(true);
  });

  it("test_heading_hint_matches_section", () => {
    // 'heading' and 'section' share the same remediation hint.
    const section_marker = _marker("section");
    const heading_marker = _marker("heading");
    // Both should mention the sub-heading remediation.
    expect(
      heading_marker.includes("#2") || heading_marker.toLowerCase().includes("sub-heading"),
    ).toBe(true);
    // And produce the same hint text. Python rpartition("showing")[2] = the
    // substring AFTER the last "showing".
    const sectionTail = section_marker.slice(section_marker.lastIndexOf("showing") + "showing".length);
    const headingTail = heading_marker.slice(heading_marker.lastIndexOf("showing") + "showing".length);
    expect(sectionTail).toBe(headingTail);
  });

  it("test_lines_hint_mentions_line_range", () => {
    const marker = _marker("lines");
    // lines hint suggests a smaller line range, e.g. 'file.py::100-150'.
    expect(marker.toLowerCase().includes("range") || marker.includes("100-150")).toBe(true);
  });

  it("test_bash_output_hint_mentions_grep_tail_section", () => {
    const marker = _marker("bash-output");
    expect(marker).toContain("--grep");
    expect(marker).toContain("--tail");
    expect(marker).toContain("--section");
  });

  it("test_web_output_hint_matches_bash_output", () => {
    const marker = _marker("web-output");
    expect(marker).toContain("--grep");
  });

  it("test_default_hint_differs_from_command_hints", () => {
    // Unlabeled command produces the generic 'narrow your query' hint.
    const default_marker = _marker("");
    expect(default_marker.includes("max_tokens") || default_marker.includes("Narrow")).toBe(true);
    // The default hint must NOT carry a command-specific remediation.
    expect(default_marker).not.toContain("--grep");
    expect(default_marker).not.toContain("::Class.method");
  });
});
