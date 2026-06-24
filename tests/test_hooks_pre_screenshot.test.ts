/**
 * Tests for the pre_screenshot hook handler (T3 — MCP screenshot deny-redirect).
 *
 * 1:1 port of tests/test_hooks_pre_screenshot.py. The handler explains the
 * redirect in terms of the image-shrink Read path (now ported), so this suite
 * is live.
 *
 * Parity notes (Python -> TS):
 *  - hooks_cli.pre_screenshot resolves (via Python module __getattr__) to the
 *    bare hooks_read.pre_screenshot handler; the TS port calls
 *    hooks_read.pre_screenshot directly.
 *  - hook_helpers.assert_continue / assert_deny are reproduced inline.
 *    assert_continue only asserts continue===true (deny is ALSO a fail-soft
 *    continue:true response, so the "pass through" tests assert the fail-soft
 *    contract, not the absence of a deny). assert_deny additionally checks
 *    hookSpecificOutput.permissionDecision === "deny".
 *  - pre_screenshot is SYNC in the TS port (no image encode on this path).
 *  - monkeypatch.setattr(config, "load", patched_load) -> vi.spyOn(config,
 *    "load").mockReturnValue(...). hooks_read reads `import * as config`, so the
 *    spy is observed. The disabled-config copy starts from the real defaults and
 *    flips image_shrink.screenshot_redirect to false.
 *  - tmp_data_dir autouse fixture -> tests/setup.ts (global setupFiles).
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import * as hooks_read from "../src/token_goat/hooks_read.js";
import * as config from "../src/token_goat/config.js";
import type { HookPayload } from "../src/token_goat/types.js";
import type { ConfigSchema } from "../src/token_goat/types.js";

// hooks_cli.pre_screenshot (Python) -> the bare hooks_read.pre_screenshot.
const pre_screenshot = hooks_read.pre_screenshot;

// ---------------------------------------------------------------------------
// Shared helpers (ports of hook_helpers).
// ---------------------------------------------------------------------------

/** Verbatim port of hook_helpers.assert_continue. */
function _assert_continue(result: Record<string, unknown>): void {
  expect(result["continue"]).toBe(true);
}

/** Verbatim port of hook_helpers.assert_deny. */
function _assert_deny(result: Record<string, unknown>): void {
  expect(result["continue"]).toBe(true);
  const hso = (result["hookSpecificOutput"] as Record<string, unknown> | undefined) ?? {};
  expect(hso["permissionDecision"]).toBe("deny");
}

/** Concatenate additionalContext + " " + permissionDecisionReason (the Python helper). */
function _denyOutput(result: Record<string, unknown>): string {
  const hso = (result["hookSpecificOutput"] as Record<string, unknown> | undefined) ?? {};
  const ctx = (hso["additionalContext"] as string | undefined) ?? "";
  const reason = (hso["permissionDecisionReason"] as string | undefined) ?? "";
  return `${ctx} ${reason}`;
}

afterEach(() => {
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// MCP screenshot calls without filePath are denied with a redirect.
// ---------------------------------------------------------------------------

describe("TestPreScreenshotDenyWithoutFilePath", () => {
  it("test_chrome_devtools_screenshot_denied", () => {
    const payload: HookPayload = {
      tool_name: "mcp__plugin_chrome-devtools-mcp_chrome-devtools__take_screenshot",
      tool_input: {},
    };
    const result = pre_screenshot(payload);
    _assert_deny(result as Record<string, unknown>);
  });

  it("test_playwright_screenshot_denied", () => {
    const payload: HookPayload = {
      tool_name: "mcp__plugin_playwright_playwright__browser_take_screenshot",
      tool_input: { type: "png" },
    };
    const result = pre_screenshot(payload);
    _assert_deny(result as Record<string, unknown>);
  });

  it("test_deny_message_mentions_file_path", () => {
    const payload: HookPayload = {
      tool_name: "mcp__plugin_chrome-devtools-mcp_chrome-devtools__take_screenshot",
      tool_input: {},
    };
    const result = pre_screenshot(payload);
    _assert_deny(result as Record<string, unknown>);
    const output = _denyOutput(result as Record<string, unknown>);
    expect(output.includes("filePath") || output.includes("file_path")).toBe(true);
  });

  it("test_deny_message_mentions_both_param_variants", () => {
    // Deny message must show both "filePath" (chrome-devtools) and "filename" (playwright).
    const payload: HookPayload = {
      tool_name: "mcp__plugin_playwright_playwright__browser_take_screenshot",
      tool_input: {},
    };
    const result = pre_screenshot(payload);
    _assert_deny(result as Record<string, unknown>);
    const output = _denyOutput(result as Record<string, unknown>);
    expect(output.includes("filePath")).toBe(true);
    expect(output.includes("filename")).toBe(true);
  });

  it("test_deny_message_mentions_image_shrink", () => {
    const payload: HookPayload = {
      tool_name: "mcp__plugin_playwright_playwright__browser_take_screenshot",
      tool_input: {},
    };
    const result = pre_screenshot(payload);
    _assert_deny(result as Record<string, unknown>);
    const output = _denyOutput(result as Record<string, unknown>).toLowerCase();
    // Message should explain the redirect to image-shrink path.
    expect(output.includes("image") || output.includes("compress") || output.includes("shrink")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// MCP screenshot calls that already include filePath are allowed through.
// ---------------------------------------------------------------------------

describe("TestPreScreenshotAllowWithFilePath", () => {
  it("test_chrome_devtools_with_file_path_allowed", () => {
    const payload: HookPayload = {
      tool_name: "mcp__plugin_chrome-devtools-mcp_chrome-devtools__take_screenshot",
      tool_input: { filePath: "/tmp/shot.png" },
    };
    const result = pre_screenshot(payload);
    _assert_continue(result as Record<string, unknown>);
  });

  it("test_playwright_with_filename_allowed", () => {
    // Playwright uses "filename", not "filePath" — this is the critical escape path.
    const payload: HookPayload = {
      tool_name: "mcp__plugin_playwright_playwright__browser_take_screenshot",
      tool_input: { filename: "/tmp/shot.png", type: "png" },
    };
    const result = pre_screenshot(payload);
    _assert_continue(result as Record<string, unknown>);
  });

  it("test_playwright_file_path_also_accepted", () => {
    // filePath is accepted for all tools as a belt-and-suspenders fallback.
    const payload: HookPayload = {
      tool_name: "mcp__plugin_playwright_playwright__browser_take_screenshot",
      tool_input: { filePath: "/tmp/shot.png", type: "png" },
    };
    const result = pre_screenshot(payload);
    _assert_continue(result as Record<string, unknown>);
  });

  it("test_snake_case_file_path_allowed", () => {
    // Some MCP variants may use file_path instead of filePath.
    const payload: HookPayload = {
      tool_name: "mcp__plugin_chrome-devtools-mcp_chrome-devtools__take_screenshot",
      tool_input: { file_path: "/tmp/shot.png" },
    };
    const result = pre_screenshot(payload);
    _assert_continue(result as Record<string, unknown>);
  });
});

// ---------------------------------------------------------------------------
// Non-screenshot MCP tools and standard tools are unaffected.
// ---------------------------------------------------------------------------

describe("TestPreScreenshotNonScreenshotTools", () => {
  it("test_read_tool_passes_through", () => {
    const payload: HookPayload = {
      tool_name: "Read",
      tool_input: { file_path: "some_file.txt" },
    };
    const result = pre_screenshot(payload);
    _assert_continue(result as Record<string, unknown>);
  });

  it("test_bash_tool_passes_through", () => {
    const payload: HookPayload = {
      tool_name: "Bash",
      tool_input: { command: "ls" },
    };
    const result = pre_screenshot(payload);
    _assert_continue(result as Record<string, unknown>);
  });

  it("test_mcp_navigate_passes_through", () => {
    const payload: HookPayload = {
      tool_name: "mcp__plugin_chrome-devtools-mcp_chrome-devtools__navigate_page",
      tool_input: { url: "https://example.com" },
    };
    const result = pre_screenshot(payload);
    _assert_continue(result as Record<string, unknown>);
  });

  it("test_empty_payload_passes_through", () => {
    const result = pre_screenshot({} as HookPayload);
    _assert_continue(result as Record<string, unknown>);
  });
});

// ---------------------------------------------------------------------------
// When screenshot_redirect is disabled in config, all calls pass through.
// ---------------------------------------------------------------------------

describe("TestPreScreenshotConfigDisabled", () => {
  it("test_disabled_config_passes_through", () => {
    const base = config.load();
    const patched: ConfigSchema = {
      ...base,
      image_shrink: { ...(base.image_shrink ?? {}), screenshot_redirect: false },
    };
    vi.spyOn(config, "load").mockReturnValue(patched);

    const payload: HookPayload = {
      tool_name: "mcp__plugin_chrome-devtools-mcp_chrome-devtools__take_screenshot",
      tool_input: {},
    };
    const result = pre_screenshot(payload);
    _assert_continue(result as Record<string, unknown>);
  });
});
