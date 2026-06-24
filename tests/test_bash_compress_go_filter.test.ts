/**
 * Tests for GoTestFilter — compress go test output.
 *
 * 1:1 port of tests/test_bash_compress_go_filter.py. Every Python `def test_*`
 * maps to a vitest `it()` with the SAME name and assertion polarity; the Python
 * test classes map to `describe()` blocks of the same name.
 *
 * Test-seam mapping (Python -> TS):
 *  - `import token_goat.bash_compress as bc`
 *      -> import the barrel "../src/token_goat/bash_compress.js" as `bc`
 *        (re-exports the framework + the ported filter classes + select_filter +
 *        the FILTERS registry).
 *  - module-level `_PAD_COUNT = 25` -> a module-level const (kept for parity even
 *    though the padding loop, like Python's, is driven by the running blank-line
 *    count rather than this constant directly).
 *  - `_run(lines)` -> a local helper that builds a GoTestFilter, pads with
 *    `ok  github.com/pad/pkgN  0.00Ns` lines until more than 20 non-blank lines
 *    exist (defeating any ≤20-line passthrough), then calls compress().
 *  - `_run_exact(lines, *, stdout, stderr, argv)` -> a local helper that joins the
 *    lines and calls compress() with no padding (or overriding stdout/stderr/argv).
 *
 * Byte-exactness: GoTestFilter operates on whole lines; the assertions here are
 * substring / startsWith / splitlines checks matching the Python `in` / `not in`
 * / `.startswith` / `.splitlines()` checks. Python `str.splitlines()` splits on
 * "\n" for these single-"\n" inputs; the TS port uses `.split("\n")` which is the
 * faithful equivalent for the data under test (no embedded CR / U+2028 etc.).
 *
 * No deferral: GoTestFilter, GoFilter and the FILTERS registry are all ported and
 * exported by the barrel, so every test ports live.
 */
import { describe, expect, it } from "vitest";

import * as bc from "../src/token_goat/bash_compress.js";

// Minimum lines to defeat the ≤20-line passthrough threshold.
const _PAD_COUNT = 25;
void _PAD_COUNT; // retained for parity with the Python module-level constant.

/** Call GoTestFilter.compress directly with stdout only. */
function _run(lines: string[]): string {
  const f = new bc.GoTestFilter();
  const padded = [...lines];
  let i = 0;
  while (padded.filter((ln) => ln.trim()).length <= 20) {
    padded.push(`ok  github.com/pad/pkg${i}  0.00${i}s`);
    i += 1;
  }
  return f.compress(padded.join("\n"), "", 0, ["go", "test", "./..."]);
}

/** Call GoTestFilter.compress with exact lines — no padding. */
function _run_exact(
  lines: string[],
  opts?: { stdout?: string; stderr?: string; argv?: string[] },
): string {
  const f = new bc.GoTestFilter();
  const text = lines.join("\n");
  const stdout = opts?.stdout ?? "";
  const stderr = opts?.stderr ?? "";
  const argv = opts?.argv ?? ["go", "test", "./..."];
  return f.compress(stdout || text, stderr, 0, argv);
}

describe("TestGoTestFilterSuppression", () => {
  // === RUN and --- PASS lines are dropped; counts reported in notes.

  it("test_run_lines_suppressed", () => {
    const out = _run(["=== RUN   TestFoo", "--- PASS: TestFoo (0.01s)"]);
    // The note mentions "RUN/PAUSE/CONT" so check no line starts with === RUN
    expect(out.split("\n").some((ln) => ln.startsWith("=== RUN"))).toBe(false);
  });

  it("test_pause_lines_suppressed", () => {
    const out = _run(["=== PAUSE TestFoo", "--- PASS: TestFoo (0.01s)"]);
    expect(out.split("\n").some((ln) => ln.startsWith("=== PAUSE"))).toBe(false);
  });

  it("test_cont_lines_suppressed", () => {
    const out = _run(["=== CONT  TestFoo", "--- PASS: TestFoo (0.01s)"]);
    expect(out.split("\n").some((ln) => ln.startsWith("=== CONT"))).toBe(false);
  });

  it("test_pass_lines_suppressed", () => {
    const out = _run(["--- PASS: TestFoo (0.01s)", "--- PASS: TestBar (0.02s)"]);
    expect(out).not.toContain("--- PASS:");
  });

  it("test_pass_count_in_notes", () => {
    const out = _run(["--- PASS: TestFoo (0.01s)", "--- PASS: TestBar (0.02s)"]);
    expect(out).toContain("2");
    expect(
      out.toLowerCase().includes("pass") || out.includes("collapsed"),
    ).toBe(true);
  });
});

describe("TestGoTestFilterKeeps", () => {
  // Lines that must always survive compression.

  it("test_fail_line_kept", () => {
    const out = _run(["--- FAIL: TestBad (0.05s)"]);
    expect(out).toContain("--- FAIL: TestBad");
  });

  it("test_ok_summary_kept", () => {
    const lines = [
      ...Array<string>(5).fill("=== RUN   TestFoo"),
      ...Array<string>(5).fill("--- PASS: TestFoo (0.01s)"),
    ];
    lines.push("ok  github.com/foo/bar  0.123s");
    const out = _run(lines);
    expect(out).toContain("ok  github.com/foo/bar  0.123s");
  });

  it("test_fail_pkg_line_kept", () => {
    const out = _run(["--- FAIL: TestBad (0.05s)", "FAIL\tgithub.com/foo/bar\t0.456s"]);
    expect(out).toContain("FAIL\tgithub.com/foo/bar");
  });

  it("test_panic_line_kept", () => {
    const out = _run(["panic: runtime error: index out of range"]);
    expect(out).toContain("panic: runtime error");
  });

  it("test_goroutine_line_kept", () => {
    // goroutine lines belong to panic/race stack traces
    const out = _run(["panic: nil pointer", "goroutine 1 [running]:"]);
    expect(out).toContain("goroutine 1 [running]:");
  });
});

describe("TestGoTestFilterPassthrough", () => {
  // Edge-case passthrough conditions.

  it("test_empty_output_passthrough", () => {
    const out = _run_exact([]);
    expect(out).toBe("");
  });

  it("test_short_output_still_compressed", () => {
    // GoTestFilter compresses even short output (no passthrough threshold)
    const lines = ["=== RUN   TestFoo", "--- PASS: TestFoo (0.01s)", "ok  pkg  0.001s"];
    const out = _run_exact(lines);
    expect(out.split("\n").some((ln) => ln.startsWith("=== RUN"))).toBe(false);
    expect(out).not.toContain("--- PASS:");
  });

  it("test_json_flag_passthrough", () => {
    const raw = '{"Action":"run","Test":"TestFoo"}\n{"Action":"pass","Test":"TestFoo"}';
    const f = new bc.GoTestFilter();
    const out = f.compress(raw, "", 0, ["go", "test", "-json", "./..."]);
    expect(out).toBe(raw);
  });

  it("test_non_test_subcommand_routes_to_go_filter", () => {
    const f = bc.select_filter(["go", "build", "./..."]);
    expect(f).not.toBeNull();
    expect(f!.name).toBe("go");
  });
});

describe("TestGoTestFilterDispatch", () => {
  // Routing: go test → GoTestFilter; other go subcommands → GoFilter.

  it("test_go_test_routes_to_go_test", () => {
    const f = bc.select_filter(["go", "test", "./..."]);
    expect(f).not.toBeNull();
    expect(f!.name).toBe("go-test");
  });

  it("test_go_test_v_routes_to_go_test", () => {
    const f = bc.select_filter(["go", "test", "-v", "./..."]);
    expect(f).not.toBeNull();
    expect(f!.name).toBe("go-test");
  });

  it("test_go_run_does_not_route_to_go_test", () => {
    const f = bc.select_filter(["go", "run", "main.go"]);
    expect(f).not.toBeNull();
    expect(f!.name).not.toBe("go-test");
  });

  it("test_go_test_before_go_filter_in_registry", () => {
    const names = bc.FILTERS.map((f) => f.name);
    expect(names.indexOf("go-test")).toBeLessThan(names.indexOf("go"));
  });
});

describe("TestGoTestFilterRaceDetector", () => {
  // Race detector block handling and goroutine frame collapsing.

  it("test_race_block_preserved", () => {
    // Race blocks with WARNING: DATA RACE and ==================== are kept verbatim.
    const lines = [
      "==================",
      "WARNING: DATA RACE",
      "Write at 0x00c000045280 by goroutine 9:",
      "    runtime.acquirem()",
      "        /usr/local/go/src/runtime/proc.go:123 +0x4c",
      "==================",
    ];
    const out = _run(lines);
    // All race block lines should be present
    expect(out).toContain("==================");
    expect(out).toContain("WARNING: DATA RACE");
    expect(out).toContain("Write at 0x00c000045280");
    expect(out).toContain("/usr/local/go/src/runtime/proc.go");
  });

  it("test_goroutine_frames_collapsed", () => {
    // Race blocks with >5 goroutine frames collapse frames to first 5 + omit note.
    const lines = [
      "==================",
      "WARNING: DATA RACE",
      "Goroutine 9 (running):",
      "    frame1()",
      "    frame2()",
      "    frame3()",
      "    frame4()",
      "    frame5()",
      "    frame6()",
      "    frame7()",
      "    frame8()",
      "Previous read at 0x00c000045280:",
      "    prev_frame()",
      "==================",
    ];
    const out = _run(lines);
    // First 5 frames under Goroutine 9 should be present
    expect(out).toContain("frame1()");
    expect(out).toContain("frame5()");
    // Frames 6 and 7 should be dropped
    expect(out).not.toContain("frame6()");
    expect(out).not.toContain("frame7()");
    // Omit marker should be present for collapsed frames
    expect(out).toContain("[token-goat: +3 goroutine frames omitted]");
  });

  it("test_failing_subtest_preserved", () => {
    // Failing subtests like '--- FAIL: TestParent/SubTest' are kept.
    const lines = [
      "=== RUN   TestParent/SubTest",
      "--- FAIL: TestParent/SubTest (0.05s)",
      "    subtest_error_message.go:42: assertion failed",
    ];
    const out = _run(lines);
    // The FAIL line must be kept
    expect(out).toContain("--- FAIL: TestParent/SubTest");
    // The error message should also be kept (indented continuation)
    expect(out).toContain("assertion failed");
  });

  it("test_skip_count_in_notes", () => {
    // --- SKIP: lines are suppressed and count appears in notes.
    const lines = [
      "=== RUN   TestSkip1",
      "--- SKIP: TestSkip1 (0.00s) (reason: not applicable)",
      "=== RUN   TestSkip2",
      "--- SKIP: TestSkip2 (0.00s) (reason: not applicable)",
      "=== RUN   TestPass",
      "--- PASS: TestPass (0.01s)",
    ];
    const out = _run(lines);
    // SKIP lines should not appear in output
    expect(out).not.toContain("--- SKIP:");
    // But the count should be in notes
    expect(out).toContain("2");
    expect(out.toLowerCase()).toContain("skip");
  });
});
