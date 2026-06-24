/**
 * Unit tests for token_goat/hints — part 3/4 of the 1:1 port of
 * tests/test_hints.py.
 *
 * Scope: the Python classes TestCuratorEmissionGating through
 * TestGlobDedupBelowThresholdSuppression (tests/test_hints.py lines ~2195-3650).
 * Each Python `def test_*` maps to a vitest `it()` with the SAME name and the
 * SAME assertion polarity; each Python class maps to a `describe()`.
 *
 * ReadHint assertion contract (per src/token_goat/hints.ts file header):
 *   Python `"x" in hint`      → TS `hint.text.includes("x")`
 *   Python `hint.lower()`     → TS `hint.text.toLowerCase()`
 *   Python `str(hint)`        → TS `hint.text` (or String(hint))
 *   Python `hint.tokens_saved`→ TS `hint.tokens_saved`
 *   Python `hint is None`     → TS `hint === null`
 *
 * Config seam (Python `monkeypatch.setattr(config, "load", lambda: cfg)` /
 * `patch("token_goat.config.load", ...)`): hints.ts imports `import * as config`,
 * so `vi.spyOn(config, "load").mockReturnValue(fakeCfg)` is observed. The Python
 * HintBudgetConfig / CuratorConfig / Config() classes are plain interfaces in the
 * TS port, so a fake `ConfigSchema` is built inline with only the fields the
 * helper reads (curator / hint_budget / hints sub-objects).
 *
 * record_stat seam (Python `patch("token_goat.db.record_stat", side_effect=...)`):
 * the impl calls `db.recordStat(undefined, kind, {bytesSaved, tokensSaved,
 * detail})`. We `vi.spyOn(db, "recordStat")` and read the recorded opts object,
 * whose keys are the TS camelCase param names (bytesSaved / tokensSaved), not the
 * Python snake_case kwargs.
 *
 * bash_cache is now ported and wired (the build_bash_dedup_hint seam defaults to
 * the real module), so the bash-dedup tests that seed via bash_cache.command_hash
 * + session.mark_bash_run are LIVE. Tests that additionally need skill_cache /
 * worker (not yet ported) stay it.skip'd with an updated reason.
 *
 * Per-test tmp data dir + cache clearing is handled by tests/setup.ts
 * (beforeEach → setDataDirOverride + clearModuleCaches), mirroring the Python
 * tmp_data_dir autouse fixture.
 */
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { Database as DatabaseType } from "better-sqlite3";

import * as hints from "../src/token_goat/hints.js";
import {
  STALE_READ_AGE_SECONDS,
  build_bash_dedup_hint,
  build_glob_dedup_hint,
  build_grep_dedup_hint,
  build_read_hint,
  build_web_dedup_hint,
} from "../src/token_goat/hints.js";
import * as session from "../src/token_goat/session.js";
import * as db from "../src/token_goat/db.js";
import * as config from "../src/token_goat/config.js";
import * as bash_cache from "../src/token_goat/bash_cache.js";
import * as web_cache from "../src/token_goat/web_cache.js";
import { dataDir } from "../src/token_goat/paths.js";

import type { ConfigSchema } from "../src/token_goat/types.js";

// ---------------------------------------------------------------------------
// Shared helpers (inline replicas of the Python conftest / test helpers).
// ---------------------------------------------------------------------------

/** Python time.time() analogue (epoch seconds, float). */
function now(): number {
  return Date.now() / 1000;
}

/** The per-test data dir setup.ts overrides — the Python tmp_data_dir fixture. */
function tmpDataDir(): string {
  return dataDir();
}

/**
 * `_mark(tmp_data_dir, sid, path, offset=, limit=)` from the Python module-level
 * helper: record a single file read in the session cache. (Python _mark.)
 */
function _mark(
  _tmp: string,
  sid: string,
  p: string,
  opts: { offset?: number | null; limit?: number | null } = {},
): void {
  session.mark_file_read(sid, p, opts.offset ?? null, opts.limit ?? null);
}

/**
 * sha1 hex of a pattern (Python TestCrossSessionGrepDedup._pattern_hash:
 * hashlib.sha1(pattern.encode("utf-8", errors="replace")).hexdigest()).
 */
function patternHash(pattern: string): string {
  return createHash("sha1").update(Buffer.from(pattern, "utf8")).digest("hex");
}

/** Build a fake ConfigSchema for config.load() spies. */
function fakeConfig(partial: Partial<ConfigSchema>): ConfigSchema {
  return partial as ConfigSchema;
}

// ===========================================================================
// TestCuratorEmissionGating
// ===========================================================================

describe("TestCuratorEmissionGating", () => {
  /** Return a loaded session cache with preset curator counters. */
  function makeCache(
    sid: string,
    _tmp: string,
    args: { emitted: number; ignored: number },
  ): session.SessionCache {
    const cache = session.load(sid);
    cache.hints_emitted = args.emitted;
    cache.hints_ignored = args.ignored;
    cache._invalidate_json_cache();
    session.save(cache);
    return session.load(sid);
  }

  it("test_below_min_samples_always_emits", () => {
    const cache = makeCache("curator_gate_1", tmpDataDir(), { emitted: 5, ignored: 5 });
    // 5 < default min_samples (10), so should still emit
    expect(hints._curator_should_emit(cache)).toBe(true);
  });

  it("test_high_acceptance_rate_emits", () => {
    const cache = makeCache("curator_gate_2", tmpDataDir(), { emitted: 15, ignored: 5 });
    expect(hints._curator_should_emit(cache)).toBe(true);
  });

  it("test_low_acceptance_rate_suppresses", () => {
    const cache = makeCache("curator_gate_3", tmpDataDir(), { emitted: 15, ignored: 13 });
    expect(hints._curator_should_emit(cache)).toBe(false);
  });

  it("test_exactly_at_threshold_emits", () => {
    const cache = makeCache("curator_gate_4", tmpDataDir(), { emitted: 10, ignored: 8 });
    // acceptance = 2/10 * 100 = 20.0 — exactly at threshold, NOT below, so emits
    expect(hints._curator_should_emit(cache)).toBe(true);
  });

  it("test_bash_dedup_hint_suppressed_at_low_rate", () => {
    const sid = "curator_bash_1";
    const cmd = "uv run pytest tests/";
    const cmd_sha = bash_cache.command_hash(cmd);
    session.mark_bash_run(sid, cmd_sha, cmd.slice(0, 120), "output-id-1", 2000, 0, 0, false);
    let cache = session.load(sid);
    cache.hints_emitted = 15;
    cache.hints_ignored = 13; // 13% acceptance → suppress
    cache._invalidate_json_cache();
    session.save(cache);
    cache = session.load(sid);

    const hint = build_bash_dedup_hint({ session_id: sid, command: cmd, cache });
    expect(hint).toBeNull(); // curator should suppress at low acceptance rate
  });

  it("test_bash_dedup_hint_fires_at_high_rate", () => {
    const sid = "curator_bash_2";
    const cmd = "uv run pytest tests/ -q";
    const cmd_sha = bash_cache.command_hash(cmd);
    session.mark_bash_run(sid, cmd_sha, cmd.slice(0, 120), "output-id-2", 2000, 0, 0, false);
    let cache = session.load(sid);
    cache.hints_emitted = 15;
    cache.hints_ignored = 5; // 66% acceptance → emit
    cache._invalidate_json_cache();
    session.save(cache);
    cache = session.load(sid);

    const hint = build_bash_dedup_hint({ session_id: sid, command: cmd, cache });
    expect(hint).not.toBeNull(); // curator should allow at high acceptance rate
  });

  it("test_record_hint_emitted_increments_and_tracks_path", () => {
    const sid = "curator_record_1";
    const cache = session.load(sid);
    expect(cache.hints_emitted).toBe(0);
    expect(cache.recent_hints).toEqual([]);

    hints._record_hint_emitted(cache, "/proj/foo.py");
    expect(cache.hints_emitted).toBe(1);
    expect(cache.recent_hints.length).toBe(1);
    expect(cache.recent_hints[0]![0]).toBe("/proj/foo.py");
  });

  it("test_record_hint_emitted_caps_ring_buffer", () => {
    const sid = "curator_record_2";
    const cache = session.load(sid);
    for (let i = 0; i < 5; i++) {
      hints._record_hint_emitted(cache, `/proj/file_${i}.py`);
    }
    expect(cache.hints_emitted).toBe(5);
    expect(cache.recent_hints.length).toBe(3);
    // Most recent 3 paths are kept
    const paths = cache.recent_hints.map(([p]) => p);
    expect(paths).toContain("/proj/file_2.py");
    expect(paths).toContain("/proj/file_3.py");
    expect(paths).toContain("/proj/file_4.py");
    expect(paths).not.toContain("/proj/file_0.py");
  });
});

// ===========================================================================
// TestHintBudgetCheck
// ===========================================================================

describe("TestHintBudgetCheck", () => {
  function makeCache(sid: string, _tmp: string): session.SessionCache {
    const cache = session.load(sid);
    session.save(cache);
    return session.load(sid);
  }

  it("test_dedup_99th_hint_still_fires", () => {
    const cache = makeCache("hb_dedup_99", tmpDataDir());
    cache.hints_emitted = 99;

    const cfg = fakeConfig({ hint_budget: { enabled: true, max_per_session: 100 } });
    const spy = vi.spyOn(config, "load").mockReturnValue(cfg);
    const result = hints._hint_budget_check(cache, hints._HINT_KIND_DEDUP);
    spy.mockRestore();
    expect(result).toBe(true);
  });

  it("test_dedup_100th_hint_is_suppressed", () => {
    const cache = makeCache("hb_dedup_100", tmpDataDir());
    cache.hints_emitted = 100; // at cap

    const cfg = fakeConfig({ hint_budget: { enabled: true, max_per_session: 100 } });
    const spy = vi.spyOn(config, "load").mockReturnValue(cfg);
    const result = hints._hint_budget_check(cache, hints._HINT_KIND_DEDUP);
    spy.mockRestore();
    expect(result).toBe(false);
  });

  it("test_structured_budget_independent_of_dedup", () => {
    const cache = makeCache("hb_structured_indep", tmpDataDir());
    cache.hints_emitted = 200; // dedup exhausted
    cache.structured_hints_emitted = 5; // structured has room

    const cfg = fakeConfig({
      hint_budget: { enabled: true, max_per_session: 100, max_structured_per_session: 30 },
    });
    const spy = vi.spyOn(config, "load").mockReturnValue(cfg);
    const dedup_ok = hints._hint_budget_check(cache, hints._HINT_KIND_DEDUP);
    const structured_ok = hints._hint_budget_check(cache, hints._HINT_KIND_STRUCTURED);
    spy.mockRestore();
    expect(dedup_ok).toBe(false);
    expect(structured_ok).toBe(true);
  });

  it("test_index_only_budget_independent_of_dedup", () => {
    const cache = makeCache("hb_index_indep", tmpDataDir());
    cache.hints_emitted = 200; // dedup exhausted
    cache.index_only_hints_emitted = 2; // index-only has room

    const cfg = fakeConfig({
      hint_budget: { enabled: true, max_per_session: 100, max_index_only_per_session: 30 },
    });
    const spy = vi.spyOn(config, "load").mockReturnValue(cfg);
    const dedup_ok = hints._hint_budget_check(cache, hints._HINT_KIND_DEDUP);
    const index_only_ok = hints._hint_budget_check(cache, hints._HINT_KIND_INDEX_ONLY);
    spy.mockRestore();
    expect(dedup_ok).toBe(false);
    expect(index_only_ok).toBe(true);
  });

  it("test_structured_cap_enforced", () => {
    const cache = makeCache("hb_structured_cap", tmpDataDir());
    cache.structured_hints_emitted = 30; // at cap

    const cfg = fakeConfig({ hint_budget: { enabled: true, max_structured_per_session: 30 } });
    const spy = vi.spyOn(config, "load").mockReturnValue(cfg);
    const result = hints._hint_budget_check(cache, hints._HINT_KIND_STRUCTURED);
    spy.mockRestore();
    expect(result).toBe(false);
  });

  it("test_disabled_budget_always_emits", () => {
    const cache = makeCache("hb_disabled", tmpDataDir());
    cache.hints_emitted = 9999; // way over any cap

    const cfg = fakeConfig({ hint_budget: { enabled: false, max_per_session: 10 } });
    const spy = vi.spyOn(config, "load").mockReturnValue(cfg);
    const result = hints._hint_budget_check(cache, hints._HINT_KIND_DEDUP);
    spy.mockRestore();
    expect(result).toBe(true);
  });

  it("test_curator_and_budget_both_apply", () => {
    const cache = makeCache("hb_curator_combined", tmpDataDir());
    // Both curator and budget would suppress.
    cache.hints_emitted = 200; // budget: over cap
    cache.hints_ignored = 190; // curator: only 5% acceptance, well below 20% threshold

    // Curator check.
    const curCfg = fakeConfig({
      curator: { enabled: true, min_samples: 10, threshold_pct: 20 },
    });
    let spy = vi.spyOn(config, "load").mockReturnValue(curCfg);
    const curator_ok = hints._curator_should_emit(cache);
    spy.mockRestore();
    expect(curator_ok).toBe(false);

    // Budget check.
    const hbCfg = fakeConfig({ hint_budget: { enabled: true, max_per_session: 100 } });
    spy = vi.spyOn(config, "load").mockReturnValue(hbCfg);
    const budget_ok = hints._hint_budget_check(cache, hints._HINT_KIND_DEDUP);
    spy.mockRestore();
    expect(budget_ok).toBe(false);
  });
});

// ===========================================================================
// TestWebDedupGrepSuggest
// ===========================================================================

describe("TestWebDedupGrepSuggest", () => {
  function record(sid: string, url: string, args: { body_bytes: number }): void {
    const url_sha = web_cache.url_hash(url);
    const output_id = `web-${url_sha.slice(0, 8)}`;
    session.mark_web_fetch(sid, url_sha, url.slice(0, 200), output_id, args.body_bytes, 200, false);
  }

  it("test_below_grep_threshold_no_grep_suffix", () => {
    const sid = "s_web_grep_below";
    const url = "https://example.com/api/data";
    record(sid, url, { body_bytes: hints._BASH_DEDUP_GREP_SUGGEST_BYTES - 1 });
    const hint = build_web_dedup_hint({ session_id: sid, url });
    expect(hint).not.toBeNull();
    expect(hint!.text.includes("--grep")).toBe(false);
  });

  it("test_at_grep_threshold_includes_grep_suffix", () => {
    const sid = "s_web_grep_at";
    const url = "https://api.github.com/repos/owner/repo";
    record(sid, url, { body_bytes: hints._BASH_DEDUP_GREP_SUGGEST_BYTES });
    const hint = build_web_dedup_hint({ session_id: sid, url });
    expect(hint).not.toBeNull();
    expect(hint!.text.includes("--grep")).toBe(true);
    expect(hint!.text.includes("PATTERN")).toBe(true);
  });

  it("test_above_grep_threshold_includes_grep_suffix", () => {
    const sid = "s_web_grep_above";
    const url = "https://example.com/large-doc";
    record(sid, url, { body_bytes: 50000 });
    const hint = build_web_dedup_hint({ session_id: sid, url });
    expect(hint).not.toBeNull();
    expect(hint!.text.includes("--grep")).toBe(true);
  });

  it("test_grep_suffix_shown_only_once_per_session", () => {
    const sid = "s_web_recall_once";
    const url1 = "https://example.com/large-1";
    const url2 = "https://example.com/large-2";
    record(sid, url1, { body_bytes: hints._BASH_DEDUP_GREP_SUGGEST_BYTES + 100 });
    record(sid, url2, { body_bytes: hints._BASH_DEDUP_GREP_SUGGEST_BYTES + 200 });

    const cache = session.load(sid);

    // First large-body dedup should include the --grep suffix.
    const hint1 = build_web_dedup_hint({ session_id: sid, url: url1, cache });
    expect(hint1).not.toBeNull();
    expect(hint1!.text.includes("--grep")).toBe(true);

    // Second large-body dedup in the same session should omit --grep.
    const hint2 = build_web_dedup_hint({ session_id: sid, url: url2, cache });
    expect(hint2).not.toBeNull();
    expect(hint2!.text.includes("--grep")).toBe(false);
  });

  it("test_grep_suffix_omitted_when_cache_unavailable", () => {
    const sid = "s_web_recall_nocache";
    const url = "https://example.com/large-nocache";
    record(sid, url, { body_bytes: hints._BASH_DEDUP_GREP_SUGGEST_BYTES + 100 });

    // cache=None path — cannot suppress, so hint includes --grep.
    const hint = build_web_dedup_hint({ session_id: sid, url, cache: null });
    expect(hint).not.toBeNull();
    expect(hint!.text.includes("--grep")).toBe(true);
  });
});

// ===========================================================================
// TestCrossSessionGrepDedup
// ===========================================================================

describe("TestCrossSessionGrepDedup", () => {
  const PATTERN = "def test_login";

  function seedGlobal(
    _tmp: string,
    args: { count: number; last_ts: number; pattern?: string | null },
  ): void {
    const pat = args.pattern ?? PATTERN;
    const pat_hash = patternHash(pat);
    db.openGlobal((conn: DatabaseType) => {
      conn
        .prepare(
          "INSERT OR REPLACE INTO grep_patterns " +
            "(pattern_hash, first_pattern, last_ts, count) VALUES (?,?,?,?)",
        )
        .run(pat_hash, pat, args.last_ts, args.count);
    });
  }

  /** Run build_grep_dedup_hint for the test pattern (no prior session greps). */
  function hint(_tmp: string, sid = "xsess_sid_001"): hints.ReadHint | null {
    return build_grep_dedup_hint({ session_id: sid, pattern: PATTERN, path: null });
  }

  // --- cross-session hint fires ----------------------------------------

  it("test_cross_session_hint_fires_when_count_gte_3_and_recent", () => {
    const t = now();
    seedGlobal(tmpDataDir(), { count: 3, last_ts: t - 60 }); // 1 minute ago
    const h = hint(tmpDataDir());
    expect(h).not.toBeNull();
    expect(
      h!.text.toLowerCase().includes("frequent") || h!.text.toLowerCase().includes("semantic"),
    ).toBe(true);
  });

  it("test_cross_session_hint_fires_when_count_above_3", () => {
    const t = now();
    seedGlobal(tmpDataDir(), { count: 10, last_ts: t - 300 });
    const h = hint(tmpDataDir());
    expect(h).not.toBeNull();
    expect(h!.text.includes("token-goat semantic")).toBe(true);
  });

  it("test_cross_session_hint_includes_pattern_text", () => {
    const t = now();
    seedGlobal(tmpDataDir(), { count: 5, last_ts: t - 10 });
    const h = hint(tmpDataDir());
    expect(h).not.toBeNull();
    expect(h!.text.includes("test_login")).toBe(true);
  });

  // --- cross-session hint suppressed -----------------------------------

  it("test_cross_session_hint_suppressed_when_count_lt_3", () => {
    const t = now();
    seedGlobal(tmpDataDir(), { count: 2, last_ts: t - 60 });
    const h = hint(tmpDataDir());
    // No prior intra-session grep → no hint at all from either path.
    expect(h).toBeNull();
  });

  it("test_cross_session_hint_suppressed_when_last_ts_stale", () => {
    const t = now();
    const stale_ts = t - 3601; // just over 1 hour
    seedGlobal(tmpDataDir(), { count: 10, last_ts: stale_ts });
    const h = hint(tmpDataDir());
    expect(h).toBeNull();
  });

  it("test_cross_session_hint_suppressed_when_no_global_row", () => {
    const h = hint(tmpDataDir());
    expect(h).toBeNull();
  });

  it("test_cross_session_hint_suppressed_at_exactly_1h_boundary", () => {
    const t = now();
    seedGlobal(tmpDataDir(), { count: 5, last_ts: t - 3600 });
    const h = hint(tmpDataDir());
    expect(h).toBeNull();
  });

  // --- low-result patterns not written to global.db ---------------------

  it("test_low_result_count_not_written_to_global_db", () => {
    const sid = "xsess_low_results";
    // result_count is one below the threshold — must NOT write to global.db.
    session.mark_grep(sid, PATTERN, null, hints._GREP_DEDUP_MIN_RESULT_COUNT - 1);

    const row = db.openGlobal((conn: DatabaseType) => {
      return conn
        .prepare("SELECT count FROM grep_patterns WHERE first_pattern = ?")
        .get(PATTERN) as { count?: number } | undefined;
    });
    expect(row ?? null).toBeNull();
  });

  it("test_cross_session_hint_increments_grep_dedup_type_counter", () => {
    const t = now();
    seedGlobal(tmpDataDir(), { count: 5, last_ts: t - 30 });

    const sid = "xsess_type_counter";
    const cache = session.load(sid);
    const h = build_grep_dedup_hint({ session_id: sid, pattern: PATTERN, path: null, cache });

    expect(h).not.toBeNull();
    expect(cache.hints_emitted_by_type["grep_dedup"] ?? 0).toBe(1);
  });

  it("test_none_result_count_not_written_to_global_db", () => {
    const sid = "xsess_none_results";
    session.mark_grep(sid, PATTERN, null, null);

    const row = db.openGlobal((conn: DatabaseType) => {
      return conn
        .prepare("SELECT count FROM grep_patterns WHERE first_pattern = ?")
        .get(PATTERN) as { count?: number } | undefined;
    });
    expect(row ?? null).toBeNull();
  });

  it("test_sufficient_result_count_written_to_global_db", () => {
    const sid = "xsess_sufficient_results";
    session.mark_grep(sid, PATTERN, null, hints._GREP_DEDUP_MIN_RESULT_COUNT);

    const row = db.openGlobal((conn: DatabaseType) => {
      return conn
        .prepare("SELECT count FROM grep_patterns WHERE first_pattern = ?")
        .get(PATTERN) as { count?: number } | undefined;
    });
    expect(row ?? null).not.toBeNull();
    expect(row!.count).toBe(1);
  });

  // --- three-session simulation ----------------------------------------

  it("test_three_sessions_produce_count_3", () => {
    const pattern = "rg 'class Auth'";
    const pattern_hash = patternHash(pattern);

    const t0 = 1_000_000.0;
    db.update_global_grep_pattern(pattern_hash, pattern, t0);
    db.update_global_grep_pattern(pattern_hash, pattern, t0 + 86401);
    db.update_global_grep_pattern(pattern_hash, pattern, t0 + 2 * 86401);

    const row = db.openGlobal((conn: DatabaseType) => {
      return conn
        .prepare("SELECT count FROM grep_patterns WHERE pattern_hash = ?")
        .get(pattern_hash) as { count?: number } | undefined;
    });
    expect(row ?? null).not.toBeNull();
    expect(row!.count).toBe(3);
  });
});

// ===========================================================================
// TestRecallPathRelative
// ===========================================================================

describe("TestRecallPathRelative", () => {
  it("test_surgical_nudge_uses_relative_recall_path", () => {
    const sid = "s_relpath_nudge";
    const cwd = "C:/proj";
    const p = `${cwd}/src/auth.py`;
    // Mark the file read enough times to trigger the surgical-read nudge.
    for (let i = 0; i < hints._SUPPRESS_HINT_AT_READ_COUNT; i++) {
      session.mark_file_read(sid, p, i * 100, 100);
    }

    const hint = build_read_hint({ session_id: sid, file_path: p, offset: 0, limit: 100, cwd });
    expect(hint).not.toBeNull();
    expect(hint!.text.includes("src/auth.py")).toBe(true);
    expect(hint!.text.includes("C:/proj/src/auth.py")).toBe(false);
  });

  it("test_symbol_only_hint_uses_relative_recall_path", () => {
    const sid = "s_relpath_sym";
    const cwd = "C:/myproject";
    const p = `${cwd}/module/parser.py`;
    session.mark_file_read(sid, p, null, null, { symbol: "parse_token" });

    const hint = build_read_hint({ session_id: sid, file_path: p, offset: 0, limit: 2000, cwd });
    expect(hint).not.toBeNull();
    expect(hint!.text.includes("token-goat read")).toBe(true);
    expect(hint!.text.includes("module/parser.py")).toBe(true);
    expect(hint!.text.includes("C:/myproject/module/parser.py")).toBe(false);
  });

  it("test_no_cwd_falls_back_to_absolute_path", () => {
    const sid = "s_relpath_nocwd";
    const p = "C:/proj/src/auth.py";
    for (let i = 0; i < hints._SUPPRESS_HINT_AT_READ_COUNT; i++) {
      session.mark_file_read(sid, p, i * 100, 100);
    }

    const hint = build_read_hint({ session_id: sid, file_path: p, offset: 0, limit: 100, cwd: null });
    expect(hint).not.toBeNull();
    expect(hint!.text.includes("C:/proj/src/auth.py")).toBe(true);
  });

  it("test_path_not_under_cwd_keeps_absolute", () => {
    const sid = "s_relpath_outside";
    const cwd = "C:/other";
    const p = "C:/proj/src/auth.py";
    for (let i = 0; i < hints._SUPPRESS_HINT_AT_READ_COUNT; i++) {
      session.mark_file_read(sid, p, i * 100, 100);
    }

    const hint = build_read_hint({ session_id: sid, file_path: p, offset: 0, limit: 100, cwd });
    expect(hint).not.toBeNull();
    expect(hint!.text.includes("C:/proj/src/auth.py")).toBe(true);
  });
});

// ===========================================================================
// TestProximityCheck
// ===========================================================================

describe("TestProximityCheck", () => {
  it("test_far_ahead_read_suppresses_hint", () => {
    const sid = "s_prox_ahead";
    const p = "C:/proj/longfile.py";
    // Mark lines 1-50 as cached.
    session.mark_file_read(sid, p, 0, 50);

    // Request lines far past the end of the cached range + slop.
    const far_offset = 50 + hints._PROXIMITY_SLOP_LINES + 10;
    const hint = build_read_hint({
      session_id: sid,
      file_path: p,
      offset: far_offset,
      limit: 100,
      cwd: null,
    });
    expect(hint).toBeNull();
  });

  it("test_far_before_read_suppresses_hint", () => {
    const sid = "s_prox_before";
    const p = "C:/proj/longfile2.py";
    // Mark lines 500-600 as cached (offset=499, limit=101 → 1-indexed start=500).
    session.mark_file_read(sid, p, 499, 101);

    // Request lines well before the cached range (before min - slop).
    const early_hint = build_read_hint({
      session_id: sid,
      file_path: p,
      offset: 0,
      limit: 50,
      cwd: null,
    });
    expect(early_hint).toBeNull();
  });

  it("test_nearby_read_still_emits_hint", () => {
    const sid = "s_prox_near";
    const p = "C:/proj/nearfile.py";
    // Mark lines 1-50 as cached.
    session.mark_file_read(sid, p, 0, 50);

    // Request lines just within the proximity slop (overlapping range: 30-130).
    // build_read_hint must not raise for near-range overlap.
    build_read_hint({ session_id: sid, file_path: p, offset: 29, limit: 100, cwd: null });
    // Same-range hint must also not raise.
    build_read_hint({ session_id: sid, file_path: p, offset: 0, limit: 50, cwd: null });
    // Verify proximity constant is a positive integer (sanity check on the export).
    expect(hints._PROXIMITY_SLOP_LINES > 0).toBe(true);
  });
});

// ===========================================================================
// TestJsonSidecar
// ===========================================================================

describe("TestJsonSidecar", () => {
  it("test_sidecar_off_by_default", () => {
    delete process.env["TOKEN_GOAT_HINT_JSON_SIDECAR"];
    const sid = "s_sidecar_off";
    const p = "C:/proj/sidecar_off.py";
    _mark(tmpDataDir(), sid, p, { offset: 0, limit: 200 });

    const hint = build_read_hint({ session_id: sid, file_path: p, offset: 0, limit: 200, cwd: null });
    expect(hint).not.toBeNull();
    // No leading JSON object — the prose starts with the backtick filename.
    expect(String(hint).startsWith("{")).toBe(false);
  });

  it("test_sidecar_on_prepends_json_line", () => {
    process.env["TOKEN_GOAT_HINT_JSON_SIDECAR"] = "1";
    config.clearConfigCache();

    const sid = "s_sidecar_on";
    const p = "C:/proj/sidecar_on.py";
    _mark(tmpDataDir(), sid, p, { offset: 0, limit: 200 });

    const hint = build_read_hint({ session_id: sid, file_path: p, offset: 0, limit: 200, cwd: null });
    expect(hint).not.toBeNull();
    const text = String(hint);
    const idx = text.indexOf("\n");
    const first_line = idx >= 0 ? text.slice(0, idx) : text;
    const rest = idx >= 0 ? text.slice(idx + 1) : "";
    const payload = JSON.parse(first_line) as Record<string, unknown>;
    expect(payload["hint"]).toBe("already_read");
    expect(payload["file"]).toBe(p);
    expect(payload["wasted"] as number).toBeGreaterThan(0);
    // Prose portion still contains the cache marker — unchanged.
    expect(rest.includes("⌘")).toBe(true);
  });

  it("test_sidecar_preserves_tokens_saved", () => {
    process.env["TOKEN_GOAT_HINT_JSON_SIDECAR"] = "1";
    config.clearConfigCache();

    const sid = "s_sidecar_tokens";
    const p = "C:/proj/sidecar_tokens.py";
    _mark(tmpDataDir(), sid, p, { offset: 0, limit: 200 });

    const hint = build_read_hint({ session_id: sid, file_path: p, offset: 0, limit: 200, cwd: null });
    expect(hint).not.toBeNull();
    expect(hint!.tokens_saved).toBeGreaterThan(0);
  });

  it("test_sidecar_failsoft_on_bad_payload", () => {
    process.env["TOKEN_GOAT_HINT_JSON_SIDECAR"] = "1";
    config.clearConfigCache();

    const original = new hints.ReadHint("prose only", 42);
    // A circular object is not JSON-serialisable — helper must catch and fall back.
    const bad: Record<string, unknown> = {};
    bad["self"] = bad;
    const result = hints._emit_json_sidecar(original, "already_read", { bad });
    expect(result).toBe(original);
  });

  it("test_sidecar_disabled_returns_original_hint", () => {
    delete process.env["TOKEN_GOAT_HINT_JSON_SIDECAR"];
    config.clearConfigCache();

    const original = new hints.ReadHint("untouched prose", 7);
    const result = hints._emit_json_sidecar(original, "already_read", { file: "x" });
    expect(result).toBe(original);
    expect(String(result)).toBe("untouched prose");
  });

  it("test_sidecar_drops_none_fields", () => {
    process.env["TOKEN_GOAT_HINT_JSON_SIDECAR"] = "1";
    config.clearConfigCache();

    const original = new hints.ReadHint("prose", 10);
    const wrapped = hints._emit_json_sidecar(original, "diff_since_last_read", {
      file: "x.py",
      added: 2,
      line: null,
    });
    expect(wrapped).not.toBeNull();
    const text = String(wrapped);
    const idx = text.indexOf("\n");
    const first_line = idx >= 0 ? text.slice(0, idx) : text;
    const payload = JSON.parse(first_line) as Record<string, unknown>;
    expect("line" in payload).toBe(false);
    expect(payload["added"]).toBe(2);
  });

  it("test_all_dedup_hints_have_consistent_sidecars", () => {
    process.env["TOKEN_GOAT_HINT_JSON_SIDECAR"] = "1";
    config.clearConfigCache();

    const sid = "s_dedup_sidecars";

    // Record bash command
    const cmd = "pytest tests/";
    const cmd_sha = bash_cache.command_hash(cmd);
    session.mark_bash_run(sid, cmd_sha, cmd, `out_${cmd_sha.slice(0, 8)}`, 2000, 0, 0, false);

    // Record grep pattern
    session.mark_grep(sid, "test_", "src/", 12);

    // Record glob pattern
    session.mark_glob_run(sid, "*.py", "src/", 25);

    // Record web URL
    const url = "https://example.com/docs.html";
    const url_sha = web_cache.url_hash(url);
    session.mark_web_fetch(sid, url_sha, url, `web_${url_sha.slice(0, 8)}`, 5000, 200, false);

    // Test bash_dedup_hint
    const bash_hint = build_bash_dedup_hint({ session_id: sid, command: cmd });
    expect(bash_hint).not.toBeNull();
    const bash_payload = JSON.parse(String(bash_hint).split("\n")[0]!) as Record<string, unknown>;
    expect(bash_payload["hint"]).toBe("bash_dedup");
    expect("command" in bash_payload).toBe(true);
    expect("bytes_size" in bash_payload).toBe(true);
    expect("wasted" in bash_payload).toBe(true);

    // Test grep_dedup_hint
    const grep_hint = build_grep_dedup_hint({ session_id: sid, pattern: "test_", path: "src/" });
    expect(grep_hint).not.toBeNull();
    const grep_payload = JSON.parse(String(grep_hint).split("\n")[0]!) as Record<string, unknown>;
    expect(grep_payload["hint"]).toBe("grep_dedup");
    expect("pattern" in grep_payload).toBe(true);
    expect("result_count" in grep_payload).toBe(true);

    // Test glob_dedup_hint
    const glob_hint = build_glob_dedup_hint({ session_id: sid, pattern: "*.py", path: "src/" });
    expect(glob_hint).not.toBeNull();
    const glob_payload = JSON.parse(String(glob_hint).split("\n")[0]!) as Record<string, unknown>;
    expect(glob_payload["hint"]).toBe("glob_dedup");
    expect("pattern" in glob_payload).toBe(true);
    expect("result_count" in glob_payload).toBe(true);

    // Test web_dedup_hint
    const web_hint = build_web_dedup_hint({ session_id: sid, url });
    expect(web_hint).not.toBeNull();
    const web_payload = JSON.parse(String(web_hint).split("\n")[0]!) as Record<string, unknown>;
    expect(web_payload["hint"]).toBe("web_dedup");
    expect("url" in web_payload).toBe(true);
    expect("bytes_size" in web_payload).toBe(true);
  });

  it("test_sidecar_json_parseable_for_all_hint_types", () => {
    process.env["TOKEN_GOAT_HINT_JSON_SIDECAR"] = "1";
    config.clearConfigCache();

    const sid = "s_json_parse_test";

    // Test bash dedup
    const cmd = "echo test";
    const cmd_sha = bash_cache.command_hash(cmd);
    session.mark_bash_run(sid, cmd_sha, cmd, `out_${cmd_sha.slice(0, 8)}`, 2500, 0, 0, false);
    let hint = build_bash_dedup_hint({ session_id: sid, command: cmd });
    expect(hint).not.toBeNull();
    let payload = JSON.parse(String(hint).split("\n")[0]!) as Record<string, unknown>;
    expect("hint" in payload).toBe(true);
    expect(payload["hint"]).toBe("bash_dedup");
    expect("command" in payload).toBe(true);
    expect("wasted" in payload).toBe(true);

    // Test grep dedup
    session.mark_grep(sid, "test_pattern", "src/", 15);
    hint = build_grep_dedup_hint({ session_id: sid, pattern: "test_pattern", path: "src/" });
    expect(hint).not.toBeNull();
    payload = JSON.parse(String(hint).split("\n")[0]!) as Record<string, unknown>;
    expect("hint" in payload).toBe(true);
    expect(payload["hint"]).toBe("grep_dedup");
    expect("pattern" in payload).toBe(true);
    expect("result_count" in payload).toBe(true);

    // Test glob dedup
    session.mark_glob_run(sid, "*.py", "src/", 30);
    hint = build_glob_dedup_hint({ session_id: sid, pattern: "*.py", path: "src/" });
    expect(hint).not.toBeNull();
    payload = JSON.parse(String(hint).split("\n")[0]!) as Record<string, unknown>;
    expect("hint" in payload).toBe(true);
    expect(payload["hint"]).toBe("glob_dedup");
    expect("pattern" in payload).toBe(true);
    expect("result_count" in payload).toBe(true);

    // Test web dedup
    const url = "https://docs.example.com/api.html";
    const url_sha = web_cache.url_hash(url);
    session.mark_web_fetch(sid, url_sha, url, `web_${url_sha.slice(0, 8)}`, 3000, 200, false);
    hint = build_web_dedup_hint({ session_id: sid, url });
    expect(hint).not.toBeNull();
    payload = JSON.parse(String(hint).split("\n")[0]!) as Record<string, unknown>;
    expect("hint" in payload).toBe(true);
    expect(payload["hint"]).toBe("web_dedup");
    expect("url" in payload).toBe(true);
    expect("bytes_size" in payload).toBe(true);
    expect("wasted" in payload).toBe(true);
  });
});

// ===========================================================================
// TestBashDedupStaleStat
// ===========================================================================

describe("TestBashDedupStaleStat", () => {
  function recordStale(sid: string, cmd: string, args: { stdout_bytes?: number } = {}): void {
    const stdout_bytes = args.stdout_bytes ?? 1000;
    const cmd_sha = bash_cache.command_hash(cmd);
    const output_id = `out_${cmd_sha.slice(0, 8)}`;
    session.mark_bash_run(sid, cmd_sha, cmd.slice(0, 120), output_id, stdout_bytes, 0, 0, false);
    // Backdate the entry past the stale threshold so the next build_bash_dedup_hint
    // call falls through to the suppression branch.
    const cache = session.load(sid);
    const entry = cache.bash_history[cmd_sha]!;
    entry.ts = now() - (STALE_READ_AGE_SECONDS + 60);
    cache._invalidate_json_cache();
    session.save(cache);
  }

  it("test_stale_entry_records_bash_dedup_stale", () => {
    const sid = "s_bash_stale";
    const cmd = "uv run pytest tests/ -v";
    recordStale(sid, cmd, { stdout_bytes: 2000 });

    const recorded: Array<{ kind: string; bytesSaved?: number | undefined; tokensSaved?: number | undefined }> = [];
    const spy = vi
      .spyOn(db, "recordStat")
      .mockImplementation((_projectHash, kind, opts = {}) => {
        recorded.push({ kind, bytesSaved: opts.bytesSaved, tokensSaved: opts.tokensSaved });
      });
    const hint = build_bash_dedup_hint({ session_id: sid, command: cmd });
    spy.mockRestore();

    expect(hint).toBeNull(); // stale entry must suppress the hint

    const stale_rows = recorded.filter((r) => r.kind === "bash_dedup_stale");
    expect(stale_rows.length).toBe(1);
    expect(stale_rows[0]!.bytesSaved).toBe(0);
    expect(stale_rows[0]!.tokensSaved).toBe(0);
    // No companion bash_dedup_hint row should fire when suppressed.
    const hit_rows = recorded.filter((r) => r.kind === "bash_dedup_hint");
    expect(hit_rows).toEqual([]);
  });

  it("test_fresh_entry_does_not_record_stale", () => {
    const sid = "s_bash_fresh";
    const cmd = "uv run pytest tests/ -v";
    const cmd_sha = bash_cache.command_hash(cmd);
    session.mark_bash_run(sid, cmd_sha, cmd.slice(0, 120), `out_${cmd_sha.slice(0, 8)}`, 2000, 0, 0, false);

    const recorded: Array<{ kind: string }> = [];
    const spy = vi.spyOn(db, "recordStat").mockImplementation((_projectHash, kind) => {
      recorded.push({ kind });
    });
    const hint = build_bash_dedup_hint({ session_id: sid, command: cmd });
    spy.mockRestore();

    expect(hint).not.toBeNull(); // fresh entry must emit a hint
    const stale_rows = recorded.filter((r) => r.kind === "bash_dedup_stale");
    expect(stale_rows).toEqual([]);
  });
});

// ===========================================================================
// TestWebDedupStaleStat
// ===========================================================================

describe("TestWebDedupStaleStat", () => {
  function recordStale(
    sid: string,
    url: string,
    args: { body_bytes?: number } = {},
  ): void {
    const body_bytes = args.body_bytes ?? 2000;
    const url_sha = web_cache.url_hash(url);
    const output_id = `web_${url_sha.slice(0, 8)}`;
    session.mark_web_fetch(sid, url_sha, url, output_id, body_bytes, 200, false);
    const cache = session.load(sid);
    const entry = cache.web_history[url_sha]!;
    entry.ts = now() - (STALE_READ_AGE_SECONDS + 60);
    cache._invalidate_json_cache();
    session.save(cache);
  }

  it("test_stale_entry_records_web_dedup_stale", () => {
    const sid = "s_web_stale";
    const url = "https://example.com/doc.html";
    recordStale(sid, url, { body_bytes: 4000 });

    const recorded: Array<{ kind: string; bytesSaved?: number | undefined; tokensSaved?: number | undefined }> = [];
    const spy = vi
      .spyOn(db, "recordStat")
      .mockImplementation((_projectHash, kind, opts = {}) => {
        recorded.push({ kind, bytesSaved: opts.bytesSaved, tokensSaved: opts.tokensSaved });
      });
    const hint = build_web_dedup_hint({ session_id: sid, url });
    spy.mockRestore();

    expect(hint).toBeNull();

    const stale_rows = recorded.filter((r) => r.kind === "web_dedup_stale");
    expect(stale_rows.length).toBe(1);
    expect(stale_rows[0]!.bytesSaved).toBe(0);
    expect(stale_rows[0]!.tokensSaved).toBe(0);
    const hit_rows = recorded.filter((r) => r.kind === "web_dedup_hint");
    expect(hit_rows).toEqual([]);
  });

  it("test_fresh_entry_does_not_record_stale", () => {
    const sid = "s_web_fresh";
    const url = "https://example.com/doc.html";
    const url_sha = web_cache.url_hash(url);
    session.mark_web_fetch(sid, url_sha, url, `web_${url_sha.slice(0, 8)}`, 4000, 200, false);

    const recorded: Array<{ kind: string }> = [];
    const spy = vi.spyOn(db, "recordStat").mockImplementation((_projectHash, kind) => {
      recorded.push({ kind });
    });
    const hint = build_web_dedup_hint({ session_id: sid, url });
    spy.mockRestore();

    expect(hint).not.toBeNull();
    const stale_rows = recorded.filter((r) => r.kind === "web_dedup_stale");
    expect(stale_rows).toEqual([]);
  });
});

// ===========================================================================
// TestMinFileLinesForHint
// ===========================================================================

describe("TestMinFileLinesForHint", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("test_threshold_zero_disabled_emits_all_hints", () => {
    const cfg = fakeConfig({ hints: { min_file_lines_for_hint: 0 } });
    vi.spyOn(config, "load").mockReturnValue(cfg);

    const sid = "s_min_lines_zero";
    const p = path.join(tmpDataDir(), "medium.py");
    // Use 200 lines to exceed MIN_OVERLAP_TO_WARN (50).
    fs.writeFileSync(
      p,
      Array.from({ length: 200 }, (_, i) => `x = ${i + 1}`).join("\n"),
      "utf8",
    );
    // Mark ranges that will create a 60-line overlap hint.
    session.mark_file_read(sid, p, 0, 100); // Lines 1-100
    session.mark_file_read(sid, p, 40, 100); // Lines 41-140 (overlap 41-100 = 60 lines)

    // Verify the suppression helper behaves correctly.
    expect(hints._should_suppress_full_file_hint(200)).toBe(false);

    const hint = build_read_hint({
      session_id: sid,
      file_path: p,
      offset: 40,
      limit: 100,
      cwd: tmpDataDir(),
    });
    expect(hint).not.toBeNull();
  });

  it("test_threshold_30_file_25_lines_suppressed", () => {
    const cfg = fakeConfig({ hints: { min_file_lines_for_hint: 30 } });
    vi.spyOn(config, "load").mockReturnValue(cfg);
    // Python monkeypatches hints._indexed_line_count -> None to skip the slow
    // find_project walk. Here the per-test tmp data dir has no project marker, so
    // _indexed_line_count() naturally returns null and the disk-fallback (_line_count)
    // path is exercised — the same branch the Python patch forces.

    const sid = "s_min_lines_30_small";
    const p = path.join(tmpDataDir(), "small.py");
    // 25 lines exactly, which is < 30.
    fs.writeFileSync(p, Array.from({ length: 25 }, (_, i) => `x = ${i + 1}`).join("\n"), "utf8");
    session.mark_file_read(sid, p, 0, 15); // Lines 1-15
    session.mark_file_read(sid, p, 5, 15); // Lines 6-20 (overlap 6-15 = 10 lines)

    const hint = build_read_hint({
      session_id: sid,
      file_path: p,
      offset: 5,
      limit: 15,
      cwd: tmpDataDir(),
    });
    expect(hint).toBeNull();
  });

  it("test_threshold_30_file_100_lines_emitted", () => {
    const cfg = fakeConfig({ hints: { min_file_lines_for_hint: 30 } });
    vi.spyOn(config, "load").mockReturnValue(cfg);

    const sid = "s_min_lines_30_large";
    const p = path.join(tmpDataDir(), "large.py");
    fs.writeFileSync(p, Array.from({ length: 100 }, (_, i) => `x = ${i + 1}`).join("\n"), "utf8");
    // Create overlapping ranges with 60+ line overlap to emit a hint.
    session.mark_file_read(sid, p, 0, 80); // Lines 1-80
    session.mark_file_read(sid, p, 20, 80); // Lines 21-100 (overlap 21-80 = 60 lines)

    const hint = build_read_hint({
      session_id: sid,
      file_path: p,
      offset: 20,
      limit: 80,
      cwd: tmpDataDir(),
    });
    expect(hint).not.toBeNull();
  });

  it("test_large_file_partially_read_not_suppressed", () => {
    const cfg = fakeConfig({ hints: { min_file_lines_for_hint: 300 } });
    vi.spyOn(config, "load").mockReturnValue(cfg);
    // _indexed_line_count() returns null naturally (tmp dir is not an indexed
    // project), forcing the disk-fallback path the Python patch emulates.

    const sid = "s_large_partial_no_suppress";
    const p = path.join(tmpDataDir(), "large_partially_read.py");
    // 500-line file: actual line count (500) > threshold (300), but partial read
    // produces max_line=200 < threshold=300 — the proxy would incorrectly suppress.
    fs.writeFileSync(p, Array.from({ length: 500 }, (_, i) => `x = ${i + 1}`).join("\n"), "utf8");

    // Two overlapping reads of lines 1-200 (overlap = 200 lines >> MIN_OVERLAP_TO_WARN=50).
    session.mark_file_read(sid, p, 0, 200); // Lines 1-200
    session.mark_file_read(sid, p, 50, 150); // Lines 51-200 (overlap 51-200)

    // Re-read with limit=150 (> _NARROW_EXPLICIT_READ_LINES=50 → not narrow surgical).
    const hint = build_read_hint({
      session_id: sid,
      file_path: p,
      offset: 50,
      limit: 150,
      cwd: tmpDataDir(),
    });
    expect(hint).not.toBeNull();
  });

  it("test_symbol_hint_emitted_when_line_ranges_also_present", () => {
    const cfg = fakeConfig({ hints: { min_file_lines_for_hint: 100 } });
    vi.spyOn(config, "load").mockReturnValue(cfg);
    // _indexed_line_count() returns null naturally (no indexed project), so the
    // disk-fallback path runs — the branch the Python patch forces.

    const sid = "s_symbol_plus_ranges_small";
    const p = path.join(tmpDataDir(), "small_mixed_access.py");
    // 60-line file: below threshold=100, but 60 lines of overlap > MIN_OVERLAP_TO_WARN=50
    fs.writeFileSync(p, Array.from({ length: 60 }, (_, i) => `x = ${i + 1}`).join("\n"), "utf8");

    // Regular read → populates line_ranges[(1, 60)]
    session.mark_file_read(sid, p, 0, 60);
    // Symbol read → populates symbols_read["foo"] without adding line ranges
    session.mark_file_read(sid, p, 0, 60, { symbol: "foo" });

    // Re-read with no explicit limit: has_explicit_limit=False, overlap=60 > 50.
    const hint = build_read_hint({
      session_id: sid,
      file_path: p,
      offset: 0,
      limit: null,
      cwd: tmpDataDir(),
    });
    expect(hint).not.toBeNull();
    expect(hint!.text.includes("token-goat read")).toBe(true);
  });

  it("test_symbol_hints_never_suppressed", () => {
    const cfg = fakeConfig({ hints: { min_file_lines_for_hint: 30 } });
    vi.spyOn(config, "load").mockReturnValue(cfg);

    const sid = "s_min_lines_symbol";
    const p = path.join(tmpDataDir(), "tiny_with_symbol.py");
    fs.writeFileSync(p, "def foo():\n    pass\n", "utf8");
    session.mark_file_read(sid, p, 0, 10, { symbol: "foo" });

    const hint = build_read_hint({
      session_id: sid,
      file_path: p,
      offset: 0,
      limit: 10,
      cwd: tmpDataDir(),
    });
    // Symbol-only hint still emits (surgical reads not suppressed).
    expect(hint).not.toBeNull();
  });

  it("test_no_line_count_avoids_suppression", () => {
    const cfg = fakeConfig({ hints: { min_file_lines_for_hint: 30 } });
    vi.spyOn(config, "load").mockReturnValue(cfg);
    // Python monkeypatches hints.find_project -> None to avoid a slow directory
    // walk. Here the per-test tmp data dir has no project marker, so find_project
    // naturally returns null — the same path the Python patch forces.

    // Verify that None line count bypasses suppression.
    expect(hints._should_suppress_full_file_hint(null)).toBe(false);

    const sid = "s_min_lines_no_count";
    const p = path.join(tmpDataDir(), "nonexistent.py");
    // Do not write the file or mark it as read.

    const hint = build_read_hint({
      session_id: sid,
      file_path: p,
      offset: 0,
      limit: 10,
      cwd: tmpDataDir(),
    });
    // No hint expected anyway (file not in index), but test confirms no crash.
    expect(hint).toBeNull();
  });
});

// ===========================================================================
// TestReadHintEmittedByTypeRouting
// ===========================================================================

describe("TestReadHintEmittedByTypeRouting", () => {
  it("test_build_read_hint_does_not_increment_any_counter", () => {
    const sid = "kind_routing_reread";
    const p = "C:/proj/routing_test.py";
    _mark(tmpDataDir(), sid, p, { offset: 0, limit: 200 });
    const cache = session.load(sid);

    const hint = build_read_hint({
      session_id: sid,
      file_path: p,
      offset: 0,
      limit: 200,
      cwd: null,
      cache,
    });

    expect(hint).not.toBeNull();
    expect(hint!.tokens_saved).toBeGreaterThan(0);
    // Counters must NOT be incremented here — pre_read does it after dedup.
    expect(cache.hints_emitted_by_type).toEqual({});
    expect(cache.hints_emitted).toBe(0);
  });

  it("test_suggestion_hint_also_defers_counter", () => {
    const sid = "kind_routing_suggest";
    const p = "C:/proj/routing_suggest.py";
    const cache = session.load(sid);

    build_read_hint({ session_id: sid, file_path: p, offset: 0, limit: 200, cwd: null, cache });

    expect(cache.hints_emitted_by_type).toEqual({});
    expect(cache.hints_emitted).toBe(0);
  });
});

// ===========================================================================
// TestGlobDedupBelowThresholdSuppression
// ===========================================================================

describe("TestGlobDedupBelowThresholdSuppression", () => {
  it("test_glob_below_threshold_records_suppression", () => {
    const sid = "glob_below_thresh";
    const pattern = "**/*.py";
    // Record a glob run with a result count one below the threshold.
    session.mark_glob_run(
      sid,
      pattern,
      null,
      Math.max(0, hints._GLOB_DEDUP_MIN_RESULT_COUNT - 1),
    );
    const cache = session.load(sid);

    const result = build_glob_dedup_hint({ session_id: sid, pattern, path: null, cache });

    expect(result).toBeNull();
    expect(cache.hints_suppressed_by_type["glob_dedup_below_threshold"] ?? 0).toBe(1);
  });

  it("test_glob_none_result_count_records_suppression", () => {
    const sid = "glob_none_count";
    const pattern = "src/**/*.ts";
    session.mark_glob_run(sid, pattern, null, null);
    const cache = session.load(sid);

    const result = build_glob_dedup_hint({ session_id: sid, pattern, path: null, cache });

    expect(result).toBeNull();
    expect(cache.hints_suppressed_by_type["glob_dedup_below_threshold"] ?? 0).toBe(1);
  });

  it("test_glob_above_threshold_does_not_record_suppression", () => {
    const sid = "glob_above_thresh";
    const pattern = "**/*.go";
    session.mark_glob_run(sid, pattern, null, hints._GLOB_DEDUP_MIN_RESULT_COUNT + 5);
    const cache = session.load(sid);

    build_glob_dedup_hint({ session_id: sid, pattern, path: null, cache });

    expect(cache.hints_suppressed_by_type["glob_dedup_below_threshold"] ?? 0).toBe(0);
  });
});
