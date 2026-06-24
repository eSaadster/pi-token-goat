/**
 * Tests for hooks_fetch.ts — Drive / WebFetch pre-fetch interception + post-fetch
 * caching + MCP dedup.
 *
 * Faithful port of:
 *   - tests/test_hooks_fetch.py
 *   - tests/test_hooks_pre_fetch.py
 *
 * Port notes:
 *  - Python calls hooks_cli.pre_fetch(payload) directly (sync). In TS the bare
 *    handlers live on hooks_fetch (the module dispatch resolves lazily). The
 *    direct-call tests call hooks_fetch.pre_fetch / post_fetch; a small set of
 *    dispatcher-integration tests route through hooks_cli.dispatch("pre-fetch",
 *    ...) (async) to exercise the fail_soft wrapping contract.
 *  - gdrive / webfetch are now PORTED (Layer 7 leaf batch); the hooks_fetch
 *    seams default to the REAL modules (the resume.ts default-to-real pattern).
 *    compact's get_context_pressure is still unported → null-default. These
 *    tests STILL inject faithful fakes via _setGdriveModule / _setWebfetchModule
 *    / _setGetContextPressure because the no-creds / malicious-id / fail-soft
 *    scenarios are impractical to trigger against the real modules (real gdrive
 *    needs Google creds; real webfetch makes network calls). The real-module
 *    image/dedup/allow-deny paths are exercised in test_hooks_webfetch.test.ts.
 *    The Python `patch("google.auth.default", ...)` becomes a fake
 *    gdrive.get_credentials that throws (no-creds) or returns (creds-present),
 *    and a faithful _validate_file_id mirroring the real gdrive validation.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

import * as hooks_fetch from "../src/token_goat/hooks_fetch.js";
import * as hooks_cli from "../src/token_goat/hooks_cli.js";
import * as configMod from "../src/token_goat/config.js";
import * as session from "../src/token_goat/session.js";
import * as util from "../src/token_goat/util.js";
import type { ConfigSchema } from "../src/token_goat/types.js";

// ---------------------------------------------------------------------------
// Faithful fake gdrive — mirrors the real gdrive validation surface.
// ---------------------------------------------------------------------------

const TEXT_EXTENSIONS = [".md", ".markdown", ".mdown", ".mkd", ".mkdn", ".txt"];

function makeGdrive(opts: { creds?: boolean } = {}): {
  _validate_file_id(file_id: string): void;
  get_credentials(): unknown;
  is_text_path(path: string): boolean;
} {
  const hasCreds = opts.creds ?? true;
  return {
    _validate_file_id(file_id: string): void {
      if (typeof file_id !== "string" || !file_id.trim()) {
        throw new Error("file_id cannot be empty or whitespace-only");
      }
      const stripped = file_id.trim();
      if (stripped.length > 128) {
        throw new Error(`file_id too long (max 128 chars): ${stripped.length}`);
      }
      if (stripped.includes("/") || stripped.includes("\\") || stripped.includes("..")) {
        throw new Error(`file_id contains invalid characters: ${stripped}`);
      }
      for (const c of stripped) {
        const isAlnum = /[a-zA-Z0-9]/.test(c);
        if (!isAlnum && c !== "-" && c !== "_") {
          throw new Error(`file_id contains invalid characters: ${stripped}`);
        }
      }
    },
    get_credentials(): unknown {
      if (!hasCreds) {
        throw new Error("No Google Drive credentials available");
      }
      return {};
    },
    is_text_path(path: string): boolean {
      const lower = path.toLowerCase();
      const dot = lower.lastIndexOf(".");
      const suffix = dot >= 0 ? lower.slice(dot) : "";
      return TEXT_EXTENSIONS.includes(suffix);
    },
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function _assert_continue(result: Record<string, unknown>): void {
  expect(result["continue"]).toBe(true);
}

function _assert_deny(result: Record<string, unknown>): void {
  const hso = (result["hookSpecificOutput"] ?? {}) as Record<string, unknown>;
  expect(hso["permissionDecision"]).toBe("deny");
}

/** Crude str(dict) analogue: stringify enough to do substring asserts. */
function asText(result: unknown): string {
  return JSON.stringify(result);
}

function makeDrivePayload(file_id: string, name?: string): Record<string, unknown> {
  const tool_input: Record<string, unknown> = { file_id };
  if (name !== undefined) {
    tool_input["name"] = name;
  }
  return {
    tool_name: "mcp__claude_ai_Google_Drive__download_file_content",
    tool_input,
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  hooks_fetch._setGdriveModule(null);
  hooks_fetch._setWebfetchModule(null);
  hooks_fetch._setGetContextPressure(null);
});

// ===========================================================================
// test_hooks_fetch.py — Drive markdown hints
// ===========================================================================

describe("TestDriveInterceptMarkdownHint", () => {
  beforeEach(() => {
    hooks_fetch._setGdriveModule(makeGdrive({ creds: true }));
  });

  it("markdown filename adds sections hint", () => {
    const resp = hooks_fetch.pre_fetch(makeDrivePayload("file_abc", "spec.md"));
    const text = asText(resp);
    expect(text).toContain("gdrive-sections file_abc");
    expect(text).toContain("gdrive-fetch file_abc");
  });

  it("non-markdown filename: no sections hint", () => {
    const resp = hooks_fetch.pre_fetch(makeDrivePayload("file_abc", "photo.jpg"));
    const text = asText(resp);
    expect(text).not.toContain("gdrive-sections");
    expect(text).toContain("gdrive-fetch file_abc");
  });

  it("missing filename: no sections hint", () => {
    const resp = hooks_fetch.pre_fetch(makeDrivePayload("file_abc"));
    const text = asText(resp);
    expect(text).not.toContain("gdrive-sections");
    expect(text).toContain("gdrive-fetch file_abc");
  });

  it("no creds continues without intercept", () => {
    hooks_fetch._setGdriveModule(makeGdrive({ creds: false }));
    // get_credentials throws => propagates out of pre_fetch (caller fail_soft).
    expect(() => hooks_fetch.pre_fetch(makeDrivePayload("file_abc", "spec.md"))).toThrow();
  });

  it("overlong filename rejected: no hint", () => {
    const longName = "a".repeat(999) + ".md";
    const resp = hooks_fetch.pre_fetch(makeDrivePayload("file_abc", longName));
    const text = asText(resp);
    expect(text).not.toContain("gdrive-sections");
    expect(text).toContain("gdrive-fetch file_abc");
  });

  it("non-string filename rejected: no hint", () => {
    const payload = makeDrivePayload("file_abc");
    (payload["tool_input"] as Record<string, unknown>)["name"] = 42;
    const resp = hooks_fetch.pre_fetch(payload);
    const text = asText(resp);
    expect(text).not.toContain("gdrive-sections");
    expect(text).toContain("gdrive-fetch file_abc");
  });
});

describe("TestDriveInterceptFileId", () => {
  beforeEach(() => {
    hooks_fetch._setGdriveModule(makeGdrive({ creds: true }));
  });

  it("invalid file_id continues", () => {
    const resp = hooks_fetch.pre_fetch(makeDrivePayload("../etc/passwd"));
    const text = asText(resp);
    expect(text).not.toContain("gdrive-fetch");
    _assert_continue(resp);
  });

  it("empty file_id continues", () => {
    const payload = {
      tool_name: "mcp__claude_ai_Google_Drive__download_file_content",
      tool_input: {},
    };
    const resp = hooks_fetch.pre_fetch(payload);
    const text = asText(resp);
    expect(text).not.toContain("gdrive-fetch");
    _assert_continue(resp);
  });
});

// ===========================================================================
// test_hooks_fetch.py — WebFetch allow/deny
// ===========================================================================

describe("TestWebFetchAllowDeny", () => {
  function webfetchPayload(url: string): Record<string, unknown> {
    return { tool_name: "WebFetch", tool_input: { url } };
  }

  function withConfig(cfg: Partial<ConfigSchema>): void {
    vi.spyOn(configMod, "load").mockReturnValue(makeFullConfig(cfg));
  }

  it("no restrictions allows any url", () => {
    withConfig({});
    const resp = hooks_fetch.pre_fetch(webfetchPayload("https://example.com/page"));
    const text = asText(resp).toLowerCase();
    expect(resp["continue"] === true || !text.includes("allow")).toBe(true);
  });

  it("deny pattern blocks url", () => {
    withConfig({ webfetch: { allow: [], deny: ["https://evil.com/*"] } });
    const resp = hooks_fetch.pre_fetch(webfetchPayload("https://evil.com/malware"));
    const text = asText(resp).toLowerCase();
    expect(text.includes("deny") || text.includes("blocked")).toBe(true);
  });

  it("deny pattern does not block non-matching url", () => {
    withConfig({ webfetch: { allow: [], deny: ["https://evil.com/*"] } });
    const resp = hooks_fetch.pre_fetch(webfetchPayload("https://good.com/page"));
    expect(resp["continue"]).toBe(true);
  });

  it("allow list blocks unlisted url", () => {
    withConfig({ webfetch: { allow: ["https://trusted.org/*"], deny: [] } });
    const resp = hooks_fetch.pre_fetch(webfetchPayload("https://untrusted.io/page"));
    const text = asText(resp).toLowerCase();
    expect(text.includes("allow") || text.includes("blocked")).toBe(true);
  });

  it("allow list permits matching url", () => {
    withConfig({ webfetch: { allow: ["https://trusted.org/*"], deny: [] } });
    const resp = hooks_fetch.pre_fetch(webfetchPayload("https://trusted.org/docs"));
    expect(resp["continue"]).toBe(true);
  });

  it("deny checked before allow", () => {
    withConfig({
      webfetch: { allow: ["https://example.com/*"], deny: ["https://example.com/bad*"] },
    });
    const resp = hooks_fetch.pre_fetch(webfetchPayload("https://example.com/badpath"));
    const text = asText(resp).toLowerCase();
    expect(text.includes("deny") || text.includes("blocked")).toBe(true);
  });
});

// ===========================================================================
// test_hooks_fetch.py — WebFetch dedup deny (pressure-gated)
// ===========================================================================

describe("TestWebFetchDedupDeny", () => {
  function webfetchPayload(url: string, prompt: unknown = ""): Record<string, unknown> {
    return {
      tool_name: "WebFetch",
      session_id: "dedup-deny-session",
      tool_input: { url, prompt },
    };
  }

  function makeEntry(ageSeconds = 60, bodyBytes = 50_000): session.WebEntry {
    return new session.WebEntry({
      url_sha: "abc123",
      url_preview: "https://example.com/docs",
      output_id: "out_abc123456",
      ts: Date.now() / 1000 - ageSeconds,
      body_bytes: bodyBytes,
      status_code: 200,
    });
  }

  function setPressure(tier: string): void {
    hooks_fetch._setGetContextPressure(() => ({ tier }));
  }

  beforeEach(() => {
    // empty allow/deny so _check_url_allowdeny is a no-op
    vi.spyOn(configMod, "load").mockReturnValue(makeFullConfig({}));
  });

  it("deny fires at warm pressure with fresh cached entry", () => {
    vi.spyOn(session, "lookup_web_entry").mockReturnValue(makeEntry());
    setPressure("warm");
    const resp = hooks_fetch.pre_fetch(webfetchPayload("https://example.com/docs"));
    const text = asText(resp);
    expect(text.includes("cached body available") || text.includes("re-fetch blocked")).toBe(true);
    expect(text).toContain("web-output");
  });

  it("no deny at cool pressure", () => {
    vi.spyOn(session, "lookup_web_entry").mockReturnValue(makeEntry());
    setPressure("cool");
    const resp = hooks_fetch.pre_fetch(webfetchPayload("https://example.com/docs"));
    const hso = (resp["hookSpecificOutput"] ?? {}) as Record<string, unknown>;
    expect(hso["permissionDecision"] !== "deny" || !asText(resp).includes("cached body")).toBe(
      true,
    );
  });

  for (const prompt of [
    "refresh the page content",
    "get the latest version",
    "reload and summarize",
    "check the updated schema",
    "retry the fetch",
  ]) {
    it(`no deny when bypass keyword in prompt: ${prompt}`, () => {
      vi.spyOn(session, "lookup_web_entry").mockReturnValue(makeEntry());
      setPressure("warm");
      const resp = hooks_fetch.pre_fetch(webfetchPayload("https://example.com/docs", prompt));
      const hso = (resp["hookSpecificOutput"] ?? {}) as Record<string, unknown>;
      expect(hso["permissionDecision"] !== "deny" || !asText(resp).includes("cached body")).toBe(
        true,
      );
    });
  }

  it("no deny when entry is stale", async () => {
    const hints = await import("../src/token_goat/hints.js");
    const stale = makeEntry(hints.STALE_READ_AGE_SECONDS + 60);
    vi.spyOn(session, "lookup_web_entry").mockReturnValue(stale);
    setPressure("warm");
    const resp = hooks_fetch.pre_fetch(webfetchPayload("https://example.com/docs"));
    const hso = (resp["hookSpecificOutput"] ?? {}) as Record<string, unknown>;
    expect(hso["permissionDecision"] !== "deny" || !asText(resp).includes("cached body")).toBe(
      true,
    );
  });

  it("no deny when no cached entry", () => {
    vi.spyOn(session, "lookup_web_entry").mockReturnValue(null);
    setPressure("warm");
    const resp = hooks_fetch.pre_fetch(webfetchPayload("https://example.com/new"));
    const hso = (resp["hookSpecificOutput"] ?? {}) as Record<string, unknown>;
    expect(hso["permissionDecision"] !== "deny" || !asText(resp).includes("cached body")).toBe(
      true,
    );
  });

  it("deny fires at hot pressure", () => {
    vi.spyOn(session, "lookup_web_entry").mockReturnValue(makeEntry());
    setPressure("hot");
    const resp = hooks_fetch.pre_fetch(webfetchPayload("https://example.com/docs"));
    const text = asText(resp);
    expect(text.includes("re-fetch blocked") || text.includes("cached body available")).toBe(true);
  });

  it("no deny when output_id is empty", () => {
    const bad = new session.WebEntry({
      url_sha: "abc123",
      url_preview: "https://example.com/docs",
      output_id: "",
      ts: Date.now() / 1000 - 30,
      body_bytes: 50_000,
      status_code: 200,
    });
    vi.spyOn(session, "lookup_web_entry").mockReturnValue(bad);
    setPressure("warm");
    const resp = hooks_fetch.pre_fetch(webfetchPayload("https://example.com/docs"));
    const hso = (resp["hookSpecificOutput"] ?? {}) as Record<string, unknown>;
    expect(hso["permissionDecision"] !== "deny" || !asText(resp).includes("cached body")).toBe(
      true,
    );
  });

  it("no deny when session cache raises", () => {
    vi.spyOn(session, "lookup_web_entry").mockImplementation(() => {
      throw new Error("cache corrupt");
    });
    setPressure("warm");
    const resp = hooks_fetch.pre_fetch(webfetchPayload("https://example.com/docs"));
    const hso = (resp["hookSpecificOutput"] ?? {}) as Record<string, unknown>;
    expect(hso["permissionDecision"] !== "deny" || !asText(resp).includes("cached body")).toBe(
      true,
    );
  });

  for (const badPrompt of [{ text: "refresh" }, 0, [], null] as unknown[]) {
    it(`non-string prompt does not raise: ${JSON.stringify(badPrompt)}`, () => {
      vi.spyOn(session, "lookup_web_entry").mockReturnValue(makeEntry());
      setPressure("warm");
      const payload = {
        tool_name: "WebFetch",
        session_id: "dedup-deny-session",
        tool_input: { url: "https://example.com/docs", prompt: badPrompt },
      };
      const resp = hooks_fetch.pre_fetch(payload);
      expect(typeof resp).toBe("object");
    });
  }

  it("deny context contains web-output command", () => {
    vi.spyOn(session, "lookup_web_entry").mockReturnValue(makeEntry());
    setPressure("warm");
    const resp = hooks_fetch.pre_fetch(webfetchPayload("https://example.com/docs"));
    const hso = (resp["hookSpecificOutput"] ?? {}) as Record<string, unknown>;
    const context = String(hso["additionalContext"] ?? "");
    expect(context).toContain("web-output");
    expect(context.includes("--grep") || context.includes("--section")).toBe(true);
  });
});

// ===========================================================================
// test_hooks_fetch.py — WebFetch size hint (post_fetch)
// ===========================================================================

describe("TestWebSizeHint", () => {
  let debugSpy: ReturnType<typeof vi.spyOn>;
  let messages: string[];

  beforeEach(() => {
    messages = [];
    const log = util.getLogger("hooks_fetch");
    debugSpy = vi.spyOn(log, "debug").mockImplementation((msg: string) => {
      messages.push(msg);
    });
  });

  afterEach(() => {
    debugSpy.mockRestore();
  });

  it("size hint emitted for large response", () => {
    const body = "X".repeat(12 * 1024);
    const payload = {
      session_id: "size-hint-1",
      tool_name: "WebFetch",
      tool_input: { url: "https://example.com/large-doc" },
      tool_response: { output: body, status_code: 200 },
    };
    hooks_fetch.post_fetch(payload);
    expect(messages.some((m) => m.includes("web_size_hint"))).toBe(true);
  });

  it("no size hint for small response", () => {
    const body = "X".repeat(8 * 1024);
    const payload = {
      session_id: "size-hint-2",
      tool_name: "WebFetch",
      tool_input: { url: "https://example.com/small-doc" },
      tool_response: { output: body, status_code: 200 },
    };
    hooks_fetch.post_fetch(payload);
    expect(messages.some((m) => m.includes("web_size_hint"))).toBe(false);
  });

  it("size hint content correctness", () => {
    const body = "X".repeat(20 * 1024);
    const payload = {
      session_id: "size-hint-3",
      tool_name: "WebFetch",
      tool_input: { url: "https://example.com/doc" },
      tool_response: { output: body, status_code: 200 },
    };
    hooks_fetch.post_fetch(payload);
    const hintMsgs = messages.filter((m) => m.includes("web_size_hint"));
    expect(hintMsgs.length).toBeGreaterThan(0);
    const msg = hintMsgs[0]!;
    expect(msg.includes("20.0 KB") || msg.includes("20 KB")).toBe(true);
    expect(msg.toLowerCase()).toContain("tokens");
    expect(msg).toContain("--grep");
  });
});

// ===========================================================================
// test_hooks_pre_fetch.py — non-Drive / no-creds / deny / malicious ids
// ===========================================================================

describe("TestPreFetchNonDriveTool", () => {
  it("non-drive tool passes through", () => {
    const result = hooks_fetch.pre_fetch({
      tool_name: "Read",
      tool_input: { file_path: "some_file.txt" },
    });
    _assert_continue(result);
    expect("hookSpecificOutput" in result).toBe(false);
  });

  it("bash tool passes through", () => {
    const result = hooks_fetch.pre_fetch({ tool_name: "Bash", tool_input: { command: "ls" } });
    _assert_continue(result);
  });

  it("empty payload passes through", () => {
    const result = hooks_fetch.pre_fetch({});
    _assert_continue(result);
  });
});

describe("TestPreFetchDriveNoCreds", () => {
  beforeEach(() => {
    hooks_fetch._setGdriveModule(makeGdrive({ creds: false }));
  });

  it("drive download no creds passes through (dispatch fail_soft)", async () => {
    const payload = {
      tool_name: "mcp__claude_ai_Google_Drive__download_file_content",
      tool_input: { file_id: "abc123" },
    };
    // get_credentials throws; the dispatcher's fail_soft converts to continue.
    const result = await hooks_cli.dispatch("pre-fetch", payload);
    _assert_continue(result);
    expect("hookSpecificOutput" in result).toBe(false);
  });

  it("drive read_file no creds passes through (dispatch fail_soft)", async () => {
    const payload = {
      tool_name: "mcp__claude_ai_Google_Drive__read_file_content",
      tool_input: { file_id: "xyz789" },
    };
    const result = await hooks_cli.dispatch("pre-fetch", payload);
    _assert_continue(result);
  });
});

describe("TestPreFetchDriveWithCreds", () => {
  beforeEach(() => {
    hooks_fetch._setGdriveModule(makeGdrive({ creds: true }));
  });

  it("download tool with file_id gets denied", () => {
    const result = hooks_fetch.pre_fetch({
      tool_name: "mcp__claude_ai_Google_Drive__download_file_content",
      tool_input: { file_id: "testfile123" },
    });
    _assert_deny(result);
    const hso = (result["hookSpecificOutput"] ?? {}) as Record<string, unknown>;
    expect(String(hso["additionalContext"])).toContain("token-goat gdrive-fetch testfile123");
  });

  it("read_file tool with file_id gets denied", () => {
    const result = hooks_fetch.pre_fetch({
      tool_name: "mcp__claude_ai_Google_Drive__read_file_content",
      tool_input: { file_id: "readfile456" },
    });
    _assert_deny(result);
    const hso = (result["hookSpecificOutput"] ?? {}) as Record<string, unknown>;
    expect(String(hso["additionalContext"])).toContain("token-goat gdrive-fetch readfile456");
  });

  it("additional context mentions cached path hint", () => {
    const result = hooks_fetch.pre_fetch({
      tool_name: "mcp__claude_ai_Google_Drive__download_file_content",
      tool_input: { file_id: "img001" },
    });
    const hso = (result["hookSpecificOutput"] ?? {}) as Record<string, unknown>;
    const ctx = String(hso["additionalContext"] ?? "");
    expect(ctx).toContain("Read");
    expect(ctx).toContain("auto-shrunk");
  });

  it("hook event name is correct", () => {
    const result = hooks_fetch.pre_fetch({
      tool_name: "mcp__claude_ai_Google_Drive__download_file_content",
      tool_input: { file_id: "evt001" },
    });
    const hso = (result["hookSpecificOutput"] ?? {}) as Record<string, unknown>;
    expect(hso["hookEventName"]).toBe("PreToolUse");
  });

  it("file_id from fileId field", () => {
    const result = hooks_fetch.pre_fetch({
      tool_name: "mcp__claude_ai_Google_Drive__download_file_content",
      tool_input: { fileId: "camel001" },
    });
    const hso = (result["hookSpecificOutput"] ?? {}) as Record<string, unknown>;
    expect(hso["permissionDecision"]).toBe("deny");
    expect(String(hso["additionalContext"])).toContain("camel001");
  });
});

describe("TestPreFetchDriveNoFileId", () => {
  beforeEach(() => {
    hooks_fetch._setGdriveModule(makeGdrive({ creds: true }));
  });

  it("drive tool no file_id passes through", () => {
    const result = hooks_fetch.pre_fetch({
      tool_name: "mcp__claude_ai_Google_Drive__download_file_content",
      tool_input: { something_else: "value" },
    });
    _assert_continue(result);
    expect("hookSpecificOutput" in result).toBe(false);
  });

  it("drive tool empty tool_input passes through", () => {
    const result = hooks_fetch.pre_fetch({
      tool_name: "mcp__claude_ai_Google_Drive__download_file_content",
      tool_input: {},
    });
    _assert_continue(result);
  });
});

describe("TestPreFetchMaliciousFileId", () => {
  beforeEach(() => {
    hooks_fetch._setGdriveModule(makeGdrive({ creds: true }));
  });

  function deniedFor(file_id: string): Record<string, unknown> {
    return hooks_fetch.pre_fetch({
      tool_name: "mcp__claude_ai_Google_Drive__download_file_content",
      tool_input: { file_id },
    });
  }

  it("backtick injection passes through", () => {
    _assert_continue(deniedFor("`evil`"));
  });

  it("command substitution passes through", () => {
    _assert_continue(deniedFor("$(rm -rf /)"));
  });

  it("path traversal passes through", () => {
    _assert_continue(deniedFor("../../etc/passwd"));
  });

  it("null byte passes through", () => {
    _assert_continue(deniedFor("abc\x00def"));
  });

  it("newline injection passes through", () => {
    _assert_continue(deniedFor("abc\necho injected"));
  });

  it("too long id passes through", () => {
    _assert_continue(deniedFor("a".repeat(200)));
  });

  it("valid alphanumeric id still denied", () => {
    const result = deniedFor("ValidFile123-abc");
    const hso = (result["hookSpecificOutput"] ?? {}) as Record<string, unknown>;
    expect(hso["permissionDecision"]).toBe("deny");
    expect(String(hso["additionalContext"])).toContain("ValidFile123-abc");
  });
});

describe("TestPreFetchDispatcher", () => {
  it("dispatch pre-fetch non-drive tool", async () => {
    const result = await hooks_cli.dispatch("pre-fetch", {
      tool_name: "Write",
      tool_input: { file_path: "x.py" },
    });
    _assert_continue(result);
  });

  it("dispatch pre-fetch drive with creds denies", async () => {
    hooks_fetch._setGdriveModule(makeGdrive({ creds: true }));
    const result = await hooks_cli.dispatch("pre-fetch", {
      tool_name: "mcp__claude_ai_Google_Drive__download_file_content",
      tool_input: { file_id: "dispatch_test_id" },
    });
    const hso = (result["hookSpecificOutput"] ?? {}) as Record<string, unknown>;
    expect(hso["permissionDecision"]).toBe("deny");
  });

  it("crash in handler returns continue", async () => {
    // gdrive.get_credentials throws -> dispatch fail_soft must yield continue:true.
    const gd = makeGdrive({ creds: true });
    gd.get_credentials = () => {
      throw new Error("boom");
    };
    hooks_fetch._setGdriveModule(gd);
    const result = await hooks_cli.dispatch("pre-fetch", {
      tool_name: "mcp__claude_ai_Google_Drive__download_file_content",
      tool_input: { file_id: "crash_test" },
    });
    expect(result["continue"]).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Config builder: a fully-populated ConfigSchema with overrides applied.
// ---------------------------------------------------------------------------

function makeFullConfig(overrides: Partial<ConfigSchema>): ConfigSchema {
  const base = configMod.load();
  return {
    ...base,
    ...overrides,
    webfetch: { ...base.webfetch, ...(overrides.webfetch ?? {}) },
    hints: { ...base.hints, ...(overrides.hints ?? {}) },
  };
}
