/**
 * 1:1 port of tests/test_compact.py part 4/6 — classes TestRenderBudgetLines
 * through TestSingleFileInlineDiff (Python lines ~4632-6153). Each Python
 * `def test_*` maps to a vitest `it()` with the SAME name and SAME assertion
 * polarity; each Python `class Test*` maps to a `describe(...)`.
 *
 * STANDALONE file: it replicates the needed top imports + shared test helpers
 * (the conftest `_populate_session` / `_make_session` factories, the
 * `tmp_data_dir` per-test isolation handled by tests/setup.ts) rather than
 * importing them, mirroring the other ported test files.
 *
 * --- helper mapping (Python conftest -> TS inline) ----------------------------
 *   _populate_session(sid, files=3, greps=2, edits=1)  -> _populate_session(...)
 *   _make_session(sid, age_seconds=, edits=, web_fetches=)  -> makeSession(...)
 *   tmp_path (already realpath'd)  -> tmpPath() (fs.realpathSync on mkdtemp)
 *
 * --- session API keyword mapping ----------------------------------------------
 *   mark_file_read(sid, p, offset=O, limit=L)        -> mark_file_read(sid, p, O, L)
 *   mark_file_read(sid, p, offset=O, limit=L, cache=c)-> mark_file_read(sid, p, O, L, {cache:c})
 *   mark_grep(sid, pat, path, result_count=N)        -> mark_grep(sid, pat, path, N)
 *   mark_bash_run(sid, sha, prev, oid, out, err, ec, t) -> same positional
 *   mark_web_fetch(session_id=, url_sha=, ...)        -> positional in TS order
 *
 * --- exactOptionalPropertyTypes -----------------------------------------------
 *   Optional fields are `T | undefined` (never null) unless types.ts says |null.
 *
 * --- DEFERRED / SKIPPED tests -------------------------------------------------
 *  (a) bash_cache: token_goat.bash_cache is not yet ported. Tests that
 *      `from token_goat import bash_cache` (command_hash + load_output round-trip)
 *      are skipped: TestWhatWorkedSection.test_what_worked_in_full_manifest and
 *      .test_what_worked_absent_when_only_failures.
 *  (b) internal-call spy seam: the manifest render path calls _get_whole_repo_diff
 *      / _get_inline_diff_for_file / _get_git_diff_stat_summary / _get_git_diff_stat
 *      / _get_session_commits via LEXICAL module-local bindings (not through the
 *      `compact` namespace object), so vi.spyOn(compact, "...") cannot intercept
 *      them (verified empirically). The Python tests whose assertions depend on
 *      the patched git helper producing a synthetic diff (or on observing the
 *      patched call) are therefore skipped: they would be knowingly-broken.
 *      The "falls back" variants (assert NO inline diff) pass faithfully because
 *      cwd="/proj" does not exist, so the REAL helpers fail-soft to the same
 *      result the mock would produce — those are ported with guard spies.
 *  (c) const monkeypatch seam: _MANIFEST_TIMEOUT_SECS is a module-local `const`
 *      (no setter export), so monkeypatch.setattr(compact,"_MANIFEST_TIMEOUT_SECS",
 *      0.01) has no TS equivalent. The two timeout-trigger tests that depend on it
 *      are skipped; the "no timeout" happy-path test is ported.
 */
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import * as compact from "../src/token_goat/compact.js";
import * as session from "../src/token_goat/session.js";
import * as paths from "../src/token_goat/paths.js";
import type { SessionCache } from "../src/token_goat/session.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Python `time.time()` -> seconds since epoch (float). */
function _now(): number {
  return Date.now() / 1000;
}

/** sha256(text)[:12] — the conftest url_sha shortener. */
function _sha12(text: string): string {
  return createHash("sha256").update(Buffer.from(text, "utf8")).digest("hex").slice(0, 12);
}

/** Unique tmp dir under the OS tmp root (pytest tmp_path analogue). */
let _tmpCounter = 0;
const _tmpRoots: string[] = [];
function tmpPath(): string {
  // realpathSync resolves macOS's /var -> /private/var symlink so the path
  // matches what find_project canonicalises a project root to (pytest's tmp_path
  // is likewise already realpath'd).
  const dir = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), `tg-compact4-${process.pid}-${_tmpCounter++}-`)),
  );
  _tmpRoots.push(dir);
  return dir;
}

afterEach(() => {
  while (_tmpRoots.length) {
    const d = _tmpRoots.pop()!;
    try {
      fs.rmSync(d, { recursive: true, force: true });
    } catch {
      // best-effort
    }
  }
  vi.restoreAllMocks();
});

/**
 * conftest._populate_session — put enough activity in a session to exceed any
 * reasonable min_events threshold.
 */
function _populate_session(
  session_id: string,
  opts: { files?: number; greps?: number; edits?: number } = {},
): void {
  const files = opts.files ?? 3;
  const greps = opts.greps ?? 2;
  const edits = opts.edits ?? 1;
  for (let i = 0; i < files; i++) {
    session.mark_file_read(session_id, `/proj/src/file${i}.py`, 0, 100);
  }
  for (let i = 0; i < greps; i++) {
    session.mark_grep(session_id, `pattern${i}`, "/proj/src");
  }
  for (let i = 0; i < edits; i++) {
    session.mark_file_edited(session_id, `/proj/src/edited${i}.py`);
  }
}

/**
 * conftest._make_session — create and populate a SessionCache with optional
 * backdating and activity. Only the params used in this slice are implemented
 * (age_seconds, edits, web_fetches).
 */
function makeSession(
  session_id: string,
  opts: {
    age_seconds?: number;
    files_read?: number;
    greps?: number;
    edits?: number;
    web_fetches?: Record<string, number> | null;
  } = {},
): SessionCache {
  const age_seconds = opts.age_seconds ?? 0.0;
  const files_read = opts.files_read ?? 0;
  const greps = opts.greps ?? 0;
  const edits = opts.edits ?? 0;
  const web_fetches = opts.web_fetches ?? null;

  let cache = session.load(session_id);
  if (age_seconds > 0) {
    cache.created_ts = _now() - age_seconds;
    cache._invalidate_json_cache();
    session.save(cache);
  }
  for (let i = 0; i < files_read; i++) {
    session.mark_file_read(session_id, `/proj/src/file${i}.py`, 0, 100);
  }
  for (let i = 0; i < greps; i++) {
    session.mark_grep(session_id, `pattern${i}`, "/proj/src");
  }
  for (let i = 0; i < edits; i++) {
    session.mark_file_edited(session_id, `/proj/src/edited${i}.py`);
  }
  if (web_fetches) {
    for (const [url, body_bytes] of Object.entries(web_fetches)) {
      const url_sha = _sha12(url);
      session.mark_web_fetch(
        session_id,
        url_sha,
        url.slice(0, 200),
        `web-${url_sha}`,
        body_bytes,
        200,
        false,
      );
    }
  }
  return session.load(session_id);
}

/** types.SimpleNamespace(...) -> a plain object the _strAttr/_numAttr helpers read. */
type GrepNS = { pattern: string; path: string; result_count: number; ts: number };

/** TestWhatWorkedSection._make_bash_entry — SimpleNamespace bash entry. */
function _make_bash_entry(
  cmd: string,
  exit_code: number,
  ts: number,
  output_id = "",
): {
  cmd_preview: string;
  exit_code: number;
  ts: number;
  output_id: string;
  stdout_bytes: number;
  stderr_bytes: number;
  truncated: boolean;
  run_count: number;
} {
  return {
    cmd_preview: cmd,
    exit_code,
    ts,
    output_id: output_id || `out-${String(Math.abs(_pyHash(cmd)) % 100000).padStart(5, "0")}`,
    stdout_bytes: 800,
    stderr_bytes: 0,
    truncated: false,
    run_count: 1,
  };
}

/**
 * A stand-in for Python's `hash(str)` used only to derive unique output_ids in
 * _make_bash_entry. The exact value is irrelevant (the tests assert on the
 * cmd/section, never the id), so any deterministic per-string number suffices.
 */
function _pyHash(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) {
    h = (Math.imul(31, h) + s.charCodeAt(i)) | 0;
  }
  return h;
}

// ===========================================================================
// compact._render_budget_lines
// ===========================================================================

describe("TestRenderBudgetLines", () => {
  it("test_empty_input_returns_empty", () => {
    const lines: string[] = [];
    const [out, used] = compact._render_budget_lines("### H", lines, 200);
    expect(out).toEqual([]);
    expect(used).toBe(0);
  });

  it("test_all_lines_fit", () => {
    const lines = ["- line one", "- line two"];
    const [out, used] = compact._render_budget_lines("### H", lines, 500);
    expect(out[0]).toBe("### H");
    expect(out.includes("- line one")).toBe(true);
    expect(out.includes("- line two")).toBe(true);
    expect(used > 0).toBe(true);
  });

  it("test_budget_too_tight_returns_empty", () => {
    // Budget of 1 token can't fit header + any content line.
    const [out, used] = compact._render_budget_lines("### Header", ["- x"], 1);
    expect(out).toEqual([]);
    expect(used).toBe(0);
  });

  it("test_partial_fit_stops_early", () => {
    // Five long lines; only the first few should fit in a tight budget.
    const lines: string[] = [];
    for (let i = 0; i < 5; i++) {
      lines.push(`- ${"x".repeat(60)} line ${i}`);
    }
    const [out] = compact._render_budget_lines("### H", lines, 30);
    // Header + at least one line must fit, but not all five.
    expect(1 < out.length && out.length < 6).toBe(true);
    expect(out[0]).toBe("### H");
  });

  it("test_header_always_first", () => {
    const [out] = compact._render_budget_lines("### MySection", ["- a"], 200);
    expect(out[0]).toBe("### MySection");
  });
});

// ===========================================================================
// compact._dedup_grep_entries
// ===========================================================================

describe("TestDedupGrepEntries", () => {
  it("test_single_entry_unchanged", () => {
    const entry: GrepNS = { pattern: "find_fn", path: "/proj/src", result_count: 5, ts: _now() };
    const result = compact._dedup_grep_entries([entry]);
    expect(result.length).toBe(1);
    expect((result[0] as GrepNS).pattern).toBe("find_fn");
  });

  it("test_two_identical_patterns_collapsed_with_times_two", () => {
    const now = _now();
    const entry1: GrepNS = { pattern: "target", path: "/proj/src", result_count: 3, ts: now - 10 };
    const entry2: GrepNS = { pattern: "target", path: "/proj/tests", result_count: 7, ts: now };
    const result = compact._dedup_grep_entries([entry1, entry2]);
    expect(result.length).toBe(1);
    const pattern = (result[0] as GrepNS).pattern;
    expect(pattern).toBe("target [×2]");
  });

  it("test_three_identical_collapsed_with_times_three", () => {
    const now = _now();
    const entry1: GrepNS = { pattern: "needle", path: "/proj/src", result_count: 1, ts: now - 20 };
    const entry2: GrepNS = { pattern: "needle", path: "/proj/tests", result_count: 5, ts: now - 10 };
    const entry3: GrepNS = { pattern: "needle", path: "/proj/docs", result_count: 2, ts: now };
    const result = compact._dedup_grep_entries([entry1, entry2, entry3]);
    expect(result.length).toBe(1);
    const pattern = (result[0] as GrepNS).pattern;
    expect(pattern).toBe("needle [×3]");
  });

  it("test_different_patterns_not_collapsed", () => {
    const now = _now();
    const entry1: GrepNS = { pattern: "alpha", path: "/proj/src", result_count: 3, ts: now };
    const entry2: GrepNS = { pattern: "beta", path: "/proj/src", result_count: 5, ts: now };
    const result = compact._dedup_grep_entries([entry1, entry2]);
    expect(result.length).toBe(2);
    const patterns = new Set(result.map((e) => (e as GrepNS).pattern));
    expect(patterns).toEqual(new Set(["alpha", "beta"]));
  });

  it("test_mixed_dedup_some_dupes_some_unique", () => {
    const now = _now();
    // Pattern "target" appears 2x (oldest and newest)
    const entry1: GrepNS = { pattern: "target", path: "/proj/src", result_count: 1, ts: now - 20 };
    const entry2: GrepNS = { pattern: "target", path: "/proj/tests", result_count: 7, ts: now - 5 };
    // Pattern "unique" appears 1x
    const entry3: GrepNS = { pattern: "unique", path: "/proj/src", result_count: 3, ts: now };
    const result = compact._dedup_grep_entries([entry1, entry2, entry3]);
    expect(result.length).toBe(2);
    const patterns = new Set(result.map((e) => (e as GrepNS).pattern));
    expect(patterns.has("target [×2]")).toBe(true);
    expect(patterns.has("unique")).toBe(true);
  });

  it("test_raw_counts_override_internal_count", () => {
    const now = _now();
    // After dedup by _select_top_grep_entries, only the most-recent entry
    // survives — but the original session had 4 occurrences.
    const survivor: GrepNS = { pattern: "find_all", path: "/proj/src", result_count: 5, ts: now };
    const result = compact._dedup_grep_entries([survivor], { find_all: 4 });
    expect(result.length).toBe(1);
    expect((result[0] as GrepNS).pattern).toBe("find_all [×4]");
  });

  it("test_build_manifest_grep_times_four_annotation", () => {
    const sid = "grep-times-four-abc";
    // Call mark_grep 4x with different scopes; the session accumulates
    // 4 raw GrepEntry rows for the same pattern.
    for (const p of ["/proj/src", "/proj/tests", "/proj/docs", "/proj/lib"]) {
      session.mark_grep(sid, "needle_pattern", p, 3);
    }

    const result = compact.build_manifest(sid);
    expect(result.includes("[×4]")).toBe(true);
  });
});

// ===========================================================================
// compact._group_edited_by_dir
// ===========================================================================

describe("TestGroupEditedByDir", () => {
  it("test_three_files_same_dir_grouped", () => {
    const entries: Array<[string, number]> = [
      ["src/token_goat/compact.py", 3],
      ["src/token_goat/session.py", 2],
      ["src/token_goat/hints.py", 1],
    ];
    const result = compact._group_edited_by_dir(entries, null, 3);
    // Should produce a grouped line, not three separate lines
    expect(result.length).toBe(1);
    const line = result[0]!;
    expect(line.includes("(3 files)")).toBe(true);
    expect(line.includes("compact.py")).toBe(true);
    expect(line.includes("session.py")).toBe(true);
    expect(line.includes("hints.py")).toBe(true);
  });

  it("test_two_files_same_dir_not_grouped", () => {
    const entries: Array<[string, number]> = [
      ["src/compact.py", 2],
      ["src/hints.py", 1],
    ];
    const result = compact._group_edited_by_dir(entries, null, 3);
    // Two files should not be grouped — threshold is 3
    expect(result.length).toBe(2);
    expect(result.every((line) => line.startsWith("- ✎"))).toBe(true);
  });

  it("test_mixed_dirs_each_separate", () => {
    const entries: Array<[string, number]> = [
      ["src/token_goat/compact.py", 2],
      ["tests/test_compact.py", 1],
    ];
    const result = compact._group_edited_by_dir(entries, null, 3);
    // Two different directories → two separate lines
    expect(result.length).toBe(2);
    expect(result.every((line) => line.startsWith("- ✎"))).toBe(true);
  });

  it("test_single_file_unchanged", () => {
    const entries: Array<[string, number]> = [["src/main.py", 5]];
    const result = compact._group_edited_by_dir(entries);
    expect(result.length).toBe(1);
    expect(result[0]!.includes("main.py")).toBe(true);
    expect(result[0]!.includes("×5")).toBe(true);
  });

  it("test_grouped_line_respects_line_cap", () => {
    // Create many files in the same directory with long names
    const entries: Array<[string, number]> = [
      ["src/very_long_directory_name/very_long_file_name_1.py", 5],
      ["src/very_long_directory_name/very_long_file_name_2.py", 4],
      ["src/very_long_directory_name/very_long_file_name_3.py", 3],
      ["src/very_long_directory_name/very_long_file_name_4.py", 2],
      ["src/very_long_directory_name/very_long_file_name_5.py", 1],
    ];
    const result = compact._group_edited_by_dir(entries);
    expect(result.length).toBe(1);
    const line = result[0]!;
    // Line should be capped or have overflow marker
    expect(line.length <= 140 || line.includes("+more")).toBe(true);
  });

  it("test_dirs_sorted_by_edit_weight_not_alphabetically", () => {
    const entries: Array<[string, number]> = [
      ["zzz/hot.py", 10],
      ["zzz/warm.py", 8],
      ["zzz/cool.py", 6],
      ["aaa/cold1.py", 1],
      ["aaa/cold2.py", 1],
      ["aaa/cold3.py", 1],
    ];
    const result = compact._group_edited_by_dir(entries, null, 3);
    expect(result.length).toBe(2);
    // zzz/ has max edit-count 10; aaa/ has max 1 — zzz must come first.
    expect(result[0]!.includes("zzz")).toBe(true);
    expect(result[1]!.includes("aaa")).toBe(true);
  });
});

// ===========================================================================
// build_manifest timeout guard tests
// ===========================================================================

describe("TestBuildManifestTimeout", () => {
  it("test_normal_session_completes_within_timeout", () => {
    const sid = "normal-timeout-session";
    // Add moderate activity
    for (let i = 0; i < 5; i++) {
      session.mark_file_read(sid, `/proj/src/file${i}.py`, 0, 100);
      session.mark_file_edited(sid, `/proj/src/file${i}.py`);
    }
    session.mark_grep(sid, "test", "/proj/src");

    const result = compact.build_manifest(sid);
    // Should not contain timeout warning
    expect(result.toLowerCase().includes("timed out")).toBe(false);
    expect(result).not.toBe("");
  });

  // PORT: deferred — monkeypatches compact._MANIFEST_TIMEOUT_SECS (a module-local
  // `const` with no setter export, not reassignable in TS) AND relies on a slow
  // compact._get_git_diff_stat_summary spy taking effect on the internal manifest
  // render path. That render path calls the helper via a lexical module-local
  // binding, so vi.spyOn(compact, ...) is a no-op (verified empirically); the
  // synthetic sleep never runs, so the timeout note can never fire.
  it.skip("test_slow_git_diff_triggers_timeout_note", () => {
    // PORT: deferred — _MANIFEST_TIMEOUT_SECS const monkeypatch + internal-call spy seam.
  });

  // PORT: deferred — same seam as test_slow_git_diff_triggers_timeout_note.
  it.skip("test_timeout_note_contains_elapsed_seconds", () => {
    // PORT: deferred — _MANIFEST_TIMEOUT_SECS const monkeypatch + internal-call spy seam.
  });
});

// ===========================================================================
// compact._select_top_web_entries — filter dead-end fetches
// (plus the orphaned _render_tasks_section method-block that the Python source
//  re-enters TestSelectTopWebEntries with after a comment break — see py 5122+)
// ===========================================================================

describe("TestSelectTopWebEntries", () => {
  it("test_http_404_error_is_filtered_out", () => {
    const sid = "web-404-test";
    // Create a mature session with one 404 and one 200 fetch
    session.load(sid);

    // Add a 404 error fetch (should be filtered)
    const url_404 = "https://example.com/not-found";
    const url_sha_404 = _sha12(url_404);
    session.mark_web_fetch(sid, url_sha_404, url_404, `web-404-${url_sha_404}`, 500, 404, false);

    // Add two good 200 fetches from different domains (min_lines=2)
    for (const [url_good, extra_bytes] of [
      ["https://docs.example.com/api", 5000],
      ["https://otherdocs.example.org/guide", 4000],
    ] as Array<[string, number]>) {
      const url_sha_good = _sha12(url_good);
      session.mark_web_fetch(sid, url_sha_good, url_good, `web-good-${url_sha_good}`, extra_bytes, 200, false);
    }

    // Make the session mature so web section appears
    let cache = session.load(sid);
    cache.created_ts = _now() - 7200; // 2 hours old
    cache._invalidate_json_cache();
    session.save(cache);

    cache = session.load(sid);
    const manifest = compact._build_manifest_from_cache(cache, sid, 400);
    expect(manifest.includes("docs.example.com")).toBe(true);
    expect(manifest.includes("not-found")).toBe(false);
  });

  it("test_http_500_error_is_filtered_out", () => {
    const sid = "web-500-test";
    session.mark_file_edited(sid, "/proj/app.py");

    const url_500 = "https://api.example.com/v1/data";
    const url_sha_500 = _sha12(url_500);
    session.mark_web_fetch(sid, url_sha_500, url_500, `web-500-${url_sha_500}`, 1000, 500, false);

    let cache = session.load(sid);
    cache.created_ts = _now() - 7200;
    cache._invalidate_json_cache();
    session.save(cache);

    cache = session.load(sid);
    const manifest = compact._build_manifest_from_cache(cache, sid, 400);
    expect(manifest.includes("api.example.com")).toBe(false);
  });

  it("test_small_body_below_threshold_is_filtered", () => {
    const sid = "web-tiny-test";
    session.mark_file_edited(sid, "/proj/app.py");

    const url_tiny = "https://example.com/redirect";
    const url_sha_tiny = _sha12(url_tiny);
    session.mark_web_fetch(sid, url_sha_tiny, url_tiny, `web-tiny-${url_sha_tiny}`, 50, 200, false);

    for (const url_good of ["https://docs.example.com/guide", "https://otherdocs.example.org/ref"]) {
      const url_sha_good = _sha12(url_good);
      session.mark_web_fetch(sid, url_sha_good, url_good, `web-good-${url_sha_good}`, 5000, 200, false);
    }

    let cache = session.load(sid);
    cache.created_ts = _now() - 7200;
    cache._invalidate_json_cache();
    session.save(cache);

    cache = session.load(sid);
    const manifest = compact._build_manifest_from_cache(cache, sid, 800);
    expect(manifest.includes("docs.example.com")).toBe(true);
    expect(manifest.includes("redirect")).toBe(false);
  });

  it("test_normal_fetch_passes_filter", () => {
    const sid = "web-normal-test";
    session.mark_file_edited(sid, "/proj/app.py");

    for (const url of ["https://docs.python.org/3/library/json.html", "https://sqlite.org/json1.html"]) {
      const url_sha = _sha12(url);
      session.mark_web_fetch(sid, url_sha, url, `web-${url_sha}`, 10000, 200, false);
    }

    let cache = session.load(sid);
    cache.created_ts = _now() - 7200;
    cache._invalidate_json_cache();
    session.save(cache);

    cache = session.load(sid);
    const manifest = compact._build_manifest_from_cache(cache, sid, 800);
    expect(manifest.includes("python.org")).toBe(true);
  });

  // --- orphaned _render_tasks_section method-block (py 5122-5206) -------------
  // In the Python source the class header for these methods is absent; the col-0
  // comment break does not close the class, so they remain methods of
  // TestSelectTopWebEntries. Ported here under the same describe to preserve 1:1.

  it("test_no_tasks_returns_empty", () => {
    expect(compact._render_tasks_section([])).toEqual([]);
  });

  it("test_all_completed_returns_empty", () => {
    const tasks = [
      { id: "1", subject: "Deploy to prod", status: "completed" },
      { id: "2", subject: "Write tests", status: "completed" },
    ];
    expect(compact._render_tasks_section(tasks)).toEqual([]);
  });

  it("test_pending_tasks_appear", () => {
    const tasks = [
      { id: "1", subject: "Fix the bug", status: "pending" },
      { id: "2", subject: "Write tests", status: "pending" },
      { id: "3", subject: "Done already", status: "completed" },
    ];
    const lines = compact._render_tasks_section(tasks);
    expect(lines[0]).toBe("**TODOs:**");
    expect(lines.some((ln) => ln.includes("Fix the bug"))).toBe(true);
    expect(lines.some((ln) => ln.includes("Write tests"))).toBe(true);
    // Completed task must not appear
    expect(lines.some((ln) => ln.includes("Done already"))).toBe(false);
  });

  it("test_in_progress_marker", () => {
    const tasks = [{ id: "1", subject: "Active task", status: "in_progress" }];
    const lines = compact._render_tasks_section(tasks);
    expect(lines.some((ln) => ln.includes("[→]"))).toBe(true);
  });

  it("test_in_progress_hyphenated_marker", () => {
    const tasks = [{ id: "1", subject: "Active task", status: "in-progress" }];
    const lines = compact._render_tasks_section(tasks);
    expect(lines.some((ln) => ln.includes("[→]"))).toBe(true);
  });

  it("test_pending_marker", () => {
    const tasks = [{ id: "1", subject: "Pending task", status: "pending" }];
    const lines = compact._render_tasks_section(tasks);
    expect(lines.some((ln) => ln.includes("[ ]"))).toBe(true);
  });

  it("test_subject_truncated_at_60_chars", () => {
    const long_subject = "A".repeat(80);
    const tasks = [{ id: "1", subject: long_subject, status: "pending" }];
    const lines = compact._render_tasks_section(tasks);
    // Find the task line (not the header)
    const task_lines = lines.filter((ln) => ln.startsWith("- "));
    expect(task_lines.length).toBe(1);
    // Subject portion of the line should end with ellipsis and be <=60 chars
    expect(task_lines[0]!.includes("…")).toBe(true);
    const subject_text = task_lines[0]!.slice("- [ ] ".length);
    expect(subject_text.length).toBeLessThanOrEqual(60);
  });

  it("test_max_5_tasks_shown", () => {
    const tasks = Array.from({ length: 10 }, (_, i) => ({
      id: String(i),
      subject: `Task ${i}`,
      status: "pending",
    }));
    const lines = compact._render_tasks_section(tasks);
    const task_lines = lines.filter((ln) => ln.startsWith("- ") && !ln.includes("more"));
    expect(task_lines.length).toBe(5);
  });

  it("test_overflow_note_when_more_than_5", () => {
    const tasks = Array.from({ length: 10 }, (_, i) => ({
      id: String(i),
      subject: `Task ${i}`,
      status: "pending",
    }));
    const lines = compact._render_tasks_section(tasks);
    const overflow_lines = lines.filter((ln) => ln.includes("more"));
    expect(overflow_lines.length).toBe(1);
    expect(overflow_lines[0]!.includes("+5 more")).toBe(true);
  });

  it("test_exactly_5_tasks_no_overflow", () => {
    const tasks = Array.from({ length: 5 }, (_, i) => ({
      id: String(i),
      subject: `Task ${i}`,
      status: "pending",
    }));
    const lines = compact._render_tasks_section(tasks);
    const overflow_lines = lines.filter((ln) => ln.includes("more"));
    expect(overflow_lines).toEqual([]);
  });

  it("test_header_is_first_line", () => {
    const tasks = [{ id: "1", subject: "Do something", status: "pending" }];
    const lines = compact._render_tasks_section(tasks);
    expect(lines[0]).toBe("**TODOs:**");
  });
});

// ===========================================================================
// compact._load_task_list reading from a temp directory
// ===========================================================================

describe("TestLoadTaskList", () => {
  it("test_missing_directory_returns_empty", () => {
    const tmp = tmpPath();
    vi.spyOn(paths, "claudeConfigDir").mockReturnValue(path.join(tmp, "claude"));
    const result = compact._load_task_list("no-such-session");
    expect(result).toEqual([]);
  });

  it("test_reads_pending_task", () => {
    const tmp = tmpPath();
    vi.spyOn(paths, "claudeConfigDir").mockReturnValue(tmp);
    const sid = "test-session-abc";
    const task_dir = path.join(tmp, "tasks", sid);
    fs.mkdirSync(task_dir, { recursive: true });
    fs.writeFileSync(
      path.join(task_dir, "1.json"),
      JSON.stringify({ id: "1", subject: "Fix login", status: "pending" }),
      "utf8",
    );
    const result = compact._load_task_list(sid);
    expect(result.length).toBe(1);
    expect(result[0]!["subject"]).toBe("Fix login");
    expect(result[0]!["status"]).toBe("pending");
  });

  it("test_reads_multiple_tasks", () => {
    const tmp = tmpPath();
    vi.spyOn(paths, "claudeConfigDir").mockReturnValue(tmp);
    const sid = "multi-task-session";
    const task_dir = path.join(tmp, "tasks", sid);
    fs.mkdirSync(task_dir, { recursive: true });
    const statuses = ["pending", "in_progress", "completed"];
    statuses.forEach((status, i) => {
      fs.writeFileSync(
        path.join(task_dir, `${i}.json`),
        JSON.stringify({ id: String(i), subject: `Task ${i}`, status }),
        "utf8",
      );
    });
    const result = compact._load_task_list(sid);
    expect(result.length).toBe(3);
    const resultStatuses = new Set(result.map((t) => t["status"]));
    expect(resultStatuses).toEqual(new Set(["pending", "in_progress", "completed"]));
  });

  it("test_skips_malformed_json", () => {
    const tmp = tmpPath();
    vi.spyOn(paths, "claudeConfigDir").mockReturnValue(tmp);
    const sid = "malformed-session";
    const task_dir = path.join(tmp, "tasks", sid);
    fs.mkdirSync(task_dir, { recursive: true });
    fs.writeFileSync(path.join(task_dir, "bad.json"), "not-json{{{", "utf8");
    const result = compact._load_task_list(sid);
    expect(result).toEqual([]);
  });

  it("test_skips_non_dict_json", () => {
    const tmp = tmpPath();
    vi.spyOn(paths, "claudeConfigDir").mockReturnValue(tmp);
    const sid = "non-dict-session";
    const task_dir = path.join(tmp, "tasks", sid);
    fs.mkdirSync(task_dir, { recursive: true });
    fs.writeFileSync(path.join(task_dir, "1.json"), JSON.stringify([1, 2, 3]), "utf8");
    const result = compact._load_task_list(sid);
    expect(result).toEqual([]);
  });
});

// ===========================================================================
// Integration: _render_tasks_section results appear in the full manifest
// ===========================================================================

describe("TestManifestTODOs", () => {
  it("test_manifest_has_todos_section_when_pending_tasks", () => {
    const tmp = tmpPath();
    vi.spyOn(paths, "claudeConfigDir").mockReturnValue(tmp);

    const sid = "todo-manifest-session";
    const task_dir = path.join(tmp, "tasks", sid);
    fs.mkdirSync(task_dir, { recursive: true });
    ["Alpha task", "Beta task", "Gamma task"].forEach((subject, i) => {
      fs.writeFileSync(
        path.join(task_dir, `${i}.json`),
        JSON.stringify({ id: String(i), subject, status: "pending" }),
        "utf8",
      );
    });

    _populate_session(sid);
    const result = compact.build_manifest(sid);

    expect(result.includes("**TODOs:**")).toBe(true);
    expect(result.includes("Alpha task")).toBe(true);
    expect(result.includes("Beta task")).toBe(true);
    expect(result.includes("Gamma task")).toBe(true);
  });

  it("test_manifest_no_todos_section_when_no_tasks", () => {
    const tmp = tmpPath();
    vi.spyOn(paths, "claudeConfigDir").mockReturnValue(tmp);

    const sid = "no-todo-manifest-session";
    _populate_session(sid);
    const result = compact.build_manifest(sid);

    expect(result.includes("**TODOs:**")).toBe(false);
  });

  it("test_manifest_no_todos_when_all_completed", () => {
    const tmp = tmpPath();
    vi.spyOn(paths, "claudeConfigDir").mockReturnValue(tmp);

    const sid = "completed-todos-session";
    const task_dir = path.join(tmp, "tasks", sid);
    fs.mkdirSync(task_dir, { recursive: true });
    fs.writeFileSync(
      path.join(task_dir, "1.json"),
      JSON.stringify({ id: "1", subject: "Already done", status: "completed" }),
      "utf8",
    );

    _populate_session(sid);
    const result = compact.build_manifest(sid);

    expect(result.includes("**TODOs:**")).toBe(false);
  });

  it("test_manifest_todos_capped_at_5_with_overflow", () => {
    const tmp = tmpPath();
    vi.spyOn(paths, "claudeConfigDir").mockReturnValue(tmp);

    const sid = "many-todos-session";
    const task_dir = path.join(tmp, "tasks", sid);
    fs.mkdirSync(task_dir, { recursive: true });
    for (let i = 0; i < 10; i++) {
      fs.writeFileSync(
        path.join(task_dir, `${i}.json`),
        JSON.stringify({ id: String(i), subject: `Task ${i}`, status: "pending" }),
        "utf8",
      );
    }

    _populate_session(sid);
    const result = compact.build_manifest(sid);

    expect(result.includes("**TODOs:**")).toBe(true);
    expect(result.includes("+5 more")).toBe(true);
  });
});

// ===========================================================================
// TestTop5GuaranteedMin
// ===========================================================================

describe("TestTop5GuaranteedMin", () => {
  it("test_top5_files_appear_despite_tight_budget", () => {
    const sid = "top5-guarantee-tight-budget";
    // Create 20 read files with varying read counts.
    let cache = session.load(sid);
    const saveSpy = vi.spyOn(session, "save").mockImplementation(() => undefined);
    for (let i = 0; i < 20; i++) {
      // Files 0-4 read many more times than files 5-19
      const read_count = i < 5 ? 10 - i : 1;
      const padded = String(i).padStart(2, "0");
      for (let r = 0; r < read_count; r++) {
        cache = session.mark_file_read(sid, `/proj/src/file_${padded}.py`, 0, 50, { cache });
      }
    }
    saveSpy.mockRestore();
    session.save(cache);

    // Use a very small budget to force pressure; top-5 files should still appear.
    const result = compact.build_manifest(sid, { max_tokens: 71 });

    // The most-accessed files (file_00 through file_04) must appear.
    for (let i = 0; i < 5; i++) {
      const padded = String(i).padStart(2, "0");
      expect(result.includes(`file_${padded}.py`)).toBe(true);
    }
  });

  it("test_top5_guaranteed_with_many_edited_files", () => {
    const sid = "top5-guarantee-many-edits";
    let cache = session.load(sid);
    const saveSpy = vi.spyOn(session, "save").mockImplementation(() => undefined);
    // 10 edited files → dynamic max_key_files = 4, but guarantee gives us 5
    for (let i = 0; i < 10; i++) {
      const padded = String(i).padStart(2, "0");
      cache = session.mark_file_edited(sid, `/proj/src/edit_${padded}.py`, { cache });
    }
    // 8 read files; first 5 should always appear (strictly decreasing read counts).
    for (let i = 0; i < 8; i++) {
      const read_count = i < 5 ? Math.max(3, 7 - i) : 1;
      const padded = String(i).padStart(2, "0");
      for (let r = 0; r < read_count; r++) {
        cache = session.mark_file_read(sid, `/proj/src/read_${padded}.py`, 0, 50, { cache });
      }
    }
    saveSpy.mockRestore();
    session.save(cache);

    const result = compact.build_manifest(sid, { max_tokens: 2000 });

    // The top-5 read files by importance must appear (not be cut off at 4).
    for (let i = 0; i < 5; i++) {
      const padded = String(i).padStart(2, "0");
      expect(result.includes(`read_${padded}.py`)).toBe(true);
    }
  });

  it("test_fewer_than_5_files_all_appear", () => {
    const sid = "top5-guarantee-few-files";
    session.mark_file_read(sid, "/proj/src/alpha.py", 0, 100);
    session.mark_file_read(sid, "/proj/src/beta.py", 0, 100);
    session.mark_file_edited(sid, "/proj/src/gamma.py");

    const result = compact.build_manifest(sid, { max_tokens: 200 });

    expect(result.includes("alpha.py")).toBe(true);
    expect(result.includes("beta.py")).toBe(true);
  });

  it("test_top5_const_is_5", () => {
    expect(compact._TOP_FILES_GUARANTEED_MIN).toBe(5);
  });
});

// ===========================================================================
// TestTodosProtected
// ===========================================================================

describe("TestTodosProtected", () => {
  it("test_todos_survive_tight_budget", () => {
    const tmp = tmpPath();
    vi.spyOn(paths, "claudeConfigDir").mockReturnValue(tmp);

    const sid = "todos-protected-tight-budget";
    const task_dir = path.join(tmp, "tasks", sid);
    fs.mkdirSync(task_dir, { recursive: true });
    fs.writeFileSync(
      path.join(task_dir, "1.json"),
      JSON.stringify({ id: "1", subject: "Critical pending task", status: "pending" }),
      "utf8",
    );

    _populate_session(sid, { files: 3, greps: 2, edits: 1 });

    const result = compact.build_manifest(sid, { max_tokens: 180 });

    expect(result.includes("**TODOs:**")).toBe(true);
    expect(result.includes("Critical pending task")).toBe(true);
  });

  it("test_todos_survive_with_many_other_sections", () => {
    const tmp = tmpPath();
    vi.spyOn(paths, "claudeConfigDir").mockReturnValue(tmp);

    const sid = "todos-survive-busy-session";
    const task_dir = path.join(tmp, "tasks", sid);
    fs.mkdirSync(task_dir, { recursive: true });
    const taskDefs: Array<[string, string]> = [
      ["Implement feature X", "in_progress"],
      ["Write tests for Y", "pending"],
      ["Update docs", "pending"],
    ];
    taskDefs.forEach(([subj, status], i) => {
      fs.writeFileSync(
        path.join(task_dir, `${i}.json`),
        JSON.stringify({ id: String(i), subject: subj, status }),
        "utf8",
      );
    });

    // Heavy session: many files, greps, and edits to fill up the budget.
    _populate_session(sid, { files: 8, greps: 5, edits: 3 });

    const result = compact.build_manifest(sid, { max_tokens: 211 });

    expect(result.includes("**TODOs:**")).toBe(true);
    expect(
      ["Implement feature X", "Write tests for Y", "Update docs"].some((subj) => result.includes(subj)),
    ).toBe(true);
  });

  it("test_in_progress_task_survives", () => {
    const tmp = tmpPath();
    vi.spyOn(paths, "claudeConfigDir").mockReturnValue(tmp);

    const sid = "todos-in-progress-survives";
    const task_dir = path.join(tmp, "tasks", sid);
    fs.mkdirSync(task_dir, { recursive: true });
    fs.writeFileSync(
      path.join(task_dir, "1.json"),
      JSON.stringify({ id: "1", subject: "Refactor auth module", status: "in_progress" }),
      "utf8",
    );

    _populate_session(sid);

    const result = compact.build_manifest(sid, { max_tokens: 200 });

    expect(result.includes("**TODOs:**")).toBe(true);
    expect(result.includes("Refactor auth module")).toBe(true);
    // In-progress tasks use the [→] marker.
    expect(result.includes("[→]")).toBe(true);
  });

  it("test_completed_tasks_still_excluded", () => {
    const tmp = tmpPath();
    vi.spyOn(paths, "claudeConfigDir").mockReturnValue(tmp);

    const sid = "todos-completed-excluded";
    const task_dir = path.join(tmp, "tasks", sid);
    fs.mkdirSync(task_dir, { recursive: true });
    fs.writeFileSync(
      path.join(task_dir, "1.json"),
      JSON.stringify({ id: "1", subject: "Already done task", status: "completed" }),
      "utf8",
    );

    _populate_session(sid);

    const result = compact.build_manifest(sid);

    // Completed tasks should never appear — filtering happens before render.
    expect(result.includes("Already done task")).toBe(false);
  });
});

// ===========================================================================
// TestMinLinesSuppressionRegression
// ===========================================================================

describe("TestMinLinesSuppressionRegression", () => {
  it("test_single_web_fetch_still_renders", () => {
    const sid = "web-single-renders";
    makeSession(sid, {
      age_seconds: 7200,
      edits: 1,
      web_fetches: { "https://docs.example.com/api": 12_000 },
    });
    const m = compact.build_manifest(sid, { max_tokens: 400 });
    expect(m.includes("**Web Fetches:**")).toBe(true);
  });

  it("test_two_web_fetches_section_appears", () => {
    const sid = "web-double-render";
    makeSession(sid, {
      age_seconds: 7200,
      edits: 1,
      web_fetches: {
        "https://docs.example.com/api": 12_000,
        "https://other.example.org/guide": 10_000,
      },
    });
    const m = compact.build_manifest(sid, { max_tokens: 600 });
    expect(m.includes("**Web Fetches:**")).toBe(true);
    expect(m.includes("docs.example.com")).toBe(true);
  });
});

// ===========================================================================
// TestWhatWorkedSection (### What Worked manifest section, item #28)
// ===========================================================================

describe("TestWhatWorkedSection", () => {
  it("test_single_green_test_run_appears", () => {
    const now = _now();
    const entry = _make_bash_entry("pytest tests/unit/", 0, now - 120, "abc111");
    const result = compact._select_what_worked({ abc111: entry }, new Set());
    expect(result.length).toBe(1);
    expect((result[0] as { cmd_preview: string }).cmd_preview).toBe("pytest tests/unit/");
  });

  it("test_five_green_runs_yields_two_most_recent", () => {
    const now = _now();
    const history: Record<string, ReturnType<typeof _make_bash_entry>> = {};
    for (let i = 0; i < 5; i++) {
      const id = `id${String(i).padStart(4, "0")}`;
      history[id] = _make_bash_entry(`pytest tests/module${i}.py`, 0, now - (i + 1) * 300, id);
    }
    const result = compact._select_what_worked(history, new Set());
    expect(result.length).toBe(2);
    // Most recent two: i=0 (now-300) and i=1 (now-600)
    const cmds = new Set(result.map((r) => (r as { cmd_preview: string }).cmd_preview));
    expect(cmds.has("pytest tests/module0.py")).toBe(true);
    expect(cmds.has("pytest tests/module1.py")).toBe(true);
  });

  it("test_non_test_green_command_excluded", () => {
    const now = _now();
    const history = {
      gitpush: _make_bash_entry("git push origin main", 0, now - 60, "gitpush"),
      lscmd: _make_bash_entry("ls -la", 0, now - 30, "lscmd"),
    };
    const result = compact._select_what_worked(history, new Set());
    expect(result).toEqual([]);
  });

  it("test_failed_test_run_excluded", () => {
    const now = _now();
    const entry = _make_bash_entry("pytest tests/", 1, now - 60, "failid");
    const result = compact._select_what_worked({ failid: entry }, new Set());
    expect(result).toEqual([]);
  });

  it("test_blocker_id_excluded_even_if_green", () => {
    const now = _now();
    const entry = _make_bash_entry("pytest tests/", 0, now - 60, "blockerid");
    const result = compact._select_what_worked({ blockerid: entry }, new Set(["blockerid"]));
    expect(result).toEqual([]);
  });

  it("test_no_green_runs_no_section", () => {
    const result = compact._render_what_worked_section([], 0.0);
    expect(result).toEqual([]);
  });

  it("test_render_section_header_and_format", () => {
    const now = _now();
    const entries = [_make_bash_entry("pytest tests/unit/", 0, now - 180, "abc999")];
    const lines = compact._render_what_worked_section(entries, now);
    // Item #6: single-line emit — no per-entry bullet, no header-only first line.
    expect(lines.length).toBe(1);
    expect(lines[0]!.startsWith("**Passed:** ")).toBe(true);
    expect(lines[0]!.includes("pytest tests/unit/")).toBe(true);
    // Age compressed to "(3m)" form in the collapsed view.
    expect(lines[0]!.includes("(3m)")).toBe(true);
  });

  it("test_render_cmd_truncated_at_60_chars", () => {
    const now = _now();
    const long_cmd = "pytest " + "x".repeat(60);
    const entries = [_make_bash_entry(long_cmd, 0, now - 60, "longid")];
    const lines = compact._render_what_worked_section(entries, now);
    // Collapsed single-line form: extract the backtick-wrapped cmd.
    const content = lines[0]!;
    const m = /`([^`]+)`/.exec(content);
    expect(m).not.toBeNull();
    const cmd_in_line = m![1]!;
    expect(cmd_in_line.length).toBeLessThanOrEqual(60);
  });

  // PORT: deferred — imports token_goat.bash_cache (command_hash + load_output),
  // which is not yet ported in this layer.
  it.skip("test_what_worked_in_full_manifest", () => {
    // PORT: deferred — token_goat.bash_cache not ported.
  });

  // PORT: deferred — imports token_goat.bash_cache (not yet ported).
  it.skip("test_what_worked_absent_when_only_failures", () => {
    // PORT: deferred — token_goat.bash_cache not ported.
  });

  it("test_various_test_runner_prefixes", () => {
    const now = _now();
    const runners = [
      "uv run pytest -m 'not slow'",
      "npm test",
      "cargo test --release",
      "go test ./...",
      "jest --coverage",
      "mocha test/",
      "make test",
    ];
    for (const cmd of runners) {
      const entry = _make_bash_entry(cmd, 0, now - 60, `id-${Math.abs(_pyHash(cmd))}`);
      const result = compact._select_what_worked({ [entry.output_id]: entry }, new Set());
      expect(result.length).toBe(1);
    }
  });
});

// ===========================================================================
// #20 — Activity-floor suppression
// ===========================================================================

describe("TestActivityFloorSuppression", () => {
  it("test_low_activity_session_suppressed", () => {
    const sid = "floor-low-activity-abc";
    // score = 0
    session.mark_file_read(sid, "/proj/src/file.py", 0, 50);
    const result = compact.build_manifest_adaptive(sid);
    expect(result).toBe("");
  });

  it("test_single_edit_only_suppressed", () => {
    const sid = "floor-one-edit-abc";
    session.mark_file_edited(sid, "/proj/src/foo.py");
    // score = 1 edit × 2 = 2 < 3
    const result = compact.build_manifest_adaptive(sid);
    expect(result).toBe("");
  });

  it("test_two_edits_meets_floor", () => {
    const sid = "floor-two-edits-abc";
    session.mark_file_edited(sid, "/proj/src/foo.py");
    session.mark_file_edited(sid, "/proj/src/bar.py");
    // score = 2 edits × 2 = 4 >= 3
    const result = compact.build_manifest_adaptive(sid);
    expect(result.includes("Token-Goat Session Manifest")).toBe(true);
  });

  it("test_one_edit_plus_bash_meets_floor", () => {
    const sid = "floor-edit-bash-abc";
    session.mark_file_edited(sid, "/proj/src/app.py");
    session.mark_bash_run(sid, "sha-abc", "pytest", "out-abc", 600, 0, 0, false);
    // score = 1×2 + 1×1 = 3 >= 3
    const result = compact.build_manifest_adaptive(sid);
    expect(result.includes("Token-Goat Session Manifest")).toBe(true);
  });

  it("test_session_activity_score_weights", () => {
    const sid = "score-weights-abc";
    session.mark_file_edited(sid, "/proj/a.py"); // +2
    session.mark_file_edited(sid, "/proj/b.py"); // +2
    session.mark_bash_run(sid, "sha-w1", "pytest", "out-w1", 600, 0, 0, false); // +1
    const cache = session.load(sid);
    const score = compact._session_activity_score(cache);
    // 2 edits × 2 + 1 bash × 1 = 5
    expect(score).toBe(5);
  });

  it("test_activity_floor_constant_is_three", () => {
    expect(compact._ACTIVITY_FLOOR).toBe(3);
  });

  it("test_five_edits_well_above_floor", () => {
    const sid = "floor-five-edits-abc";
    for (let i = 0; i < 5; i++) {
      session.mark_file_edited(sid, `/proj/src/file${i}.py`);
    }
    const result = compact.build_manifest_adaptive(sid);
    expect(result.includes("Token-Goat Session Manifest")).toBe(true);
    expect(result.includes("**Staged/Uncommitted:**") || result.includes("**Edited:**")).toBe(true);
  });
});

// ===========================================================================
// #24 — Middle-truncation cap 12 (non-blocker) vs 20 (blocker)
// ===========================================================================

describe("TestMiddleTruncationCap", () => {
  it("test_middle_truncate_non_blocker_caps_at_12", () => {
    const text = Array.from({ length: 30 }, (_, i) => `line ${i}`).join("\n");
    const result = compact._middle_truncate(text, 12);
    // head(5) + marker(1) + tail(5) = 11 visible lines
    const lines = result.split("\n");
    expect(lines.length).toBeLessThanOrEqual(13);
    expect(result.includes("omitted")).toBe(true);
  });

  it("test_middle_truncate_blocker_caps_at_20", () => {
    const text = Array.from({ length: 30 }, (_, i) => `line ${i}`).join("\n");
    const result = compact._middle_truncate(text, 20);
    // head(8) + marker(1) + tail(8) = 17 visible lines
    const lines = result.split("\n");
    expect(lines.length).toBeLessThanOrEqual(21);
    expect(result.includes("omitted")).toBe(true);
  });

  it("test_non_blocker_fewer_lines_than_blocker_for_same_input", () => {
    const text = Array.from({ length: 30 }, (_, i) => `line ${i}`).join("\n");
    const non_blocker = compact._middle_truncate(text, 12);
    const blocker = compact._middle_truncate(text, 20);
    expect(non_blocker.split("\n").length).toBeLessThan(blocker.split("\n").length);
  });

  it("test_format_bash_entry_is_blocker_parameter_exists", () => {
    const entry = {
      cmd_preview: "pytest",
      exit_code: 0,
      output_id: "",
      stdout_bytes: 100,
      stderr_bytes: 0,
      truncated: false,
      run_count: 1,
    };
    // Both calls must not raise; inline_snippet=False skips the disk load
    const line_normal = compact._format_bash_entry(entry, false, { is_blocker: false });
    const line_blocker = compact._format_bash_entry(entry, false, { is_blocker: true });
    expect(line_normal.includes("pytest")).toBe(true);
    expect(line_blocker.includes("pytest")).toBe(true);
  });
});

// ===========================================================================
// #29 — Cold Outputs opt-in for mature sessions only
// ===========================================================================

describe("TestColdOutputsMatureOnly", () => {
  /** Add a bash entry old enough to qualify as a cold output (>30 min). */
  function _make_old_bash_entry(sid: string, age_secs = 2400): void {
    const cmd_sha = `sha-cold-${age_secs}`;
    session.mark_bash_run(sid, cmd_sha, "pytest tests/", `out-cold-${age_secs}`, 800, 0, 0, false);
    // Backdate the bash entry by patching the ts field in the session cache.
    const cache = session.load(sid);
    for (const entry of Object.values(cache.bash_history ?? {})) {
      if (entry.cmd_sha === cmd_sha) {
        entry.ts = _now() - age_secs;
      }
    }
    cache._invalidate_json_cache();
    session.save(cache);
  }

  it("test_active_session_no_cold_outputs", () => {
    const sid = "cold-active-session-abc";
    session.mark_file_edited(sid, "/proj/src/a.py");
    session.mark_file_edited(sid, "/proj/src/b.py");
    _make_old_bash_entry(sid, 2400); // 40 min old, > _COLD_OUTPUT_AGE_SECS
    const cache = session.load(sid);
    // active tier (10-60 min old)
    cache.created_ts = _now() - 1800; // 30 min old → active
    cache._invalidate_json_cache();
    session.save(cache);
    const manifest = compact._build_manifest_from_cache(cache, sid, 800);
    expect(manifest.includes("**Cold:**")).toBe(false);
  });

  it("test_mature_session_has_cold_outputs", () => {
    const sid = "cold-mature-session-abc";
    session.mark_file_edited(sid, "/proj/src/a.py");
    session.mark_file_edited(sid, "/proj/src/b.py");
    _make_old_bash_entry(sid, 2400); // 40 min old
    _make_old_bash_entry(sid, 2500); // second entry (need >=2)
    const cache = session.load(sid);
    // mature (>60 min old)
    cache.created_ts = _now() - 4000; // ~67 min old → mature
    cache._invalidate_json_cache();
    session.save(cache);
    const manifest = compact._build_manifest_from_cache(cache, sid, 800);
    expect(manifest.includes("**Cold:**")).toBe(true);
  });

  it("test_young_session_no_cold_outputs", () => {
    const sid = "cold-young-session-abc";
    session.mark_file_edited(sid, "/proj/src/a.py");
    session.mark_file_edited(sid, "/proj/src/b.py");
    _make_old_bash_entry(sid, 2400);
    const cache = session.load(sid);
    cache.created_ts = _now() - 120; // 2 min old → young
    cache._invalidate_json_cache();
    session.save(cache);
    const manifest = compact._build_manifest_from_cache(cache, sid, 800);
    expect(manifest.includes("**Cold:**")).toBe(false);
  });
});

// ===========================================================================
// #7 — inline diff for top-2 edited files
// ===========================================================================

describe("TestInlineDiffForTop2Edited", () => {
  function _make_two_edited_session(sid: string): void {
    session.mark_file_edited(sid, "src/foo.py");
    session.mark_file_edited(sid, "src/foo.py");
    session.mark_file_edited(sid, "src/bar.py");
    session.mark_file_read(sid, "src/foo.py", 0, 50);
    session.mark_file_read(sid, "src/bar.py", 0, 50);
    session.mark_file_read(sid, "src/baz.py", 0, 50);
  }

  // PORT: deferred — asserts an INLINE diff is present, which requires the patched
  // compact._get_inline_diff_for_file to take effect on the render path. That call
  // resolves through a lexical module-local binding, so vi.spyOn(compact, ...) is a
  // no-op (verified empirically); with no real git repo at cwd the synthetic diff
  // never appears.
  it.skip("test_small_diffs_are_inlined", () => {
    // PORT: deferred — internal-call spy seam (lexical binding, not namespace).
  });

  it("test_large_diff_falls_back_to_entry", () => {
    const sid = "inline-diff-large-abc";
    _make_two_edited_session(sid);

    // Guard spies (install cleanly; the REAL helpers also fail-soft to null at
    // cwd="/proj" which does not exist, so the assertion holds either way).
    vi.spyOn(compact, "_get_inline_diff_for_file").mockImplementation(() => null);
    vi.spyOn(compact, "_get_whole_repo_diff").mockImplementation(() => null);
    vi.spyOn(compact, "_get_git_diff_stat_summary").mockImplementation(() => "");
    vi.spyOn(compact, "_get_session_commits").mockImplementation(() => []);

    const cache = session.load(sid);
    cache.cwd = "/proj";
    cache._invalidate_json_cache();
    session.save(cache);
    const manifest = compact._build_manifest_from_cache(cache, sid, 800);
    expect(manifest.includes("inline diff")).toBe(false);
    // Item #16: high overlap may merge Edited+Files into **Files:**; accept either.
    expect(manifest.includes("**Edited:**") || manifest.includes("**Files:**")).toBe(true);
  });

  // PORT: deferred — requires a per-path patched compact._get_inline_diff_for_file
  // (foo.py → None, bar.py → small) to inline bar.py and observe "inline diff".
  // The internal call uses a lexical binding, so the spy is a no-op and bar.py is
  // never inlined.
  it.skip("test_total_inline_cap_limits_second_file", () => {
    // PORT: deferred — internal-call spy seam (lexical binding, not namespace).
  });

  it("test_slice_diff_for_file_normalizes_backslashes", () => {
    const whole =
      "diff --git a/src/foo.py b/src/foo.py\n" +
      "index 1111111..2222222 100644\n" +
      "--- a/src/foo.py\n" +
      "+++ b/src/foo.py\n" +
      "@@ -1 +1 @@\n" +
      "-old\n" +
      "+new\n";
    expect(compact._slice_diff_for_file(whole, "src\\foo.py")).toBe(whole);
  });
});

// ===========================================================================
// #17 — single-file whole-repo inline diff
// ===========================================================================

describe("TestSingleFileInlineDiff", () => {
  function _make_single_edited_session(sid: string): void {
    session.mark_file_edited(sid, "src/only.py");
    session.mark_file_read(sid, "src/only.py", 0, 50);
    session.mark_file_read(sid, "src/util.py", 0, 50);
    session.mark_file_read(sid, "src/main.py", 0, 50);
  }

  // PORT: deferred — asserts the single-file whole-repo diff is inlined, which
  // requires patched compact._get_whole_repo_diff to take effect on the render
  // path. The internal call uses a lexical binding, so vi.spyOn is a no-op.
  it.skip("test_single_file_small_diff_inlined", () => {
    // PORT: deferred — internal-call spy seam (lexical binding, not namespace).
  });

  it("test_single_file_large_diff_not_inlined", () => {
    const sid = "single-inline-large-abc";
    _make_single_edited_session(sid);

    // Guard spies (the REAL helpers also fail-soft to null at cwd="/proj").
    vi.spyOn(compact, "_get_whole_repo_diff").mockImplementation(() => null);
    vi.spyOn(compact, "_get_inline_diff_for_file").mockImplementation(() => null);
    vi.spyOn(compact, "_get_git_diff_stat_summary").mockImplementation(() => "");
    vi.spyOn(compact, "_get_session_commits").mockImplementation(() => []);

    const cache = session.load(sid);
    cache.cwd = "/proj";
    cache._invalidate_json_cache();
    session.save(cache);
    const manifest = compact._build_manifest_from_cache(cache, sid, 800);
    expect(manifest.includes("inline diff")).toBe(false);
    // Item #16: high overlap may merge Edited+Files into **Files:**; accept either.
    expect(manifest.includes("**Edited:**") || manifest.includes("**Files:**")).toBe(true);
  });

  // PORT: deferred — asserts _get_whole_repo_diff is NEVER called (call-count
  // observed via the closure-captured spy). The internal manifest path resolves
  // the helper through a lexical module-local binding, so vi.spyOn(compact, ...)
  // is a no-op and the spy's call counter cannot observe the (non-)call — making
  // the assertion meaningless. Skipped rather than ported as a misleading test.
  it.skip("test_two_files_skips_single_file_path", () => {
    // PORT: deferred — internal-call spy seam cannot observe the call count.
  });
});
