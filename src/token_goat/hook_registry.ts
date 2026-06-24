/**
 * Single source of truth for token-goat hook event registration.
 *
 * Faithful port of src/token_goat/hook_registry.py — a pure-data module with NO
 * token_goat dependencies. The Harness / ToolName / HookEvent SHAPES live in
 * ./types.js (import type only); this module owns the RUNTIME data: the
 * CANONICAL_TOOLS set, the HOOK_EVENTS rows table, the harness-derivation
 * property, and the derived-table helpers.
 *
 * Why this module exists (carried over from the Python docstring)
 * ---------------------------------------------------------------
 * Hook events used to be declared in five independent tables (install's two
 * wire-format blocks, hooks_cli's _HANDLER_LOOKUP + EVENTS + __getattr__ map),
 * plus the per-event decorators in cli.py. Adding an event meant editing six
 * places, and two incidents shipped with mismatched tables. This module is now
 * the canonical definition; install, hooks_cli, and cli all derive their tables
 * from HOOK_EVENTS via the helpers exposed here.
 *
 * Parity notes:
 *  - CANONICAL_TOOLS is a frozenset in Python; here it is a ReadonlySet<string>
 *    (frozen via Object.freeze on the backing Set is not possible, so the
 *    exported binding is a `const` ReadonlySet — membership + size are the only
 *    operations the tests exercise).
 *  - HookEvent is a frozen dataclass with a derived `harness` property in
 *    Python. TS interfaces erase at runtime, so HOOK_EVENTS rows are built by a
 *    small makeHookEvent() factory that computes the harness eagerly and
 *    Object.freeze()s the row, preserving the dataclass(frozen=True) contract.
 *  - claude_event / codex_event are `str | None` in types.ts → spelled `null`
 *    here (types.ts pins `| null`), matching the Python None sentinel.
 *  - This module owns no mutable global state, so there is nothing to register
 *    with reset.ts. _BY_NAME is built once at module load from the immutable
 *    HOOK_EVENTS tuple and never mutated.
 *
 * verbatimModuleSyntax is on → the type imports use `import type`.
 * noUncheckedIndexedAccess is on → Map.get() returns T | undefined, narrowed at
 * the lookup() call site.
 */

import type { Harness, HookEvent } from "./types.js";

/**
 * Canonical PascalCase tool names that token-goat handlers recognise.
 * This is the single source of truth referenced by hooks_cli._TG_KNOWN_TOOLS,
 * the harness-specific tool-name maps (Codex, Gemini), the embedded TOOL_TO_TG
 * tables in bridges (opencode, openclaw), and tests/test_tool_name_registry.py.
 *
 * frozenset in Python → a const ReadonlySet here. Membership tests and size are
 * the only operations callers/tests use.
 */
export const CANONICAL_TOOLS: ReadonlySet<string> = new Set<string>([
  "Read",
  "Write",
  "Edit",
  "MultiEdit",
  "Bash",
  "Glob",
  "WebFetch",
  "Grep",
  "Skill",
]);

/**
 * Compute which harness wire formats an event applies to.
 *
 * Mirrors the Python HookEvent.harness property: both keys set → "both", only
 * codex → "codex", otherwise → "claude". A truthy check on the event keys (a
 * null OR empty-string codex_event is falsy, matching `if self.codex_event`).
 */
function _deriveHarness(claude_event: string | null, codex_event: string | null): Harness {
  if (claude_event && codex_event) {
    return "both";
  }
  if (codex_event) {
    return "codex";
  }
  return "claude";
}

/** Field bag for makeHookEvent (everything except the derived `harness`). */
type HookEventInit = Omit<HookEvent, "harness">;

/**
 * Build one frozen HookEvent row with its `harness` property derived eagerly.
 *
 * Ports the frozen dataclass + @property: Object.freeze() makes the row
 * immutable (dataclass frozen=True) and `harness` is computed once at
 * construction so it behaves like the read-only property the tests would read.
 */
function makeHookEvent(init: HookEventInit): HookEvent {
  return Object.freeze({
    ...init,
    harness: _deriveHarness(init.claude_event, init.codex_event),
  });
}

/**
 * Canonical event registry. Order matters only for stable iteration in tests
 * and for stable settings.json diff output — grouped by Claude top-level event
 * (SessionStart, PreToolUse, PostToolUse, UserPromptSubmit, SubagentStop,
 * PreCompact) for readability.
 */
export const HOOK_EVENTS: readonly HookEvent[] = Object.freeze([
  makeHookEvent({
    name: "session-start",
    typer_func: "session_start",
    module: "hooks_session",
    attr: "session_start",
    claude_event: "SessionStart",
    claude_matcher: "*",
    claude_timeout_ms: 30000,
    codex_event: "SessionStart",
    codex_matcher: "*",
    codex_timeout_ms: 30000,
    docstring: "session-start event.",
  }),
  makeHookEvent({
    name: "pre-read",
    typer_func: "pre_read",
    module: "hooks_read",
    attr: "pre_read",
    claude_event: "PreToolUse",
    // Bash -> noisy-output compression; Grep/Glob -> dedup hint; Read -> image shrink + session hint.
    claude_matcher: "Read|Grep|Glob|Bash",
    claude_timeout_ms: 5000,
    codex_event: "PreToolUse",
    codex_matcher: "view_image|Bash",
    codex_timeout_ms: 5000,
    docstring: "pre-read event.",
  }),
  makeHookEvent({
    name: "pre-fetch",
    typer_func: "pre_fetch",
    module: "hooks_fetch",
    attr: "pre_fetch",
    claude_event: "PreToolUse",
    claude_matcher: "mcp__.*|WebFetch",
    claude_timeout_ms: 2000,
    codex_event: "PreToolUse",
    codex_matcher: "mcp__.*|web_search",
    codex_timeout_ms: 2000,
    docstring: "pre-fetch event.",
  }),
  makeHookEvent({
    name: "pre-screenshot",
    typer_func: "pre_screenshot",
    module: "hooks_read",
    attr: "pre_screenshot",
    claude_event: "PreToolUse",
    claude_matcher: "mcp__.*take_screenshot$",
    claude_timeout_ms: 2000,
    codex_event: null,
    codex_matcher: "",
    codex_timeout_ms: 0,
    docstring:
      "pre-screenshot event (redirects MCP screenshots without filePath so image-shrink applies).",
  }),
  makeHookEvent({
    name: "post-edit",
    typer_func: "post_edit",
    module: "hooks_edit",
    attr: "post_edit",
    claude_event: "PostToolUse",
    claude_matcher: "Edit|Write|MultiEdit",
    claude_timeout_ms: 2000,
    codex_event: "PostToolUse",
    codex_matcher: "apply_patch",
    codex_timeout_ms: 2000,
    docstring: "post-edit event.",
  }),
  makeHookEvent({
    name: "post-read",
    typer_func: "post_read",
    module: "hooks_read",
    attr: "post_read",
    claude_event: "PostToolUse",
    claude_matcher: "Read|Grep|Glob",
    claude_timeout_ms: 2000,
    codex_event: null, // Codex post-read goes through post-bash + cat detection.
    codex_matcher: "",
    codex_timeout_ms: 0,
    docstring: "post-read event.",
  }),
  makeHookEvent({
    name: "post-bash",
    typer_func: "post_bash",
    module: "hooks_read",
    attr: "post_bash",
    claude_event: "PostToolUse",
    claude_matcher: "Bash",
    claude_timeout_ms: 3000,
    codex_event: "PostToolUse",
    codex_matcher: "Bash",
    codex_timeout_ms: 3000,
    docstring: "post-bash event (caches Bash output for dedup + retrieval).",
  }),
  makeHookEvent({
    name: "post-fetch",
    typer_func: "post_fetch",
    module: "hooks_fetch",
    attr: "post_fetch",
    claude_event: "PostToolUse",
    claude_matcher: "mcp__.*|WebFetch",
    claude_timeout_ms: 3000,
    codex_event: null,
    codex_matcher: "",
    codex_timeout_ms: 0,
    docstring:
      "post-fetch event (caches WebFetch text body for dedup + retrieval; captures MCP results).",
  }),
  makeHookEvent({
    name: "pre-skill",
    typer_func: "pre_skill",
    module: "hooks_skill",
    attr: "pre_skill",
    claude_event: "PreToolUse",
    claude_matcher: "Skill",
    claude_timeout_ms: 3000,
    codex_event: null, // Codex has no Skill tool.
    codex_matcher: "",
    codex_timeout_ms: 0,
    docstring:
      "pre-skill event (blocks repeat skill loads; serves compact on first load when curated).",
  }),
  makeHookEvent({
    name: "post-skill",
    typer_func: "post_skill",
    module: "hooks_skill",
    attr: "post_skill",
    claude_event: "PostToolUse",
    claude_matcher: "Skill",
    claude_timeout_ms: 3000,
    codex_event: null, // Codex has no Skill tool.
    codex_matcher: "",
    codex_timeout_ms: 0,
    docstring: "post-skill event (caches loaded skill bodies for post-compact recall).",
  }),
  makeHookEvent({
    name: "user-prompt-submit",
    typer_func: "user_prompt_submit",
    module: "hooks_session",
    attr: "user_prompt_submit",
    claude_event: "UserPromptSubmit",
    claude_matcher: "*",
    claude_timeout_ms: 5000,
    codex_event: null, // Codex has no UserPromptSubmit equivalent.
    codex_matcher: "",
    codex_timeout_ms: 0,
    docstring: "user-prompt-submit event.",
  }),
  makeHookEvent({
    name: "subagent-stop",
    typer_func: "subagent_stop",
    module: "hooks_session",
    attr: "subagent_stop",
    claude_event: "SubagentStop",
    claude_matcher: "*",
    claude_timeout_ms: 5000,
    codex_event: null,
    codex_matcher: "",
    codex_timeout_ms: 0,
    docstring: "subagent-stop event.",
  }),
  makeHookEvent({
    name: "pre-compact",
    typer_func: "pre_compact",
    module: "hooks_cli", // Handler lives in hooks_cli itself, not a submodule.
    attr: "pre_compact",
    claude_event: "PreCompact",
    claude_matcher: "*",
    claude_timeout_ms: 5000,
    codex_event: "PreCompact",
    codex_matcher: "*",
    codex_timeout_ms: 5000,
    docstring: "pre-compact event.",
  }),
]);

/** Sentinel map for quick single-event lookup (Python ``_BY_NAME``). */
const _BY_NAME: Map<string, HookEvent> = new Map(HOOK_EVENTS.map((e) => [e.name, e]));

/** Return the canonical event names in registration order. */
export function all_events(): readonly string[] {
  return HOOK_EVENTS.map((e) => e.name);
}

/** Return events that are wired into Claude Code's settings.json. */
export function claude_events(): readonly HookEvent[] {
  return HOOK_EVENTS.filter((e) => e.claude_event);
}

/** Return events that are wired into Codex CLI's config.toml. */
export function codex_events(): readonly HookEvent[] {
  return HOOK_EVENTS.filter((e) => e.codex_event);
}

/**
 * Return the HookEvent for *name*, or null when unknown.
 *
 * Used by tests and callers that want a single-event view without iterating the
 * full registry. (Python returns ``HookEvent | None``; the JS null preserves
 * that sentinel — Map.get() yields undefined for a miss, normalised to null.)
 */
export function lookup(name: string): HookEvent | null {
  const found = _BY_NAME.get(name);
  return found ?? null;
}

/**
 * Build the hooks_cli._HANDLER_LOOKUP mapping from the registry.
 *
 * Returns ``{event_name: [submodule_name, attr_name]}``. ``pre-compact`` is
 * excluded — its handler is defined directly inside hooks_cli (not a submodule),
 * so dispatch resolves through EVENTS instead of through the lazy import path.
 */
export function handler_lookup(): Record<string, [string, string]> {
  const out: Record<string, [string, string]> = {};
  for (const e of HOOK_EVENTS) {
    if (e.module !== "hooks_cli") {
      out[e.name] = [e.module, e.attr];
    }
  }
  return out;
}

/**
 * Build the hooks_cli.__getattr__::event_map from the registry.
 *
 * Returns ``{typer_func_name: event_name}`` for every event that lives in a
 * submodule (excludes ``pre-compact`` which is already a module attribute).
 */
export function lazy_attr_map(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const e of HOOK_EVENTS) {
    if (e.module !== "hooks_cli") {
      out[e.typer_func] = e.name;
    }
  }
  return out;
}

/**
 * Verify that every registry event has a matching @hook_app.command.
 *
 * Raises an ImportError-equivalent (a plain Error whose message names the
 * missing events and the file to edit) on mismatch so the package fails to load
 * if drift exists. Called from cli.py immediately after the last
 * @hook_app.command decorator runs.
 *
 * @param registered_names Set of subcommand names actually registered on the
 *   hook_app typer instance. Caller derives this from
 *   hook_app.registered_commands.
 */
export function assert_typer_subcommands_aligned(registered_names: Set<string>): void {
  const expected = new Set(all_events());
  const missing: string[] = [];
  for (const name of expected) {
    if (!registered_names.has(name)) {
      missing.push(name);
    }
  }
  if (missing.length > 0) {
    missing.sort();
    throw new Error(
      `hook_registry drift: event(s) ${JSON.stringify(missing)} declared in ` +
        `hook_registry.HOOK_EVENTS but NOT registered as @hook_app.command ` +
        `in cli.py. Add \`@hook_app.command("<name>", ` +
        `context_settings=_HOOK_CTX)\` decorators in cli.py.`,
    );
  }
}

/**
 * Mirror of the Python module's ``__all__`` list. Exposed so the cross-harness
 * test can assert ``"CANONICAL_TOOLS" in hook_registry.__all__`` without
 * reflecting over ES module exports (which carry no ordered name list).
 */
export const __all__: readonly string[] = [
  "CANONICAL_TOOLS",
  "HOOK_EVENTS",
  "HookEvent",
  "all_events",
  "claude_events",
  "codex_events",
  "handler_lookup",
  "lazy_attr_map",
  "lookup",
  "assert_typer_subcommands_aligned",
];
