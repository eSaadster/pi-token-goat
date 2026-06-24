/**
 * Tests for per-file session hint cooldown, hint list trimming, and suppressed
 * stat. 1:1 port of tests/test_session_hint_cooldown.py.
 *
 * Covers three improvements to session_hint signal/noise ratio:
 *  1. Per-file hint cooldown: suppress repeat hints for the same file until edited.
 *  2. Hint range display capped at _MAX_CACHED_RANGES_DISPLAY (10) most-recent.
 *  3. session_hint_suppressed stat tracked when cooldown fires.
 *
 * Port notes
 * ----------
 * The Python suite imports from three modules:
 *   - token_goat.session   (SessionCache, FileEntry, _normalize_path,
 *                            mark_file_edited)  — PORTED (src/token_goat/session.ts).
 *   - token_goat.hints      (_MAX_CACHED_RANGES_DISPLAY, _hint_from_cache) — NOT
 *                            yet ported to TS.
 *   - token_goat.hooks_read (pre_read + the _try_* patch points)            — NOT
 *                            yet ported to TS.
 *
 * Every test that reaches into `hints` or `hooks_read` is therefore marked
 * it.skip with a "// PORT: deferred" note. The pure-SessionCache cooldown /
 * suppressed-stat / serialization tests port directly.
 */
import { describe, expect, it } from "vitest";

import * as session_mod from "../src/token_goat/session.js";
import { FileEntry, SessionCache } from "../src/token_goat/session.js";

// ---------------------------------------------------------------------------
// Helpers (Python module-level helpers)
// ---------------------------------------------------------------------------

/** Return a fresh SessionCache with sensible defaults. */
function _make_session_cache(session_id = "test_session"): SessionCache {
  const now = Date.now() / 1000;
  return new SessionCache({
    session_id,
    started_ts: now,
    last_activity_ts: now,
  });
}

/** Return a FileEntry with the given line_ranges. (Used by the deferred hints tests.) */
function _make_file_entry(
  line_ranges: Array<[number, number]>,
  read_count = 1,
  last_read_ts: number | null = null,
  last_edit_ts = 0.0,
): FileEntry {
  const now = last_read_ts === null ? Date.now() / 1000 : last_read_ts;
  return new FileEntry({
    rel_or_abs: "/fake/file.py",
    last_read_ts: now,
    read_count,
    line_ranges,
    symbols_read: [],
    last_edit_ts,
  });
}

// ---------------------------------------------------------------------------
// Test 1: per-file hint cooldown — suppresses repeat hint for same file
// ---------------------------------------------------------------------------

describe("TestPerFileHintCooldown", () => {
  it("test_cooldown_suppresses_repeat_hint", () => {
    const cache = _make_session_cache();
    const file_key = session_mod._normalize_path("/fake/file.py");

    // Initially, no hint has been emitted for this file.
    expect(cache.has_session_hint_been_emitted(file_key)).toBe(false);

    // After marking, cooldown is active.
    cache.mark_session_hint_emitted(file_key);
    expect(cache.has_session_hint_been_emitted(file_key)).toBe(true);
  });

  it("test_cooldown_cleared_on_edit", () => {
    const cache = _make_session_cache();
    const file_key = session_mod._normalize_path("/fake/file.py");

    cache.mark_session_hint_emitted(file_key);
    expect(cache.has_session_hint_been_emitted(file_key)).toBe(true);

    // Simulate an edit via clear_session_hint_cooldown (called by mark_file_edited).
    cache.clear_session_hint_cooldown(file_key);
    expect(cache.has_session_hint_been_emitted(file_key)).toBe(false);
  });

  it("test_mark_file_edited_clears_cooldown", () => {
    const cache = _make_session_cache();
    const file_key = session_mod._normalize_path("/fake/file.py");

    cache.mark_session_hint_emitted(file_key);
    expect(cache.has_session_hint_been_emitted(file_key)).toBe(true);

    // mark_file_edited should call clear_session_hint_cooldown.
    session_mod.mark_file_edited(cache.session_id, "/fake/file.py", { cache });
    expect(cache.has_session_hint_been_emitted(file_key)).toBe(false);
  });

  it("test_cooldown_is_per_file", () => {
    const cache = _make_session_cache();
    const key_a = session_mod._normalize_path("/fake/a.py");
    const key_b = session_mod._normalize_path("/fake/b.py");

    cache.mark_session_hint_emitted(key_a);
    expect(cache.has_session_hint_been_emitted(key_a)).toBe(true);
    expect(cache.has_session_hint_been_emitted(key_b)).toBe(false);
  });

  // PORT: deferred — hooks_read.pre_read (and its _try_* patch points) is not yet ported to TS.
  it.skip("test_pre_read_records_suppressed_stat", () => {});

  // PORT: deferred — hooks_read.pre_read + db.record_stat path not yet ported to TS.
  it.skip("test_pre_read_writes_session_hint_suppressed_to_db", () => {});
});

// ---------------------------------------------------------------------------
// Test 2: hint range display capped at _MAX_CACHED_RANGES_DISPLAY
// ---------------------------------------------------------------------------

describe("TestHintRangeDisplayCap", () => {
  // PORT: deferred — token_goat.hints (_MAX_CACHED_RANGES_DISPLAY) not yet ported to TS.
  it.skip("test_max_cached_ranges_display_constant", () => {
    void _make_file_entry;
  });

  // PORT: deferred — token_goat.hints._hint_from_cache not yet ported to TS.
  it.skip("test_hint_caps_ranges_to_10", () => {});

  // PORT: deferred — token_goat.hints._hint_from_cache not yet ported to TS.
  it.skip("test_hint_shows_most_recent_ranges", () => {});

  // PORT: deferred — token_goat.hints._hint_from_cache not yet ported to TS.
  it.skip("test_under_cap_shows_all_ranges", () => {});
});

// ---------------------------------------------------------------------------
// Test 3: session_hint_suppressed stat in SessionCache
// ---------------------------------------------------------------------------

describe("TestSessionHintSuppressedStat", () => {
  it("test_record_hint_suppressed_increments_counter", () => {
    const cache = _make_session_cache();
    expect(cache.hints_suppressed_by_type["session_hint_suppressed"] ?? 0).toBe(0);

    cache.record_hint_suppressed("session_hint_suppressed");
    expect(cache.hints_suppressed_by_type["session_hint_suppressed"]).toBe(1);

    cache.record_hint_suppressed("session_hint_suppressed");
    expect(cache.hints_suppressed_by_type["session_hint_suppressed"]).toBe(2);
  });

  it("test_suppression_stat_serialized_to_json", () => {
    const cache = _make_session_cache();
    cache.record_hint_suppressed("session_hint_suppressed");

    const d = cache.to_dict();
    const suppressed = d.hints_suppressed_by_type;
    expect(suppressed).toBeDefined();
    expect(suppressed?.["session_hint_suppressed"]).toBe(1);

    const restored = SessionCache.from_dict(d as unknown as Record<string, unknown>);
    expect(restored.hints_suppressed_by_type["session_hint_suppressed"]).toBe(1);
  });

  it("test_cooldown_fields_not_persisted", () => {
    const cache = _make_session_cache();
    const file_key = session_mod._normalize_path("/fake/file.py");
    cache.mark_session_hint_emitted(file_key);

    const d = cache.to_dict() as unknown as Record<string, unknown>;
    // The field should not appear in the serialized dict.
    expect("_session_hinted_files" in d).toBe(false);
    expect("session_hinted_files" in d).toBe(false);

    // After restoring, the cooldown is gone (fresh process).
    const restored = SessionCache.from_dict(d);
    expect(restored.has_session_hint_been_emitted(file_key)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Test 4: exponential backoff for session re-read hints
// ---------------------------------------------------------------------------

describe("TestSessionHintBackoff", () => {
  // PORT: deferred — hooks_read.pre_read + config.HintsConfig backoff path not yet ported to TS.
  it.skip("test_threshold_read_counts_emit_hint", () => {});

  // PORT: deferred — hooks_read.pre_read + config.HintsConfig backoff path not yet ported to TS.
  it.skip("test_non_threshold_read_counts_suppress_hint", () => {});

  // PORT: deferred — hooks_read.pre_read + config.HintsConfig backoff path not yet ported to TS.
  it.skip("test_empty_thresholds_disables_backoff", () => {});

  // PORT: deferred — hooks_read.pre_read + config.HintsConfig backoff path not yet ported to TS.
  it.skip("test_backoff_suppressed_stat_recorded", () => {});

  it("test_backoff_stat_counter_in_cache", () => {
    const cache = _make_session_cache();
    expect(cache.hints_suppressed_by_type["hint_backoff_suppressed"] ?? 0).toBe(0);
    cache.record_hint_suppressed("hint_backoff_suppressed");
    expect(cache.hints_suppressed_by_type["hint_backoff_suppressed"]).toBe(1);
  });

  // PORT: deferred — hooks_read.pre_read + config.HintsConfig backoff path not yet ported to TS.
  it.skip("test_backoff_does_not_fingerprint_suppressed_hint", () => {});
});
