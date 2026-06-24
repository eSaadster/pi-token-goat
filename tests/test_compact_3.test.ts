/**
 * 1:1 port of tests/test_compact.py part 3/6 — classes TestImportanceScore
 * through TestCapLine (Python lines ~3140-4631).
 *
 * Each Python `class Test*` maps to a `describe(...)`; each `def test_*` maps to
 * an `it()` with the SAME name and the SAME assertion polarity. Helpers that the
 * Python module pulled from sibling test modules (_make_entry, the per-test
 * tmp_data_dir fixture, the monotonic clock) are replicated inline here so this
 * file is standalone.
 *
 * Test-seam mapping (Python -> TS), matching the shipped Layer 1-4b modules:
 *   - tmp_data_dir fixture
 *       -> setup.ts's setDataDirOverride per test (its beforeEach already runs).
 *   - monkeypatch.setattr(session.time, "time", itertools.count(1e9, 0.01))
 *       -> vi.spyOn(Date, "now") returning a monotonic ms counter. The TS
 *          session stamps timestamps from Date.now()/1000, so an incrementing
 *          Date.now() reproduces the strictly-increasing clock the Python test
 *          installed (same convention as ts/tests/test_session.test.ts).
 *   - compact._importance_score(entry, now, edit_bonus=15.0)
 *       -> _importance_score(entry, now, 15.0)  (edit_bonus is the 3rd positional
 *          arg in the TS port, not an opts field).
 *   - compact.build_manifest(sid, max_tokens=N)
 *       -> build_manifest(sid, { max_tokens: N }).
 *   - compact.compute_adaptive_budget(cache, age_seconds=A, has_*=...)
 *       -> compute_adaptive_budget(cache, A, { has_pending_diff, ... }).
 *   - session.mark_file_read(sid, p, offset=O, limit=L, symbol="X")
 *       -> mark_file_read(sid, p, O, L, { symbol }); a symbol-only read passes
 *          (sid, p, null, null, { symbol }).
 *   - session.mark_file_edited(sid, p, cache=c) -> mark_file_edited(sid, p, { cache: c }).
 *
 * monkeypatch.setattr(compact, "_get_uncommitted_changes", ...) and friends:
 *   _get_uncommitted_changes / _get_git_diff_stat are module-private in the TS
 *   port (not exported, called via local bindings inside the manifest builders),
 *   so a namespace-level vi.spyOn cannot intercept them — the same situation
 *   ts/tests/test_hints.test.ts documents for _line_count / _hint_from_index.
 *   The exported git helpers (_get_git_diff_stat_summary, _get_session_commits)
 *   ARE spied. The behaviour the Python monkeypatches were guarding (no real git
 *   subprocess noise) holds regardless: the fake /proj/... cwd is not a git repo,
 *   so the real helpers fail soft and return "" / null. The spies on exported
 *   helpers are retained; the private ones are noted inline.
 *
 * Per-test tmp data dir + cache clearing is handled by tests/setup.ts.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import * as compact from "../src/token_goat/compact.js";
import * as session from "../src/token_goat/session.js";
import {
  build_manifest,
  build_manifest_with_count,
  compute_adaptive_budget,
  estimate_tokens,
  event_count,
  _build_manifest_from_cache,
  _cap_line,
  _importance_score,
  _rank_symbols_by_recency,
  _render,
  _section_budgets,
  _session_age_tier,
  _short_path,
  _manifest_sha_written_this_process,
} from "../src/token_goat/compact.js";
import { FileEntry, SessionCache, SkillEntry } from "../src/token_goat/session.js";
import { _GLOB_DEDUP_MIN_RESULT_COUNT } from "../src/token_goat/hints.js";

afterEach(() => {
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Python's module-level _make_entry: construct a FileEntry for _importance_score. */
function _make_entry(
  path: string,
  opts: { read_count?: number; symbols?: string[] | null; last_read_ts?: number | null } = {},
): FileEntry {
  const read_count = opts.read_count ?? 1;
  const symbols = opts.symbols ?? null;
  const last_read_ts = opts.last_read_ts ?? Date.now() / 1000;
  return new FileEntry({
    rel_or_abs: path,
    last_read_ts,
    read_count,
    line_ranges: [],
    symbols_read: symbols ?? [],
  });
}

/** time.time() analogue. */
function _now(): number {
  return Date.now() / 1000;
}

/**
 * Install a strictly-increasing clock — the TS analogue of
 * monkeypatch.setattr(session.time, "time", itertools.count(1e9, 0.01)). The
 * session stamps from Date.now()/1000, so we return ms incrementing by 10
 * (= +0.01s) per call.
 */
function installMonotonicClock(): void {
  let nowMs = 1_000_000_000_000; // 1e9 seconds, in ms
  vi.spyOn(Date, "now").mockImplementation(() => {
    const cur = nowMs;
    nowMs += 10; // +0.01s per call
    return cur;
  });
}

// ===========================================================================
// TestImportanceScore
// ===========================================================================
describe("TestImportanceScore", () => {
  it("test_file_with_symbols_outranks_file_with_more_reads", () => {
    const now = _now();
    const entry_a = _make_entry("/proj/scanned.py", { read_count: 5, symbols: [], last_read_ts: now - 10 });
    const entry_b = _make_entry("/proj/symbolic.py", {
      read_count: 1,
      symbols: ["a", "b", "c", "d", "e"],
      last_read_ts: now - 10,
    });

    const score_a = _importance_score(entry_a, now);
    const score_b = _importance_score(entry_b, now);

    expect(score_b > score_a).toBe(true);
  });

  it("test_edited_file_outranks_unedited_files", () => {
    const now = _now();
    const entry_heavy = _make_entry("/proj/heavy.py", { read_count: 10, symbols: [], last_read_ts: now - 1 });
    const entry_edited = _make_entry("/proj/edited.py", { read_count: 1, symbols: [], last_read_ts: now - 1 });

    const score_heavy = _importance_score(entry_heavy, now, 0.0);
    const score_edited = _importance_score(entry_edited, now, 15.0);

    expect(score_edited > score_heavy).toBe(true);
  });

  it("test_older_file_scores_lower_than_recent_file", () => {
    const now = _now();
    const entry_recent = _make_entry("/proj/recent.py", { read_count: 2, symbols: [], last_read_ts: now - 5 });
    const entry_old = _make_entry("/proj/old.py", { read_count: 2, symbols: [], last_read_ts: now - 7200 });

    const score_recent = _importance_score(entry_recent, now);
    const score_old = _importance_score(entry_old, now);

    expect(score_recent > score_old).toBe(true);
  });

  it("test_read_count_capped_at_ten", () => {
    const now = _now();
    const entry_10 = _make_entry("/proj/a.py", { read_count: 10, symbols: [], last_read_ts: now });
    const entry_50 = _make_entry("/proj/b.py", { read_count: 50, symbols: [], last_read_ts: now });

    expect(_importance_score(entry_10, now)).toBe(_importance_score(entry_50, now));
  });

  it("test_symbol_count_capped_at_twenty", () => {
    const now = _now();
    const syms20: string[] = [];
    for (let i = 0; i < 20; i++) syms20.push(`s${i}`);
    const syms50: string[] = [];
    for (let i = 0; i < 50; i++) syms50.push(`s${i}`);
    const entry_20 = _make_entry("/proj/a.py", { read_count: 1, symbols: syms20, last_read_ts: now });
    const entry_50 = _make_entry("/proj/b.py", { read_count: 1, symbols: syms50, last_read_ts: now });

    expect(_importance_score(entry_20, now)).toBe(_importance_score(entry_50, now));
  });

  it("test_recency_max_at_zero_age", () => {
    const now = _now();
    const entry = _make_entry("/proj/fresh.py", { read_count: 0, symbols: [], last_read_ts: now });
    const score = _importance_score(entry, now);
    // read_score=0, symbol_score=0, edit_bonus=0, recency=exp(0)*3.0=3.0
    expect(Math.abs(score - 3.0)).toBeLessThan(0.01);
  });

  it("test_recency_half_life_at_thirty_minutes", () => {
    const now = _now();
    const age = 1800.0; // 30 minutes — one half-life
    const entry = _make_entry("/proj/halflife.py", { read_count: 0, symbols: [], last_read_ts: now - age });
    const score = _importance_score(entry, now);
    // recency = 0.5 * 3.0 = 1.5
    expect(Math.abs(score - 1.5)).toBeLessThan(0.05);
  });
});

// ===========================================================================
// TestImportanceScoringInManifest
// ===========================================================================
describe("TestImportanceScoringInManifest", () => {
  it("test_symbol_file_outranks_scan_heavy_file_in_manifest", () => {
    const sid = "importance-sym-vs-reads-session";
    for (let i = 0; i < 4; i++) {
      session.mark_file_read(sid, "/proj/src/scanned.py", 0, 50);
    }
    session.mark_file_read(sid, "/proj/src/symbolic.py", null, null, { symbol: "parse_tree" });
    session.mark_file_read(sid, "/proj/src/symbolic.py", null, null, { symbol: "walk_nodes" });
    session.mark_file_read(sid, "/proj/src/symbolic.py", null, null, { symbol: "emit_tokens" });

    const result = build_manifest(sid);
    expect(result.includes("scanned.py")).toBe(true);
    expect(result.includes("symbolic.py")).toBe(true);

    expect(result.indexOf("symbolic.py") < result.indexOf("scanned.py")).toBe(true);
  });

  it("test_edited_file_appears_before_unedited_in_manifest", () => {
    const sid = "importance-edit-before-reads-session";
    for (let i = 0; i < 8; i++) {
      session.mark_file_read(sid, "/proj/src/read_heavy.py", 0, 50);
    }
    session.mark_file_edited(sid, "/proj/src/edited_once.py");

    const result = build_manifest(sid);
    expect(result.includes("edited_once.py")).toBe(true);
    expect(result.includes("read_heavy.py")).toBe(true);
    const edited_header = result.includes("**Staged/Uncommitted:**") ? "**Staged/Uncommitted:**" : "**Edited:**";
    expect(result.includes(edited_header)).toBe(true);
    expect(result.indexOf(edited_header) < result.indexOf("**Files:**")).toBe(true);
    expect(result.indexOf("edited_once.py") < result.indexOf("read_heavy.py")).toBe(true);
  });

  it("test_recently_read_file_outranks_older_file_when_counts_tie", () => {
    installMonotonicClock();
    const sid = "importance-recency-tie-session";
    session.mark_file_read(sid, "/proj/src/older.py", 0, 50);
    session.mark_file_read(sid, "/proj/src/older.py", 50, 50);
    session.mark_file_read(sid, "/proj/src/newer.py", 0, 50);
    session.mark_file_read(sid, "/proj/src/newer.py", 50, 50);

    const result = build_manifest(sid);
    expect(result.includes("older.py")).toBe(true);
    expect(result.includes("newer.py")).toBe(true);

    if (result.includes("**Files:**")) {
      const key_section = result.split("**Files:**")[1]!;
      expect(key_section.indexOf("newer.py") < key_section.indexOf("older.py")).toBe(true);
    } else {
      expect(result.indexOf("newer.py") < result.indexOf("older.py")).toBe(true);
    }
  });
});

// ===========================================================================
// TestSessionAgeTier
// ===========================================================================
describe("TestSessionAgeTier", () => {
  it("test_zero_seconds_is_young", () => {
    expect(_session_age_tier(0)).toBe("young");
  });

  it("test_just_below_10min_is_young", () => {
    expect(_session_age_tier(599)).toBe("young");
  });

  it("test_exactly_10min_is_active", () => {
    expect(_session_age_tier(600)).toBe("active");
  });

  it("test_just_below_60min_is_active", () => {
    expect(_session_age_tier(3599)).toBe("active");
  });

  it("test_exactly_60min_is_mature", () => {
    expect(_session_age_tier(3600)).toBe("mature");
  });

  it("test_two_hours_is_mature", () => {
    expect(_session_age_tier(7200)).toBe("mature");
  });
});

// ===========================================================================
// TestComputeAdaptiveBudgetWithAge
// ===========================================================================
describe("TestComputeAdaptiveBudgetWithAge", () => {
  it("test_young_session_reduces_budget", () => {
    const sid = "young-age-budget";
    session.mark_file_edited(sid, "/proj/a.py");
    session.mark_file_edited(sid, "/proj/b.py");
    const cache = session.load(sid);
    const budget = compute_adaptive_budget(cache, 0.0);
    // raw=300 × 0.6 = 180 → floor clamps to 200
    expect(budget).toBe(200);
  });

  it("test_young_session_floor_clamped", () => {
    const sid = "young-floor-clamp";
    const cache = session.load(sid);
    const budget = compute_adaptive_budget(cache, 0.0);
    expect(budget).toBe(200);
  });

  it("test_active_session_no_change", () => {
    const sid = "active-age-budget";
    session.mark_file_edited(sid, "/proj/a.py");
    session.mark_file_edited(sid, "/proj/b.py");
    const cache = session.load(sid);
    const budget_active = compute_adaptive_budget(cache, 1800);
    const budget_no_age = compute_adaptive_budget(cache, 0.0);
    expect(budget_active).toBe(300);
    expect(budget_active > budget_no_age).toBe(true);
  });

  it("test_mature_session_increases_budget", () => {
    const sid = "mature-age-budget";
    // 36 edits in 120 min → density = 0.30/min ≥ threshold → full mature factor (1.4).
    // raw = 200 + min(200, 36 × 50) = 400; × 1.4 = 560.
    // Batch the writes via the cache= seam to avoid N×(load+save) and mirror the
    // Python patch.object(_session_mod, "save", ...) suppression.
    const saveSpy = vi.spyOn(session, "save").mockImplementation(() => undefined);
    let cache = session.load(sid);
    for (let i = 0; i < 36; i++) {
      cache = session.mark_file_edited(sid, `/proj/e${i}.py`, { cache });
    }
    saveSpy.mockRestore();
    session.save(cache);
    cache = session.load(sid);
    const budget = compute_adaptive_budget(cache, 7200);
    expect(budget).toBe(560);
  });

  it("test_mature_session_low_activity_downgraded", () => {
    const sid = "mature-low-activity";
    session.mark_file_edited(sid, "/proj/a.py");
    session.mark_file_edited(sid, "/proj/b.py");
    const cache = session.load(sid);
    const budget = compute_adaptive_budget(cache, 7200);
    expect(budget).toBe(300);
  });

  it("test_mature_session_capped_at_800", () => {
    const sid = "mature-ceiling";
    const saveSpy = vi.spyOn(session, "save").mockImplementation(() => undefined);
    let cache = session.load(sid);
    for (let i = 0; i < 10; i++) {
      cache = session.mark_file_edited(sid, `/proj/e${i}.py`, { cache });
    }
    for (let i = 0; i < 10; i++) {
      cache = session.mark_file_read(sid, `/proj/s${i}.py`, null, null, { symbol: `fn_${i}`, cache });
    }
    cache = session.mark_bash_run(sid, "sha_ceil", "pytest", "id_ceil", 2000, 1000, 0, false, { cache });
    saveSpy.mockRestore();
    session.save(cache);
    cache = session.load(sid);
    const budget = compute_adaptive_budget(cache, 7200);
    expect(budget).toBeLessThanOrEqual(800);
  });

  it("test_default_age_zero_treated_as_young", () => {
    const sid = "default-age-young";
    for (let i = 0; i < 4; i++) {
      session.mark_file_edited(sid, `/proj/e${i}.py`);
    }
    const cache = session.load(sid);
    // With no age arg: raw=200+200=400 × 0.6 = 240
    const budget_default = compute_adaptive_budget(cache);
    const budget_explicit = compute_adaptive_budget(cache, 0.0);
    expect(budget_default).toBe(budget_explicit);
    expect(budget_default).toBe(240);
  });
});

// ===========================================================================
// TestYoungSessionOmitsBashSection
// (also carries the 3 uncommitted-bonus methods that Python's AST attaches here)
// ===========================================================================
describe("TestYoungSessionOmitsBashSection", () => {
  it("test_young_session_omits_bash_section", () => {
    const sid = "young-no-bash-abc";
    session.mark_file_edited(sid, "/proj/src/app.py");
    session.mark_bash_run(sid, "sha_young_bash", "pytest -x", "out_young_001", 2000, 100, 0, false);
    const cache = session.load(sid);
    cache.created_ts = _now() - 120;
    session.save(cache);

    const result = build_manifest(sid);
    expect(result.includes("**Recent Commands:**")).toBe(false);
  });

  it("test_young_session_omits_cold_outputs", () => {
    const sid = "young-no-cold-abc";
    session.mark_file_edited(sid, "/proj/src/app.py");
    const old_ts = _now() - 1801;
    session.mark_bash_run(sid, "sha_young_cold", "make build", "out_cold_young", 1500, 0, 0, false);
    const cache = session.load(sid);
    for (const entry of Object.values(cache.bash_history)) {
      if (entry.output_id === "out_cold_young") {
        entry.ts = old_ts;
      }
    }
    cache.created_ts = _now() - 120;
    session.save(cache);

    const result = build_manifest(sid);
    expect(result.includes("**Cold:**")).toBe(false);
  });

  it("test_mature_session_includes_bash_section", () => {
    const sid = "mature-bash-abc";
    session.mark_file_edited(sid, "/proj/src/app.py");
    session.mark_bash_run(sid, "sha_mature_bash", "pytest -v", "out_mature_001", 2000, 100, 0, false);
    const cache = session.load(sid);
    cache.created_ts = _now() - 7200;
    session.save(cache);

    const result = build_manifest(sid);
    expect(result.includes("**Recent Commands:**")).toBe(true);
  });

  it("test_uncommitted_bonus_adds_ten_tokens", () => {
    const sid = "uncommitted-bonus-test-abc";
    session.mark_file_read(sid, "/proj/src/a.py");
    const cache = session.load(sid);

    const age = 1800.0; // active tier → factor 1.0, so delta is unscaled
    const budget_without = compute_adaptive_budget(cache, age, { has_uncommitted_changes: false });
    const budget_with = compute_adaptive_budget(cache, age, { has_uncommitted_changes: true });
    expect(budget_with).toBe(budget_without + 10);
  });

  it("test_uncommitted_bonus_false_by_default", () => {
    const sid = "uncommitted-bonus-default-test-abc";
    session.mark_file_read(sid, "/proj/src/b.py");
    const cache = session.load(sid);

    const age = 1800.0;
    const budget_default = compute_adaptive_budget(cache, age);
    const budget_explicit = compute_adaptive_budget(cache, age, { has_uncommitted_changes: false });
    expect(budget_default).toBe(budget_explicit);
  });

  it("test_uncommitted_bonus_independent_of_pending_diff", () => {
    const sid = "uncommitted-stack-test-abc";
    session.mark_file_read(sid, "/proj/src/c.py");
    const cache = session.load(sid);

    const age = 1800.0;
    const budget_neither = compute_adaptive_budget(cache, age, {
      has_pending_diff: false,
      has_uncommitted_changes: false,
    });
    const budget_both = compute_adaptive_budget(cache, age, {
      has_pending_diff: true,
      has_uncommitted_changes: true,
    });
    // pending_diff adds 50, uncommitted adds 10 → total +60
    expect(budget_both).toBe(budget_neither + 60);
  });
});

// ===========================================================================
// TestEmptySectionSuppression
// ===========================================================================
describe("TestEmptySectionSuppression", () => {
  // Python monkeypatched compact._get_uncommitted_changes / _get_git_diff_stat /
  // _get_git_diff_stat_summary / _get_session_commits to no-ops. In the TS port
  // _get_uncommitted_changes and _get_git_diff_stat are module-private (called via
  // local bindings inside the manifest builders), so a namespace spy cannot
  // intercept them; the exported _get_git_diff_stat_summary and _get_session_commits
  // ARE spied. The fake /proj/... cwd is not a git repo, so the private helpers
  // fail soft and return "" / null on their own — the section-suppression
  // assertions below hold regardless.
  function _stubGit(): void {
    vi.spyOn(compact, "_get_git_diff_stat_summary").mockImplementation(() => "");
    vi.spyOn(compact, "_get_session_commits").mockImplementation(() => []);
  }

  it("test_bash_section_suppressed_when_no_commands", () => {
    const sid = "empty-bash-test-abc";
    session.mark_file_read(sid, "/proj/src/a.py");
    const cache = session.load(sid);
    expect(Object.keys(cache.bash_history).length).toBe(0);

    _stubGit();

    const result = build_manifest(sid);
    const lines = result.split("\n");
    const bash_header_idx = lines.findIndex((line) => line.includes("**Recent Commands:**"));
    expect(bash_header_idx).toBe(-1);
  });

  it("test_grep_section_suppressed_when_no_patterns", () => {
    const sid = "empty-grep-test-abc";
    session.mark_file_read(sid, "/proj/src/a.py");
    const cache = session.load(sid);
    expect(cache.greps.length).toBe(0);

    _stubGit();

    const result = build_manifest(sid);
    const lines = result.split("\n");
    const grep_header_idx = lines.findIndex((line) => line.includes("**Patterns Searched:**"));
    expect(grep_header_idx).toBe(-1);
  });

  it("test_web_section_suppressed_when_no_fetches", () => {
    const sid = "empty-web-test-abc";
    session.mark_file_read(sid, "/proj/src/a.py");
    const cache = session.load(sid);
    expect(Object.keys(cache.web_history).length).toBe(0);

    _stubGit();

    const result = build_manifest(sid);
    const lines = result.split("\n");
    const web_header_idx = lines.findIndex((line) => line.includes("**Web Fetches:**"));
    expect(web_header_idx).toBe(-1);
  });

  it("test_web_section_rendered_with_single_entry", () => {
    const sid = "single-web-test-abc";
    session.mark_file_edited(sid, "/proj/app.py");
    session.mark_web_fetch(sid, "sha_1", "https://example.com/docs", "out_id_1", 12_000, 200, false);

    let cache = session.load(sid);
    cache.created_ts = _now() - 4000;
    session.save(cache);
    cache = session.load(sid);

    const manifest = _build_manifest_from_cache(cache, sid, 800);
    expect(manifest.includes("**Web Fetches:**")).toBe(true);
  });

  it("test_web_section_present_when_two_domain_entries", () => {
    const sid = "two-web-test-abc";
    session.mark_file_edited(sid, "/proj/app.py");
    session.mark_web_fetch(sid, "sha_a", "https://example.com/page", "out_id_a", 500, 200, false);
    session.mark_web_fetch(sid, "sha_b", "https://otherdomain.org/docs", "out_id_b", 500, 200, false);

    let cache = session.load(sid);
    cache.created_ts = _now() - 4000;
    session.save(cache);
    cache = session.load(sid);

    const manifest = _build_manifest_from_cache(cache, sid, 800);
    expect(manifest.includes("**Web Fetches:**")).toBe(true);
  });
});

// ===========================================================================
// TestShortPathProjectStripping
// ===========================================================================
describe("TestShortPathProjectStripping", () => {
  it("test_strips_project_name_non_src_path", () => {
    const result = _short_path("token-goat/lib/foo.py", 70, "/Projects/token-goat");
    expect(result).toBe("lib/foo.py");
  });

  it("test_strips_project_name_with_windows_root", () => {
    const result = _short_path("token-goat/render/panel.py", 70, "C:/Projects/token-goat");
    expect(result).toBe("render/panel.py");
  });

  it("test_keeps_other_project_name", () => {
    const result = _short_path("other-project/lib/bar.py", 70, "/Projects/token-goat");
    expect(result).toBe("other-project/lib/bar.py");
  });

  it("test_no_stripping_without_project_root", () => {
    const result = _short_path("token-goat/lib/foo.py");
    expect(result).toBe("token-goat/lib/foo.py");
  });

  it("test_src_prefix_still_wins_for_absolute_paths", () => {
    const result = _short_path("/Projects/token-goat/src/foo.py", 70, "/Projects/token-goat");
    expect(result).toBe("src/foo.py");
  });

  it("test_manifest_edited_file_strips_project_name", () => {
    const sid = "path-norm-edited-abc";
    session.mark_file_edited(sid, "token-goat/render/panel.py");
    const cache = session.load(sid);
    cache.cwd = "/Projects/token-goat";

    // _get_uncommitted_changes / _get_git_diff_stat are module-private; the
    // exported git helpers are stubbed and the fake cwd is not a git repo so
    // the private helpers fail soft on their own.
    vi.spyOn(compact, "_get_git_diff_stat_summary").mockImplementation(() => "");
    vi.spyOn(compact, "_get_session_commits").mockImplementation(() => []);

    const result = _build_manifest_from_cache(cache, sid, 400);
    expect(result.includes("render/panel.py")).toBe(true);
    expect(result.includes("token-goat/render/panel.py")).toBe(false);
  });
});

// ===========================================================================
// TestSessionAgeTierBoundaries
// ===========================================================================
describe("TestSessionAgeTierBoundaries", () => {
  it("test_young_mature_boundary_at_exactly_600_seconds", () => {
    const sid = "age-boundary-600-exact";
    session.mark_file_edited(sid, "/proj/a.py");
    session.mark_file_read(sid, "/proj/b.py", 0, 100);

    session.load(sid);
    const tier = _session_age_tier(600.0);
    expect(tier).toBe("active");
  });

  it("test_young_boundary_at_599_seconds", () => {
    const sid = "age-boundary-599";
    session.mark_file_edited(sid, "/proj/a.py");
    session.mark_file_read(sid, "/proj/b.py", 0, 100);

    session.load(sid);
    const tier = _session_age_tier(599.0);
    expect(tier).toBe("young");
  });

  it("test_young_boundary_at_601_seconds", () => {
    const sid = "age-boundary-601";
    session.mark_file_edited(sid, "/proj/a.py");
    session.mark_file_read(sid, "/proj/b.py", 0, 100);

    session.load(sid);
    const tier = _session_age_tier(601.0);
    expect(tier).toBe("active");
  });

  it("test_active_mature_boundary_at_exactly_3600_seconds", () => {
    const sid = "age-boundary-3600-exact";
    session.mark_file_edited(sid, "/proj/a.py");
    session.mark_file_read(sid, "/proj/b.py", 0, 100);

    session.load(sid);
    const tier = _session_age_tier(3600.0);
    expect(tier).toBe("mature");
  });

  it("test_active_boundary_at_3599_seconds", () => {
    const sid = "age-boundary-3599";
    session.mark_file_edited(sid, "/proj/a.py");
    session.mark_file_read(sid, "/proj/b.py", 0, 100);

    session.load(sid);
    const tier = _session_age_tier(3599.0);
    expect(tier).toBe("active");
  });

  it("test_mature_boundary_at_3601_seconds", () => {
    const sid = "age-boundary-3601";
    session.mark_file_edited(sid, "/proj/a.py");
    session.mark_file_read(sid, "/proj/b.py", 0, 100);

    session.load(sid);
    const tier = _session_age_tier(3601.0);
    expect(tier).toBe("mature");
  });

  it("test_young_tier_manifests_minimally", () => {
    const sid = "young-manifest-minimal";
    session.mark_file_edited(sid, "/proj/app.py");
    session.mark_file_read(sid, "/proj/lib.py", 0, 100);
    session.mark_bash_run(sid, "cmd_sha_young", "pytest", "id_young", 500, 200, 0, false);

    const cache = session.load(sid);
    const manifest = _build_manifest_from_cache(cache, sid, 400);
    expect(manifest.includes("**Recent Commands:**")).toBe(false);
  });

  it("test_active_tier_includes_bash_section", () => {
    const sid = "active-manifest-bash";
    session.mark_file_edited(sid, "/proj/app.py");
    session.mark_file_read(sid, "/proj/lib.py", 0, 100);
    session.mark_bash_run(sid, "cmd_sha_act", "pytest -v", "id_active", 5000, 2000, 0, false);

    const cache = session.load(sid);
    cache.created_ts = _now() - 1800; // 30 minutes ago = active tier
    session.save(cache);

    _build_manifest_from_cache(cache, sid, 400);
    if (Object.keys(session.load(sid).bash_history).length > 0) {
      // Bash section may appear depending on budget — just verify no crash.
    }
  });

  it("test_mature_tier_gets_extra_key_file_slots", () => {
    const sid = "mature-extra-files";
    const cache = session.load(sid);
    cache.created_ts = _now() - 7200; // 2 hours ago = mature tier

    for (let i = 0; i < 15; i++) {
      session.mark_file_read(sid, `/proj/file${String(i).padStart(2, "0")}.py`, 0, 100);
    }
    session.save(cache);

    const reloaded = session.load(sid);
    const manifest = _build_manifest_from_cache(reloaded, sid, 600);
    expect(typeof manifest).toBe("string");
  });
});

// ===========================================================================
// TestZeroNearZeroBudgetEdgeCases
// ===========================================================================
describe("TestZeroNearZeroBudgetEdgeCases", () => {
  it("test_compute_adaptive_budget_zero_age_is_young", () => {
    const sid = "budget-age-zero";
    session.mark_file_edited(sid, "/proj/a.py");

    const cache = session.load(sid);
    const budget = compute_adaptive_budget(cache, 0.0);
    expect(budget).toBe(200);
  });

  it("test_section_budgets_with_zero_remaining", () => {
    const result = _section_budgets(100, 150);
    expect(result["symbols"]).toBe(20);
    expect(result["files"]).toBe(20);
    expect(result["greps"]).toBe(20);
    expect(result["bash"]).toBe(20);
    expect(result["web"]).toBe(20);
  });

  it("test_section_budgets_with_one_token_remaining", () => {
    const result = _section_budgets(50, 49);
    expect(result["symbols"]).toBe(20);
    expect(result["files"]).toBe(20);
    expect(result["greps"]).toBe(20);
    expect(result["bash"]).toBe(20);
    expect(result["web"]).toBe(20);
  });

  it("test_build_manifest_with_one_token_budget", () => {
    const sid = "manifest-one-token";
    session.mark_file_edited(sid, "/proj/app.py");

    const result = build_manifest(sid, { max_tokens: 1 });
    expect(typeof result).toBe("string");
  });

  it("test_build_manifest_with_zero_budget", () => {
    const sid = "manifest-zero-budget";
    session.mark_file_edited(sid, "/proj/app.py");

    const result = build_manifest(sid, { max_tokens: 0 });
    expect(typeof result).toBe("string");
  });

  it("test_section_budgets_proportions_sum_to_one", () => {
    const result = _section_budgets(1000, 0);
    expect(result["symbols"]).toBeGreaterThanOrEqual(20);
    expect(result["files"]).toBeGreaterThanOrEqual(20);
    expect(result["greps"]).toBeGreaterThanOrEqual(20);
    expect(result["bash"]).toBeGreaterThanOrEqual(20);
    expect(result["web"]).toBeGreaterThanOrEqual(20);
  });

  it("test_adaptive_budget_empty_session_at_young_age", () => {
    const sid = "empty-young-age";
    const cache = session.load(sid);

    const budget = compute_adaptive_budget(cache, 5.0);
    expect(budget).toBe(200);
  });

  it("test_adaptive_budget_empty_session_at_mature_age", () => {
    const sid = "empty-mature-age";
    const cache = session.load(sid);

    const budget = compute_adaptive_budget(cache, 7200.0);
    expect(budget).toBeGreaterThanOrEqual(200);
    expect(budget).toBeLessThanOrEqual(800);
  });
});

// ===========================================================================
// TestManifestRenderingEdgeCases
// ===========================================================================
describe("TestManifestRenderingEdgeCases", () => {
  it("test_render_with_no_edited_files", () => {
    const sid = "no-edits-manifest";
    session.mark_file_read(sid, "/proj/lib.py", 0, 100);
    session.mark_grep(sid, "pattern", "/proj");

    const cache = session.load(sid);
    const manifest = _build_manifest_from_cache(cache, sid, 400);
    expect(typeof manifest).toBe("string");
  });

  it("test_render_with_no_bash_history", () => {
    const sid = "no-bash-manifest";
    session.mark_file_edited(sid, "/proj/app.py");
    session.mark_file_read(sid, "/proj/lib.py", 0, 100);

    const cache = session.load(sid);
    const manifest = _build_manifest_from_cache(cache, sid, 400);
    expect(manifest.includes("**Recent Commands:**")).toBe(false);
  });

  it("test_render_with_no_web_history", () => {
    const sid = "no-web-manifest";
    session.mark_file_edited(sid, "/proj/app.py");
    session.mark_file_read(sid, "/proj/lib.py", 0, 100);

    const cache = session.load(sid);
    const manifest = _build_manifest_from_cache(cache, sid, 400);
    expect(manifest.includes("**Web Fetches:**")).toBe(false);
  });

  it("test_render_with_no_symbols_accessed", () => {
    const sid = "no-symbols-manifest";
    session.mark_file_edited(sid, "/proj/app.py");
    session.mark_file_read(sid, "/proj/lib.py", 0, 100); // No symbol

    const cache = session.load(sid);
    const manifest = _build_manifest_from_cache(cache, sid, 400);
    expect(manifest.includes("**Symbols Accessed:**")).toBe(false);
  });

  it("test_render_all_sections_empty", () => {
    const sid = "completely-empty";
    const result = build_manifest(sid);
    expect(result).toBe("");
  });

  it("test_render_with_very_large_budget", () => {
    const sid = "huge-budget";
    session.mark_file_edited(sid, "/proj/app.py");

    const result = build_manifest(sid, { max_tokens: 100_000 });
    expect(typeof result).toBe("string");
  });

  it("test_manifest_respects_young_tier_bash_skip", () => {
    const sid = "young-skip-bash";
    session.mark_file_edited(sid, "/proj/app.py");
    session.mark_file_read(sid, "/proj/lib.py", 0, 100);
    session.mark_bash_run(sid, "cmd_sha_y", "make", "id_y", 2000, 1000, 0, false);

    let cache = session.load(sid);
    cache.created_ts = _now() - 30; // 30 seconds ago
    session.save(cache);

    cache = session.load(sid);
    const manifest = _build_manifest_from_cache(cache, sid, 400);
    expect(manifest.includes("Commands Run")).toBe(false);
  });

  it("test_manifest_respects_young_tier_web_skip", () => {
    const sid = "young-skip-web";
    session.mark_file_edited(sid, "/proj/app.py");
    session.mark_file_read(sid, "/proj/lib.py", 0, 100);
    // Python passes (sid, "https://example.com", "id_web", 5000, 200, 0, False):
    // positionally url_sha="https://example.com", url_preview="id_web",
    // output_id=5000, body_bytes=200, status_code=0, truncated=False. The TS port
    // mirrors the same positional order (output_id stringified); smoke test only.
    session.mark_web_fetch(sid, "https://example.com", "id_web", "5000", 200, 0, false);

    let cache = session.load(sid);
    cache.created_ts = _now() - 30; // 30 seconds ago
    session.save(cache);

    cache = session.load(sid);
    const manifest = _build_manifest_from_cache(cache, sid, 400);
    expect(manifest.includes("Web Fetches")).toBe(false);
  });
});

// ===========================================================================
// TestEmptySessionManifestRendering
// (also carries the Directory Scans / glob methods Python's AST attaches here)
// ===========================================================================
describe("TestEmptySessionManifestRendering", () => {
  /** Push session created_ts back 2 hours so it's not 'young'. */
  function _mature_session(sid: string): void {
    const cache = session.load(sid);
    cache.created_ts = _now() - 7200;
    session.save(cache);
  }

  it("test_completely_empty_session_returns_empty_string", () => {
    const sid = "totally-empty-session-xyz";
    const result = build_manifest(sid);
    expect(result).toBe("");
    expect(typeof result).toBe("string");
  });

  it("test_completely_empty_session_no_section_headers", () => {
    const sid = "empty-no-headers-abc";
    const result = build_manifest(sid);
    expect(result.includes("Token-Goat Session Manifest")).toBe(false);
    expect(result.includes("Files Edited")).toBe(false);
    expect(result.includes("Symbols Accessed")).toBe(false);
    expect(result.includes("Key Files Read")).toBe(false);
    expect(result.includes("Commands Run")).toBe(false);
    expect(result.includes("Web Fetches")).toBe(false);
    expect(result.includes("Grep Patterns")).toBe(false);
  });

  it("test_empty_session_with_high_token_budget", () => {
    const sid = "empty-high-budget-xyz";
    const result = build_manifest(sid, { max_tokens: 10000 });
    expect(result).toBe("");
  });

  it("test_empty_session_with_minimal_token_budget", () => {
    const sid = "empty-minimal-budget-abc";
    const result = build_manifest(sid, { max_tokens: 1 });
    expect(result).toBe("");
  });

  it("test_build_manifest_with_count_empty_session", () => {
    const sid = "empty-count-session-xyz";
    const [manifest, event_count_val] = build_manifest_with_count(sid);
    expect(manifest).toBe("");
    expect(event_count_val).toBe(0);
  });

  it("test_empty_session_with_none_session_id_guard", () => {
    // Too long → validation fails.
    const result = build_manifest("x".repeat(300));
    expect(result).toBe("");
  });

  it("test_render_directly_with_empty_cache", () => {
    const ts = _now();
    const empty_cache = new SessionCache({
      session_id: "test-render-empty",
      started_ts: ts,
      last_activity_ts: ts,
      created_ts: ts,
      files: {},
      edited_files: {},
      greps: [],
    });
    const [result, symbols_count] = _render(empty_cache, "test-render-empty", 400);
    expect(result).toBe("");
    expect(symbols_count).toBe(0);
  });

  it("test_empty_session_returns_zero_event_count", () => {
    const sid = "empty-event-count-abc";
    const count = event_count(sid);
    expect(count).toBe(0);
  });

  // ---- Directory Scans / glob methods (AST-owned by this class) ----

  it("test_glob_section_appears_with_qualifying_entry", () => {
    const sid = "glob-manifest-appears";
    session.mark_file_edited(sid, "src/main.py");
    session.mark_glob_run(sid, "**/*.py", null, _GLOB_DEDUP_MIN_RESULT_COUNT + 10);
    session.mark_glob_run(sid, "**/*.ts", null, _GLOB_DEDUP_MIN_RESULT_COUNT + 5);
    _mature_session(sid);

    const result = build_manifest(sid, { max_tokens: 400 });
    expect(result.includes("Directory Scans")).toBe(true);
    expect(result.includes("**/*.py")).toBe(true);
  });

  it("test_glob_section_absent_when_history_empty", () => {
    const sid = "glob-manifest-absent";
    session.mark_file_edited(sid, "src/main.py");
    _mature_session(sid);

    const result = build_manifest(sid, { max_tokens: 400 });
    expect(result.includes("Directory Scans")).toBe(false);
  });

  it("test_glob_trivial_pattern_not_shown", () => {
    const sid = "glob-manifest-trivial";
    session.mark_file_edited(sid, "src/main.py");
    session.mark_glob_run(sid, "**", null, 100);
    _mature_session(sid);

    const result = build_manifest(sid, { max_tokens: 400 });
    expect(result.includes("Directory Scans")).toBe(false);
  });

  it("test_glob_section_absent_in_young_session", () => {
    const sid = "glob-manifest-young";
    session.mark_file_edited(sid, "src/main.py");
    session.mark_glob_run(sid, "**/*.py", null, 50);
    // Do NOT call _mature_session — let it stay young.

    const result = build_manifest(sid, { max_tokens: 400 });
    expect(result.includes("Directory Scans")).toBe(false);
  });

  it("test_glob_section_shows_path_scope", () => {
    const sid = "glob-manifest-scope";
    session.mark_file_edited(sid, "src/main.py");
    session.mark_glob_run(sid, "**/*.rs", "src/", _GLOB_DEDUP_MIN_RESULT_COUNT + 5);
    _mature_session(sid);

    const result = build_manifest(sid, { max_tokens: 400 });
    expect(result.includes("src/")).toBe(true);
  });
});

// ===========================================================================
// TestAllSectionsSimultaneous
// ===========================================================================
describe("TestAllSectionsSimultaneous", () => {
  function _build_full_session(sid: string): void {
    // Edited files
    session.mark_file_edited(sid, "src/token_goat/compact.py");
    session.mark_file_edited(sid, "src/token_goat/session.py");

    // File reads (symbol + plain)
    session.mark_file_read(sid, "src/token_goat/compact.py", null, null, { symbol: "_render" });
    session.mark_file_read(sid, "src/token_goat/session.py", 0, 50);
    session.mark_file_read(sid, "src/token_goat/hints.py", 0, 100);

    // Bash history (output_bytes must be >= _MIN_BASH_BYTES_FOR_MANIFEST = 400)
    session.mark_bash_run(sid, "sha_pytest", "uv run pytest -q", "out_pytest", 1200, 800, 0, false);
    session.mark_bash_run(sid, "sha_ruff", "uv run ruff check", "out_ruff", 500, 300, 0, false);

    // Web fetches (content_bytes must be >= _MIN_WEB_BYTES_FOR_MANIFEST = 200).
    // Positional args: url_sha, url_preview, output_id, body_bytes, status_code,
    // truncated — the same order Python's mark_web_fetch uses.
    session.mark_web_fetch(
      sid,
      "https://docs.python.org/3/library/heapq.html",
      "out_web1",
      "5000",
      200,
      1000,
      false,
    );
    session.mark_web_fetch(sid, "https://sqlite.org/json1.html", "out_web2", "3000", 200, 500, false);

    // Grep patterns
    session.mark_grep(sid, "_render", "src/token_goat/", 4);
    session.mark_grep(sid, "estimate_tokens", null, 7);

    // Glob runs (result_count must be >= _GLOB_DEDUP_MIN_RESULT_COUNT = 5)
    session.mark_glob_run(sid, "**/*.py", null, 42);
    session.mark_glob_run(sid, "tests/**/*.py", "tests/", 12);

    // Age the session so all tier gates open.
    const cache = session.load(sid);
    cache.created_ts = _now() - 7200;
    session.save(cache);
  }

  it("test_all_sections_no_crash", () => {
    const sid = "all-sections-no-crash";
    _build_full_session(sid);
    const result = build_manifest(sid, { max_tokens: 800 });
    expect(typeof result).toBe("string");
    expect(result.includes("compact.py")).toBe(true);
  });

  it("test_all_sections_budget_respected", () => {
    const sid = "all-sections-budget";
    _build_full_session(sid);
    const max_tok = 600;
    const result = build_manifest(sid, { max_tokens: max_tok });
    expect(estimate_tokens(result)).toBeLessThanOrEqual(max_tok);
  });

  it("test_all_sections_edited_files_present", () => {
    const sid = "all-sections-edited";
    _build_full_session(sid);
    const result = build_manifest(sid, { max_tokens: 800 });
    expect(
      result.includes("**Staged/Uncommitted:**") ||
        result.includes("**Edited:**") ||
        result.includes("compact.py"),
    ).toBe(true);
  });

  it("test_all_sections_glob_present_in_mature_session", () => {
    const sid = "all-sections-glob";
    _build_full_session(sid);
    const result = build_manifest(sid, { max_tokens: 800 });
    expect(result.includes("Directory Scans")).toBe(true);
  });

  it("test_all_sections_token_budget_tight", () => {
    const sid = "all-sections-tight";
    _build_full_session(sid);
    const max_tok = 300;
    const result = build_manifest(sid, { max_tokens: max_tok });
    expect(typeof result).toBe("string");
    expect(estimate_tokens(result)).toBeLessThanOrEqual(max_tok);
  });
});

// ===========================================================================
// TestSafetyTrimAndBudgetFloor
// ===========================================================================
describe("TestSafetyTrimAndBudgetFloor", () => {
  it("test_safety_trim_output_within_budget", () => {
    const sid = "safety-trim-path";
    session.mark_file_edited(sid, "src/token_goat/compact.py");
    session.mark_file_edited(sid, "src/token_goat/session.py");
    session.mark_file_edited(sid, "src/token_goat/hints.py");
    for (let i = 0; i < 10; i++) {
      session.mark_file_read(sid, `src/module_${i}.py`, 0, 200);
    }
    session.mark_bash_run(sid, "sha_cmd", "uv run pytest -q", "out_cmd", 1500, 800, 0, false);
    session.mark_web_fetch(sid, "https://docs.python.org", "out_web", "2000", 200, 500, false);
    const cache = session.load(sid);
    cache.created_ts = _now() - 7200;
    session.save(cache);

    const max_tok = 80;
    const result = build_manifest(sid, { max_tokens: max_tok });
    expect(typeof result).toBe("string");
    // Allow +12 for the "# as-of: …" suffix.
    expect(estimate_tokens(result)).toBeLessThanOrEqual(max_tok + 12);
  });

  it("test_glob_budget_floor_kicks_in_at_small_remaining", () => {
    // remaining = 200 → glob 5% = 10 < floor 20 → floor applies
    const budgets = _section_budgets(200, 0);
    expect(budgets["glob"]).toBe(20);
  });

  it("test_glob_budget_above_floor_for_large_remaining", () => {
    // remaining = 800 → glob 5% = 40 > floor 20 → proportional
    const budgets = _section_budgets(800, 0);
    expect(budgets["glob"]).toBe(40);
  });

  it("test_section_budgets_floor_applied_to_all_sections_under_pressure", () => {
    // remaining = 50 → every section gets floor (20)
    const budgets = _section_budgets(50, 0);
    for (const key of ["symbols", "files", "greps", "bash", "web", "glob"]) {
      expect(budgets[key]).toBeGreaterThanOrEqual(20);
    }
  });

  it("test_build_manifest_with_count_returns_nonzero_for_active_session", () => {
    const sid = "bmwc-active";
    session.mark_file_edited(sid, "src/main.py");
    session.mark_file_read(sid, "src/lib.py", 0, 50, { symbol: "MyClass" });
    const [, files_count] = build_manifest_with_count(sid);
    expect(files_count).toBeGreaterThan(0);
  });

  it("test_build_manifest_with_count_uses_sidecar_cache_on_second_call", () => {
    const sid = "bmwc-sidecar-regression";
    session.mark_file_edited(sid, "src/main.py");

    // First call: cache miss → renders full manifest and writes sidecar.
    const [manifest1, count1] = build_manifest_with_count(sid);
    expect(manifest1).toBeTruthy();
    expect(count1).toBeGreaterThan(0);

    // Clear the in-process guard so the next call can hit the sidecar.
    _manifest_sha_written_this_process.delete(sid);

    // Second call with identical session state: must return sidecar stub.
    const [manifest2, count2] = build_manifest_with_count(sid);
    expect(manifest2.includes("unchanged since")).toBe(true);
    expect(count2).toBe(count1);
  });

  it("test_build_manifest_with_count_includes_skill_history", () => {
    const sid = "bmwc-skill-history-regression";
    const cache = session.load(sid);
    cache.skill_history = {
      ralph: new SkillEntry({
        skill_name: "ralph",
        output_id: "oid-ralph",
        content_sha: "abc123",
        ts: 1000.0,
        body_bytes: 2048,
        run_count: 1,
      }),
    };
    session.save(cache);

    const [, n_events_bmwc] = build_manifest_with_count(sid);
    const n_events_standalone = event_count(sid);

    expect(n_events_bmwc).toBe(n_events_standalone);
    expect(n_events_bmwc).toBeGreaterThan(0);
  });
});

// ===========================================================================
// TestStaleReadFilesSection
// ===========================================================================
describe("TestStaleReadFilesSection", () => {
  it("test_stale_file_appears_in_manifest", () => {
    const sid = "stale-read-path";
    const p = "src/token_goat/hints.py";

    session.mark_file_read(sid, p, 0, 80);

    const cache = session.load(sid);
    const key = Object.keys(cache.files)[0]!;
    const entry = cache.files[key]!;
    entry.last_edit_ts = entry.last_read_ts + 1.0;
    // Do NOT add to edited_files — this is the stale scenario.
    session.save(cache);

    const result = build_manifest(sid, { max_tokens: 400 });
    expect(result.includes("Outdated File Snapshots")).toBe(true);
    expect(result.includes("⚠")).toBe(true);
  });

  it("test_stale_file_absent_when_in_edited_files", () => {
    const sid = "stale-but-edited";
    const p = "src/token_goat/compact.py";

    session.mark_file_read(sid, p, 0, 50);
    session.mark_file_edited(sid, p);

    const result = build_manifest(sid, { max_tokens: 400 });
    expect(result.includes("Outdated File Snapshots")).toBe(false);
  });

  it("test_no_stale_section_when_all_edits_before_reads", () => {
    const sid = "edit-then-read";
    const p = "src/token_goat/session.py";

    session.mark_file_edited(sid, p);
    session.mark_file_read(sid, p, 0, 50);

    const cache = session.load(sid);
    cache.edited_files = {};
    session.save(cache);

    const result = build_manifest(sid, { max_tokens: 400 });
    expect(result.includes("Outdated File Snapshots")).toBe(false);
  });
});

// ===========================================================================
// TestSymbolRecencyRanking
// ===========================================================================
describe("TestSymbolRecencyRanking", () => {
  it("test_most_recent_symbol_ranks_first_when_sizes_equal", () => {
    installMonotonicClock();
    const sid = "symbol-recency-recent-first";

    session.mark_file_read(sid, "/proj/parser.py", null, null, { symbol: "parse_expr" });
    session.mark_file_read(sid, "/proj/parser.py", null, null, { symbol: "parse_stmt" });

    const cache = session.load(sid);
    const entry = cache.files["/proj/parser.py"]!;

    const ranked = _rank_symbols_by_recency(entry, _now());

    expect(ranked[0]).toBe("parse_stmt");
    expect(ranked[1]).toBe("parse_expr");
  });

  it("test_old_symbol_ranks_last", () => {
    const sid = "symbol-recency-old";
    const now = _now();

    session.mark_file_read(sid, "/proj/lib.py", null, null, { symbol: "old_func" });
    const cache = session.load(sid);
    const entry = cache.files["/proj/lib.py"]!;

    entry.symbols_ts["old_func"] = now - 3600;

    const ranked = _rank_symbols_by_recency(entry, now);
    expect(ranked).toEqual(["old_func"]);
  });

  it("test_recency_tiers_applied_correctly", () => {
    const sid = "symbol-recency-tiers";
    const now = _now();

    session.mark_file_read(sid, "/proj/core.py", null, null, { symbol: "very_recent" });
    session.mark_file_read(sid, "/proj/core.py", null, null, { symbol: "recent" });
    session.mark_file_read(sid, "/proj/core.py", null, null, { symbol: "old" });

    const cache = session.load(sid);
    const entry = cache.files["/proj/core.py"]!;

    entry.symbols_ts["very_recent"] = now - 60; // < 5 min → 1.5x
    entry.symbols_ts["recent"] = now - 600; // < 30 min → 1.2x
    entry.symbols_ts["old"] = now - 3600; // > 30 min → 1.0x

    const ranked = _rank_symbols_by_recency(entry, now);
    expect(ranked).toEqual(["very_recent", "recent", "old"]);
  });

  it("test_missing_ts_field_falls_back_gracefully", () => {
    const sid = "symbol-recency-legacy";

    session.mark_file_read(sid, "/proj/compat.py", null, null, { symbol: "func1" });
    session.mark_file_read(sid, "/proj/compat.py", null, null, { symbol: "func2" });

    const cache = session.load(sid);
    const entry = cache.files["/proj/compat.py"]!;

    entry.symbols_ts = {};

    const ranked = _rank_symbols_by_recency(entry, _now());
    expect(ranked).toEqual(entry.symbols_read);
  });
});

// ===========================================================================
// TestEstimateTokensDirect
// ===========================================================================
describe("TestEstimateTokensDirect", () => {
  it("test_empty_string_returns_one", () => {
    expect(estimate_tokens("")).toBe(1);
  });

  it("test_short_string_positive", () => {
    expect(estimate_tokens("hello")).toBeGreaterThanOrEqual(1);
  });

  it("test_long_string_proportional", () => {
    const short = estimate_tokens("x".repeat(100));
    const long_ = estimate_tokens("x".repeat(1000));
    expect(long_ > short).toBe(true);
  });

  it("test_approx_three_chars_per_token", () => {
    const result = estimate_tokens("a".repeat(300));
    // Formula is max(1, len//3 + 1); exact: 300//3 + 1 = 101.
    expect(result).toBeGreaterThanOrEqual(90);
    expect(result).toBeLessThanOrEqual(115);
  });
});

// ===========================================================================
// TestCapLine
// ===========================================================================
describe("TestCapLine", () => {
  it("test_short_line_unchanged", () => {
    const short = "- this is a short line";
    expect(_cap_line(short)).toBe(short);
  });

  it("test_exact_120_char_line_unchanged", () => {
    const exact = "x".repeat(120);
    expect(_cap_line(exact)).toBe(exact);
  });

  it("test_121_char_line_capped_with_ellipsis", () => {
    const long_line = "x".repeat(121);
    const result = _cap_line(long_line);
    expect(result.length).toBe(120);
    expect(result.endsWith("…")).toBe(true);
    expect(result).toBe("x".repeat(119) + "…");
  });

  it("test_very_long_line_capped", () => {
    const very_long = "x".repeat(300);
    const result = _cap_line(very_long);
    expect(result.length).toBe(120);
    expect(result).toBe("x".repeat(119) + "…");
  });
});
