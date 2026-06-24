/**
 * Tests for jest/vitest post-bash detection and compression helpers.
 *
 * 1:1 port of tests/test_jest_compress.py. The post_bash helpers
 * (_is_jest_cmd, _has_jest_output, _has_vitest_output, compress_jest_output)
 * now live in bash_compress/post_bash_helpers.ts and are re-exported from the
 * bash_compress barrel, and hooks_read.post_bash's jest block looks them up via
 * _bcFn() — so both the unit and the post_bash-integration tests run live.
 *
 * Test-seam mapping (Python -> TS):
 *  - `from token_goat import bash_compress as bc` -> import the barrel as `bc`.
 *  - `_post_bash(cmd, stdout, exit_code=0)` -> calls hooks_read.post_bash with a
 *    minimal sessionless payload (no session_id). With an empty/absent
 *    session_id the session machinery is skipped and the jest block fires
 *    regardless, so no internal-helper mocking is needed (the Python file uses
 *    its own minimal payload too, also without mocks).
 *  - textwrap.dedent("""\\ ... """) blocks -> plain template literals holding the
 *    exact same bytes (the leading-space-and-glyph layout is preserved verbatim).
 */
import { describe, expect, it } from "vitest";

import * as bc from "../src/token_goat/bash_compress.js";
import * as hooks_read from "../src/token_goat/hooks_read.js";
import type { HookPayload } from "../src/token_goat/types.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const JEST_PASS_ONLY = ` PASS src/components/Button.test.js
   Button
     ✓ renders without errors (3 ms)
     ✓ handles click events (5 ms)
 PASS src/utils/format.test.js
   format
     ✓ formats date correctly (2 ms)
Test Suites: 2 passed, 2 total
Tests:       3 passed, 3 total
Snapshots:   0 total
Time:        1.234 s
Ran all test suites.
`;

const JEST_MIXED = ` PASS src/components/Button.test.js
   Button
     ✓ renders without errors (3 ms)
 FAIL src/api/client.test.js
   ● ClientAPI › should handle errors

     expect(received).toBe(expected)

     Expected: "ok"
     Received: "error"

       5 | test('should handle errors', () => {
       6 |   expect(client.get()).toBe('ok');
         |                        ^
       7 | });

Test Suites: 1 failed, 1 passed, 2 total
Tests:       1 failed, 1 passed, 2 total
Snapshots:   0 total
Time:        2.534 s
Ran all test suites.
`;

const VITEST_OUTPUT = ` ✓ src/utils.test.ts (3 tests)
 ✓ src/api.test.ts (5 tests)
 × src/client.test.ts (1 test)
   → Client > handles errors

Test Files  1 failed | 2 passed (3)
Tests       1 failed | 8 passed (9)
Duration    1.23s
`;

const VITEST_PASS_ONLY = ` ✓ src/utils.test.ts (3 tests)
 ✓ src/api.test.ts (5 tests)
 ✓ src/helpers.test.ts (2 tests)

Test Files  3 passed (3)
Tests       10 passed (10)
Duration    0.89s
`;

function _post_bash(cmd: string, stdout: string, exit_code = 0): Record<string, unknown> {
  const payload = {
    hook_event_name: "PostToolUse",
    tool_name: "Bash",
    tool_input: { command: cmd },
    tool_response: { stdout, stderr: "", exit_code },
  } as unknown as HookPayload;
  return hooks_read.post_bash(payload) as Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// _is_jest_cmd
// ---------------------------------------------------------------------------

describe("TestIsJestCmd", () => {
  it("test_jest_binary", () => {
    expect(bc._is_jest_cmd(["jest"])).toBeTruthy();
  });

  it("test_jest_binary_with_args", () => {
    expect(bc._is_jest_cmd(["jest", "--coverage", "src/"])).toBeTruthy();
  });

  it("test_vitest_binary", () => {
    expect(bc._is_jest_cmd(["vitest"])).toBeTruthy();
  });

  it("test_react_scripts", () => {
    expect(bc._is_jest_cmd(["react-scripts"])).toBeTruthy();
  });

  it("test_npx_jest", () => {
    expect(bc._is_jest_cmd(["npx", "jest"])).toBeTruthy();
  });

  it("test_npx_vitest", () => {
    expect(bc._is_jest_cmd(["npx", "vitest"])).toBeTruthy();
  });

  it("test_yarn_test", () => {
    expect(bc._is_jest_cmd(["yarn", "test"])).toBeTruthy();
  });

  it("test_npm_test", () => {
    expect(bc._is_jest_cmd(["npm", "test"])).toBeTruthy();
  });

  it("test_pnpm_test", () => {
    expect(bc._is_jest_cmd(["pnpm", "test"])).toBeTruthy();
  });

  it("test_npm_run_build_false", () => {
    expect(bc._is_jest_cmd(["npm", "run", "build"])).toBeFalsy();
  });

  it("test_python_false", () => {
    expect(bc._is_jest_cmd(["python", "script.py"])).toBeFalsy();
  });

  it("test_empty_argv_false", () => {
    expect(bc._is_jest_cmd([])).toBeFalsy();
  });

  it("test_windows_exe_suffix", () => {
    expect(bc._is_jest_cmd(["jest.exe"])).toBeTruthy();
  });

  it("test_windows_cmd_suffix", () => {
    expect(bc._is_jest_cmd(["vitest.cmd"])).toBeTruthy();
  });

  it("test_cargo_false", () => {
    expect(bc._is_jest_cmd(["cargo", "test"])).toBeFalsy();
  });

  it("test_npx_yes_jest", () => {
    expect(bc._is_jest_cmd(["npx", "--yes", "jest"])).toBeTruthy();
  });

  it("test_npx_legacy_peer_deps_jest", () => {
    expect(bc._is_jest_cmd(["npx", "--legacy-peer-deps", "jest"])).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// _has_jest_output / _has_vitest_output
// ---------------------------------------------------------------------------

describe("TestHasJestOutput", () => {
  it("test_pass_line_detected", () => {
    expect(bc._has_jest_output(" PASS src/foo.test.js\nTest Suites: 1 passed\n")).toBeTruthy();
  });

  it("test_fail_line_detected", () => {
    expect(bc._has_jest_output(" FAIL src/foo.test.js\nTest Suites: 1 failed\n")).toBeTruthy();
  });

  it("test_mixed_detected", () => {
    expect(bc._has_jest_output(JEST_MIXED)).toBeTruthy();
  });

  it("test_plain_text_false", () => {
    expect(bc._has_jest_output("hello world\nno jest here\n")).toBeFalsy();
  });

  it("test_empty_false", () => {
    expect(bc._has_jest_output("")).toBeFalsy();
  });

  it("test_vitest_output_false", () => {
    // Vitest-only output has no PASS/FAIL headers
    expect(bc._has_jest_output(VITEST_OUTPUT)).toBeFalsy();
  });
});

describe("TestHasVitestOutput", () => {
  it("test_pass_line_detected", () => {
    expect(bc._has_vitest_output(" ✓ src/utils.test.ts (3 tests)\n")).toBeTruthy();
  });

  it("test_fail_line_detected", () => {
    expect(bc._has_vitest_output(" × src/client.test.ts (1 test)\n")).toBeTruthy();
  });

  it("test_mixed_vitest_detected", () => {
    expect(bc._has_vitest_output(VITEST_OUTPUT)).toBeTruthy();
  });

  it("test_plain_text_false", () => {
    expect(bc._has_vitest_output("hello world\nno vitest here\n")).toBeFalsy();
  });

  it("test_empty_false", () => {
    expect(bc._has_vitest_output("")).toBeFalsy();
  });
});

// ---------------------------------------------------------------------------
// compress_jest_output — Jest mode
// ---------------------------------------------------------------------------

describe("TestCompressJestOutput", () => {
  it("test_pass_only_all_pass_lines_removed", () => {
    const [compressed] = bc.compress_jest_output(JEST_PASS_ONLY);
    expect(compressed).not.toContain(" PASS src/components/Button.test.js");
    expect(compressed).not.toContain(" PASS src/utils/format.test.js");
  });

  it("test_pass_only_tick_lines_removed", () => {
    const [compressed] = bc.compress_jest_output(JEST_PASS_ONLY);
    expect(compressed).not.toContain("✓ renders without errors");
    expect(compressed).not.toContain("✓ handles click events");
  });

  it("test_pass_only_summary_kept", () => {
    const [compressed] = bc.compress_jest_output(JEST_PASS_ONLY);
    expect(compressed).toContain("Test Suites: 2 passed");
    expect(compressed).toContain("Tests:       3 passed");
    expect(compressed).toContain("Ran all test suites.");
  });

  it("test_pass_only_pass_count", () => {
    const [, pass_ct, fail_ct] = bc.compress_jest_output(JEST_PASS_ONLY);
    expect(pass_ct).toBe(2);
    expect(fail_ct).toBe(0);
  });

  it("test_mixed_pass_suppressed", () => {
    const [compressed] = bc.compress_jest_output(JEST_MIXED);
    expect(compressed).not.toContain(" PASS src/components/Button.test.js");
  });

  it("test_mixed_fail_kept", () => {
    const [compressed] = bc.compress_jest_output(JEST_MIXED);
    expect(compressed).toContain(" FAIL src/api/client.test.js");
  });

  it("test_mixed_failure_detail_kept", () => {
    const [compressed] = bc.compress_jest_output(JEST_MIXED);
    expect(compressed).toContain("expect(received).toBe(expected)");
    expect(compressed).toContain('Expected: "ok"');
  });

  it("test_mixed_counts", () => {
    const [, pass_ct, fail_ct] = bc.compress_jest_output(JEST_MIXED);
    expect(pass_ct).toBe(1);
    expect(fail_ct).toBe(1);
  });

  it("test_mixed_summary_kept", () => {
    const [compressed] = bc.compress_jest_output(JEST_MIXED);
    expect(compressed).toContain("Test Suites: 1 failed");
  });

  it("test_no_jest_output_passthrough", () => {
    const plain = "hello\nworld\nno jest\n";
    const [compressed, pass_ct, fail_ct] = bc.compress_jest_output(plain);
    expect(compressed).toBe(plain);
    expect(pass_ct).toBe(0);
    expect(fail_ct).toBe(0);
  });

  it("test_returns_string_not_bytes", () => {
    const [compressed] = bc.compress_jest_output(JEST_PASS_ONLY);
    expect(typeof compressed).toBe("string");
  });
});

// ---------------------------------------------------------------------------
// compress_jest_output — Vitest mode
// ---------------------------------------------------------------------------

describe("TestCompressVitestOutput", () => {
  it("test_pass_lines_suppressed", () => {
    const [compressed, pass_ct] = bc.compress_jest_output(VITEST_PASS_ONLY);
    expect(compressed).not.toContain(" ✓ src/utils.test.ts");
    expect(compressed).not.toContain(" ✓ src/api.test.ts");
    expect(pass_ct).toBe(3);
  });

  it("test_fail_line_kept", () => {
    const [compressed, , fail_ct] = bc.compress_jest_output(VITEST_OUTPUT);
    expect(compressed).toContain(" × src/client.test.ts");
    expect(fail_ct).toBe(1);
  });

  it("test_vitest_summary_kept", () => {
    const [compressed] = bc.compress_jest_output(VITEST_OUTPUT);
    expect(compressed).toContain("Test Files");
    expect(compressed).toContain("Tests");
  });

  it("test_vitest_pass_count", () => {
    const [, pass_ct, fail_ct] = bc.compress_jest_output(VITEST_OUTPUT);
    expect(pass_ct).toBe(2);
    expect(fail_ct).toBe(1);
  });

  it("test_vitest_pass_only_counts", () => {
    const [, pass_ct, fail_ct] = bc.compress_jest_output(VITEST_PASS_ONLY);
    expect(pass_ct).toBe(3);
    expect(fail_ct).toBe(0);
  });

  it("test_vitest_per_test_tick_lines_suppressed", () => {
    // Per-test ✓ lines under a passing vitest file block must be suppressed.
    const verbose = ` ✓ src/utils.test.ts (3 tests)
   ✓ formatDate 2ms
   ✓ parseDate 1ms
   ✓ isValid 1ms
 × src/client.test.ts (1 test)
   × Client > handles errors 5ms

Test Files  1 failed | 1 passed (2)
`;
    const [compressed, pass_ct, fail_ct] = bc.compress_jest_output(verbose);
    expect(compressed).not.toContain("✓ formatDate");
    expect(compressed).not.toContain("✓ parseDate");
    expect(compressed).not.toContain("✓ isValid");
    expect(compressed).toContain("× Client > handles errors");
    expect(pass_ct).toBe(1);
    expect(fail_ct).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// post_bash integration
// ---------------------------------------------------------------------------

describe("TestPostBashJestIntegration", () => {
  it("test_jest_pass_only_compressed", () => {
    const result = _post_bash("jest", JEST_PASS_ONLY);
    const msg = (result["systemMessage"] as string) ?? "";
    expect(msg).toContain("PASS suite(s) suppressed");
  });

  it("test_npx_jest_compressed", () => {
    const result = _post_bash("npx jest --coverage", JEST_PASS_ONLY);
    const msg = (result["systemMessage"] as string) ?? "";
    expect(msg).toContain("PASS suite(s) suppressed");
  });

  it("test_npm_test_compressed", () => {
    const result = _post_bash("npm test", JEST_PASS_ONLY);
    const msg = (result["systemMessage"] as string) ?? "";
    expect(msg).toContain("PASS suite(s) suppressed");
  });

  it("test_non_jest_cmd_not_triggered", () => {
    const result = _post_bash("cargo build", JEST_PASS_ONLY);
    const msg = (result["systemMessage"] as string) ?? "";
    expect(msg).not.toContain("PASS suite(s) suppressed");
  });

  it("test_exit_code_1_fail_block_compressed", () => {
    // exit_code=1 is normal for test failures; should still compress
    const result = _post_bash("jest", JEST_MIXED, 1);
    const msg = (result["systemMessage"] as string) ?? "";
    expect(msg).toContain("PASS suite(s) suppressed");
    expect(msg).toContain("FAIL");
  });

  it("test_exit_code_2_not_triggered", () => {
    // exit_code=2 means jest itself crashed; pass through unchanged
    const result = _post_bash("jest", JEST_PASS_ONLY, 2);
    const msg = (result["systemMessage"] as string) ?? "";
    expect(msg).not.toContain("PASS suite(s) suppressed");
  });

  it("test_fewer_than_5_lines_not_triggered", () => {
    const short = " PASS a.test.js\nTest Suites: 1 passed\n";
    const result = _post_bash("jest", short);
    const msg = (result["systemMessage"] as string) ?? "";
    expect(msg).not.toContain("PASS suite(s) suppressed");
  });

  it("test_all_fail_no_pass_not_triggered", () => {
    // no PASS lines -> pass_count=0 -> no systemMessage replacement
    const fail_only = ` FAIL src/a.test.js
   ● A › fails

     error here

Test Suites: 1 failed, 1 total
Tests:       1 failed, 1 total
Time:        1.0 s
`;
    const result = _post_bash("jest", fail_only);
    const msg = (result["systemMessage"] as string) ?? "";
    expect(msg).not.toContain("PASS suite(s) suppressed");
  });

  it("test_vitest_compressed", () => {
    const result = _post_bash("vitest", VITEST_OUTPUT);
    const msg = (result["systemMessage"] as string) ?? "";
    expect(msg).toContain("PASS suite(s) suppressed");
  });

  it("test_all_pass_no_summary_no_replacement", () => {
    // All-PASS output with no summary must not produce a systemMessage.
    //
    // Regression: compress_jest_output returns ("", N, 0) when every line
    // is a PASS header; the empty string must not be substituted as output.
    const truncated = ` PASS src/a.test.js
 PASS src/b.test.js
 PASS src/c.test.js
 PASS src/d.test.js
 PASS src/e.test.js
`;
    const result = _post_bash("jest", truncated);
    const msg = (result["systemMessage"] as string) ?? "";
    // Must not replace — compressed output would be blank
    expect(msg).not.toContain("PASS suite(s) suppressed");
  });
});
