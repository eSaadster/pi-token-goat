/**
 * Tests for the WebFetch intercept in pre_fetch — Phase 14.
 *
 * Faithful port of tests/test_hooks_webfetch.py.
 *
 * Port notes:
 *  - Like test_hooks_fetch.test.ts, the direct-call tests invoke
 *    hooks_fetch.pre_fetch (sync) rather than hooks_cli.pre_fetch; the behaviour
 *    is identical (hooks_cli only routes). Python's tmp_data_dir fixture → the
 *    suite's per-file setDataDir (tests/setup.ts).
 *  - gdrive/webfetch are now PORTED and the hooks_fetch seams default to the
 *    REAL modules (resume.ts pattern). The image-URL / non-image / dedup tests
 *    therefore exercise the REAL webfetch.is_image_url + the real session
 *    dedup path — no fake is injected. (test_hooks_fetch.test.ts still injects
 *    fakes via _setGdriveModule/_setWebfetchModule where it needs no-creds or
 *    malicious-id behaviour.)
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import * as hooks_fetch from "../src/token_goat/hooks_fetch.js";
import * as configMod from "../src/token_goat/config.js";
import * as session from "../src/token_goat/session.js";
import * as web_cache from "../src/token_goat/web_cache.js";
import { short_output_id } from "../src/token_goat/cache_common.js";
import type { ConfigSchema, HookPayload } from "../src/token_goat/types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function _assertContinue(result: Record<string, unknown>): void {
  expect(result["continue"]).toBe(true);
}

function _assertDeny(result: Record<string, unknown>): void {
  const hso = (result["hookSpecificOutput"] ?? {}) as Record<string, unknown>;
  expect(hso["permissionDecision"]).toBe("deny");
}

function additionalContext(result: Record<string, unknown>): string {
  const hso = (result["hookSpecificOutput"] ?? {}) as Record<string, unknown>;
  return typeof hso["additionalContext"] === "string"
    ? (hso["additionalContext"] as string)
    : "";
}

function webfetchPayload(
  url: string,
  opts: { session_id?: string; prompt?: unknown } = {},
): Record<string, unknown> {
  const tool_input: Record<string, unknown> = {};
  if (url !== undefined) {
    tool_input["url"] = url;
  }
  if (opts.prompt !== undefined) {
    tool_input["prompt"] = opts.prompt;
  }
  const payload: Record<string, unknown> = {
    tool_name: "WebFetch",
    tool_input,
  };
  if (opts.session_id !== undefined) {
    payload["session_id"] = opts.session_id;
  }
  return payload;
}

afterEach(() => {
  vi.restoreAllMocks();
});

// ===========================================================================
// 10. pre_fetch with WebFetch on image URL → deny + additionalContext
// ===========================================================================

describe("TestPreFetchWebFetchImageUrl", () => {
  it("image url gets denied", () => {
    const result = hooks_fetch.pre_fetch(
      webfetchPayload("https://example.com/photo.jpg"),
    ) as Record<string, unknown>;
    _assertDeny(result);
  });

  it("additional context mentions fetch-image", () => {
    const url = "https://cdn.example.com/banner.png";
    const result = hooks_fetch.pre_fetch(webfetchPayload(url)) as Record<
      string,
      unknown
    >;
    const ctx = additionalContext(result);
    expect(ctx).toContain("token-goat fetch-image");
    expect(ctx).toContain(url);
  });

  it("hook event name is correct", () => {
    const result = hooks_fetch.pre_fetch(
      webfetchPayload("https://example.com/img.webp"),
    ) as Record<string, unknown>;
    const hso = (result["hookSpecificOutput"] ?? {}) as Record<string, unknown>;
    expect(hso["hookEventName"]).toBe("PreToolUse");
  });

  it("context mentions read", () => {
    const result = hooks_fetch.pre_fetch(
      webfetchPayload("https://example.com/photo.avif"),
    ) as Record<string, unknown>;
    expect(additionalContext(result)).toContain("Read");
  });

  it("permission decision reason set", () => {
    const result = hooks_fetch.pre_fetch(
      webfetchPayload("https://example.com/img.gif"),
    ) as Record<string, unknown>;
    const hso = (result["hookSpecificOutput"] ?? {}) as Record<string, unknown>;
    expect(hso["permissionDecisionReason"]).toBeTruthy();
  });
});

// ===========================================================================
// 11. pre_fetch with WebFetch on non-image URL → continue:true, no deny
// ===========================================================================

describe("TestPreFetchWebFetchNonImageUrl", () => {
  it("html url passes through", () => {
    const result = hooks_fetch.pre_fetch(
      webfetchPayload("https://example.com/page.html"),
    ) as Record<string, unknown>;
    _assertContinue(result);
    expect(result["hookSpecificOutput"]).toBeUndefined();
  });

  it("json url passes through", () => {
    const result = hooks_fetch.pre_fetch(
      webfetchPayload("https://api.example.com/data.json"),
    ) as Record<string, unknown>;
    _assertContinue(result);
  });

  it("bare domain url passes through", () => {
    const result = hooks_fetch.pre_fetch(
      webfetchPayload("https://example.com/"),
    ) as Record<string, unknown>;
    _assertContinue(result);
  });
});

// ===========================================================================
// 12. pre_fetch with WebFetch and missing url → continue:true
// ===========================================================================

describe("TestPreFetchWebFetchNoUrl", () => {
  it("missing url field", () => {
    const result = hooks_fetch.pre_fetch({
      tool_name: "WebFetch",
      tool_input: { prompt: "what is this page about?" },
    }) as Record<string, unknown>;
    _assertContinue(result);
  });

  it("empty tool_input", () => {
    const result = hooks_fetch.pre_fetch({
      tool_name: "WebFetch",
      tool_input: {},
    }) as Record<string, unknown>;
    _assertContinue(result);
  });

  it("none tool_input", () => {
    // tool_input is null at runtime (get_tool_input handles it); the type is
    // stricter than Python's, so cast through unknown.
    const result = hooks_fetch.pre_fetch({
      tool_name: "WebFetch",
      tool_input: null,
    } as unknown as HookPayload) as Record<string, unknown>;
    _assertContinue(result);
  });
});

// ===========================================================================
// 13. pre_fetch with WebFetch on previously-fetched URL → dedup hint injected
// ===========================================================================

const _DEDUP_URL = "https://docs.example.com/api/reference";
const _LARGE_BODY_BYTES = 5000; // above the web-dedup min-bytes threshold

/** Record a web fetch in the session cache and return the output_id. */
function _seedWebSession(
  sid: string,
  bodyBytes: number = _LARGE_BODY_BYTES,
): string {
  const urlSha = web_cache.url_hash(_DEDUP_URL);
  const outputId = `${sid.slice(0, 16)}-0000000099999-${urlSha}`;
  session.mark_web_fetch(
    sid,
    urlSha,
    _DEDUP_URL,
    outputId,
    bodyBytes,
    200,
    false,
  );
  return outputId;
}

describe("TestPreFetchWebFetchDedup", () => {
  it("cache hit injects hint", () => {
    const sid = "dedup-test-session";
    const outputId = _seedWebSession(sid);
    const result = hooks_fetch.pre_fetch(
      webfetchPayload(_DEDUP_URL, { session_id: sid }),
    ) as Record<string, unknown>;
    expect(result["continue"]).toBe(true);
    const ctx = additionalContext(result);
    // Hint renders the short id (…<last8>), not the full output_id.
    expect(ctx).toContain(short_output_id(outputId));
    expect(ctx).toContain("token-goat web-output");
  });

  it("cache hit hint mentions age", () => {
    const sid = "dedup-test-session";
    _seedWebSession(sid);
    const result = hooks_fetch.pre_fetch(
      webfetchPayload(_DEDUP_URL, { session_id: sid }),
    ) as Record<string, unknown>;
    const ctx = additionalContext(result);
    // Age-suffix concept (Ns inside parens), not the exact wording.
    expect(ctx).toMatch(/\(\d+s\):/);
  });

  it("cache hit hint mentions byte size", () => {
    const sid = "dedup-test-session";
    _seedWebSession(sid);
    const result = hooks_fetch.pre_fetch(
      webfetchPayload(_DEDUP_URL, { session_id: sid }),
    ) as Record<string, unknown>;
    expect(additionalContext(result)).toContain("B");
  });

  it("cache miss passes through", () => {
    const result = hooks_fetch.pre_fetch(
      webfetchPayload("https://new.example.com/never-fetched", {
        session_id: "dedup-test-session",
      }),
    ) as Record<string, unknown>;
    _assertContinue(result);
    expect(result["hookSpecificOutput"]).toBeUndefined();
  });

  it("no session id passes through", () => {
    const result = hooks_fetch.pre_fetch(
      webfetchPayload(_DEDUP_URL),
    ) as Record<string, unknown>;
    _assertContinue(result);
  });

  it("small body no hint", () => {
    const sid = "dedup-small-session";
    _seedWebSession(sid, 100); // below the dedup threshold
    const result = hooks_fetch.pre_fetch(
      webfetchPayload(_DEDUP_URL, { session_id: sid }),
    ) as Record<string, unknown>;
    _assertContinue(result);
    expect(result["hookSpecificOutput"]).toBeUndefined();
  });

  it("image url still denied not dedup", () => {
    // Image URLs must take the image-redirect path, not the dedup path.
    const imgUrl = "https://example.com/photo.jpg";
    const sid = "dedup-test-session";
    const urlSha = web_cache.url_hash(imgUrl);
    session.mark_web_fetch(sid, urlSha, imgUrl, "img-output-001", 50000, 200, false);
    const result = hooks_fetch.pre_fetch(
      webfetchPayload(imgUrl, { session_id: sid }),
    ) as Record<string, unknown>;
    _assertDeny(result);
    expect(additionalContext(result)).toContain("token-goat fetch-image");
  });

  it("hint does not start with note", () => {
    const sid = "dedup-test-session";
    _seedWebSession(sid);
    const result = hooks_fetch.pre_fetch(
      webfetchPayload(_DEDUP_URL, { session_id: sid }),
    ) as Record<string, unknown>;
    const ctx = additionalContext(result);
    expect(ctx.length).toBeGreaterThan(0);
    expect(ctx.startsWith("Note:")).toBe(false);
  });
});

// ===========================================================================
// _check_url_allowdeny unit tests
// ===========================================================================

describe("TestCheckUrlAllowDeny", () => {
  /** Call _check_url_allowdeny with config.load() patched to { webfetch: {allow, deny} }. */
  function invoke(
    url: string,
    opts: { allow?: string[]; deny?: string[] } = {},
  ): Record<string, unknown> | null {
    const cfg = {
      webfetch: { allow: opts.allow ?? [], deny: opts.deny ?? [] },
    } as unknown as ConfigSchema;
    vi.spyOn(configMod, "load").mockReturnValue(cfg);
    return hooks_fetch._check_url_allowdeny(url) as Record<string, unknown> | null;
  }

  it("no lists passes everything", () => {
    expect(invoke("https://example.com/page")).toBeNull();
  });

  it("deny match blocks url", () => {
    const result = invoke("https://evil.com/bad", { deny: ["*evil.com*"] });
    expect(result).not.toBeNull();
    const hso = (result!["hookSpecificOutput"] ?? {}) as Record<string, unknown>;
    const reason = String(hso["permissionDecisionReason"] ?? "").toLowerCase();
    expect(reason.includes("deny") || reason.includes("block")).toBe(true);
  });

  it("deny match takes priority over allow", () => {
    const result = invoke("https://example.com/path", {
      deny: ["*example.com*"],
      allow: ["*example.com*"],
    });
    expect(result).not.toBeNull();
  });

  it("allow match passes url", () => {
    const result = invoke("https://docs.python.org/3/", {
      allow: ["*docs.python.org*"],
    });
    expect(result).toBeNull();
  });

  it("allow miss blocks url", () => {
    const result = invoke("https://random-site.io/", {
      allow: ["*docs.python.org*"],
    });
    expect(result).not.toBeNull();
    const hso = (result!["hookSpecificOutput"] ?? {}) as Record<string, unknown>;
    expect(String(hso["permissionDecisionReason"] ?? "").toLowerCase()).toContain(
      "allow",
    );
  });

  it("empty deny nonempty allow passes matching", () => {
    expect(
      invoke("https://github.com/foo", { allow: ["*github.com*"] }),
    ).toBeNull();
  });

  it("empty deny nonempty allow blocks nonmatching", () => {
    const result = invoke("https://example.com/", { allow: ["*github.com*"] });
    expect(result).not.toBeNull();
  });

  it("deny non match passes", () => {
    expect(
      invoke("https://safe.com/page", { deny: ["*evil.com*"] }),
    ).toBeNull();
  });
});
