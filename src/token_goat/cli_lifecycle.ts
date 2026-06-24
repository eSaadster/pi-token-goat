/**
 * lifecycle command implementations — the TS port of cli.py's batch I
 * (4 of 5 commands): install, uninstall, worker, context-stats.
 *
 * `doctor` (cli.py:6126) lives in its own module `cli_doctor.ts` (it delegates
 * to `cli_doctor.doctor(...)`; cli_doctor.py is 2585 LOC — the single biggest
 * module, a mass of health-check orchestration over psutil/subprocess/db/paths/
 * project). It is registered alongside the lifecycle commands by
 * `cli.ts:_registerLifecycleCommands` (lazy `_cliDoctor()` import).
 *
 * Faithful 1:1 port of cli.py command bodies:
 *   - cmd_install      (cli.py:6181)
 *   - cmd_uninstall    (cli.py:6318)
 *   - cmd_worker       (cli.py:6362)
 *   - context_stats    (cli.py:6152) → thin delegator to cli_context_stats.run
 *
 * Output seam: Python `typer.echo` / `raise typer.Exit` route through
 * cli_common.ts (`_echo` / `CliExit`), identical to the other cli_ modules.
 *
 * ASYNC gotcha: `worker_daemon.run_daemon` is async in the TS port → `worker`
 * (the daemon branch) is `async` + awaits it. Everything else is sync.
 *
 * Spy-ability: install / worker_daemon / worker / paths fns the tests patch are
 * called via the `import * as` namespace.
 */
import * as fs from "node:fs";

import * as install_mod from "./install.js";
import * as paths from "./paths.js";
import * as worker from "./worker.js";
import * as worker_daemon from "./worker_daemon.js";
import * as cli_context_stats from "./cli_context_stats.js";
import { CliExit, _echo } from "./cli_common.js";

const _VALID_TARGETS = new Set([
  "claude",
  "codex",
  "gemini",
  "opencode",
  "openclaw",
  "pi",
  "all",
]);

// ---------------------------------------------------------------------------
// install (cli.py:6181)
// ---------------------------------------------------------------------------

/** One-time setup: scheduled tasks, settings.json, CLAUDE.md, skill, watchdog. */
export function cmd_install(args: {
  codex: boolean;
  opencode: boolean;
  openclaw: boolean;
  pi: boolean;
  target: string[] | null;
  dry_run: boolean;
  verify: boolean;
  check: boolean;
}): void {
  const { codex, opencode, openclaw, pi, dry_run, verify, check } = args;
  const target = args.target;

  if (check) {
    const info = install_mod.check_autostart();
    _echo(`Autostart: ${info["status"] ?? ""}`);
    if (info["command"]) {
      _echo(`Command: ${info["command"]}`);
    }
    if (info["registered_interp"]) {
      _echo(`Interpreter: ${info["registered_interp"]}`);
      const match = info["match"];
      if (match === "YES") {
        _echo("Match: YES (current interpreter matches)");
      } else if (match === "NO") {
        _echo(
          `Match: NO (registered: ${info["registered_interp"]}, ` +
            `current: ${info["current_interp"] ?? ""})`,
        );
      } else {
        _echo("Match: UNKNOWN (could not compare interpreters)");
      }
    } else {
      _echo(`Current interpreter: ${info["current_interp"] ?? ""}`);
    }
    return;
  }

  let targets: Set<string> | null = null;
  if (target && target.length > 0) {
    const unknown = target.filter((t) => !_VALID_TARGETS.has(t));
    if (unknown.length > 0) {
      _echo(
        `Unknown --target value(s): ${unknown.slice().sort().join(", ")}. ` +
          `Valid choices: ${Array.from(_VALID_TARGETS).sort().join(", ")}`,
        { err: true },
      );
      throw new CliExit(1);
    }
    targets = new Set(target);
  }

  if (dry_run) {
    const plan = install_mod.plan_install(codex, opencode, openclaw, pi, targets);
    _echo("token-goat install --dry-run (no changes made):");
    for (const row of plan) {
      _echo(`  [${row.action.padStart(17)}] ${row.component}: ${row.target}`);
      if (row.detail) _echo(`      ${row.detail}`);
    }
    _echo("");
    _echo("Re-run without --dry-run to apply.");
    return;
  }

  // Show current integration state before making changes.
  const status = install_mod.check_status();
  _echo("Current integration status:");
  for (const [integration, state] of Object.entries(status)) {
    const icon = state === "installed" ? "+" : "-";
    _echo(`  [${icon}] ${integration}: ${state}`);
  }
  _echo("");

  const result = install_mod.install_all(codex, opencode, openclaw, pi, targets);
  _echo("token-goat install:");
  for (const [step, detail] of Object.entries(result)) {
    _echo(`  ${step}: ${detail}`);
  }
  _echo("");

  const codecReport = install_mod.probe_image_codecs();
  if (!codecReport.ok) {
    _echo("!".repeat(72));
    _echo("WARNING — image codecs incomplete; WebP shrink will be degraded or broken.");
    _echo(`  detected: ${codecReport.summary}`);
    if (codecReport.missing.length > 0) {
      _echo(`  missing:  ${codecReport.missing.join(", ")}`);
    }
    _echo("");
    _echo("To fix (part of the install — do not skip):");
    for (const line of codecReport.hint.split(/\r\n|\r|\n/)) {
      if (line.length > 0) _echo(`  ${line}`);
    }
    _echo("");
    _echo("After fixing, re-run: token-goat doctor");
    _echo("!".repeat(72));
    _echo("");
  }
  if (verify) {
    _echo("Verifying install:");
    for (const row of install_mod.verify_install()) {
      const icon = row.action === "ok" ? "+" : row.action === "missing" ? "-" : "!";
      _echo(`  [${icon}] ${row.component}: ${row.detail}`);
    }
    _echo("");
  }
  _echo("All set. token-goat will be invisible from here on.");
  _echo("Run `token-goat doctor` anytime to check status.");
  _echo("Defender exclusion (optional, for max perf):");
  _echo('  Add-MpPreference -ExclusionPath "$env:LOCALAPPDATA\\dfk-helper\\token-goat"');
}

// ---------------------------------------------------------------------------
// uninstall (cli.py:6318)
// ---------------------------------------------------------------------------

/** Cleanly reverse install. */
export function cmd_uninstall(args: {
  purge: boolean;
  codex: boolean;
  gemini: boolean;
  opencode: boolean;
  openclaw: boolean;
  pi: boolean;
}): void {
  const { purge, codex, gemini, opencode, openclaw, pi } = args;
  const result = install_mod.uninstall_all(purge, codex, gemini, opencode, openclaw, pi);
  _echo("token-goat uninstall:");
  for (const [step, detail] of Object.entries(result)) {
    _echo(`  ${step}: ${detail}`);
  }
}

// ---------------------------------------------------------------------------
// worker (cli.py:6362)
// ---------------------------------------------------------------------------

/**
 * Internal: background worker daemon. Port of cli.py `cmd_worker`. ASYNC (the
 * daemon branch awaits `worker_daemon.run_daemon`). Under
 * `TOKEN_GOAT_NO_WORKER_SPAWN=1` the daemon branch exits without spawning.
 */
export async function cmd_worker(args: {
  daemon: boolean;
  status: boolean;
  check: boolean;
  kill_duplicate: boolean;
}): Promise<void> {
  const { daemon: _daemon, status, check, kill_duplicate } = args;
  void _daemon; // the presence of any non-flag arg means "run the daemon"

  if (kill_duplicate) {
    _echo(worker_daemon.kill_duplicate_daemon());
    return;
  }

  if (check) {
    const pidPath = paths.workerPidPath();
    if (!fs.existsSync(pidPath)) {
      _echo("Worker: not running (no pid file)");
      throw new CliExit(0);
    }
    let pid: number;
    let workerInterp: string | null;
    try {
      const pidText = fs.readFileSync(pidPath, "utf8");
      [pid, workerInterp] = worker._read_pid_info(pidText);
    } catch (e) {
      _echo(`Worker: pid file unreadable (${e})`);
      throw new CliExit(0);
    }

    const running = worker_daemon._pid_is_alive(pid);
    if (!running) {
      _echo(`Worker: stale pid file (pid ${pid} not alive)`);
      throw new CliExit(0);
    }

    _echo(`Worker: running (pid ${pid})`);
    if (workerInterp) {
      _echo(`Interpreter: ${workerInterp}`);
      const current = process.execPath;
      const norm = (p: string): string =>
        process.platform === "win32" ? p.replace(/\\/g, "/").toLowerCase() : p;
      if (norm(workerInterp) !== norm(current)) {
        _echo(
          `DUPLICATE DETECTED: worker interpreter (${workerInterp}) ` +
            `differs from current (${current})`,
        );
        throw new CliExit(1);
      } else {
        _echo("Match: YES (worker interpreter matches current)");
      }
    } else {
      _echo("Interpreter: unknown (legacy pid file format)");
    }
    throw new CliExit(0);
  }

  if (status) {
    const info = worker_daemon.query_worker_status() as Record<string, unknown>;
    const pidStr = info["pid"] !== null && info["pid"] !== undefined ? ` (pid ${info["pid"]})` : "";
    const state = info["running"] ? "running" : "stopped";
    _echo(`Worker: ${state}${pidStr}`);
    if (info["interpreter"]) _echo(`Interpreter: ${info["interpreter"]}`);
    if (info["started_at"] && info["running"]) {
      try {
        const started = new Date(String(info["started_at"]));
        const uptimeSecs = Math.max(0, Math.trunc((Date.now() - started.getTime()) / 1000));
        if (!Number.isNaN(started.getTime())) {
          const hours = Math.floor(uptimeSecs / 3600);
          const rem = uptimeSecs % 3600;
          const mins = Math.floor(rem / 60);
          const secs = rem % 60;
          const uptimeStr = hours ? `${hours}h ${mins}m ${secs}s` : `${mins}m ${secs}s`;
          _echo(`Uptime: ${uptimeStr}`);
        }
      } catch {
        // suppress
      }
    }
    _echo(`Pool size: ${info["pool_size"] ?? 4}`);
    if (info["autostart"] !== null && info["autostart"] !== undefined) {
      const activeStr =
        info["autostart_active"] === true
          ? "enabled"
          : info["autostart_active"] === false
            ? "disabled"
            : "unknown";
      _echo(`Autostart: ${info["autostart"]} (${activeStr})`);
    }
    if (info["last_log_line"]) _echo(`Last log: ${info["last_log_line"]}`);
    return;
  }

  if (_noWorkerSpawn()) {
    return;
  }

  await worker_daemon.run_daemon();
}

/** Whether TOKEN_GOAT_NO_WORKER_SPAWN is set to a truthy value. */
function _noWorkerSpawn(): boolean {
  const v = (process.env["TOKEN_GOAT_NO_WORKER_SPAWN"] ?? "").trim().toLowerCase();
  return v === "1" || v === "true" || v === "yes" || v === "on";
}

// ---------------------------------------------------------------------------
// context-stats (cli.py:6152) — thin delegator to cli_context_stats.run
// ---------------------------------------------------------------------------

/** Show startup context footprint and optionally prune stale MEMORY.md entries. */
export function context_stats(args: {
  fix: boolean;
  json_output: boolean;
  project: string | null;
}): void {
  cli_context_stats.run({
    fix: args.fix,
    json_out: args.json_output,
    project: args.project,
  });
}
