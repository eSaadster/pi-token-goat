/**
 * Port of tests/test_install.py — part A.
 *
 * Covers the platform-independent surface: settings.json patching, CLAUDE.md
 * block patching, skill write/remove, codex config strip, and the hook
 * predicates / interpreter-extraction helpers that the Python suite reaches via
 * `install._foo`.
 *
 * Where the Python test calls a *private* install helper that the TS port does
 * NOT export (the impl is frozen — install.ts may not be edited), the test is
 * `it.skip`-ped with a reason and the symbol is reported as a missingExport.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import * as fs from "node:fs";
import * as os from "node:os";
import * as nodePath from "node:path";

import * as install from "../src/token_goat/install.js";
import * as paths from "../src/token_goat/paths.js";
import * as reset from "../src/token_goat/reset.js";
import {
  withFakeHome,
  loadInstall,
  restorePlatform,
  makeFakeWinreg,
} from "./_install_helpers.js";

// Track fake-home teardown per test.
let _home: { home: string; restore: () => void } | null = null;

function fakeHome(): string {
  _home = withFakeHome();
  return _home.home;
}

afterEach(() => {
  vi.restoreAllMocks();
  restorePlatform();
  if (_home) {
    _home.restore();
    _home = null;
  }
});

function readJSON(p: string): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(p, "utf-8")) as Record<string, unknown>;
}

// Flatten command strings out of a hooks event entry list.
function commandsOf(entries: unknown): string[] {
  const out: string[] = [];
  for (const entry of (entries as Array<Record<string, unknown>>) ?? []) {
    const hooks = (entry["hooks"] as Array<Record<string, unknown>>) ?? [];
    for (const h of hooks) {
      out.push(String(h["command"] ?? ""));
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// 1. patch_settings_json — missing file creates valid JSON with our hooks
// ---------------------------------------------------------------------------

describe("patch_settings_json", () => {
  it("missing file creates valid JSON with our hooks", () => {
    const home = fakeHome();
    vi.spyOn(install, "token_goat_binary").mockReturnValue("token-goat");

    const [ok] = install.patch_settings_json();

    expect(ok).toBe(true);
    const settingsPath = nodePath.join(home, ".claude", "settings.json");
    expect(fs.existsSync(settingsPath)).toBe(true);
    const data = readJSON(settingsPath);

    const hooks = data["hooks"] as Record<string, unknown>;
    expect("SessionStart" in hooks).toBe(true);
    expect("PreToolUse" in hooks).toBe(true);
    expect("PostToolUse" in hooks).toBe(true);

    const ssHooks = commandsOf(hooks["SessionStart"]);
    expect(
      ssHooks.some((c) => c.includes("token_goat") || c.includes("tg-hook")),
    ).toBe(true);

    const perms = data["permissions"] as Record<string, unknown>;
    expect((perms["allow"] as string[]).includes("Bash(token-goat:*)")).toBe(true);
  });

  // 2. preserves existing unrelated hooks
  it("preserves existing unrelated hooks", () => {
    const home = fakeHome();
    vi.spyOn(install, "token_goat_binary").mockReturnValue("token-goat");

    const claudeDir = nodePath.join(home, ".claude");
    fs.mkdirSync(claudeDir, { recursive: true });
    const existing = {
      hooks: {
        PostToolUse: [
          {
            matcher: "Bash",
            hooks: [{ type: "command", command: "other-tool hook bash", timeout: 1000 }],
          },
        ],
      },
    };
    fs.writeFileSync(nodePath.join(claudeDir, "settings.json"), JSON.stringify(existing), "utf-8");

    const [ok] = install.patch_settings_json();
    expect(ok).toBe(true);

    const data = readJSON(nodePath.join(claudeDir, "settings.json"));
    const postEntries = (data["hooks"] as Record<string, unknown>)["PostToolUse"];
    const commandsFlat = commandsOf(postEntries);
    expect(commandsFlat.some((c) => c.includes("other-tool"))).toBe(true);
    expect(commandsFlat.some((c) => c.includes("token_goat") || c.includes("tg-hook"))).toBe(true);
  });

  // 3. idempotent
  it("idempotent (running twice produces a single token-goat SessionStart entry)", () => {
    const home = fakeHome();
    vi.spyOn(install, "token_goat_binary").mockReturnValue("token-goat");

    install.patch_settings_json();
    install.patch_settings_json();

    const data = readJSON(nodePath.join(home, ".claude", "settings.json"));
    const ssEntries = (data["hooks"] as Record<string, unknown>)["SessionStart"];
    const ccCommands = commandsOf(ssEntries).filter(
      (c) => c.includes("token_goat") || c.includes("tg-hook"),
    );
    expect(ccCommands.length).toBe(1);
  });

  // Regression: dedup on re-install (PreToolUse has no duplicate commands)
  it("strip deduplicates on re-install (no duplicate PreToolUse commands)", () => {
    const home = fakeHome();
    vi.spyOn(install, "token_goat_binary").mockReturnValue("token-goat");

    install.patch_settings_json();
    install.patch_settings_json();

    const data = readJSON(nodePath.join(home, ".claude", "settings.json"));
    const preEntries = (data["hooks"] as Record<string, unknown>)["PreToolUse"];
    const allCommands = commandsOf(preEntries);
    const tgCommands = allCommands.filter((c) => c.includes("token_goat"));
    expect(tgCommands.length).toBe(new Set(tgCommands).size);
  });

  // strips legacy tokenwise hooks + permission cruft
  it("strips legacy tokenwise hooks + permission cruft", () => {
    const home = fakeHome();
    vi.spyOn(install, "token_goat_binary").mockReturnValue("token-goat");

    const claudeDir = nodePath.join(home, ".claude");
    fs.mkdirSync(claudeDir, { recursive: true });
    const existing = {
      hooks: {
        PostToolUse: [
          {
            matcher: "Bash",
            hooks: [
              { type: "command", command: "pythonw.exe -m tokenwise.cli hook post-edit", timeout: 1000 },
            ],
          },
        ],
      },
      permissions: { allow: ["Bash(tokenwise:*)", "Bash(git:*)"] },
    };
    fs.writeFileSync(nodePath.join(claudeDir, "settings.json"), JSON.stringify(existing), "utf-8");

    const [ok] = install.patch_settings_json();
    expect(ok).toBe(true);

    const data = readJSON(nodePath.join(claudeDir, "settings.json"));
    const commandsFlat = commandsOf((data["hooks"] as Record<string, unknown>)["PostToolUse"]);
    expect(commandsFlat.some((c) => c.includes("tokenwise"))).toBe(false);
    expect(commandsFlat.some((c) => c.includes("token_goat") || c.includes("tg-hook"))).toBe(true);

    const allowed = (data["permissions"] as Record<string, unknown>)["allow"] as string[];
    expect(allowed.includes("Bash(tokenwise:*)")).toBe(false);
    expect(allowed.filter((a) => a === "Bash(token-goat:*)").length).toBe(1);
    expect(allowed.includes("Bash(git:*)")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 4. unpatch_settings_json — removes our entries cleanly
// ---------------------------------------------------------------------------

describe("unpatch_settings_json", () => {
  it("removes token-goat entries cleanly", () => {
    const home = fakeHome();
    vi.spyOn(install, "token_goat_binary").mockReturnValue("token-goat");

    install.patch_settings_json();
    install.unpatch_settings_json();

    const settingsPath = nodePath.join(home, ".claude", "settings.json");
    const data = readJSON(settingsPath);
    const hooks = (data["hooks"] as Record<string, unknown>) ?? {};
    for (const entries of Object.values(hooks)) {
      for (const command of commandsOf(entries)) {
        expect(command.includes("token_goat")).toBe(false);
        expect(command.includes("tg-hook")).toBe(false);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// 5-8b. patch_claude_md / unpatch_claude_md
// ---------------------------------------------------------------------------

describe("patch_claude_md", () => {
  it("missing file creates file with delimited block", () => {
    const home = fakeHome();
    install.patch_claude_md();
    const mdPath = nodePath.join(home, ".claude", "CLAUDE.md");
    expect(fs.existsSync(mdPath)).toBe(true);
    const content = fs.readFileSync(mdPath, "utf-8");
    expect(content.includes(install.CLAUDE_MD_BEGIN)).toBe(true);
    expect(content.includes(install.CLAUDE_MD_END)).toBe(true);
    expect(content.includes("token-goat")).toBe(true);
  });

  it("appends to existing file without our block", () => {
    const home = fakeHome();
    const claudeDir = nodePath.join(home, ".claude");
    fs.mkdirSync(claudeDir, { recursive: true });
    const existingContent = "# My existing CLAUDE.md\n\nSome prior content.\n";
    fs.writeFileSync(nodePath.join(claudeDir, "CLAUDE.md"), existingContent, "utf-8");

    install.patch_claude_md();
    const content = fs.readFileSync(nodePath.join(claudeDir, "CLAUDE.md"), "utf-8");
    expect(content.includes("My existing CLAUDE.md")).toBe(true);
    expect(content.includes(install.CLAUDE_MD_BEGIN)).toBe(true);
    expect(content.includes(install.CLAUDE_MD_END)).toBe(true);
  });

  it("replaces existing block (idempotent)", () => {
    const home = fakeHome();
    install.patch_claude_md();
    install.patch_claude_md();
    const mdPath = nodePath.join(home, ".claude", "CLAUDE.md");
    const content = fs.readFileSync(mdPath, "utf-8");
    expect(content.split(install.CLAUDE_MD_BEGIN).length - 1).toBe(1);
    expect(content.split(install.CLAUDE_MD_END).length - 1).toBe(1);
  });

  it("strips legacy tokenwise block left over from pre-rename", () => {
    const home = fakeHome();
    const claudeDir = nodePath.join(home, ".claude");
    fs.mkdirSync(claudeDir, { recursive: true });
    const legacyBlock =
      `${install.LEGACY_CLAUDE_MD_BEGIN}\n` +
      "## tokenwise - route code reads through tokenwise first\n\n" +
      "| Goal | Do this | Not this |\n" +
      "|------|---------|----------|\n" +
      "| Find a function | `tokenwise symbol X` | `Grep X` |\n" +
      `${install.LEGACY_CLAUDE_MD_END}\n`;
    const seed = "# My existing CLAUDE.md\n\nSome prior content.\n\n" + legacyBlock;
    const mdPath = nodePath.join(claudeDir, "CLAUDE.md");
    fs.writeFileSync(mdPath, seed, "utf-8");

    install.patch_claude_md();
    const content = fs.readFileSync(mdPath, "utf-8");

    expect(content.includes("My existing CLAUDE.md")).toBe(true);
    expect(content.includes(install.CLAUDE_MD_BEGIN)).toBe(true);
    expect(content.includes(install.CLAUDE_MD_END)).toBe(true);
    expect(content.includes(install.LEGACY_CLAUDE_MD_BEGIN)).toBe(false);
    expect(content.includes(install.LEGACY_CLAUDE_MD_END)).toBe(false);
    expect(content.includes("tokenwise symbol X")).toBe(false);
  });

  it("legacy strip is idempotent", () => {
    const home = fakeHome();
    const claudeDir = nodePath.join(home, ".claude");
    fs.mkdirSync(claudeDir, { recursive: true });
    const seed = `${install.LEGACY_CLAUDE_MD_BEGIN}\nlegacy body\n${install.LEGACY_CLAUDE_MD_END}\n`;
    const mdPath = nodePath.join(claudeDir, "CLAUDE.md");
    fs.writeFileSync(mdPath, seed, "utf-8");

    install.patch_claude_md();
    install.patch_claude_md();
    const content = fs.readFileSync(mdPath, "utf-8");

    expect(content.split(install.CLAUDE_MD_BEGIN).length - 1).toBe(1);
    expect(content.split(install.CLAUDE_MD_END).length - 1).toBe(1);
    expect(content.includes(install.LEGACY_CLAUDE_MD_BEGIN)).toBe(false);
    expect(content.includes(install.LEGACY_CLAUDE_MD_END)).toBe(false);
  });
});

describe("unpatch_claude_md", () => {
  it("removes the block", () => {
    const home = fakeHome();
    install.patch_claude_md();
    install.unpatch_claude_md();
    const mdPath = nodePath.join(home, ".claude", "CLAUDE.md");
    const content = fs.readFileSync(mdPath, "utf-8");
    expect(content.includes(install.CLAUDE_MD_BEGIN)).toBe(false);
    expect(content.includes(install.CLAUDE_MD_END)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 9-10. write_skill / remove_skill
// ---------------------------------------------------------------------------

describe("write_skill / remove_skill", () => {
  it("write_skill creates SKILL.md under ~/.claude/skills/token-goat/", () => {
    const home = fakeHome();
    install.write_skill();
    const skillPath = nodePath.join(home, ".claude", "skills", "token-goat", "SKILL.md");
    expect(fs.existsSync(skillPath)).toBe(true);
    const content = fs.readFileSync(skillPath, "utf-8");
    expect(content.includes("name: token-goat")).toBe(true);
    expect(content.includes("description:")).toBe(true);
  });

  it("remove_skill deletes the skill directory", () => {
    const home = fakeHome();
    install.write_skill();
    const skillDir = nodePath.join(home, ".claude", "skills", "token-goat");
    expect(fs.existsSync(skillDir)).toBe(true);

    install.remove_skill();
    expect(fs.existsSync(skillDir)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// task_exists — reports based on subprocess return code
//
// Python patches install._run_schtasks (private). The TS port has no exported
// _run_schtasks; the equivalent seam is setSubprocessRunner, which stubs the
// schtasks.exe call task_exists() makes. Faithful behaviour, public seam.
// ---------------------------------------------------------------------------

describe("task_exists", () => {
  afterEach(() => install.setSubprocessRunner(null));

  it("true when schtasks query returns 0", () => {
    install.setSubprocessRunner(() => ({
      returncode: 0,
      stdout: "task found",
      stderr: "",
      failed: false,
      error: "",
    }));
    expect(install.task_exists("some-task")).toBe(true);
  });

  it("false when schtasks query returns 1", () => {
    install.setSubprocessRunner(() => ({
      returncode: 1,
      stdout: "not found",
      stderr: "",
      failed: false,
      error: "",
    }));
    expect(install.task_exists("some-task")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Codex config strip of legacy tokenwise hooks
// ---------------------------------------------------------------------------

describe("patch_codex_config", () => {
  it("strips legacy tokenwise hook entries", async () => {
    const home = fakeHome();
    vi.spyOn(install, "token_goat_binary").mockReturnValue("token-goat");

    const codexDir = nodePath.join(home, ".codex");
    fs.mkdirSync(codexDir, { recursive: true });
    const existing =
      "[[hooks.PostToolUse]]\n" +
      'matcher = "Bash"\n' +
      "[[hooks.PostToolUse.hooks]]\n" +
      'type = "command"\n' +
      'command = "tokenwise hook post-edit"\n';
    fs.writeFileSync(nodePath.join(codexDir, "config.toml"), existing, "utf-8");

    install.patch_codex_config("token-goat");

    const { parse } = await import("smol-toml");
    const data = parse(fs.readFileSync(nodePath.join(codexDir, "config.toml"), "utf-8")) as Record<
      string,
      unknown
    >;
    const hooks = (data["hooks"] as Record<string, unknown>) ?? {};
    const commandsFlat: string[] = [];
    for (const entries of Object.values(hooks)) {
      commandsFlat.push(...commandsOf(entries));
    }
    expect(commandsFlat.length).toBeGreaterThan(0);
    expect(commandsFlat.some((c) => c.includes("tokenwise"))).toBe(false);
    expect(commandsFlat.some((c) => c.includes("token_goat") || c.includes("tg-hook"))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Hook wrapper helpers (paths.hookWrapperContent).
//
// The TS port's wrapper is documented as UNGATED (paths.ts: Node has no
// importlib.util.find_spec to probe a Python module from JS, so the
// sentinel-gate / `{"continue":true}` short-circuit branch is intentionally
// not portable). Tests below assert the invariants that DO hold for the TS
// wrapper; the Python-only short-circuit test is deferred.
// ---------------------------------------------------------------------------

describe("hook wrapper content", () => {
  it.skip("short-circuits when module absent — TS wrapper is intentionally ungated (no {\"continue\":true} branch; paths.hookWrapperContent is Python-only there)", () => {
    // Deferred: the TS hookWrapperContent() emits an ungated forwarder with no
    // {"continue":true} sentinel branch (documented divergence in paths.ts).
  });

  it("gate path exists for current interpreter (ungated wrapper forwards unconditionally)", () => {
    const content = paths.hookWrapperContent();
    // Node-native wrapper forwards to the CLI entry file — never the Python
    // `-m token_goat.cli` form (which throws `node: bad option: -m`).
    expect(content).not.toContain("token_goat.cli");
    expect(content).not.toContain(" -m ");
    expect(/\.(ts|js|mjs|cjs)/.test(content)).toBe(true);
    expect(content.includes(process.platform === "win32" ? "%*" : '"$@"')).toBe(true);

    let match: RegExpMatchArray | null;
    if (process.platform === "win32") {
      match = content.match(/if not exist "([^"]+)"/);
    } else {
      match = content.match(/if \[ ! -f "([^"]+)" \]/);
    }
    if (match !== null) {
      const gated = match[1]!;
      expect(fs.existsSync(gated)).toBe(true);
      expect(nodePath.basename(gated)).toBe("__init__.py");
      expect(nodePath.basename(nodePath.dirname(gated))).toBe("token_goat");
    }
  });

  it("ungated when no sentinel found (no gate, forwards, no continue sentinel)", () => {
    const content = paths.hookWrapperContent();
    expect(content).not.toContain("token_goat.cli");
    expect(content.includes('{"continue":true}')).toBe(false);
    if (process.platform === "win32") {
      expect(content.includes("if not exist")).toBe(false);
    } else {
      expect(content.includes("! -f")).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// Predicate / interpreter-extraction helpers.
//
// These are now EXPORTED from the TS port: _is_token_goat_hook /
// _is_managed_hook / _extract_interpreter_from_command /
// _settings_json_token_goat_count. The tests below exercise them directly,
// faithful to tests/test_install.py.
// ---------------------------------------------------------------------------

describe("predicate / extraction helpers", () => {
  it("_is_token_goat_hook recognises both markers", () => {
    expect(install._is_token_goat_hook("C:/path/pythonw.exe -m token_goat.cli hook pre-read")).toBe(
      true,
    );
    expect(
      install._is_token_goat_hook(
        '"C:/Users/x/AppData/Local/dfk-helper/token-goat/bin/tg-hook.cmd" hook pre-read',
      ),
    ).toBe(true);
    expect(install._is_token_goat_hook("other-tool hook bash")).toBe(false);
    expect(install._is_token_goat_hook("")).toBe(false);
  });

  it("_is_token_goat_hook excludes legacy tokenwise", () => {
    expect(install._is_token_goat_hook("C:/path/pythonw.exe -m tokenwise.cli hook pre-read")).toBe(
      false,
    );
    expect(install._is_token_goat_hook("Bash(tokenwise:*)")).toBe(false);
  });

  it("_is_managed_hook covers current and legacy", () => {
    expect(install._is_managed_hook("pythonw.exe -m token_goat.cli hook pre-read")).toBe(true);
    expect(install._is_managed_hook('"...\\bin\\tg-hook.cmd" hook pre-read')).toBe(true);
    expect(install._is_managed_hook("pythonw.exe -m tokenwise.cli hook pre-read")).toBe(true);
    expect(install._is_managed_hook("other-tool hook bash")).toBe(false);
    expect(install._is_managed_hook("")).toBe(false);
  });

  it("_extract_interpreter_from_command quoted", () => {
    const cmd = '"C:/Users/zelys/.venv/Scripts/pythonw.exe" -m token_goat.cli worker --daemon';
    expect(install._extract_interpreter_from_command(cmd)).toBe(
      "C:/Users/zelys/.venv/Scripts/pythonw.exe",
    );
  });

  it("_extract_interpreter_from_command unquoted", () => {
    const cmd = "/usr/bin/python3 -m token_goat.cli worker --daemon";
    expect(install._extract_interpreter_from_command(cmd)).toBe("/usr/bin/python3");
  });

  it("_extract_interpreter_from_command empty", () => {
    expect(install._extract_interpreter_from_command("")).toBeNull();
    expect(install._extract_interpreter_from_command("   ")).toBeNull();
  });

  it("_settings_json_token_goat_count stable across re-installs", () => {
    fakeHome();
    vi.spyOn(install, "token_goat_binary").mockReturnValue("token-goat");

    install.patch_settings_json();
    const first = install._settings_json_token_goat_count();
    install.patch_settings_json();
    const second = install._settings_json_token_goat_count();
    install.patch_settings_json();
    const third = install._settings_json_token_goat_count();
    expect(first).toBe(second);
    expect(second).toBe(third);
    expect(first).toBeGreaterThan(0);
  });

  it.skip("_hooks_block events have typer subcommands — needs cli.py hook_app (Layer 7 / cli not ported); the typer command registry has no TS analogue", () => {});
});

// ---------------------------------------------------------------------------
// _write_hook_wrapper / _hook_runner_command — now exported.
//
// _write_hook_wrapper writes paths.hookWrapperContent() byte-for-byte (no CRLF
// doubling). _hook_runner_command prefers the on-disk wrapper when present and
// falls back to the direct python runner when absent. Both reach paths.* via
// the module namespace, so paths.hookWrapperPath is spyable.
//
// NOTE: the Python "creates file with {\"continue\":true}" assertion is NOT
// portable — the TS hookWrapperContent() is the documented *ungated* forwarder
// with no {"continue":true} sentinel; that case stays deferred (see the hook
// wrapper content block above).
// ---------------------------------------------------------------------------

describe("_write_hook_wrapper / _hook_runner_command", () => {
  it("_write_hook_wrapper byte-faithful (no CRLF doubling)", () => {
    const dataDir = fs.mkdtempSync(nodePath.join(os.tmpdir(), "tg-wrap-"));
    try {
      reset.setDataDirOverride(dataDir);
      const wrapperPath = install._write_hook_wrapper();
      const onDisk = fs.readFileSync(wrapperPath).toString("utf-8");
      // Same process, same content generator -> byte-identical.
      expect(onDisk).toBe(paths.hookWrapperContent());
      expect(onDisk.includes("\r\r\n")).toBe(false);
    } finally {
      reset.clearDataDirOverride();
      fs.rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it("_hook_runner_command prefers wrapper when present", () => {
    const tmp = fs.mkdtempSync(nodePath.join(os.tmpdir(), "tg-wrap-"));
    try {
      const fakeWrapper = nodePath.join(tmp, "bin", "tg-hook.cmd");
      fs.mkdirSync(nodePath.dirname(fakeWrapper), { recursive: true });
      fs.writeFileSync(fakeWrapper, "@echo off\r\n", "utf-8");
      vi.spyOn(paths, "hookWrapperPath").mockReturnValue(fakeWrapper);

      const cmd = install._hook_runner_command("hook", "session-start");
      expect(cmd.includes("tg-hook")).toBe(true);
      expect(cmd.includes("session-start")).toBe(true);
      // The wrapper hides the module invocation.
      expect(cmd.includes("token_goat.cli")).toBe(false);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("_hook_runner_command falls back when wrapper missing", () => {
    const tmp = fs.mkdtempSync(nodePath.join(os.tmpdir(), "tg-wrap-"));
    try {
      vi.spyOn(paths, "hookWrapperPath").mockReturnValue(nodePath.join(tmp, "nope.cmd"));
      const cmd = install._hook_runner_command("hook", "session-start");
      // Fallback = pythonRunnerCommand → [node, <entry>] (no `-m token_goat.cli`).
      expect(cmd.includes("token_goat.cli")).toBe(false);
      expect(/\.(ts|js|mjs|cjs)/.test(cmd)).toBe(true);
      expect(cmd.includes("session-start")).toBe(true);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// _read_win_autostart_command / _read_linux_autostart_command — now exported.
//
// Both are platform-coupled (read winreg / systemd-or-XDG files), so they use
// loadInstall(platform) for a fresh platform-pinned module graph. The Python
// tests monkeypatch _systemd_service_path / _xdg_autostart_path; those are
// lexical same-module calls in the TS port, so we instead drive them via the
// real fake-home paths (systemd unit / XDG desktop file on disk).
// ---------------------------------------------------------------------------

describe("_read_win_autostart_command", () => {
  it("returns the registry value when set", async () => {
    const { install: inst } = await loadInstall("win32");
    const stored = '"C:/venv/pythonw.exe" -m token_goat.cli worker --daemon';
    const { backend } = makeFakeWinreg({ [inst.TASK_WORKER]: stored });
    inst.setWinregBackend(backend);
    expect(inst._read_win_autostart_command()).toBe(stored);
  });

  it("returns null when the value does not exist", async () => {
    const { install: inst } = await loadInstall("win32");
    const { backend } = makeFakeWinreg();
    inst.setWinregBackend(backend);
    expect(inst._read_win_autostart_command()).toBeNull();
  });

  it("returns null on non-Windows", async () => {
    const { install: inst } = await loadInstall("linux");
    expect(inst._read_win_autostart_command()).toBeNull();
  });
});

describe("_read_linux_autostart_command", () => {
  it("reads ExecStart from systemd service file", async () => {
    fakeHome();
    const { install: inst } = await loadInstall("linux");
    const svc = inst._systemd_service_path();
    fs.mkdirSync(nodePath.dirname(svc), { recursive: true });
    fs.writeFileSync(
      svc,
      "[Unit]\nDescription=test\n\n[Service]\n" +
        "ExecStart=/usr/bin/python3 -m token_goat.cli worker --daemon\n\n" +
        "[Install]\nWantedBy=default.target\n",
      "utf-8",
    );
    expect(inst._read_linux_autostart_command()).toBe(
      "/usr/bin/python3 -m token_goat.cli worker --daemon",
    );
  });

  it("falls back to XDG Exec= when no systemd file", async () => {
    fakeHome();
    const { install: inst } = await loadInstall("linux");
    const desktop = inst._xdg_autostart_path();
    fs.mkdirSync(nodePath.dirname(desktop), { recursive: true });
    fs.writeFileSync(
      desktop,
      "[Desktop Entry]\nVersion=1.0\nType=Application\n" +
        "Exec=/home/user/venv/bin/python3 -m token_goat.cli worker --daemon\n",
      "utf-8",
    );
    expect(inst._read_linux_autostart_command()).toBe(
      "/home/user/venv/bin/python3 -m token_goat.cli worker --daemon",
    );
  });

  it("returns null when neither file exists", async () => {
    fakeHome();
    const { install: inst } = await loadInstall("linux");
    expect(inst._read_linux_autostart_command()).toBeNull();
  });
});
