/**
 * Faithful TS port of tests/test_skill_iter8_improvements.py.
 *
 * Covers:
 * 1. `token-goat doctor` skill cache health section (DEFERRED — cli not ported).
 * 2. Skill stats tracking — SOURCE_SKILL bucket / kind_to_source (DEFERRED —
 *    token_goat.stats module is not ported). The post_skill compact-stat
 *    recording is exercised via db.recordStat spying.
 * 3. Codex bridge skill event verification (hook_registry — ported).
 *
 * Porting notes:
 *  - token_goat.cli is NOT ported -> every CliRunner("doctor") test is deferred.
 *  - token_goat.stats is NOT ported -> TestSourceSkillBucket is deferred.
 *  - hooks_skill._record_skill_compact_stat is NOT exported (private) -> the two
 *    direct-call tests are deferred; the through-post_skill test is ported.
 *  - db.record_stat is `db.recordStat` in the TS port (camelCase) with keyword
 *    opts {bytesSaved, tokensSaved, detail}; the spy reads those.
 *  - hook_registry.lookup / codex_events are ported; HookEvent fields keep their
 *    Python names (claude_event, codex_event, claude_matcher, harness).
 *  - test_skill_event_comment_in_registry reads hook_registry.ts (the TS source)
 *    rather than hook_registry.py.
 */
import { describe, expect, it, vi } from "vitest";

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import * as hooks_skill from "../src/token_goat/hooks_skill.js";
import * as hook_registry from "../src/token_goat/hook_registry.js";
import * as db from "../src/token_goat/db.js";
import type { HookPayload, HookResponse } from "../src/token_goat/types.js";

// ---------------------------------------------------------------------------
// Improvement 1: doctor skill cache health section (DEFERRED — cli)
// ---------------------------------------------------------------------------

describe("TestDoctorSkillCacheHealth", () => {
  // PORT: deferred — token_goat.cli is not ported (no cli.ts module exists),
  // so the `doctor` CLI subcommand and its "Skill cache health" section output
  // cannot be exercised.
  it.skip("test_doctor_skill_section_present", () => {});
  it.skip("test_doctor_skill_section_no_cache", () => {});
  it.skip("test_doctor_skill_section_with_cached_skills", () => {});
  it.skip("test_doctor_skill_stale_detection", () => {});
  it.skip("test_doctor_skill_no_stale_when_fresh", () => {});
});

// ---------------------------------------------------------------------------
// Improvement 2: skill stats tracking — SOURCE_SKILL and skill_compact_served
// ---------------------------------------------------------------------------

describe("TestSourceSkillBucket", () => {
  // PORT: deferred — token_goat.stats is not ported (no stats.ts module exists),
  // so SOURCE_SKILL / kind_to_source / _KIND_TO_SOURCE cannot be imported.
  it.skip("test_source_skill_exported", () => {});
  it.skip("test_skill_compact_served_maps_to_source_skill", () => {});
  it.skip("test_skill_cached_maps_to_source_skill", () => {});
  it.skip("test_source_skill_in_kind_to_source", () => {});
  it.skip("test_source_skill_in_all_exports", () => {});
});

describe("TestSkillCompactStatRecording", () => {
  // PORT: deferred — hooks_skill._record_skill_compact_stat is not exported from
  // the TS port (it is a module-private function), so it cannot be called
  // directly from the test.
  it.skip("test_record_skill_compact_stat_calls_db", () => {});
  it.skip("test_record_skill_compact_stat_swallows_db_error", () => {});

  it("test_post_skill_records_compact_stat_for_large_body", () => {
    // Build a large body with an explicit COMPACT_END marker.
    const compact_part = "## Quick Reference\n\nKey rule A.\nKey rule B.\n";
    const full_body =
      compact_part + "\n<!-- COMPACT_END -->\n\n" + "Z".repeat(5000);

    const payload = {
      tool_name: "Skill",
      tool_input: { skill: "bigskill" },
      tool_result: full_body,
      session_id: "s-post-skill-stat-test-001",
    } as unknown as HookPayload;

    const recorded: Array<{
      kind: string;
      bytes_saved: number;
      tokens_saved: number;
    }> = [];

    const spy = vi
      .spyOn(db, "recordStat")
      .mockImplementation((_projectHash, kind, opts) => {
        recorded.push({
          kind,
          bytes_saved: opts?.bytesSaved ?? 0,
          tokens_saved: opts?.tokensSaved ?? 0,
        });
      });

    try {
      const result: HookResponse = hooks_skill.post_skill(payload);
      // Hook should always continue.
      expect(result.continue).not.toBe(false);
    } finally {
      spy.mockRestore();
    }

    const compact_rows = recorded.filter(
      (r) => r.kind === "skill_compact_served",
    );
    expect(compact_rows.length).toBe(1);
    expect(compact_rows[0]!.bytes_saved).toBeGreaterThan(0);
    expect(compact_rows[0]!.tokens_saved).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// Improvement 3: Codex bridge skill event verification
// ---------------------------------------------------------------------------

describe("TestCodexBridgeSkillEvents", () => {
  it("test_post_skill_has_no_codex_event", () => {
    const event = hook_registry.lookup("post-skill");
    expect(event).not.toBeNull();
    expect(event!.codex_event).toBeNull();
  });

  it("test_post_skill_has_claude_event", () => {
    const event = hook_registry.lookup("post-skill");
    expect(event).not.toBeNull();
    expect(event!.claude_event).toBe("PostToolUse");
    expect(event!.claude_matcher).toBe("Skill");
  });

  it("test_codex_events_do_not_include_post_skill", () => {
    const codex_names = new Set(hook_registry.codex_events().map((e) => e.name));
    expect(codex_names.has("post-skill")).toBe(false);
  });

  it("test_codex_events_include_core_events", () => {
    const codex_names = new Set(hook_registry.codex_events().map((e) => e.name));
    const required = ["session-start", "pre-compact", "pre-read", "post-edit"];
    const missing = required.filter((r) => !codex_names.has(r));
    expect(missing).toEqual([]);
  });

  it("test_harness_property_for_post_skill", () => {
    const event = hook_registry.lookup("post-skill");
    expect(event).not.toBeNull();
    expect(event!.harness).toBe("claude");
  });

  it("test_skill_event_comment_in_registry", () => {
    // Read the TS source to verify the explanatory comment is present.
    const here = path.dirname(fileURLToPath(import.meta.url));
    const registry_src = path.join(
      here,
      "..",
      "src",
      "token_goat",
      "hook_registry.ts",
    );
    const content = fs.readFileSync(registry_src, "utf-8");
    expect(content.includes("Codex has no Skill tool")).toBe(true);
  });
});
