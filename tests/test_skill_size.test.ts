/**
 * Tests for the skill-size command.
 *
 * 1:1 port of tests/test_skill_size.py. The CLI layer is now ported (batch D —
 * cli_skills.skill_size), so these run for real via the in-process CliRunner.
 */
import { describe, it, expect, afterEach, vi } from "vitest";

import { invoke } from "./_cli_runner.js";
import * as skill_cache from "../src/token_goat/skill_cache.js";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("TestSkillSize", () => {
  it("test_skill_size_exits_zero", async () => {
    const body = "# Test Skill\n\n" + "Some content. ".repeat(100);
    const meta = skill_cache.store_output("test_session_1", "test-skill", body);
    expect(meta).not.toBeNull();

    const r = await invoke(["skill-size", "--session-id", "test_session_1"]);
    expect(r.exit_code).toBe(0);
  });

  it("test_skill_size_output_contains_tokens", async () => {
    const body = "# Test Skill\n\n" + "Line of text. ".repeat(100);
    expect(skill_cache.store_output("test_session_2", "test-skill", body)).not.toBeNull();

    const r = await invoke(["skill-size", "--session-id", "test_session_2"]);
    expect(r.exit_code).toBe(0);
    expect(r.stdout.toLowerCase()).toContain("tokens");
  });

  it("test_skill_size_large_skill_flagged", async () => {
    const compact_section = "## DoD\n\n" + "Requirement item. ".repeat(150);
    const body = `${compact_section}\n\n<!-- COMPACT_END -->\n\nDetailed reference here.`;

    expect(skill_cache.store_output("test_session_3", "large-skill", body)).not.toBeNull();

    const compact_text = skill_cache.extract_compact_from_marker(body);
    if (compact_text) {
      skill_cache.store_compact("test_session_3", "large-skill", compact_text);
    }

    const r = await invoke(["skill-size", "--session-id", "test_session_3"]);
    expect(r.exit_code).toBe(0);
    // restructure flag OR at least runs (non-empty output).
    expect(r.stdout.includes("⚠ restructure") || r.stdout.length > 0).toBe(true);
  });

  it("test_skill_size_json_output", async () => {
    const body = "# Test Skill\n\nContent.".repeat(50);
    expect(skill_cache.store_output("test_session_4", "test-skill", body)).not.toBeNull();

    const r = await invoke(["skill-size", "--session-id", "test_session_4", "--json"]);
    expect(r.exit_code).toBe(0);

    const data = JSON.parse(r.stdout) as Record<string, unknown>;
    expect(data).toHaveProperty("session_id");
    expect(data).toHaveProperty("skills");
    expect(Array.isArray(data["skills"])).toBe(true);
    expect(data).toHaveProperty("total_overhead_at_100_turns");

    const skills = data["skills"] as Array<Record<string, unknown>>;
    if (skills.length > 0) {
      const skill = skills[0]!;
      expect(skill).toHaveProperty("name");
      expect(skill).toHaveProperty("body_tokens");
      expect(skill).toHaveProperty("compact_tokens");
      expect(skill).toHaveProperty("per_100_overhead");
      expect(skill).toHaveProperty("flag");
    }
  });

  it("test_skill_size_no_session_shows_all", async () => {
    const body1 = "# Skill A\n\nContent A.".repeat(50);
    const body2 = "# Skill B\n\nContent B.".repeat(50);
    expect(skill_cache.store_output("sess_a", "skill-a", body1)).not.toBeNull();
    expect(skill_cache.store_output("sess_b", "skill-b", body2)).not.toBeNull();

    const r = await invoke(["skill-size"]);
    expect(r.exit_code).toBe(0);
    expect(r.stdout.includes("Total overhead") || r.stdout.includes("No cached")).toBe(true);
  });

  it("test_skill_size_empty_cache", async () => {
    const r = await invoke(["skill-size", "--session-id", "nonexistent"]);
    expect(r.exit_code).toBe(0);
    expect(r.stdout).toContain("No cached skills");
  });

  it("test_skill_size_sorting", async () => {
    skill_cache.store_output("test_session_5", "small", "Small.".repeat(10));
    skill_cache.store_output("test_session_5", "medium", "Medium.".repeat(100));
    skill_cache.store_output("test_session_5", "large", "Large.".repeat(500));

    const r = await invoke(["skill-size", "--session-id", "test_session_5"]);
    expect(r.exit_code).toBe(0);

    const large_pos = r.stdout.indexOf("large");
    const medium_pos = r.stdout.indexOf("medium");
    if (large_pos >= 0 && medium_pos >= 0) {
      expect(large_pos).toBeLessThan(medium_pos);
    }
  });

  it("test_skill_size_total_line", async () => {
    skill_cache.store_output("test_session_6", "test", "Content.".repeat(100));

    const r = await invoke(["skill-size", "--session-id", "test_session_6"]);
    expect(r.exit_code).toBe(0);
    expect(r.stdout).toContain("Total overhead at 100 turns");
  });
});
