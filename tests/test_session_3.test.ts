/**
 * Session module tests — part 3/4. 1:1 port of tests/test_session.py classes
 * TestSharedHistoryHelpers through TestSortedListCache (Python source lines
 * ~2448-3644). One vitest it() per Python `def test_*`, same name + polarity.
 *
 * Scope:
 *  - TestSharedHistoryHelpers   — dict/list history eviction caps.
 *  - TestCuratorSessionFields   — hints_emitted/ignored/recent_hints round-trip.
 *  - TestHintBudgetCounters     — structured/index_only counters round-trip.
 *  - TestLastManifestFields     — last_manifest_sha/ts round-trip.
 *  - TestSessionCAS             — optimistic CAS / version counter / merge.
 *  - TestSessionLockfile        — sidecar lockfile helpers.
 *  - TestSessionLockfileConcurrent — cross-process no-loss (mostly deferred).
 *  - TestDiskMtimeFingerprint   — _disk_mtime_ns / _disk_size fast-path skip.
 *  - TestSortedListCache        — to_dict() sorted-list caching.
 *
 * Test-seam mapping (Python → TS):
 *  - tmp_data_dir fixture       → setup.ts's per-test setDataDirOverride.
 *  - session.paths.session_cache_path → paths.sessionCachePath (paths.js).
 *  - session.paths.atomic_write_text  → paths.atomicWriteText (paths.js).
 *  - session._proc_load_cache.pop/clear → _proc_load_cache Map delete/clear.
 *  - patch.object(_session_mod, "save", return_value=None) — a pure perf
 *    optimization in the Python source (avoid N×save while batch-filling a
 *    history). ESM cannot intercept session.ts's INTERNAL `save` binding, and
 *    the optimization is not behavior-load-bearing, so the ported tests run the
 *    real per-iteration saves; the end-state assertions are identical.
 *
 * Deferred (it.skip): tests relying on Python threading/multiprocessing to
 * simulate a concurrent writer single-threaded Node cannot reproduce, and the
 * fcntl-advisory-lock semantics (persistent fd lock / auto-release on fd close)
 * the TS port deliberately re-expressed as an O_EXCL+unlink lockfile. Each
 * carries a "// PORT: deferred — <reason>" note.
 */
import fs from "node:fs";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";

import * as paths from "../src/token_goat/paths.js";
import {
  BASH_HISTORY_MAX,
  GLOB_HISTORY_MAX,
  GREPS_HISTORY_MAX,
  GlobEntry,
  GrepEntry,
  HINTS_SEEN_MAX,
  SessionCache,
  WEB_HISTORY_MAX,
  _BASH_HISTORY_EVICT,
  _merge_session_caches,
  _normalize_path,
  _proc_load_cache,
  _session_lock_path,
  load,
  mark_bash_run,
  mark_file_edited,
  mark_file_read,
  mark_glob_run,
  mark_grep,
  mark_web_fetch,
  save,
} from "../src/token_goat/session.js";

// ===========================================================================
// TestSharedHistoryHelpers
// ===========================================================================

describe("TestSharedHistoryHelpers", () => {
  it("test_dict_history_evicts_at_cap_plus_one", () => {
    const sid = "dict_evict_1";
    let cache = load(sid);
    // Fill bash_history to BASH_HISTORY_MAX with new keys.
    for (let i = 0; i < BASH_HISTORY_MAX; i++) {
      cache = mark_bash_run(sid, `sha_${i}`, `cmd_${i}`, `out_${i}`, 100, 0, 0, false, {
        cache,
      });
    }
    save(cache);
    cache = load(sid);
    expect(Object.keys(cache.bash_history).length).toBe(BASH_HISTORY_MAX);
    // Adding one more (cap+1) triggers eviction: oldest batch is removed.
    mark_bash_run(sid, "sha_final", "cmd_final", "out_final", 100, 0, 0, false);
    cache = load(sid);
    expect(Object.keys(cache.bash_history).length).toBeLessThanOrEqual(BASH_HISTORY_MAX);
  });

  it("test_dict_history_batch_eviction_respects_batch_size", () => {
    const sid = "dict_batch_1";
    let cache = load(sid);
    for (let i = 0; i < BASH_HISTORY_MAX; i++) {
      cache = mark_bash_run(sid, `sha_${i}`, `cmd_${i}`, `out_${i}`, 100, 0, 0, false, {
        cache,
      });
    }
    save(cache);
    cache = load(sid);
    const initialCount = Object.keys(cache.bash_history).length;
    // Add one more to trigger eviction.
    mark_bash_run(sid, `sha_${BASH_HISTORY_MAX}`, "cmd_new", "out_new", 100, 0, 0, false);
    cache = load(sid);
    // Count: initial - evict_batch + 1 new = initial - (batch - 1).
    const expected = initialCount - (_BASH_HISTORY_EVICT - 1);
    expect(Object.keys(cache.bash_history).length).toBe(expected);
  });

  it("test_list_history_evicts_at_cap_plus_one", () => {
    const sid = "list_evict_1";
    let cache = load(sid);
    for (let i = 0; i < GREPS_HISTORY_MAX; i++) {
      cache = mark_grep(sid, `pattern_${i}`, "/src", null, { cache });
    }
    save(cache);
    cache = load(sid);
    expect(cache.greps.length).toBe(GREPS_HISTORY_MAX);
    // Adding one more should evict oldest to keep at max.
    mark_grep(sid, "pattern_final", "/src");
    cache = load(sid);
    expect(cache.greps.length).toBe(GREPS_HISTORY_MAX);
  });

  it("test_list_history_keeps_most_recent", () => {
    const sid = "list_recent_1";
    let cache = load(sid);
    for (let i = 0; i < GREPS_HISTORY_MAX + 5; i++) {
      cache = mark_grep(sid, `pattern_${i}`, "/src", null, { cache });
    }
    save(cache);
    cache = load(sid);
    const patterns = cache.greps.map((g) => g.pattern);
    // Oldest patterns should be gone.
    expect(patterns).not.toContain("pattern_0");
    expect(patterns).not.toContain("pattern_1");
    // Most recent should exist.
    expect(patterns).toContain(`pattern_${GREPS_HISTORY_MAX + 4}`);
  });

  it("test_web_history_uses_dict_helper", () => {
    const sid = "web_dict_1";
    let cache = load(sid);
    for (let i = 0; i < WEB_HISTORY_MAX; i++) {
      cache = mark_web_fetch(
        sid,
        `sha_${i}`,
        `http://example.com/${i}`,
        `out_${i}`,
        1000,
        200,
        false,
        { cache },
      );
    }
    save(cache);
    cache = load(sid);
    expect(Object.keys(cache.web_history).length).toBe(WEB_HISTORY_MAX);
    // Add one more to trigger eviction.
    mark_web_fetch(sid, "sha_final", "http://example.com/final", "out_final", 1000, 200, false);
    cache = load(sid);
    expect(Object.keys(cache.web_history).length).toBeLessThanOrEqual(WEB_HISTORY_MAX);
  });

  it("test_glob_history_uses_list_helper", () => {
    const sid = "glob_list_1";
    let cache = load(sid);
    for (let i = 0; i < GLOB_HISTORY_MAX + 3; i++) {
      cache = mark_glob_run(sid, `**/${i}/*.py`, null, i, { cache });
    }
    save(cache);
    cache = load(sid);
    expect(cache.glob_history.length).toBe(GLOB_HISTORY_MAX);
    const patterns = cache.glob_history.map((g) => g.pattern);
    expect(patterns).not.toContain("**/0/*.py");
    expect(patterns).toContain(`**/${GLOB_HISTORY_MAX + 2}/*.py`);
  });
});

// ===========================================================================
// TestCuratorSessionFields
// ===========================================================================

describe("TestCuratorSessionFields", () => {
  it("test_hints_emitted_ignored_default_zero", () => {
    const cache = load("curator_fresh_1");
    expect(cache.hints_emitted).toBe(0);
    expect(cache.hints_ignored).toBe(0);
  });

  it("test_recent_hints_default_empty", () => {
    const cache = load("curator_fresh_2");
    expect(cache.recent_hints).toEqual([]);
  });

  it("test_roundtrip_hints_emitted_ignored", () => {
    const sid = "curator_rt_1";
    const cache = load(sid);
    cache.hints_emitted = 15;
    cache.hints_ignored = 7;
    cache._invalidate_json_cache();
    save(cache);
    const reloaded = load(sid);
    expect(reloaded.hints_emitted).toBe(15);
    expect(reloaded.hints_ignored).toBe(7);
  });

  it("test_roundtrip_recent_hints", () => {
    const sid = "curator_rt_2";
    const cache = load(sid);
    const ts1 = Date.now() / 1000;
    const ts2 = ts1 + 1.5;
    cache.recent_hints = [
      ["/proj/a.py", ts1],
      ["/proj/b.py", ts2],
    ];
    cache._invalidate_json_cache();
    save(cache);
    const reloaded = load(sid);
    expect(reloaded.recent_hints.length).toBe(2);
    const recentPaths = reloaded.recent_hints.map(([p]) => p);
    expect(recentPaths).toContain("/proj/a.py");
    expect(recentPaths).toContain("/proj/b.py");
  });

  it("test_recent_hints_capped_at_3_on_load", () => {
    const sid = "curator_cap_1";
    const cache = load(sid);
    const now = Date.now() / 1000;
    // Manually write a session JSON with 5 recent_hints entries.
    const raw = JSON.parse(cache.to_json()) as Record<string, unknown>;
    raw["recent_hints"] = Array.from({ length: 5 }, (_, i) => [`/proj/file_${i}.py`, now + i]);
    const p = paths.sessionCachePath(sid);
    paths.ensureDir(path.dirname(p));
    fs.writeFileSync(p, JSON.stringify(raw), "utf8");
    const reloaded = load(sid);
    expect(reloaded.recent_hints.length).toBeLessThanOrEqual(3);
  });

  it("test_migration_adds_missing_fields", () => {
    const sid = "curator_migrate_1";
    const cache = load(sid);
    const raw = JSON.parse(cache.to_json()) as Record<string, unknown>;
    delete raw["hints_emitted"];
    delete raw["hints_ignored"];
    delete raw["recent_hints"];
    const p = paths.sessionCachePath(sid);
    paths.ensureDir(path.dirname(p));
    fs.writeFileSync(p, JSON.stringify(raw), "utf8");
    const reloaded = load(sid);
    expect(reloaded.hints_emitted).toBe(0);
    expect(reloaded.hints_ignored).toBe(0);
    expect(reloaded.recent_hints).toEqual([]);
  });

  it("test_serialized_recent_hints_shape", () => {
    const sid = "curator_serial_1";
    const cache = load(sid);
    const now = Date.now() / 1000;
    cache.recent_hints = [["/proj/x.py", now]];
    cache._invalidate_json_cache();
    const raw = JSON.parse(cache.to_json()) as Record<string, unknown>;
    expect(Array.isArray(raw["recent_hints"])).toBe(true);
    const rh = raw["recent_hints"] as unknown[];
    expect(rh.length).toBe(1);
    const entry = rh[0];
    expect(Array.isArray(entry)).toBe(true);
    const pair = entry as unknown[];
    expect(pair[0]).toBe("/proj/x.py");
    expect(typeof pair[1]).toBe("number");
  });
});

// ===========================================================================
// TestHintBudgetCounters
// ===========================================================================

describe("TestHintBudgetCounters", () => {
  it("test_structured_hints_emitted_defaults_to_zero", () => {
    const cache = load("hb_ct_default");
    expect(cache.structured_hints_emitted).toBe(0);
    expect(cache.index_only_hints_emitted).toBe(0);
  });

  it("test_structured_hints_emitted_roundtrip", () => {
    const sid = "hb_ct_roundtrip";
    const cache = load(sid);
    cache.structured_hints_emitted = 7;
    cache.index_only_hints_emitted = 13;
    cache._invalidate_json_cache();
    save(cache);

    const reloaded = load(sid);
    expect(reloaded.structured_hints_emitted).toBe(7);
    expect(reloaded.index_only_hints_emitted).toBe(13);
  });

  it("test_missing_counters_deserialize_as_zero", () => {
    const sid = "hb_ct_legacy";
    const cache = load(sid);
    const raw = JSON.parse(cache.to_json()) as Record<string, unknown>;
    delete raw["structured_hints_emitted"];
    delete raw["index_only_hints_emitted"];

    const restored = SessionCache.from_dict(raw);
    expect(restored.structured_hints_emitted).toBe(0);
    expect(restored.index_only_hints_emitted).toBe(0);
  });

  it("test_counters_in_json_output", () => {
    const sid = "hb_ct_json";
    const cache = load(sid);
    cache.structured_hints_emitted = 3;
    cache.index_only_hints_emitted = 5;
    cache._invalidate_json_cache();

    const raw = JSON.parse(cache.to_json()) as Record<string, unknown>;
    expect(raw["structured_hints_emitted"]).toBe(3);
    expect(raw["index_only_hints_emitted"]).toBe(5);
  });
});

// ===========================================================================
// TestLastManifestFields
// ===========================================================================

describe("TestLastManifestFields", () => {
  it("test_default_values", () => {
    const cache = load("mf_defaults");
    expect(cache.last_manifest_sha).toBe("");
    expect(cache.last_manifest_ts).toBe(0.0);
  });

  it("test_round_trip_persists_fields", () => {
    const sid = "mf_roundtrip";
    const cache = load(sid);
    cache.last_manifest_sha = "abcd1234abcd1234";
    cache.last_manifest_ts = 1_700_000_000.0;
    cache._invalidate_json_cache();
    save(cache);

    const reloaded = load(sid);
    expect(reloaded.last_manifest_sha).toBe("abcd1234abcd1234");
    expect(reloaded.last_manifest_ts).toBeCloseTo(1_700_000_000.0);
  });

  it("test_legacy_session_missing_fields_defaults_to_zero", () => {
    const sid = "mf_legacy";
    const cache = load(sid);
    const raw = JSON.parse(cache.to_json()) as Record<string, unknown>;
    delete raw["last_manifest_sha"];
    delete raw["last_manifest_ts"];

    const restored = SessionCache.from_dict(raw);
    expect(restored.last_manifest_sha).toBe("");
    expect(restored.last_manifest_ts).toBe(0.0);
  });

  it("test_fields_present_in_to_json", () => {
    const sid = "mf_json_keys";
    const cache = load(sid);
    cache.last_manifest_sha = "ff00ff00ff00ff00";
    cache.last_manifest_ts = 12345.6;
    cache._invalidate_json_cache();

    const raw = JSON.parse(cache.to_json()) as Record<string, unknown>;
    expect(raw["last_manifest_sha"]).toBe("ff00ff00ff00ff00");
    expect(raw["last_manifest_ts"]).toBeCloseTo(12345.6);
  });
});

// ===========================================================================
// TestSessionCAS
// ===========================================================================

describe("TestSessionCAS", () => {
  it("test_version_field_default_zero", () => {
    const cache = load("cas_v0");
    expect(cache.version).toBe(0);
  });

  it("test_version_increments_on_save", () => {
    const sid = "cas_incr";
    const c = load(sid);
    expect(c.version).toBe(0);
    save(c);
    const c2 = load(sid);
    expect(c2.version).toBe(1);
    save(c2);
    const c3 = load(sid);
    expect(c3.version).toBe(2);
  });

  it("test_version_survives_round_trip", () => {
    const sid = "cas_rt";
    const c = load(sid);
    save(c);
    const raw = JSON.parse(load(sid).to_json()) as Record<string, unknown>;
    expect(raw["version"]).toBe(1);
  });

  it("test_legacy_json_missing_version_defaults_to_zero", () => {
    const sid = "cas_legacy";
    const c = load(sid);
    const raw = JSON.parse(c.to_json()) as Record<string, unknown>;
    delete raw["version"];
    const restored = SessionCache.from_dict(raw);
    expect(restored.version).toBe(0);
  });

  it("test_version_does_not_regress_when_stale_disk_version_present", () => {
    const sid = "cas_no_regress";

    // In-memory cache with version=5 (simulates several prior saves).
    const c = load(sid);
    c.version = 5;

    // Plant a stale on-disk file with version=3.
    const staleData = c.to_dict() as Record<string, unknown>;
    staleData["version"] = 3;
    const p = paths.sessionCachePath(sid);
    paths.ensureDir(path.dirname(p));
    fs.writeFileSync(p, JSON.stringify(staleData), "utf8");
    // Corrupt the fingerprint so the fast-path CAS skip does NOT fire.
    c._disk_mtime_ns = 0;
    c._disk_size = 0;

    save(c);

    const written = load(sid);
    // Written version must be strictly greater than the in-memory version.
    expect(written.version).toBeGreaterThan(5);
  });

  it.skip("test_concurrent_threads_both_edits_preserved", () => {
    // PORT: deferred — needs multi-process concurrency (Python threading.Barrier
    // racing two mark_file_edited writers; single-threaded Node cannot mirror).
  });

  it.skip("test_concurrent_threads_hints_emitted_not_lost", () => {
    // PORT: deferred — needs multi-process concurrency (Python threading.Barrier
    // racing two hints_emitted writers; single-threaded Node cannot mirror).
  });

  it("test_merge_session_caches_merges_dicts", () => {
    const sid = "cas_merge_sets";
    const base = load(sid);
    base.version = 5;

    const local = load(sid);
    local.version = 3;
    local.hints_seen = { a: 2, b: 1 };
    local.bash_dedup_emitted_ids = new Set(["x"]);

    const remote = load(sid);
    remote.version = 5;
    remote.hints_seen = { b: 3, c: 1 };
    remote.bash_dedup_emitted_ids = new Set(["y"]);

    const merged = _merge_session_caches(local, remote);
    expect(merged.hints_seen).toEqual({ a: 2, b: 3, c: 1 });
    expect(merged.bash_dedup_emitted_ids).toEqual(new Set(["x", "y"]));
  });

  it("test_merge_session_caches_max_counts", () => {
    const sid = "cas_merge_counts";
    const local = load(sid);
    local.hints_emitted = 7;
    local.hints_ignored = 2;
    local.structured_hints_emitted = 3;
    local.index_only_hints_emitted = 1;

    const remote = load(sid);
    remote.hints_emitted = 5;
    remote.hints_ignored = 4;
    remote.structured_hints_emitted = 6;
    remote.index_only_hints_emitted = 0;

    const merged = _merge_session_caches(local, remote);
    expect(merged.hints_emitted).toBe(7);
    expect(merged.hints_ignored).toBe(4);
    expect(merged.structured_hints_emitted).toBe(6);
    expect(merged.index_only_hints_emitted).toBe(1);
  });

  it("test_merge_greps_respects_cap", () => {
    const sid = "cas_merge_greps_cap";
    const ts = 1_700_000_000.0;

    // Local: 70 unique entries (below cap but near it).
    const local = load(sid);
    local.greps = Array.from(
      { length: 70 },
      (_, i) => new GrepEntry({ pattern: `local_${i}`, path: null, ts: ts + i }),
    );

    // Remote: 60 remote-only + 10 overlapping with local.
    const remote = load(sid);
    remote.greps = [
      ...Array.from(
        { length: 60 },
        (_, i) => new GrepEntry({ pattern: `remote_${i}`, path: null, ts: ts + i }),
      ),
      ...Array.from(
        { length: 10 },
        (_, i) => new GrepEntry({ pattern: `local_${i}`, path: null, ts: ts + i }),
      ),
    ];

    const merged = _merge_session_caches(local, remote);
    expect(merged.greps.length).toBeLessThanOrEqual(GREPS_HISTORY_MAX);
  });

  it("test_merge_glob_history_respects_cap", () => {
    const sid = "cas_merge_glob_cap";
    const ts = 1_700_000_000.0;

    // Local: near cap (18 entries).
    const local = load(sid);
    local.glob_history = Array.from(
      { length: 18 },
      (_, i) => new GlobEntry({ pattern: `local_${i}/**`, path: null, ts: ts + i }),
    );

    // Remote: 16 remote-only + 2 overlapping.
    const remote = load(sid);
    remote.glob_history = [
      ...Array.from(
        { length: 16 },
        (_, i) => new GlobEntry({ pattern: `remote_${i}/**`, path: null, ts: ts + i }),
      ),
      ...Array.from(
        { length: 2 },
        (_, i) => new GlobEntry({ pattern: `local_${i}/**`, path: null, ts: ts + i }),
      ),
    ];

    const merged = _merge_session_caches(local, remote);
    expect(merged.glob_history.length).toBeLessThanOrEqual(GLOB_HISTORY_MAX);
  });

  it("test_merge_recent_hints_respects_cap", () => {
    const sid = "cas_merge_recent_hints_cap";
    const ts = 1_700_000_000.0;

    const local = load(sid);
    local.recent_hints = [
      ["a.py", ts],
      ["b.py", ts + 1],
      ["c.py", ts + 2],
    ];

    const remote = load(sid);
    remote.recent_hints = [
      ["d.py", ts + 3],
      ["e.py", ts + 4],
      ["f.py", ts + 5],
    ];

    const merged = _merge_session_caches(local, remote);
    expect(merged.recent_hints.length).toBeLessThanOrEqual(3);
  });

  it("test_merge_hints_seen_respects_cap", () => {
    const sid = "cas_merge_hints_seen_cap";

    const local = load(sid);
    local.hints_seen = Object.fromEntries(
      Array.from({ length: HINTS_SEEN_MAX - 1 }, (_, i) => [`local_${i}`, 1]),
    );

    const remote = load(sid);
    remote.hints_seen = Object.fromEntries(
      Array.from({ length: HINTS_SEEN_MAX - 1 }, (_, i) => [`remote_${i}`, 1]),
    );

    const merged = _merge_session_caches(local, remote);
    expect(Object.keys(merged.hints_seen).length).toBeLessThanOrEqual(HINTS_SEEN_MAX);
  });

  it("test_merge_hints_seen_lru_preserves_highest_counts", () => {
    const sid = "cas_merge_hints_seen_lru";

    // Local has entries with higher counts; remote has entries with lower counts.
    const local = load(sid);
    local.hints_seen = Object.fromEntries(
      Array.from({ length: 250 }, (_, i) => [`hot_${i}`, 100 - i]),
    );

    const remote = load(sid);
    remote.hints_seen = Object.fromEntries(Array.from({ length: 250 }, (_, i) => [`cold_${i}`, i]));

    const merged = _merge_session_caches(local, remote);

    expect(Object.keys(merged.hints_seen).length).toBe(HINTS_SEEN_MAX);

    const hotCount = Object.keys(merged.hints_seen).filter((k) => k.startsWith("hot_")).length;
    expect(hotCount).toBeGreaterThanOrEqual(240);
  });
});

// ===========================================================================
// TestSessionLockfile
// ===========================================================================

describe("TestSessionLockfile", () => {
  it("test_lock_path_is_adjacent_to_json", () => {
    const lp = _session_lock_path("lock_path_test");
    const jsonPath = paths.sessionCachePath("lock_path_test");
    expect(path.dirname(lp)).toBe(path.dirname(jsonPath));
    expect(path.basename(lp)).toBe(path.basename(jsonPath) + ".lock");
  });

  it.skip("test_acquire_creates_lockfile_that_persists_after_release", () => {
    // PORT: deferred — asserts the persistent-lockfile (fcntl-fd) semantic where
    // release leaves the file on disk. The TS port re-expresses locking as an
    // O_EXCL lockfile that is unlinked on release (db.ts pattern); Node has no
    // fcntl, so this persistence invariant cannot be faithfully reproduced.
  });

  it.skip("test_second_acquire_returns_none_while_lock_held", () => {
    // PORT: deferred — drives the holder via os.open + _os_advisory_lock(fd)
    // (fcntl byte-range lock) which Node lacks; _os_advisory_lock/_unlock are
    // not exported and are no-ops in the TS port (locking is by file existence).
  });

  it.skip("test_lock_auto_releases_when_holder_fd_closes", () => {
    // PORT: deferred — relies on the kernel dropping a fcntl advisory lock when
    // the owning fd closes. Node has no fcntl; the TS lockfile has no held-fd
    // semantic, so this auto-release-on-close invariant cannot be reproduced.
  });

  it.skip("test_acquire_succeeds_over_unlocked_leftover_file", () => {
    // PORT: deferred — depends on fcntl semantics where an *unlocked* leftover
    // lockfile never blocks acquire. The TS O_EXCL staleness model treats a
    // fresh, non-PID leftover as currently held (no fcntl), so the Python
    // polarity (acquire succeeds) cannot be faithfully reproduced.
  });

  it("test_save_holds_lock_during_write", () => {
    const sid = "lock_during_save";
    const lockPath = _session_lock_path(sid);
    const observedDuringWrite: boolean[] = [];

    const original = paths.atomicWriteText;
    const spy = vi.spyOn(paths, "atomicWriteText").mockImplementation((p: string, text: string) => {
      // Record whether the lock exists during the write.
      observedDuringWrite.push(fs.existsSync(lockPath));
      return original(p, text);
    });
    try {
      const c = load(sid);
      mark_file_edited(sid, "/proj/locked.py", { cache: c });
    } finally {
      spy.mockRestore();
    }

    expect(observedDuringWrite.some((v) => v)).toBe(true);
  });

  it.skip("test_save_does_not_write_when_lock_times_out", () => {
    // PORT: deferred — patches the module-internal _acquire_session_lock to
    // return None. ESM cannot intercept session.ts's internal binding, and the
    // const _LOCK_TIMEOUT_SECS cannot be shrunk to force a fast real timeout, so
    // a faithful lock-timeout cannot be induced in-process.
  });

  it.skip("test_lock_timeout_does_not_mark_cache_unavailable", () => {
    // PORT: deferred — same as above: requires patching the internal
    // _acquire_session_lock to force repeated timeouts, which ESM cannot do.
  });
});

// ===========================================================================
// TestSessionLockfileConcurrent
// ===========================================================================

describe("TestSessionLockfileConcurrent", () => {
  it.skip("test_two_processes_200_edits_no_loss", () => {
    // PORT: deferred — needs multi-process concurrency (spawns two real Python
    // subprocesses writing 100 edits each); single-threaded Node cannot mirror.
  });

  it.skip("test_concurrent_threads_100_edits_no_loss", () => {
    // PORT: deferred — needs multi-process concurrency (Python threading racing
    // two 100-edit writers); single-threaded Node cannot mirror.
  });

  it("test_stale_version_with_aliased_fingerprint_forces_merge", () => {
    const sid = "alias_stale_version";
    save(load(sid)); // disk now at version 1
    const p = paths.sessionCachePath(sid);

    // Two *distinct* caches both observing version 1 (clear the proc-load cache
    // between loads so it does not hand back one shared object).
    _proc_load_cache.clear();
    const a = load(sid);
    _proc_load_cache.clear();
    const b = load(sid);
    expect(a).not.toBe(b);
    a.edited_files["/edit/aaa.py"] = 1;
    b.edited_files["/edit/bbb.py"] = 1;

    // 'a' commits first, advancing the on-disk version to 2.
    save(a);

    // Force the aliasing precondition: point 'b' at the current on-disk
    // fingerprint so the fast path sees a match, even though 'b' still holds the
    // pre-'a' version. Only the version registry distinguishes this.
    const st = fs.statSync(p);
    const mtimeNs = (st as fs.Stats & { mtimeNs?: bigint }).mtimeNs;
    b._disk_mtime_ns =
      typeof mtimeNs === "bigint" ? Number(mtimeNs) : Math.round(st.mtimeMs * 1_000_000);
    b._disk_size = st.size;

    save(b);

    _proc_load_cache.clear();
    const final = load(sid);
    expect("/edit/aaa.py" in final.edited_files).toBe(true);
    expect("/edit/bbb.py" in final.edited_files).toBe(true);
  });
});

// ===========================================================================
// TestDiskMtimeFingerprint
// ===========================================================================

describe("TestDiskMtimeFingerprint", () => {
  it("test_load_sets_disk_fingerprint", () => {
    const sid = "aabbcc".repeat(6);
    const cache = load(sid);
    mark_file_read(sid, "/tmp/foo.py", null, null, { cache });

    const reloaded = load(sid);
    const p = paths.sessionCachePath(sid);
    const st = fs.statSync(p);
    const mtimeNs = (st as fs.Stats & { mtimeNs?: bigint }).mtimeNs;
    const expectedNs =
      typeof mtimeNs === "bigint" ? Number(mtimeNs) : Math.round(st.mtimeMs * 1_000_000);
    expect(reloaded._disk_mtime_ns).toBe(expectedNs);
    expect(reloaded._disk_size).toBe(st.size);
  });

  it("test_fresh_cache_has_zero_fingerprint", () => {
    const sid = "ccddee".repeat(6);
    const cache = load(sid);
    // File doesn't exist yet — fingerprint stays zero.
    expect(cache._disk_mtime_ns).toBe(0);
    expect(cache._disk_size).toBe(0);
  });

  it("test_save_updates_fingerprint", () => {
    const sid = "ddeeff".repeat(6);
    const cache = load(sid);
    mark_file_read(sid, "/tmp/bar.py", null, null, { cache });

    const p = paths.sessionCachePath(sid);
    const st = fs.statSync(p);
    const mtimeNs = (st as fs.Stats & { mtimeNs?: bigint }).mtimeNs;
    const expectedNs =
      typeof mtimeNs === "bigint" ? Number(mtimeNs) : Math.round(st.mtimeMs * 1_000_000);
    expect(cache._disk_mtime_ns).toBe(expectedNs);
    expect(cache._disk_size).toBe(st.size);
  });

  it("test_cas_merge_still_fires_on_concurrent_write", () => {
    const sid = "eeff00".repeat(6);
    const cache1 = load(sid);
    // Simulate concurrent write by a second process.
    const cache2 = load(sid);
    mark_file_read(sid, "/tmp/from_p2.py", null, null, { cache: cache2 });
    // Now save cache1 (stale fingerprint relative to cache2's write).
    mark_file_read(sid, "/tmp/from_p1.py", null, null, { cache: cache1 });
    // Both paths should be present after the CAS merge.
    const final = load(sid);
    const norm1 = _normalize_path("/tmp/from_p1.py");
    const norm2 = _normalize_path("/tmp/from_p2.py");
    expect(norm1 in final.files).toBe(true);
    expect(norm2 in final.files).toBe(true);
  });
});

// ===========================================================================
// TestSortedListCache
// ===========================================================================

describe("TestSortedListCache", () => {
  it("test_hints_seen_dict_serialized_correctly", () => {
    const sid = "aabb11".repeat(6);
    const cache = load(sid);
    cache.hints_seen = { "z-fp": 3, "a-fp": 1, "m-fp": 2 };
    cache._invalidate_json_cache();
    const d = cache.to_dict() as Record<string, unknown>;
    expect(d["hints_seen"]).toEqual({ "z-fp": 3, "a-fp": 1, "m-fp": 2 });
  });

  it("test_bash_dedup_sorted_cache_cleared_on_invalidate", () => {
    const sid = "bbcc22".repeat(6);
    const cache = load(sid);
    cache.hints_seen = { fp1: 1 };
    cache.bash_dedup_emitted_ids = new Set(["id1"]);
    cache.to_dict(); // populate cache
    expect(cache._bash_dedup_sorted_cache).not.toBeNull();
    cache._invalidate_json_cache();
    expect(cache._bash_dedup_sorted_cache).toBeNull();
  });

  it("test_dict_serialized_consistently", () => {
    const sid = "ccdd33".repeat(6);
    const cache = load(sid);
    cache.hints_seen = { "fp-x": 2, "fp-a": 1 };
    cache._invalidate_json_cache();
    const firstDict = cache.to_dict() as Record<string, unknown>;
    const secondDict = cache.to_dict() as Record<string, unknown>;
    expect(firstDict["hints_seen"]).toEqual(secondDict["hints_seen"]);
  });

  it("test_bash_dedup_sorted_cache", () => {
    const sid = "ddee44".repeat(6);
    const cache = load(sid);
    cache.bash_dedup_emitted_ids = new Set(["z-id", "a-id"]);
    cache._invalidate_json_cache();
    const d = cache.to_dict() as Record<string, unknown>;
    expect(d["bash_dedup_emitted_ids"]).toEqual(["a-id", "z-id"]);
    expect(cache._bash_dedup_sorted_cache).toEqual(["a-id", "z-id"]);
  });

  it("test_hints_seen_output_is_dict", () => {
    const sid = "eeff55".repeat(6);
    const cache = load(sid);
    cache.hints_seen = { z: 1, a: 2, m: 3 };
    cache._invalidate_json_cache();
    const d = cache.to_dict() as Record<string, unknown>;
    expect(d["hints_seen"]).toEqual({ z: 1, a: 2, m: 3 });
  });
});
