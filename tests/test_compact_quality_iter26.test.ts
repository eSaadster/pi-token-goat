/**
 * 1:1 port of tests/test_compact_quality_iter26.py — compaction assistance
 * quality improvements (iterations 26-30).
 *
 * Each Python `class Test*` maps to a vitest `describe(...)`; each `def test_*`
 * maps to an `it(...)` with the SAME name and the SAME assertion polarity.
 *
 * Covers:
 *   A. Manifest delta line accuracy (TestManifestDeltaQuality)
 *   B. Session goal inference from bash work patterns (TestInferSessionGoalBashPatterns)
 *   C. Compact-hint token budget accuracy (TestCompactHintTokenBudgetAccuracy)
 *   D. Skills section ordering by recency (TestSkillsOrderedByRecency)
 *   E. Compact skip TTL fast path (TestCompactSkipActivityBustsCache)
 *
 * Mapping notes (Python -> TS):
 *   - compact_test_helpers.clear_process_guard(sid) ->
 *       compact._manifest_sha_written_this_process.delete(sid)
 *     (the helper just does `compact._manifest_sha_written_this_process.discard(sid)`).
 *   - token_goat.hooks_cli._check_compact_skip_sentinel_detail /
 *     _write_compact_skip_sentinel are statically imported from hooks_cli.js.
 *     `_write_compact_skip_sentinel(sid, edited_count=1, bash_count=0)` ->
 *       `_write_compact_skip_sentinel(sid, { edited_count: 1, bash_count: 0 })`.
 *   - paths.manifest_sha_sidecar_path -> paths.manifestShaSidecarPath.
 *   - paths.compact_skip_sentinel_path -> paths.compactSkipSentinelPath.
 *   - session.mark_bash_run(sid, cmd_sha=..., cmd_preview=..., output_id=...,
 *       stdout_bytes=..., stderr_bytes=..., exit_code=..., truncated=...) maps
 *     positionally to mark_bash_run(sid, cmd_sha, cmd_preview, output_id,
 *       stdout_bytes, stderr_bytes, exit_code, truncated).
 *   - session.mark_file_read(sid, p, symbol="X") ->
 *       mark_file_read(sid, p, null, null, { symbol: "X" }).
 *   - SimpleNamespace(...) caches -> plain JS objects with the same own-enumerable
 *     fields (compact reads attributes via getattr-style accessors).
 *   - compact._select_top_skill_entries(history, session_started_ts=now) ->
 *       compact._select_top_skill_entries(history, { session_started_ts: now }).
 *   - os.utime(sentinel, (m, m)) -> fs.utimesSync(sentinel, m, m).
 *
 * Time handling: sub-areas D and E build skill/sentinel state stamped at
 * `time.time()` (real wall-clock). No Date.now() mocking is required — the
 * code-under-test reads the same wall-clock, so the freshly-stamped entries are
 * seen as fresh (mirroring the Python tests, which do not patch any clock).
 *
 * Per-test tmp data dir + cache clearing is handled by tests/setup.ts (the
 * analogue of the Python tmp_data_dir autouse fixture); the `tmp_data_dir` fixture
 * arg on the Python tests therefore has no positional twin here.
 */
import fs from "node:fs";

import { describe, expect, it } from "vitest";

import * as compact from "../src/token_goat/compact.js";
import * as paths from "../src/token_goat/paths.js";
import * as session from "../src/token_goat/session.js";
import { SkillEntry } from "../src/token_goat/session.js";
import {
  _check_compact_skip_sentinel_detail,
  _write_compact_skip_sentinel,
} from "../src/token_goat/hooks_cli.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** clear_process_guard(sid) — evict sid from the per-process manifest-SHA set. */
function clearProcessGuard(sid: string): void {
  compact._manifest_sha_written_this_process.delete(sid);
}

/** time.time() analogue (float seconds). */
function _time(): number {
  return Date.now() / 1000;
}

// ---------------------------------------------------------------------------
// Sub-area A — Manifest delta captures new edited files, bash cmds, symbols
// ---------------------------------------------------------------------------

describe("TestManifestDeltaQuality", () => {
  function _clearProcessGuard(sid: string): void {
    clearProcessGuard(sid);
  }

  it("test_delta_shows_new_edited_files", () => {
    const sid = "quality-delta-edited-a26";
    session.mark_file_edited(sid, "/proj/src/auth.py");
    compact.build_manifest(sid); // first compact establishes baseline

    session.mark_file_edited(sid, "/proj/src/new_file.py");
    session.mark_file_edited(sid, "/proj/src/another.py");

    _clearProcessGuard(sid);
    const second = compact.build_manifest(sid);
    expect(second.includes("Δ since last compact")).toBe(true);
    expect(second.includes("+2 edited")).toBe(true);
  });

  it("test_delta_shows_new_bash_commands", () => {
    const hex8 = Math.random().toString(16).slice(2, 10).padEnd(8, "0");
    const sid = `quality-delta-bash-a26-${hex8}`;
    session.mark_file_edited(sid, "/proj/src/auth.py");
    compact.build_manifest(sid); // first compact

    // Add bash runs after first compact
    session.mark_bash_run(sid, "aa1", "pytest -x tests/", "o1", 2000, 0, 0, false);
    session.mark_bash_run(sid, "bb2", "ruff check src/", "o2", 500, 0, 0, false);

    _clearProcessGuard(sid);
    const second = compact.build_manifest(sid);
    expect(second.includes("Δ since last compact")).toBe(true);
    expect(second.includes("+2 bash")).toBe(true);
  });

  it("test_delta_shows_new_symbols_accessed", () => {
    const sid = "quality-delta-symbols-a26";
    session.mark_file_edited(sid, "/proj/src/auth.py");
    session.mark_file_edited(sid, "/proj/src/login.py");
    // First compact — no symbols yet
    compact.build_manifest(sid);

    // Expire the sidecar so a real rebuild happens (not a stub)
    const sidecar = paths.manifestShaSidecarPath(sid);
    const data = JSON.parse(fs.readFileSync(sidecar, "utf8")) as Record<string, unknown>;
    // Read back prior counts; symbols should be 0
    const prior_counts = (data["counts"] as Record<string, number> | undefined) ?? {};
    data["ts"] = _time() - 700.0;
    fs.writeFileSync(sidecar, JSON.stringify(data), "utf8");
    _clearProcessGuard(sid);

    // Add symbol accesses via mark_file_read with symbol argument
    session.mark_file_read(sid, "/proj/src/auth.py", null, null, { symbol: "login_user" });
    session.mark_file_read(sid, "/proj/src/auth.py", null, null, { symbol: "check_password" });
    session.mark_file_read(sid, "/proj/src/login.py", null, null, { symbol: "generate_token" });

    _clearProcessGuard(sid);
    const second = compact.build_manifest(sid);
    // Symbols delta only appears if the prior sidecar had a different symbol count
    // (the prior sidecar from the first compact should have symbols=0).
    expect(second.includes("## Token-Goat Session Manifest")).toBe(true);
    // With 2 files now having symbols (prev had 0), delta should show +symbols
    if ((prior_counts["symbols"] ?? 0) === 0 && second.includes("Δ since last compact")) {
      expect(
        second.includes("+2 symbols") ||
          second.includes("+1 symbols") ||
          second.includes("symbols"),
      ).toBe(true);
    }
  });

  it("test_delta_has_content_after_realistic_session_activity", () => {
    const sid = "quality-delta-realistic-a26";
    // First compact with minimal state
    session.mark_file_edited(sid, "/proj/src/core.py");
    compact.build_manifest(sid);

    // Simulate continued work: more edits and bash runs
    session.mark_file_edited(sid, "/proj/src/utils.py");
    session.mark_bash_run(sid, "cc3", "pytest --tb=short", "o3", 4000, 0, 1, false);

    _clearProcessGuard(sid);
    const second = compact.build_manifest(sid);

    // The delta line must have at least one +/- term
    if (second.includes("Δ since last compact")) {
      const first_line = second.split("\n")[0]!;
      expect(first_line.includes("+") || first_line.includes("-")).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// Sub-area B — Session goal inference uses bash work patterns
// ---------------------------------------------------------------------------

interface BashHistEntryLike {
  cmd_preview: string;
  exit_code: number;
}

interface CacheLike {
  edited_files: Record<string, number>;
  symbol_access_counts: Record<string, number>;
  bash_history: Record<string, BashHistEntryLike> | null;
}

describe("TestInferSessionGoalBashPatterns", () => {
  /** Build a plain-object cache with edited files and bash history. */
  function cacheWithBash(edited_paths: string[], bash_cmds: string[]): CacheLike {
    const bash_history: Record<string, BashHistEntryLike> = {};
    bash_cmds.forEach((cmd, i) => {
      bash_history[`key${i}`] = { cmd_preview: cmd, exit_code: 0 };
    });
    const edited_files: Record<string, number> = {};
    for (const p of edited_paths) {
      edited_files[p] = 1;
    }
    return { edited_files, symbol_access_counts: {}, bash_history };
  }

  it("test_pytest_runs_inferred_as_testing", () => {
    const cache = cacheWithBash(
      ["/proj/src/a.py", "/proj/src/b.py"],
      ["pytest -x tests/", "pytest tests/auth/", "uv run pytest"],
    );
    const goal = compact.infer_session_goal(cache);
    // Goal should mention 'testing' or the area; not empty
    expect(goal).not.toBe("");
    // If work-mode kicks in, it should mention testing
    expect(goal.toLowerCase().includes("testing") || goal.toLowerCase().includes("src")).toBe(true);
  });

  it("test_ruff_and_mypy_inferred_as_linting_type_checking", () => {
    const cache = cacheWithBash(
      ["/proj/src/a.py", "/proj/src/b.py"],
      ["ruff check src/", "ruff check --fix", "ruff src/"],
    );
    const goal = compact.infer_session_goal(cache);
    expect(goal).not.toBe("");
    // With 3 ruff runs, linting mode should be inferred
    expect(goal.toLowerCase().includes("linting") || goal.toLowerCase().includes("src")).toBe(true);
  });

  it("test_mypy_runs_inferred_as_type_checking", () => {
    const cache = cacheWithBash(
      ["/proj/src/a.py", "/proj/src/b.py"],
      ["mypy src/", "mypy --strict src/", "mypy src/token_goat/"],
    );
    const goal = compact.infer_session_goal(cache);
    expect(goal).not.toBe("");
    expect(goal.toLowerCase().includes("type-checking") || goal.toLowerCase().includes("src")).toBe(
      true,
    );
  });

  it("test_commit_message_takes_priority_over_bash_patterns", () => {
    const cache = cacheWithBash(
      ["/proj/src/a.py", "/proj/src/b.py"],
      [
        "pytest tests/",
        "pytest tests/",
        "pytest tests/",
        'git commit -m "fix: resolve auth token expiry bug"',
      ],
    );
    const goal = compact.infer_session_goal(cache);
    expect(goal).not.toBe("");
    // Commit message should win over bash pattern
    expect(
      goal.toLowerCase().includes("auth token expiry") || goal.toLowerCase().includes("fix"),
    ).toBe(true);
  });

  it("test_single_bash_run_below_threshold_no_mode_hint", () => {
    const cache = cacheWithBash(
      ["/proj/src/a.py", "/proj/src/b.py"],
      ["pytest tests/"], // only 1 run — below threshold
    );
    const goal = compact.infer_session_goal(cache);
    // Goal should still be non-empty (from area signal), but no work-mode suffix
    // if there's only one pytest run. The threshold is >=2.
    if (goal) {
      // Either no "Session activity:" suffix or it's missing entirely
      expect(goal.split(".").length).toBeLessThanOrEqual(3); // at most 2 sentences
    }
  });

  it("test_no_bash_history_still_produces_goal", () => {
    const cache: CacheLike = {
      edited_files: { "/proj/src/a.py": 1, "/proj/src/b.py": 1 },
      symbol_access_counts: { foo: 3, bar: 2 },
      bash_history: null,
    };
    const goal = compact.infer_session_goal(cache);
    expect(goal).not.toBe("");
    expect(goal.toLowerCase().includes("src") || goal.toLowerCase().includes("foo")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Sub-area C — Compact-hint token estimate uses same formula as build_manifest
// ---------------------------------------------------------------------------

describe("TestCompactHintTokenBudgetAccuracy", () => {
  it("test_estimate_tokens_formula_matches_manifest_size", () => {
    // Build a manifest directly and check that estimate_tokens matches
    // the expected formula: max(1, len(text) // 3 + 1)
    const sample_text = "## Token-Goat Session Manifest\n" + "x".repeat(300);
    const result = compact.estimate_tokens(sample_text);
    const expected = Math.max(1, Math.floor(sample_text.length / 3) + 1);
    expect(result).toBe(expected);
  });

  it("test_estimate_tokens_consistent_with_character_length", () => {
    const sid = "quality-token-budget-c26";
    session.mark_file_edited(sid, "/proj/src/auth.py");
    session.mark_file_edited(sid, "/proj/src/login.py");
    session.mark_bash_run(sid, "dd4", "pytest tests/", "o4", 3000, 0, 0, false);

    const manifest = compact.build_manifest(sid);
    expect(manifest).toBeTruthy(); // non-empty

    const token_estimate = compact.estimate_tokens(manifest);
    const char_count = manifest.length;

    // The formula is max(1, len(text) // 3 + 1), so estimate should be
    // approximately char_count / 3.
    const expected = Math.max(1, Math.floor(char_count / 3) + 1);
    expect(token_estimate).toBe(expected);
  });

  it("test_estimate_tokens_is_same_function_as_render_uses", async () => {
    // The compact-hint command calls compact_mod.estimate_tokens(manifest).
    // The _render function uses estimate_tokens from the same module.
    // Verify they're the same callable.
    const { estimate_tokens: render_estimate } = await import("../src/token_goat/compact.js");
    // compact.estimate_tokens is what compact-hint calls
    expect(render_estimate).toBe(compact.estimate_tokens);
  });

  it("test_empty_text_estimate_returns_one", () => {
    expect(compact.estimate_tokens("")).toBe(1);
  });

  it("test_token_estimate_grows_with_manifest_length", () => {
    const sid_short = "quality-token-short-c26";
    const sid_long = "quality-token-long-c26";

    // Short manifest: one edited file
    session.mark_file_edited(sid_short, "/proj/src/a.py");
    const short_manifest = compact.build_manifest(sid_short);

    // Long manifest: many edited files + bash runs
    for (let i = 0; i < 8; i++) {
      session.mark_file_edited(sid_long, `/proj/src/file${i}.py`);
    }
    for (let i = 0; i < 4; i++) {
      session.mark_bash_run(sid_long, `ee${i}`, `pytest tests/module${i}/`, `o5${i}`, 5000, 0, 0, false);
    }
    const long_manifest = compact.build_manifest(sid_long);

    if (short_manifest && long_manifest) {
      const short_tokens = compact.estimate_tokens(short_manifest);
      const long_tokens = compact.estimate_tokens(long_manifest);
      expect(long_tokens).toBeGreaterThanOrEqual(short_tokens);
    }
  });
});

// ---------------------------------------------------------------------------
// Sub-area D — Skills section: most-recently-used skills appear first
// ---------------------------------------------------------------------------

describe("TestSkillsOrderedByRecency", () => {
  function makeSkill(name: string, ts: number, run_count = 1): SkillEntry {
    return new SkillEntry({
      skill_name: name,
      output_id: `oid_${name}`,
      content_sha: `sha_${name}`,
      ts,
      body_bytes: 1000,
      run_count,
    });
  }

  it("test_skill_used_5min_ago_beats_skill_used_2h_ago", () => {
    const now = _time();
    const history: Record<string, SkillEntry> = {
      old_skill: makeSkill("old_skill", now - 7200, 1),
      recent_skill: makeSkill("recent_skill", now - 300, 1),
    };
    const result = compact._select_top_skill_entries(history, { session_started_ts: now - 7200 });
    const names = result.map((e) => String((e as { skill_name?: string }).skill_name ?? ""));
    expect(names.indexOf("recent_skill")).toBeLessThan(names.indexOf("old_skill"));
  });

  it("test_skill_used_1min_ago_is_first", () => {
    const now = _time();
    const history: Record<string, SkillEntry> = {
      skill_a: makeSkill("skill_a", now - 3600, 3),
      skill_b: makeSkill("skill_b", now - 1800, 2),
      skill_c: makeSkill("skill_c", now - 60, 1),
    };
    const result = compact._select_top_skill_entries(history, { session_started_ts: now - 7200 });
    const names = result.map((e) => String((e as { skill_name?: string }).skill_name ?? ""));
    expect(names[0]).toBe("skill_c");
  });

  it("test_skill_loaded_at_session_start_still_included", () => {
    const session_start = _time() - 3600; // 1h ago
    const history: Record<string, SkillEntry> = {
      ralph: makeSkill("ralph", session_start + 10, 1),
    };
    const result = compact._select_top_skill_entries(history, { session_started_ts: session_start });
    const names = result.map((e) => String((e as { skill_name?: string }).skill_name ?? ""));
    expect(names.includes("ralph")).toBe(true);
  });

  it("test_skills_outside_session_excluded", () => {
    const session_start = _time() - 3600;
    const history: Record<string, SkillEntry> = {
      pre_session: makeSkill("pre_session", session_start - 7200, 1),
      in_session: makeSkill("in_session", session_start + 60, 1),
    };
    const result = compact._select_top_skill_entries(history, { session_started_ts: session_start });
    const names = result.map((e) => String((e as { skill_name?: string }).skill_name ?? ""));
    expect(names.includes("in_session")).toBe(true);
    expect(names.includes("pre_session")).toBe(false);
  });

  it("test_five_minute_skills_all_outrank_hourly_skills", () => {
    const now = _time();
    const history: Record<string, SkillEntry> = {
      fresh_a: makeSkill("fresh_a", now - 60, 1),
      fresh_b: makeSkill("fresh_b", now - 180, 1),
      stale_x: makeSkill("stale_x", now - 4000, 5),
      stale_y: makeSkill("stale_y", now - 5000, 3),
    };
    const result = compact._select_top_skill_entries(history, { session_started_ts: now - 7200 });
    const names = result.map((e) => String((e as { skill_name?: string }).skill_name ?? ""));
    const fresh_max_rank = Math.max(names.indexOf("fresh_a"), names.indexOf("fresh_b"));
    const stale_min_rank = Math.min(names.indexOf("stale_x"), names.indexOf("stale_y"));
    expect(fresh_max_rank).toBeLessThan(stale_min_rank);
  });
});

// ---------------------------------------------------------------------------
// Sub-area E — Compact skip TTL: activity after sentinel causes re-compute
// ---------------------------------------------------------------------------

describe("TestCompactSkipActivityBustsCache", () => {
  it("test_new_edit_after_sentinel_causes_recompute", () => {
    const sid = "quality-skip-edit-e26";
    // Write sentinel with current state (1 edited file)
    session.mark_file_edited(sid, "/proj/src/auth.py");
    _write_compact_skip_sentinel(sid, { edited_count: 1, bash_count: 0 });

    // Fresh sentinel → should skip
    const before = _check_compact_skip_sentinel_detail(sid);
    expect(before.should_skip).toBe(true);

    // Now add a second edit (activity after sentinel creation)
    session.mark_file_edited(sid, "/proj/src/new_feature.py");

    // After activity, sentinel should be busted
    const after = _check_compact_skip_sentinel_detail(sid);
    expect(after.should_skip).toBe(false);
  });

  it("test_new_bash_run_after_sentinel_causes_recompute", () => {
    const sid = "quality-skip-bash-e26";
    session.mark_file_edited(sid, "/proj/src/auth.py");
    _write_compact_skip_sentinel(sid, { edited_count: 1, bash_count: 0 });

    const before = _check_compact_skip_sentinel_detail(sid);
    expect(before.should_skip).toBe(true);

    // Add a bash run after the sentinel was written
    session.mark_bash_run(sid, "ff5", "pytest tests/", "o6", 2500, 0, 0, false);

    const after = _check_compact_skip_sentinel_detail(sid);
    expect(after.should_skip).toBe(false);
  });

  it("test_no_activity_after_sentinel_still_skips", () => {
    const sid = "quality-skip-nochange-e26";
    session.mark_file_edited(sid, "/proj/src/auth.py");
    _write_compact_skip_sentinel(sid, { edited_count: 1, bash_count: 0 });

    const result = _check_compact_skip_sentinel_detail(sid);
    expect(result.should_skip).toBe(true);
  });

  it("test_multiple_edits_and_bash_all_bust_sentinel", () => {
    const sid = "quality-skip-both-e26";
    session.mark_file_edited(sid, "/proj/src/a.py");
    session.mark_bash_run(sid, "gg6", "pytest", "o7", 1000, 0, 0, false);
    // Sentinel records current state: 1 edit, 1 bash
    _write_compact_skip_sentinel(sid, { edited_count: 1, bash_count: 1 });

    // Verify fresh
    expect(_check_compact_skip_sentinel_detail(sid).should_skip).toBe(true);

    // Add more edits AND bash runs
    session.mark_file_edited(sid, "/proj/src/b.py");
    session.mark_bash_run(sid, "hh7", "ruff check", "o8", 200, 0, 0, false);

    // Sentinel should now be busted (both counts increased)
    const result = _check_compact_skip_sentinel_detail(sid);
    expect(result.should_skip).toBe(false);
  });

  it("test_ttl_expiry_also_causes_recompute", () => {
    const sid = "quality-skip-ttl-e26";
    session.mark_file_edited(sid, "/proj/src/auth.py");
    _write_compact_skip_sentinel(sid, { edited_count: 1, bash_count: 0 });

    // Backdate the sentinel by > TTL (default 300 s)
    const sentinel = paths.compactSkipSentinelPath(sid);
    const old_mtime = _time() - 400; // 400 s ago > default 300 s TTL
    fs.utimesSync(sentinel, old_mtime, old_mtime);

    const result = _check_compact_skip_sentinel_detail(sid);
    expect(result.should_skip).toBe(false);
  });
});
