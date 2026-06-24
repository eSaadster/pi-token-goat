/**
 * Smoke tests for the `compress` command (cli_compress.cmd_compress →
 * bash_runner.run). These exercise the command end-to-end through the in-process
 * CLI harness, spawning REAL subprocesses (echo / exit) under the system shell —
 * so they assert exit codes and safe output substrings, not brittle exact bytes.
 *
 * Notes:
 *  - The default (compress) path captures the child's output and re-emits it via
 *    bash_runner's write_stdout = process.stdout.write, which the invoke harness
 *    DOES spy → stdout is observable.
 *  - The --no-compress path streams raw via spawnSync(stdio:"inherit"), writing
 *    to the real stdout/stderr fds that the harness's process.stdout.write spy
 *    does NOT intercept → only the exit code is observable there.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import { invoke } from "./_cli_runner.js";

describe("TestCompressCli", () => {
  afterEach(() => vi.restoreAllMocks());

  it("test_compress_filter_path_emits_output", async () => {
    // No --no-compress: bash_runner.run captures + compresses + writes via
    // process.stdout.write (captured). Output carries the command's text.
    const r = await invoke(["compress", "--cmd", "echo hello-compressed"]);
    expect(r.exit_code).toBe(0);
    expect(r.stdout).toContain("hello-compressed");
  });

  it("test_compress_no_compress_streams_and_exits_zero", async () => {
    // --no-compress streams raw via spawnSync(stdio:"inherit"); the child's
    // output goes to the real fds (not the harness spy), so assert only the
    // exit code surfaces cleanly.
    const r = await invoke(["compress", "--cmd", "echo hello-compress", "--no-compress"]);
    expect(r.exit_code).toBe(0);
  });

  it("test_compress_surfaces_wrapped_exit_code", async () => {
    // The wrapped command's exit code is the compress command's exit code.
    const r = await invoke(["compress", "--cmd", "exit 7"]);
    expect(r.exit_code).toBe(7);
  });
});
