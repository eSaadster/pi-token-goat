/**
 * Faithful TS port of tests/test_skill_iter4_improvements.py.
 *
 * Covers:
 * 1. Pre-read hook: marketplace cache path detection
 *    (hooks_read._detect_skill_name_from_path handles deep layouts).
 * 2. skill_cache.generate_compact_summary flat-file fallback.
 * 3. skill_cache.extract_all_headings with max_level=4 includes H4 headings.
 * 4. skill_cache.extract_named_section reaches H4 sections.
 *
 * Porting notes:
 *  - All asserted functions (hooks_read._detect_skill_name_from_path,
 *    skill_cache.generate_compact_summary / extract_all_headings /
 *    extract_named_section) are ported with the same names + signatures.
 *  - Python `len(result)` counts code points; the prose-cap test uses ASCII so
 *    `.length` is equivalent here.
 */
import { describe, expect, it } from "vitest";

import * as hooks_read from "../src/token_goat/hooks_read.js";
import * as skill_cache from "../src/token_goat/skill_cache.js";

// ---------------------------------------------------------------------------
// Improvement 1: marketplace cache path detection in _detect_skill_name_from_path
// ---------------------------------------------------------------------------

describe("TestMarketplaceCachePathDetection", () => {
  it("test_legacy_flat_layout", () => {
    const result = hooks_read._detect_skill_name_from_path(
      "/home/user/.claude/skills/ralph.md",
    );
    expect(result).toBe("ralph");
  });

  it("test_legacy_subdir_layout", () => {
    const result = hooks_read._detect_skill_name_from_path(
      "/home/user/.claude/skills/ralph/SKILL.md",
    );
    expect(result).toBe("ralph");
  });

  it("test_legacy_plugin_flat_layout", () => {
    const result = hooks_read._detect_skill_name_from_path(
      "/home/user/.claude/plugins/myplugin/skills/ralph/SKILL.md",
    );
    expect(result).toBe("ralph");
  });

  it("test_marketplace_two_segment_layout", () => {
    const result = hooks_read._detect_skill_name_from_path(
      "/home/user/.claude/plugins/cache/myplugin/skills/ralph/SKILL.md",
    );
    expect(result).toBe("ralph");
  });

  it("test_marketplace_four_segment_layout", () => {
    const result = hooks_read._detect_skill_name_from_path(
      "/home/user/.claude/plugins/cache/registry.example.com/myplugin/1.0.0/skills/ralph/SKILL.md",
    );
    expect(result).toBe("ralph");
  });

  it("test_marketplace_hyphenated_plugin_name", () => {
    const result = hooks_read._detect_skill_name_from_path(
      "/home/user/.claude/plugins/cache/registry/plugin-name/2.1.3/skills/commit-commands/SKILL.md",
    );
    expect(result).toBe("commit-commands");
  });

  it("test_windows_marketplace_path", () => {
    const result = hooks_read._detect_skill_name_from_path(
      "C:\\Users\\user\\.claude\\plugins\\cache\\registry\\myplugin\\1.0.0\\skills\\ralph\\SKILL.md",
    );
    expect(result).toBe("ralph");
  });

  it("test_non_skill_file_returns_none", () => {
    expect(
      hooks_read._detect_skill_name_from_path("/home/user/.claude/settings.json"),
    ).toBeNull();
    expect(
      hooks_read._detect_skill_name_from_path("/home/user/project/src/main.py"),
    ).toBeNull();
    expect(hooks_read._detect_skill_name_from_path("")).toBeNull();
  });

  it("test_case_insensitive_skill_md", () => {
    const result = hooks_read._detect_skill_name_from_path(
      "/home/user/.claude/skills/ralph/SKILL.MD",
    );
    expect(result).toBe("ralph");
  });
});

// ---------------------------------------------------------------------------
// Improvement 2: generate_compact_summary flat-file fallback
// ---------------------------------------------------------------------------

describe("TestCompactSummaryFlatFileFallback", () => {
  it("test_truly_flat_prose_included", () => {
    const body =
      "This skill does something very specific for the agent. " +
      "When invoked, it configures the session with a particular behavior pattern.";
    const result = skill_cache.generate_compact_summary(body);
    expect(result).not.toBe("");
    expect(result.includes("skill does something very specific")).toBe(true);
  });

  it("test_flat_prose_fallback_not_triggered_when_headings_present", () => {
    const body = "## Overview\n\nSome prose.\n\n## Rules\n\nMore prose.";
    const result = skill_cache.generate_compact_summary(body);
    expect(result.includes("**Sections:**")).toBe(true);
    expect((result.match(/Some prose/g) ?? []).length).toBe(0);
  });

  it("test_flat_prose_fallback_not_triggered_when_rules_present", () => {
    const body =
      "CRITICAL: Always do this.\n\nSome long plain prose that could be the fallback.";
    const result = skill_cache.generate_compact_summary(body);
    expect(result.includes("CRITICAL")).toBe(true);
    expect(result.includes("Some long plain prose")).toBe(false);
  });

  it("test_flat_prose_skips_short_lines", () => {
    const body =
      "Short.\n\nThis is a long enough line to serve as the first prose paragraph fallback.";
    const result = skill_cache.generate_compact_summary(body);
    expect(result.includes("long enough line")).toBe(true);
    expect(result.includes("Short.")).toBe(false);
  });

  it("test_frontmatter_description_plus_flat_prose", () => {
    const body =
      "---\n" +
      "description: A skill that automates X\n" +
      "---\n\n" +
      "Use this skill to automate routine tasks in the project with a single invocation.";
    const result = skill_cache.generate_compact_summary(body);
    expect(result.includes("A skill that automates X")).toBe(true);
    expect(result.includes("automate routine tasks")).toBe(true);
    expect((result.match(/A skill that automates X/g) ?? []).length).toBe(1);
  });

  it("test_frontmatter_fields_not_included_in_prose", () => {
    const body =
      "---\n" +
      "description: My skill\n" +
      "trigger: when user mentions X\n" +
      "---\n\n" +
      "This is the actual prose content of the skill body that matters.";
    const result = skill_cache.generate_compact_summary(body);
    expect(result.includes("trigger:")).toBe(false);
    expect(result.includes("actual prose content")).toBe(true);
  });

  it("test_prose_capped_at_400_chars", () => {
    const body = "x".repeat(600);
    const result = skill_cache.generate_compact_summary(body);
    expect(result.length).toBeLessThanOrEqual(400 + 10);
  });

  it("test_empty_body_returns_empty", () => {
    expect(skill_cache.generate_compact_summary("")).toBe("");
  });
});

// ---------------------------------------------------------------------------
// Improvement 3: extract_all_headings includes H4 headings
// ---------------------------------------------------------------------------

describe("TestExtractAllHeadingsH4", () => {
  const _BODY =
    "# Title\n\n" +
    "## Section A\n\n" +
    "Content A.\n\n" +
    "### Subsection A1\n\n" +
    "Content A1.\n\n" +
    "#### Deep Section A1a\n\n" +
    "Deep content.\n\n" +
    "## Section B\n\n" +
    "Content B.\n";

  it("test_max_level_4_includes_h4", () => {
    const headings = skill_cache.extract_all_headings(_BODY, 4);
    const levels = headings.map(([lvl]) => lvl);
    const titles = headings.map(([, title]) => title);
    expect(levels.includes(4)).toBe(true);
    expect(titles.includes("Deep Section A1a")).toBe(true);
  });

  it("test_max_level_3_excludes_h4", () => {
    const headings = skill_cache.extract_all_headings(_BODY, 3);
    const levels = headings.map(([lvl]) => lvl);
    expect(levels.includes(4)).toBe(false);
    expect(levels.every((lvl) => lvl <= 3)).toBe(true);
  });

  it("test_default_max_level_excludes_h4", () => {
    const headings = skill_cache.extract_all_headings(_BODY);
    expect(headings.every(([lvl]) => lvl <= 3)).toBe(true);
  });

  it("test_h4_inside_code_block_excluded", () => {
    const body = "## Real\n\n```\n#### Fake\n```\n\n#### Real H4\n\nContent.\n";
    const headings = skill_cache.extract_all_headings(body, 4);
    const titles = headings.map(([, title]) => title);
    expect(titles.includes("Real H4")).toBe(true);
    expect(titles.includes("Fake")).toBe(false);
  });

  it("test_empty_body_returns_empty", () => {
    expect(skill_cache.extract_all_headings("")).toEqual([]);
    expect(skill_cache.extract_all_headings("", 4)).toEqual([]);
  });

  it("test_h2_h3_h4_ordering_preserved", () => {
    const body = "## A\n### B\n#### C\n## D\n";
    const headings = skill_cache.extract_all_headings(body, 4);
    const titles = headings.map(([, title]) => title);
    expect(titles).toEqual(["A", "B", "C", "D"]);
  });
});

// ---------------------------------------------------------------------------
// Improvement 4: extract_named_section reaches H4 sections
// ---------------------------------------------------------------------------

describe("TestExtractNamedSectionH4", () => {
  it("test_h4_section_extracted", () => {
    const body =
      "## Top\n\nTop content.\n\n" +
      "### Sub\n\nSub content.\n\n" +
      "#### Deep\n\nDeep content here.\n\n" +
      "## Next\n\nNext content.\n";
    const result = skill_cache.extract_named_section(body, "Deep");
    expect(result).not.toBeNull();
    expect(result!.includes("Deep content here.")).toBe(true);
  });

  it("test_h2_preferred_over_h4_same_name", () => {
    const body = "## Rules\n\nH2 rules.\n\n#### Rules\n\nH4 rules.\n";
    const result = skill_cache.extract_named_section(body, "Rules");
    expect(result).not.toBeNull();
    expect(result!.includes("H2 rules.")).toBe(true);
    expect(result!.includes("H4 rules.")).toBe(true);
  });

  it("test_h4_section_stops_at_next_h4", () => {
    const body = "#### Alpha\n\nAlpha content.\n\n#### Beta\n\nBeta content.\n";
    const result = skill_cache.extract_named_section(body, "Alpha");
    expect(result).not.toBeNull();
    expect(result!.includes("Alpha content.")).toBe(true);
    expect(result!.includes("Beta content.")).toBe(false);
  });

  it("test_nonexistent_section_returns_none", () => {
    const body = "## Real Section\n\nContent.\n";
    const result = skill_cache.extract_named_section(body, "No Such Section");
    expect(result).toBeNull();
  });
});
