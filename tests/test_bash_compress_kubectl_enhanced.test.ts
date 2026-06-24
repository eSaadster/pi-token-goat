/**
 * Tests for enhanced kubectl compression: events dedup and improved describe.
 *
 * 1:1 port of tests/test_bash_compress_kubectl_enhanced.py. Every Python
 * `def test_*` maps to a vitest `it()` with the SAME name and assertion
 * polarity.
 *
 * Test-seam mapping (Python -> TS):
 *  - `from token_goat import bash_compress as bc`
 *      -> import { KubectlFilter } from the barrel
 *         "../src/token_goat/bash_compress.js" (containers.ts re-exports it).
 *  - module-level `_f = bc.KubectlFilter()` -> `const _f = new KubectlFilter()`.
 *  - `_kubectl(stdout, argv, exit_code=0)` helper ->
 *      `_kubectl(stdout, argv, exit_code = 0)`; returns
 *      `_f.apply(stdout, "", exit_code, argv).text` exactly like Python.
 *  - `_make_events_table` reproduces the Python f-string left-justified field
 *    widths (`{x:<11}` etc.) with String.prototype.padEnd, which is byte-exact
 *    for the ASCII fixtures used here (code-unit length == byte length).
 *
 * Byte-exactness: every assertion is a substring `in` / `not in` check or a
 * line-count check on the returned string, matching the Python checks; the
 * fixtures are pure ASCII so code-unit length equals UTF-8 byte length.
 */
import { describe, expect, it } from "vitest";

import { KubectlFilter } from "../src/token_goat/bash_compress.js";

// ---------------------------------------------------------------------------
// Helper
// ---------------------------------------------------------------------------

const _f = new KubectlFilter();

function _kubectl(stdout: string, argv: string[], exit_code = 0): string {
  return _f.apply(stdout, "", exit_code, argv).text;
}

// ---------------------------------------------------------------------------
// _compress_kubectl_events via "kubectl get events"
// ---------------------------------------------------------------------------

const _EVENTS_HEADER =
  "LAST SEEN   TYPE      REASON              OBJECT                    MESSAGE";

function _make_events_table(
  rows: Array<[string, string, string, string, string]>,
): string {
  const lines = [_EVENTS_HEADER];
  for (const [last_seen, typ, reason, obj, msg] of rows) {
    lines.push(
      `${last_seen.padEnd(11)} ${typ.padEnd(9)} ${reason.padEnd(19)} ${obj.padEnd(25)} ${msg}`,
    );
  }
  return lines.join("\n");
}

describe("kubectl enhanced events", () => {
  it("test_events_few_rows_passthrough", () => {
    // Fewer than 5 total rows -> no elision.
    const table = _make_events_table([
      ["5s", "Normal", "Scheduled", "pod/foo", "assigned"],
      ["4s", "Normal", "Pulled", "pod/foo", "image pulled"],
    ]);
    const result = _kubectl(table, ["kubectl", "get", "events"]);
    expect(result).toContain("Scheduled");
    expect(result).toContain("Pulled");
    expect(result).not.toContain("elided");
  });

  it("test_events_repeated_reason_collapsed", () => {
    // 10 rows with the same REASON -> keep last 3, elide older 7.
    const rows = Array.from(
      { length: 10 },
      (_, i): [string, string, string, string, string] => [
        "60s",
        "Warning",
        "BackOff",
        "pod/app-1",
        `restart #${i}`,
      ],
    );
    const table = _make_events_table(rows);
    const result = _kubectl(table, ["kubectl", "get", "events"]);
    expect(result).toContain("BackOff");
    expect(result.toLowerCase()).toContain("elided");
    const backoff_data = result
      .split("\n")
      .filter(
        (ln) => ln.includes("BackOff") && !ln.toLowerCase().includes("elided"),
      );
    expect(backoff_data.length).toBeLessThanOrEqual(3);
  });

  it("test_events_mixed_reasons_each_capped", () => {
    // Different REASON values each get their own bucket; non-overflow ones pass.
    const rows: Array<[string, string, string, string, string]> = [
      ...Array.from(
        { length: 5 },
        (_, i): [string, string, string, string, string] => [
          "60s",
          "Warning",
          "BackOff",
          "pod/app",
          `restart #${i}`,
        ],
      ),
      ["30s", "Normal", "Scheduled", "pod/app", "assigned to node"],
      ["20s", "Normal", "Pulled", "pod/app", "image pulled"],
    ];
    const table = _make_events_table(rows);
    const result = _kubectl(table, ["kubectl", "get", "events"]);
    expect(result).toContain("Scheduled");
    expect(result).toContain("Pulled");
    expect(result).toContain("BackOff");
    expect(result.toLowerCase()).toContain("elided");
  });

  it("test_events_alias_ev", () => {
    // 'kubectl get ev' triggers the event compressor.
    const rows = Array.from(
      { length: 8 },
      (_, i): [string, string, string, string, string] => [
        "60s",
        "Warning",
        "BackOff",
        "pod/x",
        `msg ${i}`,
      ],
    );
    const table = _make_events_table(rows);
    const result = _kubectl(table, ["kubectl", "get", "ev"]);
    expect(result).toContain("BackOff");
    expect(result.toLowerCase()).toContain("elided");
  });

  it("test_events_alias_event", () => {
    // 'kubectl get event' (singular) triggers the event compressor.
    const rows = Array.from(
      { length: 6 },
      (_, i): [string, string, string, string, string] => [
        "60s",
        "Warning",
        "OOMKilled",
        "pod/x",
        `msg ${i}`,
      ],
    );
    const table = _make_events_table(rows);
    const result = _kubectl(table, ["kubectl", "get", "event"]);
    expect(result).toContain("OOMKilled");
    expect(result.toLowerCase()).toContain("elided");
  });

  it("test_events_non_events_header_falls_back_to_table", () => {
    // Output without REASON header falls back to generic table compressor.
    const table =
      "NAME    READY   STATUS\npod-a   1/1     Running\npod-b   1/1     Running";
    const result = _kubectl(table, ["kubectl", "get", "events"]);
    expect(result).toContain("pod-a");
  });

  it("test_events_total_summary_has_field_selector_hint", () => {
    // A total summary line with --field-selector hint appears when events are
    // collapsed.
    const rows: Array<[string, string, string, string, string]> = [
      ...Array.from(
        { length: 6 },
        (_, i): [string, string, string, string, string] => [
          "60s",
          "Warning",
          "BackOff",
          "pod/app",
          `r#${i}`,
        ],
      ),
      ...Array.from(
        { length: 6 },
        (_, i): [string, string, string, string, string] => [
          "10s",
          "Warning",
          "OOMKilled",
          "pod/app",
          `k#${i}`,
        ],
      ),
    ];
    const table = _make_events_table(rows);
    const result = _kubectl(table, ["kubectl", "get", "events"]);
    expect(result).toContain("--field-selector");
  });

  it("test_events_header_preserved", () => {
    // The column header row is always present in the output.
    const rows = Array.from(
      { length: 5 },
      (_, i): [string, string, string, string, string] => [
        "60s",
        "Warning",
        "BackOff",
        "pod/x",
        `msg ${i}`,
      ],
    );
    const table = _make_events_table(rows);
    const result = _kubectl(table, ["kubectl", "get", "events"]);
    expect(result).toContain("LAST SEEN");
    expect(result).toContain("REASON");
  });
});

// ---------------------------------------------------------------------------
// Enhanced _compress_kubectl_describe
// ---------------------------------------------------------------------------

const _POD_DESCRIBE = `Name:         my-pod
Namespace:    production
Priority:     0
Node:         node-1/10.0.0.1
Labels:       app=web
              env=prod
              tier=frontend
              version=v1.2.3
              managed-by=helm
Annotations:  kubectl.kubernetes.io/last-applied-configuration: {"apiVersion":"v1"}
              meta.helm.sh/release-name: my-release
              meta.helm.sh/release-namespace: production
              checksum/config: abcdef1234567890abcdef
              checksum/secret: 1234567890abcdef1234567890
Status:       Running
IP:           10.1.2.3
Containers:
  web:
    Image:          nginx:1.25
    State:          Running
      Started:      Mon, 01 Jan 2024 00:00:00 +0000
    Ready:          True
    Restart Count:  0
    Limits:
      cpu:     500m
      memory:  128Mi
    Requests:
      cpu:     250m
      memory:  64Mi
Conditions:
  Type              Status
  Initialized       True
  Ready             True
  ContainersReady   True
  PodScheduled      True
Volumes:
  default-token-abcde:
    Type:        Secret
    SecretName:  default-token-abcde
Events:
  Type    Reason     Age   From               Message
  ----    ------     ----  ----               -------
  Normal  Scheduled  5m    default-scheduler  Successfully assigned
  Normal  Pulled     4m    kubelet            image already present
  Normal  Created    4m    kubelet            Created container web
  Normal  Started    4m    kubelet            Started container web
`;

describe("kubectl enhanced describe", () => {
  it("test_describe_name_namespace_kept", () => {
    const result = _kubectl(_POD_DESCRIBE, ["kubectl", "describe", "pod", "my-pod"]);
    expect(result).toContain("Name:         my-pod");
    expect(result).toContain("Namespace:    production");
  });

  it("test_describe_status_ip_kept", () => {
    const result = _kubectl(_POD_DESCRIBE, ["kubectl", "describe", "pod", "my-pod"]);
    expect(result).toContain("Status:       Running");
    expect(result).toContain("IP:           10.1.2.3");
  });

  it("test_describe_labels_collapsed", () => {
    // Labels block with 5 entries -> keep 3 + elision notice.
    const result = _kubectl(_POD_DESCRIBE, ["kubectl", "describe", "pod", "my-pod"]);
    expect(result).toContain("Labels:");
    expect(result).toContain("more entries elided");
    // At most 3 label data lines kept
    const label_data = result
      .split("\n")
      .filter(
        (ln) =>
          (ln.includes("=") && ln.includes("app=")) ||
          ln.includes("env=") ||
          ln.includes("tier="),
      );
    expect(label_data.length).toBeLessThanOrEqual(3);
  });

  it("test_describe_annotations_collapsed", () => {
    // Annotations block with 5 entries -> elision notice.
    const result = _kubectl(_POD_DESCRIBE, ["kubectl", "describe", "pod", "my-pod"]);
    expect(result).toContain("Annotations:");
    expect(result).toContain("more entries elided");
  });

  it("test_describe_conditions_kept_in_full", () => {
    // Conditions section is kept entirely - it is a compact, high-signal table.
    const result = _kubectl(_POD_DESCRIBE, ["kubectl", "describe", "pod", "my-pod"]);
    expect(result).toContain("Conditions:");
    expect(result).toContain("Initialized");
    expect(result).toContain("PodScheduled");
  });

  it("test_describe_container_image_kept", () => {
    // Image field extracted from nested container block.
    const result = _kubectl(_POD_DESCRIBE, ["kubectl", "describe", "pod", "my-pod"]);
    expect(result).toContain("Image:");
    expect(result).toContain("nginx:1.25");
  });

  it("test_describe_container_state_ready_restart_kept", () => {
    const result = _kubectl(_POD_DESCRIBE, ["kubectl", "describe", "pod", "my-pod"]);
    expect(result).toContain("State:");
    expect(result).toContain("Ready:");
    expect(result).toContain("Restart Count:");
  });

  it("test_describe_resource_limits_kept", () => {
    const result = _kubectl(_POD_DESCRIBE, ["kubectl", "describe", "pod", "my-pod"]);
    expect(result).toContain("Limits:");
    expect(result).toContain("cpu:");
    expect(result).toContain("memory:");
  });

  it("test_describe_events_kept", () => {
    const result = _kubectl(_POD_DESCRIBE, ["kubectl", "describe", "pod", "my-pod"]);
    expect(result).toContain("Events:");
    expect(result).toContain("Scheduled");
  });

  it("test_describe_events_elided_when_many", () => {
    // More than 10 event lines -> elision count notice appears.
    const many_events = Array.from(
      { length: 15 },
      (_, i) => `  Normal  Pulled  ${i}m  kubelet  message ${i}`,
    ).join("\n");
    const text = `Name:   x\nNamespace:   y\nStatus:   Running\nEvents:\n${many_events}\n`;
    const result = _kubectl(text, ["kubectl", "describe", "pod", "x"]);
    expect(result).toContain("earlier events elided");
  });

  it("test_describe_fallback_when_nothing_recognized", () => {
    // Describe output with no recognisable keys -> fallback truncation marker.
    const result = _kubectl(
      "SomeUnknownField: value\nAnother: line\n",
      ["kubectl", "describe", "pod", "x"],
    );
    expect(result).toContain("[token-goat: describe output truncated]");
  });

  it("test_describe_empty_labels_no_continuation", () => {
    // Labels with no indented continuation lines works without error.
    const text = "Name:   x\nNamespace:   y\nLabels:      <none>\nStatus:   Running\n";
    const result = _kubectl(text, ["kubectl", "describe", "pod", "x"]);
    expect(result).toContain("Name:");
  });

  it("test_describe_conditions_do_not_bleed_into_events", () => {
    // Conditions section stops before Events; Events are still captured separately.
    const result = _kubectl(_POD_DESCRIBE, ["kubectl", "describe", "pod", "my-pod"]);
    const lines = result.split("\n");
    const cond_idx = lines.findIndex((ln) => ln.includes("Conditions:"));
    const ev_idx = lines.findIndex((ln) => ln.trim() === "Events:");
    expect(cond_idx).not.toBe(-1);
    expect(ev_idx).not.toBe(-1);
    expect(ev_idx).toBeGreaterThan(cond_idx);
  });
});

// ---------------------------------------------------------------------------
// Regression: plain "kubectl get pods" still uses generic table compressor
// ---------------------------------------------------------------------------

describe("kubectl get pods regression", () => {
  it("test_get_pods_uses_table_compressor_not_events", () => {
    // kubectl get pods (resource != events) still uses table compressor.
    const header = "NAME    READY   STATUS    RESTARTS   AGE";
    const rows = Array.from(
      { length: 20 },
      (_, i) => `pod-${i}   1/1     Running   0          1m`,
    );
    const table = [header, ...rows].join("\n");
    const result = _kubectl(table, ["kubectl", "get", "pods"]);
    expect(result).toContain("more rows");
    expect(result).not.toContain("--field-selector");
  });

  it("test_describe_no_labels_annotations_sections", () => {
    // Describe output without Labels or Annotations sections works without error.
    const text = [
      "Name:         my-configmap",
      "Namespace:    default",
      "Data",
      "====",
      "config.yaml:",
      "----",
      "key: value",
      "",
      "Events: <none>",
    ].join("\n");
    const result = _kubectl(text, ["kubectl", "describe", "configmap", "my-configmap"]);
    expect(result).toContain("Name:");
    expect(result).toContain("Events:");
  });
});
