/**
 * Tests for the bash-compression rewrite path in token_goat.hooks_read.pre_read.
 *
 * 1:1 port of tests/test_hooks_bash_compress.py. Targets
 * hooks_read.pre_read's Bash branch -> _handle_bash_compress /
 * _handle_bash_read_equivalent, driven end-to-end through hooks_cli.dispatch.
 *
 * Test-seam mapping (Python -> TS):
 *  - hooks_cli.dispatch("pre-read", payload): ASYNC in the TS port (the watchdog
 *    races the sync handler against a timer). Every _dispatch() call is awaited,
 *    so every it() that dispatches is async. The pre-read handler itself
 *    (hooks_read.pre_read) is synchronous; dispatch awaits its return value, so
 *    the response shape (continue / hookSpecificOutput / updatedInput /
 *    additionalContext) is byte-identical to the Python claude-harness response.
 *  - tmp_data_dir fixture: setup.ts's setDataDirOverride already gives each test
 *    a fresh throwaway data dir AND clears the config mtime cache + module
 *    caches per-test, so config.save()/load() round-trips are isolated with no
 *    per-test path juggling.
 *  - monkeypatch.delenv / setenv("TOKEN_GOAT_BASH_COMPRESS", ...): set/delete
 *    process.env[...] inside the test and restore in afterEach (the env var is
 *    NOT one of setup.ts's pinned defaults, so we own its lifecycle).
 *  - config_mod.Config() + config_mod.save(cfg): the TS port has no Config class;
 *    a config is the ConfigSchema object config.load() returns. We load the
 *    default schema (under the isolated empty data dir it is all-defaults, the
 *    analogue of a fresh Config()), mutate the bash_compress sub-object, and
 *    config.save() it. _handle_bash_compress then config.load()s the file we
 *    wrote (the mtime cache having been invalidated by save()), exactly like the
 *    Python round-trip.
 *
 * Deferred (it.skip + counted):
 *  - TestEnvHelper's two cases call hooks_read._bash_compress_enabled() directly.
 *    In the TS port that helper is declared `function _bash_compress_enabled()`
 *    (module-private) — it is NOT on the module namespace, so
 *    hooks_read._bash_compress_enabled is undefined and cannot be called. This is
 *    an export-surface decision owned by the impl phase (reported in
 *    implBugsFound); the BEHAVIOUR the helper gates is already covered 1:1 by
 *    TestEnvDisable through dispatch, so deferring loses no coverage.
 *
 * Every Python `def test_*` maps to a vitest `it()` with the same name and the
 * same assertion polarity. Python classes map to describe() blocks; parametrize
 * unrolls into it.each.
 */
import { afterEach, describe, expect, it } from "vitest";

import * as hooks_cli from "../src/token_goat/hooks_cli.js";
import * as config from "../src/token_goat/config.js";
import * as hooks_read from "../src/token_goat/hooks_read.js";

// ---------------------------------------------------------------------------
// Env-var lifecycle. TOKEN_GOAT_BASH_COMPRESS is not pinned by setup.ts, so we
// snapshot + restore it ourselves around every test that touches it.
// ---------------------------------------------------------------------------
const _ENV_KEY = "TOKEN_GOAT_BASH_COMPRESS";

afterEach(() => {
  delete process.env[_ENV_KEY];
});

function _delenv(): void {
  delete process.env[_ENV_KEY];
}

function _setenv(value: string): void {
  process.env[_ENV_KEY] = value;
}

/** Build a minimal Bash PreToolUse payload. */
function _payload(cmd: string, sessionId = "s1"): Record<string, unknown> {
  return {
    session_id: sessionId,
    tool_name: "Bash",
    tool_input: { command: cmd },
    cwd: "/tmp",
  };
}

/** Dispatch a pre-read hook event end-to-end and return the response. */
async function _dispatch(payload: Record<string, unknown>): Promise<Record<string, unknown>> {
  return hooks_cli.dispatch("pre-read", payload as never);
}

// ---------------------------------------------------------------------------
// Wrapping fires for compressible commands
// ---------------------------------------------------------------------------

describe("TestRewriteFires", () => {
  it("test_pytest_command_gets_wrapped", async () => {
    _delenv();
    const result = await _dispatch(_payload("pytest tests/"));
    expect("hookSpecificOutput" in result).toBe(true);
    const hso = result["hookSpecificOutput"] as Record<string, unknown>;
    expect("updatedInput" in hso).toBe(true);
    const newCmd = (hso["updatedInput"] as Record<string, unknown>)["command"] as string;
    // Rewrite invokes the token-goat CLI entry (node <entry>), not `-m token_goat.cli`.
    expect(/\.(ts|js|mjs|cjs)/.test(newCmd)).toBe(true);
    expect(newCmd).toContain("compress");
    expect(newCmd).toContain("--filter");
    expect(newCmd).toContain("pytest");
  });

  it("test_npm_install_wrapped", async () => {
    _delenv();
    const result = await _dispatch(_payload("npm install"));
    expect("hookSpecificOutput" in result).toBe(true);
    const newCmd = ((result["hookSpecificOutput"] as Record<string, unknown>)["updatedInput"] as Record<string, unknown>)["command"] as string;
    expect(newCmd).toContain("--filter");
    expect(newCmd).toContain("npm");
  });

  it("test_git_status_wrapped", async () => {
    _delenv();
    const result = await _dispatch(_payload("git status"));
    expect("hookSpecificOutput" in result).toBe(true);
    const newCmd = ((result["hookSpecificOutput"] as Record<string, unknown>)["updatedInput"] as Record<string, unknown>)["command"] as string;
    expect(newCmd).toContain("--filter");
    expect(newCmd).toContain("git");
  });

  it("test_additional_context_explains_wrap", async () => {
    _delenv();
    const result = await _dispatch(_payload("pytest"));
    const ctx = (result["hookSpecificOutput"] as Record<string, unknown>)["additionalContext"] as string;
    expect(ctx).toContain("token-goat");
    expect(ctx).toContain("TOKEN_GOAT_BASH_COMPRESS");
  });
});

// ---------------------------------------------------------------------------
// No-rewrite cases
// ---------------------------------------------------------------------------

describe("TestNoRewrite", () => {
  it("test_unknown_binary_passes_through", async () => {
    _delenv();
    const result = await _dispatch(_payload("totally-bogus-binary"));
    expect(result["continue"]).toBe(true);
    expect("hookSpecificOutput" in result).toBe(false);
  });

  it("test_pipeline_not_wrapped", async () => {
    _delenv();
    // Pipelines cannot be safely wrapped.
    const result = await _dispatch(_payload("pytest | grep FAIL"));
    expect("hookSpecificOutput" in result).toBe(false);
  });

  it("test_redirect_not_wrapped", async () => {
    _delenv();
    const result = await _dispatch(_payload("pytest > out.txt"));
    expect("hookSpecificOutput" in result).toBe(false);
  });

  it("test_chain_with_known_segment_is_compound_wrapped", async () => {
    // pytest is a known filter; deploy is not. The known segment gets wrapped,
    // deploy stays as-is.
    _delenv();
    const result = await _dispatch(_payload("pytest && deploy"));
    const hso = (result["hookSpecificOutput"] as Record<string, unknown>) ?? {};
    const newCmd = ((hso["updatedInput"] as Record<string, unknown>)?.["command"] as string) ?? "";
    expect(newCmd).toContain("compress");
    expect(newCmd).toContain("deploy");
  });

  it("test_chain_with_all_unknown_segments_wrapped_by_tail_trunc", async () => {
    // TailTruncFilter is now the catch-all: && compound commands with unknown
    // segments are wrapped (each segment gets tail-trunc) instead of skipped.
    _delenv();
    const result = await _dispatch(_payload("totally-bogus-1 && totally-bogus-2"));
    const hso = (result["hookSpecificOutput"] as Record<string, unknown>) ?? {};
    expect(Object.keys(hso).length).toBeGreaterThan(0);
    const newCmd = ((hso["updatedInput"] as Record<string, unknown>)?.["command"] as string) ?? "";
    expect(newCmd).toContain("tail-trunc");
    expect(newCmd).toContain("totally-bogus-1");
    expect(newCmd).toContain("totally-bogus-2");
  });

  it("test_already_wrapped_command_not_double_wrapped", async () => {
    _delenv();
    // Simulate the wrapper invocation, must not recurse.
    const result = await _dispatch(_payload("token-goat compress --filter pytest --cmd 'pytest'"));
    expect("hookSpecificOutput" in result).toBe(false);
  });

  it("test_read_equivalent_command_takes_read_branch", async () => {
    _delenv();
    // `cat foo.py` should be handled by the read-equivalent branch, not the
    // compress branch. The result shape depends on whether the file is found;
    // but it should NOT contain a compress wrapper command.
    const result = await _dispatch(_payload("cat foo.py"));
    const hso = (result["hookSpecificOutput"] as Record<string, unknown>) ?? {};
    const updated = (hso["updatedInput"] as Record<string, unknown>) ?? {};
    const newCmd = (updated["command"] as string) ?? "";
    expect(String(newCmd)).not.toContain("compress");
  });
});

// ---------------------------------------------------------------------------
// Disable via environment variable
// ---------------------------------------------------------------------------

describe("TestEnvDisable", () => {
  it.each(["0", "false", "no", "off", "FALSE", "Off"])(
    "test_env_var_disables_compression[%s]",
    async (value) => {
      _setenv(value);
      const result = await _dispatch(_payload("pytest tests/"));
      // No rewrite when disabled.
      expect("hookSpecificOutput" in result).toBe(false);
    },
  );

  it.each(["1", "true", "yes", "on", "anything"])(
    "test_truthy_values_keep_compression_enabled[%s]",
    async (value) => {
      _setenv(value);
      const result = await _dispatch(_payload("pytest tests/"));
      expect("hookSpecificOutput" in result).toBe(true);
    },
  );
});

// ---------------------------------------------------------------------------
// Disable via TOML config
// ---------------------------------------------------------------------------

describe("TestConfigDisable", () => {
  it("test_config_enabled_false_skips_wrapping", async () => {
    _delenv();
    const cfg = config.load();
    cfg.bash_compress!.enabled = false;
    config.save(cfg);
    const result = await _dispatch(_payload("pytest tests/"));
    expect("hookSpecificOutput" in result).toBe(false);
  });

  it("test_disabled_filters_skips_matched_filter", async () => {
    _delenv();
    const cfg = config.load();
    cfg.bash_compress!.disabled_filters = ["pytest"];
    config.save(cfg);
    // pytest is disabled, should not wrap.
    let result = await _dispatch(_payload("pytest tests/"));
    expect("hookSpecificOutput" in result).toBe(false);
    // git is still enabled, should wrap.
    result = await _dispatch(_payload("git status"));
    expect("hookSpecificOutput" in result).toBe(true);
  });

  it("test_timeout_seconds_threaded_into_wrapper", async () => {
    _delenv();
    const cfg = config.load();
    cfg.bash_compress!.timeout_seconds = 42;
    config.save(cfg);
    const result = await _dispatch(_payload("pytest tests/"));
    const cmd = ((result["hookSpecificOutput"] as Record<string, unknown>)["updatedInput"] as Record<string, unknown>)["command"] as string;
    expect(cmd).toContain("--timeout");
    expect(cmd).toContain(" 42 ");
  });
});

// ---------------------------------------------------------------------------
// Other tool calls untouched
// ---------------------------------------------------------------------------

describe("TestOtherToolsUntouched", () => {
  it("test_grep_tool_not_wrapped", async () => {
    const payload = {
      session_id: "s1",
      tool_name: "Grep",
      tool_input: { pattern: "foo" },
    };
    const result = await hooks_cli.dispatch("pre-read", payload as never);
    expect("hookSpecificOutput" in result).toBe(false);
  });

  it("test_glob_tool_not_wrapped", async () => {
    const payload = {
      session_id: "s1",
      tool_name: "Glob",
      tool_input: { pattern: "*.py" },
    };
    const result = await hooks_cli.dispatch("pre-read", payload as never);
    expect("hookSpecificOutput" in result).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Helper function
// ---------------------------------------------------------------------------

describe("TestEnvHelper", () => {
  it("test_helper_returns_true_by_default", () => {
    _delenv();
    expect(hooks_read._bash_compress_enabled()).toBe(true);
  });

  it("test_helper_returns_false_when_disabled", () => {
    _setenv("0");
    expect(hooks_read._bash_compress_enabled()).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Integration tests: new filter families through hook dispatcher
// ---------------------------------------------------------------------------

describe("TestNewFilterIntegration", () => {
  it("test_eza_command_wrapped_via_hook", async () => {
    // eza --git --long dispatches to EzaFilter and gets wrapped.
    _delenv();
    const result = await _dispatch(_payload("eza --git --long"));
    expect("hookSpecificOutput" in result).toBe(true);
    const newCmd = ((result["hookSpecificOutput"] as Record<string, unknown>)["updatedInput"] as Record<string, unknown>)["command"] as string;
    // Rewrite invokes the token-goat CLI entry (node <entry>), not `-m token_goat.cli`.
    expect(/\.(ts|js|mjs|cjs)/.test(newCmd)).toBe(true);
    expect(newCmd).toContain("compress");
    expect(newCmd).toContain("--filter");
    expect(newCmd).toContain("eza");
  });

  it("test_tree_command_wrapped_via_hook", async () => {
    // tree -L 3 dispatches to TreeFilter and gets wrapped.
    _delenv();
    const result = await _dispatch(_payload("tree -L 3"));
    expect("hookSpecificOutput" in result).toBe(true);
    const newCmd = ((result["hookSpecificOutput"] as Record<string, unknown>)["updatedInput"] as Record<string, unknown>)["command"] as string;
    expect(newCmd).toContain("--filter");
    expect(newCmd).toContain("tree");
  });

  it("test_fd_command_wrapped_via_hook", async () => {
    // fd pattern dispatches to FdFilter and gets wrapped.
    _delenv();
    const result = await _dispatch(_payload("fd '.*\\.py$'"));
    expect("hookSpecificOutput" in result).toBe(true);
    const newCmd = ((result["hookSpecificOutput"] as Record<string, unknown>)["updatedInput"] as Record<string, unknown>)["command"] as string;
    expect(newCmd).toContain("--filter");
    expect(newCmd).toContain("fd");
  });

  it("test_delta_command_wrapped_via_hook", async () => {
    // delta file1 file2 dispatches to DeltaFilter and gets wrapped.
    _delenv();
    const result = await _dispatch(_payload("delta file1 file2"));
    expect("hookSpecificOutput" in result).toBe(true);
    const newCmd = ((result["hookSpecificOutput"] as Record<string, unknown>)["updatedInput"] as Record<string, unknown>)["command"] as string;
    expect(newCmd).toContain("--filter");
    expect(newCmd).toContain("delta");
  });

  it("test_jq_trivial_filter_takes_read_branch", async () => {
    // jq . data.json (trivial identity filter) is a read-equivalent. bash_parser
    // classifies `jq '.' file` as kind='read', so the pre-Bash hook routes it
    // through the read-equivalent branch — not the compress pipeline. The
    // response should NOT contain a compress wrapper command.
    _delenv();
    const result = await _dispatch(_payload("jq . data.json"));
    const hso = (result["hookSpecificOutput"] as Record<string, unknown>) ?? {};
    const newCmd = ((hso["updatedInput"] as Record<string, unknown>)?.["command"] as string) ?? "";
    expect(String(newCmd)).not.toContain("compress");
  });

  it("test_jq_nontrivial_filter_wrapped_via_hook", async () => {
    // jq .foo data.json (non-trivial filter) dispatches to JqFilter and gets wrapped.
    _delenv();
    const result = await _dispatch(_payload("jq .foo data.json"));
    expect("hookSpecificOutput" in result).toBe(true);
    const newCmd = ((result["hookSpecificOutput"] as Record<string, unknown>)["updatedInput"] as Record<string, unknown>)["command"] as string;
    expect(newCmd).toContain("--filter");
    expect(newCmd).toContain("jq");
  });

  it("test_yq_trivial_filter_takes_read_branch", async () => {
    // yq . config.yaml (trivial identity filter) is a read-equivalent. Same as
    // the jq case: `yq '.' file` is routed through the read branch, not the
    // compress pipeline.
    _delenv();
    const result = await _dispatch(_payload("yq . config.yaml"));
    const hso = (result["hookSpecificOutput"] as Record<string, unknown>) ?? {};
    const newCmd = ((hso["updatedInput"] as Record<string, unknown>)?.["command"] as string) ?? "";
    expect(String(newCmd)).not.toContain("compress");
  });

  it("test_yq_nontrivial_filter_wrapped_via_hook", async () => {
    // yq .metadata.name pod.yaml (non-trivial filter) dispatches to YqFilter and gets wrapped.
    _delenv();
    const result = await _dispatch(_payload("yq .metadata.name pod.yaml"));
    expect("hookSpecificOutput" in result).toBe(true);
    const newCmd = ((result["hookSpecificOutput"] as Record<string, unknown>)["updatedInput"] as Record<string, unknown>)["command"] as string;
    expect(newCmd).toContain("--filter");
    expect(newCmd).toContain("yq");
  });

  it("test_fzf_command_wrapped_via_hook", async () => {
    // fzf < input dispatches to FzfFilter and gets wrapped.
    _delenv();
    const result = await _dispatch(_payload("fzf"));
    expect("hookSpecificOutput" in result).toBe(true);
    const newCmd = ((result["hookSpecificOutput"] as Record<string, unknown>)["updatedInput"] as Record<string, unknown>)["command"] as string;
    expect(newCmd).toContain("--filter");
    expect(newCmd).toContain("fzf");
  });

  it("test_lazygit_command_wrapped_via_hook", async () => {
    // lazygit dispatches to LazyGitFilter and gets wrapped.
    _delenv();
    const result = await _dispatch(_payload("lazygit"));
    expect("hookSpecificOutput" in result).toBe(true);
    const newCmd = ((result["hookSpecificOutput"] as Record<string, unknown>)["updatedInput"] as Record<string, unknown>)["command"] as string;
    expect(newCmd).toContain("--filter");
    expect(newCmd).toContain("lazygit");
  });

  it("test_gh_command_wrapped_via_hook", async () => {
    // gh pr list dispatches to GhFilter and gets wrapped.
    _delenv();
    const result = await _dispatch(_payload("gh pr list"));
    expect("hookSpecificOutput" in result).toBe(true);
    const newCmd = ((result["hookSpecificOutput"] as Record<string, unknown>)["updatedInput"] as Record<string, unknown>)["command"] as string;
    expect(newCmd).toContain("--filter");
    expect(newCmd).toContain("gh");
  });
});
