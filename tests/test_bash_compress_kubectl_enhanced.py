"""Tests for enhanced kubectl compression: events dedup and improved describe."""
from __future__ import annotations

from token_goat import bash_compress as bc

# ---------------------------------------------------------------------------
# Helper
# ---------------------------------------------------------------------------

_f = bc.KubectlFilter()


def _kubectl(stdout: str, argv: list[str], exit_code: int = 0) -> str:
    return _f.apply(stdout, "", exit_code, argv).text


# ---------------------------------------------------------------------------
# _compress_kubectl_events via "kubectl get events"
# ---------------------------------------------------------------------------

_EVENTS_HEADER = "LAST SEEN   TYPE      REASON              OBJECT                    MESSAGE"


def _make_events_table(rows: list[tuple[str, str, str, str, str]]) -> str:
    lines = [_EVENTS_HEADER]
    for last_seen, typ, reason, obj, msg in rows:
        lines.append(f"{last_seen:<11} {typ:<9} {reason:<19} {obj:<25} {msg}")
    return "\n".join(lines)


def test_events_few_rows_passthrough():
    """Fewer than 5 total rows → no elision."""
    table = _make_events_table([
        ("5s", "Normal", "Scheduled", "pod/foo", "assigned"),
        ("4s", "Normal", "Pulled", "pod/foo", "image pulled"),
    ])
    result = _kubectl(table, ["kubectl", "get", "events"])
    assert "Scheduled" in result
    assert "Pulled" in result
    assert "elided" not in result


def test_events_repeated_reason_collapsed():
    """10 rows with the same REASON → keep last 3, elide older 7."""
    rows = [("60s", "Warning", "BackOff", "pod/app-1", f"restart #{i}") for i in range(10)]
    table = _make_events_table(rows)
    result = _kubectl(table, ["kubectl", "get", "events"])
    assert "BackOff" in result
    assert "elided" in result.lower()
    backoff_data = [ln for ln in result.splitlines() if "BackOff" in ln and "elided" not in ln.lower()]
    assert len(backoff_data) <= 3


def test_events_mixed_reasons_each_capped():
    """Different REASON values each get their own bucket; non-overflow ones pass through."""
    rows = (
        [("60s", "Warning", "BackOff", "pod/app", f"restart #{i}") for i in range(5)]
        + [("30s", "Normal", "Scheduled", "pod/app", "assigned to node")]
        + [("20s", "Normal", "Pulled", "pod/app", "image pulled")]
    )
    table = _make_events_table(rows)
    result = _kubectl(table, ["kubectl", "get", "events"])
    assert "Scheduled" in result
    assert "Pulled" in result
    assert "BackOff" in result
    assert "elided" in result.lower()


def test_events_alias_ev():
    """'kubectl get ev' triggers the event compressor."""
    rows = [("60s", "Warning", "BackOff", "pod/x", f"msg {i}") for i in range(8)]
    table = _make_events_table(rows)
    result = _kubectl(table, ["kubectl", "get", "ev"])
    assert "BackOff" in result
    assert "elided" in result.lower()


def test_events_alias_event():
    """'kubectl get event' (singular) triggers the event compressor."""
    rows = [("60s", "Warning", "OOMKilled", "pod/x", f"msg {i}") for i in range(6)]
    table = _make_events_table(rows)
    result = _kubectl(table, ["kubectl", "get", "event"])
    assert "OOMKilled" in result
    assert "elided" in result.lower()


def test_events_non_events_header_falls_back_to_table():
    """Output without REASON header falls back to generic table compressor."""
    table = "NAME    READY   STATUS\npod-a   1/1     Running\npod-b   1/1     Running"
    result = _kubectl(table, ["kubectl", "get", "events"])
    assert "pod-a" in result


def test_events_total_summary_has_field_selector_hint():
    """A total summary line with --field-selector hint appears when events are collapsed."""
    rows = (
        [("60s", "Warning", "BackOff", "pod/app", f"r#{i}") for i in range(6)]
        + [("10s", "Warning", "OOMKilled", "pod/app", f"k#{i}") for i in range(6)]
    )
    table = _make_events_table(rows)
    result = _kubectl(table, ["kubectl", "get", "events"])
    assert "--field-selector" in result


def test_events_header_preserved():
    """The column header row is always present in the output."""
    rows = [("60s", "Warning", "BackOff", "pod/x", f"msg {i}") for i in range(5)]
    table = _make_events_table(rows)
    result = _kubectl(table, ["kubectl", "get", "events"])
    assert "LAST SEEN" in result
    assert "REASON" in result


# ---------------------------------------------------------------------------
# Enhanced _compress_kubectl_describe
# ---------------------------------------------------------------------------

_POD_DESCRIBE = """\
Name:         my-pod
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
"""


def test_describe_name_namespace_kept():
    result = _kubectl(_POD_DESCRIBE, ["kubectl", "describe", "pod", "my-pod"])
    assert "Name:         my-pod" in result
    assert "Namespace:    production" in result


def test_describe_status_ip_kept():
    result = _kubectl(_POD_DESCRIBE, ["kubectl", "describe", "pod", "my-pod"])
    assert "Status:       Running" in result
    assert "IP:           10.1.2.3" in result


def test_describe_labels_collapsed():
    """Labels block with 5 entries → keep 3 + elision notice."""
    result = _kubectl(_POD_DESCRIBE, ["kubectl", "describe", "pod", "my-pod"])
    assert "Labels:" in result
    assert "more entries elided" in result
    # At most 3 label data lines kept
    label_data = [ln for ln in result.splitlines() if "=" in ln and "app=" in ln or "env=" in ln or "tier=" in ln]
    assert len(label_data) <= 3


def test_describe_annotations_collapsed():
    """Annotations block with 5 entries → elision notice."""
    result = _kubectl(_POD_DESCRIBE, ["kubectl", "describe", "pod", "my-pod"])
    assert "Annotations:" in result
    assert "more entries elided" in result


def test_describe_conditions_kept_in_full():
    """Conditions section is kept entirely — it is a compact, high-signal table."""
    result = _kubectl(_POD_DESCRIBE, ["kubectl", "describe", "pod", "my-pod"])
    assert "Conditions:" in result
    assert "Initialized" in result
    assert "PodScheduled" in result


def test_describe_container_image_kept():
    """Image field extracted from nested container block."""
    result = _kubectl(_POD_DESCRIBE, ["kubectl", "describe", "pod", "my-pod"])
    assert "Image:" in result
    assert "nginx:1.25" in result


def test_describe_container_state_ready_restart_kept():
    result = _kubectl(_POD_DESCRIBE, ["kubectl", "describe", "pod", "my-pod"])
    assert "State:" in result
    assert "Ready:" in result
    assert "Restart Count:" in result


def test_describe_resource_limits_kept():
    result = _kubectl(_POD_DESCRIBE, ["kubectl", "describe", "pod", "my-pod"])
    assert "Limits:" in result
    assert "cpu:" in result
    assert "memory:" in result


def test_describe_events_kept():
    result = _kubectl(_POD_DESCRIBE, ["kubectl", "describe", "pod", "my-pod"])
    assert "Events:" in result
    assert "Scheduled" in result


def test_describe_events_elided_when_many():
    """More than 10 event lines → elision count notice appears."""
    many_events = "\n".join(
        f"  Normal  Pulled  {i}m  kubelet  message {i}" for i in range(15)
    )
    text = f"Name:   x\nNamespace:   y\nStatus:   Running\nEvents:\n{many_events}\n"
    result = _kubectl(text, ["kubectl", "describe", "pod", "x"])
    assert "earlier events elided" in result


def test_describe_fallback_when_nothing_recognized():
    """Describe output with no recognisable keys → fallback truncation marker."""
    result = _kubectl(
        "SomeUnknownField: value\nAnother: line\n",
        ["kubectl", "describe", "pod", "x"],
    )
    assert "[token-goat: describe output truncated]" in result


def test_describe_empty_labels_no_continuation():
    """Labels with no indented continuation lines works without error."""
    text = "Name:   x\nNamespace:   y\nLabels:      <none>\nStatus:   Running\n"
    result = _kubectl(text, ["kubectl", "describe", "pod", "x"])
    assert "Name:" in result


def test_describe_conditions_do_not_bleed_into_events():
    """Conditions section stops before Events; Events are still captured separately."""
    result = _kubectl(_POD_DESCRIBE, ["kubectl", "describe", "pod", "my-pod"])
    lines = result.splitlines()
    cond_idx = next((i for i, ln in enumerate(lines) if "Conditions:" in ln), -1)
    ev_idx = next((i for i, ln in enumerate(lines) if ln.strip() == "Events:"), -1)
    assert cond_idx != -1
    assert ev_idx != -1
    assert ev_idx > cond_idx


# ---------------------------------------------------------------------------
# Regression: plain "kubectl get pods" still uses generic table compressor
# ---------------------------------------------------------------------------

def test_get_pods_uses_table_compressor_not_events():
    """kubectl get pods (resource != events) still uses table compressor."""
    header = "NAME    READY   STATUS    RESTARTS   AGE"
    rows = [f"pod-{i}   1/1     Running   0          1m" for i in range(20)]
    table = "\n".join([header] + rows)
    result = _kubectl(table, ["kubectl", "get", "pods"])
    assert "more rows" in result
    assert "--field-selector" not in result


def test_describe_no_labels_annotations_sections() -> None:
    """Describe output without Labels or Annotations sections works without error."""
    text = "\n".join([
        "Name:         my-configmap",
        "Namespace:    default",
        "Data",
        "====",
        "config.yaml:",
        "----",
        "key: value",
        "",
        "Events: <none>",
    ])
    result = _kubectl(text, ["kubectl", "describe", "configmap", "my-configmap"])
    assert "Name:" in result
    assert "Events:" in result
