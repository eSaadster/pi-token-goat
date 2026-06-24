/**
 * Hook dispatcher: reads stdin JSON, routes to handlers, always returns {"continue": true}.
 *
 * Faithful port of src/token_goat/hooks_cli.py (the hook DISPATCH SHELL — 1428 LOC).
 * This module owns the dispatcher entry points (safe_run / dispatch), the
 * harness payload/response translation (normalize_payload / denormalize_response),
 * the fail-soft handler wrapper, the lazy handler resolver, the PreCompact handler
 * (pre_compact lives here, not in a submodule), and the compact-skip sentinel
 * fast-path helpers.
 *
 * --------------------------------------------------------------------------
 * THE WATCHDOG — the load-bearing design decision (read this before editing):
 * --------------------------------------------------------------------------
 * Python runs the handler in a DAEMON THREAD and join(timeout)s it; if still
 * alive past the budget it ABANDONS the wait (the thread orphans and keeps
 * running) and returns CONTINUE() + {_tg_watchdog_tripped:true, ...}. A Node
 * worker_thread COULD preempt a hung handler, but it runs in a separate isolate
 * where the test suite's main-thread vi.spyOn mocks are INVISIBLE — that would
 * break every mock-based dispatcher test. So this port does NOT use
 * worker_threads.
 *
 * Instead: `dispatch` (and therefore `safe_run`) is ASYNC. The handler runs ON
 * THE MAIN THREAD via `await handler(payload)` (handlers may be sync OR async —
 * await handles both), RACED against a timeout timer with Promise.race. If the
 * timer wins we return the watchdog-tripped CONTINUE result and let the handler
 * promise orphan (its own fail_soft / try-catch still fires) — the faithful
 * equivalent of Python abandoning the join. If the handler wins we clear the
 * timer and take the normal path (elapsed measure, slow/moderate logging,
 * result.continue setdefault true, _tg_elapsed_ms). This satisfies BOTH the
 * mock-based tests (the handler runs in-isolate so spies work) and the
 * hung-handler watchdog test (an async slow handler vs the timer).
 *
 * Python's `_hook_context` (contextvars.ContextVar holding (t0, budget_ms,
 * event)) ports to a node:async_hooks AsyncLocalStorage so
 * get_hook_context_remaining_ms() reads the running dispatch's deadline across
 * awaits. The contract is preserved: 0 when past the deadline, 1_000_000 with no
 * context.
 *
 * --------------------------------------------------------------------------
 * Handler resolution + not-yet-ported siblings:
 * --------------------------------------------------------------------------
 * _resolve_handler maps event -> (module, attr) from hook_registry.handler_lookup()
 * and dynamically imports the handler module. The handler modules
 * (hooks_session/edit/skill/fetch/read) DO NOT EXIST yet (Layer 5), so resolution
 * is fail-soft: a dynamic import("./<mod>.js") in try/catch returns null on
 * failure, the lazy proxy returns CONTINUE(), and dispatching a Layer-5 event
 * degrades to continue:true instead of crashing.
 *
 * pre_compact LIVES here but calls compact (Layer 4, not ported) for
 * merge_session_manifests / compute_adaptive_budget / build_manifest_with_count.
 * compact is referenced via a fail-soft dynamic import, so the self-contained
 * compact-skip-sentinel fast-path still works while the manifest-budget path
 * no-ops until Layer 4 lands. session / project / config ARE ported and are
 * imported statically so tests can spy on them.
 *
 * Parity notes (Python → TS):
 *  - The TypedDicts (HookPayload / HookResponse / HookSpecificOutput*) and the
 *    Harness literal SHAPES live in ./types.js (imported type-only). The runtime
 *    Harness type used here is the narrower Literal["claude","codex","gemini"]
 *    (types.ts's Harness is "claude"|"codex"|"both" for the registry — a
 *    different axis), so it is defined locally as `Harness` here (the verbatim
 *    Python name), NOT imported from types.ts. Reported in known_gaps.
 *  - Module-global mutable state (_log_date_cached, _HANDLER_CACHE, the hook
 *    AsyncLocalStorage, _current_harness) → module-level lets/Maps + a
 *    registerReset so the per-test wipe (tests/setup.ts) returns them to their
 *    freshly-imported baseline.
 *  - contextvars.ContextVar → AsyncLocalStorage. The harness contextvar
 *    (_current_harness, default "claude") ports as a module-level let set by
 *    safe_run (Node has no per-async-context default-carrying var without an
 *    enclosing run(); a plain let is the faithful "defaults to claude when
 *    bypassed" behaviour the Python ContextVar default provides).
 *  - byte math is UTF-8 via utf8Bytes (Buffer), never String.length.
 *  - sibling modules a test spies on (session, db, config, project, paths) are
 *    reached via STATIC `import * as x from "./x.js"` so vi.spyOn(x, "fn") is
 *    observed (createRequire / dynamic import would load a separate instance the
 *    spy cannot see). The NOT-YET-PORTED compact / handler modules are the only
 *    dynamic imports — they cannot be spied on until they land, and importing
 *    them statically would crash module load.
 *
 * `verbatimModuleSyntax` is on → type-only imports use `import type`.
 * `exactOptionalPropertyTypes` is on → optional fields are `T | undefined`.
 * `noUncheckedIndexedAccess` is on → indexed access is narrowed before use.
 */

import { AsyncLocalStorage } from "node:async_hooks";
import * as fs from "node:fs";
import * as nodePath from "node:path";
import { performance } from "node:perf_hooks";

import * as paths from "./paths.js";
import * as config from "./config.js";
import * as session from "./session.js";
import * as project from "./project.js";
import * as db from "./db.js";
import { CANONICAL_TOOLS } from "./hook_registry.js";
import * as hook_registry from "./hook_registry.js";
import { CONTINUE, sanitize_log_str } from "./hooks_common.js";
import * as util from "./util.js";
import { configureStdoutEncoding, getLogger, utf8Bytes } from "./util.js";
import { registerReset } from "./reset.js";

// sanitize_surrogates is reached through the `util` namespace (NOT the named
// import above) at its call sites in safe_run so a test can spy on it the way
// Python's crash-sink test monkeypatches hooks_cli.sanitize_surrogates. The
// snake_case re-export below preserves the Python attribute name on this module.
export const sanitize_surrogates = util.sanitizeSurrogates;

import type { HookPayload, HookResponse } from "./types.js";

// Re-export the typed shapes so callers that imported them from hooks_cli in
// Python (`from .hooks_cli import HookPayload`) port one-for-one.
export type { HookPayload, HookResponse } from "./types.js";

/**
 * Mirror of the Python module's `__all__`. Kept as a runtime array so a test
 * asserting membership ports one-for-one. The names use the Python snake_case
 * form (the canonical contract); each has a matching export below.
 */
export const __all__ = [
  "EVENTS",
  "Harness",
  "HookPayload",
  "HookResponse",
  "_SkipResult",
  "_check_compact_skip_sentinel",
  "_check_compact_skip_sentinel_detail",
  "_current_harness",
  "_current_session_counts",
  "_is_noop_session",
  "_read_sentinel_counts",
  "_write_compact_skip_sentinel",
  "denormalize_response",
  "dispatch",
  "emit",
  "fail_soft",
  "get_hook_context_remaining_ms",
  "normalize_payload",
  "pre_compact",
  "read_payload",
  "safe_run",
] as const;

// Ensure UTF-8 encoding on stdout/stderr for Windows cp1252 terminals.
// (No-op stub in the TS port — Node process I/O is already UTF-8 everywhere.)
configureStdoutEncoding();

/**
 * Valid harness identifiers used by normalize_payload, denormalize_response, and
 * safe_run.
 *
 * NOTE: types.ts's `Harness` is the registry axis (`"claude"|"codex"|"both"`),
 * a different concept. The dispatcher's harness is the wire-format selector
 * Literal["claude","codex","gemini"] from the Python module; it is defined here
 * locally as `Harness` (the verbatim Python name) so callers/tests port 1:1.
 * Reported in known_gaps.
 */
export type Harness = "claude" | "codex" | "gemini";

const _LOG = getLogger("hooks");

// Cached log-path date string — invalidated when the calendar date rolls over.
// Avoids a Date() construction on every hook dispatch (hooks fire on every
// Read/Write/Edit/Bash tool use; the date string changes at most once a day).
let _log_date_cached = "";

/**
 * Context-local watchdog budget tracking: stores (start_time_ms, budget_ms,
 * event_name) for the currently-executing hook. Used by DB layers to apply
 * shorter timeouts when running inside a hook handler (where the watchdog budget
 * is limited). Undefined when not inside a hook.
 *
 * Python: contextvars.ContextVar("tg_hook_context", default=None). The TS port
 * uses AsyncLocalStorage so get_hook_context_remaining_ms() reads the running
 * dispatch's deadline across awaits.
 *
 * start_time_ms is performance.now()-based (the monotonic clock Python uses via
 * time.monotonic()), in MILLISECONDS (Python stored seconds and multiplied by
 * 1000 on read; storing ms here keeps the arithmetic in one unit).
 */
type HookContext = readonly [start_time_ms: number, budget_ms: number, event_name: string];

const _hook_context = new AsyncLocalStorage<HookContext>();

/**
 * Context-local harness identifier set by safe_run before dispatching.
 *
 * Allows inner handlers to read the active harness without threading it through
 * every function signature. Python used a ContextVar with default "claude" so a
 * call that bypasses safe_run (e.g. direct dispatch() in tests) still gets
 * sensible behaviour. Node has no default-carrying async var without an
 * enclosing run(), so this is a module-level `let` defaulting to "claude" —
 * identical observable behaviour (safe_run sets it; everything else reads the
 * default). Exposed via getter/setter so tests/handlers can read/poke it.
 */
let _current_harness_value: Harness = "claude";

/** Read the context-local harness identifier (mirrors `_current_harness.get()`). */
export function _current_harness_get(): Harness {
  return _current_harness_value;
}

/** Set the context-local harness identifier (mirrors `_current_harness.set(...)`). */
export function _current_harness_set(value: Harness): void {
  _current_harness_value = value;
}

/**
 * Namespace object exposed under the Python name `_current_harness` so call
 * sites that did `_current_harness.get()` / `_current_harness.set(x)` port
 * one-for-one (Python ContextVar API surface).
 */
export const _current_harness = {
  get: _current_harness_get,
  set: _current_harness_set,
} as const;

// Reset module-global mutable state to its freshly-imported baseline before each
// test (tests/setup.ts → clearModuleCaches). Mirrors "each fresh Python process
// starts fresh": the date cache, the resolved-handler cache, and the harness var.
registerReset(() => {
  _log_date_cached = "";
  _HANDLER_CACHE.clear();
  _current_harness_value = "claude";
});

/**
 * Idempotent: daily-rotated log file in logs/.
 *
 * In the TS port the logging layer farms out to console (util.getLogger), so
 * there is no FileHandler to attach. paths.openLogFile() throws (not yet
 * ported); the original Python wraps the whole setup in a try/except OSError and
 * falls back to a NullHandler, so this port mirrors that fail-soft contract: the
 * date-cache bookkeeping and paths.ensure_dirs() / roll-if-oversized run inside
 * a try, and any failure (including the openLogFile throw) is swallowed so the
 * hook still runs and returns {"continue": true}.
 *
 * The log-path date string is cached in `_log_date_cached` and only recomputed
 * when the calendar date actually changes, avoiding a Date() construction on
 * every dispatch.
 */
export function _setup_logging(): void {
  // Python: datetime.now().strftime("%Y-%m-%d"). Local-time YYYY-MM-DD.
  const now = new Date();
  const today = `${now.getFullYear().toString().padStart(4, "0")}-${(now.getMonth() + 1)
    .toString()
    .padStart(2, "0")}-${now.getDate().toString().padStart(2, "0")}`;
  if (today === _log_date_cached) {
    return;
  }
  // Either first call or the day has rolled over.
  _log_date_cached = today;
  try {
    paths.ensureDirs();
    const log_path = `${paths.logsDir()}/${today}.log`;
    paths.rollLogIfOversized(log_path, paths.LOG_FILE_MAX_BYTES);
    // paths.openLogFile() throws in the TS port (FileHandler analogue pending
    // the worker layer); the console-backed logger needs no handler attached,
    // so the open is best-effort and its failure is caught below.
    paths.openLogFile(log_path);
  } catch {
    // OSError (read-only/inaccessible log dir) or the not-yet-ported
    // openLogFile throw — fall through; the console logger keeps working and
    // the hook still returns continue:true.
  }
}

/**
 * Translate harness-specific payloads to token-goat's internal format.
 *
 * Codex sends snake_case tool names (e.g. `bash`, `edit_file`, `write_file`)
 * where Claude uses PascalCase (`Bash`, `Edit`, `Write`). Codex also uses
 * `turn_id` instead of a message ID. The inbound field names for `session_id`,
 * `cwd`, and `tool_input` are identical between the two harnesses, so only the
 * tool name needs remapping.
 *
 * Gemini CLI uses snake_case tool names (e.g. `run_shell_command`, `replace`)
 * and may include a `functionCallId` field instead of `toolUseId`. Both fields
 * are normalised to `toolUseId` so downstream handlers see a consistent shape.
 *
 * Output normalisation (camelCase → snake_case for Codex; continue/decision for
 * Gemini) is handled by denormalize_response.
 *
 * Validates that the payload has a non-empty tool_name (required by all
 * handlers). On invalid payload, logs a warning and returns an empty dict so
 * handlers degrade gracefully (no-op with continue:true).
 */
export function normalize_payload(payload: HookPayload, harness: Harness = "claude"): HookPayload {
  // Schema check: payload must be a dict with a valid tool_name.
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) {
    _LOG.warning(
      "normalize_payload: payload is not a dict; received %s",
      payload === null ? "null" : typeof payload,
    );
    return {} as HookPayload;
  }

  if (Object.keys(payload).length === 0) {
    _LOG.warning("normalize_payload: payload is empty");
    return {} as HookPayload;
  }

  const tool_name = payload.tool_name;
  if (typeof tool_name !== "string" || tool_name.trim() === "") {
    // Non-tool lifecycle events (SessionStart, UserPromptSubmit, SubagentStop,
    // PreCompact, Stop) legitimately carry no `tool_name`; this is the normal
    // payload shape for them, not an error. A single session start fans out into
    // dozens of such events, so logging at WARNING produced 45+ identical noise
    // lines per SessionStart. DEBUG keeps the signal for operators chasing a
    // genuinely malformed tool payload without spamming the log on every clean run.
    _LOG.debug("normalize_payload: tool_name missing or invalid; received %s", JSON.stringify(tool_name));
    return {} as HookPayload;
  }

  if (harness === "codex") {
    // Remap Codex snake_case tool names to token-goat PascalCase internal names.
    const mapped = _CODEX_TOOL_NAME_MAP[tool_name];
    if (mapped === undefined) {
      // Warn at WARNING so operators can see unknown tools in logs rather than
      // having them silently pass through to handlers that may not recognise them.
      if (!_TG_KNOWN_TOOLS.has(tool_name)) {
        _LOG.warning(
          "normalize_payload: unknown Codex tool %s — passing through unrecognised",
          JSON.stringify(tool_name),
        );
      } else {
        _LOG.debug(
          "normalize_payload: Codex tool %s already PascalCase — passing through",
          JSON.stringify(tool_name),
        );
      }
    } else {
      payload = { ...payload };
      payload.tool_name = mapped;
    }
    payload = { ...payload };
    payload._tg_harness = harness;
    return payload;
  }

  if (harness === "gemini") {
    // Remap Gemini tool names to token-goat internal names.
    const mapped = _GEMINI_TOOL_NAME_MAP[tool_name];
    if (mapped === undefined) {
      _LOG.warning(
        "normalize_payload: unknown Gemini tool %s — passing through unrecognised",
        JSON.stringify(tool_name),
      );
    } else {
      payload = { ...payload };
      payload.tool_name = mapped;
      // Remap tool_input keys for the translated tool.
      const raw_input = payload.tool_input ?? {};
      if (raw_input !== null && typeof raw_input === "object" && !Array.isArray(raw_input)) {
        const key_map = _GEMINI_INPUT_KEY_MAP[mapped] ?? {};
        if (Object.keys(key_map).length > 0) {
          const new_input: Record<string, unknown> = {};
          for (const [k, v] of Object.entries(raw_input as Record<string, unknown>)) {
            new_input[key_map[k] ?? k] = v;
          }
          payload.tool_input = new_input;
        }
      }
    }
    // Gemini may send functionCallId instead of toolUseId — normalise to toolUseId.
    if ("functionCallId" in payload && !("toolUseId" in payload)) {
      const fcid = payload.functionCallId;
      payload = { ...payload };
      if (fcid !== undefined) {
        payload.toolUseId = fcid;
      }
      delete payload.functionCallId;
    }
    payload = { ...payload };
    payload._tg_harness = harness;
    return payload;
  }

  // Claude harness: field names already match the internal shape; no
  // transformation needed. Still stamp the harness so downstream handlers can
  // read it without needing the ContextVar.
  payload = { ...payload };
  payload._tg_harness = harness;
  return payload;
}

/**
 * Mapping of camelCase `hookSpecificOutput` keys to their Codex snake_case
 * equivalents.
 *
 * NOTE: Codex 0.137.0+ uses camelCase throughout `hookSpecificOutput`, so this
 * table is no longer applied in denormalize_response. Kept for reference.
 */
export const _HSO_CAMEL_TO_SNAKE: Record<string, string> = {
  additionalContext: "additional_context",
  updatedInput: "updated_input",
  permissionDecision: "permission_decision",
  permissionDecisionReason: "permission_decision_reason",
  hookEventName: "hook_event_name",
};

/**
 * Canonical set of PascalCase tool names that token-goat handlers recognise.
 * Used by normalize_payload to distinguish known pass-through names (e.g. a
 * harness that already sends PascalCase) from genuinely unknown tools that
 * warrant a WARNING so operators can spot mapping gaps.
 *
 * Source of truth: hook_registry.CANONICAL_TOOLS — imported above.
 */
export const _TG_KNOWN_TOOLS: ReadonlySet<string> = CANONICAL_TOOLS;

// Codex tool name → token-goat internal tool name.
// Codex uses lowercase/snake_case names; token-goat handlers expect PascalCase.
// Keys cover the canonical Codex names plus common short aliases that some
// Codex versions emit (e.g. "edit" alongside "edit_file").
export const _CODEX_TOOL_NAME_MAP: Record<string, string> = {
  bash: "Bash",
  edit_file: "Edit",
  edit: "Edit",
  write_file: "Write",
  search_files: "Grep",
  grep: "Grep",
  list_files: "Glob",
  glob: "Glob",
  web_search: "WebFetch",
};

// Gemini CLI tool name → token-goat internal tool name.
// Gemini's tool names follow snake_case; token-goat uses PascalCase.
export const _GEMINI_TOOL_NAME_MAP: Record<string, string> = {
  run_shell_command: "Bash",
  read_file: "Read",
  read_many_files: "Read",
  list_directory: "Read",
  write_file: "Write",
  replace: "Edit",
  glob: "Glob",
  grep_search: "Grep",
  search_file_content: "Grep",
  web_search: "WebFetch",
  web_fetch: "WebFetch",
};

// Gemini tool_input key → token-goat tool_input key, per remapped tool.
// Only keys that differ between Gemini and token-goat need to appear here.
export const _GEMINI_INPUT_KEY_MAP: Record<string, Record<string, string>> = {
  Read: { path: "file_path" },
  Write: { path: "file_path" },
  Edit: { path: "file_path", old_str: "old_string", new_str: "new_string" },
  Grep: { query: "pattern" },
};

/**
 * No longer called — Codex 0.137.0+ uses camelCase in hookSpecificOutput; kept
 * for reference.
 */
export function _translate_hso_to_codex(hso: Record<string, unknown>): Record<string, unknown> {
  const translated: Record<string, unknown> = {};
  for (const [key, val] of Object.entries(hso)) {
    const new_key = _HSO_CAMEL_TO_SNAKE[key] ?? key;
    if (val !== null && typeof val === "object" && !Array.isArray(val)) {
      translated[new_key] = _translate_hso_to_codex(val as Record<string, unknown>);
    } else {
      translated[new_key] = val;
    }
  }
  return translated;
}

/**
 * Resolve the Codex hookEventName const (e.g. "pre-read" → "PreToolUse") from
 * the hook registry.
 */
export function _codex_hook_event_name(event: string): string {
  const ev = hook_registry.lookup(event);
  if (ev === null) {
    return "";
  }
  return ev.claude_event || ev.codex_event || "";
}

/** Translate token-goat's internal response dict to the harness wire format. */
export function denormalize_response(
  response: Record<string, unknown>,
  harness: Harness = "claude",
  event = "",
): Record<string, unknown> {
  if (harness === "codex") {
    // All Codex output schemas declare additionalProperties:false — _tg_* keys
    // from dispatch() cause "hook returned invalid JSON output".
    const result: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(response)) {
      if (!k.startsWith("_tg_")) {
        result[k] = v;
      }
    }
    // Codex requires hookEventName as a typed const in every hookSpecificOutput
    // shape; inject it when absent.
    const hso = result["hookSpecificOutput"];
    if (hso !== null && typeof hso === "object" && !Array.isArray(hso) && !("hookEventName" in hso)) {
      const hen = _codex_hook_event_name(event);
      if (hen) {
        result["hookSpecificOutput"] = { hookEventName: hen, ...(hso as Record<string, unknown>) };
      }
    }
    return result;
  }

  if (harness === "gemini") {
    const out: Record<string, unknown> = {};
    // Map continue→decision: false→"deny", true (or absent)→"allow".
    // For SessionStart/PreCompress Gemini treats decision as advisory, but
    // emitting it is harmless and keeps the wire shape uniform.
    const continue_val = "continue" in response ? response["continue"] : true;
    out["decision"] = continue_val ? "allow" : "deny";
    // Gemini natively renders a top-level `systemMessage` (SessionStart git
    // brief, PreCompress compaction manifest). Preserve it — dropping it silently
    // discarded token-goat's entire compaction manifest and the session-start
    // orientation brief for every Gemini user.
    const sysmsg = response["systemMessage"];
    if (typeof sysmsg === "string" && sysmsg) {
      out["systemMessage"] = sysmsg;
    }
    const hso = response["hookSpecificOutput"];
    if (hso !== null && typeof hso === "object" && !Array.isArray(hso)) {
      const hsoRec = hso as Record<string, unknown>;
      // `reason` is only surfaced by Gemini on a *deny* (sent to the agent as a
      // tool error); on an allow it is advisory and ignored. Context injection
      // (session memory, post-read/skill hints) MUST therefore ride
      // `hookSpecificOutput.additionalContext` — Gemini's native channel
      // ("injected as the first turn" at SessionStart, "appended to the tool
      // result" at AfterTool). Flattening additionalContext into `reason`
      // silently dropped every hint on the allow path, where token-goat emits
      // virtually all of them.
      const add_ctx = hsoRec["additionalContext"];
      if (typeof add_ctx === "string" && add_ctx) {
        out["hookSpecificOutput"] = { additionalContext: add_ctx };
      }
      const reason = hsoRec["permissionDecisionReason"];
      if (reason) {
        out["reason"] = reason;
      }
    }
    // Pass through diagnostic fields for debugging.
    for (const k of ["_tg_elapsed_ms", "_tg_handler", "_tg_error"] as const) {
      if (k in response) {
        out[k] = response[k];
      }
    }
    return out;
  }

  return response;
}

export const _MAX_PAYLOAD_BYTES = 10 * 1024 * 1024; // 10 MB — guard against runaway harness output

// Hook dispatch timing thresholds (milliseconds).
// Hooks slower than HOOK_SLOW_MS are logged at WARNING level; hooks between
// HOOK_MODERATE_MS and HOOK_SLOW_MS are logged at DEBUG with a "moderate" tag.
export const _HOOK_SLOW_MS = 500;
export const _HOOK_MODERATE_MS = 100;

// Watchdog budget for a single hook handler. Set to 4x the slow threshold so a
// "slow but legitimate" handler completes well within the budget, while a
// genuinely hung handler (deadlock, blocked I/O on a dead socket, etc.) is
// abandoned before it can stall the agent. In Python this rationale referenced
// signal.alarm being POSIX-only; the TS port races the handler promise against a
// timeout timer instead (see dispatch) — same budget, same semantics.
//
// NOTE: this is a module-level `let` (not const) because the dispatcher tests
// monkeypatch it via vi.spyOn-style reassignment — Python does
// monkeypatch.setattr(hooks_cli, "_HOOK_WATCHDOG_MS", N). Mutate the exported
// binding through the setter (set_HOOK_WATCHDOG_MS) to mirror that.
export let _HOOK_WATCHDOG_MS = _HOOK_SLOW_MS * 4;

/** Test seam: reassign the module-level _HOOK_WATCHDOG_MS (Python monkeypatch.setattr). */
export function set_HOOK_WATCHDOG_MS(value: number): void {
  _HOOK_WATCHDOG_MS = value;
}

// Operator-tunable bounds for the watchdog budget. 100ms is a hard floor so a
// bad env value can't make every hook trip the watchdog on the first sleep; the
// 30s ceiling caps the worst-case agent stall from a wedged handler at half a
// minute. Outside this range we clamp rather than reject so a fat-fingered value
// still produces sane behavior (fail-soft over fail-loud).
export const _HOOK_WATCHDOG_MS_FLOOR = 100;
export const _HOOK_WATCHDOG_MS_CEIL = 30_000;

/**
 * Environment variable that overrides `_HOOK_WATCHDOG_MS` per-invocation.
 * Read on every dispatch (cheap — a dict lookup) so an operator can re-tune the
 * budget by editing settings.json without restarting the agent. Invalid/blank
 * values silently fall back to the compiled default.
 */
export const _ENV_HOOK_WATCHDOG_MS = "TOKEN_GOAT_HOOK_WATCHDOG_MS";

/**
 * Return the effective watchdog budget in milliseconds.
 *
 * Three-layer resolution:
 *   1. Env var `_ENV_HOOK_WATCHDOG_MS`, clamped to
 *      [_HOOK_WATCHDOG_MS_FLOOR, _HOOK_WATCHDOG_MS_CEIL].
 *   2. Per-project config value from config.load().hooks.watchdog_ms (has a
 *      process-level mtime cache — costs one stat per call).
 *   3. Compile-time constant `_HOOK_WATCHDOG_MS` — terminal fallback when
 *      config.load() raises.
 *
 * Any parse failure on Layer 1 (non-numeric, negative) also falls back to
 * `_HOOK_WATCHDOG_MS` directly (skipping Layer 2) since bad env values indicate a
 * misconfiguration, not an absent config file.
 */
export function _resolved_watchdog_ms(): number {
  const raw = (process.env[_ENV_HOOK_WATCHDOG_MS] ?? "").trim();
  if (raw === "") {
    // Layer 2: per-project config baseline before the compile-time constant.
    try {
      const cfg = config.load();
      const watchdog = cfg.hooks?.watchdog_ms;
      if (typeof watchdog === "number") {
        return watchdog;
      }
      return _HOOK_WATCHDOG_MS;
    } catch {
      return _HOOK_WATCHDOG_MS;
    }
  }
  // Python: int(raw) — strict integer parse. JS Number() accepts floats/sci, so
  // gate on a strict integer regex first; non-integer garbage falls to default.
  if (!/^[+-]?\d+$/.test(raw)) {
    return _HOOK_WATCHDOG_MS;
  }
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) {
    return _HOOK_WATCHDOG_MS;
  }
  if (parsed <= 0) {
    return _HOOK_WATCHDOG_MS;
  }
  // Clamp to the operator-safe band. We deliberately clamp rather than raise: a
  // hook firing on every tool call must not crash on a bad env value, and the
  // clamped behavior is still observable + correctable.
  if (parsed < _HOOK_WATCHDOG_MS_FLOOR) {
    return _HOOK_WATCHDOG_MS_FLOOR;
  }
  if (parsed > _HOOK_WATCHDOG_MS_CEIL) {
    return _HOOK_WATCHDOG_MS_CEIL;
  }
  return parsed;
}

/**
 * Return milliseconds remaining until the hook watchdog deadline.
 *
 * If called outside a hook, returns a large number (1000000 ms). If called
 * inside a hook and the deadline has passed, returns 0. Useful for DB layers to
 * apply shorter timeouts when running hot against the watchdog budget.
 */
export function get_hook_context_remaining_ms(): number {
  const ctx = _hook_context.getStore();
  if (ctx === undefined) {
    return 1_000_000;
  }
  const [start_time_ms, budget_ms] = ctx;
  const elapsed_ms = _monotonicMs() - start_time_ms;
  const remaining = Math.max(0, budget_ms - elapsed_ms);
  return Math.trunc(remaining);
}

/**
 * Monotonic clock in milliseconds. Python uses time.monotonic() (seconds) and
 * multiplies by 1000; Node's perf_hooks performance.now() is already a monotonic
 * high-resolution millisecond clock, so it is the faithful analogue.
 */
function _monotonicMs(): number {
  return performance.now();
}

/**
 * Read JSON payload from stdin (or a file, for testing).
 *
 * Always returns a dict. Coerces non-dict JSON (`null`, lists, scalars) to `{}`
 * so handlers can safely access payload fields. Catches JSON decode errors and
 * returns an empty dict instead of crashing.
 *
 * Enforces a 10 MB size cap on the raw input to prevent a malicious or runaway
 * harness from causing an OOM condition by sending an unbounded payload.
 *
 * @param input_file Absolute path to a JSON file (test seam). When undefined,
 *   reads from stdin (file descriptor 0) synchronously — the faithful analogue
 *   of Python's sys.stdin.read(). Pass a string path to read a file instead.
 */
export function read_payload(input_file?: string): HookPayload {
  let data: unknown;
  try {
    if (input_file !== undefined) {
      const raw = fsReadTextUtf8(input_file);
      // Encode to UTF-8 once and reuse the bytes for both the size check and the
      // warning log so we don't encode twice.
      const raw_bytes = utf8Bytes(raw);
      if (raw_bytes.length > _MAX_PAYLOAD_BYTES) {
        _LOG.warning(
          "hook payload from file too large (%d bytes > %d limit); ignoring",
          raw_bytes.length,
          _MAX_PAYLOAD_BYTES,
        );
        return {};
      }
      data = JSON.parse(raw);
    } else {
      // Read stdin synchronously. Node has no "read one byte past the limit"
      // streaming primitive in sync form, so read the whole stream and then
      // size-check the decoded string length (mirrors the Python char count).
      const raw = readStdinSync();
      if (raw.length > _MAX_PAYLOAD_BYTES) {
        _LOG.warning("hook payload from stdin too large (> %d bytes); ignoring", _MAX_PAYLOAD_BYTES);
        return {};
      }
      if (raw.trim() === "") {
        return {};
      }
      data = JSON.parse(raw);
    }
  } catch (e) {
    // JSON.parse SyntaxError → Python's json.JSONDecodeError branch.
    // fs read errors (ENOENT/EISDIR/EACCES, or a non-UTF-8 decode) → Python's
    // OSError / UnicodeDecodeError branches. All return {} so the dispatcher can
    // fall through to the CONTINUE safety net rather than crashing.
    if (e instanceof SyntaxError) {
      _LOG.warning("failed to decode JSON payload: %s", String(e));
    } else {
      _LOG.warning("failed to read payload from file: %s", String(e));
    }
    return {};
  }
  return data !== null && typeof data === "object" && !Array.isArray(data) ? (data as HookPayload) : {};
}

/**
 * Write the hook result to stdout as JSON, swallowing every output error.
 *
 * Forces UTF-8 on stdout (Node is UTF-8 everywhere; the Python rationale about
 * Windows cp1252 does not apply but the fail-soft contract does). Never raises: a
 * broken pipe, missing buffer, or closed stream simply ends the call without
 * surfacing an error to the harness, which would otherwise see the hook as
 * failed.
 */
export function emit(result: Record<string, unknown>): void {
  let payload: string;
  try {
    payload = JSON.stringify(result);
  } catch {
    // Non-serializable value in result (e.g. a Date, Set, BigInt from a handler
    // bug, or a cyclic structure). Fall back to a replacer that coerces unknown
    // values to strings so the harness always receives valid JSON rather than a
    // silent empty response — mirrors Python's json.dumps(default=str).
    try {
      payload = JSON.stringify(result, _jsonDefaultStrReplacer());
    } catch {
      // Even the fallback failed (cyclic) — swallow and return nothing.
      return;
    }
  }
  // Preferred: raw bytes so UTF-8 is correct on Windows.
  try {
    process.stdout.write(utf8Bytes(payload));
    return;
  } catch (e) {
    _LOG.debug("emit: binary write failed, trying text fallback: %s", String(e));
  }
  // Fallback: text-mode write.
  try {
    process.stdout.write(payload);
  } catch {
    // Swallow — the fail-soft contract forbids surfacing an output error.
  }
}

/**
 * Run a hook event end-to-end with absolute fail-soft semantics.
 *
 * Catches every error so the process always succeeds, no matter what. On failure
 * we still emit a valid `{"continue": true}` response so the harness has
 * something to parse, and we log a one-line diagnostic to stderr so the harness's
 * hook-error display has the cause if you go looking for it.
 *
 * ASYNC because dispatch() is async (the watchdog races the handler promise
 * against a timer). Callers `await safe_run(...)`.
 */
export async function safe_run(event: string, input_file?: string, harness: Harness = "claude"): Promise<void> {
  let result: Record<string, unknown> = { ...CONTINUE() };
  _current_harness.set(harness);
  let raw: HookPayload | undefined;
  let dispatched: Record<string, unknown>;
  try {
    raw = read_payload(input_file);
    const payload = normalize_payload(raw, harness);
    dispatched = await dispatch(event, payload);
  } catch (exc) {
    // Process-control signals must propagate in Python (KeyboardInterrupt /
    // SystemExit); JS has no analogue thrown from this path, so every caught
    // error is treated as a hook failure.
    const excName = exc instanceof Error ? exc.constructor.name : "Error";
    const excMsg = exc instanceof Error ? exc.message : String(exc);
    const msg = `token-goat hook ${event} failed: ${excName}: ${excMsg}`;
    // Sanitize surrogates at the message boundary so every downstream consumer
    // (stderr print, logger, crash-sink write) receives valid UTF-8. On Windows,
    // a path with non-UTF-8 bytes produces surrogate-escape chars; without
    // sanitization the write would raise and the crash would be silently lost.
    // Called via the `util` namespace so the crash-sink test's spy is observed.
    const safe_msg = util.sanitizeSurrogates(msg);
    try {
      process.stderr.write(safe_msg + "\n");
    } catch {
      // swallow
    }
    try {
      // Attempt to persist to log file even if normal setup failed.
      _setup_logging();
      _LOG.error("%s", safe_msg);
    } catch {
      // swallow
    }
    // Dedicated crash sink: append msg + traceback to hooks-stderr.log so hook
    // crashes are not silently lost when the harness redirects stderr to
    // nul:/dev/null. This must never raise — any write failure is swallowed so
    // the fail-soft contract (always returns continue:true) is preserved.
    try {
      const sink = paths.hooksStderrLogPath();
      paths.ensureDir(dirname(sink));
      paths.rollLogIfOversized(sink, paths.HOOKS_STDERR_LOG_MAX_BYTES);
      const tb = exc instanceof Error && exc.stack ? exc.stack : `${excName}: ${excMsg}`;
      // safe_msg was sanitized above; only tb needs sanitization here. Via the
      // `util` namespace so the crash-sink test's spy counts this call too.
      const safe_tb = util.sanitizeSurrogates(tb);
      // Prepend a structured JSON header so entries are machine-parseable. Use
      // the recovered raw payload (may be undefined if read_payload itself
      // threw) to extract session_id regardless of which statement raised.
      const _raw: Record<string, unknown> = raw ?? {};
      const _sid = String(_raw["session_id"] ?? "").slice(0, 16);
      const header = JSON.stringify({
        ts: nowSeconds(),
        event,
        sid: _sid,
        err: `${excName}: ${excMsg}`,
      });
      appendFileUtf8(sink, header + "\n" + safe_msg + "\n" + safe_tb + "\n");
    } catch {
      // swallow
    }
    emit(result);
    return;
  }
  // Dispatch succeeded — attempt output translation. A bug in
  // denormalize_response (e.g. a future field that triggers an error in
  // _translate_hso_to_codex) must not discard the real dispatch output. If
  // translation fails, emit the un-denormalized dict: the harness sees
  // unexpected keys and ignores them — still better than bare CONTINUE.
  try {
    result = { ...denormalize_response(dispatched, harness, event) };
  } catch (_denorm_exc) {
    _LOG.warning(
      "denormalize_response failed for %s (%s): %s — emitting raw dispatch output",
      event,
      harness,
      String(_denorm_exc),
    );
    result = { ...dispatched };
  }
  emit(result);
  // Best-effort: record hook timing AFTER emit() so the stat write never adds
  // latency visible to the harness. bytes_saved stores elapsed_ms as an int so
  // SQL aggregates (AVG/MAX) work without a schema change.
  try {
    const _elapsed_ms = result["_tg_elapsed_ms"];
    if (typeof _elapsed_ms === "number") {
      db.recordStat(undefined, `hook:${sanitize_log_str(event, 48)}`, {
        bytesSaved: Math.trunc(_elapsed_ms),
      });
    }
  } catch {
    // swallow
  }
}

// ---------------------------------------------------------------------------
// Internal fs / json / time shims (no Python analogue — Node stdlib bridges).
// node:fs / node:path are imported at the top of the module; these helpers wrap
// the small number of direct filesystem touches this module makes that paths.ts
// does not already cover (reading the payload file, appending the crash sink).
// ---------------------------------------------------------------------------

/** Read a UTF-8 text file. Throws on a non-UTF-8 file? No — Node replaces invalid
 *  bytes with U+FFFD under "utf8"; the Python UnicodeDecodeError branch is folded
 *  into the generic read-error catch in read_payload, which returns {} either way. */
function fsReadTextUtf8(p: string): string {
  return fs.readFileSync(p, "utf8");
}

/** Default stdin source: read fd 0 (standard input) synchronously as UTF-8 —
 *  the faithful analogue of Python's sys.stdin.read(). Returns "" if fd 0 errors
 *  (closed/EOF). NOTE: a synchronous read of an open-but-empty fd 0 BLOCKS, which
 *  is why tests must inject via _set_stdin_reader rather than hit the real fd. */
function _defaultStdinReader(): string {
  try {
    return fs.readFileSync(0, "utf8");
  } catch {
    // No stdin attached (EAGAIN/EOF on a closed fd) — treat as empty input.
    return "";
  }
}

// Overridable stdin source. Python tests do monkeypatch.setattr(sys, "stdin", …);
// the TS port exposes this explicit seam (same pattern as paths' data-dir
// override) so tests inject payload text without touching the real fd 0. Reset
// to the default before every test via the registry below.
let _stdinReader: () => string = _defaultStdinReader;

/** Test seam: override the stdin source. Pass null to restore the fd-0 reader. */
export function _set_stdin_reader(fn: (() => string) | null): void {
  _stdinReader = fn ?? _defaultStdinReader;
}

registerReset(() => {
  _stdinReader = _defaultStdinReader;
});

/** Read all of stdin synchronously as UTF-8 via the (overridable) reader. */
function readStdinSync(): string {
  return _stdinReader();
}

/** Append text to a file as UTF-8, creating it if absent. */
function appendFileUtf8(p: string, text: string): void {
  fs.appendFileSync(p, text, "utf8");
}

/** Directory name of a path (node:path.dirname). */
function dirname(p: string): string {
  return nodePath.dirname(p);
}

/** Unix epoch seconds as a float (Python time.time()). */
function nowSeconds(): number {
  return Date.now() / 1000;
}

/** JSON.stringify replacer that coerces values JSON cannot serialise to their
 *  String() form — the analogue of Python json.dumps(default=str). Applied only
 *  on the emit() fallback path. */
function _jsonDefaultStrReplacer(): (key: string, value: unknown) => unknown {
  return (_key, value) => {
    if (typeof value === "bigint") {
      return value.toString();
    }
    return value;
  };
}

/**
 * Extract sanitized session and cwd log tags from a hook payload.
 *
 * Sanitizes both strings against log injection (embedded newlines could forge
 * fake log entries) and returns them as `[" session=<id>", " cwd=<path>"]` prefix
 * strings — empty string when the field is absent. The leading space means
 * callers can concatenate them directly without a join.
 */
function _build_handler_log_tags(payload: HookPayload): [string, string] {
  const payload_dict = payload !== null && typeof payload === "object" && !Array.isArray(payload) ? payload : {};
  const session_id = typeof payload_dict.session_id === "string" ? payload_dict.session_id : "";
  const cwd = typeof payload_dict.cwd === "string" ? payload_dict.cwd : "";
  const safe_session = session_id ? sanitize_log_str(session_id.slice(0, 16)) : "";
  const safe_cwd = cwd ? sanitize_log_str(cwd) : "";
  const session_tag = safe_session ? ` session=${safe_session}` : "";
  const cwd_tag = safe_cwd ? ` cwd=${safe_cwd}` : "";
  return [session_tag, cwd_tag];
}

/** A hook handler: takes a payload, returns a response (sync or async). */
export type HookHandler = (payload: HookPayload) => HookResponse | Promise<HookResponse>;

/**
 * Decorator: wrap a hook handler to never raise or crash the harness.
 *
 * CRITICAL INVARIANT: A broken token-goat hook must NEVER interrupt the agent's
 * work. This wrapper guarantees:
 *   1. Returns {"continue": true} even if the handler raises/crashes.
 *   2. Logs the exception without surfacing it to the caller.
 *   3. The process is never failed by a handler error.
 *
 * Used on all hook handlers to ensure harness resilience.
 *
 * The returned wrapper is ASYNC so it can `await` handlers that are themselves
 * async while still catching synchronous throws (await of a sync return is a
 * no-op). The Python original was sync because Python handlers are sync; the TS
 * port awaits to support both sync and async handlers uniformly (the dispatcher
 * awaits the result either way).
 */
export function fail_soft(handler: HookHandler): HookHandler {
  const wrapper = async (payload: HookPayload): Promise<HookResponse> => {
    try {
      return await handler(payload);
    } catch (exc) {
      // Broadened to catch every thrown value (the analogue of Python widening
      // Exception → BaseException so MemoryError and friends also honour the
      // fail-soft contract). KeyboardInterrupt / SystemExit have no JS analogue.
      const handler_name = _functionName(handler);
      const excName = exc instanceof Error ? exc.constructor.name : "Error";
      const excMsg = exc instanceof Error ? exc.message : String(exc);
      const err_summary = `${excName}: ${excMsg}`;
      const [session_tag, cwd_tag] = _build_handler_log_tags(payload);
      try {
        _LOG.error(
          "hook handler crashed: handler=%s%s%s error=%s",
          handler_name,
          session_tag,
          cwd_tag,
          err_summary,
        );
      } catch {
        // swallow
      }
      // Return a safe CONTINUE-shaped response with diagnostic fields attached.
      const err_response: HookResponse = {
        continue: true,
        _tg_error: err_summary,
        _tg_handler: handler_name,
      };
      return err_response;
    }
  };
  // Preserve the wrapped handler's name so the crash log / _tg_handler field
  // matches what Python's functools.wraps surfaced.
  try {
    Object.defineProperty(wrapper, "name", { value: _functionName(handler), configurable: true });
  } catch {
    // name is non-configurable on some runtimes — best-effort.
  }
  return wrapper;
}

/** Best-effort function name (Python getattr(handler, "__name__", repr(handler))). */
function _functionName(fn: unknown): string {
  if (typeof fn === "function" && typeof fn.name === "string" && fn.name !== "") {
    return fn.name;
  }
  return String(fn);
}

// Hook submodules are imported on first dispatch, not at module load time. Each
// event needs only one submodule, so a Bash tool call that triggers `pre-read`
// should never pay the import cost of `hooks_session` or `hooks_fetch`.
// `_HANDLER_LOOKUP` maps event names to `[submodule_name, attr_name]` pairs;
// `_resolve_handler` imports the submodule on demand and wraps the bare handler
// in `fail_soft`. The wrapped handler is cached so the import is paid at most
// once per process.
//
// Derived from hook_registry — the single source of truth for hook event names,
// handler modules, and CLI wiring. Adding a new event only requires editing
// hook_registry.HOOK_EVENTS.
export const _HANDLER_LOOKUP: Record<string, [string, string]> = hook_registry.handler_lookup();

export const _HANDLER_CACHE = new Map<string, HookHandler>();

/**
 * Lazy loaders for the Layer-5 handler modules, keyed by the module name that
 * hook_registry.handler_lookup() returns. Each value is a thunk over a
 * dynamic `import()` with a STATIC LITERAL specifier — still deferred (so
 * importing hooks_cli never eagerly pulls in hooks_read/session/etc. + their
 * heavy deps), but statically analyzable, so esbuild bundles each module and
 * rewrites the import to the bundled copy. A COMPUTED specifier
 * (`import(`./${name}.js`)`) is NOT bundleable: under esbuild it stays a
 * runtime path import that resolves to a sibling `./hooks_read.js` file which
 * does not exist in a single-file bundle → "Module not found in bundle" →
 * every hook silently no-ops. An unknown module name (the tests repoint a
 * lookup at a bogus module) is absent here → treated as an import failure
 * (null, uncached), preserving the fail-soft contract.
 */
const _HANDLER_MODULE_LOADERS: Record<string, () => Promise<Record<string, unknown>>> = {
  hooks_session: () => import("./hooks_session.js") as Promise<Record<string, unknown>>,
  hooks_read: () => import("./hooks_read.js") as Promise<Record<string, unknown>>,
  hooks_edit: () => import("./hooks_edit.js") as Promise<Record<string, unknown>>,
  hooks_skill: () => import("./hooks_skill.js") as Promise<Record<string, unknown>>,
  hooks_fetch: () => import("./hooks_fetch.js") as Promise<Record<string, unknown>>,
};

/**
 * Return the `fail_soft`-wrapped handler for *event*, importing it lazily.
 *
 * Returns null (not throws) on import or attribute errors so the dispatcher can
 * fall through to the CONTINUE safety net rather than surfacing an unhandled
 * ImportError/AttributeError to the caller.
 *
 * ASYNC because dynamic import() returns a Promise. The handler submodules
 * (hooks_session/edit/skill/fetch/read) are NOT YET PORTED (Layer 5); the
 * dynamic import("./<mod>.js") therefore currently rejects, this returns null,
 * and the lazy proxy degrades the event to continue:true. A failed import is NOT
 * cached, so a later retry (after the module lands) can succeed — matching the
 * Python contract the tests assert.
 */
export async function _resolve_handler(event: string): Promise<HookHandler | null> {
  const cached = _HANDLER_CACHE.get(event);
  if (cached !== undefined) {
    return cached;
  }
  const lookup = _HANDLER_LOOKUP[event];
  if (lookup === undefined) {
    return null;
  }
  const [submodule_name, attr_name] = lookup;
  let bare_handler: HookHandler;
  try {
    // Look the loader up by module name (static-literal import thunks, see
    // _HANDLER_MODULE_LOADERS). Keeps Layer-5 handlers out of the eager
    // dependency graph AND lets a missing/unknown module fail soft instead of
    // crashing module load — while staying bundleable (no computed specifier).
    const loader = _HANDLER_MODULE_LOADERS[submodule_name];
    if (loader === undefined) {
      throw new Error(`unknown handler module ${submodule_name}`);
    }
    const submodule = await loader();
    const candidate = submodule[attr_name];
    if (typeof candidate !== "function") {
      throw new Error(`module ${submodule_name} has no attribute ${attr_name}`);
    }
    bare_handler = candidate as HookHandler;
  } catch (exc) {
    _LOG.error(
      "_resolve_handler: failed to load %s.%s for event %s: %s",
      submodule_name,
      attr_name,
      JSON.stringify(event),
      String(exc),
    );
    return null;
  }
  const wrapped = fail_soft(bare_handler);
  _HANDLER_CACHE.set(event, wrapped);
  return wrapped;
}

/**
 * Lazily resolve a handler by its Python typer-func attribute name (e.g.
 * "session_start", "pre_read").
 *
 * Python exposed these via module-level __getattr__ so `hooks_cli.session_start`
 * resolved through `_resolve_handler`. ES modules cannot intercept attribute
 * access, so the equivalent is this async accessor: callers that did
 * `hooks_cli.pre_read` use `await getLazyAttr("pre_read")`. Returns null when the
 * name is unknown or its submodule fails to import (fail-soft).
 */
export async function getLazyAttr(name: string): Promise<HookHandler | null> {
  // Derived from hook_registry so this map stays in sync with _HANDLER_LOOKUP
  // automatically.
  const event_map = hook_registry.lazy_attr_map();
  const event = event_map[name];
  if (event === undefined) {
    return null;
  }
  return _resolve_handler(event);
}

// --- dispatcher entry point used by cli.ts ---

// Default TTL for the compact-skip sentinel. The runtime value can be tuned via
// `[compact_assist] compact_skip_ttl_secs` — see config.CompactAssistConfig. The
// constant is preserved as the fall-back used when config has not been loaded yet
// (e.g. test paths that exercise `_check_compact_skip_sentinel` directly without
// going through `pre_compact`).
export const _COMPACT_SKIP_TTL_SECS = 300.0; // 5 minutes

/**
 * Return the active TTL for the compact-skip sentinel.
 *
 * Resolves from `[compact_assist] compact_skip_ttl_secs` when the config module
 * is importable, falling back to `_COMPACT_SKIP_TTL_SECS` otherwise. Wrapped in a
 * broad try/catch because this helper is called on the hot sentinel-fast-path: a
 * config load failure must never crash the hook, and a sane default is always
 * preferable to falling through to the slow path on a transient TOML parse error.
 *
 * Exposed as an object with a `value()` method (NOT a bare function) so a test
 * can do the equivalent of Python's
 * `patch.object(hc, "_compact_skip_ttl_secs", return_value=300.0)` by spying on
 * `_compact_skip_ttl_secs.value`. The default export name stays snake_case.
 */
function _compact_skip_ttl_secs_impl(): number {
  try {
    const ttl = Number(config.load().compact_assist?.compact_skip_ttl_secs);
    // mirror validator clamp; reject NaN/inf via comparison (NaN fails both).
    if (ttl > 0.0 && ttl <= 3600.0) {
      return ttl;
    }
  } catch {
    // swallow
  }
  return _COMPACT_SKIP_TTL_SECS;
}

/**
 * Callable holder for the compact-skip TTL. Call `_compact_skip_ttl_secs()` to
 * read the value; tests override `_compact_skip_ttl_secs.value` to stub it
 * (the analogue of monkeypatching the Python function).
 */
export const _compact_skip_ttl_secs: { (): number; value: () => number } = Object.assign(
  (): number => _compact_skip_ttl_secs.value(),
  { value: _compact_skip_ttl_secs_impl },
);

/**
 * Lightweight result object returned by `_check_compact_skip_sentinel_detail`.
 *
 * Fields:
 *   should_skip: True when the sentinel is fresh and the hook should short-circuit.
 *   reason:      Human-readable skip reason string, or "" when not skipping.
 *                Possible values:
 *                - "ttl_not_expired"  — sentinel is fresh and within TTL
 *                - "fingerprint_match" — (reserved; currently unused by the
 *                                          mtime-based sentinel, kept for forward
 *                                          compatibility)
 *                - "noop_session"     — session has zero activity
 *                - ""                  — sentinel is absent or busted
 *   age_secs:    Age of the sentinel file in seconds (0.0 when no sentinel).
 *
 * Python defined `__bool__` so `if _check_compact_skip_sentinel(...)` worked; in
 * TS the boolean-coercion sites read `.should_skip` explicitly (JS truthiness of
 * any object instance is always true), so callers must not rely on truthiness of
 * the instance — they read `should_skip`.
 */
export class _SkipResult {
  readonly should_skip: boolean;
  readonly reason: string;
  readonly age_secs: number;
  constructor(should_skip: boolean, reason: string, age_secs: number) {
    this.should_skip = should_skip;
    this.reason = reason;
    this.age_secs = age_secs;
  }
}

/**
 * Read the `edited_count` and `bash_count` stored in *sentinel_path*.
 *
 * The sentinel file is JSON when written by `_write_compact_skip_sentinel`.
 * Legacy sentinels written by touch() (empty or non-JSON) return [null, null] —
 * the caller treats null as "no count available" and skips the count-comparison
 * gate.
 *
 * Returns [edited_count, bash_count] as integers, or [null, null] on any parse
 * error.
 *
 * @param sentinel_path Absolute sentinel-file path. Typed `string` (Python
 *   accepted `object`/Path; the caller always passes the resolved path string).
 */
export function _read_sentinel_counts(sentinel_path: string): [number | null, number | null] {
  try {
    const raw = fs.readFileSync(sentinel_path, "utf8").trim();
    if (raw === "") {
      return [null, null];
    }
    const data = JSON.parse(raw) as Record<string, unknown>;
    const edited = data["edited_count"];
    const bash = data["bash_count"];
    if (Number.isInteger(edited) && Number.isInteger(bash)) {
      return [edited as number, bash as number];
    }
  } catch {
    // swallow
  }
  return [null, null];
}

/**
 * Return [edited_count, bash_count] for *session_id* from the session JSON.
 *
 * Loads the session cache at the JSON level (no heavy deserialization) to extract
 * the two count fields. Returns [0, 0] on any load failure so the count
 * comparison always has a baseline.
 *
 * This function is called on the sentinel hot-path; it reads one JSON file and
 * does minimal work — no DB, no tree-sitter, no embeddings.
 */
export function _current_session_counts(session_id: string): [number, number] {
  try {
    const session_file = paths.sessionCachePath(session_id);
    const raw = fs.readFileSync(session_file, "utf8");
    const data = JSON.parse(raw) as Record<string, unknown>;
    const edited = data["edited_files"];
    const bash = data["bash_history"];
    const edited_count = _isPlainObject(edited) ? Object.keys(edited).length : 0;
    const bash_count = _isPlainObject(bash) ? Object.keys(bash).length : 0;
    return [edited_count, bash_count];
  } catch {
    return [0, 0];
  }
}

/**
 * Return True if a fresh compact-skip sentinel exists for *session_id*.
 *
 * This is the legacy boolean interface; it delegates to
 * `_check_compact_skip_sentinel_detail` and returns only the `should_skip` flag.
 * New code should use the detail variant.
 */
export function _check_compact_skip_sentinel(session_id: string): boolean {
  return _check_compact_skip_sentinel_detail(session_id).should_skip;
}

/**
 * Return a `_SkipResult` describing whether and why the sentinel is fresh.
 *
 * Reads only `paths` on the fast path — no other token_goat module is touched
 * when the sentinel is absent or stale. The sentinel is considered fresh when all
 * of the following hold:
 *
 *   1. TTL: sentinel age is within the configured TTL (default 300 s).
 *   2. Activity floor (mtime): session JSON mtime is not newer than the sentinel
 *      mtime (guards against edits that occurred after the sentinel write).
 *   3. Activity floor (counts): the session's current edited_count and bash_count
 *      match the values stored inside the sentinel JSON. If the session has more
 *      edits or bash commands than when the sentinel was written it means real
 *      work happened, and the manifest should be regenerated. Sentinels written
 *      by older code (no JSON content) skip this check so the upgrade is
 *      backwards-compatible.
 *
 * Negative-age defence: if the sentinel mtime is in the future (clock skew, NTP
 * step, manually edited file), log a warning and return a not-skipping result so
 * the slow path rebuilds the manifest.
 *
 * Any filesystem error (missing file, permission denied, stat failure) returns a
 * not-skipping result so the normal path runs.
 */
export function _check_compact_skip_sentinel_detail(session_id: string): _SkipResult {
  let sentinel: string;
  try {
    sentinel = paths.compactSkipSentinelPath(session_id);
  } catch {
    // Bad session_id (path traversal etc.) → Python's ValueError branch.
    return new _SkipResult(false, "", 0.0);
  }
  let sentinel_mtime: number;
  try {
    // Floor mtimeMs to whole milliseconds so it shares the resolution of
    // nowSeconds() (Date.now()/1000, integer ms). fs preserves sub-ms mtime but
    // Date.now() floors to ms; without this a just-written sentinel can read as a
    // few tenths of a millisecond "in the future", yielding a tiny negative age.
    // Python compares time.time() and st_mtime at equal (sub-ms) precision, so it
    // never goes negative here; matching resolutions reproduces that invariant.
    sentinel_mtime = Math.floor(fs.statSync(sentinel).mtimeMs) / 1000;
  } catch {
    return new _SkipResult(false, "", 0.0);
  }

  const now = nowSeconds();
  const age = now - sentinel_mtime;
  if (age < -1.0) {
    // Future-dated sentinel: genuine clock skew (NTP step, manual edit, or stale
    // file from another machine). Sub-second negative ages are normal Windows
    // filesystem/wall-clock jitter and are treated as age ~= 0.
    _LOG.warning(
      "compact-skip sentinel mtime is in the future session=%s skew=%ss" +
        " — ignoring sentinel, falling back to full pre-compact path",
      session_id.slice(0, 16),
      (-age).toFixed(0),
    );
    return new _SkipResult(false, "", 0.0);
  }
  if (age >= _compact_skip_ttl_secs()) {
    _LOG.debug(
      "compact-skip sentinel expired session=%s age=%ss ttl=%ss",
      session_id.slice(0, 16),
      age.toFixed(0),
      _compact_skip_ttl_secs().toFixed(0),
    );
    return new _SkipResult(false, "", age);
  }

  // Activity floor (mtime): any session-state update since the sentinel was
  // written should bust the cache.
  let session_file: string;
  try {
    session_file = paths.sessionCachePath(session_id);
  } catch {
    // Bad session_id (path traversal etc.) — no manifest to be had.
    return new _SkipResult(true, "ttl_not_expired", age);
  }
  let session_mtime: number;
  try {
    session_mtime = fs.statSync(session_file).mtimeMs / 1000;
  } catch {
    // No session file → nothing to invalidate against. Skip is safe.
    return new _SkipResult(true, "ttl_not_expired", age);
  }

  // +2.0 s grace handles the case where the sentinel was written immediately
  // after a session save in the same hook firing — filesystem mtime resolution
  // on Windows (FAT/exFAT) is 2 s; on NTFS/ext4 it is ~ns.
  if (session_mtime > sentinel_mtime + 2.0) {
    _LOG.debug(
      "compact-skip sentinel busted by mtime activity session=%s" +
        " (session_mtime=%s > sentinel_mtime=%s)",
      session_id.slice(0, 16),
      session_mtime.toFixed(3),
      sentinel_mtime.toFixed(3),
    );
    return new _SkipResult(false, "", age);
  }

  // Activity floor (counts): read edited_count + bash_count from the sentinel
  // JSON and compare against the live session. A count increase since the
  // sentinel was written means real work happened regardless of mtime resolution.
  const [sentinel_edited, sentinel_bash] = _read_sentinel_counts(sentinel);
  if (sentinel_edited !== null && sentinel_bash !== null) {
    const [current_edited, current_bash] = _current_session_counts(session_id);
    if (current_edited > sentinel_edited || current_bash > sentinel_bash) {
      _LOG.debug(
        "compact-skip sentinel busted by count increase session=%s" + " edited=%d->%d bash=%d->%d",
        session_id.slice(0, 16),
        sentinel_edited,
        current_edited,
        sentinel_bash,
        current_bash,
      );
      return new _SkipResult(false, "", age);
    }
  }

  _LOG.debug(
    "compact-skip sentinel fresh session=%s age=%ss reason=ttl_not_expired",
    session_id.slice(0, 16),
    age.toFixed(0),
  );
  return new _SkipResult(true, "ttl_not_expired", age);
}

/**
 * Write the compact-skip sentinel for *session_id* with activity counts.
 *
 * Stores `edited_count` and `bash_count` inside the sentinel so
 * `_check_compact_skip_sentinel_detail` can detect activity that happened after
 * the sentinel was written even when the session file's mtime resolution is
 * coarse (FAT32: 2 s).
 *
 * Creates the `compact_skip/` directory as needed. Errors are silently swallowed
 * — a failure to write the sentinel only means the next call pays the full import
 * cost instead of taking the fast path; the hook still returns
 * {"continue": true} correctly.
 */
export function _write_compact_skip_sentinel(
  session_id: string,
  opts: { edited_count?: number; bash_count?: number } = {},
): void {
  const edited_count = opts.edited_count ?? 0;
  const bash_count = opts.bash_count ?? 0;
  try {
    const sentinel = paths.compactSkipSentinelPath(session_id);
    paths.ensureDir(dirname(sentinel));
    // Python json.dumps(separators=(",", ":")) — JSON.stringify is already
    // separator-compact (no spaces).
    const payload = JSON.stringify({ edited_count, bash_count });
    paths.atomicWriteText(sentinel, payload);
  } catch {
    // swallow
  }
}

/**
 * Write a JSON sentinel with the bytes estimate for the pre-compact session.
 *
 * Called from `pre_compact` immediately after the session cache is loaded — at
 * that point `bash_history` and `web_history` still hold the pre-compaction data.
 * After compaction the agent may start a *new* session so the post-compact
 * SessionStart handler cannot reconstruct this estimate from the (empty) new
 * session cache.
 *
 * The sentinel is keyed by the *pre-compact* session ID. The
 * `_try_recovery_response` function in hooks_session looks for the most recently
 * written sentinel so it works even when the session ID changes after compaction.
 *
 * Errors are silently swallowed — this is advisory telemetry only.
 */
export function _write_precompact_estimate(session_id: string, cache: unknown): void {
  try {
    const bash_hist = (_getAttr(cache, "bash_history") as Record<string, unknown> | null) ?? {};
    const web_hist = (_getAttr(cache, "web_history") as Record<string, unknown> | null) ?? {};
    let bytes_estimate = 0;
    for (const be of Object.values(bash_hist)) {
      bytes_estimate += (_numAttr(be, "stdout_bytes") ?? 0) + (_numAttr(be, "stderr_bytes") ?? 0);
    }
    for (const we of Object.values(web_hist)) {
      bytes_estimate += _numAttr(we, "body_bytes") ?? 0;
    }
    const payload = JSON.stringify({
      bytes_estimate: Math.max(0, bytes_estimate),
      bash_count: Object.keys(bash_hist).length,
      web_count: Object.keys(web_hist).length,
      session_id,
      ts: nowSeconds(),
    });
    const sentinel = paths.precompactEstimatePath(session_id);
    paths.ensureDir(dirname(sentinel));
    paths.atomicWriteText(sentinel, payload);
    _LOG.debug(
      "pre-compact: wrote estimate sentinel session=%s bytes=%d bash=%d web=%d",
      session_id.slice(0, 16),
      Math.max(0, bytes_estimate),
      Object.keys(bash_hist).length,
      Object.keys(web_hist).length,
    );
  } catch {
    _LOG.debug("pre-compact: estimate sentinel write failed");
  }
}

/**
 * Return True when the session has no meaningful activity worth manifesting.
 *
 * A session is a noop when ALL of the following hold:
 *   - zero edited files
 *   - zero bash commands
 *   - zero symbols accessed (all file entries have empty `symbols_read`)
 *
 * This is the cheapest possible check: three attribute reads and a loop over what
 * is usually an empty dict. Called before any heavy manifest rendering so the
 * PreCompact hook can skip even the manifest fingerprint computation.
 */
export function _is_noop_session(cache: unknown): boolean {
  const edited = (_getAttr(cache, "edited_files") as Record<string, unknown> | null) ?? {};
  if (Object.keys(edited).length > 0) {
    return false;
  }
  const bash = (_getAttr(cache, "bash_history") as Record<string, unknown> | null) ?? {};
  if (Object.keys(bash).length > 0) {
    return false;
  }
  const files = (_getAttr(cache, "files") as Record<string, unknown> | null) ?? {};
  for (const entry of Object.values(files)) {
    const syms = _getAttr(entry, "symbols_read");
    if (syms !== null && syms !== undefined && (Array.isArray(syms) ? syms.length > 0 : Boolean(syms))) {
      return false;
    }
  }
  return true;
}

/**
 * PreCompact hook: inject a session manifest as systemMessage before compaction.
 *
 * The compaction LLM receives the manifest in its context and includes it in the
 * summary, so edited files and accessed symbols survive the compaction.
 * Configurable via config [compact_assist] or TOKEN_GOAT_COMPACT_ASSIST=0.
 *
 * Fast path: when a fresh compact-skip sentinel exists for this session (written
 * on a previous call that determined the session had too little activity to
 * warrant a manifest), return immediately without importing any heavy modules.
 *
 * LAYER-4 GATING: the heavy manifest-budget path calls the compact module
 * (merge_session_manifests / compute_adaptive_budget / build_manifest_with_count
 * / write_session_manifest / get_auto_trigger_multiplier / estimate_tokens),
 * which is NOT YET PORTED. compact is loaded via a fail-soft dynamic import; when
 * it is absent (the import rejects) the heavy path no-ops to CONTINUE() while the
 * self-contained sentinel fast-path above still works. When compact.ts lands the
 * full path activates with no further change here. Reported in known_gaps.
 *
 * ASYNC because it awaits the dynamic compact import (and is awaited by dispatch).
 */
async function _pre_compact_impl(payload: HookPayload): Promise<HookResponse> {
  // --- Sentinel fast-path (before any heavy imports) ---
  const session_id = payload.session_id;
  if (session_id) {
    const skip_result = _check_compact_skip_sentinel_detail(String(session_id));
    if (skip_result.should_skip) {
      _LOG.debug(
        "pre-compact: sentinel fast-path session=%s reason=%s age=%ss",
        String(session_id).slice(0, 16),
        skip_result.reason,
        skip_result.age_secs.toFixed(0),
      );
      return CONTINUE();
    }
  }

  // compact is Layer 4 (not ported). Load it fail-soft: when the import rejects,
  // compact_mod is null and every heavy path below short-circuits to CONTINUE so
  // the dispatcher never crashes on a Layer-5/PreCompact event.
  const compact_mod = await _loadCompactModule();

  let cfg: NonNullable<ReturnType<typeof config.load>["compact_assist"]>;
  try {
    cfg = config.load().compact_assist ?? {};
  } catch {
    cfg = {};
  }
  if (!(cfg.enabled ?? false)) {
    if (session_id) {
      _write_compact_skip_sentinel(String(session_id));
    }
    return CONTINUE();
  }

  const trigger_raw = payload.trigger ?? "manual";
  const trigger = trigger_raw !== null && trigger_raw !== undefined ? String(trigger_raw) : "manual";
  const triggers = cfg.triggers ?? [];
  if (triggers.length === 0 || !triggers.includes(trigger)) {
    _LOG.info("pre-compact: skipping (trigger=%s not in %s)", sanitize_log_str(trigger), JSON.stringify(triggers));
    if (session_id) {
      _write_compact_skip_sentinel(String(session_id));
    }
    return CONTINUE();
  }

  if (!session_id) {
    return CONTINUE();
  }

  // Beyond this point the heavy path needs the compact module. When it is not
  // yet ported, no-op to CONTINUE (the sentinel was not written — the next
  // PreCompact re-checks once compact lands).
  if (compact_mod === null) {
    _LOG.debug("pre-compact: compact module not yet ported; skipping manifest path (Layer 4 pending)");
    return CONTINUE();
  }

  const session_cache = session.safe_load(String(session_id), { caller: "pre-compact" });
  if (session_cache === null) {
    _write_compact_skip_sentinel(String(session_id));
    return CONTINUE();
  }

  // --- Cross-session manifest deduplication ---
  // Write this session's file coverage so concurrent sessions can read it, then
  // merge all live session manifests to avoid duplicating coverage when two
  // agent windows work on the same project simultaneously.
  const cwd = payload.cwd;
  if (cwd) {
    try {
      const _proj_hash = project.project_hash(project.canonicalize(String(cwd)));
      const _session_files: Array<Record<string, unknown>> = [];
      const filesMap = (_getAttr(session_cache, "files") as Record<string, unknown> | null) ?? {};
      for (const e of Object.values(filesMap)) {
        const rel = _getAttr(e, "rel_or_abs");
        if (rel) {
          _session_files.push({
            rel_path: rel,
            hit_count: _getAttr(e, "read_count"),
            last_read_ts: _getAttr(e, "last_read_ts"),
          });
        }
      }
      compact_mod.write_session_manifest(_proj_hash, String(session_id), {
        session_id: String(session_id),
        files: _session_files,
        updated_at: nowSeconds(),
      });
      const _all_manifests = compact_mod.read_all_session_manifests(_proj_hash);
      const _merged = compact_mod.merge_session_manifests(_all_manifests, 200);
      const _current_files: Record<string, unknown> =
        (_getAttr(session_cache, "files") as Record<string, unknown> | null) ?? {};
      for (const _mentry of _merged as Array<Record<string, unknown>>) {
        const _rel = (_mentry["rel_path"] as string | undefined) ?? "";
        if (_rel && !(_rel in _current_files)) {
          _current_files[_rel] = new session.FileEntry({
            rel_or_abs: _rel,
            last_read_ts: Number(_mentry["last_read_ts"] ?? 0.0),
            read_count: Math.trunc(Number(_mentry["hit_count"] ?? 1)),
            line_ranges: [],
            symbols_read: [],
          });
        }
      }
      (session_cache as { files: Record<string, unknown> }).files = _current_files;
    } catch {
      _LOG.debug("pre-compact: cross-session dedup failed");
    }
  }

  // --- Noop session fast-path ---
  // If the session has zero edits, zero bash commands, and zero symbols accessed
  // there is nothing worth preserving. Skip manifest construction entirely and
  // write the sentinel with current counts so the next PreCompact doesn't have to
  // re-check.
  //
  // Guard: only apply when min_events >= 1. When min_events is 0 the caller
  // explicitly requested "always run"; skip the noop gate so test code that uses
  // min_events=0 with mock sessions still reaches build_manifest_with_count.
  if ((cfg.min_events ?? 0) >= 1 && _is_noop_session(session_cache)) {
    _LOG.debug(
      "pre-compact: skipping — noop session (no edits, no bash, no symbols) session=%s",
      String(session_id).slice(0, 16),
    );
    _write_compact_skip_sentinel(String(session_id), { edited_count: 0, bash_count: 0 });
    return CONTINUE();
  }

  // Write the pre-compact bytes estimate sentinel so the post-compact
  // SessionStart handler can read it when building the recovery_pending sidecar.
  _write_precompact_estimate(String(session_id), session_cache);

  // Compute adaptive budget based on session complexity.
  const created_ts = _numAttr(session_cache, "created_ts") ?? 0;
  const age_seconds = nowSeconds() - created_ts;
  const base_tokens = compact_mod.compute_adaptive_budget(session_cache, age_seconds);
  _LOG.debug("pre-compact: adaptive budget computed from session complexity: %d tokens", base_tokens);

  // Pressure-aware sizing multiplier: auto-triggered compaction means the agent's
  // context is near-full and the harness is forced to compact. A larger manifest
  // at that moment is net-positive — every preserved fact saves a subsequent
  // re-read. Manual /compact, by contrast, fires while the agent still has
  // headroom, so we skip the multiplier to avoid wasting tokens.
  const multiplier = compact_mod.get_auto_trigger_multiplier(cfg.auto_trigger_multiplier);
  let pre_clamp_tokens: number;
  if (trigger === "auto" && multiplier > 1.0) {
    pre_clamp_tokens = Math.trunc(base_tokens * multiplier);
    _LOG.info(
      "pre-compact: auto-trigger detected — boosting manifest budget %d -> %d (x%s)",
      base_tokens,
      pre_clamp_tokens,
      multiplier.toFixed(2),
    );
  } else {
    pre_clamp_tokens = base_tokens;
  }

  // Hard ceiling: prevent unbounded manifests. Clamp to either config max or
  // 1200, whichever is configured. Adaptive budget already returns [200, 800], so
  // this only caps the multiplier-amplified value.
  const hard_max = Math.max(cfg.max_manifest_tokens ?? 0, 1200);
  const effective_tokens = Math.min(pre_clamp_tokens, hard_max);

  const _manifest_t0 = _monotonicMs();
  const [manifest, n_events] = compact_mod.build_manifest_with_count(String(session_id), effective_tokens);
  const _manifest_ms = _monotonicMs() - _manifest_t0;
  const _manifest_tokens = manifest ? compact_mod.estimate_tokens(manifest) : 0;
  _LOG.debug("pre-compact: built manifest in %sms (%d tokens)", _manifest_ms.toFixed(0), _manifest_tokens);

  // Compute counts once for sentinel writes below.
  const _sentinel_edited = Object.keys(
    (_getAttr(session_cache, "edited_files") as Record<string, unknown> | null) ?? {},
  ).length;
  const _sentinel_bash = Object.keys(
    (_getAttr(session_cache, "bash_history") as Record<string, unknown> | null) ?? {},
  ).length;

  if (n_events < (cfg.min_events ?? 0)) {
    _LOG.info("pre-compact: skipping manifest (events=%d < min=%d)", n_events, cfg.min_events ?? 0);
    _write_compact_skip_sentinel(String(session_id), { edited_count: _sentinel_edited, bash_count: _sentinel_bash });
    return CONTINUE();
  }

  if (!manifest) {
    _LOG.debug(
      "pre-compact: manifest builder returned empty string (events=%d session=%s); skipping injection",
      n_events,
      String(session_id).slice(0, 16),
    );
    _write_compact_skip_sentinel(String(session_id), { edited_count: _sentinel_edited, bash_count: _sentinel_bash });
    return CONTINUE();
  }

  _LOG.info(
    "pre-compact: injecting manifest (%d chars, trigger=%s, events=%d)",
    manifest.length,
    sanitize_log_str(trigger),
    n_events,
  );

  // Manifest-budget envelope telemetry: record an informational stat row
  // capturing budget vs. realised token cost. Best-effort — a stat-write failure
  // never blocks the manifest injection.
  try {
    const actual_tokens = compact_mod.estimate_tokens(manifest);
    const detail = `budget=${effective_tokens},actual=${actual_tokens},trigger=${trigger},events=${n_events}`;
    db.recordStat(undefined, "compact_manifest", { tokensSaved: 0, bytesSaved: 0, detail });
  } catch {
    _LOG.debug("pre-compact: telemetry record failed");
  }

  // Reset context-growth tracking so threshold advisories restart cleanly in the
  // post-compact session (the cache is preserved across compaction).
  try {
    (session_cache as { turns_since_last_compact: number }).turns_since_last_compact = 0;
    (session_cache as { last_context_advisory_threshold: number | null }).last_context_advisory_threshold = null;
    // Snapshot the current pressure total as the new baseline. After this point
    // get_context_pressure subtracts it, so the fill fraction measures only
    // incremental load since this compaction — preventing the session from being
    // permanently pinned to "critical" for its entire remaining life.
    (session_cache as { pressure_baseline_tokens: number }).pressure_baseline_tokens =
      compact_mod._pressure_raw_total(session_cache);
    session.save(session_cache);
    // Stamp last_compact_ts via the canonical helper so pre_read can suppress
    // "already in context" hints for files whose content is gone post-compact.
    session.record_compact(String(session_id));
  } catch {
    _LOG.debug("pre-compact: context tracking reset failed");
  }

  return { continue: true, systemMessage: manifest };
}

/**
 * The PreCompact handler, wrapped in `fail_soft` (Python applied `@fail_soft`).
 * Exposed under the verbatim Python name `pre_compact`.
 */
export const pre_compact: HookHandler = fail_soft(_pre_compact_impl);

/**
 * Minimal duck-typed surface of the (not-yet-ported) compact module that
 * pre_compact reaches into. When compact.ts lands it must export these names with
 * compatible signatures. Until then `_loadCompactModule()` returns null and the
 * heavy path no-ops.
 */
interface CompactModule {
  write_session_manifest(projHash: string, sessionId: string, manifest: Record<string, unknown>): void;
  read_all_session_manifests(projHash: string): Array<Record<string, unknown>>;
  merge_session_manifests(manifests: Array<Record<string, unknown>>, budgetTokens: number): Array<Record<string, unknown>>;
  compute_adaptive_budget(cache: unknown, ageSeconds: number): number;
  get_auto_trigger_multiplier(configExplicitMultiplier: number | undefined): number;
  build_manifest_with_count(sessionId: string, maxTokens: number): [string, number];
  estimate_tokens(text: string): number;
  _pressure_raw_total(cache: unknown): number;
}

/**
 * Load the compact module fail-soft. Returns null when it is not yet ported (the
 * dynamic import rejects) so pre_compact's heavy path can no-op to CONTINUE.
 */
async function _loadCompactModule(): Promise<CompactModule | null> {
  try {
    // The specifier is built from a variable (not a string literal) so the TS
    // compiler does not try to statically resolve ./compact.js — which does not
    // exist yet (Layer 4) and would otherwise raise TS2307 at build time. At
    // runtime the import rejects (module absent) and we return null. When
    // compact.ts lands this resolves and the heavy path activates unchanged.
    const spec = `./${_COMPACT_MODULE_NAME}.js`;
    return (await import(spec)) as unknown as CompactModule;
  } catch {
    return null;
  }
}

/** Submodule basename for the compact module (kept as a var so the dynamic
 *  import specifier is computed, not a literal tsc would resolve). */
const _COMPACT_MODULE_NAME = "compact";

/**
 * Return a tiny proxy that resolves and calls the real handler lazily.
 *
 * Storing these proxies in `EVENTS` (a plain Map) keeps the public
 * `hooks_cli.EVENTS` interface compatible with per-test mutation (the analogue of
 * mock.patch.dict) and any `EVENTS.get(event)` lookup, while still deferring the
 * submodule import until the *first call* of that proxy. After the first call the
 * resolved `fail_soft`-wrapped handler is cached in `_HANDLER_CACHE` so subsequent
 * dispatches incur only a Map lookup plus a function call.
 *
 * The proxy is ASYNC (it awaits `_resolve_handler`, which awaits the dynamic
 * import). dispatch awaits the proxy, so this composes cleanly.
 */
export function _make_lazy_proxy(event: string): HookHandler {
  const _proxy = async (payload: HookPayload): Promise<HookResponse> => {
    const handler = await _resolve_handler(event);
    if (handler === null) {
      return CONTINUE();
    }
    return handler(payload);
  };
  try {
    Object.defineProperty(_proxy, "name", {
      value: `_lazy_${event.replace(/-/g, "_")}`,
      configurable: true,
    });
  } catch {
    // best-effort
  }
  return _proxy;
}

/**
 * `EVENTS` is a Map for backwards compatibility (the analogue of Python's plain
 * dict + mock.patch.dict). Each value is a lazy proxy that imports its submodule
 * on first call; `pre-compact` is the exception — its handler lives in this
 * module directly, so we register the real (fail_soft-wrapped) function.
 *
 * Derived from hook_registry so adding a new event only requires editing one
 * place. Tests mutate this Map directly (set/restore in their teardown), the
 * analogue of monkeypatch.setitem(hooks_cli.EVENTS, ...).
 */
export const EVENTS = new Map<string, HookHandler>();
for (const name of Object.keys(_HANDLER_LOOKUP)) {
  EVENTS.set(name, _make_lazy_proxy(name));
}
EVENTS.set("pre-compact", pre_compact);

/**
 * Dispatch a hook event. Always returns at minimum {"continue": true}.
 *
 * ASYNC: the watchdog races the handler promise against a timeout timer with
 * Promise.race instead of Python's daemon-thread + join(timeout). If the timer
 * wins, the handler promise is orphaned (its own fail_soft / try-catch still
 * fires) and we return the watchdog-tripped CONTINUE — the faithful equivalent of
 * Python abandoning the join. If the handler wins, the timer is cleared and the
 * normal path runs.
 *
 * Running the handler on the main thread (not a worker isolate) is deliberate: it
 * is the only way the test suite's vi.spyOn mocks are visible to the handler, AND
 * the only way the AsyncLocalStorage hook context propagates into the handler's
 * awaits so get_hook_context_remaining_ms() works.
 */
export async function dispatch(event: string, payload: HookPayload): Promise<Record<string, unknown>> {
  _setup_logging();
  const safe_event = sanitize_log_str(event, 64);
  const handler = EVENTS.get(event);
  if (handler === undefined) {
    _LOG.warning("unknown hook event: %s", safe_event);
    return { ...CONTINUE() };
  }
  _LOG.debug("hook %s started", safe_event);
  const t0 = _monotonicMs();
  // Re-read the env on every dispatch (cheap) so operators can widen the budget
  // on slow boxes without restarting the agent.
  const watchdog_ms = _resolved_watchdog_ms();

  // Run the handler inside the AsyncLocalStorage hook context so DB layers and
  // other components can query the remaining watchdog budget across awaits. The
  // store is set for the whole handler run and torn down when the race resolves.
  let timer: ReturnType<typeof setTimeout> | undefined;
  const WATCHDOG = Symbol("tg-watchdog");

  const handlerPromise: Promise<Record<string, unknown>> = _hook_context.run(
    [t0, watchdog_ms, safe_event] as HookContext,
    async () => {
      try {
        // `await handler(payload)` handles both sync and async handlers. The
        // handler's own fail_soft (when present) still fires on the orphan path
        // if the watchdog wins — exactly as the Python daemon thread keeps
        // running its try/except after the join is abandoned.
        const local = await handler(payload);
        return { ...(local as Record<string, unknown>) };
      } catch (exc) {
        // Top-level safety net: catch throws from handlers whose fail_soft is
        // missing or ineffective (e.g. test injection). Return {} so the
        // setdefault below adds continue:true.
        _LOG.error("handler %s raised; relying on dispatcher safety net: %s", safe_event, String(exc));
        return {};
      }
    },
  );

  // The watchdog timer resolves to the WATCHDOG sentinel after the budget.
  const watchdogPromise: Promise<typeof WATCHDOG> = new Promise((resolve) => {
    timer = setTimeout(() => resolve(WATCHDOG), watchdog_ms);
    // Do not keep the event loop alive solely for this timer.
    if (typeof timer.unref === "function") {
      timer.unref();
    }
  });

  const winner = await Promise.race([handlerPromise, watchdogPromise]);

  if (winner === WATCHDOG) {
    _LOG.warning(
      "hook %s watchdog tripped after %sms — abandoning wait (handler continues in background)",
      safe_event,
      watchdog_ms.toFixed(0),
    );
    // Orphan the handler promise but keep its rejection from becoming an
    // unhandled-rejection warning (its fail_soft normally resolves it anyway).
    handlerPromise.catch(() => {});
    const watchdog_result: Record<string, unknown> = { ...CONTINUE() };
    watchdog_result["_tg_elapsed_ms"] = _round2(_monotonicMs() - t0);
    watchdog_result["_tg_watchdog_tripped"] = true;
    watchdog_result["_tg_watchdog_budget_ms"] = watchdog_ms;
    return watchdog_result;
  }

  // Handler won the race — clear the timer and take the normal path.
  if (timer !== undefined) {
    clearTimeout(timer);
  }
  const result: Record<string, unknown> = winner as Record<string, unknown>;
  const elapsed_ms = _monotonicMs() - t0;
  if (elapsed_ms >= _HOOK_SLOW_MS) {
    _LOG.warning("hook %s slow: %sms (check for blockage or I/O delays)", safe_event, elapsed_ms.toFixed(1));
  } else {
    const speed_tag = elapsed_ms >= _HOOK_MODERATE_MS ? "moderate" : "fast";
    _LOG.debug("hook %s completed in %sms (%s)", safe_event, elapsed_ms.toFixed(1), speed_tag);
  }
  result["_tg_elapsed_ms"] = _round2(elapsed_ms);
  // Top-level safety net: every valid hook response must carry {"continue": true}.
  // fail_soft already guarantees this on exception paths, but a handler that
  // returns an unexpected shape (e.g. empty dict, missing key) would otherwise
  // produce a response the harness cannot parse. Force the field to true so the
  // harness never blocks on a malformed-but-non-crashing handler return.
  if (!("continue" in result)) {
    result["continue"] = true;
  }
  return result;
}

// ---------------------------------------------------------------------------
// Small narrowing / arithmetic shims (no Python analogue).
// ---------------------------------------------------------------------------

/** Round to 2 decimal places (Python round(x, 2)). */
function _round2(x: number): number {
  return Math.round(x * 100) / 100;
}

/** True for a plain (non-array, non-null) object. */
function _isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * Read a property off an object-or-class-instance, returning undefined when the
 * holder is not an object. Mirrors Python's getattr(obj, name, None) for the
 * attribute reads pre_compact does on the session cache and its entries.
 */
function _getAttr(obj: unknown, name: string): unknown {
  if (obj !== null && typeof obj === "object") {
    return (obj as Record<string, unknown>)[name];
  }
  return undefined;
}

/** Read a numeric property, returning null when absent or non-numeric. */
function _numAttr(obj: unknown, name: string): number | null {
  const v = _getAttr(obj, name);
  return typeof v === "number" ? v : null;
}
