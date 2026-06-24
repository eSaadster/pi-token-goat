/**
 * vitest setupFiles module — the TS port of tests/conftest.py's autouse guards.
 *
 * Wired via `setupFiles: ["tests/setup.ts"]` in vitest.config.ts. vitest runs
 * this file once per test file (the forks pool gives file-level isolation, the
 * TS analogue of pytest-xdist --dist=loadscope). The beforeEach/afterEach
 * below then run around every individual `it()` in that file, reproducing the
 * function-scoped autouse fixtures conftest.py applied to every Python test.
 *
 * JS has no monkeypatch, so the ~9 module-level caches Python's conftest
 * cleared via direct dict mutation are exposed through an explicit reset
 * registry — src/token_goat/reset.ts (the "linchpin test seam" from
 * PORT-PLAN.md §3). This file is its sole consumer: every test starts from a
 * clean cache graph and an isolated data dir, so a stale entry from one test
 * can never leak into the next.
 *
 * Ported conftest behaviors (per-test, in beforeEach):
 *   - tmp_data_dir          -> setDataDirOverride(per-test tmp dir)
 *   - cache clearing        -> clearModuleCaches() + clearDataDirOverride()
 *   - _pin_claudecode_harness -> TOKEN_GOAT_HARNESS_OVERRIDE=claudecode
 *   - _suppress_real_spawns -> TOKEN_GOAT_NO_WORKER_SPAWN=1
 *
 * Deferred (no TS seam exists yet — see file-bottom notes):
 *   isolate_hooks_stderr_log, isolate_registry, isolate_worker_autostart,
 *   isolate_hook_logging, _disable_user_git_hooks.
 */
import { afterEach, beforeEach } from "vitest";

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  clearDataDirOverride,
  clearModuleCaches,
  setDataDirOverride,
} from "../src/token_goat/reset.js";

// ---------------------------------------------------------------------------
// Per-test tmp data dir factory.
//
// conftest.py used pytest's tmp_path (function-scoped). vitest gives us no such
// fixture inside setupFiles, so we build one from node:os/fs/path. Uniqueness
// across tests in a single fork worker must NOT rely on Date.now() (two tests
// starting in the same millisecond would collide). A monotonic counter scoped
// to this module + process.pid + vitest's per-test task id guarantees a unique
// path even under concurrent forks: each fork is its own process (distinct pid)
// and the counter increments within a fork.
//
// Per PORT-PLAN §7 the original design note said "per file"; the reset registry
// makes per-test isolation as cheap as per-file, and per-test is strictly safer
// (matches the function-scoped tmp_data_dir fixture, not the module-scoped one)
// so we isolate every it().
// ---------------------------------------------------------------------------
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "tg-data-"));
let dirCounter = 0;

function makeDataDir(): string {
  // process.pid disambiguates across fork workers; dirCounter across tests in
  // one worker. No Date.now — collision-free by construction.
  const dir = path.join(tmpRoot, `d-${process.pid}-${dirCounter++}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

// ---------------------------------------------------------------------------
// TOKEN_GOAT_* env defaults conftest pins for every test.
//
// Python pinned these via two autouse fixtures:
//   _pin_claudecode_harness (function-scoped monkeypatch.setenv)
//   _suppress_real_spawns   (session-scoped os.environ)
// Both reduce to "set these env vars before each test." We set/restore them
// around each test so a test that intentionally delenv's one (conftest allows
// the function-scoped monkeypatch to win) still sees the default restored for
// the next test.
// ---------------------------------------------------------------------------
const ENV_DEFAULTS: Record<string, string> = {
  // manifest output must be env-independent: on a Claude Code dev box the
  // ambient CLAUDE_CODE_SESSION_ID probe resolves to "claudecode", on a bare
  // shell to "generic". Pin claudecode everywhere so 51 manifest assertions
  // don't flip.
  TOKEN_GOAT_HARNESS_OVERRIDE: "claudecode",
  // spawn_detached()/spawn_index_detached() short-circuit to None when set, so
  // no code path reaching a spawn can orphan a daemon after the suite exits.
  TOKEN_GOAT_NO_WORKER_SPAWN: "1",
};

let savedEnv: Record<string, string | undefined> = {};
let savedHomeEnv: { HOME: string | undefined; USERPROFILE: string | undefined } | null = null;

beforeEach(() => {
  // (1) Reset the cache graph to a blank slate. clearDataDirOverride() first
  //     so any override a prior test left dangling is gone before we read the
  //     default; clearModuleCaches() then drops the ~9 module-level caches
  //     (session._proc_load_cache, compact.* caches, config mtime, ...) that
  //     would otherwise carry stale entries keyed on the previous data dir.
  clearDataDirOverride();
  clearModuleCaches();

  // (2) Isolate the data dir: each test writes under its own throwaway dir,
  //     exactly like the function-scoped tmp_data_dir fixture.
  setDataDirOverride(makeDataDir());

  // (2b) Sandbox HOME (defense-in-depth). install.ts's _home() -> os.homedir()
  //      reads $HOME at call time, so redirecting HOME/USERPROFILE here routes
  //      EVERY home-derived path — ~/.claude/settings.json, ~/.claude/CLAUDE.md,
  //      the skill dir, the ~/Library/LaunchAgents plist — into a throwaway dir.
  //      This is the global backstop the conftest's opt-in patched_home fixture
  //      did NOT give the TS port: on 2026-06-24 a single test
  //      (test_install_all_includes_pregen_step) called the real install_all()
  //      with only an os.homedir() spy and clobbered the developer's real
  //      ~/.claude hooks + registered a launchd plist + a cron job. With HOME
  //      sandboxed here, no test — even one that forgets its own seam — can
  //      reach the real home. (Subprocess writes like crontab/launchctl ignore
  //      $HOME, so install_all callers must ALSO stub setSubprocessRunner; that
  //      is enforced per-test.)
  const fakeHome = fs.mkdtempSync(path.join(tmpRoot, "home-"));
  savedHomeEnv = {
    HOME: process.env["HOME"],
    USERPROFILE: process.env["USERPROFILE"],
  };
  process.env["HOME"] = fakeHome;
  process.env["USERPROFILE"] = fakeHome;

  // (3) Pin TOKEN_GOAT_* env defaults.
  savedEnv = {};
  for (const [key, value] of Object.entries(ENV_DEFAULTS)) {
    savedEnv[key] = process.env[key];
    process.env[key] = value;
  }
});

afterEach(() => {
  // Restore env first so teardown of later seams sees the original world.
  for (const [key, prev] of Object.entries(savedEnv)) {
    if (prev === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = prev;
    }
  }
  savedEnv = {};

  // Restore HOME/USERPROFILE (the (2b) sandbox).
  if (savedHomeEnv) {
    if (savedHomeEnv.HOME === undefined) delete process.env["HOME"];
    else process.env["HOME"] = savedHomeEnv.HOME;
    if (savedHomeEnv.USERPROFILE === undefined) delete process.env["USERPROFILE"];
    else process.env["USERPROFILE"] = savedHomeEnv.USERPROFILE;
    savedHomeEnv = null;
  }

  // Clear the override + caches so nothing holds the tmp dir open.
  try {
    clearDataDirOverride();
    clearModuleCaches();
  } catch {
    // best-effort — a failing clear must not mask the real test failure.
  }
});

// ---------------------------------------------------------------------------
// Whole-process tmp-root cleanup.
//
// vitest has no "after the entire run" hook inside a setupFiles module the way
// globalSetup has, so we register against process exit as a backstop. rmSync
// recursive + force ignores ENOENT and partially-deleted trees. Best-effort:
// wrapped in try/catch so a wedged file handle never fails the run.
// ---------------------------------------------------------------------------
process.on("exit", () => {
  try {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  } catch {
    // best-effort; OS tmp reaper will sweep it.
  }
});

// ===========================================================================
// Deferred conftest behaviors (documented — not yet portable to TS).
// ===========================================================================
// These conftest.py autouse fixtures have no TS-side seam yet. They are tracked
// here so the port does not silently drop them; each lands with its layer:
//
// - isolate_hooks_stderr_log (session): redirects hooks-stderr.log writes to a
//   session tmp file. Needs paths.ts to expose setHooksStderrLogOverride()
//   (Python paths.py:86 has it; Layer 1 ports paths). Until then, a test that
//   crashes a hook writes to the real log — acceptable for the seed, must be
//   restored before the hook-handler layers (L4/L5) ship.
//
// - isolate_registry / isolate_worker_autostart (function): replace winreg with
//   an in-memory fake and stub worker._register_autostart. Windows-only; lands
//   with the worker/install layer (L6).
//
// - isolate_hook_logging (function): patches hooks_cli._setup_logging to a
//   no-op and clears the "token_goat.hooks" logger handlers. Lands with
//   hooks_cli (L3).
//
// - _disable_user_git_hooks (session): sets GIT_CONFIG_* env to point
//   core.hooksPath at an empty dir so a global lefthook doesn't fire on every
//   test `git init/commit`. Lands with the git_history / compact integration
//   tests (L4) — add the GIT_CONFIG_COUNT/KEY_0/VALUE_0 triple to ENV_DEFAULTS
//   (as a session-pinned block) once those tests exist.
//
// - Hypothesis CI profile (module import-time): CI=-> max_examples=50, else
//   200. The TS port uses fast-check for the 2 property files; register the
//   equivalent fast-check configure() call when those tests land (L4).
// ===========================================================================
