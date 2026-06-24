/**
 * Read-replacement: return just a symbol's source instead of the whole file.
 *
 * Faithful port of src/token_goat/read_replacement.py.
 *
 * Parity notes (Python -> TS):
 *  - Python's `db.open_project(hash)` is a context manager; the TS db.ts exposes
 *    `openProject(hash, (conn) => ...)` as a callback HOF that closes the
 *    connection in a finally. Every `with db.open_project(...) as conn:` body in
 *    the Python source is reproduced as a callback passed to db.openProject so
 *    the close contract holds and tests can spy on the db namespace.
 *  - Python `Project.root` is a `pathlib.Path`; the TS Project (project.ts) has
 *    `root: string`. `project.root / rel_path` becomes `path.join(project.root,
 *    rel_path)`, and `abs_path.resolve().relative_to(project.root.resolve())`
 *    becomes a posix-prefix containment test via path.resolve.
 *  - Byte math is UTF-8 via util.utf8Bytes (Buffer.byteLength), never
 *    String.length, so bytes_total/bytes_extracted/bytes_saved are byte-identical
 *    to Python's `len(s.encode("utf-8"))`.
 *  - UTF-8 BOM handling: Python read with encoding="utf-8-sig" strips a leading
 *    BOM. util.stripBOM reproduces that.
 *  - sqlite3.Row column access -> better-sqlite3 returns plain objects; named
 *    column access works directly.
 *
 * `verbatimModuleSyntax` is on -> type-only imports use `import type`.
 * `exactOptionalPropertyTypes` is on -> optional fields are `T | undefined`.
 * `noUncheckedIndexedAccess` is on -> array/record accesses are narrowed.
 */

import fs from "node:fs";
import path from "node:path";

import type { Database as DatabaseType } from "better-sqlite3";

import type { Project } from "./project.js";
import type { SymbolResult, SectionResult, LineRangeResult } from "./types.js";

import * as db from "./db.js";
import { isSafeRelPath as _is_safe_rel_path } from "./paths.js";
import { getLogger, utf8Bytes, stripBOM } from "./util.js";
import { registerReset } from "./reset.js";

export const __all__ = [
  "AmbiguousFileMatch",
  "LineRangeResult",
  "ProjectIndexUnavailable",
  "ReadLookupError",
  "SectionResult",
  "SymbolResult",
  "find_in_all_projects",
  "format_callers_footer",
  "invalidate_file_cache",
  "parse_line_range",
  "read_line_range",
  "read_section",
  "read_symbol",
  "resolve_file_rel",
  "truncate_symbol_body",
  "token_estimate_header",
] as const;

// Re-export the snake_case `_is_safe_rel_path` the Python test imports from
// read_replacement (it is re-exported there from token_goat.paths).
export { _is_safe_rel_path };

// Maximum file size allowed for symbol/section extraction.  Mirrors parser.MAX_FILE_SIZE
// (2 MB) so a file that grew after indexing cannot cause an unbounded in-memory read
// when the caller requests a slice from it.  Defined here as a local constant to avoid
// importing the heavy parser module (tree-sitter, language grammars) at CLI startup time.
const _MAX_READ_BYTES = 2_000_000; // 2 MB - keep in sync with parser.MAX_FILE_SIZE

// Maximum length accepted for symbol names and section headings supplied by the
// caller (CLI args or harness payload).  Real identifiers are bounded by language
// specs (Python/JS: ~256 chars; Go: no explicit limit but convention is short);
// anything beyond 1 KiB is anomalous and must not be forwarded to a DB query or
// log message as an unbounded heap allocation.
export const _MAX_SYMBOL_LEN: number = 1_024; // 1 KiB

// Maximum number of LIKE pattern matches to return in _resolve_file_rel_db.
// Prevents unbounded memory allocation when querying bare extensions (e.g., ".py")
// against projects with many files.
export const _LIKE_MATCH_LIMIT: number = 50;

const _LOG = getLogger("read_replacement");

// Re-export the TypedDict shapes from types.ts under their snake_case names so
// callers importing `{ SymbolResult }` from this module continue to work.
export type { SymbolResult, SectionResult, LineRangeResult };

// Regex matching the ``start-end`` line-range suffix, e.g. ``100-200``.
// Both numbers are required; ``start`` must be >= 1; ``end`` >= ``start`` is
// validated at runtime.  The pattern is anchored so ``read_symbol`` fallback
// for names like ``MY-CONST`` is not mis-parsed as a range.
const _LINE_RANGE_RE = /^(\d+)-(\d+)$/;

/**
 * Return ``(start, end)`` when *item* matches ``"N-M"`` syntax, else ``null``.
 *
 * Validates that both numbers are positive integers and that start <= end.
 * A match of ``"0-5"`` returns ``null`` because line numbers are 1-based.
 */
export function parse_line_range(item: string): [number, number] | null {
  const m = _LINE_RANGE_RE.exec(item);
  if (m === null) {
    return null;
  }
  const start = parseInt(m[1]!, 10);
  const end = parseInt(m[2]!, 10);
  if (start < 1 || end < start) {
    return null;
  }
  return [start, end];
}

/**
 * Return the lines ``start``..``end`` (1-based, inclusive) from *rel_path*.
 *
 * Returns a LineRangeResult or ``null`` when the file cannot be read or the
 * requested range is entirely outside the file's line count.  The range is
 * clamped to ``[1, total_lines]``.
 */
export function read_line_range(
  project: Project,
  rel_path: string,
  start: number,
  end: number,
): LineRangeResult | null {
  const t0 = _monotonic();
  const read_result = _read_file_lines(path.join(project.root, rel_path));
  if (read_result === null) {
    _LOG.debug(
      `read_line_range: cannot read file ${rel_path} in project ${project.hash.slice(0, 8)}`,
    );
    return null;
  }
  const [lines, full_bytes] = read_result;

  const safe_start = Math.max(1, start);
  const safe_end = Math.min(lines.length, end);
  if (safe_start > lines.length) {
    _LOG.debug(
      `read_line_range: start=${start} beyond file length=${lines.length} in ${rel_path}`,
    );
    return null;
  }

  const snippet = lines.slice(safe_start - 1, safe_end).join("\n");
  const snippet_bytes = utf8Bytes(snippet).length;
  const elapsed = _monotonic() - t0;
  _LOG.debug(
    `read_line_range: ${rel_path} lines ${safe_start}-${safe_end}, ${snippet_bytes}/${full_bytes} bytes extracted (${_pct_saved(snippet_bytes, full_bytes).toFixed(1)}% saved, ${elapsed.toFixed(3)}s)`,
  );
  return {
    file: rel_path,
    start_line: safe_start,
    end_line: safe_end,
    text: snippet,
    bytes_total: full_bytes,
    bytes_extracted: snippet_bytes,
    bytes_saved: Math.max(0, full_bytes - snippet_bytes),
  };
}

// Lower value = higher priority when multiple symbols share the same name.
// The ordering reflects "most likely what the user meant" when names collide:
// a top-level class/interface is more structural than a free function, which
// is more likely to be the target than a method of the same name nested inside
// some unrelated class.  Variables and constants lose to everything else because
// they are rarely the object of a surgical read; headings rank alongside type/enum
// since they serve the same structural role in prose files.
const _KIND_PRIORITY: Record<string, number> = {
  class: 0,
  interface: 1,
  trait: 1,
  type: 2,
  enum: 2,
  function: 3,
  method: 4,
  const: 5,
  var: 6,
  heading: 2,
};

/**
 * Return *val* as int, or *default* when *val* is not an int.
 *
 * DB row columns retrieved via better-sqlite3 are typed as ``unknown``; this
 * helper centralises the ``int(x) if x is not None else default`` idiom.
 */
function _coerce_line(val: unknown, def: number): number {
  if (typeof val === "number" && Number.isInteger(val)) {
    return val;
  }
  if (typeof val === "bigint") {
    return Number(val);
  }
  return def;
}

/**
 * Return *val* as int, or null when *val* is not an int.
 *
 * Companion to _coerce_line for the end_line DB column, which may be NULL
 * (null) when only the start line is known.
 */
function _coerce_end_line(val: unknown): number | null {
  if (typeof val === "number" && Number.isInteger(val)) {
    return val;
  }
  if (typeof val === "bigint") {
    return Number(val);
  }
  return null;
}

/**
 * Validate the common preamble shared by read_symbol and read_section.
 *
 * Both functions begin with the same two guards:
 * 1. Reject unsafe relative paths (path traversal).
 * 2. Reject oversized name/heading strings (unbounded heap allocation).
 */
function _validate_lookup_args(caller: string, rel_path: string, name: string): boolean {
  if (!_is_safe_rel_path(rel_path)) {
    _LOG.warning(`${caller}: rejected unsafe rel_path: ${rel_path}`);
    return false;
  }
  if (name.length > _MAX_SYMBOL_LEN) {
    _LOG.warning(
      `${caller}: name/heading too long (${name.length} chars > ${_MAX_SYMBOL_LEN} limit); rejecting`,
    );
    return false;
  }
  return true;
}

/** Structured read-resolution failure. */
export class ReadLookupError extends Error {
  static readonly code: string = "read_lookup_error";
  code: string = "read_lookup_error";
  constructor(message?: string) {
    super(message);
    this.name = "ReadLookupError";
  }
}

/** Raised when indexed-project metadata cannot be queried safely. */
export class ProjectIndexUnavailable extends ReadLookupError {
  static override readonly code: string = "project_index_unavailable";
  override code: string = "project_index_unavailable";
  detail: string;
  constructor(detail: string) {
    super(detail);
    this.name = "ProjectIndexUnavailable";
    this.detail = detail;
  }
}

/** Raised when a file_part matches multiple indexed paths. */
export class AmbiguousFileMatch extends ReadLookupError {
  static override readonly code: string = "ambiguous_file";
  override code: string = "ambiguous_file";
  file_part: string;
  candidates: readonly string[];
  constructor(file_part: string, candidates: readonly string[]) {
    super(`ambiguous file match for ${file_part}: ${candidates.join(", ")}`);
    this.name = "AmbiguousFileMatch";
    this.file_part = file_part;
    this.candidates = [...candidates];
  }
}

/**
 * Escape SQLite LIKE wildcards (%, _) so file names are matched literally.
 */
export function _escape_like_pattern(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/%/g, "\\%").replace(/_/g, "\\_");
}

// ---------------------------------------------------------------------------
// File-resolution cache (item 8)
// ---------------------------------------------------------------------------
// Bounded in-process cache for (project_hash, normalized_file_part) -> rel_path.
// Keyed on project_hash so invalidation per project is O(n) on cache size.
// AmbiguousFileMatch results are never cached - callers see the exception each time.
// Max 512 entries; evict oldest 128 when full (simple FIFO - LRU not needed here).
//
// Cache values are `string` (a resolved rel_path) or `null` (confirmed not found
// in this project's DB).  We need a third state - "not yet cached" - that is
// distinct from both of those.  _CACHE_MISS is that sentinel.
//
// A JS Map preserves insertion order (like a Python 3.7+ dict), and a tuple key
// has no value identity in JS, so we encode the (project_hash, file_part) pair
// as a single delimited string key.  The delimiter is "\x00" which cannot appear
// in a project hash (hex) or a (null-byte-rejected) file_part.

function _cacheKey(project_hash: string, file_part: string): string {
  return `${project_hash}\x00${file_part}`;
}

let _RESOLVE_CACHE = new Map<string, string | null>();
const _RESOLVE_CACHE_MAX = 512;
const _RESOLVE_CACHE_EVICT = 128;
export { _RESOLVE_CACHE_MAX, _RESOLVE_CACHE_EVICT };

/** Read-only accessor for the resolve cache (tests inspect membership/size). */
export function _RESOLVE_CACHE_obj(): Map<string, string | null> {
  return _RESOLVE_CACHE;
}

// Sentinel returned by _resolve_cache_lookup when the key is absent from the cache.
// Distinct from null so callers can tell "not cached yet" apart from "cached as
// not found".  A unique frozen object provides `is`-style identity comparison.
export const _CACHE_MISS: unique symbol = Symbol("CACHE_MISS");
export type _CacheMissSentinel = typeof _CACHE_MISS;

/**
 * Return the cached rel_path, null (confirmed-not-found), or _CACHE_MISS (absent).
 *
 * Callers should check ``result === _CACHE_MISS`` to detect a cache miss.
 */
export function _resolve_cache_lookup(
  project_hash: string,
  file_part: string,
): string | null | _CacheMissSentinel {
  const key = _cacheKey(project_hash, file_part);
  const has = _RESOLVE_CACHE.has(key);
  if (!has) {
    _LOG.debug(
      `resolve_cache miss: project=${project_hash.slice(0, 8)} file=${JSON.stringify(file_part)} cache_size=${_RESOLVE_CACHE.size}`,
    );
    return _CACHE_MISS;
  }
  const result = _RESOLVE_CACHE.get(key) as string | null;
  _LOG.debug(
    `resolve_cache hit: project=${project_hash.slice(0, 8)} file=${JSON.stringify(file_part)} -> ${JSON.stringify(result)} cache_size=${_RESOLVE_CACHE.size}`,
  );
  return result;
}

/**
 * Store a file-resolution result in the in-process cache.
 *
 * If cache is full (512 entries), evicts 128 oldest entries (FIFO).
 */
export function _resolve_cache_put(
  project_hash: string,
  file_part: string,
  rel_path: string | null,
): void {
  const key = _cacheKey(project_hash, file_part);
  if (_RESOLVE_CACHE.has(key)) {
    _RESOLVE_CACHE.set(key, rel_path);
    _LOG.debug(
      `resolve_cache update: project=${project_hash.slice(0, 8)} file=${JSON.stringify(file_part)} -> ${JSON.stringify(rel_path)}`,
    );
    return;
  }
  if (_RESOLVE_CACHE.size >= _RESOLVE_CACHE_MAX) {
    // Evict oldest entries (Map preserves insertion order).
    let evicted = 0;
    for (const k of _RESOLVE_CACHE.keys()) {
      if (evicted >= _RESOLVE_CACHE_EVICT) break;
      _RESOLVE_CACHE.delete(k);
      evicted += 1;
    }
    _LOG.debug(
      `resolve_cache evicted ${_RESOLVE_CACHE_EVICT} entries (project=${project_hash.slice(0, 8)})`,
    );
  }
  _RESOLVE_CACHE.set(key, rel_path);
  _LOG.debug(
    `resolve_cache store: project=${project_hash.slice(0, 8)} file=${JSON.stringify(file_part)} -> ${JSON.stringify(rel_path)} cache_size=${_RESOLVE_CACHE.size}`,
  );
}

/**
 * Remove all cached resolutions for a project. Returns count evicted.
 *
 * Called by the post-edit hook after a file is reindexed so the next lookup
 * gets a fresh result from the DB.
 */
export function invalidate_file_cache(project_hash: string): number {
  const prefix = `${project_hash}\x00`;
  const kept = new Map<string, string | null>();
  for (const [k, v] of _RESOLVE_CACHE) {
    if (!k.startsWith(prefix)) {
      kept.set(k, v);
    }
  }
  const evicted = _RESOLVE_CACHE.size - kept.size;
  _RESOLVE_CACHE = kept;
  if (evicted) {
    _LOG.debug(
      `invalidate_file_cache: evicted ${evicted} resolution(s) for project=${project_hash.slice(0, 8)} (cache_size now=${_RESOLVE_CACHE.size})`,
    );
  } else {
    _LOG.debug(
      `invalidate_file_cache: no cached entries for project=${project_hash.slice(0, 8)} (cache_size=${_RESOLVE_CACHE.size})`,
    );
  }
  return evicted;
}

registerReset(() => {
  _RESOLVE_CACHE.clear();
});

// ---------------------------------------------------------------------------
// Specificity ranking for ambiguous file matches (item 14)
// ---------------------------------------------------------------------------

/**
 * Score how specifically file_part matches rel_path (higher = more specific).
 *
 * Returns [suffix_match_len, neg_path_depth] as a tuple for sort comparison.
 */
export function _match_specificity(file_part: string, rel_path: string): [number, number] {
  const fp_parts = file_part.replace(/\\/g, "/").split("/");
  const rp_parts = rel_path.split("/");
  // Count how many trailing components of rel_path match the full file_part
  let suffix_len = 0;
  const reversed = [...fp_parts].reverse();
  for (let i = 0; i < reversed.length; i++) {
    const part = reversed[i]!;
    const rp_idx = rp_parts.length - 1 - i;
    if (rp_idx < 0 || rp_parts[rp_idx] !== part) {
      break;
    }
    suffix_len += 1;
  }
  return [suffix_len, -rp_parts.length];
}

/** Compare two [int, int] tuples lexicographically. */
function _tupleCmp(a: [number, number], b: [number, number]): number {
  if (a[0] !== b[0]) return a[0] - b[0];
  return a[1] - b[1];
}

/**
 * Return the single best match by specificity, or null if ambiguous.
 *
 * Returns null when two or more candidates tie for the highest specificity
 * score, so callers can raise AmbiguousFileMatch with the full candidate list.
 */
export function _pick_best_match(file_part: string, candidates: string[]): string | null {
  if (candidates.length === 0) {
    return null;
  }
  if (candidates.length === 1) {
    return candidates[0]!;
  }
  // Score every candidate once upfront, then sort by score descending.
  const scored: Array<[string, [number, number]]> = candidates.map((r) => [
    r,
    _match_specificity(file_part, r),
  ]);
  scored.sort((a, b) => _tupleCmp(b[1], a[1]));
  if (_tupleCmp(scored[1]![1], scored[0]![1]) === 0) {
    return null; // tie -> still ambiguous
  }
  return scored[0]![0];
}

/**
 * Return true when file_part is an absolute path on any platform.
 *
 * Covers POSIX (/foo), Windows drive-letter (C:/foo or C:\\foo), and
 * UNC (//host/share) forms.
 */
function _is_absolute(file_part: string): boolean {
  if (file_part.startsWith("/") || file_part.startsWith("\\")) {
    return true;
  }
  // Windows drive-letter form: X: or X:/ or X:\
  return (
    file_part.length >= 2 &&
    file_part[1] === ":" &&
    /[a-zA-Z]/.test(file_part[0]!)
  );
}

/**
 * Given the file part from a 'file::symbol' target, find the matching rel_path.
 *
 * Raises AmbiguousFileMatch when multiple indexed files match file_part at equal
 * specificity.  Results are cached in-process keyed on (project_hash, file_part).
 *
 * Rejects relative paths that contain ``..`` traversal components.  Absolute
 * paths are allowed through; _resolve_file_rel_db resolves them against the
 * project root and enforces containment.
 */
export function resolve_file_rel(project: Project, file_part: string): string | null {
  file_part = file_part.replace(/\\/g, "/").trim();

  // Reject relative-path traversal attempts early.
  if (!_is_absolute(file_part) && file_part.split("/").includes("..")) {
    _LOG.warning(`resolve_file_rel: rejected traversal attempt: ${JSON.stringify(file_part)}`);
    return null;
  }

  // Cache hit - avoids DB round-trips for repeated lookups within same process
  const cached = _resolve_cache_lookup(project.hash, file_part);
  if (cached !== _CACHE_MISS) {
    return cached; // string | null - narrowed away from _CACHE_MISS
  }

  const result = _resolve_file_rel_db(project, file_part);
  _resolve_cache_put(project.hash, file_part, result);
  return result;
}

/** Un-cached DB-backed resolution. Called by resolve_file_rel. */
export function _resolve_file_rel_db(project: Project, file_part: string): string | null {
  return db.openProject(project.hash, (conn: DatabaseType) => {
    // 1. Exact relative match - guard against any traversal that slipped through.
    if (!_is_absolute(file_part) && !_is_safe_rel_path(file_part)) {
      _LOG.warning(`_resolve_file_rel_db: rejected unsafe rel_path: ${JSON.stringify(file_part)}`);
      return null;
    }
    let row = conn
      .prepare("SELECT rel_path FROM files WHERE rel_path = ?")
      .get(file_part) as { rel_path: string } | undefined;
    if (row) {
      return row.rel_path;
    }

    // 2. Absolute path - make it relative to project root
    if (path.isAbsolute(file_part)) {
      try {
        const rootResolved = _safeResolve(project.root);
        const absResolved = _safeResolve(file_part);
        const rel = _relativeTo(absResolved, rootResolved);
        if (rel !== null) {
          row = conn
            .prepare("SELECT rel_path FROM files WHERE rel_path = ?")
            .get(rel) as { rel_path: string } | undefined;
          if (row) {
            return row.rel_path;
          }
        } else {
          // path is not under this project root - expected control flow
          _LOG.debug(
            `_resolve_file_rel_db: absolute path ${file_part} is not under project root ${project.root}`,
          );
        }
      } catch (e) {
        _LOG.debug(
          `resolve_file_rel: could not resolve absolute path ${file_part}: ${String(e)}`,
        );
      }
    }

    // 3. Fast path for path-containing suffixes: try exact-suffix match first.
    if (file_part.includes("/")) {
      row = conn
        .prepare("SELECT rel_path FROM files WHERE rel_path = ?")
        .get(file_part) as { rel_path: string } | undefined;
      if (row) {
        return row.rel_path;
      }
    }

    // 4. Endswith match - handles bare filename or partial path
    const rows = conn
      .prepare("SELECT rel_path FROM files WHERE rel_path LIKE ? ESCAPE '\\' LIMIT ?")
      .all(`%${_escape_like_pattern(file_part)}`, _LIKE_MATCH_LIMIT) as Array<{
      rel_path: string;
    }>;
    if (rows.length === 0) {
      return null;
    }
    if (rows.length === 1) {
      return rows[0]!.rel_path;
    }

    // 5. Multiple candidates - try to pick the most specific one before raising
    const candidate_paths = rows.map((r) => r.rel_path);
    const best = _pick_best_match(file_part, candidate_paths);
    if (best !== null) {
      _LOG.debug(
        `ambiguity resolved by specificity in ${project.hash.slice(0, 8)} for ${file_part} -> ${best}`,
      );
      return best;
    }

    const candidates = [...candidate_paths].sort();
    _LOG.debug(
      `ambiguous file match in ${project.hash.slice(0, 8)} for ${file_part}: ${candidates.join(", ")}`,
    );
    throw new AmbiguousFileMatch(file_part, candidates);
  });
}

/** Resolve a path string the way Python's Path.resolve() would (best-effort). */
function _safeResolve(p: string): string {
  try {
    return fs.realpathSync(p);
  } catch {
    return path.resolve(p);
  }
}

/**
 * Return the posix-form relative path of `target` under `base`, or null when
 * `target` is not contained in `base` (mirrors Path.relative_to raising
 * ValueError). Equivalent to Python's `.relative_to(...).as_posix()`.
 */
function _relativeTo(target: string, base: string): string | null {
  const rel = path.relative(base, target);
  if (rel === "" || rel.startsWith("..") || path.isAbsolute(rel)) {
    return rel === "" ? "" : null;
  }
  return rel.split(path.sep).join("/");
}

/**
 * Search every indexed project for a file matching file_part.
 *
 * Returns ``[project, rel_path]`` for the best unambiguous match, or ``null``.
 */
export function find_in_all_projects(file_part: string): [Project, string] | null {
  let rows: Array<{
    hash: string;
    root: string;
    marker: string;
    last_seen: number | null;
  }>;
  try {
    rows = db.openGlobalReadonly((gconn: DatabaseType) => {
      return gconn
        .prepare("SELECT hash, root, marker, last_seen FROM projects")
        .all() as Array<{ hash: string; root: string; marker: string; last_seen: number | null }>;
    });
  } catch (exc) {
    if (_isFileNotFound(exc)) {
      return null;
    }
    if (_isOSorSqliteError(exc)) {
      _LOG.warning(`find_in_all_projects: global DB unavailable: ${String(exc)}`);
      throw new ProjectIndexUnavailable(
        "Project index database is unavailable. Run `token-goat index --full` again.",
      );
    }
    _LOG.warning(
      `find_in_all_projects: unexpected error opening global DB (${_excName(exc)}: ${String(exc)}); skipping cross-project lookup`,
    );
    return null;
  }

  _LOG.debug(
    `find_in_all_projects: searching ${rows.length} indexed project(s) for ${JSON.stringify(file_part)}`,
  );
  // matches carry the last_seen timestamp for tie-breaking.
  const matches: Array<[Project, string, number]> = []; // [project, rel_path, last_seen]
  // Formatted as "{project_hash_prefix}:{rel_path}" for error messages.
  const cross_project_candidates: string[] = [];
  const project_errors: string[] = [];
  for (const row of rows) {
    const proj: Project = { root: row.root, hash: row.hash, marker: row.marker };
    const last_seen: number = row.last_seen !== null ? Number(row.last_seen) : 0;
    let rel: string | null;
    try {
      rel = resolve_file_rel(proj, file_part);
    } catch (exc) {
      if (exc instanceof AmbiguousFileMatch) {
        for (const rel_path of exc.candidates) {
          cross_project_candidates.push(`${proj.hash.slice(0, 8)}:${rel_path}`);
        }
        continue;
      }
      if (_isFileNotFound(exc) || _isOSorSqliteError(exc) || exc instanceof RangeError) {
        _LOG.warning(
          `find_in_all_projects: resolve failed for project ${proj.hash.slice(0, 8)} (${String(exc)})`,
        );
        project_errors.push(`${proj.hash.slice(0, 8)}: ${String(exc)}`);
        continue;
      }
      throw exc;
    }
    if (rel !== null) {
      matches.push([proj, rel, last_seen]);
    }
  }
  if (matches.length === 1) {
    const [proj, rel] = matches[0]!;
    _LOG.debug(`find_in_all_projects: found ${JSON.stringify(rel)} in project ${proj.hash.slice(0, 8)}`);
    return [proj, rel];
  }
  if (matches.length > 1 && cross_project_candidates.length === 0) {
    // Multiple projects each have a single unambiguous match.  If all of them
    // resolve to the same relative path, pick the most recently indexed project.
    const rel_paths = new Set(matches.map(([, rel]) => rel));
    if (rel_paths.size === 1) {
      let best = matches[0]!;
      for (const m of matches) {
        if (m[2] > best[2]) best = m;
      }
      const [proj, rel] = best;
      _LOG.debug(
        `find_in_all_projects: ${matches.length} projects share rel_path ${JSON.stringify(rel)}; chose most-recently-indexed project ${proj.hash.slice(0, 8)} (last_seen=${best[2]})`,
      );
      return [proj, rel];
    }
  }
  // Combine unambiguous-but-multiple matches with any per-project ambiguous
  // candidates, deduplicate, and raise so the caller can surface all possibilities.
  let all_candidates = matches.map(([proj, rel]) => `${proj.hash.slice(0, 8)}:${rel}`);
  all_candidates = all_candidates.concat(cross_project_candidates);
  if (all_candidates.length > 1) {
    all_candidates = [...new Set(all_candidates)].sort();
    _LOG.debug(
      `ambiguous cross-project file match for ${file_part}: ${all_candidates.join(", ")}`,
    );
    throw new AmbiguousFileMatch(file_part, all_candidates);
  }
  if (project_errors.length > 0) {
    throw new ProjectIndexUnavailable(
      "Project index database is unavailable for one or more indexed projects. " +
        "Run `token-goat index --full` again.",
    );
  }
  if (matches.length === 0) {
    _LOG.debug(
      `find_in_all_projects: no match found for ${JSON.stringify(file_part)} across ${rows.length} project(s)`,
    );
  }
  if (matches.length > 0) {
    const m0 = matches[0]!;
    return [m0[0], m0[1]];
  }
  return null;
}

/** True when the error looks like a Python FileNotFoundError (ENOENT). */
function _isFileNotFound(err: unknown): boolean {
  if (err !== null && typeof err === "object" && "code" in err) {
    if ((err as { code?: unknown }).code === "ENOENT") return true;
  }
  return _errMessage(err).includes("not found");
}

/** True when the error is an OS/sqlite-class error (disk I/O, db errors). */
function _isOSorSqliteError(err: unknown): boolean {
  const code = err !== null && typeof err === "object" && "code" in err
    ? (err as { code?: unknown }).code
    : undefined;
  if (typeof code === "string") {
    if (code.startsWith("SQLITE_")) return true;
    if (["EIO", "EACCES", "EPERM", "EBUSY"].includes(code)) return true;
  }
  const msg = _errMessage(err).toLowerCase();
  return (
    msg.includes("i/o") ||
    msg.includes("disk i/o") ||
    msg.includes("database") ||
    err instanceof db.DBError
  );
}

function _errMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

function _excName(err: unknown): string {
  if (err instanceof Error) return err.name || err.constructor.name;
  return typeof err;
}

/**
 * Slice *lines* to the requested range plus optional context.
 *
 * Returns [snippet, snippet_bytes, start, end].
 */
function _extract_snippet(
  lines: string[],
  full_bytes: number,
  row_start: number | null,
  row_end: number | null,
  context_lines: number,
): [string, number, number, number] {
  const safe_start = row_start !== null ? row_start : 1;
  const safe_end = row_end !== null ? row_end : safe_start;
  const start = Math.max(1, safe_start - context_lines);
  const end = Math.min(lines.length, safe_end + context_lines);
  const snippet = lines.slice(start - 1, end).join("\n");
  const snippet_bytes = utf8Bytes(snippet).length;
  return [snippet, snippet_bytes, start, end];
}

/**
 * Return the percentage of bytes saved by extracting *snippet_bytes* from
 * *full_bytes*.  Returns 0.0 when *full_bytes* is zero.
 */
function _pct_saved(snippet_bytes: number, full_bytes: number): number {
  if (!full_bytes) {
    return 0.0;
  }
  return (100.0 * Math.max(0, full_bytes - snippet_bytes)) / full_bytes;
}

// ---------------------------------------------------------------------------
// Smart truncation for long symbol bodies (item: context savings)
// ---------------------------------------------------------------------------

/** Number of body lines above which smart truncation is applied. */
export const TRUNCATE_THRESHOLD: number = 60;
/** Number of lines to show from the start of the body (after signature + docstring). */
export const TRUNCATE_HEAD_LINES: number = 15;
/** Number of lines to show from the end of the body. */
export const TRUNCATE_TAIL_LINES: number = 5;
/** Maximum number of docstring lines to include after the signature. */
export const TRUNCATE_DOCSTRING_LINES: number = 10;

/**
 * Return True when *line* starts a triple-quoted string literal (Python
 * docstring).  Detects both triple-double and triple-single forms, with
 * optional leading whitespace and an optional r/u/b string prefix.
 */
function _is_docstring_delimiter(line: string): boolean {
  const stripped = _lstrip(line);
  let prefix_end = 0;
  while (prefix_end < stripped.length && "rRuUbB".includes(stripped[prefix_end]!)) {
    prefix_end += 1;
  }
  const rest = stripped.slice(prefix_end);
  return rest.startsWith('"""') || rest.startsWith("'''");
}

/**
 * Return the index (inclusive) of the line that closes the docstring.
 *
 * *start_idx* is the index of the line that opens the triple-quoted string.
 */
function _find_docstring_end(lines: string[], start_idx: number): number {
  const stripped = _lstrip(lines[start_idx]!);
  let prefix_end = 0;
  while (prefix_end < stripped.length && "rRuUbB".includes(stripped[prefix_end]!)) {
    prefix_end += 1;
  }
  const rest = stripped.slice(prefix_end);
  const delimiter = rest.startsWith('"""') ? '"""' : "'''";
  // One-liner: the closing quotes appear after the opening on the same line.
  const after_open = rest.slice(3);
  if (after_open.includes(delimiter)) {
    return start_idx;
  }
  // Search subsequent lines for the closing delimiter.
  for (let i = start_idx + 1; i < lines.length; i++) {
    if (lines[i]!.includes(delimiter)) {
      return i;
    }
  }
  // Closing delimiter not found - treat as unbounded docstring.
  return lines.length - 1;
}

/** Python str.lstrip() over ASCII + common Unicode whitespace. */
function _lstrip(s: string): string {
  return s.replace(/^\s+/, "");
}

/** Leading-whitespace prefix of `s` (the part str.lstrip() removes). */
function _leadingWhitespace(s: string): string {
  return s.slice(0, s.length - _lstrip(s).length);
}

/** Python str.rstrip() over ASCII + common Unicode whitespace. */
function _rstrip(s: string): string {
  return s.replace(/\s+$/, "");
}

/**
 * Python str.splitlines() — split on universal newlines without a trailing
 * empty element. Matches CPython's behaviour for the line set the truncation
 * and byte math depend on.
 */
function _splitlines(text: string): string[] {
  if (text === "") return [];
  const parts = text.split(
    /\r\n|\r|\n|\u000b|\u000c|\u001c|\u001d|\u001e|\u0085|\u2028|\u2029/,
  );
  // Python splitlines() drops a trailing empty string produced by a terminal
  // newline (because the line boundary is a terminator, not a separator).
  if (parts.length > 0 && parts[parts.length - 1] === "") {
    parts.pop();
  }
  return parts;
}

/**
 * Return a smart-truncated view of a symbol body when it exceeds the threshold.
 *
 * When the body is at most TRUNCATE_THRESHOLD lines, or when *full* is true,
 * the original text is returned unchanged.
 */
export function truncate_symbol_body(text: string, opts: { full?: boolean } = {}): string {
  const full = opts.full ?? false;
  if (full) {
    return text;
  }

  const lines = _splitlines(text);
  if (lines.length <= TRUNCATE_THRESHOLD) {
    return text;
  }

  // ------------------------------------------------------------------
  // Phase 1: identify the signature boundary.
  // ------------------------------------------------------------------
  let sig_end_idx = 0; // index of the last signature line (0-based)
  for (let i = 0; i < lines.length; i++) {
    const stripped = _rstrip(lines[i]!);
    if (stripped.endsWith(":") || stripped.endsWith("{")) {
      sig_end_idx = i;
      break;
    }
    // If first line doesn't look like a header, treat it as the sole sig line.
    if (
      i === 0 &&
      !(stripped.endsWith(":") || stripped.endsWith("{") || stripped.endsWith(","))
    ) {
      sig_end_idx = 0;
      break;
    }
  }

  const sig_lines = lines.slice(0, sig_end_idx + 1);
  const body_lines = lines.slice(sig_end_idx + 1);

  // ------------------------------------------------------------------
  // Phase 2: detect and extract docstring (Python-style triple quotes).
  // ------------------------------------------------------------------
  let docstring_lines: string[] = [];
  let doc_was_capped = false; // True when the docstring exceeded the cap and was trimmed
  let body_start_offset = 0; // index into body_lines where the real body begins

  // Find first non-blank body line.
  let first_body_idx = 0;
  for (let i = 0; i < body_lines.length; i++) {
    if (body_lines[i]!.trim()) {
      first_body_idx = i;
      break;
    }
  }

  if (body_lines.length > 0 && _is_docstring_delimiter(body_lines[first_body_idx]!)) {
    const doc_end_idx = _find_docstring_end(body_lines, first_body_idx);
    const raw_doc = body_lines.slice(first_body_idx, doc_end_idx + 1);
    if (raw_doc.length <= TRUNCATE_DOCSTRING_LINES) {
      docstring_lines = raw_doc;
    } else {
      // Cap at TRUNCATE_DOCSTRING_LINES and add a note.
      const indent0 = _leadingWhitespace(raw_doc[0]!);
      docstring_lines = raw_doc
        .slice(0, TRUNCATE_DOCSTRING_LINES)
        .concat([`${indent0}    # ... (docstring truncated)`]);
      doc_was_capped = true;
    }
    body_start_offset = doc_end_idx + 1;
  }

  const real_body = body_lines.slice(body_start_offset);

  // ------------------------------------------------------------------
  // Phase 3: apply head + tail truncation to the real body.
  // ------------------------------------------------------------------
  const total_real = real_body.length;
  if (total_real <= TRUNCATE_HEAD_LINES + TRUNCATE_TAIL_LINES) {
    if (doc_was_capped) {
      return sig_lines.concat(docstring_lines, real_body).join("\n");
    }
    return text;
  }

  const head = real_body.slice(0, TRUNCATE_HEAD_LINES);
  const tail = real_body.slice(total_real - TRUNCATE_TAIL_LINES);
  const truncated_count = total_real - TRUNCATE_HEAD_LINES - TRUNCATE_TAIL_LINES;

  // Infer indentation from the first head line for the ellipsis comment.
  let indent = "";
  if (head.length > 0) {
    const stripped_head = _lstrip(head[0]!);
    if (stripped_head) {
      indent = _leadingWhitespace(head[0]!);
    }
  }

  const ellipsis_line = `${indent}# ... (${truncated_count} lines truncated) ...`;

  const result_lines = sig_lines.concat(docstring_lines, head, [ellipsis_line], tail);
  return result_lines.join("\n");
}

/**
 * Return a one-line header estimating the token count of *text*.
 *
 * Format: ``# {N} lines (~{approx_tokens} tok)``
 */
export function token_estimate_header(text: string): string {
  const n_lines = _countChar(text, "\n") + (text ? 1 : 0);
  const approx_tokens = Math.floor(text.length / 4);
  return `# ${n_lines} lines (~${approx_tokens} tok)`;
}

/** Count occurrences of a single character in `s` (str.count for a 1-char needle). */
function _countChar(s: string, ch: string): number {
  let count = 0;
  for (let i = 0; i < s.length; i++) {
    if (s[i] === ch) count += 1;
  }
  return count;
}

/**
 * Read *abs_path*, split into lines, and return [lines, byte_size].
 *
 * Returns ``null`` on any I/O error, if the file is empty, or if the file
 * exceeds ``_MAX_READ_BYTES``.
 */
function _read_file_lines(abs_path: string): [string[], number] | null {
  let file_size: number;
  try {
    file_size = fs.statSync(abs_path).size;
  } catch (e) {
    _LOG.warning(`stat failed: ${abs_path}: ${String(e)}`);
    return null;
  }

  if (file_size > _MAX_READ_BYTES) {
    _LOG.warning(
      `read_file_lines: skipping oversized file ${abs_path} (${file_size} bytes > ${_MAX_READ_BYTES} limit)`,
    );
    return null;
  }

  let full_text: string;
  try {
    // encoding="utf-8-sig" strips a leading BOM; errors="replace" maps invalid
    // sequences to U+FFFD (Buffer.toString("utf8") already does the latter).
    const raw = fs.readFileSync(abs_path);
    full_text = stripBOM(raw.toString("utf8"));
  } catch (e) {
    _LOG.warning(`read failed: ${abs_path}: ${String(e)}`);
    return null;
  }
  const lines = _splitlines(full_text);
  if (lines.length === 0) {
    _LOG.debug(`_read_file_lines: empty file (no lines): ${abs_path}`);
    return null;
  }
  return [lines, utf8Bytes(full_text).length];
}

/**
 * Split a possibly-qualified symbol into ``[qualifier, leaf_name]``.
 *
 * Supports ``Class.method`` notation. Multi-level qualifiers are collapsed so
 * the immediate enclosing scope is the qualifier.
 *
 * Returns ``[null, symbol]`` for a bare name with no ``.`` separator.
 */
export function _split_qualified_symbol(symbol: string): [string | null, string] {
  if (!symbol.includes(".")) {
    return [null, symbol];
  }
  const lastDot = symbol.lastIndexOf(".");
  const qualifier = symbol.slice(0, lastDot);
  const leaf = symbol.slice(lastDot + 1);
  // Strip nested qualifiers: only the immediate parent matters for filtering.
  const qLastDot = qualifier.lastIndexOf(".");
  const immediate = qLastDot >= 0 ? qualifier.slice(qLastDot + 1) : qualifier;
  return [immediate || null, leaf];
}

// Kinds that can act as a method's enclosing scope for qualified lookups.
const _QUALIFIER_KINDS: readonly string[] = [
  "class",
  "interface",
  "struct",
  "trait",
  "enum",
  "impl",
  "type",
];

interface SymbolRow {
  name: string;
  kind: string;
  line: number;
  end_line: number | null;
  signature: string | null;
}

/**
 * Restrict *rows* to symbols enclosed by a class/interface named *qualifier*.
 */
function _filter_by_qualifier(
  conn: DatabaseType,
  rel_path: string,
  rows: SymbolRow[],
  qualifier: string,
): SymbolRow[] {
  const placeholders = _QUALIFIER_KINDS.map(() => "?").join(",");
  const enclosing = conn
    .prepare(
      "SELECT name, line, end_line FROM symbols " +
        "WHERE file_rel = ? AND name = ? AND end_line IS NOT NULL " +
        `AND kind IN (${placeholders})`,
    )
    .all(rel_path, qualifier, ..._QUALIFIER_KINDS) as Array<{
    name: string;
    line: number;
    end_line: number;
  }>;
  if (enclosing.length === 0) {
    return [];
  }
  const spans: Array<[number, number]> = enclosing.map((e) => [
    Number(e.line),
    Number(e.end_line),
  ]);
  const kept: SymbolRow[] = [];
  for (const r of rows) {
    const r_line = Number(r.line);
    if (spans.some(([s, e]) => s <= r_line && r_line <= e)) {
      kept.push(r);
    }
  }
  return kept;
}

/**
 * Look up symbol in DB, slice the file, return extraction dict.
 *
 * Returns a SymbolResult or null if the symbol is not found or the file cannot
 * be read.
 */
export function read_symbol(
  project: Project,
  rel_path: string,
  symbol: string,
  opts: { context_lines?: number } = {},
): SymbolResult | null {
  const context_lines = opts.context_lines ?? 0;
  const t0 = _monotonic();
  const [qualifier, leaf] = _split_qualified_symbol(symbol);
  if (!_validate_lookup_args("read_symbol", rel_path, symbol)) {
    return null;
  }

  let rows: SymbolRow[];
  try {
    rows = db.openProject(project.hash, (conn: DatabaseType) => {
      let r = conn
        .prepare(
          "SELECT name, kind, line, end_line, signature FROM symbols " +
            "WHERE file_rel = ? AND name = ? AND end_line IS NOT NULL ORDER BY line",
        )
        .all(rel_path, leaf) as SymbolRow[];
      if (qualifier && r.length > 0) {
        const qualified = _filter_by_qualifier(conn, rel_path, r, qualifier);
        if (qualified.length > 0) {
          r = qualified;
        } else {
          _LOG.debug(
            `read_symbol: qualifier ${JSON.stringify(qualifier)} did not narrow ${r.length} candidates for ${JSON.stringify(leaf)} in ${rel_path}; falling back to unqualified lookup`,
          );
        }
      }
      return r;
    });
  } catch (exc) {
    if (_isSqliteError(exc)) {
      _LOG.warning(
        `read_symbol: DB error for project=${project.hash.slice(0, 8)} file=${rel_path} symbol=${symbol}: ${String(exc)}`,
      );
      return null;
    }
    throw exc;
  }
  if (rows.length === 0) {
    _LOG.debug(`symbol not found: project=${project.hash.slice(0, 8)} file=${rel_path} symbol=${symbol}`);
    return null;
  }

  // If multiple matches, prefer by kind priority then by earliest line.
  let chosen = rows[0]!;
  let chosenKey: [number, number] = [_kpGet(chosen.kind), Number(chosen.line)];
  for (const r of rows) {
    const key: [number, number] = [_kpGet(r.kind), Number(r.line)];
    if (_tupleCmp(key, chosenKey) < 0) {
      chosen = r;
      chosenKey = key;
    }
  }
  if (rows.length > 1) {
    const rejected = rows
      .filter((r) => r !== chosen)
      .map((r) => `${r.kind}@${r.line}`)
      .join(", ");
    _LOG.debug(
      `read_symbol: ${rows.length} candidates for ${JSON.stringify(symbol)}; chose kind=${JSON.stringify(chosen.kind)} line=${chosen.line} (rejected: ${rejected})`,
    );
  }

  const read_result = _read_file_lines(path.join(project.root, rel_path));
  if (read_result === null) {
    _LOG.debug(`read_symbol: cannot read file ${rel_path} in project ${project.hash.slice(0, 8)}`);
    return null;
  }
  const [lines, full_bytes] = read_result;

  const sym_line: number = _coerce_line(chosen.line, 1);
  const sym_end_line: number | null = _coerce_end_line(chosen.end_line);
  const core_start = Math.max(1, sym_line);
  const core_end = Math.min(lines.length, sym_end_line !== null ? sym_end_line : sym_line);
  const [snippet, snippet_bytes, start, end] = _extract_snippet(
    lines,
    full_bytes,
    sym_line,
    sym_end_line,
    context_lines,
  );
  const elapsed = _monotonic() - t0;
  _LOG.debug(
    `read_symbol: ${rel_path}::${chosen.name} (${chosen.kind}) lines ${start}-${end}, ${snippet_bytes}/${full_bytes} bytes extracted (${_pct_saved(snippet_bytes, full_bytes).toFixed(1)}% saved, ${elapsed.toFixed(3)}s)`,
  );
  return {
    file: rel_path,
    symbol: chosen.name,
    kind: chosen.kind,
    start_line: start,
    end_line: end,
    core_start_line: core_start,
    core_end_line: core_end,
    text: snippet,
    signature: chosen.signature,
    bytes_total: full_bytes,
    bytes_extracted: snippet_bytes,
    bytes_saved: Math.max(0, full_bytes - snippet_bytes),
  };
}

/** _KIND_PRIORITY.get(kind, 9) */
function _kpGet(kind: string): number {
  const v = _KIND_PRIORITY[kind];
  return v !== undefined ? v : 9;
}

interface SectionRow {
  heading: string;
  level: number;
  line: number;
  end_line: number | null;
}

/**
 * Split a heading like ``Methodology#2`` into ``["Methodology", 2]``.
 *
 * Returns ``[heading, null]`` when no ordinal suffix is present, or when the
 * suffix is malformed.
 */
export function _parse_section_ordinal(heading: string): [string, number | null] {
  if (!heading.includes("#")) {
    return [heading, null];
  }
  const lastHash = heading.lastIndexOf("#");
  const base = heading.slice(0, lastHash);
  const ordinal_str = heading.slice(lastHash + 1);
  if (!base || !ordinal_str) {
    return [heading, null];
  }
  if (!/^[+-]?\d+$/.test(ordinal_str)) {
    return [heading, null];
  }
  const ordinal = parseInt(ordinal_str, 10);
  if (Number.isNaN(ordinal)) {
    return [heading, null];
  }
  if (ordinal < 1) {
    return [heading, null];
  }
  return [base, ordinal];
}

/**
 * Same as read_symbol but for markdown/HTML/Liquid section headings.
 *
 * Returns a SectionResult or null if the heading is not found or the file
 * cannot be read.  Supports an ordinal suffix ``Heading#N`` (1-based).
 */
export function read_section(
  project: Project,
  rel_path: string,
  heading: string,
  opts: { context_lines?: number } = {},
): SectionResult | null {
  const context_lines = opts.context_lines ?? 0;
  const t0 = _monotonic();
  const [base_heading, ordinal] = _parse_section_ordinal(heading);
  if (!_validate_lookup_args("read_section", rel_path, base_heading)) {
    return null;
  }

  let rows: SectionRow[];
  let case_sensitive_match: boolean;
  try {
    const result = db.openProject(project.hash, (conn: DatabaseType) => {
      let r = conn
        .prepare(
          "SELECT heading, level, line, end_line FROM sections " +
            "WHERE file_rel = ? AND heading = ? AND end_line IS NOT NULL ORDER BY line",
        )
        .all(rel_path, base_heading) as SectionRow[];
      const csm = r.length > 0;
      if (r.length === 0) {
        // Fallback: case-insensitive match
        r = conn
          .prepare(
            "SELECT heading, level, line, end_line FROM sections " +
              "WHERE file_rel = ? AND lower(heading) = lower(?) AND end_line IS NOT NULL ORDER BY line",
          )
          .all(rel_path, base_heading) as SectionRow[];
      }
      return { rows: r, case_sensitive_match: csm };
    });
    rows = result.rows;
    case_sensitive_match = result.case_sensitive_match;
  } catch (exc) {
    if (_isSqliteError(exc)) {
      _LOG.warning(
        `read_section: DB error for project=${project.hash.slice(0, 8)} file=${rel_path} heading=${heading}: ${String(exc)}`,
      );
      return null;
    }
    throw exc;
  }
  if (rows.length === 0) {
    _LOG.debug(`section not found: project=${project.hash.slice(0, 8)} file=${rel_path} heading=${heading}`);
    return null;
  }

  // Apply ordinal selection if the caller asked for a specific occurrence.
  let chosen: SectionRow;
  if (ordinal !== null) {
    if (ordinal > rows.length) {
      _LOG.info(
        `read_section: ordinal ${ordinal} requested for ${JSON.stringify(base_heading)} in ${rel_path} but only ${rows.length} match(es) exist; no section returned`,
      );
      return null;
    }
    chosen = rows[ordinal - 1]!;
  } else if (rows.length > 1) {
    const other_lines = rows
      .slice(1)
      .map((r) => String(Number(r.line)))
      .join(", ");
    _LOG.warning(
      `read_section: ${rows.length} sections in ${rel_path} share heading ${JSON.stringify(base_heading)}; returning the first (line ${Number(rows[0]!.line)}). To select another, use ${JSON.stringify(base_heading)}#2, ${JSON.stringify(base_heading)}#3, ... (other matches at lines: ${other_lines})`,
    );
    chosen = rows[0]!;
  } else {
    chosen = rows[0]!; // single match - straightforward
  }

  const read_result = _read_file_lines(path.join(project.root, rel_path));
  if (read_result === null) {
    _LOG.debug(`read_section: cannot read file ${rel_path} in project ${project.hash.slice(0, 8)}`);
    return null;
  }
  const [lines, full_bytes] = read_result;

  const sec_line: number = _coerce_line(chosen.line, 1);
  const sec_end_line: number | null = _coerce_end_line(chosen.end_line);
  const core_start = Math.max(1, sec_line);
  const core_end = Math.min(lines.length, sec_end_line !== null ? sec_end_line : sec_line);
  const [snippet, snippet_bytes, start, end] = _extract_snippet(
    lines,
    full_bytes,
    sec_line,
    sec_end_line,
    context_lines,
  );
  const elapsed = _monotonic() - t0;
  const match_kind = case_sensitive_match ? "exact" : "case-insensitive";
  if (!case_sensitive_match) {
    _LOG.info(
      `read_section: heading ${JSON.stringify(heading)} not found by exact match in ${rel_path} - fell back to case-insensitive match -> ${JSON.stringify(chosen.heading)}`,
    );
  }
  _LOG.debug(
    `read_section: ${rel_path}#${chosen.heading} (h${chosen.level}, ${match_kind}-match) lines ${start}-${end}, ${snippet_bytes}/${full_bytes} bytes extracted (${_pct_saved(snippet_bytes, full_bytes).toFixed(1)}% saved, ${elapsed.toFixed(3)}s)`,
  );
  return {
    file: rel_path,
    heading: chosen.heading,
    level: chosen.level,
    start_line: start,
    end_line: end,
    core_start_line: core_start,
    core_end_line: core_end,
    text: snippet,
    bytes_total: full_bytes,
    bytes_extracted: snippet_bytes,
    bytes_saved: Math.max(0, full_bytes - snippet_bytes),
  };
}

// ---------------------------------------------------------------------------
// Cross-reference footer for symbol reads
// ---------------------------------------------------------------------------

/**
 * Return a compact "Refs: ..." footer for *symbol_name*, or an empty string.
 *
 * Returns ``""`` on any DB error (fail-soft) or when no callers are indexed.
 */
export function format_callers_footer(
  project: Project,
  symbol_name: string,
  limit: number = 3,
): string {
  let callers: Array<{ file_rel: string; line: number }>;
  try {
    callers = db.get_symbol_callers(project.hash, symbol_name, limit);
  } catch {
    // defensive; get_symbol_callers is already fail-soft
    return "";
  }

  if (!callers || callers.length === 0) {
    return "";
  }

  const shown = callers.slice(0, limit);
  const has_more = callers.length > limit;

  const parts = shown.map((c) => `${c.file_rel}:${c.line}`);
  let refs_str = parts.join(", ");
  if (has_more) {
    refs_str += " (and more)";
  }
  return `Refs: ${refs_str}`;
}

/** True when the error is a better-sqlite3 SqliteError (operational/db error). */
function _isSqliteError(err: unknown): boolean {
  const code =
    err !== null && typeof err === "object" && "code" in err
      ? (err as { code?: unknown }).code
      : undefined;
  if (typeof code === "string" && code.startsWith("SQLITE_")) return true;
  return err instanceof Error && err.constructor.name === "SqliteError";
}

/** Monotonic clock in seconds (time.monotonic analogue). */
function _monotonic(): number {
  return Number(process.hrtime.bigint()) / 1e9;
}
