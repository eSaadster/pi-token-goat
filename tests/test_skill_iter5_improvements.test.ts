/**
 * Tests for skill context savings accuracy improvements (iteration 5).
 *
 * Faithful 1:1 port of tests/test_skill_iter5_improvements.py.
 *
 * Covers:
 * 1. LRU eviction correctness — most-recently written skill is not evicted first
 *    when the cache cap is hit.
 * 2. Cross-session compact isolation — get_compact/store_compact keyed by session.
 * 3. Recovery hint overflow count — based on unique skill names, not raw entries.
 * 4. hooks_skill.py robustness — unusual payload shapes:
 *    - missing tool_name key
 *    - tool_input as non-dict
 *    - skill field as non-string (int, list, None)
 *    - skill name empty after normalization (e.g. "/", "/.md")
 *    - extremely large body (>1MB) is pre-capped before caching
 *
 * Port notes:
 *  - tmp_data_dir fixture -> setup.ts's per-test setDataDirOverride already gives
 *    each it() an isolated data dir, so no fixture argument is needed.
 *  - Python `skill_cache._skill_outputs_dir()` is module-private in the TS port
 *    (not exported). Reconstruct the same directory via
 *    `cache_common.get_cache_dir("skills")` (the exact implementation of the
 *    private helper).
 *  - The `monkeypatch.setattr(_sc_mod.time, "time", _fake_time)` in
 *    test_eviction_removes_oldest_not_newest only matters in Python because the
 *    stored ts/mtime drives sort order; the TS port sorts by filesystem mtime
 *    and the assertion is "newest survives", which holds without the clock
 *    patch. Faithful to the asserted behaviour.
 *  - hooks_skill._SKILL_CACHE_MAX_CHARS is NOT exported from the TS module
 *    (see missingExports). The huge-body test inlines the same constant value
 *    (2 MB) used in hooks_skill.ts and asserts caching still happens.
 */
import { describe, expect, it, vi } from "vitest";

import * as hooks_skill from "../src/token_goat/hooks_skill.js";
import * as session from "../src/token_goat/session.js";
import * as skill_cache from "../src/token_goat/skill_cache.js";
import * as hooks_session from "../src/token_goat/hooks_session.js";
import * as cache_common from "../src/token_goat/cache_common.js";
import path from "node:path";
import fs from "node:fs";

/** TS analogue of the module-private skill_cache._skill_outputs_dir(). */
function skillOutputsDir(): string {
  return cache_common.get_cache_dir("skills");
}

// ---------------------------------------------------------------------------
// Improvement 1: LRU eviction correctness
// ---------------------------------------------------------------------------

describe("TestSkillCacheLRUEviction", () => {
  it("test_newest_skill_survives_eviction", () => {
    // When adding a skill causes the cap to be exceeded, the oldest skill is
    // evicted, not the one just written (which has the freshest mtime).
    const body_old = "# Old Skill\n\n" + "old content. ".repeat(100);
    const body_new = "# New Skill\n\n" + "new content. ".repeat(100);

    // Store old skill — its file gets an older mtime because it's first.
    const meta_old = skill_cache.store_output("sess-lru-1", "old-skill", body_old);
    expect(meta_old).not.toBeNull();

    // Confirm old skill is on disk.
    const old_path = path.join(skillOutputsDir(), `${meta_old!.output_id}.txt`);
    expect(fs.existsSync(old_path)).toBe(true);

    // Store new skill with a cap that forces eviction (cap = len of new body only).
    const new_body_bytes = Buffer.from(body_new, "utf-8").length;
    const meta_new = skill_cache.store_output("sess-lru-1", "new-skill", body_new, {
      max_total_bytes: new_body_bytes + 100, // tight cap: only fits one skill
    });
    expect(meta_new).not.toBeNull();

    // New skill must still be retrievable.
    const new_loaded = skill_cache.load_output(meta_new!.output_id);
    expect(new_loaded).not.toBeNull();
    expect(new_loaded!).toContain("new content.");
  });

  it("test_eviction_removes_oldest_not_newest", () => {
    // When N skills are cached and cap is exceeded, the N-1 oldest entries are
    // removed before the newest (by mtime), not the other way around.
    const bodies: Record<string, string> = {};
    for (let i = 0; i < 5; i++) {
      bodies[`skill-${i}`] = `# Skill ${i}\n\n` + "x. ".repeat(100);
    }
    const metas: Record<string, skill_cache.SkillMeta> = {};
    for (const [name, body] of Object.entries(bodies)) {
      const m = skill_cache.store_output("sess-lru-evict", name, body);
      expect(m).not.toBeNull();
      metas[name] = m!;
    }

    // All 5 skills should be on disk now.
    for (const [name, m] of Object.entries(metas)) {
      const p = path.join(skillOutputsDir(), `${m.output_id}.txt`);
      expect(fs.existsSync(p), `Expected ${name} to be on disk`).toBe(true);
    }

    // Now store a 6th skill with a tight cap that forces eviction of the oldest.
    const body_new = "# New Skill\n\n" + "y. ".repeat(100);
    const per_body = Buffer.from(body_new, "utf-8").length + 200;
    // Cap = 3 bodies worth; we have 5 + about to add 1 = 6. Should evict 3.
    const cap = per_body * 3;
    const meta_newest = skill_cache.store_output("sess-lru-evict", "newest", body_new, {
      max_total_bytes: cap,
    });
    expect(meta_newest).not.toBeNull();

    // The newest skill must survive.
    const newest_loaded = skill_cache.load_output(meta_newest!.output_id);
    expect(newest_loaded).not.toBeNull();
    expect(newest_loaded!).toContain("y.");
  });

  it("test_active_session_skill_still_loadable_after_new_large_skill", () => {
    // An existing session skill that's just been re-accessed (updated mtime via
    // idempotent store) is NOT evicted when a new large skill triggers the cap.
    const body_existing = "# Existing\n\n" + "exist. ".repeat(100);
    const body_new_large = "# Large\n\n" + "z. ".repeat(500); // larger body

    // Write existing skill first.
    const meta_existing = skill_cache.store_output("sess-lru-active", "existing", body_existing);
    expect(meta_existing).not.toBeNull();

    // Re-write the same existing skill (same body = same output_id = updates mtime).
    skill_cache.store_output("sess-lru-active", "existing", body_existing);

    // Now add a large skill with a cap that would require eviction.
    const large_bytes = Buffer.from(body_new_large, "utf-8").length;
    const existing_bytes = Buffer.from(body_existing, "utf-8").length;
    // Cap = existing + large + 500 bytes: nothing should be evicted.
    const meta_large = skill_cache.store_output("sess-lru-active", "large-new", body_new_large, {
      max_total_bytes: existing_bytes + large_bytes + 500,
    });
    expect(meta_large).not.toBeNull();

    // Both should be loadable.
    const existing_loaded = skill_cache.load_output(meta_existing!.output_id);
    const large_loaded = skill_cache.load_output(meta_large!.output_id);
    expect(existing_loaded).not.toBeNull();
    expect(large_loaded).not.toBeNull();
  });

  it("test_evict_cache_dir_protects_mru_entry_with_oldest_mtime", () => {
    // Helper-level regression for the MRU-eviction flake. evict_cache_dir with
    // protect_ids must keep that entry regardless of its timestamp.
    const body_old = "# Old\n\n" + "old. ".repeat(100);
    const body_new = "# New\n\n" + "new. ".repeat(100);
    const cap = Buffer.from(body_new, "utf-8").length + 100; // only one body fits under the cap
    const out_dir = skillOutputsDir();

    function _setup(): [string, string] {
      // Large per-store cap so store_output's own internal eviction is a no-op
      // here; we drive eviction manually with the tight cap below.
      const m_old = skill_cache.store_output("sess-protect", "old-skill", body_old, {
        max_total_bytes: 10_000_000,
      });
      const m_new = skill_cache.store_output("sess-protect", "new-skill", body_new, {
        max_total_bytes: 10_000_000,
      });
      expect(m_old).not.toBeNull();
      expect(m_new).not.toBeNull();
      const old_p = path.join(out_dir, `${m_old!.output_id}.txt`);
      const new_p = path.join(out_dir, `${m_new!.output_id}.txt`);
      expect(fs.existsSync(old_p)).toBe(true);
      expect(fs.existsSync(new_p)).toBe(true);
      // Adversarial coarse-mtime condition: force the MRU (new) entry to carry
      // the OLDEST timestamp — the worst case the tie can degrade to.
      const base = fs.statSync(old_p).mtimeMs / 1000;
      fs.utimesSync(old_p, base, base);
      fs.utimesSync(new_p, base - 5.0, base - 5.0);
      return [m_old!.output_id, m_new!.output_id];
    }

    // --- Baseline: no protection -> the MRU entry (oldest mtime) is evicted. ---
    let [, new_id] = _setup();
    cache_common.evict_cache_dir({
      cache_dir_fn: skillOutputsDir,
      log_name: "skill_cache",
      max_total_bytes: cap,
    });
    expect(
      fs.existsSync(path.join(out_dir, `${new_id}.txt`)),
      "baseline: without protect_ids the MRU entry with the oldest mtime is evicted",
    ).toBe(false);

    // Clean slate for the protected run.
    for (const f of fs.readdirSync(out_dir)) {
      if (f.endsWith(".txt")) {
        fs.unlinkSync(path.join(out_dir, f));
      }
    }

    // --- Fix: protect the MRU id -> it survives, the older sibling evicts. ---
    let old_id: string;
    [old_id, new_id] = _setup();
    cache_common.evict_cache_dir({
      cache_dir_fn: skillOutputsDir,
      log_name: "skill_cache",
      max_total_bytes: cap,
      protect_ids: new Set<string>([new_id]),
    });
    expect(
      fs.existsSync(path.join(out_dir, `${new_id}.txt`)),
      "fix: protect_ids must keep the freshest entry even when its mtime sorts oldest",
    ).toBe(true);
    expect(
      fs.existsSync(path.join(out_dir, `${old_id}.txt`)),
      "fix: the genuinely older sibling must still be evicted to honor the cap",
    ).toBe(false);
  });

  it("test_store_output_forwards_protect_id_to_eviction", () => {
    // store_output must forward the id it just wrote to the eviction helper as a
    // protected id. In the TS port store_output calls self.evict_old_entries({...
    // protect_id}) which forwards protect_id as protect_ids = {protect_id} to
    // evict_cache_dir. Spy on evict_old_entries (called via the self namespace)
    // to capture protect_id, then assert the forwarded protected set.
    const captured: { protect_id?: unknown } = {};
    const spy = vi
      .spyOn(skill_cache, "evict_old_entries")
      .mockImplementation((opts: { protect_id?: string | null } = {}): number => {
        captured.protect_id = opts.protect_id;
        return 0;
      });
    try {
      const meta = skill_cache.store_output("sess-forward", "fwd-skill", "# Body\n\n" + "x ".repeat(50));
      expect(meta).not.toBeNull();
      expect(
        captured.protect_id,
        "store_output must protect the just-written id during its own eviction pass",
      ).toBe(meta!.output_id);
    } finally {
      spy.mockRestore();
    }
  });
});

// ---------------------------------------------------------------------------
// Improvement 2: Cross-session compact isolation
// ---------------------------------------------------------------------------

describe("TestCrossSessionCompactIsolation", () => {
  it("test_different_sessions_same_skill_isolated", () => {
    skill_cache.store_compact("session-A", "ralph", "Session A compact text.");
    skill_cache.store_compact("session-B", "ralph", "Session B compact text.");

    const result_a = skill_cache.get_compact("session-A", "ralph");
    const result_b = skill_cache.get_compact("session-B", "ralph");

    expect(result_a).not.toBeNull();
    expect(result_b).not.toBeNull();
    expect(result_a!).toContain("Session A compact text.");
    expect(result_b!).toContain("Session B compact text.");
    // Cross-contamination check.
    expect(result_a!).not.toContain("Session B compact text.");
    expect(result_b!).not.toContain("Session A compact text.");
  });

  it("test_session_compact_only_retrieved_by_same_session", () => {
    skill_cache.store_compact("session-C", "improve", "Compact for session C.");

    // session-D was never stored.
    const result_d = skill_cache.get_compact("session-D", "improve");
    expect(result_d).toBeNull();
  });

  it("test_updating_compact_in_one_session_does_not_affect_other", () => {
    skill_cache.store_compact("session-E", "myskill", "Original E content.");
    skill_cache.store_compact("session-F", "myskill", "F content.");

    // Overwrite E.
    skill_cache.store_compact("session-E", "myskill", "Updated E content.");

    const result_e = skill_cache.get_compact("session-E", "myskill") ?? "";
    const result_f = skill_cache.get_compact("session-F", "myskill") ?? "";

    expect(result_e).toContain("Updated E content.");
    expect(result_e).not.toContain("Original E content.");
    expect(result_f).toContain("F content.");
    expect(result_f).not.toContain("Updated E content.");
  });

  it("test_session_body_cache_isolated_by_session_prefix", () => {
    const body = "# Same Body\n\n" + "content. ".repeat(100);
    const meta_sess1 = skill_cache.store_output("session-111", "myskill", body);
    const meta_sess2 = skill_cache.store_output("session-222", "myskill", body);

    expect(meta_sess1).not.toBeNull();
    expect(meta_sess2).not.toBeNull();
    // Different session prefixes -> different output_ids, even for same body.
    expect(meta_sess1!.output_id).not.toBe(meta_sess2!.output_id);
  });

  it("test_lookup_skill_entry_is_session_scoped", () => {
    session.mark_skill_loaded("sess-scope-1", "ralph", "oid-1", "sha1", 5000, false);
    session.mark_skill_loaded("sess-scope-2", "ralph", "oid-2", "sha2", 5000, false);

    const entry_1 = session.lookup_skill_entry("sess-scope-1", "ralph");
    const entry_2 = session.lookup_skill_entry("sess-scope-2", "ralph");

    expect(entry_1).not.toBeNull();
    expect(entry_2).not.toBeNull();
    // Each session sees only its own entry.
    expect(entry_1!.output_id).toBe("oid-1");
    expect(entry_2!.output_id).toBe("oid-2");

    // Session 3 has no skills loaded.
    const entry_3 = session.lookup_skill_entry("sess-scope-3", "ralph");
    expect(entry_3).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Improvement 3: Recovery hint overflow count uses unique skill names
// ---------------------------------------------------------------------------

describe("TestRecoveryHintOverflowCount", () => {
  it("test_repeated_loads_do_not_inflate_overflow_count", () => {
    const sid = "sess-overflow-unique";
    // Load "ralph" three times (simulates run_count increments).
    for (let i = 0; i < 3; i++) {
      session.mark_skill_loaded(sid, "ralph", `oid-${i}`, `sha-${i}`, 5000, false);
    }

    const hint = hooks_session._build_recovery_hint(sid);
    expect(hint).not.toBeNull();
    expect(hint!).toContain("ralph");

    // With only one unique skill name, the overflow should be 0 (no "+N more").
    expect(hint!).not.toContain("+1 more");
    expect(hint!).not.toContain("+2 more");
    expect(hint!).not.toContain("+3 more");
  });

  it("test_overflow_count_with_many_unique_skills_beyond_ceiling", () => {
    const sid = "sess-overflow-many";
    // Load 10 distinct skills.
    for (let i = 0; i < 10; i++) {
      const name = `skill-${String(i).padStart(2, "0")}`;
      session.mark_skill_loaded(sid, name, `oid-${i}`, `sha-${i}`, 5000, false);
    }

    const hint = hooks_session._build_recovery_hint(sid);
    expect(hint).not.toBeNull();
    expect(hint!).toContain("### Active Skills");

    // At most 8 skills shown (ceiling). With 10 unique, "+2 more" expected.
    expect(hint!).toContain("+2 more");
  });

  it("test_overflow_zero_when_all_skills_fit", () => {
    const sid = "sess-no-overflow";
    for (let i = 0; i < 3; i++) {
      session.mark_skill_loaded(sid, `skill-${i}`, `oid-${i}`, `sha-${i}`, 5000, false);
    }

    const hint = hooks_session._build_recovery_hint(sid);
    expect(hint).not.toBeNull();
    // Three skills, all fit — no overflow suffix.
    expect(hint!).not.toContain(" more");
  });

  it("test_repeated_and_unique_mixed_overflow_count", () => {
    const sid = "sess-mixed-overflow";
    // 8 unique skills (fills ceiling), plus "ralph" loaded 5 times, plus 1 more unique.
    for (let i = 0; i < 8; i++) {
      session.mark_skill_loaded(sid, `skill-${i}`, `oid-s${i}`, `sha-s${i}`, 5000, false);
    }
    for (let j = 0; j < 5; j++) {
      session.mark_skill_loaded(sid, "ralph", `oid-r${j}`, `sha-r${j}`, 25000, false);
    }
    session.mark_skill_loaded(sid, "extra-skill", "oid-extra", "sha-extra", 5000, false);

    const hint = hooks_session._build_recovery_hint(sid);
    expect(hint).not.toBeNull();
    expect(hint!).toContain("### Active Skills");

    // 10 unique skills total (8 + ralph + extra-skill); ceiling is 8.
    // Overflow should be +2 (the 2 unique names not shown), not +7.
    expect(hint!).toContain("+2 more");
    expect(hint!).not.toContain("+7 more");
    expect(hint!).not.toContain("+6 more");
  });
});

// ---------------------------------------------------------------------------
// Improvement 4: hooks_skill.py robustness
// ---------------------------------------------------------------------------

describe("TestPostSkillHookRobustness", () => {
  it("test_missing_tool_name_key", () => {
    const payload = {
      session_id: "sess-robust-1",
      // no tool_name key
      tool_input: { skill: "ralph" },
      tool_response: "# Ralph\n\n" + "rule. ".repeat(200),
    };
    const resp = hooks_skill.post_skill(payload);
    expect(resp.continue).toBe(true);
    // Should not cache because tool_name defaults to "" (not "Skill").
    const cache = session.load("sess-robust-1");
    expect("ralph" in cache.skill_history).toBe(false);
  });

  it("test_tool_input_as_list_instead_of_dict", () => {
    const payload = {
      session_id: "sess-robust-2",
      tool_name: "Skill",
      tool_input: ["ralph", "extra"], // list, not dict
      tool_response: "# Ralph\n\n" + "rule. ".repeat(200),
    };
    const resp = hooks_skill.post_skill(payload as never);
    expect(resp.continue).toBe(true);
  });

  it("test_tool_input_as_string", () => {
    const payload = {
      session_id: "sess-robust-3",
      tool_name: "Skill",
      tool_input: "ralph", // string, not dict
      tool_response: "# Ralph\n\n" + "rule. ".repeat(200),
    };
    const resp = hooks_skill.post_skill(payload as never);
    expect(resp.continue).toBe(true);
  });

  it("test_skill_field_as_integer", () => {
    const payload = {
      session_id: "sess-robust-4",
      tool_name: "Skill",
      tool_input: { skill: 42 }, // int, not str
      tool_response: "# Ralph\n\n" + "rule. ".repeat(200),
    };
    const resp = hooks_skill.post_skill(payload as never);
    expect(resp.continue).toBe(true);
    const cache = session.load("sess-robust-4");
    expect(Object.keys(cache.skill_history).length).toBe(0);
  });

  it("test_skill_field_as_list", () => {
    const payload = {
      session_id: "sess-robust-5",
      tool_name: "Skill",
      tool_input: { skill: ["ralph", "improve"] }, // list, not str
      tool_response: "# Ralph\n\n" + "rule. ".repeat(200),
    };
    const resp = hooks_skill.post_skill(payload as never);
    expect(resp.continue).toBe(true);
    const cache = session.load("sess-robust-5");
    expect(Object.keys(cache.skill_history).length).toBe(0);
  });

  it("test_skill_field_as_none", () => {
    const payload = {
      session_id: "sess-robust-6",
      tool_name: "Skill",
      tool_input: { skill: null },
      tool_response: "# Ralph\n\n" + "rule. ".repeat(200),
    };
    const resp = hooks_skill.post_skill(payload as never);
    expect(resp.continue).toBe(true);
    const cache = session.load("sess-robust-6");
    expect(Object.keys(cache.skill_history).length).toBe(0);
  });

  it("test_skill_name_empty_after_path_strip", () => {
    // "/" -> path-split -> "" -> guarded and skipped
    const payload = {
      session_id: "sess-robust-7",
      tool_name: "Skill",
      tool_input: { skill: "/" },
      tool_response: "# Something\n\n" + "rule. ".repeat(200),
    };
    const resp = hooks_skill.post_skill(payload as never);
    expect(resp.continue).toBe(true);
    const cache = session.load("sess-robust-7");
    expect(Object.keys(cache.skill_history).length).toBe(0);
  });

  it("test_skill_name_only_md_extension", () => {
    const payload = {
      session_id: "sess-robust-8",
      tool_name: "Skill",
      tool_input: { skill: ".md" },
      tool_response: "# Something\n\n" + "rule. ".repeat(200),
    };
    const resp = hooks_skill.post_skill(payload as never);
    expect(resp.continue).toBe(true);
    const cache = session.load("sess-robust-8");
    expect(Object.keys(cache.skill_history).length).toBe(0);
  });

  it("test_empty_body_skipped", () => {
    const payload = {
      session_id: "sess-robust-9",
      tool_name: "Skill",
      tool_input: { skill: "ralph" },
      tool_response: "",
    };
    const resp = hooks_skill.post_skill(payload as never);
    expect(resp.continue).toBe(true);
    const cache = session.load("sess-robust-9");
    expect("ralph" in cache.skill_history).toBe(false);
  });

  it("test_body_as_integer_in_tool_response", () => {
    const payload = {
      session_id: "sess-robust-10",
      tool_name: "Skill",
      tool_input: { skill: "ralph" },
      tool_response: 12345, // integer, not str
    };
    const resp = hooks_skill.post_skill(payload as never);
    expect(resp.continue).toBe(true);
    const cache = session.load("sess-robust-10");
    expect("ralph" in cache.skill_history).toBe(false);
  });

  it("test_extremely_large_body_is_pre_capped", () => {
    // A body larger than _SKILL_CACHE_MAX_CHARS (2 MB) is pre-capped and still
    // cached. _SKILL_CACHE_MAX_CHARS is module-private in the TS port (see
    // missingExports); the 2 MB cap value is inlined to match hooks_skill.ts.
    const SKILL_CACHE_MAX_CHARS = 2 * 1024 * 1024;
    const big_body = "# Huge Skill\n\n" + "A".repeat(3 * 1024 * 1024);
    expect(big_body.length).toBeGreaterThan(SKILL_CACHE_MAX_CHARS);

    const sid = "sess-robust-huge";
    const payload = {
      session_id: sid,
      tool_name: "Skill",
      tool_input: { skill: "huge-skill" },
      tool_response: big_body,
    };
    const resp = hooks_skill.post_skill(payload as never);
    expect(resp.continue).toBe(true);

    // The skill should still be cached.
    const cache = session.load(sid);
    expect("huge-skill" in cache.skill_history, "Huge skill should be cached despite extreme body size").toBe(true);
  });

  it("test_none_payload_does_not_crash", () => {
    // Passing null/undefined as the payload does not crash the hook.
    const resp = hooks_skill.post_skill(null as never);
    expect(resp.continue).toBe(true);
  });

  it("test_skill_name_with_only_whitespace", () => {
    const payload = {
      session_id: "sess-robust-ws",
      tool_name: "Skill",
      tool_input: { skill: "   " },
      tool_response: "# Skill\n\n" + "body. ".repeat(200),
    };
    const resp = hooks_skill.post_skill(payload as never);
    expect(resp.continue).toBe(true);
    const cache = session.load("sess-robust-ws");
    expect(Object.keys(cache.skill_history).length).toBe(0);
  });
});
