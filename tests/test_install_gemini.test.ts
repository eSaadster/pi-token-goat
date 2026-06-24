/**
 * Tests for Gemini CLI install/uninstall — patch/unpatch/check integration.
 *
 * 1:1 port of tests/test_install_gemini.py.
 *
 * Test-seam mapping (Python -> TS):
 *  - monkeypatch.setattr("token_goat.install.gemini_settings_path", lambda: X)
 *      -> set process.env.HOME to a per-test fake home; install.ts resolves
 *        gemini_settings_path() through gemini_dir() -> os.homedir(), which on
 *        POSIX honours $HOME. (gemini_settings_path is called via a LOCAL binding
 *        inside patch/unpatch, AND Node's os.homedir is non-spyable, so the env
 *        route is the working seam.) The settings file lands at
 *        <fakeHome>/.gemini/settings.json — functionally identical to Python's
 *        tmp_path/settings.json for these read-after-write assertions.
 *  - json.loads / json.dumps -> JSON.parse / JSON.stringify.
 *
 * Deferred:
 *  - test__check_status_installed / not_installed / malformed call
 *    install._check_gemini_settings, which is module-private (not exported from
 *    install.ts) -> reported as a missing export and skipped.
 *  - test_install_target_help_lists_every_valid_target drives the Typer CLI
 *    (token_goat.cli + _VALID_TARGETS); there is no cli.ts in the TS port yet
 *    -> deferred (needs the CLI module, an L7-style un-ported surface).
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import * as install from "../src/token_goat/install.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface HookCmd {
  type?: string;
  command?: string;
  timeout?: number;
}
interface HookEntry {
  matcher?: string;
  hooks?: HookCmd[];
}
interface SettingsData {
  hooks?: Record<string, HookEntry[]>;
}

/** Return every hook command string present in a settings dict. */
function allHookCommands(data: SettingsData): string[] {
  const out: string[] = [];
  for (const entries of Object.values(data.hooks ?? {})) {
    for (const e of entries) {
      for (const h of e.hooks ?? []) {
        if (h && typeof h === "object" && typeof h.command === "string") {
          out.push(h.command);
        }
      }
    }
  }
  return out;
}

let _savedHome: string | undefined;

/**
 * Build a per-test fake home and return the gemini settings.json path inside it
 * (<fakeHome>/.gemini/settings.json). Sets process.env.HOME so install.ts's
 * gemini_settings_path() resolves under the fake home.
 */
function mkSettingsFile(): string {
  const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "tg-gemini-")));
  const home = path.join(tmp, "home");
  // Pre-create the ~/.gemini dir so tests that seed settings.json before calling
  // patch (Python wrote directly into tmp_path, which always exists) can write.
  fs.mkdirSync(path.join(home, ".gemini"), { recursive: true });
  process.env["HOME"] = home;
  return path.join(home, ".gemini", "settings.json");
}

beforeEach(() => {
  _savedHome = process.env["HOME"];
});

afterEach(() => {
  vi.restoreAllMocks();
  if (_savedHome === undefined) {
    delete process.env["HOME"];
  } else {
    process.env["HOME"] = _savedHome;
  }
});

describe("test_install_gemini", () => {
  // -------------------------------------------------------------------------
  // 1. patch creates settings.json when it does not exist
  // -------------------------------------------------------------------------
  it("test_patch_creates_settings_json", () => {
    const settingsFile = mkSettingsFile();

    const result = install.patch_gemini_settings();

    expect(fs.existsSync(settingsFile)).toBe(true);
    expect(result).toBe(settingsFile);

    const data = JSON.parse(fs.readFileSync(settingsFile, "utf-8")) as SettingsData;
    const hooks = data.hooks ?? {};

    expect("BeforeTool" in hooks).toBe(true);
    expect("AfterTool" in hooks).toBe(true);
    expect("SessionStart" in hooks).toBe(true);
    expect("PreCompress" in hooks).toBe(true);

    for (const eventEntries of Object.values(hooks)) {
      for (const entry of eventEntries) {
        for (const h of entry.hooks ?? []) {
          const cmd = h.command ?? "";
          expect(cmd.includes("tg-hook") || cmd.includes("token_goat")).toBe(true);
        }
      }
    }
  });

  // -------------------------------------------------------------------------
  // 2. patch is idempotent — calling twice does not duplicate entries
  // -------------------------------------------------------------------------
  it("test_patch_idempotent", () => {
    const settingsFile = mkSettingsFile();

    install.patch_gemini_settings();
    const dataFirst = JSON.parse(fs.readFileSync(settingsFile, "utf-8")) as SettingsData;
    const countsFirst: Record<string, number> = {};
    for (const [event, entries] of Object.entries(dataFirst.hooks ?? {})) {
      countsFirst[event] = entries.length;
    }

    install.patch_gemini_settings();
    const dataSecond = JSON.parse(fs.readFileSync(settingsFile, "utf-8")) as SettingsData;
    const countsSecond: Record<string, number> = {};
    for (const [event, entries] of Object.entries(dataSecond.hooks ?? {})) {
      countsSecond[event] = entries.length;
    }

    expect(countsSecond).toEqual(countsFirst);
  });

  // -------------------------------------------------------------------------
  // 3. patch preserves pre-existing non-token-goat hooks
  // -------------------------------------------------------------------------
  it("test_patch_preserves_existing_hooks", () => {
    const settingsFile = mkSettingsFile();

    const existing = {
      hooks: {
        BeforeTool: [
          {
            matcher: "some_tool",
            hooks: [{ type: "command", command: "other-tool hook pre", timeout: 1000 }],
          },
        ],
      },
    };
    fs.writeFileSync(settingsFile, JSON.stringify(existing), "utf-8");

    install.patch_gemini_settings();

    const data = JSON.parse(fs.readFileSync(settingsFile, "utf-8")) as SettingsData;
    const allCmds = allHookCommands(data);

    expect(allCmds.some((c) => c.includes("other-tool"))).toBe(true);
    expect(allCmds.some((c) => c.includes("tg-hook") || c.includes("token_goat"))).toBe(true);
  });

  // -------------------------------------------------------------------------
  // 4. patch handles malformed JSON — starts fresh, writes valid output
  // -------------------------------------------------------------------------
  it("test_patch_merges_into_malformed_json", () => {
    const settingsFile = mkSettingsFile();

    fs.writeFileSync(settingsFile, "{ this is not valid json !!!", "utf-8");

    // Must not raise.
    install.patch_gemini_settings();

    expect(fs.existsSync(settingsFile)).toBe(true);
    const data = JSON.parse(fs.readFileSync(settingsFile, "utf-8")) as SettingsData;
    const hooks = data.hooks ?? {};
    expect(Object.keys(hooks).length).toBeGreaterThan(0);
    const allCmds = allHookCommands(data);
    expect(allCmds.some((c) => c.includes("tg-hook") || c.includes("token_goat"))).toBe(true);
  });

  // -------------------------------------------------------------------------
  // 5. unpatch removes token-goat hooks
  // -------------------------------------------------------------------------
  it("test_unpatch_removes_token_goat_hooks", () => {
    const settingsFile = mkSettingsFile();

    install.patch_gemini_settings();
    install.unpatch_gemini_settings();

    const data = JSON.parse(fs.readFileSync(settingsFile, "utf-8")) as SettingsData;
    const allCmds = allHookCommands(data);
    expect(allCmds.some((c) => c.includes("tg-hook") || c.includes("token_goat"))).toBe(false);
  });

  // -------------------------------------------------------------------------
  // 6. unpatch preserves non-token-goat hooks
  // -------------------------------------------------------------------------
  it("test_unpatch_preserves_other_hooks", () => {
    const settingsFile = mkSettingsFile();

    const seed = {
      hooks: {
        BeforeTool: [
          {
            matcher: "some_tool",
            hooks: [{ type: "command", command: "other-tool hook pre", timeout: 1000 }],
          },
        ],
      },
    };
    fs.writeFileSync(settingsFile, JSON.stringify(seed), "utf-8");

    install.patch_gemini_settings();
    install.unpatch_gemini_settings();

    const data = JSON.parse(fs.readFileSync(settingsFile, "utf-8")) as SettingsData;
    const allCmds = allHookCommands(data);

    expect(allCmds.some((c) => c.includes("other-tool"))).toBe(true);
    expect(allCmds.some((c) => c.includes("tg-hook") || c.includes("token_goat"))).toBe(false);
  });

  // -------------------------------------------------------------------------
  // 7. unpatch on missing file returns a message, does not raise
  // -------------------------------------------------------------------------
  it("test_unpatch_missing_file", () => {
    const settingsFile = mkSettingsFile();

    const result = install.unpatch_gemini_settings();

    expect(typeof result).toBe("string");
    expect(result.toLowerCase().includes("not found") || Boolean(result)).toBe(true);
    expect(fs.existsSync(settingsFile)).toBe(false);
  });

  // -------------------------------------------------------------------------
  // 8. _check_gemini_settings returns "installed" after patch
  // -------------------------------------------------------------------------
  it("test_check_status_installed", () => {
    mkSettingsFile();

    install.patch_gemini_settings();
    const status = install._check_gemini_settings();

    expect(status.toLowerCase()).toContain("installed");
    expect(status.toLowerCase().includes("not installed")).toBe(false);
  });

  // -------------------------------------------------------------------------
  // 9. _check_gemini_settings returns "not installed" when file is missing
  // -------------------------------------------------------------------------
  it("test_check_status_not_installed", () => {
    // mkSettingsFile pre-creates ~/.gemini but NOT settings.json itself, so the
    // settings file is absent (parallel to Python's never-written tmp file).
    const settingsFile = mkSettingsFile();
    expect(fs.existsSync(settingsFile)).toBe(false);

    const status = install._check_gemini_settings();

    expect(status.toLowerCase()).toContain("not installed");
  });

  // -------------------------------------------------------------------------
  // 10. _check_gemini_settings returns "error" for malformed JSON
  // -------------------------------------------------------------------------
  it("test_check_status_malformed", () => {
    const settingsFile = mkSettingsFile();
    fs.writeFileSync(settingsFile, "not json at all", "utf-8");

    const status = install._check_gemini_settings();

    expect(status.toLowerCase()).toContain("error");
  });

  // -------------------------------------------------------------------------
  // 11. Every hook command contains --harness gemini
  // -------------------------------------------------------------------------
  it("test_hook_commands_have_harness_gemini_flag", () => {
    const settingsFile = mkSettingsFile();

    install.patch_gemini_settings();

    const data = JSON.parse(fs.readFileSync(settingsFile, "utf-8")) as SettingsData;
    const allCmds = allHookCommands(data);

    expect(allCmds.length).toBeGreaterThan(0);
    for (const cmd of allCmds) {
      if (cmd.includes("tg-hook") || cmd.includes("token_goat")) {
        expect(cmd).toContain("--harness gemini");
      }
    }
  });

  // -------------------------------------------------------------------------
  // 12. Hook event names are Gemini-format, not Claude-format
  // -------------------------------------------------------------------------
  it("test_event_names_are_gemini_format", () => {
    const settingsFile = mkSettingsFile();

    install.patch_gemini_settings();

    const data = JSON.parse(fs.readFileSync(settingsFile, "utf-8")) as SettingsData;
    const hookEvents = new Set(Object.keys(data.hooks ?? {}));

    for (const expected of ["BeforeTool", "AfterTool", "SessionStart", "PreCompress"]) {
      expect(hookEvents.has(expected)).toBe(true);
    }

    for (const claudeName of ["PreToolUse", "PostToolUse", "PreCompact"]) {
      expect(hookEvents.has(claudeName)).toBe(false);
    }
  });

  // -------------------------------------------------------------------------
  // 13. `install --target` help advertises every valid target (incl. gemini)
  // -------------------------------------------------------------------------
  it.skip(
    "test_install_target_help_lists_every_valid_target (PORT: deferred — no cli.ts/_VALID_TARGETS in the TS port; needs the Typer CLI surface)",
    () => {
      // Needs token_goat.cli (+ _VALID_TARGETS) and a CliRunner — not ported.
    },
  );
});
