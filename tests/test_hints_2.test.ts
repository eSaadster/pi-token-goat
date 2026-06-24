/**
 * Unit tests for token_goat/hints — part 2/4 of the 1:1 port of
 * tests/test_hints.py (Python classes TestCacheHintSymbolSuffix through
 * TestShortOutputIdInHints, lines ~1059-2194).
 *
 * Each Python `def test_*` maps to a vitest `it()` with the SAME name and the
 * same assertion polarity. Python classes map to `describe()` blocks. parametrize
 * (none in this slice) would unroll into it.each.
 *
 * ReadHint assertion mapping (per hints.ts file header):
 *   Python `"x" in hint`     → TS `hint.text.includes("x")`
 *   Python `hint.lower()`    → TS `hint.text.toLowerCase()`
 *   Python `str(n) in hint`  → TS `hint.text.includes(String(n))`
 *   Python `str(hint)`       → TS `hint.text`
 *   Python `len(hint)`       → TS `hint.text.length`
 *   Python `hint.startswith` → TS `hint.text.startsWith`
 *   Python `hint.count(s)`   → TS countSubstr(hint.text, s)
 *   Python `hint.tokens_saved` → TS `hint.tokens_saved`
 *
 * Indexing seam: the Python suite builds an indexed project DB via
 * `with db.open_project(h) as conn: conn.execute(...)`. parser.ts is a later
 * layer, so the index rows are inserted directly through the shipped db.ts API
 * (db.openProject + conn.prepare().run()), mirroring tests/test_read_replacement.test.ts.
 *
 * Per-test tmp data dir + cache clearing is handled by tests/setup.ts
 * (beforeEach → setDataDirOverride + clearModuleCaches), mirroring the Python
 * tmp_data_dir autouse fixture.
 *
 * Deferred (it.skip): all bash-dedup tests that import `from token_goat import
 * bash_cache` — bash_cache.ts is not yet ported, so build_bash_dedup_hint fails
 * soft (returns null) and command_hash() is unavailable. The web-output and
 * short_output_id helper tests of TestShortOutputIdInHints ARE ported (web_cache
 * + cache_common are shipped).
 */
import { describe, expect, it } from "vitest";

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type { Database as DatabaseType } from "better-sqlite3";

import * as db from "../src/token_goat/db.js";
import * as session from "../src/token_goat/session.js";
import * as paths from "../src/token_goat/paths.js";
import * as web_cache from "../src/token_goat/web_cache.js";
import { short_output_id } from "../src/token_goat/cache_common.js";
import { find_project } from "../src/token_goat/project.js";
import {
  LARGE_FILE_LINE_THRESHOLD,
  STALE_READ_AGE_SECONDS,
  _BASH_DEDUP_MIN_BYTES,
  _BASH_DEDUP_LIGHT_MAX_BYTES,
  _BASH_DEDUP_GREP_SUGGEST_BYTES,
  _GLOB_DEDUP_MIN_RESULT_COUNT,
  _session_stale_threshold,
  build_bash_dedup_hint,
  build_glob_dedup_hint,
  build_read_hint,
  build_web_dedup_hint,
  compute_stale_threshold,
} from "../src/token_goat/hints.js";
import * as bash_cache from "../src/token_goat/bash_cache.js";
import { FileEntry, SessionCache, _normalize_path } from "../src/token_goat/session.js";

// ---------------------------------------------------------------------------
// Helpers (port of tests/test_hints.py module helpers).
// ---------------------------------------------------------------------------

/** time.time() → seconds since epoch. */
function timeNow(): number {
  return Date.now() / 1000;
}

/** Shortcut to mark a file read in the session cache (Python _mark). */
function _mark(
  sid: string,
  p: string,
  opts: { offset?: number; limit?: number; symbol?: string | null } = {},
): void {
  const offset = opts.offset ?? 0;
  const limit = opts.limit ?? 100;
  const symbol = opts.symbol ?? null;
  session.mark_file_read(sid, p, offset, limit, { symbol });
}

/** Unique tmp dir under the OS tmp root (pytest tmp_path analogue). */
let _tmpCounter = 0;
function tmpPath(): string {
  // realpathSync resolves macOS's /var -> /private/var symlink to match find_project's
  // canonical project root (else the index-hint containment check fails).
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), `tg-hints2-${process.pid}-${_tmpCounter++}-`)));
}

/**
 * Write a file with `n_lines` lines long enough to exceed the stat fast-path
 * threshold. Each line is ~76 bytes so LARGE_FILE_LINE_THRESHOLD lines ≈ 38 KB,
 * clearing the LARGE_FILE_LINE_THRESHOLD * _BYTES_PER_LINE_ESTIMATE byte
 * threshold in build_read_hint. (Python _make_large_file.)
 */
function _make_large_file(p: string, n_lines: number = LARGE_FILE_LINE_THRESHOLD + 10): void {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const lines: string[] = [];
  for (let i = 1; i <= n_lines; i++) {
    lines.push(`x = ${"x".repeat(70)}  # ${String(i).padStart(5, "0")}`);
  }
  fs.writeFileSync(p, lines.join("\n"), "utf8");
}

// ===========================================================================
// TestCacheHintSymbolSuffix
// ===========================================================================

describe("TestCacheHintSymbolSuffix", () => {
  it("test_exact_match_hint_includes_symbol_names", () => {
    const sid = "s_sym_exact";
    const p = "C:/proj/auth.py";
    _mark(sid, p, { offset: 0, limit: 200 });
    session.mark_file_read(sid, p, null, null, { symbol: "login" });
    session.mark_file_read(sid, p, null, null, { symbol: "validate_token" });

    const hint = build_read_hint({ session_id: sid, file_path: p, offset: 0, limit: 200, cwd: null });
    expect(hint).not.toBeNull();
    expect(hint!.text.includes("⌘")).toBe(true); // terse form of "cached"
    expect(hint!.text.includes("login")).toBe(true);
    expect(hint!.text.includes("validate_token")).toBe(true);
    expect(hint!.text.includes("[symbols:")).toBe(true);
  });

  it("test_exact_match_hint_overflow_shows_plus_n", () => {
    const sid = "s_sym_overflow";
    const p = "C:/proj/util.py";
    _mark(sid, p, { offset: 0, limit: 300 });
    for (const sym of ["alpha", "beta", "gamma", "delta"]) {
      session.mark_file_read(sid, p, null, null, { symbol: sym });
    }

    // Pin read_count below the suppression threshold so this test stays focused
    // on the symbols-suffix overflow display rather than the working-file path.
    const cache = session.load(sid);
    const entry = cache.files[_normalize_path(p)]!;
    entry.read_count = 4;
    cache._invalidate_json_cache();
    session.save(cache);

    const hint = build_read_hint({ session_id: sid, file_path: p, offset: 0, limit: 300, cwd: null });
    expect(hint).not.toBeNull();
    expect(hint!.text.includes("alpha")).toBe(true);
    expect(hint!.text.includes("beta")).toBe(true);
    expect(hint!.text.includes("gamma")).toBe(true);
    expect(hint!.text.includes("+1")).toBe(true);
    // Fourth name should NOT appear as a standalone entry
    expect(hint!.text.includes("delta")).toBe(false);
  });

  it("test_exact_match_hint_no_symbols_read_unchanged", () => {
    const sid = "s_nosym_exact";
    const p = "C:/proj/plain.py";
    _mark(sid, p, { offset: 0, limit: 100 });

    const hint = build_read_hint({ session_id: sid, file_path: p, offset: 0, limit: 100, cwd: null });
    expect(hint).not.toBeNull();
    expect(hint!.text.includes("[symbols:")).toBe(false);
  });

  it("test_overlap_hint_includes_symbol_names", () => {
    const sid = "s_sym_overlap";
    const p = "C:/proj/service.py";
    _mark(sid, p, { offset: 0, limit: 300 });
    session.mark_file_read(sid, p, null, null, { symbol: "get_user" });
    session.mark_file_read(sid, p, null, null, { symbol: "set_password" });

    // Overlap of 100 lines (201-300) — above MIN_OVERLAP_TO_WARN.
    const hint = build_read_hint({ session_id: sid, file_path: p, offset: 200, limit: 250, cwd: null });
    expect(hint).not.toBeNull();
    expect(hint!.text.toLowerCase().includes("overlap")).toBe(true);
    expect(hint!.text.includes("get_user")).toBe(true);
    expect(hint!.text.includes("set_password")).toBe(true);
    expect(hint!.text.includes("[symbols:")).toBe(true);
  });

  it("test_symbol_suffix_is_under_max_chars", () => {
    const sid = "s_longname";
    const p = "C:/proj/heavy.py";
    _mark(sid, p, { offset: 0, limit: 200 });
    const long_name = "a".repeat(70); // a single 70-char name exceeds the 60-char cap
    session.mark_file_read(sid, p, null, null, { symbol: long_name });

    const hint = build_read_hint({ session_id: sid, file_path: p, offset: 0, limit: 200, cwd: null });
    expect(hint).not.toBeNull();
    // The suffix is suppressed because even one name exceeds the budget.
    expect(hint!.text.includes("[symbols:")).toBe(false);
  });

  it("test_three_symbols_no_overflow", () => {
    const sid = "s_three";
    const p = "C:/proj/three.py";
    _mark(sid, p, { offset: 0, limit: 200 });
    for (const sym of ["foo", "bar", "baz"]) {
      session.mark_file_read(sid, p, null, null, { symbol: sym });
    }

    const hint = build_read_hint({ session_id: sid, file_path: p, offset: 0, limit: 200, cwd: null });
    expect(hint).not.toBeNull();
    expect(hint!.text.includes("foo")).toBe(true);
    expect(hint!.text.includes("bar")).toBe(true);
    expect(hint!.text.includes("baz")).toBe(true);
    const between = hint!.text.split("[symbols:").slice(-1)[0]!.split("]")[0]!;
    expect(between.includes("+")).toBe(false);
  });
});

// ===========================================================================
// TestIndexHintSymbolListing — _hint_from_index lists first 3 indexed symbols
// ===========================================================================

describe("TestIndexHintSymbolListing", () => {
  it("test_index_hint_lists_first_symbol_names", () => {
    const tmp = tmpPath();
    fs.mkdirSync(path.join(tmp, ".git"), { recursive: true });
    const src_file = path.join(tmp, "big2.py");
    _make_large_file(src_file, LARGE_FILE_LINE_THRESHOLD + 50);

    const proj = find_project(tmp);
    expect(proj).not.toBeNull();

    db.openProject(proj!.hash, (conn: DatabaseType) => {
      conn
        .prepare(
          "INSERT OR IGNORE INTO files (rel_path, language, size, mtime, content_sha256, indexed_at) " +
            "VALUES (?, ?, ?, ?, ?, ?)",
        )
        .run("big2.py", "python", 50000, 0.0, "abc123", 0);
      const insSym = conn.prepare(
        "INSERT INTO symbols (name, kind, file_rel, line, col, end_line) VALUES (?, ?, ?, ?, ?, ?)",
      );
      const names = ["login", "logout", "validate_token", "refresh"];
      names.forEach((name, i) => {
        insSym.run(name, "function", "big2.py", 10 + i * 20, 0, 25 + i * 20);
      });
    });

    const hint = build_read_hint({
      session_id: "s_idx_syms",
      file_path: src_file,
      offset: 0,
      limit: 2000,
      cwd: tmp,
    });
    expect(hint).not.toBeNull();
    // First 3 symbols must appear in the hint
    expect(hint!.text.includes("login")).toBe(true);
    expect(hint!.text.includes("logout")).toBe(true);
    expect(hint!.text.includes("validate_token")).toBe(true);
    // 4th symbol is overflow — should NOT appear by name
    expect(hint!.text.includes("refresh")).toBe(false);
    expect(hint!.text.includes("...")).toBe(true); // overflow indicator
  });

  it("test_index_hint_single_symbol_no_overflow", () => {
    const tmp = tmpPath();
    fs.mkdirSync(path.join(tmp, ".git"), { recursive: true });
    const src_file = path.join(tmp, "single_sym.py");
    _make_large_file(src_file, LARGE_FILE_LINE_THRESHOLD + 10);

    const proj = find_project(tmp);
    expect(proj).not.toBeNull();

    db.openProject(proj!.hash, (conn: DatabaseType) => {
      conn
        .prepare(
          "INSERT OR IGNORE INTO files (rel_path, language, size, mtime, content_sha256, indexed_at) " +
            "VALUES (?, ?, ?, ?, ?, ?)",
        )
        .run("single_sym.py", "python", 50000, 0.0, "xyz", 0);
      conn
        .prepare(
          "INSERT INTO symbols (name, kind, file_rel, line, col, end_line) VALUES (?, ?, ?, ?, ?, ?)",
        )
        .run("only_func", "function", "single_sym.py", 10, 0, 20);
    });

    const hint = build_read_hint({
      session_id: "s_single",
      file_path: src_file,
      offset: 0,
      limit: 2000,
      cwd: tmp,
    });
    expect(hint).not.toBeNull();
    expect(hint!.text.includes("only_func")).toBe(true);
    expect(hint!.text.includes("...")).toBe(false);
  });
});

// ===========================================================================
// TestLegacySessionJsonFromOlderVersion
// ===========================================================================

describe("TestLegacySessionJsonFromOlderVersion", () => {
  it("test_legacy_session_json_without_last_edit_ts_loads_clean", () => {
    const sid = "s_legacy";
    session.validate_session_id(sid);
    const legacy = {
      schema_version: 1,
      created_by: "token-goat",
      session_id: sid,
      started_ts: timeNow(),
      last_activity_ts: timeNow(),
      // No last_edit_ts on the file entry — the old wire format.
      files: {
        "c:/proj/legacy.py": {
          rel_or_abs: "C:/proj/legacy.py",
          last_read_ts: timeNow(),
          read_count: 1,
          line_ranges: [[1, 100]],
          symbols_read: [],
        },
      },
      greps: [],
      edited_files: {},
    };
    paths.atomicWriteText(paths.sessionCachePath(sid), JSON.stringify(legacy));

    const cache = session.load(sid);
    const entry = cache.files["c:/proj/legacy.py"]!;
    // Missing field defaults to 0.0 (= "never edited").
    expect(entry.last_edit_ts).toBe(0.0);
  });
});

// ===========================================================================
// TestReadCountSuppression
// ===========================================================================

describe("TestReadCountSuppression", () => {
  /** Mark a file read `read_count` times so session cache reflects it. */
  function _make_entry_with_read_count(sid: string, p: string, read_count: number): void {
    for (let i = 0; i < read_count; i++) {
      session.mark_file_read(sid, p, 0, 200);
    }
  }

  it("test_read_count_4_still_gets_exact_match_hint", () => {
    const sid = "s_rc4";
    const p = "C:/proj/rc4.py";
    _make_entry_with_read_count(sid, p, 4);

    const hint = build_read_hint({ session_id: sid, file_path: p, offset: 0, limit: 200, cwd: null });
    expect(hint).not.toBeNull();
    expect(hint!.text.includes("⌘")).toBe(true); // terse form of "cached"
  });

  it("test_read_count_5_emits_surgical_nudge", () => {
    const sid = "s_rc5";
    const p = "C:/proj/rc5.py";
    _make_entry_with_read_count(sid, p, 5);

    const hint = build_read_hint({ session_id: sid, file_path: p, offset: 0, limit: 200, cwd: null });
    expect(hint).not.toBeNull();
    expect(hint!.text.includes("token-goat read")).toBe(true);
    expect(
      hint!.text.toLowerCase().includes("frequently") || hint!.text.toLowerCase().includes("surgical"),
    ).toBe(true);
  });

  it("test_surgical_nudge_text_is_stable_across_read_counts", () => {
    // Use paths with no digits so digit-checks are unambiguous.
    const sid_a = "s_nudge_alpha";
    const path_a = "C:/proj/alpha.py";
    const sid_b = "s_nudge_beta";
    const path_b = "C:/proj/beta.py";
    _make_entry_with_read_count(sid_a, path_a, 5);
    _make_entry_with_read_count(sid_b, path_b, 7);

    const hint_a = build_read_hint({ session_id: sid_a, file_path: path_a, offset: 0, limit: 200, cwd: null });
    const hint_b = build_read_hint({ session_id: sid_b, file_path: path_b, offset: 0, limit: 200, cwd: null });
    expect(hint_a).not.toBeNull();
    expect(hint_b).not.toBeNull();
    // The read counts (5 and 7) must not appear in the hint text — stable fingerprint.
    expect(hint_a!.text.includes("5")).toBe(false);
    expect(hint_b!.text.includes("7")).toBe(false);
  });

  it("test_read_count_10_returns_sentinel_hint", () => {
    const sid = "s_rc10";
    const p = "C:/proj/rc10.py";
    _make_entry_with_read_count(sid, p, 10);

    const hint = build_read_hint({ session_id: sid, file_path: p, offset: 0, limit: 200, cwd: null });
    // Should emit sentinel hint, not suppress
    expect(hint).not.toBeNull();
    expect(hint!.text.includes("full file")).toBe(true);
    expect(hint!.text.includes("10")).toBe(true);
  });

  it("test_symbol_only_hint_not_suppressed_at_high_read_count", () => {
    const sid = "s_rc_sym";
    const p = "C:/proj/rc_sym.py";
    // Mark as symbol-only reads (no line ranges accumulate).
    for (let i = 0; i < 5; i++) {
      session.mark_file_read(sid, p, null, null, { symbol: "MyFunc" });
    }

    const hint = build_read_hint({ session_id: sid, file_path: p, offset: 0, limit: 2000, cwd: null });
    // Symbol hint should still fire (not suppressed by read_count).
    expect(hint).not.toBeNull();
    expect(hint!.text.includes("token-goat read")).toBe(true);
  });
});

// ===========================================================================
// TestComputeStaleThreshold
// ===========================================================================

describe("TestComputeStaleThreshold", () => {
  it("test_zero_session_age_returns_floor", () => {
    expect(compute_stale_threshold(0)).toBe(900.0);
  });

  it("test_3600s_session_age_returns_floor", () => {
    expect(compute_stale_threshold(3600)).toBe(900.0);
  });

  it("test_7200s_session_age_returns_mid_range", () => {
    expect(compute_stale_threshold(7200)).toBe(1800.0);
  });

  it("test_14400s_session_age_returns_ceiling", () => {
    const result = compute_stale_threshold(14400);
    expect(result).toBe(STALE_READ_AGE_SECONDS);
  });

  it("test_stale_read_age_seconds_is_unchanged", () => {
    expect(STALE_READ_AGE_SECONDS).toBe(30 * 60);
  });

  it("test_adaptive_threshold_used_in_read_hint", () => {
    const sid = "s_adaptive";
    const p = "C:/proj/adaptive.py";
    session.mark_file_read(sid, p, 0, 200);

    // Simulate a long session (4h = 14400s) with a read 1000s old. The adaptive
    // threshold = clamp(14400*0.25, 900, 1800) = 1800s. Since 1000s < 1800s the
    // read is still fresh — hint should fire.
    const cache = session.load(sid);
    cache.created_ts = timeNow() - 14400; // session started 4h ago
    const entry = cache.files[_normalize_path(p)]!;
    entry.last_read_ts = timeNow() - 1000; // read 1000s ago
    cache._invalidate_json_cache();
    session.save(cache);

    const hint = build_read_hint({ session_id: sid, file_path: p, offset: 0, limit: 200, cwd: null });
    expect(hint).not.toBeNull();
    expect(hint!.text.includes("⌘")).toBe(true); // terse form of "cached"
  });

  it("test_adaptive_threshold_suppresses_older_read_in_long_session", () => {
    const sid = "s_adaptive2";
    const p = "C:/proj/adaptive2.py";
    session.mark_file_read(sid, p, 0, 200);

    // Short session (3600s = 1h). threshold = clamp(3600*0.25, 900, 1800) = 900s.
    const cache = session.load(sid);
    cache.created_ts = timeNow() - 3600;
    const entry = cache.files[_normalize_path(p)]!;
    entry.last_read_ts = timeNow() - 1000; // read 1000s ago (> 900s threshold)
    cache._invalidate_json_cache();
    session.save(cache);

    const hint = build_read_hint({ session_id: sid, file_path: p, offset: 0, limit: 200, cwd: null });
    expect(hint).toBeNull();
  });

  it("test_stale_symbol_only_access_suppressed", () => {
    const sid = "s_stale_sym";
    const p = "C:/proj/stale_sym.py";
    session.mark_file_read(sid, p, null, null, { symbol: "MyClass" });

    // Short session (1h). threshold = clamp(3600*0.25, 900, 1800) = 900s. Make
    // the symbol access 1000s old — beyond the 900s threshold.
    const cache = session.load(sid);
    cache.created_ts = timeNow() - 3600;
    const entry = cache.files[_normalize_path(p)]!;
    entry.last_read_ts = timeNow() - 1000;
    cache._invalidate_json_cache();
    session.save(cache);

    const hint = build_read_hint({ session_id: sid, file_path: p, offset: null, limit: null, cwd: null });
    expect(hint).toBeNull();
  });
});

// ===========================================================================
// TestSessionStaleThreshold
// ===========================================================================

describe("TestSessionStaleThreshold", () => {
  it("test_extracts_created_ts_from_cache", () => {
    const now = timeNow();
    const session_age = 3600; // 1h old session
    const cache = new SessionCache({
      session_id: "test_extract",
      started_ts: now - session_age,
      last_activity_ts: now,
    });
    cache.created_ts = now - session_age; // 1h old session

    // 1h session → threshold = clamp(3600*0.25, 900, 1800) = 900s
    const result = _session_stale_threshold(cache, now);
    expect(result).toBe(900.0);
  });

  it("test_uses_stale_read_age_when_created_ts_missing", () => {
    const now = timeNow();
    const cache = new SessionCache({
      session_id: "test_fallback",
      started_ts: now,
      last_activity_ts: now,
    });
    // Don't set created_ts — the SessionCache dataclass/class defaults it to
    // time.time() (≈ now), so session_age ≈ 0 → threshold = clamp(0, 900, 1800)
    // = 900s. (Python's "missing created_ts" comment is about the wire format;
    // the constructed object always carries a now-ish created_ts, exactly as the
    // TS SessionCache constructor defaults `created_ts` to Date.now()/1000.)

    const result = _session_stale_threshold(cache, now);
    expect(result).toBe(900.0);
  });

  it("test_agrees_with_compute_stale_threshold", () => {
    const now = timeNow();
    for (const session_age of [0, 1800, 3600, 7200, 14400]) {
      const cache = new SessionCache({
        session_id: `test_agree_${session_age}`,
        started_ts: now - session_age,
        last_activity_ts: now,
      });
      cache.created_ts = now - session_age;

      const result1 = _session_stale_threshold(cache, now);
      const result2 = compute_stale_threshold(session_age);
      expect(result1).toBe(result2);
    }
  });

  it("test_fresh_symbol_only_access_still_emits", () => {
    const sid = "s_fresh_sym";
    const p = "C:/proj/fresh_sym.py";
    session.mark_file_read(sid, p, null, null, { symbol: "MyClass" });

    // Long session (4h). threshold = min(14400*0.25, 1800) = 1800s. Read 500s
    // ago — well within the 1800s threshold.
    const cache = session.load(sid);
    cache.created_ts = timeNow() - 14400;
    const entry = cache.files[_normalize_path(p)]!;
    entry.last_read_ts = timeNow() - 500;
    cache._invalidate_json_cache();
    session.save(cache);

    const hint = build_read_hint({ session_id: sid, file_path: p, offset: null, limit: null, cwd: null });
    expect(hint).not.toBeNull();
  });
});

// ===========================================================================
// TestHintsEdgeCases
// ===========================================================================

describe("TestHintsEdgeCases", () => {
  it("test_empty_session_first_read_returns_none", () => {
    const sid = "fresh_session_edge";
    // Don't mark anything — the file has never been read
    const p = "src/never_read.py";
    const hint = build_read_hint({ session_id: sid, file_path: p, offset: 0, limit: 100, cwd: "/tmp" });
    // File is not in session cache, not indexed, and not large → no hint
    expect(hint).toBeNull();
  });

  it("test_file_read_once_emits_hint_on_second_read", () => {
    const sid = "second_read_edge";
    const p = "src/test.py";

    // First read
    session.mark_file_read(sid, p, 0, 100);

    // Second read of the same range
    const hint = build_read_hint({ session_id: sid, file_path: p, offset: 0, limit: 100, cwd: "/tmp" });
    // Should emit an exact-match hint
    expect(hint).not.toBeNull();
    expect(hint!.text.includes("⌘")).toBe(true); // terse form of "cached"
    expect(hint!.tokens_saved).toBeGreaterThan(0);
  });

  it("test_very_long_file_path_in_hint", () => {
    const sid = "long_path_edge";
    // Create a 200-char path
    const long_path = "src/" + "a".repeat(180) + "/file.py";
    expect(long_path.length).toBeGreaterThan(180);

    session.mark_file_read(sid, long_path, 0, 50);

    // Second read with a different range to get a partial-overlap hint.
    const hint = build_read_hint({
      session_id: sid,
      file_path: long_path,
      offset: 0,
      limit: 100,
      cwd: "/tmp",
    });
    // Should not crash; may or may not produce a hint. If present, it should be
    // a reasonable size (sanitized/truncated).
    if (hint !== null) {
      expect(hint.text.length).toBeLessThan(1000);
    }
  });

  it("test_glob_dedup_hint_zero_results_suppressed", () => {
    const sid = "glob_zero_results";

    // Record a glob with 0 results
    session.mark_glob_run(sid, "**/*.nonexistent", null, 0);

    // Try to build a hint for the same glob
    const hint = build_glob_dedup_hint({ session_id: sid, pattern: "**/*.nonexistent", path: null });

    // Suppressed: result_count (0) < _GLOB_DEDUP_MIN_RESULT_COUNT (5)
    expect(hint).toBeNull();
  });

  it("test_glob_dedup_hint_with_special_regex_chars", () => {
    const sid = "glob_special_chars";

    // A pattern with regex-special chars: [, ], *, +, ?, etc.
    const pattern = "**/[test_]+([a-z]*).py";
    session.mark_glob_run(sid, pattern, "src/", 10);

    // Should not crash
    const hint = build_glob_dedup_hint({ session_id: sid, pattern, path: "src/" });

    // Should emit a hint (10 >= 5)
    expect(hint).not.toBeNull();
    expect(hint!.text.includes("Glob")).toBe(true);
  });

  it("test_glob_dedup_hint_exact_threshold_boundary", () => {
    const sid = "glob_boundary";
    const pattern = "**/*.py";

    // Record exactly at threshold
    session.mark_glob_run(sid, pattern, null, _GLOB_DEDUP_MIN_RESULT_COUNT);

    const hint = build_glob_dedup_hint({ session_id: sid, pattern, path: null });

    // Should emit (not suppressed)
    expect(hint).not.toBeNull();
    expect(hint!.text.includes(String(_GLOB_DEDUP_MIN_RESULT_COUNT))).toBe(true);
  });

  it("test_glob_dedup_hint_one_below_threshold_suppressed", () => {
    const sid = "glob_below_threshold";
    const pattern = "**/*.txt";

    session.mark_glob_run(sid, pattern, null, _GLOB_DEDUP_MIN_RESULT_COUNT - 1);

    const hint = build_glob_dedup_hint({ session_id: sid, pattern, path: null });

    // Should be suppressed (below threshold)
    expect(hint).toBeNull();
  });

  it("test_build_read_hint_empty_session_cache_object", () => {
    const sid = "explicit_empty_cache";
    const p = "src/file.py";

    // Create an empty cache object
    const empty_cache = session.load(sid);
    expect(empty_cache.files).toEqual({});

    // Try to build a hint with this empty cache
    const hint = build_read_hint({
      session_id: sid,
      file_path: p,
      offset: 0,
      limit: 100,
      cwd: "/tmp",
      cache: empty_cache,
    });
    // No hint because file was never read
    expect(hint).toBeNull();
  });

  it("test_build_read_hint_cache_with_edited_but_unread_file", () => {
    const sid = "edited_unread";
    const p = "src/edited.py";

    // Mark file as edited without reading
    session.mark_file_edited(sid, p);

    // Try to build a hint for a read
    const hint = build_read_hint({ session_id: sid, file_path: p, offset: 0, limit: 100, cwd: "/tmp" });
    // No hint because file was never read (only edited)
    expect(hint).toBeNull();
  });
});

// ===========================================================================
// TestHintThrottleByFileSize
// ===========================================================================

describe("TestHintThrottleByFileSize", () => {
  it("test_small_file_10_lines_single_read_no_hint", () => {
    const sid = "s_small_1_read";
    const p = "C:/proj/tiny.py";
    // Mark as read with 10-line span (offset=0, limit=10)
    _mark(sid, p, { offset: 0, limit: 10 });

    // Request the same range again
    const hint = build_read_hint({ session_id: sid, file_path: p, offset: 0, limit: 10, cwd: null });
    // Should suppress hint for tiny file with single read
    expect(hint).toBeNull();
  });

  it("test_small_file_25_lines_multiple_reads_with_overlap_emits_hint", () => {
    const sid = "s_small_25_3_reads_overlap";
    const p = "C:/proj/tiny25.py";
    // Mark lines 1-100 to create overlap that's > MIN_OVERLAP_TO_WARN (50)
    _mark(sid, p, { offset: 0, limit: 100 });
    session.mark_file_read(sid, p, 0, 100);
    session.mark_file_read(sid, p, 0, 100);

    // Now request L1-75 (overlap = 75 lines, which is > 50)
    const hint = build_read_hint({ session_id: sid, file_path: p, offset: 0, limit: 75, cwd: null });
    // Should emit overlap hint (read_count=3 so small-file check doesn't apply)
    expect(hint).not.toBeNull();
    expect(hint!.text.includes("⌘") || hint!.text.toLowerCase().includes("overlap")).toBe(true);
  });

  it("test_large_file_100_lines_emits_hint", () => {
    const sid = "s_large_1_read";
    const p = "C:/proj/medium.py";
    // Mark as read with 100-line span (offset=0, limit=100)
    _mark(sid, p, { offset: 0, limit: 100 });

    // Request the same range again
    const hint = build_read_hint({ session_id: sid, file_path: p, offset: 0, limit: 100, cwd: null });
    // Should emit hint for larger file even with single read
    expect(hint).not.toBeNull();
    expect(hint!.text.includes("⌘")).toBe(true); // terse form of "cached"
    expect(hint!.text.toLowerCase().includes("waste")).toBe(true);
  });

  it("test_exactly_30_lines_boundary_emits_hint", () => {
    const sid = "s_boundary_30";
    const p = "C:/proj/boundary.py";
    // Mark with 100 lines to avoid both exact-match and overlap suppressions
    _mark(sid, p, { offset: 0, limit: 100 });

    // Request ALL 100 lines again (exact match), which should emit a hint since
    // 100 > NARROW_EXPLICIT_READ_LINES (50).
    const hint = build_read_hint({ session_id: sid, file_path: p, offset: 0, limit: 100, cwd: null });
    // Should emit exact-match hint (100 lines > NARROW_EXPLICIT_READ_LINES threshold)
    expect(hint).not.toBeNull();
    expect(hint!.text.includes("⌘")).toBe(true); // terse form of "cached"
    expect(hint!.text.toLowerCase().includes("waste")).toBe(true);
  });

  it("test_sentinel_full_file_hint", () => {
    const sid = "s_sentinel_hint";
    const p = "c:/proj/hotfile.py"; // Use lowercase drive on Windows
    // Manually create a FileEntry with sentinel to test hint generation
    const cache = session.load(sid);
    cache.files[p] = new FileEntry({
      rel_or_abs: p,
      last_read_ts: timeNow(),
      read_count: 15,
      line_ranges: [[0, 0]], // The sentinel
      symbols_read: ["func1", "func2"],
    });
    session.save(cache);

    // Request any range on this file (use original path; normalization will match)
    const hint = build_read_hint({ session_id: sid, file_path: p, offset: 0, limit: 50, cwd: null });
    // Should emit a full-file summary hint
    expect(hint).not.toBeNull();
    expect(hint!.text.includes("full file")).toBe(true);
    expect(hint!.text.includes("15")).toBe(true); // read count
    expect(hint!.text.includes("func1") || hint!.text.includes("func2")).toBe(true);
  });
});

// ===========================================================================
// TestBashDedupLightOutput — bash_cache now wired (real module default)
// ===========================================================================

/**
 * Mark a bash run for the dedup-hint tests (Python TestBashDedupLightOutput._record
 * and friends). Mirrors session.mark_bash_run with positional args. bash_cache is
 * the real ported module, so build_bash_dedup_hint resolves it via the seam.
 */
function _recordBashRun(
  sid: string,
  cmd: string,
  opts: { stdout_bytes: number; stderr_bytes?: number; exit_code?: number | null; output_id?: string } = {
    stdout_bytes: 0,
  },
): string {
  const cmd_sha = bash_cache.command_hash(cmd);
  const output_id = opts.output_id ?? `out_${cmd_sha.slice(0, 8)}`;
  session.mark_bash_run(
    sid,
    cmd_sha,
    cmd.slice(0, 120),
    output_id,
    opts.stdout_bytes,
    opts.stderr_bytes ?? 0,
    opts.exit_code === undefined ? 0 : opts.exit_code,
    false,
  );
  return cmd_sha;
}

describe("TestBashDedupLightOutput", () => {
  it("test_below_min_threshold_no_hint", () => {
    const sid = "s_light_below";
    const cmd = "git status";
    _recordBashRun(sid, cmd, { stdout_bytes: _BASH_DEDUP_MIN_BYTES - 1 });
    const hint = build_bash_dedup_hint({ session_id: sid, command: cmd });
    expect(hint).toBeNull();
  });

  it("test_at_min_threshold_emits_light_hint", () => {
    const sid = "s_light_at_min";
    const cmd = "git status --short";
    _recordBashRun(sid, cmd, { stdout_bytes: _BASH_DEDUP_MIN_BYTES });
    const hint = build_bash_dedup_hint({ session_id: sid, command: cmd });
    expect(hint).not.toBeNull();
    expect(hint!.text.includes("⌘")).toBe(true); // terse form of "cached"
    expect(hint!.text.includes("bash-output")).toBe(true);
  });

  it("test_light_hint_is_compact", () => {
    const sid = "s_light_compact";
    const cmd = "python --version";
    _recordBashRun(sid, cmd, { stdout_bytes: 300 });
    const hint = build_bash_dedup_hint({ session_id: sid, command: cmd });
    expect(hint).not.toBeNull();
    // Light hint must not contain the verbose "tokens" or "WARNING" markers
    expect(hint!.text.includes("tokens")).toBe(false);
    expect(hint!.text.includes("WARNING")).toBe(false);
    expect(hint!.text.includes("bash-output")).toBe(true);
  });

  it("test_at_light_max_boundary_still_light", () => {
    const sid = "s_light_boundary";
    const cmd = "ls -la";
    _recordBashRun(sid, cmd, { stdout_bytes: _BASH_DEDUP_LIGHT_MAX_BYTES });
    const hint = build_bash_dedup_hint({ session_id: sid, command: cmd });
    expect(hint).not.toBeNull();
    expect(hint!.text.includes("tokens")).toBe(false);
    expect(hint!.text.includes("bash-output")).toBe(true);
  });

  it("test_above_light_max_uses_full_hint", () => {
    const sid = "s_full_hint";
    const cmd = "uv run pytest tests/ -v";
    _recordBashRun(sid, cmd, { stdout_bytes: _BASH_DEDUP_LIGHT_MAX_BYTES + 1 });
    const hint = build_bash_dedup_hint({ session_id: sid, command: cmd });
    expect(hint).not.toBeNull();
    // Full hint: uses comma-formatted bytes like "1,000B"; light uses "1000B"
    expect(hint!.text.includes("1,000B")).toBe(true);
    expect(hint!.text.includes("bash-output")).toBe(true);
  });
});

// ===========================================================================
// TestBashDedupGrepSuggest — bash_cache now wired
// ===========================================================================

describe("TestBashDedupGrepSuggest", () => {
  it("test_below_grep_threshold_no_grep_suffix", () => {
    const sid = "s_grep_below";
    const cmd = "uv run pytest tests/test_hints.py -q";
    _recordBashRun(sid, cmd, { stdout_bytes: _BASH_DEDUP_GREP_SUGGEST_BYTES - 1 });
    const hint = build_bash_dedup_hint({ session_id: sid, command: cmd });
    expect(hint).not.toBeNull();
    expect(hint!.text.includes("--grep")).toBe(false);
  });

  it("test_at_grep_threshold_includes_grep_suffix", () => {
    const sid = "s_grep_at";
    const cmd = "uv run pytest tests/ -v --tb=long";
    _recordBashRun(sid, cmd, { stdout_bytes: _BASH_DEDUP_GREP_SUGGEST_BYTES });
    const hint = build_bash_dedup_hint({ session_id: sid, command: cmd });
    expect(hint).not.toBeNull();
    expect(hint!.text.includes("--grep")).toBe(true);
    expect(hint!.text.includes("PATTERN")).toBe(true);
  });

  it("test_above_grep_threshold_includes_grep_suffix", () => {
    const sid = "s_grep_above";
    const cmd = "git log --oneline --all";
    _recordBashRun(sid, cmd, { stdout_bytes: 20000 });
    const hint = build_bash_dedup_hint({ session_id: sid, command: cmd });
    expect(hint).not.toBeNull();
    expect(hint!.text.includes("--grep")).toBe(true);
  });

  it("test_light_hint_never_gets_grep_suffix", () => {
    const sid = "s_grep_light";
    const cmd = "git status";
    _recordBashRun(sid, cmd, { stdout_bytes: _BASH_DEDUP_LIGHT_MAX_BYTES - 100 });
    const hint = build_bash_dedup_hint({ session_id: sid, command: cmd });
    expect(hint).not.toBeNull();
    expect(hint!.text.includes("--grep")).toBe(false);
  });
});

// ===========================================================================
// TestBashDedupFailedExitCode — bash_cache now wired
// ===========================================================================

describe("TestBashDedupFailedExitCode", () => {
  it("test_zero_exit_no_failed_prefix", () => {
    const sid = "s_exit0";
    const cmd = "uv run pytest tests/ -q";
    _recordBashRun(sid, cmd, { stdout_bytes: 2000, exit_code: 0 });
    const hint = build_bash_dedup_hint({ session_id: sid, command: cmd });
    expect(hint).not.toBeNull();
    expect(hint!.text.includes("FAILED")).toBe(false);
  });

  it("test_nonzero_exit_light_hint_has_prefix", () => {
    const sid = "s_exit1_light";
    const cmd = "git push";
    _recordBashRun(sid, cmd, { stdout_bytes: 400, exit_code: 1 });
    const hint = build_bash_dedup_hint({ session_id: sid, command: cmd });
    expect(hint).not.toBeNull();
    expect(hint!.text.startsWith("FAILED")).toBe(true);
    expect(hint!.text.includes("x=1")).toBe(true); // terse form of "exit=1"
  });

  it("test_nonzero_exit_full_hint_has_prefix", () => {
    const sid = "s_exit2_full";
    const cmd = "uv run mypy src";
    _recordBashRun(sid, cmd, { stdout_bytes: 3000, exit_code: 2 });
    const hint = build_bash_dedup_hint({ session_id: sid, command: cmd });
    expect(hint).not.toBeNull();
    expect(hint!.text.startsWith("FAILED")).toBe(true);
    expect(hint!.text.includes("x=2")).toBe(true); // terse form of "exit=2"
  });

  it("test_exit_code_not_duplicated_in_hint", () => {
    const sid = "s_no_dup";
    const cmd = "ruff check src/";
    _recordBashRun(sid, cmd, { stdout_bytes: 1500, exit_code: 1 });
    const hint = build_bash_dedup_hint({ session_id: sid, command: cmd });
    expect(hint).not.toBeNull();
    // terse form of "exit=1", appears exactly once
    expect(hint!.text.split("x=1").length - 1).toBe(1);
  });

  it("test_none_exit_code_no_prefix", () => {
    const sid = "s_exit_none";
    const cmd = "some-command";
    const cmd_sha = bash_cache.command_hash(cmd);
    session.mark_bash_run(
      sid,
      cmd_sha,
      cmd,
      `out_${cmd_sha.slice(0, 8)}`,
      2000,
      0,
      null,
      false,
    );
    const hint = build_bash_dedup_hint({ session_id: sid, command: cmd });
    expect(hint).not.toBeNull();
    expect(hint!.text.includes("FAILED")).toBe(false);
    // terse form of "exit=" — must be absent for None exit code
    expect(hint!.text.includes("x=")).toBe(false);
  });
});

// ===========================================================================
// TestShortOutputIdInHints — hints render …<last8> not the full output_id
// ===========================================================================

describe("TestShortOutputIdInHints", () => {
  it("test_bash_hint_uses_short_id", () => {
    const sid = "s_shortid_bash";
    const cmd = "uv run pytest tests/ -q";
    const full_id = "ses-abc123-0000000000001-deadbeef12345678";
    _recordBashRun(sid, cmd, { stdout_bytes: 2000, output_id: full_id });
    const hint = build_bash_dedup_hint({ session_id: sid, command: cmd });
    expect(hint).not.toBeNull();
    // Short suffix must appear; full id must NOT appear.
    expect(hint!.text.includes("…12345678")).toBe(true);
    expect(hint!.text.includes(full_id)).toBe(false);
  });

  it("test_web_hint_uses_short_id", () => {
    const sid = "s_shortid_web";
    const url = "https://docs.example.com/api/reference";
    const full_id = "ses-abc123-0000000000002-cafebabe87654321";
    const url_sha = web_cache.url_hash(url);
    session.mark_web_fetch(sid, url_sha, url.slice(0, 200), full_id, 5000, 200, false);
    const hint = build_web_dedup_hint({ session_id: sid, url });
    expect(hint).not.toBeNull();
    expect(hint!.text.includes("…87654321")).toBe(true);
    expect(hint!.text.includes(full_id)).toBe(false);
  });

  it("test_short_id_helper_ellipsis_prefix", () => {
    const full = "ses-abc-0000000000001-abcd1234";
    expect(short_output_id(full)).toBe("…abcd1234");
  });

  it("test_short_id_helper_passthrough_for_short", () => {
    expect(short_output_id("abc123")).toBe("abc123");
    expect(short_output_id("abcd1234")).toBe("abcd1234");
  });
});
