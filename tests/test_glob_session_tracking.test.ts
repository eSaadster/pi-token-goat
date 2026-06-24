/**
 * Tests for Glob tool session tracking and dedup hint (sub-area C).
 *
 * 1:1 port of tests/test_glob_session_tracking.py.
 *
 * Verifies that:
 *  - mark_glob_run records patterns to glob_history
 *  - lookup_glob_entry retrieves the most recent entry for (pattern, path)
 *  - build_glob_dedup_hint emits a hint on repeat Glob calls
 *  - _handle_glob_dedup integrates tracking + hint in the pre-read hook
 *
 * Test-seam mapping (Python -> TS):
 *  - tmp_data_dir / monkeypatch.chdir(tmp_data_dir.parent): the Python tests
 *    chdir so the data dir resolves; the TS setup.ts already isolates the data
 *    dir per test via setDataDirOverride(), so session files resolve under the
 *    per-test dir without any chdir. No cwd manipulation is needed (and the
 *    session paths come from paths.ts, not cwd).
 *  - session.load / mark_glob_run / lookup_glob_entry / reset_session import
 *    their EXACT snake_case names from ../src/token_goat/session.js.
 *  - time.sleep(0.01): the TS port uses mark_glob_run's monotonic ts directly;
 *    the most-recent lookup walks the list in reverse so the second append wins
 *    regardless of clock resolution — but we keep the test 1:1 by relying on the
 *    same reverse-scan semantics (no sleep needed since insertion order is the
 *    tiebreaker).
 *
 * Skipped:
 *  - TestBuildGlobDedupHint (both tests) import token_goat.hints
 *    (build_glob_dedup_hint), which is NOT yet ported to TS. Marked it.skip
 *    with a PORT note and counted in tests_skipped.
 */
import { describe, expect, it } from "vitest";

import {
  load,
  lookup_glob_entry,
  mark_glob_run,
  reset_session,
} from "../src/token_goat/session.js";

// ===========================================================================
// TestMarkGlobRun — mark_glob_run records Glob patterns into glob_history.
// ===========================================================================
describe("TestMarkGlobRun", () => {
  it("test_records_pattern", () => {
    // mark_glob_run stores the pattern in the session cache.
    const sid = "test-glob-session-001";
    reset_session(sid);
    try {
      const cache = mark_glob_run(sid, "**/*.py", null, 5);
      expect(cache.glob_history.length).toBeGreaterThanOrEqual(1);
      const last = cache.glob_history[cache.glob_history.length - 1]!;
      expect(last.pattern).toBe("**/*.py");
    } finally {
      reset_session(sid);
    }
  });

  it("test_records_result_count", () => {
    // mark_glob_run stores the result_count on the entry.
    const sid = "test-glob-session-002";
    reset_session(sid);
    try {
      const cache = mark_glob_run(sid, "**/*.ts", "src/", 42);
      const entry = cache.glob_history[cache.glob_history.length - 1]!;
      expect(entry.result_count).toBe(42);
      expect(entry.path).toBe("src/");
    } finally {
      reset_session(sid);
    }
  });

  it("test_records_multiple_distinct_patterns", () => {
    // mark_glob_run appends separate entries for distinct patterns.
    const sid = "test-glob-session-003";
    reset_session(sid);
    try {
      mark_glob_run(sid, "**/*.py", null, 10);
      mark_glob_run(sid, "**/*.ts", null, 5);
      const cache = load(sid);
      const patterns = cache.glob_history.map((e) => e.pattern);
      expect(patterns).toContain("**/*.py");
      expect(patterns).toContain("**/*.ts");
    } finally {
      reset_session(sid);
    }
  });
});

// ===========================================================================
// TestLookupGlobEntry — lookup_glob_entry retrieves the most recent match.
// ===========================================================================
describe("TestLookupGlobEntry", () => {
  it("test_returns_entry_for_known_pattern", () => {
    // Returns a GlobEntry when pattern was previously recorded.
    const sid = "test-glob-session-004";
    reset_session(sid);
    try {
      mark_glob_run(sid, "**/*.py", null, 7);
      const entry = lookup_glob_entry(sid, "**/*.py", null);
      expect(entry).not.toBeNull();
      expect(entry!.pattern).toBe("**/*.py");
      expect(entry!.result_count).toBe(7);
    } finally {
      reset_session(sid);
    }
  });

  it("test_returns_none_for_unknown_pattern", () => {
    // Returns None when pattern has not been recorded yet.
    const sid = "test-glob-session-005";
    reset_session(sid);
    try {
      const entry = lookup_glob_entry(sid, "**/*.rb", null);
      expect(entry).toBeNull();
    } finally {
      reset_session(sid);
    }
  });

  it("test_path_scoped_lookup_is_independent", () => {
    // (pattern, path=None) and (pattern, path='src/') are separate entries.
    const sid = "test-glob-session-006";
    reset_session(sid);
    try {
      mark_glob_run(sid, "**/*.py", null, 20);
      mark_glob_run(sid, "**/*.py", "src/", 5);
      const entry_no_path = lookup_glob_entry(sid, "**/*.py", null);
      const entry_with_path = lookup_glob_entry(sid, "**/*.py", "src/");
      expect(entry_no_path).not.toBeNull();
      expect(entry_with_path).not.toBeNull();
      expect(entry_no_path!.result_count).toBe(20);
      expect(entry_with_path!.result_count).toBe(5);
    } finally {
      reset_session(sid);
    }
  });

  it("test_most_recent_entry_returned", () => {
    // Returns the most recent entry when the same pattern is run twice.
    // (Python @pytest.mark.slow used time.sleep(0.01); the TS lookup walks the
    // history in reverse so the later append wins on insertion order — no sleep
    // needed to reproduce the assertion.)
    const sid = "test-glob-session-007";
    reset_session(sid);
    try {
      mark_glob_run(sid, "**/*.py", null, 3);
      mark_glob_run(sid, "**/*.py", null, 99);
      const entry = lookup_glob_entry(sid, "**/*.py", null);
      expect(entry).not.toBeNull();
      expect(entry!.result_count).toBe(99);
    } finally {
      reset_session(sid);
    }
  });
});

// ===========================================================================
// TestBuildGlobDedupHint — build_glob_dedup_hint returns a hint for repeats.
// ===========================================================================
describe("TestBuildGlobDedupHint", () => {
  // PORT: deferred — imports token_goat.hints.build_glob_dedup_hint; the hints
  // module is not yet ported to TS.
  it.skip("test_no_hint_on_first_run", () => {});
  // PORT: deferred — imports token_goat.hints.build_glob_dedup_hint; the hints
  // module is not yet ported to TS.
  it.skip("test_hint_emitted_on_repeat_run", () => {});
});
