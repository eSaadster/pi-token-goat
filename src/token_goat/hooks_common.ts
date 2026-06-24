/**
 * Shared constants and micro-helpers used by all hook modules.
 *
 * Faithful port of src/token_goat/hooks_common.py (FULL module — supersedes the
 * Layer 2 partial that shipped only sanitize_log_str / sanitize_opt / is_real_int
 * / _BIDI_CONTROLS). Those three guards and the bidi-control constant are carried
 * over UNCHANGED (same logic, same global-RegExp replace-all, same U+2026 suffix,
 * same is_real_int predicate); the remainder of the Python surface is added below.
 *
 * Centralises the most-repeated patterns across the hook layer:
 *  - CONTINUE() — the canonical {"continue": true} response factory.
 *  - get_tool_input(payload) — payload.tool_input or {}, None-safe.
 *  - deny_redirect / pre_tool_use_with_context / pre_tool_use_with_update —
 *    the three hookSpecificOutput builders.
 *  - the adaptive hook-watchdog module-global state.
 *
 * Parity notes (Python → TS):
 *  - The TypedDicts (HookPayload / HookResponse / HookSpecificOutput{Deny,Context,
 *    Update}) live in ./types.ts and are imported here as type-only; this module
 *    re-exports them so callers that did `from .hooks_common import HookPayload`
 *    port one-for-one.
 *  - Module-global watchdog state (_effective_watchdog_ms, _consecutive_timeouts,
 *    _timeout_configured) ports as module-level `let`s + a registerReset so the
 *    per-test cache wipe (tests/setup.ts) returns them to their freshly-imported
 *    baseline, mirroring "each fresh Python process starts fresh".
 *  - Sibling modules that a test spies on (db, session, config) are reached via
 *    a STATIC `import * as x from "./x.js"` so vi.spyOn(x, "fn") is observed
 *    (per the porting convention; createRequire would load a separate instance).
 *  - bytes_to_tokens: Python does `from .hints import CHARS_PER_TOKEN` lazily.
 *    hints.ts is NOT yet ported, so the verbatim Python value (3.5) is inlined as
 *    a module-local CHARS_PER_TOKEN here, with int(...) → Math.trunc(...) (Python
 *    int() truncates toward zero). When hints.ts lands, swap this for an import.
 *    Reported in known_gaps.
 *  - _is_quiet_hours: re.fullmatch → an anchored RegExp; datetime.datetime.now()
 *    → new Date() (local time), .getHours()/.getMinutes(). The test monkeypatches
 *    the clock; the TS test mocks Date the same way.
 *  - validate_cwd: pathlib.Path.is_absolute()/is_dir() → node:path.isAbsolute +
 *    fs.statSync(...).isDirectory(); OSError/ValueError → catch any thrown error.
 *  - byte math is UTF-8 via utf8Bytes (Buffer), never String.length.
 *
 * `verbatimModuleSyntax` is on → all type-only imports use `import type`.
 * `exactOptionalPropertyTypes` is on → optional fields are `T | undefined`.
 * `noUncheckedIndexedAccess` is on → every indexed access is narrowed.
 */

import * as fs from "node:fs";
import * as nodePath from "node:path";

import { getLogger, utf8Bytes } from "./util.js";
import { registerReset } from "./reset.js";
import * as config from "./config.js";
import * as db from "./db.js";
import * as session from "./session.js";

import type {
  HookPayload,
  HookResponse,
  HookSpecificOutputContext,
  HookSpecificOutputDeny,
  HookSpecificOutputUpdate,
} from "./types.js";
import type { SessionCache } from "./session.js";

// Re-export the typed shapes so callers that imported them from hooks_common in
// Python (`from .hooks_common import HookPayload`) port one-for-one.
export type {
  HookPayload,
  HookResponse,
  HookSpecificOutputContext,
  HookSpecificOutputDeny,
  HookSpecificOutputUpdate,
} from "./types.js";

/**
 * Public symbol surface, mirroring Python's hooks_common.__all__. Kept as a
 * runtime array so a test that asserts membership ports one-for-one. The names
 * use the Python snake_case form (the canonical contract); each has a matching
 * snake_case export below.
 */
export const __all__ = [
  "CONTINUE",
  "HookPayload",
  "HookResponse",
  "HookSpecificOutputContext",
  "HookSpecificOutputDeny",
  "HookSpecificOutputUpdate",
  "LOG",
  "bytes_to_tokens",
  "deny_redirect",
  "emit_if_new_hint",
  "extract_tool_response_text",
  "get_effective_watchdog_ms",
  "get_hook_context",
  "get_session_context",
  "get_tool_input",
  "is_real_int",
  "load_session_safe",
  "pre_tool_use_with_context",
  "pre_tool_use_with_update",
  "record_cached_stat",
  "record_hint_stat_pair",
  "record_watchdog_timeout",
  "run_dedup_hint",
  "update_session",
  "_is_quiet_hours",
  "sanitize_log_str",
  "sanitize_opt",
  "validate_cwd",
] as const;

// All hook modules share one logger so their output appears together in the log.
// Python: LOG = get_logger("hooks").
export const LOG = getLogger("hooks");

// ---------------------------------------------------------------------------
// Adaptive hook watchdog timeout state
// ---------------------------------------------------------------------------

// Module-level state for adaptive timeout: when a hook subprocess times out,
// the effective timeout is doubled (capped at 30 s) for subsequent calls in
// the same session. This adapts to slow CI machines or cold-cache environments.
const _DEFAULT_WATCHDOG_MS = 5000;

// Will be overridden by config on first call to get_effective_watchdog_ms().
let _effective_watchdog_ms: number = _DEFAULT_WATCHDOG_MS;
let _consecutive_timeouts = 0;
let _timeout_configured = false;

// Reset the adaptive watchdog module-globals to their freshly-imported baseline.
// In Python each fresh process starts fresh; tests/setup.ts calls
// clearModuleCaches() (which runs this) before every test for the same effect.
registerReset(() => {
  _effective_watchdog_ms = _DEFAULT_WATCHDOG_MS;
  _consecutive_timeouts = 0;
  _timeout_configured = false;
});

/**
 * Return the current effective hook watchdog timeout in milliseconds.
 *
 * On first invocation, loads the [hooks].watchdog_ms value from config (or the
 * default 5000 ms). The value is clamped to [100, 30000] by config itself.
 *
 * On subsequent invocations within the same process, returns the adapted value
 * (which may have been doubled due to timeouts).
 */
export function get_effective_watchdog_ms(): number {
  if (!_timeout_configured) {
    try {
      const cfg = config.load();
      _effective_watchdog_ms = cfg.hooks?.watchdog_ms ?? _DEFAULT_WATCHDOG_MS;
      _timeout_configured = true;
      LOG.debug("hook watchdog initialized: %d ms", _effective_watchdog_ms);
    } catch {
      // fail-soft: use hardcoded default if config load fails.
      _effective_watchdog_ms = _DEFAULT_WATCHDOG_MS;
      _timeout_configured = true;
      LOG.debug("hook watchdog config load failed, using default 5000 ms");
    }
  }

  return _effective_watchdog_ms;
}

/**
 * Record a hook subprocess timeout and adapt the effective timeout upward.
 *
 * Doubles the effective timeout (up to the 30 s cap) and logs the adjustment.
 * The adaptive state is in-process memory — each fresh process starts fresh with
 * the configured baseline.
 */
export function record_watchdog_timeout(): void {
  _consecutive_timeouts += 1;
  const old_ms = _effective_watchdog_ms;
  _effective_watchdog_ms = Math.min(_effective_watchdog_ms * 2, 30_000);

  LOG.warning(
    "hook subprocess timeout (attempt %d); doubling watchdog: %d ms → %d ms",
    _consecutive_timeouts,
    old_ms,
    _effective_watchdog_ms,
  );
}

/**
 * Reset the adaptive timeout state on successful hook completion.
 *
 * Resets the consecutive timeout counter to zero so the next timeout (if any)
 * starts the doubling sequence fresh.
 */
export function _reset_watchdog_state(): void {
  if (_consecutive_timeouts > 0) {
    LOG.debug("hook subprocess completed successfully; resetting timeout counter");
    _consecutive_timeouts = 0;
  }
}

/**
 * Return a fresh `{"continue": true}` dict.
 *
 * Named in UPPER_CASE to read like a constant at call sites (`return CONTINUE()`).
 * A factory (not a module-level object) ensures each caller gets its own object
 * and cannot accidentally mutate a shared singleton.
 */
export function CONTINUE(): HookResponse {
  return { continue: true };
}

/**
 * Return `[session_id, cwd]` from a hook payload, or `[null, null]` for missing
 * keys. Both fields are optional in the harness protocol (HookPayload uses
 * total=False), so either or both may be absent.
 */
export function get_session_context(
  payload: HookPayload,
): [string | null, string | null] {
  const sidRaw = payload.session_id;
  const cwdRaw = payload.cwd;
  const session_id = (sidRaw ?? null) as string | null;
  const cwd = (cwdRaw ?? null) as string | null;
  if (session_id === null) {
    LOG.debug(
      "get_session_context: session_id absent from payload (tool=%s)",
      sanitize_opt(payload.tool_name),
    );
  }
  if (cwd === null) {
    LOG.debug(
      "get_session_context: cwd absent from payload (tool=%s)",
      sanitize_opt(payload.tool_name),
    );
  }
  return [session_id, cwd];
}

/**
 * Return `[session_id, cwd]` or `[null, null]` when *session_id* is absent.
 *
 * Strict variant of get_session_context: returns `[null, null]` when session_id
 * is missing, because a session context without a session ID is unusable for any
 * cache/hint operation. cwd is returned as-is (may be null) when a session ID is
 * present.
 */
export function get_hook_context(
  payload: HookPayload,
): [string | null, string | null] {
  const [session_id, cwd] = get_session_context(payload);
  if (session_id === null) {
    return [null, null];
  }
  return [session_id, cwd];
}

/**
 * Return `payload.tool_input` as a dict, defaulting to `{}`.
 *
 * Handles three degenerate cases without extra guards at every call site:
 *  - payload is null/undefined
 *  - tool_input key is missing
 *  - tool_input value is null or another falsy non-dict
 */
export function get_tool_input(
  payload: HookPayload | null | undefined,
): Record<string, unknown> {
  if (payload === null || payload === undefined || typeof payload !== "object" || Array.isArray(payload)) {
    return {};
  }
  const value = (payload as HookPayload).tool_input;
  return _isPlainDict(value) ? (value as Record<string, unknown>) : {};
}

/**
 * Build the canonical interception response that denies a tool call with a
 * redirect hint.
 *
 * @param reason  Short sentence explaining why the tool call was denied.
 * @param context Longer message telling the agent what to do instead.
 */
export function deny_redirect(reason: string, context: string): HookResponse {
  const hso: HookSpecificOutputDeny = {
    hookEventName: "PreToolUse",
    permissionDecision: "deny",
    permissionDecisionReason: reason,
    additionalContext: context,
  };
  return { continue: true, hookSpecificOutput: hso };
}

/**
 * Build a PreToolUse response that injects an `additionalContext` hint, leaving
 * the tool call unchanged.
 *
 * @param additional_context The message to inject (Markdown OK).
 */
export function pre_tool_use_with_context(additional_context: string): HookResponse {
  const hso: HookSpecificOutputContext = {
    hookEventName: "PreToolUse",
    additionalContext: additional_context,
  };
  return { continue: true, hookSpecificOutput: hso };
}

// Unicode bidirectional control characters that can cause log viewers to
// display misleading text by overriding rendering direction. A malicious
// filename containing U+202E (RIGHT-TO-LEFT OVERRIDE) could make "evil.exe"
// appear as "exe.live" in a terminal or log viewer. Strip them all.
//
// Verbatim port of the Python `_BIDI_CONTROLS` tuple (same code points, same
// order). Spelled with \uXXXX escapes so the invisible characters are visible
// to a reviewer.
export const _BIDI_CONTROLS: readonly string[] = [
  "‎", // LEFT-TO-RIGHT MARK
  "‏", // RIGHT-TO-LEFT MARK
  "‪", // LEFT-TO-RIGHT EMBEDDING
  "‫", // RIGHT-TO-LEFT EMBEDDING
  "‬", // POP DIRECTIONAL FORMATTING
  "‭", // LEFT-TO-RIGHT OVERRIDE
  "‮", // RIGHT-TO-LEFT OVERRIDE
  "⁦", // LEFT-TO-RIGHT ISOLATE
  "⁧", // RIGHT-TO-LEFT ISOLATE
  "⁨", // FIRST STRONG ISOLATE
  "⁩", // POP DIRECTIONAL ISOLATE
] as const;

/**
 * Sanitize a user-controlled string before embedding it in a log message.
 *
 * Strips embedded newlines and carriage returns that could inject fake log
 * entries into the log file. Also removes Unicode bidirectional control
 * characters that can cause log viewers and terminals to display misleading text
 * by overriding rendering direction. Truncates to *maxLen* to prevent log
 * flooding.
 *
 * Faithful port of `sanitize_log_str`. Newlines/CRs are replaced GLOBALLY
 * (Python str.replace replaces all occurrences); truncation appends a single
 * U+2026 (…) and uses character length, not bytes.
 */
export function sanitize_log_str(value: string, maxLen = 200): string {
  let sanitized = value.replace(/\n/g, "\\n").replace(/\r/g, "\\r");
  for (const ch of _BIDI_CONTROLS) {
    sanitized = sanitized.replaceAll(ch, "");
  }
  if (sanitized.length > maxLen) {
    sanitized = sanitized.slice(0, maxLen) + "…";
  }
  return sanitized;
}

/**
 * Sanitize an optional log value: convert to str, strip injections, return ""
 * for falsy.
 *
 * Calling `sanitize_opt(x)` is equivalent to `sanitize_log_str(str(x)) if x else
 * ""`. Falsy non-null values (0, false) are treated the same as null/undefined
 * and return "".
 *
 * @param value Any value from a hook payload (session_id, cwd, tool_name, …).
 */
export function sanitize_opt(value: unknown): string {
  if (!value) {
    return "";
  }
  if (typeof value !== "string") {
    LOG.debug(
      "sanitize_opt: coercing non-string payload field %s(%s) to str",
      typeof value,
      sanitize_log_str(String(value)),
    );
  }
  return sanitize_log_str(String(value));
}

// hints.CHARS_PER_TOKEN — verbatim Python value (3.5). The Python original does
// a lazy `from .hints import CHARS_PER_TOKEN` inside bytes_to_tokens; hints.ts is
// not yet ported, so the constant is inlined here. When hints.ts lands, replace
// this with an import. Reported in known_gaps.
const CHARS_PER_TOKEN = 3.5;

/**
 * Convert a byte count to an approximate token count (minimum 1).
 *
 * Uses the same CHARS_PER_TOKEN constant (3.5) as the rest of the hint layer.
 * The max(1, ...) guard ensures zero-length injections still record at least one
 * token of overhead. Python's int() truncates toward zero → Math.trunc.
 */
export function bytes_to_tokens(byte_count: number): number {
  return Math.max(1, Math.trunc(byte_count / CHARS_PER_TOKEN));
}

/**
 * Return true when the current local time falls within the *quiet_hours* window.
 *
 * *quiet_hours* must be a non-empty string in "HH:MM-HH:MM" 24-hour format.
 * Midnight wrap-around is supported: "22:00-07:00" suppresses from 10 pm to 7 am
 * (crossing midnight). Returns false for empty / malformed strings so the feature
 * is a no-op when not configured.
 */
export function _is_quiet_hours(quiet_hours: string): boolean {
  if (!quiet_hours) {
    return false;
  }
  // Python: re.fullmatch(r"(\d{1,2}):(\d{2})-(\d{1,2}):(\d{2})", quiet_hours.strip()).
  const m = /^(\d{1,2}):(\d{2})-(\d{1,2}):(\d{2})$/.exec(quiet_hours.trim());
  if (m === null) {
    return false;
  }
  const start_h = Number(m[1]);
  const start_m = Number(m[2]);
  const end_h = Number(m[3]);
  const end_m = Number(m[4]);
  const hour_valid = start_h >= 0 && start_h < 24 && end_h >= 0 && end_h < 24;
  const minute_valid = start_m >= 0 && start_m < 60 && end_m >= 0 && end_m < 60;
  if (!(hour_valid && minute_valid)) {
    return false;
  }

  const now = new Date();
  const current_minutes = now.getHours() * 60 + now.getMinutes();
  const window_start = start_h * 60 + start_m;
  const window_end = end_h * 60 + end_m;

  if (window_start <= window_end) {
    // Normal range (same day): e.g. 09:00-17:00.
    return window_start <= current_minutes && current_minutes < window_end;
  }
  // Midnight-crossing range: e.g. 22:00-07:00.
  return current_minutes >= window_start || current_minutes < window_end;
}

/**
 * Record a matched-pair of stat rows for a hint: the gross saving plus the
 * injection overhead.
 *
 * Centralises the five-line block that previously appeared identically in the
 * dedup / diff / session-hint handlers.
 *
 * @param kind   Base stat kind for the saving row (e.g. "bash_dedup_hint"). The
 *               overhead row is recorded under kind + "_overhead" automatically.
 * @param hint   The hint object — must have a numeric tokens_saved attribute and
 *               a string form (its String() value is measured for byte cost).
 * @param detail Short string stored in the stat row for triage. Callers must
 *               sanitize before passing.
 */
export function record_hint_stat_pair(kind: string, hint: unknown, detail: string): void {
  const cfg = config.load();

  // Item 16: quiet-hours suppression. When the current local time falls inside
  // the configured quiet window, skip the stat-record.
  if (_is_quiet_hours(cfg.hints?.quiet_hours ?? "")) {
    return;
  }

  const realized_tokens: number = _getNumericAttr(hint, "tokens_saved", 0);
  const injection_text = String(hint);
  const injection_bytes: number = utf8Bytes(injection_text).length;
  const injection_cost_tokens = bytes_to_tokens(injection_bytes);

  const record_zero_savings = cfg.stats?.record_zero_savings ?? false;

  // Skip writing stat rows for zero-saving hints unless explicitly enabled.
  if (realized_tokens === 0 && injection_bytes === 0 && !record_zero_savings) {
    return;
  }

  // Item 15: Skip writing the overhead row when injection_bytes < 32 and
  // tokens_saved > 0. The saving row is still written.
  if (injection_bytes < 32 && realized_tokens > 0) {
    db.recordStat(undefined, kind, {
      bytesSaved: realized_tokens * 4,
      tokensSaved: realized_tokens,
      detail,
    });
    return;
  }

  // For zero savings, skip rows unless record_zero_savings config is enabled.
  if (realized_tokens === 0 && !record_zero_savings) {
    return;
  }

  db.recordStat(undefined, kind, {
    bytesSaved: realized_tokens * 4,
    tokensSaved: realized_tokens,
    detail,
  });
  db.recordStat(undefined, kind + "_overhead", {
    bytesSaved: -injection_bytes,
    tokensSaved: -injection_cost_tokens,
    detail,
  });
}

/**
 * Record a stat row for a cache-capture event (bash/web/skill).
 *
 * *bytes_saved* should be the byte length of the content that was stored. Tokens
 * are estimated at 4 bytes per token via max(1, bytes // 3 + 1). Defaults to 0.
 *
 * @param kind        Stat kind string (e.g. "bash_output_cached").
 * @param detail      Short sanitised label for triage.
 * @param bytes_saved Byte length of the cached content. Defaults to 0.
 */
export function record_cached_stat(kind: string, detail: string, bytes_saved = 0): void {
  const _bs = Math.max(0, bytes_saved);
  const tokens = _bs > 0 ? Math.max(1, Math.trunc(_bs / 3) + 1) : 0;
  try {
    db.recordStat(undefined, kind, {
      bytesSaved: Math.max(0, bytes_saved),
      tokensSaved: tokens,
      detail,
    });
  } catch {
    LOG.debug("record_cached_stat(%s): stat record failed", kind);
  }
}

/**
 * Build a PreToolUse response that rewrites the tool input and injects a context
 * hint.
 *
 * @param updated_input      The modified tool_input dict to hand back to the harness.
 * @param additional_context Message explaining the redirect (Markdown OK).
 */
export function pre_tool_use_with_update(
  updated_input: Record<string, unknown>,
  additional_context: string,
): HookResponse {
  const hso: HookSpecificOutputUpdate = {
    hookEventName: "PreToolUse",
    updatedInput: updated_input,
    additionalContext: additional_context,
  };
  return { continue: true, hookSpecificOutput: hso };
}

// Maximum byte length accepted for a `cwd` value from an untrusted hook payload.
// Matches PATH_MAX on Linux; well above any real working-directory path on
// Windows. Prevents large Path object allocations from adversarial input.
const _MAX_CWD_LEN = 4096;

/**
 * Validate a `cwd` value from an untrusted hook payload.
 *
 * Returns a path string when *cwd* is a non-empty string that is not too long, is
 * absolute, and names an existing directory. Returns null and logs a warning
 * otherwise.
 *
 * @param cwd    The raw cwd field from the hook payload (may be any type).
 * @param caller Short label used in warning log messages (e.g. "post-edit").
 */
export function validate_cwd(cwd: unknown, opts?: { caller?: string }): string | null {
  const caller = opts?.caller ?? "hook";
  if (!cwd || typeof cwd !== "string") {
    return null;
  }
  if (cwd.length > _MAX_CWD_LEN) {
    LOG.warning(
      "%s: cwd too long (%d chars > %d limit); ignoring",
      caller,
      cwd.length,
      _MAX_CWD_LEN,
    );
    return null;
  }
  if (!nodePath.isAbsolute(cwd)) {
    LOG.warning(
      "%s: cwd is not an absolute path (%s); ignoring",
      caller,
      sanitize_log_str(cwd),
    );
    return null;
  }
  try {
    if (!fs.statSync(cwd).isDirectory()) {
      LOG.warning(
        "%s: cwd %s is not an existing directory; ignoring",
        caller,
        sanitize_log_str(cwd),
      );
      return null;
    }
  } catch (exc) {
    LOG.warning(
      "%s: could not stat cwd %s: %s; ignoring",
      caller,
      sanitize_log_str(cwd),
      String(exc),
    );
    return null;
  }
  return cwd;
}

/**
 * Return *true* when *value* is a genuine integer, not a boolean.
 *
 * Python's bool subclasses int, so a plain isinstance(x, int) check accepts
 * True/False. This predicate names the intent. Returning a TS type predicate
 * (`value is number`) narrows the value to number in the true-branch (the
 * analogue of Python's TypeGuard[int]).
 *
 * Faithful port of is_real_int: accepts an integer Number; rejects booleans,
 * non-integral floats (and NaN/Infinity), strings, null, undefined, bigint, and
 * everything else.
 */
export function is_real_int(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value);
}

/**
 * Load the session cache, returning null on any error (fail-soft).
 *
 * Centralises the `try: session.load(session_id) except ...: return null`
 * pattern. Any error silently returns null so hooks never abort on cache issues.
 *
 * @param session_id The session ID string (from the hook payload).
 */
export function load_session_safe(session_id: string): SessionCache | null {
  try {
    return session.load(session_id);
  } catch {
    // OSError, ValueError, JSON corruption, and unexpected errors all return null.
    return null;
  }
}

/**
 * Load session cache, call a mutation function, and save — fail-soft pattern.
 *
 * Failures at any step are logged at debug level and swallowed (fail-soft) so the
 * hook never aborts on cache issues.
 *
 * @param session_id The session ID string.
 * @param fn         Callable that receives the loaded cache and mutates it in place.
 * @returns true if the cache was loaded, mutated, and saved successfully; false otherwise.
 */
export function update_session(
  session_id: string,
  fn: (cache: SessionCache) => void,
): boolean {
  const cache = load_session_safe(session_id);
  if (cache === null) {
    return false;
  }

  try {
    fn(cache);
  } catch {
    LOG.debug("update_session: mutation function failed");
    return false;
  }

  try {
    session.save(cache);
    return true;
  } catch {
    LOG.debug("update_session: save failed");
    return false;
  }
}

/**
 * Concatenate text from an MCP-style `content` array.
 *
 * Each item is either a {"type": "text", "text": "..."} dict or a bare string.
 * Non-text items are silently skipped.
 */
function _coerce_content_array(items: unknown[]): string {
  const parts: string[] = [];
  for (const item of items) {
    if (_isPlainDict(item)) {
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

/**
 * Extract the primary text body from a PostToolUse payload.
 *
 * Handles every shape the harness and MCP adapters produce:
 *  1. tool_response is a str — returned as-is.
 *  2. tool_response is a list — treated as an MCP content array.
 *  3. tool_response is a dict — probed at each key in *text_keys* in order; the
 *     first str value wins. A list value is treated as an MCP content array.
 *  4. Fallbacks: tool_result, response at the top level.
 *
 * Returns "" when nothing decodable is present.
 *
 * @param payload   The raw hook payload.
 * @param text_keys Dict-key probe order. Defaults to the bash/web/skill set.
 */
export function extract_tool_response_text(
  payload: HookPayload | null | undefined,
  opts?: { text_keys?: readonly string[] },
): string {
  const text_keys = opts?.text_keys ?? ["output", "text", "body", "content", "response"];

  const isDictPayload =
    payload !== null && payload !== undefined && typeof payload === "object" && !Array.isArray(payload);

  let raw_resp: unknown = isDictPayload ? (payload as HookPayload).tool_response : null;
  if ((raw_resp === undefined || raw_resp === null) && isDictPayload) {
    for (const key of ["tool_result", "response"] as const) {
      if (key in (payload as HookPayload)) {
        const candidate = (payload as HookPayload)[key];
        if (candidate !== null && candidate !== undefined) {
          raw_resp = candidate;
          break;
        }
      }
    }
  }

  if (typeof raw_resp === "string") {
    return raw_resp;
  }

  if (Array.isArray(raw_resp)) {
    return _coerce_content_array(raw_resp);
  }

  if (_isPlainDict(raw_resp)) {
    const rec = raw_resp as Record<string, unknown>;
    for (const key of text_keys) {
      const val = rec[key];
      if (typeof val === "string") {
        return val;
      }
      if (Array.isArray(val)) {
        const result = _coerce_content_array(val);
        if (result) {
          return result;
        }
      }
    }
  }

  return "";
}

/** Callable that returns a hint object (with tokens_saved) or null. */
export type DedupeHintBuilder = (session_id: string, cache: unknown) => unknown;

/**
 * Append *hint_text* to *context_parts* and record metrics iff *fingerprint* is
 * new.
 *
 * Centralises the three-step dedup→emit pattern:
 *  1. Check if fingerprint already seen via cache.has_hint_fingerprint
 *  2. Record it via cache.mark_hint_seen
 *  3. Increment the per-type counter via cache.record_hint_emitted
 *
 * Returns true when the hint was appended, false when suppressed or cache is null.
 *
 * @param cache         Session cache or null (returns false if null).
 * @param fingerprint   Unique key for this hint.
 * @param hint_text     Text to append to *context_parts* when new.
 * @param stat_key      Stat kind string for record_hint_emitted.
 * @param context_parts List to append *hint_text* to; mutated in place.
 */
export function emit_if_new_hint(
  cache: unknown,
  fingerprint: string,
  hint_text: string,
  stat_key: string,
  context_parts: string[],
): boolean {
  if (cache === null || cache === undefined) {
    return false;
  }
  let has_hint_fp: boolean;
  try {
    const fn = (cache as { has_hint_fingerprint?: unknown }).has_hint_fingerprint;
    if (typeof fn !== "function") {
      return false;
    }
    has_hint_fp = Boolean(fn.call(cache, fingerprint));
  } catch {
    return false;
  }

  if (has_hint_fp) {
    return false;
  }

  context_parts.push(hint_text);
  try {
    const markFn = (cache as { mark_hint_seen?: unknown }).mark_hint_seen;
    const recFn = (cache as { record_hint_emitted?: unknown }).record_hint_emitted;
    if (typeof markFn === "function") {
      markFn.call(cache, fingerprint);
    }
    if (typeof recFn === "function") {
      recFn.call(cache, stat_key);
    }
  } catch {
    // AttributeError / TypeError analogue — swallowed.
  }
  return true;
}

/**
 * Shared skeleton for the four pre-hook dedup handlers.
 *
 * Loads the session cache, calls *builder* to produce a hint, records the stat
 * pair, logs, and returns a pre_tool_use_with_context response — or null when no
 * hint is available so the caller can fall through to CONTINUE.
 *
 * @param payload   The raw hook payload (must contain session_id).
 * @param builder   Callable (session_id, cache) -> hint | null.
 * @param stat_kind Base stat kind string, e.g. "bash_dedup_hint".
 * @param detail    Short string stored in the stat row detail column.
 * @param log_label Optional prefix for the LOG.info call. Defaults to "pre-hook".
 */
export function run_dedup_hint(
  payload: HookPayload,
  opts: {
    builder: DedupeHintBuilder;
    stat_kind: string;
    detail: string;
    log_label?: string | null;
  },
): HookResponse | null {
  const { builder, stat_kind, detail } = opts;
  const log_label = opts.log_label;

  const [session_id] = get_session_context(payload);
  if (!session_id) {
    return null;
  }

  const cache = load_session_safe(session_id);
  if (cache === null) {
    return null;
  }

  const hint = builder(session_id, cache);

  // Persist mutations made by the builder before the hook process exits. Save
  // unconditionally: the suppression path (hint is null) also mutates counters
  // that must survive the process boundary.
  session.save(cache);

  if (hint === null || hint === undefined) {
    return null;
  }

  record_hint_stat_pair(stat_kind, hint, detail);
  LOG.info(
    "%s: %s injected (tokens_saved=%d)",
    log_label ?? "pre-hook",
    stat_kind,
    _getNumericAttr(hint, "tokens_saved", 0),
  );
  return pre_tool_use_with_context(String(hint));
}

// ---------------------------------------------------------------------------
// Internal helpers (no Python analogue — narrowing shims for strict TS).
// ---------------------------------------------------------------------------

/** True for a plain (non-array, non-null) object — the JS analogue of isinstance(x, dict). */
function _isPlainDict(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * Read a numeric attribute off an arbitrary object, defaulting to *fallback*
 * when absent or non-numeric. Mirrors Python's getattr(obj, name, default) for
 * the numeric-attribute reads (tokens_saved).
 */
function _getNumericAttr(obj: unknown, name: string, fallback: number): number {
  if (obj !== null && typeof obj === "object" && name in obj) {
    const v = (obj as Record<string, unknown>)[name];
    if (typeof v === "number") {
      return v;
    }
  }
  return fallback;
}
