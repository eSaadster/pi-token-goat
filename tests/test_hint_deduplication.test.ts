/**
 * Unit tests for hint-seen deduplication in session cache.
 *
 * 1:1 port of tests/test_hint_deduplication.py. Each Python `def test_*` maps to
 * a vitest `it()` with the SAME name and the same assertion polarity; each Python
 * class maps to a describe().
 *
 * ReadHint assertion mapping (Python str-subclass → TS class; see hints.ts file
 * header):
 *   - Python `str(hint)`            → TS `String(hint)` / `hint.text`
 *   - Python `"x" in str(hint)`     → TS `String(hint).includes("x")`
 *   - Python `hint.tokens_saved`    → TS `hint.tokens_saved`
 *   - Python `f"seen {n}×" in str(h)` → TS `String(h).includes(`seen ${n}×`)`
 *
 * Construction mapping:
 *   - Python `session.SessionCache("id", 0, 0)` (positional) → TS
 *     `new session.SessionCache({ session_id: "id", started_ts: 0,
 *     last_activity_ts: 0 })` (the TS dataclass port takes an init object).
 *
 * Fixture mapping:
 *   - the `tmp_data_dir` autouse fixture is provided by tests/setup.ts
 *     (beforeEach → setDataDirOverride + clearModuleCaches), so the parameter is
 *     simply dropped from the TS signatures.
 *
 * Deferred: the entire `TestEmitDedupBudgetedHintVerboseWindow` class imports
 * `_emit_dedup_budgeted_hint` from `token_goat.hooks_read`, which is NOT YET
 * PORTED. Those tests are skipped with `it.skip(... )` + a "// PORT: deferred"
 * reason and retained so the parity surface stays visible.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import * as session from "../src/token_goat/session.js";
import * as config from "../src/token_goat/config.js";
import { ReadHint, _hint_fingerprint, _make_short_stub_hint } from "../src/token_goat/hints.js";
import { SESSION_SCHEMA_VERSION } from "../src/token_goat/session.js";
import { _emit_dedup_budgeted_hint } from "../src/token_goat/hooks_read.js";

// ---------------------------------------------------------------------------
// Helper: build a SessionCache the way Python's positional
// SessionCache(session_id, started_ts, last_activity_ts) does.
// ---------------------------------------------------------------------------
function makeCache(
  session_id: string,
  started_ts = 0,
  last_activity_ts = 0,
): session.SessionCache {
  return new session.SessionCache({ session_id, started_ts, last_activity_ts });
}

describe("TestHintFingerprint", () => {
  it("test_fingerprint_is_deterministic", () => {
    // Same hint text produces same fingerprint.
    const hint_text = "This is a test hint about file.py";
    const fp1 = _hint_fingerprint(hint_text);
    const fp2 = _hint_fingerprint(hint_text);
    expect(fp1).toBe(fp2);
  });

  it("test_fingerprint_length", () => {
    // Fingerprint is 12 hex characters.
    const hint_text = "Some hint";
    const fp = _hint_fingerprint(hint_text);
    expect(fp.length).toBe(12);
    expect([...fp].every((c) => "0123456789abcdef".includes(c))).toBe(true);
  });

  it("test_different_text_different_fingerprint", () => {
    // Different hint text produces different fingerprints.
    const fp1 = _hint_fingerprint("Hint one");
    const fp2 = _hint_fingerprint("Hint two");
    expect(fp1).not.toBe(fp2);
  });

  it("test_fingerprint_handles_unicode", () => {
    // Fingerprint works with unicode text.
    const hint_text = "File 📁 cached 🚀";
    const fp = _hint_fingerprint(hint_text);
    expect(fp.length).toBe(12);
  });
});

describe("TestSessionCacheHintMethods", () => {
  it("test_has_hint_fingerprint_empty_by_default", () => {
    // New cache has no hints seen.
    const cache = makeCache("test_session");
    expect(cache.has_hint_fingerprint("abc123def456")).toBe(false);
  });

  it("test_mark_hint_seen_records_fingerprint", () => {
    // mark_hint_seen adds fingerprint to hints_seen set.
    const cache = makeCache("test_session");
    const fp = "abc123def456";

    // Initially not seen
    expect(cache.has_hint_fingerprint(fp)).toBe(false);

    // Mark as seen
    cache.mark_hint_seen(fp);

    // Now it's seen
    expect(cache.has_hint_fingerprint(fp)).toBe(true);
  });

  it("test_mark_hint_seen_idempotent", () => {
    // Calling mark_hint_seen twice with same fingerprint increments count.
    const cache = makeCache("test_session");
    const fp = "abc123def456";

    // Mark twice
    cache.mark_hint_seen(fp);
    cache.mark_hint_seen(fp);

    // Still in the dict, count incremented to 2
    expect(cache.has_hint_fingerprint(fp)).toBe(true);
    expect(cache.hints_seen[fp]).toBe(2);
  });

  it("test_mark_hint_seen_persists_to_disk", () => {
    // mark_hint_seen updates in-memory state; save() flushes to disk.
    const session_id = "test_session_persist";

    // Create and mark hint — sets _pending_hint_save but does NOT write yet
    const cache1 = makeCache(session_id);
    const fp = "abc123def456";
    cache1.mark_hint_seen(fp);
    expect(cache1._pending_hint_save).toBeTruthy(); // Flag must be set after mark_hint_seen

    // Explicitly flush (simulates what pre_read or mark_file_read does)
    cache1._pending_hint_save = false;
    session.save(cache1);

    // Reload from disk
    const cache2 = session.load(session_id);

    // Fingerprint should be present
    expect(cache2.has_hint_fingerprint(fp)).toBe(true);
  });

  it("test_hints_seen_serialization_round_trip", () => {
    // hints_seen serializes to JSON and deserializes correctly.
    const cache = makeCache("test_session");
    cache.hints_seen["abc123def456"] = 1;
    cache.hints_seen["xyz789uvw012"] = 2;

    // Serialize
    const d = cache.to_dict();
    expect("hints_seen" in d).toBe(true);
    const serialized = d.hints_seen;
    // Python `isinstance(d["hints_seen"], dict)` — the new format is an object map,
    // not the legacy list. Narrow off the array branch of the union.
    expect(typeof serialized === "object" && serialized !== null && !Array.isArray(serialized)).toBe(
      true,
    );
    expect(serialized !== undefined && Object.keys(serialized).length === 2).toBe(true);

    // Deserialize
    const cache2 = session.SessionCache.from_dict(d as unknown as Record<string, unknown>);
    expect(cache2.has_hint_fingerprint("abc123def456")).toBe(true);
    expect(cache2.has_hint_fingerprint("xyz789uvw012")).toBe(true);
    expect(cache2.hints_seen["abc123def456"]).toBe(1);
    expect(cache2.hints_seen["xyz789uvw012"]).toBe(2);
  });

  it("test_hints_seen_empty_dict_on_new_cache", () => {
    // New cache serializes with empty hints_seen dict.
    const cache = makeCache("test");
    const d = cache.to_dict();
    expect(d.hints_seen ?? {}).toEqual({});
  });

  it("test_hints_seen_missing_field_backward_compat", () => {
    // from_dict handles missing hints_seen field gracefully.
    const d = {
      schema_version: SESSION_SCHEMA_VERSION,
      created_by: "token-goat",
      session_id: "test",
      started_ts: 0,
      last_activity_ts: 0,
      files: {},
      greps: [],
      edited_files: {},
    };
    const cache = session.SessionCache.from_dict(d as Record<string, unknown>);
    expect(typeof cache.hints_seen === "object" && cache.hints_seen !== null).toBe(true);
    expect(Object.keys(cache.hints_seen).length).toBe(0);
  });

  it("test_hints_seen_corrupt_entry_skipped", () => {
    // from_dict (legacy format) converts list[str] to dict[str, int].
    const d = {
      schema_version: SESSION_SCHEMA_VERSION,
      created_by: "token-goat",
      session_id: "test",
      started_ts: 0,
      last_activity_ts: 0,
      files: {},
      greps: [],
      edited_files: {},
      hints_seen: ["abc123def456", 123, null, "xyz789uvw012", ""],
    };
    const cache = session.SessionCache.from_dict(d as Record<string, unknown>);
    expect(cache.has_hint_fingerprint("abc123def456")).toBe(true);
    expect(cache.has_hint_fingerprint("xyz789uvw012")).toBe(true);
    expect(Object.keys(cache.hints_seen).length).toBe(2);
    // Legacy list format is converted to count=1 for each entry
    expect(cache.hints_seen["abc123def456"]).toBe(1);
    expect(cache.hints_seen["xyz789uvw012"]).toBe(1);
  });
});

describe("TestReadHintIntegration", () => {
  it("test_read_hint_fingerprint_stability", () => {
    // ReadHint text produces stable fingerprints.
    const hint1 = new ReadHint("`auth.py` lines 10-20 cached. ~50 tokens wasted.", 50);
    const hint2 = new ReadHint("`auth.py` lines 10-20 cached. ~50 tokens wasted.", 50);

    const fp1 = _hint_fingerprint(String(hint1));
    const fp2 = _hint_fingerprint(String(hint2));

    expect(fp1).toBe(fp2);
  });

  it("test_different_hints_different_fingerprints", () => {
    // Different ReadHints produce different fingerprints.
    const hint1 = new ReadHint("`auth.py` lines 10-20 cached.", 50);
    const hint2 = new ReadHint("`config.py` lines 1-10 cached.", 30);

    const fp1 = _hint_fingerprint(String(hint1));
    const fp2 = _hint_fingerprint(String(hint2));

    expect(fp1).not.toBe(fp2);
  });
});

describe("TestHintsSeenLifecycle", () => {
  it("test_session_tracks_multiple_fingerprints", () => {
    // Session can track multiple unique hint fingerprints.
    const cache = makeCache("test_session");

    const hints = [
      "First hint about auth.py",
      "Second hint about config.py",
      "Third hint about utils.py",
    ];

    for (const hint_text of hints) {
      const fp = _hint_fingerprint(hint_text);
      cache.mark_hint_seen(fp);
    }

    for (const hint_text of hints) {
      const fp = _hint_fingerprint(hint_text);
      expect(cache.has_hint_fingerprint(fp)).toBe(true);
    }

    expect(Object.keys(cache.hints_seen).length).toBe(3);
  });

  it("test_hint_dedup_scenario", () => {
    // Simulate reading same file multiple times — hint should be suppressed on second read.
    const session_id = "test_scenario";
    let cache = makeCache(session_id);

    const hint_text = "`auth.py` lines 1-100 cached. ~200 tokens wasted.";
    const hint = new ReadHint(hint_text, 200);
    const fp = _hint_fingerprint(String(hint));

    expect(cache.has_hint_fingerprint(fp)).toBe(false);
    cache.mark_hint_seen(fp);
    // mark_hint_seen now defers the save; flush explicitly for persistence test
    cache._pending_hint_save = false;
    session.save(cache);

    cache = session.load(session_id);

    expect(cache.has_hint_fingerprint(fp)).toBe(true);
  });
});

describe("TestVerboseHintSuppression", () => {
  it("test_first_emit_is_verbose", () => {
    // First emit of a hint is always verbose (full text).
    // Stub should only be used for counts > 1
    const cache = makeCache("test");
    const fp = "abc123def456";

    // First emit: count goes from 0 → 1
    cache.mark_hint_seen(fp);
    expect(cache.hints_seen[fp]).toBe(1);
  });

  it("test_second_emit_is_verbose_by_default", () => {
    // Second emit is still verbose with default config (verbose_until_seen_count=2).
    const cache = makeCache("test");
    const fp = "abc123def456";

    // First emit: count 1
    cache.mark_hint_seen(fp);
    // Second emit: count 2 (still <= verbose_until=2)
    cache.mark_hint_seen(fp);
    expect(cache.hints_seen[fp]).toBe(2);
  });

  it("test_third_emit_triggers_short_stub", () => {
    // Third emit uses short stub when verbose_until_seen_count=2.
    const stub = _make_short_stub_hint(3);
    expect(String(stub).includes("same hint seen 3×")).toBe(true);
    expect(stub.tokens_saved).toBe(0);
  });

  it("test_short_stub_format", () => {
    // Short stub has correct format for any count.
    for (const count of [3, 4, 5, 10]) {
      const stub = _make_short_stub_hint(count);
      expect(String(stub).includes(`seen ${count}×`)).toBe(true);
      expect(String(stub).includes("↳")).toBe(true);
    }
  });

  it("test_hint_count_increments_on_mark", () => {
    // mark_hint_seen increments count each time.
    const cache = makeCache("test");
    const fp = "abc123def456";

    // Mark 5 times
    for (let i = 1; i < 6; i++) {
      cache.mark_hint_seen(fp);
      expect(cache.hints_seen[fp]).toBe(i);
    }
  });

  it("test_count_survives_serialization", () => {
    // Hint counts survive round-trip to disk.
    const session_id = "test_count_persist";
    const cache1 = makeCache(session_id);
    const fp = "abc123def456";

    // Mark 3 times
    for (let i = 0; i < 3; i++) {
      cache1.mark_hint_seen(fp);
    }
    cache1._pending_hint_save = false;
    session.save(cache1);

    // Reload
    const cache2 = session.load(session_id);
    expect(cache2.hints_seen[fp]).toBe(3);
  });
});

describe("TestEmitDedupBudgetedHintVerboseWindow", () => {
  // hooks_read is now ported (_emit_dedup_budgeted_hint). These cases run live.
  //
  // Seam mapping (Python → TS):
  //  - mock.patch("token_goat.config.load", return_value=cfg)
  //      → vi.spyOn(config, "load").mockReturnValue(cfg). _emit_dedup_budgeted_hint
  //        reads config.load() through the static `config` namespace, so the spy
  //        is observed.
  //  - Config(hints=HintsConfig(verbose_until_seen_count=N)) → start from the real
  //        config.load() (a full ConfigSchema) and override only
  //        hints.verbose_until_seen_count, matching the field the impl reads.
  //  - str(result) (a dict) contains the additionalContext → assert on
  //        result.hookSpecificOutput.additionalContext (`_resultText`).
  //  - _hint_fingerprint(str(hint), path="src/x.py") → _hint_fingerprint(String(hint), "src/x.py").

  afterEach(() => {
    vi.restoreAllMocks();
  });

  /** Text the model would see (Python's `str(result)` ⊇ additionalContext). */
  function _resultText(result: unknown): string {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return (result as any)?.hookSpecificOutput?.additionalContext ?? "";
  }

  /** A full ConfigSchema with hints.verbose_until_seen_count overridden. */
  function _cfgWithVerboseUntil(verboseUntil: number): ReturnType<typeof config.load> {
    const base = config.load();
    return {
      ...base,
      hints: { ...base.hints, verbose_until_seen_count: verboseUntil },
    };
  }

  /**
   * Port of the Python `_call` helper: build a ReadHint, pre-seed seen_count by
   * marking the fingerprint that many times, mock config.load to a Config with
   * the given verbose_until, then call _emit_dedup_budgeted_hint with the same
   * keyword args.
   */
  function _call(
    cache: session.SessionCache,
    seen_count: number,
    verbose_until = 2,
  ): unknown {
    const hint = new ReadHint("Note: already read src/x.py", 100);
    const fp = _hint_fingerprint(String(hint), "src/x.py");
    for (let i = 0; i < seen_count; i++) {
      cache.mark_hint_seen(fp);
    }
    const cfg = _cfgWithVerboseUntil(verbose_until);
    const loadSpy = vi.spyOn(config, "load").mockReturnValue(cfg);
    try {
      return _emit_dedup_budgeted_hint({
        hint,
        file_path: "src/x.py",
        cache,
        budget_kind: "index_only",
        record_emitted_fn: () => undefined,
        stat_kind: "index_only",
        display_name: "index-only",
      });
    } finally {
      loadSpy.mockRestore();
    }
  }

  it("test_first_read_emits_full_hint", () => {
    // seen_count=0 (first read): always emits full hint.
    const cache = new session.SessionCache({ session_id: "vw-test-0", started_ts: 0, last_activity_ts: 0 });
    const result = _call(cache, 0);
    expect(result).not.toBeNull();
  });

  it("test_second_read_emits_full_hint_within_verbose_window", () => {
    // seen_count=1 (second read) with verbose_until=2: must emit full hint, not None.
    const cache = new session.SessionCache({ session_id: "vw-test-1", started_ts: 0, last_activity_ts: 0 });
    const result = _call(cache, 1);
    expect(result, "second read within verbose window must not be suppressed").not.toBeNull();
    // Full hint contains the hint text, not a stub marker.
    expect(_resultText(result).includes("already read")).toBe(true);
  });

  it("test_third_read_emits_stub_at_verbose_until_boundary", () => {
    // seen_count=2 with verbose_until=2: boundary hit → stub, not full hint.
    const cache = new session.SessionCache({ session_id: "vw-test-2", started_ts: 0, last_activity_ts: 0 });
    const result = _call(cache, 2);
    expect(result, "stub must be emitted at the verbose_until boundary").not.toBeNull();
    expect(_resultText(result).includes("seen 2×"), "must be a short stub at the threshold, not the full hint").toBe(true);
  });

  it("test_fourth_read_emits_stub_past_verbose_window", () => {
    // seen_count=3 with verbose_until=2: must emit short stub, not full hint.
    const cache = new session.SessionCache({ session_id: "vw-test-3", started_ts: 0, last_activity_ts: 0 });
    const result = _call(cache, 3);
    expect(result, "past verbose window should emit a stub, not None").not.toBeNull();
    expect(_resultText(result).includes("seen 3×")).toBe(true);
  });

  it("test_verbose_until_zero_suppresses_all_repeats", () => {
    // verbose_until=0 (feature disabled): second read returns None.
    const cache = new session.SessionCache({ session_id: "vw-test-4", started_ts: 0, last_activity_ts: 0 });
    const result = _call(cache, 1, 0);
    expect(result, "verbose_until=0 must suppress all duplicate hints").toBeNull();
  });

  it("test_verbose_until_one_stubs_at_second_read", () => {
    // verbose_until=1: only the first read is full; second read emits stub.
    const cacheStub = new session.SessionCache({ session_id: "vw-test-5a", started_ts: 0, last_activity_ts: 0 });
    const resultStub = _call(cacheStub, 1, 1);
    expect(resultStub).not.toBeNull();
    expect(_resultText(resultStub).includes("seen 1×"), "second read must emit stub when verbose_until=1").toBe(true);

    const cacheStub2 = new session.SessionCache({ session_id: "vw-test-5b", started_ts: 0, last_activity_ts: 0 });
    const resultStub2 = _call(cacheStub2, 2, 1);
    expect(resultStub2).not.toBeNull();
    expect(_resultText(resultStub2).includes("seen 2×")).toBe(true);
  });

  it("test_stub_path_calls_record_emitted_fn", () => {
    // Stub path must call record_emitted_fn so emission counters stay accurate.
    const cache = new session.SessionCache({ session_id: "vw-stub-record", started_ts: 0, last_activity_ts: 0 });
    const hint = new ReadHint("Note: already read src/x.py", 100);
    const fp = _hint_fingerprint(String(hint), "src/x.py");
    for (let i = 0; i < 2; i++) {
      cache.mark_hint_seen(fp); // seen_count=2 >= verbose_until=2 → stub path
    }
    const cfg = _cfgWithVerboseUntil(2);
    const recordCalls: unknown[] = [];
    const loadSpy = vi.spyOn(config, "load").mockReturnValue(cfg);
    let result: unknown;
    try {
      result = _emit_dedup_budgeted_hint({
        hint,
        file_path: "src/x.py",
        cache,
        budget_kind: "index_only",
        record_emitted_fn: (c) => recordCalls.push(c),
        stat_kind: "index_only",
        display_name: "index-only",
      });
    } finally {
      loadSpy.mockRestore();
    }
    expect(result, "stub must be emitted").not.toBeNull();
    expect(recordCalls.length, "record_emitted_fn must be called once for stubs").toBe(1);
  });

  it("test_stub_path_respects_budget_cap", () => {
    // Stub path must obey budget cap — unlimited stubs cannot bypass max_per_session.
    const cache = new session.SessionCache({ session_id: "vw-stub-budget", started_ts: 0, last_activity_ts: 0 });
    const hint = new ReadHint("Note: already read src/x.py", 100);
    const fp = _hint_fingerprint(String(hint), "src/x.py");
    for (let i = 0; i < 2; i++) {
      cache.mark_hint_seen(fp); // seen_count=2 >= verbose_until=2 → stub path
    }

    // Exhaust the index_only budget by setting the counter at the cap.
    const cfg = config.load();
    const cap = cfg.hint_budget!.max_index_only_per_session ?? 30;
    cache.index_only_hints_emitted = cap; // budget exhausted

    const loadSpy = vi.spyOn(config, "load").mockReturnValue(cfg);
    let result: unknown;
    try {
      result = _emit_dedup_budgeted_hint({
        hint,
        file_path: "src/x.py",
        cache,
        budget_kind: "index_only",
        record_emitted_fn: () => undefined,
        stat_kind: "index_only",
        display_name: "index-only",
      });
    } finally {
      loadSpy.mockRestore();
    }
    expect(result, "stub must be suppressed when budget is exhausted").toBeNull();
  });

  it.skip("test_stub_path_calls_record_hint_stat_pair", () => {
    // PORT: deferred — Python patches token_goat.hooks_read.record_hint_stat_pair
    // and asserts the stub branch calls it once. In the TS port hooks_read.ts
    // imports record_hint_stat_pair from hooks_common as a LEXICAL binding and
    // calls it directly (not via a self / hooks_common namespace), so a
    // vi.spyOn(hooks_common, "record_hint_stat_pair") is invisible to the call
    // site. Porting would require routing the call through the module namespace —
    // an implementation change out of scope for a read-mostly un-defer pass.
  });

  it("test_suppressed_hint_does_not_increment_counter", () => {
    // When verbose_until_seen_count=0 suppresses a repeat hint, record_emitted_fn
    // must NOT fire (budget counts firings, not dedup-gate visits).
    const cache = new session.SessionCache({ session_id: "vw-no-counter", started_ts: 0, last_activity_ts: 0 });
    const hint = new ReadHint("Note: already read src/x.py", 100);
    const fp = _hint_fingerprint(String(hint), "src/x.py");
    // Simulate one prior emission so seen_count=1 on the next call.
    cache.mark_hint_seen(fp);

    const cfg = _cfgWithVerboseUntil(0);
    const recordCalls: unknown[] = [];
    const loadSpy = vi.spyOn(config, "load").mockReturnValue(cfg);
    let result: unknown;
    try {
      result = _emit_dedup_budgeted_hint({
        hint,
        file_path: "src/x.py",
        cache,
        budget_kind: "index_only",
        record_emitted_fn: (c) => recordCalls.push(c),
        stat_kind: "index_only",
        display_name: "index-only",
      });
    } finally {
      loadSpy.mockRestore();
    }
    expect(result, "verbose_until=0 must suppress repeat hint").toBeNull();
    expect(
      recordCalls.length,
      "record_emitted_fn must NOT be called for suppressed hints — budget counts firings (emitted messages), not dedup-gate visits",
    ).toBe(0);
  });
});
