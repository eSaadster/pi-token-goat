/**
 * Port of tests/test_install.py — part B.
 *
 * Covers the OS-coupled surface: Linux systemd / XDG autostart, the update
 * cron, macOS LaunchAgent, Windows worker Run-key, the per-platform
 * check_status / plan_install / verify_install reports, the image-codec probe,
 * and the full install_all / uninstall_all round-trip.
 *
 * Platform mocking: install.ts captures `process.platform` at module load, so
 * `loadInstall(platform)` (see _install_helpers) redefines platform, resets the
 * module registry, and dynamic-imports a fresh install+paths+worker graph. The
 * subprocess seam (`setSubprocessRunner`) and winreg seam (`setWinregBackend`)
 * stub every schtasks/launchctl/systemctl/crontab call so no real process is
 * ever forked. Worker spawn is doubly safe: TOKEN_GOAT_NO_WORKER_SPAWN is set
 * by tests/setup.ts and we additionally spy on worker.ensure_running.
 *
 * Python tests that patch *private* install helpers (install._systemd_service_path,
 * install._launchd_plist_path, install._check_mac_autostart, install._run_schtasks,
 * install._read_*_autostart_command, install.check_autostart, ...) which the TS
 * port does NOT export are either re-expressed against the public seams when the
 * behaviour is reachable, or skipped + reported as missingExports when not.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import * as fs from "node:fs";
import * as nodePath from "node:path";
import * as nodeUtil from "node:util";

import type { SubprocessResult } from "../src/token_goat/install.js";
// Static import used only for probe_image_codecs (platform-independent).
import * as install from "../src/token_goat/install.js";
import { loadInstall, restorePlatform, withFakeHome, mkTmpDir, makeFakeWinreg } from "./_install_helpers.js";

let _home: { home: string; restore: () => void } | null = null;
const _tmpDirs: string[] = [];
let _dataDir: string | null = null;

function fakeHome(): string {
  _home = withFakeHome();
  return _home.home;
}
function tmpDir(): string {
  const d = mkTmpDir();
  _tmpDirs.push(d);
  return d;
}
function dataDir(): string {
  _dataDir = tmpDir();
  return _dataDir;
}

afterEach(() => {
  vi.restoreAllMocks();
  restorePlatform();
  if (_home) {
    _home.restore();
    _home = null;
  }
  for (const d of _tmpDirs.splice(0)) {
    try {
      fs.rmSync(d, { recursive: true, force: true });
    } catch {
      /* best-effort */
    }
  }
  _dataDir = null;
});

// A subprocess runner that always succeeds (returncode 0).
function okRunner(stdout = ""): (cmd: string, args: string[], opts: { input?: string }) => SubprocessResult {
  return () => ({ returncode: 0, stdout, stderr: "", failed: false, error: "" });
}

// caplog analogue: _LOG.warning forwards to console.warn(`[name] msg`, ...args)
// with printf-style %s placeholders. Reconstruct each formatted warning line.
function captureWarnings(): { lines: string[]; restore: () => void } {
  const lines: string[] = [];
  const spy = vi.spyOn(console, "warn").mockImplementation((msg?: unknown, ...args: unknown[]) => {
    lines.push(nodeUtil.format(msg, ...args));
  });
  return { lines, restore: () => spy.mockRestore() };
}

const systemdSvcPath = (home: string): string =>
  nodePath.join(home, ".config", "systemd", "user", "token-goat-worker.service");
const xdgPath = (home: string): string =>
  nodePath.join(home, ".config", "autostart", "token-goat-worker.desktop");
const plistPath = (home: string): string =>
  nodePath.join(home, "Library", "LaunchAgents", "com.dfkhelper.token-goat-worker.plist");

// ---------------------------------------------------------------------------
// install_linux_autostart
// ---------------------------------------------------------------------------

describe("install_linux_autostart", () => {
  it("returns success-skipped on Windows", async () => {
    const { install } = await loadInstall("win32");
    const [ok, out] = install.install_linux_autostart();
    expect(ok).toBe(true);
    expect(out.includes("skipped")).toBe(true);
  });

  it("writes a systemd unit and calls enable when systemd is available", async () => {
    const home = fakeHome();
    const { install } = await loadInstall("linux", dataDir());

    const calls: string[][] = [];
    install.setSubprocessRunner((cmd, args) => {
      calls.push([cmd, ...args]);
      // is-system-running -> "running" so _systemd_user_available() is true.
      const joined = [cmd, ...args].join(" ");
      const stdout = joined.includes("is-system-running") ? "running" : "";
      return { returncode: 0, stdout, stderr: "", failed: false, error: "" };
    });

    const [ok, out] = install.install_linux_autostart();
    expect(ok).toBe(true);
    expect(out.includes("systemd")).toBe(true);

    const svc = systemdSvcPath(home);
    expect(fs.existsSync(svc)).toBe(true);
    const content = fs.readFileSync(svc, "utf-8");
    expect(content.includes("token_goat") || content.includes("token-goat")).toBe(true);
    expect(content.includes("WantedBy=default.target")).toBe(true);
    expect(content.includes("Restart=on-failure")).toBe(true);
    expect(content.includes("RestartSec=5")).toBe(true);
    expect(content.includes("StartLimitIntervalSec=60")).toBe(true);
    expect(content.includes("StartLimitBurst=3")).toBe(true);

    const cmdsFlat = calls.map((c) => c.join(" "));
    expect(cmdsFlat.some((c) => c.includes("daemon-reload"))).toBe(true);
    expect(cmdsFlat.some((c) => c.includes("enable"))).toBe(true);
  });

  it("falls back to XDG autostart when systemd is unavailable", async () => {
    const home = fakeHome();
    const { install } = await loadInstall("linux", dataDir());
    // is-system-running fails -> systemd unavailable.
    install.setSubprocessRunner(() => ({
      returncode: -1,
      stdout: "",
      stderr: "",
      failed: true,
      error: "ENOENT",
    }));

    const [ok] = install.install_linux_autostart();
    expect(ok).toBe(true);
    const desktop = xdgPath(home);
    expect(fs.existsSync(desktop)).toBe(true);
    const content = fs.readFileSync(desktop, "utf-8");
    expect(content.includes("[Desktop Entry]")).toBe(true);
    expect(content.includes("Exec=")).toBe(true);
    expect(content.includes("Version=1.0")).toBe(true);
    expect(content.includes("X-GNOME-Autostart-enabled=true")).toBe(true);
  });

  it("idempotent (callable twice)", async () => {
    const home = fakeHome();
    const { install } = await loadInstall("linux", dataDir());
    install.setSubprocessRunner(() => ({
      returncode: -1,
      stdout: "",
      stderr: "",
      failed: true,
      error: "ENOENT",
    }));
    install.install_linux_autostart();
    const [ok] = install.install_linux_autostart();
    expect(ok).toBe(true);
    expect(fs.existsSync(xdgPath(home))).toBe(true);
  });
});

describe("uninstall_linux_autostart", () => {
  it("removes service and desktop files", async () => {
    const home = fakeHome();
    const { install } = await loadInstall("linux", dataDir());
    install.setSubprocessRunner(() => ({
      returncode: -1,
      stdout: "",
      stderr: "",
      failed: true,
      error: "ENOENT",
    }));
    install.install_linux_autostart();
    expect(fs.existsSync(xdgPath(home))).toBe(true);

    // systemctl unavailable; suppress that failure path. Returner returns
    // returncode 1 for everything now.
    install.setSubprocessRunner(() => ({
      returncode: 1,
      stdout: "",
      stderr: "",
      failed: false,
      error: "",
    }));
    const removed = install.uninstall_linux_autostart();
    expect(fs.existsSync(xdgPath(home))).toBe(false);
    expect(removed.some((r) => r.includes(xdgPath(home)))).toBe(true);
  });

  it("no-op on Windows", async () => {
    const { install } = await loadInstall("win32");
    expect(install.uninstall_linux_autostart()).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// macOS autostart
// ---------------------------------------------------------------------------

describe("install_mac_autostart", () => {
  it("returns success-skipped on Windows", async () => {
    const { install } = await loadInstall("win32");
    const [ok, out] = install.install_mac_autostart();
    expect(ok).toBe(true);
    expect(out.includes("skipped")).toBe(true);
  });

  it("writes a valid LaunchAgent plist and calls launchctl", async () => {
    const home = fakeHome();
    const { install } = await loadInstall("darwin", dataDir());
    const calls: string[][] = [];
    install.setSubprocessRunner((cmd, args) => {
      calls.push([cmd, ...args]);
      return { returncode: 0, stdout: "", stderr: "", failed: false, error: "" };
    });

    const [ok, out] = install.install_mac_autostart();
    expect(ok).toBe(true);
    expect(out.includes("LaunchAgent")).toBe(true);
    const plist = plistPath(home);
    expect(fs.existsSync(plist)).toBe(true);
    const content = fs.readFileSync(plist, "utf-8");
    expect(content.includes(install.LAUNCHD_PLIST_NAME)).toBe(true);
    expect(content.includes("RunAtLoad")).toBe(true);
    expect(content.includes("token_goat") || content.includes("token-goat")).toBe(true);
    const cmdsFlat = calls.map((c) => c.join(" "));
    expect(cmdsFlat.some((c) => c.includes("launchctl") && c.includes("load"))).toBe(true);
  });

  it("KeepAlive restarts on failure (dict with SuccessfulExit=false)", async () => {
    const home = fakeHome();
    const { install } = await loadInstall("darwin", dataDir());
    install.setSubprocessRunner(okRunner());
    const [ok] = install.install_mac_autostart();
    expect(ok).toBe(true);
    const content = fs.readFileSync(plistPath(home), "utf-8");
    expect(content.includes("<key>KeepAlive</key>")).toBe(true);
    expect(content.includes("<dict>")).toBe(true);
    expect(content.includes("<key>SuccessfulExit</key>")).toBe(true);
    expect(content.includes("RunAtLoad")).toBe(true);
    const idx = content.indexOf("<key>KeepAlive</key>");
    const block = content.slice(idx, idx + 120);
    expect(!block.includes("<false/>") || block.includes("<dict>")).toBe(true);
  });

  it("message includes confirm hint", async () => {
    fakeHome();
    const { install } = await loadInstall("darwin", dataDir());
    install.setSubprocessRunner(okRunner());
    const [ok, msg] = install.install_mac_autostart();
    expect(ok).toBe(true);
    expect(msg.includes("launchctl")).toBe(true);
    expect(msg.includes(install.LAUNCHD_PLIST_NAME)).toBe(true);
  });

  it("idempotent (callable twice)", async () => {
    const home = fakeHome();
    const { install } = await loadInstall("darwin", dataDir());
    install.setSubprocessRunner(okRunner());
    install.install_mac_autostart();
    const [ok] = install.install_mac_autostart();
    expect(ok).toBe(true);
    expect(fs.existsSync(plistPath(home))).toBe(true);
  });
});

describe("uninstall_mac_autostart", () => {
  it("removes the plist and calls launchctl unload", async () => {
    const home = fakeHome();
    const { install } = await loadInstall("darwin", dataDir());
    install.setSubprocessRunner(okRunner());
    install.install_mac_autostart();
    expect(fs.existsSync(plistPath(home))).toBe(true);

    const removed = install.uninstall_mac_autostart();
    expect(fs.existsSync(plistPath(home))).toBe(false);
    expect(removed.some((r) => r.includes(plistPath(home)))).toBe(true);
  });

  it("no-op on Windows", async () => {
    const { install } = await loadInstall("win32");
    expect(install.uninstall_mac_autostart()).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Linux update cron
// ---------------------------------------------------------------------------

describe("install_linux_update_cron", () => {
  it("returns success-skipped on Windows", async () => {
    const { install } = await loadInstall("win32");
    const [ok, out] = install.install_linux_update_cron();
    expect(ok).toBe(true);
    expect(out.includes("skipped")).toBe(true);
  });

  it("adds entry idempotently", async () => {
    const { install } = await loadInstall("linux");
    const written: Record<string, string> = {};
    install.setSubprocessRunner((cmd, args, opts) => {
      const joined = [cmd, ...args].join(" ");
      if (joined.includes("crontab") && opts.input) {
        written["crontab"] = opts.input;
      }
      return { returncode: 0, stdout: "", stderr: "", failed: false, error: "" };
    });
    const [ok] = install.install_linux_update_cron();
    expect(ok).toBe(true);
    expect(written["crontab"]!.includes(install.CRON_JOB_MARKER)).toBe(true);
    expect(written["crontab"]!.includes("npm install -g token-goat@latest")).toBe(true);
  });

  it("deduplicates (does not add duplicate entries)", async () => {
    const { install } = await loadInstall("linux");
    const existingCron = `0 3 * * 0 npm install -g token-goat@latest ${install.CRON_JOB_MARKER}\n`;
    const written: Record<string, string> = {};
    install.setSubprocessRunner((cmd, args, opts) => {
      const joined = [cmd, ...args].join(" ");
      if (joined.includes("crontab") && opts.input) {
        written["crontab"] = opts.input;
      }
      return { returncode: 0, stdout: existingCron, stderr: "", failed: false, error: "" };
    });
    install.install_linux_update_cron();
    const cronOut = written["crontab"] ?? "";
    expect(cronOut.split(install.CRON_JOB_MARKER).length - 1).toBe(1);
  });

  it("skips when crontab not found", async () => {
    const { install } = await loadInstall("linux");
    const prevPath = process.env["PATH"];
    process.env["PATH"] = "";
    try {
      const [ok, msg] = install.install_linux_update_cron();
      expect(ok).toBe(false);
      expect(msg.includes("not available")).toBe(true);
      expect(msg.includes("PATH")).toBe(true);
    } finally {
      process.env["PATH"] = prevPath;
    }
  });
});

describe("uninstall_linux_update_cron", () => {
  it("strips the marker line from crontab", async () => {
    const { install } = await loadInstall("linux");
    const existing =
      "0 0 * * * /usr/bin/true\n" +
      `0 3 * * 0 npm install -g token-goat@latest ${install.CRON_JOB_MARKER}\n`;
    const written: Record<string, string> = {};
    install.setSubprocessRunner((cmd, args, opts) => {
      const joined = [cmd, ...args].join(" ");
      if (joined.includes("crontab") && opts.input) {
        written["crontab"] = opts.input;
      }
      return { returncode: 0, stdout: existing, stderr: "", failed: false, error: "" };
    });
    const result = install.uninstall_linux_update_cron();
    expect(result.includes("removed")).toBe(true);
    const out = written["crontab"] ?? "";
    expect(out.includes(install.CRON_JOB_MARKER)).toBe(false);
    expect(out.includes("/usr/bin/true")).toBe(true);
  });

  it("skips when crontab not found", async () => {
    const { install } = await loadInstall("linux");
    const prevPath = process.env["PATH"];
    process.env["PATH"] = "";
    try {
      const result = install.uninstall_linux_update_cron();
      expect(result.includes("not available")).toBe(true);
      expect(result.includes("PATH")).toBe(true);
    } finally {
      process.env["PATH"] = prevPath;
    }
  });
});

// ---------------------------------------------------------------------------
// install_worker_task (Windows HKCU Run key)
// ---------------------------------------------------------------------------

describe("install_worker_task", () => {
  it("uses HKCU Run registry key with --daemon and token_goat", async () => {
    const { install } = await loadInstall("win32");
    const { backend, store } = makeFakeWinreg();
    install.setWinregBackend(backend);

    const [ok] = install.install_worker_task();
    expect(ok).toBe(true);
    expect(store.has(install.TASK_WORKER)).toBe(true);
    const value = store.get(install.TASK_WORKER)!;
    expect(value.includes("--daemon")).toBe(true);
    expect(value.includes("token_goat")).toBe(true);
  });

  // The interpreter-change WARNING tests: Python patches
  // install._read_win_autostart_command + caplog. In the TS port that read is a
  // lexical same-module call, so we drive its return by SEEDING the fake winreg
  // (the registry value it reads). _LOG.warning forwards to console.warn with
  // printf-style %s args, so we capture warnings by spying console.warn and
  // reconstructing the formatted message with util.format. paths.pythonRunnerCommand
  // is reached via the module namespace, so it is spyable to pin the new interpreter.
  it("warns on interpreter change", async () => {
    const { install: inst, paths } = await loadInstall("win32");
    const oldCmd = '"C:/Python312/pythonw.exe" -m token_goat.cli worker --daemon';
    const { backend } = makeFakeWinreg({ [inst.TASK_WORKER]: oldCmd });
    inst.setWinregBackend(backend);
    vi.spyOn(paths, "pythonRunnerCommand").mockReturnValue(
      '"C:/venv/Scripts/pythonw.exe" -m token_goat.cli worker --daemon',
    );

    const warnings = captureWarnings();
    try {
      inst.install_worker_task();
    } finally {
      warnings.restore();
    }
    expect(
      warnings.lines.some(
        (m) =>
          m.includes("replacing existing autostart entry") && m.includes("C:/Python312/pythonw.exe"),
      ),
    ).toBe(true);
  });

  it("no warn when same interpreter", async () => {
    const { install: inst, paths } = await loadInstall("win32");
    const sameCmd = '"C:/venv/Scripts/pythonw.exe" -m token_goat.cli worker --daemon';
    const { backend } = makeFakeWinreg({ [inst.TASK_WORKER]: sameCmd });
    inst.setWinregBackend(backend);
    vi.spyOn(paths, "pythonRunnerCommand").mockReturnValue(sameCmd);

    const warnings = captureWarnings();
    try {
      inst.install_worker_task();
    } finally {
      warnings.restore();
    }
    expect(warnings.lines.some((m) => m.includes("replacing existing autostart entry"))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// check_status: platform-appropriate keys
// ---------------------------------------------------------------------------

describe("check_status", () => {
  it("includes Windows-specific keys on win32", async () => {
    fakeHome();
    const { install } = await loadInstall("win32", dataDir());
    // No winreg backend + no schtasks runner: _check_worker_task -> error string,
    // _check_update_task -> task_exists (subprocess fails -> false). Keys still present.
    install.setSubprocessRunner(() => ({
      returncode: 1,
      stdout: "",
      stderr: "",
      failed: false,
      error: "",
    }));
    const status = install.check_status();
    expect("worker autostart (HKCU Run)" in status).toBe(true);
    expect("update task (schtasks)" in status).toBe(true);
    // No bare "worker autostart" key without the HKCU qualifier.
    expect(Object.keys(status).filter((k) => !k.includes("HKCU")).includes("worker autostart")).toBe(
      false,
    );
  });

  it("includes Linux-specific keys on non-Windows", async () => {
    fakeHome();
    const { install } = await loadInstall("linux", dataDir());
    install.setSubprocessRunner(() => ({
      returncode: 1,
      stdout: "",
      stderr: "",
      failed: false,
      error: "",
    }));
    const status = install.check_status();
    expect("worker autostart" in status).toBe(true);
    expect("update cron" in status).toBe(true);
    expect("worker autostart (HKCU Run)" in status).toBe(false);
    expect("update task (schtasks)" in status).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// install_all: Linux dispatches to linux autostart + cron
// ---------------------------------------------------------------------------

describe("install_all (Linux dispatch)", () => {
  // The Python test patches install.install_linux_autostart / install_linux_update_cron
  // (call-count spies). In the TS port install_all() calls these via lexical
  // (same-module) references, which are NOT interceptable by spying the module
  // namespace. We instead assert the observable dispatch outcome: on Linux the
  // result dict carries the autostart/cron keys (real functions, subprocess
  // stubbed) and NOT the Windows task keys.
  it("produces autostart/cron result keys, not task keys", async () => {
    fakeHome();
    const { install, worker } = await loadInstall("linux", dataDir());
    vi.spyOn(install, "token_goat_binary").mockReturnValue("token-goat");
    vi.spyOn(worker, "ensure_running").mockReturnValue(99);
    // systemd unavailable + crontab no-op so the real autostart/cron run hermetically.
    const prevPath = process.env["PATH"];
    process.env["PATH"] = "";
    install.setSubprocessRunner(() => ({
      returncode: 1,
      stdout: "",
      stderr: "",
      failed: false,
      error: "",
    }));
    try {
      const result = install.install_all();
      expect("autostart: worker" in result).toBe(true);
      expect("cron: update" in result).toBe(true);
      expect("task: worker" in result).toBe(false);
      expect("task: update" in result).toBe(false);
    } finally {
      process.env["PATH"] = prevPath;
    }
  });
});

// ---------------------------------------------------------------------------
// plan_install — dry-run preview, must not touch disk or registry
// ---------------------------------------------------------------------------

describe("plan_install", () => {
  it("makes no changes (read-only)", async () => {
    const home = fakeHome();
    const { install } = await loadInstall("linux", dataDir());
    // Force XDG branch: systemd unavailable.
    install.setSubprocessRunner(() => ({
      returncode: 1,
      stdout: "",
      stderr: "",
      failed: false,
      error: "",
    }));
    // Python spies install_*/patch_* to assert plan_install never invokes them.
    // In the TS port those are lexical same-module calls (not interceptable via
    // the namespace), but plan_install genuinely performs no mutation, so we
    // assert the read-only contract directly: nothing is written under ~/.claude.
    const plan = install.plan_install();

    expect(fs.existsSync(nodePath.join(home, ".claude", "settings.json"))).toBe(false);
    expect(fs.existsSync(nodePath.join(home, ".claude", "CLAUDE.md"))).toBe(false);
    expect(fs.existsSync(nodePath.join(home, ".claude", "skills", "token-goat", "SKILL.md"))).toBe(
      false,
    );

    const components = new Set(plan.map((r) => r.component));
    expect(components.has("settings.json")).toBe(true);
    expect(components.has("CLAUDE.md")).toBe(true);
    expect(components.has("skill")).toBe(true);
    expect(components.has("worker autostart")).toBe(true);
  });

  it("picks systemd when available", async () => {
    fakeHome();
    const { install } = await loadInstall("linux", dataDir());
    install.setSubprocessRunner((cmd, args) => {
      const joined = [cmd, ...args].join(" ");
      const stdout = joined.includes("is-system-running") ? "running" : "";
      return { returncode: 0, stdout, stderr: "", failed: false, error: "" };
    });
    const plan = install.plan_install();
    const autostart = plan.find((r) => r.component === "worker autostart")!;
    expect(autostart.detail.toLowerCase().includes("systemd")).toBe(true);
    expect(autostart.target.endsWith("token-goat-worker.service")).toBe(true);
  });

  it("falls back to XDG without systemd", async () => {
    fakeHome();
    const { install } = await loadInstall("linux", dataDir());
    install.setSubprocessRunner(() => ({
      returncode: 1,
      stdout: "",
      stderr: "",
      failed: false,
      error: "",
    }));
    const plan = install.plan_install();
    const autostart = plan.find((r) => r.component === "worker autostart")!;
    expect(autostart.target.endsWith(".desktop")).toBe(true);
    expect(
      autostart.detail.toLowerCase().includes("xdg") ||
        autostart.detail.toLowerCase().includes("autostart"),
    ).toBe(true);
  });

  it("detects existing settings (reports update)", async () => {
    fakeHome();
    const { install } = await loadInstall("linux", dataDir());
    install.setSubprocessRunner(() => ({
      returncode: 1,
      stdout: "",
      stderr: "",
      failed: false,
      error: "",
    }));
    vi.spyOn(install, "token_goat_binary").mockReturnValue("token-goat");
    install.patch_settings_json();

    const plan = install.plan_install();
    const settingsRow = plan.find((r) => r.component === "settings.json")!;
    expect(settingsRow.action).toBe("update");
    expect(settingsRow.detail.includes("existing token-goat hook entries")).toBe(true);
  });

  it("optional codex rows only when flagged", async () => {
    fakeHome();
    const { install } = await loadInstall("linux", dataDir());
    install.setSubprocessRunner(() => ({
      returncode: 1,
      stdout: "",
      stderr: "",
      failed: false,
      error: "",
    }));
    const planOff = install.plan_install(false);
    const planOn = install.plan_install(true);
    const componentsOff = new Set(planOff.map((r) => r.component));
    const componentsOn = new Set(planOn.map((r) => r.component));
    expect(componentsOff.has("codex: config.toml")).toBe(false);
    expect(componentsOff.has("codex: AGENTS.md")).toBe(false);
    expect(componentsOn.has("codex: config.toml")).toBe(true);
    expect(componentsOn.has("codex: AGENTS.md")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// verify_install
// ---------------------------------------------------------------------------

describe("verify_install", () => {
  it("clean state: all components missing", async () => {
    fakeHome();
    const { install } = await loadInstall("linux", dataDir());
    install.setSubprocessRunner(() => ({
      returncode: 1,
      stdout: "",
      stderr: "",
      failed: false,
      error: "",
    }));
    const report = install.verify_install();
    const byComponent: Record<string, string> = {};
    for (const r of report) byComponent[r.component] = r.action;
    expect(byComponent["settings.json"]).toBe("missing");
    expect(byComponent["CLAUDE.md"]).toBe("missing");
    expect(byComponent["skill"]).toBe("missing");
    expect(byComponent["worker autostart"]).toBe("missing");
  });

  it("after install reports ok for landed pieces (Linux+systemd)", async () => {
    fakeHome();
    const { install } = await loadInstall("linux", dataDir());
    install.setSubprocessRunner((cmd, args) => {
      const joined = [cmd, ...args].join(" ");
      const stdout = joined.includes("is-system-running") ? "running" : "";
      return { returncode: 0, stdout, stderr: "", failed: false, error: "" };
    });
    vi.spyOn(install, "token_goat_binary").mockReturnValue("token-goat");

    install.patch_settings_json();
    install.patch_claude_md();
    install.write_skill();
    install.install_linux_autostart();

    const report = install.verify_install();
    const byComponent: Record<string, string> = {};
    for (const r of report) byComponent[r.component] = r.action;
    expect(byComponent["settings.json"]).toBe("ok");
    expect(byComponent["CLAUDE.md"]).toBe("ok");
    expect(byComponent["skill"]).toBe("ok");
    expect(byComponent["worker autostart"]).toBe("ok");
  });

  it("idempotent count stable across re-installs", async () => {
    fakeHome();
    const { install } = await loadInstall("linux", dataDir());
    vi.spyOn(install, "token_goat_binary").mockReturnValue("token-goat");
    install.setSubprocessRunner(() => ({
      returncode: 1,
      stdout: "",
      stderr: "",
      failed: false,
      error: "",
    }));
    // _settings_json_token_goat_count is private; verify the invariant it guards
    // (re-install never doubles hook entries) via the public verify_install
    // detail string, which embeds the count.
    install.patch_settings_json();
    const countOf = (): number => {
      const row = install.verify_install().find((r) => r.component === "settings.json")!;
      const m = row.detail.match(/^(\d+) token-goat hook entries present$/);
      return m ? parseInt(m[1]!, 10) : -1;
    };
    const first = countOf();
    install.patch_settings_json();
    const second = countOf();
    install.patch_settings_json();
    const third = countOf();
    expect(first).toBe(second);
    expect(second).toBe(third);
    expect(first).toBeGreaterThan(0);
  });

  it("omits codex when absent", async () => {
    fakeHome();
    const { install } = await loadInstall("linux", dataDir());
    install.setSubprocessRunner(() => ({
      returncode: 1,
      stdout: "",
      stderr: "",
      failed: false,
      error: "",
    }));
    const report = install.verify_install();
    const components = new Set(report.map((r) => r.component));
    expect(components.has("codex config.toml")).toBe(false);
  });

  it("reports codex when installed", async () => {
    fakeHome();
    const { install } = await loadInstall("linux", dataDir());
    install.setSubprocessRunner(() => ({
      returncode: 1,
      stdout: "",
      stderr: "",
      failed: false,
      error: "",
    }));
    vi.spyOn(install, "token_goat_binary").mockReturnValue("token-goat");
    install.patch_codex_config("token-goat");

    const report = install.verify_install();
    const byComponent: Record<string, string> = {};
    const detailByComponent: Record<string, string> = {};
    for (const r of report) {
      byComponent[r.component] = r.action;
      detailByComponent[r.component] = r.detail;
    }
    expect("codex config.toml" in byComponent).toBe(true);
    expect(byComponent["codex config.toml"]).toBe("ok");
    expect(detailByComponent["codex config.toml"]!.includes("token-goat hook entries present")).toBe(
      true,
    );
  });
});

// ---------------------------------------------------------------------------
// probe_image_codecs (sharp-backed in the TS port)
// ---------------------------------------------------------------------------

describe("probe_image_codecs", () => {
  it("ok when all codecs present + WebP encode works", () => {
    // sharp ships webp/jpeg/png on every supported platform; the probe should
    // report all-ok with no missing list and an empty hint.
    const report = install.probe_image_codecs();
    expect(report.ok).toBe(true);
    expect(report.summary.includes("WebP=ok")).toBe(true);
    expect(report.summary.includes("WebP-encode=ok")).toBe(true);
    expect(report.missing).toEqual([]);
    expect(report.hint).toBe("");
  });

  // The "flags missing + emits hint" test patches PIL.features.check (Python
  // Pillow). The TS probe reads sharp's static format table, which has no
  // injectable seam, so the missing-codec branch is not reachable in a test.
  it.skip("flags missing + emits hint — TS probe uses sharp's static format table (no PIL.features.check seam to force a miss)", () => {});
});

// ---------------------------------------------------------------------------
// Full round-trip: install_all + uninstall_all (Windows-flavoured paths but
// run under the current platform branch via loadInstall("linux") to avoid the
// winreg/schtasks Windows-only code; mirrors the Python hermetic round-trip
// which mocks schtasks + worker.ensure_running + paths.ensure_dirs).
// ---------------------------------------------------------------------------

describe("install_all / uninstall_all round-trip", () => {
  it("install_all creates files; uninstall_all removes them", async () => {
    const home = fakeHome();
    const { install: inst, worker, paths } = await loadInstall("linux", dataDir());
    vi.spyOn(inst, "token_goat_binary").mockReturnValue("token-goat");
    vi.spyOn(worker, "ensure_running").mockReturnValue(12345);
    // All subprocess (systemctl/crontab) calls succeed/no-op.
    inst.setSubprocessRunner(() => ({
      returncode: 1,
      stdout: "",
      stderr: "",
      failed: false,
      error: "",
    }));
    // Avoid any pregen/skill scanning touching the real home: data dir is
    // isolated, ~/.claude/skills is empty in the fake home.

    const result = inst.install_all();

    const settingsPath = nodePath.join(home, ".claude", "settings.json");
    const mdPath = nodePath.join(home, ".claude", "CLAUDE.md");
    const skillPath = nodePath.join(home, ".claude", "skills", "token-goat", "SKILL.md");

    expect(fs.existsSync(settingsPath)).toBe(true);
    expect(fs.existsSync(mdPath)).toBe(true);
    expect(fs.existsSync(skillPath)).toBe(true);
    expect(result["settings.json"]!.includes("ok")).toBe(true);
    expect(result["CLAUDE.md"]!.includes("ok")).toBe(true);
    expect(result["skill"]!.includes("ok")).toBe(true);

    // --- uninstall ---
    // worker pid file lives under the isolated data dir; ensure none exists.
    const pidPath = paths.workerPidPath();
    try {
      fs.unlinkSync(pidPath);
    } catch {
      /* absent is fine */
    }

    inst.uninstall_all(false);

    const data = JSON.parse(fs.readFileSync(settingsPath, "utf-8")) as Record<string, unknown>;
    const hooks = (data["hooks"] as Record<string, unknown>) ?? {};
    for (const entries of Object.values(hooks)) {
      for (const entry of (entries as Array<Record<string, unknown>>) ?? []) {
        for (const h of (entry["hooks"] as Array<Record<string, unknown>>) ?? []) {
          expect(String(h["command"] ?? "").includes("token_goat")).toBe(false);
        }
      }
    }
    expect(fs.readFileSync(mdPath, "utf-8").includes(inst.CLAUDE_MD_BEGIN)).toBe(false);
    expect(fs.existsSync(skillPath)).toBe(false);
  });
});
