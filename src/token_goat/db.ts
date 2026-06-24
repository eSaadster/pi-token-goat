/**
 * SQLite + sqlite-vec storage layer for token-goat's indexed project data.
 *
 * Faithful port of src/token_goat/db.py to TypeScript using the better-sqlite3
 * SYNCHRONOUS API. The entire codebase is sync; better-sqlite3 is sync by
 * design, which is why it was chosen over node:sqlite (still experimental in
 * Node 20) or sqlite3 (async callbacks).
 *
 * Two database files are managed here:
 *
 * - `global.db` — project registry, global symbol snapshot, cumulative stats.
 *   Opened with openGlobal() / openGlobalReadonly().
 * - `projects/{hash}.db` — per-project files, symbols, refs, sections, chunks,
 *   and sqlite-vec embeddings. Opened with openProject() / openProjectReadonly().
 *
 * Key design decisions (preserved verbatim from the Python original):
 *
 * - WAL mode + immutable fallback: all writable connections enable WAL so
 *   readers don't block writers. On sandboxed systems WAL SHM creation can
 *   fail; connectDb() falls back to immutable=1 URI mode so reads still work
 *   while writes silently fail (expected in that context).
 * - Corruption auto-recovery: repairIfCorrupt() runs PRAGMA integrity_check
 *   once per path per process. A genuine failure triggers rebuild() which
 *   renames the corrupt file to `*.bad-<ts>` and opens a fresh (empty) DB.
 *   Transient errors (locked, busy, I/O) are NOT treated as corruption.
 * - Read-only openers skip integrity_check and DDL entirely.
 * - File-based writer lock: projectWriterLock() uses a PID + timestamp lockfile
 *   (created via O_EXCL) rather than BEGIN EXCLUSIVE so the worker can detect
 *   and clear stale locks from crashed processes without blocking indefinitely.
 *
 * sqlite-vec handling: the sqlite-vec package is NOT a hard dependency. It is
 * loaded defensively inside try/catch via a guarded dynamic import; if the
 * package is absent OR the extension fails to load, `embeddingsDisabled` is
 * set in the project DB's meta table and the embeddings virtual table is
 * skipped. tsc + tests pass without the package installed. See
 * `_tryLoadVecExtension`.
 *
 * Parity notes (Python → TS):
 *  - sqlite3.Connection → Database from better-sqlite3 (the default export).
 *    better-sqlite3 is sync, so there is no async/await anywhere; every
 *    function is sync and every "context manager" is a higher-order function
 *    that takes a callback (openGlobal((conn) => { ... })). This mirrors the
 *    Python `with open_global() as conn:` body literally.
 *  - sqlite3.Row row_factory → better-sqlite3 returns plain objects by
 *    default (get/getAll/iterate), so named-column access works without a
 *    row_factory assignment. raw() returns tuples when needed.
 *  - contextlib.contextmanager → the withX helpers below (openGlobal, etc.)
 *    take a callback and guarantee close in a finally. This is the idiomatic
 *    sync-resource pattern in JS and reproduces the Python contract: the
 *    connection is closed even when the body throws.
 *  - os.open(O_CREAT | O_EXCL) → fs.openSync(path, "wx") for the atomic lock
 *    create. "wx" is the Node flag for "fail if exists" — the exact mutex
 *    semantic the Python O_EXCL provides.
 *  - psutil.pid_exists → process.kill(pid, 0) try/catch. Node has no psutil;
 *    process.kill(pid, 0) is the POSIX analogue (signal 0 = existence check).
 *    EPERM on Windows maps to "alive" (same as the Python PermissionError
 *    branch); ESRCH maps to "dead".
 *  - sqlite3.OperationalError / DatabaseError → better-sqlite3 throws a single
 *    SqliteError type with a `.code` property ("SQLITE_BUSY", "SQLITE_READONLY",
 *    "SQLITE_CORRUPT", ...). The transient/readonly predicates below inspect
 *    both `.code` and `.message` so the same error taxonomy holds.
 *  - Exports use snake_case-only where the Python test suite asserts on the
 *    name directly (SCHEMA_VERSION, EMBED_DIM, _pid_alive, _INTEGRITY_CHECKED,
 *    _SCHEMA_MIGRATED, error classes). Public helpers use camelCase per TS
 *    convention; the snake_case names are aliased for the test parity layer.
 *
 * `verbatimModuleSyntax` is on → all type-only imports use `import type`.
 * `exactOptionalPropertyTypes` is on → optional fields are `T | undefined`,
 * never `T | null`, and callers pass `undefined` (not null) for "not set".
 * `noUncheckedIndexedAccess` is on → array/record accesses are narrowed.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import Database from "better-sqlite3";

import type { Database as DatabaseType, Statement } from "better-sqlite3";

import { createRequire } from "node:module";
import { performance } from "node:perf_hooks";

import * as Paths from "./paths.js";
import { getLogger } from "./util.js";
import { registerReset } from "./reset.js";
// session ↔ db is a benign ESM cycle: session statically imports db (call-time
// use via its _dbModule namespace), and db reaches session.safe_load only inside
// getCompressionStats (call-time). ESM live bindings resolve by call time, so
// neither module touches the other's bindings at eval time.
import * as session from "./session.js";

// Node's real `createRequire` bound to THIS module's URL. Works identically
// under native ESM (`node`/`tsx`) and vitest. A bare `require` is `undefined`
// under native ESM — relying on it silently disabled sqlite-vec and crashed
// the perf-timing path (caught by running the real CLI, not the test suite,
// since vitest injects a global `require`).
const _nodeRequire = createRequire(import.meta.url);

// ===========================================================================
// Constants
// ===========================================================================

/** Per-project schema version stamped into the meta table. */
export const SCHEMA_VERSION = 2 as const;

/** Embedding dimension for BAAI/bge-small-en-v1.5. */
export const EMBED_DIM = 384 as const;

/**
 * Maximum age (seconds) of a writer lock before it is treated as stale.
 * 10 minutes is longer than the slowest realistic full reindex, so a
 * legitimately running worker is never falsely evicted.
 */
export const LOCK_STALE_SECONDS = 600 as const;

/**
 * Cross-platform lock timeout: if a lock was written on a different platform,
 * PID validation is unreliable. Treat such locks as stale after 60 seconds.
 */
export const LOCK_CROSS_PLATFORM_STALE_SECONDS = 60 as const;

/**
 * Cap the WAL file size. journal_size_limit makes SQLite truncate the -wal file
 * back down to this size whenever a checkpoint resets it. 64 MB is generous
 * headroom over the ~4 MB the default 1000-page autocheckpoint normally holds.
 */
const WAL_SIZE_LIMIT_BYTES = 64 * 1024 * 1024;

const _LOG = getLogger("db");

// ===========================================================================
// Error classes (mirror the Python DBError hierarchy)
// ===========================================================================

/** Base class for token-goat database errors. */
export class DBError extends Error {}

/** DB integrity check failed; file quarantined. */
export class DBCorruptionError extends DBError {}

/** DB locked or busy; caller may retry. */
export class DBBusyError extends DBError {}

/** DB is in read-only / sandbox mode; writes are silently dropped. */
export class DBReadOnlyError extends DBError {}

/** sqlite-vec couldn't be loaded — embeddings disabled. */
export class VecExtensionUnavailable extends DBError {}

// ===========================================================================
// Per-path caches (mutable module-global state — registered with reset)
// ===========================================================================
//
// Python kept these as module-level dicts/sets. In TS they are module-scoped
// `let`s/`Map`s; tests clear them via clearModuleCaches() (reset.ts) through
// the registration at the bottom of this file. This is the contract described
// in reset.ts's header: every module that owns mutable module-global state
// registers a reset fn at load time.

/** Cache of paths that have passed integrity_check this process. */
const _INTEGRITY_CHECKED = new Map<string, boolean>();

/** Cache of project DB paths that have had the line_count migration confirmed. */
const _SCHEMA_MIGRATED = new Map<string, boolean>();

/** Tracks which DB paths have had the last_access_epoch stats migration applied. */
const _STATS_EPOCH_MIGRATED = new Set<string>();

// ===========================================================================
// DDL — global and per-project table definitions (verbatim from db.py)
// ===========================================================================

const _GLOBAL_TABLES = `
-- Cross-session Grep pattern frequency index.
CREATE TABLE IF NOT EXISTS grep_patterns (
    pattern_hash  TEXT    PRIMARY KEY,
    first_pattern TEXT    NOT NULL,
    last_ts       REAL    NOT NULL,
    count         INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX IF NOT EXISTS idx_grep_patterns_last_ts ON grep_patterns(last_ts);

-- Registry of every project token-goat has indexed, keyed by SHA1(canonical_path).
CREATE TABLE IF NOT EXISTS projects (
    hash       TEXT    PRIMARY KEY,
    root       TEXT    NOT NULL,
    marker     TEXT    NOT NULL,
    first_seen INTEGER NOT NULL,
    last_seen  INTEGER NOT NULL,
    file_count INTEGER NOT NULL DEFAULT 0,
    languages  TEXT    NOT NULL DEFAULT ''
);

-- Snapshot of top-level symbols across all projects.
CREATE TABLE IF NOT EXISTS symbols_global (
    project_hash TEXT NOT NULL,
    name         TEXT NOT NULL,
    kind         TEXT NOT NULL,
    file_rel     TEXT NOT NULL,
    line         INTEGER NOT NULL,
    signature    TEXT,
    FOREIGN KEY (project_hash) REFERENCES projects(hash) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_symbols_global_name    ON symbols_global(name);
CREATE INDEX IF NOT EXISTS idx_symbols_global_project ON symbols_global(project_hash);
CREATE INDEX IF NOT EXISTS idx_symbols_global_name_kind ON symbols_global(name, kind);

-- Cumulative token/byte savings events.
CREATE TABLE IF NOT EXISTS stats (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    ts           INTEGER NOT NULL,
    kind         TEXT    NOT NULL,
    tokens_saved INTEGER NOT NULL DEFAULT 0,
    bytes_saved  INTEGER NOT NULL DEFAULT 0,
    detail       TEXT,
    last_access_epoch REAL
);
CREATE INDEX IF NOT EXISTS idx_stats_global_ts   ON stats(ts);
CREATE INDEX IF NOT EXISTS idx_stats_global_kind ON stats(kind);

-- Key/value store for global configuration and version stamps.
CREATE TABLE IF NOT EXISTS meta (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
);

-- Tracks how many times a needle was searched without a hit.
CREATE TABLE IF NOT EXISTS miss_patterns (
    needle          TEXT    NOT NULL,
    file_hint       TEXT    NOT NULL DEFAULT '',
    miss_count      INTEGER NOT NULL DEFAULT 1,
    last_miss_epoch REAL    NOT NULL,
    PRIMARY KEY (needle, file_hint)
);
`;

const _PROJECT_TABLES = `
CREATE TABLE IF NOT EXISTS meta (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS files (
    rel_path       TEXT    PRIMARY KEY,
    language       TEXT    NOT NULL,
    size           INTEGER NOT NULL,
    line_count     INTEGER,
    mtime          REAL    NOT NULL,
    content_sha256 TEXT    NOT NULL,
    indexed_at     INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS symbols (
    id        INTEGER PRIMARY KEY AUTOINCREMENT,
    name      TEXT    NOT NULL,
    kind      TEXT    NOT NULL,
    file_rel  TEXT    NOT NULL,
    line      INTEGER NOT NULL,
    col       INTEGER NOT NULL DEFAULT 0,
    end_line  INTEGER,
    signature TEXT,
    parent_id INTEGER,
    FOREIGN KEY (file_rel)   REFERENCES files(rel_path) ON DELETE CASCADE,
    FOREIGN KEY (parent_id)  REFERENCES symbols(id)     ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_symbols_name ON symbols(name);
CREATE INDEX IF NOT EXISTS idx_symbols_file ON symbols(file_rel);
CREATE INDEX IF NOT EXISTS idx_symbols_file_name ON symbols(file_rel, name);
CREATE INDEX IF NOT EXISTS idx_symbols_name_kind ON symbols(name, kind);

CREATE TABLE IF NOT EXISTS refs (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    symbol_name TEXT    NOT NULL,
    file_rel    TEXT    NOT NULL,
    line        INTEGER NOT NULL,
    col         INTEGER NOT NULL DEFAULT 0,
    context     TEXT,
    FOREIGN KEY (file_rel) REFERENCES files(rel_path) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_refs_symbol ON refs(symbol_name);

CREATE TABLE IF NOT EXISTS sections (
    id       INTEGER PRIMARY KEY AUTOINCREMENT,
    file_rel TEXT    NOT NULL,
    heading  TEXT    NOT NULL,
    level    INTEGER NOT NULL DEFAULT 1,
    line     INTEGER NOT NULL,
    end_line INTEGER,
    FOREIGN KEY (file_rel) REFERENCES files(rel_path) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_sections_file    ON sections(file_rel);
CREATE INDEX IF NOT EXISTS idx_sections_heading ON sections(heading);
CREATE INDEX IF NOT EXISTS idx_sections_file_heading ON sections(file_rel, heading);

CREATE TABLE IF NOT EXISTS imports_exports (
    id       INTEGER PRIMARY KEY AUTOINCREMENT,
    file_rel TEXT    NOT NULL,
    kind     TEXT    NOT NULL,
    target   TEXT    NOT NULL,
    line     INTEGER NOT NULL,
    FOREIGN KEY (file_rel) REFERENCES files(rel_path) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_imex_file ON imports_exports(file_rel);

CREATE TABLE IF NOT EXISTS chunks (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    file_rel       TEXT    NOT NULL,
    start_line     INTEGER NOT NULL,
    end_line       INTEGER NOT NULL,
    content_sha256 TEXT    NOT NULL,
    kind           TEXT    NOT NULL,
    text           TEXT    NOT NULL,
    FOREIGN KEY (file_rel) REFERENCES files(rel_path) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_chunks_file ON chunks(file_rel);
CREATE INDEX IF NOT EXISTS idx_chunks_sha  ON chunks(content_sha256);

CREATE TABLE IF NOT EXISTS stats (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    ts           INTEGER NOT NULL,
    kind         TEXT    NOT NULL,
    tokens_saved INTEGER NOT NULL DEFAULT 0,
    bytes_saved  INTEGER NOT NULL DEFAULT 0,
    detail       TEXT,
    last_access_epoch REAL
);
CREATE INDEX IF NOT EXISTS idx_stats_ts   ON stats(ts);
CREATE INDEX IF NOT EXISTS idx_stats_kind ON stats(kind);

CREATE TABLE IF NOT EXISTS repomap_cache (
    rel_path      TEXT    NOT NULL,
    mtime         REAL    NOT NULL,
    size          INTEGER NOT NULL,
    summary_text  TEXT    NOT NULL,
    created_at    INTEGER NOT NULL,
    PRIMARY KEY (rel_path, mtime, size),
    FOREIGN KEY (rel_path) REFERENCES files(rel_path) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_repomap_cache_file ON repomap_cache(rel_path);
`;

const _EMBEDDINGS_DDL = `
CREATE VIRTUAL TABLE IF NOT EXISTS embeddings USING vec0(
    chunk_id  INTEGER PRIMARY KEY,
    embedding FLOAT[${EMBED_DIM}]
);
`;

// Allowlist of table names permitted in dynamic COUNT queries (SQL-injection guard).
const _KNOWN_PROJECT_TABLES = new Set([
  "files",
  "symbols",
  "refs",
  "sections",
  "chunks",
  "embeddings",
]);

// ===========================================================================
// sqlite-vec defensive loader
// ===========================================================================
//
// sqlite-vec is an OPTIONAL native extension. On the dev machine (and in CI
// without it installed) the package is absent. We MUST NOT let that break tsc
// (no `import sqlite_vec from "sqlite-vec"` at module top level — tsc would
// error on the missing module) or break module load (no top-level await on a
// dynamic import that would reject). The loader below:
//
//   1. Resolves the package path loosely via require.resolve under try/catch
//      (so a missing package returns undefined, not a thrown TypeError).
//   2. Dynamically requires it (CommonJS interop — better-sqlite3's
//      loadExtension needs the native .node/.dll path, which the package's
//      `load` export wires up).
//   3. Calls db.loadExtension on the resolved path OR invokes the package's
//      default `load(db)` helper if present (the @sqlite-vec/sqlite-vec
//      package exports a JS helper that locates the native binary portably).
//   4. Any failure sets embeddingsDisabled = true and returns; the caller
//      (ensureProjectSchema) then writes the meta flag and skips the
//      embeddings DDL.
//
// The whole thing is synchronous (better-sqlite3 is sync; sqlite-vec's load
// is sync too). No async, no top-level await.

/**
 * Cached path to the sqlite-vec native extension, or null if the package is
 * not installed / not resolvable. Resolved once on first use.
 */
let _vecExtPath: string | null | undefined = undefined;

/**
 * Attempt to locate the sqlite-vec loadable extension path.
 *
 * Uses createRequire(require.resolve) to locate the package from this module's
 * own location (so it works under both tsc-build and vitest-ts paths). Returns
 * the absolute path to the loadable extension, or null if the package is not
 * installed / cannot be resolved. Never throws.
 */
function _resolveVecExtensionPath(): string | null {
  if (_vecExtPath !== undefined) return _vecExtPath;
  try {
    // Lazy require so a missing package does not break module load. We use
    // createRequire to get a CJS require from inside an ESM module; this works
    // under both Node ESM and vitest's ts-loader.
    //
    // The sqlite-vec npm package exposes its native loadable at a known
    // subpath. We try the JS helper first (preferred), then the raw .node.
    const modPath = _nodeRequire.resolve("sqlite-vec");
    _vecExtPath = modPath;
  } catch {
    // Package not installed — not an error. Embeddings will be disabled.
    _vecExtPath = null;
  }
  return _vecExtPath;
}

/**
 * Try to load the sqlite-vec extension into `db`.
 *
 * Returns true on success, false on any failure (package missing, extension
 * load error, version mismatch). Never throws — the caller treats "false" as
 * "embeddings disabled" and proceeds without them.
 *
 * better-sqlite3's loadExtension takes the absolute path to a loadable
 * extension. The sqlite-vec package ships both a JS helper (which locates the
 * native binary across platforms) and the native file itself; we try the JS
 * helper first via the package's main export, then fall back to enabling
 * extension loading and pointing loadExtension at the resolved native path.
 */
function _tryLoadVecExtension(db: DatabaseType): boolean {
  // First strategy: the JS helper exported by the sqlite-vec package.
  try {
    // createRequire lets us require() from an ESM module synchronously.
    const modulePath = _resolveVecExtensionPath();
    if (modulePath === null) {
      return false;
    }
    // The package's main export has a `load(db)` helper that handles
    // cross-platform native-binary location. We require it dynamically (via
    // Node's createRequire) so tsc never sees a static `import sqlite_vec`
    // (which would fail tsc when the package is absent).
    const sqliteVecMod = _nodeRequire(modulePath) as {
      load?: (db: DatabaseType) => void;
    };
    if (typeof sqliteVecMod.load === "function") {
      db.loadExtension = db.loadExtension; // touch to satisfy no-unused
      sqliteVecMod.load(db);
      _LOG.debug("sqlite-vec loaded via JS helper");
      return true;
    }
  } catch (err) {
    _LOG.debug(`sqlite-vec JS helper load failed: ${String(err)}`);
  }

  // Second strategy: load the raw native extension by resolved path.
  try {
    const modulePath = _resolveVecExtensionPath();
    if (modulePath === null) return false;
    // Replace the .js/.cjs main with the packaged .dylib/.so/.dll. The sqlite-vec
    // package bundles the loadable under a known name relative to its main.
    const extDir = path.dirname(modulePath);
    const candidates = [
      path.join(extDir, "sqlite-vec"),
      path.join(extDir, "build", "Release", "sqlite-vec"),
      modulePath.replace(/\.(c?js|mjs)$/, ""),
    ];
    for (const candidate of candidates) {
      try {
        db.loadExtension(candidate);
        _LOG.debug(`sqlite-vec loaded via native path: ${candidate}`);
        return true;
      } catch {
        // try next candidate
      }
    }
  } catch (err) {
    _LOG.warning(`sqlite-vec native load failed: ${String(err)}`);
  }
  return false;
}

// ===========================================================================
// Connection management
// ===========================================================================

/**
 * Close `db`, silently suppressing any exception.
 *
 * Accepts undefined so callers can safely pass a connection variable that may
 * not have been assigned yet (e.g. when Database construction itself throws
 * before the local is bound).
 */
function _closeConn(db: DatabaseType | undefined): void {
  if (db === undefined) return;
  try {
    db.close();
  } catch {
    // Swallow — already-closed, OS-level file lock errors, etc.
  }
}

/**
 * Apply the standard read/write PRAGMA settings to `db`.
 *
 * busy_timeout, synchronous=NORMAL, foreign_keys=ON, cache_size=64MB,
 * temp_store=MEMORY, mmap_size=128MB, journal_size_limit=64MB.
 *
 * When suppress is true, PRAGMA failures (immutable-fallback paths) are
 * swallowed rather than thrown.
 */
function _applyConnectionPragmas(
  db: DatabaseType,
  opts: { suppress?: boolean } = {},
): void {
  const apply = (): void => {
    db.pragma(`busy_timeout = 5000`);
    db.pragma(`synchronous = NORMAL`);
    db.pragma(`foreign_keys = ON`);
    db.pragma(`cache_size = -65536`); // 64 MB (KB when negative)
    db.pragma(`temp_store = MEMORY`);
    db.pragma(`mmap_size = 134217728`); // 128 MB
    db.pragma(`journal_size_limit = ${WAL_SIZE_LIMIT_BYTES}`);
  };
  if (opts.suppress) {
    try {
      apply();
    } catch {
      // Immutable fallback — PRAGMAs may be rejected; swallow.
    }
  } else {
    apply();
  }
}

/**
 * Open a connection with WAL, foreign keys, and (optionally) sqlite-vec.
 *
 * Falls back to an immutable read-only connection when WAL coordination fails
 * (e.g. sandboxed environments cannot create the WAL shm file). The fallback
 * bypasses WAL entirely and serves read paths; any write attempt fails with
 * "attempt to write a readonly database", the correct behaviour for a
 * sandboxed read-only caller.
 */
function _connect(dbPath: string, opts: { loadVec?: boolean } = {}): DatabaseType {
  const loadVec = opts.loadVec ?? true;
  Paths.ensureDir(path.dirname(dbPath));

  let db: DatabaseType = new Database(dbPath, {
    // isolation_level=None in Python → autocommit off by default in
    // better-sqlite3 we control transactions explicitly. better-sqlite3 is
    // always in a transaction by default (like Python's default isolation);
    // we use db.exec / db.prepare + run which auto-begins. To match the
    // Python `isolation_level=None` (autocommit) semantics for DDL/PRAGMAs,
    // we leave the default and rely on exec() which commits implicitly.
    timeout: 10000, // 10s — matches Python timeout=10.0
    fileMustExist: false,
  });
  try {
    const modeRow = db.pragma(`journal_mode = WAL`, { simple: true });
    const actualMode =
      typeof modeRow === "string" ? modeRow : String(modeRow ?? "unknown");
    if (actualMode.toLowerCase() !== "wal") {
      _LOG.debug(
        `journal_mode for ${path.basename(dbPath)}: requested WAL but got ${actualMode} (network/FAT volume?)`,
      );
    } else {
      _LOG.debug(`journal_mode for ${path.basename(dbPath)}: WAL confirmed`);
    }
    _applyConnectionPragmas(db);
    // Best-effort PASSIVE checkpoint (never blocks under concurrent readers).
    try {
      db.pragma(`wal_checkpoint(PASSIVE)`, { simple: true });
    } catch (err) {
      _LOG.debug(`WAL checkpoint failed (non-fatal): ${String(err)}`);
    }
  } catch (err) {
    // WAL coordination unavailable (sandbox). Fall back to a read-only open.
    // better-sqlite3's `{ readonly: true }` opens the DB file directly without
    // requiring WAL/SHM coordination — the native equivalent of Python's
    // immutable=1 URI mode (better-sqlite3 does not support URI query params).
    _LOG.info(
      `WAL coordination unavailable for ${path.basename(dbPath)}: ${String(err)} — opening read-only`,
    );
    _closeConn(db);
    db = new Database(dbPath, { readonly: true, timeout: 10000, fileMustExist: false });
    try {
      _applyConnectionPragmas(db, { suppress: true });
      // Validate the fallback open with a real read (SQLite is otherwise lazy).
      db.prepare("SELECT 1 FROM sqlite_master LIMIT 1").get();
    } catch (err2) {
      _closeConn(db);
      throw err2;
    }
  }
  if (loadVec) {
    const ok = _tryLoadVecExtension(db);
    if (!ok) {
      _LOG.warning("sqlite-vec unavailable — embeddings disabled for this connection");
    }
  }
  _LOG.debug(`connection opened: ${path.basename(dbPath)}`);
  return db;
}

// Note: better-sqlite3 opens DBs by plain filesystem path (no URI query params).
// An earlier revision used a file:// URI with ?mode=ro for read-only opens, but
// better-sqlite3 rejects URI-form paths ("unable to open database file") — its
// native API exposes `readonly` / `fileMustExist` flags instead. There is
// therefore no pathToFileUri helper here.

// ===========================================================================
// Corruption detection + auto-rebuild
// ===========================================================================

/**
 * Check if a SqliteError-like error is transient (locked / busy / I/O) — not
 * evidence of corruption. Inspects both the error code and message.
 */
function _isTransientDbError(err: unknown): boolean {
  const msg = _errorMessage(err).toLowerCase();
  const code = _errorCode(err);
  return (
    msg.includes("locked") ||
    msg.includes("busy") ||
    msg.includes("i/o") ||
    code === "SQLITE_BUSY" ||
    code === "SQLITE_IOERR"
  );
}

/**
 * Return true when `err` is a read-only sandbox or transient lock/busy condition.
 *
 * touch_project_last_seen and record_stat treat these identically: log at DEBUG
 * and silently drop the write, because telemetry is best-effort and sandbox
 * environments are expected to be read-only.
 */
function _isReadonlyOrTransient(err: unknown): boolean {
  const msg = _errorMessage(err).toLowerCase();
  const code = _errorCode(err);
  return (
    msg.includes("locked") ||
    msg.includes("busy") ||
    msg.includes("i/o") ||
    msg.includes("readonly") ||
    code === "SQLITE_BUSY" ||
    code === "SQLITE_READONLY" ||
    code === "SQLITE_IOERR"
  );
}

function _errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

function _errorCode(err: unknown): string | undefined {
  if (err !== null && typeof err === "object" && "code" in err) {
    const c = (err as { code?: unknown }).code;
    return typeof c === "string" ? c : undefined;
  }
  return undefined;
}

/**
 * Execute `fn` as a best-effort DB write, swallowing expected sandbox errors.
 *
 * On read-only (sandboxed) connections an error whose message/code says
 * "readonly", "locked", "busy", or "I/O" is downgraded to DEBUG and silently
 * dropped — telemetry writes are best-effort. Any other error is logged at
 * ERROR so real failures surface.
 */
function _bestEffortWrite(fn: () => void, label: string): void {
  try {
    fn();
  } catch (err) {
    if (_isReadonlyOrTransient(err)) {
      _LOG.debug(`${label} skipped (read-only or transient): ${_errorMessage(err)}`);
    } else {
      _LOG.error(`${label} failed: ${_errorMessage(err)}`);
    }
  }
}

/**
 * Return true if the DB is verifiably healthy.
 *
 * An exception or "busy/locked" result is NOT evidence of corruption — only
 * an explicit non-"ok" result from PRAGMA integrity_check counts. We return
 * true (healthy) even when the PRAGMA raises: if we cannot run the check, we
 * have no evidence of corruption, only evidence of a transient or access
 * problem. Quarantining on uncertainty destroys data.
 */
function _integrityOk(db: DatabaseType): boolean {
  let row: unknown;
  try {
    row = db.pragma(`integrity_check`, { simple: true });
  } catch (err) {
    if (_isTransientDbError(err)) return true;
    _LOG.warning(`integrity_check raised (treating as healthy): ${_errorMessage(err)}`);
    return true;
  }
  if (row === undefined || row === null) return true;
  // integrity_check returns either "ok" (a single-row string) or a list of
  // error strings. better-sqlite3 simple:true returns the first row.
  return String(row) === "ok";
}

/**
 * Try to quarantine a corrupt file. Returns true on success.
 *
 * Never throws. If the file is in use by another process (Windows file lock),
 * logs and returns false so callers can continue with the existing connection
 * rather than destroying user data.
 */
function _rebuild(dbPath: string): boolean {
  if (!fs.existsSync(dbPath)) return false;
  const ts = Math.floor(Date.now() / 1000);
  const bad = `${dbPath}.bad-${ts}`;
  try {
    fs.renameSync(dbPath, bad);
    _LOG.error(`quarantined corrupt db: ${dbPath} -> ${bad}`);
    // Invalidate per-path caches so the rebuilt DB gets fresh checks.
    _INTEGRITY_CHECKED.delete(dbPath);
    _SCHEMA_MIGRATED.delete(dbPath);
    return true;
  } catch (err) {
    _LOG.error(
      `failed to quarantine ${dbPath}: ${_errorMessage(err)} (continuing with existing DB)`,
    );
    return false;
  }
}

// ===========================================================================
// Timeout wrapper for hook-context DB writes
// ===========================================================================

/**
 * Execute a callable with a short DB busy_timeout, swallowing transient lock
 * errors. On systems with long-lived writer locks, a single hook write can
 * block for >10s; this wrapper opens a connection with a 2s timeout so hooks
 * fail fast instead of stalling the harness.
 *
 * The Python original monkeypatches busy_timeout on a fresh connection. The
 * better-sqlite3 port opens the global DB with a short timeout directly.
 *
 * @param fn        Callback that takes a Database and performs the op.
 * @param timeoutS  Timeout in seconds (default 2.0).
 */
export function withTimeout(
  fn: (db: DatabaseType) => void,
  timeoutS: number = 2.0,
): void {
  const timeoutMs = Math.floor(timeoutS * 1000);
  try {
    Paths.ensureDir(path.dirname(Paths.globalDbPath()));
    let db: DatabaseType | undefined;
    try {
      db = new Database(Paths.globalDbPath(), { timeout: timeoutS });
      db.pragma(`busy_timeout = ${timeoutMs}`);
      fn(db);
    } finally {
      if (db !== undefined) db.close();
    }
  } catch (err) {
    if (_isReadonlyOrTransient(err)) {
      _LOG.debug(`withTimeout write skipped (transient): ${_errorMessage(err)}`);
    } else {
      _LOG.warning(`withTimeout write failed: ${_errorMessage(err)}`);
    }
  }
}

// ===========================================================================
// Schema helpers
// ===========================================================================

/** Return the value for `key` from the meta table, or undefined if absent. */
function _getMeta(db: DatabaseType, key: string): string | undefined {
  const row = db.prepare("SELECT value FROM meta WHERE key = ?").get(key) as
    | { value?: string }
    | undefined;
  return row?.value;
}

/**
 * Create or verify the global-DB tables and stamp the schema version.
 *
 * Safe to call on read-only connections (sandbox mode): DDL is skipped
 * silently because the schema was already created by a prior writable open.
 */
function _ensureGlobalSchema(db: DatabaseType): void {
  try {
    db.exec(_GLOBAL_TABLES);
    if (_getMeta(db, "schema_version") === undefined) {
      db.prepare(
        "INSERT INTO meta (key, value) VALUES ('schema_version', ?)",
      ).run(String(SCHEMA_VERSION));
    }
    const dbPath = Paths.globalDbPath();
    if (!_STATS_EPOCH_MIGRATED.has(dbPath)) {
      const cols = _tableColumns(db, "stats");
      if (!cols.has("last_access_epoch")) {
        _LOG.info("schema migration: adding last_access_epoch column to global stats table");
        db.exec("ALTER TABLE stats ADD COLUMN last_access_epoch REAL");
      }
      _STATS_EPOCH_MIGRATED.add(dbPath);
    }
  } catch (err) {
    if (_isReadonlyOrTransient(err)) {
      _LOG.debug(
        `global schema ensure skipped (read-only connection): ${_errorMessage(err)}`,
      );
      return;
    }
    throw err;
  }
}

/**
 * Create or verify the per-project tables including the sqlite-vec embeddings
 * table. If sqlite-vec is unavailable the embeddings table creation is skipped
 * and an `embeddings_disabled` flag is written to the meta table so callers
 * can degrade gracefully. Safe to call on read-only connections.
 */
function _ensureProjectSchema(
  db: DatabaseType,
  opts: { dbPath?: string | undefined } = {},
): void {
  const { dbPath } = opts;
  try {
    db.exec(_PROJECT_TABLES);
    // Check for the line_count migration at most once per path per process.
    if (dbPath === undefined || !_SCHEMA_MIGRATED.has(dbPath)) {
      const fileCols = _tableColumns(db, "files");
      if (!fileCols.has("line_count")) {
        _LOG.info(
          `schema migration: adding line_count column to files table${
            dbPath ? ` (${path.basename(dbPath)})` : ""
          }`,
        );
        db.exec("ALTER TABLE files ADD COLUMN line_count INTEGER");
      }
      if (dbPath === undefined || !_STATS_EPOCH_MIGRATED.has(dbPath)) {
        const statsCols = _tableColumns(db, "stats");
        if (!statsCols.has("last_access_epoch")) {
          _LOG.info(
            `schema migration: adding last_access_epoch column to stats table${
              dbPath ? ` (${path.basename(dbPath)})` : ""
            }`,
          );
          db.exec("ALTER TABLE stats ADD COLUMN last_access_epoch REAL");
        }
        if (dbPath !== undefined) {
          _STATS_EPOCH_MIGRATED.add(dbPath);
        }
      }
      if (dbPath !== undefined) {
        _SCHEMA_MIGRATED.set(dbPath, true);
      }
    }
    // INSERT OR REPLACE so the version row is always current after a schema
    // upgrade (per-project DBs use OR REPLACE; global uses plain INSERT).
    const existingVer = _getMeta(db, "schema_version");
    if (existingVer !== undefined && existingVer !== String(SCHEMA_VERSION)) {
      _LOG.info(`schema upgrade: ${existingVer} -> ${SCHEMA_VERSION}`);
    }
    db.prepare(
      "INSERT OR REPLACE INTO meta (key, value) VALUES ('schema_version', ?)",
    ).run(String(SCHEMA_VERSION));
  } catch (err) {
    if (_isReadonlyOrTransient(err)) {
      _LOG.debug(
        `project schema ensure skipped (read-only connection): ${_errorMessage(err)}`,
      );
      return;
    }
    throw err;
  }
  // Try to create the sqlite-vec virtual table.
  try {
    db.exec(_EMBEDDINGS_DDL);
  } catch (err) {
    _LOG.warning(`embeddings table unavailable: ${_errorMessage(err)}`);
    try {
      db.prepare(
        "INSERT OR IGNORE INTO meta (key, value) VALUES ('embeddings_disabled', '1')",
      ).run();
    } catch {
      // meta table may not exist on read-only fallback — swallow.
    }
  }
}

/** Return the set of column names for `table` via PRAGMA table_info. */
function _tableColumns(db: DatabaseType, table: string): Set<string> {
  const rows = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{
    name: string;
  }>;
  return new Set(rows.map((r) => r.name));
}

// ===========================================================================
// Open with retry + rebuild
// ===========================================================================

/**
 * Attempt _openWithRebuild() with exponential backoff on transient locks.
 *
 * Only errors whose message/code say "locked" or "busy" are retried — genuine
 * corruption errors propagate immediately so the caller's quarantine-and-
 * rebuild logic still fires.
 */
function _openWithRetry(
  dbPath: string,
  opts: {
    loadVec?: boolean | undefined;
    maxAttempts?: number | undefined;
    baseDelay?: number | undefined;
  } = {},
): DatabaseType {
  const loadVec = opts.loadVec ?? true;
  const maxAttempts = opts.maxAttempts ?? 3;
  const baseDelay = opts.baseDelay ?? 0.1;
  let lastErr: unknown;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      return _openWithRebuild(dbPath, { loadVec });
    } catch (err) {
      const msg = _errorMessage(err).toLowerCase();
      if (!msg.includes("locked") && !msg.includes("busy")) throw err;
      lastErr = err;
      const delay = baseDelay * Math.pow(2, attempt);
      _LOG.warning(
        `db locked (${_errorMessage(err)}), retrying in ${delay.toFixed(2)}s (attempt ${attempt + 1}/${maxAttempts})`,
      );
      _sleepSync(delay);
    }
  }
  throw lastErr;
}

/**
 * Try _connect(); on a database error, quarantine and retry once.
 *
 * Re-throws DBCorruptionError if the second attempt also fails so callers get
 * a clear exception rather than a silent crash later.
 */
function _openWithRebuild(
  dbPath: string,
  opts: { loadVec?: boolean | undefined } = {},
): DatabaseType {
  const loadVec = opts.loadVec ?? true;
  try {
    return _connect(dbPath, { loadVec });
  } catch (err) {
    // Only treat genuine DatabaseError-class errors as corruption triggers.
    // (better-sqlite3 throws SqliteError with codes like SQLITE_CORRUPT,
    // SQLITE_NOTADB, etc. Transient lock/busy errors are handled by the
    // retry layer above.)
    if (!_isDatabaseError(err)) throw err;
    _LOG.warning(
      `db open failed: ${_errorMessage(err)} — attempting quarantine and rebuild`,
    );
    _rebuild(dbPath);
    _LOG.info(`retrying db open after quarantine: ${path.basename(dbPath)}`);
    try {
      return _connect(dbPath, { loadVec });
    } catch (err2) {
      _LOG.error(`db open failed after quarantine attempt: ${_errorMessage(err2)}`);
      throw new DBCorruptionError(`DB unrecoverable after quarantine: ${path.basename(dbPath)}`);
    }
  }
}

/**
 * Does `err` represent a genuine SQLite database integrity error (as opposed
 * to a transient lock/busy or a JS-level error)? Used to decide whether to
 * trigger quarantine + rebuild.
 */
function _isDatabaseError(err: unknown): boolean {
  const code = _errorCode(err);
  if (code === undefined) return false;
  return [
    "SQLITE_CORRUPT",
    "SQLITE_NOTADB",
    "SQLITE_FORMAT",
    "SQLITE_IOERR_SHORT_READ",
    "SQLITE_INTERNAL",
  ].includes(code);
}

/**
 * Run an integrity check; if it fails, quarantine `dbPath` and open a fresh
 * connection. Only runs once per path per process (results cached). Returns
 * the original `db` when the check passes or is already cached; returns a new
 * connection when the file was quarantined. The old connection is closed
 * before quarantine so Windows file locks don't block the rename.
 */
function _repairIfCorrupt(db: DatabaseType, dbPath: string): DatabaseType {
  if (_INTEGRITY_CHECKED.has(dbPath)) return db;
  if (_integrityOk(db)) {
    _INTEGRITY_CHECKED.set(dbPath, true);
    return db;
  }
  _LOG.error(`db integrity check failed, quarantining ${dbPath}`);
  try {
    db.close();
  } catch {
    // swallow
  }
  _rebuild(dbPath);
  const newDb = _openWithRebuild(dbPath);
  _INTEGRITY_CHECKED.set(dbPath, true);
  return newDb;
}

// ===========================================================================
// Public context managers (higher-order functions; sync)
// ===========================================================================
//
// Python's `with open_global() as conn:` becomes `openGlobal((conn) => { ... })`.
// The callback form preserves the exact contract: the connection is closed in
// a finally, even when the body throws. Callers that need to return a value
// from the body return it from the callback; the wrapper returns it from the
// outer call.
//
// On-close checkpoint: a best-effort PASSIVE wal_checkpoint runs before close
// for writable openers (openGlobal/openProject), matching the Python
// _log_session_close(checkpoint=True). Read-only openers skip it (checkpoint
// on a read-only connection is a no-op and can raise).

function _logSessionClose(
  label: string,
  t0Ms: number,
  db: DatabaseType | undefined,
  opts: { checkpoint?: boolean } = {},
): void {
  const sessionMs = (performanceNow() - t0Ms) * 1000;
  if (sessionMs >= 1000) {
    _LOG.debug(`${label} session slow: ${sessionMs.toFixed(1)}ms total`);
  } else {
    _LOG.debug(`closing ${label} (session ${sessionMs.toFixed(1)}ms)`);
  }
  if (opts.checkpoint && db !== undefined) {
    try {
      db.pragma(`wal_checkpoint(PASSIVE)`, { simple: true });
    } catch {
      // swallowed — a failed checkpoint is not fatal.
    }
  }
  _closeConn(db);
}

/** performance.now()-like monotonic clock in milliseconds. */
function performanceNow(): number {
  return performance.now() / 1000;
}

/** Synchronous sleep (only used for retry backoff, never on the hot path). */
function _sleepSync(seconds: number): void {
  // Atomics.wait cannot be interrupted but is truly synchronous. We bound it
  // to the (sub-second) backoff window only. fs.readFileSync on /dev/null is
  // an alternative sync delay but Atomics is the cleanest sync sleep in Node.
  const ms = Math.max(0, Math.floor(seconds * 1000));
  if (ms <= 0) return;
  try {
    const buf = new Int32Array(new SharedArrayBuffer(4));
    Atomics.wait(buf, 0, 0, ms);
  } catch {
    // SharedArrayBuffer may be disabled in some sandboxes; fall back to a
    // busy wait bounded by Date.now. Only reached on retry backoff paths.
    const end = Date.now() + ms;
    while (Date.now() < end) {
      // spin
    }
  }
}

/**
 * Yield a connection to global.db with schema applied.
 *
 * @param body Callback receiving the open connection. Its return value is
 *             returned from openGlobal. Thrown errors propagate after the
 *             connection is closed in the finally.
 */
export function openGlobal<T>(body: (db: DatabaseType) => T): T {
  const dbPath = Paths.globalDbPath();
  const t0 = performanceNow();
  _LOG.debug(`opening global db: ${dbPath}`);
  let db = _openWithRetry(dbPath);
  let repaired: DatabaseType | undefined;
  try {
    db = _repairIfCorrupt(db, dbPath);
    repaired = db;
    _ensureGlobalSchema(db);
    _LOG.debug(`global db ready in ${((performanceNow() - t0) * 1000).toFixed(1)}ms`);
    return body(db);
  } finally {
    // If repair replaced the connection, `db` is the fresh one (the original
    // was closed inside _repairIfCorrupt). Close whichever we ended with.
    _logSessionClose("global db", t0, repaired ?? db, { checkpoint: true });
  }
}

/**
 * Yield a connection to a per-project DB with schema applied.
 *
 * @param projectHash Lowercase-hex SHA-1 digest identifying the project.
 * @param body        Callback receiving the open connection.
 */
export function openProject<T>(
  projectHash: string,
  body: (db: DatabaseType) => T,
): T {
  _validateProjectHash(projectHash);
  const dbPath = Paths.projectDbPath(projectHash);
  const t0 = performanceNow();
  _LOG.debug(`opening project db: ${dbPath} (hash=${projectHash})`);
  let db = _openWithRetry(dbPath);
  let repaired: DatabaseType | undefined;
  try {
    db = _repairIfCorrupt(db, dbPath);
    repaired = db;
    _ensureProjectSchema(db, { dbPath });
    _LOG.debug(
      `project db ready in ${((performanceNow() - t0) * 1000).toFixed(1)}ms (hash=${projectHash.slice(0, 8)})`,
    );
    return body(db);
  } finally {
    _logSessionClose(`project db ${projectHash.slice(0, 8)}`, t0, repaired ?? db, {
      checkpoint: true,
    });
  }
}

// ===========================================================================
// Read-only openers (skip integrity_check + DDL)
// ===========================================================================

/**
 * Open a read-only SQLite connection via URI mode. No WAL, no vec, no DDL.
 *
 * Falls back to immutable=1 when the WAL shared-memory file is inaccessible.
 * A real read (SELECT FROM sqlite_master) forces SQLite to actually open the
 * file so a lazy-open failure surfaces here for the fallback to handle.
 *
 * @throws DBBusyError when both the WAL and immutable opens fail.
 */
function _connectReadonly(dbPath: string): DatabaseType {
  // better-sqlite3 does NOT support Python's `sqlite3.connect(uri=True)` with
  // `?mode=ro&immutable=1` query params — it rejects URI-form paths with
  // "unable to open database file" because the query string is not stripped.
  // The native API instead exposes dedicated `readonly` and `fileMustExist`
  // options on the Database constructor. We open the plain filesystem path
  // with `{ readonly: true }`; better-sqlite3 then opens the DB read-only
  // without requiring WAL/SHM coordination (the readonly path reads the file
  // directly when WAL sidecars are absent or inaccessible). A real read
  // (SELECT FROM sqlite_master) forces SQLite to actually open the file so a
  // lazy-open failure surfaces here for the fallback to handle.
  let db: DatabaseType | undefined;
  try {
    db = new Database(dbPath, { readonly: true, timeout: 10000, fileMustExist: false });
    _applyConnectionPragmas(db);
    db.prepare("SELECT 1 FROM sqlite_master LIMIT 1").get();
    return db;
  } catch (err) {
    _LOG.info(
      `read-only open failed for ${path.basename(dbPath)} (${_errorMessage(err)}) — retrying with suppressed PRAGMAs`,
    );
    _closeConn(db);
    db = undefined;
    // Fallback: reopen with PRAGMAs suppressed (the readonly path on a sandbox
    // may reject some PRAGMAs). This mirrors the Python immutable-fallback
    // branch's intent — keep serving reads when the primary open is rejected.
    try {
      db = new Database(dbPath, { readonly: true, timeout: 10000, fileMustExist: false });
      _applyConnectionPragmas(db, { suppress: true });
      db.prepare("SELECT 1 FROM sqlite_master LIMIT 1").get();
      return db;
    } catch (err2) {
      _closeConn(db);
      throw new DBBusyError(
        `read-only connection failed for ${path.basename(dbPath)}: ${_errorMessage(err2)}`,
      );
    }
  }
}

/**
 * Read-only connection to global.db, skipping integrity_check and schema DDL.
 *
 * Intended for stats reads where performance matters more than migrations.
 *
 * @throws DBBusyError when the connection cannot be opened.
 */
export function openGlobalReadonly<T>(body: (db: DatabaseType) => T): T {
  const dbPath = Paths.globalDbPath();
  if (!fs.existsSync(dbPath)) {
    throw new Error(`global.db not found: ${dbPath}`);
  }
  const db = _connectReadonly(dbPath);
  try {
    return body(db);
  } finally {
    _closeConn(db);
  }
}

/**
 * Read-only connection to a per-project DB, skipping integrity_check and DDL.
 *
 * @throws DBBusyError when the connection cannot be opened.
 */
export function openProjectReadonly<T>(
  projectHash: string,
  body: (db: DatabaseType) => T,
): T {
  _validateProjectHash(projectHash);
  const dbPath = Paths.projectDbPath(projectHash);
  if (!fs.existsSync(dbPath)) {
    throw new Error(`project db not found: ${dbPath}`);
  }
  const db = _connectReadonly(dbPath);
  try {
    return body(db);
  } finally {
    _closeConn(db);
  }
}

// ===========================================================================
// Writer lockfile
// ===========================================================================

/**
 * Check if a process with the given PID is still alive.
 *
 * Node has no psutil; process.kill(pid, 0) is the POSIX analogue (signal 0 =
 * existence check). EPERM on Windows maps to "alive" (same as the Python
 * PermissionError branch — we lack ACL permission to signal it, but it
 * exists); ESRCH maps to "dead". Any other error assumes dead to avoid false
 * positives.
 */
export function _pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    const code = _errorCode(err);
    if (code === "EPERM") {
      // Windows: EPERM means the process exists but we lack permission.
      return true;
    }
    if (code === "ESRCH") {
      return false;
    }
    // Other OSError-class errors: assume dead to avoid false positives.
    return false;
  }
}

/**
 * File-based writer lock for a project DB.
 *
 * Writes `<locks_dir>/<hash>.lock` containing `<pid>\n<timestamp>\n<platform>`.
 * Stale locks (>10 min old, or owning PID not alive) are auto-cleared.
 * Cross-platform locks (written on a different OS) are stale after 60s.
 *
 * @param projectHash Lowercase-hex SHA-1 digest.
 * @param body        Callback executed while the lock is held.
 * @param timeoutSec  Max seconds to wait for the lock (default 5.0).
 * @throws {Error} TimeoutError analogue if the lock cannot be acquired.
 */
export function projectWriterLock<T>(
  projectHash: string,
  body: () => T,
  opts: { timeoutSec?: number | undefined } = {},
): T {
  _validateProjectHash(projectHash);
  const timeoutSec = opts.timeoutSec ?? 5.0;
  const lockPath = path.join(Paths.locksDir(), `${projectHash}.lock`);
  Paths.ensureDir(path.dirname(lockPath));
  const deadlineMs = performanceNow() * 1000 + timeoutSec * 1000;
  const pid = process.pid;
  const currentPlatform = process.platform;

  const isStale = (lockText: string): boolean => {
    const trimmed = lockText.trim();
    if (trimmed === "") {
      // Empty/malformed content is the microsecond window between O_EXCL create
      // and the owner's write — NOT treated as stale. Fall back to mtime.
      try {
        const st = fs.statSync(lockPath);
        const age = (Date.now() / 1000) - (st.mtimeMs / 1000);
        return age > LOCK_STALE_SECONDS;
      } catch {
        return false;
      }
    }
    const lines = trimmed.split("\n");
    const ownerPidStr = lines[0];
    const ownerTsStr = lines[1];
    const ownerPlatform = lines.length > 2 ? lines[2] : null;
    if (ownerPidStr === undefined || ownerTsStr === undefined) {
      try {
        const st = fs.statSync(lockPath);
        const age = (Date.now() / 1000) - (st.mtimeMs / 1000);
        return age > LOCK_STALE_SECONDS;
      } catch {
        return false;
      }
    }
    const ownerPid = parseInt(ownerPidStr, 10);
    const ownerTs = parseFloat(ownerTsStr);
    if (!Number.isFinite(ownerTs)) {
      try {
        const st = fs.statSync(lockPath);
        const age = (Date.now() / 1000) - (st.mtimeMs / 1000);
        return age > LOCK_STALE_SECONDS;
      } catch {
        return false;
      }
    }
    const nowSec = Date.now() / 1000;
    if (nowSec - ownerTs > LOCK_STALE_SECONDS) return true;
    if (ownerPlatform !== null && ownerPlatform !== "" && ownerPlatform !== String(currentPlatform)) {
      return nowSec - ownerTs > LOCK_CROSS_PLATFORM_STALE_SECONDS;
    }
    return !_pidAlive(ownerPid);
  };

  const tryAcquire = (): boolean => {
    for (let attempt = 1; attempt <= 2; attempt++) {
      let fd: number | undefined;
      try {
        // "wx" = O_CREAT | O_EXCL | O_WRONLY. Creation is the mutex.
        fd = fs.openSync(lockPath, "wx", 0o600);
      } catch (err) {
        const code = _errorCode(err);
        if (code === "EEXIST") {
          let text = "";
          try {
            text = fs.readFileSync(lockPath, "utf8");
          } catch (err2) {
            _LOG.debug(`lock read failed for ${path.basename(lockPath)}: ${_errorMessage(err2)}`);
            return false;
          }
          if (!isStale(text)) return false;
          if (attempt === 2) return false; // cleared a stale lock once; let caller re-loop
          _LOG.info(
            `clearing stale writer lock for project ${projectHash.slice(0, 8)} (lock content: ${text.trim().slice(0, 60)})`,
          );
          try {
            fs.unlinkSync(lockPath);
          } catch (err2) {
            const c = _errorCode(err2);
            if (c !== "ENOENT") {
              _LOG.debug(`lock unlink failed: ${_errorMessage(err2)}`);
              return false;
            }
          }
          continue; // retry the atomic create once
        }
        _LOG.debug(`lock create failed for ${path.basename(lockPath)}: ${_errorMessage(err)}`);
        return false;
      }
      // We hold the lock — record owner pid + timestamp + platform, then close.
      try {
        const nowSec = Date.now() / 1000;
        fs.writeFileSync(fd, `${pid}\n${nowSec}\n${currentPlatform}`, "utf8");
      } finally {
        fs.closeSync(fd);
      }
      return true;
    }
    return false;
  };

  let acquired = false;
  const t0 = performanceNow();
  let waited = false;
  let holderPid: number | undefined;
  let retries = 0;
  while (true) {
    if (tryAcquire()) {
      acquired = true;
      break;
    }
    waited = true;
    retries++;
    if (holderPid === undefined) {
      try {
        const lockText = fs.readFileSync(lockPath, "utf8");
        const parts = lockText.trim().split("\n", 2);
        const parsed = parseInt(parts[0] ?? "", 10);
        holderPid = Number.isFinite(parsed) ? parsed : -1;
      } catch {
        holderPid = -1;
      }
    }
    if (performanceNow() * 1000 >= deadlineMs) break;
    _sleepSync(0.1);
  }

  if (!acquired) {
    throw new Error(
      `could not acquire writer lock for project ${projectHash.slice(0, 8)} within ${timeoutSec}s (held by pid=${holderPid})`,
    );
  }
  const elapsed = performanceNow() - t0;
  if (waited) {
    _LOG.info(
      `writer lock acquired for project ${projectHash.slice(0, 8)} after ${elapsed.toFixed(3)}s (retries=${retries}, held by pid=${holderPid})`,
    );
  } else {
    _LOG.debug(`writer lock acquired for project ${projectHash.slice(0, 8)} (no contention)`);
  }
  try {
    return body();
  } finally {
    try {
      fs.unlinkSync(lockPath);
    } catch (err) {
      const code = _errorCode(err);
      if (code !== "ENOENT") {
        _LOG.debug(`lock unlink on release failed: ${_errorMessage(err)}`);
      }
    }
    _LOG.debug(`writer lock released for project ${projectHash.slice(0, 8)}`);
  }
}

// ===========================================================================
// Stats helpers
// ===========================================================================

const _MAX_STAT_KIND_LEN = 64;
const _MAX_STAT_DETAIL_LEN = 512;
const _MISS_NEEDLE_MAX = 512;
const _MISS_FILE_HINT_MAX = 512;

/** Amortization threshold for grep pattern writes (24 hours). */
const _GREP_PATTERN_WRITE_STALE_SECS = 24 * 3600;

/**
 * How many files are indexed for this project. 0 means never indexed.
 *
 * Returns 0 (not an error) if the project DB does not exist yet or any DB
 * error occurs — callers cannot distinguish "never indexed" from "error", so
 * failures are logged at WARNING to avoid silent unnecessary reindexes.
 */
export function fileCount(projectHash: string): number {
  try {
    return openProject(projectHash, (db) => {
      const row = db.prepare("SELECT COUNT(*) AS n FROM files").get() as
        | { n: number }
        | undefined;
      return row ? Number(row.n) : 0;
    });
  } catch (err) {
    if (_isNotFoundError(err)) return 0;
    _LOG.warning(`fileCount(${projectHash.slice(0, 8)}…) failed, returning 0: ${_errorMessage(err)}`);
    return 0;
  }
}

/** Alias mirroring the Python snake_case name. */
export const file_count = fileCount;

/** Return true when the project DB already contains at least one file row. */
export function projectHasFiles(projectHash: string): boolean {
  try {
    return openProjectReadonly(projectHash, (db) => {
      const row = db.prepare("SELECT 1 FROM files LIMIT 1").get();
      return row !== undefined;
    });
  } catch (err) {
    if (_isNotFoundError(err)) return false;
    _LOG.debug(`projectHasFiles(${projectHash.slice(0, 8)}…) failed: ${_errorMessage(err)}`);
    return false;
  }
}

/** Alias mirroring the Python snake_case name. */
export const project_has_files = projectHasFiles;

/**
 * Return the Unix timestamp of the most-recently-indexed file in the project.
 *
 * Returns 0.0 when the project has no indexed files, the DB does not exist, or
 * any error occurs (fail-soft — callers treat 0.0 as "never indexed").
 */
export function projectLastIndexedTs(projectHash: string): number {
  try {
    return openProjectReadonly(projectHash, (db) => {
      const row = db.prepare("SELECT MAX(indexed_at) AS m FROM files").get() as
        | { m: number | null }
        | undefined;
      if (row === undefined || row.m === null || row.m === undefined) return 0.0;
      return Number(row.m);
    });
  } catch (err) {
    if (_isNotFoundError(err)) return 0.0;
    _LOG.debug(`projectLastIndexedTs(${projectHash.slice(0, 8)}…) failed: ${_errorMessage(err)}`);
    return 0.0;
  }
}

/** Alias mirroring the Python snake_case name. */
export const project_last_indexed_ts = projectLastIndexedTs;

/**
 * Return the hash of every project registered in the global DB.
 *
 * Returns an empty list when the global DB does not exist or is unreadable —
 * callers must gracefully handle the empty case.
 */
export function listAllProjectHashes(): string[] {
  try {
    return openGlobalReadonly((db) => {
      const rows = db.prepare("SELECT hash FROM projects").all() as Array<{
        hash: string;
      }>;
      return rows.map((r) => r.hash);
    });
  } catch (err) {
    if (_isNotFoundError(err)) return [];
    _LOG.debug(`listAllProjectHashes: global DB unavailable: ${_errorMessage(err)}`);
    return [];
  }
}

/** Alias mirroring the Python snake_case name. */
export const list_all_project_hashes = listAllProjectHashes;

/**
 * Bump a project's last_seen to mark recent user activity. Best-effort.
 *
 * No-op if the project is not yet registered — the first indexProject call
 * registers it.
 */
export function touchProjectLastSeen(projectHash: string): void {
  const do_ = (): void => {
    openGlobal((db) => {
      db.prepare("UPDATE projects SET last_seen = ? WHERE hash = ?").run(
        Math.floor(Date.now() / 1000),
        projectHash,
      );
    });
  };
  _bestEffortWrite(do_, "touch_project_last_seen");
}

/** Alias mirroring the Python snake_case name. */
export const touch_project_last_seen = touchProjectLastSeen;

/** Return true when `err` is a "file not found" / ENOENT-style error. */
function _isNotFoundError(err: unknown): boolean {
  const code = _errorCode(err);
  if (code === "ENOENT") return true;
  return _errorMessage(err).includes("not found");
}

/**
 * Return health and statistics for a project DB.
 *
 * Keys: ok, integrity_ok, file_count, symbol_count, ref_count,
 * section_count, chunk_count, embedding_count, db_size_bytes,
 * schema_version, embeddings_disabled.
 */
export function indexHealth(projectHash: string): Record<string, unknown> {
  const dbPath = Paths.projectDbPath(projectHash);
  const result: Record<string, unknown> = {
    ok: false,
    integrity_ok: false,
    file_count: 0,
    symbol_count: 0,
    ref_count: 0,
    section_count: 0,
    chunk_count: 0,
    embedding_count: 0,
    db_size_bytes: 0,
    schema_version: null,
    embeddings_disabled: false,
  };
  if (!fs.existsSync(dbPath)) return result;
  try {
    result.db_size_bytes = fs.statSync(dbPath).size;
  } catch {
    // best-effort size
  }
  try {
    openProject(projectHash, (db) => {
      const integrityRow = db.pragma(`integrity_check`, { simple: true });
      result.integrity_ok = integrityRow !== undefined && String(integrityRow) === "ok";

      const count = (table: string): number => {
        if (!_KNOWN_PROJECT_TABLES.has(table)) {
          throw new Error(`_count: unknown table name '${table}'`);
        }
        const row = db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as
          | { n: number }
          | undefined;
        return row ? Number(row.n) : 0;
      };

      result.file_count = count("files");
      result.symbol_count = count("symbols");
      result.ref_count = count("refs");
      result.section_count = count("sections");
      result.chunk_count = count("chunks");
      try {
        result.embedding_count = count("embeddings");
      } catch {
        // embeddings table may not exist (sqlite-vec unavailable) — leave 0.
      }
      result.schema_version = _getMeta(db, "schema_version") ?? null;
      result.embeddings_disabled = _getMeta(db, "embeddings_disabled") !== undefined;
      result.ok = true;
    });
  } catch (err) {
    _LOG.warning(`indexHealth failed for ${projectHash.slice(0, 8)}: ${_errorMessage(err)}`);
  }
  return result;
}

/**
 * Upsert a grep pattern row in global.db::grep_patterns, amortized.
 *
 * Only writes when the pattern is new OR the stored last_ts is more than 24h
 * old. Best-effort: any DB error is swallowed.
 */
export function updateGlobalGrepPattern(
  patternHash: string,
  patternText: string,
  now: number,
): void {
  const do_ = (): void => {
    openGlobal((db) => {
      const row = db
        .prepare("SELECT last_ts FROM grep_patterns WHERE pattern_hash = ?")
        .get(patternHash) as { last_ts?: number } | undefined;
      if (row !== undefined) {
        const age = now - Number(row.last_ts);
        if (age < _GREP_PATTERN_WRITE_STALE_SECS) return; // recent enough — skip
      }
      db.prepare(
        `INSERT INTO grep_patterns (pattern_hash, first_pattern, last_ts, count)
         VALUES (?, ?, ?, 1)
         ON CONFLICT(pattern_hash) DO UPDATE SET
             last_ts = excluded.last_ts,
             count   = grep_patterns.count + 1`,
      ).run(patternHash, patternText, now);
    });
  };
  _bestEffortWrite(do_, "update_global_grep_pattern");
}

/** Alias mirroring the Python snake_case name. */
export const update_global_grep_pattern = updateGlobalGrepPattern;

/**
 * Append a row to the stats table of the appropriate DB.
 *
 * `kind` is truncated to 64 chars and `detail` to 512 chars; both can
 * originate from external hook payloads so bounding prevents unbounded growth.
 */
export function recordStat(
  projectHash: string | undefined,
  kind: string,
  opts: {
    tokensSaved?: number | undefined;
    bytesSaved?: number | undefined;
    detail?: string | undefined;
  } = {},
): void {
  const tokensSaved = opts.tokensSaved ?? 0;
  const bytesSaved = opts.bytesSaved ?? 0;
  let detail = opts.detail;
  const ts = Math.floor(Date.now() / 1000);
  let boundedKind = kind;
  if (boundedKind.length > _MAX_STAT_KIND_LEN) {
    boundedKind = boundedKind.slice(0, _MAX_STAT_KIND_LEN);
  }
  if (detail !== undefined && detail.length > _MAX_STAT_DETAIL_LEN) {
    detail = detail.slice(0, _MAX_STAT_DETAIL_LEN);
  }
  const epochSec = Date.now() / 1000;
  const sql =
    "INSERT INTO stats (ts, kind, tokens_saved, bytes_saved, detail, last_access_epoch) VALUES (?, ?, ?, ?, ?, ?)";
  const params: Array<number | string | null> = [
    ts,
    boundedKind,
    tokensSaved,
    bytesSaved,
    detail ?? null,
    epochSec,
  ];
  const do_ = (): void => {
    if (projectHash !== undefined) {
      openProject(projectHash, (db) => {
        db.prepare(sql).run(...params);
      });
    } else {
      openGlobal((db) => {
        db.prepare(sql).run(...params);
      });
    }
  };
  _bestEffortWrite(do_, "record_stat");
}

/**
 * Increment the miss counter for (needle, fileHint) in the global DB.
 *
 * Uses an upsert so the first call inserts with miss_count=1 and subsequent
 * calls atomically increment. Both strings are truncated to bounded lengths.
 */
export function recordMiss(needle: string, fileHint: string = ""): void {
  const n = needle.slice(0, _MISS_NEEDLE_MAX);
  const fh = fileHint.slice(0, _MISS_FILE_HINT_MAX);
  const now = Date.now() / 1000;
  const do_ = (): void => {
    openGlobal((db) => {
      db.prepare(
        `INSERT INTO miss_patterns (needle, file_hint, miss_count, last_miss_epoch)
         VALUES (?, ?, 1, ?)
         ON CONFLICT(needle, file_hint) DO UPDATE SET
             miss_count = miss_count + 1,
             last_miss_epoch = excluded.last_miss_epoch`,
      ).run(n, fh, now);
    });
  };
  _bestEffortWrite(do_, "record_miss");
}

/** Return the current miss count for (needle, fileHint); 0 if not found. */
export function getMissCount(needle: string, fileHint: string = ""): number {
  const n = needle.slice(0, _MISS_NEEDLE_MAX);
  const fh = fileHint.slice(0, _MISS_FILE_HINT_MAX);
  try {
    return openGlobalReadonly((db) => {
      const row = db
        .prepare(
          "SELECT miss_count FROM miss_patterns WHERE needle = ? AND file_hint = ?",
        )
        .get(n, fh) as { miss_count?: number } | undefined;
      return row ? Number(row.miss_count) : 0;
    });
  } catch {
    return 0;
  }
}

/** Delete the miss-pattern row for (needle, fileHint) on a successful resolve. */
export function resetMiss(needle: string, fileHint: string = ""): void {
  const n = needle.slice(0, _MISS_NEEDLE_MAX);
  const fh = fileHint.slice(0, _MISS_FILE_HINT_MAX);
  const do_ = (): void => {
    openGlobal((db) => {
      db.prepare(
        "DELETE FROM miss_patterns WHERE needle = ? AND file_hint = ?",
      ).run(n, fh);
    });
  };
  _bestEffortWrite(do_, "reset_miss");
}

// ===========================================================================
// Query helpers (symbol callers, refs, imports) — fail-soft, return [] on error
// ===========================================================================

/**
 * Return up to `limit`+1 call-site rows for `symbolName` in the project.
 *
 * Each row is `{ file_rel: string, line: number }`. Returning limit+1 lets the
 * caller detect "and more" without a separate COUNT. Returns [] on any error.
 */
export function getSymbolCallers(
  projectHash: string,
  symbolName: string,
  limit: number = 3,
): Array<{ file_rel: string; line: number }> {
  try {
    return openProjectReadonly(projectHash, (db) => {
      const rows = db
        .prepare(
          "SELECT file_rel, line FROM refs WHERE symbol_name = ? ORDER BY file_rel, line LIMIT ?",
        )
        .all(symbolName, limit + 1) as Array<{ file_rel: string; line: number }>;
      return rows.map((r) => ({ file_rel: r.file_rel, line: Number(r.line) }));
    });
  } catch (err) {
    if (_isNotFoundError(err)) return [];
    return [];
  }
}

/** Alias mirroring the Python snake_case name. */
export const get_symbol_callers = getSymbolCallers;

/**
 * Return call-site rows for `symbolName` defined in `filePath` (partial LIKE).
 *
 * Each row is `{ path: string, line: number, context: string | null }`.
 * Returns [] on any DB error or when the project DB does not exist.
 */
export function getSymbolRefs(
  projectHash: string,
  filePath: string,
  symbolName: string,
  limit: number = 50,
): Array<{ path: string; line: number; context: string | null }> {
  try {
    return openProjectReadonly(projectHash, (db) => {
      const rows = db
        .prepare(
          `SELECT r.file_rel AS path, r.line, r.context
           FROM refs r
           WHERE r.symbol_name = ?
             AND EXISTS (
                 SELECT 1 FROM symbols s
                 WHERE s.name = r.symbol_name
                   AND s.file_rel LIKE ?
             )
           ORDER BY r.file_rel, r.line
           LIMIT ?`,
        )
        .all(symbolName, `%${filePath}%`, limit) as Array<{
        path: string;
        line: number;
        context: string | null;
      }>;
      return rows.map((r) => ({
        path: r.path,
        line: Number(r.line),
        context: r.context,
      }));
    });
  } catch (err) {
    if (_isNotFoundError(err)) return [];
    return [];
  }
}

/** Alias mirroring the Python snake_case name. */
export const get_symbol_refs = getSymbolRefs;

/**
 * Like getSymbolRefs, but each row also includes `caller_name` and
 * `caller_kind` — the innermost enclosing function/method containing the ref.
 */
export function getRefsWithCallers(
  projectHash: string,
  filePath: string,
  symbolName: string,
  limit: number = 50,
): Array<{
  path: string;
  line: number;
  context: string | null;
  caller_name: string | null;
  caller_kind: string | null;
}> {
  const functionKinds = ["function", "async_function", "method", "constructor"];
  const placeholders = functionKinds.map(() => "?").join(",");
  const query = `
    SELECT
        r.file_rel AS path,
        r.line,
        r.context,
        (
            SELECT s.name
            FROM symbols s
            WHERE s.file_rel = r.file_rel
              AND s.kind IN (${placeholders})
              AND s.line <= r.line
              AND (s.end_line IS NULL OR s.end_line >= r.line)
            ORDER BY s.line DESC, s.id DESC
            LIMIT 1
        ) AS caller_name,
        (
            SELECT s.kind
            FROM symbols s
            WHERE s.file_rel = r.file_rel
              AND s.kind IN (${placeholders})
              AND s.line <= r.line
              AND (s.end_line IS NULL OR s.end_line >= r.line)
            ORDER BY s.line DESC, s.id DESC
            LIMIT 1
        ) AS caller_kind
    FROM refs r
    WHERE r.symbol_name = ?
      AND EXISTS (
          SELECT 1 FROM symbols s
          WHERE s.name = r.symbol_name
            AND s.file_rel LIKE ?
      )
    ORDER BY r.file_rel, r.line
    LIMIT ?`;
  const params = [
    ...functionKinds,
    ...functionKinds,
    symbolName,
    `%${filePath}%`,
    limit,
  ];
  try {
    return openProjectReadonly(projectHash, (db) => {
      const rows = db.prepare(query).all(...params) as Array<{
        path: string;
        line: number;
        context: string | null;
        caller_name: string | null;
        caller_kind: string | null;
      }>;
      return rows.map((r) => ({
        path: r.path,
        line: Number(r.line),
        context: r.context,
        caller_name: r.caller_name,
        caller_kind: r.caller_kind,
      }));
    });
  } catch (err) {
    if (_isNotFoundError(err)) return [];
    return [];
  }
}

/** Alias mirroring the Python snake_case name. */
export const get_refs_with_callers = getRefsWithCallers;

/**
 * Return project-internal files that `fileRel` imports from (outgoing, one level).
 *
 * Only relative imports (targets starting with `.`) are considered. Returns []
 * on any DB error or when the project DB does not exist.
 */
export function getFileImports(
  projectHash: string,
  fileRel: string,
): string[] {
  try {
    return openProjectReadonly(projectHash, (db) => {
      const targetRows = db
        .prepare(
          `SELECT DISTINCT target FROM imports_exports
           WHERE file_rel = ? AND kind = 'import' AND target LIKE '.%'
           ORDER BY target`,
        )
        .all(fileRel) as Array<{ target: string }>;
      if (targetRows.length === 0) return [];
      const allFiles = new Set(
        (db.prepare("SELECT rel_path FROM files WHERE rel_path LIKE '%.py'").all() as Array<{
          rel_path: string;
        }>).map((r) => r.rel_path),
      );
      const resolved = new Set<string>();
      for (const row of targetRows) {
        const stem = _importStem(row.target);
        if (stem === null) continue;
        const suffix = `/${stem}.py`;
        for (const candidate of allFiles) {
          if (candidate.endsWith(suffix) || candidate === `${stem}.py`) {
            if (candidate !== fileRel) resolved.add(candidate);
            break;
          }
        }
      }
      return Array.from(resolved).sort();
    });
  } catch (err) {
    if (_isNotFoundError(err)) return [];
    return [];
  }
}

/** Alias mirroring the Python snake_case name. */
export const get_file_imports = getFileImports;

/**
 * Return project-internal files that import `fileRel` (incoming, one level).
 *
 * Matches both relative and absolute import targets by stem. Returns a sorted,
 * deduplicated list. Returns [] on any DB error or when the DB does not exist.
 */
export function getFileImporters(
  projectHash: string,
  fileRel: string,
): string[] {
  const lastSlash = fileRel.lastIndexOf("/");
  const rawStem = lastSlash === -1 ? fileRel : fileRel.slice(lastSlash + 1);
  const stem = rawStem.endsWith(".py") ? rawStem.slice(0, -3) : rawStem;
  if (stem === "") return [];
  try {
    return openProjectReadonly(projectHash, (db) => {
      const rows = db
        .prepare(
          `SELECT DISTINCT file_rel FROM imports_exports
           WHERE kind = 'import' AND file_rel != ? AND (
             target = '.' || ?
             OR target LIKE '.' || ? || '.%'
             OR target = '..' || ?
             OR target LIKE '..' || ? || '.%'
             OR target = '...' || ?
             OR target LIKE '...' || ? || '.%'
             OR target = ?
             OR target LIKE '%.' || ?
             OR target LIKE '%.' || ? || '.%'
           )
           ORDER BY file_rel`,
        )
        .all(
          fileRel,
          stem,
          stem,
          stem,
          stem,
          stem,
          stem,
          stem,
          stem,
          stem,
        ) as Array<{ file_rel: string }>;
      return rows.map((r) => r.file_rel);
    });
  } catch (err) {
    if (_isNotFoundError(err)) return [];
    return [];
  }
}

/** Alias mirroring the Python snake_case name. */
export const get_file_importers = getFileImporters;

/**
 * Extract the module stem from a relative import target string.
 *
 * `..db` → "db", `..db.SomeClass` → "db", `typer` → undefined (absolute).
 */
function _importStem(target: string): string | undefined {
  let i = 0;
  while (i < target.length && target.charAt(i) === ".") i++;
  const stripped = target.slice(i);
  if (stripped === "" || stripped === target) return undefined;
  const nextDot = stripped.indexOf(".");
  return nextDot === -1 ? stripped : stripped.slice(0, nextDot);
}

// ===========================================================================
// Type definitions query — NOTE: Python AST parsing of __all__ and class-field
// classification is intentionally NOT ported here. Those paths require reading
// source files + AST walking; the TS port returns indexed symbols only (the
// DB-query half of get_file_exports / get_type_definitions). The source-parsing
// half lands with the parser layer (L4) which owns tree-sitter / TS ASTs. This
// is the single largest parity gap and is documented in the port report.
// ===========================================================================

/**
 * Return public top-level symbol rows exported from `fileRel` in the project.
 *
 * NOTE: This is the DB-only half of the Python get_file_exports. The Python
 * original additionally parses `__all__` from source via the `ast` module;
 * that AST parsing is deferred to the parser layer (L4). Here we return the
 * indexed public top-level symbols (name not starting with `_`, kind in the
 * top-level set, end_line not null), matching the Python "no __all__" branch
 * exactly. Callers that need __all__ filtering must layer it on once the
 * parser port lands.
 */
export function getFileExports(
  projectHash: string,
  fileRel: string,
): Array<{
  name: string;
  kind: string;
  start_line: number;
  end_line: number | null;
  docstring: null;
}> {
  const topLevelKinds = new Set([
    "function",
    "async_function",
    "class",
    "interface",
    "struct",
    "trait",
    "enum",
    "type_alias",
    "constructor",
  ]);
  try {
    return openProjectReadonly(projectHash, (db) => {
      const rows = db
        .prepare(
          `SELECT name, kind, line AS start_line, end_line
           FROM symbols
           WHERE file_rel = ? AND end_line IS NOT NULL
           ORDER BY line`,
        )
        .all(fileRel) as Array<{
        name: string;
        kind: string;
        start_line: number;
        end_line: number | null;
      }>;
      const out: Array<{
        name: string;
        kind: string;
        start_line: number;
        end_line: number | null;
        docstring: null;
      }> = [];
      for (const r of rows) {
        if (r.name.startsWith("_")) continue;
        if (!topLevelKinds.has(r.kind)) continue;
        out.push({
          name: r.name,
          kind: r.kind,
          start_line: Number(r.start_line),
          end_line: r.end_line === null ? null : Number(r.end_line),
          docstring: null,
        });
      }
      return out;
    });
  } catch (err) {
    if (_isNotFoundError(err)) return [];
    return [];
  }
}

/** Alias mirroring the Python snake_case name. */
export const get_file_exports = getFileExports;

// ===========================================================================
// Compression + hook timing stats
// ===========================================================================

/**
 * Return focused compression metrics from the global stats table.
 *
 * Keys: tokens_saved, outputs_compressed, reread_denies, images_shrunk,
 * top_filters. Returns all-zero on any DB error.
 *
 * When *sessionId* is provided the query is restricted to events recorded
 * since that session's started_ts (loaded via session.safe_load); pass
 * undefined for all-time aggregates. Mirrors Python db.py:2141-2152.
 */
export function getCompressionStats(sessionId?: string | undefined): {
  tokens_saved: number;
  outputs_compressed: number;
  reread_denies: number;
  images_shrunk: number;
  top_filters: Array<{ filter: string; tokens_saved: number }>;
} {
  // Resolve the session's started_ts to scope the queries (Python db.py:2141).
  let sinceTs: number | null = null;
  if (sessionId !== undefined && sessionId !== null) {
    try {
      const cache = session.safe_load(sessionId, {
        caller: "getCompressionStats",
      });
      if (cache !== null) {
        sinceTs = cache.started_ts;
      }
    } catch {
      // fail-soft: fall through to the all-time aggregate.
    }
  }
  const tsClause = sinceTs !== null ? "AND ts >= ?" : "";
  const baseParams: Array<number> = sinceTs !== null ? [sinceTs] : [];

  try {
    return openGlobalReadonly((db) => {
      const tokensRow = db
        .prepare(
          `SELECT COALESCE(SUM(tokens_saved),0) AS n FROM stats WHERE tokens_saved > 0 AND kind NOT LIKE '%_overhead' ${tsClause}`,
        )
        .get(...baseParams) as { n: number };
      const tokensSaved = Number(tokensRow?.n ?? 0);

      const compRow = db
        .prepare(
          `SELECT COUNT(*) AS n FROM stats WHERE kind = 'bash_output_cached' ${tsClause}`,
        )
        .get(...baseParams) as { n: number };
      const outputsCompressed = Number(compRow?.n ?? 0);

      const denyRow = db
        .prepare(
          `SELECT COUNT(*) AS n FROM stats WHERE kind = 'reread_deny' ${tsClause}`,
        )
        .get(...baseParams) as { n: number };
      const rereadDenies = Number(denyRow?.n ?? 0);

      const imgRow = db
        .prepare(
          `SELECT COUNT(*) AS n FROM stats WHERE kind IN ('image_shrink','image_shrink_cache_hit') ${tsClause}`,
        )
        .get(...baseParams) as { n: number };
      const imagesShrunk = Number(imgRow?.n ?? 0);

      const topRows = db
        .prepare(
          `SELECT kind, SUM(tokens_saved) AS ts_sum FROM stats
           WHERE tokens_saved > 0 AND kind NOT LIKE '%_overhead' ${tsClause}
           GROUP BY kind ORDER BY ts_sum DESC LIMIT 3`,
        )
        .all(...baseParams) as Array<{ kind: string; ts_sum: number }>;
      const topFilters = topRows.map((r) => ({
        filter: r.kind,
        tokens_saved: Number(r.ts_sum),
      }));

      return {
        tokens_saved: tokensSaved,
        outputs_compressed: outputsCompressed,
        reread_denies: rereadDenies,
        images_shrunk: imagesShrunk,
        top_filters: topFilters,
      };
    });
  } catch {
    return {
      tokens_saved: 0,
      outputs_compressed: 0,
      reread_denies: 0,
      images_shrunk: 0,
      top_filters: [],
    };
  }
}

/** Alias mirroring the Python snake_case name. */
export const get_compression_stats = getCompressionStats;

/**
 * Return per-hook-event timing stats from the stats table.
 *
 * Queries rows where `kind LIKE 'hook:%'`; `bytes_saved` stores elapsed_ms.
 *
 * @param windowDays Look-back window in days. 0 = all time.
 * @returns Map of event name (stripped of `hook:` prefix) →
 *   `{ count, avg_ms, p95_ms, max_ms }`.
 */
export function getHookTimingStats(
  windowDays: number = 7,
): Record<string, { count: number; avg_ms: number; p95_ms: number; max_ms: number }> {
  const sinceTs = windowDays > 0 ? Math.floor(Date.now() / 1000) - windowDays * 86400 : 0;
  const result: Record<string, { count: number; avg_ms: number; p95_ms: number; max_ms: number }> = {};
  let rows: Array<{ kind: string; bytes_saved: number }>;
  try {
    rows = openGlobalReadonly((db) => {
      return db
        .prepare(
          "SELECT kind, bytes_saved FROM stats WHERE kind LIKE 'hook:%' AND ts >= ? ORDER BY kind",
        )
        .all(sinceTs) as Array<{ kind: string; bytes_saved: number }>;
    });
  } catch {
    return result;
  }
  const byEvent = new Map<string, number[]>();
  for (const row of rows) {
    const event = row.kind.slice(5); // strip "hook:"
    const ms = Math.max(0, Number(row.bytes_saved));
    const arr = byEvent.get(event);
    if (arr === undefined) {
      byEvent.set(event, [ms]);
    } else {
      arr.push(ms);
    }
  }
  for (const [event, values] of byEvent) {
    values.sort((a, b) => a - b);
    const n = values.length;
    const avgMs = Math.floor(values.reduce((a, b) => a + b, 0) / n);
    const p95Idx = Math.max(0, Math.floor(n * 0.95) - 1);
    const p95Ms = values[p95Idx] ?? 0;
    const maxMs = values[n - 1] ?? 0;
    result[event] = { count: n, avg_ms: avgMs, p95_ms: p95Ms, max_ms: maxMs };
  }
  return result;
}

/** Alias mirroring the Python snake_case name. */
export const get_hook_timing_stats = getHookTimingStats;

/**
 * Return file_rel → importance score for compact manifest trim ordering.
 *
 * Score = hit_count * exp(-lambda * age_days) where lambda=0.1 and age_days is
 * derived from last_access_epoch. When last_access_epoch is NULL, age_days=30.
 * Returns an empty map on any error.
 */
export function getEntryScores(projectHash: string): Map<string, number> {
  const LAMBDA = 0.1;
  const NULL_AGE_DAYS = 30.0;
  const now = Date.now() / 1000;
  const result = new Map<string, number>();
  try {
    openProjectReadonly(projectHash, (db) => {
      const rows = db
        .prepare(
          "SELECT detail, COUNT(*) AS hit_count, MAX(last_access_epoch) AS last_access FROM stats WHERE detail IS NOT NULL GROUP BY detail",
        )
        .all() as Array<{
        detail: string;
        hit_count: number;
        last_access: number | null;
      }>;
      for (const row of rows) {
        const hitCount = Number(row.hit_count);
        const ageDays =
          row.last_access === null || row.last_access === undefined
            ? NULL_AGE_DAYS
            : (now - Number(row.last_access)) / 86400.0;
        result.set(row.detail, hitCount * Math.exp(-LAMBDA * ageDays));
      }
    });
  } catch {
    // best-effort — return what we have (likely empty).
  }
  return result;
}

/** Alias mirroring the Python snake_case name. */
export const get_entry_scores = getEntryScores;

// ===========================================================================
// Validation
// ===========================================================================

const _PROJECT_HASH_RE = /^[0-9a-f]+$/;

/**
 * Validate projectHash to prevent path traversal attacks.
 *
 * Hashes are SHA-1 hex digests (lowercase [0-9a-f]+), so any value containing
 * uppercase letters, underscores, or path separators is provably not a real hash.
 */
export function _validateProjectHash(projectHash: string): void {
  if (!projectHash) {
    throw new Error("project_hash cannot be empty");
  }
  if (projectHash.length > 128) {
    throw new Error(`project_hash too long (max 128 chars): ${projectHash.length}`);
  }
  if (!_PROJECT_HASH_RE.test(projectHash)) {
    throw new Error(`project_hash must be lowercase hex (SHA-1 digest): ${JSON.stringify(projectHash)}`);
  }
}

// ===========================================================================
// Reset registration — clear per-path caches between tests
// ===========================================================================
//
// Python kept _INTEGRITY_CHECKED / _SCHEMA_MIGRATED / _STATS_EPOCH_MIGRATED as
// module globals cleared by conftest.py. In TS these Maps/Sets are module-
// scoped; tests clear them via clearModuleCaches() (reset.ts), which runs the
// fn registered here. clearModuleCaches() is called by every test's
// beforeEach (see tests/setup.ts), so each test starts with empty per-path
// caches — exactly the Python contract.
registerReset(() => {
  _INTEGRITY_CHECKED.clear();
  _SCHEMA_MIGRATED.clear();
  _STATS_EPOCH_MIGRATED.clear();
});
