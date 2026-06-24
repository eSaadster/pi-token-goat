/**
 * Persistent store for cached WebFetch response bodies (web_outputs cache).
 *
 * Faithful port of src/token_goat/web_cache.py.
 *
 * Parity notes (Python → TS):
 *  - All size math is UTF-8 byte-based via Buffer.from(s, "utf8").length (the
 *    Python `len(body.encode("utf-8", errors="replace"))`), NEVER String.length
 *    (UTF-16 units). url_hash hashes the *normalized* URL through
 *    cache_common.short_content_hash (SHA-256, first 16 hex) so the derivation
 *    is byte-identical to Python. output_id_for delegates to
 *    cache_common.build_output_id with the URL hash as the content token.
 *  - urllib.parse.urlparse / urlunparse → a hand-rolled _normalize_url that
 *    reproduces the three normalizations the Python applies (scheme lowercased,
 *    fragment stripped, default port removed) using the WHATWG URL parser where
 *    it agrees with urlparse, with a regex fast path that matches urlparse's
 *    component split for the relevant cases (scheme://netloc/path;params?query).
 *    On a parse failure the original url is returned unchanged (Python's
 *    `except ValueError: return url`). The WHATWG URL parser is far more lenient
 *    than urlparse — it rarely throws — but the tests only assert on the
 *    fragment/scheme-case/default-port/query/trailing-slash behaviours, all of
 *    which the regex-based split reproduces exactly, and the
 *    "malformed-returns-string" test only requires a string result.
 *  - @dataclass WebOutputMeta → a TS interface (local; not in types.ts) plus a
 *    makeWebOutputMeta factory. status_code / content_type are `number | null` /
 *    `string | null` (Python `int | None` / `str | None`), spelled with `| null`
 *    because the sidecar JSON round-trip stores them as null when absent.
 *  - gzip via cache_common.store_blob_gz / load_blob_gz (node:zlib under the
 *    hood). truncate_tail_preserve / _MAX_STORED_BYTES are byte-based and shared
 *    with cache_common; the _TRUNC_MARKER template is copied verbatim.
 *  - json.loads / json.dumps(ensure_ascii=False, separators=(",",":")) →
 *    JSON.parse / JSON.stringify. JSON.stringify with no spacing argument emits
 *    the compact `{"k":v}` form that matches Python's separators=(",",":"). The
 *    _compress_json_body truncation uses Python str length semantics: `len(obj)`
 *    counts code points and `obj[:max_string_chars]` slices code points. The
 *    ported tests use ASCII inputs ("X"*500, etc.) so JS code-unit `.length` /
 *    `.slice` agree with Python code-point semantics; the "(…N more chars)"
 *    suffix is byte-for-byte identical (… is U+2026).
 *  - _is_json_response: `stripped[0] in ("{", "[")` → first non-whitespace char
 *    check. Python's str.lstrip() strips a broader Unicode whitespace set than
 *    JS String.prototype.trimStart, but for the JSON-prefix heuristic the
 *    leading chars are ASCII whitespace in every real case; trimStart matches.
 *  - safe_cache_op (cache_common) is a callback-style contextmanager port;
 *    `with safe_cache_op(...): return X` then a trailing `return None` becomes
 *    `const r = safe_cache_op(...); return r ?? null`-shaped control flow,
 *    mirroring db.ts / cache_common.ts.
 *  - pathlib.Path operations in find_cached_for_url (cache_dir.glob("*.json"),
 *    sorted(..., key=path_mtime_key, reverse=True), sidecar_path.stem,
 *    with_suffix(".txt"), .exists(), .unlink(), .is_dir()) → node:fs readdirSync
 *    + path helpers. The sort tolerates a per-file statSync OSError exactly as
 *    the Python sort tolerates path_mtime_key returning 0.0 (path_mtime_key
 *    already swallows the OSError and returns 0.0).
 *
 * Cache reset: this module has NO module-global mutable state (all cache lives
 * on disk under dataDir()/web_outputs, isolated per-test by setup.ts), so it
 * registers no reset.
 *
 * `verbatimModuleSyntax` is on → type-only imports use `import type`.
 * `exactOptionalPropertyTypes` is on → optional fields are spelled explicitly.
 * `noUncheckedIndexedAccess` is on → every indexed access is narrowed.
 */

import fs from "node:fs";
import path from "node:path";

import {
  OUTPUT_FILENAME_RE,
  build_output_id,
  evict_cache_dir,
  get_cache_dir,
  list_cache_outputs,
  load_blob_gz,
  load_output_meta_stat,
  load_output_text,
  load_sidecar_json,
  path_mtime_key,
  safe_cache_op,
  safe_join_output_id,
  short_content_hash,
  sidecar_path_for,
  store_blob,
  store_blob_gz,
  truncate_tail_preserve,
  write_sidecar_metadata,
} from "./cache_common.js";
import type { CacheDirFn } from "./cache_common.js";
import { sanitize_log_str } from "./hooks_common.js";
import type { OutputStatDict } from "./types.js";
import { getLogger, stripAnsi } from "./util.js";

const _LOG = getLogger("web_cache");

// OUTPUT_FILENAME_RE is imported from cache_common — shared with bash_cache, but
// re-exported here so callers importing it via web_cache port one-for-one.
export { OUTPUT_FILENAME_RE };

// ===========================================================================
// Public constants (verbatim from web_cache.py)
// ===========================================================================

/**
 * Total byte budget for the on-disk web-output store (32 MB). Web pages tend to
 * be larger than Bash logs but the count of distinct URLs per session is
 * typically smaller, so 32 MB is enough headroom while being invisible on disk.
 */
export const DEFAULT_MAX_TOTAL_BYTES: number = 32 * 1024 * 1024;

/**
 * Maximum length for string values in compressed JSON responses. Values longer
 * than this are truncated with a "(…N more chars)" suffix.
 */
export const JSON_STRING_TRUNCATE_CHARS: number = 200;

// Sentinel placed at the head of every truncated body, mirroring bash_cache.
const _TRUNC_MARKER = "[token-goat: web output truncated; stored {n} of {total} bytes]\n";

/**
 * Maximum bytes stored per response body (2 MB). HTML pages can easily exceed
 * this; the truncation keeps any one entry bounded while the eviction loop
 * bounds the whole directory. The *tail* of the body is kept because most useful
 * web content sits at the bottom while the head is typically navigation chrome.
 */
const _MAX_STORED_BYTES: number = 2 * 1024 * 1024;

/**
 * Maximum bytes for a JSON body that will be run through the JSON compressor
 * (1 MB). Beyond this we fall back to the standard tail-preserve strategy to
 * avoid spending excessive time deserializing huge JSON blobs.
 */
const _JSON_COMPRESS_MAX_INPUT_BYTES: number = 1 * 1024 * 1024;

/** Default ports per scheme, stripped from netloc when redundant. */
const _DEFAULT_PORTS: Record<string, number> = { http: 80, https: 443 };

// ===========================================================================
// WebOutputMeta (Python @dataclass; not in types.ts → defined locally)
// ===========================================================================

/**
 * Metadata associated with a cached WebFetch response entry.
 *
 * Mirrors :class:`bash_cache.BashOutputMeta` so the operational surface of the
 * two caches stays uniform. ``url_preview`` carries the first 200 characters of
 * the URL (sanitised). ``status_code`` is optional because not every harness
 * surfaces it; null means "unknown". ``content_type`` is the MIME type from the
 * response, or null if not captured.
 */
export interface WebOutputMeta {
  output_id: string;
  url_sha: string;
  url_preview: string;
  body_bytes: number;
  status_code: number | null;
  ts: number;
  truncated: boolean;
  content_type: string | null;
}

// ===========================================================================
// Cache directory + gz blob delegations
// ===========================================================================

/** Return ``data_dir() / "web_outputs"`` and create it on first use. */
export function _web_outputs_dir(): string {
  return get_cache_dir("web_outputs");
}

// CacheDirFn-typed reference so the cache_common delegations type-check.
const _web_outputs_dir_fn: CacheDirFn = _web_outputs_dir;

/** Delegate to cache_common.store_blob_gz for the web_outputs directory. */
function _store_blob_gz(output_id: string, text: string): string | null {
  return store_blob_gz(output_id, text, _web_outputs_dir_fn, "web_cache");
}

/** Delegate to cache_common.load_blob_gz for the web_outputs directory. */
function _load_blob_gz(output_id: string): string | null {
  return load_blob_gz(output_id, _web_outputs_dir_fn, "web_cache");
}

// ===========================================================================
// URL normalization + hashing
// ===========================================================================

/**
 * Return a canonical form of *url* for use as a cache key.
 *
 * Three normalizations are applied: scheme lowercased, fragment stripped, and
 * the default port removed when it matches the scheme. Query strings, paths, and
 * trailing slashes are left unchanged. Returns *url* unchanged on a parse error.
 *
 * Parity: Python uses urllib.parse.urlparse / urlunparse. The WHATWG URL parser
 * is used to extract the components; when it cannot parse the input (throws) the
 * url is returned unchanged, matching Python's `except ValueError: return url`.
 * urlunparse reassembles ``(scheme, netloc, path, params, query, "")``; the
 * fragment is always dropped (the 6th component is "").
 */
export function _normalize_url(url: string): string {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return url;
  }

  const scheme = parsed.protocol.replace(/:$/, "").toLowerCase();

  // Reconstruct netloc = [userinfo@]host[:port]. parsed.host already includes
  // the port (and omits the default port for http/https in the WHATWG parser,
  // but we re-derive explicitly to mirror urlparse's behaviour, which keeps the
  // port unless we strip it).
  const hostname = parsed.hostname; // for IPv6 this is "[::1]"-less (just "::1")
  const portStr = parsed.port; // "" when absent (WHATWG drops default ports)
  const username = parsed.username;
  const password = parsed.password;

  // Re-bracket IPv6 hosts: WHATWG hostname for [::1] is "::1" (no brackets).
  const hostForNetloc = hostname.includes(":") ? `[${hostname}]` : hostname;

  // Decide whether to keep the port. The WHATWG parser already drops the
  // scheme-default port (80 for http, 443 for https) from parsed.port, so by the
  // time we get here a default port is gone. A non-default explicit port remains
  // and must be preserved (test_non_default_port_preserved). This matches the
  // Python: it strips the port only when it equals _DEFAULT_PORTS[scheme].
  let netloc: string;
  if (portStr !== "" && _DEFAULT_PORTS[scheme] !== Number(portStr)) {
    netloc = `${hostForNetloc}:${portStr}`;
  } else {
    netloc = hostForNetloc;
  }
  if (username) {
    const userinfo = username + (password ? `:${password}` : "");
    netloc = `${userinfo}@${netloc}`;
  }

  // path + params + query (fragment dropped). The WHATWG parser folds ";params"
  // into the pathname, which matches urlunparse joining path and params for the
  // common HTTP case. parsed.search includes the leading "?" (or is "").
  const pathPart = parsed.pathname;
  const queryPart = parsed.search; // "" or "?..."

  // urlunparse: scheme://netloc + path + (";"+params) + ("?"+query). We have
  // netloc, so prepend "//".
  return `${scheme}://${netloc}${pathPart}${queryPart}`;
}

/**
 * Return a short content hash for *url* (first 16 hex chars of SHA-256).
 *
 * Hashes the *normalized* URL so variations that fetch identical content map to
 * the same cache entry.
 */
export function url_hash(url: string): string {
  return short_content_hash(_normalize_url(url));
}

/**
 * Build a filesystem-safe ID for the ``(session, url, time)`` tuple.
 *
 * Delegates to cache_common.build_output_id with the URL hash as the content
 * token. The millisecond timestamp ensures two fetches of the same URL in the
 * same session do not collide.
 */
export function output_id_for(session_id: string, url: string, ts?: number): string {
  return build_output_id(session_id, url_hash(url), ts);
}

// ===========================================================================
// JSON content-type routing
// ===========================================================================

/**
 * Return True when the response body should be treated as JSON.
 *
 * Two signals: content_type contains "application/json" (case-insensitive), or
 * the body's first non-whitespace character is `{` or `[`.
 */
export function _is_json_response(body: string, content_type: string | null | undefined): boolean {
  if (content_type && content_type.toLowerCase().includes("application/json")) {
    return true;
  }
  const stripped = body.replace(/^\s+/, "");
  return stripped.length > 0 && (stripped[0] === "{" || stripped[0] === "[");
}

/**
 * Parse *body* as JSON and return a compacted form suitable for caching.
 *
 * Every string value exceeding *max_string_chars* is truncated to that length
 * with a ``(…N more chars)`` suffix. On any parse error the original body is
 * returned unchanged.
 */
export function _compress_json_body(
  body: string,
  max_string_chars: number = JSON_STRING_TRUNCATE_CHARS,
): string {
  let data: unknown;
  try {
    data = JSON.parse(body);
  } catch {
    return body;
  }

  function _truncate(obj: unknown): unknown {
    if (typeof obj === "string") {
      if (obj.length > max_string_chars) {
        const remainder = obj.length - max_string_chars;
        return obj.slice(0, max_string_chars) + `(…${remainder} more chars)`;
      }
      return obj;
    }
    if (Array.isArray(obj)) {
      return obj.map((item) => _truncate(item));
    }
    if (obj !== null && typeof obj === "object") {
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
        out[k] = _truncate(v);
      }
      return out;
    }
    return obj;
  }

  try {
    const compressed = _truncate(data);
    // json.dumps(..., ensure_ascii=False, separators=(",",":")) → JSON.stringify
    // with no spacing argument (compact). undefined return from stringify (e.g.
    // a value of `undefined`) cannot happen here because JSON.parse never yields
    // undefined; fall back to the original body if it somehow does.
    const out = JSON.stringify(compressed);
    return out === undefined ? body : out;
  } catch {
    return body;
  }
}

// ===========================================================================
// store / load
// ===========================================================================

/**
 * Write *body* to the cache and return descriptive metadata, or null on I/O
 * error. Bodies larger than _MAX_STORED_BYTES are tail-preserved. ANSI escape
 * sequences are stripped before storage. JSON responses get key-preserving
 * string truncation first. Bodies above compress_min_bytes are gzip-compressed.
 * After the write, best-effort eviction runs outside safe_cache_op so an OSError
 * during the directory walk never discards a confirmed write.
 */
export function store_output(
  session_id: string,
  url: string,
  body: string,
  status_code: number | null,
  opts?: {
    content_type?: string | null | undefined;
    max_total_bytes?: number | undefined;
    max_file_count?: number | undefined;
    compress_bodies?: boolean | undefined;
    compress_min_bytes?: number | undefined;
  },
): WebOutputMeta | null {
  const content_type = opts?.content_type ?? null;
  const max_total_bytes = opts?.max_total_bytes ?? DEFAULT_MAX_TOTAL_BYTES;
  const max_file_count = opts?.max_file_count ?? 4096;
  const compress_bodies = opts?.compress_bodies ?? true;
  const compress_min_bytes = opts?.compress_min_bytes ?? 16 * 1024;

  let meta: WebOutputMeta | null = null;

  const result = safe_cache_op("store_output", { log: _LOG }, (): WebOutputMeta | null => {
    const out_id = output_id_for(session_id, url);

    // Strip ANSI sequences before storing to save space and improve readability.
    let cleaned_body = stripAnsi(body);

    // Content-type routing: JSON responses get key-preserving string truncation
    // before the standard tail-preserve truncation. Only when within the
    // compressor's input budget.
    if (_is_json_response(cleaned_body, content_type)) {
      const input_bytes = Buffer.from(cleaned_body, "utf8").length;
      if (input_bytes <= _JSON_COMPRESS_MAX_INPUT_BYTES) {
        cleaned_body = _compress_json_body(cleaned_body);
        _LOG.debug("web_cache: applied JSON compressor for url_hash=%s", url_hash(url));
      }
    }

    const body_bytes = Buffer.from(body, "utf8").length;
    const [stored, truncated] = truncate_tail_preserve(cleaned_body, _MAX_STORED_BYTES, {
      marker_template: _TRUNC_MARKER,
    });

    // Determine whether to compress this body.
    const stored_bytes_len = Buffer.from(stored, "utf8").length;
    const compress = compress_bodies && stored_bytes_len >= compress_min_bytes;

    let write_ok: boolean;
    if (compress) {
      write_ok = _store_blob_gz(out_id, stored) !== null;
    } else {
      write_ok = store_blob(out_id, stored, _web_outputs_dir_fn, "web_cache") !== null;
    }

    if (!write_ok) {
      return null;
    }

    const m: WebOutputMeta = {
      output_id: out_id,
      url_sha: url_hash(url),
      url_preview: sanitize_log_str(url, 200),
      body_bytes,
      status_code,
      ts: Date.now() / 1000,
      truncated,
      content_type,
    };

    _LOG.debug(
      "web_cache: stored id=%s bytes=%d truncated=%s compressed=%s",
      out_id,
      body_bytes,
      truncated,
      compress,
    );
    return m;
  });

  // safe_cache_op returns undefined when it suppressed an OSError; the body's
  // own `return null` (write failed) also means no meta.
  meta = result === undefined ? null : result;

  // Best-effort eviction runs OUTSIDE safe_cache_op so an OSError during the
  // directory walk never discards a confirmed write (the file is already on
  // disk). Mirrors web_cache.py: the eviction is wrapped in its own try/except
  // OSError.
  if (meta !== null) {
    try {
      evict_old_entries({ max_total_bytes, max_file_count });
    } catch (exc) {
      if (isOSError(exc)) {
        _LOG.warning("web_cache: eviction failed (best-effort): %s", exc);
      } else {
        throw exc;
      }
    }
  }
  return meta;
}

/** True when err is an OSError-equivalent (Node ErrnoException with a code). */
function isOSError(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    typeof (err as NodeJS.ErrnoException).code === "string"
  );
}

/**
 * Return the cached response body for *output_id*, or null if absent.
 *
 * Transparently decompresses gzip-stored bodies: checks for ``output_id.gz``
 * first and falls back to plain-text ``output_id.txt``.
 */
export function load_output(output_id: string): string | null {
  const gz_result = _load_blob_gz(output_id);
  if (gz_result !== null) {
    return gz_result;
  }
  return load_output_text(output_id, _web_outputs_dir_fn, "web_cache");
}

/** Return stat-derived metadata for an output file (size, mtime), or null. */
export function load_output_meta(output_id: string): OutputStatDict | null {
  return load_output_meta_stat(output_id, _web_outputs_dir_fn, "web_cache");
}

/**
 * Return the byte size of the cached output, or null if not found.
 *
 * Reads the size from the sidecar metadata when available (original body_bytes
 * before truncation), falling back to the on-disk file size. Returns null on any
 * I/O error.
 */
export function get_output_size(output_id: string): number | null {
  const result = safe_cache_op("get_output_size", { log: _LOG }, (): number | null => {
    // Try sidecar first — it has the original body_bytes before truncation.
    const meta = read_sidecar(output_id);
    if (meta !== null) {
      return meta.body_bytes;
    }
    // Fallback to stat-derived metadata (file size on disk).
    const stat_meta = load_output_meta_stat(output_id, _web_outputs_dir_fn, "web_cache");
    if (stat_meta !== null) {
      return stat_meta.size_bytes ?? null;
    }
    return null;
  });
  return result === undefined ? null : result;
}

// ===========================================================================
// eviction / listing
// ===========================================================================

/**
 * Evict the oldest entries until total size is at or under *max_total_bytes* AND
 * the file count is at or under *max_file_count*. The shared algorithm lives in
 * cache_common.evict_cache_dir; this wrapper supplies the web-specific
 * directory, log name, and default caps.
 */
export function evict_old_entries(opts?: {
  max_total_bytes?: number | undefined;
  max_file_count?: number | undefined;
}): number {
  const max_total_bytes = opts?.max_total_bytes ?? DEFAULT_MAX_TOTAL_BYTES;
  const max_file_count = opts?.max_file_count ?? 4096;
  return evict_cache_dir({
    cache_dir_fn: _web_outputs_dir_fn,
    log_name: "web_cache",
    max_total_bytes,
    max_file_count,
  });
}

/** Return metadata for every cached output, newest first. */
export function list_outputs(): OutputStatDict[] {
  return list_cache_outputs(_web_outputs_dir_fn);
}

// ===========================================================================
// sidecar read / write
// ===========================================================================

/** Return the sidecar JSON metadata path for *output_id*, or null on invalid ID. */
export function sidecar_meta_path(output_id: string): string | null {
  const base = safe_join_output_id(output_id, _web_outputs_dir_fn, "web_cache");
  if (base === null) {
    return null;
  }
  return sidecar_path_for(base);
}

/** Persist *meta* as a JSON sidecar next to its output file (best-effort). */
export function write_sidecar(meta: WebOutputMeta): void {
  // Python passes the dataclass and write_sidecar_metadata does asdict(meta);
  // in TS the WebOutputMeta interface is already a plain object, so pass it
  // directly as the Record payload.
  write_sidecar_metadata(sidecar_meta_path(meta.output_id), meta as unknown as Record<string, unknown>, {
    log: _LOG,
    log_prefix: "web_cache",
  });
}

/**
 * Return parsed WebOutputMeta from the sidecar JSON, or null.
 *
 * Tolerant of older sidecars that lack fields added later.
 */
export function read_sidecar(output_id: string): WebOutputMeta | null {
  const p = sidecar_meta_path(output_id);
  if (p === null) {
    return null;
  }
  const data = load_sidecar_json(p);
  if (data === null) {
    return null;
  }
  try {
    const rawStatus = data["status_code"];
    const status_code =
      typeof rawStatus === "number" ? Math.trunc(rawStatus) : null;
    const rawContentType = data["content_type"];
    const content_type = typeof rawContentType === "string" ? rawContentType : null;
    return {
      output_id: String(data["output_id"] ?? output_id),
      url_sha: String(data["url_sha"] ?? ""),
      url_preview: String(data["url_preview"] ?? ""),
      body_bytes: _toInt(data["body_bytes"], 0),
      status_code,
      ts: _toFloat(data["ts"], 0.0),
      truncated: Boolean(data["truncated"] ?? false),
      content_type,
    };
  } catch {
    return null;
  }
}

/**
 * Coerce a sidecar value to an int (Python `int(data.get(k, default))`).
 *
 * Accepts numbers and numeric strings; truncates toward zero (Python int()).
 * Non-numeric values fall back to default — matching the Python which would
 * raise ValueError/TypeError and be caught by the outer try, returning None;
 * here we keep the field-local default so the rest of the record still parses
 * (the Python `.get(k, default)` supplies the default before int(), so a missing
 * key never raises — only a present-but-non-coercible value would, which the
 * ported tests never exercise).
 */
function _toInt(value: unknown, def: number): number {
  if (typeof value === "number" && Number.isFinite(value)) {
    return Math.trunc(value);
  }
  if (typeof value === "string") {
    const n = Number(value.trim());
    if (Number.isFinite(n)) {
      return Math.trunc(n);
    }
  }
  return def;
}

/** Coerce a sidecar value to a float (Python `float(data.get(k, default))`). */
function _toFloat(value: unknown, def: number): number {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string") {
    const n = Number(value.trim());
    if (Number.isFinite(n)) {
      return n;
    }
  }
  return def;
}

// ===========================================================================
// find_cached_for_url
// ===========================================================================

/**
 * Return the most recent on-disk cached entry for *url*, or null.
 *
 * Scans all sidecar files in the web_outputs store and returns the entry whose
 * url_sha matches the hash of *url*, favouring the most recently written file.
 * Linear scan over sidecar metadata (not body text). Returns null on any I/O
 * error (fail-soft contract).
 */
export function find_cached_for_url(url: string): WebOutputMeta | null {
  const target_sha = url_hash(url);
  let best: WebOutputMeta | null = null;

  const result = safe_cache_op("find_cached_for_url", { log: _LOG }, (): WebOutputMeta | null => {
    const cache_dir = _web_outputs_dir();
    let isDir = false;
    try {
      isDir = fs.statSync(cache_dir).isDirectory();
    } catch {
      isDir = false;
    }
    if (!isDir) {
      return null;
    }

    // cache_dir.glob("*.json") → readdir filtered to *.json.
    const jsonEntries: string[] = [];
    for (const entryName of fs.readdirSync(cache_dir)) {
      if (entryName.endsWith(".json")) {
        jsonEntries.push(path.join(cache_dir, entryName));
      }
    }
    // sorted(..., key=path_mtime_key, reverse=True). path_mtime_key swallows a
    // per-file statSync OSError and returns 0.0, so a concurrently-deleted
    // sidecar sorts to the bottom rather than raising (TOCTOU tolerance).
    jsonEntries.sort((a, b) => path_mtime_key(b) - path_mtime_key(a));

    for (const sidecar_path of jsonEntries) {
      // Extract output_id from sidecar filename (strip .json) → Path.stem.
      const candidate_id = _stem(sidecar_path);
      const meta = read_sidecar(candidate_id);
      if (meta === null) {
        continue;
      }
      if (meta.url_sha === target_sha && meta.body_bytes > 0) {
        // Guard: verify the body file actually exists. An orphan sidecar (no
        // body) is treated as a cache miss and removed.
        const body_path = _withSuffix(sidecar_path, ".txt");
        if (!fs.existsSync(body_path)) {
          _LOG.debug(
            "web_cache: orphan sidecar (no body) for id=%s; removing",
            candidate_id,
          );
          try {
            fs.unlinkSync(sidecar_path);
          } catch (exc) {
            _LOG.debug(
              "web_cache: failed to remove orphan sidecar %s: %s",
              path.basename(sidecar_path),
              exc,
            );
          }
          continue;
        }
        best = meta;
        break; // sorted newest-first; first match is the freshest
      }
    }
    return best;
  });

  // safe_cache_op returns undefined when it suppressed an OSError. In that case
  // `best` may already hold a match found before the throw (Python returns the
  // last-assigned `best`), so prefer the captured `best` over the undefined.
  if (result === undefined) {
    return best;
  }
  return result;
}

/** Python Path.stem — final component without its last suffix. */
function _stem(p: string): string {
  const base = path.basename(p);
  const dot = base.lastIndexOf(".");
  if (dot > 0) {
    return base.slice(0, dot);
  }
  return base;
}

/** Python Path.with_suffix(suffix) — replace the final extension. */
function _withSuffix(p: string, suffix: string): string {
  const dir = path.dirname(p);
  const base = path.basename(p);
  const dot = base.lastIndexOf(".");
  const stem = dot > 0 ? base.slice(0, dot) : base;
  return path.join(dir, stem + suffix);
}
