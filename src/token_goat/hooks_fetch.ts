/**
 * Pre/post-fetch hook handlers: image redirect + WebFetch text dedup cache.
 *
 * Faithful TypeScript port of src/token_goat/hooks_fetch.py.
 *
 * Four responsibilities run from this module:
 *
 * 1. Drive image / WebFetch image redirect: downloads to image URLs are routed
 *    through `token-goat fetch-image` so the shrink+cache pipeline applies
 *    before bytes hit context.
 * 2. WebFetch text dedup hint: when a non-image URL is fetched a second time in
 *    the same session, the pre-fetch hook suggests retrieving the cached body
 *    via `token-goat web-output` instead of re-fetching.
 * 3. WebFetch text capture: the post-fetch hook persists the response body to
 *    `data_dir() / "web_outputs"` and records the (url_sha -> output_id) mapping
 *    in the session cache so step 2 has something to point at.
 * 4. MCP read-only call dedup: repeated read-only MCP tool calls are denied at
 *    warm+ pressure when a cached result from the same session exists.
 *
 * DISPATCH CONTRACT: this module is resolved lazily by hooks_cli's
 * _resolve_handler via import("./hooks_fetch.js"); it must export the bare
 * handlers `pre_fetch` and `post_fetch` (the `attr` names in hook_registry's
 * HOOK_EVENTS). hooks_cli wraps them in fail_soft; they themselves degrade
 * gracefully (return CONTINUE) on internal failure.
 *
 * Port notes (Python -> TS):
 *  - Static ESM imports for ALL ported siblings (hooks_common, session, config,
 *    db, web_cache, mcp_cache, cache_common, hints) so a test's vi.spyOn(x, "fn")
 *    is observed (createRequire would load a separate instance).
 *  - gdrive, webfetch, and compact.get_context_pressure are NOT yet ported
 *    (Layer 7 / not-yet). Each is reached through a fail-soft injection seam:
 *    a module-level override + a _setXModule() setter registered with reset.ts.
 *    When the seam is absent the hook degrades exactly like the Python
 *    ImportError fall-through would (CONTINUE / skip).
 *  - Python lazy `from . import x` inside a function => the corresponding TS
 *    static-imported symbol (ported) or seam resolver (unported) is read at the
 *    same point.
 */

import * as contextlibSession from "./session.js"; // session.save / safe_load / lookup_web_entry / mark_web_fetch
import * as config from "./config.js";
import * as db from "./db.js";
import * as web_cache from "./web_cache.js";
import * as mcp_cache from "./mcp_cache.js";
import * as cache_common from "./cache_common.js";
import * as hints from "./hints.js";
import * as gdrive from "./gdrive.js";
import * as webfetch from "./webfetch.js";

import { getLogger } from "./util.js";
import { registerReset } from "./reset.js";

import {
  CONTINUE,
  LOG as _LOG,
  deny_redirect,
  extract_tool_response_text,
  get_hook_context,
  get_session_context,
  get_tool_input,
  is_real_int,
  pre_tool_use_with_context,
  record_cached_stat,
  run_dedup_hint,
  sanitize_log_str,
} from "./hooks_common.js";

import type { HookPayload, HookResponse } from "./types.js";
import type { SessionCache } from "./session.js";

const session = contextlibSession;

// ===========================================================================
// Fail-soft seams for late-layered modules
// ===========================================================================

// --- gdrive seam (Layer 7 — PORTED; defaults to the real module) ----------
// The Python pre_fetch path does `from . import gdrive` and calls
// gdrive._validate_file_id(file_id), gdrive.get_credentials(), and
// gdrive.is_text_path(Path(filename)). gdrive.ts is now ported, so this seam
// DEFAULTS to the real module (the resume.ts default-to-real pattern). A test
// may still inject a fake (e.g. a get_credentials that throws "no creds") or
// force the fail-soft path (null) — exactly mirroring Python's
// `try/except ImportError` when the optional Google libraries are absent.
interface _GdriveModule {
  _validate_file_id(file_id: string): void;
  get_credentials(): unknown;
  is_text_path(path: string): boolean;
}

const _gdriveDefault: _GdriveModule = gdrive;
// `undefined` override = use the real default; explicit `null` = force
// fail-soft; object = test stub.
let _gdriveOverride: _GdriveModule | null | undefined;

/**
 * Test/late-layer seam: inject a gdrive implementation. Pass an object to
 * stub, `null` to force the fail-soft (no-module) path, or `undefined` to
 * restore the real default.
 */
export function _setGdriveModule(mod: _GdriveModule | null | undefined): void {
  _gdriveOverride = mod;
}

/**
 * Resolve the gdrive module: an explicit override (object or null) wins, else
 * the real module default. Returns null only when a test forced fail-soft.
 */
function _getGdrive(): _GdriveModule | null {
  if (_gdriveOverride !== undefined) {
    return _gdriveOverride;
  }
  return _gdriveDefault;
}

// --- webfetch seam (Layer 7 — PORTED; defaults to the real module) ---------
// Python: `from . import webfetch` then webfetch.is_image_url(url) and
// webfetch._strip_html_to_text(body_bytes). webfetch.ts is now ported, so this
// seam DEFAULTS to the real module. A test may inject a fake or force fail-soft
// (null); in the fail-soft path is_image_url is treated as false (treat as a
// normal text fetch) and the HTML strip is a no-op, exactly Python's
// `try/except ImportError` behaviour (the strip "must never break caching").
interface _WebfetchModule {
  is_image_url(url: string): boolean;
  _strip_html_to_text(body: Uint8Array): Uint8Array;
}

const _webfetchDefault: _WebfetchModule = webfetch;
let _webfetchOverride: _WebfetchModule | null | undefined;

/**
 * Test/late-layer seam: inject a webfetch implementation. Pass an object to
 * stub, `null` to force the fail-soft (no-module) path, or `undefined` to
 * restore the real default.
 */
export function _setWebfetchModule(mod: _WebfetchModule | null | undefined): void {
  _webfetchOverride = mod;
}

/**
 * Resolve the webfetch module: an explicit override (object or null) wins,
 * else the real module default. Returns null only when a test forced fail-soft.
 */
function _getWebfetch(): _WebfetchModule | null {
  if (_webfetchOverride !== undefined) {
    return _webfetchOverride;
  }
  return _webfetchDefault;
}

// --- compact.get_context_pressure seam (NOT yet ported) --------------------
// Python: `from .compact import get_context_pressure`. compact.ts is ported but
// does NOT yet export get_context_pressure / ContextPressure. This seam injects
// a callable returning an object with a `.tier` field. When absent, the tier
// resolution falls through to the "cool" default (Python wraps the call in
// try/except and defaults to "cool").
interface _ContextPressure {
  tier: string;
}
type _GetContextPressure = (session_id: string) => _ContextPressure;

let _getContextPressureFn: _GetContextPressure | null = null;

/** Test/late-layer seam: inject compact.get_context_pressure (or null to clear). */
export function _setGetContextPressure(fn: _GetContextPressure | null): void {
  _getContextPressureFn = fn;
}

registerReset(() => {
  // Restore the real-module defaults for gdrive and webfetch; compact's
  // pressure surface stays unported (null).
  _gdriveOverride = undefined;
  _webfetchOverride = undefined;
  _getContextPressureFn = null;
});

// ===========================================================================
// URL sanitisation
// ===========================================================================

// Maximum URL length accepted for embedding in hook messages. URLs longer than
// this are almost certainly not legitimate image URLs.
const _MAX_URL_EMBED_LEN = 2048;

/**
 * Return a sanitized copy of *url* safe for embedding in hint text, or null to
 * reject. Length cap, control-character stripping, and shell-safety escaping.
 */
function _sanitize_url_for_embed(url: string): string | null {
  if (url.length > _MAX_URL_EMBED_LEN) {
    return null;
  }
  // Strip ASCII control characters (ord < 32 covers \x00-\x1f; \x7f is DEL).
  let cleaned = "";
  for (const ch of url) {
    const code = ch.codePointAt(0)!;
    if (code >= 32 && ch !== "\x7f") {
      cleaned += ch;
    }
  }
  if (!cleaned) {
    return null;
  }
  // Escape characters special inside a double-quoted shell string.
  for (const ch of ["\\", "$", "`", '"']) {
    cleaned = cleaned.split(ch).join("\\" + ch);
  }
  return `"${cleaned}"`;
}

// ===========================================================================
// Drive / WebFetch image interception
// ===========================================================================

/**
 * Build denial response for Drive download with redirect to token-goat shim.
 */
function _intercept_drive_download(
  file_id: string,
  opts: { hint_filename?: string | null } = {},
): HookResponse {
  const hint_filename = opts.hint_filename ?? null;
  let sections_hint = "";
  if (hint_filename) {
    const gdrive = _getGdrive();
    if (gdrive !== null && gdrive.is_text_path(hint_filename)) {
      sections_hint =
        `For markdown/text docs prefer: \`token-goat gdrive-sections ${file_id}\` first — ` +
        `it returns the heading index (tens of tokens) so you can fetch just one section ` +
        `via \`token-goat section <local-path>::<heading>\` instead of the whole doc. `;
    }
  }
  return deny_redirect(
    "token-goat redirects Drive image downloads to its shrink+cache shim",
    `token-goat intercepted a Drive download to save tokens. ` +
      `${sections_hint}` +
      `Run this Bash instead: \`token-goat gdrive-fetch ${file_id}\` — ` +
      `it returns a local cached path you can then Read (images are auto-shrunk).`,
  );
}

/**
 * Build denial response for WebFetch image with redirect to token-goat shim.
 */
function _intercept_webfetch_image(url: string): HookResponse {
  const safe_url = _sanitize_url_for_embed(url);
  if (safe_url === null) {
    return CONTINUE();
  }
  return deny_redirect(
    "token-goat redirects image URLs to its shrink+cache shim",
    `token-goat intercepted a WebFetch to an image URL to save tokens. ` +
      `Run this Bash instead: \`token-goat fetch-image ${safe_url}\` — ` +
      `it downloads, shrinks, caches, and returns a local path you can then Read.`,
  );
}

// ===========================================================================
// WebFetch text dedup / cache-hit hints
// ===========================================================================

/**
 * Return a dedup hint when *url* was just fetched in this session.
 */
function _handle_web_dedup(payload: HookPayload, url: string): HookResponse | null {
  return run_dedup_hint(payload, {
    builder: (sid, cache) =>
      hints.build_web_dedup_hint({ session_id: sid, url, cache: cache as SessionCache | null }),
    stat_kind: "web_dedup_hint",
    detail: sanitize_log_str(url, 200),
    log_label: "pre-fetch",
  });
}

/**
 * Return a cache-hit hint when *url* has a cached body from a prior session.
 */
function _handle_web_cache_hit(payload: HookPayload, url: string): HookResponse | null {
  return run_dedup_hint(payload, {
    builder: (sid, cache) =>
      hints.build_web_cache_hit_hint({ session_id: sid, url, cache: cache as SessionCache | null }),
    stat_kind: "web_cache_hit_hint",
    detail: sanitize_log_str(url, 200),
    log_label: "pre-fetch",
  });
}

/**
 * At warm+ pressure, deny a repeat WebFetch when a valid cached body exists.
 */
function _handle_web_dedup_deny(session_id: string, url: string): HookResponse | null {
  try {
    const url_sha = web_cache.url_hash(url);
    const entry = session.lookup_web_entry(session_id, url_sha);
    if (entry === null) {
      return null;
    }

    const age = Date.now() / 1000 - entry.ts;
    if (age > hints.STALE_READ_AGE_SECONDS) {
      return null;
    }

    const cfg = config.load();
    const minBytes = cfg.hints?.web_dedup_min_bytes ?? 200;
    if (entry.body_bytes < minBytes) {
      return null;
    }

    if (!entry.output_id) {
      return null; // no valid recovery path; deny must not fire without a usable web-output id
    }
    const short_id = cache_common.short_output_id(entry.output_id);
    _LOG.info(
      "pre-fetch: denying re-fetch at pressure (age=%ds bytes=%d id=%s url=%.80s)",
      Math.trunc(age),
      entry.body_bytes,
      short_id,
      url,
    );
    return deny_redirect(
      "token-goat: re-fetch blocked at high context pressure — cached body available",
      `URL fetched ${Math.trunc(age)}s ago (${_thousands(entry.body_bytes)} B). ` +
        `Use \`token-goat web-output ${short_id}\` to read the cached body. ` +
        "Add --grep PATTERN or --section HEADING for surgical access. " +
        "Include 'refresh', 'latest', 'reload', 'updated', or 'retry' in the WebFetch prompt to bypass this block.",
    );
  } catch {
    // fail-soft; never block the tool
    _LOG.debug("pre-fetch: web dedup deny check failed");
    return null;
  }
}

// ===========================================================================
// URL allow / deny lists
// ===========================================================================

/**
 * Check *url* against the configured deny/allow glob lists. Returns a deny
 * HookResponse when blocked, or null when permitted.
 */
export function _check_url_allowdeny(url: string): HookResponse | null {
  const cfg = config.load().webfetch ?? {};
  const deny = cfg.deny ?? [];
  const allow = cfg.allow ?? [];
  const url_str = url;

  for (const pat of deny) {
    if (_fnmatch(url_str, pat)) {
      _LOG.info(
        "pre-fetch: URL blocked by deny pattern %s: %s",
        _pyRepr(pat),
        sanitize_log_str(url_str, 200),
      );
      return deny_redirect(
        `token-goat webfetch deny list blocked this URL (pattern: ${_pyRepr(pat)})`,
        "The URL matches a deny pattern in your token-goat config [webfetch] deny list. " +
          "If this was unintentional, update config.toml to remove the pattern.",
      );
    }
  }

  if (allow.length > 0) {
    for (const pat of allow) {
      if (_fnmatch(url_str, pat)) {
        return null; // explicitly allowed
      }
    }
    _LOG.info("pre-fetch: URL not in allow list, blocking: %s", sanitize_log_str(url_str, 200));
    return deny_redirect(
      "token-goat webfetch allow list: URL did not match any allowed pattern",
      "The URL did not match any pattern in your token-goat config [webfetch] allow list. " +
        "Add a matching pattern to allow it.",
    );
  }

  return null; // no restrictions
}

// ===========================================================================
// MCP read-only dedup
// ===========================================================================

// Inline threshold for MCP results embedded directly in deny hints.
const _MCP_INLINE_THRESHOLD = 2048;

/**
 * Return a deny response when a cached result exists for this MCP call, else null.
 */
function _handle_mcp_dedup(
  session_id: string,
  tool_name: string,
  tool_input: Record<string, unknown>,
): HookResponse | null {
  const cache = session.safe_load(session_id, { caller: "mcp_dedup" });
  if (cache === null) {
    return null;
  }

  const h = mcp_cache.mcp_hash(tool_name, tool_input);
  const output_id = cache.lookup_mcp_output_id(h);
  if (output_id === null) {
    return null;
  }

  const result_text = mcp_cache.load_mcp_result(output_id);
  if (result_text === null) {
    return null;
  }

  const result_bytes = _utf8Len(result_text);
  let inline: string | null;
  let note: string | null;
  if (result_bytes <= _MCP_INLINE_THRESHOLD) {
    inline = result_text;
    note = `Cached result (${result_bytes} bytes)`;
  } else {
    const compacted = mcp_cache.compact_mcp_result(result_text, {
      inline_threshold: _MCP_INLINE_THRESHOLD,
    });
    if (compacted !== null) {
      inline = compacted;
      note = `Compacted result (${_utf8Len(compacted)} bytes, was ${result_bytes})`;
    } else {
      inline = null;
      note = null;
    }
  }

  let reason: string;
  if (inline !== null) {
    reason =
      `[MCP cache hit — this exact call already ran this session. ` + `${note}:\n${inline}]`;
  } else {
    reason =
      `[MCP cache hit — this exact call already ran this session (${result_bytes} bytes cached).\n` +
      `Retrieve with: token-goat mcp-output ${output_id}]`;
  }
  return deny_redirect(reason, "mcp_dedup");
}

/**
 * Return a soft (non-blocking) hint when a cached MCP result exists, else null.
 */
function _handle_mcp_hint(
  session_id: string,
  tool_name: string,
  tool_input: Record<string, unknown>,
): HookResponse | null {
  const cache = session.safe_load(session_id, { caller: "mcp_hint" });
  if (cache === null) {
    return null;
  }

  const h = mcp_cache.mcp_hash(tool_name, tool_input);
  const output_id = cache.lookup_mcp_output_id(h);
  if (output_id === null) {
    return null;
  }

  const result_text = mcp_cache.load_mcp_result(output_id);
  if (result_text === null) {
    return null;
  }

  const result_bytes = _utf8Len(result_text);
  let inline: string | null;
  let note: string | null;
  if (result_bytes <= _MCP_INLINE_THRESHOLD) {
    inline = result_text;
    note = `Cached result (${result_bytes} bytes)`;
  } else {
    const compacted = mcp_cache.compact_mcp_result(result_text, {
      inline_threshold: _MCP_INLINE_THRESHOLD,
    });
    if (compacted !== null) {
      inline = compacted;
      note = `Compacted result (${_utf8Len(compacted)} bytes, was ${result_bytes})`;
    } else {
      inline = null;
      note = null;
    }
  }

  let context: string;
  if (inline !== null) {
    context = `[MCP hint — this exact call ran earlier this session. ` + `${note}:\n${inline}]`;
  } else {
    context =
      `[MCP hint — this exact call ran earlier this session (${result_bytes} bytes cached). ` +
      `Consider: token-goat mcp-output ${output_id}]`;
  }
  return pre_tool_use_with_context(context);
}

/** Clear all cached MCP read hashes after a mutation tool call. Best-effort. */
function _invalidate_mcp_cache(session_id: string, tool_name: string): void {
  try {
    const cache = session.safe_load(session_id, { caller: "mcp_cache_invalidate" });
    if (cache === null) {
      return;
    }
    const cleared = cache.clear_mcp_result_hashes();
    if (cleared) {
      session.save(cache);
      _LOG.debug(
        "post-fetch: invalidated %d MCP cache entries after mutation %s",
        cleared,
        tool_name,
      );
      try {
        db.recordStat(session_id, "mcp_cache_invalidated", { detail: tool_name });
      } catch {
        // best-effort
      }
    }
  } catch {
    // best-effort — never throw
  }
}

/**
 * Persist a read-only MCP tool result to the MCP output cache.
 */
function _capture_mcp_result(payload: HookPayload, tool_name: string): void {
  if (!mcp_cache.is_mcp_read_only(tool_name)) {
    return;
  }

  const [session_id] = get_hook_context(payload);
  if (session_id === null) {
    return;
  }

  const tool_input = get_tool_input(payload);
  const result_text = extract_tool_response_text(payload, {
    text_keys: ["output", "text", "content", "result", "body"],
  });
  if (!result_text) {
    return;
  }
  if (_utf8Len(result_text) > mcp_cache.MCP_MAX_CACHE_BYTES) {
    return;
  }

  const h = mcp_cache.mcp_hash(tool_name, tool_input);
  const cache = session.safe_load(session_id, { caller: "mcp_capture" });
  if (cache === null) {
    return;
  }
  if (cache.lookup_mcp_output_id(h) !== null) {
    return; // already cached — skip re-write
  }

  const input_preview =
    tool_input && Object.keys(tool_input).length > 0
      ? _jsonDumpsSorted(tool_input).slice(0, 200)
      : "";
  const output_id = mcp_cache.store_mcp_result(session_id, h, result_text, null, {
    tool_name,
    input_preview,
  });
  if (output_id === null) {
    return;
  }

  cache.record_mcp_result(h, output_id);
  try {
    session.save(cache);
  } catch {
    // suppressed
  }
  _LOG.debug("post-fetch: cached MCP result id=%s tool=%s", output_id, tool_name);
}

// ===========================================================================
// pre_fetch
// ===========================================================================

/** Deny Drive/WebFetch image tools and dedup repeat text WebFetch calls. */
export function pre_fetch(payload: HookPayload): HookResponse {
  const tool_name = (payload.tool_name as string | undefined) ?? "";

  const drive_tools = [
    "mcp__claude_ai_Google_Drive__download_file_content",
    "mcp__claude_ai_Google_Drive__read_file_content",
  ];
  if (drive_tools.includes(tool_name)) {
    const tool_input = get_tool_input(payload);
    const file_id =
      (tool_input["file_id"] as unknown) ||
      (tool_input["fileId"] as unknown) ||
      (tool_input["id"] as unknown);
    if (!file_id || typeof file_id !== "string") {
      return CONTINUE();
    }

    const gdrive = _getGdrive();
    if (gdrive === null) {
      // gdrive not available — cannot validate or check creds; fall through.
      return CONTINUE();
    }

    // Validate file_id before embedding in hook message to prevent injection.
    // A malicious id raises; pre_fetch's caller fail_soft turns it into CONTINUE.
    // Faithful to Python: _validate_file_id raises ValueError on bad ids, which
    // propagates (the dispatcher's fail_soft swallows it -> CONTINUE).
    try {
      gdrive._validate_file_id(file_id);
    } catch {
      // Invalid file_id: do not embed, fall through to CONTINUE so the Drive
      // MCP errors normally (matches the test expectations for malicious ids
      // under the dispatcher's fail_soft, and the direct-call tests which
      // expect CONTINUE for invalid ids).
      return CONTINUE();
    }
    gdrive.get_credentials();

    let hint_filename: unknown =
      tool_input["name"] || tool_input["filename"] || tool_input["file_name"];
    if (hint_filename && typeof hint_filename !== "string") {
      hint_filename = null;
    }
    if (typeof hint_filename === "string" && hint_filename.length > 256) {
      hint_filename = null;
    }
    return _intercept_drive_download(file_id, {
      hint_filename: typeof hint_filename === "string" ? hint_filename : null,
    });
  }

  if (tool_name === "WebFetch") {
    const tool_input = get_tool_input(payload);
    const url = tool_input["url"];
    if (!url || typeof url !== "string") {
      return CONTINUE();
    }

    // Check allow/deny lists before anything else.
    const allowdeny = _check_url_allowdeny(url);
    if (allowdeny !== null) {
      return allowdeny;
    }

    const webfetch = _getWebfetch();
    if (webfetch !== null && webfetch.is_image_url(url)) {
      return _intercept_webfetch_image(url);
    }

    // Resolve context-pressure tier for pressure-gated deny logic.
    let _wf_tier = "cool";
    const [_wf_session_id] = get_session_context(payload);
    if (_wf_session_id) {
      try {
        const fn = _getContextPressureFn;
        if (fn !== null) {
          _wf_tier = fn(_wf_session_id).tier;
        }
      } catch {
        // fall through, keep "cool"
      }
    }

    // Escape hatch: refresh keywords in the prompt bypass the deny.
    const _wf_prompt = tool_input["prompt"] ?? "";
    const _refresh_requested =
      typeof _wf_prompt === "string" &&
      ["refresh", "latest", "reload", "updated", "retry"].some((kw) =>
        _wf_prompt.toLowerCase().includes(kw),
      );

    // At warm+ pressure with a valid cached body: deny instead of hint.
    if (
      (_wf_tier === "warm" || _wf_tier === "hot" || _wf_tier === "critical") &&
      !_refresh_requested &&
      _wf_session_id
    ) {
      const deny = _handle_web_dedup_deny(_wf_session_id, url);
      if (deny !== null) {
        return deny;
      }
    }

    // Non-image WebFetch: try in-session dedup first.
    const dedup = _handle_web_dedup(payload, url);
    if (dedup !== null) {
      return dedup;
    }

    // Cross-session cache hit.
    const cache_hit = _handle_web_cache_hit(payload, url);
    if (cache_hit !== null) {
      return cache_hit;
    }

    return CONTINUE();
  }

  // Read-only MCP tools: deny at warm+ pressure; soft hint at cool pressure.
  if (tool_name.startsWith("mcp__")) {
    if (mcp_cache.is_mcp_read_only(tool_name)) {
      const [_mcp_sid] = get_hook_context(payload);
      if (_mcp_sid) {
        let _mcp_tier = "cool";
        try {
          const fn = _getContextPressureFn;
          if (fn !== null) {
            _mcp_tier = fn(_mcp_sid).tier;
          }
        } catch {
          // keep "cool"
        }
        const _mcp_input = get_tool_input(payload);
        if (_mcp_tier === "warm" || _mcp_tier === "hot" || _mcp_tier === "critical") {
          const mcp_deny = _handle_mcp_dedup(_mcp_sid, tool_name, _mcp_input);
          if (mcp_deny !== null) {
            return mcp_deny;
          }
        } else {
          const mcp_hint = _handle_mcp_hint(_mcp_sid, tool_name, _mcp_input);
          if (mcp_hint !== null) {
            return mcp_hint;
          }
        }
      }
    }
  }

  return CONTINUE();
}

// ===========================================================================
// post_fetch — capture WebFetch text responses to the on-disk cache
// ===========================================================================

// Smallest WebFetch body worth caching.
const _WEB_CACHE_MIN_BYTES = 1024;

// Size threshold (KB) for emitting the web-output size hint.
const _WEB_SIZE_HINT_THRESHOLD_KB = 10;

/**
 * Emit a hint (logged only) when a cached web response exceeds the size
 * threshold. Mirrors the Python log line exactly: the formatted message is the
 * single string `util.get_logger("hooks_fetch")` records (the test inspects the
 * fully-formatted message), so we pre-format with a template literal.
 */
function _maybe_emit_web_size_hint(meta: web_cache.WebOutputMeta): void {
  const log = getLogger("hooks_fetch");
  const meta_body_bytes = meta.body_bytes ?? 0;
  const meta_output_id = meta.output_id ?? "unknown";
  const size_kb = meta_body_bytes / 1024.0;
  if (size_kb < _WEB_SIZE_HINT_THRESHOLD_KB) {
    return;
  }

  // Rough token estimate: ~1 token per 4 bytes; ~70% savings from --grep.
  const token_est = Math.trunc(meta_body_bytes / 4);
  const savings_est = Math.trunc(token_est * 0.7);
  log.debug(
    `web_size_hint: id=${meta_output_id} size=${size_kb.toFixed(1)} KB ` +
      `(≈${token_est} tokens, ≈${savings_est} tokens saved with --grep)`,
  );
}

/**
 * Pull (body, status_code, content_type) from a PostToolUse WebFetch payload.
 */
function _extract_web_response(
  payload: HookPayload,
): [string, number | null, string | null] {
  const body = extract_tool_response_text(payload, {
    text_keys: ["output", "text", "body", "content", "response"],
  });

  let raw_resp: unknown = _isDict(payload) ? payload.tool_response : null;
  if ((raw_resp === undefined || raw_resp === null) && _isDict(payload)) {
    raw_resp = payload.tool_result ?? payload.response ?? null;
  }

  let status_val: unknown = null;
  let content_type_val: unknown = null;
  if (_isDict(raw_resp)) {
    if ("status_code" in raw_resp) {
      status_val = raw_resp["status_code"];
    } else if ("status" in raw_resp) {
      status_val = raw_resp["status"];
    } else {
      status_val = raw_resp["code"];
    }
    const headers = raw_resp["headers"];
    if (_isDict(headers)) {
      content_type_val = headers["content-type"] ?? headers["Content-Type"];
    }
    if (!content_type_val) {
      content_type_val = raw_resp["content_type"] ?? raw_resp["content-type"];
    }
  }

  let status_code: number | null = null;
  if (is_real_int(status_val)) {
    status_code = status_val;
  } else if (typeof status_val === "string") {
    const parsed = _pyInt(status_val);
    status_code = parsed;
  }

  let content_type: string | null = null;
  if (typeof content_type_val === "string") {
    content_type = content_type_val.split(";")[0]!.trim().toLowerCase();
  }

  return [body, status_code, content_type];
}

/**
 * Post-WebFetch hook: persist large text responses to disk + session history.
 * Always returns CONTINUE.
 */
export function post_fetch(payload: HookPayload): HookResponse {
  const tool_name = (payload.tool_name as string | undefined) ?? "";

  // Capture read-only MCP results; invalidate the cache for mutation tools.
  if (tool_name.startsWith("mcp__")) {
    if (mcp_cache.is_mcp_read_only(tool_name)) {
      _capture_mcp_result(payload, tool_name);
    } else {
      const [_mcp_inv_sid] = get_hook_context(payload);
      if (_mcp_inv_sid) {
        _invalidate_mcp_cache(_mcp_inv_sid, tool_name);
      }
    }
    return CONTINUE();
  }

  if (tool_name !== "WebFetch") {
    return CONTINUE();
  }

  const [session_id] = get_hook_context(payload);
  if (session_id === null) {
    return CONTINUE();
  }

  const tool_input = get_tool_input(payload);
  const url = tool_input["url"];
  if (typeof url !== "string" || !url) {
    return CONTINUE();
  }

  const webfetch = _getWebfetch();
  if (webfetch !== null && webfetch.is_image_url(url)) {
    // Image responses go through the existing image cache pipeline.
    return CONTINUE();
  }

  let [body] = _extract_web_response(payload);
  const [, status_code, content_type] = _extract_web_response(payload);

  // Strip script/style/nav/header/footer blocks from HTML responses.
  try {
    if (webfetch !== null) {
      const _body_bytes = _utf8Encode(body);
      const _stripped = webfetch._strip_html_to_text(_body_bytes);
      if (_stripped !== _body_bytes && !_bytesEqual(_stripped, _body_bytes)) {
        body = _utf8Decode(_stripped);
        _LOG.debug(
          "post-fetch: HTML stripped %d→%d bytes for %s",
          _body_bytes.length,
          _stripped.length,
          sanitize_log_str(url, 100),
        );
      }
    }
  } catch {
    // fail-soft: stripping must never break caching
  }

  const body_size = _utf8Len(body);

  // Accumulate observed token count regardless of cache threshold.
  const _fetch_cache = session.safe_load(session_id, { caller: "post_fetch" });
  if (_fetch_cache !== null) {
    _fetch_cache.observed_tool_tokens += Math.trunc(body_size / 4);
  }

  if (body_size < _WEB_CACHE_MIN_BYTES) {
    if (_fetch_cache !== null) {
      try {
        session.save(_fetch_cache);
      } catch {
        // suppressed
      }
    }
    _LOG.debug(
      "post-fetch: body too small to cache (%d bytes < %d threshold)",
      body_size,
      _WEB_CACHE_MIN_BYTES,
    );
    return CONTINUE();
  }

  const cfg = config.load();
  const meta = web_cache.store_output(session_id, url, body, status_code, {
    content_type,
    max_total_bytes: cfg.webfetch?.max_bytes,
    max_file_count: cfg.webfetch?.max_file_count,
    compress_bodies: cfg.webfetch?.compress_bodies,
    compress_min_bytes: cfg.webfetch?.compress_min_bytes,
  });
  if (meta === null) {
    return CONTINUE();
  }
  web_cache.write_sidecar(meta);

  try {
    session.mark_web_fetch(
      session_id,
      meta.url_sha,
      url,
      meta.output_id,
      meta.body_bytes,
      meta.status_code,
      meta.truncated,
      { content_type: meta.content_type, cache: _fetch_cache },
    );
  } catch (exc) {
    _LOG.debug("post-fetch: session record failed: %s", String(exc));
  }

  // Emit a size hint if the response is large enough to benefit from --grep.
  _maybe_emit_web_size_hint(meta);

  // Record bytes cached so the stats view reflects actual content stored.
  record_cached_stat("web_output_cached", sanitize_log_str(url, 200), body_size);

  _LOG.info(
    "post-fetch: cached body id=%s bytes=%d status=%s truncated=%s",
    meta.output_id,
    body_size,
    status_code,
    meta.truncated,
  );
  return CONTINUE();
}

// ===========================================================================
// Internal helpers (no Python analogue — narrowing shims for strict TS)
// ===========================================================================

function _isDict(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function _utf8Len(s: string): number {
  return Buffer.byteLength(s, "utf-8");
}

function _utf8Encode(s: string): Uint8Array {
  return new Uint8Array(Buffer.from(s, "utf-8"));
}

function _utf8Decode(b: Uint8Array): string {
  return Buffer.from(b).toString("utf-8");
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

/** Format an integer with thousands separators (Python's `{:,}`). */
function _thousands(n: number): string {
  return Math.trunc(n).toLocaleString("en-US");
}

/** Python int(str) — truncating decimal parse; returns null on failure. */
function _pyInt(s: string): number | null {
  const trimmed = s.trim();
  if (!/^[+-]?\d+$/.test(trimmed)) {
    return null;
  }
  const n = Number(trimmed);
  return Number.isFinite(n) ? n : null;
}

/** Python repr() of a string for log/message embedding (single-quoted). */
function _pyRepr(s: string): string {
  // Mirror Python's str repr for the common case: single quotes, escape
  // backslashes and single quotes. Sufficient for glob patterns in messages.
  const escaped = s.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
  return `'${escaped}'`;
}

/**
 * Minimal fnmatch (shell glob) match against a full string, mirroring Python's
 * fnmatch.fnmatch (which is case-normalizing on case-insensitive platforms but
 * case-sensitive on POSIX; we match POSIX semantics — case-sensitive). Supports
 * *, ?, and [seq] character classes anchored to the whole string.
 */
function _fnmatch(name: string, pattern: string): boolean {
  return _translateGlob(pattern).test(name);
}

function _translateGlob(pat: string): RegExp {
  // Faithful to CPython fnmatch.translate semantics for *, ?, [ ].
  let i = 0;
  const n = pat.length;
  let res = "";
  while (i < n) {
    const c = pat[i]!;
    i += 1;
    if (c === "*") {
      res += "[\\s\\S]*";
    } else if (c === "?") {
      res += "[\\s\\S]";
    } else if (c === "[") {
      let j = i;
      if (j < n && pat[j] === "!") {
        j += 1;
      }
      if (j < n && pat[j] === "]") {
        j += 1;
      }
      while (j < n && pat[j] !== "]") {
        j += 1;
      }
      if (j >= n) {
        res += "\\[";
      } else {
        let stuff = pat.slice(i, j);
        stuff = stuff.replace(/\\/g, "\\\\");
        i = j + 1;
        if (stuff.startsWith("!")) {
          stuff = "^" + stuff.slice(1);
        } else if (stuff.startsWith("^")) {
          stuff = "\\" + stuff;
        }
        res += "[" + stuff + "]";
      }
    } else {
      res += _escapeRegex(c);
    }
  }
  return new RegExp("^(?:" + res + ")$", "s");
}

function _escapeRegex(c: string): string {
  return c.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** json.dumps(obj, sort_keys=True, ensure_ascii=False) for a flat-ish dict. */
function _jsonDumpsSorted(obj: Record<string, unknown>): string {
  return JSON.stringify(obj, _sortedReplacer(obj));
}

function _sortedReplacer(_root: unknown): (key: string, value: unknown) => unknown {
  return (_key: string, value: unknown): unknown => {
    if (value !== null && typeof value === "object" && !Array.isArray(value)) {
      const sorted: Record<string, unknown> = {};
      for (const k of Object.keys(value as Record<string, unknown>).sort()) {
        sorted[k] = (value as Record<string, unknown>)[k];
      }
      return sorted;
    }
    return value;
  };
}

export const __all__ = ["post_fetch", "pre_fetch"] as const;
