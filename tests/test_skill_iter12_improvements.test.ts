/**
 * Faithful TS port of tests/test_skill_iter12_improvements.py.
 *
 * Covers:
 * 1. skill_section cache fallback (DEFERRED — read_commands not yet ported).
 * 2. skill-compact --all: batch regeneration of stale/absent compacts,
 *    staleness check via source SHA. Ported (skill_cache only).
 * 3. Pre-compact token budget safety margin in _section_budgets (DEFERRED —
 *    compact._render / _section_budgets / estimate_tokens not yet ported).
 *
 * Porting notes:
 *  - tmp_data_dir fixture / _isolate_data_dir -> handled by tests/setup.ts.
 *  - uuid.uuid4().hex[:8] -> crypto.randomUUID() hex fragment.
 *  - meta.content_sha is the SkillMeta field; str.startswith -> String.startsWith.
 */
import { describe, expect, it } from "vitest";

import { randomBytes } from "node:crypto";

import * as skill_cache from "../src/token_goat/skill_cache.js";

function hex8(): string {
  return randomBytes(4).toString("hex");
}

// ---------------------------------------------------------------------------
// Improvement 1: skill_section falls back to cached body when disk is absent
//
// DEFERRED: token_goat.read_commands (skill_section) is not yet ported.
// ---------------------------------------------------------------------------

describe("TestSkillSectionCacheFallback", () => {
  it.skip("test_falls_back_to_cache_when_disk_absent (read_commands not ported)", () => {});
  it.skip("test_falls_back_to_cache_json_output (read_commands not ported)", () => {});
  it.skip("test_exits_when_neither_disk_nor_cache (read_commands not ported)", () => {});
  it.skip("test_disk_path_still_preferred_when_available (read_commands not ported)", () => {});
  it.skip("test_cache_fallback_section_not_found_lists_headings (read_commands not ported)", () => {});
});

// ---------------------------------------------------------------------------
// Improvement 2: skill-compact --all batch regeneration
// ---------------------------------------------------------------------------

describe("TestSkillCompactAll", () => {
  function _store_skill_with_sidecar(
    name: string,
    body: string,
    session_id = "test-session-all12",
  ): skill_cache.SkillMeta {
    const meta = skill_cache.store_output(session_id, name, body);
    expect(meta).not.toBeNull();
    skill_cache.write_sidecar(meta!);
    return meta!;
  }

  it("test_absent_compact_is_regenerated", () => {
    const session_id = `test-sc-absent12-${hex8()}`;
    const skill_name = `skill-absent12-${hex8()}`;
    const body = "# Skill\n\n## Quick Start\n\nStep 1.\n\n## Reference\n\nDetails.\n";
    const meta = _store_skill_with_sidecar(skill_name, body, session_id);

    // Verify no compact exists yet.
    const existing = skill_cache.get_compact(session_id, skill_name);
    expect(existing).toBeNull();

    // Generate and store compact.
    const compact_text = skill_cache.generate_compact_summary(body);
    skill_cache.store_compact(session_id, skill_name, compact_text, meta.content_sha);

    const stored = skill_cache.get_compact(session_id, skill_name);
    expect(stored).not.toBeNull();
    expect(stored!.includes("Quick Start") || stored!.includes("Reference")).toBe(true);
  });

  it("test_staleness_check_detects_sha_mismatch", () => {
    const session_id = "test-sc-stale12";

    // Store v1 body and its compact.
    const body_v1 = "# Skill V1\n\n## Quick Start\n\nOld content.\n";
    const meta_v1 = _store_skill_with_sidecar("skill-stale12", body_v1, session_id);
    const compact_text = skill_cache.generate_compact_summary(body_v1);
    skill_cache.store_compact(session_id, "skill-stale12", compact_text, meta_v1.content_sha);

    // Simulate: skill body updated -> new sha.
    const body_v2 = "# Skill V2\n\n## Quick Start\n\nNew content.\n## Advanced\n\nExtra.\n";
    const meta_v2 = _store_skill_with_sidecar("skill-stale12", body_v2, session_id);

    const stored_compact = skill_cache.get_compact(session_id, "skill-stale12");
    expect(stored_compact).not.toBeNull();

    const compact_sha = skill_cache.extract_compact_source_sha(stored_compact!);
    expect(compact_sha).not.toBeNull();

    // v2 body sha should NOT start with the compact's sha.
    const body_sha = meta_v2.content_sha;
    const is_stale = !body_sha.startsWith(compact_sha!);
    expect(is_stale).toBe(true);
  });

  it("test_fresh_compact_is_not_stale", () => {
    const session_id = "test-sc-fresh12";
    const body = "# Fresh Skill\n\n## Section\n\nContent.\n";
    const meta = _store_skill_with_sidecar("skill-fresh12", body, session_id);

    const compact_text = skill_cache.generate_compact_summary(body);
    skill_cache.store_compact(session_id, "skill-fresh12", compact_text, meta.content_sha);

    const stored_compact = skill_cache.get_compact(session_id, "skill-fresh12");
    expect(stored_compact).not.toBeNull();
    const compact_sha = skill_cache.extract_compact_source_sha(stored_compact!);
    expect(compact_sha).not.toBeNull();

    const body_sha = meta.content_sha;
    const is_stale = !body_sha.startsWith(compact_sha!);
    expect(is_stale).toBe(false);
  });

  it("test_all_multiple_skill_states_classified_correctly", () => {
    const session_id = "test-sc-mix12";

    // Skill A: up-to-date compact.
    const body_a = "# A\n\n## Step\n\nDo A.\n";
    const meta_a = _store_skill_with_sidecar("skill-a12", body_a, session_id);
    const compact_a = skill_cache.generate_compact_summary(body_a);
    skill_cache.store_compact(session_id, "skill-a12", compact_a, meta_a.content_sha);

    // Skill B: stale compact (stored with v1 sha, then body updated to v2).
    const body_b_v1 = "# B v1\n\n## Step\n\nOld B.\n";
    const meta_b_v1 = _store_skill_with_sidecar("skill-b12", body_b_v1, session_id);
    const compact_b_v1 = skill_cache.generate_compact_summary(body_b_v1);
    skill_cache.store_compact(session_id, "skill-b12", compact_b_v1, meta_b_v1.content_sha);
    const body_b_v2 = "# B v2\n\n## Step\n\nNew B.\n## Extra\n\nMore.\n";
    const meta_b_v2 = _store_skill_with_sidecar("skill-b12", body_b_v2, session_id);

    // Skill C: no compact at all.
    const body_c = "# C\n\n## Only\n\nContent C.\n";
    _store_skill_with_sidecar("skill-c12", body_c, session_id);

    // Verify Skill A is up-to-date.
    const compact_a_stored = skill_cache.get_compact(session_id, "skill-a12");
    const sha_a = skill_cache.extract_compact_source_sha(compact_a_stored ?? "");
    expect(Boolean(sha_a) && meta_a.content_sha.startsWith(sha_a!)).toBe(true);

    // Verify Skill B is stale.
    const compact_b_stored = skill_cache.get_compact(session_id, "skill-b12");
    const sha_b = skill_cache.extract_compact_source_sha(compact_b_stored ?? "");
    expect(Boolean(sha_b) && !meta_b_v2.content_sha.startsWith(sha_b!)).toBe(true);

    // Verify Skill C has no compact.
    const compact_c_stored = skill_cache.get_compact(session_id, "skill-c12");
    expect(compact_c_stored).toBeNull();
  });

  it("test_list_by_session_finds_stored_skills", () => {
    const session_id = "test-list-by-session12";
    const body1 = "# Skill One\n\n## A\n\nContent.\n";
    const body2 = "# Skill Two\n\n## B\n\nContent.\n";
    _store_skill_with_sidecar("skill-one12", body1, session_id);
    _store_skill_with_sidecar("skill-two12", body2, session_id);

    const entries = skill_cache.list_by_session(session_id);
    const names = new Set(entries.map((e) => e.skill_name));
    expect(names.has("skill-one12")).toBe(true);
    expect(names.has("skill-two12")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Improvement 3: Pre-compact token budget safety margin in _section_budgets
//
// DEFERRED: token_goat.compact._render / _section_budgets / estimate_tokens are
// not yet ported (compact.ts does not export these symbols).
// ---------------------------------------------------------------------------

describe("TestSectionBudgetSafetyMargin", () => {
  it.skip("test_safety_factor_applied (compact._render/_section_budgets not ported)", () => {});
  it.skip("test_safety_factor_reduces_section_allocations (compact._section_budgets not ported)", () => {});
  it.skip("test_section_budget_difference_matches_safety_factor (compact._section_budgets not ported)", () => {});
  it.skip("test_manifest_does_not_grossly_exceed_budget (compact._render/estimate_tokens not ported)", () => {});
});
