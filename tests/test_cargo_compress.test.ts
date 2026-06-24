/**
 * Tests for Rust/cargo compiler output compression.
 *
 * 1:1 port of tests/test_cargo_compress.py. Covers `_is_cargo_compile_cmd`
 * (bash_compress barrel) and the cargo post_bash compression block in
 * hooks_read, which looks up `_is_cargo_compile_cmd` via _bcFn().
 *
 * Test-seam mapping (Python -> TS):
 *  - `_make_post_bash_payload(...)` -> a sessionless payload (session_id ""), so
 *    post_bash skips session machinery and the cargo block fires regardless.
 *  - `from token_goat.hooks_read import _CARGO_COMPILE_MIN_LINES` -> in the TS
 *    port the constant is module-private (`const`, not exported). The lone
 *    `test_constant_exported` case is therefore re-skipped (export-surface
 *    decision owned by the impl phase); the value (40) it gates is still
 *    exercised by every threshold test below.
 *  - .splitlines() -> local splitlines() with Python trailing-newline semantics.
 */
import { describe, expect, it } from "vitest";

import { _is_cargo_compile_cmd } from "../src/token_goat/bash_compress.js";
import { post_bash, _CARGO_COMPILE_MIN_LINES } from "../src/token_goat/hooks_read.js";
import type { HookPayload } from "../src/token_goat/types.js";

interface PayloadOpts {
  exit_code?: number;
  sid?: string | null;
  cwd?: string;
}

function _make_post_bash_payload(cmd: string, stdout: string, opts: PayloadOpts = {}): HookPayload {
  const exit_code = opts.exit_code ?? 0;
  const sid = opts.sid ?? null;
  const cwd = opts.cwd ?? "/proj";
  return {
    session_id: sid || "",
    tool_name: "Bash",
    tool_input: { command: cmd },
    tool_response: { stdout, stderr: "", exit_code },
    cwd,
  } as unknown as HookPayload;
}

interface NoisyOpts {
  n_compiling?: number;
  n_errors?: number;
  n_warnings?: number;
  with_trailing_newline?: boolean;
  finished?: boolean;
}

function _make_noisy_build_stdout(opts: NoisyOpts = {}): string {
  const n_compiling = opts.n_compiling ?? 50;
  const n_errors = opts.n_errors ?? 0;
  const n_warnings = opts.n_warnings ?? 0;
  const with_trailing_newline = opts.with_trailing_newline ?? true;
  const finished = opts.finished ?? true;

  const lines: string[] = [];
  for (let i = 0; i < n_compiling; i++) {
    lines.push(`   Compiling crate_${i} v0.1.${i} (/workspace/crate_${i})`);
  }

  for (let i = 0; i < n_warnings; i++) {
    lines.push("warning[unused_imports]: unused import: `std::collections::HashMap`");
    lines.push(`  --> src/lib.rs:${10 + i}:5`);
    lines.push("   |");
    lines.push(`${10 + i}  | use std::collections::HashMap;`);
    lines.push("   |     ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^");
    lines.push("   = note: `#[warn(unused_imports)]` on by default");
  }

  for (let i = 0; i < n_errors; i++) {
    lines.push("error[E0308]: mismatched types");
    lines.push(`  --> src/main.rs:${20 + i}:13`);
    lines.push("   |");
    lines.push('   |     let x: i32 = "hello";');
    lines.push("   |             ^^^^^^^ expected `i32`, found `&str`");
    lines.push("   =  note: expected type `i32`");
  }

  if (n_errors > 0) {
    lines.push(`error: could not compile \`myproject\` due to ${n_errors} previous error(s)`);
  } else if (finished) {
    lines.push("Finished dev [unoptimized + debuginfo] target(s) in 3.45s");
  }

  let body = lines.join("\n");
  if (with_trailing_newline) {
    body += "\n";
  }
  return body;
}

// ---------------------------------------------------------------------------
// _is_cargo_compile_cmd — detection tests
// ---------------------------------------------------------------------------

describe("TestIsCargoCompileCmd", () => {
  function _fn(argv: string[]): boolean {
    return _is_cargo_compile_cmd(argv);
  }

  // Positive cases: compile subcommands
  it("test_build", () => {
    expect(_fn(["cargo", "build"])).toBe(true);
  });

  it("test_check", () => {
    expect(_fn(["cargo", "check"])).toBe(true);
  });

  it("test_clippy", () => {
    expect(_fn(["cargo", "clippy"])).toBe(true);
  });

  it("test_fix", () => {
    expect(_fn(["cargo", "fix"])).toBe(true);
  });

  it("test_rustc", () => {
    expect(_fn(["cargo", "rustc"])).toBe(true);
  });

  // Negative cases: non-compile subcommands
  it("test_test_excluded", () => {
    expect(_fn(["cargo", "test"])).toBe(false);
  });

  it("test_run_excluded", () => {
    expect(_fn(["cargo", "run"])).toBe(false);
  });

  it("test_install_excluded", () => {
    expect(_fn(["cargo", "install"])).toBe(false);
  });

  it("test_update_excluded", () => {
    expect(_fn(["cargo", "update"])).toBe(false);
  });

  it("test_publish_excluded", () => {
    expect(_fn(["cargo", "publish"])).toBe(false);
  });

  it("test_add_excluded", () => {
    expect(_fn(["cargo", "add"])).toBe(false);
  });

  it("test_remove_excluded", () => {
    expect(_fn(["cargo", "remove"])).toBe(false);
  });

  it("test_search_excluded", () => {
    expect(_fn(["cargo", "search"])).toBe(false);
  });

  it("test_login_excluded", () => {
    expect(_fn(["cargo", "login"])).toBe(false);
  });

  // Global flags before subcommand
  it("test_dash_v_before_build", () => {
    expect(_fn(["cargo", "-v", "build"])).toBe(true);
  });

  it("test_verbose_long_before_check", () => {
    expect(_fn(["cargo", "--verbose", "check"])).toBe(true);
  });

  it("test_quiet_before_clippy", () => {
    expect(_fn(["cargo", "--quiet", "clippy"])).toBe(true);
  });

  it("test_color_always_before_check", () => {
    // --color takes a value argument; both tokens must be skipped
    expect(_fn(["cargo", "--color", "always", "check"])).toBe(true);
  });

  it("test_color_always_before_build", () => {
    expect(_fn(["cargo", "--color", "always", "build"])).toBe(true);
  });

  it("test_config_flag_before_check", () => {
    expect(_fn(["cargo", "--config", "net.retry=3", "check"])).toBe(true);
  });

  it("test_Z_flag_before_build", () => {
    expect(_fn(["cargo", "-Z", "unstable-options", "build"])).toBe(true);
  });

  // Subcommand flags after the subcommand are irrelevant to detection
  it("test_build_release", () => {
    expect(_fn(["cargo", "build", "--release"])).toBe(true);
  });

  it("test_check_target", () => {
    expect(_fn(["cargo", "check", "--target", "x86_64-unknown-linux-gnu"])).toBe(true);
  });

  it("test_clippy_extra_flags", () => {
    expect(_fn(["cargo", "clippy", "--", "-D", "warnings"])).toBe(true);
  });

  // Edge: empty argv and non-cargo binaries
  it("test_empty_argv", () => {
    expect(_fn([])).toBe(false);
  });

  it("test_non_cargo_binary", () => {
    expect(_fn(["gcc", "build"])).toBe(false);
  });

  it("test_python_binary", () => {
    expect(_fn(["python", "cargo", "build"])).toBe(false);
  });

  it("test_cargo_only_flags_no_subcommand", () => {
    // Global flags only, no positional subcommand -> False
    expect(_fn(["cargo", "--verbose"])).toBe(false);
  });

  it("test_cargo_no_args", () => {
    expect(_fn(["cargo"])).toBe(false);
  });

  it("test_cargo_exe_extension", () => {
    // Windows-style "cargo.exe"
    expect(_fn(["cargo.exe", "build"])).toBe(true);
  });

  it("test_cargo_full_path", () => {
    expect(_fn(["/usr/local/bin/cargo", "check"])).toBe(true);
  });

  // Bug 3: --manifest-path takes an argument and must be skipped as a 2-token pair
  it("test_manifest_path_before_build", () => {
    expect(_fn(["cargo", "--manifest-path", "./Cargo.toml", "build"])).toBe(true);
  });

  it("test_manifest_path_before_check", () => {
    expect(_fn(["cargo", "--manifest-path", "./sub/Cargo.toml", "check"])).toBe(true);
  });

  // Bug 4: Windows backslash paths must not be mangled by posix shlex on win32
  it("test_windows_exe_path_detected", () => {
    // Full Windows path to cargo.exe — backslashes would be eaten by posix=True shlex
    expect(_fn(["C:\\Users\\user\\.cargo\\bin\\cargo.exe", "build"])).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// post_bash compression behaviour
// ---------------------------------------------------------------------------

describe("TestCargoPostBashCompress", () => {
  function _call(payload: HookPayload): Record<string, unknown> {
    return post_bash(payload) as Record<string, unknown>;
  }

  // Return systemMessage if it contains [token-goat] cargo header, else null.
  function _cargo_msg(result: Record<string, unknown>): string | null {
    const msg = (result["systemMessage"] as string) ?? "";
    if (msg.includes("[token-goat] cargo:")) {
      return msg;
    }
    return null;
  }

  // ------------------------------------------------------------------
  // Constant exported
  // ------------------------------------------------------------------

  it("test_constant_exported", () => {
    expect(_CARGO_COMPILE_MIN_LINES).toBe(40);
  });

  // ------------------------------------------------------------------
  // Falls through: too few lines
  // ------------------------------------------------------------------

  it("test_small_output_falls_through", () => {
    const arr: string[] = [];
    for (let i = 0; i < 10; i++) {
      arr.push(`   Compiling crate_${i} v0.1.${i} (/workspace)`);
    }
    arr.push("Finished dev target(s) in 0.12s");
    const stdout = arr.join("\n") + "\n";
    const payload = _make_post_bash_payload("cargo build", stdout, { exit_code: 0 });
    const result = _call(payload);
    expect(_cargo_msg(result)).toBeNull();
  });

  // ------------------------------------------------------------------
  // Falls through: not a compile subcommand
  // ------------------------------------------------------------------

  it("test_cargo_test_not_compressed", () => {
    const stdout = _make_noisy_build_stdout({ n_compiling: 55 });
    const payload = _make_post_bash_payload("cargo test", stdout, { exit_code: 0 });
    const result = _call(payload);
    expect(_cargo_msg(result)).toBeNull();
  });

  it("test_cargo_run_not_compressed", () => {
    const stdout = _make_noisy_build_stdout({ n_compiling: 55 });
    const payload = _make_post_bash_payload("cargo run", stdout, { exit_code: 0 });
    const result = _call(payload);
    expect(_cargo_msg(result)).toBeNull();
  });

  // ------------------------------------------------------------------
  // Falls through: unusual exit code
  // ------------------------------------------------------------------

  it("test_exit_code_101_falls_through", () => {
    const stdout = _make_noisy_build_stdout({ n_compiling: 55 });
    const payload = _make_post_bash_payload("cargo build", stdout, { exit_code: 101 });
    const result = _call(payload);
    expect(_cargo_msg(result)).toBeNull();
  });

  it("test_exit_code_2_falls_through", () => {
    const stdout = _make_noisy_build_stdout({ n_compiling: 55 });
    const payload = _make_post_bash_payload("cargo build", stdout, { exit_code: 2 });
    const result = _call(payload);
    expect(_cargo_msg(result)).toBeNull();
  });

  // ------------------------------------------------------------------
  // Falls through: clean build but not noisy (< 5 noise lines)
  // ------------------------------------------------------------------

  it("test_clean_build_too_few_noise_lines_falls_through", () => {
    // 45 non-noise lines + 2 Compiling lines + Finished line = 48 lines total
    // but < 5 noise lines -> no compression
    const lines: string[] = [];
    for (let i = 0; i < 2; i++) {
      lines.push(`   Checking config_${i}`); // noise but only 2
    }
    for (let i = 0; i < 42; i++) {
      lines.push(`info: crate_${i} ok`); // non-noise filler
    }
    lines.push("Finished dev target(s) in 0.5s");
    const stdout = lines.join("\n") + "\n";
    const payload = _make_post_bash_payload("cargo check", stdout, { exit_code: 0 });
    const result = _call(payload);
    expect(_cargo_msg(result)).toBeNull();
  });

  // ------------------------------------------------------------------
  // Clean build compression (no errors/warnings, noisy)
  // ------------------------------------------------------------------

  it("test_clean_build_shows_finished_line", () => {
    const stdout = _make_noisy_build_stdout({ n_compiling: 55, finished: true });
    const payload = _make_post_bash_payload("cargo build", stdout, { exit_code: 0 });
    const result = _call(payload);
    const msg = _cargo_msg(result);
    expect(msg).not.toBeNull();
    expect(msg as string).toContain("Finished dev");
  });

  it("test_clean_build_noise_lines_absent", () => {
    const stdout = _make_noisy_build_stdout({ n_compiling: 55, finished: true });
    const payload = _make_post_bash_payload("cargo build", stdout, { exit_code: 0 });
    const result = _call(payload);
    const msg = _cargo_msg(result);
    expect(msg).not.toBeNull();
    expect(msg as string).not.toContain("Compiling crate_");
  });

  it("test_clean_build_header_reports_zero_errors", () => {
    const stdout = _make_noisy_build_stdout({ n_compiling: 55 });
    const payload = _make_post_bash_payload("cargo build", stdout, { exit_code: 0 });
    const result = _call(payload);
    const msg = _cargo_msg(result);
    expect(msg).not.toBeNull();
    expect(msg as string).toContain("0 errors");
    expect(msg as string).toContain("0 warnings");
  });

  it("test_clean_build_suppression_count_in_header", () => {
    const stdout = _make_noisy_build_stdout({ n_compiling: 55, finished: true });
    const payload = _make_post_bash_payload("cargo check", stdout, { exit_code: 0 });
    const result = _call(payload);
    const msg = _cargo_msg(result);
    expect(msg).not.toBeNull();
    // Header must contain "lines suppressed" with non-zero numbers
    expect(msg as string).toContain("lines suppressed");
  });

  // ------------------------------------------------------------------
  // Error compression
  // ------------------------------------------------------------------

  it("test_errors_compressed_header", () => {
    const stdout = _make_noisy_build_stdout({ n_compiling: 50, n_errors: 2, finished: false });
    const payload = _make_post_bash_payload("cargo build", stdout, { exit_code: 1 });
    const result = _call(payload);
    const msg = _cargo_msg(result);
    expect(msg).not.toBeNull();
    expect(msg as string).toContain("2 errors");
  });

  it("test_error_diagnostic_block_preserved", () => {
    const stdout = _make_noisy_build_stdout({ n_compiling: 50, n_errors: 1, finished: false });
    const payload = _make_post_bash_payload("cargo build", stdout, { exit_code: 1 });
    const result = _call(payload);
    const msg = _cargo_msg(result);
    expect(msg).not.toBeNull();
    expect(msg as string).toContain("error[E0308]");
  });

  it("test_error_context_lines_kept", () => {
    // Lines starting with -->, |, = (location / source / note) must be kept.
    const stdout = _make_noisy_build_stdout({ n_compiling: 50, n_errors: 1, finished: false });
    const payload = _make_post_bash_payload("cargo build", stdout, { exit_code: 1 });
    const result = _call(payload);
    const msg = _cargo_msg(result);
    expect(msg).not.toBeNull();
    expect(msg as string).toContain("  -->");
    expect(msg as string).toContain("   |");
    expect(msg as string).toContain("   =");
  });

  it("test_error_noise_lines_absent", () => {
    const stdout = _make_noisy_build_stdout({ n_compiling: 50, n_errors: 1, finished: false });
    const payload = _make_post_bash_payload("cargo build", stdout, { exit_code: 1 });
    const result = _call(payload);
    const msg = _cargo_msg(result);
    expect(msg).not.toBeNull();
    expect(msg as string).not.toContain("Compiling crate_");
  });

  it("test_terminal_error_line_included", () => {
    const stdout = _make_noisy_build_stdout({ n_compiling: 50, n_errors: 1, finished: false });
    const payload = _make_post_bash_payload("cargo build", stdout, { exit_code: 1 });
    const result = _call(payload);
    const msg = _cargo_msg(result);
    expect(msg).not.toBeNull();
    expect(msg as string).toContain("could not compile");
  });

  // ------------------------------------------------------------------
  // Warning compression
  // ------------------------------------------------------------------

  it("test_warnings_compressed_header", () => {
    const stdout = _make_noisy_build_stdout({ n_compiling: 50, n_warnings: 3, finished: true });
    const payload = _make_post_bash_payload("cargo check", stdout, { exit_code: 0 });
    const result = _call(payload);
    const msg = _cargo_msg(result);
    expect(msg).not.toBeNull();
    expect(msg as string).toContain("3 warnings");
  });

  it("test_warning_block_preserved", () => {
    const stdout = _make_noisy_build_stdout({ n_compiling: 50, n_warnings: 1, finished: true });
    const payload = _make_post_bash_payload("cargo check", stdout, { exit_code: 0 });
    const result = _call(payload);
    const msg = _cargo_msg(result);
    expect(msg).not.toBeNull();
    expect(msg as string).toContain("warning[unused_imports]");
  });

  it("test_warning_noise_absent", () => {
    const stdout = _make_noisy_build_stdout({ n_compiling: 50, n_warnings: 1, finished: true });
    const payload = _make_post_bash_payload("cargo check", stdout, { exit_code: 0 });
    const result = _call(payload);
    const msg = _cargo_msg(result);
    expect(msg).not.toBeNull();
    expect(msg as string).not.toContain("Compiling crate_");
  });

  // ------------------------------------------------------------------
  // Trailing newline preservation
  // ------------------------------------------------------------------

  it("test_trailing_newline_preserved", () => {
    const stdout = _make_noisy_build_stdout({ n_compiling: 55, with_trailing_newline: true });
    const payload = _make_post_bash_payload("cargo build", stdout, { exit_code: 0 });
    const result = _call(payload);
    const msg = _cargo_msg(result);
    // Either no compression (falls through) or compressed msg ends with \n
    if (msg !== null) {
      expect(msg.endsWith("\n") || msg.endsWith("]")).toBe(true);
    }
  });

  it("test_no_trailing_newline_when_stdout_bare", () => {
    const stdout = _make_noisy_build_stdout({ n_compiling: 55, with_trailing_newline: false });
    const payload = _make_post_bash_payload("cargo build", stdout, { exit_code: 0 });
    const result = _call(payload);
    const msg = _cargo_msg(result);
    if (msg !== null) {
      expect(msg).toContain("[token-goat] cargo:");
    }
  });

  // ------------------------------------------------------------------
  // Session / recall hint
  // ------------------------------------------------------------------

  it("test_no_session_no_recall_hint", () => {
    const stdout = _make_noisy_build_stdout({ n_compiling: 55 });
    const payload = _make_post_bash_payload("cargo build", stdout, { exit_code: 0, sid: null });
    const result = _call(payload);
    const msg = _cargo_msg(result);
    if (msg !== null) {
      expect(msg).not.toContain("bash-output");
    }
  });

  it("test_continue_true", () => {
    const stdout = _make_noisy_build_stdout({ n_compiling: 55 });
    const payload = _make_post_bash_payload("cargo build", stdout, { exit_code: 0 });
    const result = _call(payload);
    expect(result["continue"]).toBe(true);
  });

  // ------------------------------------------------------------------
  // clippy subcommand
  // ------------------------------------------------------------------

  it("test_clippy_warnings_compressed", () => {
    const stdout = _make_noisy_build_stdout({ n_compiling: 50, n_warnings: 2, finished: true });
    const payload = _make_post_bash_payload("cargo clippy", stdout, { exit_code: 0 });
    const result = _call(payload);
    const msg = _cargo_msg(result);
    expect(msg).not.toBeNull();
    expect(msg as string).toContain("2 warnings");
  });

  // ------------------------------------------------------------------
  // Bug 1: 3-digit line-number source annotations must not break continuation
  // ------------------------------------------------------------------

  it("test_three_digit_line_number_continuation_kept", () => {
    // Gutter lines after a 'NNN |' source annotation must be preserved.
    const lines: string[] = [];
    for (let i = 0; i < 50; i++) {
      lines.push(`   Compiling crate_${i} v0.1.${i} (/workspace)`);
    }
    lines.push(
      "error[E0308]: mismatched types",
      "   --> src/main.rs:105:13",
      "    |",
      '105 |     let x: i32 = "hello";',
      "    |             ^^^^^^^ expected `i32`, found `&str`",
      "    = note: expected type `i32`",
      "error: could not compile `myproject` due to 1 previous error",
    );
    const stdout = lines.join("\n") + "\n";
    const payload = _make_post_bash_payload("cargo build", stdout, { exit_code: 1 });
    const result = _call(payload);
    const msg = _cargo_msg(result);
    expect(msg).not.toBeNull();
    expect(msg as string).toContain("error[E0308]");
    expect(msg as string).toContain("105 |");
    expect(msg as string).toContain("^^^^^^^ expected");
    expect(msg as string).toContain("note: expected type");
  });

  // ------------------------------------------------------------------
  // Bug 2: exit_code=1 with no stdout diagnostics must fall through
  // ------------------------------------------------------------------

  it("test_exit_code_1_no_stdout_diagnostics_falls_through", () => {
    // Pure noise lines — no error[...]: or warning[...]: headers at all
    const lines: string[] = [];
    for (let i = 0; i < 50; i++) {
      lines.push(`   Compiling crate_${i} v0.1.${i} (/workspace)`);
    }
    lines.push("error: could not compile `myproject`");
    const stdout = lines.join("\n") + "\n";
    const payload = _make_post_bash_payload("cargo build", stdout, { exit_code: 1 });
    const result = _call(payload);
    const msg = _cargo_msg(result);
    expect(msg).toBeNull();
  });
});
