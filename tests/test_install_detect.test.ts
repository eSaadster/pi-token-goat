/**
 * Tests for detect_cline(), detect_windsurf(), detect_copilot_cli() in install.ts.
 *
 * Faithful 1:1 port of tests/test_install_detect.py.
 *
 * The Python tests monkeypatch `shutil.which` to return a path for a specific
 * binary name. In the TS port `which()` is fs-based (it iterates PATH and probes
 * each candidate with fs.accessSync/fs.statSync). To reproduce
 * `monkeypatch.setattr("shutil.which", lambda name: ...)` faithfully we install
 * an `installWhich(present)` seam that spies fs.accessSync + fs.statSync so a
 * candidate "exists as an executable file" iff its basename (with any Windows
 * extension stripped) is in the *present* set. fs.existsSync is left untouched,
 * so directory probes (~/.windsurf, ~/.codex, ~/.gemini) keep hitting the real
 * (mocked-home) filesystem exactly as Python's tmp_path-based tests intend.
 *
 * Python `Path.home()` -> os.homedir(): patched per-test via vi.spyOn(os,...).
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import * as fs from "node:fs";
import * as os from "node:os";
import nodePath from "node:path";

import {
  detect_cline,
  detect_copilot_cli,
  detect_windsurf,
  detect_installed_harnesses,
  detect_harnesses,
  codex_dir,
} from "../src/token_goat/install.js";

// ---------------------------------------------------------------------------
// Test seams without module mocking.
//
// install.ts imports node:fs / node:os via `import * as fs` / `import * as os`.
// Under NodeNext those ESM namespaces are non-configurable, so vi.spyOn on them
// throws "Cannot redefine property", and a spy on the default import is a
// DIFFERENT object the module never reads. So instead of mocking we drive the
// real code paths through the real filesystem and process env:
//
//   * shutil.which seam  -> create a REAL executable file named `<bin>` inside a
//     fresh temp dir prepended to PATH. which() then resolves it for real,
//     reproducing `monkeypatch.setattr("shutil.which", lambda name: <path>)`.
//   * Path.home() seam   -> os.homedir() honours $HOME on this platform, so we
//     set process.env.HOME to the per-test temp home (Python's tmp_path).
//
// Both are reset in afterEach so nothing leaks between tests.
// ---------------------------------------------------------------------------

let savedHome: string | undefined;
let savedPath: string | undefined;
let savedAppdata: string | undefined;
let savedCodexHome: string | undefined;
const tmpDirs: string[] = [];

function freshTmp(prefix: string): string {
  const d = fs.mkdtempSync(nodePath.join(fs.realpathSync(os.tmpdir()), prefix));
  tmpDirs.push(d);
  return d;
}

/**
 * Make `which(name)` resolve exactly for the binary names in *present* by
 * planting real executable files on a temp PATH directory.
 */
function installWhich(present: Set<string>): void {
  const binDir = freshTmp("which-bin-");
  for (const name of present) {
    const p = nodePath.join(binDir, name);
    fs.writeFileSync(p, "#!/bin/sh\nexit 0\n");
    fs.chmodSync(p, 0o755);
  }
  // Prepend our bin dir; keep nothing else so unrelated binaries stay "absent".
  process.env["PATH"] = binDir;
}

/** Point os.homedir() at a temp dir (Python: Path.home() -> tmp_path). */
function setHome(dir: string): void {
  process.env["HOME"] = dir;
}

beforeEach(() => {
  savedHome = process.env["HOME"];
  savedPath = process.env["PATH"];
  savedAppdata = process.env["APPDATA"];
  savedCodexHome = process.env["CODEX_HOME"];
  // Default: no binaries discoverable, so detect_* default to "absent" unless a
  // test plants one. (Empty PATH means which() finds nothing.)
  process.env["PATH"] = "";
});

afterEach(() => {
  const restore = (k: string, v: string | undefined): void => {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  };
  restore("HOME", savedHome);
  restore("PATH", savedPath);
  restore("APPDATA", savedAppdata);
  restore("CODEX_HOME", savedCodexHome);
  for (const d of tmpDirs.splice(0)) {
    try {
      fs.rmSync(d, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
  }
});

// ---------------------------------------------------------------------------
// detect_cline
// ---------------------------------------------------------------------------

describe("detect_cline", () => {
  it("test_detect_cline_via_binary", () => {
    installWhich(new Set(["cline"]));
    expect(detect_cline()).toBe(true);
  });

  it("test_detect_cline_via_alias_binary", () => {
    installWhich(new Set(["claude-dev"]));
    expect(detect_cline()).toBe(true);
  });

  it("test_detect_cline_not_present", () => {
    installWhich(new Set());
    // Python additionally patches importlib.util.find_spec -> None; there is no
    // JS package-import probe, so the PATH miss alone yields False.
    expect(detect_cline()).toBe(false);
  });

  it.skip("test_detect_cline_via_package — no JS importlib.util.find_spec equivalent (impl notes the probe is dropped)", () => {
    // Python: shutil.which -> None but find_spec("cline") -> object() => True.
    // The TS port has no package-import detection path, so this scenario cannot
    // occur and the assertion (detect_cline() is True) is not reproducible.
  });
});

// ---------------------------------------------------------------------------
// detect_windsurf
// ---------------------------------------------------------------------------

describe("detect_windsurf", () => {
  it("test_detect_windsurf_via_binary", () => {
    installWhich(new Set(["windsurf"]));
    expect(detect_windsurf()).toBe(true);
  });

  it("test_detect_windsurf_via_home_dir", () => {
    // Returns True when ~/.windsurf directory exists under the mocked home.
    installWhich(new Set());
    const home = freshTmp("ws-home-");
    fs.mkdirSync(nodePath.join(home, ".windsurf"));
    setHome(home);
    const result = detect_windsurf();
    expect(result).toBe(true);
  });

  it("test_detect_windsurf_not_present", () => {
    // Returns False when binary absent and no windsurf config dirs exist.
    installWhich(new Set());
    const home = freshTmp("ws-home-");
    setHome(home);
    // APPDATA points to home (no Windsurf subdir); only consulted on win32 anyway.
    process.env["APPDATA"] = home;
    const result = detect_windsurf();
    expect(result).toBe(false);
  });

  it.skip("test_detect_windsurf_via_appdata_dir — Windows APPDATA branch only (sys.platform != win32)", () => {
    // skipif(sys.platform != "win32"): the %APPDATA%\\Windsurf branch is gated
    // on the module-level _PLATFORM === "win32", which is darwin in this runner.
  });
});

// ---------------------------------------------------------------------------
// detect_copilot_cli
// ---------------------------------------------------------------------------

describe("detect_copilot_cli", () => {
  it("test_detect_copilot_cli_via_binary", () => {
    installWhich(new Set(["copilot"]));
    expect(detect_copilot_cli()).toBe(true);
  });

  it("test_detect_copilot_cli_not_present", () => {
    installWhich(new Set());
    expect(detect_copilot_cli()).toBe(false);
  });

  it("test_detect_copilot_via_alias", () => {
    installWhich(new Set(["github-copilot-cli"]));
    expect(detect_copilot_cli()).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// detect_installed_harnesses
// ---------------------------------------------------------------------------

describe("detect_installed_harnesses", () => {
  it("test_detect_installed_harnesses_returns_dict", () => {
    // Verify detect_installed_harnesses returns a dict with expected keys.
    const result = detect_installed_harnesses();
    expect(typeof result).toBe("object");
    expect(result).not.toBeNull();
    // Check for all expected harness keys (matches Python's expected_keys 1:1,
    // including the fork-added "pi" key).
    const expectedKeys = new Set([
      "claude",
      "aider",
      "codex",
      "gemini",
      "opencode",
      "openclaw",
      "pi",
      "cline",
      "windsurf",
      "copilot-cli",
    ]);
    expect(new Set(Object.keys(result))).toEqual(expectedKeys);
  });

  it("test_detect_installed_harnesses_claude_always_true", () => {
    // Claude harness should always be detected.
    const result = detect_installed_harnesses();
    expect(result["claude"]).toBe(true);
  });

  it("test_detect_installed_harnesses_all_values_bool", () => {
    // All values in the returned dict should be booleans.
    const result = detect_installed_harnesses();
    for (const [name, installed] of Object.entries(result)) {
      expect(typeof installed, `Value for ${name} should be bool, got ${typeof installed}`).toBe(
        "boolean",
      );
    }
  });

  it("test_detect_installed_harnesses_handles_missing_bridges", () => {
    // Should handle gracefully when bridges module is unavailable.
    // The Python test monkeypatches the whole function with a stub that returns
    // opencode/openclaw == False, then asserts on that stub — i.e. it exercises
    // the fixture, not the real impl. We reproduce the same shape: a local stub
    // standing in for the patched function.
    const patchedDetect = (): Record<string, boolean> => ({
      claude: true,
      aider: false,
      codex: false,
      gemini: false,
      opencode: false,
      openclaw: false,
      cline: false,
      windsurf: false,
      "copilot-cli": false,
    });
    const result = patchedDetect();
    expect(result["opencode"]).toBe(false);
    expect(result["openclaw"]).toBe(false);
  });

  it("test_detect_installed_harnesses_codex_via_env", () => {
    // Codex should be detected when CODEX_HOME env var is set.
    const home = freshTmp("cdx-home-");
    process.env["CODEX_HOME"] = nodePath.join(home, "codex");
    const result = detect_installed_harnesses();
    expect(result["codex"]).toBe(true);
  });

  it("test_detect_installed_harnesses_codex_via_dir", () => {
    // Codex should be detected when ~/.codex directory exists.
    // Python mocks codex_dir() directly; the TS impl calls codex_dir() = join(
    // _home(), ".codex"), which is not interceptable via spyOn. We instead point
    // home at a tmp dir and create the real .codex directory under it.
    const home = freshTmp("cdx-home-");
    fs.mkdirSync(nodePath.join(home, ".codex"));
    setHome(home);
    delete process.env["CODEX_HOME"];
    // Sanity: the mocked home indeed yields an existing codex dir.
    expect(fs.existsSync(codex_dir())).toBe(true);

    const result = detect_installed_harnesses();
    expect(result["codex"]).toBe(true);
  });

  it("test_detect_installed_harnesses_codex_false_when_absent", () => {
    // Codex should not be detected when env var absent and dir doesn't exist.
    const home = freshTmp("cdx-home-");
    // Do NOT create .codex under home.
    setHome(home);
    delete process.env["CODEX_HOME"];

    const result = detect_installed_harnesses();
    expect(result["codex"]).toBe(false);
  });

  it("test_detect_installed_harnesses_gemini_via_dir", () => {
    // Gemini should be detected when ~/.gemini directory exists.
    const home = freshTmp("gem-home-");
    fs.mkdirSync(nodePath.join(home, ".gemini"));
    setHome(home);
    const result = detect_installed_harnesses();
    expect(result["gemini"]).toBe(true);
  });

  it("test_detect_installed_harnesses_preserves_backward_compat", () => {
    // detect_harnesses() should still work and use the dict version.
    const harnessesList = detect_harnesses();
    const harnessesDict = detect_installed_harnesses();

    // The list should match the keys in the dict where value is True.
    let detectedFromDict = Object.entries(harnessesDict)
      .filter(([, installed]) => installed)
      .map(([name]) => name);
    detectedFromDict = [
      "claude",
      ...detectedFromDict.filter((name) => name !== "claude").sort(),
    ];
    expect(new Set(harnessesList)).toEqual(new Set(detectedFromDict));
  });
});
