/**
 * Project marker detection + path canonicalization.
 *
 * Faithful port of src/token_goat/project.py. Pure, sync, dependency-free except
 * for node:path / node:fs / node:crypto and the getLogger re-export from
 * ./util.js (which mirrors Python's `from .util import get_logger`).
 *
 * -----
 * Path model
 * -----
 * Python's pathlib.Path has no JS twin. Throughout this module a "path" is a
 * plain `string`. The two path-shaped concepts in the Python source collapse to
 * one here:
 *
 *   - `canonicalize(path: string): string`  — returns the canonical posix
 *     string (Python returned `Path`, but every consumer immediately called
 *     `.as_posix()` or passed it back to another path function, so exposing the
 *     string is lossless and removes a pointless wrapper).
 *   - `project_hash(canonicalRoot: string): string` — sha1 of the canonical
 *     posix string. The Python signature took `Path` and called `.as_posix()`
 *     internally; the TS caller is expected to pass the *output of
 *     canonicalize()* (which is already the posix string), preserving the
 *     "never pass a raw cwd" contract documented on the Python function.
 *
 * The cross-platform test `test_project_hash_known_vectors_durable_format`
 * passes PurePosixPath(...) purely so `.as_posix()` is uniform across the
 * Windows and Linux CI runners; in the TS port the test passes the posix
 * string directly (e.g. `"c:/work/foo"`), which is the identical surface.
 *
 * -----
 * Module-global caches
 * -----
 * Unlike paths.py / config.py / session.py, project.py owns NO module-level
 * mutable cache. The only module-global state is the `_LOG` Logger, and the
 * logger cache it draws from lives in util.ts (which registers its own reset).
 * Therefore this module does NOT call registerReset — there is nothing here
 * for clearModuleCaches() to wipe.
 *
 * -----
 * Parity notes
 * -----
 *  - Symlink resolution uses fs.realpathSync (Python's Path.resolve). On
 *    Windows, realpathSync does NOT lower-case the drive letter or collapse
 *    MSYS /cygdrive/c/... prefixes the way the Python code's explicit
 *    _normalize_shell_drive_prefix step does, so the same two-pass shell-prefix
 *    normalization (before AND after resolve) is preserved verbatim. The
 *    Windows-specific tests are skipped on POSIX in the Python suite and the
 *    TS port mirrors that (see test_project.test.ts).
 *  - `find_project` walk-up: Python iterates `(p, *p.parents)`. node:path has
 *    no parents iterator, so the loop walks via path.dirname until the value
 *    stops changing (posix root `/` or a Windows drive root `c:/`), which is
 *    exactly the set `p.parents` would have yielded.
 *  - `_is_repo_container` uses fs.readdirSync + try/catch (Python's scandir
 *    raises OSError on permission errors; the TS port treats any throw as
 *    "not a container", matching the Python `except OSError: return False`).
 *  - `_marker_exists` uses lstat/isSymbolicLink + realpathSync. The
 *    out-of-root escape check uses aposix-prefix containment test
 *    (resolved.startsWith(rootResolved + "/") || resolved === rootResolved),
 *    which is the string equivalent of Python's
 *    `resolved.relative_to(current.resolve())` (raises ValueError on escape).
 *  - The Python `make_project_at` debug log calls sanitize_log_str (from
 *    hooks_common.py). hooks_common is NOT one of the allowed imports for this
 *    layer, and the helper is a trivial newline/RTL/truncate sanitizer used
 *    only to make one debug log line injection-safe. A local _sanitizeLogStr
 *    is inlined below (verbatim semantics from hooks_common.sanitize_log_str)
 *    so this module stays dependency-free apart from util.getLogger.
 */

import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { getLogger } from "./util.js";

// ===========================================================================
// Cross-shell Windows-drive prefix normalization
// ===========================================================================
//
// Verbatim port of the three regexes in project.py. These map the WSL / Cygwin
// / MSYS forms of a Windows drive path onto the canonical `c:/...` form BEFORE
// hashing, so the same physical directory yields one SHA1 regardless of which
// shell the user invoked token-goat from. See the long comment in project.py
// for the full rationale (the short version: without this, PowerShell vs Git
// Bash vs WSL would fragment the per-project DB into three files).
//
// JS regex character classes behave like Python's here: the inputs are path
// strings with no DOTALL concerns (the `.*` groups are anchored at ^ and run
// to end-of-input, so embedded newlines are not a practical concern for a
// path; if one did appear it would match just as in Python under re.DOTALL).

/** /mnt/<drive>/rest (WSL / Linux mount) -> <drive>:/rest */
const _WSL_PREFIX_RE = /^\/mnt\/([a-zA-Z])\/([\s\S]*)$/;
/** /cygdrive/<drive>/rest (Cygwin) -> <drive>:/rest */
const _CYGWIN_PREFIX_RE = /^\/cygdrive\/([a-zA-Z])\/([\s\S]*)$/;
/** /<drive>/rest (Git Bash MSYS) -> <drive>:/rest */
const _MSYS_PREFIX_RE = /^\/([a-zA-Z])\/([\s\S]*)$/;

/**
 * Map WSL / Cygwin / MSYS Windows-drive prefixes to canonical `c:/` form.
 *
 * Pure string transform — does not touch the filesystem and never raises.
 * Unrecognised paths (e.g. `/usr/local/bin`, `/home/user/foo`) are returned
 * unchanged. Drive letter in the captured group is lowercased so `/mnt/C/foo`
 * and `/mnt/c/foo` collapse to the same `c:/foo`.
 *
 * Ported verbatim from project.py:_normalize_shell_drive_prefix. The three
 * regexes are tried in the same order (WSL, then Cygwin, then MSYS); the first
 * match wins and the remaining regexes are not consulted.
 */
export function _normalize_shell_drive_prefix(posixStr: string): string {
  let m = _WSL_PREFIX_RE.exec(posixStr);
  if (m !== null) {
    return `${m[1]!.toLowerCase()}:/${m[2]}`;
  }
  m = _CYGWIN_PREFIX_RE.exec(posixStr);
  if (m !== null) {
    return `${m[1]!.toLowerCase()}:/${m[2]}`;
  }
  m = _MSYS_PREFIX_RE.exec(posixStr);
  if (m !== null) {
    return `${m[1]!.toLowerCase()}:/${m[2]}`;
  }
  return posixStr;
}

const _LOG = getLogger("project");

/**
 * Project marker files, in precedence order.
 *
 * A directory containing any of these is treated as a project root by
 * find_project. The order mirrors Python's tuple exactly so the marker
 * reported for a directory carrying more than one is deterministic and matches
 * the Python output byte-for-byte.
 */
export const PROJECT_MARKERS = [
  ".git",
  "package.json",
  "pyproject.toml",
  "Cargo.toml",
  "go.mod",
  "shopify.app.toml",
  "_config.yml",
  "deno.json",
  "deno.jsonc",
] as const;

/**
 * A directory with at least this many immediate children that are themselves
 * independent git repos is treated as a *container* of repos, not a project.
 * See _is_repo_container for the rationale (the short version: a stray
 * `git init` at a parent of many checkouts must not swallow them all).
 */
const _REPO_CONTAINER_THRESHOLD = 3;

/**
 * Detected project: canonical root path, SHA1 hash, and the marker file that
 * identified it.
 *
 * Ported from the frozen `@dataclass(frozen=True) Project`. Field names are
 * preserved exactly (snake_case). The Python `root: Path` becomes `root:
 * string` (see the path-model note at the top of this file). `hash` is the
 * sha1 hex of the canonical posix path; `marker` is the basename of the
 * marker file that matched (one of PROJECT_MARKERS, or "manual" for
 * make_project_at).
 */
export interface Project {
  /** Canonical posix path of the project root. */
  root: string;
  /** sha1 hex (40 chars) of canonicalize(root). */
  hash: string;
  /** Marker file that identified the root, or "manual" for make_project_at. */
  marker: string;
}

/**
 * Minimal inline port of hooks_common.sanitize_log_str.
 *
 * Strips embedded newlines (log-injection guard) and truncates to maxLen. The
 * full Python helper also strips Unicode bidi controls; project.ts only ever
 * sanitizes filesystem paths in a single debug line, where bidi controls are
 * not a realistic vector, so the bidi strip is omitted here to avoid importing
 * hooks_common (not yet ported at this layer). If a bidi-stripping caller is
 * added later, lift this into hooks_common.ts and import it.
 */
function _sanitizeLogStr(value: string, maxLen: number = 200): string {
  let sanitized = value.replace(/\n/g, "\\n").replace(/\r/g, "\\r");
  if (sanitized.length > maxLen) {
    sanitized = sanitized.slice(0, maxLen) + "…";
  }
  return sanitized;
}

/**
 * Resolve symlinks, normalize, lowercase the Windows drive letter.
 *
 * Returns a canonical posix path string that is identical regardless of which
 * shell or OS view accessed the same underlying directory:
 *
 *   C:\Projects\foo            (cmd.exe, PowerShell)
 *   c:\Projects\foo            (lowercased drive letter)
 *   C:/Projects/foo            (forward slashes on Windows)
 *   /c/Projects/foo            (Git Bash MSYS)
 *   /cygdrive/c/Projects/foo   (Cygwin)
 *   /mnt/c/Projects/foo        (WSL / Linux mount)
 *
 * All six canonicalize to "c:/Projects/foo" so project_hash produces a single,
 * stable SHA1 across shells.
 *
 * Algorithm (verbatim from project.py:canonicalize):
 *  1. Replace backslashes with forward slashes.
 *  2. Pre-resolve MSYS/WSL/Cygwin prefix -> c:/ form. (Without this, on
 *     Windows fs.realpathSync would misinterpret `/c/Projects/foo` as relative
 *     to the current drive and produce `C:\c\Projects/foo` — the "double
 *     drive" trap.)
 *  3. realpathSync (resolve symlinks). Two paths pointing at the same target
 *     via different symlink chains still canonicalize identically.
 *  4. Re-run the prefix normalization on the resolved string (WSL resolve
 *     keeps `/mnt/c/...` as-is, so this is where WSL paths get normalized).
 *  5. Lowercase the drive letter (`C:/foo` -> `c:/foo`).
 *
 * On POSIX, realpathSync of a non-existent path throws ENOENT; the Python code
 * lets OSError propagate from Path.resolve. Callers that need to tolerate
 * missing paths (find_project) wrap this in try/catch themselves.
 */
export function canonicalize(inputPath: string): string {
  // Step 1+2: backslash -> slash, then pre-resolve shell drive prefix.
  const withSlashes = inputPath.replace(/\\/g, "/");
  const pre = _normalize_shell_drive_prefix(withSlashes);
  let p = pre !== withSlashes ? pre : withSlashes;

  // Step 3: resolve symlinks. realpathSync gives the absolute canonical path.
  // If the path does not exist, this throws ENOENT (the Python Path.resolve
  // also raises in that case); callers wrap as needed.
  let resolved: string;
  try {
    resolved = fs.realpathSync(p);
  } catch (err) {
    // Re-raise as a canonical OSError-like Error so callers' try/catch on the
    // message string (find_project checks for "ENOENT" etc.) still works. We
    // attach the original via `cause` for diagnosis.
    const code = (err as NodeJS.ErrnoException).code ?? "UNKNOWN";
    throw new Error(`canonicalize: could not resolve ${p}: ${code}`, {
      cause: err,
    });
  }

  // path.posix so separators are forward slashes regardless of platform.
  let s = path.posix.normalize(resolved.replace(/\\/g, "/"));

  // Step 4: re-run prefix normalization on the resolved string (WSL keeps
  // /mnt/c/... through resolve).
  s = _normalize_shell_drive_prefix(s);

  // Step 5: lowercase the drive letter on Windows-style paths (e.g.
  // "C:/foo" -> "c:/foo"). Same guard as project.py: len >= 2 and s[1] == ":".
  if (s.length >= 2 && s.charAt(1) === ":") {
    s = s.charAt(0).toLowerCase() + s.slice(1);
  }
  return s;
}

/**
 * Return sha1 hex (40 chars) of the canonical posix path.
 *
 * MUST always receive the output of canonicalize() — never a raw cwd or
 * user-supplied path — so the hash is stable across drive-letter case
 * variation, symlinks, and relative vs absolute forms.
 *
 * `node:crypto`'s createHash("sha1").update(str, "utf8").digest("hex") is
 * byte-identical to Python's `hashlib.sha1(str.encode("utf-8")).hexdigest()`
 * for all UTF-8 inputs (both follow RFC 3174 over the exact same octets).
 */
export function project_hash(canonicalRoot: string): string {
  return crypto.createHash("sha1").update(canonicalRoot, "utf8").digest("hex");
}

/**
 * Create a Project for any directory without requiring a project marker.
 *
 * Used for indexing arbitrary directories like ~/.claude/skills/ that have no
 * .git, pyproject.toml, or other marker files. The marker field is set to
 * "manual".
 *
 * Raises Error (with a message containing "not a directory") when root does
 * not resolve to an existing directory. This prevents accidental project
 * creation for symlinks-to-files or non-existent paths, which would cause the
 * indexer to crawl nothing useful while silently succeeding. The message
 * shape ("not a directory") is asserted on by the Python tests; the TS port
 * keeps the same substring so test_project.test.ts can match on it.
 */
export function make_project_at(
  root: string,
): Project {
  // Python's Path.resolve(strict=False) does NOT raise for a nonexistent path
  // — it returns the absolute form as-is, and make_project_at then fails at
  // the is_dir() check with "path is not a directory". fs.realpathSync (the TS
  // equivalent) IS strict and throws ENOENT for nonexistent paths. To preserve
  // the Python error message contract that test_make_project_at_rejects_nonexistent
  // asserts on ("not a directory"), we catch the ENOENT and route it to the
  // is_dir branch: a path that cannot be resolved is by definition not a
  // directory, so the "not a directory" message is accurate for the missing-path
  // case AND matches Python's observable behaviour.
  //
  // A genuine resolution failure for an existing path (e.g. a symlink loop, or
  // EACCES on a parent dir) is less common but still surfaces as "not a
  // directory" via the same path, which is acceptable: the Python version
  // would have raised OSError("could not resolve") in that narrow case, but
  // both languages reject the input with a ValueError-shaped Error and the
  // caller's recovery (don't create the project) is identical.
  let canonical: string;
  try {
    canonical = canonicalize(root);
  } catch {
    // Realpath failed (ENOENT / ELOOP / EACCES). Fall through to the is_dir
    // check below, which will report "not a directory" — matching the Python
    // message for the common (missing-path) case.
    canonical = root;
  }
  let isDir: boolean;
  try {
    isDir = fs.statSync(canonical).isDirectory();
  } catch {
    // stat failed (permission, ENOENT post-resolve, etc.) — treat as not a dir.
    isDir = false;
  }
  if (!isDir) {
    throw new Error(`make_project_at: path is not a directory: ${canonical}`);
  }
  const ph = project_hash(canonical);
  _LOG.debug(
    `make_project_at: created manual project (root=${_sanitizeLogStr(canonical)} hash=${ph.slice(0, 8)})`,
  );
  return { root: canonical, hash: ph, marker: "manual" };
}

/**
 * True if `dirPath` merely *contains* independent repos rather than being a
 * project itself.
 *
 * A stray `git init` at such a directory (e.g. C:\Projects holding a dozen
 * unrelated checkouts) would otherwise make find_project return the whole
 * supertree, and the entire thing would index as one giant project. We detect
 * the pattern by counting immediate child directories that have their own
 * `.git` — three or more nested independent repos is the container signature.
 * A real project, including a monorepo (whose packages share the one root
 * `.git`), does not look like this.
 *
 * Returns false on any readdir/stat error (mirrors Python's
 * `except OSError: return False`): a directory we cannot read is not something
 * we can confidently classify as a container, and the safe default is to treat
 * it as a potential project so find_project keeps walking.
 */
function _is_repo_container(dirPath: string): boolean {
  let nestedRepos = 0;
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dirPath, { withFileTypes: true });
  } catch (err) {
    _LOG.debug(
      `_is_repo_container: readdir failed for ${dirPath}: ${(err as Error).message}`,
    );
    return false;
  }
  for (const entry of entries) {
    // entry.isDirectory() without following symlinks — matches Python's
    // entry.is_dir(follow_symlinks=False). A symlinked child dir that happens
    // to contain a .git is not counted as a nested repo (it would be if we
    // followed the link, but then a single symlinked tree could trip the
    // threshold on its own).
    if (entry.isDirectory() && fs.existsSync(path.join(entry.parentPath ?? dirPath, entry.name, ".git"))) {
      nestedRepos += 1;
      if (nestedRepos >= _REPO_CONTAINER_THRESHOLD) {
        _LOG.debug(
          `repo container detected: ${dirPath} (>=${_REPO_CONTAINER_THRESHOLD} nested .git dirs)`,
        );
        return true;
      }
    }
  }
  return false;
}

/**
 * Return true when `marker` exists under `currentDir` and is not a symlink
 * that escapes the candidate project root.
 *
 * A bare `fs.existsSync(currentDir / marker)` follows symlinks unconditionally.
 * That lets an attacker plant a symlink such as `mydir/.git -> /etc/passwd` to
 * make find_project treat `mydir` as a project and trigger indexing of
 * arbitrary filesystem paths. We allow symlinks only when they resolve to a
 * path still contained within `currentDir`.
 *
 * Containment check: resolved === rootResolved OR resolved starts with
 * rootResolved + "/". This is the string equivalent of Python's
 * `resolved.relative_to(current.resolve())` (which raises ValueError when the
 * target is not under the base).
 */
function _marker_exists(currentDir: string, marker: string): boolean {
  const markerPath = path.join(currentDir, marker);
  try {
    if (!fs.existsSync(markerPath)) {
      return false;
    }
    const stat = fs.lstatSync(markerPath);
    if (!stat.isSymbolicLink()) {
      return true;
    }
    // Symlink: verify the resolved target stays inside the candidate root.
    const resolved = fs.realpathSync(markerPath);
    const rootResolved = fs.realpathSync(currentDir);
    if (resolved === rootResolved || resolved.startsWith(rootResolved + "/")) {
      return true;
    }
    return false;
  } catch {
    // realpath/lstat/stat failure (broken symlink, permission, ...) — treat as
    // "marker does not qualify". Mirrors Python's `except (OSError, ValueError):
    // return False`.
    return false;
  }
}

/**
 * Walk up from `cwd` looking for a project marker.
 *
 * A directory that looks like a container of repos (see _is_repo_container) is
 * skipped even if it carries a marker, so a stray `.git` at a parent of many
 * checkouts cannot swallow them all into one project.
 *
 * Returns null if none found (e.g. user is in a parent of many sibling dirs).
 *
 * The walk stops at the system temp directory (os.tmpdir()). A stray
 * project-marker file landing in %TEMP% or /tmp — e.g. from a package manager
 * that runs an install step there — must not be treated as a real project root.
 *
 * `cwd` may be a string (the common case) — Python accepted `Path | str`; the
 * TS port takes string directly since every caller already has one.
 */
export function find_project(cwd: string): Project | null {
  const t0 = Date.now();
  let p: string;
  try {
    p = canonicalize(cwd);
  } catch (err) {
    _LOG.debug(
      `find_project: could not canonicalize cwd ${JSON.stringify(cwd)}: ${(err as Error).message}`,
    );
    return null;
  }
  let sysTemp: string | null;
  try {
    sysTemp = canonicalize(os.tmpdir());
  } catch {
    sysTemp = null;
  }

  let levelsWalked = 0;
  // Walk up via path.dirname until the value stops changing (root). This
  // yields exactly p, p.dirname, p.dirname.dirname, ... up to the filesystem
  // root — the same sequence Python's `(p, *p.parents)` produces.
  let current: string = p;
  // Guard against a dirname loop that never stabilizes (shouldn't happen on
  // real paths, but a malformed input shouldn't hang the walk).
  for (;;) {
    if (sysTemp !== null && current === sysTemp) {
      _LOG.debug(`find_project: stopping walk at system temp dir ${current}`);
      break;
    }
    for (const marker of PROJECT_MARKERS) {
      if (_marker_exists(current, marker)) {
        if (_is_repo_container(current)) {
          _LOG.debug(
            `find_project: skipping container at ${current} (marker=${marker})`,
          );
          break; // not a project — keep walking up
        }
        const elapsed = Date.now() - t0;
        _LOG.debug(
          `find_project: found ${current} (marker=${marker}, levels_walked=${levelsWalked}, ${elapsed}ms)`,
        );
        return {
          root: current,
          hash: project_hash(current),
          marker,
        };
      }
    }
    levelsWalked += 1;
    const parent = path.posix.dirname(current);
    if (parent === current) {
      // Reached the filesystem root (dirname("/") === "/", dirname("c:/") ===
      // "c:/"). Stop the walk.
      break;
    }
    current = parent;
  }
  const elapsed = Date.now() - t0;
  _LOG.debug(
    `find_project: no project found from ${p} (levels_walked=${levelsWalked}, ${elapsed}ms)`,
  );
  return null;
}
