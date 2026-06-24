/**
 * Session-context cache: tracks files, line ranges, and symbols read in the
 * current session. Faithful port of src/token_goat/session.py (the persistence
 * heart of token-goat — the largest module).
 *
 * Each Claude Code session gets a SessionCache JSON file keyed by the session
 * ID. Hooks populate it on every Read, Grep, Glob, and Edit tool call; the
 * pre-read hook reads it to emit "you already read lines X-Y of this file"
 * nudges that prevent the model from pulling in content it already holds.
 *
 * Concurrency model (Parity notes — Python → TS)
 * ----------------------------------------------
 *  - Python's `threading.Lock` (`_FILE_LOCK`) serialised same-process threads.
 *    Node's main module is single-threaded, so `_FILE_LOCK` is modelled as a
 *    trivial no-op guard (`withFileLock`). The REAL correctness mechanism — the
 *    on-disk advisory lock + the compare-and-swap (version-counter) read-modify
 *    -write inside save() — is ported faithfully and is what actually prevents
 *    lost updates across the one-process-per-tool-call model Claude Code uses.
 *  - The cross-process advisory lock. Python used `fcntl.flock` (POSIX) /
 *    `msvcrt.locking` (Windows) on a persistent never-deleted sidecar lockfile;
 *    the OS dropped the lock on fd close / process death. Node has NO fcntl or
 *    msvcrt, so `_acquire_session_lock` / `_release_session_lock` implement the
 *    advisory lock with an O_EXCL PID+timestamp lockfile + a timeout/poll loop
 *    (EXACTLY the pattern db.ts's projectWriterLock uses): the lockfile content
 *    is `<pid>\n<monotonic-ish ts>` (kept for staleness diagnostics), creation
 *    via "wx" (= O_CREAT|O_EXCL|O_WRONLY) is the mutex, stale locks (owning PID
 *    dead, or older than `_LOCK_TIMEOUT_SECS`) are evicted, and the fd is
 *    unlinked on release. `_os_advisory_lock` / `_os_advisory_unlock` are kept
 *    as the low-level primitives (here implemented as the EXCL create/unlink so
 *    the public surface matches). `_session_file_lock` (the contextmanager) is
 *    ported as a higher-order function taking a callback.
 *  - The entry dataclasses (FileEntry, GrepEntry, GlobEntry, WebEntry, BashEntry,
 *    SkillEntry, DecisionEntry, ResultCacheEntry) are ported as CLASSES (not
 *    plain object literals) because the tests construct them with keyword-style
 *    args, MUTATE their fields after construction (entry.read_count += 1), and
 *    rely on per-instance identity in _merge_session_caches. Each class takes a
 *    single options object (mirroring Python kwargs), exposes public mutable
 *    fields with the same defaults, and the _serialize_* / _parse_* helpers read
 *    `entry.field`. The interface shapes in types.ts (FileEntry, …) describe the
 *    WIRE/in-memory field set; the classes `implements` those interfaces so a
 *    SessionCacheShape consumer sees the same fields.
 *  - `_round_ts` reproduces Python's `round(ts, 3)` — banker's rounding
 *    (round-half-to-even) — so the `d["last_read_ts"] == round(ts, 3)` test
 *    assertions hold bit-for-bit.
 *  - Byte math (`_trim_session_for_size`) uses util.utf8Bytes (UTF-8 Buffer
 *    length), never String.length. JSON via JSON.stringify(…) (json.dumps with
 *    ensure_ascii=False; key order matches Python dict insertion order).
 *  - `_proc_load_cache` (dict) and `_LAST_SAVED_VERSION` (dict) are the
 *    module-global mutable state conftest cleared; they port as module-level
 *    Maps with a registered reset (registerReset) so tests/setup.ts's
 *    clearModuleCaches() wipes them per-test.
 *  - sanitize_log_str / is_real_int come from ./hooks_common.js; env_int /
 *    get_logger / strip_bom / utf8_bytes from ./util.js; the path helpers and
 *    overrides from ./paths.js — exactly mirroring the Python imports.
 *  - Public surface: every name in the Python `__all__` is exported under its
 *    EXACT snake_case identifier, plus the private `_helpers`/constants the
 *    session test suite reaches into (`_proc_load_cache`, `_PROC_LOAD_CACHE_MAX`,
 *    `_HINT_CAT_HISTORY_MAX`, `_evict_oldest`, `_merge_ranges`,
 *    `_cleanup_stale_tmp_files`, `_preserve_corrupt_file`, `_record_cache_contention`,
 *    `_contention_mark_path`, …). camelCase aliases are NOT added (the Python
 *    names ARE the public API the tests assert on).
 *
 * `verbatimModuleSyntax` is on → type-only imports use `import type`.
 * `exactOptionalPropertyTypes` is on → optional fields are `T | undefined`
 * unless types.ts spells `| null` (read_mtime_ns / read_size / status_code /
 * content_type / cwd / last_context_advisory_threshold are `| null`).
 * `noUncheckedIndexedAccess` is on → every arr[i] / map.get(k) is narrowed.
 */

import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import type {
  BashEntry as BashEntryShape,
  DecisionEntry as DecisionEntryShape,
  FileEntry as FileEntryShape,
  GlobEntry as GlobEntryShape,
  GrepEntry as GrepEntryShape,
  ResultCacheEntry as ResultCacheEntryShape,
  SkillEntry as SkillEntryShape,
  WebEntry as WebEntryShape,
} from "./types.js";

import * as paths from "./paths.js";
import * as _dbModule from "./db.js";
import * as _snapshotsModule from "./snapshots.js";
import { is_real_int, sanitize_log_str } from "./hooks_common.js";
import { envInt, getLogger, stripBOM, utf8Bytes } from "./util.js";
import { registerReset } from "./reset.js";

const _LOG = getLogger("session");

// ===========================================================================
// Platform detection
// ===========================================================================

const _IS_WINDOWS: boolean = process.platform === "win32";

// ===========================================================================
// Small coercion / numeric helpers
// ===========================================================================

/**
 * Reproduce Python's `round(value, 3)` — round-half-to-even (banker's
 * rounding). JS `Math.round` rounds half away from zero (and only to integer),
 * and `Number.toFixed` rounds half-up with float artefacts, so neither matches
 * Python's `round`. We scale by 1000, round to nearest with ties-to-even, then
 * unscale. The intermediate scale is done with a tiny epsilon nudge guard so a
 * value like 0.5 that lands exactly on .5 after float scaling is bucketed to
 * even, matching CPython's round() observable behaviour for the 3-dp inputs the
 * session JSON carries.
 */
function _pyRound3(value: number): number {
  if (!Number.isFinite(value)) return value;
  const scaled = value * 1000;
  const floor = Math.floor(scaled);
  const diff = scaled - floor;
  let roundedScaled: number;
  // Use a small tolerance so float representation error near .5 does not flip
  // the tie decision the wrong way.
  const EPS = 1e-9;
  if (diff > 0.5 + EPS) {
    roundedScaled = floor + 1;
  } else if (diff < 0.5 - EPS) {
    roundedScaled = floor;
  } else {
    // Exactly halfway (within tolerance): round to even.
    roundedScaled = floor % 2 === 0 ? floor : floor + 1;
  }
  return roundedScaled / 1000;
}

/**
 * Return *raw* as a number if it is numeric, else 0.0. (Python _coerce_ts:
 * `float(raw) if isinstance(raw, (int, float)) else 0.0`.) A boolean in Python
 * is an int subclass so `_coerce_ts(True)` is 1.0; we mirror that. NaN (which a
 * corrupt JSON "NaN" literal can produce) passes through as a number, matching
 * Python — _safe_max_ts is the guard that neutralises it downstream.
 */
export function _coerce_ts(raw: unknown): number {
  if (typeof raw === "number") return raw;
  if (typeof raw === "boolean") return raw ? 1.0 : 0.0;
  return 0.0;
}

/**
 * Return max(a, b) but treat NaN as -Infinity so a valid timestamp always wins.
 * (Python _safe_max_ts.) If both are NaN, returns 0.0.
 */
function _safe_max_ts(a: number, b: number): number {
  const aVal = !Number.isNaN(a) ? a : -Infinity;
  const bVal = !Number.isNaN(b) ? b : -Infinity;
  const result = aVal >= bVal ? aVal : bVal;
  return result !== -Infinity ? result : 0.0;
}

/** Return int(raw) clamped to >= 0, or *default* on error. (Python _coerce_nonneg_int.) */
export function _coerce_nonneg_int(raw: unknown, defaultVal = 0): number {
  const n = _toInt(raw);
  if (n === undefined) return defaultVal;
  return Math.max(0, n);
}

/**
 * Return int(raw) clamped to >= 0, or null when *raw* is missing/None/invalid.
 * (Python _coerce_nonneg_int_or_none.) Distinct from _coerce_nonneg_int: the
 * on-disk fingerprint fields must distinguish "not recorded" (null) from a
 * legitimate epoch mtime of 0.
 */
export function _coerce_nonneg_int_or_none(raw: unknown): number | null {
  if (raw === null || raw === undefined) return null;
  const n = _toInt(raw);
  if (n === undefined) return null;
  return Math.max(0, n);
}

/**
 * Best-effort `int(raw)` analogue: accept a finite number (truncated toward
 * zero, matching Python int()) or a string of digits; return undefined on
 * anything Python's int() would raise TypeError/ValueError on. Booleans are
 * rejected (Python's int(True) is 1, but these coercion sites guard untrusted
 * JSON where a bool means a malformed field — and the Python callers wrap
 * int() in try/except so a bool that *does* coerce is harmless; we accept bool
 * as 0/1 to match int(bool) exactly).
 */
function _toInt(raw: unknown): number | undefined {
  if (typeof raw === "boolean") return raw ? 1 : 0;
  if (typeof raw === "number") {
    if (!Number.isFinite(raw)) return undefined;
    return Math.trunc(raw);
  }
  if (typeof raw === "string") {
    const t = raw.trim();
    if (!/^[+-]?\d+$/.test(t)) return undefined;
    const n = Number(t);
    return Number.isFinite(n) ? Math.trunc(n) : undefined;
  }
  return undefined;
}

/** Python float() analogue used where the value is already number|null. */
function _toFloatOr(raw: unknown, fallback: number): number {
  if (typeof raw === "number") return raw;
  if (typeof raw === "boolean") return raw ? 1 : 0;
  if (typeof raw === "string") {
    const t = raw.trim();
    if (t === "") return fallback;
    const n = Number(t);
    return Number.isFinite(n) ? n : fallback;
  }
  return fallback;
}

type _Factory<T> = (data: Record<string, unknown>) => T | null;

/**
 * Call *factory(data)*, logging and returning null on any parse error.
 * (Python _safe_parse.)
 */
export function _safe_parse<T>(
  factory: _Factory<T>,
  data: Record<string, unknown>,
  label: string,
): T | null {
  try {
    return factory(data);
  } catch (exc) {
    _LOG.debug("session: skipping corrupted %s entry: %s", label, exc);
    return null;
  }
}

// ===========================================================================
// Module constants + module-global mutable state
// ===========================================================================

export const SESSION_SCHEMA_VERSION = 1;

/**
 * In-process no-op file lock. Python used threading.Lock to serialise
 * same-process threads; Node's main module is single-threaded so this is a
 * trivial guard. The real cross-process safety is the advisory lockfile + the
 * CAS version counter in save(). Exposed for parity, not relied upon.
 */
function withFileLock<T>(body: () => T): T {
  return body();
}

/**
 * In-process record of the highest session version this process has written,
 * keyed by session id. Breaks (mtime, size) fingerprint aliasing: if another
 * same-process write advanced the on-disk version past the loaded cache's
 * version, the save() fast path is bypassed and full CAS+merge runs. (Python
 * _LAST_SAVED_VERSION dict.) Registered for reset below.
 */
export const _LAST_SAVED_VERSION: Map<string, number> = new Map();

// ---------------------------------------------------------------------------
// Process-local load cache
// ---------------------------------------------------------------------------
// user-prompt-submit and subagent-stop hooks both fire near-instantly in the
// same tool turn. Keyed by session_id; value: [cache_obj, mtime_when_loaded].
// Invalidated by mtime change or overflow. Cap 4. (Python _proc_load_cache.)
export const _PROC_LOAD_CACHE_MAX = 4;
export const _proc_load_cache: Map<string, [SessionCache, number]> = new Map();

// Register the reset so tests/setup.ts clearModuleCaches() wipes the module
// globals back to their freshly-imported state (the conftest _proc_load_cache
// clear analogue), mirroring db.ts's registration pattern.
registerReset(() => {
  _proc_load_cache.clear();
  _LAST_SAVED_VERSION.clear();
});

// ---------------------------------------------------------------------------
// Disk-based contention dedup
// ---------------------------------------------------------------------------
// Touch-files under data_dir()/contention_marks/ dedup "cache unavailable"
// telemetry across the one-process-per-hook model. (Python _contention_mark_path.)

const _CONTENTION_SAFE_RE = /[^A-Za-z0-9_-]/g;

/** Return the touch-file path for a (session_id, phase) contention record. */
export function _contention_mark_path(session_id: string, phase: string): string {
  const safeSid = session_id.replace(_CONTENTION_SAFE_RE, "_").slice(0, 32) || "anon";
  const safePhase = phase.replace(_CONTENTION_SAFE_RE, "_").slice(0, 32) || "phase";
  const fragment = `${safeSid}_${safePhase}.mark`;
  return paths.safeJoin(path.join(paths.dataDir(), "contention_marks"), fragment);
}

/** Touch-files older than this are expired and may be swept by the worker. */
export const _CONTENTION_MARK_TTL_SECS = 3600.0;

// ---------------------------------------------------------------------------
// Cross-process session lockfile helpers
// ---------------------------------------------------------------------------
// Each session JSON gets a sidecar `<session_id>.json.lock`. Node has no
// fcntl/msvcrt advisory lock, so the lock is an O_EXCL PID+timestamp lockfile
// (db.ts projectWriterLock pattern): creation is the mutex, stale locks are
// evicted by PID-liveness + age. _LOCK_TIMEOUT_SECS is the max wait before
// giving up; the hot path is unaffected (this budget only applies under
// genuine contention).
export const _LOCK_TIMEOUT_SECS = 5.0;
/** Poll interval (seconds) when spinning for the lock, jittered in the loop. */
export const _LOCK_POLL_SECS = 0.002;

/** Return the lockfile path for *session_id*. */
export function _session_lock_path(session_id: string): string {
  const p = paths.sessionCachePath(session_id);
  return _withSuffix(p, ".json.lock");
}

/**
 * Replace the final suffix of *p* with *newSuffix* (pathlib `with_suffix`).
 * `with_suffix(".json.lock")` on `foo.json` yields `foo.json.lock`? No —
 * pathlib replaces only the LAST suffix, so `foo.json`.with_suffix(".json.lock")
 * → `foo.json.lock` is wrong; pathlib gives `foo.json.lock` only because it
 * strips `.json` then appends `.json.lock` → `foo.json.lock`. We reproduce
 * pathlib exactly: strip the final `.<ext>` (if any) then append newSuffix.
 */
function _withSuffix(p: string, newSuffix: string): string {
  const dir = path.dirname(p);
  const base = path.basename(p);
  const dot = base.lastIndexOf(".");
  const stem = dot > 0 ? base.slice(0, dot) : base;
  return path.join(dir, stem + newSuffix);
}

/**
 * Return true if a process with the given PID is still alive. Node has no
 * psutil; process.kill(pid, 0) is the POSIX existence check. EPERM (Windows /
 * insufficient perms) means alive; ESRCH means dead; any other error assumes
 * dead. (Mirrors db.ts _pidAlive.)
 */
function _pidAlive(pid: number): boolean {
  if (!Number.isFinite(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "EPERM") return true;
    return false;
  }
}

/**
 * Low-level "advisory lock" primitive. Python took an OS byte-range lock on an
 * open fd; Node has no such API, so the advisory lock IS the O_EXCL lockfile.
 * This helper is retained for surface parity but the real acquisition lives in
 * _acquire_session_lock (it owns the create+stale-eviction loop). Returns true
 * (we never hold a separate byte-range lock to re-take).
 */
function _os_advisory_lock(_fd: number): boolean {
  return true;
}

/** Counterpart to _os_advisory_lock — a no-op (the lockfile unlink releases). */
function _os_advisory_unlock(_fd: number): void {
  /* no-op: release is the lockfile unlink in _release_session_lock */
}

// Lock-handle bookkeeping: map an integer "fd" token to the lockfile path so
// _release_session_lock can unlink it. Python returned a real fd; Node's "fd"
// here is a synthetic monotonic token because the lock semantic is file
// existence (O_EXCL), not a held descriptor.
let _lockTokenCounter = 1;
const _lockTokenPaths: Map<number, string> = new Map();

/**
 * Acquire the cross-process lock for *session_id*. Returns an opaque token on
 * success (pass to _release_session_lock), or null on timeout. The lockfile is
 * created via "wx" (O_CREAT|O_EXCL|O_WRONLY); creation is the mutex. Stale
 * locks (owning PID dead, or older than _LOCK_TIMEOUT_SECS) are evicted. The
 * lockfile content is `<pid>\n<unix-ts>` (diagnostics + staleness). (Python
 * _acquire_session_lock, re-expressed via the db.ts O_EXCL pattern.)
 */
export function _acquire_session_lock(session_id: string): number | null {
  const lockPath = _session_lock_path(session_id);
  paths.ensureDir(path.dirname(lockPath));
  const deadlineMs = _monotonicMs() + _LOCK_TIMEOUT_SECS * 1000;

  for (;;) {
    let fd: number | undefined;
    try {
      fd = fs.openSync(lockPath, "wx", 0o600);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "EEXIST") {
        // Held — check for a stale lock from a crashed process.
        if (_evictIfStale(lockPath)) {
          // Stale lock cleared; retry the atomic create immediately.
          continue;
        }
      } else {
        _LOG.error("session lock open failed: %s", session_id.slice(0, 16));
        return null;
      }
      if (_monotonicMs() >= deadlineMs) {
        _LOG.debug("session lock timeout: %s", session_id.slice(0, 16));
        return null;
      }
      // Jitter (±25%) so two starving processes do not settle into lockstep.
      _sleepSync(_LOCK_POLL_SECS * (0.75 + 0.5 * Math.random()));
      continue;
    }
    // We hold the lock — record owner pid + timestamp, then close the fd. The
    // lockfile persists; mutual exclusion is its existence (O_EXCL), not a held
    // descriptor, so we close immediately (mirrors db.ts).
    try {
      const nowSec = Date.now() / 1000;
      fs.writeFileSync(fd, `${process.pid}\n${nowSec}`, "utf8");
    } catch {
      // best-effort write of owner metadata; the lock is held regardless.
    } finally {
      try {
        fs.closeSync(fd);
      } catch {
        /* ignore */
      }
    }
    const token = _lockTokenCounter++;
    _lockTokenPaths.set(token, lockPath);
    return token;
  }
}

/**
 * Release the cross-process lock acquired by _acquire_session_lock. Unlinks the
 * lockfile (the O_EXCL token). *session_id* is retained for signature stability.
 * (Python _release_session_lock.)
 */
export function _release_session_lock(session_id: string, fd: number | null): void {
  if (fd === null) return;
  _os_advisory_unlock(fd);
  const lockPath = _lockTokenPaths.get(fd) ?? _session_lock_path(session_id);
  _lockTokenPaths.delete(fd);
  try {
    fs.unlinkSync(lockPath);
  } catch {
    // missing_ok: another process may have swept it.
  }
}

/**
 * If the lockfile at *lockPath* is stale (owning PID dead, malformed content
 * older than the timeout, or older than the timeout by mtime), unlink it and
 * return true. Otherwise return false. Mirrors db.ts projectWriterLock's
 * isStale + unlink path adapted to the `<pid>\n<ts>` content.
 */
function _evictIfStale(lockPath: string): boolean {
  let text = "";
  try {
    text = fs.readFileSync(lockPath, "utf8");
  } catch {
    return false;
  }
  const stale = _lockIsStale(lockPath, text);
  if (!stale) return false;
  try {
    fs.unlinkSync(lockPath);
    return true;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    // Already gone — treat as cleared so the retry attempts the create.
    return code === "ENOENT";
  }
}

function _lockIsStale(lockPath: string, text: string): boolean {
  const trimmed = text.trim();
  const ageByMtime = (): boolean => {
    try {
      const st = fs.statSync(lockPath);
      const age = Date.now() / 1000 - st.mtimeMs / 1000;
      return age > _LOCK_TIMEOUT_SECS;
    } catch {
      return false;
    }
  };
  if (trimmed === "") return ageByMtime();
  const lines = trimmed.split("\n");
  const ownerPidStr = lines[0];
  const ownerTsStr = lines[1];
  if (ownerPidStr === undefined) return ageByMtime();
  const ownerPid = parseInt(ownerPidStr, 10);
  if (!Number.isFinite(ownerPid)) return ageByMtime();
  // If a timestamp is present and exceeds the timeout, treat as stale.
  if (ownerTsStr !== undefined) {
    const ownerTs = parseFloat(ownerTsStr);
    if (Number.isFinite(ownerTs) && Date.now() / 1000 - ownerTs > _LOCK_TIMEOUT_SECS) {
      return true;
    }
  }
  // Otherwise stale iff the owning process is gone.
  return !_pidAlive(ownerPid);
}

// ---------------------------------------------------------------------------
// File-level lock context manager (Python _session_file_lock + variants)
// ---------------------------------------------------------------------------
// Python used fcntl.flock on POSIX and an O_EXCL `.flock` sidecar on Windows,
// bounded by a 200ms timeout, failing soft (proceed without the lock on
// timeout). Node has neither fcntl nor msvcrt, so BOTH platforms use the O_EXCL
// sidecar approach uniformly (the same mechanism the Windows branch used). The
// contextmanager becomes a higher-order function taking a callback; the lock is
// always released on exit, even when the body throws.
export const _SESSION_FILE_LOCK_TIMEOUT_MS = 200;
export const _SESSION_FILE_LOCK_POLL_MS = 10;

/**
 * Cross-process file-level lock for a session JSON path, run around *body*.
 * Acquires a `<path>.flock` sidecar via O_EXCL with a timeout/poll loop. On
 * timeout a warning is logged and *body* runs WITHOUT the lock (fail-soft:
 * never blocks the hook). The sidecar is removed on exit. Returns body()'s
 * value. (Python _session_file_lock — the contextmanager.)
 */
export function _session_file_lock<T>(p: string, body: () => T): T {
  if (_IS_WINDOWS) {
    return _session_file_lock_windows(p, body);
  }
  return _session_file_lock_posix(p, body);
}

/**
 * POSIX variant. Python used fcntl.flock(LOCK_EX|LOCK_NB) on an fd opened on the
 * session path; Node has no fcntl, so this uses the same O_EXCL `.flock` sidecar
 * as the Windows path (the only cross-process file lock primitive available in
 * portable Node). Behaviour (timeout, fail-soft warning, always-release) is
 * identical to the Python contract.
 */
function _session_file_lock_posix<T>(p: string, body: () => T): T {
  return _flockSidecar(p, body, "POSIX");
}

/**
 * Windows variant — O_EXCL `.flock` sidecar with stale-eviction, matching the
 * Python Windows branch. (On Windows the Python original ALSO used a sidecar;
 * this is a direct port.)
 */
function _session_file_lock_windows<T>(p: string, body: () => T): T {
  return _flockSidecar(p, body, "Windows");
}

function _flockSidecar<T>(p: string, body: () => T, label: string): T {
  const sidecar = p + ".flock";
  let acquired = false;
  try {
    paths.ensureDir(path.dirname(p));
    const deadlineMs = _SESSION_FILE_LOCK_TIMEOUT_MS;
    let elapsedMs = 0;
    // A stale flock is one held longer than 10× the timeout (2s at defaults).
    const staleThresholdSecs = (_SESSION_FILE_LOCK_TIMEOUT_MS * 10) / 1000.0;
    while (elapsedMs < deadlineMs) {
      try {
        const fd = fs.openSync(sidecar, "wx", 0o600);
        fs.closeSync(fd);
        acquired = true;
        break;
      } catch {
        // Check for a stale sidecar left by a crashed process before sleeping.
        try {
          const st = fs.statSync(sidecar);
          if (Date.now() / 1000 - st.mtimeMs / 1000 > staleThresholdSecs) {
            try {
              fs.unlinkSync(sidecar);
            } catch {
              /* ignore */
            }
            _LOG.debug("_session_file_lock: evicted stale flock for %s", path.basename(p));
            continue;
          }
        } catch {
          /* stat failed — fall through to sleep */
        }
        _sleepSync(_SESSION_FILE_LOCK_POLL_MS / 1000.0);
        elapsedMs += _SESSION_FILE_LOCK_POLL_MS;
      }
    }
    if (!acquired) {
      _LOG.warning(
        "_session_file_lock: %s sidecar timeout (%dms) for %s; proceeding without lock",
        label,
        _SESSION_FILE_LOCK_TIMEOUT_MS,
        path.basename(p),
      );
    }
    return body();
  } finally {
    if (acquired) {
      try {
        fs.unlinkSync(sidecar);
      } catch {
        /* missing_ok */
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Sync time / sleep helpers (mirroring db.ts / paths.ts).
// ---------------------------------------------------------------------------

/** Monotonic time in milliseconds. */
function _monotonicMs(): number {
  return Number(process.hrtime.bigint() / 1_000_000n);
}

/** Synchronous sleep — only used on lock retry/poll paths, never hot. */
function _sleepSync(seconds: number): void {
  const ms = Math.max(0, Math.floor(seconds * 1000));
  if (ms <= 0) return;
  try {
    const buf = new Int32Array(new SharedArrayBuffer(4));
    Atomics.wait(buf, 0, 0, ms);
  } catch {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      /* spin */
    }
  }
}

// ===========================================================================
// Entry classes (Python @dataclass FileEntry/GrepEntry/.../ResultCacheEntry)
// ===========================================================================
// Ported as classes (not object literals): tests construct them with keyword
// args, mutate fields after construction, and rely on per-instance identity in
// _merge_session_caches. Each takes a single options object mirroring Python
// kwargs. Defaults match the dataclass field defaults exactly.

/** Options accepted by the FileEntry constructor (mirrors Python kwargs). */
export interface FileEntryInit {
  rel_or_abs: string;
  last_read_ts: number;
  read_count: number;
  line_ranges: Array<[number, number]>;
  symbols_read: string[];
  last_edit_ts?: number;
  symbols_ts?: Record<string, number>;
  read_mtime_ns?: number | null;
  read_size?: number | null;
  last_read_call_index?: number;
}

/** Tracks reads of a single file within a session. (Python FileEntry.) */
export class FileEntry implements FileEntryShape {
  rel_or_abs: string;
  last_read_ts: number;
  read_count: number;
  line_ranges: Array<[number, number]>;
  symbols_read: string[];
  last_edit_ts: number;
  symbols_ts: Record<string, number>;
  read_mtime_ns: number | null;
  read_size: number | null;
  last_read_call_index: number;

  constructor(init: FileEntryInit) {
    this.rel_or_abs = init.rel_or_abs;
    this.last_read_ts = init.last_read_ts;
    this.read_count = init.read_count;
    this.line_ranges = init.line_ranges;
    this.symbols_read = init.symbols_read;
    this.last_edit_ts = init.last_edit_ts ?? 0.0;
    this.symbols_ts = init.symbols_ts ?? {};
    this.read_mtime_ns = init.read_mtime_ns ?? null;
    this.read_size = init.read_size ?? null;
    this.last_read_call_index = init.last_read_call_index ?? 0;
  }
}

/** Options accepted by the GrepEntry constructor. */
export interface GrepEntryInit {
  pattern: string;
  path: string | null;
  ts: number;
  result_count?: number | null;
}

/** Tracks a Grep call (pattern + scope). (Python GrepEntry.) */
export class GrepEntry implements GrepEntryShape {
  pattern: string;
  path: string | null;
  ts: number;
  result_count: number | null;

  constructor(init: GrepEntryInit) {
    this.pattern = init.pattern;
    this.path = init.path;
    this.ts = init.ts;
    this.result_count = init.result_count ?? null;
  }
}

/** Options accepted by the GlobEntry constructor. */
export interface GlobEntryInit {
  pattern: string;
  path: string | null;
  ts: number;
  result_count?: number | null;
}

/** Tracks a Glob call (pattern + optional path scope). (Python GlobEntry.) */
export class GlobEntry implements GlobEntryShape {
  pattern: string;
  path: string | null;
  ts: number;
  result_count: number | null;

  constructor(init: GlobEntryInit) {
    this.pattern = init.pattern;
    this.path = init.path;
    this.ts = init.ts;
    this.result_count = init.result_count ?? null;
  }
}

/** Options accepted by the WebEntry constructor. */
export interface WebEntryInit {
  url_sha: string;
  url_preview: string;
  output_id: string;
  ts: number;
  body_bytes: number;
  status_code?: number | null;
  truncated?: boolean;
  content_type?: string | null;
}

/** Tracks one WebFetch invocation within a session. (Python WebEntry.) */
export class WebEntry implements WebEntryShape {
  url_sha: string;
  url_preview: string;
  output_id: string;
  ts: number;
  body_bytes: number;
  status_code: number | null;
  truncated: boolean;
  content_type: string | null;

  constructor(init: WebEntryInit) {
    this.url_sha = init.url_sha;
    this.url_preview = init.url_preview;
    this.output_id = init.output_id;
    this.ts = init.ts;
    this.body_bytes = init.body_bytes;
    this.status_code = init.status_code ?? null;
    this.truncated = init.truncated ?? false;
    this.content_type = init.content_type ?? null;
  }
}

/** Options accepted by the BashEntry constructor. */
export interface BashEntryInit {
  cmd_sha: string;
  cmd_preview: string;
  output_id: string;
  ts: number;
  stdout_bytes: number;
  stderr_bytes: number;
  exit_code?: number | null;
  truncated?: boolean;
  run_count?: number;
  output_sha?: string;
}

/** Tracks one execution of a Bash command within a session. (Python BashEntry.) */
export class BashEntry implements BashEntryShape {
  cmd_sha: string;
  cmd_preview: string;
  output_id: string;
  ts: number;
  stdout_bytes: number;
  stderr_bytes: number;
  exit_code: number | null;
  truncated: boolean;
  run_count: number;
  output_sha: string;

  constructor(init: BashEntryInit) {
    this.cmd_sha = init.cmd_sha;
    this.cmd_preview = init.cmd_preview;
    this.output_id = init.output_id;
    this.ts = init.ts;
    this.stdout_bytes = init.stdout_bytes;
    this.stderr_bytes = init.stderr_bytes;
    this.exit_code = init.exit_code ?? null;
    this.truncated = init.truncated ?? false;
    this.run_count = init.run_count ?? 1;
    this.output_sha = init.output_sha ?? "";
  }
}

/** Options accepted by the SkillEntry constructor. */
export interface SkillEntryInit {
  skill_name: string;
  output_id: string;
  content_sha: string;
  ts: number;
  body_bytes: number;
  truncated?: boolean;
  run_count?: number;
  source_path?: string;
  compact_served_count?: number;
}

/** Tracks one Skill tool invocation within a session. (Python SkillEntry.) */
export class SkillEntry implements SkillEntryShape {
  skill_name: string;
  output_id: string;
  content_sha: string;
  ts: number;
  body_bytes: number;
  truncated: boolean;
  run_count: number;
  source_path: string;
  compact_served_count: number;

  constructor(init: SkillEntryInit) {
    this.skill_name = init.skill_name;
    this.output_id = init.output_id;
    this.content_sha = init.content_sha;
    this.ts = init.ts;
    this.body_bytes = init.body_bytes;
    this.truncated = init.truncated ?? false;
    this.run_count = init.run_count ?? 1;
    this.source_path = init.source_path ?? "";
    this.compact_served_count = init.compact_served_count ?? 0;
  }
}

/** Options accepted by the DecisionEntry constructor. */
export interface DecisionEntryInit {
  text: string;
  ts: number;
  tag?: string;
}

/** One agent decision captured via `token-goat decision "<text>"`. (Python DecisionEntry.) */
export class DecisionEntry implements DecisionEntryShape {
  text: string;
  ts: number;
  tag: string;

  constructor(init: DecisionEntryInit) {
    this.text = init.text;
    this.ts = init.ts;
    this.tag = init.tag ?? "";
  }
}

/** Options accepted by the ResultCacheEntry constructor. */
export interface ResultCacheEntryInit {
  file_sha: string;
  kind: string;
  result: Record<string, unknown>;
  ts: number;
}

/** A cached read_symbol/read_section result. (Python ResultCacheEntry.) */
export class ResultCacheEntry implements ResultCacheEntryShape {
  file_sha: string;
  kind: string;
  result: Record<string, unknown>;
  ts: number;

  constructor(init: ResultCacheEntryInit) {
    this.file_sha = init.file_sha;
    this.kind = init.kind;
    this.result = init.result;
    this.ts = init.ts;
  }
}

/**
 * Round a Unix timestamp to millisecond precision (3 dp). Full microsecond
 * precision wastes bytes and is never needed for hint staleness logic.
 * (Python _round_ts → round(ts, 3); banker's rounding preserved via _pyRound3.)
 */
export function _round_ts(ts: number): number {
  return _pyRound3(ts);
}

// ===========================================================================
// Size-cap / eviction-threshold constants (verbatim values from session.py)
// ===========================================================================

// In-session result cache.
export const RESULT_CACHE_MAX = 50;
export const _RESULT_CACHE_EVICT = 10;

// Bash history.
export const BASH_HISTORY_MAX = 75;
export const _BASH_HISTORY_EVICT = 15;
export const _MAX_BASH_PREVIEW = 120;

// Web history.
export const WEB_HISTORY_MAX = 75;
export const _WEB_HISTORY_EVICT = 15;
export const _MAX_WEB_URL_PREVIEW = 100;

// Skill history.
export const SKILL_HISTORY_MAX = 20;
export const _SKILL_HISTORY_EVICT = 5;
export const _MAX_SKILL_NAME_LEN = 128;

// Grep history.
export const GREPS_HISTORY_MAX = 75;
export const _GREPS_HISTORY_EVICT = 15;

// Grep result-content hashes.
export const GREP_RESULT_HASHES_MAX = 50;
export const _GREP_RESULT_HASHES_EVICT = 5;
// MCP result hashes.
export const MCP_RESULT_HASHES_MAX = 100;
export const _MCP_RESULT_HASHES_EVICT = 10;
// File-content SHA entries.
export const FILE_CONTENT_SEEN_MAX = 500;
export const _FILE_CONTENT_SEEN_EVICT = 50;
// Read-content-hash entries.
export const READ_CONTENT_HASHES_MAX = 100;
export const _READ_CONTENT_HASHES_EVICT = 10;
// Log-file content cache.
export const LOG_FILE_CACHE_MAX = 50;
export const _LOG_FILE_CACHE_EVICT = 5;
// Dir-listing fingerprint cache.
export const DIR_LISTING_CACHE_MAX = 30;
export const _DIR_LISTING_CACHE_EVICT = 3;
// Command-output dedup hash map.
export const CMD_OUTPUT_HASHES_MAX = 50;
export const _CMD_OUTPUT_HASHES_EVICT = 5;

// Decision-log entries.
export const DECISION_HISTORY_MAX = 30;
export const _DECISION_HISTORY_EVICT = 5;
export const _MAX_DECISION_TEXT_LEN = 280;

// Glob history.
export const GLOB_HISTORY_MAX = 20;
export const _GLOB_HISTORY_EVICT = 5;
export const _MAX_GLOB_PATTERN_LEN = 512;

// Per-file line-range span cap + full-file collapse threshold.
export const _MAX_LINE_RANGES_PER_FILE = 15;
export const _READ_COUNT_FULL_FILE_THRESHOLD = 10;

// Hint fingerprint / content-dedup caps.
export const HINTS_SEEN_MAX = 500;
export const HINTS_CONTENT_DEDUP_MAX = 100;
export const _HINTS_CONTENT_DEDUP_EVICT = 10;

// Per-category hint history ring buffer size.
export const _HINT_CAT_HISTORY_MAX = 10;

// File-entry / edited-file / snapshot / image / pinned caps.
export const FILES_MAX = 500;
export const _FILES_EVICT = 50;
export const EDITED_FILES_MAX = 500;
export const _EDITED_FILES_EVICT = 50;
export const SNAPSHOT_SHAS_MAX = 200;
export const _SNAPSHOT_SHAS_EVICT = 50;
export const IMAGE_SHRINK_COUNT_MAX = 200;
export const _IMAGE_SHRINK_COUNT_EVICT = 40;
export const PINNED_SYMBOLS_MAX = 20;

// Bash-dedup emitted-ids set cap (2× bash history).
export const BASH_DEDUP_IDS_MAX = BASH_HISTORY_MAX * 2;

// ===========================================================================
// CAS merge helper (Python _merge_session_caches)
// ===========================================================================

/**
 * FIFO-evict the *count* oldest keys from a plain-object record (insertion
 * order). Mirrors the `for _ in range(n): d.pop(next(iter(d)))` idiom.
 */
function _popOldest<V>(rec: Record<string, V>, count: number): void {
  const keys = Object.keys(rec);
  const n = Math.min(count, keys.length);
  for (let i = 0; i < n; i++) {
    const k = keys[i];
    if (k !== undefined) delete rec[k];
  }
}

/**
 * Merge *local* mutations into a newer *remote* on-disk state. Called when
 * save() detects remote.version > local.version (another process saved while we
 * held our copy). *remote* is the base (authoritative for uncontested fields);
 * local's mutations are re-applied per-field with the matching strategy: sets →
 * union, dicts → update (newer ts wins per-key), counts → max, lists → longer
 * (capped), scalars → max. (Python _merge_session_caches — ported verbatim.)
 */
export function _merge_session_caches(
  local: SessionCache,
  remote: SessionCache,
): SessionCache {
  const merged = remote;

  // --- hints_seen: dict merge — max count per fingerprint, bounded ---
  const mergedHints: Record<string, number> = { ...remote.hints_seen };
  for (const [fp, count] of Object.entries(local.hints_seen)) {
    mergedHints[fp] = Math.max(mergedHints[fp] ?? 0, count);
  }
  merged.hints_seen = mergedHints;
  if (Object.keys(merged.hints_seen).length > HINTS_SEEN_MAX) {
    const sorted = Object.entries(mergedHints).sort((a, b) => b[1] - a[1]);
    merged.hints_seen = Object.fromEntries(sorted.slice(0, HINTS_SEEN_MAX));
  }

  // --- hints_content_dedup: max count per content hash, FIFO-bounded ---
  const mergedContentDedup: Record<string, [string, number]> = {
    ...remote.hints_content_dedup,
  };
  for (const [ch, val] of Object.entries(local.hints_content_dedup)) {
    const [summary, count] = val;
    const existing = mergedContentDedup[ch];
    if (existing !== undefined) {
      const [oldSummary, oldCount] = existing;
      mergedContentDedup[ch] = [oldSummary, Math.max(oldCount, count)];
    } else {
      mergedContentDedup[ch] = [summary, count];
    }
  }
  merged.hints_content_dedup = mergedContentDedup;
  if (Object.keys(merged.hints_content_dedup).length > HINTS_CONTENT_DEDUP_MAX) {
    const removeN =
      Object.keys(merged.hints_content_dedup).length -
      (HINTS_CONTENT_DEDUP_MAX - _HINTS_CONTENT_DEDUP_EVICT);
    _popOldest(merged.hints_content_dedup, removeN);
  }

  // --- bash_dedup_emitted_ids: set union ---
  merged.bash_dedup_emitted_ids = new Set([
    ...local.bash_dedup_emitted_ids,
    ...remote.bash_dedup_emitted_ids,
  ]);

  // --- files: dict merge, newer last_read_ts wins ---
  for (const [k, v] of Object.entries(local.files)) {
    const r = remote.files[k];
    if (r === undefined) {
      remote.files[k] = v;
    } else if (v.last_read_ts > r.last_read_ts) {
      remote.files[k] = v;
    }
  }
  merged.files = remote.files;

  // --- edited_files: max per key ---
  for (const [efk, ec] of Object.entries(local.edited_files)) {
    remote.edited_files[efk] = Math.max(remote.edited_files[efk] ?? 0, ec);
  }
  merged.edited_files = remote.edited_files;

  // --- result_cache / bash_history / web_history / skill_history: newer ts wins ---
  for (const [rck, rce] of Object.entries(local.result_cache)) {
    const r = remote.result_cache[rck];
    if (r === undefined || rce.ts > r.ts) remote.result_cache[rck] = rce;
  }
  merged.result_cache = remote.result_cache;

  for (const [bek, be] of Object.entries(local.bash_history)) {
    const r = remote.bash_history[bek];
    if (r === undefined || be.ts > r.ts) remote.bash_history[bek] = be;
  }
  merged.bash_history = remote.bash_history;

  for (const [wek, we] of Object.entries(local.web_history)) {
    const r = remote.web_history[wek];
    if (r === undefined || we.ts > r.ts) remote.web_history[wek] = we;
  }
  merged.web_history = remote.web_history;

  for (const [skk, ske] of Object.entries(local.skill_history)) {
    const r = remote.skill_history[skk];
    if (r === undefined || ske.ts > r.ts) remote.skill_history[skk] = ske;
  }
  merged.skill_history = remote.skill_history;

  // --- snapshot_shas: local wins (freshest content snapshot) ---
  Object.assign(remote.snapshot_shas, local.snapshot_shas);
  merged.snapshot_shas = remote.snapshot_shas;

  // --- greps: append local entries not already in remote, re-cap ---
  const remoteGrepKeys = new Set(remote.greps.map((g) => `${g.pattern}\x00${g.path}`));
  for (const grep of local.greps) {
    if (!remoteGrepKeys.has(`${grep.pattern}\x00${grep.path}`)) {
      remote.greps.push(grep);
    }
  }
  merged.greps = remote.greps.slice(-GREPS_HISTORY_MAX);

  // --- grep_result_hashes: first-seen wins (remote precedence), FIFO cap ---
  const mergedGrepHashes: Record<string, string> = { ...remote.grep_result_hashes };
  for (const [hk, pattern] of Object.entries(local.grep_result_hashes)) {
    if (mergedGrepHashes[hk] === undefined) mergedGrepHashes[hk] = pattern;
  }
  merged.grep_result_hashes = mergedGrepHashes;
  if (Object.keys(merged.grep_result_hashes).length > GREP_RESULT_HASHES_MAX) {
    const removeN =
      Object.keys(merged.grep_result_hashes).length -
      (GREP_RESULT_HASHES_MAX - _GREP_RESULT_HASHES_EVICT);
    _popOldest(merged.grep_result_hashes, removeN);
  }

  // --- mcp_result_hashes: first-seen wins, FIFO cap ---
  const mergedMcpHashes: Record<string, string> = { ...remote.mcp_result_hashes };
  for (const [hk, outputId] of Object.entries(local.mcp_result_hashes)) {
    if (mergedMcpHashes[hk] === undefined) mergedMcpHashes[hk] = outputId;
  }
  merged.mcp_result_hashes = mergedMcpHashes;
  if (Object.keys(merged.mcp_result_hashes).length > MCP_RESULT_HASHES_MAX) {
    const removeN =
      Object.keys(merged.mcp_result_hashes).length -
      (MCP_RESULT_HASHES_MAX - _MCP_RESULT_HASHES_EVICT);
    _popOldest(merged.mcp_result_hashes, removeN);
  }

  // --- file_content_seen: first-seen wins, FIFO cap ---
  const mergedFcs: Record<string, string> = { ...remote.file_content_seen };
  for (const [sha16, fpath] of Object.entries(local.file_content_seen)) {
    if (mergedFcs[sha16] === undefined) mergedFcs[sha16] = fpath;
  }
  merged.file_content_seen = mergedFcs;
  if (Object.keys(merged.file_content_seen).length > FILE_CONTENT_SEEN_MAX) {
    const evict =
      Object.keys(merged.file_content_seen).length -
      (FILE_CONTENT_SEEN_MAX - _FILE_CONTENT_SEEN_EVICT);
    _popOldest(merged.file_content_seen, evict);
  }

  // --- pytest_failures: local wins per cmd_sha ---
  const mergedPf: Record<string, string[]> = { ...remote.pytest_failures };
  Object.assign(mergedPf, local.pytest_failures);
  merged.pytest_failures = mergedPf;

  // --- glob_history: append local not in remote, re-cap ---
  const remoteGlobKeys = new Set(
    remote.glob_history.map((g) => `${g.pattern}\x00${g.path}`),
  );
  for (const glob of local.glob_history) {
    if (!remoteGlobKeys.has(`${glob.pattern}\x00${glob.path}`)) {
      remote.glob_history.push(glob);
    }
  }
  merged.glob_history = remote.glob_history.slice(-GLOB_HISTORY_MAX);

  // --- decisions: append local not in remote (dedup on ts+text), re-cap ---
  const remoteDecisionKeys = new Set(
    remote.decisions.map((d) => `${d.ts}\x00${d.text}`),
  );
  for (const d of local.decisions) {
    if (!remoteDecisionKeys.has(`${d.ts}\x00${d.text}`)) {
      remote.decisions.push(d);
    }
  }
  merged.decisions = remote.decisions.slice(-DECISION_HISTORY_MAX);

  // --- flat hint counters: max (NaN-guarded) ---
  merged.hints_emitted = Math.trunc(_safe_max_ts(local.hints_emitted, remote.hints_emitted));
  merged.hints_ignored = Math.trunc(_safe_max_ts(local.hints_ignored, remote.hints_ignored));
  merged.structured_hints_emitted = Math.trunc(
    _safe_max_ts(local.structured_hints_emitted, remote.structured_hints_emitted),
  );
  merged.index_only_hints_emitted = Math.trunc(
    _safe_max_ts(local.index_only_hints_emitted, remote.index_only_hints_emitted),
  );

  // --- per-type counters: max per key ---
  const mergedEmittedByType: Record<string, number> = { ...remote.hints_emitted_by_type };
  for (const [ht, count] of Object.entries(local.hints_emitted_by_type)) {
    mergedEmittedByType[ht] = Math.max(mergedEmittedByType[ht] ?? 0, count);
  }
  merged.hints_emitted_by_type = mergedEmittedByType;

  const mergedSuppressedByType: Record<string, number> = {
    ...remote.hints_suppressed_by_type,
  };
  for (const [ht, count] of Object.entries(local.hints_suppressed_by_type)) {
    mergedSuppressedByType[ht] = Math.max(mergedSuppressedByType[ht] ?? 0, count);
  }
  merged.hints_suppressed_by_type = mergedSuppressedByType;

  // --- hint_category_history: union-with-cap per category (longer list wins) ---
  const mergedCatHist: Record<string, boolean[]> = { ...remote.hint_category_history };
  for (const [catKey, localVals] of Object.entries(local.hint_category_history)) {
    const remoteVals = remote.hint_category_history[catKey] ?? [];
    const combined = localVals.length >= remoteVals.length ? localVals : remoteVals;
    mergedCatHist[catKey] = combined.slice(-_HINT_CAT_HISTORY_MAX);
  }
  merged.hint_category_history = mergedCatHist;

  // --- recent_hints: longer list wins, re-cap at 3 ---
  merged.recent_hints = (
    local.recent_hints.length >= remote.recent_hints.length
      ? local.recent_hints
      : remote.recent_hints
  ).slice(-3);

  // --- last_activity_ts: max (NaN-guarded) ---
  merged.last_activity_ts = _safe_max_ts(local.last_activity_ts, remote.last_activity_ts);

  // --- manifest delta-cache: take the newer emit ---
  const localTs = !Number.isNaN(local.last_manifest_ts) ? local.last_manifest_ts : -Infinity;
  const remoteTs = !Number.isNaN(remote.last_manifest_ts) ? remote.last_manifest_ts : -Infinity;
  if (localTs >= remoteTs) {
    merged.last_manifest_sha = local.last_manifest_sha;
    merged.last_manifest_ts = !Number.isNaN(local.last_manifest_ts)
      ? local.last_manifest_ts
      : 0.0;
  }

  // --- cwd: prefer local (the hook that fired knows the cwd) ---
  if (local.cwd !== null) {
    merged.cwd = local.cwd;
  }

  // --- file_access_counts / symbol_access_counts / grep_target_counts: max per key ---
  const mergedFac: Record<string, number> = { ...remote.file_access_counts };
  for (const [fpath, count] of Object.entries(local.file_access_counts)) {
    mergedFac[fpath] = Math.max(mergedFac[fpath] ?? 0, count);
  }
  merged.file_access_counts = mergedFac;

  const mergedSac: Record<string, number> = { ...remote.symbol_access_counts };
  for (const [symKey, count] of Object.entries(local.symbol_access_counts)) {
    mergedSac[symKey] = Math.max(mergedSac[symKey] ?? 0, count);
  }
  merged.symbol_access_counts = mergedSac;

  const mergedGtc: Record<string, number> = { ...remote.grep_target_counts };
  for (const [gtcPath, count] of Object.entries(local.grep_target_counts)) {
    mergedGtc[gtcPath] = Math.max(mergedGtc[gtcPath] ?? 0, count);
  }
  merged.grep_target_counts = mergedGtc;

  // --- pinned_symbols: union-with-cap, remote-order first ---
  const mergedPinned: string[] = [...remote.pinned_symbols];
  for (const spec of local.pinned_symbols) {
    if (!mergedPinned.includes(spec)) mergedPinned.push(spec);
  }
  merged.pinned_symbols = mergedPinned.slice(0, PINNED_SYMBOLS_MAX);

  // --- read_content_hashes: local wins, FIFO cap ---
  const mergedRch: Record<string, string> = { ...remote.read_content_hashes };
  Object.assign(mergedRch, local.read_content_hashes);
  merged.read_content_hashes = mergedRch;
  if (Object.keys(merged.read_content_hashes).length > READ_CONTENT_HASHES_MAX) {
    const evict =
      Object.keys(merged.read_content_hashes).length -
      (READ_CONTENT_HASHES_MAX - _READ_CONTENT_HASHES_EVICT);
    _popOldest(merged.read_content_hashes, evict);
  }

  // --- log_file_cache: local wins, FIFO cap ---
  const mergedLfc: Record<string, string> = { ...remote.log_file_cache };
  Object.assign(mergedLfc, local.log_file_cache);
  merged.log_file_cache = mergedLfc;
  if (Object.keys(merged.log_file_cache).length > LOG_FILE_CACHE_MAX) {
    const evict =
      Object.keys(merged.log_file_cache).length -
      (LOG_FILE_CACHE_MAX - _LOG_FILE_CACHE_EVICT);
    _popOldest(merged.log_file_cache, evict);
  }

  // --- dir_listing_cache: local wins, FIFO cap ---
  const mergedDlc: Record<string, string> = { ...remote.dir_listing_cache };
  Object.assign(mergedDlc, local.dir_listing_cache);
  merged.dir_listing_cache = mergedDlc;
  if (Object.keys(merged.dir_listing_cache).length > DIR_LISTING_CACHE_MAX) {
    const evict =
      Object.keys(merged.dir_listing_cache).length -
      (DIR_LISTING_CACHE_MAX - _DIR_LISTING_CACHE_EVICT);
    _popOldest(merged.dir_listing_cache, evict);
  }

  // --- cmd_output_hashes: local wins, FIFO cap ---
  const mergedCoh: Record<string, string> = { ...remote.cmd_output_hashes };
  Object.assign(mergedCoh, local.cmd_output_hashes);
  merged.cmd_output_hashes = mergedCoh;
  if (Object.keys(merged.cmd_output_hashes).length > CMD_OUTPUT_HASHES_MAX) {
    const evict =
      Object.keys(merged.cmd_output_hashes).length -
      (CMD_OUTPUT_HASHES_MAX - _CMD_OUTPUT_HASHES_EVICT);
    _popOldest(merged.cmd_output_hashes, evict);
  }

  merged._invalidate_json_cache();
  return merged;
}

// attrgetter("last_read_ts") equivalent for sorting FileEntry by last_read_ts.
function _byLastReadTs(a: FileEntry, b: FileEntry): number {
  return a.last_read_ts - b.last_read_ts;
}

// ===========================================================================
// SessionCache (Python @dataclass SessionCache)
// ===========================================================================

/** Required constructor fields for SessionCache (the three non-default ones). */
export interface SessionCacheInit {
  session_id: string;
  started_ts: number;
  last_activity_ts: number;
  // Every other field is optional and defaults exactly as the Python dataclass.
  files?: Record<string, FileEntry>;
  greps?: GrepEntry[];
  grep_result_hashes?: Record<string, string>;
  mcp_result_hashes?: Record<string, string>;
  read_content_hashes?: Record<string, string>;
  log_file_cache?: Record<string, string>;
  dir_listing_cache?: Record<string, string>;
  cmd_output_hashes?: Record<string, string>;
  file_content_seen?: Record<string, string>;
  edited_files?: Record<string, number>;
  result_cache?: Record<string, ResultCacheEntry>;
  bash_history?: Record<string, BashEntry>;
  glob_history?: GlobEntry[];
  web_history?: Record<string, WebEntry>;
  skill_history?: Record<string, SkillEntry>;
  decisions?: DecisionEntry[];
  snapshot_shas?: Record<string, string>;
  hints_seen?: Record<string, number>;
  hints_content_dedup?: Record<string, [string, number]>;
  bash_dedup_emitted_ids?: Set<string>;
  stored_task_outputs?: Record<string, string>;
  hints_emitted?: number;
  hints_ignored?: number;
  structured_hints_emitted?: number;
  index_only_hints_emitted?: number;
  recent_hints?: Array<[string, number]>;
  hint_category_history?: Record<string, boolean[]>;
  cwd?: string | null;
  created_ts?: number;
  last_manifest_sha?: string;
  last_manifest_ts?: number;
  hints_emitted_by_type?: Record<string, number>;
  hints_suppressed_by_type?: Record<string, number>;
  image_shrink_count?: Record<string, number>;
  file_access_counts?: Record<string, number>;
  symbol_access_counts?: Record<string, number>;
  grep_target_counts?: Record<string, number>;
  pinned_symbols?: string[];
  turns_since_last_compact?: number;
  loaded_skill_total_tokens?: number;
  last_context_advisory_threshold?: number | null;
  pressure_baseline_tokens?: number;
  observed_tool_tokens?: number;
  last_compact_ts?: number;
  pytest_failures?: Record<string, string[]>;
  version?: number;
  recovery_injected?: boolean;
  unavailable?: boolean;
}

/**
 * Session context cache keyed by session_id. Populated by post-read / post-edit
 * hooks; used by pre-read hooks to emit hints. Persisted as JSON on disk.
 * (Python @dataclass SessionCache.)
 */
export class SessionCache {
  session_id: string;
  started_ts: number;
  last_activity_ts: number;
  files: Record<string, FileEntry>;
  greps: GrepEntry[];
  grep_result_hashes: Record<string, string>;
  mcp_result_hashes: Record<string, string>;
  read_content_hashes: Record<string, string>;
  log_file_cache: Record<string, string>;
  dir_listing_cache: Record<string, string>;
  cmd_output_hashes: Record<string, string>;
  file_content_seen: Record<string, string>;
  edited_files: Record<string, number>;
  result_cache: Record<string, ResultCacheEntry>;
  bash_history: Record<string, BashEntry>;
  glob_history: GlobEntry[];
  web_history: Record<string, WebEntry>;
  skill_history: Record<string, SkillEntry>;
  decisions: DecisionEntry[];
  snapshot_shas: Record<string, string>;
  hints_seen: Record<string, number>;
  hints_content_dedup: Record<string, [string, number]>;
  bash_dedup_emitted_ids: Set<string>;
  stored_task_outputs: Record<string, string>;
  hints_emitted: number;
  hints_ignored: number;
  structured_hints_emitted: number;
  index_only_hints_emitted: number;
  recent_hints: Array<[string, number]>;
  hint_category_history: Record<string, boolean[]>;
  cwd: string | null;
  created_ts: number;
  last_manifest_sha: string;
  last_manifest_ts: number;
  hints_emitted_by_type: Record<string, number>;
  hints_suppressed_by_type: Record<string, number>;
  image_shrink_count: Record<string, number>;
  file_access_counts: Record<string, number>;
  symbol_access_counts: Record<string, number>;
  grep_target_counts: Record<string, number>;
  pinned_symbols: string[];
  turns_since_last_compact: number;
  loaded_skill_total_tokens: number;
  last_context_advisory_threshold: number | null;
  pressure_baseline_tokens: number;
  observed_tool_tokens: number;
  last_compact_ts: number;
  pytest_failures: Record<string, string[]>;
  version: number;
  recovery_injected: boolean;
  unavailable: boolean;

  // In-process-only fields (not persisted; repr=False, compare=False in Python).
  _json_cache: string | null;
  _disk_mtime_ns: number;
  _disk_size: number;
  _pending_hint_save: boolean;
  _bash_dedup_sorted_cache: string[] | null;
  _session_hinted_files: Set<string>;

  constructor(init: SessionCacheInit) {
    this.session_id = init.session_id;
    this.started_ts = init.started_ts;
    this.last_activity_ts = init.last_activity_ts;
    this.files = init.files ?? {};
    this.greps = init.greps ?? [];
    this.grep_result_hashes = init.grep_result_hashes ?? {};
    this.mcp_result_hashes = init.mcp_result_hashes ?? {};
    this.read_content_hashes = init.read_content_hashes ?? {};
    this.log_file_cache = init.log_file_cache ?? {};
    this.dir_listing_cache = init.dir_listing_cache ?? {};
    this.cmd_output_hashes = init.cmd_output_hashes ?? {};
    this.file_content_seen = init.file_content_seen ?? {};
    this.edited_files = init.edited_files ?? {};
    this.result_cache = init.result_cache ?? {};
    this.bash_history = init.bash_history ?? {};
    this.glob_history = init.glob_history ?? [];
    this.web_history = init.web_history ?? {};
    this.skill_history = init.skill_history ?? {};
    this.decisions = init.decisions ?? [];
    this.snapshot_shas = init.snapshot_shas ?? {};
    this.hints_seen = init.hints_seen ?? {};
    this.hints_content_dedup = init.hints_content_dedup ?? {};
    this.bash_dedup_emitted_ids = init.bash_dedup_emitted_ids ?? new Set();
    this.stored_task_outputs = init.stored_task_outputs ?? {};
    this.hints_emitted = init.hints_emitted ?? 0;
    this.hints_ignored = init.hints_ignored ?? 0;
    this.structured_hints_emitted = init.structured_hints_emitted ?? 0;
    this.index_only_hints_emitted = init.index_only_hints_emitted ?? 0;
    this.recent_hints = init.recent_hints ?? [];
    this.hint_category_history = init.hint_category_history ?? {};
    this.cwd = init.cwd ?? null;
    this.created_ts = init.created_ts ?? Date.now() / 1000;
    this.last_manifest_sha = init.last_manifest_sha ?? "";
    this.last_manifest_ts = init.last_manifest_ts ?? 0.0;
    this.hints_emitted_by_type = init.hints_emitted_by_type ?? {};
    this.hints_suppressed_by_type = init.hints_suppressed_by_type ?? {};
    this.image_shrink_count = init.image_shrink_count ?? {};
    this.file_access_counts = init.file_access_counts ?? {};
    this.symbol_access_counts = init.symbol_access_counts ?? {};
    this.grep_target_counts = init.grep_target_counts ?? {};
    this.pinned_symbols = init.pinned_symbols ?? [];
    this.turns_since_last_compact = init.turns_since_last_compact ?? 0;
    this.loaded_skill_total_tokens = init.loaded_skill_total_tokens ?? 0;
    this.last_context_advisory_threshold = init.last_context_advisory_threshold ?? null;
    this.pressure_baseline_tokens = init.pressure_baseline_tokens ?? 0;
    this.observed_tool_tokens = init.observed_tool_tokens ?? 0;
    this.last_compact_ts = init.last_compact_ts ?? 0.0;
    this.pytest_failures = init.pytest_failures ?? {};
    this.version = init.version ?? 0;
    this.recovery_injected = init.recovery_injected ?? false;
    this.unavailable = init.unavailable ?? false;

    this._json_cache = null;
    this._disk_mtime_ns = 0;
    this._disk_size = 0;
    this._pending_hint_save = false;
    this._bash_dedup_sorted_cache = null;
    this._session_hinted_files = new Set();
  }

  /** Serialize to a plain object for JSON. (Python to_dict → _SessionDict.) */
  to_dict(): _SessionDict {
    const d: _SessionDict = {
      schema_version: SESSION_SCHEMA_VERSION,
      created_by: "token-goat",
      session_id: this.session_id,
      started_ts: _round_ts(this.started_ts),
      last_activity_ts: _round_ts(this.last_activity_ts),
      created_ts: _round_ts(this.created_ts),
      files: _mapValues(this.files, _serialize_file_entry),
      greps: this.greps.map(_serialize_grep_entry),
      grep_result_hashes: { ...this.grep_result_hashes },
      edited_files: this.edited_files,
      result_cache: _mapValues(this.result_cache, _serialize_result_cache_entry),
      bash_history: _mapValues(this.bash_history, _serialize_bash_entry),
      glob_history: this.glob_history.map(_serialize_glob_entry),
      web_history: _mapValues(this.web_history, _serialize_web_entry),
      skill_history: _mapValues(this.skill_history, _serialize_skill_entry),
      decisions: this.decisions.map(_serialize_decision_entry),
      snapshot_shas: { ...this.snapshot_shas },
      hints_seen: this._get_hints_seen_sorted(),
      hints_content_dedup: _mapValues(
        this.hints_content_dedup,
        ([v, c]): [string, number] => [v, c],
      ),
      bash_dedup_emitted_ids: this._get_bash_dedup_sorted(),
      stored_task_outputs: { ...this.stored_task_outputs },
      hints_emitted: this.hints_emitted,
      hints_ignored: this.hints_ignored,
      structured_hints_emitted: this.structured_hints_emitted,
      index_only_hints_emitted: this.index_only_hints_emitted,
      hints_emitted_by_type: this.hints_emitted_by_type,
      hints_suppressed_by_type: this.hints_suppressed_by_type,
      recent_hints: this.recent_hints.map(([p, t]): [string, number] => [p, t]),
      last_manifest_sha: this.last_manifest_sha,
      last_manifest_ts: this.last_manifest_ts,
      version: this.version,
      hint_category_history: _mapValues(this.hint_category_history, (lst) =>
        lst.map((v) => (v ? 1 : 0)),
      ),
      image_shrink_count: this.image_shrink_count,
      file_access_counts: this.file_access_counts,
      symbol_access_counts: this.symbol_access_counts,
      pinned_symbols: [...this.pinned_symbols],
      cwd: this.cwd,
      turns_since_last_compact: this.turns_since_last_compact,
      loaded_skill_total_tokens: this.loaded_skill_total_tokens,
      last_context_advisory_threshold: this.last_context_advisory_threshold,
      pressure_baseline_tokens: this.pressure_baseline_tokens,
      observed_tool_tokens: this.observed_tool_tokens,
      last_compact_ts: this.last_compact_ts,
      file_content_seen: { ...this.file_content_seen },
      pytest_failures: { ...this.pytest_failures },
      mcp_result_hashes: { ...this.mcp_result_hashes },
      grep_target_counts: { ...this.grep_target_counts },
      read_content_hashes: { ...this.read_content_hashes },
      log_file_cache: { ...this.log_file_cache },
      dir_listing_cache: { ...this.dir_listing_cache },
      cmd_output_hashes: { ...this.cmd_output_hashes },
    };
    return d;
  }

  /**
   * Return a JSON string for this cache, using a cached result when available.
   * The cache is set here and cleared by _invalidate_json_cache() on mutation.
   * json.dumps(..., ensure_ascii=False) → JSON.stringify (UTF-8 preserved; key
   * order = object insertion order = Python dict order). (Python to_json.)
   */
  to_json(): string {
    if (this._json_cache === null) {
      this._json_cache = JSON.stringify(this.to_dict());
    }
    return this._json_cache;
  }

  /** Invalidate the serialization cache after any mutation. */
  _invalidate_json_cache(): void {
    this._json_cache = null;
    this._bash_dedup_sorted_cache = null;
  }

  /** Return hints_seen for serialization (now a dict; no sorting needed). */
  _get_hints_seen_sorted(): Record<string, number> {
    return this.hints_seen;
  }

  /** Return a cached sorted list of bash_dedup_emitted_ids. */
  _get_bash_dedup_sorted(): string[] {
    if (this._bash_dedup_sorted_cache === null) {
      this._bash_dedup_sorted_cache = [...this.bash_dedup_emitted_ids].sort();
    }
    return this._bash_dedup_sorted_cache;
  }

  is_bash_history_empty(): boolean {
    return Object.keys(this.bash_history).length === 0;
  }

  is_web_history_empty(): boolean {
    return Object.keys(this.web_history).length === 0;
  }

  is_greps_empty(): boolean {
    return this.greps.length === 0;
  }

  is_glob_history_empty(): boolean {
    return this.glob_history.length === 0;
  }

  is_skill_history_empty(): boolean {
    return Object.keys(this.skill_history).length === 0;
  }

  has_hint_fingerprint(fingerprint: string): boolean {
    return fingerprint in this.hints_seen;
  }

  mark_hint_seen(fingerprint: string): void {
    const currentCount = this.hints_seen[fingerprint] ?? 0;
    this.hints_seen[fingerprint] = currentCount + 1;
    if (Object.keys(this.hints_seen).length > HINTS_SEEN_MAX) {
      const sorted = Object.entries(this.hints_seen).sort((a, b) => b[1] - a[1]);
      this.hints_seen = Object.fromEntries(sorted.slice(0, HINTS_SEEN_MAX));
    }
    this.last_activity_ts = Date.now() / 1000;
    this._invalidate_json_cache();
    this._pending_hint_save = true;
  }

  has_hint_content_hash(content_hash: string): boolean {
    return content_hash in this.hints_content_dedup;
  }

  get_hint_content_summary(content_hash: string): string | null {
    const entry = this.hints_content_dedup[content_hash];
    if (entry !== undefined) {
      return entry[0];
    }
    return null;
  }

  record_hint_content_seen(content_hash: string, summary: string): void {
    const existing = this.hints_content_dedup[content_hash];
    if (existing !== undefined) {
      this.hints_content_dedup[content_hash] = [existing[0], existing[1] + 1];
    } else {
      this.hints_content_dedup[content_hash] = [summary, 1];
    }
    if (Object.keys(this.hints_content_dedup).length > HINTS_CONTENT_DEDUP_MAX) {
      const removeN =
        Object.keys(this.hints_content_dedup).length -
        (HINTS_CONTENT_DEDUP_MAX - _HINTS_CONTENT_DEDUP_EVICT);
      _popOldest(this.hints_content_dedup, removeN);
    }
    this.last_activity_ts = Date.now() / 1000;
    this._invalidate_json_cache();
    this._pending_hint_save = true;
  }

  record_hint_emitted(hint_type: string): void {
    const current = this.hints_emitted_by_type[hint_type] ?? 0;
    this.hints_emitted_by_type[hint_type] = current + 1;
    this.last_activity_ts = Date.now() / 1000;
    this._invalidate_json_cache();
    this._pending_hint_save = true;
  }

  record_hint_suppressed(hint_type: string): void {
    const current = this.hints_suppressed_by_type[hint_type] ?? 0;
    this.hints_suppressed_by_type[hint_type] = current + 1;
    this.last_activity_ts = Date.now() / 1000;
    this._invalidate_json_cache();
    this._pending_hint_save = true;
  }

  // --- Per-file hint cooldown helpers ---

  has_session_hint_been_emitted(file_key: string): boolean {
    return this._session_hinted_files.has(file_key);
  }

  mark_session_hint_emitted(file_key: string): void {
    this._session_hinted_files.add(file_key);
  }

  clear_session_hint_cooldown(file_key: string): void {
    this._session_hinted_files.delete(file_key);
  }

  get_file_access_count(file_path: string): number {
    const key = paths.normalizeKey(file_path);
    return this.file_access_counts[key] ?? 0;
  }

  record_grep_target(file_path: string, cwd: string | null = null): boolean {
    if (this.unavailable) {
      return false;
    }
    const key = paths.normalizePathKey(file_path, cwd ?? undefined);
    const newCount = (this.grep_target_counts[key] ?? 0) + 1;
    this.grep_target_counts[key] = newCount;
    this._invalidate_json_cache();
    return newCount === 3;
  }

  has_grep_result_hash(result_hash: string): boolean {
    return result_hash in this.grep_result_hashes;
  }

  get_grep_result_pattern(result_hash: string): string | null {
    return this.grep_result_hashes[result_hash] ?? null;
  }

  record_grep_result_hash(result_hash: string, pattern: string): void {
    this.grep_result_hashes[result_hash] = pattern;
    if (Object.keys(this.grep_result_hashes).length > GREP_RESULT_HASHES_MAX) {
      const removeN =
        Object.keys(this.grep_result_hashes).length -
        (GREP_RESULT_HASHES_MAX - _GREP_RESULT_HASHES_EVICT);
      _popOldest(this.grep_result_hashes, removeN);
    }
    this.last_activity_ts = Date.now() / 1000;
    this._invalidate_json_cache();
  }

  record_read_hash(p: string, content_hash: string): void {
    this.read_content_hashes[p] = content_hash;
    if (Object.keys(this.read_content_hashes).length > READ_CONTENT_HASHES_MAX) {
      const removeN =
        Object.keys(this.read_content_hashes).length -
        (READ_CONTENT_HASHES_MAX - _READ_CONTENT_HASHES_EVICT);
      _popOldest(this.read_content_hashes, removeN);
    }
    this.last_activity_ts = Date.now() / 1000;
    this._invalidate_json_cache();
  }

  get_read_hash(p: string): string | null {
    return this.read_content_hashes[p] ?? null;
  }

  static _log_cache_key(p: string, size: number, mtime: number): string {
    return `${p}:${size}:${mtime.toFixed(9)}`;
  }

  record_log_read(p: string, size: number, mtime: number, content_hash: string): void {
    const key = SessionCache._log_cache_key(p, size, mtime);
    this.log_file_cache[key] = content_hash;
    if (Object.keys(this.log_file_cache).length > LOG_FILE_CACHE_MAX) {
      const removeN =
        Object.keys(this.log_file_cache).length -
        (LOG_FILE_CACHE_MAX - _LOG_FILE_CACHE_EVICT);
      _popOldest(this.log_file_cache, removeN);
    }
    this.last_activity_ts = Date.now() / 1000;
    this._invalidate_json_cache();
  }

  get_log_cache_hit(p: string, size: number, mtime: number): string | null {
    const key = SessionCache._log_cache_key(p, size, mtime);
    return this.log_file_cache[key] ?? null;
  }

  get_dir_listing_hit(key: string): string | null {
    return this.dir_listing_cache[key] ?? null;
  }

  record_dir_listing(key: string, output_hash: string): void {
    this.dir_listing_cache[key] = output_hash;
    if (Object.keys(this.dir_listing_cache).length > DIR_LISTING_CACHE_MAX) {
      const removeN =
        Object.keys(this.dir_listing_cache).length -
        (DIR_LISTING_CACHE_MAX - _DIR_LISTING_CACHE_EVICT);
      _popOldest(this.dir_listing_cache, removeN);
    }
    this.last_activity_ts = Date.now() / 1000;
    this._invalidate_json_cache();
  }

  lookup_mcp_output_id(tool_input_hash: string): string | null {
    return this.mcp_result_hashes[tool_input_hash] ?? null;
  }

  record_mcp_result(tool_input_hash: string, output_id: string): void {
    this.mcp_result_hashes[tool_input_hash] = output_id;
    if (Object.keys(this.mcp_result_hashes).length > MCP_RESULT_HASHES_MAX) {
      const removeN =
        Object.keys(this.mcp_result_hashes).length -
        (MCP_RESULT_HASHES_MAX - _MCP_RESULT_HASHES_EVICT);
      _popOldest(this.mcp_result_hashes, removeN);
    }
    this.last_activity_ts = Date.now() / 1000;
    this._invalidate_json_cache();
  }

  clear_mcp_result_hashes(): number {
    const count = Object.keys(this.mcp_result_hashes).length;
    if (count) {
      this.mcp_result_hashes = {};
      this.last_activity_ts = Date.now() / 1000;
      this._invalidate_json_cache();
    }
    return count;
  }

  // --- Cross-file content dedup helpers ---

  get_file_content_path(sha16: string): string | null {
    return this.file_content_seen[sha16] ?? null;
  }

  register_file_content(sha16: string, norm_path: string): void {
    if (sha16 in this.file_content_seen) {
      return;
    }
    this.file_content_seen[sha16] = norm_path;
    if (Object.keys(this.file_content_seen).length > FILE_CONTENT_SEEN_MAX) {
      const evict =
        Object.keys(this.file_content_seen).length -
        (FILE_CONTENT_SEEN_MAX - _FILE_CONTENT_SEEN_EVICT);
      _popOldest(this.file_content_seen, evict);
    }
    this.last_activity_ts = Date.now() / 1000;
    this._invalidate_json_cache();
  }

  // --- Pinned-symbol helpers ---

  add_pinned(spec: string): void {
    if (this.pinned_symbols.includes(spec)) {
      return;
    }
    if (this.pinned_symbols.length >= PINNED_SYMBOLS_MAX) {
      throw new Error(
        `pinned-symbol limit reached (${PINNED_SYMBOLS_MAX}); ` +
          "remove an entry with `token-goat pinned remove` first",
      );
    }
    this.pinned_symbols.push(spec);
    this.last_activity_ts = Date.now() / 1000;
    this._invalidate_json_cache();
  }

  remove_pinned(spec: string): boolean {
    const idx = this.pinned_symbols.indexOf(spec);
    if (idx === -1) {
      return false;
    }
    this.pinned_symbols.splice(idx, 1);
    this.last_activity_ts = Date.now() / 1000;
    this._invalidate_json_cache();
    return true;
  }

  list_pinned(): string[] {
    return [...this.pinned_symbols];
  }

  /** Deserialize from a plain object (JSON). Tolerates missing/corrupted fields. */
  static from_dict(d: Record<string, unknown>): SessionCache {
    const now = Date.now() / 1000;

    const schemaV = d["schema_version"] ?? 0;
    let schemaVInt = 0;
    const sv = _toInt(schemaV);
    if (sv !== undefined && schemaV) schemaVInt = sv;
    if (schemaVInt > SESSION_SCHEMA_VERSION) {
      _LOG.warning(
        "session schema_version %s > current %s; some fields may be ignored",
        sanitize_log_str(String(schemaV), _MAX_LOG_STR),
        SESSION_SCHEMA_VERSION,
      );
    }

    const session_id = d["session_id"];
    if (typeof session_id !== "string" || !session_id) {
      throw new Error(`session_id missing or invalid: ${JSON.stringify(session_id)}`);
    }

    const files: Record<string, FileEntry> = {};
    let skippedFileEntries = 0;
    for (const [k, v] of Object.entries(_asRecord(d["files"]))) {
      if (!_isRecord(v)) {
        skippedFileEntries += 1;
        continue;
      }
      const entry = _parse_file_entry(k, v, now);
      if (entry === null) {
        skippedFileEntries += 1;
      } else {
        files[k] = entry;
      }
    }

    const greps: GrepEntry[] = [];
    let skippedGrepEntries = 0;
    for (const g of _asArray(d["greps"])) {
      if (!_isRecord(g)) {
        skippedGrepEntries += 1;
        continue;
      }
      const grepEntry = _parse_grep_entry(g);
      if (grepEntry === null) {
        skippedGrepEntries += 1;
      } else {
        greps.push(grepEntry);
      }
    }

    if (skippedFileEntries > 0 || skippedGrepEntries > 0) {
      _LOG.info(
        "session cache: recovered with %d corrupted file entries, %d corrupted grep entries",
        skippedFileEntries,
        skippedGrepEntries,
      );
    }

    const grep_result_hashes: Record<string, string> = {};
    for (const [hk, pattern] of Object.entries(_asRecord(d["grep_result_hashes"]))) {
      if (typeof hk === "string" && typeof pattern === "string" && hk && pattern) {
        grep_result_hashes[hk] = pattern;
      }
    }

    const mcp_result_hashes: Record<string, string> = {};
    for (const [hk, outputId] of Object.entries(_asRecord(d["mcp_result_hashes"]))) {
      if (typeof hk === "string" && typeof outputId === "string" && hk && outputId) {
        mcp_result_hashes[hk] = outputId;
      }
    }

    const file_content_seen: Record<string, string> = {};
    for (const [sha16, fpath] of Object.entries(_asRecord(d["file_content_seen"]))) {
      if (typeof sha16 === "string" && typeof fpath === "string" && sha16 && fpath) {
        file_content_seen[sha16] = fpath;
      }
    }

    const edited_files: Record<string, number> = {};
    for (const [k, v] of Object.entries(_asRecord(d["edited_files"]))) {
      const n = _toInt(v);
      if (n !== undefined) edited_files[k] = Math.max(0, n);
    }

    const result_cache: Record<string, ResultCacheEntry> = {};
    for (const [k, v] of Object.entries(_asRecord(d["result_cache"]))) {
      if (!_isRecord(v)) continue;
      const rc = _parse_result_cache_entry(v);
      if (rc !== null) result_cache[k] = rc;
    }

    const bash_history: Record<string, BashEntry> = {};
    for (const [k, v] of Object.entries(_asRecord(d["bash_history"]))) {
      if (!_isRecord(v)) continue;
      const be = _parse_bash_entry(v);
      if (be !== null) bash_history[k] = be;
    }

    const glob_history: GlobEntry[] = [];
    for (const g of _asArray(d["glob_history"])) {
      if (!_isRecord(g)) continue;
      const ge = _parse_glob_entry(g);
      if (ge !== null) glob_history.push(ge);
    }

    const web_history: Record<string, WebEntry> = {};
    for (const [k, v] of Object.entries(_asRecord(d["web_history"]))) {
      if (!_isRecord(v)) continue;
      const we = _parse_web_entry(v);
      if (we !== null) web_history[k] = we;
    }

    const skill_history: Record<string, SkillEntry> = {};
    for (const [k, v] of Object.entries(_asRecord(d["skill_history"]))) {
      if (!_isRecord(v)) continue;
      const sk = _parse_skill_entry(v);
      if (sk !== null) skill_history[k] = sk;
    }

    let decisions: DecisionEntry[] = [];
    const rawDecisions = d["decisions"];
    if (Array.isArray(rawDecisions)) {
      for (const deRaw of rawDecisions) {
        if (!_isRecord(deRaw)) continue;
        const de = _parse_decision_entry(deRaw);
        if (de !== null) decisions.push(de);
      }
      if (decisions.length > DECISION_HISTORY_MAX) {
        decisions = decisions.slice(-DECISION_HISTORY_MAX);
      }
    }

    const snapshot_shas: Record<string, string> = {};
    for (const [k, v] of Object.entries(_asRecord(d["snapshot_shas"]))) {
      if (typeof k === "string" && typeof v === "string") snapshot_shas[k] = v;
    }

    // hints_seen: dict[str,int] (new) or list[str] (legacy → count 1).
    const hints_seen: Record<string, number> = {};
    const rawHints = d["hints_seen"];
    if (_isRecord(rawHints)) {
      for (const [h, count] of Object.entries(rawHints)) {
        if (typeof h === "string" && h) {
          const n = _toInt(count);
          hints_seen[h] = n !== undefined && count ? Math.max(1, n) : 1;
        }
      }
    } else if (Array.isArray(rawHints)) {
      for (const h of rawHints) {
        if (typeof h === "string" && h) hints_seen[h] = 1;
      }
    }

    // hints_content_dedup: dict[str, [summary, count]].
    const hints_content_dedup: Record<string, [string, number]> = {};
    for (const [hk, val] of Object.entries(_asRecord(d["hints_content_dedup"]))) {
      if (typeof hk === "string" && Array.isArray(val) && val.length === 2) {
        const summary = val[0];
        const count = val[1];
        if (typeof summary === "string" && typeof count === "number" && Number.isInteger(count)) {
          hints_content_dedup[hk] = [summary, Math.max(1, count)];
        }
      }
    }

    // bash_dedup_emitted_ids: list[str] → set.
    const bash_dedup_emitted_ids = new Set<string>();
    const rawDedup = d["bash_dedup_emitted_ids"];
    if (Array.isArray(rawDedup)) {
      for (const oid of rawDedup) {
        if (typeof oid === "string" && oid) bash_dedup_emitted_ids.add(oid);
      }
    }

    const stored_task_outputs: Record<string, string> = {};
    for (const [tid, oid] of Object.entries(_asRecord(d["stored_task_outputs"]))) {
      if (typeof tid === "string" && tid && typeof oid === "string" && oid) {
        stored_task_outputs[tid] = oid;
      }
    }

    const hints_emitted = _coerce_nonneg_int(d["hints_emitted"] ?? 0);
    const hints_ignored = _coerce_nonneg_int(d["hints_ignored"] ?? 0);
    const structured_hints_emitted = _coerce_nonneg_int(d["structured_hints_emitted"] ?? 0);
    const index_only_hints_emitted = _coerce_nonneg_int(d["index_only_hints_emitted"] ?? 0);

    const hints_emitted_by_type: Record<string, number> = {};
    for (const [ht, count] of Object.entries(_asRecord(d["hints_emitted_by_type"]))) {
      if (typeof ht === "string" && ht) {
        const n = _toInt(count);
        if (n !== undefined) hints_emitted_by_type[ht] = Math.max(0, n);
      }
    }

    const hints_suppressed_by_type: Record<string, number> = {};
    for (const [ht, count] of Object.entries(_asRecord(d["hints_suppressed_by_type"]))) {
      if (typeof ht === "string" && ht) {
        const n = _toInt(count);
        if (n !== undefined) hints_suppressed_by_type[ht] = Math.max(0, n);
      }
    }

    let recent_hints: Array<[string, number]> = [];
    const rawRecent = d["recent_hints"];
    if (Array.isArray(rawRecent)) {
      for (const item of rawRecent) {
        if (Array.isArray(item) && item.length === 2) {
          const p = item[0];
          const t = item[1];
          if (typeof p === "string" && typeof t === "number") {
            recent_hints.push([p, t]);
          }
        }
      }
      recent_hints = recent_hints.slice(-3);
    }

    const hint_category_history: Record<string, boolean[]> = {};
    for (const [catKey, catVals] of Object.entries(_asRecord(d["hint_category_history"]))) {
      if (typeof catKey !== "string" || !Array.isArray(catVals)) continue;
      const bools: boolean[] = [];
      for (const v of catVals) {
        if (typeof v === "number" || typeof v === "boolean") bools.push(Boolean(v));
      }
      if (bools.length > 0) {
        hint_category_history[catKey] = bools.slice(-_HINT_CAT_HISTORY_MAX);
      }
    }

    const image_shrink_count: Record<string, number> = {};
    for (const [imgPath, count] of Object.entries(_asRecord(d["image_shrink_count"]))) {
      if (typeof imgPath === "string" && imgPath) {
        const n = _toInt(count);
        if (n !== undefined) image_shrink_count[imgPath] = Math.max(0, n);
      }
    }

    const file_access_counts: Record<string, number> = {};
    for (const [fpath, count] of Object.entries(_asRecord(d["file_access_counts"]))) {
      if (typeof fpath === "string" && fpath) {
        const n = _toInt(count);
        if (n !== undefined) file_access_counts[fpath] = Math.max(0, n);
      }
    }

    const symbol_access_counts: Record<string, number> = {};
    for (const [symKey, count] of Object.entries(_asRecord(d["symbol_access_counts"]))) {
      if (typeof symKey === "string" && symKey) {
        const n = _toInt(count);
        if (n !== undefined) symbol_access_counts[symKey] = Math.max(0, n);
      }
    }

    const grep_target_counts: Record<string, number> = {};
    for (const [gtcPath, count] of Object.entries(_asRecord(d["grep_target_counts"]))) {
      if (typeof gtcPath === "string" && gtcPath) {
        const n = _toInt(count);
        if (n !== undefined) grep_target_counts[gtcPath] = Math.max(0, n);
      }
    }

    let pinned_symbols: string[] = [];
    const rawPinned = d["pinned_symbols"];
    if (Array.isArray(rawPinned)) {
      for (const spec of rawPinned) {
        if (typeof spec === "string" && spec && spec.includes("::")) {
          pinned_symbols.push(spec);
        }
      }
      pinned_symbols = pinned_symbols.slice(0, PINNED_SYMBOLS_MAX);
    }

    const rawTslc = d["turns_since_last_compact"] ?? 0;
    const turns_since_last_compact =
      typeof rawTslc === "number" ? Math.max(0, Math.trunc(rawTslc)) : 0;
    const rawLstt = d["loaded_skill_total_tokens"] ?? 0;
    const loaded_skill_total_tokens =
      typeof rawLstt === "number" ? Math.max(0, Math.trunc(rawLstt)) : 0;
    const rawLcat = d["last_context_advisory_threshold"];
    const last_context_advisory_threshold =
      rawLcat === 50 || rawLcat === 70 ? rawLcat : null;
    const rawPbt = d["pressure_baseline_tokens"] ?? 0;
    const pressure_baseline_tokens =
      typeof rawPbt === "number" ? Math.max(0, Math.trunc(rawPbt)) : 0;
    const rawOtt = d["observed_tool_tokens"] ?? 0;
    const observed_tool_tokens =
      typeof rawOtt === "number" ? Math.max(0, Math.trunc(rawOtt)) : 0;
    const rawLcts = d["last_compact_ts"] ?? 0.0;
    const last_compact_ts = typeof rawLcts === "number" ? rawLcts : 0.0;

    const pytest_failures: Record<string, string[]> = {};
    for (const [pfK, pfV] of Object.entries(_asRecord(d["pytest_failures"]))) {
      if (typeof pfK === "string" && Array.isArray(pfV)) {
        pytest_failures[pfK] = pfV.filter((s): s is string => typeof s === "string");
      }
    }

    const read_content_hashes: Record<string, string> = {};
    for (const [rchK, rchV] of Object.entries(_asRecord(d["read_content_hashes"]))) {
      if (typeof rchK === "string" && typeof rchV === "string") {
        read_content_hashes[rchK] = rchV;
      }
    }

    const log_file_cache: Record<string, string> = {};
    for (const [lfcK, lfcV] of Object.entries(_asRecord(d["log_file_cache"]))) {
      if (typeof lfcK === "string" && typeof lfcV === "string" && lfcK && lfcV) {
        log_file_cache[lfcK] = lfcV;
      }
    }

    const dir_listing_cache: Record<string, string> = {};
    for (const [dlcK, dlcV] of Object.entries(_asRecord(d["dir_listing_cache"]))) {
      if (typeof dlcK === "string" && typeof dlcV === "string" && dlcK && dlcV) {
        dir_listing_cache[dlcK] = dlcV;
      }
    }

    const cmd_output_hashes: Record<string, string> = {};
    for (const [cohK, cohV] of Object.entries(_asRecord(d["cmd_output_hashes"]))) {
      if (typeof cohK === "string" && typeof cohV === "string" && cohK && cohV) {
        cmd_output_hashes[cohK] = cohV;
      }
    }

    const rawVersion = d["version"];
    const version =
      typeof rawVersion === "number" ? _coerce_nonneg_int(d["version"] ?? 0) : 0;
    const rawCwd = d["cwd"];

    return new SessionCache({
      session_id,
      started_ts: _toFloatOr(d["started_ts"], now),
      last_activity_ts: _toFloatOr(d["last_activity_ts"], now),
      created_ts: _toFloatOr(d["created_ts"], now),
      files,
      greps,
      grep_result_hashes,
      edited_files,
      result_cache,
      bash_history,
      glob_history,
      web_history,
      skill_history,
      decisions,
      snapshot_shas,
      hints_seen,
      hints_content_dedup,
      bash_dedup_emitted_ids,
      stored_task_outputs,
      hints_emitted,
      hints_ignored,
      structured_hints_emitted,
      index_only_hints_emitted,
      hints_emitted_by_type,
      hints_suppressed_by_type,
      recent_hints,
      last_manifest_sha: String(d["last_manifest_sha"] ?? ""),
      last_manifest_ts: _coerce_ts(d["last_manifest_ts"] ?? 0.0),
      version,
      hint_category_history,
      image_shrink_count,
      file_access_counts,
      symbol_access_counts,
      grep_target_counts,
      pinned_symbols,
      cwd: typeof rawCwd === "string" ? rawCwd : null,
      turns_since_last_compact,
      loaded_skill_total_tokens,
      last_context_advisory_threshold,
      pressure_baseline_tokens,
      observed_tool_tokens,
      last_compact_ts,
      file_content_seen,
      pytest_failures,
      mcp_result_hashes,
      read_content_hashes,
      log_file_cache,
      dir_listing_cache,
      cmd_output_hashes,
    });
  }
}

// NOTE: there is intentionally NO `SessionCache extends SessionCacheShape`
// conformance guard. The class holds in-memory representations (Set/Map for
// several collection fields) that deliberately differ from the serialized
// SessionCacheShape (arrays/records); to_dict() performs that conversion. The
// per-field round-trip is what the serialization tests verify instead.

// ===========================================================================
// JSON-shape helpers (narrowers for untrusted parsed JSON)
// ===========================================================================

/** True when *v* is a plain (non-array, non-null) object. */
function _isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Coerce *v* to a record for iteration; non-records become {} (Python .get(k, {})). */
function _asRecord(v: unknown): Record<string, unknown> {
  return _isRecord(v) ? v : {};
}

/** Coerce *v* to an array for iteration; non-arrays become [] (Python .get(k, [])). */
function _asArray(v: unknown): unknown[] {
  return Array.isArray(v) ? v : [];
}

/** Map a record's values through *fn*, preserving key insertion order. */
function _mapValues<V, R>(rec: Record<string, V>, fn: (v: V) => R): Record<string, R> {
  const out: Record<string, R> = {};
  for (const [k, v] of Object.entries(rec)) {
    out[k] = fn(v);
  }
  return out;
}

// ===========================================================================
// Serialize / parse helpers (Python _serialize_*/_parse_*)
// ===========================================================================

/** Wire format of a single FileEntry (Python _FileEntryDict, total=False). */
export interface _FileEntryDict {
  rel_or_abs?: string;
  last_read_ts?: number;
  read_count?: number;
  line_ranges?: number[][];
  symbols_read?: string[];
  symbols_ts?: Record<string, number>;
  last_edit_ts?: number;
  read_mtime_ns?: number;
  read_size?: number;
  last_read_call_index?: number;
}

/** Wire format of a GrepEntry (Python _GrepEntryDict, total=False). */
export interface _GrepEntryDict {
  pattern?: string;
  path?: string | null;
  ts?: number;
  result_count?: number | null;
}

/** Wire format of a GlobEntry (Python _GlobEntryDict, total=False). */
export type _GlobEntryDict = _GrepEntryDict;

/** Wire format of a ResultCacheEntry (Python _ResultCacheEntryDict, total=False). */
export interface _ResultCacheEntryDict {
  file_sha?: string;
  kind?: string;
  result?: Record<string, unknown>;
  ts?: number;
}

/** Wire format of a BashEntry (Python _BashEntryDict, total=False). */
export interface _BashEntryDict {
  cmd_sha?: string;
  cmd_preview?: string;
  output_id?: string;
  ts?: number;
  stdout_bytes?: number;
  stderr_bytes?: number;
  exit_code?: number | null;
  truncated?: boolean;
  run_count?: number;
  output_sha?: string;
  // Open dict (Python `dict[str, Any]`): the round-trip _parse_bash_entry(v)
  // accepts a Record<string, unknown>, so the wire shape carries an index sig.
  [key: string]: unknown;
}

/** Wire format of a WebEntry (Python _WebEntryDict, total=False). */
export interface _WebEntryDict {
  url_sha?: string;
  url_preview?: string;
  output_id?: string;
  ts?: number;
  body_bytes?: number;
  status_code?: number | null;
  truncated?: boolean;
  content_type?: string | null;
  // Open dict (Python `dict[str, Any]`) — see _BashEntryDict above.
  [key: string]: unknown;
}

/** Wire format of a SkillEntry (Python _SkillEntryDict, total=False). */
export interface _SkillEntryDict {
  skill_name?: string;
  output_id?: string;
  content_sha?: string;
  ts?: number;
  body_bytes?: number;
  truncated?: boolean;
  run_count?: number;
  source_path?: string;
  compact_served_count?: number;
}

/** Wire format of a DecisionEntry (Python _DecisionEntryDict, total=False). */
export interface _DecisionEntryDict {
  text?: string;
  ts?: number;
  tag?: string;
}

/**
 * Serialize a FileEntry, omitting fields that equal their defaults.
 * (Python _serialize_file_entry.) Timestamps rounded to 3 dp.
 */
export function _serialize_file_entry(entry: FileEntry): _FileEntryDict {
  const d: _FileEntryDict = {
    rel_or_abs: entry.rel_or_abs,
    last_read_ts: _round_ts(entry.last_read_ts),
    read_count: entry.read_count,
  };
  if (entry.line_ranges.length > 0) {
    d.line_ranges = entry.line_ranges.map((r) => [r[0], r[1]]);
  }
  if (entry.symbols_read.length > 0) {
    d.symbols_read = [...entry.symbols_read];
  }
  const symbolsTs = entry.symbols_ts;
  if (symbolsTs && Object.keys(symbolsTs).length > 0) {
    d.symbols_ts = _mapValues(symbolsTs, (v) => _round_ts(v));
  }
  if (entry.last_edit_ts) {
    d.last_edit_ts = _round_ts(entry.last_edit_ts);
  }
  if (entry.read_mtime_ns !== null) {
    d.read_mtime_ns = entry.read_mtime_ns;
  }
  if (entry.read_size !== null) {
    d.read_size = entry.read_size;
  }
  if (entry.last_read_call_index) {
    d.last_read_call_index = entry.last_read_call_index;
  }
  return d;
}

/** Serialize a GrepEntry or GlobEntry to its wire dict with rounded ts. */
export function _serialize_pattern_entry(entry: GrepEntry | GlobEntry): _GrepEntryDict {
  const d: _GrepEntryDict = {
    pattern: entry.pattern,
    path: entry.path,
    ts: _round_ts(entry.ts),
  };
  if (entry.result_count !== null) {
    d.result_count = entry.result_count;
  }
  return d;
}

/** Serialize a GrepEntry. (Python _serialize_grep_entry.) */
export function _serialize_grep_entry(entry: GrepEntry): _GrepEntryDict {
  return _serialize_pattern_entry(entry);
}

/** Serialize a GlobEntry. (Python _serialize_glob_entry.) */
export function _serialize_glob_entry(entry: GlobEntry): _GlobEntryDict {
  return _serialize_pattern_entry(entry);
}

/**
 * Shared grep/glob parse: construct the entry via *factory*. (Python
 * _parse_pattern_entry_fields.) Returns null on parse error.
 */
export function _parse_pattern_entry_fields<T>(
  g: Record<string, unknown>,
  factory: (init: GrepEntryInit) => T,
  label: string,
): T | null {
  try {
    const rawPattern = g["pattern"] ?? "";
    const rawPath = g["path"];
    const rawTs = g["ts"] ?? 0.0;
    const rawResultCount = g["result_count"];
    return factory({
      pattern:
        typeof rawPattern === "string" ||
        typeof rawPattern === "number" ||
        (typeof rawPattern === "boolean")
          ? String(rawPattern)
          : "",
      path: typeof rawPath === "string" ? rawPath : null,
      ts: _coerce_ts(rawTs),
      result_count: is_real_int(rawResultCount) ? Math.trunc(rawResultCount) : null,
    });
  } catch (exc) {
    _LOG.debug(
      "session: skipping corrupted %s entry (%s): %s",
      label,
      exc,
      sanitize_log_str(_repr(g).slice(0, 120)),
    );
    return null;
  }
}

/** Deserialize one grep-entry dict. (Python _parse_grep_entry.) */
export function _parse_grep_entry(g: Record<string, unknown>): GrepEntry | null {
  return _parse_pattern_entry_fields(g, (init) => new GrepEntry(init), "grep");
}

/** Deserialize one glob-entry dict. (Python _parse_glob_entry.) */
export function _parse_glob_entry(g: Record<string, unknown>): GlobEntry | null {
  return _parse_pattern_entry_fields(g, (init) => new GlobEntry(init), "glob");
}

/** Serialize a ResultCacheEntry to its wire dict with rounded ts. */
export function _serialize_result_cache_entry(
  entry: ResultCacheEntry,
): _ResultCacheEntryDict {
  return {
    file_sha: entry.file_sha,
    kind: entry.kind,
    result: entry.result,
    ts: _round_ts(entry.ts),
  };
}

/**
 * Serialize a BashEntry, omitting default fields. (Python _serialize_bash_entry.)
 */
export function _serialize_bash_entry(entry: BashEntry): _BashEntryDict {
  const d: _BashEntryDict = {
    cmd_sha: entry.cmd_sha,
    cmd_preview: entry.cmd_preview,
    output_id: entry.output_id,
    ts: _round_ts(entry.ts),
    stdout_bytes: entry.stdout_bytes,
    stderr_bytes: entry.stderr_bytes,
  };
  if (entry.exit_code !== null) {
    d.exit_code = entry.exit_code;
  }
  if (entry.truncated) {
    d.truncated = true;
  }
  if (entry.run_count !== 1) {
    d.run_count = entry.run_count;
  }
  if (entry.output_sha) {
    d.output_sha = entry.output_sha;
  }
  return d;
}

/**
 * Serialize a WebEntry, omitting default fields. (Python _serialize_web_entry.)
 * Note: content_type is NOT serialized by the Python original (it is dropped on
 * save and defaults back to None on parse), so it is omitted here too.
 */
export function _serialize_web_entry(entry: WebEntry): _WebEntryDict {
  const d: _WebEntryDict = {
    url_sha: entry.url_sha,
    url_preview: entry.url_preview,
    output_id: entry.output_id,
    ts: _round_ts(entry.ts),
    body_bytes: entry.body_bytes,
  };
  if (entry.status_code !== null) {
    d.status_code = entry.status_code;
  }
  if (entry.truncated) {
    d.truncated = true;
  }
  return d;
}

/** Serialize a SkillEntry with rounded ts; omits empty source_path. */
export function _serialize_skill_entry(entry: SkillEntry): _SkillEntryDict {
  const d: _SkillEntryDict = {
    skill_name: entry.skill_name,
    output_id: entry.output_id,
    content_sha: entry.content_sha,
    ts: _round_ts(entry.ts),
    body_bytes: entry.body_bytes,
    truncated: entry.truncated,
    run_count: entry.run_count,
  };
  if (entry.source_path) {
    d.source_path = entry.source_path;
  }
  if (entry.compact_served_count) {
    d.compact_served_count = entry.compact_served_count;
  }
  return d;
}

/** Deserialize one skill-history dict. (Python _parse_skill_entry.) */
export function _parse_skill_entry(v: Record<string, unknown>): SkillEntry | null {
  const inner = (d: Record<string, unknown>): SkillEntry => {
    const rawRunCount = d["run_count"] ?? 1;
    const rcN = _toInt(rawRunCount);
    const run_count =
      typeof rawRunCount === "number" || typeof rawRunCount === "boolean"
        ? Math.max(1, rcN ?? 1)
        : 1;
    const rawCompactServed = d["compact_served_count"] ?? 0;
    const csN = _toInt(rawCompactServed);
    const compact_served_count =
      typeof rawCompactServed === "number" || typeof rawCompactServed === "boolean"
        ? Math.max(0, csN ?? 0)
        : 0;
    return new SkillEntry({
      skill_name: String(d["skill_name"] ?? ""),
      output_id: String(d["output_id"] ?? ""),
      content_sha: String(d["content_sha"] ?? ""),
      ts: _coerce_ts(d["ts"] ?? 0.0),
      body_bytes: _coerce_nonneg_int(d["body_bytes"] ?? 0),
      truncated: Boolean(d["truncated"] ?? false),
      run_count,
      source_path: String(d["source_path"] ?? ""),
      compact_served_count,
    });
  };
  return _safe_parse(inner, v, "skill");
}

/** Serialize a DecisionEntry; omits empty tag. (Python _serialize_decision_entry.) */
export function _serialize_decision_entry(entry: DecisionEntry): _DecisionEntryDict {
  const d: _DecisionEntryDict = { text: entry.text, ts: _round_ts(entry.ts) };
  if (entry.tag) {
    d.tag = entry.tag;
  }
  return d;
}

/** Deserialize one decision-log dict. (Python _parse_decision_entry.) */
export function _parse_decision_entry(v: Record<string, unknown>): DecisionEntry | null {
  const inner = (d: Record<string, unknown>): DecisionEntry => {
    let rawText = String(d["text"] ?? "").trim();
    if (!rawText) {
      throw new Error("decision text is empty");
    }
    if (rawText.length > _MAX_DECISION_TEXT_LEN) {
      rawText = rawText.slice(0, _MAX_DECISION_TEXT_LEN);
    }
    let rawTag = String(d["tag"] ?? "").trim();
    if (rawTag.length > 24) {
      rawTag = rawTag.slice(0, 24);
    }
    return new DecisionEntry({ text: rawText, ts: _coerce_ts(d["ts"] ?? 0.0), tag: rawTag });
  };
  return _safe_parse(inner, v, "decision");
}

/**
 * Deserialize one file-entry dict. (Python _parse_file_entry.) Coerces
 * line_ranges to [int,int] pairs (dropping malformed) and symbols_read to
 * strings (dropping non-scalars).
 */
export function _parse_file_entry(
  key: string,
  v: Record<string, unknown>,
  now: number,
): FileEntry | null {
  try {
    const rawRanges = _asArray(v["line_ranges"]);
    const line_ranges: Array<[number, number]> = [];
    for (const r of rawRanges) {
      if (Array.isArray(r) && r.length === 2) {
        const startVal = r[0];
        const endVal = r[1];
        if (_isPyInt(startVal) && _isPyInt(endVal)) {
          line_ranges.push([startVal, endVal]);
        }
      }
    }

    const rawSymbols = _asArray(v["symbols_read"]);
    const symbols_read: string[] = [];
    for (const s of rawSymbols) {
      if (
        (typeof s === "string" || typeof s === "number") &&
        !(typeof s === "boolean")
      ) {
        symbols_read.push(String(s));
      }
    }

    const rawLastEditTs = v["last_edit_ts"] ?? 0.0;
    let last_edit_ts: number;
    if (rawLastEditTs === null) {
      last_edit_ts = 0.0;
    } else {
      const f = _toFloatStrict(rawLastEditTs);
      last_edit_ts = f === undefined ? 0.0 : f;
    }

    const symbols_ts: Record<string, number> = {};
    const rawSymbolsTs = v["symbols_ts"];
    if (_isRecord(rawSymbolsTs)) {
      for (const [symName, symTs] of Object.entries(rawSymbolsTs)) {
        if (typeof symName === "string" && typeof symTs === "number") {
          symbols_ts[symName] = symTs;
        }
      }
    }

    return new FileEntry({
      rel_or_abs: String(v["rel_or_abs"] ?? key),
      last_read_ts: _toFloatOr(v["last_read_ts"], now),
      read_count: _coerce_nonneg_int(v["read_count"] ?? 0),
      line_ranges,
      symbols_read,
      last_edit_ts,
      symbols_ts,
      read_mtime_ns: _coerce_nonneg_int_or_none(v["read_mtime_ns"]),
      read_size: _coerce_nonneg_int_or_none(v["read_size"]),
      last_read_call_index: _toInt(v["last_read_call_index"]) || 0,
    });
  } catch (exc) {
    _LOG.debug(
      "session: skipping corrupted file entry for key %s: %s",
      sanitize_log_str(key, _MAX_LOG_STR),
      exc,
    );
    return null;
  }
}

/** Deserialize one result-cache entry. (Python _parse_result_cache_entry.) */
export function _parse_result_cache_entry(
  v: Record<string, unknown>,
): ResultCacheEntry | null {
  const inner = (d: Record<string, unknown>): ResultCacheEntry | null => {
    const rawSha = d["file_sha"] ?? "";
    const rawKind = d["kind"] ?? "";
    const rawResult = d["result"] ?? {};
    const rawTs = d["ts"] ?? 0.0;
    if (!_isRecord(rawResult)) {
      return null;
    }
    if (typeof rawKind !== "string" || (rawKind !== "symbol" && rawKind !== "section")) {
      return null;
    }
    return new ResultCacheEntry({
      file_sha:
        typeof rawSha === "string" ||
        typeof rawSha === "number" ||
        typeof rawSha === "boolean"
          ? String(rawSha)
          : "",
      kind: rawKind,
      result: { ...rawResult },
      ts: _coerce_ts(rawTs),
    });
  };
  return _safe_parse(inner, v, "result_cache");
}

/** Deserialize one web-history dict. (Python _parse_web_entry.) */
export function _parse_web_entry(v: Record<string, unknown>): WebEntry | null {
  const inner = (d: Record<string, unknown>): WebEntry => {
    const rawStatus = d["status_code"];
    const status_code: number | null = is_real_int(rawStatus) ? rawStatus : null;
    return new WebEntry({
      url_sha: String(d["url_sha"] ?? ""),
      url_preview: String(d["url_preview"] ?? ""),
      output_id: String(d["output_id"] ?? ""),
      ts: _coerce_ts(d["ts"] ?? 0.0),
      body_bytes: _coerce_nonneg_int(d["body_bytes"] ?? 0),
      status_code,
      truncated: Boolean(d["truncated"] ?? false),
    });
  };
  return _safe_parse(inner, v, "web");
}

/** Deserialize one bash-history dict. (Python _parse_bash_entry.) */
export function _parse_bash_entry(v: Record<string, unknown>): BashEntry | null {
  const inner = (d: Record<string, unknown>): BashEntry => {
    const rawExit = d["exit_code"];
    const exit_code: number | null = is_real_int(rawExit) ? rawExit : null;
    const rawRunCount = d["run_count"] ?? 1;
    const rcN = _toInt(rawRunCount);
    const run_count =
      typeof rawRunCount === "number" || typeof rawRunCount === "boolean"
        ? Math.max(1, rcN ?? 1)
        : 1;
    const outputShaRaw = d["output_sha"] ?? "";
    const output_sha = typeof outputShaRaw === "string" ? outputShaRaw : String(outputShaRaw);
    return new BashEntry({
      cmd_sha: String(d["cmd_sha"] ?? ""),
      cmd_preview: String(d["cmd_preview"] ?? ""),
      output_id: String(d["output_id"] ?? ""),
      ts: _coerce_ts(d["ts"] ?? 0.0),
      stdout_bytes: _coerce_nonneg_int(d["stdout_bytes"] ?? 0),
      stderr_bytes: _coerce_nonneg_int(d["stderr_bytes"] ?? 0),
      exit_code,
      truncated: Boolean(d["truncated"] ?? false),
      run_count,
      output_sha: typeof output_sha === "string" ? output_sha : "",
    });
  };
  return _safe_parse(inner, v, "bash");
}

/**
 * True when *v* is a genuine integer (Python `isinstance(x, int)` excluding
 * bool — used in line_ranges parsing where the Python source requires
 * `isinstance(start_val, int)`, which rejects floats AND treats bool as int).
 * Python's int check accepts True/False (bool subclasses int), so a [True,5]
 * pair would pass; we match by accepting boolean here too. But floats are
 * rejected. NOTE: the Python line_ranges check is `isinstance(start_val, int)`
 * which DOES accept bool — we replicate that quirk for parity.
 */
function _isPyInt(v: unknown): v is number {
  if (typeof v === "boolean") return true; // bool is an int subclass in Python
  return typeof v === "number" && Number.isInteger(v);
}

/** float() that returns undefined on TypeError/ValueError (number|string only). */
function _toFloatStrict(v: unknown): number | undefined {
  if (typeof v === "number") return v;
  if (typeof v === "boolean") return v ? 1 : 0;
  if (typeof v === "string") {
    const t = v.trim();
    if (t === "") return undefined;
    const n = Number(t);
    return Number.isFinite(n) ? n : undefined;
  }
  return undefined;
}

/** Python repr() approximation for log messages (used only in debug paths). */
function _repr(v: unknown): string {
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

// ===========================================================================
// _SessionDict — wire format of a serialized SessionCache
// ===========================================================================

/** Wire format of a serialized SessionCache (Python _SessionDict, total=False). */
export interface _SessionDict {
  schema_version?: number;
  created_by?: string;
  session_id?: string;
  started_ts?: number;
  last_activity_ts?: number;
  created_ts?: number;
  files?: Record<string, _FileEntryDict>;
  greps?: _GrepEntryDict[];
  grep_result_hashes?: Record<string, string>;
  mcp_result_hashes?: Record<string, string>;
  edited_files?: Record<string, number>;
  result_cache?: Record<string, _ResultCacheEntryDict>;
  bash_history?: Record<string, _BashEntryDict>;
  glob_history?: _GlobEntryDict[];
  web_history?: Record<string, _WebEntryDict>;
  skill_history?: Record<string, _SkillEntryDict>;
  decisions?: _DecisionEntryDict[];
  snapshot_shas?: Record<string, string>;
  hints_seen?: Record<string, number> | string[];
  hints_content_dedup?: Record<string, [string, number]>;
  bash_dedup_emitted_ids?: string[];
  stored_task_outputs?: Record<string, string>;
  hints_emitted?: number;
  hints_ignored?: number;
  structured_hints_emitted?: number;
  index_only_hints_emitted?: number;
  hints_emitted_by_type?: Record<string, number>;
  hints_suppressed_by_type?: Record<string, number>;
  recent_hints?: Array<[string, number]>;
  last_manifest_sha?: string;
  last_manifest_ts?: number;
  version?: number;
  hint_category_history?: Record<string, number[]>;
  image_shrink_count?: Record<string, number>;
  file_access_counts?: Record<string, number>;
  symbol_access_counts?: Record<string, number>;
  grep_target_counts?: Record<string, number>;
  pinned_symbols?: string[];
  cwd?: string | null;
  turns_since_last_compact?: number;
  loaded_skill_total_tokens?: number;
  last_context_advisory_threshold?: number | null;
  pressure_baseline_tokens?: number;
  observed_tool_tokens?: number;
  last_compact_ts?: number;
  file_content_seen?: Record<string, string>;
  pytest_failures?: Record<string, string[]>;
  read_content_hashes?: Record<string, string>;
  log_file_cache?: Record<string, string>;
  dir_listing_cache?: Record<string, string>;
  cmd_output_hashes?: Record<string, string>;
}

// ===========================================================================
// Fresh cache + path helpers
// ===========================================================================

/**
 * Return a new empty SessionCache for *session_id*. When *unavailable* is true
 * the cache is created with the unavailable flag set. (Python _fresh_cache.)
 */
function _fresh_cache(session_id: string, opts: { unavailable?: boolean } = {}): SessionCache {
  const now = Date.now() / 1000;
  return new SessionCache({
    session_id,
    started_ts: now,
    last_activity_ts: now,
    unavailable: opts.unavailable ?? false,
  });
}

/**
 * True when *s* starts with a Windows drive letter followed by a colon (both
 * cases). (Python _has_windows_drive_prefix.)
 */
function _has_windows_drive_prefix(s: string): boolean {
  return s.length >= 2 && s[1] === ":" && /[A-Za-z]/.test(s[0] ?? "");
}

/** Normalize a path for use as a cache key (alias to paths.normalizeKey). */
export function _normalize_path(p: string): string {
  return paths.normalizeKey(p);
}

const _SESSION_ID_RE = /^[a-zA-Z0-9_-]+$/;

/** Truncation limit for user-controlled values embedded in log messages. */
const _MAX_LOG_STR = 120;

// ===========================================================================
// Eviction + history-append helpers
// ===========================================================================

/**
 * FIFO-evict the oldest *evict_n* entries from *mapping* when it hits *cap*.
 * Uses object insertion order. No-ops if size < cap. (Python _evict_oldest.)
 */
export function _evict_oldest(
  mapping: Record<string, unknown>,
  cap: number,
  evict_n: number,
  label: string,
  session_id: string,
): void {
  const keys = Object.keys(mapping);
  if (keys.length < cap) {
    return;
  }
  const evictKeys = keys.slice(0, evict_n);
  for (const k of evictKeys) {
    delete mapping[k];
  }
  _LOG.debug("%s: evicted %d entries (cap=%d) for session=%s", label, evict_n, cap, session_id.slice(0, 16));
}

/**
 * Append an entry to a dict-based history, evicting oldest if needed. New keys
 * trigger eviction; updates preserve insertion order. (Python
 * _append_to_dict_history.)
 */
function _append_to_dict_history<V>(
  history_dict: Record<string, V>,
  key: string,
  entry: V,
  max_size: number,
  batch_size: number,
  label: string,
  session_id: string,
): void {
  if (!(key in history_dict)) {
    _evict_oldest(history_dict as Record<string, unknown>, max_size, batch_size, label, session_id);
  }
  history_dict[key] = entry;
}

/**
 * Append to a list-based history, slicing to the most recent *max_size*.
 * (Python _append_to_list_history — mutates *history_list* in place.)
 */
function _append_to_list_history<V>(
  history_list: V[],
  entry: V,
  max_size: number,
  batch_size: number,
  label: string,
  session_id: string,
): void {
  history_list.push(entry);
  if (history_list.length > max_size) {
    history_list.splice(0, history_list.length - max_size);
    _LOG.debug(
      "%s: evicted %d entries (cap=%d) for session=%s",
      label,
      batch_size,
      max_size,
      session_id.slice(0, 16),
    );
  }
}

/**
 * Validate session_id to prevent path traversal. Throws on invalid input.
 * Must be non-empty, <=128 chars, alphanumeric + hyphen + underscore only.
 * (Python validate_session_id.)
 */
export function validate_session_id(session_id: string): void {
  if (!session_id) {
    throw new Error("session_id cannot be empty");
  }
  if (session_id.length > 128) {
    throw new Error("session_id too long (max 128 chars)");
  }
  if (!_SESSION_ID_RE.test(session_id)) {
    throw new Error(`session_id contains invalid characters: ${JSON.stringify(session_id)}`);
  }
}

// ===========================================================================
// Tmp/corrupt-file cleanup + contention recording
// ===========================================================================

/**
 * Clean up stale `<name>.*.tmp` files left by interrupted atomic writes.
 * Best-effort; OSError is logged but never propagates. (Python
 * _cleanup_stale_tmp_files.)
 */
export function _cleanup_stale_tmp_files(p: string): void {
  try {
    const parent = path.dirname(p);
    if (!fs.existsSync(parent)) {
      return;
    }
    const baseName = path.basename(p);
    const prefix = baseName + ".";
    let entries: string[];
    try {
      entries = fs.readdirSync(parent);
    } catch (e) {
      _LOG.debug("failed to scan for tmp files near %s: %s", baseName, e);
      return;
    }
    for (const name of entries) {
      // glob pattern `${name}.*.tmp`: starts with "<name>." and ends with ".tmp".
      if (name.startsWith(prefix) && name.endsWith(".tmp")) {
        const tmpPath = path.join(parent, name);
        try {
          fs.unlinkSync(tmpPath);
          _LOG.debug("cleaned up stale tmp file: %s", name);
        } catch (e) {
          const code = (e as NodeJS.ErrnoException).code;
          if (code !== "ENOENT") {
            _LOG.debug("failed to clean up tmp file %s: %s", name, e);
          }
        }
      }
    }
  } catch (e) {
    _LOG.debug("failed to scan for tmp files near %s: %s", path.basename(p), e);
  }
}

/**
 * Move a corrupt session JSON to a timestamped archive for forensics. Failures
 * are logged but do not propagate. (Python _preserve_corrupt_file.)
 */
export function _preserve_corrupt_file(p: string): void {
  try {
    if (!fs.existsSync(p)) {
      return;
    }
    const timestamp = Math.floor(Date.now() / 1000);
    const corruptPath = `${p}.corrupt.${timestamp}`;
    fs.renameSync(p, corruptPath);
    _LOG.warning(
      "archived corrupt session file: %s -> %s",
      path.basename(p),
      path.basename(corruptPath),
    );
  } catch (e) {
    _LOG.debug("failed to archive corrupt session file %s: %s", path.basename(p), e);
  }
}

/**
 * Record a best-effort telemetry row when the session cache is locked. Uses a
 * disk touch-file under data_dir()/contention_marks/ as the cross-process dedup
 * token. (Python _record_cache_contention.) *exc* is the OSError-class error
 * that triggered the contention; only its constructor name is used in the row.
 */
export function _record_cache_contention(
  session_id: string,
  phase: string,
  exc: unknown,
): void {
  const mark = _contention_mark_path(session_id, phase);
  try {
    if (fs.existsSync(mark)) {
      return;
    }
    paths.ensureDir(path.dirname(mark));
    // O_CREAT|O_EXCL|O_WRONLY ("wx") is atomic: the process that wins records
    // the stat row; concurrent losers see the file on the next existsSync.
    const fd = fs.openSync(mark, "wx", 0o600);
    fs.closeSync(fd);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "EEXIST") {
      // Another process created the mark between our check and our exclusive
      // create — treat as already reported.
      return;
    }
    // Cannot create the mark (read-only FS, quota): fall through and record the
    // stat row anyway; duplicates are acceptable in edge cases.
  }
  // Best-effort telemetry row (Python `from . import db; db.record_stat(...)`).
  // Lazy-loaded so the native db dep is only pulled in when contention actually
  // fires; any failure is swallowed (the touch-file dedup is the durable part).
  try {
    const db = _loadDb();
    const tname = exc instanceof Error ? exc.constructor.name : "Error";
    db?.recordStat?.(undefined, "session_cache_unavailable", {
      detail: `${phase}:${session_id.slice(0, 16)}:${tname}`,
    });
  } catch {
    _LOG.debug("failed to record session cache contention");
  }
}

// ===========================================================================
// load / safe_load + migration
// ===========================================================================

/**
 * Validate session_id and return *cache* (if it matches), else load from disk.
 * Throws if *cache* belongs to a different session_id. (Python _resolve_cache.)
 */
function _resolve_cache(session_id: string, cache: SessionCache | null): SessionCache {
  validate_session_id(session_id);
  if (cache !== null) {
    if (cache.session_id !== session_id) {
      throw new Error(
        `cache.session_id ${JSON.stringify(cache.session_id)} does not match session_id ${JSON.stringify(session_id)}`,
      );
    }
    return cache;
  }
  return load(session_id);
}

/**
 * Add missing top-level + nested fields to a session dict with safe defaults,
 * for backwards compat with older session JSON. (Python _migrate_session.)
 */
export function _migrate_session(data: Record<string, unknown>): Record<string, unknown> {
  if (!("edited_files" in data)) data["edited_files"] = {};
  if (!("glob_history" in data)) data["glob_history"] = [];
  if (!("skill_history" in data)) data["skill_history"] = {};
  if (!("cwd" in data)) data["cwd"] = null;
  if (!("bash_dedup_emitted_ids" in data)) data["bash_dedup_emitted_ids"] = [];
  if (!("stored_task_outputs" in data)) data["stored_task_outputs"] = {};
  if (!("hints_emitted" in data)) data["hints_emitted"] = 0;
  if (!("hints_ignored" in data)) data["hints_ignored"] = 0;
  if (!("recent_hints" in data)) data["recent_hints"] = [];
  if (!("hint_category_history" in data)) data["hint_category_history"] = {};
  if (!("version" in data)) data["version"] = 0;

  const filesVal = data["files"];
  if (_isRecord(filesVal)) {
    for (const fileEntry of Object.values(filesVal)) {
      if (!_isRecord(fileEntry)) continue;
      if (!("symbols_ts" in fileEntry)) fileEntry["symbols_ts"] = {};
      if (!("last_edit_ts" in fileEntry)) fileEntry["last_edit_ts"] = 0.0;
    }
  }

  return data;
}

/**
 * Load JSON from *path*, returning {} on read or parse errors. Strips a leading
 * UTF-8 BOM before parsing. (Python _load_or_empty_json.)
 */
function _load_or_empty_json(p: string): Record<string, unknown> {
  try {
    let raw = fs.readFileSync(p, "utf8");
    raw = stripBOM(raw);
    const parsed = JSON.parse(raw);
    return _isRecord(parsed) ? parsed : {};
  } catch (e) {
    _LOG.debug("load failed for %s: %s — returning empty", p, e);
    return {};
  }
}

/**
 * Load the on-disk session cache for *session_id*, or create a fresh one.
 * Retries the read up to three times for transient races. Corrupted JSON is
 * treated as missing (reset rather than throw). (Python load.)
 */
export function load(session_id: string): SessionCache {
  validate_session_id(session_id);
  const t0 = _monotonicMs();
  const p = paths.sessionCachePath(session_id);

  _cleanup_stale_tmp_files(p);

  // Process-local load cache: skip the JSON read when the file is unchanged.
  let curMtime: number;
  try {
    curMtime = fs.existsSync(p) ? fs.statSync(p).mtimeMs / 1000 : -1.0;
  } catch {
    curMtime = -1.0;
  }
  const procEntry = _proc_load_cache.get(session_id);
  if (procEntry !== undefined) {
    const [cachedObj, cachedMtime] = procEntry;
    if (cachedMtime === curMtime && curMtime >= 0.0) {
      _LOG.debug("session load: proc-cache hit for %s", session_id.slice(0, 16));
      return cachedObj;
    }
  }

  let exists: boolean;
  try {
    exists = fs.existsSync(p);
  } catch (exc) {
    _LOG.debug("session cache unavailable (%s); returning empty cache", exc);
    _record_cache_contention(session_id, "load", exc);
    return _fresh_cache(session_id, { unavailable: true });
  }
  if (!exists) {
    _LOG.info("session opened: %s (new)", session_id.slice(0, 16));
    return _fresh_cache(session_id);
  }

  let readError: unknown = null;
  for (const delay of [0.0, 0.05, 0.15]) {
    if (delay) {
      _sleepSync(delay);
    }
    let raw: string;
    try {
      raw = fs.readFileSync(p, "utf8");
    } catch (exc) {
      readError = exc;
      continue;
    }
    let cache: SessionCache;
    try {
      const data = JSON.parse(stripBOM(raw)) as Record<string, unknown>;
      // Schema version guard: drop any cache not written by the current schema.
      const cachedV = data["schema_version"] ?? 0;
      let cachedVInt = 0;
      const cv = _toInt(cachedV);
      if (cv !== undefined && cachedV) cachedVInt = cv;
      if (cachedVInt !== SESSION_SCHEMA_VERSION) {
        _LOG.info(
          "session %s: schema_version %s != %s; dropping stale cache",
          session_id.slice(0, 16),
          sanitize_log_str(String(cachedV), _MAX_LOG_STR),
          SESSION_SCHEMA_VERSION,
        );
        return _fresh_cache(session_id);
      }
      const migrated = _migrate_session(data);
      cache = SessionCache.from_dict(migrated);
    } catch (e) {
      _LOG.warning("session cache corrupted (%s); resetting", e);
      _preserve_corrupt_file(p);
      return _fresh_cache(session_id);
    }
    cache.unavailable = false;
    // Record the on-disk fingerprint so save() can skip the CAS round-trip.
    try {
      const st = fs.statSync(p);
      cache._disk_mtime_ns = _mtimeNs(st);
      cache._disk_size = st.size;
      curMtime = st.mtimeMs / 1000;
    } catch {
      // benign — save() falls back to full CAS if fingerprint is missing.
    }
    const elapsedMs = _monotonicMs() - t0;
    _LOG.info(
      "session opened: %s (resuming, %d files tracked, %d edited, %.1fms)",
      session_id.slice(0, 16),
      Object.keys(cache.files).length,
      Object.keys(cache.edited_files).length,
      elapsedMs,
    );
    if (curMtime >= 0.0) {
      if (_proc_load_cache.size >= _PROC_LOAD_CACHE_MAX && !_proc_load_cache.has(session_id)) {
        const firstKey = _proc_load_cache.keys().next().value;
        if (firstKey !== undefined) _proc_load_cache.delete(firstKey);
      }
      _proc_load_cache.set(session_id, [cache, curMtime]);
    }
    return cache;
  }

  if (readError !== null) {
    _LOG.debug("session cache unavailable (%s); returning empty cache", readError);
    _record_cache_contention(session_id, "load", readError);
  }
  return _fresh_cache(session_id, { unavailable: true });
}

/**
 * Validate *session_id* and load its cache, returning null on any failure.
 * (Python safe_load.)
 */
export function safe_load(
  session_id: string,
  opts: { caller?: string } = {},
): SessionCache | null {
  const caller = opts.caller ?? "safe_load";
  try {
    validate_session_id(session_id);
    return load(session_id);
  } catch (exc) {
    // ValueError-class (invalid id) → warning; any other → debug.
    if (exc instanceof Error && /session_id/.test(exc.message)) {
      _LOG.warning("%s: invalid session_id rejected: %s", caller, exc.message);
      return null;
    }
    const sidShort = session_id ? session_id.slice(0, 8) : "<empty>";
    _LOG.debug("%s(%s) failed: %s", caller, sidShort, exc);
    return null;
  }
}

// ===========================================================================
// Session file size cap
// ===========================================================================

export const _SESSION_MAX_BYTES = 2 * 1024 * 1024; // 2 MB default

/**
 * Return the session file size cap in bytes, from TOKEN_GOAT_SESSION_MAX_BYTES
 * or the 2 MB default. (Python _get_session_max_bytes.)
 */
export function _get_session_max_bytes(): number {
  const v = envInt("TOKEN_GOAT_SESSION_MAX_BYTES", 0);
  return v > 0 ? v : _SESSION_MAX_BYTES;
}

/**
 * Trim *cache* in-place until its serialized size fits within *max_bytes*.
 * Trim order (largest-first, up to 5 passes): result_cache, bash_history,
 * web_history, greps, glob_history, hints_seen, bash_dedup_emitted_ids. Never
 * trims files/edited_files/skill_history/decisions. Returns true if any
 * trimming was performed. (Python _trim_session_for_size.)
 */
export function _trim_session_for_size(cache: SessionCache, max_bytes: number): boolean {
  cache._invalidate_json_cache();
  let currentSize = utf8Bytes(cache.to_json()).length;
  if (currentSize <= max_bytes) {
    return false;
  }

  _LOG.warning(
    "session size cap: %s serialized to %d bytes (cap=%d); trimming",
    cache.session_id.slice(0, 16),
    currentSize,
    max_bytes,
  );
  let trimmed = false;

  for (let _pass = 0; _pass < 5; _pass++) {
    cache._invalidate_json_cache();
    currentSize = utf8Bytes(cache.to_json()).length;
    if (currentSize <= max_bytes) {
      break;
    }

    const candidates: Array<[number, string]> = [];
    if (Object.keys(cache.result_cache).length) {
      candidates.push([Object.keys(cache.result_cache).length, "result_cache"]);
    }
    if (Object.keys(cache.bash_history).length) {
      candidates.push([Object.keys(cache.bash_history).length, "bash_history"]);
    }
    if (Object.keys(cache.web_history).length) {
      candidates.push([Object.keys(cache.web_history).length, "web_history"]);
    }
    if (cache.greps.length) {
      candidates.push([cache.greps.length, "greps"]);
    }
    if (cache.glob_history.length) {
      candidates.push([cache.glob_history.length, "glob_history"]);
    }
    if (Object.keys(cache.hints_seen).length) {
      candidates.push([Object.keys(cache.hints_seen).length, "hints_seen"]);
    }
    if (cache.bash_dedup_emitted_ids.size) {
      candidates.push([cache.bash_dedup_emitted_ids.size, "bash_dedup_emitted_ids"]);
    }

    if (candidates.length === 0) {
      break;
    }

    // sorted(reverse=True): primary by count desc, secondary by name desc to
    // match Python's tuple comparison (count, name) reversed.
    candidates.sort((a, b) => (b[0] - a[0]) || (b[1] < a[1] ? -1 : b[1] > a[1] ? 1 : 0));
    const first = candidates[0]!;
    const targetName = first[1];
    const targetCount = first[0];
    const dropN = Math.max(1, Math.floor(targetCount / 4)); // drop 25%

    if (targetName === "result_cache") {
      const ordered = Object.entries(cache.result_cache).sort((a, b) => a[1].ts - b[1].ts);
      const toRemove = new Set(ordered.slice(0, dropN).map(([k]) => k));
      cache.result_cache = Object.fromEntries(
        Object.entries(cache.result_cache).filter(([k]) => !toRemove.has(k)),
      );
    } else if (targetName === "bash_history") {
      const ordered = Object.entries(cache.bash_history).sort((a, b) => a[1].ts - b[1].ts);
      const toRemove = new Set(ordered.slice(0, dropN).map(([k]) => k));
      cache.bash_history = Object.fromEntries(
        Object.entries(cache.bash_history).filter(([k]) => !toRemove.has(k)),
      );
    } else if (targetName === "web_history") {
      const ordered = Object.entries(cache.web_history).sort((a, b) => a[1].ts - b[1].ts);
      const toRemove = new Set(ordered.slice(0, dropN).map(([k]) => k));
      cache.web_history = Object.fromEntries(
        Object.entries(cache.web_history).filter(([k]) => !toRemove.has(k)),
      );
    } else if (targetName === "greps") {
      cache.greps = [...cache.greps].sort((a, b) => a.ts - b.ts).slice(dropN);
    } else if (targetName === "glob_history") {
      cache.glob_history = [...cache.glob_history].sort((a, b) => a.ts - b.ts).slice(dropN);
    } else if (targetName === "hints_seen") {
      const sortedHints = Object.entries(cache.hints_seen).sort((a, b) => a[1] - b[1]);
      cache.hints_seen = Object.fromEntries(sortedHints.slice(dropN));
    } else if (targetName === "bash_dedup_emitted_ids") {
      const lst = [...cache.bash_dedup_emitted_ids];
      cache.bash_dedup_emitted_ids = new Set(lst.slice(dropN));
    }

    trimmed = true;
  }

  cache._invalidate_json_cache();
  const finalSize = utf8Bytes(cache.to_json()).length;
  if (finalSize > max_bytes) {
    _LOG.warning(
      "session size cap: could not reduce %s below cap after 5 passes (final=%d bytes, cap=%d)",
      cache.session_id.slice(0, 16),
      finalSize,
      max_bytes,
    );
  } else {
    _LOG.info(
      "session size cap: trimmed %s to %d bytes (cap=%d)",
      cache.session_id.slice(0, 16),
      finalSize,
      max_bytes,
    );
  }
  return trimmed;
}

/**
 * Atomically persist the session cache to disk with cross-process CAS. Uses the
 * sidecar advisory lockfile for mutual exclusion between hook processes; within
 * the critical section the on-disk version is re-read and, if newer,
 * _merge_session_caches re-applies our mutations on top. (Python save.)
 *
 * The version-counter CAS is the actual correctness mechanism; the lock just
 * bounds concurrent re-reads. A lock timeout aborts ONLY that attempt — it
 * never marks the cache unavailable (a busy lock must not drop future edits).
 */
export function save(cache: SessionCache): void {
  if (cache.unavailable) {
    _LOG.debug("session save skipped (cache unavailable): %s", cache.session_id.slice(0, 16));
    return;
  }
  const t0 = _monotonicMs();
  let lastExc: unknown = null;

  for (let attempt = 0; attempt < 3; attempt++) {
    if (attempt) {
      _sleepSync(0.05 * attempt);
    }

    // withFileLock serialises same-process threads (no-op in single-threaded
    // Node); the sidecar lockfile serialises across processes.
    const result = withFileLock<{ done: boolean }>(() => {
      const lockFd = _acquire_session_lock(cache.session_id);
      if (lockFd === null) {
        // Cross-process lock timed out — abort only this attempt.
        _LOG.debug(
          "session lock timeout (attempt %d): %s",
          attempt + 1,
          cache.session_id.slice(0, 16),
        );
        // Best-effort lock-timeout telemetry (Python lazy `from . import db`).
        try {
          const dbLock = _loadDb();
          dbLock?.recordStat?.(undefined, "session_cache_lock_timeout", {
            bytesSaved: 0,
            tokensSaved: 0,
            detail: cache.session_id.slice(0, 32),
          });
        } catch {
          /* swallow — telemetry is best-effort */
        }
        return { done: false };
      }
      try {
        let diskCache: SessionCache | null = null;
        const p = paths.sessionCachePath(cache.session_id);
        let skipCas = false;
        // Fast path is sound only when no other writer advanced the on-disk
        // version. Consult the version registry first to break fingerprint
        // aliasing from a same-process write.
        const inProcAhead = (_LAST_SAVED_VERSION.get(cache.session_id) ?? -1) > cache.version;
        if (!inProcAhead && (cache._disk_mtime_ns !== 0 || cache._disk_size !== 0)) {
          try {
            const st = fs.statSync(p);
            if (_mtimeNs(st) === cache._disk_mtime_ns && st.size === cache._disk_size) {
              skipCas = true;
            }
          } catch {
            // file may not exist yet; fall through to full CAS.
          }
        }

        if (!skipCas) {
          try {
            if (fs.existsSync(p)) {
              const raw = fs.readFileSync(p, "utf8");
              const data = JSON.parse(stripBOM(raw)) as Record<string, unknown>;
              const migrated = _migrate_session(data);
              diskCache = SessionCache.from_dict(migrated);
            }
          } catch {
            // On-disk file unreadable — treat as empty (will overwrite).
            diskCache = null;
          }
        }

        // Merge if another process wrote a newer version since we loaded.
        if (diskCache !== null && diskCache.version > cache.version) {
          _LOG.debug(
            "session CAS merge: %s (local v%d, remote v%d)",
            cache.session_id.slice(0, 16),
            cache.version,
            diskCache.version,
          );
          cache = _merge_session_caches(cache, diskCache);
        }

        // Bump version and write.
        cache.version =
          Math.max(diskCache !== null ? diskCache.version : 0, cache.version) + 1;
        cache._invalidate_json_cache();

        // Size cap: trim oldest entries before writing if over the limit.
        _trim_session_for_size(cache, _get_session_max_bytes());

        try {
          paths.atomicWriteText(p, cache.to_json());
          _LAST_SAVED_VERSION.set(cache.session_id, cache.version);
          try {
            const st2 = fs.statSync(p);
            cache._disk_mtime_ns = _mtimeNs(st2);
            cache._disk_size = st2.size;
            if (_proc_load_cache.has(cache.session_id)) {
              _proc_load_cache.set(cache.session_id, [cache, st2.mtimeMs / 1000]);
            }
          } catch {
            // benign.
          }
        } catch (exc) {
          lastExc = exc;
          return { done: false };
        }
      } finally {
        _release_session_lock(cache.session_id, lockFd);
      }
      return { done: true };
    });

    if (!result.done) {
      continue;
    }

    const elapsedMs = _monotonicMs() - t0;
    if (elapsedMs >= 100) {
      _LOG.warning(
        "session save slow: %s (%d files, %d greps) %.1fms",
        cache.session_id.slice(0, 16),
        Object.keys(cache.files).length,
        cache.greps.length,
        elapsedMs,
      );
    } else {
      _LOG.debug(
        "session saved: %s (%d files, %d greps) v%d %.1fms",
        cache.session_id.slice(0, 16),
        Object.keys(cache.files).length,
        cache.greps.length,
        cache.version,
        elapsedMs,
      );
    }
    return;
  }

  if (lastExc !== null) {
    _LOG.warning(
      "session save failed after retries: %s (session=%s, files=%d, greps=%d) — marking cache unavailable to skip future save attempts",
      lastExc,
      cache.session_id.slice(0, 16),
      Object.keys(cache.files).length,
      cache.greps.length,
    );
    cache.unavailable = true;
    _record_cache_contention(cache.session_id, "save", lastExc);
  }
}

/**
 * Return st_mtime_ns analogue. fs.Stats has mtimeNs (BigInt) on modern Node;
 * fall back to mtimeMs*1e6 when absent. Python compares st_mtime_ns exactly, so
 * we prefer the integer-nanosecond field when available.
 */
function _mtimeNs(st: fs.Stats): number {
  const ns = (st as fs.Stats & { mtimeNs?: bigint }).mtimeNs;
  if (typeof ns === "bigint") {
    return Number(ns);
  }
  return Math.round(st.mtimeMs * 1_000_000);
}

// ===========================================================================
// Sibling-module accessors (Python `from . import db` / `snapshots`)
// ===========================================================================
// Python defers these imports to call time so a missing/failing db never breaks
// the hot session path, but crucially the lazy `from . import db` resolves to
// the SAME module object as a top-level import (Python's module cache) — which
// is what tests patch. The faithful TS equivalent is a static ESM import: it
// shares the ESM module cache with the test's `import * as db`, so spies on
// db.recordStat are observed. (A `createRequire("./db.js")` would load a
// SEPARATE CJS instance — or throw ERR_REQUIRE_ESM on these "type":"module"
// files — and the spy would never fire.) db.ts now imports session too (for
// getCompressionStats session-scoping) — a benign db↔session ESM cycle: both
// modules reach each other only at call-time, so live bindings resolve and the
// cycle is init-order safe. The accessors keep the
// best-effort `| null` shape so every call site stays defensively guarded.

interface _DbModule {
  update_global_grep_pattern?: (hash: string, text: string, now: number) => void;
  recordStat?: (
    projectHash: string | undefined,
    kind: string,
    opts?: { tokensSaved?: number; bytesSaved?: number; detail?: string },
  ) => void;
}
interface _SnapshotsModule {
  cleanup_session?: (sessionId: string) => number;
}

function _loadDb(): _DbModule | null {
  return _dbModule;
}

function _loadSnapshots(): _SnapshotsModule | null {
  return _snapshotsModule;
}

// ===========================================================================
// Path-mutation prologue/epilogue helpers
// ===========================================================================

const _MAX_PATH_LEN = 4096;

// Sentinel "end line" for whole-file reads (Read tool reports no limit).
const _UNKNOWN_END_SENTINEL = 99_999;

/**
 * Reject or normalise a file path before storing. Absolute paths pass through;
 * relative paths with `..` traversal are rejected (returns ""); null bytes are
 * stripped. (Python _sanitize_path.)
 */
function _sanitize_path(p: string): string {
  if (!p) {
    return p;
  }
  p = p.replace(/\x00/g, "");
  if (p.length > _MAX_PATH_LEN) {
    _LOG.warning("mark_file: path exceeds max length (%d), truncating", _MAX_PATH_LEN);
    p = p.slice(0, _MAX_PATH_LEN);
  }
  const normalized = paths.normalizeKey(p);
  const isAbsolute = normalized.startsWith("/") || _has_windows_drive_prefix(normalized);
  if (!isAbsolute) {
    const parts = normalized.split("/");
    if (parts.includes("..")) {
      _LOG.warning("mark_file: rejected traversal path: %s", _repr(p));
      return "";
    }
  }
  return p;
}

/**
 * Validate *path*, resolve the session cache, and return [cache, key], or null
 * when the caller should bail (empty path or unavailable cache). (Python
 * _prepare_path_mutation.)
 */
function _prepare_path_mutation(
  session_id: string,
  p: string,
  cache: SessionCache | null,
): [SessionCache, string] | null {
  p = _sanitize_path(p);
  if (!p) {
    _LOG.debug("_prepare_path_mutation: empty path after sanitize (session=%s)", session_id.slice(0, 16));
    return null;
  }
  cache = _resolve_cache(session_id, cache);
  if (cache.unavailable) {
    _LOG.debug(
      "_prepare_path_mutation: session unavailable, skipping mutation (session=%s)",
      session_id.slice(0, 16),
    );
    return null;
  }
  return [cache, _normalize_path(p)];
}

/** Return a frozen set of already-read symbols for fast membership tests. */
function _symbols_set(entry: FileEntry): Set<string> {
  return new Set(entry.symbols_read);
}

/**
 * Stamp *now* as last-activity, flush the JSON cache, persist, and return.
 * (Python _commit_mutation.)
 */
function _commit_mutation(cache: SessionCache, now: number): SessionCache {
  cache.last_activity_ts = now;
  cache._invalidate_json_cache();
  save(cache);
  return cache;
}

/**
 * Record that a compaction just occurred for *session_id*. Sets last_compact_ts
 * and persists. (Python record_compact.)
 */
export function record_compact(session_id: string): void {
  const cache = safe_load(session_id, { caller: "record_compact" });
  if (cache === null) {
    return;
  }
  cache.last_compact_ts = Date.now() / 1000;
  save(cache);
}

// ===========================================================================
// mark_file_read + constants
// ===========================================================================

// Caps for grep/symbol/line-number/result-count and the cross-session grep
// dedup threshold. (Defined here, after the functions that don't need them but
// before mark_file_read which does, mirroring the Python ordering loosely.)
const _MAX_GREP_PATTERN_LEN = 200;
const _MAX_SYMBOL_LEN = 256;
const _MAX_SYMBOLS_PER_FILE = 50;
const _MAX_LINE_NUMBER = 100_000_000;
const _MAX_RESULT_COUNT = 1_000_000;
const _GREP_GLOBAL_MIN_RESULT_COUNT = 5;

/**
 * Record that a file (or a named symbol within it) was read this session. When
 * *symbol* is supplied, the read is symbol-level (no line-range tracking).
 * Otherwise *offset* / *limit* are converted to 1-indexed inclusive (start, end)
 * ranges merged with prior ranges. The returned cache is always saved. (Python
 * mark_file_read.)
 */
export function mark_file_read(
  session_id: string,
  p: string,
  offset: number | null = null,
  limit: number | null = null,
  opts: {
    symbol?: string | null;
    cache?: SessionCache | null;
    call_index?: number | null;
  } = {},
): SessionCache {
  let symbol = opts.symbol ?? null;
  const inCache = opts.cache ?? null;
  const call_index = opts.call_index ?? null;

  const prep = _prepare_path_mutation(session_id, p, inCache);
  if (prep === null) {
    return inCache ?? _fresh_cache(session_id);
  }
  const [cache, key] = prep;
  let entry = cache.files[key];
  const now = Date.now() / 1000;
  if (entry === undefined) {
    _evict_oldest(cache.files as Record<string, unknown>, FILES_MAX, _FILES_EVICT, "files", session_id);
    entry = new FileEntry({
      rel_or_abs: p,
      last_read_ts: now,
      read_count: 0,
      line_ranges: [],
      symbols_read: [],
    });
    cache.files[key] = entry;
  }
  entry.read_count += 1;
  entry.last_read_ts = now;
  if (call_index !== null) {
    entry.last_read_call_index = call_index;
  }
  // Capture the file's on-disk fingerprint as of this read (best-effort).
  try {
    const readStat = fs.statSync(p);
    entry.read_mtime_ns = _mtimeNs(readStat);
    entry.read_size = readStat.size;
  } catch {
    // unstattable path leaves the fingerprint at null (= unrecorded).
  }
  // Per-file access frequency counter, capped at FILES_MAX.
  cache.file_access_counts[key] = (cache.file_access_counts[key] ?? 0) + 1;
  if (Object.keys(cache.file_access_counts).length > FILES_MAX) {
    _evict_oldest(
      cache.file_access_counts as Record<string, unknown>,
      FILES_MAX,
      _FILES_EVICT,
      "file_access_counts",
      session_id,
    );
  }
  if (symbol) {
    symbol = sanitize_log_str(symbol, _MAX_SYMBOL_LEN);
    if (!symbol) {
      _LOG.debug("mark_file_read: symbol sanitized to empty string; skipping");
      return _commit_mutation(cache, now);
    }
    if (entry.symbols_read.length >= _MAX_SYMBOLS_PER_FILE) {
      _LOG.debug(
        "mark_file_read: symbols_read cap (%d) reached for %s; discarding %s",
        _MAX_SYMBOLS_PER_FILE,
        key,
        _repr(symbol),
      );
      return _commit_mutation(cache, now);
    }
    const alreadyKnown = entry.symbols_read.includes(symbol);
    if (!alreadyKnown) {
      entry.symbols_read.push(symbol);
      _LOG.debug(
        "mark_file_read: symbol recorded %s in %s (total symbols=%d)",
        _repr(symbol),
        key,
        entry.symbols_read.length,
      );
    }
    entry.symbols_ts[symbol] = now;
    _LOG.debug("mark_file_read: symbol %s timestamp recorded/updated to %.1f in %s", _repr(symbol), now, key);
    const symKey = `${key}::${symbol}`;
    cache.symbol_access_counts[symKey] = (cache.symbol_access_counts[symKey] ?? 0) + 1;
    if (Object.keys(cache.symbol_access_counts).length > FILES_MAX) {
      _evict_oldest(
        cache.symbol_access_counts as Record<string, unknown>,
        FILES_MAX,
        _FILES_EVICT,
        "symbol_access_counts",
        session_id,
      );
    }
  } else {
    const lineOffset =
      offset !== null ? Math.min(Math.max(0, Math.trunc(offset)), _MAX_LINE_NUMBER) : 0;
    const lineLimit =
      limit !== null ? Math.min(Math.max(0, Math.trunc(limit)), _MAX_LINE_NUMBER) : 0;
    const start = lineOffset + 1; // Read tool's offset is 0-indexed; store 1-indexed inclusive
    const end = lineLimit ? start + lineLimit - 1 : start + _UNKNOWN_END_SENTINEL;
    const prevRangeCount = entry.line_ranges.length;
    if (entry.read_count >= _READ_COUNT_FULL_FILE_THRESHOLD) {
      entry.line_ranges = [[0, 0]];
      _LOG.debug(
        "mark_file_read: line_ranges collapsed to full-file sentinel for %s (read_count=%d >= _READ_COUNT_FULL_FILE_THRESHOLD=%d)",
        key,
        entry.read_count,
        _READ_COUNT_FULL_FILE_THRESHOLD,
      );
    } else {
      let merged = _merge_ranges([...entry.line_ranges, [start, end]]);
      if (merged.length > _MAX_LINE_RANGES_PER_FILE) {
        const first = merged[0]!;
        const last = merged[merged.length - 1]!;
        merged = [[first[0], last[1]]];
        _LOG.debug(
          "mark_file_read: line_ranges collapsed to spanning range for %s (exceeded _MAX_LINE_RANGES_PER_FILE=%d)",
          key,
          _MAX_LINE_RANGES_PER_FILE,
        );
      }
      entry.line_ranges = merged;
    }
    const newRangeCount = entry.line_ranges.length;
    if (newRangeCount < prevRangeCount + 1) {
      _LOG.debug(
        "mark_file_read: ranges merged for %s: added (%d-%d), consolidated %d->%d ranges",
        key,
        start,
        end,
        prevRangeCount,
        newRangeCount,
      );
    } else {
      _LOG.debug(
        "mark_file_read: range (%d-%d) appended for %s (total ranges=%d)",
        start,
        end,
        key,
        newRangeCount,
      );
    }
  }
  return _commit_mutation(cache, now);
}

/** Return a stable SHA-1 hex digest for *pattern*. (Python _grep_pattern_hash.) */
function _grep_pattern_hash(pattern: string): string {
  return createHash("sha1").update(Buffer.from(pattern, "utf8")).digest("hex");
}

/** Record a Grep call. Returns the updated cache. (Python mark_grep.) */
export function mark_grep(
  session_id: string,
  pattern: string,
  p: string | null = null,
  result_count: number | null = null,
  opts: { cache?: SessionCache | null } = {},
): SessionCache {
  const cache = _resolve_cache(session_id, opts.cache ?? null);
  if (cache.unavailable) {
    return cache;
  }
  const now = Date.now() / 1000;
  const safePattern =
    pattern.length > _MAX_GREP_PATTERN_LEN ? pattern.slice(0, _MAX_GREP_PATTERN_LEN) : pattern;
  const entry = new GrepEntry({ pattern: safePattern, path: p, ts: now, result_count });
  _append_to_list_history(cache.greps, entry, GREPS_HISTORY_MAX, _GREPS_HISTORY_EVICT, "greps", session_id);
  _LOG.debug(
    "mark_grep: pattern=%s path=%s results=%s (session=%s total_greps=%d)",
    _repr(sanitize_log_str(safePattern.slice(0, 60), _MAX_LOG_STR)),
    p,
    result_count,
    session_id.slice(0, 16),
    cache.greps.length,
  );
  // Cross-session dedup: update global.db grep_patterns when result_count meets
  // the dedup threshold. Best-effort, lazy db load (Python `from . import db`).
  if (result_count !== null && result_count >= _GREP_GLOBAL_MIN_RESULT_COUNT) {
    const db = _loadDb();
    db?.update_global_grep_pattern?.(_grep_pattern_hash(safePattern), safePattern, now);
  }
  return _commit_mutation(cache, now);
}

/** Record a Glob call. Returns the updated cache. (Python mark_glob_run.) */
export function mark_glob_run(
  session_id: string,
  pattern: string,
  p: string | null = null,
  result_count: number | null = null,
  opts: { cache?: SessionCache | null } = {},
): SessionCache {
  const cache = _resolve_cache(session_id, opts.cache ?? null);
  if (cache.unavailable) {
    return cache;
  }
  const now = Date.now() / 1000;
  const safePattern =
    pattern.length > _MAX_GLOB_PATTERN_LEN ? pattern.slice(0, _MAX_GLOB_PATTERN_LEN) : pattern;
  const entry = new GlobEntry({ pattern: safePattern, path: p, ts: now, result_count });
  _append_to_list_history(
    cache.glob_history,
    entry,
    GLOB_HISTORY_MAX,
    _GLOB_HISTORY_EVICT,
    "glob_history",
    session_id,
  );
  _LOG.debug(
    "mark_glob_run: pattern=%s path=%s results=%s (session=%s total_globs=%d)",
    _repr(sanitize_log_str(safePattern.slice(0, 60), _MAX_LOG_STR)),
    p,
    result_count,
    session_id.slice(0, 16),
    cache.glob_history.length,
  );
  return _commit_mutation(cache, now);
}

/** Return the most recent GlobEntry for *pattern* in this session, or null. */
export function lookup_glob_entry(
  session_id: string,
  pattern: string,
  p: string | null = null,
  opts: { cache?: SessionCache | null } = {},
): GlobEntry | null {
  let cache: SessionCache;
  try {
    cache = _resolve_cache(session_id, opts.cache ?? null);
  } catch (exc) {
    if (exc instanceof Error && /session_id/.test(exc.message)) return null;
    throw exc;
  }
  if (cache.unavailable || cache.glob_history.length === 0) {
    return null;
  }
  for (let i = cache.glob_history.length - 1; i >= 0; i--) {
    const entry = cache.glob_history[i]!;
    if (entry.pattern === pattern && entry.path === p) {
      return entry;
    }
  }
  return null;
}

/** Return the most recent GrepEntry for *pattern* in this session, or null. */
export function lookup_grep_entry(
  session_id: string,
  pattern: string,
  p: string | null = null,
  opts: { cache?: SessionCache | null } = {},
): GrepEntry | null {
  let cache: SessionCache;
  try {
    cache = _resolve_cache(session_id, opts.cache ?? null);
  } catch (exc) {
    if (exc instanceof Error && /session_id/.test(exc.message)) return null;
    throw exc;
  }
  if (cache.unavailable || cache.greps.length === 0) {
    return null;
  }
  for (let i = cache.greps.length - 1; i >= 0; i--) {
    const entry = cache.greps[i]!;
    if (entry.pattern === pattern && entry.path === p) {
      return entry;
    }
  }
  return null;
}

/**
 * Coalesce overlapping and adjacent (start, end) line-range pairs. Output is
 * sorted ascending with no overlaps. (Python _merge_ranges.)
 */
export function _merge_ranges(ranges: Array<[number, number]>): Array<[number, number]> {
  if (ranges.length === 0) {
    return [];
  }
  if (ranges.length === 1) {
    const r = ranges[0]!;
    return [[r[0], r[1]]];
  }
  // sorted(): tuple compare → start asc, then end asc.
  const sortedR = [...ranges].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const first = sortedR[0]!;
  const out: Array<[number, number]> = [[first[0], first[1]]];
  for (let i = 1; i < sortedR.length; i++) {
    const [start, end] = sortedR[i]!;
    const last = out[out.length - 1]!;
    if (start <= last[1] + 1) {
      out[out.length - 1] = [last[0], Math.max(last[1], end)];
    } else {
      out.push([start, end]);
    }
  }
  return out;
}

/** Get a file entry by path, or null if not found. (Python get_file_entry.) */
export function get_file_entry(
  session_id: string,
  p: string,
  opts: { cache?: SessionCache | null } = {},
): FileEntry | null {
  const cache = _resolve_cache(session_id, opts.cache ?? null);
  if (cache.unavailable) {
    return null;
  }
  return cache.files[_normalize_path(p)] ?? null;
}

/**
 * Wipe the cache for a session (SessionStart on /clear or compact). Also clears
 * per-session content snapshots. (Python reset_session.)
 */
export function reset_session(session_id: string): void {
  validate_session_id(session_id);
  const p = paths.sessionCachePath(session_id);
  if (fs.existsSync(p)) {
    try {
      fs.unlinkSync(p);
    } catch (e) {
      _LOG.warning("failed to delete session cache %s: %s", p, e);
    }
  }
  // Snapshot cleanup is best-effort and isolated.
  try {
    const snapshots = _loadSnapshots();
    snapshots?.cleanup_session?.(session_id);
  } catch {
    _LOG.debug("reset_session: snapshot cleanup failed");
  }
}

/**
 * Record that a file was edited this session. Stamps last_edit_ts on the
 * matching FileEntry (if any) and clears the per-file hint cooldown. (Python
 * mark_file_edited.)
 */
export function mark_file_edited(
  session_id: string,
  p: string,
  opts: { cache?: SessionCache | null } = {},
): SessionCache {
  const inCache = opts.cache ?? null;
  const prep = _prepare_path_mutation(session_id, p, inCache);
  if (prep === null) {
    return inCache ?? _fresh_cache(session_id);
  }
  const [cache, key] = prep;
  const now = Date.now() / 1000;
  const prevCount = cache.edited_files[key] ?? 0;
  if (prevCount === 0) {
    _evict_oldest(
      cache.edited_files as Record<string, unknown>,
      EDITED_FILES_MAX,
      _EDITED_FILES_EVICT,
      "edited_files",
      session_id,
    );
  }
  cache.edited_files[key] = prevCount + 1;
  const entry = cache.files[key];
  if (entry !== undefined) {
    entry.last_edit_ts = now;
  }
  cache.clear_session_hint_cooldown(key);
  _LOG.debug(
    "mark_file_edited: %s (edit #%d this session, total edited files=%d)",
    key,
    prevCount + 1,
    Object.keys(cache.edited_files).length,
  );
  return _commit_mutation(cache, now);
}

/** Return edited files for this session: normalized_path → edit count. */
export function list_edited(session_id: string): Record<string, number> {
  return load(session_id).edited_files;
}

/** List all files touched in a session, sorted by last read time (newest first). */
export function list_touched(session_id: string): FileEntry[] {
  const cache = load(session_id);
  return Object.values(cache.files).sort((a, b) => _byLastReadTs(b, a));
}

/** Build the dict key for the in-session result cache. (Python _result_cache_key.) */
function _result_cache_key(rel_path: string, item: string, kind: string): string {
  return `${kind}\x1f${_normalize_path(rel_path)}\x1f${item}`;
}

/**
 * Return a cached result dict for (rel_path, item, kind, sha), or null on miss /
 * SHA mismatch / unavailable. Returns a fresh shallow copy. (Python
 * get_result_cache.)
 */
export function get_result_cache(
  session_id: string,
  rel_path: string,
  item: string,
  kind: string,
  file_sha: string,
  opts: { cache?: SessionCache | null } = {},
): Record<string, unknown> | null {
  try {
    validate_session_id(session_id);
  } catch {
    return null;
  }
  const cache = _resolve_cache(session_id, opts.cache ?? null);
  if (cache.unavailable) {
    return null;
  }
  const key = _result_cache_key(rel_path, item, kind);
  const entry = cache.result_cache[key];
  if (entry === undefined) {
    return null;
  }
  if (entry.file_sha !== file_sha) {
    _LOG.debug(
      "result_cache: stale entry for %s (sha %s != %s); dropping",
      key,
      entry.file_sha.slice(0, 8),
      file_sha.slice(0, 8),
    );
    delete cache.result_cache[key];
    _commit_mutation(cache, Date.now() / 1000);
    return null;
  }
  _LOG.debug("result_cache: hit for %s (kind=%s sha=%s)", key, kind, file_sha.slice(0, 8));
  return { ...entry.result };
}

/**
 * Store *result* in the in-session cache under (rel_path, item, kind). Enforces
 * RESULT_CACHE_MAX via FIFO eviction on fresh inserts. (Python put_result_cache.)
 */
export function put_result_cache(
  session_id: string,
  rel_path: string,
  item: string,
  kind: string,
  file_sha: string,
  result: Record<string, unknown>,
  opts: { cache?: SessionCache | null } = {},
): void {
  try {
    validate_session_id(session_id);
  } catch {
    return;
  }
  const cache = _resolve_cache(session_id, opts.cache ?? null);
  if (cache.unavailable) {
    return;
  }
  if (kind !== "symbol" && kind !== "section") {
    _LOG.debug("put_result_cache: rejecting unknown kind %s", _repr(kind));
    return;
  }
  const key = _result_cache_key(rel_path, item, kind);
  if (!(key in cache.result_cache)) {
    _evict_oldest(
      cache.result_cache as Record<string, unknown>,
      RESULT_CACHE_MAX,
      _RESULT_CACHE_EVICT,
      "result_cache",
      session_id,
    );
  }
  cache.result_cache[key] = new ResultCacheEntry({
    file_sha,
    kind,
    result: { ...result },
    ts: Date.now() / 1000,
  });
  _commit_mutation(cache, Date.now() / 1000);
  _LOG.debug(
    "result_cache: stored %s (kind=%s sha=%s size=%d)",
    key,
    kind,
    file_sha.slice(0, 8),
    Object.keys(cache.result_cache).length,
  );
}

/** Record a Bash invocation in the per-session history. (Python mark_bash_run.) */
export function mark_bash_run(
  session_id: string,
  cmd_sha: string,
  cmd_preview: string,
  output_id: string,
  stdout_bytes: number,
  stderr_bytes: number,
  exit_code: number | null,
  truncated: boolean,
  opts: { output_sha?: string; cache?: SessionCache | null } = {},
): SessionCache {
  const output_sha = opts.output_sha ?? "";
  const inCache = opts.cache ?? null;
  let cache: SessionCache;
  try {
    cache = _resolve_cache(session_id, inCache);
  } catch (exc) {
    _LOG.warning("mark_bash_run: invalid session_id (%s); skipping", exc);
    return inCache ?? _fresh_cache(session_id);
  }
  if (cache.unavailable) {
    return cache;
  }

  const safePreview = sanitize_log_str(cmd_preview, _MAX_BASH_PREVIEW);
  const now = Date.now() / 1000;
  const priorRunCount =
    cmd_sha in cache.bash_history ? cache.bash_history[cmd_sha]!.run_count : 0;
  const entry = new BashEntry({
    cmd_sha,
    cmd_preview: safePreview,
    output_id,
    ts: now,
    stdout_bytes: Math.max(0, Math.trunc(stdout_bytes)),
    stderr_bytes: Math.max(0, Math.trunc(stderr_bytes)),
    exit_code: is_real_int(exit_code) ? exit_code : null,
    truncated: Boolean(truncated),
    run_count: priorRunCount + 1,
    output_sha: typeof output_sha === "string" ? output_sha : "",
  });
  _append_to_dict_history(
    cache.bash_history,
    cmd_sha,
    entry,
    BASH_HISTORY_MAX,
    _BASH_HISTORY_EVICT,
    "bash_history",
    session_id,
  );
  return _commit_mutation(cache, now);
}

/**
 * Resolve *session_id*, guard on unavailable, then return accessor(cache)[key].
 * Returns null on invalid session_id or unavailable cache. (Python
 * _lookup_in_cache.)
 */
function _lookup_in_cache<V>(
  session_id: string,
  accessor: (c: SessionCache) => Record<string, V>,
  key: string,
  cache: SessionCache | null,
): V | null {
  let resolved: SessionCache;
  try {
    resolved = _resolve_cache(session_id, cache);
  } catch (exc) {
    if (exc instanceof Error && /session_id/.test(exc.message)) return null;
    throw exc;
  }
  if (resolved.unavailable) {
    return null;
  }
  return accessor(resolved)[key] ?? null;
}

/** Return the BashEntry for *cmd_sha* in *session_id*, or null. */
export function lookup_bash_entry(
  session_id: string,
  cmd_sha: string,
  opts: { cache?: SessionCache | null } = {},
): BashEntry | null {
  return _lookup_in_cache(session_id, (c) => c.bash_history, cmd_sha, opts.cache ?? null);
}

/** Record a WebFetch invocation in the per-session history. (Python mark_web_fetch.) */
export function mark_web_fetch(
  session_id: string,
  url_sha: string,
  url_preview: string,
  output_id: string,
  body_bytes: number,
  status_code: number | null,
  truncated: boolean,
  opts: { content_type?: string | null; cache?: SessionCache | null } = {},
): SessionCache {
  const content_type = opts.content_type ?? null;
  const inCache = opts.cache ?? null;
  let cache: SessionCache;
  try {
    cache = _resolve_cache(session_id, inCache);
  } catch (exc) {
    _LOG.warning("mark_web_fetch: invalid session_id (%s); skipping", exc);
    return inCache ?? _fresh_cache(session_id);
  }
  if (cache.unavailable) {
    return cache;
  }

  const safePreview = sanitize_log_str(url_preview, _MAX_WEB_URL_PREVIEW);
  const now = Date.now() / 1000;
  const entry = new WebEntry({
    url_sha,
    url_preview: safePreview,
    output_id,
    ts: now,
    body_bytes: Math.max(0, Math.trunc(body_bytes)),
    status_code: is_real_int(status_code) ? status_code : null,
    truncated: Boolean(truncated),
    content_type,
  });
  _append_to_dict_history(
    cache.web_history,
    url_sha,
    entry,
    WEB_HISTORY_MAX,
    _WEB_HISTORY_EVICT,
    "web_history",
    session_id,
  );
  return _commit_mutation(cache, now);
}

/** Return the WebEntry for *url_sha* in *session_id*, or null. */
export function lookup_web_entry(
  session_id: string,
  url_sha: string,
  opts: { cache?: SessionCache | null } = {},
): WebEntry | null {
  return _lookup_in_cache(session_id, (c) => c.web_history, url_sha, opts.cache ?? null);
}

/** Record a Skill tool load in the per-session history. (Python mark_skill_loaded.) */
export function mark_skill_loaded(
  session_id: string,
  skill_name: string,
  output_id: string,
  content_sha: string,
  body_bytes: number,
  truncated: boolean,
  opts: { source_path?: string; cache?: SessionCache | null } = {},
): SessionCache {
  const source_path = opts.source_path ?? "";
  const inCache = opts.cache ?? null;
  let cache: SessionCache;
  try {
    cache = _resolve_cache(session_id, inCache);
  } catch (exc) {
    _LOG.warning("mark_skill_loaded: invalid session_id (%s); skipping", exc);
    return inCache ?? _fresh_cache(session_id);
  }
  if (cache.unavailable) {
    return cache;
  }

  const safeName = sanitize_log_str(skill_name, _MAX_SKILL_NAME_LEN);
  if (!safeName) {
    _LOG.debug("mark_skill_loaded: skill_name sanitized to empty; skipping");
    return cache;
  }

  const now = Date.now() / 1000;
  const priorRunCount =
    safeName in cache.skill_history ? cache.skill_history[safeName]!.run_count : 0;
  const entry = new SkillEntry({
    skill_name: safeName,
    output_id,
    content_sha,
    ts: now,
    body_bytes: Math.max(0, Math.trunc(body_bytes)),
    truncated: Boolean(truncated),
    run_count: priorRunCount + 1,
    source_path,
  });
  _append_to_dict_history(
    cache.skill_history,
    safeName,
    entry,
    SKILL_HISTORY_MAX,
    _SKILL_HISTORY_EVICT,
    "skill_history",
    session_id,
  );
  // Recompute aggregate token count (body_bytes//4 across all skills).
  let totalBytes = 0;
  for (const e of Object.values(cache.skill_history)) {
    totalBytes += e.body_bytes;
  }
  cache.loaded_skill_total_tokens = Math.floor(totalBytes / 4);
  return _commit_mutation(cache, now);
}

/** Return the SkillEntry for *skill_name* in *session_id*, or null. */
export function lookup_skill_entry(
  session_id: string,
  skill_name: string,
  opts: { cache?: SessionCache | null } = {},
): SkillEntry | null {
  const safeName = sanitize_log_str(skill_name, _MAX_SKILL_NAME_LEN);
  if (!safeName) {
    return null;
  }
  return _lookup_in_cache(session_id, (c) => c.skill_history, safeName, opts.cache ?? null);
}

/** Return the skill_history dict for *session_id*, or null on error. */
export function get_skill_history(
  session_id: string,
  opts: { cache?: SessionCache | null } = {},
): Record<string, SkillEntry> | null {
  try {
    const resolved = _resolve_cache(session_id, opts.cache ?? null);
    if (resolved.unavailable) {
      return null;
    }
    return Object.keys(resolved.skill_history).length > 0 ? resolved.skill_history : null;
  } catch {
    return null;
  }
}

/**
 * Increment the compact_served_count for *skill_name* in *session_id*. Best
 * effort; never raises. (Python record_skill_compact_hit.)
 */
export function record_skill_compact_hit(
  session_id: string,
  skill_name: string,
  opts: { cache?: SessionCache | null } = {},
): SessionCache {
  const inCache = opts.cache ?? null;
  try {
    const safeName = sanitize_log_str(skill_name, _MAX_SKILL_NAME_LEN);
    if (!safeName) {
      return inCache ?? _fresh_cache(session_id);
    }
    const resolved = _resolve_cache(session_id, inCache);
    if (resolved.unavailable) {
      return resolved;
    }
    const existing = resolved.skill_history[safeName];
    if (existing === undefined) {
      return resolved;
    }
    const now = Date.now() / 1000;
    const updated = new SkillEntry({
      skill_name: existing.skill_name,
      output_id: existing.output_id,
      content_sha: existing.content_sha,
      ts: existing.ts,
      body_bytes: existing.body_bytes,
      truncated: existing.truncated,
      run_count: existing.run_count,
      source_path: existing.source_path,
      compact_served_count: existing.compact_served_count + 1,
    });
    resolved.skill_history[safeName] = updated;
    return _commit_mutation(resolved, now);
  } catch {
    _LOG.debug("record_skill_compact_hit: failed for skill %s", sanitize_log_str(skill_name, 80));
    return inCache ?? _fresh_cache(session_id);
  }
}

/** Append a decision-log entry to *session_id* and persist. (Python mark_decision.) */
export function mark_decision(
  session_id: string,
  text: string,
  opts: { tag?: string; cache?: SessionCache | null } = {},
): SessionCache {
  const tag = opts.tag ?? "";
  const inCache = opts.cache ?? null;
  let cache: SessionCache;
  try {
    cache = _resolve_cache(session_id, inCache);
  } catch (exc) {
    _LOG.warning("mark_decision: invalid session_id (%s); skipping", exc);
    return inCache ?? _fresh_cache(session_id);
  }
  if (cache.unavailable) {
    return cache;
  }

  const strippedText = typeof text === "string" ? text.trim() : "";
  if (!strippedText) {
    _LOG.debug("mark_decision: text sanitized to empty; skipping");
    return cache;
  }
  const sanitizedText = sanitize_log_str(strippedText, _MAX_DECISION_TEXT_LEN * 2);
  const safeText = sanitizedText.slice(0, _MAX_DECISION_TEXT_LEN);
  if (!safeText) {
    _LOG.debug("mark_decision: text sanitized to empty; skipping");
    return cache;
  }
  let safeTag = "";
  if (tag) {
    const strippedTag = tag.trim();
    if (strippedTag) {
      const sanitizedTag = sanitize_log_str(strippedTag, 48);
      safeTag = sanitizedTag.slice(0, 24);
    }
  }

  const now = Date.now() / 1000;
  const entry = new DecisionEntry({ text: safeText, ts: now, tag: safeTag });
  cache.decisions.push(entry);
  if (cache.decisions.length > DECISION_HISTORY_MAX) {
    const excess = cache.decisions.length - DECISION_HISTORY_MAX + _DECISION_HISTORY_EVICT;
    cache.decisions.splice(0, Math.max(1, excess));
  }
  return _commit_mutation(cache, now);
}

/**
 * Record that a snapshot for *file_path* with hash *content_sha* exists on disk.
 * (Python set_snapshot_sha.)
 */
export function set_snapshot_sha(
  session_id: string,
  file_path: string,
  content_sha: string,
  opts: { cache?: SessionCache | null } = {},
): SessionCache {
  const inCache = opts.cache ?? null;
  const prep = _prepare_path_mutation(session_id, file_path, inCache);
  if (prep === null) {
    return inCache ?? _fresh_cache(session_id);
  }
  const [cache, key] = prep;
  if (!(key in cache.snapshot_shas)) {
    _evict_oldest(
      cache.snapshot_shas as Record<string, unknown>,
      SNAPSHOT_SHAS_MAX,
      _SNAPSHOT_SHAS_EVICT,
      "snapshot_shas",
      session_id,
    );
  }
  cache.snapshot_shas[key] = content_sha;
  return _commit_mutation(cache, Date.now() / 1000);
}

/** Return the stored snapshot SHA for *file_path*, or null when absent. */
export function get_snapshot_sha(
  session_id: string,
  file_path: string,
  opts: { cache?: SessionCache | null } = {},
): string | null {
  let cache: SessionCache;
  try {
    cache = _resolve_cache(session_id, opts.cache ?? null);
  } catch (exc) {
    if (exc instanceof Error && /session_id/.test(exc.message)) return null;
    throw exc;
  }
  if (cache.unavailable) {
    return null;
  }
  return cache.snapshot_shas[_normalize_path(file_path)] ?? null;
}

/**
 * Delete session cache files older than max_age_hours. Also removes companion
 * .json.lock/.json.flock sidecars and orphaned .tmp files. Returns count
 * removed. (Python cleanup_stale.)
 */
export function cleanup_stale(max_age_hours = 24.0): number {
  let removed = 0;
  const sessionsDir = path.dirname(paths.sessionCachePath("dummy"));
  if (!fs.existsSync(sessionsDir)) {
    return 0;
  }
  const cutoff = Date.now() / 1000 - max_age_hours * 3600;
  let examined = 0;

  let dirEntries: string[];
  try {
    dirEntries = fs.readdirSync(sessionsDir);
  } catch {
    return 0;
  }

  for (const name of dirEntries) {
    if (!name.endsWith(".json")) continue;
    examined += 1;
    const stem = name.slice(0, -".json".length);
    if (!_SESSION_ID_RE.test(stem)) {
      _LOG.debug("cleanup_stale: skipping non-session-ID filename %s", _repr(name));
      continue;
    }
    const f = path.join(sessionsDir, name);
    let st: fs.Stats;
    try {
      st = fs.lstatSync(f);
    } catch (e) {
      _LOG.debug("cleanup_stale: could not stat %s: %s", name, e);
      continue;
    }
    if (st.isSymbolicLink()) {
      _LOG.warning("cleanup_stale: skipping symlink in sessions dir: %s", name);
      continue;
    }
    try {
      if (st.mtimeMs / 1000 < cutoff) {
        fs.unlinkSync(f);
        removed += 1;
        for (const sidecarSuffix of [".json.lock", ".json.flock"]) {
          const sidecar = path.join(sessionsDir, stem + sidecarSuffix);
          try {
            fs.unlinkSync(sidecar);
          } catch {
            // missing_ok
          }
        }
      }
    } catch (e) {
      _LOG.debug("cleanup_stale: could not remove %s: %s", name, e);
    }
  }

  // Sweep orphaned lock/flock sidecars whose .json was removed.
  for (const name of dirEntries) {
    if (!name.endsWith(".json.lock") && !name.endsWith(".json.flock")) continue;
    const idx = name.indexOf(".json.");
    const stem = idx >= 0 ? name.slice(0, idx) : name;
    if (!_SESSION_ID_RE.test(stem)) continue;
    const correspondingJson = path.join(sessionsDir, `${stem}.json`);
    if (!fs.existsSync(correspondingJson)) {
      const sidecar = path.join(sessionsDir, name);
      try {
        fs.unlinkSync(sidecar);
        _LOG.debug("cleanup_stale: removed orphaned sidecar %s", name);
      } catch {
        // missing_ok
      }
    }
  }

  // Sweep orphaned .tmp files: <session-id>.json.<digits>.<digits>.tmp.
  const tmpRe = /^([a-zA-Z0-9_-]+)\.json\.\d+\.\d+\.tmp$/;
  for (const name of dirEntries) {
    if (!name.endsWith(".tmp")) continue;
    if (!tmpRe.test(name)) continue;
    const tmpFile = path.join(sessionsDir, name);
    let st: fs.Stats;
    try {
      st = fs.lstatSync(tmpFile);
    } catch {
      continue;
    }
    if (st.isSymbolicLink()) continue;
    if (st.mtimeMs / 1000 < cutoff) {
      try {
        fs.unlinkSync(tmpFile);
        _LOG.debug("cleanup_stale: removed orphaned tmp file %s", name);
      } catch {
        // missing_ok
      }
    }
  }

  _LOG.info(
    "cleanup_stale: examined=%d removed=%d (max_age_hours=%.1f)",
    examined,
    removed,
    max_age_hours,
  );
  return removed;
}

// ===========================================================================
// Item 7: Adaptive hint suppression per category
// ===========================================================================

/**
 * Record whether a hint in *category* was accepted (true) or ignored (false).
 * Appends to the ring buffer, capping at _HINT_CAT_HISTORY_MAX. Does NOT save —
 * the caller's post-read save handles that. (Python record_hint_category.)
 */
export function record_hint_category(
  cache: SessionCache,
  category: string,
  accepted: boolean,
): void {
  if (cache.unavailable) {
    return;
  }
  let hist = cache.hint_category_history[category];
  if (hist === undefined) {
    hist = [];
    cache.hint_category_history[category] = hist;
  }
  hist.push(accepted);
  if (hist.length > _HINT_CAT_HISTORY_MAX) {
    cache.hint_category_history[category] = hist.slice(-_HINT_CAT_HISTORY_MAX);
  }
  cache._invalidate_json_cache();
}

/**
 * Return true when the last *threshold* hints in *category* were all ignored.
 * False (never suppress) when threshold <= 0, fewer than threshold entries, or
 * any of the last threshold was accepted. (Python _hint_category_should_suppress.)
 */
export function _hint_category_should_suppress(
  cache: SessionCache,
  category: string,
  threshold = 5,
): boolean {
  if (threshold <= 0) {
    return false;
  }
  const hist = cache.hint_category_history[category] ?? [];
  if (hist.length < threshold) {
    return false;
  }
  return !hist.slice(-threshold).some((v) => v);
}
