/**
 * cache-cleaning command implementations — the TS port of cli.py's batch J
 * (3 commands): clean-cache, prune-cache, clean.
 *
 * Faithful 1:1 port of cli.py command bodies:
 *   - cmd_clean_cache  (cli.py:7558)
 *   - cmd_prune_cache  (cli.py:7626)
 *   - cmd_clean        (cli.py:8400)
 *
 * Output seam: Python `typer.echo` / `raise typer.Exit` / `_error` route through
 * cli_common.ts (`_echo` / `CliExit` / `_error`), identical to the other cli_
 * modules. JSON dumps use `json.dumps(ensure_ascii=False, separators=(",",":"))`
 * → bare `JSON.stringify` (the batch-D ensure_ascii=False convention).
 *
 * Spy-ability gotcha: every paths / cache / worker fn the tests `vi.spyOn`
 * (imageCacheDir / dataDir / sessionCachePath / evict_* / evict_old_entries) is
 * called via the `import * as` namespace — the ESM live-binding analogue of
 * Python `monkeypatch.setattr(paths, "image_cache_dir", …)` / `patch.object(
 * worker, "evict_image_cache_if_over_limit", …)`. cache_common.get_cache_dir
 * also resolves through the shared paths namespace, so a `vi.spyOn(paths,
 * "dataDir")` propagates into get_cache_dir too.
 *
 * Time gotcha: Python `time.time()` → `Date.now() / 1000` (the worker.ts `_now`
 * convention). The clean/prune tests set file mtimes to the past and rely on
 * real wall-clock time for the cutoff, so no clock mock is needed.
 *
 * Thousands separator: Python `f"{n:,}"` → `_comma(n)` (used in clean-cache and
 * prune-cache human output).
 */
import * as fs from "node:fs";
import * as path from "node:path";

import * as bash_cache from "./bash_cache.js";
import * as cache_common from "./cache_common.js";
import * as mcp_cache from "./mcp_cache.js";
import * as paths from "./paths.js";
import * as skill_cache from "./skill_cache.js";
import * as web_cache from "./web_cache.js";
import * as worker from "./worker.js";
import { CliExit, _echo, _error } from "./cli_common.js";

/** Insert thousands separators — Python `f"{n:,}"` for a non-negative integer. */
function _comma(n: number): string {
  return String(Math.trunc(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

/** Python `f"{x:.1f}"` — one decimal place. */
function _fixed1(x: number): string {
  return x.toFixed(1);
}

/** Total byte size of the regular (non-symlink) files in *dir* (0 if absent). */
function _dirFileBytes(dir: string): number {
  let total = 0;
  for (const name of fs.readdirSync(dir)) {
    const fp = path.join(dir, name);
    const st = fs.lstatSync(fp);
    if (st.isFile() && !st.isSymbolicLink()) total += st.size;
  }
  return total;
}

/**
 * Prune on-disk caches to their configured floor. Port of cli.py
 * `cmd_clean_cache` (cli.py:7558). Currently only `--images` is supported; at
 * least one target flag is required (exit 2 otherwise, matching Python).
 */
export function clean_cache(args: { images: boolean; json_output: boolean }): void {
  const { images, json_output } = args;

  if (!images) {
    _error("specify at least one cache target: --images");
    throw new CliExit(2);
  }

  const results: Record<string, Record<string, unknown>> = {};

  if (images) {
    try {
      const cacheDir = paths.imageCacheDir();
      if (!fs.existsSync(cacheDir)) {
        results["images"] = { status: "skipped", reason: "cache dir does not exist" };
      } else {
        // Gather current size before eviction.
        const beforeBytes = _dirFileBytes(cacheDir);
        const [bytesFreed, filesEvicted] = worker.evict_image_cache_if_over_limit();
        const afterBytes = beforeBytes - bytesFreed;
        results["images"] = {
          status: "ok",
          evicted_files: filesEvicted,
          before_bytes: beforeBytes,
          after_bytes: afterBytes,
          freed_bytes: bytesFreed,
        };
      }
    } catch (exc) {
      results["images"] = { status: "error", error: String(exc) };
    }
  }

  if (json_output) {
    _echo(JSON.stringify(results));
    return;
  }

  for (const [target, info] of Object.entries(results)) {
    const status = String(info["status"] ?? "?");
    if (status === "ok") {
      const freed = Number(info["freed_bytes"] ?? 0);
      const evictedCount = info["evicted_files"] ?? 0;
      const after = Number(info["after_bytes"] ?? 0);
      _echo(
        `  ${target}: evicted ${evictedCount} file(s), freed ${_comma(freed)} bytes  (cache now ${_comma(after)} bytes)`,
      );
    } else if (status === "skipped") {
      _echo(`  ${target}: skipped — ${info["reason"] ?? ""}`);
    } else {
      _echo(`  ${target}: ERROR — ${info["error"] ?? "unknown"}`);
    }
  }
}

/** Size + file count for a cache directory (port of prune-cache's get_cache_stats). */
function _getCacheStats(
  cacheDir: string,
): { exists: boolean; size_bytes: number; file_count: number } {
  if (!fs.existsSync(cacheDir)) {
    return { exists: false, size_bytes: 0, file_count: 0 };
  }
  try {
    let size = 0;
    let count = 0;
    for (const name of fs.readdirSync(cacheDir)) {
      const fp = path.join(cacheDir, name);
      const st = fs.lstatSync(fp);
      if (st.isFile() && !st.isSymbolicLink()) {
        size += st.size;
        count += 1;
      }
    }
    return { exists: true, size_bytes: size, file_count: count };
  } catch {
    return { exists: true, size_bytes: 0, file_count: 0 };
  }
}

/**
 * Manually trigger cache eviction across all cache directories. Port of cli.py
 * `cmd_prune_cache` (cli.py:7626). Prunes images/, bash_outputs/, web_outputs/,
 * mcp_outputs/, skills/, and session files (>7 days). `--dry-run` reports
 * without deleting.
 */
export function prune_cache(args: { dry_run: boolean; json_output: boolean }): void {
  const { dry_run, json_output } = args;

  const results: Record<string, Record<string, unknown>> = {};
  let totalFreedBytes = 0;
  let totalFiles = 0;

  const pruneEvictable = (
    cacheName: string,
    evict: () => number,
    cacheDir: string,
  ): void => {
    try {
      const before = _getCacheStats(cacheDir);
      if (before.exists) {
        const removed = dry_run ? 0 : evict();
        const after = dry_run ? before : _getCacheStats(cacheDir);
        const freed = before.size_bytes - after.size_bytes;
        results[cacheName] = {
          status: "ok",
          files_removed: removed,
          bytes_freed: freed,
        };
        totalFreedBytes += freed;
        totalFiles += removed;
      } else {
        results[cacheName] = { status: "skipped", reason: "cache dir does not exist" };
      }
    } catch (exc) {
      results[cacheName] = { status: "error", error: String(exc) };
    }
  };

  // Prune bash_outputs / web_outputs / mcp_outputs / skills.
  pruneEvictable("bash_outputs", () => bash_cache.evict_old_entries(), cache_common.get_cache_dir("bash_outputs"));
  pruneEvictable("web_outputs", () => web_cache.evict_old_entries(), cache_common.get_cache_dir("web_outputs"));
  pruneEvictable("mcp_outputs", () => mcp_cache.evict_old_entries(), cache_common.get_cache_dir("mcp_outputs"));
  pruneEvictable("skills", () => skill_cache.evict_old_entries(), cache_common.get_cache_dir("skills"));

  // Prune images.
  try {
    const cacheDir = paths.imageCacheDir();
    const before = _getCacheStats(cacheDir);
    if (before.exists) {
      let freed: number;
      let removed: number;
      if (dry_run) {
        removed = 0;
        freed = 0;
      } else {
        [freed, removed] = worker.evict_image_cache_if_over_limit();
      }
      results["images"] = {
        status: "ok",
        files_removed: removed,
        bytes_freed: freed,
      };
      totalFreedBytes += freed;
      totalFiles += removed;
    } else {
      results["images"] = { status: "skipped", reason: "cache dir does not exist" };
    }
  } catch (exc) {
    results["images"] = { status: "error", error: String(exc) };
  }

  // Clean old session files (>7 days).
  try {
    const sessionsDir = path.dirname(paths.sessionCachePath("dummy"));
    if (fs.existsSync(sessionsDir)) {
      const now = Date.now() / 1000;
      let removed = 0;
      let freed = 0;
      const sevenDaysSecs = 7 * 24 * 3600;
      for (const name of fs.readdirSync(sessionsDir)) {
        if (!name.endsWith(".json")) continue;
        const fp = path.join(sessionsDir, name);
        const st = fs.lstatSync(fp);
        if (!(st.isFile() && !st.isSymbolicLink())) continue;
        try {
          const mtime = fs.statSync(fp).mtimeMs / 1000;
          if (now - mtime > sevenDaysSecs) {
            const size = fs.statSync(fp).size;
            if (!dry_run) {
              fs.unlinkSync(fp);
            }
            removed += 1;
            freed += size;
          }
        } catch {
          continue;
        }
      }
      if (removed > 0) {
        results["sessions"] = {
          status: "ok",
          files_removed: removed,
          bytes_freed: freed,
        };
        totalFreedBytes += freed;
        totalFiles += removed;
      } else {
        results["sessions"] = { status: "ok", files_removed: 0, bytes_freed: 0 };
      }
    } else {
      results["sessions"] = { status: "skipped", reason: "sessions dir does not exist" };
    }
  } catch (exc) {
    results["sessions"] = { status: "error", error: String(exc) };
  }

  if (json_output) {
    const output = {
      dry_run: dry_run,
      total_files_removed: totalFiles,
      total_bytes_freed: totalFreedBytes,
      details: results,
    };
    _echo(JSON.stringify(output));
    return;
  }

  // Text output.
  const actionVerb = dry_run ? "would free" : "freed";
  for (const cacheName of ["bash_outputs", "web_outputs", "mcp_outputs", "skills", "images", "sessions"]) {
    const info = (results[cacheName] ?? {}) as Record<string, unknown>;
    const status = String(info["status"] ?? "?");
    if (status === "ok") {
      const freed = Number(info["bytes_freed"] ?? 0);
      const removed = Number(info["files_removed"] ?? 0);
      if (freed > 0 || removed > 0) {
        _echo(
          `${cacheName}: ${actionVerb} ${_comma(freed)} bytes (${removed} file${removed !== 1 ? "s" : ""})`,
        );
      } else {
        _echo(`${cacheName}: no cleanup needed`);
      }
    } else if (status === "skipped") {
      _echo(`${cacheName}: skipped — ${info["reason"] ?? ""}`);
    } else {
      _echo(`${cacheName}: ERROR — ${info["error"] ?? "unknown"}`);
    }
  }

  _echo("");
  _echo(
    `Total: ${actionVerb} ${_comma(totalFreedBytes)} bytes (${totalFiles} file${totalFiles !== 1 ? "s" : ""})`,
  );
  if (dry_run) {
    _echo("(Use without --dry-run to actually delete)");
  }
}

/**
 * Clear caches to free disk space. Port of cli.py `cmd_clean` (cli.py:8400).
 * Specify one or more target flags or `--all`; `--dry-run` previews; the
 * `--older-than DAYS` mtime filter applies to all categories (default 7 days).
 */
export function clean(args: {
  images: boolean;
  bash: boolean;
  web: boolean;
  sessions: boolean;
  all: boolean;
  dry_run: boolean;
  older_than: number;
}): void {
  let { images, bash, web, sessions, all: allCaches, dry_run, older_than } = args;

  if (allCaches) {
    images = bash = web = sessions = true;
  }

  if (![images, bash, web, sessions].some(Boolean)) {
    _error("specify at least one target: --images, --bash, --web, --sessions, or --all");
    throw new CliExit(2);
  }

  const prefix = dry_run ? "[dry run] " : "";
  const cutoff = Date.now() / 1000 - older_than * 86400;

  const clearDir = (cacheDir: string, label: string): void => {
    if (!fs.existsSync(cacheDir)) {
      _echo(`${prefix}skipped — ${label} cache dir does not exist`);
      return;
    }
    const files: string[] = [];
    for (const name of fs.readdirSync(cacheDir)) {
      const fp = path.join(cacheDir, name);
      const st = fs.lstatSync(fp);
      if (st.isFile() && !st.isSymbolicLink()) files.push(fp);
    }
    const eligible = files.filter((f) => fs.statSync(f).mtimeMs / 1000 < cutoff);
    const totalBytes = eligible.reduce((sum, f) => sum + fs.statSync(f).size, 0);
    const mb = totalBytes / (1024 * 1024);
    if (eligible.length === 0) {
      _echo(`${prefix}nothing to remove — ${label} (0 files older than ${older_than}d)`);
      return;
    }
    if (!dry_run) {
      for (const f of eligible) {
        try {
          fs.unlinkSync(f);
        } catch {
          // contextlib.suppress(OSError) — missing_ok equivalent.
        }
      }
    }
    _echo(`${prefix}cleared ${eligible.length} file(s) (${_fixed1(mb)} MB) — ${label}`);
  };

  if (images) {
    clearDir(paths.imageCacheDir(), "images");
  }
  if (bash) {
    clearDir(path.join(paths.dataDir(), "bash_outputs"), "bash");
  }
  if (web) {
    clearDir(path.join(paths.dataDir(), "web_outputs"), "web");
  }
  if (sessions) {
    const sessDir = paths.sessionsDir();
    if (!fs.existsSync(sessDir)) {
      _echo(`${prefix}skipped — sessions dir does not exist`);
    } else {
      const files: string[] = [];
      for (const name of fs.readdirSync(sessDir)) {
        if (!name.endsWith(".json")) continue;
        const fp = path.join(sessDir, name);
        const st = fs.lstatSync(fp);
        if (st.isFile() && !st.isSymbolicLink() && fs.statSync(fp).mtimeMs / 1000 < cutoff) {
          files.push(fp);
        }
      }
      const totalBytes = files.reduce((sum, f) => sum + fs.statSync(f).size, 0);
      const mb = totalBytes / (1024 * 1024);
      if (files.length === 0) {
        _echo(`${prefix}nothing to remove — sessions (0 files older than ${older_than}d)`);
      } else {
        if (!dry_run) {
          for (const f of files) {
            try {
              fs.unlinkSync(f);
            } catch {
              // contextlib.suppress(OSError).
            }
          }
        }
        _echo(`${prefix}cleared ${files.length} file(s) (${_fixed1(mb)} MB) — sessions`);
      }
    }
  }
}
