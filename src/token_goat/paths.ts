/**
 * Central path resolver for token-goat data directories — TypeScript port of
 * src/token_goat/paths.py.
 *
 * This is the foundational Layer 1 module every other port module imports for
 * data-directory, atomic-write, and path-key normalisation services. Pure,
 * sync, dependency-free except for the shared reset seam (`./reset.js`) and
 * the WSL/backslash normaliser in `./util.js` (mirroring paths.py's lazy
 * `from .util import normalize_path`).
 *
 * Parity notes (Python → TS):
 *  - pathlib.Path → string paths throughout. Python's `Path.is_absolute()`,
 *    `Path.resolve()`, `Path.relative_to()` map to `path.resolve()` /
 *    `path.isAbsolute()` / a `startsWith` containment check. The traversal
 *    guard (resolve candidate, confirm under resolved base) is preserved
 *    verbatim: Python's `relative_to` raises ValueError when the candidate is
 *    not under base; the TS port throws an Error with the same message shape.
 *  - sys.platform == "win32" → process.platform === "win32". The port's
 *    runtime checks key off process.platform exactly as paths.py keys off
 *    sys.platform, so the WSL MAX_PATH guard, the tg-hook.cmd vs tg-hook.sh
 *    branch, and the colon-as-NTFS-ADS guard all fire on Windows test runs.
 *  - _DATA_DIR_CACHE: paths.py computes the default once at import and caches
 *    it. The TS port mirrors this with a module-level `let _dataDirCache`
 *    initialised lazily on first dataDir() call. Lazy compute (not eager at
 *    import) means the override slot is consulted first and the default is
 *    only computed once per cleared cache; clearModuleCaches() (per-test)
 *    drops the cache and the next call observes a fresh platform default —
 *    mirroring conftest.py's monkeypatching of the Python module global.
 *  - configPath override: the prior minimal shim added a test seam
 *    (setConfigPathOverride / clearConfigPathOverride) that paths.py itself
 *    does not have (Python tests monkeypatch the module global directly).
 *    The seam is preserved verbatim because db.ts / config.ts will consume
 *    it once they land, and it is registered for reset so per-test isolation
 *    holds.
 *  - _hooks_stderr_log_override: the TS port adds setHooksStderrLogOverride
 *    (Python has it at paths.py:86) so the isolate_hooks_stderr_log conftest
 *    fixture has a JS analogue. Registered for reset.
 *  - threading.get_ident() / time.monotonic_ns() for tmp names →
 *    `${pid}-${monotonicMs()}-${counter}`. JS is single-threaded in the main
 *    module so pid+counter+timestamp is collision-free across rapid sequential
 *    calls; a worker_thread would carry a distinct pid (forks) or share pid
 *    but be serialized by the single-threaded event loop.
 *  - os.open(O_CREAT, 0o600) → fs.openSync(path, "wx", 0o600) on POSIX
 *    (mode honoured); on Windows Node ignores the mode and the user-profile
 *    ACL provides isolation, matching paths.py's _open_restricted branch.
 *  - os.replace → fs.renameSync (POSIX atomic; Windows overwrites target).
 *    Retry on EPERM/EBUSY/ETXTBSY for Windows file-lock races, mirroring
 *    _rename_with_retry.
 *  - logging.FileHandler / _OwnerOnlyFileHandler → NOT ported. The Python
 *    open_log_file returns a stdlib logging handler; no TS module imports
 *    that symbol yet (the logging layer farms out to console in util.ts
 *    getLogger). openLogFile is included as a stub that throws to surface
 *    the gap loudly; the worker layer will grow a real FileHandler analogue
 *    when it lands.
 *  - hook_wrapper_content: Python resolves token_goat/__init__.py via
 *    importlib.util.find_spec. Node has no equivalent for resolving the
 *    Python module from a JS context, so the JS port emits the *ungated*
 *    wrapper (forward unconditionally) — the Python "sentinel is None"
 *    branch. This is correct for any JS-side install that does not rely on
 *    a Python venv; the Python install path is not affected (the Python
 *    module remains the source of truth for installs that use it).
 *  - shlex.quote → a minimal POSIX single-quote quoter (see posixSingleQuote).
 *    The TS port reimplements the exact same recipe (wrap in single quotes,
 *    escape embedded single quotes as '\'') so test_python_runner_command
 *    _cmd_with_inner_double_quotes round-trips identically.
 *  - exactOptionalPropertyTypes is on → optional parameters are
 *    `T | undefined`, never `T | null`.
 *  - noUncheckedIndexedAccess is on → every `argv[i]` / `s[i]` access is
 *    narrowed before use (see the python_runner_command quoter loop).
 *  - verbatimModuleSyntax is on → type-only imports use `import type`.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  getDataDirOverride,
  registerReset,
} from "./reset.js";
import { normalizePath } from "./util.js";

// ---------------------------------------------------------------------------
// Platform sentinels — centralised so every branch reads the same value.
// ---------------------------------------------------------------------------

const IS_WIN32 = process.platform === "win32";
const IS_DARWIN = process.platform === "darwin";

// Windows MAX_PATH guard (mirrors session_cache_path's 260-char check).
const WIN_MAX_PATH = 260;

// ---------------------------------------------------------------------------
// Size caps for log rollover (verbatim from paths.py:72-80).
// ---------------------------------------------------------------------------

/** Size cap for a structured daily log file (paths.py LOG_FILE_MAX_BYTES). */
export const LOG_FILE_MAX_BYTES = 5_000_000;

/** Size cap for the hooks crash-sink log (paths.py HOOKS_STDERR_LOG_MAX_BYTES). */
export const HOOKS_STDERR_LOG_MAX_BYTES = 1_000_000;

// ---------------------------------------------------------------------------
// hooks-stderr.log override test seam (Python paths.py:83-103).
// ---------------------------------------------------------------------------

let _hooksStderrLogOverride: string | undefined = undefined;

/**
 * Override the hooks-stderr.log path for testing (Python
 * set_hooks_stderr_log_override). Pass an absolute path (typically a tmp dir)
 * to redirect crash-sink writes; pass undefined to restore the default.
 */
export function setHooksStderrLogOverride(p: string | undefined): void {
  _hooksStderrLogOverride = p;
}

/** Path to the hook-process crash sink: logs/hooks-stderr.log. */
export function hooksStderrLogPath(): string {
  if (_hooksStderrLogOverride !== undefined) {
    return _hooksStderrLogOverride;
  }
  return path.join(logsDir(), "hooks-stderr.log");
}

// ---------------------------------------------------------------------------
// WSL detection (Python paths.py:105-121).
// ---------------------------------------------------------------------------

/**
 * Return true when running inside Windows Subsystem for Linux (WSL).
 *
 * WSL processes report process.platform === "linux" but may benefit from
 * Windows-specific guidance. Detection uses the env vars the WSL kernel
 * injector populates: WSL_DISTRO_NAME (WSL 2 + recent WSL 1) and WSL_INTEROP
 * (WSL 2 interop socket). Both are pure env reads — safe on the hot hook path.
 */
export function isWsl(): boolean {
  return Boolean(process.env.WSL_DISTRO_NAME || process.env.WSL_INTEROP);
}

// ---------------------------------------------------------------------------
// python_runner_argv / python_runner_command (Python paths.py:124-169).
// ---------------------------------------------------------------------------
// Python resolves sys.executable + `-m token_goat.cli`. Node has NO `-m
// <module>` flag (a literal `node -m token_goat.cli` throws "node: bad option:
// -m"), so the TS port instead points the interpreter directly at the CLI entry
// FILE. cliEntryPath() resolves that file for both a built/installed
// distribution (compiled main.js beside this module, or a single-file bundle)
// and source/dev under tsx (main.ts). The command-string shape callers parse
// (settings.json hook entries, the launchd plist ProgramArguments) is therefore
// `[node, <entry>]` rather than `[python, -m, token_goat.cli]`.

/**
 * Absolute path to the runnable CLI entry. Resolution order, relative to THIS
 * module's location (works whether tsc-built, esbuild-bundled, or run via tsx):
 *  1. a compiled `main.{js,mjs,cjs}` sibling (the normal built/installed case);
 *  2. a `main.ts` sibling (running from source under tsx);
 *  3. this module's own file (a single-file bundle IS the entry).
 */
export function cliEntryPath(): string {
  const here = fileURLToPath(import.meta.url);
  const dir = path.dirname(here);
  for (const name of ["main.js", "main.mjs", "main.cjs"]) {
    const p = path.join(dir, name);
    if (fs.existsSync(p)) return p;
  }
  const tsEntry = path.join(dir, "main.ts");
  if (fs.existsSync(tsEntry)) return tsEntry;
  return here;
}

/**
 * The interpreter + entry portion of a token-goat invocation, WITHOUT any
 * subcommand: `[process.execPath, cliEntryPath()]`. The node-native replacement
 * for Python's `[sys.executable, "-m", "token_goat.cli"]` — node has no `-m`,
 * so it runs the entry FILE directly.
 *
 * NOTE: persistent invocations (settings.json hook commands, the launchd plist,
 * worker spawn) need a runnable JS entry, i.e. a built/installed distribution
 * (`npm run build` → `dist/token-goat.mjs`, exposed as the `token-goat` bin).
 * When run purely from TypeScript source via `tsx`, cliEntryPath() resolves to
 * `main.ts`, which `node` cannot execute directly — so `install` and the
 * background worker require a build first (interactive `tsx` use is fine).
 */
export function cliRunnerPrefix(): string[] {
  return [process.execPath, cliEntryPath()];
}

/**
 * Argv to invoke token-goat via the current interpreter + CLI entry:
 * [...cliRunnerPrefix(), ...subcommand]. Replaces Python's
 * paths.python_runner_argv (`[sys.executable, "-m", "token_goat.cli", ...]`) —
 * see the note above for why the `-m token_goat.cli` form is not used.
 */
export function pythonRunnerArgv(...subcommand: string[]): string[] {
  return [...cliRunnerPrefix(), ...subcommand];
}

/**
 * Same as pythonRunnerArgv but as a single shell-style command string, for
 * embedding in settings.json / config.toml hook entries.
 *
 * The interpreter path uses forward slashes (Claude Code on Windows runs hook
 * commands through Git Bash, which strips backslashes). Args containing `"`
 * are quoted POSIX single-quote style (shlex.quote equivalent) so an inner
 * double quote does not truncate the arg; args containing spaces but no `"`
 * are wrapped in double quotes.
 */
export function pythonRunnerCommand(...subcommand: string[]): string {
  const prefix = cliRunnerPrefix();
  const argv = [...prefix, ...subcommand];
  // Convert backslashes to forward slashes on the PREFIX (interpreter + entry
  // path — both can be real filesystem paths now). Subcommand args are left
  // verbatim (a `read`/`section` target may legitimately contain separators).
  for (let i = 0; i < prefix.length; i++) {
    argv[i] = argv[i]!.replace(/\\/g, "/");
  }
  // Quote each arg that needs it. Matches paths.py:160-168:
  //   - if the arg contains a double quote, use POSIX single-quote style.
  //   - elif the arg contains a space, wrap in double quotes.
  //   - else leave as-is.
  const quoted: string[] = [];
  for (const a of argv) {
    if (a.includes('"')) {
      quoted.push(posixSingleQuote(a));
    } else if (a.includes(" ")) {
      quoted.push(`"${a}"`);
    } else {
      quoted.push(a);
    }
  }
  return quoted.join(" ");
}

/**
 * POSIX single-quote an arg: wrap in `'...'` and escape every embedded `'` as
 * `'\''` (the standard shlex.quote recipe). Equivalent to Python's
 * shlex.quote for the inputs token-goat produces (no NUL bytes; the shell only
 * sees printable ASCII + whitespace + quotes).
 */
function posixSingleQuote(s: string): string {
  return `'${s.replace(/'/g, `'"'"'`)}'`;
}

// ---------------------------------------------------------------------------
// Data directory resolution (Python paths.py:172-253).
// ---------------------------------------------------------------------------

/**
 * Validate an env-var directory value before using it as a data-dir base
 * (Python _safe_env_dir). Accepts only non-empty absolute paths so a crafted
 * env var (LOCALAPPDATA=../../etc, XDG_DATA_HOME=../../tmp/evil) cannot
 * redirect the data directory to an attacker-controlled location.
 *
 * Returns the stripped path when valid, or undefined to signal that the caller
 * should fall back to the home-based default.
 */
function safeEnvDir(value: string): string | undefined {
  const stripped = value.trim();
  if (stripped.length === 0) return undefined;
  if (!path.isAbsolute(stripped)) {
    // Python logs a warning here; the TS port returns undefined silently. A
    // relative path is rejected silently-by-fallback in either case (caller
    // falls through to the home default).
    return undefined;
  }
  return stripped;
}

/**
 * Compute the platform-appropriate data directory without platformdirs
 * (Python _default_data_dir). Matches platformdirs.user_data_dir("token-goat",
 * "dfk-helper"):
 *   - Windows:  %LOCALAPPDATA%\dfk-helper\token-goat  (or ~\dfk-helper\token-goat)
 *   - Linux:    $XDG_DATA_HOME/token-goat  (or ~/.local/share/token-goat)
 *   - macOS:    ~/Library/Application Support/token-goat
 *
 * Env vars (LOCALAPPDATA, XDG_DATA_HOME) are validated via safeEnvDir before
 * use; a relative/malformed value falls back to the home default.
 */
function defaultDataDir(): string {
  if (IS_WIN32) {
    const raw = process.env.LOCALAPPDATA ?? "";
    const basePath = raw.length > 0 ? safeEnvDir(raw) : undefined;
    if (basePath !== undefined) {
      return path.join(basePath, "dfk-helper", "token-goat");
    }
    return path.join(os.homedir(), "dfk-helper", "token-goat");
  }
  if (IS_DARWIN) {
    return path.join(os.homedir(), "Library", "Application Support", "token-goat");
  }
  // Linux / BSD / WSL — honour XDG_DATA_HOME.
  const xdg = process.env.XDG_DATA_HOME ?? "";
  const baseDir = xdg.length > 0 ? safeEnvDir(xdg) : undefined;
  if (baseDir !== undefined) {
    return path.join(baseDir, "token-goat");
  }
  return path.join(os.homedir(), ".local", "share", "token-goat");
}

/**
 * Module-level cache for the data directory (Python _DATA_DIR_CACHE).
 *
 * Python computes this once at import. The TS port computes lazily on first
 * dataDir() call: clearModuleCaches() (per-test) drops the cache, and the
 * next dataDir() call observes a fresh platform default. dataDir() always
 * consults getDataDirOverride() first; only when the override is undefined
 * does it compute (and cache) the default.
 */
let _dataDirCache: string | undefined = undefined;

/**
 * Get token-goat data directory (Python data_dir).
 *
 * Order: (1) return the per-test override verbatim when set (setDataDirOverride
 * in tests/setup.ts redirects this to a tmp dir); (2) else compute the
 * platform default once and cache it for subsequent calls.
 */
export function dataDir(): string {
  const override = getDataDirOverride();
  if (override !== undefined) {
    return override;
  }
  if (_dataDirCache === undefined) {
    _dataDirCache = defaultDataDir();
  }
  return _dataDirCache;
}

/** Path to global.db. */
export function globalDbPath(): string {
  return path.join(dataDir(), "global.db");
}

// ---------------------------------------------------------------------------
// Child-path safety (Python _safe_child_path / _sanitize_session_id_for_filename).
// ---------------------------------------------------------------------------

/**
 * Return `base / (childName + extension)` after null-byte, colon, UNC, and
 * traversal checks (Python _safe_child_path).
 *
 * Throws Error if childName contains a null byte, contains a colon (Windows
 * only — NTFS Alternate Data Stream guard), begins with a UNC `//` prefix, or
 * resolves to a path outside `base`.
 *
 * The colon guard is applied on win32 only in paths.py; the TS port preserves
 * that platform-conditional behaviour here so internal callers (project_db_path)
 * match Python on POSIX. The public safeJoin wrapper enforces unconditional
 * colon rejection regardless of platform.
 */
export function _safeChildPath(
  base: string,
  childName: string,
  extension: string,
  label: string,
): string {
  if (childName.includes("\x00")) {
    throw new Error(`${label} contains null byte: ${JSON.stringify(childName)}`);
  }
  if (IS_WIN32 && childName.includes(":")) {
    throw new Error(
      `${label} contains colon (would create NTFS Alternate Data Stream on Windows): ${JSON.stringify(childName)}`,
    );
  }
  // Reject UNC-style paths before resolving. On Windows, resolving a UNC path
  // triggers a network lookup and can stall for seconds when the host is
  // unreachable. Check the raw string first.
  const norm = childName.replace(/\\/g, "/");
  if (norm.startsWith("//")) {
    throw new Error(
      `${label} produces a path outside ${path.basename(base)}/: ${JSON.stringify(childName)}`,
    );
  }
  // Replicate Python's `Path(base) / fragment` reset semantic: in pathlib, if
  // the fragment is itself absolute, the join RESETS to the fragment (so
  // `Path("/safe") / "/etc/passwd"` → `/etc/passwd`, escaping base). Node's
  // `path.join` does NOT do this — it concatenates `/etc/passwd` as a segment,
  // leaving the candidate under base. To match the Python traversal guard
  // (which catches the escape via `relative_to`), we detect an absolute
  // fragment (POSIX-rooted `/...` or Windows drive-prefixed `C:\...`) after
  // backslash normalisation and reject it as escaping base. This preserves
  // the observable contract: an absolute fragment can never produce a path
  // inside base.
  if (norm.startsWith("/") || hasWindowsDrivePrefix(norm)) {
    throw new Error(
      `${label} produces a path outside ${path.basename(base)}/: ${JSON.stringify(childName)}`,
    );
  }
  const candidate = path.resolve(path.join(base, `${childName}${extension}`));
  const resolvedBase = path.resolve(base);
  // Containment check: candidate must equal resolvedBase or live under it.
  // Python's Path.relative_to raises ValueError when not under base.
  if (
    candidate !== resolvedBase &&
    !candidate.startsWith(resolvedBase + path.sep)
  ) {
    throw new Error(
      `${label} produces a path outside ${path.basename(base)}/: ${JSON.stringify(childName)}`,
    );
  }
  return candidate;
}

/**
 * Sanitize a session_id for use in a filename (Python
 * _sanitize_session_id_for_filename). On Windows, colons become underscores
 * so they do not silently create NTFS Alternate Data Streams. Idempotent.
 */
function sanitizeSessionIdForFilename(sessionId: string): string {
  if (IS_WIN32 && sessionId.includes(":")) {
    return sessionId.replace(/:/g, "_");
  }
  return sessionId;
}

/**
 * Canonical public helper for joining a base directory with a user-controlled
 * fragment (Python safe_join). Subsumes _safeChildPath and adds an
 * unconditional colon rejection (POSIX-legal but Windows-illegal; Codex
 * session IDs can contain `:`).
 *
 * Checks in order: empty → null byte → colon → (delegate to _safeChildPath for
 * UNC + traversal + absolute-path containment).
 */
export function safeJoin(
  base: string,
  fragment: string,
  ext: string = "",
): string {
  if (fragment.length === 0) {
    throw new Error("safe_join: fragment must not be empty");
  }
  if (fragment.includes("\x00")) {
    throw new Error(
      `safe_join: fragment contains null byte: ${JSON.stringify(fragment)}`,
    );
  }
  if (fragment.includes(":")) {
    throw new Error(
      `safe_join: fragment contains colon (possible Windows absolute path): ${JSON.stringify(fragment)}`,
    );
  }
  return _safeChildPath(base, fragment, ext, "fragment");
}

/** Path to projects/{hash}.db. Throws on traversal/null-byte escape. */
export function projectDbPath(projectHash: string): string {
  return _safeChildPath(
    path.join(dataDir(), "projects"),
    projectHash,
    ".db",
    "project_hash",
  );
}

// ---------------------------------------------------------------------------
// normalize_key / normalize_path_key (Python paths.py:387-487).
// ---------------------------------------------------------------------------

/**
 * Canonical path-key normalizer (Python normalize_key). Delegates to
 * util.normalizePath for: WSL `/mnt/<drive>/rest` → `<drive>:/rest`,
 * backslash → forward slash, uppercase drive letter → lowercase.
 *
 * The result is a consistent canonical string suitable as a dict key or SQLite
 * lookup value regardless of whether the path arrived from Windows (C:\\foo),
 * WSL (/mnt/c/foo), or already-normalised (c:/foo). String-only: symlinks,
 * junctions, NTFS case folding are deliberately NOT resolved.
 */
export function normalizeKey(p: string): string {
  return normalizePath(p);
}

/** Return true when s begins with a Windows drive letter followed by a colon. */
function hasWindowsDrivePrefix(s: string): boolean {
  return s.length >= 2 && s[1] === ":" && /[A-Za-z]/.test(s[0]!);
}

/**
 * Normalize a path to a canonical absolute key for cross-form dedup lookups
 * (Python normalize_path_key). Extends normalizeKey with relative-path
 * resolution against an optional cwd.
 *
 *  - Absolute (string analysis + path.isAbsolute): resolve symlinks, apply
 *    normalizeKey transformations.
 *  - POSIX-rooted on Windows (starts with `/` but not isAbsolute): apply
 *    normalizeKey string-only (calling resolve would anchor it to the current
 *    Windows drive and produce an inconsistent key vs session.mark_file_read).
 *  - Relative + cwd provided: join cwd/path, resolve, normalize.
 *  - Relative + no cwd: fall back to normalizeKey (best-effort).
 *
 * Always fail-soft: any exception falls back to normalizeKey.
 */
export function normalizePathKey(
  p: string,
  cwd: string | undefined = undefined,
): string {
  try {
    const normalizedStr = p.replace(/\\/g, "/");
    const isPosixRooted = normalizedStr.startsWith("/");
    const hasDrive = hasWindowsDrivePrefix(normalizedStr);
    const isStringAbsolute = isPosixRooted || hasDrive;
    if (isStringAbsolute) {
      if (path.isAbsolute(p)) {
        // Truly absolute on the current OS — safe to resolve symlinks.
        return normalizeKey(path.resolve(p));
      }
      // POSIX-rooted on Windows: string-only normalization.
      return normalizeKey(p);
    }
    if (cwd !== undefined && cwd.length > 0) {
      return normalizeKey(path.resolve(path.join(cwd, p)));
    }
  } catch {
    // Fall through to normalizeKey.
  }
  return normalizeKey(p);
}

/**
 * Return true when relPath is safe to join under a project root (Python
 * is_safe_rel_path). Rejects POSIX absolute paths, Windows drive/UNC paths,
 * null bytes, and any `..` traversal component on either separator style.
 */
export function isSafeRelPath(relPath: string): boolean {
  if (relPath.length === 0) return false;
  const candidate = relPath.trim();
  if (candidate.length === 0 || candidate.includes("\x00")) return false;
  const normalized = candidate.replace(/\\/g, "/");
  if (normalized.startsWith("/")) return false;
  if (hasWindowsDrivePrefix(normalized)) return false;
  return normalized.split("/").every((part) => part !== "..");
}

// ---------------------------------------------------------------------------
// Named path helpers (Python paths.py:512-990).
// ---------------------------------------------------------------------------

/** Path to sessions/ directory. */
export function sessionsDir(): string {
  return path.join(dataDir(), "sessions");
}

/**
 * Path to sessions/{sessionId}.json (Python session_cache_path).
 *
 * Validates the session id via _safeChildPath (null byte + traversal + UNC).
 * On Windows, rejects paths whose total length reaches or exceeds MAX_PATH
 * (260 chars) — the sessions/ base is typically 60–80 chars and a 128-char
 * session id stays well under, but the explicit check ensures correctness on
 * systems with unusually deep LOCALAPPDATA paths.
 */
export function sessionCachePath(sessionId: string): string {
  const candidate = _safeChildPath(
    path.join(dataDir(), "sessions"),
    sessionId,
    ".json",
    "session_id",
  );
  if (IS_WIN32 && candidate.length >= WIN_MAX_PATH) {
    throw new Error(
      `session_id produces a path that exceeds Windows MAX_PATH (260 chars): len=${candidate.length}`,
    );
  }
  return candidate;
}

/**
 * Path to the persistent hook wrapper script (Python hook_wrapper_path).
 * tg-hook.cmd on Windows, tg-hook.sh elsewhere. Lives under data_dir/bin/ so
 * it survives `uv tool install --reinstall` (which rebuilds the venv).
 */
export function hookWrapperPath(): string {
  const name = IS_WIN32 ? "tg-hook.cmd" : "tg-hook.sh";
  return path.join(dataDir(), "bin", name);
}

/**
 * Build the contents of the hook wrapper script for this platform (Python
 * hook_wrapper_content).
 *
 * The TS port emits the *ungated* wrapper (forwards unconditionally): Node has
 * no equivalent of Python's importlib.util.find_spec for locating a Python
 * module from JS, so the sentinel-probe branch is not portable. The ungated
 * wrapper is correct for any JS-side install that does not depend on a Python
 * venv; the Python install path continues to use the Python module's richer
 * wrapper (the Python module remains the source of truth there).
 */
export function hookWrapperContent(): string {
  // [node, <entry>] (or [node, --import, tsx, <entry.ts>]); forward slashes on
  // every token (Git Bash on Windows strips backslashes), quoting any token
  // that contains whitespace so a path with spaces survives the shell.
  const prefix = cliRunnerPrefix()
    .map((a) => a.replace(/\\/g, "/"))
    .map((a) => (/\s/.test(a) ? `"${a}"` : a))
    .join(" ");
  if (IS_WIN32) {
    return (
      "@echo off\r\n" +
      "REM token-goat hook wrapper - auto-generated by `token-goat install`.\r\n" +
      `${prefix} %*\r\n`
    );
  }
  return (
    "#!/bin/sh\n" +
    "# token-goat hook wrapper - auto-generated by `token-goat install`.\n" +
    `exec ${prefix} "$@"\n`
  );
}

/** Path to images/ directory. */
export function imageCacheDir(): string {
  return path.join(dataDir(), "images");
}

/** Path to models/ directory. */
export function modelsDir(): string {
  return path.join(dataDir(), "models");
}

/** Path to logs/ directory. */
export function logsDir(): string {
  return path.join(dataDir(), "logs");
}

/**
 * Roll a log file over to a .prev.log sibling once it exceeds maxBytes
 * (Python roll_log_if_oversized). Best-effort: on Windows rename fails if
 * another process holds the file open, so the roll is suppressed on error and
 * retried by the next process that opens the log while it is briefly unheld.
 *
 * The .prev.log name ends in .log so the worker's 7-day retention sweep reaps
 * it too.
 */
export function rollLogIfOversized(p: string, maxBytes: number): void {
  let size: number;
  try {
    size = fs.statSync(p).size;
    if (size <= maxBytes) return;
  } catch {
    return;
  }
  // .prev.log sibling: replace a trailing .log (any case), else append.
  const dest = /\.log$/i.test(p) ? p.replace(/\.log$/i, ".prev.log") : `${p}.prev.log`;
  try {
    fs.renameSync(p, dest);
    // Python prints to stderr here; console.error mirrors it.
    console.error(
      `token-goat: rolled oversized log ${path.basename(p)} -> ${path.basename(dest)} ` +
        `(${size} bytes > ${maxBytes} limit)`,
    );
  } catch {
    // Suppressed — best-effort; next process will retry.
  }
}

/** Path to locks/ directory. */
export function locksDir(): string {
  return path.join(dataDir(), "locks");
}

/** Path to worker.pid. */
export function workerPidPath(): string {
  return path.join(locksDir(), "worker.pid");
}

/** Path to worker.heartbeat. */
export function workerHeartbeatPath(): string {
  return path.join(locksDir(), "worker.heartbeat");
}

/** Path to queue/dirty.txt. */
export function dirtyQueuePath(): string {
  return path.join(dataDir(), "queue", "dirty.txt");
}

// ---------------------------------------------------------------------------
// configPath — where config.toml lives, overridable for tests.
// ---------------------------------------------------------------------------
// Python's tests redirect config resolution by monkeypatching
// `paths.config_path` to return a tmp_path / "config.toml" literal. JS has no
// monkeypatch for a module-private `let`, so configPath() consults an override
// slot first; tests call setConfigPathOverride(file) to redirect and
// clearModuleCaches() (which runs clearConfigPathOverride via the registration
// below) restores the default on teardown. This seam was added by the prior
// minimal shim and is preserved verbatim so db.ts / config.ts consume it when
// they land.

/** Current configPath override, or undefined when the default is in effect. */
let _configPathOverride: string | undefined = undefined;

/**
 * Return the path to config.toml.
 *
 * A test-provided override wins (set via setConfigPathOverride); otherwise the
 * default `<dataDir>/config.toml` is returned. The override slot is the JS
 * analogue of Python's monkeypatch.setattr(paths_mod, "config_path", ...).
 */
export function configPath(): string {
  if (_configPathOverride !== undefined) {
    return _configPathOverride;
  }
  return path.join(dataDir(), "config.toml");
}

/**
 * Set or clear the configPath override.
 *
 * Pass an absolute path (typically a test tmp file) to redirect config
 * resolution; pass undefined to restore the `<dataDir>/config.toml` default.
 * configPath() reads the new value on its next call — no invalidation hook is
 * needed.
 */
export function setConfigPathOverride(p: string | undefined): void {
  _configPathOverride = p;
}

/** Return the current configPath override if one is set, else undefined. */
export function getConfigPathOverride(): string | undefined {
  return _configPathOverride;
}

/**
 * Clear the configPath override, restoring the `<dataDir>/config.toml` default.
 * Equivalent to setConfigPathOverride(undefined). Exposed as its own named
 * function so the clear-module-caches registration reads as intent.
 */
export function clearConfigPathOverride(): void {
  _configPathOverride = undefined;
}

// Register the configPath override reset so clearModuleCaches() — called by
// every test's beforeEach in tests/setup.ts — restores the default config path
// as part of the same wipe that clears every other module's caches.
registerReset(clearConfigPathOverride);

/** Path to gdrive_creds.json. */
export function gdriveCredsPath(): string {
  return path.join(dataDir(), "gdrive_creds.json");
}

/** Path to gdrive_cache/ directory. */
export function gdriveCacheDir(): string {
  return path.join(dataDir(), "gdrive_cache");
}

/** Path to web_cache/ directory. */
export function webCacheDir(): string {
  return path.join(dataDir(), "web_cache");
}

/**
 * Path to compact_skip/{sessionId}.sentinel (Python compact_skip_sentinel_path).
 * On Windows, colons in sessionId are sanitized to underscores.
 */
export function compactSkipSentinelPath(sessionId: string): string {
  const safeId = sanitizeSessionIdForFilename(sessionId);
  return _safeChildPath(
    path.join(dataDir(), "compact_skip"),
    safeId,
    ".sentinel",
    "session_id",
  );
}

/** Path to sentinels/ — general-purpose small sidecar files. */
export function sentinelsDir(): string {
  return path.join(dataDir(), "sentinels");
}

/**
 * Path to sentinels/recovery_pending_{sessionId} (Python recovery_pending_path).
 * On Windows, colons in sessionId are sanitized to underscores.
 */
export function recoveryPendingPath(sessionId: string): string {
  const safeId = sanitizeSessionIdForFilename(sessionId);
  return _safeChildPath(
    sentinelsDir(),
    `recovery_pending_${safeId}`,
    "",
    "session_id",
  );
}

/**
 * Path to sentinels/baseline_advisory_{sessionId} (Python
 * baseline_advisory_sent_path). On Windows, colons sanitized to underscores.
 */
export function baselineAdvisorySentPath(sessionId: string): string {
  const safeId = sanitizeSessionIdForFilename(sessionId);
  return _safeChildPath(
    sentinelsDir(),
    `baseline_advisory_${safeId}`,
    "",
    "session_id",
  );
}

/**
 * Path to sentinels/precompact_estimate_{sessionId}.json (Python
 * precompact_estimate_path). On Windows, colons sanitized to underscores.
 */
export function precompactEstimatePath(sessionId: string): string {
  const safeId = sanitizeSessionIdForFilename(sessionId);
  return _safeChildPath(
    sentinelsDir(),
    `precompact_estimate_${safeId}`,
    ".json",
    "session_id",
  );
}

/** Path to sentinels/skill_pregen_sentinel.json (Python skill_pregen_sentinel_path). */
export function skillPregenSentinelPath(): string {
  return path.join(sentinelsDir(), "skill_pregen_sentinel.json");
}

/**
 * Path to the manifest-SHA sidecar for sessionId (Python
 * manifest_sha_sidecar_path). On Windows, colons sanitized to underscores.
 */
export function manifestShaSidecarPath(sessionId: string): string {
  const safeId = sanitizeSessionIdForFilename(sessionId);
  return _safeChildPath(
    sentinelsDir(),
    `manifest_sha_${safeId}`,
    "",
    "session_id",
  );
}

/**
 * Path to the manifest-text sidecar for sessionId (Python
 * manifest_text_sidecar_path). On Windows, colons sanitized to underscores.
 */
export function manifestTextSidecarPath(sessionId: string): string {
  const safeId = sanitizeSessionIdForFilename(sessionId);
  return _safeChildPath(
    sentinelsDir(),
    `manifest_text_${safeId}`,
    ".txt",
    "session_id",
  );
}

// ---------------------------------------------------------------------------
// Claude Code paths (Python paths.py:893-987).
// ---------------------------------------------------------------------------

/** Path to Claude Code's config directory (~/.claude). */
export function claudeConfigDir(): string {
  return path.join(os.homedir(), ".claude");
}

/** Path to Claude Code's per-project session store (~/.claude/projects). */
export function claudeProjectsDir(): string {
  return path.join(claudeConfigDir(), "projects");
}

/**
 * Return the tool-results directory for sessionId, or undefined (Python
 * claude_session_tool_results_dir). Scans claude_projects_dir for the project
 * that owns sessionId rather than reconstructing Claude Code's path-slug
 * scheme. sessionId is validated as a bare path segment. Never throws.
 */
export function claudeSessionToolResultsDir(
  sessionId: string,
): string | undefined {
  if (!isValidClaudeSessionSegment(sessionId)) return undefined;
  const root = claudeProjectsDir();
  if (!isDirSync(root)) return undefined;
  try {
    for (const entry of fs.readdirSync(root)) {
      const projDir = path.join(root, entry);
      if (!isDirSync(projDir)) continue;
      const candidate = path.join(projDir, sessionId, "tool-results");
      if (isDirSync(candidate)) return candidate;
    }
  } catch {
    return undefined;
  }
  return undefined;
}

/**
 * Return the ~/.claude/projects/<slug> directory that owns sessionId, or
 * undefined (Python claude_session_project_dir). Matches by scanning for a
 * `<sessionId>.jsonl` transcript file. Never throws.
 */
export function claudeSessionProjectDir(
  sessionId: string,
): string | undefined {
  if (!isValidClaudeSessionSegment(sessionId)) return undefined;
  const root = claudeProjectsDir();
  if (!isDirSync(root)) return undefined;
  try {
    for (const entry of fs.readdirSync(root)) {
      const projDir = path.join(root, entry);
      if (!isDirSync(projDir)) continue;
      if (isFileSync(path.join(projDir, `${sessionId}.jsonl`))) {
        return projDir;
      }
    }
  } catch {
    return undefined;
  }
  return undefined;
}

/** True when sessionId is a valid bare path segment (no separators, ., .., NUL). */
function isValidClaudeSessionSegment(sessionId: string): boolean {
  return (
    sessionId.length > 0 &&
    !sessionId.includes("\x00") &&
    !sessionId.includes("/") &&
    !sessionId.includes("\\") &&
    sessionId !== "." &&
    sessionId !== ".."
  );
}

/** isDirectory without throwing on missing/error (Python Path.is_dir guard). */
function isDirSync(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

/** isFile without throwing on missing/error. */
function isFileSync(p: string): boolean {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

/** Path to Claude Code skills directory (~/.claude/skills). */
export function claudeSkillsDir(): string {
  return path.join(claudeConfigDir(), "skills");
}

/** Path to Claude Code plugins directory (~/.claude/plugins). */
export function claudePluginsDir(): string {
  return path.join(claudeConfigDir(), "plugins");
}

// ---------------------------------------------------------------------------
// Directory creation (Python ensure_dir / ensure_dirs, paths.py:989-1046).
// ---------------------------------------------------------------------------

/**
 * Create the directory (and any missing parents) and return it (Python
 * ensure_dir). Race-tolerant: fs.mkdirSync(recursive) can spuriously throw
 * EEXIST on Windows when another process beat us; we retry briefly and fall
 * back to existsSync (more forgiving than statSync under attribute lag).
 */
export function ensureDir(p: string): string {
  let lastErr: NodeJS.ErrnoException | undefined = undefined;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      fs.mkdirSync(p, { recursive: true });
      return p;
    } catch (err) {
      const e = err as NodeJS.ErrnoException;
      if (e.code === "EEXIST") {
        lastErr = e;
        // Race: another process beat us; Windows stat may not have synced
        // yet. Yield briefly and re-check.
        sleepSync(5 * (attempt + 1));
        if (isDirSync(p)) return p;
        // isDirSync raced or path is a file; keep retrying.
        continue;
      }
      throw e;
    }
  }
  // Final check: trust existsSync (cheaper than statSync, less sensitive to
  // attribute lag). If anything exists at this path treat exist_ok as
  // satisfied — same intent as the caller.
  if (fs.existsSync(p)) return p;
  throw lastErr ?? new Error(`ensure_dir: failed to create ${p}`);
}

/**
 * Create all needed subdirectories idempotently (Python ensure_dirs).
 */
export function ensureDirs(): void {
  const dirs = [
    dataDir(),
    path.join(dataDir(), "projects"),
    path.join(dataDir(), "sessions"),
    imageCacheDir(),
    modelsDir(),
    logsDir(),
    locksDir(),
    path.join(dataDir(), "queue"),
  ];
  for (const d of dirs) ensureDir(d);
}

/**
 * Recursively create the directory containing filePath if it does not exist.
 *
 * Mirrors Python's `paths.ensure_dir(p.parent)`: given a file path, ensure the
 * parent directory exists. Idempotent. Thin wrapper over
 * ensureDir(path.dirname(filePath)) so the Python call site ports one-for-one.
 */
export function ensureParentDir(filePath: string): string {
  return ensureDir(path.dirname(filePath));
}

/**
 * Synchronous sleep (ensure_dir retry back-off). Node has no stdlib sync
 * sleep; Atomics.wait on a SharedArrayBuffer is the idiomatic sync block. The
 * waits are tiny (5–15 ms) so main-thread blockage is negligible and matches
 * Python's time.sleep semantics.
 */
function sleepSync(ms: number): void {
  const buf = new Int32Array(new SharedArrayBuffer(4));
  Atomics.wait(buf, 0, 0, ms);
}

// ---------------------------------------------------------------------------
// Atomic write (Python paths.py:1048-1202).
// ---------------------------------------------------------------------------

/** Monotonic time in milliseconds (Python time.monotonic_ns → ms). */
function monotonicMs(): number {
  return Number(process.hrtime.bigint() / 1_000_000n);
}

let _tmpCounter = 0;

/**
 * Rename src to dest, retrying on EPERM/EBUSY/ETXTBSY (Windows file-lock race,
 * Python _rename_with_retry). Three attempts with short back-off cover the
 * common case without meaningfully delaying the caller. Non-retryable errors
 * propagate immediately.
 */
function renameWithRetry(src: string, dest: string): void {
  let lastErr: NodeJS.ErrnoException | undefined = undefined;
  const delays = [0, 50, 150];
  for (const delay of delays) {
    if (delay > 0) sleepSync(delay);
    try {
      fs.renameSync(src, dest);
      return;
    } catch (err) {
      const e = err as NodeJS.ErrnoException;
      // Python catches PermissionError specifically; on Windows the analogous
      // errno codes are EPERM (privilege) and EBUSY/ETXTBSY (file locked by
      // another process). Retry those; rethrow everything else immediately.
      if (e.code === "EPERM" || e.code === "EBUSY" || e.code === "ETXTBSY") {
        lastErr = e;
        continue;
      }
      throw e;
    }
  }
  throw lastErr ?? new Error(`rename_with_retry: failed to rename ${src} -> ${dest}`);
}

/**
 * Write content (text or bytes) to path atomically via a temp file + rename
 * (Python _atomic_write_core).
 *
 * Tmp name: `${path}.{pid}.{monotonicMs}.{counter}.tmp` — pid disambiguates
 * across forked workers, monotonicMs across sequential calls in the same
 * process, counter across same-ms calls. Rename-over rather than in-place so
 * a mid-write crash cannot leave a partial file.
 *
 * On POSIX the tmp file is created with mode 0o600 (owner-only) via
 * fs.openSync(path, "wx", 0o600) so it is never world-readable even during
 * the brief window before the rename. On Windows Node ignores the mode (NTFS
 * ACLs govern access; the user-profile location already provides isolation),
 * matching paths.py's _open_restricted branch.
 *
 * Text-mode surrogate handling: Python encodes with "utf-8", "replace" so a
 * lone UTF-16 surrogate (mis-decoded cp1252 on Windows) becomes "?" rather
 * than aborting the write. The TS port writes Buffer.from(content, "utf8")
 * which substitutes U+FFFD for lone surrogates — same fail-soft contract.
 *
 * The finally block unlinks tmp only when the rename did not succeed — on
 * POSIX the rename atomically removed the source name, and unlinking a stale
 * path could theoretically hit a file that reused the name.
 */
function atomicWriteCore(
  p: string,
  content: string | Buffer,
  isBytes: boolean,
): void {
  const tmp = `${p}.${process.pid}.${monotonicMs()}.${_tmpCounter++}.tmp`;
  ensureDir(path.dirname(p));
  let renamed = false;
  try {
    // Open with "wx" (exclusive create) so we fail loudly if the tmp name
    // somehow already exists. Mode 0o600 on POSIX; ignored on Windows.
    const fd = fs.openSync(tmp, "wx", 0o600);
    try {
      const buf = isBytes
        ? (content as Buffer)
        : Buffer.from(content as string, "utf8");
      fs.writeSync(fd, buf, 0, buf.length, 0);
    } finally {
      fs.closeSync(fd);
    }
    renameWithRetry(tmp, p);
    renamed = true;
  } catch (err) {
    // Any write/open error: clean up tmp then re-raise. Matches paths.py's
    // except-branch (tmp.unlink(missing_ok=True) then raise).
    try {
      fs.unlinkSync(tmp);
    } catch {
      // missing_ok equivalent: ignore ENOENT.
    }
    throw err;
  } finally {
    // Only unlink when the rename did not succeed. On POSIX the rename
    // atomically removed the source name so tmp no longer exists; calling
    // unlink on a stale path could hit a file that reused the name. On
    // Windows the rename consumed tmp; clean up only if we still own it.
    if (!renamed) {
      try {
        fs.unlinkSync(tmp);
      } catch {
        // ignore ENOENT.
      }
    }
  }
}

/**
 * Write content (text) to path atomically via a temp file + rename (Python
 * atomic_write_text). Creates parent directories as needed. On POSIX the tmp
 * file is created owner-only (0o600). Lone surrogates are replaced (U+FFFD)
 * rather than aborting the write.
 */
export function atomicWriteText(p: string, content: string): void {
  atomicWriteCore(p, content, false);
}

/**
 * Write content (bytes) to path atomically via a temp file + rename (Python
 * atomic_write_bytes). Same retry-on-EPERM/EBUSY strategy; same 0o600 tmp on
 * POSIX.
 *
 * This function was present (with a simpler rename-no-retry implementation) in
 * the prior minimal shim; the full port swaps in atomicWriteCore so the retry
 * loop and owner-only mode apply uniformly. The signature is unchanged.
 */
export function atomicWriteBytes(p: string, content: Buffer): void {
  atomicWriteCore(p, content, true);
}

// ---------------------------------------------------------------------------
// NOT PORTED — open_log_file (Python paths.py:1087-1120).
// ---------------------------------------------------------------------------
// open_log_file returns a Python logging.FileHandler created with 0o600 on
// POSIX. The TS port has no logging-FileHandler analogue (the logging layer
// farms out to console via util.ts getLogger). The function is included as a
// stub that throws so any caller reaching it surfaces the gap loudly; the
// worker/install layer will grow a real FileHandler when it lands.

/**
 * NOT YET PORTED. Python open_log_file returns a logging.FileHandler with
 * owner-only (0o600) permissions on POSIX. The TS port has no logging-
 * FileHandler analogue yet; the worker layer will grow one. Throws to surface
 * the gap.
 */
export function openLogFile(_p: string): never {
  throw new Error(
    "paths.openLogFile: not yet ported (logging.FileHandler analogue pending the worker layer)",
  );
}

// ---------------------------------------------------------------------------
// Module-global cache reset registration.
// ---------------------------------------------------------------------------

// Register a reset for _dataDirCache so clearModuleCaches() (per-test
// beforeEach in tests/setup.ts) drops the cached platform default. The
// data-dir override itself (getDataDirOverride/setDataDirOverride) is reset
// by its own registration in reset.ts; this registration handles only the
// computed-and-cached default.
registerReset(() => {
  _dataDirCache = undefined;
});

// Register a reset for the hooks-stderr.log override so clearModuleCaches()
// also wipes any per-test redirect. Mirrors the conftest
// isolate_hooks_stderr_log autouse fixture (documented as deferred in
// tests/setup.ts until this seam landed).
registerReset(() => {
  _hooksStderrLogOverride = undefined;
});
