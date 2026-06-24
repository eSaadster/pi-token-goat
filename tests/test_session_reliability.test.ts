/**
 * Unit tests for token_goat/session reliability edge cases. 1:1 port of
 * tests/test_session_reliability.py.
 *
 * Covers (per the Python module docstring):
 *  - Session file size cap (_trim_session_for_size / _get_session_max_bytes).
 *  - Stale session cleanup (cleanup_stale) at the 7-day cutoff.
 *  - Corruption recovery: load() returns a fresh session + logs a WARNING on bad
 *    JSON, and archives the corrupt file to .json.corrupt.*.
 *  - Stale sidecar cleanup: cleanup_stale() removes orphaned .json.lock/.flock.
 *  - Config corrupt-TOML fallback (regression).
 *  - _session_file_lock (the cross-process file-level lock).
 *
 * Test-seam mapping (Python -> TS):
 *  - session.paths.session_cache_path(id) -> paths.sessionCachePath(id). The
 *    snake_case name does not exist on the TS paths module; the camelCase helper
 *    resolves the same sessions/<id>.json path under the per-test data dir that
 *    setup.ts installs via setDataDirOverride.
 *  - tmp_data_dir fixture -> setup.ts already gives each it() its own isolated
 *    data dir (setDataDirOverride in beforeEach), so the session/lock/snapshot
 *    files resolve under a throwaway dir. We call the paths helpers; never
 *    hardcode tmp paths.
 *  - tmp_path fixture -> fs.mkdtempSync under the OS tmp dir (for the lock tests
 *    and the config-fallback tests that write a config file outside the data
 *    dir).
 *  - os.utime(p, (t, t)) -> fs.utimesSync(p, t, t).
 *  - monkeypatch.setenv/delenv -> process.env assign/delete; setup.ts snapshots
 *    and restores the two ENV_DEFAULTS keys, and an afterEach here restores
 *    TOKEN_GOAT_SESSION_MAX_BYTES so a test that sets it cannot leak.
 *  - monkeypatch.setattr(paths, "config_path", lambda: f) -> setConfigPathOverride(f).
 *  - cfg_mod._config_mtime_cache = None -> clearConfigCache().
 *  - caplog.at_level(WARNING, logger="token_goat.session"|"token_goat.config")
 *      -> vi.spyOn(console, "warn"). util.ts's ConsoleLogger forwards
 *         _LOG.warning(msg, ...args) to console.warn("[token_goat.<name>] " +
 *         msg, ...args); the format placeholders (%s, %d) are passed as separate
 *         args (not interpolated), so we join c.map(String) over each call's args
 *         before substring-asserting — and read mock.calls BEFORE mockRestore().
 *
 * Skipped (cannot be faithfully reproduced single-threaded / module not ported):
 *  - TestSessionStartStaleCleanup::test_session_start_calls_cleanup — needs
 *    token_goat.hooks_session, which is not yet ported. it.skip.
 *  - TestSessionFileLock::test_concurrent_writes_no_data_corruption — needs real
 *    Python threading (8 concurrent threads racing the lock). Node's main module
 *    is single-threaded and cannot mirror it. it.skip.
 *
 * Parity notes on the lock tests:
 *  - Python's _session_file_lock branched on _IS_WINDOWS (fcntl on POSIX, an
 *    O_EXCL `.flock` sidecar on Windows). The TS port uses the O_EXCL `.flock`
 *    sidecar on BOTH platforms (Node has neither fcntl nor msvcrt), so the
 *    Windows-branch assertions (sidecar present while held, gone after release)
 *    hold on the real POSIX test host WITHOUT monkeypatching _IS_WINDOWS (which
 *    is a non-exported module const). The POSIX test's only assertion runs AFTER
 *    the with-block (sidecar removed), which is also true in the TS port, so it
 *    is ported faithfully too.
 *  - The contextmanager becomes a higher-order function: `with _session_file_lock(p): BODY`
 *    -> `_session_file_lock(p, () => { BODY })`. Assertions made "during the
 *    body" run inside the callback; assertions "after release" run after the call.
 *
 * Every Python `def test_*` maps to a vitest `it()` with the same name and
 * assertion polarity. Each Python test class maps to a describe() block.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import * as session from "../src/token_goat/session.js";
import * as hooks_session from "../src/token_goat/hooks_session.js";
import * as paths from "../src/token_goat/paths.js";
import { clearConfigCache, load as configLoad } from "../src/token_goat/config.js";
import {
  clearConfigPathOverride,
  setConfigPathOverride,
} from "../src/token_goat/paths.js";

// ---------------------------------------------------------------------------
// Helpers (1:1 with the Python module-level helpers).
// ---------------------------------------------------------------------------

/** Return a fresh empty SessionCache without touching disk. */
function _make_cache(session_id = "test-size-cap"): session.SessionCache {
  const now = Date.now() / 1000;
  return new session.SessionCache({
    session_id,
    started_ts: now,
    last_activity_ts: now,
  });
}

/** Stuff *n* large ResultCacheEntry objects into cache.result_cache. */
function _bloat_result_cache(cache: session.SessionCache, n = 200): void {
  const now = Date.now() / 1000;
  for (let i = 0; i < n; i++) {
    const key = `src/mod${i}.py::function_${i}`;
    cache.result_cache[key] = new session.ResultCacheEntry({
      file_sha: "abc123",
      kind: "symbol",
      result: { source: "x".repeat(500), line_start: i, line_end: i + 20 },
      ts: now + i,
    });
  }
}

/** Stuff *n* BashEntry objects into cache.bash_history. */
function _bloat_bash_history(cache: session.SessionCache, n = 75): void {
  const now = Date.now() / 1000;
  for (let i = 0; i < n; i++) {
    const sha = `sha${String(i).padStart(4, "0")}`;
    cache.bash_history[sha] = new session.BashEntry({
      cmd_sha: sha,
      cmd_preview: `pytest tests/test_${i}.py -v --tb=long --cov=src`.repeat(3),
      output_id: `out-${i}`,
      ts: now + i,
      stdout_bytes: 8000,
      stderr_bytes: 500,
    });
  }
}

/** Stuff *n* entries into cache.hints_seen. */
function _bloat_hints_seen(cache: session.SessionCache, n = 500): void {
  for (let i = 0; i < n; i++) {
    cache.hints_seen[`fingerprint_${String(i).padStart(4, "0")}`] = i + 1;
  }
}

/** Stuff *n* GrepEntry objects into cache.greps. */
function _bloat_greps(cache: session.SessionCache, n = 75): void {
  const now = Date.now() / 1000;
  for (let i = 0; i < n; i++) {
    cache.greps.push(
      new session.GrepEntry({
        pattern: `def function_${i}`.repeat(5),
        path: `src/module_${i}.py`,
        ts: now + i,
        result_count: i,
      }),
    );
  }
}

/** Join every recorded console.* call into substring-searchable strings. */
function joinCalls(spy: { mock: { calls: unknown[][] } }): string[] {
  return spy.mock.calls.map((c) => c.map(String).join(" "));
}

// setup.ts only snapshots TOKEN_GOAT_HARNESS_OVERRIDE / TOKEN_GOAT_NO_WORKER_SPAWN.
// Several size-cap tests set TOKEN_GOAT_SESSION_MAX_BYTES, so restore it per test.
let _savedMaxBytes: string | undefined;
beforeEach(() => {
  _savedMaxBytes = process.env.TOKEN_GOAT_SESSION_MAX_BYTES;
});
afterEach(() => {
  if (_savedMaxBytes === undefined) {
    delete process.env.TOKEN_GOAT_SESSION_MAX_BYTES;
  } else {
    process.env.TOKEN_GOAT_SESSION_MAX_BYTES = _savedMaxBytes;
  }
  vi.restoreAllMocks();
});

// ===========================================================================
// Session size cap
// ===========================================================================

describe("TestSessionSizeCap", () => {
  it("test_no_trim_when_under_limit", () => {
    const cache = _make_cache();
    const trimmed = session._trim_session_for_size(cache, 2 * 1024 * 1024);
    expect(trimmed).toBeFalsy();
  });

  it("test_trim_result_cache_when_over_limit", () => {
    const cache = _make_cache();
    _bloat_result_cache(cache, 200);
    const original_size = Object.keys(cache.result_cache).length;
    const trimmed = session._trim_session_for_size(cache, 10_000);
    expect(trimmed).toBeTruthy();
    expect(Object.keys(cache.result_cache).length).toBeLessThan(original_size);
  });

  it("test_trim_bash_history_when_over_limit", () => {
    const cache = _make_cache();
    _bloat_bash_history(cache, 75);
    const original_size = Object.keys(cache.bash_history).length;
    const trimmed = session._trim_session_for_size(cache, 5_000);
    expect(trimmed).toBeTruthy();
    expect(Object.keys(cache.bash_history).length).toBeLessThan(original_size);
  });

  it("test_trim_hints_seen_when_over_limit", () => {
    const cache = _make_cache();
    _bloat_hints_seen(cache, 500);
    const original_size = Object.keys(cache.hints_seen).length;
    const trimmed = session._trim_session_for_size(cache, 5_000);
    expect(trimmed).toBeTruthy();
    expect(Object.keys(cache.hints_seen).length).toBeLessThan(original_size);
  });

  it("test_trim_greps_when_over_limit", () => {
    const cache = _make_cache();
    _bloat_greps(cache, 75);
    const original_size = cache.greps.length;
    const trimmed = session._trim_session_for_size(cache, 3_000);
    expect(trimmed).toBeTruthy();
    expect(cache.greps.length).toBeLessThan(original_size);
  });

  it("test_trim_preserves_files_dict", () => {
    const cache = _make_cache();
    const now = Date.now() / 1000;
    for (let i = 0; i < 50; i++) {
      const k = `src/file_${i}.py`;
      cache.files[k] = new session.FileEntry({
        rel_or_abs: k,
        last_read_ts: now,
        read_count: 1,
        line_ranges: [[1, 100]],
        symbols_read: [],
      });
    }
    _bloat_result_cache(cache, 200);
    const initial_files = new Set(Object.keys(cache.files));
    session._trim_session_for_size(cache, 5_000);
    expect(new Set(Object.keys(cache.files))).toEqual(initial_files);
  });

  it("test_trim_result_is_valid_json", () => {
    const cache = _make_cache();
    _bloat_result_cache(cache, 200);
    _bloat_bash_history(cache, 75);
    session._trim_session_for_size(cache, 20_000);
    let data: Record<string, unknown>;
    try {
      data = JSON.parse(cache.to_json()) as Record<string, unknown>;
    } catch {
      throw new Error("to_json() returned invalid JSON after trimming");
    }
    expect(data["session_id"]).toBe(cache.session_id);
  });

  it("test_trim_produces_smaller_json", () => {
    const cache = _make_cache();
    _bloat_result_cache(cache, 200);
    const before_json = cache.to_json();
    session._trim_session_for_size(cache, 10_000);
    cache._invalidate_json_cache();
    const after_json = cache.to_json();
    expect(after_json.length).toBeLessThan(before_json.length);
  });

  it("test_get_session_max_bytes_default", () => {
    delete process.env.TOKEN_GOAT_SESSION_MAX_BYTES;
    expect(session._get_session_max_bytes()).toBe(session._SESSION_MAX_BYTES);
  });

  it("test_get_session_max_bytes_env_override", () => {
    process.env.TOKEN_GOAT_SESSION_MAX_BYTES = "524288";
    expect(session._get_session_max_bytes()).toBe(524288);
  });

  it("test_get_session_max_bytes_invalid_env_falls_back_to_default", () => {
    process.env.TOKEN_GOAT_SESSION_MAX_BYTES = "not-a-number";
    expect(session._get_session_max_bytes()).toBe(session._SESSION_MAX_BYTES);
  });

  it("test_get_session_max_bytes_zero_env_falls_back_to_default", () => {
    process.env.TOKEN_GOAT_SESSION_MAX_BYTES = "0";
    expect(session._get_session_max_bytes()).toBe(session._SESSION_MAX_BYTES);
  });

  it("test_save_applies_size_cap", () => {
    process.env.TOKEN_GOAT_SESSION_MAX_BYTES = "30000";
    const cache = _make_cache("test-save-cap");
    _bloat_result_cache(cache, 200);
    _bloat_bash_history(cache, 75);
    const uncapped_size = Buffer.from(cache.to_json(), "utf8").length;
    expect(uncapped_size, `Pre-condition failed: ${uncapped_size} not > 30000`).toBeGreaterThan(
      30000,
    );
    session.save(cache);
    const p = paths.sessionCachePath("test-save-cap");
    expect(fs.existsSync(p)).toBe(true);
    const saved_size = fs.statSync(p).size;
    expect(
      saved_size,
      `Expected saved file (${saved_size}) to be smaller than uncapped (${uncapped_size})`,
    ).toBeLessThan(uncapped_size);
  });

  it("test_trim_bash_dedup_ids", () => {
    const cache = _make_cache();
    cache.bash_dedup_emitted_ids = new Set(
      Array.from({ length: 150 }, (_, i) => `id-${String(i).padStart(4, "0")}`),
    );
    const original_size = cache.bash_dedup_emitted_ids.size;
    const trimmed = session._trim_session_for_size(cache, 1_000);
    expect(trimmed).toBeTruthy();
    expect(cache.bash_dedup_emitted_ids.size).toBeLessThan(original_size);
  });
});

// ===========================================================================
// Stale session cleanup at SessionStart
// ===========================================================================

describe("TestSessionStartStaleCleanup", () => {
  it("test_cleanup_stale_7_days_cutoff", () => {
    const old_id = "old-session-8days";
    const s = session.load(old_id);
    session.save(s);
    const old_path = paths.sessionCachePath(old_id);
    const old_mtime = Date.now() / 1000 - 8 * 24 * 3600; // 8 days ago
    fs.utimesSync(old_path, old_mtime, old_mtime);

    const recent_id = "recent-session-6days";
    const s2 = session.load(recent_id);
    session.save(s2);
    const recent_path = paths.sessionCachePath(recent_id);
    const recent_mtime = Date.now() / 1000 - 6 * 24 * 3600; // 6 days ago
    fs.utimesSync(recent_path, recent_mtime, recent_mtime);

    const removed = session.cleanup_stale(168.0);
    expect(removed).toBeGreaterThanOrEqual(1);
    expect(fs.existsSync(old_path)).toBe(false);
    expect(fs.existsSync(recent_path)).toBe(true);
  });

  it("test_cleanup_stale_does_not_remove_active_sessions", () => {
    const active_id = "active-session";
    session.mark_file_read(active_id, "main.py");
    session.cleanup_stale(168.0);
    const active_path = paths.sessionCachePath(active_id);
    expect(fs.existsSync(active_path)).toBe(true);
  });

  it("test_cleanup_stale_empty_dir_returns_zero", () => {
    const removed = session.cleanup_stale(168.0);
    expect(removed).toBe(0);
  });

  it("test_session_start_calls_cleanup", () => {
    // session_start invokes cleanup_stale at startup (non-compact source).
    const cleanup_calls: number[] = [];
    // Spy on session.cleanup_stale; hooks_session calls it through the session
    // module namespace, so the spy is observed.
    const spy = vi
      .spyOn(session, "cleanup_stale")
      .mockImplementation((max_age_hours = 24.0): number => {
        cleanup_calls.push(max_age_hours);
        return 0;
      });

    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "tg-sess-cleanup-"));
    const payload = { session_id: "test-cleanup-session", cwd };
    try {
      // session_start may fail for other reasons (db, worker, etc.) — we only
      // care that cleanup was called.
      hooks_session.session_start(payload);
    } catch {
      // suppress
    }
    spy.mockRestore();

    expect(cleanup_calls.length, "cleanup_stale should have been called").toBeGreaterThanOrEqual(1);
    expect(cleanup_calls[0], `Expected 168h cutoff, got ${cleanup_calls[0]}`).toBe(168.0);
  });
});

// ===========================================================================
// Config corrupt TOML fallback (regression)
// ===========================================================================

describe("TestConfigCorruptTomlFallback", () => {
  function _reset_config_cache(): void {
    clearConfigCache();
  }

  it("test_corrupt_toml_returns_defaults", () => {
    _reset_config_cache();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tg-cfg-"));
    const config_file = path.join(dir, "config.toml");
    fs.writeFileSync(config_file, "this is not valid TOML ][[[", "utf8");
    setConfigPathOverride(config_file);

    const cfg = configLoad();
    expect(cfg.compact_assist?.enabled).toBe(true);
    expect(cfg.bash_compress?.enabled).toBe(true);
  });

  it("test_missing_config_returns_defaults", () => {
    _reset_config_cache();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tg-cfg-miss-"));
    const config_file = path.join(dir, "nonexistent.toml");
    setConfigPathOverride(config_file);

    const cfg = configLoad();
    expect(cfg.compact_assist?.enabled).toBe(true);
  });

  it("test_corrupt_toml_emits_warning", () => {
    _reset_config_cache();
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tg-cfg-"));
    const config_file = path.join(dir, "config.toml");
    fs.writeFileSync(config_file, "[[bad", "utf8");
    setConfigPathOverride(config_file);

    configLoad();
    const msgs = joinCalls(warnSpy);
    expect(
      msgs.some((s) => s.toLowerCase().includes("load failed")),
      `Expected warning about load failure; got: ${JSON.stringify(msgs)}`,
    ).toBe(true);
  });

  it("test_partial_toml_applies_valid_fields", () => {
    _reset_config_cache();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tg-cfg-"));
    const config_file = path.join(dir, "config.toml");
    fs.writeFileSync(config_file, "[compact_assist]\nenabled = false\n", "utf8");
    setConfigPathOverride(config_file);

    const cfg = configLoad();
    expect(cfg.compact_assist?.enabled).toBe(false);
    expect(cfg.bash_compress?.enabled).toBe(true);
  });

  afterEach(() => {
    clearConfigPathOverride();
    clearConfigCache();
  });
});

// ===========================================================================
// Session atomic writes (regression: ensure tmp file is not left on success)
// ===========================================================================

describe("TestSessionAtomicWrite", () => {
  it("test_no_tmp_artifact_after_successful_save", () => {
    const s_id = "atomic-write-test";
    session.mark_file_read(s_id, "foo.py");
    const p = paths.sessionCachePath(s_id);
    const parent = path.dirname(p);
    const after_tmps = fs.readdirSync(parent).filter((n) => n.endsWith(".tmp"));
    expect(after_tmps, `Stale .tmp files left after save: ${JSON.stringify(after_tmps)}`).toEqual(
      [],
    );
    expect(fs.existsSync(p)).toBe(true);
  });

  it("test_saved_file_is_valid_json", () => {
    const s_id = "json-valid-test";
    session.mark_file_read(s_id, "bar.py", 0, 100);
    const p = paths.sessionCachePath(s_id);
    const raw = fs.readFileSync(p, "utf8");
    const data = JSON.parse(raw) as Record<string, unknown>;
    expect(data["session_id"]).toBe(s_id);
  });
});

// ===========================================================================
// _session_file_lock context manager
// ===========================================================================

describe("TestSessionFileLock", () => {
  let tmpPath: string;

  beforeEach(() => {
    tmpPath = fs.mkdtempSync(path.join(os.tmpdir(), "tg-lock-"));
  });

  afterEach(() => {
    try {
      fs.rmSync(tmpPath, { recursive: true, force: true });
    } catch {
      // best-effort
    }
  });

  it("test_lock_acquired_and_released", () => {
    const target = path.join(tmpPath, "test_session.json");
    // Lock should be acquired; the callback runs without exception.
    session._session_file_lock(target, () => {
      /* body executes without exception */
    });
  });

  it("test_lock_creates_parent_dir_if_missing", () => {
    const target = path.join(tmpPath, "deep", "nested", "session.json");
    session._session_file_lock(target, () => {
      expect(fs.existsSync(path.dirname(target))).toBe(true);
    });
  });

  it("test_body_executes_with_lock_held", () => {
    const target = path.join(tmpPath, "side_effect.json");
    const result: number[] = [];
    session._session_file_lock(target, () => {
      result.push(1);
    });
    expect(result).toEqual([1]);
  });

  it("test_windows_sidecar_created_and_removed", () => {
    // The TS port uses the O_EXCL .flock sidecar on BOTH platforms, so the
    // sidecar is present while held and removed after release here, exactly as
    // the Python Windows branch asserted (no _IS_WINDOWS monkeypatch needed).
    const target = path.join(tmpPath, "sidecar_test.json");
    const sidecar = target + ".flock";

    const sidecar_existed_during: boolean[] = [];
    session._session_file_lock(target, () => {
      sidecar_existed_during.push(fs.existsSync(sidecar));
    });

    expect(sidecar_existed_during, "sidecar must exist while lock is held").toEqual([true]);
    expect(fs.existsSync(sidecar), "sidecar must be removed after lock is released").toBe(false);
  });

  it("test_posix_path_does_not_create_sidecar", () => {
    // Python's POSIX branch used fcntl and left no sidecar; the only assertion is
    // post-release. The TS POSIX path creates+removes the .flock sidecar, so the
    // sidecar is gone after the with-block exits — the post-release assertion holds.
    const target = path.join(tmpPath, "posix_test.json");
    const sidecar = target + ".flock";

    session._session_file_lock(target, () => {
      /* no-op */
    });

    expect(fs.existsSync(sidecar), "POSIX path must not leave a .flock sidecar").toBe(false);
  });

  it("test_timeout_falls_back_gracefully", () => {
    // Pre-create the sidecar (fresh mtime) to simulate a competing lock holder.
    // _session_file_lock cannot acquire it within _SESSION_FILE_LOCK_TIMEOUT_MS,
    // logs a warning, and runs the body anyway (fail-soft).
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const target = path.join(tmpPath, "timeout_test.json");
    const sidecar = target + ".flock";
    fs.mkdirSync(path.dirname(sidecar), { recursive: true });
    fs.writeFileSync(sidecar, "taken", "utf8");

    const body_ran: boolean[] = [];
    session._session_file_lock(target, () => {
      body_ran.push(true);
    });

    const msgs = joinCalls(warnSpy);
    // Body must have run (fail-soft: body always executes even without the lock).
    expect(body_ran, "body must execute even when lock times out").toEqual([true]);
    // A warning must have been logged.
    expect(
      msgs.some((s) => s.toLowerCase().includes("timeout")),
      `expected timeout warning; got: ${JSON.stringify(msgs)}`,
    ).toBe(true);

    // Cleanup: we held the fake sidecar so our code did NOT take it.
    try {
      fs.unlinkSync(sidecar);
    } catch {
      // missing_ok
    }
  });

  it("test_stale_flock_is_evicted_and_lock_acquired", () => {
    // A stale .flock sidecar (from a crashed process) is removed and the lock
    // acquired. Stale threshold = 10x the timeout (2s at the default 200ms).
    const target = path.join(tmpPath, "stale_flock_test.json");
    const sidecar = target + ".flock";
    fs.mkdirSync(path.dirname(sidecar), { recursive: true });
    // Create a sidecar that is 3 seconds old (well past the 2s stale threshold).
    fs.writeFileSync(sidecar, "crashed-holder", "utf8");
    const old_mtime = fs.statSync(sidecar).mtimeMs / 1000 - 3.0;
    fs.utimesSync(sidecar, old_mtime, old_mtime);

    const body_ran: boolean[] = [];
    session._session_file_lock(target, () => {
      body_ran.push(true);
      // The stale sidecar should have been evicted; our lock is now held via a
      // new sidecar.
      expect(fs.existsSync(sidecar), "lock holder's own sidecar must exist during body").toBe(
        true,
      );
    });

    expect(body_ran, "body must execute after evicting stale flock").toEqual([true]);
    expect(fs.existsSync(sidecar), "sidecar must be released after body").toBe(false);
  });

  it("test_lock_released_on_exception", () => {
    const target = path.join(tmpPath, "exc_test.json");
    const sidecar = target + ".flock";

    expect(() =>
      session._session_file_lock(target, () => {
        expect(fs.existsSync(sidecar), "sidecar must exist during body").toBe(true);
        throw new Error("expected");
      }),
    ).toThrow("expected");

    expect(fs.existsSync(sidecar), "sidecar must be released after exception").toBe(false);
  });

  // PORT: deferred — needs real Python threading (8 concurrent threads racing
  // the lock). Node's main module is single-threaded and cannot mirror genuine
  // multi-thread contention.
  it.skip("test_concurrent_writes_no_data_corruption", () => {});
});

// ===========================================================================
// Corruption recovery — WARNING log + fresh session
// ===========================================================================

describe("TestCorruptionRecovery", () => {
  function _write_session_file(session_id: string, content: string): void {
    const p = paths.sessionCachePath(session_id);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, content, "utf8");
  }

  it("test_corrupt_json_returns_fresh_session", () => {
    const sid = "corrupt-recovery-basic";
    _write_session_file(sid, "not-valid-json!!!{[");
    const cache = session.load(sid);
    expect(cache.session_id).toBe(sid);
    expect(cache.files).toEqual({});
    expect(cache.greps).toEqual([]);
    expect(cache.unavailable).toBeFalsy();
  });

  it("test_corrupt_json_logs_warning", () => {
    const sid = "corrupt-recovery-warn";
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    _write_session_file(sid, "{broken json]");
    session.load(sid);
    const msgs = joinCalls(warnSpy);
    expect(
      msgs.some(
        (s) => s.toLowerCase().includes("corrupt") || s.toLowerCase().includes("corrupted"),
      ),
      `Expected a WARNING about corruption; got: ${JSON.stringify(msgs)}`,
    ).toBe(true);
  });

  it("test_truncated_json_returns_fresh_session", () => {
    const sid = "corrupt-recovery-truncated";
    _write_session_file(sid, '{"session_id": "abc", "files": {');
    const cache = session.load(sid);
    expect(cache.session_id).toBe(sid);
    expect(cache.files).toEqual({});
  });

  it("test_corrupt_file_is_archived", () => {
    const sid = "corrupt-recovery-archive";
    const p = paths.sessionCachePath(sid);
    _write_session_file(sid, "!!!garbage!!!");
    session.load(sid);
    // The .corrupt sidecar should exist next to the (now removed) .json.
    const parent = path.dirname(p);
    const base = path.basename(p); // <sid>.json
    const corrupt_files = fs
      .readdirSync(parent)
      .filter((n) => n.startsWith(`${base}.corrupt.`));
    expect(
      corrupt_files.length > 0,
      `Expected a .corrupt archive file next to ${base}; found: ${JSON.stringify(
        fs.readdirSync(parent),
      )}`,
    ).toBe(true);
  });

  it("test_valid_but_wrong_schema_returns_fresh_session", () => {
    const sid = "corrupt-schema-mismatch";
    const wrong_schema = JSON.stringify({
      schema_version: 9999,
      session_id: sid,
      started_ts: Date.now() / 1000,
      last_activity_ts: Date.now() / 1000,
      files: {},
    });
    _write_session_file(sid, wrong_schema);
    const cache = session.load(sid);
    expect(cache.session_id).toBe(sid);
    expect(cache.files).toEqual({});
  });
});

// ===========================================================================
// Stale sidecar cleanup — cleanup_stale removes orphaned .json.lock / .json.flock
// ===========================================================================

describe("TestStaleSidecarCleanup", () => {
  function _sessions_dir(): string {
    return path.dirname(paths.sessionCachePath("dummy"));
  }

  function _old_mtime(): number {
    return Date.now() / 1000 - 9 * 24 * 3600; // 9 days ago
  }

  /** pathlib with_suffix(".json.lock"|".json.flock") on a <id>.json path. */
  function _withJsonSidecar(p: string, suffix: string): string {
    // p ends in ".json"; pathlib replaces only the final suffix → <stem><suffix>.
    const dir = path.dirname(p);
    const base = path.basename(p);
    const dot = base.lastIndexOf(".");
    const stem = dot > 0 ? base.slice(0, dot) : base;
    return path.join(dir, stem + suffix);
  }

  it("test_cleanup_removes_lock_sidecar_with_stale_json", () => {
    const sid = "stale-with-lock";
    const s = session.load(sid);
    session.save(s);
    const p = paths.sessionCachePath(sid);
    const lock_path = _withJsonSidecar(p, ".json.lock");
    fs.writeFileSync(lock_path, "99999", "utf8");
    const old_t = _old_mtime();
    fs.utimesSync(p, old_t, old_t);
    fs.utimesSync(lock_path, old_t, old_t);

    session.cleanup_stale(168.0);

    expect(fs.existsSync(p), "Stale session JSON should have been removed").toBe(false);
    expect(fs.existsSync(lock_path), "Stale .json.lock sidecar should have been removed").toBe(
      false,
    );
  });

  it("test_cleanup_removes_flock_sidecar_with_stale_json", () => {
    const sid = "stale-with-flock";
    const s = session.load(sid);
    session.save(s);
    const p = paths.sessionCachePath(sid);
    const flock_path = _withJsonSidecar(p, ".json.flock");
    fs.writeFileSync(flock_path, "", "utf8");
    const old_t = _old_mtime();
    fs.utimesSync(p, old_t, old_t);
    fs.utimesSync(flock_path, old_t, old_t);

    session.cleanup_stale(168.0);

    expect(fs.existsSync(p), "Stale session JSON should have been removed").toBe(false);
    expect(fs.existsSync(flock_path), "Stale .json.flock sidecar should have been removed").toBe(
      false,
    );
  });

  it("test_cleanup_removes_orphaned_lock_when_json_already_gone", () => {
    const sessions_dir = _sessions_dir();
    fs.mkdirSync(sessions_dir, { recursive: true });
    const orphan_sid = "orphan-lock-session";
    const orphan_lock = path.join(sessions_dir, `${orphan_sid}.json.lock`);
    fs.writeFileSync(orphan_lock, "99999", "utf8");
    expect(
      fs.existsSync(path.join(sessions_dir, `${orphan_sid}.json`)),
      "Pre-condition: no JSON",
    ).toBe(false);

    session.cleanup_stale(168.0);

    expect(
      fs.existsSync(orphan_lock),
      "Orphaned .json.lock (no corresponding .json) should have been removed",
    ).toBe(false);
  });

  it("test_cleanup_keeps_lock_sidecar_for_active_session", () => {
    const sid = "active-with-lock";
    const s = session.load(sid);
    session.save(s);
    const p = paths.sessionCachePath(sid);
    const lock_path = _withJsonSidecar(p, ".json.lock");
    fs.writeFileSync(lock_path, "99999", "utf8");
    // Both files are recent (within the 7-day cutoff) — do not age them.

    session.cleanup_stale(168.0);

    expect(fs.existsSync(p), "Active session JSON must not be removed").toBe(true);
    expect(fs.existsSync(lock_path), "Lock sidecar for active session must not be removed").toBe(
      true,
    );
  });
});
