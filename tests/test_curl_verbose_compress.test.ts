/**
 * Tests for curl -v verbose output compression (Iter 37).
 *
 * 1:1 port of tests/test_curl_verbose_compress.py. The helpers
 * (_is_curl_verbose_cmd, _has_curl_verbose_output, compress_curl_verbose) live
 * in bash_compress/post_bash_helpers.ts and are re-exported from the
 * bash_compress barrel; hooks_read.post_bash's curl block looks them up via
 * _bcFn(), so both unit and integration tests run live.
 *
 * Test-seam mapping (Python -> TS):
 *  - The Python integration class wraps post_bash in a stack of mock.patch(...)
 *    over hooks_read internals, but its docstring states the intent: the empty
 *    session_id makes post_bash return CONTINUE() before any session ops, and
 *    the curl block fires regardless of session_id. In the TS port we achieve
 *    the same by passing a payload with no session_id (the session machinery is
 *    skipped: _sess_mod is null), so no internal-helper mocking is needed and
 *    the result is byte-identical.
 *  - tool_response uses the "output" text key (one of the keys
 *    _extract_bash_response scans), matching the Python _make_payload.
 */
import { describe, expect, it } from "vitest";

import {
  _has_curl_verbose_output,
  _is_curl_verbose_cmd,
  compress_curl_verbose,
} from "../src/token_goat/bash_compress.js";
import * as hooks_read from "../src/token_goat/hooks_read.js";
import type { HookPayload } from "../src/token_goat/types.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const FULL_CURL_VERBOSE = `*   Trying 93.184.216.34:443...
* Connected to example.com (93.184.216.34) port 443 (#0)
* ALPN: offers h2,http/1.1
* TLSv1.3 (OUT), TLS handshake, Client hello (1):
* TLSv1.3 (IN), TLS handshake, Server hello (2):
* TLSv1.3 (OUT), TLS change cipher, Change cipher spec (1):
* TLSv1.3 (IN), TLS handshake, Finished (20):
* SSL connection using TLSv1.3 / TLS_AES_256_GCM_SHA384
* Server certificate:
*  subject: CN=example.com
*  expire date: Dec 14 23:59:59 2024 GMT
*  SSL certificate verify ok.
> GET /api/v1/data HTTP/2
> Host: api.example.com
> user-agent: curl/8.1.2
> accept: */*
>
< HTTP/2 200
< content-type: application/json; charset=utf-8
< date: Sat, 14 Jun 2026 02:00:00 GMT
< cache-control: max-age=3600
< x-request-id: abc123
< content-length: 1234
<
{"data": "the actual response body here"}
`;

// ---------------------------------------------------------------------------
// _is_curl_verbose_cmd
// ---------------------------------------------------------------------------

describe("TestIsCurlVerboseCmd", () => {
  it("test_short_verbose_flag", () => {
    expect(_is_curl_verbose_cmd(["curl", "-v", "https://example.com"])).toBe(true);
  });

  it("test_long_verbose_flag", () => {
    expect(_is_curl_verbose_cmd(["curl", "--verbose", "https://example.com"])).toBe(true);
  });

  it("test_combined_flags_vL", () => {
    expect(_is_curl_verbose_cmd(["curl", "-vL", "https://example.com"])).toBe(true);
  });

  it("test_combined_flags_separate_minus_v", () => {
    expect(_is_curl_verbose_cmd(["curl", "-L", "-v", "https://example.com"])).toBe(true);
  });

  it("test_combined_flags_svL", () => {
    // -s (silent progress) + -v (verbose) + -L (follow redirect)
    expect(_is_curl_verbose_cmd(["curl", "-svL", "https://example.com"])).toBe(true);
  });

  it("test_no_verbose_flag", () => {
    expect(_is_curl_verbose_cmd(["curl", "https://example.com"])).toBe(false);
  });

  it("test_silent_flag_only", () => {
    expect(_is_curl_verbose_cmd(["curl", "-s", "https://example.com"])).toBe(false);
  });

  it("test_not_curl", () => {
    expect(_is_curl_verbose_cmd(["wget", "-v", "https://example.com"])).toBe(false);
  });

  it("test_empty_argv", () => {
    expect(_is_curl_verbose_cmd([])).toBe(false);
  });

  it("test_curl_with_output_flag", () => {
    expect(_is_curl_verbose_cmd(["curl", "-v", "-o", "out.json", "https://example.com"])).toBe(true);
  });

  it("test_curl_location_verbose_order", () => {
    // --verbose before URL
    expect(_is_curl_verbose_cmd(["curl", "--verbose", "--location", "https://example.com"])).toBe(true);
  });

  it("test_wget_not_curl", () => {
    expect(_is_curl_verbose_cmd(["wget", "--verbose", "url"])).toBe(false);
  });

  it("test_curl_exe_extension", () => {
    expect(_is_curl_verbose_cmd(["curl.exe", "-v", "https://example.com"])).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// _has_curl_verbose_output
// ---------------------------------------------------------------------------

describe("TestHasCurlVerboseOutput", () => {
  it("test_full_verbose_output", () => {
    expect(_has_curl_verbose_output(FULL_CURL_VERBOSE)).toBe(true);
  });

  it("test_star_lines_only", () => {
    const output = "* Trying 1.2.3.4...\n* Connected\n* SSL ok\n";
    expect(_has_curl_verbose_output(output)).toBe(true);
  });

  it("test_req_and_resp_lines", () => {
    const output = "> GET /foo HTTP/2\n> Host: example.com\n< HTTP/2 200\n< content-type: text/plain\n";
    expect(_has_curl_verbose_output(output)).toBe(true);
  });

  it("test_plain_text_no_markers", () => {
    const output = "Hello world\nThis is plain text\nNo curl markers here\n";
    expect(_has_curl_verbose_output(output)).toBe(false);
  });

  it("test_json_body_only", () => {
    const output = '{"key": "value"}\n';
    expect(_has_curl_verbose_output(output)).toBe(false);
  });

  it("test_empty_string", () => {
    expect(_has_curl_verbose_output("")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// compress_curl_verbose
// ---------------------------------------------------------------------------

describe("TestCompressCurlVerbose", () => {
  function _run(text: string): [string, number] {
    return compress_curl_verbose(text);
  }

  it("test_star_lines_removed", () => {
    const [compressed, removed] = _run(FULL_CURL_VERBOSE);
    expect(removed).toBeGreaterThan(0);
    expect(compressed.split("\n").some((line) => line.startsWith("* "))).toBe(false);
  });

  it("test_request_line_kept", () => {
    const [compressed] = _run(FULL_CURL_VERBOSE);
    expect(compressed).toContain("> GET /api/v1/data HTTP/2");
  });

  it("test_request_headers_removed", () => {
    const [compressed] = _run(FULL_CURL_VERBOSE);
    const lines = compressed.split("\n");
    // Host, user-agent, accept headers should be stripped
    expect(lines.some((ln) => ln.includes("> Host:"))).toBe(false);
    expect(lines.some((ln) => ln.includes("> user-agent:"))).toBe(false);
    expect(lines.some((ln) => ln.includes("> accept:"))).toBe(false);
  });

  it("test_status_line_kept", () => {
    const [compressed] = _run(FULL_CURL_VERBOSE);
    expect(compressed).toContain("< HTTP/2 200");
  });

  it("test_content_type_kept", () => {
    const [compressed] = _run(FULL_CURL_VERBOSE);
    expect(compressed).toContain("< content-type: application/json; charset=utf-8");
  });

  it("test_redundant_response_headers_removed", () => {
    const [compressed] = _run(FULL_CURL_VERBOSE);
    const lines = compressed.split("\n");
    expect(lines.some((ln) => ln.includes("< date:"))).toBe(false);
    expect(lines.some((ln) => ln.includes("< cache-control:"))).toBe(false);
    expect(lines.some((ln) => ln.includes("< x-request-id:"))).toBe(false);
    expect(lines.some((ln) => ln.includes("< content-length:"))).toBe(false);
  });

  it("test_body_kept_verbatim", () => {
    const [compressed] = _run(FULL_CURL_VERBOSE);
    expect(compressed).toContain('{"data": "the actual response body here"}');
  });

  it("test_lines_removed_count_correct", () => {
    const [compressed, removed] = _run(FULL_CURL_VERBOSE);
    const original_count = FULL_CURL_VERBOSE.replace(/\n$/, "").split("\n").length;
    const compressed_count = compressed === "" ? 0 : compressed.replace(/\n$/, "").split("\n").length;
    expect(removed).toBe(original_count - compressed_count);
  });

  it("test_lines_removed_positive", () => {
    const [, removed] = _run(FULL_CURL_VERBOSE);
    expect(removed).toBeGreaterThan(0);
  });

  it("test_progress_meter_removed", () => {
    const output =
      "  % Total    % Received % Xferd  Average Speed   Time    Time     Time  Current\n" +
      "                                 Dload  Upload   Total   Spent    Left  Speed\n" +
      "100  1234  100  1234    0     0  56789      0 --:--:-- --:--:-- --:--:-- 56789\n" +
      '{"result": "ok"}\n';
    const [compressed, removed] = _run(output);
    expect(removed).toBe(3);
    expect(compressed).not.toContain("% Total");
    expect(compressed).not.toContain("Dload  Upload");
    expect(compressed).not.toContain("56789");
    expect(compressed).toContain('{"result": "ok"}');
  });

  it("test_http1_status_kept", () => {
    const output =
      "* Connected to example.com\n" +
      "> GET /foo HTTP/1.1\n" +
      "> Host: example.com\n" +
      "< HTTP/1.1 200 OK\n" +
      "< content-type: text/html\n" +
      "< server: nginx\n" +
      "<\n" +
      "<html>body</html>\n";
    const [compressed] = _run(output);
    expect(compressed).toContain("< HTTP/1.1 200 OK");
    expect(compressed).toContain("< content-type: text/html");
    expect(compressed).not.toContain("< server: nginx");
  });

  it("test_post_request_line_kept", () => {
    const output =
      "* Trying 1.2.3.4...\n" +
      "> POST /submit HTTP/2\n" +
      "> Host: api.example.com\n" +
      "> content-type: application/json\n" +
      "<\n" +
      "< HTTP/2 201\n" +
      "< location: /resource/42\n" +
      "<\n" +
      '{"id": 42}\n';
    const [compressed] = _run(output);
    expect(compressed).toContain("> POST /submit HTTP/2");
    expect(compressed).toContain("< HTTP/2 201");
    expect(compressed).toContain('{"id": 42}');
  });

  it("test_plain_output_no_change", () => {
    const plain = "Hello world\nThis is text\n";
    const [compressed, removed] = _run(plain);
    expect(removed).toBe(0);
    expect(compressed).toBe(plain);
  });

  it("test_empty_input", () => {
    const [compressed, removed] = _run("");
    expect(compressed).toBe("");
    expect(removed).toBe(0);
  });

  it("test_tls_handshake_lines_all_removed", () => {
    const output = FULL_CURL_VERBOSE;
    const [compressed] = _run(output);
    for (const tls_phrase of ["TLSv1.3", "TLS handshake", "Server certificate", "SSL connection"]) {
      expect(compressed).not.toContain(tls_phrase);
    }
  });

  it("test_status_404_kept", () => {
    const output =
      "* Trying 1.2.3.4...\n" +
      "> GET /missing HTTP/2\n" +
      "> Host: example.com\n" +
      ">  \n" +
      "< HTTP/2 404\n" +
      "< content-type: application/json\n" +
      "< x-error: not-found\n" +
      "<\n" +
      '{"error": "not found"}\n';
    const [compressed] = _run(output);
    expect(compressed).toContain("< HTTP/2 404");
    expect(compressed).toContain("< content-type: application/json");
    expect(compressed).not.toContain("< x-error: not-found");
  });
});

// ---------------------------------------------------------------------------
// post_bash integration (via hook payload)
// ---------------------------------------------------------------------------

function _make_payload(command: string, stdout: string, exit_code = 0): HookPayload {
  return {
    // No session_id: post_bash skips session ops and the curl block fires
    // regardless (the Python file mocks get_session_context -> ("", "/tmp")).
    cwd: "/tmp",
    tool_input: { command },
    tool_response: {
      output: stdout,
      stderr: "",
      exit_code,
    },
  } as unknown as HookPayload;
}

describe("TestPostBashCurlIntegration", () => {
  function _call_post_bash(command: string, stdout: string, exit_code = 0): Record<string, unknown> {
    const payload = _make_payload(command, stdout, exit_code);
    return hooks_read.post_bash(payload) as Record<string, unknown>;
  }

  it("test_curl_verbose_triggers_compression", () => {
    const result = _call_post_bash("curl -v https://example.com", FULL_CURL_VERBOSE);
    expect(result["continue"]).toBe(true);
    const msg = (result["systemMessage"] as string) ?? "";
    expect(msg).toContain("verbose lines stripped");
  });

  it("test_non_verbose_curl_not_triggered", () => {
    const plain_output = '{"data": "hello"}';
    const result = _call_post_bash("curl https://example.com", plain_output);
    const msg = (result["systemMessage"] as string) ?? "";
    expect(msg).not.toContain("verbose lines stripped");
  });

  it("test_wget_not_triggered", () => {
    const result = _call_post_bash("wget -v https://example.com", FULL_CURL_VERBOSE);
    const msg = (result["systemMessage"] as string) ?? "";
    expect(msg).not.toContain("verbose lines stripped");
  });

  it("test_curl_failure_passes_through", () => {
    // exit_code=1 means curl error; should NOT compress
    const result = _call_post_bash("curl -v https://example.com", FULL_CURL_VERBOSE, 1);
    const msg = (result["systemMessage"] as string) ?? "";
    expect(msg).not.toContain("verbose lines stripped");
  });

  it("test_compressed_message_contains_status", () => {
    const result = _call_post_bash("curl -v https://example.com", FULL_CURL_VERBOSE);
    const msg = (result["systemMessage"] as string) ?? "";
    expect(msg).toContain("200");
  });

  it("test_compressed_output_contains_request_line", () => {
    const result = _call_post_bash("curl -v https://example.com", FULL_CURL_VERBOSE);
    const msg = (result["systemMessage"] as string) ?? "";
    expect(msg).toContain("> GET /api/v1/data HTTP/2");
  });

  it("test_compressed_output_contains_body", () => {
    const result = _call_post_bash("curl -v https://example.com", FULL_CURL_VERBOSE);
    const msg = (result["systemMessage"] as string) ?? "";
    expect(msg).toContain('{"data": "the actual response body here"}');
  });
});

describe("TestRedirectChain", () => {
  // Regression tests for curl -vL redirect chains (Bug: in_body never reset).

  const REDIRECT_OUTPUT =
    "* Connected to example.com port 443 (#0)\n" +
    "> GET /old HTTP/2\n" +
    "> Host: example.com\n" +
    ">\n" +
    "< HTTP/2 301\n" +
    "< location: https://example.com/new\n" +
    "< content-length: 0\n" +
    "<\n" +
    "* Issue another request to this URL: https://example.com/new\n" +
    "* Connected to example.com port 443 (#1)\n" +
    "> GET /new HTTP/2\n" +
    "> Host: example.com\n" +
    ">\n" +
    "< HTTP/2 200\n" +
    "< content-type: application/json\n" +
    "< content-length: 18\n" +
    "<\n" +
    '{"status": "ok"}\n';

  function _run(stdout: string): [string, number] {
    return compress_curl_verbose(stdout);
  }

  it("test_tls_noise_in_second_connection_suppressed", () => {
    // * lines from the second connection must not appear in compressed output.
    const [compressed] = _run(REDIRECT_OUTPUT);
    expect(compressed).not.toContain("* Connected to example.com port 443 (#1)");
  });

  it("test_issue_another_request_suppressed", () => {
    // The redirect `* Issue another request` line must be suppressed.
    const [compressed] = _run(REDIRECT_OUTPUT);
    expect(compressed).not.toContain("* Issue another request");
  });

  it("test_final_status_200_kept", () => {
    // The final HTTP 200 status must appear in compressed output.
    const [compressed] = _run(REDIRECT_OUTPUT);
    expect(compressed).toContain("< HTTP/2 200");
  });

  it("test_final_body_kept", () => {
    // The response body after the final redirect must be present.
    const [compressed] = _run(REDIRECT_OUTPUT);
    expect(compressed).toContain('{"status": "ok"}');
  });

  it("test_lines_removed_positive", () => {
    // At least some lines must have been removed from the redirect output.
    const [, removed] = _run(REDIRECT_OUTPUT);
    expect(removed).toBeGreaterThan(0);
  });
});
