/**
 * Background worker daemon: dirty-queue polling, self-healing, periodic cleanup.
 *
 * Faithful TS/Node port of src/token_goat/worker.py (2621 LOC). Owned jointly
 * with worker_daemon.ts — worker_daemon.ts calls ~15 of this module's internals
 * (the _-prefixed functions are exported on purpose so that sibling can reach
 * them via `import * as worker`).
 *
 * Porting notes
 * -------------
 *  - **psutil has no Node twin.** Python uses psutil for pid_exists /
 *    create_time / cmdline / terminate / kill. Node only ships
 *    `process.kill(pid, sig)`:
 *      * psutil.pid_exists(pid)        -> _pidExists(pid): process.kill(pid, 0)
 *        with EPERM treated as "alive" (mirrors db.ts/_pidAlive + the os.kill
 *        signal-0 fallback in worker_daemon._pid_is_alive).
 *      * psutil.Process(pid).create_time() -> _procCreateTime: NO portable
 *        Node API. Returns null by default (== "process gone / unknown"). This
 *        is exactly the psutil-*absent* stub behaviour in the Python file
 *        (`_PsutilShim.Process` raises NoSuchProcess), so every call site that
 *        catches NoSuchProcess already has a correct degraded path.
 *      * psutil.Process(pid).cmdline() -> _procCmdline: NO portable Node API.
 *        Returns null (== "cmdline unreadable") which makes the cmdline checks
 *        fall through *leniently* — precisely what is_worker_alive /
 *        _index_spawn_active / _is_token_goat_worker do on AccessDenied.
 *      * proc.terminate()/kill()/wait() -> _procTerminate/_procKill: SIGTERM /
 *        SIGKILL via process.kill; wait() degrades to a fixed-attempts poll on
 *        _pidExists.
 *    All three process-introspection seams are overridable
 *    (_setProcessIntrospection) so tests can simulate a live/recycled/hung PID
 *    without real subprocesses.
 *  - **subprocess.Popen(detached)** -> child_process.spawn({detached:true,
 *    stdio:[...]}).unref(). The spawn implementation is injectable via
 *    _setSpawnImpl so no test ever forks a real worker/daemon (that would hang
 *    the vitest suite). The TOKEN_GOAT_NO_WORKER_SPAWN env guard is ported
 *    verbatim.
 *  - **parser is NOT ported (Layer 7).** worker calls parser.index_project only.
 *    Reach it through the _setParserModule fail-soft seam: when no parser is
 *    registered, the index/reindex path degrades to a no-op (returns null) and
 *    the index-driving tests defer.
 *  - **threading.Lock (_ENQUEUE_DIRTY_LOCK)** is a no-op in single-threaded
 *    Node — kept as documentation of the cross-thread guard the OS file lock
 *    already covers cross-process. Likewise fcntl.flock / msvcrt.locking: Node
 *    has no stdlib advisory-lock binding, so _dirtyQueueLock degrades to a
 *    best-effort "no OS lock" (lock_acquired=true) — same yield contract.
 *  - **importlib.metadata.version("token-goat")** -> version.__version__
 *    (resolved from package.json once at load).
 *  - **hashlib.sha1** -> node:crypto createHash("sha1").
 *  - **datetime strftime %Y-%m-%d** -> a small local formatter.
 *  - byte sizes via fs.statSync().size; mtime via .mtimeMs / 1000 (float secs).
 *  - Python `dict.fromkeys` insertion-order dedup -> a Map for stable order.
 */
import * as crypto from "node:crypto";
import * as childProcess from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

import type { Database as DatabaseType } from "better-sqlite3";

import * as paths from "./paths.js";
import * as db from "./db.js";
import * as snapshots from "./snapshots.js";
import * as bash_cache from "./bash_cache.js";
import * as config from "./config.js";
import * as web_cache from "./web_cache.js";
import * as git_history from "./git_history.js";
import * as skill_cache from "./skill_cache.js";
import * as parser from "./parser.js";
import { sanitize_log_str } from "./hooks_common.js";
import type { Project } from "./project.js";
import { getLogger, envFloat } from "./util.js";
import { __version__ } from "./version.js";
import { registerReset } from "./reset.js";
// Circular (static `import * as`, function-level USE keeps ESM safe):
//   worker <-> worker_daemon (same agent), worker -> install.
import * as worker_daemon from "./worker_daemon.js";
import * as install from "./install.js";
// Self-import so the daemon loop / worker_daemon's `_worker.<fn>()` calls go
// through the module namespace, keeping vi.spyOn(worker, ...) visible.
import * as self from "./worker.js";

// ===========================================================================
// TypedDicts (worker.py CleanupStats / DirtyQueueEntry / _ProjectBucket)
// ===========================================================================

/** Result of cleanup_on_startup operation (worker.py CleanupStats). */
export interface CleanupStats {
  stale_locks_cleared?: number;
  stale_index_markers_cleared?: number;
  logs_deleted?: number;
  image_bytes_evicted?: number;
  image_files_evicted?: number;
  stats_rows_pruned?: number;
  snapshots_cleared?: number;
  bash_outputs_evicted?: number;
  web_outputs_evicted?: number;
  wal_bytes_reclaimed?: number;
  project_wal_bytes_reclaimed?: number;
  orphaned_projects_removed?: number;
  old_sessions_removed?: number;
  orphaned_state_files_deleted?: number;
  old_sentinels_deleted?: number;
  /** task names that raised during cleanup */
  failures?: string[];
}

/** One line from the dirty queue (written by hooks_cli._enqueue_for_reindex). */
export interface DirtyQueueEntry {
  path?: string;
  project_hash?: string;
  project_root?: string;
  project_marker?: string;
  ts?: number;
}

/** Accumulator used inside _process_dirty_entries to group files by project. */
interface _ProjectBucket {
  rels: Set<string>;
  root: string | null;
  marker: string | null;
}

const _LOG = getLogger("worker");

// ===========================================================================
// Constants (verbatim from worker.py)
// ===========================================================================

/** Heartbeat interval (seconds) */
export const HEARTBEAT_INTERVAL = 30.0;
/** Dirty queue poll interval — baseline cadence when actively draining. */
export const POLL_INTERVAL = 2.0;
/** Maximum poll interval (seconds) when the queue has been empty a long stretch. */
export const POLL_INTERVAL_MAX = 10.0;
/** Consecutive empty drains before adaptive back-off kicks in. */
export const IDLE_BACKOFF_AFTER_EMPTY_DRAINS = 5;
/** Periodic maintenance interval (cleanup tasks). */
export const MAINTENANCE_INTERVAL = 300.0; // 5 min
/** How often to incrementally re-index active projects. */
export const PERIODIC_REINDEX_INTERVAL = 600.0; // 10 min
/** Skip re-indexing any project that has grown beyond this many files. */
export let PERIODIC_REINDEX_MAX_FILES = 2000;
/** Only periodically re-index projects seen within this window. */
export const PERIODIC_REINDEX_ACTIVE_WINDOW = 7 * 24 * 3600.0; // 7 days

/** How many days of granular stats events to keep in global.db before pruning. */
export const STATS_RETENTION_DAYS = 90;

/**
 * Image cache eviction threshold (500 MB).
 *
 * Mutable so eviction tests can lower it (Python monkeypatches the module
 * attribute). An ESM `const` export is read-only across modules, so this is a
 * `let` with a setter seam (_setImageCacheLimit) + registerReset to restore the
 * default. evict_image_cache_if_over_limit reads the live binding directly.
 */
export let IMAGE_CACHE_LIMIT = 500 * 1024 * 1024; // 500 MB
/** evict to 80% to avoid thrash (mutable test seam — see IMAGE_CACHE_LIMIT) */
export let IMAGE_CACHE_TARGET = Math.trunc(IMAGE_CACHE_LIMIT * 0.8);

/** Default values captured once so the reset seam can restore them. */
const _DEFAULT_IMAGE_CACHE_LIMIT = IMAGE_CACHE_LIMIT;
const _DEFAULT_IMAGE_CACHE_TARGET = IMAGE_CACHE_TARGET;

/** Test seam: override the image-cache eviction threshold. */
export function _setImageCacheLimit(v: number): void {
  IMAGE_CACHE_LIMIT = v;
}

/** Test seam: override the image-cache eviction target. */
export function _setImageCacheTarget(v: number): void {
  IMAGE_CACHE_TARGET = v;
}

function _resetImageCacheThresholds(): void {
  IMAGE_CACHE_LIMIT = _DEFAULT_IMAGE_CACHE_LIMIT;
  IMAGE_CACHE_TARGET = _DEFAULT_IMAGE_CACHE_TARGET;
}
registerReset(_resetImageCacheThresholds);

/** Log retention (days) */
export const LOG_RETENTION_DAYS = 7;

/** Seconds in one day. */
const _SECS_PER_DAY = 86_400;

/** Maximum length of a project_marker value read from the dirty queue. */
const _MAX_QUEUE_MARKER_LEN = 64;

/** Maximum number of entries to keep in the dirty queue file. */
export const DIRTY_QUEUE_MAX_ENTRIES = 10_000;
/** Byte-size cap for the dirty queue file. */
export const DIRTY_QUEUE_MAX_BYTES = 2_000_000;

// In-process serialization for dirty-queue appends. No-op in single-threaded
// Node (the OS file lock handles cross-process); kept for fidelity.

/** Size cap for the worker-stderr.log crash sink. */
export const STDERR_LOG_MAX_BYTES = 1_000_000;

/** Worker timeout: started but never heartbeats within this many seconds. */
export const WORKER_STARTUP_GRACE = 15.0;

/** Heartbeat staleness beyond which a *live* worker is treated as hung. */
export const WORKER_HUNG_THRESHOLD = 900.0;

/** How often the daemon checks whether it has been replaced on disk. */
export const VERSION_CHECK_INTERVAL = 60.0;

/** Minimum seconds between worker restart attempts triggered by the post-edit hook. */
export const WORKER_RESTART_THROTTLE_SECS = 30.0;

/** Maximum seconds to allow a single file-index call to run before cancelling. */
export const INDEX_TIMEOUT_SECS: number = envFloat("TOKEN_GOAT_INDEX_TIMEOUT_SECS", 30.0, { lo: 0.1 });

/** Worker RSS threshold (MB) above which indexing is suspended. */
export const MEMORY_PRESSURE_THRESHOLD_MB: number = envFloat(
  "TOKEN_GOAT_MEMORY_PRESSURE_MB",
  500.0,
  { lo: 1.0 },
);

/** Consecutive failures before exponential backoff kicks in (per path). */
export const _BACKOFF_FAILURE_THRESHOLD = 3;
/** Base back-off delay (seconds); actual delay is 2^(failures - threshold) * base. */
const _BACKOFF_BASE_SECS = 2.0;
/** Cap on back-off delay per path. */
export const _BACKOFF_MAX_SECS = 300.0; // 5 minutes

/**
 * In-memory per-path failure counters and backoff expiry times.
 * Keyed by `${project_hash}\0${rel_path}` so the same file in different
 * projects is tracked independently. Reset when the worker restarts.
 *
 * These Maps are mutated in place by tests (set/clear/inspect) via the exported
 * bindings; a Map is a mutable object so the const binding is fine to export
 * directly — tests reach the same Map instance and the helpers below close over
 * it. Registered with reset.ts so each test starts from an empty slate.
 */
export const _index_failure_counts = new Map<string, number>();
export const _index_backoff_until = new Map<string, number>();

function _resetIndexBackoffState(): void {
  _index_failure_counts.clear();
  _index_backoff_until.clear();
}
registerReset(_resetIndexBackoffState);

function _key(projectHash: string, relPath: string): string {
  return `${projectHash}\u0000${relPath}`;
}

// ---------------------------------------------------------------------------
// process / time helpers (psutil & time.time() analogues)
// ---------------------------------------------------------------------------

/** time.time() — float seconds since epoch. */
function _now(): number {
  return Date.now() / 1000;
}

/** time.monotonic() — float seconds from a monotonic clock. */
function _monotonic(): number {
  return Number(process.hrtime.bigint()) / 1e9;
}

/**
 * Process-introspection seam. Node has no psutil; these three closures are the
 * only places that "know" about live processes, and tests override them via
 * _setProcessIntrospection so a fake live/recycled/hung PID can be simulated
 * without spawning anything.
 *
 * Defaults mirror the psutil-*absent* stub in worker.py:
 *  - pidExists: process.kill(pid, 0) existence probe (EPERM => alive).
 *  - createTime: null (no Node API) — treated as "process gone / unknown".
 *  - cmdline: null (no Node API) — treated as "cmdline unreadable" (lenient).
 */
interface ProcessIntrospection {
  pidExists(pid: number): boolean;
  createTime(pid: number): number | null;
  cmdline(pid: number): string[] | null;
}

function _defaultPidExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    const err = e as NodeJS.ErrnoException;
    if (err.code === "EPERM") {
      return true; // exists but no permission to signal
    }
    return false;
  }
}

let _introspection: ProcessIntrospection = {
  pidExists: _defaultPidExists,
  createTime: (_pid: number): number | null => null,
  cmdline: (_pid: number): string[] | null => null,
};

/**
 * Override the process-introspection seam. Pass a partial override; unspecified
 * members keep their current value. Returns the previous full object so a test
 * can restore it. Registered with reset.ts to restore defaults between tests.
 */
export function _setProcessIntrospection(
  override: Partial<ProcessIntrospection>,
): ProcessIntrospection {
  const prev = _introspection;
  _introspection = { ...prev, ...override };
  return prev;
}

function _resetProcessIntrospection(): void {
  _introspection = {
    pidExists: _defaultPidExists,
    createTime: (_pid: number): number | null => null,
    cmdline: (_pid: number): string[] | null => null,
  };
}
registerReset(_resetProcessIntrospection);

/** psutil.pid_exists analogue. */
export function _pidExists(pid: number): boolean {
  return _introspection.pidExists(pid);
}

/** psutil.Process(pid).create_time() analogue; null when gone/unknown. */
function _procCreateTime(pid: number): number | null {
  return _introspection.createTime(pid);
}

/** psutil.Process(pid).cmdline() analogue; null when unreadable. */
function _procCmdline(pid: number): string[] | null {
  return _introspection.cmdline(pid);
}

// ---------------------------------------------------------------------------
// spawn seam (subprocess.Popen(detached) analogue)
// ---------------------------------------------------------------------------

/** Minimal stand-in for the parts of a spawned child the worker uses. */
export interface SpawnedChild {
  pid: number | undefined;
  unref(): void;
}

/** Options handed to the spawn seam (a subset of child_process.spawn opts). */
export interface SpawnImplOptions {
  cwd?: string;
  /** Path to append child stderr to, or null/undefined for DEVNULL. */
  stderrPath?: string | null;
  /** Windows creationflags (ignored on POSIX; 0 on non-Windows). */
  creationflags: number;
}

/**
 * Detached-spawn seam. Default uses child_process.spawn with detached:true,
 * stdio ignored (stdin/stdout to /dev/null), stderr appended to stderrPath when
 * given, and .unref() so the parent can exit. Tests override via _setSpawnImpl
 * to capture argv without forking anything.
 */
let _spawnImpl: (cmd: string[], opts: SpawnImplOptions) => SpawnedChild | null = _defaultSpawn;

function _defaultSpawn(cmd: string[], opts: SpawnImplOptions): SpawnedChild | null {
  let stderrFd = "ignore" as "ignore" | number;
  let openedFd: number | null = null;
  if (opts.stderrPath) {
    try {
      openedFd = fs.openSync(opts.stderrPath, "a");
      stderrFd = openedFd;
    } catch {
      stderrFd = "ignore";
    }
  }
  try {
    const [exe, ...args] = cmd;
    const spawnOpts: childProcess.SpawnOptions = {
      stdio: ["ignore", "ignore", stderrFd],
      detached: true,
      windowsHide: true,
    };
    if (opts.cwd !== undefined) {
      spawnOpts.cwd = opts.cwd;
    }
    const child = childProcess.spawn(exe as string, args, spawnOpts);
    child.unref();
    return { pid: child.pid, unref: () => child.unref() };
  } finally {
    if (openedFd !== null) {
      try {
        fs.closeSync(openedFd);
      } catch {
        // child inherited its own handle; the parent copy is spare
      }
    }
  }
}

/**
 * Override the detached-spawn implementation (test seam). Pass null to restore
 * the default. Returns the previous impl.
 */
export function _setSpawnImpl(
  impl: ((cmd: string[], opts: SpawnImplOptions) => SpawnedChild | null) | null,
): (cmd: string[], opts: SpawnImplOptions) => SpawnedChild | null {
  const prev = _spawnImpl;
  _spawnImpl = impl ?? _defaultSpawn;
  return prev;
}

function _resetSpawnImpl(): void {
  _spawnImpl = _defaultSpawn;
}
registerReset(_resetSpawnImpl);

/** True when TOKEN_GOAT_NO_WORKER_SPAWN is set to a truthy value. */
function _noWorkerSpawn(): boolean {
  const v = (process.env["TOKEN_GOAT_NO_WORKER_SPAWN"] ?? "").trim().toLowerCase();
  return v === "1" || v === "true" || v === "yes" || v === "on";
}

// ---------------------------------------------------------------------------
// parser seam (parser.index_project — now ported and fully indexing code)
// ---------------------------------------------------------------------------

/**
 * The single parser entry-point worker needs.
 *
 * The real parser.index_project is async (returns a Promise, because the
 * web-tree-sitter grammar load is async); the synchronous stubs the worker
 * tests register return a plain dict. The return type is therefore the union of
 * both so either shape assigns. _run_index_with_timeout forwards whatever the
 * seam returns; the sync call-chain consumers treat a Promise as truthy ("index
 * dispatched"), matching the timeout-future contract.
 */
export interface ParserModule {
  index_project(
    project: Project,
    opts: { full: boolean },
  ): Record<string, unknown> | null | Promise<Record<string, unknown> | null>;
}

/**
 * Adapter wrapping the real parser module so its broad namespace narrows to the
 * single-method ParserModule seam (the real index_project takes an optional
 * options bag and returns Promise<IndexProjectResult>, which structurally
 * satisfies the {full:boolean} -> Promise<dict> shape).
 */
const _realParserModule: ParserModule = {
  index_project: (project: Project, opts: { full: boolean }) =>
    parser.index_project(project, opts) as unknown as Promise<Record<string, unknown> | null>,
};

let _parserModule: ParserModule | null = _realParserModule;

/**
 * Register the parser module (fail-soft seam). The default is the real
 * parser.ts module (now ported and fully indexing code). Passing a stub
 * overrides it; passing null degrades every index/reindex code path to a no-op
 * returning null (exactly as if the index call had failed the timeout). reset
 * restores the real module. Tests drive indexing either through a synchronous
 * stub or the real default.
 */
export function _setParserModule(mod: ParserModule | null): void {
  _parserModule = mod;
}

function _resetParserModule(): void {
  _parserModule = _realParserModule;
}
registerReset(_resetParserModule);

// ===========================================================================
// Version / fingerprint (importlib.metadata + sha1 package hash)
// ===========================================================================

/**
 * The token-goat version currently installed on disk.
 *
 * Python reads importlib.metadata fresh on every call so a long-running worker
 * notices a reinstall. The TS port resolves from package.json at module load
 * (version.__version__); there is no per-call metadata lookup, so this returns
 * that cached value. Returns null only if it is the zero value "0.0.0".
 */
export function _installed_version(): string | null {
  return __version__ || null;
}

/**
 * A content fingerprint of the installed token-goat package's code on disk.
 *
 * Python hashes (rel-path, size, mtime_ns) of every .py under the package dir.
 * The TS port hashes every .ts/.js under this module's directory the same way,
 * so a `npm install`/rebuild that rewrites the files changes the fingerprint.
 * Best-effort: returns null on any error so the daemon falls back to the
 * version-string check.
 */
export function _package_fingerprint(): string | null {
  try {
    const pkgDir = path.dirname(new URL(import.meta.url).pathname);
    const entries: string[] = [];
    const walk = (dir: string): void => {
      for (const name of fs.readdirSync(dir).sort()) {
        const full = path.join(dir, name);
        let st: fs.Stats;
        try {
          st = fs.statSync(full);
        } catch {
          continue;
        }
        if (st.isDirectory()) {
          walk(full);
        } else if (name.endsWith(".ts") || name.endsWith(".js")) {
          const rel = path.relative(pkgDir, full).split(path.sep).join("/");
          const mtimeNs = BigInt(Math.round(st.mtimeMs * 1e6));
          entries.push(`${rel}:${st.size}:${mtimeNs}`);
        }
      }
    };
    walk(pkgDir);
    entries.sort();
    return crypto.createHash("sha1").update(entries.join("\n"), "utf-8").digest("hex");
  } catch (e) {
    _LOG.debug("package fingerprint unavailable (falling back to version-string check): %s", e);
    return null;
  }
}

/**
 * Version this process booted with.
 *
 * Mutable so the version-change upgrade-detection tests can simulate a reinstall
 * by reassigning it (Python monkeypatches the module attribute). An ESM `const`
 * export is read-only across modules, so this is a `let` with a setter seam
 * (_setBootedVersion) + registerReset to restore the real boot value. Consumers
 * read it via the live binding (e.g. worker_daemon's `_worker._BOOTED_VERSION`),
 * which always reflects the current value.
 */
export let _BOOTED_VERSION = _installed_version();

/** Code fingerprint this process booted with (mutable test seam — see _BOOTED_VERSION). */
export let _BOOTED_FINGERPRINT = _package_fingerprint();

/** Real boot-time values, captured once so the reset seam can restore them. */
const _REAL_BOOTED_VERSION = _BOOTED_VERSION;
const _REAL_BOOTED_FINGERPRINT = _BOOTED_FINGERPRINT;

/** Test seam: override the booted version (Python monkeypatches the attribute). */
export function _setBootedVersion(v: string | null): void {
  _BOOTED_VERSION = v;
}

/** Test seam: override the booted code fingerprint. */
export function _setBootedFingerprint(v: string | null): void {
  _BOOTED_FINGERPRINT = v;
}

function _resetBootedIdentity(): void {
  _BOOTED_VERSION = _REAL_BOOTED_VERSION;
  _BOOTED_FINGERPRINT = _REAL_BOOTED_FINGERPRINT;
}
registerReset(_resetBootedIdentity);

// ===========================================================================
// Memory pressure helpers
// ===========================================================================

/**
 * Return the worker process's current RSS in MB, or null if unavailable.
 *
 * Python uses psutil; Node has process.memoryUsage().rss natively, so the TS
 * port uses that directly — it is always available, so this never returns null
 * in practice, but the null branch is preserved for parity with callers that
 * treat null as "not under pressure".
 */
export function _get_rss_mb(): number | null {
  try {
    return process.memoryUsage().rss / (1024 * 1024);
  } catch {
    return null;
  }
}

/** True when worker RSS exceeds MEMORY_PRESSURE_THRESHOLD_MB. */
export function _is_under_memory_pressure(): boolean {
  const rss = self._get_rss_mb();
  if (rss === null) {
    return false;
  }
  const over = rss > MEMORY_PRESSURE_THRESHOLD_MB;
  if (over) {
    _LOG.warning(
      "memory pressure: RSS=%s MB exceeds threshold %s MB; skipping indexing until memory drops",
      rss.toFixed(1),
      MEMORY_PRESSURE_THRESHOLD_MB.toFixed(1),
    );
  }
  return over;
}

// ===========================================================================
// Per-file indexing backoff helpers
// ===========================================================================

/** True if this (project, path) is in an active backoff window. */
export function _should_skip_due_to_backoff(projectHash: string, relPath: string): boolean {
  const key = _key(projectHash, relPath);
  const until = _index_backoff_until.get(key) ?? 0.0;
  const now = _now();
  if (now < until) {
    _LOG.debug(
      "backoff active for %s/%s: %ss remaining",
      projectHash.slice(0, 8),
      relPath,
      (until - now).toFixed(0),
    );
    return true;
  }
  return false;
}

/** Increment the failure counter for (project, path) and set backoff. */
export function _record_index_failure(projectHash: string, relPath: string): void {
  const key = _key(projectHash, relPath);
  const count = (_index_failure_counts.get(key) ?? 0) + 1;
  _index_failure_counts.set(key, count);
  if (count >= _BACKOFF_FAILURE_THRESHOLD) {
    const exponent = count - _BACKOFF_FAILURE_THRESHOLD;
    const delay = Math.min(_BACKOFF_BASE_SECS ** exponent * _BACKOFF_BASE_SECS, _BACKOFF_MAX_SECS);
    _index_backoff_until.set(key, _now() + delay);
    _LOG.warning(
      "index failure #%d for %s/%s; backing off %ss",
      count,
      projectHash.slice(0, 8),
      relPath,
      delay.toFixed(0),
    );
  }
}

/** Clear the failure counter and backoff for (project, path) after success. */
export function _record_index_success(projectHash: string, relPath: string): void {
  const key = _key(projectHash, relPath);
  _index_failure_counts.delete(key);
  _index_backoff_until.delete(key);
}

// ===========================================================================
// Logging setup
// ===========================================================================

/** Format a Date as YYYY-MM-DD in local time (datetime strftime %Y-%m-%d). */
function _todayStamp(d: Date = new Date()): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/**
 * Configure the worker's logger for the current process.
 *
 * Python attaches a daily rotating FileHandler + (interactive only) a stderr
 * StreamHandler. The TS port's getLogger returns a console-backed Logger with
 * no attachable handlers, and paths.openLogFile is a not-yet-ported stub that
 * throws. So this degrades to: ensure dirs exist, best-effort roll the daily
 * log file if oversized, and otherwise no-op (console logging is already
 * active). Wrapped fail-soft so a logging-setup failure never takes the worker
 * down. Idempotent.
 */
export function _setup_logging(): void {
  try {
    paths.ensureDirs();
    const logPath = path.join(paths.logsDir(), `${_todayStamp()}.log`);
    try {
      paths.rollLogIfOversized(logPath, paths.LOG_FILE_MAX_BYTES);
    } catch {
      // best-effort
    }
  } catch (e) {
    _LOG.debug("_setup_logging: degraded (no-op): %s", e);
  }
}

// ===========================================================================
// Liveness
// ===========================================================================

/** Extra seconds of leniency beyond 2x HEARTBEAT_INTERVAL before stale. */
export const HEARTBEAT_GRACE_SECONDS = 5.0;

/** Seconds after which a heartbeat is considered stale by the watchdog. */
export function heartbeat_stale_threshold(): number {
  return 2 * HEARTBEAT_INTERVAL + HEARTBEAT_GRACE_SECONDS;
}

/**
 * Seconds since the heartbeat file was last written, or null if it does not
 * exist (or could not be stat'ed).
 */
export function heartbeat_age(hbPath?: string): number | null {
  const p = hbPath !== undefined ? hbPath : paths.workerHeartbeatPath();
  try {
    return _now() - fs.statSync(p).mtimeMs / 1000;
  } catch {
    return null;
  }
}

/**
 * True if the heartbeat is older than heartbeat_stale_threshold — i.e. the
 * post-edit hook should respawn the worker via ensure_running. A missing
 * heartbeat file is also treated as stale.
 */
export function is_heartbeat_stale_for_nudge(hbPath?: string): boolean {
  const age = self.heartbeat_age(hbPath);
  if (age === null) {
    return true;
  }
  return age > self.heartbeat_stale_threshold();
}

/** Check if heartbeat file exists and is recent (within 2x interval + grace). */
function _is_heartbeat_fresh(hbPath: string): boolean {
  if (!fs.existsSync(hbPath)) {
    return false;
  }
  const age = self.heartbeat_age(hbPath);
  if (age === null) {
    return false;
  }
  return age <= self.heartbeat_stale_threshold();
}

/** Check if process exists and is younger than startup grace window. */
export function _is_process_recent(pid: number): boolean {
  const ct = _procCreateTime(pid);
  if (ct === null) {
    _LOG.debug("_is_process_recent pid=%s: create_time unavailable", pid);
    return false;
  }
  const age = _now() - ct;
  return age <= WORKER_STARTUP_GRACE;
}

/**
 * True if the PID file exists, points to a live token-goat process, and
 * heartbeat is fresh.
 */
export function is_worker_alive(): boolean {
  const pidPath = paths.workerPidPath();
  if (!fs.existsSync(pidPath)) {
    return false;
  }
  let pid: number;
  try {
    [pid] = _read_pid_info(fs.readFileSync(pidPath, "utf-8"));
  } catch {
    return false;
  }

  if (!_pidExists(pid)) {
    return false;
  }

  // Attempt cmdline verification to catch PID recycling. When cmdline is
  // unreadable (the default in the TS port — no Node API), a fresh heartbeat
  // proves a live process was checking in, so we accept it.
  const cmd = _procCmdline(pid);
  if (cmd !== null) {
    const cmdline = cmd.join(" ").toLowerCase();
    if (!cmdline.includes("token_goat") || !cmdline.includes("worker")) {
      _LOG.debug(
        "is_worker_alive: PID %d is alive but cmdline does not match token-goat worker",
        pid,
      );
      return false;
    }
  }

  // Check heartbeat freshness or startup grace period.
  const hbPath = paths.workerHeartbeatPath();
  if (fs.existsSync(hbPath)) {
    return _is_heartbeat_fresh(hbPath);
  }
  // No heartbeat yet — worker is still starting up.
  return _is_process_recent(pid);
}

/**
 * Parse the worker PID file content and return [pid, interpreter|null].
 * Accepts the legacy bare-integer format and the JSON format. Throws on
 * malformed input so callers fall through to "pid file unreadable".
 */
export function _read_pid_info(pidText: string): [number, string | null] {
  const text = pidText.trim();
  if (text.startsWith("{")) {
    const data = JSON.parse(text) as { pid: unknown; interpreter?: unknown };
    const pid = Number.parseInt(String(data.pid), 10);
    if (!Number.isFinite(pid)) {
      throw new Error(`invalid pid in JSON pid file: ${String(data.pid)}`);
    }
    const interpreter = (data.interpreter as string | undefined) || null;
    return [pid, interpreter];
  }
  // Legacy plain-integer format.
  const pid = Number.parseInt(text, 10);
  if (!Number.isFinite(pid) || text.trim() === "" || !/^[+-]?\d+$/.test(text.trim())) {
    throw new Error(`invalid legacy pid file content: ${text}`);
  }
  return [pid, null];
}

/** Write the current process ID to the worker PID file (JSON payload). */
export function _write_pid(): void {
  let version: string;
  try {
    version = __version__ || "unknown";
  } catch {
    version = "unknown";
  }
  const payload = JSON.stringify({
    pid: process.pid,
    started_at: new Date().toISOString(),
    interpreter: process.execPath,
    version,
  });
  paths.atomicWriteText(paths.workerPidPath(), payload);
}

/** Write current timestamp to heartbeat file to indicate the worker is alive. */
export function _heartbeat(): void {
  paths.atomicWriteText(paths.workerHeartbeatPath(), String(_now()));
}

/** Remove PID and heartbeat files to signal the worker is stopping. */
export function _clear_pid(): void {
  for (const p of [paths.workerPidPath(), paths.workerHeartbeatPath()]) {
    try {
      fs.unlinkSync(p);
    } catch (e) {
      const err = e as NodeJS.ErrnoException;
      if (err.code === "ENOENT") {
        continue;
      }
      _LOG.warning("failed to clear %s: %s", p, e);
    }
  }
}

/** Path to the atomic single-worker claim file. */
export function _worker_claim_path(): string {
  return path.join(paths.locksDir(), "worker.claim");
}

/** Return the process creation time, or null if the process is gone. */
export function _proc_create_time(pid: number): number | null {
  return _procCreateTime(pid);
}

/**
 * True only if the claim's owning process is definitely gone.
 *
 * The claim records `pid\ncreate_time`. Stale iff that exact process is no
 * longer alive (dead, or PID recycled — detected via create-time mismatch). An
 * empty/malformed claim is NOT stale during the brief startup window, unless
 * the file mtime is older than 60s (owner died mid-startup → zombie).
 */
export function _worker_claim_is_stale(claimPath: string): boolean {
  let pid: number;
  let claimedCt: number;
  try {
    const raw = fs.readFileSync(claimPath, "utf-8");
    const nl = raw.indexOf("\n");
    if (nl < 0) {
      throw new Error("no newline in claim file");
    }
    const pidStr = raw.slice(0, nl);
    const ctStr = raw.slice(nl + 1);
    pid = Number.parseInt(pidStr, 10);
    claimedCt = Number.parseFloat(ctStr.trim());
    if (!Number.isFinite(pid) || !Number.isFinite(claimedCt)) {
      throw new Error("malformed claim content");
    }
  } catch {
    // Empty or malformed content. Check file age to detect zombie claims.
    let mtime: number;
    try {
      mtime = fs.statSync(claimPath).mtimeMs / 1000;
    } catch {
      return false; // file vanished — treat as not stale
    }
    const age = _now() - mtime;
    if (age > 60) {
      _LOG.warning("clearing zombie claim file: %s (mtime age %ss)", claimPath, age.toFixed(1));
      return true;
    }
    return false; // mid-startup grace window
  }
  const actualCt = _proc_create_time(pid);
  if (actualCt === null) {
    // No create_time available. In the TS port (no psutil) create_time is null
    // both when the process is gone AND when it is alive-but-unintrospectable.
    // Mirror the psutil-absent stub: Process() raises NoSuchProcess -> the
    // Python path returns True ("owner gone — reclaim"). Fall back to the
    // pid-existence probe so a still-running owner is not falsely reclaimed.
    return !_pidExists(pid);
  }
  // PID alive — stale only if it was recycled to a different process.
  return Math.abs(actualCt - claimedCt) > 1.0;
}

/**
 * Atomically claim the single-worker slot. Returns an open fd, or null.
 *
 * Uses fs.openSync with "wx" (O_CREAT | O_EXCL) as a cross-platform mutex. A
 * claim left by a crashed worker is reclaimed once.
 */
export function _try_claim_worker_slot(): number | null {
  const claimPath = _worker_claim_path();
  paths.ensureDir(path.dirname(claimPath));
  for (const attempt of [1, 2]) {
    let fd: number;
    try {
      // 0o600: owner-only.
      fd = fs.openSync(claimPath, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY, 0o600);
    } catch (e) {
      const err = e as NodeJS.ErrnoException;
      if (err.code === "EEXIST") {
        if (attempt === 1 && _worker_claim_is_stale(claimPath)) {
          _LOG.info("removing stale worker claim file");
          try {
            fs.unlinkSync(claimPath);
          } catch {
            // ignore
          }
          continue; // retry the atomic create once
        }
        return null; // a live worker holds the slot
      }
      _LOG.warning("failed to claim worker slot: %s", e);
      return null;
    }
    // On write failure, close the fd and remove the empty file.
    try {
      const createTime = _proc_create_time(process.pid) ?? _now();
      fs.writeSync(fd, `${process.pid}\n${createTime}`);
    } catch (e) {
      try {
        fs.closeSync(fd);
      } catch {
        // ignore
      }
      try {
        fs.unlinkSync(claimPath);
      } catch {
        // ignore
      }
      _LOG.warning("failed to populate worker claim file: %s", e);
      return null;
    }
    return fd;
  }
  return null;
}

// ===========================================================================
// Dirty queue
// ===========================================================================

/**
 * Acquire an exclusive lock on the dirty queue, run body, release.
 *
 * Python uses fcntl.flock / msvcrt.locking. Node has no stdlib advisory-lock
 * binding, so this degrades to a best-effort "no OS lock" — body always runs
 * with lockAcquired=true (the append is still atomic on POSIX because O_APPEND
 * writes under PIPE_BUF are atomic). The yield/finally contract is preserved so
 * the call site is a one-for-one port.
 */
export function _dirty_queue_lock<T>(lockPath: string, body: (lockAcquired: boolean) => T): T {
  try {
    paths.ensureDir(path.dirname(lockPath));
    try {
      // touch(exist_ok=True)
      const fd = fs.openSync(lockPath, "a");
      fs.closeSync(fd);
    } catch {
      // best-effort
    }
  } catch {
    // best-effort
  }
  // No stdlib advisory lock in Node — best-effort, treat as acquired.
  return body(true);
}

/**
 * Render a float the way Python's `json.dumps` does (`repr(float)`): shortest
 * round-trip, but an integral value keeps its `.0` (json.dumps(1700000000.0) ->
 * "1700000000.0"). JS `String(num)` drops the `.0` for an integral float, so we
 * re-append it. Non-integral floats and exponential forms (1e+21) already match
 * Python's repr, so they pass through unchanged.
 */
function _pyFloatRepr(value: number): string {
  const s = String(value);
  // Integral and not already in exponential notation → Python keeps ".0".
  if (Number.isInteger(value) && !/[.eEnN]/.test(s)) {
    return `${s}.0`;
  }
  return s;
}

/**
 * Serialize a dirty-queue entry byte-for-byte like Python's `json.dumps(entry)`.
 *
 * Python's default `json.dumps` uses ", " and ": " separators (with spaces) and
 * preserves a float's trailing ".0"; JS `JSON.stringify` drops both. This is the
 * approach documented in cache_common.ts (~L492) — there the divergence is
 * immaterial because the sidecar is only ever re-parsed, but the dirty queue is
 * a shared on-disk contract with the Python writer (hooks_cli._enqueue_for_reindex),
 * so the bytes must match exactly. The entry shape is closed (string|null fields
 * plus a single float `ts`), so a direct key-ordered emit suffices.
 */
/**
 * JSON-encode a string the way Python `json.dumps` does with its default
 * `ensure_ascii=True`: JSON.stringify already matches Python's quote/backslash/
 * control-char escaping (the short \\n \\t \\r \\b \\f escapes + \\u00XX for other
 * controls), so we only need to additionally escape every non-ASCII UTF-16 code
 * unit to \\uXXXX (an astral char is a surrogate pair, so each unit escapes to
 * \\uD83D\\uDE00 — exactly Python's output). The dirty queue is a cross-language
 * on-disk contract, so a unicode file path must serialize byte-for-byte.
 */
function _asciiJsonString(s: string): string {
  // JSON.stringify already matches Python json.dumps' quote/backslash/control
  // escaping; additionally escape every non-ASCII UTF-16 code unit to \uXXXX
  // (an astral char is a surrogate pair, so each unit -> \uD83D\uDE00) to match
  // json.dumps' default ensure_ascii=True.
  const base = JSON.stringify(s);
  let out = "";
  for (let i = 0; i < base.length; i += 1) {
    const code = base.charCodeAt(i);
    out += code > 0x7f ? "\\u" + code.toString(16).padStart(4, "0") : base.charAt(i);
  }
  return out;
}

function _dumpDirtyEntry(entry: Record<string, unknown>): string {
  const parts: string[] = [];
  for (const [key, value] of Object.entries(entry)) {
    const k = _asciiJsonString(key);
    let v: string;
    if (value === null) {
      v = "null";
    } else if (typeof value === "number") {
      // The only numeric field is `ts`, which is always a Python float
      // (time.time()); render it with float semantics so an integral value
      // keeps its ".0".
      v = Number.isFinite(value) ? _pyFloatRepr(value) : JSON.stringify(value);
    } else {
      v = _asciiJsonString(String(value));
    }
    parts.push(`${k}: ${v}`);
  }
  return `{${parts.join(", ")}}`;
}

/**
 * Append a dirty path to the queue. Used by hooks after Edit/Write.
 *
 * Append-only: never reads or rewrites the existing queue file. The byte-size
 * cap is enforced via a single statSync (O(1)).
 */
export function enqueue_dirty(
  relPath: string,
  projectHash?: string | null,
  opts: { project_root?: string | null; project_marker?: string | null } = {},
): void {
  paths.ensureDir(path.dirname(paths.dirtyQueuePath()));
  const entry: Record<string, unknown> = {
    path: relPath,
    project_hash: projectHash ?? null,
    ts: _now(),
  };
  if (opts.project_root !== undefined && opts.project_root !== null) {
    entry["project_root"] = opts.project_root;
  }
  if (opts.project_marker !== undefined && opts.project_marker !== null) {
    entry["project_marker"] = opts.project_marker;
  }
  const line = _dumpDirtyEntry(entry);

  const queuePath = paths.dirtyQueuePath();
  const lockPath = path.join(path.dirname(queuePath), ".dirty_queue.lock");
  _dirty_queue_lock(lockPath, (lockAcquired) => {
    if (!lockAcquired) {
      _LOG.debug("dirty queue OS lock not acquired; dropping entry (fail-soft): %s", relPath);
      return;
    }
    // Byte-size cap: single statSync instead of reading all entries.
    try {
      if (fs.existsSync(queuePath) && fs.statSync(queuePath).size >= DIRTY_QUEUE_MAX_BYTES) {
        _LOG.info(
          "dirty queue byte cap reached (%d B); dropping entry: %s",
          DIRTY_QUEUE_MAX_BYTES,
          relPath,
        );
        return;
      }
    } catch {
      // stat failed — proceed with the append anyway
    }
    try {
      fs.appendFileSync(queuePath, line + "\n", { encoding: "utf-8" });
    } catch (e) {
      _LOG.warning("failed to write dirty queue: %s", e);
    }
  });
}

/** Return the sleep interval for the daemon main loop given idle duration. */
export function adaptive_poll_interval(consecutiveEmptyDrains: number): number {
  if (consecutiveEmptyDrains < IDLE_BACKOFF_AFTER_EMPTY_DRAINS) {
    return POLL_INTERVAL;
  }
  // +1 so the first eligible drain steps strictly above POLL_INTERVAL.
  const extra = consecutiveEmptyDrains - IDLE_BACKOFF_AFTER_EMPTY_DRAINS + 1;
  return Math.min(POLL_INTERVAL_MAX, POLL_INTERVAL + extra * POLL_INTERVAL);
}

/** Python str.splitlines(): split on line boundaries, drop a single trailing empty. */
function _splitlines(text: string): string[] {
  if (text === "") {
    return [];
  }
  const parts = text.split(/\r\n|\r|\n/);
  // Python's splitlines drops the trailing empty element that a final newline
  // would otherwise produce.
  if (parts.length > 0 && parts[parts.length - 1] === "") {
    parts.pop();
  }
  return parts;
}

/** Read a file as UTF-8 with invalid bytes replaced (errors="replace"). */
function _readTextReplace(p: string): string {
  return fs.readFileSync(p).toString("utf-8");
}

/**
 * Atomically claim and return all queued entries.
 *
 * Renames dirty.txt to a private `.draining` file before reading it. Returns a
 * (possibly empty) list on a successful drain, or null when the drain was
 * deferred (live dirty.txt existed but could not be claimed).
 */
export function drain_dirty_queue(): DirtyQueueEntry[] | null {
  _LOG.debug("draining dirty queue");
  const p = paths.dirtyQueuePath();
  const draining = path.join(path.dirname(p), path.basename(p) + ".draining");
  const rawLines: string[] = [];
  let deferred = false;

  // Recover entries from a .draining file a previous (crashed) drain abandoned.
  if (fs.existsSync(draining)) {
    try {
      for (const ln of _splitlines(_readTextReplace(draining))) {
        rawLines.push(ln);
      }
      fs.unlinkSync(draining);
      _LOG.info(
        "recovered %d entries from abandoned .draining file: %s",
        rawLines.length,
        path.basename(draining),
      );
    } catch (e) {
      // Quarantine the unreadable file.
      const corrupt = draining.replace(/\.[^.]*$/, "") + `.corrupt-${Math.trunc(_now())}`;
      try {
        fs.renameSync(draining, corrupt);
        _LOG.warning("quarantined unreadable .draining file as %s: %s", path.basename(corrupt), e);
      } catch (renameErr) {
        _LOG.error(
          "cannot quarantine .draining file, skipping drain cycle: %s (read error: %s)",
          renameErr,
          e,
        );
        return null;
      }
    }
  }

  // Atomically claim the live queue via rename (os.replace analogue). On
  // Windows a concurrent appender can make rename fail; retry, then defer.
  if (fs.existsSync(p)) {
    let claimed = false;
    let lastReplaceErr: unknown = null;
    for (let i = 0; i < 5; i++) {
      try {
        fs.renameSync(p, draining);
        claimed = true;
        break;
      } catch (e) {
        lastReplaceErr = e;
        _sleepMsBusy(50);
      }
    }
    if (claimed) {
      try {
        const drainingLines = _splitlines(_readTextReplace(draining));
        for (const ln of drainingLines) {
          rawLines.push(ln);
        }
        fs.unlinkSync(draining);
        _LOG.debug("claimed and read %d fresh queue entries", drainingLines.length);
      } catch (e) {
        _LOG.warning("failed to read/clear drained queue file: %s", e);
      }
    } else {
      deferred = true;
      _LOG.warning(
        "dirty queue busy after 5 retries; deferring drain to next cycle (%s)",
        lastReplaceErr,
      );
    }
  }

  const rawEntries: DirtyQueueEntry[] = [];
  let malformedCount = 0;
  for (const rawLine of rawLines) {
    const line = rawLine.trim();
    if (!line) {
      continue;
    }
    try {
      const entry = JSON.parse(line) as unknown;
      if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
        _LOG.warning("dirty queue entry is not a dict: %s", line.slice(0, 120));
        malformedCount += 1;
        continue;
      }
      rawEntries.push(entry as DirtyQueueEntry);
    } catch {
      _LOG.warning("bad dirty queue entry (not valid JSON): %s", line.slice(0, 120));
      malformedCount += 1;
    }
  }

  // Deduplicate by (project_hash, path), first occurrence wins.
  const seen = new Set<string>();
  const entries: DirtyQueueEntry[] = [];
  for (const entry of rawEntries) {
    const key = _key(entry.project_hash ?? "", entry.path ?? "");
    if (!seen.has(key)) {
      seen.add(key);
      entries.push(entry);
    }
  }
  const dupes = rawEntries.length - entries.length;

  if (entries.length > 0) {
    _LOG.info(
      "drained dirty queue: %d valid entries%s%s",
      entries.length,
      dupes ? ` (${dupes} dupes removed)` : "",
      malformedCount ? `, ${malformedCount} malformed` : "",
    );
    return entries;
  }
  if (deferred) {
    return null;
  }
  return entries;
}

/**
 * Busy-wait sleep in milliseconds (time.sleep analogue for the short retry
 * back-offs inside drain_dirty_queue). NEVER used for the daemon poll loop —
 * that uses the abortable async sleep in worker_daemon. Bounded to small values
 * (<= a few hundred ms) so it cannot wedge a test.
 */
function _sleepMsBusy(ms: number): void {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    // spin — only ever 50 ms at a time on the rare Windows rename-retry path
  }
}

// ===========================================================================
// Self-healing
// ===========================================================================

/** Remove stale or malformed lockfiles. Returns count cleared. */
export function _cleanup_stale_locks(): number {
  let cleared = 0;
  const locks = paths.locksDir();
  if (!fs.existsSync(locks)) {
    _LOG.debug("locks directory does not exist, skipping cleanup");
    return 0;
  }
  let totalLocks = 0;
  const now = _now();
  for (const lockPath of _glob(locks, ".lock")) {
    totalLocks += 1;
    try {
      const content = fs.readFileSync(lockPath, "utf-8");
      const pidStr = (content.split("\n", 1)[0] ?? "").trim();
      if (!pidStr) {
        throw new Error(`empty PID in lock file ${path.basename(lockPath)}`);
      }
      const pid = Number.parseInt(pidStr, 10);
      if (!Number.isFinite(pid)) {
        throw new Error(`non-integer PID in lock file ${path.basename(lockPath)}`);
      }
      const ownerIsDead = !_pidExists(pid);
      const lockIsStale = now - fs.statSync(lockPath).mtimeMs / 1000 > db.LOCK_STALE_SECONDS;
      if (ownerIsDead || lockIsStale) {
        fs.unlinkSync(lockPath);
        cleared += 1;
        const reason = ownerIsDead ? "owner dead" : "stale (>600s)";
        _LOG.debug("cleared stale lock %s (%s)", path.basename(lockPath), reason);
      }
    } catch (e) {
      _LOG.debug("removing stale/malformed lock %s: %s", path.basename(lockPath), e);
      try {
        fs.unlinkSync(lockPath);
        cleared += 1;
      } catch (unlinkErr) {
        _LOG.warning("failed to remove lock %s: %s", path.basename(lockPath), unlinkErr);
      }
    }
  }
  if (cleared > 0) {
    _LOG.debug("stale locks cleanup: cleared %d of %d locks", cleared, totalLocks);
  }
  return cleared;
}

/** List absolute paths of files in dir whose name ends with suffix. */
function _glob(dir: string, suffix: string): string[] {
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return [];
  }
  const out: string[] = [];
  for (const name of names) {
    if (name.endsWith(suffix)) {
      out.push(path.join(dir, name));
    }
  }
  return out;
}

/** Delete log files older than LOG_RETENTION_DAYS. Returns count deleted. */
export function _cleanup_old_logs(): number {
  let deleted = 0;
  const logs = paths.logsDir();
  if (!fs.existsSync(logs)) {
    _LOG.debug("logs directory does not exist, skipping cleanup");
    return 0;
  }
  const cutoff = _now() - LOG_RETENTION_DAYS * _SECS_PER_DAY;
  for (const log of _glob(logs, ".log")) {
    try {
      if (fs.statSync(log).mtimeMs / 1000 < cutoff) {
        fs.unlinkSync(log);
        deleted += 1;
        _LOG.debug("deleted old log file: %s", path.basename(log));
      }
    } catch (e) {
      _LOG.warning("failed to delete old log %s: %s", path.basename(log), e);
    }
  }
  if (deleted > 0) {
    _LOG.debug("old logs cleanup: deleted %d files", deleted);
  }
  return deleted;
}

/** Delete granular stats events older than STATS_RETENTION_DAYS from global.db. */
export function _prune_stats_table(): number {
  const cutoffTs = Math.trunc(_now() - STATS_RETENTION_DAYS * _SECS_PER_DAY);
  try {
    return db.openGlobal((conn: DatabaseType): number => {
      const res = conn.prepare("DELETE FROM stats WHERE ts < ?").run(cutoffTs);
      const pruned = res.changes || 0;
      _LOG.debug("stats prune: deleted %d rows older than %d days", pruned, STATS_RETENTION_DAYS);
      return pruned;
    });
  } catch (exc) {
    _LOG.warning("stats prune failed (global.db unavailable): %s", exc);
    throw exc;
  }
}

/** Drop per-session content snapshots older than 24 hours. */
export function _cleanup_stale_snapshots(): number {
  return snapshots.cleanup_stale(24.0);
}

/** Enforce the on-disk bash-output store byte cap. */
export function _evict_bash_outputs(): number {
  const cfg = config.load().bash_compress;
  // bash_cache.evict_old_entries types both opts as required `number` (no
  // `| undefined`) under exactOptionalPropertyTypes; build the object omitting
  // any field config validation left undefined so the shapes line up. In
  // practice config.load() always populates these (validated ints), matching
  // Python's `cfg.cache_max_bytes` / `cfg.cache_max_file_count` direct access.
  const opts: { max_total_bytes?: number; max_file_count?: number } = {};
  if (cfg?.cache_max_bytes !== undefined) {
    opts.max_total_bytes = cfg.cache_max_bytes;
  }
  if (cfg?.cache_max_file_count !== undefined) {
    opts.max_file_count = cfg.cache_max_file_count;
  }
  return bash_cache.evict_old_entries(opts);
}

/** Enforce the on-disk web-output store byte cap. */
export function _evict_web_outputs(): number {
  const cfg = config.load().webfetch;
  return web_cache.evict_old_entries({
    max_total_bytes: cfg?.max_bytes,
    max_file_count: cfg?.max_file_count,
  });
}

/** Force a TRUNCATE checkpoint of global.db's WAL, returning bytes reclaimed. */
export function _checkpoint_global_wal(): number {
  const base = paths.globalDbPath();
  const walPath = base + "-wal";
  const before = fs.existsSync(walPath) ? fs.statSync(walPath).size : 0;
  db.openGlobal((conn: DatabaseType): void => {
    conn.prepare("PRAGMA wal_checkpoint(TRUNCATE)").run();
  });
  const after = fs.existsSync(walPath) ? fs.statSync(walPath).size : 0;
  const reclaimed = Math.max(0, before - after);
  if (reclaimed) {
    _LOG.info("WAL checkpoint reclaimed %d bytes from global.db-wal", reclaimed);
  }
  return reclaimed;
}

/** TRUNCATE-checkpoint the WAL for every active project DB. */
export function _checkpoint_project_wals(): number {
  let reclaimed = 0;
  let hashes: string[];
  try {
    hashes = db.openGlobalReadonly((gconn: DatabaseType): string[] => {
      return (gconn.prepare("SELECT hash FROM projects").all() as { hash: string }[]).map(
        (r) => r.hash,
      );
    });
  } catch {
    _LOG.debug("_checkpoint_project_wals: could not list projects; skipping");
    return 0;
  }
  for (const projectHash of hashes) {
    const dbPath = paths.projectDbPath(projectHash);
    const walPath = dbPath + "-wal";
    if (!fs.existsSync(walPath)) {
      continue;
    }
    const before = fs.statSync(walPath).size;
    try {
      db.openProject(projectHash, (conn: DatabaseType): void => {
        conn.prepare("PRAGMA wal_checkpoint(TRUNCATE)").run();
      });
    } catch {
      _LOG.debug("_checkpoint_project_wals: checkpoint failed for %s", projectHash);
      continue;
    }
    const after = fs.existsSync(walPath) ? fs.statSync(walPath).size : 0;
    reclaimed += Math.max(0, before - after);
  }
  if (reclaimed) {
    _LOG.info("WAL checkpoint reclaimed %d bytes across %d project DBs", reclaimed, hashes.length);
  }
  return reclaimed;
}

/** Projects whose root has been missing for less than this are spared from GC. */
const _GC_PROJECTS_SAFETY_WINDOW = 1800.0; // 30 minutes

/** How often to run the orphan-project GC pass in the running daemon. */
export const GC_PROJECTS_INTERVAL = 3600.0; // 1 hour

/**
 * Delete global.db project rows (and on-disk .db files) whose roots no longer
 * exist. Exported because the daemon's hourly GC pass
 * (worker_daemon.run_daemon) calls it directly — Python keeps it module-private
 * and reaches it via `_worker._gc_orphaned_projects`, which a TS cross-module
 * call cannot do, so it is part of the public surface here.
 */
export function _gc_orphaned_projects(): number {
  let removed = 0;
  const now = _now();
  const safetyCutoff = now - _GC_PROJECTS_SAFETY_WINDOW;
  let rows: { hash: string; root: string; last_seen: number }[];
  try {
    rows = db.openGlobal((gconn: DatabaseType): { hash: string; root: string; last_seen: number }[] => {
      return gconn
        .prepare("SELECT hash, root, last_seen FROM projects")
        .all() as { hash: string; root: string; last_seen: number }[];
    });
  } catch (exc) {
    _LOG.warning("_gc_orphaned_projects: could not read projects table: %s", exc);
    return 0;
  }

  for (const row of rows) {
    const projectHash = row.hash;
    const root = row.root;
    const lastSeen = Number(row.last_seen);

    if (lastSeen > safetyCutoff) {
      _LOG.debug(
        "_gc_orphaned_projects: skipping recent project %s (last_seen %ss ago)",
        root,
        (now - lastSeen).toFixed(0),
      );
      continue;
    }

    if (_isDir(root)) {
      continue;
    }

    _LOG.info("_gc_orphaned_projects: removing orphaned project root=%s hash=%s", root, projectHash);
    try {
      const deletedRows = db.openGlobal((gconn: DatabaseType): number => {
        const res = gconn
          .prepare("DELETE FROM projects WHERE hash = ? AND last_seen <= ?")
          .run(projectHash, safetyCutoff);
        return res.changes;
      });
      if (deletedRows === 0) {
        _LOG.debug(
          "_gc_orphaned_projects: skipping %s — last_seen updated concurrently",
          projectHash,
        );
        continue;
      }
    } catch (exc) {
      _LOG.warning("_gc_orphaned_projects: could not delete row for %s: %s", projectHash, exc);
      continue;
    }

    // Remove per-project DB files; ignore individual errors.
    let dbPath: string;
    try {
      dbPath = paths.projectDbPath(projectHash);
    } catch {
      _LOG.warning(
        "_gc_orphaned_projects: invalid project hash %s — skipping file removal",
        projectHash,
      );
      removed += 1;
      continue;
    }
    for (const suffix of ["", "-wal", "-shm"]) {
      const candidate = suffix ? dbPath + suffix : dbPath;
      if (fs.existsSync(candidate)) {
        try {
          fs.unlinkSync(candidate);
          _LOG.debug("_gc_orphaned_projects: deleted %s", candidate);
        } catch (exc) {
          _LOG.warning("_gc_orphaned_projects: could not delete %s: %s", candidate, exc);
        }
      }
    }
    removed += 1;
  }

  if (removed) {
    _LOG.info("_gc_orphaned_projects: removed %d orphaned project(s)", removed);
  }
  return removed;
}

/** fs.statSync(p).isDirectory() with a false-on-error wrapper. */
function _isDir(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

const _SESSION_RETENTION_DAYS = 7;
/** How many days to retain orphaned improve-state files. */
const _IMPROVE_STATE_RETENTION_DAYS = 7;
/** How many days to retain sentinel files. */
const _SENTINEL_RETENTION_DAYS = 30;

/** Delete orphaned .improve-state-*.json files older than 7 days. */
function _cleanup_orphaned_state_files(): number {
  let deleted = 0;
  const now = _now();
  const cutoff = now - _IMPROVE_STATE_RETENTION_DAYS * _SECS_PER_DAY;

  let rows: { root: string }[];
  try {
    rows = db.openGlobal((gconn: DatabaseType): { root: string }[] => {
      return gconn.prepare("SELECT root FROM projects").all() as { root: string }[];
    });
  } catch (exc) {
    _LOG.debug("_cleanup_orphaned_state_files: could not read projects table: %s", exc);
    return 0;
  }

  for (const row of rows) {
    const projectRoot = row.root;
    try {
      if (!_isDir(projectRoot)) {
        continue;
      }
      for (const stateFile of _globPrefixSuffix(projectRoot, ".improve-state-", ".json")) {
        try {
          if (fs.statSync(stateFile).mtimeMs / 1000 < cutoff) {
            fs.unlinkSync(stateFile);
            deleted += 1;
            _LOG.debug("_cleanup_orphaned_state_files: removed %s", path.basename(stateFile));
          }
        } catch (e) {
          _LOG.warning(
            "failed to remove orphaned state file %s: %s",
            path.basename(stateFile),
            e,
          );
        }
      }
    } catch (e) {
      _LOG.warning(
        "error scanning project root %s for improve-state files: %s",
        projectRoot,
        e,
      );
      continue;
    }
  }

  if (deleted > 0) {
    _LOG.info("_cleanup_orphaned_state_files: removed %d orphaned state file(s)", deleted);
  }
  return deleted;
}

/** List files in dir whose name starts with prefix and ends with suffix. */
function _globPrefixSuffix(dir: string, prefix: string, suffix: string): string[] {
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return [];
  }
  const out: string[] = [];
  for (const name of names) {
    if (name.startsWith(prefix) && name.endsWith(suffix)) {
      out.push(path.join(dir, name));
    }
  }
  return out;
}

/** Delete sentinel files older than _SENTINEL_RETENTION_DAYS (30 days). */
function _cleanup_old_sentinels(): number {
  const sentinelsDir = paths.sentinelsDir();
  if (!_isDir(sentinelsDir)) {
    _LOG.debug("sentinels directory does not exist, skipping cleanup");
    return 0;
  }

  let deleted = 0;
  const now = _now();
  const cutoff = now - _SENTINEL_RETENTION_DAYS * _SECS_PER_DAY;

  let names: string[];
  try {
    names = fs.readdirSync(sentinelsDir);
  } catch (exc) {
    _LOG.debug("_cleanup_old_sentinels: directory scan failed: %s", exc);
    return deleted;
  }
  for (const name of names) {
    const sentinelFile = path.join(sentinelsDir, name);
    try {
      if (fs.statSync(sentinelFile).mtimeMs / 1000 < cutoff) {
        fs.unlinkSync(sentinelFile);
        deleted += 1;
        _LOG.debug("_cleanup_old_sentinels: removed %s", name);
      }
    } catch (e) {
      _LOG.warning("failed to remove sentinel file %s: %s", name, e);
    }
  }

  if (deleted > 0) {
    _LOG.info("_cleanup_old_sentinels: removed %d sentinel file(s)", deleted);
  }
  return deleted;
}

/** Remove session JSON files older than SESSION_RETENTION_DAYS days. */
export function _cleanup_old_sessions(): number {
  const sessionsDir = paths.sessionsDir();
  if (!_isDir(sessionsDir)) {
    return 0;
  }
  const maxAge = _SESSION_RETENTION_DAYS * 86400;
  const now = _now();
  let removed = 0;
  let names: string[];
  try {
    names = fs.readdirSync(sessionsDir);
  } catch (exc) {
    _LOG.debug("_cleanup_old_sessions: directory scan failed: %s", exc);
    return removed;
  }
  for (const name of names) {
    if (path.extname(name) !== ".json") {
      continue;
    }
    const fp = path.join(sessionsDir, name);
    try {
      if (now - fs.statSync(fp).mtimeMs / 1000 > maxAge) {
        fs.unlinkSync(fp);
        removed += 1;
        _LOG.debug("_cleanup_old_sessions: removed %s", name);
        // Remove companion lock/flock sidecars (fp with .json replaced).
        const stem = name.slice(0, -".json".length);
        for (const sidecarSuffix of [".json.lock", ".json.flock"]) {
          const sidecar = path.join(sessionsDir, stem + sidecarSuffix);
          try {
            fs.unlinkSync(sidecar);
          } catch {
            // ignore (missing_ok)
          }
        }
      }
    } catch {
      continue;
    }
  }
  // Sweep orphaned lock/flock sidecars whose .json was removed in a prior run.
  for (const sidecarSuffix of [".json.lock", ".json.flock"]) {
    for (const sidecar of _glob(sessionsDir, sidecarSuffix)) {
      const base = path.basename(sidecar);
      const stem = base.split(".json.")[0] ?? base;
      if (!fs.existsSync(path.join(sessionsDir, `${stem}.json`))) {
        try {
          fs.unlinkSync(sidecar);
        } catch {
          // ignore
        }
      }
    }
  }
  if (removed > 0) {
    _LOG.info("_cleanup_old_sessions: removed %d stale session JSON(s)", removed);
  }
  return removed;
}

/**
 * Run all self-healing tasks on daemon startup. Returns a summary with counts
 * and failures. Each task runs independently; a failure is caught, recorded in
 * `failures`, and does not prevent remaining tasks from running.
 */
export function cleanup_on_startup(): CleanupStats {
  const stats: CleanupStats = {
    stale_locks_cleared: 0,
    stale_index_markers_cleared: 0,
    logs_deleted: 0,
    image_bytes_evicted: 0,
    image_files_evicted: 0,
    stats_rows_pruned: 0,
    orphaned_projects_removed: 0,
    old_sessions_removed: 0,
    orphaned_state_files_deleted: 0,
    old_sentinels_deleted: 0,
  };
  const failures: string[] = [];

  const intTasks: [string, () => number, keyof CleanupStats][] = [
    ["stale_locks", _cleanup_stale_locks, "stale_locks_cleared"],
    ["old_logs", _cleanup_old_logs, "logs_deleted"],
    ["stats_prune", _prune_stats_table, "stats_rows_pruned"],
    ["snapshots", _cleanup_stale_snapshots, "snapshots_cleared"],
    ["bash_outputs", _evict_bash_outputs, "bash_outputs_evicted"],
    ["web_outputs", _evict_web_outputs, "web_outputs_evicted"],
    ["wal_checkpoint", _checkpoint_global_wal, "wal_bytes_reclaimed"],
    ["project_wal_checkpoint", _checkpoint_project_wals, "project_wal_bytes_reclaimed"],
    ["gc_orphaned_projects", _gc_orphaned_projects, "orphaned_projects_removed"],
    ["old_sessions", _cleanup_old_sessions, "old_sessions_removed"],
    ["orphaned_state_files", _cleanup_orphaned_state_files, "orphaned_state_files_deleted"],
    ["old_sentinels", _cleanup_old_sentinels, "old_sentinels_deleted"],
  ];
  for (const [taskName, taskFn, statKey] of intTasks) {
    try {
      const resultInt = taskFn();
      (stats[statKey] as number) = resultInt;
    } catch (exc) {
      _LOG.error("cleanup task %s failed: %s", taskName, exc);
      failures.push(`${taskName}: ${_excName(exc)}: ${String(exc)}`);
    }
  }

  // Stale index-spawn markers — already has its own error handling.
  try {
    stats.stale_index_markers_cleared = reap_stale_index_markers();
  } catch (exc) {
    _LOG.error("cleanup task stale_index_markers failed: %s", exc);
    failures.push(`stale_index_markers: ${_excName(exc)}: ${String(exc)}`);
  }

  // Clear stale image-cache eviction lock before attempting eviction.
  try {
    _clear_stale_eviction_lock();
  } catch (exc) {
    _LOG.error("cleanup task clear_stale_eviction_lock failed: %s", exc);
    failures.push(`clear_stale_eviction_lock: ${_excName(exc)}: ${String(exc)}`);
  }

  // Image LRU eviction — already has its own error handling.
  try {
    const [bytesEvicted, filesEvicted] = evict_image_cache_if_over_limit();
    stats.image_bytes_evicted = bytesEvicted;
    stats.image_files_evicted = filesEvicted;
  } catch (exc) {
    _LOG.error("cleanup task image_eviction failed: %s", exc);
    failures.push(`image_eviction: ${_excName(exc)}: ${String(exc)}`);
  }

  if (failures.length) {
    stats.failures = failures;
  }
  _LOG.info(
    "startup cleanup complete: locks_cleared=%d index_markers_cleared=%d logs_deleted=%d " +
      "stats_rows_pruned=%d image_bytes_evicted=%d image_files_evicted=%d " +
      "snapshots_cleared=%d bash_outputs_evicted=%d web_outputs_evicted=%d wal_bytes_reclaimed=%d " +
      "orphaned_projects_removed=%d old_sessions_removed=%d orphaned_state_files_deleted=%d " +
      "old_sentinels_deleted=%d%s",
    stats.stale_locks_cleared ?? 0,
    stats.stale_index_markers_cleared ?? 0,
    stats.logs_deleted ?? 0,
    stats.stats_rows_pruned ?? 0,
    stats.image_bytes_evicted ?? 0,
    stats.image_files_evicted ?? 0,
    stats.snapshots_cleared ?? 0,
    stats.bash_outputs_evicted ?? 0,
    stats.web_outputs_evicted ?? 0,
    stats.wal_bytes_reclaimed ?? 0,
    stats.orphaned_projects_removed ?? 0,
    stats.old_sessions_removed ?? 0,
    stats.orphaned_state_files_deleted ?? 0,
    stats.old_sentinels_deleted ?? 0,
    failures.length ? ` failures=${JSON.stringify(failures)}` : "",
  );
  return stats;
}

/** `type(exc).__name__` analogue. */
function _excName(exc: unknown): string {
  if (exc instanceof Error) {
    return exc.constructor.name;
  }
  return typeof exc;
}

/** Stale eviction lock age (seconds). */
export const _EVICTION_LOCK_STALE_SECONDS = 120.0;

/** Return true if lockPath is older than _EVICTION_LOCK_STALE_SECONDS. */
export function _eviction_lock_is_stale(lockPath: string, now?: number): boolean {
  let age: number;
  try {
    age = (now ?? _now()) - fs.statSync(lockPath).mtimeMs / 1000;
  } catch {
    return false;
  }
  return age > _EVICTION_LOCK_STALE_SECONDS;
}

/** Atomically claim the eviction lock. Returns the fd, or null. */
export function _acquire_eviction_lock(lockPath: string): number | null {
  const flags = fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY;
  let fd: number;
  try {
    fd = fs.openSync(lockPath, flags, 0o600);
  } catch (e) {
    const err = e as NodeJS.ErrnoException;
    if (err.code !== "EEXIST") {
      throw e;
    }
    if (_eviction_lock_is_stale(lockPath)) {
      _LOG.info("clearing stale image-cache eviction lock at %s", lockPath);
      try {
        fs.unlinkSync(lockPath);
      } catch {
        // ignore
      }
      try {
        fd = fs.openSync(lockPath, flags, 0o600);
      } catch (e2) {
        const err2 = e2 as NodeJS.ErrnoException;
        if (err2.code === "EEXIST") {
          _LOG.warning(
            "image-cache eviction lock contention: another process holds %s",
            lockPath,
          );
          return null;
        }
        throw e2;
      }
    } else {
      _LOG.warning(
        "image-cache eviction lock contention: another process holds %s (lock is fresh)",
        lockPath,
      );
      return null;
    }
  }
  try {
    fs.writeSync(fd, `${process.pid}\n${_now()}\n`);
  } catch {
    // best-effort PID stamp
  }
  return fd;
}

/** Clear stale image-cache eviction lock at startup. Never raises. */
export function _clear_stale_eviction_lock(): void {
  const lockPath = path.join(paths.locksDir(), "image_cache_eviction.lock");
  if (!fs.existsSync(lockPath)) {
    return;
  }
  try {
    if (_eviction_lock_is_stale(lockPath)) {
      try {
        fs.unlinkSync(lockPath);
      } catch {
        // ignore
      }
      _LOG.info("cleared stale image-cache eviction lock at startup: %s", lockPath);
    }
  } catch (exc) {
    _LOG.debug("_clear_stale_eviction_lock failed: %s", exc);
  }
}

/**
 * LRU-evict image cache entries if total size exceeds IMAGE_CACHE_LIMIT.
 * Returns [bytes_freed, files_freed]. Both 0 when within the limit, the dir does
 * not exist, or another evictor holds the lock.
 */
export function evict_image_cache_if_over_limit(): [number, number] {
  const imgDir = paths.imageCacheDir();
  if (!fs.existsSync(imgDir)) {
    _LOG.debug("image cache directory does not exist");
    return [0, 0];
  }

  const lockPath = path.join(paths.locksDir(), "image_cache_eviction.lock");
  try {
    paths.ensureDir(path.dirname(lockPath));
  } catch {
    // ignore
  }
  const lockFd = _acquire_eviction_lock(lockPath);
  if (lockFd === null) {
    _LOG.debug("image cache eviction already in progress; skipping this pass");
    return [0, 0];
  }

  try {
    const cacheEntries: [string, number, number][] = []; // [path, mtime, size]
    let totalBytes = 0;
    let names: string[];
    try {
      names = fs.readdirSync(imgDir);
    } catch {
      names = [];
    }
    for (const name of names) {
      const f = path.join(imgDir, name);
      let st: fs.Stats;
      try {
        st = fs.statSync(f);
      } catch {
        continue;
      }
      if (!st.isFile()) {
        continue;
      }
      cacheEntries.push([f, st.mtimeMs / 1000, st.size]);
      totalBytes += st.size;
    }
    if (totalBytes <= IMAGE_CACHE_LIMIT) {
      _LOG.debug(
        "image cache size %s MB is within limit %s MB",
        (totalBytes / (1024 * 1024)).toFixed(1),
        (IMAGE_CACHE_LIMIT / (1024 * 1024)).toFixed(1),
      );
      return [0, 0];
    }
    _LOG.warning(
      "image cache %s MB exceeds limit %s MB; starting LRU eviction",
      (totalBytes / (1024 * 1024)).toFixed(1),
      (IMAGE_CACHE_LIMIT / (1024 * 1024)).toFixed(1),
    );
    // Sort oldest-accessed first.
    cacheEntries.sort((a, b) => a[1] - b[1]);
    let bytesFreed = 0;
    let filesFreed = 0;
    for (const [f, , size] of cacheEntries) {
      if (totalBytes - bytesFreed <= IMAGE_CACHE_TARGET) {
        break;
      }
      try {
        fs.unlinkSync(f);
        bytesFreed += size;
        filesFreed += 1;
        _LOG.debug("evicted image cache file: %s (%s MB)", path.basename(f), (size / (1024 * 1024)).toFixed(1));
      } catch (e) {
        _LOG.warning("failed to evict cache file %s: %s", path.basename(f), e);
      }
    }
    if (bytesFreed > 0) {
      _LOG.info(
        "image cache eviction: freed %s MB by removing %d files",
        (bytesFreed / (1024 * 1024)).toFixed(1),
        filesFreed,
      );
    }
    return [bytesFreed, filesFreed];
  } finally {
    try {
      fs.closeSync(lockFd);
    } catch {
      // ignore
    }
    try {
      fs.unlinkSync(lockPath);
    } catch {
      // ignore
    }
  }
}

// ===========================================================================
// Spawn API (called by SessionStart watchdog)
// ===========================================================================

/** Return the Windows creationflags for a detached background process. */
function _detach_creationflags(): number {
  if (process.platform === "win32") {
    // DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP | CREATE_NO_WINDOW
    return 0x00000008 | 0x00000200 | 0x08000000;
  }
  return 0;
}

/**
 * Spawn the token-goat worker as a detached background process.
 * Returns PID or null on failure.
 */
export function spawn_detached(): number | null {
  const cmd = paths.pythonRunnerArgv("worker", "--daemon");
  const creationflags = _detach_creationflags();

  if (_noWorkerSpawn()) {
    _LOG.debug("spawn_detached suppressed: TOKEN_GOAT_NO_WORKER_SPAWN is set");
    return null;
  }

  // Capture the spawned worker's stderr to a file rather than DEVNULL. A worker
  // that fails before its logging FileHandler is attached would otherwise die
  // with no trace at all. Python opens the file itself (open(stderr_path, "a"))
  // BEFORE Popen, so the crash sink exists on disk even when the spawn is
  // mocked; mirror that here by pre-creating/reopening the file in append mode
  // after rolling an oversized one (the rename leaves a fresh empty file).
  let stderrPath: string | null = null;
  try {
    const sp = path.join(paths.logsDir(), "worker-stderr.log");
    paths.ensureDir(path.dirname(sp));
    paths.rollLogIfOversized(sp, STDERR_LOG_MAX_BYTES);
    // open(stderr_path, "a") analogue: create the file (or no-op if present) so
    // the crash sink exists before the child is launched. The parent's handle is
    // closed immediately; the child opens its own via the stderrPath seam.
    const fd = fs.openSync(sp, "a");
    fs.closeSync(fd);
    stderrPath = sp;
  } catch (e) {
    _LOG.warning("could not open worker stderr log, falling back to DEVNULL: %s", e);
  }

  let child: SpawnedChild | null;
  try {
    child = _spawnImpl(cmd, { stderrPath, creationflags });
  } catch (e) {
    _LOG.error("failed to spawn worker: %s", e);
    return null;
  }
  if (child === null || child.pid === undefined) {
    _LOG.error("failed to spawn worker: spawn returned no child/pid");
    return null;
  }
  _LOG.info("worker spawned: pid=%d cmd=%s", child.pid, cmd.join(" "));
  return child.pid;
}

/** A spawn marker older than this is treated as stale (hung index). */
export const INDEX_SPAWN_TTL = 600.0; // 10 min

/** True if marker records an index spawn that is still running and fresh. */
export function _index_spawn_active(marker: string): boolean {
  let pid: number;
  let ts: number;
  try {
    const raw = fs.readFileSync(marker, "utf-8");
    const nl = raw.indexOf("\n");
    if (nl < 0) {
      throw new Error("no newline in marker");
    }
    pid = Number.parseInt(raw.slice(0, nl), 10);
    ts = Number.parseFloat(raw.slice(nl + 1).trim());
    if (!Number.isFinite(pid) || !Number.isFinite(ts)) {
      throw new Error("malformed marker");
    }
  } catch {
    return false; // missing or malformed marker — not active
  }
  if (_now() - ts > INDEX_SPAWN_TTL) {
    return false; // stale — a hung index
  }
  if (!_pidExists(pid)) {
    return false;
  }
  const cmd = _procCmdline(pid);
  if (cmd !== null) {
    const cmdline = cmd.join(" ").toLowerCase();
    if (!cmdline.includes("token_goat") && pid !== process.pid) {
      _LOG.debug(
        "_index_spawn_active: PID %d alive but cmdline lacks token_goat; treating as recycled",
        pid,
      );
      return false;
    }
  }
  return true;
}

/** Delete `.indexing` spawn markers whose index process is gone or hung. */
export function reap_stale_index_markers(): number {
  const locks = paths.locksDir();
  if (!fs.existsSync(locks)) {
    return 0;
  }
  let cleared = 0;
  for (const marker of _glob(locks, ".indexing")) {
    if (_index_spawn_active(marker)) {
      _LOG.debug("index marker %s is still active; skipping", path.basename(marker));
      continue;
    }
    try {
      fs.unlinkSync(marker);
      cleared += 1;
      _LOG.debug("reaped stale index marker: %s", path.basename(marker));
    } catch (e) {
      _LOG.warning("failed to remove stale index marker %s: %s", path.basename(marker), e);
    }
  }
  if (cleared) {
    _LOG.info("reaped %d stale index marker(s)", cleared);
  }
  return cleared;
}

/** Spawn `token-goat index --full` from the given project root, detached. */
export function spawn_index_detached(projectRoot: string, projectHash: string): number | null {
  try {
    db._validateProjectHash(projectHash);
  } catch (exc) {
    _LOG.warning("spawn_index_detached: rejecting invalid project_hash %s: %s", projectHash, exc);
    return null;
  }

  if (!path.isAbsolute(projectRoot)) {
    _LOG.warning(
      "spawn_index_detached: rejecting non-absolute project_root %s for %s",
      projectRoot,
      projectHash.slice(0, 8),
    );
    return null;
  }
  try {
    if (!fs.statSync(projectRoot).isDirectory()) {
      _LOG.warning(
        "spawn_index_detached: project_root %s is not a directory for %s; skipping",
        projectRoot,
        projectHash.slice(0, 8),
      );
      return null;
    }
  } catch (exc) {
    _LOG.warning(
      "spawn_index_detached: could not stat project_root %s for %s: %s",
      projectRoot,
      projectHash.slice(0, 8),
      exc,
    );
    return null;
  }

  const marker = path.join(paths.locksDir(), `${projectHash}.indexing`);
  if (_index_spawn_active(marker)) {
    _LOG.info("auto-index skipped for %s — an index spawn is already running", projectHash.slice(0, 8));
    return null;
  }

  if (_noWorkerSpawn()) {
    _LOG.debug("spawn_index_detached suppressed: TOKEN_GOAT_NO_WORKER_SPAWN is set");
    return null;
  }

  const cmd = paths.pythonRunnerArgv("index", "--full");
  const creationflags = _detach_creationflags();

  let logPath: string | null = null;
  try {
    logPath = path.join(paths.logsDir(), "index-spawn.log");
  } catch (e) {
    _LOG.warning("could not open log file for index spawn stderr: %s", e);
  }

  let child: SpawnedChild | null;
  try {
    child = _spawnImpl(cmd, { cwd: projectRoot, stderrPath: logPath, creationflags });
  } catch (e) {
    _LOG.error("failed to spawn auto-index: %s", e);
    return null;
  }
  if (child === null || child.pid === undefined) {
    _LOG.error("failed to spawn auto-index: spawn returned no child/pid");
    return null;
  }

  // Record the spawn so concurrent SessionStart hooks don't pile on.
  try {
    paths.atomicWriteText(marker, `${child.pid}\n${_now()}`);
  } catch {
    // ignore
  }
  _LOG.info("auto-index spawned for %s (root=%s, pid=%d)", projectHash.slice(0, 8), projectRoot, child.pid);
  return child.pid;
}

/** Seconds since the worker last heartbeat, or null. Thin alias. */
function _heartbeat_age(): number | null {
  return self.heartbeat_age();
}

/** True if pid is a live process whose command line is a token-goat worker. */
export function _is_token_goat_worker(pid: number): boolean {
  const cmd = _procCmdline(pid);
  if (cmd === null) {
    _LOG.debug("_is_token_goat_worker pid=%s: cmdline unavailable", pid);
    return false;
  }
  const cmdline = cmd.join(" ").toLowerCase();
  return cmdline.includes("token_goat") && cmdline.includes("worker");
}

/** PID from the pid file, but only if it names a live token-goat-worker process. */
export function _live_worker_pid(): number | null {
  let pid: number;
  try {
    [pid] = _read_pid_info(fs.readFileSync(paths.workerPidPath(), "utf-8"));
  } catch {
    return null;
  }

  if (!_pidExists(pid)) {
    return null;
  }

  const cmd = _procCmdline(pid);
  if (cmd !== null) {
    const cmdline = cmd.join(" ").toLowerCase();
    if (!cmdline.includes("token_goat") || !cmdline.includes("worker")) {
      return null; // PID recycled to an unrelated process
    }
  }

  return pid;
}

/** Terminate the worker iff it is alive but its heartbeat proves it is hung. */
export function _reap_hung_worker(): boolean {
  const pid = self._live_worker_pid();
  if (pid === null) {
    return false;
  }
  const age = _heartbeat_age();
  if (age === null || age < WORKER_HUNG_THRESHOLD) {
    return false; // no heartbeat yet, or busy-not-hung
  }
  _LOG.warning("reaping hung worker pid=%s (heartbeat %ss stale)", pid, age.toFixed(0));
  _procTerminateAndWait(pid);
  return true;
}

/** SIGTERM the pid, wait up to 3s, SIGKILL if still alive (psutil terminate/wait/kill). */
function _procTerminateAndWait(pid: number): void {
  try {
    process.kill(pid, "SIGTERM");
  } catch (e) {
    const err = e as NodeJS.ErrnoException;
    if (err.code === "ESRCH") {
      _LOG.debug("hung worker pid=%s already gone by the time we tried to reap it", pid);
      return;
    }
    if (err.code === "EPERM") {
      _LOG.warning("reap hung worker pid=%s: access denied — %s", pid, e);
      return;
    }
  }
  // Poll for exit up to ~3s without a blocking wait (no async here).
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) {
    if (!_pidExists(pid)) {
      return;
    }
    _sleepMsBusy(50);
  }
  _LOG.warning("hung worker pid=%s did not exit after SIGTERM; sending SIGKILL", pid);
  try {
    process.kill(pid, "SIGKILL");
  } catch {
    // ignore — already gone or no permission
  }
}

/**
 * Idempotent watchdog: ensure exactly one healthy worker is running. Returns the
 * worker PID (existing or freshly spawned), or null on spawn failure.
 */
export function ensure_running(): number | null {
  if (self.is_worker_alive()) {
    try {
      const [pid] = _read_pid_info(fs.readFileSync(paths.workerPidPath(), "utf-8"));
      return pid;
    } catch (e) {
      _LOG.debug("worker is alive but pid file unreadable: %s", e);
      return null;
    }
  }

  // No healthy worker. Reap a hung one if present; otherwise a live process is
  // merely busy — don't disturb it.
  const reaped = self._reap_hung_worker();
  if (!reaped) {
    const busyPid = self._live_worker_pid();
    if (busyPid !== null) {
      return busyPid;
    }
  }

  // Either nothing was running, or we just reaped a hung worker. Clear stale
  // pid/claim state so the fresh worker can take the slot cleanly.
  self._clear_pid();
  try {
    fs.unlinkSync(_worker_claim_path());
  } catch {
    // ignore
  }
  return self.spawn_detached();
}

// ===========================================================================
// Main run loop (daemon mode)
// ===========================================================================

/**
 * Self-register the worker for at-logon autostart. Fail-soft: an error here must
 * never take the worker down. (Function-level use of `install` keeps the ESM
 * circular import safe.)
 */
export function _register_autostart(): void {
  try {
    let ok: boolean;
    let detail: string;
    if (process.platform === "win32") {
      [ok, detail] = install.install_worker_task();
    } else if (process.platform === "darwin") {
      [ok, detail] = install.install_mac_autostart();
    } else {
      [ok, detail] = install.install_linux_autostart();
    }
    _LOG.info("autostart self-register: %s", ok ? detail : "failed — " + detail);
  } catch (e) {
    _LOG.error("autostart self-register failed: %s", e);
  }
}

/** Compatibility wrapper around worker_daemon.run_daemon. */
export async function run_daemon(stopEvent?: StopEvent): Promise<void> {
  await worker_daemon.run_daemon(stopEvent);
}

// ===========================================================================
// Periodic reindex
// ===========================================================================

/** Incrementally re-index every recently-active project. */
export function _reindex_active_projects(): void {
  _LOG.debug("starting periodic reindex cycle");

  if (_is_under_memory_pressure()) {
    _LOG.info("memory pressure: skipping periodic reindex cycle");
    return;
  }

  const cutoff = Math.trunc(_now() - PERIODIC_REINDEX_ACTIVE_WINDOW);
  let rows: { hash: string; root: string; marker: string; file_count: number }[];
  try {
    rows = db.openGlobalReadonly(
      (gconn: DatabaseType): { hash: string; root: string; marker: string; file_count: number }[] => {
        return gconn
          .prepare("SELECT hash, root, marker, file_count FROM projects WHERE last_seen >= ?")
          .all(cutoff) as { hash: string; root: string; marker: string; file_count: number }[];
      },
    );
  } catch (exc) {
    _LOG.error("could not query active projects for reindex: %s", exc);
    return;
  }

  if (rows.length === 0) {
    _LOG.debug("periodic reindex: no active projects within window");
    return;
  }

  _LOG.info("periodic reindex: %d active project(s) to check", rows.length);
  let reindexedCount = 0;
  let skippedOversized = 0;
  for (const row of rows) {
    if (row.file_count > PERIODIC_REINDEX_MAX_FILES) {
      _LOG.info(
        "periodic reindex: skipping %s — %d files exceeds limit of %d " +
          "(set PERIODIC_REINDEX_MAX_FILES higher to include it)",
        row.root,
        row.file_count,
        PERIODIC_REINDEX_MAX_FILES,
      );
      skippedOversized += 1;
      continue;
    }
    const ph = row.hash;
    if (_should_skip_due_to_backoff(ph, "<project>")) {
      _LOG.info("backoff: skipping periodic reindex for project %s", ph.slice(0, 8));
      continue;
    }
    const proj: Project = { root: row.root, hash: ph, marker: row.marker };
    try {
      const rawSummary = _run_index_with_timeout(proj, false, INDEX_TIMEOUT_SECS);
      if (rawSummary === null) {
        _record_index_failure(ph, "<project>");
        continue;
      }
      _record_index_success(ph, "<project>");
      const summary = _syncIndexSummary(rawSummary);
      const indexed = Number(summary["indexed"] ?? 0);
      const errors = Number(summary["errors"] ?? 0);
      if (indexed > 0 || errors > 0) {
        _LOG.info(
          "periodic reindex: root=%s indexed=%d skipped=%d errors=%d dur=%ss",
          row.root,
          summary["indexed"],
          summary["skipped_unchanged"],
          summary["errors"],
          Number(summary["duration_sec"] ?? 0).toFixed(2),
        );
        reindexedCount += 1;
      } else {
        _LOG.debug("periodic reindex: root=%s no changes", row.root);
      }
      // Refresh git-history hints in the durable worker (idempotent, 1h gated).
      git_history.index_project_history(proj.root, proj.hash);
    } catch (exc) {
      _LOG.error("periodic reindex failed for %s: %s", row.root, exc);
      _record_index_failure(ph, "<project>");
    }
  }
  if (skippedOversized > 0) {
    _LOG.info(
      "periodic reindex: skipped %d project(s) with > %d files (increase PERIODIC_REINDEX_MAX_FILES to include them)",
      skippedOversized,
      PERIODIC_REINDEX_MAX_FILES,
    );
  }
  _LOG.debug(
    "periodic reindex cycle complete: %d processed, %d skipped (oversized)",
    reindexedCount,
    skippedOversized,
  );
}

/** Validate and group raw queue entries by project hash. */
export function _parse_and_group_entries(entries: DirtyQueueEntry[]): Map<string, _ProjectBucket> {
  const byProject = new Map<string, _ProjectBucket>();
  for (const entry of entries) {
    const ph = entry.project_hash;
    const rel = entry.path;
    if (!ph || !rel) {
      _LOG.debug("skipping malformed queue entry (missing hash or path)");
      continue;
    }
    try {
      db._validateProjectHash(ph);
    } catch {
      _LOG.warning("dirty queue: skipping entry with invalid project_hash %s", ph);
      continue;
    }
    if (!paths.isSafeRelPath(rel)) {
      _LOG.warning("dirty queue: skipping entry with unsafe rel path %s", rel);
      continue;
    }
    let bucket = byProject.get(ph);
    if (bucket === undefined) {
      bucket = { rels: new Set<string>(), root: null, marker: null };
      byProject.set(ph, bucket);
    }
    bucket.rels.add(rel);
    if (bucket.root === null && entry.project_root) {
      bucket.root = entry.project_root;
      const rawMarker = entry.project_marker || "manual";
      bucket.marker = sanitize_log_str(String(rawMarker), _MAX_QUEUE_MARKER_LEN) || "manual";
    }
  }
  return byProject;
}

/** Batch-fetch project rows from global.db for the given hashes. */
function _lookup_known_projects(hashes: string[]): Map<string, { hash: string; root: string; marker: string }> {
  const out = new Map<string, { hash: string; root: string; marker: string }>();
  if (hashes.length === 0) {
    return out;
  }
  const placeholders = hashes.map(() => "?").join(",");
  try {
    db.openGlobal((gconn: DatabaseType): void => {
      const rows = gconn
        .prepare(`SELECT hash, root, marker FROM projects WHERE hash IN (${placeholders})`)
        .all(...hashes) as { hash: string; root: string; marker: string }[];
      for (const row of rows) {
        out.set(row.hash, row);
      }
    });
    return out;
  } catch (exc) {
    _LOG.warning(
      "dirty queue: global.db lookup failed for %d project(s): %s — " +
        "will fall back to queue-entry metadata where available",
      hashes.length,
      exc,
    );
    return new Map();
  }
}

/** Resolve a Project and first-index flag from a dirty-queue bucket. */
function _resolve_project_from_bucket(
  ph: string,
  bucket: _ProjectBucket,
  knownRow: { hash: string; root: string; marker: string } | null,
): [Project, boolean] | null {
  if (knownRow) {
    const project: Project = { root: knownRow.root, hash: ph, marker: knownRow.marker };
    _LOG.debug(
      "dirty queue: project %s known (root=%s), running incremental index",
      ph.slice(0, 8),
      knownRow.root,
    );
    return [project, false];
  }

  if (bucket.root) {
    const rawRoot = bucket.root;
    if (!path.isAbsolute(rawRoot)) {
      _LOG.warning("dirty queue: project %s root %s is not absolute; dropping", ph.slice(0, 8), rawRoot);
      return null;
    }
    let rootIsDir: boolean;
    try {
      rootIsDir = fs.statSync(rawRoot).isDirectory();
    } catch {
      rootIsDir = false;
    }
    if (!rootIsDir) {
      _LOG.warning(
        "dirty queue: project %s root %s is not an existing directory; dropping",
        ph.slice(0, 8),
        rawRoot,
      );
      return null;
    }
    const project: Project = { root: rawRoot, hash: ph, marker: bucket.marker || "manual" };
    _LOG.info(
      "dirty queue: project %s not yet registered (root=%s); running first index",
      ph.slice(0, 8),
      bucket.root,
    );
    return [project, true];
  }

  _LOG.warning("dirty queue refers to unknown project hash %s with no root; dropping", ph);
  return null;
}

/** Return the configured (and ceiling-clamped) max_pool_workers value. */
export function _get_max_pool_workers(): number {
  try {
    return config.load().worker?.max_pool_workers ?? 1;
  } catch {
    return 1;
  }
}

/**
 * Run parser.index_project with a wall-clock timeout.
 *
 * Python uses a ThreadPoolExecutor with future.result(timeout). The TS parser
 * is ported but async (the web-tree-sitter grammar load is async); this calls
 * the registered parser seam and forwards whatever it returns — a synchronous
 * stub returns a plain dict, the real module returns a Promise. When no parser
 * is registered, it returns null — exactly the "treat this project as a failure"
 * contract a timeout produces. The *timeout* / *max_workers* / pool ceiling are
 * honoured as documentation parity; with an in-process call there is no thread
 * to bound, so the wall-clock cancel is a no-op here.
 */
export function _run_index_with_timeout(
  project: Project,
  full: boolean,
  timeout: number,
  opts: { max_workers?: number | null } = {},
): Record<string, unknown> | null | Promise<Record<string, unknown> | null> {
  const poolSizeRaw = opts.max_workers != null ? opts.max_workers : self._get_max_pool_workers();
  // Clamp to [1, WORKER_MAX_POOL_CEILING] for parity (unused without a thread pool).
  void Math.max(1, Math.min(poolSizeRaw, config.WORKER_MAX_POOL_CEILING));
  if (_parserModule === null) {
    _LOG.debug(
      "index_project skipped for project %s (root=%s): parser module not registered",
      String(project.hash).slice(0, 8),
      project.root,
    );
    return null;
  }
  try {
    return _parserModule.index_project(project, { full });
  } catch (exc) {
    _LOG.error("index_project raised for project %s (root=%s): %s", String(project.hash).slice(0, 8), project.root, exc);
    void timeout;
    return null;
  }
}

/**
 * Narrow a {@link _run_index_with_timeout} result for synchronous count
 * inspection. A synchronous stub returns a plain summary dict; the real parser
 * returns a Promise<dict> (the grammar load is async). The synchronous worker
 * call-chain cannot await it, so a Promise narrows to an empty dict — the real
 * parser has already performed its own DB writes inside index_project, and the
 * worker's count logging is best-effort. A non-Promise summary passes through.
 */
function _syncIndexSummary(
  summary: Record<string, unknown> | Promise<Record<string, unknown> | null>,
): Record<string, unknown> {
  if (summary !== null && typeof (summary as { then?: unknown }).then === "function") {
    return {};
  }
  return summary as Record<string, unknown>;
}

/** Purge skill cache entries for any dirty queue entries that are skill files. */
export function _invalidate_skill_cache_entries(entries: DirtyQueueEntry[]): void {
  const skillHint = (`.claude${path.sep}skills`).toLowerCase();
  const skillHintFwd = ".claude/skills";

  const candidateEntries = entries.filter((e) => {
    const p = (e.path ?? "").toLowerCase();
    return p.includes(skillHintFwd) || p.includes(skillHint);
  });
  if (candidateEntries.length === 0) {
    return;
  }

  for (const entry of candidateEntries) {
    const rel = entry.path ?? "";
    const root = entry.project_root ?? "";
    if (!rel) {
      continue;
    }
    const fullPath = root ? path.join(root, rel) : rel;
    const n = skill_cache.invalidate_for_path(fullPath);
    if (n > 0) {
      _LOG.info(
        "dirty queue: invalidated %d skill cache entr%s for edited path %s",
        n,
        n === 1 ? "y" : "ies",
        sanitize_log_str(fullPath, 120),
      );
    }
  }
}

/** Re-index files that were marked dirty by Edit/Write/MultiEdit hooks. */
export function _process_dirty_entries(entries: DirtyQueueEntry[]): void {
  _LOG.debug("processing %d dirty queue entries", entries.length);
  const batchT0 = _now();

  // Skill cache invalidation runs before the re-index. Fail-soft.
  try {
    _invalidate_skill_cache_entries(entries);
  } catch {
    _LOG.debug("skill cache invalidation failed (non-fatal)");
  }

  if (_is_under_memory_pressure()) {
    _LOG.info("memory pressure: skipping dirty-queue indexing (%d entries deferred)", entries.length);
    return;
  }

  const byProject = _parse_and_group_entries(entries);
  _LOG.debug("grouped into %d projects", byProject.size);

  const knownProjects = _lookup_known_projects([...byProject.keys()]);

  let projectsProcessed = 0;
  for (const [ph, bucket] of byProject) {
    if (_should_skip_due_to_backoff(ph, "<project>")) {
      _LOG.info("backoff: skipping project %s this cycle", ph.slice(0, 8));
      continue;
    }
    try {
      const resolved = _resolve_project_from_bucket(ph, bucket, knownProjects.get(ph) ?? null);
      if (resolved === null) {
        continue;
      }
      const [project, isFirstIndex] = resolved;

      const t0 = _now();
      const rawResult = _run_index_with_timeout(project, isFirstIndex, INDEX_TIMEOUT_SECS);
      const elapsed = _now() - t0;

      if (rawResult === null) {
        _record_index_failure(ph, "<project>");
        continue;
      }

      _record_index_success(ph, "<project>");
      projectsProcessed += 1;
      const result = _syncIndexSummary(rawResult);
      const errors = Number(result["errors"] ?? 0);
      if (errors > 0) {
        _LOG.warning(
          "reindexed %d/%d files in project %s after dirty queue drain (errors=%d dur=%ss)",
          result["indexed"],
          result["total_files"],
          ph.slice(0, 8),
          result["errors"],
          elapsed.toFixed(2),
        );
      } else {
        _LOG.info(
          "reindexed %d/%d files in project %s after dirty queue drain (dur=%ss)",
          result["indexed"],
          result["total_files"],
          ph.slice(0, 8),
          elapsed.toFixed(2),
        );
      }
    } catch (exc) {
      _LOG.error("failed to reindex project %s from dirty queue: %s", ph, exc);
      _record_index_failure(ph, "<project>");
    }
  }
  const batchElapsed = _now() - batchT0;
  _LOG.debug(
    "finished processing dirty entries: %d/%d projects reindexed (batch dur=%ss)",
    projectsProcessed,
    byProject.size,
    batchElapsed.toFixed(2),
  );
}

// ===========================================================================
// Abortable stop signal (threading.Event analogue, shared with worker_daemon)
// ===========================================================================

/**
 * Minimal threading.Event analogue used by run_daemon / WatchdogThread.
 *
 * Python's threading.Event has set()/is_set()/wait(timeout). The TS port models
 * the same surface but `wait` is async (returns a Promise that resolves either
 * when the timeout elapses OR when set() is called — whichever comes first), so
 * the daemon loop is a cooperatively-abortable async task that a test resolves
 * by calling set(). NO test ever blocks on a live daemon: it constructs a
 * StopEvent, kicks run_daemon (without awaiting, or with a microtask yield),
 * then calls stop.set() to unwind the loop.
 */
export class StopEvent {
  private _set = false;
  private _waiters: (() => void)[] = [];

  is_set(): boolean {
    return this._set;
  }

  set(): void {
    if (this._set) {
      return;
    }
    this._set = true;
    const waiters = this._waiters;
    this._waiters = [];
    for (const w of waiters) {
      w();
    }
  }

  /**
   * Resolve after `timeoutSecs` seconds, or immediately when set() is called —
   * whichever happens first. Returns true if the event was set, false on
   * timeout (mirrors threading.Event.wait's bool return).
   */
  wait(timeoutSecs: number): Promise<boolean> {
    if (this._set) {
      return Promise.resolve(true);
    }
    return new Promise<boolean>((resolve) => {
      let done = false;
      const timer = setTimeout(() => {
        if (done) {
          return;
        }
        done = true;
        const idx = this._waiters.indexOf(onSet);
        if (idx >= 0) {
          this._waiters.splice(idx, 1);
        }
        resolve(false);
      }, Math.max(0, timeoutSecs * 1000));
      // Don't keep the event loop alive solely for this timer.
      if (typeof timer.unref === "function") {
        timer.unref();
      }
      const onSet = (): void => {
        if (done) {
          return;
        }
        done = true;
        clearTimeout(timer);
        resolve(true);
      };
      this._waiters.push(onSet);
    });
  }
}

// ===========================================================================
// __all__ — public surface (incl. the _private fns worker_daemon imports)
// ===========================================================================

export const __all__ = [
  // liveness / heartbeat
  "heartbeat_stale_threshold",
  "heartbeat_age",
  "is_heartbeat_stale_for_nudge",
  "is_worker_alive",
  "_pidExists",
  // dirty queue
  "enqueue_dirty",
  "adaptive_poll_interval",
  "drain_dirty_queue",
  // self-healing / cleanup
  "cleanup_on_startup",
  "evict_image_cache_if_over_limit",
  "reap_stale_index_markers",
  "_index_spawn_active",
  // spawn API
  "spawn_detached",
  "spawn_index_detached",
  "ensure_running",
  "run_daemon",
  // internals worker_daemon imports
  "_reindex_active_projects",
  "_process_dirty_entries",
  "_clear_pid",
  "_write_pid",
  "_read_pid_info",
  "_heartbeat",
  "_installed_version",
  "_package_fingerprint",
  "_setup_logging",
  "_try_claim_worker_slot",
  "_worker_claim_path",
  "_worker_claim_is_stale",
  "_register_autostart",
  // constants
  "HEARTBEAT_INTERVAL",
  "HEARTBEAT_GRACE_SECONDS",
  "POLL_INTERVAL",
  "POLL_INTERVAL_MAX",
  "IDLE_BACKOFF_AFTER_EMPTY_DRAINS",
  "MAINTENANCE_INTERVAL",
  "PERIODIC_REINDEX_INTERVAL",
  "PERIODIC_REINDEX_MAX_FILES",
  "PERIODIC_REINDEX_ACTIVE_WINDOW",
  "STATS_RETENTION_DAYS",
  "IMAGE_CACHE_LIMIT",
  "IMAGE_CACHE_TARGET",
  "LOG_RETENTION_DAYS",
  "DIRTY_QUEUE_MAX_ENTRIES",
  "DIRTY_QUEUE_MAX_BYTES",
  "STDERR_LOG_MAX_BYTES",
  "WORKER_STARTUP_GRACE",
  "WORKER_HUNG_THRESHOLD",
  "VERSION_CHECK_INTERVAL",
  "WORKER_RESTART_THROTTLE_SECS",
  "INDEX_TIMEOUT_SECS",
  "MEMORY_PRESSURE_THRESHOLD_MB",
  "GC_PROJECTS_INTERVAL",
  "INDEX_SPAWN_TTL",
  "_BOOTED_VERSION",
  "_BOOTED_FINGERPRINT",
  // test seams
  "_setParserModule",
  "_setSpawnImpl",
  "_setProcessIntrospection",
  "_setBootedVersion",
  "_setBootedFingerprint",
  "_setImageCacheLimit",
  "_setImageCacheTarget",
  "StopEvent",
  // module internals the Python tests import directly (cleanup / self-healing)
  "_cleanup_stale_locks",
  "_cleanup_old_logs",
  "_prune_stats_table",
  "_cleanup_stale_snapshots",
  "_evict_bash_outputs",
  "_evict_web_outputs",
  "_checkpoint_global_wal",
  "_checkpoint_project_wals",
  "_cleanup_old_sessions",
  "_parse_and_group_entries",
  // process / liveness introspection
  "_proc_create_time",
  "_is_process_recent",
  "_is_token_goat_worker",
  "_live_worker_pid",
  "_reap_hung_worker",
  // eviction lock
  "_eviction_lock_is_stale",
  "_acquire_eviction_lock",
  "_clear_stale_eviction_lock",
  "_EVICTION_LOCK_STALE_SECONDS",
  // dirty-queue lock
  "_dirty_queue_lock",
  // per-file indexing backoff
  "_index_failure_counts",
  "_index_backoff_until",
  "_record_index_failure",
  "_record_index_success",
  "_should_skip_due_to_backoff",
  "_BACKOFF_FAILURE_THRESHOLD",
  "_BACKOFF_MAX_SECS",
  // memory pressure
  "_is_under_memory_pressure",
  "_get_rss_mb",
  // index timeout / pool
  "_run_index_with_timeout",
  "_get_max_pool_workers",
] as const;
