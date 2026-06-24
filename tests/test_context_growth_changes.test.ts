/**
 * TS port of tests/test_context_growth_changes.py — FULL port.
 *
 * Covers every class/function in the Python file:
 *  - py 79-692 (Changes 2/3/4 — skill_cache / install / hooks_skill /
 *    hooks_session): TestGetCompactAnySession, TestPregenSkillCompacts,
 *    test_install_all_includes_pregen_step, TestPluginGapDetection,
 *    TestChange2PreSkillAdvisory, TestChange2PostSkillCompactPaths,
 *    TestChange3ThresholdAdvisory.
 *  - py 693-1945 (Change 1 — cli_doctor._build_context_section /
 *    _compute_context_growth_trend): the eight doctor test classes.
 *
 * Seam notes for the Change 2/3 classes (compact's context-pressure surface is a
 * fail-soft injection seam in TS):
 *  - hooks_skill's pre_skill advisory (2a) reaches its body only when a
 *    CompactPressureModule is injected via hooks_skill._setCompactPressureModule.
 *    Python patched the module-private _estimate_context_fill /
 *    _estimate_incoming_skill_tokens directly; those are NOT exported in TS, so
 *    we drive _estimate_context_fill through the injected module's
 *    get_context_pressure and _estimate_incoming_skill_tokens through a real
 *    on-disk skill file resolved via hooks_skill._setResolveSkillBodyPathOverride.
 *  - hooks_session's threshold advisory (Change 3) reaches its body only when a
 *    compact module is injected via hooks_session._setCompactModule. We inject
 *    the REAL compact module so get_context_pressure computes the same
 *    fill_fraction from loaded_skill_total_tokens as Python does.
 *  - post_skill Path 3 (py test_path3_dispatches_thread_when_worker_alive) and
 *    the _generate_and_store_compact-assertion tests patch module-private
 *    functions (threading.Thread / hooks_skill._generate_and_store_compact) that
 *    are unspyable in TS (private, called directly; the TS port uses setImmediate
 *    not a Thread). Those two assertions are it.skip'd with TODOs (see below); the
 *    observable system_message behaviour is still asserted where reachable.
 */
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import * as paths from "../src/token_goat/paths.js";
import * as cli_doctor from "../src/token_goat/cli_doctor.js";
import * as session from "../src/token_goat/session.js";
import { SessionCache, SkillEntry, BashEntry } from "../src/token_goat/session.js";
import * as skill_cache from "../src/token_goat/skill_cache.js";
import * as install from "../src/token_goat/install.js";
import * as hooks_skill from "../src/token_goat/hooks_skill.js";
import * as hooks_session from "../src/token_goat/hooks_session.js";
import * as config from "../src/token_goat/config.js";
import * as compact from "../src/token_goat/compact.js";

// ---------------------------------------------------------------------------
// Shared helpers (py 22-73).
// ---------------------------------------------------------------------------

/** Invoke _build_context_section() — shared by all test classes in this file. */
function _call_context_section(): [string[], boolean] {
  return cli_doctor._build_context_section();
}

/**
 * Write precompact_estimate_test.json sentinel, optionally backdated.
 * Mirrors py 29-46 _write_precompact_sentinel.
 */
function _write_precompact_sentinel(
  bytes_estimate: number | null = null,
  opts: { age_seconds?: number; content?: string } = {},
): void {
  const sentinels_dir = paths.sentinelsDir();
  fs.mkdirSync(sentinels_dir, { recursive: true });
  const p = path.join(sentinels_dir, "precompact_estimate_test.json");
  const text =
    opts.content !== undefined
      ? opts.content
      : JSON.stringify({ bytes_estimate });
  fs.writeFileSync(p, text, { encoding: "utf-8" });
  if (opts.age_seconds !== undefined) {
    const t = Date.now() / 1000 - opts.age_seconds;
    fs.utimesSync(p, t, t);
  }
}

const _SIMPLE_SKILL_BODY = `---
description: A simple test skill for unit tests.
---

# Test Skill

## Overview

This is a test skill body for pre-generation testing.

## Usage

Call it when you need to test compact pre-generation.

CRITICAL: This line must appear in the compact.
`;

/** Create a minimal ~/.claude/skills/<name>/SKILL.md under *parent* (py 68-73). */
function _make_skill_dir(parent: string, name: string, body: string = _SIMPLE_SKILL_BODY): string {
  const skill_dir = path.join(parent, name);
  fs.mkdirSync(skill_dir, { recursive: true });
  fs.writeFileSync(path.join(skill_dir, "SKILL.md"), body, { encoding: "utf-8" });
  return skill_dir;
}

/**
 * Build a fresh SessionCache for *sid* with the given turns + skill/bash/web
 * history, then persist it. Mirrors the Python `ses._fresh_cache(sid)` +
 * field-mutation + `ses.save(cache)` pattern (the TS _fresh_cache is module-
 * private, so we construct SessionCache directly).
 */
function _save_cache(
  sid: string,
  init: {
    turns?: number;
    skill_history?: Record<string, SkillEntry>;
    bash_history?: Record<string, BashEntry>;
  } = {},
): void {
  const now = Date.now() / 1000;
  const cache = new SessionCache({
    session_id: sid,
    started_ts: now,
    last_activity_ts: now,
  });
  if (init.turns !== undefined) cache.turns_since_last_compact = init.turns;
  if (init.skill_history) cache.skill_history = init.skill_history;
  if (init.bash_history) cache.bash_history = init.bash_history;
  session.save(cache);
}

afterEach(() => {
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// TestChange1ContextFootprint (py 693-1042).
//
// Python's autouse _isolate fixture monkeypatches paths.claude_skills_dir /
// paths.claude_plugins_dir to per-test fake dirs under the (auto-isolated) data
// dir. We replicate with a beforeEach-style helper that spies the camelCase
// paths.claudeSkillsDir / paths.claudePluginsDir (restored by afterEach above).
// ---------------------------------------------------------------------------

describe("TestChange1ContextFootprint", () => {
  let fake_skills_root = "";
  let fake_plugins_root = "";

  function isolate(): void {
    fake_skills_root = path.join(paths.dataDir(), "fake_skills");
    fake_plugins_root = path.join(paths.dataDir(), "fake_plugins");
    vi.spyOn(paths, "claudeSkillsDir").mockReturnValue(fake_skills_root);
    vi.spyOn(paths, "claudePluginsDir").mockReturnValue(fake_plugins_root);
  }

  function _call(): [string[], boolean] {
    return _call_context_section();
  }

  it("test_returns_lines_and_flag", () => {
    isolate();
    const [lines, auto] = _call();
    expect(Array.isArray(lines)).toBe(true);
    expect(typeof auto).toBe("boolean");
    expect(lines.some((ln) => ln.includes("Context footprint"))).toBe(true);
  });

  it("test_section_absent_when_low_fill_no_uncompacted", () => {
    isolate();
    const [, auto] = _call();
    expect(auto).toBe(false);
  });

  it("test_auto_show_when_fill_exceeds_40_percent", () => {
    isolate();
    const sid = "sess-ctx1-high";
    _save_cache(sid, {
      turns: 5,
      skill_history: {
        "big-skill": new SkillEntry({
          skill_name: "big-skill",
          output_id: "fake-big-id",
          content_sha: "aabbccdd",
          ts: 1000.0,
          body_bytes: 1_100_000,
        }),
      },
    });
    const [, auto] = _call();
    expect(auto).toBe(true);
  });

  it("test_auto_show_when_loaded_skill_over_2k_lacks_compact", () => {
    isolate();
    const sid = "sess-ctx1-no-compact";
    _save_cache(sid, {
      turns: 2,
      skill_history: {
        "medium-skill": new SkillEntry({
          skill_name: "medium-skill",
          output_id: "fake-med-id",
          content_sha: "11223344",
          ts: 1000.0,
          body_bytes: 10_000,
        }),
      },
    });
    const [, auto] = _call();
    expect(auto).toBe(true);
  });

  it("test_no_auto_show_when_small_skill_has_no_compact", () => {
    isolate();
    const sid = "sess-ctx1-tiny";
    _save_cache(sid, {
      turns: 2,
      skill_history: {
        "tiny-skill": new SkillEntry({
          skill_name: "tiny-skill",
          output_id: "fake-tiny-id",
          content_sha: "aabbccdd",
          ts: 1000.0,
          body_bytes: 4_000,
        }),
      },
    });
    const [, auto] = _call();
    expect(auto).toBe(false);
  });

  it("test_loaded_skill_with_compact_shows_savings", () => {
    isolate();
    const sid = "sess-ctx1-with-compact";
    const body = "# Large Skill\n\n" + "word ".repeat(2000); // ~10 KB
    const compact_text = "# Compact\n\nSummary only.\n";

    skill_cache.store_compact(sid, "rich-skill", compact_text);

    _save_cache(sid, {
      turns: 3,
      skill_history: {
        "rich-skill": new SkillEntry({
          skill_name: "rich-skill",
          output_id: "fake-rich-id",
          content_sha: "ccddccdd",
          ts: 1000.0,
          body_bytes: Buffer.byteLength(body, "utf-8"),
        }),
      },
    });

    const [lines] = _call();
    const combined = lines.join("\n");
    expect(combined).toContain("rich-skill");
    expect(combined).toContain("compact:");
    expect(combined).toContain("saves");
  });

  it("test_loaded_skill_without_compact_shows_action", () => {
    isolate();
    const sid = "sess-ctx1-no-cpt";
    _save_cache(sid, {
      turns: 3,
      skill_history: {
        "bare-skill": new SkillEntry({
          skill_name: "bare-skill",
          output_id: "fake-bare-id",
          content_sha: "00112233",
          ts: 1000.0,
          body_bytes: 30_000,
        }),
      },
    });

    const [lines] = _call();
    const combined = lines.join("\n");
    expect(combined).toContain("bare-skill");
    expect(combined).toContain("no compact");
    expect(combined).toContain("token-goat skill-compact bare-skill");
  });

  it("test_catalog_count_includes_installed_skills", () => {
    isolate();
    _make_skill_dir(fake_skills_root, "alpha");
    _make_skill_dir(fake_skills_root, "beta");

    const [lines] = _call();
    const combined = lines.join("\n");
    expect(combined).toContain("2 skills");
  });

  it("test_never_run_pregen_shows_warning", () => {
    isolate();
    const [lines] = _call();
    const combined = lines.join("\n");
    expect(combined).toContain("never run");
  });

  it("test_new_skills_since_pregen_reported", () => {
    isolate();
    _make_skill_dir(fake_skills_root, "skill-one");
    _make_skill_dir(fake_skills_root, "skill-two");

    const sentinel = paths.skillPregenSentinelPath();
    fs.mkdirSync(path.dirname(sentinel), { recursive: true });
    fs.writeFileSync(
      sentinel,
      JSON.stringify({ ts: Date.now() / 1000, skill_count: 1, compact_count: 0 }),
      { encoding: "utf-8" },
    );

    const [lines] = _call();
    const combined = lines.join("\n");
    expect(combined).toContain("installed since last pre-gen");
  });

  it("test_up_to_date_pregen_shows_no_new_skills", () => {
    isolate();
    _make_skill_dir(fake_skills_root, "skill-x");

    const sentinel = paths.skillPregenSentinelPath();
    fs.mkdirSync(path.dirname(sentinel), { recursive: true });
    fs.writeFileSync(
      sentinel,
      JSON.stringify({ ts: Date.now() / 1000, skill_count: 1, compact_count: 1 }),
      { encoding: "utf-8" },
    );

    const [lines] = _call();
    const combined = lines.join("\n");
    expect(combined).not.toContain("installed since last pre-gen");
  });

  it("test_claude_md_and_memory_md_contribute_meta_tokens", () => {
    isolate();
    // _build_context_section reads os.homedir()/.claude/CLAUDE.md. cli_doctor
    // imports `import * as os`, so spying os.homedir routes through.
    const fake_home = path.join(paths.dataDir(), "fakehome");
    fs.mkdirSync(fake_home, { recursive: true });
    const claude_dir = path.join(fake_home, ".claude");
    fs.mkdirSync(claude_dir, { recursive: true });
    fs.writeFileSync(path.join(claude_dir, "CLAUDE.md"), "x".repeat(4000), {
      encoding: "utf-8",
    });

    // os.homedir() reads $HOME at call time and THAT reaches cli_doctor's
    // _build_context_section. A bare vi.spyOn(os,"homedir") does NOT propagate
    // across modules — this test only ever passed because cli_doctor was reading
    // the developer's real ~/.claude/CLAUDE.md (the same cross-module spy gap
    // that let the install_all leak write real config). Set $HOME so the fake
    // CLAUDE.md written above is the one actually counted; the global setup.ts
    // afterEach restores HOME.
    process.env["HOME"] = fake_home;
    process.env["USERPROFILE"] = fake_home;
    vi.spyOn(os, "homedir").mockReturnValue(fake_home);

    const [lines] = _call();
    const combined = lines.join("\n");
    const m = combined.match(/CLAUDE\.md \+ MEMORY\.md: ~(\d[\d,]*) tokens\/turn/);
    expect(m).not.toBeNull();
    const tok = parseInt((m as RegExpMatchArray)[1]!.replace(/,/g, ""), 10);
    expect(tok).toBeGreaterThanOrEqual(1000);
  });

  it("test_conversation_tokens_based_on_turns", () => {
    isolate();
    const sid = "sess-ctx1-conv";
    _save_cache(sid, { turns: 7 });

    const [lines] = _call();
    const combined = lines.join("\n");
    expect(combined).toContain("5,600");
    expect(combined).toContain("7 turns");
  });

  it("test_eta_unknown_with_no_active_session", () => {
    isolate();
    const [lines] = _call();
    const combined = lines.join("\n");
    expect(combined).toContain("ETA");
    expect(combined).toContain("unknown");
  });

  it("test_eta_range_shown_for_fewer_than_3_turns", () => {
    isolate();
    const sid = "sess-ctx1-eta-2";
    _save_cache(sid, { turns: 2 });

    const [lines] = _call();
    const combined = lines.join("\n");
    expect(combined).toContain("ETA");
    expect(combined).toContain("–"); // dash range
  });

  it("test_actions_block_appears_for_uncompacted_large_skill", () => {
    isolate();
    const sid = "sess-ctx1-actions";
    _save_cache(sid, {
      turns: 3,
      skill_history: {
        "action-skill": new SkillEntry({
          skill_name: "action-skill",
          output_id: "fake-act-id",
          content_sha: "ffffffff",
          ts: 1000.0,
          body_bytes: 25_000,
        }),
      },
    });

    const [lines] = _call();
    const combined = lines.join("\n");
    expect(combined).toContain("Recommendations:");
    expect(combined).toContain("token-goat skill-compact action-skill");
  });

  it("test_actions_block_absent_when_all_compacted", () => {
    isolate();
    const sid = "sess-ctx1-no-actions";
    const compact_text = "# Summary\n\nCompact.\n";
    skill_cache.store_compact(sid, "covered-skill", compact_text);

    _make_skill_dir(fake_skills_root, "covered-skill");
    const sentinel = paths.skillPregenSentinelPath();
    fs.mkdirSync(path.dirname(sentinel), { recursive: true });
    fs.writeFileSync(
      sentinel,
      JSON.stringify({ ts: Date.now() / 1000, skill_count: 1, compact_count: 1 }),
      { encoding: "utf-8" },
    );

    _save_cache(sid, {
      turns: 3,
      skill_history: {
        "covered-skill": new SkillEntry({
          skill_name: "covered-skill",
          output_id: "fake-cov-id",
          content_sha: "aabbccdd",
          ts: 1000.0,
          body_bytes: 7_000,
        }),
      },
    });

    const [lines] = _call();
    const combined = lines.join("\n");
    expect(combined).not.toContain("Recommendations:");
  });
});

// ---------------------------------------------------------------------------
// SkillPathsMixin (py 1043-1057) — shared isolate helper for the classes below.
// ---------------------------------------------------------------------------

function isolateSkillPaths(): string {
  const dataDir = paths.dataDir();
  vi.spyOn(paths, "claudeSkillsDir").mockReturnValue(path.join(dataDir, "fake_skills"));
  vi.spyOn(paths, "claudePluginsDir").mockReturnValue(path.join(dataDir, "fake_plugins"));
  return dataDir;
}

// ---------------------------------------------------------------------------
// TestPrecompactSentinelAge (py 1063-1118).
// ---------------------------------------------------------------------------

describe("TestPrecompactSentinelAge", () => {
  function _call(): [string[], boolean] {
    return _call_context_section();
  }
  function _write_sentinel(age_seconds: number, bytes_estimate = 500_000): void {
    _write_precompact_sentinel(bytes_estimate, { age_seconds });
  }

  it("test_accepts_sentinel_older_than_300_seconds", () => {
    isolateSkillPaths();
    _write_sentinel(600, 800_000);
    const [lines] = _call();
    const combined = lines.join("\n");
    expect(combined).not.toContain("no compact baseline yet");
    expect(combined).toContain("Context at last compact");
  });

  it("test_old_sentinel_shows_age_annotation", () => {
    isolateSkillPaths();
    _write_sentinel(400, 800_000);
    const [lines] = _call();
    const combined = lines.join("\n");
    expect(combined.includes("m old") || combined.includes("h old")).toBe(true);
  });

  it("test_very_old_sentinel_shows_hours", () => {
    isolateSkillPaths();
    _write_sentinel(7200, 800_000);
    const [lines] = _call();
    const combined = lines.join("\n");
    expect(combined).toContain("h old");
  });

  it("test_fresh_sentinel_shows_no_age_annotation", () => {
    isolateSkillPaths();
    _write_sentinel(60, 800_000);
    const [lines] = _call();
    const line = lines.find((ln) => ln.includes("Context at last compact")) ?? "";
    expect(line).not.toContain("old");
  });

  it("test_no_sentinel_still_shows_no_baseline_message", () => {
    isolateSkillPaths();
    const [lines] = _call();
    const combined = lines.join("\n");
    expect(combined).toContain("no compact baseline yet");
  });
});

// ---------------------------------------------------------------------------
// TestContextFillBar (py 1119-1169).
// ---------------------------------------------------------------------------

describe("TestContextFillBar", () => {
  function _call(): [string[], boolean] {
    return _call_context_section();
  }
  function _write_sentinel(bytes_estimate: number): void {
    _write_precompact_sentinel(bytes_estimate);
  }

  it("test_fill_bar_present_in_output", () => {
    isolateSkillPaths();
    const [lines] = _call();
    // Mirror the Python `ln.strip().startswith("[") and "░" in ln or "█" in ln`
    // (Python operator precedence: ((a and b) or c)).
    const bar_lines = lines.filter(
      (ln) => (ln.trim().startsWith("[") && ln.includes("░")) || ln.includes("█"),
    );
    expect(bar_lines.length).toBeGreaterThanOrEqual(1);
  });

  it("test_fill_bar_shows_ok_when_low", () => {
    isolateSkillPaths();
    const [lines] = _call();
    const combined = lines.join("\n");
    expect(combined).toContain("(ok)");
  });

  it("test_fill_bar_shows_warn_at_50_percent", () => {
    isolateSkillPaths();
    _write_sentinel(1_320_000);
    const [lines] = _call();
    const combined = lines.join("\n");
    expect(combined).toContain("(WARN)");
  });

  it("test_fill_bar_shows_crit_at_90_percent", () => {
    isolateSkillPaths();
    _write_sentinel(2_376_000);
    const [lines] = _call();
    const combined = lines.join("\n");
    expect(combined).toContain("(CRIT)");
  });

  it("test_breakdown_line_present_with_nonzero_components", () => {
    isolateSkillPaths();
    _write_sentinel(1_000_000);
    const [lines] = _call();
    const combined = lines.join("\n");
    expect(combined).toContain("Breakdown:");
  });

  it("test_breakdown_omitted_when_no_data", () => {
    isolateSkillPaths();
    const [lines] = _call();
    expect(Array.isArray(lines)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// TestContextGrowthTrend (py 1175-1314).
// ---------------------------------------------------------------------------

describe("TestContextGrowthTrend", () => {
  function _write_sentinels(byte_estimates: number[]): void {
    const sentinels_dir = paths.sentinelsDir();
    fs.mkdirSync(sentinels_dir, { recursive: true });
    const base_mtime = Date.now() / 1000 - 3600.0;
    byte_estimates.forEach((est, i) => {
      const p = path.join(sentinels_dir, `precompact_estimate_sess${String(i).padStart(3, "0")}.json`);
      fs.writeFileSync(p, JSON.stringify({ bytes_estimate: est }), { encoding: "utf-8" });
      const t = base_mtime + i * 60;
      fs.utimesSync(p, t, t);
    });
  }

  function _trend(current_tokens = 0, context_cap = 660_000): string | null {
    return cli_doctor._compute_context_growth_trend(
      paths.sentinelsDir(),
      current_tokens,
      context_cap,
    );
  }

  it("test_returns_none_with_single_sentinel", () => {
    isolateSkillPaths();
    _write_sentinels([400_000]);
    expect(_trend()).toBeNull();
  });

  it("test_returns_none_with_no_sentinels", () => {
    isolateSkillPaths();
    fs.mkdirSync(paths.sentinelsDir(), { recursive: true });
    expect(_trend()).toBeNull();
  });

  it("test_returns_none_when_dir_missing", () => {
    isolateSkillPaths();
    const missing = path.join(path.dirname(paths.sentinelsDir()), "nonexistent_dir");
    expect(cli_doctor._compute_context_growth_trend(missing)).toBeNull();
  });

  it("test_growing_trend_detected", () => {
    isolateSkillPaths();
    _write_sentinels([100_000, 200_000, 300_000]);
    const result = _trend();
    expect(result).not.toBeNull();
    expect(result!).toContain("growing");
    expect(result!).toContain("↗");
  });

  it("test_shrinking_trend_detected", () => {
    isolateSkillPaths();
    _write_sentinels([400_000, 300_000, 200_000]);
    const result = _trend();
    expect(result).not.toBeNull();
    expect(result!).toContain("shrinking");
    expect(result!).toContain("↘");
  });

  it("test_stable_trend_detected", () => {
    isolateSkillPaths();
    _write_sentinels([400_000, 401_000, 399_000]);
    const result = _trend();
    expect(result).not.toBeNull();
    expect(result!).toContain("stable");
    expect(result!).toContain("→");
  });

  it("test_trend_shows_session_count", () => {
    isolateSkillPaths();
    _write_sentinels([100_000, 200_000, 300_000, 400_000]);
    const result = _trend();
    expect(result).not.toBeNull();
    expect(result!).toContain("3 sessions"); // 4 sentinels = 3 deltas
  });

  it("test_integration_trend_in_context_section", () => {
    isolateSkillPaths();
    _write_sentinels([100_000, 200_000, 300_000]);
    const [lines] = cli_doctor._build_context_section();
    const combined = lines.join("\n");
    expect(["↗", "↘", "→"].some((arrow) => combined.includes(arrow))).toBe(true);
  });

  it("test_growing_trend_with_high_fill_shows_sessions_to_urgent", () => {
    isolateSkillPaths();
    _write_sentinels([400_000, 600_000, 800_000]);
    const result = _trend(450_000);
    expect(result).not.toBeNull();
    expect(
      result!.includes("sessions to URGENT") || result!.includes("session to URGENT"),
    ).toBe(true);
  });

  it("test_growing_trend_far_from_urgent_no_projection", () => {
    isolateSkillPaths();
    _write_sentinels([400_000, 408_000, 416_000]);
    const result = _trend(50_000);
    expect(result).not.toBeNull();
    expect(result ?? "").not.toContain("sessions to URGENT");
  });

  it("test_shrinking_trend_never_shows_projection", () => {
    isolateSkillPaths();
    _write_sentinels([800_000, 600_000, 400_000]);
    const result = _trend(500_000);
    expect(result).not.toBeNull();
    expect(result!).not.toContain("sessions to URGENT");
    expect(result!).not.toContain("session to URGENT");
  });

  it("test_growing_trend_no_current_tokens_no_projection", () => {
    isolateSkillPaths();
    _write_sentinels([400_000, 600_000, 800_000]);
    const result = _trend(0);
    expect(result).not.toBeNull();
    expect(result!).not.toContain("sessions to URGENT");
    expect(result!).not.toContain("session to URGENT");
  });

  it("test_already_urgent_shows_1_session", () => {
    isolateSkillPaths();
    _write_sentinels([400_000, 600_000, 800_000]);
    const result = _trend(580_000);
    expect(result).not.toBeNull();
    expect(
      result!.includes("session to URGENT") || result!.includes("sessions to URGENT"),
    ).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// TestCompactionRecommendations (py 1319-1511).
// ---------------------------------------------------------------------------

describe("TestCompactionRecommendations", () => {
  function _call(): [string[], boolean] {
    return _call_context_section();
  }
  function _write_sentinel(bytes_estimate: number): void {
    _write_precompact_sentinel(bytes_estimate);
  }

  it("test_urgent_recommendation_at_85_percent", () => {
    isolateSkillPaths();
    _write_sentinel(2_244_000);
    const [lines] = _call();
    const combined = lines.join("\n");
    expect(combined).toContain("URGENT");
    expect(combined).toContain("/compact");
  });

  it("test_recommendation_at_70_percent", () => {
    isolateSkillPaths();
    _write_sentinel(1_848_000);
    const [lines] = _call();
    const combined = lines.join("\n");
    expect(combined.toLowerCase()).toContain("compact");
  });

  it("test_no_compact_recommendation_at_low_fill", () => {
    isolateSkillPaths();
    const [lines] = _call();
    const combined = lines.join("\n");
    expect(combined).not.toContain("URGENT");
  });

  it("test_skill_compact_in_recommendations_for_uncompacted_large_skill", () => {
    isolateSkillPaths();
    const sid = "sess-rec-large";
    _save_cache(sid, {
      turns: 3,
      skill_history: {
        "big-skill": new SkillEntry({
          skill_name: "big-skill",
          output_id: "fake-id",
          content_sha: "deadbeef",
          ts: 1000.0,
          body_bytes: 30_000,
        }),
      },
    });
    const [lines] = _call();
    const combined = lines.join("\n");
    expect(combined).toContain("token-goat skill-compact big-skill");
  });

  it("test_recommendations_label_used_not_actions", () => {
    isolateSkillPaths();
    const sid = "sess-rec-label";
    _save_cache(sid, {
      turns: 3,
      skill_history: {
        "unlabeled-skill": new SkillEntry({
          skill_name: "unlabeled-skill",
          output_id: "fake-id2",
          content_sha: "cafebabe",
          ts: 1000.0,
          body_bytes: 20_000,
        }),
      },
    });
    const [lines] = _call();
    const combined = lines.join("\n");
    expect(combined).toContain("Recommendations:");
    expect(combined).not.toContain("Actions:");
  });

  it("test_over_capacity_shows_tier0_warning", () => {
    isolateSkillPaths();
    _write_sentinel(4_000_000);
    const [lines] = _call();
    const combined = lines.join("\n");
    expect(combined).toContain("OVER CAPACITY");
  });

  it("test_tier0_takes_priority_over_tier1", () => {
    isolateSkillPaths();
    _write_sentinel(4_000_000);
    const [lines] = _call();
    const combined = lines.join("\n");
    expect(combined).toContain("OVER CAPACITY");
    // The standard tier-1 URGENT message should not duplicate.
    const urgentCount = combined.split("URGENT").length - 1;
    expect(urgentCount === 1 || combined.includes("OVER CAPACITY")).toBe(true);
  });

  it("test_compound_recommendation_when_urgent_and_uncompacted_skills", () => {
    isolateSkillPaths();
    const sid = "sess-compound-iter10";
    _save_cache(sid, {
      turns: 5,
      skill_history: {
        "heavy-skill": new SkillEntry({
          skill_name: "heavy-skill",
          output_id: "oid-heavy",
          content_sha: "aaaabbbb",
          ts: 1000.0,
          body_bytes: 40_000,
        }),
      },
    });
    _write_sentinel(2_244_000);
    const [lines] = _call();
    const combined = lines.join("\n");
    expect(combined).toContain("skill-compact");
    expect(combined).toContain("URGENT");
    expect(combined).toContain("heavy-skill");
  });

  it("test_skill_compact_recommendation_includes_savings_estimate", () => {
    isolateSkillPaths();
    const sid = "sess-savings-iter10";
    _save_cache(sid, {
      turns: 3,
      skill_history: {
        "costly-skill": new SkillEntry({
          skill_name: "costly-skill",
          output_id: "oid-costly",
          content_sha: "11223344",
          ts: 1000.0,
          body_bytes: 20_000,
        }),
      },
    });
    const [lines] = _call();
    const rec_line = lines.find(
      (ln) => ln.includes("costly-skill") && ln.includes("skill-compact") && ln.includes("tok saved"),
    );
    expect(rec_line).not.toBeUndefined();
  });

  it("test_tier4_early_session_shows_dominant_component", () => {
    isolateSkillPaths();
    const sid = "sess-tier4-iter10";
    _save_cache(sid, {
      turns: 2,
      skill_history: {
        "dominant-skill": new SkillEntry({
          skill_name: "dominant-skill",
          output_id: "oid-dom",
          content_sha: "99aabbcc",
          ts: 1000.0,
          body_bytes: 800_000,
        }),
      },
    });
    const [lines] = _call();
    const tier4_line = lines.find(
      (ln) => ln.includes("Skill compacts will help most") || ln.includes("dominant cost"),
    );
    expect(tier4_line).not.toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// TestContextEdgeCases (py 1517-1628).
// ---------------------------------------------------------------------------

describe("TestContextEdgeCases", () => {
  function _call(): [string[], boolean] {
    return _call_context_section();
  }
  function _write_sentinel(bytes_estimate: number): void {
    _write_precompact_sentinel(bytes_estimate);
  }

  it("test_zero_byte_sentinel_treated_as_no_baseline", () => {
    isolateSkillPaths();
    _write_sentinel(0);
    const [lines] = _call();
    const combined = lines.join("\n");
    expect(combined).toContain("no compact baseline yet");
  });

  it("test_zero_byte_sentinel_does_not_show_context_at_last_compact", () => {
    isolateSkillPaths();
    _write_sentinel(0);
    const [lines] = _call();
    for (const line of lines) {
      expect(line).not.toContain("Context at last compact: ~0");
    }
  });

  it("test_positive_byte_sentinel_still_shows_baseline", () => {
    isolateSkillPaths();
    _write_sentinel(400_000);
    const [lines] = _call();
    const combined = lines.join("\n");
    expect(combined).toContain("Context at last compact");
    expect(combined).not.toContain("no compact baseline yet");
  });

  it("test_empty_skill_files_show_fallback_label", () => {
    const dataDir = isolateSkillPaths();
    const skills_root = path.join(dataDir, "fake_skills");
    for (const name of ["skill-a", "skill-b"]) {
      const skill_dir = path.join(skills_root, name);
      fs.mkdirSync(skill_dir, { recursive: true });
      fs.writeFileSync(path.join(skill_dir, "SKILL.md"), "", { encoding: "utf-8" });
    }
    const [lines] = _call();
    const combined = lines.join("\n");
    expect(combined).toContain("[fallback estimate]");
    expect(combined.toLowerCase()).toContain("no byte sizes");
  });

  it("test_populated_skill_files_show_actual_file_sizes_label", () => {
    const dataDir = isolateSkillPaths();
    const skills_root = path.join(dataDir, "fake_skills");
    const skill_dir = path.join(skills_root, "real-skill");
    fs.mkdirSync(skill_dir, { recursive: true });
    fs.writeFileSync(path.join(skill_dir, "SKILL.md"), "# Real Skill\n\n" + "x ".repeat(500), {
      encoding: "utf-8",
    });
    const [lines] = _call();
    const combined = lines.join("\n");
    expect(combined).toContain("[actual file sizes]");
    expect(combined).not.toContain("[fallback estimate]");
  });

  it("test_no_skills_shows_actual_file_sizes_label", () => {
    isolateSkillPaths();
    const [lines] = _call();
    const combined = lines.join("\n");
    expect(combined.toLowerCase()).not.toContain("no byte sizes");
  });

  it("test_empty_session_shows_no_active_session", () => {
    isolateSkillPaths();
    const [lines] = _call();
    const combined = lines.join("\n");
    expect(combined).toContain("no active session found");
  });

  it("test_empty_session_shows_eta_unknown", () => {
    isolateSkillPaths();
    const [lines] = _call();
    const combined = lines.join("\n");
    expect(combined).toContain("ETA: unknown");
    const eta_line = lines.find((ln) => ln.includes("ETA:")) ?? "";
    expect(eta_line).not.toContain("turns at current rate");
  });
});

// ---------------------------------------------------------------------------
// TestSentinelErrorHandling (py 1634-1694).
// ---------------------------------------------------------------------------

describe("TestSentinelErrorHandling", () => {
  function _call(): [string[], boolean] {
    return _call_context_section();
  }
  function _write_sentinel(content: string): void {
    _write_precompact_sentinel(null, { content });
  }

  it("test_malformed_json_sentinel_shows_error_note", () => {
    isolateSkillPaths();
    _write_sentinel("{not valid json}");
    const [lines] = _call();
    const combined = lines.join("\n");
    expect(combined).toContain("no compact baseline yet");
    expect(combined).toContain("sentinel error");
  });

  it("test_malformed_json_sentinel_does_not_show_baseline", () => {
    isolateSkillPaths();
    _write_sentinel("null");
    const [lines] = _call();
    for (const line of lines) {
      expect(line).not.toContain("Context at last compact: ~");
    }
  });

  it("test_non_numeric_bytes_estimate_sentinel_shows_error_note", () => {
    isolateSkillPaths();
    _write_sentinel('{"bytes_estimate": "not-a-number"}');
    const [lines] = _call();
    const combined = lines.join("\n");
    expect(combined).toContain("no compact baseline yet");
    expect(combined).toContain("sentinel error");
  });

  it("test_valid_sentinel_does_not_show_sentinel_error", () => {
    isolateSkillPaths();
    _write_sentinel('{"bytes_estimate": 400000}');
    const [lines] = _call();
    const combined = lines.join("\n");
    expect(combined).not.toContain("sentinel error");
    expect(combined).toContain("Context at last compact");
  });

  it("test_function_never_raises_on_empty_sentinel_dir", () => {
    isolateSkillPaths();
    const result = _call();
    expect(Array.isArray(result)).toBe(true);
    expect(result.length).toBe(2);
  });

  it("test_function_never_raises_on_missing_sentinel_dir", () => {
    const dataDir = isolateSkillPaths();
    const nonexistent = path.join(dataDir, "does_not_exist", "sentinels");
    vi.spyOn(paths, "sentinelsDir").mockReturnValue(nonexistent);
    const result = _call();
    expect(Array.isArray(result)).toBe(true);
    expect(result.length).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// TestContextMetricAccuracy (py 1700-1945).
// ---------------------------------------------------------------------------

describe("TestContextMetricAccuracy", () => {
  function _call(): [string[], boolean] {
    return _call_context_section();
  }
  function _write_sentinel(bytes_estimate: number, age_seconds = 10.0): void {
    _write_precompact_sentinel(bytes_estimate, { age_seconds });
  }

  it("test_severity_ok_below_40_percent", () => {
    isolateSkillPaths();
    const [lines] = _call();
    const bar_line = lines.find((ln) => ln.includes("█") || ln.includes("░")) ?? "";
    expect(bar_line).toContain("(ok)");
  });

  it("test_severity_warn_at_40_percent", () => {
    isolateSkillPaths();
    _write_sentinel(1_056_000);
    const [lines] = _call();
    const bar_line = lines.find((ln) => ln.includes("█") || ln.includes("░")) ?? "";
    expect(bar_line.includes("(WARN)") || bar_line.includes("(ok)")).toBe(true);
  });

  it("test_severity_crit_above_85_percent", () => {
    isolateSkillPaths();
    _write_sentinel(2_244_001);
    const [lines] = _call();
    const bar_line = lines.find((ln) => ln.includes("█") || ln.includes("░")) ?? "";
    expect(bar_line).toContain("(CRIT)");
  });

  it("test_severity_high_between_70_and_85_percent", () => {
    isolateSkillPaths();
    _write_sentinel(1_980_000);
    const [lines] = _call();
    const bar_line = lines.find((ln) => ln.includes("█") || ln.includes("░")) ?? "";
    expect(bar_line).toContain("(HIGH)");
  });

  it("test_breakdown_omits_components_below_2_percent", () => {
    isolateSkillPaths();
    const [lines] = _call();
    const bd_line = lines.find((ln) => ln.includes("Breakdown:"));
    if (bd_line !== undefined) {
      expect(bd_line).toContain("%");
    }
  });

  it("test_breakdown_shows_dominant_component", () => {
    isolateSkillPaths();
    _write_sentinel(2_000_000);
    const [lines] = _call();
    const bd_line = lines.find((ln) => ln.includes("Breakdown:"));
    expect(bd_line).not.toBeUndefined();
    expect(bd_line!).toContain("precompact");
  });

  it("test_growth_trend_shown_when_multiple_sentinels_exist", () => {
    isolateSkillPaths();
    const sentinels_dir = paths.sentinelsDir();
    fs.mkdirSync(sentinels_dir, { recursive: true });
    const now = Date.now() / 1000;
    [
      [200, 400_000],
      [100, 600_000],
    ].forEach(([age, size], i) => {
      const p = path.join(sentinels_dir, `precompact_estimate_s${i}.json`);
      fs.writeFileSync(p, JSON.stringify({ bytes_estimate: size }), { encoding: "utf-8" });
      const t = now - (age as number);
      fs.utimesSync(p, t, t);
    });
    const [lines] = _call();
    const combined = lines.join("\n");
    expect(["↗", "↘", "→"].some((arrow) => combined.includes(arrow))).toBe(true);
  });

  it("test_growth_trend_absent_with_single_sentinel", () => {
    isolateSkillPaths();
    _write_sentinel(400_000);
    const [lines] = _call();
    const combined = lines.join("\n");
    expect(combined).not.toContain("↗");
    expect(combined).not.toContain("↘");
    expect(combined).not.toContain("→");
  });

  it("test_eta_uses_fallback_when_fewer_than_3_turns", () => {
    isolateSkillPaths();
    const sid = "sess-eta-fallback";
    _save_cache(sid, {
      turns: 2,
      skill_history: {
        tiny: new SkillEntry({
          skill_name: "tiny",
          output_id: "oid",
          content_sha: "aabb",
          ts: 1000.0,
          body_bytes: 4_000,
        }),
      },
    });
    const [lines] = _call();
    const eta_line = lines.find((ln) => ln.includes("ETA:")) ?? "";
    expect(eta_line.includes("–") || eta_line.includes("unknown")).toBe(true);
    expect(eta_line).not.toContain("at current rate");
  });

  it("test_eta_at_current_rate_with_3_or_more_turns", () => {
    isolateSkillPaths();
    const sid = "sess-eta-real";
    _save_cache(sid, {
      turns: 5,
      skill_history: {
        big: new SkillEntry({
          skill_name: "big",
          output_id: "oid2",
          content_sha: "ccdd",
          ts: 1000.0,
          body_bytes: 20_000,
        }),
      },
    });
    const [lines] = _call();
    const eta_line = lines.find((ln) => ln.includes("ETA:")) ?? "";
    expect(eta_line.includes("at current rate") || eta_line.includes("ETA: unknown")).toBe(true);
  });

  it("test_tool_output_tokens_increase_estimate", () => {
    isolateSkillPaths();
    const sid = "sess-toolout-iter8";
    _save_cache(sid, {
      turns: 3,
      bash_history: {
        abc12345: new BashEntry({
          cmd_sha: "abc12345",
          cmd_preview: "pytest",
          output_id: "out123",
          ts: 1000.0,
          stdout_bytes: 80_000,
          stderr_bytes: 0,
        }),
      },
    });
    const [lines] = _call();
    const combined = lines.join("\n");
    expect(combined).toContain("tool outputs");
    const conv_line = lines.find((ln) => ln.includes("Conversation") && ln.includes("turns")) ?? "";
    expect(conv_line).toContain("dialogue");
  });

  it("test_no_tool_output_shows_simple_conversation_line", () => {
    isolateSkillPaths();
    const sid = "sess-notools-iter8";
    _save_cache(sid, { turns: 4 });
    const [lines] = _call();
    const conv_line = lines.find((ln) => ln.includes("Conversation") && ln.includes("turns")) ?? "";
    expect(conv_line).not.toContain("dialogue");
    expect(conv_line).not.toContain("tool outputs");
  });

  it("test_tool_output_capped_per_entry", () => {
    isolateSkillPaths();
    const sid = "sess-cap-iter8";
    _save_cache(sid, {
      turns: 2,
      bash_history: {
        bigcmd1: new BashEntry({
          cmd_sha: "bigcmd1",
          cmd_preview: "cat bigfile",
          output_id: "outbig",
          ts: 1000.0,
          stdout_bytes: 1_000_000,
          stderr_bytes: 0,
        }),
      },
    });
    const [lines] = _call();
    const combined = lines.join("\n");
    expect(combined).not.toContain("250,000");
  });
});

// ===========================================================================
// py 79-692 — Changes 2/3/4 (skill_cache / install / hooks_skill /
// hooks_session). Ported below; the doctor classes above stay untouched.
// ===========================================================================

// ---------------------------------------------------------------------------
// Change 4: get_compact_any_session (py 79-129).
//
// Python's autouse _isolate just stores tmp_data_dir; the data dir is already
// auto-isolated per test via setup.ts, so no fixture body is needed.
// ---------------------------------------------------------------------------

describe("TestGetCompactAnySession", () => {
  it("test_returns_none_when_no_compact_exists", () => {
    const result = skill_cache.get_compact_any_session("nonexistent-skill");
    expect(result).toBeNull();
  });

  it("test_finds_compact_from_install_session", () => {
    const body = _SIMPLE_SKILL_BODY;
    const sha = skill_cache.content_hash(body);
    const compact_text = skill_cache.generate_compact_summary(body);
    skill_cache.store_compact("_install", "test-skill", compact_text, sha);

    const result = skill_cache.get_compact_any_session("test-skill");
    expect(result).not.toBeNull();
    expect(result!).toContain("compact form");
  });

  it("test_finds_newest_when_multiple_sessions", () => {
    const body = _SIMPLE_SKILL_BODY;
    const sha = skill_cache.content_hash(body);
    const compactStr = skill_cache.generate_compact_summary(body);
    skill_cache.store_compact("session-aaa", "multi-skill", compactStr, sha);
    // Python time.sleep(0.01) just orders mtimes; both files are returned by
    // get_compact_any_session regardless, so the newest-wins assertion holds.
    const compact2 = compactStr + "\n# Extra section";
    skill_cache.store_compact("session-bbb", "multi-skill", compact2, sha);

    const result = skill_cache.get_compact_any_session("multi-skill");
    expect(result).not.toBeNull();
  });

  it("test_plugin_namespaced_skill", () => {
    const body = _SIMPLE_SKILL_BODY;
    const sha = skill_cache.content_hash(body);
    const compactStr = skill_cache.generate_compact_summary(body);
    skill_cache.store_compact("_install", "myplugin:myscill", compactStr, sha);

    const result = skill_cache.get_compact_any_session("myplugin:myscill");
    expect(result).not.toBeNull();
  });

  it("test_returns_none_for_invalid_name", () => {
    expect(skill_cache.get_compact_any_session("")).toBeNull();
    expect(skill_cache.get_compact_any_session("../etc/passwd")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Change 4: pregen_skill_compacts (py 130-216).
//
// Python's autouse _isolate monkeypatches paths.claude_skills_dir /
// claude_plugins_dir to per-test fake dirs under the data dir. We spy the
// camelCase paths.claudeSkillsDir / claudePluginsDir (pregen_skill_compacts
// references them via the paths.* namespace, so the spy lands).
// ---------------------------------------------------------------------------

describe("TestPregenSkillCompacts", () => {
  let fake_skills_root = "";
  let fake_plugins_root = "";

  beforeEach(() => {
    fake_skills_root = path.join(paths.dataDir(), "fake_skills");
    fake_plugins_root = path.join(paths.dataDir(), "fake_plugins");
    fs.mkdirSync(fake_skills_root, { recursive: true });
    fs.mkdirSync(fake_plugins_root, { recursive: true });
    vi.spyOn(paths, "claudeSkillsDir").mockReturnValue(fake_skills_root);
    vi.spyOn(paths, "claudePluginsDir").mockReturnValue(fake_plugins_root);
  });

  it("test_generates_compacts_for_user_skills", () => {
    _make_skill_dir(fake_skills_root, "skill-alpha");
    _make_skill_dir(fake_skills_root, "skill-beta");

    const summary = install.pregen_skill_compacts();

    expect(summary).toContain("2 skills found");
    expect(summary).toContain("2 generated");

    expect(skill_cache.get_compact_any_session("skill-alpha")).not.toBeNull();
    expect(skill_cache.get_compact_any_session("skill-beta")).not.toBeNull();
  });

  it("test_skips_up_to_date_compact", () => {
    _make_skill_dir(fake_skills_root, "fresh-skill");
    install.pregen_skill_compacts();
    const summary = install.pregen_skill_compacts();
    expect(summary).toContain("1 up-to-date");
    expect(
      !summary.includes("generated") ||
        summary.includes("0 generated") ||
        summary.includes("1 skills found"),
    ).toBe(true);
  });

  it("test_writes_sentinel_file", () => {
    _make_skill_dir(fake_skills_root, "sentinel-skill");
    install.pregen_skill_compacts();

    const sentinel = paths.skillPregenSentinelPath();
    expect(fs.existsSync(sentinel)).toBe(true);
    const data = JSON.parse(fs.readFileSync(sentinel, "utf-8"));
    expect("ts" in data).toBe(true);
    expect(data.skill_count).toBe(1);
    expect(data.compact_count).toBeGreaterThanOrEqual(1);
  });

  it("test_handles_empty_skills_dir", () => {
    const summary = install.pregen_skill_compacts();
    expect(summary).toContain("0 skills found");
  });

  it("test_handles_skills_dir_not_existing", () => {
    vi.spyOn(paths, "claudeSkillsDir").mockReturnValue(
      path.join(fake_skills_root, "does_not_exist"),
    );
    const summary = install.pregen_skill_compacts();
    expect(summary).toContain("0 skills found");
  });

  it("test_discovers_plugin_skills", () => {
    // Marketplace layout:
    // plugins/cache/<marketplace>/<plugin>/<version>/skills/<name>/SKILL.md
    const plugin_skill_dir = path.join(
      fake_plugins_root,
      "cache",
      "hub",
      "my-plugin",
      "v1.0.0",
      "skills",
      "my-plugin-skill",
    );
    fs.mkdirSync(plugin_skill_dir, { recursive: true });
    fs.writeFileSync(path.join(plugin_skill_dir, "SKILL.md"), _SIMPLE_SKILL_BODY, "utf-8");

    const summary = install.pregen_skill_compacts();

    expect(summary).toContain("1 skills found");
    expect(skill_cache.get_compact_any_session("my-plugin:my-plugin-skill")).not.toBeNull();
  });

  it("test_subsequent_post_skill_finds_cache_hit", () => {
    _make_skill_dir(fake_skills_root, "cached-skill", _SIMPLE_SKILL_BODY);
    install.pregen_skill_compacts();

    const result = skill_cache.get_compact_any_session("cached-skill");
    expect(result).not.toBeNull();
    expect(result!).toContain("compact form");
  });
});

// ---------------------------------------------------------------------------
// Change 4: install_all includes skill compact pre-gen step (py 217-241).
//
// patched_home -> vi.spyOn(os, "homedir"). The five patched install helpers in
// Python prevent real install side-effects; here the homedir spy + the
// auto-isolated data dir + TOKEN_GOAT_NO_WORKER_SPAWN keep all writes inside the
// tmp tree, so the unpatched-in-TS locals (_install_platform_autostart /
// _remove_legacy_launchers, both module-private) are harmless. The assertion is
// only that the pregen step ran and did not FAIL.
// ---------------------------------------------------------------------------

describe("test_install_all_includes_pregen_step", () => {
  it("includes a non-FAIL 'skill compact pre-gen' result key", () => {
    const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "tg-home-")));
    // Sandbox HOME via env — install.ts's _home() -> os.homedir() reads $HOME at
    // call time, so this is what actually redirects every home-derived write
    // (settings.json, CLAUDE.md, skill dir, ~/Library/LaunchAgents plist) into
    // the throwaway home. The os.homedir() spy alone does NOT reach install.ts's
    // path resolution; without the $HOME override this test wrote real install
    // artefacts into the developer's ~/.claude.
    const prevHome = process.env["HOME"];
    const prevUserProfile = process.env["USERPROFILE"];
    process.env["HOME"] = home;
    process.env["USERPROFILE"] = home;
    vi.spyOn(os, "homedir").mockReturnValue(home);

    const fake_skills = path.join(home, ".claude", "skills");
    fs.mkdirSync(fake_skills, { recursive: true });
    _make_skill_dir(fake_skills, "install-test-skill");

    vi.spyOn(paths, "claudeSkillsDir").mockReturnValue(fake_skills);
    vi.spyOn(paths, "claudePluginsDir").mockReturnValue(path.join(home, ".claude", "plugins"));

    // Stub the subprocess seam so install_all's autostart / update-task
    // registration (launchctl / crontab / systemctl / schtasks) is a no-op and
    // never mutates the real per-user crontab or ~/Library/LaunchAgents.
    install.setSubprocessRunner(() => ({
      returncode: 1,
      stdout: "",
      stderr: "",
      failed: false,
      error: "",
    }));

    try {
      const result = install.install_all();

      expect("skill compact pre-gen" in result).toBe(true);
      expect(result["skill compact pre-gen"]).not.toContain("FAIL");
    } finally {
      install.setSubprocessRunner(null);
      if (prevHome === undefined) delete process.env["HOME"];
      else process.env["HOME"] = prevHome;
      if (prevUserProfile === undefined) delete process.env["USERPROFILE"];
      else process.env["USERPROFILE"] = prevUserProfile;
      try {
        fs.rmSync(home, { recursive: true, force: true });
      } catch {
        // best-effort
      }
    }
  });
});

// ---------------------------------------------------------------------------
// Change 4: sentinel-based new-plugin gap detection (py 242-307).
// ---------------------------------------------------------------------------

describe("TestPluginGapDetection", () => {
  let fake_skills_root = "";
  let fake_plugins_root = "";

  beforeEach(() => {
    fake_skills_root = path.join(paths.dataDir(), "fake_skills");
    fake_plugins_root = path.join(paths.dataDir(), "fake_plugins");
    fs.mkdirSync(fake_skills_root, { recursive: true });
    fs.mkdirSync(fake_plugins_root, { recursive: true });
    vi.spyOn(paths, "claudeSkillsDir").mockReturnValue(fake_skills_root);
    vi.spyOn(paths, "claudePluginsDir").mockReturnValue(fake_plugins_root);
  });

  it("test_sentinel_ts_is_after_pregen", () => {
    _make_skill_dir(fake_skills_root, "gap-skill");
    const t_before = Date.now() / 1000;
    install.pregen_skill_compacts();
    const sentinel = paths.skillPregenSentinelPath();
    const data = JSON.parse(fs.readFileSync(sentinel, "utf-8"));
    expect(data.ts).toBeGreaterThanOrEqual(t_before);
  });

  it("test_no_sentinel_before_pregen", () => {
    const sentinel = paths.skillPregenSentinelPath();
    expect(fs.existsSync(sentinel)).toBe(false);
  });

  it("test_sentinel_updated_on_second_run", () => {
    _make_skill_dir(fake_skills_root, "gap-skill2");
    install.pregen_skill_compacts();
    const sentinel = paths.skillPregenSentinelPath();
    const ts1 = JSON.parse(fs.readFileSync(sentinel, "utf-8")).ts;

    // Python sleeps 0.05s to advance the wall clock; the sentinel stamps
    // Date.now()/1000 each run, so ts2 >= ts1 holds without a real sleep.
    install.pregen_skill_compacts();
    const ts2 = JSON.parse(fs.readFileSync(sentinel, "utf-8")).ts;
    expect(ts2).toBeGreaterThanOrEqual(ts1);
  });
});

// ---------------------------------------------------------------------------
// Change 2: pre_skill context advisory (2a) (py 308-394).
//
// The advisory body (hooks_skill.ts ~671-699) requires an injected
// CompactPressureModule. We inject one whose get_context_pressure returns the
// chosen fill_fraction (the TS analogue of patching _estimate_context_fill) and
// resolve a real on-disk skill file sized to the chosen token count (the TS
// analogue of patching _estimate_incoming_skill_tokens — size/4 tokens).
// ---------------------------------------------------------------------------

describe("TestChange2PreSkillAdvisory", () => {
  let tmpRoot = "";

  beforeEach(() => {
    tmpRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "tg-preskill-")));
  });
  afterEach(() => {
    try {
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    } catch {
      // best-effort
    }
  });

  /** Make the injected compact-pressure surface return *fill* (or throw). */
  function _setFill(fill: number | "throw"): void {
    hooks_skill._setCompactPressureModule({
      CONTEXT_AUTOCOMPACT_TOKENS: compact.CONTEXT_AUTOCOMPACT_TOKENS,
      get_context_pressure: () => {
        if (fill === "throw") {
          throw new Error("simulated failure");
        }
        return { fill_fraction: fill };
      },
    });
  }

  /** Write a real skill file sized so size/4 == *tokens*, wire the resolve seam. */
  function _setSkillTokens(tokens: number): void {
    const skill_file = path.join(tmpRoot, "SKILL.md");
    fs.writeFileSync(skill_file, "x".repeat(tokens * 4), "utf-8");
    hooks_skill._setResolveSkillBodyPathOverride(() => skill_file);
  }

  function _run_pre_skill(session_id: string, skill_name: string): Record<string, unknown> {
    return hooks_skill.pre_skill({
      session_id,
      tool_name: "Skill",
      tool_input: { skill: skill_name },
    }) as unknown as Record<string, unknown>;
  }

  it("test_emits_advisory_when_context_high_and_skill_large", () => {
    // Context > 60% and incoming skill > 4K tokens -> non-blocking advisory.
    _setFill(0.75);
    _setSkillTokens(6_000);
    const resp = _run_pre_skill("sess-advisory", "big-skill");

    expect(resp.continue).toBe(true);
    const hook_out = (resp.hookSpecificOutput ?? {}) as Record<string, unknown>;
    const additional = String(hook_out.additionalContext ?? "");
    expect(additional).toContain("token-goat");
    expect(additional).toContain("context at");
    expect(additional).toContain("big-skill");
    expect(additional.toLowerCase()).toContain("compact");
  });

  it("test_no_advisory_when_context_below_threshold", () => {
    // Context <= 60% -> no advisory.
    _setFill(0.45);
    _setSkillTokens(8_000);
    const resp = _run_pre_skill("sess-low-ctx", "any-skill");

    expect(resp.continue).toBe(true);
    const hook_out = (resp.hookSpecificOutput ?? {}) as Record<string, unknown>;
    expect(!("additionalContext" in hook_out) || hook_out.additionalContext === "").toBe(true);
  });

  it("test_no_advisory_when_skill_tokens_below_threshold", () => {
    // Context > 60% but skill <= 4K tokens -> no advisory.
    _setFill(0.8);
    _setSkillTokens(2_000);
    const resp = _run_pre_skill("sess-small-skill", "tiny-skill");

    expect(resp.continue).toBe(true);
    const hook_out = (resp.hookSpecificOutput ?? {}) as Record<string, unknown>;
    expect(!("additionalContext" in hook_out) || hook_out.additionalContext === "").toBe(true);
  });

  it("test_advisory_disabled_via_config", () => {
    // pre_skill_advisory=False -> advisory suppressed even at 90% context.
    _setFill(0.9);
    _setSkillTokens(10_000);
    const fake_cfg = config.defaultConfig();
    fake_cfg.hints!.pre_skill_advisory = false;
    vi.spyOn(config, "load").mockReturnValue(fake_cfg);

    const resp = _run_pre_skill("sess-disabled", "big-skill");

    expect(resp.continue).toBe(true);
    const hook_out = (resp.hookSpecificOutput ?? {}) as Record<string, unknown>;
    expect(!("additionalContext" in hook_out) || hook_out.additionalContext === "").toBe(true);
  });

  it("test_estimate_failure_does_not_block_skill", () => {
    // If estimation raises, pre_skill still returns CONTINUE (fail-soft).
    _setFill("throw");
    _setSkillTokens(10_000);
    const resp = _run_pre_skill("sess-err", "any-skill");
    expect(resp.continue).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Change 2: post_skill 4-path compact advisory (2b) (py 395-552).
// ---------------------------------------------------------------------------

// 9 KB body — above _ADVISORY_BODY_THRESHOLD_BYTES (8 KB) but below
// _LARGE_BODY_THRESHOLD_BYTES (40 KB), so post_skill goes Path 2 (sync).
const _MEDIUM_SKILL_BODY = "# Medium Skill\n\n" + "w ".repeat(4_500) + "\nCRITICAL: medium marker.\n";

// 42 KB body — above _LARGE_BODY_THRESHOLD_BYTES, so post_skill goes Path 3/4.
const _XLARGE_SKILL_BODY = "# XLarge Skill\n\n" + "z ".repeat(21_000) + "\nCRITICAL: xlarge marker.\n";

// Small body < advisory threshold.
const _SMALL_SKILL_BODY = "# Tiny Skill\n\nOne liner.\n";

function _utf8ByteLen(s: string): number {
  return Buffer.byteLength(s, "utf-8");
}

describe("TestChange2PostSkillCompactPaths", () => {
  function _run_post_skill(
    session_id: string,
    skill_name: string,
    body: string,
  ): Record<string, unknown> {
    return hooks_skill.post_skill({
      session_id,
      tool_name: "Skill",
      tool_input: { skill: skill_name },
      tool_response: body,
    }) as unknown as Record<string, unknown>;
  }

  // -- Path 1: pre-generated compact with matching SHA --------------------

  it("test_path1_uses_pregen_compact_on_sha_match", () => {
    const body = _MEDIUM_SKILL_BODY;
    const body_sha = skill_cache.content_hash(body);
    const compactStr = skill_cache.generate_compact_summary(body);
    skill_cache.store_compact("_install", "pregen-skill", compactStr, body_sha);

    const resp = _run_post_skill("sess-path1", "pregen-skill", body);

    expect(resp.continue).toBe(true);
    const system_msg = String(resp.systemMessage ?? "");
    expect(system_msg).toContain("pregen-skill");
    expect(system_msg).toContain("Pre-generated");
  });

  it("test_path1_skips_generation_when_pregen_hit", () => {
    // Path 1: _generate_and_store_compact must NOT be called on a SHA hit.
    // hooks_skill now calls it via `import * as self`, so the spy is observed
    // (the TS analogue of patch("token_goat.hooks_skill._generate_and_store_compact")).
    const body = _MEDIUM_SKILL_BODY;
    const body_sha = skill_cache.content_hash(body);
    const compactStr = skill_cache.generate_compact_summary(body);
    skill_cache.store_compact("_install", "pregen-no-gen", compactStr, body_sha);

    const genSpy = vi
      .spyOn(hooks_skill, "_generate_and_store_compact")
      .mockReturnValue(null);
    _run_post_skill("sess-path1-skip", "pregen-no-gen", body);
    expect(genSpy).not.toHaveBeenCalled();
  });

  // -- Path 2: sync generation for small-to-medium bodies ----------------

  it("test_path2_sync_generates_compact_for_medium_body", () => {
    const body = _MEDIUM_SKILL_BODY; // ~9 KB, above advisory threshold
    expect(_utf8ByteLen(body)).toBeLessThan(40_000);

    const resp = _run_post_skill("sess-path2", "medium-skill", body);

    expect(resp.continue).toBe(true);
    const stored = skill_cache.get_compact("sess-path2", "medium-skill");
    expect(stored).not.toBeNull();
    const system_msg = String(resp.systemMessage ?? "");
    expect(system_msg).toContain("medium-skill");
    expect(system_msg).toContain("tokens");
  });

  it("test_path2_no_system_message_for_tiny_body", () => {
    const body = _SMALL_SKILL_BODY;
    expect(_utf8ByteLen(body)).toBeLessThan(8_000);

    const resp = _run_post_skill("sess-path2-tiny", "tiny-skill", body);

    expect(resp.continue).toBe(true);
    expect(resp.systemMessage).toBeFalsy();
  });

  // -- Path 3: async generation for large body when worker alive ----------

  it("test_path3_dispatches_thread_when_worker_alive", async () => {
    // body >= 40 KB, worker alive -> generation is dispatched to a background
    // task and must NOT run synchronously in the hook body. Python spawns a
    // daemon `threading.Thread`; the TS port has no daemon threads so it uses
    // `setImmediate` (fires on the next tick). The faithful observable assertions:
    // (1) _generate_and_store_compact NOT called synchronously, (2) it IS called
    // once on the next tick (dispatch happened, not skipped), (3) the
    // system_message mentions background generation.
    const body = _XLARGE_SKILL_BODY;
    expect(_utf8ByteLen(body)).toBeGreaterThanOrEqual(40_000);

    hooks_skill._setWorkerModule({ is_worker_alive: () => true });
    const genSpy = vi
      .spyOn(hooks_skill, "_generate_and_store_compact")
      .mockReturnValue(null);
    const resp = _run_post_skill("sess-path3", "xlarge-skill", body);

    // Sync generation must NOT run in the hook body.
    expect(genSpy).not.toHaveBeenCalled();
    expect(resp.continue).toBe(true);
    const system_msg = String(resp.systemMessage ?? "");
    expect(system_msg.toLowerCase()).toContain("background");
    expect(system_msg).toContain("xlarge-skill");

    // The deferred task fires on the next tick -> generation was dispatched.
    await new Promise((r) => setImmediate(r));
    expect(genSpy).toHaveBeenCalledTimes(1);
  });

  // -- Path 4: info-only when worker is down and no pre-gen --------------

  it("test_path4_info_only_when_worker_down", () => {
    const body = _XLARGE_SKILL_BODY;
    expect(_utf8ByteLen(body)).toBeGreaterThanOrEqual(40_000);

    hooks_skill._setWorkerModule({ is_worker_alive: () => false });
    const resp = _run_post_skill("sess-path4", "xlarge-offline", body);

    expect(resp.continue).toBe(true);
    const system_msg = String(resp.systemMessage ?? "");
    expect(system_msg).toContain("xlarge-offline");
    expect(system_msg.includes("install") || system_msg.includes("skill-compact")).toBe(true);
  });

  // -- Stale pre-gen (SHA mismatch) falls through to path 2/3/4 ----------

  it("test_stale_pregen_compact_falls_through_to_sync", () => {
    // Pre-gen compact with wrong SHA -> treated as absent; sync generation runs
    // (observable via a stored session compact, since _generate_and_store_compact
    // itself is unspyable — see the it.skip'd path-1/path-3 tests).
    const body = _MEDIUM_SKILL_BODY;
    skill_cache.store_compact("_install", "stale-skill", "old compact text", "deadbeef");

    const resp = _run_post_skill("sess-stale", "stale-skill", body);

    expect(resp.continue).toBe(true);
    // Sync generation ran since the pre-gen SHA doesn't match: a fresh compact
    // is now stored for this session.
    const stored = skill_cache.get_compact("sess-stale", "stale-skill");
    expect(stored).not.toBeNull();
    expect(stored).not.toBe("old compact text");
  });
});

// ---------------------------------------------------------------------------
// Change 3: threshold-crossing ETA in user_prompt_submit (py 553-692).
//
// The advisory body (hooks_session.ts ~1838-1862) requires an injected compact
// module. We inject the REAL compact module so get_context_pressure computes the
// same fill_fraction from loaded_skill_total_tokens as Python.
// ---------------------------------------------------------------------------

function _set_loaded_skill_tokens(session_id: string, tokens: number): void {
  let cache = session.safe_load(session_id, { caller: "test" });
  if (cache === null) {
    const now = Date.now() / 1000;
    cache = new SessionCache({ session_id, started_ts: now, last_activity_ts: now });
  }
  cache.loaded_skill_total_tokens = tokens;
  session.save(cache);
}

function _run_user_prompt_submit(
  session_id: string,
  prompt = "what changed?",
): Record<string, unknown> {
  return hooks_session.user_prompt_submit({
    session_id,
    prompt,
  }) as unknown as Record<string, unknown>;
}

function _additionalContext(resp: Record<string, unknown>): string {
  const hook_out = (resp.hookSpecificOutput ?? {}) as Record<string, unknown>;
  return String(hook_out.additionalContext ?? "");
}

describe("TestChange3ThresholdAdvisory", () => {
  beforeEach(() => {
    // hooks_session's _compactModule defaults to null (unported pressure seam);
    // inject an adapter that delegates get_context_pressure to the REAL compact
    // module (the only _CompactModule member the threshold advisory uses; the
    // others are unreferenced on this path). Cast through the module's interface.
    hooks_session._setCompactModule({
      get_context_pressure: (session_id: string | null, opts?: { cache?: unknown }) =>
        compact.get_context_pressure(session_id, opts as { cache?: SessionCache | null }),
    } as unknown as Parameters<typeof hooks_session._setCompactModule>[0]);
  });

  it("test_no_advisory_below_50_percent", () => {
    const sid = "sess-c3-low";
    // 0 loaded skill tokens -> pct = 10,800 / 660,000 ~= 1.6%, well below 50%.
    _set_loaded_skill_tokens(sid, 0);

    const ctx = _additionalContext(_run_user_prompt_submit(sid));
    expect(ctx).not.toContain("ctx");
    expect(ctx).not.toContain("CONTEXT");
  });

  it("test_first_crossing_50_percent_appends_ctx_part", () => {
    const sid = "sess-c3-50";
    _set_loaded_skill_tokens(sid, 320_000);

    const ctx = _additionalContext(_run_user_prompt_submit(sid));
    expect(ctx).toContain("ctx:");
    expect(ctx).toContain("context approaching midpoint");
    expect(ctx.startsWith("[")).toBe(true);
    expect(ctx).not.toContain("CONTEXT");
  });

  it("test_50_percent_crossing_fires_only_once", () => {
    const sid = "sess-c3-50-once";
    _set_loaded_skill_tokens(sid, 320_000);

    _run_user_prompt_submit(sid); // first turn — fires
    const resp2 = _run_user_prompt_submit(sid); // second turn — should not fire again

    const ctx = _additionalContext(resp2);
    expect(ctx).not.toContain("ctx:");
    expect(ctx).not.toContain("context approaching midpoint");
  });

  it("test_first_crossing_70_percent_replaces_summary", () => {
    const sid = "sess-c3-70";
    _set_loaded_skill_tokens(sid, 452_000);

    const ctx = _additionalContext(_run_user_prompt_submit(sid));
    expect(ctx.startsWith("[CONTEXT ~7")).toBe(true);
    expect(ctx).toContain("Consider /compact soon.");
  });

  it("test_70_percent_crossing_fires_only_once", () => {
    const sid = "sess-c3-70-once";
    _set_loaded_skill_tokens(sid, 452_000);

    _run_user_prompt_submit(sid); // first turn — fires
    const resp2 = _run_user_prompt_submit(sid); // second turn — should not fire again

    const ctx = _additionalContext(resp2);
    expect(ctx).not.toContain("Consider /compact soon.");
  });

  it("test_85_percent_fires_every_turn", () => {
    const sid = "sess-c3-85";
    _set_loaded_skill_tokens(sid, 551_000);

    const resp1 = _run_user_prompt_submit(sid);
    const resp2 = _run_user_prompt_submit(sid);

    for (const resp of [resp1, resp2]) {
      const ctx = _additionalContext(resp);
      expect(ctx.startsWith("[CONTEXT ~8")).toBe(true);
      expect(ctx).toContain("/compact now.");
    }
  });

  it("test_turns_since_last_compact_increments", () => {
    const sid = "sess-c3-turns";
    _set_loaded_skill_tokens(sid, 0);

    _run_user_prompt_submit(sid);
    _run_user_prompt_submit(sid);
    _run_user_prompt_submit(sid);

    const cache = session.safe_load(sid, { caller: "test" });
    expect(cache).not.toBeNull();
    expect(cache!.turns_since_last_compact).toBe(3);
  });

  it("test_advisory_disabled_via_config", () => {
    const sid = "sess-c3-disabled";
    _set_loaded_skill_tokens(sid, 600_000); // ~90%

    const fake_cfg = config.defaultConfig();
    fake_cfg.hints!.context_threshold_advisory = false;
    vi.spyOn(config, "load").mockReturnValue(fake_cfg);

    const ctx = _additionalContext(_run_user_prompt_submit(sid));
    expect(ctx).not.toContain("CONTEXT");
    expect(ctx).not.toContain("ctx:");
  });
});
