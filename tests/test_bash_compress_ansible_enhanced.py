"""Enhanced tests for AnsibleFilter in bash_compress.py.

Covers:
  - Verbose ok/changed/skipped JSON payloads suppressed and reported in per-task note
  - Gathering Facts verbose JSON blob suppressed (same mechanism)
  - Deeply nested JSON (nested braces) suppressed correctly
  - Fatal/failure payloads still kept verbatim (not suppressed)
  - --check / -C dry-run annotation prepended to output
  - Non-verbose (no JSON payload) output unaffected
  - Payload count accurate in flush_status note
  - Structural boundary (new TASK header) exits success-payload mode safely
  - Per-task [token-goat: N ok, M payloads elided] annotation
"""
from __future__ import annotations

from token_goat.bash_compress import AnsibleFilter


def _af() -> AnsibleFilter:
    return AnsibleFilter()


def _compress(
    stdout: str,
    stderr: str = "",
    exit_code: int = 0,
    argv: list[str] | None = None,
) -> str:
    if argv is None:
        argv = ["ansible-playbook", "site.yml"]
    return _af().compress(stdout, stderr, exit_code, argv)


# ---------------------------------------------------------------------------
# Verbose ok payload suppression
# ---------------------------------------------------------------------------

def test_verbose_ok_payload_suppressed() -> None:
    # With -v, ok lines include a multi-line => {} JSON block that should be suppressed.
    out = "\n".join([
        "PLAY [webservers] *****",
        "",
        "TASK [ping] *****",
        "ok: [host1] => {",
        '    "changed": false,',
        '    "ping": "pong"',
        "}",
        "ok: [host2] => {",
        '    "changed": false,',
        '    "ping": "pong"',
        "}",
        "",
    ])
    result = _compress(out)
    # Status counts are reported
    assert "2 ok" in result
    # JSON payload lines are suppressed
    assert '"ping"' not in result
    assert '"changed": false' not in result
    # Payload elision is noted
    assert "verbose payload" in result or "elided" in result


def test_verbose_ok_payload_elided_count_accurate() -> None:
    # Two hosts with payloads → 2 elided.
    out = "\n".join([
        "TASK [debug] *****",
        "ok: [alpha] => {",
        '    "msg": "hello"',
        "}",
        "ok: [beta] => {",
        '    "msg": "hello"',
        "}",
    ])
    result = _compress(out)
    assert "2 verbose payloads elided" in result


def test_verbose_single_payload_singular_form() -> None:
    # One elided payload uses singular "payload" not "payloads".
    out = "\n".join([
        "TASK [check] *****",
        "ok: [host1] => {",
        '    "msg": "ok"',
        "}",
    ])
    result = _compress(out)
    assert "1 verbose payload elided" in result
    assert "payloads" not in result


def test_verbose_changed_payload_suppressed() -> None:
    out = "\n".join([
        "TASK [copy file] *****",
        "changed: [host1] => {",
        '    "changed": true,',
        '    "dest": "/etc/foo.conf"',
        "}",
    ])
    result = _compress(out)
    assert "1 changed" in result
    assert '"dest"' not in result
    assert "verbose payload" in result or "elided" in result


def test_verbose_skipped_payload_suppressed() -> None:
    out = "\n".join([
        "TASK [conditional] *****",
        "skipping: [host1] => {",
        '    "false_condition": "True"',
        "}",
    ])
    result = _compress(out)
    assert "1 skipping" in result
    assert '"false_condition"' not in result


# ---------------------------------------------------------------------------
# Gathering Facts verbose blob
# ---------------------------------------------------------------------------

def test_gathering_facts_verbose_json_suppressed() -> None:
    # Gathering Facts with -v dumps enormous JSON per host; must be suppressed.
    facts_lines = [f'    "ansible_fact_{i}": "value_{i}",' for i in range(30)]
    out = "\n".join([
        "PLAY [all] *****",
        "",
        "TASK [Gathering Facts] *****",
        "ok: [server1] => {",
        '    "ansible_facts": {',
        *facts_lines,
        "    },",
        '    "changed": false',
        "}",
        "ok: [server2] => {",
        '    "ansible_facts": {',
        *facts_lines,
        "    },",
        '    "changed": false',
        "}",
        "",
        "PLAY RECAP *****",
        "server1 : ok=1 changed=0 unreachable=0 failed=0",
        "server2 : ok=1 changed=0 unreachable=0 failed=0",
    ])
    result = _compress(out)
    # Two ok lines counted
    assert "2 ok" in result
    # Facts JSON is suppressed
    assert "ansible_fact_" not in result
    # Both payloads noted
    assert "2 verbose payloads elided" in result
    # PLAY RECAP kept verbatim
    assert "ok=1" in result


# ---------------------------------------------------------------------------
# Deeply nested JSON (nested braces)
# ---------------------------------------------------------------------------

def test_deeply_nested_json_payload_suppressed() -> None:
    # Brace counting must handle nested structures correctly.
    out = "\n".join([
        "TASK [nested result] *****",
        "ok: [host] => {",
        '    "result": {',
        '        "inner": {',
        '            "deep": "value"',
        "        }",
        "    }",
        "}",
    ])
    result = _compress(out)
    assert "1 ok" in result
    assert '"deep"' not in result
    assert "1 verbose payload elided" in result


# ---------------------------------------------------------------------------
# Failure payloads are NOT suppressed
# ---------------------------------------------------------------------------

def test_failure_payload_kept_verbatim() -> None:
    # fatal: lines and their => {} payload must be preserved (different from ok payloads).
    out = "\n".join([
        "TASK [install pkg] *****",
        "fatal: [host1]: FAILED! => {",
        '    "msg": "No package matching foo found"',
        "}",
        "",
    ])
    result = _compress(out)
    assert "fatal:" in result
    assert '"msg"' in result
    assert "No package matching foo found" in result


def test_failure_payload_not_marked_as_elided() -> None:
    out = "\n".join([
        "TASK [run cmd] *****",
        "fatal: [host1]: FAILED! => {",
        '    "rc": 1,',
        '    "stderr": "command not found"',
        "}",
    ])
    result = _compress(out)
    # No elision note since this is a failure (which we always keep).
    assert "elided" not in result
    assert '"rc": 1' in result


# ---------------------------------------------------------------------------
# Non-verbose (no JSON payload) output is unaffected
# ---------------------------------------------------------------------------

def test_non_verbose_output_unchanged() -> None:
    # Without -v, ok lines have no JSON payload; counts still work.
    out = "\n".join([
        "PLAY [servers] *****",
        "",
        "TASK [ping] *****",
        "ok: [host1]",
        "ok: [host2]",
        "ok: [host3]",
        "",
        "PLAY RECAP *****",
        "host1 : ok=1 changed=0 unreachable=0 failed=0",
    ])
    result = _compress(out)
    assert "3 ok" in result
    assert "verbose payload" not in result
    assert "elided" not in result
    assert "PLAY RECAP" in result
    assert "ok=1" in result


def test_headers_always_kept() -> None:
    out = "\n".join([
        "PLAY [webservers] *****",
        "TASK [Gathering Facts] *****",
        "ok: [host1]",
        "TASK [install nginx] *****",
        "ok: [host1]",
    ])
    result = _compress(out)
    assert "PLAY [webservers]" in result
    assert "TASK [Gathering Facts]" in result
    assert "TASK [install nginx]" in result


# ---------------------------------------------------------------------------
# --check / -C dry-run annotation
# ---------------------------------------------------------------------------

def test_check_mode_annotation_long_flag() -> None:
    out = "PLAY [all] *****\nTASK [test] *****\nok: [h1]\n"
    result = _compress(out, argv=["ansible-playbook", "site.yml", "--check"])
    assert "--check" in result or "dry run" in result
    assert "no actual changes" in result


def test_check_flag_short_form() -> None:
    out = "PLAY [all] *****\nTASK [test] *****\nok: [h1]\n"
    result = _compress(out, argv=["ansible-playbook", "-C", "site.yml"])
    assert "dry run" in result


def test_no_check_annotation_without_flag() -> None:
    out = "PLAY [all] *****\nTASK [test] *****\nok: [h1]\n"
    result = _compress(out, argv=["ansible-playbook", "site.yml"])
    assert "dry run" not in result
    assert "--check" not in result


def test_check_annotation_appears_first() -> None:
    # The dry-run note should appear before any PLAY output.
    out = "PLAY [all] *****\nok: [h1]\n"
    result = _compress(out, argv=["ansible-playbook", "--check", "site.yml"])
    check_pos = result.find("dry run")
    play_pos = result.find("PLAY [all]")
    assert check_pos != -1 and play_pos != -1
    assert check_pos < play_pos


# ---------------------------------------------------------------------------
# Structural boundary exits success-payload mode safely
# ---------------------------------------------------------------------------

def test_new_task_header_exits_payload_mode() -> None:
    # If a TASK header appears while we think we're inside a payload, we must
    # exit payload mode so the header is kept (not suppressed).
    out = "\n".join([
        "TASK [first] *****",
        "ok: [host] => {",
        '    "changed": false',
        "}",
        "TASK [second] *****",
        "ok: [host]",
    ])
    result = _compress(out)
    assert "TASK [first]" in result
    assert "TASK [second]" in result
    assert "1 ok" in result


def test_payload_suppression_does_not_bleed_across_tasks() -> None:
    # Payload suppression for task A must not suppress lines from task B.
    out = "\n".join([
        "TASK [task A] *****",
        "ok: [host] => {",
        '    "msg": "a"',
        "}",
        "",
        "TASK [task B] *****",
        "ok: [host]",
    ])
    result = _compress(out)
    assert "TASK [task A]" in result
    assert "TASK [task B]" in result
    # task B has 1 ok with no payload
    assert '"msg": "a"' not in result


# ---------------------------------------------------------------------------
# Per-task note combines counts and elisions
# ---------------------------------------------------------------------------

def test_per_task_note_combines_ok_and_changed_with_elisions() -> None:
    out = "\n".join([
        "TASK [mixed] *****",
        "ok: [host1] => {",
        '    "changed": false',
        "}",
        "changed: [host2] => {",
        '    "changed": true',
        "}",
        "skipping: [host3]",
    ])
    result = _compress(out)
    assert "1 ok" in result
    assert "1 changed" in result
    assert "1 skipping" in result
    assert "2 verbose payloads elided" in result


def test_inline_single_line_json_not_counted_as_payload() -> None:
    # ok: [host] => {"changed": false}  — all one line, no payload mode needed.
    out = "\n".join([
        "TASK [check] *****",
        'ok: [host] => {"changed": false, "ping": "pong"}',
    ])
    result = _compress(out)
    assert "1 ok" in result
    # Single-line JSON is consumed with the status line; no elision note.
    assert "elided" not in result
