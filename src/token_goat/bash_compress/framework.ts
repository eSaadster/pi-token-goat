/**
 * bash_compress FRAMEWORK CORE — TypeScript port of the framework portion of
 * src/token_goat/bash_compress.py (the 26,234-LOC compression mega-module).
 *
 * This file ports ONLY the framework: module constants, the shared text-shaping
 * helpers (roughly Python lines 300-2128), the CompressedOutput dataclass, the
 * abstract BaseFilter, the concrete Filter base, and the two FOUNDATIONAL
 * fallback filters GenericFilter + PythonFilter. The ~150 tool-specific Filter
 * subclasses (CargoFilter, DockerFilter, GitFilter, PytestFilter, ...) are
 * EXPLICITLY OUT OF SCOPE for this run — they land in later runs as separate
 * modules that import this framework.
 *
 * The dispatch (compress_output / select_filter / detect_from_command) and the
 * FILTERS registry live in the BARREL one level up (../bash_compress.ts), which
 * re-exports this module's public surface and seeds FILTERS with the foundational
 * filters available now.
 *
 * ---------------------------------------------------------------------------
 * Parity notes (Python -> TS)
 * ---------------------------------------------------------------------------
 *  - Python identifiers are preserved EXACTLY: snake_case for functions/constants
 *    (DEFAULT_MAX_LINES, cap_bytes, strip_progress, _safe_decode, ...) and the
 *    PascalCase class names exactly as in Python (BaseFilter, Filter,
 *    GenericFilter, PythonFilter, CompressedOutput). camelCase aliases may be
 *    ADDED but the snake_case/PascalCase original always exists — it is the
 *    canonical contract the test files import/assert on.
 *  - BYTE-EXACTNESS is central. cap_bytes / cap_tokens / DEFAULT_MAX_BYTES /
 *    MAX_INSPECT_BYTES / DEFAULT_MAX_INPUT_BYTES all measure UTF-8 BYTES via
 *    Buffer (util.utf8Bytes), never String.length. Python's
 *    `text.encode("utf-8", errors="replace")` -> Buffer.from(text, "utf8")
 *    (Node replaces lone surrogates with U+FFFD, matching errors="replace" for
 *    the surrogate range). When slicing bytes we walk back to a UTF-8 code-point
 *    boundary so a multibyte char is never split — Buffer.toString("utf8")
 *    already substitutes U+FFFD for a trailing partial sequence, which matches
 *    Python's decode(errors="replace").
 *  - bytes_to_tokens uses math.ceil(n / 3.5) -> Math.ceil(n / 3.5), with the
 *    max(1, ...) guard. cap_tokens copies the token cap math verbatim:
 *    estimated_tokens = len(strip_ansi(text)) / 3.5 (code-point length, matching
 *    Python len() for the BMP text bash output carries), max_bytes =
 *    int(max_tokens * 3.5) -> Math.trunc(max_tokens * 3.5).
 *  - re.compile(...) -> top-level RegExp compiled once at module load, preserving
 *    flags/semantics (IGNORECASE -> "i", MULTILINE -> "m", DOTALL handled via
 *    [\s\S] where needed). The BYTE regex re.compile(rb"\x00") (_NULL_BYTE_RE)
 *    operates on a Buffer in Python; the TS port strips null bytes from the
 *    decoded string instead (the only caller, _safe_decode, decodes first then
 *    strips — semantically identical: a null byte is U+0000 in both the byte and
 *    the decoded-string domain, and decode(errors="replace") never introduces or
 *    removes a 0x00). Reported in parity_notes.
 *  - abc.ABC -> a TS `abstract class`; the abstract methods (detect_from_command,
 *    compress) -> abstract method signatures. Python's
 *    `with pytest.raises(TypeError, match="abstract"): BaseFilter()` is enforced
 *    at the type level in TS (you cannot `new` an abstract class); a runtime
 *    guard in the BaseFilter constructor reproduces the THROW so a JS caller that
 *    bypasses the type checker still gets a TypeError mentioning "abstract".
 *  - @dataclass CompressedOutput -> a class with a constructor and readonly-ish
 *    fields. The Python @property accessors (bytes_saved / tokens_saved /
 *    percent_saved) -> TS getters; with_marker() -> a method. notes defaults to
 *    [] via a constructor default (Python field(default_factory=list)).
 *  - Module-global mutable state: this framework owns NONE beyond the compiled
 *    regexes and the module logger (both immutable for the process lifetime), so
 *    there is nothing to wipe — no registerReset is wired here (mirrors
 *    render/ansi.ts, which also registers nothing). The barrel's FILTERS registry
 *    is the closest thing to module state but it is a fixed seed list, not a
 *    per-test-dirtied cache. registerReset is imported for forward-compat and
 *    referenced in a no-op so a later run that adds a TTL cache here has the seam
 *    ready; see the bottom of this file.
 *  - Logging: getLogger("bash_compress") from util.
 *  - _strip_git_crlf_warnings / the _GIT_CRLF_* regexes are ported here because
 *    Filter.apply() calls _strip_git_crlf_warnings on the normalised streams when
 *    self.name.startswith("git"). The git FILTERS themselves are out of scope,
 *    but the helper + its regexes are framework-level (apply() is framework), so
 *    they ship now. _is_diff_add / _is_diff_remove are in Python's __all__ and
 *    are framework-public, so they ship now too even though their only callers
 *    are the deferred git/diff filters.
 *  - shlex.split: Python uses shlex for argv parsing in detect_from_command /
 *    matches / _strip_prefixes / can_handle. Node has no shlex; a faithful POSIX
 *    shlex tokenizer (_shlexSplit) is implemented locally, supporting posix=True
 *    (quote removal, backslash escapes) and posix=False (quotes retained). It
 *    raises on unbalanced quotes exactly as Python's shlex.split does so the
 *    fail-soft try/catch in can_handle / detect_from_command behaves identically.
 *  - pathlib.Path(argv[0]).stem / .name -> local _pathStem / _pathName helpers
 *    (final component after normalising backslashes; stem strips the LAST
 *    extension, matching Path.stem which stops at the final dot — NOT the first).
 *    Python's str.strip("\"'") -> _stripQuotes (strip leading/trailing quote
 *    chars from both ends).
 *
 * NOTE on import depth: this file lives in the bash_compress/ SUBDIR, so
 * sibling-package imports go UP one level (../).
 *
 * verbatimModuleSyntax is on -> type-only imports use `import type`.
 * exactOptionalPropertyTypes is on -> optional fields are `T | undefined`.
 * noUncheckedIndexedAccess is on -> every indexed access is narrowed.
 */

import { Buffer } from "node:buffer";

// The shipped Layer 1-4c TS modules export camelCase names; the Python source
// uses snake_case (strip_ansi / has_high_entropy_token / env_int /
// sanitize_control_chars). We alias each camelCase export to the snake_case name
// this port uses internally so the body reads as a 1:1 port of the Python while
// resolving against the real shipped exports. (render/ansi.ts exports
// `stripAnsi`, not `strip_ansi`; entropy.ts exports `hasHighEntropyToken`;
// util.ts exports `envInt` / `sanitizeControlChars`.)
import { stripAnsi as strip_ansi } from "../render/ansi.js";
import { hasHighEntropyToken as has_high_entropy_token } from "../entropy.js";
import { envInt as env_int, getLogger, sanitizeControlChars as sanitize_control_chars } from "../util.js";
import { registerReset } from "../reset.js";

const _LOG = getLogger("bash_compress");

/**
 * Return the shared "bash_compress" logger.
 *
 * The barrel (../bash_compress.ts) needs the same logger instance for its
 * dispatch diagnostics; exposing it through this getter keeps the dotted
 * "token_goat.bash_compress" name defined in exactly one place (here) rather than
 * re-deriving it in the barrel. getLogger is identity-stable, so this returns the
 * same object as the module-local _LOG.
 */
export function getBashCompressLogger(): ReturnType<typeof getLogger> {
  return _LOG;
}

// ===========================================================================
// Tunable limits
// ===========================================================================

/**
 * Maximum line count produced by any filter. Beyond this the filter elides the
 * middle of the output with a truncate_middle marker. ~1000 lines at ~80 chars
 * each is about 80 KB / 20K tokens, already past the point where a human (or a
 * model) is reading every line.
 */
export const DEFAULT_MAX_LINES = 1000;

/**
 * Maximum byte count produced by any filter. Acts as a backstop when individual
 * lines are unusually long (binary diff, base64, ...). 64 KiB corresponds to
 * ~16K tokens which is still a meaningful chunk of context.
 */
export const DEFAULT_MAX_BYTES = 64 * 1024;

/**
 * Maximum bytes of raw output a filter is willing to inspect. Beyond this the
 * filter falls back to head/tail truncation without per-tool analysis to keep
 * filter runtime bounded. 2 MiB covers virtually any realistic command.
 */
export const MAX_INSPECT_BYTES = 2 * 1024 * 1024;

/**
 * Maximum bytes of input the filter pipeline will accept before truncating.
 * Applies to the combined raw stdout + stderr before normalisation so that even
 * ANSI-heavy output cannot cause a multi-second stall inside the filter.
 * Override via the env var TOKEN_GOAT_FILTER_MAX_BYTES (integer bytes).
 */
export const DEFAULT_MAX_INPUT_BYTES = 500 * 1024; // 500 KiB

/** Return the effective MAX_INPUT_BYTES cap (env override or default). */
export function _get_max_input_bytes(): number {
  const v = env_int("TOKEN_GOAT_FILTER_MAX_BYTES", 0);
  return v > 0 ? v : DEFAULT_MAX_INPUT_BYTES;
}

/**
 * Trailing marker appended to every compressed output so the agent knows it is
 * looking at a summary and can opt out if it needs the raw view. Kept short so
 * the meta-cost of the marker is dwarfed by the savings.
 */
export const _COMPRESSION_MARKER_FMT =
  "\n[token-goat: {filter} filter -{pct:.0f}%; disable via TOKEN_GOAT_BASH_COMPRESS]";

// ===========================================================================
// Internal Python-builtin / stdlib shims (no Python analogue at the surface).
// ===========================================================================

/** UTF-8 byte length of s (Buffer.byteLength with surrogate replacement). */
function _utf8Len(s: string): number {
  return Buffer.byteLength(s, "utf8");
}

/**
 * Python str.format(filter=..., pct=...) for _COMPRESSION_MARKER_FMT only.
 * Reproduces the {pct:.0f} format spec (fixed-point, 0 decimals, round-half-up
 * via toFixed — the tested pct values are never exactly N.5 so half-even vs
 * half-up is unobservable) and the plain {filter} substitution.
 */
function _formatCompressionMarker(filter: string, pct: number): string {
  return _COMPRESSION_MARKER_FMT.replace("{filter}", filter).replace(
    "{pct:.0f}",
    pct.toFixed(0),
  );
}

/**
 * Python str.strip("\"'") — strip leading AND trailing single/double quote
 * characters from both ends. (Python's str.strip(chars) removes any leading or
 * trailing character that is in the chars set, not the literal substring.)
 */
function _stripQuotes(s: string): string {
  let start = 0;
  let end = s.length;
  while (start < end && (s[start] === '"' || s[start] === "'")) {
    start += 1;
  }
  while (end > start && (s[end - 1] === '"' || s[end - 1] === "'")) {
    end -= 1;
  }
  return s.slice(start, end);
}

/**
 * pathlib.PurePath(p).name — final path component after normalising backslashes
 * to forward slashes (Python's PurePath treats "\\" as a separator on Windows;
 * the Python source normalises with .replace("\\", "/") before constructing the
 * Path, so we do the same and split on "/").
 */
function _pathName(p: string): string {
  const norm = p.replace(/\\/g, "/");
  const trimmed = norm.replace(/\/+$/, ""); // PurePath("a/b/").name == "b"
  const idx = trimmed.lastIndexOf("/");
  return idx >= 0 ? trimmed.slice(idx + 1) : trimmed;
}

/**
 * pathlib.PurePath(p).stem — the final component with its LAST suffix removed.
 * Path.stem strips only the final extension (".tar.gz" -> stem "archive.tar"),
 * and a leading-dot dotfile with no other dot has an empty suffix (".bashrc"
 * -> stem ".bashrc"). A trailing dot is not a suffix. Reproduced here.
 */
function _pathStem(p: string): string {
  const name = _pathName(p);
  // A dot at index 0 is not a suffix separator (".bashrc" -> ".bashrc").
  const dot = name.lastIndexOf(".");
  if (dot <= 0) {
    return name;
  }
  // A trailing dot is not a suffix ("foo." -> stem "foo.").
  if (dot === name.length - 1) {
    return name;
  }
  return name.slice(0, dot);
}

/**
 * Faithful POSIX shlex.split.
 *
 * Tokenises a command string the way Python's shlex.split does. Two modes:
 *  - posix=true  (default in Python's shlex.split): quotes are removed,
 *    backslash escapes are processed (outside single quotes), and the result is
 *    the unquoted token list.
 *  - posix=false: quote characters are RETAINED in the tokens (used by the
 *    Python source's `shlex.split(cmd, posix=False)` calls so downstream
 *    quote-stripping is explicit).
 *
 * Raises an Error on an unterminated quote (Python's shlex raises
 * `ValueError("No closing quotation")`), so the fail-soft try/catch in
 * can_handle / detect_from_command degrades to "no match" exactly as in Python.
 *
 * This is a pragmatic subset: it handles single quotes, double quotes,
 * backslash escapes, and whitespace splitting — the surface bash_compress
 * dispatch actually exercises. It does not implement shlex comment handling
 * (commenters="") which Python's shlex.split also disables by default.
 */
export function _shlexSplit(s: string, opts?: { posix?: boolean }): string[] {
  const posix = opts?.posix ?? true;
  const tokens: string[] = [];
  let i = 0;
  const n = s.length;
  const isSpace = (c: string): boolean =>
    c === " " || c === "\t" || c === "\n" || c === "\r" || c === "\f" || c === "\v";

  while (i < n) {
    // Skip leading whitespace between tokens.
    while (i < n && isSpace(s[i]!)) {
      i += 1;
    }
    if (i >= n) {
      break;
    }
    let token = "";
    let inToken = false;
    while (i < n) {
      const c = s[i]!;
      if (isSpace(c)) {
        break;
      }
      inToken = true;
      if (c === "'") {
        // Single quote: everything until the next single quote is literal.
        const close = s.indexOf("'", i + 1);
        if (close === -1) {
          throw new Error("No closing quotation");
        }
        const inner = s.slice(i + 1, close);
        token += posix ? inner : `'${inner}'`;
        i = close + 1;
        continue;
      }
      if (c === '"') {
        // Double quote: process backslash escapes for \ " $ ` in posix mode.
        let j = i + 1;
        let inner = "";
        let closed = false;
        while (j < n) {
          const d = s[j]!;
          if (d === '"') {
            closed = true;
            break;
          }
          if (posix && d === "\\" && j + 1 < n) {
            const e = s[j + 1]!;
            if (e === '"' || e === "\\" || e === "$" || e === "`") {
              inner += e;
              j += 2;
              continue;
            }
            // Backslash before any other char inside double quotes is literal.
            inner += d;
            j += 1;
            continue;
          }
          inner += d;
          j += 1;
        }
        if (!closed) {
          throw new Error("No closing quotation");
        }
        token += posix ? inner : `"${inner}"`;
        i = j + 1;
        continue;
      }
      if (posix && c === "\\" && i + 1 < n) {
        // Backslash escape outside quotes: the next char is literal.
        token += s[i + 1]!;
        i += 2;
        continue;
      }
      token += c;
      i += 1;
    }
    if (inToken) {
      tokens.push(token);
    }
  }
  return tokens;
}

// ===========================================================================
// Encoding safety helpers
// ===========================================================================

// Matches Claude task-output temp paths on Windows and Unix:
//   Windows: ...\AppData\Local\Temp\claude\<proj>\<sess>\tasks\<id>.output
//   Unix:    /tmp/claude/<proj>/<sess>/tasks/<id>.output
// Python: re.compile(r"[/\\]claude[/\\][^/\\]+[/\\][^/\\]+[/\\]tasks[/\\]([a-z0-9]+)\.output$", re.IGNORECASE)
const _TASK_OUTPUT_RE: RegExp =
  /[/\\]claude[/\\][^/\\]+[/\\][^/\\]+[/\\]tasks[/\\]([a-z0-9]+)\.output$/i;

/**
 * Return the task-output blob ID from a Claude task temp-file path, or null.
 *
 * Accepts both Windows backslash and Unix forward-slash separators. The returned
 * ID is the hex token that appears as <id> in the filename <id>.output.
 */
export function _task_output_id(path: string): string | null {
  const m = _TASK_OUTPUT_RE.exec(path.replace(/\\/g, "/"));
  return m ? m[1]! : null;
}

/**
 * Return a clean Unicode string safe for all filter logic.
 *
 * Handles:
 *  - Buffer input — null bytes stripped, then decoded as UTF-8 with U+FFFD
 *    replacement for invalid sequences (errors="replace").
 *  - Null bytes (0x00) — stripped unconditionally. They are valid Unicode but
 *    invisible, break many regex matchers, and never carry meaningful content in
 *    captured shell output.
 *  - Already-decoded string — null bytes are still stripped so callers don't
 *    need to check which path was taken.
 *
 * Python's _NULL_BYTE_RE (a `rb"\x00"` byte regex) strips nulls from the raw
 * bytes BEFORE decoding; the TS port strips them from the string AFTER decoding,
 * which is equivalent because decode(errors="replace") never introduces or
 * removes a 0x00 (null is a valid code point, not an invalid byte sequence).
 *
 * This function is intentionally NOT responsible for ANSI stripping or
 * progress-line collapsing; those are handled by normalise().
 */
export function _safe_decode(data: Buffer | string): string {
  if (Buffer.isBuffer(data)) {
    // Decode with U+FFFD replacement (Buffer.toString always does this for
    // invalid UTF-8), then strip null bytes from the decoded string.
    const decoded = data.toString("utf8");
    return decoded.includes("\x00") ? decoded.replace(/\x00/g, "") : decoded;
  }
  // str path: strip null bytes only.
  if (data.includes("\x00")) {
    return data.replace(/\x00/g, "");
  }
  return data;
}

// ===========================================================================
// Common text-shaping helpers
// ===========================================================================

// strip_ansi imported from render.ansi (single authoritative implementation).
// Re-exported below for the Python __all__ surface.
export { strip_ansi };

/**
 * Collapse \r-overwrite progress lines to their final state.
 *
 * Most terminal progress renderers (pip, docker, cargo, npm, apt) emit a
 * sequence of bytes ending in \r so each subsequent update overwrites the
 * previous one. In a captured stream these renderings concatenate. This helper
 * keeps only the segment after the last \r within each line, which is what a
 * terminal user would have actually seen. Lines without \r pass through.
 */
export function strip_progress(text: string): string {
  if (!text.includes("\r")) {
    return text;
  }
  return text
    .split("\n")
    .map((line) => (line.includes("\r") ? _rsplitOnce(line, "\r")[1] : line))
    .join("\n");
}

/**
 * Python str.rsplit(sep, 1) — split on the LAST occurrence of sep into at most
 * two parts. Returns [head, tail]; when sep is absent returns ["", s] so the
 * caller can read result[1] as the whole string (matching Python's
 * `s.rsplit(sep, 1)[-1]`). The caller in strip_progress reads index 1 (the part
 * after the last \r).
 */
function _rsplitOnce(s: string, sep: string): [string, string] {
  const idx = s.lastIndexOf(sep);
  if (idx < 0) {
    return ["", s];
  }
  return [s.slice(0, idx), s.slice(idx + sep.length)];
}

/**
 * Collapse runs of identical consecutive lines to `line  (×N)`.
 *
 * A run shorter than min_run is emitted verbatim. The default fmt appends the
 * count after two spaces, which keeps grep-anchored greps on the original line
 * text working. When entropy_bypass is true, lines containing high-entropy
 * tokens (UUIDs, SHAs, JWTs, API keys) are always emitted verbatim and never
 * participate in run-length deduplication.
 */
export function dedupe_consecutive(
  lines: Iterable<string>,
  opts?: {
    min_run?: number;
    fmt?: string;
    entropy_bypass?: boolean;
  },
): string[] {
  const min_run = opts?.min_run ?? 2;
  const fmt = opts?.fmt ?? "{line}  (×{count})";
  const entropy_bypass = opts?.entropy_bypass ?? false;

  const out: string[] = [];
  let prev: string | null = null;
  let count = 0;
  const flush = (): void => {
    if (prev !== null) {
      if (count >= min_run) {
        out.push(_fmtLineCount(fmt, prev, count));
      } else {
        for (let k = 0; k < count; k += 1) {
          out.push(prev);
        }
      }
    }
  };

  for (const line of lines) {
    if (entropy_bypass && has_high_entropy_token(line)) {
      // Flush any pending run, then emit the high-entropy line verbatim.
      flush();
      prev = null;
      count = 0;
      out.push(line);
      continue;
    }
    if (line === prev) {
      count += 1;
      continue;
    }
    flush();
    prev = line;
    count = 1;
  }
  flush();
  return out;
}

/** Render a "{line}  (×{count})"-style template (the dedupe_consecutive fmt). */
function _fmtLineCount(fmt: string, line: string, count: number): string {
  return fmt.replace("{line}", line).replace("{count}", String(count));
}

// Pre-compiled pattern used by dedupe_numeric_runs for digit normalisation.
const _DIGITS_RE: RegExp = /\d+/g;

// Matches the exact bytes-elided marker appended by cap_bytes so cap_tokens can
// replace it with a token-based equivalent.
// Python: re.compile(r"\n\.\.\. \[\d+ bytes elided by token-goat\]$")
const _BYTES_ELIDED_MARKER_RE: RegExp =
  /\n\.\.\. \[\d+ bytes elided by token-goat\]$/;

/**
 * Collapse runs of lines that differ only in embedded numbers.
 *
 * Normalises all digit sequences to "#" before comparison so a structural
 * template is used as the deduplication key. When a run of min_run or more
 * consecutive lines share the same normalised template the whole run is replaced
 * by the first verbatim line plus the count marker. Runs shorter than min_run
 * pass through unchanged. Error/failure signal lines (matching _ERROR_SIGNAL_RE)
 * are never collapsed.
 */
export function dedupe_numeric_runs(
  lines: Iterable<string>,
  opts?: { min_run?: number; fmt?: string },
): string[] {
  const min_run = opts?.min_run ?? 3;
  const fmt = opts?.fmt ?? "{first}  … ({count} similar lines)";

  const line_list = [...lines];
  const out: string[] = [];
  let i = 0;
  while (i < line_list.length) {
    const line = line_list[i]!;
    // Never collapse lines containing error/failure signal.
    if (_searchErrorSignal(line)) {
      out.push(line);
      i += 1;
      continue;
    }
    const key = _digitsKey(line);
    // Look ahead for consecutive lines with the same normalised template.
    let j = i + 1;
    while (j < line_list.length) {
      const candidate = line_list[j]!;
      if (_searchErrorSignal(candidate)) {
        break;
      }
      if (_digitsKey(candidate) !== key) {
        break;
      }
      j += 1;
    }
    const run_len = j - i;
    if (run_len >= min_run) {
      out.push(_fmtFirstCount(fmt, line, run_len));
    } else {
      out.push(...line_list.slice(i, j));
    }
    i = j;
  }
  return out;
}

/** Python _DIGITS_RE.sub("#", line) — replace every digit run with a single "#". */
function _digitsKey(line: string): string {
  return line.replace(_DIGITS_RE, "#");
}

/** Render a "{first}  … ({count} similar lines)"-style template. */
function _fmtFirstCount(fmt: string, first: string, count: number): string {
  return fmt.replace("{first}", first).replace("{count}", String(count));
}

/**
 * Group lines by a regex key and keep only keep_first_n per group.
 *
 * For each line, the first capture group of key is the bucket id. Lines whose
 * pattern does not match pass through unchanged. The count in fmt is the number
 * of additional lines dropped beyond keep_first_n.
 */
export function dedupe_by_key(
  lines: Iterable<string>,
  key: RegExp,
  opts?: { keep_first_n?: number; fmt?: string },
): string[] {
  const keep_first_n = opts?.keep_first_n ?? 3;
  const fmt = opts?.fmt ?? "... +{count} more lines with key={key_value}";

  const seen = new Map<string, number>();
  const out: string[] = [];
  const summaries = new Map<string, number>();
  // key.search semantics: a fresh, non-global match per line. Clone without the
  // global flag so lastIndex state never leaks across lines.
  const re = _nonGlobal(key);
  for (const line of lines) {
    const m = re.exec(line);
    if (m === null) {
      out.push(line);
      continue;
    }
    // m.group(1) if m.groups() else m.group(0): use capture group 1 when the
    // pattern has any capture group, else the whole match.
    const bucket = m.length > 1 && m[1] !== undefined ? m[1] : m[0];
    const cur = seen.get(bucket) ?? 0;
    seen.set(bucket, cur + 1);
    if (cur + 1 <= keep_first_n) {
      out.push(line);
    } else {
      summaries.set(bucket, (summaries.get(bucket) ?? 0) + 1);
    }
  }
  for (const bucket of [...summaries.keys()].sort()) {
    out.push(_fmtKeyCount(fmt, summaries.get(bucket)!, bucket));
  }
  return out;
}

/** Render a "... +{count} more lines with key={key_value}"-style template. */
function _fmtKeyCount(fmt: string, count: number, key_value: string): string {
  return fmt.replace("{count}", String(count)).replace("{key_value}", key_value);
}

/** Return a clone of re without the global/sticky flags (for one-shot .exec). */
function _nonGlobal(re: RegExp): RegExp {
  const flags = re.flags.replace(/[gy]/g, "");
  return new RegExp(re.source, flags);
}

/**
 * Cap lines at max_lines by keeping the head and tail with a marker.
 *
 * The split favours the tail (where summaries and failures usually live) by
 * default (head_ratio=0.4 keeps 40% at the head, 60% at the tail). When the
 * input is already within budget the list is returned unchanged. The marker is
 * one extra line so the actual output length is max_lines + 1 (deliberate: the
 * marker is metadata, not payload).
 */
export function truncate_middle(
  lines: string[],
  max_lines: number,
  opts?: { head_ratio?: number; marker_fmt?: string },
): string[] {
  const head_ratio = opts?.head_ratio ?? 0.4;
  const marker_fmt = opts?.marker_fmt ?? "... [{n} lines elided by token-goat]";

  if (lines.length <= max_lines) {
    return lines;
  }
  const head_keep = Math.max(1, Math.trunc(max_lines * head_ratio));
  const tail_keep = Math.max(1, max_lines - head_keep);
  const elided = lines.length - head_keep - tail_keep;
  return [
    ...lines.slice(0, head_keep),
    marker_fmt.replace("{n}", String(elided)),
    ...lines.slice(lines.length - tail_keep),
  ];
}

// Patterns that signal an error or failure line worth preserving.
// Python: re.compile(r"error:|Error:|ERROR|FAILED|failed|fatal:|Traceback
//   |exception:|Exception:|AssertionError|assert |panic:", re.IGNORECASE)
const _ERROR_SIGNAL_RE: RegExp =
  /error:|Error:|ERROR|FAILED|failed|fatal:|Traceback|exception:|Exception:|AssertionError|assert |panic:/i;

/** Python _ERROR_SIGNAL_RE.search(line) — boolean "contains error signal". */
function _searchErrorSignal(line: string): boolean {
  return _ERROR_SIGNAL_RE.test(line);
}

/**
 * Cap lines at max_lines, preserving error-signal lines from the middle.
 *
 * Unlike truncate_middle, this variant scans for lines that match error/failure
 * patterns before deciding what to keep. This prevents important failures buried
 * in the middle of long output from being silently elided.
 *
 * Algorithm: if no error-signal lines are found, fall back to truncate_middle.
 * Otherwise keep up to head_keep header lines, up to max_error_lines unique
 * error-signal lines (each with up to error_context lines of context), and up to
 * tail_keep summary lines, inserting "--- N lines omitted ---" markers between
 * non-contiguous sections.
 */
export function truncate_middle_smart(
  lines: string[],
  max_lines: number,
  opts?: {
    head_keep?: number;
    tail_keep?: number;
    error_context?: number;
    max_error_lines?: number;
    marker_fmt?: string;
  },
): string[] {
  const head_keep = opts?.head_keep ?? 10;
  const tail_keep = opts?.tail_keep ?? 10;
  const error_context = opts?.error_context ?? 2;
  const max_error_lines = opts?.max_error_lines ?? 10;
  const marker_fmt = opts?.marker_fmt ?? "--- {n} lines omitted ---";

  if (lines.length <= max_lines) {
    return lines;
  }

  // Find error-signal line indices.
  const error_indices: number[] = [];
  for (let idx = 0; idx < lines.length; idx += 1) {
    if (_searchErrorSignal(lines[idx]!)) {
      error_indices.push(idx);
    }
  }
  if (error_indices.length === 0) {
    // No error signals — use simple head+tail.
    return truncate_middle(lines, max_lines, { marker_fmt });
  }

  const total = lines.length;

  // Clamp head/tail so they don't overlap when the output is only slightly over
  // budget.
  const eff_head = Math.min(head_keep, Math.trunc(total / 4));
  const eff_tail = Math.min(tail_keep, Math.trunc(total / 4));

  // Build the set of indices to include from the middle (error + context).
  const middle_indices = new Set<number>();
  for (let kept_error_count = 0; kept_error_count < error_indices.length; kept_error_count += 1) {
    if (kept_error_count >= max_error_lines) {
      break;
    }
    const ei = error_indices[kept_error_count]!;
    for (let ci = Math.max(0, ei - error_context); ci < Math.min(total, ei + error_context + 1); ci += 1) {
      middle_indices.add(ci);
    }
  }

  // Remove indices already covered by head/tail to avoid duplication.
  for (let h = 0; h < eff_head; h += 1) {
    middle_indices.delete(h);
  }
  for (let t = total - eff_tail; t < total; t += 1) {
    middle_indices.delete(t);
  }

  // Sort and trim middle indices to stay within the line budget.
  const budget_for_middle = Math.max(0, max_lines - eff_head - eff_tail);
  let sorted_middle = [...middle_indices].sort((a, b) => a - b);
  if (sorted_middle.length > budget_for_middle) {
    sorted_middle = sorted_middle.slice(0, budget_for_middle);
  }

  // Build output as sections, inserting omission markers between gaps.
  const result: string[] = [];

  const _append_section = (indices: number[]): void => {
    for (let pos = 0; pos < indices.length; pos += 1) {
      const idx = indices[pos]!;
      if (pos === 0) {
        result.push(lines[idx]!);
        continue;
      }
      const prev_idx = indices[pos - 1]!;
      if (idx !== prev_idx + 1) {
        const gap = idx - prev_idx - 1;
        result.push(marker_fmt.replace("{n}", String(gap)));
      }
      result.push(lines[idx]!);
    }
  };

  const head_list: number[] = [];
  for (let h = 0; h < eff_head; h += 1) {
    head_list.push(h);
  }
  const tail_list: number[] = [];
  for (let t = total - eff_tail; t < total; t += 1) {
    tail_list.push(t);
  }

  _append_section(head_list);

  if (sorted_middle.length > 0) {
    const gap_after_head =
      sorted_middle[0]! - (head_list.length > 0 ? head_list[head_list.length - 1]! : -1) - 1;
    if (gap_after_head > 0) {
      result.push(marker_fmt.replace("{n}", String(gap_after_head)));
    }
    _append_section(sorted_middle);
  }

  if (tail_list.length > 0) {
    const last_kept =
      sorted_middle.length > 0
        ? sorted_middle[sorted_middle.length - 1]!
        : head_list.length > 0
          ? head_list[head_list.length - 1]!
          : -1;
    const gap_before_tail = tail_list[0]! - last_kept - 1;
    if (gap_before_tail > 0) {
      result.push(marker_fmt.replace("{n}", String(gap_before_tail)));
    }
    _append_section(tail_list);
  }

  return result;
}

/**
 * Truncate text to max_bytes UTF-8 bytes, preserving line boundaries.
 *
 * Avoids splitting a multibyte UTF-8 character or the middle of a line: cuts at
 * the last newline before the budget when one exists, otherwise at the last
 * well-formed UTF-8 code point. A truncation marker is appended.
 *
 * Byte-exact port: Python encodes to UTF-8 bytes, slices the byte array, then
 * decodes with errors="replace". The TS port does the same via Buffer; slicing a
 * Buffer mid-codepoint and toString("utf8") substitutes U+FFFD for the trailing
 * partial sequence, matching decode(errors="replace").
 */
export function cap_bytes(text: string, max_bytes: number): string {
  const encoded = Buffer.from(text, "utf8");
  if (encoded.length <= max_bytes) {
    return text;
  }
  // Reserve room for the marker so the final size stays under the cap.
  const marker = `\n... [${encoded.length - max_bytes} bytes elided by token-goat]`;
  const marker_bytes = Buffer.byteLength(marker, "utf8");
  const budget = max_bytes - marker_bytes;
  if (budget <= 0) {
    return marker.trim();
  }
  let truncated = encoded.subarray(0, budget);
  // Walk back to the last newline so we don't slice mid-line, falling back to
  // the original cut if no newline exists in budget.
  const nl = truncated.lastIndexOf(0x0a); // b"\n"
  if (nl > Math.trunc(budget / 2)) {
    truncated = truncated.subarray(0, nl);
  }
  return truncated.toString("utf8") + marker;
}

/**
 * Convert a byte count to an approximate token count.
 *
 * Uses a conservative estimate of 3.5 characters per token, rounding up. This
 * aligns byte limits with actual model context usage. Python: max(1,
 * math.ceil(n / 3.5)).
 */
export function bytes_to_tokens(n: number): number {
  return Math.max(1, Math.ceil(n / 3.5));
}

/**
 * Truncate text to approximately max_tokens tokens.
 *
 * Estimates token count as len(text) / 3.5 and uses truncate via cap_bytes for
 * line-aware truncation when over budget. A truncation marker is appended.
 *
 * Token measurement strips ANSI codes before counting so that ANSI-heavy output
 * doesn't falsely trigger the token cap earlier than it should. The byte budget
 * (int(max_tokens * 3.5)) is consumed entirely by readable content.
 */
export function cap_tokens(text: string, max_tokens: number): string {
  // Strip ANSI codes before measuring token count.
  const clean_text = strip_ansi(text);
  const estimated_tokens = clean_text.length / 3.5;
  if (estimated_tokens <= max_tokens) {
    return text;
  }
  // Convert max_tokens back to bytes for truncation (conservative: 3.5 chars/token).
  const max_bytes = Math.trunc(max_tokens * 3.5);
  let truncated = cap_bytes(clean_text, max_bytes);
  // Replace the byte-based marker with a token-based one.
  if (!truncated.includes("[token-goat: output capped at")) {
    truncated = truncated.replace(_BYTES_ELIDED_MARKER_RE, "");
    truncated += `\n[token-goat: output capped at ~${max_tokens} tokens]`;
  }
  return truncated;
}

/**
 * Split text into blocks demarcated by lines matching block_re.
 *
 * Each returned block begins at a line matching block_re (the match is the first
 * line of the block) and extends through the line before the next match. Leading
 * content before the first match is returned as the first block (may be empty).
 */
export function split_blocks(text: string, block_re: RegExp): string[] {
  const lines = text.split("\n");
  const blocks: string[] = [];
  let current: string[] = [];
  const re = _nonGlobal(block_re);
  for (const line of lines) {
    if (_reMatch(re, line)) {
      if (current.length > 0) {
        blocks.push(current.join("\n"));
      }
      current = [line];
    } else {
      current.push(line);
    }
  }
  if (current.length > 0) {
    blocks.push(current.join("\n"));
  }
  return blocks;
}

/**
 * Python re.Pattern.match(line) — anchored at the START of the string (NOT
 * end-anchored). JS has no anchored-match primitive; emulate by checking the
 * match index is 0.
 */
function _reMatch(re: RegExp, line: string): boolean {
  const r = _nonGlobal(re);
  const m = r.exec(line);
  return m !== null && m.index === 0;
}

/**
 * Run the universal pre-filter pipeline: progress + ANSI + control chars + line
 * endings.
 *
 * Every filter should call this on its raw input before per-tool logic; it
 * removes the noise that obscures structural patterns. Idempotent.
 *
 * @param skip_progress When true, skip the strip_progress step that collapses
 *   \r-overwrite progress lines. Used for the "minimal" compression profile.
 */
export function normalise(text: string, opts?: { skip_progress?: boolean }): string {
  const skip_progress = opts?.skip_progress ?? false;
  if (!text) {
    return "";
  }
  // CRLF -> LF before progress collapsing so the rsplit('\r', ...) doesn't
  // spuriously eat the line-feed half of a Windows line ending.
  let out = text.replace(/\r\n/g, "\n");
  if (!skip_progress) {
    out = strip_progress(out);
  }
  out = strip_ansi(out);
  out = sanitize_control_chars(out);
  return out;
}

/**
 * Return head lines + marker + tail lines when lines.length > head + tail.
 *
 * If lines.length <= head + tail, returns the lines joined unchanged. The marker
 * reads: "... [N more <label> elided by token-goat]".
 */
export function _head_tail_compress(
  lines: string[],
  head: number,
  tail: number,
  label = "items",
): string {
  const total = lines.length;
  if (total <= head + tail) {
    return lines.join("\n");
  }
  const elided = total - head - tail;
  const head_lines = lines.slice(0, head);
  const tail_lines = lines.slice(total - tail);
  const result = [
    ...head_lines,
    `... [${elided} more ${label} elided by token-goat]`,
    ...tail_lines,
  ];
  return result.join("\n");
}

/**
 * Return text unchanged if it contains <= threshold non-empty lines.
 *
 * Used by filters that skip expensive processing when input is already short.
 * Returns the text if short (no processing needed), or null to signal the caller
 * to proceed with detailed compression logic.
 */
export function _pass_if_short(text: string, threshold = 30): string | null {
  const non_empty = text.split("\n").filter((ln) => ln.trim() !== "");
  if (non_empty.length <= threshold) {
    return text;
  }
  return null;
}

/**
 * Append msg to notes when value is truthy (non-zero, non-empty, non-null).
 *
 * Reduces the ubiquitous `if n: notes.append(msg)` two-liner to a single call.
 * Accepts int counts as well as str|null regex capture groups. Mirrors Python's
 * truthiness: 0, "", null, and undefined are falsy; everything else is truthy.
 */
export function _maybe_note(notes: string[], value: number | string | null | undefined, msg: string): void {
  if (value) {
    notes.push(msg);
  }
}

/**
 * Return combined output when exit_code != 0 and stderr is non-empty.
 *
 * Centralises the pattern: when a command fails (non-zero exit code) and
 * produces stderr, preserve both stdout and stderr with a separator. Returns
 * null when no error condition is detected, signalling the caller to continue
 * with normal (non-error) compression logic.
 */
export function _preserve_stderr_on_error(
  stdout: string,
  stderr: string,
  exit_code: number,
): string | null {
  if (exit_code !== 0 && stderr.trim() !== "") {
    return stdout.trim() !== "" ? `${_rstrip(stdout)}\n---\n${_rstrip(stderr)}` : stderr;
  }
  return null;
}

/** Python str.rstrip() — strip trailing ASCII+Unicode whitespace. */
function _rstrip(s: string): string {
  return s.replace(/\s+$/u, "");
}

// ===========================================================================
// Shared filter helpers — DRY utilities used by multiple Filter subclasses
// ===========================================================================

// Consolidated timestamp regex covering all common CI/log formats:
//   2024-01-01T00:00:00Z, 2024-01-01 00:00:00, [2024-01-01T00:00:00.123Z],
//   HH:MM:SS prefix.
// Python: re.compile(r"^\[?\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:\.\d+)?Z?\]?\s*"
//                     r"|^\d{2}:\d{2}:\d{2}(?:\.\d+)?\s+")
const _TIMESTAMP_PREFIX_RE: RegExp =
  /^\[?\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:\.\d+)?Z?\]?\s*|^\d{2}:\d{2}:\d{2}(?:\.\d+)?\s+/;

/**
 * Strip common ISO-8601 / datetime / HH:MM:SS timestamp prefixes from each line.
 *
 * Covers the timestamp formats used by gh run view --log, generic CI pipelines,
 * kubectl logs, and any tool that prepends date/time to lines. Lines without a
 * recognised prefix are returned unchanged. A new list is always returned.
 */
export function _strip_timestamps(lines: string[]): string[] {
  // The Python regex is not global; .sub replaces all non-overlapping matches,
  // but the pattern is start-anchored (^) and not multiline, so at most one
  // match per line. Use a non-global clone and a single replace.
  return lines.map((ln) => ln.replace(_TIMESTAMP_PREFIX_RE, ""));
}

/**
 * Replace lines with a single `[token-goat: collapsed N <label> lines]` marker.
 *
 * When keep_last > 0, the last keep_last lines from lines are appended verbatim
 * after the marker. Returns lines unchanged when it is empty, so callers can
 * always call this unconditionally.
 */
export function _collapse_to_count(
  lines: string[],
  label: string,
  opts?: { keep_last?: number },
): string[] {
  const keep_last = opts?.keep_last ?? 0;
  const n = lines.length;
  if (n === 0) {
    return lines;
  }
  const marker = `[token-goat: collapsed ${n} ${label} line${n !== 1 ? "s" : ""}]`;
  if (keep_last > 0 && keep_last < n) {
    return [marker, ...lines.slice(n - keep_last)];
  }
  return [marker];
}

/**
 * Keep only the first max_per_key occurrences of each unique key in lines.
 *
 * Deduplicates a sequence of lines by bucketing on a key derived from each line.
 * The first max_per_key lines for a given key are kept verbatim; additional
 * occurrences are silently dropped (counted so the caller can emit a note).
 *
 * @param key_fn Optional callable returning the deduplication key for a line.
 *   When undefined, the entire stripped line is used as the key (equivalent to
 *   Python's str.strip default).
 * @returns A [kept_lines, dropped_count] tuple.
 */
export function _dedup_lines(
  lines: string[],
  max_per_key = 1,
  opts?: { key_fn?: ((line: string) => string) | undefined },
): [string[], number] {
  const key_fn = opts?.key_fn ?? ((ln: string): string => ln.trim());
  const seen = new Map<string, number>();
  const out: string[] = [];
  let dropped = 0;
  for (const line of lines) {
    const key = key_fn(line);
    const count = seen.get(key) ?? 0;
    seen.set(key, count + 1);
    if (count < max_per_key) {
      out.push(line);
    } else {
      dropped += 1;
    }
  }
  return [out, dropped];
}

/**
 * Partition lines into error lines and other lines.
 *
 * A line is classified as an error when any pattern produces a match via
 * pattern.search(line). When error_patterns is undefined, the default set is
 * used (the single _ERROR_SIGNAL_RE). Returns [error_lines, other_lines]
 * preserving original order within each partition.
 */
export function _keep_errors_verbatim(
  lines: string[],
  error_patterns?: RegExp[] | undefined,
): [string[], string[]] {
  const patterns = error_patterns ?? [_ERROR_SIGNAL_RE];
  const compiled = patterns.map((p) => _nonGlobal(p));
  const error_lines: string[] = [];
  const other_lines: string[] = [];
  for (const line of lines) {
    if (compiled.some((pat) => pat.test(line))) {
      error_lines.push(line);
    } else {
      other_lines.push(line);
    }
  }
  return [error_lines, other_lines];
}

// ===========================================================================
// git CRLF-warning stripping (framework-level: Filter.apply calls this when
// self.name.startswith("git")). The git filters themselves are out of scope.
// ===========================================================================

// Python: re.compile(r"^warning: in the working copy of '.*', "
//   r"(?:LF will be replaced by CRLF|CRLF will be replaced by LF) "
//   r"the next time Git touches it\.?\r?$", re.MULTILINE)
// MULTILINE matters only because _strip_git_crlf_warnings calls .match() on each
// already-split line; we apply it per-line via _reMatch, so the "m" flag's $
// behaviour is irrelevant (no embedded newline in a single split line). The
// optional trailing \r is preserved.
const _GIT_CRLF_MODERN_RE: RegExp =
  /^warning: in the working copy of '.*', (?:LF will be replaced by CRLF|CRLF will be replaced by LF) the next time Git touches it\.?\r?$/;
// Python: re.compile(r"^warning: (?:LF will be replaced by CRLF|CRLF will be replaced by LF) in .*\.?\r?$")
const _GIT_CRLF_WARNING_RE: RegExp =
  /^warning: (?:LF will be replaced by CRLF|CRLF will be replaced by LF) in .*\.?\r?$/;
// Python: re.compile(r"^The file will have its original line endings in your working directory\.?\r?$")
const _GIT_CRLF_CONTINUATION_RE: RegExp =
  /^The file will have its original line endings in your working directory\.?\r?$/;

/**
 * Drop git's LF/CRLF line-ending normalisation warnings from text.
 *
 * Handles both formats git can emit. The modern (git 2.37+) format is a single
 * self-contained line, removed outright. The legacy (pre-2.37) format is the
 * two-line warning+continuation pair, removed as a unit so no orphan continuation
 * line survives. A bare continuation line with no preceding warning header is
 * also dropped defensively. Returns [cleaned_text, suppressed_count]; when
 * nothing matches the original string is returned unchanged so non-git callers
 * pay no cost.
 */
export function _strip_git_crlf_warnings(text: string): [string, number] {
  if (
    !text.includes("will be replaced by") &&
    !text.includes("original line endings") &&
    !text.includes("next time Git touches it")
  ) {
    return [text, 0];
  }
  const lines = text.split("\n");
  const out: string[] = [];
  let suppressed = 0;
  let i = 0;
  const n = lines.length;
  while (i < n) {
    const line = lines[i]!;
    if (_reMatch(_GIT_CRLF_MODERN_RE, line)) {
      // Modern git 2.37+: self-contained single line, no continuation.
      i += 1;
      suppressed += 1;
      continue;
    }
    if (_reMatch(_GIT_CRLF_WARNING_RE, line)) {
      // Legacy git <2.37: header plus its continuation line (if present).
      if (i + 1 < n && _reMatch(_GIT_CRLF_CONTINUATION_RE, lines[i + 1]!)) {
        i += 2;
      } else {
        i += 1;
      }
      suppressed += 1;
      continue;
    }
    if (_reMatch(_GIT_CRLF_CONTINUATION_RE, line)) {
      // Orphan continuation: drop it without counting a separate pair.
      i += 1;
      continue;
    }
    out.push(line);
    i += 1;
  }
  return [out.join("\n"), suppressed];
}

/**
 * True for added content lines (starting with "+"), excluding lines that start
 * with "+++". The +++ exclusion covers the file-header (+++ b/filename) but also
 * any added content that itself starts with "++".
 */
export function _is_diff_add(line: string): boolean {
  return line.startsWith("+") && !line.startsWith("+++");
}

/**
 * True for removed content lines (starting with "-"), excluding lines that start
 * with "---". The --- exclusion covers the file-header (--- a/filename) but also
 * any removed content whose source text starts with "--".
 */
export function _is_diff_remove(line: string): boolean {
  return line.startsWith("-") && !line.startsWith("---");
}

/**
 * Collapse 3+ consecutive blank lines to a single blank line.
 *
 * Many filters drop selected lines, leaving runs of empties that bloat output.
 * Applied at the end of each filter's compress. Python:
 * re.sub(r"\n\s*\n\s*\n+", "\n\n", text).
 */
export function _squeeze_blank_lines(text: string): string {
  return text.replace(/\n\s*\n\s*\n+/g, "\n\n");
}

// ===========================================================================
// Public dataclass
// ===========================================================================

/**
 * Result of running a Filter over a captured command output.
 *
 * Python's @dataclass -> a class with a constructor. The @property accessors
 * (bytes_saved / tokens_saved / percent_saved) -> getters; with_marker() -> a
 * method. notes defaults to [] (Python field(default_factory=list)).
 */
export class CompressedOutput {
  /**
   * The compressed output ready to be written to the wrapper's stdout. Always
   * ends without a trailing newline (the wrapper adds one).
   */
  text: string;
  /** Total bytes of stdout + stderr before compression (post-decoding, pre-filter). */
  original_bytes: number;
  /** len(text.encode("utf-8")). Stored explicitly so stats don't re-encode. */
  compressed_bytes: number;
  /** Filter.name of the filter that produced this output ("raw" when none applied). */
  filter_name: string;
  /** Exit code of the wrapped subprocess. */
  exit_code: number;
  /** Optional diagnostic lines produced during compression. */
  notes: string[];

  constructor(args: {
    text: string;
    original_bytes: number;
    compressed_bytes: number;
    filter_name: string;
    exit_code?: number;
    notes?: string[];
  }) {
    this.text = args.text;
    this.original_bytes = args.original_bytes;
    this.compressed_bytes = args.compressed_bytes;
    this.filter_name = args.filter_name;
    this.exit_code = args.exit_code ?? 0;
    this.notes = args.notes ?? [];
  }

  /** Non-negative byte savings (original - compressed clamped at 0). */
  get bytes_saved(): number {
    return Math.max(0, this.original_bytes - this.compressed_bytes);
  }

  /**
   * Estimated token savings. Uses max(1, bytes // 3 + 1) — the same formula as
   * compact.estimate_tokens. Returns 0 when bytes_saved is 0.
   */
  get tokens_saved(): number {
    const n = this.bytes_saved;
    if (n <= 0) {
      return 0;
    }
    return Math.max(1, Math.floor(n / 3) + 1);
  }

  /** Reduction as a percentage of the original size (0.0 when no input). */
  get percent_saved(): number {
    if (this.original_bytes <= 0) {
      return 0.0;
    }
    return (100.0 * this.bytes_saved) / this.original_bytes;
  }

  /**
   * Return text with the trailing compression-summary marker appended.
   *
   * The marker tells the reader exactly how much was elided and how to opt out.
   * Skipped entirely when the compression was a no-op (savings <= 0) so we never
   * confuse the model with a marker on raw output.
   */
  with_marker(): string {
    if (this.bytes_saved <= 0 || this.original_bytes <= 0) {
      return this.text;
    }
    const marker = _formatCompressionMarker(this.filter_name, this.percent_saved);
    return this.text + marker;
  }
}

// ===========================================================================
// Filter base class
// ===========================================================================

/**
 * Abstract base class for per-tool output compressors.
 *
 * Defines the minimal interface that all filter implementations must provide,
 * with helper methods for common compression patterns.
 *
 * Python's abc.ABC means BaseFilter() raises TypeError("Can't instantiate
 * abstract class ..."). In TS, `new BaseFilter()` is a compile error (abstract
 * class). A runtime guard in the constructor reproduces the THROW for any JS
 * caller that bypasses the type checker, with a message containing "abstract" so
 * the Python test (`pytest.raises(TypeError, match="abstract")`) ports
 * one-for-one when re-implemented against the TS surface.
 */
export abstract class BaseFilter {
  /**
   * Display name used in stats and the compression marker. Should be a short
   * identifier ([a-z-]+) without whitespace so it survives in log lines.
   */
  name = "base";

  /**
   * Set of accepted binary stems (lower-case, no extension). "pytest" matches
   * both /usr/bin/pytest and pytest.exe.
   */
  binaries: ReadonlySet<string> = new Set<string>();

  /**
   * When non-empty, only fire when one of these tokens appears as a positional
   * argument after the binary. Empty means "match any subcommand".
   */
  subcommands: ReadonlySet<string> = new Set<string>();

  constructor() {
    // abc.ABC parity: instantiating the abstract base directly is forbidden.
    // new.target is the concrete class being constructed; if it IS BaseFilter
    // the caller tried `new BaseFilter()` directly. (Subclasses pass a different
    // new.target, so they construct fine.)
    if (new.target === BaseFilter) {
      throw new TypeError("Can't instantiate abstract class BaseFilter");
    }
  }

  /**
   * Return true if this filter can handle the given command string.
   *
   * Override in subclasses to implement filter-specific command detection. This
   * method should return false rather than throw; the can_handle wrapper provides
   * exception safety.
   */
  abstract detect_from_command(cmd: string): boolean;

  /**
   * Return the compressed body (no marker; no byte cap).
   *
   * Subclasses override this. stdout and stderr have already been run through
   * normalise() by apply(). argv is the parsed command tokens (after prefix
   * stripping). exit_code lets filters preserve failure context.
   */
  abstract compress(stdout: string, stderr: string, exit_code: number, argv: string[]): string;

  /**
   * Check if this filter can handle the command (fail-soft wrapper).
   *
   * Calls detect_from_command and catches all exceptions, returning false on
   * error. This ensures a broken filter never breaks command dispatch.
   */
  can_handle(cmd: string): boolean {
    try {
      return this.detect_from_command(cmd);
    } catch {
      // fail-soft is the contract
      return false;
    }
  }

  /**
   * Estimated compression ratio (0.0 to 1.0) for this filter.
   *
   * Computed by running compress on a sample of typical tool output. Returns 0.0
   * if the filter raises an exception or if no compression savings are achieved.
   * Clamped to [0.0, 1.0].
   */
  get savings_ratio(): number {
    try {
      const sample = "progress line\n".repeat(100) + "error: test\n".repeat(10);
      const compressed = this.compress(sample, "", 0, []);
      const orig_len = sample.length;
      if (orig_len === 0) {
        return 0.0;
      }
      const saved = 1.0 - compressed.length / orig_len;
      return Math.max(0.0, Math.min(1.0, saved));
    } catch {
      // fail-soft
      return 0.0;
    }
  }
}

/**
 * Per-tool output compressor.
 *
 * Subclasses declare which command binaries they accept via binaries (matched
 * against the resolved argv stem after prefix-stripping) and implement compress
 * to produce the compressed body. The base apply method handles ANSI / progress
 * normalisation, byte caps, and the trailing compression marker.
 *
 * Set error_passthrough to true on a subclass to make compress short-circuit to
 * the raw stderr output (combined with stdout) before calling _compress_body,
 * when the command exits with a non-zero code and stderr is non-empty.
 */
export class Filter extends BaseFilter {
  /**
   * When true, compress short-circuits to the raw stderr output (combined with
   * stdout) before invoking _compress_body, whenever the command exits non-zero
   * and stderr is non-empty. Defaults to false.
   *
   * Python's `error_passthrough: ClassVar[bool] = False` is a class attribute; a
   * TS instance field with the same default is observably identical for the
   * `this.error_passthrough` reads in compress().
   */
  error_passthrough = false;

  /**
   * Detect if this filter applies to the raw command string.
   *
   * Default implementation parses the command string to argv, then calls matches
   * on the result. Subclasses can override for custom logic.
   */
  override detect_from_command(cmd: string): boolean {
    try {
      // Strip out command prefixes and parse.
      if (!cmd || cmd.length > 65_536) {
        return false;
      }
      const resolved = _strip_prefixes(_shlexSplit(cmd));
      if (resolved.length === 0) {
        return false;
      }
      return this.matches(resolved);
    } catch {
      // fail-soft
      return false;
    }
  }

  /**
   * Return true when this filter should run for the given argv.
   *
   * Default implementation checks binaries against the lowercased stem of
   * argv[0] and, when subcommands is non-empty, looks for an exact match in the
   * first three positional arguments (skipping leading flags). Override for more
   * sophisticated dispatch.
   *
   * Matching strategy: Path(argv[0]).stem.lower() covers the common cases. As a
   * fallback the full lowercased filename is also checked so that dot-in-name
   * binaries like py.test are dispatched correctly.
   */
  matches(argv: string[]): boolean {
    if (argv.length === 0) {
      return false;
    }
    const normed = argv[0]!.replace(/\\/g, "/");
    const stem = _pathStem(normed).toLowerCase();
    const name = _pathName(normed).toLowerCase();
    if (!this.binaries.has(stem) && !this.binaries.has(name)) {
      return false;
    }
    if (this.subcommands.size === 0) {
      return true;
    }
    const positionals = _positional_args(argv.slice(1)).slice(0, 3);
    return positionals.some((tok) => this.subcommands.has(tok));
  }

  /**
   * Combine stdout and stderr with a separator when both are present.
   *
   * Returns stderr if stdout is empty; otherwise returns stdout + "\n---\n" +
   * stderr. This is the standard output combination pattern used by most filters.
   */
  _combine_output(stdout: string, stderr: string): string {
    if (stderr.trim() !== "" && stdout.trim() !== "") {
      return `${_rstrip(stdout)}\n---\n${_rstrip(stderr)}`;
    }
    return stdout.trim() !== "" ? _rstrip(stdout) : _rstrip(stderr);
  }

  /**
   * Append a `[token-goat: <joined notes>]` summary line to kept.
   *
   * Centralises the common pattern of building a list of "N <label>" fragments
   * during a line-walk and emitting them as a single bracketed marker at the end.
   * No-op when notes is empty. Joined with "; " so multi-fragment markers stay
   * legible.
   */
  static _emit_notes(kept: string[], notes: string[], opts?: { prefix?: string }): void {
    const prefix = opts?.prefix ?? "token-goat: ";
    if (notes.length > 0) {
      kept.push(`[${prefix}${notes.join("; ")}]`);
    }
  }

  /**
   * Join kept with newlines and squeeze runs of blank lines.
   *
   * The standard last step of any filter that builds a kept list during a
   * line-walk. Centralises the _squeeze_blank_lines("\n".join(kept)) idiom.
   */
  static _finalize(kept: string[]): string {
    const joined = kept.join("\n");
    return _squeeze_blank_lines(joined);
  }

  /**
   * Return the compressed body (no marker; no byte cap).
   *
   * Template method: when error_passthrough is true, returns the raw error
   * output immediately (via _preserve_stderr_on_error) before calling
   * _compress_body. Subclasses that need error-passthrough behaviour set
   * error_passthrough = true and override _compress_body instead of this method.
   *
   * Subclasses that handle errors structurally leave error_passthrough = false
   * (the default) and override this method directly.
   */
  override compress(stdout: string, stderr: string, exit_code: number, argv: string[]): string {
    if (this.error_passthrough) {
      const err = _preserve_stderr_on_error(stdout, stderr, exit_code);
      if (err !== null) {
        return err;
      }
    }
    return this._compress_body(stdout, stderr, exit_code, argv);
  }

  /**
   * Inner compression logic called after the error-passthrough guard.
   *
   * Override this (instead of compress) when the filter sets error_passthrough =
   * true. The default implementation is a passthrough that concatenates stdout
   * and stderr with a separator, useful when the only compression is the ANSI /
   * progress strip that apply already performed.
   */
  _compress_body(stdout: string, stderr: string, _exit_code: number, _argv: string[]): string {
    if (stderr && stdout) {
      return `${_rstrip(stdout)}\n---\n${_rstrip(stderr)}`;
    }
    return stdout ? stdout : stderr;
  }

  /**
   * Top-level entry: normalise -> compress -> cap -> wrap in CompressedOutput.
   *
   * Wraps compress with the universal pipeline that every filter needs (see the
   * 10-step contract in the Python docstring). Errors from compress are caught
   * and logged; the fallback is a truncated view of the raw normalised text so
   * the agent always sees something.
   */
  apply(
    stdout: string,
    stderr: string,
    exit_code: number,
    argv: string[],
    opts?: {
      max_lines?: number;
      max_bytes?: number;
      skip_progress?: boolean;
    },
  ): CompressedOutput {
    const max_lines = opts?.max_lines ?? DEFAULT_MAX_LINES;
    const max_bytes = opts?.max_bytes ?? DEFAULT_MAX_BYTES;
    const skip_progress = opts?.skip_progress ?? false;

    // Step 1: sanitise — strip null bytes, ensure well-formed Unicode.
    let stdoutS = _safe_decode(stdout);
    let stderrS = _safe_decode(stderr);

    // Step 2: pre-filter input cap. Truncate BEFORE normalisation so even the
    // normalisation pass stays O(capped_bytes). Per-stream cap; total budget is
    // 2x the per-stream limit.
    const max_input = _get_max_input_bytes();
    const notes: string[] = [];
    const stdout_bytes = Buffer.from(stdoutS, "utf8");
    const stderr_bytes = Buffer.from(stderrS, "utf8");
    if (stdout_bytes.length > max_input) {
      stdoutS = stdout_bytes.subarray(0, max_input).toString("utf8");
      notes.push(`input truncated at ${Math.trunc(max_input / 1024)}KB (TOKEN_GOAT_FILTER_MAX_BYTES)`);
    }
    if (stderr_bytes.length > max_input) {
      stderrS = stderr_bytes.subarray(0, max_input).toString("utf8");
      if (!notes.some((nn) => nn.includes("input truncated"))) {
        notes.push(`stderr truncated at ${Math.trunc(max_input / 1024)}KB (TOKEN_GOAT_FILTER_MAX_BYTES)`);
      }
    }

    // Use pre-truncation byte arrays so original_bytes reflects the true process
    // output size, not the post-truncation size.
    const original_bytes = stdout_bytes.length + stderr_bytes.length;

    // Step 4: early-return on empty input — avoids compress("","") which causes
    // "".split("\n") -> [""] off-by-one in some filters.
    if (stdoutS.trim() === "" && stderrS.trim() === "") {
      // Embed notes in text — CompressedOutput.notes is never read back by
      // callers so storing them only there silently drops them.
      const text = notes.length > 0 ? `[${notes.join("; ")}]\n` : "";
      return new CompressedOutput({
        text,
        original_bytes,
        compressed_bytes: _utf8Len(text),
        filter_name: this.name,
        exit_code,
        notes,
      });
    }

    let body: string;
    try {
      let norm_out = normalise(stdoutS, { skip_progress });
      let norm_err = normalise(stderrS, { skip_progress });
      // git filters only — drop LF/CRLF line-ending normalisation warnings.
      if (this.name.startsWith("git")) {
        [norm_out] = _strip_git_crlf_warnings(norm_out);
        [norm_err] = _strip_git_crlf_warnings(norm_err);
      }
      const norm_bytes = _utf8Len(norm_out) + _utf8Len(norm_err);

      // Early exit: if normalisation alone (ANSI + progress strip) achieved
      // >=40% reduction, skip expensive per-tool filter and use simple dedup.
      if (original_bytes > 0 && norm_bytes <= original_bytes * 0.6) {
        _LOG.debug(
          "filter %s: normalisation reduced %d -> %d bytes (%.0f%% saved); skipping expensive filter",
          this.name,
          original_bytes,
          norm_bytes,
          100 * (1 - norm_bytes / original_bytes),
        );
        let b = dedupe_consecutive(norm_out.split("\n")).join("\n");
        if (norm_err.trim() !== "") {
          b = _rstrip(b) + "\n---\n" + _rstrip(dedupe_consecutive(norm_err.split("\n")).join("\n"));
        }
        body = b;
        notes.push("early-exit: normalisation alone sufficient");
      } else if (norm_bytes > MAX_INSPECT_BYTES) {
        _LOG.debug(
          "filter %s: input exceeds inspect budget (%d KiB > %d KiB); falling back to truncation",
          this.name,
          Math.trunc(norm_bytes / 1024),
          Math.trunc(MAX_INSPECT_BYTES / 1024),
        );
        notes.push(
          `input exceeded inspect budget (${Math.trunc(MAX_INSPECT_BYTES / 1024)} KiB); fell back to truncation`,
        );
        body = _fallback_truncate(norm_out, norm_err, max_lines);
      } else {
        body = this.compress(norm_out, norm_err, exit_code, argv);
      }
    } catch (exc) {
      // fail-soft is the contract
      _LOG.error("filter %s raised; falling back to truncation", this.name, exc);
      const excName = exc instanceof Error ? exc.constructor.name : "Error";
      notes.push(`${this.name} filter raised ${excName}; truncated raw`);
      let fb_out = normalise(stdoutS, { skip_progress });
      let fb_err = normalise(stderrS, { skip_progress });
      if (this.name.startsWith("git")) {
        [fb_out] = _strip_git_crlf_warnings(fb_out);
        [fb_err] = _strip_git_crlf_warnings(fb_err);
      }
      body = _fallback_truncate(fb_out, fb_err, max_lines);
    }

    // Line cap — use smart truncation to preserve error-signal lines from the
    // middle of long output. Falls back to plain head+tail when no error signals.
    let lines = body.split("\n");
    if (lines.length > max_lines) {
      lines = truncate_middle_smart(lines, max_lines);
      body = lines.join("\n");
    }
    // Byte cap (backstop for pathological lines).
    body = cap_bytes(body, max_bytes);
    if (notes.length > 0) {
      body = `[${notes.join("; ")}]\n` + body;
    }
    const compressed_bytes = _utf8Len(body);
    return new CompressedOutput({
      text: body,
      original_bytes,
      compressed_bytes,
      filter_name: this.name,
      exit_code,
    });
  }
}

/**
 * Produce a head/tail-truncated dump when a filter cannot run normally.
 *
 * Used when input exceeds the inspect budget or when a filter raises. Combines
 * stdout + stderr (each separately truncated) and includes a clear --- separator
 * so the model can tell them apart.
 */
export function _fallback_truncate(stdout: string, stderr: string, max_lines: number): string {
  const out_lines = truncate_middle(stdout.split("\n"), Math.trunc(max_lines / 2));
  const err_lines = truncate_middle(stderr.split("\n"), Math.trunc(max_lines / 2));
  if (stderr) {
    return out_lines.join("\n") + "\n---\n" + err_lines.join("\n");
  }
  return out_lines.join("\n");
}

/**
 * Return positional arguments (skipping -x and --xyz flags).
 *
 * Naive but correct for the dispatch use-case: we only need to find the
 * subcommand which is always positional. Flag-value pairs like --config=foo are
 * treated as flags; standalone flag values (-c foo) leak foo into the positional
 * list, but that is benign because we only check the first few tokens.
 */
export function _positional_args(args: string[]): string[] {
  return args.filter((a) => !a.startsWith("-"));
}

// ===========================================================================
// Command prefix stripping (sudo, env, nice, ...)
// ===========================================================================

// Wrappers that change resource use but not the underlying command semantics.
// Their first non-flag argument is the real binary we want to dispatch on.
const _PASSTHROUGH_PREFIXES: ReadonlySet<string> = new Set([
  "sudo",
  "doas",
  "time",
  "nice",
  "ionice",
  "nohup",
  "exec",
  "env",
  "stdbuf",
  "unbuffer",
  "script",
]);

// Multi-token wrappers where the next two tokens form the real binary.
// `python -m pytest`, `uv run pytest`, `poetry run pytest`, `npx jest`,
// `pnpm exec eslint`, `yarn run lint`, `bundle exec rspec`.
const _TWO_TOKEN_PREFIXES: ReadonlyMap<string, ReadonlySet<string>> = new Map<string, ReadonlySet<string>>([
  ["python", new Set(["-m"])],
  ["python3", new Set(["-m"])],
  ["py", new Set(["-m"])],
  ["uv", new Set(["run", "tool"])],
  ["uvx", new Set()], // uvx <tool>, second token IS the binary
  ["poetry", new Set(["run"])],
  ["rye", new Set(["run"])],
  ["pdm", new Set(["run"])],
  ["pipenv", new Set(["run"])],
  ["npx", new Set()], // npx <tool>, second token IS the binary
  ["pnpm", new Set(["exec", "dlx"])],
  ["yarn", new Set(["exec", "dlx"])],
  ["bundle", new Set(["exec"])],
  ["tox", new Set(["-e"])],
  ["hatch", new Set(["run"])],
]);

/**
 * Strip pass-through wrappers and resolve multi-token launchers to the real
 * binary.
 *
 * Handles three classes of prefix:
 *  - Env assignments: `FOO=bar BAZ=qux cmd` -> drop tokens with "=".
 *  - Single-token wrappers: sudo, time, nice, env, stdbuf -> skip the wrapper
 *    and any of its short flags.
 *  - Two-token launchers: `python -m pytest`, `uv run pytest`, `npx jest` -> skip
 *    the launcher and (optionally) the dispatch keyword, treating the next token
 *    as the binary.
 *
 * Returns a new argv list. An empty list is returned when stripping consumes all
 * tokens.
 */
export function _strip_prefixes(argv: string[]): string[] {
  if (argv.length === 0) {
    return [];
  }
  let out = [...argv];
  // Strip leading env assignments (`FOO=bar BAZ=qux cmd ...`).
  while (out.length > 0 && out[0]!.includes("=") && !out[0]!.startsWith("-") && !out[0]!.includes("/")) {
    // Only treat KEY=value as an env assignment when KEY is a valid identifier.
    const head = out[0]!.split("=", 1)[0]!;
    const head0 = head.length > 0 ? head[0]! : "";
    if (
      head.length > 0 &&
      (_isAlpha(head0) || head0 === "_") &&
      [...head].every((c) => _isAlnum(c) || c === "_")
    ) {
      out.shift();
    } else {
      break;
    }
  }
  // Strip pass-through prefixes, including their short flags (`nice -n 10`).
  while (out.length > 0) {
    const stem = _pathStem(out[0]!).toLowerCase();
    if (!_PASSTHROUGH_PREFIXES.has(stem)) {
      break;
    }
    out.shift();
    // Skip the prefix's own flags so we land on the real binary in out[0].
    while (out.length > 0 && out[0]!.startsWith("-")) {
      const flag = out.shift()!;
      // Two-token flags need their value consumed too.
      if ((flag === "-n" || flag === "-c" || flag === "-i" || flag === "-u" || flag === "-e") && out.length > 0) {
        out.shift();
      }
    }
  }
  if (out.length === 0) {
    return out;
  }
  // Resolve two-token launchers. `python -m pytest` -> `pytest`.
  const stem = _pathStem(out[0]!).toLowerCase();
  const triggers = _TWO_TOKEN_PREFIXES.get(stem);
  if (triggers !== undefined && out.length >= 2) {
    const next_tok = out[1]!;
    if (triggers.size === 0 || triggers.has(next_tok)) {
      // Skip the launcher and (when present) the dispatch keyword.
      const consume = triggers.size === 0 ? 1 : 2;
      if (out.length > consume) {
        out = out.slice(consume);
      }
    }
  }
  return out;
}

/** Python str.isalpha() for a single ASCII-or-Unicode-letter char (used for env-key heads). */
function _isAlpha(c: string): boolean {
  return /\p{L}/u.test(c);
}

/** Python str.isalnum() for a single char (letter or digit). */
function _isAlnum(c: string): boolean {
  return /[\p{L}\p{N}]/u.test(c);
}

// ===========================================================================
// Foundational filters: GenericFilter + PythonFilter (catch-all fallbacks).
// The ~150 tool-specific filters land in later runs as separate modules.
// ===========================================================================

/**
 * Fallback filter: ANSI strip + progress strip + consecutive dedupe.
 *
 * Used when no per-tool filter matches but the hook layer has decided to wrap a
 * command. Cannot rely on tool-specific structure, so it just removes the
 * universal noise sources.
 */
export class GenericFilter extends Filter {
  override name = "generic";

  override compress(stdout: string, stderr: string, _exit_code: number, _argv: string[]): string {
    const out_lines = dedupe_consecutive(stdout.split("\n"), { entropy_bypass: true });
    const err_lines = dedupe_consecutive(stderr.split("\n"), { entropy_bypass: true });
    let result: string;
    if (stderr.trim() !== "") {
      result = _rstrip(out_lines.join("\n")) + "\n---\n" + _rstrip(err_lines.join("\n"));
    } else {
      result = out_lines.join("\n");
    }
    // Cap token-aware output to ~2000 tokens (~7KB).
    return cap_tokens(result, 2000);
  }
}

// --- Python filter regexes -------------------------------------------------

// Python traceback frame line: '  File "path", line N, in func'
// Python: re.compile(r'^\s+File\s+"[^"]+",\s+line\s+\d+(?:,\s+in\s+.*)?\s*$')
const _PYTHON_FRAME_RE: RegExp = /^\s+File\s+"[^"]+",\s+line\s+\d+(?:,\s+in\s+.*)?\s*$/;
// Python error/exception terminator: "ErrorType: message"
// Python: re.compile(r"^[A-Za-z][A-Za-z0-9_]*(?:Error|Exception|Warning):\s")
const _PYTHON_ERROR_RE: RegExp = /^[A-Za-z][A-Za-z0-9_]*(?:Error|Exception|Warning):\s/;
// Python warning lines. Python: re.compile(r"^\s*.*Warning:\s")
const _PYTHON_WARNING_RE: RegExp = /^\s*.*Warning:\s/;

/**
 * Compress Python script output and tracebacks.
 *
 * When `python script.py`, `python -c "code"`, or `python -m module` produces a
 * traceback, the filter compresses it to preserve only the innermost frame (where
 * the actual error occurred) plus the error message. For very long tracebacks
 * (>10 frames), keeps only the first 2 and last 3 frames with a marker in between.
 *
 * Compression model: traceback compression (keep error line + immediate cause,
 * drop intermediate frame lines except innermost; >10-frame tracebacks keep first
 * 2 + last 3); repeated-line dedup (5+ consecutive -> "line × N"); warning spam
 * (Warning: repeating >3 -> keep first 3); progress bars (\r -> keep last).
 */
export class PythonFilter extends Filter {
  override name = "python";
  override binaries: ReadonlySet<string> = new Set([
    "python",
    "python3",
    "python3.11",
    "python3.12",
    "python3.13",
  ]);

  override matches(argv: string[]): boolean {
    if (argv.length === 0) {
      return false;
    }
    const stem = _pathStem(argv[0]!).toLowerCase();
    // Match python/python3 directly, but NOT pytest (handled by PytestFilter).
    if (!this.binaries.has(stem)) {
      return false;
    }
    // Don't match if this is actually pytest (python -m pytest or pytest).
    if (argv.length > 1) {
      const positionals = _positional_args(argv.slice(1));
      // Check for "-m pytest" or "-c" with pytest code.
      if (positionals.length > 0 && positionals[0] === "pytest") {
        return false;
      }
    }
    return true;
  }

  override compress(stdout: string, stderr: string, _exit_code: number, _argv: string[]): string {
    // Combine stderr (traceback) and stdout.
    let text = stderr.trim() !== "" ? stderr : stdout;
    if (text && stderr.trim() !== "" && stdout.trim() !== "") {
      text = _rstrip(text) + "\n" + _rstrip(stdout);
    }
    if (text.trim() === "") {
      return text;
    }

    let lines = text.split("\n");
    lines = this._compress_traceback(lines);
    lines = this._dedupe_repeated_lines(lines);
    lines = this._compress_warnings(lines);
    return _squeeze_blank_lines(lines.join("\n"));
  }

  /**
   * Compress Python tracebacks, keeping error and innermost frame.
   *
   * For very long tracebacks (>10 frames), keep first 2 and last 3 frames with an
   * omission marker.
   */
  _compress_traceback(lines: string[]): string[] {
    // Find "Traceback" header and "Error:" terminator.
    let traceback_start: number | null = null;
    let error_line_idx: number | null = null;

    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i]!;
      if (line.startsWith("Traceback")) {
        traceback_start = i;
      }
      if (_PYTHON_ERROR_RE.test(line)) {
        error_line_idx = i;
      }
    }

    // No traceback found; pass through.
    if (traceback_start === null) {
      return lines;
    }

    // If no error found, the traceback is incomplete (or it's a warning).
    if (error_line_idx === null || error_line_idx <= traceback_start) {
      return lines;
    }

    // Extract frame lines (those matching _PYTHON_FRAME_RE) between Traceback and
    // error line.
    const frame_indices: number[] = [];
    for (let i = traceback_start; i < error_line_idx; i += 1) {
      if (_PYTHON_FRAME_RE.test(lines[i]!)) {
        frame_indices.push(i);
      }
    }

    // If there are too many frames (>10), keep first 2 and last 3 with marker.
    if (frame_indices.length > 10) {
      const kept_indices = new Set<number>([
        ...frame_indices.slice(0, 2),
        ...frame_indices.slice(-3),
      ]);
      const omitted = frame_indices.length - 5;
      const result: string[] = [];
      for (let i = 0; i < lines.length; i += 1) {
        const line = lines[i]!;
        if (
          i < traceback_start ||
          i > error_line_idx ||
          kept_indices.has(i) ||
          i === traceback_start ||
          i === error_line_idx
        ) {
          result.push(line);
        } else if (i === frame_indices[2]!) {
          // Insert omission marker at the first dropped frame.
          result.push(`  ... ${omitted} frames omitted ...`);
        }
      }
      return result;
    }

    // Standard case: keep traceback header, innermost frame(s), and error.
    const innermost = frame_indices.length > 0 ? frame_indices[frame_indices.length - 1]! : -1;
    const result: string[] = [];
    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i]!;
      if (i < traceback_start || i > error_line_idx) {
        // Before traceback or after error: pass through.
        result.push(line);
      } else if (i === traceback_start) {
        // Keep traceback header.
        result.push(line);
      } else if (i === innermost) {
        // Keep only the innermost frame (last frame before error).
        result.push(line);
      } else if (i === error_line_idx) {
        // Always keep the error line.
        result.push(line);
      } else if (i === error_line_idx - 1 && !_PYTHON_FRAME_RE.test(line)) {
        // Keep the line immediately before the error if it's not a frame.
        result.push(line);
      }
    }
    return result;
  }

  /** Collapse 5+ consecutive identical lines to 'line × N'. */
  _dedupe_repeated_lines(lines: string[]): string[] {
    const out: string[] = [];
    let prev: string | null = null;
    let count = 0;
    for (const line of lines) {
      if (line === prev) {
        count += 1;
      } else {
        if (prev !== null && count >= 5) {
          out.push(`${prev}  (×${count})`);
        } else if (prev !== null) {
          for (let k = 0; k < count; k += 1) {
            out.push(prev);
          }
        }
        prev = line;
        count = 1;
      }
    }
    if (prev !== null) {
      if (count >= 5) {
        out.push(`${prev}  (×${count})`);
      } else {
        for (let k = 0; k < count; k += 1) {
          out.push(prev);
        }
      }
    }
    return out;
  }

  /** Compress repeated warnings: keep first 3, summarize rest. */
  _compress_warnings(lines: string[]): string[] {
    const warning_groups = new Map<string, number[]>();

    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i]!;
      if (_PYTHON_WARNING_RE.test(line)) {
        // Normalize the warning message for grouping.
        const normalized = line.replace(/:\d+:/g, ":N:");
        const grp = warning_groups.get(normalized);
        if (grp === undefined) {
          warning_groups.set(normalized, [i]);
        } else {
          grp.push(i);
        }
      }
    }

    if (warning_groups.size === 0) {
      return lines;
    }

    // Keep first 3 of each normalized warning; drop the rest.
    const keep_indices = new Set<number>();
    for (const indices of warning_groups.values()) {
      for (const idx of indices.slice(0, 3)) {
        keep_indices.add(idx);
      }
    }

    const result: string[] = [];
    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i]!;
      if (keep_indices.has(i) || !_PYTHON_WARNING_RE.test(line)) {
        result.push(line);
      }
    }

    // Add summary for dropped warnings.
    let total_warnings = 0;
    for (const grp of warning_groups.values()) {
      total_warnings += grp.length;
    }
    const kept_warnings = keep_indices.size;
    if (total_warnings > kept_warnings) {
      result.push(`[token-goat: suppressed ${total_warnings - kept_warnings} additional warning(s)]`);
    }

    return result;
  }
}

// --- Tail-trunc catch-all filter ------------------------------------------

// Safety-net catch-all placed LAST in FILTERS so every more-specific filter
// wins the first-match race. Only activates when nothing else matched AND the
// combined output exceeds 500 lines; otherwise passes through verbatim.

/**
 * Safety-net catch-all: truncate unmatched outputs longer than 500 lines.
 *
 * Keeps the first 50 and last 50 lines with a suppressed-count marker in the
 * middle. Placed last in FILTERS so every more-specific filter wins; only
 * activates when nothing else matched and the output is very long. Outputs of
 * 500 lines or fewer pass through verbatim.
 *
 * Parity notes (Python -> TS):
 *  - name = "tail-trunc"; binaries = frozenset() -> empty ReadonlySet (matches()
 *    returns True unconditionally, so binaries is never consulted — kept empty
 *    for parity with the Python class attribute).
 *  - matches(argv) returns True unconditionally (catch-all last-resort).
 *  - compress() merges stdout+stderr via the inherited _combine_output instance
 *    method, then splits on "\n" (NOT splitlines(): bare-CR handling parity is
 *    the same as the rest of this file — split("\n") matches the Python source
 *    which also uses merged.split("\n")).
 *  - Marker string preserved VERBATIM including the U+2014 em-dash; built via
 *    a template literal so the ${suppressed} count is interpolated exactly as
 *    Python's f-string does.
 */
export class TailTruncFilter extends Filter {
  override name = "tail-trunc";
  override binaries: ReadonlySet<string> = new Set();

  override matches(_argv: string[]): boolean {
    return true; // catch-all: always claim as last-resort fallback
  }

  override compress(
    stdout: string,
    stderr: string,
    _exit_code: number,
    _argv: string[],
  ): string {
    const merged = this._combine_output(stdout, stderr);
    const lines = merged.split("\n");
    if (lines.length <= 500) {
      return merged;
    }
    const suppressed = lines.length - 100;
    const marker = `[... ${suppressed} lines suppressed — use TOKEN_GOAT_BASH_COMPRESS=0 to disable ...]`;
    return lines.slice(0, 50).concat([marker], lines.slice(-50)).join("\n");
  }
}

// ===========================================================================
// Forward-compat reset seam.
// ===========================================================================
// This framework owns no per-test-dirtied mutable module state today (the
// compiled regexes and the module logger are immutable for the process
// lifetime, exactly as render/ansi.ts has nothing to reset). registerReset is
// imported so a later run that adds a TTL cache HERE can wire it without
// re-touching the import block; the no-op registration below keeps the import
// live and documents the seam. A no-op reset is idempotent and harmless.
registerReset(() => {
  // Intentionally empty: no framework-global cache to clear yet. Later runs that
  // add module-level mutable state to this file should reset it here.
});
