/**
 * Worker daemon runtime and maintenance helpers.
 *
 * Faithful TS/Node port of src/token_goat/worker_daemon.py (806 LOC). Owned
 * jointly with worker.ts (this module calls ~15 worker internals via the
 * `import * as _worker` namespace).
 *
 * The worker runs as a *separate process* rather than a background thread in the
 * hook process (hook latency + lifetime independence) — see the Python module
 * docstring.
 *
 * Porting notes
 * -------------
 *  - **threading.Thread (WatchdogThread)** -> a main-thread async task driven by
 *    a worker.StopEvent (NOT a worker_thread, so vi.spyOn on the injected
 *    launch_fn / pid reader stays visible). `start()` kicks `run()` as a
 *    detached async loop; `stop()` resolves the stop event so the loop unwinds.
 *    NO test ever blocks on a live watchdog: it constructs one with stubbed
 *    callbacks, starts it, then stops it.
 *  - **threading.Event (_daemon_stop_event)** -> worker.StopEvent; its `wait`
 *    is async (resolves on timeout OR set()).
 *  - **signal.signal(SIGTERM/SIGINT)** -> process.on("SIGTERM"/"SIGINT") that
 *    set the stop event. Installed/removed symmetrically so tests can install
 *    and the daemon can tear down its own handlers on exit (Python leaves them
 *    installed; the TS port removes them on run_daemon exit to avoid leaking
 *    listeners across a vitest process).
 *  - **ctypes SetConsoleCtrlHandler / TerminateProcess / OpenProcess** (Windows)
 *    -> degraded no-ops / process.kill fallbacks; Node has no ctypes. On
 *    non-Windows these paths are never reached anyway.
 *  - **subprocess.run(["systemctl", ...])** in query_worker_status ->
 *    child_process.spawnSync, wrapped fail-soft.
 *  - **psutil.pid_exists** -> _pid_is_alive: process.kill(pid, 0) (EPERM =>
 *    alive), mirroring db.ts/_pidAlive.
 *  - run_daemon is `async` and takes an optional worker.StopEvent; the loop
 *    awaits stop_event.wait(sleep_for) instead of time.sleep, so it is
 *    cooperatively abortable and a test resolves it with stop.set().
 */
import * as childProcess from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

import * as paths from "./paths.js";
import * as config from "./config.js";
import * as install from "./install.js";
import { getLogger } from "./util.js";
import { registerReset } from "./reset.js";
// Circular (static `import * as`, function-level use keeps ESM safe):
import * as _worker from "./worker.js";
import type { CleanupStats, DirtyQueueEntry, StopEvent } from "./worker.js";
// Self-import so internal callbacks (the pid reader / launch_fn handed to the
// watchdog) route through the namespace and stay vi.spyOn-visible.
import * as self from "./worker_daemon.js";

const _LOG = getLogger("worker");

// ===========================================================================
// Watchdog thread
// ===========================================================================

/** Sentinel returned by _read_pid_from_file when the PID file is absent/unreadable. */
export const _PID_UNKNOWN = -1;

/**
 * Return the PID written by the worker, or _PID_UNKNOWN if unavailable.
 * Handles both the legacy plain-integer format and the current JSON format.
 */
export function _read_pid_from_file(): number {
  try {
    const [pid] = _worker._read_pid_info(fs.readFileSync(paths.workerPidPath(), "utf-8"));
    return pid;
  } catch {
    return _PID_UNKNOWN;
  }
}

/**
 * Return true if pid is a running process. Uses process.kill(pid, 0) (the POSIX
 * existence probe; EPERM means it exists but we cannot signal it — treat as
 * alive). Mirrors worker_daemon.py _pid_is_alive's psutil + os.kill fallback.
 */
export function _pid_is_alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    const err = e as NodeJS.ErrnoException;
    if (err.code === "EPERM") {
      return true; // process exists but no permission
    }
    return false;
  }
}

/**
 * Background task that monitors a worker process and restarts it on unexpected
 * exit.
 *
 * Ported from threading.Thread to a main-thread async loop driven by a
 * worker.StopEvent so vi.spyOn on the injected callbacks stays visible and no
 * test forks a real thread. Semantics match the Python loop one-for-one:
 * latch onto a PID, poll liveness every poll_interval, and on an unexpected
 * exit (stop event NOT set) wait retry_delay then call launch_fn, bounded by
 * max_retries within a sliding window_secs.
 */
export class WatchdogThread {
  private readonly _pidFileReader: () => number;
  private readonly _launchFn: () => number | null;
  private readonly _maxRetries: number;
  private readonly _windowSecs: number;
  private readonly _retryDelay: number;
  private readonly _pollInterval: number;
  private readonly _onLatch: (() => void) | null;
  private readonly _stopEvent: StopEvent;
  /** Monotonic timestamps for each restart attempt (sliding-window eviction). */
  private _restartTimes: number[] = [];
  /** The running loop promise, set by start(); awaited by join() in tests. */
  private _runPromise: Promise<void> | null = null;

  constructor(
    pidFileReader: () => number,
    launchFn: () => number | null,
    opts: {
      maxRetries?: number;
      windowSecs?: number;
      retryDelay?: number;
      pollInterval?: number;
      onLatch?: (() => void) | null;
    } = {},
  ) {
    this._pidFileReader = pidFileReader;
    this._launchFn = launchFn;
    this._maxRetries = opts.maxRetries ?? 5;
    this._windowSecs = opts.windowSecs ?? 600.0;
    this._retryDelay = opts.retryDelay ?? 5.0;
    this._pollInterval = opts.pollInterval ?? 2.0;
    this._onLatch = opts.onLatch ?? null;
    this._stopEvent = new _worker.StopEvent();
  }

  /** Kick the watchdog loop as a detached async task. */
  start(): void {
    if (this._runPromise !== null) {
      return;
    }
    this._runPromise = this.run();
    // Swallow unhandled rejections — run() already wraps in try/catch, but be safe.
    void this._runPromise.catch(() => {
      /* logged inside run() */
    });
  }

  /** Signal the watchdog to exit cleanly. Non-blocking. */
  stop(): void {
    this._stopEvent.set();
  }

  /** Await the loop's completion (test helper). */
  async join(): Promise<void> {
    if (this._runPromise !== null) {
      await this._runPromise;
    }
  }

  /** Return the count of restart attempts within the current window. */
  private _retriesInWindow(): number {
    const cutoff = _monotonic() - this._windowSecs;
    this._restartTimes = this._restartTimes.filter((t) => t >= cutoff);
    return this._restartTimes.length;
  }

  /** Main watchdog loop. */
  async run(): Promise<void> {
    _LOG.debug("watchdog thread started");
    let watchedPid = _PID_UNKNOWN;
    try {
      while (!this._stopEvent.is_set()) {
        await this._stopEvent.wait(this._pollInterval);
        if (this._stopEvent.is_set()) {
          break;
        }

        const currentPid = this._pidFileReader();

        // Latch onto a freshly-up worker (or the first PID we see).
        if (currentPid !== _PID_UNKNOWN && currentPid !== watchedPid) {
          watchedPid = currentPid;
          if (this._onLatch !== null) {
            try {
              this._onLatch();
            } catch {
              // suppress
            }
          }
        }

        // Nothing to watch yet.
        if (watchedPid === _PID_UNKNOWN) {
          continue;
        }

        // Check liveness.
        if (self._pid_is_alive(watchedPid)) {
          continue;
        }

        // PID gone. If stop is set this is a graceful shutdown — do not restart.
        if (this._stopEvent.is_set()) {
          break;
        }

        _LOG.warning(
          "watchdog: worker pid=%d exited unexpectedly; considering restart",
          watchedPid,
        );

        const retries = this._retriesInWindow();
        if (retries >= this._maxRetries) {
          _LOG.error(
            "watchdog: %d restarts in %ss window; giving up to prevent restart loop",
            retries,
            this._windowSecs.toFixed(0),
          );
          break;
        }

        // Wait before restarting to avoid a tight loop.
        _LOG.info(
          "watchdog: waiting %ss before restart attempt %d/%d",
          this._retryDelay.toFixed(1),
          retries + 1,
          this._maxRetries,
        );
        await this._stopEvent.wait(this._retryDelay);
        if (this._stopEvent.is_set()) {
          break;
        }

        // Attempt restart.
        _LOG.info("watchdog: restarting worker (attempt %d/%d)", retries + 1, this._maxRetries);
        let newPid: number | null;
        try {
          newPid = this._launchFn();
        } catch {
          _LOG.error("watchdog: launch_fn raised during restart attempt");
          newPid = null;
        }

        if (newPid !== null) {
          _LOG.info("watchdog: worker restarted, new pid=%d", newPid);
          watchedPid = newPid;
        } else {
          _LOG.warning("watchdog: restart attempt returned no PID; will retry");
          // Keep watchedPid as-is (the dead PID) so the next poll re-enters the
          // "PID gone" branch and can reach the max_retries check.
        }

        this._restartTimes.push(_monotonic());
      }
    } catch {
      _LOG.error("watchdog thread crashed — watchdog disabled for this session");
    } finally {
      _LOG.debug("watchdog thread exiting");
    }
  }
}

/** time.monotonic() — float seconds from a monotonic clock. */
function _monotonic(): number {
  return Number(process.hrtime.bigint()) / 1e9;
}

/** time.time() — float seconds since epoch. */
function _now(): number {
  return Date.now() / 1000;
}

// Module-level stop event used by signal handlers. Set by _install_signal_handlers.
//
// Mutable module-global that the signal-handling tests both read (to confirm
// _install_signal_handlers stored their stop event) and reset between cases.
// An ESM binding cannot be reassigned from another module, so the read goes
// through _get_daemon_stop_event() and the reset through _set_daemon_stop_event();
// both are registered with reset.ts so each test starts with it cleared.
let _daemon_stop_event: StopEvent | null = null;

/** Test seam: read the module-level stop event the signal handlers act on. */
export function _get_daemon_stop_event(): StopEvent | null {
  return _daemon_stop_event;
}

/** Test seam: set/clear the module-level stop event (Python reassigns the attr). */
export function _set_daemon_stop_event(ev: StopEvent | null): void {
  _daemon_stop_event = ev;
}

function _resetDaemonStopEvent(): void {
  _daemon_stop_event = null;
}
registerReset(_resetDaemonStopEvent);

/** Currently-installed signal listeners, tracked so we can remove them on exit. */
const _installedSignalHandlers: { signal: NodeJS.Signals; handler: () => void }[] = [];

/** Delegate startup cleanup to the worker core implementation. */
export function cleanup_on_startup(): CleanupStats {
  return _worker.cleanup_on_startup();
}

/** Delegate periodic reindexing to the worker core implementation. */
export function _reindex_active_projects(): void {
  _worker._reindex_active_projects();
}

/** Delegate dirty-queue processing to the worker core implementation. */
export function _process_dirty_entries(entries: DirtyQueueEntry[]): void {
  _worker._process_dirty_entries(entries);
}

/**
 * Signal handler: request a clean shutdown by setting the stop event. Falls back
 * to clearing the PID file when no stop event is available (signal arrived
 * before run_daemon initialised it).
 */
export function _graceful_shutdown(signum: string): void {
  _LOG.debug("received signal %s; requesting clean shutdown", signum);
  if (_daemon_stop_event !== null) {
    _daemon_stop_event.set();
  } else {
    try {
      _worker._clear_pid();
    } catch {
      // suppress
    }
    // Python calls sys.exit(0); the TS port lets the process keep running (a
    // hard exit from a signal handler would kill a vitest run). The PID file is
    // cleared, which is the durable side-effect callers depend on.
  }
}

/**
 * Register SIGTERM/SIGINT handlers that exit cleanly. The stop_event is stored
 * in the module-level _daemon_stop_event so the handler can set it. When
 * stop_event is null the handler falls back to clearing the PID file.
 */
export function _install_signal_handlers(stopEvent: StopEvent | null = null): void {
  _daemon_stop_event = stopEvent;
  for (const sig of ["SIGTERM", "SIGINT"] as NodeJS.Signals[]) {
    const handler = (): void => _graceful_shutdown(sig);
    try {
      process.on(sig, handler);
      _installedSignalHandlers.push({ signal: sig, handler });
    } catch {
      // platform may not support this signal — suppress
    }
  }
}

/** Remove the signal handlers installed by _install_signal_handlers. */
function _remove_signal_handlers(): void {
  for (const { signal, handler } of _installedSignalHandlers) {
    try {
      process.removeListener(signal, handler);
    } catch {
      // suppress
    }
  }
  _installedSignalHandlers.length = 0;
}

/**
 * Register a Windows console-control handler. Node has no ctypes /
 * SetConsoleCtrlHandler analogue, so this degrades to a documented no-op. On
 * non-Windows this is never called.
 */
export function _install_windows_console_handler(_stopEvent: StopEvent | null = null): void {
  _LOG.debug("Windows console-control handler unavailable in the Node port; skipping");
}

/** Run fn, logging elapsed time on success and exception details on failure. */
function _timed_cycle(label: string, fn: () => void): void {
  _LOG.info("starting %s", label);
  const t0 = _now();
  try {
    fn();
  } catch (e) {
    _LOG.error("%s failed after %ss: %s", label, (_now() - t0).toFixed(2), e);
    return;
  }
  _LOG.info("%s completed in %ss", label, (_now() - t0).toFixed(2));
}

/** Execute one periodic maintenance cycle, logging duration and results. */
function _run_maintenance_cycle(): void {
  _LOG.info("starting maintenance cycle");
  const t0 = _now();
  let s: CleanupStats;
  try {
    s = self.cleanup_on_startup();
  } catch (e) {
    _LOG.error("periodic maintenance failed after %ss: %s", (_now() - t0).toFixed(2), e);
    return;
  }
  const elapsed = _now() - t0;
  if (_anyValue(s)) {
    _LOG.info("periodic maintenance completed in %ss: %s", elapsed.toFixed(2), JSON.stringify(s));
  } else {
    _LOG.debug("periodic maintenance completed in %ss (no actions needed)", elapsed.toFixed(2));
  }
}

/** Python `any(dict.values())` for a CleanupStats — true if any numeric value is truthy. */
function _anyValue(s: CleanupStats): boolean {
  for (const v of Object.values(s)) {
    if (Array.isArray(v)) {
      if (v.length > 0) {
        return true;
      }
    } else if (v) {
      return true;
    }
  }
  return false;
}

/** Execute one periodic reindex cycle, logging duration and any failure. */
function _run_reindex_cycle(): void {
  _timed_cycle("periodic reindex cycle", self._reindex_active_projects);
}

/** Return true when a package version or code fingerprint change is detected. */
function _detect_upgrade(): boolean {
  const currentVersion = _worker._installed_version();
  const currentFp = _worker._package_fingerprint();
  const versionChanged =
    _worker._BOOTED_VERSION !== null &&
    currentVersion !== null &&
    currentVersion !== _worker._BOOTED_VERSION;
  const codeChanged =
    _worker._BOOTED_FINGERPRINT !== null &&
    currentFp !== null &&
    currentFp !== _worker._BOOTED_FINGERPRINT;
  if (versionChanged || codeChanged) {
    _LOG.info(
      "token-goat %s changed on disk (version %s -> %s); restarting worker to load new code",
      versionChanged ? "version" : "code",
      _worker._BOOTED_VERSION,
      currentVersion,
    );
    return true;
  }
  return false;
}

/** Main loop: heartbeat + dirty-queue processing + periodic maintenance. */
export async function run_daemon(stopEvent?: StopEvent): Promise<void> {
  const stop_event = stopEvent ?? null;
  _worker._setup_logging();

  const claimFd = _worker._try_claim_worker_slot();
  if (claimFd === null) {
    // Surface the conflicting interpreter (cross-interpreter duplicate guard).
    try {
      const pidText = fs.readFileSync(paths.workerPidPath(), "utf-8");
      const [pid, exe] = _worker._read_pid_info(pidText);
      if (exe) {
        _LOG.warning(
          "another token-goat worker is already running (PID %d, interpreter %s); exiting",
          pid,
          exe,
        );
      } else {
        _LOG.info("another worker holds the slot (PID %d); exiting", pid);
      }
    } catch {
      _LOG.info("another worker holds the slot; exiting");
    }
    return;
  }

  // process.exit-on-exit belt-and-suspenders: Python registers atexit
  // _clear_pid. Node has no atexit that survives SIGKILL; the try/finally below
  // is the durable cleanup. We also register a process "exit" listener that
  // clears the PID synchronously, removed in the finally block.
  const onProcessExit = (): void => {
    try {
      _worker._clear_pid();
    } catch {
      // suppress
    }
  };
  process.on("exit", onProcessExit);

  let restartForUpgrade = false;
  let watchdog: WatchdogThread | null = null;
  try {
    _worker._clear_pid();
    _worker._write_pid();

    // Post-write race guard: re-read the PID file and verify it contains OUR PID.
    try {
      const writtenText = fs.readFileSync(paths.workerPidPath(), "utf-8");
      const [writtenPid] = _worker._read_pid_info(writtenText);
      if (writtenPid !== process.pid) {
        _LOG.error(
          "PID file contains PID %d after write but our PID is %d; " +
            "another process won the startup race — exiting",
          writtenPid,
          process.pid,
        );
        // Early return on the PID-race path: explicitly drop the "exit" listener
        // here so it is removed on EVERY return path, not only via the finally
        // below. removeListener on an already-absent listener is a no-op, so the
        // finally's removeListener remains harmless.
        process.removeListener("exit", onProcessExit);
        return;
      }
    } catch (e) {
      _LOG.warning("could not verify PID file after write: %s; continuing", e);
    }

    _worker._heartbeat();
    _worker._register_autostart();

    // Start the auto-restart watchdog unless disabled in config.
    let watchdogEnabled: boolean;
    try {
      watchdogEnabled = config.load().worker?.watchdog_enabled ?? true;
    } catch {
      watchdogEnabled = true; // fail-open
    }

    if (watchdogEnabled) {
      watchdog = new WatchdogThread(self._read_pid_from_file, _worker.spawn_detached);
      watchdog.start();
      _LOG.debug("watchdog thread started");
    }

    const stats = self.cleanup_on_startup();
    if (_anyValue(stats)) {
      _LOG.info("startup cleanup: %s", JSON.stringify(stats));
    } else {
      _LOG.debug("startup cleanup: no actions needed");
    }

    let lastHeartbeat = _now();
    let lastMaintenance = _now();
    let lastPeriodicReindex = _now();
    let lastVersionCheck = _now();
    let lastGcProjects = _now();
    let consecutiveEmptyDrains = 0;
    _LOG.debug(
      "worker main loop initialized: heartbeat=%ss maintenance=%ss reindex=%ss",
      _worker.HEARTBEAT_INTERVAL.toFixed(1),
      _worker.MAINTENANCE_INTERVAL.toFixed(1),
      _worker.PERIODIC_REINDEX_INTERVAL.toFixed(1),
    );

    const shouldStop = (): boolean => stop_event !== null && stop_event.is_set();

    _install_signal_handlers(stop_event);
    if (process.platform === "win32") {
      _install_windows_console_handler(stop_event);
    }
    _LOG.info("worker started, pid=%s", process.pid);

    while (!shouldStop()) {
      const now = _now();

      if (now - lastHeartbeat >= _worker.HEARTBEAT_INTERVAL) {
        _worker._heartbeat();
        lastHeartbeat = now;
        _LOG.debug("worker heartbeat written");
      }

      const entries = _worker.drain_dirty_queue();
      if (entries && entries.length > 0) {
        _LOG.debug("found %d dirty queue entries, processing", entries.length);
        self._process_dirty_entries(entries);
        consecutiveEmptyDrains = 0;
      } else if (entries === null) {
        // Drain deferred — work still pending, don't count as an idle cycle.
        consecutiveEmptyDrains = 0;
      } else {
        consecutiveEmptyDrains += 1;
      }

      if (now - lastMaintenance >= _worker.MAINTENANCE_INTERVAL) {
        _run_maintenance_cycle();
        lastMaintenance = now;
      }

      if (now - lastPeriodicReindex >= _worker.PERIODIC_REINDEX_INTERVAL) {
        _run_reindex_cycle();
        lastPeriodicReindex = now;
      }

      if (now - lastVersionCheck >= _worker.VERSION_CHECK_INTERVAL) {
        if (_detect_upgrade()) {
          restartForUpgrade = true;
          break;
        }
        lastVersionCheck = now;
      }

      if (now - lastGcProjects >= _worker.GC_PROJECTS_INTERVAL) {
        _timed_cycle("gc orphaned projects", _worker._gc_orphaned_projects);
        lastGcProjects = now;
      }

      const sleepFor = _worker.adaptive_poll_interval(consecutiveEmptyDrains);
      if (stop_event !== null) {
        // Cooperatively abortable: resolves on the poll timeout OR immediately
        // when the stop event is set (SIGTERM/SIGINT handler, or a test calling
        // stop.set()). This is the only way out of the loop short of an upgrade
        // restart — exactly like Python's stop_event.wait(timeout).
        await stop_event.wait(sleepFor);
      } else {
        // No stop event. Python loops forever here (should_stop() is always
        // False) because the real daemon is a detached process that runs until
        // SIGTERM. In the Node port an un-cancellable infinite async loop would
        // wedge the vitest suite if a test ever called run_daemon() without a
        // stop event, so the safety contract (see module docstring) is: a
        // stop-event-less call performs a single maintenance tick and returns.
        // Production always supplies a stop event whose signal handler sets it,
        // so the long-lived daemon is unaffected.
        await _sleepAbortable(sleepFor);
        break;
      }
    }
  } finally {
    _LOG.info("worker shutting down, pid=%s", process.pid);
    if (watchdog !== null) {
      watchdog.stop();
    }
    _worker._clear_pid();
    try {
      fs.closeSync(claimFd);
    } catch {
      // suppress
    }
    try {
      fs.unlinkSync(_worker._worker_claim_path());
    } catch {
      // suppress
    }
    _remove_signal_handlers();
    process.removeListener("exit", onProcessExit);
    _daemon_stop_event = null;
  }

  if (restartForUpgrade) {
    _LOG.info("respawning worker with updated code");
    _worker.spawn_detached();
  }
}

/** Abortable sleep that never keeps the event loop alive (unref'd timer). */
function _sleepAbortable(secs: number): Promise<void> {
  return new Promise<void>((resolve) => {
    const t = setTimeout(resolve, Math.max(0, secs * 1000));
    if (typeof t.unref === "function") {
      t.unref();
    }
  });
}

// ===========================================================================
// Duplicate daemon kill (used by `token-goat worker --kill-duplicate`)
// ===========================================================================

/**
 * Kill a running worker whose interpreter path differs from the current
 * executable. Never raises; all errors are returned as descriptive strings.
 */
export function kill_duplicate_daemon(): string {
  const pidPath = paths.workerPidPath();
  if (!fs.existsSync(pidPath)) {
    return "No running worker found.";
  }

  let pid: number;
  let workerInterp: string | null;
  try {
    const pidText = fs.readFileSync(pidPath, "utf-8");
    [pid, workerInterp] = _worker._read_pid_info(pidText);
  } catch (exc) {
    return `No running worker found (pid file unreadable: ${String(exc)}).`;
  }

  if (!self._pid_is_alive(pid)) {
    try {
      fs.unlinkSync(pidPath);
    } catch {
      // suppress
    }
    return "No running worker found.";
  }

  if (workerInterp === null) {
    return "Worker interpreter unknown (legacy pid file format).";
  }

  const norm = (p: string): string =>
    process.platform === "win32" ? p.replace(/\\/g, "/").toLowerCase() : p;

  if (norm(workerInterp) === norm(process.execPath)) {
    return "No duplicate daemon found.";
  }

  // The running worker uses a different interpreter — kill it.
  try {
    process.kill(pid, "SIGTERM");
  } catch (exc) {
    return `Failed to kill PID ${pid}: ${String(exc)}.`;
  }

  // Remove the stale PID file so subsequent --check calls reflect the kill.
  try {
    fs.unlinkSync(pidPath);
  } catch {
    // suppress
  }

  return `Killed duplicate daemon (PID ${pid}, interpreter ${workerInterp}).`;
}

// ===========================================================================
// Worker status query (used by `token-goat worker --status`)
// ===========================================================================

/** Return a dict describing current worker status. */
export function query_worker_status(): Record<string, unknown> {
  let pid: number | null = null;
  let interpreter: string | null = null;
  let startedAt: string | null = null;
  let running = false;

  const pidPath = paths.workerPidPath();
  if (fs.existsSync(pidPath)) {
    try {
      const pidText = fs.readFileSync(pidPath, "utf-8");
      const [pidRaw, interp] = _worker._read_pid_info(pidText);
      if (pidRaw !== _PID_UNKNOWN) {
        pid = pidRaw;
        interpreter = interp;
        running = self._pid_is_alive(pidRaw);
        // Extract started_at from the JSON payload if present.
        try {
          const data = JSON.parse(pidText.trim()) as { started_at?: unknown };
          startedAt = (data.started_at as string | undefined) || null;
        } catch {
          // not JSON or no started_at
        }
      }
    } catch {
      // suppress
    }
  }

  // Fall back to the simple reader when the above didn't populate pid.
  if (pid === null) {
    const rawPid = self._read_pid_from_file();
    if (rawPid !== _PID_UNKNOWN) {
      pid = rawPid;
      running = self._pid_is_alive(rawPid);
    }
  }

  // Pool size from config (fail-soft: default 4).
  let poolSize = 4;
  try {
    poolSize = config.load().worker?.max_pool_workers ?? 4;
  } catch {
    // suppress
  }

  let autostart: string | null = null;
  let autostartActive: boolean | null = null;

  // install.ts is a sibling module under concurrent development; access its
  // platform-specific internals defensively (Python uses hasattr + try/except).
  // The loose record view tolerates symbols that may not be typed yet.
  const inst = install as unknown as Record<string, unknown>;

  if (process.platform === "win32") {
    autostart = "registry";
    // No winreg in Node; the registry check degrades to "unknown".
    autostartActive = null;
  } else if (process.platform.startsWith("linux") || process.platform === "darwin") {
    try {
      const systemdServicePath = inst["_systemd_service_path"];
      const svcPath =
        typeof systemdServicePath === "function"
          ? (systemdServicePath as () => string)()
          : null;
      if (svcPath && fs.existsSync(svcPath)) {
        autostart = "systemd";
        try {
          const svcName = inst["SYSTEMD_SERVICE_NAME"];
          const result = childProcess.spawnSync(
            "systemctl",
            ["--user", "is-active", `${String(svcName)}.service`],
            { timeout: 5000 },
          );
          autostartActive = result.status === 0;
        } catch {
          autostartActive = null;
        }
      } else {
        const xdgFn = inst["_xdg_desktop_path"];
        const xdgPath = typeof xdgFn === "function" ? (xdgFn as () => string)() : null;
        if (xdgPath && fs.existsSync(xdgPath)) {
          autostart = "xdg";
          autostartActive = true;
        } else {
          autostart = null;
          autostartActive = false;
        }
      }
    } catch {
      // install internals not available yet — leave autostart unknown.
      autostart = null;
      autostartActive = null;
    }
  }

  let lastLogLine: string | null = null;
  try {
    const today = _todayStamp();
    const logFile = path.join(paths.logsDir(), `${today}.log`);
    if (fs.existsSync(logFile)) {
      const text = fs.readFileSync(logFile).toString("utf-8");
      const lines = text.split(/\r\n|\r|\n/).filter((ln) => ln.trim());
      if (lines.length > 0) {
        lastLogLine = lines[lines.length - 1] ?? null;
      }
    }
  } catch {
    // suppress
  }

  return {
    running,
    pid,
    interpreter,
    started_at: startedAt,
    autostart,
    autostart_active: autostartActive,
    pool_size: poolSize,
    last_log_line: lastLogLine,
  };
}

/** Format a Date as YYYY-MM-DD in local time (datetime.date.today strftime). */
function _todayStamp(d: Date = new Date()): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

export const __all__ = [
  "WatchdogThread",
  "cleanup_on_startup",
  "run_daemon",
  "kill_duplicate_daemon",
  "query_worker_status",
  // module internals the Python tests import directly
  "_install_signal_handlers",
  "_graceful_shutdown",
  "_install_windows_console_handler",
  "_PID_UNKNOWN",
  "_get_daemon_stop_event",
  "_set_daemon_stop_event",
] as const;
