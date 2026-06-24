/**
 * Tests for bridges — opencode and openclaw bridge plugin install/check/uninstall.
 *
 * 1:1 port of tests/test_bridges.py.
 *
 * Test-seam mapping (Python → TS):
 *  - patch.object(bridges, "opencode_plugins_dir", return_value=X)
 *      → vi.spyOn(bridges, "opencode_plugins_dir").mockReturnValue(X). The
 *        implementation calls the sibling helpers through the module namespace
 *        import (`import * as bridges`), so spies on those names are observed by
 *        install/uninstall/check exactly as Python's patch.object on the module
 *        attribute is.
 *  - tmp_path fixture → a per-test throwaway directory under the OS tmp dir
 *        (mkdtempSync). The TS bridges module does not resolve paths under the
 *        token-goat data dir, so setup.ts's data-dir override is irrelevant
 *        here; we build explicit tmp dirs exactly like pytest's tmp_path.
 *  - patch.object(sys, "platform", "win32"/"linux"/"darwin")
 *      → Object.defineProperty(process, "platform", { value: X }) restored in a
 *        finally block (process.platform is read-only, so define/restore mirrors
 *        monkeypatch.setattr's scoped patch).
 *  - patch.dict("os.environ", {"APPDATA": X}) → set/restore process.env.APPDATA.
 *  - caplog → not exercised by the ported subset (the warning paths here are not
 *        asserted on).
 *
 * Deliberately skipped (depend on not-yet-ported modules):
 *  - TestBridgeEventRegistryAlignment (4 tests) — imports token_goat.hook_registry
 *    (not yet ported to TS); its all_events() table is the assertion target.
 *  - TestInstallIntegration (16 tests) — imports token_goat.install (not yet
 *    ported to TS); patches install.check_status / install_all / uninstall_all
 *    and their platform-specific helpers.
 *  Each is marked it.skip with a "// PORT: deferred — <reason>" tag and counted.
 *
 * Every Python `def test_*` maps to a vitest `it()` with the same name and
 * assertion polarity.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import * as bridges from "../src/token_goat/bridges.js";

// ---------------------------------------------------------------------------
// Per-test helpers.
// ---------------------------------------------------------------------------

/** Create a fresh throwaway directory (the TS analogue of pytest's tmp_path). */
function makeTmpPath(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "tg-bridges-"));
}

let _tmpPath = "";

beforeEach(() => {
  _tmpPath = makeTmpPath();
});

afterEach(() => {
  vi.restoreAllMocks();
  try {
    fs.rmSync(_tmpPath, { recursive: true, force: true });
  } catch {
    // best-effort cleanup.
  }
});

/** Python: _write_fake_plugin(path, content). */
function _write_fake_plugin(p: string, content: string): void {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content, "utf-8");
}

/**
 * Run `fn` with process.platform temporarily set to `value`, restoring the
 * original (read-only) descriptor afterward. Mirrors
 * monkeypatch.setattr(sys, "platform", value).
 */
function withPlatform<T>(value: string, fn: () => T): T {
  const orig = Object.getOwnPropertyDescriptor(process, "platform");
  Object.defineProperty(process, "platform", { value, configurable: true });
  try {
    return fn();
  } finally {
    if (orig) {
      Object.defineProperty(process, "platform", orig);
    }
  }
}

// ---------------------------------------------------------------------------
// TypeScript source content smoke checks
// ---------------------------------------------------------------------------

describe("TestPluginTsSources", () => {
  it("test_opencode_ts_contains_spawnSync", () => {
    expect(bridges.OPENCODE_PLUGIN_TS).toContain("spawnSync");
  });

  it("test_opencode_ts_contains_token_goat", () => {
    expect(bridges.OPENCODE_PLUGIN_TS).toContain("token-goat");
  });

  it("test_opencode_ts_exports_server", () => {
    expect(bridges.OPENCODE_PLUGIN_TS).toContain("export const server");
  });

  it("test_opencode_ts_handles_tool_execute_before", () => {
    expect(bridges.OPENCODE_PLUGIN_TS).toContain("tool.execute.before");
  });

  it("test_opencode_ts_handles_tool_execute_after", () => {
    expect(bridges.OPENCODE_PLUGIN_TS).toContain("tool.execute.after");
  });

  it("test_opencode_ts_handles_compacting", () => {
    expect(bridges.OPENCODE_PLUGIN_TS).toContain("experimental.session.compacting");
  });

  it("test_openclaw_ts_contains_spawnSync", () => {
    expect(bridges.OPENCLAW_PLUGIN_TS).toContain("spawnSync");
  });

  it("test_openclaw_ts_contains_token_goat", () => {
    expect(bridges.OPENCLAW_PLUGIN_TS).toContain("token-goat");
  });

  it("test_openclaw_ts_has_register_function", () => {
    expect(bridges.OPENCLAW_PLUGIN_TS).toContain("register(");
  });

  it("test_openclaw_ts_handles_before_tool_call", () => {
    expect(bridges.OPENCLAW_PLUGIN_TS).toContain("before_tool_call");
  });

  it("test_openclaw_ts_handles_after_tool_call", () => {
    expect(bridges.OPENCLAW_PLUGIN_TS).toContain("after_tool_call");
  });

  it("test_openclaw_ts_has_deny_support", () => {
    expect(bridges.OPENCLAW_PLUGIN_TS).toContain("block: true");
  });

  it("test_openclaw_ts_has_updated_input_support", () => {
    expect(bridges.OPENCLAW_PLUGIN_TS).toContain("updatedInput");
  });

  it("test_openclaw_ts_session_id_uses_pid", () => {
    expect(bridges.OPENCLAW_PLUGIN_TS).toContain("process.pid");
  });

  it("test_openclaw_ts_exports_default", () => {
    expect(bridges.OPENCLAW_PLUGIN_TS).toContain("export default");
  });

  it("test_openclaw_ts_plugin_id", () => {
    expect(bridges.OPENCLAW_PLUGIN_TS).toContain("token-goat-bridge");
  });

  it("test_opencode_ts_maps_read_tool", () => {
    // TS object keys are unquoted: `read: "Read",`
    expect(bridges.OPENCODE_PLUGIN_TS).toContain('read: "Read"');
  });

  it("test_opencode_ts_maps_webfetch_to_pre_fetch", () => {
    expect(bridges.OPENCODE_PLUGIN_TS).toContain("pre-fetch");
  });

  it("test_openclaw_ts_maps_exec_tool", () => {
    // TS object keys are unquoted: `exec: "Bash",`
    expect(bridges.OPENCLAW_PLUGIN_TS).toContain('exec: "Bash"');
  });

  it("test_openclaw_ts_post_edit_for_write", () => {
    // TS object keys are unquoted: `Write: "post-edit",`
    expect(bridges.OPENCLAW_PLUGIN_TS).toContain('Write: "post-edit"');
  });

  it("test_opencode_ts_bash_routes_to_post_bash", () => {
    // Bash output caching requires post-bash, not post-read.
    // opencode now uses a POST_HOOK table (same as openclaw) instead of a ternary chain.
    expect(bridges.OPENCODE_PLUGIN_TS).toContain("post-bash");
    expect(bridges.OPENCODE_PLUGIN_TS).toContain('Bash: "post-bash"');
  });

  it("test_opencode_ts_webfetch_routes_to_post_fetch", () => {
    // Web-fetch caching requires post-fetch, not post-read.
    expect(bridges.OPENCODE_PLUGIN_TS).toContain('WebFetch: "post-fetch"');
  });

  it("test_opencode_ts_has_post_hook_table", () => {
    // opencode now uses a POST_HOOK lookup table, mirroring openclaw's pattern.
    expect(bridges.OPENCODE_PLUGIN_TS).toContain("POST_HOOK");
    expect(bridges.OPENCODE_PLUGIN_TS).toContain('Edit: "post-edit"');
  });

  it("test_opencode_ts_post_hook_table_used_in_after_handler", () => {
    // The after handler must dispatch via POST_HOOK, not a ternary chain.
    expect(bridges.OPENCODE_PLUGIN_TS).toContain("POST_HOOK[tgTool]");
  });

  it("test_openclaw_ts_bash_routes_to_post_bash", () => {
    // Bash output caching requires post-bash, not post-read.
    expect(bridges.OPENCLAW_PLUGIN_TS).toContain('Bash: "post-bash"');
  });

  it("test_openclaw_ts_webfetch_routes_to_post_fetch", () => {
    // Web-fetch caching requires post-fetch, not post-read.
    expect(bridges.OPENCLAW_PLUGIN_TS).toContain('WebFetch: "post-fetch"');
  });

  // --- PRE_HOOK_TOOLS guard tests ---

  it("test_opencode_ts_has_pre_hook_tools_guard", () => {
    // The before handler must skip pre-hook dispatch for edit-type tools.
    // Edit/Write/apply_patch have no pre-hook in token-goat.
    expect(bridges.OPENCODE_PLUGIN_TS).toContain("PRE_HOOK_TOOLS");
  });

  it("test_openclaw_ts_has_pre_hook_tools_guard", () => {
    // Same guard required in openclaw's before_tool_call handler.
    expect(bridges.OPENCLAW_PLUGIN_TS).toContain("PRE_HOOK_TOOLS");
  });

  it("test_opencode_ts_pre_hook_guard_skips_edit", () => {
    // The guard expression must check whether the resolved tgTool is in the
    // PRE_HOOK_TOOLS set and return early when it is not.
    expect(bridges.OPENCODE_PLUGIN_TS).toContain("PRE_HOOK_TOOLS.has(tgTool)");
  });

  it("test_openclaw_ts_pre_hook_guard_skips_edit", () => {
    expect(bridges.OPENCLAW_PLUGIN_TS).toContain("PRE_HOOK_TOOLS.has(tgTool)");
  });

  it("test_opencode_ts_pre_hook_tools_excludes_edit", () => {
    // PRE_HOOK_TOOLS must NOT include Edit or Write — only read/search/fetch tools.
    const match = /const PRE_HOOK_TOOLS = new Set\(\[([^\]]+)\]\)/.exec(
      bridges.OPENCODE_PLUGIN_TS,
    );
    expect(match, "PRE_HOOK_TOOLS Set literal not found in OPENCODE_PLUGIN_TS").toBeTruthy();
    const members = match![1]!;
    expect(members).not.toContain('"Edit"');
    expect(members).not.toContain('"Write"');
    expect(members).toContain('"Read"');
    expect(members).toContain('"Bash"');
  });

  it("test_openclaw_ts_pre_hook_tools_excludes_edit", () => {
    const match = /const PRE_HOOK_TOOLS = new Set\(\[([^\]]+)\]\)/.exec(
      bridges.OPENCLAW_PLUGIN_TS,
    );
    expect(match, "PRE_HOOK_TOOLS Set literal not found in OPENCLAW_PLUGIN_TS").toBeTruthy();
    const members = match![1]!;
    expect(members).not.toContain('"Edit"');
    expect(members).not.toContain('"Write"');
    expect(members).toContain('"Read"');
    expect(members).toContain('"Bash"');
  });

  // --- callHook error handling tests ---

  it("test_opencode_ts_callhook_checks_r_error", () => {
    // callHook must return null immediately when spawnSync sets r.error
    // (binary not found / ENOENT) rather than proceeding to stdout parsing.
    expect(bridges.OPENCODE_PLUGIN_TS).toContain("r.error");
  });

  it("test_openclaw_ts_callhook_checks_r_error", () => {
    expect(bridges.OPENCLAW_PLUGIN_TS).toContain("r.error");
  });

  it("test_opencode_ts_callhook_error_before_stdout", () => {
    // The r.error guard must appear before the stdout check to avoid
    // dereferencing stdout on a failed spawn.
    const oc = bridges.OPENCODE_PLUGIN_TS;
    const error_pos = oc.indexOf("r.error");
    const stdout_pos = oc.indexOf("r.stdout");
    expect(error_pos !== -1 && stdout_pos !== -1).toBe(true);
    expect(error_pos, "r.error check must precede r.stdout access").toBeLessThan(stdout_pos);
  });

  it("test_openclaw_ts_callhook_error_before_stdout", () => {
    const ocl = bridges.OPENCLAW_PLUGIN_TS;
    const error_pos = ocl.indexOf("r.error");
    const stdout_pos = ocl.indexOf("r.stdout");
    expect(error_pos !== -1 && stdout_pos !== -1).toBe(true);
    expect(error_pos, "r.error check must precede r.stdout access").toBeLessThan(stdout_pos);
  });

  // --- opencode PreCompact / experimental.session.compacting tests ---

  it("test_opencode_ts_precompact_calls_pre_compact_hook", () => {
    // The compacting handler must call callHook("pre-compact", ...).
    expect(bridges.OPENCODE_PLUGIN_TS).toContain('callHook("pre-compact"');
  });

  it("test_opencode_ts_precompact_passes_session_id", () => {
    // The compacting handler must forward input.sessionID as session_id.
    const oc = bridges.OPENCODE_PLUGIN_TS;
    expect(oc).toContain("input.sessionID");
    // The pre-compact call must include session_id: input.sessionID
    expect(oc).toContain("session_id: input.sessionID");
  });

  it("test_opencode_ts_precompact_extracts_systemMessage", () => {
    // The compacting handler must extract resp["systemMessage"] from the hook response.
    expect(bridges.OPENCODE_PLUGIN_TS).toContain('"systemMessage"');
  });

  it("test_opencode_ts_precompact_uses_context_push", () => {
    // Injection must use output.context.push(), not output.context.set() or any other API.
    const oc = bridges.OPENCODE_PLUGIN_TS;
    expect(oc).toContain("output.context.push(");
  });

  it("test_opencode_ts_precompact_guards_empty_manifest", () => {
    // The compacting handler must guard with `if (manifest)` before calling push.
    const oc = bridges.OPENCODE_PLUGIN_TS;
    const guard_pos = oc.indexOf("if (manifest)");
    const push_pos = oc.indexOf("output.context.push(");
    expect(guard_pos, "if (manifest) guard not found in OPENCODE_PLUGIN_TS").not.toBe(-1);
    expect(push_pos, "output.context.push not found in OPENCODE_PLUGIN_TS").not.toBe(-1);
    expect(guard_pos, "if (manifest) guard must precede output.context.push call").toBeLessThan(push_pos);
  });

  it("test_opencode_ts_precompact_push_inside_guard", () => {
    // Verify the structural invariant: push is inside the `if (manifest)` block.
    const oc = bridges.OPENCODE_PLUGIN_TS;
    const compact_start = oc.indexOf('"experimental.session.compacting"');
    expect(compact_start, "compacting handler not found").not.toBe(-1);
    const handler_body = oc.slice(compact_start);
    const guard_in_handler = handler_body.indexOf("if (manifest)");
    const push_in_handler = handler_body.indexOf("output.context.push(");
    expect(guard_in_handler, "if (manifest) guard not in compacting handler scope").not.toBe(-1);
    expect(push_in_handler, "output.context.push not in compacting handler scope").not.toBe(-1);
    expect(guard_in_handler).toBeLessThan(push_in_handler);
  });

  it("test_opencode_ts_precompact_no_unconditional_push", () => {
    // There must not be an unconditional output.context.push() call.
    const oc = bridges.OPENCODE_PLUGIN_TS;
    const push_count = oc.split("output.context.push(").length - 1;
    expect(
      push_count,
      `Expected exactly 1 output.context.push call (guarded), found ${push_count}`,
    ).toBe(1);
  });

  // --- pi extension TS source smoke checks ---

  it("test_pi_ts_contains_spawnSync", () => {
    expect(bridges.PI_EXTENSION_TS).toContain("spawnSync");
  });

  it("test_pi_ts_contains_token_goat", () => {
    expect(bridges.PI_EXTENSION_TS).toContain("token-goat");
  });

  it("test_pi_ts_exports_default_factory", () => {
    expect(bridges.PI_EXTENSION_TS).toContain("export default function");
  });

  it("test_pi_ts_imports_extension_api", () => {
    // The factory's single argument is typed against pi's ExtensionAPI.
    expect(bridges.PI_EXTENSION_TS).toContain("ExtensionAPI");
    expect(bridges.PI_EXTENSION_TS).toContain("@earendil-works/pi-coding-agent");
  });

  it("test_pi_ts_subscribes_session_start", () => {
    expect(bridges.PI_EXTENSION_TS).toContain('pi.on("session_start"');
  });

  it("test_pi_ts_subscribes_tool_call", () => {
    expect(bridges.PI_EXTENSION_TS).toContain('pi.on("tool_call"');
  });

  it("test_pi_ts_subscribes_tool_result", () => {
    expect(bridges.PI_EXTENSION_TS).toContain('pi.on("tool_result"');
  });

  it("test_pi_ts_subscribes_compaction_events", () => {
    expect(bridges.PI_EXTENSION_TS).toContain('pi.on("session_before_compact"');
    expect(bridges.PI_EXTENSION_TS).toContain('pi.on("session_compact"');
  });

  it("test_pi_ts_maps_read_tool", () => {
    // TS object keys are unquoted: `read: "Read",`
    expect(bridges.PI_EXTENSION_TS).toContain('read: "Read"');
  });

  it("test_pi_ts_maps_find_to_glob", () => {
    // pi's find tool is the glob-equivalent.
    expect(bridges.PI_EXTENSION_TS).toContain('find: "Glob"');
  });

  it("test_pi_ts_has_deny_support", () => {
    expect(bridges.PI_EXTENSION_TS).toContain("block: true");
  });

  it("test_pi_ts_has_updated_input_support", () => {
    expect(bridges.PI_EXTENSION_TS).toContain("updatedInput");
  });

  it("test_pi_ts_bash_routes_to_post_bash", () => {
    expect(bridges.PI_EXTENSION_TS).toContain('Bash: "post-bash"');
  });

  it("test_pi_ts_post_edit_for_write", () => {
    expect(bridges.PI_EXTENSION_TS).toContain('Write: "post-edit"');
  });

  it("test_pi_ts_has_post_hook_table", () => {
    expect(bridges.PI_EXTENSION_TS).toContain("POST_HOOK");
    expect(bridges.PI_EXTENSION_TS).toContain("POST_HOOK[tg]");
  });

  it("test_pi_ts_has_pre_hook_tools_guard", () => {
    expect(bridges.PI_EXTENSION_TS).toContain("PRE_HOOK_TOOLS");
    expect(bridges.PI_EXTENSION_TS).toContain("PRE_HOOK_TOOLS.has(tg)");
  });

  it("test_pi_ts_pre_hook_tools_excludes_edit", () => {
    const match = /const PRE_HOOK_TOOLS = new Set\(\[([^\]]+)\]\)/.exec(
      bridges.PI_EXTENSION_TS,
    );
    expect(match, "PRE_HOOK_TOOLS Set literal not found in PI_EXTENSION_TS").toBeTruthy();
    const members = match![1]!;
    expect(members).not.toContain('"Edit"');
    expect(members).not.toContain('"Write"');
    expect(members).toContain('"Read"');
    expect(members).toContain('"Bash"');
  });

  it("test_pi_ts_callhook_checks_r_error", () => {
    expect(bridges.PI_EXTENSION_TS).toContain("r.error");
  });

  it("test_pi_ts_callhook_error_before_stdout", () => {
    const pts = bridges.PI_EXTENSION_TS;
    const error_pos = pts.indexOf("r.error");
    const stdout_pos = pts.indexOf("r.stdout");
    expect(error_pos !== -1 && stdout_pos !== -1).toBe(true);
    expect(error_pos, "r.error check must precede r.stdout access").toBeLessThan(stdout_pos);
  });

  it("test_pi_ts_session_id_sanitizer_excludes_dot", () => {
    // token-goat's session_id validator is ^[a-zA-Z0-9_-]+$ (session.py
    // _SESSION_ID_RE) — no dots. The extension derives session_id from the
    // session filename, so its sanitizer must strip dots (e.g. ".jsonl") too.
    expect(bridges.PI_EXTENSION_TS).toContain("[^A-Za-z0-9_-]");
    expect(bridges.PI_EXTENSION_TS).not.toContain("[^A-Za-z0-9._-]");
  });

  it("test_pi_ts_registers_status_command", () => {
    // /token-goat status command must be registered for visibility.
    expect(bridges.PI_EXTENSION_TS).toContain('registerCommand("token-goat"');
  });

  it("test_pi_ts_registers_surgical_read_tools", () => {
    // pi should be able to proactively call token-goat's surgical reads.
    for (const tool of ['"tg_map"', '"tg_symbol"', '"tg_read"', '"tg_find"']) {
      expect(bridges.PI_EXTENSION_TS, tool).toContain(tool);
    }
    expect(bridges.PI_EXTENSION_TS).toContain("registerTool");
  });

  it("test_pi_ts_injects_routing_note", () => {
    // before_agent_start nudges pi to prefer token-goat's tools.
    expect(bridges.PI_EXTENSION_TS).toContain('pi.on("before_agent_start"');
    expect(bridges.PI_EXTENSION_TS).toContain("ROUTING_NOTE");
  });

  it("test_pi_ts_routing_gated_on_availability", () => {
    // The routing note must not be injected when token-goat is not on PATH.
    expect(bridges.PI_EXTENSION_TS).toContain("tgAvailable");
  });

  it("test_pi_ts_sets_status_indicator", () => {
    // A visible status line confirms the extension is active.
    expect(bridges.PI_EXTENSION_TS).toContain("setStatus");
  });

  it("test_pi_ts_imports_typebox", () => {
    // Tool parameter schemas need typebox.
    expect(bridges.PI_EXTENSION_TS).toContain('import { Type } from "typebox"');
  });

  it("test_pi_ts_no_backslash_escapes", () => {
    // The TS is embedded in a plain (non-raw) Python triple-quoted string.
    // Backslashes would risk invalid-escape SyntaxWarnings and corrupted regex,
    // so the source must avoid them entirely.
    expect(bridges.PI_EXTENSION_TS).not.toContain("\\");
  });
});

// ---------------------------------------------------------------------------
// Bridge TS event-table alignment with hook_registry
// ---------------------------------------------------------------------------

describe("TestBridgeEventRegistryAlignment", () => {
  // PORT: deferred — these tests import token_goat.hook_registry (not yet ported
  // to TS); all_events() is the canonical assertion target.
  it.skip("test_opencode_events_all_registered", () => {});
  it.skip("test_openclaw_events_all_registered", () => {});
  it.skip("test_pi_events_all_registered", () => {});
  it.skip("test_combined_bridge_events_cover_common_subset", () => {});
});

// ---------------------------------------------------------------------------
// Shared file-level helpers
// ---------------------------------------------------------------------------

describe("TestWritePluginFile", () => {
  it("test_writes_content", () => {
    const result = bridges._write_plugin_file(_tmpPath, "foo.ts", "content here");
    expect(fs.readFileSync(result, "utf-8")).toBe("content here");
  });

  it("test_returns_absolute_path", () => {
    const result = bridges._write_plugin_file(_tmpPath, "foo.ts", "x");
    expect(path.isAbsolute(result)).toBe(true);
    expect(path.basename(result)).toBe("foo.ts");
  });

  it("test_creates_parent_dirs", () => {
    const nested = path.join(_tmpPath, "a", "b", "c");
    bridges._write_plugin_file(nested, "foo.ts", "x");
    expect(fs.statSync(nested).isDirectory()).toBe(true);
  });

  it("test_idempotent_overwrite", () => {
    bridges._write_plugin_file(_tmpPath, "foo.ts", "first");
    bridges._write_plugin_file(_tmpPath, "foo.ts", "second");
    expect(fs.readFileSync(path.join(_tmpPath, "foo.ts"), "utf-8")).toBe("second");
  });
});

describe("TestRemovePluginFile", () => {
  it("test_removes_existing_file", () => {
    const p = path.join(_tmpPath, "foo.ts");
    fs.writeFileSync(p, "x", "utf-8");
    const result = bridges._remove_plugin_file(p);
    expect(fs.existsSync(p)).toBe(false);
    expect(result).toContain("removed");
    expect(result).toContain(p);
  });

  it("test_returns_not_found_when_absent", () => {
    const result = bridges._remove_plugin_file(path.join(_tmpPath, "missing.ts"));
    expect(result).toBe("not found");
  });
});

// ---------------------------------------------------------------------------
// Path helpers
// ---------------------------------------------------------------------------

describe("TestPathHelpers", () => {
  it("test_opencode_plugins_dir_returns_path", () => {
    const result = bridges.opencode_plugins_dir();
    expect(typeof result).toBe("string");
    expect(result.toLowerCase()).toContain("opencode");
    expect(result).toContain("plugins");
  });

  it("test_opencode_plugins_dir_platform_win32", () => {
    const fake_appdata = path.join("/fake", "appdata");
    const prev = process.env.APPDATA;
    process.env.APPDATA = fake_appdata;
    let result: string;
    try {
      result = withPlatform("win32", () => bridges.opencode_plugins_dir());
    } finally {
      if (prev === undefined) delete process.env.APPDATA;
      else process.env.APPDATA = prev;
    }
    expect(result).toBe(path.join(fake_appdata, "opencode", "plugins"));
  });

  it("test_opencode_plugins_dir_platform_linux", () => {
    const result = withPlatform("linux", () => bridges.opencode_plugins_dir());
    expect(result).toBe(path.join(os.homedir(), ".config", "opencode", "plugins"));
  });

  it("test_opencode_plugins_dir_platform_darwin", () => {
    const result = withPlatform("darwin", () => bridges.opencode_plugins_dir());
    expect(result).toBe(path.join(os.homedir(), ".config", "opencode", "plugins"));
  });

  it("test_openclaw_plugins_dir", () => {
    const result = bridges.openclaw_plugins_dir();
    expect(result).toBe(path.join(os.homedir(), ".openclaw", "plugins"));
  });

  it("test_openclaw_config_path", () => {
    const result = bridges.openclaw_config_path();
    expect(result).toBe(path.join(os.homedir(), ".openclaw", "openclaw.json"));
  });

  it("test_pi_extensions_dir", () => {
    const result = bridges.pi_extensions_dir();
    expect(result).toBe(path.join(os.homedir(), ".pi", "agent", "extensions"));
  });

  it("test_pi_plugin_path_default", () => {
    const result = bridges.pi_plugin_path();
    expect(result).toBe(path.join(bridges.pi_extensions_dir(), bridges._PI_FILENAME));
  });

  it("test_pi_plugin_path_target_dir", () => {
    const target = path.join(_tmpPath, "proj", ".pi", "extensions");
    const result = bridges.pi_plugin_path(target);
    expect(result).toBe(path.join(target, bridges._PI_FILENAME));
  });
});

// ---------------------------------------------------------------------------
// Opencode install / uninstall / check
// ---------------------------------------------------------------------------

describe("TestOpencodePlugin", () => {
  it("test_install_writes_file", () => {
    vi.spyOn(bridges, "opencode_plugins_dir").mockReturnValue(
      path.join(_tmpPath, "plugins"),
    );
    const path_str = bridges.install_opencode_plugin();
    const written = path_str;
    expect(fs.existsSync(written)).toBe(true);
    expect(fs.readFileSync(written, "utf-8")).toBe(bridges.OPENCODE_PLUGIN_TS);
  });

  it("test_install_creates_parent_dirs", () => {
    const nested = path.join(_tmpPath, "a", "b", "plugins");
    vi.spyOn(bridges, "opencode_plugins_dir").mockReturnValue(nested);
    bridges.install_opencode_plugin();
    expect(fs.existsSync(nested)).toBe(true);
  });

  it("test_install_returns_path_string", () => {
    vi.spyOn(bridges, "opencode_plugins_dir").mockReturnValue(_tmpPath);
    const result = bridges.install_opencode_plugin();
    expect(typeof result).toBe("string");
    expect(result).toContain("token-goat.ts");
  });

  it("test_install_is_idempotent", () => {
    vi.spyOn(bridges, "opencode_plugins_dir").mockReturnValue(_tmpPath);
    bridges.install_opencode_plugin();
    bridges.install_opencode_plugin();
    expect(fs.existsSync(path.join(_tmpPath, bridges._OPENCODE_FILENAME))).toBe(true);
  });

  it("test_uninstall_removes_file", () => {
    const plugin_path = path.join(_tmpPath, bridges._OPENCODE_FILENAME);
    _write_fake_plugin(plugin_path, bridges.OPENCODE_PLUGIN_TS);
    vi.spyOn(bridges, "opencode_plugins_dir").mockReturnValue(_tmpPath);
    const result = bridges.uninstall_opencode_plugin();
    expect(fs.existsSync(plugin_path)).toBe(false);
    expect(result).toContain("removed");
  });

  it("test_uninstall_not_found", () => {
    vi.spyOn(bridges, "opencode_plugins_dir").mockReturnValue(_tmpPath);
    const result = bridges.uninstall_opencode_plugin();
    expect(result).toBe("not found");
  });

  it("test_check_not_installed", () => {
    vi.spyOn(bridges, "opencode_plugins_dir").mockReturnValue(_tmpPath);
    const result = bridges._check_opencode_plugin();
    expect(result).toBe("not installed");
  });

  it("test_check_installed", () => {
    const plugin_path = path.join(_tmpPath, bridges._OPENCODE_FILENAME);
    _write_fake_plugin(plugin_path, bridges.OPENCODE_PLUGIN_TS);
    vi.spyOn(bridges, "opencode_plugins_dir").mockReturnValue(_tmpPath);
    const result = bridges._check_opencode_plugin();
    expect(result).toBe("installed");
  });

  it("test_check_foreign_file", () => {
    const plugin_path = path.join(_tmpPath, bridges._OPENCODE_FILENAME);
    _write_fake_plugin(plugin_path, "// some other plugin");
    vi.spyOn(bridges, "opencode_plugins_dir").mockReturnValue(_tmpPath);
    const result = bridges._check_opencode_plugin();
    expect(result).toContain("not token-goat bridge");
  });

  it("test_check_after_install", () => {
    vi.spyOn(bridges, "opencode_plugins_dir").mockReturnValue(_tmpPath);
    bridges.install_opencode_plugin();
    const result = bridges._check_opencode_plugin();
    expect(result).toBe("installed");
  });

  it("test_check_after_uninstall", () => {
    vi.spyOn(bridges, "opencode_plugins_dir").mockReturnValue(_tmpPath);
    bridges.install_opencode_plugin();
    bridges.uninstall_opencode_plugin();
    const result = bridges._check_opencode_plugin();
    expect(result).toBe("not installed");
  });
});

// ---------------------------------------------------------------------------
// Openclaw install / uninstall / check
// ---------------------------------------------------------------------------

describe("TestOpenclawPlugin", () => {
  /**
   * Python's TestOpenclawPlugin._patch returns two context managers patching
   * openclaw_plugins_dir and openclaw_config_path. The TS analogue installs both
   * spies and returns the resolved dirs/paths for the test body.
   */
  function _patch(tmp_path: string): { plugins_dir: string; cfg_path: string } {
    const plugins_dir = path.join(tmp_path, "plugins");
    const cfg_path = path.join(tmp_path, "openclaw.json");
    vi.spyOn(bridges, "openclaw_plugins_dir").mockReturnValue(plugins_dir);
    vi.spyOn(bridges, "openclaw_config_path").mockReturnValue(cfg_path);
    return { plugins_dir, cfg_path };
  }

  it("test_install_writes_plugin_file", () => {
    _patch(_tmpPath);
    const path_str = bridges.install_openclaw_plugin();
    expect(fs.readFileSync(path_str, "utf-8")).toBe(bridges.OPENCLAW_PLUGIN_TS);
  });

  it("test_install_registers_in_config", () => {
    _patch(_tmpPath);
    bridges.install_openclaw_plugin();
    const cfg = JSON.parse(
      fs.readFileSync(path.join(_tmpPath, "openclaw.json"), "utf-8"),
    ) as Record<string, any>;
    const entries = cfg["plugins"]["entries"];
    expect(Object.prototype.hasOwnProperty.call(entries, bridges._OPENCLAW_PLUGIN_ID)).toBe(true);
    const entry = entries[bridges._OPENCLAW_PLUGIN_ID];
    expect(entry["enabled"]).toBe(true);
    expect(Object.prototype.hasOwnProperty.call(entry, "path")).toBe(true);
  });

  it("test_install_merges_existing_config", () => {
    const cfg_path = path.join(_tmpPath, "openclaw.json");
    fs.mkdirSync(path.dirname(cfg_path), { recursive: true });
    fs.writeFileSync(
      cfg_path,
      JSON.stringify({ other: "value", plugins: { entries: { "other-plugin": { enabled: true } } } }),
      "utf-8",
    );
    _patch(_tmpPath);
    bridges.install_openclaw_plugin();
    const cfg = JSON.parse(fs.readFileSync(cfg_path, "utf-8")) as Record<string, any>;
    expect(cfg["other"]).toBe("value");
    expect(Object.prototype.hasOwnProperty.call(cfg["plugins"]["entries"], "other-plugin")).toBe(true);
    expect(Object.prototype.hasOwnProperty.call(cfg["plugins"]["entries"], bridges._OPENCLAW_PLUGIN_ID)).toBe(true);
  });

  it("test_install_handles_corrupt_config", () => {
    const cfg_path = path.join(_tmpPath, "openclaw.json");
    fs.mkdirSync(path.dirname(cfg_path), { recursive: true });
    fs.writeFileSync(cfg_path, "not valid json {{{{", "utf-8");
    _patch(_tmpPath);
    // Should not raise; recovers from corrupt config
    bridges.install_openclaw_plugin();
    const cfg = JSON.parse(fs.readFileSync(cfg_path, "utf-8")) as Record<string, any>;
    expect(Object.prototype.hasOwnProperty.call(cfg["plugins"]["entries"], bridges._OPENCLAW_PLUGIN_ID)).toBe(true);
  });

  it("test_install_creates_parent_dirs", () => {
    const nested_plugins = path.join(_tmpPath, "deep", "plugins");
    const cfg_path = path.join(_tmpPath, "deep", "openclaw.json");
    vi.spyOn(bridges, "openclaw_plugins_dir").mockReturnValue(nested_plugins);
    vi.spyOn(bridges, "openclaw_config_path").mockReturnValue(cfg_path);
    bridges.install_openclaw_plugin();
    expect(fs.existsSync(nested_plugins)).toBe(true);
  });

  it("test_uninstall_removes_file_and_deregisters", () => {
    _patch(_tmpPath);
    bridges.install_openclaw_plugin();
    const result = bridges.uninstall_openclaw_plugin();
    const pluginsDir = path.join(_tmpPath, "plugins");
    if (fs.existsSync(pluginsDir)) {
      const names = fs.readdirSync(pluginsDir);
      expect(names).not.toContain(bridges._OPENCLAW_FILENAME);
    }
    expect(result).toContain("deregistered");
  });

  it("test_uninstall_not_found", () => {
    _patch(_tmpPath);
    const result = bridges.uninstall_openclaw_plugin();
    expect(result).toBe("not found");
  });

  it("test_uninstall_removes_only_our_entry", () => {
    const cfg_path = path.join(_tmpPath, "openclaw.json");
    fs.mkdirSync(path.dirname(cfg_path), { recursive: true });
    fs.writeFileSync(
      cfg_path,
      JSON.stringify({ plugins: { entries: { "other-plugin": { enabled: true } } } }),
      "utf-8",
    );
    _patch(_tmpPath);
    bridges.install_openclaw_plugin();
    bridges.uninstall_openclaw_plugin();
    const cfg = JSON.parse(fs.readFileSync(cfg_path, "utf-8")) as Record<string, any>;
    expect(Object.prototype.hasOwnProperty.call(cfg["plugins"]["entries"], "other-plugin")).toBe(true);
    expect(Object.prototype.hasOwnProperty.call(cfg["plugins"]["entries"], bridges._OPENCLAW_PLUGIN_ID)).toBe(false);
  });

  it("test_check_not_installed", () => {
    _patch(_tmpPath);
    const result = bridges._check_openclaw_plugin();
    expect(result).toBe("not installed");
  });

  it("test_check_installed", () => {
    _patch(_tmpPath);
    bridges.install_openclaw_plugin();
    const result = bridges._check_openclaw_plugin();
    expect(result).toBe("installed");
  });

  it("test_check_file_present_not_registered", () => {
    const plugins_dir = path.join(_tmpPath, "plugins");
    const plugin_path = path.join(plugins_dir, bridges._OPENCLAW_FILENAME);
    _write_fake_plugin(plugin_path, bridges.OPENCLAW_PLUGIN_TS);
    const cfg_path = path.join(_tmpPath, "openclaw.json");
    vi.spyOn(bridges, "openclaw_plugins_dir").mockReturnValue(plugins_dir);
    vi.spyOn(bridges, "openclaw_config_path").mockReturnValue(cfg_path);
    const result = bridges._check_openclaw_plugin();
    expect(result).toContain("not registered");
  });

  it("test_check_registered_but_file_missing", () => {
    const cfg_path = path.join(_tmpPath, "openclaw.json");
    fs.mkdirSync(path.dirname(cfg_path), { recursive: true });
    fs.writeFileSync(
      cfg_path,
      JSON.stringify({ plugins: { entries: { [bridges._OPENCLAW_PLUGIN_ID]: { enabled: true } } } }),
      "utf-8",
    );
    _patch(_tmpPath);
    const result = bridges._check_openclaw_plugin();
    expect(result).toContain("missing");
  });

  it("test_check_foreign_file", () => {
    const plugins_dir = path.join(_tmpPath, "plugins");
    const cfg_path = path.join(_tmpPath, "openclaw.json");
    const plugin_path = path.join(plugins_dir, bridges._OPENCLAW_FILENAME);
    _write_fake_plugin(plugin_path, "// some other plugin entirely");
    fs.mkdirSync(path.dirname(cfg_path), { recursive: true });
    fs.writeFileSync(
      cfg_path,
      JSON.stringify({ plugins: { entries: { [bridges._OPENCLAW_PLUGIN_ID]: { enabled: true } } } }),
      "utf-8",
    );
    vi.spyOn(bridges, "openclaw_plugins_dir").mockReturnValue(plugins_dir);
    vi.spyOn(bridges, "openclaw_config_path").mockReturnValue(cfg_path);
    const result = bridges._check_openclaw_plugin();
    expect(result).toContain("not token-goat bridge");
  });

  it("test_check_after_uninstall", () => {
    _patch(_tmpPath);
    bridges.install_openclaw_plugin();
    bridges.uninstall_openclaw_plugin();
    const result = bridges._check_openclaw_plugin();
    expect(result).toBe("not installed");
  });
});

// ---------------------------------------------------------------------------
// Pi install / uninstall / check
// ---------------------------------------------------------------------------

describe("TestPiPlugin", () => {
  it("test_install_writes_file", () => {
    vi.spyOn(bridges, "pi_extensions_dir").mockReturnValue(
      path.join(_tmpPath, "extensions"),
    );
    const path_str = bridges.install_pi_plugin();
    const written = path_str;
    expect(fs.existsSync(written)).toBe(true);
    expect(fs.readFileSync(written, "utf-8")).toBe(bridges.PI_EXTENSION_TS);
  });

  it("test_install_creates_parent_dirs", () => {
    const nested = path.join(_tmpPath, "a", "b", "extensions");
    vi.spyOn(bridges, "pi_extensions_dir").mockReturnValue(nested);
    bridges.install_pi_plugin();
    expect(fs.existsSync(nested)).toBe(true);
  });

  it("test_install_returns_path_string", () => {
    vi.spyOn(bridges, "pi_extensions_dir").mockReturnValue(_tmpPath);
    const result = bridges.install_pi_plugin();
    expect(typeof result).toBe("string");
    expect(result).toContain("token-goat.ts");
  });

  it("test_install_target_dir_overrides_global", () => {
    // Project-local install: target_dir wins over pi_extensions_dir().
    const proj = path.join(_tmpPath, "proj", ".pi", "extensions");
    const global_dir = path.join(_tmpPath, "global");
    vi.spyOn(bridges, "pi_extensions_dir").mockReturnValue(global_dir);
    const path_str = bridges.install_pi_plugin(proj);
    expect(path_str).toBe(path.join(proj, bridges._PI_FILENAME));
    expect(fs.existsSync(path.join(proj, bridges._PI_FILENAME))).toBe(true);
    expect(fs.existsSync(global_dir)).toBe(false);
  });

  it("test_install_is_idempotent", () => {
    vi.spyOn(bridges, "pi_extensions_dir").mockReturnValue(_tmpPath);
    bridges.install_pi_plugin();
    bridges.install_pi_plugin();
    expect(fs.existsSync(path.join(_tmpPath, bridges._PI_FILENAME))).toBe(true);
  });

  it("test_uninstall_removes_file", () => {
    const plugin_path = path.join(_tmpPath, bridges._PI_FILENAME);
    _write_fake_plugin(plugin_path, bridges.PI_EXTENSION_TS);
    vi.spyOn(bridges, "pi_extensions_dir").mockReturnValue(_tmpPath);
    const result = bridges.uninstall_pi_plugin();
    expect(fs.existsSync(plugin_path)).toBe(false);
    expect(result).toContain("removed");
  });

  it("test_uninstall_target_dir", () => {
    const proj = path.join(_tmpPath, "proj", ".pi", "extensions");
    bridges.install_pi_plugin(proj);
    const result = bridges.uninstall_pi_plugin(proj);
    expect(result).toContain("removed");
    expect(fs.existsSync(path.join(proj, bridges._PI_FILENAME))).toBe(false);
  });

  it("test_uninstall_not_found", () => {
    vi.spyOn(bridges, "pi_extensions_dir").mockReturnValue(_tmpPath);
    const result = bridges.uninstall_pi_plugin();
    expect(result).toBe("not found");
  });

  it("test_check_not_installed", () => {
    vi.spyOn(bridges, "pi_extensions_dir").mockReturnValue(_tmpPath);
    const result = bridges._check_pi_plugin();
    expect(result).toBe("not installed");
  });

  it("test_check_installed", () => {
    const plugin_path = path.join(_tmpPath, bridges._PI_FILENAME);
    _write_fake_plugin(plugin_path, bridges.PI_EXTENSION_TS);
    vi.spyOn(bridges, "pi_extensions_dir").mockReturnValue(_tmpPath);
    const result = bridges._check_pi_plugin();
    expect(result).toBe("installed");
  });

  it("test_check_foreign_file", () => {
    const plugin_path = path.join(_tmpPath, bridges._PI_FILENAME);
    _write_fake_plugin(plugin_path, "// some other extension");
    vi.spyOn(bridges, "pi_extensions_dir").mockReturnValue(_tmpPath);
    const result = bridges._check_pi_plugin();
    expect(result).toContain("not token-goat bridge");
  });

  it("test_check_after_install_uninstall", () => {
    vi.spyOn(bridges, "pi_extensions_dir").mockReturnValue(_tmpPath);
    bridges.install_pi_plugin();
    expect(bridges._check_pi_plugin()).toBe("installed");
    bridges.uninstall_pi_plugin();
    expect(bridges._check_pi_plugin()).toBe("not installed");
  });
});

// ---------------------------------------------------------------------------
// install.py integration: check_status, install_all, uninstall_all
// ---------------------------------------------------------------------------

describe("TestInstallIntegration", () => {
  // PORT: deferred — these tests import token_goat.install (not yet ported to
  // TS) and patch its check_status / install_all / uninstall_all entry points
  // plus the platform-specific install/uninstall helpers.
  it.skip("test_check_status_includes_opencode", () => {});
  it.skip("test_check_status_includes_openclaw", () => {});
  it.skip("test_check_status_includes_pi", () => {});
  it.skip("test_install_all_pi_called_when_flag_set", () => {});
  it.skip("test_install_all_pi_via_target", () => {});
  it.skip("test_install_all_pi_not_called_without_flag", () => {});
  it.skip("test_uninstall_all_pi_called_when_flag_set", () => {});
  it.skip("test_install_all_pi_fail_soft", () => {});
  it.skip("test_install_all_opencode_called_when_flag_set", () => {});
  it.skip("test_install_all_openclaw_called_when_flag_set", () => {});
  it.skip("test_install_all_bridges_not_called_without_flags", () => {});
  it.skip("test_uninstall_all_opencode_called_when_flag_set", () => {});
  it.skip("test_uninstall_all_openclaw_called_when_flag_set", () => {});
  it.skip("test_uninstall_all_bridges_not_called_without_flags", () => {});
  it.skip("test_install_all_opencode_fail_soft", () => {});
});
