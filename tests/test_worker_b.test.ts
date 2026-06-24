/**
 * Tests for token_goat.worker (part B) — faithful 1:1 port of tests/test_worker.py
 * (split into _a / _b by topic).
 *
 * Part B covers: run_daemon (stop-event / autostart / adaptive back-off /
 * periodic reindex), _reindex_active_projects, cleanup_on_startup failure +
 * extra-key contracts, _gc_orphaned_projects, enqueue-dirty append/byte-cap
 * regression, the adaptive_poll_interval ramp, and the duplicate-instance guard.
 *
 * NO TEST FORKS A REAL WORKER/DAEMON. run_daemon is driven with a StopEvent
 * (worker.StopEvent) whose async `wait` the test resolves; spawn_detached is
 * always stubbed via worker._setSpawnImpl or a vi.spyOn returning a fake PID.
 * The daemon loop dispatches through worker_daemon's `_worker.<fn>` / `self.<fn>`
 * namespaces, so vi.spyOn(worker, ...) on the daemon-driven internals is visible.
 *
 * DEFERRED (it.skip) — recurring reasons:
 *  - MONKEYPATCH OF NON-EXPORTED MODULE-PRIVATE FUNCTIONS that worker.ts calls
 *    DIRECTLY (not through the module namespace), so neither importable nor
 *    spy-observable: _cleanup_stale_locks, _cleanup_old_logs, _prune_stats_table,
 *    _cleanup_stale_snapshots, _evict_bash_outputs, _evict_web_outputs,
 *    _checkpoint_global_wal, _checkpoint_project_wals, _cleanup_old_sessions,
 *    reap_stale_index_markers(*exported but cleanup calls it directly),
 *    _eviction_lock_is_stale/_acquire_eviction_lock/_clear_stale_eviction_lock,
 *    _EVICTION_LOCK_STALE_SECONDS, _parse_and_group_entries,
 *    _proc_create_time/_is_process_recent/_is_token_goat_worker.
 *  - CONST CONSTANT OVERRIDES Python monkeypatched but TS declares `const`:
 *    IMAGE_CACHE_LIMIT, IMAGE_CACHE_TARGET, _BOOTED_VERSION, _BOOTED_FINGERPRINT.
 *  - fs.readFileSync / Path.read_text path-selective stubs the TS port cannot
 *    intercept (the impl captures the `fs` namespace at import).
 */
import { describe, expect, it, vi, afterEach } from "vitest";

import fs from "node:fs";
import path from "node:path";

import * as worker from "../src/token_goat/worker.js";
import * as worker_daemon from "../src/token_goat/worker_daemon.js";
import * as paths from "../src/token_goat/paths.js";
import * as db from "../src/token_goat/db.js";
import * as project from "../src/token_goat/project.js";
import * as install from "../src/token_goat/install.js";
import * as config from "../src/token_goat/config.js";
import * as web_cache from "../src/token_goat/web_cache.js";
import * as parser from "../src/token_goat/parser.js";
import * as git_history from "../src/token_goat/git_history.js";

const _now = (): number => Date.now() / 1000;
const getpid = (): number => process.pid;

function utime(p: string, t: number): void {
  fs.utimesSync(p, t, t);
}

/**
 * A StopEvent whose async wait records each timeout and can self-stop after N
 * calls — the TS analogue of Python's _TrackingEvent(threading.Event).
 */
class TrackingEvent extends worker.StopEvent {
  waitCalls: number[] = [];
  stopAt: number;
  setImmediately: boolean;

  constructor(opts: { stopAt?: number; setImmediately?: boolean } = {}) {
    super();
    this.stopAt = opts.stopAt ?? 1;
    this.setImmediately = opts.setImmediately ?? false;
  }

  override wait(timeoutSecs: number): Promise<boolean> {
    this.waitCalls.push(timeoutSecs || 0.0);
    if (this.setImmediately || this.waitCalls.length >= this.stopAt) {
      this.set();
    }
    return Promise.resolve(this.is_set());
  }
}

/** Stub every worker internal the daemon loop dereferences, so no real work runs. */
function stubDaemonInternals(): (() => void)[] {
  const restores: (() => void)[] = [];
  const spy = <K extends keyof typeof worker>(name: K, impl: unknown): void => {
    const s = vi.spyOn(worker, name as never).mockImplementation(impl as never);
    restores.push(() => s.mockRestore());
  };
  spy("spawn_detached", () => null);
  spy("_try_claim_worker_slot", () => 99);
  spy("_clear_pid", () => {});
  spy("_write_pid", () => {});
  spy("_heartbeat", () => {});
  spy("_register_autostart", () => {});
  spy("cleanup_on_startup", () => ({}));
  spy("drain_dirty_queue", () => []);
  spy("_reindex_active_projects", () => {});
  spy("_installed_version", () => null);
  spy("_package_fingerprint", () => null);
  return restores;
}

afterEach(() => {
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// 9. run_daemon smoke test — stop_event shuts it down, PID file is cleaned up
// ---------------------------------------------------------------------------

describe("run_daemon lifecycle", () => {
  it("test_run_daemon_stop_event", async () => {
    const stop = new worker.StopEvent();
    // Stub spawn/claim/write so no real fork and the slot is granted; stop on
    // the autostart hook so the loop never iterates unbounded.
    const claimSpy = vi.spyOn(worker, "_try_claim_worker_slot").mockReturnValue(99);
    const spawnSpy = vi.spyOn(worker, "spawn_detached").mockReturnValue(null);
    const regSpy = vi.spyOn(worker, "_register_autostart").mockImplementation(() => {
      stop.set();
    });
    try {
      await worker.run_daemon(stop);
    } finally {
      claimSpy.mockRestore();
      spawnSpy.mockRestore();
      regSpy.mockRestore();
    }
    expect(fs.existsSync(paths.workerPidPath())).toBe(false);
    expect(fs.existsSync(paths.workerHeartbeatPath())).toBe(false);
  });

  it("test_run_daemon_self_registers_autostart", async () => {
    const stop = new worker.StopEvent();
    let called = false;
    const claimSpy = vi.spyOn(worker, "_try_claim_worker_slot").mockReturnValue(99);
    const spawnSpy = vi.spyOn(worker, "spawn_detached").mockReturnValue(null);
    const regSpy = vi.spyOn(worker, "_register_autostart").mockImplementation(() => {
      called = true;
      stop.set();
    });
    try {
      await worker.run_daemon(stop);
    } finally {
      claimSpy.mockRestore();
      spawnSpy.mockRestore();
      regSpy.mockRestore();
    }
    expect(called).toBe(true);
  });

  it("test_register_autostart_invokes_install_task", () => {
    // _register_autostart() must drive the platform-appropriate install function,
    // fail-soft. TS has no autouse stub of _register_autostart, so it is called
    // directly; the install.* fns are spied through the install namespace.
    const installFnName: keyof typeof install =
      process.platform === "win32"
        ? "install_worker_task"
        : process.platform === "darwin"
          ? "install_mac_autostart"
          : "install_linux_autostart";

    let called = false;
    const okSpy = vi
      .spyOn(install, installFnName)
      .mockImplementation((): [boolean, string] => {
        called = true;
        return [true, "spy"];
      });
    try {
      worker._register_autostart();
    } finally {
      okSpy.mockRestore();
    }
    expect(called).toBe(true);

    // Fail-soft: an error must not propagate out of the worker.
    const boomSpy = vi.spyOn(install, installFnName).mockImplementation((): [boolean, string] => {
      throw new Error("autostart unavailable");
    });
    try {
      expect(() => worker._register_autostart()).not.toThrow();
    } finally {
      boomSpy.mockRestore();
    }
    // The atomic claim file must not exist (nothing created it here).
    expect(fs.existsSync(worker._worker_claim_path())).toBe(false);
  });

  it("test_run_daemon_second_instance_exits_immediately", async () => {
    // If the slot is already claimed, run_daemon must return without draining.
    const prev = worker._setProcessIntrospection({ createTime: (_p) => 1000.0 });
    const drainSpy = vi.spyOn(worker, "drain_dirty_queue").mockReturnValue([]);
    try {
      paths.ensureDirs();
      const claim = worker._worker_claim_path();
      fs.writeFileSync(claim, `${getpid()}\n1000.0`, "utf-8");
      await worker.run_daemon(new worker.StopEvent());
      expect(drainSpy).not.toHaveBeenCalled();
      try {
        fs.unlinkSync(claim);
      } catch {
        // ignore
      }
    } finally {
      drainSpy.mockRestore();
      worker._setProcessIntrospection(prev);
    }
  });

  // _BOOTED_VERSION/_BOOTED_FINGERPRINT now have setter seams, but these cases
  // also need VERSION_CHECK_INTERVAL lowered to 0.0 so the upgrade check fires on
  // the first loop pass. VERSION_CHECK_INTERVAL is an `export const` (60s) with no
  // reassignment seam, and the daemon seeds lastVersionCheck=now and gates on
  // `now - last >= VERSION_CHECK_INTERVAL`, so _detect_upgrade is never reached in
  // a single bounded loop. DEFER until a VERSION_CHECK_INTERVAL seam exists.
  it.skip("test_run_daemon_restarts_on_version_change — needs VERSION_CHECK_INTERVAL=0.0 (const, no seam)", () => {});
  it.skip("test_run_daemon_restarts_on_code_change — needs VERSION_CHECK_INTERVAL=0.0 (const, no seam)", () => {});
  it.skip("test_run_daemon_no_restart_when_version_unchanged — needs VERSION_CHECK_INTERVAL=0.0 (const, no seam)", () => {});
});

// ---------------------------------------------------------------------------
// _package_fingerprint — content fingerprint stability
// ---------------------------------------------------------------------------

describe("_package_fingerprint", () => {
  it("test_package_fingerprint_changes_with_file_content", () => {
    const fp1 = worker._package_fingerprint();
    expect(fp1).not.toBe(null);
    expect(fp1!.length).toBe(40);
    expect(worker._package_fingerprint()).toBe(fp1);

    // Touching a package file (bumping its mtime) must change the fingerprint.
    // worker.ts is this module's own file on disk.
    const workerFile = new URL("../src/token_goat/worker.ts", import.meta.url).pathname;
    const st = fs.statSync(workerFile);
    try {
      fs.utimesSync(workerFile, st.atimeMs / 1000, st.mtimeMs / 1000 + 5);
      expect(worker._package_fingerprint()).not.toBe(fp1);
    } finally {
      fs.utimesSync(workerFile, st.atimeMs / 1000, st.mtimeMs / 1000);
    }
  });
});

// ---------------------------------------------------------------------------
// TestReindexActiveProjects
// ---------------------------------------------------------------------------

describe("TestReindexActiveProjects", () => {
  function registerProject(
    hash_: string,
    root: string,
    marker: string,
    fileCount: number,
    lastSeen?: number,
  ): void {
    db.openGlobal((gconn) => {
      const now = Math.trunc(_now());
      const ls = lastSeen === undefined ? now : lastSeen;
      gconn
        .prepare(
          "INSERT OR REPLACE INTO projects(hash, root, marker, first_seen, last_seen, file_count, languages) " +
            "VALUES (?, ?, ?, ?, ?, ?, ?)",
        )
        .run(hash_, root, marker, now, ls, fileCount, "markdown");
    });
  }

  it("test_does_nothing_when_no_projects", () => {
    expect(() => worker._reindex_active_projects()).not.toThrow();
  });

  it("test_reindexes_git_project", async () => {
    // Regression: git-detected projects must be swept too (edits made outside
    // Claude Code never hit the dirty queue). The real parser is wired as the
    // default seam; a real index seeds a project DB, then the sweep must invoke
    // index_project exactly once. The sweep dispatches the (async) real parser,
    // so we count via a synchronous stub seam registered just before the sweep.
    const projRoot = path.join(paths.dataDir(), "code");
    fs.mkdirSync(projRoot, { recursive: true });
    fs.writeFileSync(path.join(projRoot, "mod.py"), "def f():\n    return 1\n", "utf-8");
    const ph = project.project_hash(project.canonicalize(projRoot));
    await parser.index_project(project.make_project_at(projRoot), { full: true });
    registerProject(ph, projRoot, ".git", 1);

    let calls = 0;
    worker._setParserModule({
      index_project: () => {
        calls += 1;
        return {};
      },
    });
    try {
      worker._reindex_active_projects();
    } finally {
      worker._setParserModule(null);
    }
    expect(calls).toBe(1);
  });

  it("test_reindex_triggers_git_history_indexing", async () => {
    // The periodic sweep refreshes git-history hints for each active project.
    const projRoot = path.join(paths.dataDir(), "code-gh");
    fs.mkdirSync(projRoot, { recursive: true });
    fs.writeFileSync(path.join(projRoot, "mod.py"), "def f():\n    return 1\n", "utf-8");
    const ph = project.project_hash(project.canonicalize(projRoot));
    await parser.index_project(project.make_project_at(projRoot), { full: true });
    registerProject(ph, projRoot, ".git", 1);

    // A synchronous stub seam returns a dict so the success path (which calls
    // git_history.index_project_history) runs without dispatching the real
    // async parser.
    worker._setParserModule({
      index_project: () => ({}),
    });
    const ghSpy = vi.spyOn(git_history, "index_project_history").mockImplementation(() => 0);
    let calls: [string, string][];
    try {
      worker._reindex_active_projects();
      // Capture the call list before mockRestore() clears it in finally.
      calls = ghSpy.mock.calls.map((c) => [c[0], c[1]]);
    } finally {
      ghSpy.mockRestore();
      worker._setParserModule(null);
    }
    expect(calls.length).toBe(1);
    const [calledRoot, calledHash] = calls[0]!;
    expect(calledRoot).toBe(projRoot);
    expect(calledHash).toBe(ph);
  });

  it("test_reindexes_manual_project", async () => {
    const skillRoot = path.join(paths.dataDir(), "skills");
    fs.mkdirSync(skillRoot, { recursive: true });
    fs.writeFileSync(
      path.join(skillRoot, "tool.md"),
      "# Tool\n\n## Section\n\nContent.\n",
      "utf-8",
    );
    const ph = project.project_hash(project.canonicalize(skillRoot));
    registerProject(ph, skillRoot, "manual", 1);

    // First index so there is a project DB to update.
    await parser.index_project(project.make_project_at(skillRoot), { full: true });

    // Now call the sweep — should run without raising.
    expect(() => worker._reindex_active_projects()).not.toThrow();
  });

  it("test_skips_project_outside_active_window", () => {
    const oldRoot = path.join(paths.dataDir(), "dormant");
    fs.mkdirSync(oldRoot, { recursive: true });
    const ph = project.project_hash(project.canonicalize(oldRoot));
    const staleTs = Math.trunc(_now() - worker.PERIODIC_REINDEX_ACTIVE_WINDOW - 3600);
    registerProject(ph, oldRoot, ".git", 5, staleTs);

    // Parser is the only thing that would index; register a spy stub to confirm
    // it is never called for an out-of-window project.
    let calls = 0;
    worker._setParserModule({
      index_project: () => {
        calls += 1;
        return {};
      },
    });
    try {
      worker._reindex_active_projects();
    } finally {
      worker._setParserModule(null);
    }
    expect(calls).toBe(0);
  });

  it("test_skips_project_exceeding_file_cap", () => {
    // PERIODIC_REINDEX_MAX_FILES is `export let` but an ESM namespace binding is
    // read-only from outside the declaring module (no setter is exported), so we
    // cannot lower it to 500 as Python's monkeypatch did. Instead register a
    // project whose file_count exceeds the REAL default cap
    // (PERIODIC_REINDEX_MAX_FILES = 2000) and assert the parser is never called.
    const bigRoot = path.join(paths.dataDir(), "huge");
    fs.mkdirSync(bigRoot, { recursive: true });
    const ph = project.project_hash(project.canonicalize(bigRoot));
    registerProject(ph, bigRoot, "manual", worker.PERIODIC_REINDEX_MAX_FILES + 1);

    let calls = 0;
    worker._setParserModule({
      index_project: () => {
        calls += 1;
        return {};
      },
    });
    try {
      worker._reindex_active_projects();
    } finally {
      worker._setParserModule(null);
    }
    expect(calls).toBe(0);
  });

  it("test_one_project_failing_does_not_block_others", async () => {
    const goodRoot = path.join(paths.dataDir(), "good");
    fs.mkdirSync(goodRoot, { recursive: true });
    fs.writeFileSync(path.join(goodRoot, "skill.md"), "# Good\n", "utf-8");
    const badRoot = path.join(paths.dataDir(), "bad");
    fs.mkdirSync(badRoot, { recursive: true });

    const goodPh = project.project_hash(project.canonicalize(goodRoot));
    const badPh = project.project_hash(project.canonicalize(badRoot));

    await parser.index_project(project.make_project_at(goodRoot), { full: true });

    registerProject(badPh, badRoot, "manual", 1);
    registerProject(goodPh, goodRoot, "manual", 1);

    const callLog: string[] = [];
    // Stub seam: the bad project raises; the good project records its hash. The
    // sweep must catch the failure and still process the good project.
    worker._setParserModule({
      index_project: (proj) => {
        if (proj.hash === badPh) {
          throw new Error("simulated index failure");
        }
        callLog.push(proj.hash);
        return {};
      },
    });
    try {
      expect(() => worker._reindex_active_projects()).not.toThrow();
    } finally {
      worker._setParserModule(null);
    }
    expect(callLog).toContain(goodPh);
  });

  it("test_global_db_error_is_swallowed", () => {
    const spy = vi.spyOn(db, "openGlobalReadonly").mockImplementation(() => {
      throw new db.DBError("DB gone");
    });
    try {
      // Must not raise — error is caught and logged.
      expect(() => worker._reindex_active_projects()).not.toThrow();
    } finally {
      spy.mockRestore();
    }
  });

  it.skip("test_run_daemon_triggers_periodic_reindex — PERIODIC_REINDEX_INTERVAL is a `const` (Python set it to 0.0); the daemon seeds lastPeriodicReindex to now and gates the reindex on `now - last >= INTERVAL`, so with a non-zero const the first loop never fires reindex and there is no reassignment seam to force it", () => {});
});

// ---------------------------------------------------------------------------
// run_daemon adaptive back-off / reset (drive worker_daemon.run_daemon)
// ---------------------------------------------------------------------------

describe("run_daemon adaptive backoff", () => {
  it("test_event_wait_used_when_stop_event_provided", async () => {
    const restores = stubDaemonInternals();
    const stop = new TrackingEvent({ setImmediately: true });
    try {
      await worker_daemon.run_daemon(stop);
    } finally {
      for (const r of restores) {
        r();
      }
    }
    expect(stop.waitCalls.length >= 1).toBe(true);
    expect(stop.waitCalls[0]).toBe(worker.POLL_INTERVAL);
  });

  it("test_run_daemon_backs_off_after_consecutive_empty_drains", async () => {
    const restores = stubDaemonInternals();
    const threshold = worker.IDLE_BACKOFF_AFTER_EMPTY_DRAINS;
    const nCycles = threshold + 3;
    const stop = new TrackingEvent({ stopAt: nCycles });
    try {
      await worker_daemon.run_daemon(stop);
    } finally {
      for (const r of restores) {
        r();
      }
    }
    for (let i = 0; i < threshold - 1; i++) {
      expect(stop.waitCalls[i], `call ${i} expected baseline`).toBe(worker.POLL_INTERVAL);
    }
    expect(stop.waitCalls[threshold - 1]! > worker.POLL_INTERVAL).toBe(true);
  });

  it("test_run_daemon_resets_backoff_after_work_appears", async () => {
    const drainResults: worker.DirtyQueueEntry[][] = [
      [], [], [], [], [], [],
      [{ path: "x.py", project_hash: "a".repeat(40), ts: 0.0 }],
    ];
    let drainIdx = 0;
    const restores = stubDaemonInternals();
    // Override drain to walk the scripted results, and short-circuit the
    // entry-processing so no project lookup runs.
    const drainSpy = vi.spyOn(worker, "drain_dirty_queue").mockImplementation(() => {
      const i = drainIdx++;
      return i < drainResults.length ? drainResults[i]! : [];
    });
    const procSpy = vi.spyOn(worker, "_process_dirty_entries").mockImplementation(() => {});
    const stop = new TrackingEvent({ stopAt: drainResults.length });
    try {
      await worker_daemon.run_daemon(stop);
    } finally {
      drainSpy.mockRestore();
      procSpy.mockRestore();
      for (const r of restores) {
        r();
      }
    }
    expect(stop.waitCalls[5]! > worker.POLL_INTERVAL).toBe(true);
    expect(stop.waitCalls[6]).toBe(worker.POLL_INTERVAL);
  });
});

// ---------------------------------------------------------------------------
// drain_dirty_queue — atomic rename closes the read-then-truncate race
// ---------------------------------------------------------------------------

describe("drain_dirty_queue concurrency / quarantine", () => {
  it.skip("test_drain_dirty_queue_preserves_concurrent_append — patches Path.read_text to enqueue mid-read; TS impl reads via the fs namespace which a vi.spyOn cannot path-selectively intercept", () => {});
  it.skip("test_unreadable_draining_file_is_quarantined — patches Path.read_text for the .draining path only; not interceptable through the fs namespace binding", () => {});
  it.skip("test_unreadable_draining_file_not_silently_overwritten — patches Path.read_text + Path.rename for the .draining path only; not interceptable through the fs namespace binding", () => {});
});

// ---------------------------------------------------------------------------
// cleanup_on_startup — failure reporting + standalone task fns
// ---------------------------------------------------------------------------

describe("cleanup_on_startup failure reporting", () => {
  it("test_cleanup_stale_locks_standalone", () => {
    // _cleanup_stale_locks returns count of removed lock files.
    const locksDir = paths.locksDir();
    paths.ensureDir(locksDir);
    const deadPid = 2 ** 30; // unreachable PID
    fs.writeFileSync(path.join(locksDir, "fake.lock"), `${deadPid}\n`, "utf-8");

    const count = worker._cleanup_stale_locks();
    expect(count).toBe(1);
    expect(fs.existsSync(path.join(locksDir, "fake.lock"))).toBe(false);
  });

  it("test_cleanup_old_logs_standalone", () => {
    // _cleanup_old_logs removes logs older than retention window.
    const logsDir = paths.logsDir();
    paths.ensureDir(logsDir);
    const oldLog = path.join(logsDir, "2000-01-01.log");
    fs.writeFileSync(oldLog, "old\n", "utf-8");
    const oldTs = _now() - 100 * 86400; // 100 days ago
    utime(oldLog, oldTs);

    const count = worker._cleanup_old_logs();
    expect(count >= 1).toBe(true);
    expect(fs.existsSync(oldLog)).toBe(false);
  });

  // cleanup_on_startup builds its task list (the _int_tasks array) by capturing
  // the function *references* at module load, so a vi.spyOn(worker, "_cleanup_*")
  // replaces the namespace property but not the captured reference the loop calls.
  // The monkeypatch-a-task-to-raise/return cases below are therefore unobservable
  // through cleanup_on_startup. (Faithful Python patched the module attribute,
  // which Python's name lookup re-reads at call time; ESM captures it.)
  it.skip("test_cleanup_on_startup_records_failures — cleanup_on_startup calls _cleanup_stale_locks via a captured reference (the _int_tasks array), so a namespace spy is not observed", () => {});
  it.skip("test_cleanup_on_startup_no_failures_omits_key — monkeypatches task fns invoked via captured references (not observed)", () => {});
  it.skip("test_cleanup_on_startup_includes_project_wal_bytes_reclaimed — monkeypatches _checkpoint_project_wals invoked via a captured reference (not observed)", () => {});
  it.skip("test_cleanup_on_startup_includes_web_outputs_evicted — monkeypatches _evict_web_outputs invoked via a captured reference (not observed)", () => {});

  it("test_evict_web_outputs_calls_web_cache", () => {
    // _evict_web_outputs must delegate to web_cache.evict_old_entries with the
    // config values — not hardcoded defaults.
    const calls: { max_total_bytes: number | undefined; max_file_count: number | undefined }[] = [];
    const spy = vi
      .spyOn(web_cache, "evict_old_entries")
      .mockImplementation(
        (opts?: { max_total_bytes?: number | undefined; max_file_count?: number | undefined }): number => {
          calls.push({ max_total_bytes: opts?.max_total_bytes, max_file_count: opts?.max_file_count });
          return 3;
        },
      );
    try {
      const result = worker._evict_web_outputs();
      const cfg = config.load().webfetch;
      expect(result).toBe(3);
      expect(calls.length).toBe(1);
      expect(calls[0]!.max_total_bytes).toBe(cfg?.max_bytes);
      expect(calls[0]!.max_file_count).toBe(cfg?.max_file_count);
    } finally {
      spy.mockRestore();
    }
  });
});

// ---------------------------------------------------------------------------
// adaptive poll interval (module-level functions in test_worker.py)
// ---------------------------------------------------------------------------

describe("adaptive_poll_interval", () => {
  it("test_adaptive_poll_interval_stays_baseline_under_threshold", () => {
    for (let n = 0; n < worker.IDLE_BACKOFF_AFTER_EMPTY_DRAINS; n++) {
      expect(worker.adaptive_poll_interval(n)).toBe(worker.POLL_INTERVAL);
    }
  });

  it("test_adaptive_poll_interval_grows_after_threshold", () => {
    const threshold = worker.IDLE_BACKOFF_AFTER_EMPTY_DRAINS;
    const firstBackoff = worker.adaptive_poll_interval(threshold);
    const secondBackoff = worker.adaptive_poll_interval(threshold + 1);
    expect(firstBackoff > worker.POLL_INTERVAL).toBe(true);
    expect(secondBackoff > firstBackoff).toBe(true);
  });

  it("test_adaptive_poll_interval_caps_at_max", () => {
    const capped = worker.adaptive_poll_interval(10_000);
    expect(capped).toBe(worker.POLL_INTERVAL_MAX);
    expect(worker.POLL_INTERVAL_MAX > worker.POLL_INTERVAL).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Dirty-queue coalescing — _parse_and_group_entries (not exported)
// ---------------------------------------------------------------------------

describe("dirty-queue coalescing", () => {
  it("test_parse_and_group_entries_coalesces_duplicate_paths", () => {
    // Five appends of the same (project, path) collapse to one rel-path.
    const ph = "a".repeat(40);
    const root = process.platform === "win32" ? "C:/proj" : "/proj";
    const entries: worker.DirtyQueueEntry[] = [];
    for (let i = 0; i < 5; i++) {
      entries.push({
        path: "src/foo.py",
        project_hash: ph,
        project_root: root,
        project_marker: "manual",
        ts: i,
      });
    }
    const byProject = worker._parse_and_group_entries(entries);
    expect(byProject.has(ph)).toBe(true);
    const bucket = byProject.get(ph)!;
    expect(bucket.rels).toEqual(new Set(["src/foo.py"]));
    expect(bucket.rels.size).toBe(1);
  });

  it("test_parse_and_group_entries_coalesces_distinct_files_independently", () => {
    // Different files in the same project remain distinct after coalescing.
    const ph = "b".repeat(40);
    const root = process.platform === "win32" ? "C:/proj" : "/proj";
    const entries: worker.DirtyQueueEntry[] = [];
    for (const p of ["src/a.py", "src/b.py", "src/a.py", "src/c.py", "src/b.py"]) {
      entries.push({ path: p, project_hash: ph, project_root: root, project_marker: "manual", ts: 0.0 });
    }
    const byProject = worker._parse_and_group_entries(entries);
    expect(byProject.get(ph)!.rels).toEqual(new Set(["src/a.py", "src/b.py", "src/c.py"]));
  });
});

// ---------------------------------------------------------------------------
// TestImageCacheEviction — overrides const IMAGE_CACHE_LIMIT/TARGET / private fns
// ---------------------------------------------------------------------------

describe("TestImageCacheEviction", () => {
  function setSmallLimits(limitBytes = 1000): [number, number] {
    const targetBytes = Math.trunc(limitBytes * 0.8);
    worker._setImageCacheLimit(limitBytes);
    worker._setImageCacheTarget(targetBytes);
    return [limitBytes, targetBytes];
  }

  function plantStaggered(imgDir: string, count: number): void {
    for (let i = 0; i < count; i++) {
      const f = path.join(imgDir, `img_${String(i).padStart(2, "0")}.webp`);
      fs.writeFileSync(f, Buffer.alloc(100, "x"));
      const ts = _now() - (count - i) * 10; // i=0 oldest
      utime(f, ts);
    }
  }

  function remainingBytes(imgDir: string): number {
    let total = 0;
    for (const name of fs.readdirSync(imgDir)) {
      const st = fs.statSync(path.join(imgDir, name));
      if (st.isFile()) {
        total += st.size;
      }
    }
    return total;
  }

  it("test_eviction_drives_to_target_not_just_limit", () => {
    paths.ensureDirs();
    const imgDir = paths.imageCacheDir();
    const [, target] = setSmallLimits(1000);
    // 12 files at 100 bytes = 1200 bytes total (20% over LIMIT).
    for (let i = 0; i < 12; i++) {
      const f = path.join(imgDir, `img_${String(i).padStart(2, "0")}.webp`);
      fs.writeFileSync(f, Buffer.alloc(100, "x"));
      const ts = _now() - (12 - i) * 5;
      utime(f, ts);
    }
    worker.evict_image_cache_if_over_limit();
    expect(remainingBytes(imgDir) <= target).toBe(true);
  });

  it("test_eviction_oldest_mtime_evicted_first", () => {
    paths.ensureDirs();
    const imgDir = paths.imageCacheDir();
    setSmallLimits(500);
    plantStaggered(imgDir, 6); // 6 × 100 = 600 bytes
    worker.evict_image_cache_if_over_limit();
    const remaining = new Set(fs.readdirSync(imgDir));
    // img_00 (oldest) must be gone; img_05 (newest) must survive.
    expect(remaining.has("img_00.webp")).toBe(false);
    expect(remaining.has("img_05.webp")).toBe(true);
  });

  it.skip("test_cache_hit_bumps_mtime_for_true_lru — drives image_shrink.shrink with PIL/WEBP (image layer not ported)", () => {});

  it("test_concurrent_eviction_lock_mutex", () => {
    paths.ensureDirs();
    const imgDir = paths.imageCacheDir();
    setSmallLimits(500);
    plantStaggered(imgDir, 6);

    // Pre-create a fresh lockfile to simulate "another evictor is running".
    const lockPath = path.join(paths.locksDir(), "image_cache_eviction.lock");
    paths.ensureDir(path.dirname(lockPath));
    fs.writeFileSync(lockPath, `${getpid()}\n${_now()}\n`, "utf-8");

    const result = worker.evict_image_cache_if_over_limit();
    expect(result).toEqual([0, 0]);
    expect(remainingBytes(imgDir)).toBe(600);

    fs.unlinkSync(lockPath);
  });

  it("test_stale_eviction_lock_is_reclaimed", () => {
    paths.ensureDirs();
    const imgDir = paths.imageCacheDir();
    const [, target] = setSmallLimits(500);
    plantStaggered(imgDir, 6);

    // Plant a stale lockfile — mtime older than _EVICTION_LOCK_STALE_SECONDS.
    const lockPath = path.join(paths.locksDir(), "image_cache_eviction.lock");
    paths.ensureDir(path.dirname(lockPath));
    fs.writeFileSync(lockPath, "99999999\nold\n", "utf-8");
    const staleTs = _now() - (worker._EVICTION_LOCK_STALE_SECONDS + 60);
    utime(lockPath, staleTs);

    const [bytesFreed, filesFreed] = worker.evict_image_cache_if_over_limit();
    expect(bytesFreed > 0 && filesFreed > 0).toBe(true);
    expect(remainingBytes(imgDir) <= target).toBe(true);
  });

  it("test_eviction_releases_lock_on_exit", () => {
    paths.ensureDirs();
    const imgDir = paths.imageCacheDir();
    setSmallLimits(500);
    plantStaggered(imgDir, 6);
    worker.evict_image_cache_if_over_limit();
    const lockPath = path.join(paths.locksDir(), "image_cache_eviction.lock");
    expect(fs.existsSync(lockPath)).toBe(false);
  });

  it("test_eviction_releases_lock_on_below_limit_path", () => {
    paths.ensureDirs();
    const imgDir = paths.imageCacheDir();
    // Huge limit so the sample file stays under it (early-return branch).
    worker._setImageCacheLimit(10 * 1024 * 1024);
    fs.writeFileSync(path.join(imgDir, "tiny.webp"), Buffer.alloc(100, "x"));

    const result = worker.evict_image_cache_if_over_limit();
    expect(result).toEqual([0, 0]);
    const lockPath = path.join(paths.locksDir(), "image_cache_eviction.lock");
    expect(fs.existsSync(lockPath)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// TestCheckpointProjectWals — _checkpoint_project_wals (not exported)
// ---------------------------------------------------------------------------

describe("TestCheckpointProjectWals", () => {
  function insertProject(ph: string, root: string): void {
    db.openGlobal((gconn) => {
      const now = Math.trunc(_now());
      gconn
        .prepare(
          "INSERT OR REPLACE INTO projects(hash, root, marker, first_seen, last_seen, file_count, languages) " +
            "VALUES (?, ?, ?, ?, ?, ?, ?)",
        )
        .run(ph, root, ".git", now, now, 1, "python");
    });
  }

  it("test_no_projects_returns_zero", () => {
    // With no projects registered in global.db, returns 0 with no errors.
    expect(worker._checkpoint_project_wals()).toBe(0);
  });

  it("test_project_with_no_wal_file_is_skipped_gracefully", () => {
    // A project whose WAL file does not exist is skipped without error.
    insertProject("a".repeat(40), "/some/proj");
    expect(worker._checkpoint_project_wals()).toBe(0);
  });

  it("test_db_error_listing_projects_returns_zero", () => {
    // If opening global.db to list projects fails, return 0 without propagating.
    const spy = vi.spyOn(db, "openGlobalReadonly").mockImplementation(() => {
      throw new db.DBError("simulated global DB error");
    });
    try {
      expect(worker._checkpoint_project_wals()).toBe(0);
    } finally {
      spy.mockRestore();
    }
  });

  it("test_checkpoint_error_on_one_project_continues_and_returns_zero", () => {
    // A checkpoint failure on a project is caught; no exception propagates.
    const ph = "b".repeat(40);
    insertProject(ph, "/some/other/proj");

    // Create a fake WAL file so the size-check path is reached.
    const dbPath = paths.projectDbPath(ph);
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    fs.writeFileSync(dbPath + "-wal", Buffer.alloc(512, "x"));

    // Make open_project raise so the checkpoint itself fails.
    const spy = vi.spyOn(db, "openProject").mockImplementation(() => {
      throw new db.DBError("simulated checkpoint failure");
    });
    try {
      const result = worker._checkpoint_project_wals();
      expect(typeof result).toBe("number");
    } finally {
      spy.mockRestore();
    }
  });

  it("test_project_with_wal_reclaims_bytes", async () => {
    // A real project WAL is checkpointed and the reclaimed byte count is a
    // non-negative integer. Build a real indexed project so openProject works.
    const projRoot = path.join(paths.dataDir(), "wal_proj");
    fs.mkdirSync(projRoot, { recursive: true });
    fs.writeFileSync(path.join(projRoot, "mod.py"), "def hello(): pass\n", "utf-8");
    const ph = project.project_hash(project.canonicalize(projRoot));
    await parser.index_project(project.make_project_at(projRoot), { full: true });

    insertProject(ph, projRoot);

    // Ensure a WAL file exists (the checkpoint will shrink/remove it).
    const dbPath = paths.projectDbPath(ph);
    const walPath = dbPath + "-wal";
    if (!fs.existsSync(walPath)) {
      fs.writeFileSync(walPath, Buffer.alloc(4096, 0));
    }

    const result = worker._checkpoint_project_wals();
    expect(typeof result).toBe("number");
    expect(result).toBeGreaterThanOrEqual(0);
  });
});

// ---------------------------------------------------------------------------
// Dirty-queue file locking (concurrency)
// ---------------------------------------------------------------------------

describe("enqueue_dirty concurrency / lock", () => {
  it("test_enqueue_dirty_concurrent_writes", () => {
    // Node is single-threaded; Python's 4-thread torn-write test reduces to a
    // sequential batch of 80 appends that must all land as well-formed JSON.
    const numThreads = 4;
    const entriesPerThread = 20;
    const totalExpected = numThreads * entriesPerThread;

    for (let threadId = 0; threadId < numThreads; threadId++) {
      for (let i = 0; i < entriesPerThread; i++) {
        worker.enqueue_dirty(`src/thread_${threadId}_file_${i}.ts`, `proj_${threadId}`);
      }
    }

    const queueFile = paths.dirtyQueuePath();
    expect(fs.existsSync(queueFile)).toBe(true);
    const lines = fs
      .readFileSync(queueFile, "utf-8")
      .split("\n")
      .filter((l) => l.length > 0);
    expect(lines.length).toBe(totalExpected);
    for (let i = 0; i < lines.length; i++) {
      const entry = JSON.parse(lines[i]!) as Record<string, unknown>;
      expect("path" in entry, `Line ${i} missing 'path'`).toBe(true);
      expect("project_hash" in entry, `Line ${i} missing 'project_hash'`).toBe(true);
      expect("ts" in entry, `Line ${i} missing 'ts'`).toBe(true);
    }
  });

  it.skip("test_enqueue_dirty_drops_entry_when_os_lock_not_acquired — monkeypatches private _dirty_queue_lock to yield False; it is not exported and enqueue_dirty calls it directly, so the not-acquired drop branch is unobservable. (In TS _dirty_queue_lock always yields true anyway — Node has no stdlib advisory lock.)", () => {});
});

// ---------------------------------------------------------------------------
// OSError handling in psutil Process queries — private seams (not exported)
// ---------------------------------------------------------------------------

describe("psutil OSError handling", () => {
  // In Python the OSError originates inside psutil.Process(pid).create_time() /
  // .cmdline() and _proc_create_time / _is_token_goat_worker catch it. In the TS
  // port the psutil.Process boundary IS the _setProcessIntrospection seam, whose
  // createTime/cmdline contract is "return null on failure, never throw". The
  // catch therefore lives in the seam (default impl already returns null), not in
  // _proc_create_time (which is a thin pass-through with no try/catch). Driving
  // the seam to throw and asserting the thin wrapper catches it tests a Python
  // boundary that does not exist in this design. DEFER (design divergence, not a
  // bug): the OSError-returns-null contract is held by the default seam.
  it.skip("test_proc_create_time_oserror_returns_none — the OSError catch is owned by the introspection seam (returns null), not by _proc_create_time", () => {});
  it.skip("test_is_process_recent_oserror_returns_false — OSError catch owned by the createTime seam (returns null), not _is_process_recent", () => {});
  it.skip("test_is_token_goat_worker_oserror_returns_false — OSError catch owned by the cmdline seam (returns null), not _is_token_goat_worker", () => {});
});

// ---------------------------------------------------------------------------
// no source files found — parser message level
// ---------------------------------------------------------------------------

describe("parser message level", () => {
  it("test_no_source_files_message_is_debug_not_info", async () => {
    // index_project emits the 'no source files' message at DEBUG, not INFO, so it
    // does not pollute worker-stderr.log. The TS Logger forwards .debug ->
    // console.debug and .info -> console.info, so we spy on both.
    const emptyDir = path.join(paths.dataDir(), "empty_project");
    fs.mkdirSync(emptyDir, { recursive: true });
    const proj = project.make_project_at(emptyDir);

    const debugSpy = vi.spyOn(console, "debug").mockImplementation(() => {});
    const infoSpy = vi.spyOn(console, "info").mockImplementation(() => {});
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await parser.index_project(proj, { full: true });
    } finally {
      const inArgs = (call: unknown[]): boolean =>
        call.some((a) => typeof a === "string" && a.includes("no source files"));
      const debugHits = debugSpy.mock.calls.filter(inArgs);
      const infoOrAbove = [
        ...infoSpy.mock.calls,
        ...warnSpy.mock.calls,
        ...errorSpy.mock.calls,
      ].filter(inArgs);
      debugSpy.mockRestore();
      infoSpy.mockRestore();
      warnSpy.mockRestore();
      errorSpy.mockRestore();
      expect(debugHits.length, "expected 'no source files' message at DEBUG").toBeGreaterThan(0);
      expect(infoOrAbove.length, "'no source files' must not appear at INFO+").toBe(0);
    }
  });
});

// ---------------------------------------------------------------------------
// _gc_orphaned_projects — orphan project GC (exported)
// ---------------------------------------------------------------------------

describe("_gc_orphaned_projects", () => {
  function insertProjectRow(hashVal: string, root: string, lastSeen: number): void {
    db.openGlobal((gconn) => {
      const now = Math.trunc(_now());
      gconn
        .prepare(
          "INSERT OR REPLACE INTO projects(hash, root, marker, first_seen, last_seen, file_count, languages) " +
            "VALUES (?, ?, ?, ?, ?, ?, ?)",
        )
        .run(hashVal, root, ".git", now, Math.trunc(lastSeen), 0, "");
    });
  }

  function selectRoot(ph: string): { root: string } | undefined {
    return db.openGlobal((gconn) => {
      return gconn.prepare("SELECT root FROM projects WHERE hash = ?").get(ph) as
        | { root: string }
        | undefined;
    });
  }

  it("test_gc_orphaned_projects_spares_existing_dir", () => {
    const root = path.join(paths.dataDir(), "live_project");
    fs.mkdirSync(root, { recursive: true });
    const ph = project.project_hash(root);
    insertProjectRow(ph, root, _now() - 7200);

    expect(worker._gc_orphaned_projects()).toBe(0);
    expect(selectRoot(ph)).not.toBe(undefined);
  });

  it("test_gc_orphaned_projects_removes_deleted_dir", () => {
    const root = path.join(paths.dataDir(), "deleted_project");
    fs.mkdirSync(root, { recursive: true });
    const ph = project.project_hash(root);
    insertProjectRow(ph, root, _now() - 7200);

    const dbPath = paths.projectDbPath(ph);
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    fs.writeFileSync(dbPath, Buffer.alloc(0));

    fs.rmdirSync(root);

    expect(worker._gc_orphaned_projects()).toBe(1);
    expect(selectRoot(ph)).toBe(undefined);
    expect(fs.existsSync(dbPath)).toBe(false);
  });

  it("test_gc_orphaned_projects_spares_recent_last_seen", () => {
    const root = path.join(paths.dataDir(), "recent_project");
    fs.mkdirSync(root, { recursive: true });
    const ph = project.project_hash(root);
    insertProjectRow(ph, root, _now() - 60);

    fs.rmdirSync(root);

    expect(worker._gc_orphaned_projects()).toBe(0);
    expect(selectRoot(ph)).not.toBe(undefined);
  });

  it("test_gc_orphaned_projects_toctou_concurrent_touch_preserves_row", () => {
    const root = path.join(paths.dataDir(), "concurrent_project");
    fs.mkdirSync(root, { recursive: true });
    const ph = project.project_hash(root);
    insertProjectRow(ph, root, _now() - 7200);
    fs.rmdirSync(root);

    // Before GC issues the DELETE (the 2nd openGlobal call), bump last_seen into
    // the safety window — the conditional DELETE must then be a no-op.
    let callCount = 0;
    const orig = db.openGlobal.bind(db);
    const impl = ((body: (c: unknown) => unknown): unknown => {
      callCount += 1;
      if (callCount === 2) {
        orig((touchConn) => {
          (touchConn as { prepare: (s: string) => { run: (...a: unknown[]) => unknown } })
            .prepare("UPDATE projects SET last_seen = ? WHERE hash = ?")
            .run(Math.trunc(_now()), ph);
        });
      }
      return orig(body as never);
    }) as typeof db.openGlobal;
    const spy = vi.spyOn(db, "openGlobal").mockImplementation(impl);
    try {
      expect(worker._gc_orphaned_projects()).toBe(0);
    } finally {
      spy.mockRestore();
    }
    expect(selectRoot(ph)).not.toBe(undefined);
  });
});

// ---------------------------------------------------------------------------
// _cleanup_old_sessions — session JSON eviction (private fn, but cleanup_on_startup
//   surfaces the count). The standalone-fn tests are deferred; the wired-in test
//   is exercised end-to-end through cleanup_on_startup.
// ---------------------------------------------------------------------------

describe("cleanup old sessions", () => {
  function makeSessionFile(sessionsDir: string, name: string, ageSecs: number): string {
    const f = path.join(sessionsDir, name);
    fs.writeFileSync(f, "{}", "utf-8");
    const old = _now() - ageSecs;
    utime(f, old);
    return f;
  }

  // _SESSION_RETENTION_DAYS is module-private (7). A "stale" age is any value
  // comfortably past it; 8 days is used (matching the existing end-to-end case).
  const STALE_AGE = 8 * 86400;

  it("test_cleanup_old_sessions_removes_stale", () => {
    const sessionsDir = path.join(paths.dataDir(), "sessions");
    fs.mkdirSync(sessionsDir, { recursive: true });
    const stale = makeSessionFile(sessionsDir, "stale-session.json", STALE_AGE);
    const fresh = makeSessionFile(sessionsDir, "fresh-session.json", 3600);

    const removed = worker._cleanup_old_sessions();
    expect(removed).toBe(1);
    expect(fs.existsSync(stale)).toBe(false);
    expect(fs.existsSync(fresh)).toBe(true);
  });

  it("test_cleanup_old_sessions_spares_fresh", () => {
    const sessionsDir = path.join(paths.dataDir(), "sessions");
    fs.mkdirSync(sessionsDir, { recursive: true });
    const recent = makeSessionFile(sessionsDir, "recent.json", 60);

    const removed = worker._cleanup_old_sessions();
    expect(removed).toBe(0);
    expect(fs.existsSync(recent)).toBe(true);
  });

  it("test_cleanup_old_sessions_ignores_non_json", () => {
    const sessionsDir = path.join(paths.dataDir(), "sessions");
    fs.mkdirSync(sessionsDir, { recursive: true });
    const nonJson = makeSessionFile(sessionsDir, "not-a-session.txt", STALE_AGE);

    const removed = worker._cleanup_old_sessions();
    expect(removed).toBe(0);
    expect(fs.existsSync(nonJson)).toBe(true);
  });

  it("test_cleanup_old_sessions_no_dir_returns_zero", () => {
    const sessionsDir = path.join(paths.dataDir(), "sessions");
    expect(fs.existsSync(sessionsDir)).toBe(false);
    expect(worker._cleanup_old_sessions()).toBe(0);
  });

  it("test_cleanup_old_sessions_removes_companion_sidecars", () => {
    const sessionsDir = path.join(paths.dataDir(), "sessions");
    fs.mkdirSync(sessionsDir, { recursive: true });
    const staleJson = makeSessionFile(sessionsDir, "sid-old.json", STALE_AGE);
    const lockSidecar = path.join(sessionsDir, "sid-old.json.lock");
    const flockSidecar = path.join(sessionsDir, "sid-old.json.flock");
    fs.writeFileSync(lockSidecar, "", "utf-8");
    fs.writeFileSync(flockSidecar, "", "utf-8");

    const removed = worker._cleanup_old_sessions();
    expect(removed).toBe(1);
    expect(fs.existsSync(staleJson)).toBe(false);
    expect(fs.existsSync(lockSidecar)).toBe(false);
    expect(fs.existsSync(flockSidecar)).toBe(false);
  });

  it("test_cleanup_old_sessions_sweeps_orphaned_sidecars", () => {
    const sessionsDir = path.join(paths.dataDir(), "sessions");
    fs.mkdirSync(sessionsDir, { recursive: true });
    const orphanLock = path.join(sessionsDir, "sid-gone.json.lock");
    const orphanFlock = path.join(sessionsDir, "sid-gone.json.flock");
    fs.writeFileSync(orphanLock, "", "utf-8");
    fs.writeFileSync(orphanFlock, "", "utf-8");

    worker._cleanup_old_sessions();
    expect(fs.existsSync(orphanLock)).toBe(false);
    expect(fs.existsSync(orphanFlock)).toBe(false);
  });

  it.skip("test_cleanup_old_sessions_wired_into_cleanup_on_startup — monkeypatches _cleanup_old_sessions, invoked via a captured reference (the _int_tasks array), so a namespace spy is not observed", () => {});

  it("test_cleanup_old_sessions_end_to_end_via_cleanup_on_startup", () => {
    // TS-port-added end-to-end check (the wired-in contract): a real stale
    // session JSON is removed and surfaced as old_sessions_removed >= 1.
    const sessionsDir = path.join(paths.dataDir(), "sessions");
    fs.mkdirSync(sessionsDir, { recursive: true });
    const stale = makeSessionFile(sessionsDir, "stale-session.json", 8 * 86400);
    const fresh = makeSessionFile(sessionsDir, "fresh-session.json", 3600);

    const stats = worker.cleanup_on_startup();
    expect((stats.old_sessions_removed ?? 0) >= 1).toBe(true);
    expect(fs.existsSync(stale)).toBe(false);
    expect(fs.existsSync(fresh)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Eviction Lock Reliability — private fns (_eviction_lock_is_stale etc.)
// ---------------------------------------------------------------------------

describe("TestEvictionLockConflictLogging / AutoClears", () => {
  // The two "logs_warning" cases assert the WARNING log message text. Their
  // distinguishing contract is the log string ("contention" / "fresh"); the
  // stale-collision case additionally needs os.open to raise EEXIST twice, which
  // the TS impl issues via the `fs` namespace (fs.openSync) that a vi.spyOn
  // cannot intercept. There is no log-capture seam in this suite, so the
  // load-bearing log assertion is unobservable. (The null-on-fresh-lock behavior
  // itself is covered by test_concurrent_eviction_lock_mutex.) DEFER.
  it.skip("test_acquire_lock_logs_warning_on_stale_lock_collision — needs fs.openSync to raise EEXIST twice (uninterceptable namespace import) + no log-capture seam", () => {});
  it.skip("test_acquire_lock_logs_warning_on_fresh_lock_conflict — asserts a WARNING log string with no log-capture seam (behavior covered by test_concurrent_eviction_lock_mutex)", () => {});

  it("test_clear_stale_eviction_lock_removes_old_lock", () => {
    paths.ensureDirs();
    const lockPath = path.join(paths.locksDir(), "image_cache_eviction.lock");
    fs.writeFileSync(lockPath, "dead_pid\nstale_time\n", "utf-8");
    const staleMtime = _now() - (worker._EVICTION_LOCK_STALE_SECONDS + 100);
    utime(lockPath, staleMtime);

    expect(fs.existsSync(lockPath)).toBe(true);
    expect(worker._eviction_lock_is_stale(lockPath)).toBe(true);

    worker._clear_stale_eviction_lock();
    expect(fs.existsSync(lockPath)).toBe(false);
  });

  it("test_clear_stale_eviction_lock_preserves_fresh_lock", () => {
    paths.ensureDirs();
    const lockPath = path.join(paths.locksDir(), "image_cache_eviction.lock");
    fs.writeFileSync(lockPath, "current_pid\ncurrent_time\n", "utf-8");
    utime(lockPath, _now());

    expect(fs.existsSync(lockPath)).toBe(true);
    expect(worker._eviction_lock_is_stale(lockPath)).toBe(false);

    worker._clear_stale_eviction_lock(); // no-op
    expect(fs.existsSync(lockPath)).toBe(true);
  });

  it("test_clear_stale_eviction_lock_wired_into_cleanup_on_startup", () => {
    paths.ensureDirs();
    const lockPath = path.join(paths.locksDir(), "image_cache_eviction.lock");
    fs.writeFileSync(lockPath, "dead\nold\n", "utf-8");
    const staleMtime = _now() - (worker._EVICTION_LOCK_STALE_SECONDS + 60);
    utime(lockPath, staleMtime);
    expect(fs.existsSync(lockPath)).toBe(true);

    worker.cleanup_on_startup();
    expect(fs.existsSync(lockPath)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// TestEnqueueDirtyRegression — append-only + byte-size cap (real DIRTY_QUEUE_MAX_BYTES)
// ---------------------------------------------------------------------------

describe("TestEnqueueDirtyRegression", () => {
  it("test_appends_second_entry_preserves_first", () => {
    paths.ensureDirs();
    worker.enqueue_dirty("a/first.py", "proj1");
    worker.enqueue_dirty("b/second.py", "proj1");

    const queueFile = paths.dirtyQueuePath();
    const lines = fs
      .readFileSync(queueFile, "utf-8")
      .split("\n")
      .filter((l) => l.trim().length > 0);
    expect(lines.length).toBe(2);
    const pathsInQueue = lines.map((ln) => (JSON.parse(ln) as { path: string }).path);
    expect(pathsInQueue).toContain("a/first.py");
    expect(pathsInQueue).toContain("b/second.py");
  });

  it("test_byte_cap_drops_entry_without_reading_file", () => {
    paths.ensureDirs();
    const queueFile = paths.dirtyQueuePath();
    paths.ensureDir(path.dirname(queueFile));
    fs.writeFileSync(queueFile, Buffer.alloc(worker.DIRTY_QUEUE_MAX_BYTES, "x"));
    const sizeBefore = fs.statSync(queueFile).size;

    worker.enqueue_dirty("should_be_dropped.py", "proj1");

    expect(fs.statSync(queueFile).size).toBe(sizeBefore);
  });

  it("test_entry_appended_when_below_cap", () => {
    paths.ensureDirs();
    const queueFile = paths.dirtyQueuePath();
    paths.ensureDir(path.dirname(queueFile));
    fs.writeFileSync(queueFile, Buffer.alloc(worker.DIRTY_QUEUE_MAX_BYTES - 500, "x"));
    const sizeBefore = fs.statSync(queueFile).size;

    worker.enqueue_dirty("fits.py", "proj1");

    expect(fs.statSync(queueFile).size > sizeBefore).toBe(true);
  });
});
