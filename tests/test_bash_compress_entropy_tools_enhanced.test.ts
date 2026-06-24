/**
 * Enhanced tests for JsonArrayFilter, GenericFilter, and WindsurfFilter.
 *
 * 1:1 port of tests/test_bash_compress_entropy_tools_enhanced.py. Every Python
 * `def test_*` maps to a vitest `it()` with the SAME name and assertion
 * polarity; the three Python test classes (TestJsonArrayFilter,
 * TestGenericEntropyFilter, TestWindsurfFilterEnhanced) map to `describe()`
 * blocks of the same name.
 *
 * Test-seam mapping (Python -> TS):
 *  - `from tests.filter_test_helpers import apply_filter, savings_ratio`
 *      -> local `apply_filter` / `savings_ratio` helpers below (ports of the
 *         Python helpers: apply_filter calls `filter_.apply(stdout, stderr,
 *         exit_code, argv).text`, defaulting argv to `[filter_.name]` when
 *         omitted; savings_ratio returns `apply(...).percent_saved / 100.0`).
 *  - `from token_goat import bash_compress as bc`
 *      -> import the barrel "../src/token_goat/bash_compress.js" as `bc`
 *        (re-exports JsonArrayFilter / GenericFilter / WindsurfFilter +
 *        detect_from_command).
 *  - Class-level `F = bc.<Filter>()` singletons -> module-level `const F_Json`
 *    / `F_Generic` / `F_Windsurf`. The filters are stateless across calls
 *    (compress() reads no mutable instance fields), so a shared instance is
 *    observably identical to per-test `new <Filter>()`. Mirrors the Python
 *    class-attribute pattern.
 *  - The Python `self._compress(stdout)` helpers call `apply_filter(self.F,
 *    stdout=stdout, argv=[...])`; ported as local `_compressJson` /
 *    `_compressGeneric` closures that route through `apply_filter`.
 *
 * Byte-exactness: assertions are substring `in` / `not in`, `.count(...)`,
 * `len(out) < len(inp) * k`, and `json.loads(out)` round-trips. JSON fixtures
 * are built via `JSON.stringify` (the TS equivalent of Python `json.dumps`)
 * and parsed back via `JSON.parse` (the TS equivalent of `json.loads`). The
 * fixtures are pure ASCII so code-unit length equals byte length.
 */
import { describe, expect, it } from "vitest";

import * as bc from "../src/token_goat/bash_compress.js";
import type { Filter } from "../src/token_goat/bash_compress.js";

// ---------------------------------------------------------------------------
// Ports of tests/filter_test_helpers.py: apply_filter + savings_ratio.
// ---------------------------------------------------------------------------

/**
 * Run filter_.apply() and return the compressed text. When argv is omitted the
 * filter's own `.name` is used as the sole argv element (matching the Python
 * helper's `argv=None` default).
 */
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

/** Return the byte-savings fraction in [0.0, 1.0] (Python savings_ratio). */
function savings_ratio(
  filter_: Filter,
  opts: { stdout: string; stderr?: string; argv?: string[] },
): number {
  const argv = opts.argv ?? [filter_.name];
  return filter_.apply(opts.stdout, opts.stderr ?? "", 0, argv).percent_saved / 100.0;
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
// TestJsonArrayFilter
// ===========================================================================

describe("TestJsonArrayFilter", () => {
  const F = new bc.JsonArrayFilter();

  function _compress(stdout: string): string {
    return apply_filter(F, { stdout, argv: ["gh", "api", "/repos"] });
  }

  it("test_empty_input_returns_empty", () => {
    const out = _compress("");
    expect(out).toBe("");
  });

  it("test_non_array_json_passthrough", () => {
    // A JSON object (not array) should pass through unchanged.
    const obj: Record<string, unknown> = { key: "value", count: 42 };
    const out = _compress(JSON.stringify(obj));
    const parsed = JSON.parse(out) as Record<string, unknown>;
    expect(parsed["key"]).toBe("value");
    expect(parsed["count"]).toBe(42);
  });

  it("test_invalid_json_passthrough", () => {
    // Invalid JSON must pass through rather than raise.
    const junk = "not json at all\nsecond line";
    const out = _compress(junk);
    expect(out).toContain("not json at all");
  });

  it("test_empty_array_passthrough", () => {
    const out = _compress("[]");
    expect(JSON.parse(out)).toEqual([]);
  });

  it("test_single_item_array_passthrough", () => {
    const data: Array<Record<string, unknown>> = [{ id: 1, name: "alpha" }];
    const out = _compress(JSON.stringify(data));
    const parsed = JSON.parse(out) as Array<Record<string, unknown>>;
    expect(parsed.length).toBe(1);
    expect(parsed[0]!["name"]).toBe("alpha");
  });

  it("test_duplicate_objects_collapsed", () => {
    const data: Array<Record<string, unknown>> = [
      { status: "ok" },
      { status: "ok" },
      { status: "ok" },
    ];
    const out = _compress(JSON.stringify(data));
    expect(out).toContain("2 duplicate");
  });

  it("test_dedup_suffix_line_count", () => {
    // With N-1 duplicates the suffix must mention the right count.
    const n = 5;
    const data: Array<Record<string, unknown>> = Array.from({ length: n }, () => ({ x: 1 }));
    const stdout = JSON.stringify(data);
    const out = _compress(stdout);
    expect(out).toContain(`${n - 1} duplicate`);
    // Filter pretty-prints; compare against the full pretty-printed equivalent.
    const full_pretty = JSON.stringify(data, null, 2);
    expect(out.length).toBeLessThan(full_pretty.length);
  });

  it("test_objects_different_key_sets_group_separately", () => {
    // Objects with key {"a"} and objects with key {"b"} form separate dedup groups.
    const data: Array<Record<string, unknown>> = [
      { a: 1 },
      { a: 2 },
      { b: 10 },
      { b: 20 },
    ];
    const out = _compress(JSON.stringify(data));
    // Each key-set is deduplicated independently; two separate dedup messages emitted.
    expect(out).toContain("keys {a}");
    expect(out).toContain("keys {b}");
  });

  it("test_base64_value_preserves_object", () => {
    // Long base64-like value has high entropy — object must not be deduped.
    const b64 = "dGhpcyBpcyBhIHRlc3QgYmFzZTY0IHN0cmluZyBsb25nZW5vdWdo";
    const data: Array<Record<string, unknown>> = [
      { id: 1, data: "plain" },
      { id: 2, data: b64 },
    ];
    const out = _compress(JSON.stringify(data));
    expect(out).not.toContain("1 duplicate");
    expect(out).toContain(b64);
  });

  it("test_repeated_40char_hex_value_deduped", () => {
    // 40-char hex value that is IDENTICAL in both objects does NOT prevent dedup
    // (entropy guard fires only when the value differs between objects — and
    // even if it fired, identical objects collapse anyway because the first
    // instance is always kept).
    const sha = "a".repeat(40);
    const data: Array<Record<string, unknown>> = [
      { commit: sha, msg: "first" },
      { commit: sha, msg: "first" },
    ];
    const out = _compress(JSON.stringify(data));
    // Identical objects -> deduped; first one is kept.
    expect(out).toContain("first");
    expect(out).toContain("1 duplicate");
  });

  it("test_non_dict_items_preserved", () => {
    // Arrays containing non-dict items (strings, ints) pass through.
    const data: unknown[] = ["alpha", "beta", "gamma"];
    const out = _compress(JSON.stringify(data));
    const parsed = JSON.parse(out) as unknown[];
    expect(parsed).toContain("alpha");
    expect(parsed).toContain("gamma");
  });

  it("test_mixed_dict_and_scalar_items", () => {
    // Scalars between dicts survive; dict dedup still applies.
    const data: unknown[] = [{ x: 1 }, "sep", { x: 1 }];
    const out = _compress(JSON.stringify(data));
    expect(out).toContain("sep");
    // The two identical {"x": 1} objects must be deduplicated — one dup dropped.
    expect(out).toContain("1 duplicate");
  });

  it("test_large_array_dedup_reduces_size", () => {
    // 50 identical objects -> output must be much smaller than input.
    const data: Array<Record<string, unknown>> = Array.from({ length: 50 }, () => ({
      status: "ok",
      code: 200,
    }));
    const inp = JSON.stringify(data);
    const out = _compress(inp);
    expect(out.length).toBeLessThan(inp.length * 0.5);
  });

  it("test_dedup_message_names_key_set", () => {
    const data: Array<Record<string, unknown>> = Array.from({ length: 3 }, () => ({
      alpha: 1,
      beta: 2,
    }));
    const out = _compress(JSON.stringify(data));
    // The dedup line must mention both keys.
    expect(out).toContain("alpha");
    expect(out).toContain("beta");
  });
});

// ===========================================================================
// TestGenericEntropyFilter
// ===========================================================================

describe("TestGenericEntropyFilter", () => {
  const F = new bc.GenericFilter();

  function _compress(stdout: string): string {
    return apply_filter(F, { stdout, argv: ["cmd"] });
  }

  it("test_empty_input_returns_empty", () => {
    const out = _compress("");
    expect(out).toBe("");
  });

  it("test_single_line_passthrough", () => {
    const out = _compress("hello world");
    expect(out).toContain("hello world");
  });

  it("test_two_identical_plain_lines_deduped", () => {
    const out = _compress("foo\nfoo");
    expect(out).toContain("×2");
  });

  it("test_entropy_bypass_uuid_two_lines", () => {
    // Two identical UUID lines must NOT be deduped.
    const uid = "550e8400-e29b-41d4-a716-446655440000";
    const line = `request_id=${uid}`;
    const out = _compress(`${line}\n${line}`);
    expect(_count(out, line)).toBe(2);
    // Entropy bypass means no dedup marker was inserted.
    expect(out).not.toContain("×");
  });

  it("test_entropy_bypass_real_sha256", () => {
    // Real SHA-256 hash has high Shannon entropy -> bypasses dedup.
    const sha = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
    const line = `hash=${sha}`;
    const out = _compress(`${line}\n${line}`);
    expect(_count(out, line)).toBe(2);
  });

  it("test_low_entropy_repeated_chars_still_deduped", () => {
    // Repeated-char strings are long but low entropy -> dedup fires normally.
    const token = "x".repeat(48);
    const line = `key=${token}`;
    const out = _compress(`${line}\n${line}\n${line}`);
    // Low-entropy value — deduped.
    expect(out).toContain("×3");
  });

  it("test_short_line_under_min_length_is_deduped", () => {
    // Lines under 8 chars are not entropy-checked -> normal dedup.
    const out = _compress("ab\nab\nab");
    expect(out).toContain("×3");
  });

  it("test_plain_english_lines_collapsed_to_one", () => {
    const out = _compress("note: file updated\n".repeat(4));
    expect(out).toContain("×4");
    expect(_count(out, "note: file updated")).toBe(1);
  });

  it("test_run_of_mixed_entropy_preserves_order", () => {
    // UUID lines interspersed with plain lines; plain ones collapse.
    const uid = "550e8400-e29b-41d4-a716-446655440000";
    const plain = "processed";
    const inp = [uid, plain, uid, plain, plain].join("\n");
    const out = _compress(inp);
    // UUID lines all present.
    expect(_count(out, uid)).toBe(2);
    // plain lines collapsed — 3 occurrences of "processed", 2 are duplicates.
    expect(out).toContain("×2");
  });

  it("test_dedup_run_min_two_not_single", () => {
    // A single occurrence is never tagged as a duplicate.
    const out = _compress("unique line here");
    expect(out).not.toContain("×");
  });

  it("test_stderr_combined_in_output", () => {
    // apply_filter merges stderr into output when non-empty.
    const out = apply_filter(F, { stdout: "out line", stderr: "err line", argv: ["cmd"] });
    expect(out).toContain("out line");
    expect(out).toContain("err line");
  });

  it("test_savings_on_repetitive_output", () => {
    // 20 identical lines -> at least 50% savings.
    const ratio = savings_ratio(F, { stdout: "warning: deprecated\n".repeat(20), argv: ["cmd"] });
    expect(ratio).toBeGreaterThanOrEqual(0.5);
  });
});

// ===========================================================================
// TestWindsurfFilterEnhanced
// ===========================================================================

describe("TestWindsurfFilterEnhanced", () => {
  const F = new bc.WindsurfFilter();

  it("test_empty_input_returns_empty", () => {
    const out = apply_filter(F, { stdout: "" });
    expect(out).toBe("");
  });

  it("test_dispatch_detects_windsurf_command", () => {
    const result = bc.detect_from_command("windsurf .");
    expect(result).not.toBeNull();
    const [filt, _argv] = result!;
    expect(filt.name).toBe("windsurf");
    expect(filt.matches(["windsurf", "."])).toBe(true);
  });

  it("test_dispatch_detects_windsurf_path", () => {
    // Full path invocation must also dispatch to WindsurfFilter.
    const result = bc.detect_from_command("/usr/bin/windsurf --new-window");
    expect(result).not.toBeNull();
    const [filt, _argv] = result!;
    expect(filt.name).toBe("windsurf");
    expect(filt.matches(["/usr/bin/windsurf", "--new-window"])).toBe(true);
  });

  it("test_codeium_activation_lines_dropped", () => {
    const lines = "Codeium: Activating...\nCodeium index: loading...\nReady.\n";
    const out = apply_filter(F, { stdout: lines });
    expect(out).not.toContain("Codeium: Activating");
    expect(out).not.toContain("Codeium index: loading");
    expect(out).toContain("Ready.");
  });

  it("test_authentication_status_dropped", () => {
    const lines = "Authentication status: authenticated\nModel status: ready\nDone.\n";
    const out = apply_filter(F, { stdout: lines });
    expect(out).not.toContain("Authentication status");
    expect(out).not.toContain("Model status");
    expect(out).toContain("Done.");
  });

  it("test_telemetry_disabled_dropped", () => {
    const lines = "Telemetry is disabled\nResponse text here.\n";
    const out = apply_filter(F, { stdout: lines });
    expect(out).not.toContain("Telemetry is disabled");
    expect(out).toContain("Response text here.");
  });

  it("test_only_noise_returns_minimal", () => {
    // Input with nothing but startup noise produces very short output.
    const noise = [
      "Windsurf v1.4.2",
      "Codeium: Activating...",
      "Codeium index: loading...",
      "Connecting to Codeium server",
      "Authentication status: authenticated",
      "Cascade: connected",
      "Cascade: ready",
      "Thinking...",
      "Generating...",
    ].join("\n");
    const out = apply_filter(F, { stdout: noise });
    // Meaningful content lines are absent; output must be much shorter than input.
    expect(out.length).toBeGreaterThan(0);
    expect(out.length).toBeLessThan(noise.length * 0.5);
  });

  it("test_response_body_preserved_in_full", () => {
    // Multi-paragraph response must survive unchanged.
    const body =
      "The `process_data` function reads from S3.\n" +
      "It transforms records via the ETL pipeline.\n" +
      "Finally it writes to PostgreSQL.\n";
    const preamble = "Cascade: connected\nThinking...\n";
    const out = apply_filter(F, { stdout: preamble + body });
    expect(out).toContain("reads from S3");
    expect(out).toContain("ETL pipeline");
    expect(out).toContain("PostgreSQL");
  });

  it("test_context_meter_single_line_preserved", () => {
    const lines = "Context: 12345 / 200000 tokens (6%)\nResult: 42\n";
    const out = apply_filter(F, { stdout: lines });
    expect(out).toContain("12345");
    expect(out).toContain("6%");
    expect(out).toContain("Result: 42");
  });

  it("test_multiple_context_meters_only_last_kept", () => {
    // Earlier meter reads are superseded by the last one.
    const lines =
      "Context: 10000 / 200000 tokens (5%)\n" +
      "Context: 50000 / 200000 tokens (25%)\n" +
      "Context: 80000 / 200000 tokens (40%)\n" +
      "Answer text.\n";
    const out = apply_filter(F, { stdout: lines });
    // Only the last meter value should appear.
    expect(out).not.toContain("10000");
    expect(out).not.toContain("50000");
    expect(out).toContain("Answer text.");
  });

  it("test_savings_on_pure_startup_noise", () => {
    const noiseBlock =
      "Windsurf v1.4.2\n" +
      "Codeium: Activating...\n" +
      "Codeium index: loading...\n" +
      "Codeium index loaded\n" +
      "Connecting to Codeium server\n" +
      "Authentication status: authenticated\n" +
      "Model status: ready\n" +
      "Cascade: connected\n" +
      "Cascade: ready\n" +
      "Cascade v2.1.0\n" +
      "AI assistant ready\n" +
      "Loading workspace...\n" +
      "Indexing workspace... (100/500 files)\n" +
      "Workspace loading\n" +
      "Scanning files...\n" +
      "File watcher started\n" +
      "Thinking...\n" +
      "Generating...\n" +
      "Telemetry is disabled\n";
    const noise = noiseBlock.repeat(3);
    const ratio = savings_ratio(F, { stdout: noise });
    expect(ratio).toBeGreaterThanOrEqual(0.6);
  });

  it("test_tool_calls_collapsed_to_count", () => {
    const lines =
      "Cascade is reading file: src/a.py\n" +
      "Cascade is reading file: src/b.py\n" +
      "Cascade is reading file: src/c.py\n" +
      "Cascade is writing file: src/d.py\n" +
      "Cascade is running: make test\n" +
      "Here is my summary.\n";
    const out = apply_filter(F, { stdout: lines });
    // None of the file paths should appear verbatim.
    expect(out).not.toContain("src/a.py");
    expect(out).not.toContain("src/b.py");
    expect(out).not.toContain("src/c.py");
    expect(out).not.toContain("src/d.py");
    // A collapse message with count and tool-call label must be present.
    expect(out.toLowerCase()).toContain("collapsed");
    expect(out.toLowerCase()).toContain("tool");
    expect(out).toContain("Here is my summary.");
  });

  it("test_filter_name_is_windsurf", () => {
    expect(F.name).toBe("windsurf");
  });

  it("test_pure_response_no_noise_passthrough", () => {
    // Clean response with no noise patterns must survive intact.
    const body = "The answer is 42.\nNo noise here.\n";
    const out = apply_filter(F, { stdout: body });
    expect(out).toContain("The answer is 42.");
    expect(out).toContain("No noise here.");
  });
});
