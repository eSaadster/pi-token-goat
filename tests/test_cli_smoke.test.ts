/**
 * Port of tests/test_cli_smoke.py — FOUNDATION subset.
 *
 * The foundation sub-run lands the commander app skeleton + the hook subapp +
 * `version`. Tests that assert command-listing completeness (`symbol`, `ref`,
 * `semantic`, `map` in --help), `doctor`, or the `semantic` output format are
 * DEFERRED until those command batches (A/B/I) land.
 *
 * Hook dispatch is exercised in-process: `safe_run` reads the payload from
 * `--input-file` (NOT stdin — a sync fd-0 read would hang vitest) and writes the
 * `{"continue": true}` response to process.stdout, captured by the CliRunner.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { invoke } from "./_cli_runner.js";

const _tmpRoots: string[] = [];

function tmpDir(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), `tg-cli-${process.pid}-${_tmpRoots.length}-`));
  _tmpRoots.push(d);
  return d;
}

afterEach(() => {
  vi.restoreAllMocks();
  while (_tmpRoots.length) {
    const d = _tmpRoots.pop()!;
    try {
      fs.rmSync(d, { recursive: true, force: true });
    } catch {
      // best-effort
    }
  }
});

// ---------------------------------------------------------------------------
// Root --version / -V / version subcommand / hook --help
// ---------------------------------------------------------------------------

describe("cli smoke (foundation)", () => {
  it("test_cli_version_flag", async () => {
    const r = await invoke(["--version"]);
    expect(r.exit_code).toBe(0);
    expect(r.stdout).toContain("token-goat");
    expect(/\d/.test(r.stdout)).toBe(true);
  });

  it("test_cli_version_short_flag", async () => {
    const r = await invoke(["-V"]);
    expect(r.exit_code).toBe(0);
    expect(r.stdout).toContain("token-goat");
  });

  it("test_hook_help_runs", async () => {
    const r = await invoke(["hook", "--help"]);
    expect(r.exit_code).toBe(0);
    expect(r.stdout).toContain("session-start");
  });

  it("test_version_subcommand", async () => {
    const r = await invoke(["version"]);
    expect(r.exit_code).toBe(0);
    expect(/\d/.test(r.stdout)).toBe(true);
  });

  it("test_version_subcommand_json", async () => {
    const r = await invoke(["version", "--json"]);
    expect(r.exit_code).toBe(0);
    const data = JSON.parse(r.stdout.trim()) as { version: string };
    expect(typeof data.version).toBe("string");
    expect(data.version.length).toBeGreaterThan(0);
  });

  it.skip("test_cli_help_runs", () => {
    // PORT: deferred — asserts symbol/ref/semantic/map appear in --help; those
    // commands land in batches A/B. Un-skip once they are registered.
  });

  it.skip("test_doctor_command_runs", () => {
    // PORT: deferred — `doctor` lands with batch I (cli_doctor port).
  });

  it.skip("semantic --compact / --full output format tests", () => {
    // PORT: deferred — the `semantic` command lands with batch A.
  });
});

// ---------------------------------------------------------------------------
// Hook dispatch (port of test_cli_hook_smoke.py, in-process via --input-file)
// ---------------------------------------------------------------------------

describe("cli hook dispatch (foundation)", () => {
  function writePayload(obj: unknown): string {
    const dir = tmpDir();
    const p = path.join(dir, "payload.json");
    fs.writeFileSync(p, JSON.stringify(obj), "utf8");
    return p;
  }

  it("test_hook_session_start_smoke", async () => {
    const dir = tmpDir();
    fs.mkdirSync(path.join(dir, ".git"), { recursive: true });
    const p = path.join(dir, "payload.json");
    fs.writeFileSync(p, JSON.stringify({ session_id: "smoke", cwd: dir }), "utf8");
    const r = await invoke(["hook", "session-start", "--input-file", p]);
    expect(r.exit_code).toBe(0);
    const parsed = JSON.parse(r.stdout.trim()) as { continue?: boolean };
    expect(parsed.continue).toBe(true);
  });

  it("test_hook_pre_read_smoke", async () => {
    const p = writePayload({ session_id: "s", tool_name: "Read", tool_input: { file_path: "x" } });
    const r = await invoke(["hook", "pre-read", "--input-file", p]);
    expect(r.exit_code).toBe(0);
    const parsed = JSON.parse(r.stdout.trim()) as { continue?: boolean };
    expect(parsed.continue).toBe(true);
  });

  it("test_hook_garbage_input_returns_continue", async () => {
    // Even if the payload is malformed JSON, the CLI must not crash.
    const dir = tmpDir();
    const p = path.join(dir, "bad.json");
    fs.writeFileSync(p, "not valid json {{", "utf8");
    const r = await invoke(["hook", "session-start", "--input-file", p]);
    expect(r.exit_code).toBe(0);
    const parsed = JSON.parse(r.stdout.trim()) as { continue?: boolean };
    expect(parsed.continue).toBe(true);
  });

  it("test_hook_tolerates_unknown_options_and_extra_args", async () => {
    // context_settings = {ignore_unknown_options, allow_extra_args}: a harness
    // passing version-specific flags/positional args must not abort the hook.
    const p = writePayload({ session_id: "s", tool_name: "Read", tool_input: { file_path: "x" } });
    const r = await invoke([
      "hook",
      "pre-read",
      "--input-file",
      p,
      "--codex-only-flag",
      "value",
      "extra-positional",
    ]);
    expect(r.exit_code).toBe(0);
    const parsed = JSON.parse(r.stdout.trim()) as { continue?: boolean };
    expect(parsed.continue).toBe(true);
  });
});
