/**
 * CLI tests for the batch-I lifecycle commands (cli_lifecycle.ts): install,
 * uninstall, worker, context-stats. (`doctor` is deferred — needs cli_doctor.)
 *
 * The install/worker commands call into the install/worker_daemon modules,
 * which touch the real filesystem (settings.json, pid files, autostart). Tests
 * therefore `vi.spyOn` those module fns (called via `import * as` in
 * cli_lifecycle) to no-op fakes — the same pattern as the gdrive/cache tests.
 * `context-stats` runs the REAL cli_context_stats over a throwaway project.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import * as install_mod from "../src/token_goat/install.js";
import * as paths from "../src/token_goat/paths.js";
import * as worker_daemon from "../src/token_goat/worker_daemon.js";
import { invoke } from "./_cli_runner.js";

afterEach(() => {
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// install
// ---------------------------------------------------------------------------

describe("TestInstallCli", () => {
  it("check prints autostart info", async () => {
    vi.spyOn(install_mod, "check_autostart").mockReturnValue({
      status: "registered",
      command: "launchctl load ...",
      registered_interp: "/usr/local/bin/node",
      match: "YES",
      current_interp: "/usr/local/bin/node",
    });
    const result = await invoke(["install", "--check"]);
    expect(result.exit_code).toBe(0);
    expect(result.output).toContain("Autostart: registered");
    expect(result.output).toContain("Command: launchctl");
    expect(result.output).toContain("Match: YES");
  });

  it("check with no registered interp prints current interp", async () => {
    vi.spyOn(install_mod, "check_autostart").mockReturnValue({
      status: "not registered",
      command: null,
      registered_interp: null,
      match: "UNKNOWN",
      current_interp: "/usr/local/bin/node",
    });
    const result = await invoke(["install", "--check"]);
    expect(result.exit_code).toBe(0);
    expect(result.output).toContain("Current interpreter:");
  });

  it("dry-run prints the plan", async () => {
    vi.spyOn(install_mod, "plan_install").mockReturnValue([
      { component: "settings.json", target: "claude", action: "write", detail: "hooks added" },
      { component: "CLAUDE.md", target: "claude", action: "skip", detail: "" },
    ]);
    const result = await invoke(["install", "--dry-run"]);
    expect(result.exit_code).toBe(0);
    expect(result.output).toContain("no changes made");
    expect(result.output).toContain("settings.json: claude");
    expect(result.output).toContain("Re-run without --dry-run");
  });

  it("unknown --target exits 1", async () => {
    const result = await invoke(["install", "--target", "bogus"]);
    expect(result.exit_code).toBe(1);
    expect(result.output).toContain("Unknown --target value(s)");
  });

  it("full install renders status + result + codecs ok", async () => {
    vi.spyOn(install_mod, "check_status").mockReturnValue({
      claude: "installed",
      codex: "not installed",
    });
    vi.spyOn(install_mod, "install_all").mockReturnValue({
      "settings.json": "updated",
      watchdog: "started",
    });
    vi.spyOn(install_mod, "probe_image_codecs").mockReturnValue({
      ok: true,
      summary: "all present",
      missing: [],
      hint: "",
    });
    const result = await invoke(["install", "--target", "claude"]);
    expect(result.exit_code).toBe(0);
    expect(result.output).toContain("Current integration status");
    expect(result.output).toContain("[+] claude: installed");
    expect(result.output).toContain("settings.json: updated");
    expect(result.output).not.toContain("WARNING — image codecs");
    expect(result.output).toContain("All set.");
  });

  it("install warns when codecs incomplete", async () => {
    vi.spyOn(install_mod, "check_status").mockReturnValue({ claude: "not installed" });
    vi.spyOn(install_mod, "install_all").mockReturnValue({ done: "ok" });
    vi.spyOn(install_mod, "probe_image_codecs").mockReturnValue({
      ok: false,
      summary: "webp missing",
      missing: ["webp"],
      hint: "brew install webp",
    });
    const result = await invoke(["install"]);
    expect(result.exit_code).toBe(0);
    expect(result.output).toContain("WARNING — image codecs incomplete");
    expect(result.output).toContain("webp");
  });

  it("verify prints the verify rows", async () => {
    vi.spyOn(install_mod, "check_status").mockReturnValue({ claude: "installed" });
    vi.spyOn(install_mod, "install_all").mockReturnValue({ done: "ok" });
    vi.spyOn(install_mod, "probe_image_codecs").mockReturnValue({
      ok: true,
      summary: "",
      missing: [],
      hint: "",
    });
    vi.spyOn(install_mod, "verify_install").mockReturnValue([
      { component: "settings.json", target: "", action: "ok", detail: "present" },
      { component: "watchdog", target: "", action: "missing", detail: "not found" },
    ]);
    const result = await invoke(["install", "--verify"]);
    expect(result.exit_code).toBe(0);
    expect(result.output).toContain("Verifying install:");
    expect(result.output).toContain("[+] settings.json: present");
    expect(result.output).toContain("[-] watchdog: not found");
  });
});

// ---------------------------------------------------------------------------
// uninstall
// ---------------------------------------------------------------------------

describe("TestUninstallCli", () => {
  it("prints uninstall steps", async () => {
    vi.spyOn(install_mod, "uninstall_all").mockReturnValue({
      "settings.json": "cleaned",
      watchdog: "stopped",
    });
    const result = await invoke(["uninstall", "--codex"]);
    expect(result.exit_code).toBe(0);
    expect(result.output).toContain("token-goat uninstall:");
    expect(result.output).toContain("settings.json: cleaned");
  });
});

// ---------------------------------------------------------------------------
// worker
// ---------------------------------------------------------------------------

describe("TestWorkerCli", () => {
  it("kill-duplicate prints the result", async () => {
    vi.spyOn(worker_daemon, "kill_duplicate_daemon").mockReturnValue("killed pid 123");
    const result = await invoke(["worker", "--kill-duplicate"]);
    expect(result.exit_code).toBe(0);
    expect(result.output).toContain("killed pid 123");
  });

  it("status reports stopped when no pid", async () => {
    vi.spyOn(worker_daemon, "query_worker_status").mockReturnValue({
      running: false,
      pid: null,
      interpreter: null,
      started_at: null,
      pool_size: 4,
      autostart: null,
      autostart_active: null,
      last_log_line: "",
    });
    const result = await invoke(["worker", "--status"]);
    expect(result.exit_code).toBe(0);
    expect(result.output).toContain("Worker: stopped");
    expect(result.output).toContain("Pool size: 4");
  });

  it("check reports not-running when pid file absent", async () => {
    vi.spyOn(paths, "workerPidPath").mockReturnValue(
      path.join(os.tmpdir(), "tg-definitely-no-pid-" + process.pid),
    );
    const result = await invoke(["worker", "--check"]);
    expect(result.exit_code).toBe(0);
    expect(result.output).toContain("not running (no pid file)");
  });

  it("daemon exits 0 under TOKEN_GOAT_NO_WORKER_SPAWN (no spawn)", async () => {
    const spy = vi.spyOn(worker_daemon, "run_daemon").mockResolvedValue(undefined);
    const prev = process.env["TOKEN_GOAT_NO_WORKER_SPAWN"];
    process.env["TOKEN_GOAT_NO_WORKER_SPAWN"] = "1";
    try {
      const result = await invoke(["worker", "--daemon"]);
      expect(result.exit_code).toBe(0);
      expect(spy).not.toHaveBeenCalled();
    } finally {
      if (prev === undefined) delete process.env["TOKEN_GOAT_NO_WORKER_SPAWN"];
      else process.env["TOKEN_GOAT_NO_WORKER_SPAWN"] = prev;
    }
  });
});

// ---------------------------------------------------------------------------
// context-stats (real run over a throwaway project)
// ---------------------------------------------------------------------------

describe("TestContextStatsCli", () => {
  it("prints the context footprint header", async () => {
    const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "tg-ctxstats-")));
    const result = await invoke(["context-stats", "--project", tmp]);
    expect(result.exit_code).toBe(0);
    expect(result.output).toContain("Context footprint");
    expect(result.output).toContain("Window assumed");
    expect(result.output).toContain("System prompt (est.)");
  });

  it("json output is a valid object with the expected keys", async () => {
    const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "tg-ctxstats-")));
    const result = await invoke(["context-stats", "--project", tmp, "--json"]);
    expect(result.exit_code).toBe(0);
    const data = JSON.parse(result.output);
    expect(data).toHaveProperty("context_window");
    expect(data).toHaveProperty("system_prompt_est");
    expect(data).toHaveProperty("grand_total_est");
    expect(data).toHaveProperty("claude_md_files");
  });
});
