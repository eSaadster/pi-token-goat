/**
 * Tests for cross-session manifest deduplication.
 *
 * 1:1 port of tests/test_cross_session_dedup.py.
 *
 * PORT STATUS — fully deferred
 * ----------------------------
 * The Python source imports its three subjects from `token_goat.compact`:
 *     from token_goat.compact import (
 *         merge_session_manifests,
 *         read_all_session_manifests,
 *         write_session_manifest,
 *     )
 *
 * `compact.py` has NOT been ported to TypeScript yet — there is no
 * `ts/src/token_goat/compact.ts`, and none of the three functions
 * (write_session_manifest / read_all_session_manifests / merge_session_manifests)
 * exist anywhere in the TS port (they are NOT in session.ts; a repo-wide grep for
 * both the snake_case and camelCase forms returns nothing). They live solely in
 * src/token_goat/compact.py (lines 4590, 4602, 4626).
 *
 * Because the entire module under test is absent, every test here is `it.skip`
 * with a one-line PORT note rather than importing a nonexistent module (which
 * would break compilation). The describe-block grouping, the it() names, and the
 * assertion polarity each test WOULD use are preserved verbatim from the Python
 * so this file lands as the ready-to-fill harness the moment compact.ts ships —
 * at which point the import below becomes:
 *     import {
 *       merge_session_manifests,
 *       read_all_session_manifests,
 *       write_session_manifest,
 *     } from "../src/token_goat/compact.js";
 * and each it.skip becomes it(), using the per-test data-dir seam from setup.ts
 * (paths.dataDir() is overridden per test there) in place of the Python
 * `patch("token_goat.paths.data_dir", return_value=tmp_path)`.
 *
 * Test-seam mapping (Python -> TS), for when these are un-skipped:
 *  - with patch("token_goat.paths.data_dir", return_value=tmp_path):
 *        -> setup.ts already overrides paths.dataDir() per test to a throwaway
 *           dir; resolve sessions under paths.dataDir() directly. (No explicit
 *           override call is needed beyond what setup.ts does; if a distinct dir
 *           is wanted, call setDataDirOverride from reset.ts.)
 *  - os.utime(file, (t, t)) to back-date mtime
 *        -> fs.utimesSync(file, t, t).
 *  - time.time()
 *        -> Date.now() / 1000 (seconds, matching Python's float epoch seconds).
 *  - .write_text("NOT JSON {{{{", encoding="utf-8")
 *        -> fs.writeFileSync(path, "NOT JSON {{{{", "utf8").
 *  - the _manifest / _entry module-level helpers are reproduced below so the
 *    bodies are drop-in once the import is live.
 */
import { describe, it } from "vitest";

// ---------------------------------------------------------------------------
// Helpers (ported from the Python module-level _manifest / _entry).
// Retained (and exported-shaped) so the skipped bodies are drop-in once
// compact.ts exists. Marked with a leading underscore + a void reference to
// keep `noUnusedLocals` quiet while the suite is deferred.
// ---------------------------------------------------------------------------

interface ManifestEntry {
  rel_path: string;
  hit_count: number;
  last_read_ts: number;
}

interface Manifest {
  session_id: string;
  files: Array<Record<string, unknown>>;
  updated_at: number;
}

/** Python `_manifest(session_id, files)`. */
function _manifest(session_id: string, files: Array<Record<string, unknown>>): Manifest {
  return { session_id, files, updated_at: Date.now() / 1000 };
}

/** Python `_entry(rel_path, hit_count, last_read_ts=0.0)`. */
function _entry(rel_path: string, hit_count: number, last_read_ts = 0.0): ManifestEntry {
  return { rel_path, hit_count, last_read_ts };
}

// Reference the helpers so they are not flagged as unused while every test is
// skipped (the live suite will consume them in each body).
void _manifest;
void _entry;

// ===========================================================================
// write_session_manifest / read_all_session_manifests
// ===========================================================================

describe("cross-session manifest dedup — write/read", () => {
  // PORT: deferred — token_goat.compact not yet ported (write_session_manifest /
  // read_all_session_manifests live in compact.py; no compact.ts exists).
  it.skip("test_write_then_read_round_trip", () => {});

  // PORT: deferred — token_goat.compact not yet ported (read_all_session_manifests).
  it.skip("test_stale_session_excluded", () => {});

  // PORT: deferred — token_goat.compact not yet ported (read_all_session_manifests).
  it.skip("test_corrupt_json_silently_skipped", () => {});

  // PORT: deferred — token_goat.compact not yet ported (read_all_session_manifests).
  it.skip("test_empty_sessions_dir_returns_empty", () => {});
});

// ===========================================================================
// merge_session_manifests
// ===========================================================================

describe("cross-session manifest dedup — merge", () => {
  // PORT: deferred — token_goat.compact not yet ported (merge_session_manifests).
  it.skip("test_no_duplicate_paths_in_merged_result", () => {});

  // PORT: deferred — token_goat.compact not yet ported (merge_session_manifests).
  it.skip("test_higher_hit_count_wins_on_collision", () => {});

  // PORT: deferred — token_goat.compact not yet ported (merge_session_manifests).
  it.skip("test_budget_cap_limits_entries", () => {});

  // PORT: deferred — token_goat.compact not yet ported (merge_session_manifests).
  it.skip("test_single_session_identity", () => {});

  // PORT: deferred — token_goat.compact not yet ported (merge_session_manifests).
  it.skip("test_entries_sorted_by_hit_count_descending", () => {});

  // PORT: deferred — token_goat.compact not yet ported (merge_session_manifests).
  it.skip("test_empty_manifests_returns_empty", () => {});

  // PORT: deferred — token_goat.compact not yet ported (merge_session_manifests).
  it.skip("test_entries_with_missing_rel_path_skipped", () => {});
});
