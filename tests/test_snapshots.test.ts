/**
 * Tests for the per-session file-content snapshot store + diff-aware re-read.
 *
 * 1:1 port of tests/test_snapshots.py (the snapshots-owned subset).
 *
 * Test-seam mapping (Python → TS):
 *  - tmp_data_dir fixture → setup.ts's setDataDirOverride already gives each
 *    test a throwaway data dir; snapshot files live under it automatically.
 *  - tmp_path fixture → fs.mkdtempSync under the OS tmp dir for the few tests
 *    that need real source files on disk.
 *  - monkeypatch.setattr(snapshots, "MAX_SNAPSHOTS_PER_SESSION", N) → the TS
 *    export is a `const`, so the eviction-cap tests pass an explicit cap into a
 *    direct `store` loop is not possible; instead we override the module binding
 *    via vi.spyOn is also impossible (const). The Python test relies on shrinking
 *    the cap; in TS the cap is a const, so we reproduce the SAME observable
 *    eviction by storing MAX_SNAPSHOTS_PER_SESSION + k files and asserting the
 *    oldest k were evicted. (See the per-test comments.)
 *  - os.utime(path, (ts, ts)) → fs.utimesSync(path, ts, ts) (seconds).
 *  - session.set_snapshot_sha(...) → snapshots.setSnapshotShaLookup(fn): the
 *    session module is not ported in this layer, so the integrity-gate tests
 *    install the recorded-SHA lookup directly through the wiring seam. This
 *    exercises the exact integrity path the Python test does.
 *  - monkeypatch.setattr(_tg_paths, "atomic_write_bytes", spy) → vi.spyOn on
 *    the paths module's atomicWriteBytes.
 *  - monkeypatch.setattr(Path, "read_bytes", fail_read) → vi.spyOn(fs,
 *    "readFileSync") with a one-shot throwing implementation.
 *
 * Deferred classes (depend on not-yet-ported modules — written as it.skip):
 *  - TestDiffHint                    → hints / session (Layer N)
 *  - TestPostReadSnapshots           → hooks_read / session (Layer N)
 *  - TestPredictiveSnapshot          → hooks_edit (Layer N)
 *  - TestPredictivePrefetchAttribution → hooks_edit (Layer N)
 *  - TestSymbolChangedIntegrity::test_symbol_changed_suppressed_on_corrupted_snapshot
 *    is portable via the setSnapshotShaLookup seam and IS ported (not skipped).
 */
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";

import { afterEach, describe, expect, it, vi } from "vitest";

import * as snapshots from "../src/token_goat/snapshots.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function sha256hex(buf: Buffer): string {
  return createHash("sha256").update(buf).digest("hex");
}

// ===========================================================================
// TestSnapshotStore
// ===========================================================================

describe("TestSnapshotStore", () => {
  it("test_store_and_load_round_trip", () => {
    const result = snapshots.store("sess1", "/tmp/foo.py", Buffer.from("hello\nworld\n"));
    expect(result).not.toBeNull();
    const loaded = snapshots.load("sess1", "/tmp/foo.py");
    expect(loaded).toEqual(Buffer.from("hello\nworld\n"));
  });

  it("test_oversized_file_not_stored", () => {
    const big = Buffer.alloc(snapshots.MAX_SNAPSHOT_BYTES + 1, "X");
    const result = snapshots.store("sess2", "/tmp/big.py", big);
    expect(result).toBeNull();
    expect(snapshots.load("sess2", "/tmp/big.py")).toBeNull();
  });

  it("test_path_with_traversal_chars_normalised", () => {
    const result = snapshots.store("sess3", "../../etc/passwd", Buffer.from("x"));
    expect(result).not.toBeNull();
    expect(path.basename(path.dirname(result!.path)).startsWith("sess3")).toBe(true);
  });

  it("test_cleanup_session_removes_files", () => {
    snapshots.store("sess4", "/tmp/a.py", Buffer.from("a"));
    snapshots.store("sess4", "/tmp/b.py", Buffer.from("b"));
    const removed = snapshots.cleanup_session("sess4");
    expect(removed).toBe(2);
    expect(snapshots.load("sess4", "/tmp/a.py")).toBeNull();
  });

  it("test_eviction_keeps_per_session_under_cap", () => {
    // Python monkeypatches MAX_SNAPSHOTS_PER_SESSION to 3. The TS export is a
    // const, so we reproduce the same observable eviction at the real cap:
    // store CAP + 2 distinct files, stamping strictly-ascending mtimes, and
    // assert the two oldest are evicted while the most recent survives.
    const cap = snapshots.MAX_SNAPSHOTS_PER_SESSION;
    const total = cap + 2;
    const base_ts = Date.now() / 1000 - 1000; // well in the past, ascending
    for (let i = 0; i < total; i++) {
      const result = snapshots.store("sess5", `/tmp/f${i}.py`, Buffer.from(`v${i}`));
      expect(result).not.toBeNull();
      const ts = base_ts + i;
      fs.utimesSync(result!.path, ts, ts);
    }
    // The two oldest (f0, f1) must be evicted; the most-recently-inserted
    // survives.
    expect(snapshots.load("sess5", "/tmp/f0.py")).toBeNull();
    expect(snapshots.load("sess5", "/tmp/f1.py")).toBeNull();
    expect(snapshots.load("sess5", `/tmp/f${total - 1}.py`)).toEqual(
      Buffer.from(`v${total - 1}`),
    );
  });
});

// ===========================================================================
// TestDiffHint — DEFERRED (hints / session not yet ported)
// ===========================================================================

describe("TestDiffHint", () => {
  // PORT: deferred to Layer N (hints + session modules not yet ported)
  it.skip("test_no_snapshot_means_no_hint", () => {});
  it.skip("test_identical_snapshot_means_no_hint", () => {});
  it.skip("test_meaningful_diff_emits_hint", () => {});
  it.skip("test_huge_diff_suppressed", () => {});
  it.skip("test_diff_hint_suppressed_on_snapshot_integrity_mismatch", () => {});
  it.skip("test_diff_hint_still_fires_when_sha_unrecorded", () => {});
});

// ===========================================================================
// TestSnapshotLoadIntegrity
// ===========================================================================

describe("TestSnapshotLoadIntegrity", () => {
  it("test_load_returns_bytes_when_expected_sha_matches", () => {
    const content = Buffer.from("def foo(): pass\n");
    const result = snapshots.store("integ1", "/tmp/match.py", content);
    expect(result).not.toBeNull();
    const loaded = snapshots.load("integ1", "/tmp/match.py", {
      expected_sha: result!.content_sha,
    });
    expect(loaded).toEqual(content);
  });

  it("test_load_returns_none_on_sha_mismatch", () => {
    const result = snapshots.store("integ2", "/tmp/mismatch.py", Buffer.from("original\n"));
    expect(result).not.toBeNull();
    const loaded = snapshots.load("integ2", "/tmp/mismatch.py", {
      expected_sha: "0".repeat(64),
    });
    expect(loaded).toBeNull();
  });

  it("test_load_without_expected_sha_skips_integrity_check", () => {
    snapshots.store("integ3", "/tmp/legacy.py", Buffer.from("hello\n"));
    const loaded = snapshots.load("integ3", "/tmp/legacy.py");
    expect(loaded).toEqual(Buffer.from("hello\n"));
  });
});

// ===========================================================================
// TestPostReadSnapshots — DEFERRED (hooks_read / session not yet ported)
// ===========================================================================

describe("TestPostReadSnapshots", () => {
  // PORT: deferred to Layer N (hooks_read + session modules not yet ported)
  it.skip("test_post_read_captures_snapshot", () => {});
  it.skip("test_post_read_oversized_skips_snapshot", () => {});
});

// ===========================================================================
// TestPredictiveSnapshot — DEFERRED (hooks_edit not yet ported)
// ===========================================================================

describe("TestPredictiveSnapshot", () => {
  // PORT: deferred to Layer N (hooks_edit module not yet ported)
  it.skip("test_relative_import_creates_snapshot", () => {});
  it.skip("test_non_python_file_no_snapshot", () => {});
  it.skip("test_cap_at_three_imports", () => {});
  it.skip("test_imports_below_type_checking_block_picked_up", () => {});
  it.skip("test_multiline_parenthesized_import", () => {});
  it.skip("test_duplicate_import_paths_deduped_before_cap", () => {});
});

// ===========================================================================
// TestSnapshotKind
// ===========================================================================

describe("TestSnapshotKind", () => {
  it("test_default_kind_is_read", () => {
    snapshots.store("kind1", "/tmp/k1.py", Buffer.from("hello\n"));
    expect(snapshots.load_kind("kind1", "/tmp/k1.py")).toBe("read");
  });

  it("test_predictive_kind_stored_and_loaded", () => {
    snapshots.store("kind2", "/tmp/k2.py", Buffer.from("hi\n"), { kind: "predictive" });
    expect(snapshots.load_kind("kind2", "/tmp/k2.py")).toBe("predictive");
  });

  it("test_unknown_kind_falls_back_to_read", () => {
    snapshots.store("kind3", "/tmp/k3.py", Buffer.from("x"), { kind: "bogus-value" });
    expect(snapshots.load_kind("kind3", "/tmp/k3.py")).toBe("read");
  });

  it("test_load_kind_missing_snapshot_returns_none", () => {
    expect(snapshots.load_kind("kind4-none", "/tmp/never.py")).toBeNull();
  });

  it("test_load_kind_missing_sidecar_returns_none", () => {
    snapshots.store("kind5", "/tmp/k5.py", Buffer.from("x"), { kind: "predictive" });
    const p = snapshots.snapshot_path("kind5", "/tmp/k5.py");
    expect(p).not.toBeNull();
    const sidecar = p! + ".kind";
    expect(fs.existsSync(sidecar)).toBe(true);
    fs.unlinkSync(sidecar);
    expect(snapshots.load_kind("kind5", "/tmp/k5.py")).toBeNull();
    // The snapshot itself is still loadable — only the attribution is lost.
    expect(snapshots.load("kind5", "/tmp/k5.py")).toEqual(Buffer.from("x"));
  });

  it("test_cleanup_session_removes_sidecars", () => {
    snapshots.store("kind6", "/tmp/k6.py", Buffer.from("a"), { kind: "predictive" });
    const p = snapshots.snapshot_path("kind6", "/tmp/k6.py");
    expect(p).not.toBeNull();
    const sidecar = p! + ".kind";
    expect(fs.existsSync(sidecar)).toBe(true);
    snapshots.cleanup_session("kind6");
    expect(fs.existsSync(sidecar)).toBe(false);
    expect(snapshots.load_kind("kind6", "/tmp/k6.py")).toBeNull();
  });

  it("test_eviction_drops_orphan_sidecar", () => {
    // Python monkeypatches MAX_SNAPSHOTS_PER_SESSION to 2. The TS export is a
    // const; we reproduce the same in-band orphan cleanup at the real cap by
    // storing CAP + 2 predictive snapshots with ascending mtimes, then assert
    // that every surviving .kind sidecar still has a matching .bin (no orphan).
    const cap = snapshots.MAX_SNAPSHOTS_PER_SESSION;
    const total = cap + 2;
    const base_ts = Date.now() / 1000 - 1000;
    for (let i = 0; i < total; i++) {
      const result = snapshots.store("kind7-evict", `/tmp/ke${i}.py`, Buffer.from(`v${i}`), {
        kind: "predictive",
      });
      expect(result).not.toBeNull();
      const ts = base_ts + i;
      fs.utimesSync(result!.path, ts, ts);
      const sidecar = result!.path + ".kind";
      if (fs.existsSync(sidecar)) {
        fs.utimesSync(sidecar, ts, ts);
      }
    }
    const sess_dir = snapshots._session_dir("kind7-evict");
    expect(sess_dir).not.toBeNull();
    const names = fs.readdirSync(sess_dir!);
    const kinds = names.filter((n) => n.endsWith(".kind")).sort();
    const bins = names.filter((n) => n.endsWith(".bin")).sort();
    const bin_stems = new Set(bins.map((p) => p.slice(0, p.length - ".bin".length)));
    const kind_stems = new Set(kinds.map((p) => p.slice(0, p.length - ".bin.kind".length)));
    // Every kind sidecar must have a matching .bin counterpart.
    for (const ks of kind_stems) {
      expect(bin_stems.has(ks)).toBe(true);
    }
  });
});

// ===========================================================================
// TestPredictivePrefetchAttribution — DEFERRED (hooks_edit not yet ported)
// ===========================================================================

describe("TestPredictivePrefetchAttribution", () => {
  // PORT: deferred to Layer N (hooks_edit module not yet ported)
  it.skip("test_predictive_snapshot_kind_is_predictive", () => {});
});

// ===========================================================================
// TestSnapshotContentHashDedup
// ===========================================================================

describe("TestSnapshotContentHashDedup", () => {
  it("test_second_store_same_content_skips_write", () => {
    const content = Buffer.from("def foo(): pass\n");
    const sid = "dedup-01";
    const fp = "/proj/src/foo.py";

    const r1 = snapshots.store(sid, fp, content);
    expect(r1).not.toBeNull();

    // Backdate the file's mtime by 2 s so any subsequent write is unambiguously
    // detectable without a real sleep.
    const past_ts = fs.statSync(r1!.path).mtimeMs / 1000 - 2.0;
    fs.utimesSync(r1!.path, past_ts, past_ts);
    const mtime1 = fs.statSync(r1!.path).mtimeMs;

    const r2 = snapshots.store(sid, fp, content);
    expect(r2).not.toBeNull();
    expect(r2!.content_sha).toBe(r1!.content_sha);
    const mtime2 = fs.statSync(r2!.path).mtimeMs;
    expect(mtime1).toBe(mtime2);
  });

  it("test_different_content_rewrites_snapshot", () => {
    const content_v1 = Buffer.from("def foo(): return 1\n");
    const content_v2 = Buffer.from("def foo(): return 2\n");
    const sid = "dedup-02";
    const fp = "/proj/src/bar.py";

    const r1 = snapshots.store(sid, fp, content_v1);
    expect(r1).not.toBeNull();

    const r2 = snapshots.store(sid, fp, content_v2);
    expect(r2).not.toBeNull();
    expect(r2!.content_sha).not.toBe(r1!.content_sha);
    expect(snapshots.load(sid, fp)).toEqual(content_v2);
  });

  it("test_first_store_writes_when_no_existing_snapshot", () => {
    const content = Buffer.from("brand new content\n");
    const sid = "dedup-03";
    const fp = "/proj/src/new_file.py";
    const r = snapshots.store(sid, fp, content);
    expect(r).not.toBeNull();
    expect(snapshots.load(sid, fp)).toEqual(content);
  });

  it("test_returns_correct_sha_even_on_cache_hit", () => {
    const content = Buffer.from("class Baz:\n    pass\n");
    const sid = "dedup-04";
    const fp = "/proj/src/baz.py";
    snapshots.store(sid, fp, content);
    const r = snapshots.store(sid, fp, content);
    expect(r).not.toBeNull();
    const expected_sha = sha256hex(content);
    expect(r!.content_sha).toBe(expected_sha);
  });

  it("test_read_error_on_existing_falls_through_to_write", () => {
    const content = Buffer.from("def boo(): pass\n");
    const sid = "dedup-05";
    const fp = "/proj/src/boo.py";
    const r1 = snapshots.store(sid, fp, content);
    expect(r1).not.toBeNull();

    // Simulate a read error on the second call's dedup read. Fail exactly once
    // (the first readFileSync), then forward to the captured original so
    // atomic_write etc. still work. Capture the original BEFORE spying so the
    // forward does not re-enter the spy (infinite recursion).
    const origReadFileSync = fs.readFileSync as unknown as (...a: unknown[]) => unknown;
    let callCount = 0;
    const spy = vi.spyOn(fs, "readFileSync").mockImplementation(((
      file: fs.PathOrFileDescriptor,
      ...rest: unknown[]
    ) => {
      callCount += 1;
      if (callCount === 1) {
        const err = new Error("simulated read error") as NodeJS.ErrnoException;
        err.code = "EACCES";
        throw err;
      }
      return origReadFileSync(file, ...rest);
    }) as typeof fs.readFileSync);

    try {
      const r2 = snapshots.store(sid, fp, content);
      expect(r2).not.toBeNull();
    } finally {
      spy.mockRestore();
    }
  });
});

// ===========================================================================
// TestSnapshotTruncation
// ===========================================================================

describe("TestSnapshotTruncation", () => {
  it("test_small_file_stored_verbatim", () => {
    const content = Buffer.alloc(snapshots.SNAPSHOT_TRUNCATE_BYTES, "x");
    const sid = "trunc-small-01";
    const fp = "/proj/small.py";
    const r = snapshots.store(sid, fp, content);
    expect(r).not.toBeNull();
    const loaded = snapshots.load(sid, fp);
    expect(loaded).toEqual(content);
  });

  it("test_large_file_truncated_with_marker", () => {
    const orig_len = snapshots.SNAPSHOT_TRUNCATE_BYTES + 1024;
    const content = Buffer.alloc(orig_len, "A");
    const sid = "trunc-large-01";
    const fp = "/proj/large.py";
    const r = snapshots.store(sid, fp, content);
    expect(r).not.toBeNull();
    const loaded = snapshots.load(sid, fp);
    expect(loaded).not.toBeNull();
    expect(loaded!.length).toBeLessThan(orig_len);
    expect(loaded!.subarray(0, snapshots.SNAPSHOT_TRUNCATE_BYTES)).toEqual(
      content.subarray(0, snapshots.SNAPSHOT_TRUNCATE_BYTES),
    );
    expect(loaded!.includes(Buffer.from(String(orig_len)))).toBe(true);
  });

  it("test_truncated_snapshot_integrity_check_consistent", () => {
    const orig_len = snapshots.SNAPSHOT_TRUNCATE_BYTES + 512;
    const content = Buffer.alloc(orig_len, "B");
    const sid = "trunc-integ-01";
    const fp = "/proj/trunc_integ.py";
    const r = snapshots.store(sid, fp, content);
    expect(r).not.toBeNull();
    const loaded = snapshots.load(sid, fp, { expected_sha: r!.content_sha });
    expect(loaded).not.toBeNull();
    const original_sha = sha256hex(content);
    if (original_sha !== r!.content_sha) {
      const bad_load = snapshots.load(sid, fp, { expected_sha: original_sha });
      expect(bad_load).toBeNull();
    }
  });

  it("test_oversized_file_still_skipped", () => {
    const content = Buffer.alloc(snapshots.MAX_SNAPSHOT_BYTES + 1, "Z");
    const sid = "trunc-over-01";
    const fp = "/proj/toobig.py";
    const r = snapshots.store(sid, fp, content);
    expect(r).toBeNull();
    expect(snapshots.load(sid, fp)).toBeNull();
  });
});

// ===========================================================================
// TestSymbolChangedIntegrity
// ===========================================================================

describe("TestSymbolChangedIntegrity", () => {
  afterEach(() => {
    snapshots.setSnapshotShaLookup(undefined);
  });

  it("test_symbol_changed_returns_true_when_changed", () => {
    const body = "def foo():\n    return 1\n";
    const filler = "# filler\n".repeat(20);
    const old_text = filler + body;
    const sid = "sym-integ-01";
    const fp = "/proj/sym_test.py";
    snapshots.store(sid, fp, Buffer.from(old_text));
    // Symbol is at lines 21-22 (1-based) in the original.
    const result = snapshots.symbol_changed_since_read(
      sid,
      fp,
      "foo",
      21,
      22,
      "def foo():\n    return 99\n",
    );
    expect(result).toBe(true);
  });

  it("test_symbol_changed_returns_false_when_unchanged", () => {
    const body = "def bar():\n    pass\n";
    const filler = "# filler\n".repeat(10);
    const text = filler + body;
    const sid = "sym-integ-02";
    const fp = "/proj/sym_unch.py";
    snapshots.store(sid, fp, Buffer.from(text));
    const result = snapshots.symbol_changed_since_read(sid, fp, "bar", 11, 12, body);
    expect(result).toBe(false);
  });

  it("test_symbol_changed_suppressed_on_corrupted_snapshot", () => {
    const body = "def baz():\n    return 42\n";
    const filler = "# filler\n".repeat(20);
    const orig_text = filler + body;
    const sid = "sym-integ-corrupt-01";
    const fp = "/proj/sym_corrupt.py";

    const result = snapshots.store(sid, fp, Buffer.from(orig_text));
    expect(result).not.toBeNull();
    // Record the sha via the lookup seam so the integrity gate activates
    // (session.set_snapshot_sha analogue — the session module is not ported).
    snapshots.setSnapshotShaLookup((s, f) =>
      s === sid && f === fp ? result!.content_sha : undefined,
    );

    // Tamper with the snapshot: write completely different content to disk.
    const snap_path = snapshots.snapshot_path(sid, fp);
    expect(snap_path).not.toBeNull();
    const corrupted = Buffer.from("GARBAGE DATA ".repeat(50));
    fs.writeFileSync(snap_path!, corrupted);

    const changed = snapshots.symbol_changed_since_read(sid, fp, "baz", 21, 22, body);
    expect(changed).toBe(false);
  });

  it("test_symbol_changed_without_recorded_sha_uses_legacy_path", () => {
    const body = "def legacy():\n    return 0\n";
    const filler = "# filler\n".repeat(10);
    const old_text = filler + body;
    const sid = "sym-legacy-01";
    const fp = "/proj/sym_legacy.py";
    snapshots.store(sid, fp, Buffer.from(old_text));
    // Note: deliberately do NOT install a sha lookup here.
    const result = snapshots.symbol_changed_since_read(sid, fp, "legacy", 11, 12, body);
    expect(result).toBe(false);
  });
});

// ===========================================================================
// TestStoreContentHashDedup
// ===========================================================================

describe("TestStoreContentHashDedup", () => {
  it("test_same_content_skips_write", () => {
    // Python spies on paths.atomic_write_bytes to count writes. ES module
    // namespace exports are non-configurable, so vi.spyOn cannot redirect the
    // intra-module `paths.atomicWriteBytes` call snapshots.store makes (the same
    // limitation documented in test_web_cache.test.ts). We drive the SAME
    // observable — "no new write for unchanged content" — via the snapshot
    // file's mtime: a skipped write leaves it untouched.
    const content = Buffer.from("def foo():\n    pass\n");
    const r1 = snapshots.store("dedup-01", "/p/file.py", content);
    expect(r1).not.toBeNull();

    const past_ts = fs.statSync(r1!.path).mtimeMs / 1000 - 2.0;
    fs.utimesSync(r1!.path, past_ts, past_ts);
    const mtime1 = fs.statSync(r1!.path).mtimeMs;

    const r2 = snapshots.store("dedup-01", "/p/file.py", content);
    expect(r2).not.toBeNull();
    expect(r2!.content_sha).toBe(r1!.content_sha);
    const mtime2 = fs.statSync(r2!.path).mtimeMs;
    expect(mtime1).toBe(mtime2); // no new write for unchanged content
  });

  it("test_changed_content_writes_through", () => {
    const r1 = snapshots.store("dedup-02", "/p/file.py", Buffer.from("version 1"));
    const r2 = snapshots.store("dedup-02", "/p/file.py", Buffer.from("version 2"));
    expect(r1).not.toBeNull();
    expect(r2).not.toBeNull();
    expect(r1!.content_sha).not.toBe(r2!.content_sha);
    expect(snapshots.load("dedup-02", "/p/file.py")).toEqual(Buffer.from("version 2"));
  });
});

// ===========================================================================
// TestStoreTruncation
// ===========================================================================

describe("TestStoreTruncation", () => {
  it("test_oversized_body_stored_truncated", () => {
    const content = Buffer.alloc(snapshots.SNAPSHOT_TRUNCATE_BYTES + 512, "A");
    const r = snapshots.store("trunc-01", "/p/big.py", content);
    expect(r).not.toBeNull();
    const stored = snapshots.load("trunc-01", "/p/big.py");
    expect(stored).not.toBeNull();
    expect(stored!.length).toBeLessThan(content.length);
    expect(stored!.includes(Buffer.from("<snapshot truncated at"))).toBe(true);
    expect(stored!.subarray(0, snapshots.SNAPSHOT_TRUNCATE_BYTES)).toEqual(
      content.subarray(0, snapshots.SNAPSHOT_TRUNCATE_BYTES),
    );
  });

  it("test_file_exactly_at_threshold_not_truncated", () => {
    const content = Buffer.alloc(snapshots.SNAPSHOT_TRUNCATE_BYTES, "B");
    const r = snapshots.store("trunc-02", "/p/exact.py", content);
    expect(r).not.toBeNull();
    const stored = snapshots.load("trunc-02", "/p/exact.py");
    expect(stored).toEqual(content);
    expect(stored!.includes(Buffer.from("<snapshot truncated at"))).toBe(false);
  });
});

// ===========================================================================
// TestLoadIntegrityCheck
// ===========================================================================

describe("TestLoadIntegrityCheck", () => {
  it("test_sha_mismatch_returns_none", () => {
    const r = snapshots.store("integ-01", "/p/file.py", Buffer.from("original"));
    expect(r).not.toBeNull();
    const result = snapshots.load("integ-01", "/p/file.py", { expected_sha: "0".repeat(64) });
    expect(result).toBeNull();
  });

  it("test_correct_sha_returns_content", () => {
    const content = Buffer.from("trusted content");
    const r = snapshots.store("integ-02", "/p/file.py", content);
    expect(r).not.toBeNull();
    const result = snapshots.load("integ-02", "/p/file.py", { expected_sha: r!.content_sha });
    expect(result).toEqual(content);
  });

  it("test_none_sha_skips_integrity_check", () => {
    const content = Buffer.from("no check");
    snapshots.store("integ-03", "/p/file.py", content);
    const result = snapshots.load("integ-03", "/p/file.py", { expected_sha: null });
    expect(result).toEqual(content);
  });
});

// ===========================================================================
// TestLoadKindEdgeCases
// ===========================================================================

describe("TestLoadKindEdgeCases", () => {
  it("test_missing_sidecar_returns_none", () => {
    const r = snapshots.store("kind-01", "/p/file.py", Buffer.from("content"));
    expect(r).not.toBeNull();
    const sidecar = r!.path + ".kind";
    if (fs.existsSync(sidecar)) {
      fs.unlinkSync(sidecar);
    }
    expect(snapshots.load_kind("kind-01", "/p/file.py")).toBeNull();
  });

  it("test_invalid_bytes_sidecar_returns_none", () => {
    const r = snapshots.store("kind-02", "/p/file.py", Buffer.from("content"));
    expect(r).not.toBeNull();
    const sidecar = r!.path + ".kind";
    fs.writeFileSync(sidecar, Buffer.from([0xff, 0xfe, 0x20, 0x6e, 0x6f, 0x74]));
    expect(snapshots.load_kind("kind-02", "/p/file.py")).toBeNull();
  });

  it("test_unknown_kind_string_returns_none", () => {
    const r = snapshots.store("kind-03", "/p/file.py", Buffer.from("content"));
    expect(r).not.toBeNull();
    const sidecar = r!.path + ".kind";
    fs.writeFileSync(sidecar, Buffer.from("not_a_valid_kind"));
    expect(snapshots.load_kind("kind-03", "/p/file.py")).toBeNull();
  });

  it("test_predictive_kind_roundtrips", () => {
    const r = snapshots.store("kind-04", "/p/file.py", Buffer.from("content"), {
      kind: "predictive",
    });
    expect(r).not.toBeNull();
    expect(snapshots.load_kind("kind-04", "/p/file.py")).toBe("predictive");
  });
});

// ===========================================================================
// TestCleanupStale
// ===========================================================================

describe("TestCleanupStale", () => {
  it("test_stale_snapshots_removed", () => {
    const r = snapshots.store("stale-01", "/p/file.py", Buffer.from("old"));
    expect(r).not.toBeNull();
    const old_ts = Date.now() / 1000 - 48 * 3600;
    fs.utimesSync(r!.path, old_ts, old_ts);
    const sidecar = r!.path + ".kind";
    if (fs.existsSync(sidecar)) {
      fs.utimesSync(sidecar, old_ts, old_ts);
    }
    const removed = snapshots.cleanup_stale(24.0);
    expect(removed).toBeGreaterThanOrEqual(1);
    expect(snapshots.load("stale-01", "/p/file.py")).toBeNull();
  });

  it("test_fresh_snapshots_not_removed", () => {
    const r = snapshots.store("stale-02", "/p/file.py", Buffer.from("fresh"));
    expect(r).not.toBeNull();
    const removed = snapshots.cleanup_stale(24.0);
    expect(removed).toBe(0);
    expect(snapshots.load("stale-02", "/p/file.py")).toEqual(Buffer.from("fresh"));
  });

  it("test_missing_base_dir_returns_zero", () => {
    expect(snapshots.cleanup_stale(1.0)).toBe(0);
  });

  it("test_empty_session_dir_pruned", () => {
    const r = snapshots.store("stale-empty", "/p/file.py", Buffer.from("x"));
    expect(r).not.toBeNull();
    const session_dir = path.dirname(r!.path);
    const old_ts = Date.now() / 1000 - 48 * 3600;
    fs.utimesSync(r!.path, old_ts, old_ts);
    const sidecar = r!.path + ".kind";
    if (fs.existsSync(sidecar)) {
      fs.utimesSync(sidecar, old_ts, old_ts);
    }
    snapshots.cleanup_stale(24.0);
    expect(fs.existsSync(session_dir)).toBe(false);
  });
});
