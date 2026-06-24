/**
 * bash_compress TAIL FILTERS — TypeScript port of the EnvFilter /
 * JsonArrayFilter / BinaryInspectFilter / FileTypeFilter / PsFilter /
 * SeverityLogFilter subclasses from src/token_goat/bash_compress.py.
 *
 * Six filters subclass the concrete Filter base from ./framework.js:
 *   - EnvFilter           — `env` / `printenv` dumps. Passes through <= 20 vars;
 *                           keeps PATH / VIRTUAL_ENV / *_HOME / GITHUB_ / AWS_ /
 *                           TF_ sentinels and tooling-prefix vars verbatim,
 *                           suppresses the rest with a count summary.
 *   - JsonArrayFilter     — JSON-array output (`json`, `npm ls --json`,
 *                           `gh api`, `kubectl -o json`). Key-set dedup of dict
 *                           items (high-entropy-value objects preserved), then
 *                           truncate at 50 items. Content-based (matches() and
 *                           detect_from_command() both return false; routed by
 *                           the hook layer via detect()).
 *   - BinaryInspectFilter — `xxd` / `hexdump` / `od` / `hd`. Keeps first 2 hex
 *                           lines, identifies file type from magic bytes,
 *                           replaces the rest with a semantic summary line.
 *   - FileTypeFilter      — `file`. Pass-through wrapper; batch runs truncated
 *                           to 20 lines + a count.
 *   - PsFilter            — `ps` / `top` / `pstree` / `tasklist`. Keeps header,
 *                           dev-relevant + high-resource + user-owned processes,
 *                           drops kernel threads / system daemons / idle procs;
 *                           appends a `[suppressed N system processes]` sentinel.
 *   - SeverityLogFilter   — content-based severity-scored log compressor. Keeps
 *                           ERROR/WARN lines (>= score_threshold) plus
 *                           context_lines neighbours; collapses lower-severity
 *                           runs to `[suppressed N lines]`. Multi-line stack
 *                           traces opened by an ERROR/FAIL line preserved whole.
 *
 * ---------------------------------------------------------------------------
 * Parity notes (Python -> TS)
 * ---------------------------------------------------------------------------
 *  - Python identifiers preserved EXACTLY: PascalCase class names; snake_case
 *    methods/fields (matches, compress, detect, detect_from_command); snake_case
 *    module-private regex/constant names (_ENV_KEEP_VARS, _ENV_KEEP_PREFIXES,
 *    _ENV_PASSTHROUGH_THRESHOLD, _ENV_LINE_RE, _JSON_ARRAY_MAX_ITEMS,
 *    _BIN_INSPECT_PASSTHROUGH, _MAGIC_MAP, _HEX_DUMP_LINE_RE, _LOG_LEVEL_RE,
 *    _LOG_WARN_RE, _LOG_INFO_RE, _LOG_DEBUG_RE, _LOG_ANY_RE, _TRACE_CONTINUATION_RE,
 *    _PS_MIN_LINES, _PS_HEADER_KEYWORDS, _PS_TOP_PREFIXES, _PS_DEV_SUBSTRINGS);
 *    snake_case helper functions (_identify_hex_magic, _score_log_line,
 *    _compress_severity_log, _ps_keep_line).
 *  - re.compile(...) -> top-level RegExp compiled once at module load.
 *    re.IGNORECASE -> "i". Python re.Pattern.match(line) is START-anchored ->
 *    _reMatch (non-global clone + index===0). .search(line) -> _reSearch /
 *    _reSearchObj (non-global clone, .exec anywhere; capture groups read off the
 *    match). Named groups (?P<name>...) -> (?<name>...).
 *  - _ERROR_SIGNAL_RE is framework-PRIVATE (not exported by framework.ts). It is
 *    NOT re-declared here because none of the six filters in this module
 *    reference it (unlike utils.ts's DotenvFilter via _is_dotenv_banner); a dead
 *    module-private copy is omitted to keep the module clean. Should a future
 *    helper here need it, the verbatim source lives in framework.ts ~line 667
 *    (and in utils.ts as a private copy).
 *  - Python `splitlines()` -> `.split("\n")`. The streams are already ANSI- and
 *    CR-stripped by Filter.apply()'s normalise() before compress() runs, so
 *    `.split("\n")` matches Python `splitlines()` output on the already-cleaned
 *    text. (Mirrors the framework convention; see framework.ts ~line 2167.)
 *  - json.loads / json.dumps(indent=2) -> JSON.parse / JSON.stringify(.., null,
 *    2). A non-object / non-array top level or a parse error -> return text
 *    unchanged (Python catches ValueError/TypeError; JS catches SyntaxError and
 *    also guards non-plain-object top levels).
 *  - frozenset / tuple literals -> ReadonlySet / readonly tuple (typed
 *    `readonly [...]` / `ReadonlySet<string>`). `in` membership -> Set.has /
 *    Array.includes. str.startswith(pfx) -> str.startsWith(pfx); the Python
 *    `any(var_name.startswith(p) for p in PREFIXES)` becomes
 *    PREFIXES.some((p) => var_name.startsWith(p)).
 *  - Python `@staticmethod detect(stdout)` / `@classmethod detect(cls, stdout)`
 *    -> INSTANCE method `detect(stdout)` on the TS class. TS classes dispatch
 *    through instances (apply()/compress() run on an instance), so the
 *    static/classmethod distinction collapses; the call site
 *    `if (!this.detect(combined))` is observably identical. (Mirrors the
 *    TreeFilter.detect(lines) idiom in cli_utils_a.ts.)
 *  - os.getenv("USERNAME") or os.getenv("USER") -> process.env.USERNAME ??
 *    process.env.USER (both lowercased). Matches Python's short-circuit `or`.
 *  - has_high_entropy_token is imported from ../entropy.js (framework.ts imports
 *    but does NOT re-export it, so each module that needs it imports directly).
 *  - config: `import * as config from "../config.js"` then config.load() reads
 *    the cached ConfigSchema; cfg.bash_severity_log.context_lines and
 *    .score_threshold drive _compress_severity_log.
 *  - SeverityLogFilter.detect_from_command + matches BOTH return false
 *    (content-based only; the hook layer routes via the detect() instance
 *    method called from compress()).
 *  - Python `[...ks]` / `frozenset(item.keys())` -> [...Object.keys(obj)] as a
 *    sorted joined key-signature string; the dedup map is keyed on the sorted
 *    comma-joined key string (a stable stand-in for Python's frozenset hash).
 *  - Python `float(cols[cpu_col])` -> Number(cols[cpu_col]); a NaN result
 *    (non-numeric) fails the `> 5.0` comparison exactly as Python's ValueError
 *    branch (NaN > 5.0 is false in JS).
 *  - _combine_output is an INSTANCE method; _finalize / _emit_notes are STATIC
 *    methods on Filter.
 *  - Module-global mutable state: NONE. Every counter/list/set/map is a local
 *    inside compress()/helpers; no registerReset seam is needed.
 *
 * NOTE on import depth: this file lives in the bash_compress/ SUBDIR; the
 * framework is a SIBLING (./framework.js), entropy is UP one level (../entropy.js)
 * and config is UP one level (../config.js). verbatimModuleSyntax is on ->
 * nothing imported here is type-only. noImplicitOverride is on -> every
 * overridden member carries `override`.
 */

import { Filter } from "./framework.js";
import { hasHighEntropyToken as has_high_entropy_token } from "../entropy.js";
import * as config from "../config.js";

// ===========================================================================
// Internal Python-builtin shims local to this module.
// ===========================================================================

/** Python str.strip() — strip leading and trailing whitespace. */
function _strip(s: string): string {
  return s.replace(/^\s+/u, "").replace(/\s+$/u, "");
}

/** Python str.rstrip() — strip trailing whitespace. */
function _rstrip(s: string): string {
  return s.replace(/\s+$/u, "");
}

/** Return a clone of re without the global/sticky flags (one-shot .exec/.test). */
function _nonGlobal(re: RegExp): RegExp {
  const flags = re.flags.replace(/[gy]/g, "");
  return new RegExp(re.source, flags);
}

/**
 * Python re.Pattern.match(line) — anchored at the START (NOT end-anchored). JS
 * has no anchored-match primitive; emulate via a non-global clone and an
 * index===0 check.
 */
function _reMatch(re: RegExp, line: string): boolean {
  const r = _nonGlobal(re);
  const m = r.exec(line);
  return m !== null && m.index === 0;
}

/**
 * Python re.Pattern.match(line) returning the match object (or null), for the
 * callers that read capture groups. Non-global clone so lastIndex never leaks.
 */
function _reMatchObj(re: RegExp, line: string): RegExpExecArray | null {
  const m = _nonGlobal(re).exec(line);
  return m !== null && m.index === 0 ? m : null;
}

/** Python re.search(...) — boolean "matches anywhere". */
function _reSearch(re: RegExp, text: string): boolean {
  return _nonGlobal(re).test(text);
}

// ===========================================================================
// env / printenv (Python ~24649-24735)
//
// NOTE: _ERROR_SIGNAL_RE (framework-private) is intentionally NOT re-declared
// here — none of the six filters in this module reference it (unlike utils.ts's
// DotenvFilter via _is_dotenv_banner). Keeping an unused module-private copy
// would be dead weight; the parity block above documents its existence.
// ===========================================================================

/** Variables always kept verbatim regardless of count (Python _ENV_KEEP_VARS). */
const _ENV_KEEP_VARS: ReadonlySet<string> = new Set<string>([
  "PATH", "PYTHONPATH", "VIRTUAL_ENV", "CONDA_DEFAULT_ENV", "CONDA_PREFIX",
  "NODE_ENV", "NODE_VERSION", "NODE_PATH",
  "GOPATH", "GOROOT", "GOBIN",
  "JAVA_HOME", "JAVA_OPTS",
  "CARGO_HOME", "RUSTUP_HOME", "RUST_LOG",
  "GEM_HOME", "BUNDLE_PATH",
  "HOME", "USER", "USERNAME", "LOGNAME", "SHELL", "PWD", "OLDPWD",
  "TERM", "LANG", "LC_ALL", "TZ",
  "VIRTUAL_ENV_PROMPT",
  "npm_config_prefix", "npm_config_cache",
]);

/**
 * Prefixes: keep any var whose name starts with one of these
 * (Python _ENV_KEEP_PREFIXES).
 */
const _ENV_KEEP_PREFIXES: readonly string[] = [
  "CLAUDE_", "TOKEN_GOAT_", "CI_", "GITHUB_", "GITLAB_", "CIRCLECI_",
  "AWS_", "GCP_", "AZURE_", "GOOGLE_",
  "PYTHON", "UV_", "PIP_",
  "CONDA_", "NPM_", "PNPM_", "YARN_",
  "DOCKER_", "KUBECONFIG", "KUBE_",
  "TF_", "PULUMI_",
  "JAVA_", "MAVEN_", "GRADLE_",
  "CARGO_", "RUSTUP_", "RUST_",
];

/** Threshold: if total KEY=value lines is at or below this, pass through (Python). */
const _ENV_PASSTHROUGH_THRESHOLD = 20;

/** Python _ENV_LINE_RE: re.compile(r"^([A-Za-z_][A-Za-z_0-9]*)=(.*)$") */
const _ENV_LINE_RE: RegExp = /^([A-Za-z_][A-Za-z_0-9]*)=(.*)$/;

/**
 * Compress `env` / `printenv` environment-variable dumps.
 *
 * Passes through short dumps (<= _ENV_PASSTHROUGH_THRESHOLD vars). Keeps
 * important variables verbatim (PATH, VIRTUAL_ENV, NODE_ENV, GOPATH, JAVA_HOME,
 * and similar dev-environment sentinels), plus any variable whose name starts
 * with a recognised tooling prefix (GITHUB_, AWS_, TF_, etc.). Suppresses the
 * remaining variables and emits a count summary. Non-assignment lines (errors,
 * blank lines) are kept verbatim.
 */
export class EnvFilter extends Filter {
  override name = "env";
  override binaries: ReadonlySet<string> = new Set<string>(["env", "printenv"]);

  override compress(stdout: string, stderr: string, _exit_code: number, _argv: string[]): string {
    const merged = this._combine_output(stdout, stderr);
    const lines = merged.split("\n");

    // Count total KEY=value lines to decide whether to compress.
    let total_vars = 0;
    for (const ln of lines) {
      if (_reMatch(_ENV_LINE_RE, ln)) {
        total_vars += 1;
      }
    }
    if (total_vars <= _ENV_PASSTHROUGH_THRESHOLD) {
      return merged;
    }

    const kept: string[] = [];
    let suppressed = 0;

    for (const line of lines) {
      const m = _reMatchObj(_ENV_LINE_RE, line);
      if (!m) {
        // Non-assignment lines (errors, blank lines, etc.) — keep verbatim.
        kept.push(line);
        continue;
      }
      const var_name = m[1]!;
      if (
        _ENV_KEEP_VARS.has(var_name) ||
        _ENV_KEEP_PREFIXES.some((p) => var_name.startsWith(p))
      ) {
        kept.push(line);
      } else {
        suppressed += 1;
      }
    }

    if (suppressed) {
      kept.push(
        `[token-goat: ${suppressed} env vars suppressed ` +
          `(${total_vars} total) — run \`env | grep NAME\` to inspect]`,
      );
    }
    return Filter._finalize(kept);
  }
}

// ===========================================================================
// JSON array (Python ~24738-24819)
// ===========================================================================

/** Truncation cap for JSON-array items (Python _JSON_ARRAY_MAX_ITEMS). */
const _JSON_ARRAY_MAX_ITEMS = 50;

/**
 * Compress JSON array output (`npm ls --json`, `gh api`, `kubectl -o json`).
 *
 * Non-array / invalid JSON passes through unchanged. Objects sharing the same
 * frozenset of top-level keys are collapsed (all but the first dropped) with a
 * per-group `[... N duplicate objects with keys {k1, k2, ...} omitted]` line —
 * EXCEPT objects whose values contain a high-entropy token (UUIDs, hashes,
 * JWTs), which are always preserved. After dedup, arrays still exceeding
 * _JSON_ARRAY_MAX_ITEMS are truncated with a `[... N more items not shown]`
 * suffix. When nothing changed, the original text is returned byte-for-byte so
 * downstream callers can detect zero savings.
 *
 * Content-based: matches() and detect_from_command() both return false (the hook
 * layer routes JSON-array output via the detect() content probe, not binary
 * dispatch).
 */
export class JsonArrayFilter extends Filter {
  override name = "json_array";
  // "json" is the binary stem registered in bash_detect._BINARY_TO_FILTER;
  // content-based detection (stdout starts with '[') is the primary path.
  override binaries: ReadonlySet<string> = new Set<string>(["json"]);

  override matches(_argv: string[]): boolean {
    if (_argv.length === 0) {
      return false;
    }
    // Python: Path(argv[0]).stem.lower() in self.binaries
    const normed = _argv[0]!.replace(/\\/g, "/");
    const trimmed = normed.replace(/\/+$/, "");
    const slash = trimmed.lastIndexOf("/");
    const name = slash >= 0 ? trimmed.slice(slash + 1) : trimmed;
    const dot = name.lastIndexOf(".");
    const stem = (dot <= 0 || dot === name.length - 1 ? name : name.slice(0, dot)).toLowerCase();
    return this.binaries.has(stem);
  }

  override detect_from_command(_cmd: string): boolean {
    return false; // content-based only; the hook layer routes via detect()
  }

  override compress(stdout: string, stderr: string, _exit_code: number, _argv: string[]): string {
    const text = _strip(stdout) !== "" ? stdout : stdout + stderr;
    const stripped = _strip(text);
    if (!(stripped.startsWith("[") && stripped.endsWith("]"))) {
      return text;
    }
    let data: unknown;
    try {
      data = JSON.parse(stripped);
    } catch {
      return text; // JSONDecodeError -> pass through.
    }
    if (!Array.isArray(data)) {
      return text;
    }

    // --- key-set deduplication (dicts only) ------------------------------
    // Python keys the dup map on frozenset(item.keys()). JS has no frozenset
    // hash, so the key is the sorted comma-joined key string (stable stand-in).
    const seen = new Map<string, number>(); // key-sig -> first-index in kept
    const kept: unknown[] = [];
    const dup_counts = new Map<string, number>(); // key-sig -> dropped count
    for (const item of data) {
      if (typeof item === "object" && item !== null && !Array.isArray(item)) {
        const obj = item as Record<string, unknown>;
        const ks_sig = Object.keys(obj).slice().sort().join(",");
        // Preserve objects whose values contain high-entropy tokens (UUIDs, hashes, JWTs).
        let preserve = false;
        for (const v of Object.values(obj)) {
          if (typeof v === "string" && has_high_entropy_token(v)) {
            preserve = true;
            break;
          }
        }
        if (seen.has(ks_sig) && !preserve) {
          dup_counts.set(ks_sig, (dup_counts.get(ks_sig) ?? 0) + 1);
        } else {
          if (!seen.has(ks_sig)) {
            seen.set(ks_sig, kept.length);
          }
          kept.push(item);
        }
      } else {
        kept.push(item);
      }
    }
    let changed = dup_counts.size > 0;

    // --- truncation ------------------------------------------------------
    const suffix_lines: string[] = [];
    if (dup_counts.size > 0) {
      for (const [ks_sig, n] of dup_counts) {
        const keys_repr = ks_sig.split(",").join(", ");
        suffix_lines.push(`[... ${n} duplicate objects with keys {${keys_repr}} omitted]`);
      }
    }
    if (kept.length > _JSON_ARRAY_MAX_ITEMS) {
      const extra = kept.length - _JSON_ARRAY_MAX_ITEMS;
      kept.splice(_JSON_ARRAY_MAX_ITEMS, extra);
      suffix_lines.push(`[... ${extra} more items not shown]`);
      changed = true;
    }

    if (!changed) {
      return text;
    }

    const parts = [JSON.stringify(kept, null, 2)];
    parts.push(...suffix_lines);
    return parts.join("\n");
  }
}

// ===========================================================================
// Binary inspection (xxd / hexdump / od) — Python ~24822-24898
// ===========================================================================

/** Short dumps pass through unchanged (e.g. single-line `file` output leaking in). */
const _BIN_INSPECT_PASSTHROUGH = 4;

/**
 * Magic-byte prefixes (lowercase hex, longest-match checked first).
 * Python _MAGIC_MAP: tuple of (prefix_hex, description).
 */
const _MAGIC_MAP: ReadonlyArray<readonly [string, string]> = [
  ["89504e47", "PNG image"],
  ["ffd8ff", "JPEG image"],
  ["25504446", "PDF document"],
  ["504b0304", "ZIP archive"],
  ["7f454c46", "ELF binary"],
  ["4d5a", "Windows EXE/DLL"],
  ["cafebabe", "Java class file"],
  ["1f8b", "gzip archive"],
  ["377abcaf", "7-zip archive"],
];

/**
 * Matches xxd ("OFFSET: XX XX ...") or hexdump -C ("OFFSET  XX XX ...").
 * Python: re.compile(r"^[0-9a-f]{4,}(?::\s+|\s{2,})([0-9a-f][0-9a-f\s]+)", re.IGNORECASE)
 */
const _HEX_DUMP_LINE_RE: RegExp =
  /^[0-9a-f]{4,}(?::\s+|\s{2,})([0-9a-f][0-9a-f\s]+)/i;

/**
 * Return [magic_hex, description] for the first hex-dump line.
 *
 * Falls back to ["", "unrecognised format"] when the line cannot be parsed.
 * Mirrors Python `_identify_hex_magic` (module-private helper).
 */
function _identify_hex_magic(first_line: string): [string, string] {
  const m = _reMatchObj(_HEX_DUMP_LINE_RE, first_line);
  if (!m) {
    return ["", "unrecognised format"];
  }
  // Strip spaces from the data portion and normalise to lowercase.
  const raw = m[1]!.replace(/ /g, "").toLowerCase();
  const magic8 = raw.slice(0, 8);
  if (magic8.length < 4) {
    return ["", "unrecognised format"];
  }
  for (const [prefix, description] of _MAGIC_MAP) {
    if (magic8.startsWith(prefix)) {
      return [magic8.slice(0, prefix.length), description];
    }
  }
  return [magic8, "unknown binary type"];
}

/**
 * Compress hex-dump output from `xxd`, `hexdump`, `od`, and `hd`.
 *
 * Passes through short output (<= _BIN_INSPECT_PASSTHROUGH lines). Keeps the
 * first 2 hex lines verbatim (shows magic bytes in context), identifies the file
 * type from the first 4 magic bytes, and replaces remaining lines with a single
 * semantic summary line.
 */
export class BinaryInspectFilter extends Filter {
  override name = "xxd";
  override binaries: ReadonlySet<string> = new Set<string>(["xxd", "hexdump", "od", "hd"]);

  override compress(stdout: string, stderr: string, _exit_code: number, _argv: string[]): string {
    const merged = this._combine_output(stdout, stderr);
    const lines = merged.split("\n");
    if (lines.length <= _BIN_INSPECT_PASSTHROUGH) {
      return merged;
    }
    const total = lines.length;
    // Python: lines[0].rstrip("\r\n") — strip a trailing CR (already gone after
    // normalise(), but kept for parity).
    const [magic_hex, description] = _identify_hex_magic(_rstrip(lines[0]!).replace(/\r+$/, ""));
    let summary: string;
    if (magic_hex) {
      summary =
        `[token-goat: hex dump of ${total} lines` +
        ` — detected: ${description} (magic: ${magic_hex})]`;
    } else {
      summary = `[token-goat: hex dump of ${total} lines — ${description}]`;
    }
    const kept: string[] = [lines[0]!, lines[1]!];
    kept.push(summary + "\n");
    return Filter._finalize(kept);
  }
}

/**
 * Pass-through wrapper for the `file` command.
 *
 * `file` output is already semantic (e.g. "foo.png: PNG image, 800x600"). This
 * filter registers the binary so it is never accidentally routed to a generic
 * handler. Long batch runs (directory scans) are truncated to 20 lines plus a
 * count.
 */
export class FileTypeFilter extends Filter {
  override name = "file";
  override binaries: ReadonlySet<string> = new Set<string>(["file"]);
  _BATCH_LIMIT = 20;

  override compress(stdout: string, stderr: string, _exit_code: number, _argv: string[]): string {
    const merged = this._combine_output(stdout, stderr);
    const lines = merged.split("\n");
    if (lines.length <= this._BATCH_LIMIT) {
      return merged;
    }
    const remaining = lines.length - this._BATCH_LIMIT;
    const kept = lines.slice(0, this._BATCH_LIMIT);
    kept.push(`[token-goat: ${remaining} more file entries truncated]\n`);
    return Filter._finalize(kept);
  }
}

// ===========================================================================
// Severity-scored log classification — Python ~24927-25015
// ===========================================================================

/**
 * ERROR / FAIL / CRITICAL / EXCEPTION / FATAL signals.
 * Python _LOG_LEVEL_RE (re.IGNORECASE).
 */
const _LOG_LEVEL_RE: RegExp =
  /\b(ERROR|FAIL(?:URE|ED)?|CRITICAL|EXCEPTION|FATAL)\b|\[ERROR\]|\[CRITICAL\]|\[FATAL\]|level=(?:error|critical|fatal)/i;
/** WARN(ING) signals. Python _LOG_WARN_RE (re.IGNORECASE). */
const _LOG_WARN_RE: RegExp = /\b(WARN(?:ING)?)\b|\[WARN(?:ING)?\]|level=warn/i;
/** INFO signals. Python _LOG_INFO_RE (re.IGNORECASE). */
const _LOG_INFO_RE: RegExp = /\b(INFO)\b|\[INFO\]|level=info/i;
/** DEBUG / TRACE / VERBOSE signals. Python _LOG_DEBUG_RE (re.IGNORECASE). */
const _LOG_DEBUG_RE: RegExp =
  /\b(DEBUG|TRACE|VERBOSE)\b|\[DEBUG\]|\[TRACE\]|level=(?:debug|trace)/i;
/** Combined keyword regex for log-stream detection (30% threshold check). */
const _LOG_ANY_RE: RegExp =
  /\b(?:ERROR|FAIL(?:URE|ED)?|CRITICAL|EXCEPTION|FATAL|WARN(?:ING)?|INFO|DEBUG|TRACE|VERBOSE)\b|\[(?:ERROR|CRITICAL|FATAL|WARN(?:ING)?|INFO|DEBUG|TRACE)\]|level=(?:error|critical|fatal|warn|info|debug|trace)/i;
/**
 * Stack-trace continuation lines kept unconditionally inside a trace window.
 * Python _TRACE_CONTINUATION_RE.
 */
const _TRACE_CONTINUATION_RE: RegExp =
  /^\s+(?:at |File "|in |\w+Error:|\w+Exception:)|^\s+\w+[\w.]+\(.*\)$|^\s+\.{3}\s*\d+\s+more|^Caused by:|^During handling of the above exception/;

/** Return severity score for a single log line (0.0-1.0). Mirrors Python helper. */
function _score_log_line(line: string): number {
  if (_reSearch(_LOG_LEVEL_RE, line)) {
    return 1.0;
  }
  if (_reSearch(_LOG_WARN_RE, line)) {
    return 0.5;
  }
  if (_reSearch(_LOG_INFO_RE, line)) {
    return 0.1;
  }
  if (_reSearch(_LOG_DEBUG_RE, line)) {
    return 0.0;
  }
  return 0.0;
}

/** Apply severity-scored filtering to log text; return compressed output. */
function _compress_severity_log(text: string, context_n: number, threshold: number): string {
  const lines = text.split("\n");
  const n = lines.length;
  const scores = lines.map((ln) => _score_log_line(ln));
  // First pass: identify primary-kept lines (high score or inside a trace window).
  const primary = new Set<number>();
  let in_trace = false;
  for (let i = 0; i < lines.length; i += 1) {
    const ln = lines[i]!;
    const score = scores[i]!;
    if (in_trace) {
      if (_strip(ln) === "") {
        in_trace = false;
      } else if (_reMatch(_TRACE_CONTINUATION_RE, ln)) {
        primary.add(i);
      } else {
        in_trace = false;
        if (score >= threshold) {
          primary.add(i);
          if (score >= 1.0) {
            in_trace = true;
          }
        }
      }
    } else {
      if (score >= threshold) {
        primary.add(i);
        if (score >= 1.0) {
          in_trace = true;
        }
      }
    }
  }
  // Second pass: expand by context_n around every primary-kept line.
  const expanded = new Set<number>();
  for (const idx of primary) {
    const lo = Math.max(0, idx - context_n);
    const hi = Math.min(n, idx + context_n + 1);
    for (let j = lo; j < hi; j += 1) {
      expanded.add(j);
    }
  }
  // Build output, inserting suppression sentinels at each gap.
  const result: string[] = [];
  let suppressed = 0;
  for (let i = 0; i < lines.length; i += 1) {
    if (expanded.has(i)) {
      if (suppressed > 0) {
        result.push(`[suppressed ${suppressed} lines]`);
        suppressed = 0;
      }
      result.push(lines[i]!);
    } else {
      suppressed += 1;
    }
  }
  if (suppressed > 0) {
    result.push(`[suppressed ${suppressed} lines]`);
  }
  return Filter._finalize(result);
}

/**
 * Severity-scored compressor for structured log streams.
 *
 * Keeps every line scoring at or above score_threshold (ERROR/WARN by default),
 * plus context_lines neighbours on each side. Runs of lower-severity lines are
 * replaced by `[suppressed N lines]` sentinels. Multi-line stack traces opened
 * by an ERROR/FAIL line are preserved as a unit until a blank line or
 * non-continuation line closes the window.
 */
export class SeverityLogFilter extends Filter {
  override name = "severity_log";
  override binaries: ReadonlySet<string> = new Set<string>();

  /**
   * Return True when stdout looks like a structured log stream.
   *
   * Requires at least 5 lines, with >=30% containing a log-level keyword.
   * (Python @classmethod detect — ported as an instance method.)
   */
  detect(stdout: string): boolean {
    const lines = stdout.split("\n");
    if (lines.length < 5) {
      return false;
    }
    let keyword_count = 0;
    for (const ln of lines) {
      if (_reSearch(_LOG_ANY_RE, ln)) {
        keyword_count += 1;
      }
    }
    return keyword_count / lines.length >= 0.30;
  }

  override detect_from_command(_cmd: string): boolean {
    return false; // content-based only; hook layer routes via detect()
  }

  override matches(_argv: string[]): boolean {
    return false; // content-based only; never claimed via binary dispatch
  }

  override compress(stdout: string, stderr: string, _exit_code: number, _argv: string[]): string {
    const combined = this._combine_output(stdout, stderr);
    if (!this.detect(combined)) {
      return combined;
    }
    // SeverityLogConfig marks both fields optional in the type (they are always
    // populated by config.load()'s _validatedInt/_validatedFloat, but the TS
    // type is loose). Mirror the Python / config.ts fallback defaults
    // (context_lines=3, score_threshold=0.5) so the optional shape is honoured.
    const cfg = config.load().bash_severity_log;
    const context_lines = cfg?.context_lines ?? 3;
    const score_threshold = cfg?.score_threshold ?? 0.5;
    return _compress_severity_log(combined, context_lines, score_threshold);
  }
}

// ===========================================================================
// ps / top / tasklist — Python ~25087-25231
// ===========================================================================

const _PS_MIN_LINES = 20;
const _PS_HEADER_KEYWORDS: readonly string[] = [
  "PID", "COMMAND", "CMD", "IMAGE NAME", "%CPU", "UID",
];
const _PS_TOP_PREFIXES: readonly string[] = [
  "top -", "tasks:", "%cpu", "mib ", "kib ", "gib ",
];
const _PS_DEV_SUBSTRINGS: readonly string[] = [
  "python", "node", "uvicorn", "gunicorn", "django", "flask", "fastapi",
  "cargo", "rustc", "go ", "java", "ruby", "rails", "php", "postgres",
  "mysql", "redis", "nginx", "caddy", "docker", "kubectl", "npm",
  "pnpm", "yarn", "bun", "deno", "git", "ssh",
];

/**
 * Return True if a process line should be kept by PsFilter.
 *
 * For tasklist (no user/cpu/mem columns), the whole line is checked for
 * dev-relevant substrings. For ps/top, the USER column (col0) is checked for the
 * current user, the COMMAND column (from cmd_start onward) for dev-relevant
 * substrings, and the %CPU/%MEM columns against resource thresholds (>5.0% CPU
 * or >2.0% MEM) when present. A non-numeric CPU/MEM value yields NaN, which
 * fails the comparison exactly as Python's ValueError branch.
 */
function _ps_keep_line(
  line: string,
  opts: {
    cpu_col: number | null;
    mem_col: number | null;
    cmd_start: number;
    is_tasklist: boolean;
    current_user: string;
  },
): boolean {
  const { cpu_col, mem_col, cmd_start, is_tasklist, current_user } = opts;
  if (is_tasklist) {
    // tasklist has no user/cpu/mem columns by default; check whole line.
    const lower = line.toLowerCase();
    return _PS_DEV_SUBSTRINGS.some((sub) => lower.includes(sub));
  }
  const cols = line.split(/\s+/).filter((c) => c.length > 0);
  if (cols.length === 0) {
    return false;
  }
  // Keep user-owned processes (USER is col0 in ps aux / ps -ef).
  if (current_user !== "" && cols[0]!.toLowerCase() === current_user) {
    return true;
  }
  // Check command column for dev-relevant substrings.
  let cmd_str: string;
  if (cols.length > cmd_start) {
    cmd_str = cols.slice(cmd_start).join(" ").toLowerCase();
  } else {
    cmd_str = line.toLowerCase();
  }
  if (_PS_DEV_SUBSTRINGS.some((sub) => cmd_str.includes(sub))) {
    return true;
  }
  // Check CPU/MEM resource thresholds when available.
  if (cpu_col !== null && mem_col !== null && cols.length > Math.max(cpu_col, mem_col)) {
    const cpu_val = Number(cols[cpu_col]!);
    const mem_val = Number(cols[mem_col]!);
    if (cpu_val > 5.0 || mem_val > 2.0) {
      return true;
    }
    // NaN > 5.0 is false — matches Python's ValueError pass.
  }
  return false;
}

/**
 * Compress ps/top/pstree/tasklist process-listing output.
 *
 * Keeps the header, dev-relevant processes, high-resource processes, and
 * user-owned processes. Drops kernel threads, system daemons, and idle
 * processes. Appends a `[suppressed N system processes]` sentinel line when any
 * lines are dropped. Passes through unchanged when the output is <= 20 lines or
 * when nothing was suppressed.
 */
export class PsFilter extends Filter {
  override name = "ps";
  override binaries: ReadonlySet<string> = new Set<string>(["ps", "top", "pstree", "tasklist"]);

  /**
   * Return True when stdout looks like ps, top, or tasklist tabular output.
   * (Python @staticmethod detect — ported as an instance method.)
   */
  detect(stdout: string): boolean {
    for (const line of stdout.split("\n")) {
      const stripped = _strip(line);
      if (stripped === "") {
        continue;
      }
      // top batch mode starts with a summary line.
      if (stripped.toLowerCase().startsWith("top -")) {
        return true;
      }
      // Column header contains known process-table keywords.
      const upper = stripped.toUpperCase();
      if (_PS_HEADER_KEYWORDS.some((kw) => upper.includes(kw))) {
        return true;
      }
      break;
    }
    return false;
  }

  override compress(stdout: string, _stderr: string, _exit_code: number, _argv: string[]): string {
    // NOTE: Python reads `stdout` only (not _combine_output) for PsFilter.
    const lines = stdout.split("\n");
    if (lines.length <= _PS_MIN_LINES) {
      return stdout;
    }
    // Locate the column-header line (skip top's summary block).
    let col_header_idx = -1;
    for (let i = 0; i < lines.length; i += 1) {
      const stripped = _strip(lines[i]!);
      if (stripped === "") {
        continue;
      }
      const lower = stripped.toLowerCase();
      // Skip top summary lines (top -, Tasks:, %Cpu, MiB, KiB, GiB).
      if (_PS_TOP_PREFIXES.some((pfx) => lower.startsWith(pfx))) {
        continue;
      }
      const upper = stripped.toUpperCase();
      if (_PS_HEADER_KEYWORDS.some((kw) => upper.includes(kw))) {
        col_header_idx = i;
        break;
      }
    }
    if (col_header_idx === -1) {
      return stdout;
    }
    const header_upper = lines[col_header_idx]!.toUpperCase();
    const is_tasklist = header_upper.includes("IMAGE NAME");
    // Dynamically locate %CPU / %MEM / COMMAND cols from header; ps aux =
    // col2/3/10, top = col8/9/11, tasklist = n/a.
    const header_tokens = lines[col_header_idx]!.split(/\s+/).filter((t) => t.length > 0);
    let cpu_col: number | null = null;
    let mem_col: number | null = null;
    for (let i = 0; i < header_tokens.length; i += 1) {
      if (header_tokens[i]!.toUpperCase() === "%CPU") {
        cpu_col = i;
      }
    }
    for (let i = 0; i < header_tokens.length; i += 1) {
      if (header_tokens[i]!.toUpperCase() === "%MEM") {
        mem_col = i;
      }
    }
    const _cmd_col_names: ReadonlySet<string> = new Set<string>(["COMMAND", "CMD"]);
    let cmd_start = 10; // fallback: ps aux default
    for (let i = 0; i < header_tokens.length; i += 1) {
      if (_cmd_col_names.has(header_tokens[i]!.toUpperCase())) {
        cmd_start = i;
        break;
      }
    }
    const current_user = (process.env.USERNAME ?? process.env.USER ?? "").toLowerCase();
    const kept: string[] = [];
    let suppressed_count = 0;
    for (let i = 0; i < lines.length; i += 1) {
      // Keep all lines up to and including the column header.
      if (i <= col_header_idx) {
        kept.push(lines[i]!);
        continue;
      }
      const line = lines[i]!;
      const stripped = _strip(line);
      if (stripped === "") {
        kept.push(line);
        continue;
      }
      // Keep tasklist separator lines (=== === ...).
      if (is_tasklist && [...stripped].every((c) => c === "=" || c === " ")) {
        kept.push(line);
        continue;
      }
      if (
        _ps_keep_line(line, {
          cpu_col,
          mem_col,
          cmd_start,
          is_tasklist,
          current_user,
        })
      ) {
        kept.push(line);
      } else {
        suppressed_count += 1;
      }
    }
    if (suppressed_count === 0) {
      return stdout;
    }
    // Strip trailing blank lines before appending sentinel.
    while (kept.length > 0 && _strip(kept[kept.length - 1]!) === "") {
      kept.pop();
    }
    kept.push(`[suppressed ${suppressed_count} system processes]`);
    return Filter._finalize(kept);
  }
}
