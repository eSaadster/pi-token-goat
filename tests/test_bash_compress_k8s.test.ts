/**
 * Tests for DockerComposeFilter, HelmFilter, and KubectlLogsFilter.
 *
 * 1:1 port of tests/test_bash_compress_k8s.py. Every Python `def test_*` maps to
 * a vitest `it()` with the SAME name and assertion polarity; the Python test
 * classes (TestDockerComposeFilter, TestHelmFilter, TestKubectlLogsFilter,
 * TestFilterOrdering) map to `describe()` blocks of the same name.
 *
 * Test-seam mapping (Python -> TS):
 *  - `from token_goat import bash_compress as bc`
 *      -> import the barrel "../src/token_goat/bash_compress.js" as `bc`
 *        (re-exports the framework + the container/cloud filter classes +
 *        select_filter + the FILTERS registry).
 *  - Each Python test class has a `_filter(self)` factory returning a fresh
 *    filter instance; ported to a local `const f = new <Filter>()` inside each
 *    `it()` (matching the Python pattern where `_filter()` is called per-method).
 *  - The Python tests call `f.apply(stdout, stderr, exit_code, argv)` directly
 *    and read `.text`; the TS port calls `f.apply(...)` with the same positional
 *    args and reads `.text` (apply() returns a CompressedOutput whose `.text` is
 *    the body). The Python `result.text` -> TS `result.text`.
 *  - `isinstance(f, bc.XFilter)` -> `f instanceof XFilter`.
 *  - `json.dumps(obj, indent=2)` (CPython) is reproduced for the one JSON-blob
 *    fixture via `_pyJsonDumpsIndent2`: keys in insertion order, two-space indent
 *    per level, `": "` after each key, `","` between items, closing brace
 *    de-indented. The blob the test builds is a flat dict of string values, so
 *    the helper only needs the flat one-level form CPython emits.
 *
 * Byte-exactness: these filters operate on whole lines and on substring markers
 * ("more Pulling lines elided", "more similar lines omitted", "HTTP access log
 * lines collapsed", ...). The assertions are substring / `.count()` checks on the
 * returned string, matching the Python `in` / `not in` / `.count(...)` checks.
 * The fixtures are pure ASCII, so code-unit length equals byte length; no Buffer
 * arithmetic is needed for these particular tests.
 */
import { describe, expect, it } from "vitest";

import * as bc from "../src/token_goat/bash_compress.js";
import {
  DockerComposeFilter,
  DockerFilter,
  HelmFilter,
  KubectlFilter,
  KubectlLogsFilter,
} from "../src/token_goat/bash_compress.js";

// ---------------------------------------------------------------------------
// CPython json.dumps(obj, indent=2) for the single flat-string-dict JSON blob
// fixture. Keys in insertion order; two-space indent; ": " after each key;
// "," between items; closing brace de-indented to column 0.
// ---------------------------------------------------------------------------
function _pyJsonDumpsIndent2(obj: Record<string, unknown>): string {
  const keys = Object.keys(obj);
  if (keys.length === 0) {
    return "{}";
  }
  const inner = keys
    .map((key) => `  ${JSON.stringify(key)}: ${JSON.stringify(obj[key])}`)
    .join(",\n");
  return `{\n${inner}\n}`;
}

/** Python str.count(sub) — count of non-overlapping occurrences. */
function _count(haystack: string, needle: string): number {
  if (needle === "") {
    return haystack.length + 1;
  }
  let n = 0;
  let idx = haystack.indexOf(needle);
  while (idx !== -1) {
    n += 1;
    idx = haystack.indexOf(needle, idx + needle.length);
  }
  return n;
}

// ===========================================================================
// DockerComposeFilter
// ===========================================================================

describe("TestDockerComposeFilter", () => {
  // --- dispatch ---

  it("test_matches_docker_compose_binary", () => {
    const f = new DockerComposeFilter();
    expect(f.matches(["docker-compose", "up"])).toBe(true);
  });

  it("test_matches_docker_compose_subcommand", () => {
    const f = new DockerComposeFilter();
    expect(f.matches(["docker", "compose", "up", "-d"])).toBe(true);
  });

  it("test_does_not_match_docker_build", () => {
    const f = new DockerComposeFilter();
    expect(f.matches(["docker", "build", "."])).toBe(false);
  });

  it("test_does_not_match_docker_run", () => {
    const f = new DockerComposeFilter();
    expect(f.matches(["docker", "run", "myimage"])).toBe(false);
  });

  it("test_does_not_match_kubectl", () => {
    const f = new DockerComposeFilter();
    expect(f.matches(["kubectl", "get", "pods"])).toBe(false);
  });

  it("test_select_filter_docker_compose_binary", () => {
    const f = bc.select_filter(["docker-compose", "up"]);
    expect(f instanceof DockerComposeFilter).toBe(true);
  });

  it("test_select_filter_docker_compose_subcommand", () => {
    const f = bc.select_filter(["docker", "compose", "up"]);
    expect(f instanceof DockerComposeFilter).toBe(true);
  });

  it("test_docker_build_still_routes_to_docker_filter", () => {
    const f = bc.select_filter(["docker", "build", "."]);
    expect(f instanceof DockerFilter).toBe(true);
  });

  // --- pulling lines ---

  it("test_collapses_many_pulling_lines", () => {
    const lines = [
      "Pulling db (postgres:14)...",
      "Pulling redis (redis:7)...",
      "Pulling web (myapp:latest)...",
    ];
    const text = lines.join("\n");
    const f = new DockerComposeFilter();
    const result = f.apply(text, "", 0, ["docker-compose", "up"]);
    expect(result.text).toContain("Pulling db");
    expect(result.text).not.toContain("Pulling redis");
    expect(result.text).toContain("2 more Pulling lines elided");
  });

  it("test_single_pulling_line_not_collapsed", () => {
    const text = "Pulling db (postgres:14)...";
    const f = new DockerComposeFilter();
    const result = f.apply(text, "", 0, ["docker-compose", "up"]);
    expect(result.text).toContain("Pulling db");
    expect(result.text).not.toContain("elided");
  });

  // --- service streaming logs ---

  it("test_service_logs_short_pass_through", () => {
    const lines = Array.from({ length: 10 }, (_, i) => `web | log line ${i}`);
    const text = lines.join("\n");
    const f = new DockerComposeFilter();
    const result = f.apply(text, "", 0, ["docker-compose", "up"]);
    for (let i = 0; i < 10; i++) {
      expect(result.text).toContain(`web | log line ${i}`);
    }
  });

  it("test_service_logs_over_threshold_collapsed", () => {
    const lines = Array.from({ length: 60 }, (_, i) => `web | log line ${i}`);
    const text = lines.join("\n");
    const f = new DockerComposeFilter();
    const result = f.apply(text, "", 0, ["docker-compose", "up"]);
    // Should collapse: 60 - 10 = 50 lines elided
    expect(result.text).toContain("50 lines from web elided");
    // Last 10 lines kept
    for (let i = 50; i < 60; i++) {
      expect(result.text).toContain(`web | log line ${i}`);
    }
    // First lines should not appear
    expect(result.text).not.toContain("web | log line 0");
  });

  it("test_multiple_services_collapsed_independently", () => {
    const web_lines = Array.from({ length: 60 }, (_, i) => `web | line ${i}`);
    const db_lines = Array.from({ length: 10 }, (_, i) => `db | query ${i}`); // under threshold
    const text = [...web_lines, ...db_lines].join("\n");
    const f = new DockerComposeFilter();
    const result = f.apply(text, "", 0, ["docker-compose", "up"]);
    expect(result.text).toContain("lines from web elided");
    // db lines all present (under 50)
    expect(result.text).toContain("db | query 0");
    expect(result.text).toContain("db | query 9");
  });

  // --- Creating/Starting/Stopping lines kept ---

  it("test_creating_network_kept", () => {
    const text =
      "Creating network default_network ... done\nCreating volume myapp_data ... done";
    const f = new DockerComposeFilter();
    const result = f.apply(text, "", 0, ["docker-compose", "up"]);
    expect(result.text).toContain("Creating network");
    expect(result.text).toContain("Creating volume");
  });

  it("test_starting_and_stopping_kept", () => {
    const text = "Starting myapp_web_1 ... done\nStopping myapp_db_1 ... done";
    const f = new DockerComposeFilter();
    const result = f.apply(text, "", 0, ["docker-compose", "up"]);
    expect(result.text).toContain("Starting myapp_web_1");
    expect(result.text).toContain("Stopping myapp_db_1");
  });

  // --- health check ---

  it("test_health_check_retries_collapsed", () => {
    const lines = [
      "Container myapp_web_1 Waiting",
      "Container myapp_web_1 Waiting",
      "Container myapp_web_1 Waiting",
      "Container myapp_web_1 Healthy",
    ];
    const text = lines.join("\n");
    const f = new DockerComposeFilter();
    const result = f.apply(text, "", 0, ["docker-compose", "up"]);
    // First occurrence kept
    expect(result.text).toContain("Container myapp_web_1 Waiting");
    // Summary for repeated
    expect(result.text).toContain("more health-check wait lines");
  });

  // --- error on non-zero exit ---

  it("test_error_exit_preserves_stderr", () => {
    const stdout = "Starting myapp_web_1 ... done\n";
    const stderr = "Error response from daemon: No such container";
    const f = new DockerComposeFilter();
    const result = f.apply(stdout, stderr, 1, ["docker-compose", "up"]);
    expect(result.text).toContain("Error response from daemon");
  });

  // --- empty output ---

  it("test_empty_output", () => {
    const f = new DockerComposeFilter();
    const result = f.apply("", "", 0, ["docker-compose", "ps"]);
    expect(result.text).toBe("");
  });
});

// ===========================================================================
// HelmFilter
// ===========================================================================

describe("TestHelmFilter", () => {
  const _INSTALL_OUTPUT =
    "NAME: myrelease\n" +
    "LAST DEPLOYED: Sat May 30 12:00:00 2026\n" +
    "NAMESPACE: default\n" +
    "STATUS: deployed\n" +
    "REVISION: 1\n" +
    "TEST SUITE: None\n" +
    "NOTES:\n" +
    "This chart installs a web application.\n" +
    "Visit http://localhost:8080 to access it.\n" +
    "\n" +
    "Some more NOTES text here.\n";

  // --- dispatch ---

  it("test_matches_helm", () => {
    const f = new HelmFilter();
    expect(f.matches(["helm", "install", "myrelease", "mychart"])).toBe(true);
    expect(f.matches(["helm", "list"])).toBe(true);
    expect(f.matches(["helm", "template", "mychart"])).toBe(true);
  });

  it("test_does_not_match_kubectl", () => {
    const f = new HelmFilter();
    expect(f.matches(["kubectl", "apply", "-f", "chart.yaml"])).toBe(false);
  });

  it("test_select_filter_returns_helm_filter", () => {
    const f = bc.select_filter(["helm", "install", "myrelease", "mychart"]);
    expect(f instanceof HelmFilter).toBe(true);
  });

  it("test_select_filter_helm_not_kubectl_filter", () => {
    // HelmFilter must precede KubectlFilter which used to claim `helm`
    const f = bc.select_filter(["helm", "list"]);
    expect(f instanceof HelmFilter).toBe(true);
    expect(f instanceof KubectlFilter).toBe(false);
  });

  // --- helm install / upgrade ---

  it("test_install_keeps_status_line", () => {
    const f = new HelmFilter();
    const result = f.apply(_INSTALL_OUTPUT, "", 0, ["helm", "install", "myrelease", "mychart"]);
    expect(result.text).toContain("STATUS: deployed");
  });

  it("test_install_collapses_boilerplate", () => {
    const f = new HelmFilter();
    const result = f.apply(_INSTALL_OUTPUT, "", 0, ["helm", "install", "myrelease", "mychart"]);
    // NOTES header body should be elided, not emitted verbatim
    expect(result.text).not.toContain("Visit http://localhost:8080");
    expect(result.text).toContain("lines elided");
  });

  it("test_upgrade_keeps_status_failed", () => {
    const text = "NAME: myrelease\nSTATUS: failed\nLAST DEPLOYED: today\n";
    const f = new HelmFilter();
    const result = f.apply(text, "", 0, ["helm", "upgrade", "myrelease", "mychart"]);
    expect(result.text).toContain("STATUS: failed");
  });

  it("test_install_error_stderr_kept", () => {
    const stderr = "Error: INSTALLATION FAILED: chart not found";
    const f = new HelmFilter();
    const result = f.apply("", stderr, 1, ["helm", "install", "x", "y"]);
    expect(result.text).toContain("INSTALLATION FAILED");
  });

  // --- helm list ---

  it("test_list_short_passthrough", () => {
    const header = "NAME\tNAMESPACE\tREVISION\tSTATUS\tCHART";
    const rows = Array.from(
      { length: 5 },
      (_, i) => `rel${i}\tdefault\t1\tdeployed\tmychart-1.0`,
    );
    const text = [header, ...rows].join("\n");
    const f = new HelmFilter();
    const result = f.apply(text, "", 0, ["helm", "list"]);
    expect(result.text).toContain("rel0");
    expect(result.text).toContain("rel4");
    expect(result.text).not.toContain("elided");
  });

  it("test_list_over_limit_truncated", () => {
    const header = "NAME\tNAMESPACE\tREVISION\tSTATUS\tCHART";
    const rows = Array.from(
      { length: 25 },
      (_, i) => `rel${i}\tdefault\t1\tdeployed\tmychart-1.0`,
    );
    const text = [header, ...rows].join("\n");
    const f = new HelmFilter();
    const result = f.apply(text, "", 0, ["helm", "list"]);
    // Should keep header + 10 rows + marker
    expect(result.text).toContain("rel0");
    expect(result.text).toContain("rel9");
    expect(result.text).not.toContain("rel10");
    expect(result.text).toContain("15 more helm releases elided");
  });

  // --- helm template ---

  it("test_template_short_passthrough", () => {
    const text = "---\n# Source: mychart/templates/deploy.yaml\napiVersion: apps/v1\n";
    const f = new HelmFilter();
    const result = f.apply(text, "", 0, ["helm", "template", "mychart"]);
    // Short output: not compressed
    expect(result.text).toContain("apiVersion");
  });

  it("test_template_long_shows_section_headers", () => {
    // Build a fake template output > 200 lines
    const sections: string[] = [];
    for (let i = 0; i < 15; i++) {
      sections.push(`---\n# Source: chart/templates/resource${i}.yaml`);
      sections.push(
        Array.from({ length: 15 }, (_, j) => `field${j}: value${j}`).join("\n"),
      );
    }
    const text = sections.join("\n");
    expect(text.split("\n").length).toBeGreaterThan(200);
    const f = new HelmFilter();
    const result = f.apply(text, "", 0, ["helm", "template", "mychart"]);
    // Should contain document separator markers
    expect(result.text).toContain("---");
    // Should contain total line count summary
    expect(result.text).toContain("total lines");
    // Should NOT contain all the field lines
    expect(_count(result.text, "field0: value0")).toBeLessThanOrEqual(1);
  });

  // --- other subcommands pass through ---

  it("test_status_passthrough", () => {
    const text = "NAME: myrelease\nSTATUS: deployed\n";
    const f = new HelmFilter();
    const result = f.apply(text, "", 0, ["helm", "status", "myrelease"]);
    expect(result.text).toContain("STATUS: deployed");
  });
});

// ===========================================================================
// KubectlLogsFilter
// ===========================================================================

describe("TestKubectlLogsFilter", () => {
  // --- dispatch ---

  it("test_matches_kubectl_logs", () => {
    const f = new KubectlLogsFilter();
    expect(f.matches(["kubectl", "logs", "my-pod"])).toBe(true);
    expect(f.matches(["kubectl", "logs", "-f", "my-pod"])).toBe(true);
    expect(f.matches(["k", "logs", "my-pod"])).toBe(true);
  });

  it("test_does_not_match_kubectl_get", () => {
    const f = new KubectlLogsFilter();
    expect(f.matches(["kubectl", "get", "pods"])).toBe(false);
  });

  it("test_does_not_match_kubectl_describe", () => {
    const f = new KubectlLogsFilter();
    expect(f.matches(["kubectl", "describe", "pod", "my-pod"])).toBe(false);
  });

  it("test_does_not_match_helm", () => {
    const f = new KubectlLogsFilter();
    expect(f.matches(["helm", "logs", "release"])).toBe(false);
  });

  it("test_select_filter_returns_kubectl_logs_filter", () => {
    const f = bc.select_filter(["kubectl", "logs", "my-pod"]);
    expect(f instanceof KubectlLogsFilter).toBe(true);
  });

  it("test_select_filter_kubectl_get_still_routes_to_kubectl_filter", () => {
    const f = bc.select_filter(["kubectl", "get", "pods"]);
    expect(f instanceof KubectlFilter).toBe(true);
  });

  // --- short output passthrough ---

  it("test_short_output_passes_through", () => {
    const lines = ["2026-05-30T12:00:00Z INFO started", "2026-05-30T12:00:01Z INFO ready"];
    const text = lines.join("\n");
    const f = new KubectlLogsFilter();
    const result = f.apply(text, "", 0, ["kubectl", "logs", "my-pod"]);
    for (const line of lines) {
      expect(result.text).toContain(line);
    }
  });

  // --- repetitive line dedup ---

  it("test_dedup_repetitive_timestamp_lines", () => {
    // Same message with different timestamps — enough lines (>50) to
    // trigger the dedup path in KubectlLogsFilter.compress()
    const lines = Array.from(
      { length: 60 },
      (_, i) => `2026-05-30T12:00:${String(i).padStart(2, "0")}Z INFO heartbeat ok`,
    );
    const text = lines.join("\n");
    const f = new KubectlLogsFilter();
    const result = f.apply(text, "", 0, ["kubectl", "logs", "my-pod"]);
    // Should collapse: keep 3, show N more
    expect(result.text).toContain("more similar lines omitted");
    // First 3 should be present
    expect(result.text).toContain("2026-05-30T12:00:00Z INFO heartbeat ok");
    expect(result.text).toContain("2026-05-30T12:00:01Z INFO heartbeat ok");
    expect(result.text).toContain("2026-05-30T12:00:02Z INFO heartbeat ok");
  });

  it("test_dedup_does_not_collapse_different_messages", () => {
    const lines = [
      "2026-05-30T12:00:00Z INFO started server",
      "2026-05-30T12:00:01Z INFO connected to db",
      "2026-05-30T12:00:02Z INFO cache warmed",
    ];
    const text = lines.join("\n");
    const f = new KubectlLogsFilter();
    const result = f.apply(text, "", 0, ["kubectl", "logs", "my-pod"]);
    // All distinct lines should survive (output is short, no compression applied)
    for (const line of lines) {
      expect(result.text).toContain(line);
    }
  });

  // --- stack trace collapsing ---

  it("test_stack_trace_collapsed", () => {
    const error_line = "2026-05-30T12:00:00Z ERROR NullPointerException";
    const frames = Array.from(
      { length: 15 },
      (_, i) => `    at com.example.Class${i}.method(Class${i}.java:${i * 10})`,
    );
    // Pad to >50 lines so dedup path activates
    const padding = Array.from(
      { length: 50 },
      (_, i) => `2026-05-30T12:00:${String(i + 1).padStart(2, "0")}Z INFO log line ${i}`,
    );
    const text = [error_line, ...frames, ...padding].join("\n");
    const f = new KubectlLogsFilter();
    const result = f.apply(text, "", 0, ["kubectl", "logs", "my-pod"]);
    expect(result.text).toContain("more frames");
    // First 5 frames kept
    expect(result.text).toContain("at com.example.Class0.method");
    expect(result.text).toContain("at com.example.Class4.method");
  });

  // --- access log collapsing ---

  it("test_access_logs_collapsed_over_threshold", () => {
    // 25 access log lines
    const access = Array.from(
      { length: 25 },
      () => '10.0.0.1 - - [30/May/2026] "GET /api/v1/foo HTTP/1.1" 200 123',
    );
    // A few non-access lines
    const other = Array.from({ length: 10 }, () => "2026-05-30T12:00:00Z INFO started");
    // Need >50 total lines to trigger compression
    const padding = Array.from(
      { length: 30 },
      (_, i) => `2026-05-30T12:00:${String(i).padStart(2, "0")}Z INFO padding ${i}`,
    );
    const text = [...other, ...access, ...padding].join("\n");
    const f = new KubectlLogsFilter();
    const result = f.apply(text, "", 0, ["kubectl", "logs", "my-pod"]);
    expect(result.text).toContain("HTTP access log lines collapsed");
    expect(result.text).toContain("2xx:");
  });

  it("test_access_logs_under_threshold_kept", () => {
    // Only 5 access log lines — under the 20-line threshold
    const access = Array.from(
      { length: 5 },
      () => '10.0.0.1 - - [30/May/2026] "GET /healthz HTTP/1.1" 200 10',
    );
    // Total lines still over 50 (to trigger filter)
    const padding = Array.from(
      { length: 60 },
      (_, i) => `2026-05-30T12:00:${String(i).padStart(2, "0")}Z INFO other ${i}`,
    );
    const text = [...access, ...padding].join("\n");
    const f = new KubectlLogsFilter();
    const result = f.apply(text, "", 0, ["kubectl", "logs", "my-pod"]);
    // access logs should survive (threshold not hit)
    expect(
      !result.text.includes("collapsed") || !result.text.includes("HTTP access"),
    ).toBe(true);
  });

  // --- JSON blob collapsing ---

  it("test_json_blob_over_5_lines_collapsed", () => {
    // Build a JSON blob that exceeds the 5-line threshold (indent=2 on a
    // dict with many keys produces one line per key + 2 brace lines)
    const obj: Record<string, string> = {};
    for (let i = 0; i < 8; i++) {
      obj[`key${i}`] = `value${i}`;
    }
    const blob = _pyJsonDumpsIndent2(obj);
    const blob_lines = blob.split("\n");
    expect(blob_lines.length).toBeGreaterThan(5);
    // Surround with enough log lines to trigger the filter (>50 total)
    const padding = Array.from(
      { length: 60 },
      (_, i) => `2026-05-30T12:00:${String(i).padStart(2, "0")}Z INFO log ${i}`,
    );
    const text =
      padding.slice(0, 30).join("\n") + "\n" + blob + "\n" + padding.slice(30).join("\n");
    const f = new KubectlLogsFilter();
    const result = f.apply(text, "", 0, ["kubectl", "logs", "my-pod"]);
    expect(result.text).toContain("JSON blob");
    expect(result.text).toContain("collapsed");
  });

  it("test_json_blob_under_5_lines_kept", () => {
    // A compact 2-line JSON object
    const blob = '{"level": "info", "msg": "ok"}';
    const padding = Array.from(
      { length: 60 },
      (_, i) => `2026-05-30T12:00:${String(i).padStart(2, "0")}Z INFO log ${i}`,
    );
    const text = padding.join("\n") + "\n" + blob;
    const f = new KubectlLogsFilter();
    const result = f.apply(text, "", 0, ["kubectl", "logs", "my-pod"]);
    // Single-line JSON should not be collapsed
    expect(result.text.includes('"level": "info"') || result.text.includes('{"level"')).toBe(
      true,
    );
  });

  // --- error exit preserves stderr ---

  it("test_error_exit_preserves_stderr", () => {
    const stderr = 'Error from server (NotFound): pods "missing-pod" not found';
    const f = new KubectlLogsFilter();
    const result = f.apply("", stderr, 1, ["kubectl", "logs", "missing-pod"]);
    expect(result.text).toContain("NotFound");
  });

  // --- multi-pod / --prefix output dedup ---

  it("test_multi_pod_prefix_dedup", () => {
    // kubectl logs -l selector emits pod-name | message; same message collapses.
    // 60 lines from 2 pods, alternating, with the same health-check message
    const lines: string[] = [];
    for (let i = 0; i < 30; i++) {
      const ts = `2026-05-30T12:${String(Math.trunc(i / 60)).padStart(2, "0")}:${String(
        i % 60,
      ).padStart(2, "0")}Z`;
      lines.push(`pod-abc123 | ${ts} INFO health check ok`);
      lines.push(`pod-def456 | ${ts} INFO health check ok`);
    }
    const text = lines.join("\n");
    const f = new KubectlLogsFilter();
    const result = f.apply(text, "", 0, ["kubectl", "logs", "-l", "app=myapp"]);
    // Should collapse: the two pods emit the same message; keep first 3 of any
    expect(result.text).toContain("more similar lines omitted");
    // At least the first instance from one pod should be preserved
    expect(result.text).toContain("INFO health check ok");
  });

  it("test_multi_pod_prefix_output_different_messages_kept", () => {
    // Different messages from multiple pods are not collapsed.
    const lines = Array.from(
      { length: 60 },
      (_, i) => `pod-${i} | 2026-05-30T12:00:00Z INFO unique message ${i}`,
    );
    const text = lines.join("\n");
    const f = new KubectlLogsFilter();
    const result = f.apply(text, "", 0, ["kubectl", "logs", "-l", "app=myapp"]);
    // All unique messages should survive (no collapsing of distinct messages)
    expect(result.text).not.toContain("more similar lines omitted");
  });

  it("test_kubectl_prefix_flag_dedup", () => {
    // kubectl logs --prefix emits [pod/name/container] prefix; same message collapses.
    const lines: string[] = [];
    for (let i = 0; i < 60; i++) {
      const ts = `2026-05-30T12:00:${String(i).padStart(2, "0")}Z`;
      const pod = i % 2 === 0 ? "pod-abc" : "pod-def";
      lines.push(`[pod/${pod}/main] ${ts} INFO connected to cache`);
    }
    const text = lines.join("\n");
    const f = new KubectlLogsFilter();
    const result = f.apply(text, "", 0, ["kubectl", "logs", "--prefix", "-l", "app=svc"]);
    expect(result.text).toContain("more similar lines omitted");
  });

  it("test_follow_cap_applied_to_very_long_output", () => {
    // Very long --follow output is capped at head=40, tail=40.
    const lines = Array.from(
      { length: 500 },
      (_, i) =>
        `2026-05-30T12:${String(Math.trunc(i / 60)).padStart(2, "0")}:${String(
          i % 60,
        ).padStart(2, "0")}Z INFO line ${i}`,
    );
    const text = lines.join("\n");
    const f = new KubectlLogsFilter();
    const result = f.apply(text, "", 0, ["kubectl", "logs", "-f", "my-pod"]);
    // Should be significantly compressed — well under 500 lines
    const result_lines = result.text.split("\n").filter((ln) => ln.trim() !== "");
    expect(result_lines.length).toBeLessThan(200);
    // Marker should indicate elision
    expect(result.text.includes("elided") || result.text.includes("omitted")).toBe(true);
  });

  // --- integration: no filter for kubectl get ---

  it("test_kubectl_get_not_routed_to_logs_filter", () => {
    // KubectlLogsFilter must not intercept kubectl get.
    const f = bc.select_filter(["kubectl", "get", "deployments"]);
    expect(f).not.toBeNull();
    expect(f instanceof KubectlLogsFilter).toBe(false);
  });
});

// ===========================================================================
// Cross-filter ordering sanity
// ===========================================================================

describe("TestFilterOrdering", () => {
  it("test_docker_compose_before_docker", () => {
    const dc_idx = bc.FILTERS.findIndex((f) => f instanceof DockerComposeFilter);
    const d_idx = bc.FILTERS.findIndex((f) => f instanceof DockerFilter);
    expect(dc_idx).toBeLessThan(d_idx); // DockerComposeFilter must precede DockerFilter
  });

  it("test_kubectl_logs_before_kubectl", () => {
    const kl_idx = bc.FILTERS.findIndex((f) => f instanceof KubectlLogsFilter);
    const k_idx = bc.FILTERS.findIndex((f) => f instanceof KubectlFilter);
    expect(kl_idx).toBeLessThan(k_idx); // KubectlLogsFilter must precede KubectlFilter
  });

  it("test_helm_before_kubectl", () => {
    const h_idx = bc.FILTERS.findIndex((f) => f instanceof HelmFilter);
    const k_idx = bc.FILTERS.findIndex((f) => f instanceof KubectlFilter);
    expect(h_idx).toBeLessThan(k_idx); // HelmFilter must precede KubectlFilter
  });

  it("test_helm_not_in_kubectl_binaries", () => {
    const kubectl = bc.FILTERS.find((f) => f instanceof KubectlFilter) as KubectlFilter;
    expect(kubectl.binaries.has("helm")).toBe(false);
    // helm binary should be claimed by HelmFilter, not KubectlFilter
  });
});
