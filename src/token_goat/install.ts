/**
 * install + uninstall: scheduled tasks, settings.json, CLAUDE.md, skill, permission allowlist.
 *
 * Faithful TS port of src/token_goat/install.py. Heavily OS-coupled: autostart
 * registration differs per platform (macOS launchd .plist, Linux systemd /
 * XDG .desktop / cron, Windows HKCU Run + schtasks), and the file contents
 * written (plist XML, .desktop INI, systemd unit, settings.json / config.toml
 * patches) are byte-parity-checked against the Python original.
 *
 * Parity / porting notes:
 *  - `sys.platform == "win32" | "darwin" | <else=linux>` → `process.platform`
 *    (Node reports "win32" / "darwin" / "linux"), keyed exactly as the Python
 *    branches key off sys.platform.
 *  - `sys.executable` (the interpreter running now) → `process.execPath` (the
 *    Node binary). This is what check_autostart() reports as current_interp and
 *    what the dedup warnings compare against, mirroring Python's use of the
 *    interpreter path.
 *  - `subprocess.run(...)` → a single injectable seam `_runSubprocess` wrapping
 *    `child_process.spawnSync`. Tests stub the seam via setSubprocessRunner so
 *    no real schtasks/launchctl/systemctl/crontab process is ever forked.
 *  - `winreg` is Windows-only and has no Node equivalent; every winreg path is
 *    guarded to a no-op / null result off Windows (the test platform), which
 *    preserves the byte-parity logic of the surrounding code. On Windows the
 *    `_winregBackend` seam (also injectable) would be wired up by the real
 *    Windows entry point.
 *  - TOML read/write via `smol-toml` (`parse`/`stringify`) — the equivalents of
 *    Python's `tomllib.loads` / `tomli_w.dumps`.
 *  - `worker.ensure_running()` is the ONLY symbol install pulls from worker.ts
 *    (a sibling module written this same phase). Imported statically as
 *    `import * as worker from "./worker.js"` and called only function-level
 *    inside install_all, keeping the circular import ESM-safe.
 *  - Python `str.splitlines()` drops a trailing empty element; the TS helper
 *    `_splitlines` mirrors that. JSON output uses 2-space indent to match
 *    json.dumps(indent=2).
 *  - Markers like "worker.service" / "<label>.plist" / "token-goat-worker.desktop"
 *    are FILENAMES, not calls.
 *  - Public API keeps snake_case names to match the Python package exports.
 */

import * as childProcess from "node:child_process";
import * as fs from "node:fs";
import * as nodePath from "node:path";
import * as os from "node:os";

import sharp from "sharp";
import { stringify as tomlStringify, parse as tomlParse, TomlError } from "smol-toml";

import type { HookEvent } from "./types.js";
import * as paths from "./paths.js";
import { getLogger } from "./util.js";
import * as hook_registry from "./hook_registry.js";
import * as skill_cache from "./skill_cache.js";
import * as bridges from "./bridges.js";
import * as worker from "./worker.js";
import { registerReset } from "./reset.js";

// ---------------------------------------------------------------------------
// Hook-entry types (mirror the Python TypedDicts)
// ---------------------------------------------------------------------------

/**
 * A single hook command definition in Claude Code / Codex settings.
 *
 * Represents one entry in the `hooks` list of a matcher block:
 *   {"type": "command", "command": "token-goat hook pre-read", "timeout": 5000}
 */
export interface _HookCommandEntry {
  type: string;
  command: string;
  timeout: number;
}

/**
 * A single matcher block: one event-pattern -> list of hook commands.
 *
 *   {"matcher": "Read", "hooks": [{"type": "command", ...}]}
 */
export interface _HookMatcherEntry {
  matcher: string;
  hooks: _HookCommandEntry[];
}

// Markers for idempotent Codex AGENTS.md patching
export const CODEX_AGENTS_BEGIN = "<!-- token-goat-codex-begin -->";
export const CODEX_AGENTS_END = "<!-- token-goat-codex-end -->";

const _LOG = getLogger("install");

// Markers for idempotent CLAUDE.md patching
export const CLAUDE_MD_BEGIN = "<!-- token-goat-begin -->";
export const CLAUDE_MD_END = "<!-- token-goat-end -->";

// Legacy markers from the pre-rename "tokenwise" era. These blocks describe the
// old binary name and produce incorrect routing instructions; the patch path
// strips them on install so a single install run leaves only the modern block.
export const LEGACY_CLAUDE_MD_BEGIN = "<!-- tokenwise-begin -->";
export const LEGACY_CLAUDE_MD_END = "<!-- tokenwise-end -->";
export const LEGACY_CODEX_AGENTS_BEGIN = "<!-- tokenwise-codex-begin -->";
export const LEGACY_CODEX_AGENTS_END = "<!-- tokenwise-codex-end -->";

// Scheduled task names (Windows)
export const TASK_WORKER = "token-goat-worker";
export const TASK_UPDATE = "token-goat-update";

// Linux autostart constants
export const SYSTEMD_SERVICE_NAME = "token-goat-worker";
export const CRON_JOB_MARKER = "# token-goat-autoupdate";

// macOS autostart constants
export const LAUNCHD_PLIST_NAME = "com.dfkhelper.token-goat-worker";

// ---------------------------------------------------------------------------
// Platform helpers (mirror sys.platform branching)
// ---------------------------------------------------------------------------

const _PLATFORM = process.platform;

/** Python `sys.platform == "win32"`. */
function _isWin32(): boolean {
  return _PLATFORM === "win32";
}

/** Python `sys.platform == "darwin"`. */
function _isDarwin(): boolean {
  return _PLATFORM === "darwin";
}

/**
 * Python `sys.executable` — the interpreter running now. In the TS port the
 * interpreter is the Node binary (process.execPath); there is no pythonw
 * analogue in a JS-only install. This is the value compared against the
 * registered autostart interpreter and surfaced as current_interp.
 */
function _sysExecutable(): string {
  return process.execPath;
}

/** Python `Path.home()`. */
function _home(): string {
  return os.homedir();
}

/**
 * Python `str.splitlines()`. Splits on universal newlines and, critically,
 * DROPS the trailing empty element (so "a\n".splitlines() == ["a"], not
 * ["a", ""]). Used wherever the Python source iterates `content.splitlines()`.
 */
function _splitlines(s: string): string[] {
  if (s === "") {
    return [];
  }
  // Split on \r\n, \r, or \n. Then drop a single trailing empty element if the
  // string ended with a line terminator (Python semantics).
  const parts = s.split(/\r\n|\r|\n/);
  if (parts.length > 0 && parts[parts.length - 1] === "") {
    parts.pop();
  }
  return parts;
}

// ---------------------------------------------------------------------------
// shutil.which port
// ---------------------------------------------------------------------------

/**
 * Port of `shutil.which(name)`: locate an executable named *name* on PATH.
 *
 * Returns the absolute candidate path when found, otherwise null. On Windows,
 * PATHEXT-style suffixes are appended when *name* has no extension (mirroring
 * shutil.which's behaviour of resolving "token-goat" -> "token-goat.exe").
 */
function which(name: string): string | null {
  // If name has a directory separator, treat it as a path and only check it.
  const hasDirComponent = name.includes("/") || name.includes("\\");

  const buildCandidates = (base: string): string[] => {
    if (!_isWin32()) {
      return [base];
    }
    // On Windows, if the name already has an extension matching PATHEXT, use it
    // as-is; otherwise append each PATHEXT suffix (and also try the bare name).
    const pathext = (process.env["PATHEXT"] ?? ".COM;.EXE;.BAT;.CMD")
      .split(";")
      .filter((e) => e.length > 0);
    const lowerName = base.toLowerCase();
    const hasExt = pathext.some((ext) => lowerName.endsWith(ext.toLowerCase()));
    if (hasExt) {
      return [base];
    }
    return [base, ...pathext.map((ext) => base + ext)];
  };

  const isExecutable = (candidate: string): boolean => {
    try {
      // X_OK is meaningless on Windows (everything is "executable"); fall back
      // to a plain existence check there.
      const mode = _isWin32() ? fs.constants.F_OK : fs.constants.X_OK;
      fs.accessSync(candidate, mode);
      // Must be a file, not a directory.
      const st = fs.statSync(candidate);
      return st.isFile();
    } catch {
      return false;
    }
  };

  if (hasDirComponent) {
    for (const candidate of buildCandidates(name)) {
      if (isExecutable(candidate)) {
        return candidate;
      }
    }
    return null;
  }

  const pathEnv = process.env["PATH"] ?? "";
  const dirs = pathEnv.split(nodePath.delimiter).filter((d) => d.length > 0);
  // shutil.which on Windows implicitly checks the current directory first.
  if (_isWin32()) {
    dirs.unshift(".");
  }
  for (const dir of dirs) {
    for (const candidate of buildCandidates(nodePath.join(dir, name))) {
      if (isExecutable(candidate)) {
        return candidate;
      }
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Subprocess seam (injectable for tests)
// ---------------------------------------------------------------------------

/** Result of a subprocess invocation (parallels subprocess.run's fields). */
export interface SubprocessResult {
  /** Process exit code. -1 signals "could not run" (FileNotFoundError/timeout). */
  returncode: number;
  /** Captured stdout (decoded). */
  stdout: string;
  /** Captured stderr (decoded). */
  stderr: string;
  /** True when the underlying spawn raised (binary missing) or timed out. */
  failed: boolean;
  /** Error message when `failed` is true. */
  error: string;
}

/** Options passed to the subprocess runner seam. */
export interface SubprocessOptions {
  /** Timeout in milliseconds (Python passes seconds; converted at call sites). */
  timeoutMs?: number;
  /** Text written to the child's stdin (Python `input=`). */
  input?: string;
}

export type SubprocessRunner = (
  cmd: string,
  args: string[],
  opts: SubprocessOptions,
) => SubprocessResult;

/**
 * Default subprocess runner backed by `child_process.spawnSync`.
 *
 * NEVER forks a detached/long-lived process: every command here (schtasks,
 * launchctl, systemctl, crontab) is short-lived and capture-mode. Tests
 * replace this seam entirely so the real binaries are never invoked.
 */
const _defaultSubprocessRunner: SubprocessRunner = (cmd, args, opts) => {
  try {
    const res = childProcess.spawnSync(cmd, args, {
      encoding: "utf-8",
      timeout: opts.timeoutMs,
      input: opts.input,
      windowsHide: true,
    });
    if (res.error) {
      // ENOENT (binary missing) or ETIMEDOUT — Python's FileNotFoundError /
      // TimeoutExpired branches.
      return {
        returncode: -1,
        stdout: res.stdout ?? "",
        stderr: res.stderr ?? "",
        failed: true,
        error: String((res.error as Error).message ?? res.error),
      };
    }
    return {
      returncode: res.status ?? -1,
      stdout: res.stdout ?? "",
      stderr: res.stderr ?? "",
      failed: false,
      error: "",
    };
  } catch (e) {
    return {
      returncode: -1,
      stdout: "",
      stderr: "",
      failed: true,
      error: String((e as Error).message ?? e),
    };
  }
};

let _subprocessRunner: SubprocessRunner = _defaultSubprocessRunner;

/** Test seam: replace the subprocess runner (e.g. to stub schtasks/launchctl). */
export function setSubprocessRunner(runner: SubprocessRunner | null): void {
  _subprocessRunner = runner ?? _defaultSubprocessRunner;
}

function _runSubprocess(cmd: string, args: string[], opts: SubprocessOptions = {}): SubprocessResult {
  return _subprocessRunner(cmd, args, opts);
}

registerReset(() => {
  _subprocessRunner = _defaultSubprocessRunner;
  _winregBackend = null;
});

// ---------------------------------------------------------------------------
// winreg seam (Windows-only; injectable for tests)
// ---------------------------------------------------------------------------
//
// Node has no built-in registry access and winreg is Windows-only in Python.
// Off Windows (the test platform) every winreg path returns null / no-ops,
// exactly as the Python code would behave when `import winreg` raised
// ImportError. The seam lets a Windows entry point (or a test) supply a backend
// without changing the byte-parity logic in the surrounding functions.

/** Minimal HKCU\...\Run registry backend used by the Windows autostart paths. */
export interface WinregBackend {
  /** Read a value under HKCU\Run; null when the value is absent. */
  readRunValue(valueName: string): string | null;
  /** Write/replace a REG_SZ value under HKCU\Run. */
  setRunValue(valueName: string, value: string): void;
  /** Delete a value under HKCU\Run; raises {code:"ENOENT"} when absent. */
  deleteRunValue(valueName: string): void;
}

let _winregBackend: WinregBackend | null = null;

/** Test seam: install a fake winreg backend (Windows autostart paths). */
export function setWinregBackend(backend: WinregBackend | null): void {
  _winregBackend = backend;
}

function _winreg(): WinregBackend | null {
  return _winregBackend;
}

// ---------------------------------------------------------------------------
// Path accessors
// ---------------------------------------------------------------------------

/** Return ~/.claude/ */
export function claude_dir(): string {
  return nodePath.join(_home(), ".claude");
}

/** Return the path to ~/.claude/settings.json where hooks and permissions are configured. */
export function claude_settings_path(): string {
  return nodePath.join(claude_dir(), "settings.json");
}

/** Return the path to ~/.claude/CLAUDE.md where project memory and instructions live. */
export function claude_md_path(): string {
  return nodePath.join(claude_dir(), "CLAUDE.md");
}

/** Return the directory where the token-goat skill is installed (Claude Code plugins). */
export function skill_dir(): string {
  return nodePath.join(claude_dir(), "skills", "token-goat");
}

/** Return the path to the token-goat executable. Falls back to 'token-goat' (PATH-resolved). */
export function token_goat_binary(): string {
  const binary = which("token-goat");
  if (binary) {
    return binary;
  }
  return "token-goat";
}

/** Return bin directories that currently host token-goat launchers. */
function _launcher_bin_dirs(): Set<string> {
  const dirs = new Set<string>();
  for (const binaryName of ["token-goat", "token-goat-hook", "token-goat-worker"]) {
    const binary = which(binaryName);
    if (!binary) {
      continue;
    }
    try {
      dirs.add(nodePath.dirname(fs.realpathSync(binary)));
    } catch {
      dirs.add(nodePath.dirname(binary));
    }
  }
  return dirs;
}

/** Remove legacy tokenwise launchers that live beside token-goat launchers. */
function _remove_legacy_launchers(): string[] {
  const launcherDirs = _launcher_bin_dirs();
  if (launcherDirs.size === 0) {
    return [];
  }

  const removed: string[] = [];
  for (const binaryName of ["tokenwise", "tokenwise-hook", "tokenwise-worker"]) {
    const legacy = which(binaryName);
    if (!legacy) {
      continue;
    }

    let legacyDir: string;
    try {
      legacyDir = nodePath.dirname(fs.realpathSync(legacy));
    } catch {
      legacyDir = nodePath.dirname(legacy);
    }

    if (!launcherDirs.has(legacyDir)) {
      continue;
    }

    try {
      fs.unlinkSync(legacy);
      removed.push(legacy);
      _LOG.info("removed legacy launcher: %s", legacy);
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (code === "ENOENT") {
        continue;
      }
      _LOG.warning("failed to remove legacy launcher %s: %s", legacy, e);
    }
  }

  if (removed.length > 0) {
    _LOG.info("legacy launchers removed: %d (%s)", removed.length, removed.join(", "));
  }
  return removed;
}

/**
 * Return *name* from PATH if found, otherwise fall back to token_goat_binary().
 *
 * Used for the windowless GUI-subsystem variants (token-goat-hook,
 * token-goat-worker) which share the same fall-back logic.
 */
function _resolve_binary(name: string): string {
  const binary = which(name);
  return binary ? binary : token_goat_binary();
}

/**
 * Path to the windowless (GUI-subsystem) entry for hooks.
 * Falls back to token-goat if the windowless variant isn't installed.
 */
export function token_goat_hook_binary(): string {
  return _resolve_binary("token-goat-hook");
}

/** Windowless entry for the background worker. Falls back to token-goat. */
export function token_goat_worker_binary(): string {
  return _resolve_binary("token-goat-worker");
}

// ---------------------------------------------------------------------------
// Small result-formatting helpers
// ---------------------------------------------------------------------------

/**
 * Format a (bool, str) task result as "ok — detail" or "FAIL — detail".
 *
 * Note: Python slices `detail[:max_detail]` by code points; in practice the
 * details are ASCII paths/messages, but we slice by code points to match.
 */
function _ok_fail(ok: boolean, detail: string, maxDetail = 200): string {
  const prefix = ok ? "ok" : "FAIL";
  const truncated = [...detail].slice(0, maxDetail).join("");
  return `${prefix} — ${truncated}`;
}

/**
 * Run *fn* and record "ok — <return value>" or "FAIL — <exc>" in result[key].
 *
 * Eliminates the repeated try/except pattern used for optional
 * harness-integration steps in install_all (codex, opencode, openclaw patches).
 */
function _run_step(result: Record<string, string>, key: string, fn: () => unknown): void {
  try {
    const detail = fn();
    result[key] = `ok — ${String(detail)}`;
    _LOG.info("install step ok: %s — %s", key, String(detail).slice(0, 200));
  } catch (e) {
    result[key] = `FAIL — ${(e as Error).message ?? String(e)}`;
    _LOG.warning("install step failed: %s — %s", key, e);
  }
}

// ---------------------------------------------------------------------------
// Scheduled Tasks (Windows)
// ---------------------------------------------------------------------------

const _HKCU_RUN_PATH = String.raw`Software\Microsoft\Windows\CurrentVersion\Run`;

/** Wrap schtasks.exe subprocess call. */
export function _run_schtasks(args: string[]): [number, string] {
  const result = _runSubprocess("schtasks.exe", args, { timeoutMs: 30000 });
  if (result.failed) {
    return [-1, result.error];
  }
  return [result.returncode, (result.stdout || "") + (result.stderr || "")];
}

/** Check if a Windows scheduled task with the given name exists. */
export function task_exists(name: string): boolean {
  const [code] = _run_schtasks(["/Query", "/TN", name]);
  return code === 0;
}

/**
 * Extract the interpreter path from an autostart command string.
 *
 * Handles the node-native `node <entry> worker --daemon` form (and the legacy
 * `pythonw.exe -m token_goat.cli ...` form). The interpreter is always the first
 * token (quoted or unquoted). Returns null when extraction fails.
 */
export function _extract_interpreter_from_command(cmd: string): string | null {
  const stripped = cmd.trim();
  if (!stripped) {
    return null;
  }
  // Handle a leading quoted path: "C:/path/pythonw.exe" -m ...
  if (stripped.startsWith('"')) {
    const end = stripped.indexOf('"', 1);
    if (end !== -1) {
      return stripped.slice(1, end);
    }
    return null;
  }
  // Unquoted: take first whitespace-delimited token.
  const tokens = stripped.split(/\s+/).filter((t) => t.length > 0);
  return tokens.length > 0 ? tokens[0]! : null;
}

/**
 * Return the current HKCU Run value for token-goat-worker, or null if absent.
 *
 * Read-only. Returns the raw command string exactly as stored in the registry.
 * Returns null when the key/value does not exist, on read error, or off Windows.
 */
export function _read_win_autostart_command(): string | null {
  if (!_isWin32()) {
    return null;
  }
  const reg = _winreg();
  if (!reg) {
    return null;
  }
  try {
    return reg.readRunValue(TASK_WORKER);
  } catch {
    return null;
  }
}

/**
 * Return the ExecStart (systemd) or Exec (XDG) line from the autostart file, or null.
 *
 * Read-only. Returns the raw exec string from whichever autostart mechanism is
 * present (systemd user service first, XDG autostart fallback).
 */
export function _read_linux_autostart_command(): string | null {
  if (_isWin32()) {
    return null;
  }
  const svc = _systemd_service_path();
  if (fs.existsSync(svc)) {
    try {
      const content = fs.readFileSync(svc, "utf-8");
      for (const line of _splitlines(content)) {
        const strippedLine = line.trim();
        if (strippedLine.startsWith("ExecStart=")) {
          return strippedLine.slice("ExecStart=".length).trim();
        }
      }
    } catch {
      // pass
    }
    return null;
  }
  const desktop = _xdg_autostart_path();
  if (fs.existsSync(desktop)) {
    try {
      const content = fs.readFileSync(desktop, "utf-8");
      for (const line of _splitlines(content)) {
        const strippedLine = line.trim();
        if (strippedLine.startsWith("Exec=")) {
          return strippedLine.slice("Exec=".length).trim();
        }
      }
    } catch {
      // pass
    }
  }
  return null;
}

/**
 * Return the first ProgramArguments entry (the interpreter) from the LaunchAgent plist.
 *
 * Read-only. Returns the joined `<string>` entries in ProgramArguments, or null
 * when the plist is absent or unreadable.
 */
function _read_mac_autostart_command(): string | null {
  if (_isWin32()) {
    return null;
  }
  const plist = _launchd_plist_path();
  if (!fs.existsSync(plist)) {
    return null;
  }
  try {
    const content = fs.readFileSync(plist, "utf-8");
    // Extract all <string> entries following <key>ProgramArguments</key><array>.
    const m = /<key>ProgramArguments<\/key>\s*<array>([\s\S]*?)<\/array>/.exec(content);
    if (!m) {
      return null;
    }
    const strings: string[] = [];
    const re = /<string>([\s\S]*?)<\/string>/g;
    let sm: RegExpExecArray | null;
    while ((sm = re.exec(m[1]!)) !== null) {
      strings.push(sm[1]!);
    }
    if (strings.length > 0) {
      // The first element is the interpreter executable; reconstruct full command.
      return strings.join(" ");
    }
  } catch {
    // pass
  }
  return null;
}

/**
 * Return a dict describing the current autostart registration (read-only).
 *
 * Keys: status, command, registered_interp, current_interp, match.
 * No side effects — safe to call at any time.
 */
export function check_autostart(): Record<string, string | null> {
  const currentInterp = _sysExecutable();

  let cmd: string | null;
  if (_isWin32()) {
    cmd = _read_win_autostart_command();
  } else if (_isDarwin()) {
    cmd = _read_mac_autostart_command();
  } else {
    cmd = _read_linux_autostart_command();
  }

  const status = cmd !== null ? "registered" : "not registered";
  const registeredInterp = cmd ? _extract_interpreter_from_command(cmd) : null;

  let match: string;
  if (registeredInterp === null) {
    match = "UNKNOWN";
  } else {
    // Normalise path separators and case (Windows paths are case-insensitive).
    const norm = (p: string): string =>
      _isWin32() ? p.replace(/\\/g, "/").toLowerCase() : p;
    match = norm(registeredInterp) === norm(currentInterp) ? "YES" : "NO";
  }

  return {
    status,
    command: cmd,
    registered_interp: registeredInterp,
    current_interp: currentInterp,
    match,
  };
}

/**
 * Register the token-goat worker to run at user logon via the HKCU Run key.
 *
 * HKCU\...\Run is the standard user-scope at-logon mechanism and never needs
 * elevation. If an existing entry points to a different interpreter, it is
 * replaced and a WARNING is logged.
 */
export function install_worker_task(): [boolean, string] {
  const cmd = paths.pythonRunnerCommand("worker", "--daemon");

  if (!_isWin32()) {
    return [true, "non-Windows: skipped"];
  }

  // Dedup check: warn when replacing an entry that pointed at a different interpreter.
  const existingCmd = _read_win_autostart_command();
  if (existingCmd !== null) {
    const oldInterp = _extract_interpreter_from_command(existingCmd);
    const newInterp = _extract_interpreter_from_command(cmd);
    if (oldInterp && newInterp) {
      const norm = (p: string): string => p.replace(/\\/g, "/").toLowerCase();
      if (norm(oldInterp) !== norm(newInterp)) {
        _LOG.warning(
          "install_worker_task: replacing existing autostart entry " +
            "(old interpreter: %s) with new one (new interpreter: %s)",
          oldInterp,
          newInterp,
        );
      }
    }
  }

  const reg = _winreg();
  if (!reg) {
    const msg = "winreg unavailable";
    _LOG.warning("failed to set HKCU Run key %s: %s", TASK_WORKER, msg);
    return [false, msg];
  }
  try {
    reg.setRunValue(TASK_WORKER, cmd);
    _LOG.info("HKCU Run key set: key=%s cmd=%s", TASK_WORKER, cmd);
    return [true, `HKCU Run key set: ${cmd}`];
  } catch (exc) {
    _LOG.warning("failed to set HKCU Run key %s: %s", TASK_WORKER, exc);
    return [false, String((exc as Error).message ?? exc)];
  }
}

const _USERNAME_RE = /^[A-Za-z0-9_.\-\\@]{1,128}$/;

/**
 * Return the current Windows username if it matches a safe pattern, else "".
 *
 * USERNAME is pulled from the environment and validated before being passed to
 * schtasks /RU. We use a strict allowlist that covers all realistic Windows
 * usernames including domain accounts (DOMAIN\user) and UPN accounts
 * (user@domain). Any value that does not match is silently dropped.
 */
function _safe_username(): string {
  const username = (process.env["USERNAME"] || process.env["USER"] || "").trim();
  if (!username) {
    return "";
  }
  if (!_USERNAME_RE.test(username)) {
    _LOG.warning(
      "install_update_task: USERNAME %s failed safety check; omitting /RU argument",
      username,
    );
    return "";
  }
  return username;
}

/** Create the weekly auto-update scheduled task (Sunday 03:00, user scope). */
export function install_update_task(): [boolean, string] {
  if (!_isWin32()) {
    return [true, "non-Windows: skipped"];
  }
  if (task_exists(TASK_UPDATE)) {
    _run_schtasks(["/Delete", "/TN", TASK_UPDATE, "/F"]);
  }

  const username = _safe_username();
  const args = [
    "/Create",
    "/TN",
    TASK_UPDATE,
    "/SC",
    "WEEKLY",
    "/D",
    "SUN",
    "/ST",
    "03:00",
    "/RL",
    "LIMITED",
    "/F",
    "/TR",
    'cmd /c "npm install -g token-goat@latest"',
  ];
  if (username) {
    args.push("/RU", username);
  }
  const [code, out] = _run_schtasks(args);
  if (code === 0) {
    _LOG.info("update task registered: task=%s user=%s", TASK_UPDATE, username || "<current>");
  } else {
    _LOG.warning(
      "update task registration failed: task=%s code=%d: %s",
      TASK_UPDATE,
      code,
      out.trim(),
    );
  }
  return [code === 0, out];
}

/** Remove worker Run key + update scheduled task. Returns list of names removed. */
export function uninstall_tasks(): string[] {
  const removed: string[] = [];

  // Worker: HKCU Run registry key
  if (_isWin32()) {
    const reg = _winreg();
    if (reg) {
      try {
        reg.deleteRunValue(TASK_WORKER);
        removed.push(TASK_WORKER);
      } catch (e) {
        const code = (e as NodeJS.ErrnoException).code;
        if (code === "ENOENT") {
          // key didn't exist
        } else {
          _LOG.warning("failed to remove registry autostart entry: %s", e);
        }
      }
    }
  }

  // Update task: still a schtasks WEEKLY entry
  if (task_exists(TASK_UPDATE)) {
    const [code] = _run_schtasks(["/Delete", "/TN", TASK_UPDATE, "/F"]);
    if (code === 0) {
      removed.push(TASK_UPDATE);
    }
  }

  return removed;
}

// ---------------------------------------------------------------------------
// Linux autostart (systemd user service + XDG autostart fallback)
// ---------------------------------------------------------------------------

/** Return ~/.config/systemd/user/ */
function _systemd_user_dir(): string {
  return nodePath.join(_home(), ".config", "systemd", "user");
}

/** Return ~/.config/systemd/user/token-goat-worker.service */
export function _systemd_service_path(): string {
  return nodePath.join(_systemd_user_dir(), `${SYSTEMD_SERVICE_NAME}.service`);
}

/** Return ~/.config/autostart/token-goat-worker.desktop */
export function _xdg_autostart_path(): string {
  return nodePath.join(_home(), ".config", "autostart", "token-goat-worker.desktop");
}

/** Return True if systemd --user is running and accepting service management. */
export function _systemd_user_available(): boolean {
  const r = _runSubprocess(
    "systemctl",
    ["--user", "--no-pager", "is-system-running"],
    { timeoutMs: 5000 },
  );
  if (r.failed) {
    return false;
  }
  const out = (r.stdout || "").trim();
  return out === "running" || out === "degraded";
}

/**
 * POSIX shell-quote a single argument (shlex.quote port).
 *
 * Wraps the argument in single quotes when it contains anything outside the
 * shlex "safe" set (alphanumerics plus @%+=:,./-). An embedded single quote is
 * escaped as '"'"'. An empty string becomes ''.
 */
function _shlex_quote(s: string): string {
  if (s === "") {
    return "''";
  }
  if (/^[A-Za-z0-9@%+=:,./_-]+$/.test(s)) {
    return s;
  }
  return "'" + s.replace(/'/g, "'\"'\"'") + "'";
}

/**
 * Register worker autostart on Linux.
 *
 * Tries systemd --user first; falls back to an XDG autostart .desktop file. On
 * WSL without systemd the XDG file is written but won't trigger at logon — the
 * SessionStart watchdog ensures the worker runs on every session regardless.
 *
 * If an existing entry points to a different interpreter, it is replaced and a
 * WARNING is logged.
 */
export function install_linux_autostart(): [boolean, string] {
  if (_isWin32()) {
    return [true, "Windows: skipped"];
  }

  // Dedup check: warn when replacing an entry that pointed at a different interpreter.
  const existingCmd = _read_linux_autostart_command();
  if (existingCmd !== null) {
    const oldInterp = _extract_interpreter_from_command(existingCmd);
    const newInterp = _sysExecutable();
    if (oldInterp && newInterp) {
      // Linux paths are case-sensitive.
      if (oldInterp !== newInterp) {
        _LOG.warning(
          "install_linux_autostart: replacing existing autostart entry " +
            "(old interpreter: %s) with new one (new interpreter: %s)",
          oldInterp,
          newInterp,
        );
      }
    }
  }

  const cmdArgs = paths.pythonRunnerArgv("worker", "--daemon");
  // Shell-quote every argument so paths containing spaces are correctly
  // represented in the systemd unit's ExecStart= directive and in the XDG
  // .desktop Exec= field. Both formats accept POSIX shell quoting.
  const execStr = cmdArgs.map((a) => _shlex_quote(a)).join(" ");

  if (_systemd_user_available()) {
    const svcDir = _systemd_user_dir();
    paths.ensureDir(svcDir);
    const svcPath = _systemd_service_path();
    fs.writeFileSync(
      svcPath,
      "[Unit]\n" +
        "Description=token-goat background worker\n" +
        "After=default.target\n" +
        "StartLimitIntervalSec=60\n" +
        "StartLimitBurst=3\n\n" +
        "[Service]\n" +
        "Type=simple\n" +
        `ExecStart=${execStr}\n` +
        "Restart=on-failure\n" +
        "RestartSec=5\n\n" +
        "[Install]\n" +
        "WantedBy=default.target\n",
      { encoding: "utf-8" },
    );
    _LOG.info("systemd service file written: %s", svcPath);

    const reloadR = _runSubprocess("systemctl", ["--user", "daemon-reload"], { timeoutMs: 10000 });
    if (reloadR.failed) {
      _LOG.warning("systemctl unavailable or timed out: %s", reloadR.error);
      return [false, `systemd enable failed: ${reloadR.error}`];
    }
    if (reloadR.returncode !== 0) {
      _LOG.warning(
        "systemctl daemon-reload exited %d: %s",
        reloadR.returncode,
        (reloadR.stderr || "").trim(),
      );
    } else {
      _LOG.debug("systemctl daemon-reload ok");
    }

    const enableR = _runSubprocess("systemctl", ["--user", "enable", SYSTEMD_SERVICE_NAME], {
      timeoutMs: 10000,
    });
    if (enableR.failed) {
      _LOG.warning("systemctl unavailable or timed out: %s", enableR.error);
      return [false, `systemd enable failed: ${enableR.error}`];
    }
    if (enableR.returncode !== 0) {
      _LOG.warning(
        "systemctl enable %s exited %d: %s",
        SYSTEMD_SERVICE_NAME,
        enableR.returncode,
        (enableR.stderr || "").trim(),
      );
    } else {
      _LOG.info("systemctl enable %s ok", SYSTEMD_SERVICE_NAME);
    }

    return [
      true,
      `systemd user service installed: ${svcPath} — ` +
        `run \`systemctl --user start ${SYSTEMD_SERVICE_NAME}\` to start immediately`,
    ];
  }

  // Fallback: XDG autostart .desktop file. Works on desktop sessions (GNOME,
  // KDE, XFCE). On WSL the SessionStart watchdog fills the gap.
  const desktop = _xdg_autostart_path();
  paths.ensureDir(nodePath.dirname(desktop));
  fs.writeFileSync(
    desktop,
    "[Desktop Entry]\n" +
      "Version=1.0\n" +
      "Type=Application\n" +
      "Name=token-goat worker\n" +
      `Exec=${execStr}\n` +
      "Hidden=false\n" +
      "NoDisplay=true\n" +
      "X-GNOME-Autostart-enabled=true\n",
    { encoding: "utf-8" },
  );
  _LOG.info("XDG autostart file written: %s", desktop);
  return [
    true,
    `XDG autostart installed: ${desktop} ` +
      "(SessionStart watchdog also ensures the worker runs)",
  ];
}

/** Remove Linux autostart entries. Returns a list of paths removed. */
export function uninstall_linux_autostart(): string[] {
  if (_isWin32()) {
    return [];
  }

  const removed: string[] = [];

  const svcPath = _systemd_service_path();
  if (fs.existsSync(svcPath)) {
    // contextlib.suppress(FileNotFoundError, TimeoutExpired)
    _runSubprocess("systemctl", ["--user", "disable", "--now", SYSTEMD_SERVICE_NAME], {
      timeoutMs: 10000,
    });
    try {
      fs.unlinkSync(svcPath);
      _runSubprocess("systemctl", ["--user", "daemon-reload"], { timeoutMs: 10000 });
      removed.push(svcPath);
    } catch (e) {
      _LOG.warning("failed to remove systemd service: %s", e);
    }
  }

  const desktop = _xdg_autostart_path();
  if (fs.existsSync(desktop)) {
    try {
      fs.unlinkSync(desktop);
      removed.push(desktop);
    } catch (e) {
      _LOG.warning("failed to remove XDG autostart: %s", e);
    }
  }

  return removed;
}

/** Add a weekly Sunday 03:00 cron job to auto-update token-goat. */
export function install_linux_update_cron(): [boolean, string] {
  if (_isWin32()) {
    return [true, "Windows: skipped"];
  }

  if (!which("crontab")) {
    _LOG.info("crontab not found in PATH; skipping cron install");
    return [false, "crontab not available (not found in PATH)"];
  }

  const cronLine = `0 3 * * 0 npm install -g token-goat@latest ${CRON_JOB_MARKER}`;
  const r = _runSubprocess("crontab", ["-l"], { timeoutMs: 10000 });
  if (r.failed) {
    return [false, `crontab unavailable: ${r.error}`];
  }
  // crontab -l exits 1 with no output on a fresh system that has no crontab yet;
  // treat that as an empty crontab rather than an error.
  const existing = r.returncode === 0 ? r.stdout : "";

  const lines = _splitlines(existing).filter((ln) => !ln.includes(CRON_JOB_MARKER));
  lines.push(cronLine);
  const newCrontab = lines.join("\n") + "\n";

  const r2 = _runSubprocess("crontab", ["-"], { input: newCrontab, timeoutMs: 10000 });
  if (r2.failed) {
    _LOG.warning("crontab write failed: %s", r2.error);
    return [false, `crontab write failed: ${r2.error}`];
  }
  if (r2.returncode === 0) {
    _LOG.info("cron job installed: %s", cronLine);
  } else {
    _LOG.warning("crontab write exited %d: %s", r2.returncode, (r2.stderr || "").trim());
  }
  return [r2.returncode === 0, `cron job added: ${cronLine}`];
}

/** Remove the token-goat cron job. */
export function uninstall_linux_update_cron(): string {
  if (_isWin32()) {
    return "n/a (Windows)";
  }

  if (!which("crontab")) {
    return "crontab not available (not found in PATH)";
  }

  const r = _runSubprocess("crontab", ["-l"], { timeoutMs: 10000 });
  if (r.failed) {
    return `crontab unavailable: ${r.error}`;
  }
  if (r.returncode !== 0) {
    return "no crontab found";
  }
  const lines = _splitlines(r.stdout).filter((ln) => !ln.includes(CRON_JOB_MARKER));
  _runSubprocess("crontab", ["-"], { input: lines.join("\n") + "\n", timeoutMs: 10000 });
  return "cron job removed";
}

// ---------------------------------------------------------------------------
// macOS autostart (launchd user agent)
// ---------------------------------------------------------------------------

/** Return ~/Library/LaunchAgents/com.dfkhelper.token-goat-worker.plist */
export function _launchd_plist_path(): string {
  return nodePath.join(_home(), "Library", "LaunchAgents", `${LAUNCHD_PLIST_NAME}.plist`);
}

/**
 * Escape a string for safe embedding in XML element content.
 *
 * Guards against XML injection in the macOS LaunchAgent plist when a
 * command-line argument or file-system path contains <, >, &, ', or ". Mirrors
 * Python's html.escape(s, quote=True) then normalises &#x27; back to &apos;.
 *
 * Order matters: & must be replaced first so the entities introduced below are
 * not double-escaped.
 */
function _xml_escape(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

/**
 * Register worker autostart on macOS via a LaunchAgent plist.
 *
 * Writes ~/Library/LaunchAgents/com.dfkhelper.token-goat-worker.plist and calls
 * `launchctl load` to activate it immediately. No admin required. Idempotent:
 * unloads before re-loading if the plist already exists.
 *
 * If an existing plist points to a different interpreter, it is replaced and a
 * WARNING is logged.
 */
export function install_mac_autostart(): [boolean, string] {
  if (_isWin32()) {
    return [true, "Windows: skipped"];
  }

  // Dedup check: warn when replacing an entry that pointed at a different interpreter.
  const existingCmd = _read_mac_autostart_command();
  if (existingCmd !== null) {
    const oldInterp = _extract_interpreter_from_command(existingCmd);
    const newInterp = _sysExecutable();
    if (oldInterp && newInterp && oldInterp !== newInterp) {
      _LOG.warning(
        "install_mac_autostart: replacing existing autostart entry " +
          "(old interpreter: %s) with new one (new interpreter: %s)",
        oldInterp,
        newInterp,
      );
    }
  }

  const cmdArgs = paths.pythonRunnerArgv("worker", "--daemon");
  const plistPath = _launchd_plist_path();
  paths.ensureDir(nodePath.dirname(plistPath));

  // XML-escape every argument and path to guard against injection.
  const argEntries = cmdArgs
    .map((arg) => `        <string>${_xml_escape(arg)}</string>`)
    .join("\n");
  const logDir = paths.logsDir();
  paths.ensureDir(logDir);

  const plistXml =
    '<?xml version="1.0" encoding="UTF-8"?>\n' +
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"' +
    ' "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n' +
    '<plist version="1.0">\n' +
    "<dict>\n" +
    "    <key>Label</key>\n" +
    `    <string>${_xml_escape(LAUNCHD_PLIST_NAME)}</string>\n` +
    "    <key>ProgramArguments</key>\n" +
    "    <array>\n" +
    `${argEntries}\n` +
    "    </array>\n" +
    "    <key>RunAtLoad</key>\n" +
    "    <true/>\n" +
    "    <key>KeepAlive</key>\n" +
    "    <dict>\n" +
    "        <key>SuccessfulExit</key>\n" +
    "        <false/>\n" +
    "    </dict>\n" +
    "    <key>StandardOutPath</key>\n" +
    `    <string>${_xml_escape(nodePath.join(logDir, "worker-stdout.log"))}</string>\n` +
    "    <key>StandardErrorPath</key>\n" +
    `    <string>${_xml_escape(nodePath.join(logDir, "worker-stderr.log"))}</string>\n` +
    "</dict>\n" +
    "</plist>\n";
  fs.writeFileSync(plistPath, plistXml, { encoding: "utf-8" });

  // Unload first (idempotent — ignore errors if not loaded yet).
  const unloadR = _runSubprocess("launchctl", ["unload", plistPath], { timeoutMs: 10000 });
  _LOG.debug("launchctl unload %s: exit=%d", LAUNCHD_PLIST_NAME, unloadR.returncode);

  const r = _runSubprocess("launchctl", ["load", plistPath], { timeoutMs: 10000 });
  if (r.failed) {
    _LOG.warning("launchctl unavailable for %s: %s", LAUNCHD_PLIST_NAME, r.error);
    return [false, `launchctl unavailable: ${r.error}`];
  }
  if (r.returncode !== 0) {
    const err = (r.stderr || "").trim();
    _LOG.warning("launchctl load %s failed (exit=%d): %s", LAUNCHD_PLIST_NAME, r.returncode, err);
    return [false, `launchctl load failed: ${err}`];
  }
  _LOG.info("LaunchAgent installed and loaded: %s", plistPath);
  return [
    true,
    `LaunchAgent installed: ${plistPath} — ` +
      `run \`launchctl list ${LAUNCHD_PLIST_NAME}\` to confirm it is running`,
  ];
}

/** Remove the macOS LaunchAgent plist. Returns a list of paths removed. */
export function uninstall_mac_autostart(): string[] {
  if (_isWin32()) {
    return [];
  }

  const removed: string[] = [];
  const plistPath = _launchd_plist_path();
  if (fs.existsSync(plistPath)) {
    // contextlib.suppress(FileNotFoundError, TimeoutExpired)
    _runSubprocess("launchctl", ["unload", plistPath], { timeoutMs: 10000 });
    try {
      fs.unlinkSync(plistPath);
      removed.push(plistPath);
      _LOG.info("removed LaunchAgent plist: %s", plistPath);
    } catch (e) {
      _LOG.warning("failed to remove LaunchAgent plist: %s", e);
    }
  }
  return removed;
}

/** Return the macOS LaunchAgent status string. */
export function _check_mac_autostart(): string {
  if (_isWin32()) {
    return "n/a (Windows)";
  }
  return fs.existsSync(_launchd_plist_path()) ? "installed" : "not installed";
}

/** Return the Linux autostart status string. */
function _check_linux_autostart(): string {
  if (_isWin32()) {
    return "n/a (Windows)";
  }
  if (fs.existsSync(_systemd_service_path())) {
    return "installed (systemd user service)";
  }
  if (fs.existsSync(_xdg_autostart_path())) {
    return "installed (XDG autostart)";
  }
  return "not installed";
}

/** Return the Linux cron job status string. */
function _check_linux_update_cron(): string {
  if (_isWin32()) {
    return "n/a (Windows)";
  }
  const r = _runSubprocess("crontab", ["-l"], { timeoutMs: 5000 });
  if (r.failed) {
    return "n/a (crontab unavailable)";
  }
  if (r.returncode !== 0) {
    return "not installed (no crontab)";
  }
  return r.stdout.includes(CRON_JOB_MARKER) ? "installed" : "not installed";
}

// ---------------------------------------------------------------------------
// settings.json patching
// ---------------------------------------------------------------------------

/**
 * Write the persistent hook wrapper script to {data_dir}/bin/.
 *
 * The wrapper bridges the `npm install -g token-goat@latest` reinstall race
 * window where the global package's files are briefly absent. Idempotent —
 * rewriting is safe and picks up any change in the interpreter/entry path.
 */
export function _write_hook_wrapper(): string {
  const wrapperPath = paths.hookWrapperPath();
  paths.ensureDir(nodePath.dirname(wrapperPath));
  const content = paths.hookWrapperContent();
  // Write as bytes, not text: content bakes in platform-correct line endings.
  paths.atomicWriteBytes(wrapperPath, Buffer.from(content, "utf-8"));
  if (!_isWin32()) {
    fs.chmodSync(wrapperPath, 0o755);
  }
  _LOG.info("install step: hook wrapper — %s", wrapperPath);
  return wrapperPath;
}

/**
 * Return the hook command for settings.json.
 *
 * Prefers the persistent wrapper (data_dir/bin/tg-hook.cmd) when it exists, so
 * an `npm install -g token-goat@latest` mid-session does not surface a transient
 * module-not-found error. Falls back to direct invocation when the wrapper is
 * absent.
 */
export function _hook_runner_command(...subcommand: string[]): string {
  const wrapper = paths.hookWrapperPath();
  if (fs.existsSync(wrapper)) {
    const wrapperStr = wrapper.replace(/\\/g, "/");
    const quotedArgs = subcommand.map((a) => (a.includes(" ") ? `"${a}"` : a)).join(" ");
    return subcommand.length > 0 ? `"${wrapperStr}" ${quotedArgs}` : `"${wrapperStr}"`;
  }
  return paths.pythonRunnerCommand(...subcommand);
}

/**
 * Derive a hooks structure from hook_registry.
 *
 * Drives both _hooks_block (Claude wire format) and _codex_hooks_block (Codex
 * wire format) from the single registry source of truth.
 */
function _build_hooks_block(
  runner: (...subcommand: string[]) => string,
  codex: boolean,
): Record<string, _HookMatcherEntry[]> {
  const block: Record<string, _HookMatcherEntry[]> = {};
  const events: readonly HookEvent[] = codex
    ? hook_registry.codex_events()
    : hook_registry.claude_events();
  for (const ev of events) {
    const topEvent = codex ? ev.codex_event : ev.claude_event;
    const matcher = codex ? ev.codex_matcher : ev.claude_matcher;
    const timeout = codex ? ev.codex_timeout_ms : ev.claude_timeout_ms;
    if (!topEvent) {
      continue;
    }
    // Codex hooks need the explicit harness flag so the dispatcher knows which
    // wire format to use for the response.
    const cmd = codex
      ? runner("hook", ev.name, "--harness", "codex")
      : runner("hook", ev.name);
    const entry: _HookMatcherEntry = {
      matcher,
      hooks: [{ type: "command", command: cmd, timeout }],
    };
    if (!(topEvent in block)) {
      block[topEvent] = [];
    }
    block[topEvent]!.push(entry);
  }
  return block;
}

/**
 * Build the Claude Code settings.json hooks structure.
 *
 * Derived from hook_registry.HOOK_EVENTS. The `binary` parameter is kept for
 * backwards compatibility but unused; commands now invoke the persistent
 * wrapper at data_dir/bin/tg-hook.cmd.
 */
export function _hooks_block(_binary?: string | null): Record<string, _HookMatcherEntry[]> {
  return _build_hooks_block(_hook_runner_command, false);
}

// Substrings that identify a hook command as belonging to token-goat.
// - "token_goat" matches the legacy direct pythonw -m token_goat.cli form.
// - "tg-hook" matches the persistent wrapper at data_dir/bin/tg-hook.cmd.
const _TOKEN_GOAT_HOOK_MARKERS = ["token_goat", "tg-hook"] as const;
// Legacy command markers from before the tokenwise -> token-goat rename.
const _LEGACY_HOOK_MARKERS = ["tokenwise"] as const;

/**
 * Return True when *command* is one of our *current* hook commands.
 *
 * Current-only by design: drives the "installed?" status checks, so a config
 * carrying only stale legacy entries correctly reports as not installed.
 */
export function _is_token_goat_hook(command: string): boolean {
  return _TOKEN_GOAT_HOOK_MARKERS.some((marker) => command.includes(marker));
}

/**
 * Return True when *command* is a hook token-goat owns and should replace.
 *
 * Covers current and legacy (pre-rename tokenwise) command markers, so the
 * idempotent strip path removes orphaned legacy entries.
 */
export function _is_managed_hook(command: string): boolean {
  return (
    _is_token_goat_hook(command) ||
    _LEGACY_HOOK_MARKERS.some((marker) => command.includes(marker))
  );
}

// Claude settings.json permission allowlist entry, plus legacy variants.
const _TOKEN_GOAT_PERMISSION = "Bash(token-goat:*)";
const _LEGACY_PERMISSIONS = ["Bash(tokenwise:*)"] as const;

/** Remove hook entries belonging to token-goat (for idempotent re-install). */
function _strip_token_goat_entries(entries: Array<Record<string, unknown>>): Array<Record<string, unknown>> {
  const kept: Array<Record<string, unknown>> = [];
  for (const entry of entries) {
    const rawHooks = entry["hooks"] ?? [];
    const hookList: Array<Record<string, unknown>> = Array.isArray(rawHooks)
      ? (rawHooks as Array<Record<string, unknown>>)
      : [];
    const survivingHooks = hookList.filter(
      (h) =>
        _isPlainObject(h) && !_is_managed_hook(String((h as Record<string, unknown>)["command"] ?? "")),
    );
    if (survivingHooks.length > 0) {
      kept.push({ matcher: entry["matcher"] ?? "*", hooks: survivingHooks });
    }
  }
  return kept;
}

/**
 * Idempotently merge *our_hooks* into *existing_hooks* in place.
 *
 * For each event in our_hooks: strip any prior token-goat entries from the
 * existing list, then append the fresh ones. Returns [added, replaced].
 */
function _merge_token_goat_hooks(
  existingHooks: Record<string, unknown>,
  ourHooks: Record<string, _HookMatcherEntry[]>,
): [string[], string[]] {
  const added: string[] = [];
  const replaced: string[] = [];
  for (const event of Object.keys(ourHooks)) {
    const entries = ourHooks[event]!;
    const rawExisting = existingHooks[event];
    const existingEntries: Array<Record<string, unknown>> = Array.isArray(rawExisting)
      ? (rawExisting as Array<Record<string, unknown>>)
      : [];
    const kept = _strip_token_goat_entries(existingEntries);
    const strippedCount = existingEntries.length - kept.length;
    existingHooks[event] = [...kept, ...(entries as unknown as Array<Record<string, unknown>>)];
    if (strippedCount) {
      replaced.push(`${event}(replaced ${strippedCount})`);
    } else {
      added.push(event);
    }
  }
  return [added, replaced];
}

/**
 * Remove all token-goat entries from *hooks* in place, dropping empty events.
 */
function _strip_token_goat_hooks(hooks: Record<string, unknown>): void {
  for (const event of Object.keys(hooks)) {
    const rawEntries = hooks[event];
    const entries: Array<Record<string, unknown>> = Array.isArray(rawEntries)
      ? (rawEntries as Array<Record<string, unknown>>)
      : [];
    const cleaned = _strip_token_goat_entries(entries);
    if (cleaned.length > 0) {
      hooks[event] = cleaned;
    } else {
      delete hooks[event];
    }
  }
}

/** True for a plain JSON object (not array, not null). */
function _isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * Error raised when settings.json cannot be parsed as a JSON object. Carries a
 * `decodeError` flag so callers can distinguish a parse failure (Python's
 * json.JSONDecodeError) from an OS read error.
 */
class JSONDecodeError extends Error {
  readonly decodeError = true;
  constructor(message: string) {
    super(message);
    this.name = "JSONDecodeError";
  }
}

function _isJSONDecodeError(e: unknown): boolean {
  return e instanceof JSONDecodeError || (e instanceof SyntaxError);
}

/**
 * Parse *settings_path* as JSON and return the object.
 *
 * Returns null when the file does not exist (caller should start from {}).
 * Throws JSONDecodeError on malformed content or when the top-level value is
 * not a JSON object. Throws on OS read error.
 */
function _read_settings_json(settingsPath: string): Record<string, unknown> | null {
  if (!fs.existsSync(settingsPath)) {
    return null;
  }
  let raw: string;
  try {
    raw = fs.readFileSync(settingsPath, "utf-8");
  } catch (e) {
    throw new Error(`could not read settings.json: ${(e as Error).message ?? e}`);
  }
  const data = JSON.parse(raw);
  if (!_isPlainObject(data)) {
    const typeName = Array.isArray(data) ? "array" : data === null ? "NoneType" : typeof data;
    throw new JSONDecodeError(`settings.json must be a JSON object, got ${typeName}`);
  }
  return data;
}

/**
 * Write *data* as indented JSON to *settings_path* atomically (indent=2).
 */
function _write_settings_json(settingsPath: string, data: Record<string, unknown>): void {
  paths.atomicWriteText(settingsPath, JSON.stringify(data, null, 2));
}

/** Add token-goat hooks to ~/.claude/settings.json idempotently. Preserves other hooks. */
export function patch_settings_json(): [boolean, string] {
  const settingsPath = claude_settings_path();
  paths.ensureDir(nodePath.dirname(settingsPath));

  let current: Record<string, unknown>;
  if (fs.existsSync(settingsPath)) {
    try {
      current = _read_settings_json(settingsPath) ?? {};
    } catch (e) {
      if (_isJSONDecodeError(e)) {
        return [false, "settings.json is malformed JSON"];
      }
      throw e;
    }
  } else {
    current = {};
  }

  const binary = token_goat_hook_binary();
  const ourHooks = _hooks_block(binary);

  // Backup before any modification. Faithful to Python's unguarded
  // shutil.copy2(settings_path, backup): a copy failure propagates.
  if (fs.existsSync(settingsPath)) {
    const backup = _withSuffix(settingsPath, `.json.bak.${_timestamp()}`);
    fs.copyFileSync(settingsPath, backup);
  }

  const rawHooks = current["hooks"] ?? {};
  const existingHooks: Record<string, unknown> = _isPlainObject(rawHooks) ? rawHooks : {};
  const [hooksAdded, hooksReplaced] = _merge_token_goat_hooks(existingHooks, ourHooks);
  current["hooks"] = existingHooks;
  if (hooksReplaced.length > 0) {
    _LOG.info("patch_settings_json: replaced existing entries for: %s", hooksReplaced.join(", "));
  }
  if (hooksAdded.length > 0) {
    _LOG.info("patch_settings_json: added new hook entries for: %s", hooksAdded.join(", "));
  }

  // Permission allowlist — add the current entry, drop any legacy entries.
  const rawPerms = current["permissions"] ?? {};
  const perms: Record<string, unknown> = _isPlainObject(rawPerms) ? rawPerms : {};
  const rawAllowed = perms["allow"] ?? [];
  const allowed: string[] = (Array.isArray(rawAllowed) ? (rawAllowed as unknown[]) : []).filter(
    (a): a is string =>
      typeof a === "string" && !(_LEGACY_PERMISSIONS as readonly string[]).includes(a),
  );
  const permAdded = !allowed.includes(_TOKEN_GOAT_PERMISSION);
  if (permAdded) {
    allowed.push(_TOKEN_GOAT_PERMISSION);
    _LOG.info("patch_settings_json: added permission %s", _TOKEN_GOAT_PERMISSION);
  } else {
    _LOG.debug("patch_settings_json: permission %s already present", _TOKEN_GOAT_PERMISSION);
  }
  perms["allow"] = allowed;
  current["permissions"] = perms;

  _write_settings_json(settingsPath, current);
  _LOG.info("patch_settings_json: wrote %s", settingsPath);
  return [true, settingsPath];
}

/** Remove token-goat entries from settings.json. */
export function unpatch_settings_json(): string {
  const settingsPath = claude_settings_path();
  if (!fs.existsSync(settingsPath)) {
    return "settings.json not found (nothing to do)";
  }
  let current: Record<string, unknown>;
  try {
    current = _read_settings_json(settingsPath) ?? {};
  } catch (e) {
    if (_isJSONDecodeError(e)) {
      return "settings.json malformed; not modifying";
    }
    throw e;
  }

  const rawHooks = current["hooks"] ?? {};
  const hooks: Record<string, unknown> = _isPlainObject(rawHooks) ? rawHooks : {};
  _strip_token_goat_hooks(hooks);
  current["hooks"] = hooks;

  const rawPerms = current["permissions"] ?? {};
  const perms: Record<string, unknown> = _isPlainObject(rawPerms) ? rawPerms : {};
  const rawAllowed = perms["allow"] ?? [];
  const dropPerms = new Set<string>([_TOKEN_GOAT_PERMISSION, ..._LEGACY_PERMISSIONS]);
  const allowed = (Array.isArray(rawAllowed) ? (rawAllowed as unknown[]) : []).filter(
    (a) => typeof a === "string" && !dropPerms.has(a),
  );
  perms["allow"] = allowed;
  // Drop permissions key entirely if it has no meaningful content left.
  const allowEmpty = !Array.isArray(perms["allow"]) || (perms["allow"] as unknown[]).length === 0;
  const denyEmpty = !perms["deny"] || (Array.isArray(perms["deny"]) && (perms["deny"] as unknown[]).length === 0);
  const askEmpty = !perms["ask"] || (Array.isArray(perms["ask"]) && (perms["ask"] as unknown[]).length === 0);
  if (allowEmpty && denyEmpty && askEmpty) {
    delete current["permissions"];
  } else {
    current["permissions"] = perms;
  }

  _write_settings_json(settingsPath, current);
  _LOG.info("unpatch_settings_json: wrote %s", settingsPath);
  return settingsPath;
}

/**
 * Python `Path.with_suffix`-ish helper used only for the settings.json backup
 * name. Strips the final extension of *path* and appends *newSuffix*.
 */
function _withSuffix(path: string, newSuffix: string): string {
  const dir = nodePath.dirname(path);
  const base = nodePath.basename(path);
  const dot = base.lastIndexOf(".");
  const stem = dot > 0 ? base.slice(0, dot) : base;
  return nodePath.join(dir, stem + newSuffix);
}

/** Render the current local time as YYYYmmdd-HHMMSS (datetime.now() format). */
function _timestamp(): string {
  const d = new Date();
  const p2 = (n: number): string => String(n).padStart(2, "0");
  return (
    `${d.getFullYear()}${p2(d.getMonth() + 1)}${p2(d.getDate())}` +
    `-${p2(d.getHours())}${p2(d.getMinutes())}${p2(d.getSeconds())}`
  );
}

// ---------------------------------------------------------------------------
// Shared markdown-block patching helpers
// ---------------------------------------------------------------------------

/** Escape a string for use as a literal inside a RegExp (re.escape port). */
function _reEscape(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Insert or replace a delimited block in a markdown file idempotently.
 *
 * Reads *md_path* (creates it if absent), replaces the region between
 * *begin_marker* and *end_marker* with *content*, and writes the result back.
 * Returns str(md_path).
 */
function _patch_md_block(
  mdPath: string,
  beginMarker: string,
  endMarker: string,
  content: string,
): string {
  paths.ensureDir(nodePath.dirname(mdPath));
  const block = `${beginMarker}\n${content}\n${endMarker}`;

  let updated: string;
  if (fs.existsSync(mdPath)) {
    let existing = fs.readFileSync(mdPath, "utf-8");
    if (existing.includes(beginMarker) && existing.includes(endMarker)) {
      const re = new RegExp(_reEscape(beginMarker) + "[\\s\\S]*?" + _reEscape(endMarker));
      updated = existing.replace(re, () => block);
    } else if (existing.trim()) {
      if (!existing.endsWith("\n")) {
        existing += "\n";
      }
      updated = existing + "\n" + block + "\n";
    } else {
      // File exists but is whitespace-only.
      updated = block + "\n";
    }
  } else {
    updated = block + "\n";
  }

  paths.atomicWriteText(mdPath, updated);
  return mdPath;
}

/**
 * Remove the delimited block between *begin_marker* and *end_marker* from *md_path*.
 *
 * Returns true when a block was stripped (file rewritten), false when nothing
 * matched (file unchanged or absent).
 */
function _remove_md_block(mdPath: string, beginMarker: string, endMarker: string): boolean {
  if (!fs.existsSync(mdPath)) {
    return false;
  }
  const content = fs.readFileSync(mdPath, "utf-8");
  if (!content.includes(beginMarker) || !content.includes(endMarker)) {
    return false;
  }
  const re = new RegExp(
    "\\n*" + _reEscape(beginMarker) + "[\\s\\S]*?" + _reEscape(endMarker) + "\\n*",
  );
  const replaced = content.replace(re, "\n").trim();
  paths.atomicWriteText(mdPath, replaced ? replaced + "\n" : "");
  return true;
}

/**
 * Remove the delimited block between *begin_marker* and *end_marker* from *md_path*.
 *
 * Returns a status string. Always returns the path even when no block matched.
 */
function _unpatch_md_block(
  mdPath: string,
  beginMarker: string,
  endMarker: string,
  notFoundMsg: string,
): string {
  if (!fs.existsSync(mdPath)) {
    return notFoundMsg;
  }
  _remove_md_block(mdPath, beginMarker, endMarker);
  return mdPath;
}

/**
 * Remove a legacy tokenwise-era delimited block from *md_path* if present.
 *
 * Returns true if a block was stripped, false otherwise.
 */
function _strip_legacy_block(mdPath: string, beginMarker: string, endMarker: string): boolean {
  return _remove_md_block(mdPath, beginMarker, endMarker);
}

// ---------------------------------------------------------------------------
// Routing-table single source of truth
// ---------------------------------------------------------------------------
// Each row: (goal, do_this, not_this_claude_skill, not_this_codex)
type _RoutingRow = [string, string, string, string];

const _ROUTING_ROWS: _RoutingRow[] = [
  [
    "Find a function, class, or type",
    "`token-goat symbol getUser`",
    '`Grep "getUser"` (10 to 50x more tokens)',
    '`rg "getUser"` (10 to 50x more tokens)',
  ],
  [
    "Read one function or method body",
    '`token-goat read "src/auth.py::login"`',
    "`Read src/auth.py` (about 85% more tokens)",
    "`cat src/auth.py` (about 85% more tokens)",
  ],
  [
    "Read one method on a class",
    '`token-goat read "src/auth.py::Session.refresh"`',
    "`Read src/auth.py`",
    "`cat src/auth.py`",
  ],
  [
    "Read one section of a doc",
    '`token-goat section "README.md::Install"`',
    "`Read README.md`",
    "`cat README.md`",
  ],
  [
    "Disambiguate a duplicate heading",
    '`token-goat section "doc.md::Setup#2"`',
    "`Read doc.md`",
    "`cat doc.md`",
  ],
  [
    "Find code by meaning, not name",
    '`token-goat semantic "rate limit retry"`',
    "Several rounds of `Grep`",
    "Several rounds of `rg`",
  ],
  [
    "Get oriented in an unfamiliar repo",
    "`token-goat map --compact`",
    "Recursive `ls` plus multiple `Read` calls",
    "`ls -R` plus multiple `cat` calls",
  ],
  [
    "Outline a long Google Doc",
    "`token-goat gdrive-sections <file-id>`",
    "Fetching the whole doc",
    "Fetching the whole doc",
  ],
  [
    "Read one TOML/YAML/JSON/INI/.env/Dockerfile block",
    '`token-goat section "pyproject.toml::tool.ruff"`',
    "`Read pyproject.toml`",
    "`cat pyproject.toml`",
  ],
  [
    "Re-inspect a recent Bash output",
    "`token-goat bash-output <id> --tail 50`",
    "Re-running `pytest`/`cargo`/`git log`",
    "Re-running `pytest`/`cargo`/`git log`",
  ],
  [
    "Find all callers of a symbol",
    "`token-goat refs src/auth.py::login --callers`",
    '`Grep "login"` across many files',
    '`rg "login"` across many files',
  ],
  [
    "List symbols changed since a git ref",
    "`token-goat changed --symbol`",
    "Reading the full `git diff`",
    "Reading the full `git diff`",
  ],
  [
    "Read one value from a config file",
    "`token-goat config-get pyproject.toml project.version`",
    "`Read pyproject.toml`",
    "`cat pyproject.toml`",
  ],
  [
    "List all signatures in a file without bodies",
    "`token-goat skeleton src/auth.py`",
    "`Read src/auth.py` (70-90% more tokens)",
    "`cat src/auth.py` (70-90% more tokens)",
  ],
  [
    "List symbols with line ranges and docstrings",
    "`token-goat outline src/auth.py`",
    "`Read src/auth.py`",
    "`cat src/auth.py`",
  ],
  [
    "Read a file on Windows via PowerShell",
    '`token-goat read "src/auth.py::login"` or `token-goat section "README.md::Install"`',
    "`Get-Content src/auth.py`",
    "`Get-Content src/auth.py`",
  ],
];

// Goal text for the WebFetch row differs by harness (Codex adds "/ web_search").
const _ROUTING_ROW_WEBFETCH_CLAUDE_SKILL: _RoutingRow = [
  "Re-inspect a recent WebFetch response",
  '`token-goat web-output <id> --grep "TODO"`',
  "Re-fetching the same docs URL",
  "Re-fetching the same docs URL", // not_this_codex unused here
];
const _ROUTING_ROW_WEBFETCH_CODEX: _RoutingRow = [
  "Re-inspect a recent WebFetch / web_search response",
  '`token-goat web-output <id> --grep "TODO"`',
  "Re-fetching the same docs URL", // not_this_claude_skill unused here
  "Re-fetching the same docs URL",
];

// Extra row present only in SKILL_MD_CONTENT.
const _ROUTING_ROW_SESSION_TOUCHED: _RoutingRow = [
  "See what you have already touched",
  "`token-goat session-touched`",
  "Re-reading and hoping you remember",
  "Re-reading and hoping you remember",
];

const _ROUTING_TABLE_HEADER = "| Goal | Do this | Not this |\n|------|---------|----------|\n";

/**
 * Render routing rows as a markdown table string (no trailing newline).
 *
 * Each row is (goal, do_this, not_this_claude_skill, not_this_codex). When
 * *codex* is true the fourth element is used; otherwise the third.
 */
function _render_routing_table(rows: _RoutingRow[], codex: boolean): string {
  const col = codex ? 3 : 2;
  const lines = [_ROUTING_TABLE_HEADER.replace(/\n+$/, "")];
  for (const row of rows) {
    lines.push(`| ${row[0]} | ${row[1]} | ${row[col]} |`);
  }
  return lines.join("\n");
}

/** Rows for CLAUDE_MD_CONTENT and SKILL_MD_CONTENT (common rows + WebFetch). */
function _claude_skill_routing_rows(): _RoutingRow[] {
  return [..._ROUTING_ROWS, _ROUTING_ROW_WEBFETCH_CLAUDE_SKILL];
}

/** Rows for CODEX_AGENTS_MD_CONTENT (common rows + Codex WebFetch). */
function _codex_routing_rows(): _RoutingRow[] {
  return [..._ROUTING_ROWS, _ROUTING_ROW_WEBFETCH_CODEX];
}

/** Rows for SKILL_MD_CONTENT (common + WebFetch + session-touched extra row). */
function _skill_routing_rows(): _RoutingRow[] {
  return [..._ROUTING_ROWS, _ROUTING_ROW_WEBFETCH_CLAUDE_SKILL, _ROUTING_ROW_SESSION_TOUCHED];
}

// ---------------------------------------------------------------------------
// CLAUDE.md patching
// ---------------------------------------------------------------------------

export const CLAUDE_MD_CONTENT =
  "## token-goat - route code reads through token-goat first\n" +
  "\n" +
  "token-goat is installed. Before you call Read or Grep on a source file, or use" +
  " PowerShell `Get-Content` on Windows, check for a token-goat command that does the" +
  " same job for a fraction of the tokens. This is the default path, not an optimization." +
  " Skipping it burns context you will need later in the session.\n" +
  "\n" +
  _render_routing_table(_claude_skill_routing_rows(), false) +
  "\n" +
  "\n" +
  "Modifiers: `symbol --all-projects` (cross-repo), `--strict` (disable close-match redirect)," +
  " `map --compact` (300-token budget), `semantic --max-distance 1.0` / `--no-rerank`" +
  " (widen/tighten), `bash-output --grep PATTERN` / `web-output --grep PATTERN` (filter cached" +
  " output), `bash-output --section HEADING` / `web-output --section HEADING` (extract a" +
  " markdown section from cached output), `changed --symbol` (tree-sitter symbol names instead" +
  " of git hunk context), `refs --callers` (resolve enclosing function name for each reference)," +
  " `symbol --context N` (show N lines of surrounding context per symbol), `outline --min-lines N`" +
  " (only show symbols whose body is ≥ N lines)." +
  " A miss prints \"Did you mean...?\" suggestions; a unique high-confidence match redirects" +
  " transparently with a `(redirected from: ...)` marker. Pre-Bash, pre-Grep, and pre-WebFetch" +
  " hooks hint when a tool call is about to repeat.\n" +
  "\n" +
  "Read is the right call when:\n" +
  "- The file is under about 200 lines and you need the whole thing.\n" +
  "- The file has never been indexed (new path, scratch script, untracked draft).\n" +
  "- It is an image you need to see visually. The shrink runs automatically. Just Read it.\n" +
  "\n" +
  "Skill commands (after a skill is loaded via Skill tool):\n" +
  "- `token-goat skill-body <name>` — print the full cached body for a loaded skill\n" +
  "- `token-goat skill-body --compact <name>` — print the compact slice" +
  " (post-COMPACT_END rules; far fewer tokens)\n" +
  "- `token-goat skill-compact <name>` — alias for skill-body --compact; regenerates and" +
  " caches the compact\n" +
  "- `token-goat skill-compact --all` — batch-regenerate stale or missing compacts for every" +
  " cached skill in the current session; skips skills whose compact is already fresh\n" +
  "- `token-goat skill-size [--session-id <id>]` — show body and compact token counts for" +
  " all cached skills\n" +
  "- `token-goat skill-list [--session-id <id>]` — list loaded skills with compact" +
  " availability, token counts, and per-skill compact_stale status\n" +
  "- `token-goat skill-list --json [--session-id <id>]` — machine-readable output; each" +
  " skill row includes compact_stale (true/false/null) comparing the compact's source SHA" +
  " to the current body SHA — null when no compact exists or SHA is unavailable\n" +
  "- `token-goat skill-section <name> <heading>` — extract one named section from a skill" +
  " body\n" +
  "\n" +
  "Stale compact advisory: when a skill file is read from disk and the cached compact's" +
  " source SHA no longer matches the file's current content SHA, the pre-read hook emits a" +
  " `token-goat skill-compact <name>` hint. Run `skill-compact --all` after updating any" +
  " skill file to refresh all compacts in one pass.\n" +
  "\n" +
  "Opt-in config options (set in config.toml or via env vars):\n" +
  "- `compact_assist.lazy_skill_injection` (default true) — instead of embedding the full" +
  " compact body in the pre-compact manifest, emit a one-line recall pointer" +
  " (`token-goat skill-body <name> --compact`). Keeps manifests small; the model fetches" +
  " body text on demand. Disable with `TOKEN_GOAT_LAZY_SKILL_INJECTION=0` or" +
  " `[compact_assist] lazy_skill_injection = false` to embed compacts inline.\n" +
  "- `hints.serve_diff_on_reread` (default false) — when an already-read file is re-read" +
  " and its content has changed since the last read, deny the Read tool call and inject a" +
  " unified diff instead of the full file. Saves 10-100x tokens when only a few lines" +
  " changed. Enable with `TOKEN_GOAT_SERVE_DIFF_ON_REREAD=1` or" +
  " `[hints] serve_diff_on_reread = true`.\n" +
  "\n" +
  "`token-goat stats` groups event kinds into named categories (Read savings, Lookups," +
  " Images, Hints, Bash, Web, Compact / Skills, Other) so the table stays readable even" +
  " after many event kinds accumulate. The `By command` breakdown shows which surgical-read" +
  " commands (symbol, read, section, semantic, map, skeleton, outline, refs, changed," +
  " config-get) are generating savings.\n" +
  "\n" +
  "Verify the habit. Run `token-goat stats` and watch event counts climb. Flat counts" +
  " during code work mean you are reaching for Read or Grep where token-goat would apply.\n";

/** Add or update the token-goat block in ~/.claude/CLAUDE.md, idempotently. */
export function patch_claude_md(): string {
  const mdPath = claude_md_path();
  const existed = fs.existsSync(mdPath);
  if (_strip_legacy_block(mdPath, LEGACY_CLAUDE_MD_BEGIN, LEGACY_CLAUDE_MD_END)) {
    _LOG.info("patch_claude_md: stripped legacy tokenwise block from %s", mdPath);
  }
  const result = _patch_md_block(mdPath, CLAUDE_MD_BEGIN, CLAUDE_MD_END, CLAUDE_MD_CONTENT);
  const action = existed ? "updated" : "created";
  _LOG.info("patch_claude_md: %s %s", action, mdPath);
  return result;
}

/** Remove the token-goat block from ~/.claude/CLAUDE.md. */
export function unpatch_claude_md(): string {
  return _unpatch_md_block(claude_md_path(), CLAUDE_MD_BEGIN, CLAUDE_MD_END, "CLAUDE.md not found");
}

// ---------------------------------------------------------------------------
// Skill
// ---------------------------------------------------------------------------

export const SKILL_MD_CONTENT =
  "---\n" +
  "name: token-goat\n" +
  "description: Use BEFORE reaching for Read or Grep on a source file, or PowerShell" +
  " `Get-Content` on Windows. token-goat commands replace symbol search, single-function" +
  " reads, doc-section reads, semantic search, and repo overviews at a fraction of the" +
  " token cost. Hooks handle image shrink, Drive intercept, and read dedup automatically." +
  " Skipping token-goat burns session context.\n" +
  "---\n" +
  "\n" +
  "# token-goat\n" +
  "\n" +
  "token-goat is installed. Route code and content reads through it first. This is the" +
  " default path, not optional polish. Tokens you spend rereading files or grepping wide" +
  " are tokens you will not have for the work that matters.\n" +
  "\n" +
  "## Automatic. Do not duplicate.\n" +
  "\n" +
  "- Large images on Read get redirected to a shrunken cached copy (about 95% fewer tokens).\n" +
  "- Google Drive downloads get redirected to a token-goat fetch that downloads, shrinks," +
  " and caches.\n" +
  "- WebFetch on an image URL gets the same treatment.\n" +
  "- Repeat reads of the same file in one session trigger a system reminder so you do not" +
  " pay twice.\n" +
  "\n" +
  "You do not call these. They run on their own.\n" +
  "\n" +
  "## What you DO call\n" +
  "\n" +
  "Before reaching for Read or Grep on a code file, or PowerShell `Get-Content` on" +
  " Windows, check this table.\n" +
  "\n" +
  _render_routing_table(_skill_routing_rows(), false) +
  "\n" +
  "\n" +
  "Modifiers: `symbol --all-projects` (cross-repo), `--strict` (disable close-match redirect)," +
  " `map --compact` (300-token budget), `semantic --max-distance 1.0` / `--no-rerank`" +
  " (widen/tighten), `bash-output --grep PATTERN` / `web-output --grep PATTERN` (filter cached" +
  " output), `bash-output --section HEADING` / `web-output --section HEADING` (extract a" +
  " markdown section from cached output), `changed --symbol` (tree-sitter symbol names instead" +
  " of git hunk context), `refs --callers` (resolve enclosing function name for each reference)," +
  " `symbol --context N` (show N lines of surrounding context per symbol), `outline --min-lines N`" +
  " (only show symbols whose body is ≥ N lines)." +
  " A miss prints \"Did you mean...?\" suggestions; try one before falling back to `Read`. A" +
  " unique high-confidence match redirects transparently with a `(redirected from: ...)` marker.\n" +
  "\n" +
  "## Skill commands\n" +
  "\n" +
  "After a skill is loaded via the Skill tool, use these to inspect or recall it:\n" +
  "\n" +
  "- `token-goat skill-body <name>` — print the full cached body for a loaded skill\n" +
  "- `token-goat skill-body --compact <name>` — print the compact slice (post-COMPACT_END rules" +
  " only; far fewer tokens)\n" +
  "- `token-goat skill-compact <name>` — alias for skill-body --compact; regenerates and caches" +
  " the compact\n" +
  "- `token-goat skill-compact --all` — batch-regenerate stale or missing compacts for every" +
  " cached skill in the current session (skips skills whose compact is already fresh)\n" +
  "- `token-goat skill-size [--session-id <id>]` — show body and compact token counts for all" +
  " cached skills\n" +
  "- `token-goat skill-list [--session-id <id>]` — list loaded skills with compact availability," +
  " token counts, and compact_stale status\n" +
  "- `token-goat skill-list --json [--session-id <id>]` — machine-readable output; each skill" +
  " row includes compact_stale (true/false/null) — true when the compact's embedded source SHA" +
  " does not match the body's current SHA\n" +
  "- `token-goat skill-section <name> <heading>` — extract one named section from a skill body\n" +
  "\n" +
  "Stale compact advisory: when a skill file changes on disk between sessions, the pre-read" +
  " hook detects the SHA mismatch and hints `token-goat skill-compact <name>`. Run" +
  " `skill-compact --all` after updating skill files to refresh every compact in one pass.\n" +
  "\n" +
  "## When Read is the right call\n" +
  "\n" +
  "- The file is under about 200 lines and you need the whole thing.\n" +
  "- The file has never been indexed (new path, scratch script, untracked draft).\n" +
  "- You need to view an image visually. The shrink already ran. Just Read it.\n" +
  "\n" +
  "## Verify the habit\n" +
  "\n" +
  "Run `token-goat stats` and watch event counts climb. Flat counts during code work mean" +
  " you are reaching for Read or Grep where a token-goat command would apply. Run" +
  " `token-goat doctor` if anything looks wrong. Run `token-goat version` to confirm the" +
  " installed version (scriptable; `--json` for structured output).\n";

/** Write the token-goat skill to the Claude Code skills directory. */
export function write_skill(): string {
  const sd = skill_dir();
  paths.ensureDir(sd);
  const skillPath = nodePath.join(sd, "SKILL.md");
  fs.writeFileSync(skillPath, SKILL_MD_CONTENT, { encoding: "utf-8" });
  _LOG.info("skill written: %s (%d bytes)", skillPath, Buffer.byteLength(SKILL_MD_CONTENT, "utf-8"));
  return skillPath;
}

/**
 * Pre-generate compact summaries for every skill file on disk.
 *
 * Discovers all skill SKILL.md files under claude_skills_dir() and
 * claude_plugins_dir() (marketplace layout). For each skill without an
 * up-to-date compact in any session, generates one synchronously and stores it
 * under the _install pseudo-session ID. After the run, writes a sentinel file.
 *
 * Returns a human-readable summary string for the install result dict.
 */
export function pregen_skill_compacts(): string {
  const skillsRoot = paths.claudeSkillsDir();
  const pluginsRoot = paths.claudePluginsDir();

  // Collect (skill_name, skill_path) pairs.
  const skillFiles: Array<[string, string]> = [];

  // User-installed skills: ~/.claude/skills/<name>/SKILL.md
  if (_isDir(skillsRoot)) {
    for (const skillDirEntry of _iterdir(skillsRoot)) {
      if (!_isDir(skillDirEntry)) {
        continue;
      }
      const skillName = nodePath.basename(skillDirEntry);
      for (const candidate of [
        nodePath.join(skillDirEntry, "SKILL.md"),
        nodePath.join(skillDirEntry, `${skillName}.md`),
        nodePath.join(skillDirEntry, skillName, "SKILL.md"),
      ]) {
        if (_isFile(candidate)) {
          skillFiles.push([skillName, candidate]);
          break;
        }
      }
    }
  }

  // Plugin-installed skills: marketplace layout
  // ~/.claude/plugins/cache/<marketplace>/<plugin>/<version>/skills/<name>/SKILL.md
  const pluginsCache = nodePath.join(pluginsRoot, "cache");
  if (_isDir(pluginsCache)) {
    try {
      for (const mkt of _iterdir(pluginsCache)) {
        if (!_isDir(mkt)) {
          continue;
        }
        for (const pluginDirEntry of _iterdir(mkt)) {
          if (!_isDir(pluginDirEntry)) {
            continue;
          }
          const pluginName = nodePath.basename(pluginDirEntry);
          let versions: string[];
          try {
            versions = _iterdir(pluginDirEntry)
              .filter((v) => _isDir(v))
              .sort()
              .reverse();
          } catch {
            continue;
          }
          for (const ver of versions) {
            const verSkills = nodePath.join(ver, "skills");
            if (!_isDir(verSkills)) {
              continue;
            }
            for (const skillEntry of _iterdir(verSkills)) {
              if (!_isDir(skillEntry)) {
                continue;
              }
              const sname = nodePath.basename(skillEntry);
              const namespaced = `${pluginName}:${sname}`;
              for (const candidate of [
                nodePath.join(skillEntry, "SKILL.md"),
                nodePath.join(skillEntry, `${sname}.md`),
              ]) {
                if (_isFile(candidate)) {
                  skillFiles.push([namespaced, candidate]);
                  break;
                }
              }
            }
            break; // use newest version only
          }
        }
      }
    } catch {
      // pass
    }
  }

  let generated = 0;
  let skipped = 0;
  let failed = 0;
  const sessionId = "_install";

  for (const [skillName, skillPath] of skillFiles) {
    try {
      const body = _readTextReplace(skillPath);
      const bodySha = skill_cache.content_hash(body);

      // Check if a fresh compact already exists (any session).
      const existing = skill_cache.get_compact_any_session(skillName);
      if (existing) {
        const compactSha = skill_cache.extract_compact_source_sha(existing);
        if (compactSha !== null && bodySha.startsWith(compactSha)) {
          skipped += 1;
          continue;
        }
      }

      // Generate and store the compact.
      const compact = skill_cache.generate_compact_summary(body);
      skill_cache.store_compact(sessionId, skillName, compact, bodySha);
      generated += 1;
    } catch (exc) {
      _LOG.warning("pregen_skill_compacts: failed for %s: %s", skillName, exc);
      failed += 1;
    }
  }

  // Write sentinel so doctor can detect newly installed skills.
  try {
    const sentinelPath = paths.skillPregenSentinelPath();
    fs.mkdirSync(nodePath.dirname(sentinelPath), { recursive: true });
    const sentinelData = JSON.stringify({
      ts: Date.now() / 1000,
      skill_count: skillFiles.length,
      compact_count: generated + skipped,
    });
    paths.atomicWriteText(sentinelPath, sentinelData);
  } catch (exc) {
    _LOG.warning("pregen_skill_compacts: sentinel write failed: %s", exc);
  }

  const parts = [`${generated} generated`];
  if (skipped) {
    parts.push(`${skipped} up-to-date`);
  }
  if (failed) {
    parts.push(`${failed} failed`);
  }
  const total = skillFiles.length;
  return `${total} skills found — ` + parts.join(", ");
}

/** Remove the token-goat skill from the Claude Code skills directory. */
export function remove_skill(): string {
  const sd = skill_dir();
  if (fs.existsSync(sd)) {
    fs.rmSync(sd, { recursive: true, force: true });
    return sd;
  }
  return "skill dir not found";
}

// Small filesystem helpers mirroring Path.is_dir / Path.is_file / Path.iterdir
// and Path.read_text(errors="replace").

function _isDir(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

function _isFile(p: string): boolean {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

function _iterdir(p: string): string[] {
  return fs.readdirSync(p).map((name) => nodePath.join(p, name));
}

/** Path.read_text(encoding="utf-8", errors="replace") — invalid bytes -> U+FFFD. */
function _readTextReplace(p: string): string {
  const buf = fs.readFileSync(p);
  return new TextDecoder("utf-8", { fatal: false }).decode(buf);
}

// ---------------------------------------------------------------------------
// Codex integration
// ---------------------------------------------------------------------------

/** Return ~/.codex/ */
export function codex_dir(): string {
  return nodePath.join(_home(), ".codex");
}

/** Return the path to ~/.codex/config.toml where Codex hooks are configured. */
export function codex_config_path(): string {
  return nodePath.join(codex_dir(), "config.toml");
}

/** Return the path to ~/.codex/AGENTS.md where Codex agents are configured. */
export function codex_agents_path(): string {
  return nodePath.join(codex_dir(), "AGENTS.md");
}

/**
 * The hooks structure for Codex's config.toml.
 *
 * Derived from hook_registry.HOOK_EVENTS. The `binary` parameter is kept for
 * backwards compatibility but unused.
 */
export function _codex_hooks_block(_binary?: string | null): Record<string, _HookMatcherEntry[]> {
  return _build_hooks_block((...sub: string[]) => paths.pythonRunnerCommand(...sub), true);
}

/** Merge token-goat hooks into ~/.codex/config.toml idempotently. */
export function patch_codex_config(binary: string): string {
  const cfgPath = codex_config_path();
  paths.ensureDir(nodePath.dirname(cfgPath));

  const existing: Record<string, unknown> = fs.existsSync(cfgPath)
    ? (tomlParse(fs.readFileSync(cfgPath, "utf-8")) as Record<string, unknown>)
    : {};

  const ourHooks = _codex_hooks_block(binary);
  const rawExistingHooks = existing["hooks"] ?? {};
  const existingHooks: Record<string, unknown> = _isPlainObject(rawExistingHooks)
    ? rawExistingHooks
    : {};
  _merge_token_goat_hooks(existingHooks, ourHooks);
  existing["hooks"] = existingHooks;

  // Atomic write: a crash mid-write must never leave a truncated config.toml.
  paths.atomicWriteText(cfgPath, tomlStringify(existing));
  return cfgPath;
}

/** Remove token-goat entries from ~/.codex/config.toml. */
export function unpatch_codex_config(): string {
  const cfgPath = codex_config_path();
  if (!fs.existsSync(cfgPath)) {
    return "codex config not found";
  }

  const existing = tomlParse(fs.readFileSync(cfgPath, "utf-8")) as Record<string, unknown>;
  const rawHooks = existing["hooks"] ?? {};
  const hooks: Record<string, unknown> = _isPlainObject(rawHooks) ? rawHooks : {};
  _strip_token_goat_hooks(hooks);
  existing["hooks"] = hooks;

  paths.atomicWriteText(cfgPath, tomlStringify(existing));
  return cfgPath;
}

export const CODEX_AGENTS_MD_CONTENT =
  "## token-goat - route code reads through token-goat first (Codex)\n" +
  "\n" +
  "token-goat is installed. Before you run `rg`, `grep`, `cat`, `head`, `bat`," +
  " `Get-Content`, or any Bash read of a source file, check whether a token-goat command" +
  " does the same job for a fraction of the tokens. Route through token-goat by default." +
  " Skipping it burns context you will need later in the session.\n" +
  "\n" +
  _render_routing_table(_codex_routing_rows(), true) +
  "\n" +
  "\n" +
  "Modifiers: `symbol --all-projects` (cross-repo), `--strict` (disable close-match redirect)," +
  " `map --compact` (300-token budget), `semantic --max-distance 1.0` / `--no-rerank`" +
  " (widen/tighten), `bash-output --grep PATTERN` / `web-output --grep PATTERN` (filter cached" +
  " output), `bash-output --section HEADING` / `web-output --section HEADING` (extract a" +
  " markdown section from cached output), `changed --symbol` (tree-sitter symbol names instead" +
  " of git hunk context), `refs --callers` (resolve enclosing function name for each reference)," +
  " `symbol --context N` (show N lines of surrounding context per symbol), `outline --min-lines N`" +
  " (only show symbols whose body is ≥ N lines)." +
  " A miss prints \"Did you mean...?\" suggestions; a unique high-confidence match redirects" +
  " transparently with a `(redirected from: ...)` marker. Pre-Bash, pre-Grep, and pre-WebFetch" +
  " hooks hint when a tool call is about to repeat.\n" +
  "\n" +
  "Plain Bash reads are the right call when:\n" +
  "- The file is under about 200 lines and you need the whole thing.\n" +
  "- The file has never been indexed (new path, scratch script, untracked draft).\n" +
  "- You need exact bytes to build an `apply_patch` hunk that must match the file verbatim.\n" +
  "\n" +
  "Verify the habit. Run `token-goat stats` and watch event counts climb. Flat counts" +
  " during code work mean you are reaching for `rg` or `cat` where a token-goat command" +
  " would apply.\n";

/** Append/replace the delimited token-goat block in ~/.codex/AGENTS.md. */
export function patch_codex_agents_md(): string {
  const mdPath = codex_agents_path();
  if (_strip_legacy_block(mdPath, LEGACY_CODEX_AGENTS_BEGIN, LEGACY_CODEX_AGENTS_END)) {
    _LOG.info("patch_codex_agents_md: stripped legacy tokenwise-codex block from %s", mdPath);
  }
  return _patch_md_block(mdPath, CODEX_AGENTS_BEGIN, CODEX_AGENTS_END, CODEX_AGENTS_MD_CONTENT);
}

/** Remove the token-goat block from ~/.codex/AGENTS.md. */
export function unpatch_codex_agents_md(): string {
  return _unpatch_md_block(
    codex_agents_path(),
    CODEX_AGENTS_BEGIN,
    CODEX_AGENTS_END,
    "codex AGENTS.md not found",
  );
}

// ---------------------------------------------------------------------------
// Gemini CLI hook integration
// ---------------------------------------------------------------------------
// Gemini CLI uses ~/.gemini/settings.json (global) or .gemini/settings.json
// (per-project). The hooks format is structurally identical to Claude Code's
// settings.json. Key differences: event names (BeforeTool/AfterTool/
// SessionStart/PreCompress), tool names (run_shell_command, read_file, ...),
// output field (decision: allow/deny + reason). We add a --harness gemini flag
// so the dispatcher can apply format translation.

// Gemini CLI tool name -> token-goat internal tool name.
export const _GEMINI_TOOL_TO_TG: Record<string, string> = {
  run_shell_command: "Bash",
  read_file: "Read",
  read_many_files: "Read",
  list_directory: "Read",
  write_file: "Write",
  replace: "Edit",
  glob: "Glob",
  grep_search: "Grep",
  search_file_content: "Grep", // legacy alias kept by Gemini CLI
  web_search: "WebFetch",
  web_fetch: "WebFetch",
};

// Regex patterns for BeforeTool / AfterTool matchers:
const _GEMINI_READ_MATCHER =
  "run_shell_command|read_file|read_many_files|list_directory|glob|grep_search|search_file_content";
const _GEMINI_EDIT_MATCHER = "write_file|replace";
const _GEMINI_FETCH_MATCHER = "web_search|web_fetch";

/** Return the global Gemini CLI config directory (~/.gemini). */
export function gemini_dir(): string {
  return nodePath.join(_home(), ".gemini");
}

/** Return the path to ~/.gemini/settings.json where Gemini CLI hooks are configured. */
export function gemini_settings_path(): string {
  return nodePath.join(gemini_dir(), "settings.json");
}

/**
 * Build the Gemini CLI settings.json hooks structure.
 *
 * All hook commands get --harness gemini appended so the dispatcher can apply
 * Gemini-specific payload translation.
 */
function _gemini_hooks_block(): Record<string, _HookMatcherEntry[]> {
  const runner = _hook_runner_command;

  const entry = (matcher: string, eventName: string, timeout: number): _HookMatcherEntry => {
    const cmd = runner("hook", eventName, "--harness", "gemini");
    return {
      matcher,
      hooks: [{ type: "command", command: cmd, timeout }],
    };
  };

  return {
    SessionStart: [entry("startup", "session-start", 30000)],
    BeforeTool: [
      entry(_GEMINI_READ_MATCHER, "pre-read", 5000),
      entry(_GEMINI_FETCH_MATCHER, "pre-fetch", 2000),
    ],
    AfterTool: [
      entry(_GEMINI_EDIT_MATCHER, "post-edit", 2000),
      entry(_GEMINI_READ_MATCHER, "post-read", 2000),
      entry("run_shell_command", "post-bash", 3000),
      entry(_GEMINI_FETCH_MATCHER, "post-fetch", 3000),
    ],
    PreCompress: [entry("*", "pre-compact", 5000)],
  };
}

/**
 * Merge token-goat hooks into ~/.gemini/settings.json idempotently.
 *
 * Creates the file with an empty JSON object if it does not exist. Returns the
 * path of the settings file written.
 */
export function patch_gemini_settings(): string {
  const settingsPath = gemini_settings_path();
  paths.ensureDir(nodePath.dirname(settingsPath));

  let existing: Record<string, unknown> = {};
  if (fs.existsSync(settingsPath)) {
    try {
      const raw = fs.readFileSync(settingsPath, "utf-8");
      const parsed = JSON.parse(raw);
      if (_isPlainObject(parsed)) {
        existing = parsed;
      }
    } catch (e) {
      _LOG.warning("gemini settings.json read failed, starting fresh: %s", (e as Error).message ?? e);
    }
  }

  const ourHooks = _gemini_hooks_block();
  const existingHooksRaw = existing["hooks"] ?? {};
  const existingHooks: Record<string, unknown> = _isPlainObject(existingHooksRaw)
    ? existingHooksRaw
    : {};
  _merge_token_goat_hooks(existingHooks, ourHooks);
  existing["hooks"] = existingHooks;

  paths.atomicWriteText(settingsPath, JSON.stringify(existing, null, 2));
  _LOG.info("gemini settings.json written: %s", settingsPath);
  return settingsPath;
}

/** Remove token-goat entries from ~/.gemini/settings.json. Returns a status string. */
export function unpatch_gemini_settings(): string {
  const settingsPath = gemini_settings_path();
  if (!fs.existsSync(settingsPath)) {
    return "gemini settings.json not found";
  }

  let data: unknown;
  try {
    const raw = fs.readFileSync(settingsPath, "utf-8");
    data = JSON.parse(raw);
  } catch (e) {
    return `error reading gemini settings.json: ${(e as Error).message ?? e}`;
  }

  if (!_isPlainObject(data)) {
    return "gemini settings.json is not a JSON object; skipped";
  }

  const hooksRaw = data["hooks"] ?? {};
  const hooks: Record<string, unknown> = _isPlainObject(hooksRaw) ? hooksRaw : {};
  _strip_token_goat_hooks(hooks);
  data["hooks"] = hooks;
  paths.atomicWriteText(settingsPath, JSON.stringify(data, null, 2));
  return settingsPath;
}

/** Return 'installed' if ~/.gemini/settings.json has token-goat hooks. */
export function _check_gemini_settings(): string {
  const settingsPath = gemini_settings_path();
  if (!fs.existsSync(settingsPath)) {
    return "not installed (gemini settings.json absent)";
  }
  let data: unknown;
  try {
    const raw = fs.readFileSync(settingsPath, "utf-8");
    data = JSON.parse(raw);
  } catch {
    return "error (gemini settings.json malformed)";
  }
  if (!_isPlainObject(data)) {
    return "error (gemini settings.json not a JSON object)";
  }
  const hooksRaw = data["hooks"] ?? {};
  const hooks: Record<string, unknown> = _isPlainObject(hooksRaw) ? hooksRaw : {};
  return _hooks_contain_token_goat(hooks) ? "installed" : "not installed";
}

// ---------------------------------------------------------------------------
// Integration status check
// ---------------------------------------------------------------------------

/**
 * Return True if any hook entry in *hooks* has a command containing 'token_goat'.
 *
 * *hooks* maps event names to lists of matcher/hook-list entries.
 */
function _hooks_contain_token_goat(hooks: Record<string, unknown>): boolean {
  for (const entries of Object.values(hooks)) {
    const entryList = Array.isArray(entries) ? entries : [];
    for (const entry of entryList) {
      if (!_isPlainObject(entry)) {
        continue;
      }
      const hookArr = entry["hooks"];
      for (const h of Array.isArray(hookArr) ? hookArr : []) {
        if (_isPlainObject(h) && _is_token_goat_hook(String(h["command"] ?? ""))) {
          return true;
        }
      }
    }
  }
  return false;
}

/** Return 'installed' if settings.json has token-goat hooks, otherwise 'not installed'. */
export function _check_settings_json(): string {
  const settingsPath = claude_settings_path();
  if (!fs.existsSync(settingsPath)) {
    return "not installed (settings.json absent)";
  }
  let data: Record<string, unknown>;
  try {
    data = _read_settings_json(settingsPath) ?? {};
  } catch (e) {
    if (_isJSONDecodeError(e)) {
      return "error (settings.json malformed)";
    }
    throw e;
  }
  const rawHooks = data["hooks"] ?? {};
  const hooks: Record<string, unknown> = _isPlainObject(rawHooks) ? rawHooks : {};
  return _hooks_contain_token_goat(hooks) ? "installed" : "not installed";
}

/** Return 'installed' if CLAUDE.md contains the token-goat block. */
export function _check_claude_md(): string {
  const mdPath = claude_md_path();
  if (!fs.existsSync(mdPath)) {
    return "not installed (CLAUDE.md absent)";
  }
  const content = fs.readFileSync(mdPath, "utf-8");
  if (content.includes(CLAUDE_MD_BEGIN)) {
    return "installed";
  }
  return "not installed";
}

/** Return 'installed' if the skill directory and SKILL.md exist. */
export function _check_skill(): string {
  const skillPath = nodePath.join(skill_dir(), "SKILL.md");
  if (fs.existsSync(skillPath)) {
    return "installed";
  }
  return "not installed";
}

/**
 * Return True/False if the HKCU Run key can be read, null on error.
 *
 * Returns null when the registry is inaccessible (non-Windows, permission
 * error, no backend) so callers can distinguish "absent" from "unreadable".
 */
function _winreg_run_value_exists(valueName: string): boolean | null {
  if (!_isWin32()) {
    // winreg is only available on Windows; elsewhere return null (unreadable).
    return null;
  }
  const reg = _winreg();
  if (!reg) {
    return null;
  }
  try {
    return reg.readRunValue(valueName) !== null;
  } catch {
    return null;
  }
}

/** Return 'installed' if the HKCU Run key for the worker exists. */
export function _check_worker_task(): string {
  if (!_isWin32()) {
    return "n/a (non-Windows)";
  }
  const result = _winreg_run_value_exists(TASK_WORKER);
  if (result === true) {
    return "installed";
  }
  if (result === false) {
    return "not installed";
  }
  return "error reading HKCU\\Run";
}

/** Return 'installed' if the weekly auto-update scheduled task exists. */
function _check_update_task(): string {
  return task_exists(TASK_UPDATE) ? "installed" : "not installed";
}

/** Return 'installed' if ~/.codex/config.toml has token-goat hooks. */
export function _check_codex_config(): string {
  const cfgPath = codex_config_path();
  if (!fs.existsSync(cfgPath)) {
    return "not installed (codex config absent)";
  }
  let data: Record<string, unknown>;
  try {
    data = tomlParse(fs.readFileSync(cfgPath, "utf-8")) as Record<string, unknown>;
  } catch (e) {
    if (e instanceof TomlError) {
      return `error (codex config malformed: ${cfgPath})`;
    }
    return `error reading codex config (${cfgPath}): ${(e as Error).message ?? e}`;
  }
  const rawHooks = data["hooks"] ?? {};
  const hooks: Record<string, unknown> = _isPlainObject(rawHooks) ? rawHooks : {};
  return _hooks_contain_token_goat(hooks) ? "installed" : "not installed";
}

/** Return True if aider is installed on this machine (binary on PATH). */
export function detect_aider(): boolean {
  if (which("aider")) {
    return true;
  }
  // Python also checks importlib.util.find_spec("aider"); there is no Python
  // package import in the JS runtime, so the PATH probe is the only signal.
  return false;
}

/** Return True if Cline (AI coding extension CLI) is on PATH. */
export function detect_cline(): boolean {
  if (which("cline") || which("claude-dev")) {
    return true;
  }
  // Python also probes importlib.util.find_spec("cline"); no JS equivalent.
  return false;
}

/** Return True if Windsurf (Codeium AI editor) is on PATH or its config dir exists. */
export function detect_windsurf(): boolean {
  if (which("windsurf")) {
    return true;
  }
  // Windsurf stores its config/extensions in ~/.windsurf or AppData/Roaming/Windsurf.
  if (fs.existsSync(nodePath.join(_home(), ".windsurf"))) {
    return true;
  }
  if (_isWin32()) {
    const appdata = process.env["APPDATA"] ?? "";
    if (appdata && fs.existsSync(nodePath.join(appdata, "Windsurf"))) {
      return true;
    }
  }
  return false;
}

/** Return True if the standalone GitHub Copilot CLI binary is on PATH. */
export function detect_copilot_cli(): boolean {
  return Boolean(which("copilot") || which("github-copilot-cli"));
}

/**
 * Return a dict of harness name -> bool indicating presence on this machine.
 *
 * Detection is purely heuristic — a harness is "detected" when one of its
 * well-known environment variables or directories is present.
 */
export function detect_installed_harnesses(): Record<string, boolean> {
  const result: Record<string, boolean> = {};

  // Claude Code: always present (token-goat only makes sense inside Claude Code).
  result["claude"] = true;

  // Aider
  result["aider"] = detect_aider();

  // Codex: env var takes precedence; fall back to directory probe.
  const codexHomeEnv = process.env["CODEX_HOME"] ?? "";
  const codexDirExists = fs.existsSync(codex_dir());
  result["codex"] = Boolean(codexHomeEnv || codexDirExists);

  // Gemini CLI: stores config/settings in ~/.gemini/
  result["gemini"] = fs.existsSync(nodePath.join(_home(), ".gemini"));

  // opencode and openclaw: check with error handling
  try {
    result["opencode"] = fs.existsSync(nodePath.dirname(bridges.opencode_plugins_dir()));
    result["openclaw"] = fs.existsSync(nodePath.join(_home(), ".openclaw"));
    result["pi"] = fs.existsSync(nodePath.join(_home(), ".pi"));
  } catch {
    result["opencode"] = false;
    result["openclaw"] = false;
    result["pi"] = false;
  }

  // Other harnesses
  result["cline"] = detect_cline();
  result["windsurf"] = detect_windsurf();
  result["copilot-cli"] = detect_copilot_cli();

  return result;
}

/**
 * Return a list of harness names that appear to be present on this machine.
 *
 * Claude Code first (always present), then others alphabetically. Kept for
 * backward compatibility; prefer detect_installed_harnesses().
 */
export function detect_harnesses(): string[] {
  const harnessesDict = detect_installed_harnesses();
  const found: string[] = ["claude"]; // always first
  for (const name of Object.keys(harnessesDict).sort()) {
    if (name !== "claude" && harnessesDict[name]) {
      found.push(name);
    }
  }
  return found;
}

/** Return a dict of integration name -> status string for display before install/uninstall. */
export function check_status(): Record<string, string> {
  const status: Record<string, string> = {
    "Claude Code hooks (settings.json)": _check_settings_json(),
    "CLAUDE.md block": _check_claude_md(),
    "skill (SKILL.md)": _check_skill(),
  };
  if (_isWin32()) {
    status["worker autostart (HKCU Run)"] = _check_worker_task();
    status["update task (schtasks)"] = _check_update_task();
  } else if (_isDarwin()) {
    status["worker autostart (LaunchAgent)"] = _check_mac_autostart();
    status["update cron"] = _check_linux_update_cron();
  } else {
    status["worker autostart"] = _check_linux_autostart();
    status["update cron"] = _check_linux_update_cron();
  }
  status["Codex hooks (config.toml)"] = _check_codex_config();
  status["Gemini CLI hooks (settings.json)"] = _check_gemini_settings();
  status["opencode plugin"] = bridges._check_opencode_plugin();
  status["openclaw plugin"] = bridges._check_openclaw_plugin();
  status["pi plugin"] = bridges._check_pi_plugin();
  return status;
}

// ---------------------------------------------------------------------------
// Platform autostart helpers (shared by install_all / uninstall_all)
// ---------------------------------------------------------------------------

/**
 * Install platform-appropriate worker autostart and update schedule.
 *
 * Mutates *result* in-place with the step keys and formatted outcome strings.
 */
function _install_platform_autostart(result: Record<string, string>): void {
  _LOG.debug("_install_platform_autostart: platform=%s", _PLATFORM);
  if (_isWin32()) {
    const [workerOk, workerOut] = install_worker_task();
    result["task: worker"] = _ok_fail(workerOk, workerOut);
    const [updateOk, updateOut] = install_update_task();
    result["task: update"] = _ok_fail(updateOk, updateOut);
  } else if (_isDarwin()) {
    const [workerOk, workerOut] = install_mac_autostart();
    result["autostart: worker"] = _ok_fail(workerOk, workerOut);
    const [cronOk, cronOut] = install_linux_update_cron();
    result["cron: update"] = _ok_fail(cronOk, cronOut);
  } else {
    const [workerOk, workerOut] = install_linux_autostart();
    result["autostart: worker"] = _ok_fail(workerOk, workerOut);
    const [cronOk, cronOut] = install_linux_update_cron();
    result["cron: update"] = _ok_fail(cronOk, cronOut);
  }
}

/**
 * Remove platform-appropriate worker autostart and update schedule.
 *
 * Mutates *result* in-place. Mirror of _install_platform_autostart.
 */
function _uninstall_platform_autostart(result: Record<string, string>): void {
  _LOG.debug("_uninstall_platform_autostart: platform=%s", _PLATFORM);
  if (_isWin32()) {
    const removedTasks = uninstall_tasks();
    result["tasks"] = `removed: ${_pyList(removedTasks)}`;
  } else if (_isDarwin()) {
    const removedMac = uninstall_mac_autostart();
    result["autostart"] = removedMac.length > 0 ? `removed: ${_pyList(removedMac)}` : "none found";
    result["cron"] = uninstall_linux_update_cron();
  } else {
    const removedLinux = uninstall_linux_autostart();
    result["autostart"] =
      removedLinux.length > 0 ? `removed: ${_pyList(removedLinux)}` : "none found";
    result["cron"] = uninstall_linux_update_cron();
  }
}

/**
 * Render a list the way Python's f"{list}" does: ['a', 'b'] (single quotes).
 * Used only for the human-readable "removed: [...]" result strings so the
 * uninstall output matches the Python original.
 */
function _pyList(items: string[]): string {
  return "[" + items.map((s) => `'${s.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`).join(", ") + "]";
}

// ---------------------------------------------------------------------------
// Plan / verify (dry-run preview + post-install self-check)
// ---------------------------------------------------------------------------

/**
 * One row of an install plan: a file or registry artefact that *would* change.
 *
 * Fields: component, target, action, detail.
 */
export interface _PlanEntry {
  component: string;
  target: string;
  action: string;
  detail: string;
}

/**
 * Return the number of token-goat hook entries in a hooks dict.
 *
 * Structure is {event: [{matcher, hooks: [{command, ...}]}, ...], ...} which is
 * identical between Claude's settings.json and Codex's config.toml.
 */
function _count_token_goat_hooks(hooks: Record<string, unknown>): number {
  let count = 0;
  for (const entries of Object.values(hooks)) {
    const entryList = Array.isArray(entries) ? entries : [];
    for (const entry of entryList) {
      if (!_isPlainObject(entry)) {
        continue;
      }
      const hookArr = entry["hooks"];
      for (const h of Array.isArray(hookArr) ? hookArr : []) {
        if (_isPlainObject(h) && _is_managed_hook(String(h["command"] ?? ""))) {
          count += 1;
        }
      }
    }
  }
  return count;
}

/** Return the number of token-goat hook entries currently in settings.json. */
export function _settings_json_token_goat_count(): number {
  const settingsPath = claude_settings_path();
  if (!fs.existsSync(settingsPath)) {
    return 0;
  }
  let data: Record<string, unknown>;
  try {
    data = _read_settings_json(settingsPath) ?? {};
  } catch {
    return 0;
  }
  const rawHooks = data["hooks"] ?? {};
  const hooks: Record<string, unknown> = _isPlainObject(rawHooks) ? rawHooks : {};
  return _count_token_goat_hooks(hooks);
}

/** Return the number of token-goat hook entries currently in codex config.toml. */
export function _codex_config_token_goat_count(): number {
  const cfgPath = codex_config_path();
  if (!fs.existsSync(cfgPath)) {
    return 0;
  }
  let data: Record<string, unknown>;
  try {
    data = tomlParse(fs.readFileSync(cfgPath, "utf-8")) as Record<string, unknown>;
  } catch {
    return 0;
  }
  const rawHooks = data["hooks"] ?? {};
  const hooks: Record<string, unknown> = _isPlainObject(rawHooks) ? rawHooks : {};
  return _count_token_goat_hooks(hooks);
}

/**
 * Return what install_all *would* do, without making any changes.
 *
 * Read-only: must never write to disk, registry, schtasks, launchctl, systemd,
 * or crontab. *targets* overrides booleans when provided.
 */
export function plan_install(
  install_codex = false,
  install_opencode = false,
  install_openclaw = false,
  install_pi = false,
  targets: Set<string> | null = null,
): _PlanEntry[] {
  let install_gemini = false;
  if (targets !== null) {
    const effective = !targets.has("all")
      ? targets
      : new Set(["claude", "codex", "gemini", "opencode", "openclaw", "pi"]);
    install_codex = effective.has("codex");
    install_gemini = effective.has("gemini");
    install_opencode = effective.has("opencode");
    install_openclaw = effective.has("openclaw");
    install_pi = effective.has("pi");
  }
  const plan: _PlanEntry[] = [];

  // 1. settings.json
  const settingsPath = claude_settings_path();
  {
    let action: string;
    let detail: string;
    if (fs.existsSync(settingsPath)) {
      const existingCount = _settings_json_token_goat_count();
      action = existingCount ? "update" : "create";
      detail = existingCount
        ? `would replace ${existingCount} existing token-goat hook entries`
        : "would add token-goat hooks block (preserving other hooks)";
    } else {
      action = "create";
      detail = "file does not exist; would create with token-goat hooks";
    }
    plan.push({ component: "settings.json", target: settingsPath, action, detail });
  }

  // 2. CLAUDE.md (Python: try: read; except OSError: error-row; else: read-row)
  const mdPath = claude_md_path();
  if (fs.existsSync(mdPath)) {
    let mdText: string | null = null;
    try {
      mdText = fs.readFileSync(mdPath, "utf-8");
    } catch (e) {
      plan.push({
        component: "CLAUDE.md",
        target: mdPath,
        action: "error",
        detail: `unreadable: ${(e as Error).message ?? e}`,
      });
    }
    if (mdText !== null) {
      const hasBlock = mdText.includes(CLAUDE_MD_BEGIN) && mdText.includes(CLAUDE_MD_END);
      // Python intentionally yields "update" on both branches here.
      plan.push({
        component: "CLAUDE.md",
        target: mdPath,
        action: hasBlock ? "update" : "update",
        detail: hasBlock ? "would replace existing delimited block" : "would append delimited block",
      });
    }
  } else {
    plan.push({
      component: "CLAUDE.md",
      target: mdPath,
      action: "create",
      detail: "file does not exist; would create with delimited block",
    });
  }

  // 3. skill
  const skillMd = nodePath.join(skill_dir(), "SKILL.md");
  plan.push({
    component: "skill",
    target: skillMd,
    action: fs.existsSync(skillMd) ? "update" : "create",
    detail: "SKILL.md written under ~/.claude/skills/token-goat/",
  });

  // 4. platform autostart
  if (_isWin32()) {
    const runPresent = _winreg_run_value_exists(TASK_WORKER);
    plan.push({
      component: "worker autostart",
      target: String.raw`HKCU\Software\Microsoft\Windows\CurrentVersion\Run\\` + TASK_WORKER,
      action: runPresent ? "update" : "create",
      detail: "HKCU Run registry key (no admin required)",
    });
    plan.push({
      component: "update task",
      target: `schtasks: ${TASK_UPDATE}`,
      action: task_exists(TASK_UPDATE) ? "update" : "create",
      detail: "weekly Sunday 03:00 schtasks job",
    });
  } else if (_isDarwin()) {
    const plist = _launchd_plist_path();
    plan.push({
      component: "worker autostart",
      target: plist,
      action: fs.existsSync(plist) ? "update" : "create",
      detail: "LaunchAgent plist (user scope, RunAtLoad)",
    });
    plan.push({
      component: "update cron",
      target: "crontab (current user)",
      action: _check_linux_update_cron().includes(CRON_JOB_MARKER) ? "update" : "create",
      detail: "weekly Sunday 03:00 cron entry",
    });
  } else {
    let mechanism: string;
    let target: string;
    let exists: boolean;
    if (_systemd_user_available()) {
      const svc = _systemd_service_path();
      mechanism = "systemd --user service";
      target = svc;
      exists = fs.existsSync(svc);
    } else {
      const desktop = _xdg_autostart_path();
      mechanism = "XDG autostart .desktop (systemd --user unavailable)";
      target = desktop;
      exists = fs.existsSync(desktop);
    }
    plan.push({
      component: "worker autostart",
      target,
      action: exists ? "update" : "create",
      detail: mechanism,
    });
    plan.push({
      component: "update cron",
      target: "crontab (current user)",
      action: _check_linux_update_cron().includes("installed") ? "update" : "create",
      detail: "weekly Sunday 03:00 cron entry",
    });
  }

  // 5. optional codex
  if (install_codex) {
    plan.push({
      component: "codex: config.toml",
      target: codex_config_path(),
      action: fs.existsSync(codex_config_path()) ? "update" : "create",
      detail: "merge token-goat hooks into [hooks]",
    });
    plan.push({
      component: "codex: AGENTS.md",
      target: codex_agents_path(),
      action: fs.existsSync(codex_agents_path()) ? "update" : "create",
      detail: "append/replace delimited block",
    });
  }

  // 6. optional gemini — BeforeTool/AfterTool/SessionStart/PreCompress hooks
  if (install_gemini) {
    const gsPath = gemini_settings_path();
    let action: string;
    let detail: string;
    if (fs.existsSync(gsPath)) {
      try {
        const gsRaw = fs.readFileSync(gsPath, "utf-8");
        const gsData = JSON.parse(gsRaw) as Record<string, unknown>;
        const rawHooks = gsData["hooks"] ?? {};
        const hooksObj: Record<string, unknown> = _isPlainObject(rawHooks) ? rawHooks : {};
        let existingCount = 0;
        for (const entries of Object.values(hooksObj)) {
          if (!Array.isArray(entries)) {
            continue;
          }
          for (const e of entries) {
            const hookArr = _isPlainObject(e) ? e["hooks"] : [];
            for (const h of Array.isArray(hookArr) ? hookArr : []) {
              if (_isPlainObject(h) && _is_managed_hook(String(h["command"] ?? ""))) {
                existingCount += 1;
              }
            }
          }
        }
        action = existingCount ? "update" : "create";
        detail = existingCount
          ? `would replace ${existingCount} existing token-goat hook entries`
          : "would add token-goat hooks block (preserving other hooks)";
      } catch {
        action = "update";
        detail = "could not read existing settings; will merge idempotently";
      }
    } else {
      action = "create";
      detail = "file does not exist; would create with token-goat hooks";
    }
    plan.push({ component: "gemini: hooks", target: gsPath, action, detail });
  }

  // 7. optional opencode / openclaw / pi
  if (install_opencode || install_openclaw || install_pi) {
    let bridgesOk = true;
    try {
      // bridges is statically imported; this mirrors the Python try/except that
      // guards a lazy import. Touch a member to surface any load failure.
      void bridges.opencode_plugins_dir;
    } catch (e) {
      plan.push({
        component: "bridges",
        target: "(import failed)",
        action: "error",
        detail: String((e as Error).message ?? e),
      });
      bridgesOk = false;
    }
    if (install_opencode && bridgesOk) {
      plan.push({
        component: "opencode: plugin",
        target: _safeCall(() => (bridges as Record<string, unknown>)["opencode_plugin_path"]),
        action: "create",
        detail: "would write/refresh TS shim",
      });
    }
    if (install_openclaw && bridgesOk) {
      plan.push({
        component: "openclaw: plugin",
        target: _safeCall(() => (bridges as Record<string, unknown>)["openclaw_plugin_path"]),
        action: "create",
        detail: "would write/refresh TS shim",
      });
    }
    if (install_pi && bridgesOk) {
      plan.push({
        component: "pi: extension",
        target: _safeCall(() => bridges.pi_plugin_path()),
        action: "create",
        detail: "would write/refresh TS extension",
      });
    }
  }

  return plan;
}

/**
 * Port of Python's `getattr(bridges, "<name>", lambda: "<unknown>")()`: invoke
 * a possibly-absent bridges accessor, returning "<unknown>" when it is not a
 * callable on the module.
 */
function _safeCall(get: () => unknown): string {
  try {
    const v = get();
    if (typeof v === "function") {
      return String((v as () => unknown)());
    }
    if (typeof v === "string") {
      return v;
    }
    return "<unknown>";
  } catch {
    return "<unknown>";
  }
}

/**
 * Run after install_all to confirm each artefact actually landed.
 *
 * Read-only. Returns structured rows with an ok/missing/error action so callers
 * can detect partial-install scenarios.
 */
export function verify_install(): _PlanEntry[] {
  const report: _PlanEntry[] = [];

  // 1. settings.json
  const settingsPath = claude_settings_path();
  const count = _settings_json_token_goat_count();
  if (!fs.existsSync(settingsPath)) {
    report.push({
      component: "settings.json",
      target: settingsPath,
      action: "missing",
      detail: "settings.json absent after install",
    });
  } else if (count === 0) {
    report.push({
      component: "settings.json",
      target: settingsPath,
      action: "missing",
      detail: "no token-goat hook entries found",
    });
  } else {
    report.push({
      component: "settings.json",
      target: settingsPath,
      action: "ok",
      detail: `${count} token-goat hook entries present`,
    });
  }

  // 2. CLAUDE.md
  const mdPath = claude_md_path();
  if (!fs.existsSync(mdPath)) {
    report.push({
      component: "CLAUDE.md",
      target: mdPath,
      action: "missing",
      detail: "CLAUDE.md absent",
    });
  } else {
    let mdText: string | null = null;
    try {
      mdText = fs.readFileSync(mdPath, "utf-8");
    } catch (e) {
      report.push({
        component: "CLAUDE.md",
        target: mdPath,
        action: "error",
        detail: `unreadable: ${(e as Error).message ?? e}`,
      });
    }
    if (mdText !== null) {
      const hasBlock = mdText.includes(CLAUDE_MD_BEGIN) && mdText.includes(CLAUDE_MD_END);
      report.push({
        component: "CLAUDE.md",
        target: mdPath,
        action: hasBlock ? "ok" : "missing",
        detail: hasBlock ? "delimited block present" : "no token-goat block found",
      });
    }
  }

  // 3. skill
  const skillMd = nodePath.join(skill_dir(), "SKILL.md");
  report.push({
    component: "skill",
    target: skillMd,
    action: fs.existsSync(skillMd) ? "ok" : "missing",
    detail: fs.existsSync(skillMd) ? "SKILL.md present" : "SKILL.md missing",
  });

  // 3b. codex config.toml — only verified when the file exists.
  const codexCfg = codex_config_path();
  if (fs.existsSync(codexCfg)) {
    const codexCount = _codex_config_token_goat_count();
    report.push({
      component: "codex config.toml",
      target: codexCfg,
      action: codexCount > 0 ? "ok" : "missing",
      detail:
        codexCount > 0
          ? `${codexCount} token-goat hook entries present`
          : "no token-goat hook entries found",
    });
  }

  // 4. platform autostart
  if (_isWin32()) {
    const runPresent = _winreg_run_value_exists(TASK_WORKER);
    const action = runPresent === true ? "ok" : runPresent === false ? "missing" : "error";
    report.push({
      component: "worker autostart",
      target: String.raw`HKCU\Run\\` + TASK_WORKER,
      action,
      detail:
        "HKCU Run key " +
        (runPresent === true ? "present" : runPresent === false ? "absent" : "unreadable"),
    });
  } else if (_isDarwin()) {
    const plist = _launchd_plist_path();
    report.push({
      component: "worker autostart",
      target: plist,
      action: fs.existsSync(plist) ? "ok" : "missing",
      detail: "LaunchAgent plist " + (fs.existsSync(plist) ? "present" : "absent"),
    });
  } else {
    const svc = _systemd_service_path();
    const desktop = _xdg_autostart_path();
    if (fs.existsSync(svc)) {
      report.push({
        component: "worker autostart",
        target: svc,
        action: "ok",
        detail: "systemd user service installed",
      });
    } else if (fs.existsSync(desktop)) {
      report.push({
        component: "worker autostart",
        target: desktop,
        action: "ok",
        detail: "XDG autostart installed",
      });
    } else {
      report.push({
        component: "worker autostart",
        target: svc,
        action: "missing",
        detail: "neither systemd unit nor XDG .desktop present",
      });
    }
  }

  return report;
}

// ---------------------------------------------------------------------------
// Top-level install / uninstall
// ---------------------------------------------------------------------------

/**
 * Run the full install. Returns a dict of step -> result string.
 *
 * *targets* is an optional set of tool names (claude, codex, opencode,
 * openclaw, pi, all). When provided it overrides the individual boolean flags.
 */
export function install_all(
  install_codex = false,
  install_opencode = false,
  install_openclaw = false,
  install_pi = false,
  targets: Set<string> | null = null,
): Record<string, string> {
  let install_gemini = false;
  if (targets !== null) {
    const effective = !targets.has("all")
      ? targets
      : new Set(["claude", "codex", "gemini", "opencode", "openclaw", "pi"]);
    install_codex = effective.has("codex");
    install_gemini = effective.has("gemini");
    install_opencode = effective.has("opencode");
    install_openclaw = effective.has("openclaw");
    install_pi = effective.has("pi");
  }
  _LOG.info(
    "install_all: starting (platform=%s codex=%s opencode=%s openclaw=%s pi=%s targets=%s)",
    _PLATFORM,
    install_codex,
    install_opencode,
    install_openclaw,
    install_pi,
    targets,
  );
  paths.ensureDirs();
  const result: Record<string, string> = {};

  // Write the hook wrapper FIRST so patch_settings_json() picks it up.
  try {
    const wrapperPath = _write_hook_wrapper();
    result["hook wrapper"] = _ok_fail(true, wrapperPath);
  } catch (e) {
    result["hook wrapper"] = `FAIL — ${(e as Error).message ?? e}`;
    _LOG.warning("install step: hook wrapper — FAIL: %s", e);
  }

  const [settingsOk, settingsDetail] = patch_settings_json();
  result["settings.json"] = _ok_fail(settingsOk, settingsDetail);
  _LOG.info("install step: settings.json — %s", _ok_fail(settingsOk, settingsDetail));

  const mdOut = patch_claude_md();
  result["CLAUDE.md"] = _ok_fail(true, mdOut);
  _LOG.info("install step: CLAUDE.md — %s", _ok_fail(true, mdOut));

  const skillPath = write_skill();
  result["skill"] = _ok_fail(true, skillPath);
  _LOG.info("install step: skill — %s", _ok_fail(true, skillPath));

  try {
    const pregenResult = pregen_skill_compacts();
    result["skill compact pre-gen"] = _ok_fail(true, pregenResult);
    _LOG.info("install step: skill compact pre-gen — %s", pregenResult);
  } catch (e) {
    result["skill compact pre-gen"] = `FAIL — ${(e as Error).message ?? e}`;
    _LOG.warning("install step: skill compact pre-gen — FAIL: %s", e);
  }

  _install_platform_autostart(result);

  // Spawn the worker right now (fail-soft).
  try {
    const pid = worker.ensure_running();
    const workerStatus = pid ? `spawned, pid=${pid}` : "spawn failed";
    result["worker"] = workerStatus;
    _LOG.info("install step: worker — %s", workerStatus);
  } catch (e) {
    result["worker"] = `FAIL — ${(e as Error).message ?? e}`;
    _LOG.warning("install step: worker — FAIL: %s", e);
  }

  const removedLaunchers = _remove_legacy_launchers();
  result["legacy launchers"] =
    removedLaunchers.length > 0 ? "removed — " + removedLaunchers.join(", ") : "none found";

  if (install_codex) {
    const binary = token_goat_hook_binary();
    _run_step(result, "codex: config.toml", () => patch_codex_config(binary));
    _run_step(result, "codex: AGENTS.md", patch_codex_agents_md);
  }

  if (install_gemini) {
    _run_step(result, "gemini: hooks", patch_gemini_settings);
  }

  if (install_opencode) {
    _run_step(result, "opencode: plugin", bridges.install_opencode_plugin);
  }

  if (install_openclaw) {
    _run_step(result, "openclaw: plugin", bridges.install_openclaw_plugin);
  }

  if (install_pi) {
    _run_step(result, "pi: extension", () => bridges.install_pi_plugin());
  }

  const codecReport = probe_image_codecs();
  result["image codecs"] = codecReport.ok
    ? _ok_fail(true, codecReport.summary)
    : _ok_fail(false, codecReport.summary);
  _LOG.info("install step: image codecs — %s", result["image codecs"]);

  const failures = Object.entries(result)
    .filter(([, v]) => v.startsWith("FAIL"))
    .map(([k]) => k);
  _LOG.info(
    "install_all: complete — %d steps, %d failure(s)%s",
    Object.keys(result).length,
    failures.length,
    failures.length > 0 ? `: ${_pyList(failures)}` : "",
  );
  return result;
}

/** Structured report from probe_image_codecs. */
export interface _ImageCodecReport {
  ok: boolean;
  summary: string;
  missing: string[];
  hint: string;
}

/**
 * Probe image codec availability and return a structured report.
 *
 * Python probes Pillow's WebP/JPEG/PNG (zlib) support. The TS port uses `sharp`
 * (the image backend used throughout the TS port — see image_shrink.ts) to
 * report the same WebP/JPEG/PNG capability matrix and run a tiny WebP encode
 * smoke test. The summary/hint strings are kept parallel to the Python output.
 */
export function probe_image_codecs(): _ImageCodecReport {
  const report: _ImageCodecReport = { ok: false, summary: "", missing: [], hint: "" };

  try {
    const fmt = (sharp as unknown as { format: Record<string, { input?: unknown; output?: unknown }> })
      .format;
    const parts: string[] = [];
    const missing: string[] = [];
    const cap: Array<[string, string]> = [
      ["webp", "WebP"],
      ["jpeg", "JPEG"],
      ["png", "PNG"],
    ];
    for (const [codec, label] of cap) {
      const entry = fmt[codec];
      const ok = Boolean(entry && entry.output);
      if (ok) {
        parts.push(`${label}=ok`);
      } else {
        parts.push(`${label}=MISSING`);
        missing.push(label);
      }
    }
    // WebP encode smoke test (Image.new(...).save(buf, "WEBP") equivalent).
    try {
      // A 4x4 solid RGB buffer encoded to WebP.
      const raw = Buffer.alloc(4 * 4 * 3);
      for (let i = 0; i < raw.length; i += 3) {
        raw[i] = 200;
        raw[i + 1] = 100;
        raw[i + 2] = 50;
      }
      const s = sharp(raw, { raw: { width: 4, height: 4, channels: 3 } });
      // toBuffer is async; we only need the call to succeed synchronously up to
      // the point of pipeline construction. The encode itself runs on toBuffer.
      void s.webp({ quality: 80 });
      parts.push("WebP-encode=ok");
    } catch (exc) {
      parts.push(`WebP-encode=FAIL (${(exc as Error).name})`);
      if (!missing.includes("WebP")) {
        missing.push("WebP");
      }
    }
    const summary = parts.join(", ");
    const ok = missing.length === 0 && !summary.includes("FAIL");
    let hint = "";
    if (!ok) {
      if (_PLATFORM.startsWith("linux")) {
        hint =
          "Install system codecs and reinstall the image backend:\n" +
          "    sudo apt-get install -y libwebp-dev libjpeg-dev zlib1g-dev   # Debian/Ubuntu/WSL\n" +
          "    sudo dnf install -y libwebp-devel libjpeg-turbo-devel zlib-devel  # Fedora/RHEL\n" +
          "    sudo pacman -S libwebp libjpeg-turbo zlib                        # Arch\n" +
          "    sudo apk add libwebp-dev libjpeg-turbo-dev zlib-dev               # Alpine\n" +
          "    npm rebuild sharp";
      } else if (_isDarwin()) {
        hint =
          "Install system codecs and reinstall the image backend:\n" +
          "    brew install webp jpeg-turbo\n" +
          "    npm rebuild sharp";
      } else {
        hint =
          "sharp on Windows ships codecs by default — a missing codec usually means " +
          "sharp itself is broken. Reinstall: npm rebuild sharp";
      }
    }
    report.ok = ok;
    report.summary = summary;
    report.missing = missing;
    report.hint = hint;
  } catch (exc) {
    report.summary = `image backend probe failed — ${(exc as Error).message ?? exc}`;
    report.missing = ["sharp"];
    report.hint = "npm rebuild sharp";
  }
  return report;
}

/** Terminate the background worker if running. Returns a status string. */
function _stop_worker(): string {
  const pidPath = paths.workerPidPath();
  if (!fs.existsSync(pidPath)) {
    return "stopped";
  }
  try {
    const pid = parseInt(fs.readFileSync(pidPath, "utf-8").trim(), 10);
    if (Number.isFinite(pid) && _pidExists(pid)) {
      // process.kill(pid, "SIGTERM") is the psutil.Process(pid).terminate()
      // analogue. Guarded so a permission/ESRCH error is logged, not thrown.
      process.kill(pid, "SIGTERM");
    }
  } catch (e) {
    _LOG.warning("failed to terminate worker process (pid_path=%s): %s", pidPath, e);
  }
  try {
    fs.unlinkSync(pidPath);
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code !== "ENOENT") {
      // missing_ok=True semantics: only ENOENT is swallowed silently.
      _LOG.warning("failed to remove worker pid file %s: %s", pidPath, e);
    }
  }
  return "stopped";
}

/** psutil.pid_exists(pid) — probe whether a PID is live via signal 0. */
function _pidExists(pid: number): boolean {
  if (pid <= 0) {
    return false;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    // EPERM means the process exists but we can't signal it.
    return code === "EPERM";
  }
}

/** Reverse install. With purge=True also deletes the data directory. */
export function uninstall_all(
  purge = false,
  codex = false,
  gemini = false,
  opencode = false,
  openclaw = false,
  pi = false,
): Record<string, string> {
  _LOG.info(
    "uninstall_all: starting (platform=%s purge=%s codex=%s gemini=%s opencode=%s openclaw=%s pi=%s)",
    _PLATFORM,
    purge,
    codex,
    gemini,
    opencode,
    openclaw,
    pi,
  );
  const result: Record<string, string> = {};

  try {
    result["worker"] = _stop_worker();
  } catch (e) {
    result["worker"] = `stop failed: ${(e as Error).message ?? e}`;
  }

  _uninstall_platform_autostart(result);

  result["settings.json"] = _ok_fail(true, `unpatched — ${unpatch_settings_json()}`);
  result["CLAUDE.md"] = _ok_fail(true, `unpatched — ${unpatch_claude_md()}`);
  result["skill"] = _ok_fail(true, `removed — ${remove_skill()}`);
  const removedLaunchers = _remove_legacy_launchers();
  result["legacy launchers"] =
    removedLaunchers.length > 0 ? "removed — " + removedLaunchers.join(", ") : "none found";

  if (purge) {
    const target = paths.dataDir();
    if (fs.existsSync(target)) {
      fs.rmSync(target, { recursive: true, force: true });
      result["data_dir"] = `purged — ${target}`;
    } else {
      result["data_dir"] = "already absent";
    }
  }

  if (codex) {
    result["codex: config.toml"] = unpatch_codex_config();
    result["codex: AGENTS.md"] = unpatch_codex_agents_md();
  }

  if (gemini) {
    result["gemini: hooks"] = _ok_fail(true, `unpatched — ${unpatch_gemini_settings()}`);
  }

  if (opencode) {
    result["opencode: plugin"] = bridges.uninstall_opencode_plugin();
  }

  if (openclaw) {
    result["openclaw: plugin"] = bridges.uninstall_openclaw_plugin();
  }

  if (pi) {
    result["pi: extension"] = bridges.uninstall_pi_plugin();
  }

  const failures = Object.entries(result)
    .filter(([, v]) => v.startsWith("FAIL"))
    .map(([k]) => k);
  _LOG.info(
    "uninstall_all: complete — %d steps, %d failure(s)%s",
    Object.keys(result).length,
    failures.length,
    failures.length > 0 ? `: ${_pyList(failures)}` : "",
  );
  return result;
}

export const __all__: readonly string[] = [
  "claude_dir",
  "claude_settings_path",
  "claude_md_path",
  "skill_dir",
  "token_goat_binary",
  "token_goat_hook_binary",
  "token_goat_worker_binary",
  "task_exists",
  "check_autostart",
  "install_worker_task",
  "install_update_task",
  "uninstall_tasks",
  "install_linux_autostart",
  "uninstall_linux_autostart",
  "install_linux_update_cron",
  "uninstall_linux_update_cron",
  "install_mac_autostart",
  "uninstall_mac_autostart",
  "patch_settings_json",
  "unpatch_settings_json",
  "patch_claude_md",
  "unpatch_claude_md",
  "write_skill",
  "pregen_skill_compacts",
  "remove_skill",
  "codex_dir",
  "codex_config_path",
  "codex_agents_path",
  "patch_codex_config",
  "unpatch_codex_config",
  "patch_codex_agents_md",
  "unpatch_codex_agents_md",
  "gemini_dir",
  "gemini_settings_path",
  "patch_gemini_settings",
  "unpatch_gemini_settings",
  "detect_aider",
  "detect_cline",
  "detect_windsurf",
  "detect_copilot_cli",
  "detect_installed_harnesses",
  "detect_harnesses",
  "_check_settings_json",
  "_check_claude_md",
  "_check_skill",
  "_check_worker_task",
  "_check_codex_config",
  "check_status",
  "plan_install",
  "verify_install",
  "install_all",
  "uninstall_all",
  "probe_image_codecs",
  "CLAUDE_MD_CONTENT",
  "SKILL_MD_CONTENT",
  "CODEX_AGENTS_MD_CONTENT",
];
