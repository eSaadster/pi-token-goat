/**
 * 1:1 port of tests/test_hooks_common.py.
 *
 * Covers extract_tool_response_text, run_dedup_hint, record_hint_stat_pair,
 * _is_quiet_hours, denormalize_response, normalize_payload, load_session_safe,
 * and record_cached_stat — plus the three string/int guards (sanitize_log_str,
 * sanitize_opt, is_real_int) carried over from the Layer 2 partial.
 *
 * Deferred (it.skip) cases are those that import a not-yet-ported module:
 *  - hints.ReadHint / hints.CHARS_PER_TOKEN  → token_goat/hints not ported.
 *    record_hint_stat_pair / structured_file_hint / run_dedup_hint-emit tests
 *    depend on it (record_hint_stat_pair calls bytes_to_tokens, whose
 *    CHARS_PER_TOKEN normally lives in hints).
 *  - hooks_cli.denormalize_response / normalize_payload → token_goat/hooks_cli
 *    not ported.
 *
 * Spy conventions (per the porting plan):
 *  - monkeypatch.setattr(_session, "load", …) → vi.spyOn(session, "load").
 *  - monkeypatch.setattr(_db, "record_stat", …) → vi.spyOn(db, "recordStat").
 *  - monkeypatch.setattr(_config, "load", …)   → vi.spyOn(config, "load").
 *  - patch("datetime.datetime") → vi.useFakeTimers()/setSystemTime for _is_quiet_hours.
 *  - caplog is unused here; non-string sanitize_opt path is not asserted on.
 *
 * tests/setup.ts isolates the data dir + clears module caches before each test,
 * so the watchdog module-globals and config cache start fresh every time.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import * as db from "../src/token_goat/db.js";
import * as session from "../src/token_goat/session.js";
import * as config from "../src/token_goat/config.js";
import { ReadHint } from "../src/token_goat/hints.js";
import { record_hint_stat_pair } from "../src/token_goat/hooks_common.js";
import { denormalize_response, normalize_payload } from "../src/token_goat/hooks_cli.js";
import {
  _BIDI_CONTROLS,
  _is_quiet_hours,
  extract_tool_response_text,
  is_real_int,
  load_session_safe,
  record_cached_stat,
  run_dedup_hint,
  sanitize_log_str,
  sanitize_opt,
} from "../src/token_goat/hooks_common.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function _payload(tool_response: unknown): Record<string, unknown> {
  return { session_id: "s1", tool_name: "Bash", tool_response };
}

// ---------------------------------------------------------------------------
// Shape 1: tool_response is a bare string
// ---------------------------------------------------------------------------

describe("extract_tool_response_text — shapes", () => {
  it("test_bare_string", () => {
    const payload = _payload("hello world\n");
    expect(extract_tool_response_text(payload)).toBe("hello world\n");
  });

  it("test_empty_string", () => {
    const payload = _payload("");
    expect(extract_tool_response_text(payload)).toBe("");
  });

  // -------------------------------------------------------------------------
  // Shape 2: tool_response is an MCP content array (list at top level)
  // -------------------------------------------------------------------------

  it("test_mcp_array_typed_text", () => {
    const items = [
      { type: "text", text: "line 1\n" },
      { type: "text", text: "line 2\n" },
    ];
    const payload = _payload(items);
    expect(extract_tool_response_text(payload)).toBe("line 1\nline 2\n");
  });

  it("test_mcp_array_bare_strings", () => {
    const payload = _payload(["part A", "part B"]);
    expect(extract_tool_response_text(payload)).toBe("part Apart B");
  });

  it("test_mcp_array_skips_non_text_typed_items", () => {
    const items = [
      { type: "image", text: "should be skipped" },
      { type: "text", text: "kept" },
    ];
    const result = extract_tool_response_text(_payload(items));
    expect(result).toContain("kept");
    expect(result).not.toContain("should be skipped");
  });

  it("test_mcp_array_no_type_key_included", () => {
    // Items that omit the type field entirely (older harnesses) are included.
    const items = [{ text: "legacy item" }, { type: "text", text: "typed item" }];
    const result = extract_tool_response_text(_payload(items));
    expect(result).toContain("legacy item");
    expect(result).toContain("typed item");
  });

  it("test_mcp_array_empty", () => {
    const payload = _payload([]);
    expect(extract_tool_response_text(payload)).toBe("");
  });

  // -------------------------------------------------------------------------
  // Shape 3: tool_response is a dict with named fields
  // -------------------------------------------------------------------------

  it("test_dict_stdout_key", () => {
    const payload = _payload({ stdout: "output here", exit_code: 0 });
    // Default text_keys don't include "stdout"; pass explicit keys like bash does.
    const result = extract_tool_response_text(payload, {
      text_keys: ["stdout", "output", "text"],
    });
    expect(result).toBe("output here");
  });

  it("test_dict_output_key", () => {
    const payload = _payload({ output: "fetched body", status_code: 200 });
    expect(extract_tool_response_text(payload)).toBe("fetched body");
  });

  it("test_dict_text_key", () => {
    const payload = _payload({ text: "plain text body" });
    expect(extract_tool_response_text(payload)).toBe("plain text body");
  });

  it("test_dict_body_key", () => {
    const payload = _payload({ body: "response body" });
    expect(extract_tool_response_text(payload)).toBe("response body");
  });

  it("test_dict_content_key_string", () => {
    const payload = _payload({ content: "content string" });
    expect(extract_tool_response_text(payload)).toBe("content string");
  });

  it("test_dict_content_key_mcp_array", () => {
    // content value is itself an MCP array — should concatenate.
    const items = [
      { type: "text", text: "A" },
      { type: "text", text: "B" },
    ];
    const payload = _payload({ content: items });
    expect(extract_tool_response_text(payload)).toBe("AB");
  });

  it("test_dict_prefers_first_matching_key", () => {
    // output wins over text when both are present.
    const payload = _payload({ output: "first", text: "second" });
    expect(extract_tool_response_text(payload)).toBe("first");
  });

  // -------------------------------------------------------------------------
  // Fallback: tool_result / response keys instead of tool_response
  // -------------------------------------------------------------------------

  it("test_tool_result_fallback", () => {
    const payload = { session_id: "s1", tool_result: "from tool_result" };
    expect(extract_tool_response_text(payload)).toBe("from tool_result");
  });

  it.each([["string", ""], ["list", []], ["dict", {}]] as Array<[string, unknown]>)(
    "test_empty_tool_result_does_not_fall_back[%s]",
    (_label, tool_result) => {
      const payload = { session_id: "s1", tool_result, response: "fallback" };
      expect(extract_tool_response_text(payload)).toBe("");
    },
  );

  it("test_response_fallback", () => {
    const payload = { session_id: "s1", response: "from response key" };
    expect(extract_tool_response_text(payload)).toBe("from response key");
  });

  // -------------------------------------------------------------------------
  // Missing / malformed payloads
  // -------------------------------------------------------------------------

  it("test_missing_tool_response", () => {
    const payload = { session_id: "s1", tool_name: "Bash" };
    expect(extract_tool_response_text(payload)).toBe("");
  });

  it("test_none_tool_response", () => {
    const payload = _payload(null);
    expect(extract_tool_response_text(payload)).toBe("");
  });

  it("test_non_dict_payload", () => {
    // Should not raise; returns empty string.
    expect(extract_tool_response_text(null)).toBe("");
    expect(extract_tool_response_text("not a dict" as unknown as null)).toBe("");
  });

  it("test_integer_tool_response", () => {
    // Unexpected type — returns "" (not coerced via str()).
    const payload = _payload(42);
    expect(extract_tool_response_text(payload)).toBe("");
  });

  // -------------------------------------------------------------------------
  // custom text_keys ordering
  // -------------------------------------------------------------------------

  it("test_custom_text_keys_ordering", () => {
    // Caller can pass a different key order; first match wins.
    const payload = _payload({ body: "body text", output: "output text" });
    const result = extract_tool_response_text(payload, { text_keys: ["body", "output"] });
    expect(result).toBe("body text");
  });
});

// ---------------------------------------------------------------------------
// run_dedup_hint
// ---------------------------------------------------------------------------

function _sid_payload(session_id: string, tool_name = "Bash"): Record<string, unknown> {
  return { session_id, tool_name, tool_input: {} };
}

/** Minimal hint object with tokens_saved and toString / length. */
class _FakeHint {
  private _text: string;
  tokens_saved: number;
  constructor(text: string, tokens_saved = 10) {
    this._text = text;
    this.tokens_saved = tokens_saved;
  }
  toString(): string {
    return this._text;
  }
  get length(): number {
    return this._text.length;
  }
}

describe("run_dedup_hint", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("test_run_dedup_hint_returns_none_when_builder_returns_none", () => {
    // Builder returning null → run_dedup_hint returns null (no hint injected).
    const fake_cache = {} as never;

    vi.spyOn(session, "load").mockImplementation(() => fake_cache);
    vi.spyOn(session, "save").mockImplementation(() => undefined);

    // Patch db.recordStat to no-op so no DB is needed.
    vi.spyOn(db, "recordStat").mockImplementation(() => undefined);

    const payload = _sid_payload("test-no-hint");
    const result = run_dedup_hint(payload, {
      builder: () => null,
      stat_kind: "bash_dedup_hint",
      detail: "pytest",
    });
    expect(result).toBeNull();
  });

  it("test_run_dedup_hint_returns_context_when_builder_returns_hint", () => {
    // Builder returning a hint → response with additionalContext set.
    const fake_cache = {} as never;

    vi.spyOn(session, "load").mockImplementation(() => fake_cache);
    vi.spyOn(session, "save").mockImplementation(() => undefined);
    vi.spyOn(db, "recordStat").mockImplementation(() => undefined);

    const hint = new _FakeHint("reuse cached output (bash_dedup)", 20);

    const payload = _sid_payload("test-hint-injected");
    const result = run_dedup_hint(payload, {
      builder: () => hint as unknown as null,
      stat_kind: "bash_dedup_hint",
      detail: "pytest --tb=short",
    }) as Record<string, unknown> | null;
    expect(result).not.toBeNull();
    expect((result as Record<string, unknown>)["continue"]).toBe(true);
    const hso = ((result as Record<string, unknown>)["hookSpecificOutput"] ?? {}) as Record<string, unknown>;
    expect(String(hso["additionalContext"] ?? "").includes("reuse cached output")).toBe(true);
  });

  it("test_run_dedup_hint_returns_none_when_no_session_id", () => {
    // Missing session_id in payload → returns null without touching session.
    const payload = { tool_name: "Bash", tool_input: {} }; // no session_id
    const result = run_dedup_hint(payload, {
      builder: () => new _FakeHint("should not appear"),
      stat_kind: "bash_dedup_hint",
      detail: "cmd",
    });
    expect(result).toBeNull();
  });

  it("test_run_dedup_hint_returns_none_on_session_load_error", () => {
    // OSError from session.load → returns null (fail-soft).
    vi.spyOn(session, "load").mockImplementation(() => {
      throw new Error("disk full");
    });

    const payload = _sid_payload("test-load-error");
    const result = run_dedup_hint(payload, {
      builder: () => new _FakeHint("irrelevant"),
      stat_kind: "bash_dedup_hint",
      detail: "cmd",
    });
    expect(result).toBeNull();
  });

  it("test_run_dedup_hint_builder_receives_session_id_and_cache", () => {
    // Builder is called with the correct (session_id, cache) arguments.
    const fake_cache = {} as never;
    const captured: { sid?: string; cache?: unknown } = {};

    vi.spyOn(session, "load").mockImplementation(() => fake_cache);
    vi.spyOn(session, "save").mockImplementation(() => undefined);
    vi.spyOn(db, "recordStat").mockImplementation(() => undefined);

    const _builder = (sid: string, cache: unknown): _FakeHint => {
      captured.sid = sid;
      captured.cache = cache;
      return new _FakeHint("hint text");
    };

    const payload = _sid_payload("test-builder-args");
    run_dedup_hint(payload, {
      builder: _builder as unknown as () => null,
      stat_kind: "grep_dedup_hint",
      detail: "pat",
    });

    expect(captured.sid).toBe("test-builder-args");
    expect(captured.cache).toBe(fake_cache);
  });

  it("test_run_dedup_hint_saves_cache_when_hint_emitted", () => {
    // run_dedup_hint must call session.save(cache) when the builder returns a hint.
    const fake_cache = {} as never;
    const save_calls: unknown[] = [];

    vi.spyOn(session, "load").mockImplementation(() => fake_cache);
    vi.spyOn(session, "save").mockImplementation((c) => {
      save_calls.push(c);
    });
    vi.spyOn(db, "recordStat").mockImplementation(() => undefined);

    const payload = _sid_payload("test-save-on-emit");
    const result = run_dedup_hint(payload, {
      builder: () => new _FakeHint("cached result", 50) as unknown as null,
      stat_kind: "bash_dedup_hint",
      detail: "cmd",
    });

    expect(result, "hint must be emitted").not.toBeNull();
    expect(save_calls.length, "session.save must be called once when hint is emitted").toBe(1);
    expect(save_calls[0], "session.save must receive the same cache object").toBe(fake_cache);
  });

  it("test_run_dedup_hint_saves_cache_when_builder_returns_none", () => {
    // run_dedup_hint must call session.save even when builder returns null.
    const fake_cache = {} as never;
    const save_calls: unknown[] = [];

    vi.spyOn(session, "load").mockImplementation(() => fake_cache);
    vi.spyOn(session, "save").mockImplementation((c) => {
      save_calls.push(c);
    });

    const payload = _sid_payload("test-save-on-none");
    const result = run_dedup_hint(payload, {
      builder: () => null,
      stat_kind: "bash_dedup_hint",
      detail: "cmd",
    });

    expect(result).toBeNull();
    expect(save_calls.length).toBe(1);
    expect(save_calls[0]).toBe(fake_cache);
  });
});

// ---------------------------------------------------------------------------
// denormalize_response fast-path optimization
// ---------------------------------------------------------------------------

describe("denormalize_response", () => {
  it("test_denormalize_response_continue_only_claude", () => {
    // Response {continue: true} on Claude harness returns same dict (no copy).
    const resp: Record<string, unknown> = { continue: true };
    const result = denormalize_response(resp, "claude");
    expect(result).toBe(resp); // Same object, not a copy
  });

  it("test_denormalize_response_with_system_message_claude", () => {
    // Response with camelCase keys (Claude format) returns same dict on Claude harness.
    const resp: Record<string, unknown> = {
      continue: true,
      systemMessage: "test context",
      hookSpecificOutput: {},
    };
    const result = denormalize_response(resp, "claude");
    expect(result).toBe(resp);
  });

  it("test_denormalize_response_camel_case_no_hso", () => {
    // No hookSpecificOutput and no _tg_* keys → equivalent content, _tg_* would be stripped.
    const resp: Record<string, unknown> = { continue: true };
    const result = denormalize_response(resp, "codex");
    expect(result["continue"]).toBe(true);
    expect("hookSpecificOutput" in result).toBe(false);
  });

  it("test_denormalize_response_codex_preserves_camel_and_existing_snake", () => {
    // Codex 0.137.0+ uses camelCase — all keys pass through unchanged.
    const resp: Record<string, unknown> = {
      continue: true,
      hookSpecificOutput: {
        hook_event_name: "PreToolUse",
        additionalContext: "hint",
      },
    };
    const result = denormalize_response(resp, "codex");
    const hso = result["hookSpecificOutput"] as Record<string, unknown>;
    expect(hso["hook_event_name"]).toBe("PreToolUse");
    expect(hso["additionalContext"]).toBe("hint");
  });

  it("test_denormalize_response_mixed_keys_all_preserved", () => {
    // No translation occurs; both camelCase and any pre-existing snake_case pass through.
    const resp: Record<string, unknown> = {
      continue: true,
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        additional_context: "mixed",
      },
    };
    const result = denormalize_response(resp, "codex");
    const hso = result["hookSpecificOutput"] as Record<string, unknown>;
    expect(hso["hookEventName"]).toBe("PreToolUse");
    expect(hso["additional_context"]).toBe("mixed");
  });

  it("test_denormalize_response_updated_input_preserved_for_codex", () => {
    const resp: Record<string, unknown> = {
      continue: true,
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        updatedInput: { file_path: "/shrunk.png" },
        additionalContext: "image shrunk",
      },
    };
    const result = denormalize_response(resp, "codex");
    const hso = result["hookSpecificOutput"] as Record<string, unknown>;
    expect(hso["updatedInput"]).toEqual({ file_path: "/shrunk.png" });
    expect(hso["additionalContext"]).toBe("image shrunk");
    expect("updated_input" in hso).toBe(false);
    expect("additional_context" in hso).toBe(false);
  });

  it("test_denormalize_response_permission_decision_preserved_for_codex", () => {
    const resp: Record<string, unknown> = {
      continue: false,
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason: "blocked",
        additionalContext: "denied",
      },
    };
    const result = denormalize_response(resp, "codex");
    const hso = result["hookSpecificOutput"] as Record<string, unknown>;
    expect(hso["permissionDecision"]).toBe("deny");
    expect(hso["permissionDecisionReason"]).toBe("blocked");
    expect("permission_decision" in hso).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// record_hint_stat_pair: zero-saving guard and config gate
//
// Un-deferred: hints is now ported (ReadHint) and record_hint_stat_pair reads
// config.load() / db.recordStat() through the static `config` / `db` namespaces,
// so vi.spyOn(config, "load") / vi.spyOn(db, "recordStat") are observed.
//
// Seam mapping (Python → TS):
//   - patch("token_goat.db.record_stat")  → vi.spyOn(db, "recordStat").
//   - monkeypatch.setattr(config, "load", lambda: cfg) → vi.spyOn(config, "load").
//   - _config.Config() (default) → config.load() (full default ConfigSchema).
//   - cfg.stats = StatsConfig(record_zero_savings=True) → override cfg.stats.
//   - record_stat(project_hash, kind, ...) — kind is the 2nd positional arg →
//     recordStat(projectHash, kind, opts); kind is mock.calls[i][1].
//   - overhead row's bytes_saved kwarg → opts.bytesSaved (3rd-arg object).
// ---------------------------------------------------------------------------

/** A default ConfigSchema with optional stats override (Python _config.Config()). */
function _defaultCfg(record_zero_savings = false): ReturnType<typeof config.load> {
  const base = config.load();
  return {
    ...base,
    stats: { ...base.stats, record_zero_savings },
  };
}

describe("record_hint_stat_pair", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("test_record_hint_stat_pair_zero_savings_skips_writes", () => {
    // tokens_saved=0 and injection_bytes=0 should skip DB writes.
    const recordSpy = vi.spyOn(db, "recordStat").mockImplementation(() => undefined);
    vi.spyOn(config, "load").mockReturnValue(_defaultCfg());

    const hint = new ReadHint("", 0);
    record_hint_stat_pair("test_hint", hint, "detail");

    expect(recordSpy.mock.calls.length).toBe(0);
  });

  it("test_record_hint_stat_pair_nonzero_savings_writes", () => {
    // tokens_saved>0 should write both stat rows.
    const recordSpy = vi.spyOn(db, "recordStat").mockImplementation(() => undefined);
    vi.spyOn(config, "load").mockReturnValue(_defaultCfg());

    const hint = new ReadHint("x".repeat(40), 10);
    record_hint_stat_pair("test_hint", hint, "detail");

    expect(recordSpy.mock.calls.length).toBe(2);
  });

  it("test_record_hint_stat_pair_zero_savings_with_config_override", () => {
    // record_zero_savings=True should write zero-saving rows.
    const recordSpy = vi.spyOn(db, "recordStat").mockImplementation(() => undefined);
    vi.spyOn(config, "load").mockReturnValue(_defaultCfg(true));

    const hint = new ReadHint("", 0);
    record_hint_stat_pair("test_hint", hint, "detail");

    expect(recordSpy.mock.calls.length).toBe(2);
  });

  it("test_record_hint_stat_pair_small_injection_skips_overhead", () => {
    // injection_bytes < 32 skips overhead row; saving row written if tokens_saved > 0.
    const recordSpy = vi.spyOn(db, "recordStat").mockImplementation(() => undefined);
    vi.spyOn(config, "load").mockReturnValue(_defaultCfg());

    const hint = new ReadHint("short hint", 5);
    record_hint_stat_pair("test_hint", hint, "detail");

    expect(recordSpy.mock.calls.length).toBe(1);
    // kind is the 2nd positional arg of recordStat(projectHash, kind, ...).
    expect(recordSpy.mock.calls[0]![1]).toBe("test_hint");
  });

  it("test_record_hint_stat_pair_small_injection_zero_savings_skips_all", () => {
    // injection_bytes < 32 and tokens_saved = 0 skips both rows.
    const recordSpy = vi.spyOn(db, "recordStat").mockImplementation(() => undefined);
    vi.spyOn(config, "load").mockReturnValue(_defaultCfg());

    const hint = new ReadHint("tiny", 0);
    record_hint_stat_pair("test_hint", hint, "detail");

    expect(recordSpy.mock.calls.length).toBe(0);
  });

  it("test_record_hint_stat_pair_large_injection_writes_both", () => {
    // injection_bytes >= 32 writes both saving and overhead rows (if tokens > 0).
    const recordSpy = vi.spyOn(db, "recordStat").mockImplementation(() => undefined);
    vi.spyOn(config, "load").mockReturnValue(_defaultCfg());

    const hint = new ReadHint("x".repeat(40), 5);
    record_hint_stat_pair("test_hint", hint, "detail");

    expect(recordSpy.mock.calls.length).toBe(2);
    const kinds = recordSpy.mock.calls.map((c) => c[1]);
    expect(kinds.includes("test_hint")).toBe(true);
    expect(kinds.includes("test_hint_overhead")).toBe(true);
  });

  it("test_record_hint_stat_pair_counts_utf8_bytes", () => {
    // UTF-8 overhead should be counted in bytes, not characters.
    const recordSpy = vi.spyOn(db, "recordStat").mockImplementation(() => undefined);
    vi.spyOn(config, "load").mockReturnValue(_defaultCfg());

    const hint_text = "café".repeat(10);
    const hint = new ReadHint(hint_text, 10);
    record_hint_stat_pair("test_hint", hint, "detail");

    expect(recordSpy.mock.calls.length).toBe(2);
    // The overhead row is the 2nd call; its opts.bytesSaved is the negative byte count.
    const overheadOpts = recordSpy.mock.calls[1]![2] as { bytesSaved?: number };
    expect(overheadOpts.bytesSaved).toBe(-Buffer.byteLength(hint_text, "utf8"));
  });

  it("test_structured_file_hint_no_overhead_by_default", () => {
    // structured_file_hint is always tokens_saved=0 (advisory). By default
    // (record_zero_savings=False), no DB rows are written.
    const recordSpy = vi.spyOn(db, "recordStat").mockImplementation(() => undefined);
    const cfg = _defaultCfg();
    expect(cfg.stats!.record_zero_savings).toBe(false);
    vi.spyOn(config, "load").mockReturnValue(cfg);

    const hint = new ReadHint(
      '📄 large json (120KB) — use `token-goat read "file.json::Key.path"` or jq',
      0,
    );
    record_hint_stat_pair("structured_file_hint", hint, "file.json");

    expect(
      recordSpy.mock.calls.length,
      "structured_file_hint (tokens_saved=0) must not write saving or overhead rows when record_zero_savings=False",
    ).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// _is_quiet_hours
// ---------------------------------------------------------------------------

/** Call _is_quiet_hours with a fake current local time given as 'HH:MM'. */
function _quiet_hours_at(hhmm: string, quiet_hours: string): boolean {
  const h = Number(hhmm.slice(0, 2));
  const m = Number(hhmm.slice(3));
  // Mock the wall clock the same way the Python test patches datetime.datetime.
  vi.useFakeTimers();
  vi.setSystemTime(new Date(2026, 0, 1, h, m, 0, 0));
  try {
    return _is_quiet_hours(quiet_hours);
  } finally {
    vi.useRealTimers();
  }
}

describe("TestQuietHours", () => {
  it("test_empty_string_never_quiet", () => {
    expect(_is_quiet_hours("")).toBe(false);
  });

  it("test_malformed_string_never_quiet", () => {
    expect(_is_quiet_hours("not-a-time")).toBe(false);
    expect(_is_quiet_hours("25:00-26:00")).toBe(false);
    expect(_is_quiet_hours("9-17")).toBe(false);
  });

  it("test_normal_range_inside", () => {
    // Time clearly inside a normal (non-wrapping) range returns True.
    expect(_quiet_hours_at("14:30", "09:00-17:00")).toBe(true);
  });

  it("test_normal_range_outside_before", () => {
    // Time before the normal range returns False.
    expect(_quiet_hours_at("08:00", "09:00-17:00")).toBe(false);
  });

  it("test_normal_range_outside_after", () => {
    // Time after the normal range returns False.
    expect(_quiet_hours_at("18:00", "09:00-17:00")).toBe(false);
  });

  it("test_midnight_wrap_inside_evening", () => {
    // Time after start of midnight-crossing range (e.g. 23:00) returns True.
    expect(_quiet_hours_at("23:00", "22:00-07:00")).toBe(true);
  });

  it("test_midnight_wrap_inside_early_morning", () => {
    // Early morning inside midnight-crossing range returns True.
    expect(_quiet_hours_at("03:00", "22:00-07:00")).toBe(true);
  });

  it("test_midnight_wrap_outside", () => {
    // Time clearly outside a midnight-crossing range (noon) returns False.
    expect(_quiet_hours_at("12:00", "22:00-07:00")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// normalize_payload schema validation
// ---------------------------------------------------------------------------

describe("TestNormalizePayloadValidation", () => {
  it("test_valid_payload_returns_unchanged", () => {
    // Valid payload with tool_name passes through; _tg_harness is stamped.
    const payload = {
      session_id: "s1",
      tool_name: "Read",
      tool_input: "file.txt",
    } as unknown as Record<string, unknown>;
    const result = normalize_payload(payload);
    expect(result.session_id).toBe("s1");
    expect(result.tool_name).toBe("Read");
    expect(result._tg_harness).toBe("claude");
  });

  it("test_empty_dict_returns_empty", () => {
    // Empty dict payload is rejected.
    const result = normalize_payload({});
    expect(result).toEqual({});
  });

  it("test_non_dict_payload_returns_empty", () => {
    // Non-dict payload (list, string, None) is rejected.
    expect(normalize_payload([] as unknown as Record<string, unknown>)).toEqual({});
    expect(normalize_payload("string" as unknown as Record<string, unknown>)).toEqual({});
    expect(normalize_payload(null as unknown as Record<string, unknown>)).toEqual({});
  });

  it("test_missing_tool_name_returns_empty", () => {
    // Payload without tool_name is rejected.
    const payload = {
      session_id: "s1",
      tool_input: "file.txt",
    } as unknown as Record<string, unknown>;
    const result = normalize_payload(payload);
    expect(result).toEqual({});
  });

  it("test_empty_tool_name_returns_empty", () => {
    // Payload with empty tool_name is rejected.
    const payload = { session_id: "s1", tool_name: "" };
    const result = normalize_payload(payload);
    expect(result).toEqual({});
  });

  it("test_whitespace_tool_name_returns_empty", () => {
    // Payload with whitespace-only tool_name is rejected.
    const payload = { session_id: "s1", tool_name: "   " };
    const result = normalize_payload(payload);
    expect(result).toEqual({});
  });

  it("test_non_string_tool_name_returns_empty", () => {
    // Payload with non-string tool_name is rejected.
    const payload = { session_id: "s1", tool_name: 123 } as unknown as Record<string, unknown>;
    const result = normalize_payload(payload);
    expect(result).toEqual({});
  });

  it("test_valid_payload_with_minimal_fields", () => {
    // Valid payload needs only tool_name; _tg_harness is stamped.
    const payload = { tool_name: "Bash" };
    const result = normalize_payload(payload);
    expect(result.tool_name).toBe("Bash");
    expect(result._tg_harness).toBe("claude");
  });
});

// ---------------------------------------------------------------------------
// load_session_safe — fail-soft session loader
// ---------------------------------------------------------------------------

describe("TestLoadSessionSafe", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("test_returns_fresh_cache_for_unknown_session", () => {
    // load_session_safe returns a fresh SessionCache for an unknown session ID.
    const result = load_session_safe("no-such-session-id-xyz-9999");
    // Returns a fresh (non-null) SessionCache — same as session.load() behaviour.
    expect(result).not.toBeNull();
    expect(result).toBeInstanceOf(session.SessionCache);
  });

  it("test_returns_session_cache_on_success", () => {
    // load_session_safe returns a SessionCache when the session exists on disk.
    const sid = "test-load-session-safe-ok";
    const cache = session.load(sid);
    session.save(cache);

    const result = load_session_safe(sid);
    expect(result).not.toBeNull();
    expect(result).toBeInstanceOf(session.SessionCache);
  });

  it("test_returns_none_on_oserror", () => {
    // load_session_safe returns null when session.load raises OSError.
    vi.spyOn(session, "load").mockImplementation(() => {
      throw new Error("disk gone");
    });

    const result = load_session_safe("any-session-id");
    expect(result).toBeNull();
  });

  it("test_returns_none_on_value_error", () => {
    // load_session_safe returns null when session.load raises ValueError (corrupt JSON).
    vi.spyOn(session, "load").mockImplementation(() => {
      throw new Error("bad json");
    });

    const result = load_session_safe("any-session-id");
    expect(result).toBeNull();
  });

  it("test_returns_none_on_unexpected_exception", () => {
    // load_session_safe returns null on any unexpected exception (broad except).
    vi.spyOn(session, "load").mockImplementation(() => {
      throw new Error("unexpected");
    });

    const result = load_session_safe("any-session-id");
    expect(result).toBeNull();
  });

  it("test_does_not_raise", () => {
    // load_session_safe never raises; it is a strict fail-soft function.
    vi.spyOn(session, "load").mockImplementation(() => {
      throw new Error("OOM");
    });

    // Must not raise.
    const result = load_session_safe("any-id");
    expect(result).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// record_cached_stat — bytes_saved / tokens_saved accounting
// ---------------------------------------------------------------------------

interface _CapturedCall {
  kind: string;
  bytes_saved: number;
  tokens_saved: number;
  detail: string | undefined;
}

describe("TestRecordCachedStatSavingsAccounting", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  function _capture_record_stat_calls(): _CapturedCall[] {
    const calls: _CapturedCall[] = [];
    vi.spyOn(db, "recordStat").mockImplementation((_projectHash, kind, opts = {}) => {
      calls.push({
        kind,
        bytes_saved: opts.bytesSaved ?? 0,
        tokens_saved: opts.tokensSaved ?? 0,
        detail: opts.detail,
      });
    });
    return calls;
  }

  it("test_bash_output_cached_records_nonzero_bytes", () => {
    // bash_output_cached should record the actual byte count of cached output.
    const calls = _capture_record_stat_calls();
    record_cached_stat("bash_output_cached", "pytest --tb=short", 4096);

    expect(calls.length).toBe(1);
    expect(calls[0]!.kind).toBe("bash_output_cached");
    expect(calls[0]!.bytes_saved).toBe(4096);
    expect(calls[0]!.tokens_saved).toBe(Math.max(1, Math.trunc(4096 / 3) + 1)); // 1366
  });

  it("test_skill_cached_records_nonzero_bytes", () => {
    // skill_cached should record the actual body size of the cached skill.
    const calls = _capture_record_stat_calls();
    record_cached_stat("skill_cached", "ralph", 32768);

    expect(calls.length).toBe(1);
    expect(calls[0]!.kind).toBe("skill_cached");
    expect(calls[0]!.bytes_saved).toBe(32768);
    expect(calls[0]!.tokens_saved).toBe(Math.max(1, Math.trunc(32768 / 3) + 1)); // 10923
  });

  it("test_tokens_saved_uses_canonical_formula", () => {
    // tokens_saved must use max(1, bytes // 3 + 1).
    const calls = _capture_record_stat_calls();
    record_cached_stat("bash_output_cached", "some-cmd", 7);

    // max(1, 7 // 3 + 1) = max(1, 3) = 3.
    expect(calls[0]!.tokens_saved).toBe(Math.max(1, Math.trunc(7 / 3) + 1)); // 3
  });

  it("test_zero_bytes_saved_when_omitted", () => {
    // Callers that don't pass bytes_saved get 0 (backwards-compatible).
    const calls = _capture_record_stat_calls();
    record_cached_stat("glob_result_cache_hit", "**/*.py");

    expect(calls[0]!.bytes_saved).toBe(0);
    expect(calls[0]!.tokens_saved).toBe(0);
  });

  it("test_negative_bytes_clamped_to_zero", () => {
    // A negative bytes_saved value should be clamped to 0.
    const calls = _capture_record_stat_calls();
    record_cached_stat("bash_output_cached", "cmd", -100);

    expect(calls[0]!.bytes_saved).toBe(0);
    expect(calls[0]!.tokens_saved).toBe(0);
  });

  it("test_db_error_is_swallowed", () => {
    // A DB failure must not propagate — record_cached_stat is fail-soft.
    vi.spyOn(db, "recordStat").mockImplementation(() => {
      throw new Error("DB gone");
    });

    // Must not raise.
    expect(() => record_cached_stat("bash_output_cached", "cmd", 1024)).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// sanitize_log_str / sanitize_opt / is_real_int — the three guards carried over
// from the Layer 2 partial (no dedicated Python test cases; smoke-covered here).
// ---------------------------------------------------------------------------

describe("sanitize_log_str", () => {
  it("escapes embedded newlines and carriage returns (all occurrences)", () => {
    expect(sanitize_log_str("a\nb\nc")).toBe("a\\nb\\nc");
    expect(sanitize_log_str("a\rb")).toBe("a\\rb");
    expect(sanitize_log_str("line1\r\nline2")).toBe("line1\\r\\nline2");
  });

  it("strips every Unicode bidi control character", () => {
    const withControls = _BIDI_CONTROLS.map((ch) => `x${ch}y`).join("");
    const expected = _BIDI_CONTROLS.map(() => "xy").join("");
    expect(sanitize_log_str(withControls)).toBe(expected);
    expect(sanitize_log_str("evil‮exe.txt")).toBe("evilexe.txt");
  });

  it("truncates to max_len appending the … (U+2026) suffix", () => {
    const long = "a".repeat(250);
    const out = sanitize_log_str(long);
    expect(out).toBe("a".repeat(200) + "…");
    expect(out.length).toBe(201);

    expect(sanitize_log_str("abcdef", 3)).toBe("abc…");
    expect(sanitize_log_str("abc", 3)).toBe("abc");
    expect(sanitize_log_str("ab", 3)).toBe("ab");
  });
});

describe("sanitize_opt", () => {
  it("returns '' for falsy values and sanitizes truthy strings", () => {
    expect(sanitize_opt(undefined)).toBe("");
    expect(sanitize_opt(null)).toBe("");
    expect(sanitize_opt("")).toBe("");
    expect(sanitize_opt(0)).toBe("");
    expect(sanitize_opt(false)).toBe("");

    expect(sanitize_opt("session-123")).toBe("session-123");
    expect(sanitize_opt("a\nb")).toBe("a\\nb");
  });

  it("coerces a non-string truthy value to a sanitized string", () => {
    const debugSpy = vi.spyOn(console, "debug").mockImplementation(() => {});
    expect(sanitize_opt(42)).toBe("42");
    expect(debugSpy).toHaveBeenCalled();
    debugSpy.mockRestore();
  });
});

describe("is_real_int", () => {
  it("is true for genuine integers", () => {
    expect(is_real_int(0)).toBe(true);
    expect(is_real_int(1)).toBe(true);
    expect(is_real_int(-5)).toBe(true);
    expect(is_real_int(1000000)).toBe(true);
  });

  it("is false for booleans, floats, strings, and null/undefined", () => {
    expect(is_real_int(true)).toBe(false);
    expect(is_real_int(false)).toBe(false);
    expect(is_real_int(1.5)).toBe(false);
    expect(is_real_int(NaN)).toBe(false);
    expect(is_real_int(Infinity)).toBe(false);
    expect(is_real_int("1")).toBe(false);
    expect(is_real_int("")).toBe(false);
    expect(is_real_int(null)).toBe(false);
    expect(is_real_int(undefined)).toBe(false);
  });
});
