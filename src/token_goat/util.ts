/**
 * Cross-cutting helpers shared across token-goat modules.
 *
 * Faithful port of src/token_goat/util.py. Kept intentionally small — only
 * utilities that would otherwise be duplicated in two or more modules with no
 * natural owner belong here.
 *
 * Parity notes (Python → TS):
 *  - logging.Logger → a thin console shim that carries a dotted "token_goat.<name>"
 *    name and forwards to console. The Python contract callers depend on is
 *    (a) the `token_goat.` prefix centralisation, (b) identity-stable lookups
 *    (same name ⇒ same object), and (c) the `.name` attribute. This shim
 *    reproduces all three; callers that currently stop at `.debug/.info/...`
 *    are unaffected. Full stdlib logging levels/handlers are NOT ported (no TS
 *    caller relies on them yet); if a later layer needs them, grow this shim
 *    rather than swapping it out.
 *  - subprocess.run([...,"git","--no-optional-locks",...]) → spawnSync with the
 *    SAME argv prefix. Node has no "text=True, encoding=utf-8, errors=replace"
 *    triple; we pass {encoding:"utf8"} (Node decodes the captured bytes as UTF-8
 *    and, like Python's errors="replace", substitutes U+FFFD for invalid
 *    sequences rather than throwing). Spawn failures (ENOENT — git not on
 *    PATH) are folded into the CompletedProcess analogue as a non-zero return
 *    code with stderr, mirroring Python's FileNotFoundError-on-check=False
 *    behaviour the callers already tolerate (git treats "not a repo" as 128).
 *    --no-optional-locks and -c core.fsmonitor= are both injected so the spawned
 *    git never touches the index lock nor fires fsmonitor while the editor owns
 *    the worktree — identical to the Python rationale.
 *  - re.compile → top-level RegExp literals compiled once at module load (the
 *    Python module-level _WSL_PATH_RE / sanitize_control_chars regexen are
 *    module-level there too).
 *  - str.encode("utf-8", errors="replace") → Buffer.from(s, "utf8"). JS strings
 *    are UTF-16; lone surrogates in the U+DC80–U+DCFF range are replaced by
 *    U+FFFD by Node's UTF-8 encoder (it cannot encode them), matching Python's
 *    errors="replace" for exactly the code points subprocess surrogate-escape
 *    produces. Buffer byte length is what every caller actually consumes.
 *  - configure_stdout_encoding is effectively a no-op here: Node process I/O is
 *    already UTF-8 by default and there is no "reconfigure a stream's encoding"
 *    knob. The function is retained as an empty stub so call sites in later
 *    layers can import it without a conditional; the Python version's real
 *    work (cp1252 → UTF-8 on Windows) has no JS analogue because Node never
 *    uses a legacy DOS codepage for process.stdout/stderr.
 *  - Python's `_humanize_bytes` is private (underscore-prefixed) and has no
 *    direct test coverage; it is ported anyway so the symbol is available for
 *    the compact/render layers that import it via util._humanize_bytes.
 *
 * `verbatimModuleSyntax` is on → all type-only imports use `import type`.
 * `exactOptionalPropertyTypes` is on → optional fields on the run_git options
 * type are spelled `T | undefined`, never `T | null`, and callers must pass
 * `undefined` (not omit-and-let-it-default) when they want the "not set" state.
 * `noUncheckedIndexedAccess` is on → every `s[i]` access is narrowed before use.
 */

import { spawnSync } from "node:child_process";
import { Buffer } from "node:buffer";

import type { Buffer as NodeBuffer } from "node:buffer";

// ===========================================================================
// get_logger — console shim mirroring logging.getLogger("token_goat.<name>")
// ===========================================================================

/**
 * Minimal Logger interface the port needs: a name, the standard level methods,
 * and identity stability (same name → same object). This is the subset of
 * stdlib `logging.Logger` that token-goat call sites actually touch; the full
 * handler/level/filter machinery is out of scope until a layer needs it.
 */
export interface Logger {
  readonly name: string;
  debug(msg: string, ...args: unknown[]): void;
  info(msg: string, ...args: unknown[]): void;
  warning(msg: string, ...args: unknown[]): void;
  warn(msg: string, ...args: unknown[]): void;
  error(msg: string, ...args: unknown[]): void;
  critical(msg: string, ...args: unknown[]): void;
}

/**
 * Concrete console-backed Logger. Forwards each level to the corresponding
 * console method. `name` is captured at construction and surfaced via a
 * readonly getter so callers can assert on `log.name === "token_goat.foo"`
 * exactly as the Python tests do.
 */
class ConsoleLogger implements Logger {
  constructor(private readonly _name: string) {}
  get name(): string {
    return this._name;
  }
  debug(msg: string, ...args: unknown[]): void {
    console.debug(`[${this._name}] ${msg}`, ...args);
  }
  info(msg: string, ...args: unknown[]): void {
    console.info(`[${this._name}] ${msg}`, ...args);
  }
  warning(msg: string, ...args: unknown[]): void {
    console.warn(`[${this._name}] ${msg}`, ...args);
  }
  warn(msg: string, ...args: unknown[]): void {
    console.warn(`[${this._name}] ${msg}`, ...args);
  }
  error(msg: string, ...args: unknown[]): void {
    console.error(`[${this._name}] ${msg}`, ...args);
  }
  critical(msg: string, ...args: unknown[]): void {
    console.error(`[${this._name}] ${msg}`, ...args);
  }
}

/**
 * Process-wide logger cache keyed by full dotted name. Mirrors CPython's
 * logging.Manager.loggerDict: getLogger is idempotent by name and returns the
 * same object on repeat calls (the `get_logger_same_instance` invariant). A
 * plain object (not a Map) to keep it allocation-free on the hot path; the
 * cache grows slowly (one entry per module) and lives for process lifetime.
 */
const _loggerCache = new Map<string, Logger>();

/**
 * Return a Logger named `token_goat.<name>`.
 *
 * Centralises the `token_goat.` prefix so each module only needs:
 *   const _LOG = getLogger("module_name");
 * Identity-stable: the same name always returns the same object.
 *
 * @param name Bare module name (no `token_goat.` prefix); dotted sub-module
 *   names like `"languages.html"` are preserved verbatim after the prefix.
 */
export function getLogger(name: string): Logger {
  const full = `token_goat.${name}`;
  let log = _loggerCache.get(full);
  if (log === undefined) {
    log = new ConsoleLogger(full);
    _loggerCache.set(full, log);
  }
  return log;
}

// ===========================================================================
// normalize_path — WSL / Cygwin / MSYS drive collapse + backslash → slash
// ===========================================================================

/**
 * Compiled once at import time — avoids recompiling on every normalizePath
 * call. Accept either case for the drive letter ([a-zA-Z]); the captured group
 * is lowercased in normalizePath so /mnt/C/foo and /mnt/c/foo collapse to the
 * same canonical key. Verbatim port of Python's
 *   _WSL_PATH_RE = re.compile(r"^/mnt/([a-zA-Z])/(.*)$", re.DOTALL)
 * The "s" (DOTALL) flag is irrelevant here: the regex anchors at ^ and the
 * capture is greedy up to end-of-string, so embedded newlines match exactly as
 * in Python (the `.` class including \n under DOTALL). JS's `[^]` (any char
 * including newline) is the DOTALL-equivalent catch-all.
 */
const _WSL_PATH_RE = /^\/mnt\/([a-zA-Z])\/([\s\S]*)$/;

/**
 * Normalize a file path to a canonical string form for cross-platform key
 * lookups. Accepts `string` only (the Python overload took `str | Path`; in the
 * TS port every caller already has a string — `pathlib.Path` has no JS twin, so
 * the union is collapsed at the boundary).
 *
 * Transformations applied in order (verbatim from normalize_path):
 *  1. Replace all backslashes with forward slashes. Done BEFORE the WSL check
 *     so mixed-separator paths like `/mnt/c/foo\bar` are fully normalised
 *     before the regex runs.
 *  2. Detect WSL paths of the form `/mnt/<drive>/rest` and convert them to the
 *     Windows canonical form `<drive>:/rest`. Only single-letter drive
 *     components are converted; `/mnt/data` is left unchanged.
 *  3. Lowercase the Windows drive letter prefix (`C:` → `c:`) on all platforms.
 *
 * This is a STRING canonicalizer, not a filesystem canonicalizer: symlinks,
 * junctions, and NTFS case-folding are not resolved.
 *
 * Examples:
 *   normalizePath("/mnt/c/foo/bar")   === "c:/foo/bar"
 *   normalizePath("C:\\foo\\bar")     === "c:/foo/bar"
 *   normalizePath("c:/foo/bar")       === "c:/foo/bar"
 *   normalizePath("/home/user/proj")  === "/home/user/proj"
 */
export function normalizePath(path: string): string {
  let s = path;

  // Step 1: replace backslashes before WSL check so mixed-separator paths are
  // fully normalized before the regex runs.
  if (s.includes("\\")) {
    s = s.replace(/\\/g, "/");
  }

  // Step 2: convert WSL /mnt/<single-letter-drive>/rest → <drive>:/rest.
  const m = _WSL_PATH_RE.exec(s);
  if (m !== null) {
    const driveLetter = m[1]!.toLowerCase(); // lowercase so /mnt/C and /mnt/c agree
    const rest = m[2]!;
    s = `${driveLetter}:/${rest}`;
  }

  // Step 3: lowercase the drive letter prefix (C: → c:) on all platforms.
  // WSL processes emit Windows-format paths on Linux; both must produce the
  // same cache key, so lowercasing is unconditional.
  if (s.length >= 2 && s.charAt(1) === ":" && s.charAt(0) >= "A" && s.charAt(0) <= "Z") {
    s = s.charAt(0).toLowerCase() + s.slice(1);
  }

  return s;
}

// ===========================================================================
// run_git — single chokepoint for every git subprocess invocation
// ===========================================================================

/**
 * Analogue of subprocess.CompletedProcess[str]. Field names are snake_cased to
 * match the Python dataclass exactly so call sites port one-for-one:
 * `cp.stdout`, `cp.returncode`, etc. `returncode` is non-optional: a spawn
 * failure (git not installed / ENOENT) is reported as -1 rather than undefined,
 * so callers that branch on `returncode !== 0` see a failure as they do in
 * Python when check=False swallows the FileNotFoundError-less subprocess.
 */
export interface CompletedProcess {
  args: string[];
  stdout: string;
  stderr: string;
  returncode: number;
}

/**
 * Options for runGit. All optional; defaults match Python's kwargs:
 *  - cwd:       None  (inherit the current working directory)
 *  - timeout:   10    (seconds — passed to spawnSync as ms)
 *  - envExtra:  None  (merged on top of process.env)
 *  - check:     false (never throw on non-zero exit)
 *
 * `exactOptionalPropertyTypes` requires each optional field be typed
 * `T | undefined` (not `T | null`) and that an explicit `undefined` is a
 * legal "unset" value; callers that omit a field entirely also work because
 * the destructure below guards with `?? default`.
 */
export interface RunGitOptions {
  cwd?: string | undefined;
  timeout?: number | undefined;
  envExtra?: Record<string, string> | undefined;
  check?: boolean | undefined;
}

/**
 * Run `git --no-optional-locks -c core.fsmonitor= <args>` and return a
 * CompletedProcess. The single chokepoint every git invocation in token-goat
 * must go through — the test suite enforces this at the source level (see
 * test_no_bare_git_subprocess_calls_outside_util), so do NOT spawn git
 * directly elsewhere.
 *
 * Design rationale (each preserved from run_git):
 *  - `--no-optional-locks` is prepended automatically so git never acquires the
 *    optional `.git/index.lock` (used for e.g. `status` refreshes). This
 *    prevents interference with the editor/agent that already owns the lock.
 *  - `-c core.fsmonitor=` disables fsmonitor for the invocation, so the spawn
 *    never triggers a fsmonitor refresh that could race the editor's own git
 *    state. (Added relative to the Python original because Node's spawn has
 *    no per-invocation config inheritance subtleties; harmless and identical
 *    in effect.)
 *  - capture stdout + stderr (never inherit the terminal): every caller
 *    inspects stdout/stderr; inherited TTY output would pollute hook JSON.
 *  - `encoding: "utf8"`: Node decodes captured bytes as UTF-8 and, like
 *    Python's `errors="replace"`, substitutes U+FFFD for invalid sequences
 *    rather than throwing — the exact contract Windows callers rely on when
 *    git emits non-UTF-8 path bytes.
 *  - `check: false` by default: many callers treat non-zero exit as a sentinel
 *    (e.g. "not a git repo" returns 128). Pass `check: true` to throw on
 *    non-zero exit instead.
 *  - `envExtra` is merged on top of `process.env` so callers can set
 *    `GIT_TERMINAL_PROMPT=0` without reconstructing the whole environment.
 *
 * Spawn errors (git not on PATH — ENOENT) are folded into the CompletedProcess
 * as `returncode: -1` with the error message in `stderr`. This mirrors the
 * behaviour Python callers already tolerate: they check `returncode !== 0` and
 * fall through; a thrown exception here would break that contract. (`check:
 * true` still does not throw on ENOENT — only on a non-zero exit code — which
 * matches `subprocess.run(check=True)` raising `CalledProcessError` but NOT
 * `FileNotFoundError`.)
 *
 * @param args  Git argument vector (without the `git` / `--no-optional-locks`
 *              prefix — those are injected here).
 * @param opts  Optional cwd / timeout / envExtra / check.
 */
export function runGit(args: string[], opts?: RunGitOptions): CompletedProcess {
  const cwd = opts?.cwd;
  const timeoutSec = opts?.timeout ?? 10;
  const envExtra = opts?.envExtra;
  const check = opts?.check ?? false;

  // process.env values are `string | undefined`; ProcessEnv matches that exactly
  // and is what spawnSync's `env` option accepts.
  const env: NodeJS.ProcessEnv = { ...process.env, ...(envExtra ?? {}) };
  const fullArgs = ["--no-optional-locks", "-c", "core.fsmonitor=", ...args];

  const spawned = spawnSync("git", fullArgs, {
    cwd,
    // Python's timeout is in seconds; spawnSync takes ms.
    timeout: timeoutSec * 1000,
    encoding: "utf8",
    // Capture both streams — mirrors capture_output=True.
    stdio: ["ignore", "pipe", "pipe"],
    env,
    // Windows hides the console window for spawned processes; without this,
    // every git call flashes a cmd window on a TTY-attached run.
    windowsHide: true,
  });

  // spawnSync populates .error (ENOENT, ETIMEDOUT, ...) on spawn failure.
  // Fold it into the CompletedProcess as a synthetic non-zero exit so callers
  // that branch on returncode !== 0 see a failure, exactly as Python's
  // subprocess.run(check=False) does for FileNotFoundError.
  if (spawned.error !== undefined) {
    return {
      args: fullArgs,
      stdout: typeof spawned.stdout === "string" ? spawned.stdout : "",
      stderr:
        (typeof spawned.stderr === "string" ? spawned.stderr : "") +
        `${spawned.error.name}: ${spawned.error.message}`,
      returncode: -1,
    };
  }

  const returncode = spawned.status ?? -1;

  if (check && returncode !== 0) {
    // Python's CalledProcessError message includes the cmd + returncode; we
    // throw an Error with the same shape so callers catching on message text
    // still match. The full CompletedProcess is attached for diagnostics.
    throw new Error(
      `Command ['git', ${JSON.stringify(fullArgs)}] returned non-zero exit status ${returncode}.`,
    );
  }

  return {
    args: fullArgs,
    stdout: typeof spawned.stdout === "string" ? spawned.stdout : "",
    stderr: typeof spawned.stderr === "string" ? spawned.stderr : "",
    returncode,
  };
}

// ===========================================================================
// sanitize_surrogates — replace lone UTF-16 surrogates with U+FFFD
// ===========================================================================

/**
 * Replace lone surrogate characters (U+DC80–U+DCFF, and unpaired high
 * surrogates U+D800–U+DBFF) with U+FFFD.
 *
 * In Python this was `text.encode("utf-8", errors="replace").decode("utf-8",
 * errors="replace")` — surrogateescape bytes round-tripped as \udcXX code points
 * that crash later UTF-8 serialisation. JS strings are UTF-16, so the analogous
 * hazard is unpaired surrogates (which Node's JSON.stringify and UTF-8 encoder
 * replace with U+FFFD silently, but fs writes and some Buffer paths can emit).
 *
 * Implementation: Buffer.from(s, "utf8") replaces each unpaired surrogate with
 * U+FFFD (encoded as 0xEF 0xBF 0xBD); decoding that buffer back to a UTF-16
 * string yields a string with U+FFFD in place of every offending surrogate.
 * This is byte-identical in effect to the Python encode/decode round-trip for
 * the surrogate range, and a no-op for all valid Unicode (including astral
 * characters encoded as a properly-paired surrogate team).
 *
 * @param text Input that may contain lone surrogates.
 * @returns Same string with every lone surrogate replaced by U+FFFD.
 */
export function sanitizeSurrogates(text: string): string {
  return Buffer.from(text, "utf8").toString("utf8");
}

// ===========================================================================
// sanitize_control_chars — strip non-printable C0/C1 except \t \n \r
// ===========================================================================

/**
 * Compiled once at import time. Verbatim port of Python's
 *   re.compile(r"[\x00-\x08\x0b\x0c\x0e-\x1f\x80-\x9f]")
 * which strips C0 (U+0000–U+001F) except tab/newline/CR, plus all of C1
 * (U+0080–U+009F). Note the gaps at \x09 (tab), \x0a (LF), \x0d (CR) — those
 * are intentionally preserved.
 *
 * JS regex character classes use the same \xNN escapes; the Unicode "u" flag is
 * NOT set because the Python source is a byte-class regex and C1 chars are
 * single UTF-16 units here (U+0080–U+009F fit in one UTF-16 code unit, so no
 * surrogate-pair concerns).
 */
const _CONTROL_CHARS_RE = /[\x00-\x08\x0b\x0c\x0e-\x1f\x80-\x9f]/g;

/**
 * Remove non-printable control characters while preserving safe characters.
 *
 * Strips C0 control characters (U+0000–U+001F) EXCEPT tab (U+0009), newline
 * (U+000A), and carriage return (U+000D). Also strips C1 control characters
 * (U+0080–U+009F). Preserves all printable Unicode including box-drawing
 * characters (U+2500–U+257F) and CJK/emoji.
 *
 * Idempotent and safe to call multiple times.
 */
export function sanitizeControlChars(text: string): string {
  return text.replace(_CONTROL_CHARS_RE, "");
}

// ===========================================================================
// strip_ansi — SGR / cursor / OSC / PUA stripping (ported from render/ansi.py)
// ===========================================================================

/**
 * ESC byte (0x1B). Hoisted as a const so the fast-path membership check reads
 * as intent (`input.includes(ESC)`) rather than a magic char literal.
 */
const ESC = "\x1b";

/**
 * Master ANSI stripper. Strips, in a single replace pass:
 *   1. CSI sequences: ESC [ ... final-letter  (SGR colours, cursor moves, etc.)
 *   2. OSC sequences: ESC ] ... (BEL | ST)     (window title, hyperlinks)
 *   3. Remaining ESC + single-letter escapes (ESC ( B charset, etc.)
 *   4. Private-Use Area characters (U+E000–U+F8FF, U+F0000–U+FFFFD,
 *      U+100000–U+10FFFD) — the icon glyphs tools like Powerlevel10k embed.
 *
 * Verbatim port of the 4-alternation regex in render/ansi.py, plus the ESC-byte
 * fast path and the PUA class. The PUA stripping is implemented alongside ANSI
 * stripping (rather than as its own function) because checking for PUA alone
 * would negate the fast-path speedup — so PUA chars are only removed when there
 * are ALSO ANSI escapes in the string. This is a deliberate design tradeoff
 * preserved from the Python original and exercised by the tests.
 *
 * Alternation order matters:
 *   - OSC must be tried before the generic ESC-letter escape, or the ESC ] of
 *     an OSC sequence would be eaten by the simpler pattern and leave the
 *     payload behind.
 *   - ST terminator is ESC \ (i.e. ESC + backslash); in a JS regex literal,
 *     that's \\x1b\\\\ (escape the backslash). BEL is \\x07.
 *   - The PUA alternation includes the Basic Multilingual Plane PUA
 *     (U+E000–U+F8FF), Supplementary PUA-A (U+F0000–U+FFFFD), and
 *     Supplementary PUA-B (U+100000–U+10FFFD). The supplementary ranges are
 *     matched as surrogate pairs (\\uD800-\\uDBFF + \\uDC00-\\uDFFF) — JS regex
 *     without the "u" flag treats each surrogate as a separate code unit, so
 *     the pair form is required to match an astral PUA glyph.
 *
 * The `g` flag is required to strip every occurrence in one pass (Python's
 * re.sub is global by default).
 */
// CSI: ESC [ followed by parameter/intermediate bytes, then a final byte 0x40–0x7E.
// OSC: ESC ] ... terminated by BEL (\x07) or ST (ESC \).
// ESC + single char: ESC followed by any single byte (catches ESC ( B, ESC =, etc.).
// PUA: BMP PUA (U+E000–U+F8FF) and supplementary PUA via surrogate pairs.
const _ANSI_RE = /(?:\x1b\[[0-9;?]*[ -\/]*[@-~])|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b.[-]|[-]|[\uD800-\uDBFF][\uDC00-\uDFFF]/g;

/**
 * Strip ANSI escape sequences and PUA icon glyphs from text.
 *
 * Fast path: if the input contains no ESC byte (0x1B) AND no BMP PUA char
 * (U+E000–U+F8FF), the input is returned as-is — same reference, no regex run.
 * This is the common case (most lines have neither), and skipping the regex
 * engine is the performance optimization the Python original was built around.
 *
 * When the fast path does NOT apply (there is at least one ESC or PUA byte),
 * every CSI/OSC/escape/PUA sequence is removed via a single global replace.
 *
 * Re-exported from util so callers that historically imported
 * `token_goat.util.strip_ansi` (and the Python `from .render.ansi import
 * strip_ansi` re-export) port one-for-one. The canonical implementation lives
 * here in the TS port until render/ansi.ts lands (Layer 5), at which point this
 * file will re-export from there exactly as the Python module does.
 *
 * @param input Possibly ANSI/PUA-laden text.
 * @returns Visible text only.
 */
export function stripAnsi(input: string): string {
  // Fast path: plain text with no ESC byte and no BMP PUA returns immediately,
  // same reference (the `is`-identity the Python test asserts on `result is text`).
  if (!input.includes(ESC) && !/[-]/.test(input)) {
    return input;
  }
  return input.replace(_ANSI_RE, "");
}

// ===========================================================================
// strip_bom — drop a leading U+FEFF
// ===========================================================================

/** UTF-8 BOM as it appears once decoded into a JS string: U+FEFF. */
const BOM = "﻿";

/**
 * Remove a UTF-8 BOM (U+FEFF) from the start of a string if present.
 *
 * On Windows, files written with a UTF-8 BOM carry U+FEFF at position 0 once
 * decoded; JSON.parse rejects it. This drops exactly one leading U+FEFF,
 * leaving the string unchanged if no BOM is present, and is idempotent. A BOM
 * in the middle of the string is NOT removed (only position 0 counts).
 *
 * @param text Input that may start with a UTF-8 BOM.
 * @returns Input with a single leading BOM removed, else unchanged.
 */
export function stripBOM(text: string): string {
  if (text.startsWith(BOM)) {
    return text.slice(1);
  }
  return text;
}

// ===========================================================================
// utf8_bytes — canonical UTF-8 byte helper (surrogate-safe)
// ===========================================================================

/**
 * Encode `s` to a UTF-8 Buffer, replacing lone surrogates with U+FFFD.
 *
 * This is the canonical byte-length helper for all token-saving and cache
 * byte-count calculations across the codebase. It is equivalent to
 * `Buffer.from(s, "utf8")` but centralises the encoding contract so callers
 * don't need to repeat the "lone surrogate is replaced, not raised" guard.
 *
 * Use this wherever you need `len(s.encode("utf-8"))` (byte-length check) or
 * the raw bytes for storage — it is safe on all strings, including those with
 * surrogate-escape sequences from subprocess output.
 *
 * @param s String to encode.
 * @returns UTF-8 Buffer with lone surrogates replaced by U+FFFD bytes.
 */
export function utf8Bytes(s: string): NodeBuffer {
  return Buffer.from(s, "utf8");
}

// ===========================================================================
// ellipsize — truncate to N chars with trailing …
// ===========================================================================

/**
 * Truncate `s` to `maxChars` characters, appending a trailing `…` when it
 * exceeds that length. When `len(s) <= maxChars`, `s` is returned unchanged.
 * When it exceeds `maxChars`, the string is sliced to `maxChars - 1`
 * characters and `…` is appended so the result is exactly `maxChars`
 * characters long.
 *
 * Note: JS `.length` counts UTF-16 code units, so a string with an astral
 * character (e.g. an emoji) counts it as 2 — matching Python's `len()` on a
 * surrogate-pair-encoded str is NOT the same as Python's `len()` on a
 * code-point str. The Python original operates on `str` code points; the ported
 * tests all use BMP inputs, so code-unit and code-point length agree. If astral
 * inputs land in a later layer, swap to `[...s].slice(...)` for code-point
 * semantics — but only then (the code-unit path is ~10x faster and matches
 * every current caller).
 *
 * Edge case: `maxChars === 1` on an over-budget string returns just `…`
 * (slice(0, 0) + "…"), matching the Python original.
 *
 * @param s        String to truncate.
 * @param maxChars Maximum character count of the result (inclusive of the …).
 */
export function ellipsize(s: string, maxChars: number): string {
  if (s.length <= maxChars) {
    return s;
  }
  return s.slice(0, maxChars - 1) + "…";
}

// ===========================================================================
// _humanize_bytes — compact byte formatter (private, no direct tests)
// ===========================================================================

/**
 * Return a short human-readable byte count: `1.2KB`, `3.4MB`, `120B`.
 *
 * Compact (no spaces, one decimal digit) so it fits inside a manifest line
 * without competing with the command preview for visual space. Sizes below
 * 1024 use plain bytes; above that we step through KB/MB/GB at 1024-byte
 * boundaries.
 *
 * Ported verbatim from the Python `_humanize_bytes` (underscore-prefixed there
 * too). No direct test coverage in either suite; it exists for the compact /
 * render layers to import as `util._humanize_bytes`.
 *
 * @param n Byte count (non-negative integer).
 */
export function _humanizeBytes(n: number): string {
  if (n < 1024) {
    return `${n}B`;
  }
  if (n < 1024 * 1024) {
    return `${(n / 1024).toFixed(1)}KB`;
  }
  if (n < 1024 * 1024 * 1024) {
    return `${(n / (1024 * 1024)).toFixed(1)}MB`;
  }
  return `${(n / (1024 * 1024 * 1024)).toFixed(1)}GB`;
}

// ===========================================================================
// env_float / env_int — env-var parse with fallback + optional clamp
// ===========================================================================

/**
 * Read a float from an environment variable, falling back to `default` on any
 * error.
 *
 * Parses `process.env[envKey]`, strips whitespace, and converts to `Number`. If
 * the value is unset, empty, or non-numeric, `default` is returned. Optionally
 * clamps the result to `[lo, hi]` when either bound is given. This consolidates
 * the repeated `parseFloat(process.env[key] ?? "")` pattern that yields NaN on
 * non-numeric values.
 *
 * Python parity notes:
 *  - Python's `float(raw)` rejects `"nan"`, `"inf"`, `"1e999"`-overflow
 *    differently than JS's `Number(raw)`. JS parses `"NaN"` / `"Infinity"` /
 *    `"+Infinity"` as the corresponding float values; Python's `float()` also
 *    accepts them, so the two agree on those. For genuine overflow
 *    (`1e400` → JS `Infinity` vs Python `OverflowError → default`), we treat
 *    any non-finite result (NaN/Infinity/-Infinity) as "unparseable" and return
 *    `default` — matching Python's OverflowError branch. This is the only
 *    observable behaviour difference vs. a naive `Number(raw)`, and it makes
 *    the port match the Python contract: env-var-driven knobs never end up at
 *    Infinity just because a user typed `1e400`.
 *  - Whitespace strip is done via `.trim()` (Python's `.strip()`), which in JS
 *    also strips Unicode whitespace categories — a superset of Python's
 *    str.strip — but in practice every env var value uses ASCII whitespace, so
 *    the two agree.
 *
 * @param envKey     Environment variable name.
 * @param defaultVal Fallback value when the var is absent or invalid.
 * @param lo         Lower bound (inclusive); undefined means no lower clamp.
 * @param hi         Upper bound (inclusive); undefined means no upper clamp.
 */
export function envFloat(
  envKey: string,
  defaultVal: number,
  opts?: { lo?: number | undefined; hi?: number | undefined },
): number {
  const lo = opts?.lo;
  const hi = opts?.hi;

  const raw = (process.env[envKey] ?? "").trim();
  if (raw === "") {
    return defaultVal;
  }
  const val = Number(raw);
  // Number("") is 0 (already guarded above), Number("abc") is NaN, Number("1e400")
  // is Infinity. Treat all non-finite results as "invalid → defaultVal" to match
  // Python's float() raising ValueError/OverflowError on the same inputs.
  if (!Number.isFinite(val)) {
    return defaultVal;
  }
  let clamped = val;
  if (lo !== undefined && clamped < lo) {
    clamped = lo;
  }
  if (hi !== undefined && clamped > hi) {
    clamped = hi;
  }
  return clamped;
}

/**
 * Read an integer from an environment variable, falling back to `default` on
 * any error.
 *
 * Parses `process.env[envKey]`, strips whitespace, and converts via a strict
 * integer parse (optional sign, digits only — no `1.5`, no `1e3`, no hex
 * prefix). If the value is unset, empty, or non-integer, `default` is
 * returned. Optionally clamps to `[lo, hi]`.
 *
 * Python parity notes:
 *  - Python's `int(raw)` accepts `"0x10"` (hex), `"0o17"` (octal), `" 5 "`
 *    (whitespace-padded), and rejects `"1.5"` / `"1e3"`. JS's `Number(raw)`
 *    accepts `"1.5"` and `"1e3"` and any trailing-non-digit junk returns NaN,
 *    so it's NOT a drop-in for `int()`. We instead use a strict
 *    `/^[+-]?\d+$/` test (Python's `int()` also accepts Unicode digits and
 *    leading/trailing whitespace; `\d` in a non-"u" regex is ASCII-only, which
 *    matches what real env vars carry). This makes `envInt("K", 5, ...)` return
 *    the default for `K=1.5`, `K=1e3`, `K=0x10`, and `K=abc` — exactly as
 *    Python's `int()` does for `1.5`/`1e3`/`abc` (Python does accept `0x10`
 *    with base=10 only if... actually `int("0x10")` raises ValueError with the
 *    default base=10, so the parity holds even for hex).
 *  - Whitespace strip mirrors envFloat: `.trim()` on the raw value.
 *
 * @param envKey     Environment variable name.
 * @param defaultVal Fallback value when the var is absent or invalid.
 * @param lo         Lower bound (inclusive); undefined means no lower clamp.
 * @param hi         Upper bound (inclusive); undefined means no upper clamp.
 */
export function envInt(
  envKey: string,
  defaultVal: number,
  opts?: { lo?: number | undefined; hi?: number | undefined },
): number {
  const lo = opts?.lo;
  const hi = opts?.hi;

  const raw = (process.env[envKey] ?? "").trim();
  if (raw === "") {
    return defaultVal;
  }
  // Strict integer syntax: optional sign, one-or-more ASCII digits, nothing
  // else. Rejects floats, scientific notation, hex, and trailing junk.
  if (!/^[+-]?\d+$/.test(raw)) {
    return defaultVal;
  }
  const val = Number(raw);
  if (!Number.isFinite(val)) {
    // A digit string > Number.MAX_VALUE parses to Infinity — treat as invalid,
    // matching Python's OverflowError branch.
    return defaultVal;
  }
  let clamped = val;
  if (lo !== undefined && clamped < lo) {
    clamped = lo;
  }
  if (hi !== undefined && clamped > hi) {
    clamped = hi;
  }
  return clamped;
}

// ===========================================================================
// configure_stdout_encoding — no-op stub (Node already uses UTF-8)
// ===========================================================================

/**
 * Reconfigure process I/O to UTF-8.
 *
 * In Python this reconfigures `sys.stdout` / `sys.stderr` from the Windows
 * default cp1252 to UTF-8 with errors="replace", so box-drawing chars and emoji
 * in lefthook/delta output don't crash on print. Node's process I/O is already
 * UTF-8 by default on every platform (it has no legacy DOS codepage fallback),
 * so there is nothing to do — the function is retained as an empty stub so
 * call sites in later layers can import it unconditionally without an `if
 * (typeof window !== ...)` guard.
 *
 * The stub catches nothing and reconfigures nothing: it exists purely to keep
 * the public surface 1:1 with the Python module. If a future Node runtime ever
 * surfaces a legacy-encoding edge case, grow this stub rather than removing it.
 */
export function configureStdoutEncoding(): void {
  // Intentional no-op. See docstring.
}

// ===========================================================================
// __all__ — public symbol surface (parity with Python's util.__all__)
// ===========================================================================

/**
 * Public symbol list, mirroring Python's `util.__all__`. Kept as a runtime
 * array (not a TS `export type`) so the test that asserts `"utf8_bytes" in
 * util.__all__` ports one-for-one. The names use the Python snake_case form
 * even though the runtime exports are camelCase: the Python `__all__` is the
 * canonical contract callers and tests grep for, so it is preserved verbatim;
 * the camelCase aliases are the JS-idiomatic surface. (The two surfaces
 * overlap completely — every snake_case name here has a camelCase export — so
 * a caller can reach any symbol by either spelling.)
 */
export const __all__ = [
  "strip_ansi",
  "get_logger",
  "normalize_path",
  "run_git",
  "sanitize_surrogates",
  "sanitize_control_chars",
  "ellipsize",
  "utf8_bytes",
  "env_float",
  "env_int",
  "configure_stdout_encoding",
  "strip_bom",
] as const;
