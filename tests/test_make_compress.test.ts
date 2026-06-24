/**
 * Tests for make/cmake/ninja output detection and compression.
 *
 * 1:1 port of tests/test_make_compress.py. Covers `_is_make_cmd`
 * (bash_compress barrel) and the make post_bash compression block in
 * hooks_read, which looks up `_is_make_cmd` via _bcFn().
 *
 * Test-seam mapping (Python -> TS):
 *  - `_run_hook(stdout, cmd, exit_code=0)` -> hooks_read.post_bash with a
 *    sessionless payload (no session_id), returning {} when post_bash returns a
 *    falsy value (Python `result or {}`).
 *  - f"[{pct:3d}%]" (Python right-justify width-3 int) -> a local pad3() helper.
 *  - .splitlines() -> local splitlines() with Python trailing-newline semantics.
 *  - exit_code=None -> null.
 */
import { describe, expect, it } from "vitest";

import { _is_make_cmd } from "../src/token_goat/bash_compress.js";
import * as hooks_read from "../src/token_goat/hooks_read.js";
import type { HookPayload } from "../src/token_goat/types.js";

const _MAKE_MIN_LINES = 40;

/** Port of Python format spec `{n:3d}` (right-justify int in width 3). */
function pad3(n: number): string {
  return String(n).padStart(3, " ");
}

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

interface MakeStdoutOpts {
  progress_lines?: number;
  error_lines?: number;
  warning_lines?: number;
  blank_lines?: number;
  with_summary?: boolean;
  makefile_noise?: boolean;
}

function _make_stdout(opts: MakeStdoutOpts = {}): string {
  const progress_lines = opts.progress_lines ?? 0;
  const error_lines = opts.error_lines ?? 0;
  const warning_lines = opts.warning_lines ?? 0;
  const blank_lines = opts.blank_lines ?? 0;
  const with_summary = opts.with_summary ?? true;
  const makefile_noise = opts.makefile_noise ?? false;

  const lines: string[] = [];
  for (let i = 0; i < progress_lines; i++) {
    const pct = (i + 1) * 2;
    lines.push(`[${pad3(pct)}%] Building CXX object src/foo${i}.cpp.o`);
  }
  if (makefile_noise) {
    lines.push("make[1]: Entering directory '/tmp/build'");
    lines.push("make[2]: Entering directory '/tmp/build/src'");
    lines.push("-- Configuring done");
    lines.push("Leaving directory '/tmp/build'");
  }
  for (let i = 0; i < error_lines; i++) {
    lines.push(`src/foo${i}.cpp:10:5: error: use of undeclared identifier 'bar'`);
  }
  for (let i = 0; i < warning_lines; i++) {
    lines.push(`src/bar${i}.cpp:20:3: warning: unused variable 'x' [-Wunused-variable]`);
  }
  for (let i = 0; i < blank_lines; i++) {
    lines.push("");
  }
  if (with_summary) {
    lines.push("Build complete: myapp"); // plain summary, not a [N%] progress line
  }
  return lines.join("\n") + "\n";
}

function _run_hook(stdout: string, cmd: string, exit_code: number | null = 0): Record<string, unknown> {
  const payload = {
    tool: "Bash",
    tool_input: { command: cmd },
    tool_response: {
      stdout,
      stderr: "",
      exit_code,
    },
  } as unknown as HookPayload;
  const result = hooks_read.post_bash(payload) as Record<string, unknown>;
  return result || {};
}

// ---------------------------------------------------------------------------
// Detection tests — _is_make_cmd
// ---------------------------------------------------------------------------

describe("TestIsMakeCmd", () => {
  // --- make / gmake ---

  it("test_bare_make", () => {
    expect(_is_make_cmd(["make"])).toBe(true);
  });

  it("test_make_with_target", () => {
    expect(_is_make_cmd(["make", "all"])).toBe(true);
  });

  it("test_make_with_jobs_flag", () => {
    expect(_is_make_cmd(["make", "-j8"])).toBe(true);
  });

  it("test_make_with_file_flag", () => {
    expect(_is_make_cmd(["make", "-f", "Makefile.custom", "install"])).toBe(true);
  });

  it("test_make_with_multiple_flags", () => {
    expect(_is_make_cmd(["make", "-j4", "-C", "src", "all"])).toBe(true);
  });

  it("test_make_exe_extension", () => {
    expect(_is_make_cmd(["make.exe"])).toBe(true);
  });

  it("test_make_path_prefix", () => {
    expect(_is_make_cmd(["/usr/bin/make", "clean"])).toBe(true);
  });

  it("test_make_windows_path", () => {
    expect(_is_make_cmd(["C:\\MinGW\\bin\\make.exe", "all"])).toBe(true);
  });

  it("test_gmake_bare", () => {
    expect(_is_make_cmd(["gmake"])).toBe(true);
  });

  it("test_gmake_with_target", () => {
    expect(_is_make_cmd(["gmake", "install"])).toBe(true);
  });

  it("test_gmake_path_prefix", () => {
    expect(_is_make_cmd(["/usr/local/bin/gmake", "-j4"])).toBe(true);
  });

  // --- ninja ---

  it("test_bare_ninja", () => {
    expect(_is_make_cmd(["ninja"])).toBe(true);
  });

  it("test_ninja_with_target", () => {
    expect(_is_make_cmd(["ninja", "all"])).toBe(true);
  });

  it("test_ninja_with_jobs_flag", () => {
    expect(_is_make_cmd(["ninja", "-j8"])).toBe(true);
  });

  it("test_ninja_with_verbose", () => {
    expect(_is_make_cmd(["ninja", "-v"])).toBe(true);
  });

  it("test_ninja_path_prefix", () => {
    expect(_is_make_cmd(["/usr/bin/ninja", "-C", "build"])).toBe(true);
  });

  it("test_ninja_exe_extension", () => {
    expect(_is_make_cmd(["ninja.exe", "-j4"])).toBe(true);
  });

  // --- cmake --build ---

  it("test_cmake_build", () => {
    expect(_is_make_cmd(["cmake", "--build", "."])).toBe(true);
  });

  it("test_cmake_build_with_dir", () => {
    expect(_is_make_cmd(["cmake", "--build", "build/"])).toBe(true);
  });

  it("test_cmake_build_with_config_flag", () => {
    expect(_is_make_cmd(["cmake", "--build", ".", "--config", "Release"])).toBe(true);
  });

  it("test_cmake_build_with_preset_before", () => {
    expect(_is_make_cmd(["cmake", "--preset", "default", "--build", "."])).toBe(true);
  });

  it("test_cmake_build_flag_skips_G_value", () => {
    expect(_is_make_cmd(["cmake", "-G", "Ninja", "--build", "."])).toBe(true);
  });

  it("test_cmake_build_flag_skips_D_value", () => {
    expect(_is_make_cmd(["cmake", "-DCMAKE_BUILD_TYPE=Release", "--build", "."])).toBe(true);
  });

  it("test_cmake_path_prefix", () => {
    expect(_is_make_cmd(["/usr/bin/cmake", "--build", "."])).toBe(true);
  });

  // --- False cases ---

  it("test_empty_argv", () => {
    expect(_is_make_cmd([])).toBe(false);
  });

  it("test_unknown_command", () => {
    expect(_is_make_cmd(["gcc", "main.c"])).toBe(false);
  });

  it("test_cmake_without_build", () => {
    expect(_is_make_cmd(["cmake", "."])).toBe(false);
  });

  it("test_cmake_configure_only", () => {
    expect(_is_make_cmd(["cmake", "-G", "Ninja", "-B", "build"])).toBe(false);
  });

  it("test_cmake_install", () => {
    expect(_is_make_cmd(["cmake", "--install", "."])).toBe(false);
  });

  it("test_cmake_empty_argv_after_cmake", () => {
    expect(_is_make_cmd(["cmake"])).toBe(false);
  });

  it("test_make_upper_case_not_matched", () => {
    // _base() lower-cases, so MAKE.exe -> make -> matches; pure upper "MAKE" w/o ext
    expect(_is_make_cmd(["MAKE"])).toBe(true); // lower-cased by _base()
  });

  it("test_not_python", () => {
    expect(_is_make_cmd(["python", "build.py"])).toBe(false);
  });

  it("test_not_cargo", () => {
    expect(_is_make_cmd(["cargo", "build"])).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Compression block tests (hooks_read.post_bash)
// ---------------------------------------------------------------------------

describe("TestMakeCompression", () => {
  // Test the make/cmake/ninja post_bash compression block in hooks_read.

  it("test_short_output_falls_through", () => {
    // Output with < 40 lines must not be compressed.
    const stdout = _make_stdout({ progress_lines: 20, error_lines: 2, with_summary: true });
    expect(splitlines(stdout).length).toBeLessThan(_MAKE_MIN_LINES);
    const result = _run_hook(stdout, "make all", 0);
    const msg = (result["systemMessage"] as string) ?? "";
    expect(msg).not.toContain("[token-goat] make:");
  });

  it("test_non_make_command_not_compressed", () => {
    // Large output from a non-make command must not trigger make compression.
    const stdout = _make_stdout({ progress_lines: 50, with_summary: true });
    const result = _run_hook(stdout, "cargo build", 0);
    const msg = (result["systemMessage"] as string) ?? "";
    expect(msg).not.toContain("[token-goat] make:");
  });

  it("test_exit_code_3_falls_through", () => {
    // exit_code=3 is outside (None, 0, 1, 2) — must not be compressed.
    const stdout = _make_stdout({ progress_lines: 50, error_lines: 5, with_summary: true });
    expect(splitlines(stdout).length).toBeGreaterThanOrEqual(_MAKE_MIN_LINES);
    const result = _run_hook(stdout, "make all", 3);
    const msg = (result["systemMessage"] as string) ?? "";
    expect(msg).not.toContain("[token-goat] make:");
  });

  // SEAM: re-skipped — reveals an impl bug in the just-ported make block.
  // Python's post_bash make block counts lines with stdout.splitlines()
  // (hooks_read.py:6578/6591), but the TS port uses stdout.split("\n")
  // (hooks_read.ts:6159/6166-6167). For output with a trailing newline,
  // split("\n") yields an extra empty trailing element, so (a) the trailing
  // blank line is wrongly counted as a suppressed "progress" line and (b)
  // _mk_total is one larger. Here the 42 plain lines + trailing "" makes the
  // impl suppress 1 line and emit a header, where Python suppresses 0 and
  // falls through. Reported in implBugsFound; do NOT edit src.
  it("test_no_progress_lines_falls_through", () => {
    // Output with 0 suppressible lines must not emit a make header.
    const lines: string[] = [];
    for (let i = 0; i < 42; i++) {
      lines.push(`real output line ${i}`);
    }
    const stdout = lines.join("\n") + "\n";
    const result = _run_hook(stdout, "make all", 0);
    const msg = (result["systemMessage"] as string) ?? "";
    expect(msg).not.toContain("[token-goat] make:");
  });

  it("test_progress_lines_suppressed", () => {
    // [  N%] progress lines must be stripped from output.
    const stdout = _make_stdout({ progress_lines: 45, error_lines: 2, with_summary: true });
    expect(splitlines(stdout).length).toBeGreaterThanOrEqual(_MAKE_MIN_LINES);
    const result = _run_hook(stdout, "make all", 1);
    const msg = (result["systemMessage"] as string) ?? "";
    expect(msg).toContain("[token-goat] make:");
    expect(msg).not.toContain("[  2%] Building");
  });

  it("test_make_bracket_noise_suppressed", () => {
    // make[N]: lines must be suppressed.
    const stdout = _make_stdout({ progress_lines: 35, makefile_noise: true, error_lines: 2, with_summary: true });
    expect(splitlines(stdout).length).toBeGreaterThanOrEqual(_MAKE_MIN_LINES);
    const result = _run_hook(stdout, "make all", 1);
    const msg = (result["systemMessage"] as string) ?? "";
    expect(msg).not.toContain("make[1]: Entering");
  });

  it("test_entering_directory_suppressed", () => {
    const stdout = _make_stdout({ progress_lines: 35, makefile_noise: true, error_lines: 2, with_summary: true });
    const result = _run_hook(stdout, "make all", 1);
    const msg = (result["systemMessage"] as string) ?? "";
    expect(msg).not.toContain("Entering directory");
  });

  it("test_leaving_directory_suppressed", () => {
    const stdout = _make_stdout({ progress_lines: 35, makefile_noise: true, error_lines: 2, with_summary: true });
    const result = _run_hook(stdout, "make all", 1);
    const msg = (result["systemMessage"] as string) ?? "";
    expect(msg).not.toContain("Leaving directory");
  });

  it("test_double_dash_lines_suppressed", () => {
    const stdout = _make_stdout({ progress_lines: 35, makefile_noise: true, error_lines: 2, with_summary: true });
    const result = _run_hook(stdout, "make all", 1);
    const msg = (result["systemMessage"] as string) ?? "";
    expect(msg).not.toContain("-- Configuring done");
  });

  it("test_blank_lines_suppressed", () => {
    const stdout = _make_stdout({ progress_lines: 35, blank_lines: 10, error_lines: 2, with_summary: true });
    expect(splitlines(stdout).length).toBeGreaterThanOrEqual(_MAKE_MIN_LINES);
    const result = _run_hook(stdout, "make all", 1);
    const msg = (result["systemMessage"] as string) ?? "";
    expect(msg).toContain("[token-goat] make:");
    expect(msg).toContain("progress lines hidden");
  });

  it("test_error_lines_kept", () => {
    const stdout = _make_stdout({ progress_lines: 38, error_lines: 3, with_summary: true });
    expect(splitlines(stdout).length).toBeGreaterThanOrEqual(_MAKE_MIN_LINES);
    const result = _run_hook(stdout, "make all", 1);
    const msg = (result["systemMessage"] as string) ?? "";
    expect(msg).toContain("error: use of undeclared identifier");
  });

  it("test_warning_lines_kept", () => {
    const stdout = _make_stdout({ progress_lines: 38, warning_lines: 3, with_summary: true });
    expect(splitlines(stdout).length).toBeGreaterThanOrEqual(_MAKE_MIN_LINES);
    const result = _run_hook(stdout, "make all", 0);
    const msg = (result["systemMessage"] as string) ?? "";
    expect(msg).toContain("warning: unused variable");
  });

  it("test_summary_line_kept", () => {
    const stdout = _make_stdout({ progress_lines: 39, with_summary: true });
    expect(splitlines(stdout).length).toBeGreaterThanOrEqual(_MAKE_MIN_LINES);
    const result = _run_hook(stdout, "make", 0);
    const msg = (result["systemMessage"] as string) ?? "";
    // "Build complete: myapp" has no progress-line prefix so it must survive
    expect(msg).toContain("Build complete: myapp");
  });

  // SEAM: re-skipped — same impl bug (split("\n") vs splitlines()). The header
  // reports _mk_total counted via split("\n"), which is one larger than the
  // Python splitlines() total this test computes, so the "{total} lines"
  // substring does not match. Reported in implBugsFound; do NOT edit src.
  it("test_header_contains_line_counts", () => {
    const stdout = _make_stdout({ progress_lines: 40, error_lines: 2, with_summary: true });
    const total = splitlines(stdout).length;
    expect(total).toBeGreaterThanOrEqual(_MAKE_MIN_LINES);
    const result = _run_hook(stdout, "make all", 1);
    const msg = (result["systemMessage"] as string) ?? "";
    expect(msg).toContain(`${total} lines`);
    expect(msg).toContain("kept");
  });

  it("test_suppressed_count_in_header", () => {
    const stdout = _make_stdout({ progress_lines: 40, error_lines: 2, with_summary: true });
    expect(splitlines(stdout).length).toBeGreaterThanOrEqual(_MAKE_MIN_LINES);
    const result = _run_hook(stdout, "make all", 1);
    const msg = (result["systemMessage"] as string) ?? "";
    expect(msg).toContain("progress lines hidden");
  });

  it("test_bash_output_hint_present", () => {
    // When no session_id, no bash-output id is available but hint block absent.
    const stdout = _make_stdout({ progress_lines: 40, error_lines: 1, with_summary: true });
    expect(splitlines(stdout).length).toBeGreaterThanOrEqual(_MAKE_MIN_LINES);
    const result = _run_hook(stdout, "make all", 1);
    // result must be a systemMessage dict
    expect("systemMessage" in result).toBe(true);
  });

  it("test_continue_true_returned", () => {
    const stdout = _make_stdout({ progress_lines: 40, error_lines: 1, with_summary: true });
    const result = _run_hook(stdout, "make all", 1);
    expect(result["continue"]).toBe(true);
  });

  it("test_ninja_command_detected", () => {
    const stdout = _make_stdout({ progress_lines: 42, error_lines: 2, with_summary: true });
    expect(splitlines(stdout).length).toBeGreaterThanOrEqual(_MAKE_MIN_LINES);
    const result = _run_hook(stdout, "ninja -j8 all", 1);
    const msg = (result["systemMessage"] as string) ?? "";
    expect(msg).toContain("[token-goat] make:");
  });

  it("test_cmake_build_command_detected", () => {
    const stdout = _make_stdout({ progress_lines: 42, error_lines: 2, with_summary: true });
    expect(splitlines(stdout).length).toBeGreaterThanOrEqual(_MAKE_MIN_LINES);
    const result = _run_hook(stdout, "cmake --build . --config Release", 1);
    const msg = (result["systemMessage"] as string) ?? "";
    expect(msg).toContain("[token-goat] make:");
  });

  it("test_gmake_command_detected", () => {
    const stdout = _make_stdout({ progress_lines: 42, error_lines: 2, with_summary: true });
    expect(splitlines(stdout).length).toBeGreaterThanOrEqual(_MAKE_MIN_LINES);
    const result = _run_hook(stdout, "gmake -j4", 1);
    const msg = (result["systemMessage"] as string) ?? "";
    expect(msg).toContain("[token-goat] make:");
  });

  it("test_exit_code_none_accepted", () => {
    const stdout = _make_stdout({ progress_lines: 40, error_lines: 1, with_summary: true });
    expect(splitlines(stdout).length).toBeGreaterThanOrEqual(_MAKE_MIN_LINES);
    const result = _run_hook(stdout, "make all", null);
    const msg = (result["systemMessage"] as string) ?? "";
    expect(msg).toContain("[token-goat] make:");
  });

  it("test_exit_code_2_accepted", () => {
    const stdout = _make_stdout({ progress_lines: 40, error_lines: 3, with_summary: false });
    expect(splitlines(stdout).length).toBeGreaterThanOrEqual(_MAKE_MIN_LINES);
    const result = _run_hook(stdout, "make all", 2);
    const msg = (result["systemMessage"] as string) ?? "";
    expect(msg).toContain("[token-goat] make:");
  });

  it("test_exact_40_lines_triggers", () => {
    // Build stdout with exactly 40 lines total, at least some suppressible
    const lines: string[] = [];
    for (let i = 0; i < 37; i++) {
      lines.push(`[${pad3(i + 1)}%] Building src/file${i}.o`);
    }
    lines.push("src/bad.cpp:1:1: error: bad");
    lines.push(""); // blank — suppressible
    lines.push("Build complete: myapp");
    const stdout = lines.join("\n") + "\n";
    expect(splitlines(stdout).length).toBe(40);
    const result = _run_hook(stdout, "make", 1);
    const msg = (result["systemMessage"] as string) ?? "";
    expect(msg).toContain("[token-goat] make:");
  });

  // SEAM: re-skipped — same impl bug (split("\n") vs splitlines()). A 39-line
  // stdout with a trailing newline becomes 40 elements under split("\n"), so
  // the impl's `>= _MAKE_MIN_LINES` guard wrongly fires and a make header is
  // emitted where Python's splitlines() count of 39 falls through. Reported in
  // implBugsFound; do NOT edit src.
  it("test_39_lines_falls_through", () => {
    const lines: string[] = [];
    for (let i = 0; i < 36; i++) {
      lines.push(`[${pad3(i + 1)}%] Building src/file${i}.o`);
    }
    lines.push("src/bad.cpp:1:1: error: bad");
    lines.push("");
    lines.push("Build complete: myapp");
    const stdout = lines.join("\n") + "\n";
    expect(splitlines(stdout).length).toBe(39);
    const result = _run_hook(stdout, "make", 1);
    const msg = (result["systemMessage"] as string) ?? "";
    expect(msg).not.toContain("[token-goat] make:");
  });

  it("test_make_error_bracket_line_kept", () => {
    // make[N]: *** [...] Error lines must be kept, not suppressed.
    const lines: string[] = [];
    for (let i = 0; i < 37; i++) {
      lines.push(`[${pad3(i + 1)}%] Building CXX object src/CMakeFiles/myapp.dir/file${i}.cpp.o`);
    }
    lines.push("make[1]: Entering directory '/tmp/build'");
    lines.push("make[2]: Entering directory '/tmp/build/src'");
    lines.push("make[1]: *** [src/CMakeFiles/myapp.dir/main.cpp.o] Error 1");
    lines.push("Build complete: myapp");
    const stdout = lines.join("\n") + "\n";
    expect(splitlines(stdout).length).toBeGreaterThanOrEqual(_MAKE_MIN_LINES);
    const result = _run_hook(stdout, "make all", 1);
    const msg = (result["systemMessage"] as string) ?? "";
    // The *** Error line is a build diagnostic — it must survive compression.
    expect(msg).toContain("make[1]: *** [src/CMakeFiles/myapp.dir/main.cpp.o] Error 1");
    // Directory-entry noise lines must still be suppressed.
    expect(msg).not.toContain("make[1]: Entering directory");
    expect(msg).not.toContain("make[2]: Entering directory");
  });
});
