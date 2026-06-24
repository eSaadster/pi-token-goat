/**
 * Tests for the batch-J cache-cleaning CLI commands (cli_clean.ts):
 * clean-cache, prune-cache, clean.
 *
 * Port of tests/test_phase11_items.py (the 4 clean-cache Item-12 tests) +
 * tests/test_cli_prune_cache.py (9) + tests/test_cli_clean.py (10).
 *
 * Path handling: unlike the Python tests (which `monkeypatch.setattr(
 * "token_goat.paths.data_dir", …)` / `image_cache_dir` / `session_cache_path`
 * to redirect to tmp_path), the TS port relies on tests/setup.ts's per-test
 * `setDataDirOverride`. `dataDir()` returns that override directly (no
 * caching), and `imageCacheDir()` / `sessionsDir()` / `sessionCachePath()` /
 * `cache_common.get_cache_dir()` ALL key off `dataDir()` — so they resolve
 * under the isolated tmp dir automatically. Tests therefore just seed files
 * under `paths.dataDir()`. The one Python `monkeypatch` that has no override
 * equivalent — `patch.object(worker, "evict_image_cache_if_over_limit", …)` —
 * becomes `vi.spyOn(worker, "evict_image_cache_if_over_limit")` (cli_clean calls
 * it via the `import * as worker` namespace).
 *
 * Mtime: Python `os.utime(f, (t, t))` with `t = time.time() - age*86400` →
 * `fs.utimesSync(f, t, t)` with `t = Date.now()/1000 - age*86400`.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import fs from "node:fs";
import path from "node:path";

import * as paths from "../src/token_goat/paths.js";
import * as worker from "../src/token_goat/worker.js";
import { invoke } from "./_cli_runner.js";

afterEach(() => {
  vi.restoreAllMocks();
});

const DAY = 86400;

/** Set a file's atime+mtime to ageDays in the past (Python os.utime). */
function age(filePath: string, ageDays: number): void {
  const t = Date.now() / 1000 - ageDays * DAY;
  fs.utimesSync(filePath, t, t);
}

/** Create parent/name with fileCount regular files, each ageDays old. */
function fakeCacheDir(parent: string, name: string, fileCount: number, ageDays: number): string {
  const dir = path.join(parent, name);
  fs.mkdirSync(dir, { recursive: true });
  for (let i = 0; i < fileCount; i++) {
    const f = path.join(dir, `file${i}.txt`);
    fs.writeFileSync(f, `content ${i}`);
    age(f, ageDays);
  }
  return dir;
}

/** Create dir/name holding sizeBytes bytes, ageDays old. */
function createCacheFile(dir: string, name: string, sizeBytes: number, ageDays: number): string {
  fs.mkdirSync(dir, { recursive: true });
  const f = path.join(dir, name);
  fs.writeFileSync(f, Buffer.alloc(sizeBytes, 0x78)); // "x" * sizeBytes
  age(f, ageDays);
  return f;
}

// ---------------------------------------------------------------------------
// clean-cache (Item 12)
// ---------------------------------------------------------------------------

describe("TestCleanCacheCli", () => {
  it("no flags exits error", async () => {
    const result = await invoke(["clean-cache"]);
    expect(result.exit_code).toBe(2);
  });

  it("images nonexistent dir reports skipped", async () => {
    // imageCacheDir() = dataDir()/images does not exist (fresh override) → skipped.
    const result = await invoke(["clean-cache", "--images"]);
    expect(result.exit_code).toBe(0);
    expect(result.output.toLowerCase()).toContain("skipped");
  });

  it("images calls eviction", async () => {
    // Seed a real images dir with a dummy file.
    const cacheDir = path.join(paths.dataDir(), "images");
    fs.mkdirSync(cacheDir, { recursive: true });
    fs.writeFileSync(path.join(cacheDir, "img1.webp"), Buffer.alloc(400, 0x78));

    vi.spyOn(worker, "evict_image_cache_if_over_limit").mockReturnValue([1024, 1]);

    const result = await invoke(["clean-cache", "--images"]);
    expect(result.exit_code).toBe(0);
    expect(result.output.toLowerCase()).toContain("evicted");
  });

  it("images json output", async () => {
    const cacheDir = path.join(paths.dataDir(), "images");
    fs.mkdirSync(cacheDir, { recursive: true });
    fs.writeFileSync(path.join(cacheDir, "img1.webp"), Buffer.alloc(500, 0x78));

    vi.spyOn(worker, "evict_image_cache_if_over_limit").mockReturnValue([500, 1]);

    const result = await invoke(["clean-cache", "--images", "--json"]);
    expect(result.exit_code).toBe(0);
    const data = JSON.parse(result.output);
    expect(data.images).toBeDefined();
    expect(data.images.status).toBe("ok");
    expect(data.images.freed_bytes).toBe(500);
  });
});

// ---------------------------------------------------------------------------
// prune-cache
// ---------------------------------------------------------------------------

describe("TestPruneCacheCli", () => {
  it("dry run no deletion", async () => {
    const bashDir = path.join(paths.dataDir(), "bash_outputs");
    const f = createCacheFile(bashDir, "test.txt", 100, 10);

    const result = await invoke(["prune-cache", "--dry-run"]);
    expect(result.exit_code).toBe(0);
    expect(result.output).toContain("would free");
    expect(result.output).toContain("Use without --dry-run to actually delete");
    expect(fs.existsSync(f)).toBe(true);
  });

  it("removes files", async () => {
    const bashDir = path.join(paths.dataDir(), "bash_outputs");
    const webDir = path.join(paths.dataDir(), "web_outputs");
    createCacheFile(bashDir, "test.txt", 100, 10);
    createCacheFile(webDir, "test.txt", 200, 10);

    const result = await invoke(["prune-cache"]);
    expect(result.exit_code).toBe(0);
    expect(result.output).toContain("freed");
    expect(result.output).toContain("Total:");
  });

  it("empty caches shows zero", async () => {
    const result = await invoke(["prune-cache"]);
    expect(result.exit_code).toBe(0);
    // Empty caches report "no cleanup needed" or "skipped".
    expect(
      result.output.includes("skipped") || result.output.includes("no cleanup needed"),
    ).toBe(true);
  });

  it("json output", async () => {
    const bashDir = path.join(paths.dataDir(), "bash_outputs");
    createCacheFile(bashDir, "test.txt", 100, 10);

    const result = await invoke(["prune-cache", "--json"]);
    expect(result.exit_code).toBe(0);
    const data = JSON.parse(result.output);
    expect(data).toHaveProperty("dry_run");
    expect(data).toHaveProperty("total_files_removed");
    expect(data).toHaveProperty("total_bytes_freed");
    expect(data).toHaveProperty("details");
    expect(typeof data.details).toBe("object");
  });

  it("dry run json", async () => {
    const bashDir = path.join(paths.dataDir(), "bash_outputs");
    createCacheFile(bashDir, "test.txt", 100, 10);

    const result = await invoke(["prune-cache", "--dry-run", "--json"]);
    expect(result.exit_code).toBe(0);
    const data = JSON.parse(result.output);
    expect(data.dry_run).toBe(true);
  });

  it("removes old sessions but keeps recent", async () => {
    const sessionsDir = path.join(paths.dataDir(), "sessions");
    fs.mkdirSync(sessionsDir, { recursive: true });
    const oldSession = createCacheFile(sessionsDir, "old.json", 50, 10);
    const recent = path.join(sessionsDir, "recent.json");
    fs.writeFileSync(recent, "{}");
    age(recent, 1);

    const result = await invoke(["prune-cache"]);
    expect(result.exit_code).toBe(0);
    expect(fs.existsSync(oldSession)).toBe(false);
    expect(fs.existsSync(recent)).toBe(true);
  });

  it("multiple caches", async () => {
    const bashDir = path.join(paths.dataDir(), "bash_outputs");
    const webDir = path.join(paths.dataDir(), "web_outputs");
    const skillsDir = path.join(paths.dataDir(), "skills");
    createCacheFile(bashDir, "bash.txt", 100, 10);
    createCacheFile(webDir, "web.txt", 200, 10);
    createCacheFile(skillsDir, "skill.txt", 50, 10);

    const result = await invoke(["prune-cache"]);
    expect(result.exit_code).toBe(0);
    expect(result.output).toContain("bash_outputs");
    expect(result.output).toContain("web_outputs");
    expect(result.output).toContain("skills");
    expect(result.output).toContain("Total:");
  });

  it("summary format has numbers", async () => {
    const bashDir = path.join(paths.dataDir(), "bash_outputs");
    createCacheFile(bashDir, "test.txt", 1024, 10);

    const result = await invoke(["prune-cache"]);
    expect(result.exit_code).toBe(0);
    expect(result.output).toContain("Total:");
    expect(/\d/.test(result.output)).toBe(true);
  });

  it("nonexistent image/session dir skipped gracefully", async () => {
    // images + sessions dirs are never created; bash/web/mcp/skills are
    // auto-created (empty) by get_cache_dir's ensureDir. Either way exit 0.
    const result = await invoke(["prune-cache"]);
    expect(result.exit_code).toBe(0);
    expect(result.output.includes("skipped") || result.output.includes("Total:")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// clean
// ---------------------------------------------------------------------------

describe("TestCleanCli", () => {
  it("requires at least one flag", async () => {
    const result = await invoke(["clean"]);
    expect(result.exit_code).toBe(2);
  });

  it("images dry run", async () => {
    const cache = fakeCacheDir(paths.dataDir(), "images", 3, 10);

    const result = await invoke(["clean", "--images", "--dry-run"]);
    expect(result.exit_code).toBe(0);
    expect(result.output).toContain("[dry run]");
    expect(result.output).toContain("3 file(s)");
    expect(result.output).toContain("images");
    // Files should still exist after dry run.
    expect(fs.readdirSync(cache).length).toBe(3);
  });

  it("images deletes files", async () => {
    const cache = fakeCacheDir(paths.dataDir(), "images", 3, 10);

    const result = await invoke(["clean", "--images"]);
    expect(result.exit_code).toBe(0);
    expect(result.output).not.toContain("[dry run]");
    expect(result.output).toContain("3 file(s)");
    expect(fs.readdirSync(cache).length).toBe(0);
  });

  it("bash deletes files", async () => {
    const cache = fakeCacheDir(paths.dataDir(), "bash_outputs", 2, 15);

    const result = await invoke(["clean", "--bash"]);
    expect(result.exit_code).toBe(0);
    expect(result.output).toContain("2 file(s)");
    expect(result.output).toContain("bash");
    expect(fs.readdirSync(cache).length).toBe(0);
  });

  it("web deletes files", async () => {
    const cache = fakeCacheDir(paths.dataDir(), "web_outputs", 4, 20);

    const result = await invoke(["clean", "--web"]);
    expect(result.exit_code).toBe(0);
    expect(result.output).toContain("4 file(s)");
    expect(result.output).toContain("web");
    expect(fs.readdirSync(cache).length).toBe(0);
  });

  it("sessions deletes old files", async () => {
    const sessions = path.join(paths.dataDir(), "sessions");
    fs.mkdirSync(sessions, { recursive: true });
    for (let i = 0; i < 2; i++) {
      const f = path.join(sessions, `file${i}.json`);
      fs.writeFileSync(f, `content ${i}`);
      age(f, 10);
    }

    const result = await invoke(["clean", "--sessions"]);
    expect(result.exit_code).toBe(0);
    expect(result.output).toContain("2 file(s)");
    expect(result.output).toContain("sessions");
    expect(fs.readdirSync(sessions).length).toBe(0);
  });

  it("sessions skips recent files", async () => {
    const sessions = path.join(paths.dataDir(), "sessions");
    fs.mkdirSync(sessions, { recursive: true });
    const recent = path.join(sessions, "recent.json");
    fs.writeFileSync(recent, "{}");
    age(recent, 1);

    const result = await invoke(["clean", "--sessions", "--older-than", "7"]);
    expect(result.exit_code).toBe(0);
    expect(result.output).toContain("nothing to remove");
    expect(fs.existsSync(recent)).toBe(true);
  });

  it("all flag clears every category", async () => {
    fakeCacheDir(paths.dataDir(), "images", 1, 10);
    fakeCacheDir(paths.dataDir(), "bash_outputs", 1, 10);
    fakeCacheDir(paths.dataDir(), "web_outputs", 1, 10);
    const sessions = path.join(paths.dataDir(), "sessions");
    fs.mkdirSync(sessions, { recursive: true });
    const sf = path.join(sessions, "s.json");
    fs.writeFileSync(sf, "{}");
    age(sf, 10);

    const result = await invoke(["clean", "--all"]);
    expect(result.exit_code).toBe(0);
    expect(result.output).toContain("images");
    expect(result.output).toContain("bash");
    expect(result.output).toContain("web");
    expect(result.output).toContain("sessions");
  });

  it("missing dir reports skipped", async () => {
    // images dir does not exist (fresh override); --images → skipped.
    const result = await invoke(["clean", "--images"]);
    expect(result.exit_code).toBe(0);
    expect(result.output).toContain("skipped");
  });

  it("older than respected", async () => {
    const cache = path.join(paths.dataDir(), "bash_outputs");
    fs.mkdirSync(cache, { recursive: true });
    const oldF = path.join(cache, "old.txt");
    const newF = path.join(cache, "new.txt");
    fs.writeFileSync(oldF, "old content");
    fs.writeFileSync(newF, "new content");
    age(oldF, 30);
    age(newF, 2);

    const result = await invoke(["clean", "--bash", "--older-than", "7"]);
    expect(result.exit_code).toBe(0);
    expect(result.output).toContain("1 file(s)");
    expect(fs.existsSync(oldF)).toBe(false);
    expect(fs.existsSync(newF)).toBe(true);
  });
});
