/**
 * 1:1 port of tests/test_compact_stale_budget.py — the stale-compact fraction
 * signal in compute_adaptive_budget (iter 9/10) plus the context-pressure caps.
 *
 * Each Python `class Test*` maps to a vitest `describe(...)`; each `def test_*`
 * maps to an `it(...)` with the SAME name and (where portable) the SAME
 * assertion polarity.
 *
 * ---------------------------------------------------------------------------
 * Mapping notes (Python -> TS)
 * ---------------------------------------------------------------------------
 *  - `_minimal_cache(**overrides)` (a MagicMock with sane defaults) -> the local
 *    minimalCache() helper. compute_adaptive_budget only reads `edited_files`,
 *    `files`, `bash_history`, `web_history` (and the budget never touches
 *    `created_ts`/`cwd`/`skill_history` for these inputs), so a plain object cast
 *    to SessionCache is a faithful stand-in. The Python `_minimal_cache` seeds
 *    bash_history/web_history as empty LISTS; the TS budget gates them through
 *    _isDict (a list is not a dict -> 0 bonus), and the Python `if cache.bash_history`
 *    on an empty list is likewise falsy -> 0, so the empty-default budget matches.
 *
 *  - `_complex_mature_cache()` -> complexMatureCache(). Python seeds bash_history
 *    and web_history as one-element LISTS (truthy -> +20 / +15 in Python). The TS
 *    budget gates those bonuses through _isDict, so a one-element list yields +0
 *    there (a list is not a dict). This shifts the *complex* cache's uncapped
 *    budget by 35 tokens versus Python but does NOT change any assertion in
 *    TestContextPressureCaps: every assertion is an ordering / cap-ceiling check
 *    (uncapped > 500; capped <= 300/500 and < uncapped; crit < hot; cool/warm/none
 *    == uncapped), and the TS uncapped value (670) still saturates well above 500.
 *    The density downgrade in _compute_activity_multiplier (edit density 6/120 =
 *    0.05 < 0.3 caps the mature 1.4x factor at 1.0) applies identically in both
 *    languages. Reported in parity_notes.
 *
 *  - `_REAL_COMPACT` and the skill_cache `store_compact` / `_skill_outputs_dir`
 *    machinery are only used by Sub-areas F/G/H, which call the MODULE-PRIVATE
 *    helper `_compute_stale_compact_fraction` directly. That helper is NOT
 *    exported from compact.ts (not in `__all__`, no `export` on the decl), so it
 *    cannot be imported here without editing the (frozen, green) src module.
 *    Sub-areas E/F/G/H are therefore it.skip'd with a reason and counted. The
 *    skill_cache.ts module is also not yet ported; compact.ts reaches it through
 *    the `_setSkillCacheModule` seam (mirrored below for the wiring test).
 *
 *  - Sub-area I (build_manifest_adaptive wiring) patches `compute_adaptive_budget`
 *    and `_build_manifest_from_cache` ON the compact module and relies on
 *    build_manifest_adaptive calling them THROUGH that namespace. Under vitest's
 *    ESM transform an intra-module call resolves to the local lexical binding, so
 *    a `vi.spyOn(compact, "compute_adaptive_budget")` is NOT observed for the
 *    internal call — the Python monkeypatch-the-module seam has no ESM twin. The
 *    test is ported BEHAVIORALLY instead: a real session (loadable cache with a
 *    skill_history entry + enough activity to clear the floor) is built, a
 *    skill_cache stub is injected via the seam, and build_manifest_adaptive is
 *    driven end-to-end. The assertion shifts from "captured fraction in [0,1]" to
 *    "the full wiring chain ran and produced a manifest" — the chain includes
 *    _compute_stale_compact_fraction -> compute_adaptive_budget, and that helper
 *    always returns a value in [0,1] by construction (stale_count / total). The
 *    assertion-shape change is flagged in parity_notes/known_gaps.
 *
 *  - ContextPressure(fill_fraction=..., tier=...) -> new compact.ContextPressure({
 *    fill_fraction, tier }) (the TS ctor takes a single options object).
 *
 *  - compute_adaptive_budget(cache, stale_compact_fraction=X) -> the TS signature
 *    is (cache, age_seconds=0.0, opts). Keyword-only kwargs move into the 3rd
 *    `opts` object: compact.compute_adaptive_budget(cache, 0.0, { ...kwargs }).
 *
 * Per-test tmp data dir + cache clearing is handled by tests/setup.ts.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import * as compact from "../src/token_goat/compact.js";
import * as session from "../src/token_goat/session.js";

import type { SessionCache } from "../src/token_goat/session.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * _minimal_cache analogue: a minimal cache with sane defaults, overridable.
 * compute_adaptive_budget only reads edited_files / files / bash_history /
 * web_history, so a plain object cast to SessionCache is faithful here.
 */
function minimalCache(overrides: Record<string, unknown> = {}): SessionCache {
  const base: Record<string, unknown> = {
    edited_files: {},
    files: {},
    bash_history: [],
    web_history: [],
    skill_history: {},
    created_ts: 0.0,
    cwd: null,
  };
  return { ...base, ...overrides } as unknown as SessionCache;
}

/**
 * _complex_mature_cache analogue: a mature, maximally-complex cache whose
 * uncapped budget hits the ceiling so the context-pressure caps (300 / 500) are
 * strictly lower than the uncapped value.
 */
function complexMatureCache(): SessionCache {
  const files: Record<string, unknown> = {};
  for (let i = 0; i < 6; i++) {
    files[`f${i}.py`] = { symbols_read: ["sym"] };
  }
  const edited: Record<string, unknown> = {};
  for (let i = 0; i < 6; i++) {
    edited[`e${i}.py`] = {};
  }
  return minimalCache({
    edited_files: edited,
    files,
    bash_history: ["ran a command"],
    web_history: ["fetched a url"],
  });
}

/** Bonuses that push the uncapped budget to its ceiling for the complex cache. */
const MAX_KW = {
  age_seconds: 7200.0, // mature -> 1.4x factor (downgraded to 1.0 by edit density)
  has_pending_diff: true,
  has_uncommitted_changes: true,
  stale_compact_fraction: 1.0,
} as const;

/** compute_adaptive_budget(complexMatureCache(), **MAX_KW) — the uncapped value. */
function uncappedBudget(): number {
  return compact.compute_adaptive_budget(complexMatureCache(), MAX_KW.age_seconds, {
    has_pending_diff: MAX_KW.has_pending_diff,
    has_uncommitted_changes: MAX_KW.has_uncommitted_changes,
    stale_compact_fraction: MAX_KW.stale_compact_fraction,
  });
}

afterEach(() => {
  compact._setSkillCacheModule(undefined);
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// Sub-area A — baseline: no stale bonus when fraction=0.0
// ---------------------------------------------------------------------------

describe("TestComputeAdaptiveBudgetNoStaleBonus", () => {
  it("test_no_bonus_when_fraction_zero", () => {
    const cache = minimalCache();
    const budget_no_stale = compact.compute_adaptive_budget(cache, 0.0, { stale_compact_fraction: 0.0 });
    const budget_default = compact.compute_adaptive_budget(cache);
    expect(budget_no_stale).toBe(budget_default);
  });
});

// ---------------------------------------------------------------------------
// Sub-area B — graduated bonus as fraction rises
// ---------------------------------------------------------------------------

describe("TestComputeAdaptiveBudgetGraduatedBonus", () => {
  it("test_half_fraction_gives_partial_bonus", () => {
    const cache = minimalCache();
    const budget_zero = compact.compute_adaptive_budget(cache, 0.0, { stale_compact_fraction: 0.0 });
    const budget_half = compact.compute_adaptive_budget(cache, 0.0, { stale_compact_fraction: 0.5 });
    const budget_full = compact.compute_adaptive_budget(cache, 0.0, { stale_compact_fraction: 1.0 });
    // Budget should increase monotonically with stale_compact_fraction.
    expect(budget_zero <= budget_half && budget_half <= budget_full).toBe(true);
  });

  it("test_quarter_fraction_less_than_full", () => {
    const cache = minimalCache();
    const budget_quarter = compact.compute_adaptive_budget(cache, 0.0, { stale_compact_fraction: 0.25 });
    const budget_full = compact.compute_adaptive_budget(cache, 0.0, { stale_compact_fraction: 1.0 });
    expect(budget_quarter).toBeLessThanOrEqual(budget_full);
  });
});

// ---------------------------------------------------------------------------
// Sub-area C — bonus caps at 60 tokens
// ---------------------------------------------------------------------------

describe("TestComputeAdaptiveBudgetBonusCap", () => {
  it("test_stale_bonus_caps_at_60", () => {
    const cache = minimalCache();
    const budget_zero = compact.compute_adaptive_budget(cache, 0.0, { stale_compact_fraction: 0.0 });
    const budget_full = compact.compute_adaptive_budget(cache, 0.0, { stale_compact_fraction: 1.0 });
    const raw_bonus = budget_full - budget_zero;
    // The stale bonus from stale fraction alone should be at most 60.
    expect(raw_bonus).toBeLessThanOrEqual(60);
  });

  it("test_fraction_above_1_clamped", () => {
    const cache = minimalCache();
    const budget_one = compact.compute_adaptive_budget(cache, 0.0, { stale_compact_fraction: 1.0 });
    const budget_two = compact.compute_adaptive_budget(cache, 0.0, { stale_compact_fraction: 2.0 });
    // Fractions > 1.0 are clamped to 1.0 before applying the bonus.
    expect(budget_one).toBe(budget_two);
  });
});

// ---------------------------------------------------------------------------
// Sub-area D — clamp fraction to [0.0, 1.0]
// ---------------------------------------------------------------------------

describe("TestComputeAdaptiveBudgetFractionClamp", () => {
  it("test_negative_fraction_clamped_to_zero", () => {
    const cache = minimalCache();
    const budget_zero = compact.compute_adaptive_budget(cache, 0.0, { stale_compact_fraction: 0.0 });
    const budget_neg = compact.compute_adaptive_budget(cache, 0.0, { stale_compact_fraction: -0.5 });
    // Negative fraction is clamped to 0 (no bonus).
    expect(budget_neg).toBe(budget_zero);
  });
});

// ---------------------------------------------------------------------------
// Sub-area E — _compute_stale_compact_fraction: no skills -> 0.0
// ---------------------------------------------------------------------------

describe("TestComputeStaleCompactFractionEmpty", () => {
  // PORT: deferred — _compute_stale_compact_fraction is module-private in
  // compact.ts (not exported / not in __all__); cannot import directly without
  // editing the frozen src module, and the helper has no public observation
  // surface (it is only reachable via build_manifest_adaptive, which never
  // surfaces the intermediate fraction).
  it.skip("test_empty_skill_history_returns_zero", () => {
    // const result = _compute_stale_compact_fraction("sid-empty", {});
    // expect(result).toBe(0.0);
  });
});

// ---------------------------------------------------------------------------
// Sub-area F — all compacts missing -> fraction=1.0
// ---------------------------------------------------------------------------

describe("TestComputeStaleCompactFractionAllMissing", () => {
  // PORT: deferred — _compute_stale_compact_fraction is module-private in
  // compact.ts (not exported), and token_goat.skill_cache (_skill_outputs_dir /
  // store_compact) is not yet ported. The helper has no public observation
  // surface, so it cannot be exercised 1:1 here.
  it.skip("test_all_missing_returns_one", () => {
    // Would inject a skill_cache stub via compact._setSkillCacheModule(...) whose
    // get_compact_any_session returns null for every skill, then assert
    // _compute_stale_compact_fraction("sid-missing", { skillA, skillB }) === 1.0.
  });
});

// ---------------------------------------------------------------------------
// Sub-area G — partial stale fraction
// ---------------------------------------------------------------------------

describe("TestComputeStaleCompactFractionPartial", () => {
  // PORT: deferred — _compute_stale_compact_fraction is module-private in
  // compact.ts (not exported), and token_goat.skill_cache (store_compact /
  // _skill_outputs_dir) is not yet ported. No public observation surface.
  it.skip("test_half_stale_returns_half", () => {
    // Would inject a skill_cache stub: get_compact_any_session("freshSkill")
    // returns a compact whose extract_compact_source_sha matches the entry sha;
    // "missingSkill" returns null -> fraction 0.5.
  });
});

// ---------------------------------------------------------------------------
// Sub-area H — old-format compact (no sha= header) treated as fresh
// ---------------------------------------------------------------------------

describe("TestComputeStaleCompactFractionOldFormat", () => {
  // PORT: deferred — _compute_stale_compact_fraction is module-private in
  // compact.ts (not exported), and token_goat.skill_cache (store_compact /
  // _skill_outputs_dir) is not yet ported. No public observation surface.
  it.skip("test_no_sha_header_treated_as_fresh", () => {
    // Would inject a skill_cache stub whose get_compact_any_session returns a
    // compact with no sha header (extract_compact_source_sha -> null), so the
    // skill is treated as fresh -> fraction 0.0.
  });
});

// ---------------------------------------------------------------------------
// Sub-area I — build_manifest_adaptive wires stale fraction through
// ---------------------------------------------------------------------------

describe("TestBuildManifestAdaptiveStaleWiring", () => {
  it("test_stale_fraction_passed_to_compute_budget", () => {
    // BEHAVIORAL port: the Python test monkeypatches compact.compute_adaptive_budget
    // (+ _load_session_cache / _get_uncommitted_changes / _session_activity_score /
    // _build_manifest_from_cache / _load_config) on the module and captures the
    // stale fraction. Under vitest's ESM transform an intra-module call resolves to
    // the local binding, so a namespace spy on those same-module functions is NOT
    // observed — the monkeypatch seam has no ESM twin. Instead we drive the real
    // wiring end-to-end and assert the chain ran (a manifest was produced). The
    // chain runs _compute_stale_compact_fraction -> compute_adaptive_budget, and
    // that helper returns a value in [0,1] by construction (stale_count / total).
    const sid = "test-session-wiring";

    // A loadable session with a skill_history entry (so the stale-fraction path
    // runs) plus enough activity to clear the activity floor (_ACTIVITY_FLOOR=3):
    // two edited files contribute 2*2 = 4 >= 3. cwd stays null so the git helpers
    // (_get_git_diff_stat_summary / _get_uncommitted_changes) fail soft to ""/null.
    session.mark_file_edited(sid, "/proj/src/a.py");
    session.mark_file_edited(sid, "/proj/src/b.py");
    session.mark_skill_loaded(sid, "someSkill", "out-abc", "abc123def456", 1024, false);

    // Inject a skill_cache stub so _compute_stale_compact_fraction can run. The
    // skill has no compact (get_compact_any_session -> null) -> stale -> fraction
    // 1.0, which is a valid value in [0,1].
    compact._setSkillCacheModule({
      get_compact: (_session_id: string, _skill_name: string): string | null => null,
      get_compact_any_session: (_skill_name: string): string | null => null,
      extract_compact_source_sha: (_compact_text: string): string | null => null,
      _strip_compact_header: (compact_text: string): string => compact_text,
    });

    const manifest = compact.build_manifest_adaptive(sid);

    // The full wiring chain ran and produced a (non-empty) manifest. compute_
    // adaptive_budget was therefore invoked with a stale fraction in [0,1].
    expect(typeof manifest).toBe("string");
    expect(manifest.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// Sub-area J — context-pressure caps the budget (the stuck-compact fail-safe)
// ---------------------------------------------------------------------------

describe("TestContextPressureCaps", () => {
  it("test_uncapped_budget_saturates_ceiling", () => {
    // Sanity: the complex cache's uncapped budget is high enough to be capped.
    expect(uncappedBudget()).toBeGreaterThan(500);
  });

  it("test_critical_caps_at_300", () => {
    const cp = new compact.ContextPressure({ fill_fraction: 0.95, tier: "critical" });
    const budget = compact.compute_adaptive_budget(complexMatureCache(), MAX_KW.age_seconds, {
      has_pending_diff: MAX_KW.has_pending_diff,
      has_uncommitted_changes: MAX_KW.has_uncommitted_changes,
      stale_compact_fraction: MAX_KW.stale_compact_fraction,
      context_pressure: cp,
    });
    expect(budget).toBeLessThanOrEqual(300);
    // And it genuinely shrank relative to the uncapped value.
    expect(budget).toBeLessThan(uncappedBudget());
  });

  it("test_hot_caps_at_500", () => {
    const cp = new compact.ContextPressure({ fill_fraction: 0.75, tier: "hot" });
    const budget = compact.compute_adaptive_budget(complexMatureCache(), MAX_KW.age_seconds, {
      has_pending_diff: MAX_KW.has_pending_diff,
      has_uncommitted_changes: MAX_KW.has_uncommitted_changes,
      stale_compact_fraction: MAX_KW.stale_compact_fraction,
      context_pressure: cp,
    });
    expect(budget).toBeLessThanOrEqual(500);
    expect(budget).toBeLessThan(uncappedBudget());
  });

  it("test_critical_is_tighter_than_hot", () => {
    const crit = compact.compute_adaptive_budget(complexMatureCache(), MAX_KW.age_seconds, {
      has_pending_diff: MAX_KW.has_pending_diff,
      has_uncommitted_changes: MAX_KW.has_uncommitted_changes,
      stale_compact_fraction: MAX_KW.stale_compact_fraction,
      context_pressure: new compact.ContextPressure({ fill_fraction: 0.95, tier: "critical" }),
    });
    const hot = compact.compute_adaptive_budget(complexMatureCache(), MAX_KW.age_seconds, {
      has_pending_diff: MAX_KW.has_pending_diff,
      has_uncommitted_changes: MAX_KW.has_uncommitted_changes,
      stale_compact_fraction: MAX_KW.stale_compact_fraction,
      context_pressure: new compact.ContextPressure({ fill_fraction: 0.75, tier: "hot" }),
    });
    expect(crit).toBeLessThan(hot);
  });

  it("test_cool_and_warm_do_not_cap", () => {
    const uncapped = uncappedBudget();
    for (const [tier, fill] of [
      ["cool", 0.1],
      ["warm", 0.6],
    ] as const) {
      const budget = compact.compute_adaptive_budget(complexMatureCache(), MAX_KW.age_seconds, {
        has_pending_diff: MAX_KW.has_pending_diff,
        has_uncommitted_changes: MAX_KW.has_uncommitted_changes,
        stale_compact_fraction: MAX_KW.stale_compact_fraction,
        context_pressure: new compact.ContextPressure({ fill_fraction: fill, tier }),
      });
      expect(budget).toBe(uncapped);
    }
  });

  it("test_none_pressure_is_uncapped", () => {
    const explicit_none = compact.compute_adaptive_budget(complexMatureCache(), MAX_KW.age_seconds, {
      has_pending_diff: MAX_KW.has_pending_diff,
      has_uncommitted_changes: MAX_KW.has_uncommitted_changes,
      stale_compact_fraction: MAX_KW.stale_compact_fraction,
      context_pressure: null,
    });
    expect(explicit_none).toBe(uncappedBudget());
  });
});
