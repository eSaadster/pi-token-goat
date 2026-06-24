/**
 * Tests for JUnit XML detection and summarisation in post_bash.
 *
 * 1:1 port of tests/test_junit_xml_compress.py. `_is_junit_xml_output` lives in
 * the bash_compress barrel; `_summarize_junit_xml` is exported from hooks_read.
 * The post_bash JUnit block looks up `_is_junit_xml_output` via _bcFn() and
 * calls `self._summarize_junit_xml`, so the integration tests run live.
 *
 * Test-seam mapping (Python -> TS):
 *  - `_post_bash(cmd, stdout, exit_code=0)` -> hooks_read.post_bash with a
 *    sessionless payload (no session_id), so the JUnit block fires without
 *    session machinery (mirrors the Python sessionless payload).
 *  - `len(xml)` (Python char count, ASCII -> == byte count) -> xml.length.
 *  - .splitlines() -> local splitlines() with Python trailing-newline semantics.
 */
import { describe, expect, it } from "vitest";

import * as bc from "../src/token_goat/bash_compress.js";
import { _summarize_junit_xml, post_bash } from "../src/token_goat/hooks_read.js";
import type { HookPayload } from "../src/token_goat/types.js";

function splitlines(s: string): string[] {
  if (s === "") {
    return [];
  }
  const parts = s.split("\n");
  if (parts.length > 0 && parts[parts.length - 1] === "") {
    parts.pop();
  }
  return parts;
}

function _post_bash(cmd: string, stdout: string, exit_code = 0): Record<string, unknown> {
  return post_bash({
    hook_event_name: "PostToolUse",
    tool_name: "Bash",
    tool_input: { command: cmd },
    tool_response: { stdout, stderr: "", exit_code },
  } as unknown as HookPayload) as Record<string, unknown>;
}

interface MakeJunitOpts {
  tests?: number;
  failures?: number;
  errors?: number;
  skipped?: number;
  failure_cases?: Array<[string, string, string]> | null;
  wrapper?: boolean;
}

function _make_junit(opts: MakeJunitOpts = {}): string {
  let tests = opts.tests ?? 5;
  let failures = opts.failures ?? 0;
  const errors = opts.errors ?? 0;
  const skipped = opts.skipped ?? 0;
  const failure_cases = opts.failure_cases ?? null;
  const wrapper = opts.wrapper ?? false;

  let cases: string[] = [];
  for (let i = 0; i < tests; i++) {
    const classname = `com.example.Test${i}`;
    const name = `test_method_${i}`;
    cases.push(`  <testcase classname="${classname}" name="${name}" time="0.1"/>`);
  }

  // Overwrite cases with failures (each testcase on multiple lines so line count stays high).
  if (failure_cases) {
    cases = [];
    for (const [cls, nm, msg] of failure_cases) {
      cases.push(
        `  <testcase classname="${cls}" name="${nm}">\n` +
          `    <failure message="${msg}">\n` +
          `      stack trace here\n` +
          `    </failure>\n` +
          `  </testcase>`,
      );
    }
    tests = failure_cases.length;
    failures = tests;
  }

  const suite =
    `<testsuite name="Suite" tests="${tests}" failures="${failures}"` +
    ` errors="${errors}" skipped="${skipped}">\n` +
    cases.join("\n") +
    "\n</testsuite>";
  const body = wrapper ? `<testsuites>\n${suite}\n</testsuites>` : suite;
  return `<?xml version="1.0" encoding="UTF-8"?>\n${body}`;
}

// ---------------------------------------------------------------------------
// _is_junit_xml_output
// ---------------------------------------------------------------------------

describe("TestIsJunitXmlOutput", () => {
  it("test_valid_testsuite_root", () => {
    const xml = '<?xml version="1.0"?>\n<testsuite tests="3" failures="0"/>';
    expect(bc._is_junit_xml_output(xml)).toBe(true);
  });

  it("test_valid_testsuites_wrapper", () => {
    const xml = '<?xml version="1.0"?>\n<testsuites><testsuite tests="1"/></testsuites>';
    expect(bc._is_junit_xml_output(xml)).toBe(true);
  });

  it("test_empty_string", () => {
    expect(bc._is_junit_xml_output("")).toBe(false);
  });

  it("test_plain_text_output", () => {
    expect(bc._is_junit_xml_output("PASSED 10 tests in 0.3s\nAll good!\n")).toBe(false);
  });

  it("test_partial_xml_no_testsuite", () => {
    // Has <?xml but no <testsuite
    expect(bc._is_junit_xml_output('<?xml version="1.0"?>\n<root><item/></root>')).toBe(false);
  });

  it("test_markers_beyond_first_2000_chars", () => {
    // <?xml in first 2000, but <testsuite only after 2000
    const padding = "x".repeat(2001);
    const xml = `<?xml version="1.0"?>\n${padding}<testsuite tests="1"/>`;
    // <testsuite is NOT in first 2000 chars, so should be False
    expect(bc._is_junit_xml_output(xml)).toBe(false);
  });

  it("test_html_with_xml_declaration", () => {
    // has <?xml but no <testsuite
    const html = '<?xml version="1.0"?>\n<!DOCTYPE html><html><body>hello</body></html>';
    expect(bc._is_junit_xml_output(html)).toBe(false);
  });

  it("test_testsuites_root_only_no_child", () => {
    // <testsuites present in head — True even without child <testsuite
    const xml = '<?xml version="1.0"?>\n<testsuites/>';
    expect(bc._is_junit_xml_output(xml)).toBe(true);
  });

  it("test_none_equivalent_false", () => {
    // Single-character string — definitely no markers
    expect(bc._is_junit_xml_output("x")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// _summarize_junit_xml
// ---------------------------------------------------------------------------

describe("TestSummarizeJunitXml", () => {
  it("test_all_passing_status_pass", () => {
    const xml = _make_junit({ tests: 5, failures: 0 });
    const result = _summarize_junit_xml(xml);
    expect(result).not.toBeNull();
    expect(result as string).toContain("PASS");
    expect(result as string).toContain("5 passed");
  });

  it("test_all_passing_no_failures_section", () => {
    const xml = _make_junit({ tests: 3, failures: 0 });
    const result = _summarize_junit_xml(xml);
    expect(result as string).not.toContain("Failures");
  });

  it("test_some_failures_status_fail", () => {
    const xml = _make_junit({
      failure_cases: [
        ["com.Foo", "test_a", "AssertionError: expected 1"],
        ["com.Bar", "test_b", "NPE"],
      ],
    });
    const result = _summarize_junit_xml(xml);
    expect(result as string).toContain("FAIL");
    expect(result as string).toContain("2 failed");
  });

  it("test_failure_names_in_output", () => {
    const xml = _make_junit({
      failure_cases: [["com.example.MyTest", "test_login", "wrong password"]],
    });
    const result = _summarize_junit_xml(xml);
    expect(result as string).toContain("com.example.MyTest.test_login");
  });

  it("test_errors_counted_separately", () => {
    const xml =
      '<?xml version="1.0"?>' +
      '<testsuite tests="3" failures="1" errors="1" skipped="0">' +
      '<testcase classname="A" name="t1"/>' +
      '<testcase classname="A" name="t2"><failure message="boom"/></testcase>' +
      '<testcase classname="A" name="t3"><error message="oops"/></testcase>' +
      "</testsuite>";
    const result = _summarize_junit_xml(xml);
    expect(result as string).toContain("1 failed");
    expect(result as string).toContain("1 errors");
  });

  it("test_skipped_counted", () => {
    const xml =
      '<?xml version="1.0"?>' +
      '<testsuite tests="4" failures="0" errors="0" skipped="2">' +
      '<testcase classname="S" name="t1"/>' +
      '<testcase classname="S" name="t2"/>' +
      "</testsuite>";
    const result = _summarize_junit_xml(xml);
    expect(result as string).toContain("2 skipped");
  });

  it("test_more_than_10_failures_capped", () => {
    const cases: Array<[string, string, string]> = [];
    for (let i = 0; i < 15; i++) {
      cases.push(["com.T", `test_${i}`, `msg${i}`]);
    }
    const xml = _make_junit({ failure_cases: cases });
    const result = _summarize_junit_xml(xml);
    // Only 10 shown, plus a "... X more" line
    expect(result as string).toContain("5 more failures");
  });

  it("test_classname_testname_dot_format", () => {
    const xml =
      '<?xml version="1.0"?>' +
      '<testsuite tests="1" failures="1">' +
      '<testcase classname="pkg.MyClass" name="my_test">' +
      '<failure message="wrong"/>' +
      "</testcase>" +
      "</testsuite>";
    const result = _summarize_junit_xml(xml);
    expect(result as string).toContain("pkg.MyClass.my_test");
  });

  it("test_parse_error_returns_none", () => {
    expect(_summarize_junit_xml("not xml at all")).toBeNull();
  });

  it("test_parse_error_truncated_xml_returns_none", () => {
    expect(_summarize_junit_xml('<?xml version="1.0"?><testsuite tests="1"')).toBeNull();
  });

  it("test_testsuites_wrapper_aggregates_totals", () => {
    const xml = `<?xml version="1.0"?>
<testsuites>
  <testsuite name="A" tests="3" failures="1" errors="0" skipped="0">
    <testcase classname="A" name="t1"/>
    <testcase classname="A" name="t2"/>
    <testcase classname="A" name="t3"><failure message="fail"/></testcase>
  </testsuite>
  <testsuite name="B" tests="2" failures="0" errors="0" skipped="1">
    <testcase classname="B" name="t4"/>
    <testcase classname="B" name="t5"/>
  </testsuite>
</testsuites>
`;
    const result = _summarize_junit_xml(xml);
    // total = 5, failures = 1, skipped = 1, passed = 3
    expect(result as string).toContain("5 total");
    expect(result as string).toContain("1 failed");
    expect(result as string).toContain("1 skipped");
    expect(result as string).toContain("3 passed");
  });

  it("test_empty_testsuite_zero_tests", () => {
    const xml = '<?xml version="1.0"?><testsuite tests="0" failures="0" errors="0" skipped="0"/>';
    const result = _summarize_junit_xml(xml);
    expect(result).not.toBeNull();
    expect(result as string).toContain("0 total");
    expect(result as string).toContain("PASS");
  });

  it("test_long_failure_message_truncated", () => {
    const long_msg = "A".repeat(300);
    const xml =
      '<?xml version="1.0"?>' +
      '<testsuite tests="1" failures="1">' +
      `<testcase classname="C" name="t"><failure message="${long_msg}"/></testcase>` +
      "</testsuite>";
    const result = _summarize_junit_xml(xml);
    // The message in the summary line must be <= 160 chars
    const lines = splitlines(result as string);
    const msg_line = lines.find((ln) => ln.startsWith("    ")) ?? "";
    expect(msg_line.trim().length).toBeLessThanOrEqual(160);
  });

  it("test_wrong_root_tag_returns_none", () => {
    const xml = '<?xml version="1.0"?><report><item/></report>';
    expect(_summarize_junit_xml(xml)).toBeNull();
  });

  it("test_empty_attribute_strings_dont_raise", () => {
    // int("") raises ValueError — _safe_int must handle it gracefully.
    const xml =
      '<?xml version="1.0"?>' +
      '<testsuite tests="" failures="" errors="" skipped="">' +
      '<testcase classname="A" name="t1"/>' +
      "</testsuite>";
    const result = _summarize_junit_xml(xml);
    expect(result).not.toBeNull();
    expect(result as string).toContain("0 total");
    expect(result as string).toContain("PASS");
  });

  it("test_nested_suites_no_double_count", () => {
    // Outer suite tests="5" contains two inner suites tests="2" and tests="3".
    // Total must be 5 (outer only), not 10.
    const xml = `<?xml version="1.0"?>
<testsuites>
  <testsuite name="Outer" tests="5" failures="0" errors="0" skipped="0">
    <testsuite name="Inner1" tests="2" failures="0" errors="0" skipped="0">
      <testcase classname="A" name="t1"/>
      <testcase classname="A" name="t2"/>
    </testsuite>
    <testsuite name="Inner2" tests="3" failures="0" errors="0" skipped="0">
      <testcase classname="B" name="t3"/>
      <testcase classname="B" name="t4"/>
      <testcase classname="B" name="t5"/>
    </testsuite>
  </testsuite>
</testsuites>
`;
    const result = _summarize_junit_xml(xml);
    expect(result).not.toBeNull();
    expect(result as string).toContain("5 total");
    expect(result as string).not.toContain("10 total");
  });

  it("test_failure_without_message_attr_uses_text", () => {
    const xml =
      '<?xml version="1.0"?>' +
      '<testsuite tests="1" failures="1">' +
      '<testcase classname="C" name="t">' +
      "<failure>text content fallback</failure>" +
      "</testcase>" +
      "</testsuite>";
    const result = _summarize_junit_xml(xml);
    expect(result as string).toContain("text content fallback");
  });

  it("test_classname_missing_no_leading_dot", () => {
    const xml =
      '<?xml version="1.0"?>' +
      '<testsuite tests="1" failures="1">' +
      '<testcase name="only_name">' +
      '<failure message="boom"/>' +
      "</testcase>" +
      "</testsuite>";
    const result = _summarize_junit_xml(xml);
    // Should show "only_name", not ".only_name"
    expect(result as string).toContain("only_name");
    for (const line of splitlines(result as string)) {
      if (line.includes("only_name")) {
        expect(line.trim().startsWith(".")).toBe(false);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// Integration: post_bash interception
// ---------------------------------------------------------------------------

describe("TestPostBashJunit", () => {
  function _junit_10lines(opts: MakeJunitOpts = {}): string {
    // Produce JUnit XML that is at least 10 lines long.
    const xml = _make_junit(opts);
    // Ensure >= 10 lines
    expect(splitlines(xml).length).toBeGreaterThanOrEqual(10);
    return xml;
  }

  it("test_failures_triggers_interception", () => {
    const xml = _junit_10lines({
      failure_cases: [
        ["com.Foo", "test_a", "AssertionError"],
        ["com.Bar", "test_b", "Timeout"],
        ["com.Baz", "test_c", "NPE"],
      ],
    });
    const result = _post_bash("pytest --junitxml=report.xml && cat report.xml", xml);
    const msg = (result["systemMessage"] as string) ?? "";
    expect(msg).toContain("[token-goat] JUnit XML [FAIL]");
  });

  it("test_all_pass_triggers_interception", () => {
    const xml = _junit_10lines({ tests: 8, failures: 0 });
    const result = _post_bash("cat report.xml", xml);
    const msg = (result["systemMessage"] as string) ?? "";
    expect(msg).toContain("[token-goat] JUnit XML [PASS]");
  });

  it("test_short_xml_no_interception", () => {
    // Build XML that is < 10 lines
    const xml = '<?xml version="1.0"?><testsuite tests="1" failures="0"><testcase name="t"/></testsuite>';
    expect(splitlines(xml).length).toBeLessThan(10);
    const result = _post_bash("cat report.xml", xml);
    // Should NOT be intercepted as JUnit — no systemMessage with JUnit marker
    const msg = (result["systemMessage"] as string) ?? "";
    expect(msg).not.toContain("[token-goat] JUnit XML");
  });

  it("test_non_xml_stdout_no_interception", () => {
    const plain = "PASSED 10 tests in 0.3s\n".repeat(20);
    const result = _post_bash("pytest -v", plain);
    const msg = (result["systemMessage"] as string) ?? "";
    expect(msg).not.toContain("[token-goat] JUnit XML");
  });

  it("test_single_line_xml_over_4096_bytes_intercepted", () => {
    // Compact single-line XML (pytest-junit compact / machine-generated) with > 4096 bytes
    // must be intercepted even though it has < 10 lines.
    let cases = "";
    for (let i = 0; i < 60; i++) {
      cases += `<testcase classname="com.example.Pkg${i}" name="test_method_${i}" time="0.01"/>`;
    }
    const xml = `<?xml version="1.0" encoding="UTF-8"?><testsuite name="S" tests="60" failures="0" errors="0" skipped="0">${cases}</testsuite>`;
    expect(splitlines(xml).length).toBeLessThan(10);
    expect(xml.length).toBeGreaterThanOrEqual(4096);
    const result = _post_bash("cat report.xml", xml);
    const msg = (result["systemMessage"] as string) ?? "";
    expect(msg).toContain("[token-goat] JUnit XML [PASS]");
  });
});
