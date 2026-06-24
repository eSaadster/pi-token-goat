/**
 * Subprocess wrapper invoked by ``token-goat compress`` to run user commands.
 *
 * TypeScript port of src/token_goat/bash_runner.py. The hook layer rewrites a
 * Bash tool call from::
 *
 *     pytest -v tests/
 *
 * to::
 *
 *     token-goat compress --filter pytest --cmd 'pytest -v tests/'
 *
 * When the harness executes the rewritten command, control lands here via
 * :func:`run`. It runs the original command through the system shell, captures
 * both stdout and stderr (byte-capped), applies the requested filter, prints the
 * compressed output, records the byte/token savings to the stats DB, and returns
 * the *original* exit code so shell chaining (``cmd && next``) still works.
 *
 * ---------------------------------------------------------------------------
 * Parity notes (Python -> TS)
 * ---------------------------------------------------------------------------
 *  - Python uses ``subprocess.Popen`` + background draining threads + a
 *    ``wait(timeout=)`` + a process-tree kill. Node's spawn is event-based, so
 *    the idiomatic equivalent makes :func:`run` (and :func:`_wrap_and_compress`)
 *    ASYNC. That is the single structural divergence. The threads become
 *    ``proc.stdout/stderr.on("data", …)`` drain callbacks; ``proc.wait(timeout)``
 *    becomes a Promise that resolves on ``"close"`` raced against a
 *    ``setTimeout`` that kills the tree.
 *  - ``_passthrough`` uses ``childProcess.spawnSync`` with ``stdio: "inherit"``
 *    so output streams straight through (matching ``subprocess.run`` with no
 *    capture), staying SYNC since ``run`` awaits nothing there.
 *  - The POSIX process-group kill is reproduced via ``detached: true`` on spawn
 *    (== ``start_new_session=True``) + ``process.kill(-pid, SIGTERM/SIGKILL)``.
 *  - Signal-killed exit codes map to the NEGATIVE signal number (Python's
 *    ``proc.returncode`` convention); the surrounding shell/CLI layer applies the
 *    ``128 + |code|`` translation.
 *
 * verbatimModuleSyntax is on -> type-only imports use `import type`.
 */
import * as childProcess from "node:child_process";
import * as os from "node:os";

import * as bash_compress from "./bash_compress.js";
import * as db from "./db.js";
import * as config from "./config.js";
import { _shlexSplit } from "./bash_compress/framework.js";
import { getLogger } from "./util.js";
import { sanitize_log_str } from "./hooks_common.js";

const _LOG = getLogger("bash_runner");

export const __all__ = ["run", "run_compressed", "DEFAULT_TIMEOUT_SECONDS", "MAX_CAPTURE_BYTES"];

/**
 * Minimum bytes saved to bother writing a stat row. Filters that squeeze 2–3
 * bytes (e.g. whitespace-only collapses) generate noise rows with "0.0%
 * savings" in `token-goat stats`; skip them below this threshold.
 */
export const MIN_RECORD_STAT_BYTES = 32;

/**
 * Per-stream byte cap. Beyond this we stop appending to the in-memory buffer and
 * discard the rest, so a runaway log can never OOM the wrapper. 32 MiB per
 * stream covers practically any real command (10K lines × 3 KB/line).
 */
export const MAX_CAPTURE_BYTES = 32 * 1024 * 1024;

/**
 * Default wall-clock timeout for the wrapped subprocess, in seconds. Long enough
 * to cover npm install on a fresh node_modules (~120 s on a slow disk) while
 * bounded enough to surface a hang. Configurable via the ``--timeout`` flag.
 */
export const DEFAULT_TIMEOUT_SECONDS = 600;

// _READ_CHUNK (Python's 64 KiB non-blocking pipe read size) has no analogue in
// the event-based model — chunk sizes are decided by Node's stream layer — so it
// is intentionally dropped.

/**
 * Decode captured bytes as UTF-8 (replace errors); append overflow marker.
 *
 * Python: ``buf.decode("utf-8", errors="replace")`` — Buffer.toString("utf8")
 * substitutes U+FFFD for invalid sequences, matching errors="replace". The
 * overflow byte count is rendered with thousands separators (Python ``{:,}`` ->
 * Number.toLocaleString("en-US")).
 */
function _decode_capture(buf: Buffer, overflow: number): string {
  let decoded = buf.toString("utf8");
  if (overflow > 0) {
    decoded +=
      `\n[token-goat: capture capped at ${Math.floor(MAX_CAPTURE_BYTES / (1024 * 1024))} MiB;` +
      ` ${overflow.toLocaleString("en-US")} bytes dropped]`;
  }
  return decoded;
}

/**
 * Spawn the wrapped subprocess in shell mode with pipes for stdout/stderr.
 *
 * A new process group is created on POSIX (``detached: true`` ==
 * ``start_new_session=True``) so we can kill the entire pipeline if a timeout
 * fires; ``proc.kill()`` by itself only signals the top-level shell, leaving
 * children running. stdin is /dev/null ("ignore").
 */
function _spawn(
  command: string,
  { cwd, env }: { cwd?: string | null; env?: Record<string, string> | null },
): childProcess.ChildProcess {
  return childProcess.spawn(command, {
    shell: true,
    stdio: ["ignore", "pipe", "pipe"],
    cwd: cwd ?? undefined,
    env: env ?? undefined,
    // POSIX: new process group so we can tree-kill on timeout. On Windows there
    // is no equivalent group-kill, so we leave the default and rely on
    // proc.kill() in _kill_process_tree.
    detached: process.platform !== "win32",
  });
}

/**
 * Terminate the subprocess and all of its descendants.
 *
 * On POSIX, sends SIGTERM to the process group then SIGKILL after a grace
 * period. On Windows, calls proc.kill() (TerminateProcess); there is no
 * tree-kill API, so the best we can do is the top-level shell.
 */
function _kill_process_tree(proc: childProcess.ChildProcess): void {
  // Already dead? (Python: proc.poll() is not None.)
  if (proc.exitCode !== null || proc.signalCode !== null) {
    return;
  }
  if (process.platform !== "win32") {
    _posix_kill_tree(proc);
  } else {
    try {
      proc.kill();
    } catch (exc) {
      _LOG.debug("kill failed: %s", exc);
    }
  }
}

/**
 * SIGTERM then SIGKILL the subprocess's process group on POSIX.
 *
 * Mirrors Python's ``os.killpg(os.getpgid(pid), …)``. With ``detached: true`` the
 * child is its own process-group leader whose PGID == its PID, so a negative-PID
 * signal targets the whole group (the shell + every descendant). The 5 s grace
 * SIGKILL follow-up is scheduled with an unref'd timer so it never keeps the
 * event loop (or vitest) alive on its own. Every kill is wrapped to swallow
 * ESRCH (ProcessLookupError) / EPERM (PermissionError).
 */
function _posix_kill_tree(proc: childProcess.ChildProcess): void {
  const pid = proc.pid;
  if (pid === undefined) {
    return;
  }
  try {
    process.kill(-pid, "SIGTERM");
  } catch {
    // ProcessLookupError (ESRCH) / PermissionError (EPERM) -> nothing to kill.
    return;
  }
  // Grace period then SIGKILL the group, best-effort. Python loops for up to 5 s
  // polling proc.poll(); the event-based port schedules a one-shot SIGKILL after
  // the same window. unref() so the timer never blocks process/runner exit.
  setTimeout(() => {
    if (proc.exitCode !== null || proc.signalCode !== null) {
      return;
    }
    try {
      process.kill(-pid, "SIGKILL");
    } catch {
      // already gone
    }
  }, 5000).unref();
}

/**
 * Run *command* through the system shell, compress its output, return exit code.
 *
 * This is the primary entry point invoked by the ``token-goat compress`` CLI
 * subcommand. It returns the wrapped subprocess's exit code so the surrounding
 * shell sees the same failure / success signal it would have seen without the
 * wrapper. 124 on wrapper-induced timeout (matching ``timeout(1)``). Negative
 * values map to ``128 + |code|`` for shell parity (applied by the caller layer).
 *
 * ASYNC (the one structural divergence from Python — Node's spawn is
 * event-based).
 */
export async function run(
  command: string,
  opts: {
    filter_name?: string | null;
    timeout?: number;
    cwd?: string | null;
    env?: Record<string, string> | null;
    write_stdout?: (s: string) => void;
    write_stderr?: (s: string) => void;
    compression_profile?: string | null;
    max_tokens?: number;
  } = {},
): Promise<number> {
  const timeout = opts.timeout ?? DEFAULT_TIMEOUT_SECONDS;
  const cwd = opts.cwd ?? null;
  const env = opts.env ?? null;
  const write_stdout =
    opts.write_stdout ??
    ((s: string): void => {
      process.stdout.write(s);
    });
  const write_stderr =
    opts.write_stderr ??
    ((s: string): void => {
      process.stderr.write(s);
    });
  const filter_name = opts.filter_name ?? null;
  const compression_profile = opts.compression_profile ?? null;
  const max_tokens = opts.max_tokens ?? 0;

  const filter_ = _resolve_filter(command, filter_name);
  if (filter_ === null) {
    // No filter applies, exec the command transparently. We could skip the
    // subprocess for zero overhead, but that loses the timeout protection; the
    // wrapper subprocess cost is ~5 ms.
    return _passthrough(command, { timeout, cwd, env });
  }

  // Resolve effective compression profile: explicit argument wins; otherwise
  // read from config (ignoring "auto" since harness detection is unavailable in
  // the wrapper subprocess — the hook already resolved it before spawning).
  let effective_profile: string | null = compression_profile;
  if (effective_profile === null) {
    try {
      const _cfg_profile = config.load().compression?.profile ?? "balanced";
      effective_profile = _cfg_profile !== "auto" ? _cfg_profile : "balanced";
    } catch {
      effective_profile = "balanced";
    }
  }

  return _wrap_and_compress(command, filter_, {
    timeout,
    cwd,
    env,
    write_stdout,
    write_stderr,
    compression_profile: effective_profile,
    max_tokens,
  });
}

// Alias for clarity at the public API surface.
export const run_compressed = run;

/**
 * Look up the filter by name first, falling back to argv-based dispatch.
 */
function _resolve_filter(command: string, filter_name: string | null): bash_compress.Filter | null {
  if (filter_name) {
    const named = bash_compress.filter_by_name(filter_name);
    if (named !== null) {
      return named;
    }
    _LOG.debug("filter_name=%s not registered; falling back to auto-detect", filter_name);
  }
  let argv: string[];
  try {
    argv = _shlexSplit(command, { posix: true });
  } catch {
    return null;
  }
  return bash_compress.select_filter(argv);
}

/**
 * Run *command* with no compression, streaming stdout/stderr unchanged.
 *
 * Used when no filter applies (so the wrapper would be pure overhead). Still runs
 * through a subprocess so the timeout takes effect. Uses spawnSync with
 * stdio:"inherit" so output goes straight to the parent's streams — the
 * equivalent of Python's ``subprocess.run`` without capture.
 */
function _passthrough(
  command: string,
  { timeout, cwd, env }: { timeout: number; cwd: string | null; env: Record<string, string> | null },
): number {
  const res = childProcess.spawnSync(command, {
    shell: true,
    stdio: "inherit",
    cwd: cwd ?? undefined,
    env: env ?? undefined,
    timeout: timeout * 1000,
  });
  if (res.error) {
    const code = (res.error as NodeJS.ErrnoException).code;
    if (code === "ETIMEDOUT") {
      return 124; // subprocess.TimeoutExpired
    }
    if (code === "ENOENT") {
      return 127; // FileNotFoundError
    }
  }
  if (res.status !== null) {
    return res.status;
  }
  if (res.signal) {
    return 128 + (os.constants.signals[res.signal] ?? 15);
  }
  return 0;
}

/**
 * Run *command* with output capture, apply *filter_*, print result. ASYNC.
 *
 * Captures up to :data:`MAX_CAPTURE_BYTES` per stream via "data" callbacks
 * (Python uses background threads — the event model is equivalent). The timeout
 * fires promptly because we race the ``"close"`` event against a ``setTimeout``
 * that kills the process tree, rather than blocking on EOF.
 */
async function _wrap_and_compress(
  command: string,
  filter_: bash_compress.Filter,
  {
    timeout,
    cwd,
    env,
    write_stdout,
    write_stderr,
    compression_profile = "balanced",
    max_tokens = 0,
  }: {
    timeout: number;
    cwd: string | null;
    env: Record<string, string> | null;
    write_stdout: (s: string) => void;
    write_stderr: (s: string) => void;
    compression_profile?: string;
    max_tokens?: number;
  },
): Promise<number> {
  const start = Date.now();
  let timed_out = false;
  const proc = _spawn(command, { cwd, env });

  const stdoutChunks: Buffer[] = [];
  let stdoutLen = 0;
  let stdoutOverflow = 0;
  const stderrChunks: Buffer[] = [];
  let stderrLen = 0;
  let stderrOverflow = 0;

  // Mirrors _drain_stream_to_buffer's cap+overflow logic: append up to
  // MAX_CAPTURE_BYTES; track dropped bytes in the matching overflow counter.
  const drain = (chunk: Buffer, isOut: boolean): void => {
    if (isOut) {
      const remaining = MAX_CAPTURE_BYTES - stdoutLen;
      if (remaining <= 0) {
        stdoutOverflow += chunk.length;
        return;
      }
      if (chunk.length > remaining) {
        stdoutChunks.push(chunk.subarray(0, remaining));
        stdoutLen += remaining;
        stdoutOverflow += chunk.length - remaining;
      } else {
        stdoutChunks.push(chunk);
        stdoutLen += chunk.length;
      }
    } else {
      const remaining = MAX_CAPTURE_BYTES - stderrLen;
      if (remaining <= 0) {
        stderrOverflow += chunk.length;
        return;
      }
      if (chunk.length > remaining) {
        stderrChunks.push(chunk.subarray(0, remaining));
        stderrLen += remaining;
        stderrOverflow += chunk.length - remaining;
      } else {
        stderrChunks.push(chunk);
        stderrLen += chunk.length;
      }
    }
  };

  proc.stdout?.on("data", (c: Buffer) => {
    drain(c, true);
  });
  proc.stderr?.on("data", (c: Buffer) => {
    drain(c, false);
  });

  // Wait for "close" (all stdio flushed + exited), raced against a timeout that
  // kills the process tree.
  const exitInfo = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) {
        return;
      }
      timed_out = true;
      _kill_process_tree(proc);
      // Do NOT resolve here — let the eventual "close" (after the kill flushes
      // the pipes) settle the promise so captured output is complete.
    }, timeout * 1000);
    proc.on("close", (code, signal) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      resolve({ code, signal });
    });
    proc.on("error", () => {
      // spawn failure (ENOENT etc.) — treat as command-not-found.
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      resolve({ code: 127, signal: null });
    });
  });

  // Python: proc.returncode if not timed_out else 124. A signal-killed process
  // surfaces as the NEGATIVE signal number (Popen.returncode convention).
  let exit_code: number;
  if (timed_out) {
    exit_code = 124;
  } else if (exitInfo.code !== null) {
    exit_code = exitInfo.code;
  } else {
    exit_code = -(os.constants.signals[exitInfo.signal as NodeJS.Signals] ?? 15);
  }

  let stdout_text = _decode_capture(Buffer.concat(stdoutChunks), stdoutOverflow);
  let stderr_text = _decode_capture(Buffer.concat(stderrChunks), stderrOverflow);
  if (timed_out) {
    stderr_text = stderr_text ? stderr_text + "\n" : "";
    stderr_text += `[token-goat: command exceeded ${timeout}s timeout and was killed]`;
  }

  let argv: string[];
  try {
    argv = _shlexSplit(command, { posix: true });
  } catch {
    argv = [command];
  }

  const result = bash_compress.compress_output(filter_, stdout_text, stderr_text, exit_code, argv, {
    compression_profile,
  });
  // Apply pressure-scaled cap to the text portion BEFORE appending the
  // compression summary marker so the marker survives truncation and stays
  // visible to the agent.
  let text = result.text;
  if (max_tokens > 0) {
    text = bash_compress.cap_tokens(text, max_tokens);
  }
  // result.text is exactly the prefix of with_marker(); slicing by UTF-16 units
  // yields the marker suffix ("" when bytes_saved <= 0), faithful to Python's
  // ``result.with_marker()[len(result.text):]``.
  const marker = result.with_marker().slice(result.text.length);
  const body = text + marker;
  write_stdout(body + (body.endsWith("\n") ? "" : "\n"));
  void write_stderr; // wrapper diagnostics sink; unused on the success path.

  const elapsed_ms = Date.now() - start;
  _record_savings(result, command, elapsed_ms);
  return exit_code;
}

/**
 * Write the bash_compress savings stat to the global stats DB.
 *
 * Best-effort: a DB error must never block the wrapper from returning the exit
 * code. All exceptions are caught and logged at debug level.
 */
export function _record_savings(result: bash_compress.CompressedOutput, command: string, elapsed_ms: number): void {
  if (result.bytes_saved < MIN_RECORD_STAT_BYTES) {
    return;
  }
  try {
    // Use a bounded, sanitized form of the command for the detail field.
    const detail = sanitize_log_str(command, 256);
    db.recordStat(undefined, `bash_compress:${result.filter_name}`, {
      bytesSaved: result.bytes_saved,
      tokensSaved: result.tokens_saved,
      detail,
    });
    _LOG.info(
      "bash_compress %s saved %d bytes (%d tokens) in %.0f ms",
      result.filter_name,
      result.bytes_saved,
      result.tokens_saved,
      elapsed_ms,
    );
  } catch (exc) {
    _LOG.debug("record_savings failed: %s", exc);
  }
}
