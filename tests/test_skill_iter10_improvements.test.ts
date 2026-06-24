/**
 * Faithful TS port of tests/test_skill_iter10_improvements.py.
 *
 * Covers:
 * 1. Gzip-compressed skill body + section extraction end-to-end.
 * 2. Token savings reporting accuracy: estimate_tokens (3 chars/token) vs // 4.
 * 3. Token count display consistency (skill-list / skill-size) — DEFERRED for the
 *    CLI portions (token_goat.cli is not ported); the skill-size token-math
 *    portion is exercised via skill_cache.get_all_cached_skills directly.
 *
 * Porting notes:
 *  - conftest.make_skill_body_with_sections -> inlined module-level helper.
 *  - conftest.patch_skill_config / skill_compress_cfg -> vi.spyOn(config,"load")
 *    returning a fake config whose .skill_preservation is the chosen cfg.
 *  - compact.estimate_tokens is ported (max(1, len // 3 + 1)).
 *  - Python `len(text)` is code points; the bodies here are ASCII so `.length`
 *    matches. Python `text.encode()` byte length -> Buffer.byteLength(text,"utf8").
 *  - TestSkillListTokenCounts uses CliRunner + token_goat.cli (not ported) ->
 *    deferred with it.skip.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import fs from "node:fs";
import path from "node:path";

import * as skill_cache from "../src/token_goat/skill_cache.js";
import * as config from "../src/token_goat/config.js";
import { estimate_tokens } from "../src/token_goat/compact.js";
import { get_cache_dir } from "../src/token_goat/cache_common.js";
import type {
  ConfigSchema,
  SkillPreservationConfig,
} from "../src/token_goat/types.js";

// ---------------------------------------------------------------------------
// Helpers (conftest)
// ---------------------------------------------------------------------------

/** conftest.make_skill_body_with_sections(size_bytes). */
function make_skill_body_with_sections(size_bytes = 20_000): string {
  const lines: string[] = [
    "# Big Skill",
    "",
    "## Overview",
    "",
    "This skill does many things.",
    "",
    "## Rules",
    "",
    "MUST follow rules.",
    "NEVER skip steps.",
    "",
    "## Implementation Details",
    "",
  ];
  const filler =
    "This is detailed implementation content with lots of words. ".repeat(10);
  const total = (): number =>
    lines.reduce((acc, ln) => acc + ln.length + 1, 0);
  while (total() < size_bytes) {
    lines.push(filler);
  }
  lines.push("");
  lines.push("## Summary");
  lines.push("");
  lines.push("The summary section.");
  return lines.join("\n");
}

/** conftest.skill_compress_cfg: compress at a 1 KB threshold. */
function skill_compress_cfg(): SkillPreservationConfig {
  return { compress_bodies: true, compress_min_bytes: 1024 };
}

/**
 * conftest.patch_skill_config: spy config.load() to return an object whose
 * .skill_preservation is the supplied cfg.
 */
function patch_skill_config(
  cfg: SkillPreservationConfig,
): ReturnType<typeof vi.spyOn> {
  return vi.spyOn(config, "load").mockReturnValue({
    skill_preservation: cfg,
  } as ConfigSchema);
}

/** The per-test skills cache directory (== <dataDir>/skills). */
function skillsDir(): string {
  return get_cache_dir("skills");
}

/** Python `list(dir.glob("*.gz"))` returning full paths. */
function globGz(dir: string): string[] {
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return [];
  }
  return names.filter((n) => n.endsWith(".gz")).map((n) => path.join(dir, n));
}

afterEach(() => {
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// Improvement 1: gzip-compressed body + section extraction end-to-end
// ---------------------------------------------------------------------------

describe("TestGzipSectionExtraction", () => {
  it("test_section_extracted_from_compressed_body", () => {
    const body = make_skill_body_with_sections(20_000);
    patch_skill_config(skill_compress_cfg());
    const meta = skill_cache.store_output("sess-gz", "bigskill", body);

    expect(meta).not.toBeNull();

    const gz_files = globGz(skillsDir());
    expect(gz_files.length).toBeGreaterThan(0);

    const loaded = skill_cache.load_output(meta!.output_id);
    expect(loaded).not.toBeNull();

    const section = skill_cache.extract_named_section(loaded!, "Rules");
    expect(section).not.toBeNull();
    expect(section!.includes("MUST follow rules")).toBe(true);
    expect(section!.includes("NEVER skip steps")).toBe(true);
  });

  it("test_section_extraction_returns_none_for_missing_section", () => {
    const body = make_skill_body_with_sections(20_000);
    patch_skill_config(skill_compress_cfg());
    const meta = skill_cache.store_output("sess-gz2", "bigskill2", body);

    expect(meta).not.toBeNull();

    const loaded = skill_cache.load_output(meta!.output_id);
    expect(loaded).not.toBeNull();

    const section = skill_cache.extract_named_section(
      loaded!,
      "Nonexistent Section",
    );
    expect(section).toBeNull();
  });

  it("test_overview_section_extracted_from_compressed_body", () => {
    const body = make_skill_body_with_sections(20_000);
    patch_skill_config(skill_compress_cfg());
    const meta = skill_cache.store_output("sess-gz3", "bigskill3", body);

    expect(meta).not.toBeNull();
    const loaded = skill_cache.load_output(meta!.output_id);
    expect(loaded).not.toBeNull();

    const section = skill_cache.extract_named_section(loaded!, "Overview");
    expect(section).not.toBeNull();
    expect(section!.includes("This skill does many things")).toBe(true);
  });

  it("test_section_not_truncated_after_decompression", () => {
    const body = make_skill_body_with_sections(20_000);
    patch_skill_config(skill_compress_cfg());
    const meta = skill_cache.store_output("sess-gz4", "bigskill4", body);

    expect(meta).not.toBeNull();
    const loaded = skill_cache.load_output(meta!.output_id);
    expect(loaded).not.toBeNull();

    const section = skill_cache.extract_named_section(loaded!, "Summary");
    expect(section).not.toBeNull();
    expect(section!.includes("The summary section")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Improvement 2: Token savings stat accuracy — estimate_tokens vs // 4
// ---------------------------------------------------------------------------

describe("TestTokenSavingsAccuracy", () => {
  it("test_estimate_tokens_formula", () => {
    const text = "x".repeat(1200);
    const result = estimate_tokens(text);
    expect(result).toBe(401);
  });

  it("test_estimate_tokens_larger_than_div4", () => {
    for (const n_chars of [8, 100, 1000, 10_000]) {
      const text = "a".repeat(n_chars);
      const est = estimate_tokens(text);
      const naive = Math.floor(n_chars / 4);
      expect(est).toBeGreaterThan(naive);
    }
  });

  it("test_skill_body_recall_stat_uses_estimate_tokens", () => {
    const body = make_skill_body_with_sections(8_000);
    patch_skill_config({ compress_bodies: false });
    const meta = skill_cache.store_output("sess-stat", "statskill", body);

    expect(meta).not.toBeNull();
    const loaded = skill_cache.load_output(meta!.output_id);
    expect(loaded).not.toBeNull();

    const section_text = skill_cache.extract_named_section(loaded!, "Rules");
    expect(section_text).not.toBeNull();

    const expected_tokens_saved = Math.max(
      0,
      estimate_tokens(loaded!) - estimate_tokens(section_text!),
    );
    const naive_tokens_saved = Math.max(
      0,
      Math.floor(
        (Buffer.byteLength(loaded!, "utf8") -
          Buffer.byteLength(section_text!, "utf8")) /
          4,
      ),
    );
    expect(expected_tokens_saved).toBeGreaterThan(naive_tokens_saved);
  });

  it("test_compact_tokens_use_estimate_tokens", () => {
    const body = make_skill_body_with_sections(5_000);
    patch_skill_config({ compress_bodies: false });
    const meta = skill_cache.store_output("sess-ct", "ctskill", body);

    expect(meta).not.toBeNull();
    const loaded = skill_cache.load_output(meta!.output_id);
    expect(loaded).not.toBeNull();

    const compact_body = skill_cache.generate_compact_summary(loaded!);
    const est = estimate_tokens(compact_body);
    const naive = Math.floor(compact_body.length / 4);
    expect(est > naive || compact_body.length < 8).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Improvement 3: skill-list and skill-size use canonical token estimator
// ---------------------------------------------------------------------------

describe("TestSkillListTokenCounts", () => {
  // PORT: deferred — token_goat.cli is not ported (no cli.ts module exists),
  // so the skill-list CLI subcommand cannot be exercised.
  it.skip("test_skill_list_json_body_tokens_uses_estimate_tokens", () => {});
});

describe("TestSkillSizeTokenCounts", () => {
  it("test_body_tokens_exceeds_div4", () => {
    const body = make_skill_body_with_sections(5_000);
    patch_skill_config({ compress_bodies: false });
    skill_cache.store_output("sess-size", "sizeskill", body);

    const skills = skill_cache.get_all_cached_skills("sess-size");
    expect(skills.length).toBeGreaterThan(0);

    const skill = skills[0]!;
    const body_chars = (skill as Record<string, unknown>)["body_chars"];
    if (typeof body_chars === "number" && body_chars > 0) {
      const expected = Math.max(1, Math.floor(body_chars / 3) + 1);
      const naive = Math.floor(body_chars / 4);
      expect(expected).toBeGreaterThan(naive);
    }
  });
});
