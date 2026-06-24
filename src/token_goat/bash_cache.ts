/**
 * Persistent store for cached Bash tool output.
 *
 * Faithful port of src/token_goat/bash_cache.py.
 *
 * Every PostToolUse(Bash) hook invocation records the command's stdout/stderr to
 * a short text file under `data_dir() / "bash_outputs"` keyed by a content-derived
 * ID. Subsequent invocations of the same command in the same session can detect
 * the duplicate via session.lookup_bash_entry, and agents can retrieve sliced
 * views of any cached output via the `token-goat bash-output` CLI.
 *
 * Parity notes (Python -> TS):
 *  - All byte math uses UTF-8 Buffers (Buffer.from(s, "utf8").length), NEVER
 *    String.length (UTF-16 units). command_hash / glob_hash / grep_hash derive
 *    keys through cache_common.short_content_hash so they are byte-identical to
 *    Python. The truncation in store_output slices on raw UTF-8 bytes and skips
 *    leading continuation bytes at the cut, identical to the Python.
 *  - @dataclass BashOutputMeta -> a TS interface (local; not in types.ts) — a
 *    plain object the sidecar JSON round-trips. exit_code is `number | null`.
 *  - pathlib.Path operations (resolve, parents, .git detection, glob, stem,
 *    is_dir/is_file, stat.st_mtime_ns) -> node:fs + node:path helpers.
 *    st_mtime_ns -> stat.mtimeNs (a BigInt) stringified, matching the
 *    nanosecond-precision integer Python hashes.
 *  - safe_cache_op (cache_common) is a callback-style contextmanager port;
 *    `with safe_cache_op(...): ...` then a trailing `return X` becomes
 *    `const r = safe_cache_op(...); ...`-shaped control flow, mirroring
 *    web_cache.ts / db.ts.
 *  - The module-level mutable `_last_eviction_ts` (eviction throttle) is exposed
 *    through `_setLastEvictionTs` / `_getLastEvictionTs` (registered with
 *    registerReset) so tests can backdate it; store_output reads/writes it and
 *    calls evict_old_entries through the self-namespace so vi.spyOn intercepts
 *    (ESM live-binding = Python's monkeypatch.setattr on the module).
 *  - time.monotonic() -> performance.now()/1000 (seconds). time.time() ->
 *    Date.now()/1000.
 *
 * `verbatimModuleSyntax` is on -> type-only imports use `import type`.
 * `exactOptionalPropertyTypes` is on. `noUncheckedIndexedAccess` is on.
 */

import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { performance } from "node:perf_hooks";

import {
  OUTPUT_FILENAME_RE,
  build_keyed_output_id,
  build_output_id,
  evict_cache_dir,
  get_cache_dir,
  list_cache_outputs,
  load_output_meta_stat,
  load_output_text,
  load_sidecar_json,
  path_mtime_key,
  safe_cache_op,
  safe_join_output_id,
  short_content_hash,
  sidecar_path_for,
  store_blob,
  write_sidecar_metadata,
} from "./cache_common.js";
import type { CacheDirFn, OutputStatDict } from "./cache_common.js";
import { sanitize_log_str } from "./hooks_common.js";
import * as paths from "./paths.js";
import { registerReset } from "./reset.js";
import * as self from "./bash_cache.js";
import { getLogger, normalizePath, stripAnsi } from "./util.js";

export { OUTPUT_FILENAME_RE };

const _LOG = getLogger("bash_cache");

// ===========================================================================
// Public constants (verbatim from bash_cache.py)
// ===========================================================================

/** Total byte budget for the on-disk bash output store (16 MB). */
export const DEFAULT_MAX_TOTAL_BYTES: number = 16 * 1024 * 1024;
/** File-count cap. */
export const DEFAULT_MAX_FILE_COUNT: number = 4096;
/** Minimum output size (bytes) to cache. Default 0 disables the filter. */
export const DEFAULT_MIN_CACHE_BYTES: number = 0;
/** Maximum output size (bytes) to cache per single bash output (50 MB). */
export const DEFAULT_MAX_CACHE_BYTES: number = 50 * 1024 * 1024;

// Minimum gap between eviction scans.
const _EVICTION_THROTTLE_SECONDS: number = 60.0;
let _last_eviction_ts: number = 0.0;

// Monotonic seconds clock (Python's time.monotonic()). performance.now()
// returns ms since process start, which can be < the 60 s throttle window when
// the suite has just started — that would make a `_last_eviction_ts = 0.0`
// baseline (the value tests backdate to, to FORCE eviction) fail the gate. We
// anchor the monotonic reading to a fixed large epoch (process start in Unix
// seconds) so the clock is reliably large and strictly monotonic, exactly like
// time.monotonic(): a 0.0 baseline is always "long ago", and a same-instant
// baseline is "now" (within the window).
const _MONO_EPOCH_SECONDS = Date.now() / 1000 - performance.now() / 1000;

/** Monotonic seconds since an arbitrary fixed epoch (Python time.monotonic()). */
export function _monotonic(): number {
  return _MONO_EPOCH_SECONDS + performance.now() / 1000;
}

registerReset(() => {
  _last_eviction_ts = 0.0;
});

/** Test/internal seam: set the eviction-throttle timestamp (Python module attr). */
export function _setLastEvictionTs(value: number): void {
  _last_eviction_ts = value;
}

/** Test/internal seam: read the eviction-throttle timestamp. */
export function _getLastEvictionTs(): number {
  return _last_eviction_ts;
}

// Sentinel placed at the head of every truncated output file.
const _TRUNC_MARKER = "[token-goat: bash output truncated; stored {n} of {total} bytes]\n";

// Maximum bytes stored per output file (2 MB), tail-preserved (head truncated).
const _MAX_STORED_BYTES: number = 2 * 1024 * 1024;

// Pre-compiled patterns for normalize_command_for_cache_key (hot path).
const _WHITESPACE_RE = /\s+/g;
const _SINGLE_CHAR_FLAG_RE = /^-[a-zA-Z0-9]$/;
// Tools where short-flag sorting improves cache-hit rates.
const _SORT_FLAG_TOOLS: ReadonlySet<string> = new Set(["pytest", "rg", "grep", "git"]);

// git diff / git status: output changes with working-tree state (HEAD + index).
const _GIT_MUTABLE_RE = /^\s*git\s+(diff|status)\b/i;
// git show <full-40-char-sha>: output is immutable for a given SHA.
const _GIT_IMMUTABLE_RE = /^\s*git\s+show\s+[0-9a-f]{40}\b/i;
// Matches git diff with no path scope.
const _GIT_DIFF_UNSCOPED_RE = /^\s*git\s+diff\b/i;
const _GIT_DIFF_SCOPED_RE = /\s--\s+\S/;
// ls/eza/dir/Get-ChildItem: output changes with directory contents.
const _LS_CMD_RE = /^\s*(?:ls|eza|exa|dir|Get-ChildItem|gci)\b/i;
// Tokens that look like flags — skipped when extracting the target path.
const _LS_FLAG_RE = /^-/;
// Dependency-listing commands whose output is fully determined by their lockfile.
const _DEP_LIST_RE =
  /^\s*(?:npm\s+(?:-\S+\s+)*(?:ls|list)\b|pip\s+(?:-\S+\s+)*(?:list|freeze)\b|uv\s+pip\s+(?:-\S+\s+)*(?:list|freeze)\b|pnpm\s+(?:-\S+\s+)*(?:list|ls)\b|yarn\s+(?:-\S+\s+)*(?:list)\b|cargo\s+(?:-\S+\s+)*tree\b|bundle\s+(?:-\S+\s+)*(?:list|show)\b|composer\s+(?:-\S+\s+)*show\b)/i;
// Session-immutable env probes: version strings and binary lookups.
//
// Python: python3?\s+(?:(?-i:-V)\b|--?version) inside an otherwise
// re.IGNORECASE pattern. The (?-i:-V) scoped flag makes ONLY the python
// version short flag case-sensitive (matches `-V`, not `-v`); every other
// alternative is case-insensitive. JS RegExp has no inline scoped flags, so the
// python version probe is split out: the case-insensitive bulk pattern handles
// `python --version` / `-version`, and a dedicated case-sensitive `-V` test
// handles `python -V` while rejecting `python -v`.
const _ENV_PROBE_RE_I =
  /^\s*(?:node\s+(?:-v|--version)|npm\s+(?:-v|--version)|python3?\s+--?version|git\s+--version|uv\s+--version|go\s+version|rustc\s+--version|cargo\s+--version|java\s+--version|ruby\s+--version|gem\s+--version|php\s+--version|which\b|where\b)/i;
// python3? -V — the word `python`/`python3` is case-insensitive (outer
// re.IGNORECASE), the `-V` short flag is case-sensitive (the (?-i:-V) scope).
// Capture the flag token so the case of `-V` vs `-v` can be checked exactly.
const _ENV_PROBE_RE_PYV = /^\s*python3?\s+(-[Vv])\b/i;

// ===========================================================================
// BashOutputMeta (Python @dataclass; not in types.ts -> defined locally)
// ===========================================================================

/** Metadata associated with a cached Bash output entry. */
export interface BashOutputMeta {
  output_id: string;
  cmd_sha: string;
  cmd_preview: string;
  stdout_bytes: number;
  stderr_bytes: number;
  exit_code: number | null;
  ts: number;
  truncated: boolean;
}

// ===========================================================================
// Cache directory
// ===========================================================================

/** Return `data_dir() / "bash_outputs"` and create it on first use. */
export function _bash_outputs_dir(): string {
  return get_cache_dir("bash_outputs");
}

// CacheDirFn-typed reference so the cache_common delegations type-check. It
// reads through the self-namespace so a test that spies on _bash_outputs_dir
// (e.g. to make it throw) is intercepted by every delegating call.
const _bash_outputs_dir_fn: CacheDirFn = () => self._bash_outputs_dir();

// ===========================================================================
// Command classification predicates
// ===========================================================================

/** True for git diff / git status commands whose output changes with working-tree state. */
export function is_git_mutable_command(cmd: string): boolean {
  return _GIT_MUTABLE_RE.test(cmd);
}

/** True for `git show <full-40-char-sha>` — output never changes for a given SHA. */
export function is_git_immutable_command(cmd: string): boolean {
  return _GIT_IMMUTABLE_RE.test(cmd);
}

/** Return a short fingerprint of the git working-tree state rooted at *cwd*, or null. */
export function git_state_fingerprint(cwd: string): string | null {
  try {
    const p = path.resolve(cwd);
    let git_dir: string | null = null;
    // [p, *p.parents] — p then each ancestor up to the root.
    const chain: string[] = [p];
    let cur = p;
    while (true) {
      const parent = path.dirname(cur);
      if (parent === cur) {
        break;
      }
      chain.push(parent);
      cur = parent;
    }
    for (const ancestor of chain) {
      const candidate = path.join(ancestor, ".git");
      let isDir = false;
      let isFile = false;
      try {
        const st = fs.statSync(candidate);
        isDir = st.isDirectory();
        isFile = st.isFile();
      } catch {
        isDir = false;
        isFile = false;
      }
      if (isDir) {
        git_dir = candidate;
        break;
      }
      if (isFile) {
        const text = fs.readFileSync(candidate, "utf8").trim();
        if (text.startsWith("gitdir:")) {
          git_dir = path.resolve(text.slice(7).trim());
        }
        break;
      }
    }
    if (git_dir === null) {
      return null;
    }
    const head_file = path.join(git_dir, "HEAD");
    let headIsFile = false;
    try {
      headIsFile = fs.statSync(head_file).isFile();
    } catch {
      headIsFile = false;
    }
    if (!headIsFile) {
      return null;
    }
    let head_content = fs.readFileSync(head_file, "utf8").trim();
    if (head_content.startsWith("ref: ")) {
      const ref_path = path.join(git_dir, head_content.slice(5).trim());
      let refIsFile = false;
      try {
        refIsFile = fs.statSync(ref_path).isFile();
      } catch {
        refIsFile = false;
      }
      if (refIsFile) {
        head_content = fs.readFileSync(ref_path, "utf8").trim();
      }
    }
    let index_mtime = "";
    const index_file = path.join(git_dir, "index");
    let indexIsFile = false;
    try {
      const st = fs.statSync(index_file, { bigint: true });
      indexIsFile = st.isFile();
      if (indexIsFile) {
        index_mtime = String(st.mtimeNs);
      }
    } catch {
      indexIsFile = false;
    }
    return short_content_hash(`${head_content}\x00${index_mtime}`);
  } catch {
    return null;
  }
}

/** True for ls/eza/dir commands whose output changes with directory contents. */
export function is_dir_listing_command(cmd: string): boolean {
  return _LS_CMD_RE.test(cmd);
}

/** True for version-check and binary-lookup commands whose output is session-immutable. */
export function is_env_probe_command(cmd: string): boolean {
  // The bulk of the pattern is case-insensitive (Python's re.IGNORECASE).
  if (_ENV_PROBE_RE_I.test(cmd)) {
    return true;
  }
  // python -V is case-sensitive in Python ((?-i:-V)). An uppercase -V matches;
  // a lowercase -v does NOT. The `python` word remains case-insensitive.
  const m = _ENV_PROBE_RE_PYV.exec(cmd);
  if (m !== null) {
    return m[1] === "-V";
  }
  return false;
}

/** True when cmd is a git diff with no path scope (no ' -- <path>' suffix). */
export function is_unscoped_git_diff(cmd: string): boolean {
  if (!_GIT_DIFF_UNSCOPED_RE.test(cmd)) {
    return false;
  }
  return !_GIT_DIFF_SCOPED_RE.test(cmd);
}

/** True for dependency-listing commands whose output is fully determined by their lockfile. */
export function is_dep_list_command(cmd: string): boolean {
  return _DEP_LIST_RE.test(cmd);
}

// Lockfile names keyed by the leading tool token extracted from the command.
const _DEP_LOCKFILES: Record<string, string[]> = {
  npm: ["package-lock.json", "yarn.lock"],
  pip: ["requirements.txt"],
  uv: ["uv.lock", "requirements.txt"],
  pnpm: ["pnpm-lock.yaml"],
  yarn: ["yarn.lock"],
  cargo: ["Cargo.lock"],
  bundle: ["Gemfile.lock"],
  composer: ["composer.lock"],
};

/** Return a 16-char hex SHA-256 of the relevant lockfile for *cmd* run in *cwd*, or null. */
export function dep_lockfile_fingerprint(cmd: string, cwd: string | null): string | null {
  if (cwd === null) {
    return null;
  }
  const stripped = cmd.trim();
  const firstToken = stripped ? stripped.split(/\s+/)[0]!.toLowerCase() : "";
  let candidates: string[];
  if (firstToken === "uv") {
    candidates = _DEP_LOCKFILES["uv"] ?? [];
  } else {
    candidates = _DEP_LOCKFILES[firstToken] ?? [];
  }
  if (candidates.length === 0) {
    return null;
  }
  for (const lockfile_name of candidates) {
    const lockfile = path.join(cwd, lockfile_name);
    try {
      const raw = fs.readFileSync(lockfile);
      return createHash("sha256").update(raw).digest("hex").slice(0, 16);
    } catch {
      continue;
    }
  }
  return null;
}

/** Return the directory path targeted by a listing command, or cwd. */
function _extract_ls_target(cmd: string, cwd: string | null): string | null {
  const tokens = cmd.trim().split(/\s+/);
  for (const token of tokens.slice(1)) {
    if (!_LS_FLAG_RE.test(token)) {
      return token;
    }
  }
  return cwd;
}

/** Return a short fingerprint sensitive to namespace changes in a directory, or null. */
export function dir_state_fingerprint(p: string): string | null {
  try {
    let isDir = false;
    let mtimeNs: bigint;
    try {
      const st = fs.statSync(p, { bigint: true });
      isDir = st.isDirectory();
      mtimeNs = st.mtimeNs;
    } catch {
      return null;
    }
    if (!isDir) {
      return null;
    }
    return short_content_hash(String(mtimeNs));
  } catch {
    return null;
  }
}

// ===========================================================================
// Command normalization
// ===========================================================================

/** Normalize a command string before hashing to increase cache hit rate. */
export function normalize_command_for_cache_key(cmd: string): string {
  // Step 1: Strip outer whitespace.
  let normalized = cmd.trim();

  // Step 2: Normalize internal whitespace to single spaces.
  normalized = normalized.replace(_WHITESPACE_RE, " ");

  // Step 3: Normalize Windows path separators within tokens.
  {
    const tokens = normalized.split(" ");
    const normalized_tokens: string[] = [];
    for (const token of tokens) {
      normalized_tokens.push(token.replace(/\\/g, "/"));
    }
    normalized = normalized_tokens.join(" ");
  }

  // Step 3.5: Normalize redundant path prefixes / suffixes.
  {
    const tokens = normalized.split(" ");
    const normalized_tokens: string[] = [];
    const operators = new Set(["&&", "||", "|", ">", ">>", ";", "&"]);
    for (let token of tokens) {
      if (token.startsWith("-") || operators.has(token)) {
        normalized_tokens.push(token);
        continue;
      }
      if (token) {
        // Strip leading ./ but not ../
        if (token.startsWith("./") && !token.startsWith("../")) {
          token = token.slice(2);
        }
        // Strip trailing / unless the token is just '/' (filesystem root).
        if (token.endsWith("/") && token !== "/") {
          token = token.replace(/\/+$/, "");
        }
        // After stripping "./" the token may be empty — normalise to ".".
        if (!token) {
          token = ".";
        }
      }
      normalized_tokens.push(token);
    }
    normalized = normalized_tokens.join(" ");
  }

  // Step 4: Sort single-char flags for common tools.
  const tokens = normalized.split(" ");
  if (tokens.length === 0) {
    return normalized;
  }

  // Extract tool name: skip 'uv run' if present.
  let tool_start_idx = 0;
  if (tokens.length >= 2 && tokens[0] === "uv" && tokens[1] === "run") {
    tool_start_idx = 2;
  }
  if (tool_start_idx >= tokens.length) {
    return normalized;
  }

  const tool = tokens[tool_start_idx]!;

  if (_SORT_FLAG_TOOLS.has(tool) && tokens.length > tool_start_idx + 1) {
    const pre_tool = tokens.slice(0, tool_start_idx);
    const tool_and_args = tokens.slice(tool_start_idx);

    const cmd_tool = tool_and_args[0]!;
    const rest = tool_and_args.slice(1);

    const single_char_flags: string[] = [];
    const other_args: string[] = [];
    let found_non_flag = false;

    for (const token of rest) {
      if (!found_non_flag && _SINGLE_CHAR_FLAG_RE.test(token)) {
        single_char_flags.push(token);
      } else {
        found_non_flag = true;
        other_args.push(token);
      }
    }

    if (single_char_flags.length > 0) {
      // Python list.sort() — lexicographic ascending by code point.
      single_char_flags.sort();
      normalized = [...pre_tool, cmd_tool, ...single_char_flags, ...other_args].join(" ");
    }
    // else: no change needed.
  }

  return normalized;
}

/** Return a short content hash for *command* scoped to *cwd*. */
export function command_hash(command: string, cwd: string | null = null): string {
  const normalized = normalize_command_for_cache_key(command);
  let key = cwd === null ? normalized : `${normalizePath(cwd)}\x00${normalized}`;
  // git diff/status: salt the key with the working-tree fingerprint.
  if (cwd !== null && self.is_git_mutable_command(command)) {
    const fp = self.git_state_fingerprint(normalizePath(cwd));
    if (fp !== null) {
      key = `${key}\x00git:${fp}`;
    }
  }
  // Directory-listing commands: salt with the target directory's mtime.
  if (cwd !== null && self.is_dir_listing_command(command)) {
    const norm_cwd = normalizePath(cwd);
    const raw_target = _extract_ls_target(command, norm_cwd);
    if (raw_target !== null) {
      const resolved_target = path.isAbsolute(raw_target)
        ? raw_target
        : path.join(norm_cwd, raw_target);
      const fp = self.dir_state_fingerprint(resolved_target);
      if (fp !== null) {
        key = `${key}\x00dir:${fp}`;
      }
    }
  }
  // Dependency-listing commands: salt with the lockfile hash.
  if (self.is_dep_list_command(command)) {
    const fp = self.dep_lockfile_fingerprint(command, cwd);
    if (fp !== null) {
      key = `${key}\x00lockfile:${fp}`;
    }
  }
  return short_content_hash(key);
}

// ===========================================================================
// Glob result cache
// ===========================================================================

/** Return a content hash for a (pattern, path) Glob call key. */
export function glob_hash(pattern: string, p: string | null): string {
  const canonical = `${pattern}\x00${p || ""}`;
  return short_content_hash(canonical);
}

const _GLOB_RESULT_PREFIX = "glob_";

/** Cache the text result of a Glob call and return the output_id, or null on error. */
export function store_glob_result(
  session_id: string,
  pattern: string,
  p: string | null,
  result_text: string,
  opts?: { max_total_bytes?: number; max_file_count?: number },
): string | null {
  const max_total_bytes = opts?.max_total_bytes ?? DEFAULT_MAX_TOTAL_BYTES;
  const max_file_count = opts?.max_file_count ?? DEFAULT_MAX_FILE_COUNT;
  try {
    const g_hash = glob_hash(pattern, p);
    const out_id = build_keyed_output_id(_GLOB_RESULT_PREFIX, session_id, g_hash);
    if (store_blob(out_id, result_text, _bash_outputs_dir_fn, "bash_cache") === null) {
      return null;
    }
    self.evict_old_entries({ max_total_bytes, max_file_count });
    _LOG.debug("bash_cache: stored glob result id=%s pattern=%s", out_id, sanitize_log_str(pattern));
    return out_id;
  } catch (exc) {
    if (isOSError(exc)) {
      _LOG.debug("bash_cache: glob store failed: %s", exc);
      return null;
    }
    throw exc;
  }
}

/** Return the cached Glob result text for *(session_id, pattern, path)*, or null. */
export function load_glob_result(
  session_id: string,
  pattern: string,
  p: string | null,
): string | null {
  try {
    const g_hash = glob_hash(pattern, p);
    const out_id = build_keyed_output_id(_GLOB_RESULT_PREFIX, session_id, g_hash);
    return load_output_text(out_id, _bash_outputs_dir_fn, "bash_cache");
  } catch {
    return null;
  }
}

// ===========================================================================
// Grep result cache
// ===========================================================================

const _GREP_RESULT_PREFIX = "grep_";
const _DOT_SLASH_RE = /^(\.\/)+/;

/** Normalize a grep search path for cache key stability. */
function _normalize_grep_path(p: string): string {
  let s = p.replace(/\\/g, "/");
  s = s.replace(_DOT_SLASH_RE, "");
  const strippedTrail = s.replace(/\/+$/, "");
  return strippedTrail || s;
}

/** Return a content hash for a Grep call's full key tuple. */
export function grep_hash(
  pattern: string,
  p: string | null,
  glob_filter: string | null,
  type_filter: string | null,
  output_mode: string | null,
): string {
  const canonical = [
    pattern,
    p ? _normalize_grep_path(p) : "",
    glob_filter || "",
    type_filter || "",
    output_mode || "",
  ].join("\x00");
  return short_content_hash(canonical);
}

/** Cache the text result of a Grep call and return the output_id, or null on error. */
export function store_grep_result(
  session_id: string,
  pattern: string,
  p: string | null,
  glob_filter: string | null,
  type_filter: string | null,
  output_mode: string | null,
  result_text: string,
  opts?: { max_total_bytes?: number; max_file_count?: number },
): string | null {
  const max_total_bytes = opts?.max_total_bytes ?? DEFAULT_MAX_TOTAL_BYTES;
  const max_file_count = opts?.max_file_count ?? DEFAULT_MAX_FILE_COUNT;
  try {
    const g_hash = grep_hash(pattern, p, glob_filter, type_filter, output_mode);
    const out_id = build_keyed_output_id(_GREP_RESULT_PREFIX, session_id, g_hash);
    if (store_blob(out_id, result_text, _bash_outputs_dir_fn, "bash_cache") === null) {
      return null;
    }
    self.evict_old_entries({ max_total_bytes, max_file_count });
    _LOG.debug("bash_cache: stored grep result id=%s pattern=%s", out_id, sanitize_log_str(pattern));
    return out_id;
  } catch (exc) {
    if (isOSError(exc)) {
      _LOG.debug("bash_cache: grep store failed: %s", exc);
      return null;
    }
    throw exc;
  }
}

/** Return the cached Grep result text for the given key tuple, or null. */
export function load_grep_result(
  session_id: string,
  pattern: string,
  p: string | null,
  glob_filter: string | null,
  type_filter: string | null,
  output_mode: string | null,
): string | null {
  try {
    const g_hash = grep_hash(pattern, p, glob_filter, type_filter, output_mode);
    const out_id = build_keyed_output_id(_GREP_RESULT_PREFIX, session_id, g_hash);
    return load_output_text(out_id, _bash_outputs_dir_fn, "bash_cache");
  } catch {
    return null;
  }
}

// ===========================================================================
// output_id_for / store_output / load_output
// ===========================================================================

/** Build a filesystem-safe ID for the (session, command, time) tuple. */
export function output_id_for(
  session_id: string,
  command: string,
  ts?: number,
  opts?: { cwd?: string | null },
): string {
  const cwd = opts?.cwd ?? null;
  return build_output_id(session_id, command_hash(command, cwd), ts);
}

/** True when err is an OSError-equivalent (Node ErrnoException with a code). */
function isOSError(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    typeof (err as NodeJS.ErrnoException).code === "string"
  );
}

/** Write *stdout* + *stderr* to the cache and return descriptive metadata, or null. */
export function store_output(
  session_id: string,
  command: string,
  stdout: string,
  stderr: string,
  exit_code: number | null,
  opts?: {
    cwd?: string | null;
    max_total_bytes?: number;
    max_file_count?: number;
    min_cache_bytes?: number;
    max_cache_bytes?: number;
  },
): BashOutputMeta | null {
  const cwd = opts?.cwd ?? null;
  const max_total_bytes = opts?.max_total_bytes ?? DEFAULT_MAX_TOTAL_BYTES;
  const max_file_count = opts?.max_file_count ?? DEFAULT_MAX_FILE_COUNT;
  const min_cache_bytes = opts?.min_cache_bytes ?? DEFAULT_MIN_CACHE_BYTES;
  const max_cache_bytes = opts?.max_cache_bytes ?? DEFAULT_MAX_CACHE_BYTES;

  // Strip ANSI/VT100 escape sequences before storing so cached content is clean.
  const cleanStdout = stripAnsi(stdout);
  const cleanStderr = stripAnsi(stderr);

  let meta: BashOutputMeta | null = null;

  const result = safe_cache_op("store_output", { log: _LOG }, (): BashOutputMeta | null => {
    const stdout_bytes = Buffer.from(cleanStdout, "utf8").length;
    const stderr_bytes = Buffer.from(cleanStderr, "utf8").length;
    const total = stdout_bytes + stderr_bytes;

    // Check size thresholds.
    if (total < min_cache_bytes) {
      _LOG.debug(
        "bash_cache: output too small (%d bytes < min %d); skipping cache",
        total,
        min_cache_bytes,
      );
      return null;
    }
    if (total > max_cache_bytes) {
      _LOG.debug(
        "bash_cache: output too large (%d bytes > max %d); skipping cache",
        total,
        max_cache_bytes,
      );
      return null;
    }

    const out_id = output_id_for(session_id, command, undefined, { cwd });
    const p = safe_join_output_id(out_id, _bash_outputs_dir_fn, "bash_cache");
    if (p === null) {
      return null;
    }

    let truncated = false;
    const body_parts: string[] = [];

    if (total > _MAX_STORED_BYTES) {
      // Preserve the tail. Compose the combined stream, slice on raw utf-8 bytes.
      let combined = cleanStdout;
      if (cleanStderr) {
        combined = cleanStdout
          ? `${cleanStdout}\n--- stderr ---\n${cleanStderr}`
          : cleanStderr;
      }
      const combined_bytes = Buffer.from(combined, "utf8");
      let keep_bytes = combined_bytes.subarray(combined_bytes.length - _MAX_STORED_BYTES);
      // Advance past any utf-8 continuation bytes at the cut boundary.
      let skip = 0;
      while (skip < keep_bytes.length && (keep_bytes[skip]! & 0xc0) === 0x80) {
        skip += 1;
      }
      if (skip) {
        keep_bytes = keep_bytes.subarray(skip);
      }
      const keep = keep_bytes.toString("utf8");
      body_parts.push(
        _TRUNC_MARKER.replace("{n}", String(_MAX_STORED_BYTES)).replace("{total}", String(total)),
      );
      body_parts.push(keep);
      truncated = true;
    } else {
      if (cleanStdout) {
        body_parts.push(cleanStdout);
      }
      if (cleanStderr) {
        if (cleanStdout) {
          body_parts.push("\n--- stderr ---\n");
        }
        body_parts.push(cleanStderr);
      }
    }

    const body = body_parts.join("");
    paths.atomicWriteText(p, body);

    const m: BashOutputMeta = {
      output_id: out_id,
      cmd_sha: command_hash(command, cwd),
      cmd_preview: sanitize_log_str(command, 120),
      stdout_bytes,
      stderr_bytes,
      exit_code,
      ts: Date.now() / 1000,
      truncated,
    };

    _LOG.debug("bash_cache: stored id=%s bytes=%d truncated=%s", out_id, total, truncated);
    return m;
  });

  // safe_cache_op returns undefined when it suppressed an OSError; the body's
  // own `return null` (skipped/failed) also means no meta.
  meta = result === undefined ? null : result;

  // Best-effort eviction runs OUTSIDE safe_cache_op so an OSError during the
  // directory walk never discards a confirmed write (the file is already on disk).
  if (meta !== null) {
    try {
      const now = self._monotonic();
      if (now - _last_eviction_ts >= _EVICTION_THROTTLE_SECONDS) {
        _last_eviction_ts = now;
        self.evict_old_entries({ max_total_bytes, max_file_count });
      }
    } catch (exc) {
      if (isOSError(exc)) {
        _LOG.warning("bash_cache: eviction failed (best-effort): %s", exc);
      } else {
        throw exc;
      }
    }
  }
  return meta;
}

/** Return the cached output body for *output_id*, or null if absent. */
export function load_output(output_id: string): string | null {
  return load_output_text(output_id, _bash_outputs_dir_fn, "bash_cache");
}

/** Return stat-derived metadata for an output file (size, mtime), or null. */
export function load_output_meta(output_id: string): OutputStatDict | null {
  return load_output_meta_stat(output_id, _bash_outputs_dir_fn, "bash_cache");
}

// ===========================================================================
// eviction / listing
// ===========================================================================

/** Evict the oldest entries until total size is at or under *max_total_bytes*. */
export function evict_old_entries(opts?: {
  max_total_bytes?: number;
  max_file_count?: number;
}): number {
  const max_total_bytes = opts?.max_total_bytes ?? DEFAULT_MAX_TOTAL_BYTES;
  const max_file_count = opts?.max_file_count ?? DEFAULT_MAX_FILE_COUNT;
  return evict_cache_dir({
    cache_dir_fn: _bash_outputs_dir_fn,
    log_name: "bash_cache",
    max_total_bytes,
    max_file_count,
  });
}

/** Return metadata for every cached output, newest first. */
export function list_outputs(): OutputStatDict[] {
  return list_cache_outputs(_bash_outputs_dir_fn);
}

// ===========================================================================
// sidecar read / write
// ===========================================================================

/** Return the sidecar JSON metadata path for *output_id*, or null on invalid ID. */
export function sidecar_meta_path(output_id: string): string | null {
  const base = safe_join_output_id(output_id, _bash_outputs_dir_fn, "bash_cache");
  if (base === null) {
    return null;
  }
  return sidecar_path_for(base);
}

/** Persist *meta* as a JSON sidecar next to its output file (best-effort). */
export function write_sidecar(meta: BashOutputMeta): void {
  write_sidecar_metadata(
    sidecar_meta_path(meta.output_id),
    meta as unknown as Record<string, unknown>,
    { log: _LOG, log_prefix: "bash_cache" },
  );
}

/** Return parsed BashOutputMeta from the sidecar JSON, or null. */
export function read_sidecar(output_id: string): BashOutputMeta | null {
  const p = sidecar_meta_path(output_id);
  if (p === null) {
    return null;
  }
  const data = load_sidecar_json(p);
  if (data === null) {
    return null;
  }
  try {
    const rawExit = data["exit_code"];
    const exit_code =
      typeof rawExit === "number" && Number.isFinite(rawExit) ? Math.trunc(rawExit) : null;
    return {
      output_id: String(data["output_id"] ?? output_id),
      cmd_sha: String(data["cmd_sha"] ?? ""),
      cmd_preview: String(data["cmd_preview"] ?? ""),
      stdout_bytes: _toInt(data["stdout_bytes"], 0),
      stderr_bytes: _toInt(data["stderr_bytes"], 0),
      exit_code,
      ts: _toFloat(data["ts"], 0.0),
      truncated: Boolean(data["truncated"] ?? false),
    };
  } catch {
    return null;
  }
}

/** Coerce a sidecar value to an int (Python `int(data.get(k, default))`). */
function _toInt(value: unknown, def: number): number {
  if (typeof value === "number" && Number.isFinite(value)) {
    return Math.trunc(value);
  }
  if (typeof value === "string") {
    const n = Number(value.trim());
    if (Number.isFinite(n)) {
      return Math.trunc(n);
    }
  }
  return def;
}

/** Coerce a sidecar value to a float (Python `float(data.get(k, default))`). */
function _toFloat(value: unknown, def: number): number {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string") {
    const n = Number(value.trim());
    if (Number.isFinite(n)) {
      return n;
    }
  }
  return def;
}

// ===========================================================================
// get_recent_error_outputs
// ===========================================================================

/** Return up to *max_entries* recent bash outputs with errors, for manifest assist. */
export function get_recent_error_outputs(
  session_id: string,
  max_entries = 5,
): Array<{ command: string; error_summary: string }> {
  const result: Array<{ command: string; error_summary: string }> = [];

  safe_cache_op("get_recent_error_outputs", { log: _LOG }, () => {
    try {
      const cache_dir = self._bash_outputs_dir();
      let isDir = false;
      try {
        isDir = fs.statSync(cache_dir).isDirectory();
      } catch {
        isDir = false;
      }
      if (!isDir) {
        return;
      }

      // cache_dir.glob("*.json"), sorted newest-first.
      const jsonEntries: string[] = [];
      for (const entryName of fs.readdirSync(cache_dir)) {
        if (entryName.endsWith(".json")) {
          jsonEntries.push(path.join(cache_dir, entryName));
        }
      }
      jsonEntries.sort((a, b) => path_mtime_key(b) - path_mtime_key(a));

      for (const sidecar_path of jsonEntries) {
        if (result.length >= max_entries) {
          break;
        }
        const candidate_id = _stem(sidecar_path);
        // Skip glob-result entries.
        if (candidate_id.startsWith("glob_")) {
          continue;
        }
        const meta = self.read_sidecar(candidate_id);
        if (meta === null) {
          continue;
        }
        // Filter by session_id.
        if (
          session_id &&
          !(candidate_id.includes(session_id) || String(meta.output_id).includes(session_id))
        ) {
          continue;
        }

        let has_error = false;
        let error_summary = "";

        // First try to extract error pattern from output.
        if (meta.stdout_bytes + meta.stderr_bytes > 0) {
          try {
            const raw_output = self.load_output(candidate_id);
            if (raw_output) {
              for (const line of _splitlines(raw_output)) {
                const stripped = line.trim();
                if (
                  ["Error:", "FAILED", "Traceback", "error:"].some((pattern) =>
                    stripped.includes(pattern),
                  )
                ) {
                  error_summary = sanitize_log_str(stripped, 120);
                  has_error = true;
                  break;
                }
              }
            }
          } catch {
            // pass
          }
        }

        // If no pattern match, check for non-zero exit code.
        if (!has_error && typeof meta.exit_code === "number" && meta.exit_code !== 0) {
          has_error = true;
        }

        if (has_error) {
          const cmd = sanitize_log_str(meta.cmd_preview, 80);
          if (!error_summary) {
            error_summary = meta.exit_code ? `exit ${meta.exit_code}` : "unknown error";
          }
          result.push({ command: cmd, error_summary });
        }
      }
    } catch {
      // pass
    }
  });

  return result;
}

/** Return the most recent on-disk cached entry for *command*, or null. */
export function find_cached_for_command(
  command: string,
  cwd: string | null = null,
): BashOutputMeta | null {
  const target_sha = command_hash(command, cwd);
  let best: BashOutputMeta | null = null;

  safe_cache_op("find_cached_for_command", { log: _LOG }, () => {
    const cache_dir = self._bash_outputs_dir();
    let isDir = false;
    try {
      isDir = fs.statSync(cache_dir).isDirectory();
    } catch {
      isDir = false;
    }
    if (!isDir) {
      return;
    }
    // cache_dir.glob("*.json"), sorted newest-first. path_mtime_key swallows a
    // per-file OSError and returns 0.0, so a concurrently-deleted sidecar sorts
    // to the bottom rather than raising (TOCTOU tolerance).
    const jsonEntries: string[] = [];
    for (const entryName of fs.readdirSync(cache_dir)) {
      if (entryName.endsWith(".json")) {
        jsonEntries.push(path.join(cache_dir, entryName));
      }
    }
    jsonEntries.sort((a, b) => path_mtime_key(b) - path_mtime_key(a));

    for (const sidecar_path of jsonEntries) {
      const candidate_id = _stem(sidecar_path);
      // Skip glob-result entries.
      if (candidate_id.startsWith("glob_")) {
        continue;
      }
      const meta = self.read_sidecar(candidate_id);
      if (meta === null) {
        continue;
      }
      if (meta.cmd_sha === target_sha && meta.stdout_bytes + meta.stderr_bytes > 0) {
        best = meta;
        break; // sorted newest-first; first match is the freshest
      }
    }
  });

  return best;
}

// ===========================================================================
// Small pathlib.Path / str helpers
// ===========================================================================

/** Python Path.stem — final component without its last suffix. */
function _stem(p: string): string {
  const base = path.basename(p);
  const dot = base.lastIndexOf(".");
  if (dot > 0) {
    return base.slice(0, dot);
  }
  return base;
}

/**
 * Python str.splitlines(): split on universal newlines and drop a trailing
 * empty produced by a final newline. The error-pattern scan only inspects each
 * line's stripped content, so the exact line-boundary set matters less than
 * not emitting a spurious trailing empty; \n / \r\n / \r are all handled.
 */
function _splitlines(s: string): string[] {
  if (s === "") {
    return [];
  }
  const parts = s.split(/\r\n|\r|\n/);
  if (parts.length > 0 && parts[parts.length - 1] === "") {
    parts.pop();
  }
  return parts;
}
