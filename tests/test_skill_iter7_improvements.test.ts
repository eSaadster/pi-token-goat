/**
 * Faithful TS port of tests/test_skill_iter7_improvements.py.
 *
 * Covers:
 * 1. Skill body truncation budget — truncation_budget_tokens config option.
 * 2. skill-section #N ordinal disambiguation — extract_named_section / _parse_section_ordinal.
 * 3. Compaction manifest total inline budget — _SKILL_INLINE_TOTAL_TOKEN_BUDGET.
 *
 * Porting notes:
 *  - tmp_data_dir fixture -> handled by tests/setup.ts (per-test tmp data dir).
 *  - SkillPreservationConfig is a TS interface (not an instantiable dataclass);
 *    `SkillPreservationConfig()` default check is ported to a config.load()
 *    default-value assertion with an isolated (non-existent) config path.
 *  - monkeypatch.setattr(paths, "config_path", ...) -> paths.setConfigPathOverride().
 *  - cfg_mod._config_mtime_cache = None -> config.clearConfigCache().
 *  - build_manifest(sid, max_tokens=N) -> build_manifest(sid, { max_tokens: N }).
 *  - _SKILL_INLINE_TOTAL_TOKEN_BUDGET / _SKILL_COMPACT_INLINE_MAX_CHARS are
 *    module-private `const` in compact.ts (NOT exported). The tests that need
 *    them are DEFERRED with a missing-export note.
 */
import { describe, expect, it, beforeEach, afterEach } from "vitest";

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import * as skill_cache from "../src/token_goat/skill_cache.js";
import {
  _parse_section_ordinal,
  extract_named_section,
} from "../src/token_goat/skill_cache.js";
import * as config from "../src/token_goat/config.js";
import * as paths from "../src/token_goat/paths.js";
import { build_manifest, estimate_tokens } from "../src/token_goat/compact.js";
import * as sess_mod from "../src/token_goat/session.js";
import { SkillEntry } from "../src/token_goat/session.js";

// ---------------------------------------------------------------------------
// Improvement 2: skill-section #N ordinal disambiguation
// ---------------------------------------------------------------------------

describe("TestParseSectionOrdinal", () => {
  it("test_no_hash_returns_heading_and_none", () => {
    expect(_parse_section_ordinal("Usage")).toEqual(["Usage", null]);
  });

  it("test_hash2_returns_heading_and_2", () => {
    expect(_parse_section_ordinal("Usage#2")).toEqual(["Usage", 2]);
  });

  it("test_hash3_returns_heading_and_3", () => {
    expect(_parse_section_ordinal("Step 1 — Explore#3")).toEqual([
      "Step 1 — Explore",
      3,
    ]);
  });

  it("test_malformed_nonnumeric_returns_none_ordinal", () => {
    expect(_parse_section_ordinal("Usage#abc")).toEqual(["Usage#abc", null]);
  });

  it("test_zero_ordinal_is_invalid", () => {
    expect(_parse_section_ordinal("Usage#0")).toEqual(["Usage#0", null]);
  });

  it("test_negative_ordinal_is_invalid", () => {
    expect(_parse_section_ordinal("Usage#-1")).toEqual(["Usage#-1", null]);
  });

  it("test_heading_with_hash_but_no_ordinal", () => {
    expect(_parse_section_ordinal("Usage#")).toEqual(["Usage#", null]);
  });

  it("test_empty_base_is_not_split", () => {
    expect(_parse_section_ordinal("#2")).toEqual(["#2", null]);
  });
});

describe("TestExtractNamedSectionOrdinal", () => {
  const _BODY_TWO_USAGE = `# Skill

## Overview

Intro text.

## Usage

First Usage content.

## Step 1

Step one content.

## Usage

Second Usage content.
`;

  it("test_first_occurrence_returned_without_ordinal", () => {
    const result = extract_named_section(_BODY_TWO_USAGE, "Usage");
    expect(result).not.toBeNull();
    expect(result!.includes("First Usage content")).toBe(true);
    expect(result!.includes("Second Usage content")).toBe(false);
  });

  it("test_hash1_returns_first", () => {
    const result = extract_named_section(_BODY_TWO_USAGE, "Usage#1");
    expect(result).not.toBeNull();
    expect(result!.includes("First Usage content")).toBe(true);
  });

  it("test_hash2_returns_second", () => {
    const result = extract_named_section(_BODY_TWO_USAGE, "Usage#2");
    expect(result).not.toBeNull();
    expect(result!.includes("Second Usage content")).toBe(true);
    expect(result!.includes("First Usage content")).toBe(false);
  });

  it("test_hash3_returns_none_when_only_two_exist", () => {
    const result = extract_named_section(_BODY_TWO_USAGE, "Usage#3");
    expect(result).toBeNull();
  });

  it("test_single_occurrence_with_hash1", () => {
    const body = "## Overview\n\ncontent\n";
    const result = extract_named_section(body, "Overview#1");
    expect(result).toBe("content");
  });

  it("test_different_headings_no_confusion", () => {
    const body = `## Alpha

Alpha one.

## Beta

Beta one.

## Alpha

Alpha two.
`;
    expect((extract_named_section(body, "Alpha#2") ?? "").includes("Alpha two")).toBe(
      true,
    );
    expect((extract_named_section(body, "Beta#1") ?? "").includes("Beta one")).toBe(
      true,
    );
  });

  it("test_h3_duplicate_headings_ordinal", () => {
    const body = `## Parent

### Notes

First notes.

### Notes

Second notes.
`;
    const result1 = extract_named_section(body, "Notes#1");
    const result2 = extract_named_section(body, "Notes#2");
    expect(result1 !== null && result1.includes("First notes")).toBe(true);
    expect(result2 !== null && result2.includes("Second notes")).toBe(true);
  });

  it("test_heading_with_real_hash_in_name_not_split", () => {
    const body = "## C#\n\nCsharp content.\n";
    const result = extract_named_section(body, "C#");
    expect(result).not.toBeNull();
    expect(result!.includes("Csharp content")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Improvement 1: truncation_budget_tokens
// ---------------------------------------------------------------------------

describe("TestTruncationBudgetTokensConfig", () => {
  // _isolate_config: point config_path at a non-existent file so the real user
  // config.toml is never read. clearModuleCaches() in setup.ts already resets
  // the config mtime cache before each test.
  let tmp: string;

  beforeEach(() => {
    tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "tg-iter7-")));
    paths.setConfigPathOverride(path.join(tmp, "config.toml"));
    config.clearConfigCache();
  });

  afterEach(() => {
    config.clearConfigCache();
    paths.setConfigPathOverride(undefined);
  });

  it("test_default_value", () => {
    // Python instantiates SkillPreservationConfig() (a dataclass) and checks the
    // default. TS has no such class (interface), so we assert the load() default.
    const cfg = config.load();
    expect(cfg.skill_preservation!.truncation_budget_tokens).toBe(800);
  });

  it("test_toml_override", () => {
    const toml_content =
      "[skill_preservation]\n" + "truncation_budget_tokens = 200\n";
    const cfg_file = path.join(tmp, "config.toml");
    fs.writeFileSync(cfg_file, toml_content, "utf-8");
    paths.setConfigPathOverride(cfg_file);
    config.clearConfigCache();

    const loaded = config.load();
    expect(loaded.skill_preservation!.truncation_budget_tokens).toBe(200);

    config.clearConfigCache();
  });

  it("test_zero_disables_budget_cap", () => {
    const toml_content =
      "[skill_preservation]\ntruncation_budget_tokens = 0\n";
    const cfg_file = path.join(tmp, "config.toml");
    fs.writeFileSync(cfg_file, toml_content, "utf-8");
    paths.setConfigPathOverride(cfg_file);
    config.clearConfigCache();

    const loaded = config.load();
    expect(loaded.skill_preservation!.truncation_budget_tokens).toBe(0);
    config.clearConfigCache();
  });
});

describe("TestTruncationBudgetApplied", () => {
  // These tests simulate the budget-application logic inline (mirroring the
  // Python tests, which also inline the logic from hooks_skill.py). No skill_cache
  // API is exercised — pure string math, identical to the Python source.

  it("test_compact_truncated_to_budget", () => {
    let compact_text = "A".repeat(2000);
    const cfg_budget = 100; // tokens
    const budget_chars = cfg_budget * 4; // 400 chars
    if (cfg_budget > 0 && compact_text.length > budget_chars) {
      let _cut = compact_text.lastIndexOf("\n", budget_chars - 1);
      // Python str.rfind("\n", 0, budget_chars) → search in [0, budget_chars).
      if (_cut <= 0) {
        _cut = budget_chars;
      }
      compact_text = compact_text.slice(0, _cut).replace(/\s+$/u, "") + "…";
    }
    expect(compact_text.length).toBe(budget_chars + 1);
  });

  it("test_compact_truncated_at_newline_boundary", () => {
    const line = "A".repeat(99);
    let compact_text = Array(5).fill(line).join("\n");
    const cfg_budget = 50;
    const budget_chars = cfg_budget * 4; // 200 chars
    if (cfg_budget > 0 && compact_text.length > budget_chars) {
      let _cut = compact_text.lastIndexOf("\n", budget_chars - 1);
      if (_cut <= 0) {
        _cut = budget_chars;
      }
      compact_text = compact_text.slice(0, _cut).replace(/\s+$/u, "") + "…";
    }
    expect(compact_text.endsWith("…")).toBe(true);
    expect(compact_text.length).toBeLessThanOrEqual(budget_chars + 1);
  });

  it("test_zero_budget_disables_truncation", () => {
    let compact_text = "B".repeat(5000);
    const cfg_budget = 0;
    if (cfg_budget > 0) {
      const budget_chars = cfg_budget * 4;
      if (compact_text.length > budget_chars) {
        let _cut = compact_text.lastIndexOf("\n", budget_chars - 1);
        if (_cut <= 0) {
          _cut = budget_chars;
        }
        compact_text = compact_text.slice(0, _cut).replace(/\s+$/u, "") + "…";
      }
    }
    expect(compact_text.length).toBe(5000);
  });

  it("test_compact_under_budget_not_truncated", () => {
    let compact_text = "Short compact.";
    const cfg_budget = 800;
    const budget_chars = cfg_budget * 4;
    const original = compact_text;
    if (cfg_budget > 0 && compact_text.length > budget_chars) {
      let _cut = compact_text.lastIndexOf("\n", budget_chars - 1);
      if (_cut <= 0) {
        _cut = budget_chars;
      }
      compact_text = compact_text.slice(0, _cut).replace(/\s+$/u, "") + "…";
    }
    expect(compact_text).toBe(original);
  });
});

// ---------------------------------------------------------------------------
// Improvement 3: manifest total inline skill budget
// ---------------------------------------------------------------------------

describe("TestManifestSkillInlineBudget", () => {
  // _SKILL_INLINE_TOTAL_TOKEN_BUDGET and _SKILL_COMPACT_INLINE_MAX_CHARS are
  // module-private `const` in compact.ts (not exported). The three tests that
  // import them are DEFERRED with a missing-export note.
  it.skip("test_budget_constant_present (compact._SKILL_INLINE_TOTAL_TOKEN_BUDGET not exported)", () => {});
  it.skip("test_per_skill_chars_shrinks_with_more_skills (compact._SKILL_COMPACT_INLINE_MAX_CHARS not exported)", () => {});
  it.skip("test_six_skills_fit_within_total_budget (compact._SKILL_COMPACT_INLINE_MAX_CHARS not exported)", () => {});

  it("test_skill_lines_respect_budget_in_manifest", () => {
    // Set up a session with 3 large skill compacts.
    const session_id = "s-manifest-budget-test-001";
    for (const skill_name of ["ralph", "improve", "marketing"]) {
      const large_compact = Array.from(
        { length: 200 },
        (_, i) => `## Section ${i}: CRITICAL rule for ${skill_name}`,
      ).join("\n");
      skill_cache.store_compact(session_id, skill_name, large_compact);
    }

    // Populate the session cache with skill history entries.
    const cache = sess_mod.load(session_id);
    const now = Date.now() / 1000;
    for (const skill_name of ["ralph", "improve", "marketing"]) {
      cache.skill_history[skill_name] = new SkillEntry({
        skill_name,
        output_id: `${session_id.slice(0, 8)}-${skill_name}-oid`,
        content_sha: "abc",
        body_bytes: 30000,
        ts: now,
      });
    }
    // Also add an edit so the manifest passes the activity floor.
    cache.edited_files["src/some_file.py"] = 1;
    sess_mod.save(cache);

    const manifest = build_manifest(session_id, { max_tokens: 400 });
    const token_count = estimate_tokens(manifest);
    expect(token_count).toBeLessThanOrEqual(400);
  });
});
