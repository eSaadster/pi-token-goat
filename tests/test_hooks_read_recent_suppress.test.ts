/**
 * Tests for recent-read suppression window in pre_read.
 *
 * 1:1 port of tests/test_hooks_read_recent_suppress.py.
 *
 * The protect_recent_reads config setting (default 4) suppresses re-read hints
 * when a file was read within N tool calls ago — content is still in context.
 *
 * Port notes:
 *  - TestRecentReadSuppressWindow: the Python `_run_suppress_check` helper never
 *    calls into hooks_read — it computes the suppression condition arithmetically
 *    (`protect > 0 and last > 0 and gap <= protect`) and returns it. That mirrors
 *    the exact gate hooks_read.pre_read applies at hooks_read.ts:
 *      `if (entry.last_read_call_index > 0) { ... if (_protect > 0 &&
 *       _call_index - entry.last_read_call_index <= _protect) { _recent_suppress
 *       = true } }`.
 *    Ported faithfully as the same local arithmetic (no hooks_read call), so the
 *    test stays a pure pin on the suppression formula.
 *  - TestFileEntryCallIndex: exercises real session.mark_file_read / FileEntry.
 *  - TestProtectRecentReadsConfig: Python constructs HintsConfig() directly. In
 *    TS HintsConfig is an interface (no class constructor with defaults); the
 *    defaults live in config.load(). The default-of-4 case is pinned via
 *    load().hints.protect_recent_reads; the 0 / 100 cases are pinned by writing
 *    a [hints] config.toml override and asserting load() reflects it — the same
 *    behavior the Python field default + explicit kwargs assert.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import * as session from "../src/token_goat/session.js";
import { FileEntry, SessionCache } from "../src/token_goat/session.js";
import { load } from "../src/token_goat/config.js";
import { setConfigPathOverride } from "../src/token_goat/paths.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Return true if the recent-read suppression fires for the given inputs.
 *
 * Faithful port of the Python helper: it computes the condition directly rather
 * than invoking pre_read, pinning the exact gate hooks_read applies.
 */
function runSuppressCheck(
  currentCallIndex: number,
  lastReadCallIndex: number,
  protect: number,
): boolean {
  const gap = currentCallIndex - lastReadCallIndex;
  return protect > 0 && lastReadCallIndex > 0 && gap <= protect;
}

/** Write a [hints] config and redirect configPath() to it. */
function writeConfig(body: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tg-cfg-"));
  const file = path.join(dir, "config.toml");
  fs.writeFileSync(file, body, "utf8");
  setConfigPathOverride(file);
  return file;
}

// realpathSync the tmp dir: on macOS os.tmpdir() is a /var symlink and session
// path normalization resolves realpaths, so the cache key must match.
function realTmpDir(): string {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "tg-sess-")));
}

afterEach(() => {
  // setup.ts's clearModuleCaches() clears the config path override + caches per
  // test; nothing extra to undo here.
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("TestRecentReadSuppressWindow", () => {
  it("test_within_window_suppresses", () => {
    // Read at call 1, re-read at call 3 (gap=2, window=4) -> suppressed.
    expect(runSuppressCheck(3, 1, 4)).toBe(true);
  });

  it("test_outside_window_fires", () => {
    // Read at call 1, re-read at call 6 (gap=5, window=4) -> hint fires.
    expect(runSuppressCheck(6, 1, 4)).toBe(false);
  });

  it("test_window_zero_always_fires", () => {
    // Window=0 -> suppression disabled; hint fires even on consecutive calls.
    expect(runSuppressCheck(2, 1, 0)).toBe(false);
  });

  it("test_window_zero_fires_immediately", () => {
    // Window=0, gap=1 (consecutive) -> still fires (no suppression).
    expect(runSuppressCheck(2, 1, 0)).toBe(false);
  });

  it("test_large_window_suppresses_wide_gap", () => {
    // Window=10 suppresses a gap of 8.
    expect(runSuppressCheck(10, 2, 10)).toBe(true);
  });

  it("test_large_window_fires_just_outside", () => {
    // Window=10, gap=11 -> fires (just outside).
    expect(runSuppressCheck(13, 2, 10)).toBe(false);
  });

  it("test_boundary_exactly_equal_suppressed", () => {
    // Window=4, gap=4 (exactly equal) -> suppressed (<= means equal is suppressed).
    expect(runSuppressCheck(5, 1, 4)).toBe(true);
  });

  it("test_boundary_one_over_fires", () => {
    // Window=4, gap=5 -> fires (just outside window).
    expect(runSuppressCheck(6, 1, 4)).toBe(false);
  });

  it("test_never_recorded_not_suppressed", () => {
    // last_read_call_index=0 (never recorded) -> suppression does not fire.
    expect(runSuppressCheck(2, 0, 4)).toBe(false);
  });

  it("test_independent_files_tracked_separately", () => {
    // fileA: read at 1, re-read at 4 -> gap=3, window=4 -> suppressed
    expect(runSuppressCheck(4, 1, 4)).toBe(true);
    // fileB: read at 2, re-read at 7 -> gap=5, window=4 -> fires
    expect(runSuppressCheck(7, 2, 4)).toBe(false);
  });
});

describe("TestFileEntryCallIndex", () => {
  it("test_fileentry_default_is_zero", () => {
    const entry = new FileEntry({
      rel_or_abs: "foo.py",
      last_read_ts: 0.0,
      read_count: 0,
      line_ranges: [],
      symbols_read: [],
    });
    expect(entry.last_read_call_index).toBe(0);
  });

  it("test_mark_file_read_records_call_index", () => {
    // mark_file_read stores call_index in FileEntry.last_read_call_index.
    const tmp = realTmpDir();
    const sid = "test-sess-idx";
    const fpath = path.join(tmp, "dummy.py");
    fs.writeFileSync(fpath, "x = 1\n");

    const now = Date.now() / 1000;
    const cache = new SessionCache({ session_id: sid, started_ts: now, last_activity_ts: now });
    session.mark_file_read(sid, fpath, null, null, { cache, call_index: 42 });
    const key = session._normalize_path(fpath);
    expect(cache.files[key]!.last_read_call_index).toBe(42);
  });

  it("test_mark_file_read_no_call_index_leaves_zero", () => {
    // mark_file_read without call_index leaves last_read_call_index at 0.
    const tmp = realTmpDir();
    const sid = "test-sess-zero";
    const fpath = path.join(tmp, "dummy2.py");
    fs.writeFileSync(fpath, "y = 2\n");

    const now = Date.now() / 1000;
    const cache = new SessionCache({ session_id: sid, started_ts: now, last_activity_ts: now });
    session.mark_file_read(sid, fpath, null, null, { cache });
    const key = session._normalize_path(fpath);
    expect(cache.files[key]!.last_read_call_index).toBe(0);
  });
});

describe("TestProtectRecentReadsConfig", () => {
  it("test_default_is_four", () => {
    // Python: HintsConfig().protect_recent_reads == 4. TS default lives in load().
    writeConfig("");
    expect(load().hints!.protect_recent_reads).toBe(4);
  });

  it("test_zero_is_valid", () => {
    // Python: HintsConfig(protect_recent_reads=0).
    writeConfig("[hints]\nprotect_recent_reads = 0\n");
    expect(load().hints!.protect_recent_reads).toBe(0);
  });

  it("test_hundred_is_valid", () => {
    // Python: HintsConfig(protect_recent_reads=100).
    writeConfig("[hints]\nprotect_recent_reads = 100\n");
    expect(load().hints!.protect_recent_reads).toBe(100);
  });
});
