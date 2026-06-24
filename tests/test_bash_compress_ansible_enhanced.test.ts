/**
 * Enhanced tests for AnsibleFilter in bash_compress.
 *
 * 1:1 port of tests/test_bash_compress_ansible_enhanced.py. Every Python `def
 * test_*` maps to a vitest `it()` with the SAME name and assertion polarity.
 *
 * Covers:
 *   - Verbose ok/changed/skipped JSON payloads suppressed and reported in
 *     per-task note
 *   - Gathering Facts verbose JSON blob suppressed (same mechanism)
 *   - Deeply nested JSON (nested braces) suppressed correctly
 *   - Fatal/failure payloads still kept verbatim (not suppressed)
 *   - --check / -C dry-run annotation prepended to output
 *   - Non-verbose (no JSON payload) output unaffected
 *   - Payload count accurate in flush_status note
 *   - Structural boundary (new TASK header) exits success-payload mode safely
 *   - Per-task [token-goat: N ok, M payloads elided] annotation
 *
 * Test-seam mapping (Python -> TS):
 *  - `from token_goat.bash_compress import AnsibleFilter`
 *      -> import { AnsibleFilter } from the barrel
 *         "../src/token_goat/bash_compress.js".
 *  - `_af()` -> `new AnsibleFilter()`.
 *  - `_compress(stdout, stderr, exit_code, argv)` calls
 *     `_af().compress(stdout, stderr, exit_code, argv)` directly (the Python
 *     helper does the same), defaulting argv to ["ansible-playbook", "site.yml"].
 *
 * Byte-exactness: every assertion is a substring `in` / `not in` check or a
 * `.find()`/`indexOf` position comparison on the returned string. The fixtures
 * are pure ASCII so Python `str.find` (code points) equals JS `indexOf` (UTF-16
 * code units); no Buffer arithmetic is needed for these particular tests.
 */
import { describe, expect, it } from "vitest";

import { AnsibleFilter } from "../src/token_goat/bash_compress.js";

// ---------------------------------------------------------------------------
// Helpers (ports of _af and _compress).
// ---------------------------------------------------------------------------
function _af(): AnsibleFilter {
  return new AnsibleFilter();
}

function _compress(
  stdout: string,
  opts?: { stderr?: string; exit_code?: number; argv?: string[] },
): string {
  const stderr = opts?.stderr ?? "";
  const exit_code = opts?.exit_code ?? 0;
  const argv = opts?.argv ?? ["ansible-playbook", "site.yml"];
  return _af().compress(stdout, stderr, exit_code, argv);
}

// ---------------------------------------------------------------------------
// Verbose ok payload suppression
// ---------------------------------------------------------------------------

describe("test_bash_compress_ansible_enhanced", () => {
  it("test_verbose_ok_payload_suppressed", () => {
    // With -v, ok lines include a multi-line => {} JSON block that should be
    // suppressed.
    const out = [
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
    ].join("\n");
    const result = _compress(out);
    // Status counts are reported
    expect(result).toContain("2 ok");
    // JSON payload lines are suppressed
    expect(result).not.toContain('"ping"');
    expect(result).not.toContain('"changed": false');
    // Payload elision is noted (2 hosts, 2 payloads)
    expect(result).toContain("2 verbose payloads elided");
  });

  it("test_verbose_ok_payload_elided_count_accurate", () => {
    // Two hosts with payloads -> 2 elided.
    const out = [
      "TASK [debug] *****",
      "ok: [alpha] => {",
      '    "msg": "hello"',
      "}",
      "ok: [beta] => {",
      '    "msg": "hello"',
      "}",
    ].join("\n");
    const result = _compress(out);
    expect(result).toContain("2 verbose payloads elided");
  });

  it("test_verbose_single_payload_singular_form", () => {
    // One elided payload uses singular "payload" not "payloads".
    const out = [
      "TASK [check] *****",
      "ok: [host1] => {",
      '    "msg": "ok"',
      "}",
    ].join("\n");
    const result = _compress(out);
    expect(result).toContain("1 verbose payload elided");
    expect(result).not.toContain("payloads");
  });

  it("test_verbose_changed_payload_suppressed", () => {
    const out = [
      "TASK [copy file] *****",
      "changed: [host1] => {",
      '    "changed": true,',
      '    "dest": "/etc/foo.conf"',
      "}",
    ].join("\n");
    const result = _compress(out);
    expect(result).toContain("1 changed");
    expect(result).not.toContain('"dest"');
    expect(result).toContain("1 verbose payload elided");
  });

  it("test_verbose_skipped_payload_suppressed", () => {
    const out = [
      "TASK [conditional] *****",
      "skipping: [host1] => {",
      '    "false_condition": "True"',
      "}",
    ].join("\n");
    const result = _compress(out);
    expect(result).toContain("1 skipping");
    expect(result).not.toContain('"false_condition"');
    expect(result).toContain("1 verbose payload elided");
  });

  // -------------------------------------------------------------------------
  // Gathering Facts verbose blob
  // -------------------------------------------------------------------------

  it("test_gathering_facts_verbose_json_suppressed", () => {
    // Gathering Facts with -v dumps enormous JSON per host; must be suppressed.
    const facts_lines: string[] = [];
    for (let i = 0; i < 30; i++) {
      facts_lines.push(`    "ansible_fact_${i}": "value_${i}",`);
    }
    const out = [
      "PLAY [all] *****",
      "",
      "TASK [Gathering Facts] *****",
      "ok: [server1] => {",
      '    "ansible_facts": {',
      ...facts_lines,
      "    },",
      '    "changed": false',
      "}",
      "ok: [server2] => {",
      '    "ansible_facts": {',
      ...facts_lines,
      "    },",
      '    "changed": false',
      "}",
      "",
      "PLAY RECAP *****",
      "server1 : ok=1 changed=0 unreachable=0 failed=0",
      "server2 : ok=1 changed=0 unreachable=0 failed=0",
    ].join("\n");
    const result = _compress(out);
    // Two ok lines counted
    expect(result).toContain("2 ok");
    // Facts JSON is suppressed
    expect(result).not.toContain("ansible_fact_");
    // Both payloads noted
    expect(result).toContain("2 verbose payloads elided");
    // PLAY RECAP kept verbatim
    expect(result).toContain("ok=1");
  });

  // -------------------------------------------------------------------------
  // Deeply nested JSON (nested braces)
  // -------------------------------------------------------------------------

  it("test_deeply_nested_json_payload_suppressed", () => {
    // Brace counting must handle nested structures correctly.
    const out = [
      "TASK [nested result] *****",
      "ok: [host] => {",
      '    "result": {',
      '        "inner": {',
      '            "deep": "value"',
      "        }",
      "    }",
      "}",
    ].join("\n");
    const result = _compress(out);
    expect(result).toContain("1 ok");
    expect(result).not.toContain('"deep"');
    expect(result).toContain("1 verbose payload elided");
  });

  // -------------------------------------------------------------------------
  // Failure payloads are NOT suppressed
  // -------------------------------------------------------------------------

  it("test_failure_payload_kept_verbatim", () => {
    // fatal: lines and their => {} payload must be preserved (different from ok
    // payloads).
    const out = [
      "TASK [install pkg] *****",
      "fatal: [host1]: FAILED! => {",
      '    "msg": "No package matching foo found"',
      "}",
      "",
    ].join("\n");
    const result = _compress(out);
    expect(result).toContain("fatal:");
    expect(result).toContain('"msg"');
    expect(result).toContain("No package matching foo found");
  });

  it("test_failure_payload_not_marked_as_elided", () => {
    const out = [
      "TASK [run cmd] *****",
      "fatal: [host1]: FAILED! => {",
      '    "rc": 1,',
      '    "stderr": "command not found"',
      "}",
    ].join("\n");
    const result = _compress(out);
    // No elision note since this is a failure (which we always keep).
    expect(result).not.toContain("elided");
    expect(result).toContain('"rc": 1');
  });

  // -------------------------------------------------------------------------
  // Non-verbose (no JSON payload) output is unaffected
  // -------------------------------------------------------------------------

  it("test_non_verbose_output_unchanged", () => {
    // Without -v, ok lines have no JSON payload; counts still work.
    const out = [
      "PLAY [servers] *****",
      "",
      "TASK [ping] *****",
      "ok: [host1]",
      "ok: [host2]",
      "ok: [host3]",
      "",
      "PLAY RECAP *****",
      "host1 : ok=1 changed=0 unreachable=0 failed=0",
    ].join("\n");
    const result = _compress(out);
    expect(result).toContain("3 ok");
    expect(result).not.toContain("verbose payload");
    expect(result).not.toContain("elided");
    expect(result).toContain("PLAY RECAP");
    expect(result).toContain("ok=1");
  });

  it("test_headers_always_kept", () => {
    const out = [
      "PLAY [webservers] *****",
      "TASK [Gathering Facts] *****",
      "ok: [host1]",
      "TASK [install nginx] *****",
      "ok: [host1]",
    ].join("\n");
    const result = _compress(out);
    expect(result).toContain("PLAY [webservers]");
    expect(result).toContain("TASK [Gathering Facts]");
    expect(result).toContain("TASK [install nginx]");
  });

  // -------------------------------------------------------------------------
  // --check / -C dry-run annotation
  // -------------------------------------------------------------------------

  it("test_check_mode_annotation_long_flag", () => {
    const out = "PLAY [all] *****\nTASK [test] *****\nok: [h1]\n";
    const result = _compress(out, {
      argv: ["ansible-playbook", "site.yml", "--check"],
    });
    expect(result).toContain("--check");
    expect(result).toContain("no actual changes");
  });

  it("test_check_flag_short_form", () => {
    const out = "PLAY [all] *****\nTASK [test] *****\nok: [h1]\n";
    const result = _compress(out, {
      argv: ["ansible-playbook", "-C", "site.yml"],
    });
    expect(result).toContain("dry run");
  });

  it("test_no_check_annotation_without_flag", () => {
    const out = "PLAY [all] *****\nTASK [test] *****\nok: [h1]\n";
    const result = _compress(out, { argv: ["ansible-playbook", "site.yml"] });
    expect(result).not.toContain("dry run");
    expect(result).not.toContain("--check");
  });

  it("test_check_annotation_appears_first", () => {
    // The dry-run note should appear before any PLAY output.
    const out = "PLAY [all] *****\nok: [h1]\n";
    const result = _compress(out, {
      argv: ["ansible-playbook", "--check", "site.yml"],
    });
    const check_pos = result.indexOf("dry run");
    const play_pos = result.indexOf("PLAY [all]");
    expect(check_pos !== -1 && play_pos !== -1).toBe(true);
    expect(check_pos).toBeLessThan(play_pos);
  });

  // -------------------------------------------------------------------------
  // Structural boundary exits success-payload mode safely
  // -------------------------------------------------------------------------

  it("test_new_task_header_exits_payload_mode", () => {
    // If a TASK header appears while we think we're inside a payload, we must
    // exit payload mode so the header is kept (not suppressed).
    const out = [
      "TASK [first] *****",
      "ok: [host] => {",
      '    "changed": false',
      "}",
      "TASK [second] *****",
      "ok: [host]",
    ].join("\n");
    const result = _compress(out);
    expect(result).toContain("TASK [first]");
    expect(result).toContain("TASK [second]");
    expect(result).toContain("1 ok");
  });

  it("test_payload_suppression_does_not_bleed_across_tasks", () => {
    // Payload suppression for task A must not suppress lines from task B.
    const out = [
      "TASK [task A] *****",
      "ok: [host] => {",
      '    "msg": "a"',
      "}",
      "",
      "TASK [task B] *****",
      "ok: [host]",
    ].join("\n");
    const result = _compress(out);
    expect(result).toContain("TASK [task A]");
    expect(result).toContain("TASK [task B]");
    // task B has 1 ok with no payload
    expect(result).not.toContain('"msg": "a"');
  });

  // -------------------------------------------------------------------------
  // Per-task note combines counts and elisions
  // -------------------------------------------------------------------------

  it("test_per_task_note_combines_ok_and_changed_with_elisions", () => {
    const out = [
      "TASK [mixed] *****",
      "ok: [host1] => {",
      '    "changed": false',
      "}",
      "changed: [host2] => {",
      '    "changed": true',
      "}",
      "skipping: [host3]",
    ].join("\n");
    const result = _compress(out);
    expect(result).toContain("1 ok");
    expect(result).toContain("1 changed");
    expect(result).toContain("1 skipping");
    expect(result).toContain("2 verbose payloads elided");
  });

  it("test_inline_single_line_json_not_counted_as_payload", () => {
    // ok: [host] => {"changed": false}  — all one line, no payload mode needed.
    const out = [
      "TASK [check] *****",
      'ok: [host] => {"changed": false, "ping": "pong"}',
    ].join("\n");
    const result = _compress(out);
    expect(result).toContain("1 ok");
    // Single-line JSON is consumed with the status line; no elision note.
    expect(result).not.toContain("elided");
  });
});
