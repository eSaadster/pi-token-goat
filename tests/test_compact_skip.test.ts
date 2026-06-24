/**
 * Tests for compact pre-skip logic improvements — 1:1 port of
 * tests/test_compact_skip.py.
 *
 * Each Python `def test_*` maps to a vitest `it()` with the SAME name and the
 * SAME assertion polarity; each Python `class Test*` maps to a `describe(...)`.
 *
 * ---------------------------------------------------------------------------
 * Parity notes (Python -> TS)
 * ---------------------------------------------------------------------------
 *  - The sentinel helpers Python imports from `token_goat.hooks_cli`
 *    (_SkipResult, _check_compact_skip_sentinel[/_detail],
 *    _current_session_counts, _is_noop_session, _read_sentinel_counts,
 *    _write_compact_skip_sentinel, pre_compact) live in the shipped
 *    hooks_cli.ts. `_score_manifest` and `_MANIFEST_THIN_THRESHOLD` live in
 *    compact.ts. Both are imported from their shipped `.js` modules.
 *
 *  - `_SkipResult.__bool__`. Python defined `__bool__` returning `should_skip`,
 *    so `bool(r)` / `if r:` reflected the flag. JS object instances are always
 *    truthy, and the shipped TS `_SkipResult` carries no `__bool__` analogue —
 *    callers read `.should_skip`. So the Python `bool(r)` / truthy-`if` tests
 *    are ported to assert on `.should_skip` directly (same end state). Recorded
 *    in parity_notes.
 *
 *  - `paths.compact_skip_sentinel_path` -> `paths.compactSkipSentinelPath`
 *    (camelCase in the TS paths module); `paths.atomic_write_text` ->
 *    `paths.atomicWriteText`. The atomic-write test spies the camelCase name.
 *
 *  - conftest `_make_session(..., edits=, bash_runs=)` -> the local makeSession()
 *    helper. Python's `bash_cache.command_hash(cmd)` (bash_cache not ported) is
 *    replaced by `short_content_hash(cmd)` from cache_common — any stable,
 *    per-command-unique 16-char sha works as the bash_history key; the tests
 *    only assert on the COUNT of bash entries, never the sha value.
 *
 *  - `_write_compact_skip_sentinel(sid, edited_count=E, bash_count=B)` (Python
 *    keyword args) -> `_write_compact_skip_sentinel(sid, {edited_count:E,
 *    bash_count:B})` (the shipped TS opts-object signature).
 *
 *  - `_read_sentinel_counts` takes a `string` path in TS (Python passed a Path);
 *    `paths.compactSkipSentinelPath` already returns the resolved path string.
 *
 *  - `patch("token_goat.config.load")` (a MagicMock config) -> `vi.spyOn(config,
 *    "load")` returning the REAL default config with `compact_assist` overridden
 *    (spread + the specific fields the test sets). The integration tests assert
 *    only on the high-level outcome (continue / systemMessage / sentinel
 *    counts), so the real defaults for the un-overridden compact_assist fields
 *    are behaviour-equivalent (and strictly better-typed than Python's
 *    auto-vivified MagicMock attrs).
 *
 *  - `pre_compact` is ASYNC in the TS port (it dynamically imports the shipped
 *    compact.js). Every integration test `await`s it.
 *
 *  - `caplog.at_level(DEBUG, logger="token_goat.hooks")` -> `vi.spyOn(console,
 *    "debug")`. util.ts's ConsoleLogger forwards `.debug(...)` to console.debug
 *    with a `[token_goat.hooks]` prefix and the raw `%s`/`%d` format string +
 *    args; each captured call is rendered with node:util.format (the same `%s`/
 *    `%d` substitution console performs) so the Python `record.getMessage()`
 *    substring/regex checks match. mock.calls are read BEFORE mockRestore().
 *
 *  - MagicMock session-cache shims in TestIsNoopSession -> plain objects with
 *    the same `.edited_files` / `.bash_history` / `.files[k].symbols_read`
 *    shape; `_is_noop_session` reads them via getattr-style access.
 *
 * No bash_cache / skill_cache seam injection is needed: no test in this file
 * patches token_goat.bash_cache or token_goat.skill_cache. (The only Python use
 * was conftest `_make_session`'s `command_hash`, replaced above.)
 *
 * No test here uses a tmp dir as a PROJECT ROOT, builds a git repo, or sets a
 * payload cwd, so no fs.realpathSync / git fixtures are required.
 */
import { format } from "node:util";
import * as fs from "node:fs";
import * as nodePath from "node:path";

import { describe, expect, it, vi } from "vitest";

import * as paths from "../src/token_goat/paths.js";
import * as session from "../src/token_goat/session.js";
import * as config from "../src/token_goat/config.js";
import { short_content_hash } from "../src/token_goat/cache_common.js";
import { _MANIFEST_THIN_THRESHOLD, _score_manifest } from "../src/token_goat/compact.js";
import {
  _check_compact_skip_sentinel,
  _check_compact_skip_sentinel_detail,
  _current_session_counts,
  _is_noop_session,
  _read_sentinel_counts,
  _SkipResult,
  _write_compact_skip_sentinel,
  pre_compact,
} from "../src/token_goat/hooks_cli.js";
import type { ConfigSchema } from "../src/token_goat/types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Write a sentinel JSON directly (bypassing the public helper). */
function _write_sentinel_json(path: string, edited_count: number, bash_count: number): void {
  fs.mkdirSync(nodePath.dirname(path), { recursive: true });
  fs.writeFileSync(path, JSON.stringify({ edited_count, bash_count }), "utf8");
}

/**
 * conftest `_make_session` analogue (the kwargs this file uses: edits,
 * bash_runs). bash_runs is a map of command -> [output_bytes, exit_code]; the
 * command's stable sha (short_content_hash, standing in for the not-ported
 * bash_cache.command_hash) keys bash_history.
 */
function makeSession(
  session_id: string,
  opts: { edits?: number; bash_runs?: Record<string, [number, number]> } = {},
): session.SessionCache {
  const edits = opts.edits ?? 0;
  for (let i = 0; i < edits; i++) {
    session.mark_file_edited(session_id, `/proj/src/edited${i}.py`);
  }
  const bash_runs = opts.bash_runs;
  if (bash_runs) {
    for (const [cmd, pair] of Object.entries(bash_runs)) {
      const [output_bytes, exit_code] = pair;
      const cmd_sha = short_content_hash(cmd);
      session.mark_bash_run(
        session_id,
        cmd_sha,
        cmd,
        `out-${cmd_sha}`,
        output_bytes,
        0,
        exit_code,
        false,
      );
    }
  }
  return session.load(session_id);
}

/**
 * vi.spyOn(config, "load") returning the real default config with
 * `compact_assist` overridden by `overrides`. Mirrors the Python
 * `patch("token_goat.config.load")` MagicMock whose compact_assist fields the
 * test sets explicitly.
 */
function mockConfig(overrides: Record<string, unknown>): ReturnType<typeof vi.spyOn> {
  const base = config.load();
  const merged: ConfigSchema = {
    ...base,
    compact_assist: { ...(base.compact_assist ?? {}), ...overrides },
  };
  return vi.spyOn(config, "load").mockReturnValue(merged);
}

// ---------------------------------------------------------------------------
// 1. _SkipResult
// ---------------------------------------------------------------------------

describe("TestSkipResult", () => {
  it("test_bool_true_when_should_skip", () => {
    const r = new _SkipResult(true, "ttl_not_expired", 42.0);
    // Python asserted bool(r) is True via __bool__; the TS class exposes the
    // flag directly.
    expect(r.should_skip).toBe(true);
    expect(r.should_skip).toBe(true);
    expect(r.reason).toBe("ttl_not_expired");
    expect(r.age_secs).toBe(42.0);
  });

  it("test_bool_false_when_not_skipping", () => {
    const r = new _SkipResult(false, "", 0.0);
    expect(r.should_skip).toBe(false);
  });

  it("test_truthy_in_if", () => {
    // Python relied on __bool__: assert _SkipResult(True,...) / not(False,...).
    // TS reads should_skip.
    expect(new _SkipResult(true, "noop_session", 0.0).should_skip).toBe(true);
    expect(new _SkipResult(false, "", 0.0).should_skip).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 2. _write_compact_skip_sentinel stores counts
// ---------------------------------------------------------------------------

describe("TestWriteCompactSkipSentinel", () => {
  it("test_writes_json_with_counts", () => {
    const sid = "write-sentinel-test-abc";
    _write_compact_skip_sentinel(sid, { edited_count: 3, bash_count: 5 });
    const sentinel = paths.compactSkipSentinelPath(sid);
    expect(fs.existsSync(sentinel)).toBe(true);
    const data = JSON.parse(fs.readFileSync(sentinel, "utf8")) as Record<string, unknown>;
    expect(data["edited_count"]).toBe(3);
    expect(data["bash_count"]).toBe(5);
  });

  it("test_default_counts_are_zero", () => {
    const sid = "write-sentinel-defaults-abc";
    _write_compact_skip_sentinel(sid);
    const sentinel = paths.compactSkipSentinelPath(sid);
    const data = JSON.parse(fs.readFileSync(sentinel, "utf8")) as Record<string, unknown>;
    expect(data["edited_count"]).toBe(0);
    expect(data["bash_count"]).toBe(0);
  });

  it("test_overwrites_existing_sentinel", () => {
    const sid = "write-sentinel-overwrite-abc";
    _write_compact_skip_sentinel(sid, { edited_count: 1, bash_count: 1 });
    _write_compact_skip_sentinel(sid, { edited_count: 4, bash_count: 7 });
    const sentinel = paths.compactSkipSentinelPath(sid);
    const data = JSON.parse(fs.readFileSync(sentinel, "utf8")) as Record<string, unknown>;
    expect(data["edited_count"]).toBe(4);
    expect(data["bash_count"]).toBe(7);
  });
});

// ---------------------------------------------------------------------------
// 3. _read_sentinel_counts
// ---------------------------------------------------------------------------

describe("TestReadSentinelCounts", () => {
  it("test_reads_counts_from_json", () => {
    const sid = "read-sentinel-counts-abc";
    const sentinel = paths.compactSkipSentinelPath(sid);
    _write_sentinel_json(sentinel, 2, 8);
    const [edited, bash] = _read_sentinel_counts(sentinel);
    expect(edited).toBe(2);
    expect(bash).toBe(8);
  });

  it("test_empty_file_returns_none_none", () => {
    const sid = "read-sentinel-empty-abc";
    const sentinel = paths.compactSkipSentinelPath(sid);
    fs.mkdirSync(nodePath.dirname(sentinel), { recursive: true });
    fs.writeFileSync(sentinel, "", "utf8");
    expect(_read_sentinel_counts(sentinel)).toEqual([null, null]);
  });

  it("test_non_json_returns_none_none", () => {
    const sid = "read-sentinel-nonjson-abc";
    const sentinel = paths.compactSkipSentinelPath(sid);
    fs.mkdirSync(nodePath.dirname(sentinel), { recursive: true });
    fs.writeFileSync(sentinel, "not valid json!!!", "utf8");
    expect(_read_sentinel_counts(sentinel)).toEqual([null, null]);
  });

  it("test_json_missing_keys_returns_none_none", () => {
    const sid = "read-sentinel-nokeys-abc";
    const sentinel = paths.compactSkipSentinelPath(sid);
    fs.mkdirSync(nodePath.dirname(sentinel), { recursive: true });
    fs.writeFileSync(sentinel, JSON.stringify({ other: 1 }), "utf8");
    expect(_read_sentinel_counts(sentinel)).toEqual([null, null]);
  });
});

// ---------------------------------------------------------------------------
// 4. _current_session_counts
// ---------------------------------------------------------------------------

describe("TestCurrentSessionCounts", () => {
  it("test_counts_from_populated_session", () => {
    const sid = "current-counts-session-abc";
    session.mark_file_edited(sid, "/proj/a.py");
    session.mark_file_edited(sid, "/proj/b.py");
    makeSession(sid, { bash_runs: { pytest: [1000, 0], "ruff check": [500, 1] } });
    const [edited, bash] = _current_session_counts(sid);
    expect(edited).toBe(2);
    expect(bash).toBe(2);
  });

  it("test_zero_counts_for_empty_session", () => {
    const sid = "current-counts-empty-abc";
    const [edited, bash] = _current_session_counts(sid);
    expect(edited).toBe(0);
    expect(bash).toBe(0);
  });

  it("test_graceful_on_missing_session", () => {
    const sid = "current-counts-missing-abc";
    // No session file written; should return [0, 0].
    const [edited, bash] = _current_session_counts(sid);
    expect(edited).toBe(0);
    expect(bash).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// 5. _check_compact_skip_sentinel_detail — TTL and mtime gates
// ---------------------------------------------------------------------------

describe("TestCheckCompactSkipSentinelDetail", () => {
  it("test_absent_sentinel_returns_not_skip", () => {
    const sid = "detail-absent-abc";
    const result = _check_compact_skip_sentinel_detail(sid);
    expect(result.should_skip).toBe(false);
    expect(result.reason).toBe("");
  });

  it("test_fresh_sentinel_returns_skip", () => {
    const sid = "detail-fresh-abc";
    _write_compact_skip_sentinel(sid);
    const result = _check_compact_skip_sentinel_detail(sid);
    expect(result.should_skip).toBe(true);
    expect(result.reason).toBe("ttl_not_expired");
    expect(result.age_secs).toBeGreaterThanOrEqual(0.0);
  });

  it("test_expired_sentinel_returns_not_skip", () => {
    const sid = "detail-expired-abc";
    _write_compact_skip_sentinel(sid);
    const sentinel = paths.compactSkipSentinelPath(sid);
    // Backdate mtime by 400 s (beyond default 300-s TTL).
    const old_mtime = Date.now() / 1000 - 400;
    fs.utimesSync(sentinel, old_mtime, old_mtime);
    const result = _check_compact_skip_sentinel_detail(sid);
    expect(result.should_skip).toBe(false);
  });

  it("test_future_sentinel_returns_not_skip", () => {
    const sid = "detail-future-abc";
    _write_compact_skip_sentinel(sid);
    const sentinel = paths.compactSkipSentinelPath(sid);
    const future_mtime = Date.now() / 1000 + 3600;
    fs.utimesSync(sentinel, future_mtime, future_mtime);
    const result = _check_compact_skip_sentinel_detail(sid);
    expect(result.should_skip).toBe(false);
  });

  it("test_boolean_coercion_matches_legacy", () => {
    // _check_compact_skip_sentinel (legacy) returns same bool as detail.
    const sid = "detail-compat-abc";
    _write_compact_skip_sentinel(sid);
    expect(_check_compact_skip_sentinel(sid)).toBe(_check_compact_skip_sentinel_detail(sid).should_skip);
  });

  it("test_age_secs_populated_when_sentinel_exists", () => {
    const sid = "detail-age-abc";
    _write_compact_skip_sentinel(sid);
    const result = _check_compact_skip_sentinel_detail(sid);
    // Age should be very small but >= 0.
    expect(result.age_secs).toBeGreaterThanOrEqual(0.0);
    expect(result.age_secs).toBeLessThan(5.0);
  });

  it("test_age_secs_nonzero_when_expired", () => {
    const sid = "detail-age-expired-abc";
    _write_compact_skip_sentinel(sid);
    const sentinel = paths.compactSkipSentinelPath(sid);
    const old_mtime = Date.now() / 1000 - 400;
    fs.utimesSync(sentinel, old_mtime, old_mtime);
    const result = _check_compact_skip_sentinel_detail(sid);
    expect(result.age_secs).toBeGreaterThanOrEqual(390.0); // within a rounding margin
  });
});

// ---------------------------------------------------------------------------
// 6. Activity floor — count-based bust
// ---------------------------------------------------------------------------

describe("TestActivityFloorCounts", () => {
  it("test_count_increase_busts_sentinel", () => {
    // A sentinel with edited_count=1 is busted when session now has 2 edits.
    const sid = "count-bust-edits-abc";
    // Write sentinel recording edited_count=1
    _write_compact_skip_sentinel(sid, { edited_count: 1, bash_count: 0 });
    // Now add a second edited file to the session (count increases to 2)
    session.mark_file_edited(sid, "/proj/a.py");
    session.mark_file_edited(sid, "/proj/b.py"); // 2 total
    const result = _check_compact_skip_sentinel_detail(sid);
    expect(result.should_skip).toBe(false);
  });

  it("test_bash_increase_busts_sentinel", () => {
    // A sentinel with bash_count=0 is busted when session now has 1 bash run.
    const sid = "count-bust-bash-abc";
    // Write sentinel with bash_count=0
    _write_compact_skip_sentinel(sid, { edited_count: 0, bash_count: 0 });
    // Now record a bash run
    makeSession(sid, { bash_runs: { pytest: [500, 0] } });
    const result = _check_compact_skip_sentinel_detail(sid);
    expect(result.should_skip).toBe(false);
  });

  it("test_same_counts_does_not_bust_sentinel", () => {
    // Sentinel is not busted when counts have not increased.
    const sid = "count-nochange-abc";
    session.mark_file_edited(sid, "/proj/a.py"); // edited_count == 1
    _write_compact_skip_sentinel(sid, { edited_count: 1, bash_count: 0 });
    // No new edits or bash since the sentinel was written.
    const result = _check_compact_skip_sentinel_detail(sid);
    expect(result.should_skip).toBe(true);
  });

  it("test_legacy_empty_sentinel_skips_count_check", () => {
    // Legacy touch()-style sentinels (empty content) skip the count gate.
    const sid = "count-legacy-abc";
    const sentinel = paths.compactSkipSentinelPath(sid);
    fs.mkdirSync(nodePath.dirname(sentinel), { recursive: true });
    fs.writeFileSync(sentinel, "", "utf8"); // legacy: no JSON
    // Even with edits present, a legacy sentinel is not busted by count check.
    // (mtime floor may still bust it, but count check passes through.)
    const result = _check_compact_skip_sentinel_detail(sid);
    // Legacy sentinel has no counts -> count gate skipped -> only mtime + TTL gate.
    // The sentinel is fresh (just written) so should still skip.
    expect(result.should_skip).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 7. _is_noop_session
// ---------------------------------------------------------------------------

interface _MockCacheOpts {
  edited?: Record<string, unknown> | undefined;
  bash?: Record<string, unknown> | undefined;
  files_with_syms?: boolean | undefined;
}

/** Build a minimal mock session cache (the Python _make_cache helper). */
function _make_cache(opts: _MockCacheOpts = {}): unknown {
  const files_with_syms = opts.files_with_syms ?? false;
  return {
    edited_files: opts.edited ?? {},
    bash_history: opts.bash ?? {},
    files: files_with_syms ? { key: { symbols_read: ["some_symbol"] } } : {},
  };
}

describe("TestIsNoopSession", () => {
  it("test_empty_session_is_noop", () => {
    const cache = _make_cache();
    expect(_is_noop_session(cache)).toBe(true);
  });

  it("test_session_with_edit_is_not_noop", () => {
    const cache = _make_cache({ edited: { "/proj/a.py": 1 } });
    expect(_is_noop_session(cache)).toBe(false);
  });

  it("test_session_with_bash_is_not_noop", () => {
    const mock = {
      edited_files: {},
      bash_history: { abc123: {} },
      files: {},
    };
    expect(_is_noop_session(mock)).toBe(false);
  });

  it("test_session_with_symbols_is_not_noop", () => {
    const mock = {
      edited_files: {},
      bash_history: {},
      files: { key: { symbols_read: ["my_func"] } },
    };
    expect(_is_noop_session(mock)).toBe(false);
  });

  it("test_files_without_symbols_is_noop", () => {
    // Files-read but no symbols accessed is still a noop.
    const mock = {
      edited_files: {},
      bash_history: {},
      files: { key: { symbols_read: [] } },
    };
    expect(_is_noop_session(mock)).toBe(true);
  });

  it("test_none_attributes_treated_as_empty", () => {
    // None attribute values are treated as empty collections.
    const mock = {
      edited_files: null,
      bash_history: null,
      files: null,
    };
    expect(_is_noop_session(mock)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 8. _score_manifest
// ---------------------------------------------------------------------------

describe("TestScoreManifest", () => {
  it("test_empty_sections_scores_zero", () => {
    expect(_score_manifest([])).toBe(0);
  });

  it("test_empty_string_scores_zero", () => {
    expect(_score_manifest([""])).toBe(0);
  });

  it("test_edited_file_lines_score_ten_each", () => {
    const section = "**Edited**:\n- a.py ✎×2\n- b.py ✎×1";
    const score = _score_manifest([section]);
    expect(score).toBe(20); // 2 edit lines × 10
  });

  it("test_bash_lines_score_three_each", () => {
    const section = "**Bash**:\n- `pytest` (8kb) abc123\n- `ruff check` (2kb) def456";
    const score = _score_manifest([section]);
    expect(score).toBe(6); // 2 bash lines × 3
  });

  it("test_symbol_lines_score_two_each", () => {
    const section = "**Symbols**:\n- get_user (auth.py)\n- create_token (auth.py)";
    const score = _score_manifest([section]);
    expect(score).toBe(4); // 2 symbol lines × 2
  });

  it("test_failure_line_adds_five", () => {
    // A line in Bash section containing ✗ triggers the +5 bonus
    const section = "**Bash**:\n- ✗ pytest (exit=1)";
    const score = _score_manifest([section]);
    // 1 bash line (3) + failure bonus (5) = 8
    expect(score).toBe(8);
  });

  it("test_mixed_sections", () => {
    const sections = [
      "**Edited**:\n- main.py ✎×3",
      "**Bash**:\n- `pytest` (1kb) abc\n- `ruff` (500b) def",
      "**Symbols**:\n- parse_args (cli.py)",
    ];
    const score = _score_manifest(sections);
    // 1 edit (10) + 2 bash (6) + 1 symbol (2) = 18
    expect(score).toBe(18);
  });

  it("test_multiple_sections_combined", () => {
    // Sections in a single string (whole manifest) are also scored.
    const manifest =
      "## Token-Goat Session Manifest\n\n" +
      "**Edited**:\n- foo.py ✎×1\n\n" +
      "**Bash**:\n- `uv run pytest` (5kb exit=0) id123\n";
    const score = _score_manifest([manifest]);
    expect(score).toBeGreaterThanOrEqual(10); // at least the edited file
  });

  it("test_thin_manifest_threshold_constant", () => {
    // _MANIFEST_THIN_THRESHOLD is defined and positive.
    expect(Number.isInteger(_MANIFEST_THIN_THRESHOLD)).toBe(true);
    expect(_MANIFEST_THIN_THRESHOLD).toBeGreaterThan(0);
  });

  it("test_zero_score_is_below_thin_threshold", () => {
    expect(_score_manifest([])).toBeLessThan(_MANIFEST_THIN_THRESHOLD);
  });

  it("test_rich_session_exceeds_thin_threshold", () => {
    // 2 edits (20) should exceed any reasonable thin threshold.
    const section = "**Edited**:\n- a.py ✎×1\n- b.py ✎×2";
    const score = _score_manifest([section]);
    expect(score).toBeGreaterThanOrEqual(_MANIFEST_THIN_THRESHOLD);
  });
});

// ---------------------------------------------------------------------------
// 9. pre_compact noop-session integration
// ---------------------------------------------------------------------------

describe("TestPreCompactNoopSession", () => {
  it("test_noop_session_skips_manifest", async () => {
    // pre_compact returns CONTINUE without systemMessage for noop sessions.
    const sid = "precompact-noop-session-abc";
    // Create an empty session (no edits, no bash, no symbols).
    session.load(sid); // creates the session file

    const payload = { session_id: sid, trigger: "manual" };
    const cfgSpy = mockConfig({
      enabled: true,
      triggers: ["manual", "auto"],
      min_events: 1,
      max_manifest_tokens: 400,
      auto_trigger_multiplier: 1.0,
    });
    let response: Awaited<ReturnType<typeof pre_compact>>;
    try {
      response = await pre_compact(payload);
    } finally {
      cfgSpy.mockRestore();
    }

    expect(response.continue).toBe(true);
    expect("systemMessage" in response).toBe(false);
  });

  it("test_session_with_edit_does_not_skip_as_noop", async () => {
    // pre_compact does NOT skip when the session has an edited file.
    const sid = "precompact-has-edit-abc";
    session.mark_file_edited(sid, "/proj/main.py");

    const payload = { session_id: sid, trigger: "manual" };
    const cfgSpy = mockConfig({
      enabled: true,
      triggers: ["manual", "auto"],
      min_events: 1,
      max_manifest_tokens: 400,
      auto_trigger_multiplier: 1.0,
    });
    try {
      await pre_compact(payload);
    } finally {
      cfgSpy.mockRestore();
    }

    // With an edited file the noop guard should NOT fire; the hook may still
    // skip for other reasons (events < min, empty manifest), but NOT because of
    // the noop gate. We verify by confirming the sentinel written does NOT
    // record reason="noop" — instead the sentinel written should contain
    // edited_count >= 1.
    const sentinel = paths.compactSkipSentinelPath(sid);
    if (fs.existsSync(sentinel)) {
      const raw = fs.readFileSync(sentinel, "utf8");
      if (raw.trim()) {
        const data = JSON.parse(raw) as Record<string, unknown>;
        // The noop gate writes edited_count=0; any path through the non-noop
        // gate should write edited_count >= 1.
        expect(Number(data["edited_count"] ?? -1)).toBeGreaterThanOrEqual(1);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// 10. Sentinel written with counts after min_events skip
// ---------------------------------------------------------------------------

describe("TestSentinelCountsAfterSkip", () => {
  it("test_sentinel_records_counts_after_min_events_skip", async () => {
    // When pre_compact skips due to min_events, sentinel carries current counts.
    const sid = "sentinel-counts-skip-abc";
    makeSession(sid, { edits: 2, bash_runs: { ls: [100, 0] } });

    const payload = { session_id: sid, trigger: "manual" };
    const cfgSpy = mockConfig({
      enabled: true,
      triggers: ["manual", "auto"],
      // Set min_events very high so it always skips
      min_events: 99999,
      max_manifest_tokens: 400,
      auto_trigger_multiplier: 1.0,
    });
    try {
      await pre_compact(payload);
    } finally {
      cfgSpy.mockRestore();
    }

    const sentinel = paths.compactSkipSentinelPath(sid);
    expect(fs.existsSync(sentinel)).toBe(true);
    const data = JSON.parse(fs.readFileSync(sentinel, "utf8")) as Record<string, unknown>;
    expect(data["edited_count"]).toBe(2);
    expect(data["bash_count"]).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// 11. Sentinel write is atomic (uses paths.atomicWriteText)
// ---------------------------------------------------------------------------

describe("TestWriteCompactSkipSentinelAtomic", () => {
  it("test_uses_atomic_write_text", () => {
    // _write_compact_skip_sentinel delegates to paths.atomicWriteText, not write.
    const atomicSpy = vi.spyOn(paths, "atomicWriteText").mockImplementation(() => {});
    let writtenPayload = "";
    try {
      _write_compact_skip_sentinel("atomic-sentinel-abc", { edited_count: 2, bash_count: 3 });
      expect(atomicSpy).toHaveBeenCalledTimes(1);
      // First arg: path, second arg: JSON string.
      const callArgs = atomicSpy.mock.calls[0]!;
      writtenPayload = String(callArgs[1]);
    } finally {
      atomicSpy.mockRestore();
    }
    const data = JSON.parse(writtenPayload) as Record<string, unknown>;
    expect(data["edited_count"]).toBe(2);
    expect(data["bash_count"]).toBe(3);
  });

  it("test_atomic_write_no_partial_content_on_error", () => {
    // If atomicWriteText raises, the error is silently swallowed (fail-soft).
    const atomicSpy = vi.spyOn(paths, "atomicWriteText").mockImplementation(() => {
      throw new Error("disk full");
    });
    try {
      // Must not raise; sentinel write failures are always suppressed.
      _write_compact_skip_sentinel("atomic-error-abc", { edited_count: 1, bash_count: 0 });
    } finally {
      atomicSpy.mockRestore();
    }
    // No sentinel was written (error suppressed).
    const sentinel = paths.compactSkipSentinelPath("atomic-error-abc");
    expect(fs.existsSync(sentinel)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 12. pre_compact timing log
// ---------------------------------------------------------------------------

describe("TestPreCompactTimingLog", () => {
  it("test_timing_log_emitted_at_debug", async () => {
    // pre_compact emits a DEBUG log with 'built manifest in' after
    // build_manifest_with_count.
    const sid = "timing-log-test-abc";
    makeSession(sid, { edits: 1, bash_runs: { "echo hi": [50, 0] } });

    const payload = { session_id: sid, trigger: "manual" };
    const cfgSpy = mockConfig({
      enabled: true,
      triggers: ["manual", "auto"],
      min_events: 0,
      max_manifest_tokens: 400,
      auto_trigger_multiplier: 1.0,
      max_manifest_chars: 0,
    });
    const debugSpy = vi.spyOn(console, "debug").mockImplementation(() => {});
    let messages: string[] = [];
    try {
      await pre_compact(payload);
      // Render each captured console.debug call exactly as console would (%s/%d
      // substitution via node:util.format) so the substring checks match
      // Python's record.getMessage().
      messages = debugSpy.mock.calls.map((c) => format(...(c as [unknown, ...unknown[]])));
    } finally {
      debugSpy.mockRestore();
      cfgSpy.mockRestore();
    }

    const timing_logs = messages.filter((m) => m.includes("built manifest in"));
    expect(timing_logs.length).toBeGreaterThan(0);
    // The message should contain 'ms' (milliseconds) and 'tokens'.
    expect(timing_logs.some((m) => m.includes("ms") && m.includes("tokens"))).toBe(true);
  });

  it("test_timing_log_contains_token_count", async () => {
    // Timing log token count is non-negative integer.
    const sid = "timing-log-tokens-abc";
    makeSession(sid, { edits: 1 });

    const payload = { session_id: sid, trigger: "manual" };
    const cfgSpy = mockConfig({
      enabled: true,
      triggers: ["manual", "auto"],
      min_events: 0,
      max_manifest_tokens: 400,
      auto_trigger_multiplier: 1.0,
      max_manifest_chars: 0,
    });
    const debugSpy = vi.spyOn(console, "debug").mockImplementation(() => {});
    let messages: string[] = [];
    try {
      await pre_compact(payload);
      messages = debugSpy.mock.calls.map((c) => format(...(c as [unknown, ...unknown[]])));
    } finally {
      debugSpy.mockRestore();
      cfgSpy.mockRestore();
    }

    let found = false;
    for (const msg of messages) {
      if (msg.includes("built manifest in")) {
        // Extract token count — expect pattern like "built manifest in 42ms (7 tokens)"
        const m = /\((\d+) tokens\)/.exec(msg);
        expect(m).not.toBeNull();
        expect(Number.parseInt(m![1]!, 10)).toBeGreaterThanOrEqual(0);
        found = true;
        break;
      }
    }
    expect(found).toBe(true);
  });
});
