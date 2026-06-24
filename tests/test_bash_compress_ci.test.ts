/**
 * Tests for CI-related bash_compress filters.
 *
 * 1:1 port of tests/test_bash_compress_ci.py. Every Python `def test_*` maps to
 * a vitest `it()` with the SAME name and assertion polarity; the Python test
 * classes (TestGhRunLogFilter, TestActFilter, TestGenericCIFilter,
 * TestNodePackageFilterAudit, TestCIFiltersRegistered) map to `describe()`
 * blocks of the same name.
 *
 * Covers: GhRunLogFilter, ActFilter, GenericCIFilter, and npm audit improvements
 * in NodePackageFilter.
 *
 * Test-seam mapping (Python -> TS):
 *  - `from token_goat import bash_compress as bc`
 *      -> import the barrel "../src/token_goat/bash_compress.js" as `bc`
 *        (re-exports the framework + the CI filter classes + select_filter + the
 *        FILTERS registry).
 *  - Each Python test class has a `_filter(self)` factory returning a fresh
 *    filter instance; ported to a local `const f = bc.<Filter>()` per `it()`
 *    (matching the Python pattern where `_filter()` is called per-method).
 *  - The Python tests call `f.apply(stdout, stderr, exit_code, argv)` directly
 *    and read `.text`; the TS port calls `f.apply(...)` with the same positional
 *    args and reads `.text`.
 *  - `isinstance(f, bc.XFilter)` -> `f instanceof bc.XFilter`.
 *  - `json.dumps(data)` (CPython, indent=None) is reproduced for the npm-audit
 *    JSON fixtures via `_pyJsonDumps`: the default separators are ", " between
 *    items and ": " between key and value. The fixtures are flat-ish dicts of
 *    string/number values, so the recursive helper below reproduces the compact
 *    form CPython emits (which the filter then re-parses with JSON.parse, so the
 *    exact spacing only matters for the round-trip the filter performs).
 *  - `json.loads(result.text)` -> `JSON.parse(result.text)`.
 *  - `hasattr(bc, "GhRunLogFilter")` -> `"GhRunLogFilter" in bc`.
 *
 * Byte-exactness: these filters operate on whole lines and on substring markers
 * ("3 action(s) collapsed", "30 lines collapsed", "docker-pull progress lines",
 * "collapsed 20 DEBUG/TRACE", ...). The assertions are substring `in` / `not in`
 * checks on the returned string, matching the Python `in` / `not in` checks. The
 * fixtures are ASCII apart from a handful of status glyphs (✅ ❌), which are the
 * same Unicode codepoints as the Python source; no Buffer byte arithmetic is
 * needed for these particular tests.
 */
import { describe, expect, it } from "vitest";

import * as bc from "../src/token_goat/bash_compress.js";

// ---------------------------------------------------------------------------
// CPython json.dumps(data) (indent=None) for the npm-audit fixtures. Default
// separators: ", " between items, ": " between key and value. Keys in insertion
// order. The filter re-parses this with JSON.parse, so only the round-trip needs
// to be faithful — but we mirror CPython's compact form exactly for parity.
// ---------------------------------------------------------------------------
function _pyJsonDumps(value: unknown): string {
  if (value === null) {
    return "null";
  }
  if (typeof value === "number") {
    return String(value);
  }
  if (typeof value === "boolean") {
    return value ? "true" : "false";
  }
  if (typeof value === "string") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return "[" + value.map((v) => _pyJsonDumps(v)).join(", ") + "]";
  }
  if (typeof value === "object") {
    const obj = value as Record<string, unknown>;
    const parts = Object.keys(obj).map((k) => `${JSON.stringify(k)}: ${_pyJsonDumps(obj[k])}`);
    return "{" + parts.join(", ") + "}";
  }
  return JSON.stringify(value);
}

// ===========================================================================
// GhRunLogFilter
// ===========================================================================

describe("TestGhRunLogFilter", () => {
  const _filter = (): bc.GhRunLogFilter => new bc.GhRunLogFilter();

  // --- dispatch ---

  it("test_matches_gh_run_view_log", () => {
    const f = _filter();
    expect(f.matches(["gh", "run", "view", "123456789", "--log"])).toBe(true);
  });

  it("test_matches_gh_run_view_log_failed", () => {
    const f = _filter();
    expect(f.matches(["gh", "run", "view", "123456789", "--log", "--exit-status"])).toBe(true);
  });

  it("test_does_not_match_gh_run_view_without_log", () => {
    const f = _filter();
    expect(f.matches(["gh", "run", "view", "123456789"])).toBe(false);
  });

  it("test_does_not_match_gh_pr_view", () => {
    const f = _filter();
    expect(f.matches(["gh", "pr", "view", "42"])).toBe(false);
  });

  it("test_select_filter_returns_gh_run_log_filter", () => {
    // GhRunLogFilter must be registered before GhFilter in FILTERS.
    const f = bc.select_filter(["gh", "run", "view", "123456789", "--log"]);
    expect(f).toBeInstanceOf(bc.GhRunLogFilter);
  });

  it("test_plain_gh_run_view_still_uses_gh_filter", () => {
    const f = bc.select_filter(["gh", "run", "view", "123456789"]);
    expect(f).toBeInstanceOf(bc.GhFilter);
  });

  // --- timestamp stripping ---

  it("test_strips_iso8601_timestamp_prefix", () => {
    const stdout =
      "2024-01-15T12:34:56.1234567Z Set up job\n" +
      "2024-01-15T12:34:57.0000000Z Run actions/checkout@v4\n";
    const result = _filter().apply(stdout, "", 0, ["gh", "run", "view", "1", "--log"]);
    expect(result.text).not.toContain("2024-01-15T");
    expect(result.text).toContain("Set up job");
  });

  it("test_preserves_line_content_after_timestamp", () => {
    const stdout = "2024-06-01T00:00:00.0000000Z hello world\n";
    const result = _filter().apply(stdout, "", 0, ["gh", "run", "view", "1", "--log"]);
    expect(result.text).toContain("hello world");
  });

  // --- setup action collapsing ---

  it("test_collapses_setup_action_lines", () => {
    const lines = [
      "Run actions/checkout@v4",
      "Run actions/setup-node@v3",
      "Run actions/cache@v3",
    ];
    const stdout = lines.join("\n") + "\n";
    const result = _filter().apply(stdout, "", 0, ["gh", "run", "view", "1", "--log"]);
    // Individual action run lines should be gone; summary kept.
    expect(result.text).not.toContain("Run actions/checkout@v4");
    expect(result.text).toContain("3 action(s) collapsed");
  });

  // --- boilerplate dropping ---

  it("test_drops_boilerplate_lines", () => {
    const stdout =
      "Setting up runner\n" +
      "Runner version 2.313.0\n" +
      "Operating System     : Ubuntu 22.04\n" +
      "Actual step output here\n";
    const result = _filter().apply(stdout, "", 0, ["gh", "run", "view", "1", "--log"]);
    expect(result.text).not.toContain("Setting up runner");
    expect(result.text).not.toContain("Runner version");
    expect(result.text).toContain("Actual step output here");
  });

  // --- cleanup dropping ---

  it("test_drops_cleanup_lines", () => {
    const stdout =
      "Some useful log line\n" +
      "Post job cleanup.\n" +
      "Cleaning up orphan processes\n" +
      "Post Run actions/checkout@v4\n";
    const result = _filter().apply(stdout, "", 0, ["gh", "run", "view", "1", "--log"]);
    expect(result.text).not.toContain("Post job cleanup");
    expect(result.text).not.toContain("Cleaning up orphan processes");
    expect(result.text).not.toContain("Post Run");
    expect(result.text).toContain("Some useful log line");
  });

  // --- group collapsing ---

  it("test_collapses_large_passing_group", () => {
    const group_body = Array.from({ length: 30 }, (_, i) => `  line ${i}`).join("\n");
    const stdout = `##[group]Set up Python\n${group_body}\n##[endgroup]\n`;
    const result = _filter().apply(stdout, "", 0, ["gh", "run", "view", "1", "--log"]);
    // Should collapse the group since it has 30 lines and no failures.
    expect(result.text).toContain("Set up Python");
    expect(result.text).toContain("30 lines collapsed");
    expect(result.text).not.toContain("line 0");
  });

  it("test_preserves_group_with_failure", () => {
    const group_body = [
      ...Array.from({ length: 25 }, (_, i) => `  line ${i}`),
      "  Error: build failed",
    ].join("\n");
    const stdout = `##[group]Build\n${group_body}\n##[endgroup]\n`;
    const result = _filter().apply(stdout, "", 0, ["gh", "run", "view", "1", "--log"]);
    // Group has a failure — must NOT collapse.
    expect(result.text).toContain("Error: build failed");
  });

  it("test_preserves_small_group_verbatim", () => {
    const group_body = Array.from({ length: 5 }, (_, i) => `  step ${i}`).join("\n");
    const stdout = `##[group]Quick step\n${group_body}\n##[endgroup]\n`;
    const result = _filter().apply(stdout, "", 0, ["gh", "run", "view", "1", "--log"]);
    // Small group — should keep all lines.
    expect(result.text).toContain("step 0");
    expect(result.text).toContain("step 4");
  });

  // --- failure lines kept ---

  it("test_keeps_failure_lines_verbatim", () => {
    const stdout =
      "2024-01-01T00:00:00.0000000Z ##[error]Process completed with exit code 1\n" +
      "2024-01-01T00:00:01.0000000Z FAILED: tests/test_foo.py\n";
    const result = _filter().apply(stdout, "", 0, ["gh", "run", "view", "1", "--log"]);
    expect(result.text).toContain("Process completed with exit code 1");
    expect(result.text).toContain("FAILED: tests/test_foo.py");
  });

  // --- ##[command] echo dropping ---

  it("test_drops_command_echo_lines", () => {
    const stdout =
      "##[command]echo Hello\n" +
      "##[command]/bin/bash -e /runner/_temp/step.sh\n" +
      "Actual step output here\n";
    const result = _filter().apply(stdout, "", 0, ["gh", "run", "view", "1", "--log"]);
    // The raw command bodies must not appear, only the collapsed note may
    // mention "##[command]".
    expect(result.text).not.toContain("echo Hello");
    expect(result.text).not.toContain("/runner/_temp/step.sh");
    expect(result.text).toContain("Actual step output here");
    expect(result.text).toContain("##[command] echo lines");
  });

  it("test_command_echo_with_failure_signal_kept", () => {
    // A ##[command] line that contains an error signal must be preserved.
    const stdout = "##[command]echo 'Error: something went wrong'\n" + "Normal output\n";
    const result = _filter().apply(stdout, "", 0, ["gh", "run", "view", "1", "--log"]);
    // Contains 'Error:' — must not be dropped.
    expect(result.text).toContain("Error: something went wrong");
  });

  // --- step-name TAB prefix stripping ---

  it("test_strips_step_name_tab_prefix", () => {
    // Lines in `gh run view --log` real output have step-name\ttimestamp format.
    const stdout =
      "build (ubuntu-latest)\t2024-01-15T12:34:56.1234567Z Hello from step\n" +
      "test (ubuntu-latest)\t2024-01-15T12:34:57.0000000Z Test line\n";
    const result = _filter().apply(stdout, "", 0, ["gh", "run", "view", "1", "--log"]);
    // Step-name prefix and timestamp must both be stripped.
    expect(result.text).not.toContain("ubuntu-latest");
    expect(result.text).not.toContain("2024-01-15T");
    expect(result.text).toContain("Hello from step");
    expect(result.text).toContain("Test line");
  });

  // --- combined scenario ---

  it("test_combined_compression", () => {
    const lines = [
      "2024-01-01T00:00:00.0000000Z Setting up runner",
      "2024-01-01T00:00:01.0000000Z ##[group]Install dependencies",
    ];
    for (let i = 0; i < 25; i += 1) {
      lines.push(`2024-01-01T00:00:0${(i % 9) + 1}.0000000Z   npm install step ${i}`);
    }
    lines.push(
      "2024-01-01T00:00:30.0000000Z ##[endgroup]",
      "2024-01-01T00:00:31.0000000Z Run actions/setup-node@v3",
      "2024-01-01T00:00:32.0000000Z Post job cleanup.",
    );
    const stdout = lines.join("\n") + "\n";
    const result = _filter().apply(stdout, "", 0, ["gh", "run", "view", "1", "--log"]);
    // Timestamps gone.
    expect(result.text).not.toContain("2024-01-01T");
    // Boilerplate gone.
    expect(result.text).not.toContain("Setting up runner");
    // Group collapsed.
    expect(result.text).toContain("25 lines collapsed");
    // Setup action summarised.
    expect(result.text).toContain("action(s) collapsed");
    // Cleanup gone.
    expect(result.text).not.toContain("Post job cleanup");
  });
});

// ===========================================================================
// ActFilter
// ===========================================================================

describe("TestActFilter", () => {
  const _filter = (): bc.ActFilter => new bc.ActFilter();

  // --- dispatch ---

  it("test_matches_act", () => {
    const f = _filter();
    expect(f.matches(["act"])).toBe(true);
    expect(f.matches(["act", "-j", "test"])).toBe(true);
    expect(f.matches(["act", "push"])).toBe(true);
  });

  it("test_does_not_match_other_commands", () => {
    const f = _filter();
    expect(f.matches(["gh", "run", "view"])).toBe(false);
    expect(f.matches(["docker"])).toBe(false);
  });

  it("test_select_filter_returns_act_filter", () => {
    const f = bc.select_filter(["act", "-j", "build"]);
    expect(f).toBeInstanceOf(bc.ActFilter);
  });

  // --- prefix stripping ---

  it("test_strips_job_step_prefix_from_body_lines", () => {
    const stdout =
      "[build/install-deps] | npm install\n[build/install-deps] | added 100 packages\n";
    const result = _filter().apply(stdout, "", 0, ["act", "-j", "build"]);
    expect(result.text).not.toContain("[build/install-deps]");
    expect(result.text).toContain("npm install");
    expect(result.text).toContain("added 100 packages");
  });

  // --- status lines preserved ---

  it("test_keeps_success_status_line", () => {
    const stdout = "[build/run-tests] ✅\n";
    const result = _filter().apply(stdout, "", 0, ["act"]);
    expect(result.text).toContain("✅");
  });

  it("test_keeps_failure_status_line", () => {
    const stdout = "[build/run-tests] ❌\n";
    const result = _filter().apply(stdout, "", 0, ["act"]);
    expect(result.text).toContain("❌");
  });

  // --- docker pull collapsing ---

  it("test_collapses_docker_pull_progress", () => {
    const lines = [
      "[build/setup] | Pulling from library/node",
      "[build/setup] | Waiting",
      "[build/setup] | Pulling fs layer",
      "[build/setup] | Verifying Checksum",
      "[build/setup] | Pull complete",
      "[build/setup] | Digest: sha256:abc123",
      "[build/setup] | Status: Downloaded newer image",
    ];
    const stdout = lines.join("\n") + "\n";
    const result = _filter().apply(stdout, "", 0, ["act"]);
    expect(result.text).toContain("docker-pull progress lines");
    // No individual pull lines should remain.
    expect(result.text).not.toContain("Pulling fs layer");
    expect(result.text).not.toContain("Pull complete");
  });

  // --- matrix expansion collapsing ---

  it("test_collapses_matrix_expansion_lines", () => {
    const lines = [
      '[build/test] Matrix: {"os":"ubuntu-latest","node":"16"}',
      '[build/test] Matrix: {"os":"ubuntu-latest","node":"18"}',
      '[build/test] Matrix: {"os":"ubuntu-latest","node":"20"}',
    ];
    const stdout = lines.join("\n") + "\n";
    const result = _filter().apply(stdout, "", 0, ["act"]);
    expect(result.text).toContain("matrix expansion lines");
  });

  // --- failure lines kept verbatim ---

  it("test_keeps_failure_lines", () => {
    const stdout = "[build/test] | ERROR: test_foo.py::test_bar FAILED\n";
    const result = _filter().apply(stdout, "", 0, ["act"]);
    expect(result.text).toContain("FAILED");
  });

  // --- combined scenario ---

  it("test_combined_act_compression", () => {
    const lines = [
      "[build/setup] | Pulling from library/python",
      "[build/setup] | Pull complete",
      "[build/setup] | Digest: sha256:abc",
      "[build/run] | Running tests...",
      "[build/run] | test_foo ... ok",
      "[build/run] | FAILED: test_bar",
      "[build/run] ❌",
    ];
    const stdout = lines.join("\n") + "\n";
    const result = _filter().apply(stdout, "", 0, ["act"]);
    // Docker pull collapsed.
    expect(result.text).toContain("docker-pull");
    // Status lines kept.
    expect(result.text).toContain("❌");
    // Failure line kept.
    expect(result.text).toContain("FAILED: test_bar");
    // Normal body lines stripped of prefix.
    expect(result.text).toContain("Running tests...");
    // Prefix should only appear in status lines (❌ ✅) — not bare in body lines.
    // We verify by checking body lines (non-status lines) don't carry the prefix.
    const body_lines_with_prefix = result.text
      .split("\n")
      .filter(
        (ln) =>
          ln.includes("[build/") &&
          !["✅", "❌", "✓", "✗"].some((s) => ln.includes(s)),
      );
    expect(body_lines_with_prefix).toEqual([]);
  });
});

// ===========================================================================
// GenericCIFilter
// ===========================================================================

describe("TestGenericCIFilter", () => {
  const _filter = (): bc.GenericCIFilter => new bc.GenericCIFilter();

  // --- dispatch ---

  it("test_matches_on_log_flag", () => {
    const f = _filter();
    expect(f.matches(["some-ci-tool", "--log"])).toBe(true);
  });

  it("test_matches_on_logs_subcommand", () => {
    const f = _filter();
    expect(f.matches(["pipeline-cli", "logs", "--job", "build"])).toBe(true);
  });

  it("test_matches_on_pipeline_keyword", () => {
    const f = _filter();
    expect(f.matches(["ci-tool", "pipeline", "status"])).toBe(true);
  });

  it("test_matches_on_workflow_keyword", () => {
    const f = _filter();
    expect(f.matches(["tool", "workflow", "run"])).toBe(true);
  });

  it("test_does_not_match_plain_commands", () => {
    const f = _filter();
    expect(f.matches(["pytest", "-v"])).toBe(false);
    expect(f.matches(["npm", "install"])).toBe(false);
  });

  // --- timestamp stripping ---

  it("test_strips_iso8601_timestamp", () => {
    const stdout = "2024-06-15T10:30:00.000Z Build started\n2024-06-15T10:30:01.000Z Step 1\n";
    const result = _filter().apply(stdout, "", 0, ["tool", "--log"]);
    expect(result.text).not.toContain("2024-06-15T");
    expect(result.text).toContain("Build started");
    expect(result.text).toContain("Step 1");
  });

  it("test_strips_space_separated_datetime", () => {
    const stdout = "2024-06-15 10:30:00 INFO some message\n";
    const result = _filter().apply(stdout, "", 0, ["pipeline", "logs"]);
    expect(result.text).not.toContain("2024-06-15");
    expect(result.text).toContain("INFO some message");
  });

  it("test_strips_bracket_timestamp", () => {
    const stdout = "[2024-06-15T10:30:00Z] log entry\n";
    const result = _filter().apply(stdout, "", 0, ["tool", "--log"]);
    expect(result.text).not.toContain("[2024");
    expect(result.text).toContain("log entry");
  });

  // --- ANSI stripping ---

  it("test_strips_ansi_codes", () => {
    const stdout = "\x1b[32mINFO\x1b[0m: build succeeded\n";
    const result = _filter().apply(stdout, "", 0, ["tool", "--log"]);
    expect(result.text).not.toContain("\x1b[");
    expect(result.text).toContain("build succeeded");
  });

  // --- DEBUG/TRACE collapsing ---

  it("test_collapses_debug_lines", () => {
    const lines = Array.from({ length: 20 }, (_, i) => `DEBUG: connecting to host ${i}`);
    const stdout = lines.join("\n") + "\n";
    const result = _filter().apply(stdout, "", 0, ["tool", "--log"]);
    expect(result.text).not.toContain("DEBUG: connecting");
    expect(result.text).toContain("collapsed 20 DEBUG/TRACE");
  });

  it("test_collapses_trace_lines", () => {
    const lines = Array.from({ length: 15 }, (_, i) => `TRACE: frame ${i}`);
    const stdout = lines.join("\n") + "\n";
    const result = _filter().apply(stdout, "", 0, ["tool", "--log"]);
    expect(result.text).not.toContain("TRACE: frame");
    expect(result.text).toContain("collapsed 15 DEBUG/TRACE");
  });

  it("test_keeps_info_lines", () => {
    const stdout = "INFO: deployment complete\nINFO: pods healthy\n";
    const result = _filter().apply(stdout, "", 0, ["tool", "--log"]);
    expect(result.text).toContain("INFO: deployment complete");
    expect(result.text).toContain("INFO: pods healthy");
  });

  // --- heartbeat collapsing ---

  it("test_collapses_heartbeat_lines", () => {
    const lines = Array.from({ length: 30 }, () => "heartbeat: alive");
    const stdout = lines.join("\n") + "\n";
    const result = _filter().apply(stdout, "", 0, ["tool", "--log"]);
    expect(result.text).not.toContain("heartbeat: alive");
    expect(result.text).toContain("heartbeat/health-check");
  });

  it("test_collapses_health_check_lines", () => {
    const lines = Array.from({ length: 20 }, (_, i) => `health check #${i} OK`);
    const stdout = lines.join("\n") + "\n";
    const result = _filter().apply(stdout, "", 0, ["tool", "--log"]);
    expect(result.text).not.toContain("health check");
    expect(result.text).toContain("heartbeat/health-check");
  });

  it("test_collapses_keepalive_lines", () => {
    const lines = Array.from({ length: 10 }, () => "keepalive sent");
    const stdout = lines.join("\n") + "\n";
    const result = _filter().apply(stdout, "", 0, ["tool", "--log"]);
    expect(result.text).not.toContain("keepalive sent");
  });

  // --- failure lines always kept ---

  it("test_keeps_error_lines", () => {
    const stdout =
      "DEBUG: verbose noise\n" +
      "Error: failed to connect to database\n" +
      "DEBUG: more noise\n";
    const result = _filter().apply(stdout, "", 0, ["tool", "--log"]);
    expect(result.text).toContain("Error: failed to connect");
  });

  it("test_keeps_failed_lines", () => {
    const stdout = "FAILED: job build-and-test after 5 retries\n";
    const result = _filter().apply(stdout, "", 0, ["pipeline", "logs"]);
    expect(result.text).toContain("FAILED: job build-and-test");
  });

  // --- generic-ci select_filter ---

  it("test_select_filter_does_not_preempt_specific_filters", () => {
    // gh run view --log must be handled by GhRunLogFilter, not GenericCIFilter.
    const f = bc.select_filter(["gh", "run", "view", "123", "--log"]);
    expect(f).toBeInstanceOf(bc.GhRunLogFilter);
  });

  it("test_select_filter_does_not_preempt_kubectl_logs", () => {
    // kubectl logs must be handled by KubectlLogsFilter.
    const f = bc.select_filter(["kubectl", "logs", "my-pod"]);
    expect(f).toBeInstanceOf(bc.KubectlLogsFilter);
  });
});

// ===========================================================================
// NodePackageFilter — npm audit improvements
// ===========================================================================

describe("TestNodePackageFilterAudit", () => {
  const _filter = (): bc.NodePackageFilter => new bc.NodePackageFilter();

  // --- JSON mode ---

  it("test_audit_json_short_passes_through", () => {
    const vulns: Record<string, unknown> = {};
    for (let i = 0; i < 5; i += 1) {
      vulns[`pkg${i}`] = { severity: "moderate" };
    }
    const data = {
      vulnerabilities: vulns,
      metadata: { vulnerabilities: { total: 5 } },
    };
    const text = _pyJsonDumps(data);
    const result = _filter().apply(text, "", 1, ["npm", "audit", "--json"]);
    const out = JSON.parse(result.text) as { vulnerabilities: Record<string, unknown> };
    expect(Object.keys(out.vulnerabilities).length).toBe(5);
  });

  it("test_audit_json_collapses_over_10_entries", () => {
    // 4 critical + 4 high + 6 moderate = 14 total; moderate should be collapsed.
    const vulns: Record<string, unknown> = {};
    for (let i = 0; i < 4; i += 1) {
      vulns[`critical-pkg-${i}`] = { severity: "critical" };
    }
    for (let i = 0; i < 4; i += 1) {
      vulns[`high-pkg-${i}`] = { severity: "high" };
    }
    for (let i = 0; i < 6; i += 1) {
      vulns[`moderate-pkg-${i}`] = { severity: "moderate" };
    }
    const data = { vulnerabilities: vulns, metadata: {} };
    const text = _pyJsonDumps(data);
    const result = _filter().apply(text, "", 1, ["npm", "audit", "--json"]);
    const out = JSON.parse(result.text) as { vulnerabilities: Record<string, unknown> };
    const vuln_out = out.vulnerabilities;
    // critical + high should be kept; moderate collapsed into sentinel.
    for (let i = 0; i < 4; i += 1) {
      expect(vuln_out).toHaveProperty(`critical-pkg-${i}`);
      expect(vuln_out).toHaveProperty(`high-pkg-${i}`);
    }
    // A summary sentinel should be present.
    expect(vuln_out).toHaveProperty("__token_goat__");
    expect(String(vuln_out["__token_goat__"])).toContain("6");
  });

  it("test_audit_json_keeps_critical_and_high_when_many", () => {
    const vulns: Record<string, unknown> = {};
    for (let i = 0; i < 15; i += 1) {
      vulns[`pkg${i}`] = { severity: "low" };
    }
    const data = { vulnerabilities: vulns, metadata: {} };
    const text = _pyJsonDumps(data);
    const result = _filter().apply(text, "", 1, ["npm", "audit", "--json"]);
    const out = JSON.parse(result.text) as { vulnerabilities: Record<string, unknown> };
    // All 15 are low — none are critical/high, so only sentinel remains.
    expect(out.vulnerabilities).toHaveProperty("__token_goat__");
    expect(Object.keys(out.vulnerabilities).length).toBe(1);
  });

  it("test_audit_json_non_json_passthrough", () => {
    const text = "not json at all";
    const result = _filter().apply(text, "", 1, ["npm", "audit", "--json"]);
    expect(result.text).toContain("not json at all");
  });

  it("test_audit_json_preserves_metadata", () => {
    const vulns: Record<string, unknown> = {};
    for (let i = 0; i < 12; i += 1) {
      vulns[`pkg${i}`] = { severity: "low" };
    }
    const metadata = { vulnerabilities: { low: 12, moderate: 0, high: 0, critical: 0 } };
    const data = { vulnerabilities: vulns, metadata };
    const text = _pyJsonDumps(data);
    const result = _filter().apply(text, "", 1, ["npm", "audit", "--json"]);
    const out = JSON.parse(result.text) as { metadata: unknown };
    // Metadata must be untouched.
    expect(out.metadata).toEqual(metadata);
  });

  // --- human mode ---

  it("test_audit_human_short_passes_through", () => {
    const blocks: string[] = [];
    for (let i = 0; i < 5; i += 1) {
      blocks.push(`# pkg-${i}\n  Severity: moderate\n  Some advisory text\n`);
    }
    const text = blocks.join("\n") + "\nfound 5 vulnerabilities\n";
    const result = _filter().apply(text, "", 1, ["npm", "audit"]);
    expect(result.text).toContain("found 5 vulnerabilities");
    // All 5 blocks kept (under threshold).
    for (let i = 0; i < 5; i += 1) {
      expect(result.text).toContain(`# pkg-${i}`);
    }
  });

  it("test_audit_human_collapses_over_10_same_severity", () => {
    const blocks: string[] = [];
    for (let i = 0; i < 15; i += 1) {
      blocks.push(`# moderate-pkg-${i}\n  Severity: moderate\n  Advisory details here\n`);
    }
    const text = blocks.join("\n") + "\nfound 15 vulnerabilities\n";
    const result = _filter().apply(text, "", 1, ["npm", "audit"]);
    // First 10 moderate blocks kept.
    expect(result.text).toContain("# moderate-pkg-0");
    expect(result.text).toContain("# moderate-pkg-9");
    // Blocks 10..14 collapsed.
    expect(result.text).not.toContain("# moderate-pkg-10");
    expect(result.text).toContain("collapsed 5 duplicate moderate advisories");
    // Summary line always kept.
    expect(result.text).toContain("found 15 vulnerabilities");
  });

  it("test_audit_human_mixed_severities_collapses_only_overflow", () => {
    const blocks: string[] = [];
    for (let i = 0; i < 12; i += 1) {
      blocks.push(`# high-pkg-${i}\n  Severity: high\n  Details\n`);
    }
    for (let i = 0; i < 3; i += 1) {
      blocks.push(`# critical-pkg-${i}\n  Severity: critical\n  Details\n`);
    }
    const text = blocks.join("\n") + "\nfound 15 vulnerabilities\n";
    const result = _filter().apply(text, "", 1, ["npm", "audit"]);
    // First 10 high blocks kept.
    expect(result.text).toContain("# high-pkg-9");
    expect(result.text).not.toContain("# high-pkg-10");
    // All 3 critical blocks kept (under threshold).
    for (let i = 0; i < 3; i += 1) {
      expect(result.text).toContain(`# critical-pkg-${i}`);
    }
  });

  it("test_audit_human_no_advisory_blocks_passes_through", () => {
    const text = "found 0 vulnerabilities (0 packages audited)\n";
    const result = _filter().apply(text, "", 0, ["npm", "audit"]);
    expect(result.text).toContain("found 0 vulnerabilities");
  });

  // --- non-audit npm subcommands still work ---

  it("test_non_audit_install_still_drops_progress", () => {
    const text = "⠋ idealTree\nadded 50 packages in 3s\n";
    const result = _filter().apply(text, "", 0, ["npm", "install"]);
    expect(result.text).not.toContain("⠋ idealTree");
    expect(result.text).toContain("added 50 packages");
  });
});

// ===========================================================================
// FILTERS list includes all new filters
// ===========================================================================

describe("TestCIFiltersRegistered", () => {
  const _names = (): string[] => bc.FILTERS.map((f) => f.name);

  it("test_gh_run_log_filter_registered", () => {
    expect(_names()).toContain("gh-run-log");
  });

  it("test_act_filter_registered", () => {
    expect(_names()).toContain("act");
  });

  it("test_generic_ci_filter_registered", () => {
    expect(_names()).toContain("generic-ci");
  });

  it("test_gh_run_log_before_gh", () => {
    const names = _names();
    expect(names.indexOf("gh-run-log")).toBeLessThan(names.indexOf("gh"));
  });

  it("test_gh_run_log_exported", () => {
    expect("GhRunLogFilter" in bc).toBe(true);
  });

  it("test_act_exported", () => {
    expect("ActFilter" in bc).toBe(true);
  });

  it("test_generic_ci_exported", () => {
    expect("GenericCIFilter" in bc).toBe(true);
  });
});
