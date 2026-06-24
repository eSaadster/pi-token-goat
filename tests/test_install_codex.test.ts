/**
 * Tests for Codex install/uninstall — Phase 18.
 *
 * 1:1 port of tests/test_install_codex.py.
 *
 * Test-seam mapping (Python -> TS):
 *  - conftest `patched_home` (monkeypatch Path.home() at <tmp>/home) ->
 *    set process.env.HOME to <fakeHome>. install.ts resolves every ~/.codex path
 *    through `os.homedir()`, which on POSIX honours $HOME (Node's os.homedir is
 *    NOT spyable — its namespace binding is non-configurable — so the env route
 *    is the working seam, per the iter11 port note). One env var redirects the
 *    whole tree, mirroring the Python fixture.
 *  - tomli_w.dumps / tomllib.loads -> smol-toml stringify/parse (the same TOML
 *    engine install.ts itself uses).
 *  - monkeypatch.setattr(install, "token_goat_binary", ...) /
 *    monkeypatch.setattr(install, "_run_schtasks", ...) -> these patch
 *    module-private helpers that are NOT exported from install.ts. The TS port
 *    cannot reach _run_schtasks; instead we install a no-op subprocess runner
 *    via install.setSubprocessRunner so launchctl/systemctl/crontab/schtasks are
 *    never forked (the spawn-safety requirement), and spy worker.ensure_running
 *    to a fixed pid (the analogue of patch("token_goat.worker.ensure_running",
 *    return_value=99999)).
 *  - patch("token_goat.install.paths.ensure_dirs") -> vi.spyOn(paths,
 *    "ensureDirs"); install.ts calls it through the `import * as paths` namespace
 *    so the spy is observed.
 *  - patch("token_goat.install.paths.worker_pid_path", ...) -> vi.spyOn(paths,
 *    "workerPidPath") so _stop_worker reads a throwaway pid path (and the file
 *    is absent -> "stopped", no process killed).
 *
 * Deferred:
 *  - test_patch_codex_config_total_count_stable_across_three_installs and
 *    test_codex_config_token_goat_count_zero_when_absent call
 *    install._codex_config_token_goat_count, which is module-private (not
 *    exported from install.ts) -> reported as a missing export and skipped.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parse as tomlParse, stringify as tomlStringify } from "smol-toml";

import * as install from "../src/token_goat/install.js";
import * as paths from "../src/token_goat/paths.js";
import * as worker from "../src/token_goat/worker.js";

// ---------------------------------------------------------------------------
// patched_home fixture analogue.
// ---------------------------------------------------------------------------
let _savedHome: string | undefined;

function patchedHome(): string {
  const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "tg-codex-home-")));
  const home = path.join(tmp, "home");
  fs.mkdirSync(home, { recursive: true });
  process.env["HOME"] = home;
  return home;
}

beforeEach(() => {
  _savedHome = process.env["HOME"];
  // Default: a no-op subprocess runner so no real schtasks/launchctl/systemctl/
  // crontab process is ever forked by install_all/uninstall_all.
  install.setSubprocessRunner(() => ({
    returncode: 0,
    stdout: "",
    stderr: "",
    failed: false,
    error: "",
  }));
});

afterEach(() => {
  install.setSubprocessRunner(null);
  vi.restoreAllMocks();
  if (_savedHome === undefined) {
    delete process.env["HOME"];
  } else {
    process.env["HOME"] = _savedHome;
  }
});

// ---------------------------------------------------------------------------
// 1. patch_codex_config on missing file -> creates valid TOML with our hooks
// ---------------------------------------------------------------------------

describe("test_install_codex", () => {
  it("test_patch_codex_config_creates_file", () => {
    patchedHome();
    const cfgPath = install.patch_codex_config("token-goat");

    expect(fs.existsSync(cfgPath)).toBe(true);
    const content = fs.readFileSync(cfgPath, "utf-8");
    expect(content).toContain("token_goat");
    expect(content.includes("SessionStart") || content.includes("session-start")).toBe(true);
  });

  // -------------------------------------------------------------------------
  // 2. patch_codex_config on existing config with other hooks -> preserves them
  // -------------------------------------------------------------------------
  it("test_patch_codex_config_preserves_existing", () => {
    const home = patchedHome();

    const codexDir = path.join(home, ".codex");
    fs.mkdirSync(codexDir, { recursive: true });
    const existing = {
      hooks: {
        PreToolUse: [
          {
            matcher: "Bash",
            hooks: [{ type: "command", command: "other-tool hook bash", timeout: 1000 }],
          },
        ],
      },
    };
    fs.writeFileSync(path.join(codexDir, "config.toml"), tomlStringify(existing), "utf-8");

    install.patch_codex_config("token-goat");

    const content = tomlParse(
      fs.readFileSync(path.join(codexDir, "config.toml"), "utf-8"),
    ) as { hooks: { PreToolUse: Array<{ hooks?: Array<{ command: string }> }> } };
    const preEntries = content.hooks.PreToolUse;
    const allCommands: string[] = [];
    for (const e of preEntries) {
      for (const h of e.hooks ?? []) {
        allCommands.push(h.command);
      }
    }
    expect(allCommands.some((c) => c.includes("other-tool"))).toBe(true);
    expect(allCommands.some((c) => c.includes("token_goat"))).toBe(true);
  });

  // -------------------------------------------------------------------------
  // 3. patch_codex_config is idempotent
  // -------------------------------------------------------------------------
  it("test_patch_codex_config_idempotent", () => {
    const home = patchedHome();

    install.patch_codex_config("token-goat");
    install.patch_codex_config("token-goat");

    const cfgPath = path.join(home, ".codex", "config.toml");
    const content = tomlParse(fs.readFileSync(cfgPath, "utf-8")) as {
      hooks: Record<string, Array<{ hooks?: Array<{ command: string }> }>>;
    };

    const ssEntries = content.hooks.SessionStart ?? [];
    const twCmds: string[] = [];
    for (const e of ssEntries) {
      for (const h of e.hooks ?? []) {
        if (h.command.includes("token_goat")) {
          twCmds.push(h.command);
        }
      }
    }
    expect(twCmds.length).toBe(1);
  });

  // patch_codex_config three times -> token-goat hook count must be stable.
  // Parallel to the Claude-side idempotent-count check; catches drift across the
  // full event registry (PreToolUse, PostToolUse, PreCompact), not just
  // SessionStart.
  it("test_patch_codex_config_total_count_stable_across_three_installs", () => {
    patchedHome();

    install.patch_codex_config("token-goat");
    const countFirst = install._codex_config_token_goat_count();
    install.patch_codex_config("token-goat");
    const countSecond = install._codex_config_token_goat_count();
    install.patch_codex_config("token-goat");
    const countThird = install._codex_config_token_goat_count();

    expect(countFirst).toBe(countSecond);
    expect(countSecond).toBe(countThird);
    expect(countFirst).toBeGreaterThan(0);
  });

  // _codex_config_token_goat_count returns 0 when the config doesn't exist.
  // Guards the helper's tolerance contract — verify/plan should never crash just
  // because codex was never installed.
  it("test_codex_config_token_goat_count_zero_when_absent", () => {
    // patchedHome gives a fresh ~/.codex directory that doesn't exist yet.
    patchedHome();
    expect(install._codex_config_token_goat_count()).toBe(0);
  });

  // -------------------------------------------------------------------------
  // 4. unpatch_codex_config removes only token-goat entries
  // -------------------------------------------------------------------------
  it("test_unpatch_codex_config_removes_token_goat", () => {
    const home = patchedHome();

    const codexDir = path.join(home, ".codex");
    fs.mkdirSync(codexDir, { recursive: true });
    const existing = {
      hooks: {
        PreToolUse: [
          {
            matcher: "Bash",
            hooks: [{ type: "command", command: "other-tool hook bash", timeout: 1000 }],
          },
        ],
      },
    };
    fs.writeFileSync(path.join(codexDir, "config.toml"), tomlStringify(existing), "utf-8");

    install.patch_codex_config("token-goat");
    install.unpatch_codex_config();

    const content = tomlParse(
      fs.readFileSync(path.join(codexDir, "config.toml"), "utf-8"),
    ) as { hooks?: Record<string, Array<{ hooks?: Array<{ command: string }> }>> };
    const allCmds: string[] = [];
    for (const entries of Object.values(content.hooks ?? {})) {
      for (const e of entries) {
        for (const h of e.hooks ?? []) {
          allCmds.push(h.command);
        }
      }
    }
    expect(allCmds.some((c) => c.includes("token_goat"))).toBe(false);
    expect(allCmds.some((c) => c.includes("other-tool"))).toBe(true);
  });

  // -------------------------------------------------------------------------
  // 5. patch_codex_agents_md creates the file with delimited block
  // -------------------------------------------------------------------------
  it("test_patch_codex_agents_md_creates_file", () => {
    const home = patchedHome();

    install.patch_codex_agents_md();

    const mdPath = path.join(home, ".codex", "AGENTS.md");
    expect(fs.existsSync(mdPath)).toBe(true);
    const content = fs.readFileSync(mdPath, "utf-8");
    expect(content).toContain(install.CODEX_AGENTS_BEGIN);
    expect(content).toContain(install.CODEX_AGENTS_END);
    expect(content).toContain("token-goat");
    expect(content).toContain("Get-Content");
  });

  // -------------------------------------------------------------------------
  // 6. unpatch_codex_agents_md removes the block
  // -------------------------------------------------------------------------
  it("test_unpatch_codex_agents_md_removes_block", () => {
    const home = patchedHome();

    install.patch_codex_agents_md();
    install.unpatch_codex_agents_md();

    const mdPath = path.join(home, ".codex", "AGENTS.md");
    const content = fs.readFileSync(mdPath, "utf-8");
    expect(content).not.toContain(install.CODEX_AGENTS_BEGIN);
    expect(content).not.toContain(install.CODEX_AGENTS_END);
  });

  // -------------------------------------------------------------------------
  // 7. patch_codex_agents_md is idempotent (running twice -> one block)
  // -------------------------------------------------------------------------
  it("test_patch_codex_agents_md_idempotent", () => {
    const home = patchedHome();

    install.patch_codex_agents_md();
    install.patch_codex_agents_md();

    const mdPath = path.join(home, ".codex", "AGENTS.md");
    const content = fs.readFileSync(mdPath, "utf-8");
    expect(content.split(install.CODEX_AGENTS_BEGIN).length - 1).toBe(1);
    expect(content.split(install.CODEX_AGENTS_END).length - 1).toBe(1);
  });

  it("test_patch_codex_agents_md_strips_legacy_tokenwise_block", () => {
    const home = patchedHome();

    const codexDir = path.join(home, ".codex");
    fs.mkdirSync(codexDir, { recursive: true });
    const legacyBlock =
      `${install.LEGACY_CODEX_AGENTS_BEGIN}\n` +
      "## tokenwise - route code reads through tokenwise first (Codex)\n\n" +
      "| Goal | Do this | Not this |\n" +
      "|------|---------|----------|\n" +
      "| Find a function | `tokenwise symbol X` | `rg X` |\n" +
      `${install.LEGACY_CODEX_AGENTS_END}\n`;
    const mdPath = path.join(codexDir, "AGENTS.md");
    fs.writeFileSync(mdPath, legacyBlock, "utf-8");

    install.patch_codex_agents_md();
    const content = fs.readFileSync(mdPath, "utf-8");

    expect(content).toContain(install.CODEX_AGENTS_BEGIN);
    expect(content).toContain(install.CODEX_AGENTS_END);
    expect(content).not.toContain(install.LEGACY_CODEX_AGENTS_BEGIN);
    expect(content).not.toContain(install.LEGACY_CODEX_AGENTS_END);
    expect(content).not.toContain("tokenwise symbol X");
  });

  it("test_patch_codex_agents_md_legacy_strip_is_idempotent", () => {
    const home = patchedHome();

    const codexDir = path.join(home, ".codex");
    fs.mkdirSync(codexDir, { recursive: true });
    const seed =
      `${install.LEGACY_CODEX_AGENTS_BEGIN}\n` +
      "legacy body\n" +
      `${install.LEGACY_CODEX_AGENTS_END}\n`;
    const mdPath = path.join(codexDir, "AGENTS.md");
    fs.writeFileSync(mdPath, seed, "utf-8");

    install.patch_codex_agents_md();
    install.patch_codex_agents_md();
    const content = fs.readFileSync(mdPath, "utf-8");

    expect(content.split(install.CODEX_AGENTS_BEGIN).length - 1).toBe(1);
    expect(content.split(install.CODEX_AGENTS_END).length - 1).toBe(1);
    expect(content).not.toContain(install.LEGACY_CODEX_AGENTS_BEGIN);
    expect(content).not.toContain(install.LEGACY_CODEX_AGENTS_END);
  });

  // -------------------------------------------------------------------------
  // 8. patch_codex_agents_md appends to existing file without our block
  // -------------------------------------------------------------------------
  it("test_patch_codex_agents_md_appends", () => {
    const home = patchedHome();

    const codexDir = path.join(home, ".codex");
    fs.mkdirSync(codexDir, { recursive: true });
    fs.writeFileSync(path.join(codexDir, "AGENTS.md"), "# Existing content\n", "utf-8");

    install.patch_codex_agents_md();

    const content = fs.readFileSync(path.join(codexDir, "AGENTS.md"), "utf-8");
    expect(content).toContain("Existing content");
    expect(content).toContain(install.CODEX_AGENTS_BEGIN);
  });

  // -------------------------------------------------------------------------
  // 9. install_all(install_codex=True) writes both Codex files
  // -------------------------------------------------------------------------
  it("test_install_all_codex_flag", () => {
    const home = patchedHome();
    vi.spyOn(install, "token_goat_binary").mockReturnValue("token-goat");

    // schtasks/launchctl/systemctl/crontab are stubbed via the no-op subprocess
    // runner installed in beforeEach (fake_schtasks analogue). The fresh-machine
    // "/Query" -> not-found branch is irrelevant on darwin/linux test hosts.
    vi.spyOn(paths, "ensureDirs").mockImplementation(() => {});
    vi.spyOn(worker, "ensure_running").mockReturnValue(99999);

    const result = install.install_all(true);

    expect("codex: config.toml" in result).toBe(true);
    expect("codex: AGENTS.md" in result).toBe(true);
    expect(result["codex: config.toml"]).toContain("ok");
    expect(result["codex: AGENTS.md"]).toContain("ok");

    expect(fs.existsSync(path.join(home, ".codex", "config.toml"))).toBe(true);
    expect(fs.existsSync(path.join(home, ".codex", "AGENTS.md"))).toBe(true);
  });

  // -------------------------------------------------------------------------
  // 10. uninstall_all(codex=True) cleans up Codex files
  // -------------------------------------------------------------------------
  it("test_uninstall_all_codex_flag", () => {
    const home = patchedHome();
    vi.spyOn(install, "token_goat_binary").mockReturnValue("token-goat");

    vi.spyOn(paths, "ensureDirs").mockImplementation(() => {});
    vi.spyOn(worker, "ensure_running").mockReturnValue(99999);

    // Install Codex first.
    install.install_all(true);

    // Now uninstall with codex=True. worker_pid_path -> a throwaway path that
    // doesn't exist, so _stop_worker returns "stopped" without killing anything.
    const stopTmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "tg-codex-stop-")));
    vi.spyOn(paths, "workerPidPath").mockReturnValue(path.join(stopTmp, "w.pid"));

    const result = install.uninstall_all(false, true);

    expect("codex: config.toml" in result).toBe(true);
    expect("codex: AGENTS.md" in result).toBe(true);

    const cfgPath = path.join(home, ".codex", "config.toml");
    if (fs.existsSync(cfgPath)) {
      const content = tomlParse(fs.readFileSync(cfgPath, "utf-8")) as {
        hooks?: Record<string, Array<{ hooks?: Array<{ command: string }> }>>;
      };
      const allCmds: string[] = [];
      for (const entries of Object.values(content.hooks ?? {})) {
        for (const e of entries) {
          for (const h of e.hooks ?? []) {
            allCmds.push(h.command);
          }
        }
      }
      expect(allCmds.some((c) => c.includes("token_goat"))).toBe(false);
    }

    const mdPath = path.join(home, ".codex", "AGENTS.md");
    if (fs.existsSync(mdPath)) {
      const content = fs.readFileSync(mdPath, "utf-8");
      expect(content).not.toContain(install.CODEX_AGENTS_BEGIN);
    }
  });

  // -------------------------------------------------------------------------
  // 11. detect_harnesses: codex detected when CODEX_HOME is set
  // -------------------------------------------------------------------------
  //
  // NOTE on the codex_dir seam: Python patches install.codex_dir directly, but
  // in the TS port detect_installed_harnesses() calls codex_dir() through a
  // LOCAL binding (a bare module-internal call), so vi.spyOn(install,
  // "codex_dir") would NOT propagate. We instead drive the same branches by
  // (a) setting CODEX_HOME (env takes precedence) and (b) materialising /
  // omitting <fakeHome>/.codex so the real codex_dir() resolves to a present /
  // absent directory — faithful to each test's intent.
  it("test_detect_harnesses_codex_home_env", () => {
    patchedHome();
    const prev = process.env["CODEX_HOME"];
    process.env["CODEX_HOME"] = "/some/codex/path";
    try {
      // fakeHome/.codex is absent; only the env-var path fires.
      const result = install.detect_harnesses();
      expect(result).toContain("claude");
      expect(result).toContain("codex");
    } finally {
      if (prev === undefined) {
        delete process.env["CODEX_HOME"];
      } else {
        process.env["CODEX_HOME"] = prev;
      }
    }
  });

  it("test_detect_harnesses_codex_dir_present", () => {
    const home = patchedHome();
    const prev = process.env["CODEX_HOME"];
    delete process.env["CODEX_HOME"];
    try {
      fs.mkdirSync(path.join(home, ".codex"), { recursive: true });
      const result = install.detect_harnesses();
      expect(result).toContain("codex");
    } finally {
      if (prev === undefined) {
        delete process.env["CODEX_HOME"];
      } else {
        process.env["CODEX_HOME"] = prev;
      }
    }
  });

  it("test_detect_harnesses_no_codex", () => {
    patchedHome();
    const prev = process.env["CODEX_HOME"];
    delete process.env["CODEX_HOME"];
    try {
      // fakeHome/.codex does not exist and CODEX_HOME is unset.
      const result = install.detect_harnesses();
      expect(result).toContain("claude");
      expect(result).not.toContain("codex");
    } finally {
      if (prev === undefined) {
        delete process.env["CODEX_HOME"];
      } else {
        process.env["CODEX_HOME"] = prev;
      }
    }
  });
});
