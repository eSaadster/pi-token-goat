/**
 * Tests for WindsurfFilter (Codeium Windsurf + Cascade AI patterns).
 *
 * 1:1 port of tests/test_bash_compress_windsurf.py. Every Python `def test_*`
 * maps to a vitest `it()` with the SAME name and assertion polarity; the
 * Python tests are module-level functions, so they sit under one
 * `describe("TestWindsurfFilter", ...)` block.
 *
 * Test-seam mapping (Python -> TS):
 *  - `from token_goat import bash_compress as bc`
 *      -> import the barrel "../src/token_goat/bash_compress.js" as `bc`
 *        (re-exports WindsurfFilter + detect_from_command).
 *  - `from filter_test_helpers import apply_filter, savings_ratio`
 *      -> local `_apply` and `_savings_ratio` helpers below. `_apply` defaults
 *         argv to `[filter_.name]` exactly like the Python helper; `_savings_ratio`
 *         is `apply(...).percent_saved / 100.0`.
 *
 * Byte-exactness: assertions are substring `in` / `not in` checks plus one
 * savings-ratio threshold. All fixtures and substrings are ASCII.
 */
import { describe, expect, it } from "vitest";

import * as bc from "../src/token_goat/bash_compress.js";
import { WindsurfFilter } from "../src/token_goat/bash_compress.js";

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
// Fixture: a realistic Windsurf + Cascade session (Python lines 11-43).
// ---------------------------------------------------------------------------

const _WINDSURF_CASCADE_SESSION =
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
  "Indexing workspace... (234/1456 files)\n" +
  "Workspace loading\n" +
  "Scanning files...\n" +
  "File watcher started\n" +
  "Thinking...\n" +
  "Thinking...\n" +
  "Generating...\n" +
  "\n" +
  "The `process_data` function in src/pipeline.py handles the main ETL flow.\n" +
  "It reads from S3, transforms the data, and writes to PostgreSQL.\n" +
  "\n" +
  "Cascade is reading file: src/pipeline.py\n" +
  "Cascade is reading file: src/config.py\n" +
  "Cascade is reading file: src/models.py\n" +
  "Context: 45678 / 200000 tokens (23%)\n" +
  "\n" +
  "I recommend refactoring the transform step into a separate class.\n" +
  "\n" +
  "Telemetry is disabled\n";

// ===========================================================================
// TestWindsurfFilter
// ===========================================================================

describe("TestWindsurfFilter", () => {
  // --- individual Cascade-pattern tests ---

  it("test_windsurf_drops_cascade_status", () => {
    // Cascade status lines are dropped as startup noise.
    const f = new WindsurfFilter();
    const lines =
      "Cascade: connected\n" +
      "Cascade: disconnected\n" +
      "Cascade: ready\n" +
      "Cascade: connecting\n" +
      "Cascade: starting\n" +
      "Cascade: model loaded\n" +
      "Cascade v2.1.0\n" +
      "AI assistant ready\n" +
      "AI assistant loaded\n" +
      "AI assistant connecting\n" +
      "Actual response content here.\n";
    const out = _apply(f, { stdout: lines });
    expect(out).not.toContain("Cascade: connected");
    expect(out).not.toContain("Cascade: disconnected");
    expect(out).not.toContain("Cascade: ready");
    expect(out).not.toContain("Cascade v2.1.0");
    expect(out).not.toContain("AI assistant ready");
    expect(out).not.toContain("AI assistant loaded");
    expect(out).not.toContain("AI assistant connecting");
    expect(out).toContain("Actual response content here.");
  });

  it("test_windsurf_drops_cascade_spinner", () => {
    // Cascade spinner / thinking lines are dropped.
    const f = new WindsurfFilter();
    const lines =
      "Thinking...\n" +
      "Thinking\n" +
      "Generating...\n" +
      "Generating\n" +
      "Cascade is thinking...\n" +
      "Processing request...\n" +
      "The answer is 42.\n";
    const out = _apply(f, { stdout: lines });
    expect(out).not.toContain("Thinking");
    expect(out).not.toContain("Generating");
    expect(out).not.toContain("Cascade is thinking");
    expect(out).not.toContain("Processing request");
    expect(out).toContain("The answer is 42.");
  });

  it("test_windsurf_collapses_cascade_tool_calls", () => {
    // Cascade tool-call lines are collapsed to a count, not shown verbatim.
    const f = new WindsurfFilter();
    const lines =
      "Cascade is reading file: src/pipeline.py\n" +
      "Cascade is reading file: src/config.py\n" +
      "Cascade is writing file: src/output.py\n" +
      "Cascade is running: pytest tests/\n" +
      "Here is my analysis of the code.\n";
    const out = _apply(f, { stdout: lines });
    expect(out).not.toContain("src/pipeline.py");
    expect(out).not.toContain("src/config.py");
    expect(out).not.toContain("src/output.py");
    // The count note should mention the collapsed calls
    expect(out.includes("4") || out.includes("tool-call") || out.includes("collapsed")).toBe(true);
    expect(out).toContain("Here is my analysis of the code.");
  });

  it("test_windsurf_drops_workspace_loading", () => {
    // Workspace loading and scanning lines are dropped.
    const f = new WindsurfFilter();
    const lines =
      "Loading workspace...\n" +
      "Indexing workspace... (234/1456 files)\n" +
      "Workspace indexed\n" +
      "Workspace ready\n" +
      "Workspace loading\n" +
      "Scanning files...\n" +
      "File watcher started\n" +
      "Ready to assist.\n";
    const out = _apply(f, { stdout: lines });
    expect(out).not.toContain("Loading workspace");
    expect(out).not.toContain("Indexing workspace");
    expect(out).not.toContain("Workspace indexed");
    expect(out).not.toContain("Workspace ready");
    expect(out).not.toContain("Scanning files");
    expect(out).not.toContain("File watcher");
    expect(out).toContain("Ready to assist.");
  });

  it("test_windsurf_keeps_context_as_note", () => {
    // Context window meter lines are kept as a note, not inline.
    const f = new WindsurfFilter();
    const lines =
      "Context: 45678 / 200000 tokens (23%)\n" +
      "Context: 67890 / 200000 tokens (34%)\n" +
      "The refactoring is complete.\n";
    const out = _apply(f, { stdout: lines });
    // Raw context lines should not appear verbatim in output
    expect(out).toContain("67890 / 200000"); // last seen value preserved in note
    // Earlier meter line is superseded
    expect(out).not.toContain("45678 / 200000");
    expect(out).toContain("The refactoring is complete.");
  });

  it("test_windsurf_keeps_response_body", () => {
    // The actual AI response body is always kept verbatim.
    const f = new WindsurfFilter();
    const out = _apply(f, { stdout: _WINDSURF_CASCADE_SESSION });
    expect(out).toContain("process_data");
    expect(
      out.includes("src/pipeline.py") || out.includes("pipeline.py") || out.includes("ETL flow"),
    ).toBe(true);
    expect(out).toContain("refactoring the transform step");
  });

  it("test_windsurf_savings_on_cascade_session", () => {
    // Savings on a realistic Cascade session are at least 35%.
    const f = new WindsurfFilter();
    const ratio = _savings_ratio(f, _WINDSURF_CASCADE_SESSION);
    expect(ratio).toBeGreaterThanOrEqual(0.35);
  });

  it("test_windsurf_dispatch_routes", () => {
    // detect_from_command('windsurf .') resolves to the WindsurfFilter.
    const result = bc.detect_from_command("windsurf .");
    expect(result).not.toBeNull();
    const [filter_, _argv] = result!;
    expect(filter_.name).toBe("windsurf");
    expect(filter_ instanceof WindsurfFilter).toBe(true);
  });
});
