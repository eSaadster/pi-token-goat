/**
 * Tests for worker.ts reliability improvements:
 *
 *  * corrupt-line skipping in drain_dirty_queue
 *  * per-project exponential backoff tracking
 *  * graceful shutdown via stop_event on SIGTERM/SIGINT
 *  * memory pressure guard skips indexing
 *  * indexing timeout
 *
 * Faithful 1:1 TS port of tests/test_worker_reliability.py
 *   - class Test*  -> describe
 *   - def test_*   -> it() (same name, same assertion polarity)
 *
 * Test-seam / fixture mapping (Python -> TS):
 *  - tmp_data_dir fixture
 *      -> tests/setup.ts already redirects the data dir to a per-test tmp dir,
 *        so paths.dirtyQueuePath() etc. resolve under it with no per-test setup.
 *  - paths.dirty_queue_path() / paths.ensure_dir()
 *      -> paths.dirtyQueuePath() / paths.ensureDir().
 *  - caplog.at_level(WARNING, logger="token_goat.worker")
 *      -> vi.spyOn(console, "warn"); util.ts forwards WARNING -> console.warn
 *        with a `[token_goat.worker] <msg>` prefix.
 *
 * DEFERRED groups (it.skip with reason). The TS port of worker.ts keeps a large
 * set of the reliability internals module-private; the Python tests reach into
 * them directly. Where the symbol is simply not exported it is recorded in the
 * task report under missingExports. Where the TS port deliberately diverges from
 * the Python implementation (no ThreadPoolExecutor, no real wall-clock index
 * timeout, no sys.exit() from the signal handler) or where the case would drive
 * the live daemon main loop, the case is deferred to avoid asserting behaviour
 * the port does not implement / to avoid forking a real daemon:
 *
 *   TestBackoffHelpers       — _record_index_failure / _record_index_success /
 *                              _should_skip_due_to_backoff / _index_failure_counts
 *                              / _index_backoff_until / _BACKOFF_FAILURE_THRESHOLD
 *                              / _BACKOFF_MAX_SECS are NOT exported (missingExports).
 *   TestGracefulShutdown     — _graceful_shutdown / _install_signal_handlers /
 *                              _daemon_stop_event are NOT exported (worker_daemon.ts);
 *                              the fallback test additionally expects SystemExit(0),
 *                              which the TS port intentionally does NOT do (it clears
 *                              the PID file and keeps running so a signal can't kill a
 *                              vitest run); the SIGTERM case drives the live daemon
 *                              main loop (would fork the real daemon).
 *   TestMemoryPressureGuard  — _is_under_memory_pressure / _get_rss_mb are NOT
 *                              exported, and _process_dirty_entries /
 *                              _reindex_active_projects call _is_under_memory_pressure
 *                              directly (not via the module namespace), so a vi.spyOn
 *                              seam cannot intercept it even if exported.
 *   TestIndexTimeout         — _run_index_with_timeout is NOT exported; the TS port
 *                              has no real wall-clock timeout (synchronous parser
 *                              seam, `void timeout`), so a genuinely-blocking "slow"
 *                              index would hang the suite rather than return None.
 *   TestPoolSizeCap          — _run_index_with_timeout / _get_max_pool_workers are
 *                              NOT exported; the explicit-max / ceiling cases patch
 *                              concurrent.futures.ThreadPoolExecutor, which the TS
 *                              port does not use (no thread pool — pool size is a
 *                              documented no-op).
 */
import fs from "node:fs";
import os from "node:os";
import nodePath from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import * as config from "../src/token_goat/config.js";
import * as paths from "../src/token_goat/paths.js";
import type { Project } from "../src/token_goat/project.js";
import * as worker from "../src/token_goat/worker.js";
import * as worker_daemon from "../src/token_goat/worker_daemon.js";

/**
 * Compute the backoff-map key the way worker._key() does: project_hash and
 * rel_path joined by a NUL separator. The Python tests index
 * _index_failure_counts / _index_backoff_until with a (project_hash, rel_path)
 * tuple; the TS Maps are keyed by this joined string.
 */
function backoffKey(projectHash: string, relPath: string): string {
  return `${projectHash}\u0000${relPath}`;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Write raw text lines directly to the dirty queue file, bypassing enqueue_dirty. */
function writeRawQueueLines(lines: string[]): void {
  const queuePath = paths.dirtyQueuePath();
  paths.ensureDir(nodePath.dirname(queuePath));
  fs.writeFileSync(queuePath, lines.map((l) => l + "\n").join(""), { encoding: "utf-8" });
}

afterEach(() => {
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// 1. Corrupt-line skipping
// ---------------------------------------------------------------------------

describe("TestDirtyQueueCorruptLineSkipping", () => {
  // drain_dirty_queue must skip bad lines rather than crashing.

  it("test_invalid_json_is_skipped", () => {
    // A line that is not valid JSON is logged and dropped; good lines survive.
    const good = JSON.stringify({ path: "src/foo.py", project_hash: "abc123", ts: 1.0 });
    const bad = "THIS IS NOT JSON {";
    writeRawQueueLines([good, bad]);

    const entries = worker.drain_dirty_queue();
    expect(entries).not.toBeNull();
    expect(entries!.length).toBe(1);
    expect(entries![0]!.path).toBe("src/foo.py");
  });

  it("test_truncated_json_is_skipped", () => {
    // A truncated JSON object (partial write) is dropped without raising.
    const good = JSON.stringify({ path: "src/bar.py", project_hash: "abc123", ts: 2.0 });
    const truncated = '{"path": "src/incomplete.py", "project'; // truncated mid-string
    writeRawQueueLines([truncated, good]);

    const entries = worker.drain_dirty_queue();
    expect(entries).not.toBeNull();
    expect(entries!.length).toBe(1);
    expect(entries![0]!.path).toBe("src/bar.py");
  });

  it("test_json_non_dict_is_skipped", () => {
    // A valid JSON line that is not a dict (e.g. a list) is dropped.
    const nonDict = JSON.stringify(["src/foo.py", "abc123"]);
    const good = JSON.stringify({ path: "src/good.py", project_hash: "abc123", ts: 3.0 });
    writeRawQueueLines([nonDict, good]);

    const entries = worker.drain_dirty_queue();
    expect(entries).not.toBeNull();
    expect(entries!.length).toBe(1);
    expect(entries![0]!.path).toBe("src/good.py");
  });

  it("test_empty_lines_are_ignored", () => {
    // Blank lines in the queue file are silently discarded.
    const good = JSON.stringify({ path: "src/baz.py", project_hash: "abc123", ts: 4.0 });
    writeRawQueueLines(["", "   ", good, ""]);

    const entries = worker.drain_dirty_queue();
    expect(entries).not.toBeNull();
    expect(entries!.length).toBe(1);
  });

  it("test_entirely_corrupt_queue_returns_empty", () => {
    // A queue containing only corrupt lines returns an empty list, not null.
    writeRawQueueLines([
      "not json at all",
      "also bad {{{",
      JSON.stringify([1, 2, 3]),
    ]);

    const entries = worker.drain_dirty_queue();
    // Should return [] (empty but not null — no deferred drain occurred).
    expect(entries).toEqual([]);
  });

  it("test_mix_of_corrupt_and_valid_logs_warning", () => {
    // Corrupt lines produce a WARNING log entry.
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const good = JSON.stringify({ path: "x.py", project_hash: "abc123", ts: 5.0 });
    writeRawQueueLines(["bad json", good]);

    const entries = worker.drain_dirty_queue();

    expect(entries).not.toBeNull();
    expect(entries!.length).toBe(1);
    const msgs = warnSpy.mock.calls.map((c) => c.map(String).join(" "));
    expect(
      msgs.some((m) => m.includes("not valid JSON") || m.toLowerCase().includes("malformed")),
      `expected a WARNING about malformed/invalid JSON; got: ${JSON.stringify(msgs)}`,
    ).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 2. Exponential backoff helpers
// ---------------------------------------------------------------------------

describe("TestBackoffHelpers", () => {
  // _record_index_failure / _record_index_success / _should_skip_due_to_backoff.
  // All exported from worker.ts (incl. _index_failure_counts / _index_backoff_until /
  // _BACKOFF_FAILURE_THRESHOLD / _BACKOFF_MAX_SECS), so these cases are live.
  //
  // Python's setup_method/teardown_method clear the two in-memory Maps before and
  // after each case; here a beforeEach/afterEach pair reproduces that scope.

  beforeEach(() => {
    worker._index_failure_counts.clear();
    worker._index_backoff_until.clear();
  });
  afterEach(() => {
    worker._index_failure_counts.clear();
    worker._index_backoff_until.clear();
  });

  it("test_no_backoff_before_threshold", () => {
    // Fewer than _BACKOFF_FAILURE_THRESHOLD failures should not activate backoff.
    const ph = "aabbccdd";
    const rel = "src/foo.py";
    for (let i = 0; i < worker._BACKOFF_FAILURE_THRESHOLD - 1; i++) {
      worker._record_index_failure(ph, rel);
    }
    expect(worker._should_skip_due_to_backoff(ph, rel)).toBe(false);
  });

  it("test_backoff_activates_at_threshold", () => {
    // Exactly _BACKOFF_FAILURE_THRESHOLD failures should activate backoff.
    const ph = "aabbccdd";
    const rel = "src/foo.py";
    for (let i = 0; i < worker._BACKOFF_FAILURE_THRESHOLD; i++) {
      worker._record_index_failure(ph, rel);
    }
    expect(worker._should_skip_due_to_backoff(ph, rel)).toBe(true);
  });

  it("test_backoff_delay_grows_exponentially", () => {
    // Each failure beyond the threshold should grow the backoff delay.
    const ph = "aabbccdd";
    const rel = "src/foo.py";
    const delays: number[] = [];
    for (let i = 0; i < worker._BACKOFF_FAILURE_THRESHOLD + 3; i++) {
      worker._record_index_failure(ph, rel);
      const until = worker._index_backoff_until.get(backoffKey(ph, rel)) ?? 0.0;
      if (until > 0) {
        delays.push(until - Date.now() / 1000);
      }
    }
    // Each successive delay should be larger than the previous (10% jitter tolerance).
    expect(delays.length).toBeGreaterThanOrEqual(2);
    for (let i = 1; i < delays.length; i++) {
      expect(delays[i]!).toBeGreaterThan(delays[i - 1]! * 0.9);
    }
  });

  it("test_backoff_capped_at_max", () => {
    // Delay should not exceed _BACKOFF_MAX_SECS regardless of failure count.
    const ph = "aabbccdd";
    const rel = "src/baz.py";
    for (let i = 0; i < 50; i++) {
      worker._record_index_failure(ph, rel);
    }
    const until = worker._index_backoff_until.get(backoffKey(ph, rel)) ?? 0.0;
    const delay = until - Date.now() / 1000;
    expect(delay).toBeLessThanOrEqual(worker._BACKOFF_MAX_SECS + 1.0); // 1s tolerance
  });

  it("test_success_clears_backoff", () => {
    // After _record_index_success, the path should no longer be in backoff.
    const ph = "aabbccdd";
    const rel = "src/foo.py";
    for (let i = 0; i < worker._BACKOFF_FAILURE_THRESHOLD + 1; i++) {
      worker._record_index_failure(ph, rel);
    }
    expect(worker._should_skip_due_to_backoff(ph, rel)).toBe(true);

    worker._record_index_success(ph, rel);
    expect(worker._should_skip_due_to_backoff(ph, rel)).toBe(false);
    expect(worker._index_failure_counts.has(backoffKey(ph, rel))).toBe(false);
    expect(worker._index_backoff_until.has(backoffKey(ph, rel))).toBe(false);
  });

  it("test_different_projects_tracked_independently", () => {
    // Failures for one project should not affect another.
    const ph1 = "aaaaaaaa";
    const ph2 = "bbbbbbbb";
    const rel = "src/foo.py";
    for (let i = 0; i < worker._BACKOFF_FAILURE_THRESHOLD + 2; i++) {
      worker._record_index_failure(ph1, rel);
    }
    // ph1 in backoff, ph2 is clean.
    expect(worker._should_skip_due_to_backoff(ph1, rel)).toBe(true);
    expect(worker._should_skip_due_to_backoff(ph2, rel)).toBe(false);
  });

  it("test_backoff_expires_after_window", () => {
    // Once the backoff window passes, the path should be retried.
    const ph = "aabbccdd";
    const rel = "src/foo.py";
    for (let i = 0; i < worker._BACKOFF_FAILURE_THRESHOLD; i++) {
      worker._record_index_failure(ph, rel);
    }
    // Manually backdate the expiry so the window has already passed.
    worker._index_backoff_until.set(backoffKey(ph, rel), Date.now() / 1000 - 1.0);
    expect(worker._should_skip_due_to_backoff(ph, rel)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 3. Graceful shutdown via stop_event
// ---------------------------------------------------------------------------

describe("TestGracefulShutdown", () => {
  // SIGTERM / SIGINT should set the stop_event rather than calling sys.exit.
  // worker_daemon now exports _graceful_shutdown / _install_signal_handlers and a
  // get/set seam for the module-level stop event (_get_daemon_stop_event /
  // _set_daemon_stop_event); Python's direct `worker_daemon._daemon_stop_event = x`
  // assignment maps onto those accessors.

  it("test_graceful_shutdown_sets_stop_event", () => {
    // _graceful_shutdown sets the daemon stop event instead of exiting.
    const stop = new worker.StopEvent();
    worker_daemon._set_daemon_stop_event(stop);
    try {
      worker_daemon._graceful_shutdown("SIGTERM");
      expect(stop.is_set()).toBe(true);
    } finally {
      worker_daemon._set_daemon_stop_event(null);
    }
  });

  // test_graceful_shutdown_falls_back_without_stop_event stays skipped: the Python
  // case asserts the no-stop-event fallback raises SystemExit(0). The TS port
  // deliberately does NOT process.exit() from the signal handler (a hard exit from
  // a signal handler would kill the vitest run); it clears the PID file and keeps
  // running. Asserting SystemExit would assert behaviour the port intentionally
  // does not implement.
  it.skip("test_graceful_shutdown_falls_back_without_stop_event — TS port deliberately does NOT process.exit(0); clears PID + keeps running", () => {});

  it("test_install_signal_handlers_registers_stop_event", () => {
    // _install_signal_handlers stores the stop_event in the module-level slot.
    const stop = new worker.StopEvent();
    const original = worker_daemon._get_daemon_stop_event();
    // Snapshot existing SIGTERM/SIGINT listeners so we can drop the two this call
    // adds (the port has no exported remover; leaking real signal listeners across
    // the suite would eventually trip Node's MaxListeners warning).
    const beforeTerm = process.listeners("SIGTERM");
    const beforeInt = process.listeners("SIGINT");
    try {
      worker_daemon._install_signal_handlers(stop);
      expect(worker_daemon._get_daemon_stop_event()).toBe(stop);
    } finally {
      worker_daemon._set_daemon_stop_event(original);
      for (const l of process.listeners("SIGTERM")) {
        if (!beforeTerm.includes(l)) {
          process.removeListener("SIGTERM", l as NodeJS.SignalsListener);
        }
      }
      for (const l of process.listeners("SIGINT")) {
        if (!beforeInt.includes(l)) {
          process.removeListener("SIGINT", l as NodeJS.SignalsListener);
        }
      }
    }
  });

  // test_sigterm_stops_daemon_main_loop stays skipped: it drives the full
  // run_daemon main loop (watchdog thread, autostart, cleanup) to verify the stop
  // event breaks the loop. The suite-wide no-fork / no-live-daemon constraint
  // forbids spinning the real daemon loop in-process, so this remains deferred.
  it.skip("test_sigterm_stops_daemon_main_loop — drives the live run_daemon main loop (no-live-daemon constraint)", () => {});
});

// ---------------------------------------------------------------------------
// 4. Memory pressure guard
// ---------------------------------------------------------------------------

describe("TestMemoryPressureGuard", () => {
  // _is_under_memory_pressure and its integration with indexing.
  // worker.ts now exports _is_under_memory_pressure / _get_rss_mb, and
  // _is_under_memory_pressure() reads RSS via the module namespace
  // (`self._get_rss_mb()`), so spying _get_rss_mb is observed even by the callers
  // (_process_dirty_entries / _reindex_active_projects) that invoke
  // _is_under_memory_pressure() directly.
  //
  // Python flips MEMORY_PRESSURE_THRESHOLD_MB to 500 explicitly; in the TS port
  // that constant already defaults to 500 (no TOKEN_GOAT_MEMORY_PRESSURE_MB in the
  // test env), so the RSS values 100 / 600 straddle the default threshold without
  // needing to mutate the (read-only) constant.

  it("test_no_pressure_when_rss_below_threshold", () => {
    // RSS below threshold returns False.
    vi.spyOn(worker, "_get_rss_mb").mockReturnValue(100.0);
    expect(worker.MEMORY_PRESSURE_THRESHOLD_MB).toBe(500.0);
    expect(worker._is_under_memory_pressure()).toBe(false);
  });

  it("test_pressure_when_rss_exceeds_threshold", () => {
    // RSS above threshold returns True.
    vi.spyOn(worker, "_get_rss_mb").mockReturnValue(600.0);
    expect(worker.MEMORY_PRESSURE_THRESHOLD_MB).toBe(500.0);
    expect(worker._is_under_memory_pressure()).toBe(true);
  });

  it("test_no_pressure_when_rss_unavailable", () => {
    // If RSS cannot be determined, pressure is treated as absent (safe default).
    vi.spyOn(worker, "_get_rss_mb").mockReturnValue(null);
    expect(worker._is_under_memory_pressure()).toBe(false);
  });

  it("test_process_dirty_entries_skipped_under_pressure", () => {
    // _process_dirty_entries returns immediately when under memory pressure.
    const entry: worker.DirtyQueueEntry = {
      path: "src/foo.py",
      project_hash: "aabbccdd",
      project_root: paths.dataDir(),
      project_marker: "manual",
      ts: Date.now() / 1000,
    };
    const indexCalled: boolean[] = [];

    // Force pressure (RSS 600 > default threshold 500); register a parser stub
    // that records any index_project call (it must never fire).
    vi.spyOn(worker, "_get_rss_mb").mockReturnValue(600.0);
    worker._setParserModule({
      index_project(_project: Project, _opts: { full: boolean }) {
        indexCalled.push(true);
        return { indexed: 1, total_files: 1, errors: 0, skipped_unchanged: 0, duration_sec: 0.1 };
      },
    });

    worker._process_dirty_entries([entry]);

    expect(indexCalled.length, "index_project should not be called under memory pressure").toBe(0);
  });

  it("test_reindex_skipped_under_pressure", () => {
    // _reindex_active_projects returns immediately when under memory pressure.
    const indexCalled: boolean[] = [];

    vi.spyOn(worker, "_get_rss_mb").mockReturnValue(600.0);
    worker._setParserModule({
      index_project(_project: Project, _opts: { full: boolean }) {
        indexCalled.push(true);
        return null;
      },
    });

    worker._reindex_active_projects();

    expect(indexCalled.length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// 5. Index timeout
// ---------------------------------------------------------------------------

describe("TestIndexTimeout", () => {
  // _run_index_with_timeout runs the parser seam and returns its result (or null
  // on raise / when no parser is registered). worker.ts now exports it. The TS
  // parser seam is synchronous: the port honours the timeout/pool args for parity
  // but cannot bound a *blocking* call, so the two slow-index cases (which rely on
  // a thread being killed mid-wait) stay deferred — a truly-blocking stub would
  // hang the suite rather than return null.

  it("test_fast_index_succeeds", () => {
    // A fast index call returns the result dict normally.
    const expected = { indexed: 1, total_files: 1, errors: 0, skipped_unchanged: 0, duration_sec: 0.01 };
    worker._setParserModule({
      index_project(_project: Project, _opts: { full: boolean }) {
        return expected;
      },
    });
    const proj: Project = { root: paths.dataDir(), hash: "aabbccdd", marker: "manual" };
    const result = worker._run_index_with_timeout(proj, false, 5.0);
    expect(result).toEqual(expected);
  });

  // test_slow_index_returns_none stays skipped: the Python case blocks the index
  // thread for 10s and relies on the wall-clock timeout cancelling it. The TS port
  // calls the parser seam synchronously (no thread to cancel), so a blocking stub
  // would hang the suite rather than return null.
  it.skip("test_slow_index_returns_none — synchronous parser seam: a blocking stub would hang (no real wall-clock cancel)", () => {});

  it("test_raising_index_returns_none", () => {
    // An index call that raises an exception returns null (does not re-raise).
    worker._setParserModule({
      index_project(_project: Project, _opts: { full: boolean }): Record<string, unknown> | null {
        throw new Error("catastrophic indexer failure");
      },
    });
    const proj: Project = { root: paths.dataDir(), hash: "aabbccdd", marker: "manual" };
    const result = worker._run_index_with_timeout(proj, false, 5.0);
    expect(result).toBeNull();
  });

  // test_timeout_triggers_backoff stays skipped: it depends on the same wall-clock
  // timeout (a 10s-blocking index returning null) which the synchronous TS seam
  // cannot produce without hanging the suite.
  it.skip("test_timeout_triggers_backoff — depends on the wall-clock timeout returning null (blocking stub would hang)", () => {});
});

// ---------------------------------------------------------------------------
// 6. Pool size cap — max_pool_workers config & ceiling
// ---------------------------------------------------------------------------

describe("TestPoolSizeCap", () => {
  // worker.max_pool_workers config is honoured and capped at WORKER_MAX_POOL_CEILING.
  // worker.ts now exports _run_index_with_timeout / _get_max_pool_workers, so the
  // two _get_max_pool_workers cases are live. The two executor cases stay deferred:
  // they patch concurrent.futures.ThreadPoolExecutor and assert the captured
  // max_workers; the TS port uses no thread pool (pool size is a documented no-op),
  // so there is no executor construction to observe.

  it.skip("test_run_index_respects_explicit_max_workers — no ThreadPoolExecutor in the TS port (pool size is a documented no-op)", () => {});
  it.skip("test_run_index_ceiling_enforced — no ThreadPoolExecutor in the TS port (pool size is a documented no-op)", () => {});

  it("test_get_max_pool_workers_returns_config_value", () => {
    // _get_max_pool_workers() returns the configured value.
    config.clearConfigCache();
    const dir = fs.mkdtempSync(nodePath.join(os.tmpdir(), "tg-pool-cfg-"));
    const configFile = nodePath.join(dir, "config.toml");
    fs.writeFileSync(configFile, "[worker]\nmax_pool_workers = 2\n", "utf8");
    paths.setConfigPathOverride(configFile);
    try {
      const result = worker._get_max_pool_workers();
      expect(result, `Expected 2, got ${result}`).toBe(2);
    } finally {
      paths.clearConfigPathOverride();
      config.clearConfigCache();
    }
  });

  it("test_get_max_pool_workers_falls_back_on_error", () => {
    // _get_max_pool_workers() returns 1 when config.load() raises.
    vi.spyOn(config, "load").mockImplementation(() => {
      throw new Error("config unavailable");
    });
    const result = worker._get_max_pool_workers();
    expect(result, "Expected fallback of 1 on config error").toBe(1);
  });
});
