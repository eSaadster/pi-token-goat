/**
 * WebFetch image downloader: HTTP fetch + shrink + cache.
 *
 * Faithful TypeScript port of src/token_goat/webfetch.py.
 *
 * Provides `fetch_url()`, which downloads a URL to the local web cache
 * directory and returns the local path. Images are automatically passed through
 * `image_shrink.shrink_if_image()` to reduce token cost before they reach the
 * model.
 *
 * Security hardening
 * ------------------
 *  - SSRF guard (`_is_ssrf_safe`): rejects private/loopback/link-local IPs,
 *    metadata endpoints (GCP/AWS), non-http/https schemes, and unresolvable
 *    hostnames (fail-closed by default; opt out with
 *    TOKEN_GOAT_WEBFETCH_ALLOW_UNRESOLVED=1).
 *  - Post-redirect SSRF check: validates the *final* URL after the client
 *    follows redirects, closing the open-redirect bypass vector.
 *  - Streaming with size cap: `_stream_to_file` enforces `max_size_bytes`
 *    during download so a large response cannot exhaust disk space.
 *  - Sidecar metadata validation: ETag/Last-Modified sidecars are size-capped,
 *    key-allowlisted, and value-truncated before use.
 *
 * ===========================================================================
 * TWO INJECTABLE SEAMS (mirror the Python test's two patch points)
 * ===========================================================================
 *
 * 1. HTTP client seam — `_setHttpClient(factory | null)`.
 *    Python tests do `patch("httpx.Client", return_value=client)` where the
 *    client exposes:
 *        client.stream(method, url, opts?) -> ResponseCtx
 *        client.get(url, { headers }?)     -> ResponseCtx  (revalidation path)
 *        client.__enter__ / client.__exit__ (context manager)
 *    A ResponseCtx is itself a context manager exposing:
 *        .status_code : number
 *        .url         : string   (the FINAL url after redirects)
 *        .headers     : { get(name): string | null | undefined }  (dict-like)
 *        .iter_bytes(): Iterable<Uint8Array | Buffer>  (byte chunks)
 *        .raise_for_status(): void   (throws HttpStatusError on 4xx/5xx)
 *        .__enter__ / .__exit__       (context manager)
 *    Map `patch("httpx.Client", return_value=client)` ->
 *        webfetch._setHttpClient(() => client).
 *    The default factory (`_setHttpClient(null)`) returns a real client built
 *    on global `fetch` + `node:dns`, implementing the SAME minimal interface,
 *    pinning the connection to a pre-validated IP.
 *
 * 2. Resolver seam — `_setGetaddrinfo(fn | null)`.
 *    Python tests do `patch("socket.getaddrinfo", return_value=fake_addrinfo)`
 *    / `side_effect=OSError(...)`. fake_addrinfo is a list of Python
 *    getaddrinfo tuples: `[family, type, proto, canonname, sockaddr]` where
 *    `sockaddr` is `[address, port]` (IPv4) or `[address, port, flow, scope]`
 *    (IPv6). The SSRF code reads `sockaddr[0]` (the address). Map
 *    `patch("socket.getaddrinfo", return_value=fake_addrinfo)` ->
 *        webfetch._setGetaddrinfo(() => fakeAddrinfo)
 *    and `side_effect=OSError(...)` -> a function that throws.
 *    The default resolver (`_setGetaddrinfo(null)`) uses `node:dns` lookup and
 *    returns tuples in the same shape.
 *
 * ASYNC BOUNDARY
 * --------------
 * Node DNS is async, so the functions that resolve DNS become async in TS:
 *     _is_ssrf_safe(url): Promise<boolean>
 *     _resolve_and_validate_ip(host): Promise<string>
 *     fetch_url(...): Promise<string>
 *     _validate_response_url(url): Promise<void>
 * PURE helpers stay sync. Tests map `webfetch._is_ssrf_safe(url)` ->
 * `await webfetch._is_ssrf_safe(url)` and `_resolve_and_validate_ip(host)` ->
 * `await ...`.
 *
 * Parity notes (Python -> TS)
 * ---------------------------
 *  - pathlib.Path -> string paths; sha256 via node:crypto; byte math via Buffer.
 *  - Python ipaddress is_private/is_loopback/is_link_local/is_reserved ->
 *    data-driven CIDR tables in _ip_is_blocked, transcribed 1:1 from CPython
 *    3.13.2 ipaddress.py (_IPv4Constants/_IPv6Constants). NOTE: 100.64.0.0/10
 *    (CGNAT) is NOT blocked — 3.13 made it the _public_network (it was private
 *    in 3.11/3.12); the guard matches the shipped Python tool's 3.13 runtime.
 *  - html.unescape -> _html_unescape (full HTML5 table embedded in
 *    _html_entities.ts; same longest-prefix-match algorithm).
 *  - Python str slicing counts CODE POINTS; user-facing truncation uses
 *    [...s].slice(...).join("") to match.
 *  - str.splitlines() -> _splitlines (drops a trailing empty + splits on the
 *    Python line-boundary set; for the ASCII inputs the tests use, "\n" split
 *    suffices, but we match splitlines faithfully).
 *  - json.dumps default separators ", "/": " + ensure_ascii -> _jsonDumps.
 *  - image_shrink.shrink_if_image is ASYNC in TS; fetch_url awaits it. The
 *    pure return-the-cached-path branches still await where Python returned
 *    image_shrink.shrink_if_image(...).
 *  - Internal self-calls that a test spies on (_is_ssrf_safe,
 *    _resolve_and_validate_ip, _validate_response_url) are routed through
 *    `import * as self` so vi.spyOn(webfetch, "...") is observed.
 */

import crypto from "node:crypto";
import dns from "node:dns";
import fs from "node:fs";
import path from "node:path";
import { URL } from "node:url";

import * as image_shrink from "./image_shrink.js";
import * as paths from "./paths.js";
import * as self from "./webfetch.js";
import { sanitize_log_str } from "./hooks_common.js";
import { registerReset } from "./reset.js";
import { getLogger } from "./util.js";

import {
  HTML5_ENTITIES,
  INVALID_CHARREFS,
  INVALID_CODEPOINTS,
} from "./_html_entities.js";

// Re-export `paths` so test code that calls `webfetch.paths.web_cache_dir()`
// (Python `webfetch.paths.web_cache_dir()`) resolves through this module's
// binding. The Python name is web_cache_dir(); the TS analogue is webCacheDir().
export { paths };

const _LOG = getLogger("webfetch");

export const __all__ = [
  "is_image_url",
  "is_image_content_type",
  "cleanup_stale_downloads",
  "fetch_url",
] as const;

// ===========================================================================
// HTTP client seam (mirror of patch("httpx.Client", ...))
// ===========================================================================

/**
 * Minimal response interface a client.stream(...) / client.get(...) returns.
 * Mirrors the httpx streaming Response shape the Python tests build by hand.
 * It is itself a context manager (enter/exit) because the stream path uses
 * `with client.stream(...) as r:`.
 */
export interface WebfetchResponse {
  status_code: number;
  /** Final URL after the client followed redirects. */
  url: string;
  headers: { get(name: string): string | null | undefined };
  // Async-iterable so the real fetch client can stream resp.body chunk by chunk
  // (letting _stream_to_file enforce the size cap mid-stream); sync iterables
  // (e.g. a test mock returning an array) are also accepted by for-await.
  iter_bytes(): AsyncIterable<Uint8Array | Buffer> | Iterable<Uint8Array | Buffer>;
  raise_for_status(): void;
  enter?(): WebfetchResponse;
  exit?(): void;
}

/**
 * Minimal client interface a factory returns. Mirrors the httpx.Client shape
 * the Python tests build by hand: a context manager exposing stream()/get().
 */
export interface WebfetchClient {
  stream(
    method: string,
    url: string,
    opts?: Record<string, unknown>,
  ): WebfetchResponse | Promise<WebfetchResponse>;
  get(url: string, opts?: { headers?: Record<string, string> }): WebfetchResponse | Promise<WebfetchResponse>;
  enter?(): WebfetchClient;
  exit?(): void;
}

/** Options passed to a client factory (timeout + pinned IP, like httpx kwargs). */
export interface ClientFactoryOpts {
  timeout: number;
  follow_redirects: boolean;
  pinned_ip: string;
  hostname: string;
}

export type ClientFactory = (opts: ClientFactoryOpts) => WebfetchClient;

let _httpClientFactory: ClientFactory | null = null;

/**
 * Test/late-layer seam: inject an HTTP client factory (or null to restore the
 * real fetch/node:dns-based default). Map
 * `patch("httpx.Client", return_value=client)` ->
 * `_setHttpClient(() => client)`.
 */
export function _setHttpClient(factory: ClientFactory | null): void {
  _httpClientFactory = factory;
}

// ===========================================================================
// Resolver seam (mirror of patch("socket.getaddrinfo", ...))
// ===========================================================================

/**
 * A Python getaddrinfo tuple: [family, type, proto, canonname, sockaddr].
 * sockaddr is [address, port] for IPv4 or [address, port, flow, scope] for
 * IPv6. The SSRF code reads sockaddr[0]. We model it as an array so a test can
 * build the exact same shape the Python tests build.
 */
export type AddrInfoTuple = [
  number,
  number,
  number,
  string,
  [string, number, ...number[]],
];

export type GetaddrinfoFn = (
  host: string,
  port: number | null,
) => AddrInfoTuple[] | Promise<AddrInfoTuple[]>;

let _getaddrinfoFn: GetaddrinfoFn | null = null;

/**
 * Test/late-layer seam: inject a getaddrinfo implementation (or null to restore
 * the real node:dns-based default). Map
 * `patch("socket.getaddrinfo", return_value=fake_addrinfo)` ->
 * `_setGetaddrinfo(() => fakeAddrinfo)` and `side_effect=OSError(...)` -> a
 * function that throws.
 */
export function _setGetaddrinfo(fn: GetaddrinfoFn | null): void {
  _getaddrinfoFn = fn;
}

/** An OSError-equivalent: thrown by the resolver when a host cannot resolve. */
export class OSErrorLike extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OSError";
  }
}

/**
 * Default resolver: node:dns lookup -> Python-getaddrinfo-shaped tuples.
 * Throws OSErrorLike on resolution failure (the Python socket.gaierror /
 * OSError analogue). Returns all addresses (dual-stack) so the SSRF checks see
 * every resolved IP, matching socket.getaddrinfo(..., proto=IPPROTO_TCP).
 */
async function _defaultGetaddrinfo(host: string): Promise<AddrInfoTuple[]> {
  let records: dns.LookupAddress[];
  try {
    records = await new Promise<dns.LookupAddress[]>((resolve, reject) => {
      dns.lookup(host, { all: true, verbatim: true }, (err, addresses) => {
        if (err) {
          reject(err);
        } else {
          resolve(addresses);
        }
      });
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new OSErrorLike(msg);
  }
  // socket.AF_INET = 2, AF_INET6 = 10 (Linux); SOCK_STREAM = 1; IPPROTO_TCP = 6.
  return records.map((rec): AddrInfoTuple => {
    const family = rec.family === 6 ? 10 : 2;
    const sockaddr: [string, number, ...number[]] =
      rec.family === 6 ? [rec.address, 0, 0, 0] : [rec.address, 0];
    return [family, 1, 6, "", sockaddr];
  });
}

/** Call the active resolver seam (or the default) for *host*. */
async function _callGetaddrinfo(host: string): Promise<AddrInfoTuple[]> {
  if (_getaddrinfoFn !== null) {
    return await _getaddrinfoFn(host, null);
  }
  return await _defaultGetaddrinfo(host);
}

registerReset(() => {
  _httpClientFactory = null;
  _getaddrinfoFn = null;
});

// ===========================================================================
// Header / URL sanitation
// ===========================================================================

/**
 * Strip CRLF from an HTTP header value and truncate to *max_len*.
 *
 * Stored ETag / Last-Modified values come from untrusted server responses.
 * Without stripping \r / \n a malicious server can inject arbitrary headers
 * into the next conditional request by returning a crafted ETag.
 *
 * Python `sanitized[:max_len]` counts code points -> [...s].slice(0, n).
 */
export function _sanitize_header_value(value: string, max_len = 512): string {
  const sanitized = value.split("\r").join("").split("\n").join("");
  return _codePointSlice(sanitized, 0, max_len);
}

const _MAX_URL_IN_ERROR = 200; // chars kept in error messages
const _MAX_URL_LEN = 8192; // hard cap on URL length

/**
 * Truncate *url* for safe inclusion in error/log messages. Strips \r/\n and
 * caps to *max_len* code points, appending an ellipsis (… = U+2026) when the
 * URL was longer.
 */
export function _truncate_url(url: string, max_len: number = _MAX_URL_IN_ERROR): string {
  const sanitized = url.split("\r").join("").split("\n").join("");
  if (_codePointLength(sanitized) > max_len) {
    return _codePointSlice(sanitized, 0, max_len) + "…";
  }
  return sanitized;
}

// ===========================================================================
// Image-extension / content-type heuristics
// ===========================================================================

/** Common image extensions to detect from URL (byte-identical to Python). */
export const IMAGE_URL_EXTS: readonly string[] = [
  ".jpg",
  ".jpeg",
  ".png",
  ".webp",
  ".avif",
  ".gif",
  ".bmp",
  ".tiff",
  ".tif",
];

/**
 * MIME type -> file extension mapping used by _suffix_for(). Only raster
 * formats Pillow can decompress and recompress are listed. SVG (XML, not a
 * raster bitmap) and PDF (document) are deliberately absent. Falls back to
 * ".bin" for anything not listed here.
 */
const _CONTENT_TYPE_EXT: Record<string, string> = {
  "image/jpeg": ".jpg",
  "image/png": ".png",
  "image/webp": ".webp",
  "image/avif": ".avif",
  "image/gif": ".gif",
  "image/bmp": ".bmp",
  "image/tiff": ".tiff",
};

/** Hostnames that must never be fetched (SSRF protection). */
const _BLOCKED_HOSTNAMES: ReadonlySet<string> = new Set([
  "localhost",
  "ip6-localhost", // common /etc/hosts alias for ::1
  "ip6-loopback", // common /etc/hosts alias for ::1
  "metadata.google.internal", // GCP metadata endpoint
  "169.254.169.254", // AWS/Azure/GCP instance metadata (bare IP literal)
]);

/**
 * Set TOKEN_GOAT_WEBFETCH_ALLOW_UNRESOLVED=1 to allow unresolvable hostnames.
 * Default is fail-closed: an unresolvable hostname is treated as blocked.
 *
 * Python reads this at module load. The TS port reads it at call time inside
 * _is_ssrf_safe so a test that sets the env var after import is honoured
 * (Python tests reload the module; reading at call time is equivalent and
 * strictly more flexible without changing the default behaviour).
 */
function _allowUnresolved(): boolean {
  const raw = (process.env.TOKEN_GOAT_WEBFETCH_ALLOW_UNRESOLVED ?? "").trim();
  return raw === "1" || raw === "true" || raw === "yes" || raw === "on";
}

/**
 * Return the configured HTTP request timeout in seconds.
 *
 * Reads TOKEN_GOAT_WEBFETCH_TIMEOUT_SECS at call time so tests can set the env
 * var after import without a module reload. Invalid values fall back to the
 * 30 s default with a debug log rather than crashing the hook.
 */
export function _webfetch_timeout(): number {
  const raw = (process.env.TOKEN_GOAT_WEBFETCH_TIMEOUT_SECS ?? "").trim();
  if (!raw) {
    return 30.0;
  }
  const val = _pyFloat(raw);
  if (val === null) {
    _LOG.debug(
      "TOKEN_GOAT_WEBFETCH_TIMEOUT_SECS=%s is not a valid float; using 30s default",
      _pyRepr(raw),
    );
    return 30.0;
  }
  if (val <= 0) {
    _LOG.debug(
      "TOKEN_GOAT_WEBFETCH_TIMEOUT_SECS=%s is not positive; using 30s default",
      _pyRepr(raw),
    );
    return 30.0;
  }
  return val;
}

// ===========================================================================
// SSRF guard
// ===========================================================================

/**
 * Return True only if the URL is safe to fetch (not an SSRF risk).
 *
 * Blocks:
 *  - Non-http/https schemes (file://, ftp://, etc.)
 *  - Known metadata hostnames (localhost, metadata.google.internal)
 *  - Private / loopback / link-local IP addresses:
 *      127.x.x.x, 10.x, 172.16-31.x, 192.168.x, 169.254.x, ::1, fc00::/7,
 *      fe80::/10
 *  - Bare IP literals for the above ranges
 *  - Unresolvable hostnames (fail-closed by default; opt out with
 *    TOKEN_GOAT_WEBFETCH_ALLOW_UNRESOLVED=1)
 *
 * Async because the DNS resolution goes through the resolver seam (node:dns is
 * async). Test maps webfetch._is_ssrf_safe(url) -> await webfetch._is_ssrf_safe(url).
 */
export async function _is_ssrf_safe(url: string): Promise<boolean> {
  let parsed: ParsedUrl;
  try {
    parsed = _urlparse(url);
  } catch {
    return false;
  }

  if (parsed.scheme !== "http" && parsed.scheme !== "https") {
    return false;
  }

  const hostname = parsed.hostname;
  if (!hostname) {
    return false;
  }

  // rstrip(".") strips the trailing DNS root dot ("example.com." -> "example.com").
  const hostname_lower = _rstripDot(hostname.toLowerCase());
  if (_BLOCKED_HOSTNAMES.has(hostname_lower)) {
    _LOG.warning("SSRF guard: blocked hostname %s in URL", _pyRepr(hostname));
    return false;
  }

  // Resolve the hostname and check every returned address. A dual-stack host
  // can return a safe public IPv4 and a private IPv6 in the same response, and
  // the OS / client can pick either one at connect time.
  let addr_info: AddrInfoTuple[];
  try {
    addr_info = await _callGetaddrinfo(hostname_lower);
  } catch {
    if (_allowUnresolved()) {
      _LOG.debug(
        "SSRF guard: unresolvable hostname %s allowed (opt-out active)",
        _pyRepr(hostname),
      );
      return true;
    }
    // Fail-closed: an unresolvable hostname is treated as blocked so internal
    // hostnames invisible from outside a VPC cannot be probed.
    _LOG.warning("SSRF guard: blocked unresolvable hostname %s", _pyRepr(hostname));
    return false;
  }

  for (const tuple of addr_info) {
    const sockaddr = tuple[4];
    const ip_str = sockaddr[0];
    const norm = _normalizeIp(ip_str);
    if (norm === null) {
      continue;
    }
    if (_ip_is_blocked(norm)) {
      _LOG.warning(
        "SSRF guard: blocked %s (resolves to %s which is private/loopback/link-local)",
        _pyRepr(hostname),
        ip_str,
      );
      return false;
    }
  }

  return true;
}

/**
 * Quick heuristic: URL ends with an image extension (case-insensitive, ignoring
 * query). Rejects URLs longer than _MAX_URL_LEN before parsing.
 *
 * Pure + sync. This is one of the two signatures hooks_fetch.ts requires.
 */
export function is_image_url(url: string): boolean {
  if (url.length > _MAX_URL_LEN) {
    return false;
  }
  let parsed: ParsedUrl;
  try {
    parsed = _urlparse(url);
  } catch {
    return false;
  }
  if (parsed.scheme !== "http" && parsed.scheme !== "https") {
    return false;
  }
  const p = (parsed.path || "").toLowerCase();
  return IMAGE_URL_EXTS.some((ext) => p.endsWith(ext));
}

/** Return True if the Content-Type header indicates an image. */
export function is_image_content_type(content_type: string): boolean {
  return content_type.toLowerCase().startsWith("image/");
}

// ===========================================================================
// Cache paths + sidecar metadata
// ===========================================================================

/** Cache filename: <sha256-of-url>.<suffix> */
export function _cache_path_for(url: string, suffix: string): string {
  const h = crypto.createHash("sha256").update(Buffer.from(url, "utf-8")).digest("hex");
  return path.join(paths.webCacheDir(), `${h}${suffix}`);
}

/**
 * Derive a sensible file suffix from the URL path extension or Content-Type.
 *
 * Checks the URL path first so the URL's extension takes precedence over a
 * possibly generic Content-Type. Falls back to a MIME-type mapping when the URL
 * has no recognizable extension. Returns ".bin" when neither source yields a
 * known image type.
 */
export function _suffix_for(url: string, content_type = ""): string {
  const parsed = _urlparse(url);
  const p = (parsed.path || "").toLowerCase();
  for (const ext of IMAGE_URL_EXTS) {
    if (p.endsWith(ext)) {
      return ext;
    }
  }
  const ct = content_type.toLowerCase().split(";")[0]!.trim();
  return _CONTENT_TYPE_EXT[ct] ?? ".bin";
}

/** Path to the JSON metadata sidecar for a cached file: <name>.meta */
export function _sidecar_path(cache_path: string): string {
  // Python cache_path.with_suffix(cache_path.suffix + ".meta") appends ".meta"
  // to the existing suffix, e.g. "abc.png" -> "abc.png.meta".
  return cache_path + ".meta";
}

const _MAX_SIDECAR_BYTES = 4096; // ETag + Last-Modified never need more
const _ALLOWED_META_KEYS: ReadonlySet<string> = new Set([
  "etag",
  "last_modified",
  "content_sha256",
  "shrunk_path",
]);
const _MAX_META_VALUE_LEN = 512; // per-value cap
const _MAX_SHRUNK_PATH_LEN = 4096; // absolute path to the shrunk artifact

/**
 * Read ETag/Last-Modified metadata for a cached file, or return {}.
 *
 * Guards: rejects sidecars > 4 KB, validates a flat dict[str, str], returns
 * only allow-listed keys, truncates values, and strips CRLF defense-in-depth.
 */
export function _read_cache_meta(cache_path: string): Record<string, string> {
  const sidecar = _sidecar_path(cache_path);
  let st: fs.Stats;
  try {
    st = fs.statSync(sidecar);
  } catch {
    return {}; // not exists
  }
  try {
    const size = st.size;
    if (size > _MAX_SIDECAR_BYTES) {
      _LOG.warning(
        "cache metadata file too large (%d bytes); discarding: %s",
        size,
        path.basename(sidecar),
      );
      return {};
    }
    const raw = fs.readFileSync(sidecar, "utf-8");
    const parsed: unknown = JSON.parse(raw);
    if (!_isPlainObject(parsed)) {
      _LOG.debug("cache metadata is not a dict; discarding: %s", path.basename(sidecar));
      return {};
    }
    const result: Record<string, string> = {};
    for (const [k, v] of Object.entries(parsed)) {
      if (!_ALLOWED_META_KEYS.has(k)) {
        continue;
      }
      if (typeof v !== "string") {
        _LOG.debug("cache metadata key %s has non-string value; skipping", _pyRepr(k));
        continue;
      }
      const cap = k === "shrunk_path" ? _MAX_SHRUNK_PATH_LEN : _MAX_META_VALUE_LEN;
      result[k] = _sanitize_header_value(v, cap);
    }
    return result;
  } catch (e) {
    _LOG.debug("corrupt cache metadata at %s; discarding: %s", path.basename(sidecar), String(e));
    return {};
  }
}

/** Dict-like response headers (httpx.Headers analogue) for _write_cache_meta. */
export interface ResponseHeadersLike {
  get(name: string): string | null | undefined;
}

/**
 * Persist ETag and/or Last-Modified from response headers alongside the cache
 * file. Header values from untrusted servers are truncated to
 * _MAX_META_VALUE_LEN before being written.
 *
 * *extra* may carry additional allow-listed keys produced locally (not from the
 * server), e.g. content_sha256 and shrunk_path. Merged in after the
 * header-derived values so the local view wins a clash. Unknown keys ignored.
 */
export function _write_cache_meta(
  cache_path: string,
  response_headers: ResponseHeadersLike,
  opts: { extra?: Record<string, string> | null } = {},
): void {
  const extra = opts.extra ?? null;
  const meta: Record<string, string> = {};
  const etag = response_headers.get("etag");
  if (etag) {
    meta["etag"] = _sanitize_header_value(etag, _MAX_META_VALUE_LEN);
  }
  const lm = response_headers.get("last-modified");
  if (lm) {
    meta["last_modified"] = _sanitize_header_value(lm, _MAX_META_VALUE_LEN);
  }
  if (extra) {
    for (const [k, v] of Object.entries(extra)) {
      if (!_ALLOWED_META_KEYS.has(k) || typeof v !== "string") {
        continue;
      }
      const cap = k === "shrunk_path" ? _MAX_SHRUNK_PATH_LEN : _MAX_META_VALUE_LEN;
      meta[k] = _sanitize_header_value(v, cap);
    }
  }
  if (Object.keys(meta).length === 0) {
    return;
  }
  try {
    fs.writeFileSync(_sidecar_path(cache_path), _jsonDumps(meta), "utf-8");
  } catch (exc) {
    _LOG.debug("could not write cache metadata for %s: %s", path.basename(cache_path), String(exc));
  }
}

/**
 * Streaming SHA256 of *path* contents. Returns null if the file is unreadable.
 * Streams in 1 MB chunks so a 50 MB image doesn't materialize in memory.
 */
export function _hash_file_sha256(p: string): string | null {
  try {
    const h = crypto.createHash("sha256");
    const fd = fs.openSync(p, "r");
    try {
      const chunkSize = 1 << 20;
      const buf = Buffer.allocUnsafe(chunkSize);
      for (;;) {
        const n = fs.readSync(fd, buf, 0, chunkSize, null);
        if (n === 0) {
          break;
        }
        h.update(buf.subarray(0, n));
      }
    } finally {
      fs.closeSync(fd);
    }
    return h.digest("hex");
  } catch (exc) {
    _LOG.debug("could not hash %s for content dedup: %s", path.basename(p), String(exc));
    return null;
  }
}

// ===========================================================================
// Content-hash index (cross-URL dedup)
// ===========================================================================

/** Path to the content-hash index pointer for *content_sha256*. */
export function _content_index_path(content_sha256: string): string {
  return path.join(paths.webCacheDir(), "by_content", `${content_sha256}.idx`);
}

/**
 * Look up the canonical cache file for *content_sha256*, or return null.
 *
 * Returns null when the index entry is missing, malformed, or points at a file
 * that has since been evicted. Stale entries are proactively cleaned up.
 */
export function _read_content_index(content_sha256: string): string | null {
  const idx = _content_index_path(content_sha256);
  let st: fs.Stats;
  try {
    st = fs.statSync(idx);
  } catch {
    return null; // not exists
  }
  try {
    const size = st.size;
    if (size > _MAX_SIDECAR_BYTES) {
      _LOG.debug("content index too large (%d bytes); discarding: %s", size, path.basename(idx));
      return null;
    }
    const raw = fs.readFileSync(idx, "utf-8");
    const parsed: unknown = JSON.parse(raw);
    if (!_isPlainObject(parsed)) {
      return null;
    }
    const target = parsed["cache_path"];
    if (typeof target !== "string" || !target) {
      return null;
    }
    if (!fs.existsSync(target)) {
      // Pointer is stale — eviction or manual cleanup deleted the target.
      try {
        fs.unlinkSync(idx);
      } catch {
        // suppress OSError
      }
      return null;
    }
    return target;
  } catch (exc) {
    _LOG.debug("corrupt content index at %s; discarding: %s", path.basename(idx), String(exc));
    return null;
  }
}

/** Record that *content_sha256* maps to *cache_path* (best-effort). */
export function _write_content_index(content_sha256: string, cache_path: string): void {
  const idx = _content_index_path(content_sha256);
  try {
    paths.ensureDir(path.dirname(idx));
    const payload = _jsonDumps({ cache_path });
    fs.writeFileSync(idx, payload, "utf-8");
  } catch (exc) {
    _LOG.debug("could not write content index for %s: %s", path.basename(cache_path), String(exc));
  }
}

// ===========================================================================
// Streaming download with size cap
// ===========================================================================

/** Raised when a fetch exceeds the size cap (Python RuntimeError analogue). */
export class WebfetchRuntimeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RuntimeError";
  }
}

/**
 * Write a streaming HTTP response to *dest* atomically, enforcing a size cap.
 *
 * Downloads into a ".tmp" sibling first, then renames to *dest* on success.
 * Raises WebfetchRuntimeError if the Content-Length header or accumulated byte
 * count exceeds *max_size_bytes*.
 */
export async function _stream_to_file(
  response: WebfetchResponse,
  dest: string,
  max_size_bytes: number,
): Promise<void> {
  const raw_cl = response.headers.get("content-length") ?? "0";
  let content_length: number;
  const parsed = _pyInt(raw_cl);
  if (parsed === null) {
    _LOG.debug("webfetch: non-integer Content-Length %s; skipping pre-check", _pyRepr(raw_cl));
    content_length = 0;
  } else {
    content_length = parsed;
  }
  if (content_length > max_size_bytes) {
    throw new WebfetchRuntimeError(
      `file too large: ${content_length} bytes > ${max_size_bytes}`,
    );
  }

  const tmp = dest + ".tmp";
  let written = 0;
  let oversize_error: WebfetchRuntimeError | null = null;
  try {
    const fd = fs.openSync(tmp, "w");
    try {
      for await (const chunk of response.iter_bytes()) {
        const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        written += buf.length;
        if (written > max_size_bytes) {
          oversize_error = new WebfetchRuntimeError(
            `file too large during stream: ${written} > ${max_size_bytes}`,
          );
          break;
        }
        fs.writeSync(fd, buf, 0, buf.length, null);
      }
    } finally {
      fs.closeSync(fd);
    }
    // File is now closed; safe to clean up.
    if (oversize_error !== null) {
      _unlinkMissingOk(tmp);
      throw oversize_error;
    }
    fs.renameSync(tmp, dest);
    _LOG.debug("webfetch: streamed %d bytes to %s", written, path.basename(dest));
  } catch (e) {
    if (e instanceof WebfetchRuntimeError) {
      // Either oversize_error (already cleaned up above) or raised by caller —
      // clean up and re-raise without double-logging.
      _unlinkMissingOk(tmp);
      throw e;
    }
    _LOG.warning("webfetch: stream write failed after %d bytes: %s", written, String(e));
    _unlinkMissingOk(tmp);
    throw e;
  }
}

/**
 * Raise (via Promise rejection) if *url* is an SSRF target after redirects.
 *
 * Called with the FINAL URL after the client has resolved any redirects. Async
 * because it delegates to the async _is_ssrf_safe seam. Routed through `self`
 * so the inner _is_ssrf_safe call is observable by a test spy.
 */
export async function _validate_response_url(url: string): Promise<void> {
  if (!(await self._is_ssrf_safe(url))) {
    throw new ValueErrorLike(
      `URL blocked by SSRF safety check after redirect: ${_pyRepr(_truncate_url(url))}`,
    );
  }
}

/** Python ValueError analogue (carries an "SSRF"-matching message). */
export class ValueErrorLike extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ValueError";
  }
}

// ===========================================================================
// Stale-download cleanup
// ===========================================================================

/**
 * Remove leftover ".tmp" partial-download files from the web cache directory.
 * Returns the number of files removed.
 */
export function cleanup_stale_downloads(): number {
  const cache_dir = paths.webCacheDir();
  if (!fs.existsSync(cache_dir)) {
    return 0;
  }
  let removed = 0;
  let entries: string[];
  try {
    entries = fs.readdirSync(cache_dir);
  } catch {
    return removed;
  }
  for (const name of entries) {
    if (!name.endsWith(".tmp")) {
      continue;
    }
    const f = path.join(cache_dir, name);
    try {
      _unlinkMissingOk(f);
      removed += 1;
      _LOG.debug("cleaned up partial download: %s", name);
    } catch (exc) {
      _LOG.debug("could not remove partial download %s: %s", name, String(exc));
    }
  }
  return removed;
}

// ===========================================================================
// HTML -> text stripping
// ===========================================================================

// Precompiled once (module level) so _strip_html_to_text does not allocate 7
// new RegExp objects on every fetched HTML body. Global regexes are safe to
// reuse with String.replace — replace ignores lastIndex and matches from 0.
const _HTML_BOILERPLATE_RES: readonly RegExp[] = (
  ["script", "style", "nav", "header", "footer", "aside", "noscript"] as const
).map((tag) => new RegExp(`<${tag}[\\s>][\\s\\S]*?</${tag}>`, "gi"));

/**
 * Strip HTML boilerplate to readable text for token-efficient storage.
 *
 * Returns the stripped text as UTF-8 bytes, or the SAME input bytes (reference
 * equality, like Python's `return body`) if:
 *  - Content is not HTML (no <html or <!doctype near the top)
 *  - Stripping produces less than 20% size reduction
 *  - Any decoding/processing error occurs
 *
 * Intentionally fail-soft: any unhandled exception returns the original *body*
 * unchanged. Pure + sync. This is one of the two signatures hooks_fetch.ts
 * requires (signature: (body: Uint8Array) => Uint8Array).
 */
export function _strip_html_to_text(body: Uint8Array): Uint8Array {
  try {
    let text: string;
    try {
      // Python body.decode("utf-8", errors="replace"); Buffer.toString("utf-8")
      // substitutes U+FFFD for invalid sequences — same fail-soft contract.
      text = Buffer.from(body).toString("utf-8");
    } catch {
      return body;
    }

    // Preamble-only check: take the first 2000 CODE POINTS (Python text[:2000])
    // without spreading the whole body into an array (O(2000), not O(n)).
    const lower = _firstCodePoints(text, 2000).toLowerCase();
    if (!lower.includes("<html") && !lower.includes("<!doctype")) {
      return body; // not HTML — JSON/text/Markdown pass through unchanged
    }

    const original_len = body.length;

    // Remove script/style/nav/header/footer/aside/noscript blocks entirely.
    // (Python: rf"<{tag}[\s>].*?</{tag}>" with IGNORECASE | DOTALL.)
    for (const re of _HTML_BOILERPLATE_RES) {
      text = text.replace(re, " ");
    }

    // Convert block-level elements to newlines (IGNORECASE).
    text = text.replace(/<(?:p|div|br|li|tr|h[1-6])[^>]*>/gi, "\n");

    // Strip remaining HTML tags.
    text = text.replace(/<[^>]+>/g, "");

    // Decode HTML entities.
    text = _html_unescape(text);

    // Normalize whitespace: strip each line, then collapse blank-line runs.
    const lines = _splitlines(text).map((line) => _pyStrip(line));
    const result_lines: string[] = [];
    let empty_run = 0;
    for (const line of lines) {
      if (!line) {
        empty_run += 1;
        if (empty_run <= 2) {
          result_lines.push("");
        }
      } else {
        empty_run = 0;
        result_lines.push(line);
      }
    }

    const stripped = _pyStrip(result_lines.join("\n"));
    const stripped_bytes = Buffer.from(stripped, "utf-8");
    const stripped_len = stripped_bytes.length;

    // Only use the stripped version when it's meaningfully smaller (>=20%).
    if (stripped_len >= original_len * 0.8) {
      return body;
    }

    const marker = `[token-goat: HTML→text, ${original_len}B→${stripped_len}B]\n`;
    return Buffer.from(marker + stripped, "utf-8");
  } catch {
    return body; // fail-soft, never break caching
  }
}

/**
 * Read *cache_path*, strip HTML if applicable, and write the result back.
 *
 * No-op when the file does not exist, is unreadable, or _strip_html_to_text
 * determines the content is not HTML or the reduction is below the threshold.
 */
export function _apply_html_strip(cache_path: string): void {
  try {
    const raw = new Uint8Array(fs.readFileSync(cache_path));
    const stripped = self._strip_html_to_text(raw);
    if (stripped !== raw && !_bytesEqual(stripped, raw)) {
      fs.writeFileSync(cache_path, Buffer.from(stripped));
      _LOG.debug(
        "webfetch: HTML stripped %d→%d bytes for %s",
        raw.length,
        stripped.length,
        path.basename(cache_path),
      );
    }
  } catch (exc) {
    _LOG.debug("webfetch: HTML strip failed for %s: %s", path.basename(cache_path), String(exc));
  }
}

// ===========================================================================
// DNS-rebinding IP pin
// ===========================================================================

/**
 * Resolve *hostname* to a single IP string, validated as non-private.
 *
 * Returns the first address returned by getaddrinfo that passed SSRF
 * validation. Raises ValueErrorLike if no safe address is found (all resolved
 * to private ranges) or if the hostname is unresolvable (fail-closed).
 *
 * Async (resolver seam). Test maps webfetch._resolve_and_validate_ip(host) ->
 * await webfetch._resolve_and_validate_ip(host).
 */
export async function _resolve_and_validate_ip(hostname: string): Promise<string> {
  let addr_info: AddrInfoTuple[];
  try {
    addr_info = await _callGetaddrinfo(hostname);
  } catch (exc) {
    const msg = exc instanceof Error ? exc.message : String(exc);
    throw new ValueErrorLike(`SSRF IP-pin: cannot resolve ${_pyRepr(hostname)}: ${msg}`);
  }

  for (const tuple of addr_info) {
    const sockaddr = tuple[4];
    const ip_str = sockaddr[0];
    const norm = _normalizeIp(ip_str);
    if (norm === null) {
      continue;
    }
    if (_ip_is_blocked(norm)) {
      continue;
    }
    return ip_str; // first safe address wins
  }

  throw new ValueErrorLike(
    `SSRF IP-pin: no safe address for ${_pyRepr(hostname)} ` +
      "(all resolved addresses are private/loopback/link-local)",
  );
}

// ===========================================================================
// fetch_url
// ===========================================================================

/** Raised to mirror httpx.HTTPStatusError carry of the failing response. */
export class HttpStatusError extends Error {
  status_code: number;
  reason_phrase: string;
  constructor(status_code: number, reason_phrase: string) {
    super(`HTTP ${status_code}: ${reason_phrase}`);
    this.name = "HTTPStatusError";
    this.status_code = status_code;
    this.reason_phrase = reason_phrase;
  }
}

/** Raised to mirror httpx.TimeoutException. */
export class TimeoutException extends Error {
  constructor(message = "timeout") {
    super(message);
    this.name = "TimeoutException";
  }
}

/** Raised to mirror httpx.RequestError (network errors). */
export class RequestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RequestError";
  }
}

/**
 * Download a URL. Return the local cached path. Shrink if image and big enough.
 *
 * Raises ValueErrorLike if the URL fails SSRF safety checks. Sends ETag /
 * If-Modified-Since conditional requests when cache metadata is available;
 * returns the cached file unchanged on HTTP 304.
 *
 * DNS rebinding protection: the hostname is resolved once (in _is_ssrf_safe)
 * and the validated IP is pinned for the actual connection so a hostile DNS
 * server cannot return a different address at connect time.
 *
 * Async (DNS + image_shrink are async in the TS port).
 */
export async function fetch_url(
  url: string,
  opts: {
    shrink_if_image?: boolean;
    timeout_sec?: number | null;
    max_size_bytes?: number;
  } = {},
): Promise<string> {
  const shrink_if_image = opts.shrink_if_image ?? true;
  const timeout_sec = opts.timeout_sec ?? null;
  const max_size_bytes = opts.max_size_bytes ?? 50 * 1024 * 1024;

  // Resolve effective timeout: explicit argument wins over env var.
  const _timeout = timeout_sec !== null ? timeout_sec : _webfetch_timeout();

  if (url.length > _MAX_URL_LEN) {
    throw new ValueErrorLike(`URL too long (${url.length} chars, max ${_MAX_URL_LEN})`);
  }
  if (!(await self._is_ssrf_safe(url))) {
    throw new ValueErrorLike(`URL blocked by SSRF safety check: ${_pyRepr(_truncate_url(url))}`);
  }

  // DNS rebinding mitigation: resolve once here and pin the validated IP.
  const _hostname = _urlparse(url).hostname || "";
  let _pinned_ip: string;
  try {
    _pinned_ip = await self._resolve_and_validate_ip(_hostname);
    _LOG.debug("webfetch: pinned %s → %s", _pyRepr(_hostname), _pinned_ip);
  } catch (pin_exc) {
    // Fail-closed: if we cannot pin the IP treat it as an SSRF risk.
    const msg = pin_exc instanceof Error ? pin_exc.message : String(pin_exc);
    throw new ValueErrorLike(`URL blocked: could not pin IP for ${_pyRepr(_hostname)}: ${msg}`);
  }

  const _makeClient = (): WebfetchClient => {
    if (_httpClientFactory !== null) {
      return _httpClientFactory({
        timeout: _timeout,
        follow_redirects: true,
        pinned_ip: _pinned_ip,
        hostname: _hostname,
      });
    }
    return _makeDefaultClient({
      timeout: _timeout,
      follow_redirects: true,
      pinned_ip: _pinned_ip,
      hostname: _hostname,
    });
  };

  image_shrink.ensure_cache_dir(paths.webCacheDir());

  // Check if the file is already cached (URL-derived suffix as a best guess).
  const url_suffix = _suffix_for(url);
  const cached_path = _cache_path_for(url, url_suffix);
  if (fs.existsSync(cached_path)) {
    const meta = _read_cache_meta(cached_path);
    // Fast-path: a recorded shrunk artifact pointer lets us skip both the
    // conditional revalidation and the shrink re-hash on every repeat hit.
    const shrunk_pointer = meta["shrunk_path"];
    if (shrink_if_image && shrunk_pointer) {
      let shrunk_path: string | null = shrunk_pointer;
      // Path containment: a tampered sidecar could redirect to any file on
      // disk. Resolve symlinks then confirm the target lives under an allowed
      // cache root before trusting it.
      const allowed_roots = [
        _resolveOrSelf(paths.imageCacheDir()),
        _resolveOrSelf(paths.webCacheDir()),
      ];
      let contained = false;
      try {
        const resolved = _resolveOrSelf(shrunk_pointer);
        contained = allowed_roots.some(
          (root) => resolved === root || resolved.startsWith(root + path.sep),
        );
      } catch {
        contained = false;
      }
      if (!contained) {
        _LOG.warning(
          "web cache: shrunk_path sidecar points outside allowed cache roots " +
            "(possible tampered sidecar); ignoring pointer: %s",
          shrunk_path,
        );
        shrunk_path = null;
      }
      if (shrunk_path !== null && fs.existsSync(shrunk_path)) {
        _LOG.info("web cache hit (shrunk pointer): %s", path.basename(shrunk_path));
        return shrunk_path;
      }
    }
    // Only revalidate when we have HTTP cache validators to send.
    const has_validators = "etag" in meta || "last_modified" in meta;
    if (has_validators) {
      const headers: Record<string, string> = {};
      const etag = meta["etag"];
      if (etag !== undefined) {
        headers["If-None-Match"] = etag;
      }
      const last_modified = meta["last_modified"];
      if (last_modified !== undefined) {
        headers["If-Modified-Since"] = last_modified;
      }
      try {
        const client = _makeClient();
        const r = await _withClient(client, () => client.get(url, { headers }));
        const final_url = String(r.url);
        if (final_url !== url) {
          _LOG.info(
            "web revalidation redirected: %s -> %s",
            sanitize_log_str(url),
            sanitize_log_str(final_url),
          );
        }
        try {
          await self._validate_response_url(final_url);
        } catch (e) {
          if (e instanceof ValueErrorLike) {
            _LOG.warning(
              "revalidation redirect blocked by SSRF guard (%s -> %s); using cached file",
              sanitize_log_str(url),
              sanitize_log_str(final_url),
            );
            return cached_path;
          }
          throw e;
        }
        if (r.status_code === 304) {
          _LOG.info("web cache revalidated (304): %s", path.basename(cached_path));
          if (shrink_if_image) {
            return await image_shrink.shrink_if_image(cached_path);
          }
          return cached_path;
        }
        if (r.status_code === 200) {
          _LOG.info("web cache stale (200 on revalidation): %s", path.basename(cached_path));
        } else {
          _LOG.debug(
            "revalidation returned %s; using cached %s",
            r.status_code,
            path.basename(cached_path),
          );
          return cached_path;
        }
      } catch (exc) {
        if (exc instanceof RequestError) {
          _LOG.debug(
            "revalidation request failed (%s); using cached %s",
            String(exc),
            path.basename(cached_path),
          );
          return cached_path;
        }
        throw exc;
      }
    } else {
      _LOG.info("web cache hit (URL-derived): %s", path.basename(cached_path));
      if (shrink_if_image) {
        return await image_shrink.shrink_if_image(cached_path);
      }
      return cached_path;
    }
  }

  // Download.
  let response_headers: ResponseHeadersLike | null = null;
  let cache_path: string;
  try {
    const client = _makeClient();
    cache_path = await _withClient(client, async () => {
      const r = await client.stream("GET", url);
      return _withResponse(r, async () => {
        r.raise_for_status();
        const final_url = String(r.url);
        if (final_url !== url) {
          _LOG.info(
            "web fetch redirected: %s -> %s",
            sanitize_log_str(url),
            sanitize_log_str(final_url),
          );
        }
        await self._validate_response_url(final_url);
        const content_type = r.headers.get("content-type") ?? "";
        const suffix = _suffix_for(url, content_type);
        const cp = _cache_path_for(url, suffix);
        await _stream_to_file(r, cp, max_size_bytes);
        response_headers = r.headers;
        // Strip HTML boilerplate in-place before any caching/dedup logic.
        _apply_html_strip(cp);
        return cp;
      });
    });
  } catch (exc) {
    // ValueError: SSRF check failed after redirect. RuntimeError: size cap.
    if (exc instanceof ValueErrorLike || exc instanceof WebfetchRuntimeError) {
      throw exc;
    }
    if (exc instanceof HttpStatusError) {
      throw new WebfetchRuntimeError(
        `HTTP ${exc.status_code} fetching ${_pyRepr(_truncate_url(url))}: ${exc.reason_phrase}`,
      );
    }
    if (exc instanceof TimeoutException) {
      throw new WebfetchRuntimeError(
        `Request timed out after ${_timeout}s fetching ${_pyRepr(_truncate_url(url))}`,
      );
    }
    if (exc instanceof RequestError) {
      throw new WebfetchRuntimeError(
        `Network error fetching ${_pyRepr(_truncate_url(url))}: ${exc.name}: ${String(exc)}`,
      );
    }
    throw exc;
  }

  // Content-hash dedup: bytes are now on disk.
  const content_sha = _hash_file_sha256(cache_path);
  const extra_meta: Record<string, string> = {};
  if (content_sha !== null) {
    extra_meta["content_sha256"] = content_sha;
    const canonical = _read_content_index(content_sha);
    if (canonical !== null && canonical !== cache_path) {
      const canonical_meta = _read_cache_meta(canonical);
      const shrunk_pointer = canonical_meta["shrunk_path"];
      if (shrunk_pointer) {
        const shrunk_path = shrunk_pointer;
        if (fs.existsSync(shrunk_path) && shrink_if_image) {
          _LOG.info(
            "web content dedup hit: %s shares bytes with %s (shrunk: %s)",
            path.basename(cache_path),
            path.basename(canonical),
            path.basename(shrunk_path),
          );
          extra_meta["shrunk_path"] = shrunk_path;
          if (response_headers !== null) {
            _write_cache_meta(cache_path, response_headers, { extra: extra_meta });
          }
          return shrunk_path;
        }
        // Shrunk path missing but canonical exists; will re-shrink below.
      }
    }
  }

  // Shrink if image.
  if (shrink_if_image) {
    const shrunk = await image_shrink.shrink_if_image(cache_path);
    if (content_sha !== null && shrunk !== cache_path) {
      extra_meta["shrunk_path"] = shrunk;
    }
    if (response_headers !== null || Object.keys(extra_meta).length > 0) {
      _write_cache_meta(cache_path, response_headers ?? _emptyHeaders(), { extra: extra_meta });
    }
    if (content_sha !== null) {
      _write_content_index(content_sha, cache_path);
    }
    return shrunk;
  }

  // No shrink requested; still record metadata for cache revalidation.
  if (response_headers !== null || Object.keys(extra_meta).length > 0) {
    _write_cache_meta(cache_path, response_headers ?? _emptyHeaders(), { extra: extra_meta });
  }
  if (content_sha !== null) {
    _write_content_index(content_sha, cache_path);
  }
  return cache_path;
}

// ===========================================================================
// Default fetch/node:dns client (real implementation of the seam interface)
// ===========================================================================

/**
 * Build a real client over global fetch, pinning the connection to *pinned_ip*.
 *
 * Implements the SAME minimal interface the test mock implements. The pin is
 * effected by rewriting the request URL's host to the literal IP while keeping
 * the original Host header for SNI / virtual hosting. Redirects are followed by
 * fetch (redirect: "follow"); the final URL is exposed via response.url for the
 * post-redirect SSRF re-check. This is only used when no test factory is
 * injected, so the ported unit tests never hit the network.
 */
function _makeDefaultClient(opts: ClientFactoryOpts): WebfetchClient {
  const buildResponse = async (
    method: string,
    url: string,
    reqHeaders?: Record<string, string>,
  ): Promise<WebfetchResponse> => {
    // Pin: connect to the literal IP, preserve Host header for SNI / vhosting.
    const parsed = new URL(url);
    const originalHost = parsed.host; // host[:port]
    const isV6 = opts.pinned_ip.includes(":");
    parsed.hostname = isV6 ? `[${opts.pinned_ip}]` : opts.pinned_ip;
    const pinnedUrl = parsed.toString();

    const headers: Record<string, string> = { ...(reqHeaders ?? {}), Host: originalHost };
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), Math.trunc(opts.timeout * 1000));
    let resp: Response;
    try {
      resp = await fetch(pinnedUrl, {
        method,
        headers,
        redirect: opts.follow_redirects ? "follow" : "manual",
        signal: controller.signal,
      });
    } catch (err) {
      if (err instanceof Error && err.name === "AbortError") {
        throw new TimeoutException(`request to ${url} timed out`);
      }
      throw new RequestError(String(err));
    } finally {
      clearTimeout(timer);
    }

    // fetch follows redirects but reports the ORIGINAL request URL via resp.url
    // pointing at the pinned IP; reconstruct the logical final URL by swapping
    // the pinned host back to the original hostname so the post-redirect SSRF
    // check sees the logical address. When fetch surfaces resp.url we prefer it.
    let finalUrl = resp.url || url;
    try {
      const fu = new URL(finalUrl);
      if (fu.hostname === opts.pinned_ip || fu.hostname === `[${opts.pinned_ip}]`) {
        fu.hostname = opts.hostname;
        finalUrl = fu.toString();
      }
    } catch {
      finalUrl = url;
    }

    const response: WebfetchResponse = {
      status_code: resp.status,
      url: finalUrl,
      headers: {
        get: (name: string): string | null => resp.headers.get(name),
      },
      iter_bytes: async function* (): AsyncGenerator<Uint8Array | Buffer, void, unknown> {
        // Stream resp.body chunk by chunk so _stream_to_file can enforce the
        // size cap DURING the read (bailing mid-stream) rather than after the
        // whole body is buffered — the streaming size cap is the real guard
        // against oversized responses, especially when Content-Length is absent.
        if (!resp.body) {
          return;
        }
        const reader = resp.body.getReader();
        try {
          for (;;) {
            const { done, value } = await reader.read();
            if (done || !value) {
              break;
            }
            yield value;
          }
        } finally {
          // Fires on normal completion OR on an early break (oversize): cancel
          // so we stop pulling body bytes from the network.
          try {
            await reader.cancel();
          } catch {
            // already closed / released
          }
        }
      },
      raise_for_status: () => {
        if (resp.status >= 400) {
          throw new HttpStatusError(resp.status, resp.statusText);
        }
      },
      enter: () => response,
      exit: () => {
        // no-op
      },
    };
    return response;
  };

  return {
    // The default client returns a Promise<WebfetchResponse>: fetch is async,
    // and fetch_url awaits the stream result. The response body is STREAMED
    // (iter_bytes is an async generator over resp.body), so _stream_to_file's
    // per-chunk size cap can bail mid-stream instead of after buffering the
    // whole body. The unit tests inject a synchronous factory via
    // _setHttpClient, so this async path is integration-only.
    async stream(
      method: string,
      url: string,
    ): Promise<WebfetchResponse> {
      return buildResponse(method, url);
    },
    async get(url: string, getOpts?: { headers?: Record<string, string> }): Promise<WebfetchResponse> {
      return buildResponse("GET", url, getOpts?.headers);
    },
  };
}

// ===========================================================================
// Context-manager helpers (Python `with ... as x:`)
// ===========================================================================

/** Run *fn* with the client's enter/exit (Python `with client as c:`). */
async function _withClient<T>(client: WebfetchClient, fn: () => T | Promise<T>): Promise<T> {
  const entered = client.enter ? client.enter() : client;
  void entered;
  try {
    return await fn();
  } finally {
    if (client.exit) {
      client.exit();
    }
  }
}

/** Run *fn* with the response's enter/exit (Python `with r as resp:`). */
async function _withResponse<T>(
  resp: WebfetchResponse,
  fn: () => T | Promise<T>,
): Promise<T> {
  const entered = resp.enter ? resp.enter() : resp;
  void entered;
  try {
    return await fn();
  } finally {
    if (resp.exit) {
      resp.exit();
    }
  }
}

/** An empty headers object (httpx.Headers() analogue) for _write_cache_meta. */
function _emptyHeaders(): ResponseHeadersLike {
  return { get: () => null };
}

// ===========================================================================
// Pure helpers — URL parsing, IP range checks, Python-string semantics
// ===========================================================================

interface ParsedUrl {
  scheme: string;
  hostname: string | null;
  path: string;
}

/**
 * Minimal urllib.parse.urlparse analogue for the fields webfetch reads:
 * scheme (lowercased), hostname (lowercased, no port/brackets), path.
 *
 * Mirrors urlparse closely enough for the tests: scheme is the part before the
 * first ":", the authority is delimited by "//", the path is everything up to
 * "?"/"#". For "https:///image.png" the hostname is empty (-> null) while the
 * path is "/image.png" — matching the no-hostname-blocked test.
 */
function _urlparse(url: string): ParsedUrl {
  // Match scheme (urlparse only treats it as a scheme when it matches
  // ^[a-zA-Z][a-zA-Z0-9+.-]*: ).
  let rest = url;
  let scheme = "";
  const m = /^([a-zA-Z][a-zA-Z0-9+.\-]*):(.*)$/s.exec(url);
  if (m) {
    scheme = m[1]!.toLowerCase();
    rest = m[2]!;
  }

  let hostname: string | null = null;
  let pathStr = "";
  if (rest.startsWith("//")) {
    // authority present.
    let authEnd = rest.length;
    for (let i = 2; i < rest.length; i++) {
      const c = rest[i]!;
      if (c === "/" || c === "?" || c === "#") {
        authEnd = i;
        break;
      }
    }
    let authority = rest.slice(2, authEnd);
    const afterAuth = rest.slice(authEnd);
    // Strip userinfo.
    const at = authority.lastIndexOf("@");
    if (at >= 0) {
      authority = authority.slice(at + 1);
    }
    // Host: handle [IPv6]:port and host:port.
    if (authority.startsWith("[")) {
      const close = authority.indexOf("]");
      if (close >= 0) {
        hostname = authority.slice(1, close);
      } else {
        hostname = authority;
      }
    } else {
      const colon = authority.indexOf(":");
      hostname = colon >= 0 ? authority.slice(0, colon) : authority;
    }
    // urlparse hostname is lowercased and empty-string -> we map to "" then null.
    hostname = hostname.toLowerCase();
    if (hostname === "") {
      hostname = null;
    }
    pathStr = _pathOf(afterAuth);
  } else {
    pathStr = _pathOf(rest);
  }

  return { scheme, hostname, path: pathStr };
}

/** Extract the path component (everything before "?" or "#"). */
function _pathOf(s: string): string {
  let end = s.length;
  for (let i = 0; i < s.length; i++) {
    const c = s[i]!;
    if (c === "?" || c === "#") {
      end = i;
      break;
    }
  }
  return s.slice(0, end);
}

/** Python str.rstrip(".") for a single char. */
function _rstripDot(s: string): string {
  let end = s.length;
  while (end > 0 && s[end - 1] === ".") {
    end -= 1;
  }
  return s.slice(0, end);
}

/**
 * Normalize an IP string into a canonical {version, parts} form, unwrapping
 * IPv4-mapped IPv6. Returns null when the string is not a valid IP (Python
 * ipaddress.ip_address raising ValueError -> `continue`).
 */
interface NormIp {
  version: 4 | 6;
  /** 4 octets for v4, 8 hextets for v6. */
  parts: number[];
}

function _normalizeIp(ipStr: string): NormIp | null {
  // Strip an IPv6 zone id ("%eth0") if present.
  const pct = ipStr.indexOf("%");
  const s = pct >= 0 ? ipStr.slice(0, pct) : ipStr;
  if (s.includes(":")) {
    const v6 = _parseIpv6(s);
    if (v6 === null) {
      return null;
    }
    // Unwrap IPv4-mapped IPv6 (::ffff:a.b.c.d). hextets[0..4]==0, [5]==0xffff.
    if (
      v6[0] === 0 &&
      v6[1] === 0 &&
      v6[2] === 0 &&
      v6[3] === 0 &&
      v6[4] === 0 &&
      v6[5] === 0xffff
    ) {
      const a = (v6[6]! >> 8) & 0xff;
      const b = v6[6]! & 0xff;
      const c = (v6[7]! >> 8) & 0xff;
      const d = v6[7]! & 0xff;
      return { version: 4, parts: [a, b, c, d] };
    }
    return { version: 6, parts: v6 };
  }
  const v4 = _parseIpv4(s);
  if (v4 === null) {
    return null;
  }
  return { version: 4, parts: v4 };
}

/**
 * Strict IPv4 parse matching Python ipaddress: exactly 4 decimal octets 0-255,
 * NO leading zeros (Python rejects "127.0.0.01"). Returns octets or null.
 */
function _parseIpv4(s: string): number[] | null {
  const parts = s.split(".");
  if (parts.length !== 4) {
    return null;
  }
  const out: number[] = [];
  for (const p of parts) {
    if (!/^\d+$/.test(p)) {
      return null;
    }
    if (p.length > 1 && p[0] === "0") {
      return null; // leading zero rejected (Python strict)
    }
    const n = Number(p);
    if (n > 255) {
      return null;
    }
    out.push(n);
  }
  return out;
}

/**
 * Parse an IPv6 string into 8 hextets (0..0xffff), supporting "::" compression
 * and a trailing embedded IPv4 (::ffff:1.2.3.4). Returns null on malformed
 * input. Sufficient for the SSRF range checks (we do not need full RFC parsing
 * fidelity, only the private/loopback/link-local determinations).
 */
function _parseIpv6(s: string): number[] | null {
  if (s === "::") {
    return [0, 0, 0, 0, 0, 0, 0, 0];
  }
  const doubleColon = s.indexOf("::");
  let head: string;
  let tail: string;
  if (doubleColon >= 0) {
    if (s.indexOf("::", doubleColon + 1) >= 0) {
      return null; // more than one "::"
    }
    head = s.slice(0, doubleColon);
    tail = s.slice(doubleColon + 2);
  } else {
    head = s;
    tail = "";
  }

  const expand = (segment: string): number[] | null => {
    if (segment === "") {
      return [];
    }
    const groups = segment.split(":");
    const vals: number[] = [];
    for (let i = 0; i < groups.length; i++) {
      const g = groups[i]!;
      // Embedded IPv4 only allowed as the very last group.
      if (g.includes(".")) {
        if (i !== groups.length - 1) {
          return null;
        }
        const v4 = _parseIpv4(g);
        if (v4 === null) {
          return null;
        }
        vals.push((v4[0]! << 8) | v4[1]!);
        vals.push((v4[2]! << 8) | v4[3]!);
        continue;
      }
      if (!/^[0-9a-fA-F]{1,4}$/.test(g)) {
        return null;
      }
      vals.push(parseInt(g, 16));
    }
    return vals;
  };

  const headVals = expand(head);
  const tailVals = expand(tail);
  if (headVals === null || tailVals === null) {
    return null;
  }

  let full: number[];
  if (doubleColon >= 0) {
    const missing = 8 - headVals.length - tailVals.length;
    if (missing < 0) {
      return null;
    }
    full = [...headVals, ...new Array<number>(missing).fill(0), ...tailVals];
  } else {
    full = headVals;
  }
  if (full.length !== 8) {
    return null;
  }
  return full;
}

/**
 * Mirror Python ipaddress is_loopback / is_private / is_link_local /
 * is_reserved for the address families webfetch sees. Returns true when the IP
 * falls in any of those blocked ranges.
 *
 * The CIDR tables below are a 1:1 transcription of CPython 3.13.2's
 * `_IPv4Constants` (ipaddress.py ~L1579) and `_IPv6Constants` (~L2383):
 * `_private_networks`, `_private_networks_exceptions`, `_reserved_network[s]`,
 * `_loopback_network`, `_linklocal_network`. is_private is "in any private
 * network AND not in any exception", exactly as in CPython L1355-1356 /
 * L2122-2123. This is byte-parity-verified against the .venv (3.13.2) oracle
 * over ~65k IPv4+IPv6 addresses (boundary enumeration + seeded sample).
 *
 * NOTE: 100.64.0.0/10 (CGNAT) is intentionally NOT blocked — CPython 3.13 made
 * it the `_public_network` (is_private=False, is_reserved=False), so the Python
 * `_is_ssrf_safe` does not block it under the project's supported runtime. It
 * WAS private in 3.11/3.12; this port matches the verified 3.13.2 behaviour.
 */
export function _ip_is_blocked(ip: NormIp): boolean {
  if (ip.version === 4) {
    return _ipv4_blocked(ip.parts);
  }
  return _ipv6_blocked(ip.parts);
}

// [network (u32), prefixlen] — transcribed from CPython 3.13.2 _IPv4Constants.
const _IPV4_PRIVATE: ReadonlyArray<readonly [number, number]> = [
  [0x00000000, 8], // 0.0.0.0/8
  [0x0a000000, 8], // 10.0.0.0/8
  [0x7f000000, 8], // 127.0.0.0/8
  [0xa9fe0000, 16], // 169.254.0.0/16
  [0xac100000, 12], // 172.16.0.0/12
  [0xc0000000, 24], // 192.0.0.0/24
  [0xc00000aa, 31], // 192.0.0.170/31
  [0xc0000200, 24], // 192.0.2.0/24
  [0xc0a80000, 16], // 192.168.0.0/16
  [0xc6120000, 15], // 198.18.0.0/15
  [0xc6336400, 24], // 198.51.100.0/24
  [0xcb007100, 24], // 203.0.113.0/24
  [0xf0000000, 4], // 240.0.0.0/4
  [0xffffffff, 32], // 255.255.255.255/32
];
const _IPV4_PRIVATE_EXC: ReadonlyArray<readonly [number, number]> = [
  [0xc0000009, 32], // 192.0.0.9/32
  [0xc000000a, 32], // 192.0.0.10/32
];
const _IPV4_RESERVED: ReadonlyArray<readonly [number, number]> = [
  [0xf0000000, 4], // 240.0.0.0/4
];
const _IPV4_LOOPBACK: readonly [number, number] = [0x7f000000, 8]; // 127.0.0.0/8
const _IPV4_LINKLOCAL: readonly [number, number] = [0xa9fe0000, 16]; // 169.254.0.0/16

// [network (u128 BigInt), prefixlen] — transcribed from CPython 3.13.2 _IPv6Constants.
const _IPV6_PRIVATE: ReadonlyArray<readonly [bigint, number]> = [
  [0x00000000000000000000000000000001n, 128], // ::1/128
  [0x00000000000000000000000000000000n, 128], // ::/128
  [0x00000000000000000000ffff00000000n, 96], // ::ffff:0:0/96
  [0x0064ff9b000100000000000000000000n, 48], // 64:ff9b:1::/48
  [0x01000000000000000000000000000000n, 64], // 100::/64
  [0x20010000000000000000000000000000n, 23], // 2001::/23
  [0x20010db8000000000000000000000000n, 32], // 2001:db8::/32
  [0x20020000000000000000000000000000n, 16], // 2002::/16
  [0x3fff0000000000000000000000000000n, 20], // 3fff::/20
  [0xfc000000000000000000000000000000n, 7], // fc00::/7
  [0xfe800000000000000000000000000000n, 10], // fe80::/10
];
const _IPV6_PRIVATE_EXC: ReadonlyArray<readonly [bigint, number]> = [
  [0x20010001000000000000000000000001n, 128], // 2001:1::1/128
  [0x20010001000000000000000000000002n, 128], // 2001:1::2/128
  [0x20010003000000000000000000000000n, 32], // 2001:3::/32
  [0x20010004011200000000000000000000n, 48], // 2001:4:112::/48
  [0x20010020000000000000000000000000n, 28], // 2001:20::/28
  [0x20010030000000000000000000000000n, 28], // 2001:30::/28
];
const _IPV6_RESERVED: ReadonlyArray<readonly [bigint, number]> = [
  [0x00000000000000000000000000000000n, 8], // ::/8
  [0x01000000000000000000000000000000n, 8], // 100::/8
  [0x02000000000000000000000000000000n, 7], // 200::/7
  [0x04000000000000000000000000000000n, 6], // 400::/6
  [0x08000000000000000000000000000000n, 5], // 800::/5
  [0x10000000000000000000000000000000n, 4], // 1000::/4
  [0x40000000000000000000000000000000n, 3], // 4000::/3
  [0x60000000000000000000000000000000n, 3], // 6000::/3
  [0x80000000000000000000000000000000n, 3], // 8000::/3
  [0xa0000000000000000000000000000000n, 3], // a000::/3
  [0xc0000000000000000000000000000000n, 3], // c000::/3
  [0xe0000000000000000000000000000000n, 4], // e000::/4
  [0xf0000000000000000000000000000000n, 5], // f000::/5
  [0xf8000000000000000000000000000000n, 6], // f800::/6
  [0xfe000000000000000000000000000000n, 9], // fe00::/9
];
const _IPV6_LOOPBACK: readonly [bigint, number] = [
  0x00000000000000000000000000000001n,
  128,
]; // ::1/128
const _IPV6_LINKLOCAL: readonly [bigint, number] = [
  0xfe800000000000000000000000000000n,
  10,
]; // fe80::/10

/** True when the 32-bit *ipInt* lies within [net]/prefix. */
function _inCidr4(ipInt: number, net: number, prefix: number): boolean {
  if (prefix <= 0) {
    return true;
  }
  if (prefix >= 32) {
    return (ipInt >>> 0) === (net >>> 0);
  }
  return ((ipInt ^ net) >>> (32 - prefix)) === 0;
}

/** True when the 128-bit *ipBig* lies within [net]/prefix. */
function _inCidr6(ipBig: bigint, net: bigint, prefix: number): boolean {
  if (prefix <= 0) {
    return true;
  }
  if (prefix >= 128) {
    return ipBig === net;
  }
  return ((ipBig ^ net) >> BigInt(128 - prefix)) === 0n;
}

function _inAnyCidr4(ipInt: number, nets: ReadonlyArray<readonly [number, number]>): boolean {
  return nets.some(([net, prefix]) => _inCidr4(ipInt, net, prefix));
}

function _inAnyCidr6(
  ipBig: bigint,
  nets: ReadonlyArray<readonly [bigint, number]>,
): boolean {
  return nets.some(([net, prefix]) => _inCidr6(ipBig, net, prefix));
}

function _ipv4_blocked(o: number[]): boolean {
  const ipInt = (((o[0]! << 24) >>> 0) | (o[1]! << 16) | (o[2]! << 8) | o[3]!) >>> 0;
  // is_loopback || is_link_local || is_reserved
  if (
    _inCidr4(ipInt, _IPV4_LOOPBACK[0], _IPV4_LOOPBACK[1]) ||
    _inCidr4(ipInt, _IPV4_LINKLOCAL[0], _IPV4_LINKLOCAL[1]) ||
    _inAnyCidr4(ipInt, _IPV4_RESERVED)
  ) {
    return true;
  }
  // is_private: in any _private_networks AND not in any _private_networks_exceptions.
  if (
    _inAnyCidr4(ipInt, _IPV4_PRIVATE) &&
    !_inAnyCidr4(ipInt, _IPV4_PRIVATE_EXC)
  ) {
    return true;
  }
  return false;
}

function _ipv6_blocked(h: number[]): boolean {
  let ipBig = 0n;
  for (const hx of h) {
    ipBig = (ipBig << 16n) | BigInt(hx);
  }
  // is_loopback || is_link_local || is_reserved
  if (
    _inCidr6(ipBig, _IPV6_LOOPBACK[0], _IPV6_LOOPBACK[1]) ||
    _inCidr6(ipBig, _IPV6_LINKLOCAL[0], _IPV6_LINKLOCAL[1]) ||
    _inAnyCidr6(ipBig, _IPV6_RESERVED)
  ) {
    return true;
  }
  // is_private: in any _private_networks AND not in any _private_networks_exceptions.
  if (_inAnyCidr6(ipBig, _IPV6_PRIVATE) && !_inAnyCidr6(ipBig, _IPV6_PRIVATE_EXC)) {
    return true;
  }
  return false;
}

// ===========================================================================
// Python string-semantics helpers
// ===========================================================================

/** Code-point length (Python len(str)). */
function _codePointLength(s: string): number {
  return [...s].length;
}

/** Code-point slice (Python s[start:end]). */
function _codePointSlice(s: string, start: number, end: number): string {
  return [...s].slice(start, end).join("");
}

/**
 * First *n* code points of *s* — same result as _codePointSlice(s, 0, n) but
 * O(n) (bounded) instead of spreading the whole string. Used for the HTML
 * preamble check on potentially large bodies.
 */
function _firstCodePoints(s: string, n: number): string {
  const parts: string[] = [];
  let count = 0;
  let i = 0;
  while (i < s.length && count < n) {
    const cp = s.codePointAt(i)!;
    if (cp > 0xffff) {
      // Astral code point: two UTF-16 code units.
      parts.push(s[i]!, s[i + 1]!);
      i += 2;
    } else {
      parts.push(s[i]!);
      i += 1;
    }
    count += 1;
  }
  return parts.join("");
}

/**
 * Python str.splitlines(): split on the Unicode line-boundary set and DROP a
 * single trailing empty element (so "a\n".splitlines() == ["a"], and
 * "".splitlines() == []). The boundary set includes \n \r \r\n \v \f \x1c \x1d
 * \x1e \x85    .
 */
function _splitlines(s: string): string[] {
  if (s === "") {
    return [];
  }
  const out: string[] = [];
  // Accumulate each line in an array buffer + join once per line (linear),
  // NOT `cur += c` (which is O(n²) on long lines). Matches Python
  // str.splitlines(): on a boundary push the current line (even if empty); at
  // EOF push the tail only when non-empty.
  let buf: string[] = [];
  for (let i = 0; i < s.length; i++) {
    const c = s[i]!;
    const code = c.charCodeAt(0);
    const isBoundary =
      c === "\n" ||
      c === "\r" ||
      c === "\v" ||
      c === "\f" ||
      code === 0x1c ||
      code === 0x1d ||
      code === 0x1e ||
      code === 0x85 ||
      code === 0x2028 ||
      code === 0x2029;
    if (isBoundary) {
      out.push(buf.join(""));
      buf = [];
      // \r\n counts as a single boundary.
      if (c === "\r" && i + 1 < s.length && s[i + 1] === "\n") {
        i += 1;
      }
    } else {
      buf.push(c);
    }
  }
  if (buf.length > 0) {
    out.push(buf.join(""));
  }
  return out;
}

/**
 * Python str.strip() with no args: strips a broad Unicode whitespace set from
 * both ends. We strip the ASCII whitespace plus the common Unicode spaces
 * Python's str.strip removes (the inputs the tests use are ASCII, so the ASCII
 * set is what actually fires).
 */
const _PY_WS = new Set([
  0x09, 0x0a, 0x0b, 0x0c, 0x0d, 0x20, 0x1c, 0x1d, 0x1e, 0x1f, 0x85, 0xa0,
  0x1680, 0x2000, 0x2001, 0x2002, 0x2003, 0x2004, 0x2005, 0x2006, 0x2007,
  0x2008, 0x2009, 0x200a, 0x2028, 0x2029, 0x202f, 0x205f, 0x3000,
]);

function _pyStrip(s: string): string {
  let start = 0;
  let end = s.length;
  while (start < end && _PY_WS.has(s.charCodeAt(start))) {
    start += 1;
  }
  while (end > start && _PY_WS.has(s.charCodeAt(end - 1))) {
    end -= 1;
  }
  return s.slice(start, end);
}

/** Python int(str): strict decimal parse; returns null on failure. */
function _pyInt(s: string): number | null {
  const trimmed = s.trim();
  if (!/^[+-]?\d+$/.test(trimmed)) {
    return null;
  }
  const n = Number(trimmed);
  return Number.isFinite(n) ? n : null;
}

/** Python float(str): returns null on failure. */
function _pyFloat(s: string): number | null {
  const trimmed = s.trim();
  if (trimmed === "") {
    return null;
  }
  // Python float() accepts "inf"/"nan"; webfetch treats those via the <=0 / NaN
  // guards in _webfetch_timeout, so we accept the standard numeric grammar plus
  // inf/nan to mirror it.
  if (/^[+-]?(inf|infinity)$/i.test(trimmed)) {
    return trimmed.startsWith("-") ? -Infinity : Infinity;
  }
  if (/^[+-]?nan$/i.test(trimmed)) {
    return NaN;
  }
  if (!/^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/.test(trimmed)) {
    return null;
  }
  return Number(trimmed);
}

/**
 * Python repr() of a string for message embedding ({!r}). Single-quoted unless
 * the string contains a single quote but no double quote, escaping backslashes
 * and the chosen quote. Sufficient for the URL/hostname strings in error
 * messages (the tests match on substrings, not the exact repr form, but this
 * keeps the message shape faithful).
 */
function _pyRepr(s: string): string {
  let quote = "'";
  if (s.includes("'") && !s.includes('"')) {
    quote = '"';
  }
  let out = "";
  for (const ch of s) {
    if (ch === "\\") {
      out += "\\\\";
    } else if (ch === quote) {
      out += "\\" + quote;
    } else if (ch === "\n") {
      out += "\\n";
    } else if (ch === "\r") {
      out += "\\r";
    } else if (ch === "\t") {
      out += "\\t";
    } else {
      out += ch;
    }
  }
  return quote + out + quote;
}

/**
 * json.dumps(obj) with default separators (", " / ": ") and ensure_ascii=True.
 * Mirrors Python's default dump: a space after each comma and colon, and
 * non-ASCII escaped as \uXXXX. Keys preserve insertion order (Python dicts).
 */
function _jsonDumps(obj: Record<string, string>): string {
  const parts: string[] = [];
  for (const [k, v] of Object.entries(obj)) {
    parts.push(`${_jsonStr(k)}: ${_jsonStr(v)}`);
  }
  return "{" + parts.join(", ") + "}";
}

/** json.dumps string encoder with ensure_ascii (\uXXXX for non-ASCII). */
function _jsonStr(s: string): string {
  let out = '"';
  for (const ch of s) {
    const cp = ch.codePointAt(0)!;
    if (ch === '"') {
      out += '\\"';
    } else if (ch === "\\") {
      out += "\\\\";
    } else if (ch === "\n") {
      out += "\\n";
    } else if (ch === "\r") {
      out += "\\r";
    } else if (ch === "\t") {
      out += "\\t";
    } else if (cp === 0x08) {
      out += "\\b";
    } else if (cp === 0x0c) {
      out += "\\f";
    } else if (cp < 0x20) {
      out += "\\u" + cp.toString(16).padStart(4, "0");
    } else if (cp < 0x7f) {
      out += ch;
    } else if (cp <= 0xffff) {
      out += "\\u" + cp.toString(16).padStart(4, "0");
    } else {
      // astral -> surrogate pair (json.dumps ensure_ascii emits \uHHHH\uHHHH).
      const u = cp - 0x10000;
      const hi = 0xd800 + (u >> 10);
      const lo = 0xdc00 + (u & 0x3ff);
      out += "\\u" + hi.toString(16).padStart(4, "0");
      out += "\\u" + lo.toString(16).padStart(4, "0");
    }
  }
  return out + '"';
}

// ===========================================================================
// html.unescape (faithful port)
// ===========================================================================

// CPython html._charref: &(#[0-9]+;?|#[xX][0-9a-fA-F]+;?|[^\t\n\f <&#;]{1,32};?)
const _CHARREF =
  /&(#[0-9]+;?|#[xX][0-9a-fA-F]+;?|[^\t\n\f <&#;]{1,32};?)/g;

/**
 * Convert all named and numeric character references in *s* to the
 * corresponding Unicode characters, byte-faithful to Python html.unescape().
 *
 * Uses the embedded HTML5 entity table and the same longest-prefix-match rule
 * (try the full match, then progressively shorter prefixes >= 2 chars), and the
 * same numeric-charref normalization (invalid charref map, surrogate/overflow
 * -> U+FFFD, invalid-codepoint -> "").
 */
export function _html_unescape(s: string): string {
  if (!s.includes("&")) {
    return s;
  }
  return s.replace(_CHARREF, (_full, group: string) => _replaceCharref(group));
}

function _replaceCharref(s: string): string {
  if (s[0] === "#") {
    let num: number;
    if (s[1] === "x" || s[1] === "X") {
      num = parseInt(_rstripSemicolon(s.slice(2)), 16);
    } else {
      num = parseInt(_rstripSemicolon(s.slice(1)), 10);
    }
    const inv = INVALID_CHARREFS[num];
    if (inv !== undefined) {
      return inv;
    }
    if ((num >= 0xd800 && num <= 0xdfff) || num > 0x10ffff) {
      return "�";
    }
    if (INVALID_CODEPOINTS.has(num)) {
      return "";
    }
    return String.fromCodePoint(num);
  }
  // Named charref.
  const direct = HTML5_ENTITIES[s];
  if (direct !== undefined) {
    return direct;
  }
  // Find the longest matching name (HTML5 standard): range(len(s)-1, 1, -1).
  for (let x = s.length - 1; x > 1; x--) {
    const prefix = s.slice(0, x);
    const hit = HTML5_ENTITIES[prefix];
    if (hit !== undefined) {
      return hit + s.slice(x);
    }
  }
  return "&" + s;
}

/** Python s.rstrip(";"). */
function _rstripSemicolon(s: string): string {
  let end = s.length;
  while (end > 0 && s[end - 1] === ";") {
    end -= 1;
  }
  return s.slice(0, end);
}

// ===========================================================================
// Misc small helpers
// ===========================================================================

function _isPlainObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

function _bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) {
    return false;
  }
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) {
      return false;
    }
  }
  return true;
}

function _unlinkMissingOk(p: string): void {
  try {
    fs.unlinkSync(p);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      throw err;
    }
  }
}

/** path.resolve + realpath when the target exists; falls back to resolve. */
function _resolveOrSelf(p: string): string {
  try {
    return fs.realpathSync(p);
  } catch {
    return path.resolve(p);
  }
}
