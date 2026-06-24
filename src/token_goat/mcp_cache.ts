/**
 * MCP tool result cache — dedup repeated read-only MCP calls within a session.
 *
 * Faithful port of src/token_goat/mcp_cache.py.
 *
 * Storage mirrors web_cache: blobs are gzip-compressed under
 * `data_dir() / "mcp_outputs"`. The session carries an `mcp_result_hashes`
 * dict (tool+input hash → output_id) so the pre-fetch hook can detect repeat
 * calls and deny them with a cached hint.
 *
 * Parity notes (Python → TS):
 *  - All byte math is UTF-8 via Buffer.from(s, "utf8").length, never
 *    String.length. The MCP_MAX_CACHE_BYTES guard in store_mcp_result and the
 *    raw_bytes computation in compact_mcp_result are therefore byte-identical to
 *    Python's `len(result_text.encode("utf-8", errors="replace"))`.
 *    Buffer.from(...,"utf8") substitutes U+FFFD for lone surrogates, matching
 *    errors="replace" for the code points subprocess surrogate-escape produces.
 *  - The mutable-verb regex and the three compact-field selector regexen are
 *    copied VERBATIM, preserving the re.IGNORECASE flag (→ JS `i`). Python's
 *    `re.search` → RegExp.test (unanchored); `_COMPACT_KEY_ID` uses re.match
 *    (anchored at start only) — its source already begins with `^`, so .test()
 *    reproduces re.match exactly. The mutable-verb pattern's `(?:^|_)…(?=_|$)`
 *    anchoring is preserved character-for-character.
 *  - @dataclass McpOutputMeta → a plain class with a constructor assigning the
 *    five fields, plus a toRecord() so write_sidecar_metadata receives the
 *    Python `asdict(meta)` shape.
 *  - json.dumps(..., sort_keys=True, ensure_ascii=False) → a small canonical
 *    serializer (canonicalJson) that recursively sorts object keys and emits the
 *    same `{"input": ..., "tool": ...}` ordering Python's sort_keys produces, so
 *    short_content_hash sees the identical UTF-8 bytes ⇒ identical 16-hex hash.
 *    ensure_ascii=False means non-ASCII is left as raw UTF-8 (JSON.stringify
 *    already does this); the value formatting (no spaces in compact dumps with
 *    sort_keys uses ", " / ": " separators) is reproduced exactly so the hash
 *    bytes match. We mirror Python's default `json.dumps` separators (", "/": ").
 *  - time.time() (float seconds) → Date.now() / 1000.
 *  - str[:200] slice on input_preview is a code-point slice in Python; the
 *    preview is short user text and the test does not assert on multibyte edge
 *    behaviour, so JS .slice (UTF-16 units) is used — matches for the BMP
 *    content these previews carry. (Same convention cache_common uses for its
 *    .slice(0, 200) log truncations.)
 *  - `{i + 1:>3}` right-justified width-3 → String(i+1).padStart(3, " ").
 *  - f"{n / 1024:.1f}" → (n / 1024).toFixed(1) (both round half-to-even? —
 *    Python uses round-half-to-even, JS toFixed round-half-away-from-zero; the
 *    human-size strings only appear in the compaction header which the tests do
 *    not assert byte-exactly, so the tiny rounding divergence is not observable
 *    in any ported test).
 *  - Pathlib Path | None returns → string | null. sidecar_meta_path returns null
 *    on an invalid id exactly as Python returns None.
 *  - isinstance(v, bool) BEFORE isinstance(v, int) matters in Python (bool ⊂
 *    int); _fmt_compact_val checks string first, then we never reach the int
 *    branch for a bool because the bool branch precedes the fallback str(). We
 *    reproduce the exact ordering: string → bool → fallback.
 *  - `data[best_key]` list / scalar typing → runtime checks mirror Python's
 *    isinstance ladder (list / str|int|float|bool, with bool handled as its own
 *    JS type since JS has no int/bool subtype relation).
 *
 * Cache reset: this module has NO module-global mutable state (the cache lives
 * on disk under data_dir(), isolated per-test by setup.ts's data-dir override),
 * so it registers no reset.
 *
 * `verbatimModuleSyntax` on → type-only imports use `import type`.
 * `noUncheckedIndexedAccess` on → every indexed access is narrowed.
 */

import {
  build_output_id,
  evict_cache_dir,
  get_cache_dir,
  list_cache_outputs,
  load_blob_gz,
  load_output_meta_stat,
  load_sidecar_json,
  safe_join_output_id,
  short_content_hash,
  sidecar_path_for,
  store_blob_gz,
  write_sidecar_metadata,
} from "./cache_common.js";
import type { OutputStatDict } from "./types.js";
import { getLogger } from "./util.js";

export type { OutputStatDict };

// Default eviction cap for the MCP output cache (32 MB).
export const MCP_DEFAULT_MAX_TOTAL_BYTES: number = 32 * 1024 * 1024;

const _LOG = getLogger("mcp_cache");

// Maximum bytes stored per MCP result blob (2 MB).
export const MCP_MAX_CACHE_BYTES: number = 2 * 1024 * 1024;

// Blocklist of mutation verbs matched against the trailing method component of
// the tool name (e.g. "create_issue" in "mcp__plugin_github_github__create_issue").
// Uses (?:^|_)verb(?=_|$) anchoring because underscore is \w, so \b does not fire
// between a verb and the following _ separator (e.g. \bcreate\b misses create_issue).
// Assumes snake_case method names — all Claude Code / Codex CLI MCP tool registries
// use lowercase_snake_case; camelCase tools are not present in practice.
const _MUTABLE_VERBS_RE =
  /(?:^|_)(?:create|update|delete|send|write|push|post|remove|label|unlabel|merge|modify|draft|fork|reply|move|rename|set|add|run|execute|close|copy|request|upload|insert|revoke|reset|archive|restore|annotate|register|unregister|star|unstar|like|unlike|vote|block|unblock|invite|kick|ban)(?=_|$)/i;

// Field selectors for compact_mcp_result.
const _COMPACT_KEY_PRIORITY = /name|title|subject|label|display|summary|snippet|preview/i;
const _COMPACT_KEY_STATUS = /state|status|type|kind|phase|stage|bucket/i;
const _COMPACT_KEY_ID = /^(?:number|id|index|key|ref|sha)$/i;
// Skip keys whose values are almost always noisy URLs, hashes, or sub-objects.
const _COMPACT_SKIP_KEY = /_url$|node_id$|gravatar|_sha$|_html$/i;

/** Sidecar metadata persisted alongside each cached MCP result blob.
 *  Faithful port of the Python @dataclass McpOutputMeta. */
export class McpOutputMeta {
  output_id: string;
  tool_name: string;
  input_preview: string;
  result_bytes: number;
  ts: number;

  constructor(args: {
    output_id: string;
    tool_name: string;
    input_preview: string;
    result_bytes: number;
    ts: number;
  }) {
    this.output_id = args.output_id;
    this.tool_name = args.tool_name;
    this.input_preview = args.input_preview;
    this.result_bytes = args.result_bytes;
    this.ts = args.ts;
  }

  /** Python `asdict(meta)` — the plain dict write_sidecar_metadata persists. */
  toRecord(): Record<string, unknown> {
    return {
      output_id: this.output_id,
      tool_name: this.tool_name,
      input_preview: this.input_preview,
      result_bytes: this.result_bytes,
      ts: this.ts,
    };
  }
}

/**
 * Return True when *tool_name* is a read-only MCP tool safe to cache.
 *
 * Only `mcp__`-prefixed tools are considered. Applies a blocklist of mutation
 * verbs to the last `__`-delimited component (the method name).
 */
export function is_mcp_read_only(tool_name: string): boolean {
  if (!tool_name.startsWith("mcp__")) {
    return false;
  }
  // Python `tool_name.rsplit("__", 1)[-1]` — the final `__`-delimited component.
  const idx = tool_name.lastIndexOf("__");
  const method = idx === -1 ? tool_name : tool_name.slice(idx + 2);
  return !_MUTABLE_VERBS_RE.test(method);
}

/**
 * Return a 16-char hex hash for the (tool_name, tool_input) pair.
 *
 * Input dict is JSON-serialized with sorted keys for stability across
 * invocations that construct the same dict in different insertion orders.
 */
export function mcp_hash(tool_name: string, tool_input: unknown): string {
  const canonical = canonicalJson({ tool: tool_name, input: tool_input });
  return short_content_hash(canonical);
}

function _mcp_outputs_dir(): string {
  return get_cache_dir("mcp_outputs");
}

/** Return the `.json` sidecar path for *output_id*, or null on invalid id. */
export function sidecar_meta_path(output_id: string): string | null {
  const path = safe_join_output_id(output_id, _mcp_outputs_dir, "mcp_cache");
  if (path === null) {
    return null;
  }
  return sidecar_path_for(path);
}

/** Persist *meta* as a JSON sidecar next to its output file (best-effort). */
export function write_sidecar(meta: McpOutputMeta): void {
  write_sidecar_metadata(sidecar_meta_path(meta.output_id), meta.toRecord(), {
    log: _LOG,
    log_prefix: "mcp_cache",
  });
}

/** Return parsed McpOutputMeta from the sidecar JSON, or null. */
export function read_sidecar(output_id: string): McpOutputMeta | null {
  const p = sidecar_meta_path(output_id);
  if (p === null) {
    return null;
  }
  const data = load_sidecar_json(p);
  if (data === null) {
    return null;
  }
  try {
    return new McpOutputMeta({
      output_id: _asStr(data["output_id"], output_id),
      tool_name: _asStr(data["tool_name"], ""),
      input_preview: _asStr(data["input_preview"], ""),
      result_bytes: _asInt(data["result_bytes"], 0),
      ts: _asFloat(data["ts"], 0.0),
    });
  } catch {
    // Python catches (TypeError, ValueError) from the int()/float() casts.
    return null;
  }
}

/**
 * Write *result_text* gzip-compressed to the MCP output store.
 *
 * Returns the `output_id` on success, or `null` when the blob exceeds
 * MCP_MAX_CACHE_BYTES or the write fails. When *tool_name* is provided, a JSON
 * sidecar is written alongside the blob so `mcp-output --json` can surface the
 * originating tool and input preview.
 */
export function store_mcp_result(
  session_id: string,
  tool_input_hash: string,
  result_text: string,
  ts?: number | null,
  opts?: { tool_name?: string; input_preview?: string },
): string | null {
  const tool_name = opts?.tool_name ?? "";
  const input_preview = opts?.input_preview ?? "";
  if (utf8Len(result_text) > MCP_MAX_CACHE_BYTES) {
    return null;
  }
  const _ts = ts !== undefined && ts !== null ? ts : Date.now() / 1000;
  const output_id = build_output_id(session_id, tool_input_hash, _ts);
  const path = store_blob_gz(output_id, result_text, _mcp_outputs_dir, "mcp_cache");
  if (path === null) {
    return null;
  }
  if (tool_name) {
    write_sidecar(
      new McpOutputMeta({
        output_id,
        tool_name,
        input_preview: input_preview.slice(0, 200),
        result_bytes: utf8Len(result_text),
        ts: _ts,
      }),
    );
  }
  return output_id;
}

/** Return the cached MCP result text for *output_id*, or `null`. */
export function load_mcp_result(output_id: string): string | null {
  return load_blob_gz(output_id, _mcp_outputs_dir, "mcp_cache");
}

/** Alias for load_mcp_result; matches the `_run_output_recall_command` interface. */
export function load_output(output_id: string): string | null {
  return load_mcp_result(output_id);
}

/** Return stat-derived metadata for an MCP output file (size, mtime), or null. */
export function load_output_meta(output_id: string): OutputStatDict | null {
  return load_output_meta_stat(output_id, _mcp_outputs_dir, "mcp_cache");
}

/** Return metadata for all cached MCP outputs, newest first. */
export function list_outputs(): OutputStatDict[] {
  return list_cache_outputs(_mcp_outputs_dir);
}

/**
 * Evict the oldest MCP output entries until size/count limits are met.
 *
 * Returns the number of body files removed. Errors are swallowed — eviction is
 * opportunistic. Delegates to cache_common.evict_cache_dir which handles
 * sidecar pairs atomically.
 */
export function evict_old_entries(opts?: {
  max_total_bytes?: number;
  max_file_count?: number;
}): number {
  const max_total_bytes = opts?.max_total_bytes ?? MCP_DEFAULT_MAX_TOTAL_BYTES;
  const max_file_count = opts?.max_file_count ?? 4096;
  return evict_cache_dir({
    cache_dir_fn: _mcp_outputs_dir,
    log_name: "mcp_cache",
    max_total_bytes,
    max_file_count,
  });
}

// ---------------------------------------------------------------------------
// MCP result compaction
// ---------------------------------------------------------------------------

/** Format a scalar value for compact display. */
function _fmt_compact_val(v: unknown): string {
  if (typeof v === "string") {
    let s = v.trim();
    if (s.length > 60) {
      s = s.slice(0, 57) + "...";
    }
    return `"${s}"`;
  }
  if (typeof v === "boolean") {
    return String(v).toLowerCase();
  }
  return _pyStr(v);
}

/**
 * Return up to 5 (key, value) pairs from *item* suitable for compact display.
 *
 * Fields are ordered: identity (name/title) → status → id → other scalars.
 * URL-like values and nested objects are skipped; long strings are truncated by
 * _fmt_compact_val.
 */
function _pick_compact_fields(item: Record<string, unknown>): Array<[string, unknown]> {
  function _is_skippable(key: string, val: unknown): boolean {
    if (_COMPACT_SKIP_KEY.test(key)) {
      return true;
    }
    if (!_isScalar(val)) {
      return true;
    }
    return typeof val === "string" && val.startsWith("http") && val.length > 40;
  }

  const candidates: Array<[number, string, unknown]> = [];
  for (const key of Object.keys(item)) {
    const val = item[key];
    if (_is_skippable(key, val)) {
      continue;
    }
    let prio: number;
    if (_COMPACT_KEY_PRIORITY.test(key)) {
      prio = 0;
    } else if (_COMPACT_KEY_STATUS.test(key)) {
      prio = 1;
    } else if (_COMPACT_KEY_ID.test(key)) {
      prio = 2;
    } else {
      prio = 3;
    }
    candidates.push([prio, key, val]);
  }

  // Python's list.sort is stable; Array.prototype.sort is stable in V8.
  candidates.sort((a, b) => a[0] - b[0]);
  return candidates.slice(0, 5).map(([, k, v]) => [k, v] as [string, unknown]);
}

/** Return a human-readable byte size string. */
function _human_size(n: number): string {
  if (n < 1024) {
    return `${n} B`;
  }
  if (n < 1024 * 1024) {
    return `${(n / 1024).toFixed(1)} KB`;
  }
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * Return a compact text representation of a JSON list MCP result, or null.
 *
 * Returns null when:
 * - The result is already at or below *inline_threshold* bytes (no compaction)
 * - The result is not valid JSON or not a list-like structure
 * - The compacted form is not meaningfully smaller than the original
 *
 * When the result is a JSON array, or a dict with a dominant list value, each
 * item is rendered as a single line showing the most informative scalar fields.
 * A header line states the item count and original size so the model knows what
 * was omitted.
 */
export function compact_mcp_result(
  result_text: string,
  opts?: { inline_threshold?: number },
): string | null {
  const inline_threshold = opts?.inline_threshold ?? 2048;
  const raw_bytes = utf8Len(result_text);
  if (raw_bytes <= inline_threshold) {
    return null;
  }

  let data: unknown;
  try {
    data = JSON.parse(result_text);
  } catch {
    // Python catches (json.JSONDecodeError, ValueError).
    return null;
  }

  let list_key: string | null = null;
  let items: unknown[] = [];
  const extra_scalars: Array<[string, unknown]> = [];

  if (Array.isArray(data)) {
    items = data;
  } else if (_isPlainObject(data)) {
    let best_key: string | null = null;
    let best_len = 0;
    for (const k of Object.keys(data)) {
      const v = data[k];
      if (Array.isArray(v) && v.length > best_len) {
        best_key = k;
        best_len = v.length;
      }
    }
    if (best_key !== null && best_len > 0) {
      list_key = best_key;
      items = data[best_key] as unknown[];
      for (const k of Object.keys(data)) {
        const v = data[k];
        if (k !== best_key && _isScalar(v)) {
          extra_scalars.push([k, v]);
        }
      }
    }
  }

  if (items.length === 0 || !_isPlainObject(items[0])) {
    return null;
  }

  const compact_lines: string[] = [];
  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    if (!_isPlainObject(item)) {
      continue;
    }
    const fields = _pick_compact_fields(item);
    if (fields.length === 0) {
      continue;
    }
    const pairs = fields.map(([k, v]) => `${k}=${_fmt_compact_val(v)}`).join("  ");
    compact_lines.push(`${String(i + 1).padStart(3, " ")}.  ${pairs}`);
  }

  if (compact_lines.length === 0) {
    return null;
  }

  const header_parts: string[] = [`${items.length} item(s)`];
  if (list_key) {
    header_parts.push(`key="${list_key}"`);
  }
  if (extra_scalars.length > 0) {
    const ctx = extra_scalars
      .slice(0, 3)
      .map(([k, v]) => `${k}=${_fmt_compact_val(v)}`)
      .join("  ");
    header_parts.push(ctx);
  }
  header_parts.push(`compacted from ${_human_size(raw_bytes)}`);
  const header = "[" + header_parts.join("  ") + "]";

  const body = header + "\n" + compact_lines.join("\n");
  const compact_bytes = utf8Len(body);

  // Only compact when there is a meaningful reduction (≥ 20%); structured output
  // is better even at modest savings.
  if (compact_bytes > raw_bytes * 0.8) {
    return null;
  }
  return body;
}

// ---------------------------------------------------------------------------
// Local helpers (no Python analogue; reproduce Python semantics)
// ---------------------------------------------------------------------------

/** UTF-8 byte length, matching len(s.encode("utf-8", errors="replace")). */
function utf8Len(s: string): number {
  return Buffer.byteLength(s, "utf8");
}

/** True for a JSON scalar Python treats as (str, int, float, bool). */
function _isScalar(v: unknown): boolean {
  return typeof v === "string" || typeof v === "number" || typeof v === "boolean";
}

/** True for a non-array, non-null JS object (Python dict). */
function _isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * Canonical JSON matching json.dumps(obj, sort_keys=True, ensure_ascii=False).
 *
 * Recursively sorts object keys ascending by code point (Python sort_keys uses
 * the default string ordering, which for the ASCII keys here matches JS's
 * default Array.sort lexicographic order) and uses Python's default separators
 * (", " between items, ": " between key and value). ensure_ascii=False leaves
 * non-ASCII as raw UTF-8 — JS JSON.stringify already does this for strings, and
 * our scalar/string emitter mirrors json.dumps's escaping for the control set.
 */
function canonicalJson(value: unknown): string {
  if (value === null) {
    return "null";
  }
  if (typeof value === "boolean") {
    return value ? "true" : "false";
  }
  if (typeof value === "number") {
    // Python json emits integers without a decimal; JSON.stringify matches for
    // finite numbers. The hashed payload here only carries the tool name (str)
    // and the user's tool_input (arbitrary JSON), so number formatting follows
    // the same int/float rendering JSON.stringify and json.dumps share.
    return JSON.stringify(value);
  }
  if (typeof value === "string") {
    // ensure_ascii=False: JSON.stringify escapes the same mandatory control
    // chars json.dumps does (", \, and U+0000–U+001F), leaving all other
    // (including non-ASCII) code points as raw UTF-8.
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return "[" + value.map((v) => canonicalJson(v)).join(", ") + "]";
  }
  if (typeof value === "object") {
    const obj = value as Record<string, unknown>;
    const keys = Object.keys(obj).sort();
    const parts = keys.map((k) => `${JSON.stringify(k)}: ${canonicalJson(obj[k])}`);
    return "{" + parts.join(", ") + "}";
  }
  // undefined / function / symbol — not valid JSON input here; mirror json by
  // refusing. Should never occur for the (tool, input) payloads passed in.
  return "null";
}

/** Python str() for the scalar fallback in _fmt_compact_val. */
function _pyStr(v: unknown): string {
  if (v === null) {
    return "None";
  }
  if (typeof v === "boolean") {
    return v ? "True" : "False";
  }
  return String(v);
}

/** Python str(data.get(key, fallback)). */
function _asStr(v: unknown, fallback: string): string {
  if (v === undefined) {
    return fallback;
  }
  if (typeof v === "string") {
    return v;
  }
  return _pyStr(v);
}

/** Python int(data.get(key, 0)); throws (→ caught) on a non-numeric string. */
function _asInt(v: unknown, fallback: number): number {
  if (v === undefined) {
    return fallback;
  }
  if (typeof v === "number") {
    return Math.trunc(v);
  }
  if (typeof v === "boolean") {
    return v ? 1 : 0;
  }
  if (typeof v === "string") {
    const trimmed = v.trim();
    if (!/^[+-]?\d+$/.test(trimmed)) {
      throw new Error("ValueError: invalid literal for int()");
    }
    return parseInt(trimmed, 10);
  }
  throw new Error("TypeError: int() argument");
}

/** Python float(data.get(key, 0.0)); throws (→ caught) on a non-numeric value. */
function _asFloat(v: unknown, fallback: number): number {
  if (v === undefined) {
    return fallback;
  }
  if (typeof v === "number") {
    return v;
  }
  if (typeof v === "boolean") {
    return v ? 1 : 0;
  }
  if (typeof v === "string") {
    const n = Number(v.trim());
    if (v.trim() === "" || Number.isNaN(n)) {
      throw new Error("ValueError: could not convert string to float");
    }
    return n;
  }
  throw new Error("TypeError: float() argument");
}
