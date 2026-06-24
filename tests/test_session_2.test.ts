/**
 * Unit tests for token_goat/session — part 2/4. 1:1 port of the
 * TestFilesMaxEviction…TestSessionSchemaMigration block of
 * tests/test_session.py (source lines ~1176-2447).
 *
 * Test-seam mapping (Python → TS):
 *  - tmp_data_dir fixture         → tests/setup.ts beforeEach isolates the data
 *    dir per test, so we just call the session helpers (no per-test wiring here).
 *  - with patch.object(session, "save"): … — a pure PERF optimization in the
 *    Python source (avoid N×save while batch-filling a history). ESM cannot
 *    intercept session.ts's INTERNAL `save` binding (the mark_* helpers call the
 *    module-local `save`, not the namespace export), and the optimization is not
 *    behavior-load-bearing, so these ported tests run the real per-iteration
 *    saves; the end-state assertions are identical. The trailing explicit
 *    session.save(cache) (Python's post-loop flush) is kept and is idempotent.
 *    This mirrors the seam decision already made in test_session_3.test.ts.
 *  - monkeypatch.setattr(db, "record_stat", …) → vi.spyOn(db, "recordStat").
 *    session calls db.recordStat via createRequire("./db.js"); vitest dedups the
 *    module instance so the spy intercepts. The call-count assertions mirror
 *    Python's `calls` list length.
 *  - bash_cache.command_hash             → ported; the bash-FIFO eviction test
 *    seeds via it (parallel to web_cache.url_hash, also ported).
 *  - mark_file_read(sid, p, offset=, limit=, symbol=, cache=) → the TS overload
 *    is mark_file_read(sid, p, offset|null, limit|null, { symbol?, cache?, ... }).
 *
 * Every Python `def test_*` maps to one vitest `it()` with the same name and
 * assertion polarity.
 */
import fs from "node:fs";
import nodePath from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import * as session from "../src/token_goat/session.js";
import * as db from "../src/token_goat/db.js";
import * as bash_cache from "../src/token_goat/bash_cache.js";
import * as web_cache from "../src/token_goat/web_cache.js";
import { FileEntry, GrepEntry, GlobEntry, WebEntry, BashEntry } from "../src/token_goat/session.js";

afterEach(() => {
  vi.restoreAllMocks();
});

// ===========================================================================
// TestFilesMaxEviction
// ===========================================================================
describe("TestFilesMaxEviction", () => {
  it("test_files_evicted_when_cap_exceeded", () => {
    const sid = "files_cap_1";
    const overshoot = 10;
    let cache: session.SessionCache | null = null;
    for (let i = 0; i < session.FILES_MAX + overshoot; i++) {
      cache = session.mark_file_read(sid, `/abs/path/file_${i}.py`, null, null, { cache });
    }
    expect(Object.keys(cache!.files).length).toBeLessThanOrEqual(session.FILES_MAX);
  });

  it("test_newest_files_survive_eviction", () => {
    const sid = "files_cap_2";
    const total = session.FILES_MAX + 20;
    let cache: session.SessionCache | null = null;
    for (let i = 0; i < total; i++) {
      cache = session.mark_file_read(sid, `/abs/path/file_${i}.py`, null, null, { cache });
    }
    const lastKey = `/abs/path/file_${total - 1}.py`;
    expect(lastKey in cache!.files).toBe(true);
  });

  it("test_files_exactly_at_cap_not_evicted", () => {
    const sid = "files_cap_3";
    let cache: session.SessionCache | null = null;
    for (let i = 0; i < session.FILES_MAX; i++) {
      cache = session.mark_file_read(sid, `/abs/path/f_${i}.py`, null, null, { cache });
    }
    expect(Object.keys(cache!.files).length).toBe(session.FILES_MAX);
  });
});

// ===========================================================================
// TestEditedFilesMaxEviction
// ===========================================================================
describe("TestEditedFilesMaxEviction", () => {
  it("test_edited_files_evicted_when_cap_exceeded", () => {
    const sid = "edited_cap_1";
    const overshoot = 10;
    let cache: session.SessionCache | null = null;
    for (let i = 0; i < session.EDITED_FILES_MAX + overshoot; i++) {
      cache = session.mark_file_edited(sid, `/abs/path/edit_${i}.py`, { cache });
    }
    expect(Object.keys(cache!.edited_files).length).toBeLessThanOrEqual(
      session.EDITED_FILES_MAX,
    );
  });

  it("test_newest_edited_files_survive_eviction", () => {
    const sid = "edited_cap_2";
    const total = session.EDITED_FILES_MAX + 20;
    let cache: session.SessionCache | null = null;
    for (let i = 0; i < total; i++) {
      cache = session.mark_file_edited(sid, `/abs/path/edit_${i}.py`, { cache });
    }
    const lastKey = `/abs/path/edit_${total - 1}.py`;
    expect(lastKey in cache!.edited_files).toBe(true);
  });

  it("test_edited_files_exactly_at_cap_not_evicted", () => {
    const sid = "edited_cap_3";
    let cache: session.SessionCache | null = null;
    for (let i = 0; i < session.EDITED_FILES_MAX; i++) {
      cache = session.mark_file_edited(sid, `/abs/path/e_${i}.py`, { cache });
    }
    expect(Object.keys(cache!.edited_files).length).toBe(session.EDITED_FILES_MAX);
  });

  it("test_repeated_edit_of_same_file_does_not_evict", () => {
    const sid = "edited_cap_4";
    let cache: session.SessionCache | null = null;
    for (let i = 0; i < session.EDITED_FILES_MAX; i++) {
      cache = session.mark_file_edited(sid, `/abs/path/e_${i}.py`, { cache });
    }
    for (let i = 0; i < 20; i++) {
      cache = session.mark_file_edited(sid, "/abs/path/e_0.py", { cache });
    }
    expect(Object.keys(cache!.edited_files).length).toBe(session.EDITED_FILES_MAX);
    expect(cache!.edited_files["/abs/path/e_0.py"] ?? 0).toBeGreaterThan(1);
  });
});

// ===========================================================================
// TestSnapshotShasMaxEviction
// ===========================================================================
describe("TestSnapshotShasMaxEviction", () => {
  it("test_snapshot_shas_evicted_when_cap_exceeded", () => {
    const sid = "snap_cap_1";
    const overshoot = 5;
    let cache: session.SessionCache | null = null;
    for (let i = 0; i < session.SNAPSHOT_SHAS_MAX + overshoot; i++) {
      cache = session.set_snapshot_sha(sid, `/abs/path/snap_${i}.py`, `sha_${i}`, { cache });
    }
    expect(Object.keys(cache!.snapshot_shas).length).toBeLessThanOrEqual(
      session.SNAPSHOT_SHAS_MAX,
    );
  });

  it("test_newest_snapshots_survive_eviction", () => {
    const sid = "snap_cap_2";
    const total = session.SNAPSHOT_SHAS_MAX + 10;
    let cache: session.SessionCache | null = null;
    for (let i = 0; i < total; i++) {
      cache = session.set_snapshot_sha(sid, `/abs/path/snap_${i}.py`, `sha_${i}`, { cache });
    }
    const lastKey = `/abs/path/snap_${total - 1}.py`;
    expect(lastKey in cache!.snapshot_shas).toBe(true);
  });

  it("test_snapshot_shas_exactly_at_cap_not_evicted", () => {
    const sid = "snap_cap_3";
    let cache: session.SessionCache | null = null;
    for (let i = 0; i < session.SNAPSHOT_SHAS_MAX; i++) {
      cache = session.set_snapshot_sha(sid, `/abs/path/s_${i}.py`, `sha_${i}`, { cache });
    }
    expect(Object.keys(cache!.snapshot_shas).length).toBe(session.SNAPSHOT_SHAS_MAX);
  });

  it("test_last_activity_ts_updated_by_set_snapshot_sha", () => {
    const before = Date.now() / 1000 - 1;
    const cache = session.set_snapshot_sha("snap_ts_1", "/proj/foo.py", "deadbeef");
    expect(cache.last_activity_ts).toBeGreaterThan(before);
  });
});

// ===========================================================================
// TestWebHistoryMaxEviction
// ===========================================================================
describe("TestWebHistoryMaxEviction", () => {
  it("test_web_history_evicted_when_cap_exceeded", () => {
    const sid = "web_cap_1";
    const overshoot = 5;
    let cache: session.SessionCache | null = null;
    for (let i = 0; i < session.WEB_HISTORY_MAX + overshoot; i++) {
      cache = session.mark_web_fetch(
        sid,
        `sha_${i}`,
        `https://example.com/page_${i}`,
        `out_${i}`,
        1000,
        200,
        false,
        { cache },
      );
    }
    expect(Object.keys(cache!.web_history).length).toBeLessThanOrEqual(
      session.WEB_HISTORY_MAX,
    );
  });

  it("test_newest_web_entries_survive_eviction", () => {
    const sid = "web_cap_2";
    const total = session.WEB_HISTORY_MAX + 10;
    let cache: session.SessionCache | null = null;
    for (let i = 0; i < total; i++) {
      cache = session.mark_web_fetch(
        sid,
        `sha_${i}`,
        `https://example.com/page_${i}`,
        `out_${i}`,
        1000,
        200,
        false,
        { cache },
      );
    }
    const lastKey = `sha_${total - 1}`;
    expect(lastKey in cache!.web_history).toBe(true);
  });

  it("test_web_history_exactly_at_cap_not_evicted", () => {
    const sid = "web_cap_3";
    let cache: session.SessionCache | null = null;
    for (let i = 0; i < session.WEB_HISTORY_MAX; i++) {
      cache = session.mark_web_fetch(
        sid,
        `sha_${i}`,
        `https://example.com/page_${i}`,
        `out_${i}`,
        1000,
        200,
        false,
        { cache },
      );
    }
    expect(Object.keys(cache!.web_history).length).toBe(session.WEB_HISTORY_MAX);
  });

  it("test_duplicate_url_sha_does_not_trigger_eviction", () => {
    const sid = "web_cap_4";
    let cache: session.SessionCache | null = null;
    for (let i = 0; i < session.WEB_HISTORY_MAX; i++) {
      cache = session.mark_web_fetch(
        sid,
        `sha_${i}`,
        `https://example.com/page_${i}`,
        `out_${i}`,
        1000,
        200,
        false,
        { cache },
      );
    }
    cache = session.mark_web_fetch(
      sid,
      "sha_0",
      "https://example.com/page_0?v=2",
      "out_0_retry",
      1000,
      200,
      false,
      { cache },
    );
    expect(Object.keys(cache!.web_history).length).toBe(session.WEB_HISTORY_MAX);
    expect(cache!.web_history["sha_0"]!.output_id).toBe("out_0_retry");
  });
});

// ===========================================================================
// TestContentionDiskDedup
// ===========================================================================
describe("TestContentionDiskDedup", () => {
  it("test_first_call_records_stat_and_creates_mark", () => {
    const spy = vi.spyOn(db, "recordStat").mockImplementation(() => undefined);

    const exc = new Error("simulated contention");
    session._record_cache_contention("sess_first", "load", exc);

    expect(spy.mock.calls.length).toBe(1);
    const mark = session._contention_mark_path("sess_first", "load");
    expect(fs.existsSync(mark)).toBe(true);
  });

  it("test_second_call_deduped_by_touch_file", () => {
    const spy = vi.spyOn(db, "recordStat").mockImplementation(() => undefined);

    const exc = new Error("contention again");
    session._record_cache_contention("sess_dedup", "save", exc);
    expect(spy.mock.calls.length).toBe(1);

    session._record_cache_contention("sess_dedup", "save", exc);
    expect(spy.mock.calls.length).toBe(1);
  });

  it("test_different_phases_each_get_own_mark", () => {
    const spy = vi.spyOn(db, "recordStat").mockImplementation(() => undefined);

    const exc = new Error("contention");
    session._record_cache_contention("sess_phases", "load", exc);
    session._record_cache_contention("sess_phases", "save", exc);

    expect(spy.mock.calls.length).toBe(2);
    expect(fs.existsSync(session._contention_mark_path("sess_phases", "load"))).toBe(true);
    expect(fs.existsSync(session._contention_mark_path("sess_phases", "save"))).toBe(true);
  });

  it("test_mark_file_race_fileexists_handled", () => {
    const spy = vi.spyOn(db, "recordStat").mockImplementation(() => undefined);

    // Pre-create the mark file to simulate another process already wrote it.
    const mark = session._contention_mark_path("sess_race", "load");
    fs.mkdirSync(nodePath.dirname(mark), { recursive: true });
    fs.writeFileSync(mark, "");

    const exc = new Error("contention");
    session._record_cache_contention("sess_race", "load", exc);

    expect(spy.mock.calls.length).toBe(0);
  });
});

// ===========================================================================
// TestCompactSerialization
// ===========================================================================
describe("TestCompactSerialization", () => {
  it("test_file_entry_empty_symbols_omitted", () => {
    const entry = new FileEntry({
      rel_or_abs: "src/foo.py",
      last_read_ts: 1_700_000_000.0,
      read_count: 1,
      line_ranges: [[1, 50]],
      symbols_read: [],
    });
    const d = session._serialize_file_entry(entry);
    expect("symbols_read" in d).toBe(false);
  });

  it("test_file_entry_empty_line_ranges_omitted", () => {
    const entry = new FileEntry({
      rel_or_abs: "src/foo.py",
      last_read_ts: 1_700_000_000.0,
      read_count: 1,
      line_ranges: [],
      symbols_read: ["MyClass"],
    });
    const d = session._serialize_file_entry(entry);
    expect("line_ranges" in d).toBe(false);
  });

  it("test_file_entry_both_empty_omitted", () => {
    const entry = new FileEntry({
      rel_or_abs: "src/foo.py",
      last_read_ts: 1_700_000_000.0,
      read_count: 1,
      line_ranges: [],
      symbols_read: [],
    });
    const d = session._serialize_file_entry(entry);
    expect("symbols_read" in d).toBe(false);
    expect("line_ranges" in d).toBe(false);
  });

  it("test_file_entry_nonempty_fields_present", () => {
    const entry = new FileEntry({
      rel_or_abs: "src/foo.py",
      last_read_ts: 1_700_000_000.0,
      read_count: 2,
      line_ranges: [[1, 10], [20, 30]],
      symbols_read: ["func_a", "func_b"],
    });
    const d = session._serialize_file_entry(entry);
    expect(d["symbols_read"]).toEqual(["func_a", "func_b"]);
    expect(d["line_ranges"]).toEqual([[1, 10], [20, 30]]);
  });

  it("test_file_entry_default_last_edit_ts_omitted", () => {
    const entry = new FileEntry({
      rel_or_abs: "src/foo.py",
      last_read_ts: 1_700_000_000.0,
      read_count: 1,
      line_ranges: [],
      symbols_read: [],
      last_edit_ts: 0.0,
    });
    const d = session._serialize_file_entry(entry);
    expect("last_edit_ts" in d).toBe(false);
  });

  it("test_file_entry_nonzero_last_edit_ts_present", () => {
    const entry = new FileEntry({
      rel_or_abs: "src/foo.py",
      last_read_ts: 1_700_000_000.0,
      read_count: 1,
      line_ranges: [],
      symbols_read: [],
      last_edit_ts: 1_700_000_100.5,
    });
    const d = session._serialize_file_entry(entry);
    expect("last_edit_ts" in d).toBe(true);
  });

  it("test_roundtrip_missing_symbols_read_defaults_to_empty", () => {
    const raw = {
      rel_or_abs: "src/bar.py",
      last_read_ts: 1_700_000_000.0,
      read_count: 1,
    };
    const entry = session._parse_file_entry("src/bar.py", raw, 1_700_000_000.0);
    expect(entry).not.toBeNull();
    expect(entry!.symbols_read).toEqual([]);
  });

  it("test_roundtrip_missing_line_ranges_defaults_to_empty", () => {
    const raw = {
      rel_or_abs: "src/bar.py",
      last_read_ts: 1_700_000_000.0,
      read_count: 1,
    };
    const entry = session._parse_file_entry("src/bar.py", raw, 1_700_000_000.0);
    expect(entry).not.toBeNull();
    expect(entry!.line_ranges).toEqual([]);
  });

  it("test_roundtrip_full_cycle_file_entry", () => {
    const sid = "roundtrip_compact_1";
    const cache = session.mark_file_read(sid, "src/mod.py", 0, 100);
    const entryBefore = cache.files["src/mod.py"]!;
    expect(entryBefore.symbols_read).toEqual([]);

    const loaded = session.load(sid);
    const entryAfter = loaded.files["src/mod.py"]!;
    expect(entryAfter.symbols_read).toEqual([]);
    expect(entryAfter.line_ranges).toEqual(entryBefore.line_ranges);
    expect(entryAfter.read_count).toBe(entryBefore.read_count);
  });

  it("test_file_entry_ts_rounded_to_3dp", () => {
    const ts = 1_747_854_321.4839182;
    const entry = new FileEntry({
      rel_or_abs: "src/foo.py",
      last_read_ts: ts,
      read_count: 1,
      line_ranges: [],
      symbols_read: [],
    });
    const d = session._serialize_file_entry(entry);
    const serialized = d["last_read_ts"];
    expect(serialized).toBe(session._round_ts(ts));
    expect(serialized).not.toBe(ts);
  });

  it("test_session_top_level_ts_rounded", () => {
    const sid = "ts_round_top_1";
    const cache = session.load(sid);
    cache.started_ts = 1_747_854_321.4839182;
    cache.last_activity_ts = 1_747_854_400.9991234;
    cache.created_ts = 1_747_854_200.1234567;
    const d = cache.to_dict();
    expect(d["started_ts"]).toBe(session._round_ts(1_747_854_321.4839182));
    expect(d["last_activity_ts"]).toBe(session._round_ts(1_747_854_400.9991234));
    expect(d["created_ts"]).toBe(session._round_ts(1_747_854_200.1234567));
  });

  it("test_grep_ts_rounded", () => {
    const entry = new GrepEntry({ pattern: "foo", path: null, ts: 1_747_000_000.9876543 });
    const d = session._serialize_grep_entry(entry);
    expect(d["ts"]).toBe(session._round_ts(1_747_000_000.9876543));
  });

  it("test_bash_ts_rounded", () => {
    const entry = new BashEntry({
      cmd_sha: "abc123",
      cmd_preview: "pytest",
      output_id: "out_1",
      ts: 1_747_000_000.1234567,
      stdout_bytes: 500,
      stderr_bytes: 0,
    });
    const d = session._serialize_bash_entry(entry);
    expect(d["ts"]).toBe(session._round_ts(1_747_000_000.1234567));
  });

  it("test_web_ts_rounded", () => {
    const entry = new WebEntry({
      url_sha: "sha_abc",
      url_preview: "https://example.com",
      output_id: "out_web",
      ts: 1_747_000_000.5551234,
      body_bytes: 2048,
    });
    const d = session._serialize_web_entry(entry);
    expect(d["ts"]).toBe(session._round_ts(1_747_000_000.5551234));
  });

  it("test_bash_entry_omits_default_fields", () => {
    const entry = new BashEntry({
      cmd_sha: "abc123",
      cmd_preview: "ls",
      output_id: "out_1",
      ts: 1_747_000_000.0,
      stdout_bytes: 100,
      stderr_bytes: 0,
    });
    const d = session._serialize_bash_entry(entry);
    expect("cmd_sha" in d).toBe(true);
    expect("ts" in d).toBe(true);
    expect("exit_code" in d).toBe(false);
    expect("truncated" in d).toBe(false);
    expect("run_count" in d).toBe(false);
    expect("output_sha" in d).toBe(false);
  });

  it("test_bash_entry_includes_non_default_fields", () => {
    const entry = new BashEntry({
      cmd_sha: "def456",
      cmd_preview: "pytest -x",
      output_id: "out_2",
      ts: 1_747_000_000.0,
      stdout_bytes: 4096,
      stderr_bytes: 512,
      exit_code: 1,
      truncated: true,
      run_count: 3,
      output_sha: "deadbeef01234567",
    });
    const d = session._serialize_bash_entry(entry);
    expect(d["exit_code"]).toBe(1);
    expect(d["truncated"]).toBe(true);
    expect(d["run_count"]).toBe(3);
    expect(d["output_sha"]).toBe("deadbeef01234567");
  });

  it("test_bash_entry_roundtrip_with_defaults", () => {
    const entry = new BashEntry({
      cmd_sha: "aaa000",
      cmd_preview: "echo hi",
      output_id: "out_rt",
      ts: 1_747_000_000.0,
      stdout_bytes: 10,
      stderr_bytes: 0,
    });
    const d = session._serialize_bash_entry(entry);
    const parsed = session._parse_bash_entry(d);
    expect(parsed).not.toBeNull();
    expect(parsed!.exit_code).toBeNull();
    expect(parsed!.truncated).toBe(false);
    expect(parsed!.run_count).toBe(1);
    expect(parsed!.output_sha).toBe("");
  });

  it("test_web_entry_omits_default_fields", () => {
    const entry = new WebEntry({
      url_sha: "abc_sha",
      url_preview: "https://example.com",
      output_id: "web_out",
      ts: 1_747_000_000.0,
      body_bytes: 1024,
    });
    const d = session._serialize_web_entry(entry);
    expect("status_code" in d).toBe(false);
    expect("truncated" in d).toBe(false);
  });

  it("test_web_entry_includes_non_default_fields", () => {
    const entry = new WebEntry({
      url_sha: "abc_sha",
      url_preview: "https://example.com",
      output_id: "web_out",
      ts: 1_747_000_000.0,
      body_bytes: 1024,
      status_code: 200,
      truncated: true,
    });
    const d = session._serialize_web_entry(entry);
    expect(d["status_code"]).toBe(200);
    expect(d["truncated"]).toBe(true);
  });

  it("test_web_entry_roundtrip_with_defaults", () => {
    const entry = new WebEntry({
      url_sha: "rt_sha",
      url_preview: "https://rt.example.com",
      output_id: "web_rt",
      ts: 1_747_000_000.0,
      body_bytes: 512,
    });
    const d = session._serialize_web_entry(entry);
    const parsed = session._parse_web_entry(d);
    expect(parsed).not.toBeNull();
    expect(parsed!.status_code).toBeNull();
    expect(parsed!.truncated).toBe(false);
  });

  it("test_timestamp_roundtrip_within_millisecond", () => {
    const sid = "ts_roundtrip_1";
    const tsBefore = Date.now() / 1000;
    session.mark_file_read(sid, "src/z.py", 0, 10);
    const loaded = session.load(sid);
    const entry = loaded.files["src/z.py"]!;
    expect(Math.abs(entry.last_read_ts - tsBefore)).toBeLessThan(1.0);
    const serialized = session._round_ts(entry.last_read_ts);
    expect(entry.last_read_ts).toBe(serialized);
  });
});

// ===========================================================================
// TestGlob
// ===========================================================================
describe("TestGlob", () => {
  it("test_mark_glob_run_appends_and_persists", () => {
    const cache = session.mark_glob_run("glob_s1", "**/*.py", "src/", 42);
    expect(cache.glob_history.length).toBe(1);
    const entry = cache.glob_history[0]!;
    expect(entry.pattern).toBe("**/*.py");
    expect(entry.path).toBe("src/");
    expect(entry.result_count).toBe(42);

    const loaded = session.load("glob_s1");
    expect(loaded.glob_history.length).toBe(1);
    expect(loaded.glob_history[0]!.pattern).toBe("**/*.py");
    expect(loaded.glob_history[0]!.result_count).toBe(42);
  });

  it("test_mark_glob_run_no_result_count", () => {
    const cache = session.mark_glob_run("glob_s2", "**/*.ts");
    expect(cache.glob_history[0]!.result_count).toBeNull();

    const loaded = session.load("glob_s2");
    expect(loaded.glob_history[0]!.result_count).toBeNull();
  });

  it("test_multiple_globs", () => {
    session.mark_glob_run("glob_s3", "**/*.py", null, 10);
    session.mark_glob_run("glob_s3", "**/*.ts", null, 5);
    const cache = session.load("glob_s3");
    expect(cache.glob_history.length).toBe(2);
    expect(cache.glob_history[0]!.pattern).toBe("**/*.py");
    expect(cache.glob_history[1]!.pattern).toBe("**/*.ts");
  });

  it("test_lookup_glob_entry_found", () => {
    session.mark_glob_run("glob_s4", "**/*.py", null, 7);
    const entry = session.lookup_glob_entry("glob_s4", "**/*.py", null);
    expect(entry).not.toBeNull();
    expect(entry!.pattern).toBe("**/*.py");
    expect(entry!.result_count).toBe(7);
  });

  it("test_lookup_glob_entry_not_found", () => {
    session.mark_glob_run("glob_s5", "**/*.py", null, 3);
    const result = session.lookup_glob_entry("glob_s5", "**/*.ts");
    expect(result).toBeNull();
  });

  it("test_lookup_glob_entry_path_differentiates", () => {
    session.mark_glob_run("glob_s6", "**/*.py", "src/", 10);
    session.mark_glob_run("glob_s6", "**/*.py", "tests/", 5);
    const entrySrc = session.lookup_glob_entry("glob_s6", "**/*.py", "src/");
    expect(entrySrc).not.toBeNull();
    expect(entrySrc!.result_count).toBe(10);
    const entryTests = session.lookup_glob_entry("glob_s6", "**/*.py", "tests/");
    expect(entryTests).not.toBeNull();
    expect(entryTests!.result_count).toBe(5);
  });

  it("test_lookup_glob_entry_returns_most_recent", () => {
    session.mark_glob_run("glob_s7", "**/*.py", null, 10);
    session.mark_glob_run("glob_s7", "**/*.py", null, 15);
    const entry = session.lookup_glob_entry("glob_s7", "**/*.py");
    expect(entry).not.toBeNull();
    expect(entry!.result_count).toBe(15);
  });

  it("test_is_glob_history_empty_true", () => {
    const cache = session.load("glob_empty_1");
    expect(cache.is_glob_history_empty()).toBe(true);
  });

  it("test_is_glob_history_empty_false", () => {
    const cache = session.mark_glob_run("glob_empty_2", "**/*.py", null, 1);
    expect(cache.is_glob_history_empty()).toBe(false);
  });
});

// ===========================================================================
// TestGlobHistoryCap
// ===========================================================================
describe("TestGlobHistoryCap", () => {
  it("test_glob_capped_at_max", () => {
    const sid = "glob_cap_1";
    let cache = session.load(sid);
    for (let i = 0; i < session.GLOB_HISTORY_MAX + 5; i++) {
      cache = session.mark_glob_run(sid, `**/${i}/*.py`, null, i, { cache });
    }
    session.save(cache);
    cache = session.load(sid);
    expect(cache.glob_history.length).toBeLessThanOrEqual(session.GLOB_HISTORY_MAX);
  });

  it("test_glob_cap_evicts_oldest", () => {
    const sid = "glob_cap_2";
    const n = session.GLOB_HISTORY_MAX + 3;
    let cache = session.load(sid);
    for (let i = 0; i < n; i++) {
      cache = session.mark_glob_run(sid, `**/pat_${i}/*.py`, null, i, { cache });
    }
    session.save(cache);
    cache = session.load(sid);
    const patterns = cache.glob_history.map((g) => g.pattern);
    expect(patterns).not.toContain("**/pat_0/*.py");
    expect(patterns).not.toContain("**/pat_1/*.py");
    expect(patterns).not.toContain("**/pat_2/*.py");
    expect(patterns).toContain(`**/pat_${n - 1}/*.py`);
  });

  it("test_glob_exactly_at_cap_not_evicted", () => {
    const sid = "glob_cap_3";
    let cache = session.load(sid);
    for (let i = 0; i < session.GLOB_HISTORY_MAX; i++) {
      cache = session.mark_glob_run(sid, `**/cap_${i}/*.py`, null, i, { cache });
    }
    session.save(cache);
    cache = session.load(sid);
    expect(cache.glob_history.length).toBe(session.GLOB_HISTORY_MAX);
  });
});

// ===========================================================================
// TestGlobSerializationRoundtrip
// ===========================================================================
describe("TestGlobSerializationRoundtrip", () => {
  it("test_glob_entry_roundtrip_with_result_count", () => {
    session.mark_glob_run("glob_rt_1", "**/*.py", "src/", 99);
    const loaded = session.load("glob_rt_1");
    expect(loaded.glob_history.length).toBe(1);
    const e = loaded.glob_history[0]!;
    expect(e.pattern).toBe("**/*.py");
    expect(e.path).toBe("src/");
    expect(e.result_count).toBe(99);
  });

  it("test_glob_entry_roundtrip_no_result_count", () => {
    session.mark_glob_run("glob_rt_2", "*.toml", null);
    const loaded = session.load("glob_rt_2");
    expect(loaded.glob_history[0]!.result_count).toBeNull();
  });

  it("test_parse_glob_entry_corrupted_returns_none", () => {
    const bad = { pattern: null, path: 123, ts: "not-a-float" };
    const result = session._parse_glob_entry(bad);
    expect(result === null || result instanceof GlobEntry).toBe(true);
  });

  it("test_serialize_glob_entry_omits_none_result_count", () => {
    const entry = new GlobEntry({ pattern: "**/*.py", path: null, ts: 1_747_000_000.0 });
    const d = session._serialize_glob_entry(entry);
    expect("result_count" in d).toBe(false);
  });

  it("test_serialize_glob_entry_includes_result_count", () => {
    const entry = new GlobEntry({
      pattern: "**/*.py",
      path: "src/",
      ts: 1_747_000_000.0,
      result_count: 7,
    });
    const d = session._serialize_glob_entry(entry);
    expect(d["result_count"]).toBe(7);
  });
});

// ===========================================================================
// TestSessionEvictionFIFO
// ===========================================================================
describe("TestSessionEvictionFIFO", () => {
  it("test_file_read_eviction_preserves_newest", () => {
    const sid = "evict_file_newest";
    let cache: session.SessionCache | null = null;
    for (let i = 0; i < 25; i++) {
      cache = session.mark_file_read(
        sid,
        `file_${String(i).padStart(2, "0")}.py`,
        0,
        10,
        { cache },
      );
    }
    expect(Object.keys(cache!.files).length).toBe(25);
    for (let i = 0; i < 475; i++) {
      cache = session.mark_file_read(
        sid,
        `extra_${String(i).padStart(4, "0")}.py`,
        0,
        10,
        { cache },
      );
    }
    expect(Object.keys(cache!.files).length).toBeLessThanOrEqual(session.FILES_MAX);
    expect(`extra_${String(474).padStart(4, "0")}.py` in cache!.files).toBe(true);
  });

  it("test_glob_history_eviction_exact_threshold", () => {
    const sid = "glob_exact_cap";
    let cache = session.load(sid);
    for (let i = 0; i < session.GLOB_HISTORY_MAX; i++) {
      cache = session.mark_glob_run(
        sid,
        `pattern_${String(i).padStart(3, "0")}`,
        null,
        10 + i,
        { cache },
      );
    }
    session.save(cache);
    cache = session.load(sid);
    expect(cache.glob_history.length).toBe(session.GLOB_HISTORY_MAX);
    expect(cache.glob_history[0]!.pattern).toBe("pattern_000");
  });

  it("test_glob_history_eviction_at_cap_plus_one", () => {
    const sid = "glob_at_cap_plus_one";
    let cache = session.load(sid);
    for (let i = 0; i < session.GLOB_HISTORY_MAX + 1; i++) {
      cache = session.mark_glob_run(sid, `pat_${String(i).padStart(3, "0")}`, null, i, { cache });
    }
    session.save(cache);
    cache = session.load(sid);
    expect(cache.glob_history.length).toBe(session.GLOB_HISTORY_MAX);
    const patterns = cache.glob_history.map((g) => g.pattern);
    expect(patterns).not.toContain("pat_000");
    expect(patterns).toContain(`pat_${String(session.GLOB_HISTORY_MAX).padStart(3, "0")}`);
  });

  it("test_glob_history_eviction_batch_25_entries", () => {
    const sid = "glob_batch_evict";
    const total = session.GLOB_HISTORY_MAX + 25;
    let cache = session.load(sid);
    for (let i = 0; i < total; i++) {
      cache = session.mark_glob_run(sid, `batch_${String(i).padStart(3, "0")}`, null, 100 + i, { cache });
    }
    session.save(cache);
    cache = session.load(sid);
    expect(cache.glob_history.length).toBeLessThanOrEqual(session.GLOB_HISTORY_MAX);
    const patterns = cache.glob_history.map((g) => g.pattern);
    expect(patterns).toContain(`batch_${String(total - 1).padStart(3, "0")}`);
    expect(patterns).not.toContain("batch_000");
  });

  it("test_bash_history_eviction_fifo_order", () => {
    const sid = "bash_fifo_order";
    // Add BASH_HISTORY_MAX + 10 entries; thread the cache so intermediate saves
    // are suppressed (the TS analogue of Python's patch.object(session, "save")).
    let cache: session.SessionCache | null = null;
    for (let i = 0; i < session.BASH_HISTORY_MAX + 10; i++) {
      const cmd = `cmd_${String(i).padStart(4, "0")}`;
      const cmd_sha = bash_cache.command_hash(cmd);
      cache = session.mark_bash_run(sid, cmd_sha, cmd, `out_${i}`, 1000, 0, 0, false, { cache });
    }
    if (cache !== null) session.save(cache);
    const loaded = session.load(sid);
    // Should be capped at BASH_HISTORY_MAX
    expect(Object.keys(loaded.bash_history).length).toBeLessThanOrEqual(session.BASH_HISTORY_MAX);
    // Most recent command's output should be in the history.
    const max_i = session.BASH_HISTORY_MAX + 10 - 1;
    const last_cmd = `cmd_${String(max_i).padStart(4, "0")}`;
    expect(Object.values(loaded.bash_history).some((e) => e.cmd_preview.includes(last_cmd))).toBe(true);
  });

  it("test_web_history_eviction_preserves_newest", () => {
    const sid = "web_fifo_newest";
    let cache = session.load(sid);
    for (let i = 0; i < session.WEB_HISTORY_MAX + 15; i++) {
      const url = `https://example.com/page_${i}`;
      const urlSha = web_cache.url_hash(url);
      cache = session.mark_web_fetch(
        sid,
        urlSha,
        url,
        `web_out_${i}`,
        5000,
        200,
        false,
        { cache },
      );
    }
    session.save(cache);
    cache = session.load(sid);
    expect(Object.keys(cache.web_history).length).toBeLessThanOrEqual(session.WEB_HISTORY_MAX);
    const previews = Object.values(cache.web_history).map((e) => e.url_preview);
    const maxI = session.WEB_HISTORY_MAX + 15 - 1;
    expect(previews.some((p) => p.includes(`page_${maxI}`))).toBe(true);
  });
});

// ===========================================================================
// TestEdgesCasesForEviction
// ===========================================================================
describe("TestEdgesCasesForEviction", () => {
  it("test_evict_oldest_on_empty_dict_noop", () => {
    const d: Record<string, unknown> = {};
    session._evict_oldest(d, 10, 5, "test", "test");
    expect(d).toEqual({});
  });

  it("test_evict_oldest_below_cap_is_noop", () => {
    const d: Record<string, unknown> = { a: 1, b: 2, c: 3 };
    session._evict_oldest(d, 10, 5, "test", "test");
    expect(d).toEqual({ a: 1, b: 2, c: 3 });
  });

  it("test_evict_oldest_exactly_at_cap_triggers", () => {
    const d: Record<string, unknown> = { a: 1, b: 2, c: 3, d: 4, e: 5 };
    session._evict_oldest(d, 5, 2, "test", "test");
    expect(Object.keys(d).length).toBe(3);
    expect("a" in d).toBe(false);
    expect("b" in d).toBe(false);
    expect("c" in d).toBe(true);
  });
});

// ===========================================================================
// TestLineRangesCap
// ===========================================================================
describe("TestLineRangesCap", () => {
  it("test_below_cap_ranges_kept_distinct", () => {
    const sid = "lr-cap-1";
    const path = "/proj/src/big.py";
    session.mark_file_read(sid, path, 0, 10);
    session.mark_file_read(sid, path, 100, 10);
    session.mark_file_read(sid, path, 200, 10);
    const entry = session.get_file_entry(sid, path);
    expect(entry).not.toBeNull();
    expect(entry!.line_ranges.length).toBe(3);
  });

  it("test_at_cap_ranges_not_yet_collapsed", () => {
    const sid = "lr-cap-2";
    const path = "/proj/src/big.py";
    let cache: session.SessionCache | null = null;
    for (let i = 0; i < 9; i++) {
      cache = session.mark_file_read(sid, path, i * 100, 10, { cache });
    }
    const entry = session.get_file_entry(sid, path);
    expect(entry).not.toBeNull();
    expect(entry!.line_ranges).not.toEqual([[0, 0]]);
    expect(entry!.line_ranges.length).toBeLessThanOrEqual(session._MAX_LINE_RANGES_PER_FILE);
  });

  it("test_exceeding_cap_collapses_to_spanning", () => {
    const sid = "lr-cap-3";
    const path = "/proj/src/big.py";
    let cache: session.SessionCache | null = null;
    for (let i = 0; i < 10; i++) {
      cache = session.mark_file_read(sid, path, i * 100, 10, { cache });
    }
    const entry = session.get_file_entry(sid, path);
    expect(entry).not.toBeNull();
    expect(entry!.line_ranges).toEqual([[0, 0]]);
  });

  it("test_spanning_range_is_superset", () => {
    const sid = "lr-cap-4";
    const path = "/proj/src/big.py";
    let cache: session.SessionCache | null = null;
    for (let i = 0; i < 9; i++) {
      cache = session.mark_file_read(sid, path, i * 500, 10, { cache });
    }
    const entry = session.get_file_entry(sid, path);
    expect(entry).not.toBeNull();
    expect(entry!.line_ranges).not.toEqual([[0, 0]]);
    expect(entry!.line_ranges.some(([start]) => start <= 1)).toBe(true);
    expect(entry!.line_ranges.some(([, end]) => end >= 8 * 500 + 10)).toBe(true);
  });
});

// ===========================================================================
// TestLegacyHighCapSessionLoad
// ===========================================================================
describe("TestLegacyHighCapSessionLoad", () => {
  it("test_bash_history_over_new_cap_loads_without_error", () => {
    const sid = "legacy-bash-150";
    let cache: session.SessionCache | null = null;
    for (let i = 0; i < 150; i++) {
      cache = session.mark_bash_run(
        sid,
        `sha${String(i).padStart(4, "0")}`,
        `pytest tests/test_${i}.py`,
        `out-${i}`,
        1000,
        0,
        0,
        false,
        { cache },
      );
    }
    if (cache !== null) session.save(cache);
    const loaded = session.load(sid);
    expect(loaded).toBeInstanceOf(session.SessionCache);
    expect(Object.keys(loaded.bash_history).length).toBeLessThanOrEqual(session.BASH_HISTORY_MAX);
  });

  it("test_web_history_over_new_cap_loads_without_error", () => {
    const sid = "legacy-web-150";
    let cache: session.SessionCache | null = null;
    for (let i = 0; i < 150; i++) {
      cache = session.mark_web_fetch(
        sid,
        `sha${String(i).padStart(4, "0")}`,
        `https://example.com/page/${i}`,
        `wout-${i}`,
        2000,
        200,
        false,
        { cache },
      );
    }
    if (cache !== null) session.save(cache);
    const loaded = session.load(sid);
    expect(loaded).toBeInstanceOf(session.SessionCache);
    expect(Object.keys(loaded.web_history).length).toBeLessThanOrEqual(session.WEB_HISTORY_MAX);
  });

  it("test_grep_history_over_new_cap_loads_without_error", () => {
    const sid = "legacy-grep-150";
    let cache: session.SessionCache | null = null;
    for (let i = 0; i < 150; i++) {
      cache = session.mark_grep(sid, `pattern_${i}`, `/proj/src_${i}`, null, { cache });
    }
    if (cache !== null) session.save(cache);
    const loaded = session.load(sid);
    expect(loaded).toBeInstanceOf(session.SessionCache);
    expect(loaded.greps.length).toBeLessThanOrEqual(session.GREPS_HISTORY_MAX);
  });

  it("test_next_write_after_oversize_load_stays_bounded", () => {
    const sid = "legacy-write-bounded";
    let cache: session.SessionCache | null = null;
    for (let i = 0; i < 150; i++) {
      cache = session.mark_bash_run(
        sid,
        `sha${String(i).padStart(4, "0")}`,
        `cmd ${i}`,
        `out-${i}`,
        500,
        0,
        0,
        false,
        { cache },
      );
    }
    if (cache !== null) session.save(cache);
    session.mark_bash_run(sid, "shaXXXX", "final cmd", "out-final", 500, 0, 0, false);
    const loaded = session.load(sid);
    expect(Object.keys(loaded.bash_history).length).toBeLessThanOrEqual(session.BASH_HISTORY_MAX);
  });

  it("test_bash_history_cap_300_entries_save_load", () => {
    const sid = "bash-cap-300-roundtrip";
    const n = 300;
    let cache: session.SessionCache | null = null;
    for (let i = 0; i < n; i++) {
      cache = session.mark_bash_run(
        sid,
        `sha${String(i).padStart(4, "0")}`,
        `pytest tests/test_batch_${i}.py`,
        `out-${i}`,
        500,
        0,
        0,
        false,
        { cache },
      );
    }
    if (cache !== null) session.save(cache);
    const loaded = session.load(sid);
    expect(Object.keys(loaded.bash_history).length).toBeLessThanOrEqual(session.BASH_HISTORY_MAX);
    const lastPreview = `pytest tests/test_batch_${n - 1}.py`;
    expect(
      Object.values(loaded.bash_history).some((e) => e.cmd_preview.includes(lastPreview)),
    ).toBe(true);
    const firstPreview = "pytest tests/test_batch_0.py";
    expect(
      Object.values(loaded.bash_history).every((e) => !e.cmd_preview.includes(firstPreview)),
    ).toBe(true);
  });
});

// ===========================================================================
// TestSessionSchemaMigration
// ===========================================================================
describe("TestSessionSchemaMigration", () => {
  it("test_migrate_session_adds_missing_edited_files", () => {
    const oldData = {
      session_id: "test-migrate-1",
      started_ts: Date.now() / 1000,
      last_activity_ts: Date.now() / 1000,
      files: {},
    };
    const migrated = session._migrate_session(oldData);
    expect("edited_files" in migrated).toBe(true);
    expect(migrated["edited_files"]).toEqual({});
  });

  it("test_migrate_session_adds_missing_glob_history", () => {
    const oldData = {
      session_id: "test-migrate-2",
      started_ts: Date.now() / 1000,
      last_activity_ts: Date.now() / 1000,
      files: {},
    };
    const migrated = session._migrate_session(oldData);
    expect("glob_history" in migrated).toBe(true);
    expect(migrated["glob_history"]).toEqual([]);
  });

  it("test_migrate_session_adds_symbols_ts_to_file_entries", () => {
    const oldData = {
      session_id: "test-migrate-3",
      started_ts: Date.now() / 1000,
      last_activity_ts: Date.now() / 1000,
      files: {
        "src/foo.py": {
          rel_or_abs: "src/foo.py",
          last_read_ts: Date.now() / 1000,
          read_count: 1,
        },
      },
    };
    const migrated = session._migrate_session(oldData);
    const fileEntry = (migrated["files"] as Record<string, Record<string, unknown>>)["src/foo.py"]!;
    expect("symbols_ts" in fileEntry).toBe(true);
    expect(fileEntry["symbols_ts"]).toEqual({});
  });

  it("test_migrate_session_adds_last_edit_ts_to_file_entries", () => {
    const oldData = {
      session_id: "test-migrate-4",
      started_ts: Date.now() / 1000,
      last_activity_ts: Date.now() / 1000,
      files: {
        "src/bar.py": {
          rel_or_abs: "src/bar.py",
          last_read_ts: Date.now() / 1000,
          read_count: 2,
        },
      },
    };
    const migrated = session._migrate_session(oldData);
    const fileEntry = (migrated["files"] as Record<string, Record<string, unknown>>)["src/bar.py"]!;
    expect("last_edit_ts" in fileEntry).toBe(true);
    expect(fileEntry["last_edit_ts"]).toBe(0.0);
  });

  it("test_old_session_without_glob_history_loads_fine", () => {
    const sid = "old-no-glob-history";
    session.load(sid);
    session.mark_file_read(sid, "test.py", 0, 10);
    const loaded = session.load(sid);
    expect(loaded.glob_history).toEqual([]);
    expect(Object.keys(loaded.files).length).toBe(1);
  });

  it("test_old_session_without_symbols_ts_on_file_entry_loads_fine", () => {
    const sid = "old-no-symbols-ts";
    session.mark_file_read(sid, "src/module.py", null, null, { symbol: "MyClass" });
    const loaded = session.load(sid);
    const entry = loaded.files["src/module.py"];
    expect(entry).not.toBeUndefined();
    expect(typeof entry!.symbols_ts === "object" && entry!.symbols_ts !== null).toBe(true);
    expect(entry!.symbols_read).toContain("MyClass");
  });

  it("test_fully_modern_session_unaffected_by_migration", () => {
    const sid = "modern-session";
    session.mark_file_read(sid, "src/test.py", 0, 50);
    session.mark_file_edited(sid, "src/test.py");
    session.mark_glob_run(sid, "**/*.py", null, 42);
    const loaded = session.load(sid);
    expect(Array.isArray(loaded.glob_history)).toBe(true);
    expect(loaded.glob_history.length).toBe(1);
    expect(loaded.glob_history[0]!.pattern).toBe("**/*.py");
    expect(loaded.edited_files).toEqual({ "src/test.py": 1 });
    const entry = loaded.files["src/test.py"]!;
    expect(typeof entry.symbols_ts === "object" && entry.symbols_ts !== null).toBe(true);
    expect(entry.last_edit_ts).toBeGreaterThan(0.0);
  });

  it("test_missing_edited_files_defaults_to_empty_list", () => {
    const oldData = {
      session_id: "test-default-edited",
      started_ts: Date.now() / 1000,
      last_activity_ts: Date.now() / 1000,
      files: {},
    };
    const migrated = session._migrate_session(oldData);
    const cache = session.SessionCache.from_dict(migrated);
    expect(cache.edited_files).toEqual({});
  });
});
