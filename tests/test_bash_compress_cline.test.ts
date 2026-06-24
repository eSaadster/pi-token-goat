/**
 * Tests for ClineFilter (Cline AI coding assistant CLI output compression).
 *
 * 1:1 port of tests/test_bash_compress_cline.py. Every Python `def test_*`
 * maps to a vitest `it()` with the SAME name and assertion polarity; the
 * Python tests are module-level functions, so they sit under one
 * `describe("TestClineFilter", ...)` block.
 *
 * Test-seam mapping (Python -> TS):
 *  - `from token_goat import bash_compress as bc`
 *      -> import the barrel "../src/token_goat/bash_compress.js" as `bc`
 *        (re-exports ClineFilter + detect_from_command + FILTERS + __all__).
 *  - `from filter_test_helpers import apply_filter, savings_ratio`
 *      -> local `_apply` and `_savings_ratio` helpers below. `_apply` defaults
 *         argv to `[filter_.name]` exactly like the Python helper; `_savings_ratio`
 *         is `apply(...).percent_saved / 100.0`.
 *
 * Byte-exactness: assertions are substring `in` / `not in` checks and one
 * `.count("API Cost") <= 1` check. The fixtures contain emoji (the up/down
 * arrows in the Tokens line) but every assertion is a plain substring match
 * on ASCII substrings, so code-unit `.length` semantics are irrelevant here.
 * The `count` check uses a Python `str.count`-equivalent helper.
 */
import { describe, expect, it } from "vitest";

import * as bc from "../src/token_goat/bash_compress.js";
import { ClineFilter } from "../src/token_goat/bash_compress.js";

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

// ---------------------------------------------------------------------------
// Realistic mixed Cline session output (Python lines 11-38).
// ---------------------------------------------------------------------------

const _CLINE_SESSION =
  "Cline v3.2.1\n" +
  "Loading workspace...\n" +
  "MCP Server 'filesystem' connected (3 tools enabled)\n" +
  "MCP Server 'memory' connected (5 tools enabled)\n" +
  "Thinking...\n" +
  "Processing...\n" +
  "I'll analyze the authentication module and suggest improvements.\n" +
  "\n" +
  "The current implementation has a few issues worth addressing:\n" +
  "1. The token refresh logic doesn't handle network timeouts gracefully.\n" +
  "2. Session expiry is checked only on login, not on each request.\n" +
  "\n" +
  "Cline wants to execute: npm test -- --testPathPattern=auth\n" +
  "Reading file: src/auth.py...\n" +
  "Reading file: src/session.py...\n" +
  "Reading file: tests/test_auth.py...\n" +
  "Streaming response...\n" +
  "✅ Edited src/auth.py\n" +
  "✅ Edited src/session.py\n" +
  "Running: npm test\n" +
  "Command output:\n" +
  "  PASS tests/test_auth.py\n" +
  "Tokens: 45,123 (↑ 32,456 in, ↓ 12,667 out)\n" +
  "API Cost: $0.1234\n" +
  "Context Window: 45,123 / 200,000 tokens (22%)\n" +
  "Task completed successfully.\n";

const _CLINE_SESSION_MULTI_COST =
  "Cline v3.1.0\n" +
  "Loading workspace...\n" +
  "Thinking...\n" +
  "Here is my plan for the refactor.\n" +
  "Tokens: 10,000 (↑ 7,000 in, ↓ 3,000 out)\n" +
  "API Cost: $0.0200\n" +
  "Context Window: 10,000 / 200,000 tokens (5%)\n" +
  "Processing...\n" +
  "Refactor complete.\n" +
  "Tokens: 25,500 (↑ 18,000 in, ↓ 7,500 out)\n" +
  "API Cost: $0.0512\n" +
  "Context Window: 25,500 / 200,000 tokens (12%)\n";

const _CLINE_ERROR_SESSION =
  "Cline v3.2.1\n" +
  "Loading workspace...\n" +
  "Thinking...\n" +
  "Error: Cannot read property 'map' of undefined\n" +
  "Traceback (most recent call last):\n" +
  '  File "main.py", line 42, in run\n' +
  "    TypeError: 'NoneType' is not iterable\n";

const _CLINE_VERBOSE =
  "Cline v3.2.1\n" +
  "Loading workspace...\n" +
  "MCP Server 'filesystem' connected (3 tools enabled)\n" +
  "MCP Server 'memory' connected (5 tools enabled)\n" +
  "MCP Server 'browser' connected (2 tools enabled)\n" +
  "Thinking...\n" +
  "Processing...\n" +
  "Thinking...\n" +
  "Processing...\n" +
  "Thinking...\n" +
  "Processing...\n" +
  "Streaming response...\n" +
  "Streaming response...\n" +
  "Reading file: src/auth.py...\n" +
  "Reading file: src/session.py...\n" +
  "Reading file: src/models/user.py...\n" +
  "Reading file: tests/test_auth.py...\n" +
  "Reading file: src/middleware/jwt.py...\n" +
  "Reading file: src/utils/crypto.py...\n" +
  "The authentication module has several issues.\n" +
  "Tokens: 45,123 (↑ 32,456 in, ↓ 12,667 out)\n" +
  "API Cost: $0.1234\n" +
  "Context Window: 45,123 / 200,000 tokens (22%)\n";

// ===========================================================================
// TestClineFilter
// ===========================================================================

describe("TestClineFilter", () => {
  // --- matches() ---

  it("test_cline_matches", () => {
    const f = new ClineFilter();
    expect(f.matches(["cline"])).toBe(true);
    expect(f.matches(["cline", "--task", "refactor auth.py"])).toBe(true);
    expect(f.matches(["claude-dev"])).toBe(true);
    expect(f.matches(["claude-dev", "--help"])).toBe(true);
    expect(f.matches(["npm"])).toBe(false);
    expect(f.matches(["npx"])).toBe(false);
    expect(f.matches(["aider"])).toBe(false);
    expect(f.matches([])).toBe(false);
  });

  // --- version banner ---

  it("test_cline_drops_version_banner", () => {
    const f = new ClineFilter();
    const out = _apply(f, { stdout: _CLINE_SESSION });
    expect(out).not.toContain("Cline v3.2.1");
  });

  // --- spinner / progress lines ---

  it("test_cline_drops_spinner_lines", () => {
    const f = new ClineFilter();
    const out = _apply(f, { stdout: _CLINE_SESSION });
    // "Thinking..." / "Processing..." / "Streaming response..." dropped
    expect(out).not.toContain("Thinking...");
    expect(out).not.toContain("Processing...");
    expect(out).not.toContain("Streaming response...");
  });

  // --- MCP noise ---

  it("test_cline_drops_mcp_noise", () => {
    const f = new ClineFilter();
    const out = _apply(f, { stdout: _CLINE_SESSION });
    expect(out).not.toContain("MCP Server");
  });

  // --- response body preserved ---

  it("test_cline_keeps_response_body", () => {
    const f = new ClineFilter();
    const out = _apply(f, { stdout: _CLINE_SESSION });
    expect(out).toContain("authentication module");
    expect(out).toContain("token refresh logic");
    expect(out).toContain("Task completed successfully");
    // Edit summaries kept
    expect(out).toContain("Edited src/auth.py");
  });

  // --- "Cline wants to execute:" preserved ---

  it("test_cline_keeps_wants_to_execute", () => {
    const f = new ClineFilter();
    const out = _apply(f, { stdout: _CLINE_SESSION });
    expect(out).toContain("Cline wants to execute");
  });

  // --- token/cost collapsing ---

  it("test_cline_summarises_token_cost", () => {
    const f = new ClineFilter();
    const out = _apply(f, { stdout: _CLINE_SESSION_MULTI_COST });
    // Only the last-seen values should appear in notes; raw lines dropped
    expect(out.includes("25,500") || out.includes("0.0512")).toBe(true);
    // The first (intermediate) cost line should not appear verbatim in output
    // (at most 1 note line, not both raw lines)
    expect(_count(out, "API Cost")).toBeLessThanOrEqual(1);
  });

  // --- non-zero exit: preserve stderr verbatim ---

  it("test_cline_preserves_error_on_nonzero_exit", () => {
    const f = new ClineFilter();
    const stderr = "cline: fatal internal error\nCannot connect to extension host\n";
    const out = _apply(f, { stdout: "", stderr, exit_code: 1 });
    expect(out).toContain("fatal internal error");
    expect(out).toContain("extension host");
  });

  // --- error signals in stdout always kept ---

  it("test_cline_keeps_error_signals_in_stdout", () => {
    const f = new ClineFilter();
    const out = _apply(f, { stdout: _CLINE_ERROR_SESSION });
    expect(out).toContain("Cannot read property");
    expect(out).toContain("TypeError");
  });

  // --- savings ratio ---

  it("test_cline_savings", () => {
    const f = new ClineFilter();
    const ratio = _savings_ratio(f, _CLINE_VERBOSE);
    expect(ratio).toBeGreaterThanOrEqual(0.2);
  });

  // --- registry checks ---

  it("test_cline_registered_in_filters", () => {
    const names = new Set(bc.FILTERS.map((f) => f.name));
    expect(names.has("cline")).toBe(true);
  });

  it("test_cline_in_all_exports", () => {
    expect(bc.__all__.includes("ClineFilter")).toBe(true);
  });

  it("test_dispatch_routes_cline", () => {
    const result = bc.detect_from_command("cline --task 'refactor auth.py'");
    expect(result).not.toBeNull();
    const [f, _argv] = result!;
    expect(f.name).toBe("cline");
  });
});
