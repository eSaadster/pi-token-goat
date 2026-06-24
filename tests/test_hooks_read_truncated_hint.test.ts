/**
 * Tests for the truncated-read advisory hint injected by post_read.
 *
 * 1:1 port of tests/test_hooks_read_truncated_hint.py.
 *
 * Test-seam mapping (Python -> TS):
 *  - patch("token_goat.hooks_read.get_hook_context", ...)
 *  - patch("token_goat.hooks_read.load_session_safe", ...)
 *      get_hook_context / load_session_safe are imported into hooks_read from
 *      hooks_common and called as bare references (NOT through `self`), so the
 *      spy must target the hooks_common module namespace — that is the exact
 *      binding hooks_read resolves at call time (ESM live binding = Python's
 *      "patch the name in the module that LOOKS IT UP").
 *  - patch("token_goat.hooks_read._get_session" / "._check_ignored_hint" /
 *    "._read_is_windowed" / "._try_snapshot" / "._is_memory_file", ...)
 *      these are hooks_read's OWN module-level functions, invoked through the
 *      `self` self-namespace import, so we spy on the hooks_read namespace.
 *  - session.mark_file_read / session.save run for real against the Python
 *    MagicMock cache (the Python test does not patch them). Here the fake cache
 *    is a plain object, so we stub mark_file_read/save to inert no-ops; neither
 *    affects the truncated-read path under test.
 *  - monkeypatch.setenv(TOKEN_GOAT_BASH_COMPRESS, ...)
 *      direct process.env assignment; setup.ts snapshots/restores env per test.
 *  - patch.object(cfg_mod, "load", return_value=mock_cfg)
 *      spy on the config module namespace's load(); post_read calls
 *      config.load() through that namespace.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import * as hr from "../src/token_goat/hooks_read.js";
import * as hooksCommon from "../src/token_goat/hooks_common.js";
import * as session from "../src/token_goat/session.js";
import * as config from "../src/token_goat/config.js";
import type { HookPayload, HookResponse } from "../src/token_goat/types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface FakeCache {
  observed_tool_tokens: number;
  recent_hints: Record<string, unknown>;
  hints_ignored: Record<string, unknown>;
}

function makePayload(
  filePath: string,
  respText: string,
  offset?: number,
  limit?: number,
): HookPayload {
  const toolInput: Record<string, unknown> = { file_path: filePath };
  if (offset !== undefined) {
    toolInput["offset"] = offset;
  }
  if (limit !== undefined) {
    toolInput["limit"] = limit;
  }
  return {
    tool_name: "Read",
    tool_input: toolInput,
    tool_response: respText,
    session_id: "test-session-id",
    cwd: "/tmp",
  } as unknown as HookPayload;
}

/**
 * Install the common spies that stub out session/cache so only the
 * truncated-read path matters. Returns a teardown not needed (vi.restoreAllMocks
 * in afterEach handles it) and the fake cache for inspection.
 */
function installCommonSpies(): FakeCache {
  const fakeCache: FakeCache = {
    observed_tool_tokens: 0,
    recent_hints: {},
    hints_ignored: {},
  };
  const fakeSession = {} as unknown;

  vi.spyOn(hooksCommon, "get_hook_context").mockReturnValue(["sess-1", "/tmp"]);
  vi.spyOn(hr, "_get_session").mockReturnValue(fakeSession as ReturnType<typeof hr._get_session>);
  vi.spyOn(hooksCommon, "load_session_safe").mockReturnValue(
    fakeCache as unknown as ReturnType<typeof hooksCommon.load_session_safe>,
  );
  vi.spyOn(hr, "_check_ignored_hint").mockImplementation(() => undefined);
  vi.spyOn(hr, "_read_is_windowed").mockReturnValue(true);
  vi.spyOn(hr, "_try_snapshot").mockImplementation(() => undefined);
  vi.spyOn(hr, "_is_memory_file").mockReturnValue(false);

  // The Python test runs mark_file_read/save against a MagicMock; here we keep
  // them inert so the plain fake cache is not mutated by real session logic.
  vi.spyOn(session, "mark_file_read").mockImplementation(
    () => fakeCache as unknown as ReturnType<typeof session.mark_file_read>,
  );
  vi.spyOn(session, "save").mockImplementation(() => undefined);

  return fakeCache;
}

function runPostReadNoSession(payload: HookPayload): HookResponse {
  installCommonSpies();
  return hr.post_read(payload);
}

const PARTIAL_NOTICE_1500 = "File content here.\n(lines 1-200 of 1500)\nMore content.";
const PARTIAL_NOTICE_EN_DASH = "File content.\nlines 1–200 of 1500\nEnd.";
const PARTIAL_NOTICE_TO_FORM = "File content.\n(showing lines 1 to 200 of 1500)\nEnd.";

beforeEach(() => {
  // The truncated-read path is gated on TOKEN_GOAT_BASH_COMPRESS not being a
  // disable value. setup.ts pins HARNESS/NO_WORKER_SPAWN but leaves this unset;
  // ensure a clean (enabled) baseline for every test that does not set it.
  delete process.env["TOKEN_GOAT_BASH_COMPRESS"];
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// _detect_partial_read unit tests
// ---------------------------------------------------------------------------

describe("TestDetectPartialRead", () => {
  it("test_hyphen_form", () => {
    expect(hr._detect_partial_read("Showing lines 1-200 of 1500 total.")).toEqual([1, 200, 1500]);
  });

  it("test_en_dash_form", () => {
    expect(hr._detect_partial_read("lines 1–200 of 900")).toEqual([1, 200, 900]);
  });

  it("test_to_form", () => {
    expect(hr._detect_partial_read("(showing lines 1 to 200 of 1500)")).toEqual([1, 200, 1500]);
  });

  it("test_case_insensitive", () => {
    expect(hr._detect_partial_read("Lines 50-300 of 2000")).toEqual([50, 300, 2000]);
  });

  it("test_no_sentinel", () => {
    expect(hr._detect_partial_read("normal file content, no partial notice")).toBeNull();
  });

  it("test_empty_string", () => {
    expect(hr._detect_partial_read("")).toBeNull();
  });

  it("test_mid_offset_range", () => {
    expect(hr._detect_partial_read("lines 400-600 of 3000")).toEqual([400, 600, 3000]);
  });
});

// ---------------------------------------------------------------------------
// post_read integration tests
// ---------------------------------------------------------------------------

describe("TestTruncatedHintInjected", () => {
  it("test_hint_injected_on_partial_read", () => {
    const payload = makePayload("/project/src/big_file.py", PARTIAL_NOTICE_1500);
    const result = runPostReadNoSession(payload);
    expect(result.continue).toBe(true);
    const msg = result.systemMessage ?? "";
    expect(msg).toContain("[token-goat]");
    expect(msg).toContain("1500");
  });

  it("test_hint_contains_section_command", () => {
    const payload = makePayload("/project/src/big_file.py", PARTIAL_NOTICE_1500);
    const result = runPostReadNoSession(payload);
    expect(result.systemMessage ?? "").toContain("token-goat section");
  });

  it("test_hint_contains_skeleton_command", () => {
    const payload = makePayload("/project/src/big_file.py", PARTIAL_NOTICE_1500);
    const result = runPostReadNoSession(payload);
    expect(result.systemMessage ?? "").toContain("token-goat skeleton");
  });

  it("test_hint_contains_read_command", () => {
    const payload = makePayload("/project/src/big_file.py", PARTIAL_NOTICE_1500);
    const result = runPostReadNoSession(payload);
    expect(result.systemMessage ?? "").toContain("token-goat read");
  });

  it("test_en_dash_sentinel_triggers_hint", () => {
    const payload = makePayload("/project/src/big_file.py", PARTIAL_NOTICE_EN_DASH);
    const result = runPostReadNoSession(payload);
    expect(result.systemMessage ?? "").toContain("token-goat section");
  });

  it("test_to_form_sentinel_triggers_hint", () => {
    const payload = makePayload("/project/src/big_file.py", PARTIAL_NOTICE_TO_FORM);
    const result = runPostReadNoSession(payload);
    expect(result.systemMessage ?? "").toContain("token-goat section");
  });

  it("test_hint_includes_file_path", () => {
    const payload = makePayload("/project/src/big_file.py", PARTIAL_NOTICE_1500);
    const result = runPostReadNoSession(payload);
    expect(result.systemMessage ?? "").toContain("/project/src/big_file.py");
  });
});

describe("TestTruncatedHintSkipped", () => {
  it("test_no_partial_sentinel_no_hint", () => {
    const payload = makePayload(
      "/project/src/big_file.py",
      "Normal file content without any partial notice.",
    );
    const result = runPostReadNoSession(payload);
    const sm = result.systemMessage ?? "";
    expect(sm).not.toContain("token-goat section");
  });

  it("test_full_file_start_equals_end_no_hint", () => {
    // start=1, end=1500, total=1500 -> full file, skip
    const payload = makePayload("/project/src/big_file.py", "lines 1-1500 of 1500");
    const result = runPostReadNoSession(payload);
    expect(result.systemMessage ?? "").not.toContain("token-goat section");
  });

  it("test_total_at_min_threshold_no_hint", () => {
    // Z=200, default threshold=200 -> Z <= min_lines, skip
    const payload = makePayload("/project/src/small.py", "lines 1-100 of 200");
    const result = runPostReadNoSession(payload);
    expect(result.systemMessage ?? "").not.toContain("token-goat section");
  });

  it("test_total_below_min_threshold_no_hint", () => {
    // Z=50 -> well below threshold
    const payload = makePayload("/project/src/tiny.py", "lines 1-25 of 50");
    const result = runPostReadNoSession(payload);
    expect(result.systemMessage ?? "").not.toContain("token-goat section");
  });

  const binaryAndImageExts = [
    ".png", ".jpg", ".jpeg", ".gif", ".ico",
    ".pdf", ".zip", ".tar", ".gz", ".exe",
    ".dll", ".so", ".dylib", ".woff", ".ttf", ".eot",
  ];
  it.each(binaryAndImageExts)("test_binary_and_image_extensions_no_hint[%s]", (ext) => {
    const payload = makePayload(`/project/assets/file${ext}`, PARTIAL_NOTICE_1500);
    const result = runPostReadNoSession(payload);
    expect(result.systemMessage ?? "").not.toContain("token-goat section");
  });

  it("test_bash_compress_disabled_no_hint", () => {
    process.env["TOKEN_GOAT_BASH_COMPRESS"] = "0";
    const payload = makePayload("/project/src/big_file.py", PARTIAL_NOTICE_1500);
    const result = runPostReadNoSession(payload);
    expect(result.systemMessage ?? "").not.toContain("token-goat section");
  });

  const disableVariants = ["false", "no", "off", "False", "NO"];
  it.each(disableVariants)("test_bash_compress_disabled_variants_no_hint[%s]", (val) => {
    process.env["TOKEN_GOAT_BASH_COMPRESS"] = val;
    const payload = makePayload("/project/src/big_file.py", PARTIAL_NOTICE_1500);
    const result = runPostReadNoSession(payload);
    expect(result.systemMessage ?? "").not.toContain("token-goat section");
  });

  it("test_bash_compress_enabled_no_suppression", () => {
    // Explicitly set to "1" (enabled) -> hint should still fire
    process.env["TOKEN_GOAT_BASH_COMPRESS"] = "1";
    const payload = makePayload("/project/src/big_file.py", PARTIAL_NOTICE_1500);
    const result = runPostReadNoSession(payload);
    expect(result.systemMessage ?? "").toContain("token-goat section");
  });
});

describe("TestTruncatedHintConfigMinLines", () => {
  it("test_custom_min_lines_suppresses_hint", () => {
    // Z=500 but min_lines=600 -> skip
    const payload = makePayload("/project/src/big_file.py", "lines 1-200 of 500");
    const mockCfg = {
      hints: { truncated_read_min_lines: 600 },
    } as unknown as ReturnType<typeof config.load>;
    installCommonSpies();
    vi.spyOn(config, "load").mockReturnValue(mockCfg);
    const result = hr.post_read(payload);
    expect(result.systemMessage ?? "").not.toContain("token-goat section");
  });

  it("test_custom_min_lines_allows_hint", () => {
    // Z=1500, min_lines=100 -> hint fires
    const payload = makePayload("/project/src/big_file.py", PARTIAL_NOTICE_1500);
    const mockCfg = {
      hints: { truncated_read_min_lines: 100 },
    } as unknown as ReturnType<typeof config.load>;
    installCommonSpies();
    vi.spyOn(config, "load").mockReturnValue(mockCfg);
    const result = hr.post_read(payload);
    expect(result.systemMessage ?? "").toContain("token-goat section");
  });
});
