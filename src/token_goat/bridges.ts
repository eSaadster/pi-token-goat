/**
 * TypeScript bridge plugins for opencode and openclaw interoperability.
 *
 * Faithful port of src/token_goat/bridges.py.
 *
 * Each bridge is a thin TypeScript file that shims the harness-specific plugin
 * API into token-goat's subprocess hook protocol via child_process.spawnSync.
 *
 * Supported harnesses
 * -------------------
 * opencode  — sst/opencode in-process plugin system; hooks via
 *             tool.execute.before/after and experimental.session.compacting.
 * openclaw  — openclawlab plugin system; hooks via before_tool_call /
 *             after_tool_call.
 * pi        — earendil-works/pi-coding-agent extension system; a
 *             default-exported factory that subscribes to session_start /
 *             tool_call / tool_result / session_before_compact / session_compact
 *             via the ExtensionAPI.
 *
 * Parity notes (Python → TS):
 *  - The bridge .ts sources are stored as STRING TEMPLATES (OPENCODE_PLUGIN_TS,
 *    OPENCLAW_PLUGIN_TS, PI_EXTENSION_TS) and written verbatim at install time.
 *    These strings MUST be byte-identical to the Python triple-quoted literals
 *    (tests assert substrings + a regex on the PRE_HOOK_TOOLS set literal, and
 *    the load-bearing pi sessionId sanitizer regex /[^A-Za-z0-9_-]/g — note the
 *    EXCLUDED dot — must survive unchanged). To guarantee byte-exactness without
 *    TS template-literal interpolation mangling the embedded JS `${...}` /
 *    backtick syntax, each template is stored as an array of plain
 *    double-quoted string literals (one per source line) joined with "\n" plus
 *    a trailing newline. The embedded JS template-literal syntax inside those
 *    strings is therefore inert text — TS never interpolates it.
 *  - pathlib.Path → string paths via node:path + node:os.
 *  - paths.ensure_dir → ensureDir from ./paths.js.
 *  - sys.platform == "win32" → process.platform === "win32".
 *  - os.environ.get("APPDATA") → process.env.APPDATA.
 *  - Path.home() → os.homedir().
 *  - json.loads/json.dumps → JSON.parse / JSON.stringify (indent=2 → 2 spaces,
 *    plus a trailing newline so the file is POSIX-compliant and diff-friendly).
 *  - The Python install path distinguishes json.JSONDecodeError, OSError, and
 *    ValueError. The TS port reproduces the observable contract: _load_json_config
 *    throws a JSONDecodeError (parse failure or non-object JSON) or an OSError
 *    (stat/read failure) or a ValueError (size cap), and install_openclaw_plugin
 *    catches the parse/IO pair so a corrupt config recovers to {} rather than
 *    propagating — exactly like the Python `except (json.JSONDecodeError,
 *    OSError)` handlers.
 *
 * `verbatimModuleSyntax` is on → type-only imports use `import type`.
 * `exactOptionalPropertyTypes` is on → optional params are `T | undefined`.
 * `noUncheckedIndexedAccess` is on → every indexed access is narrowed.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import * as paths from "./paths.js";
import { getLogger } from "./util.js";

// Self-namespace import so the path-resolver helpers (opencode_plugins_dir,
// openclaw_plugins_dir, openclaw_config_path, pi_extensions_dir) are invoked
// through the live module binding. This is the JS analogue of Python's
// patch.object(bridges, "opencode_plugins_dir", ...): tests vi.spyOn() these
// exports, and the install/uninstall/check call sites below dispatch via `self`
// so the spy is observed exactly as Python's module-attribute patch is. (A
// direct local call would bind to the un-spied function — see CONVENTIONS 11c.)
import * as self from "./bridges.js";

const _LOG = getLogger("bridges");

// Maximum size for user-controlled config files (openclaw.json, etc.).
// Prevents OOM from a maliciously large or corrupted config file.
const _MAX_CONFIG_BYTES = 1 * 1024 * 1024; // 1 MB

// ---------------------------------------------------------------------------
// Error analogues for the Python json.JSONDecodeError / OSError / ValueError
// distinctions the install path branches on.
// ---------------------------------------------------------------------------

/** Analogue of Python's json.JSONDecodeError (invalid or non-object JSON). */
export class JSONDecodeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "JSONDecodeError";
  }
}

/** Analogue of Python's OSError (stat/read failure on a config file). */
export class OSError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OSError";
  }
}

/** Analogue of Python's ValueError (config file exceeds the size cap). */
export class ValueError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ValueError";
  }
}

/**
 * Read and parse a JSON config file with a size cap (Python _load_json_config).
 *
 * Throws OSError if the file cannot be stat'd, JSONDecodeError if the content
 * is not valid JSON (or is not a JSON object), and ValueError if the file
 * exceeds 1 MB (guard against a maliciously large config consuming unbounded
 * memory).
 */
function _load_json_config(p: string): Record<string, unknown> {
  let size: number;
  try {
    size = fs.statSync(p).size;
  } catch (e) {
    throw new OSError(`could not stat config file ${p}: ${String(e)}`);
  }
  if (size > _MAX_CONFIG_BYTES) {
    throw new ValueError(
      `config file too large (${size} bytes > ${_MAX_CONFIG_BYTES} limit): ${p}`,
    );
  }
  const raw = fs.readFileSync(p, "utf-8");
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch (e) {
    throw new JSONDecodeError(`invalid JSON in ${p}: ${String(e)}`);
  }
  if (
    data === null ||
    typeof data !== "object" ||
    Array.isArray(data)
  ) {
    const typeName = data === null ? "null" : Array.isArray(data) ? "list" : typeof data;
    throw new JSONDecodeError(`expected JSON object, got ${typeName}`);
  }
  return data as Record<string, unknown>;
}

/**
 * Serialise *cfg* as indented JSON and write to *p* (Python _save_json_config).
 *
 * Uses a trailing newline so the file is POSIX-compliant and diff-friendly. The
 * directory must already exist; callers are responsible for mkdir.
 */
function _save_json_config(p: string, cfg: Record<string, unknown>): void {
  fs.writeFileSync(p, JSON.stringify(cfg, null, 2) + "\n", "utf-8");
}

// ---------------------------------------------------------------------------
// TypeScript bridge sources
// ---------------------------------------------------------------------------
//
// Stored as arrays of plain double-quoted string literals (one per source
// line) and joined with "\n" + trailing "\n". The embedded JS template-literal
// `${...}` / backtick syntax inside these strings is inert text — TS does NOT
// interpolate it. This keeps the emitted bridge sources byte-identical to the
// Python originals (see the module docstring). DO NOT convert these to TS
// backtick template literals.

const OPENCODE_PLUGIN_TS_LINES: string[] = [
  "// token-goat bridge plugin for opencode",
  "// Bridges opencode's plugin API to token-goat's subprocess hook protocol.",
  "// https://github.com/DFKHelper/token-goat",
  "import { spawnSync } from \"child_process\";",
  "",
  "const TOOL_TO_TG: Record<string, string> = {",
  "  read: \"Read\",",
  "  edit: \"Edit\",",
  "  apply_patch: \"Edit\",",
  "  shell: \"Bash\",",
  "  bash: \"Bash\",",
  "  grep: \"Grep\",",
  "  glob: \"Glob\",",
  "  webfetch: \"WebFetch\",",
  "};",
  "",
  "// opencode uses camelCase args; token-goat expects snake_case tool_input",
  "const ARGS_TO_TG: Record<string, Record<string, string>> = {",
  "  read: { filePath: \"file_path\", offset: \"offset\", limit: \"limit\" },",
  "  edit: { filePath: \"file_path\", oldString: \"old_string\", newString: \"new_string\", replaceAll: \"replace_all\" },",
  "  apply_patch: { patchText: \"patch_text\" },",
  "  shell: { command: \"command\" },",
  "  bash: { command: \"command\" },",
  "  grep: { pattern: \"pattern\", path: \"path\", include: \"glob\" },",
  "  glob: { pattern: \"pattern\", path: \"path\" },",
  "  webfetch: { url: \"url\", prompt: \"prompt\" },",
  "};",
  "",
  "// Post-call hook event per token-goat tool name (mirrors openclaw's POST_HOOK table)",
  "const POST_HOOK: Record<string, string> = {",
  "  Read: \"post-read\",",
  "  Grep: \"post-read\",",
  "  Glob: \"post-read\",",
  "  Bash: \"post-bash\",",
  "  WebFetch: \"post-fetch\",",
  "  Edit: \"post-edit\",",
  "  Write: \"post-edit\",",
  "};",
  "",
  "// Tools that have a pre-hook (read/search/fetch types only).",
  "// Edit/Write tools have no pre-hook in token-goat; skip before-dispatch for them.",
  "const PRE_HOOK_TOOLS = new Set([\"Read\", \"Grep\", \"Glob\", \"Bash\", \"WebFetch\"]);",
  "",
  "const _seenSessions = new Set<string>();",
  "",
  "function reverseArgMap(tool: string): Record<string, string> {",
  "  const fwd = ARGS_TO_TG[tool] ?? {};",
  "  return Object.fromEntries(Object.entries(fwd).map(([cc, tg]) => [tg, cc]));",
  "}",
  "",
  "function callHook(event: string, payload: Record<string, unknown>): Record<string, unknown> | null {",
  "  try {",
  "    const r = spawnSync(\"token-goat\", [\"hook\", event], {",
  "      input: JSON.stringify(payload),",
  "      encoding: \"utf8\",",
  "      timeout: 5000,",
  "      windowsHide: true,",
  "    });",
  "    if (r.error) return null;",
  "    const out = r.stdout?.trim();",
  "    if (!out) return null;",
  "    return JSON.parse(out) as Record<string, unknown>;",
  "  } catch {",
  "    return null;",
  "  }",
  "}",
  "",
  "export const server = async (pluginInput: { directory: string }) => {",
  "  const cwd = pluginInput.directory;",
  "",
  "  return {",
  "    \"tool.execute.before\": async (",
  "      input: { tool: string; sessionID: string; callID: string },",
  "      output: { args: Record<string, unknown> },",
  "    ) => {",
  "      const tgTool = TOOL_TO_TG[input.tool];",
  "      if (!tgTool) return;",
  "",
  "      if (!_seenSessions.has(input.sessionID)) {",
  "        _seenSessions.add(input.sessionID);",
  "        callHook(\"session-start\", { session_id: input.sessionID, cwd });",
  "      }",
  "",
  "      // Edit/Write/apply_patch only have post-hooks; skip pre-hook dispatch.",
  "      if (!PRE_HOOK_TOOLS.has(tgTool)) return;",
  "",
  "      const argMap = ARGS_TO_TG[input.tool] ?? {};",
  "      const toolInput: Record<string, unknown> = {};",
  "      for (const [ccKey, tgKey] of Object.entries(argMap)) {",
  "        if (output.args[ccKey] !== undefined) toolInput[tgKey] = output.args[ccKey];",
  "      }",
  "",
  "      const hookEvent = tgTool === \"WebFetch\" ? \"pre-fetch\" : \"pre-read\";",
  "      const resp = callHook(hookEvent, {",
  "        session_id: input.sessionID,",
  "        tool_name: tgTool,",
  "        tool_input: toolInput,",
  "        cwd,",
  "      });",
  "      if (!resp) return;",
  "",
  "      const hso = resp[\"hookSpecificOutput\"] as Record<string, unknown> | undefined;",
  "      const updated = hso?.[\"updatedInput\"] as Record<string, unknown> | undefined;",
  "      if (updated) {",
  "        const rev = reverseArgMap(input.tool);",
  "        for (const [tgKey, val] of Object.entries(updated)) {",
  "          output.args[rev[tgKey] ?? tgKey] = val;",
  "        }",
  "      }",
  "    },",
  "",
  "    \"tool.execute.after\": async (input: {",
  "      tool: string;",
  "      sessionID: string;",
  "      callID: string;",
  "      args: Record<string, unknown>;",
  "    }) => {",
  "      const tgTool = TOOL_TO_TG[input.tool];",
  "      if (!tgTool) return;",
  "",
  "      const argMap = ARGS_TO_TG[input.tool] ?? {};",
  "      const toolInput: Record<string, unknown> = {};",
  "      for (const [ccKey, tgKey] of Object.entries(argMap)) {",
  "        if (input.args[ccKey] !== undefined) toolInput[tgKey] = input.args[ccKey];",
  "      }",
  "",
  "      callHook(POST_HOOK[tgTool] ?? \"post-read\", {",
  "        session_id: input.sessionID,",
  "        tool_name: tgTool,",
  "        tool_input: toolInput,",
  "        cwd,",
  "      });",
  "    },",
  "",
  "    \"experimental.session.compacting\": async (",
  "      input: { sessionID: string },",
  "      output: { context: string[] },",
  "    ) => {",
  "      const resp = callHook(\"pre-compact\", { session_id: input.sessionID, trigger: \"auto\" });",
  "      const manifest = resp?.[\"systemMessage\"] as string | undefined;",
  "      if (manifest) output.context.push(manifest);",
  "    },",
  "  };",
  "};",
];
export const OPENCODE_PLUGIN_TS: string = OPENCODE_PLUGIN_TS_LINES.join("\n") + "\n";

const OPENCLAW_PLUGIN_TS_LINES: string[] = [
  "// token-goat bridge plugin for openclaw",
  "// Bridges openclaw's plugin API to token-goat's subprocess hook protocol.",
  "// https://github.com/DFKHelper/token-goat",
  "import { spawnSync } from \"child_process\";",
  "",
  "// openclaw tool names \u2192 token-goat internal tool names",
  "const TOOL_TO_TG: Record<string, string> = {",
  "  read: \"Read\",",
  "  write: \"Write\",",
  "  edit: \"Edit\",",
  "  apply_patch: \"Edit\",",
  "  exec: \"Bash\",",
  "  grep: \"Grep\",",
  "  glob: \"Glob\",",
  "  webfetch: \"WebFetch\",",
  "};",
  "",
  "// Post-call hook event per token-goat tool name",
  "const POST_HOOK: Record<string, string> = {",
  "  Read: \"post-read\",",
  "  Grep: \"post-read\",",
  "  Glob: \"post-read\",",
  "  Bash: \"post-bash\",",
  "  WebFetch: \"post-fetch\",",
  "  Edit: \"post-edit\",",
  "  Write: \"post-edit\",",
  "};",
  "",
  "// Tools that have a pre-hook (read/search/fetch types only).",
  "// Edit/Write tools have no pre-hook in token-goat; skip before-dispatch for them.",
  "const PRE_HOOK_TOOLS = new Set([\"Read\", \"Grep\", \"Glob\", \"Bash\", \"WebFetch\"]);",
  "",
  "// Stable pseudo-session for this process lifetime (openclaw has no session concept)",
  "const SESSION_ID = `openclaw-${process.pid}-${Date.now()}`;",
  "",
  "function callHook(event: string, payload: Record<string, unknown>): Record<string, unknown> | null {",
  "  try {",
  "    const r = spawnSync(\"token-goat\", [\"hook\", event], {",
  "      input: JSON.stringify(payload),",
  "      encoding: \"utf8\",",
  "      timeout: 5000,",
  "      windowsHide: true,",
  "    });",
  "    if (r.error) return null;",
  "    const out = r.stdout?.trim();",
  "    if (!out) return null;",
  "    return JSON.parse(out) as Record<string, unknown>;",
  "  } catch {",
  "    return null;",
  "  }",
  "}",
  "",
  "// Fire session-start once when the plugin module is loaded",
  "callHook(\"session-start\", { session_id: SESSION_ID, cwd: process.cwd() });",
  "",
  "export default {",
  "  id: \"token-goat-bridge\",",
  "  name: \"token-goat\",",
  "",
  "  register(api: any): void {",
  "    api.on(\"before_tool_call\", async (event: any) => {",
  "      const tgTool = TOOL_TO_TG[event.toolName];",
  "      if (!tgTool) return {};",
  "",
  "      // Edit/Write/apply_patch only have post-hooks; skip pre-hook dispatch.",
  "      if (!PRE_HOOK_TOOLS.has(tgTool)) return {};",
  "",
  "      const hookEvent = tgTool === \"WebFetch\" ? \"pre-fetch\" : \"pre-read\";",
  "      const resp = callHook(hookEvent, {",
  "        session_id: SESSION_ID,",
  "        tool_name: tgTool,",
  "        tool_input: event.params ?? {},",
  "        cwd: process.cwd(),",
  "      });",
  "      if (!resp) return {};",
  "",
  "      const hso = resp[\"hookSpecificOutput\"] as Record<string, unknown> | undefined;",
  "      if (!hso) return {};",
  "",
  "      // Deny: block the tool call with a reason",
  "      if (hso[\"permissionDecision\"] === \"deny\") {",
  "        return {",
  "          block: true,",
  "          blockReason: (hso[\"permissionDecisionReason\"] as string) ?? \"blocked by token-goat\",",
  "        };",
  "      }",
  "",
  "      // Update: redirect to modified params (e.g. image-shrunk file path)",
  "      const updated = hso[\"updatedInput\"] as Record<string, unknown> | undefined;",
  "      if (updated) {",
  "        return { params: { ...event.params, ...updated } };",
  "      }",
  "",
  "      return {};",
  "    });",
  "",
  "    api.on(\"after_tool_call\", async (event: any) => {",
  "      const tgTool = TOOL_TO_TG[event.toolName];",
  "      if (!tgTool) return;",
  "",
  "      callHook(POST_HOOK[tgTool] ?? \"post-read\", {",
  "        session_id: SESSION_ID,",
  "        tool_name: tgTool,",
  "        tool_input: event.params ?? {},",
  "        cwd: process.cwd(),",
  "      });",
  "    });",
  "  },",
  "};",
];
export const OPENCLAW_PLUGIN_TS: string = OPENCLAW_PLUGIN_TS_LINES.join("\n") + "\n";

const PI_EXTENSION_TS_LINES: string[] = [
  "// token-goat bridge extension for pi (pi-coding-agent)",
  "// Bridges pi's extension events to token-goat's subprocess hook protocol.",
  "// https://github.com/DFKHelper/token-goat",
  "import type { ExtensionAPI } from \"@earendil-works/pi-coding-agent\";",
  "import { Type } from \"typebox\";",
  "import { spawnSync } from \"node:child_process\";",
  "",
  "// pi built-in tool names -> token-goat internal tool names",
  "const TOOL_TO_TG: Record<string, string> = {",
  "  read: \"Read\",",
  "  bash: \"Bash\",",
  "  edit: \"Edit\",",
  "  write: \"Write\",",
  "  grep: \"Grep\",",
  "  find: \"Glob\",",
  "};",
  "",
  "// pi tool args (camelCase/short) -> token-goat snake_case tool_input keys",
  "const ARGS_TO_TG: Record<string, Record<string, string>> = {",
  "  read: { path: \"file_path\", offset: \"offset\", limit: \"limit\" },",
  "  bash: { command: \"command\", timeout: \"timeout\" },",
  "  edit: { path: \"file_path\" },",
  "  write: { path: \"file_path\" },",
  "  grep: { pattern: \"pattern\", path: \"path\" },",
  "  find: { pattern: \"pattern\", path: \"path\" },",
  "};",
  "",
  "// Post-call hook event per token-goat tool name",
  "const POST_HOOK: Record<string, string> = {",
  "  Read: \"post-read\",",
  "  Grep: \"post-read\",",
  "  Glob: \"post-read\",",
  "  Bash: \"post-bash\",",
  "  WebFetch: \"post-fetch\",",
  "  Edit: \"post-edit\",",
  "  Write: \"post-edit\",",
  "};",
  "",
  "// Tools that have a pre-hook (read/search/fetch types only).",
  "// Edit/Write tools have no pre-hook in token-goat; skip before-dispatch for them.",
  "const PRE_HOOK_TOOLS = new Set([\"Read\", \"Grep\", \"Glob\", \"Bash\", \"WebFetch\"]);",
  "",
  "function callHook(event: string, payload: Record<string, unknown>): Record<string, unknown> | null {",
  "  try {",
  "    const r = spawnSync(\"token-goat\", [\"hook\", event], {",
  "      input: JSON.stringify(payload),",
  "      encoding: \"utf8\",",
  "      timeout: 5000,",
  "      windowsHide: true,",
  "    });",
  "    if (r.error) return null;",
  "    const out = r.stdout?.trim();",
  "    if (!out) return null;",
  "    return JSON.parse(out) as Record<string, unknown>;",
  "  } catch {",
  "    return null;",
  "  }",
  "}",
  "",
  "function reverseArgMap(tool: string): Record<string, string> {",
  "  const fwd = ARGS_TO_TG[tool] ?? {};",
  "  return Object.fromEntries(Object.entries(fwd).map(([piKey, tgKey]) => [tgKey, piKey]));",
  "}",
  "",
  "function toToolInput(tool: string, input: Record<string, unknown>): Record<string, unknown> {",
  "  const argMap = ARGS_TO_TG[tool] ?? {};",
  "  const out: Record<string, unknown> = {};",
  "  for (const [piKey, tgKey] of Object.entries(argMap)) {",
  "    if (input[piKey] !== undefined) out[tgKey] = input[piKey];",
  "  }",
  "  return out;",
  "}",
  "",
  "// Run a token-goat CLI command (no stdin) and capture stdout. Used by the",
  "// surgical-read tools and the /token-goat status command.",
  "function runTg(args: string[], runCwd: string): { ok: boolean; out: string; err: string } {",
  "  try {",
  "    const r = spawnSync(\"token-goat\", args, {",
  "      cwd: runCwd,",
  "      encoding: \"utf8\",",
  "      timeout: 20000,",
  "      windowsHide: true,",
  "      maxBuffer: 16 * 1024 * 1024,",
  "    });",
  "    if (r.error) return { ok: false, out: \"\", err: String(r.error.message ?? r.error) };",
  "    return { ok: (r.status ?? 0) === 0, out: r.stdout ?? \"\", err: r.stderr ?? \"\" };",
  "  } catch (e) {",
  "    return { ok: false, out: \"\", err: String(e) };",
  "  }",
  "}",
  "",
  "// Cap tool output so one huge surgical read can't overflow pi's context.",
  "// token-goat already caps most output; this is a backstop.",
  "function cap(text: string): string {",
  "  const MAX = 60000;",
  "  return text.length <= MAX ? text : text.slice(0, MAX) + \"  [token-goat: output truncated at 60000 chars]\";",
  "}",
  "",
  "// One-line system-prompt nudge so pi proactively prefers token-goat's surgical",
  "// reads. Only injected when token-goat is actually reachable.",
  "const ROUTING_NOTE = \"token-goat is available for token-efficient code work. Prefer its tools over reading whole files: use tg_map to orient in the repo, tg_symbol and tg_read to pull specific definitions, and tg_find to search. Large full-file reads are redirected to surgical reads automatically; noisy command output and screenshots are compressed in the background.\";",
  "",
  "export default function (pi: ExtensionAPI) {",
  "  // Stable per-session id derived from pi's session file (filesystem-safe), or",
  "  // a process-scoped fallback for ephemeral sessions. Recomputed on every",
  "  // session_start (new / resume / fork all re-fire it).",
  "  let sessionId = `pi-${process.pid}`;",
  "  let cwd = process.cwd();",
  "  // Manifest captured at session_before_compact, injected after compaction.",
  "  let pendingManifest: string | undefined;",
  "  // Whether the token-goat CLI is reachable on PATH (probed at session_start).",
  "  let tgAvailable = false;",
  "",
  "  pi.on(\"session_start\", (_event, ctx) => {",
  "    cwd = ctx.cwd ?? process.cwd();",
  "    const file = ctx.sessionManager?.getSessionFile?.();",
  "    // token-goat validates session_id against ^[a-zA-Z0-9_-]+$ \u2014 no dots, so",
  "    // map every other char (including the .jsonl dot and path separators) to _.",
  "    sessionId = file ? `pi-${file.replace(/[^A-Za-z0-9_-]/g, \"_\")}` : `pi-${process.pid}`;",
  "    tgAvailable = runTg([\"--version\"], cwd).ok;",
  "    callHook(\"session-start\", { session_id: sessionId, cwd });",
  "    if (ctx.hasUI) {",
  "      ctx.ui.setStatus(\"token-goat\", tgAvailable ? \"token-goat \u25cf\" : \"token-goat \u26a0 not on PATH\");",
  "      if (!tgAvailable) {",
  "        ctx.ui.notify(\"token-goat extension loaded, but the `token-goat` command isn't on PATH. Activate the venv before launching pi: source .venv/bin/activate\", \"warning\");",
  "      }",
  "    }",
  "  });",
  "",
  "  pi.on(\"tool_call\", async (event, _ctx) => {",
  "    const tg = TOOL_TO_TG[event.toolName];",
  "    if (!tg || !PRE_HOOK_TOOLS.has(tg)) return;",
  "",
  "    const input = event.input as Record<string, unknown>;",
  "    const hookEvent = tg === \"WebFetch\" ? \"pre-fetch\" : \"pre-read\";",
  "    const resp = callHook(hookEvent, {",
  "      session_id: sessionId,",
  "      tool_name: tg,",
  "      tool_input: toToolInput(event.toolName, input),",
  "      cwd,",
  "    });",
  "    if (!resp) return;",
  "",
  "    const hso = resp[\"hookSpecificOutput\"] as Record<string, unknown> | undefined;",
  "    if (!hso) return;",
  "",
  "    // Deny: block the tool call with a reason (e.g. confirmed re-read).",
  "    if (hso[\"permissionDecision\"] === \"deny\") {",
  "      return {",
  "        block: true,",
  "        reason: (hso[\"permissionDecisionReason\"] as string) ?? \"blocked by token-goat\",",
  "      };",
  "    }",
  "",
  "    // Update: rewrite tool args in place (e.g. image-shrunk path, compressed",
  "    // bash command). token-goat returns its own snake_case keys; map them back.",
  "    const updated = hso[\"updatedInput\"] as Record<string, unknown> | undefined;",
  "    if (updated) {",
  "      const rev = reverseArgMap(event.toolName);",
  "      for (const [tgKey, val] of Object.entries(updated)) {",
  "        input[rev[tgKey] ?? tgKey] = val;",
  "      }",
  "    }",
  "  });",
  "",
  "  pi.on(\"tool_result\", async (event, _ctx) => {",
  "    const tg = TOOL_TO_TG[event.toolName];",
  "    if (!tg) return;",
  "    callHook(POST_HOOK[tg] ?? \"post-read\", {",
  "      session_id: sessionId,",
  "      tool_name: tg,",
  "      tool_input: toToolInput(event.toolName, (event.input ?? {}) as Record<string, unknown>),",
  "      cwd,",
  "    });",
  "  });",
  "",
  "  // Compaction: pi's session_before_compact REPLACES the summary rather than",
  "  // appending to it (unlike opencode's additive output.context). So capture the",
  "  // token-goat manifest here, let pi build its own summary, then inject the",
  "  // manifest as a post-compaction message that survives into the new context",
  "  // window. This preserves the edited-file / symbol manifest within pi's",
  "  // replace-only compaction model.",
  "  pi.on(\"session_before_compact\", async (_event, _ctx) => {",
  "    const resp = callHook(\"pre-compact\", { session_id: sessionId, trigger: \"auto\" });",
  "    pendingManifest = resp?.[\"systemMessage\"] as string | undefined;",
  "  });",
  "",
  "  pi.on(\"session_compact\", async (_event, _ctx) => {",
  "    if (pendingManifest) {",
  "      pi.sendMessage(",
  "        { customType: \"token-goat-manifest\", content: pendingManifest, display: false },",
  "        { deliverAs: \"nextTurn\" },",
  "      );",
  "      pendingManifest = undefined;",
  "    }",
  "  });",
  "",
  "  // Proactive routing: nudge pi to prefer token-goat's surgical reads. Only when",
  "  // token-goat is reachable, so we never advertise tools that would fail.",
  "  pi.on(\"before_agent_start\", (event) => {",
  "    if (!tgAvailable) return;",
  "    return { systemPrompt: `${event.systemPrompt}",
  "",
  "${ROUTING_NOTE}` };",
  "  });",
  "",
  "  // Surgical-read tools. These shell out to token-goat so pi can pull exactly",
  "  // what it needs instead of whole files, and they show up as visible tool calls.",
  "  pi.registerTool({",
  "    name: \"tg_map\",",
  "    label: \"token-goat map\",",
  "    description: \"Get a compact, PageRank-ranked map of the repository (top files and key symbols) instead of listing or reading files. Good first step to orient in an unfamiliar repo.\",",
  "    promptSnippet: \"Orient in the repo with a ranked file/symbol map\",",
  "    promptGuidelines: [\"Use tg_map to orient before reading files when exploring an unfamiliar repo.\"],",
  "    parameters: Type.Object({",
  "      compact: Type.Optional(Type.Boolean({ description: \"Fit a ~300-token budget\" })),",
  "    }),",
  "    async execute(_id, params, _signal, _onUpdate, ctx) {",
  "      const r = runTg(params?.compact ? [\"map\", \"--compact\"] : [\"map\"], ctx?.cwd ?? cwd);",
  "      if (!r.ok && !r.out) throw new Error(r.err || \"token-goat map failed\");",
  "      return { content: [{ type: \"text\", text: cap(r.out || r.err) }], details: {} };",
  "    },",
  "  });",
  "",
  "  pi.registerTool({",
  "    name: \"tg_symbol\",",
  "    label: \"token-goat symbol\",",
  "    description: \"Jump to a symbol definition (function/class/method) by name, returning just that definition. Requires the repo to be indexed (token-goat index).\",",
  "    promptSnippet: \"Find a symbol definition by name\",",
  "    promptGuidelines: [\"Use tg_symbol to locate a function or class by name instead of grepping or reading files.\"],",
  "    parameters: Type.Object({ name: Type.String({ description: \"Symbol name\" }) }),",
  "    async execute(_id, params, _signal, _onUpdate, ctx) {",
  "      const r = runTg([\"symbol\", params.name], ctx?.cwd ?? cwd);",
  "      if (!r.ok && !r.out) throw new Error(r.err || \"token-goat symbol failed\");",
  "      return { content: [{ type: \"text\", text: cap(r.out || r.err) }], details: {} };",
  "    },",
  "  });",
  "",
  "  pi.registerTool({",
  "    name: \"tg_read\",",
  "    label: \"token-goat read\",",
  "    description: \"Read one symbol or a line range instead of a whole file. Target is 'path::Symbol' (e.g. src/app.py::Login.handle) or 'path:START-END' for a line range.\",",
  "    promptSnippet: \"Pull one function/class/section instead of a whole file\",",
  "    promptGuidelines: [\"Prefer tg_read over read when you only need a single function, class, method, or line range.\"],",
  "    parameters: Type.Object({ target: Type.String({ description: \"path::Symbol or path:START-END\" }) }),",
  "    async execute(_id, params, _signal, _onUpdate, ctx) {",
  "      const r = runTg([\"read\", params.target], ctx?.cwd ?? cwd);",
  "      if (!r.ok && !r.out) throw new Error(r.err || \"token-goat read failed\");",
  "      return { content: [{ type: \"text\", text: cap(r.out || r.err) }], details: {} };",
  "    },",
  "  });",
  "",
  "  pi.registerTool({",
  "    name: \"tg_find\",",
  "    label: \"token-goat find\",",
  "    description: \"Search the codebase for a symbol or concept by name or meaning, returning ranked matches. Good when you do not know the exact symbol name.\",",
  "    promptSnippet: \"Search code by name or meaning\",",
  "    promptGuidelines: [\"Use tg_find to locate code by name or concept instead of a broad grep across files.\"],",
  "    parameters: Type.Object({ query: Type.String({ description: \"What to search for\" }) }),",
  "    async execute(_id, params, _signal, _onUpdate, ctx) {",
  "      const r = runTg([\"find\", params.query], ctx?.cwd ?? cwd);",
  "      if (!r.ok && !r.out) throw new Error(r.err || \"token-goat find failed\");",
  "      return { content: [{ type: \"text\", text: cap(r.out || r.err) }], details: {} };",
  "    },",
  "  });",
  "",
  "  // /token-goat \u2014 visible status + savings, so you can confirm it is active.",
  "  pi.registerCommand(\"token-goat\", {",
  "    description: \"Show token-goat status and token savings\",",
  "    handler: async (_args, ctx) => {",
  "      const ver = runTg([\"--version\"], ctx.cwd ?? cwd);",
  "      if (!ver.ok) {",
  "        ctx.ui.notify(\"token-goat is not on PATH. Activate the venv first: source .venv/bin/activate\", \"error\");",
  "        return;",
  "      }",
  "      const cost = runTg([\"cost\"], ctx.cwd ?? cwd);",
  "      const savings = cost.ok && cost.out.trim() ? cost.out.trim().slice(0, 800) : \"(no savings recorded yet)\";",
  "      ctx.ui.notify(`${ver.out.trim()} \u2014 extension active",
  "session: ${sessionId}",
  "",
  "${savings}`, \"info\");",
  "    },",
  "  });",
  "}",
];
export const PI_EXTENSION_TS: string = PI_EXTENSION_TS_LINES.join("\n") + "\n";

// ---------------------------------------------------------------------------
// Shared file-level install / uninstall helpers
// ---------------------------------------------------------------------------

/**
 * Write *content* to the `<plugins_dir>/<filename>` path, creating parent
 * directories (Python _write_plugin_file).
 *
 * Returns the absolute path of the written file. Both opencode and openclaw
 * share this step; the only difference is the filename and content string.
 */
export function _write_plugin_file(
  plugins_dir: string,
  filename: string,
  content: string,
): string {
  paths.ensureDir(plugins_dir);
  const plugin_path = path.join(plugins_dir, filename);
  fs.writeFileSync(plugin_path, content, "utf-8");
  return plugin_path;
}

/**
 * Remove *plugin_path* if it exists and return a human-readable status (Python
 * _remove_plugin_file).
 *
 * Returns `"removed <path>"` on success or `"not found"` if the file was
 * absent. Both opencode and openclaw share this step; the openclaw uninstall
 * additionally deregisters from openclaw.json after calling this helper.
 */
export function _remove_plugin_file(plugin_path: string): string {
  if (fs.existsSync(plugin_path)) {
    fs.unlinkSync(plugin_path);
    return `removed ${plugin_path}`;
  }
  return "not found";
}

// ---------------------------------------------------------------------------
// Path helpers
// ---------------------------------------------------------------------------

/** Return the opencode plugins directory (platform-aware) (Python opencode_plugins_dir). */
export function opencode_plugins_dir(): string {
  if (process.platform === "win32") {
    const appdata =
      process.env.APPDATA ?? path.join(os.homedir(), "AppData", "Roaming");
    return path.join(appdata, "opencode", "plugins");
  }
  // XDG on Linux and macOS
  return path.join(os.homedir(), ".config", "opencode", "plugins");
}

/** Return the openclaw plugins directory (~/.openclaw/plugins) (Python openclaw_plugins_dir). */
export function openclaw_plugins_dir(): string {
  return path.join(os.homedir(), ".openclaw", "plugins");
}

/** Return the openclaw config file path (~/.openclaw/openclaw.json) (Python openclaw_config_path). */
export function openclaw_config_path(): string {
  return path.join(os.homedir(), ".openclaw", "openclaw.json");
}

/**
 * Return the global pi extensions directory (~/.pi/agent/extensions) (Python
 * pi_extensions_dir).
 *
 * pi auto-discovers extensions from this user/global location. Project-local
 * installs target `<project>/.pi/extensions` instead — pass that path as the
 * `target_dir` argument to install_pi_plugin.
 */
export function pi_extensions_dir(): string {
  return path.join(os.homedir(), ".pi", "agent", "extensions");
}

/**
 * Return the path the pi bridge extension is (or would be) written to (Python
 * pi_plugin_path).
 *
 * Defaults to the global pi_extensions_dir; pass *target_dir* for a
 * project-local install directory.
 */
export function pi_plugin_path(target_dir: string | undefined = undefined): string {
  const dest = target_dir !== undefined ? target_dir : self.pi_extensions_dir();
  return path.join(dest, _PI_FILENAME);
}

// ---------------------------------------------------------------------------
// Opencode install / uninstall / check
// ---------------------------------------------------------------------------

// Strings that must appear in any token-goat bridge plugin file to confirm it
// is ours (not a leftover from another tool). Both opencode and openclaw
// plugins share the same fingerprint because they are generated from the same
// template and always contain these markers.
const _PLUGIN_FINGERPRINT: readonly string[] = ["token-goat", "spawnSync"];

export const _OPENCODE_FILENAME = "token-goat.ts";

/**
 * Return a status string for a simple single-file bridge plugin (Python
 * _check_plugin_file).
 *
 * Returns one of:
 * - `"not installed"`  — *plugin_path* does not exist
 * - `"installed"`      — file exists and contains all fingerprint strings
 * - `"present but not token-goat bridge"` — file exists but fingerprint missing
 * - `"error reading plugin file"` — error while reading
 */
function _check_plugin_file(plugin_path: string): string {
  if (!fs.existsSync(plugin_path)) {
    return "not installed";
  }
  try {
    const content = fs.readFileSync(plugin_path, "utf-8");
    if (_PLUGIN_FINGERPRINT.every((fp) => content.includes(fp))) {
      return "installed";
    }
    return "present but not token-goat bridge";
  } catch (e) {
    _LOG.warning(
      `opencode plugin status check failed reading ${plugin_path}: ${String(e)}`,
    );
    return "error reading plugin file";
  }
}

/** Write the opencode bridge plugin to the opencode plugins directory. Returns the path. */
export function install_opencode_plugin(): string {
  const plugin_path = _write_plugin_file(
    self.opencode_plugins_dir(),
    _OPENCODE_FILENAME,
    OPENCODE_PLUGIN_TS,
  );
  _LOG.info(`opencode plugin written: ${plugin_path}`);
  return plugin_path;
}

/** Remove the opencode bridge plugin. Returns a status string. */
export function uninstall_opencode_plugin(): string {
  return _remove_plugin_file(path.join(self.opencode_plugins_dir(), _OPENCODE_FILENAME));
}

/** Return install status of the opencode bridge plugin (Python _check_opencode_plugin). */
export function _check_opencode_plugin(): string {
  return _check_plugin_file(path.join(self.opencode_plugins_dir(), _OPENCODE_FILENAME));
}

// ---------------------------------------------------------------------------
// Openclaw install / uninstall / check
// ---------------------------------------------------------------------------

export const _OPENCLAW_PLUGIN_ID = "token-goat-bridge";
export const _OPENCLAW_FILENAME = "token-goat-bridge.ts";

/**
 * Return the `plugins.entries` dict from an openclaw config, creating it if
 * absent (Python _openclaw_entries).
 *
 * The three callers (install, uninstall, check) all traverse the same two-level
 * path `cfg["plugins"]["entries"]` with identical isinstance guards. Extracted
 * here to avoid repeating the traversal in each caller.
 *
 * Mutates *cfg* in-place only when the intermediate keys are missing (safe for
 * the install path); for read-only callers (check/uninstall) the dict is
 * already present and is returned as-is.
 */
function _openclaw_entries(cfg: Record<string, unknown>): Record<string, unknown> {
  const raw_plugins = cfg["plugins"];
  const plugins: Record<string, unknown> =
    isPlainObject(raw_plugins) ? raw_plugins : {};
  cfg["plugins"] = plugins;
  const raw_entries = plugins["entries"];
  const entries: Record<string, unknown> =
    isPlainObject(raw_entries) ? raw_entries : {};
  plugins["entries"] = entries;
  return entries;
}

/**
 * Return the `plugins.entries` dict from an openclaw config without mutating
 * *cfg* (Python _openclaw_entries_readonly).
 *
 * Used by read/uninstall paths where creating missing keys would corrupt a
 * config that genuinely has no plugins section yet.
 */
function _openclaw_entries_readonly(
  cfg: Record<string, unknown>,
): Record<string, unknown> {
  const raw_plugins = cfg["plugins"];
  const raw_entries = isPlainObject(raw_plugins) ? raw_plugins["entries"] : {};
  return isPlainObject(raw_entries) ? raw_entries : {};
}

/** True for a non-null, non-array object (Python isinstance(x, dict)). */
function isPlainObject(x: unknown): x is Record<string, unknown> {
  return x !== null && typeof x === "object" && !Array.isArray(x);
}

/** Write the openclaw bridge plugin and register it in openclaw.json. Returns the path. */
export function install_openclaw_plugin(): string {
  const plugin_path = _write_plugin_file(
    self.openclaw_plugins_dir(),
    _OPENCLAW_FILENAME,
    OPENCLAW_PLUGIN_TS,
  );

  const cfg_path = self.openclaw_config_path();
  paths.ensureDir(path.dirname(cfg_path));
  let cfg: Record<string, unknown>;
  try {
    cfg = fs.existsSync(cfg_path) ? _load_json_config(cfg_path) : {};
  } catch (e) {
    if (e instanceof JSONDecodeError || e instanceof OSError) {
      _LOG.debug(`openclaw.json read failed, starting fresh: ${String(e)}`);
      cfg = {};
    } else {
      throw e;
    }
  }

  const entries = _openclaw_entries(cfg);
  entries[_OPENCLAW_PLUGIN_ID] = { enabled: true, path: plugin_path };
  _save_json_config(cfg_path, cfg);

  _LOG.info(`openclaw plugin written: ${plugin_path}`);
  return plugin_path;
}

/** Remove the openclaw bridge plugin and deregister from openclaw.json. Returns a status string. */
export function uninstall_openclaw_plugin(): string {
  const removed: string[] = [];

  const file_result = _remove_plugin_file(
    path.join(self.openclaw_plugins_dir(), _OPENCLAW_FILENAME),
  );
  if (file_result !== "not found") {
    removed.push(file_result);
  }

  const cfg_path = self.openclaw_config_path();
  if (fs.existsSync(cfg_path)) {
    try {
      const cfg = _load_json_config(cfg_path);
      const entries = _openclaw_entries_readonly(cfg);
      if (Object.prototype.hasOwnProperty.call(entries, _OPENCLAW_PLUGIN_ID)) {
        delete entries[_OPENCLAW_PLUGIN_ID];
        _save_json_config(cfg_path, cfg);
        removed.push("deregistered from openclaw.json");
      }
    } catch (e) {
      if (e instanceof JSONDecodeError || e instanceof OSError) {
        _LOG.warning(`openclaw config not updated during uninstall: ${String(e)}`);
      } else {
        throw e;
      }
    }
  }

  return removed.length > 0 ? removed.join(", ") : "not found";
}

/**
 * Return install status of the openclaw bridge plugin (Python
 * _check_openclaw_plugin).
 *
 * Unlike the opencode variant, openclaw plugins must also be registered in
 * `openclaw.json`, so this check reports both the file and registry state.
 */
export function _check_openclaw_plugin(): string {
  const plugin_path = path.join(self.openclaw_plugins_dir(), _OPENCLAW_FILENAME);
  const cfg_path = self.openclaw_config_path();

  const file_status = _check_plugin_file(plugin_path);
  // Pass through error/foreign-file states immediately — registry check not meaningful.
  if (file_status !== "not installed" && file_status !== "installed") {
    return file_status;
  }
  const file_installed = file_status === "installed";

  let registered = false;
  if (fs.existsSync(cfg_path)) {
    try {
      const cfg = _load_json_config(cfg_path);
      registered = Object.prototype.hasOwnProperty.call(
        _openclaw_entries_readonly(cfg),
        _OPENCLAW_PLUGIN_ID,
      );
    } catch (e) {
      if (e instanceof JSONDecodeError || e instanceof OSError) {
        _LOG.debug(`openclaw.json read failed in check: ${String(e)}`);
      } else {
        throw e;
      }
    }
  }

  if (file_installed && registered) {
    return "installed";
  }
  if (file_installed && !registered) {
    return "file present but not registered in openclaw.json";
  }
  if (registered && !file_installed) {
    return "registered in openclaw.json but plugin file missing";
  }
  return "not installed";
}

// ---------------------------------------------------------------------------
// Pi install / uninstall / check
// ---------------------------------------------------------------------------

export const _PI_FILENAME = "token-goat.ts";

/**
 * Write the pi bridge extension. Returns the path (Python install_pi_plugin).
 *
 * *target_dir* overrides the destination directory. Defaults to the global
 * pi_extensions_dir (`~/.pi/agent/extensions`); pass a project-local
 * `<project>/.pi/extensions` path to install for a single project only (pi
 * loads project-local extensions after the project is trusted).
 */
export function install_pi_plugin(
  target_dir: string | undefined = undefined,
): string {
  const dest = target_dir !== undefined ? target_dir : self.pi_extensions_dir();
  const plugin_path = _write_plugin_file(dest, _PI_FILENAME, PI_EXTENSION_TS);
  _LOG.info(`pi extension written: ${plugin_path}`);
  return plugin_path;
}

/**
 * Remove the pi bridge extension. Returns a status string (Python
 * uninstall_pi_plugin).
 *
 * *target_dir* must match the directory used at install time (default global).
 */
export function uninstall_pi_plugin(
  target_dir: string | undefined = undefined,
): string {
  return _remove_plugin_file(pi_plugin_path(target_dir));
}

/** Return install status of the pi bridge extension (default global dir) (Python _check_pi_plugin). */
export function _check_pi_plugin(
  target_dir: string | undefined = undefined,
): string {
  return _check_plugin_file(pi_plugin_path(target_dir));
}
