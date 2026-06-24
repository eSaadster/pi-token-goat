/**
 * Hint generator for PreToolUse (Read, Grep, Bash) interception.
 *
 * Faithful port of src/token_goat/hints.py (the main decision layer executed by
 * the pre-tool hooks). For each incoming Read/Grep/Bash event it decides whether
 * to emit a hint that redirects the agent away from re-reading content it has
 * already seen, and if so, what that hint should say.
 *
 * All hint functions are fail-soft: exceptions are caught and logged; null is
 * returned so a broken hint layer never interrupts the agent's work.
 *
 * ===========================================================================
 * ReadHint — the public API the 6 test-port agents MUST assert against.
 * ===========================================================================
 * Python's `class ReadHint(str)` is a STRING SUBCLASS that also carries a
 * `tokens_saved` integer. In TS it is ported as a CLASS holding the hint TEXT
 * plus its metadata, with a toString()/valueOf() that returns the text so it can
 * be coerced into a string anywhere a string is expected. The exact contract:
 *
 *   class ReadHint {
 *     text: string;          // the prose hint string (what str(hint) returns)
 *     tokens_saved: number;  // honest realized-saving annotation (0 for suggestions)
 *     toString(): string;    // returns this.text
 *     valueOf(): string;     // returns this.text (so `${hint}` / String(hint) work)
 *   }
 *
 * How tests must assert against a ReadHint (Python → TS):
 *   - Python `"x" in hint`            → TS `hint.text.includes("x")`
 *   - Python `hint.lower()`           → TS `hint.text.toLowerCase()`
 *   - Python `str(n) in hint`         → TS `hint.text.includes(String(n))`
 *   - Python `isinstance(h, ReadHint)`→ TS `h instanceof ReadHint`
 *   - Python `hint.tokens_saved`      → TS `hint.tokens_saved`
 *   - Python `str(hint)`              → TS `String(hint)` or `hint.text`
 *   - Python `len(hint)`              → TS `hint.text.length`
 *   - Python `hint == "..."`          → TS `hint.text === "..."` (or String(hint))
 *   - Python `hint.startswith("..")`  → TS `hint.text.startsWith("..")`
 * Equality: `hint1 === hint2` is identity in TS (Python str equality is value);
 * compare `.text` (and `.tokens_saved`) explicitly when value-equality is meant.
 *
 * Builders that return `ReadHint | null` and the routing/sidecar code all use
 * this representation consistently. `_emit_json_sidecar` wraps a ReadHint into a
 * NEW ReadHint whose `.text` is `"<json line>\n<original .text>"` and whose
 * `.tokens_saved` is copied from the input.
 *
 * HintItem (used by build_high_frequency_hint / build_test_file_hint /
 * build_pinned_hint / apply_hint_priority_limit / dedup_hints) is a separate
 * class with `text: string` and `hint_priority: number` (NOT a ReadHint).
 *
 * ===========================================================================
 * Parity notes (Python → TS):
 * ===========================================================================
 *  - Sibling modules are imported via STATIC `import * as x from "./x.js"` so a
 *    test's vi.spyOn(session, "get_file_entry") / vi.spyOn(config, "load") /
 *    vi.spyOn(snapshots, "load") / vi.spyOn(db, "openProject") is observed.
 *  - db.py's `with db.open_project(h) as conn: conn.execute(sql, p).fetchone()`
 *    becomes the callback form `db.openProject(h, (conn) => conn.prepare(sql)
 *    .get(...p))`. better-sqlite3 `.get()` / `.all()` return row objects keyed by
 *    column name, so `row["line_count"]` ports as `row.line_count`. The Python
 *    `db.open_project_readonly` / `db.open_global` / `db.open_global_readonly`
 *    map to db.openProjectReadonly / db.openGlobal / db.openGlobalReadonly. The
 *    snake_case module entry-points the hint code calls were never aliased on
 *    db.ts, so this module uses the camelCase names directly (still observed by
 *    spies because the import is `import * as db`).
 *  - db.record_stat(None, kind, bytes_saved=, tokens_saved=, detail=) →
 *    db.recordStat(undefined, kind, {bytesSaved, tokensSaved, detail}).
 *  - find_project(Path) → find_project(string) (the TS port takes a string).
 *  - `_PATTERN_DISPLAY_CACHE` (module-global mutable) is a module-level Map with a
 *    registerReset(() => _PATTERN_DISPLAY_CACHE.clear()) so tests/setup.ts's
 *    clearModuleCaches() wipes it. Python keys the cache on `hash(pattern)`; we
 *    key on the pattern string itself (a stable, collision-free identity for the
 *    rendered-display memo — the only observable behaviour is "same pattern →
 *    same display string", which a string key preserves exactly).
 *  - CHARS_PER_TOKEN is exposed via an overridable `let` + setCharsPerToken()
 *    seam: tests monkeypatch hints.CHARS_PER_TOKEN, so the impl reads the live
 *    value through _charsPerToken() and TOKENS_PER_LINE is computed from it.
 *  - Byte math is UTF-8 via utf8Bytes (Buffer), never String.length (e.g. the
 *    JSON-sidecar byte cap, the diff byte size). char/token estimates operate on
 *    the Python str length (code points); JS .length (UTF-16) agrees for BMP
 *    text, matching the Python op for the inputs the hint layer sees.
 *  - Python `hashlib.sha256(x.encode()).hexdigest()[:n]` → createHash("sha256")
 *    .update(Buffer.from(x, "utf8")).digest("hex").slice(0, n).
 *  - difflib.unified_diff is reimplemented locally (_unifiedDiff) over the same
 *    keepends-splitlines line lists, producing byte-identical hunk output.
 *
 * `verbatimModuleSyntax` is on → type-only imports use `import type`.
 * `exactOptionalPropertyTypes` is on → optional fields are `T | undefined`.
 * `noUncheckedIndexedAccess` is on → every indexed access is narrowed.
 */

import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import type { Database as DatabaseType } from "better-sqlite3";

import * as config from "./config.js";
import * as db from "./db.js";
import * as session from "./session.js";
import * as snapshots from "./snapshots.js";
import * as paths from "./paths.js";
import * as cache_common from "./cache_common.js";
import * as web_cache from "./web_cache.js";
import * as doc_compact from "./doc_compact.js";
import * as bash_cache from "./bash_cache.js";
import { find_project } from "./project.js";
import { load_session_safe, sanitize_log_str, validate_cwd } from "./hooks_common.js";
import { getLogger, utf8Bytes } from "./util.js";
import { registerReset } from "./reset.js";

import type { SessionCache, FileEntry } from "./session.js";

// ---------------------------------------------------------------------------
// bash_cache seam — now wired to the real module.
// ---------------------------------------------------------------------------
// The Python hint code does lazy `from . import bash_cache` inside the bash
// dedup / cache-hit builders. bash_cache.ts is now ported, so the default for
// this seam IS the real module (static `import * as bash_cache`). The override
// setter is retained so tests can swap in a stub (object), force the fail-soft
// branch (null), or restore the real default (undefined). reset.ts clears the
// override back to undefined, i.e. back to the real module — so a test that does
// not touch the seam gets real behavior, while one that calls
// _setBashCacheModule(null) still exercises the @_failsoft_hint null path. The
// interface names mirror the Python bash_cache surface the hint code calls.
interface _BashCacheModule {
  command_hash(command: string, cwd?: string | null): string;
  find_cached_for_command(command: string, cwd?: string | null): _BashCacheMeta | null;
  is_git_immutable_command(command: string): boolean;
  load_output(output_id: string): string | null;
}
interface _BashCacheMeta {
  output_id: string;
  stdout_bytes: number;
  stderr_bytes: number;
  exit_code: number | null;
  ts: number;
}

// The real module is the default. `undefined` override means "use the default";
// an explicit `null` override means "fail soft (no module)"; an object override
// is a test stub.
const _bashCacheDefault: _BashCacheModule = bash_cache;
let _bashCacheModuleOverride: _BashCacheModule | null | undefined;

/**
 * Test/late-layer seam: inject a bash_cache implementation. Pass `null` to force
 * the fail-soft (no-module) path, or `undefined` to restore the real default.
 */
export function _setBashCacheModule(mod: _BashCacheModule | null | undefined): void {
  _bashCacheModuleOverride = mod;
}

registerReset(() => {
  // Restore the default (the real module), not null — see seam note above.
  _bashCacheModuleOverride = undefined;
});

/**
 * Resolve the bash_cache module: an explicit override (object or null) wins;
 * otherwise the real module default. Returns null only when a test forced it so
 * the bash builders fail soft.
 */
function _getBashCache(): _BashCacheModule | null {
  if (_bashCacheModuleOverride !== undefined) {
    return _bashCacheModuleOverride;
  }
  return _bashCacheDefault;
}

const _LOG = getLogger("hints");

// Maximum entries in the recent_hints ring buffer stored per session.
const _RECENT_HINTS_MAX = 3;

// ===========================================================================
// Hint priority ordering
// ===========================================================================
// Priority levels assigned to each hint type. Lower number = higher priority.
export const HINT_PRIORITY_CRITICAL = 1;
export const HINT_PRIORITY_HIGH = 2;
export const HINT_PRIORITY_MEDIUM = 3;
export const HINT_PRIORITY_LOW = 4;

// Maximum number of hints emitted per tool call.
export const HINT_MAX_PER_TOOL_CALL = 3;

/**
 * A hint with an attached priority level for ordering and filtering.
 *
 * `hint_priority` determines ordering when multiple hints apply to the same
 * tool call: lower values are emitted first. `text` is the prose hint string
 * injected into additionalContext. (Python class HintItem.)
 */
export class HintItem {
  hint_priority: number;
  text: string;

  constructor(text: string, hint_priority: number) {
    this.text = text;
    this.hint_priority = hint_priority;
  }
}

const _SLIM_HINT_MAX_CHARS = 250;

/**
 * Compress a hint to its first paragraph at hot/critical context pressure.
 *
 * At cool/warm pressure the full text is returned unchanged. At hot/critical,
 * only the first paragraph (up to the first blank line) is kept, then capped at
 * _SLIM_HINT_MAX_CHARS characters with a trailing ellipsis when truncated.
 * (Python slim_hint_text.)
 */
export function slim_hint_text(text: string, tier: string): string {
  if (tier !== "hot" && tier !== "critical") {
    return text;
  }
  // Keep only the first paragraph.
  const first_para = (text.split("\n\n")[0] ?? "").trim();
  if (!first_para) {
    return text; // empty paragraph — return original rather than empty string
  }
  // Single-line first paragraphs are the command line itself; skip char cap.
  if (!first_para.includes("\n")) {
    return first_para;
  }
  if (first_para.length <= _SLIM_HINT_MAX_CHARS) {
    return first_para;
  }
  return first_para.slice(0, _SLIM_HINT_MAX_CHARS).replace(/\s+$/, "") + "…";
}

/**
 * Sort hints by priority and return at most *max_hints* hint texts.
 *
 * Hints are sorted ascending by hint_priority (stable). When there are more than
 * max_hints, the lowest-priority excess are dropped and a "(+N more hints
 * suppressed)" footer is appended to the last emitted hint. At hot/critical tier
 * each text is compressed via slim_hint_text. (Python apply_hint_priority_limit.)
 */
export function apply_hint_priority_limit(
  hints: HintItem[],
  max_hints: number = HINT_MAX_PER_TOOL_CALL,
  opts: { tier?: string } = {},
): string[] {
  const tier = opts.tier ?? "cool";
  if (hints.length === 0) {
    return [];
  }
  // Stable sort by priority (lower value = higher priority = emitted first).
  // Array.prototype.sort is stable in modern Node, matching Python's sorted().
  const sorted_hints = [...hints].sort((a, b) => a.hint_priority - b.hint_priority);
  if (sorted_hints.length <= max_hints) {
    return sorted_hints.map((h) => slim_hint_text(h.text, tier));
  }
  // Cap at max_hints; append suppression footer to the last emitted hint.
  const emitted = sorted_hints.slice(0, max_hints);
  const suppressed_count = sorted_hints.length - max_hints;
  const result = emitted.map((h) => slim_hint_text(h.text, tier));
  result[result.length - 1] =
    `${result[result.length - 1]}\n(+${suppressed_count} more hints suppressed)`;
  return result;
}

/**
 * Compress duplicate hints by content hash; replace repeats with short stubs.
 *
 * For each HintItem, computes a stable content hash of the normalized hint text.
 * If the same content hash was seen before in this session, replaces the full
 * hint text with a short "Same as previously shown hint for <context>" stub.
 * (Python dedup_hints.)
 */
export function dedup_hints(
  hint_items: HintItem[],
  session_cache: SessionCache | null,
): HintItem[] {
  if (session_cache === null) {
    return hint_items;
  }

  const result: HintItem[] = [];
  for (const item of hint_items) {
    // Normalize hint text: strip whitespace, convert to lowercase for comparison.
    const normalized = item.text.trim().toLowerCase();
    // Compute content hash: first 8 hex chars of SHA256.
    const content_hash = _sha256_hex(normalized, 8);

    // Check if this content has been seen before.
    const prior_summary = session_cache.get_hint_content_summary(content_hash);
    if (prior_summary !== null) {
      // Duplicate content: increment count and replace with short stub.
      const summary = item.text.replace(/\n/g, " ").slice(0, 50);
      session_cache.record_hint_content_seen(content_hash, summary);
      const stub_text = `Same as previously shown hint for '${prior_summary}...'`;
      result.push(new HintItem(stub_text, item.hint_priority));
    } else {
      // First occurrence: keep original, record for future dedup.
      const summary = item.text.replace(/\n/g, " ").slice(0, 50);
      session_cache.record_hint_content_seen(content_hash, summary);
      result.push(item);
    }
  }

  return result;
}

// ===========================================================================
// Terse-mode substitution table
// ===========================================================================
// Applied at the end of every hint constructor via _apply_terse(). Each entry
// replaces a verbose phrase with a compact token-saving equivalent. Order
// matters: longer/more-specific patterns must precede shorter ones that share a
// prefix. (Python _TERSE — same key order, which JS Map preserves.)
const _TERSE: Array<[string, string]> = [
  ["cached", "⌘"],
  ["exit=", "x="],
  ["ran ", "×"],
  ["use `offset=", "→offset="],
  // Keep "tok" consistent with the token_estimate_header format (~N tok).
  [" tokens).", " tok)."],
  ["to read selectively.", "selectively."],
  // Cache-hit verbs: ~18 chars saved per bash/web cache hint fire.
  ["to read without re-running.", "(no re-run)."],
  ["to read without re-fetching.", "(no re-fetch)."],
];

/** Apply all _TERSE substitutions to *text* and return the result. */
function _apply_terse(text: string): string {
  let out = text;
  for (const [verbose, terse] of _TERSE) {
    out = out.split(verbose).join(terse);
  }
  return out;
}

/**
 * Return a short stub hint for when a fingerprint has been seen Nx already.
 * Carries 0 tokens_saved because suppressing the verbose text is the saving.
 * (Python _make_short_stub_hint.)
 */
export function _make_short_stub_hint(seen_count: number): ReadHint {
  return new ReadHint(
    `(↳ same hint seen ${seen_count}×, see prior context)`,
    0,
  );
}

// ===========================================================================
// Structured-JSON sidecar (opt-in via [hints] json_sidecar = true)
// ===========================================================================

// Cap on the size of any single sidecar JSON line to bound worst-case overhead.
const _JSON_SIDECAR_MAX_BYTES = 400;

// Separator placed between the sidecar JSON line and the existing prose hint.
const _JSON_SIDECAR_SEP = "\n";

/**
 * Return True when [hints] json_sidecar is enabled in config or env. Fails
 * closed (returns False) if config loading raises. (Python _json_sidecar_enabled.)
 */
export function _json_sidecar_enabled(): boolean {
  try {
    return Boolean(config.load().hints?.json_sidecar);
  } catch {
    return false; // fail-soft; sidecar is purely additive
  }
}

/**
 * Return *hint* unchanged when the JSON sidecar is disabled, else prepend a
 * compact JSON line. null fields are dropped. tokens_saved is preserved on the
 * wrapped result. Fail-soft: any exception returns the original hint unchanged.
 * (Python _emit_json_sidecar.)
 */
export function _emit_json_sidecar(
  hint: ReadHint | null,
  kind: string,
  fields: Record<string, unknown> = {},
): ReadHint | null {
  if (hint === null) {
    return null;
  }
  if (!_json_sidecar_enabled()) {
    return hint;
  }
  try {
    const payload: Record<string, unknown> = { hint: kind };
    for (const [k, v] of Object.entries(fields)) {
      if (v === null || v === undefined) {
        continue;
      }
      payload[k] = v;
    }
    const line = _compactJson(payload);
    if (utf8Bytes(line).length > _JSON_SIDECAR_MAX_BYTES) {
      // Pathological payload — drop the sidecar rather than bloat context.
      return hint;
    }
    const combined = `${line}${_JSON_SIDECAR_SEP}${hint.text}`;
    return new ReadHint(combined, hint.tokens_saved);
  } catch (exc) {
    _LOG.debug("_emit_json_sidecar: skipped (encoding error: %s)", exc);
    return hint;
  }
}

/**
 * Render an object as a compact JSON line with no internal whitespace, matching
 * Python's json.dumps(payload, separators=(",", ":"), ensure_ascii=False).
 * JSON.stringify already uses no spaces and does not escape non-ASCII, so this
 * is a thin wrapper retained for intent + the ensure_ascii=False guarantee.
 */
function _compactJson(payload: Record<string, unknown>): string {
  return JSON.stringify(payload);
}

// Max length for a file path embedded in an LLM-context hint string.
const _MAX_HINT_PATH_LEN = 300;

// Max display length for a grep pattern in dedup hints.
const _MAX_GREP_PATTERN_DISPLAY_LEN = 60;

/**
 * Return the first *length* hex characters of the SHA-256 of *text*. (Python
 * _sha256_hex.) Removes the repeated inline hashlib.sha256(...).hexdigest()[:N].
 */
export function _sha256_hex(text: string, length = 12): string {
  return createHash("sha256").update(Buffer.from(text, "utf8")).digest("hex").slice(0, length);
}

/**
 * Return a stable SHA256 fingerprint (first 12 hex chars) of hint text + path.
 * The fingerprint includes the file path so two different files producing
 * identical hint text are not treated as duplicates. (Python _hint_fingerprint.)
 */
export function _hint_fingerprint(hint_text: string, path_value = ""): string {
  const key = path_value ? `${path_value}|${hint_text}` : hint_text;
  return _sha256_hex(key);
}

/**
 * Strip newlines/CRs and cap length for a path embedded in an LLM hint string.
 * Neutralises the newline-injection vector before any path reaches a hint
 * template literal. (Python _sanitize_hint_path.)
 */
export function _sanitize_hint_path(p: string): string {
  return sanitize_log_str(p, _MAX_HINT_PATH_LEN);
}

/**
 * Sanitise a symbol name for safe interpolation inside a double-quoted CLI hint.
 * Builds on _sanitize_hint_path and additionally replaces embedded double quotes
 * with single quotes (no shell-escaping ambiguity). (Python _sanitize_hint_symbol.)
 */
export function _sanitize_hint_symbol(name: string): string {
  return _sanitize_hint_path(name).replace(/"/g, "'");
}

// Process-local cache for pattern display strings. Keyed on the pattern string
// (a stable, collision-free identity for the rendered-display memo). Soft-cap at
// _PATTERN_DISPLAY_CACHE_MAX; cleared (full reset) rather than LRU-evicted.
// (Python _PATTERN_DISPLAY_CACHE; registered for reset below.)
export const _PATTERN_DISPLAY_CACHE: Map<string, string> = new Map();
const _PATTERN_DISPLAY_CACHE_MAX = 256;

registerReset(() => {
  _PATTERN_DISPLAY_CACHE.clear();
});

/**
 * Return a display-safe version of a grep pattern for use in hint text.
 * Sanitises newlines/CRs, then truncates to _MAX_GREP_PATTERN_DISPLAY_LEN chars.
 * Results are memoised in _PATTERN_DISPLAY_CACHE. (Python _truncate_pattern_display.)
 */
export function _truncate_pattern_display(pattern: string): string {
  const cached = _PATTERN_DISPLAY_CACHE.get(pattern);
  if (cached !== undefined) {
    return cached;
  }
  const safe = _sanitize_hint_path(pattern);
  let display: string;
  if (safe.length > _MAX_GREP_PATTERN_DISPLAY_LEN) {
    display = safe.slice(0, _MAX_GREP_PATTERN_DISPLAY_LEN) + "…";
  } else {
    display = safe;
  }
  if (_PATTERN_DISPLAY_CACHE.size >= _PATTERN_DISPLAY_CACHE_MAX) {
    _PATTERN_DISPLAY_CACHE.clear();
  }
  _PATTERN_DISPLAY_CACHE.set(pattern, display);
  return display;
}

/** Shape of one row returned by the symbols SELECT. (Python _SymbolRow.) */
interface _SymbolRow {
  kind: string;
  name: string;
  line: number;
  end_line: number;
}

// ===========================================================================
// Token estimator + thresholds
// ===========================================================================
// Token estimator: ~3.5 chars/token, ~60 chars/line code → ~17 tokens/line.
// CHARS_PER_TOKEN is an overridable `let` + setCharsPerToken() seam because some
// tests monkeypatch hints.CHARS_PER_TOKEN. The impl reads it through
// _charsPerToken() and derives TOKENS_PER_LINE from the live value.
export let CHARS_PER_TOKEN = 3.5;
export const AVG_CHARS_PER_LINE = 60;
export let TOKENS_PER_LINE = AVG_CHARS_PER_LINE / CHARS_PER_TOKEN; // ≈17.1

/**
 * Test seam: override hints.CHARS_PER_TOKEN (and re-derive TOKENS_PER_LINE).
 * Mirrors monkeypatch.setattr(hints, "CHARS_PER_TOKEN", x): keep the two derived
 * values consistent the way reassigning the module attribute would in Python.
 */
export function setCharsPerToken(value: number): void {
  CHARS_PER_TOKEN = value;
  TOKENS_PER_LINE = AVG_CHARS_PER_LINE / CHARS_PER_TOKEN;
}

/** Read the live CHARS_PER_TOKEN (honours setCharsPerToken / direct reassignment). */
function _charsPerToken(): number {
  return CHARS_PER_TOKEN;
}

/** Read the live TOKENS_PER_LINE derived from CHARS_PER_TOKEN. */
function _tokensPerLine(): number {
  return AVG_CHARS_PER_LINE / _charsPerToken();
}

// Thresholds
export const LARGE_FILE_LINE_THRESHOLD = 500;
// Minimum overlap required before emitting a partial-overlap warning.
export const MIN_OVERLAP_TO_WARN = 50;
// Claude Code's default lines-per-Read when the caller omits a limit.
export const DEFAULT_READ_LIMIT = 2000;

// How old a cached read may be before the dedup hint is suppressed.
export const STALE_READ_AGE_SECONDS = 30 * 60;

/**
 * Return an adaptive staleness threshold in seconds.
 * Formula: clamp(session_age * 0.25, 900, STALE_READ_AGE_SECONDS).
 * (Python compute_stale_threshold.)
 */
export function compute_stale_threshold(session_age_secs: number): number {
  return Math.max(900.0, Math.min(STALE_READ_AGE_SECONDS, session_age_secs * 0.25));
}

/**
 * Extract session age and compute stale threshold in one helper. (Python
 * _session_stale_threshold.)
 */
export function _session_stale_threshold(cache: SessionCache | null, now: number): number {
  const created_ts = cache !== null ? (cache as { created_ts?: number }).created_ts : undefined;
  const session_age = created_ts !== undefined && created_ts !== null
    ? now - created_ts
    : STALE_READ_AGE_SECONDS;
  return compute_stale_threshold(session_age);
}

// How many bytes to assume per line when estimating line count from file size.
const _BYTES_PER_LINE_ESTIMATE = 75;

// Maximum number of indexed symbols to fetch per file in one DB query.
const _MAX_INDEXED_SYMBOLS_FETCHED = 50;

// Maximum character budget for the "[symbols: ...]" suffix appended to cache hints.
const _SYMBOLS_SUFFIX_MAX_CHARS = 60;

// A file read this many times or more is a "working file".
export const _SUPPRESS_HINT_AT_READ_COUNT = 5;

// Maximum number of cached ranges shown in the hint text.
export const _MAX_CACHED_RANGES_DISPLAY = 10;

// A request narrower than this (with an explicit limit) is "surgical intent".
const _NARROW_EXPLICIT_READ_LINES = MIN_OVERLAP_TO_WARN;

// Minimum line count for a file to warrant an "already read" hint.
const _MIN_LINES_FOR_HINT = 30;

/**
 * A pre-read hint carrying the genuine token saving it represents. Ported from
 * Python's `class ReadHint(str)`; see the file header for the full public API.
 *
 * `tokens_saved` is 0 for *suggestion* hints (firing the suggestion realizes no
 * saving) and non-zero only for dedup hints that warn about re-reading content
 * already in the session (a concrete, already-realized avoided cost).
 */
export class ReadHint {
  text: string;
  tokens_saved: number;

  constructor(text: string, tokens_saved = 0) {
    this.text = text;
    this.tokens_saved = tokens_saved;
  }

  toString(): string {
    return this.text;
  }

  valueOf(): string {
    return this.text;
  }
}

// ===========================================================================
// Shared fail-soft decorator for all hint builders
// ===========================================================================

/**
 * Wrap a hint builder: catch any exception raised by the inner implementation
 * and return null so the calling hook stays fail-soft. When the wrapped call
 * passes `session_id` in its keyword-arg options object it is included
 * (truncated to 16 chars) in the log line. (Python _failsoft_hint.)
 *
 * The TS builders take a single options object (mirroring Python keyword-only
 * args), so this wraps `(opts) => ReadHint | null` callables.
 */
function _failsoft_hint<A>(
  fn: (args: A) => ReadHint | null,
  fnName: string,
): (args: A) => ReadHint | null {
  return (args: A): ReadHint | null => {
    try {
      return fn(args);
    } catch (exc) {
      // Read session_id defensively: not every builder's args carry it (the
      // structured-file / index-only builders take {file_path, offset, limit}).
      const sid = (args as { session_id?: unknown } | null | undefined)?.session_id;
      const session_id_str = sid ? String(sid).slice(0, 16) : "";
      _LOG.warning(
        "%s: unexpected error (session=%s): %s",
        fnName,
        session_id_str,
        exc,
      );
      return null;
    }
  };
}

/**
 * Return a compact ' [symbols: a, b +N]' suffix, or '' if the list is empty.
 * Lists the first three symbol names; shows '+N' when there are more. Capped at
 * *max_chars* — returns '' rather than truncating a name mid-way. (Python
 * _symbols_suffix.)
 */
function _symbols_suffix(symbols_read: string[], max_chars = _SYMBOLS_SUFFIX_MAX_CHARS): string {
  if (symbols_read.length === 0) {
    return "";
  }
  const preview = symbols_read.slice(0, 3);
  const overflow = symbols_read.length - preview.length;
  const overflow_str = overflow > 0 ? ` +${overflow}` : "";
  const names_part = preview.join(", ");
  const suffix = ` [symbols: ${names_part}${overflow_str}]`;
  if (suffix.length > max_chars) {
    return "";
  }
  return suffix;
}

/** Rough token estimate from line count (integer, never < 1). (Python _est_tokens_from_lines.) */
export function _est_tokens_from_lines(n_lines: number): number {
  return Math.max(1, Math.trunc(n_lines * _tokensPerLine()));
}

/** Rough token estimate from character count. (Python _est_tokens_from_chars.) */
export function _est_tokens_from_chars(n_chars: number): number {
  return Math.max(1, Math.trunc(n_chars / _charsPerToken()));
}

/** Cheap newline count; returns null on any error. (Python _line_count.) */
export function _line_count(p: string): number | null {
  try {
    const st = fs.statSync(p);
    if (!st.isFile()) {
      return null;
    }
    const buf = fs.readFileSync(p);
    let count = 0;
    for (let i = 0; i < buf.length; i++) {
      if (buf[i] === 0x0a) {
        count++;
      }
    }
    return count;
  } catch {
    return null;
  }
}

/**
 * Return *abs_path* relative to *base* as a posix string, or null when it is not
 * under *base*. Mirrors Python's Path(p).relative_to(base).as_posix() (raises
 * ValueError → null here). Both inputs are normalised so a Windows-drive or
 * trailing-separator mismatch does not produce a false "not under" result.
 */
function _relativeTo(abs_path: string, base: string): string | null {
  const rel = path.relative(base, abs_path);
  // path.relative returns "" when equal, or a "../"-prefixed path when not
  // contained. Python's relative_to raises ValueError in the "not under" case.
  if (rel === "") {
    return ".";
  }
  if (rel.startsWith("..") || path.isAbsolute(rel)) {
    return null;
  }
  return rel.split(path.sep).join("/");
}

/** True for a Node fs error (the analogue of Python's OSError on a stat/open). */
function _isOSError(exc: unknown): boolean {
  return (
    exc instanceof Error &&
    typeof (exc as NodeJS.ErrnoException).code === "string"
  );
}

/** Path(p).is_file() analogue: true iff *p* exists and is a regular file. */
function _isFile(p: string): boolean {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

/** read_text(encoding="utf-8", errors="replace") analogue. */
function _readTextReplace(p: string): string {
  return fs.readFileSync(p).toString("utf8");
}

/**
 * Read the first *n* bytes of *p* into a Buffer (Python `fh.read(n)` on a binary
 * file). Throws on I/O error (the caller's try/catch maps it to OSError-fail-soft).
 */
function _readFirstBytes(p: string, n: number): Buffer {
  const fd = fs.openSync(p, "r");
  try {
    const buf = Buffer.alloc(n);
    const bytesRead = fs.readSync(fd, buf, 0, n, 0);
    return buf.subarray(0, bytesRead);
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * Python `isinstance(x, int)` analogue for the index-only / structured surgical
 * guards: true for an integer-valued number. Booleans are excluded — the harness
 * delivers offset/limit as numbers and a bool there is a malformed value (the
 * Python sites only ever receive ints/None in practice).
 */
function _isInt(x: unknown): x is number {
  return typeof x === "number" && Number.isInteger(x);
}

/**
 * Path(p).suffix analogue: the final ".<ext>" of the basename, or "" when the
 * name has no dot, the only dot is leading (a dotfile like ".env" has suffix ""),
 * or the name ends with a dot. Mirrors pathlib's suffix exactly for the
 * extension checks the structured-file hint performs.
 */
function _suffix(p: string): string {
  const name = path.basename(p);
  const dot = name.lastIndexOf(".");
  if (dot <= 0 || dot === name.length - 1) {
    return "";
  }
  return name.slice(dot);
}

/**
 * Read the first text line of *p* (Python `fh.open(errors="replace").readline()`):
 * the bytes up to and including the first "\n", decoded as UTF-8. Reads only a
 * bounded prefix so a huge single-line file does not load whole. The returned
 * line keeps no trailing "\n" guarantee — callers .trim() it (matching Python's
 * .strip() on the readline result).
 */
function _readFirstLine(p: string): string {
  const PROBE = 65_536;
  const buf = _readFirstBytes(p, PROBE);
  const nl = buf.indexOf(0x0a);
  const slice = nl >= 0 ? buf.subarray(0, nl + 1) : buf;
  return slice.toString("utf8");
}

/**
 * Posix-style Path(p).parent: the directory portion of a forward-slash path.
 * Mirrors pathlib's parent on a project-relative rel_path (always posix).
 */
function _posixDirname(p: string): string {
  const idx = p.lastIndexOf("/");
  if (idx < 0) {
    return ".";
  }
  if (idx === 0) {
    return "/";
  }
  return p.slice(0, idx);
}

/**
 * Format an integer with comma thousands separators (Python f"{n:,}"). Used in
 * bash/web dedup hint byte counts so the rendered text matches the Python form.
 */
function _comma(n: number): string {
  return Math.trunc(n).toLocaleString("en-US");
}

/**
 * Python str.splitlines() (NO keepends): split on universal newlines and drop
 * the terminators. Reuses _splitlinesKeepends then strips the trailing break of
 * each piece, mirroring CPython's boundary set.
 */
function _splitlines(text: string): string[] {
  return _splitlinesKeepends(text).map((line) => _stripTrailingBreak(line));
}

/** Remove the single trailing line break (\r\n or any one boundary char) from *line*. */
function _stripTrailingBreak(line: string): string {
  const n = line.length;
  if (n === 0) {
    return line;
  }
  const last = line.charCodeAt(n - 1);
  const isBreakCode = (c: number): boolean =>
    c === 0x0a ||
    c === 0x0d ||
    c === 0x0b ||
    c === 0x0c ||
    c === 0x1c ||
    c === 0x1d ||
    c === 0x1e ||
    c === 0x85 ||
    c === 0x2028 ||
    c === 0x2029;
  if (!isBreakCode(last)) {
    return line;
  }
  if (n >= 2 && last === 0x0a && line.charCodeAt(n - 2) === 0x0d) {
    return line.slice(0, n - 2);
  }
  return line.slice(0, n - 1);
}
/**
 * Return symbols AND actual or estimated line count in one query. The third flag
 * indicates whether the count is exact (from the line_count column) or estimated
 * from file size. The two-step SELECT handles older DB schemas that pre-date the
 * line_count column. (Python _get_indexed_symbols_and_line_count.)
 *
 * Returns [symbols, n_lines | null, line_count_is_exact].
 */
export function _get_indexed_symbols_and_line_count(
  file_rel: string,
  project_hash: string,
): [_SymbolRow[], number | null, boolean] {
  try {
    return db.openProject(project_hash, (conn: DatabaseType): [_SymbolRow[], number | null, boolean] => {
      // Fetch file metadata; fall back to size-only on older schemas.
      let file_row: { size?: number; line_count?: number | null } | undefined;
      let db_has_line_count_column: boolean;
      try {
        file_row = conn
          .prepare("SELECT size, line_count FROM files WHERE rel_path = ?")
          .get(file_rel) as { size?: number; line_count?: number | null } | undefined;
        db_has_line_count_column = true;
      } catch (exc) {
        if (!String((exc as Error).message ?? exc).toLowerCase().includes("line_count")) {
          throw exc;
        }
        file_row = conn
          .prepare("SELECT size FROM files WHERE rel_path = ?")
          .get(file_rel) as { size?: number } | undefined;
        db_has_line_count_column = false;
      }

      const sym_rows = conn
        .prepare(
          `
                SELECT kind, name, line, end_line
                FROM symbols
                WHERE file_rel = ? AND name IS NOT NULL AND end_line IS NOT NULL
                ORDER BY line
                LIMIT ${_MAX_INDEXED_SYMBOLS_FETCHED}
                `,
        )
        .all(file_rel) as Array<{ kind: unknown; name: unknown; line: unknown; end_line: unknown }>;

      // Resolve line count: prefer the stored exact value; fall back to a
      // size-based estimate when the column is absent or NULL.
      let n_lines: number | null;
      let line_count_is_exact: boolean;
      if (file_row) {
        if (db_has_line_count_column && file_row.line_count !== null && file_row.line_count !== undefined) {
          n_lines = Math.trunc(file_row.line_count);
          line_count_is_exact = true;
        } else {
          const size = Number(file_row.size ?? 0);
          n_lines = Math.max(1, Math.trunc(size / _BYTES_PER_LINE_ESTIMATE));
          line_count_is_exact = false;
        }
      } else {
        n_lines = null;
        line_count_is_exact = false;
      }

      const sym_dicts: _SymbolRow[] = sym_rows.map((r) => ({
        kind: String(r.kind),
        name: String(r.name),
        line: Math.trunc(Number(r.line)),
        end_line: Math.trunc(Number(r.end_line)),
      }));
      return [sym_dicts, n_lines, line_count_is_exact];
    });
  } catch (exc) {
    _LOG.debug("failed to load indexed symbols for %s: %s", file_rel, exc);
    return [[], null, false];
  }
}

/**
 * Return a ReadHint, or null when no hint is warranted. Never raises: any
 * unexpected exception is caught and logged. (Python build_read_hint.)
 */
export function build_read_hint(args: {
  session_id: string | null;
  file_path: string;
  offset: number | null;
  limit: number | null;
  cwd: string | null;
  cache?: SessionCache | null;
  large_file_line_threshold?: number;
}): ReadHint | null {
  const {
    session_id,
    file_path,
    offset,
    limit,
    cwd,
  } = args;
  const cache = args.cache ?? null;
  const large_file_line_threshold = args.large_file_line_threshold ?? LARGE_FILE_LINE_THRESHOLD;
  try {
    let hint = _build_read_hint_inner({
      session_id,
      file_path,
      offset,
      limit,
      cwd,
      cache,
      threshold: large_file_line_threshold,
    });
    // JSON sidecar: opt-in machine-readable line prepended after dedup so
    // fingerprint dedup keeps deduping correctly. No-op when [hints]
    // json_sidecar is off (default).
    if (hint !== null) {
      const kind = hint.tokens_saved > 0 ? "already_read" : "read_suggestion";
      hint = _emit_json_sidecar(hint, kind, {
        file: file_path,
        wasted: hint.tokens_saved || null,
      });
    }
    return hint;
  } catch (exc) {
    _LOG.warning(
      "build_read_hint: unexpected error for %s (session=%s): %s",
      JSON.stringify(file_path),
      (session_id ?? "").slice(0, 16),
      exc,
    );
    return null;
  }
}

/** Inner implementation of build_read_hint; may raise. (Python _build_read_hint_inner.) */
function _build_read_hint_inner(args: {
  session_id: string | null;
  file_path: string;
  offset: number | null;
  limit: number | null;
  cwd: string | null;
  cache?: SessionCache | null;
  threshold?: number;
}): ReadHint | null {
  const { session_id, offset, limit, cwd } = args;
  let file_path = args.file_path;
  let cache = args.cache ?? null;
  const threshold = args.threshold ?? LARGE_FILE_LINE_THRESHOLD;

  if (!session_id || !file_path) {
    _LOG.debug(
      "build_read_hint: skipped (session_id=%s, file_path=%s)",
      JSON.stringify(session_id),
      JSON.stringify(file_path),
    );
    return null;
  }

  // Requested line range (1-indexed inclusive).
  const safe_offset = offset !== null && offset !== undefined ? Math.max(0, Math.trunc(offset)) : 0;
  const safe_limit = limit !== null && limit !== undefined ? Math.max(0, Math.trunc(limit)) : 0;
  const req_start = safe_offset + 1;
  const req_end = req_start + (safe_limit || DEFAULT_READ_LIMIT) - 1;
  // An explicit limit signals "surgical intent".
  const has_explicit_limit = safe_limit > 0;

  // Compute fname once; sanitize both so every downstream hint template is safe.
  const fname = _sanitize_hint_path(path.basename(file_path));
  file_path = _sanitize_hint_path(file_path);

  // Compute a shorter recall_path (relative path when cwd is available).
  let recall_path: string = file_path;
  if (cwd) {
    const rel = _relativeTo(file_path, cwd);
    if (rel !== null) {
      recall_path = _sanitize_hint_path(rel);
    }
  }

  // 1. Check session cache first.
  if (cache === null) {
    cache = load_session_safe(session_id);
  }
  const entry = session.get_file_entry(session_id, file_path, { cache });
  if (entry !== null) {
    // Curator: if the agent has been ignoring re-read dedup hints, stop emitting.
    if (cache === null || !_curator_should_emit(cache)) {
      return null;
    }
    // Budget: hard cap on total dedup hints for the session.
    if (cache !== null && !_hint_budget_check(cache, _HINT_KIND_DEDUP)) {
      return null;
    }
    const hint = _hint_from_cache(entry, req_start, req_end, file_path, {
      fname,
      recall_path,
      has_explicit_limit,
      cache,
      cwd,
    });
    if (hint !== null) {
      // Apply minimum-savings threshold: suppress re-read dedup hints where the
      // estimated bytes saved is below the configured floor. Only dedup hints
      // (tokens_saved > 0); suggestion hints are never suppressed here.
      if (hint.tokens_saved > 0) {
        let _min_bytes: number;
        try {
          _min_bytes = config.load().hints?.min_session_hint_savings_bytes ?? 0;
        } catch {
          _min_bytes = 0;
        }
        if (_min_bytes > 0) {
          const estimated_bytes_saved = hint.tokens_saved * 3;
          if (estimated_bytes_saved < _min_bytes) {
            _LOG.debug(
              "build_read_hint: suppressing hint for %s (bytes_saved=%d < threshold=%d)",
              fname,
              estimated_bytes_saved,
              _min_bytes,
            );
            return null;
          }
        }
      }
      _LOG.debug(
        "build_read_hint: cache hint for %s lines %d-%d (tokens_saved=%d)",
        fname,
        req_start,
        req_end,
        hint.tokens_saved,
      );
    } else {
      _LOG.debug("build_read_hint: no hint (non-overlapping prior read of %s)", fname);
    }
    return hint;
  }

  // 2. Not cached — consider "large file with indexed symbols" suggestion or
  // "co-read import suggestions" for small source files.
  // Fast-path: a file smaller than threshold * _BYTES_PER_LINE_ESTIMATE bytes
  // can never have enough lines to trigger a hint.
  let _stat_size: number | null = null;
  try {
    _stat_size = fs.statSync(file_path).size;
    if (_stat_size < threshold * _BYTES_PER_LINE_ESTIMATE) {
      _LOG.debug(
        "build_read_hint: stat-skip index for %s (%dB < %dB threshold)",
        fname,
        _stat_size,
        threshold * _BYTES_PER_LINE_ESTIMATE,
      );
      // Before returning null, check for co-read suggestions on supported
      // source files on first read (when cache entry is None).
      const _fp_lower = file_path.toLowerCase();
      const _coread_eligible =
        _fp_lower.endsWith(_PY_SUFFIX) ||
        _TS_JS_SUFFIXES.some((s) => _fp_lower.endsWith(s)) ||
        _fp_lower.endsWith(_GO_SUFFIX);
      if (_coread_eligible) {
        const _cwd_path = validate_cwd(cwd, { caller: "_build_read_hint_inner (coread)" });
        if (_cwd_path !== null) {
          const _project = find_project(_cwd_path);
          if (_project !== null) {
            const _coread_hint = _build_coread_suggestion_hint(file_path, _project.hash, cache);
            if (_coread_hint !== null) {
              _LOG.debug("build_read_hint: coread hint for %s", fname);
              return _coread_hint;
            }
          }
        }
      }
      return null;
    }
  } catch (exc) {
    if (!_isOSError(exc)) {
      throw exc;
    }
    // OSError (missing file, permission error) falls through to _hint_from_index.
  }

  const hint = _hint_from_index(file_path, cwd, req_start, req_end, { fname, threshold });
  if (hint !== null) {
    _LOG.debug("build_read_hint: index hint for %s (large file suggestion)", fname);
  } else {
    _LOG.debug("build_read_hint: no hint for %s (not in session cache, not large/indexed)", fname);
  }
  return hint;
}

// ---------------------------------------------------------------------------
// Line-range helpers
// ---------------------------------------------------------------------------

// Minimum line proximity gap before a "you already read this file" hint is
// suppressed as a false positive.
export const _PROXIMITY_SLOP_LINES = 200;

/**
 * Return [global_min_start, global_max_end] across all cached line ranges in a
 * single pass. Callers must verify the list is non-empty. (Python
 * _line_ranges_global_bounds.)
 */
export function _line_ranges_global_bounds(
  line_ranges: Array<[number, number]>,
): [number, number] {
  let global_min = line_ranges[0]![0];
  let global_max = line_ranges[0]![1];
  for (let i = 1; i < line_ranges.length; i++) {
    const [range_start, range_end] = line_ranges[i]!;
    if (range_start < global_min) {
      global_min = range_start;
    }
    if (range_end > global_max) {
      global_max = range_end;
    }
  }
  return [global_min, global_max];
}

/**
 * Return the count of distinct lines covered by *line_ranges* (size of the union
 * of the (start, end) tuples). A (0, 0) sentinel contributes nothing. (Python
 * _total_cached_lines.)
 */
export function _total_cached_lines(line_ranges: Array<[number, number]>): number {
  const spans = line_ranges
    .filter(([s, e]) => e >= s && !(s === 0 && e === 0))
    .sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  if (spans.length === 0) {
    return 0;
  }
  let total = 0;
  let [cur_start, cur_end] = spans[0]!;
  for (let i = 1; i < spans.length; i++) {
    const [s, e] = spans[i]!;
    if (s <= cur_end + 1) {
      // contiguous or overlapping — extend the current span
      if (e > cur_end) {
        cur_end = e;
      }
    } else {
      // gap — close out the current span and start a new one
      total += cur_end - cur_start + 1;
      cur_start = s;
      cur_end = e;
    }
  }
  total += cur_end - cur_start + 1;
  return total;
}

/**
 * Return True when a full-file hint should be suppressed based on line count.
 * (Python _should_suppress_full_file_hint.)
 */
export function _should_suppress_full_file_hint(n_lines: number | null, threshold?: number | null): boolean {
  let thr = threshold;
  if (thr === undefined || thr === null) {
    thr = config.load().hints?.min_file_lines_for_hint ?? 0;
  }
  if (thr <= 0 || n_lines === null) {
    return false;
  }
  return n_lines < thr;
}

/**
 * Return the DB-indexed line count for *file_path*, or null if unavailable.
 * (Python _indexed_line_count.)
 */
function _indexed_line_count(file_path: string, cwd: string | null): number | null {
  if (!cwd) {
    return null;
  }
  try {
    const project = find_project(cwd);
    if (project === null) {
      return null;
    }
    let abs_p = file_path;
    if (!path.isAbsolute(abs_p)) {
      abs_p = path.resolve(project.root, file_path);
    }
    const rel = _relativeTo(abs_p, project.root);
    if (rel === null) {
      return null;
    }
    return db.openProjectReadonly(project.hash, (conn: DatabaseType): number | null => {
      const row = conn
        .prepare("SELECT line_count FROM files WHERE rel_path = ?")
        .get(rel) as { line_count?: number | null } | undefined;
      return row && row.line_count !== null && row.line_count !== undefined
        ? Math.trunc(row.line_count)
        : null;
    });
  } catch {
    return null;
  }
}

/**
 * Build hint when the file was already accessed this session.
 * (Python _hint_from_cache.)
 */
function _hint_from_cache(
  entry: FileEntry,
  req_start: number,
  req_end: number,
  file_path_in: string,
  opts: {
    fname?: string | null;
    recall_path?: string | null;
    has_explicit_limit?: boolean;
    cache?: SessionCache | null;
    cwd?: string | null;
  } = {},
): ReadHint | null {
  let fname = opts.fname ?? null;
  let recall_path = opts.recall_path ?? null;
  const has_explicit_limit = opts.has_explicit_limit ?? false;
  const cache = opts.cache ?? null;
  const cwd = opts.cwd ?? null;

  if (fname === null) {
    fname = _sanitize_hint_path(path.basename(file_path_in));
  }
  const file_path = _sanitize_hint_path(file_path_in);
  if (recall_path === null) {
    recall_path = file_path;
  }
  const requested_lines = req_end - req_start + 1;

  // Suppress the line-range dedup hint when the cached ranges are no longer
  // trustworthy: edited after last read, or read is stale.
  const edited_after_read = entry.last_edit_ts > entry.last_read_ts;
  const now = _now();
  const stale_threshold = _session_stale_threshold(cache, now);
  const read_is_stale = now - entry.last_read_ts > stale_threshold;
  if ((edited_after_read || read_is_stale) && entry.line_ranges.length > 0) {
    _LOG.debug(
      "_hint_from_cache: suppressing line-range hint for %s (edited_after_read=%s, read_is_stale=%s)",
      fname,
      edited_after_read,
      read_is_stale,
    );
    if (entry.symbols_read.length === 0) {
      return null;
    }
    // Symbols still meaningful but combined symbols+ranges entry suppresses both.
    return null;
  }

  // Full-file collapse sentinel: line_ranges == [(0, 0)].
  if (_isFullFileSentinel(entry.line_ranges)) {
    const sym_suffix = _symbols_suffix(entry.symbols_read);
    return new ReadHint(
      _apply_terse(
        `\`${fname}\` full file ×${entry.read_count}${sym_suffix}. ` +
          `In context; range hints suppressed.`,
      ),
      0, // No tokens saved — the file is in context; this is informational.
    );
  }

  // Line-count threshold suppression for tiny files.
  if (entry.line_ranges.length > 0 && !_isFullFileSentinel(entry.line_ranges)) {
    const max_line = Math.max(...entry.line_ranges.map(([, cached_end]) => cached_end));
    const _min_lines = config.load().hints?.min_file_lines_for_hint ?? 0;
    if (_should_suppress_full_file_hint(max_line, _min_lines)) {
      // max_line proxy says "maybe suppress". Resolve the true line count.
      let _true_lines: number | null = _indexed_line_count(file_path, cwd);
      if (_true_lines === null) {
        _true_lines = _line_count(file_path);
      }
      if (_true_lines !== null && _true_lines >= _min_lines) {
        // File is large; max_line undercount — do not suppress.
      } else {
        _LOG.debug(
          "_hint_from_cache: suppressing full-file hint for %s (line_count=%d < threshold=%d)",
          fname,
          _true_lines !== null ? _true_lines : max_line,
          _min_lines,
        );
        if (entry.symbols_read.length === 0) {
          return null;
        }
        // File is small but has surgical-read symbols — emit symbol-only hint.
        const n_syms = entry.symbols_read.length;
        const sym_list = entry.symbols_read
          .slice(0, 3)
          .map((s) => `\`${s}\``)
          .join(", ");
        const more = n_syms > 3 ? ` +${n_syms - 3}` : "";
        return new ReadHint(
          _apply_terse(
            `\`${fname}\` read via \`token-goat read\`: ${sym_list}${more}. ` +
              `Use \`token-goat read "${recall_path}::symbol"\` for more.`,
          ),
          0,
        );
      }
    }
  }

  // Frequently-read files: emit a one-time surgical-read nudge.
  if (entry.read_count >= _SUPPRESS_HINT_AT_READ_COUNT && entry.line_ranges.length > 0) {
    const sym_suffix = _symbols_suffix(entry.symbols_read);
    _LOG.debug(
      "_hint_from_cache: surgical-read nudge for %s (working file: read_count=%d)",
      fname,
      entry.read_count,
    );
    return new ReadHint(
      _apply_terse(
        `\`${fname}\` re-read often${sym_suffix}. ` +
          `Use \`token-goat read "${recall_path}::sym"\` for surgical access.`,
      ),
      0,
    );
  }

  // Suppress hints for very small files (< 30 lines) with only a single prior read.
  if (entry.line_ranges.length > 0 && entry.read_count === 1) {
    const max_line = Math.max(...entry.line_ranges.map(([, cached_end]) => cached_end));
    if (max_line < _MIN_LINES_FOR_HINT) {
      _LOG.debug(
        "_hint_from_cache: suppressing hint for %s (small file: %d lines, read_count=1)",
        fname,
        max_line,
      );
      return null;
    }
  }

  // Case: file accessed only via token-goat read <file>::<symbol>.
  if (read_is_stale && entry.line_ranges.length === 0) {
    return null;
  }
  if (entry.symbols_read.length > 0 && entry.line_ranges.length === 0) {
    const n_syms = entry.symbols_read.length;
    const sym_list = entry.symbols_read
      .slice(0, 3)
      .map((s) => `\`${s}\``)
      .join(", ");
    const more = n_syms > 3 ? ` +${n_syms - 3}` : "";
    return new ReadHint(
      _apply_terse(
        `\`${fname}\` read via \`token-goat read\`: ${sym_list}${more}. ` +
          `Use \`token-goat read "${recall_path}::symbol"\` for more.`,
      ),
      0,
    );
  }

  // Hoist entry.line_ranges to a local.
  const line_ranges = entry.line_ranges;
  const n_ranges = line_ranges.length;

  // Proximity check: when the new read is entirely outside every cached range by
  // more than _PROXIMITY_SLOP_LINES lines, the hint is a false positive.
  if (line_ranges.length > 0) {
    const [global_min, global_max] = _line_ranges_global_bounds(line_ranges);
    if (
      req_start > global_max + _PROXIMITY_SLOP_LINES ||
      req_end < global_min - _PROXIMITY_SLOP_LINES
    ) {
      _LOG.debug(
        "_hint_from_cache: suppressing hint for %s (proximity: req=[%d,%d] cached=[%d,%d] slop=%d)",
        fname,
        req_start,
        req_end,
        global_min,
        global_max,
        _PROXIMITY_SLOP_LINES,
      );
      return null;
    }
  }

  // Compute overlap against all cached ranges in a single pass.
  let overlap_lines = 0;
  let exact_match = false;
  let last_cached_end = 0;
  for (const [cached_start, cached_end] of line_ranges) {
    const overlap_start = Math.max(cached_start, req_start);
    const overlap_end = Math.min(cached_end, req_end);
    if (overlap_end >= overlap_start) {
      overlap_lines += overlap_end - overlap_start + 1;
    }
    if (cached_start <= req_start && cached_end >= req_end) {
      exact_match = true;
    }
    if (cached_end > last_cached_end) {
      last_cached_end = cached_end;
    }
  }

  // Trim the displayed ranges to the _MAX_CACHED_RANGES_DISPLAY most-recent.
  const _display_ranges = [...line_ranges]
    .sort((a, b) => a[0] - b[0])
    .slice(-_MAX_CACHED_RANGES_DISPLAY);
  const _n_hidden = n_ranges - _display_ranges.length;
  const cached_summary = _display_ranges.map(([s, e]) => `${s}-${e}`).join(", ");
  const extra = _n_hidden > 0 ? ` (+${_n_hidden} more ranges)` : "";

  // Exact re-read of already-cached lines — the full request is avoidable.
  if (exact_match) {
    // Surgical intent guard: narrow window with explicit limit → suppress.
    if (has_explicit_limit && requested_lines <= _NARROW_EXPLICIT_READ_LINES) {
      _LOG.debug(
        "_hint_from_cache: suppressing exact-match nag for %s (surgical re-read: %d lines with explicit limit)",
        fname,
        requested_lines,
      );
      return null;
    }
    // Report waste against the full content already in context.
    const cached_lines = _total_cached_lines(line_ranges);
    const wasted = _est_tokens_from_lines(Math.max(cached_lines, requested_lines));
    const sym_suffix = _symbols_suffix(entry.symbols_read);
    return new ReadHint(
      _apply_terse(
        `\`${fname}\` L${req_start}-${req_end} cached (L${cached_summary}${extra})${sym_suffix}. ` +
          `~${wasted}t wasted.`,
      ),
      wasted,
    );
  }

  // Partial overlap — only the overlapping lines are avoidable.
  if (overlap_lines > MIN_OVERLAP_TO_WARN) {
    const wasted = _est_tokens_from_lines(overlap_lines);
    // Suggest starting the next Read just past the last cached line.
    const resume_offset = last_cached_end;
    const sym_suffix = _symbols_suffix(entry.symbols_read);
    return new ReadHint(
      _apply_terse(
        `\`${fname}\` cached L${cached_summary}${extra}${sym_suffix}. ` +
          `Overlap (~${wasted}t) — use \`offset=${resume_offset}\`.`,
      ),
      wasted,
    );
  }

  // Non-overlapping prior read — nothing actionable to say; suppress.
  return null;
}

/**
 * Return a confirmed line count at or above the large-file threshold, or null.
 * (Python _confirmed_line_count.)
 */
function _confirmed_line_count(
  estimated_lines: number,
  line_count_is_exact: boolean,
  abs_path: string,
  threshold: number = LARGE_FILE_LINE_THRESHOLD,
): number | null {
  if (line_count_is_exact) {
    return estimated_lines >= threshold ? estimated_lines : null;
  }
  // Estimate below threshold — check the real file before suppressing the hint.
  if (estimated_lines < threshold) {
    const actual = _line_count(abs_path);
    if (actual === null || actual < threshold) {
      return null;
    }
    return actual;
  }
  // Estimate at or above threshold — trust it without a disk read.
  return estimated_lines;
}

/**
 * Build hint when file is large and has indexed symbols but not yet cached.
 * (Python _hint_from_index.)
 */
function _hint_from_index(
  file_path: string,
  cwd: string | null,
  req_start: number,
  req_end: number,
  opts: { fname?: string | null; threshold?: number } = {},
): ReadHint | null {
  let fname = opts.fname ?? null;
  const threshold = opts.threshold ?? LARGE_FILE_LINE_THRESHOLD;
  if (fname === null) {
    fname = _sanitize_hint_path(path.basename(file_path));
  }
  const cwd_path = validate_cwd(cwd, { caller: "_hint_from_index" });
  if (cwd_path === null) {
    _LOG.debug("_hint_from_index: skipped for %s (no valid cwd)", fname);
    return null;
  }

  const project = find_project(cwd_path);
  if (project === null) {
    _LOG.debug("_hint_from_index: skipped for %s (no project found in %s)", fname, cwd);
    return null;
  }

  let abs_path = file_path;
  if (!path.isAbsolute(abs_path)) {
    abs_path = path.resolve(project.root, file_path);
  }

  // Compute relative path for DB lookup.
  const rel = _relativeTo(abs_path, project.root);
  if (rel === null) {
    _LOG.debug("_hint_from_index: %s not under project root %s", file_path, project.root);
    return null;
  }

  const [symbols, estimated_lines, line_count_is_exact] = _get_indexed_symbols_and_line_count(
    rel,
    project.hash,
  );
  if (estimated_lines === null) {
    _LOG.debug("_hint_from_index: %s not in project index (no file row)", fname);
    return null;
  }

  const n_lines = _confirmed_line_count(estimated_lines, line_count_is_exact, abs_path, threshold);
  if (n_lines === null) {
    _LOG.debug(
      "_hint_from_index: %s below large-file threshold (estimated=%s)",
      fname,
      estimated_lines,
    );
    return null;
  }

  // Line-count threshold suppression for tiny files.
  const _min_lines = config.load().hints?.min_file_lines_for_hint ?? 0;
  if (_should_suppress_full_file_hint(n_lines, _min_lines)) {
    _LOG.debug(
      "_hint_from_index: suppressing index hint for %s (line_count=%d < threshold=%d)",
      fname,
      n_lines,
      _min_lines,
    );
    return null;
  }

  const full_tokens = _est_tokens_from_lines(n_lines);

  if (symbols.length === 0) {
    _LOG.info(
      "_hint_from_index: %s is large (%d lines) but has no indexed symbols (project=%s) — emitting chunk-read hint",
      rel,
      n_lines,
      project.hash.slice(0, 8),
    );
    return new ReadHint(
      _apply_terse(
        `\`${fname}\`: ${n_lines} lines (~${full_tokens} tokens). ` +
          `No symbols indexed. Use offset/limit to chunk.`,
      ),
      0,
    );
  }

  const n_total = symbols.length;
  const first_sym_name = _sanitize_hint_path(symbols[0]!.name);

  // Build a compact listing of up to 3 symbol names.
  const preview_names = symbols.slice(0, 3).map((s) => _sanitize_hint_path(s.name));
  const sym_list_str = preview_names.join(", ");
  const overflow = n_total - preview_names.length;
  const sym_overflow = overflow > 0 ? " ..." : "";
  const sym_clause = `Symbols: ${sym_list_str}${sym_overflow}. `;

  return new ReadHint(
    _apply_terse(
      `\`${fname}\`: ${n_lines} lines (~${full_tokens} tokens). ` +
        `${sym_clause}` +
        `Use \`token-goat read "${rel}::${first_sym_name}"\` (~85% faster).`,
    ),
    0,
  );
}

/** True when line_ranges is exactly [(0, 0)] (full-file collapse marker). */
function _isFullFileSentinel(line_ranges: Array<[number, number]>): boolean {
  return line_ranges.length === 1 && line_ranges[0]![0] === 0 && line_ranges[0]![1] === 0;
}

/** time.time() analogue — seconds since the epoch as a float. */
function _now(): number {
  return Date.now() / 1000;
}

// ---------------------------------------------------------------------------
// Co-read suggestion hint (predictive import suggestions)
// ---------------------------------------------------------------------------

// TS/JS source extensions tried when resolving a bare relative import path.
const _TS_EXTENSIONS: readonly string[] = [".ts", ".tsx", ".js", ".jsx"];
const _TS_JS_SUFFIXES: readonly string[] = [".ts", ".tsx", ".js", ".jsx"];
const _GO_SUFFIX = ".go";
const _PY_SUFFIX = ".py";

/**
 * Return the Go module path declared in go.mod, or null if absent/unreadable.
 * (Python _get_go_module_prefix.)
 */
function _get_go_module_prefix(project_hash: string): string | null {
  try {
    const row = db.openGlobalReadonly((conn: DatabaseType): { root?: string } | undefined => {
      return conn.prepare("SELECT root FROM projects WHERE hash = ?").get(project_hash) as
        | { root?: string }
        | undefined;
    });
    if (!row || !row.root) {
      return null;
    }
    const go_mod = path.join(row.root, "go.mod");
    if (!_isFile(go_mod)) {
      return null;
    }
    const text = _readTextReplace(go_mod);
    const m = /^\s*module\s+(\S+)/m.exec(text);
    return m ? m[1]! : null;
  } catch {
    return null;
  }
}

/**
 * Resolve a relative TS/JS import target to candidate rel_path strings. Only
 * called for targets that start with './' or '../'. (Python _resolve_ts_candidates.)
 */
function _resolve_ts_candidates(target: string, importing_rel: string): string[] {
  const importing_dir = _posixDirname(importing_rel);
  // Strip leading ./ or ../ by joining then normalising.
  const resolved_base = importing_dir === "." ? target : `${importing_dir}/${target}`;
  const parts: string[] = [];
  for (const part of resolved_base.split("/")) {
    if (part === "..") {
      if (parts.length > 0) {
        parts.pop();
      }
    } else if (part !== "" && part !== ".") {
      parts.push(part);
    }
  }
  const base = parts.join("/");

  const candidates: string[] = [];
  for (const ext of _TS_EXTENSIONS) {
    candidates.push(`${base}${ext}`);
  }
  // index file variants
  for (const ext of _TS_EXTENSIONS) {
    candidates.push(`${base}/index${ext}`);
  }
  return candidates;
}

/** Python-specific co-read: resolve dot-separated module names to .py files. */
function _get_unread_coread_files_py(
  file_path: string,
  _project_hash: string,
  cache: SessionCache | null,
  conn: DatabaseType,
): Array<[string, string]> {
  const name = path.basename(file_path);
  const stem = name.slice(0, -3);
  const imports = (
    conn
      .prepare(
        "SELECT DISTINCT target FROM imports_exports WHERE kind = 'import' AND file_rel LIKE ? LIMIT 10",
      )
      .all(`%${stem}%`) as Array<{ target: string }>
  ).map((row) => row.target);
  const unread: Array<[string, string]> = [];
  for (const target of imports) {
    const parts = target.split(".");
    const module_name = parts[parts.length - 1]!;
    const candidates = [`${module_name}.py`];
    for (let i = parts.length - 1; i > 0; i--) {
      candidates.push(`${parts.slice(0, i).join("/")}/${parts[i]}.py`);
    }
    for (const candidate of candidates) {
      const row = conn
        .prepare("SELECT rel_path FROM files WHERE rel_path LIKE ? AND rel_path LIKE '%.py' LIMIT 1")
        .get(`%${candidate}`) as { rel_path: string } | undefined;
      if (row) {
        const matched_rel = row.rel_path;
        if (!cache || !(matched_rel in cache.files)) {
          unread.push([matched_rel, module_name]);
        }
        break;
      }
    }
    if (unread.length >= 3) {
      break;
    }
  }
  return unread;
}

/** TS/JS-specific co-read: resolve relative imports to local source files. */
function _get_unread_coread_files_ts(
  file_path: string,
  _project_hash: string,
  cache: SessionCache | null,
  conn: DatabaseType,
): Array<[string, string]> {
  let rel_path_row: { rel_path: string } | undefined;
  try {
    rel_path_row = conn
      .prepare("SELECT rel_path FROM files WHERE rel_path LIKE ? LIMIT 1")
      .get(`%${path.basename(file_path)}`) as { rel_path: string } | undefined;
  } catch {
    return [];
  }
  const importing_rel = rel_path_row ? rel_path_row.rel_path : path.basename(file_path);

  const all_targets = (
    conn
      .prepare(
        "SELECT DISTINCT target FROM imports_exports WHERE kind = 'import' AND file_rel = ? LIMIT 20",
      )
      .all(importing_rel) as Array<{ target: string }>
  ).map((row) => row.target);

  // Only local relative imports.
  const local_targets = all_targets.filter((t) => t.startsWith("./") || t.startsWith("../"));
  if (local_targets.length === 0) {
    return [];
  }

  const unread: Array<[string, string]> = [];
  for (const target of local_targets) {
    const candidates = _resolve_ts_candidates(target, importing_rel);
    for (const candidate of candidates) {
      const row = conn
        .prepare("SELECT rel_path FROM files WHERE rel_path = ? LIMIT 1")
        .get(candidate) as { rel_path: string } | undefined;
      if (row) {
        const matched_rel = row.rel_path;
        const display_name = path.basename(matched_rel);
        if (!cache || !(matched_rel in cache.files)) {
          unread.push([matched_rel, display_name]);
        }
        break;
      }
    }
    if (unread.length >= 3) {
      break;
    }
  }
  return unread;
}

/** Go-specific co-read: resolve intra-module imports to local .go files. */
function _get_unread_coread_files_go(
  file_path: string,
  project_hash: string,
  cache: SessionCache | null,
  conn: DatabaseType,
): Array<[string, string]> {
  const module_prefix = _get_go_module_prefix(project_hash);
  if (!module_prefix) {
    return [];
  }

  const importing_rel = conn
    .prepare("SELECT rel_path FROM files WHERE rel_path LIKE ? LIMIT 1")
    .get(`%${path.basename(file_path)}`) as { rel_path: string } | undefined;
  if (!importing_rel) {
    return [];
  }
  const file_rel = importing_rel.rel_path;

  const all_targets = (
    conn
      .prepare(
        "SELECT DISTINCT target FROM imports_exports WHERE kind = 'import' AND file_rel = ? LIMIT 20",
      )
      .all(file_rel) as Array<{ target: string }>
  ).map((row) => row.target);

  // Only imports that belong to this module.
  const local_targets = all_targets.filter((t) => t.startsWith(module_prefix + "/"));
  if (local_targets.length === 0) {
    return [];
  }

  const unread: Array<[string, string]> = [];
  for (const target of local_targets) {
    // Strip the module prefix to get the directory path within the project.
    const pkg_dir = target.slice(module_prefix.length + 1); // e.g. "internal/cache"
    const row = conn
      .prepare("SELECT rel_path FROM files WHERE rel_path LIKE ? AND rel_path LIKE '%.go' LIMIT 1")
      .get(`${pkg_dir}/%`) as { rel_path: string } | undefined;
    if (row) {
      const matched_rel = row.rel_path;
      const parts = pkg_dir.split("/");
      const display_name = parts[parts.length - 1]!; // just the package name
      if (!cache || !(matched_rel in cache.files)) {
        unread.push([matched_rel, display_name]);
      }
    }
    if (unread.length >= 3) {
      break;
    }
  }
  return unread;
}

/**
 * Get unread local-import files that are imported by the given file. Supports
 * Python, TS/JS, and Go. Returns up to 3 (rel_path, display_name) tuples, or
 * null if indexing is unavailable or no unread local imports exist. (Python
 * _get_unread_coread_files.)
 */
function _get_unread_coread_files(
  file_path: string,
  project_hash: string,
  cache: SessionCache | null = null,
): Array<[string, string]> | null {
  const lower = file_path.toLowerCase();
  const is_py = lower.endsWith(_PY_SUFFIX);
  const is_ts_js = _TS_JS_SUFFIXES.some((s) => lower.endsWith(s));
  const is_go = lower.endsWith(_GO_SUFFIX);
  if (!(is_py || is_ts_js || is_go)) {
    return null;
  }

  try {
    const result = db.openProjectReadonly(project_hash, (conn: DatabaseType): Array<[string, string]> => {
      if (is_py) {
        return _get_unread_coread_files_py(file_path, project_hash, cache, conn);
      } else if (is_ts_js) {
        return _get_unread_coread_files_ts(file_path, project_hash, cache, conn);
      }
      return _get_unread_coread_files_go(file_path, project_hash, cache, conn);
    });
    return result.length > 0 ? result : null;
  } catch (exc) {
    _LOG.debug(
      "_get_unread_coread_files: db query failed for %s (project=%s): %s",
      file_path.slice(0, 64),
      project_hash.slice(0, 8),
      exc,
    );
    return null;
  }
}

/**
 * Build a co-read suggestion hint when unread local imports exist. Returns null
 * for unsupported extensions, no unread imports, or unavailable indexing.
 * (Python _build_coread_suggestion_hint.)
 */
function _build_coread_suggestion_hint(
  file_path: string,
  project_hash: string,
  cache: SessionCache | null = null,
): ReadHint | null {
  const coread_files = _get_unread_coread_files(file_path, project_hash, cache);
  if (!coread_files) {
    return null;
  }

  const fname = _sanitize_hint_path(path.basename(file_path));

  // Build suggestion text using actual filenames from DB rel_paths.
  const display_names = coread_files
    .slice(0, 3)
    .map(([rel]) => _sanitize_hint_path(path.basename(rel)));
  let suggestion: string;
  if (display_names.length === 1) {
    suggestion = `\`${display_names[0]}\` (unread)`;
  } else {
    suggestion = display_names.map((n) => `\`${n}\``).join(", ") + " (unread)";
  }

  const db_rel = coread_files[0]![0];
  const first_rel = _sanitize_hint_path(db_rel.replace(/\\/g, "/"));

  // Replace the legacy ::ClassName placeholder with a real top-of-file symbol.
  const [symbols] = _get_indexed_symbols_and_line_count(db_rel, project_hash);
  let read_cmd: string;
  if (symbols.length > 0) {
    const sym = _sanitize_hint_symbol(symbols[0]!.name);
    read_cmd = `\`token-goat read "${first_rel}::${sym}"\``;
  } else {
    read_cmd = `\`token-goat outline "${first_rel}"\``;
  }

  return new ReadHint(
    _apply_terse(`Note: \`${fname}\` imports ${suggestion}. Use ${read_cmd} to read selectively.`),
    0,
  );
}

// ---------------------------------------------------------------------------
// High-frequency file access hint
// ---------------------------------------------------------------------------

// Minimum number of times a file must be accessed before the hint fires.
const _HIGH_FREQ_THRESHOLD = 3;

/**
 * Return a HintItem nudging toward surgical reads when a file is accessed often.
 * Fires at MEDIUM priority when *file_path* has been accessed at least *threshold*
 * times. (Python build_high_frequency_hint.)
 */
export function build_high_frequency_hint(
  session_cache: SessionCache,
  file_path: string,
  opts: { threshold?: number } = {},
): HintItem | null {
  const threshold = opts.threshold ?? _HIGH_FREQ_THRESHOLD;
  try {
    if (!file_path) {
      return null;
    }
    const count = session_cache.get_file_access_count(file_path);
    if (count < threshold) {
      return null;
    }
    const fname = _sanitize_hint_path(path.basename(file_path));
    const safe_path = _sanitize_hint_path(file_path);
    const text = _apply_terse(
      `\`${fname}\` read ${count}x this session — consider ` +
        `\`token-goat outline ${safe_path}\` or ` +
        `\`token-goat read "${safe_path}::<symbol>"\` for a narrower read.`,
    );
    return new HintItem(text, HINT_PRIORITY_MEDIUM);
  } catch {
    return null; // fail-soft; hint errors must never block the agent
  }
}

// ---------------------------------------------------------------------------
// Diff-aware re-read hint
// ---------------------------------------------------------------------------

// Largest diff (in bytes of unified-diff output) eligible for inclusion.
export const DIFF_HINT_MAX_BYTES = 4096;

// Minimum *raw* tokens saved before the diff hint is emitted.
const _DIFF_HINT_MIN_TOKENS_SAVED = 250;

// Number of context lines kept around each changed hunk in the unified diff.
const _DIFF_CONTEXT_LINES = 2;

// For tiny edits, one context line on each side is plenty.
const _DIFF_TINY_CHANGE_THRESHOLD = 3;
const _DIFF_TINY_CONTEXT_LINES = 1;

/**
 * Return a diff-based hint when a snapshot is available and the diff fits.
 * Never raises (fail-soft). (Python build_diff_hint, @_failsoft_hint.)
 */
export const build_diff_hint = _failsoft_hint(
  (args: { session_id: string; file_path: string; current_text: string }): ReadHint | null => {
    return _build_diff_hint_inner(args);
  },
  "build_diff_hint",
);

/** Inner implementation of build_diff_hint; may raise. (Python _build_diff_hint_inner.) */
function _build_diff_hint_inner(args: {
  session_id: string;
  file_path: string;
  current_text: string;
}): ReadHint | null {
  const { session_id, current_text } = args;
  const file_path = args.file_path;

  let _min_tokens_saved: number;
  try {
    _min_tokens_saved = config.load().hints?.diff_hint_min_tokens_saved ?? _DIFF_HINT_MIN_TOKENS_SAVED;
  } catch {
    _min_tokens_saved = _DIFF_HINT_MIN_TOKENS_SAVED;
  }

  // Integrity-gated load: pass the recorded sha when available so a corrupted
  // snapshot is detected and discarded; fall back to unverified load otherwise.
  let expected_sha: string | null;
  try {
    expected_sha = session.get_snapshot_sha(session_id, file_path);
  } catch {
    expected_sha = null;
  }
  const snapshot_bytes = snapshots.load(session_id, file_path, { expected_sha });
  if (snapshot_bytes === null) {
    return null;
  }

  // Decode defensively (errors="replace").
  const snapshot_text = snapshot_bytes.toString("utf8");
  if (snapshot_text === current_text) {
    return null;
  }

  const fname = _sanitize_hint_path(path.basename(file_path));

  const snapshot_lines = _splitlinesKeepends(snapshot_text);
  const current_lines = _splitlinesKeepends(current_text);

  // Adaptive context sizing: count actual +/- changes with a zero-context probe.
  const probe_lines = _unifiedDiff(snapshot_lines, current_lines, { n: 0, lineterm: "" });
  let added_count = 0;
  let removed_count = 0;
  for (const line of probe_lines) {
    if (line.slice(0, 1) === "+" && !line.startsWith("+++")) {
      added_count++;
    }
    if (line.slice(0, 1) === "-" && !line.startsWith("---")) {
      removed_count++;
    }
  }
  const changed_count = added_count + removed_count;
  const hunk_lines = probe_lines.filter((line) => line.startsWith("@@"));
  const hunk_count = hunk_lines.length;

  // Micro-diff collapse: a single hunk with fewer than 3 changed lines.
  const _MICRO_DIFF_MAX_CHANGED = 3;
  if (hunk_count === 1 && changed_count > 0 && changed_count < _MICRO_DIFF_MAX_CHANGED) {
    // Parse the first (only) hunk header to extract the destination line number.
    const hunk_match = /@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(hunk_lines[0]!);
    const line_num = hunk_match ? Math.trunc(Number(hunk_match[1])) : 0;

    let summary_change: string;
    if (added_count > 0 && removed_count > 0) {
      summary_change = `±${changed_count} lines`;
    } else if (added_count > 0) {
      const n_word = added_count === 1 ? "line" : "lines";
      summary_change = `+${added_count} ${n_word}`;
    } else {
      const n_word = removed_count === 1 ? "line" : "lines";
      summary_change = `-${removed_count} ${n_word}`;
    }

    const line_str = line_num ? ` @ L${line_num}` : "";
    const full_tokens_micro = _est_tokens_from_chars(current_text.length);
    // A one-liner hint costs ~8 tokens; saving is full-read minus that.
    const tokens_saved_micro = Math.max(0, full_tokens_micro - 8);
    if (tokens_saved_micro < _min_tokens_saved) {
      return null;
    }
    const prose_micro = new ReadHint(
      _apply_terse(`\`${fname}\` changed: ${summary_change}${line_str}`),
      tokens_saved_micro,
    );
    return _emit_json_sidecar(prose_micro, "diff_since_last_read", {
      file: _sanitize_hint_path(file_path),
      added: added_count,
      removed: removed_count,
      line: line_num || null,
      wasted: tokens_saved_micro,
    });
  }

  const n_context =
    changed_count > 0 && changed_count <= _DIFF_TINY_CHANGE_THRESHOLD
      ? _DIFF_TINY_CONTEXT_LINES
      : _DIFF_CONTEXT_LINES;

  // snapshot_lines/current_lines carry their own trailing "\n"; the control rows
  // must use the default lineterm="\n" to pair with the "".join below.
  const diff_iter = _unifiedDiff(snapshot_lines, current_lines, {
    fromfile: `${fname} (previously read)`,
    tofile: `${fname} (current)`,
    n: n_context,
  });
  const diff_text = diff_iter.join("");
  if (!diff_text) {
    return null;
  }

  const diff_bytes = utf8Bytes(diff_text).length;
  if (diff_bytes > DIFF_HINT_MAX_BYTES) {
    _LOG.debug(
      "build_diff_hint: diff too large (%d bytes > %d cap) for %s — suppressing",
      diff_bytes,
      DIFF_HINT_MAX_BYTES,
      fname,
    );
    return null;
  }

  // Compute the saving: full-file re-read tokens minus diff tokens.
  const full_tokens = _est_tokens_from_chars(current_text.length);
  const diff_tokens = _est_tokens_from_chars(diff_bytes);
  const tokens_saved = Math.max(0, full_tokens - diff_tokens);
  if (tokens_saved < _min_tokens_saved) {
    _LOG.debug(
      "build_diff_hint: saving too small (%d < %d) for %s — suppressing",
      tokens_saved,
      _min_tokens_saved,
      fname,
    );
    return null;
  }

  const prose_diff = new ReadHint(
    _apply_terse(`\`${fname}\` changed:\n`) + "```diff\n" + diff_text + "\n```\n",
    tokens_saved,
  );
  return _emit_json_sidecar(prose_diff, "diff_since_last_read", {
    file: _sanitize_hint_path(file_path),
    added: added_count,
    removed: removed_count,
    wasted: tokens_saved,
  });
}

// ---------------------------------------------------------------------------
// difflib port (str.splitlines(keepends=True) + difflib.unified_diff)
// ---------------------------------------------------------------------------
// Faithful enough port of CPython's difflib.SequenceMatcher.get_opcodes /
// get_grouped_opcodes and difflib.unified_diff to produce byte-identical hunk
// output for the line lists the diff hint feeds it. The autojunk heuristic is
// reproduced (popular elements ignored when b has > 200 elements) so the opcodes
// match CPython's for large inputs too.

/**
 * Python str.splitlines(keepends=True): split on universal newlines and keep the
 * line terminators. Recognises \n, \r\n, \r, plus the Unicode line boundaries
 * \v \f \x1c \x1d \x1e \x85 \u2028 \u2029 that Python's splitlines treats as
 * breaks. The terminator stays attached to the preceding line.
 *
 * Exported so cli_sessions.ts (the `compact-hint` command + its `--watch` loop)
 * can feed `_unifiedDiff` the same keepends line lists, exactly as cli.py's
 * `compact_hint` calls `difflib.unified_diff(text.splitlines(keepends=True), ...)`.
 */
export function _splitlinesKeepends(text: string): string[] {
  const out: string[] = [];
  let i = 0;
  const n = text.length;
  let start = 0;
  while (i < n) {
    const ch = text[i]!;
    const code = text.charCodeAt(i);
    // Boundary chars Python str.splitlines recognises.
    const isBreak =
      ch === "\n" ||
      ch === "\r" ||
      ch === "\v" ||
      ch === "\f" ||
      code === 0x1c ||
      code === 0x1d ||
      code === 0x1e ||
      code === 0x85 ||
      code === 0x2028 ||
      code === 0x2029;
    if (isBreak) {
      // \r\n is a single boundary.
      let end = i + 1;
      if (ch === "\r" && i + 1 < n && text[i + 1] === "\n") {
        end = i + 2;
      }
      out.push(text.slice(start, end));
      i = end;
      start = end;
    } else {
      i++;
    }
  }
  if (start < n) {
    out.push(text.slice(start));
  }
  return out;
}

type _Opcode = [string, number, number, number, number];

/** Port of difflib.SequenceMatcher restricted to the operations we need. */
class _SequenceMatcher {
  private a: string[];
  private b: string[];
  private b2j: Map<string, number[]> = new Map();
  private bjunk: Set<string> = new Set();
  private bpopular: Set<string> = new Set();
  private opcodes: _Opcode[] | null = null;

  constructor(a: string[], b: string[]) {
    this.a = a;
    this.b = b;
    this._chainB();
  }

  private _chainB(): void {
    const b = this.b;
    const b2j = this.b2j;
    b2j.clear();
    for (let i = 0; i < b.length; i++) {
      const elt = b[i]!;
      const indices = b2j.get(elt);
      if (indices !== undefined) {
        indices.push(i);
      } else {
        b2j.set(elt, [i]);
      }
    }
    // Purge junk elements. isjunk is null in our usage; skip the junk pass.
    // Purge popular elements that are not junk (autojunk heuristic).
    const n = b.length;
    this.bpopular.clear();
    if (n >= 200) {
      const ntest = Math.floor(n / 100) + 1;
      for (const [elt, idxs] of b2j) {
        if (idxs.length > ntest) {
          this.bpopular.add(elt);
        }
      }
      for (const elt of this.bpopular) {
        b2j.delete(elt);
      }
    }
  }

  private _findLongestMatch(alo: number, ahi: number, blo: number, bhi: number): [number, number, number] {
    const a = this.a;
    const b2j = this.b2j;
    const isbjunk = (x: string): boolean => this.bjunk.has(x);
    let besti = alo;
    let bestj = blo;
    let bestsize = 0;
    let j2len: Map<number, number> = new Map();
    for (let i = alo; i < ahi; i++) {
      const newj2len: Map<number, number> = new Map();
      const indices = b2j.get(a[i]!);
      if (indices !== undefined) {
        for (const j of indices) {
          if (j < blo) {
            continue;
          }
          if (j >= bhi) {
            break;
          }
          const k = (j2len.get(j - 1) ?? 0) + 1;
          newj2len.set(j, k);
          if (k > bestsize) {
            besti = i - k + 1;
            bestj = j - k + 1;
            bestsize = k;
          }
        }
      }
      j2len = newj2len;
    }
    // Extend the best by non-junk elements on each end.
    while (
      besti > alo &&
      bestj > blo &&
      !isbjunk(this.b[bestj - 1]!) &&
      a[besti - 1] === this.b[bestj - 1]
    ) {
      besti--;
      bestj--;
      bestsize++;
    }
    while (
      besti + bestsize < ahi &&
      bestj + bestsize < bhi &&
      !isbjunk(this.b[bestj + bestsize]!) &&
      a[besti + bestsize] === this.b[bestj + bestsize]
    ) {
      bestsize++;
    }
    // Now match junk-only on the boundaries (no junk in our usage; harmless).
    while (
      besti > alo &&
      bestj > blo &&
      isbjunk(this.b[bestj - 1]!) &&
      a[besti - 1] === this.b[bestj - 1]
    ) {
      besti--;
      bestj--;
      bestsize++;
    }
    while (
      besti + bestsize < ahi &&
      bestj + bestsize < bhi &&
      isbjunk(this.b[bestj + bestsize]!) &&
      a[besti + bestsize] === this.b[bestj + bestsize]
    ) {
      bestsize++;
    }
    return [besti, bestj, bestsize];
  }

  private _getMatchingBlocks(): Array<[number, number, number]> {
    const la = this.a.length;
    const lb = this.b.length;
    const queue: Array<[number, number, number, number]> = [[0, la, 0, lb]];
    const matchingBlocks: Array<[number, number, number]> = [];
    while (queue.length > 0) {
      const [alo, ahi, blo, bhi] = queue.pop()!;
      const [i, j, k] = this._findLongestMatch(alo, ahi, blo, bhi);
      if (k > 0) {
        matchingBlocks.push([i, j, k]);
        if (alo < i && blo < j) {
          queue.push([alo, i, blo, j]);
        }
        if (i + k < ahi && j + k < bhi) {
          queue.push([i + k, ahi, j + k, bhi]);
        }
      }
    }
    matchingBlocks.sort((x, y) => x[0] - y[0] || x[1] - y[1] || x[2] - y[2]);
    // Collapse adjacent equal blocks.
    let i1 = 0;
    let j1 = 0;
    let k1 = 0;
    const nonAdjacent: Array<[number, number, number]> = [];
    for (const [i2, j2, k2] of matchingBlocks) {
      if (i1 + k1 === i2 && j1 + k1 === j2) {
        k1 += k2;
      } else {
        if (k1 > 0) {
          nonAdjacent.push([i1, j1, k1]);
        }
        i1 = i2;
        j1 = j2;
        k1 = k2;
      }
    }
    if (k1 > 0) {
      nonAdjacent.push([i1, j1, k1]);
    }
    nonAdjacent.push([la, lb, 0]);
    return nonAdjacent;
  }

  getOpcodes(): _Opcode[] {
    if (this.opcodes !== null) {
      return this.opcodes;
    }
    let i = 0;
    let j = 0;
    const answer: _Opcode[] = [];
    for (const [ai, bj, size] of this._getMatchingBlocks()) {
      let tag = "";
      if (i < ai && j < bj) {
        tag = "replace";
      } else if (i < ai) {
        tag = "delete";
      } else if (j < bj) {
        tag = "insert";
      }
      if (tag) {
        answer.push([tag, i, ai, j, bj]);
      }
      i = ai + size;
      j = bj + size;
      if (size > 0) {
        answer.push(["equal", ai, i, bj, j]);
      }
    }
    this.opcodes = answer;
    return answer;
  }

  getGroupedOpcodes(n = 3): _Opcode[][] {
    let codes = this.getOpcodes();
    if (codes.length === 0) {
      codes = [["equal", 0, 1, 0, 1]];
    }
    // Fixup leading and trailing groups if they show no changes.
    if (codes[0]![0] === "equal") {
      const [tag, i1, i2, j1, j2] = codes[0]!;
      codes[0] = [tag, Math.max(i1, i2 - n), i2, Math.max(j1, j2 - n), j2];
    }
    if (codes[codes.length - 1]![0] === "equal") {
      const [tag, i1, i2, j1, j2] = codes[codes.length - 1]!;
      codes[codes.length - 1] = [tag, i1, Math.min(i2, i1 + n), j1, Math.min(j2, j1 + n)];
    }
    const nn = n + n;
    const groups: _Opcode[][] = [];
    let group: _Opcode[] = [];
    for (const [tag, i1in, i2, j1in, j2] of codes) {
      let i1 = i1in;
      let j1 = j1in;
      // End the current group and start a new one when an equal range is large.
      if (tag === "equal" && i2 - i1 > nn) {
        group.push([tag, i1, Math.min(i2, i1 + n), j1, Math.min(j2, j1 + n)]);
        groups.push(group);
        group = [];
        i1 = Math.max(i1, i2 - n);
        j1 = Math.max(j1, j2 - n);
      }
      group.push([tag, i1, i2, j1, j2]);
    }
    if (group.length > 0 && !(group.length === 1 && group[0]![0] === "equal")) {
      groups.push(group);
    }
    return groups;
  }
}

/**
 * Port of difflib.unified_diff. Yields unified-diff lines (each carrying its own
 * lineterm where applicable). The data lines come straight from a/b (so they
 * keep whatever terminator splitlines(keepends=True) left on them).
 *
 * Exported so cli_sessions.ts's `compact-hint --diff` / `--watch` reuse the
 * single verified `difflib.unified_diff` port (rather than a second, possibly
 * divergent copy). No cycle: hints imports only lib-layer modules.
 */
export function _unifiedDiff(
  a: string[],
  b: string[],
  opts: { fromfile?: string; tofile?: string; n?: number; lineterm?: string } = {},
): string[] {
  const fromfile = opts.fromfile ?? "";
  const tofile = opts.tofile ?? "";
  const n = opts.n ?? 3;
  const lineterm = opts.lineterm ?? "\n";
  const out: string[] = [];
  let started = false;
  const sm = new _SequenceMatcher(a, b);
  for (const group of sm.getGroupedOpcodes(n)) {
    if (!started) {
      started = true;
      const fromdate = "";
      const todate = "";
      out.push(`--- ${fromfile}${fromdate}${lineterm}`);
      out.push(`+++ ${tofile}${todate}${lineterm}`);
    }
    const first = group[0]!;
    const last = group[group.length - 1]!;
    const file1Range = _formatRangeUnified(first[1], last[2]);
    const file2Range = _formatRangeUnified(first[3], last[4]);
    out.push(`@@ -${file1Range} +${file2Range} @@${lineterm}`);
    for (const [tag, i1, i2, j1, j2] of group) {
      if (tag === "equal") {
        for (let i = i1; i < i2; i++) {
          out.push(" " + a[i]!);
        }
        continue;
      }
      if (tag === "replace" || tag === "delete") {
        for (let i = i1; i < i2; i++) {
          out.push("-" + a[i]!);
        }
      }
      if (tag === "replace" || tag === "insert") {
        for (let j = j1; j < j2; j++) {
          out.push("+" + b[j]!);
        }
      }
    }
  }
  return out;
}

/** Port of difflib._format_range_unified. */
function _formatRangeUnified(start: number, stop: number): string {
  const beginning = start + 1; // lines start numbering with one
  const length = stop - start;
  if (length === 1) {
    return `${beginning}`;
  }
  const b = length === 0 ? beginning - 1 : beginning; // empty ranges begin at line just before the range
  return `${b},${length}`;
}

// ---------------------------------------------------------------------------
// Symbol-level stale-edit hint
// ---------------------------------------------------------------------------

/**
 * Return a warning string when *symbol_name* changed since the agent last read
 * it, else null. The return value is a plain string (not ReadHint) because the
 * caller emits it to stdout before the symbol body. (Python build_symbol_stale_hint.)
 */
export function build_symbol_stale_hint(args: {
  session_id: string;
  file_path: string;
  symbol_name: string;
  current_start_line: number;
  current_end_line: number;
  current_text: string;
}): string | null {
  const { session_id, file_path, symbol_name } = args;
  if (!session_id || !file_path || !symbol_name) {
    return null;
  }
  try {
    const changed = snapshots.symbol_changed_since_read(
      session_id,
      file_path,
      symbol_name,
      args.current_start_line,
      args.current_end_line,
      args.current_text,
    );
    if (!changed) {
      return null;
    }
    const safe_file = _sanitize_hint_path(file_path);
    const safe_sym = _sanitize_hint_path(symbol_name);
    return (
      `⚠ ${safe_file}::${safe_sym} was modified since your last read. ` +
      "The function body may have changed."
    );
  } catch {
    _LOG.debug(
      "build_symbol_stale_hint: unexpected error for %s::%s",
      JSON.stringify(file_path),
      JSON.stringify(symbol_name),
    );
    return null;
  }
}

// ---------------------------------------------------------------------------
// Session-cache helpers
// ---------------------------------------------------------------------------

/**
 * Load the session cache if not already loaded; return null when unavailable.
 * (Python _require_cache.)
 */
function _require_cache(session_id: string, cache: SessionCache | null): SessionCache | null {
  let c = cache;
  if (c === null) {
    c = load_session_safe(session_id);
  }
  if (c === null || c.unavailable) {
    return null;
  }
  return c;
}

/**
 * Return the configured bash dedup minimum bytes threshold. Defaults to
 * _BASH_DEDUP_MIN_BYTES on any error. (Python _get_bash_dedup_min_bytes.)
 */
function _get_bash_dedup_min_bytes(): number {
  try {
    return config.load().hints?.bash_dedup_min_bytes ?? _BASH_DEDUP_MIN_BYTES;
  } catch {
    return _BASH_DEDUP_MIN_BYTES;
  }
}

/**
 * Return the configured grep dedup minimum match count threshold. Defaults to
 * _GREP_DEDUP_MIN_RESULT_COUNT on any error. (Python _get_grep_dedup_min_matches.)
 */
function _get_grep_dedup_min_matches(): number {
  try {
    return config.load().hints?.grep_dedup_min_matches ?? _GREP_DEDUP_MIN_RESULT_COUNT;
  } catch {
    return _GREP_DEDUP_MIN_RESULT_COUNT;
  }
}

/**
 * Return False when the session's hint-acceptance rate is too low. Returns True
 * (emit the hint) in all other cases. Never raises. (Python _curator_should_emit.)
 */
export function _curator_should_emit(cache: SessionCache): boolean {
  try {
    const cfg = config.load().curator;
    if (!cfg || !cfg.enabled) {
      return true;
    }

    const emitted = cache.hints_emitted;
    const min_samples = cfg.min_samples ?? 10;
    if (emitted < min_samples) {
      return true; // Not enough data yet — keep emitting
    }

    const ignored = cache.hints_ignored;
    const acceptance_pct = ((emitted - ignored) / emitted) * 100;
    const threshold_pct = cfg.threshold_pct ?? 20;
    if (acceptance_pct < threshold_pct) {
      _LOG.debug(
        "_curator_should_emit: suppressing dedup hints (acceptance=%s%% < %d%%, emitted=%d, ignored=%d)",
        acceptance_pct.toFixed(1),
        threshold_pct,
        emitted,
        ignored,
      );
      return false;
    }
    return true;
  } catch {
    return true; // fail-soft
  }
}

/**
 * Increment hints_emitted and add *norm_path* to the recent_hints ring buffer.
 * (Python _record_hint_emitted.)
 */
export function _record_hint_emitted(cache: SessionCache, norm_path: string): void {
  cache.hints_emitted += 1;
  cache.recent_hints.push([norm_path, _now()]);
  if (cache.recent_hints.length > _RECENT_HINTS_MAX) {
    cache.recent_hints = cache.recent_hints.slice(-_RECENT_HINTS_MAX);
  }
  cache._invalidate_json_cache();
}

/**
 * Consolidate the triple recording call for dedup hints. (Python
 * _record_dedup_hint_emitted.)
 */
function _record_dedup_hint_emitted(
  cache: SessionCache,
  hint_key: string,
  hint_type: string,
  fp_key: string,
): void {
  _record_hint_emitted(cache, hint_key);
  cache.record_hint_emitted(hint_type);
  cache.mark_hint_seen(fp_key);
}

/**
 * Record that a bash dedup was emitted to avoid re-emitting the same output.
 * (Python _record_bash_dedup_emitted.)
 */
function _record_bash_dedup_emitted(cache: SessionCache, dedup_key: string): void {
  cache.bash_dedup_emitted_ids.add(dedup_key);
  if (cache.bash_dedup_emitted_ids.size > session.BASH_DEDUP_IDS_MAX) {
    const _sorted = [...cache.bash_dedup_emitted_ids].sort();
    cache.bash_dedup_emitted_ids = new Set(_sorted.slice(session.BASH_HISTORY_MAX));
  }
  cache._invalidate_json_cache();
}

// ---------------------------------------------------------------------------
// Hint budget check — hard cap on total hints per session
// ---------------------------------------------------------------------------

export const _HINT_KIND_DEDUP = "dedup";
export const _HINT_KIND_STRUCTURED = "structured";
export const _HINT_KIND_INDEX_ONLY = "index_only";

/**
 * Return False (suppress) when the session has exhausted the budget for
 * *hint_kind*. Returns True when the feature is disabled, the kind is unknown,
 * or the counter is below the cap. Never raises. (Python _hint_budget_check.)
 */
export function _hint_budget_check(cache: SessionCache, hint_kind: string): boolean {
  try {
    const cfg = config.load().hint_budget;
    if (!cfg || !cfg.enabled) {
      return true;
    }

    let over: boolean;
    if (hint_kind === _HINT_KIND_DEDUP) {
      over = cache.hints_emitted >= (cfg.max_per_session ?? 100);
    } else if (hint_kind === _HINT_KIND_STRUCTURED) {
      over = cache.structured_hints_emitted >= (cfg.max_structured_per_session ?? 30);
    } else if (hint_kind === _HINT_KIND_INDEX_ONLY) {
      over = cache.index_only_hints_emitted >= (cfg.max_index_only_per_session ?? 30);
    } else {
      return true; // unknown kind — don't suppress
    }

    if (over) {
      _LOG.debug(
        "_hint_budget_check: suppressing %s hint (budget exhausted for kind=%s)",
        hint_kind,
        hint_kind,
      );
      return false;
    }
    return true;
  } catch {
    return true; // fail-soft
  }
}

/**
 * Record emission of a non-dedup hint by incrementing a counter and recording
 * the type. (Python _record_non_dedup_hint_emitted.)
 */
function _record_non_dedup_hint_emitted(
  cache: SessionCache,
  counter_attr: "structured_hints_emitted" | "index_only_hints_emitted",
  hint_type: string,
): void {
  cache[counter_attr] = cache[counter_attr] + 1;
  cache.record_hint_emitted(hint_type);
  cache._invalidate_json_cache();
}

/** Increment structured_hints_emitted counter on *cache*. (Python _record_structured_hint_emitted.) */
export function _record_structured_hint_emitted(cache: SessionCache): void {
  _record_non_dedup_hint_emitted(cache, "structured_hints_emitted", "structured_file");
}

/** Increment index_only_hints_emitted counter on *cache*. (Python _record_index_only_hint_emitted.) */
export function _record_index_only_hint_emitted(cache: SessionCache): void {
  _record_non_dedup_hint_emitted(cache, "index_only_hints_emitted", "index_only_file");
}

// ---------------------------------------------------------------------------
// Per-tool recall-command emission tracking
// ---------------------------------------------------------------------------

const _RECALL_HINT_SUPPRESS_AFTER = 2;

/**
 * Return True when the verbose recall command should be included for *tool*.
 * Increments the per-tool emission counter (sentinel fingerprints in
 * hints_seen) and returns False once the counter exceeds
 * _RECALL_HINT_SUPPRESS_AFTER. Returns True when *cache* is None. (Python
 * _should_emit_recall_command.)
 */
function _should_emit_recall_command(cache: SessionCache | null, tool: string): boolean {
  if (cache === null) {
    return true;
  }
  for (let n = 1; n <= _RECALL_HINT_SUPPRESS_AFTER; n++) {
    const key = `recall_count:${tool}:${n}`;
    if (!cache.has_hint_fingerprint(key)) {
      cache.mark_hint_seen(key);
      return true;
    }
  }
  return false;
}

// ---------------------------------------------------------------------------
// Shared fail-soft wrapper for all dedup hint builders
// ---------------------------------------------------------------------------

/**
 * Record a zero-savings stat row when a dedup hint is suppressed due to age.
 * Best-effort; any DB error is swallowed. (Python _record_dedup_stale.)
 */
function _record_dedup_stale(kind: string, detail: string): void {
  try {
    db.recordStat(undefined, kind, {
      bytesSaved: 0,
      tokensSaved: 0,
      detail: detail.slice(0, 64),
    });
  } catch {
    // telemetry must never break the hint pipeline
  }
}

/**
 * Invoke *fn* and return its result, suppressing any exception (logged at
 * WARNING). All three dedup builders share this fail-soft contract. (Python
 * _failsoft_dedup_hint.)
 */
function _failsoft_dedup_hint(
  fn: () => ReadHint | null,
  opts: { caller: string; session_id: string },
): ReadHint | null {
  try {
    return fn();
  } catch (exc) {
    _LOG.warning(
      "%s: unexpected error (session=%s): %s",
      opts.caller,
      (opts.session_id || "").slice(0, 16),
      exc,
    );
    return null;
  }
}

/**
 * Check common preconditions for all dedup builders. Return True if should
 * proceed. (Python _check_dedup_preconditions.)
 */
function _check_dedup_preconditions(opts: {
  session_id: string;
  required_param: string | null;
  cache: SessionCache | null;
}): boolean {
  const { session_id, required_param, cache } = opts;
  if (!session_id || !required_param) {
    return false;
  }

  if (cache !== null) {
    if (!_curator_should_emit(cache)) {
      return false;
    }
    if (!_hint_budget_check(cache, _HINT_KIND_DEDUP)) {
      return false;
    }
  }

  return true;
}

/**
 * Check if a cache entry is stale and record suppression. Return [is_stale, age].
 * (Python _check_entry_staleness.)
 */
function _check_entry_staleness(
  entry: { ts: number },
  cache: SessionCache | null,
  log_label: string,
  stale_reason_key: string,
  detail = "",
): [boolean, number] {
  const now = _now();
  const age = now - entry.ts;
  const stale_threshold = _session_stale_threshold(cache, now);
  if (age > stale_threshold) {
    _LOG.debug(
      "%s: entry stale (age=%ss > %ss); suppressing",
      log_label,
      age.toFixed(0),
      stale_threshold.toFixed(0),
    );
    _record_dedup_stale(stale_reason_key, detail);
    return [true, age];
  }
  return [false, age];
}

/**
 * Check if a value meets the dedup minimum threshold. Return True if it does NOT
 * (i.e., should suppress the hint). (Python _check_dedup_min_threshold.)
 */
function _check_dedup_min_threshold(
  value: number | null,
  min_fn: () => number,
  cache: SessionCache | null,
  suppression_key: string,
): boolean {
  if (value === null || value < min_fn()) {
    if (cache !== null) {
      cache.record_hint_suppressed(suppression_key);
    }
    return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Bash dedup hint
// ---------------------------------------------------------------------------

// Minimum output size before the bash dedup hint fires.
export const _BASH_DEDUP_MIN_BYTES = 200; // fallback default
// Below this threshold use a compact one-liner hint. (Exported: test imports it.)
export const _BASH_DEDUP_LIGHT_MAX_BYTES = 999;
// At this size suggest --grep filtering. (Exported: test imports it.)
export const _BASH_DEDUP_GREP_SUGGEST_BYTES = 5000;

// Maximum length for a command string in a hint before truncation.
// (Exported: test_bash_command_formatting imports it.)
export const _MAX_BASH_COMMAND_DISPLAY_LEN = 60;

/**
 * Return a hint when *command* was run earlier in this session. Never raises
 * (fail-soft). Returns null when bash_cache is unavailable (not yet ported).
 * (Python build_bash_dedup_hint, @_failsoft_hint.)
 */
export const build_bash_dedup_hint = _failsoft_hint(
  (args: {
    session_id: string;
    command: string;
    cache?: SessionCache | null;
    cwd?: string | null;
  }): ReadHint | null => {
    const { session_id, command } = args;
    const cache = args.cache ?? null;
    const cwd = args.cwd ?? null;

    if (
      !_check_dedup_preconditions({
        session_id,
        required_param: command,
        cache,
      })
    ) {
      return null;
    }

    const bash_cache = _getBashCache();
    if (bash_cache === null) {
      return null; // bash_cache not yet ported — fail soft.
    }

    const cmd_sha = bash_cache.command_hash(command, cwd);
    const entry = session.lookup_bash_entry(session_id, cmd_sha, { cache });
    if (entry === null) {
      return null;
    }

    const cmd_short = _format_bash_command_for_hint(command);
    const [is_stale, age] = _check_entry_staleness(
      entry,
      cache,
      "build_bash_dedup_hint",
      "bash_dedup_stale",
      cmd_short,
    );
    if (is_stale) {
      return null;
    }

    const total_bytes = entry.stdout_bytes + entry.stderr_bytes;
    if (
      _check_dedup_min_threshold(
        total_bytes,
        _get_bash_dedup_min_bytes,
        cache,
        "bash_dedup_below_threshold",
      )
    ) {
      return null;
    }

    // Content-aware dedup: only emit if we've seen this exact output before.
    const dedup_key = entry.output_sha || entry.output_id;
    if (dedup_key && (cache ? cache.bash_dedup_emitted_ids.has(dedup_key) : false)) {
      _LOG.debug(
        "build_bash_dedup_hint: dedup key %s already shown; suppressing",
        dedup_key ? dedup_key.slice(0, 8) : "?",
      );
      return null;
    }

    const tokens_avoided = _est_tokens_from_chars(total_bytes);
    const run_count = entry.run_count ?? 1;
    const short_id = cache_common.short_output_id(entry.output_id);

    // Two-phase dedup: check the fingerprint key BEFORE constructing hint text.
    const key_for_dedup = `${cmd_sha}|${run_count}`;
    const fp_key = _hint_fingerprint(key_for_dedup, "bash");
    if (cache !== null && cache.has_hint_fingerprint(fp_key)) {
      _LOG.debug(
        "build_bash_dedup_hint: fingerprint key %s already seen; skipping construction",
        fp_key,
      );
      return null;
    }

    // After the agent has seen the verbose recall pointer twice, emit just the ID.
    let recall_cmd: string;
    if (_should_emit_recall_command(cache, "bash")) {
      recall_cmd = `token-goat bash-output ${short_id}`;
    } else {
      recall_cmd = `id=${short_id}`;
    }

    // Front-load failure signal so the agent sees it immediately.
    const is_failed = entry.exit_code !== null && entry.exit_code !== 0;
    let fail_prefix: string;
    let exit_str: string;
    if (is_failed) {
      fail_prefix = `FAILED (exit=${entry.exit_code}): `;
      exit_str = "";
    } else {
      fail_prefix = "";
      exit_str = entry.exit_code === null ? "" : ` x=${entry.exit_code}`;
    }

    if (total_bytes <= _BASH_DEDUP_LIGHT_MAX_BYTES) {
      // For very small output, include outcome indicator for context.
      const outcome = total_bytes === 0 ? " (empty)" : ` ${total_bytes}B`;
      const hint_text = `${fail_prefix}\`${cmd_short}\` cached (${Math.trunc(age)}s${outcome}${exit_str}). \`${recall_cmd}\``;
      if (cache !== null && dedup_key) {
        _record_bash_dedup_emitted(cache, dedup_key);
      }
      if (cache !== null) {
        _record_dedup_hint_emitted(cache, cmd_sha, "bash_dedup", fp_key);
      }
      const result = new ReadHint(_apply_terse(hint_text), tokens_avoided);
      return _emit_json_sidecar(result, "bash_dedup", {
        command: cmd_short,
        bytes_size: total_bytes,
        age_s: Math.trunc(age),
        wasted: tokens_avoided,
      });
    }

    const grep_suffix =
      total_bytes >= _BASH_DEDUP_GREP_SUGGEST_BYTES ? " (add --grep PATTERN to filter)" : "";

    let hint_text: string;
    if (run_count >= 3) {
      hint_text =
        `${fail_prefix}⚠ \`${cmd_short}\` ran ${run_count}x — loop? ` +
        `Cached: (${_comma(total_bytes)}B${exit_str}): \`${recall_cmd}\`${grep_suffix}`;
    } else if (run_count === 2) {
      hint_text =
        `${fail_prefix}\`${cmd_short}\` ran 2x — cached (${_comma(total_bytes)}B${exit_str}, ~${tokens_avoided}t). ` +
        `\`${recall_cmd}\`${grep_suffix}`;
    } else {
      hint_text =
        `${fail_prefix}\`${cmd_short}\` (${Math.trunc(age)}s): ${_comma(total_bytes)}B${exit_str} cached. ` +
        `\`${recall_cmd}\`${grep_suffix}`;
    }
    if (cache !== null && dedup_key) {
      _record_bash_dedup_emitted(cache, dedup_key);
    }
    if (cache !== null) {
      _record_dedup_hint_emitted(cache, cmd_sha, "bash_dedup", fp_key);
    }
    const result = new ReadHint(_apply_terse(hint_text), tokens_avoided);
    return _emit_json_sidecar(result, "bash_dedup", {
      command: cmd_short,
      bytes_size: total_bytes,
      age_s: Math.trunc(age),
      wasted: tokens_avoided,
    });
  },
  "build_bash_dedup_hint",
);

/**
 * Format a bash command for display in a dedup hint with intelligent truncation.
 * (Python _format_bash_command_for_hint.)
 * (Exported: test_bash_command_formatting imports it.)
 */
export function _format_bash_command_for_hint(command: string): string {
  // First sanitize for injection safety.
  const safe = _sanitize_hint_path(command);

  if (safe.length <= _MAX_BASH_COMMAND_DISPLAY_LEN) {
    return safe;
  }

  // For longer commands, greedily include parts until we hit the limit.
  const parts = safe.split(/\s+/).filter((p) => p.length > 0);
  if (parts.length === 0) {
    return safe;
  }

  const result_parts: string[] = [];
  let current_len = 0;

  for (const part of parts) {
    const sep = result_parts.length > 0 ? " " : "";
    const candidate_len = current_len + sep.length + part.length;
    if (candidate_len > _MAX_BASH_COMMAND_DISPLAY_LEN) {
      break;
    }
    result_parts.push(part);
    current_len = candidate_len;
  }

  let result = result_parts.join(" ");
  if (result !== safe) {
    result = result + "…";
  }
  return result;
}

/**
 * Extract the first non-empty line from bash output for display in a hint.
 * Returns null if the output is empty or only whitespace. (Python
 * _get_first_line_preview.)
 */
function _get_first_line_preview(output_text: string, max_len = 60): string | null {
  if (!output_text) {
    return null;
  }
  for (const line of _splitlines(output_text)) {
    const stripped = line.trim();
    if (stripped) {
      let safe = _sanitize_hint_path(stripped);
      if (safe.length > max_len) {
        safe = safe.slice(0, max_len) + "…";
      }
      return safe;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Cross-session bash cache-hit hint
// ---------------------------------------------------------------------------

/**
 * Return a hint when *command* has a cached output from a prior session.
 * Complements build_bash_dedup_hint. Returns null when bash_cache is unavailable
 * (not yet ported). (Python build_bash_cache_hit_hint, @_failsoft_hint.)
 */
export const build_bash_cache_hit_hint = _failsoft_hint(
  (args: {
    session_id: string;
    command: string;
    cache?: SessionCache | null;
    cwd?: string | null;
  }): ReadHint | null => {
    const { session_id, command } = args;
    const cache = args.cache ?? null;
    const cwd = args.cwd ?? null;

    if (
      !_check_dedup_preconditions({
        session_id,
        required_param: command,
        cache,
      })
    ) {
      return null;
    }

    const bash_cache = _getBashCache();
    if (bash_cache === null) {
      return null; // bash_cache not yet ported — fail soft.
    }

    const cmd_sha = bash_cache.command_hash(command, cwd);

    // If the current session already has this command, the dedup hint handles it.
    const current_entry = session.lookup_bash_entry(session_id, cmd_sha, { cache });
    if (current_entry !== null) {
      return null;
    }

    // Look for a cached output from any prior session.
    const meta = bash_cache.find_cached_for_command(command, cwd);
    if (meta === null) {
      return null;
    }

    const total_bytes = meta.stdout_bytes + meta.stderr_bytes;
    if (
      _check_dedup_min_threshold(
        total_bytes,
        _get_bash_dedup_min_bytes,
        cache,
        "bash_cache_hit_below_threshold",
      )
    ) {
      return null;
    }

    const now = _now();
    const age = now - meta.ts;
    const stale_threshold =
      cache !== null ? _session_stale_threshold(cache, now) : STALE_READ_AGE_SECONDS;
    // Immutable git commands (git show <full-sha>) never go stale.
    if (age > stale_threshold && !bash_cache.is_git_immutable_command(command)) {
      _LOG.debug(
        "build_bash_cache_hit_hint: prior-session cache entry for %s is %ss old (threshold=%ss); skipping",
        sanitize_log_str(command, 100),
        age.toFixed(0),
        stale_threshold.toFixed(0),
      );
      if (cache !== null) {
        cache.record_hint_suppressed("bash_cache_hit_stale");
      }
      return null;
    }

    // Fingerprint dedup: emit only once per command per session.
    const fp_key = _hint_fingerprint(cmd_sha, "bash_prior");
    if (cache !== null && cache.has_hint_fingerprint(fp_key)) {
      _LOG.debug("build_bash_cache_hit_hint: fingerprint key %s already seen; skipping", fp_key);
      return null;
    }

    if (cache !== null) {
      cache.mark_hint_seen(fp_key);
    }

    const tokens_avoided = _est_tokens_from_chars(total_bytes);
    const exit_str = meta.exit_code === null ? "" : ` x=${meta.exit_code}`;
    const short_id = cache_common.short_output_id(meta.output_id);
    const age_str = age >= 3600 ? `${Math.trunc(age / 3600)}h` : `${Math.trunc(age / 60)}m`;

    // Try to load the first line of output for a preview hint.
    let preview_text = "";
    try {
      const body = bash_cache.load_output(meta.output_id);
      if (body) {
        const first_line = _get_first_line_preview(body);
        if (first_line) {
          preview_text = ` ↪'${first_line}'`;
        }
      }
    } catch {
      // fail-soft: preview must never break the hint
    }

    const result = new ReadHint(
      _apply_terse(
        `Command cached ${age_str} ago: ${_comma(total_bytes)}B${exit_str}, ~${tokens_avoided}t. ` +
          `Use \`token-goat bash-output ${short_id}\` to read without re-running.${preview_text}`,
      ),
      tokens_avoided,
    );
    return _emit_json_sidecar(result, "bash_cache_hit", {
      command,
      bytes_size: total_bytes,
      age_s: Math.trunc(age),
      wasted: tokens_avoided,
    });
  },
  "build_bash_cache_hit_hint",
);

// ---------------------------------------------------------------------------
// Grep dedup hint
// ---------------------------------------------------------------------------

// Minimum result_count before the grep dedup hint fires.
export const _GREP_DEDUP_MIN_RESULT_COUNT = 5; // fallback default

// Rough bytes-per-Grep-result estimate.
const _GREP_AVG_BYTES_PER_RESULT = 120;

// Cross-session grep dedup: minimum number of sessions before firing.
const _GREP_CROSS_SESSION_MIN_COUNT = 3;

// Cross-session grep dedup: maximum age (seconds) of last_ts to fire.
const _GREP_CROSS_SESSION_STALE_SECS = 3600.0;

/**
 * Return a hint when the same Grep pattern was just run in this session. Never
 * raises (fail-soft). (Python build_grep_dedup_hint, @_failsoft_hint.)
 */
export const build_grep_dedup_hint = _failsoft_hint(
  (args: {
    session_id: string;
    pattern: string;
    path: string | null;
    cache?: SessionCache | null;
  }): ReadHint | null => {
    const { session_id, pattern } = args;
    const grepPath = args.path;
    const cache = _require_cache(session_id, args.cache ?? null);
    if (cache === null) {
      return null;
    }

    if (
      !_check_dedup_preconditions({
        session_id,
        required_param: pattern,
        cache,
      })
    ) {
      return null;
    }

    const now = _now();
    // Cross-session hint: fires even when the session has no prior greps yet.
    if (_curator_should_emit(cache) && _hint_budget_check(cache, _HINT_KIND_DEDUP)) {
      const key_for_xsess = `${pattern}|xsess`;
      const fp_key_xsess = _hint_fingerprint(key_for_xsess, "grep_xsess");
      if (!cache.has_hint_fingerprint(fp_key_xsess)) {
        const cross_session_hint = _build_grep_cross_session_hint(pattern, now);
        if (cross_session_hint !== null) {
          _record_dedup_hint_emitted(cache, `grep_xsess:${pattern}`, "grep_dedup", fp_key_xsess);
          return cross_session_hint;
        }
      }
    }

    // Intra-session scan: requires at least one prior grep in this session.
    if (cache.greps.length === 0) {
      return null;
    }

    const grep_stale_threshold = _session_stale_threshold(cache, now);
    for (let i = cache.greps.length - 1; i >= 0; i--) {
      const entry = cache.greps[i]!;
      if (entry.pattern !== pattern) {
        continue;
      }
      if (entry.path !== grepPath) {
        continue;
      }
      const age = now - entry.ts;
      if (age > grep_stale_threshold) {
        // Older entries are even older — short-circuit the scan.
        return null;
      }
      if (
        _check_dedup_min_threshold(
          entry.result_count,
          _get_grep_dedup_min_matches,
          cache,
          "grep_dedup_below_threshold",
        )
      ) {
        return null;
      }

      // Two-phase dedup: check the fingerprint key BEFORE constructing hint text.
      const key_for_dedup = `${pattern}|${grepPath ?? ""}`;
      const fp_key = _hint_fingerprint(key_for_dedup, "grep");
      if (cache.has_hint_fingerprint(fp_key)) {
        _LOG.debug(
          "build_grep_dedup_hint: fingerprint key %s already seen; skipping construction",
          fp_key,
        );
        return null;
      }

      const bytes_avoided = (entry.result_count ?? 0) * _GREP_AVG_BYTES_PER_RESULT;
      const tokens_avoided = _est_tokens_from_chars(bytes_avoided);
      const pattern_short = _truncate_pattern_display(pattern);
      const path_str = grepPath ? ` in \`${_sanitize_hint_path(grepPath)}\`` : "";
      _record_dedup_hint_emitted(cache, `grep:${pattern}`, "grep_dedup", fp_key);
      const result = new ReadHint(
        _apply_terse(
          `Grep \`${pattern_short}\`${path_str} (${Math.trunc(age)}s): ${entry.result_count} matches, ~${tokens_avoided}t.`,
        ),
        tokens_avoided,
      );
      return _emit_json_sidecar(result, "grep_dedup", {
        pattern,
        path: grepPath,
        result_count: entry.result_count,
        age_s: Math.trunc(age),
        wasted: tokens_avoided,
      });
    }
    return null;
  },
  "build_grep_dedup_hint",
);

/**
 * Query global.db for cross-session grep frequency and emit a hint if warranted.
 * Returns null on any DB error (fail-soft). (Python _build_grep_cross_session_hint.)
 */
function _build_grep_cross_session_hint(pattern: string, now: number): ReadHint | null {
  const pattern_hash = createHash("sha1").update(Buffer.from(pattern, "utf8")).digest("hex");
  let row: { count?: number; last_ts?: number } | undefined;
  try {
    row = db.openGlobal((conn: DatabaseType): { count?: number; last_ts?: number } | undefined => {
      return conn
        .prepare("SELECT count, last_ts FROM grep_patterns WHERE pattern_hash = ?")
        .get(pattern_hash) as { count?: number; last_ts?: number } | undefined;
    });
  } catch {
    return null;
  }
  if (row === undefined || row === null) {
    return null;
  }
  const count = Math.trunc(Number(row.count));
  const last_ts = Number(row.last_ts);
  if (count < _GREP_CROSS_SESSION_MIN_COUNT) {
    return null;
  }
  const age = now - last_ts;
  if (age > _GREP_CROSS_SESSION_STALE_SECS) {
    return null;
  }
  // Pattern is frequent and recent — nudge toward semantic search.
  const pattern_short = _truncate_pattern_display(pattern);
  return new ReadHint(
    _apply_terse(
      `Grep \`${pattern_short}\` is a frequent pattern (${count} sessions). ` +
        `Try: token-goat semantic '${pattern_short}'`,
    ),
    0,
  );
}

// ---------------------------------------------------------------------------
// Glob dedup hint
// ---------------------------------------------------------------------------

// Minimum result count before the glob dedup hint fires.
export const _GLOB_DEDUP_MIN_RESULT_COUNT = 5;

// Rough bytes-per-Glob-result estimate.
const _GLOB_AVG_BYTES_PER_RESULT = 60;

/**
 * Return a hint when the same Glob pattern was already run in this session. Never
 * raises (fail-soft). (Python build_glob_dedup_hint, @_failsoft_hint.)
 */
export const build_glob_dedup_hint = _failsoft_hint(
  (args: {
    session_id: string;
    pattern: string;
    path: string | null;
    cache?: SessionCache | null;
  }): ReadHint | null => {
    const { session_id, pattern } = args;
    const globPath = args.path;
    const cache = _require_cache(session_id, args.cache ?? null);
    if (cache === null || cache.is_glob_history_empty()) {
      return null;
    }

    if (
      !_check_dedup_preconditions({
        session_id,
        required_param: pattern,
        cache,
      })
    ) {
      return null;
    }

    const entry = session.lookup_glob_entry(session_id, pattern, globPath, { cache });
    if (entry === null) {
      return null;
    }

    const [is_stale, age] = _check_entry_staleness(
      entry,
      cache,
      "build_glob_dedup_hint",
      "glob_dedup_stale",
      _sanitize_hint_path(pattern),
    );
    if (is_stale) {
      return null;
    }

    if (
      _check_dedup_min_threshold(
        entry.result_count,
        () => _GLOB_DEDUP_MIN_RESULT_COUNT,
        cache,
        "glob_dedup_below_threshold",
      )
    ) {
      return null;
    }

    // Two-phase dedup: check the fingerprint key BEFORE constructing hint text.
    const key_for_dedup = `${pattern}|${globPath ?? ""}`;
    const fp_key = _hint_fingerprint(key_for_dedup, "glob");
    if (cache.has_hint_fingerprint(fp_key)) {
      _LOG.debug(
        "build_glob_dedup_hint: fingerprint key %s already seen; skipping construction",
        fp_key,
      );
      return null;
    }

    const bytes_avoided = (entry.result_count ?? 0) * _GLOB_AVG_BYTES_PER_RESULT;
    const tokens_avoided = _est_tokens_from_chars(bytes_avoided);
    const pattern_short = _sanitize_hint_path(pattern);
    const path_str = globPath ? ` in \`${_sanitize_hint_path(globPath)}\`` : "";
    _record_dedup_hint_emitted(cache, `glob:${pattern}`, "glob_dedup", fp_key);
    const result = new ReadHint(
      _apply_terse(
        `Glob \`${pattern_short}\`${path_str} (${Math.trunc(age)}s): ${entry.result_count} results, ~${tokens_avoided}t.`,
      ),
      tokens_avoided,
    );
    return _emit_json_sidecar(result, "glob_dedup", {
      pattern,
      path: globPath,
      result_count: entry.result_count,
      age_s: Math.trunc(age),
      wasted: tokens_avoided,
    });
  },
  "build_glob_dedup_hint",
);

// ---------------------------------------------------------------------------
// WebFetch dedup hint
// ---------------------------------------------------------------------------

/**
 * Return a hint when *url* was fetched earlier in this session. Never raises
 * (fail-soft). (Python build_web_dedup_hint, @_failsoft_hint.)
 */
export const build_web_dedup_hint = _failsoft_hint(
  (args: { session_id: string; url: string; cache?: SessionCache | null }): ReadHint | null => {
    const { session_id, url } = args;
    const cache = args.cache ?? null;

    if (
      !_check_dedup_preconditions({
        session_id,
        required_param: url,
        cache,
      })
    ) {
      return null;
    }

    const url_sha = web_cache.url_hash(url);
    const entry = session.lookup_web_entry(session_id, url_sha, { cache });
    if (entry === null) {
      return null;
    }

    const [is_stale, age] = _check_entry_staleness(
      entry,
      cache,
      "build_web_dedup_hint",
      "web_dedup_stale",
      _sanitize_hint_path(url),
    );
    if (is_stale) {
      return null;
    }

    const cfg = config.load();
    if (
      _check_dedup_min_threshold(
        entry.body_bytes,
        () => cfg.hints?.web_dedup_min_bytes ?? 200,
        cache,
        "web_dedup_below_threshold",
      )
    ) {
      return null;
    }

    // Two-phase dedup: check the fingerprint key BEFORE constructing hint text.
    const fp_key = _hint_fingerprint(url_sha, "web");
    if (cache !== null && cache.has_hint_fingerprint(fp_key)) {
      _LOG.debug(
        "build_web_dedup_hint: fingerprint key %s already seen; skipping construction",
        fp_key,
      );
      return null;
    }

    const tokens_avoided = _est_tokens_from_chars(entry.body_bytes);
    const status_str = entry.status_code !== null ? ` status=${entry.status_code}` : "";
    // Format content-type for display (e.g., "html" from "text/html").
    let content_type_str = "";
    const content_type = entry.content_type;
    if (content_type) {
      const ct_parts = content_type.split("/");
      content_type_str = ct_parts.length >= 2 ? ` ${ct_parts[1]}` : ` ${content_type}`;
    }

    // Show the --grep PATTERN recall hint only once per session.
    const _WEB_RECALL_HINT_KEY = "web_output_grep_hint_shown";
    const _grep_hint_shown =
      cache !== null && cache.has_hint_fingerprint(_WEB_RECALL_HINT_KEY);
    let grep_suffix: string;
    if (entry.body_bytes >= _BASH_DEDUP_GREP_SUGGEST_BYTES && !_grep_hint_shown) {
      grep_suffix = " (add --grep PATTERN to filter)";
      if (cache !== null) {
        cache.mark_hint_seen(_WEB_RECALL_HINT_KEY);
      }
    } else {
      grep_suffix = "";
    }

    if (cache !== null) {
      _record_dedup_hint_emitted(cache, `web:${url_sha}`, "web_dedup", fp_key);
    }
    // After the agent has seen the verbose recall pointer twice, emit just the ID.
    const short_id = cache_common.short_output_id(entry.output_id);
    let recall_str: string;
    if (_should_emit_recall_command(cache, "web")) {
      recall_str = `\`token-goat web-output ${short_id}\``;
    } else {
      recall_str = `id=${short_id}`;
    }
    const result = new ReadHint(
      _apply_terse(
        `URL (${Math.trunc(age)}s): ${_comma(entry.body_bytes)}B${status_str}${content_type_str}, ~${tokens_avoided}t. ` +
          `${recall_str}${grep_suffix}`,
      ),
      tokens_avoided,
    );
    return _emit_json_sidecar(result, "web_dedup", {
      url,
      bytes_size: entry.body_bytes,
      age_s: Math.trunc(age),
      wasted: tokens_avoided,
    });
  },
  "build_web_dedup_hint",
);

// ---------------------------------------------------------------------------
// Cross-session web cache-hit hint
// ---------------------------------------------------------------------------

/**
 * Return a hint when *url* has a cached body on disk from a prior session.
 * Complements build_web_dedup_hint. Never raises (fail-soft). (Python
 * build_web_cache_hit_hint, @_failsoft_hint.)
 */
export const build_web_cache_hit_hint = _failsoft_hint(
  (args: { session_id: string; url: string; cache?: SessionCache | null }): ReadHint | null => {
    const { session_id, url } = args;
    const cache = args.cache ?? null;

    if (
      !_check_dedup_preconditions({
        session_id,
        required_param: url,
        cache,
      })
    ) {
      return null;
    }

    const url_sha = web_cache.url_hash(url);

    // If the current session already has this URL, the dedup hint handles it.
    const current_entry = session.lookup_web_entry(session_id, url_sha, { cache });
    if (current_entry !== null) {
      return null;
    }

    // Look for a cached body from any prior session.
    const meta = web_cache.find_cached_for_url(url);
    if (meta === null) {
      return null;
    }

    const cfg = config.load();
    if (
      _check_dedup_min_threshold(
        meta.body_bytes,
        () => cfg.hints?.web_dedup_min_bytes ?? 200,
        cache,
        "web_cache_hit_below_threshold",
      )
    ) {
      return null;
    }

    const now = _now();
    const age = now - meta.ts;
    const stale_threshold =
      cache !== null ? _session_stale_threshold(cache, now) : STALE_READ_AGE_SECONDS;
    if (age > stale_threshold) {
      _LOG.debug(
        "build_web_cache_hit_hint: prior-session cache entry for %s is %ss old (threshold=%ss); skipping",
        sanitize_log_str(url, 100),
        age.toFixed(0),
        stale_threshold.toFixed(0),
      );
      if (cache !== null) {
        cache.record_hint_suppressed("web_cache_hit_stale");
      }
      return null;
    }

    // Fingerprint dedup: emit only once per URL per session.
    const fp_key = _hint_fingerprint(url_sha, "web_prior");
    if (cache !== null && cache.has_hint_fingerprint(fp_key)) {
      _LOG.debug("build_web_cache_hit_hint: fingerprint key %s already seen; skipping", fp_key);
      return null;
    }

    if (cache !== null) {
      cache.mark_hint_seen(fp_key);
    }

    const tokens_avoided = _est_tokens_from_chars(meta.body_bytes);
    const status_str = meta.status_code !== null ? ` status=${meta.status_code}` : "";
    // Format content-type for display.
    let content_type_str = "";
    const content_type = meta.content_type;
    if (content_type) {
      const ct_parts = content_type.split("/");
      content_type_str = ct_parts.length >= 2 ? ` ${ct_parts[1]}` : ` ${content_type}`;
    }

    const short_id = cache_common.short_output_id(meta.output_id);
    const age_str = age >= 3600 ? `${Math.trunc(age / 3600)}h` : `${Math.trunc(age / 60)}m`;
    const result = new ReadHint(
      _apply_terse(
        `URL cached ${age_str} ago: ${_comma(meta.body_bytes)}B${status_str}${content_type_str}, ~${tokens_avoided}t. ` +
          `Use \`token-goat web-output ${short_id}\` to read without re-fetching.`,
      ),
      tokens_avoided,
    );
    return _emit_json_sidecar(result, "web_cache_hit", {
      url,
      bytes_size: meta.body_bytes,
      age_s: Math.trunc(age),
      wasted: tokens_avoided,
    });
  },
  "build_web_cache_hit_hint",
);

// ---------------------------------------------------------------------------
// Content-unchanged short-circuit hint
// ---------------------------------------------------------------------------

// Maximum age of a snapshot before the "unchanged since your edit" hint is
// suppressed.
const _UNCHANGED_MAX_AGE_SECONDS = 10 * 60;

// Minimum file size (bytes) before the unchanged hint fires.
const _UNCHANGED_MIN_BYTES = 800;

/**
 * Return a hint when a file's on-disk content matches its session snapshot.
 * Never raises (fail-soft). (Python build_unchanged_file_hint, @_failsoft_hint.)
 */
export const build_unchanged_file_hint = _failsoft_hint(
  (args: {
    session_id: string;
    file_path: string;
    cache?: SessionCache | null;
  }): ReadHint | null => {
    return _build_unchanged_file_hint_inner({
      session_id: args.session_id,
      file_path: args.file_path,
      cache: args.cache ?? null,
    });
  },
  "build_unchanged_file_hint",
);

/** Inner implementation; may raise. (Python _build_unchanged_file_hint_inner.) */
function _build_unchanged_file_hint_inner(args: {
  session_id: string;
  file_path: string;
  cache: SessionCache | null;
}): ReadHint | null {
  const { session_id, file_path } = args;
  let cache = args.cache;

  if (!session_id || !file_path) {
    return null;
  }

  cache = _require_cache(session_id, cache);
  if (cache === null) {
    return null;
  }

  // Require that the file was read AND subsequently edited this session.
  const entry = session.get_file_entry(session_id, file_path, { cache });
  if (entry === null || entry.last_edit_ts <= entry.last_read_ts) {
    return null;
  }

  // Snapshot must exist — it was written right after the last Read.
  const stored_sha = session.get_snapshot_sha(session_id, file_path, { cache });
  if (!stored_sha) {
    return null;
  }

  // Snapshot age check.
  const snapshot_age = _now() - entry.last_read_ts;
  if (snapshot_age > _UNCHANGED_MAX_AGE_SECONDS) {
    _LOG.debug(
      "build_unchanged_file_hint: snapshot too old (%ss > %ds) for %s",
      snapshot_age.toFixed(0),
      _UNCHANGED_MAX_AGE_SECONDS,
      _sanitize_hint_path(file_path),
    );
    return null;
  }

  // Read the current file (limit to MAX_SNAPSHOT_BYTES + 1).
  let current_bytes: Buffer;
  try {
    current_bytes = _readFirstBytes(file_path, snapshots.MAX_SNAPSHOT_BYTES + 1);
  } catch (exc) {
    _LOG.debug(
      "build_unchanged_file_hint: cannot read %s: %s",
      _sanitize_hint_path(file_path),
      exc,
    );
    return null;
  }

  if (current_bytes.length > snapshots.MAX_SNAPSHOT_BYTES) {
    // File grown past snapshot cap — can't compare.
    return null;
  }

  if (current_bytes.length < _UNCHANGED_MIN_BYTES) {
    return null;
  }

  // For files larger than the truncation threshold, recompute the comparison SHA
  // over the same truncated prefix so the "unchanged" check stays consistent.
  let compare_bytes = current_bytes;
  if (current_bytes.length > snapshots.SNAPSHOT_TRUNCATE_BYTES) {
    compare_bytes = current_bytes.subarray(0, snapshots.SNAPSHOT_TRUNCATE_BYTES);
  }
  const current_sha = createHash("sha256").update(compare_bytes).digest("hex");
  if (current_sha !== stored_sha) {
    // Content changed on disk since the snapshot — let diff-hint handle it.
    return null;
  }

  // SHA matches: the file is byte-for-byte identical to when it was last read.
  const fname = _sanitize_hint_path(path.basename(file_path));
  const safe_path = _sanitize_hint_path(file_path);
  const age_s = Math.trunc(snapshot_age);
  const full_tokens = _est_tokens_from_chars(current_bytes.length);
  const sha_prefix = current_sha.slice(0, 8);

  const prose = new ReadHint(
    _apply_terse(
      `\`${fname}\` unchanged since your edit (${age_s}s ago, sha:${sha_prefix}, ~${full_tokens}t). ` +
        `Edit result still in context — for symbols: \`token-goat read "${safe_path}::Symbol"\`.`,
    ),
    full_tokens,
  );
  // Opt-in machine-readable sidecar; no-op when [hints] json_sidecar is off.
  cache.record_hint_emitted("unchanged_file");
  return _emit_json_sidecar(prose, "unchanged_since_edit", {
    file: safe_path,
    age_s,
    wasted: full_tokens,
    sha: sha_prefix,
  });
}

// ---------------------------------------------------------------------------
// Index-only file hint
// ---------------------------------------------------------------------------
// Machine-generated files that are never intended to be read in full.

// Exact basenames that are always lockfiles, matched case-insensitively.
const _INDEX_ONLY_LOCKFILE_NAMES: ReadonlySet<string> = new Set([
  "uv.lock",
  "poetry.lock",
  "cargo.lock",
  "gemfile.lock",
  "composer.lock",
  "pnpm-lock.yaml",
  "yarn.lock",
  "package-lock.json",
  "bun.lockb",
]);

// Suffixes that indicate machine-generated bundles / artefacts.
const _INDEX_ONLY_BUNDLE_SUFFIXES: ReadonlySet<string> = new Set([
  ".min.js",
  ".min.css",
  ".bundle.js",
  ".bundle.css",
  ".tsbuildinfo",
  ".map",
]);

// Minimum file size (bytes) before the index-only hint fires.
const _INDEX_ONLY_MIN_BYTES = 5_000;

/**
 * Return the category ('lockfile', 'bundle', 'map', 'buildinfo') or null.
 * (Python _is_index_only_file.)
 */
function _is_index_only_file(basename_lower: string): string | null {
  if (_INDEX_ONLY_LOCKFILE_NAMES.has(basename_lower)) {
    return "lockfile";
  }
  for (const suffix of _INDEX_ONLY_BUNDLE_SUFFIXES) {
    if (basename_lower.endsWith(suffix)) {
      if (suffix === ".map") {
        return "map";
      }
      if (suffix === ".tsbuildinfo") {
        return "buildinfo";
      }
      return "bundle";
    }
  }
  return null;
}

/**
 * Return a hint when Read targets a machine-generated index-only file. Never
 * raises (fail-soft). (Python build_index_only_file_hint, @_failsoft_hint.)
 */
export const build_index_only_file_hint = _failsoft_hint(
  (args: { file_path: string; offset: unknown; limit: unknown }): ReadHint | null => {
    return _build_index_only_file_hint_inner({
      file_path: args.file_path,
      offset: args.offset,
      limit: args.limit,
    });
  },
  "build_index_only_file_hint",
);

/** Inner implementation; may raise. (Python _build_index_only_file_hint_inner.) */
function _build_index_only_file_hint_inner(args: {
  file_path: string;
  offset: unknown;
  limit: unknown;
}): ReadHint | null {
  const { file_path, offset, limit } = args;
  // Surgical guard: both offset AND limit present means intentional scoped read.
  const has_offset = offset !== null && _isInt(offset) && offset >= 0;
  const has_limit = limit !== null && _isInt(limit) && limit > 0;
  if (has_offset && has_limit) {
    return null;
  }

  const basename = path.basename(file_path);
  const basename_lower = basename.toLowerCase();

  const category = _is_index_only_file(basename_lower);
  if (category === null) {
    return null;
  }

  // Cheap size check — skip hint for tiny files.
  let file_size: number;
  try {
    file_size = fs.statSync(file_path).size;
  } catch {
    return null;
  }

  if (file_size < _INDEX_ONLY_MIN_BYTES) {
    return null;
  }

  const size_kb = Math.trunc(file_size / 1024);
  const fname = _sanitize_hint_path(basename);

  if (category === "lockfile") {
    // Identify the package manager and give a concrete alternative command.
    let alt: string;
    if (basename_lower === "uv.lock") {
      alt = `\`uv pip list\` or \`jq '.package[] | select(.name=="NAME")' ${fname}\``;
    } else if (basename_lower === "package-lock.json") {
      alt = `\`npm ls\` or \`jq '.dependencies.NAME' ${fname}\``;
    } else if (basename_lower === "yarn.lock" || basename_lower === "pnpm-lock.yaml") {
      alt = "`yarn list` / `pnpm list` instead";
    } else if (basename_lower === "cargo.lock") {
      alt = "`cargo tree` or `grep -A5 'name = \"NAME\"' " + fname + "`";
    } else if (basename_lower === "gemfile.lock") {
      alt = "`bundle list` instead";
    } else if (basename_lower === "poetry.lock") {
      alt = "`poetry show` or `grep -A5 'name = \"NAME\"' " + fname + "`";
    } else {
      alt = `\`grep NAME ${fname}\` instead`;
    }
    return new ReadHint(
      _apply_terse(
        `\`${fname}\` (lockfile, ${size_kb}KB). ` +
          `Use ${alt} — do not read ${size_kb}K lines of pinned dep hashes.`,
      ),
      0,
    );
  }

  if (category === "map") {
    return new ReadHint(
      _apply_terse(
        `\`${fname}\` (source map, ${size_kb}KB). ` +
          `Use browser devtools or source-map-cli; do not read in full.`,
      ),
      0,
    );
  }

  if (category === "buildinfo") {
    return new ReadHint(
      _apply_terse(
        `\`${fname}\` (TS incremental build cache, ${size_kb}KB). ` +
          `Machine-only artefact — do not read.`,
      ),
      0,
    );
  }

  // category == "bundle"
  let src_hint: string;
  if (basename_lower.includes(".min.js") || basename_lower.includes(".bundle.js")) {
    src_hint = "Read the source in `src/` instead.";
  } else if (basename_lower.includes(".min.css") || basename_lower.includes(".bundle.css")) {
    src_hint = "Read the source SCSS/CSS in `src/` instead.";
  } else {
    src_hint = "Read the original source instead.";
  }
  return new ReadHint(
    _apply_terse(`\`${fname}\` (minified bundle, ${size_kb}KB). ` + `${src_hint}`),
    0,
  );
}

// ---------------------------------------------------------------------------
// Structured-file hint
// ---------------------------------------------------------------------------

const _STRUCTURED_EXT_TABULAR: ReadonlySet<string> = new Set([".csv", ".tsv", ".jsonl", ".ndjson"]);
const _STRUCTURED_EXT_JSON: ReadonlySet<string> = new Set([".json"]);
const _STRUCTURED_EXT_LOG: ReadonlySet<string> = new Set([".log"]);
const _STRUCTURED_EXT_XML: ReadonlySet<string> = new Set([
  ".xml",
  ".plist",
  ".csproj",
  ".vbproj",
  ".fsproj",
  ".props",
  ".targets",
]);
const _STRUCTURED_EXT_YAML: ReadonlySet<string> = new Set([".yaml", ".yml"]);
const _STRUCTURED_EXT_TOML: ReadonlySet<string> = new Set([".toml"]);
const _STRUCTURED_EXT_LOCK: ReadonlySet<string> = new Set([".lock", ".lockb"]);

// New file types with surgical-read hints.
const _STRUCTURED_EXT_CSS: ReadonlySet<string> = new Set([".css", ".scss", ".sass"]);
const _STRUCTURED_EXT_SQL: ReadonlySet<string> = new Set([".sql"]);
const _STRUCTURED_EXT_GRAPHQL: ReadonlySet<string> = new Set([".graphql", ".gql"]);
const _STRUCTURED_EXT_PROTO: ReadonlySet<string> = new Set([".proto"]);

// Basenames (lowercased) that are env-variable files — matched by name.
const _STRUCTURED_BASENAME_ENV: ReadonlySet<string> = new Set([
  ".env",
  ".env.example",
  ".env.local",
  ".env.test",
  ".env.production",
  ".env.staging",
  ".env.development",
  ".env.defaults",
]);
// Basenames (lowercased) that are Makefiles — matched by name.
const _STRUCTURED_BASENAME_MAKEFILE: ReadonlySet<string> = new Set([
  "makefile",
  "gnumakefile",
  "bsdmakefile",
]);

// Minimum size in bytes before the structured-file hint fires.
const _STRUCTURED_FILE_MIN_BYTES = 50_000;

// Per-category minimum sizes for new file types.
const _STRUCTURED_CSS_MIN_BYTES = 10_000;
const _STRUCTURED_SQL_MIN_BYTES = 5_000;
const _STRUCTURED_GRAPHQL_MIN_BYTES = 2_000;
const _STRUCTURED_PROTO_MIN_BYTES = 2_000;
const _STRUCTURED_ENV_MIN_BYTES = 500;
const _STRUCTURED_MAKEFILE_MIN_BYTES = 1_000;

// Maximum bytes to read when counting newlines for the row estimate.
const _STRUCTURED_NEWLINE_PROBE_BYTES = 32_768;

/**
 * Estimate rows/lines in a structured file from a 32 KB probe. Returns a
 * non-negative integer; never raises. (Python _estimate_row_count.)
 */
function _estimate_row_count(p: string, file_size: number): number {
  try {
    const probe = _readFirstBytes(p, _STRUCTURED_NEWLINE_PROBE_BYTES);
    if (probe.length === 0) {
      return 0;
    }
    let probe_lines = 0;
    for (let i = 0; i < probe.length; i++) {
      if (probe[i] === 0x0a) {
        probe_lines++;
      }
    }
    if (probe.length < _STRUCTURED_NEWLINE_PROBE_BYTES) {
      // Whole file fit in the probe — exact count.
      return probe_lines;
    }
    // Extrapolate: lines_per_byte × full_size.
    return Math.max(0, Math.trunc((probe_lines * file_size) / probe.length));
  } catch {
    return 0;
  }
}

/**
 * Extract CSV header line from the first line. Returns comma-separated column
 * names, or null on error/empty file. Never raises. (Python _extract_csv_headers.)
 */
function _extract_csv_headers(p: string): string | null {
  try {
    const first_line = _readFirstLine(p).trim();
    if (first_line) {
      let line = first_line;
      if (line.length > 60) {
        line = line.slice(0, 57) + "...";
      }
      return line;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Extract schema from the first object in a JSON array. Returns schema as
 * comma-separated key types, or null. Never raises. (Python
 * _extract_json_array_schema.)
 */
function _extract_json_array_schema(p: string): string | null {
  try {
    const chunk = _readFirstBytes(p, 4096).toString("utf8");
    if (!chunk) {
      return null;
    }

    // Lightweight: look for [ and then first { to skip to object.
    const bracket_idx = chunk.indexOf("[");
    if (bracket_idx === -1) {
      return null;
    }
    const brace_idx = chunk.indexOf("{", bracket_idx);
    if (brace_idx === -1) {
      return null;
    }

    // Try to extract a complete object by finding matching }.
    const obj_start = brace_idx;
    let depth = 0;
    let in_string = false;
    let escape = false;
    let obj_str: string | null = null;
    for (let i = obj_start; i < chunk.length; i++) {
      const c = chunk[i]!;
      if (escape) {
        escape = false;
        continue;
      }
      if (c === "\\") {
        escape = true;
        continue;
      }
      if (c === '"') {
        in_string = !in_string;
        continue;
      }
      if (in_string) {
        continue;
      }
      if (c === "{") {
        depth += 1;
      } else if (c === "}") {
        depth -= 1;
        if (depth === 0) {
          obj_str = chunk.slice(obj_start, i + 1);
          break;
        }
      }
    }
    if (obj_str === null) {
      return null;
    }

    const obj: unknown = JSON.parse(obj_str);
    return _schemaFromObject(obj);
  } catch {
    return null;
  }
}

/**
 * Extract schema from the first line of an NDJSON/JSONL file. Returns null on
 * error or non-object first line. Never raises. (Python
 * _extract_ndjson_first_line_schema.)
 */
function _extract_ndjson_first_line_schema(p: string): string | null {
  try {
    const first_line = _readFirstLine(p).trim();
    if (!first_line) {
      return null;
    }
    const obj: unknown = JSON.parse(first_line);
    return _schemaFromObject(obj);
  } catch {
    return null;
  }
}

/**
 * Build a "key: type, ..." schema string from a parsed JSON object (first 5
 * keys), or null when *obj* is not a plain object / has no keys. Mirrors the
 * shared body of _extract_json_array_schema / _extract_ndjson_first_line_schema.
 */
function _schemaFromObject(obj: unknown): string | null {
  if (obj === null || typeof obj !== "object" || Array.isArray(obj)) {
    return null;
  }
  const rec = obj as Record<string, unknown>;
  const schema_parts: string[] = [];
  for (const key of Object.keys(rec).slice(0, 5)) {
    const val = rec[key];
    let type_name: string;
    // Order matches Python: bool before int (Python bool is an int subclass).
    if (typeof val === "boolean") {
      type_name = "bool";
    } else if (typeof val === "number") {
      type_name = Number.isInteger(val) ? "int" : "float";
    } else if (typeof val === "string") {
      type_name = "str";
    } else if (Array.isArray(val)) {
      type_name = "list";
    } else if (val !== null && typeof val === "object") {
      type_name = "dict";
    } else if (val === null) {
      type_name = "null";
    } else {
      type_name = "?";
    }
    schema_parts.push(`${key}: ${type_name}`);
  }
  if (schema_parts.length > 0) {
    let schema_str = schema_parts.join(", ");
    if (schema_str.length > 60) {
      schema_str = schema_str.slice(0, 57) + "...";
    }
    return schema_str;
  }
  return null;
}

/**
 * Return [rel_path, top_symbol_name] for *file_path* from the index, or null.
 * Resolves the owning project by walking up from the file's own directory.
 * Never raises. (Python _lookup_top_indexed_symbol.)
 */
function _lookup_top_indexed_symbol(file_path: string): [string, string] | null {
  try {
    if (!path.isAbsolute(file_path)) {
      return null;
    }
    const project = find_project(path.dirname(file_path));
    if (project === null) {
      return null;
    }
    const rel = _relativeTo(file_path, project.root);
    if (rel === null) {
      return null;
    }
    const [symbols] = _get_indexed_symbols_and_line_count(rel, project.hash);
    if (symbols.length === 0) {
      return null;
    }
    return [_sanitize_hint_path(rel), _sanitize_hint_symbol(symbols[0]!.name)];
  } catch {
    return null; // fail-soft; the hint path must never raise
  }
}

/**
 * Build the surgical-command clause for a structured-file hint. *fallback_cmd*
 * selects the no-symbol fallback ("outline" default, or "section" for raw-text
 * types). (Python _structured_read_or_outline.)
 */
function _structured_read_or_outline(
  top: [string, string] | null,
  safe_path: string,
  one_label: string,
  list_label: string,
  opts: { fallback_cmd?: string } = {},
): string {
  const fallback_cmd = opts.fallback_cmd ?? "outline";
  if (top !== null) {
    const [rel, sym] = top;
    return (
      `use \`token-goat read "${rel}::${sym}"\` for ${one_label} ` +
      `or \`token-goat outline "${safe_path}"\` to list all`
    );
  }
  if (fallback_cmd === "section") {
    return `use \`token-goat section "${safe_path}::<heading>"\` to read ${list_label} by name`;
  }
  return `use \`token-goat outline "${safe_path}"\` to list ${list_label}, then read one`;
}

/**
 * Return a hint when Read targets a large structured data file. Never raises
 * (fail-soft). (Python build_structured_file_hint, @_failsoft_hint.)
 */
export const build_structured_file_hint = _failsoft_hint(
  (args: { file_path: string; offset: unknown; limit: unknown }): ReadHint | null => {
    return _build_structured_file_hint_inner({
      file_path: args.file_path,
      offset: args.offset,
      limit: args.limit,
    });
  },
  "build_structured_file_hint",
);

/** Inner implementation; may raise. (Python _build_structured_file_hint_inner.) */
function _build_structured_file_hint_inner(args: {
  file_path: string;
  offset: unknown;
  limit: unknown;
}): ReadHint | null {
  const { file_path, offset, limit } = args;
  // If the caller already scoped the read with both offset AND limit, surgical.
  const has_offset = offset !== null && _isInt(offset) && offset >= 0;
  const has_limit = limit !== null && _isInt(limit) && limit > 0;
  if (has_offset && has_limit) {
    return null;
  }

  const ext = _suffix(file_path).toLowerCase();
  const basename_lower = path.basename(file_path).toLowerCase();

  const is_tabular = _STRUCTURED_EXT_TABULAR.has(ext);
  const is_json = _STRUCTURED_EXT_JSON.has(ext);
  const is_log = _STRUCTURED_EXT_LOG.has(ext);
  const is_xml = _STRUCTURED_EXT_XML.has(ext);
  const is_yaml = _STRUCTURED_EXT_YAML.has(ext);
  const is_toml = _STRUCTURED_EXT_TOML.has(ext);
  const is_lock = _STRUCTURED_EXT_LOCK.has(ext);
  const is_css = _STRUCTURED_EXT_CSS.has(ext);
  const is_sql = _STRUCTURED_EXT_SQL.has(ext);
  const is_graphql = _STRUCTURED_EXT_GRAPHQL.has(ext);
  const is_proto = _STRUCTURED_EXT_PROTO.has(ext);
  const is_env = _STRUCTURED_BASENAME_ENV.has(basename_lower);
  const is_makefile = _STRUCTURED_BASENAME_MAKEFILE.has(basename_lower);

  if (
    !(
      is_tabular ||
      is_json ||
      is_log ||
      is_xml ||
      is_yaml ||
      is_toml ||
      is_lock ||
      is_css ||
      is_sql ||
      is_graphql ||
      is_proto ||
      is_env ||
      is_makefile
    )
  ) {
    return null;
  }

  // Cheap size check first.
  let file_size: number;
  try {
    file_size = fs.statSync(file_path).size;
  } catch {
    return null;
  }

  // New file types use per-category thresholds.
  if (is_css && file_size < _STRUCTURED_CSS_MIN_BYTES) {
    return null;
  }
  if (is_sql && file_size < _STRUCTURED_SQL_MIN_BYTES) {
    return null;
  }
  if (is_graphql && file_size < _STRUCTURED_GRAPHQL_MIN_BYTES) {
    return null;
  }
  if (is_proto && file_size < _STRUCTURED_PROTO_MIN_BYTES) {
    return null;
  }
  if (is_env && file_size < _STRUCTURED_ENV_MIN_BYTES) {
    return null;
  }
  if (is_makefile && file_size < _STRUCTURED_MAKEFILE_MIN_BYTES) {
    return null;
  }

  // For the legacy types, apply the original global threshold.
  if (
    (is_tabular || is_json || is_log || is_xml || is_yaml || is_toml || is_lock) &&
    file_size < _STRUCTURED_FILE_MIN_BYTES
  ) {
    return null;
  }

  const size_kb = Math.trunc(file_size / 1024);
  const safe_path = _sanitize_hint_path(file_path);

  if (is_tabular) {
    const row_count = _estimate_row_count(file_path, file_size);
    const row_str = row_count > 0 ? `~${_comma(row_count)}rows` : "many rows";
    let hint_text = `📊 large ${ext} (${size_kb}KB, ${row_str}) — `;

    // Add schema for CSV.
    if (ext === ".csv") {
      const headers = _extract_csv_headers(file_path);
      if (headers) {
        hint_text += `columns: ${headers}. `;
      }
    } else if (ext === ".jsonl" || ext === ".ndjson") {
      const schema = _extract_ndjson_first_line_schema(file_path);
      if (schema) {
        hint_text += `schema: ${schema}. `;
      }
    }

    hint_text += `use offset/limit or \`token-goat section "${safe_path}::row N"\``;
    return new ReadHint(_apply_terse(hint_text), 0);
  }

  if (is_json) {
    let hint_text = `📄 large json (${size_kb}KB) — `;
    const schema = _extract_json_array_schema(file_path);
    if (schema) {
      hint_text += `array schema: ${schema}. `;
    }
    hint_text += `use \`token-goat read "${safe_path}::Key.path"\` or jq`;
    return new ReadHint(_apply_terse(hint_text), 0);
  }

  if (is_log) {
    const row_count = _estimate_row_count(file_path, file_size);
    const row_str = row_count > 0 ? `~${_comma(row_count)}lines` : "many lines";
    return new ReadHint(
      _apply_terse(
        `📜 log (${size_kb}KB, ${row_str}) — use tail/head or grep instead of full Read`,
      ),
      0,
    );
  }

  if (is_xml) {
    return new ReadHint(
      _apply_terse(
        `📋 large xml (${size_kb}KB) — ` +
          `use \`token-goat section "${safe_path}::ElementName"\` or yq/xmllint`,
      ),
      0,
    );
  }

  if (is_yaml) {
    return new ReadHint(
      _apply_terse(
        `📋 large yaml (${size_kb}KB) — ` +
          `use \`token-goat section "${safe_path}::key"\` or yq`,
      ),
      0,
    );
  }

  if (is_toml) {
    return new ReadHint(
      _apply_terse(
        `📋 large toml (${size_kb}KB) — ` +
          `use \`token-goat section "${safe_path}::section"\` to read one block`,
      ),
      0,
    );
  }

  // New structured types: look up the real top-of-file symbol from the index.
  let top: [string, string] | null;
  if (is_css || is_sql || is_graphql || is_proto || is_env || is_makefile) {
    top = _lookup_top_indexed_symbol(file_path);
  } else {
    top = null;
  }

  if (is_css) {
    const css_kind = ext.replace(/^\./, ""); // "css", "scss", or "sass"
    const clause = _structured_read_or_outline(top, safe_path, "a rule", "rules", {
      fallback_cmd: "section",
    });
    return new ReadHint(_apply_terse(`🎨 large ${css_kind} (${size_kb}KB) — ${clause}`), 0);
  }

  if (is_sql) {
    const clause = _structured_read_or_outline(
      top,
      safe_path,
      "one table/procedure",
      "tables/procedures",
      { fallback_cmd: "section" },
    );
    return new ReadHint(_apply_terse(`🗄️ large sql (${size_kb}KB) — ${clause}`), 0);
  }

  if (is_graphql) {
    const clause = _structured_read_or_outline(top, safe_path, "one type", "types");
    return new ReadHint(_apply_terse(`📐 large graphql (${size_kb}KB) — ${clause}`), 0);
  }

  if (is_proto) {
    const clause = _structured_read_or_outline(
      top,
      safe_path,
      "one message/service",
      "messages/services",
    );
    return new ReadHint(_apply_terse(`📦 large proto (${size_kb}KB) — ${clause}`), 0);
  }

  if (is_env) {
    const sz = size_kb > 0 ? `${size_kb}` : "<1";
    let clause: string;
    if (top !== null) {
      const [rel, sym] = top;
      clause =
        `use \`token-goat read "${rel}::${sym}"\` for one variable ` +
        `or grep/rg for the key you need`;
    } else {
      clause =
        `use \`token-goat outline "${safe_path}"\` to list variables ` +
        `or grep/rg for the key you need`;
    }
    return new ReadHint(_apply_terse(`🔑 env file (${sz}KB) — ${clause}`), 0);
  }

  if (is_makefile) {
    const row_count = _estimate_row_count(file_path, file_size);
    const row_str = row_count > 0 ? `~${_comma(row_count)}lines` : "many lines";
    const sz = size_kb > 0 ? `${size_kb}` : "<1";
    let clause: string;
    if (top !== null) {
      const [rel, sym] = top;
      clause =
        `use \`token-goat read "${rel}::${sym}"\` for one target ` +
        `or \`token-goat outline "${safe_path}"\` to list all`;
    } else {
      clause = `use \`token-goat outline "${safe_path}"\` to list targets, then read one`;
    }
    return new ReadHint(_apply_terse(`⚙️ Makefile (${sz}KB, ${row_str}) — ${clause}`), 0);
  }

  // is_lock
  const row_count = _estimate_row_count(file_path, file_size);
  const row_str = row_count > 0 ? `~${_comma(row_count)}lines` : "many lines";
  return new ReadHint(
    _apply_terse(
      `🔒 lock file (${size_kb}KB, ${row_str}) — ` +
        `use grep/rg for specific package rather than full Read`,
    ),
    0,
  );
}

// ---------------------------------------------------------------------------
// Test-file implementation-hint
// ---------------------------------------------------------------------------

/**
 * Resolve the likely implementation file path from a test file path. Only
 * returns the path if the file actually exists. (Python _resolve_impl_file_from_test.)
 */
function _resolve_impl_file_from_test(test_file_path: string, project_root: string): string | null {
  try {
    const basename = path.basename(test_file_path);

    // Only handle test_* files.
    if (!basename.startsWith("test_")) {
      return null;
    }

    // Strip test_ prefix.
    const impl_basename = basename.slice(5);
    if (!impl_basename) {
      return null;
    }

    // Try src/token_goat/impl_basename path.
    const impl_rel = path.join(project_root, "src", "token_goat", impl_basename);
    if (_isFile(impl_rel)) {
      return impl_rel;
    }

    return null;
  } catch {
    return null;
  }
}

/**
 * Return a HintItem when reading a test file with unread implementation. Returns
 * a LOW-priority hint, or null. (Python build_test_file_hint.)
 */
export function build_test_file_hint(
  test_file_path: string,
  session_cache: SessionCache | null,
  project_root: string,
): HintItem | null {
  if (session_cache === null) {
    return null;
  }

  // Check if this looks like a test file by checking the filename.
  const basename = path.basename(test_file_path);
  const test_path_lower = test_file_path.toLowerCase();
  const is_test_file =
    basename.toLowerCase().startsWith("test_") ||
    test_path_lower.includes("tests/") ||
    test_path_lower.includes("tests\\");

  if (!is_test_file) {
    return null;
  }

  // Try to resolve the implementation file.
  const impl_file = _resolve_impl_file_from_test(test_file_path, project_root);
  if (impl_file === null) {
    return null;
  }

  // Check if the impl file has been read this session (same normalization).
  const impl_file_str = impl_file;
  const normalized_impl_path = paths.normalizeKey(impl_file_str);

  const files_dict = session_cache.files;
  if (files_dict && typeof files_dict === "object" && normalized_impl_path in files_dict) {
    // Already read; no hint needed.
    return null;
  }

  // Build the hint.
  const fname = _sanitize_hint_path(path.basename(test_file_path));
  const impl_name = _sanitize_hint_path(path.basename(impl_file));
  const impl_rel = _sanitize_hint_path(impl_file);

  const text =
    `Reading test file \`${fname}\`. Implementation \`${impl_name}\` not yet read this session. ` +
    `Consider reading \`${impl_rel}\` first for context.`;

  return new HintItem(text, HINT_PRIORITY_LOW);
}

/**
 * Return a CRITICAL hint when *symbol_name* in *file_path* matches a pinned spec.
 * Returns null when there are no pinned symbols or no pin matches. (Python
 * build_pinned_hint.)
 */
export function build_pinned_hint(
  session_cache: SessionCache | null,
  file_path: string,
  symbol_name: string,
): HintItem | null {
  if (session_cache === null || !symbol_name) {
    return null;
  }

  const pinned: string[] = session_cache.pinned_symbols ?? [];
  if (pinned.length === 0) {
    return null;
  }

  // Normalise the file path so comparisons are drive-letter and separator safe.
  const norm_file = paths.normalizeKey(file_path);

  for (const spec of pinned) {
    if (!spec.includes("::")) {
      continue;
    }
    const sep = spec.indexOf("::");
    const spec_file = spec.slice(0, sep);
    const spec_sym = spec.slice(sep + 2);
    if (paths.normalizeKey(spec_file) === norm_file && spec_sym === symbol_name) {
      const text = `Pinned: \`${spec}\` — always prioritized.`;
      return new HintItem(text, HINT_PRIORITY_CRITICAL);
    }
  }

  return null;
}

// ---------------------------------------------------------------------------
// Stable-doc compact hints
// ---------------------------------------------------------------------------

// Minimum file size (bytes) before section-map / compact hints fire.
const _DOC_COMPACT_MIN_BYTES = 5_000;
// Minimum indexed section count before section-map hints fire.
const _DOC_COMPACT_MIN_SECTIONS = 5;
// Maximum heading entries shown inline in section-map / compact hints.
const _DOC_COMPACT_SECTION_MAP_MAX = 10;

// Sentinel prefix: hooks_read detects this to deny the read and serve the compact.
export const DOC_COMPACT_SERVE_SENTINEL = "\x00doc-compact-serve\x00";

/**
 * Return a hint for a large reference doc: serve compact or suggest one. Never
 * raises. (Python build_doc_compact_hint.)
 */
export function build_doc_compact_hint(
  file_path: string,
  cwd: string | null,
  opts: { cache?: SessionCache | null } = {},
): ReadHint | null {
  try {
    return _build_doc_compact_hint_inner(file_path, cwd, { cache: opts.cache ?? null });
  } catch (exc) {
    _LOG.debug("build_doc_compact_hint: unexpected error for %s: %s", JSON.stringify(file_path), exc);
    return null;
  }
}

/** Inner implementation. (Python _build_doc_compact_hint_inner.) */
function _build_doc_compact_hint_inner(
  file_path: string,
  cwd: string | null,
  _opts: { cache?: SessionCache | null } = {},
): ReadHint | null {
  // Config gate.
  try {
    if (!config.load().hints?.stable_doc_compacts) {
      return null;
    }
  } catch {
    // fall through (config unavailable)
  }

  // Only handle markdown files.
  const fp_lower = file_path.toLowerCase();
  if (!(fp_lower.endsWith(".md") || fp_lower.endsWith(".markdown"))) {
    return null;
  }

  // Resolve to absolute path.
  let abs_path: string;
  try {
    abs_path = file_path;
    if (!path.isAbsolute(abs_path) && cwd) {
      abs_path = path.resolve(cwd, file_path);
    }
    if (!fs.existsSync(abs_path)) {
      return null;
    }
  } catch {
    return null;
  }

  const cwd_path = validate_cwd(cwd, { caller: "build_doc_compact_hint" });
  if (cwd_path === null) {
    return null;
  }

  const project = find_project(cwd_path);
  if (project === null) {
    return null;
  }

  const rel = _relativeTo(abs_path, project.root);
  if (rel === null) {
    return null;
  }

  const fname = _sanitize_hint_path(path.basename(abs_path));
  const recall_path = _sanitize_hint_path(rel);

  const compact_p = doc_compact.find_compact_for_path(abs_path, project.hash);

  if (compact_p !== null) {
    const header = doc_compact.read_compact_header(compact_p);
    if (header !== null && header[0] === "STALE") {
      return new ReadHint(
        _apply_terse(
          `doc-compact: compact for \`${fname}\` is stale (source was edited). ` +
            `Run \`token-goat compact-doc "${recall_path}"\` to refresh.`,
        ),
        0,
      );
    }

    if (doc_compact.is_compact_fresh(compact_p, abs_path)) {
      const body = doc_compact.read_compact_body(compact_p);
      if (body) {
        const headings = doc_compact.get_section_headings(rel, project.hash, {
          limit: _DOC_COMPACT_SECTION_MAP_MAX,
        });
        let full_tokens: number;
        let compact_tokens: number;
        let pct: number;
        try {
          const file_bytes = fs.statSync(abs_path).size;
          const compact_bytes = fs.statSync(compact_p).size;
          full_tokens = Math.max(1, Math.trunc(file_bytes / 4));
          compact_tokens = Math.trunc(compact_bytes / 4);
          pct = Math.trunc(100 - (compact_tokens * 100) / full_tokens);
        } catch {
          full_tokens = 0;
          compact_tokens = 0;
          pct = 0;
        }
        const section_line = _format_section_map(headings);
        const size_note =
          full_tokens > 0
            ? `~${compact_tokens} tokens, ${pct}% smaller than full file`
            : "compact";
        const hint_lines: string[] = [
          `doc-compact: serving compact for \`${fname}\` (${size_note}).`,
        ];
        if (section_line) {
          hint_lines.push(`  Sections: ${section_line}`);
        }
        hint_lines.push(`  Full content: \`token-goat read "${recall_path}"\` to bypass.`);
        hint_lines.push("");
        hint_lines.push(body.replace(/\s+$/, ""));
        const serve_text = DOC_COMPACT_SERVE_SENTINEL + hint_lines.join("\n");
        const tokens_saved = Math.max(0, full_tokens - compact_tokens);
        return new ReadHint(serve_text, tokens_saved);
      }
    }
  }

  // No compact: if large markdown with sections, emit section-map hint.
  let stat_size: number;
  try {
    stat_size = fs.statSync(abs_path).size;
  } catch {
    return null;
  }

  if (stat_size < _DOC_COMPACT_MIN_BYTES) {
    return null;
  }

  const headings = doc_compact.get_section_headings(rel, project.hash, {
    limit: _DOC_COMPACT_SECTION_MAP_MAX,
  });
  if (headings.length < _DOC_COMPACT_MIN_SECTIONS) {
    return null;
  }

  const full_tokens = Math.trunc(stat_size / 4);
  const compact_est = Math.trunc(full_tokens / 10);
  const section_line = _format_section_map(headings);
  const hint_text =
    `doc-compact: \`${fname}\` has ${headings.length} sections (~${full_tokens} tokens). ` +
    `Sections: ${section_line}. ` +
    `Use \`token-goat section "${recall_path}::Heading"\` for targeted reads. ` +
    `Run \`token-goat compact-doc "${recall_path}"\` for a reusable compact ` +
    `(~${compact_est} tokens on future reads).`;
  return new ReadHint(_apply_terse(hint_text), 0);
}

/** Format a list of headings as a compact inline string. (Python _format_section_map.) */
function _format_section_map(headings: string[], max_items = 8): string {
  if (headings.length === 0) {
    return "";
  }
  const preview: string[] = [];
  for (const h of headings.slice(0, max_items)) {
    preview.push(h.startsWith("#") ? h : `## ${h}`);
  }
  const overflow = headings.length - preview.length;
  let result = preview.join(" · ");
  if (overflow > 0) {
    result += ` [+${overflow} more]`;
  }
  return result;
}

/**
 * Build a hint suggesting the scoped form of git diff when the unscoped diff is
 * large. (Python build_scoped_diff_hint.)
 */
export function build_scoped_diff_hint(output_bytes: number, edited_files: string[]): string {
  const kb = output_bytes / 1024;
  const shown = edited_files.slice(0, 5);
  const overflow = edited_files.length - shown.length;
  const file_args = shown.join(" ");
  const n = edited_files.length;
  const cmd_line = `  git diff -- ${file_args}`;
  const overflow_note =
    overflow > 0 ? `\n  (and ${overflow} more session-edited file(s) not listed)` : "";
  return (
    `[token-goat] Large diff (${kb.toFixed(1)} KB). ` +
    `You've edited ${n} file(s) this session — scope it next time:\n` +
    `${cmd_line}${overflow_note}`
  );
}

/**
 * Return a one-shot advisory hint when a file has been grepped ≥3 times this
 * session. Returns the hint string exactly when the count crosses the threshold
 * (2 → 3); null otherwise. (Python maybe_grep_advisory.)
 */
export function maybe_grep_advisory(
  pathArg: string,
  session_cache: SessionCache,
  cwd: string | null = null,
): string | null {
  try {
    if (!pathArg || pathArg === "-") {
      return null;
    }
    if (!_isFile(pathArg)) {
      return null;
    }
    const crossed = session_cache.record_grep_target(pathArg, cwd);
    if (!crossed) {
      return null;
    }
    const safe_path = _sanitize_hint_path(pathArg);
    return (
      `[token-goat] You've grepped '${safe_path}' 3× this session. ` +
      `Consider reading it once with \`token-goat read "${safe_path}"\` or using ` +
      `\`token-goat bash-output <id> --grep <pat>\` to filter cached output.`
    );
  } catch {
    return null; // fail-soft; hint errors must never block the agent
  }
}
