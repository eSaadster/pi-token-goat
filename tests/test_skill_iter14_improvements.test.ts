/**
 * Tests for skill caching improvements (iteration 14).
 *
 * Faithful 1:1 TS port of tests/test_skill_iter14_improvements.py.
 *
 * Covers:
 * 1. Cross-session dedup: find_cross_session_entry + store_output reuse behaviour
 * 2. Minimal-body guard in post_skill: tiny/stub responses are skipped gracefully
 *
 * Porting notes:
 *  - DataDirMixin (binds tmp_data_dir to self) -> setup.ts auto-isolates the
 *    data dir per test; the skills cache dir is `get_cache_dir("skills")`.
 *  - fire_skill_hook(session_id, skill_name, body) -> a module-level helper that
 *    builds the same payload (tool_response is the raw body string) and calls
 *    hooks_skill.post_skill. Default config has skill_preservation.enabled=True,
 *    so no config patch is required.
 *  - caplog.at_level(DEBUG, logger=...) -> vi.spyOn(console, "debug"/"warn") and
 *    scan the captured (format-string + args) text; the Python `r.message`
 *    assertions match substrings that live in the format string itself.
 *  - patch("token_goat.skill_cache.time.time", side_effect=[t0, t1]) -> the TS
 *    store_output uses Date.now()/1000; spy Date.now with a monotonic counter so
 *    the second store_output observes a strictly-later timestamp.
 *  - _SKILL_CACHE_MIN_BYTES is NOT exported from hooks_skill.ts (module-private);
 *    the fixed value 256 is used directly here. Reported in missingExports.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import fs from "node:fs";
import path from "node:path";

import * as skill_cache from "../src/token_goat/skill_cache.js";
import * as hooks_skill from "../src/token_goat/hooks_skill.js";
import { get_cache_dir } from "../src/token_goat/cache_common.js";

// hooks_skill._SKILL_CACHE_MIN_BYTES is module-private (not exported); its value
// is a fixed 256 in the implementation.
const _SKILL_CACHE_MIN_BYTES = 256;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** The per-test skills cache directory (== <dataDir>/skills). */
function skillsDir(): string {
  return get_cache_dir("skills");
}

/** Python `list(dir.glob("*.EXT"))` for a simple extension glob, full paths. */
function globExt(dir: string, ext: string): string[] {
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return [];
  }
  return names.filter((n) => n.endsWith(ext)).map((n) => path.join(dir, n));
}

/** conftest.fire_skill_hook: fire PostToolUse(Skill) and return the response. */
function fire_skill_hook(
  session_id: string,
  skill_name: string,
  body: string,
): Record<string, unknown> {
  const payload = {
    session_id: session_id,
    tool_name: "Skill",
    tool_input: { skill: skill_name },
    tool_response: body,
  };
  return hooks_skill.post_skill(payload) as unknown as Record<string, unknown>;
}

/** Spy console.debug/warn/info/error and accumulate "<fmt> <args...>" text. */
function captureLogs(): () => string {
  let buf = "";
  const record = (msg: unknown, ...args: unknown[]): void => {
    buf += String(msg) + " " + args.map((a) => String(a)).join(" ") + "\n";
  };
  vi.spyOn(console, "debug").mockImplementation(record);
  vi.spyOn(console, "info").mockImplementation(record);
  vi.spyOn(console, "warn").mockImplementation(record);
  vi.spyOn(console, "error").mockImplementation(record);
  return () => buf;
}

afterEach(() => {
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// Improvement 1: Cross-session dedup
// ---------------------------------------------------------------------------

describe("TestCrossSessionDedup", () => {
  // ------------------------------------------------------------------
  // find_cross_session_entry
  // ------------------------------------------------------------------

  it("test_find_cross_session_entry_returns_none_on_empty_cache", () => {
    const result = skill_cache.find_cross_session_entry("ralph", "abc123");
    expect(result).toBeNull();
  });

  it("test_find_cross_session_entry_no_match", () => {
    const body_a = "# Ralph skill\n\n" + "rule line. ".repeat(200);
    const meta_a = skill_cache.store_output("sess-alpha", "ralph", body_a);
    expect(meta_a).not.toBeNull();
    skill_cache.write_sidecar(meta_a!);

    const different_sha = "0000000000000000";
    const result = skill_cache.find_cross_session_entry("ralph", different_sha);
    expect(result).toBeNull();
  });

  it("test_find_cross_session_entry_match", () => {
    const body = "# Improve skill\n\n" + "step. ".repeat(300);
    const sha = skill_cache.content_hash(body);
    const meta_a = skill_cache.store_output("sess-first", "improve", body);
    expect(meta_a).not.toBeNull();
    skill_cache.write_sidecar(meta_a!);

    const hit = skill_cache.find_cross_session_entry("improve", sha);
    expect(hit).not.toBeNull();
    expect(hit!.skill_name).toBe("improve");
    expect(hit!.content_sha).toBe(sha);
    expect(hit!.output_id).toBe(meta_a!.output_id);
  });

  it("test_find_cross_session_entry_exported_in_all", () => {
    expect((skill_cache.__all__ as readonly string[]).includes("find_cross_session_entry")).toBe(true);
  });

  it("test_find_cross_session_entry_invalid_name_returns_none", () => {
    const result = skill_cache.find_cross_session_entry("with/slash", "abc123");
    expect(result).toBeNull();
  });

  it("test_find_cross_session_entry_empty_sha_returns_none", () => {
    const result = skill_cache.find_cross_session_entry("ralph", "");
    expect(result).toBeNull();
  });

  // ------------------------------------------------------------------
  // store_output cross-session dedup path
  // ------------------------------------------------------------------

  it("test_second_session_reuses_existing_body_file", () => {
    const body = "# Shared skill body\n\n" + "content line. ".repeat(300);
    const skills_dir = skillsDir();

    const meta_a = skill_cache.store_output("sess-A-longid", "shared-skill", body);
    expect(meta_a).not.toBeNull();
    skill_cache.write_sidecar(meta_a!);

    const txt_files_after_a = globExt(skills_dir, ".txt");
    expect(txt_files_after_a.length).toBe(1);

    const meta_b = skill_cache.store_output("sess-B-longid", "shared-skill", body);
    expect(meta_b).not.toBeNull();
    skill_cache.write_sidecar(meta_b!);

    const txt_files_after_b = globExt(skills_dir, ".txt");
    expect(txt_files_after_b.length).toBe(1);
  });

  it("test_second_session_meta_points_at_original_body", () => {
    const body = "# Skills are shared\n\n" + "shared content. ".repeat(250);

    const meta_a = skill_cache.store_output("sess-orig-001", "shared-skill2", body);
    expect(meta_a).not.toBeNull();
    skill_cache.write_sidecar(meta_a!);

    const meta_b = skill_cache.store_output("sess-new-002", "shared-skill2", body);
    expect(meta_b).not.toBeNull();
    const loaded_a = skill_cache.load_output(meta_a!.output_id);
    const loaded_b = skill_cache.load_output(meta_b!.output_id);
    expect(loaded_a).not.toBeNull();
    expect(loaded_b).not.toBeNull();
    expect(loaded_a!.slice(0, 50)).toBe(loaded_b!.slice(0, 50));
  });

  it("test_dedup_meta_has_updated_timestamp", () => {
    const body = "# Timestamped skill\n\n" + "ts content. ".repeat(200);

    // store_output uses Date.now()/1000; a monotonic counter guarantees the
    // second call observes a strictly-later timestamp without a real sleep.
    let counter = 1_000_000_000;
    vi.spyOn(Date, "now").mockImplementation(() => {
      counter += 1000; // +1s per call (ms)
      return counter;
    });

    const meta_a = skill_cache.store_output("sess-ts-aaa", "ts-skill", body);
    expect(meta_a).not.toBeNull();
    skill_cache.write_sidecar(meta_a!);

    const meta_b = skill_cache.store_output("sess-ts-bbb", "ts-skill", body);
    expect(meta_b).not.toBeNull();
    expect(meta_b!.ts).toBeGreaterThanOrEqual(meta_a!.ts);
  });

  it("test_different_skill_different_sha_no_dedup", () => {
    const body_x = "# Skill X\n\n" + "x content. ".repeat(200);
    const body_y = "# Skill Y\n\n" + "y content. ".repeat(200);
    const skills_dir = skillsDir();

    const meta_x = skill_cache.store_output("sess-multi", "skill-x", body_x);
    const meta_y = skill_cache.store_output("sess-multi", "skill-y", body_y);
    expect(meta_x).not.toBeNull();
    expect(meta_y).not.toBeNull();

    const txt_files = globExt(skills_dir, ".txt");
    expect(txt_files.length).toBe(2);
  });

  it("test_dedup_preserves_source_path_from_caller", () => {
    const body = "# Path test skill\n\n" + "path content. ".repeat(200);

    const meta_a = skill_cache.store_output("sess-path-aaa", "path-skill", body, {
      source_path: "/original/path/SKILL.md",
    });
    expect(meta_a).not.toBeNull();
    skill_cache.write_sidecar(meta_a!);

    const meta_b = skill_cache.store_output("sess-path-bbb", "path-skill", body, {
      source_path: "/new/path/SKILL.md",
    });
    expect(meta_b).not.toBeNull();
    expect(meta_b!.source_path).toBe("/new/path/SKILL.md");
  });

  it("test_dedup_falls_back_to_original_source_path_when_caller_omits", () => {
    const body = "# Fallback path skill\n\n" + "fallback content. ".repeat(200);

    const meta_a = skill_cache.store_output("sess-fb-aaa", "fallback-skill", body, {
      source_path: "/original/fallback/SKILL.md",
    });
    expect(meta_a).not.toBeNull();
    skill_cache.write_sidecar(meta_a!);

    const meta_b = skill_cache.store_output("sess-fb-bbb", "fallback-skill", body);
    expect(meta_b).not.toBeNull();
    expect(meta_b!.source_path).toBe("/original/fallback/SKILL.md");
  });

  it("test_dedup_scan_skips_entry_with_missing_body_file", () => {
    const body = "# Evicted skill\n\n" + "evict content. ".repeat(200);
    const sha = skill_cache.content_hash(body);

    const meta_a = skill_cache.store_output("sess-evict-aaa", "evict-skill", body);
    expect(meta_a).not.toBeNull();
    skill_cache.write_sidecar(meta_a!);

    // Manually remove the body file to simulate eviction.
    const skills_dir = skillsDir();
    const body_file = path.join(skills_dir, `${meta_a!.output_id}.txt`);
    if (fs.existsSync(body_file)) {
      fs.unlinkSync(body_file);
    }
    const gz_file = path.join(skills_dir, `${meta_a!.output_id}.gz`);
    if (fs.existsSync(gz_file)) {
      fs.unlinkSync(gz_file);
    }

    const result = skill_cache.find_cross_session_entry("evict-skill", sha);
    expect(result).toBeNull();
  });

  it("test_dedup_same_session_same_body_idempotent", () => {
    const body = "# Idempotent skill\n\n" + "idem content. ".repeat(200);

    const meta_1 = skill_cache.store_output("sess-idem", "idem-skill", body);
    expect(meta_1).not.toBeNull();
    skill_cache.write_sidecar(meta_1!);

    const meta_2 = skill_cache.store_output("sess-idem", "idem-skill", body);
    expect(meta_2).not.toBeNull();
    expect(meta_1!.output_id).toBe(meta_2!.output_id);
  });

  // ------------------------------------------------------------------
  // Log output for dedup path
  // ------------------------------------------------------------------

  it("test_dedup_hit_logs_debug_message", () => {
    const body = "# Log test skill\n\n" + "log content. ".repeat(200);

    const meta_a = skill_cache.store_output("sess-log-aaa", "log-skill", body);
    expect(meta_a).not.toBeNull();
    skill_cache.write_sidecar(meta_a!);

    const getLogs = captureLogs();
    skill_cache.store_output("sess-log-bbb", "log-skill", body);
    const logs = getLogs();

    expect(logs.includes("cross-session dedup")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Improvement 2: Minimal-body guard in post_skill
// ---------------------------------------------------------------------------

describe("TestPostSkillMinimalBodyGuard", () => {
  function _fire(session_id: string, skill_name: string, body: string): Record<string, unknown> {
    return fire_skill_hook(session_id, skill_name, body);
  }

  it("test_stub_response_not_cached", () => {
    const resp = _fire("sess-stub", "ralph", "Skill loaded.");
    expect(resp["continue"]).toBe(true);

    const skills_dir = skillsDir();
    const txt_files = fs.existsSync(skills_dir) ? globExt(skills_dir, ".txt") : [];
    const gz_files = fs.existsSync(skills_dir) ? globExt(skills_dir, ".gz") : [];
    expect(txt_files.length + gz_files.length).toBe(0);
  });

  it("test_stub_response_logs_debug", () => {
    const getLogs = captureLogs();
    const resp = _fire("sess-stub-log", "improve", "Loaded.");

    expect(resp["continue"]).toBe(true);
    const logs = getLogs();
    expect(logs.includes("too small") || logs.includes("threshold")).toBe(true);
  });

  it("test_empty_body_not_cached", () => {
    const resp = _fire("sess-empty", "ralph", "");
    expect(resp["continue"]).toBe(true);

    const skills_dir = skillsDir();
    const txt_files = fs.existsSync(skills_dir) ? globExt(skills_dir, ".txt") : [];
    expect(txt_files.length).toBe(0);
  });

  it("test_minimal_confirmation_variants_not_cached", () => {
    const stub_variants = ["Skill loaded.", "OK", "Done.", "✓", "Loaded"];
    for (const variant of stub_variants) {
      const resp = _fire("sess-variant", "some-skill", variant);
      expect(resp["continue"]).toBe(true);
    }

    const skills_dir = skillsDir();
    const txt_files = fs.existsSync(skills_dir) ? globExt(skills_dir, ".txt") : [];
    expect(txt_files.length).toBe(0);
  });

  it("test_real_body_above_threshold_is_cached", () => {
    const real_body = "# Ralph skill\n\n" + "rule directive here. ".repeat(100);
    expect(Buffer.from(real_body, "utf8").length).toBeGreaterThan(256);

    const resp = _fire("sess-real", "ralph", real_body);
    expect(resp["continue"]).toBe(true);

    const skills_dir = skillsDir();
    const txt_files = globExt(skills_dir, ".txt");
    expect(txt_files.length).toBeGreaterThanOrEqual(1);
  });

  it("test_boundary_body_at_min_bytes_not_cached", () => {
    const short_body = "x".repeat(_SKILL_CACHE_MIN_BYTES - 1);
    expect(Buffer.from(short_body, "utf8").length).toBeLessThan(_SKILL_CACHE_MIN_BYTES);

    const resp = _fire("sess-boundary", "boundary-skill", short_body);
    expect(resp["continue"]).toBe(true);

    const skills_dir = skillsDir();
    const txt_files = fs.existsSync(skills_dir) ? globExt(skills_dir, ".txt") : [];
    expect(txt_files.length).toBe(0);
  });

  it("test_body_at_exactly_min_bytes_is_cached", () => {
    const at_threshold = "y".repeat(_SKILL_CACHE_MIN_BYTES);
    expect(Buffer.from(at_threshold, "utf8").length).toBe(_SKILL_CACHE_MIN_BYTES);

    const resp = _fire("sess-at-threshold", "at-threshold-skill", at_threshold);
    expect(resp["continue"]).toBe(true);

    const skills_dir = skillsDir();
    const txt_files = globExt(skills_dir, ".txt");
    expect(txt_files.length).toBeGreaterThanOrEqual(1);
  });
});
