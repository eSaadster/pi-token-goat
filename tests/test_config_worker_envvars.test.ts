/**
 * Tests for config.ts — TOKEN_GOAT_WORKER_WATCHDOG and related worker env-var
 * overrides.
 *
 * Faithful 1:1 TS port of tests/test_config_worker_envvars.py.
 *   - class TestWorkerWatchdogEnvVar          -> describe
 *   - class TestMalformedTomlFallsBackToDefaults -> describe
 *   - each `def test_*`                        -> it() with the same name + polarity
 *
 * Test-seam mapping (Python -> TS):
 *  - monkeypatch.setattr(paths, "config_path", lambda: tmp/"config.toml")
 *      -> setConfigPathOverride(<written file>) from paths.js.
 *  - cfg_mod._config_mtime_cache = None  (the _reset_cfg_cache helper)
 *      -> clearConfigCache() from config.js.
 *  - monkeypatch.setenv / delenv
 *      -> direct process.env assignment / delete; the per-test env snapshot
 *        below restores the world after each test (monkeypatch is fn-scoped).
 *  - caplog.at_level(WARNING, logger="token_goat.config")
 *      -> vi.spyOn(console, "warn"); util.ts forwards WARNING -> console.warn
 *        with a `[token_goat.config] <msg>` prefix, so substring assertions on
 *        the joined args translate directly.
 *  - tmp_path fixture
 *      -> a per-call mkdtemp dir under os.tmpdir().
 *
 * NOTE: these cases are also covered inside tests/test_config.test.ts (which
 * folded the config-worker-envvar suite in). This dedicated file mirrors the
 * Python source file 1:1 as requested; both must stay green.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { clearConfigCache, load } from "../src/token_goat/config.js";
import {
  clearConfigPathOverride,
  setConfigPathOverride,
} from "../src/token_goat/paths.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** cfg_mod._config_mtime_cache = None */
function _resetCfgCache(): void {
  clearConfigCache();
}

/**
 * Write `body` to a fresh tmp config file and redirect configPath() to it.
 * Mirrors `tmp_path / "config.toml"` + monkeypatch.setattr(paths, "config_path").
 */
function writeConfig(body: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tg-cfg-wenv-"));
  const file = path.join(dir, "config.toml");
  fs.writeFileSync(file, body, "utf8");
  setConfigPathOverride(file);
  return file;
}

// Snapshot the entire process.env so any TOKEN_GOAT_* mutation a test makes is
// reverted (reproduces monkeypatch.setenv/delenv's function scope).
let _envSnapshot: Record<string, string | undefined> = {};

beforeEach(() => {
  _envSnapshot = { ...process.env };
  clearConfigCache();
  clearConfigPathOverride();
});

afterEach(() => {
  for (const k of Object.keys(process.env)) {
    if (!(k in _envSnapshot)) {
      delete process.env[k];
    }
  }
  for (const [k, v] of Object.entries(_envSnapshot)) {
    if (v === undefined) {
      delete process.env[k];
    } else {
      process.env[k] = v;
    }
  }
  vi.restoreAllMocks();
  clearConfigCache();
  clearConfigPathOverride();
});

// ---------------------------------------------------------------------------
// TestWorkerWatchdogEnvVar
// ---------------------------------------------------------------------------

describe("TestWorkerWatchdogEnvVar", () => {
  it("test_watchdog_enabled_by_default", () => {
    // With no env var, watchdog_enabled defaults to True.
    writeConfig("");
    delete process.env.TOKEN_GOAT_WORKER_WATCHDOG;
    _resetCfgCache();

    const cfg = load();
    expect(cfg.worker?.watchdog_enabled).toBe(true);
  });

  it("test_watchdog_disabled_by_env_zero", () => {
    // TOKEN_GOAT_WORKER_WATCHDOG=0 disables watchdog_enabled.
    writeConfig("");
    process.env.TOKEN_GOAT_WORKER_WATCHDOG = "0";
    _resetCfgCache();

    const cfg = load();
    expect(cfg.worker?.watchdog_enabled).toBe(false);
  });

  it("test_watchdog_disabled_by_env_false", () => {
    // TOKEN_GOAT_WORKER_WATCHDOG=false disables watchdog_enabled.
    writeConfig("");
    process.env.TOKEN_GOAT_WORKER_WATCHDOG = "false";
    _resetCfgCache();

    const cfg = load();
    expect(cfg.worker?.watchdog_enabled).toBe(false);
  });

  it("test_watchdog_disabled_by_env_no", () => {
    // TOKEN_GOAT_WORKER_WATCHDOG=no disables watchdog_enabled.
    writeConfig("");
    process.env.TOKEN_GOAT_WORKER_WATCHDOG = "no";
    _resetCfgCache();

    const cfg = load();
    expect(cfg.worker?.watchdog_enabled).toBe(false);
  });

  it("test_watchdog_disabled_by_env_off", () => {
    // TOKEN_GOAT_WORKER_WATCHDOG=off disables watchdog_enabled.
    writeConfig("");
    process.env.TOKEN_GOAT_WORKER_WATCHDOG = "off";
    _resetCfgCache();

    const cfg = load();
    expect(cfg.worker?.watchdog_enabled).toBe(false);
  });

  it("test_watchdog_toml_false_kept_without_env", () => {
    // TOML watchdog_enabled=false is respected when env var is absent.
    writeConfig("[worker]\nwatchdog_enabled = false\n");
    delete process.env.TOKEN_GOAT_WORKER_WATCHDOG;
    _resetCfgCache();

    const cfg = load();
    expect(cfg.worker?.watchdog_enabled).toBe(false);
  });

  it("test_watchdog_env_overrides_toml_true", () => {
    // Env var=0 overrides TOML watchdog_enabled=true.
    writeConfig("[worker]\nwatchdog_enabled = true\n");
    process.env.TOKEN_GOAT_WORKER_WATCHDOG = "0";
    _resetCfgCache();

    const cfg = load();
    expect(cfg.worker?.watchdog_enabled).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// TestMalformedTomlFallsBackToDefaults
// ---------------------------------------------------------------------------

describe("TestMalformedTomlFallsBackToDefaults", () => {
  it("test_malformed_toml_returns_default_config", () => {
    // A syntactically invalid TOML file yields a config with all defaults.
    writeConfig("this is not valid toml = [[[\n");
    _resetCfgCache();

    // Must not raise — load() catches the parse error and uses defaults.
    const cfg = load();

    // A sampling of defaults to confirm fallback worked:
    expect(cfg.worker?.watchdog_enabled).toBe(true);
    expect(cfg.worker?.max_pool_workers).toBe(4);
  });

  it("test_malformed_toml_logs_warning", () => {
    // A malformed TOML file causes a warning log entry.
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    writeConfig("[broken\n");
    _resetCfgCache();

    load();

    const msgs = warnSpy.mock.calls.map((c) => c.map(String).join(" "));
    expect(
      msgs.some((s) => s.includes("config load failed") || s.includes("load failed")),
      `expected a warning log about config load failure; got: ${JSON.stringify(msgs)}`,
    ).toBe(true);
  });
});
