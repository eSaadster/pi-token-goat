/**
 * Unit tests for token_goat/session — 1:1 port of tests/test_session.py
 * (the in-scope subset: TestSessionCacheBasics .. TestBashDedupEmittedIds,
 * Python source lines ~13-1175).
 *
 * Test-seam mapping (Python → TS):
 *  - tmp_data_dir fixture            → setup.ts's setDataDirOverride per test
 *    (already applied in its beforeEach); the session/lock/tmp files resolve
 *    under that dir via paths.sessionCachePath, so no test hardcodes a path.
 *  - monkeypatch.setattr(session.time, "time", itertools.count(...))
 *      → vi.spyOn(Date, "now") returning a monotonic counter (the TS session
 *        stamps timestamps from Date.now()/1000, so an incrementing Date.now()
 *        reproduces the strictly-increasing clock the Python test installed).
 *  - monkeypatch.setattr(pathlib.Path, "read_text", boom)
 *      → vi.spyOn(fs, "readFileSync") throwing an EACCES ErrnoException for the
 *        session-cache path (load() reads via fs.readFileSync).
 *  - patch.object(session, "save", ...) to batch writes
 *      → omitted. vi.spyOn cannot intercept session's INTERNAL direct call to
 *        save() (ESM lexical binding), and the Python patch was only a perf
 *        optimisation — the assertions hold with the real save() writing to the
 *        per-test isolated tmp data dir. See parity_notes.
 *  - `from token_goat import db` + `with db.open_global() as conn`
 *      → openGlobal((conn) => conn.prepare(...).all()) from db.js (callback form;
 *        better-sqlite3 .prepare/.all replaces sqlite3 .execute/.fetchall).
 *  - _MAX_SYMBOLS_PER_FILE is NOT exported from session.ts; the verbatim value
 *    (50) is inlined where the Python test imported it (noted at the call site).
 *
 * Keyword-arg → options-object mapping for the session API the tests call:
 *  - mark_file_read(sid, p, offset=0, limit=100, symbol=..., cache=...)
 *      → mark_file_read(sid, p, 0, 100, { symbol, cache })
 *  - mark_grep(sid, pattern, path=..., result_count=..., cache=...)
 *      → mark_grep(sid, pattern, path, result_count, { cache })
 *  - mark_file_edited(sid, p, cache=...) → (sid, p, { cache })
 *  - get_file_entry(sid, p)             → (sid, p)
 *  - safe_load(sid, caller=...)         → (sid, { caller })
 *  - put_result_cache(sid, rel, item, kind, sha, result, cache=...)
 *      → (sid, rel, item, kind, sha, result, { cache })
 *  - get_result_cache(sid, rel, item, kind, sha) → same positional shape.
 *  - SessionCache("id", 0, 0)
 *      → new SessionCache({ session_id: "id", started_ts: 0, last_activity_ts: 0 })
 *
 * Every Python `def test_*` maps to a vitest `it()` with the same name and the
 * same assertion polarity. parametrize is unrolled; deferred tests carry a
 * one-line "// PORT: deferred — <reason>" note and are counted in tests_skipped.
 */
import fs from "node:fs";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import * as session from "../src/token_goat/session.js";
import {
  SessionCache,
  _merge_ranges,
  _merge_session_caches,
} from "../src/token_goat/session.js";
import * as paths from "../src/token_goat/paths.js";
import { openGlobal } from "../src/token_goat/db.js";

// ---------------------------------------------------------------------------
// _MAX_SYMBOLS_PER_FILE is a module-private constant in session.ts (not
// exported). The Python test imports it; we inline its verbatim value here.
// (session.ts: `const _MAX_SYMBOLS_PER_FILE = 50;`)
// ---------------------------------------------------------------------------
const _MAX_SYMBOLS_PER_FILE = 50;

// ---------------------------------------------------------------------------
// Time mock helper: install a strictly-increasing Date.now() (ms), mirroring
// the Python `itertools.count(1_000_000_000.0, 0.01)` monkeypatch of
// session.time.time. The session stamps from Date.now()/1000, so we return ms.
// ---------------------------------------------------------------------------
function installMonotonicClock(): void {
  let nowMs = 1_000_000_000_000; // 1e9 seconds, in ms
  vi.spyOn(Date, "now").mockImplementation(() => {
    const cur = nowMs;
    nowMs += 10; // +0.01s per call
    return cur;
  });
}

afterEach(() => {
  vi.restoreAllMocks();
});

// ===========================================================================
// TestSessionCacheBasics
// ===========================================================================
describe("TestSessionCacheBasics", () => {
  it("test_load_nonexistent_returns_empty_cache", () => {
    const cache = session.load("test_session_xyz");
    expect(cache.session_id).toBe("test_session_xyz");
    expect(cache.started_ts).toBeGreaterThan(0);
    expect(cache.last_activity_ts).toBeGreaterThan(0);
    expect(cache.files).toEqual({});
    expect(cache.greps).toEqual([]);
  });

  it("test_mark_file_read_and_roundtrip", () => {
    const session_id = "test_session_1";
    const returned = session.mark_file_read(session_id, "src/foo/bar.py", 0, 100);
    expect(returned.session_id).toBe(session_id);
    expect("src/foo/bar.py" in returned.files).toBe(true);
    const entry = returned.files["src/foo/bar.py"]!;
    expect(entry.read_count).toBe(1);
    expect(entry.line_ranges).toEqual([[1, 100]]);

    // Load again and verify persistence
    const loaded = session.load(session_id);
    expect("src/foo/bar.py" in loaded.files).toBe(true);
    expect(loaded.files["src/foo/bar.py"]!.read_count).toBe(1);
  });

  it("test_reset_session_deletes_file", () => {
    const session_id = "test_reset";
    session.mark_file_read(session_id, "file.py");
    expect(Object.keys(session.load(session_id).files).length).toBeGreaterThan(0);
    session.reset_session(session_id);
    const fresh = session.load(session_id);
    expect(fresh.files).toEqual({});
    expect(fresh.greps).toEqual([]);
  });

  it("test_atomic_save_no_tmp_artifact", () => {
    const session_id = "atomic_save_test";
    session.load(session_id);
    session.mark_file_read(session_id, "src/test.py", 0, 50);
    // After save, check that no .tmp files exist in the session dir
    const session_path = paths.sessionCachePath(session_id);
    const parent_dir = path.dirname(session_path);
    const base = path.basename(session_path);
    const tmp_files = fs
      .readdirSync(parent_dir)
      .filter((n) => n.startsWith(base) && n.endsWith(".tmp"));
    expect(tmp_files, `Unexpected .tmp artifacts: ${tmp_files}`).toEqual([]);
  });

  it("test_atomic_save_tmp_cleanup_on_write_failure", () => {
    // Python mocked json.dumps to raise on the first call; the TS analogue
    // forces the atomic write to fail (paths.atomicWriteText throws once), and
    // asserts no .tmp artifact remains afterward. save() suppresses the failure
    // (best-effort retry loop), exactly like the Python contextlib.suppress.
    const session_id = "atomic_fail_test";
    const cache = session.load(session_id);
    session.mark_file_read(session_id, "src/fail.py", 0, 25);

    const realAtomicWrite = paths.atomicWriteText;
    const callCount = { n: 0 };
    const spy = vi
      .spyOn(paths, "atomicWriteText")
      .mockImplementation((p: string, content: string) => {
        callCount.n += 1;
        if (callCount.n === 1) {
          throw new Error("Simulated write failure");
        }
        // Delegate to the real implementation for any subsequent call.
        return realAtomicWrite(p, content);
      });

    const session_path = paths.sessionCachePath(session_id);
    const parent_dir = path.dirname(session_path);
    const base = path.basename(session_path);

    // Attempt to save again — should fail but clean up .tmp.
    try {
      session.save(cache);
    } catch {
      // suppress
    } finally {
      spy.mockRestore();
    }

    const tmp_files = fs
      .readdirSync(parent_dir)
      .filter((n) => n.startsWith(base) && n.endsWith(".tmp"));
    expect(tmp_files, `Temporary files not cleaned up: ${tmp_files}`).toEqual([]);
  });

  it("test_atomic_save_roundtrip_loads_correctly", () => {
    const session_id = "atomic_roundtrip_test";
    // Create initial session and add data
    session.mark_file_read(session_id, "src/app.py", 0, 100);
    session.mark_file_read(session_id, "src/utils.py", 50, 75);
    session.mark_grep(session_id, "pattern", "src/app.py", 10);

    // Load and verify
    const loaded = session.load(session_id);
    expect("src/app.py" in loaded.files).toBe(true);
    expect(loaded.files["src/app.py"]!.read_count).toBe(1);
    expect(loaded.files["src/app.py"]!.line_ranges).toEqual([[1, 100]]);
    expect("src/utils.py" in loaded.files).toBe(true);
    expect(loaded.files["src/utils.py"]!.line_ranges).toEqual([[51, 125]]);
    expect(loaded.greps.length).toBe(1);
    expect(loaded.greps[0]!.pattern).toBe("pattern");
    expect(loaded.greps[0]!.result_count).toBe(10);
  });
});

// ===========================================================================
// TestLineRanges
// ===========================================================================
describe("TestLineRanges", () => {
  it("test_single_range", () => {
    const cache = session.mark_file_read("s1", "f.py", 10, 50);
    const ranges = cache.files["f.py"]!.line_ranges;
    expect(ranges).toEqual([[11, 60]]);
  });

  it("test_merge_overlapping_ranges", () => {
    let cache = session.mark_file_read("s2", "f.py", 0, 50);
    expect(cache.files["f.py"]!.line_ranges).toEqual([[1, 50]]);
    cache = session.mark_file_read("s2", "f.py", 39, 61);
    // offset=39 means start at line 40, limit=61 means end at line 100
    expect(cache.files["f.py"]!.line_ranges).toEqual([[1, 100]]);
  });

  it("test_merge_adjacent_ranges", () => {
    let cache = session.mark_file_read("s3", "f.py", 0, 50);
    cache = session.mark_file_read("s3", "f.py", 50, 50);
    // First: (1, 50), Second: (51, 100) — should merge
    expect(cache.files["f.py"]!.line_ranges).toEqual([[1, 100]]);
  });

  it("test_disjoint_ranges_stay_separate", () => {
    let cache = session.mark_file_read("s4", "f.py", 0, 50);
    cache = session.mark_file_read("s4", "f.py", 199, 101);
    const ranges = [...cache.files["f.py"]!.line_ranges].sort((a, b) => a[0] - b[0]);
    expect(ranges).toEqual([[1, 50], [200, 300]]);
  });

  it("test_symbol_read_adds_no_line_range", () => {
    const cache = session.mark_file_read("s5", "f.py", null, null, { symbol: "myfunction" });
    const entry = cache.files["f.py"]!;
    expect(entry.symbols_read).toContain("myfunction");
    expect(entry.line_ranges).toEqual([]);
    expect(entry.read_count).toBe(1);
  });

  it("test_symbol_dedup", () => {
    session.mark_file_read("s6", "f.py", null, null, { symbol: "foo" });
    const cache = session.mark_file_read("s6", "f.py", null, null, { symbol: "foo" });
    expect(cache.files["f.py"]!.symbols_read).toEqual(["foo"]);
  });

  it("test_symbol_dedup_multiple_repeated_reads", () => {
    let cache = session.mark_file_read("s6b", "f.py", null, null, { symbol: "my_function" });
    for (let i = 1; i < 10; i++) {
      cache = session.mark_file_read("s6b", "f.py", null, null, { symbol: "my_function" });
    }
    const entry = cache.files["f.py"]!;
    expect(
      entry.symbols_read,
      `Expected 1 entry, got ${entry.symbols_read.length}: ${entry.symbols_read}`,
    ).toEqual(["my_function"]);
  });

  it("test_repeated_identical_line_range_dedup", () => {
    let cache = session.mark_file_read("s4b", "f.py", 0, 50);
    for (let i = 1; i < 5; i++) {
      cache = session.mark_file_read("s4b", "f.py", 0, 50);
    }
    const ranges = cache.files["f.py"]!.line_ranges;
    expect(ranges.length, `Expected 1 range, got ${ranges.length}: ${ranges}`).toBe(1);
  });

  it("test_last_activity_ts_updated_when_symbol_sanitized_to_empty", () => {
    const before = Date.now() / 1000 - 1;
    // A symbol string that sanitize_log_str collapses to empty (newline only).
    const cache = session.mark_file_read("s_sanitize_empty", "f.py", null, null, {
      symbol: "\n",
    });
    expect(cache.last_activity_ts).toBeGreaterThan(before);
  });

  it("test_last_activity_ts_updated_when_symbols_cap_reached", () => {
    const sid = "s_symbols_cap";
    // Fill up to the cap. (Python batched writes by patching save to a no-op;
    // here the real save runs — to the per-test tmp data dir — which vitest's
    // forks pool isolates. _MAX_SYMBOLS_PER_FILE == 50, inlined above.)
    let cache = session.load(sid);
    for (let i = 0; i < _MAX_SYMBOLS_PER_FILE; i++) {
      cache = session.mark_file_read(sid, "f.py", null, null, { symbol: `sym_${i}`, cache });
    }
    session.save(cache);

    const before = Date.now() / 1000 - 1;
    cache = session.mark_file_read(sid, "f.py", null, null, { symbol: "overflow_sym" });
    expect(cache.last_activity_ts).toBeGreaterThan(before);
  });

  it("test_idempotency_same_range_twice", () => {
    let cache = session.mark_file_read("s_ident", "f.py", 10, 40);
    const ranges_after_first = [...cache.files["f.py"]!.line_ranges];
    cache = session.mark_file_read("s_ident", "f.py", 10, 40);
    const ranges_after_second = [...cache.files["f.py"]!.line_ranges];
    expect(ranges_after_first).toEqual([[11, 50]]);
    expect(ranges_after_second).toEqual([[11, 50]]);
  });

  it("test_gap_greater_than_one_no_merge", () => {
    let cache = session.mark_file_read("s_gap", "f.py", 0, 5);
    expect(cache.files["f.py"]!.line_ranges).toEqual([[1, 5]]);
    cache = session.mark_file_read("s_gap", "f.py", 6, 4);
    // offset=6 → line 7, limit=4 → end at line 10
    const ranges = [...cache.files["f.py"]!.line_ranges].sort((a, b) => a[0] - b[0]);
    expect(ranges).toEqual([[1, 5], [7, 10]]);
  });

  it("test_gap_exactly_one_merge", () => {
    let cache = session.mark_file_read("s_gap1", "f.py", 0, 5);
    cache = session.mark_file_read("s_gap1", "f.py", 5, 5);
    // First: offset=0, limit=5 → (1, 5); Second: offset=5, limit=5 → (6, 10)
    expect(cache.files["f.py"]!.line_ranges).toEqual([[1, 10]]);
  });

  it("test_three_ranges_partial_merge", () => {
    let cache = session.mark_file_read("s_three", "f.py", 0, 5);
    cache = session.mark_file_read("s_three", "f.py", 5, 5);
    cache = session.mark_file_read("s_three", "f.py", 19, 11);
    // (1,5) + (6,10) merge → (1,10), then (20,30) stays separate
    expect(cache.files["f.py"]!.line_ranges).toEqual([[1, 10], [20, 30]]);
  });

  it("test_merge_ranges_unsorted_input", () => {
    const input: Array<[number, number]> = [[20, 30], [1, 10], [5, 15]];
    const result = _merge_ranges(input);
    // After sort: (1,10), (5,15), (20,30); (1,10) overlaps (5,15) → (1,15)
    expect(result).toEqual([[1, 15], [20, 30]]);
  });

  it("test_merge_ranges_empty_list", () => {
    expect(_merge_ranges([])).toEqual([]);
  });

  it("test_merge_ranges_single_range", () => {
    const input: Array<[number, number]> = [[5, 10]];
    const result = _merge_ranges(input);
    expect(result).toEqual([[5, 10]]);
  });

  it("test_merge_ranges_duplicate_ranges", () => {
    const input: Array<[number, number]> = [[5, 10], [5, 10]];
    const result = _merge_ranges(input);
    expect(result).toEqual([[5, 10]]);
  });

  it("test_merge_ranges_complete_overlap", () => {
    const input: Array<[number, number]> = [[1, 100], [10, 50]];
    const result = _merge_ranges(input);
    expect(result).toEqual([[1, 100]]);
  });
});

// ===========================================================================
// TestGrep
// ===========================================================================
describe("TestGrep", () => {
  it("test_mark_grep_appends_and_persists", () => {
    const cache = session.mark_grep("s7", "def myfunction", "src/", 5);
    expect(cache.greps.length).toBe(1);
    expect(cache.greps[0]!.pattern).toBe("def myfunction");
    expect(cache.greps[0]!.path).toBe("src/");
    expect(cache.greps[0]!.result_count).toBe(5);

    const loaded = session.load("s7");
    expect(loaded.greps.length).toBe(1);
    expect(loaded.greps[0]!.pattern).toBe("def myfunction");
  });

  it("test_multiple_greps", () => {
    session.mark_grep("s8", "pattern1");
    session.mark_grep("s8", "pattern2");
    const cache = session.load("s8");
    expect(cache.greps.length).toBe(2);
    expect(cache.greps[0]!.pattern).toBe("pattern1");
    expect(cache.greps[1]!.pattern).toBe("pattern2");
  });
});

// ===========================================================================
// TestPathNormalization
// ===========================================================================
describe("TestPathNormalization", () => {
  it("test_backslash_to_forward_slash", () => {
    session.mark_file_read("s9", "C:\\foo\\bar.py");
    const cache2 = session.mark_file_read("s9", "C:/foo/bar.py");
    // Both should reference the same entry; drive letter is lowercased.
    expect(Object.keys(cache2.files).length).toBe(1);
    expect(cache2.files["c:/foo/bar.py"]!.read_count).toBe(2);
  });

  it("test_drive_letter_lowercase", () => {
    session.mark_file_read("s10", "C:/foo.py");
    const cache2 = session.mark_file_read("s10", "c:/foo.py");
    expect(Object.keys(cache2.files).length).toBe(1);
    expect(cache2.files["c:/foo.py"]!.read_count).toBe(2);
  });

  it("test_relative_paths_preserved", () => {
    const cache = session.mark_file_read("s11", "src/foo.py");
    expect("src/foo.py" in cache.files).toBe(true);
  });
});

// ===========================================================================
// TestListTouched
// ===========================================================================
describe("TestListTouched", () => {
  it("test_list_touched_sorted_by_timestamp", () => {
    const s_id = "s12";
    installMonotonicClock();
    session.mark_file_read(s_id, "a.py");
    session.mark_file_read(s_id, "b.py");
    session.mark_file_read(s_id, "c.py");

    const entries = session.list_touched(s_id);
    const paths_ = entries.map((e) => e.rel_or_abs);
    expect(paths_).toEqual(["c.py", "b.py", "a.py"]);
  });

  it("test_list_touched_empty", () => {
    const entries = session.list_touched("s_empty");
    expect(entries).toEqual([]);
  });
});

// ===========================================================================
// TestCorruptedJson
// ===========================================================================
describe("TestCorruptedJson", () => {
  it("test_corrupted_json_logs_and_resets", () => {
    const session_id = "s13";
    const cache_path = paths.sessionCachePath(session_id);
    fs.mkdirSync(path.dirname(cache_path), { recursive: true });
    fs.writeFileSync(cache_path, "{ invalid json }", "utf8");

    const loaded = session.load(session_id);
    expect(loaded.session_id).toBe(session_id);
    expect(loaded.files).toEqual({});
    expect(loaded.greps).toEqual([]);
  });
});

// ===========================================================================
// TestUnavailableCacheAccess
// ===========================================================================
describe("TestUnavailableCacheAccess", () => {
  it("test_mark_file_read_skips_when_cache_file_is_locked", () => {
    const session_id = "locked_read";
    session.mark_file_read(session_id, "seed.py");

    const cachePath = paths.sessionCachePath(session_id);
    const realReadFileSync = fs.readFileSync;
    const spy = vi.spyOn(fs, "readFileSync").mockImplementation(((
      file: fs.PathOrFileDescriptor,
      ...rest: unknown[]
    ) => {
      if (file === cachePath) {
        const err = new Error("[Errno 13] Permission denied") as NodeJS.ErrnoException;
        err.code = "EACCES";
        throw err;
      }
      return (realReadFileSync as unknown as (...a: unknown[]) => unknown)(file, ...rest);
    }) as typeof fs.readFileSync);
    try {
      session.mark_file_read(session_id, "new.py");
    } finally {
      spy.mockRestore();
    }

    // The seed read persisted; the read attempted under the lock did not.
    const loaded = session.load(session_id);
    expect("seed.py" in loaded.files).toBe(true);
    expect("new.py" in loaded.files).toBe(false);

    const rows = openGlobal((conn) =>
      conn
        .prepare(
          "SELECT kind, detail FROM stats WHERE kind = 'session_cache_unavailable'",
        )
        .all(),
    ) as Array<{ kind: string; detail: string }>;
    expect(rows.length).toBe(1);
    expect(rows[0]!.detail.startsWith("load:")).toBe(true);
  });

  // PORT: deferred — Python @pytest.mark.skip (asserts the old contract where
  // the in-memory cache stayed usable after a save failure; current production
  // marks the cache unavailable to avoid retry storms).
  it.skip("test_mark_file_read_save_failure_does_not_poison_cache", () => {});
});

// ===========================================================================
// TestCleanupStale
// ===========================================================================
describe("TestCleanupStale", () => {
  it("test_cleanup_stale_removes_old_files", () => {
    // Create two sessions, one fresh, one old
    const s_fresh = session.mark_file_read("fresh", "f.py");
    session.save(s_fresh);

    const s_old = session.load("old");
    s_old.started_ts = Date.now() / 1000 - 48 * 3600;
    s_old.last_activity_ts = Date.now() / 1000 - 48 * 3600;
    session.save(s_old);

    // Manually set the old file's mtime to 48h ago
    const old_path = paths.sessionCachePath("old");
    const old_mtime = Date.now() / 1000 - 48 * 3600;
    fs.utimesSync(old_path, old_mtime, old_mtime);

    // Cleanup with 24h cutoff
    const removed = session.cleanup_stale(24.0);
    expect(removed).toBeGreaterThanOrEqual(1);

    // Old should be gone
    const after_cleanup = session.load("old");
    expect(after_cleanup.files).toEqual({});
  });

  it("test_cleanup_stale_removes_orphaned_tmp_files", () => {
    const sessions_dir = path.dirname(paths.sessionCachePath("dummy"));
    fs.mkdirSync(sessions_dir, { recursive: true });

    // Create an old orphaned .tmp file (pattern: <session-id>.json.<tid>.<ns>.tmp)
    const old_tmp = path.join(sessions_dir, "orphan-abc123.json.140000.1000000.tmp");
    fs.writeFileSync(old_tmp, "{}", "utf8");
    const old_mtime = Date.now() / 1000 - 48 * 3600;
    fs.utimesSync(old_tmp, old_mtime, old_mtime);

    // Create a recent .tmp file — should NOT be removed
    const new_tmp = path.join(sessions_dir, "recent-def456.json.140001.2000000.tmp");
    fs.writeFileSync(new_tmp, "{}", "utf8");

    session.cleanup_stale(24.0);

    expect(fs.existsSync(old_tmp), "old orphaned .tmp should be removed").toBe(false);
    expect(fs.existsSync(new_tmp), "recent .tmp should be kept").toBe(true);
    try {
      fs.unlinkSync(new_tmp);
    } catch {
      // missing_ok
    }
  });
});

// ===========================================================================
// TestUpdateReadCount
// ===========================================================================
describe("TestUpdateReadCount", () => {
  it("test_multiple_reads_increment_count", () => {
    const s_id = "s14";
    const c1 = session.mark_file_read(s_id, "f.py", 0, 50);
    expect(c1.files["f.py"]!.read_count).toBe(1);

    const c2 = session.mark_file_read(s_id, "f.py", 100, 50);
    expect(c2.files["f.py"]!.read_count).toBe(2);

    const c3 = session.mark_file_read(s_id, "f.py", null, null, { symbol: "func" });
    expect(c3.files["f.py"]!.read_count).toBe(3);
  });
});

// ===========================================================================
// TestFullFileCollapseThreshold
// ===========================================================================
describe("TestFullFileCollapseThreshold", () => {
  it("test_file_read_9_times_keeps_ranges", () => {
    const s_id = "s_collapse_9";
    let cache: SessionCache | null = null;
    for (let i = 0; i < 9; i++) {
      const offset = i * 100;
      cache = session.mark_file_read(s_id, "f.py", offset, 50, { cache });
    }
    cache = session.load(s_id);
    const entry = cache.files["f.py"]!;
    expect(entry.read_count).toBe(9);
    // Should have ranges, not collapsed to sentinel
    expect(entry.line_ranges).not.toEqual([[0, 0]]);
    expect(entry.line_ranges.length).toBeGreaterThan(0);
  });

  it("test_file_read_10_times_collapses_to_sentinel", () => {
    const s_id = "s_collapse_10";
    let cache: SessionCache | null = null;
    for (let i = 0; i < 10; i++) {
      const offset = i * 100;
      cache = session.mark_file_read(s_id, "f.py", offset, 50, { cache });
    }
    cache = session.load(s_id);
    const entry = cache.files["f.py"]!;
    expect(entry.read_count).toBe(10);
    // Should be collapsed to sentinel
    expect(entry.line_ranges).toEqual([[0, 0]]);
  });

  it("test_sentinel_preserved_on_further_reads", () => {
    const s_id = "s_sentinel_preserved";
    let cache: SessionCache | null = null;
    for (let i = 0; i < 10; i++) {
      const offset = i * 100;
      cache = session.mark_file_read(s_id, "f.py", offset, 50, { cache });
    }
    // Read again several times
    for (let i = 0; i < 3; i++) {
      cache = session.mark_file_read(s_id, "f.py", 999, 50, { cache });
    }
    cache = session.load(s_id);
    const entry = cache.files["f.py"]!;
    expect(entry.read_count).toBe(13);
    // Sentinel should be preserved
    expect(entry.line_ranges).toEqual([[0, 0]]);
  });
});

// ===========================================================================
// TestTimestampTracking
// ===========================================================================
describe("TestTimestampTracking", () => {
  it("test_last_activity_ts_updated", () => {
    const s_id = "s15";
    installMonotonicClock();
    const c1 = session.mark_file_read(s_id, "f.py");
    const t1 = c1.last_activity_ts;
    const c2 = session.mark_file_read(s_id, "g.py");
    const t2 = c2.last_activity_ts;
    expect(t2).toBeGreaterThan(t1);
  });

  it("test_file_entry_last_read_ts", () => {
    const s_id = "s16";
    installMonotonicClock();
    const c1 = session.mark_file_read(s_id, "f.py");
    const t1 = c1.files["f.py"]!.last_read_ts;
    const c2 = session.mark_file_read(s_id, "f.py");
    const t2 = c2.files["f.py"]!.last_read_ts;
    expect(t2).toBeGreaterThan(t1);
  });
});

// ===========================================================================
// TestGetFileEntry
// ===========================================================================
describe("TestGetFileEntry", () => {
  it("test_get_file_entry_found", () => {
    const s_id = "s17";
    session.mark_file_read(s_id, "f.py", 0, 100);
    const entry = session.get_file_entry(s_id, "f.py");
    expect(entry).not.toBeNull();
    expect(entry!.read_count).toBe(1);
  });

  it("test_get_file_entry_not_found", () => {
    const entry = session.get_file_entry("s_missing", "f.py");
    expect(entry).toBeNull();
  });

  it("test_get_file_entry_path_normalization", () => {
    const s_id = "s18";
    session.mark_file_read(s_id, "C:/foo.py");
    const entry = session.get_file_entry(s_id, "c:\\foo.py");
    expect(entry).not.toBeNull();
  });
});

// ===========================================================================
// TestSessionIdValidation
// ===========================================================================
describe("TestSessionIdValidation", () => {
  // ── load() ──────────────────────────────────────────────────────────────

  it("test_load_rejects_path_traversal", () => {
    expect(() => session.load("../../etc/passwd")).toThrow(/invalid characters/);
  });

  it("test_load_rejects_empty_id", () => {
    expect(() => session.load("")).toThrow(/cannot be empty/);
  });

  it("test_load_rejects_too_long_id", () => {
    expect(() => session.load("a".repeat(300))).toThrow(/too long/);
  });

  it("test_load_rejects_slash_in_id", () => {
    expect(() => session.load("session/evil")).toThrow(/invalid characters/);
  });

  it("test_load_rejects_backslash_in_id", () => {
    expect(() => session.load("session\\evil")).toThrow(/invalid characters/);
  });

  it("test_load_rejects_null_byte", () => {
    expect(() => session.load("abc\x00def")).toThrow(/invalid characters/);
  });

  it("test_load_accepts_valid_alphanum", () => {
    const cache = session.load("abc-123_XYZ");
    expect(cache.session_id).toBe("abc-123_XYZ");
  });

  // ── reset_session() ─────────────────────────────────────────────────────

  it("test_reset_session_rejects_path_traversal", () => {
    expect(() => session.reset_session("../../etc/passwd")).toThrow(/invalid characters/);
  });

  it("test_reset_session_rejects_empty_id", () => {
    expect(() => session.reset_session("")).toThrow(/cannot be empty/);
  });

  it("test_reset_session_accepts_valid_id", () => {
    // reset_session with a valid ID must not raise even if file doesn't exist.
    expect(() => session.reset_session("valid-session-id")).not.toThrow();
  });
});

// ===========================================================================
// TestSafeLoad
// ===========================================================================
describe("TestSafeLoad", () => {
  it("test_returns_none_for_invalid_id", () => {
    const result = session.safe_load("../../etc/passwd");
    expect(result).toBeNull();
  });

  it("test_returns_none_for_empty_id", () => {
    const result = session.safe_load("");
    expect(result).toBeNull();
  });

  it("test_returns_none_for_too_long_id", () => {
    const result = session.safe_load("a".repeat(300));
    expect(result).toBeNull();
  });

  it("test_returns_cache_for_valid_id", () => {
    const result = session.safe_load("valid-safe-load-id");
    expect(result).not.toBeNull();
    expect(result!.session_id).toBe("valid-safe-load-id");
  });

  it("test_caller_label_accepted", () => {
    const result = session.safe_load("valid-safe-load-id2", { caller: "test-caller" });
    expect(result).not.toBeNull();
  });

  it("test_returns_existing_cache", () => {
    const sid = "safe-load-existing";
    const cache = session.load(sid);
    session.mark_file_read(sid, "/some/file.py", null, null, { cache });
    session.save(cache);

    const result = session.safe_load(sid);
    expect(result).not.toBeNull();
    const hasKey =
      "/some/file.py" in result!.files ||
      Object.keys(result!.files).some((k) => k.includes("/some/file.py"));
    expect(hasKey).toBe(true);
  });
});

// ===========================================================================
// TestResultCache
// ===========================================================================
describe("TestResultCache", () => {
  it("test_put_then_get_returns_same_result", () => {
    const sid = "rc_session_1";
    const result = {
      file: "foo.py",
      symbol: "bar",
      text: "def bar(): pass",
      bytes_total: 100,
    };
    session.put_result_cache(sid, "foo.py", "bar", "symbol", "abc123sha", result);
    const got = session.get_result_cache(sid, "foo.py", "bar", "symbol", "abc123sha");
    expect(got).not.toBeNull();
    expect(got!["text"]).toBe("def bar(): pass");
    expect(got!["symbol"]).toBe("bar");
  });

  it("test_sha_mismatch_returns_none", () => {
    const sid = "rc_session_2";
    const result = { file: "foo.py", symbol: "bar", text: "old" };
    session.put_result_cache(sid, "foo.py", "bar", "symbol", "sha_old", result);
    // Same key, different SHA → miss
    expect(session.get_result_cache(sid, "foo.py", "bar", "symbol", "sha_new")).toBeNull();
    // And the stale entry should have been evicted from the cache
    const cache = session.load(sid);
    expect(
      Object.keys(cache.result_cache).every((k) => !k.includes("symbol") || !k.includes("bar")),
    ).toBe(true);
  });

  it("test_different_kinds_do_not_collide", () => {
    const sid = "rc_session_3";
    const sym_result = { text: "function body" };
    const sec_result = { text: "section body" };
    session.put_result_cache(sid, "f.md", "Intro", "symbol", "sha1", sym_result);
    session.put_result_cache(sid, "f.md", "Intro", "section", "sha1", sec_result);
    expect(session.get_result_cache(sid, "f.md", "Intro", "symbol", "sha1")!["text"]).toBe(
      "function body",
    );
    expect(session.get_result_cache(sid, "f.md", "Intro", "section", "sha1")!["text"]).toBe(
      "section body",
    );
  });

  it("test_capacity_evicts_oldest_fifo", () => {
    const sid = "rc_session_4";
    // Fill to cap + 5. (Python patched save to a no-op to batch; the real save
    // writes to the isolated tmp data dir here.)
    let cache: SessionCache | null = session.load(sid);
    for (let i = 0; i < session.RESULT_CACHE_MAX + 5; i++) {
      session.put_result_cache(sid, `f${i}.py`, "x", "symbol", "sha", { text: `r${i}` }, {
        cache,
      });
    }
    session.save(cache);
    cache = session.load(sid);
    // Should be at most RESULT_CACHE_MAX entries
    expect(Object.keys(cache.result_cache).length).toBeLessThanOrEqual(session.RESULT_CACHE_MAX);
    // The very first insertion (f0.py) must have been evicted
    expect(session.get_result_cache(sid, "f0.py", "x", "symbol", "sha")).toBeNull();
    // The newest insertion must still be there
    const last_idx = session.RESULT_CACHE_MAX + 4;
    const got = session.get_result_cache(sid, `f${last_idx}.py`, "x", "symbol", "sha");
    expect(got).not.toBeNull();
    expect(got!["text"]).toBe(`r${last_idx}`);
  });

  it("test_update_existing_key_does_not_evict", () => {
    const sid = "rc_session_5";
    // Fill exactly to cap.
    let cache: SessionCache | null = session.load(sid);
    for (let i = 0; i < session.RESULT_CACHE_MAX; i++) {
      session.put_result_cache(sid, `f${i}.py`, "x", "symbol", "sha", { text: `r${i}` }, {
        cache,
      });
    }
    session.save(cache);
    // Update an existing entry (should be a no-op for eviction)
    session.put_result_cache(sid, "f0.py", "x", "symbol", "sha", { text: "updated" });
    // f0 must still be present with updated text — it was not evicted
    const got = session.get_result_cache(sid, "f0.py", "x", "symbol", "sha");
    expect(got).not.toBeNull();
    expect(got!["text"]).toBe("updated");
  });

  it("test_cap_is_50", () => {
    expect(session.RESULT_CACHE_MAX).toBe(50);
  });

  it("test_eviction_retains_most_entries", () => {
    const sid = "rc_session_retain";
    // Trigger eviction exactly once by filling to cap + 1.
    let cache: SessionCache | null = session.load(sid);
    for (let i = 0; i < session.RESULT_CACHE_MAX + 1; i++) {
      session.put_result_cache(sid, `g${i}.py`, "y", "symbol", "sha", { text: `r${i}` }, {
        cache,
      });
    }
    session.save(cache);
    cache = session.load(sid);
    const min_retained = Math.trunc(session.RESULT_CACHE_MAX * 0.8);
    expect(Object.keys(cache.result_cache).length).toBeGreaterThanOrEqual(min_retained);
  });

  it("test_roundtrip_persists_across_loads", () => {
    const sid = "rc_session_6";
    session.put_result_cache(sid, "src/foo.py", "bar", "symbol", "sha9", { text: "T" });
    // Force a fresh load from disk
    const loaded = session.load(sid);
    expect(Object.keys(loaded.result_cache).some((k) => k.includes("bar"))).toBe(true);
    const got = session.get_result_cache(sid, "src/foo.py", "bar", "symbol", "sha9");
    expect(got).not.toBeNull();
    expect(got!["text"]).toBe("T");
  });

  it("test_invalid_session_id_is_a_noop", () => {
    // Empty session ID should be silently ignored — never crash the read path
    session.put_result_cache("", "f.py", "x", "symbol", "sha", { text: "z" });
    expect(session.get_result_cache("", "f.py", "x", "symbol", "sha")).toBeNull();
  });

  it("test_unknown_kind_rejected", () => {
    const sid = "rc_session_7";
    session.put_result_cache(sid, "f.py", "x", "weird", "sha", { text: "z" });
    const cache = session.load(sid);
    expect(cache.result_cache).toEqual({});
  });

  it("test_get_returns_copy_not_reference", () => {
    const sid = "rc_session_8";
    session.put_result_cache(sid, "f.py", "x", "symbol", "sha", { text: "original" });
    const got = session.get_result_cache(sid, "f.py", "x", "symbol", "sha");
    expect(got).not.toBeNull();
    got!["text"] = "MUTATED";
    // Second fetch must still see the original
    const again = session.get_result_cache(sid, "f.py", "x", "symbol", "sha");
    expect(again).not.toBeNull();
    expect(again!["text"]).toBe("original");
  });

  it("test_last_activity_ts_updated_by_put_result_cache", () => {
    const before = Date.now() / 1000 - 1;
    session.put_result_cache("rc_ts_put", "f.py", "myfunc", "symbol", "sha_abc", {
      text: "body",
    });
    const cache = session.load("rc_ts_put");
    expect(cache.last_activity_ts).toBeGreaterThan(before);
  });

  it("test_last_activity_ts_updated_on_stale_sha_eviction", () => {
    const sid = "rc_ts_stale";
    session.put_result_cache(sid, "f.py", "fn", "symbol", "sha_old", { text: "old" });
    const before = Date.now() / 1000 - 1;
    const result = session.get_result_cache(sid, "f.py", "fn", "symbol", "sha_new");
    expect(result).toBeNull(); // SHA mismatch → evicted
    const cache = session.load(sid);
    expect(cache.last_activity_ts).toBeGreaterThan(before);
  });
});

// ===========================================================================
// TestSessionCreatedTs
// ===========================================================================
describe("TestSessionCreatedTs", () => {
  it("test_created_ts_defaults_to_now_on_load", () => {
    const before = Date.now() / 1000;
    const cache = session.load("test_created_ts_1");
    const after = Date.now() / 1000;
    expect(cache.created_ts).toBeGreaterThanOrEqual(before);
    expect(cache.created_ts).toBeLessThanOrEqual(after);
  });

  it("test_created_ts_persists_roundtrip", () => {
    const sid = "test_created_ts_2";
    const cache = session.load(sid);
    const original_ts = cache.created_ts;
    // Mark some activity to trigger a save
    session.mark_file_read(sid, "file.py");
    const reloaded = session.load(sid);
    // created_ts should be identical (preserved from serialization)
    expect(Math.abs(reloaded.created_ts - original_ts)).toBeLessThan(0.01);
  });

  it("test_created_ts_backward_compatible_missing", () => {
    const legacy_dict = {
      schema_version: 1,
      created_by: "token-goat",
      session_id: "legacy_session",
      started_ts: Date.now() / 1000,
      last_activity_ts: Date.now() / 1000,
      files: {},
      greps: [],
      edited_files: {},
      result_cache: {},
      bash_history: {},
      web_history: {},
      snapshot_shas: {},
      hints_seen: [],
    };
    const before = Date.now() / 1000;
    const cache = SessionCache.from_dict(legacy_dict);
    const after = Date.now() / 1000;
    expect(cache.created_ts).toBeGreaterThanOrEqual(before);
    expect(cache.created_ts).toBeLessThanOrEqual(after);
  });

  it("test_cwd_persists_roundtrip", () => {
    const sid = "test_cwd_roundtrip";
    const cache = session.load(sid);
    cache.cwd = "/some/project/root";
    session.save(cache);
    const reloaded = session.load(sid);
    expect(reloaded.cwd).toBe("/some/project/root");
  });

  it("test_cwd_none_persists_roundtrip", () => {
    const sid = "test_cwd_none_roundtrip";
    const cache = session.load(sid);
    expect(cache.cwd).toBeNull();
    session.save(cache);
    const reloaded = session.load(sid);
    expect(reloaded.cwd).toBeNull();
  });

  it("test_cwd_absent_from_legacy_dict", () => {
    const d = {
      schema_version: 1,
      created_by: "token-goat",
      session_id: "legacy_cwd_missing",
      started_ts: Date.now() / 1000,
      last_activity_ts: Date.now() / 1000,
      files: {},
      greps: [],
      edited_files: {},
      result_cache: {},
      bash_history: {},
      web_history: {},
      snapshot_shas: {},
      hints_seen: [],
    };
    const cache = SessionCache.from_dict(d);
    expect(cache.cwd).toBeNull();
  });
});

// ===========================================================================
// TestCwdMerge
// ===========================================================================
describe("TestCwdMerge", () => {
  it("test_cwd_local_wins_when_both_set", () => {
    const local = new SessionCache({ session_id: "cwd-merge-1", started_ts: 0, last_activity_ts: 0 });
    const remote = new SessionCache({ session_id: "cwd-merge-1", started_ts: 0, last_activity_ts: 0 });
    local.cwd = "/new/path";
    remote.cwd = "/old/path";

    const merged = _merge_session_caches(local, remote);
    expect(merged.cwd).toBe("/new/path");
  });

  it("test_cwd_none_local_preserves_remote", () => {
    const local = new SessionCache({ session_id: "cwd-merge-2", started_ts: 0, last_activity_ts: 0 });
    const remote = new SessionCache({ session_id: "cwd-merge-2", started_ts: 0, last_activity_ts: 0 });
    local.cwd = null;
    remote.cwd = "/project";

    const merged = _merge_session_caches(local, remote);
    expect(merged.cwd).toBe("/project");
  });

  it("test_cwd_both_none_stays_none", () => {
    const local = new SessionCache({ session_id: "cwd-merge-3", started_ts: 0, last_activity_ts: 0 });
    const remote = new SessionCache({ session_id: "cwd-merge-3", started_ts: 0, last_activity_ts: 0 });

    const merged = _merge_session_caches(local, remote);
    expect(merged.cwd).toBeNull();
  });
});

// ===========================================================================
// TestGrepHistoryCap
// ===========================================================================
describe("TestGrepHistoryCap", () => {
  it("test_greps_capped_at_max", () => {
    const sid = "greps_cap_1";
    let cache: SessionCache | null = session.load(sid);
    for (let i = 0; i < session.GREPS_HISTORY_MAX + 5; i++) {
      cache = session.mark_grep(sid, `pattern_${i}`, "/proj/src", null, { cache });
    }
    session.save(cache);
    cache = session.load(sid);
    expect(cache.greps.length).toBeLessThanOrEqual(session.GREPS_HISTORY_MAX);
  });

  it("test_greps_cap_evicts_oldest", () => {
    const sid = "greps_cap_2";
    const n = session.GREPS_HISTORY_MAX + 3;
    let cache: SessionCache | null = session.load(sid);
    for (let i = 0; i < n; i++) {
      cache = session.mark_grep(sid, `pattern_${i}`, "/proj/src", null, { cache });
    }
    session.save(cache);
    cache = session.load(sid);
    const patterns = cache.greps.map((g) => g.pattern);
    // The first (oldest) patterns must be gone
    expect(patterns).not.toContain("pattern_0");
    expect(patterns).not.toContain("pattern_1");
    expect(patterns).not.toContain("pattern_2");
    // The most recent must survive
    expect(patterns).toContain(`pattern_${n - 1}`);
  });

  it("test_greps_exactly_at_cap_not_evicted", () => {
    const sid = "greps_cap_3";
    let cache: SessionCache | null = session.load(sid);
    for (let i = 0; i < session.GREPS_HISTORY_MAX; i++) {
      cache = session.mark_grep(sid, `pat_${i}`, "/proj/src", null, { cache });
    }
    session.save(cache);
    cache = session.load(sid);
    expect(cache.greps.length).toBe(session.GREPS_HISTORY_MAX);
  });
});

// ===========================================================================
// TestHintsSeenCap
// ===========================================================================
describe("TestHintsSeenCap", () => {
  it("test_hints_seen_capped_via_mark", () => {
    const sid = "hints_cap_1";
    const cache = session.load(sid);
    // Build hints_seen with a high-count fingerprint before reaching the cap.
    for (let i = 0; i < 100; i++) {
      cache.mark_hint_seen("fp_overflow");
    }
    // Now fill the rest up to the cap with single-count entries.
    for (let i = 0; i < session.HINTS_SEEN_MAX - 1; i++) {
      cache.mark_hint_seen(`fp_${i}`);
    }
    // len(hints_seen) == HINTS_SEEN_MAX and fp_overflow has count 100.
    expect(Object.keys(cache.hints_seen).length).toBe(session.HINTS_SEEN_MAX);
    // Add one more entry to trigger LRU eviction.
    cache.mark_hint_seen("fp_trigger");
    // After LRU, the cap is respected.
    expect(Object.keys(cache.hints_seen).length).toBeLessThanOrEqual(session.HINTS_SEEN_MAX);
    // The high-count fingerprint (fp_overflow with count 100) should survive LRU.
    expect("fp_overflow" in cache.hints_seen).toBe(true);
    expect(cache.hints_seen["fp_overflow"]).toBe(100);
  });

  it("test_hints_seen_cleared_after_cap_roundtrip", () => {
    const sid = "hints_cap_2";
    const cache = session.load(sid);
    // Overflow via mark_hint_seen
    for (let i = 0; i < session.HINTS_SEEN_MAX + 1; i++) {
      cache.mark_hint_seen(`fp_${i}`);
    }
    session.save(cache);
    const reloaded = session.load(sid);
    expect(Object.keys(reloaded.hints_seen).length).toBeLessThanOrEqual(session.HINTS_SEEN_MAX);
  });

  it("test_hints_seen_below_cap_preserved", () => {
    const sid = "hints_cap_3";
    const cache = session.load(sid);
    // Put a handful of entries well below the cap
    for (let i = 0; i < 10; i++) {
      cache.mark_hint_seen(`fp_${i}`);
    }
    session.save(cache);
    const reloaded = session.load(sid);
    expect(Object.keys(reloaded.hints_seen).length).toBe(10);
  });
});

// ===========================================================================
// TestHintFingerprintIncludesPath
// ===========================================================================
describe("TestHintFingerprintIncludesPath", () => {
  // PORT: deferred — imports token_goat.hints._hint_fingerprint; the hints
  // module is not yet ported to TS (src/token_goat/hints.ts does not exist).
  it.skip("test_same_text_different_paths_both_fire", () => {});
  // PORT: deferred — hints module not yet ported.
  it.skip("test_same_text_same_path_deduped", () => {});
  // PORT: deferred — hints module not yet ported.
  it.skip("test_session_dedup_respects_path", () => {});
  // PORT: deferred — hints module not yet ported.
  it.skip("test_no_path_fallback_still_works", () => {});
});

// ===========================================================================
// TestBashDedupEmittedIds
// ===========================================================================
describe("TestBashDedupEmittedIds", () => {
  it("test_roundtrip_preserves_ids", () => {
    const sid = "bash_dedup_rt_1";
    const cache = session.load(sid);
    cache.bash_dedup_emitted_ids.add("abc123");
    cache.bash_dedup_emitted_ids.add("def456");
    cache._invalidate_json_cache();
    session.save(cache);
    const reloaded = session.load(sid);
    expect(reloaded.bash_dedup_emitted_ids).toEqual(new Set(["abc123", "def456"]));
  });

  it("test_missing_field_migrates_to_empty_set", () => {
    const sid = "bash_dedup_migrate_1";
    const cache = session.load(sid);
    // Save a cache that has the field, then manually strip it from JSON to
    // simulate an old session file written before this field existed.
    const raw = JSON.parse(cache.to_json()) as Record<string, unknown>;
    delete raw["bash_dedup_emitted_ids"];
    const p = paths.sessionCachePath(sid);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, JSON.stringify(raw), "utf8");
    const reloaded = session.load(sid);
    expect(reloaded.bash_dedup_emitted_ids).toEqual(new Set());
  });

  it("test_serialized_as_sorted_list", () => {
    const sid = "bash_dedup_serial_1";
    const cache = session.load(sid);
    cache.bash_dedup_emitted_ids = new Set(["zzz", "aaa", "mmm"]);
    cache._invalidate_json_cache();
    const raw = JSON.parse(cache.to_json()) as Record<string, unknown>;
    expect(raw["bash_dedup_emitted_ids"]).toEqual(["aaa", "mmm", "zzz"]);
  });
});
