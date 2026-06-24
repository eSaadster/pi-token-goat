/**
 * Tests for SeverityLogFilter (severity-scored log stream compression).
 *
 * 1:1 port of tests/test_bash_compress_severity_log.py. Every Python
 * `def test_*` maps to a vitest `it()` with the SAME name and assertion
 * polarity; the four Python groupings (detect() tests, compress() suppression
 * tests) become `describe()` blocks.
 *
 * Test-seam mapping (Python -> TS):
 *  - `from token_goat.bash_compress import SeverityLogFilter`
 *      -> import SeverityLogFilter from the barrel
 *        "../src/token_goat/bash_compress.js".
 *  - `from token_goat.config import SeverityLogConfig` — in Python the helper
 *    builds a MagicMock(cfg) whose `.bash_severity_log` is a real
 *    SeverityLogConfig(context_lines=..., score_threshold=...), then patches
 *    `token_goat.config.load` to return that mock. JS has no monkeypatch for a
 *    module-private cache, so the TS port writes a real TOML `[bash_severity_log]`
 *    section to paths.configPath() (the per-test tmp data dir that setup.ts
 *    installs via setDataDirOverride) before calling compress(). config.load()
 *    reads that file, validates the same defaults/clamps (context_lines 0..100,
 *    score_threshold 0.0..1.0), and returns the same SeverityLogConfig shape.
 *    setup.ts's beforeEach already calls clearModuleCaches() — which drops the
 *    config mtime cache via the registerReset(clearConfigCache) hook — so each
 *    test starts with a blank config cache and reads the TOML we just wrote.
 *  - `SeverityLogFilter.detect(stream)` (Python @classmethod) is an INSTANCE
 *    method on the TS class (the static/classmethod distinction collapses for
 *    content-only filters; see tail_filters.ts header notes).
 *  - The Python helper calls `filt.compress(stdout, stderr, exit_code, [])`
 *    directly; the TS port calls the same positional method.
 *
 * Byte-exactness: the assertions are substring `in` / `not in` checks plus one
 * `.replace("[suppressed", "")` guard (the Python idiom for "not present outside
 * a suppression sentinel"). All fixtures are pure ASCII, so code-unit length
 * equals byte length; no Buffer arithmetic is needed.
 */
import { describe, expect, it } from "vitest";

import fs from "node:fs";

import { SeverityLogFilter } from "../src/token_goat/bash_compress.js";
import * as paths from "../src/token_goat/paths.js";
import { clearConfigCache } from "../src/token_goat/config.js";

// ---------------------------------------------------------------------------
// _compress — port of the Python helper. Writes a real TOML [bash_severity_log]
// section into the per-test tmp data dir's config.toml (the same file
// config.load() consults via paths.configPath()), busts the config cache so the
// next load() re-reads it, then runs SeverityLogFilter.compress with the
// overridden context_lines / score_threshold. This is the faithful TS analogue
// of patching token_goat.config.load to return a MagicMock whose
// .bash_severity_log is the supplied SeverityLogConfig.
// ---------------------------------------------------------------------------
function _compress(
  stdout: string,
  opts?: { context_lines?: number; score_threshold?: number; stderr?: string; exit_code?: number },
): string {
  const context_lines = opts?.context_lines ?? 3;
  const score_threshold = opts?.score_threshold ?? 0.5;
  const stderr = opts?.stderr ?? "";
  const exit_code = opts?.exit_code ?? 0;

  // Write the override TOML. config.load() validates + clamps exactly as the
  // Python SeverityLogConfig defaults do (context_lines 0..100, threshold 0..1).
  const toml =
    `[bash_severity_log]\ncontext_lines = ${context_lines}\nscore_threshold = ${score_threshold}\n`;
  fs.writeFileSync(paths.configPath(), toml, "utf8");
  // Bust the config mtime cache so the next load() reads the file we just wrote.
  clearConfigCache();

  const filt = new SeverityLogFilter();
  return filt.compress(stdout, stderr, exit_code, []);
}

// ===========================================================================
// detect() tests
// ===========================================================================

describe("TestSeverityLogDetect", () => {
  it("test_detect_false_too_few_lines", () => {
    // detect() returns False when fewer than 5 lines.
    const stream = "INFO: starting\nDEBUG: loaded\nINFO: ready\n";
    const f = new SeverityLogFilter();
    expect(f.detect(stream)).toBe(false);
  });

  it("test_detect_false_low_keyword_ratio", () => {
    // detect() returns False when fewer than 30% of lines have log keywords.
    const lines = ["plain text line", "plain text line", "plain text line", "plain text line", "plain text line", "plain text line", "plain text line", "plain text line", "plain text line", "plain text line", "INFO: only two keyword lines", "more plain text"];
    // 1 keyword line out of 12 = 8.3% < 30%
    const f = new SeverityLogFilter();
    expect(f.detect(lines.join("\n"))).toBe(false);
  });

  it("test_detect_true_structured_log", () => {
    // detect() returns True for a well-formed structured log stream.
    const stream = [
      "2024-01-01 00:00:01 INFO  Application starting",
      "2024-01-01 00:00:02 INFO  Loading config",
      "2024-01-01 00:00:03 DEBUG Config loaded ok",
      "2024-01-01 00:00:04 WARN  Deprecated option used",
      "2024-01-01 00:00:05 ERROR Connection refused",
      "2024-01-01 00:00:06 INFO  Retrying",
      "2024-01-01 00:00:07 DEBUG Attempt 2",
    ].join("\n");
    const f = new SeverityLogFilter();
    expect(f.detect(stream)).toBe(true);
  });

  it("test_detect_false_exactly_4_lines", () => {
    // detect() rejects a stream with exactly 4 lines regardless of keyword ratio.
    const stream = ["ERROR: a", "ERROR: b", "ERROR: c", "ERROR: d"].join("\n");
    const f = new SeverityLogFilter();
    expect(f.detect(stream)).toBe(false);
  });
});

// ===========================================================================
// compress() suppression tests
// ===========================================================================

describe("TestSeverityLogCompress", () => {
  it("test_pure_debug_info_stream_all_suppressed", () => {
    // All DEBUG/INFO lines below threshold are suppressed to a single sentinel.
    const debug_lines = Array.from({ length: 10 }, (_v, i) => `DEBUG: step ${i}`);
    const info_lines = Array.from({ length: 5 }, (_v, i) => `INFO: item ${i}`);
    const stdout = [...debug_lines, ...info_lines].join("\n");
    const result = _compress(stdout, { context_lines: 0 });
    expect(result).toContain("[suppressed");
    expect(result).not.toContain("DEBUG");
    expect(result).not.toContain("INFO");
  });

  it("test_error_line_kept_with_context", () => {
    // An ERROR line and its N context lines are preserved.
    const lines = [
      "DEBUG: before1",
      "DEBUG: before2",
      "DEBUG: before3",
      "ERROR: boom",
      "DEBUG: after1",
      "DEBUG: after2",
      "DEBUG: after3",
    ];
    const stdout = lines.join("\n");
    const result = _compress(stdout, { context_lines: 2 });
    expect(result).toContain("ERROR: boom");
    // context before (only 2 lines before in this window)
    expect(result).toContain("DEBUG: before2");
    expect(result).toContain("DEBUG: before3");
    // context after
    expect(result).toContain("DEBUG: after1");
    expect(result).toContain("DEBUG: after2");
  });

  it("test_warn_line_kept_at_default_threshold", () => {
    // WARN lines score 0.5 and are kept unconditionally at default threshold.
    const lines = [
      "DEBUG: noise",
      "DEBUG: noise",
      "DEBUG: noise",
      "DEBUG: noise",
      "DEBUG: noise",
      "DEBUG: noise",
      "WARN: deprecated call",
      "DEBUG: more",
      "DEBUG: more",
      "DEBUG: more",
      "DEBUG: more",
      "DEBUG: more",
      "DEBUG: more",
    ];
    const stdout = lines.join("\n");
    const result = _compress(stdout, { context_lines: 0 });
    expect(result).toContain("WARN: deprecated call");
  });

  it("test_stack_trace_after_error_preserved", () => {
    // Multi-line stack trace opened by ERROR is preserved until blank line closes it.
    const lines = [
      "INFO: running",
      "INFO: connecting",
      "ERROR: connection failed",
      "    at connect (net.js:42)",
      "    at tryConnect (net.js:88)",
      "    at Socket.<anonymous> (net.js:120)",
      "",
      "INFO: retrying",
      "INFO: done",
    ];
    const stdout = lines.join("\n");
    const result = _compress(stdout, { context_lines: 0 });
    expect(result).toContain("ERROR: connection failed");
    expect(result).toContain("at connect");
    expect(result).toContain("at tryConnect");
    expect(result).toContain("at Socket");
  });

  it("test_context_lines_exact_count", () => {
    // Exactly context_lines=2 lines are kept before and after the ERROR line.
    // Build: 5 debug lines, 1 error, 5 debug lines.
    const before = Array.from({ length: 5 }, (_v, i) => `DEBUG: b${i}`);
    const after = Array.from({ length: 5 }, (_v, i) => `DEBUG: a${i}`);
    const lines = [...before, "ERROR: boom", ...after];
    const stdout = lines.join("\n");
    const result = _compress(stdout, { context_lines: 2 });
    const result_lines = result.split(/\r?\n/).filter((ln) => !ln.startsWith("[suppressed"));
    // Should contain: b3, b4, ERROR, a0, a1 (the 2 before and 2 after)
    expect(result).toContain("DEBUG: b3");
    expect(result).toContain("DEBUG: b4");
    expect(result).toContain("ERROR: boom");
    expect(result).toContain("DEBUG: a0");
    expect(result).toContain("DEBUG: a1");
    // Confirm b0..b2 are NOT in the kept lines
    const joined = result_lines.join("\n");
    expect(joined).not.toContain("DEBUG: b0");
    expect(joined).not.toContain("DEBUG: b1");
    expect(joined).not.toContain("DEBUG: b2");
  });

  it("test_gap_sentinel_correct_suppressed_count", () => {
    // The sentinel accurately reports the number of suppressed lines in each gap.
    const lines = [
      "DEBUG: noise",
      "DEBUG: noise",
      "DEBUG: noise",
      "DEBUG: noise",
      "DEBUG: noise",
      "DEBUG: noise",
      "DEBUG: noise",
      "ERROR: boom",
      "DEBUG: tail",
      "DEBUG: tail",
      "DEBUG: tail",
      "DEBUG: tail",
    ];
    const stdout = lines.join("\n");
    const result = _compress(stdout, { context_lines: 0 });
    // 7 noise lines before the error are suppressed
    expect(result).toContain("[suppressed 7 lines]");
    // 4 tail lines after the error are suppressed
    expect(result).toContain("[suppressed 4 lines]");
  });

  it("test_score_threshold_one_drops_warn", () => {
    // score_threshold=1.0 keeps only ERROR/FAIL lines; WARN (0.5) is dropped.
    const lines = [
      "INFO: ok",
      "INFO: ok",
      "INFO: ok",
      "WARN: deprecated",
      "INFO: ok",
      "INFO: ok",
      "INFO: ok",
      "ERROR: fatal",
    ];
    // Ensure enough lines for detect() — pad to >5 lines with keywords
    const stdout = lines.join("\n");
    const result = _compress(stdout, { context_lines: 0, score_threshold: 1.0 });
    expect(result).toContain("ERROR: fatal");
    expect(result.replace("[suppressed", "")).not.toContain("WARN: deprecated");
  });

  it("test_context_lines_zero_keeps_only_matched", () => {
    // context_lines=0 keeps only the exactly matching lines, no neighbours.
    const lines = [
      "DEBUG: before1",
      "DEBUG: before2",
      "ERROR: oops",
      "DEBUG: after1",
      "DEBUG: after2",
    ];
    const stdout = lines.join("\n");
    const result = _compress(stdout, { context_lines: 0 });
    expect(result).toContain("ERROR: oops");
    expect(result.replace("[suppressed", "")).not.toContain("DEBUG: before1");
    expect(result.replace("[suppressed", "")).not.toContain("DEBUG: after1");
  });

  it("test_trace_window_closed_by_blank_line", () => {
    // Lines after a blank line that closes a trace window are scored normally.
    const lines = [
      "INFO: start",
      "INFO: running",
      "ERROR: failure",
      "    at foo (bar.js:1)",
      "",
      "DEBUG: this is after blank",
      "INFO: resuming",
      "INFO: done",
      "INFO: finished",
    ];
    const stdout = lines.join("\n");
    const result = _compress(stdout, { context_lines: 0 });
    // ERROR and trace line kept
    expect(result).toContain("ERROR: failure");
    expect(result).toContain("at foo (bar.js:1)");
    // Lines after the blank are scored normally — DEBUG/INFO suppressed
    expect(result.replace("[suppressed", "")).not.toContain("DEBUG: this is after blank");
  });

  it("test_non_log_stream_passes_through", () => {
    // Output that does not look like a log stream passes through unchanged.
    const lines = ["Hello world", "This is plain text", "No log keywords here at all", "Just output"];
    const stdout = lines.join("\n");
    const result = _compress(stdout);
    // No suppression — returned as-is (detect() returns False)
    expect(result).toContain("Hello world");
    expect(result).not.toContain("[suppressed");
  });

  it("test_python_traceback_preserved", () => {
    // Stack trace lines matching _TRACE_CONTINUATION_RE are kept inside trace window.
    //
    // Uses indented File/in/raise lines that directly follow the ERROR line so
    // they match the continuation regex (^SPACE+(?:File "|in |...) and ^SPACE+word(...)$).
    // The bare 'Traceback (most recent call last):' header is intentionally
    // omitted because it has no leading whitespace and does not match the spec
    // regex.
    const lines = [
      "INFO: process starting",
      "INFO: connecting to db",
      "ERROR: RuntimeError occurred",
      '  File "app.py", line 42, in main',
      "    connect()",
      '  File "db.py", line 10, in connect',
      "    raise RuntimeError('timeout')",
      "",
      "INFO: exiting",
    ];
    const stdout = lines.join("\n");
    const result = _compress(stdout, { context_lines: 0 });
    expect(result).toContain("ERROR: RuntimeError occurred");
    expect(result).toContain('File "app.py"');
    expect(result).toContain('File "db.py"');
  });
});
