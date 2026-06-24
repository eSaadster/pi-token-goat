/**
 * Tests for post-compaction read-cache reset (iter 33).
 *
 * 1:1 port of tests/test_compact_cache_reset.py. Each Python `def test_*` maps
 * to a vitest `it()` with the SAME name + assertion polarity; each Python
 * `class Test*` maps to a `describe(...)`.
 *
 * After a compact event, `last_compact_ts` is recorded on the session cache.
 * Pre-read hooks suppress "already in context" hints for files whose
 * `last_read_ts` is older than `last_compact_ts` — that content is gone.
 *
 * ---------------------------------------------------------------------------
 * Parity notes (Python -> TS)
 * ---------------------------------------------------------------------------
 *  - Part A (TestRecordCompact) and the round-trip / guard tests in Part D
 *    (TestCompactGuardLogic) port live: they exercise session.ts only
 *    (record_compact / safe_load / load / save / mark_file_read /
 *    SessionCache.to_dict / from_dict / last_compact_ts), all shipped.
 *  - Part B (TestBashStreakHintPostCompact) and Part C
 *    (TestBashAlreadyReadPostCompact) import token_goat.hooks_read
 *    (_handle_bash_streak_hint / _handle_bash_already_read), which is NOT yet
 *    ported. Every test in those classes is it.skip'd with a deferred reason.
 *  - The Python `tmp_data_dir` autouse fixture is supplied by tests/setup.ts
 *    (beforeEach -> setDataDirOverride + clearModuleCaches), so the per-test
 *    isolation needs no local wiring.
 *  - time.time() -> Date.now()/1000. The before/after wall-clock-window
 *    assertions read Date.now()/1000 the same way record_compact does, so the
 *    `before <= ts <= after` invariants hold byte-for-byte.
 *  - time.sleep(0.01) (used only to guarantee a monotonic bump between two
 *    record_compact calls) -> a tiny synchronous busy-wait loop. The assertion
 *    is `>=`, so it holds even without the delay; the loop preserves the intent.
 *  - MagicMock(spec=SessionCache) / MagicMock(spec=FileEntry) in the guard-logic
 *    unit tests -> plain object literals carrying just the fields the test reads
 *    (last_compact_ts / last_read_ts / read_count / last_edit_ts). The Python
 *    `getattr(cache, "last_compact_ts", 0.0)` becomes a `??`-defaulted read; the
 *    "missing attribute" case uses an object literal that omits the field.
 *  - pytest.approx -> expect(...).toBeCloseTo(...).
 *
 * verbatimModuleSyntax is on -> relative imports end in .js.
 */
import { describe, expect, it } from "vitest";

import * as session from "../src/token_goat/session.js";
import { SessionCache } from "../src/token_goat/session.js";

// ---------------------------------------------------------------------------
// Helpers shared across test classes
// ---------------------------------------------------------------------------

/** A minimal cache-shaped object for the guard-logic unit tests. */
interface _CacheLike {
  last_compact_ts?: number | undefined;
  files: Record<string, _EntryLike>;
}

/** A minimal entry-shaped object for the guard-logic unit tests. */
interface _EntryLike {
  read_count: number;
  last_read_ts: number;
  last_edit_ts: number;
}

/**
 * Python `_make_session_cache(...)` analogue. Returns [cache, entry] plain
 * objects carrying the given field values (Python used MagicMock(spec=...);
 * the ported tests only read the listed fields, so a literal is faithful).
 */
function _make_session_cache(
  opts: {
    read_count?: number;
    last_read_ts?: number;
    last_compact_ts?: number;
    path_key?: string;
    last_edit_ts?: number;
  } = {},
): [_CacheLike, _EntryLike] {
  const read_count = opts.read_count ?? 1;
  const last_read_ts = opts.last_read_ts ?? 0.0;
  const last_compact_ts = opts.last_compact_ts ?? 0.0;
  const path_key = opts.path_key ?? "c:/proj/foo.py";
  const last_edit_ts = opts.last_edit_ts ?? 0.0;

  const entry: _EntryLike = { read_count, last_read_ts, last_edit_ts };
  const cache: _CacheLike = { last_compact_ts, files: { [path_key]: entry } };
  return [cache, entry];
}

/** time.time() — float seconds. */
function _now(): number {
  return Date.now() / 1000;
}

/** Busy-wait at least `ms` milliseconds (time.sleep analogue, synchronous). */
function _sleep(ms: number): void {
  const target = Date.now() + ms;
  while (Date.now() < target) {
    // spin
  }
}

// ---------------------------------------------------------------------------
// Part A — record_compact function
// ---------------------------------------------------------------------------

describe("TestRecordCompact", () => {
  it("test_record_compact_sets_last_compact_ts", () => {
    const sid = "test-record-compact-1";
    session.load(sid); // create fresh session
    const before = _now();
    session.record_compact(sid);
    const after = _now();

    const loaded = session.load(sid);
    expect(loaded.last_compact_ts).toBeGreaterThanOrEqual(before);
    expect(loaded.last_compact_ts).toBeLessThanOrEqual(after);
  });

  it("test_record_compact_persists_to_disk", () => {
    const sid = "test-record-compact-persist";
    session.load(sid);
    session.record_compact(sid);
    const ts_written = session.load(sid).last_compact_ts;

    // Reload a second time from disk to confirm persistence.
    const ts_reloaded = session.load(sid).last_compact_ts;
    expect(ts_reloaded).toBe(ts_written);
  });

  it("test_record_compact_second_call_updates_ts", () => {
    const sid = "test-record-compact-twice";
    session.load(sid);
    session.record_compact(sid);
    const ts_first = session.load(sid).last_compact_ts;

    // Ensure monotonically increasing by sleeping a tiny bit.
    _sleep(10);
    session.record_compact(sid);
    const ts_second = session.load(sid).last_compact_ts;
    expect(ts_second).toBeGreaterThanOrEqual(ts_first);
  });

  it("test_record_compact_on_missing_session_creates_fresh_cache", () => {
    // record_compact on a session that doesn't exist creates a new cache with
    // last_compact_ts > 0. safe_load returns a fresh (non-null) cache for valid
    // but nonexistent session IDs, so record_compact stamps and persists it
    // rather than silently returning.
    const sid = "nonexistent-session-xyz-99";
    session.record_compact(sid);
    const cache = session.safe_load(sid, { caller: "test" });
    expect(cache).not.toBeNull();
    expect(cache!.last_compact_ts).toBeGreaterThan(0);
  });

  it("test_fresh_session_last_compact_ts_defaults_to_zero", () => {
    const sid = "test-fresh-default";
    const cache = session.load(sid);
    expect(cache.last_compact_ts).toBe(0.0);
  });

  it("test_last_compact_ts_survives_file_read", () => {
    const sid = "test-compact-survives-read";
    session.load(sid);
    session.record_compact(sid);
    const compact_ts = session.load(sid).last_compact_ts;

    session.mark_file_read(sid, "src/foo.py");
    expect(session.load(sid).last_compact_ts).toBe(compact_ts);
  });

  it("test_session_without_compact_has_zero_last_compact_ts", () => {
    // Backward-compat: old sessions deserialised without the field default to 0.0.
    const sid = "test-compat-zero";
    const cache = session.load(sid);
    // Manually save a dict without last_compact_ts to simulate old serialised data.
    const d = cache.to_dict() as Record<string, unknown>;
    delete d["last_compact_ts"];
    // Re-parse through from_dict — should default to 0.0.
    const restored = SessionCache.from_dict(d);
    expect(restored.last_compact_ts).toBe(0.0);
  });
});

// ---------------------------------------------------------------------------
// Part B — _handle_bash_streak_hint suppression
// ---------------------------------------------------------------------------

describe("TestBashStreakHintPostCompact", () => {
  // streak_hint (read_count >= 2) is suppressed when file was read pre-compact.
  // PORT: deferred — token_goat.hooks_read (_handle_bash_streak_hint) not ported.

  it.skip("test_hint_fires_when_read_after_compact", () => {
    // PORT: deferred — hooks_read (Layer 4)
  });

  it.skip("test_hint_suppressed_when_read_before_compact", () => {
    // PORT: deferred — hooks_read (Layer 4)
  });

  it.skip("test_hint_fires_when_no_compact_occurred", () => {
    // PORT: deferred — hooks_read (Layer 4)
  });

  it.skip("test_hint_suppressed_when_read_strictly_before_compact", () => {
    // PORT: deferred — hooks_read (Layer 4)
  });

  it.skip("test_hint_fires_when_read_at_exactly_compact_ts", () => {
    // PORT: deferred — hooks_read (Layer 4)
  });

  it.skip("test_multiple_compacts_only_most_recent_matters", () => {
    // PORT: deferred — hooks_read (Layer 4)
  });
});

// ---------------------------------------------------------------------------
// Part C — _handle_bash_already_read suppression
// ---------------------------------------------------------------------------

describe("TestBashAlreadyReadPostCompact", () => {
  // already_read hint (read_count == 1) is suppressed when file was read pre-compact.
  // PORT: deferred — token_goat.hooks_read (_handle_bash_already_read) not ported.

  it.skip("test_hint_fires_when_read_after_compact", () => {
    // PORT: deferred — hooks_read (Layer 4)
  });

  it.skip("test_hint_suppressed_when_read_before_compact", () => {
    // PORT: deferred — hooks_read (Layer 4)
  });

  it.skip("test_hint_fires_when_no_compact_occurred", () => {
    // PORT: deferred — hooks_read (Layer 4)
  });

  it.skip("test_hint_suppressed_file_never_reread_after_compact", () => {
    // PORT: deferred — hooks_read (Layer 4)
  });
});

// ---------------------------------------------------------------------------
// Part D — compact guard logic unit tests
// ---------------------------------------------------------------------------

describe("TestCompactGuardLogic", () => {
  it("test_guard_suppresses_when_read_ts_less_than_compact_ts", () => {
    // Core invariant: last_read_ts < last_compact_ts → content is gone.
    const now = _now();
    const [cache, entry] = _make_session_cache({ last_read_ts: now - 100, last_compact_ts: now });
    const compact_ts = cache.last_compact_ts ?? 0.0;
    expect(Boolean(compact_ts) && entry.last_read_ts < compact_ts).toBe(true);
  });

  it("test_guard_allows_when_read_ts_greater_than_compact_ts", () => {
    // last_read_ts > last_compact_ts → content is still in context window.
    const now = _now();
    const [cache, entry] = _make_session_cache({ last_read_ts: now + 10, last_compact_ts: now });
    const compact_ts = cache.last_compact_ts ?? 0.0;
    expect(Boolean(compact_ts) && entry.last_read_ts < compact_ts).toBe(false);
  });

  it("test_guard_allows_when_no_compact_occurred", () => {
    // last_compact_ts == 0.0 → falsy, guard condition never suppresses.
    const now = _now();
    const [cache] = _make_session_cache({ last_read_ts: now - 1000, last_compact_ts: 0.0 });
    const compact_ts = cache.last_compact_ts ?? 0.0;
    expect(Boolean(compact_ts)).toBe(false); // falsy → guard does not fire
  });

  it("test_guard_missing_attr_defaults_to_zero_via_getattr", () => {
    // getattr(cache, "last_compact_ts", 0.0) is safe on older mocks without the field.
    const cache: { last_compact_ts?: number } = {};
    // simulate missing attribute (field omitted entirely)
    const compact_ts = cache.last_compact_ts ?? 0.0;
    expect(compact_ts).toBe(0.0);
  });

  it("test_session_cache_to_dict_round_trips_last_compact_ts", () => {
    // last_compact_ts survives to_dict() → from_dict() round-trip.
    const sid = "test-roundtrip-compact-ts";
    const cache = session.load(sid);
    cache.last_compact_ts = 1_700_000_000.0;
    session.save(cache);

    const loaded = session.load(sid);
    expect(loaded.last_compact_ts).toBeCloseTo(1_700_000_000.0);
  });

  it("test_hooks_cli_sets_last_compact_ts_on_session_cache", () => {
    // pre_compact handler sets last_compact_ts on the in-memory session cache.
    // Python uses MagicMock(spec=SessionCache); the test only sets+reads the
    // field, so a plain object literal carrying last_compact_ts is faithful.
    const cache: { last_compact_ts: number } = { last_compact_ts: 0.0 };
    // Simulate what pre_compact does: set last_compact_ts = time.time().
    const before = _now();
    cache.last_compact_ts = _now();
    const after = _now();
    expect(before).toBeLessThanOrEqual(cache.last_compact_ts);
    expect(cache.last_compact_ts).toBeLessThanOrEqual(after);
  });
});
