/**
 * Pre- and post-read hook handlers.
 *
 * Faithful port of src/token_goat/hooks_read.py (7891 LOC, ~98 functions) — the
 * largest single module in token-goat. One cohesive module: the four public
 * entrypoints (pre_read / post_read / post_bash / pre_screenshot) plus ~90
 * internal _handle_* / _try_* / _build_* helpers that share module-level state
 * (_call_index, _session_module). The hook dispatcher (hooks_cli._resolve_handler)
 * imports this module via `import("./hooks_read.js")` and reads the four attrs.
 *
 * --------------------------------------------------------------------------
 * SELF-NAMESPACE (ESM live-binding = Python's mock.patch):
 * --------------------------------------------------------------------------
 * Tests vi.spyOn the internal _handle_* helpers. A direct local _handle_x() call
 * bypasses the spy (ESM module-internal references are NOT live-rebound by
 * vi.spyOn). So the entrypoints (and helpers that call other helpers a test may
 * spy on) call them through `import * as self from "./hooks_read.js"` →
 * `self._handle_x(...)`. This is the exact analogue of Python re-entering the
 * module namespace so mock.patch("...hooks_read._handle_x") intercepts.
 *
 * --------------------------------------------------------------------------
 * DEPENDENCY CONTRACT (Python lazy "from . import X" -> TS top-level static import):
 * --------------------------------------------------------------------------
 * STATIC IMPORTS (all PORTED): hooks_common, util, bash_compress, doc_compact,
 * notebook_compact, read_replacement, hints, session, db, config, project,
 * paths, snapshots, cache_common, entropy, git_history, overflow_guard,
 * bash_cache, bash_parser, bash_detect, code_compress. These share the module
 * cache exactly like Python's lazy import, so test spies observe them.
 *
 * FAIL-SOFT SEAMS: image_shrink and skill_cache are now ported and default to
 * their real modules. Still unported (Layer 6/7): worker, repomap, index_store,
 * render, and compact.get_context_pressure (compact
 * is ported but currently exports nothing). Each is a module-level `let` + a
 * _setXModule setter registered with reset.ts; the dependent handler degrades to
 * null/continue/no-op when the seam is absent. See the seam declarations below
 * and the notes for which handlers degrade on which seam.
 *
 * post_bash additionally references a cluster of bash_compress filter helpers
 * (_sleep_cmd_type, _is_pkg_install_cmd, _is_junit_xml_output, compress_jest_output,
 * …) that are part of the Run-9 bash_compress finale and NOT YET EXPORTED from
 * bash_compress.ts. Those are reached through the `bash_compress` namespace inside
 * each block's try/catch: when absent the lookup yields undefined, the "not a
 * function" guard (or the throw on calling undefined) lands in the fail-soft
 * catch, and the block no-ops and falls through — the faithful analogue of
 * Python's `from .bash_compress import _xxx` raising ImportError inside the
 * surrounding try/except. When those helpers land, the blocks activate with no
 * further change here. See _bcFn() below.
 *
 * Parity notes (Python → TS):
 *  - Module-global mutable state (_call_index, _session_module) → module-level
 *    `let`s + a registerReset so the per-test wipe (tests/setup.ts) returns them
 *    to their freshly-imported baseline ("each fresh Python process starts fresh").
 *  - Python's `_LOG.exception(...)` / `exc_info=True` map to `_LOG.error(...)` /
 *    dropping the kwarg — the TS Logger has no `.exception` method (matches the
 *    rest of the port).
 *  - DB reads: Python `with db.open_project_readonly(h) as conn: conn.execute(sql,
 *    params).fetchall()` → `db.openProjectReadonly(h, (conn) => conn.prepare(sql)
 *    .all(...params))` (better-sqlite3 returns rows as objects keyed by column
 *    name). Python f"{row['line']:4d}" right-justify → padStart on a String.
 *  - byte math is UTF-8 via util.utf8Bytes (Buffer), never String.length.
 *  - subprocess (token-goat map --compact, git rev-parse, compact-doc spawn) uses
 *    node:child_process; Popen fire-and-forget → spawn(...).unref(); run(...)
 *    capture → spawnSync.
 *  - session._MAX_RESULT_COUNT is module-private in session.ts; inlined here as
 *    the verbatim value (1_000_000) with a comment.
 *
 * `verbatimModuleSyntax` is on → type-only imports use `import type`.
 * `exactOptionalPropertyTypes` is on → optional fields are `T | undefined`.
 * `noUncheckedIndexedAccess` is on → indexed access is narrowed before use.
 */

import * as childProcess from "node:child_process";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as nodePath from "node:path";

import * as self from "./hooks_read.js";

import {
  CONTINUE,
  deny_redirect,
  emit_if_new_hint,
  extract_tool_response_text,
  get_hook_context,
  get_session_context,
  get_tool_input,
  is_real_int,
  load_session_safe,
  pre_tool_use_with_context,
  pre_tool_use_with_update,
  record_cached_stat,
  record_hint_stat_pair,
  run_dedup_hint,
  sanitize_log_str,
  sanitize_opt,
  validate_cwd,
  LOG as _LOG,
} from "./hooks_common.js";
import type { HookPayload, HookResponse } from "./types.js";

import { envInt as _env_int, sanitizeSurrogates as _sanitize_surrogates, utf8Bytes as _utf8_bytes } from "./util.js";
import { registerReset } from "./reset.js";

import * as config from "./config.js";
import * as db from "./db.js";
import * as session from "./session.js";
import * as paths from "./paths.js";
import * as project from "./project.js";
import * as snapshots from "./snapshots.js";
import * as git_history from "./git_history.js";
import * as read_replacement from "./read_replacement.js";
import * as hints from "./hints.js";
import * as bash_parser from "./bash_parser.js";
import * as bash_detect from "./bash_detect.js";
import * as bash_cache from "./bash_cache.js";
import * as bash_compress from "./bash_compress.js";
import * as notebook_compact from "./notebook_compact.js";
import * as code_compress from "./code_compress.js";
import * as cache_common from "./cache_common.js";
import * as image_shrink from "./image_shrink.js";
import * as skill_cache from "./skill_cache.js";

import type { SessionCache } from "./session.js";
import type { ImageStats, ImageSummaryInput } from "./image_shrink.js";

// Re-export the typed shapes so callers that imported them from hooks_read in
// Python (`from .hooks_read import HookPayload`) port one-for-one.
export type { HookPayload, HookResponse } from "./types.js";

/**
 * Mirror of the Python module's `__all__`. Kept as a runtime array so a test
 * asserting membership ports one-for-one.
 */
export const __all__ = ["post_bash", "post_read", "pre_read", "_safe_split_argv"] as const;

// ---------------------------------------------------------------------------
// Fail-soft injection seams (Layer 6/7 deps NOT yet ported).
// Each is a module-level `let` + a _setXModule setter registered with reset.ts.
// The dependent handler degrades to null/continue/no-op when the seam is absent
// (the exact analogue of Python's lazy-import-in-try-except).
// ---------------------------------------------------------------------------

/**
 * image_shrink shape used by _try_shrink_image (the only consumer). The real
 * module is async (sharp/libvips) and string-path based — `shrink` and
 * `stats_for` return Promises, and `_cache_path_for` returns a string path.
 * _try_shrink_image awaits accordingly. Matches the real image_shrink exports.
 */
interface ImageShrinkModule {
  is_image_path(file_path: string): boolean;
  format_threshold(p: string): number;
  shrink(src: string): Promise<string | null>;
  extract_image_summary(src: string, img: ImageSummaryInput): string;
  _cache_path_for(src: string): string;
  stats_for(src: string, shrunken: string): Promise<ImageStats>;
  vision_tokens(w: number, h: number): number;
}

/** skill_cache shape used by _emit_stale_compact_hint (the only consumer). */
interface SkillCacheModule {
  get_compact(session_id: string, skill_name: string): string | null;
  extract_compact_source_sha(compact_text: string): string | null;
}

// image_shrink and skill_cache are both ported, so each seam defaults to its real
// module. reset.ts restores those real defaults (a test that does not touch a seam
// gets real behavior; one that calls _setXModule(null) still exercises the no-op
// path).
const _imageShrinkDefault: ImageShrinkModule = image_shrink;
const _skillCacheDefault: SkillCacheModule = skill_cache;

let _imageShrinkMod: ImageShrinkModule | null = _imageShrinkDefault;
let _skillCacheMod: SkillCacheModule | null = _skillCacheDefault;

/**
 * Test/loader seam: install the image_shrink module. Pass null to force the
 * no-op (degrade to passthrough) path; reset.ts restores the real default.
 */
export function _setImageShrinkModule(m: ImageShrinkModule | null): void {
  _imageShrinkMod = m;
}

/**
 * Test/loader seam: install the skill_cache module (Layer 6). Pass null to force
 * the no-op (degrade to passthrough) path; reset.ts restores the real default.
 */
export function _setSkillCacheModule(m: SkillCacheModule | null): void {
  _skillCacheMod = m;
}

/**
 * compact.get_context_pressure seam. compact.ts is ported but currently EXPORTS
 * NOTHING, so the context-pressure tier is reached through this injection point.
 * Returns an object with `.tier` (and `.fill_fraction` for the pre_read path).
 * Absent → callers default to tier "cool", fill 0.0.
 */
type ContextPressure = { tier: string; fill_fraction: number };
type GetContextPressureFn = (session_id: string, opts?: { cache?: unknown }) => ContextPressure;

let _getContextPressure: GetContextPressureFn | null = null;

/** Test/loader seam: install compact.get_context_pressure. Pass null to clear. */
export function _setGetContextPressure(fn: GetContextPressureFn | null): void {
  _getContextPressure = fn;
}

registerReset(() => {
  // Restore the real-module defaults for image_shrink and skill_cache.
  _imageShrinkMod = _imageShrinkDefault;
  _skillCacheMod = _skillCacheDefault;
  _getContextPressure = null;
  _call_index = 0;
  _session_module = null;
});

// ---------------------------------------------------------------------------
// Module-level constants and state.
// ---------------------------------------------------------------------------

// Environment variable that disables Bash output compression at the hook layer.
const _ENV_BASH_COMPRESS = "TOKEN_GOAT_BASH_COMPRESS";

// Monotonically increasing counter incremented at the top of pre_read on every tool call.
let _call_index = 0;

// File extensions that are known to be binary (non-text) content.
const _BINARY_EXTENSIONS: ReadonlySet<string> = new Set<string>([
  // Archives
  ".zip", ".tar", ".gz", ".bz2", ".xz", ".7z", ".rar", ".zst", ".lz4",
  // Compiled / object code
  ".so", ".dylib", ".dll", ".exe", ".pyd", ".pyc", ".pyo", ".o", ".a",
  ".lib", ".obj", ".wasm",
  // Databases / binary blobs
  ".db", ".sqlite", ".sqlite3", ".parquet", ".feather", ".npy", ".npz",
  ".arrow", ".pb", ".bin", ".dat",
  // Media (non-image)
  ".mp3", ".mp4", ".wav", ".ogg", ".flac", ".aac", ".m4a",
  ".avi", ".mov", ".mkv", ".webm",
  // Fonts
  ".ttf", ".otf", ".woff", ".woff2", ".eot",
  // PDF / office
  ".pdf", ".docx", ".xlsx", ".pptx", ".odt",
  // Misc
  ".class", ".jar", ".war",
]);

// Files larger than this threshold (in bytes) are skipped for pre-read hints.
const _LARGE_FILE_HINT_SKIP_BYTES = 10 * 1024 * 1024; // 10 MB

// Image extensions not covered by _BINARY_EXTENSIONS (those go via the shrink path).
const _IMAGE_EXTENSIONS: ReadonlySet<string> = new Set<string>([
  ".png", ".jpg", ".jpeg", ".gif", ".ico", ".bmp", ".svg", ".webp", ".tiff", ".tif",
]);
// Combined skip set for truncated-read advisory hints (binary + image).
const _TRUNCATED_HINT_SKIP_EXTS: ReadonlySet<string> = new Set<string>([
  ..._BINARY_EXTENSIONS,
  ..._IMAGE_EXTENSIONS,
]);

// Regex patterns to detect Claude Code partial-read sentinels in tool result text.
const _PARTIAL_READ_RE_HYPHEN = /lines?\s+(\d+)\s*[-–]\s*(\d+)\s+of\s+(\d+)/i;
const _PARTIAL_READ_RE_TO = /showing\s+lines?\s+(\d+)\s+to\s+(\d+)\s+of\s+(\d+)/i;

// mirrors session.py _MAX_RESULT_COUNT (module-private there). Same value.
const _SESSION_MAX_RESULT_COUNT = 1_000_000;

// ---------------------------------------------------------------------------
// Internal Node-stdlib bridges (no Python analogue).
// ---------------------------------------------------------------------------

/** Lowercased file extension, dotted (Python pathlib.Path(p).suffix.lower()). */
function _suffixLower(file_path: string): string {
  return nodePath.extname(file_path).toLowerCase();
}

/** Basename of a path (Python pathlib.Path(p).name). */
function _basename(p: string): string {
  return nodePath.basename(p);
}

/** SHA-256 hex digest of a string (UTF-8) or Buffer. */
function _sha256Hex(data: string | Buffer): string {
  const h = crypto.createHash("sha256");
  h.update(typeof data === "string" ? Buffer.from(data, "utf8") : data);
  return h.digest("hex");
}

/** SHA-1 hex digest (usedforsecurity=False analogue — just a content fingerprint). */
function _sha1Hex(data: Buffer): string {
  const h = crypto.createHash("sha1");
  h.update(data);
  return h.digest("hex");
}

/** Read a file as bytes, or throw (callers catch). */
function _readBytes(p: string): Buffer {
  return fs.readFileSync(p);
}

/** True when *value* is a plain (non-array, non-null) object. */
function _isDict(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * Look up an optional helper on the bash_compress namespace (Run-9 finale
 * helpers that may not be exported yet). Returns the function or undefined.
 * post_bash blocks call this inside their try/catch; an absent helper makes the
 * block no-op (faithful analogue of Python `from .bash_compress import _x`
 * raising ImportError inside the surrounding try/except).
 */
function _bcFn(name: string): ((...args: never[]) => unknown) | undefined {
  const v = (bash_compress as unknown as Record<string, unknown>)[name];
  return typeof v === "function" ? (v as (...args: never[]) => unknown) : undefined;
}

/** Look up an optional regex const on the bash_compress namespace. */
function _bcRe(name: string): RegExp | undefined {
  const v = (bash_compress as unknown as Record<string, unknown>)[name];
  return v instanceof RegExp ? v : undefined;
}

// ===========================================================================
// pre-read helpers — Bash command synthesis + compression
// ===========================================================================

/**
 * Split a shell command string into an argv list, safely handling metacharacters.
 *
 * Python uses shlex.split(posix=True); on ValueError it falls back to a simple
 * whitespace split. bash_parser already exposes a faithful POSIX tokeniser; we
 * reuse the whitespace split as the fallback. Returns [] for empty input.
 */
export function _safe_split_argv(cmd: string): string[] {
  if (!cmd || !cmd.trim()) {
    return [];
  }
  try {
    return _posixSplit(cmd);
  } catch {
    return cmd.split(/\s+/).filter((t) => t.length > 0);
  }
}

/**
 * POSIX shell tokeniser (the analogue of Python shlex.split(s, posix=True)).
 * Throws on unbalanced quotes (mirrors shlex's ValueError) so callers can fall
 * back to a whitespace split. Strips one level of quoting and backslash escapes.
 */
function _posixSplit(s: string): string[] {
  const tokens: string[] = [];
  let cur = "";
  let hasToken = false;
  let i = 0;
  const n = s.length;
  while (i < n) {
    const ch = s[i] as string;
    if (ch === " " || ch === "\t" || ch === "\n" || ch === "\r" || ch === "\f" || ch === "\v") {
      if (hasToken) {
        tokens.push(cur);
        cur = "";
        hasToken = false;
      }
      i += 1;
      continue;
    }
    if (ch === "'") {
      hasToken = true;
      i += 1;
      let closed = false;
      while (i < n) {
        if (s[i] === "'") {
          closed = true;
          i += 1;
          break;
        }
        cur += s[i];
        i += 1;
      }
      if (!closed) {
        throw new Error("No closing quotation");
      }
      continue;
    }
    if (ch === '"') {
      hasToken = true;
      i += 1;
      let closed = false;
      while (i < n) {
        const c = s[i] as string;
        if (c === '"') {
          closed = true;
          i += 1;
          break;
        }
        if (c === "\\" && i + 1 < n) {
          const nxt = s[i + 1] as string;
          // In a double-quoted string, backslash escapes only $ ` " \ and newline.
          if (nxt === "$" || nxt === "`" || nxt === '"' || nxt === "\\") {
            cur += nxt;
            i += 2;
            continue;
          }
          cur += c;
          i += 1;
          continue;
        }
        cur += c;
        i += 1;
      }
      if (!closed) {
        throw new Error("No closing quotation");
      }
      continue;
    }
    if (ch === "\\") {
      hasToken = true;
      if (i + 1 < n) {
        cur += s[i + 1];
        i += 2;
      } else {
        // trailing backslash — shlex raises in posix mode.
        throw new Error("No escaped character");
      }
      continue;
    }
    hasToken = true;
    cur += ch;
    i += 1;
  }
  if (hasToken) {
    tokens.push(cur);
  }
  return tokens;
}

/**
 * Non-POSIX shell tokeniser (the analogue of Python shlex.split(s, posix=False)).
 * Preserves Windows backslashes and keeps quote characters inside tokens.
 * Throws on unbalanced quotes (mirrors shlex's ValueError).
 */
function _nonPosixSplit(s: string): string[] {
  const tokens: string[] = [];
  let cur = "";
  let hasToken = false;
  let i = 0;
  const n = s.length;
  while (i < n) {
    const ch = s[i] as string;
    if (ch === " " || ch === "\t" || ch === "\n" || ch === "\r" || ch === "\f" || ch === "\v") {
      if (hasToken) {
        tokens.push(cur);
        cur = "";
        hasToken = false;
      }
      i += 1;
      continue;
    }
    if (ch === "'" || ch === '"') {
      const quote = ch;
      hasToken = true;
      cur += ch;
      i += 1;
      let closed = false;
      while (i < n) {
        const c = s[i] as string;
        cur += c;
        i += 1;
        if (c === quote) {
          closed = true;
          break;
        }
      }
      if (!closed) {
        throw new Error("No closing quotation");
      }
      continue;
    }
    hasToken = true;
    cur += ch;
    i += 1;
  }
  if (hasToken) {
    tokens.push(cur);
  }
  return tokens;
}

/** Return True when hints should be skipped for *file_path* (binary ext or >10 MB). */
export function _is_binary_or_large_file(file_path: string): boolean {
  const ext = _suffixLower(file_path);
  if (_BINARY_EXTENSIONS.has(ext)) {
    return true;
  }
  try {
    const size = fs.statSync(file_path).size;
    return size >= _LARGE_FILE_HINT_SKIP_BYTES;
  } catch {
    return false;
  }
}

/** Return False when the user has explicitly disabled bash output compression. */
export function _bash_compress_enabled(): boolean {
  const val = (process.env[_ENV_BASH_COMPRESS] ?? "").trim().toLowerCase();
  return !["0", "false", "no", "off"].includes(val);
}

/** Resolve the effective compression profile for the given harness. */
function _resolve_compression_profile(harness: string, config_profile: string): string {
  if (config_profile !== "auto") {
    return config_profile;
  }
  return harness === "gemini" ? "minimal" : "balanced";
}

// Binaries that still have handler-specific logic and must NOT be short-circuited.
const _BASH_FAST_PATH_EXCLUDE: ReadonlySet<string> = new Set<string>(["which", "where"]);

/** Rewrite compressible Bash commands to flow through `token-goat compress`. */
export function _handle_bash_compress(payload: HookPayload): HookResponse | null {
  if (!_bash_compress_enabled()) {
    return null;
  }

  const cfg_obj = config.load();
  const cfg = cfg_obj.bash_compress;
  // config.load() always populates bash_compress (the loader fills defaults);
  // the optional ConfigSchema typing forces an explicit guard here.
  if (cfg === undefined || !cfg.enabled) {
    return null;
  }
  const disabled_filters = cfg.disabled_filters ?? [];
  const timeout_seconds = cfg.timeout_seconds ?? 30;

  const tool_input = get_tool_input(payload);
  const cmd = tool_input["command"];
  if (typeof cmd !== "string" || !cmd.trim()) {
    return null;
  }
  // Avoid recursive wrapping.
  const stripped = cmd.replace(/^\s+/, "");
  if (
    stripped.startsWith("token-goat") ||
    stripped.startsWith("token_goat") ||
    stripped.includes("token_goat.cli")
  ) {
    return null;
  }

  // Fast pre-check via static binary lookup before the full bash_compress import.
  const _splitWords = cmd.split(/\s+/).filter((t) => t.length > 0);
  const _first_word = _splitWords.length > 0 ? (_splitWords[0] as string) : "";
  if (!cmd.includes("&&") && !bash_detect.detect([_first_word])) {
    return null;
  }

  const harness = String(payload["_tg_harness"] ?? "claude");
  const effective_profile = _resolve_compression_profile(harness, cfg_obj.compression?.profile ?? "auto");

  // Resolve context-pressure tier to compute a pressure-scaled output token cap.
  let _bash_tier = "cool";
  const [_bash_session_id] = get_session_context(payload);
  if (_bash_session_id) {
    try {
      if (_getContextPressure !== null) {
        _bash_tier = _getContextPressure(_bash_session_id).tier;
      }
    } catch {
      // fail-soft; never block compress wrapping
    }
  }
  const _bash_max_tokens = _pressure_scaled_bash_cap(_BASH_COMPRESS_BASE_TOKENS, _bash_tier);

  const _mk_wrapper = (filter_name: string, seg: string): string | null => {
    if (disabled_filters.includes(filter_name)) {
      return null;
    }
    return paths.pythonRunnerCommand(
      "compress",
      "--filter",
      filter_name,
      "--timeout",
      String(timeout_seconds),
      "--profile",
      effective_profile,
      "--max-tokens",
      String(_bash_max_tokens),
      "--cmd",
      seg,
    );
  };

  const detected = bash_compress.detect_from_command(cmd);
  if (detected !== null) {
    const [filter_] = detected;
    if (disabled_filters.includes(filter_.name)) {
      _LOG.debug("bash_compress: filter %s disabled by config; skipping", filter_.name);
      return null;
    }
    const wrapper = _mk_wrapper(filter_.name, cmd);
    if (wrapper === null) {
      return null;
    }
    const rewritten_input: Record<string, unknown> = { ...tool_input };
    rewritten_input["command"] = wrapper;
    _LOG.info(
      "bash_compress: wrapping command with %s filter profile=%s (orig=%s)",
      filter_.name,
      effective_profile,
      sanitize_log_str(cmd, 200),
    );
    return pre_tool_use_with_update(
      rewritten_input,
      `Note: command auto-wrapped by token-goat (${filter_.name} filter) ` +
        "to compress its output before it lands in context. " +
        "Disable via TOKEN_GOAT_BASH_COMPRESS.",
    );
  }

  // Fallback: wrap each &&-segment independently.
  const rewritten_cmd = bash_compress.try_wrap_compound_segments(cmd, { wrapper_args: _mk_wrapper });
  if (rewritten_cmd === null) {
    return null;
  }
  const rewritten_input: Record<string, unknown> = { ...tool_input };
  rewritten_input["command"] = rewritten_cmd;
  _LOG.info(
    "bash_compress: compound-wrapped command profile=%s (orig=%s)",
    effective_profile,
    sanitize_log_str(cmd, 200),
  );
  return pre_tool_use_with_update(
    rewritten_input,
    "Note: compound command auto-wrapped by token-goat to compress each " +
      "stage's output before it lands in context. " +
      "Disable via TOKEN_GOAT_BASH_COMPRESS.",
  );
}

/** Convert Bash read-equivalent commands to a Read payload for recursive processing. */
export function _handle_bash_read_equivalent(payload: HookPayload): HookPayload | null {
  const tool_input = get_tool_input(payload);
  const cmd = (tool_input["command"] ?? "") as string;
  const intent = bash_parser.parse(typeof cmd === "string" ? cmd : "");
  if (intent.kind !== "read" || !intent.target_path) {
    if (intent.reason) {
      _LOG.info("bash read near-miss: %s", sanitize_log_str(intent.reason));
    }
    return null;
  }

  const read_payload: HookPayload = { ...payload };
  read_payload.tool_name = "Read";
  const raw_offset = intent.offset;
  const normalised_offset = raw_offset !== null ? raw_offset - 1 : null;
  read_payload.tool_input = {
    file_path: intent.target_path,
    offset: normalised_offset,
    limit: intent.limit,
  };
  if (intent.limit === null && intent.offset === null) {
    read_payload["_tg_from_bash_cat"] = true;
  }
  return read_payload;
}

/** Format bytes as KB or MB with one decimal place (local helper in _try_shrink_image). */
function _fmtBytesImg(nbytes: number): string {
  if (nbytes >= 1_000_000) {
    return `${(nbytes / 1_000_000).toFixed(1)} MB`;
  }
  if (nbytes >= 1_000) {
    return `${(nbytes / 1_000).toFixed(0)} KB`;
  }
  return `${nbytes} B`;
}

/**
 * Attempt image shrinking; degrades to null when image_shrink seam is absent.
 *
 * ASYNC because the real image_shrink module is async (sharp/libvips). The
 * dispatcher awaits handlers, and pre_read awaits this. Faithful to Python
 * _try_shrink_image (sync PIL there) but adapted to the async string-path API:
 * shrink()/stats_for() are awaited and the shrunken handle is a string path.
 */
export async function _try_shrink_image(
  file_path: string,
  tool_input: Record<string, unknown>,
): Promise<HookResponse | null> {
  const image_shrink = _imageShrinkMod;
  if (image_shrink === null) {
    return null; // seam not installed — degrade to no-op
  }

  if (!image_shrink.is_image_path(file_path)) {
    return null;
  }

  try {
    const src_path = file_path;
    try {
      const _src_stat = fs.statSync(src_path);
      if (_src_stat.size <= image_shrink.format_threshold(src_path)) {
        db.recordStat(undefined, "image_shrink_skipped", {
          bytesSaved: 0,
          tokensSaved: 0,
          detail: `${sanitize_log_str(file_path)} size=${_src_stat.size} threshold=${image_shrink.format_threshold(src_path)}`,
        });
        return null;
      }
    } catch (_exc) {
      _LOG.debug("image-shrink: pre-check failed for %s: %s", sanitize_log_str(file_path), String(_exc));
    }
    const shrunken = await image_shrink.shrink(src_path);
    if (shrunken === null || shrunken === undefined) {
      return null;
    }

    // Cache-hit detection: the shrunken path lives in the image cache dir and
    // shares the content-hash stem of _cache_path_for(src). The real module
    // returns string paths, so compare dir + base-without-extension (the Python
    // Path.parent / Path.stem comparison rendered for strings). Compute first so
    // the summary can reuse the shrunken dimensions below.
    let is_cache_hit = false;
    try {
      const stem = image_shrink._cache_path_for(src_path);
      const _stemDir = nodePath.dirname(stem);
      const _stemBase = _basename(stem).replace(/\.[^.]*$/, "");
      const _shrunkenDir = nodePath.dirname(shrunken);
      const _shrunkenBase = _basename(shrunken).replace(/\.[^.]*$/, "");
      if (_shrunkenDir === _stemDir && _shrunkenBase === _stemBase) {
        is_cache_hit = true;
      }
    } catch {
      _LOG.debug("image-shrink: cache-hit detection failed for %s", sanitize_log_str(file_path));
    }

    const img_stats = await image_shrink.stats_for(src_path, shrunken);

    // Python opens the shrunken file with PIL to pass an image handle to
    // extract_image_summary; Node has no in-proc PIL, but stats_for already
    // measured the shrunken dimensions, so feed those through as the summary
    // input (size-only). Fail-soft to "" so the redirect still fires.
    let img_summary = "";
    try {
      const _summaryInput: ImageSummaryInput = {
        size: [img_stats.out_width, img_stats.out_height] as const,
      };
      img_summary = image_shrink.extract_image_summary(src_path, _summaryInput);
    } catch {
      // fail-soft: empty summary on error so the redirect still fires.
    }

    const tokens_saved = Math.max(
      0,
      image_shrink.vision_tokens(img_stats.orig_width, img_stats.orig_height) -
        image_shrink.vision_tokens(img_stats.out_width, img_stats.out_height),
    );
    const stat_kind = is_cache_hit ? "image_shrink_cache_hit" : "image_shrink";
    const shrunkenName = _basename(shrunken);
    db.recordStat(undefined, stat_kind, {
      bytesSaved: img_stats.bytes_saved,
      tokensSaved: tokens_saved,
      detail: `${sanitize_log_str(file_path)} -> ${shrunkenName}`,
    });

    const shrink_response: Record<string, unknown> = { ...tool_input };
    shrink_response["file_path"] = shrunken;
    const _src_b = img_stats.src_bytes;
    const _out_b = img_stats.out_bytes;
    const _savings_pct = _src_b > 0 ? (100.0 * img_stats.bytes_saved) / _src_b : 0.0;

    const _size_str = `${_fmtBytesImg(_src_b)} → ${_fmtBytesImg(_out_b)} (saving ~${_savings_pct.toFixed(0)}%)`;
    let note = `Note: image auto-shrunk by token-goat (${_size_str}). Original: ${file_path}`;
    if (img_summary) {
      note = `${note}\n${img_summary}`;
    }
    return pre_tool_use_with_update(shrink_response, note);
  } catch (exc) {
    const excName = exc instanceof Error ? exc.constructor.name : "Error";
    _LOG.error("image-shrink failed during pre-read: %s", excName);
    return null;
  }
}

/** Persist a content snapshot for *file_path* so future diff hints can fire. */
export function _try_snapshot(session_id: string, file_path: string, opts?: { cache?: unknown }): void {
  const cache = opts?.cache;
  let data: Buffer;
  try {
    const fd = fs.openSync(file_path, "r");
    try {
      const buf = Buffer.alloc(snapshots.MAX_SNAPSHOT_BYTES + 1);
      const bytesRead = fs.readSync(fd, buf, 0, snapshots.MAX_SNAPSHOT_BYTES + 1, 0);
      data = buf.subarray(0, bytesRead);
    } finally {
      fs.closeSync(fd);
    }
  } catch (exc) {
    _LOG.debug("post-read snapshot: cannot read %s: %s", sanitize_log_str(file_path), String(exc));
    return;
  }
  if (data.length > snapshots.MAX_SNAPSHOT_BYTES) {
    _LOG.debug("post-read snapshot: skipping oversized file %s (%d bytes)", sanitize_log_str(file_path), data.length);
    return;
  }

  const result = snapshots.store(session_id, file_path, data);
  if (result === null) {
    return;
  }
  try {
    session.set_snapshot_sha(session_id, file_path, result.content_sha, { cache: (cache ?? null) as SessionCache | null });
  } catch (exc) {
    _LOG.debug("post-read snapshot: failed to persist SHA for %s: %s", sanitize_log_str(file_path), String(exc));
  }
}

/** Return a symbol-level suggestion when a line-range read maps to known symbols. */
export function _try_surgical_read_hint(
  file_path: string,
  offset: number,
  limit: number,
  cwd: string | null,
  opts?: { limit_is_sentinel?: boolean },
): string | null {
  const limit_is_sentinel = opts?.limit_is_sentinel ?? false;
  if (offset < 0 || limit <= 0) {
    return null;
  }
  const req_start = offset + 1;
  const req_end = offset + limit;
  try {
    const cwd_path = validate_cwd(cwd, { caller: "surgical-read-hint" });
    if (cwd_path === null) {
      return null;
    }
    const proj = project.find_project(cwd_path);
    if (proj === null) {
      return null;
    }

    const abs_path = nodePath.isAbsolute(file_path) ? file_path : nodePath.join(cwd_path, file_path);
    const file_rel = read_replacement.resolve_file_rel(proj, abs_path);
    if (!file_rel) {
      return null;
    }

    const rows = db.openProjectReadonly(proj.hash, (conn) =>
      conn
        .prepare(
          "SELECT name, kind FROM symbols " +
            "WHERE file_rel = ? AND line <= ? AND end_line >= ? AND end_line IS NOT NULL " +
            "ORDER BY line LIMIT 4",
        )
        .all(file_rel, req_end, req_start) as Array<{ name: string; kind: string }>,
    );

    if (rows.length === 0 || rows.length > 3) {
      return null;
    }

    const fname = _basename(file_rel);
    const sym_names = rows.map((row) => String(row.name));
    const sym_list = sym_names.map((nm) => `\`${nm}\``).join(", ");
    const primary = sym_names[0] as string;
    const cmd = `token-goat read "${file_rel}::${primary}"`;
    const range_str = limit_is_sentinel ? `Lines ${req_start}–EOF` : `Lines ${req_start}–${req_end}`;
    return (
      `${range_str} of \`${fname}\` span ${sym_list}. ` +
      `Use \`${cmd}\` for a surgical read (~90% fewer tok on repeat access).`
    );
  } catch (exc) {
    if (_isProjectDbNotFound(exc)) {
      return null;
    }
    _LOG.warning("surgical-read-hint: unexpected exception");
    return null;
  }
}

/** True for the "project db not found" Error openProjectReadonly throws. */
function _isProjectDbNotFound(exc: unknown): boolean {
  return exc instanceof Error && exc.message.startsWith("project db not found");
}

/** Return a compact git-history hint for *file_path*, or null on any failure. */
export function _build_git_hint(cwd: string | null, file_path: string): string | null {
  try {
    const _max_ms = config.load().hints?.git_hint_max_ms ?? 50;

    const cwd_path = validate_cwd(cwd, { caller: "pre-read-git-hint" });
    if (cwd_path === null) {
      return null;
    }
    const proj = project.find_project(cwd_path);
    if (proj === null) {
      return null;
    }
    let rel_path: string;
    try {
      const abs_file = nodePath.isAbsolute(file_path) ? file_path : nodePath.join(cwd_path, file_path);
      rel_path = _relativeToPosix(proj.root, abs_file);
    } catch {
      return null;
    }

    const _t0 = _monotonicMs();
    const result = git_history.build_hint(proj.hash, rel_path);
    const _elapsed_ms = _monotonicMs() - _t0;

    if (_max_ms > 0 && _elapsed_ms > _max_ms) {
      _LOG.debug(
        "git-history hint: skipped (%s ms > %d ms cap) for %s",
        _elapsed_ms.toFixed(1),
        _max_ms,
        sanitize_log_str(file_path),
      );
      record_cached_stat("git_hint_timeout", sanitize_log_str(file_path));
      return null;
    }

    return result;
  } catch {
    return null;
  }
}

/** Monotonic clock in milliseconds (Python time.monotonic()*1000). */
function _monotonicMs(): number {
  return Number(process.hrtime.bigint() / 1_000_000n);
}

/**
 * Path.relative_to(base).as_posix() — raises ValueError when *p* is not under
 * *base*. We mirror that: throw when the relative path escapes the base.
 */
function _relativeToPosix(base: string, p: string): string {
  const rel = nodePath.relative(base, p);
  if (rel.startsWith("..") || nodePath.isAbsolute(rel)) {
    throw new Error("path is not relative to base");
  }
  return rel.split(nodePath.sep).join("/");
}

// Pattern for skill body files.
const _SKILL_FILE_RE =
  /[/\\]\.claude[/\\](?:plugins[/\\](?:[^/\\]+[/\\])*)?skills[/\\]([^/\\]+)(?:[/\\]([^/\\]+)[/\\]SKILL\.md|[/\\]SKILL\.md|\.md)$/i;

/** Return the skill name if *file_path* points to a skill body file, else null. */
export function _detect_skill_name_from_path(file_path: string): string | null {
  try {
    const fp_lower = file_path.toLowerCase();
    if (!fp_lower.includes(".claude") || !fp_lower.includes("skills")) {
      return null;
    }
    const m = _SKILL_FILE_RE.exec(file_path.replace(/\\/g, "/"));
    if (m) {
      let name = m[1] as string;
      if (name.toLowerCase().endsWith(".md")) {
        name = name.slice(0, -3);
      }
      return name ? name.toLowerCase() : null;
    }
  } catch {
    // fail-soft
  }
  return null;
}

/** Build a `source_path → skill_name` reverse index from *skill_history*. */
export function _build_skill_path_index(skill_history: Record<string, unknown>): Record<string, string> {
  const index: Record<string, string> = {};
  try {
    for (const [name, entry] of Object.entries(skill_history)) {
      const sp = String((entry as { source_path?: unknown })?.source_path ?? "") || "";
      if (sp) {
        const normalised = sp.replace(/\\/g, "/").toLowerCase();
        index[normalised] = String(name);
      }
    }
  } catch {
    // fail-soft
  }
  return index;
}

/** Return a hint when the agent tries to Read a skill body file directly. */
export function _handle_skill_file_read(
  session_id: string,
  file_path: string,
  cache: unknown,
): HookResponse | null {
  if (cache === null || cache === undefined) {
    return null;
  }

  const skill_history = (cache as { skill_history?: unknown }).skill_history;
  if (!_isDict(skill_history) || Object.keys(skill_history).length === 0) {
    return null;
  }

  let skill_name: string | null = null;
  const _cached_index = (cache as { _skill_path_index?: unknown })._skill_path_index;
  let path_index: Record<string, string> | null = _isDict(_cached_index)
    ? (_cached_index as Record<string, string>)
    : null;
  if (path_index === null) {
    path_index = _build_skill_path_index(skill_history as Record<string, unknown>);
    try {
      (cache as { _skill_path_index?: unknown })._skill_path_index = path_index;
    } catch {
      // AttributeError suppressed.
    }
  }

  if (path_index && Object.keys(path_index).length > 0) {
    const normed = file_path.replace(/\\/g, "/").toLowerCase();
    skill_name = path_index[normed] ?? null;
  }

  if (skill_name === null) {
    skill_name = self._detect_skill_name_from_path(file_path);
  }
  if (skill_name === null) {
    return null;
  }

  const sh = skill_history as Record<string, unknown>;
  const matched_entry = sh[skill_name] ?? sh[skill_name.toLowerCase()] ?? null;
  if (matched_entry === null || matched_entry === undefined) {
    return null;
  }

  const cached_sha = String((matched_entry as { content_sha?: unknown }).content_sha ?? "") || "";
  const source_path = String((matched_entry as { source_path?: unknown }).source_path ?? "") || "";
  const _raw_ts = (matched_entry as { ts?: unknown }).ts;
  let cache_ts: number;
  try {
    cache_ts = _raw_ts !== null && _raw_ts !== undefined ? Number(_raw_ts) : -1.0;
    if (!Number.isFinite(cache_ts)) {
      cache_ts = -1.0;
    }
  } catch {
    cache_ts = -1.0;
  }
  if (cached_sha && source_path && cache_ts >= 0.0) {
    try {
      const src_path_obj = source_path;
      const file_mtime = fs.statSync(src_path_obj).mtimeMs / 1000;
      if (file_mtime > cache_ts) {
        const disk_bytes = _readBytes(src_path_obj);
        const disk_sha = _sha256Hex(disk_bytes);
        if (disk_sha !== cached_sha) {
          _LOG.info(
            "pre-read: skill '%s' cache stale (file mtime %s > cache ts %s, disk sha %s…  != cached %s…); allowing read to proceed",
            sanitize_log_str(skill_name),
            file_mtime.toFixed(0),
            cache_ts.toFixed(0),
            disk_sha.slice(0, 12),
            cached_sha.slice(0, 12),
          );
          self._emit_stale_compact_hint({
            skill_name,
            disk_sha,
            session_id: String((cache as { session_id?: unknown }).session_id ?? ""),
            cache,
            file_path,
          });
          try {
            delete (cache as { _skill_path_index?: unknown })._skill_path_index;
          } catch {
            // AttributeError suppressed.
          }
          return null;
        }
      }
    } catch (exc) {
      if (!_isOSError(exc)) {
        throw exc;
      }
      // File not found or unreadable — can't verify staleness; emit hint.
    }
  }

  const hint_text =
    `Skill '${skill_name}' in context (loaded via Skill tool). ` +
    `Recall: \`token-goat skill-body ${skill_name}\` (~95% fewer tok). ` +
    `Section: \`token-goat skill-section ${skill_name} <heading>\`.`;
  const fingerprint = hints._hint_fingerprint(hint_text, file_path);
  const mark_seen = (cache as { mark_hint_seen?: unknown }).mark_hint_seen;
  if (typeof mark_seen === "function") {
    const has_fp = (cache as { has_hint_fingerprint?: unknown }).has_hint_fingerprint;
    if (typeof has_fp === "function" && has_fp.call(cache, fingerprint)) {
      return null;
    }
    mark_seen.call(cache, fingerprint);
  }

  record_hint_stat_pair("skill_file_read_hint", hint_text, sanitize_log_str(file_path, 512));
  _LOG.info(
    "pre-read: skill-file hint injected for %s (skill=%s)",
    sanitize_log_str(file_path),
    sanitize_log_str(skill_name),
  );
  return pre_tool_use_with_context(hint_text);
}

/** True for a Node fs error (the analogue of Python OSError). */
function _isOSError(exc: unknown): boolean {
  return exc instanceof Error && typeof (exc as NodeJS.ErrnoException).code === "string";
}

/** Emit a best-effort advisory when a skill body change makes the compact stale. */
export function _emit_stale_compact_hint(args: {
  skill_name: string;
  disk_sha: string;
  session_id: string;
  cache: unknown;
  file_path: string;
}): void {
  const { skill_name, disk_sha, session_id, cache, file_path } = args;
  if (!skill_name || !session_id) {
    return;
  }
  try {
    const _sc = _skillCacheMod;
    if (_sc === null) {
      return; // seam not installed — degrade to no-op
    }

    const compact_text = _sc.get_compact(session_id, skill_name);
    if (compact_text === null) {
      return;
    }

    const compact_sha = _sc.extract_compact_source_sha(compact_text) ?? "";
    if (!compact_sha) {
      return;
    }

    if (compact_sha === disk_sha.slice(0, compact_sha.length)) {
      return;
    }

    const hint_text =
      `Note: skill '${skill_name}' body has changed on disk (SHA mismatch). ` +
      "The cached compact is now stale. " +
      `After loading the updated skill, run: \`token-goat skill-compact ${skill_name}\` ` +
      "to regenerate the compact with the new body.";
    const fingerprint = hints._hint_fingerprint(hint_text, file_path);
    const mark_seen = (cache as { mark_hint_seen?: unknown }).mark_hint_seen;
    if (typeof mark_seen === "function") {
      const has_fp = (cache as { has_hint_fingerprint?: unknown }).has_hint_fingerprint;
      if (typeof has_fp === "function" && has_fp.call(cache, fingerprint)) {
        return;
      }
      mark_seen.call(cache, fingerprint);
    }

    record_hint_stat_pair("stale_compact_hint", hint_text, sanitize_log_str(file_path, 512));
    _LOG.info(
      "pre-read: stale-compact advisory for skill '%s' (compact sha %s… != disk sha %s…)",
      sanitize_log_str(skill_name),
      compact_sha.slice(0, 8),
      disk_sha.slice(0, 8),
    );
  } catch {
    _LOG.debug("_emit_stale_compact_hint: unexpected error (fail-soft)");
  }
}

/** Shared dedup → budget → mark-seen → record → emit pipeline for one-shot pre-read hints. */
export function _emit_dedup_budgeted_hint(args: {
  hint: unknown;
  file_path: string;
  cache: unknown;
  budget_kind: string;
  record_emitted_fn: (cache: unknown) => void;
  stat_kind: string;
  display_name: string;
}): HookResponse | null {
  const { hint, file_path, cache, budget_kind, record_emitted_fn, stat_kind, display_name } = args;
  if (hint === null || hint === undefined) {
    return null;
  }

  const fingerprint = hints._hint_fingerprint(String(hint), file_path);
  const hints_seen_dict = (cache as { hints_seen?: unknown }).hints_seen;
  const seen_count = _isDict(hints_seen_dict) ? Number((hints_seen_dict as Record<string, unknown>)[fingerprint] ?? 0) : 0;

  if (seen_count > 0) {
    let verbose_until: number;
    try {
      verbose_until = config.load().hints?.verbose_until_seen_count ?? 2;
    } catch {
      verbose_until = 2;
    }

    if (verbose_until === 0) {
      _LOG.debug(
        "pre-read: %s hint already seen for %s; suppressing (verbose_until_seen_count=0)",
        display_name,
        sanitize_log_str(file_path),
      );
      return null;
    } else if (seen_count >= verbose_until) {
      if (cache instanceof session.SessionCache && !hints._hint_budget_check(cache, budget_kind)) {
        _LOG.debug("pre-read: %s stub budget exhausted for %s", display_name, sanitize_log_str(file_path));
        return null;
      }
      const stub_hint = hints._make_short_stub_hint(seen_count);
      const mark_seen = (cache as { mark_hint_seen?: unknown }).mark_hint_seen;
      if (typeof mark_seen === "function") {
        mark_seen.call(cache, fingerprint);
      }
      if (cache instanceof session.SessionCache) {
        record_emitted_fn(cache);
      }
      record_hint_stat_pair(stat_kind, stub_hint, sanitize_log_str(file_path, 512));
      _LOG.debug(
        "pre-read: %s hint short-stub for %s (seen %d times)",
        display_name,
        sanitize_log_str(file_path),
        seen_count,
      );
      return pre_tool_use_with_context(String(stub_hint));
    }
    // else: within verbose_until window — fall through to the full emit path below.
  }

  if (cache instanceof session.SessionCache && !hints._hint_budget_check(cache, budget_kind)) {
    _LOG.debug("pre-read: %s hint budget exhausted for %s", display_name, sanitize_log_str(file_path));
    return null;
  }

  const mark_seen = (cache as { mark_hint_seen?: unknown }).mark_hint_seen;
  if (typeof mark_seen === "function") {
    mark_seen.call(cache, fingerprint);
  }

  if (cache instanceof session.SessionCache) {
    record_emitted_fn(cache);
  }

  record_hint_stat_pair(stat_kind, hint, sanitize_log_str(file_path, 512));
  _LOG.info(
    "pre-read: %s hint injected for %s (%s)",
    display_name,
    sanitize_log_str(file_path),
    String(hint).slice(0, 60),
  );
  return pre_tool_use_with_context(String(hint));
}

/** Return a hint when Read targets a machine-generated index-only file. */
export function _handle_index_only_file(
  session_id: string,
  file_path: string,
  tool_input: Record<string, unknown>,
  cache: unknown,
): HookResponse | null {
  const hint = hints.build_index_only_file_hint({
    file_path,
    offset: tool_input["offset"],
    limit: tool_input["limit"],
  });
  return self._emit_dedup_budgeted_hint({
    hint,
    file_path,
    cache,
    budget_kind: hints._HINT_KIND_INDEX_ONLY,
    record_emitted_fn: (c) => hints._record_index_only_hint_emitted(c as SessionCache),
    stat_kind: "index_only_hint",
    display_name: "index-only",
  });
}

/** Serve a user-created compact sidecar for a large markdown reference doc. */
export function _handle_doc_compact(
  file_path: string,
  cwd: string | null,
  cache: unknown,
): HookResponse | null {
  const hint = hints.build_doc_compact_hint(file_path, cwd, { cache: cache as SessionCache | null });
  if (hint === null) {
    return null;
  }

  const hint_text = String(hint);
  if (hint_text.startsWith(hints.DOC_COMPACT_SERVE_SENTINEL)) {
    const content = hint_text.slice(hints.DOC_COMPACT_SERVE_SENTINEL.length);
    const tokens_saved = (hint as { tokens_saved: number }).tokens_saved;
    if (tokens_saved > 0) {
      try {
        const _proj = project.find_project(validate_cwd(cwd) ?? process.cwd());
        db.recordStat(_proj ? _proj.hash : undefined, "doc_compact_served", {
          tokensSaved: tokens_saved,
          detail: file_path,
        });
      } catch {
        // fail-soft
      }
    }
    return deny_redirect("doc-compact: serving compact instead of full file", content);
  }

  // Section-map hint or stale warning: let the read proceed, inject hint.
  const _fp_key = `compact_doc_spawned:${file_path}`;
  if (cache !== null && cache !== undefined) {
    try {
      const has_fp = (cache as { has_hint_fingerprint?: unknown }).has_hint_fingerprint;
      const mark_seen = (cache as { mark_hint_seen?: unknown }).mark_hint_seen;
      if (typeof has_fp === "function" && !has_fp.call(cache, _fp_key)) {
        if (typeof mark_seen === "function") {
          mark_seen.call(cache, _fp_key);
        }
        const _exe = _whichTokenGoat();
        if (_exe) {
          const child = childProcess.spawn(_exe, ["compact-doc", file_path], {
            stdio: "ignore",
            detached: true,
          });
          child.unref();
        }
      }
    } catch {
      // fail-soft
    }
  }
  return pre_tool_use_with_context(hint_text);
}

/** shutil.which("token-goat") — locate the token-goat executable on PATH. */
function _whichTokenGoat(): string | null {
  const exeNames = process.platform === "win32" ? ["token-goat.exe", "token-goat.cmd", "token-goat"] : ["token-goat"];
  const pathEnv = process.env["PATH"] ?? "";
  const dirs = pathEnv.split(nodePath.delimiter).filter((d) => d.length > 0);
  for (const dir of dirs) {
    for (const name of exeNames) {
      const candidate = nodePath.join(dir, name);
      try {
        fs.accessSync(candidate, fs.constants.X_OK);
        return candidate;
      } catch {
        // not here
      }
    }
  }
  return null;
}

/** Return a hint when Read targets a large structured data file (CSV/JSON/log). */
export function _handle_structured_file(
  session_id: string,
  file_path: string,
  tool_input: Record<string, unknown>,
  cache: unknown,
): HookResponse | null {
  const hint = hints.build_structured_file_hint({
    file_path,
    offset: tool_input["offset"],
    limit: tool_input["limit"],
  });
  return self._emit_dedup_budgeted_hint({
    hint,
    file_path,
    cache,
    budget_kind: hints._HINT_KIND_STRUCTURED,
    record_emitted_fn: (c) => hints._record_structured_hint_emitted(c as SessionCache),
    stat_kind: "structured_file_hint",
    display_name: "structured-file",
  });
}

/** Record net impact of session hints: avoided re-reads minus injection overhead. */
export function _record_session_hint_impact(file_path: string, hint: unknown): void {
  record_hint_stat_pair("session_hint", hint, sanitize_log_str(file_path, 512));
}

/** Return a hint when the file content matches its session snapshot. */
export function _try_unchanged_file_hint(
  session_id: string,
  file_path: string,
  tool_input: Record<string, unknown>,
  cache: unknown,
): HookResponse | null {
  const offset = tool_input["offset"];
  const limit = tool_input["limit"];
  if (offset !== null && offset !== undefined) {
    return null;
  }
  if (limit !== null && limit !== undefined) {
    return null;
  }

  const hint = hints.build_unchanged_file_hint({ session_id, file_path, cache: cache as SessionCache | null });
  if (hint === null) {
    return null;
  }

  record_hint_stat_pair("unchanged_file_hint", hint, sanitize_log_str(file_path, 512));
  _LOG.info(
    "pre-read: unchanged-file hint injected for %s (tokens_saved=%d)",
    sanitize_log_str(file_path),
    (hint as { tokens_saved: number }).tokens_saved,
  );
  return pre_tool_use_with_context(String(hint));
}

/** Return a diff-hint hook response when one applies, otherwise null. */
export function _try_diff_hint(
  session_id: string,
  file_path: string,
  opts?: {
    req_start?: number | null;
    req_end?: number | null;
    entry_line_ranges?: Array<[number, number]> | null;
  },
): HookResponse | null {
  const req_start = opts?.req_start ?? null;
  const req_end = opts?.req_end ?? null;
  const entry_line_ranges = opts?.entry_line_ranges ?? null;

  if (
    req_start !== null &&
    req_end !== null &&
    entry_line_ranges &&
    entry_line_ranges.length > 0 &&
    !(entry_line_ranges.length === 1 && entry_line_ranges[0]?.[0] === 0 && entry_line_ranges[0]?.[1] === 0)
  ) {
    const [global_min, global_max] = hints._line_ranges_global_bounds(entry_line_ranges);
    if (req_start > global_max + hints._PROXIMITY_SLOP_LINES || req_end < global_min - hints._PROXIMITY_SLOP_LINES) {
      _LOG.debug(
        "diff-hint: suppressed for %s (range [%d,%d] outside cached [%d,%d] ±%d)",
        sanitize_log_str(file_path),
        req_start,
        req_end,
        global_min,
        global_max,
        hints._PROXIMITY_SLOP_LINES,
      );
      return null;
    }
  }

  let current_bytes: Buffer;
  try {
    const fd = fs.openSync(file_path, "r");
    try {
      const buf = Buffer.alloc(snapshots.MAX_SNAPSHOT_BYTES + 1);
      const bytesRead = fs.readSync(fd, buf, 0, snapshots.MAX_SNAPSHOT_BYTES + 1, 0);
      current_bytes = buf.subarray(0, bytesRead);
    } finally {
      fs.closeSync(fd);
    }
  } catch (exc) {
    _LOG.debug("diff-hint: cannot read %s: %s", sanitize_log_str(file_path), String(exc));
    return null;
  }
  if (current_bytes.length > snapshots.MAX_SNAPSHOT_BYTES) {
    return null;
  }

  const current_text = current_bytes.toString("utf8");
  const hint = hints.build_diff_hint({ session_id, file_path, current_text });
  if (hint === null) {
    return null;
  }

  record_hint_stat_pair("diff_hint", hint, sanitize_log_str(file_path, 512));
  let snapshot_kind: string | null;
  try {
    snapshot_kind = snapshots.load_kind(session_id, file_path);
  } catch {
    snapshot_kind = null;
  }
  if (snapshot_kind === "predictive") {
    try {
      db.recordStat(undefined, "predictive_prefetch_hit", {
        bytesSaved: 0,
        tokensSaved: 0,
        detail: sanitize_log_str(file_path, 512),
      });
    } catch {
      _LOG.debug("predictive-snapshot: stat record failed");
    }
    _LOG.info(
      "pre-read: predictive-snapshot hit for %s (tokens_saved=%d)",
      sanitize_log_str(file_path),
      (hint as { tokens_saved: number }).tokens_saved,
    );
  }
  _LOG.info(
    "pre-read: diff-hint injected for %s (tokens_saved=%d)",
    sanitize_log_str(file_path),
    (hint as { tokens_saved: number }).tokens_saved,
  );
  return pre_tool_use_with_context(String(hint));
}

/** Intercept a re-read of a changed file and serve a unified diff instead. */
export function _try_diff_serve(
  session_id: string,
  file_path: string,
  opts?: {
    req_start?: number | null;
    req_end?: number | null;
    entry_line_ranges?: Array<[number, number]> | null;
  },
): HookResponse | null {
  const req_start = opts?.req_start ?? null;
  const req_end = opts?.req_end ?? null;
  const entry_line_ranges = opts?.entry_line_ranges ?? null;

  if (
    req_start !== null &&
    req_end !== null &&
    entry_line_ranges &&
    entry_line_ranges.length > 0 &&
    !(entry_line_ranges.length === 1 && entry_line_ranges[0]?.[0] === 0 && entry_line_ranges[0]?.[1] === 0)
  ) {
    const [global_min, global_max] = hints._line_ranges_global_bounds(entry_line_ranges);
    if (req_start > global_max + hints._PROXIMITY_SLOP_LINES || req_end < global_min - hints._PROXIMITY_SLOP_LINES) {
      _LOG.debug(
        "diff-serve: suppressed for %s (range [%d,%d] outside cached [%d,%d] ±%d)",
        sanitize_log_str(file_path),
        req_start,
        req_end,
        global_min,
        global_max,
        hints._PROXIMITY_SLOP_LINES,
      );
      return null;
    }
  }

  const snapshot_bytes = snapshots.load(session_id, file_path);
  if (snapshot_bytes === null) {
    return null;
  }

  let current_bytes: Buffer;
  try {
    const fd = fs.openSync(file_path, "r");
    try {
      const buf = Buffer.alloc(snapshots.MAX_SNAPSHOT_BYTES + 1);
      const bytesRead = fs.readSync(fd, buf, 0, snapshots.MAX_SNAPSHOT_BYTES + 1, 0);
      current_bytes = buf.subarray(0, bytesRead);
    } finally {
      fs.closeSync(fd);
    }
  } catch (exc) {
    _LOG.debug("diff-serve: cannot read %s: %s", sanitize_log_str(file_path), String(exc));
    return null;
  }
  if (current_bytes.length > snapshots.MAX_SNAPSHOT_BYTES) {
    return null;
  }

  if (current_bytes.equals(snapshot_bytes)) {
    return null;
  }

  const snapshot_text = snapshot_bytes.toString("utf8");
  const current_text = current_bytes.toString("utf8");

  const fname = _basename(file_path);
  const diff_lines = _unifiedDiff(
    _splitlines(snapshot_text),
    _splitlines(current_text),
    `a/${fname}`,
    `b/${fname}`,
  );

  if (diff_lines.length === 0) {
    return null;
  }

  const diff_text = diff_lines.join("\n");
  const diff_bytes = _utf8_bytes(diff_text).length;
  const file_size = current_bytes.length;

  if (diff_bytes >= file_size * 0.5) {
    _LOG.debug(
      "diff-serve: skipping for %s (diff=%d bytes >= 50%% of file=%d bytes)",
      sanitize_log_str(file_path),
      diff_bytes,
      file_size,
    );
    return null;
  }

  const bytes_saved = Math.max(0, file_size - diff_bytes);

  try {
    db.recordStat(undefined, "diff_served", {
      bytesSaved: bytes_saved,
      tokensSaved: bytes_saved > 0 ? Math.max(1, Math.trunc(bytes_saved / 3) + 1) : 0,
      detail: sanitize_log_str(file_path, 512),
    });
  } catch {
    _LOG.debug("diff-serve: stat record failed for %s", sanitize_log_str(file_path));
  }

  _LOG.info(
    "pre-read: diff-serve blocking Read for %s (bytes_saved=%d, diff=%d bytes)",
    sanitize_log_str(file_path),
    bytes_saved,
    diff_bytes,
  );

  const _tokens_saved_est = bytes_saved > 0 ? Math.max(1, Math.trunc(bytes_saved / 3) + 1) : 0;
  const context_msg =
    `token-goat intercepted the Read of \`${sanitize_log_str(file_path, 200)}\` ` +
    `and is serving a unified diff instead of the full file to save ~${_tokens_saved_est} tokens.\n` +
    `The diff shows changes since you last read this file:\n\n` +
    "```diff\n" +
    `${diff_text}\n` +
    "```\n\n" +
    `If you need the full file content, run: \`token-goat read "${sanitize_log_str(file_path, 200)}"\``;

  return deny_redirect("token-goat serves diff instead of full file re-read to save tokens", context_msg);
}

/** Python str.splitlines() WITHOUT keepends. */
function _splitlines(text: string): string[] {
  if (text === "") {
    return [];
  }
  // Python splitlines splits on a broad set of boundaries; \n / \r\n / \r cover
  // the cases the diff/post-bash paths need.
  const parts = text.split(/\r\n|\r|\n/);
  // Python str.splitlines() does NOT emit a trailing empty element for a string
  // ending in a line terminator (unlike a bare split). Drop the single trailing
  // "" so line counts/totals match Python (the post_bash >= _MIN_LINES guards
  // and the diff path both rely on this).
  if (parts[parts.length - 1] === "") {
    parts.pop();
  }
  return parts;
}

/**
 * Minimal unified-diff generator (the analogue of difflib.unified_diff with
 * lineterm=""). Produces @@ hunk headers and +/-/space-prefixed lines around
 * an LCS-based diff. Used only by _try_diff_serve.
 */
function _unifiedDiff(a: string[], b: string[], fromfile: string, tofile: string): string[] {
  const opcodes = _diffOpcodes(a, b);
  // If no changes, difflib.unified_diff yields nothing.
  const hasChange = opcodes.some((op) => op.tag !== "equal");
  if (!hasChange) {
    return [];
  }
  const out: string[] = [];
  out.push(`--- ${fromfile}`);
  out.push(`+++ ${tofile}`);

  // Group opcodes into hunks with 3 lines of context (difflib default n=3).
  const n = 3;
  const groups = _groupedOpcodes(opcodes, n);
  for (const group of groups) {
    const first = group[0] as Op;
    const last = group[group.length - 1] as Op;
    const i1 = first.i1;
    const i2 = last.i2;
    const j1 = first.j1;
    const j2 = last.j2;
    const aStart = i1 + 1;
    const aLen = i2 - i1;
    const bStart = j1 + 1;
    const bLen = j2 - j1;
    const aHeader = aLen === 1 ? `${aStart}` : `${aLen === 0 ? i1 : aStart},${aLen}`;
    const bHeader = bLen === 1 ? `${bStart}` : `${bLen === 0 ? j1 : bStart},${bLen}`;
    out.push(`@@ -${aHeader} +${bHeader} @@`);
    for (const op of group) {
      if (op.tag === "equal") {
        for (let k = op.i1; k < op.i2; k += 1) {
          out.push(` ${a[k] as string}`);
        }
      } else {
        if (op.tag === "replace" || op.tag === "delete") {
          for (let k = op.i1; k < op.i2; k += 1) {
            out.push(`-${a[k] as string}`);
          }
        }
        if (op.tag === "replace" || op.tag === "insert") {
          for (let k = op.j1; k < op.j2; k += 1) {
            out.push(`+${b[k] as string}`);
          }
        }
      }
    }
  }
  return out;
}

type OpTag = "equal" | "replace" | "delete" | "insert";
interface Op {
  tag: OpTag;
  i1: number;
  i2: number;
  j1: number;
  j2: number;
}

/** LCS-based opcode generator (the analogue of difflib.SequenceMatcher.get_opcodes). */
function _diffOpcodes(a: string[], b: string[]): Op[] {
  const m = a.length;
  const n = b.length;
  // LCS length table.
  const dp: number[][] = Array.from({ length: m + 1 }, () => new Array<number>(n + 1).fill(0));
  for (let i = m - 1; i >= 0; i -= 1) {
    for (let j = n - 1; j >= 0; j -= 1) {
      if (a[i] === b[j]) {
        (dp[i] as number[])[j] = ((dp[i + 1] as number[])[j + 1] as number) + 1;
      } else {
        (dp[i] as number[])[j] = Math.max((dp[i + 1] as number[])[j] as number, (dp[i] as number[])[j + 1] as number);
      }
    }
  }
  // Walk the table to build raw +/-/= operations.
  const ops: Op[] = [];
  let i = 0;
  let j = 0;
  const pushOp = (tag: OpTag, i1: number, i2: number, j1: number, j2: number): void => {
    const last = ops[ops.length - 1];
    if (last && last.tag === tag) {
      last.i2 = i2;
      last.j2 = j2;
    } else {
      ops.push({ tag, i1, i2, j1, j2 });
    }
  };
  while (i < m && j < n) {
    if (a[i] === b[j]) {
      pushOp("equal", i, i + 1, j, j + 1);
      i += 1;
      j += 1;
    } else if (((dp[i + 1] as number[])[j] as number) >= ((dp[i] as number[])[j + 1] as number)) {
      pushOp("delete", i, i + 1, j, j);
      i += 1;
    } else {
      pushOp("insert", i, i, j, j + 1);
      j += 1;
    }
  }
  while (i < m) {
    pushOp("delete", i, i + 1, j, j);
    i += 1;
  }
  while (j < n) {
    pushOp("insert", i, i, j, j + 1);
    j += 1;
  }
  // Coalesce adjacent delete+insert into replace (difflib-style).
  const merged: Op[] = [];
  for (let k = 0; k < ops.length; k += 1) {
    const cur = ops[k] as Op;
    const prev = merged[merged.length - 1];
    if (
      prev &&
      ((prev.tag === "delete" && cur.tag === "insert") || (prev.tag === "insert" && cur.tag === "delete"))
    ) {
      merged[merged.length - 1] = {
        tag: "replace",
        i1: Math.min(prev.i1, cur.i1),
        i2: Math.max(prev.i2, cur.i2),
        j1: Math.min(prev.j1, cur.j1),
        j2: Math.max(prev.j2, cur.j2),
      };
    } else {
      merged.push({ ...cur });
    }
  }
  return merged;
}

/** Group opcodes into hunks with *n* lines of context (difflib get_grouped_opcodes). */
function _groupedOpcodes(opcodes: Op[], n: number): Op[][] {
  let codes = opcodes.map((o) => ({ ...o }));
  if (codes.length === 0) {
    codes = [{ tag: "equal", i1: 0, i2: 1, j1: 0, j2: 1 }];
  }
  const first = codes[0] as Op;
  if (first.tag === "equal") {
    first.i1 = Math.max(first.i1, first.i2 - n);
    first.j1 = Math.max(first.j1, first.j2 - n);
  }
  const last = codes[codes.length - 1] as Op;
  if (last.tag === "equal") {
    last.i2 = Math.min(last.i2, last.i1 + n);
    last.j2 = Math.min(last.j2, last.j1 + n);
  }

  const nn = n;
  const groups: Op[][] = [];
  let group: Op[] = [];
  for (const op of codes) {
    let { tag, i1, i2, j1, j2 } = op;
    if (tag === "equal" && i2 - i1 > nn * 2) {
      group.push({ tag, i1, i2: Math.min(i2, i1 + nn), j1, j2: Math.min(j2, j1 + nn) });
      groups.push(group);
      group = [];
      i1 = Math.max(i1, i2 - nn);
      j1 = Math.max(j1, j2 - nn);
    }
    group.push({ tag, i1, i2, j1, j2 });
  }
  if (group.length > 0 && !(group.length === 1 && (group[0] as Op).tag === "equal")) {
    groups.push(group);
  }
  return groups;
}

// ===========================================================================
// pre-read helpers — Grep / Glob
// ===========================================================================

/** Pre-grep content dedup placeholder — always returns null (handled in post_read). */
export function _handle_grep_result_content_dedup(payload: HookPayload): HookResponse | null {
  const [session_id] = get_hook_context(payload);
  if (session_id === null) {
    return null;
  }

  const cache = load_session_safe(session_id);
  if (cache === null) {
    return null;
  }

  const tool_input = get_tool_input(payload);
  const pattern = tool_input["pattern"];
  if (typeof pattern !== "string" || !pattern) {
    return null;
  }

  // We don't have the result content at pre-time; this is handled in post_read.
  return null;
}

/** Extract and validate the `pattern` and optional `path` from a Grep payload. */
export function _extract_grep_args(payload: HookPayload): [string, string | null] | null {
  const tool_input = get_tool_input(payload);
  const pattern = tool_input["pattern"];
  if (typeof pattern !== "string" || !pattern) {
    return null;
  }
  let path = tool_input["path"];
  if (path !== null && path !== undefined && typeof path !== "string") {
    path = null;
  }
  return [pattern, (path ?? null) as string | null];
}

/** Return cached Grep results or a dedup hint when the same pattern ran recently. */
export function _handle_grep_dedup(payload: HookPayload): HookResponse | null {
  const args = self._extract_grep_args(payload);
  if (args === null) {
    return null;
  }
  const [pattern, path] = args;

  const tool_input = get_tool_input(payload);
  const glob_filter = typeof tool_input["glob"] === "string" ? (tool_input["glob"] as string) : null;
  const type_filter = typeof tool_input["type"] === "string" ? (tool_input["type"] as string) : null;
  const output_mode = typeof tool_input["output_mode"] === "string" ? (tool_input["output_mode"] as string) : null;

  const [session_id] = get_hook_context(payload);
  if (session_id === null) {
    return null;
  }

  try {
    const cache = _get_session().load(session_id);
    const grep_entry = session.lookup_grep_entry(session_id, pattern, path, { cache });
    if (grep_entry !== null) {
      const _now = Date.now() / 1000;
      const age = _now - grep_entry.ts;
      const _sess_created = (cache as { created_ts?: number }).created_ts;
      const _sess_age = _sess_created !== undefined && _sess_created !== null ? _now - _sess_created : hints.STALE_READ_AGE_SECONDS;
      const _stale_thresh = hints.compute_stale_threshold(_sess_age);
      if (age <= _stale_thresh) {
        const cached_result = bash_cache.load_grep_result(session_id, pattern, path, glob_filter, type_filter, output_mode);
        if (cached_result !== null) {
          const path_label = path ? ` in ${_pyRepr(path)}` : "";
          const _cached_lines = cached_result.split("\n").filter((ln) => ln.trim());
          let _cached_display: string;
          if ((output_mode || "files_with_matches") === "files_with_matches" && _cached_lines.length > _GLOB_ROLLUP_THRESHOLD) {
            _cached_display = self._rollup_glob_paths(cached_result);
          } else {
            _cached_display = cached_result;
          }
          const result_count = grep_entry.result_count;
          const hint_text =
            `Note: Grep \`${sanitize_log_str(pattern, 100)}\`${path_label} ` +
            `ran ${Math.trunc(age)}s ago — cached result (${result_count || "?"} matches):\n` +
            `${_cached_display}\n` +
            "(Serving from cache. Run without hints to force a fresh search.)";
          record_cached_stat("grep_result_cache_hit", sanitize_log_str(pattern, 200));
          _LOG.info("pre-read: grep result cache hit for pattern=%s (age=%ds)", sanitize_log_str(pattern, 100), Math.trunc(age));
          return pre_tool_use_with_context(hint_text);
        }
      }
    }
  } catch {
    _LOG.debug("pre-read: grep result cache check failed");
  }

  return run_dedup_hint(payload, {
    builder: (sid, cache) => hints.build_grep_dedup_hint({ session_id: sid, pattern, path, cache: cache as SessionCache | null }),
    stat_kind: "grep_dedup_hint",
    detail: sanitize_log_str(pattern, 200),
    log_label: "pre-read",
  });
}

/** Python repr() of a string for display (single-quoted, escaped). */
function _pyRepr(s: string): string {
  return `'${s.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`;
}

const _GREP_WRITTEN_NOT_READ_MAX_PATHS = 5;

/** Hint when Grep targets a file (or directory) written this session but not yet read back. */
export function _handle_grep_written_not_read(payload: HookPayload): HookResponse | null {
  const [session_id] = get_hook_context(payload);
  if (session_id === null) {
    return null;
  }

  const tool_input = get_tool_input(payload);
  const path = tool_input["path"];
  if (typeof path !== "string" || !path) {
    return null;
  }

  const cache = load_session_safe(session_id);
  if (cache === null) {
    return null;
  }

  const _edited: Record<string, number> = _isDict(cache.edited_files) ? cache.edited_files : {};

  // --- single-file path ---
  const _written_key = session._normalize_path(path);
  const _edit_count = _edited[_written_key] ?? 0;
  if (_edit_count >= 1 && !(_written_key in cache.files)) {
    const fname = sanitize_log_str(_basename(path), 256);
    const hint_text =
      `Note: \`${fname}\` was written ${_edit_count}x this session and not yet read back. ` +
      "The content you wrote may still be in context from the tool result — " +
      "check there before grepping. For a specific symbol use " +
      `\`token-goat read "${path}::SymbolName"\`.`;
    _LOG.debug("pre-read: grep written-not-read hint for %s (edit_count=%d)", sanitize_log_str(path), _edit_count);
    return pre_tool_use_with_context(hint_text);
  }

  // --- directory-scope path ---
  const _dir_key = session._normalize_path(path);
  const _dir_prefix = _dir_key.endsWith("/") ? _dir_key : _dir_key + "/";
  const _dir_matches: Array<[string, number]> = [];
  for (const [p, c] of Object.entries(_edited)) {
    if (p.startsWith(_dir_prefix) && !(p in cache.files) && c >= 1) {
      _dir_matches.push([p, c]);
    }
  }
  if (_dir_matches.length === 0) {
    return null;
  }

  _dir_matches.sort((x, y) => y[1] - x[1]);
  const _shown = _dir_matches.slice(0, _GREP_WRITTEN_NOT_READ_MAX_PATHS);
  const _overflow = _dir_matches.length - _shown.length;
  let _path_lines = _shown.map(([p]) => `  ${sanitize_log_str(p, 256)}`).join("\n");
  if (_overflow > 0) {
    _path_lines += `\n  (+${_overflow} more edited)`;
  }
  const hint_text =
    `Note: ${_dir_matches.length} file(s) under \`${sanitize_log_str(path, 200)}\` ` +
    `were written this session and not yet read back:\n${_path_lines}\n` +
    "Their content may still be in context from the tool results — " +
    "check there before grepping. For a specific symbol use " +
    `\`token-goat read "<path>::SymbolName"\`.`;
  _LOG.debug("pre-read: grep written-not-read dir hint for %s (%d files)", sanitize_log_str(path), _dir_matches.length);
  return pre_tool_use_with_context(hint_text);
}

// Matches pure code identifiers.
const _IDENTIFIER_RE = /^[A-Za-z_$][A-Za-z0-9_$]{2,}$/;
// Matches two-part dotted names.
const _DOTTED_NAME_RE = /^([A-Za-z_$][A-Za-z0-9_$]+)\.([A-Za-z_$][A-Za-z0-9_$]+)$/;

/** Return a `token-goat symbol` suggestion when the grep pattern is a known indexed symbol. */
export function _try_grep_symbol_hint(pattern: string, cwd: string | null): string | null {
  if (!_IDENTIFIER_RE.test(pattern)) {
    return null;
  }
  try {
    const cwd_path = validate_cwd(cwd, { caller: "grep-symbol-hint" });
    if (cwd_path === null) {
      return null;
    }
    const proj = project.find_project(cwd_path);
    if (proj === null) {
      return null;
    }

    const rows = db.openProjectReadonly(proj.hash, (conn) =>
      conn
        .prepare(
          "SELECT name, kind, file_rel, line FROM symbols " +
            "WHERE name = ? AND end_line IS NOT NULL " +
            "ORDER BY kind, line LIMIT 6",
        )
        .all(pattern) as Array<{ name: string; kind: string; file_rel: string; line: number }>,
    );

    if (rows.length === 0 || rows.length > 5) {
      return null;
    }

    if (rows.length === 1) {
      const row = rows[0] as { name: string; kind: string; file_rel: string; line: number };
      const file_short = _basename(row.file_rel);
      const loc = `\`${file_short}:${row.line}\` (${row.kind})`;
      const read_cmd = `token-goat read "${row.file_rel}::${pattern}"`;
      return (
        `Symbol \`${pattern}\` is indexed at ${loc} — use \`${read_cmd}\` ` +
        `to read its body directly, or \`token-goat symbol ${pattern}\` ` +
        `for all references (~95% fewer tok than grep).`
      );
    }

    const locations = rows.map((row) => `\`${_basename(row.file_rel)}:${row.line}\` (${row.kind})`);
    const loc_str = locations.join(", ");
    return (
      `Symbol \`${pattern}\` is indexed — use \`token-goat symbol ${pattern}\` ` +
      `to jump directly to its definition(s) (${loc_str}) ` +
      `instead of scanning files with grep (~95% fewer tok).`
    );
  } catch {
    return null;
  }
}

/** Return a `token-goat symbol` suggestion for a dotted-name grep pattern. */
export function _try_grep_dotted_hint(pattern: string, cwd: string | null): string | null {
  const m = _DOTTED_NAME_RE.exec(pattern);
  if (m === null) {
    return null;
  }
  const qualifier = m[1] as string;
  const method = m[2] as string;
  try {
    const cwd_path = validate_cwd(cwd, { caller: "grep-dotted-hint" });
    if (cwd_path === null) {
      return null;
    }
    const proj = project.find_project(cwd_path);
    if (proj === null) {
      return null;
    }

    const rows = db.openProjectReadonly(proj.hash, (conn) =>
      conn
        .prepare(
          "SELECT name, kind, file_rel, line FROM symbols " +
            "WHERE name = ? AND end_line IS NOT NULL " +
            "ORDER BY kind, line LIMIT 8",
        )
        .all(method) as Array<{ name: string; kind: string; file_rel: string; line: number }>,
    );

    if (rows.length === 0) {
      return null;
    }

    const qual_lower = qualifier.toLowerCase();
    const preferred = rows.filter((r) => _stemLower(r.file_rel).includes(qual_lower));
    if (preferred.length === 0) {
      return null;
    }
    const display_rows = preferred;
    if (display_rows.length > 3) {
      return null;
    }

    if (display_rows.length === 1) {
      const row = display_rows[0] as { name: string; kind: string; file_rel: string; line: number };
      const file_short = _basename(row.file_rel);
      const loc = `\`${file_short}:${row.line}\` (${row.kind})`;
      const read_cmd = `token-goat read "${row.file_rel}::${method}"`;
      return (
        `For \`${pattern}\`, \`${method}\` is indexed at ${loc} — use ` +
        `\`${read_cmd}\` to read its body directly (~95% fewer tok than grep).`
      );
    }

    const locations = display_rows.map((row) => `\`${_basename(row.file_rel)}:${row.line}\` (${row.kind})`);
    const loc_str = locations.join(", ");
    return (
      `For \`${pattern}\`, \`${method}\` is indexed — use ` +
      `\`token-goat symbol ${method}\` to jump to its definition(s) ` +
      `(${loc_str}) instead of scanning files with grep (~95% fewer tok).`
    );
  } catch {
    return null;
  }
}

/** Lowercased file stem (Path(p).stem.lower()). */
function _stemLower(p: string): string {
  const base = _basename(p);
  const ext = nodePath.extname(base);
  const stem = ext ? base.slice(0, -ext.length) : base;
  return stem.toLowerCase();
}

/** Increment grep-target count for *path* and return advisory text if threshold crossed. */
export function _try_grep_advisory_for_path(path: string | null, session_id: string, cwd?: string | null): string | null {
  if (!path || !session_id) {
    return null;
  }
  try {
    const sess = _get_session();
    const cache = sess.safe_load(session_id, { caller: "grep_advisory" });
    if (cache === null) {
      return null;
    }
    const hint = hints.maybe_grep_advisory(path, cache, cwd ?? null);
    try {
      sess.save(cache);
    } catch {
      // suppressed
    }
    return hint;
  } catch {
    _LOG.debug("_try_grep_advisory_for_path: error for path=%s", sanitize_log_str(path));
    return null;
  }
}

/** Check re-grep advisory for the native Grep tool. */
export function _handle_grep_advisory(payload: HookPayload): string | null {
  const args = self._extract_grep_args(payload);
  if (args === null) {
    return null;
  }
  const [, path] = args;
  if (!path) {
    return null;
  }
  const [session_id, cwd] = get_session_context(payload);
  if (!session_id) {
    return null;
  }
  return self._try_grep_advisory_for_path(path, session_id, cwd);
}

/** Check re-grep advisory for rg/grep Bash invocations. */
export function _handle_bash_grep_advisory(payload: HookPayload): string | null {
  const command = self._get_bash_command_from_payload(payload);
  if (command === null) {
    return null;
  }
  const intent = bash_parser.parse(command);
  if (intent.kind !== "grep" || !intent.pattern) {
    return null;
  }
  const path = intent.target_path;
  if (!path) {
    return null;
  }
  const [session_id, cwd] = get_session_context(payload);
  if (!session_id) {
    return null;
  }
  return self._try_grep_advisory_for_path(path, session_id, cwd);
}

/** Inject a `token-goat symbol` suggestion when the Grep pattern is an indexed symbol. */
export function _handle_grep_symbol_redirect(payload: HookPayload): HookResponse | null {
  const [session_id, cwd] = get_hook_context(payload);
  if (session_id === null) {
    return null;
  }

  const tool_input = get_tool_input(payload);
  const pattern = tool_input["pattern"];
  if (typeof pattern !== "string" || !pattern) {
    return null;
  }
  let hint_text: string | null;
  let stat_key: string;
  if (_IDENTIFIER_RE.test(pattern)) {
    hint_text = self._try_grep_symbol_hint(pattern, cwd);
    stat_key = "grep_symbol_redirect";
  } else if (_DOTTED_NAME_RE.test(pattern)) {
    hint_text = self._try_grep_dotted_hint(pattern, cwd);
    stat_key = "grep_dotted_redirect";
  } else {
    return null;
  }

  if (!hint_text) {
    return null;
  }

  let cache: SessionCache;
  try {
    cache = session.load(session_id);
  } catch {
    return null;
  }

  const fp = hints._hint_fingerprint(hint_text, pattern);
  if (cache.has_hint_fingerprint(fp)) {
    return null;
  }

  cache.mark_hint_seen(fp);
  cache.record_hint_emitted(stat_key);
  try {
    session.save(cache);
  } catch {
    // suppressed
  }
  return pre_tool_use_with_context(hint_text);
}

/** True when a Read already bounds its output via an explicit offset or limit. */
export function _read_is_windowed(tool_input: Record<string, unknown>): boolean {
  return (
    (tool_input["offset"] !== null && tool_input["offset"] !== undefined) ||
    (tool_input["limit"] !== null && tool_input["limit"] !== undefined)
  );
}

/** Format a byte count as KB or MB with one decimal place. */
export function _human_bytes(nbytes: number): string {
  if (nbytes >= 1_000_000) {
    return `${(nbytes / 1_000_000).toFixed(1)} MB`;
  }
  return `${(nbytes / 1_000).toFixed(0)} KB`;
}

/** Return the configured large-read redirect threshold in bytes (0 = disabled). */
export function _large_read_threshold(): number {
  try {
    return config.load().hints?.large_read_redirect_bytes ?? 0;
  } catch {
    return 0;
  }
}

const _PRESSURE_THRESHOLD_MULTIPLIERS: Record<string, number> = {
  cool: 1.0,
  warm: 0.67,
  hot: 0.33,
  critical: 0.18,
};

/** Return *base* scaled down by the context-pressure multiplier for *tier*. */
export function _pressure_scaled_threshold(base: number, tier: string): number {
  return Math.max(1, Math.trunc(base * (_PRESSURE_THRESHOLD_MULTIPLIERS[tier] ?? 1.0)));
}

const _PRESSURE_BASH_CAP_MULTIPLIERS: Record<string, number> = {
  cool: 1.0,
  warm: 0.7,
  hot: 0.45,
  critical: 0.25,
};

const _BASH_COMPRESS_BASE_TOKENS = 8_000;

/** Return *base* scaled by the bash-cap multiplier for *tier*. */
export function _pressure_scaled_bash_cap(base: number, tier: string): number {
  return Math.max(1, Math.trunc(base * (_PRESSURE_BASH_CAP_MULTIPLIERS[tier] ?? 1.0)));
}

/** Strip outputs from a Jupyter notebook and redirect the agent to the stripped copy. */
export function _handle_notebook_read(file_path: string, tool_input: Record<string, unknown>): HookResponse | null {
  if (!file_path.toLowerCase().endsWith(".ipynb")) {
    return null;
  }
  if (self._read_is_windowed(tool_input)) {
    return null;
  }
  try {
    if (!fs.existsSync(file_path)) {
      return null;
    }
    const raw = _readBytes(file_path);
    if (raw.length === 0) {
      return null;
    }
    const [sidecar_path] = notebook_compact.get_or_create_sidecar(raw, paths.dataDir());
    const saved = raw.length - fs.statSync(sidecar_path).size;
    if (saved < notebook_compact.NB_STRIP_MIN_SAVINGS) {
      return null;
    }
    const saved_kb = Math.trunc(saved / 1024);
    const reason = `Notebook outputs stripped to save ~${saved_kb} KB`;
    const context =
      `Cell outputs were stripped to reduce token cost (~${saved_kb} KB saved).\n\n` +
      `Read the stripped notebook (code sources preserved) at:\n  ${sidecar_path}\n\n` +
      "To read the original with outputs: add `offset: 0` to bypass this redirect.";
    return deny_redirect(reason, context);
  } catch {
    return null;
  }
}

/** Deny a full Read of an oversized file and redirect to surgical reads. */
export function _handle_large_read_redirect(
  file_path: string,
  tool_input: Record<string, unknown>,
  opts?: { floor?: number; tier?: string },
): HookResponse | null {
  const floor = opts?.floor ?? 0;
  const tier = opts?.tier ?? "cool";
  const threshold = self._large_read_threshold();
  if (threshold <= 0) {
    return null;
  }
  const scaled = floor === 0 ? self._pressure_scaled_threshold(threshold, tier) : threshold;
  const effective = Math.max(scaled, floor);
  if (self._read_is_windowed(tool_input)) {
    return null;
  }
  if (_BINARY_EXTENSIONS.has(_suffixLower(file_path))) {
    return null;
  }
  let size: number;
  try {
    size = fs.statSync(file_path).size;
  } catch {
    return null;
  }
  if (size < effective) {
    return null;
  }

  const name = _basename(file_path);
  const size_h = self._human_bytes(size);
  const approx_k = Math.max(1, Math.trunc(Math.trunc(size / 3) / 1000));
  const reason =
    `${name} is ${size_h} — a full read may overflow the context window; ` +
    "use a surgical read or re-issue Read with offset/limit to window it.";
  let context =
    `\`${name}\` is ${size_h} (~${approx_k}k tokens) — reading it whole can overflow a ` +
    "context window already loaded with the session baseline (the common failure mode " +
    "for spawned subagents). Read only what you need instead:\n" +
    `  - \`token-goat skeleton "${file_path}"\` — structure / symbol list\n` +
    `  - \`token-goat section "${file_path}::<Heading>"\` — one section\n` +
    `  - \`token-goat semantic "<what you need>"\` — search by meaning\n` +
    "  - `token-goat symbol <NAME>` — jump to a definition\n" +
    "Or re-issue this Read with `offset`/`limit` to window it — windowed reads pass " +
    "through unchanged, and unindexed files (transcripts, logs) support that path too.";
  const skeleton_text = self._try_get_inline_skeleton(file_path);
  if (skeleton_text) {
    context += `\n\nIndexed symbols in this file:\n${skeleton_text}`;
  }

  try {
    db.recordStat(undefined, "large_read_redirect", { detail: `${sanitize_log_str(file_path)} size=${size}` });
  } catch {
    // suppressed
  }
  return deny_redirect(reason, context);
}

/** Deny a whole-file bash cat/bat read of an indexed source file at warm+ pressure. */
export function _handle_indexed_cat_deny(
  file_path: string,
  tool_input: Record<string, unknown>,
  tier: string,
): HookResponse | null {
  if (!["warm", "hot", "critical"].includes(tier)) {
    return null;
  }
  if (self._read_is_windowed(tool_input)) {
    return null;
  }
  const skeleton_text = self._try_get_inline_skeleton(file_path);
  if (!skeleton_text) {
    return null;
  }
  const name = _basename(file_path);
  const reason = `\`${name}\` is indexed — use surgical reads instead of cat at ${tier} pressure.`;
  const context =
    `**${name}** is indexed by token-goat. ` +
    "Read only what you need instead of the whole file:\n" +
    `  - \`token-goat read "${file_path}::<symbol>"\` — one function/class\n` +
    `  - \`token-goat skeleton "${file_path}"\` — symbol list\n` +
    `  - \`token-goat section "${file_path}::<Heading>"\` — one section\n` +
    "Or re-issue as Read with offset+limit to window it.\n\n" +
    `Indexed symbols in this file:\n${skeleton_text}`;
  try {
    db.recordStat(undefined, "indexed_cat_deny", { detail: sanitize_log_str(file_path) });
  } catch {
    // suppressed
  }
  return deny_redirect(reason, context);
}

/** Advisory (non-blocking) surgical-read nudge for a whole-file bash cat of an indexed file. */
export function _handle_indexed_cat_advisory(
  file_path: string,
  tool_input: Record<string, unknown>,
  cache: unknown,
): HookResponse | null {
  if (self._read_is_windowed(tool_input)) {
    return null;
  }
  const skeleton_text = self._try_get_inline_skeleton(file_path);
  if (!skeleton_text) {
    return null;
  }
  const name = _basename(file_path);
  const hint =
    `\`${name}\` is indexed by token-goat — read only what you need instead of the whole file:\n` +
    `  \`token-goat read "${file_path}::<symbol>"\` — one function/class\n` +
    `  \`token-goat skeleton "${file_path}"\` — symbol list\n` +
    `Indexed symbols in this file:\n${skeleton_text}`;
  const fp = hints._hint_fingerprint(hint, file_path);
  const parts: string[] = [];
  if (!emit_if_new_hint(cache, fp, hint, "indexed_cat_advisory", parts)) {
    return null;
  }
  try {
    db.recordStat(undefined, "indexed_cat_advisory", { detail: sanitize_log_str(file_path) });
  } catch {
    // suppressed
  }
  return pre_tool_use_with_context(parts[0] as string);
}

/** Advisory hint for sed/awk windowed reads of indexed files. */
export function _handle_bash_range_read_hint(payload: HookPayload): HookResponse | null {
  const tool_input = get_tool_input(payload);
  const cmd = tool_input["command"] ?? "";
  if (typeof cmd !== "string") {
    return null;
  }
  const intent = bash_parser.parse(cmd);
  if (intent.kind !== "read") {
    return null;
  }
  if (intent.offset === null && intent.limit === null) {
    return null;
  }
  if (!intent.target_path) {
    return null;
  }
  const skeleton_text = self._try_get_inline_skeleton(intent.target_path);
  if (!skeleton_text) {
    return null;
  }
  const name = _basename(intent.target_path);
  let range_desc = "";
  if (intent.offset !== null && intent.limit !== null) {
    range_desc = ` lines ${intent.offset}–${intent.offset + intent.limit - 1}`;
  } else if (intent.offset !== null) {
    range_desc = ` from line ${intent.offset}`;
  } else if (intent.limit !== null) {
    range_desc = ` first ${intent.limit} lines`;
  }
  const hint =
    `\`${name}\`${range_desc} is indexed — use a symbol name instead of a line range:\n` +
    `  \`token-goat read "${intent.target_path}::<symbol>"\`\n\n` +
    `Indexed symbols:\n${skeleton_text}`;
  try {
    db.recordStat(undefined, "bash_range_read_hint", { detail: sanitize_log_str(intent.target_path) });
  } catch {
    // suppressed
  }
  return pre_tool_use_with_context(hint);
}

/** Advisory hint when a compound command has ≥1 read-type segment already cached. */
export function _handle_compound_cmd_hint(payload: HookPayload): HookResponse | null {
  const tool_input = get_tool_input(payload);
  const cmd = tool_input["command"] ?? "";
  if (typeof cmd !== "string" || !cmd) {
    return null;
  }

  if (!cmd.includes("&&") && !cmd.includes(";")) {
    return null;
  }

  const segments = bash_parser.split_compound(cmd);
  if (segments.length < 2) {
    return null;
  }

  const read_type_segments = segments.filter((s) => {
    const k = bash_parser.parse(s).kind;
    return k === "read" || k === "grep";
  });
  if (read_type_segments.length < 2) {
    return null;
  }

  const [, cwd] = get_session_context(payload);

  const cached_hits: Array<[string, string]> = [];
  try {
    for (const seg of read_type_segments) {
      const meta = bash_cache.find_cached_for_command(seg, cwd);
      if (meta !== null) {
        const short_id = cache_common.short_output_id(meta.output_id);
        cached_hits.push([seg, short_id]);
      }
    }
  } catch {
    _LOG.debug("compound_cmd_hint: cache lookup failed");
    return null;
  }

  if (cached_hits.length === 0) {
    return null;
  }

  const parts = cached_hits.map(([seg, oid]) => `  '${seg}' → token-goat bash-output ${oid}`);
  const hint =
    "[token-goat] Parts of this compound command are cached:\n" +
    parts.join("\n") +
    "\nRun them separately to use the cache.";
  try {
    db.recordStat(undefined, "compound_cmd_hint", { detail: sanitize_log_str(cmd, 200) });
  } catch {
    // suppressed
  }
  _LOG.debug("compound_cmd_hint: %d/%d segments cached", cached_hits.length, read_type_segments.length);
  return pre_tool_use_with_context(hint);
}

/** Advisory hint when the same file is Bash-read 3+ times in a session. */
export function _handle_bash_streak_hint(payload: HookPayload): HookResponse | null {
  const tool_input = get_tool_input(payload);
  const cmd = tool_input["command"] ?? "";
  if (typeof cmd !== "string") {
    return null;
  }
  const intent = bash_parser.parse(cmd);
  if (intent.kind !== "read" || !intent.target_path) {
    return null;
  }
  const [sid] = get_session_context(payload);
  if (!sid) {
    return null;
  }
  const sess = _get_session();
  const cache = sess.safe_load(sid, { caller: "bash_streak_hint" });
  if (cache === null) {
    return null;
  }
  const key = paths.normalizeKey(intent.target_path);
  const entry = cache.files[key];
  if (entry === undefined || entry.read_count < 2) {
    return null;
  }
  const _compact_ts = (cache as { last_compact_ts?: number }).last_compact_ts ?? 0.0;
  if (_compact_ts && entry.last_read_ts < _compact_ts) {
    return null;
  }
  const name = _basename(intent.target_path);
  const rel = intent.target_path;
  const skeleton_text = self._try_get_inline_skeleton(rel);
  const read_arg = _shlexQuote(`${rel}::<symbol>`);
  const sym_arg = _shlexQuote(rel);
  let hint: string;
  if (skeleton_text) {
    hint =
      `\`${name}\` has been read ${entry.read_count}× this session — use a symbol name instead of re-reading:\n` +
      `  \`token-goat read ${read_arg}\`\n\n` +
      `Indexed symbols:\n${skeleton_text}`;
  } else {
    hint =
      `\`${name}\` has been read ${entry.read_count}× this session — use surgical reads to avoid re-sending the whole file:\n` +
      `  \`token-goat symbol ${sym_arg}\`   (list symbols)\n` +
      `  \`token-goat read ${read_arg}\`   (read one symbol)`;
  }
  try {
    db.recordStat(sid, "bash_streak_hint", { detail: sanitize_log_str(rel) });
  } catch {
    // suppressed
  }
  return pre_tool_use_with_context(hint);
}

/** shlex.quote() — wrap in single quotes if the string contains shell-unsafe chars. */
function _shlexQuote(s: string): string {
  if (s === "") {
    return "''";
  }
  if (/^[A-Za-z0-9_@%+=:,./-]+$/.test(s)) {
    return s;
  }
  return "'" + s.replace(/'/g, "'\"'\"'") + "'";
}

// Commands that indicate status-checking / polling behaviour.
const _POLL_CMDS_RE =
  /\b(?:gh\s+(?:run|pr|workflow|check)|curl\b|wget\b|ping\b|docker\s+(?:ps|logs|stats|wait|inspect)|kubectl\s+(?:get|describe|logs|wait)|\bwatch\b)\b/i;
const _POLL_STALE_SECS = 600.0;
const _POLL_MIN_RUNS = 2;

/** Advisory hint when a status-checking command is run rapidly 3+ times. */
export function _handle_bash_poll_hint(payload: HookPayload): HookResponse | null {
  const tool_input = get_tool_input(payload);
  const cmd = tool_input["command"] ?? "";
  if (typeof cmd !== "string" || !_POLL_CMDS_RE.test(cmd)) {
    return null;
  }
  const [sid, cwd] = get_session_context(payload);
  if (!sid) {
    return null;
  }
  const cmd_sha = bash_cache.command_hash(cmd, cwd);
  const sess = _get_session();
  const cache = sess.safe_load(sid, { caller: "bash_poll_hint" });
  const entry = sess.lookup_bash_entry(sid, cmd_sha, { cache });
  if (entry === null || entry.run_count < _POLL_MIN_RUNS) {
    return null;
  }
  if (Date.now() / 1000 - entry.ts > _POLL_STALE_SECS) {
    return null;
  }
  const hint =
    `This command has run ${entry.run_count}× recently — looks like manual polling.\n` +
    "Replace repeated calls with a loop:\n" +
    "  `until <success-condition>; do sleep 5; done`\n" +
    `Or retrieve the cached output: \`token-goat bash-output ${entry.output_id}\``;
  try {
    db.recordStat(sid, "bash_poll_hint", { detail: sanitize_log_str(cmd.slice(0, 80)) });
  } catch {
    // suppressed
  }
  return pre_tool_use_with_context(hint);
}

const _CONTENT_DEDUP_MAX_BYTES = 500_000;
const _GREP_RESULT_CACHE_MAX_BYTES = 50_000;
const _GLOB_ROLLUP_THRESHOLD = 40;
const _GLOB_SAMPLE_PATHS = 20;
const _GLOB_ROLLUP_MAX_DIRS = 20;

const _INLINE_SKELETON_MAX_CHARS = 800;
const _INLINE_SKELETON_KINDS: readonly string[] = [
  "function", "method", "class", "interface", "struct", "trait", "enum",
  "type_alias", "constructor", "property", "decorator",
];

/** Return a compact skeleton listing for *file_path* from the index DB. */
export function _try_get_inline_skeleton(file_path: string): string {
  try {
    const abs_path = nodePath.isAbsolute(file_path) ? file_path : nodePath.join(process.cwd(), file_path);
    const cwd_path = nodePath.dirname(abs_path);
    const proj = project.find_project(cwd_path);
    if (proj === null) {
      return "";
    }
    const file_rel = read_replacement.resolve_file_rel(proj, abs_path);
    if (!file_rel) {
      return "";
    }

    const placeholders = _INLINE_SKELETON_KINDS.map(() => "?").join(",");
    const rows = db.openProjectReadonly(proj.hash, (conn) =>
      conn
        .prepare(
          "SELECT name, kind, line FROM symbols " +
            `WHERE file_rel = ? AND kind IN (${placeholders}) AND end_line IS NOT NULL ORDER BY line`,
        )
        .all(file_rel, ..._INLINE_SKELETON_KINDS) as Array<{ name: string; kind: string; line: number }>,
    );

    if (rows.length === 0) {
      return "";
    }

    const lines: string[] = rows.map(
      (row) => `  ${String(row.line).padStart(4, " ")}  ${row.kind.padEnd(12, " ")}  ${row.name}`,
    );

    const text = lines.join("\n");
    if (text.length <= _INLINE_SKELETON_MAX_CHARS) {
      return text;
    }
    const truncated = _rsplitOnce(text.slice(0, _INLINE_SKELETON_MAX_CHARS), "\n")[0] as string;
    const shown = (truncated.match(/\n/g)?.length ?? 0) + 1;
    const remaining = lines.length - shown;
    if (remaining > 0) {
      return truncated + `\n  (+${remaining} more symbols)`;
    }
    return truncated;
  } catch {
    return "";
  }
}

/** Python str.rsplit(sep, 1) — split on the last occurrence. */
function _rsplitOnce(s: string, sep: string): [string, string] {
  const idx = s.lastIndexOf(sep);
  if (idx === -1) {
    return [s, ""];
  }
  return [s.slice(0, idx), s.slice(idx + sep.length)];
}

/** Return a deny response if file_path's content was already read under a different path. */
export function _check_content_dedup(file_path: string, cache: unknown): HookResponse | null {
  try {
    if (!_isFile(file_path)) {
      return null;
    }
    const size = fs.statSync(file_path).size;
    if (size === 0 || size > _CONTENT_DEDUP_MAX_BYTES) {
      return null;
    }
    const raw = _readBytes(file_path);
    const sha16 = _sha1Hex(raw).slice(0, 16);
    const norm = _resolvePosix(file_path);
    const existing = (cache as SessionCache).get_file_content_path(sha16);
    if (existing === null || existing === norm) {
      return null;
    }
    return deny_redirect(
      "Duplicate file content",
      `This file has identical content to \`${existing}\`, which was already read this session.\n` +
        `Use \`${existing}\` instead to avoid loading identical bytes twice.`,
    );
  } catch {
    return null;
  }
}

/** True when *p* is an existing regular file (Path.is_file()). */
function _isFile(p: string): boolean {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

/** Path.resolve() normalised to forward slashes (str(p.resolve()).replace("\\","/")). */
function _resolvePosix(p: string): string {
  let resolved: string;
  try {
    resolved = fs.realpathSync(p);
  } catch {
    resolved = nodePath.resolve(p);
  }
  return resolved.replace(/\\/g, "/");
}

/** Compress a large glob result into a flat sample plus a directory-grouped summary. */
export function _rollup_glob_paths(paths_text: string): string {
  const lines = paths_text.split("\n").filter((ln) => ln.trim());
  const total = lines.length;
  if (total <= _GLOB_ROLLUP_THRESHOLD) {
    return paths_text;
  }
  const sample = lines.slice(0, _GLOB_SAMPLE_PATHS);
  const hidden_sample = total - sample.length;
  const dir_counts = new Map<string, number>();
  for (const line of lines) {
    const dir = nodePath.dirname(line.trim());
    dir_counts.set(dir, (dir_counts.get(dir) ?? 0) + 1);
  }
  const sorted_dirs = Array.from(dir_counts.entries()).sort((a, b) => {
    if (b[1] !== a[1]) {
      return b[1] - a[1];
    }
    return a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0;
  });
  const shown_dirs = sorted_dirs.slice(0, _GLOB_ROLLUP_MAX_DIRS);
  const hidden_dirs = sorted_dirs.length - shown_dirs.length;
  const hidden_dir_files = sorted_dirs.slice(_GLOB_ROLLUP_MAX_DIRS).reduce((acc, [, cnt]) => acc + cnt, 0);
  const dir_rows = shown_dirs.map(([d, cnt]) => `  ${String(cnt).padStart(4, " ")}  ${d}`);
  const n_dirs = sorted_dirs.length;
  const dir_label = n_dirs === 1 ? "directory" : "directories";
  let out =
    `${total} paths — first ${sample.length} shown; ${n_dirs} ${dir_label}:\n` +
    sample.join("\n") +
    (hidden_sample ? `\n  (+${hidden_sample} more not shown)\n` : "\n") +
    "Directory breakdown:\n" +
    dir_rows.join("\n");
  if (hidden_dirs) {
    const hidden_dir_label = hidden_dirs === 1 ? "directory" : "directories";
    out += `\n  ... and ${hidden_dirs} more ${hidden_dir_label} (${hidden_dir_files} files)`;
  }
  return out;
}

/** Deny a content-mode Grep over a single oversized file; redirect to bounded search. */
export function _handle_large_grep_redirect(payload: HookPayload): HookResponse | null {
  const threshold = self._large_read_threshold();
  if (threshold <= 0) {
    return null;
  }
  const tool_input = get_tool_input(payload);
  if (tool_input["output_mode"] !== "content" || (tool_input["head_limit"] !== null && tool_input["head_limit"] !== undefined)) {
    return null;
  }
  const path = tool_input["path"];
  if (typeof path !== "string" || !path) {
    return null;
  }
  let size: number;
  try {
    if (!_isFile(path)) {
      return null;
    }
    size = fs.statSync(path).size;
  } catch {
    return null;
  }
  if (size < threshold) {
    return null;
  }

  const name = _basename(path);
  const size_h = self._human_bytes(size);
  const pattern = tool_input["pattern"];
  const pat_s = typeof pattern === "string" && pattern ? pattern : "<pattern>";
  const reason =
    `Content grep over ${name} (${size_h}) can return a large slice of the file — ` +
    "narrow the search to avoid overflowing context.";
  const context =
    `\`${name}\` is ${size_h}; a \`content\`-mode Grep over it can stream back a large ` +
    "fraction of the file. Prefer a bounded search:\n" +
    `  - \`token-goat semantic "${pat_s}"\` — ranked matches by meaning\n` +
    `  - \`token-goat section "${path}::<Heading>"\` — the relevant section only\n` +
    "  - re-run Grep with `head_limit` set to cap the lines returned\n" +
    "  - or Read with `offset`/`limit` to window the file directly.";
  try {
    db.recordStat(undefined, "large_grep_redirect", { detail: `${sanitize_log_str(path)} size=${size}` });
  } catch {
    // suppressed
  }
  return deny_redirect(reason, context);
}

/** Return cached Glob results or a dedup hint when the same pattern ran recently. */
export function _handle_glob_dedup(payload: HookPayload): HookResponse | null {
  const args = self._extract_grep_args(payload);
  if (args === null) {
    return null;
  }
  const [pattern, path] = args;

  const [session_id] = get_hook_context(payload);
  if (session_id === null) {
    return null;
  }

  try {
    const cache = _get_session().load(session_id);
    const glob_entry = session.lookup_glob_entry(session_id, pattern, path, { cache });
    if (glob_entry !== null) {
      const _now = Date.now() / 1000;
      const age = _now - glob_entry.ts;
      const _glob_created_ts = (cache as { created_ts?: number }).created_ts;
      const _glob_session_age = _glob_created_ts !== undefined && _glob_created_ts !== null ? _now - _glob_created_ts : hints.STALE_READ_AGE_SECONDS;
      const _glob_stale_threshold = hints.compute_stale_threshold(_glob_session_age);
      if (age <= _glob_stale_threshold) {
        const cached_result = bash_cache.load_glob_result(session_id, pattern, path);
        if (cached_result !== null) {
          const path_label = path ? ` in ${_pyRepr(path)}` : "";
          const _cached_lines = cached_result.split("\n").filter((ln) => ln.trim());
          const _cached_display = _cached_lines.length > _GLOB_ROLLUP_THRESHOLD ? self._rollup_glob_paths(cached_result) : cached_result;
          const hint_text =
            `Note: Glob \`${sanitize_log_str(pattern, 100)}\`${path_label} ` +
            `ran ${Math.trunc(age)}s ago — cached result (${glob_entry.result_count || "?"} paths):\n` +
            `${_cached_display}\n` +
            "(Serving from cache. Run without hints to force a fresh scan.)";
          record_cached_stat("glob_result_cache_hit", sanitize_log_str(pattern, 200));
          _LOG.info("pre-read: glob result cache hit for pattern=%s (age=%ds)", sanitize_log_str(pattern, 100), Math.trunc(age));
          return pre_tool_use_with_context(hint_text);
        }
      }
    }
  } catch {
    _LOG.debug("pre-read: glob result cache check failed");
  }

  return run_dedup_hint(payload, {
    builder: (sid, cache) => hints.build_glob_dedup_hint({ session_id: sid, pattern, path, cache: cache as SessionCache | null }),
    stat_kind: "glob_dedup_hint",
    detail: sanitize_log_str(pattern, 200),
    log_label: "pre-read",
  });
}

/** Extract and validate the `command` string from a Bash tool payload. */
export function _get_bash_command_from_payload(payload: HookPayload): string | null {
  const tool_input = get_tool_input(payload);
  const command = tool_input["command"];
  if (typeof command !== "string" || !command) {
    return null;
  }
  return command;
}

const _BASH_DIRECT_SERVE_MAX_BYTES = 8_192;

/** Inject a small cached Bash output inline as additionalContext (direct-serve path). */
export function _try_bash_dedup_serve(payload: HookPayload): HookResponse | null {
  const command = self._get_bash_command_from_payload(payload);
  if (command === null) {
    return null;
  }

  const [session_id, cwd] = get_hook_context(payload);
  if (session_id === null) {
    return null;
  }

  try {
    const cmd_sha = bash_cache.command_hash(command, cwd);
    const cache = _get_session().load(session_id);
    const entry = session.lookup_bash_entry(session_id, cmd_sha, { cache });
    if (entry === null) {
      return null;
    }

    if ((entry.run_count ?? 1) > 1) {
      return null;
    }

    if (
      bash_cache.is_git_mutable_command(command) &&
      Object.values(cache.files).some((fe) => ((fe as { last_edit_ts?: number }).last_edit_ts ?? 0.0) > entry.ts)
    ) {
      return null;
    }

    const _now = Date.now() / 1000;
    const age = _now - entry.ts;
    const _sess_created = (cache as { created_ts?: number }).created_ts;
    const _sess_age = _sess_created !== undefined && _sess_created !== null ? _now - _sess_created : hints.STALE_READ_AGE_SECONDS;
    const _stale_thresh = hints.compute_stale_threshold(_sess_age);
    if (age > _stale_thresh && !bash_cache.is_git_immutable_command(command)) {
      return null;
    }

    const text = bash_cache.load_output(entry.output_id);
    if (!text) {
      return null;
    }

    const actual_bytes = _utf8_bytes(text).length;
    if (actual_bytes > _BASH_DIRECT_SERVE_MAX_BYTES) {
      return null;
    }

    const cmd_short = sanitize_log_str(command, 80);
    const hint_text =
      `Note: Bash \`${cmd_short}\` ran ${Math.trunc(age)}s ago — cached output ` +
      `(${actual_bytes} bytes):\n${text}\n` +
      "(Serving from cache. Re-run to force a fresh result.)";
    record_cached_stat("bash_direct_serve", sanitize_log_str(command, 200));
    _LOG.info("pre-read: bash direct serve command=%s age=%ds bytes=%d", sanitize_log_str(command, 80), Math.trunc(age), actual_bytes);
    return pre_tool_use_with_context(hint_text);
  } catch {
    _LOG.debug("pre-read: bash direct serve failed");
    return null;
  }
}

/** Return a dedup hint when this exact Bash command ran earlier in the session. */
export function _handle_bash_dedup(payload: HookPayload): HookResponse | null {
  const command = self._get_bash_command_from_payload(payload);
  if (command === null) {
    return null;
  }

  const direct = self._try_bash_dedup_serve(payload);
  if (direct !== null) {
    return direct;
  }

  const [, cwd] = get_session_context(payload);
  return run_dedup_hint(payload, {
    builder: (sid, cache) => hints.build_bash_dedup_hint({ session_id: sid, command, cache: cache as SessionCache | null, cwd }),
    stat_kind: "bash_dedup_hint",
    detail: sanitize_log_str(command, 200),
    log_label: "pre-read",
  });
}

/** Serve advisory context for env probe commands from the cross-session disk cache. */
export function _handle_env_probe_serve(payload: HookPayload): HookResponse | null {
  const command = self._get_bash_command_from_payload(payload);
  if (command === null) {
    return null;
  }
  if (!bash_cache.is_env_probe_command(command)) {
    return null;
  }

  const [, cwd] = get_session_context(payload);
  try {
    const meta = bash_cache.find_cached_for_command(command, cwd);
    if (meta === null) {
      return null;
    }
    const text = bash_cache.load_output(meta.output_id);
    if (!text) {
      return null;
    }
    const cmd_short = sanitize_log_str(command, 80);
    const hint_text = `[token-goat] \`${cmd_short}\` prior output (env probe — re-run to get a fresh result):\n${text.replace(/\s+$/, "")}`;
    record_cached_stat("env_probe_cache_hit", sanitize_log_str(command, 200));
    _LOG.info("pre-read: env-probe serve command=%s bytes=%d", sanitize_log_str(command, 80), text.length);
    return pre_tool_use_with_context(hint_text);
  } catch {
    _LOG.debug("pre-read: env-probe serve failed");
    return null;
  }
}

/** Hint when a bash read-equivalent targets a file already read once this session. */
export function _handle_bash_already_read(payload: HookPayload): HookResponse | null {
  const tool_name = payload.tool_name;
  if (tool_name !== "Bash") {
    return null;
  }
  const tool_input = get_tool_input(payload);
  const cmd = tool_input["command"] ?? "";
  if (typeof cmd !== "string") {
    return null;
  }
  const intent = bash_parser.parse(cmd);
  if (intent.kind !== "read" || !intent.target_path) {
    return null;
  }
  const [sid, cwd] = get_session_context(payload);
  if (!sid) {
    return null;
  }
  try {
    const sess = _get_session();
    const cache = sess.safe_load(sid, { caller: "bash_already_read" });
    if (cache === null) {
      return null;
    }
    const path_key = paths.normalizePathKey(intent.target_path, cwd ?? undefined);
    const entry = cache.files[path_key];
    if (entry === undefined || entry.read_count !== 1) {
      return null;
    }
    const _compact_ts = (cache as { last_compact_ts?: number }).last_compact_ts ?? 0.0;
    if (_compact_ts && entry.last_read_ts < _compact_ts) {
      return null;
    }
    const display = sanitize_log_str(intent.target_path, 80);
    const hint_text = `[token-goat] \`${display}\` already read ${entry.read_count}× this session — use \`token-goat read "${display}::SymbolName"\` for a surgical pull`;
    record_cached_stat("bash_read_equiv_already_read", sanitize_log_str(intent.target_path, 200));
    _LOG.info("pre-read: bash-already-read path=%s read_count=%d", sanitize_log_str(intent.target_path, 80), entry.read_count);
    return pre_tool_use_with_context(hint_text);
  } catch {
    _LOG.debug("pre-read: bash-already-read failed");
    return null;
  }
}

/** Serve advisory context for dependency-listing commands from the cross-session disk cache. */
export function _handle_dep_list_serve(payload: HookPayload): HookResponse | null {
  const command = self._get_bash_command_from_payload(payload);
  if (command === null) {
    return null;
  }
  if (!bash_cache.is_dep_list_command(command)) {
    return null;
  }

  const [, cwd] = get_session_context(payload);
  try {
    const meta = bash_cache.find_cached_for_command(command, cwd);
    if (meta === null) {
      return null;
    }
    const text = bash_cache.load_output(meta.output_id);
    if (!text) {
      return null;
    }
    const cmd_short = sanitize_log_str(command, 80);
    const hint_text = `[token-goat] \`${cmd_short}\` prior output (lockfile unchanged — re-run to refresh):\n${text.replace(/\s+$/, "")}`;
    record_cached_stat("dep_list_cache_hit", sanitize_log_str(command, 200));
    _LOG.info("pre-read: dep-list serve command=%s bytes=%d", sanitize_log_str(command, 80), text.length);
    return pre_tool_use_with_context(hint_text);
  } catch {
    _LOG.debug("pre-read: dep-list serve failed");
    return null;
  }
}

/** Return a cache-hit hint when this Bash command has a cached output from a prior session. */
export function _handle_bash_cache_hit(payload: HookPayload): HookResponse | null {
  const command = self._get_bash_command_from_payload(payload);
  if (command === null) {
    return null;
  }

  const [, cwd] = get_session_context(payload);
  return run_dedup_hint(payload, {
    builder: (sid, cache) => hints.build_bash_cache_hit_hint({ session_id: sid, command, cache: cache as SessionCache | null, cwd }),
    stat_kind: "bash_cache_hit_hint",
    detail: sanitize_log_str(command, 200),
    log_label: "pre-read",
  });
}

/** Return cached Grep results or a dedup hint when a Bash grep repeats a prior search. */
export function _handle_bash_grep_dedup(payload: HookPayload): HookResponse | null {
  const command = self._get_bash_command_from_payload(payload);
  if (command === null) {
    return null;
  }

  const intent = bash_parser.parse(command);
  if (intent.kind !== "grep" || !intent.pattern) {
    return null;
  }

  const pattern = intent.pattern;
  const path = intent.target_path;

  const [sid] = get_session_context(payload);
  if (sid) {
    try {
      // bash_cache._normalize_grep_path is module-private there; reimplement the
      // same normalisation locally (backslash→slash, strip leading ./, strip
      // trailing slashes) so the in-memory lookup key matches the disk cache key.
      const _ngp = (p: string): string => {
        let s = p.replace(/\\/g, "/").replace(/^(\.\/)+/, "");
        const strippedTrail = s.replace(/\/+$/, "");
        return strippedTrail || s;
      };
      const _lgr = bash_cache.load_grep_result;
      const cache = _get_session().load(sid);
      const norm_path = path !== null ? _ngp(path) : "";
      let grep_entry: { pattern: string; path: string | null; ts: number; result_count: number | null } | null = null;
      const greps = (cache as { greps?: unknown }).greps;
      if (cache !== null && Array.isArray(greps) && greps.length > 0) {
        for (let i = greps.length - 1; i >= 0; i -= 1) {
          const _e = greps[i] as { pattern: string; path: string | null; ts: number; result_count: number | null };
          if (_e.pattern === pattern && (_e.path !== null ? _ngp(_e.path) : "") === norm_path) {
            grep_entry = _e;
            break;
          }
        }
      }
      if (grep_entry !== null) {
        const _now = Date.now() / 1000;
        const age = _now - grep_entry.ts;
        const _sess_created = (cache as { created_ts?: number }).created_ts;
        const _sess_age = _sess_created !== undefined && _sess_created !== null ? _now - _sess_created : hints.STALE_READ_AGE_SECONDS;
        const _stale_thresh = hints.compute_stale_threshold(_sess_age);
        if (age <= _stale_thresh) {
          const stored_path = grep_entry.path;
          let cached_result = _lgr(sid, pattern, stored_path, null, null, "content");
          if (cached_result === null) {
            cached_result = _lgr(sid, pattern, stored_path, null, null, null);
          }
          if (cached_result !== null) {
            const path_label = path ? ` in ${_pyRepr(path)}` : "";
            const hint_text =
              `Note: Grep \`${sanitize_log_str(pattern, 100)}\`${path_label} ` +
              `ran ${Math.trunc(age)}s ago via Grep tool — cached result (${grep_entry.result_count || "?"} matches):\n` +
              `${cached_result}\n` +
              "(Serving from cache. Run without hints to force a fresh search.)";
            record_cached_stat("bash_grep_result_cache_hit", sanitize_log_str(pattern, 200));
            _LOG.info("pre-read: bash-grep cache hit pattern=%s (age=%ds)", sanitize_log_str(pattern, 100), Math.trunc(age));
            return pre_tool_use_with_context(hint_text);
          }
        }
      }
    } catch {
      _LOG.debug("pre-read: bash-grep cache check failed");
    }
  }

  return run_dedup_hint(payload, {
    builder: (sid2, cache) => hints.build_grep_dedup_hint({ session_id: sid2, pattern, path, cache: cache as SessionCache | null }),
    stat_kind: "grep_dedup_hint",
    detail: sanitize_log_str(pattern, 200),
    log_label: "pre-read",
  });
}

// ===========================================================================
// pre-read helpers — recovery / window-coverage / re-read deny / task output
// ===========================================================================

/** Estimate bytes of context the recovery hint prevents from being re-read. */
export function _estimate_recovery_context_bytes(cache: unknown): number {
  try {
    let total = 0;
    const bash_hist = ((cache as { bash_history?: unknown }).bash_history ?? {}) as Record<string, unknown>;
    for (const be of Object.values(bash_hist)) {
      total += ((be as { stdout_bytes?: number }).stdout_bytes ?? 0) + ((be as { stderr_bytes?: number }).stderr_bytes ?? 0);
    }
    const web_hist = ((cache as { web_history?: unknown }).web_history ?? {}) as Record<string, unknown>;
    for (const we of Object.values(web_hist)) {
      total += (we as { body_bytes?: number }).body_bytes ?? 0;
    }
    return Math.max(0, total);
  } catch {
    return 0;
  }
}

/** Parse a recovery_pending sidecar file, returning [hint_text, bytes_estimate]. */
export function _parse_recovery_sidecar(raw: string): [string, number] {
  const raw_stripped = raw.trim();
  if (raw_stripped.startsWith("{")) {
    try {
      const data = JSON.parse(raw_stripped) as Record<string, unknown>;
      const hint = String(data["hint"] ?? raw);
      const estimate = Math.trunc(Number(data["bytes_estimate"] ?? 0));
      return [hint, Math.max(0, Number.isFinite(estimate) ? estimate : 0)];
    } catch {
      // fall through to plain-text
    }
  }
  return [raw, 0];
}

/** Return the deferred recovery hint text and consume the sidecar, or null. */
export function _check_recovery_pending(session_id: string, cache: unknown): string | null {
  if ((cache as { recovery_injected?: boolean })?.recovery_injected) {
    return null;
  }
  try {
    const sidecar = paths.recoveryPendingPath(session_id);
    if (!fs.existsSync(sidecar)) {
      return null;
    }
    const raw = fs.readFileSync(sidecar, "utf8");
    try {
      fs.unlinkSync(sidecar);
    } catch {
      // missing_ok=True analogue
    }
    const [hint, stored_bytes_estimate] = self._parse_recovery_sidecar(raw);
    try {
      (cache as { recovery_injected?: boolean }).recovery_injected = true;
    } catch {
      // suppressed
    }
    const hint_bytes = _utf8_bytes(hint).length;
    _LOG.info(
      "pre-read: deferred recovery hint injected for session=%s (%d chars, stored_estimate=%d)",
      session_id.slice(0, 16),
      hint_bytes,
      stored_bytes_estimate,
    );
    try {
      const _BYTES_PER_TOKEN = 4;
      const context_bytes = stored_bytes_estimate > 0 ? stored_bytes_estimate : self._estimate_recovery_context_bytes(cache);
      const context_tokens = context_bytes > 0 ? Math.max(1, Math.trunc(context_bytes / _BYTES_PER_TOKEN)) : 0;
      const overhead_tokens = Math.max(1, Math.trunc(hint_bytes / _BYTES_PER_TOKEN));
      if (context_bytes > 0) {
        db.recordStat(undefined, "compact_recovery", {
          bytesSaved: context_bytes,
          tokensSaved: context_tokens,
          detail: `session=${session_id.slice(0, 8)}`,
        });
      }
      db.recordStat(undefined, "compact_recovery_overhead", {
        bytesSaved: -hint_bytes,
        tokensSaved: -overhead_tokens,
        detail: `session=${session_id.slice(0, 8)}`,
      });
    } catch {
      _LOG.debug("pre-read: recovery stat record failed");
    }
    return hint;
  } catch {
    _LOG.debug("pre-read: recovery sidecar check failed");
    return null;
  }
}

/** Flush a deferred mark_hint_seen save if _pending_hint_save is set. */
export function _flush_pending_hint_save(cache: unknown): void {
  try {
    if ((cache as { _pending_hint_save?: boolean })?._pending_hint_save) {
      (cache as { _pending_hint_save?: boolean })._pending_hint_save = false;
      _get_session().save(cache as SessionCache);
    }
  } catch {
    // suppressed
  }
}

// mirrors session.py _UNKNOWN_END_SENTINEL.
const _SESSION_UNKNOWN_END = 99_999;

/** Return True if [req_start, req_end] is fully covered by the recorded ranges. */
export function _window_is_covered(
  line_ranges: Array<[number, number]>,
  req_start: number,
  req_end: number | null,
): boolean {
  if (line_ranges.some(([s, e]) => s === 0 && e === 0)) {
    return true;
  }
  if (req_end === null) {
    return line_ranges.some(([rs, re]) => rs <= req_start && re - rs >= _SESSION_UNKNOWN_END);
  }
  return line_ranges.some(([rs, re]) => rs <= req_start && re >= req_end);
}

/** Format recorded line_ranges for a deny message. */
export function _format_read_ranges(line_ranges: Array<[number, number]>): string {
  if (line_ranges.some(([s, e]) => s === 0 && e === 0)) {
    return "full file";
  }
  const parts: string[] = [];
  for (const [s, e] of line_ranges.slice(0, 5)) {
    parts.push(e >= s + _SESSION_UNKNOWN_END ? `${s}+` : `${s}–${e}`);
  }
  if (line_ranges.length > 5) {
    parts.push(`+${line_ranges.length - 5} more`);
  }
  return parts.join(", ");
}

/** Return sub-ranges of [req_start, req_end] not covered by cached_ranges. */
export function _uncovered_subranges(
  cached_ranges: Array<[number, number]>,
  req_start: number,
  req_end: number,
): Array<[number, number]> {
  if (cached_ranges.some(([s, e]) => s === 0 && e === 0)) {
    return [];
  }
  let pending: Array<[number, number]> = [[req_start, req_end]];
  const sortedRanges = [...cached_ranges].sort((a, b) => (a[0] !== b[0] ? a[0] - b[0] : a[1] - b[1]));
  for (const [cs, ce] of sortedRanges) {
    const nxt: Array<[number, number]> = [];
    for (const [us, ue] of pending) {
      if (ce < us || cs > ue) {
        nxt.push([us, ue]);
      } else {
        if (cs > us) {
          nxt.push([us, cs - 1]);
        }
        if (ce < ue) {
          nxt.push([ce + 1, ue]);
        }
      }
    }
    pending = nxt;
  }
  return pending;
}

/** Advisory hint when a Read range partially overlaps cached line ranges. */
export function _handle_partial_overlap_hint(
  file_path: string,
  tool_input: Record<string, unknown>,
  entry: unknown,
): HookResponse | null {
  const line_ranges: Array<[number, number]> = ((entry as { line_ranges?: unknown }).line_ranges ?? []) as Array<[number, number]>;
  if (line_ranges.length === 0) {
    return null;
  }

  const raw_offset = tool_input["offset"];
  const raw_limit = tool_input["limit"];
  if (!is_real_int(raw_offset) || !is_real_int(raw_limit) || raw_limit <= 0) {
    return null;
  }

  const req_start = Math.max(0, raw_offset) + 1;
  const req_end = req_start + raw_limit - 1;

  const has_overlap =
    line_ranges.some(([cs, ce]) => !(cs === 0 && ce === 0) && cs <= req_end && ce >= req_start) ||
    line_ranges.some(([cs, ce]) => cs === 0 && ce === 0);
  if (!has_overlap) {
    return null;
  }

  const uncovered = self._uncovered_subranges(line_ranges, req_start, req_end);
  if (uncovered.length === 0) {
    return null;
  }

  const [first_start, first_end] = uncovered[0] as [number, number];
  const suggested_offset = first_start - 1;
  const suggested_limit = first_end - first_start + 1;

  const covered_count = req_end - req_start + 1 - uncovered.reduce((acc, [s, e]) => acc + (e - s + 1), 0);
  const filename = _basename(file_path);
  const ranges_fmt = self._format_read_ranges(line_ranges);

  let hint: string;
  if (uncovered.length === 1) {
    hint =
      `Note: ${covered_count} line(s) of \`${filename}\` in the requested range are already in context ` +
      `(cached: ${ranges_fmt}).\n` +
      `Consider reading only the uncovered portion: offset=${suggested_offset} limit=${suggested_limit}`;
  } else {
    const parts = uncovered.map(([s, e]) => `offset=${s - 1} limit=${e - s + 1}`);
    hint =
      `Note: ${covered_count} line(s) of \`${filename}\` in the requested range are already in context ` +
      `(cached: ${ranges_fmt}).\n` +
      `Uncovered sub-ranges: ${parts.join(", ")}`;
  }

  record_cached_stat("read_partial_overlap_hint", sanitize_log_str(file_path, 200));
  _LOG.debug("pre-read: partial overlap hint file=%s covered=%d", sanitize_log_str(file_path, 100), covered_count);
  return pre_tool_use_with_context(hint);
}

/** Deny a Read whose window is already in context from this session. */
export function _handle_reread_deny(
  session_id: string,
  file_path: string,
  tool_input: Record<string, unknown>,
  cache: unknown,
): HookResponse | null {
  let min_bytes: number;
  try {
    const hints_cfg = config.load().hints;
    if (!hints_cfg?.reread_deny) {
      return null;
    }
    min_bytes = hints_cfg.reread_deny_min_bytes ?? 2048;
  } catch {
    return null;
  }

  if (cache === null || cache === undefined) {
    return null;
  }

  let entry: unknown;
  try {
    const key = session._normalize_path(file_path);
    entry = (cache as SessionCache).files[key];
  } catch {
    return null;
  }

  if (entry === undefined || entry === null) {
    return null;
  }

  const ent = entry as { last_edit_ts: number; last_read_ts: number; read_mtime_ns: number | null; read_size: number | null; line_ranges: Array<[number, number]> };
  if (ent.last_edit_ts > ent.last_read_ts) {
    return null;
  }

  let disk_stat: fs.Stats;
  try {
    disk_stat = fs.statSync(file_path);
  } catch {
    return null;
  }

  if (min_bytes > 0 && disk_stat.size < min_bytes) {
    return null;
  }

  const disk_mtime_ns = _statMtimeNs(disk_stat);
  if (ent.read_mtime_ns !== null && (disk_mtime_ns !== ent.read_mtime_ns || disk_stat.size !== ent.read_size)) {
    return null;
  }

  const raw_offset = tool_input["offset"];
  const raw_limit = tool_input["limit"];
  const req_start = is_real_int(raw_offset) ? Math.max(0, raw_offset) + 1 : 1;
  let req_end: number | null;
  if (is_real_int(raw_limit) && raw_limit > 0) {
    req_end = req_start + raw_limit - 1;
  } else {
    req_end = null;
  }

  if (!self._window_is_covered(ent.line_ranges, req_start, req_end)) {
    return null;
  }

  try {
    const stored_sha = session.get_snapshot_sha(session_id, file_path, { cache: cache as SessionCache });
    if (stored_sha) {
      const current_sha = _sha256Hex(_readBytes(file_path));
      if (current_sha !== stored_sha) {
        return null;
      }
    }
  } catch {
    // fail-soft; never block a Read
  }

  const key = session._normalize_path(file_path);
  const _end_tag = req_end !== null ? String(req_end) : "eof";
  const deny_fp = `reread_deny:${key}:${req_start}:${_end_tag}`;
  try {
    if ((cache as SessionCache).has_hint_fingerprint(deny_fp)) {
      _LOG.debug("reread_deny: anti-loop pass-through for %s (%d+)", sanitize_log_str(file_path), req_start);
      return null;
    }
    (cache as SessionCache).mark_hint_seen(deny_fp);
  } catch {
    return null;
  }

  const name = _basename(file_path);
  const prior = self._format_read_ranges(ent.line_ranges);
  const window_str = req_end !== null ? `lines ${req_start}–${req_end}` : `lines ${req_start}+`;
  const reason = `${name} ${window_str} already in context this session — re-read is redundant.`;
  let _symbol_read_line = `  \`token-goat read "${file_path}::SymbolName"\` — extract one symbol`;
  try {
    const _proj = project.find_project(nodePath.dirname(file_path));
    if (_proj !== null) {
      const _file_rel = read_replacement.resolve_file_rel(_proj, file_path);
      if (_file_rel) {
        const _sym_rows = db.openProjectReadonly(_proj.hash, (conn) =>
          conn
            .prepare(
              "SELECT name FROM symbols " +
                "WHERE file_rel = ? AND kind NOT IN ('import', 'variable') " +
                "ORDER BY line LIMIT 8",
            )
            .all(_file_rel) as Array<{ name: string }>,
        );
        if (_sym_rows.length > 0) {
          const _names = _sym_rows.map((r) => String(r.name));
          const _rest = _names.slice(1).map((_n) => `, \`::${_n}\``).join("");
          _symbol_read_line = `  \`token-goat read "${_file_rel}::${_names[0] as string}"\`${_rest} — extract one symbol`;
        }
      }
    }
  } catch {
    // suppressed
  }
  const context =
    `\`${name}\` ${window_str} is already in context (prior reads this session: ${prior}). ` +
    "The file is unchanged. Use what is already in context, or read only the new lines:\n" +
    "  `token-goat symbol <NAME>` — jump to a definition\n" +
    `${_symbol_read_line}\n` +
    "  Re-issue this Read with `offset`/`limit` set to just the lines you need.\n" +
    "(A second identical request passes through automatically if you genuinely need it.)";
  try {
    record_cached_stat("reread_deny", sanitize_log_str(file_path, 512));
  } catch {
    // suppressed
  }
  return deny_redirect(reason, context);
}

/** st_mtime_ns analogue from a node Stats object (mtimeMs is float ms → ns int). */
function _statMtimeNs(st: fs.Stats): number {
  const bigNs = (st as fs.Stats & { mtimeNs?: bigint }).mtimeNs;
  if (typeof bigNs === "bigint") {
    return Number(bigNs);
  }
  return Math.round(st.mtimeMs * 1_000_000);
}

/** Detect Claude task-output temp files and redirect subsequent reads to bash-output. */
export function _handle_task_output_read(file_path: string, session_id: string | null): HookResponse | null {
  const _task_output_id = _bcFn("_task_output_id");
  if (_task_output_id === undefined) {
    return null; // helper not yet ported in bash_compress — degrade to no-op
  }

  const task_id = _task_output_id(String(file_path) as never) as string | null;
  if (task_id === null) {
    return null;
  }
  if (!session_id) {
    return null;
  }

  const _sess_mod = _get_session();
  const cache = _sess_mod.safe_load(session_id, { caller: "_handle_task_output_read" });
  if (cache === null) {
    return null;
  }

  const stored: Record<string, string> = ((cache as { stored_task_outputs?: unknown }).stored_task_outputs ?? {}) as Record<string, string>;
  if (task_id in stored) {
    const output_id = stored[task_id] as string;
    const reason = `Task output ${task_id} already stored as bash-output blob ${output_id}.`;
    const context =
      `[token-goat] Task output \`${task_id}\` was already read and stored. ` +
      "Recall it without re-reading the file:\n" +
      `  token-goat bash-output ${output_id}\n` +
      `  token-goat bash-output ${output_id} --grep <pattern>\n` +
      `  token-goat bash-output ${output_id} --head 50\n` +
      `  token-goat bash-output ${output_id} --tail 50\n` +
      `  token-goat bash-output ${output_id} --section "Heading"\n`;
    return deny_redirect(reason, context);
  }

  const _MAX_TASK_BYTES = 512 * 1024;
  let content: string;
  try {
    const file_size = fs.statSync(file_path).size;
    if (file_size > _MAX_TASK_BYTES) {
      const fd = fs.openSync(file_path, "r");
      try {
        const buf = Buffer.alloc(_MAX_TASK_BYTES);
        const n = fs.readSync(fd, buf, 0, _MAX_TASK_BYTES, 0);
        content = buf.subarray(0, n).toString("utf8") + "\n[token-goat: truncated at 512 KB]";
      } finally {
        fs.closeSync(fd);
      }
    } else {
      content = fs.readFileSync(file_path, "utf8");
    }
  } catch (exc) {
    _LOG.debug("task-output: could not read %s: %s", sanitize_log_str(String(file_path)), String(exc));
    return null;
  }

  let meta: { output_id: string } | null;
  try {
    meta = bash_cache.store_output(session_id, `# task-output ${task_id}`, content, "", 0);
  } catch {
    _LOG.debug("task-output: store_output failed for task_id=%s", task_id);
    return null;
  }

  if (meta === null) {
    return null;
  }

  (cache as SessionCache).stored_task_outputs[task_id] = meta.output_id;
  try {
    _sess_mod.save(cache);
  } catch {
    // suppressed
  }

  const n_lines = (content.match(/\n/g)?.length ?? 0) + (content && !content.endsWith("\n") ? 1 : 0);
  const hint =
    `[token-goat] Task output \`${task_id}\` stored (${_thousands(n_lines)} lines / ` +
    `${_thousands(content.length)} bytes) as bash-output \`${meta.output_id}\`. ` +
    "Use surgical reads instead of re-reading this file:\n" +
    `  token-goat bash-output ${meta.output_id}                     — full output\n` +
    `  token-goat bash-output ${meta.output_id} --head 50           — first 50 lines\n` +
    `  token-goat bash-output ${meta.output_id} --tail 50           — last 50 lines\n` +
    `  token-goat bash-output ${meta.output_id} --grep <pattern>    — grep for pattern\n` +
    `  token-goat bash-output ${meta.output_id} --section "Heading" — jump to section\n`;
  return pre_tool_use_with_context(hint);
}

/** Format an integer with thousands separators (Python f"{n:,}"). */
function _thousands(n: number): string {
  return n.toLocaleString("en-US");
}

// ===========================================================================
// pre_read — public entrypoint
// ===========================================================================

/** Pre-read hook: image shrinking, dedup hints, and diff-aware re-read hints. */
// ASYNC: pre_read awaits _try_shrink_image (the real image_shrink module is
// async). The hook dispatcher already `await`s handlers (sync or async), so this
// is transparent to dispatch; direct callers must await the returned Promise.
export async function pre_read(payload: HookPayload): Promise<HookResponse> {
  _call_index += 1;

  const tool_name = payload.tool_name;

  if (tool_name === "Bash") {
    // Fast-path: skip uninteresting Bash commands without loading session/DB.
    const _fp_input = get_tool_input(payload);
    const _fp_cmd = ((_fp_input["command"] ?? "") as string).trim?.() ?? "";
    if (_fp_cmd && !_fp_cmd.includes("&&")) {
      const _fpWords = _fp_cmd.split(/\s+/).filter((t) => t.length > 0);
      const _fp_first = (_fpWords.length > 0 ? (_fpWords[0] as string) : "").toLowerCase();
      if (_fp_first && !_fp_first.startsWith("token-goat") && !_fp_first.startsWith("token_goat")) {
        if (
          !bash_detect.detect([_fp_first]) &&
          !_READ_BINS.has(_fp_first) &&
          !_GREP_BINS.has(_fp_first) &&
          !_GLOB_BINS.has(_fp_first) &&
          !_BASH_FAST_PATH_EXCLUDE.has(_fp_first)
        ) {
          return CONTINUE();
        }
      }
    }
    // Deferred recovery hint.
    const [_bash_session_id] = get_session_context(payload);
    if (_bash_session_id) {
      const _sess_mod = _get_session();
      const _bash_cache = _sess_mod.safe_load(_bash_session_id, { caller: "pre_read_bash" });
      const _recovery_text = self._check_recovery_pending(_bash_session_id, _bash_cache);
      if (_recovery_text) {
        return pre_tool_use_with_context(_recovery_text);
      }
    }

    const dedup = self._handle_bash_dedup(payload);
    if (dedup !== null) {
      return dedup;
    }

    const env_probe = self._handle_env_probe_serve(payload);
    if (env_probe !== null) {
      return env_probe;
    }

    const dep_list = self._handle_dep_list_serve(payload);
    if (dep_list !== null) {
      return dep_list;
    }

    const bash_already_read = self._handle_bash_already_read(payload);
    if (bash_already_read !== null) {
      return bash_already_read;
    }

    const cache_hit = self._handle_bash_cache_hit(payload);
    if (cache_hit !== null) {
      return cache_hit;
    }

    const compound_hint = self._handle_compound_cmd_hint(payload);
    if (compound_hint !== null) {
      return compound_hint;
    }

    const bash_grep_dedup = self._handle_bash_grep_dedup(payload);
    if (bash_grep_dedup !== null) {
      return bash_grep_dedup;
    }

    const _bash_grep_advisory = self._handle_bash_grep_advisory(payload);
    if (_bash_grep_advisory) {
      return pre_tool_use_with_context(_bash_grep_advisory);
    }

    const bash_range_hint = self._handle_bash_range_read_hint(payload);
    if (bash_range_hint !== null) {
      return bash_range_hint;
    }

    const bash_streak_hint = self._handle_bash_streak_hint(payload);
    if (bash_streak_hint !== null) {
      return bash_streak_hint;
    }

    const bash_poll_hint = self._handle_bash_poll_hint(payload);
    if (bash_poll_hint !== null) {
      return bash_poll_hint;
    }

    const read_payload = self._handle_bash_read_equivalent(payload);
    if (read_payload) {
      return await self.pre_read(read_payload);
    }
    const compress_response = self._handle_bash_compress(payload);
    if (compress_response !== null) {
      return compress_response;
    }
    return CONTINUE();
  }

  if (tool_name === "Grep") {
    const advisory_text = self._handle_grep_advisory(payload);
    const dedup = self._handle_grep_dedup(payload);
    if (dedup !== null) {
      return dedup;
    }
    const written = self._handle_grep_written_not_read(payload);
    if (written !== null) {
      return written;
    }
    const symbol_redirect = self._handle_grep_symbol_redirect(payload);
    if (symbol_redirect !== null) {
      return symbol_redirect;
    }
    const large_grep = self._handle_large_grep_redirect(payload);
    if (large_grep !== null) {
      return large_grep;
    }
    if (advisory_text) {
      return pre_tool_use_with_context(advisory_text);
    }
    return CONTINUE();
  }

  if (tool_name === "Glob") {
    const dedup = self._handle_glob_dedup(payload);
    if (dedup !== null) {
      return dedup;
    }
    return CONTINUE();
  }

  if (tool_name !== "Read") {
    _LOG.debug("pre-read: skipping non-Read tool %s", sanitize_opt(tool_name));
    return CONTINUE();
  }

  const tool_input = get_tool_input(payload);
  const file_path = tool_input["file_path"] as string | undefined;
  if (!file_path) {
    _LOG.debug("pre-read: no file_path in tool_input; skipping");
    return CONTINUE();
  }

  const [session_id, cwd] = get_session_context(payload);

  const task_output_response = self._handle_task_output_read(file_path, session_id);
  if (task_output_response !== null) {
    return task_output_response;
  }

  const shrink_response = await self._try_shrink_image(file_path, tool_input);
  if (shrink_response) {
    return shrink_response;
  }

  const notebook_response = self._handle_notebook_read(file_path, tool_input);
  if (notebook_response) {
    return notebook_response;
  }

  // Catastrophic-tier guard: hard-deny a full read of a >=10 MB file.
  const large_read_early = self._handle_large_read_redirect(file_path, tool_input, { floor: _LARGE_FILE_HINT_SKIP_BYTES });
  if (large_read_early !== null) {
    return large_read_early;
  }

  if (self._is_binary_or_large_file(file_path)) {
    _LOG.debug("pre-read: skipping hints for binary/large file %s", sanitize_log_str(file_path));
    return CONTINUE();
  }

  if (!session_id) {
    _LOG.debug("pre-read: no session_id; skipping hint for %s", sanitize_log_str(file_path));
    return CONTINUE();
  }

  const cache = load_session_safe(session_id);
  try {
    let _ctx_tier = "cool";
    let _ctx_fill = 0.0;
    let _eff_threshold = 500;
    try {
      if (_getContextPressure !== null) {
        const _cp = _getContextPressure(session_id, { cache });
        _ctx_tier = _cp.tier;
        _ctx_fill = _cp.fill_fraction;
        if (_ctx_tier === "critical") {
          _eff_threshold = 50;
        } else if (_ctx_tier === "hot") {
          _eff_threshold = 200;
        } else if (_ctx_tier === "warm") {
          _eff_threshold = 350;
        }
      }
    } catch {
      // fail-soft
    }

    if (payload["_tg_from_bash_cat"]) {
      if (["warm", "hot", "critical"].includes(_ctx_tier)) {
        const _cat_deny = self._handle_indexed_cat_deny(file_path, tool_input, _ctx_tier);
        if (_cat_deny !== null) {
          return _cat_deny;
        }
      } else {
        const _cat_adv = self._handle_indexed_cat_advisory(file_path, tool_input, cache);
        if (_cat_adv !== null) {
          return _cat_adv;
        }
      }
    }

    const _recovery_text = self._check_recovery_pending(session_id, cache);
    if (_recovery_text) {
      return pre_tool_use_with_context(_recovery_text);
    }

    const skill_file_response = self._handle_skill_file_read(session_id, file_path, cache);
    if (skill_file_response !== null) {
      return skill_file_response;
    }

    const index_only_response = self._handle_index_only_file(session_id, file_path, tool_input, cache);
    if (index_only_response !== null) {
      return index_only_response;
    }

    if (!self._read_is_windowed(tool_input) && cache !== null) {
      const dedup_response = self._check_content_dedup(file_path, cache);
      if (dedup_response !== null) {
        return dedup_response;
      }
    }

    const doc_compact_response = self._handle_doc_compact(file_path, cwd, cache);
    if (doc_compact_response !== null) {
      return doc_compact_response;
    }

    const structured_response = self._handle_structured_file(session_id, file_path, tool_input, cache);
    if (structured_response !== null) {
      return structured_response;
    }

    const hint_items: hints.HintItem[] = [];

    const unchanged_response = self._try_unchanged_file_hint(session_id, file_path, tool_input, cache);
    if (unchanged_response !== null) {
      return unchanged_response;
    }

    if (cache === null) {
      return CONTINUE();
    }

    const _reread_deny = self._handle_reread_deny(session_id, file_path, tool_input, cache);
    if (_reread_deny !== null) {
      return _reread_deny;
    }

    const entry = cache.files[session._normalize_path(file_path)] as
      | { last_edit_ts: number; last_read_ts: number; line_ranges: Array<[number, number]>; read_count: number; last_read_call_index: number }
      | undefined;

    if (entry !== undefined && entry.last_edit_ts <= entry.last_read_ts) {
      const _partial_overlap = self._handle_partial_overlap_hint(file_path, tool_input, entry);
      if (_partial_overlap !== null) {
        return _partial_overlap;
      }
    }

    let _predictive_unlock = false;
    if (entry === undefined || entry.last_edit_ts <= entry.last_read_ts) {
      try {
        if (snapshots.load_kind(session_id, file_path) === "predictive") {
          _predictive_unlock = true;
        }
      } catch {
        _predictive_unlock = false;
      }
    }
    if ((entry !== undefined && entry.last_edit_ts > entry.last_read_ts) || _predictive_unlock) {
      const _raw_offset = tool_input["offset"];
      const _raw_limit = tool_input["limit"];
      let _req_start: number | null = null;
      let _req_end: number | null = null;
      try {
        const _safe_offset = _raw_offset !== null && _raw_offset !== undefined ? Math.max(0, Number(_raw_offset)) : 0;
        const _safe_limit = _raw_limit !== null && _raw_limit !== undefined ? Math.max(0, Number(_raw_limit)) : 0;
        if (Number.isNaN(_safe_offset) || Number.isNaN(_safe_limit)) {
          throw new TypeError("non-numeric offset/limit");
        }
        _req_start = _safe_offset + 1;
        _req_end = _req_start + (_safe_limit || hints.DEFAULT_READ_LIMIT) - 1;
      } catch {
        // TypeError/ValueError — leave req bounds null.
      }

      let _hints_cfg: ReturnType<typeof config.load>["hints"] | null = null;
      try {
        _hints_cfg = config.load().hints;
      } catch {
        _hints_cfg = null;
      }
      if (_hints_cfg != null && _hints_cfg.serve_diff_on_reread === true) {
        const _diff_serve_response = self._try_diff_serve(session_id, file_path, {
          req_start: _req_start,
          req_end: _req_end,
          entry_line_ranges: entry !== undefined ? entry.line_ranges : null,
        });
        if (_diff_serve_response !== null) {
          return _diff_serve_response;
        }
      }

      const diff_response = self._try_diff_hint(session_id, file_path, {
        req_start: _req_start,
        req_end: _req_end,
        entry_line_ranges: entry !== undefined ? entry.line_ranges : null,
      });
      if (diff_response !== null) {
        const hso = diff_response.hookSpecificOutput ?? {};
        const diff_text = _isDict(hso) ? String((hso as Record<string, unknown>)["additionalContext"] ?? "") : "";
        if (diff_text) {
          const _diff_fp = hints._hint_fingerprint(diff_text, file_path);
          if (cache.has_hint_fingerprint(_diff_fp)) {
            _LOG.debug(
              "pre-read: diff hint fingerprint %s already seen; suppressing duplicate for %s",
              _diff_fp,
              sanitize_log_str(file_path),
            );
            record_cached_stat("diff_hint_backoff_suppressed", sanitize_log_str(file_path, 512));
          } else {
            cache.mark_hint_seen(_diff_fp);
            hint_items.push(new hints.HintItem(diff_text, hints.HINT_PRIORITY_HIGH));
          }
        }
      }
    }

    if (hint_items.length === 0) {
      const large_read = self._handle_large_read_redirect(file_path, tool_input, { tier: _ctx_tier });
      if (large_read !== null) {
        return large_read;
      }
      const _file_key = session._normalize_path(file_path);
      const _hint_cooldown_active =
        typeof (cache as { has_session_hint_been_emitted?: unknown }).has_session_hint_been_emitted === "function" &&
        cache.has_session_hint_been_emitted(_file_key) &&
        !(entry !== undefined && entry.last_edit_ts > entry.last_read_ts);
      let hint: unknown = null;
      if (_hint_cooldown_active) {
        _LOG.debug("pre-read: session hint suppressed (per-file cooldown) for %s", sanitize_log_str(file_path));
        cache.record_hint_suppressed("session_hint_suppressed");
        record_cached_stat("session_hint_suppressed", sanitize_log_str(file_path, 512));
      } else {
        let _backoff_active = false;
        if (entry !== undefined) {
          const _entry_read_count = entry.read_count;
          let _bo_thresholds: number[];
          try {
            _bo_thresholds = config.load().hints?.backoff_thresholds ?? [1, 3, 10, 30];
          } catch {
            _bo_thresholds = [1, 3, 10, 30];
          }
          if (_bo_thresholds.length > 0 && !_bo_thresholds.includes(_entry_read_count)) {
            _backoff_active = true;
            _LOG.debug(
              "pre-read: session hint suppressed (backoff) for %s (read_count=%d not in thresholds=%s)",
              sanitize_log_str(file_path),
              _entry_read_count,
              JSON.stringify(_bo_thresholds),
            );
            cache.record_hint_suppressed("hint_backoff_suppressed");
            record_cached_stat("hint_backoff_suppressed", sanitize_log_str(file_path, 512));
          }
        }
        if (!_backoff_active) {
          let _recent_suppress = false;
          if (entry !== undefined && entry.last_read_call_index > 0) {
            let _protect: number;
            try {
              _protect = config.load().hints?.protect_recent_reads ?? 4;
            } catch {
              _protect = 4;
            }
            if (_protect > 0 && _call_index - entry.last_read_call_index <= _protect) {
              _recent_suppress = true;
              _LOG.debug(
                "pre-read: session hint suppressed (recent-read window=%d, gap=%d) for %s",
                _protect,
                _call_index - entry.last_read_call_index,
                sanitize_log_str(file_path),
              );
              cache.record_hint_suppressed("hint_recent_read_suppressed");
              record_cached_stat("hint_recent_read_suppressed", sanitize_log_str(file_path, 512));
            }
          }
          const _compact_ts = (cache as { last_compact_ts?: number }).last_compact_ts ?? 0.0;
          if (_recent_suppress) {
            // suppressed
          } else if (entry !== undefined && _compact_ts && entry.last_read_ts < _compact_ts) {
            _LOG.debug("pre-read: session hint suppressed (post-compact) for %s", sanitize_log_str(file_path));
            cache.record_hint_suppressed("hint_post_compact_suppressed");
            record_cached_stat("hint_post_compact_suppressed", sanitize_log_str(file_path, 512));
          } else {
            hint = hints.build_read_hint({
              session_id,
              file_path,
              offset: (tool_input["offset"] ?? null) as number | null,
              limit: (tool_input["limit"] ?? null) as number | null,
              cwd,
              cache,
              large_file_line_threshold: _eff_threshold,
            });
          }
        }
      }
      if (hint) {
        const hint_text = String(hint);
        const fingerprint = hints._hint_fingerprint(hint_text, file_path);

        if (cache.has_hint_fingerprint(fingerprint)) {
          _LOG.debug(
            "pre-read: hint fingerprint %s already seen; suppressing duplicate for %s",
            fingerprint,
            sanitize_log_str(file_path),
          );
        } else {
          const _tokens_saved = (hint as { tokens_saved: number }).tokens_saved;
          const _hint_kind = _tokens_saved > 0 ? "already_read" : "read_suggestion";
          if (_tokens_saved > 0) {
            _LOG.debug("pre-read: hint injected for %s (tokens_saved=%d)", sanitize_log_str(file_path), _tokens_saved);
            self._record_session_hint_impact(file_path, hint);
            hints._record_hint_emitted(cache, session._normalize_path(file_path));
            if (typeof (cache as { mark_session_hint_emitted?: unknown }).mark_session_hint_emitted === "function") {
              cache.mark_session_hint_emitted(_file_key);
            }
          } else {
            _LOG.debug("pre-read: hint built for %s but tokens_saved=0; no stat recorded", sanitize_log_str(file_path));
          }
          cache.record_hint_emitted(_hint_kind);
          hint_items.push(new hints.HintItem(hint_text, hints.HINT_PRIORITY_MEDIUM));
          cache.mark_hint_seen(fingerprint);
        }
      }

      if (hint_items.length === 0 && entry !== undefined && entry.last_edit_ts > entry.last_read_ts) {
        const _fname = sanitize_log_str(file_path, 256);
        const _changed_note =
          `Note: \`${sanitize_log_str(file_path, 200)}\` was edited since you last read it. ` +
          "The version you may remember from context may be stale.";
        const _changed_fp = hints._hint_fingerprint(_changed_note, file_path);
        if (!cache.has_hint_fingerprint(_changed_fp)) {
          cache.mark_hint_seen(_changed_fp);
          cache.record_hint_emitted("file_changed_since_read");
          record_hint_stat_pair("file_changed_since_read", _changed_note, _fname);
          hint_items.push(new hints.HintItem(_changed_note, hints.HINT_PRIORITY_CRITICAL));
          _LOG.debug("pre-read: file-changed-since-read note for %s", sanitize_log_str(file_path));
        }
      }
    }

    if (hint_items.length === 0) {
      const _written_key = session._normalize_path(file_path);
      const _edited: Record<string, number> = _isDict(cache.edited_files) ? cache.edited_files : {};
      const _edit_count = _edited[_written_key] ?? 0;
      if (_edit_count >= 1 && !(_written_key in cache.files)) {
        const _fname = sanitize_log_str(_basename(file_path), 256);
        hint_items.push(
          new hints.HintItem(
            `Note: \`${_fname}\` was written ${_edit_count}x this session and not yet read back. ` +
              "The content you wrote may still be in context from the tool result — " +
              "verify there rather than re-reading. For a specific symbol use " +
              `\`token-goat read "${file_path}::SymbolName"\`.`,
            hints.HINT_PRIORITY_CRITICAL,
          ),
        );
        _LOG.debug("pre-read: written-not-read hint for %s (edit_count=%d)", sanitize_log_str(file_path), _edit_count);
      }
    }

    // Surgical-read suggestion.
    const _raw_offset = tool_input["offset"];
    const _raw_limit = tool_input["limit"];
    if (_raw_offset !== null && _raw_offset !== undefined) {
      let _surg_hint: string | null;
      try {
        const _limit_is_sentinel = _raw_limit === null || _raw_limit === undefined;
        const _eff_limit = _raw_limit !== null && _raw_limit !== undefined ? Number(_raw_limit) : 2000;
        const _offNum = Number(_raw_offset);
        if (Number.isNaN(_offNum) || Number.isNaN(_eff_limit)) {
          throw new TypeError("non-numeric offset/limit");
        }
        _surg_hint = self._try_surgical_read_hint(file_path, _offNum, _eff_limit, cwd, { limit_is_sentinel: _limit_is_sentinel });
      } catch {
        _surg_hint = null;
      }
      if (_surg_hint) {
        const _surg_fp = hints._hint_fingerprint(_surg_hint, file_path);
        const _surg_parts: string[] = [];
        if (emit_if_new_hint(cache, _surg_fp, _surg_hint, "surgical_suggestion", _surg_parts)) {
          hint_items.push(new hints.HintItem(_surg_parts[0] as string, hints.HINT_PRIORITY_LOW));
        }
      }
    }

    // Git commit history.
    const _written_key = session._normalize_path(file_path);
    const _git_edited: Record<string, number> = _isDict(cache.edited_files) ? cache.edited_files : {};
    const _created_ts = (cache as { created_ts?: number }).created_ts ?? Date.now() / 1000;
    const _is_edited = _written_key in _git_edited;
    let _is_new_session = false;
    if (typeof _created_ts === "number") {
      const _session_age = Date.now() / 1000 - _created_ts;
      _is_new_session = _session_age < 120.0;
    }

    if (!_is_edited && !_is_new_session) {
      const git_ctx = self._build_git_hint(cwd, file_path);
      if (git_ctx) {
        const _git_fp = hints._hint_fingerprint(git_ctx, file_path);
        const _git_parts: string[] = [];
        if (emit_if_new_hint(cache, _git_fp, git_ctx, "git_history", _git_parts)) {
          hint_items.push(new hints.HintItem(_git_parts[0] as string, hints.HINT_PRIORITY_LOW));
        }
      }
    }

    // High-frequency access hint.
    const _freq_item = hints.build_high_frequency_hint(cache, file_path);
    if (_freq_item !== null) {
      const _freq_fp = hints._hint_fingerprint(_freq_item.text, file_path);
      if (!cache.has_hint_fingerprint(_freq_fp)) {
        cache.mark_hint_seen(_freq_fp);
        cache.record_hint_emitted("high_frequency_read");
        hint_items.push(_freq_item);
        _LOG.debug(
          "pre-read: high-frequency hint for %s (access count=%d)",
          sanitize_log_str(file_path),
          cache.get_file_access_count(file_path),
        );
      }
    }

    // Test-file hint.
    try {
      const _cwd_path = validate_cwd(cwd, { caller: "test-file-hint" });
      if (_cwd_path !== null) {
        const _proj = project.find_project(_cwd_path);
        if (_proj !== null) {
          const _test_hint = hints.build_test_file_hint(file_path, cache, _proj.root);
          if (_test_hint !== null) {
            const _test_fp = hints._hint_fingerprint(_test_hint.text, file_path);
            if (!cache.has_hint_fingerprint(_test_fp)) {
              cache.mark_hint_seen(_test_fp);
              hint_items.push(_test_hint);
              _LOG.debug("pre-read: test-file hint for %s", sanitize_log_str(file_path));
            }
          }
        }
      }
    } catch {
      _LOG.debug("test-file-hint: unexpected exception");
    }

    // Context-pressure urgency note.
    if (["warm", "hot", "critical"].includes(_ctx_tier) && cache !== null) {
      try {
        const _pct = Math.trunc(_ctx_fill * 100);
        let _cp_text: string;
        if (_ctx_tier === "critical") {
          _cp_text =
            `CONTEXT CRITICAL (${_pct}% full): context window is almost full. ` +
            "Read ONLY with surgical token-goat commands — " +
            `files ≥${_eff_threshold} lines now trigger surgical hints. ` +
            "Avoid full-file reads; compact or wrap up soon.";
        } else if (_ctx_tier === "hot") {
          _cp_text =
            `Context pressure (${_pct}% full): prefer surgical reads. ` +
            `Files ≥${_eff_threshold} lines now trigger surgical-read suggestions.`;
        } else {
          _cp_text =
            `Context warming (${_pct}% full): consider surgical reads for large ` +
            `files. Files ≥${_eff_threshold} lines now trigger surgical-read ` +
            "suggestions.";
        }
        const _cp_fp = hints._hint_fingerprint(_cp_text, `__ctx_pressure_${_ctx_tier}__`);
        if (!cache.has_hint_fingerprint(_cp_fp)) {
          cache.mark_hint_seen(_cp_fp);
          cache.record_hint_emitted("context_pressure_warning");
          hint_items.push(new hints.HintItem(_cp_text, hints.HINT_PRIORITY_MEDIUM));
          _LOG.debug("pre-read: context-pressure urgency note (tier=%s, fill=%s)", _ctx_tier, _ctx_fill.toFixed(2));
        }
      } catch {
        // fail-soft
      }
    }

    if (hint_items.length === 0) {
      _LOG.debug("pre-read: no hint for %s", sanitize_log_str(file_path));
      return CONTINUE();
    }

    const deduped_items = hints.dedup_hints(hint_items, cache);
    const ordered_texts = hints.apply_hint_priority_limit(deduped_items, hints.HINT_MAX_PER_TOOL_CALL, { tier: _ctx_tier });
    return pre_tool_use_with_context(ordered_texts.join("\n\n"));
  } finally {
    self._flush_pending_hint_save(cache);
  }
}

// READ/GREP/GLOB bins — bash_parser keeps these module-private; the fast-path
// guard in pre_read needs the same sets. Mirror the verbatim contents.
const _READ_BINS: ReadonlySet<string> = new Set<string>([
  "cat", "bat", "batcat", "head", "tail", "sed", "awk", "perl", "less", "more",
  "view", "nl", "get-content", "gc", "type",
]);
const _GREP_BINS: ReadonlySet<string> = new Set<string>([
  "grep", "egrep", "fgrep", "rg", "ag", "ack", "ripgrep", "git-grep", "select-string", "sls",
]);
const _GLOB_BINS: ReadonlySet<string> = new Set<string>(["find", "fd", "fdfind", "ls", "eza"]);

// ===========================================================================
// post_read — public entrypoint + helpers
// ===========================================================================

/** Increment hints_ignored when *key* is found in cache.recent_hints. */
export function _check_ignored_hint_by_key(cache: unknown, key: string, label: string): void {
  try {
    const recent_hints = ((cache as { recent_hints?: unknown }).recent_hints ?? []) as Array<[string, number]>;
    if (recent_hints.length === 0) {
      return;
    }
    for (const [hint_key] of recent_hints) {
      if (hint_key === key) {
        (cache as { hints_ignored: number }).hints_ignored += 1;
        (cache as { _invalidate_json_cache(): void })._invalidate_json_cache();
        (cache as { recent_hints: Array<[string, number]> }).recent_hints = recent_hints.filter(([k]) => k !== key);
        _LOG.debug("curator: hints_ignored++ for %s (total=%d)", label, (cache as { hints_ignored: number }).hints_ignored);
        break;
      }
    }
  } catch {
    // fail-soft
  }
}

/** Increment hints_ignored when a Read fires for a recently-hinted path. */
export function _check_ignored_hint(cache: unknown, file_path: string): void {
  let norm: string;
  try {
    norm = _get_session()._normalize_path(file_path);
  } catch {
    return;
  }
  self._check_ignored_hint_by_key(cache, norm, sanitize_log_str(file_path));
}

/** Increment hints_ignored when a Bash command runs after a bash-dedup hint. */
export function _check_ignored_bash_hint(cache: unknown, command: string, cwd?: string | null): void {
  let cmd_sha: string;
  try {
    cmd_sha = bash_cache.command_hash(command, cwd ?? null);
  } catch {
    return;
  }
  self._check_ignored_hint_by_key(cache, cmd_sha, `bash cmd ${sanitize_log_str(command, 60)}`);
}

/** Return True when *path* is an individual Claude memory file. */
export function _is_memory_file(p: string): boolean {
  const name_lower = _basename(p).toLowerCase();
  if (name_lower === "memory.md") {
    return false;
  }
  if (!name_lower.endsWith(".md")) {
    return false;
  }
  const parts_lower = p.split(/[/\\]/).map((part) => part.toLowerCase());
  return parts_lower.includes(".claude") && parts_lower.includes("memory");
}

/** Strip YAML frontmatter from a memory file body. */
export function _strip_memory_frontmatter(content: string): [string, number] {
  if (!content.startsWith("---\n") && !content.startsWith("---\r\n")) {
    return [content, 0];
  }

  const lines = _splitlinesKeepends(content);
  let close_idx: number | null = null;
  for (let i = 1; i < lines.length; i += 1) {
    if ((lines[i] as string).replace(/[\r\n]+$/, "") === "---") {
      close_idx = i;
      break;
    }
  }

  if (close_idx === null) {
    return [content, 0];
  }

  let body_start = close_idx + 1;
  if (body_start < lines.length && (lines[body_start] as string).replace(/[\r\n]+$/, "") === "") {
    body_start += 1;
  }

  return [lines.slice(body_start).join(""), body_start];
}

/** Python str.splitlines(keepends=True). */
function _splitlinesKeepends(text: string): string[] {
  const out: string[] = [];
  const re = /[^\r\n]*(?:\r\n|\r|\n)?/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    if (m[0] === "") {
      if (re.lastIndex >= text.length) {
        break;
      }
      re.lastIndex += 1;
      continue;
    }
    out.push(m[0]);
    if (re.lastIndex >= text.length) {
      break;
    }
  }
  return out;
}

/** Parse a Claude Code partial-read sentinel from tool result text. */
export function _detect_partial_read(text: string): [number, number, number] | null {
  let m = _PARTIAL_READ_RE_HYPHEN.exec(text);
  if (m) {
    return [Number(m[1]), Number(m[2]), Number(m[3])];
  }
  m = _PARTIAL_READ_RE_TO.exec(text);
  if (m) {
    return [Number(m[1]), Number(m[2]), Number(m[3])];
  }
  return null;
}

/** Post-read hook: record file/symbol accesses to session cache. */
export function post_read(payload: HookPayload): HookResponse {
  const [session_id] = get_hook_context(payload);
  if (session_id === null) {
    return CONTINUE();
  }

  const cache = load_session_safe(session_id);
  if (cache === null) {
    return CONTINUE();
  }

  const _resp_text = extract_tool_response_text(payload);
  if (_resp_text) {
    cache.observed_tool_tokens += Math.trunc(_resp_text.length / 4);
  }

  const tool_name = payload.tool_name;
  const tool_input = get_tool_input(payload);

  if (tool_name === "Read") {
    const file_path = tool_input["file_path"] as string | undefined;
    if (file_path) {
      const offset = (tool_input["offset"] ?? null) as number | null;
      const limit = (tool_input["limit"] ?? null) as number | null;
      session.mark_file_read(session_id, file_path, offset, limit, { cache, call_index: _call_index });
      _LOG.debug("post-read: recorded Read file=%s offset=%s limit=%s", sanitize_log_str(file_path), offset, limit);
      self._check_ignored_hint(cache, file_path);
      if (!self._read_is_windowed(tool_input)) {
        try {
          if (_isFile(file_path)) {
            const size = fs.statSync(file_path).size;
            if (size > 0 && size <= _CONTENT_DEDUP_MAX_BYTES) {
              const _raw = _readBytes(file_path);
              const _sha16 = _sha1Hex(_raw).slice(0, 16);
              const _norm = _resolvePosix(file_path);
              cache.register_file_content(_sha16, _norm);
              const _sha256 = _sha256Hex(_crlfToLf(_raw));
              cache.record_read_hash(_norm, _sha256);
            }
          }
        } catch {
          // suppressed
        }
      }
      try {
        session.save(cache);
      } catch {
        // suppressed
      }
      self._try_snapshot(session_id, file_path, { cache });
      if (_resp_text) {
        const _partial = self._detect_partial_read(_resp_text);
        if (_partial !== null) {
          const [_pr_start, _pr_end, _pr_total] = _partial;
          const _pr_ext = _suffixLower(file_path);
          const _pr_disabled = ["0", "false", "no", "off"].includes((process.env[_ENV_BASH_COMPRESS] ?? "").trim().toLowerCase());
          let _pr_min: number;
          try {
            _pr_min = config.load().hints?.truncated_read_min_lines ?? 200;
          } catch {
            _pr_min = 200;
          }
          const _pr_skip =
            (_pr_start === 1 && _pr_end >= _pr_total) ||
            _pr_total <= _pr_min ||
            _TRUNCATED_HINT_SKIP_EXTS.has(_pr_ext) ||
            _pr_disabled;
          if (!_pr_skip) {
            const _pr_hint =
              `[token-goat] File is ${_pr_total} lines. Consider:\n` +
              `  token-goat section "${file_path}::Heading"  — extract named section (~95% smaller)\n` +
              `  token-goat skeleton ${file_path}            — full symbol list without bodies\n` +
              `  token-goat read "${file_path}::N-M"        — targeted line range`;
            return { continue: true, systemMessage: _pr_hint };
          }
        }
      }
      if (self._is_memory_file(file_path) && _resp_text) {
        const [_mem_body, _n_stripped] = self._strip_memory_frontmatter(_resp_text);
        if (_n_stripped > 0) {
          const _note = `[token-goat] memory file: ${_n_stripped} frontmatter lines stripped\n`;
          return { continue: true, systemMessage: _note + _mem_body };
        }
      }
      const _cc_disabled = ["0", "false", "no", "off"].includes((process.env[_ENV_BASH_COMPRESS] ?? "").trim().toLowerCase());
      if (!_cc_disabled && _resp_text) {
        const _cc_ext = _suffixLower(file_path);
        const _cc_line_count = (_resp_text.match(/\n/g)?.length ?? 0) + 1;
        let _cc_min: number;
        try {
          const _cc_raw_min = config.load().post_read_code_compress?.min_lines;
          _cc_min = is_real_int(_cc_raw_min) ? _cc_raw_min : 200;
        } catch {
          _cc_min = 200;
        }
        if (_cc_line_count >= _cc_min) {
          try {
            const _skeleton = code_compress.compress_to_skeleton(_resp_text, _cc_ext);
            if (_skeleton !== null) {
              const _sk_lines = (_skeleton.match(/\n/g)?.length ?? 0) + 1;
              const _cc_footer =
                `\n[token-goat: structural view — ${_cc_line_count} lines → ${_sk_lines} skeleton lines;` +
                ` use \`token-goat read "${file_path}::SymbolName"\` for full body]`;
              return { continue: true, systemMessage: _skeleton + _cc_footer };
            }
          } catch {
            // suppressed
          }
        }
      }
    }
  } else if (tool_name === "Grep") {
    const pattern = tool_input["pattern"] as string | undefined;
    const path = (tool_input["path"] ?? null) as string | null;
    const raw_result_count = payload.result_count;
    let result_count: number | null = null;
    if (is_real_int(raw_result_count)) {
      result_count = Math.max(0, Math.min(raw_result_count, _SESSION_MAX_RESULT_COUNT));
    }
    if (pattern) {
      session.mark_grep(session_id, pattern, path, result_count, { cache });
      _LOG.debug("post-read: recorded Grep pattern=%s path=%s result_count=%s", sanitize_opt(pattern), sanitize_opt(path), result_count);
      const _grep_raw = payload.tool_response;
      const _grep_text = self._coerce_text(_grep_raw);
      try {
        if (_grep_text) {
          const normalized = _grep_text.trim();
          if (normalized) {
            const result_hash = hints._sha256_hex(normalized, 8);
            if (cache !== null) {
              cache.record_grep_result_hash(result_hash, pattern);
              _LOG.debug("post-read: recorded grep result hash=%s for pattern=%s", result_hash, sanitize_opt(pattern));
            }
          }
        }
      } catch {
        _LOG.debug("post-read: grep result hash computation failed");
      }
      try {
        if (_grep_text && _grep_text.length <= _GREP_RESULT_CACHE_MAX_BYTES) {
          const _glob_filter = typeof tool_input["glob"] === "string" ? (tool_input["glob"] as string) : null;
          const _type_filter = typeof tool_input["type"] === "string" ? (tool_input["type"] as string) : null;
          const _output_mode = typeof tool_input["output_mode"] === "string" ? (tool_input["output_mode"] as string) : null;
          const _bc2_cfg = config.load().bash_compress;
          bash_cache.store_grep_result(session_id, pattern, path, _glob_filter, _type_filter, _output_mode, _grep_text, {
            max_total_bytes: _bc2_cfg?.cache_max_bytes ?? 16 * 1024 * 1024,
            max_file_count: _bc2_cfg?.cache_max_file_count ?? 4096,
          });
        }
      } catch {
        // suppressed
      }
    }
  } else if (tool_name === "Glob") {
    const pattern = tool_input["pattern"] as string | undefined;
    const path = (tool_input["path"] ?? null) as string | null;
    if (pattern) {
      const raw_output = payload.tool_response;
      const output_text = self._coerce_text(raw_output);
      let glob_result_count: number | null = null;
      if (output_text) {
        glob_result_count = output_text.split("\n").filter((ln) => ln.trim()).length;
      }
      session.mark_glob_run(session_id, pattern, path, glob_result_count, { cache });
      if (output_text) {
        try {
          const _bc_cfg = config.load().bash_compress;
          bash_cache.store_glob_result(session_id, pattern, path, output_text, {
            max_total_bytes: _bc_cfg?.cache_max_bytes ?? 16 * 1024 * 1024,
            max_file_count: _bc_cfg?.cache_max_file_count ?? 4096,
          });
        } catch {
          // suppressed
        }
      }
      _LOG.debug("post-read: recorded Glob pattern=%s path=%s result_count=%s", sanitize_opt(pattern), sanitize_opt(path), glob_result_count);
    }
  }

  return CONTINUE();
}

/** Replace CRLF with LF in a Buffer (b.replace(b"\r\n", b"\n")). */
function _crlfToLf(buf: Buffer): Buffer {
  return Buffer.from(buf.toString("latin1").replace(/\r\n/g, "\n"), "latin1");
}

// ===========================================================================
// post_bash — constants + helpers
// ===========================================================================

const _BASH_CACHE_MIN_BYTES = 400;
const _CMD_DEDUP_MIN_BYTES = 100;
const _CMD_DEDUP_MAX_CMDS = 50;

const _PYTEST_CMD_RE = /\bpy(?:test|\.test)\b|python\s+-m\s+pytest/;
const _PYTEST_FAILURE_FULL_RE = /^(?:FAILED|ERROR)\s+(.+)$/gm;
const _PYTEST_FAILURE_SUFFIX_RE = /\s+-\s+[A-Za-z][\w.]*(?::\s.*)?$/;
const _PYTEST_COMPRESS_MIN_BYTES = 2000;
const _PYTEST_TB_SEP_RE = /^_{4,}\s+\S.*\s+_{4,}\s*$/;
const _VERBOSE_TEST_MIN_LINES = 80;
export const _CARGO_COMPILE_MIN_LINES = 40;
const _MAKE_MIN_LINES = 40;
const _GO_TEST_V_MIN_LINES = 60;
const _TSC_MIN_LINES = 50;
const _TSC_BARE_DIAG_RE = /^(error|warning) TS\d+:/;
const _RECON_CMD_RE = /^(?:ls|ll|la|eza|exa|tree|fd|fdfind)\b/;

const _BASH_DEFAULT_MAX_PROCESS_BYTES = 10 * 1024 * 1024; // 10 MB

const _BINARY_DETECTION_SAMPLE_BYTES = 4096;
const _BINARY_NULL_THRESHOLD = 0.01;

const _GIT_DIFF_MIN_BYTES = 400;
const _GIT_DIFF_SMALL_DELTA = 20;
const _GIT_DIFF_DELTA_PREVIEW_LINES = 30;
const _STDERR_DELTA_MIN_BYTES = 300;
const _STDERR_DELTA_SMALL = 8;
const _STDERR_DELTA_MAX_PREVIEW = 40;
const _JSON_SUMMARY_MIN_BYTES = 4000;
const _JSON_SUMMARY_MAX_BYTES = 2_000_000;
const _LARGE_STDOUT_LINE_THRESHOLD = 200;
const _GIT_LOG_COMPRESS_MIN_LINES = 50;
const _PKG_INSTALL_MIN_LINES = 30;
const _ENV_LIST_MIN_LINES = 10;
const _CONTAINER_LOG_MIN_LINES = 50;
const _PYTHON_TB_MIN_STDERR_LINES = 25;

// Lazy-load cache for the session module (Python _get_session()).
let _session_module: typeof session | null = null;

/** Lazy session-module accessor (Python _get_session). Returns the session namespace. */
export function _get_session(): typeof session {
  if (_session_module === null) {
    _session_module = session;
  }
  return _session_module;
}

/** Best-effort string coercion for a payload field of unknown shape. */
export function _coerce_text(value: unknown): string {
  if (value === null || value === undefined) {
    return "";
  }
  if (typeof value === "string") {
    return value;
  }
  if (Array.isArray(value)) {
    const parts: string[] = [];
    for (const item of value) {
      if (_isDict(item)) {
        const rec = item as Record<string, unknown>;
        const itemType = rec["type"];
        let txt: unknown = null;
        if (itemType === "text" || itemType === undefined || itemType === null) {
          txt = rec["text"];
        }
        if (typeof txt === "string") {
          parts.push(txt);
        }
      } else if (typeof item === "string") {
        parts.push(item);
      }
    }
    return parts.join("");
  }
  return String(value);
}

/** Return the original command if *cmd* is a `token-goat compress` wrapper. */
export function _unwrap_compress_command(cmd: string): string {
  if (!cmd.includes("compress") || !cmd.includes("--cmd")) {
    return cmd;
  }
  let argv: string[];
  try {
    argv = _posixSplit(cmd);
  } catch {
    return cmd;
  }
  let is_wrapper = false;
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i] as string;
    if (token === "token-goat" || token === "token_goat.cli" || token.endsWith("token_goat.cli")) {
      for (let j = i + 1; j < Math.min(i + 4, argv.length); j += 1) {
        if (argv[j] === "compress") {
          is_wrapper = true;
          break;
        }
      }
      if (is_wrapper) {
        break;
      }
    }
  }
  if (!is_wrapper) {
    return cmd;
  }
  for (let k = 0; k < argv.length; k += 1) {
    const token = argv[k] as string;
    if (token === "--cmd" && k + 1 < argv.length) {
      return argv[k + 1] as string;
    }
    if (token.startsWith("--cmd=")) {
      return token.slice("--cmd=".length);
    }
  }
  return cmd;
}

/** Pull [stdout, stderr, exit_code] from a PostToolUse Bash payload. */
export function _extract_bash_response(payload: HookPayload): [string, string, number | null] {
  let stdout = extract_tool_response_text(payload, { text_keys: ["stdout", "output", "text", "content"] });

  let raw_resp: unknown = _isDict(payload) ? (payload as HookPayload).tool_response : null;
  if ((raw_resp === null || raw_resp === undefined) && _isDict(payload)) {
    raw_resp = (payload as HookPayload).tool_result ?? (payload as HookPayload).response ?? null;
  }

  let stderr = "";
  let exit_val: unknown = null;

  if (_isDict(raw_resp)) {
    const rec = raw_resp as Record<string, unknown>;
    const stderr_raw = rec["stderr"] ?? rec["err"];
    stderr = self._coerce_text(stderr_raw);
    if ("exit_code" in rec) {
      exit_val = rec["exit_code"];
    } else if ("returncode" in rec) {
      exit_val = rec["returncode"];
    } else {
      exit_val = rec["exit"];
    }
  }

  if (!stdout && _isDict(payload)) {
    stdout = self._coerce_text((payload as Record<string, unknown>)["stdout"] ?? (payload as Record<string, unknown>)["output"]);
  }
  if (!stderr && _isDict(payload)) {
    stderr = self._coerce_text((payload as Record<string, unknown>)["stderr"]);
  }
  if ((exit_val === null || exit_val === undefined) && _isDict(payload)) {
    const plain = payload as Record<string, unknown>;
    if ("exit_code" in plain) {
      exit_val = plain["exit_code"];
    } else if ("returncode" in plain) {
      exit_val = plain["returncode"];
    }
  }

  let exit_code: number | null = null;
  if (is_real_int(exit_val)) {
    exit_code = exit_val;
  } else if (typeof exit_val === "string") {
    const parsed = Number(exit_val);
    exit_code = Number.isInteger(parsed) ? parsed : Number.isFinite(parsed) ? Math.trunc(parsed) : null;
    if (!/^[+-]?\d+$/.test(exit_val.trim())) {
      exit_code = null;
    }
  }

  return [stdout, stderr, exit_code];
}

/** Return the hard cap on raw Bash output size before processing. */
export function _bash_max_process_bytes(): number {
  return _env_int("TOKEN_GOAT_BASH_MAX_PROCESS_BYTES", _BASH_DEFAULT_MAX_PROCESS_BYTES, { lo: 1024 });
}

/** Truncate combined output to the configured byte cap. */
export function _apply_output_size_cap(stdout: string, stderr: string): [string, string, boolean] {
  const cap = self._bash_max_process_bytes();
  const stdout_b = _utf8_bytes(stdout);
  const stderr_b = _utf8_bytes(stderr);
  const total = stdout_b.length + stderr_b.length;
  if (total <= cap) {
    return [stdout, stderr, false];
  }

  const stderr_budget = Math.min(Math.trunc(cap / 5), 100 * 1024);
  const stdout_budget = cap - Math.min(stderr_b.length, stderr_budget);

  const original_total = total;
  let truncated_stdout = stdout;
  if (stdout_b.length > stdout_budget && stdout_budget > 0) {
    let tail = stdout_b.subarray(stdout_b.length - stdout_budget);
    const nl = tail.indexOf(0x0a);
    if (nl > 0 && nl < 256) {
      tail = tail.subarray(nl + 1);
    }
    truncated_stdout =
      `[token-goat: stdout truncated to last ${_thousands(tail.length)} bytes` +
      ` of ${_thousands(stdout_b.length)} bytes total` +
      ` (TOKEN_GOAT_BASH_MAX_PROCESS_BYTES=${_thousands(cap)})]\n` +
      tail.toString("utf8");
  }
  _LOG.info(
    "post-bash: output size cap applied: %d → %d bytes (cap=%d)",
    original_total,
    _utf8_bytes(truncated_stdout).length + stderr_b.length,
    cap,
  );
  return [truncated_stdout, stderr, true];
}

/** Return True when the output looks like binary data. */
export function _is_binary_output(stdout: string, stderr: string): boolean {
  const sample_src = (stdout + stderr).slice(0, _BINARY_DETECTION_SAMPLE_BYTES * 4);
  const sample_bytes = _utf8_bytes(sample_src).subarray(0, _BINARY_DETECTION_SAMPLE_BYTES);
  if (sample_bytes.length === 0) {
    return false;
  }
  let null_count = 0;
  for (const b of sample_bytes) {
    if (b === 0) {
      null_count += 1;
    }
  }
  return null_count / sample_bytes.length > _BINARY_NULL_THRESHOLD;
}

/** True when *cmd* is a directory-listing/exploration command (ls, eza, tree, fd). */
export function _is_recon_command(cmd: string): boolean {
  let tokens: string[];
  try {
    tokens = _posixSplit(cmd.trim());
  } catch {
    tokens = cmd.trim().split(/\s+/).filter((t) => t.length > 0);
  }
  const first = tokens.length > 0 ? (tokens[0] as string) : "";
  const base = _rsplitOnce(first.replace(/\\/g, "/"), "/")[1] || first.replace(/\\/g, "/");
  const baseClean = base.replace(/^['"]+|['"]+$/g, "");
  return _RECON_CMD_RE.test(baseClean);
}

/** True when *cmd* is a pytest invocation. */
export function _is_pytest_command(cmd: string): boolean {
  return _PYTEST_CMD_RE.test(cmd);
}

/** Suppress traceback bodies in the pytest FAILURES section. */
export function _compress_pytest_failures(stdout: string, output_id: string | null): string {
  if (!stdout.includes("FAILED")) {
    return stdout;
  }

  const _sect_re = /^=+\s/;

  const lines = _splitlinesKeepends(stdout);
  const out: string[] = [];
  let in_failures_section = false;
  let in_tb_block = false;
  let failure_count = 0;

  for (const line of lines) {
    const stripped = line.replace(/[\r\n]+$/, "");

    if (_sect_re.test(stripped)) {
      in_failures_section = stripped.includes("FAILURES");
      in_tb_block = false;
      out.push(line);
      continue;
    }

    if (in_failures_section) {
      if (_PYTEST_TB_SEP_RE.test(stripped)) {
        failure_count += 1;
        in_tb_block = true;
        const current_tb_name = stripped.replace(/^_+|_+$/g, "").trim();
        const recall = output_id ? ` (bash-output ${output_id} for full output)` : "";
        out.push(
          `[token-goat] traceback omitted — re-run with: pytest ${current_tb_name} -x for details${recall}\n`,
        );
        continue;
      }

      if (in_tb_block) {
        continue;
      }
    }

    out.push(line);
  }

  if (failure_count === 0) {
    return stdout;
  }

  const recall_hdr = output_id ? ` (bash-output ${output_id} for full output)` : "";
  const header =
    `[token-goat] pytest: ${failure_count}` +
    ` failure${failure_count !== 1 ? "s" : ""}` +
    ` detected — tracebacks suppressed${recall_hdr}:\n`;
  return header + out.join("");
}

/** Return True when *norm_path* looks like a log file. */
export function _is_log_file_path(norm_path: string): boolean {
  const lower = norm_path.toLowerCase();
  if (lower.endsWith(".log") || lower.endsWith(".out")) {
    return true;
  }
  return lower.includes("/log/") || lower.includes("/logs/") || lower.endsWith("/log") || lower.endsWith("/logs");
}

const _GIT_NOISE_FLAGS: ReadonlySet<string> = new Set<string>([
  "--color", "--no-color", "--color=never", "--color=always", "--color=auto",
]);

const _GIT_STAT_FLAGS: ReadonlySet<string> = new Set<string>(["--stat", "--shortstat", "--numstat"]);

/** Return True when argv is a `git diff` command eligible for delta caching. */
export function _is_git_diff_target(argv: string[]): boolean {
  if (argv.length === 0 || argv.length < 2) {
    return false;
  }
  let cmd_base = _rsplitOnce((argv[0] as string).toLowerCase().replace(/\\/g, "/"), "/")[1] || (argv[0] as string).toLowerCase().replace(/\\/g, "/");
  if (cmd_base.endsWith(".exe")) {
    cmd_base = cmd_base.slice(0, -4);
  }
  if (cmd_base !== "git") {
    return false;
  }
  if (argv[1] !== "diff") {
    return false;
  }
  return !argv.slice(2).some((a) => _GIT_STAT_FLAGS.has(a));
}

/** Return a canonical string of git diff args with noise flags stripped. */
export function _normalize_git_diff_args(argv: string[]): string {
  return argv.slice(2).filter((a) => !_GIT_NOISE_FLAGS.has(a)).join(" ");
}

/** Return the current HEAD commit SHA string, or null on failure. */
export function _get_head_sha(cwd: string | null): string | null {
  try {
    const opts: childProcess.SpawnSyncOptions = { encoding: "utf8", timeout: 5000 };
    if (cwd) {
      opts.cwd = cwd;
    }
    const result = childProcess.spawnSync("git", ["rev-parse", "HEAD"], opts);
    if (result.status === 0) {
      const sha = String(result.stdout ?? "").trim();
      if (sha) {
        return sha;
      }
    }
  } catch {
    // fail-soft
  }
  return null;
}

/** Return sorted FAILED/ERROR test node IDs from a pytest stdout/stderr blob. */
export function _extract_pytest_failure_ids(output: string): string[] {
  const ids = new Set<string>();
  _PYTEST_FAILURE_FULL_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = _PYTEST_FAILURE_FULL_RE.exec(output)) !== null) {
    const node_id = (m[1] as string).replace(_PYTEST_FAILURE_SUFFIX_RE, "").replace(/\s+$/, "");
    if (node_id) {
      ids.add(node_id);
    }
  }
  return Array.from(ids).sort();
}

/** Return a compact structural description of a parsed JSON value. */
export function _json_structural_summary(data: unknown, max_depth = 2, max_keys = 12): string {
  const lines: string[] = [];

  const _repr_value = (v: unknown): string => {
    if (_isDict(v)) {
      const sub = Object.keys(v as Record<string, unknown>);
      const shown = sub.slice(0, 8).join(", ");
      const suffix = sub.length > 8 ? `, +${sub.length - 8} more` : "";
      return "{" + shown + suffix + "}";
    }
    if (Array.isArray(v)) {
      return `[list, ${v.length} items]`;
    }
    return _pyTypeName(v);
  };

  if (_isDict(data)) {
    const rec = data as Record<string, unknown>;
    const keys = Object.keys(rec);
    const shown_keys = keys.slice(0, max_keys);
    const truncated = keys.length - max_keys;
    let key_line = shown_keys.map((k) => String(k)).join(", ");
    if (truncated > 0) {
      key_line += `, ... (+${truncated} more)`;
    }
    lines.push("Type: object (dict)");
    lines.push(`Keys (${keys.length}): ${key_line}`);
    let expanded = 0;
    for (const k of shown_keys) {
      const v = rec[k];
      if ((_isDict(v) || Array.isArray(v)) && expanded < max_depth * 6) {
        lines.push(`└── ${k}: ${_repr_value(v)}`);
        expanded += 1;
      }
    }
  } else if (Array.isArray(data)) {
    lines.push("Type: array (list)");
    lines.push(`Length: ${data.length} items`);
    if (data.length > 0) {
      const first = data[0];
      if (_isDict(first)) {
        const sub_keys = Object.keys(first as Record<string, unknown>);
        const shown = sub_keys.slice(0, max_keys);
        const trunc = sub_keys.length - max_keys;
        let key_line = shown.map((k) => String(k)).join(", ");
        if (trunc > 0) {
          key_line += `, ... (+${trunc} more)`;
        }
        lines.push(`First item type: object — Keys (${sub_keys.length}): ${key_line}`);
        for (const k of shown.slice(0, 6)) {
          const v = (first as Record<string, unknown>)[k];
          if (_isDict(v) || Array.isArray(v)) {
            lines.push(`  └── ${k}: ${_repr_value(v)}`);
          }
        }
      } else if (Array.isArray(first)) {
        lines.push(`First item type: array — ${first.length} items`);
      } else {
        lines.push(`First item type: ${_pyTypeName(first)}`);
      }
    }
  }

  return lines.join("\n");
}

/** Python type(v).__name__ for the JSON value kinds the summary touches. */
function _pyTypeName(v: unknown): string {
  if (v === null) {
    return "NoneType";
  }
  if (typeof v === "boolean") {
    return "bool";
  }
  if (typeof v === "number") {
    return Number.isInteger(v) ? "int" : "float";
  }
  if (typeof v === "string") {
    return "str";
  }
  if (Array.isArray(v)) {
    return "list";
  }
  if (_isDict(v)) {
    return "dict";
  }
  return typeof v;
}

/** Return int(v) or *default* when *v* is empty, None, or non-numeric. */
export function _safe_int(v: unknown, default_ = 0): number {
  if (v === null || v === undefined || v === "") {
    return default_;
  }
  const n = Number(v);
  if (!Number.isFinite(n)) {
    return default_;
  }
  return Math.trunc(n);
}

/** Parse JUnit XML *stdout* and return a token-goat summary string, or null on parse error. */
export function _summarize_junit_xml(stdout: string): string | null {
  const root = _parseXml(stdout.trim());
  if (root === null) {
    return null;
  }

  let suites: XmlNode[];
  if (root.tag === "testsuites") {
    suites = root.children.filter((el) => el.tag === "testsuite");
  } else if (root.tag === "testsuite") {
    suites = [root];
  } else {
    return null;
  }

  let total = 0;
  let errors = 0;
  let failures = 0;
  let skipped = 0;
  const failed_cases: Array<[string, string]> = [];

  for (const suite of suites) {
    total += self._safe_int(suite.attrs["tests"] ?? 0);
    errors += self._safe_int(suite.attrs["errors"] ?? 0);
    failures += self._safe_int(suite.attrs["failures"] ?? 0);
    skipped += self._safe_int(suite.attrs["skipped"] ?? 0);

    for (const tc of _iterDescendants(suite, "testcase")) {
      const fail = tc.children.find((c) => c.tag === "failure") ?? null;
      const err = tc.children.find((c) => c.tag === "error") ?? null;
      const node = fail !== null ? fail : err;
      if (node !== null) {
        const classname = tc.attrs["classname"] ?? "";
        const testname = tc.attrs["name"] ?? "";
        const name = `${classname}.${testname}`.replace(/^\.+|\.+$/g, "");
        const msg = (node.attrs["message"] ?? node.text ?? "").slice(0, 200);
        failed_cases.push([name, msg]);
      }
    }
  }

  const passed = total - errors - failures - skipped;
  const status = errors + failures === 0 ? "PASS" : "FAIL";

  const lines = [
    `[token-goat] JUnit XML [${status}]: ${passed} passed, ${failures} failed,` +
      ` ${errors} errors, ${skipped} skipped (${total} total)`,
  ];

  if (failed_cases.length > 0) {
    lines.push("Failures:");
    for (const [name, msg] of failed_cases.slice(0, 10)) {
      lines.push(`  ${name}`);
      if (msg.trim()) {
        lines.push(`    ${msg.trim().slice(0, 160)}`);
      }
    }
    if (failed_cases.length > 10) {
      lines.push(`  ... ${failed_cases.length - 10} more failures (use bash-output to see all)`);
    }
  }

  return lines.join("\n");
}

// --- Minimal XML parser (the analogue of xml.etree.ElementTree.fromstring) ---
interface XmlNode {
  tag: string;
  attrs: Record<string, string>;
  children: XmlNode[];
  text: string;
}

/** Parse XML into a tree, or null on a parse error (ET.ParseError analogue). */
function _parseXml(src: string): XmlNode | null {
  try {
    let i = 0;
    const n = src.length;
    const skipWs = (): void => {
      while (i < n && /\s/.test(src[i] as string)) {
        i += 1;
      }
    };
    // Skip XML declaration / comments / doctype / processing instructions.
    const skipProlog = (): void => {
      for (;;) {
        skipWs();
        if (src.startsWith("<?", i)) {
          const end = src.indexOf("?>", i);
          if (end === -1) {
            throw new Error("bad PI");
          }
          i = end + 2;
        } else if (src.startsWith("<!--", i)) {
          const end = src.indexOf("-->", i);
          if (end === -1) {
            throw new Error("bad comment");
          }
          i = end + 3;
        } else if (src.startsWith("<!", i)) {
          const end = src.indexOf(">", i);
          if (end === -1) {
            throw new Error("bad decl");
          }
          i = end + 1;
        } else {
          break;
        }
      }
    };
    const parseAttrs = (): Record<string, string> => {
      const attrs: Record<string, string> = {};
      for (;;) {
        skipWs();
        const c = src[i];
        if (c === ">" || c === "/" || c === undefined) {
          break;
        }
        let nameEnd = i;
        while (nameEnd < n && !/[\s=/>]/.test(src[nameEnd] as string)) {
          nameEnd += 1;
        }
        const name = src.slice(i, nameEnd);
        i = nameEnd;
        skipWs();
        let value = "";
        if (src[i] === "=") {
          i += 1;
          skipWs();
          const quote = src[i];
          if (quote === '"' || quote === "'") {
            i += 1;
            const end = src.indexOf(quote, i);
            if (end === -1) {
              throw new Error("bad attr");
            }
            value = src.slice(i, end);
            i = end + 1;
          }
        }
        attrs[name] = _xmlUnescape(value);
      }
      return attrs;
    };
    const parseElement = (): XmlNode => {
      if (src[i] !== "<") {
        throw new Error("expected <");
      }
      i += 1;
      let tagEnd = i;
      while (tagEnd < n && !/[\s/>]/.test(src[tagEnd] as string)) {
        tagEnd += 1;
      }
      const tag = src.slice(i, tagEnd);
      i = tagEnd;
      const attrs = parseAttrs();
      const node: XmlNode = { tag, attrs, children: [], text: "" };
      skipWs();
      if (src.startsWith("/>", i)) {
        i += 2;
        return node;
      }
      if (src[i] !== ">") {
        throw new Error("expected >");
      }
      i += 1;
      // Parse children + text until the matching close tag.
      let textBuf = "";
      for (;;) {
        if (i >= n) {
          throw new Error("unexpected EOF");
        }
        if (src.startsWith("</", i)) {
          const end = src.indexOf(">", i);
          if (end === -1) {
            throw new Error("bad close");
          }
          i = end + 1;
          break;
        }
        if (src.startsWith("<!--", i)) {
          const end = src.indexOf("-->", i);
          if (end === -1) {
            throw new Error("bad comment");
          }
          i = end + 3;
          continue;
        }
        if (src.startsWith("<![CDATA[", i)) {
          const end = src.indexOf("]]>", i);
          if (end === -1) {
            throw new Error("bad cdata");
          }
          textBuf += src.slice(i + 9, end);
          i = end + 3;
          continue;
        }
        if (src[i] === "<") {
          node.children.push(parseElement());
          continue;
        }
        textBuf += src[i];
        i += 1;
      }
      node.text = _xmlUnescape(textBuf).trim();
      return node;
    };
    skipProlog();
    return parseElement();
  } catch {
    return null;
  }
}

/** Unescape the five predefined XML entities. */
function _xmlUnescape(s: string): string {
  return s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

/** Iterate all descendant elements with *tag* (ElementTree.iter(tag) analogue). */
function _iterDescendants(node: XmlNode, tag: string): XmlNode[] {
  const out: XmlNode[] = [];
  const walk = (nd: XmlNode): void => {
    if (nd.tag === tag) {
      out.push(nd);
    }
    for (const c of nd.children) {
      walk(c);
    }
  };
  walk(node);
  return out;
}

// ===========================================================================
// post_bash — public entrypoint
// ===========================================================================

/** Post-Bash hook: persist large outputs to disk and record in session history. */
export function post_bash(payload: HookPayload): HookResponse {
  const [session_id, cwd] = get_session_context(payload);
  const tool_input = get_tool_input(payload);
  const command = tool_input["command"];
  if (typeof command !== "string" || !command) {
    return CONTINUE();
  }

  const display_cmd = self._unwrap_compress_command(command);

  let [stdout, stderr, exit_code] = self._extract_bash_response(payload);
  stdout = _sanitize_surrogates(stdout);
  stderr = _sanitize_surrogates(stderr);
  [stdout, stderr] = self._apply_output_size_cap(stdout, stderr);

  const _sess_mod = session_id ? _get_session() : null;
  const _session_cache = _sess_mod && session_id ? _sess_mod.safe_load(session_id, { caller: "post_bash" }) : null;
  if (_sess_mod !== null && _session_cache !== null) {
    _session_cache.observed_tool_tokens += Math.trunc((stdout.length + stderr.length) / 4);
    self._check_ignored_bash_hint(_session_cache, display_cmd, cwd);
    try {
      _sess_mod.save(_session_cache);
    } catch {
      // suppressed
    }
  }

  // Directory-recon consolidation.
  const _RECON_SEEN_KEY = "@recon_seen";
  const _RECON_MAP_KEY = "@recon_map";
  const _RECON_FAIL_KEY = "@recon_map_fail";
  if (self._is_recon_command(display_cmd) && (exit_code === null || exit_code === 0) && _sess_mod !== null && _session_cache !== null) {
    try {
      _session_cache.mark_hint_seen(_RECON_SEEN_KEY);
      const _recon_n = _session_cache.hints_seen[_RECON_SEEN_KEY] ?? 0;
      const _already_injected = _session_cache.has_hint_fingerprint(_RECON_MAP_KEY);
      const _prev_failed = _session_cache.has_hint_fingerprint(_RECON_FAIL_KEY);
      if (_recon_n >= 3 && !_already_injected && !_prev_failed) {
        const _run_opts: childProcess.SpawnSyncOptions = { encoding: "utf8", timeout: 10000 };
        if (cwd) {
          _run_opts.cwd = cwd;
        }
        const _exe = _whichTokenGoat() ?? "token-goat";
        const _map_r = childProcess.spawnSync(_exe, ["map", "--compact"], _run_opts);
        const _map_stdout = String(_map_r.stdout ?? "");
        if (_map_r.status === 0 && _map_stdout.trim()) {
          _session_cache.mark_hint_seen(_RECON_MAP_KEY);
          try {
            _sess_mod.save(_session_cache);
          } catch {
            // suppressed
          }
          return {
            continue: true,
            systemMessage: "[token-goat] Project map (injected after repeated directory reads):\n\n" + _map_stdout.trim(),
          };
        } else {
          _LOG.warning("post-bash: map --compact exited %d: %s", _map_r.status ?? -1, String(_map_r.stderr ?? "").slice(0, 200));
          _session_cache.mark_hint_seen(_RECON_FAIL_KEY);
        }
      } else if (_already_injected) {
        _session_cache.mark_hint_seen(_RECON_MAP_KEY);
      }
      try {
        _sess_mod.save(_session_cache);
      } catch {
        // suppressed
      }
    } catch {
      _session_cache.mark_hint_seen(_RECON_FAIL_KEY);
      try {
        _sess_mod.save(_session_cache);
      } catch {
        // suppressed
      }
      _LOG.debug("post-bash: recon map inject failed");
    }
  }

  // Grep-pattern session recording.
  if (_sess_mod !== null && _session_cache !== null) {
    try {
      const _grep_intent = bash_parser.parse(display_cmd);
      if (_grep_intent.kind === "grep" && _grep_intent.pattern) {
        const _grep_result_count = stdout ? stdout.split("\n").filter((ln) => ln.trim()).length : 0;
        _sess_mod.mark_grep(session_id as string, _grep_intent.pattern, _grep_intent.target_path, _grep_result_count, { cache: _session_cache });
        _LOG.debug(
          "post-bash: recorded grep pattern=%s path=%s result_count=%d",
          _grep_intent.pattern,
          _grep_intent.target_path,
          _grep_result_count,
        );
      }
    } catch {
      _LOG.debug("post-bash: grep session record failed");
    }
  }

  // Read-equivalent session tracking.
  if (_sess_mod !== null && _session_cache !== null && (exit_code === null || exit_code === 0)) {
    try {
      const _read_intent = bash_parser.parse(display_cmd);
      if (_read_intent.kind === "read" && _read_intent.target_path && !_read_intent.is_interactive_pager) {
        const _raw_offset = _read_intent.offset;
        const _norm_offset = _raw_offset !== null ? _raw_offset - 1 : null;
        const _all_paths = _read_intent.target_paths ?? [_read_intent.target_path];
        for (const _path of _all_paths) {
          _sess_mod.mark_file_read(session_id as string, _path, _norm_offset, _read_intent.limit, { cache: _session_cache });
        }
        _LOG.debug("post-bash: recorded read-equivalent paths=%s offset=%s limit=%s", JSON.stringify(_all_paths), _norm_offset, _read_intent.limit);
      }
    } catch {
      _LOG.debug("post-bash: read-equivalent session record failed");
    }
  }

  // Cross-tool content dedup (plain `cat FILE`).
  if (_sess_mod !== null && _session_cache !== null && (exit_code === null || exit_code === 0) && stdout) {
    try {
      const _ct_intent = bash_parser.parse(display_cmd);
      if (
        _ct_intent.kind === "read" &&
        _ct_intent.target_path !== null &&
        _ct_intent.target_paths === null &&
        _ct_intent.offset === null &&
        _ct_intent.limit === null &&
        !_ct_intent.filtered
      ) {
        let _argv_raw: string[];
        try {
          _argv_raw = _nonPosixSplit((display_cmd.split("|")[0] as string).trim());
        } catch {
          _argv_raw = [];
        }
        while (_argv_raw.length > 0 && ["sudo", "time", "nice", "exec"].includes(_stripQuotes(_argv_raw[0] as string).toLowerCase())) {
          _argv_raw.shift();
        }
        _argv_raw = _argv_raw.slice(1);
        const _raw_path_str = _argv_raw.map((t) => _stripQuotes(t)).find((t) => !t.startsWith("-")) ?? null;
        if (!_raw_path_str) {
          throw new Error("no path token found in argv");
        }
        let _ct_path = _raw_path_str;
        if (!nodePath.isAbsolute(_ct_path) && cwd) {
          _ct_path = nodePath.join(cwd, _raw_path_str);
        }
        const _ct_norm = _resolvePosix(_ct_path);
        const _ct_hash = _sha256Hex(stdout.replace(/\r\n/g, "\n"));
        const _prior_hash = _session_cache.get_read_hash(_ct_norm);
        if (_prior_hash !== null && _prior_hash === _ct_hash) {
          _LOG.info("post-bash: cross-tool dedup suppressed cat output path=%s", sanitize_log_str(_ct_norm));
          try {
            _sess_mod.save(_session_cache);
          } catch {
            // suppressed
          }
          return {
            continue: true,
            systemMessage:
              `[token-goat] Output identical to recent Read of '${_raw_path_str}'` +
              " — suppressed duplicate (use Read tool directly)",
          };
        }
      }
    } catch {
      _LOG.debug("post-bash: cross-tool content dedup check failed");
    }
  }

  // Log-file content cache.
  if (_sess_mod !== null && _session_cache !== null && (exit_code === null || exit_code === 0) && stdout) {
    try {
      const _lf_intent = bash_parser.parse(display_cmd);
      if (_lf_intent.kind === "read" && _lf_intent.target_path !== null && _lf_intent.target_paths === null) {
        let _lf_argv_raw: string[];
        try {
          _lf_argv_raw = _nonPosixSplit((display_cmd.split("|")[0] as string).trim());
        } catch {
          _lf_argv_raw = [];
        }
        while (_lf_argv_raw.length > 0 && ["sudo", "time", "nice", "exec"].includes(_stripQuotes(_lf_argv_raw[0] as string).toLowerCase())) {
          _lf_argv_raw.shift();
        }
        _lf_argv_raw = _lf_argv_raw.slice(1);
        const _lf_raw = _lf_argv_raw.map((t) => _stripQuotes(t)).find((t) => !t.startsWith("-")) ?? null;
        if (_lf_raw) {
          let _lf_p = _lf_raw;
          if (!nodePath.isAbsolute(_lf_p) && cwd) {
            _lf_p = nodePath.join(cwd, _lf_raw);
          }
          let _lf_resolved = "";
          let _lf_norm = "";
          try {
            _lf_resolved = fs.realpathSync(_lf_p);
            _lf_norm = _lf_resolved.replace(/\\/g, "/");
          } catch {
            _lf_norm = "";
          }
          if (_lf_norm && self._is_log_file_path(_lf_norm)) {
            let _lf_st: fs.Stats | null = null;
            try {
              _lf_st = fs.statSync(_lf_resolved);
            } catch {
              _lf_st = null;
            }
            if (_lf_st !== null) {
              const _lf_size = _lf_st.size;
              const _lf_mtime = _lf_st.mtimeMs / 1000;
              const _lf_hash = _sha256Hex(stdout.replace(/\r\n/g, "\n")).slice(0, 16);
              const _lf_cached = _session_cache.get_log_cache_hit(_lf_norm, _lf_size, _lf_mtime);
              if (_lf_cached !== null && _lf_cached === _lf_hash) {
                _LOG.info("post-bash: log-file cache hit suppressed output path=%s", sanitize_log_str(_lf_norm));
                try {
                  _sess_mod.save(_session_cache);
                } catch {
                  // suppressed
                }
                return {
                  continue: true,
                  systemMessage:
                    `[token-goat] Log file '${_lf_raw}' unchanged since last read` +
                    " — suppressed duplicate output" +
                    " (use `token-goat bash-output` to recall full content)",
                };
              }
              _session_cache.record_log_read(_lf_norm, _lf_size, _lf_mtime, _lf_hash);
              try {
                _sess_mod.save(_session_cache);
              } catch {
                // suppressed
              }
            }
          }
        }
      }
    } catch {
      _LOG.debug("post-bash: log-file cache check failed");
    }
  }

  // Sleep / watch / poll-loop suppression.
  if (exit_code === null || exit_code === 0) {
    try {
      let _sp_argv: string[];
      try {
        _sp_argv = _nonPosixSplit((display_cmd.split("|")[0] as string).trim());
      } catch {
        _sp_argv = display_cmd.trim().split(/\s+/).filter((t) => t.length > 0);
      }
      const _sp_argv_clean = _sp_argv.map((t) => _stripQuotes(t));

      const _sleep_cmd_type = _bcFn("_sleep_cmd_type");
      const _watch_cmd_info = _bcFn("_watch_cmd_info");
      const _is_poll_loop_cmd = _bcFn("_is_poll_loop_cmd");

      if (_sleep_cmd_type !== undefined && _sleep_cmd_type(_sp_argv_clean as never) !== null) {
        if (!stdout.trim()) {
          _LOG.debug("post-bash: sleep cmd empty stdout suppressed cmd=%s", display_cmd.slice(0, 60));
          return CONTINUE();
        }
        let _sp_out_id: string | null = null;
        if (session_id) {
          try {
            const _sp_meta = bash_cache.store_output(session_id, display_cmd, stdout, stderr, exit_code, { cwd, min_cache_bytes: 0 });
            if (_sp_meta !== null) {
              bash_cache.write_sidecar(_sp_meta);
              _sp_out_id = _sp_meta.output_id;
            }
          } catch {
            // suppressed
          }
        }
        const _sp_recall = _sp_out_id ? ` (use bash-output ${_sp_out_id} to see)` : "";
        _LOG.info("post-bash: sleep cmd nonempty stdout suppressed cmd=%s", display_cmd.slice(0, 60));
        return { continue: true, systemMessage: `[token-goat] ${display_cmd} — output suppressed${_sp_recall}` };
      }

      const _sp_watch_cmd = _watch_cmd_info !== undefined ? (_watch_cmd_info(_sp_argv_clean as never) as string | null) : null;
      if (_sp_watch_cmd !== null) {
        let _sp_out_id: string | null = null;
        if (session_id) {
          try {
            const _sp_meta = bash_cache.store_output(session_id, display_cmd, stdout, stderr, exit_code, { cwd, min_cache_bytes: 0 });
            if (_sp_meta !== null) {
              bash_cache.write_sidecar(_sp_meta);
              _sp_out_id = _sp_meta.output_id;
            }
          } catch {
            // suppressed
          }
        }
        const _sp_recall = _sp_out_id ? ` (use bash-output ${_sp_out_id} to see)` : "";
        _LOG.info("post-bash: watch cmd suppressed watched=%s", _sp_watch_cmd.slice(0, 80));
        return { continue: true, systemMessage: `[token-goat] watch: ${_sp_watch_cmd} — output suppressed${_sp_recall}` };
      }

      if (_is_poll_loop_cmd !== undefined && _is_poll_loop_cmd(display_cmd as never)) {
        let _sp_out_id: string | null = null;
        if (session_id) {
          try {
            const _sp_meta = bash_cache.store_output(session_id, display_cmd, stdout, stderr, exit_code, { cwd, min_cache_bytes: 0 });
            if (_sp_meta !== null) {
              bash_cache.write_sidecar(_sp_meta);
              _sp_out_id = _sp_meta.output_id;
            }
          } catch {
            // suppressed
          }
        }
        const _sp_n_lines = stdout.split("\n").filter((ln) => ln.trim()).length;
        const _sp_exit_info = `exit code: ${exit_code !== null ? exit_code : 0}`;
        _LOG.info("post-bash: poll loop suppressed lines=%d cmd=%s", _sp_n_lines, display_cmd.slice(0, 60));
        return {
          continue: true,
          systemMessage: `[token-goat] poll loop detected — ${_sp_n_lines} output lines condensed (${_sp_exit_info})`,
        };
      }
    } catch {
      _LOG.debug("post-bash: sleep/watch/poll suppress failed");
    }
  }

  // Package manager install output compression.
  if ((exit_code === null || exit_code === 0 || exit_code === 1) && stdout && _splitlines(stdout).length >= _PKG_INSTALL_MIN_LINES) {
    try {
      let _pkg_argv: string[];
      try {
        _pkg_argv = _nonPosixSplit((display_cmd.split("|")[0] as string).trim());
      } catch {
        _pkg_argv = display_cmd.trim().split(/\s+/).filter((t) => t.length > 0);
      }
      const _pkg_argv_clean = _pkg_argv.map((t) => _stripQuotes(t));

      const _is_pkg_install_cmd = _bcFn("_is_pkg_install_cmd");
      if (_is_pkg_install_cmd !== undefined && _is_pkg_install_cmd(_pkg_argv_clean as never)) {
        const _pkg_lines = _splitlines(stdout);
        const _pkg_n_lines = _pkg_lines.length;

        const _PROGRESS_PREFIXES = ["Collecting", "Compiling", "Downloading", "Installing", "Fetching", "Updating", "Resolving"];
        const _PROGRESS_BAR_CHARS = new Set("⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏█▉▊▋▌▍▎▏|#".split(""));

        const _pkg_error_lines: string[] = [];
        let _pkg_progress_count = 0;

        for (const _pl of _pkg_lines) {
          const _pl_stripped = _pl.trim();
          if (!_pl_stripped) {
            continue;
          }
          const _pl_lower = _pl_stripped.toLowerCase();
          if (
            _pl_lower.includes("error") ||
            _pl_lower.includes("failed") ||
            _pl_lower.includes("warning:") ||
            _pl_lower.includes(" err!") ||
            _pl_lower.startsWith("npm warn") ||
            _pl_lower.startsWith("npm err")
          ) {
            _pkg_error_lines.push(_pl_stripped);
          }
          if (
            _PROGRESS_PREFIXES.some((pre) => _pl_stripped.startsWith(pre)) ||
            (_pl_stripped.length > 0 && _PROGRESS_BAR_CHARS.has(_pl_stripped[0] as string))
          ) {
            _pkg_progress_count += 1;
          }
        }

        let _pkg_summary_line = "";
        for (let i = _pkg_lines.length - 1; i >= 0; i -= 1) {
          if ((_pkg_lines[i] as string).trim()) {
            _pkg_summary_line = (_pkg_lines[i] as string).trim();
            break;
          }
        }

        let _pkg_out_id: string | null = null;
        if (session_id) {
          try {
            const _pkg_meta = bash_cache.store_output(session_id, display_cmd, stdout, stderr, exit_code, { cwd, min_cache_bytes: 0 });
            if (_pkg_meta !== null) {
              bash_cache.write_sidecar(_pkg_meta);
              _pkg_out_id = _pkg_meta.output_id;
            }
          } catch {
            // suppressed
          }
        }

        const _pkg_unique_kept = new Set<string>(_pkg_error_lines);
        if (_pkg_summary_line) {
          _pkg_unique_kept.add(_pkg_summary_line);
        }
        const _pkg_kept = _pkg_unique_kept.size;
        const _pkg_cmd_short = display_cmd.slice(0, 60);
        const _pkg_recall = _pkg_out_id ? `\n[Full output: bash-output ${_pkg_out_id}]` : "";

        const _pkg_parts = [`[token-goat] pkg install: ${_pkg_n_lines} lines → ${_pkg_kept} kept | ${_pkg_cmd_short}`];
        if (_pkg_summary_line && !_pkg_error_lines.includes(_pkg_summary_line)) {
          _pkg_parts.push(_pkg_summary_line);
        }
        if (_pkg_error_lines.length > 0) {
          _pkg_parts.push(..._pkg_error_lines);
        }
        if (_pkg_recall) {
          _pkg_parts.push(_pkg_recall);
        }

        _LOG.info(
          "post-bash: pkg install compressed lines=%d progress=%d errors=%d cmd=%s",
          _pkg_n_lines,
          _pkg_progress_count,
          _pkg_error_lines.length,
          display_cmd.slice(0, 60),
        );
        return { continue: true, systemMessage: _pkg_parts.join("\n") };
      }
    } catch {
      _LOG.debug("post-bash: pkg install compression failed");
    }
  }

  // Environment variable listing compression.
  if ((exit_code === null || exit_code === 0) && stdout && _splitlines(stdout).length >= _ENV_LIST_MIN_LINES) {
    try {
      let _env_argv: string[];
      try {
        _env_argv = _nonPosixSplit((display_cmd.split("|")[0] as string).trim());
      } catch {
        _env_argv = display_cmd.trim().split(/\s+/).filter((t) => t.length > 0);
      }
      const _env_argv_clean = _env_argv.map((t) => _stripQuotes(t));

      const _is_env_list_cmd = _bcFn("_is_env_list_cmd");
      if (_is_env_list_cmd !== undefined && _is_env_list_cmd(_env_argv_clean as never)) {
        const _env_lines = _splitlines(stdout);
        const _env_n_lines = _env_lines.length;

        const _env_var_names: string[] = [];
        const _env_var_pattern = /^(?:declare\s+-x\s+|export\s+)?([A-Za-z_][A-Za-z0-9_]*)(?:=|$)/;
        for (const _el of _env_lines) {
          const _em = _env_var_pattern.exec(_el.trim());
          if (_em) {
            _env_var_names.push(_em[1] as string);
          }
        }

        const _env_total_vars = _env_var_names.length;

        if (_env_total_vars > 0) {
          const _env_cats: Record<string, string[]> = {
            "PATH-related": [],
            Python: [],
            "Node/npm": [],
            AWS: [],
            Git: [],
            CI: [],
            Other: [],
          };
          for (const _vn of _env_var_names) {
            const _vnu = _vn.toUpperCase();
            if (_vnu.includes("PATH")) {
              (_env_cats["PATH-related"] as string[]).push(_vn);
            } else if (_vnu.startsWith("PYTHON")) {
              (_env_cats["Python"] as string[]).push(_vn);
            } else if (_vnu.startsWith("NODE") || _vnu.startsWith("NPM")) {
              (_env_cats["Node/npm"] as string[]).push(_vn);
            } else if (_vnu.startsWith("AWS_")) {
              (_env_cats["AWS"] as string[]).push(_vn);
            } else if (_vnu.startsWith("GIT_")) {
              (_env_cats["Git"] as string[]).push(_vn);
            } else if (_vnu.startsWith("CI") || _vnu.startsWith("GITHUB_") || _vnu.startsWith("TRAVIS_") || _vnu.startsWith("CIRCLE_")) {
              (_env_cats["CI"] as string[]).push(_vn);
            } else {
              (_env_cats["Other"] as string[]).push(_vn);
            }
          }

          let _env_out_id: string | null = null;
          if (session_id) {
            try {
              const _env_meta = bash_cache.store_output(session_id, display_cmd, stdout, stderr, exit_code, { cwd, min_cache_bytes: 0 });
              if (_env_meta !== null) {
                bash_cache.write_sidecar(_env_meta);
                _env_out_id = _env_meta.output_id;
              }
            } catch {
              // suppressed
            }
          }

          const _env_recall = _env_out_id ? `\n[Full output: bash-output ${_env_out_id}]` : "";
          const _env_msg_parts = [`[token-goat] env: ${_env_total_vars} variables (${_env_n_lines} lines)`];
          for (const [_cat_name, _cat_vars] of Object.entries(_env_cats)) {
            if (_cat_vars.length === 0) {
              continue;
            }
            const _cat_count = _cat_vars.length;
            const _cat_display = _cat_count <= 10 ? _cat_vars.join(", ") : _cat_vars.slice(0, 10).join(", ") + ` +${_cat_count - 10} more`;
            _env_msg_parts.push(`${_cat_name} (${_cat_count}): ${_cat_display}`);
          }
          if (_env_recall) {
            _env_msg_parts.push(_env_recall);
          }

          _LOG.info("post-bash: env list compressed lines=%d vars=%d cmd=%s", _env_n_lines, _env_total_vars, display_cmd.slice(0, 60));
          return { continue: true, systemMessage: _env_msg_parts.join("\n") };
        }
      }
    } catch {
      _LOG.debug("post-bash: env list compression failed");
    }
  }

  // Container log compression.
  if ((exit_code === null || exit_code === 0) && stdout && _splitlines(stdout).length >= _CONTAINER_LOG_MIN_LINES) {
    try {
      let _cl_argv: string[];
      try {
        _cl_argv = _nonPosixSplit((display_cmd.split("|")[0] as string).trim());
      } catch {
        _cl_argv = display_cmd.trim().split(/\s+/).filter((t) => t.length > 0);
      }
      const _cl_argv_clean = _cl_argv.map((t) => _stripQuotes(t));

      const _is_container_log_cmd = _bcFn("_is_container_log_cmd");
      if (_is_container_log_cmd !== undefined && _is_container_log_cmd(_cl_argv_clean as never)) {
        if (display_cmd.includes("--tail") || display_cmd.includes("--tail=")) {
          _LOG.debug("post-bash: container logs has --tail, skipping compression");
        } else {
          const _cl_lines = _splitlines(stdout);
          const _cl_n_lines = _cl_lines.length;
          const _cl_tail = _cl_lines.slice(-20);

          const _CL_ERROR_PATTERNS = ["error", "ERROR", "FATAL", "fatal", "CRITICAL", "panic", "exception", "Exception"];
          const _cl_error_lines: string[] = [];
          let _cl_ei = 0;
          while (_cl_ei < _cl_lines.length) {
            const _cl_ln = _cl_lines[_cl_ei] as string;
            if (_CL_ERROR_PATTERNS.some((_cp) => _cl_ln.includes(_cp))) {
              _cl_error_lines.push(_cl_ln.replace(/\s+$/, ""));
              _cl_ei += 1;
              while (_cl_ei < _cl_lines.length) {
                const _cl_nxt = _cl_lines[_cl_ei] as string;
                const _cl_nxt_s = _cl_nxt.trim();
                if (
                  _cl_nxt_s.startsWith("at ") ||
                  _cl_nxt_s.toLowerCase().startsWith("caused by:") ||
                  (_cl_nxt.length > 0 && (_cl_nxt[0] === " " || _cl_nxt[0] === "\t") && _cl_nxt_s)
                ) {
                  _cl_error_lines.push(_cl_nxt.replace(/\s+$/, ""));
                  _cl_ei += 1;
                } else {
                  break;
                }
              }
            } else {
              _cl_ei += 1;
            }
          }
          const _cl_error_count = _cl_error_lines.length;

          let _cl_out_id: string | null = null;
          if (session_id) {
            try {
              const _cl_meta = bash_cache.store_output(session_id, display_cmd, stdout, stderr, exit_code, { cwd, min_cache_bytes: 0 });
              if (_cl_meta !== null) {
                bash_cache.write_sidecar(_cl_meta);
                _cl_out_id = _cl_meta.output_id;
              }
            } catch {
              // suppressed
            }
          }

          const _cl_recall = _cl_out_id ? `\n[Full output: bash-output ${_cl_out_id}]` : "";
          const _cl_short_cmd = display_cmd.slice(0, 80);
          const _cl_msg_parts = [
            `[token-goat] container logs: ${_cl_n_lines} lines | ${_cl_error_count} errors/warnings | ${_cl_short_cmd}`,
            "--- recent (last 20 lines) ---",
            _cl_tail.join("\n"),
          ];
          if (_cl_error_count > 0) {
            _cl_msg_parts.push(`--- errors/warnings (${_cl_error_count} lines) ---`);
            if (_cl_error_count > 30) {
              _cl_msg_parts.push(_cl_error_lines.slice(0, 30).join("\n"));
              _cl_msg_parts.push(`+${_cl_error_count - 30} more`);
            } else {
              _cl_msg_parts.push(_cl_error_lines.join("\n"));
            }
          }
          if (_cl_recall) {
            _cl_msg_parts.push(_cl_recall);
          }

          _LOG.info("post-bash: container logs compressed lines=%d errors=%d cmd=%s", _cl_n_lines, _cl_error_count, display_cmd.slice(0, 60));
          return { continue: true, systemMessage: _cl_msg_parts.join("\n") };
        }
      }
    } catch {
      _LOG.debug("post-bash: container log compression failed");
    }
  }

  // Git log output compression.
  if ((exit_code === null || exit_code === 0) && stdout && display_cmd.replace(/^\s+/, "").startsWith("git")) {
    try {
      let _gl_argv: string[];
      try {
        _gl_argv = _nonPosixSplit((display_cmd.split("|")[0] as string).trim());
      } catch {
        _gl_argv = display_cmd.trim().split(/\s+/).filter((t) => t.length > 0);
      }
      const _gl_argv_clean = _gl_argv.map((t) => _stripQuotes(t));

      const _is_git_log_cmd = _bcFn("_is_git_log_cmd");
      if (_is_git_log_cmd !== undefined && _is_git_log_cmd(_gl_argv_clean as never)) {
        const _gl_lines = _splitlines(stdout);
        const _gl_n_lines = _gl_lines.length;
        if (_gl_n_lines >= _GIT_LOG_COMPRESS_MIN_LINES) {
          let _gl_n_commits = (stdout.match(/^commit [0-9a-f]{40}/gm) ?? []).length;
          if (_gl_n_commits === 0) {
            _gl_n_commits = (stdout.match(/^[0-9a-f]{7,}\s/gm) ?? []).length;
          }

          if (_gl_n_commits === 0) {
            _LOG.debug("git log: unrecognized format (no commit markers found), skipping compression");
          } else {
            let _gl_out_id: string | null = null;
            if (session_id) {
              try {
                const _gl_meta = bash_cache.store_output(session_id, display_cmd, stdout, stderr, exit_code, { cwd, min_cache_bytes: 0 });
                if (_gl_meta !== null) {
                  bash_cache.write_sidecar(_gl_meta);
                  _gl_out_id = _gl_meta.output_id;
                }
              } catch {
                // suppressed
              }
            }

            const _gl_recall = _gl_out_id ? ` (bash-output ${_gl_out_id})` : "";
            const _gl_first5 = _gl_lines.slice(0, 5).join("\n");
            const _gl_omitted = _gl_n_lines - 5;
            const _gl_msg_parts = [
              `[token-goat] git log: ${_gl_n_commits} commits shown (${_gl_n_lines} lines) — full output stored${_gl_recall}`,
              "First 5 commits:",
              _gl_first5,
            ];
            if (_gl_omitted > 0) {
              _gl_msg_parts.push(`... (${_gl_omitted} lines omitted) ...`);
            }
            _LOG.info("post-bash: git log compressed lines=%d commits=%d cmd=%s", _gl_n_lines, _gl_n_commits, display_cmd.slice(0, 60));
            return { continue: true, systemMessage: _gl_msg_parts.join("\n") };
          }
        }
      }
    } catch {
      _LOG.debug("post-bash: git log compression failed");
    }
  }

  return _post_bash_part2(payload, { session_id, cwd, command, display_cmd, stdout, stderr, exit_code, _sess_mod, _session_cache });
}

/** Strip one layer of surrounding single/double quotes (t.strip("\"'")). */
function _stripQuotes(t: string): string {
  return t.replace(/^['"]+|['"]+$/g, "");
}

/** Shared state threaded between the post_bash pipeline stages. */
interface PostBashState {
  session_id: string | null;
  cwd: string | null;
  command: string;
  display_cmd: string;
  stdout: string;
  stderr: string;
  exit_code: number | null;
  _sess_mod: typeof session | null;
  _session_cache: SessionCache | null;
}

/** post_bash pipeline — verbose pytest / cargo / make / go-test / tsc compression blocks. */
function _post_bash_part2(payload: HookPayload, st: PostBashState): HookResponse {
  const { session_id, cwd, display_cmd, stdout, stderr, exit_code, _sess_mod, _session_cache } = st;

  // Verbose pytest PASSED-line suppression.
  if ((exit_code === null || exit_code === 0 || exit_code === 1) && stdout && _splitlines(stdout).length >= _VERBOSE_TEST_MIN_LINES) {
    try {
      const _vt_passed_re = _bcRe("_VT_PASSED_LINE_RE");
      const _vt_check = _bcFn("_is_verbose_test_cmd");
      if (_vt_passed_re !== undefined && _vt_check !== undefined) {
        const _vt_argv = _posixSplit(display_cmd);
        if (_vt_argv.length > 0 && _vt_check(_vt_argv as never)) {
          const _vt_lines = _splitlines(stdout);
          const _vt_kept: string[] = [];
          let _vt_suppressed = 0;
          for (const _vt_line of _vt_lines) {
            if (_vt_passed_re.test(_vt_line)) {
              _vt_suppressed += 1;
            } else {
              _vt_kept.push(_vt_line);
            }
          }
          if (_vt_suppressed > 0) {
            let _vt_out_id: string | null = null;
            if (session_id) {
              try {
                const _vt_meta = bash_cache.store_output(session_id, display_cmd, stdout, stderr, exit_code, { cwd, min_cache_bytes: 0 });
                if (_vt_meta !== null) {
                  bash_cache.write_sidecar(_vt_meta);
                  _vt_out_id = _vt_meta.output_id;
                }
              } catch {
                // suppressed
              }
            }
            const _vt_recall = _vt_out_id ? `\n[Full output: bash-output ${_vt_out_id}]` : "";
            let _vt_body = _vt_kept.join("\n");
            if (stdout.endsWith("\n") || stdout.endsWith("\r\n")) {
              _vt_body += "\n";
            }
            const _vt_msg =
              `[token-goat] pytest -v: ${_vt_lines.length} lines` +
              ` → ${_vt_kept.length} kept` +
              ` (${_vt_suppressed} PASSED lines suppressed)\n` +
              _vt_body +
              _vt_recall;
            _LOG.info("post-bash: verbose pytest PASSED suppressed count=%d cmd=%s", _vt_suppressed, display_cmd.slice(0, 60));
            if (_sess_mod !== null && _session_cache !== null) {
              try {
                _sess_mod.save(_session_cache);
              } catch {
                // suppressed
              }
            }
            return { continue: true, systemMessage: _vt_msg };
          }
        }
      }
    } catch {
      _LOG.debug("post-bash: verbose pytest suppress failed");
    }
  }

  // Cargo compilation output compression.
  if ((exit_code === null || exit_code === 0 || exit_code === 1) && stdout && _splitlines(stdout).length >= _CARGO_COMPILE_MIN_LINES) {
    try {
      const _cg_check = _bcFn("_is_cargo_compile_cmd");
      if (_cg_check !== undefined) {
        const _cg_argv = process.platform === "win32" ? _nonPosixSplit(display_cmd) : _posixSplit(display_cmd);
        if (_cg_argv.length > 0 && _cg_check(_cg_argv as never)) {
          const _DIAG_START_RE = /^(error|warning)(\[[\w:]+\])?:/;
          const _CARGO_NOISE_RE = /^(   Compiling |   Checking |   Downloaded |    Blocking |   Generating |     Running |   Downloading |   Updating )/;
          const _CARGO_TERMINAL_RE = /^(Finished |error: (?:aborting|could not compile))/;
          const _CARGO_CONT_RE = /^\s*(-->|\d*\s*\||=\s*(note|help)|[~^]+)/;
          const _cg_lines = _splitlines(stdout);
          const _cg_total = _cg_lines.length;

          const _cg_diag_lines: string[] = [];
          let _cg_in_diag = false;
          for (const _cg_line of _cg_lines) {
            if (_CARGO_TERMINAL_RE.test(_cg_line)) {
              _cg_in_diag = false;
            } else if (_DIAG_START_RE.test(_cg_line)) {
              _cg_in_diag = true;
              _cg_diag_lines.push(_cg_line);
            } else if (_cg_in_diag && _CARGO_CONT_RE.test(_cg_line)) {
              _cg_diag_lines.push(_cg_line.replace(/\s+$/, ""));
            } else {
              _cg_in_diag = false;
            }
          }

          const _cg_error_count = _cg_diag_lines.filter((_l) => /^error/.test(_l)).length;
          const _cg_warn_count = _cg_diag_lines.filter((_l) => /^warning/.test(_l)).length;

          let _cg_terminal: string | null = null;
          for (let i = _cg_lines.length - 1; i >= 0; i -= 1) {
            if (_CARGO_TERMINAL_RE.test(_cg_lines[i] as string)) {
              _cg_terminal = _cg_lines[i] as string;
              break;
            }
          }

          const _cg_noise_count = _cg_lines.filter((_l) => _CARGO_NOISE_RE.test(_l)).length;

          let _cg_should_compress: boolean;
          if (exit_code !== null && exit_code !== 0 && _cg_error_count === 0 && _cg_warn_count === 0) {
            _cg_should_compress = false;
          } else if (_cg_error_count === 0 && _cg_warn_count === 0) {
            _cg_should_compress = _cg_noise_count >= 5;
          } else {
            _cg_should_compress = true;
          }

          if (_cg_should_compress) {
            let _cg_out_id: string | null = null;
            if (session_id) {
              try {
                const _cg_meta = bash_cache.store_output(session_id, display_cmd, stdout, stderr, exit_code, { cwd, min_cache_bytes: 0 });
                if (_cg_meta !== null) {
                  bash_cache.write_sidecar(_cg_meta);
                  _cg_out_id = _cg_meta.output_id;
                }
              } catch {
                // suppressed
              }
            }
            const _cg_recall = _cg_out_id ? `\n[Full output: bash-output ${_cg_out_id}]` : "";

            let _cg_msg: string;
            if (_cg_error_count === 0 && _cg_warn_count === 0) {
              let _cg_body = _cg_terminal ? _cg_terminal + "\n" : "";
              if (!(stdout.endsWith("\n") || stdout.endsWith("\r\n")) && _cg_body.endsWith("\n")) {
                _cg_body = _cg_body.replace(/\n+$/, "");
              }
              const _cg_suppressed = _cg_total - (_cg_terminal ? 1 : 0);
              _cg_msg =
                `[token-goat] cargo: 0 errors, 0 warnings (${_cg_suppressed}/${_cg_total} lines suppressed)\n` +
                _cg_body +
                _cg_recall;
            } else {
              const _cg_body_lines = [..._cg_diag_lines];
              if (_cg_terminal && (_cg_body_lines.length === 0 || _cg_body_lines[_cg_body_lines.length - 1] !== _cg_terminal)) {
                _cg_body_lines.push(_cg_terminal);
              }
              let _cg_body = _cg_body_lines.join("\n");
              if (stdout.endsWith("\n") || stdout.endsWith("\r\n")) {
                _cg_body += "\n";
              }
              const _cg_suppressed = _cg_total - _cg_body_lines.length;
              _cg_msg =
                `[token-goat] cargo: ${_cg_error_count} errors, ${_cg_warn_count} warnings (${_cg_suppressed}/${_cg_total} lines suppressed)\n` +
                _cg_body +
                _cg_recall;
            }
            _LOG.info(
              "post-bash: cargo compile compressed lines=%d errors=%d warnings=%d cmd=%s",
              _cg_total,
              _cg_error_count,
              _cg_warn_count,
              display_cmd.slice(0, 60),
            );
            if (_sess_mod !== null && _session_cache !== null) {
              try {
                _sess_mod.save(_session_cache);
              } catch {
                // suppressed
              }
            }
            return { continue: true, systemMessage: _cg_msg };
          }
        }
      }
    } catch {
      _LOG.debug("post-bash: cargo compile compression failed");
    }
  }

  // make/cmake/ninja compression.
  if (stdout && _splitlines(stdout).length >= _MAKE_MIN_LINES && (exit_code === null || exit_code === 0 || exit_code === 1 || exit_code === 2)) {
    try {
      const _mk_check = _bcFn("_is_make_cmd");
      if (_mk_check !== undefined) {
        const _mk_argv = process.platform === "win32" ? _nonPosixSplit(display_cmd) : _posixSplit(display_cmd);
        if (_mk_argv.length > 0 && _mk_check(_mk_argv as never)) {
          const _MK_PROGRESS_RE = /^\[[ \d]+%\]|^make\[\d+\]: (?:Entering|Leaving) directory|^Entering directory|^Leaving directory|^--/;
          const _mk_lines = _splitlines(stdout);
          const _mk_total = _mk_lines.length;
          const _mk_kept: string[] = [];
          let _mk_suppressed = 0;
          for (const _mk_line of _mk_lines) {
            if (!_mk_line.trim() || _MK_PROGRESS_RE.test(_mk_line)) {
              _mk_suppressed += 1;
            } else {
              _mk_kept.push(_mk_line);
            }
          }

          if (_mk_suppressed > 0) {
            let _mk_out_id: string | null = null;
            if (session_id) {
              try {
                const _mk_meta = bash_cache.store_output(session_id, display_cmd, stdout, stderr, exit_code, { cwd, min_cache_bytes: 0 });
                if (_mk_meta !== null) {
                  bash_cache.write_sidecar(_mk_meta);
                  _mk_out_id = _mk_meta.output_id;
                }
              } catch {
                // suppressed
              }
            }
            const _mk_recall = _mk_out_id ? `\n[Full output: bash-output ${_mk_out_id}]` : "";

            let _mk_body = _mk_kept.join("\n");
            if (stdout.endsWith("\n") || stdout.endsWith("\r\n")) {
              _mk_body += "\n";
            }
            const _mk_msg =
              `[token-goat] make: ${_mk_total} lines → ${_mk_kept.length} kept (${_mk_suppressed} progress lines hidden)\n` +
              _mk_body +
              _mk_recall;
            _LOG.info("post-bash: make compressed lines=%d kept=%d suppressed=%d cmd=%s", _mk_total, _mk_kept.length, _mk_suppressed, display_cmd.slice(0, 60));
            if (_sess_mod !== null && _session_cache !== null) {
              try {
                _sess_mod.save(_session_cache);
              } catch {
                // suppressed
              }
            }
            return { continue: true, systemMessage: _mk_msg };
          }
        }
      }
    } catch {
      _LOG.debug("post-bash: make compression failed");
    }
  }

  // go test -v compression.
  if (stdout && _splitlines(stdout).length >= _GO_TEST_V_MIN_LINES && (exit_code === null || exit_code === 0 || exit_code === 1)) {
    try {
      const _go_check = _bcFn("_is_go_test_verbose_cmd");
      if (_go_check !== undefined) {
        const _go_argv = process.platform === "win32" ? _nonPosixSplit(display_cmd) : _posixSplit(display_cmd);
        if (_go_argv.length > 0 && _go_check(_go_argv as never)) {
          const _go_lines = _splitlines(stdout);
          const _go_total = _go_lines.length;
          const _go_kept: string[] = [];
          let _go_hidden = 0;
          let _go_pending_run: string | null = null;
          let _go_pending_logs: string[] = [];
          let _go_pending_has_user_logs = false;

          for (const _go_line of _go_lines) {
            const _go_stripped = _go_line.trim();
            if (_go_stripped.startsWith("=== PAUSE")) {
              _go_hidden += 1;
            } else if (_go_stripped.startsWith("=== RUN")) {
              const _go_parts = _go_stripped.split(/\s+/);
              const _go_test_name = _go_parts.length > 0 ? (_go_parts[_go_parts.length - 1] as string) : "";
              if (_go_test_name.includes("/") && _go_pending_run !== null) {
                _go_pending_logs.push(_go_line);
              } else {
                if (_go_pending_run !== null) {
                  if (_go_pending_has_user_logs) {
                    _go_kept.push(_go_pending_run);
                    _go_kept.push(..._go_pending_logs);
                  } else {
                    _go_hidden += 1 + _go_pending_logs.length;
                  }
                }
                _go_pending_run = _go_line;
                _go_pending_logs = [];
                _go_pending_has_user_logs = false;
              }
            } else if (_go_stripped.startsWith("--- PASS:")) {
              const _go_pp = _go_stripped.split(/\s+/);
              const _go_pass_name = _go_pp.length >= 3 ? (_go_pp[2] as string) : "";
              if (_go_pass_name.includes("/") && _go_pending_run !== null) {
                _go_pending_logs.push(_go_line);
              } else if (_go_pending_run !== null && !_go_pending_has_user_logs) {
                _go_hidden += 2 + _go_pending_logs.length;
                _go_pending_run = null;
                _go_pending_logs = [];
                _go_pending_has_user_logs = false;
              } else {
                if (_go_pending_run !== null) {
                  _go_kept.push(_go_pending_run);
                  _go_kept.push(..._go_pending_logs);
                }
                _go_kept.push(_go_line);
                _go_pending_run = null;
                _go_pending_logs = [];
                _go_pending_has_user_logs = false;
              }
            } else if (_go_stripped.startsWith("--- FAIL:")) {
              if (_go_pending_run !== null) {
                _go_kept.push(_go_pending_run);
                _go_kept.push(..._go_pending_logs);
              }
              _go_kept.push(_go_line);
              _go_pending_run = null;
              _go_pending_logs = [];
              _go_pending_has_user_logs = false;
            } else if (_go_pending_run !== null) {
              _go_pending_logs.push(_go_line);
              _go_pending_has_user_logs = true;
            } else {
              _go_kept.push(_go_line);
            }
          }

          if (_go_pending_run !== null) {
            if (_go_pending_has_user_logs) {
              _go_kept.push(_go_pending_run);
              _go_kept.push(..._go_pending_logs);
            } else {
              _go_hidden += 1 + _go_pending_logs.length;
            }
          }

          if (_go_hidden > 0) {
            let _go_out_id: string | null = null;
            if (session_id) {
              try {
                const _go_meta = bash_cache.store_output(session_id, display_cmd, stdout, stderr, exit_code, { cwd, min_cache_bytes: 0 });
                if (_go_meta !== null) {
                  bash_cache.write_sidecar(_go_meta);
                  _go_out_id = _go_meta.output_id;
                }
              } catch {
                // suppressed
              }
            }
            const _go_recall = _go_out_id ? `\n[Full output: bash-output ${_go_out_id}]` : "";
            let _go_body = _go_kept.join("\n");
            if (stdout.endsWith("\n") || stdout.endsWith("\r\n")) {
              _go_body += "\n";
            }
            const _go_msg =
              `[token-goat] go test -v: ${_go_total} lines → ${_go_kept.length} kept (${_go_hidden} lines suppressed)\n` +
              _go_body +
              _go_recall;
            _LOG.info("post-bash: go test -v compressed lines=%d kept=%d hidden=%d cmd=%s", _go_total, _go_kept.length, _go_hidden, display_cmd.slice(0, 60));
            if (_sess_mod !== null && _session_cache !== null) {
              try {
                _sess_mod.save(_session_cache);
              } catch {
                // suppressed
              }
            }
            return { continue: true, systemMessage: _go_msg };
          }
        }
      }
    } catch {
      _LOG.debug("post-bash: go test -v compression failed");
    }
  }

  // tsc compression.
  if (stdout && _splitlines(stdout).length >= _TSC_MIN_LINES) {
    try {
      const _tsc_check = _bcFn("_is_tsc_cmd");
      if (_tsc_check !== undefined) {
        const _tsc_argv = process.platform === "win32" ? _nonPosixSplit(display_cmd) : _posixSplit(display_cmd);
        if (_tsc_argv.length > 0 && _tsc_check(_tsc_argv as never)) {
          const _TSC_DIAG_RE = /^[^\s].+\(\d+,\d+\): (error|warning) TS\d+:/;
          const _TSC_SUMMARY_RE = /^Found \d+ errors?\./;
          const _tsc_lines = _splitlines(stdout);
          const _tsc_total = _tsc_lines.length;
          const _tsc_diag_lines: string[] = [];
          const _tsc_noise_lines: string[] = [];
          let _tsc_summary: string | null = null;
          for (const _tsc_line of _tsc_lines) {
            if (_TSC_SUMMARY_RE.test(_tsc_line)) {
              _tsc_summary = _tsc_line;
            } else if (_TSC_DIAG_RE.test(_tsc_line) || _TSC_BARE_DIAG_RE.test(_tsc_line)) {
              _tsc_diag_lines.push(_tsc_line);
            } else {
              _tsc_noise_lines.push(_tsc_line);
            }
          }

          if (_tsc_noise_lines.length === 0) {
            // nothing to suppress — fall through
          } else {
            let _tsc_out_id: string | null = null;
            if (session_id) {
              try {
                const _tsc_meta = bash_cache.store_output(session_id, display_cmd, stdout, stderr, exit_code, { cwd, min_cache_bytes: 0 });
                if (_tsc_meta !== null) {
                  bash_cache.write_sidecar(_tsc_meta);
                  _tsc_out_id = _tsc_meta.output_id;
                }
              } catch {
                // suppressed
              }
            }
            const _tsc_recall = _tsc_out_id ? `\n[Full output: bash-output ${_tsc_out_id}]` : "";

            let _tsc_msg: string;
            if (_tsc_diag_lines.length === 0 && (exit_code === null || exit_code === 0)) {
              let _tsc_summary_line: string | null = _tsc_summary;
              if (_tsc_summary_line === null) {
                for (let i = _tsc_lines.length - 1; i >= 0; i -= 1) {
                  if ((_tsc_lines[i] as string).trim()) {
                    _tsc_summary_line = _tsc_lines[i] as string;
                    break;
                  }
                }
              }
              let _tsc_body = _tsc_summary_line ? _tsc_summary_line + "\n" : "";
              if (!(stdout.endsWith("\n") || stdout.endsWith("\r\n")) && _tsc_body.endsWith("\n")) {
                _tsc_body = _tsc_body.replace(/\n+$/, "");
              }
              const _tsc_suppressed = _tsc_total - (_tsc_summary_line ? 1 : 0);
              _tsc_msg = `[token-goat] tsc: 0 errors, 0 warnings (${_tsc_suppressed}/${_tsc_total} lines suppressed)\n` + _tsc_body + _tsc_recall;
            } else {
              const _tsc_error_count = _tsc_diag_lines.filter((_l) => /(?:^|: )error TS\d+:/.test(_l)).length;
              const _tsc_warn_count = _tsc_diag_lines.filter((_l) => /(?:^|: )warning TS\d+:/.test(_l)).length;
              const _tsc_body_lines = [..._tsc_diag_lines];
              if (_tsc_summary && (_tsc_body_lines.length === 0 || _tsc_body_lines[_tsc_body_lines.length - 1] !== _tsc_summary)) {
                _tsc_body_lines.push(_tsc_summary);
              }
              let _tsc_body = _tsc_body_lines.join("\n");
              if (stdout.endsWith("\n") || stdout.endsWith("\r\n")) {
                _tsc_body += "\n";
              }
              const _tsc_suppressed = _tsc_total - _tsc_body_lines.length;
              _tsc_msg =
                `[token-goat] tsc: ${_tsc_error_count} errors, ${_tsc_warn_count} warnings (${_tsc_suppressed}/${_tsc_total} lines suppressed)\n` +
                _tsc_body +
                _tsc_recall;
            }
            _LOG.info("post-bash: tsc compressed lines=%d diag=%d cmd=%s", _tsc_total, _tsc_diag_lines.length, display_cmd.slice(0, 60));
            if (_sess_mod !== null && _session_cache !== null) {
              try {
                _sess_mod.save(_session_cache);
              } catch {
                // suppressed
              }
            }
            return { continue: true, systemMessage: _tsc_msg };
          }
        }
      }
    } catch {
      _LOG.debug("post-bash: tsc compression failed");
    }
  }

  return _post_bash_part3(payload, st);
}

/** post_bash pipeline — pytest-failures / JSON-XML / python-TB / minified / JUnit / jest / curl / docker / large-stdout. */
function _post_bash_part3(payload: HookPayload, st: PostBashState): HookResponse {
  const { session_id, cwd, display_cmd, stdout, stderr, exit_code, _sess_mod, _session_cache } = st;

  // Pytest failure traceback suppression.
  if (
    self._is_pytest_command(display_cmd) &&
    (exit_code === null || exit_code === 0 || exit_code === 1) &&
    stdout &&
    stdout.length >= _PYTEST_COMPRESS_MIN_BYTES &&
    stdout.includes("FAILED")
  ) {
    try {
      let _pt_out_id: string | null = null;
      if (session_id) {
        try {
          const _pt_meta = bash_cache.store_output(session_id, display_cmd, stdout, stderr, exit_code, { cwd, min_cache_bytes: 0 });
          if (_pt_meta !== null) {
            bash_cache.write_sidecar(_pt_meta);
            _pt_out_id = _pt_meta.output_id;
          }
        } catch {
          // suppressed
        }
      }

      const _pt_compressed = self._compress_pytest_failures(stdout, _pt_out_id);
      if (_pt_compressed !== stdout) {
        _LOG.info("post-bash: pytest failures compressed bytes=%d->%d cmd=%s", stdout.length, _pt_compressed.length, display_cmd.slice(0, 60));
        if (_sess_mod !== null && _session_cache !== null) {
          try {
            _sess_mod.save(_session_cache);
          } catch {
            // suppressed
          }
        }
        return { continue: true, systemMessage: _pt_compressed };
      }
    } catch {
      _LOG.debug("post-bash: pytest compression failed");
    }
  }

  // Large JSON/XML output summarization.
  if ((exit_code === null || exit_code === 0) && stdout && stdout.length >= _JSON_SUMMARY_MIN_BYTES && stdout.length <= _JSON_SUMMARY_MAX_BYTES) {
    let _jsonParsed = false;
    let _jx_data: unknown = null;
    try {
      _jx_data = JSON.parse(stdout);
      _jsonParsed = true;
    } catch {
      // JSONDecodeError (subclass of ValueError) — fall through to XML check.
    }
    if (_jsonParsed && (_isDict(_jx_data) || Array.isArray(_jx_data))) {
      let _jx_out_id: string | null = null;
      if (session_id) {
        try {
          const _jx_meta = bash_cache.store_output(session_id, display_cmd, stdout, stderr, exit_code, { cwd, min_cache_bytes: 0 });
          if (_jx_meta !== null) {
            bash_cache.write_sidecar(_jx_meta);
            _jx_out_id = _jx_meta.output_id;
          }
        } catch {
          // suppressed
        }
      }
      const _jx_recall = _jx_out_id ? ` (use bash-output ${_jx_out_id} for full)` : "";
      const _jx_summary = self._json_structural_summary(_jx_data);
      const _jx_size = stdout.length;
      _LOG.info("post-bash: large JSON summarized bytes=%d cmd=%s", _jx_size, display_cmd.slice(0, 60));
      return {
        continue: true,
        systemMessage:
          `[token-goat] large JSON output (${_thousands(_jx_size)} bytes) — structural summary${_jx_recall}:\n\n` + _jx_summary,
      };
    }

    // XML detection.
    try {
      const _jx_stripped = stdout.replace(/^\s+/, "");
      const _jx_is_xml =
        _jx_stripped.slice(0, 5) === "<?xml" ||
        (_jx_stripped.slice(0, 1) === "<" && _jx_stripped.length > 1 && /[A-Za-z]/.test(_jx_stripped.slice(1, 2)));
      const _is_junit = _bcFn("_is_junit_xml_output");
      const _junitMatch = _is_junit !== undefined ? (_is_junit(stdout as never) as boolean) : false;
      if (_jx_is_xml && !_junitMatch) {
        let _jx_out_id: string | null = null;
        if (session_id) {
          try {
            const _jx_meta = bash_cache.store_output(session_id, display_cmd, stdout, stderr, exit_code, { cwd, min_cache_bytes: 0 });
            if (_jx_meta !== null) {
              bash_cache.write_sidecar(_jx_meta);
              _jx_out_id = _jx_meta.output_id;
            }
          } catch {
            // suppressed
          }
        }
        const _jx_recall = _jx_out_id ? ` (use bash-output ${_jx_out_id} to recall)` : "";
        const _jx_size = stdout.length;
        _LOG.info("post-bash: large XML suppressed bytes=%d cmd=%s", _jx_size, display_cmd.slice(0, 60));
        return {
          continue: true,
          systemMessage: `[token-goat] large XML output (${_thousands(_jx_size)} bytes) — stored${_jx_recall}`,
        };
      }
    } catch {
      _LOG.debug("post-bash: XML detection failed");
    }
  }

  // Python script traceback compression.
  if (
    exit_code !== null &&
    exit_code !== 0 &&
    stderr &&
    stderr.includes("Traceback (most recent call last):") &&
    _splitlines(stderr).length >= _PYTHON_TB_MIN_STDERR_LINES &&
    !self._is_pytest_command(display_cmd)
  ) {
    try {
      const _py_check = _bcFn("_is_python_script_cmd");
      if (_py_check !== undefined) {
        const _py_argv = process.platform === "win32" ? _nonPosixSplit(display_cmd) : _posixSplit(display_cmd);
        if (_py_argv.length > 0 && _py_check(_py_argv as never)) {
          const _py_stderr_lines = _splitlines(stderr);
          const _py_total = _py_stderr_lines.length;
          const _py_tail = _py_stderr_lines.slice(-15);
          let _py_exc = "unknown error";
          for (let i = _py_stderr_lines.length - 1; i >= 0; i -= 1) {
            if ((_py_stderr_lines[i] as string).trim()) {
              _py_exc = (_py_stderr_lines[i] as string).trim();
              break;
            }
          }
          let _py_out_id: string | null = null;
          if (session_id) {
            try {
              const _py_meta = bash_cache.store_output(session_id, display_cmd, stdout, stderr, exit_code, { cwd, min_cache_bytes: 0 });
              if (_py_meta !== null) {
                bash_cache.write_sidecar(_py_meta);
                _py_out_id = _py_meta.output_id;
              }
            } catch {
              // suppressed
            }
          }
          const _py_recall = _py_out_id ? "\nbash-output " + _py_out_id + " for full output" : "";
          const _py_msg =
            "[token-goat] python crash: " +
            _py_exc +
            " (stderr: " +
            String(_py_total) +
            " lines → 15 kept)\n" +
            _py_tail.join("\n") +
            _py_recall;
          _LOG.info("post-bash: python traceback compressed stderr_lines=%d cmd=%s", _py_total, display_cmd.slice(0, 60));
          if (_sess_mod !== null && _session_cache !== null) {
            try {
              _sess_mod.save(_session_cache);
            } catch {
              // suppressed
            }
          }
          return { continue: true, systemMessage: _py_msg };
        }
      }
    } catch {
      _LOG.debug("post-bash: python traceback compression failed");
    }
  }

  // Minified-file grep elision.
  if (stdout) {
    try {
      const _min_grep_hit = _bcFn("_has_minified_grep_hit");
      const _min_is_grep = _bcFn("_is_grep_cmd");
      const _min_file = _bcFn("_is_minified_file");
      if (_min_grep_hit !== undefined && _min_is_grep !== undefined && _min_file !== undefined) {
        const _min_argv = process.platform === "win32" ? _nonPosixSplit(display_cmd) : _posixSplit(display_cmd);
        if (_min_argv.length > 0 && _min_is_grep(_min_argv as never) && _min_grep_hit(stdout as never)) {
          let _min_out_id: string | null = null;
          if (session_id) {
            try {
              const _min_meta = bash_cache.store_output(session_id, display_cmd, stdout, stderr, exit_code, { cwd, min_cache_bytes: 0 });
              if (_min_meta !== null) {
                bash_cache.write_sidecar(_min_meta);
                _min_out_id = _min_meta.output_id;
              }
            } catch {
              // suppressed
            }
          }
          const _min_recall = _min_out_id ? `\n[Full output: bash-output ${_min_out_id}]` : "";
          let _min_elided = 0;
          const _min_kept: string[] = [];
          for (const _min_line of _splitlines(stdout)) {
            const _mc_search_from = _min_line.length >= 3 && _min_line[1] === ":" && (_min_line[2] === "/" || _min_line[2] === "\\") ? 2 : 0;
            const _mc_idx = _min_line.indexOf(":", _mc_search_from);
            if (_mc_idx >= 1) {
              const _mc_path = _min_line.slice(0, _mc_idx);
              const _mc_rest = _min_line.slice(_mc_idx + 1);
              const _mc_content = _mc_rest.replace(/^\d+:/, "");
              if (_min_file(_mc_path as never) && _mc_content.length > 500) {
                _min_kept.push(`${_mc_path}:...<${_mc_content.length} chars elided, match at offset 0>...${_mc_content.slice(0, 120)}`);
                _min_elided += 1;
                continue;
              }
            }
            _min_kept.push(_min_line);
          }
          if (_min_elided) {
            const _recall_clause = _min_out_id
              ? ` (full content in bash-output ${_min_out_id})`
              : " (full output not stored — no active session)";
            const _min_header = `[token-goat] grep: minified file match — long lines truncated to first 120 chars${_recall_clause}\n`;
            _LOG.info("post-bash: minified grep elision elided=%d cmd=%s", _min_elided, display_cmd.slice(0, 60));
            return { continue: true, systemMessage: _min_header + _min_kept.join("\n") + _min_recall };
          }
        }
      }
    } catch {
      _LOG.debug("post-bash: minified grep elision failed");
    }
  }

  // JUnit XML summary.
  if (stdout) {
    try {
      const _is_junit = _bcFn("_is_junit_xml_output");
      if (_is_junit !== undefined && (_is_junit(stdout as never) as boolean) && (_splitlines(stdout).length >= 10 || stdout.length >= 4096)) {
        const _junit_summary = self._summarize_junit_xml(stdout);
        if (_junit_summary !== null) {
          let _junit_out_id: string | null = null;
          if (session_id) {
            try {
              const _junit_meta = bash_cache.store_output(session_id, display_cmd, stdout, stderr, exit_code, { cwd, min_cache_bytes: 0 });
              if (_junit_meta !== null) {
                bash_cache.write_sidecar(_junit_meta);
                _junit_out_id = _junit_meta.output_id;
              }
            } catch {
              // suppressed
            }
          }
          const _junit_recall = _junit_out_id ? `\n[Full XML: bash-output ${_junit_out_id}]` : "";
          _LOG.info("post-bash: JUnit XML summarised cmd=%s", display_cmd.slice(0, 60));
          return { continue: true, systemMessage: _junit_summary + _junit_recall };
        }
      }
    } catch {
      _LOG.debug("post-bash: JUnit XML summary failed");
    }
  }

  // Jest / Vitest verbose output.
  if (stdout && _splitlines(stdout).length >= 5) {
    try {
      const _is_jest_cmd = _bcFn("_is_jest_cmd");
      const _has_jest_output = _bcFn("_has_jest_output");
      const _has_vitest_output = _bcFn("_has_vitest_output");
      const _compress_jest_output = _bcFn("compress_jest_output");
      if (_is_jest_cmd !== undefined && _has_jest_output !== undefined && _has_vitest_output !== undefined && _compress_jest_output !== undefined) {
        let _jest_argv: string[];
        try {
          _jest_argv = _nonPosixSplit(display_cmd);
        } catch {
          _jest_argv = display_cmd.trim().split(/\s+/).filter((t) => t.length > 0);
        }
        const _jest_argv_clean = _jest_argv.map((t) => _stripQuotes(t));
        if (
          _is_jest_cmd(_jest_argv_clean as never) &&
          ((_has_jest_output(stdout as never) as boolean) || (_has_vitest_output(stdout as never) as boolean)) &&
          (exit_code === null || exit_code === 0 || exit_code === 1)
        ) {
          const [_jest_compressed, _jest_pass_ct, _jest_fail_ct] = _compress_jest_output(stdout as never) as [string, number, number];
          if (_jest_pass_ct > 0 && _jest_compressed.trim()) {
            const _jest_lines_orig = _splitlines(stdout).length;
            const _jest_lines_new = _splitlines(_jest_compressed).length;
            const _jest_saved = _jest_lines_orig - _jest_lines_new;
            let _jest_out_id: string | null = null;
            if (session_id) {
              try {
                const _jest_meta = bash_cache.store_output(session_id, display_cmd, stdout, stderr, exit_code, { cwd, min_cache_bytes: 0 });
                if (_jest_meta !== null) {
                  bash_cache.write_sidecar(_jest_meta);
                  _jest_out_id = _jest_meta.output_id;
                }
              } catch {
                // suppressed
              }
            }
            const _jest_recall = _jest_out_id ? ` (bash-output ${_jest_out_id} to recall full output)` : "";
            const _jest_header =
              `[token-goat] jest: ${_jest_pass_ct} PASS suite(s) suppressed ` +
              `(${_jest_saved} lines removed), ${_jest_fail_ct} FAIL suite(s) shown${_jest_recall}`;
            _LOG.info("post-bash: jest output compressed pass=%d fail=%d cmd=%s", _jest_pass_ct, _jest_fail_ct, display_cmd.slice(0, 60));
            return { continue: true, systemMessage: _jest_header + "\n\n" + _jest_compressed };
          }
        }
      }
    } catch {
      _LOG.debug("post-bash: jest compress failed");
    }
  }

  // curl -v verbose output compressor.
  if (stdout && (exit_code === null || exit_code === 0) && stdout.split("\n").length >= 10) {
    try {
      const _is_curl = _bcFn("_is_curl_verbose_cmd");
      const _has_curl = _bcFn("_has_curl_verbose_output");
      const _compress_curl = _bcFn("compress_curl_verbose");
      if (_is_curl !== undefined && _has_curl !== undefined && _compress_curl !== undefined) {
        let _curl_argv: string[];
        try {
          _curl_argv = _nonPosixSplit(display_cmd);
        } catch {
          _curl_argv = display_cmd.trim().split(/\s+/).filter((t) => t.length > 0);
        }
        const _curl_argv_clean = _curl_argv.map((t) => _stripQuotes(t));
        if ((_is_curl(_curl_argv_clean as never) as boolean) && (_has_curl(stdout as never) as boolean)) {
          const [_curl_compressed, _curl_lines_removed] = _compress_curl(stdout as never) as [string, number];
          if (_curl_lines_removed > 0 && _curl_compressed.trim()) {
            let _curl_out_id: string | null = null;
            if (session_id) {
              try {
                const _curl_meta = bash_cache.store_output(session_id, display_cmd, stdout, stderr, exit_code, { cwd, min_cache_bytes: 0 });
                if (_curl_meta !== null) {
                  bash_cache.write_sidecar(_curl_meta);
                  _curl_out_id = _curl_meta.output_id;
                }
              } catch {
                // suppressed
              }
            }
            let _curl_status_code = "";
            for (const _cln of _splitlines(stdout)) {
              const _sm = /^< HTTP\/[12](?:\.\d)? (\d{3})/.exec(_cln);
              if (_sm) {
                _curl_status_code = _sm[1] as string;
                break;
              }
            }
            const _curl_recall = _curl_out_id ? `\nFull output: bash-output ${_curl_out_id}` : "";
            const _curl_status_str = _curl_status_code ? `, HTTP ${_curl_status_code}` : "";
            const _curl_header =
              `[token-goat] curl -v: ${_curl_lines_removed} verbose lines stripped ` +
              `(TLS/connection/headers). Kept: request line${_curl_status_str}, content-type.${_curl_recall}`;
            _LOG.info("post-bash: curl verbose compressed lines_removed=%d cmd=%s", _curl_lines_removed, display_cmd.slice(0, 60));
            return { continue: true, systemMessage: _curl_header + "\n\n" + _curl_compressed };
          }
        }
      }
    } catch {
      _LOG.debug("post-bash: curl verbose compress failed");
    }
  }

  // docker build output compressor.
  if (stdout && (exit_code === null || exit_code === 0) && stdout.split("\n").length >= 10) {
    try {
      const _is_docker = _bcFn("_is_docker_build_cmd");
      const _has_docker = _bcFn("_has_docker_build_output");
      const _compress_docker = _bcFn("compress_docker_build");
      if (_is_docker !== undefined && _has_docker !== undefined && _compress_docker !== undefined) {
        let _docker_argv: string[];
        try {
          _docker_argv = _nonPosixSplit(display_cmd);
        } catch {
          _docker_argv = display_cmd.trim().split(/\s+/).filter((t) => t.length > 0);
        }
        const _docker_argv_clean = _docker_argv.map((t) => _stripQuotes(t));
        if ((_is_docker(_docker_argv_clean as never) as boolean) && (_has_docker(stdout as never) as boolean)) {
          const [_docker_compressed, _docker_lines_removed] = _compress_docker(stdout as never) as [string, number];
          if (_docker_lines_removed > 0 && _docker_compressed.trim()) {
            let _docker_out_id: string | null = null;
            if (session_id) {
              try {
                const _docker_meta = bash_cache.store_output(session_id, display_cmd, stdout, stderr, exit_code, { cwd, min_cache_bytes: 0 });
                if (_docker_meta !== null) {
                  bash_cache.write_sidecar(_docker_meta);
                  _docker_out_id = _docker_meta.output_id;
                }
              } catch {
                // suppressed
              }
            }
            const _docker_recall = _docker_out_id ? `\nFull output: bash-output ${_docker_out_id}` : "";
            const _docker_header =
              `[token-goat] docker build: ${_docker_lines_removed} build steps ` +
              "compressed (cache/hash/sub-step lines removed). " +
              `Kept: step headers, RUN output, errors.${_docker_recall}`;
            _LOG.info("post-bash: docker build compressed lines_removed=%d cmd=%s", _docker_lines_removed, display_cmd.slice(0, 60));
            return { continue: true, systemMessage: _docker_header + "\n\n" + _docker_compressed };
          }
        }
      }
    } catch {
      _LOG.debug("post-bash: docker build compress failed");
    }
  }

  // Large plain-text stdout fallback compressor.
  if ((exit_code === null || exit_code === 0) && stdout && _splitlines(stdout).length >= _LARGE_STDOUT_LINE_THRESHOLD) {
    try {
      const _lc_lines = _splitlines(stdout);
      const _lc_total = _lc_lines.length;
      let _lc_out_id: string | null = null;
      if (session_id) {
        try {
          const _lc_meta = bash_cache.store_output(session_id, display_cmd, stdout, stderr, exit_code, { cwd, min_cache_bytes: 0 });
          if (_lc_meta !== null) {
            bash_cache.write_sidecar(_lc_meta);
            _lc_out_id = _lc_meta.output_id;
          }
        } catch {
          // suppressed
        }
      }
      const _lc_recall = _lc_out_id ? ` (bash-output ${_lc_out_id} to recall)` : "";
      const _lc_head = _lc_lines.slice(0, 10).join("\n");
      const _lc_tail = _lc_lines.slice(-5).join("\n");
      const _lc_omitted = _lc_total - 15;
      _LOG.info("post-bash: large stdout compressed lines=%d cmd=%s", _lc_total, display_cmd.slice(0, 60));
      return {
        continue: true,
        systemMessage:
          `[token-goat] large output: ${_lc_total} lines ${_lc_out_id ? "stored" : "preview"}${_lc_recall}\n\n` +
          "```\n" +
          `${_lc_head}\n` +
          "```\n\n" +
          `... (${_lc_omitted} lines omitted) ...\n\n` +
          "```\n" +
          `${_lc_tail}\n` +
          "```",
      };
    } catch {
      _LOG.debug("post-bash: large stdout compression failed");
    }
  }

  return _post_bash_part4(payload, st);
}

/** post_bash pipeline — dir-listing / git-diff-delta / stderr-delta / binary / dedup / cache / hints. */
function _post_bash_part4(payload: HookPayload, st: PostBashState): HookResponse {
  const { session_id, cwd, command, display_cmd, stdout, stderr, exit_code, _sess_mod, _session_cache } = st;

  // Dir-listing fingerprint cache.
  if (_sess_mod !== null && _session_cache !== null && (exit_code === null || exit_code === 0) && stdout) {
    try {
      const _dir_listing_cmd_type = _bcFn("_dir_listing_cmd_type");
      if (_dir_listing_cmd_type !== undefined) {
        let _dl_argv: string[];
        try {
          _dl_argv = _nonPosixSplit((display_cmd.split("|")[0] as string).trim());
        } catch {
          _dl_argv = display_cmd.trim().split(/\s+/).filter((t) => t.length > 0);
        }
        const _dl_type = _dir_listing_cmd_type(_dl_argv as never) as string | null;
        if (_dl_type !== null) {
          const _dl_args = _dl_argv.slice(1);
          let _dl_dir_raw: string | null = null;
          let _dl_skip_next = false;
          let _dl_skip_positional = _dl_type === "fd";
          const _DL_CONSUME_NEXT = new Set<string>([
            "--max-depth", "--maxdepth", "-maxdepth", "--min-depth", "--mindepth",
            "--type", "-type", "--extension", "-e", "--exclude", "--name", "-name",
            "--ignore", "-d", "--depth", "-l", "--level",
          ]);
          for (const _dl_tok of _dl_args) {
            if (_dl_skip_next) {
              _dl_skip_next = false;
              continue;
            }
            const _dl_clean = _stripQuotes(_dl_tok);
            if (_dl_clean.startsWith("-")) {
              if (_DL_CONSUME_NEXT.has(_dl_clean)) {
                _dl_skip_next = true;
              }
              continue;
            }
            if (_dl_skip_positional) {
              _dl_skip_positional = false;
              continue;
            }
            _dl_dir_raw = _dl_clean;
            break;
          }
          if (_dl_dir_raw) {
            let _dl_p = _dl_dir_raw;
            if (!nodePath.isAbsolute(_dl_p) && cwd) {
              _dl_p = nodePath.join(cwd, _dl_dir_raw);
            }
            let _dl_norm = "";
            try {
              _dl_norm = _resolvePosix(_dl_p);
            } catch {
              _dl_norm = "";
            }
            if (_dl_norm) {
              const _dl_cmd_fp = _sha256Hex(display_cmd).slice(0, 16);
              const _dl_key = `${_dl_norm}:${_dl_cmd_fp}`;
              const _dl_out_hash = _sha256Hex(stdout.replace(/\r\n/g, "\n")).slice(0, 16);
              const _dl_cached = _session_cache.get_dir_listing_hit(_dl_key);
              if (_dl_cached !== null && _dl_cached === _dl_out_hash) {
                _LOG.info("post-bash: dir-listing cache hit suppressed output dir=%s type=%s", sanitize_log_str(_dl_norm), _dl_type);
                try {
                  _sess_mod.save(_session_cache);
                } catch {
                  // suppressed
                }
                return {
                  continue: true,
                  systemMessage:
                    `[token-goat] Directory listing for '${_dl_dir_raw}' unchanged` +
                    " — suppressed duplicate output (re-run to see full listing)",
                };
              }
              _session_cache.record_dir_listing(_dl_key, _dl_out_hash);
              try {
                _sess_mod.save(_session_cache);
              } catch {
                // suppressed
              }
            }
          }
        }
      }
    } catch {
      _LOG.debug("post-bash: dir-listing cache check failed");
    }
  }

  // Git diff delta cache.
  if ((exit_code === null || exit_code === 0) && stdout.length >= _GIT_DIFF_MIN_BYTES && session_id) {
    try {
      let _gd_argv: string[];
      try {
        _gd_argv = _nonPosixSplit((display_cmd.split("|")[0] as string).trim());
      } catch {
        _gd_argv = display_cmd.trim().split(/\s+/).filter((t) => t.length > 0);
      }
      const _gd_argv_clean = _gd_argv.map((t) => _stripQuotes(t));
      if (self._is_git_diff_target(_gd_argv_clean)) {
        const _gd_norm_args = self._normalize_git_diff_args(_gd_argv_clean);
        const _gd_head_sha = self._get_head_sha(cwd);
        if (_gd_head_sha !== null) {
          const _gd_key = `${session_id}:${_gd_norm_args}:${_gd_head_sha}`;
          const _gd_marker_cmd = `__git_diff_cache__:${_gd_key}`;
          const _gd_prior_meta = bash_cache.find_cached_for_command(_gd_marker_cmd, cwd);
          let _gd_prior_text: string | null = null;
          if (_gd_prior_meta !== null) {
            _gd_prior_text = bash_cache.load_output(_gd_prior_meta.output_id);
          }
          try {
            const _gd_stored = bash_cache.store_output(session_id, _gd_marker_cmd, stdout, "", 0, { cwd, min_cache_bytes: 0 });
            if (_gd_stored !== null) {
              bash_cache.write_sidecar(_gd_stored);
            }
          } catch {
            // suppressed
          }
          if (_gd_prior_text !== null) {
            const _gd_new_lines = _splitlines(stdout);
            const _gd_old_lines = _splitlines(_gd_prior_text);
            const _gd_old_cnt = _counter(_gd_old_lines);
            const _gd_new_cnt = _counter(_gd_new_lines);
            const _gd_added: string[] = [];
            for (const [_ln, _cnt] of _gd_new_cnt) {
              const _extra = _cnt - (_gd_old_cnt.get(_ln) ?? 0);
              for (let k = 0; k < _extra; k += 1) {
                _gd_added.push(_ln);
              }
            }
            const _gd_removed: string[] = [];
            for (const [_ln, _cnt] of _gd_old_cnt) {
              const _extra = _cnt - (_gd_new_cnt.get(_ln) ?? 0);
              for (let k = 0; k < _extra; k += 1) {
                _gd_removed.push(_ln);
              }
            }
            const _gd_delta_n = _gd_added.length + _gd_removed.length;
            if (_gd_delta_n === 0) {
              _LOG.info("post-bash: git diff unchanged; suppressing output key=%s", _gd_key.slice(0, 60));
              return { continue: true, systemMessage: "[token-goat] git diff unchanged since last run — output suppressed" };
            } else if (_gd_delta_n < _GIT_DIFF_SMALL_DELTA) {
              // small delta: full new diff passes through unchanged
            } else {
              const _gd_delta_lines = [..._gd_added.map((ln) => `+ ${ln}`), ..._gd_removed.map((ln) => `- ${ln}`)];
              const _gd_preview = _gd_delta_lines.slice(0, _GIT_DIFF_DELTA_PREVIEW_LINES).join("\n");
              _LOG.info("post-bash: git diff changed; delta summary key=%s added=%d removed=%d", _gd_key.slice(0, 60), _gd_added.length, _gd_removed.length);
              return {
                continue: true,
                systemMessage:
                  `[token-goat] git diff changed: ${_gd_added.length} lines added, ${_gd_removed.length} lines removed vs prior run\n${_gd_preview}`,
              };
            }
          }
        }
      }
    } catch {
      _LOG.debug("post-bash: git diff delta cache check failed");
    }
  }

  // Stderr delta.
  if (exit_code !== null && exit_code !== 0 && stderr.length >= _STDERR_DELTA_MIN_BYTES && session_id) {
    try {
      const _sd_prior_meta = bash_cache.find_cached_for_command(display_cmd, cwd);
      if (_sd_prior_meta !== null && _sd_prior_meta.exit_code !== null && _sd_prior_meta.exit_code !== 0 && _sd_prior_meta.stderr_bytes > 0) {
        const _sd_prior_body = bash_cache.load_output(_sd_prior_meta.output_id);
        if (_sd_prior_body !== null) {
          const _SD_SEP = "\n--- stderr ---\n";
          let _sd_prior_stderr: string;
          if (_sd_prior_body.includes(_SD_SEP)) {
            _sd_prior_stderr = _sd_prior_body.split(_SD_SEP).slice(1).join(_SD_SEP);
          } else {
            _sd_prior_stderr = _sd_prior_body;
          }
          const _sd_old_lines = _splitlines(_sd_prior_stderr);
          const _sd_new_lines = _splitlines(stderr);
          const _sd_old_cnt = _counter(_sd_old_lines);
          const _sd_new_cnt = _counter(_sd_new_lines);
          const _sd_added: string[] = [];
          for (const [_ln, _cnt] of _sd_new_cnt) {
            const _extra = _cnt - (_sd_old_cnt.get(_ln) ?? 0);
            for (let k = 0; k < _extra; k += 1) {
              _sd_added.push(_ln);
            }
          }
          const _sd_removed: string[] = [];
          for (const [_ln, _cnt] of _sd_old_cnt) {
            const _extra = _cnt - (_sd_new_cnt.get(_ln) ?? 0);
            for (let k = 0; k < _extra; k += 1) {
              _sd_removed.push(_ln);
            }
          }
          const _sd_delta_n = _sd_added.length + _sd_removed.length;
          try {
            const _sd_cur_meta = bash_cache.store_output(session_id, display_cmd, stdout, stderr, exit_code, { cwd });
            if (_sd_cur_meta !== null) {
              bash_cache.write_sidecar(_sd_cur_meta);
            }
          } catch {
            // suppressed
          }
          if (_sd_delta_n === 0) {
            _LOG.info("post-bash: stderr identical; suppressing %d lines cmd=%s", _sd_new_lines.length, display_cmd.slice(0, 60));
            return {
              continue: true,
              systemMessage: `[token-goat] stderr identical to prior run — ${_sd_new_lines.length} error lines suppressed`,
            };
          } else if (_sd_delta_n < _STDERR_DELTA_SMALL) {
            // small delta: full stderr passes through unchanged
          } else {
            const _sd_new_section = _sd_added.slice(0, _STDERR_DELTA_MAX_PREVIEW).join("\n");
            let _sd_msg =
              `[token-goat] stderr changed vs prior run: ${_sd_added.length} new lines, ${_sd_removed.length} resolved\n` +
              `--- New error lines ---\n${_sd_new_section}`;
            if (_sd_removed.length > 0) {
              _sd_msg += `\n(${_sd_removed.length} prior error line(s) resolved)`;
            }
            _LOG.info("post-bash: stderr changed; delta cmd=%s added=%d resolved=%d", display_cmd.slice(0, 60), _sd_added.length, _sd_removed.length);
            return { continue: true, systemMessage: _sd_msg };
          }
        }
      }
    } catch {
      _LOG.debug("post-bash: stderr delta check failed");
    }
  }

  // Binary output detection.
  if (self._is_binary_output(stdout, stderr)) {
    _LOG.info("post-bash: binary output detected; skipping cache (cmd=%s)", display_cmd.slice(0, 80));
    return CONTINUE();
  }

  // Repeated-command output dedup.
  if (
    _sess_mod !== null &&
    _session_cache !== null &&
    session_id &&
    (exit_code === null || exit_code === 0) &&
    stdout &&
    stdout.length >= _CMD_DEDUP_MIN_BYTES &&
    !display_cmd.replace(/^\s+/, "").startsWith("git diff")
  ) {
    try {
      const _coh = _session_cache.cmd_output_hashes;
      const _new_hash = _sha256Hex(stdout);
      const _prev_hash = _coh[display_cmd];
      if (_prev_hash !== undefined && _prev_hash === _new_hash) {
        const _n_lines = (stdout.match(/\n/g)?.length ?? 0) + (stdout && !stdout.endsWith("\n") ? 1 : 0);
        _LOG.info("post-bash: cmd-output dedup suppressed cmd=%s", display_cmd.slice(0, 60));
        let _dedup_recall = "";
        try {
          const _dedup_cmd_sha = bash_cache.command_hash(display_cmd, cwd);
          const _dedup_hist = _session_cache.bash_history[_dedup_cmd_sha] as
            | { output_id: string; truncated: boolean; output_sha: string | null }
            | undefined;
          if (_dedup_hist && _dedup_hist.output_id) {
            _dedup_recall = ` (bash-output ${_dedup_hist.output_id} to recall)`;
          }
          if (_dedup_hist) {
            _sess_mod.mark_bash_run(
              session_id,
              _dedup_cmd_sha,
              display_cmd,
              _dedup_hist.output_id,
              _utf8_bytes(stdout).length,
              _utf8_bytes(stderr).length,
              exit_code,
              _dedup_hist.truncated,
              { output_sha: _dedup_hist.output_sha ?? "", cache: _session_cache },
            );
          }
        } catch {
          _LOG.debug("post-bash: dedup mark_bash_run failed");
        }
        try {
          _sess_mod.save(_session_cache);
        } catch {
          // suppressed
        }
        return {
          continue: true,
          systemMessage: `[token-goat] output unchanged from previous run (${_n_lines} lines${_dedup_recall})`,
        };
      }
      const _cohKeys = Object.keys(_coh);
      if (_cohKeys.length >= _CMD_DEDUP_MAX_CMDS) {
        delete _coh[_cohKeys[0] as string];
      }
      _coh[display_cmd] = _new_hash;
      try {
        _sess_mod.save(_session_cache);
      } catch {
        // suppressed
      }
    } catch {
      _LOG.debug("post-bash: cmd-output dedup check failed");
    }
  }

  const total_bytes = _utf8_bytes(stdout).length + _utf8_bytes(stderr).length;
  if (total_bytes < _BASH_CACHE_MIN_BYTES) {
    _LOG.debug("post-bash: output too small to cache (%d bytes < %d threshold)", total_bytes, _BASH_CACHE_MIN_BYTES);
    if (exit_code !== null && exit_code !== 0 && session_id && _sess_mod !== null) {
      const _cmd_sha = bash_cache.command_hash(display_cmd, cwd);
      const _output_id = `small:${_cmd_sha.slice(0, 8)}:${Math.trunc(exit_code)}`;
      const _output_sha = cache_common.short_content_hash(stdout + stderr);
      try {
        _sess_mod.mark_bash_run(
          session_id,
          _cmd_sha,
          display_cmd,
          _output_id,
          _utf8_bytes(stdout).length,
          _utf8_bytes(stderr).length,
          exit_code,
          false,
          { output_sha: _output_sha, cache: _session_cache },
        );
        _LOG.debug("post-bash: recorded failed small command exit=%s bytes=%d cmd=%s", exit_code, total_bytes, display_cmd.slice(0, 60));
      } catch (exc) {
        _LOG.debug("post-bash: failed-small session record failed: %s", String(exc));
      }
    }
    return CONTINUE();
  }
  if (!session_id) {
    _LOG.debug("post-bash: no session_id; output not cached");
    return CONTINUE();
  }

  if (_sess_mod === null) {
    // session_id truthy implies _get_session() returned the module; guard for TS.
    return CONTINUE();
  }
  const _session = _sess_mod;

  const _bc_cfg = config.load().bash_compress;
  const meta = bash_cache.store_output(session_id, display_cmd, stdout, stderr, exit_code, {
    cwd,
    max_total_bytes: _bc_cfg?.cache_max_bytes ?? 16 * 1024 * 1024,
    max_file_count: _bc_cfg?.cache_max_file_count ?? 4096,
    min_cache_bytes: _bc_cfg?.cache_min_bytes ?? 0,
    max_cache_bytes: _bc_cfg?.cache_max_bytes_per_output ?? 50 * 1024 * 1024,
  });
  if (meta === null) {
    record_cached_stat("bash_output_too_small", sanitize_log_str(display_cmd, 200), 0);
    return CONTINUE();
  }
  bash_cache.write_sidecar(meta);

  const output_sha = cache_common.short_content_hash(stdout + stderr);

  try {
    _session.mark_bash_run(
      session_id,
      meta.cmd_sha,
      display_cmd,
      meta.output_id,
      meta.stdout_bytes,
      meta.stderr_bytes,
      meta.exit_code,
      meta.truncated,
      { output_sha, cache: _session_cache },
    );
  } catch (exc) {
    _LOG.debug("post-bash: session record failed: %s", String(exc));
  }

  record_cached_stat("bash_output_cached", sanitize_log_str(display_cmd, 200), total_bytes);

  _LOG.info("post-bash: cached output id=%s bytes=%d exit=%s truncated=%s", meta.output_id, total_bytes, exit_code, meta.truncated);

  // Scoped-diff hint.
  if (_session_cache !== null) {
    try {
      if (bash_cache.is_unscoped_git_diff(display_cmd)) {
        const _diff_output_len = _utf8_bytes(stdout).length + _utf8_bytes(stderr).length;
        if (_diff_output_len >= 4096) {
          const _diff_edited = Object.keys(_session_cache.edited_files);
          if (_diff_edited.length >= 1 && _diff_edited.length <= 10) {
            const _diff_hint = hints.build_scoped_diff_hint(_diff_output_len, _diff_edited);
            record_cached_stat("git_diff_scope_hint", sanitize_log_str(display_cmd, 200));
            _LOG.info("post-bash: git diff scope hint injected, output=%d bytes, edited=%d files", _diff_output_len, _diff_edited.length);
            return { continue: true, systemMessage: _diff_hint };
          }
        }
      }
    } catch {
      _LOG.debug("post-bash: git diff scope hint failed");
    }
  }

  // pytest failure delta.
  if (self._is_pytest_command(display_cmd) && _sess_mod !== null && _session_cache !== null) {
    try {
      const _curr = new Set(self._extract_pytest_failure_ids(stdout + stderr));
      const _prev = new Set(_session_cache.pytest_failures[meta.cmd_sha] ?? []);
      const _new_failures = Array.from(_curr).filter((x) => !_prev.has(x)).sort();
      const _fixed = Array.from(_prev).filter((x) => !_curr.has(x)).sort();
      _session_cache.pytest_failures[meta.cmd_sha] = Array.from(_curr).sort();
      _session_cache._invalidate_json_cache();
      try {
        _sess_mod.save(_session_cache);
      } catch {
        // suppressed
      }
      if (_prev.size > 0 && (_new_failures.length > 0 || _fixed.length > 0)) {
        const _parts: string[] = [];
        if (_new_failures.length > 0) {
          const _shown = _new_failures.slice(0, 5).join(", ");
          const _more = _new_failures.length > 5 ? ` (+${_new_failures.length - 5} more)` : "";
          _parts.push(`${_new_failures.length} new: ${_shown}${_more}`);
        }
        if (_fixed.length > 0) {
          const _shown_f = _fixed.slice(0, 5).join(", ");
          const _more_f = _fixed.length > 5 ? ` (+${_fixed.length - 5} more)` : "";
          _parts.push(`${_fixed.length} fixed: ${_shown_f}${_more_f}`);
        }
        const _delta_msg = "pytest delta — " + _parts.join("; ");
        return { continue: true, systemMessage: _delta_msg };
      }
    } catch {
      _LOG.debug("post-bash: pytest delta failed");
    }
  }

  // Auto-promote oversized unfiltered bash output.
  const _AUTO_PROMOTE_BYTES = 8192;
  const _was_filtered = display_cmd !== command;
  if ((_bc_cfg?.enabled ?? true) && !_was_filtered && total_bytes > _AUTO_PROMOTE_BYTES) {
    try {
      let _argv: string[];
      try {
        _argv = _posixSplit(display_cmd);
      } catch {
        _argv = [];
      }
      const _filter_match = _argv.length > 0 ? bash_detect.detect(_argv) : null;
      const _stem = _argv.length > 0 ? _stemLower(_argv[0] as string) : "";
      const _is_tg_cmd = ["token-goat", "token_goat", "tg"].includes(_stem);
      if (_filter_match === null && !_is_tg_cmd) {
        const _combined = stdout.replace(/\n+$/, "") + (stderr.trim() ? "\n" + stderr.replace(/\n+$/, "") : "");
        const _lines = _splitlines(_combined);
        const _HEAD = 30;
        const _TAIL = 10;
        let _preview: string;
        if (_lines.length <= _HEAD + _TAIL) {
          _preview = _lines.join("\n");
        } else {
          const _omitted = _lines.length - _HEAD - _TAIL;
          _preview = _lines.slice(0, _HEAD).join("\n") + `\n... [${_omitted} lines omitted] ...\n` + _lines.slice(-_TAIL).join("\n");
        }
        const _short_cmd = display_cmd.slice(0, 80) + (display_cmd.length > 80 ? "..." : "");
        const _promote_msg =
          `[token-goat] Large output from \`${_short_cmd}\` (${_thousands(total_bytes)} bytes)` +
          ` stored as bash-output ${meta.output_id}.\n` +
          `Preview (first ${_HEAD} lines):\n` +
          `${_preview}\n` +
          `[${_thousands(total_bytes)} bytes total — retrieve full output: \`token-goat bash-output ${meta.output_id}\`]`;
        record_cached_stat("bash_output_auto_promote", sanitize_log_str(display_cmd, 200), total_bytes);
        _LOG.info("post-bash: auto-promote id=%s bytes=%d cmd=%s", meta.output_id, total_bytes, display_cmd.slice(0, 80));
        return { continue: true, systemMessage: _promote_msg };
      }
    } catch {
      _LOG.debug("post-bash: auto-promote failed");
    }
  }

  return CONTINUE();
}

/** collections.Counter over a list of strings → a Map of value → count. */
function _counter(lines: string[]): Map<string, number> {
  const m = new Map<string, number>();
  for (const ln of lines) {
    m.set(ln, (m.get(ln) ?? 0) + 1);
  }
  return m;
}

// ===========================================================================
// pre_screenshot — public entrypoint
// ===========================================================================

/** Deny MCP screenshot calls without a save-to-disk arg; force save so image-shrink applies. */
export function pre_screenshot(payload: HookPayload): HookResponse {
  const cfg = config.load().image_shrink;
  if (!(cfg?.screenshot_redirect ?? true)) {
    return CONTINUE();
  }

  const tool_input = get_tool_input(payload);
  if (tool_input["filePath"] || tool_input["file_path"] || tool_input["filename"]) {
    return CONTINUE();
  }

  // tempfile.mktemp(suffix=".png", prefix="tg-screenshot-") — unique path per call.
  const tmp_path = nodePath.join(os.tmpdir(), `tg-screenshot-${crypto.randomBytes(8).toString("hex")}.png`);
  const reason = "Screenshot result not saved — add the save-to-disk argument first.";
  const context =
    "MCP screenshot tools return raw image bytes that bypass image-shrink and consume " +
    "~39K tokens per call. Re-issue with the save argument set, then Read the path — " +
    "the Read hook will compress it automatically.\n" +
    '  chrome-devtools: add `"filePath": "' +
    tmp_path +
    '"` to this tool call\n' +
    '  playwright:      add `"filename": "' +
    tmp_path +
    '"` to this tool call\n' +
    `  then \`Read({"file_path": "${tmp_path}"})\`.`;
  return deny_redirect(reason, context);
}
