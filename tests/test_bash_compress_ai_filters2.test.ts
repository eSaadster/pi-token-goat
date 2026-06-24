/**
 * Tests for CursorFilter, WindsurfFilter, OpenCodeFilter, and ContinueFilter.
 *
 * 1:1 port of tests/test_bash_compress_ai_filters2.py. Every Python `def
 * test_*` maps to a vitest `it()` with the SAME name and assertion polarity.
 *
 * Test-seam mapping (Python -> TS):
 *  - `from token_goat import bash_compress as bc`
 *      -> import the barrel "../src/token_goat/bash_compress.js" as `bc`
 *        (re-exports CursorFilter / WindsurfFilter / OpenCodeFilter /
 *        ContinueFilter + detect_from_command + the FILTERS registry + __all__).
 *  - `from tests.filter_test_helpers import apply_filter, savings_ratio`
 *      -> local `_apply(...)` / `_savings_ratio(...)` helpers below. `_apply`
 *        runs `filter_.apply(stdout, stderr, exit_code, argv).text`; when argv
 *        is omitted the filter's own `.name` is the sole argv element (matching
 *        filter_test_helpers.apply_filter exactly). `_savings_ratio` returns
 *        `filter_.apply(...).percent_saved / 100.0`.
 *
 * Byte-exactness: assertions are substring `in` / `not in` checks, a
 * newline-delimited body-line filter, and `percent_saved` ratio comparisons.
 * The fixtures are pure ASCII; Python `len` (code points) equals JS `.length`
 * equals the UTF-8 byte count — no Buffer arithmetic is needed. U+2028 / U+2029
 * never appear in the fixtures (they are line terminators in TS source).
 */
import { describe, expect, it } from "vitest";

import * as bc from "../src/token_goat/bash_compress.js";
import {
  ContinueFilter,
  CursorFilter,
  OpenCodeFilter,
  WindsurfFilter,
} from "../src/token_goat/bash_compress.js";

import type { Filter } from "../src/token_goat/bash_compress.js";

// ---------------------------------------------------------------------------
// Local helpers — port of tests/filter_test_helpers.py (apply_filter +
// savings_ratio). When argv is omitted the filter's own `.name` is the sole
// argv element (matching the Python helper's default exactly).
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
  opts: { stdout: string; stderr?: string; argv?: string[] },
): number {
  const stdout = opts.stdout;
  const stderr = opts.stderr ?? "";
  const argv = opts.argv ?? [filter_.name];
  return filter_.apply(stdout, stderr, 0, argv).percent_saved / 100.0;
}

// ===========================================================================
// CursorFilter
// ===========================================================================

const _CURSOR_STARTUP_VERBOSE = `Cursor 0.42.3
Extension host started
Extension 'cursor.cursor-always-local' activated
Extension 'cursor.anysphere-codewhisperer' activated
Telemetry is disabled
Starting debug adapter
Opening folder...
Connection established
Tunnel connected
> Your project is loaded successfully.
Error: failed to load extension cursor.bad-ext
`;

const _CURSOR_CLEAN_OUTPUT = `> Running test suite...
All 42 tests passed.
Build completed in 3.2s.
`;

describe("TestCursorFilter", () => {
  it("test_cursor_filter_matches", () => {
    const f = new CursorFilter();
    expect(f.matches(["cursor"])).toBe(true);
    expect(f.matches(["cursor", "--new-window"])).toBe(true);
    expect(f.matches(["cursor", "."])).toBe(true);
    expect(f.matches(["code"])).toBe(false);
    expect(f.matches(["windsurf"])).toBe(false);
    expect(f.matches([])).toBe(false);
  });

  it("test_cursor_drops_startup_lines", () => {
    const out = _apply(new CursorFilter(), { stdout: _CURSOR_STARTUP_VERBOSE });
    expect(out).not.toContain("Extension host started");
    expect(out).not.toContain("Extension 'cursor.");
    expect(out).not.toContain("Telemetry is disabled");
    expect(out).not.toContain("Starting debug adapter");
    expect(out).not.toContain("Opening folder");
    expect(out).not.toContain("Connection established");
    expect(out).not.toContain("Tunnel connected");
  });

  it("test_cursor_drops_version_banner", () => {
    const out = _apply(new CursorFilter(), { stdout: _CURSOR_STARTUP_VERBOSE });
    expect(out).not.toContain("Cursor 0.42.3");
  });

  it("test_cursor_keeps_error_signals", () => {
    const out = _apply(new CursorFilter(), { stdout: _CURSOR_STARTUP_VERBOSE });
    expect(out).toContain("Error: failed to load extension");
  });

  it("test_cursor_keeps_clean_output", () => {
    const out = _apply(new CursorFilter(), { stdout: _CURSOR_CLEAN_OUTPUT });
    expect(out).toContain("42 tests passed");
    expect(out).toContain("Build completed");
  });

  it("test_cursor_preserves_all_stderr_on_error", () => {
    const out = _apply(new CursorFilter(), {
      stdout: "Cursor 0.42.3\nExtension host started\n",
      stderr: "Error: Cannot find module 'some-module'\n",
      exit_code: 1,
    });
    expect(out).toContain("Cannot find module");
  });

  it("test_cursor_savings", () => {
    const ratio = _savings_ratio(new CursorFilter(), { stdout: _CURSOR_STARTUP_VERBOSE });
    expect(ratio).toBeGreaterThanOrEqual(0.3);
  });
});

// ===========================================================================
// WindsurfFilter
// ===========================================================================

const _WINDSURF_STARTUP_VERBOSE = `Windsurf 1.3.0
Extension host started
Extension 'codeium.codeium' activated
Codeium: Activating...
Codeium index: loading...
Codeium index loaded
Connecting to Codeium server
Authentication status: authenticated
Model status: ready
Telemetry is disabled
Opening folder...

> Cascade is ready.
Your workspace has 127 Python files.
`;

const _WINDSURF_ERROR_OUTPUT = `Windsurf 1.3.0
Extension host started
Codeium: Activating...
Error: Codeium authentication failed
`;

describe("TestWindsurfFilter", () => {
  it("test_windsurf_filter_matches", () => {
    const f = new WindsurfFilter();
    expect(f.matches(["windsurf"])).toBe(true);
    expect(f.matches(["windsurf", "--new-window"])).toBe(true);
    expect(f.matches(["windsurf", "."])).toBe(true);
    expect(f.matches(["cursor"])).toBe(false);
    expect(f.matches(["code"])).toBe(false);
    expect(f.matches([])).toBe(false);
  });

  it("test_windsurf_drops_startup_lines", () => {
    const out = _apply(new WindsurfFilter(), { stdout: _WINDSURF_STARTUP_VERBOSE });
    expect(out).not.toContain("Extension host started");
    expect(out).not.toContain("Extension 'codeium.");
    expect(out).not.toContain("Opening folder");
  });

  it("test_windsurf_drops_codeium_noise", () => {
    const out = _apply(new WindsurfFilter(), { stdout: _WINDSURF_STARTUP_VERBOSE });
    expect(out).not.toContain("Codeium: Activating");
    expect(out).not.toContain("Codeium index: loading");
    expect(out).not.toContain("Connecting to Codeium server");
    expect(out).not.toContain("Authentication status:");
    expect(out).not.toContain("Model status:");
  });

  it("test_windsurf_drops_version_banner", () => {
    const out = _apply(new WindsurfFilter(), { stdout: _WINDSURF_STARTUP_VERBOSE });
    expect(out).not.toContain("Windsurf 1.3.0");
  });

  it("test_windsurf_drops_telemetry", () => {
    const out = _apply(new WindsurfFilter(), { stdout: _WINDSURF_STARTUP_VERBOSE });
    expect(out).not.toContain("Telemetry is disabled");
  });

  it("test_windsurf_keeps_actual_output", () => {
    const out = _apply(new WindsurfFilter(), { stdout: _WINDSURF_STARTUP_VERBOSE });
    expect(out).toContain("Cascade is ready");
    expect(out).toContain("127 Python files");
  });

  it("test_windsurf_keeps_error_signals", () => {
    const out = _apply(new WindsurfFilter(), { stdout: _WINDSURF_ERROR_OUTPUT });
    expect(out).toContain("Error: Codeium authentication failed");
  });

  it("test_windsurf_preserves_all_stderr_on_error", () => {
    const out = _apply(new WindsurfFilter(), {
      stdout: "Windsurf 1.3.0\nExtension host started\n",
      stderr: "Error: License expired\n",
      exit_code: 1,
    });
    expect(out).toContain("License expired");
  });

  it("test_windsurf_savings", () => {
    const ratio = _savings_ratio(new WindsurfFilter(), { stdout: _WINDSURF_STARTUP_VERBOSE });
    expect(ratio).toBeGreaterThanOrEqual(0.3);
  });
});

// ===========================================================================
// OpenCodeFilter
// ===========================================================================

const _OPENCODE_SESSION = `OpenCode v0.3.1
Provider: anthropic
Model: claude-3-5-sonnet-20241022
Mode: auto

Context: 8234 / 200000

The project uses a monorepo layout with packages under src/.
Each package has its own pyproject.toml.

Context: 9101 / 200000
Session saved to ~/.opencode/sessions/abc123.json
`;

const _OPENCODE_WITH_TOOLS = `OpenCode v0.3.1
Provider: openai
Model: gpt-4o

→ read_file(path="src/main.py")
← result (1847 chars)
→ bash(command="pytest tests/ -q")
← result (342 chars)
...

All tests pass. The entry point is src/main.py:main().

Context: 15000 / 128000
`;

const _OPENCODE_ERROR = `OpenCode v0.3.1
Provider: anthropic
Model: claude-3-5-sonnet-20241022
Error: API key invalid or expired
`;

describe("TestOpenCodeFilter", () => {
  it("test_opencode_filter_matches", () => {
    const f = new OpenCodeFilter();
    expect(f.matches(["opencode"])).toBe(true);
    expect(f.matches(["opencode", "--model", "gpt-4o"])).toBe(true);
    expect(f.matches(["aider"])).toBe(false);
    expect(f.matches(["cursor"])).toBe(false);
    expect(f.matches([])).toBe(false);
  });

  it("test_opencode_drops_banner", () => {
    const out = _apply(new OpenCodeFilter(), { stdout: _OPENCODE_SESSION });
    expect(out).not.toContain("OpenCode v0.3.1");
  });

  it("test_opencode_drops_spinner", () => {
    const out = _apply(new OpenCodeFilter(), { stdout: _OPENCODE_WITH_TOOLS });
    // bare "..." spinner should not be in the final output
    expect(out).not.toContain("\n...\n");
  });

  it("test_opencode_drops_session_footer", () => {
    const out = _apply(new OpenCodeFilter(), { stdout: _OPENCODE_SESSION });
    expect(out).not.toContain("Session saved to");
  });

  it("test_opencode_collapses_tool_calls", () => {
    const out = _apply(new OpenCodeFilter(), { stdout: _OPENCODE_WITH_TOOLS });
    expect(out).not.toContain("→ read_file");
    expect(out).not.toContain("← result");
    // collapsed summary should appear
    expect(out.toLowerCase().includes("tool call") || out.includes("token-goat")).toBe(true);
  });

  it("test_opencode_keeps_last_provider_and_model", () => {
    const out = _apply(new OpenCodeFilter(), { stdout: _OPENCODE_SESSION });
    expect(out.toLowerCase().includes("anthropic") || out.toLowerCase().includes("provider")).toBe(
      true,
    );
    expect(out.toLowerCase().includes("claude") || out.toLowerCase().includes("model")).toBe(true);
  });

  it("test_opencode_keeps_context_meter", () => {
    const out = _apply(new OpenCodeFilter(), { stdout: _OPENCODE_SESSION });
    // Last context value should be surfaced
    expect(out.includes("9101") || out.toLowerCase().includes("context")).toBe(true);
  });

  it("test_opencode_keeps_response_body", () => {
    const out = _apply(new OpenCodeFilter(), { stdout: _OPENCODE_SESSION });
    expect(out).toContain("monorepo");
    expect(out).toContain("pyproject.toml");
  });

  it("test_opencode_keeps_error_signals", () => {
    const out = _apply(new OpenCodeFilter(), { stdout: _OPENCODE_ERROR });
    expect(out).toContain("Error:");
  });

  it("test_opencode_preserves_all_stderr_on_error", () => {
    const out = _apply(new OpenCodeFilter(), {
      stdout: "OpenCode v0.3.1\nProvider: openai\n",
      stderr: "Error: rate limit exceeded\n",
      exit_code: 1,
    });
    expect(out).toContain("rate limit exceeded");
  });

  it("test_opencode_savings", () => {
    const ratio = _savings_ratio(new OpenCodeFilter(), { stdout: _OPENCODE_SESSION });
    expect(ratio).toBeGreaterThanOrEqual(0.08);
  });

  it("test_dispatch_routes_opencode", () => {
    const result = bc.detect_from_command("opencode --model gpt-4o");
    expect(result).not.toBeNull();
    const [filter_ /* , _argv */] = result!;
    expect(filter_.name).toBe("opencode");
  });
});

// ===========================================================================
// ContinueFilter
// ===========================================================================

const _CONTINUE_VERBOSE = `Continue v0.9.215
Config loaded from /home/user/.continue/config.json
Loading model: codestral-latest...
Indexing: 1/1234 files...
Indexing: 42/1234 files...
Indexing: 500/1234 files...
Indexing: 1234/1234 files...

The quicksort implementation in src/sort.py is correct but can be
optimised by switching to an iterative approach for large inputs.

Tokens: 2048 prompt, 412 completion
`;

const _CONTINUE_PARTIAL = `Continue v0.9.215
Config loaded from ~/.continue/config.json
Loading model: claude-3-5-haiku-20241022...
Indexing: 10/200 files...
Indexing: 200/200 files...
Here is the refactored code.
`;

const _CONTINUE_ERROR = `Continue v0.9.215
Config loaded from ~/.continue/config.json
Loading model: codestral-latest...
Error: Model endpoint returned 503
`;

describe("TestContinueFilter", () => {
  it("test_continue_filter_matches", () => {
    const f = new ContinueFilter();
    expect(f.matches(["continue"])).toBe(true);
    expect(f.matches(["continue", "--model", "codestral"])).toBe(true);
    expect(f.matches(["aider"])).toBe(false);
    expect(f.matches(["opencode"])).toBe(false);
    expect(f.matches([])).toBe(false);
  });

  it("test_continue_drops_banner", () => {
    const out = _apply(new ContinueFilter(), { stdout: _CONTINUE_VERBOSE });
    expect(out).not.toContain("Continue v0.9.215");
  });

  it("test_continue_drops_config_load", () => {
    const out = _apply(new ContinueFilter(), { stdout: _CONTINUE_VERBOSE });
    expect(out).not.toContain("Config loaded from");
  });

  it("test_continue_drops_model_load", () => {
    const out = _apply(new ContinueFilter(), { stdout: _CONTINUE_VERBOSE });
    expect(out).not.toContain("Loading model:");
  });

  it("test_continue_collapses_indexing_progress", () => {
    const out = _apply(new ContinueFilter(), { stdout: _CONTINUE_VERBOSE });
    // Individual progress lines must be gone
    expect(out).not.toContain("Indexing: 1/1234");
    expect(out).not.toContain("Indexing: 42/1234");
    expect(out).not.toContain("Indexing: 500/1234");
    // But a collapsed summary should appear
    expect(out.toLowerCase().includes("indexing") || out.includes("token-goat")).toBe(true);
  });

  it("test_continue_collapses_partial_indexing", () => {
    const out = _apply(new ContinueFilter(), { stdout: _CONTINUE_PARTIAL });
    // Individual progress lines should not appear as standalone output lines
    // (they may appear inside the collapsed token-goat summary note)
    const body_lines = out
      .split("\n")
      .filter((ln) => !ln.startsWith("[token-goat:"));
    const body = body_lines.join("\n");
    expect(body).not.toContain("Indexing: 10/200");
    expect(body).not.toContain("Indexing: 200/200");
    // Collapsed summary must appear
    expect(out.toLowerCase().includes("indexing") || out.includes("token-goat")).toBe(true);
  });

  it("test_continue_keeps_token_stats", () => {
    const out = _apply(new ContinueFilter(), { stdout: _CONTINUE_VERBOSE });
    expect(out.includes("2048") || out.includes("412") || out.toLowerCase().includes("token")).toBe(
      true,
    );
  });

  it("test_continue_keeps_response_body", () => {
    const out = _apply(new ContinueFilter(), { stdout: _CONTINUE_VERBOSE });
    expect(out).toContain("quicksort");
    expect(out).toContain("src/sort.py");
  });

  it("test_continue_keeps_error_signals", () => {
    const out = _apply(new ContinueFilter(), { stdout: _CONTINUE_ERROR });
    expect(out).toContain("Error:");
  });

  it("test_continue_preserves_all_stderr_on_error", () => {
    const out = _apply(new ContinueFilter(), {
      stdout: "Continue v0.9.215\nConfig loaded from ~/.continue/config.json\n",
      stderr: "Error: cannot connect to language server\n",
      exit_code: 1,
    });
    expect(out).toContain("cannot connect to language server");
  });

  it("test_continue_savings", () => {
    const ratio = _savings_ratio(new ContinueFilter(), { stdout: _CONTINUE_VERBOSE });
    expect(ratio).toBeGreaterThanOrEqual(0.05);
  });
});

// ===========================================================================
// FILTERS list registration + dispatch
// ===========================================================================

describe("TestNewAiFiltersRegistration", () => {
  it("test_new_ai_filters_registered", () => {
    // All new AI editor filters appear in the FILTERS dispatch list.
    const names = new Set(bc.FILTERS.map((f) => f.name));
    expect(names.has("cursor")).toBe(true);
    expect(names.has("windsurf")).toBe(true);
    expect(names.has("opencode")).toBe(true);
    expect(names.has("continue")).toBe(true);
  });

  it("test_new_ai_filters_in_all_exports", () => {
    // New AI filter classes are exported via __all__.
    expect(bc.__all__).toContain("CursorFilter");
    expect(bc.__all__).toContain("WindsurfFilter");
    expect(bc.__all__).toContain("OpenCodeFilter");
    expect(bc.__all__).toContain("ContinueFilter");
  });

  it("test_dispatch_routes_cursor", () => {
    const result = bc.detect_from_command("cursor .");
    expect(result).not.toBeNull();
    const [filter_ /* , _argv */] = result!;
    expect(filter_.name).toBe("cursor");
  });

  it("test_dispatch_routes_windsurf", () => {
    const result = bc.detect_from_command("windsurf --new-window");
    expect(result).not.toBeNull();
    const [filter_ /* , _argv */] = result!;
    expect(filter_.name).toBe("windsurf");
  });

  it("test_dispatch_routes_continue", () => {
    const result = bc.detect_from_command("continue --model codestral");
    expect(result).not.toBeNull();
    const [filter_ /* , _argv */] = result!;
    expect(filter_.name).toBe("continue");
  });
});
