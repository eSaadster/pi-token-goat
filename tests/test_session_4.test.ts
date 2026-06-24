/**
 * Unit tests for token_goat/session — part 4/4. 1:1 port of the Python
 * tests/test_session.py classes from TestPendingHintSave through
 * TestGrepResultHashes (source lines ~3645-5169):
 *
 *   TestPendingHintSave, TestAdaptiveHintSuppression, TestSchemaVersioning,
 *   TestProcLoadCache, TestPerTypeHintCounters, TestEditedFilesMerge,
 *   TestDecisionsMerge, TestHintCategoryHistoryMerge, TestMergeEmptyDictFields,
 *   TestMergeNaNTimestamps, TestMergeEditedFilesConflicts,
 *   TestTypedDictDataclassAlignment, TestSessionReliability,
 *   TestGrepResultHashes.
 *
 * Test-seam mapping (Python → TS):
 *  - tmp_data_dir fixture → setup.ts's per-test setDataDirOverride; we resolve
 *    session JSON paths via paths.sessionCachePath() (never hardcoded tmp).
 *  - session._proc_load_cache.clear() → the same exported Map's .clear()
 *    (setup.ts also clears it per test via clearModuleCaches()).
 *  - session.paths.session_cache_path(sid) → paths.sessionCachePath(sid)
 *    (returns a string path; Python returned a pathlib.Path).
 *  - os.utime(file, (t, t)) → fs.utimesSync(file, atime, mtime).
 *  - monkeypatch.setattr(session.time, "time", fake) → vi.spyOn(Date, "now")
 *    because record_grep_result_hash uses Date.now()/1000 (the TS analogue of
 *    time.time()).
 *
 * TypedDictDataclassAlignment adaptation: Python reflected dataclass fields vs
 * TypedDict __annotations__ at runtime. TS interfaces have no runtime form, so
 * each entry's live field set (Object.keys of a fully-populated instance) is
 * asserted equal to the wire-dict key set declared by the corresponding
 * _*EntryDict interface in session.ts (transcribed here as literal key sets).
 * Intent preserved: a field added to an entry class without a matching wire-dict
 * key (or vice-versa) fails the test — no field drift.
 *
 * Every Python `def test_*` maps to one vitest `it()` with the same name and
 * assertion polarity.
 */
import fs from "node:fs";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";

import * as paths from "../src/token_goat/paths.js";
import {
  BashEntry,
  DecisionEntry,
  FileEntry,
  GlobEntry,
  GREP_RESULT_HASHES_MAX,
  GrepEntry,
  ResultCacheEntry,
  SESSION_SCHEMA_VERSION,
  SessionCache,
  SkillEntry,
  WebEntry,
  _HINT_CAT_HISTORY_MAX,
  _PROC_LOAD_CACHE_MAX,
  _cleanup_stale_tmp_files,
  _hint_category_should_suppress,
  _merge_session_caches,
  _normalize_path,
  _preserve_corrupt_file,
  _proc_load_cache,
  load,
  mark_file_edited,
  mark_file_read,
  record_hint_category,
  save,
} from "../src/token_goat/session.js";

// ---------------------------------------------------------------------------
// Shared helpers (replicate Python imports / fixtures the in-scope classes use).
// ---------------------------------------------------------------------------

// session._fresh_cache is NOT exported by the TS module; it merely constructs a
// fresh SessionCache(session_id, now, now). Mirror it locally so the tests that
// reached into session._fresh_cache keep identical behaviour.
function _fresh_cache(session_id: string): SessionCache {
  const now = Date.now() / 1000;
  return new SessionCache({
    session_id,
    started_ts: now,
    last_activity_ts: now,
  });
}

// session.SessionCache("id", 0, 0) in Python is positional (session_id,
// started_ts, last_activity_ts). The TS constructor takes an init object.
function makeCache(
  session_id: string,
  started_ts: number,
  last_activity_ts: number,
): SessionCache {
  return new SessionCache({ session_id, started_ts, last_activity_ts });
}

describe("TestPendingHintSave", () => {
  it("test_mark_hint_seen_sets_flag", () => {
    const sid = "ff0011".repeat(6);
    const cache = load(sid);
    cache.mark_hint_seen("test-fingerprint");
    expect(cache._pending_hint_save).toBe(true);
  });

  it("test_hint_not_on_disk_until_save", () => {
    const sid = "001122".repeat(6);
    const cache = load(sid);
    cache.mark_hint_seen("pending-fp");
    expect(cache._pending_hint_save).toBe(true);

    // Load fresh copy from disk — hint should NOT be there yet
    const on_disk = load(sid);
    const p = paths.sessionCachePath(sid);
    if (fs.existsSync(p)) {
      expect("pending-fp" in on_disk.hints_seen).toBe(false);
    }
    // In-memory cache has it
    expect("pending-fp" in cache.hints_seen).toBe(true);
  });

  it("test_hint_persisted_after_mark_file_read", () => {
    const sid = "112233".repeat(6);
    const cache = load(sid);
    cache.mark_hint_seen("flush-via-file-read");
    expect(cache._pending_hint_save).toBe(true);

    // mark_file_read calls save() internally — flush happens
    mark_file_read(sid, "/tmp/example.py", null, null, { cache });

    const on_disk = load(sid);
    expect("flush-via-file-read" in on_disk.hints_seen).toBe(true);
  });

  it("test_duplicate_fingerprint_increments_count_sets_flag", () => {
    const sid = "223344".repeat(6);
    const cache = load(sid);
    cache.mark_hint_seen("already-seen");
    expect(cache.hints_seen["already-seen"]).toBe(1);
    cache._pending_hint_save = false; // reset
    cache.mark_hint_seen("already-seen"); // second call — increments count
    expect(cache.hints_seen["already-seen"]).toBe(2);
    expect(cache._pending_hint_save).toBe(true); // flag is set because count changed
  });
});

describe("TestAdaptiveHintSuppression", () => {
  it("test_no_history_never_suppresses", () => {
    const sid = "aabbcc".repeat(6);
    const cache = load(sid);
    expect(_hint_category_should_suppress(cache, "session_hint")).toBe(false);
  });

  it("test_emits_when_accepted", () => {
    const sid = "bbccdd".repeat(6);
    const cache = load(sid);
    // Record 5 accepted (True) entries
    for (let i = 0; i < 5; i++) {
      record_hint_category(cache, "session_hint", true);
    }
    expect(_hint_category_should_suppress(cache, "session_hint")).toBe(false);
  });

  it("test_suppresses_after_n_ignored", () => {
    const sid = "ccddeeff".repeat(4);
    const cache = load(sid);
    for (let i = 0; i < 5; i++) {
      record_hint_category(cache, "bash_dedup_hint", false);
    }
    expect(_hint_category_should_suppress(cache, "bash_dedup_hint")).toBe(true);
  });

  it("test_threshold_configurable", () => {
    const sid = "ddeeff00".repeat(4);
    const cache = load(sid);
    // Record 3 False entries
    for (let i = 0; i < 3; i++) {
      record_hint_category(cache, "web_dedup_hint", false);
    }
    // threshold=5 → not yet suppressed
    expect(_hint_category_should_suppress(cache, "web_dedup_hint", 5)).toBe(false);
    // threshold=3 → suppressed
    expect(_hint_category_should_suppress(cache, "web_dedup_hint", 3)).toBe(true);
  });

  it("test_mixed_history_not_suppressed", () => {
    const sid = "eeff0011".repeat(4);
    const cache = load(sid);
    // 4 False, then 1 True: last 5 are not all False
    for (let i = 0; i < 4; i++) {
      record_hint_category(cache, "session_hint", false);
    }
    record_hint_category(cache, "session_hint", true);
    expect(_hint_category_should_suppress(cache, "session_hint")).toBe(false);
  });

  it("test_ring_buffer_capped", () => {
    const sid = "ff001122".repeat(4);
    const cache = load(sid);
    for (let i = 0; i < 20; i++) {
      record_hint_category(cache, "cat", Boolean(i % 2));
    }
    const hist = cache.hint_category_history["cat"] ?? [];
    expect(hist.length).toBeLessThanOrEqual(_HINT_CAT_HISTORY_MAX);
  });

  it("test_roundtrip_serialization", () => {
    // Use a valid session id (32+ alphanum chars)
    const sid = "a0b1c2d3".repeat(4) + "a0b1";
    const cache = load(sid);
    record_hint_category(cache, "bash_dedup_hint", false);
    record_hint_category(cache, "bash_dedup_hint", false);
    save(cache);
    const loaded = load(sid);
    expect("bash_dedup_hint" in loaded.hint_category_history).toBe(true);
    expect(loaded.hint_category_history["bash_dedup_hint"]).toEqual([false, false]);
  });

  it("test_zero_threshold_never_suppresses", () => {
    const sid = "b1c2d3e4".repeat(4) + "b1c2";
    const cache = load(sid);
    for (let i = 0; i < 10; i++) {
      record_hint_category(cache, "cat", false);
    }
    expect(_hint_category_should_suppress(cache, "cat", 0)).toBe(false);
  });
});

describe("TestSchemaVersioning", () => {
  it("test_schema_version_present_in_serialized_dict", () => {
    const sid = "schema-ver-test-" + "a".repeat(18);
    const cache = load(sid);
    const d = cache.to_dict();
    expect("schema_version" in d).toBe(true);
    expect(d.schema_version).toBe(SESSION_SCHEMA_VERSION);
  });

  it("test_schema_version_mismatch_drops_cache", () => {
    const sid = "schema-mismatch-" + "b".repeat(16);
    const cache_path = paths.sessionCachePath(sid);
    paths.ensureDir(path.dirname(cache_path));

    const stale_data = {
      schema_version: 999,
      session_id: sid,
      started_ts: 1.0,
      last_activity_ts: 1.0,
      created_ts: 1.0,
      files: { "stale/file.py": { rel_or_abs: "stale/file.py", read_count: 5 } },
      greps: [],
      edited_files: {},
      created_by: "token-goat",
    };
    fs.writeFileSync(cache_path, JSON.stringify(stale_data), "utf8");

    const loaded = load(sid);
    // Must return an empty cache, not crash
    expect(loaded.session_id).toBe(sid);
    expect(loaded.files).toEqual({});
    expect(loaded.greps).toEqual([]);
  });

  it("test_schema_version_missing_drops_cache", () => {
    const sid = "schema-missing-" + "c".repeat(17);
    const cache_path = paths.sessionCachePath(sid);
    paths.ensureDir(path.dirname(cache_path));

    const old_data = {
      // schema_version intentionally absent
      session_id: sid,
      started_ts: 1.0,
      last_activity_ts: 1.0,
      created_ts: 1.0,
      files: { "old/file.py": { rel_or_abs: "old/file.py", read_count: 3 } },
      greps: [],
      edited_files: {},
    };
    fs.writeFileSync(cache_path, JSON.stringify(old_data), "utf8");

    const loaded = load(sid);
    expect(loaded.session_id).toBe(sid);
    expect(loaded.files).toEqual({});
  });
});

describe("TestProcLoadCache", () => {
  // Clear the module-level process cache before each test (Python's
  // self._clear_proc_cache()).
  function clearProcCache(): void {
    _proc_load_cache.clear();
  }

  it("test_repeated_load_unchanged_mtime_returns_same_object", () => {
    clearProcCache();
    const sid = "proc-cache-hit-" + "a".repeat(17);
    mark_file_read(sid, "a.py", 0, 10);

    const loaded1 = load(sid);
    const loaded2 = load(sid);
    expect(loaded1).toBe(loaded2);
  });

  it("test_changed_mtime_returns_new_object", () => {
    clearProcCache();
    const sid = "proc-cache-miss-" + "b".repeat(16);
    mark_file_read(sid, "b.py", 0, 5);

    const loaded1 = load(sid);

    // Backdate the existing session file so the next write has a
    // distinguishably newer mtime without sleeping.
    const _sess_path = paths.sessionCachePath(sid);
    if (fs.existsSync(_sess_path)) {
      const st = fs.statSync(_sess_path);
      const _old_mtime = st.mtimeMs / 1000;
      fs.utimesSync(_sess_path, _old_mtime - 2.0, _old_mtime - 2.0);
    }
    // Write using mark_file_read which internally saves to disk.
    mark_file_read(sid, "c.py", 0, 3);
    // Evict the stale proc-cache entry so the next load() sees the updated mtime.
    _proc_load_cache.delete(sid);

    const loaded2 = load(sid);
    expect(loaded2).not.toBe(loaded1);
    // The freshly loaded object should contain c.py
    const norm = _normalize_path("c.py");
    expect(norm in loaded2.files).toBe(true);
  });

  it("test_save_refreshes_proc_load_cache", () => {
    clearProcCache();
    const sid = "proc-cache-refresh-" + "d".repeat(14);

    // Seed an on-disk session and prime the proc cache via load().
    mark_file_read(sid, "seed.py", 0, 4);
    const c = load(sid);
    const primed = _proc_load_cache.get(sid);
    expect(primed).not.toBeUndefined();
    expect(primed?.[0]).toBe(c);

    // Simulate the failure precondition: a DISTINCT pre-merge object shadows the
    // cache entry under the same mtime.
    const aliased_mtime = primed![1];
    const stale = _fresh_cache(sid);
    expect(stale).not.toBe(c);
    _proc_load_cache.set(sid, [stale, aliased_mtime]);

    // Mutate and persist the real cache through the normal mutation path.
    mark_file_edited(sid, "/edited/file.py", { cache: c });

    const entry = _proc_load_cache.get(sid);
    expect(entry).not.toBeUndefined();
    expect(entry?.[0]).toBe(c);
    const edited_key = _normalize_path("/edited/file.py");
    expect(edited_key in c.edited_files).toBe(true);

    // A subsequent in-process load() must observe the edit, never the stale
    // shadow object.
    const reloaded = load(sid);
    expect(reloaded).not.toBe(stale);
    expect(edited_key in reloaded.edited_files).toBe(true);
  });

  it("test_cache_cap_enforced", () => {
    clearProcCache();
    const cap = _PROC_LOAD_CACHE_MAX;
    // Create cap+2 session files and load them all.
    for (let i = 0; i < cap + 2; i++) {
      const sid = `proc-cap-${String(i).padStart(2, "0")}-` + "c".repeat(16);
      const c = _fresh_cache(sid);
      save(c);
      load(sid);
    }

    expect(_proc_load_cache.size).toBeLessThanOrEqual(cap);
  });
});

describe("TestPerTypeHintCounters", () => {
  it("test_record_hint_emitted_increments_counter", () => {
    const cache = _fresh_cache("test-per-type-1");
    expect(cache.hints_emitted_by_type["bash_dedup"] ?? 0).toBe(0);

    cache.record_hint_emitted("bash_dedup");
    expect(cache.hints_emitted_by_type["bash_dedup"]).toBe(1);

    cache.record_hint_emitted("bash_dedup");
    expect(cache.hints_emitted_by_type["bash_dedup"]).toBe(2);
  });

  it("test_record_hint_emitted_sets_pending_hint_save", () => {
    const cache = _fresh_cache("test-per-type-emitted-pending");
    cache._pending_hint_save = false;
    cache.record_hint_emitted("unchanged_file");
    expect(cache._pending_hint_save).toBe(true);
  });

  it("test_record_hint_suppressed_increments_counter", () => {
    const cache = _fresh_cache("test-per-type-2");
    expect(cache.hints_suppressed_by_type["bash_dedup_below_threshold"] ?? 0).toBe(0);

    cache.record_hint_suppressed("bash_dedup_below_threshold");
    expect(cache.hints_suppressed_by_type["bash_dedup_below_threshold"]).toBe(1);

    cache.record_hint_suppressed("bash_dedup_below_threshold");
    expect(cache.hints_suppressed_by_type["bash_dedup_below_threshold"]).toBe(2);
  });

  it("test_record_hint_suppressed_sets_pending_hint_save", () => {
    const cache = _fresh_cache("test-per-type-suppressed-pending");
    cache._pending_hint_save = false;
    cache.record_hint_suppressed("bash_dedup_below_threshold");
    expect(cache._pending_hint_save).toBe(true);
  });

  it("test_per_type_counters_persist_roundtrip", () => {
    const sid = "test-per-type-roundtrip-3";
    const cache = _fresh_cache(sid);
    cache.record_hint_emitted("read_dedup");
    cache.record_hint_emitted("bash_dedup");
    cache.record_hint_emitted("bash_dedup");
    cache.record_hint_suppressed("web_dedup_below_threshold");
    save(cache);

    const loaded = load(sid);
    expect(loaded.hints_emitted_by_type["read_dedup"]).toBe(1);
    expect(loaded.hints_emitted_by_type["bash_dedup"]).toBe(2);
    expect(loaded.hints_suppressed_by_type["web_dedup_below_threshold"]).toBe(1);
  });

  it("test_backward_compat_missing_fields_default_to_empty_dict", () => {
    const sid = "test-per-type-compat-4";
    const cache = _fresh_cache(sid);
    // Simulate an old session by manually creating a dict without the new fields
    const old_dict = cache.to_dict() as Record<string, unknown>;
    delete old_dict["hints_emitted_by_type"];
    delete old_dict["hints_suppressed_by_type"];

    // Write the old-format dict to disk
    const p = paths.sessionCachePath(sid);
    paths.ensureDir(path.dirname(p));
    fs.writeFileSync(p, JSON.stringify(old_dict), "utf8");

    // Load it back - should not crash and should default to empty dicts
    const loaded = load(sid);
    expect(loaded.hints_emitted_by_type).toEqual({});
    expect(loaded.hints_suppressed_by_type).toEqual({});
  });

  it("test_merge_max_per_type_counters", () => {
    const local = _fresh_cache("test-per-type-merge-5");
    local.hints_emitted_by_type = { bash_dedup: 3, grep_dedup: 1 };
    local.hints_suppressed_by_type = { bash_dedup_below_threshold: 2 };

    const remote = _fresh_cache("test-per-type-merge-5");
    remote.hints_emitted_by_type = { bash_dedup: 2, read_dedup: 1 };
    remote.hints_suppressed_by_type = {
      bash_dedup_below_threshold: 1,
      web_dedup_below_threshold: 3,
    };

    const merged = _merge_session_caches(local, remote);

    // max() per key — not additive — consistent with hints_emitted scalar
    expect(merged.hints_emitted_by_type["bash_dedup"]).toBe(3); // max(3, 2)
    expect(merged.hints_emitted_by_type["grep_dedup"]).toBe(1); // local-only key
    expect(merged.hints_emitted_by_type["read_dedup"]).toBe(1); // remote-only key
    expect(merged.hints_suppressed_by_type["bash_dedup_below_threshold"]).toBe(2); // max(2, 1)
    expect(merged.hints_suppressed_by_type["web_dedup_below_threshold"]).toBe(3); // remote-only key
  });

  it("test_multiple_hint_types_tracked_independently", () => {
    const cache = _fresh_cache("test-per-type-indep-6");

    cache.record_hint_emitted("read_dedup");
    cache.record_hint_emitted("bash_dedup");
    cache.record_hint_emitted("bash_dedup");
    cache.record_hint_suppressed("grep_dedup_below_threshold");
    cache.record_hint_suppressed("grep_dedup_below_threshold");
    cache.record_hint_suppressed("grep_dedup_below_threshold");

    expect(cache.hints_emitted_by_type["read_dedup"]).toBe(1);
    expect(cache.hints_emitted_by_type["bash_dedup"]).toBe(2);
    expect(cache.hints_suppressed_by_type["grep_dedup_below_threshold"]).toBe(3);
  });
});

describe("TestEditedFilesMerge", () => {
  it("test_edited_files_merge_takes_max", () => {
    const local = makeCache("efm-1", 0, 0);
    const remote = makeCache("efm-1", 0, 0);
    local.edited_files["src/a.py"] = 3;
    remote.edited_files["src/a.py"] = 5;

    const merged = _merge_session_caches(local, remote);
    expect(merged.edited_files["src/a.py"]).toBe(5); // max(5, 3)
  });

  it("test_edited_files_merge_local_higher_wins", () => {
    const local = makeCache("efm-2", 0, 0);
    const remote = makeCache("efm-2", 0, 0);
    local.edited_files["src/b.py"] = 7;
    remote.edited_files["src/b.py"] = 2;

    const merged = _merge_session_caches(local, remote);
    expect(merged.edited_files["src/b.py"]).toBe(7); // max(2, 7)
  });

  it("test_edited_files_merge_local_only_key_added", () => {
    const local = makeCache("efm-3", 0, 0);
    const remote = makeCache("efm-3", 0, 0);
    local.edited_files["src/new.py"] = 4;

    const merged = _merge_session_caches(local, remote);
    expect(merged.edited_files["src/new.py"]).toBe(4);
  });

  it("test_edited_files_merge_does_not_sum", () => {
    const local = makeCache("efm-4", 0, 0);
    const remote = makeCache("efm-4", 0, 0);
    local.edited_files["src/c.py"] = 3;
    remote.edited_files["src/c.py"] = 3;

    const merged = _merge_session_caches(local, remote);
    expect(merged.edited_files["src/c.py"]).toBe(3); // max(3,3)=3, not sum=6
  });
});

describe("TestDecisionsMerge", () => {
  it("test_local_decision_added_when_not_in_remote", () => {
    const local = makeCache("dm-1", 0, 0);
    const remote = makeCache("dm-1", 0, 0);
    local.decisions.push(new DecisionEntry({ text: "chose option A", ts: 1.0 }));

    const merged = _merge_session_caches(local, remote);
    expect(merged.decisions.some((d) => d.text === "chose option A")).toBe(true);
  });

  it("test_remote_decision_preserved_when_local_empty", () => {
    const local = makeCache("dm-2", 0, 0);
    const remote = makeCache("dm-2", 0, 0);
    remote.decisions.push(new DecisionEntry({ text: "remote decision", ts: 2.0 }));

    const merged = _merge_session_caches(local, remote);
    expect(merged.decisions.some((d) => d.text === "remote decision")).toBe(true);
  });

  it("test_duplicate_decision_not_duplicated_in_merge", () => {
    const local = makeCache("dm-3", 0, 0);
    const remote = makeCache("dm-3", 0, 0);
    const d = new DecisionEntry({ text: "same decision", ts: 3.0 });
    local.decisions.push(d);
    remote.decisions.push(d);

    const merged = _merge_session_caches(local, remote);
    expect(merged.decisions.filter((x) => x.text === "same decision").length).toBe(1);
  });

  it("test_decisions_merge_union_both", () => {
    const local = makeCache("dm-4", 0, 0);
    const remote = makeCache("dm-4", 0, 0);
    local.decisions.push(new DecisionEntry({ text: "local only", ts: 4.0 }));
    remote.decisions.push(new DecisionEntry({ text: "remote only", ts: 5.0 }));

    const merged = _merge_session_caches(local, remote);
    const texts = new Set(merged.decisions.map((d) => d.text));
    expect(texts.has("local only")).toBe(true);
    expect(texts.has("remote only")).toBe(true);
  });
});

describe("TestHintCategoryHistoryMerge", () => {
  it("test_local_only_category_appears_in_merge", () => {
    const local = makeCache("hch-1", 0, 0);
    const remote = makeCache("hch-1", 0, 0);
    local.hint_category_history["read_dedup"] = [true, false, true];

    const merged = _merge_session_caches(local, remote);
    expect("read_dedup" in merged.hint_category_history).toBe(true);
    expect(merged.hint_category_history["read_dedup"]).toEqual([true, false, true]);
  });

  it("test_remote_only_category_preserved", () => {
    const local = makeCache("hch-2", 0, 0);
    const remote = makeCache("hch-2", 0, 0);
    remote.hint_category_history["bash_dedup"] = [false, false];

    const merged = _merge_session_caches(local, remote);
    expect(merged.hint_category_history["bash_dedup"]).toEqual([false, false]);
  });

  it("test_longer_list_wins_per_category", () => {
    const local = makeCache("hch-3", 0, 0);
    const remote = makeCache("hch-3", 0, 0);
    local.hint_category_history["web_dedup"] = [true, false, true, false];
    remote.hint_category_history["web_dedup"] = [true];

    const merged = _merge_session_caches(local, remote);
    expect(merged.hint_category_history["web_dedup"]).toEqual([true, false, true, false]);
  });

  it("test_category_capped_at_history_max", () => {
    const local = makeCache("hch-4", 0, 0);
    const remote = makeCache("hch-4", 0, 0);
    const over_limit = new Array<boolean>(_HINT_CAT_HISTORY_MAX + 5).fill(true);
    local.hint_category_history["grep_dedup"] = over_limit;

    const merged = _merge_session_caches(local, remote);
    expect(merged.hint_category_history["grep_dedup"]?.length).toBe(_HINT_CAT_HISTORY_MAX);
  });
});

describe("TestMergeEmptyDictFields", () => {
  it("test_files_local_empty_remote_has_entries", () => {
    const local = makeCache("med-f1", 0.0, 1.0);
    const remote = makeCache("med-f1", 0.0, 2.0);
    remote.files["src/foo.py"] = new FileEntry({
      rel_or_abs: "src/foo.py",
      last_read_ts: 2.0,
      read_count: 3,
      line_ranges: [[1, 50]],
      symbols_read: ["bar"],
    });

    const merged = _merge_session_caches(local, remote);
    expect("src/foo.py" in merged.files).toBe(true);
    expect(merged.files["src/foo.py"]?.read_count).toBe(3);
  });

  it("test_files_remote_empty_local_has_entries", () => {
    const local = makeCache("med-f2", 0.0, 1.0);
    const remote = makeCache("med-f2", 0.0, 2.0);
    local.files["src/bar.py"] = new FileEntry({
      rel_or_abs: "src/bar.py",
      last_read_ts: 1.0,
      read_count: 1,
      line_ranges: [],
      symbols_read: [],
    });

    const merged = _merge_session_caches(local, remote);
    expect("src/bar.py" in merged.files).toBe(true);
  });

  it("test_bash_history_local_empty", () => {
    const local = makeCache("med-b1", 0.0, 1.0);
    const remote = makeCache("med-b1", 0.0, 2.0);
    remote.bash_history["abc123"] = new BashEntry({
      cmd_sha: "abc123",
      cmd_preview: "pytest",
      output_id: "out1",
      ts: 2.0,
      stdout_bytes: 512,
      stderr_bytes: 0,
    });

    const merged = _merge_session_caches(local, remote);
    expect("abc123" in merged.bash_history).toBe(true);
  });

  it("test_bash_history_remote_empty", () => {
    const local = makeCache("med-b2", 0.0, 1.0);
    const remote = makeCache("med-b2", 0.0, 2.0);
    local.bash_history["def456"] = new BashEntry({
      cmd_sha: "def456",
      cmd_preview: "ruff check",
      output_id: "out2",
      ts: 1.0,
      stdout_bytes: 128,
      stderr_bytes: 0,
    });

    const merged = _merge_session_caches(local, remote);
    expect("def456" in merged.bash_history).toBe(true);
  });

  it("test_web_history_remote_empty_local_has_entries", () => {
    const local = makeCache("med-w1", 0.0, 1.0);
    const remote = makeCache("med-w1", 0.0, 2.0);
    local.web_history["sha1"] = new WebEntry({
      url_sha: "sha1",
      url_preview: "https://example.com/doc",
      output_id: "web-out1",
      ts: 1.0,
      body_bytes: 4096,
    });

    const merged = _merge_session_caches(local, remote);
    expect("sha1" in merged.web_history).toBe(true);
  });

  it("test_skill_history_remote_empty_local_has_entries", () => {
    const local = makeCache("med-sk1", 0.0, 1.0);
    const remote = makeCache("med-sk1", 0.0, 2.0);
    local.skill_history["ralph"] = new SkillEntry({
      skill_name: "ralph",
      output_id: "skill-out1",
      content_sha: "deadbeef",
      ts: 1.0,
      body_bytes: 2048,
    });

    const merged = _merge_session_caches(local, remote);
    expect("ralph" in merged.skill_history).toBe(true);
  });

  it("test_hints_seen_local_empty_remote_non_empty", () => {
    const local = makeCache("med-hs1", 0.0, 1.0);
    const remote = makeCache("med-hs1", 0.0, 2.0);
    remote.hints_seen["fp-abc"] = 5;

    const merged = _merge_session_caches(local, remote);
    expect(merged.hints_seen["fp-abc"]).toBe(5);
  });

  it("test_hints_seen_remote_empty_local_non_empty", () => {
    const local = makeCache("med-hs2", 0.0, 1.0);
    const remote = makeCache("med-hs2", 0.0, 2.0);
    local.hints_seen["fp-xyz"] = 3;

    const merged = _merge_session_caches(local, remote);
    expect(merged.hints_seen["fp-xyz"]).toBe(3);
  });

  it("test_result_cache_remote_empty_local_has_entry", () => {
    const local = makeCache("med-rc1", 0.0, 1.0);
    const remote = makeCache("med-rc1", 0.0, 2.0);
    local.result_cache["src/a.py::my_fn::symbol"] = new ResultCacheEntry({
      file_sha: "aabbcc",
      kind: "symbol",
      result: { text: "def my_fn(): pass" },
      ts: 1.0,
    });

    const merged = _merge_session_caches(local, remote);
    expect("src/a.py::my_fn::symbol" in merged.result_cache).toBe(true);
  });

  it("test_edited_files_local_empty_remote_non_empty", () => {
    const local = makeCache("med-ef1", 0.0, 1.0);
    const remote = makeCache("med-ef1", 0.0, 2.0);
    remote.edited_files["src/utils.py"] = 4;

    const merged = _merge_session_caches(local, remote);
    expect(merged.edited_files["src/utils.py"]).toBe(4);
  });

  it("test_edited_files_remote_empty_local_non_empty", () => {
    const local = makeCache("med-ef2", 0.0, 1.0);
    const remote = makeCache("med-ef2", 0.0, 2.0);
    local.edited_files["src/models.py"] = 2;

    const merged = _merge_session_caches(local, remote);
    expect(merged.edited_files["src/models.py"]).toBe(2);
  });

  it("test_hints_emitted_by_type_local_empty", () => {
    const local = makeCache("med-hbt1", 0.0, 1.0);
    const remote = makeCache("med-hbt1", 0.0, 2.0);
    remote.hints_emitted_by_type["already_read"] = 7;

    const merged = _merge_session_caches(local, remote);
    expect(merged.hints_emitted_by_type["already_read"]).toBe(7);
  });

  it("test_hints_suppressed_by_type_remote_empty", () => {
    const local = makeCache("med-hst1", 0.0, 1.0);
    const remote = makeCache("med-hst1", 0.0, 2.0);
    local.hints_suppressed_by_type["bash_dedup"] = 9;

    const merged = _merge_session_caches(local, remote);
    expect(merged.hints_suppressed_by_type["bash_dedup"]).toBe(9);
  });

  it("test_hint_category_history_local_empty", () => {
    const local = makeCache("med-hch1", 0.0, 1.0);
    const remote = makeCache("med-hch1", 0.0, 2.0);
    remote.hint_category_history["web_dedup"] = [true, false];

    const merged = _merge_session_caches(local, remote);
    expect(merged.hint_category_history["web_dedup"]).toEqual([true, false]);
  });
});

describe("TestMergeNaNTimestamps", () => {
  it("test_last_activity_ts_nan_in_local_uses_remote", () => {
    const local = makeCache("nan-ts1", 0.0, NaN);
    const remote = makeCache("nan-ts1", 0.0, 5.0);

    const merged = _merge_session_caches(local, remote);
    expect(Number.isNaN(merged.last_activity_ts)).toBe(false);
    expect(merged.last_activity_ts).toBe(5.0);
  });

  it("test_last_activity_ts_nan_in_remote_uses_local", () => {
    const local = makeCache("nan-ts2", 0.0, 7.0);
    const remote = makeCache("nan-ts2", 0.0, NaN);

    const merged = _merge_session_caches(local, remote);
    expect(Number.isNaN(merged.last_activity_ts)).toBe(false);
    expect(merged.last_activity_ts).toBe(7.0);
  });

  it("test_hints_emitted_nan_in_local_uses_remote", () => {
    const local = makeCache("nan-he1", 0.0, 1.0);
    const remote = makeCache("nan-he1", 0.0, 1.0);
    local.hints_emitted = NaN;
    remote.hints_emitted = 3;

    const merged = _merge_session_caches(local, remote);
    expect(Number.isNaN(merged.hints_emitted)).toBe(false);
  });

  it("test_last_manifest_ts_nan_in_local", () => {
    const local = makeCache("nan-mt1", 0.0, 1.0);
    const remote = makeCache("nan-mt1", 0.0, 1.0);
    local.last_manifest_ts = NaN;
    local.last_manifest_sha = "local-sha";
    remote.last_manifest_ts = 10.0;
    remote.last_manifest_sha = "remote-sha";

    const merged = _merge_session_caches(local, remote);
    // NaN >= 10.0 is False, so remote branch taken: remote sha kept
    expect(merged.last_manifest_sha).toBe("remote-sha");
    expect(Number.isNaN(merged.last_manifest_ts)).toBe(false);
  });

  it("test_file_entry_last_read_ts_nan", () => {
    const local = makeCache("nan-fe1", 0.0, 1.0);
    const remote = makeCache("nan-fe1", 0.0, 1.0);

    // local entry with NaN last_read_ts
    local.files["src/z.py"] = new FileEntry({
      rel_or_abs: "src/z.py",
      last_read_ts: NaN,
      read_count: 1,
      line_ranges: [],
      symbols_read: [],
    });
    remote.files["src/z.py"] = new FileEntry({
      rel_or_abs: "src/z.py",
      last_read_ts: 5.0,
      read_count: 2,
      line_ranges: [[1, 10]],
      symbols_read: [],
    });

    // Must not raise; remote entry kept because NaN > 5.0 is False
    const merged = _merge_session_caches(local, remote);
    expect("src/z.py" in merged.files).toBe(true);
    expect(Number.isNaN(merged.files["src/z.py"]!.last_read_ts)).toBe(false);
    expect(merged.files["src/z.py"]?.read_count).toBe(2);
  });
});

describe("TestMergeEditedFilesConflicts", () => {
  it("test_multiple_keys_some_shared_some_unique", () => {
    const local = makeCache("ef-multi1", 0.0, 1.0);
    const remote = makeCache("ef-multi1", 0.0, 2.0);

    local.edited_files["shared.py"] = 3;
    local.edited_files["local_only.py"] = 5;

    remote.edited_files["shared.py"] = 7;
    remote.edited_files["remote_only.py"] = 2;

    const merged = _merge_session_caches(local, remote);

    // shared key: max(7, 3) = 7
    expect(merged.edited_files["shared.py"]).toBe(7);
    // local-only key: propagated as-is
    expect(merged.edited_files["local_only.py"]).toBe(5);
    // remote-only key: preserved from remote base
    expect(merged.edited_files["remote_only.py"]).toBe(2);
  });

  it("test_all_keys_conflict_local_wins_each", () => {
    const local = makeCache("ef-multi2", 0.0, 1.0);
    const remote = makeCache("ef-multi2", 0.0, 2.0);

    for (let i = 0; i < 5; i++) {
      local.edited_files[`file${i}.py`] = i + 10;
      remote.edited_files[`file${i}.py`] = i + 1;
    }

    const merged = _merge_session_caches(local, remote);

    for (let i = 0; i < 5; i++) {
      // local value (i+10) is always larger than remote (i+1)
      expect(merged.edited_files[`file${i}.py`]).toBe(i + 10);
    }
  });

  it("test_all_keys_conflict_remote_wins_each", () => {
    const local = makeCache("ef-multi3", 0.0, 1.0);
    const remote = makeCache("ef-multi3", 0.0, 2.0);

    for (let i = 0; i < 5; i++) {
      local.edited_files[`file${i}.py`] = i + 1;
      remote.edited_files[`file${i}.py`] = i + 10;
    }

    const merged = _merge_session_caches(local, remote);

    for (let i = 0; i < 5; i++) {
      // remote value (i+10) is always larger
      expect(merged.edited_files[`file${i}.py`]).toBe(i + 10);
    }
  });

  it("test_zero_counts_preserved", () => {
    const local = makeCache("ef-zero1", 0.0, 1.0);
    const remote = makeCache("ef-zero1", 0.0, 2.0);
    local.edited_files["untouched.py"] = 0;
    remote.edited_files["untouched.py"] = 0;

    const merged = _merge_session_caches(local, remote);
    expect(merged.edited_files["untouched.py"]).toBe(0);
  });

  it("test_large_key_set_no_entries_lost", () => {
    const local = makeCache("ef-large1", 0.0, 1.0);
    const remote = makeCache("ef-large1", 0.0, 2.0);

    for (let i = 0; i < 50; i++) {
      local.edited_files[`local_${i}.py`] = i + 1;
    }
    for (let i = 0; i < 50; i++) {
      remote.edited_files[`remote_${i}.py`] = i + 1;
    }

    const merged = _merge_session_caches(local, remote);
    expect(Object.keys(merged.edited_files).length).toBe(100);
    for (let i = 0; i < 50; i++) {
      expect(merged.edited_files[`local_${i}.py`]).toBe(i + 1);
      expect(merged.edited_files[`remote_${i}.py`]).toBe(i + 1);
    }
  });
});

describe("TestTypedDictDataclassAlignment", () => {
  // Python reflected dataclass fields vs TypedDict __annotations__ at runtime.
  // TS interfaces are erased at runtime, so each entry's live field set
  // (Object.keys of a fully-populated instance) is asserted equal to the wire
  // dict key set declared by the corresponding _*EntryDict interface in
  // session.ts, transcribed here as literal key sets. Intent preserved: a field
  // added to an entry class without a matching wire-dict key (or vice versa)
  // fails this test — no field drift.

  // Wire-dict key sets, transcribed verbatim from the _*EntryDict interfaces in
  // ts/src/token_goat/session.ts.
  const FILE_ENTRY_DICT_KEYS = new Set([
    "rel_or_abs",
    "last_read_ts",
    "read_count",
    "line_ranges",
    "symbols_read",
    "symbols_ts",
    "last_edit_ts",
    "read_mtime_ns",
    "read_size",
    "last_read_call_index",
  ]);
  const BASH_ENTRY_DICT_KEYS = new Set([
    "cmd_sha",
    "cmd_preview",
    "output_id",
    "ts",
    "stdout_bytes",
    "stderr_bytes",
    "exit_code",
    "truncated",
    "run_count",
    "output_sha",
  ]);
  const WEB_ENTRY_DICT_KEYS = new Set([
    "url_sha",
    "url_preview",
    "output_id",
    "ts",
    "body_bytes",
    "status_code",
    "truncated",
    "content_type",
  ]);
  const SKILL_ENTRY_DICT_KEYS = new Set([
    "skill_name",
    "output_id",
    "content_sha",
    "ts",
    "body_bytes",
    "truncated",
    "run_count",
    "source_path",
    "compact_served_count",
  ]);
  const DECISION_ENTRY_DICT_KEYS = new Set(["text", "ts", "tag"]);
  const RESULT_CACHE_ENTRY_DICT_KEYS = new Set(["file_sha", "kind", "result", "ts"]);
  const GREP_ENTRY_DICT_KEYS = new Set(["pattern", "path", "ts", "result_count"]);
  const GLOB_ENTRY_DICT_KEYS = new Set(["pattern", "path", "ts", "result_count"]);

  // Public (non-underscore) own enumerable field names of a constructed entry.
  function dcFields(instance: object): Set<string> {
    return new Set(Object.keys(instance).filter((k) => !k.startsWith("_")));
  }

  it("test_file_entry_matches_file_entry_dict", () => {
    const dc = dcFields(
      new FileEntry({
        rel_or_abs: "x",
        last_read_ts: 0,
        read_count: 0,
        line_ranges: [],
        symbols_read: [],
      }),
    );
    expect(dc).toEqual(FILE_ENTRY_DICT_KEYS);
  });

  it("test_bash_entry_matches_bash_entry_dict", () => {
    const dc = dcFields(
      new BashEntry({
        cmd_sha: "x",
        cmd_preview: "x",
        output_id: "x",
        ts: 0,
        stdout_bytes: 0,
        stderr_bytes: 0,
      }),
    );
    expect(dc).toEqual(BASH_ENTRY_DICT_KEYS);
  });

  it("test_web_entry_matches_web_entry_dict", () => {
    const dc = dcFields(
      new WebEntry({
        url_sha: "x",
        url_preview: "x",
        output_id: "x",
        ts: 0,
        body_bytes: 0,
      }),
    );
    expect(dc).toEqual(WEB_ENTRY_DICT_KEYS);
  });

  it("test_skill_entry_matches_skill_entry_dict", () => {
    const dc = dcFields(
      new SkillEntry({
        skill_name: "x",
        output_id: "x",
        content_sha: "x",
        ts: 0,
        body_bytes: 0,
      }),
    );
    expect(dc).toEqual(SKILL_ENTRY_DICT_KEYS);
  });

  it("test_decision_entry_matches_decision_entry_dict", () => {
    const dc = dcFields(new DecisionEntry({ text: "x", ts: 0 }));
    expect(dc).toEqual(DECISION_ENTRY_DICT_KEYS);
  });

  it("test_result_cache_entry_matches_result_cache_entry_dict", () => {
    const dc = dcFields(
      new ResultCacheEntry({ file_sha: "x", kind: "x", result: {}, ts: 0 }),
    );
    expect(dc).toEqual(RESULT_CACHE_ENTRY_DICT_KEYS);
  });

  it("test_grep_entry_matches_grep_entry_dict", () => {
    const dc = dcFields(new GrepEntry({ pattern: "x", path: null, ts: 0 }));
    expect(dc).toEqual(GREP_ENTRY_DICT_KEYS);
  });

  it("test_glob_entry_matches_glob_entry_dict", () => {
    const dc = dcFields(new GlobEntry({ pattern: "x", path: null, ts: 0 }));
    expect(dc).toEqual(GLOB_ENTRY_DICT_KEYS);
  });

  it("test_session_cache_vs_session_dict_intentional_exclusions", () => {
    // SessionCache <-> _SessionDict alignment with documented intentional
    // exclusions. The dataclass fields are the public (non-underscore) keys of a
    // serialized to_dict() *plus* the runtime-only flags recovery_injected /
    // unavailable that to_dict never emits; the _SessionDict keys are the
    // serialized to_dict() output keys (which include the schema_version /
    // created_by JSON envelope metadata). We derive both from a live instance so
    // any field drift in either direction is caught.
    const cache = _fresh_cache("align-session");
    const wireKeys = new Set(
      Object.keys(cache.to_dict() as Record<string, unknown>).filter(
        (k) => !k.startsWith("_"),
      ),
    );
    // Dataclass fields = all public own fields of the SessionCache instance that
    // are NOT runtime-only-but-serialized helper containers. The persisted
    // (serialized) field set is the wire-dict minus the JSON envelope metadata,
    // plus the two transient flags.
    const td_only_allowed = new Set(["schema_version", "created_by"]);
    const dc_only_allowed = new Set(["recovery_injected", "unavailable"]);

    // Build the dataclass field set from the live instance public fields.
    const dcFieldsSet = new Set(
      Object.keys(cache).filter((k) => !k.startsWith("_")),
    );

    const actual_dc_only = new Set(
      [...dcFieldsSet].filter((k) => !wireKeys.has(k)),
    );
    const actual_td_only = new Set(
      [...wireKeys].filter((k) => !dcFieldsSet.has(k)),
    );

    const unexpected_dc_only = new Set(
      [...actual_dc_only].filter((k) => !dc_only_allowed.has(k)),
    );
    const unexpected_td_only = new Set(
      [...actual_td_only].filter((k) => !td_only_allowed.has(k)),
    );

    expect(unexpected_dc_only).toEqual(new Set());
    expect(unexpected_td_only).toEqual(new Set());
    // Also verify we don't have *fewer* intentional exclusions than expected.
    expect(actual_dc_only).toEqual(dc_only_allowed);
    expect(actual_td_only).toEqual(td_only_allowed);
  });
});

describe("TestSessionReliability", () => {
  it("test_cleanup_stale_tmp_files_removes_orphaned_files", () => {
    const session_id = "test_tmp_cleanup";
    const cache_path = paths.sessionCachePath(session_id);
    paths.ensureDir(path.dirname(cache_path));

    // Create a couple of orphaned .tmp files that would be left by an
    // interrupted atomic_write_text operation.
    const baseName = path.basename(cache_path);
    const parent = path.dirname(cache_path);
    const tmp1 = path.join(parent, `${baseName}.12345.999999999.tmp`);
    const tmp2 = path.join(parent, `${baseName}.67890.888888888.tmp`);
    fs.writeFileSync(tmp1, "stale");
    fs.writeFileSync(tmp2, "stale");
    expect(fs.existsSync(tmp1)).toBe(true);
    expect(fs.existsSync(tmp2)).toBe(true);

    // Call load() which should trigger cleanup
    const loaded = load(session_id);
    expect(loaded.session_id).toBe(session_id);

    // Verify tmp files were cleaned up
    expect(fs.existsSync(tmp1)).toBe(false);
    expect(fs.existsSync(tmp2)).toBe(false);
  });

  it("test_cleanup_stale_tmp_files_tolerates_missing_parent", () => {
    // This should not raise even though the parent doesn't exist
    const nonexistent = "/nonexistent/path/to/session.json";
    _cleanup_stale_tmp_files(nonexistent); // Should be a no-op
  });

  it("test_preserve_corrupt_file_archives_on_json_decode_error", () => {
    const session_id = "test_corrupt_archive";
    const cache_path = paths.sessionCachePath(session_id);
    paths.ensureDir(path.dirname(cache_path));

    // Write an invalid JSON file
    fs.writeFileSync(cache_path, "{invalid json");

    // Load should detect corruption, preserve the file, and return fresh cache
    const loaded = load(session_id);
    expect(loaded.session_id).toBe(session_id);
    expect(loaded.files).toEqual({});

    // Original cache_path should be gone; .corrupt file should exist
    expect(fs.existsSync(cache_path)).toBe(false);
    const baseName = path.basename(cache_path);
    const parent = path.dirname(cache_path);
    const corrupt_files = fs
      .readdirSync(parent)
      .filter((n) => n.startsWith(`${baseName}.corrupt.`));
    expect(corrupt_files.length).toBe(1);
  });

  it("test_preserve_corrupt_file_tolerates_missing_file", () => {
    const nonexistent_path = "/nonexistent/cache.json";
    // Should not raise
    _preserve_corrupt_file(nonexistent_path);
  });

  it("test_load_recovers_from_corrupt_json_with_valid_fallback", () => {
    const session_id = "test_corrupt_recovery";
    const cache_path = paths.sessionCachePath(session_id);
    paths.ensureDir(path.dirname(cache_path));

    // Write invalid JSON
    fs.writeFileSync(cache_path, "{bad");

    // First load should recover and archive
    let loaded1 = load(session_id);
    expect(loaded1.files).toEqual({});

    // Mark a file in the recovered cache and save
    loaded1 = mark_file_read(session_id, "test.py", 0, 10);
    save(loaded1);

    // Load again and verify the file was persisted
    const loaded2 = load(session_id);
    expect("test.py" in loaded2.files).toBe(true);
  });

  it("test_atomic_write_creates_valid_json_on_success", () => {
    const session_id = "test_atomic_write";
    load(session_id);
    const cache = mark_file_read(session_id, "file.py", 1, 50);
    save(cache);

    const cache_path = paths.sessionCachePath(session_id);
    expect(fs.existsSync(cache_path)).toBe(true);

    // Verify the file contains valid JSON
    const raw = fs.readFileSync(cache_path, "utf8");
    const data = JSON.parse(raw) as Record<string, unknown>;
    expect(data["session_id"]).toBe(session_id);
    expect("file.py" in ((data["files"] as Record<string, unknown>) ?? {})).toBe(true);
  });

  it("test_load_handles_schema_version_mismatch", () => {
    const session_id = "test_schema_mismatch";
    const cache_path = paths.sessionCachePath(session_id);
    paths.ensureDir(path.dirname(cache_path));

    // Write a cache with a bogus schema version
    const bad_cache = {
      schema_version: 999,
      session_id,
      started_ts: Date.now() / 1000,
      last_activity_ts: Date.now() / 1000,
      created_by: "test",
      files: {},
      greps: [],
      edited_files: {},
      result_cache: {},
      bash_history: {},
      glob_history: [],
      web_history: {},
      skill_history: {},
      decisions: [],
      snapshot_shas: {},
      hints_seen: {},
      bash_dedup_emitted_ids: [],
      hints_emitted: 0,
      hints_ignored: 0,
      structured_hints_emitted: 0,
      index_only_hints_emitted: 0,
      hints_emitted_by_type: {},
      hints_suppressed_by_type: {},
      recent_hints: [],
      last_manifest_sha: "",
      last_manifest_ts: 0.0,
      version: 0,
      hint_category_history: {},
      cwd: null,
    };
    fs.writeFileSync(cache_path, JSON.stringify(bad_cache));

    // Load should drop the cache and return fresh
    const loaded = load(session_id);
    expect(loaded.files).toEqual({});
    // Fresh cache starts at version 0
    expect(loaded.version).toBe(0);
  });

  it("test_tmp_cleanup_and_corrupt_preservation_end_to_end", () => {
    const session_id = "test_e2e_reliability";
    const cache_path = paths.sessionCachePath(session_id);
    paths.ensureDir(path.dirname(cache_path));

    // Step 1: Create a cache with some data
    const initial = mark_file_read(session_id, "original.py", 0, 50);
    save(initial);
    expect(fs.existsSync(cache_path)).toBe(true);

    // Step 2: Simulate an interrupted write by creating an orphaned .tmp file
    const baseName = path.basename(cache_path);
    const parent = path.dirname(cache_path);
    const tmp_orphan = path.join(parent, `${baseName}.11111.99999999.tmp`);
    fs.writeFileSync(tmp_orphan, "abandoned write content");
    expect(fs.existsSync(tmp_orphan)).toBe(true);

    // Step 3: Corrupt the cache file
    fs.writeFileSync(cache_path, "{this is not valid json]");

    // Step 4: Load should clean up .tmp, archive corrupt file, and recover
    let recovered = load(session_id);
    expect(recovered.session_id).toBe(session_id);
    expect(recovered.files).toEqual({}); // Fresh start (corrupt file deleted)

    // Step 5: Verify cleanup happened
    expect(fs.existsSync(tmp_orphan)).toBe(false);
    expect(fs.existsSync(cache_path)).toBe(false);
    const corrupt_archives = fs
      .readdirSync(parent)
      .filter((n) => n.startsWith(`${baseName}.corrupt.`));
    expect(corrupt_archives.length).toBe(1);

    // Step 6: Verify we can continue using the recovered cache
    recovered = mark_file_read(session_id, "recovered.py", 0, 100);
    save(recovered);
    expect(fs.existsSync(cache_path)).toBe(true);
    expect("recovered.py" in recovered.files).toBe(true);
  });
});

describe("TestGrepResultHashes", () => {
  it("test_grep_result_hashes_basic_roundtrip", () => {
    const session_id = "test_grep_hashes";
    const cache = load(session_id);

    // Record a hash
    cache.record_grep_result_hash("abc12345", "def foo");
    expect(cache.has_grep_result_hash("abc12345")).toBe(true);
    expect(cache.get_grep_result_pattern("abc12345")).toBe("def foo");

    // Save and reload
    save(cache);
    const loaded = load(session_id);
    expect(loaded.has_grep_result_hash("abc12345")).toBe(true);
    expect(loaded.get_grep_result_pattern("abc12345")).toBe("def foo");
  });

  it("test_grep_result_hashes_missing_hash", () => {
    const cache = load("test_missing_hash");
    expect(cache.has_grep_result_hash("nonexistent")).toBe(false);
    expect(cache.get_grep_result_pattern("nonexistent")).toBeNull();
  });

  it("test_grep_result_hashes_fifo_eviction", () => {
    const cache = load("test_fifo_eviction");
    const max_cap = GREP_RESULT_HASHES_MAX;

    // Fill up to cap
    for (let i = 0; i < max_cap; i++) {
      cache.record_grep_result_hash(`hash${String(i).padStart(3, "0")}`, `pattern${i}`);
    }
    expect(Object.keys(cache.grep_result_hashes).length).toBe(max_cap);

    // Add one more to trigger eviction
    cache.record_grep_result_hash("hash_overflow", "pattern_overflow");

    // Should have evicted oldest (hash000)
    expect(Object.keys(cache.grep_result_hashes).length).toBeLessThanOrEqual(max_cap);
    expect(cache.has_grep_result_hash("hash000")).toBe(false);
    expect(cache.has_grep_result_hash("hash_overflow")).toBe(true);
  });

  it("test_grep_result_hashes_updates_last_activity_ts", () => {
    // Python patched time.time so the second call returns a reliably larger
    // value; record_grep_result_hash uses Date.now()/1000 in TS, so we drive
    // Date.now via a monotonic stub instead.
    let ts = 1_700_000_000_000.0;
    const spy = vi.spyOn(Date, "now").mockImplementation(() => {
      ts += 1000.0;
      return ts;
    });
    try {
      const cache = load("test_activity_ts");
      const old_ts = cache.last_activity_ts;

      cache.record_grep_result_hash("test_hash", "test_pattern");
      expect(cache.last_activity_ts).toBeGreaterThan(old_ts);
    } finally {
      spy.mockRestore();
    }
  });

  it("test_grep_result_hashes_same_pattern_overwrite", () => {
    const cache = load("test_same_pattern");

    cache.record_grep_result_hash("hash1", "pattern_a");
    expect(cache.get_grep_result_pattern("hash1")).toBe("pattern_a");

    // Record same hash with different pattern — updates to latest
    cache.record_grep_result_hash("hash1", "pattern_b");
    expect(cache.get_grep_result_pattern("hash1")).toBe("pattern_b");
  });

  it("test_grep_result_hashes_multiple_patterns", () => {
    const cache = load("test_multiple");

    cache.record_grep_result_hash("hash1", "pattern1");
    cache.record_grep_result_hash("hash2", "pattern2");
    cache.record_grep_result_hash("hash3", "pattern3");

    expect(cache.get_grep_result_pattern("hash1")).toBe("pattern1");
    expect(cache.get_grep_result_pattern("hash2")).toBe("pattern2");
    expect(cache.get_grep_result_pattern("hash3")).toBe("pattern3");
  });

  it("test_grep_result_hashes_from_dict_missing_field", () => {
    const session_id = "test_from_dict_missing";
    const cache_path = paths.sessionCachePath(session_id);
    paths.ensureDir(path.dirname(cache_path));

    // Write cache without grep_result_hashes (old schema)
    const old_cache = {
      schema_version: SESSION_SCHEMA_VERSION,
      session_id,
      started_ts: Date.now() / 1000,
      last_activity_ts: Date.now() / 1000,
      created_ts: Date.now() / 1000,
      created_by: "test",
      files: {},
      greps: [],
      edited_files: {},
      result_cache: {},
      bash_history: {},
      glob_history: [],
      web_history: {},
      skill_history: {},
      decisions: [],
      snapshot_shas: {},
      hints_seen: {},
      bash_dedup_emitted_ids: [],
      hints_emitted: 0,
      hints_ignored: 0,
      structured_hints_emitted: 0,
      index_only_hints_emitted: 0,
      hints_emitted_by_type: {},
      hints_suppressed_by_type: {},
      recent_hints: [],
      last_manifest_sha: "",
      last_manifest_ts: 0.0,
      version: 0,
      hint_category_history: {},
      image_shrink_count: {},
      file_access_counts: {},
      symbol_access_counts: {},
      cwd: null,
      // grep_result_hashes deliberately omitted
    };
    fs.writeFileSync(cache_path, JSON.stringify(old_cache));

    // Load should create empty grep_result_hashes
    const loaded = load(session_id);
    expect(loaded.grep_result_hashes).toEqual({});
    expect(loaded.has_grep_result_hash("anything")).toBe(false);
  });

  it("test_grep_result_hashes_merge_cas", () => {
    const session_id = "test_merge_cas";

    // Create and save local version
    const local = load(session_id);
    local.grep_result_hashes["hash_local"] = "pattern_local";

    // Simulate remote version with different hashes
    const remote = new SessionCache({
      session_id,
      started_ts: Date.now() / 1000,
      last_activity_ts: Date.now() / 1000,
    });
    remote.grep_result_hashes["hash_remote"] = "pattern_remote";
    remote.version = 2;

    // Merge local into remote
    const merged = _merge_session_caches(local, remote);

    // Both hashes should exist after merge
    expect(merged.has_grep_result_hash("hash_local")).toBe(true);
    expect(merged.has_grep_result_hash("hash_remote")).toBe(true);
    expect(merged.get_grep_result_pattern("hash_local")).toBe("pattern_local");
    expect(merged.get_grep_result_pattern("hash_remote")).toBe("pattern_remote");
  });

  it("test_grep_result_hashes_invalidates_json_cache", () => {
    const cache = load("test_json_cache");

    // Prime the json cache
    const json_before = cache.to_json();
    expect(cache._json_cache).not.toBeNull();

    // Record a hash should invalidate cache
    cache.record_grep_result_hash("hash1", "pattern1");
    expect(cache._json_cache).toBeNull();

    // Next to_json should be different
    const json_after = cache.to_json();
    expect(json_before).not.toBe(json_after);
    expect(json_after.includes('"grep_result_hashes"')).toBe(true);
  });
});
