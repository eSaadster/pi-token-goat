/**
 * bash_compress POST-BASH HELPERS — TypeScript port of the 28 CLASS-LESS,
 * module-level helper functions from src/token_goat/bash_compress.py that the
 * post_bash read hook (hooks_read.post_bash) reaches via the bash_compress
 * barrel namespace (`_bcFn(name)` / `_bcRe(name)`).
 *
 * Runs 1-9 ported the FILTER CLASSES; these standalone command-type / output
 * detectors, dispatch predicates, and the three lightweight post-bash
 * compressors were skipped. Without them, hooks_read's `_bcFn(...)` lookups
 * resolve to `undefined` and ~18 per-command compression blocks self-guard to a
 * no-op. Porting + EXPORTING these names (the barrel re-exports this module)
 * lights those blocks up.
 *
 * The 28 helpers (Python def line numbers in bash_compress.py):
 *   command-type / output detectors + dispatch predicates (small, verbatim):
 *     _dir_listing_cmd_type (L1108), _sleep_cmd_type (L1147),
 *     _watch_cmd_info (L1173), _is_git_log_cmd (L1278),
 *     _is_pkg_install_cmd (L1300), _is_env_list_cmd (L1355),
 *     _is_container_log_cmd (L1409), _is_poll_loop_cmd (L1457),
 *     _is_junit_xml_output (L1497), _is_verbose_test_cmd (L2226),
 *     _is_cargo_compile_cmd (L3025), _is_go_test_verbose_cmd (L3105),
 *     _is_make_cmd (L3144), _is_python_script_cmd (L3195),
 *     _is_minified_file (L9937), _has_minified_grep_hit (L9942),
 *     _is_grep_cmd (L9961), _is_jest_cmd (L25889), _has_jest_output (L25918),
 *     _has_vitest_output (L25928), _is_curl_verbose_cmd (L26013),
 *     _has_curl_verbose_output (L26037), _is_docker_build_cmd (L26145),
 *     _has_docker_build_output (L26160).
 *   the three real compressors (byte-faithful, return Python tuples):
 *     compress_jest_output (L25936)   -> [string, number, number]
 *                                        (compressed_text, pass_count, fail_count)
 *     compress_curl_verbose (L26046)  -> [string, number]
 *                                        (compressed_text, lines_removed)
 *     compress_docker_build (L26168)  -> [string, number]
 *                                        (compressed_text, lines_removed)
 * Plus the EXPORTED regex `_VT_PASSED_LINE_RE` (hooks_read reads it via
 * `_bcRe("_VT_PASSED_LINE_RE")`).
 *
 * NOT re-ported here (already resolve on the barrel from earlier runs):
 *   _is_tsc_cmd (node_tools.ts), _task_output_id (framework.ts).
 *
 * ---------------------------------------------------------------------------
 * Parity notes (Python -> TS)
 * ---------------------------------------------------------------------------
 *  - Python identifiers preserved EXACTLY (snake_case helpers, the SCREAMING
 *    regex names). Every public name in this module is a NEW symbol on the
 *    barrel (no clash with framework / filter-module exports), so the
 *    `export * from "./bash_compress/post_bash_helpers.js"` in the barrel adds
 *    no TS2308 ambiguity.
 *  - re.compile(...) -> top-level RegExp compiled once. re.IGNORECASE -> "i".
 *    re.MULTILINE -> "m" (the docker step/summary detectors use it for
 *    `_has_docker_build_output`'s `.search()` over the whole stdout).
 *  - Python re.Pattern.match(s) is START-anchored -> _reMatch (non-global clone
 *    + index===0). re.search(...) / re.fullmatch(...) -> _reSearch / _reFull.
 *    _nonGlobal/_reMatch/_reSearch/_reFull are framework-module-PRIVATE (NOT
 *    exported), so they are RE-DECLARED here module-private (same source as
 *    framework / cli_utils_a) — NOT exported, to avoid duplicate-export TS2308.
 *  - The dispatch building block `_first_positional` and the per-tool
 *    "value flag" frozensets (_GIT_GLOBAL_VALUE_FLAGS, _PIP_VALUE_FLAGS, ...)
 *    do NOT exist anywhere in the TS port (the FILTER CLASSES use their own
 *    positionals helpers), so they are ported here MODULE-PRIVATE.
 *  - The eight jest/vitest regexes the compressor + detectors read
 *    (_JEST_NPM_CMD_RE, _JEST_WORD_DETECT_RE, _VT_FILE_PASS_RE, _VT_FILE_FAIL_RE,
 *    _VITEST_TEST_PASS_RE, _JEST_PASS_LINE_RE, _JEST_FAIL_LINE_RE,
 *    _JEST_PASS_TICK_RE) exist in test_runners.ts but are MODULE-PRIVATE there;
 *    they are re-declared here module-private, byte-faithful to their Python
 *    sources (L2482/2488/2660 for the JestFilter trio, L25876+ for the rest).
 *  - `_VT_VERBOSE_FLAGS` (used only by _is_verbose_test_cmd) is module-private;
 *    only `_VT_PASSED_LINE_RE` is exported (hooks_read reads it via _bcRe).
 *  - Python str.splitlines() / str.splitlines(keepends=True) span a broad
 *    boundary set (\n \r \r\n \v \f \x1c \x1d \x1e \x85 U+2028 U+2029). These
 *    helpers run on RAW stdout (NOT normalise()d), so a faithful local
 *    _splitlines / _splitlinesKeepends shim is used (same source as e2e.ts /
 *    hooks_read.ts). The keepends variant emits NO trailing empty element for a
 *    trailing terminator; the no-keepends variant strips terminators and also
 *    drops the trailing empty element.
 *  - Python str.strip("\"'") -> _stripQuotes (strip leading/trailing ASCII
 *    single/double quotes only). Python pathlib.Path(s).stem.lower() ->
 *    _pathStemLower (final component, LAST suffix stripped, lowercased) — same
 *    source as cli_utils_a.ts.
 *  - shlex.split(seg, posix=False) -> framework._shlexSplit(seg,{posix:false});
 *    the Python ValueError fallback (`seg.strip().split()`) -> catch + whitespace
 *    split. split_compound lives UP one level in ../bash_parser.js.
 *  - The three compressors return Python tuples; ported as TS readonly tuple
 *    arrays matching the arity hooks_read destructures (verified against the
 *    jest/curl/docker blocks ~L6710/6756/6808): [str,int,int] / [str,int] /
 *    [str,int]. `"".join(out)` -> out.join(""). list.append -> Array.push.
 *  - Byte/length math here is character-length only (the Python originals use
 *    `len(...)` on str, i.e. code points), so no Buffer round-trip is needed —
 *    matching Python str semantics directly via String#length on the same
 *    (already-decoded) text.
 *  - No module-global MUTABLE state: every counter/list is local; no reset seam.
 *
 * verbatimModuleSyntax is on -> nothing imported here is type-only.
 * noUncheckedIndexedAccess is on -> every indexed access is narrowed.
 */

import { _shlexSplit } from "./framework.js";
import { split_compound } from "../bash_parser.js";

// ===========================================================================
// Internal Python-builtin / stdlib shims local to this module.
// ===========================================================================

/** Return a clone of re without the global/sticky flags (one-shot .exec/.test). */
function _nonGlobal(re: RegExp): RegExp {
  const flags = re.flags.replace(/[gy]/g, "");
  return new RegExp(re.source, flags);
}

/**
 * Python re.Pattern.match(s) — anchored at the START (NOT end-anchored). JS has
 * no anchored-match primitive; emulate via a non-global clone and index===0.
 */
function _reMatch(re: RegExp, s: string): boolean {
  const r = _nonGlobal(re);
  const m = r.exec(s);
  return m !== null && m.index === 0;
}

/** Python re.search(...) — boolean "matches anywhere". */
function _reSearch(re: RegExp, text: string): boolean {
  return _nonGlobal(re).test(text);
}

/**
 * Python re.fullmatch(pattern, s) — the WHOLE string must match. Emulated with a
 * non-global clone whose match starts at 0 and consumes the entire string.
 */
function _reFull(re: RegExp, s: string): boolean {
  const r = _nonGlobal(re);
  const m = r.exec(s);
  return m !== null && m.index === 0 && m[0].length === s.length;
}

/** Python str.strip("\"'") — strip leading/trailing ASCII single/double quotes. */
function _stripQuotes(s: string): string {
  let start = 0;
  let end = s.length;
  while (start < end && (s[start] === '"' || s[start] === "'")) {
    start++;
  }
  while (end > start && (s[end - 1] === '"' || s[end - 1] === "'")) {
    end--;
  }
  return s.slice(start, end);
}

/**
 * pathlib.Path(s).stem.lower() — lowercased final path component with its LAST
 * suffix stripped. A leading-dot-only name (".bashrc") or a trailing-dot name
 * ("docker.") is treated as having NO suffix (CPython semantics). Same source
 * as cli_utils_a.ts.
 */
function _pathStemLower(s: string): string {
  const norm = s.replace(/\\/g, "/");
  const trimmed = norm.replace(/\/+$/, "");
  const idx = trimmed.lastIndexOf("/");
  const name = idx >= 0 ? trimmed.slice(idx + 1) : trimmed;
  const dot = name.lastIndexOf(".");
  let stem: string;
  if (dot <= 0 || dot === name.length - 1) {
    stem = name;
  } else {
    stem = name.slice(0, dot);
  }
  return stem.toLowerCase();
}

/**
 * Python str.splitlines(keepends=True): split at line boundaries and KEEP each
 * terminator on its line. Boundaries mirrored from CPython: \n \r\n \r \v \f
 * \x1c \x1d \x1e \x85 U+2028 U+2029. A final line with no terminator is still
 * emitted; a trailing terminator produces NO extra empty element. Returns []
 * for the empty string. Same source as e2e.ts / hooks_read.ts.
 */
function _splitlinesKeepends(s: string): string[] {
  if (s.length === 0) return [];
  const out: string[] = [];
  let start = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    let boundaryLen = 0;
    if (c === 0x0a) {
      // \n
      boundaryLen = 1;
    } else if (c === 0x0d) {
      // \r — or \r\n if followed by \n
      boundaryLen = s.charCodeAt(i + 1) === 0x0a ? 2 : 1;
    } else if (
      c === 0x0b || // \v
      c === 0x0c || // \f
      (c >= 0x1c && c <= 0x1e) || // \x1c \x1d \x1e (file/group/record separators)
      c === 0x85 || // NEL
      c === 0x2028 || // line separator
      c === 0x2029 // paragraph separator
    ) {
      boundaryLen = 1;
    }
    if (boundaryLen > 0) {
      out.push(s.slice(start, i + boundaryLen));
      start = i + boundaryLen;
      if (boundaryLen === 2) {
        i++; // consume the \n of a \r\n pair
      }
    }
  }
  if (start < s.length) {
    out.push(s.slice(start));
  }
  return out;
}

/**
 * Python str.splitlines() WITHOUT keepends. Same broad boundary set as the
 * keepends variant; terminators are dropped and a trailing terminator produces
 * NO extra empty element (derived from _splitlinesKeepends by trimming a single
 * trailing line terminator from each emitted line).
 */
function _splitlines(s: string): string[] {
  return _splitlinesKeepends(s).map((line) => {
    // Trim a single trailing terminator (1 or 2 chars for \r\n).
    const n = line.length;
    if (n === 0) return line;
    const last = line.charCodeAt(n - 1);
    if (last === 0x0a) {
      if (n >= 2 && line.charCodeAt(n - 2) === 0x0d) {
        return line.slice(0, n - 2); // \r\n
      }
      return line.slice(0, n - 1); // \n
    }
    if (
      last === 0x0d || // \r
      last === 0x0b || // \v
      last === 0x0c || // \f
      (last >= 0x1c && last <= 0x1e) || // \x1c \x1d \x1e
      last === 0x85 || // NEL
      last === 0x2028 || // line separator
      last === 0x2029 // paragraph separator
    ) {
      return line.slice(0, n - 1);
    }
    return line; // final line, no terminator
  });
}

// ===========================================================================
// Shared dispatch building block (Python bash_compress.py L1207-1275).
// ===========================================================================

/**
 * Return [subcommand, index] — the first non-flag positional in *argv*.
 *
 * Starting at *start*, advances past standalone flags (-x, --verbose) by 1 and
 * value-taking flags (anything in *value_flags*) by 2. Returns the first
 * non-flag token lowercased together with its index. Returns ["", argv.length]
 * when no positional is found.
 *
 * Module-private port of bash_compress._first_positional — the shared building
 * block used by _is_git_log_cmd, _is_pkg_install_cmd, and _is_container_log_cmd.
 */
function _first_positional(
  argv: string[],
  value_flags: ReadonlySet<string>,
  start = 1,
): [string, number] {
  let i = start;
  while (i < argv.length) {
    const tok = argv[i]!;
    if (value_flags.has(tok)) {
      i += 2;
    } else if (tok.startsWith("-")) {
      i += 1;
    } else {
      return [tok.toLowerCase(), i];
    }
  }
  return ["", argv.length];
}

// Tool-specific "value flags" (flags that consume the following token as their
// value), used by the _is_*_cmd dispatch helpers below to skip over global
// flags when locating a subcommand via _first_positional(). Defined once at
// import time. (bash_compress.py L1240-1275.)
const _GIT_GLOBAL_VALUE_FLAGS: ReadonlySet<string> = new Set([
  "-C", "-c", "--git-dir", "--work-tree", "--namespace", "--super-prefix",
]);
const _PIP_VALUE_FLAGS: ReadonlySet<string> = new Set([
  "--index-url", "-i", "--extra-index-url", "--trusted-host",
  "--cert", "--client-cert", "--proxy", "--timeout", "--retries",
  "--log", "--cache-dir", "--build-dir", "--target",
]);
const _CARGO_VALUE_FLAGS: ReadonlySet<string> = new Set([
  "-C", "--manifest-path", "--config", "--target-dir", "-Z",
]);
const _NPM_VALUE_FLAGS: ReadonlySet<string> = new Set([
  "-C", "--prefix", "--userconfig", "--globalconfig",
]);
const _YARN_VALUE_FLAGS: ReadonlySet<string> = new Set(["--cwd"]);
const _UV_VALUE_FLAGS: ReadonlySet<string> = new Set([
  "--project", "--directory", "--python", "-p", "--cache-dir", "--config-file",
]);
const _DC_VALUE_FLAGS: ReadonlySet<string> = new Set([
  "--file", "-f", "--project-name", "-p", "--project-directory",
  "--env-file", "--profile", "--ansi", "--parallel",
]);
const _KUBECTL_VALUE_FLAGS: ReadonlySet<string> = new Set([
  "-n", "--namespace", "--context", "--kubeconfig", "--server", "-s",
  "--token", "--user", "--cluster", "--log-level", "--log-flush-frequency",
  "--request-timeout", "--as", "--as-group", "--as-uid",
  "--tls-server-name", "--certificate-authority", "--client-certificate",
  "--client-key", "--cache-dir",
]);
const _PODMAN_VALUE_FLAGS: ReadonlySet<string> = new Set([
  "--connection", "-c", "--identity", "--log-level", "--url",
]);
const _DOCKER_GLOBAL_VALUE_FLAGS: ReadonlySet<string> = new Set([
  "--host", "-H", "--config", "--context", "--log-level", "-l",
]);
// Shared compose flags: used by both "docker compose" and "docker-compose".
const _DOCKER_COMPOSE_SUBCMD_FLAGS: ReadonlySet<string> = new Set([
  "--file", "-f", "--project-name", "-p", "--project-directory",
  "--env-file", "--profile", "--ansi", "--parallel",
]);

// ===========================================================================
// Command-type / output detectors (bash_compress.py L1108-1507).
// ===========================================================================

/**
 * Return the listing type when *argv* is a recursive directory-listing command:
 * "find", "fd", "ls-r", or "eza-tree", else null. (bash_compress.py L1108.)
 *
 * *argv* must be the result of shlex.split(cmd, posix=False) — NOT a raw string.
 */
export function _dir_listing_cmd_type(argv: string[]): string | null {
  if (argv.length === 0) {
    return null;
  }
  let base = _stripQuotes(argv[0]!.replace(/\\/g, "/").split("/").pop()!).toLowerCase();
  if (base.endsWith(".exe")) {
    base = base.slice(0, -4);
  }
  if (base === "find") {
    return "find";
  }
  if (base === "fd" || base === "fdfind") {
    return "fd";
  }
  if (base === "ls" || base === "ll" || base === "la") {
    // Only flag as recursive when -R / --recursive is explicitly present.
    const rest = argv.slice(1);
    if (rest.includes("--recursive") || rest.includes("-R")) {
      return "ls-r";
    }
    // Check combined short flags (e.g. -lR, -laR)
    if (rest.some((a) => a.startsWith("-") && !a.startsWith("--") && a.includes("R"))) {
      return "ls-r";
    }
    return null;
  }
  if (base === "eza" || base === "exa") {
    // Tree variant only when --tree or -T (possibly combined) is present.
    const rest = argv.slice(1);
    if (rest.includes("--tree") || rest.includes("-T")) {
      return "eza-tree";
    }
    if (rest.some((a) => a.startsWith("-") && !a.startsWith("--") && a.includes("T"))) {
      return "eza-tree";
    }
    return null;
  }
  return null;
}

//: Matches sleep durations: N, Ns, Nm, Nh (integer or decimal).
const _SLEEP_DUR_RE: RegExp = /\d+(?:\.\d+)?[smh]?/;

/**
 * Return "sleep" when *argv* is a standalone `sleep` invocation, else null.
 * (bash_compress.py L1147.)
 *
 * Matches `sleep N`, `sleep Ns`, `sleep Nm`, `sleep Nh` where N is a
 * non-negative number, plus `sleep infinity`. Does NOT match sleep embedded in
 * another command — the caller passes only the first compound segment.
 *
 * *argv* must be the result of shlex.split(cmd, posix=False).
 */
export function _sleep_cmd_type(argv: string[]): string | null {
  if (argv.length === 0) {
    return null;
  }
  let base = _stripQuotes(argv[0]!.replace(/\\/g, "/").split("/").pop()!).toLowerCase();
  if (base.endsWith(".exe")) {
    base = base.slice(0, -4);
  }
  if (base !== "sleep") {
    return null;
  }
  const rest = argv.slice(1).filter((a) => a.trim()).map((a) => _stripQuotes(a));
  if (rest.length !== 1) {
    return null;
  }
  const dur = rest[0]!.toLowerCase();
  if (dur === "infinity" || _reFull(_SLEEP_DUR_RE, dur)) {
    return "sleep";
  }
  return null;
}

/**
 * Return the watched command string when *argv* is a `watch` invocation, else
 * null. (bash_compress.py L1173.)
 *
 * Strips watch flags (-n N, --interval N, -d, -t, etc.) and returns the
 * remainder of the argument list joined as a single string. Returns null when
 * the first token is not `watch` or when no command follows the flags.
 *
 * *argv* must be the result of shlex.split(cmd, posix=False).
 */
export function _watch_cmd_info(argv: string[]): string | null {
  if (argv.length === 0) {
    return null;
  }
  let base = _stripQuotes(argv[0]!.replace(/\\/g, "/").split("/").pop()!).toLowerCase();
  if (base.endsWith(".exe")) {
    base = base.slice(0, -4);
  }
  if (base !== "watch") {
    return null;
  }
  // Flags that consume the following token as a value.
  const _CONSUME_NEXT: ReadonlySet<string> = new Set(["-n", "--interval"]);
  let i = 1;
  const n = argv.length;
  while (i < n) {
    const tok = _stripQuotes(argv[i]!);
    if (_CONSUME_NEXT.has(tok)) {
      i += 2;
      continue;
    }
    if (tok.startsWith("-")) {
      i += 1;
      continue;
    }
    const cmd_parts = argv.slice(i).map((a) => _stripQuotes(a));
    return cmd_parts.length > 0 ? cmd_parts.join(" ") : null;
  }
  return null;
}

/**
 * Return true when *argv* is a `git log` command (any flags). (L1278.)
 *
 * *argv* must be shlex-split (posix=False) with quote-stripping already applied.
 */
export function _is_git_log_cmd(argv: string[]): boolean {
  if (argv.length < 2) {
    return false;
  }
  let base = argv[0]!.replace(/\\/g, "/").split("/").pop()!.toLowerCase();
  if (base.endsWith(".exe")) {
    base = base.slice(0, -4);
  }
  if (base !== "git") {
    return false;
  }
  // Scan argv[1:] for the subcommand, skipping global git flags.
  const [sub] = _first_positional(argv, _GIT_GLOBAL_VALUE_FLAGS);
  return sub === "log";
}

/**
 * Return true when *argv* is a package-manager install invocation. (L1300.)
 *
 * pip/pip3: install/download; cargo: install; npm: install/i/ci/update;
 * yarn: install/add/upgrade; uv: sync/install/add or `uv pip install`/`uv pip
 * sync`. Global flags before the subcommand are skipped.
 *
 * *argv* must be shlex-split with quote-stripping already applied.
 */
export function _is_pkg_install_cmd(argv: string[]): boolean {
  if (argv.length < 2) {
    return false;
  }
  let base = argv[0]!.replace(/\\/g, "/").split("/").pop()!.toLowerCase();
  if (base.endsWith(".exe")) {
    base = base.slice(0, -4);
  }

  // pip / pip3
  if (base === "pip" || base === "pip3") {
    const [sub] = _first_positional(argv, _PIP_VALUE_FLAGS);
    return sub === "install" || sub === "download";
  }

  // cargo
  if (base === "cargo") {
    const [sub] = _first_positional(argv, _CARGO_VALUE_FLAGS);
    return sub === "install";
  }

  // npm
  if (base === "npm") {
    const [sub] = _first_positional(argv, _NPM_VALUE_FLAGS);
    return sub === "install" || sub === "i" || sub === "ci" || sub === "update";
  }

  // yarn
  if (base === "yarn") {
    const [sub] = _first_positional(argv, _YARN_VALUE_FLAGS);
    return sub === "install" || sub === "add" || sub === "upgrade";
  }

  // uv
  if (base === "uv") {
    const [sub, sub_idx] = _first_positional(argv, _UV_VALUE_FLAGS);
    if (sub === "sync" || sub === "install" || sub === "add") {
      return true;
    }
    if (sub === "pip") {
      // uv pip install / uv pip sync
      const [pip_sub] = _first_positional(argv, new Set<string>(), sub_idx + 1);
      return pip_sub === "install" || pip_sub === "sync";
    }
    return false;
  }

  return false;
}

/**
 * Return true when *argv* is an environment-variable listing command. (L1355.)
 *
 * Matches: bare `env` (or with --null/-0/-i/--unset but NOT `env VAR=val cmd`),
 * `printenv [VAR...]`, `export` / `export -p`, `declare -x`.
 */
export function _is_env_list_cmd(argv: string[]): boolean {
  if (argv.length === 0) {
    return false;
  }
  let base = argv[0]!.replace(/\\/g, "/").split("/").pop()!.toLowerCase();
  if (base.endsWith(".exe")) {
    base = base.slice(0, -4);
  }

  // env
  if (base === "env") {
    // Skip recognised env flags; the next non-flag token containing '=' means
    // `env VAR=val cmd` (command prefix) -> false.
    const _ENV_NO_ARG_FLAGS: ReadonlySet<string> = new Set([
      "--null", "-0", "-i", "--ignore-environment",
    ]);
    const _ENV_ARG_FLAGS: ReadonlySet<string> = new Set(["-u", "--unset"]);
    let i = 1;
    while (i < argv.length) {
      const tok = argv[i]!;
      if (_ENV_NO_ARG_FLAGS.has(tok)) {
        i += 1;
      } else if (_ENV_ARG_FLAGS.has(tok)) {
        i += 2; // flag + its NAME argument
      } else if (tok.startsWith("-")) {
        i += 1; // unknown flag, skip
      } else {
        // Any positional argument (VAR=val or a command name) means env is
        // either setting variables for a subprocess or running a command.
        // Neither is a listing. Only bare 'env [flags]' lists the environment.
        return false;
      }
    }
    return true;
  }

  // printenv
  if (base === "printenv") {
    return true;
  }

  // export -p
  if (base === "export") {
    return argv.length === 1 || argv[1] === "-p";
  }

  // declare -x
  if (base === "declare") {
    return argv.includes("-x");
  }

  return false;
}

/**
 * Return true when *argv* is a container log retrieval command. (L1409.)
 *
 * docker logs / docker compose logs / docker-compose logs / kubectl logs /
 * podman logs. *argv* must be shlex-split with quote-stripping already applied.
 */
export function _is_container_log_cmd(argv: string[]): boolean {
  if (argv.length < 2) {
    return false;
  }
  let base = argv[0]!.replace(/\\/g, "/").split("/").pop()!.toLowerCase();
  if (base.endsWith(".exe")) {
    base = base.slice(0, -4);
  }

  // docker-compose
  if (base === "docker-compose") {
    const [sub] = _first_positional(argv, _DC_VALUE_FLAGS);
    return sub === "logs";
  }

  // kubectl
  if (base === "kubectl") {
    const [sub] = _first_positional(argv, _KUBECTL_VALUE_FLAGS);
    return sub === "logs";
  }

  // podman
  if (base === "podman") {
    const [sub] = _first_positional(argv, _PODMAN_VALUE_FLAGS);
    return sub === "logs";
  }

  // docker
  if (base === "docker") {
    // Docker has global flags before the subcommand.
    const [sub, sub_idx] = _first_positional(argv, _DOCKER_GLOBAL_VALUE_FLAGS);
    if (sub === "compose") {
      // docker compose [flags] logs ...
      const [compose_sub] = _first_positional(argv, _DOCKER_COMPOSE_SUBCMD_FLAGS, sub_idx + 1);
      return compose_sub === "logs";
    }
    return sub === "logs";
  }

  return false;
}

//: Detects a `while` / `until` keyword anywhere in the raw command string.
const _POLL_KEYWORD_RE: RegExp = /\b(?:while|until)\b/;

/**
 * Return true when *cmd* looks like a shell poll loop. (L1457.)
 *
 * Heuristic: the raw command contains a `while`/`until` keyword AND at least one
 * split_compound segment has `sleep` as its first non-keyword command token.
 * Shell control words (do/then/else/elif/fi/done/while/until/if) are skipped.
 */
export function _is_poll_loop_cmd(cmd: string): boolean {
  if (!_reSearch(_POLL_KEYWORD_RE, cmd)) {
    return false;
  }
  let segments: string[];
  try {
    segments = split_compound(cmd);
  } catch {
    segments = [cmd];
  }
  // Shell control words that may prefix a real command within a compound segment.
  const _SHELL_KEYWORDS: ReadonlySet<string> = new Set([
    "do", "then", "else", "elif", "fi", "done", "while", "until", "if",
  ]);
  for (const seg of segments) {
    let parts: string[];
    try {
      parts = _shlexSplit(seg, { posix: false });
    } catch {
      parts = seg.trim().split(/\s+/).filter((t) => t.length > 0);
    }
    // Skip leading shell keywords to reach the first real command token.
    for (const part of parts) {
      const token = _stripQuotes(part).toLowerCase();
      if (_SHELL_KEYWORDS.has(token)) {
        continue;
      }
      if (token === "sleep") {
        return true;
      }
      break; // first non-keyword token is not sleep; move to next segment
    }
  }
  return false;
}

/**
 * Return true when *stdout* looks like JUnit XML test results. (L1497.)
 *
 * Quick scan of the first 2000 chars only. Both `<testsuite>` and
 * `<testsuites>` roots are accepted.
 */
export function _is_junit_xml_output(stdout: string): boolean {
  if (!stdout) {
    return false;
  }
  const head = stdout.slice(0, 2000);
  return head.includes("<?xml") && (head.includes("<testsuite") || head.includes("<testsuites"));
}

// ===========================================================================
// pytest verbose detection (bash_compress.py L2217-2258).
// ===========================================================================

//: Verbose flags that activate per-test PASSED-line suppression. (L2218.)
const _VT_VERBOSE_FLAGS: ReadonlySet<string> = new Set(["-v", "--verbose", "-vv", "-vvv", "-vvvv"]);

/**
 * Matches a single per-test PASSED line in verbose pytest output. (L2221.)
 *
 * EXPORTED — hooks_read reads it via `_bcRe("_VT_PASSED_LINE_RE")`.
 */
export const _VT_PASSED_LINE_RE: RegExp = /^\S.+::\S+[ \t]+PASSED(?:[ \t]|$)/;

/**
 * Return true when *argv* is a pytest verbose run (-v/--verbose). (L2226.)
 *
 * Recognises direct invocations (`pytest -v`) and common wrappers: `uv run
 * pytest -v`, `python -m pytest -v`, `python3 -m pytest -v`. Does NOT match
 * plain `pytest` without a verbose flag.
 */
export function _is_verbose_test_cmd(argv: string[]): boolean {
  if (argv.length === 0) {
    return false;
  }
  // Strip path separators to get the bare executable name.
  let base = argv[0]!.replace(/\\/g, "/").split("/").pop()!.toLowerCase();
  if (base.endsWith(".exe")) {
    base = base.slice(0, -4);
  }
  if (base === "pytest" || base === "py.test") {
    // direct invocation — fall through to verbose flag check
  } else if (
    base === "uv" &&
    argv.length >= 3 &&
    argv[1] === "run" &&
    (() => {
      let b = argv[2]!.toLowerCase();
      if (b.endsWith(".exe")) {
        b = b.slice(0, -4);
      }
      return b === "pytest" || b === "py.test";
    })()
  ) {
    // uv run pytest … — fall through
  } else if (
    (base === "python" || base === "python3") &&
    argv.length >= 3 &&
    argv[1] === "-m" &&
    argv[2]!.toLowerCase() === "pytest"
  ) {
    // python -m pytest … — fall through
  } else {
    return false;
  }
  return argv.slice(1).some((a) => _VT_VERBOSE_FLAGS.has(a));
}

// ===========================================================================
// cargo / go / make / python command detectors (bash_compress.py L3025-3239).
// ===========================================================================

/**
 * Return true when *argv* is a cargo compilation invocation. (L3025.)
 *
 * Compiling subcommands: build, check, clippy, fix, rustc. Global flags before
 * the subcommand are skipped.
 */
export function _is_cargo_compile_cmd(argv: string[]): boolean {
  if (argv.length === 0) {
    return false;
  }
  let base = argv[0]!.replace(/\\/g, "/").split("/").pop()!.toLowerCase();
  if (base.endsWith(".exe")) {
    base = base.slice(0, -4);
  }
  if (base !== "cargo") {
    return false;
  }
  const _CARGO_COMPILE_SUBS: ReadonlySet<string> = new Set(["build", "check", "clippy", "fix", "rustc"]);
  // Flags that consume the next token as their value.
  const _CARGO_GLOBAL_ARG_FLAGS: ReadonlySet<string> = new Set(["--color", "--config", "-Z", "--manifest-path"]);
  let i = 1;
  while (i < argv.length) {
    const tok = argv[i]!;
    if (tok.startsWith("-")) {
      if (_CARGO_GLOBAL_ARG_FLAGS.has(tok)) {
        i += 2;
      } else {
        i += 1;
      }
    } else {
      return _CARGO_COMPILE_SUBS.has(tok);
    }
  }
  return false;
}

//: Matches -v=false / --v=false flags that explicitly disable verbose go test.
const _GO_V_DISABLED_RE: RegExp = /^--?v=false$/;

/** Lowercased final path component with .exe/.cmd stripped. */
function _baseExeCmd(s: string): string {
  let b = s.replace(/\\/g, "/").split("/").pop()!.toLowerCase();
  for (const ext of [".exe", ".cmd"]) {
    if (b.endsWith(ext)) {
      b = b.slice(0, -ext.length);
      break;
    }
  }
  return b;
}

/**
 * Return true when *argv* is a verbose `go test` invocation. (L3105.)
 *
 * Handles `go test -v ./...`, `go test -run=TestFoo -v`. Does NOT match `go test
 * -v=false` or `go test` without `-v`. Stops processing at `--`.
 */
export function _is_go_test_verbose_cmd(argv: string[]): boolean {
  if (argv.length === 0) {
    return false;
  }
  if (_baseExeCmd(argv[0]!) !== "go") {
    return false;
  }
  let has_test = false;
  let has_verbose = false;
  for (const tok of argv.slice(1)) {
    if (tok === "--") {
      break; // flags after -- are forwarded to the test binary; stop
    }
    if (tok === "test") {
      has_test = true;
    } else if (tok === "-v") {
      has_verbose = true;
    } else if (_reMatch(_GO_V_DISABLED_RE, tok)) {
      return false; // -v=false / --v=false explicitly disables verbose
    }
  }
  return has_test && has_verbose;
}

//: Matches make/gmake/ninja binary base names for _is_make_cmd detection.
const _MAKE_BIN_RE: RegExp = /^(?:g?make|ninja)$/;

/**
 * Return true when *argv* is a make/gmake/ninja/cmake --build invocation. (L3144.)
 *
 * make/gmake/ninja with any args; cmake --build <dir> (--build must be the first
 * non-flag arg; value-consuming flags -G/-D/-B/-S/etc. are skipped).
 */
export function _is_make_cmd(argv: string[]): boolean {
  if (argv.length === 0) {
    return false;
  }
  const b0 = _baseExeCmd(argv[0]!);
  if (_reMatch(_MAKE_BIN_RE, b0)) {
    return true;
  }
  if (b0 === "cmake") {
    // Flags that consume the following token as their value.
    const _CMAKE_VALUE_FLAGS: ReadonlySet<string> = new Set([
      "-G", "-D", "-T", "-A", "-U", "--preset", "--install-prefix", "-B", "-S", "-E",
    ]);
    let i = 1;
    while (i < argv.length) {
      const tok = argv[i]!;
      if (tok === "--build") {
        return true;
      }
      if (tok.startsWith("-")) {
        if (_CMAKE_VALUE_FLAGS.has(tok)) {
          i += 2;
        } else {
          i += 1;
        }
      } else {
        // Positional non-flag that is not --build → not a build invocation
        return false;
      }
    }
    return false;
  }
  return false;
}

//: Matches Python interpreter base names after _base() strips path and extension.
//: Covers python, python3, python3.12, py.
const _PYTHON_BIN_RE: RegExp = /^python3?(?:\.\d+)?$|^py$/;

/**
 * Return true when *argv* is a direct Python script invocation. (L3195.)
 *
 * python / python3 / python3.12 / py (and .exe/.cmd variants), direct `.py`
 * file invocations, and `uv run python[3[.X]]`. (pytest is excluded by the
 * caller's guard, not here.)
 */
export function _is_python_script_cmd(argv: string[]): boolean {
  if (argv.length === 0) {
    return false;
  }
  const b0 = _baseExeCmd(_stripQuotes(argv[0]!));

  // Direct Python interpreter: python, python3, python3.12, py (and .exe/.cmd)
  if (_reMatch(_PYTHON_BIN_RE, b0)) {
    return true;
  }

  // Direct .py script: ./myscript.py, C:\path\script.PY (lowercased by _base)
  if (b0.endsWith(".py")) {
    return true;
  }

  // uv run python[3[.X]] ...
  if (b0 === "uv" && argv.length >= 3) {
    // Skip any leading uv flags to find the "run" subcommand
    let i = 1;
    while (i < argv.length && argv[i]!.startsWith("-")) {
      i += 1;
    }
    if (i < argv.length && _baseExeCmd(argv[i]!) === "run") {
      i += 1;
      // Skip uv run flags/options
      while (i < argv.length && argv[i]!.startsWith("-")) {
        i += 1;
      }
      if (i < argv.length && _reMatch(_PYTHON_BIN_RE, _baseExeCmd(argv[i]!))) {
        return true;
      }
    }
  }

  return false;
}

// ===========================================================================
// Minified-file grep elision helpers (bash_compress.py L9931-9972).
// ===========================================================================

const _MINIFIED_EXT_RE: RegExp =
  /\.min\.(?:js|css)$|(?:^|[\\/])(?:vendor|bundle|dist|chunk|polyfills?)(?:\.[a-z0-9]+)*\.(?:js|css)$/i;

/** Return true when *path* looks like a minified/bundled JS or CSS file. (L9937.) */
export function _is_minified_file(path: string): boolean {
  return _reSearch(_MINIFIED_EXT_RE, path);
}

/**
 * Return true when any grep output line has a minified-file path AND a very long
 * match line (>=500 chars after the path:). (L9942.)
 */
export function _has_minified_grep_hit(stdout: string): boolean {
  for (const line of _splitlines(stdout)) {
    const search_from =
      line.length >= 3 && line[1] === ":" && (line[2] === "/" || line[2] === "\\") ? 2 : 0;
    const colon_idx = line.indexOf(":", search_from);
    if (colon_idx < 1) {
      continue;
    }
    const path_part = line.slice(0, colon_idx);
    const rest = line.slice(colon_idx + 1);
    if (_is_minified_file(path_part) && rest.length > 500) {
      return true;
    }
  }
  return false;
}

const _GREP_BIN_RE: RegExp = /^(?:rg|grep|egrep|fgrep|ag|ack|ack-grep|git)$/;

/**
 * Return true when *argv* is a grep-family command (rg, grep, egrep, fgrep, ag,
 * ack, ack-grep, git grep). (L9961.)
 */
export function _is_grep_cmd(argv: string[]): boolean {
  if (argv.length === 0) {
    return false;
  }
  let stem = argv[0]!.toLowerCase().split("/").pop()!.split("\\").pop()!;
  if (stem.endsWith(".exe")) {
    stem = stem.slice(0, -4);
  }
  if (_reMatch(_GREP_BIN_RE, stem)) {
    if (stem === "git") {
      return argv.length >= 2 && argv[1] === "grep";
    }
    return true;
  }
  return false;
}

// ===========================================================================
// jest / vitest detection + compressor (bash_compress.py L25876-25993).
// ===========================================================================

// Jest/vitest regexes — byte-faithful to their Python sources. The JestFilter
// trio (_JEST_PASS_LINE_RE / _JEST_FAIL_LINE_RE / _VITEST_TEST_PASS_RE) comes
// from Python L2482/2488/2660; the post-bash-specific set from L25876+. All are
// module-private (NOT exported): the test_runners.ts copies are also private, so
// exporting here would clash, and only _VT_PASSED_LINE_RE needs to be public.
const _JEST_NPM_CMD_RE: RegExp = /\b(?:test|jest|vitest)\b/i;
const _JEST_PASS_TICK_RE: RegExp = /^\s{2,}[✓✔√]\s/;
const _VT_FILE_PASS_RE: RegExp = /^ ✓ /;
const _VT_FILE_FAIL_RE: RegExp = /^ [×✗✕✘] /;
const _JEST_WORD_DETECT_RE: RegExp = /^\s*(?:PASS|FAIL)\s+\S/;
const _JEST_PASS_LINE_RE: RegExp = /^(?:\s*PASS\s+\S|[✓√]\s+\S)/;
const _JEST_FAIL_LINE_RE: RegExp = /^\s*(?:FAIL|✗|×|✘)\s+\S/;
const _VITEST_TEST_PASS_RE: RegExp = /^\s{2,}✓\s/;

/**
 * Return true when *argv* looks like a jest/vitest invocation. (L25889.)
 *
 * Matches direct jest/vitest/react-scripts binaries and package-manager shims
 * (`npx jest`, `npm test`, `yarn test`, `pnpm test`).
 */
export function _is_jest_cmd(argv: string[]): boolean {
  if (argv.length === 0) {
    return false;
  }
  const base = _baseExeCmd(argv[0]!);
  if (base === "jest" || base === "vitest" || base === "react-scripts") {
    return true;
  }
  if ((base === "npx" || base === "yarn" || base === "pnpm" || base === "npm") && argv.length >= 2) {
    // Skip leading flags (e.g. npx --yes jest, yarn --cwd ./app jest)
    for (const tok of argv.slice(1)) {
      if (tok.startsWith("-")) {
        continue;
      }
      return _reSearch(_JEST_NPM_CMD_RE, tok);
    }
  }
  return false;
}

/**
 * Return true when *stdout* contains jest-style PASS/FAIL suite headers. (L25918.)
 *
 * Word-only pattern (PASS/FAIL ASCII) so vitest Unicode symbols (×, ✗) do not
 * false-positive here — _has_vitest_output handles those.
 */
export function _has_jest_output(stdout: string): boolean {
  return _splitlines(stdout).some((ln) => _reMatch(_JEST_WORD_DETECT_RE, ln));
}

/** Return true when *stdout* contains vitest file-level ✓ / × headers. (L25928.) */
export function _has_vitest_output(stdout: string): boolean {
  return _splitlines(stdout).some(
    (ln) => _reMatch(_VT_FILE_PASS_RE, ln) || _reMatch(_VT_FILE_FAIL_RE, ln),
  );
}

/**
 * Compress jest/vitest verbose output for the post-bash hook. (L25936.)
 *
 * Returns [compressed_text, pass_count, fail_count]. Suppresses PASS suite
 * headers and their per-test ✓ children; keeps FAIL blocks + summary intact. A
 * lighter-weight variant of JestFilter (no stderr merging, no console-block
 * collapsing) for the post-bash hook path.
 */
export function compress_jest_output(stdout: string): [string, number, number] {
  const lines = _splitlinesKeepends(stdout);
  const out: string[] = [];
  let pass_count = 0;
  let fail_count = 0;
  let in_pass_block = false;

  const is_vitest = _has_vitest_output(stdout) && !_has_jest_output(stdout);

  if (is_vitest) {
    // Vitest: suppress file-level ✓ lines and their per-test ✓ children; keep ×
    // lines, failure detail blocks, and summary.
    let in_pass_file = false;
    for (const line of lines) {
      if (_reMatch(_VT_FILE_PASS_RE, line)) {
        pass_count += 1;
        in_pass_file = true;
        continue;
      }
      if (_reMatch(_VT_FILE_FAIL_RE, line)) {
        fail_count += 1;
        in_pass_file = false;
        out.push(line);
        continue;
      }
      if (in_pass_file && _reMatch(_VITEST_TEST_PASS_RE, line)) {
        continue; // per-test ✓ under a passing file block
      }
      if (in_pass_file && !(line.startsWith(" ") || line.startsWith("\t"))) {
        in_pass_file = false;
      }
      out.push(line);
    }
  } else {
    // Jest: suppress PASS headers and their indented ✓ children.
    for (const line of lines) {
      if (_reMatch(_JEST_PASS_LINE_RE, line)) {
        pass_count += 1;
        in_pass_block = true;
        continue;
      }
      if (_reMatch(_JEST_FAIL_LINE_RE, line)) {
        fail_count += 1;
        in_pass_block = false;
        out.push(line);
        continue;
      }
      if (in_pass_block) {
        if (line.startsWith(" ") || line.startsWith("\t")) {
          if (_reMatch(_JEST_PASS_TICK_RE, line)) {
            continue;
          }
          out.push(line);
          continue;
        }
        in_pass_block = false;
      }
      out.push(line);
    }
  }

  return [out.join(""), pass_count, fail_count];
}

// ===========================================================================
// curl verbose output detection + compressor (bash_compress.py L25997-26125).
// ===========================================================================

const _CURL_REQUEST_LINE_RE: RegExp = /^> (?:GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS|TRACE) /;
const _CURL_V_STATUS_RE: RegExp = /^< HTTP\/[12](?:\.\d)? \d{3}/;
const _CURL_CONTENT_TYPE_RE: RegExp = /^< [Cc]ontent-[Tt]ype:/i;
const _CURL_VERBOSE_PROGRESS_RE: RegExp =
  /^\s*(?:%\s+Total\s+%\s+Received|Dload\s+Upload\s+Total|\d[\d ]+(?:--:--:--|\d:\d+:\d+))/;

//: -v / --verbose detection inside the joined curl argument string.
const _CURL_VERBOSE_FLAG_RE: RegExp = /(?:^|\s)--verbose(?:\s|$)/;
const _CURL_SHORT_V_FLAG_RE: RegExp = /(?:^|\s)-[a-zA-Z]*v[a-zA-Z]*(?:\s|$)/;

/** Return true when *argv* is a curl command with a verbose flag. (L26013.) */
export function _is_curl_verbose_cmd(argv: string[]): boolean {
  if (argv.length === 0) {
    return false;
  }
  const base = _baseExeCmd(argv[0]!);
  if (base !== "curl") {
    return false;
  }
  const args_str = argv.slice(1).join(" ");
  // -v, --verbose, or combined short flags containing v (e.g. -vL, -vsL)
  return _reSearch(_CURL_VERBOSE_FLAG_RE, args_str) || _reSearch(_CURL_SHORT_V_FLAG_RE, args_str);
}

/** Return true when *stdout* contains curl verbose markers. (L26037.) */
export function _has_curl_verbose_output(stdout: string): boolean {
  const lines = _splitlines(stdout);
  const has_star = lines.some((ln) => ln.startsWith("* "));
  const has_req = lines.some((ln) => ln.startsWith("> "));
  const has_resp = lines.some((ln) => ln.startsWith("< "));
  return has_star || (has_req && has_resp);
}

/** Python str.rstrip("\r\n") — strip trailing \r and \n characters only. */
function _rstripCRLF(s: string): string {
  let end = s.length;
  while (end > 0 && (s[end - 1] === "\r" || s[end - 1] === "\n")) {
    end--;
  }
  return s.slice(0, end);
}

/**
 * Strip curl verbose noise, keeping request line, status, content-type, body.
 * (L26046.)
 *
 * Returns [compressed_text, lines_removed]. The response body (after the blank
 * separator) is kept verbatim.
 */
export function compress_curl_verbose(stdout: string): [string, number] {
  const lines = _splitlinesKeepends(stdout);
  const out: string[] = [];
  let lines_removed = 0;
  let in_body = false;
  let found_request_line = false;
  let found_status = false;
  let found_content_type = false;

  for (const line of lines) {
    // Once we're in the body, keep everything. A `* ` line while in body mode
    // means curl is following a redirect — reset so the next request/response
    // cycle gets compressed normally.
    if (in_body) {
      if (line.startsWith("* ")) {
        in_body = false;
        found_request_line = false;
        found_status = false;
        found_content_type = false;
        lines_removed += 1;
        continue;
      }
      out.push(line);
      continue;
    }

    // Bare `<` line = end of response headers, body follows.
    // Bare `>` line = end of request headers (response headers come next).
    // Empty line = body content (no prefix markers).
    const stripped = _rstripCRLF(line);
    if (stripped === "<") {
      out.push(line);
      in_body = true;
      continue;
    }
    if (stripped === ">") {
      // End-of-request-headers separator; emit and continue to response headers.
      out.push(line);
      continue;
    }
    if (stripped === "") {
      out.push(line);
      continue;
    }

    // `* ` lines (connection/TLS info) — always suppress
    if (line.startsWith("* ")) {
      lines_removed += 1;
      continue;
    }

    // `> ` lines (request headers) — keep only the request line
    if (line.startsWith("> ")) {
      if (!found_request_line && _reMatch(_CURL_REQUEST_LINE_RE, line)) {
        found_request_line = true;
        out.push(line);
      } else {
        lines_removed += 1;
      }
      continue;
    }

    // `< ` lines (response headers) — keep status + content-type only
    if (line.startsWith("< ")) {
      if (!found_status && _reMatch(_CURL_V_STATUS_RE, line)) {
        found_status = true;
        out.push(line);
      } else if (!found_content_type && _reMatch(_CURL_CONTENT_TYPE_RE, line)) {
        found_content_type = true;
        out.push(line);
      } else {
        lines_removed += 1;
      }
      continue;
    }

    // curl progress meter lines — suppress
    if (_reMatch(_CURL_VERBOSE_PROGRESS_RE, line)) {
      lines_removed += 1;
      continue;
    }

    // Everything else (body content or plain text) — keep
    out.push(line);
  }

  return [out.join(""), lines_removed];
}

// ===========================================================================
// docker build output detection + compressor (bash_compress.py L26129-26234).
// ===========================================================================

const _DOCKER_BUILD_STEP_RE: RegExp = /^Step \d+\/\d+ : /m;
const _DOCKER_ARROW_RE: RegExp = /^ --->/;
const _DOCKER_SUPPRESS_ARROW_RE: RegExp = /^ ---> (?:Using cache|Running in [0-9a-f]+|[0-9a-f]{12,})\s*$/;
const _DOCKER_BUILDKIT_STEP_RE: RegExp = /^ => (?:CACHED )?\[/;
const _DOCKER_BUILDKIT_SUBSTEP_RE: RegExp = /^ => => /;
const _DOCKER_BUILDKIT_SUMMARY_RE: RegExp = /^\[\+\] Building/m;
const _DOCKER_BUILD_SUCCESS_RE: RegExp = /^(?:Successfully (?:built|tagged)|FINISHED)/;
const _DOCKER_SUPPRESS_MISC_RE: RegExp =
  /^(?:Sending build context to Docker daemon|Removing intermediate container)/;

/** Return true when *argv* is a docker build / buildx build invocation. (L26145.) */
export function _is_docker_build_cmd(argv: string[]): boolean {
  if (argv.length === 0) {
    return false;
  }
  const base = _pathStemLower(argv[0]!);
  if (base !== "docker" && base !== "docker-compose" && base !== "docker-buildx") {
    return false;
  }
  const args = argv.slice(1).map((a) => a.toLowerCase());
  return args.includes("build");
}

/** Return true when *stdout* looks like docker build output. (L26160.) */
export function _has_docker_build_output(stdout: string): boolean {
  return _reSearch(_DOCKER_BUILD_STEP_RE, stdout) || _reSearch(_DOCKER_BUILDKIT_SUMMARY_RE, stdout);
}

/**
 * Compress docker build output, keeping step headers and errors. (L26168.)
 *
 * Returns [compressed_text, lines_removed].
 */
export function compress_docker_build(stdout: string): [string, number] {
  const lines = _splitlinesKeepends(stdout);
  const out: string[] = [];
  let lines_removed = 0;
  let in_run_step = false; // True when inside a RUN step (keep its output)

  for (const line of lines) {
    const stripped = _rstripCRLF(line);

    // Suppress misc noise at the start
    if (_reMatch(_DOCKER_SUPPRESS_MISC_RE, stripped)) {
      lines_removed += 1;
      continue;
    }

    // Classic format: Step N/M
    if (_reMatch(_DOCKER_BUILD_STEP_RE, stripped)) {
      const upper = stripped.toUpperCase();
      in_run_step = upper.includes("RUN ") || upper.endsWith(" RUN");
      out.push(line);
      continue;
    }

    // Classic format: ---> lines to suppress (Using cache, Running in, bare hash)
    if (_reMatch(_DOCKER_SUPPRESS_ARROW_RE, stripped)) {
      lines_removed += 1;
      continue;
    }

    // Classic format: keep other ---> lines (e.g., error context)
    if (_reMatch(_DOCKER_ARROW_RE, stripped)) {
      out.push(line);
      continue;
    }

    // BuildKit summary [+] Building
    if (_reMatch(_DOCKER_BUILDKIT_SUMMARY_RE, stripped)) {
      out.push(line);
      continue;
    }

    // BuildKit step lines: keep [N/M] and CACHED [N/M]
    if (_reMatch(_DOCKER_BUILDKIT_STEP_RE, stripped)) {
      out.push(line);
      continue;
    }

    // BuildKit sub-step lines: suppress
    if (_reMatch(_DOCKER_BUILDKIT_SUBSTEP_RE, stripped)) {
      lines_removed += 1;
      continue;
    }

    // Success/FINISHED lines
    if (_reMatch(_DOCKER_BUILD_SUCCESS_RE, stripped)) {
      out.push(line);
      continue;
    }

    // Error / failure lines — always keep
    const lower = stripped.toLowerCase();
    if (lower.includes("error") || lower.includes("failed") || lower.includes("fail")) {
      out.push(line);
      continue;
    }

    // Non-step lines: keep if inside a RUN step (command output), suppress otherwise
    if (in_run_step) {
      out.push(line);
    } else {
      lines_removed += 1;
    }
  }

  return [out.join(""), lines_removed];
}
