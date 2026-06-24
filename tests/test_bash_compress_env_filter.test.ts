/**
 * Tests for EnvFilter — env/printenv environment-variable dump compression.
 *
 * 1:1 port of tests/test_bash_compress_env_filter.py. Every Python `def
 * test_*` maps to a vitest `it()` with the SAME name and assertion polarity;
 * the Python TestEnvFilter class maps to a `describe()` block of the same name.
 *
 * Run 9 un-defer: EnvFilter now ships in
 * ../src/token_goat/bash_compress/tail_filters.ts (Python registry position
 * ~150) and is re-exported via the barrel, so every previously-it.skip case is
 * now a live assertion. The helper + fixtures below were preserved verbatim
 * from the deferred stub and are exercised directly now.
 *
 * Test-seam mapping (Python -> TS):
 *  - `from filter_test_helpers import apply_filter as _compress`
 *      -> local `_compress(filter, stdout, opts?)` helper below; runs
 *        `filter_.apply(stdout, stderr, exit_code, argv).text`, defaulting argv
 *        to `[filter_.name]` (matching the Python helper exactly).
 *  - `from token_goat import bash_compress as bc`
 *      -> import the barrel "../src/token_goat/bash_compress.js" as `bc`
 *        (re-exports EnvFilter + select_filter).
 *  - Class-body `F = bc.EnvFilter()` -> `const F = new bc.EnvFilter()` inside
 *    each it() (fresh instance per test, matching Python's class-attribute F).
 *
 * FilterTestMixin injects `test_empty_input` / `test_empty_output` into every
 * subclass; this Python class overrides `test_empty_output_passes_through`
 * explicitly and the suite as written does not name `test_empty_input`, so only
 * the explicit `def test_*` methods are reproduced here.
 *
 * Byte-exactness: the assertions are substring `in` / `not in` checks plus two
 * regex counts on the suppression marker (`N env vars suppressed` and
 * `(M total)`). The fixtures are pure ASCII so Python `len` (code points)
 * equals JS `.length`; no Buffer arithmetic is needed.
 */
import { describe, expect, it } from "vitest";

import * as bc from "../src/token_goat/bash_compress.js";
import { EnvFilter, select_filter } from "../src/token_goat/bash_compress.js";

import type { Filter } from "../src/token_goat/bash_compress.js";

// ---------------------------------------------------------------------------
// Local apply_filter helper (port of filter_test_helpers.apply_filter, aliased
// as `_compress` at the Python import site). When argv is omitted the filter's
// own `.name` is used as the sole argv element.
// ---------------------------------------------------------------------------
function _compress(
  filter_: Filter,
  stdout = "",
  opts?: { stderr?: string; exit_code?: number; argv?: string[] },
): string {
  const stderr = opts?.stderr ?? "";
  const exit_code = opts?.exit_code ?? 0;
  const argv = opts?.argv ?? [filter_.name];
  return filter_.apply(stdout, stderr, exit_code, argv).text;
}

// ---------------------------------------------------------------------------
// Fixture data (verbatim from the Python module).
// ---------------------------------------------------------------------------

// A short env dump (<=20 vars) — should pass through unchanged.
const _SHORT_ENV =
  [
    "HOME=/home/user",
    "SHELL=/bin/bash",
    "USER=alice",
    "TERM=xterm-256color",
    "LANG=en_US.UTF-8",
    "PWD=/home/user/projects",
  ].join("\n") + "\n";

// A large realistic env dump (>20 vars) with a mix of keep/suppress vars.
const _LARGE_ENV_LINES = [
  "HOME=/home/user",
  "SHELL=/bin/bash",
  "USER=alice",
  "LOGNAME=alice",
  "USERNAME=alice",
  "TERM=xterm-256color",
  "LANG=en_US.UTF-8",
  "LC_ALL=en_US.UTF-8",
  "TZ=UTC",
  "PATH=/usr/local/bin:/usr/bin:/bin",
  "PWD=/home/user/projects",
  "OLDPWD=/home/user",
  "VIRTUAL_ENV=/home/user/.venv",
  "VIRTUAL_ENV_PROMPT=(.venv)",
  "PYTHONPATH=/home/user/lib",
  "NODE_ENV=production",
  "NODE_VERSION=20.11.0",
  "GOPATH=/home/user/go",
  "CARGO_HOME=/home/user/.cargo",
  "JAVA_HOME=/usr/lib/jvm/java-17",
  // suppressed below this line
  "SHLVL=2",
  "LS_COLORS=rs=0:di=01;34:ln=01;36:mh=00:pi=40;33:so=01;35",
  "DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/1000/bus",
  "XDG_RUNTIME_DIR=/run/user/1000",
  "XDG_SESSION_TYPE=x11",
  "DESKTOP_SESSION=gnome",
  "DISPLAY=:0",
  "WINDOWID=12345678",
  "XAUTHORITY=/home/user/.Xauthority",
  "GPG_AGENT_INFO=/run/user/1000/gnupg/S.gpg-agent:0:1",
  "SSH_AUTH_SOCK=/tmp/ssh-abc123/agent.1234",
  "QT_ACCESSIBILITY=1",
  "LESSOPEN=| /usr/bin/lesspipe %s",
];
const _LARGE_ENV = _LARGE_ENV_LINES.join("\n") + "\n";

// Env dump with GITHUB_ prefix vars — should all be kept.
const _CI_ENV_LINES = [
  ..._LARGE_ENV_LINES,
  "GITHUB_ACTIONS=true",
  "GITHUB_RUN_ID=12345",
  "GITHUB_REF=refs/heads/main",
  "AWS_REGION=us-east-1",
  "TF_VAR_env=production",
];
const _CI_ENV = _CI_ENV_LINES.join("\n") + "\n";

// ===========================================================================
// TestEnvFilter
// ===========================================================================

describe("TestEnvFilter", () => {
  // --- matches -----------------------------------------------------------

  it("test_matches_env", () => {
    const F = new EnvFilter();
    expect(F.matches(["env"])).toBe(true);
  });

  it("test_matches_printenv", () => {
    const F = new EnvFilter();
    expect(F.matches(["printenv"])).toBe(true);
  });

  it("test_no_match_export", () => {
    const F = new EnvFilter();
    expect(F.matches(["export"])).toBe(false);
  });

  it("test_no_match_set", () => {
    const F = new EnvFilter();
    expect(F.matches(["set"])).toBe(false);
  });

  it("test_no_match_bash", () => {
    const F = new EnvFilter();
    expect(F.matches(["bash", "-c", "env"])).toBe(false);
  });

  // --- passthrough (short dump) ------------------------------------------

  it("test_short_dump_passes_through", () => {
    const F = new EnvFilter();
    const out = _compress(F, _SHORT_ENV);
    expect(out).toContain("HOME=/home/user");
    // No suppression marker for short dumps.
    expect(out).not.toContain("token-goat");
  });

  it("test_empty_output_passes_through", () => {
    const F = new EnvFilter();
    const out = _compress(F, "");
    expect(out === "" || !out.includes("token-goat")).toBe(true);
  });

  // --- compression of large dump -----------------------------------------

  it("test_large_dump_compressed", () => {
    const F = new EnvFilter();
    const out = _compress(F, _LARGE_ENV);
    expect(out).toContain("token-goat");
    expect(out).toContain("suppressed");
  });

  it("test_keep_path", () => {
    const F = new EnvFilter();
    const out = _compress(F, _LARGE_ENV);
    expect(out).toContain("PATH=/usr/local/bin");
  });

  it("test_keep_virtual_env", () => {
    const F = new EnvFilter();
    const out = _compress(F, _LARGE_ENV);
    expect(out).toContain("VIRTUAL_ENV=/home/user/.venv");
  });

  it("test_keep_node_env", () => {
    const F = new EnvFilter();
    const out = _compress(F, _LARGE_ENV);
    expect(out).toContain("NODE_ENV=production");
  });

  it("test_keep_home_and_user", () => {
    const F = new EnvFilter();
    const out = _compress(F, _LARGE_ENV);
    expect(out).toContain("HOME=/home/user");
    expect(out).toContain("USER=alice");
  });

  it("test_suppress_noise_vars", () => {
    const F = new EnvFilter();
    const out = _compress(F, _LARGE_ENV);
    // Noise vars should be gone.
    expect(out).not.toContain("SHLVL=2");
    expect(out).not.toContain("LS_COLORS=");
    expect(out).not.toContain("DBUS_SESSION_BUS_ADDRESS=");
    expect(out).not.toContain("DISPLAY=:0");
  });

  it("test_suppression_count_in_marker", () => {
    const F = new EnvFilter();
    const out = _compress(F, _LARGE_ENV);
    // Should mention the count of suppressed vars.
    const m = /(\d+) env vars suppressed/.exec(out);
    expect(m).not.toBeNull();
    const suppressed_count = Number(m![1]);
    expect(suppressed_count).toBeGreaterThan(0);
  });

  it("test_total_count_in_marker", () => {
    const F = new EnvFilter();
    const out = _compress(F, _LARGE_ENV);
    const m = /\((\d+) total\)/.exec(out);
    expect(m).not.toBeNull();
    const total = Number(m![1]);
    expect(total).toBe(_LARGE_ENV_LINES.length);
  });

  it("test_keep_github_prefix", () => {
    const F = new EnvFilter();
    const out = _compress(F, _CI_ENV);
    expect(out).toContain("GITHUB_ACTIONS=true");
    expect(out).toContain("GITHUB_RUN_ID=12345");
    expect(out).toContain("GITHUB_REF=refs/heads/main");
  });

  it("test_keep_aws_prefix", () => {
    const F = new EnvFilter();
    const out = _compress(F, _CI_ENV);
    expect(out).toContain("AWS_REGION=us-east-1");
  });

  it("test_keep_tf_prefix", () => {
    const F = new EnvFilter();
    const out = _compress(F, _CI_ENV);
    expect(out).toContain("TF_VAR_env=production");
  });

  it("test_keep_gopath", () => {
    const F = new EnvFilter();
    const out = _compress(F, _LARGE_ENV);
    expect(out).toContain("GOPATH=/home/user/go");
  });

  it("test_keep_cargo_home", () => {
    const F = new EnvFilter();
    const out = _compress(F, _LARGE_ENV);
    expect(out).toContain("CARGO_HOME=/home/user/.cargo");
  });

  it("test_keep_java_home", () => {
    const F = new EnvFilter();
    const out = _compress(F, _LARGE_ENV);
    expect(out).toContain("JAVA_HOME=/usr/lib/jvm/java-17");
  });

  // --- select_filter dispatch for bare `env` -----------------------------

  it("test_select_filter_bare_env", () => {
    const f = select_filter(["env"]);
    expect(f).not.toBeNull();
    expect(f!.name).toBe("env");
  });

  it("test_select_filter_printenv", () => {
    const f = select_filter(["printenv"]);
    expect(f).not.toBeNull();
    expect(f!.name).toBe("env");
  });

  it("test_select_filter_env_dash_zero", () => {
    // `env -0` (NUL-separated output) should still route to EnvFilter.
    const f = select_filter(["env", "-0"]);
    expect(f).not.toBeNull();
    expect(f!.name).toBe("env");
  });
});

// Keep the bc namespace import observable (mirrors the k8s/ruby_cmake
// templates which import `* as bc` for select_filter parity). select_filter is
// also imported by name above; the bc binding is retained for future parity
// additions that dispatch through the barrel namespace.
void bc;
