/**
 * Per-session content snapshots used for diff-aware re-read hints.
 *
 * Faithful port of src/token_goat/snapshots.py.
 *
 * When a file is read inside a session, post_read captures a copy of its
 * contents under `data_dir() / "session_snapshots" / "<session_short>"`. A
 * later pre-read can diff the live file against the stored snapshot. Snapshots
 * are scoped per-session, live on disk, are keyed by a SHA of the file path,
 * are capped per-session and per-file, and are best-effort (I/O errors are
 * logged and swallowed).
 *
 * Parity notes (Python → TS):
 *  - pathlib.Path → string paths throughout. `Path.exists()` → fs.existsSync;
 *    `Path.stat().st_mtime` (float seconds) → fs.statSync().mtimeMs / 1000;
 *    `Path.stat().st_size` → fs.statSync().size; `Path.read_bytes()` →
 *    fs.readFileSync(p) (a Buffer); `Path.unlink()` → fs.unlinkSync;
 *    `Path.iterdir()` → fs.readdirSync(d) joined back to absolute paths;
 *    `Path.rmdir()` → fs.rmdirSync; `Path.name` → path.basename; `Path.suffix`
 *    → the final `.ext`; `Path.is_file()/is_symlink()` → fs.lstatSync checks.
 *  - `p.with_suffix(p.suffix + ".kind")` (the sidecar) → string concat of the
 *    `.bin` path + ".kind" (so `<key>.bin` → `<key>.bin.kind`), matching the
 *    Python with_suffix-of-the-compound-suffix behaviour for our fixed `.bin`.
 *  - hashlib.sha256(...).hexdigest() → crypto.createHash("sha256")
 *    .update(buf).digest("hex"). The path key hashes the UTF-8 bytes of the
 *    file path (errors="replace" → Buffer.from(s,"utf8") substitutes U+FFFD)
 *    and takes the first 32 hex chars; the content SHA hashes the stored bytes
 *    full-length. Both are byte-identical to Python for the same input.
 *  - `_TRUNCATED_MARKER = b"\\n<snapshot truncated at %d bytes>\\n"` → a Buffer
 *    built by string-formatting %d with orig_len, then UTF-8 encoded. ASCII
 *    only, so byte-identical. The truncated content is the first
 *    SNAPSHOT_TRUNCATE_BYTES bytes of the UTF-8 buffer + the marker, exactly as
 *    Python slices `content[:SNAPSHOT_TRUNCATE_BYTES]` on a bytes object (byte
 *    slice, never code units).
 *  - `content: bytes` parameter → Buffer. `len(content)` → content.length
 *    (Buffer length is the byte count). Byte slicing uses Buffer.subarray.
 *  - @contextmanager safe_cache_op → the cache_common.safe_cache_op
 *    higher-order form: `safe_cache_op(name, {log}, () => {...; return X})`,
 *    returning undefined when an OSError was suppressed. The Python
 *    `with safe_cache_op(...): return SnapshotResult(...)` then fall-through
 *    `return None` becomes `const r = safe_cache_op(...); return r ?? null`.
 *  - re.compile(r"[^a-zA-Z0-9_\\-]") → the identical RegExp with a global flag
 *    so `.sub("_", id)` (replace-all) → `.replace(re, "_")`.
 *  - `safe = _SESSION_DIR_RE.sub("_", session_id)[:64] or "anon"` → slice to 64
 *    *chars* (the session ids are ASCII so chars == bytes), `|| "anon"` for the
 *    empty case.
 *  - os.lstat + stat.S_ISLNK → fs.lstatSync(p).isSymbolicLink(). os.utime in
 *    tests → fs.utimesSync (test side only).
 *  - time.time() → Date.now() / 1000 (float seconds), used by cleanup_stale.
 *  - The deferred `from . import session` inside symbol_changed_since_read
 *    (to avoid a circular import and look up the recorded snapshot SHA) is NOT
 *    available yet — the session module is not ported in this layer. The TS
 *    port wraps the lookup in try/catch exactly like Python; with no session
 *    module the lookup yields undefined (expected_sha undefined → unverified
 *    load), preserving the legacy fallback path. A getSnapshotShaLookup setter
 *    is provided so the session module can wire itself in when it lands without
 *    editing this file's call site.
 *  - str.splitlines(keepends=True) → a keepends-preserving line splitter (see
 *    splitLinesKeepEnds) covering \\n, \\r\\n, \\r, and the Unicode line
 *    boundaries Python's splitlines recognises. The symbol-range extraction
 *    slices that list and rstrips trailing newlines, matching Python.
 *  - bytes.decode("utf-8", errors="replace") → buf.toString("utf8") (Node
 *    substitutes U+FFFD for invalid sequences, the errors="replace" contract).
 *
 * Cache reset: this module has NO module-global mutable cache (the only
 * module-level mutable slot is the optional session-SHA lookup seam, which is a
 * wiring hook, not a per-test cache). It registers a reset that clears that
 * lookup so a test that installed one does not leak into the next.
 *
 * `verbatimModuleSyntax` is on → type-only imports use `import type`.
 * `exactOptionalPropertyTypes` is on → optional fields are `T | undefined`.
 * `noUncheckedIndexedAccess` is on → every indexed access is narrowed.
 */

import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import * as paths from "./paths.js";
import { safe_cache_op } from "./cache_common.js";
import { sanitize_log_str } from "./hooks_common.js";
import { registerReset } from "./reset.js";
import { getLogger } from "./util.js";

const _LOG = getLogger("snapshots");

// Recognised snapshot origin kinds. Stored as a tiny sidecar next to the
// binary snapshot so the diff-hint path can distinguish a normal post-read
// capture (``read``) from one written speculatively by the predictive
// prefetch path (``predictive``). The default is ``read``.
const _KIND_READ: string = "read";
const _KIND_PREDICTIVE: string = "predictive";
const _VALID_KINDS: ReadonlySet<string> = new Set([_KIND_READ, _KIND_PREDICTIVE]);

// Largest file size eligible for snapshotting. 256 KB.
export const MAX_SNAPSHOT_BYTES: number = 256 * 1024;

// Truncation threshold. Files larger than this are stored truncated to this
// many bytes (with a ``<snapshot truncated at NNN bytes>`` marker appended).
export const SNAPSHOT_TRUNCATE_BYTES: number = 50 * 1024;

// Sentinel appended to truncated snapshots so the diff hint and
// symbol_changed_since_read can recognise that the stored bytes are partial.
// Python: b"\n<snapshot truncated at %d bytes>\n" formatted with orig_len.
function _truncatedMarker(origLen: number): Buffer {
  return Buffer.from(`\n<snapshot truncated at ${origLen} bytes>\n`, "ascii");
}

// Per-session ceiling on snapshot count. 150.
export const MAX_SNAPSHOTS_PER_SESSION: number = 150;

// Used to scrub session_id before embedding it in a directory name.
const _SESSION_DIR_RE = /[^a-zA-Z0-9_\-]/g;

/**
 * Outcome of {@link store} — what was written and where.
 *
 * A non-null ``path`` indicates the snapshot exists on disk and can be loaded
 * later via {@link load}. ``content_sha`` is the SHA-256 hex digest of the
 * stored bytes. Field names preserve the Python dataclass exactly so the test
 * accesses (``result.path``, ``result.content_sha``, ``result.size_bytes``)
 * port one-for-one.
 *
 * Defined locally (types.ts has no SnapshotResult shape; see new_types_added).
 */
export interface SnapshotResult {
  path: string;
  content_sha: string;
  size_bytes: number;
}

// ---------------------------------------------------------------------------
// Optional session-SHA lookup seam.
//
// Python's symbol_changed_since_read does a deferred `from . import session`
// to call session.get_snapshot_sha(session_id, file_path). The session module
// is not ported in this layer; this slot lets it wire itself in when it lands
// without this file importing it (which would also re-create the circular
// import the Python deferral avoids). Until then the lookup is undefined and
// the integrity check is skipped (the legacy fallback path).
// ---------------------------------------------------------------------------
type SnapshotShaLookup = (sessionId: string, filePath: string) => string | undefined;
let _getSnapshotShaLookup: SnapshotShaLookup | undefined = undefined;

/** Install (or clear) the session-SHA lookup used by symbol_changed_since_read. */
export function setSnapshotShaLookup(fn: SnapshotShaLookup | undefined): void {
  _getSnapshotShaLookup = fn;
}

// ---------------------------------------------------------------------------
// Small pathlib-on-strings helpers.
// ---------------------------------------------------------------------------

/** True when err is an OSError-equivalent (Node ErrnoException with a code). */
function isOSError(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    typeof (err as NodeJS.ErrnoException).code === "string"
  );
}

/** Python Path.suffix — the final extension including the dot, or "". */
function pathSuffix(p: string): string {
  const base = path.basename(p);
  const dot = base.lastIndexOf(".");
  if (dot > 0) {
    return base.slice(dot);
  }
  return "";
}

/** Python Path.stat().st_mtime in float seconds. */
function statMtimeSeconds(st: fs.Stats): number {
  return st.mtimeMs / 1000;
}

// ---------------------------------------------------------------------------
// _session_dir / _path_key / snapshot_path
// ---------------------------------------------------------------------------

/** Resolve the snapshots directory for *session_id*, or null on invalid input. */
function _session_dir(session_id: string): string | null {
  if (!session_id) {
    return null;
  }
  const replaced = session_id.replace(_SESSION_DIR_RE, "_").slice(0, 64);
  const safe = replaced || "anon";
  const base = path.resolve(path.join(paths.dataDir(), "session_snapshots"));
  const candidate = path.resolve(path.join(base, safe));
  // Python: candidate.relative_to(base) raises ValueError when not under base.
  if (candidate !== base && !candidate.startsWith(base + path.sep)) {
    _LOG.warning(
      "snapshots: session_dir escaped base for %s",
      JSON.stringify(sanitize_log_str(session_id)),
    );
    return null;
  }
  return candidate;
}

// _session_dir is reached by a test (snapshots._session_dir). Export a
// snake_case alias matching the Python private name the test imports.
export { _session_dir };

/**
 * Return the on-disk filename component for *file_path*.
 *
 * Hashes the UTF-8 path bytes (errors="replace") and takes the first 32 hex
 * chars (~128 bits) — plenty for a per-session set of at most ~150 entries.
 */
function _path_key(file_path: string): string {
  return createHash("sha256")
    .update(Buffer.from(file_path, "utf8"))
    .digest("hex")
    .slice(0, 32);
}

/**
 * Return the snapshot file path for ``(session_id, file_path)``, or null.
 *
 * Always returns a path even when the snapshot does not yet exist.
 */
export function snapshot_path(session_id: string, file_path: string): string | null {
  const d = _session_dir(session_id);
  if (d === null) {
    return null;
  }
  return path.join(d, `${_path_key(file_path)}.bin`);
}

/** Return the sidecar path that holds the snapshot's origin kind. */
function _kind_sidecar_path(snapshot_p: string): string {
  // Python: snapshot_p.with_suffix(snapshot_p.suffix + ".kind"). For our fixed
  // ``.bin`` snapshot this yields ``<key>.bin.kind``.
  const suffix = pathSuffix(snapshot_p);
  return snapshot_p.slice(0, snapshot_p.length - suffix.length) + suffix + ".kind";
}

// ---------------------------------------------------------------------------
// _evict_oldest
// ---------------------------------------------------------------------------

/**
 * Drop the oldest snapshots in *d* until at most *max_count* remain.
 *
 * Returns the number of ``.bin`` snapshots removed (sidecar ``.kind`` files are
 * evicted alongside their owning ``.bin`` but do not count). Silently ignores
 * I/O errors.
 */
function _evict_oldest(d: string, max_count: number): number {
  let names: string[];
  try {
    names = fs.readdirSync(d);
  } catch {
    return 0;
  }
  const entries: Array<[string, number]> = [];
  try {
    for (const name of names) {
      const p = path.join(d, name);
      let st: fs.Stats;
      try {
        st = fs.lstatSync(p);
      } catch {
        continue;
      }
      if (st.isFile() && !st.isSymbolicLink() && pathSuffix(p) === ".bin") {
        entries.push([p, statMtimeSeconds(st)]);
      }
    }
  } catch {
    return 0;
  }
  if (entries.length <= max_count) {
    return 0;
  }
  // Stable ascending sort by mtime (V8 Array.sort is stable, like Python's).
  entries.sort((a, b) => a[1] - b[1]);
  let removed = 0;
  const over = entries.length - max_count;
  for (const [p] of entries.slice(0, over)) {
    try {
      fs.unlinkSync(p);
      removed += 1;
    } catch {
      continue;
    }
    // Best-effort sidecar removal.
    try {
      fs.unlinkSync(_kind_sidecar_path(p));
    } catch {
      // suppress(OSError)
    }
  }
  if (removed) {
    _LOG.debug(
      "snapshots: evicted %d entries from %s (cap=%d)",
      removed,
      path.basename(d),
      max_count,
    );
  }
  return removed;
}

// ---------------------------------------------------------------------------
// store
// ---------------------------------------------------------------------------

/**
 * Persist *content* as the current snapshot for ``(session_id, file_path)``.
 *
 * Returns null when the file is too large, the session dir cannot be created,
 * or any I/O error occurs. Otherwise returns a {@link SnapshotResult}.
 *
 * The *kind* tag identifies why the snapshot was written (``read`` default vs
 * ``predictive``); any unrecognised kind falls back to ``read``.
 */
export function store(
  session_id: string,
  file_path: string,
  content: Buffer,
  opts?: { kind?: string },
): SnapshotResult | null {
  const kind = opts?.kind ?? _KIND_READ;
  const orig_len = content.length;
  if (orig_len > MAX_SNAPSHOT_BYTES) {
    _LOG.debug(
      "snapshots: skipping oversized file (%d bytes > %d cap): %s",
      orig_len,
      MAX_SNAPSHOT_BYTES,
      sanitize_log_str(file_path),
    );
    return null;
  }
  // Truncation: files larger than SNAPSHOT_TRUNCATE_BYTES but still within
  // MAX_SNAPSHOT_BYTES are stored truncated. The SHA recorded is the SHA of
  // the *stored* (truncated) bytes, not of the original file.
  let stored = content;
  if (orig_len > SNAPSHOT_TRUNCATE_BYTES) {
    const marker = _truncatedMarker(orig_len);
    stored = Buffer.concat([content.subarray(0, SNAPSHOT_TRUNCATE_BYTES), marker]);
    _LOG.debug(
      "snapshots: truncating %d-byte file to %d bytes (threshold=%d): %s",
      orig_len,
      stored.length,
      SNAPSHOT_TRUNCATE_BYTES,
      sanitize_log_str(file_path),
    );
  }
  const p = snapshot_path(session_id, file_path);
  if (p === null) {
    return null;
  }
  const sha = createHash("sha256").update(stored).digest("hex");
  const safe_kind = _VALID_KINDS.has(kind) ? kind : _KIND_READ;

  // Content-hash dedup: skip the disk write when the existing snapshot is
  // byte-for-byte identical.
  if (fs.existsSync(p)) {
    try {
      const existing = fs.readFileSync(p);
      if (existing.equals(stored)) {
        _LOG.debug(
          "snapshots: content unchanged, skipping write for %s",
          sanitize_log_str(file_path),
        );
        return { path: p, content_sha: sha, size_bytes: stored.length };
      }
    } catch {
      // fall through to normal write
    }
  }

  const result = safe_cache_op(
    `store:${sanitize_log_str(file_path)}`,
    { log: _LOG },
    (): SnapshotResult => {
      paths.ensureDir(path.dirname(p));
      _evict_oldest(path.dirname(p), MAX_SNAPSHOTS_PER_SESSION - 1);
      paths.atomicWriteBytes(p, stored);
      // Sidecar write is best-effort.
      const sidecar = _kind_sidecar_path(p);
      try {
        paths.atomicWriteBytes(sidecar, Buffer.from(safe_kind, "ascii"));
      } catch (exc) {
        if (isOSError(exc)) {
          _LOG.debug(
            "snapshots: kind sidecar write failed for %s: %s",
            sanitize_log_str(file_path),
            exc,
          );
        } else {
          throw exc;
        }
      }
      return { path: p, content_sha: sha, size_bytes: stored.length };
    },
  );
  return result === undefined ? null : result;
}

// ---------------------------------------------------------------------------
// load_kind
// ---------------------------------------------------------------------------

/**
 * Return the recorded kind for the snapshot of ``(session_id, file_path)``.
 *
 * Returns one of {@link _VALID_KINDS}, or null when no sidecar exists. Never
 * raises — any I/O error returns null.
 */
export function load_kind(session_id: string, file_path: string): string | null {
  const p = snapshot_path(session_id, file_path);
  if (p === null) {
    return null;
  }
  const sidecar = _kind_sidecar_path(p);
  if (!fs.existsSync(sidecar)) {
    return null;
  }
  let raw: Buffer;
  try {
    // Cap the read to 32 bytes so a planted oversize sidecar cannot waste
    // memory. fs.read into a 32-byte buffer mirrors fh.read(32).
    const fd = fs.openSync(sidecar, "r");
    try {
      const buf = Buffer.alloc(32);
      const n = fs.readSync(fd, buf, 0, 32, 0);
      raw = buf.subarray(0, n);
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return null;
  }
  // Python decodes ascii and returns None on UnicodeDecodeError. Any byte
  // >= 0x80 is non-ASCII; reject the whole payload to mirror that.
  for (const b of raw) {
    if (b >= 0x80) {
      return null;
    }
  }
  const text = raw.toString("ascii").trim();
  return _VALID_KINDS.has(text) ? text : null;
}

// ---------------------------------------------------------------------------
// load
// ---------------------------------------------------------------------------

/**
 * Return the snapshot bytes for ``(session_id, file_path)``, or null.
 *
 * Returns null when the snapshot is absent, unreadable, or too large. When
 * *expected_sha* is provided, the loaded bytes are hashed and compared
 * (case-insensitively) to it; on mismatch null is returned with a warning. A
 * null/undefined *expected_sha* skips the integrity check.
 */
export function load(
  session_id: string,
  file_path: string,
  opts?: { expected_sha?: string | null },
): Buffer | null {
  const expected_sha = opts?.expected_sha ?? null;
  const p = snapshot_path(session_id, file_path);
  if (p === null || !fs.existsSync(p)) {
    return null;
  }
  let size: number;
  try {
    size = fs.statSync(p).size;
  } catch {
    return null;
  }
  if (size > MAX_SNAPSHOT_BYTES) {
    _LOG.warning(
      "snapshots: refusing to load oversized snapshot (%d bytes): %s",
      size,
      sanitize_log_str(file_path),
    );
    return null;
  }
  let data: Buffer;
  try {
    data = fs.readFileSync(p);
  } catch (exc) {
    _LOG.warning(
      "snapshots: load failed for %s: %s",
      sanitize_log_str(file_path),
      exc,
    );
    return null;
  }
  if (expected_sha !== null) {
    const actual_sha = createHash("sha256").update(data).digest("hex");
    if (actual_sha.toLowerCase() !== expected_sha.toLowerCase()) {
      _LOG.warning(
        "snapshots: integrity mismatch for %s " +
          "(expected sha[:8]=%s, got sha[:8]=%s, size=%d) — discarding",
        sanitize_log_str(file_path),
        expected_sha ? expected_sha.slice(0, 8) : "",
        actual_sha.slice(0, 8),
        size,
      );
      return null;
    }
  }
  return data;
}

// ---------------------------------------------------------------------------
// cleanup_session
// ---------------------------------------------------------------------------

/**
 * Remove every snapshot for *session_id*. Returns the count removed (``.bin``
 * snapshots only; sidecars are excluded from the count). Refuses to follow
 * symlinks.
 */
export function cleanup_session(session_id: string): number {
  const d = _session_dir(session_id);
  if (d === null || !fs.existsSync(d)) {
    return 0;
  }
  let removed = 0; // count of .bin snapshots removed (sidecars excluded)
  let names: string[];
  try {
    names = fs.readdirSync(d);
  } catch {
    return removed;
  }
  try {
    for (const name of names) {
      const fp = path.join(d, name);
      let st: fs.Stats;
      try {
        st = fs.lstatSync(fp);
      } catch {
        continue;
      }
      if (st.isSymbolicLink()) {
        _LOG.warning("snapshots: skipping symlink in cleanup: %s", path.basename(fp));
        continue;
      }
      const is_snapshot = pathSuffix(fp) === ".bin";
      try {
        fs.unlinkSync(fp);
        if (is_snapshot) {
          removed += 1;
        }
      } catch {
        continue;
      }
    }
  } catch {
    return removed;
  }
  try {
    fs.rmdirSync(d); // only succeeds when empty; ignore otherwise
  } catch {
    // suppress(OSError)
  }
  _LOG.debug("snapshots: cleanup_session %s removed=%d", sanitize_log_str(session_id), removed);
  return removed;
}

// ---------------------------------------------------------------------------
// splitlines(keepends=True) helper
// ---------------------------------------------------------------------------

/**
 * Port of str.splitlines(keepends=True). Splits on the same line boundaries
 * Python recognises (\n, \r, \r\n, and the Unicode line separators), KEEPING
 * each terminator on its line. A trailing terminator does NOT produce a final
 * empty segment (matching Python). An empty string returns [].
 */
function splitLinesKeepEnds(s: string): string[] {
  if (s.length === 0) {
    return [];
  }
  // Python str.splitlines line boundaries (the full set):
  //   \n \r \v \f \x1c \x1d \x1e \x85    , plus \r\n as one break.
  const out: string[] = [];
  let start = 0;
  let i = 0;
  const n = s.length;
  const isBoundary = (ch: string): boolean =>
    ch === "\n" ||
    ch === "\r" ||
    ch === "\v" ||
    ch === "\f" ||
    ch === "\x1c" ||
    ch === "\x1d" ||
    ch === "\x1e" ||
    ch === "\x85" ||
    ch === "\u2028" ||
    ch === "\u2029";
  while (i < n) {
    const ch = s[i]!;
    if (isBoundary(ch)) {
      let end = i + 1;
      // \r\n counts as a single boundary.
      if (ch === "\r" && end < n && s[end] === "\n") {
        end += 1;
      }
      out.push(s.slice(start, end));
      start = end;
      i = end;
    } else {
      i += 1;
    }
  }
  if (start < n) {
    out.push(s.slice(start));
  }
  return out;
}

/** Port of str.rstrip("\n") — strip trailing newline characters only. */
function rstripNewlines(s: string): string {
  let end = s.length;
  while (end > 0 && s[end - 1] === "\n") {
    end -= 1;
  }
  return s.slice(0, end);
}

// ---------------------------------------------------------------------------
// symbol_changed_since_read
// ---------------------------------------------------------------------------

/**
 * Return true when *symbol_name* in *file_path* differs from what the session
 * last read.
 *
 * Returns false (no warning) when no snapshot exists, the bodies are identical,
 * or any error occurs. Returns true only when a snapshot exists AND the symbol
 * body extracted from it differs from *current_text*.
 */
export function symbol_changed_since_read(
  session_id: string,
  file_path: string,
  symbol_name: string,
  current_start_line: number,
  current_end_line: number,
  current_text: string,
): boolean {
  if (!session_id || !file_path || !symbol_name) {
    return false;
  }
  // Use the integrity-gated load path when a snapshot SHA has been recorded.
  // The session module is not ported yet; the lookup seam stays undefined and
  // the load runs unverified (legacy fallback). The try/catch mirrors Python's
  // "sha lookup must never block the caller".
  let expected_sha: string | undefined = undefined;
  try {
    if (_getSnapshotShaLookup !== undefined) {
      expected_sha = _getSnapshotShaLookup(session_id, file_path);
    }
  } catch {
    expected_sha = undefined;
  }
  const snapshot_bytes = load(session_id, file_path, { expected_sha: expected_sha ?? null });
  if (snapshot_bytes === null) {
    return false;
  }
  try {
    const snapshot_text = snapshot_bytes.toString("utf8");
    const snapshot_lines = splitLinesKeepEnds(snapshot_text);
    const n_lines = current_end_line - current_start_line + 1;
    const snap_start = Math.max(0, current_start_line - 1);
    const snap_end = snap_start + n_lines;
    const snapshot_slice = rstripNewlines(snapshot_lines.slice(snap_start, snap_end).join(""));
    const current_stripped = rstripNewlines(current_text);
    if (snapshot_slice === current_stripped) {
      return false;
    }
    // Line-offset check: the body may have moved without changing. Return true
    // only when the body is absent from the snapshot — it changed.
    return !(current_stripped !== "" && snapshot_text.includes(current_stripped));
  } catch {
    _LOG.debug(
      "symbol_changed_since_read: comparison failed for %s::%s",
      sanitize_log_str(file_path),
      sanitize_log_str(symbol_name),
    );
    return false;
  }
}

// ---------------------------------------------------------------------------
// cleanup_stale
// ---------------------------------------------------------------------------

/**
 * Drop snapshots whose mtime is older than *max_age_hours*. Returns the count
 * removed (``.bin`` snapshots only). Prunes empty session dirs as it goes.
 */
export function cleanup_stale(max_age_hours = 24.0): number {
  const base = path.join(paths.dataDir(), "session_snapshots");
  if (!fs.existsSync(base)) {
    return 0;
  }
  const cutoff = Date.now() / 1000 - max_age_hours * 3600;
  let removed = 0; // count of .bin snapshots removed (sidecars excluded)
  let sessionNames: string[];
  try {
    sessionNames = fs.readdirSync(base);
  } catch {
    return removed;
  }
  try {
    for (const sessionName of sessionNames) {
      const session_dir = path.join(base, sessionName);
      let sdStat: fs.Stats;
      try {
        sdStat = fs.lstatSync(session_dir);
      } catch {
        continue;
      }
      if (!sdStat.isDirectory() || sdStat.isSymbolicLink()) {
        continue;
      }
      let fileNames: string[];
      try {
        fileNames = fs.readdirSync(session_dir);
      } catch {
        continue;
      }
      try {
        for (const fileName of fileNames) {
          const fp = path.join(session_dir, fileName);
          let st: fs.Stats;
          try {
            st = fs.lstatSync(fp);
          } catch {
            continue;
          }
          if (st.isSymbolicLink()) {
            continue;
          }
          if (statMtimeSeconds(st) < cutoff) {
            const is_snapshot = pathSuffix(fp) === ".bin";
            try {
              fs.unlinkSync(fp);
              if (is_snapshot) {
                removed += 1;
              }
            } catch {
              continue;
            }
          }
        }
      } catch {
        continue;
      }
      // Clean up empty session dirs as we go.
      try {
        fs.rmdirSync(session_dir);
      } catch {
        // suppress(OSError)
      }
    }
  } catch {
    return removed;
  }
  if (removed) {
    _LOG.info(
      "snapshots: cleanup_stale removed=%d (max_age_hours=%s)",
      removed,
      max_age_hours.toFixed(1),
    );
  }
  return removed;
}

// ---------------------------------------------------------------------------
// __all__ — public symbol surface (parity with Python's snapshots.__all__).
// ---------------------------------------------------------------------------

/** Public symbol list, mirroring Python's `snapshots.__all__`. */
export const __all__ = [
  "MAX_SNAPSHOT_BYTES",
  "MAX_SNAPSHOTS_PER_SESSION",
  "SNAPSHOT_TRUNCATE_BYTES",
  "SnapshotResult",
  "cleanup_session",
  "load",
  "load_kind",
  "snapshot_path",
  "store",
  "symbol_changed_since_read",
] as const;

// ---------------------------------------------------------------------------
// Module-global reset registration.
// ---------------------------------------------------------------------------
// The only module-level mutable slot is the optional session-SHA lookup seam.
// Clear it on each per-test reset so a test that installed a lookup does not
// leak into the next (mirrors conftest clearing module state).
registerReset(() => {
  _getSnapshotShaLookup = undefined;
});
