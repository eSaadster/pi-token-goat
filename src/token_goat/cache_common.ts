/**
 * Shared constants and helpers used by bash_cache / web_cache / skill_cache —
 * the SPINE the three output-cache modules import from.
 *
 * Faithful port of src/token_goat/cache_common.py.
 *
 * Parity notes (Python → TS):
 *  - All byte math is done on UTF-8 Buffers (Buffer.from(s, "utf8") /
 *    util.utf8Bytes), NEVER String.length (which counts UTF-16 units). The
 *    *_output_id hashing, short_content_hash truncation length (16 hex),
 *    short_output_id last-8 suffix, truncate_tail_preserve and
 *    find_markdown_boundary are therefore byte-/codepoint-identical to Python.
 *  - hashlib.sha256(text.encode("utf-8", errors="replace")).hexdigest()[:16] →
 *    crypto.createHash("sha256").update(Buffer.from(text,"utf8")).digest("hex")
 *    .slice(0, 16). Buffer.from(...,"utf8") replaces lone surrogates with U+FFFD,
 *    matching Python's errors="replace" for the exact code points subprocess
 *    surrogate-escape produces.
 *  - @contextmanager safe_cache_op → a higher-order function taking a callback,
 *    with a try/catch that only swallows OSError-class errors (Node ErrnoException
 *    with a string `code`) and re-raises everything else, mirroring db.ts's
 *    contextmanager→callback port. The name `safe_cache_op` is preserved.
 *  - gzip.compress(level=6) / gzip.open(...).read() → node:zlib gzipSync(buf,
 *    {level:6}) / gunzipSync(buf). gzip is byte-deterministic at a given level so
 *    the compressed bytes match Python's stdlib gzip for the same input.
 *  - pathlib.Path → string paths. p.with_suffix(".json") → swap the final
 *    extension; p.stem / p.name / p.suffix → path.parse() fields; os.lstat →
 *    fs.lstatSync; st.st_mtime (seconds) → stat.mtimeMs / 1000 for a float-second
 *    value matching Python's st_mtime; S_ISLNK → stat.isSymbolicLink().
 *  - re.compile(r"^[a-zA-Z0-9_\-]{1,80}\.txt$") → the identical RegExp literal.
 *    Python's re.match anchors at the start only; the pattern here ends with `$`,
 *    so .test() reproduces re.match semantics exactly (and rejects an embedded
 *    null byte because `.` in the class excludes it).
 *  - `int(ms)` 013d formatting → String(Math.trunc(ms)).padStart(13, "0").
 *  - time.time() (float seconds) → Date.now() / 1000.
 *  - The platform-conditional Windows MAX_PATH (>=260) guard in
 *    safe_join_output_id keys off process.platform === "win32" exactly as the
 *    Python keys off sys.platform.
 *  - OutputStatDict is imported type-only from ./types.js (total=False → all
 *    fields optional). The runtime function builds the object literal directly.
 *
 * Cache reset: this module has NO module-global mutable state, so it registers
 * no reset. (_GZ_SUFFIX / _GZ_LEVEL are immutable consts.)
 *
 * `verbatimModuleSyntax` is on → type-only imports use `import type`.
 * `exactOptionalPropertyTypes` is on → optional fields pass through as written.
 * `noUncheckedIndexedAccess` is on → every buffer[i] / array[i] is narrowed.
 */

import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";

import * as _pathsEager from "./paths.js";
import type { OutputStatDict } from "./types.js";
import { getLogger } from "./util.js";

export type { OutputStatDict };

// Filename pattern shared by both the bash-output and web-output caches.
// Components are intentionally kept short so the full path stays well within
// PATH_MAX even when the data directory lives several levels deep (e.g. roaming
// AppData on Windows).
// Format: <session_short>-<timestamp_ms>-<contenthash>.txt
export const OUTPUT_FILENAME_RE = /^[a-zA-Z0-9_\-]{1,80}\.txt$/;

// Pre-compiled pattern used by safe_session_fragment — module-level so it is
// only compiled once across both callers.
export const _SESSION_UNSAFE_RE = /[^a-zA-Z0-9_\-]/g;

// Default gzip compression level used by both web_cache and skill_cache. Level 6
// balances speed and ratio well for text content (HTML, JSON, Markdown).
const _GZ_SUFFIX = ".gz";
const _GZ_LEVEL = 6;

/**
 * Zero-arg callable that returns (and creates if absent) a cache directory.
 * Mirrors the Python `Callable[[], Path]` parameter shape.
 */
export type CacheDirFn = () => string;

// ---------------------------------------------------------------------------
// Small path helpers mirroring pathlib.Path behaviour on string paths.
// ---------------------------------------------------------------------------

/** Python Path.name — the final path component. */
function pathName(p: string): string {
  return path.basename(p);
}

/** Python Path.stem — the final component without its last suffix. */
function pathStem(p: string): string {
  const base = path.basename(p);
  const dot = base.lastIndexOf(".");
  // pathlib: a leading-dot-only name (".txt") has stem ".txt" — its single dot
  // is treated as having no suffix. Match that by requiring dot > 0.
  if (dot > 0) {
    return base.slice(0, dot);
  }
  return base;
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

/** Python Path.with_name(name) — replace the final component. */
function withName(p: string, name: string): string {
  const dir = path.dirname(p);
  return path.join(dir, name);
}

/** Python st_mtime: float seconds since the epoch (fs gives ms). */
function statMtimeSeconds(st: fs.Stats): number {
  return st.mtimeMs / 1000;
}

/** True when err is an OSError-equivalent (Node ErrnoException with a code). */
function isOSError(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    typeof (err as NodeJS.ErrnoException).code === "string"
  );
}

// ---------------------------------------------------------------------------
// get_cache_dir
// ---------------------------------------------------------------------------

/**
 * Return `data_dir() / name` and create it on first use.
 *
 * Shared implementation of the `_bash_outputs_dir` / `_web_outputs_dir` /
 * `_skill_outputs_dir` pattern used in every cache module.
 */
export function get_cache_dir(name: string): string {
  // Lazy import to mirror Python's local `from . import paths as _paths` (and to
  // keep this module dependency-light at the top level).
  const _paths = pathsModule();
  return _paths.ensureDir(path.join(_paths.dataDir(), name));
}

// paths.js is statically imported (no cycle back into cache_common). The Python
// module did `from . import paths as _paths` inside each function body to avoid
// an import cycle through the package __init__; the TS module graph has no such
// cycle, so a single eager import suffices. pathsModule() is a thin accessor so
// every call site reads identically to the Python `_paths` local.
function pathsModule(): typeof _pathsEager {
  return _pathsEager;
}

// ---------------------------------------------------------------------------
// safe_cache_op (contextmanager → callback)
// ---------------------------------------------------------------------------

/**
 * Run `body()` and catch+log any OSError-class error from a cache write.
 *
 * Python's `@contextmanager safe_cache_op` is ported as a higher-order function
 * taking a callback, mirroring db.ts's contextmanager→callback convention. Only
 * OSError (Node ErrnoException with a string `code`) is caught and logged; all
 * other exceptions propagate. Returns the body's return value on success, or
 * undefined when an OSError was suppressed — so callers can write the Python
 * `with safe_cache_op(...): return X` then `return None` fall-through pattern as
 * `const r = safe_cache_op(...); if (r !== undefined) return r; return null`.
 */
export function safe_cache_op<T>(
  op_name: string,
  opts: { log: { warning: (msg: string, ...args: unknown[]) => void } },
  body: () => T,
): T | undefined {
  try {
    return body();
  } catch (exc) {
    if (isOSError(exc)) {
      opts.log.warning("cache: %s failed: %s", op_name, exc);
      return undefined;
    }
    throw exc;
  }
}

// ---------------------------------------------------------------------------
// sidecar_path_for / path_mtime_key
// ---------------------------------------------------------------------------

/** Return the `.json` sidecar path for `output_path` (a `.txt` body file). */
export function sidecar_path_for(output_path: string): string {
  const suffix = pathSuffix(output_path);
  if (suffix !== "") {
    return output_path.slice(0, output_path.length - suffix.length) + ".json";
  }
  return output_path + ".json";
}

/** Return the mtime of `p` as a float (seconds), or 0.0 on OSError. */
export function path_mtime_key(p: string): number {
  try {
    return statMtimeSeconds(fs.statSync(p));
  } catch {
    return 0.0;
  }
}

// ---------------------------------------------------------------------------
// short_content_hash / build_output_id / build_keyed_output_id
// ---------------------------------------------------------------------------

/** Return the first 16 hex characters of the SHA-256 of `text`. */
export function short_content_hash(text: string): string {
  return createHash("sha256")
    .update(Buffer.from(text, "utf8"))
    .digest("hex")
    .slice(0, 16);
}

/** Build the canonical `{session_short}-{ms:013d}-{content_token}` output ID. */
export function build_output_id(
  session_id: string,
  content_token: string,
  ts?: number,
): string {
  const safe_session = safe_session_fragment(session_id);
  const seconds = ts !== undefined ? ts : Date.now() / 1000;
  const ms = Math.trunc(seconds * 1000);
  return `${safe_session}-${String(ms).padStart(13, "0")}-${content_token}`;
}

/** Build a timestamp-less `{prefix}{session_short}-{content_token}` output ID. */
export function build_keyed_output_id(
  prefix: string,
  session_id: string,
  content_token: string,
): string {
  const safe_session = safe_session_fragment(session_id);
  return `${prefix}${safe_session}-${content_token}`;
}

// ---------------------------------------------------------------------------
// gz_companion_size
// ---------------------------------------------------------------------------

/** Return the byte size of the `<id>.gz` sibling of a `.txt` stub, or 0. */
export function gz_companion_size(txt_path: string): number {
  let gz_st: fs.Stats;
  try {
    gz_st = fs.lstatSync(withName(txt_path, pathStem(txt_path) + _GZ_SUFFIX));
  } catch {
    return 0;
  }
  if (gz_st.isSymbolicLink()) {
    return 0;
  }
  return Math.trunc(gz_st.size);
}

// ---------------------------------------------------------------------------
// evict_cache_dir
// ---------------------------------------------------------------------------

/**
 * Evict the oldest `.txt` entries from a cache directory until the total
 * on-disk size is at or under `max_total_bytes` AND the file count is at or
 * under `max_file_count`. Returns the number of body (`.txt`) files removed.
 */
export function evict_cache_dir(opts: {
  cache_dir_fn: CacheDirFn;
  log_name: string;
  max_total_bytes: number;
  max_file_count?: number;
  protect_ids?: ReadonlySet<string> | undefined;
}): number {
  const {
    cache_dir_fn,
    log_name,
    max_total_bytes,
    max_file_count = 4096,
    protect_ids,
  } = opts;

  const _log = getLogger(log_name);

  let d: string;
  try {
    d = cache_dir_fn();
  } catch {
    return 0;
  }

  // Scan phase: collect [path, mtime, size] for every valid .txt body.
  const entries: Array<[string, number, number]> = [];
  let total = 0;
  try {
    for (const entryName of fs.readdirSync(d)) {
      if (!entryName.endsWith(".txt")) {
        continue;
      }
      if (!OUTPUT_FILENAME_RE.test(entryName)) {
        continue;
      }
      const fp = path.join(d, entryName);
      let st: fs.Stats;
      try {
        st = fs.lstatSync(fp);
      } catch {
        continue;
      }
      if (st.isSymbolicLink()) {
        _log.warning("%s: skipping symlink in cache dir: %s", log_name, entryName);
        continue;
      }
      // A gzip-compressed entry keeps its real bytes in a `<id>.gz` sibling
      // behind a 0-byte `<id>.txt` stub; attribute the sibling's size to its
      // owning entry so the byte cap sees the bytes actually on disk.
      const entry_size = Math.trunc(st.size) + gz_companion_size(fp);
      entries.push([fp, statMtimeSeconds(st), entry_size]);
      total += entry_size;
    }
  } catch {
    return 0;
  }

  // Orphan-companion sweep — a `.json` sidecar or `.gz` body whose `.txt` stub
  // was deleted out-of-band would otherwise live forever. Sweep BEFORE the
  // early-return so orphans are cleaned even when both caps are satisfied. Only
  // touch files whose names we would have generated.
  try {
    for (const spName of fs.readdirSync(d)) {
      let companion_kind: string;
      if (spName.endsWith(".json")) {
        companion_kind = "sidecar";
      } else if (spName.endsWith(_GZ_SUFFIX)) {
        companion_kind = "gz body";
      } else {
        continue;
      }
      const sp = path.join(d, spName);
      const body_name = pathStem(sp) + ".txt";
      if (!OUTPUT_FILENAME_RE.test(body_name)) {
        continue;
      }
      const body = withName(sp, body_name);
      if (fs.existsSync(body)) {
        continue;
      }
      try {
        // missing_ok=True handles the concurrent-delete race.
        if (fs.existsSync(sp)) {
          fs.unlinkSync(sp);
        }
      } catch (exc) {
        _log.debug(
          "%s: orphan %s removal failed: %s: %s",
          log_name,
          companion_kind,
          spName,
          exc,
        );
      }
    }
  } catch {
    // pass
  }

  if (total <= max_total_bytes && entries.length <= max_file_count) {
    _log.debug(
      "%s: eviction skipped (within limits): %s KB / %s KB, %d / %d files",
      log_name,
      (total / 1024).toFixed(1),
      (max_total_bytes / 1024).toFixed(1),
      entries.length,
      max_file_count,
    );
    return 0;
  }

  // Stable oldest-first sort by mtime (Array.prototype.sort is stable in V8,
  // matching Python's stable sort).
  entries.sort((a, b) => a[1] - b[1]);
  let remaining = entries.length;
  let removed = 0;
  for (const [fp, , size] of entries) {
    if (total <= max_total_bytes && remaining <= max_file_count) {
      break;
    }
    // MRU protection: never evict an id the caller just wrote.
    if (protect_ids && protect_ids.has(pathStem(fp))) {
      continue;
    }
    // Concurrent-eviction safety: only adjust accounting when *our* unlink
    // succeeds; an OSError (e.g. ENOENT from a racing process) skips the entry.
    try {
      fs.unlinkSync(fp);
      total -= size;
      remaining -= 1;
      removed += 1;
    } catch {
      continue;
    }
    const sidecar = sidecar_path_for(fp);
    try {
      fs.unlinkSync(sidecar);
    } catch (exc) {
      if ((exc as NodeJS.ErrnoException).code === "ENOENT") {
        // already removed by a concurrent eviction pass — harmless
      } else {
        _log.debug("%s: sidecar cleanup failed for %s: %s", log_name, pathName(sidecar), exc);
      }
    }
    // Free the compressed body too.
    const gz_sibling = withName(fp, pathStem(fp) + _GZ_SUFFIX);
    try {
      fs.unlinkSync(gz_sibling);
    } catch (exc) {
      if ((exc as NodeJS.ErrnoException).code === "ENOENT") {
        // uncompressed entry, or already removed by a concurrent pass
      } else {
        _log.debug("%s: gz body cleanup failed for %s: %s", log_name, pathName(gz_sibling), exc);
      }
    }
  }
  if (removed) {
    _log.info(
      "%s: evicted %d entries (bytes cap=%d, count cap=%d)",
      log_name,
      removed,
      max_total_bytes,
      max_file_count,
    );
  }

  return removed;
}

// ---------------------------------------------------------------------------
// load_sidecar_json / write_sidecar_metadata
// ---------------------------------------------------------------------------

/**
 * Load and validate a JSON sidecar file, returning a record or null.
 *
 * Returns null when the file is absent, unreadable, contains malformed JSON, or
 * has a top-level type other than an object (not array / not null).
 */
export function load_sidecar_json(p: string): Record<string, unknown> | null {
  if (!fs.existsSync(p)) {
    return null;
  }
  let data: unknown;
  try {
    data = JSON.parse(fs.readFileSync(p, "utf8"));
  } catch {
    return null;
  }
  if (typeof data !== "object" || data === null || Array.isArray(data)) {
    return null;
  }
  return data as Record<string, unknown>;
}

/**
 * Persist `meta` as a JSON sidecar at `sidecar_path`.
 *
 * `meta` is the already-dict-shaped metadata payload (the Python `asdict(meta)`
 * was done before the json.dumps; in TS the caller passes a plain object). A
 * null sidecar_path is a no-op; OSError is logged at debug and swallowed.
 */
export function write_sidecar_metadata(
  sidecar_path: string | null,
  meta: Record<string, unknown>,
  opts: {
    log: { debug: (msg: string, ...args: unknown[]) => void };
    log_prefix: string;
  },
): void {
  if (sidecar_path === null) {
    return;
  }
  try {
    const _paths = pathsModule();
    // json.dumps(..., ensure_ascii=False) → JSON.stringify (UTF-8, non-ASCII
    // preserved). Python omits separators-spacing differences are irrelevant
    // for the round-trip; JSON.stringify with no spacing matches dumps default
    // separator behaviour closely enough (both produce compact `{"k": v}` —
    // Python uses ", "/": " separators; the on-disk text is only consumed by
    // load_sidecar_json which re-parses, so exact spacing is not load-bearing).
    _paths.atomicWriteText(sidecar_path, JSON.stringify(meta));
  } catch (exc) {
    if (isOSError(exc)) {
      const output_id =
        typeof meta["output_id"] === "string" ? meta["output_id"] : "?";
      opts.log.debug(
        "%s: sidecar write failed for %s: %s",
        opts.log_prefix,
        output_id,
        exc,
      );
    } else {
      throw exc;
    }
  }
}

// ---------------------------------------------------------------------------
// find_markdown_boundary / truncate_tail_preserve
// ---------------------------------------------------------------------------

/**
 * Return the best cut index within `text[:max_chars]` at a markdown boundary.
 *
 * Strategy: last `\n#` heading ≥ min_keep → cut before the `#`; else last
 * `\n\n` paragraph break ≥ min_keep → cut after it; else last `\n` ≥ min_keep →
 * cut after it; else max_chars (hard cut). Operates on JS string indices, which
 * are UTF-16 code units; the Python original sliced on `str` code points, but
 * the markers searched for (`\n`, `#`) are ASCII so the rfind positions agree
 * for any input (a higher astral char before the marker shifts both Python and
 * JS indices identically relative to the slice the caller then takes).
 */
export function find_markdown_boundary(
  text: string,
  max_chars: number,
  opts?: { min_keep?: number },
): number {
  const min_keep = opts?.min_keep ?? 128;
  const window = text.slice(0, max_chars);

  // Priority 1: last '\n#' whose cut position is at or beyond min_keep.
  const heading_pos = window.lastIndexOf("\n#");
  if (heading_pos >= min_keep) {
    return heading_pos + 1;
  }

  // Priority 2: last blank line (paragraph break) at a useful position.
  const para_pos = window.lastIndexOf("\n\n");
  if (para_pos >= min_keep) {
    return para_pos + 2;
  }

  // Priority 3: last plain newline at a useful position.
  const nl_pos = window.lastIndexOf("\n");
  if (nl_pos >= min_keep) {
    return nl_pos + 1;
  }

  // Fallback: hard cut at max_chars.
  return max_chars;
}

/**
 * Tail-preserve `content` if its utf-8 byte length exceeds `max_bytes`.
 *
 * Returns `[stored, was_truncated]`. When the content fits, returns it unchanged
 * and false. When it doesn't, returns the trailing portion whose utf-8 byte
 * length is at or under `max_bytes` with `marker_template` prepended, and true.
 * The slice is computed on raw UTF-8 bytes (never code units); the start is
 * advanced past any leading continuation bytes (0x80–0xBF) so a mid-codepoint
 * cut never leaves a stray byte, then decoded.
 */
export function truncate_tail_preserve(
  content: string,
  max_bytes: number,
  opts: { marker_template: string },
): [string, boolean] {
  const encoded = Buffer.from(content, "utf8");
  const body_bytes = encoded.length;
  if (body_bytes <= max_bytes) {
    return [content, false];
  }
  let keep_bytes = encoded.subarray(encoded.length - max_bytes);
  // Advance past leading continuation bytes (high bits 10xxxxxx, i.e. 0x80..0xBF)
  // so the kept region starts on a valid codepoint boundary.
  let skip = 0;
  while (skip < keep_bytes.length && (keep_bytes[skip]! & 0xc0) === 0x80) {
    skip += 1;
  }
  if (skip) {
    keep_bytes = keep_bytes.subarray(skip);
  }
  const keep = keep_bytes.toString("utf8");
  const marker = opts.marker_template
    .replace(/\{n\}/g, String(max_bytes))
    .replace(/\{total\}/g, String(body_bytes));
  return [marker + keep, true];
}

// ---------------------------------------------------------------------------
// safe_session_fragment
// ---------------------------------------------------------------------------

/** Return a filesystem-safe 16-character prefix of `session_id`. */
export function safe_session_fragment(session_id: string): string {
  const replaced = session_id.replace(_SESSION_UNSAFE_RE, "_").slice(0, 16);
  return replaced || "anon";
}

// ---------------------------------------------------------------------------
// safe_join_output_id / store_blob / short_output_id
// ---------------------------------------------------------------------------

/**
 * Validate `output_id` and return the corresponding `<id>.txt` path, or null.
 *
 * Returns null (with a warning log) when the ID is malformed (traversal,
 * embedded null byte, invalid chars) or — on Windows only — when the resulting
 * path reaches MAX_PATH (>= 260 chars).
 */
export function safe_join_output_id(
  output_id: string,
  cache_dir_fn: CacheDirFn,
  log_name: string,
): string | null {
  if (!output_id) {
    return null;
  }
  const _log = getLogger(log_name);
  const name = `${output_id}.txt`;
  if (!OUTPUT_FILENAME_RE.test(name)) {
    _log.warning("%s: rejected output_id with invalid chars: %s", log_name, JSON.stringify(output_id.slice(0, 200)));
    return null;
  }
  const base = path.resolve(cache_dir_fn());
  const candidate = path.resolve(path.join(base, name));
  // Containment check (Python's candidate.relative_to(base) raising ValueError).
  if (candidate !== base && !candidate.startsWith(base + path.sep)) {
    _log.warning("%s: rejected output_id escaping base dir: %s", log_name, JSON.stringify(output_id.slice(0, 200)));
    return null;
  }
  // Windows MAX_PATH guard.
  if (process.platform === "win32" && candidate.length >= 260) {
    _log.warning(
      "%s: rejected output_id — resulting path exceeds Windows MAX_PATH (260 chars): len=%d path=%s",
      log_name,
      candidate.length,
      JSON.stringify(candidate.slice(0, 260)),
    );
    return null;
  }
  return candidate;
}

/** Validate `output_id`, write `body` atomically, and return the path or null. */
export function store_blob(
  output_id: string,
  body: string,
  cache_dir_fn: CacheDirFn,
  log_name: string,
): string | null {
  const _paths = pathsModule();
  const p = safe_join_output_id(output_id, cache_dir_fn, log_name);
  if (p === null) {
    return null;
  }
  _paths.atomicWriteText(p, body);
  return p;
}

/** Return the display form of `output_id`: `…<last8>` (13 chars total). */
export function short_output_id(output_id: string): string {
  if (output_id.length <= 8) {
    return output_id;
  }
  return `…${output_id.slice(-8)}`;
}

// ---------------------------------------------------------------------------
// load_output_text / load_output_meta_stat / list_cache_outputs
// ---------------------------------------------------------------------------

/**
 * Return the cached output body for `output_id`, or null if absent.
 *
 * Accepts both full ids and trailing 8-char suffixes. When the exact file is
 * not found, scans the cache directory for any file whose stem ends with
 * `output_id` (case-insensitive); exactly one match is loaded, zero or multiple
 * return null.
 */
export function load_output_text(
  output_id: string,
  cache_dir_fn: CacheDirFn,
  log_name: string,
): string | null {
  const _log = getLogger(log_name);
  let p = safe_join_output_id(output_id, cache_dir_fn, log_name);
  if (p === null) {
    return null;
  }
  if (!fs.existsSync(p)) {
    // Suffix fallback: allow short (8-char) ids as rendered in hints.
    const base = cache_dir_fn();
    let baseIsDir = false;
    try {
      baseIsDir = fs.statSync(base).isDirectory();
    } catch {
      baseIsDir = false;
    }
    if (baseIsDir) {
      const suffix = output_id.toLowerCase();
      const matches: string[] = [];
      for (const entryName of fs.readdirSync(base)) {
        if (pathSuffix(entryName) !== ".txt") {
          continue;
        }
        if (!OUTPUT_FILENAME_RE.test(entryName)) {
          continue;
        }
        if (pathStem(entryName).toLowerCase().endsWith(suffix)) {
          matches.push(path.join(base, entryName));
        }
      }
      if (matches.length === 1) {
        p = matches[0]!;
      } else if (matches.length > 1) {
        _log.warning(
          "%s: ambiguous suffix %s matches %d entries; pass a longer id",
          log_name,
          JSON.stringify(output_id.slice(0, 200)),
          matches.length,
        );
        return null;
      } else {
        return null;
      }
    }
  }
  try {
    return fs.readFileSync(p, "utf8");
  } catch (exc) {
    _log.warning("%s: load failed for %s: %s", log_name, output_id.slice(0, 200), exc);
    return null;
  }
}

/** Return stat-derived metadata for an output file (size, mtime), or null. */
export function load_output_meta_stat(
  output_id: string,
  cache_dir_fn: CacheDirFn,
  log_name: string,
): OutputStatDict | null {
  const p = safe_join_output_id(output_id, cache_dir_fn, log_name);
  if (p === null || !fs.existsSync(p)) {
    return null;
  }
  let st: fs.Stats;
  try {
    st = fs.statSync(p);
  } catch {
    return null;
  }
  return {
    output_id,
    // True on-disk footprint: the `.txt` stub plus its `.gz` sibling, if any.
    size_bytes: Math.trunc(st.size) + gz_companion_size(p),
    mtime: statMtimeSeconds(st),
  };
}

/** Return metadata for every cached output in `cache_dir_fn()`, newest first. */
export function list_cache_outputs(cache_dir_fn: CacheDirFn): OutputStatDict[] {
  let d: string;
  try {
    d = cache_dir_fn();
  } catch {
    return [];
  }

  const results: OutputStatDict[] = [];
  try {
    for (const entryName of fs.readdirSync(d)) {
      if (!entryName.endsWith(".txt")) {
        continue;
      }
      if (!OUTPUT_FILENAME_RE.test(entryName)) {
        continue;
      }
      const fp = path.join(d, entryName);
      let st: fs.Stats;
      try {
        st = fs.statSync(fp);
      } catch {
        continue;
      }
      results.push({
        output_id: pathStem(fp),
        // On-disk footprint includes the `.gz` sibling for compressed entries.
        size_bytes: Math.trunc(st.size) + gz_companion_size(fp),
        mtime: statMtimeSeconds(st),
      });
    }
  } catch {
    return results;
  }

  // newest first (stable sort by mtime descending).
  results.sort((a, b) => (b.mtime ?? 0) - (a.mtime ?? 0));
  return results;
}

// ---------------------------------------------------------------------------
// store_blob_gz / load_blob_gz
// ---------------------------------------------------------------------------

/**
 * Write `text` gzip-compressed to the cache directory; also write an empty
 * `output_id.txt` stub so the entry is discoverable by list_cache_outputs and
 * subject to LRU eviction. Returns the `.gz` path on success, or null on error.
 */
export function store_blob_gz(
  output_id: string,
  text: string,
  cache_dir_fn: CacheDirFn,
  log_name: string,
): string | null {
  const _paths = pathsModule();
  const _log = getLogger(log_name);

  const result = safe_cache_op("store_blob_gz", { log: _log }, () => {
    const out_dir = cache_dir_fn();
    const gz_path = path.join(out_dir, output_id + _GZ_SUFFIX);
    try {
      const raw_bytes = Buffer.from(text, "utf8");
      const compressed = gzipSync(raw_bytes, { level: _GZ_LEVEL });
      _paths.atomicWriteBytes(gz_path, compressed);
      _log.debug(
        "store_blob_gz: wrote %s (%d bytes raw -> %d compressed)",
        pathName(gz_path),
        raw_bytes.length,
        compressed.length,
      );
    } catch (exc) {
      if (isOSError(exc)) {
        _log.debug("store_blob_gz: failed to write %s: %s", output_id, exc);
        return null;
      }
      throw exc;
    }

    // Write an empty .txt stub so list/evict can discover this entry.
    const stub_result = store_blob(output_id, "", cache_dir_fn, log_name);
    if (stub_result === null) {
      _log.debug("store_blob_gz: stub write failed for %s", output_id);
      // Clean up the gz file so we don't leave an orphaned compressed file.
      try {
        fs.unlinkSync(gz_path);
      } catch {
        // suppress(OSError)
      }
      return null;
    }

    return gz_path;
  });

  // safe_cache_op returns undefined when it suppressed an OSError → null.
  return result === undefined ? null : result;
}

/** Return the decompressed text for a gzip-compressed cache entry, or null. */
export function load_blob_gz(
  output_id: string,
  cache_dir_fn: CacheDirFn,
  log_name: string,
): string | null {
  const _log = getLogger(log_name);
  const out_dir = cache_dir_fn();
  const gz_path = path.join(out_dir, output_id + _GZ_SUFFIX);
  let isFile = false;
  try {
    isFile = fs.statSync(gz_path).isFile();
  } catch {
    isFile = false;
  }
  if (!isFile) {
    return null;
  }
  try {
    const raw = fs.readFileSync(gz_path);
    return gunzipSync(raw).toString("utf8");
  } catch (exc) {
    _log.debug("load_blob_gz: failed to decompress %s: %s", pathName(gz_path), exc);
    return null;
  }
}
