/**
 * Faithful TS port of tests/test_skill_h3_headings.py.
 *
 * Covers:
 * 1. skill_cache.extract_all_headings() — H2 + H3 headings, excludes code blocks.
 * 2. skill-body "Sections available" now includes H3 headings (DEFERRED — cli).
 * 3. skill-body --section not-found error lists H2 and H3 headings (DEFERRED — cli).
 * 4. skill-size compact_is_estimated flag (DEFERRED — cli).
 * 5. Graceful no-cached-body error message (DEFERRED — cli).
 *
 * Porting notes:
 *  - token_goat.cli is NOT ported (no cli.ts module), so every CliRunner-based
 *    class is deferred with it.skip. Only the pure extract_all_headings unit
 *    tests run.
 */
import { describe, expect, it } from "vitest";

import * as skill_cache from "../src/token_goat/skill_cache.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const _RALPH_LIKE_BODY = `# ralph

## When to Use Ralph vs Superman

Use Ralph for multi-iteration tasks.

### Operating Modes

| Mode | Description |
|------|-------------|
| --auto | Full autonomous loop |
| --guided | Pause after each iteration |

## Operating Protocol

The main operating loop.

### Step 0 — Initialize Loop State

Initialize your DoD here.

### Step 1 — Iterate

Run until done.

## Multi-Agent Collaboration

Pattern for spawning agents.

\`\`\`markdown
### Fake heading inside code block

Should not appear in headings list.
\`\`\`
`;

// ---------------------------------------------------------------------------
// extract_all_headings unit tests
// ---------------------------------------------------------------------------

describe("TestExtractAllHeadings", () => {
  it("test_returns_h2_and_h3_headings", () => {
    const headings = skill_cache.extract_all_headings(_RALPH_LIKE_BODY);
    const levels = headings.map(([level]) => level);
    const titles = headings.map(([, title]) => title);
    expect(levels.includes(2)).toBe(true);
    expect(titles.includes("When to Use Ralph vs Superman")).toBe(true);
    expect(titles.includes("Operating Protocol")).toBe(true);
    expect(levels.includes(3)).toBe(true);
    expect(titles.includes("Operating Modes")).toBe(true);
    expect(titles.includes("Step 0 — Initialize Loop State")).toBe(true);
  });

  it("test_excludes_headings_inside_code_blocks", () => {
    const headings = skill_cache.extract_all_headings(_RALPH_LIKE_BODY);
    const titles = headings.map(([, title]) => title);
    expect(titles.includes("Fake heading inside code block")).toBe(false);
  });

  it("test_respects_max_level", () => {
    const headings = skill_cache.extract_all_headings(_RALPH_LIKE_BODY, 2);
    const levels = headings.map(([level]) => level);
    expect(levels.every((level) => level === 2)).toBe(true);
    expect(levels.includes(3)).toBe(false);
  });

  it("test_max_level_4_includes_deeper_headings", () => {
    const body_with_h4 = "## Top\n\n### Sub\n\n#### Deep\n\ncontent\n";
    const headings = skill_cache.extract_all_headings(body_with_h4, 4);
    const levels = headings.map(([level]) => level);
    expect(levels.includes(4)).toBe(true);
  });

  it("test_empty_body_returns_empty_list", () => {
    expect(skill_cache.extract_all_headings("")).toEqual([]);
  });

  it("test_body_with_only_h1_returns_empty", () => {
    expect(skill_cache.extract_all_headings("# Title\n\nContent.\n")).toEqual([]);
  });

  it("test_preserves_order", () => {
    const headings = skill_cache.extract_all_headings(_RALPH_LIKE_BODY);
    const titles = headings.map(([, title]) => title);
    expect(
      titles.indexOf("When to Use Ralph vs Superman") <
        titles.indexOf("Operating Modes"),
    ).toBe(true);
    expect(
      titles.indexOf("Operating Protocol") <
        titles.indexOf("Step 0 — Initialize Loop State"),
    ).toBe(true);
  });

  it("test_em_dash_in_heading_preserved", () => {
    const body =
      "## Step 4 — The Main Loop\n\ncontent\n### Sub — Phase\n\ncontent\n";
    const headings = skill_cache.extract_all_headings(body);
    const titles = headings.map(([, title]) => title);
    expect(titles.some((t) => t.includes("Step 4"))).toBe(true);
    expect(titles.some((t) => t.includes("The Main Loop"))).toBe(true);
  });

  it("test_tilde_fence_excluded", () => {
    const body = "## Real\n\n~~~\n### Fake\n~~~\n\n## Also Real\n";
    const headings = skill_cache.extract_all_headings(body);
    const titles = headings.map(([, title]) => title);
    expect(titles.includes("Real")).toBe(true);
    expect(titles.includes("Also Real")).toBe(true);
    expect(titles.includes("Fake")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// skill-body "Sections available" includes H3 headings (DEFERRED — cli)
// ---------------------------------------------------------------------------

describe("TestSkillBodySectionsAvailable", () => {
  // PORT: deferred — token_goat.cli is not ported (no cli.ts module exists),
  // so the CliRunner-driven skill-body output cannot be exercised.
  it.skip("test_sections_available_includes_h3_headings", () => {});
  it.skip("test_h3_headings_indented_in_listing", () => {});
  it.skip("test_section_not_found_error_lists_h3", () => {});
});

// ---------------------------------------------------------------------------
// skill-section not-found error lists H3 headings (DEFERRED — cli)
// ---------------------------------------------------------------------------

describe("TestSkillSectionNotFoundListsH3", () => {
  // PORT: deferred — token_goat.cli is not ported (no cli.ts module exists).
  it.skip("test_not_found_includes_h3_headings", () => {});
  it.skip("test_h3_section_extractable_via_skill_section", () => {});
});

// ---------------------------------------------------------------------------
// skill-size compact_is_estimated flag (DEFERRED — cli)
// ---------------------------------------------------------------------------

describe("TestSkillSizeCompactEstimation", () => {
  // PORT: deferred — token_goat.cli is not ported (no cli.ts module exists),
  // so the skill-size CLI subcommand and its JSON output cannot be exercised.
  it.skip("test_json_includes_compact_is_estimated_false_when_compact_stored", () => {});
  it.skip("test_json_includes_compact_is_estimated_true_when_no_compact", () => {});
  it.skip("test_human_output_notes_estimated_compact", () => {});
});

// ---------------------------------------------------------------------------
// skill-body graceful not-cached error message (DEFERRED — cli)
// ---------------------------------------------------------------------------

describe("TestSkillBodyNotCachedError", () => {
  // PORT: deferred — token_goat.cli is not ported (no cli.ts module exists).
  it.skip("test_not_cached_error_mentions_invoke", () => {});
  it.skip("test_not_cached_error_mentions_skill_name", () => {});
});
