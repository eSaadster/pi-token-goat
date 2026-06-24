/**
 * Tests for skill context savings improvements (iteration 9 of 10).
 *
 * Faithful 1:1 TS port of tests/test_skill_iter9_improvements.py.
 *
 * Covers:
 * 1. Gzip compression for large skill bodies (>16 KB) in skill_cache.
 * 2. ``token-goat skill-list`` CLI subcommand.
 * 3. Warn on oversized compact slices (COMPACT_END placed too late).
 *
 * Porting notes:
 *  - tmp_data_dir: setup.ts already isolates paths.dataDir() per test, so the
 *    "skills" cache dir is `get_cache_dir("skills")` (== <dataDir>/skills).
 *  - patch_skill_config / skill_compress_cfg: vi.spyOn(config, "load") returning
 *    a fake config object whose `.skill_preservation` is the chosen cfg. The
 *    real load() default has `compress_bodies=true, compress_min_bytes=16384`.
 *  - make_large_skill_body: ported as a module-level helper (conftest.py).
 *  - TestSkillListCommand is DEFERRED in full: cli.ts is not ported (no
 *    token_goat.cli module exists in the TS port).
 *  - The COMPACT_END warning tests build their own StringIO-equivalent buffer
 *    (a string accumulator) and exercise the pure warning logic + the real
 *    skill_cache.extract_compact_from_marker, exactly as the Python tests do.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";

import * as skill_cache from "../src/token_goat/skill_cache.js";
import * as config from "../src/token_goat/config.js";
import { get_cache_dir } from "../src/token_goat/cache_common.js";
import type {
  ConfigSchema,
  SkillPreservationConfig,
} from "../src/token_goat/types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** conftest.make_large_skill_body(size_bytes). */
function make_large_skill_body(size_bytes = 20_000): string {
  let line =
    "# Skill Body\n\n" +
    ("This is skill content with words. ".repeat(20) + "\n").repeat(20);
  while (Buffer.from(line, "utf8").length < size_bytes) {
    line += "More content here for padding purposes.\n";
  }
  return line;
}

/** conftest.skill_compress_cfg: compress at a 1 KB threshold. */
function skill_compress_cfg(): SkillPreservationConfig {
  return { compress_bodies: true, compress_min_bytes: 1024 };
}

/**
 * conftest.patch_skill_config: spy config.load() to return an object whose
 * .skill_preservation is the supplied cfg. Returns the spy so callers may
 * inspect/restore it; tests restore in afterEach.
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

/** Python `list(dir.glob(pattern))` for a simple "*.EXT" glob, returns full paths. */
function globExt(dir: string, ext: string): string[] {
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return [];
  }
  return names
    .filter((n) => n.endsWith(ext))
    .map((n) => path.join(dir, n));
}

afterEach(() => {
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// Improvement 1: gzip compression for large skill bodies
// ---------------------------------------------------------------------------

describe("TestGzipCompression", () => {
  it("test_compressed_file_created_for_large_body", () => {
    const body = make_large_skill_body(20_000);
    patch_skill_config(skill_compress_cfg());
    const meta = skill_cache.store_output("session-abc", "test-skill", body);

    expect(meta).not.toBeNull();
    const gz_files = globExt(skillsDir(), ".gz");
    expect(gz_files.length).toBe(1);
  });

  it("test_compressed_body_reads_back_correctly", () => {
    const body = make_large_skill_body(20_000);
    patch_skill_config(skill_compress_cfg());
    const meta = skill_cache.store_output("session-abc", "test-skill", body);

    expect(meta).not.toBeNull();
    const loaded = skill_cache.load_output(meta!.output_id);
    expect(loaded).not.toBeNull();
    expect(loaded!.startsWith("# Skill Body")).toBe(true);
  });

  it("test_small_body_stored_as_plain_text", () => {
    const cfg_sp: SkillPreservationConfig = {
      compress_bodies: true,
      compress_min_bytes: 16 * 1024,
    };
    patch_skill_config(cfg_sp);
    const small_body = "# Small Skill\n\nThis is a short skill body.\n";
    const meta = skill_cache.store_output("session-abc", "small-skill", small_body);

    expect(meta).not.toBeNull();
    const gz_files = globExt(skillsDir(), ".gz");
    expect(gz_files.length).toBe(0);

    const loaded = skill_cache.load_output(meta!.output_id);
    expect(loaded).not.toBeNull();
    expect(loaded!.includes("Small Skill")).toBe(true);
  });

  it("test_compress_disabled_does_not_create_gz", () => {
    const cfg_sp: SkillPreservationConfig = {
      compress_bodies: false,
      compress_min_bytes: 1024,
    };
    const body = make_large_skill_body(20_000);
    patch_skill_config(cfg_sp);
    const meta = skill_cache.store_output("session-abc", "test-skill", body);

    expect(meta).not.toBeNull();
    const gz_files = globExt(skillsDir(), ".gz");
    expect(gz_files.length).toBe(0);
  });

  it("test_gz_file_compresses_to_smaller_size", () => {
    const body = make_large_skill_body(30_000);
    patch_skill_config(skill_compress_cfg());
    const meta = skill_cache.store_output("session-abc", "test-skill", body);

    expect(meta).not.toBeNull();
    const gz_files = globExt(skillsDir(), ".gz");
    expect(gz_files.length).toBe(1);

    const gz_size = fs.statSync(gz_files[0]!).size;
    const raw_size = Buffer.from(body, "utf8").length;
    // Markdown prose should compress to at least 40% smaller.
    expect(gz_size).toBeLessThan(raw_size * 0.6);
  });

  it("test_load_output_prefers_gz_over_plain", () => {
    const skills_dir = skillsDir();
    fs.mkdirSync(skills_dir, { recursive: true });

    // output_id must match OUTPUT_FILENAME_RE when .txt is appended.
    const output_id = "abcd1234567890ab-test-skill-abcdef12345678ab";

    const plain_body = "plain text body";
    const gz_body = "compressed body (different content)";

    fs.writeFileSync(path.join(skills_dir, output_id + ".txt"), plain_body, "utf8");
    const compressed = zlib.gzipSync(Buffer.from(gz_body, "utf8"));
    fs.writeFileSync(path.join(skills_dir, output_id + ".gz"), compressed);

    const loaded = skill_cache.load_output(output_id);
    expect(loaded).toBe(gz_body);
  });

  it("test_load_output_falls_back_to_plain_when_no_gz", () => {
    const skills_dir = skillsDir();
    fs.mkdirSync(skills_dir, { recursive: true });

    const output_id = "abcd1234567890ab-test-skill-abcdef12345678ab";
    const plain_body = "plain text only";
    fs.writeFileSync(path.join(skills_dir, output_id + ".txt"), plain_body, "utf8");

    const loaded = skill_cache.load_output(output_id);
    expect(loaded).toBe(plain_body);
  });
});

// ---------------------------------------------------------------------------
// Improvement 2: token-goat skill-list command
// ---------------------------------------------------------------------------

describe("TestSkillListCommand", () => {
  // PORT: deferred — token_goat.cli is not ported to TS (no cli.ts module
  // exists), so `cli.app` / CliRunner cannot be exercised. Structure preserved.
  it.skip("test_skill_list_empty", () => {});
  it.skip("test_skill_list_shows_stored_skill", () => {});
  it.skip("test_skill_list_shows_compact_yes_when_available", () => {});
  it.skip("test_skill_list_shows_no_compact_when_absent", () => {});
  it.skip("test_skill_list_json_output", () => {});
  it.skip("test_skill_list_multiple_skills", () => {});
  it.skip("test_skill_list_session_count_in_footer", () => {});
});

// ---------------------------------------------------------------------------
// Improvement 3: warn on oversized compact slices
// ---------------------------------------------------------------------------

describe("TestOversizedCompactWarning", () => {
  /** Return a skill body whose pre-COMPACT_END section exceeds the budget. */
  function _make_body_with_large_compact(compact_tokens = 1200): string {
    // 4 chars ~= 1 token; build a compact section of ~compact_tokens tokens.
    const compact_content =
      "This is rule content. MUST follow this rule.\n".repeat(
        Math.floor((compact_tokens * 4) / 46) + 1,
      );
    return (
      `# Large Skill\n\n` +
      `${compact_content}\n` +
      `<!-- COMPACT_END -->\n\n` +
      `## Detailed Section\n\nMore detailed content here.\n`
    );
  }

  it("test_no_warning_when_compact_within_budget", () => {
    const body =
      "# Small Skill\n\n" +
      "MUST follow this rule.\n" +
      "<!-- COMPACT_END -->\n\n" +
      "## Details\n\nExtra content.\n";

    let stderr_output = "";

    const marker_compact = skill_cache.extract_compact_from_marker(body);
    expect(marker_compact).not.toBeNull();
    const compact_tokens = Math.floor(
      Buffer.from(marker_compact!, "utf8").length / 4,
    );
    expect(compact_tokens).toBeLessThan(800);

    const budget = 800;
    if (budget > 0 && compact_tokens > budget) {
      stderr_output += "token-goat warning: ...\n";
    }

    expect(stderr_output.includes("token-goat warning")).toBe(false);
  });

  it("test_warning_emitted_when_compact_exceeds_budget", () => {
    const body = _make_body_with_large_compact(1200);

    const marker_compact = skill_cache.extract_compact_from_marker(body);
    expect(marker_compact).not.toBeNull();
    const compact_tokens = Math.floor(
      Buffer.from(marker_compact!, "utf8").length / 4,
    );
    expect(compact_tokens).toBeGreaterThan(800);

    let stderr_output = "";
    const budget = 800;
    if (budget > 0 && compact_tokens > budget) {
      stderr_output +=
        `token-goat warning: skill 'test-skill' compact slice is ${compact_tokens} tokens` +
        ` (budget: ${budget} tokens).` +
        ` Move <!-- COMPACT_END --> earlier in the file.\n`;
    }

    const warning_text = stderr_output;
    expect(warning_text.includes("token-goat warning")).toBe(true);
    expect(warning_text.includes("compact slice")).toBe(true);
    expect(warning_text.includes("Move <!-- COMPACT_END --> earlier")).toBe(true);
  });

  it("test_hooks_skill_emits_warning_for_oversized_compact", () => {
    const body = _make_body_with_large_compact(1200);

    const marker_compact = skill_cache.extract_compact_from_marker(body);
    expect(marker_compact).not.toBeNull();
    const compact_tokens = Math.floor(
      Buffer.from(marker_compact!, "utf8").length / 4,
    );
    expect(compact_tokens).toBeGreaterThan(800);

    const budget = 800;

    let stderr_output = "";
    if (budget > 0 && compact_tokens > budget) {
      stderr_output +=
        `token-goat warning: skill 'large-skill'` +
        ` compact slice is ${compact_tokens} tokens` +
        ` (budget: ${budget} tokens).` +
        ` Move <!-- COMPACT_END --> earlier in the file.\n`;
    }

    expect(stderr_output.includes("token-goat warning")).toBe(true);
    expect(stderr_output.includes(String(compact_tokens))).toBe(true);
  });

  it("test_warning_contains_skill_name", () => {
    const skill_name = "my-oversized-skill";
    const compact_tokens = 1500;
    const budget = 800;
    let output = "";
    if (budget > 0 && compact_tokens > budget) {
      output +=
        `token-goat warning: skill '${skill_name}'` +
        ` compact slice is ${compact_tokens} tokens` +
        ` (budget: ${budget} tokens).` +
        ` Move <!-- COMPACT_END --> earlier in the file.\n`;
    }
    expect(output.includes(skill_name)).toBe(true);
    expect(output.includes(String(compact_tokens))).toBe(true);
    expect(output.includes(String(budget))).toBe(true);
  });

  it("test_no_warning_when_budget_zero", () => {
    const budget = 0;
    const compact_tokens = 5000; // Very large
    let output = "";
    if (budget > 0 && compact_tokens > budget) {
      output += "token-goat warning: ...\n";
    }
    expect(output).toBe("");
  });
});
