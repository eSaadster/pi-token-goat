// token-goat bridge extension for pi (pi-coding-agent)
// Bridges pi's extension events to token-goat's subprocess hook protocol.
// https://github.com/DFKHelper/token-goat
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { spawnSync } from "node:child_process";

// pi built-in tool names -> token-goat internal tool names
const TOOL_TO_TG: Record<string, string> = {
  read: "Read",
  bash: "Bash",
  edit: "Edit",
  write: "Write",
  grep: "Grep",
  find: "Glob",
};

// pi tool args (camelCase/short) -> token-goat snake_case tool_input keys
const ARGS_TO_TG: Record<string, Record<string, string>> = {
  read: { path: "file_path", offset: "offset", limit: "limit" },
  bash: { command: "command", timeout: "timeout" },
  edit: { path: "file_path" },
  write: { path: "file_path" },
  grep: { pattern: "pattern", path: "path" },
  find: { pattern: "pattern", path: "path" },
};

// Post-call hook event per token-goat tool name
const POST_HOOK: Record<string, string> = {
  Read: "post-read",
  Grep: "post-read",
  Glob: "post-read",
  Bash: "post-bash",
  WebFetch: "post-fetch",
  Edit: "post-edit",
  Write: "post-edit",
};

// Tools that have a pre-hook (read/search/fetch types only).
// Edit/Write tools have no pre-hook in token-goat; skip before-dispatch for them.
const PRE_HOOK_TOOLS = new Set(["Read", "Grep", "Glob", "Bash", "WebFetch"]);

function callHook(event: string, payload: Record<string, unknown>): Record<string, unknown> | null {
  try {
    const r = spawnSync("token-goat", ["hook", event], {
      input: JSON.stringify(payload),
      encoding: "utf8",
      timeout: 5000,
      windowsHide: true,
    });
    if (r.error) return null;
    const out = r.stdout?.trim();
    if (!out) return null;
    return JSON.parse(out) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function reverseArgMap(tool: string): Record<string, string> {
  const fwd = ARGS_TO_TG[tool] ?? {};
  return Object.fromEntries(Object.entries(fwd).map(([piKey, tgKey]) => [tgKey, piKey]));
}

function toToolInput(tool: string, input: Record<string, unknown>): Record<string, unknown> {
  const argMap = ARGS_TO_TG[tool] ?? {};
  const out: Record<string, unknown> = {};
  for (const [piKey, tgKey] of Object.entries(argMap)) {
    if (input[piKey] !== undefined) out[tgKey] = input[piKey];
  }
  return out;
}

// Run a token-goat CLI command (no stdin) and capture stdout. Used by the
// surgical-read tools and the /token-goat status command.
function runTg(args: string[], runCwd: string): { ok: boolean; out: string; err: string } {
  try {
    const r = spawnSync("token-goat", args, {
      cwd: runCwd,
      encoding: "utf8",
      timeout: 20000,
      windowsHide: true,
      maxBuffer: 16 * 1024 * 1024,
    });
    if (r.error) return { ok: false, out: "", err: String(r.error.message ?? r.error) };
    return { ok: (r.status ?? 0) === 0, out: r.stdout ?? "", err: r.stderr ?? "" };
  } catch (e) {
    return { ok: false, out: "", err: String(e) };
  }
}

// Cap tool output so one huge surgical read can't overflow pi's context.
// token-goat already caps most output; this is a backstop.
function cap(text: string): string {
  const MAX = 60000;
  return text.length <= MAX ? text : text.slice(0, MAX) + "  [token-goat: output truncated at 60000 chars]";
}

// One-line system-prompt nudge so pi proactively prefers token-goat's surgical
// reads. Only injected when token-goat is actually reachable.
const ROUTING_NOTE = "token-goat is available for token-efficient code work. Prefer its tools over reading whole files: use tg_map to orient in the repo, tg_symbol and tg_read to pull specific definitions, and tg_find to search. Large full-file reads are redirected to surgical reads automatically; noisy command output and screenshots are compressed in the background.";

export default function (pi: ExtensionAPI) {
  // Stable per-session id derived from pi's session file (filesystem-safe), or
  // a process-scoped fallback for ephemeral sessions. Recomputed on every
  // session_start (new / resume / fork all re-fire it).
  let sessionId = `pi-${process.pid}`;
  let cwd = process.cwd();
  // Manifest captured at session_before_compact, injected after compaction.
  let pendingManifest: string | undefined;
  // Whether the token-goat CLI is reachable on PATH (probed at session_start).
  let tgAvailable = false;

  pi.on("session_start", (_event, ctx) => {
    cwd = ctx.cwd ?? process.cwd();
    const file = ctx.sessionManager?.getSessionFile?.();
    // token-goat validates session_id against ^[a-zA-Z0-9_-]+$ — no dots, so
    // map every other char (including the .jsonl dot and path separators) to _.
    sessionId = file ? `pi-${file.replace(/[^A-Za-z0-9_-]/g, "_")}` : `pi-${process.pid}`;
    tgAvailable = runTg(["--version"], cwd).ok;
    callHook("session-start", { session_id: sessionId, cwd });
    if (ctx.hasUI) {
      ctx.ui.setStatus("token-goat", tgAvailable ? "token-goat ●" : "token-goat ⚠ not on PATH");
      if (!tgAvailable) {
        ctx.ui.notify("token-goat extension loaded, but the `token-goat` command isn't on PATH. Activate the venv before launching pi: source .venv/bin/activate", "warning");
      }
    }
  });

  pi.on("tool_call", async (event, _ctx) => {
    const tg = TOOL_TO_TG[event.toolName];
    if (!tg || !PRE_HOOK_TOOLS.has(tg)) return;

    const input = event.input as Record<string, unknown>;
    const hookEvent = tg === "WebFetch" ? "pre-fetch" : "pre-read";
    const resp = callHook(hookEvent, {
      session_id: sessionId,
      tool_name: tg,
      tool_input: toToolInput(event.toolName, input),
      cwd,
    });
    if (!resp) return;

    const hso = resp["hookSpecificOutput"] as Record<string, unknown> | undefined;
    if (!hso) return;

    // Deny: block the tool call with a reason (e.g. confirmed re-read).
    if (hso["permissionDecision"] === "deny") {
      return {
        block: true,
        reason: (hso["permissionDecisionReason"] as string) ?? "blocked by token-goat",
      };
    }

    // Update: rewrite tool args in place (e.g. image-shrunk path, compressed
    // bash command). token-goat returns its own snake_case keys; map them back.
    const updated = hso["updatedInput"] as Record<string, unknown> | undefined;
    if (updated) {
      const rev = reverseArgMap(event.toolName);
      for (const [tgKey, val] of Object.entries(updated)) {
        input[rev[tgKey] ?? tgKey] = val;
      }
    }
  });

  pi.on("tool_result", async (event, _ctx) => {
    const tg = TOOL_TO_TG[event.toolName];
    if (!tg) return;
    callHook(POST_HOOK[tg] ?? "post-read", {
      session_id: sessionId,
      tool_name: tg,
      tool_input: toToolInput(event.toolName, (event.input ?? {}) as Record<string, unknown>),
      cwd,
    });
  });

  // Compaction: pi's session_before_compact REPLACES the summary rather than
  // appending to it (unlike opencode's additive output.context). So capture the
  // token-goat manifest here, let pi build its own summary, then inject the
  // manifest as a post-compaction message that survives into the new context
  // window. This preserves the edited-file / symbol manifest within pi's
  // replace-only compaction model.
  pi.on("session_before_compact", async (_event, _ctx) => {
    const resp = callHook("pre-compact", { session_id: sessionId, trigger: "auto" });
    pendingManifest = resp?.["systemMessage"] as string | undefined;
  });

  pi.on("session_compact", async (_event, _ctx) => {
    if (pendingManifest) {
      pi.sendMessage(
        { customType: "token-goat-manifest", content: pendingManifest, display: false },
        { deliverAs: "nextTurn" },
      );
      pendingManifest = undefined;
    }
  });

  // Proactive routing: nudge pi to prefer token-goat's surgical reads. Only when
  // token-goat is reachable, so we never advertise tools that would fail.
  pi.on("before_agent_start", (event) => {
    if (!tgAvailable) return;
    return { systemPrompt: `${event.systemPrompt}

${ROUTING_NOTE}` };
  });

  // Surgical-read tools. These shell out to token-goat so pi can pull exactly
  // what it needs instead of whole files, and they show up as visible tool calls.
  pi.registerTool({
    name: "tg_map",
    label: "token-goat map",
    description: "Get a compact, PageRank-ranked map of the repository (top files and key symbols) instead of listing or reading files. Good first step to orient in an unfamiliar repo.",
    promptSnippet: "Orient in the repo with a ranked file/symbol map",
    promptGuidelines: ["Use tg_map to orient before reading files when exploring an unfamiliar repo."],
    parameters: Type.Object({
      compact: Type.Optional(Type.Boolean({ description: "Fit a ~300-token budget" })),
    }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      const r = runTg(params?.compact ? ["map", "--compact"] : ["map"], ctx?.cwd ?? cwd);
      if (!r.ok && !r.out) throw new Error(r.err || "token-goat map failed");
      return { content: [{ type: "text", text: cap(r.out || r.err) }], details: {} };
    },
  });

  pi.registerTool({
    name: "tg_symbol",
    label: "token-goat symbol",
    description: "Jump to a symbol definition (function/class/method) by name, returning just that definition. Requires the repo to be indexed (token-goat index).",
    promptSnippet: "Find a symbol definition by name",
    promptGuidelines: ["Use tg_symbol to locate a function or class by name instead of grepping or reading files."],
    parameters: Type.Object({ name: Type.String({ description: "Symbol name" }) }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      const r = runTg(["symbol", params.name], ctx?.cwd ?? cwd);
      if (!r.ok && !r.out) throw new Error(r.err || "token-goat symbol failed");
      return { content: [{ type: "text", text: cap(r.out || r.err) }], details: {} };
    },
  });

  pi.registerTool({
    name: "tg_read",
    label: "token-goat read",
    description: "Read one symbol or a line range instead of a whole file. Target is 'path::Symbol' (e.g. src/app.py::Login.handle) or 'path:START-END' for a line range.",
    promptSnippet: "Pull one function/class/section instead of a whole file",
    promptGuidelines: ["Prefer tg_read over read when you only need a single function, class, method, or line range."],
    parameters: Type.Object({ target: Type.String({ description: "path::Symbol or path:START-END" }) }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      const r = runTg(["read", params.target], ctx?.cwd ?? cwd);
      if (!r.ok && !r.out) throw new Error(r.err || "token-goat read failed");
      return { content: [{ type: "text", text: cap(r.out || r.err) }], details: {} };
    },
  });

  pi.registerTool({
    name: "tg_find",
    label: "token-goat find",
    description: "Search the codebase for a symbol or concept by name or meaning, returning ranked matches. Good when you do not know the exact symbol name.",
    promptSnippet: "Search code by name or meaning",
    promptGuidelines: ["Use tg_find to locate code by name or concept instead of a broad grep across files."],
    parameters: Type.Object({ query: Type.String({ description: "What to search for" }) }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      const r = runTg(["find", params.query], ctx?.cwd ?? cwd);
      if (!r.ok && !r.out) throw new Error(r.err || "token-goat find failed");
      return { content: [{ type: "text", text: cap(r.out || r.err) }], details: {} };
    },
  });

  // /token-goat — visible status + savings, so you can confirm it is active.
  pi.registerCommand("token-goat", {
    description: "Show token-goat status and token savings",
    handler: async (_args, ctx) => {
      const ver = runTg(["--version"], ctx.cwd ?? cwd);
      if (!ver.ok) {
        ctx.ui.notify("token-goat is not on PATH. Activate the venv first: source .venv/bin/activate", "error");
        return;
      }
      const cost = runTg(["cost"], ctx.cwd ?? cwd);
      const savings = cost.ok && cost.out.trim() ? cost.out.trim().slice(0, 800) : "(no savings recorded yet)";
      ctx.ui.notify(`${ver.out.trim()} — extension active
session: ${sessionId}

${savings}`, "info");
    },
  });
}
