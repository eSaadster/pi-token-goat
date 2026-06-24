/**
 * Tests for worker dirty-queue skill-cache invalidation and Windows MAX_PATH guard.
 *
 * Faithful TS port of tests/test_skill_worker_invalidation.py.
 *
 * Covers:
 * 1. skill_cache.invalidate_for_path — removes body + sidecar + compact for a given path
 * 2. worker._invalidate_skill_cache_entries — only fires for skill paths in queue entries
 * 3. cache_common.safe_join_output_id — rejects paths >= 260 chars on Windows
 *
 * Porting notes:
 *  - tmp_data_dir fixture -> handled by tests/setup.ts (per-test tmp data dir).
 *    The on-disk skills cache dir is obtained via cache_common.get_cache_dir("skills"),
 *    the TS equivalent of `tmp_data_dir / "skills"`.
 *  - worker.ts is ported: every case in TestInvalidateSkillCacheEntries drives
 *    the real worker (worker._invalidate_skill_cache_entries) and spies on
 *    skill_cache.invalidate_for_path (called through the worker's module
 *    namespace, so the spy is observed — the TS analogue of patch.object).
 *  - test_rejects_overly_long_path_on_windows / test_non_windows_no_max_path_check:
 *    Python monkeypatches _cc.sys.platform; the TS guard keys off
 *    process.platform === "win32", so we override process.platform via
 *    Object.defineProperty for the duration of the call and restore it after.
 *    The TS CacheDirFn returns a plain string (not a duck-typed Path), so the
 *    fake-Path machinery collapses to passing a long base-dir string whose
 *    str() + sep + output_id + ".txt" exceeds 260 chars.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import * as skill_cache from "../src/token_goat/skill_cache.js";
import * as cache_common from "../src/token_goat/cache_common.js";
import * as worker from "../src/token_goat/worker.js";

const skillsDir = (): string => cache_common.get_cache_dir("skills");

// ---------------------------------------------------------------------------
// skill_cache.invalidate_for_path
// ---------------------------------------------------------------------------

describe("TestInvalidateForPath", () => {
  it("test_no_match_returns_zero", () => {
    // Returns 0 when no cached entry has the given source_path.
    skill_cache.store_output("sess1", "ralph", "body ".repeat(100), {
      source_path: "/some/file.md",
    });
    const n = skill_cache.invalidate_for_path("/nonexistent/other.md");
    expect(n).toBe(0);
  });

  it("test_empty_path_returns_zero", () => {
    const n = skill_cache.invalidate_for_path("");
    expect(n).toBe(0);
  });

  it("test_removes_matching_body_and_sidecar", () => {
    // Removes the body .txt and .json sidecar for a matching source_path.
    const source = "/skills/ralph/SKILL.md";
    const meta = skill_cache.store_output("sess2", "ralph", "rule. ".repeat(200), {
      source_path: source,
    });
    expect(meta).not.toBeNull();
    skill_cache.write_sidecar(meta!);

    // Verify files exist before invalidation
    const cache_dir = skillsDir();
    expect(fs.existsSync(path.join(cache_dir, `${meta!.output_id}.txt`))).toBe(true);
    expect(fs.existsSync(path.join(cache_dir, `${meta!.output_id}.json`))).toBe(true);

    const n = skill_cache.invalidate_for_path(source);
    expect(n).toBe(1);

    // Both body and sidecar should be gone
    expect(fs.existsSync(path.join(cache_dir, `${meta!.output_id}.txt`))).toBe(false);
    expect(fs.existsSync(path.join(cache_dir, `${meta!.output_id}.json`))).toBe(false);
  });

  it("test_removes_matching_gz_body", () => {
    // Removes the .gz companion body file when it is present alongside the .txt stub.
    const source = "/skills/bigskill/SKILL.md";
    const meta = skill_cache.store_output("sess3", "bigskill", "body ".repeat(200), {
      source_path: source,
    });
    expect(meta).not.toBeNull();
    skill_cache.write_sidecar(meta!);

    const cache_dir = skillsDir();
    const txt = path.join(cache_dir, `${meta!.output_id}.txt`);
    expect(fs.existsSync(txt)).toBe(true);

    // Manually create a .gz sibling to simulate a prior compressed-storage write.
    const gz = path.join(cache_dir, `${meta!.output_id}.gz`);
    fs.writeFileSync(gz, Buffer.from("\x1f\x8b fake compressed data", "binary"));

    const n = skill_cache.invalidate_for_path(source);
    expect(n).toBe(1);
    expect(fs.existsSync(txt)).toBe(false);
    expect(fs.existsSync(gz)).toBe(false);
  });

  it("test_path_normalisation_backslash", () => {
    // Windows backslash paths are normalised and match POSIX equivalents.
    const source_stored = "/skills/ralph/SKILL.md";
    const meta = skill_cache.store_output("sess4", "ralph", "content ".repeat(100), {
      source_path: source_stored,
    });
    expect(meta).not.toBeNull();
    skill_cache.write_sidecar(meta!);

    // Use a differently-formatted but equivalent path.
    // On Windows Path.resolve() normalises; on POSIX both are the same.
    const n = skill_cache.invalidate_for_path(source_stored);
    expect(n).toBe(1);
  });

  it("test_multiple_entries_same_path", () => {
    // All entries matching the source_path are removed (not just the first).
    const source = "/skills/improve/SKILL.md";
    const meta_a = skill_cache.store_output("sess5a", "improve", "v1 body ".repeat(100), {
      source_path: source,
    });
    const meta_b = skill_cache.store_output("sess5b", "improve", "v2 body ".repeat(100), {
      source_path: source,
    });
    expect(meta_a).not.toBeNull();
    expect(meta_b).not.toBeNull();
    skill_cache.write_sidecar(meta_a!);
    skill_cache.write_sidecar(meta_b!);

    const n = skill_cache.invalidate_for_path(source);
    expect(n).toBe(2);
  });

  it("test_compact_removed_for_invalidated_skill", () => {
    // Compact files for the skill are also removed so stale compacts are not served.
    const source = "/skills/ralph/SKILL.md";
    const meta = skill_cache.store_output("sess6", "ralph", "body ".repeat(200), {
      source_path: source,
    });
    expect(meta).not.toBeNull();
    skill_cache.write_sidecar(meta!);
    // Store a compact for this session+skill
    skill_cache.store_compact("sess6", "ralph", "compact content");
    const cache_dir = skillsDir();
    // Verify the compact file exists
    const compact_files_before = fs
      .readdirSync(cache_dir)
      .filter((f) => f.endsWith("-compact"));
    expect(compact_files_before.length).toBeGreaterThanOrEqual(1);

    const n = skill_cache.invalidate_for_path(source);
    expect(n).toBeGreaterThanOrEqual(1);

    const compact_files_after = fs
      .readdirSync(cache_dir)
      .filter((f) => f.endsWith("-compact"));
    expect(compact_files_after.length).toBe(0);
  });

  it("test_compact_removal_with_namespaced_skill", () => {
    // Compact removal works for plugin:skill namespaced names (safe name has 'n' suffix).
    const source = "/plugins/core/skills/improve/SKILL.md";
    const meta = skill_cache.store_output("sess7", "plugin:improve", "body ".repeat(200), {
      source_path: source,
    });
    expect(meta).not.toBeNull();
    skill_cache.write_sidecar(meta!);
    skill_cache.store_compact("sess7", "plugin:improve", "compact for plugin improve");
    const cache_dir = skillsDir();
    const compact_before = fs.readdirSync(cache_dir).filter((f) => f.endsWith("-compact"));
    expect(compact_before.length).toBeGreaterThan(0); // compact file should exist before invalidation

    const n = skill_cache.invalidate_for_path(source);
    expect(n).toBe(1);
    const compact_after = fs.readdirSync(cache_dir).filter((f) => f.endsWith("-compact"));
    expect(compact_after.length).toBe(0);
  });

  it("test_compact_removal_with_mixed_case_skill", () => {
    // Compact removal works for mixed-case namespaced names (regression).
    //
    // _compact_file_id lowercases the safe-name segment, so a skill named
    // "userSettings:brainstorming" writes its compact as
    // "...-usersettings_brainstormingn-compact". invalidate_for_path previously
    // built the purge suffix from the un-lowercased meta.skill_name, so the
    // suffix ("...-userSettings_brainstormingn-compact") never matched the
    // on-disk file and the stale compact survived the edit. Fails pre-fix
    // (compact_after == 1), passes post-fix (compact_after == 0).
    const source = "/plugins/core/skills/brainstorming/SKILL.md";
    const meta = skill_cache.store_output(
      "sess_mc",
      "userSettings:brainstorming",
      "body ".repeat(200),
      { source_path: source },
    );
    expect(meta).not.toBeNull();
    skill_cache.write_sidecar(meta!);
    skill_cache.store_compact("sess_mc", "userSettings:brainstorming", "compact body");
    const cache_dir = skillsDir();
    const compact_before = fs.readdirSync(cache_dir).filter((f) => f.endsWith("-compact"));
    expect(compact_before.length).toBeGreaterThan(0); // compact file should exist before invalidation

    const n = skill_cache.invalidate_for_path(source);
    expect(n).toBe(1);
    const compact_after = fs.readdirSync(cache_dir).filter((f) => f.endsWith("-compact"));
    expect(compact_after.length).toBe(0); // stale compact for mixed-case skill was not purged
  });

  it("test_other_skills_not_removed", () => {
    // Only entries matching the given path are removed; others are untouched.
    const source_a = "/skills/ralph/SKILL.md";
    const source_b = "/skills/superman/SKILL.md";
    const meta_a = skill_cache.store_output("sess8", "ralph", "ralph body ".repeat(100), {
      source_path: source_a,
    });
    const meta_b = skill_cache.store_output("sess8", "superman", "superman ".repeat(100), {
      source_path: source_b,
    });
    expect(meta_a).not.toBeNull();
    expect(meta_b).not.toBeNull();
    skill_cache.write_sidecar(meta_a!);
    skill_cache.write_sidecar(meta_b!);

    const n = skill_cache.invalidate_for_path(source_a);
    expect(n).toBe(1);

    // superman entry should still be loadable
    const loaded_b = skill_cache.load_output(meta_b!.output_id);
    expect(loaded_b).not.toBeNull();
  });

  it("test_returns_zero_no_source_path", () => {
    // Entries with no source_path are never matched (source_path is empty).
    const meta = skill_cache.store_output("sess9", "ralph", "body ".repeat(100)); // no source_path
    expect(meta).not.toBeNull();
    skill_cache.write_sidecar(meta!);
    const n = skill_cache.invalidate_for_path("/skills/ralph/SKILL.md");
    expect(n).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// worker._invalidate_skill_cache_entries
// ---------------------------------------------------------------------------

describe("TestInvalidateSkillCacheEntries", () => {
  // worker.ts is ported; every case here drives the real
  // worker._invalidate_skill_cache_entries and spies on
  // skill_cache.invalidate_for_path (which the worker calls through its module
  // namespace, so the spy is observed — the TS analogue of patch.object).

  function makeEntry(p: string, root = "/project"): worker.DirtyQueueEntry {
    return { path: p, project_root: root, project_hash: "a".repeat(40) };
  }

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("test_non_skill_path_skipped", () => {
    // Regular source files do not trigger skill cache invalidation.
    const calls: string[] = [];
    const spy = vi
      .spyOn(skill_cache, "invalidate_for_path")
      .mockImplementation((p: string) => {
        calls.push(p);
        return 0;
      });
    const entries = [makeEntry("src/mymodule.py")];
    worker._invalidate_skill_cache_entries(entries);
    spy.mockRestore();
    expect(calls).toEqual([]);
  });

  it("test_skill_path_triggers_invalidation", () => {
    // .claude/skills/ in the path triggers invalidate_for_path.
    const calls: string[] = [];
    const spy = vi
      .spyOn(skill_cache, "invalidate_for_path")
      .mockImplementation((p: string) => {
        calls.push(p);
        return 1;
      });
    const entries = [makeEntry(".claude/skills/ralph/SKILL.md", "/home/user")];
    worker._invalidate_skill_cache_entries(entries);
    spy.mockRestore();
    expect(calls.length).toBe(1);
    expect(calls[0]).toContain("SKILL.md");
  });

  it("test_multiple_entries_only_skill_path_triggered", () => {
    // When mixing skill + non-skill entries, only skill paths trigger invalidation.
    const calls: string[] = [];
    const spy = vi
      .spyOn(skill_cache, "invalidate_for_path")
      .mockImplementation((p: string) => {
        calls.push(p);
        return 0;
      });
    const entries = [
      makeEntry("src/parser.py"),
      makeEntry(".claude/skills/improve/SKILL.md"),
      makeEntry("pyproject.toml"),
    ];
    worker._invalidate_skill_cache_entries(entries);
    spy.mockRestore();
    expect(calls.length).toBe(1);
    expect(calls[0]).toContain("improve");
  });

  it("test_empty_entries_no_crash", () => {
    // Empty entry list is handled gracefully.
    worker._invalidate_skill_cache_entries([]); // must not raise
  });

  it("test_malformed_entry_no_crash", () => {
    // Entries missing path/root are handled gracefully.
    const entries: worker.DirtyQueueEntry[] = [{ project_hash: "a".repeat(40) }]; // no 'path' key
    worker._invalidate_skill_cache_entries(entries); // must not raise
  });

  it("test_no_project_root_uses_rel_path", () => {
    // When project_root is absent, falls back to the rel path alone.
    const calls: string[] = [];
    const spy = vi
      .spyOn(skill_cache, "invalidate_for_path")
      .mockImplementation((p: string) => {
        calls.push(p);
        return 0;
      });
    const entries: worker.DirtyQueueEntry[] = [
      { path: ".claude/skills/ralph/SKILL.md", project_hash: "a".repeat(40) },
    ];
    worker._invalidate_skill_cache_entries(entries);
    spy.mockRestore();
    expect(calls.length).toBe(1);
    expect(calls[0]).toBe(".claude/skills/ralph/SKILL.md");
  });
});

// ---------------------------------------------------------------------------
// cache_common.safe_join_output_id — Windows MAX_PATH guard
// ---------------------------------------------------------------------------

describe("TestSafeJoinOutputIdMaxPath", () => {
  /** Build a cache_dir_fn that creates *p* and returns it (mirrors _make_dir_fn). */
  function makeDirFn(p: string): cache_common.CacheDirFn {
    return () => {
      fs.mkdirSync(p, { recursive: true });
      return p;
    };
  }

  // process.platform override helpers (the TS analogue of monkeypatch on
  // _cc.sys.platform). Object.defineProperty lets us flip the read-only prop.
  const realPlatform = Object.getOwnPropertyDescriptor(process, "platform");
  function setPlatform(value: NodeJS.Platform): void {
    Object.defineProperty(process, "platform", { value, configurable: true });
  }
  afterEach(() => {
    if (realPlatform) {
      Object.defineProperty(process, "platform", realPlatform);
    }
  });

  it("test_rejects_overly_long_path_on_windows", () => {
    // Returns None when the constructed path would be >= 260 chars on Windows.
    //
    // The TS guard keys off process.platform === "win32" and computes the
    // candidate length from path.resolve(base) + sep + output_id + ".txt". We
    // force win32 and supply a base dir long enough that the joined .txt path
    // exceeds 260 chars, without needing to create that path on disk.
    const output_id = "a".repeat(40);

    // Build a long base dir whose resolved str + sep + output_id + ".txt" >= 260.
    // Use a deeply nested POSIX-style absolute path: path.resolve keeps it as-is
    // on this (non-Windows) host, so len(base) drives the total length.
    const longBase = "/" + "x".repeat(220) + "/skills";

    setPlatform("win32");
    // Do not create the path on disk (the guard runs before any I/O); return the
    // long base string directly.
    const result = cache_common.safe_join_output_id(output_id, () => longBase, "test_cache");

    const constructed =
      path.resolve(longBase) + path.sep + output_id + ".txt";
    if (constructed.length >= 260) {
      expect(result).toBeNull();
    } else {
      // fake path length < 260; adjust longBase (mirrors pytest.skip branch).
      expect(constructed.length).toBeGreaterThanOrEqual(260);
    }
  });

  it("test_accepts_normal_length_path", () => {
    // Returns a valid path when the constructed path is under 260 chars.
    const tmp_path = fs.mkdtempSync(path.join(os.tmpdir(), "tg-sj-"));
    const cache_dir = path.join(tmp_path, "skills");
    const output_id = "a1b2c3d4e5f6" + "0".repeat(30); // 42 chars, well under limit
    const result = cache_common.safe_join_output_id(
      output_id,
      makeDirFn(cache_dir),
      "test_cache",
    );
    // Should return a valid Path on all platforms
    expect(result).not.toBeNull();
    expect(path.basename(result!)).toBe(`${output_id}.txt`);
  });

  it("test_non_windows_no_max_path_check", () => {
    // On non-Windows platforms, the MAX_PATH check is not applied.
    setPlatform("linux");

    // Use a normal-length path — the guard should not fire on linux.
    const tmp_path = fs.mkdtempSync(path.join(os.tmpdir(), "tg-sj-"));
    const cache_dir = path.join(tmp_path, "skills");
    const output_id = "a".repeat(40);
    const result = cache_common.safe_join_output_id(
      output_id,
      makeDirFn(cache_dir),
      "test_cache",
    );
    // On linux the guard is skipped; a valid path is returned.
    expect(result).not.toBeNull();
  });
});
