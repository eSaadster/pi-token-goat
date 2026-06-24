/**
 * Detect Read/Grep-equivalent patterns inside Codex's Bash tool calls.
 *
 * Codex (and other agent harnesses) issue file reads as raw Bash commands rather
 * than through a structured Read tool. This module parses those command strings
 * and returns a `BashIntent` that callers can treat the same way as a Read,
 * Grep, or Glob tool invocation — enabling image-shrink and session-hint logic to
 * apply consistently regardless of which harness fired the tool.
 *
 * Supported patterns
 * ------------------
 * Read — cat, head, tail, bat, batcat, less, more, nl, zcat, zless, zmore, xxd,
 * od, wc, type (cmd.exe), Get-Content / gc (PowerShell). Scripted readers (sed,
 * awk, perl) are also recognized but treated as unknown when invoked with
 * in-place edit flags. Stdin redirection (cmd < FILE) is recognised as a read of
 * FILE regardless of the leading command. Multi-file reads (cat f1.py f2.py) are
 * detected: target_path holds the first file for backward compatibility and
 * target_paths holds all files when more than one is present.
 *
 * Grep — rg, grep, ag, ack, ripgrep.
 * Glob/find — find, fd, fdfind, ls, eza.
 * jq/yq read-equivalent — jq '.' file.json and yq '.' file.yaml (trivial
 * identity filter '.' only) are classified as kind='read' because they stream
 * the full file to stdout unchanged. Non-trivial filter expressions fall through
 * to unknown.
 *
 * All parsing is best-effort. Unrecognized or malformed commands are returned as
 * BashIntent(kind="unknown") without raising an exception.
 */
import { getLogger } from "./util.js";

const _LOG = getLogger("bash_parser");

// Hard cap on the raw command string before tokenizing to prevent a crafted
// multi-megabyte payload from causing linear memory allocation in the tokenizer.
// 64 KiB is far larger than any legitimate single-line shell command that an
// agent would issue; anything beyond this is anomalous and rejected early.
const _MAX_COMMAND_BYTES = 65_536; // 64 KiB

// Hard cap on the extracted target_path. Real file-system paths are bounded
// by PATH_MAX (~4096 bytes on Linux, 32767 on Windows); 8 KiB leaves headroom
// while still preventing an unbounded heap allocation in the synthesized Read
// payload that bash_parser feeds into hooks_read.
const _MAX_PATH_BYTES = 8_192; // 8 KiB

/** All valid values for BashIntent.kind. */
export type BashIntentKind = "read" | "grep" | "glob" | "unknown";

/**
 * A high-level interpretation of a Bash command line.
 *
 * Ported from the Python `@dataclass BashIntent`; constructed via `makeIntent`
 * so every field defaults exactly as the Python dataclass does.
 */
export class BashIntent {
  kind: BashIntentKind;
  target_path: string | null;
  target_paths: string[] | null;
  pattern: string | null;
  offset: number | null;
  limit: number | null;
  reason: string | null;
  filtered: boolean;
  filter_pattern: string | null;
  is_interactive_pager: boolean;

  constructor(init: {
    kind: BashIntentKind;
    target_path?: string | null;
    target_paths?: string[] | null;
    pattern?: string | null;
    offset?: number | null;
    limit?: number | null;
    reason?: string | null;
    filtered?: boolean;
    filter_pattern?: string | null;
    is_interactive_pager?: boolean;
  }) {
    this.kind = init.kind;
    this.target_path = init.target_path ?? null;
    this.target_paths = init.target_paths ?? null;
    this.pattern = init.pattern ?? null;
    this.offset = init.offset ?? null;
    this.limit = init.limit ?? null;
    this.reason = init.reason ?? null;
    this.filtered = init.filtered ?? false;
    this.filter_pattern = init.filter_pattern ?? null;
    this.is_interactive_pager = init.is_interactive_pager ?? false;
  }
}

// ── Constant binary / cmdlet sets ──────────────────────────────────────────

const READ_BINS = new Set<string>([
  "cat",
  "head",
  "tail",
  "bat",
  "batcat",
  "less",
  "more",
  "nl",
  "zcat",
  "zless",
  "zmore",
  "sed",
  "awk",
  "perl",
  "xxd",
  "od",
  "wc",
  "type",
  "get-content",
  "gc",
]);

const INTERACTIVE_PAGER_BINS = new Set<string>(["less", "more"]);

const SCRIPTED_READ_BINS = new Set<string>(["sed", "awk", "perl"]);

const _PS_PATH_FLAGS = new Set<string>(["-path", "-literalpath"]);

const _PS_HEAD_FLAGS = new Set<string>(["-totalcount", "-first", "-head"]);
const _PS_TAIL_FLAGS = new Set<string>(["-tail", "-last"]);

const _PS_READ_BINS = new Set<string>(["get-content", "gc"]);

const _PS_FILTER_CMDLETS = new Set<string>([
  "select-string",
  "sls",
  "where-object",
  "where",
  "?",
]);

const _PS_LIMIT_CMDLETS = new Set<string>(["select-object", "select"]);

const _PS_PASSTHROUGH_CMDLETS = new Set<string>([
  "out-string",
  "out-host",
  "out-default",
  "format-table",
  "format-list",
  "ft",
  "fl",
  "write-host",
  "write-output",
  // Ordering / aggregation (all lines consumed)
  "sort-object",
  "sort",
  "measure-object",
  "measure",
  "group-object",
  "group",
  // Iteration (every line visited)
  "foreach-object",
  "%",
  "foreach",
  // Tee — copies stream, does not narrow it
  "tee-object",
  "tee",
  // Serialisation — all source lines consumed
  "convertto-json",
  "convertto-csv",
  "convertto-html",
  "convertto-xml",
  "convertto-string",
]);

const _PS_PATTERN_FLAGS = new Set<string>(["-pattern", "-pat", "-p"]);

// Regex extracts the pattern from a Where-Object script block. Handles the
// positive comparison operators (-match, -like, -imatch, -cmatch) and the
// negation operators (-notmatch, -notlike, -inotmatch, -cnotmatch). Single or
// double quotes accepted.
const _PS_WHERE_MATCH_RE =
  /\$_\s*-(?:(?:c|i)?(?:not)?match|(?:not)?like)\s+(['"])([^'"]+)\1/;

const GREP_BINS = new Set<string>([
  "rg",
  "grep",
  "ag",
  "ack",
  "ripgrep",
  "findstr",
  "select-string",
  "sls",
]);

const GLOB_BINS = new Set<string>(["find", "fd", "fdfind", "ls", "eza"]);

const JQ_BINS = new Set<string>(["jq", "yq"]);

const _JQ_TRIVIAL_FILTERS = new Set<string>([".", ""]);

// ── shlex (POSIX) tokenizer ─────────────────────────────────────────────────

/**
 * Faithful POSIX shlex.split. Removes quotes, processes backslash escapes
 * (outside single quotes), splits on whitespace. Throws on an unterminated
 * quote, mirroring Python's shlex `ValueError("No closing quotation")`.
 */
function _shlexSplit(s: string): string[] {
  const tokens: string[] = [];
  let i = 0;
  const n = s.length;
  const isSpace = (c: string): boolean =>
    c === " " ||
    c === "\t" ||
    c === "\n" ||
    c === "\r" ||
    c === "\f" ||
    c === "\v";

  while (i < n) {
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
        const close = s.indexOf("'", i + 1);
        if (close === -1) {
          throw new Error("No closing quotation");
        }
        token += s.slice(i + 1, close);
        i = close + 1;
        continue;
      }
      if (c === '"') {
        let j = i + 1;
        let inner = "";
        let closed = false;
        while (j < n) {
          const d = s[j]!;
          if (d === '"') {
            closed = true;
            break;
          }
          if (d === "\\" && j + 1 < n) {
            const e = s[j + 1]!;
            if (e === '"' || e === "\\" || e === "$" || e === "`") {
              inner += e;
              j += 2;
              continue;
            }
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
        token += inner;
        i = j + 1;
        continue;
      }
      if (c === "\\" && i + 1 < n) {
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

/**
 * Replicate Python `pathlib.PurePosixPath(token).stem`: take the final
 * forward-slash component, then strip a single trailing extension. A leading
 * dot (dotfile) is not treated as an extension separator.
 */
function _pathStem(token: string): string {
  const slash = token.lastIndexOf("/");
  const name = slash === -1 ? token : token.slice(slash + 1);
  // Python: name with no dot, a single leading dot, or all-dots → stem == name.
  const dot = name.lastIndexOf(".");
  if (dot <= 0) {
    return name;
  }
  return name.slice(0, dot);
}

// ── Helpers ─────────────────────────────────────────────────────────────────

/** Attempt to parse a string as an integer, return null on failure. */
function _tryParseInt(value: string): number | null {
  // Python int() accepts surrounding whitespace and an optional +/- sign, but
  // rejects floats and trailing junk. Mirror that precisely.
  const trimmed = value.trim();
  if (!/^[+-]?\d+$/.test(trimmed)) {
    return null;
  }
  const n = Number.parseInt(trimmed, 10);
  return Number.isNaN(n) ? null : n;
}

const _SED_RANGE_RE = /^\s*(\d+)(?:\s*,\s*(\d+))?\s*p\s*$/;

const _AWK_EQ_RE = /^\s*NR\s*==\s*(\d+)\s*$/;
const _AWK_RANGE_RE = /^\s*NR\s*>=?\s*(\d+)\s*&&\s*NR\s*<=?\s*(\d+)\s*$/;

const _PATH_LIKE_RE = /[./\\:~]/;

function _looksLikePath(token: string): boolean {
  return _PATH_LIKE_RE.test(token);
}

/**
 * Return True when path_str is a system/OS path unlikely to be a project file.
 */
function _isSystemPath(pathStr: string): boolean {
  const pathLower = pathStr.toLowerCase().replace(/\\/g, "/");
  if (
    pathLower.startsWith("/etc/") ||
    pathLower.startsWith("/sys/") ||
    pathLower.startsWith("/proc/") ||
    pathLower.startsWith("/dev/")
  ) {
    return true;
  }
  if (
    pathLower.startsWith("/mnt/c/windows/") ||
    pathLower.startsWith("/mnt/c/program files") ||
    pathLower.startsWith("/mnt/c/programdata/")
  ) {
    return true;
  }
  return (
    pathLower.startsWith("c:/windows/") ||
    pathLower.startsWith("c:/program files") ||
    pathLower.startsWith("c:/programdata/") ||
    pathLower.startsWith("c:/winnt/")
  );
}

/** Extract (offset, limit) from a sed -n script expression. */
function _parseSedScript(script: string): [number | null, number | null] {
  const m = _SED_RANGE_RE.exec(script);
  if (!m) {
    return [null, null];
  }
  const start = Number.parseInt(m[1]!, 10);
  const end = m[2] !== undefined ? Number.parseInt(m[2], 10) : start;
  if (end < start) {
    return [null, null];
  }
  return [start, end - start + 1];
}

/** Extract (offset, limit) from an awk slice expression. */
function _parseAwkScript(script: string): [number | null, number | null] {
  let m = _AWK_EQ_RE.exec(script);
  if (m) {
    const line = Number.parseInt(m[1]!, 10);
    return [line, 1];
  }
  m = _AWK_RANGE_RE.exec(script);
  if (m) {
    const start = Number.parseInt(m[1]!, 10);
    const end = Number.parseInt(m[2]!, 10);
    if (end < start) {
      return [null, null];
    }
    return [start, end - start + 1];
  }
  return [null, null];
}

/** Strip stdin-redirect tokens (< FILE) and return [tokens, file]. */
function _extractStdinRedirect(
  tokens: string[],
): [string[], string | null] {
  let redirectFile: string | null = null;
  const cleaned: string[] = [];
  let i = 0;
  while (i < tokens.length) {
    const tok = tokens[i]!;
    if (tok === "<<" || tok === "<<<" || tok.startsWith("<<")) {
      cleaned.push(tok);
      i += 1;
      continue;
    }
    if (tok === "<" && i + 1 < tokens.length) {
      redirectFile = tokens[i + 1]!;
      i += 2;
      continue;
    }
    if (tok.startsWith("<") && !tok.startsWith("<<")) {
      const candidate = tok.slice(1);
      if (candidate) {
        redirectFile = candidate;
        i += 1;
        continue;
      }
    }
    cleaned.push(tok);
    i += 1;
  }
  return [cleaned, redirectFile];
}

/**
 * Split a compound Bash command on &&, ;, and || operators.
 *
 * Separators inside single quotes, double quotes, and $(...)/(...) subshells
 * are ignored. || branches are dropped — they represent failure-fallback
 * commands that should not be treated as independently cacheable reads.
 */
export function split_compound(cmd: string): string[] {
  const segments: string[] = [];
  let current: string[] = [];
  let i = 0;
  const n = cmd.length;
  let inSingle = false;
  let inDouble = false;
  let inBacktick = false;
  let parenDepth = 0;
  let skipSegment = false; // True when the current segment follows a || operator

  while (i < n) {
    const ch = cmd[i]!;

    // ── Inside single quotes ──
    if (inSingle) {
      current.push(ch);
      if (ch === "'") {
        inSingle = false;
      }
      i += 1;
      continue;
    }

    // ── Inside backtick subshell ──
    if (inBacktick) {
      current.push(ch);
      if (ch === "`") {
        inBacktick = false;
      }
      i += 1;
      continue;
    }

    // ── Inside double quotes ──
    if (inDouble) {
      current.push(ch);
      if (ch === "\\") {
        i += 1;
        if (i < n) {
          current.push(cmd[i]!);
        }
        i += 1;
        continue;
      }
      if (ch === '"') {
        inDouble = false;
      } else if (ch === "$" && i + 1 < n && cmd[i + 1] === "(") {
        parenDepth += 1;
        current.push("(");
        i += 2;
        continue;
      }
      i += 1;
      continue;
    }

    // ── Inside $(...) or (...) subshell ──
    if (parenDepth > 0) {
      current.push(ch);
      if (ch === "(") {
        parenDepth += 1;
      } else if (ch === ")") {
        parenDepth -= 1;
        if (parenDepth < 0) {
          parenDepth = 0;
        }
      } else if (ch === "'") {
        inSingle = true;
      } else if (ch === '"') {
        inDouble = true;
      }
      i += 1;
      continue;
    }

    // ── Top-level characters ──
    if (ch === "`") {
      inBacktick = true;
      current.push(ch);
      i += 1;
    } else if (ch === "'") {
      inSingle = true;
      current.push(ch);
      i += 1;
    } else if (ch === '"') {
      inDouble = true;
      current.push(ch);
      i += 1;
    } else if (ch === "$" && i + 1 < n && cmd[i + 1] === "(") {
      parenDepth += 1;
      current.push(ch);
      current.push("(");
      i += 2;
    } else if (ch === "(") {
      parenDepth += 1;
      current.push(ch);
      i += 1;
    } else if (ch === "\\") {
      current.push(ch);
      i += 1;
      if (i < n) {
        current.push(cmd[i]!);
        i += 1;
      }
    } else if (cmd.slice(i, i + 2) === "&&") {
      const seg = current.join("").trim();
      if (seg && !skipSegment) {
        segments.push(seg);
      }
      current = [];
      skipSegment = false;
      i += 2;
    } else if (cmd.slice(i, i + 2) === "||") {
      const seg = current.join("").trim();
      if (seg && !skipSegment) {
        segments.push(seg);
      }
      current = [];
      skipSegment = true; // next segment is a fallback branch — drop it
      i += 2;
    } else if (ch === ";") {
      const seg = current.join("").trim();
      if (seg && !skipSegment) {
        segments.push(seg);
      }
      current = [];
      skipSegment = false;
      i += 1;
    } else {
      current.push(ch);
      i += 1;
    }
  }

  // Flush the final segment
  const seg = current.join("").trim();
  if (seg && !skipSegment) {
    segments.push(seg);
  }

  return segments.length > 0 ? segments : [cmd.trim()];
}

const _PREFIX_TOKENS = new Set<string>(["sudo", "time", "nice", "exec"]);

/**
 * Best-effort parse of a single Bash command line.
 *
 * Only the first pipeline segment (before any |) is analysed for most shells;
 * for PowerShell Get-Content pipelines downstream filter/limit cmdlets are
 * inspected too. Prefix tokens (sudo, time, nice, exec, VAR=val) are stripped.
 */
export function parse(command: string): BashIntent {
  if (command.length > _MAX_COMMAND_BYTES) {
    _LOG.warning(
      "bash_parser: command too long (%d chars > %d limit); rejecting",
      command.length,
      _MAX_COMMAND_BYTES,
    );
    return new BashIntent({ kind: "unknown", reason: "command too long" });
  }

  const segments = command.split("|").map((s) => s.trim());
  command = segments[0]!;
  const pipelineTail = segments.slice(1);

  let tokens: string[];
  try {
    tokens = _shlexSplit(command);
  } catch (e) {
    const safeErr = String((e as Error).message ?? e)
      .replace(/\n/g, "\\n")
      .replace(/\r/g, "\\r")
      .slice(0, 200);
    _LOG.debug("bash_parser: shlex.split failed: %s", safeErr);
    return new BashIntent({
      kind: "unknown",
      reason: "invalid shell quoting",
    });
  }

  // Strip common prefixes like sudo, time, nice, exec and env VAR=val assignments
  while (
    tokens.length > 0 &&
    (_PREFIX_TOKENS.has(tokens[0]!) || tokens[0]!.includes("="))
  ) {
    tokens.shift();
  }

  if (tokens.length === 0) {
    return new BashIntent({
      kind: "unknown",
      reason: "empty command after stripping prefixes",
    });
  }

  // Heredocs and here-strings look like reads but consume the literal body.
  if (
    tokens.some(
      (t) => t === "<<" || t === "<<<" || t.startsWith("<<"),
    )
  ) {
    return new BashIntent({
      kind: "unknown",
      reason: "heredoc / here-string is not a file read",
    });
  }

  let redirectFile: string | null;
  [tokens, redirectFile] = _extractStdinRedirect(tokens);

  if (tokens.length === 0) {
    if (redirectFile) {
      return _buildReadIntent(redirectFile);
    }
    return new BashIntent({
      kind: "unknown",
      reason: "empty command after stripping redirects",
    });
  }

  const rawStem = _pathStem(tokens[0]!);
  const binary = rawStem.toLowerCase();
  const args = tokens.slice(1);

  if (READ_BINS.has(binary)) {
    const intent = _parseRead(binary, args);
    if (intent.kind !== "read" && redirectFile) {
      return _buildReadIntent(redirectFile);
    }
    if (
      intent.kind === "read" &&
      _PS_READ_BINS.has(binary) &&
      pipelineTail.length > 0
    ) {
      _applyPowershellPipelineFilters(intent, pipelineTail);
    }
    return intent;
  }
  if (binary === "findstr") {
    return _parseFindstr(binary, args);
  }
  if (binary === "select-string" || binary === "sls") {
    return _parsePsGrep(binary, args);
  }
  if (GREP_BINS.has(binary)) {
    return _parseGrep(binary, args);
  }
  if (GLOB_BINS.has(binary)) {
    return _parseGlob(binary, args);
  }
  if (JQ_BINS.has(binary)) {
    return _parseJqRead(binary, args);
  }
  if (redirectFile) {
    return _buildReadIntent(redirectFile);
  }
  return new BashIntent({ kind: "unknown" });
}

/** Construct a kind='read' intent after enforcing the path length cap. */
function _buildReadIntent(targetPath: string): BashIntent {
  if (targetPath.length > _MAX_PATH_BYTES) {
    _LOG.warning(
      "bash_parser: target_path too long (%d chars > %d limit); rejecting",
      targetPath.length,
      _MAX_PATH_BYTES,
    );
    return new BashIntent({
      kind: "unknown",
      reason: "target path too long",
    });
  }
  return new BashIntent({ kind: "read", target_path: targetPath });
}

/**
 * Parse a line-count flag at position i and return [value, tokensConsumed, isSkip].
 * Returns [null, 0, false] when the token at i is not a line-count flag.
 */
function _parseLineCountFlag(
  args: string[],
  i: number,
): [number | null, number, boolean] {
  const a = args[i]!;
  if (a === "-n" || a === "--lines") {
    const raw = i + 1 < args.length ? args[i + 1]! : null;
    const isSkip = typeof raw === "string" && raw.startsWith("+");
    const value = raw ? _tryParseInt(_lstripPlus(raw)) : null;
    return [value, 2, isSkip];
  }
  if (a.startsWith("-n") && a.length > 2) {
    const raw = a.slice(2);
    const isSkip = raw.startsWith("+");
    return [_tryParseInt(_lstripPlus(raw)), 1, isSkip];
  }
  if (a.startsWith("--lines=")) {
    const raw = a.split("=").slice(1).join("=");
    const isSkip = raw.startsWith("+");
    return [_tryParseInt(_lstripPlus(raw)), 1, isSkip];
  }
  return [null, 0, false];
}

/** Python str.lstrip("+"): strip leading '+' characters. */
function _lstripPlus(s: string): string {
  let j = 0;
  while (j < s.length && s[j] === "+") {
    j += 1;
  }
  return s.slice(j);
}

/** Parse cat/head/tail/bat and scripted readers (sed/awk/perl). */
function _parseRead(binary: string, args: string[]): BashIntent {
  if (binary === "get-content" || binary === "gc") {
    return _parsePowershellRead(binary, args);
  }

  const isScripted = SCRIPTED_READ_BINS.has(binary);
  if (
    isScripted &&
    args.some((a) => a === "--in-place" || a.startsWith("-i"))
  ) {
    return new BashIntent({
      kind: "unknown",
      reason: `${binary} edits files in place`,
    });
  }

  const isLineCountBinary = binary === "head" || binary === "tail";
  let limit: number | null = null;
  let tailSkipStart: number | null = null; // 1-indexed start line for tail -n +N
  const positionalArgs: string[] = [];
  let i = 0;
  while (i < args.length) {
    const a = args[i]!;
    if (isLineCountBinary) {
      const [value, consumed, isSkip] = _parseLineCountFlag(args, i);
      if (consumed) {
        if (value !== null) {
          if (isSkip && binary === "tail") {
            tailSkipStart = value;
          } else {
            limit = value;
          }
        }
        i += consumed;
        continue;
      }
    }
    if (a.startsWith("-")) {
      i += 1;
      continue;
    }
    positionalArgs.push(a);
    i += 1;
  }

  if (positionalArgs.length === 0) {
    return new BashIntent({
      kind: "unknown",
      reason: `${binary} command is missing a file path`,
    });
  }
  if (isScripted && positionalArgs.length < 2) {
    return new BashIntent({
      kind: "unknown",
      reason: `${binary} command is missing a target file`,
    });
  }

  let offset: number | null = null;
  let targetPath: string;
  let allFilePaths: string[];
  if (isScripted) {
    targetPath = positionalArgs[positionalArgs.length - 1]!;
    if (binary === "sed") {
      [offset, limit] = _parseSedScript(
        positionalArgs[positionalArgs.length - 2]!,
      );
    } else if (binary === "awk") {
      [offset, limit] = _parseAwkScript(
        positionalArgs[positionalArgs.length - 2]!,
      );
    }
    allFilePaths = [targetPath];
  } else {
    targetPath = positionalArgs[0]!;
    if (binary === "head" && limit !== null) {
      offset = 1;
    } else if (tailSkipStart !== null) {
      offset = Math.max(1, tailSkipStart); // 1-indexed; hooks_read normalises to 0-indexed
    }
    allFilePaths = positionalArgs.filter((p) => !_isSystemPath(p));
  }

  // type ambiguity guard
  if (binary === "type" && !_looksLikePath(targetPath)) {
    return new BashIntent({
      kind: "unknown",
      reason:
        "`type <name>` without a path-like argument is the POSIX builtin",
    });
  }

  if (_isSystemPath(targetPath)) {
    return new BashIntent({
      kind: "unknown",
      reason: `system path ${targetPath} is not a project file`,
    });
  }

  const intent = _buildReadIntent(targetPath);
  if (intent.kind === "read") {
    intent.offset = offset;
    intent.limit = limit;
    if (INTERACTIVE_PAGER_BINS.has(binary)) {
      intent.is_interactive_pager = true;
    }
    if (allFilePaths.length > 1) {
      intent.target_paths = allFilePaths;
    }
  }
  return intent;
}

/** Parse Get-Content / gc (PowerShell) argument lists. */
function _parsePowershellRead(binary: string, args: string[]): BashIntent {
  const targetPaths: string[] = [];
  let limit: number | null = null;
  let offset: number | null = null;
  let isTail = false;
  let isWait = false;
  let i = 0;
  const _argConsumers = new Set<string>([
    "-include",
    "-exclude",
    "-filter",
    "-encoding",
    "-delimiter",
    "-stream",
    "-readcount",
  ]);
  while (i < args.length) {
    const a = args[i]!;
    const lower = a.toLowerCase();
    if (lower === "-wait") {
      isWait = true;
      i += 1;
      continue;
    }
    if (_PS_PATH_FLAGS.has(lower) && i + 1 < args.length) {
      targetPaths.push(args[i + 1]!);
      i += 2;
      continue;
    }
    if (a.includes("=")) {
      const stem = lower.split("=")[0]!;
      const valueStr = a.slice(a.indexOf("=") + 1);
      if (_PS_PATH_FLAGS.has(stem) && valueStr) {
        targetPaths.push(valueStr);
        i += 1;
        continue;
      }
      if (_PS_HEAD_FLAGS.has(stem)) {
        const value = _tryParseInt(valueStr);
        if (value !== null) {
          limit = value;
        }
        i += 1;
        continue;
      }
      if (_PS_TAIL_FLAGS.has(stem)) {
        const value = _tryParseInt(valueStr);
        if (value !== null) {
          limit = value;
          isTail = true;
        }
        i += 1;
        continue;
      }
    }
    if (_PS_HEAD_FLAGS.has(lower) && i + 1 < args.length) {
      const value = _tryParseInt(args[i + 1]!);
      if (value !== null) {
        limit = value;
      }
      i += 2;
      continue;
    }
    if (_PS_TAIL_FLAGS.has(lower) && i + 1 < args.length) {
      const value = _tryParseInt(args[i + 1]!);
      if (value !== null) {
        limit = value;
        isTail = true;
      }
      i += 2;
      continue;
    }
    if (a.startsWith("-")) {
      if (
        i + 1 < args.length &&
        !args[i + 1]!.startsWith("-") &&
        _argConsumers.has(lower)
      ) {
        i += 2;
        continue;
      }
      i += 1;
      continue;
    }
    targetPaths.push(a);
    i += 1;
  }

  if (targetPaths.length === 0) {
    return new BashIntent({
      kind: "unknown",
      reason: `${binary} command is missing a file path`,
    });
  }

  const validPaths = targetPaths.filter((p) => !_isSystemPath(p));
  if (validPaths.length === 0) {
    return new BashIntent({
      kind: "unknown",
      reason: `${binary}: all file paths are system paths`,
    });
  }

  if (limit !== null && !isTail) {
    offset = 1;
  }

  const intent = _buildReadIntent(validPaths[0]!);
  if (intent.kind === "read") {
    intent.offset = offset;
    intent.limit = limit;
    if (isWait) {
      intent.is_interactive_pager = true;
    }
    if (validPaths.length > 1) {
      intent.target_paths = validPaths;
    }
  }
  return intent;
}

const _FINDSTR_FLAG_RE = /^\/[a-zA-Z!?]/;
const _FINDSTR_C_FLAG_RE = /^\/[cC]:(.+)$/;

/** Parse Windows findstr — flags use / prefix; /c:<str> embeds the pattern. */
function _parseFindstr(_binary: string, args: string[]): BashIntent {
  let pattern: string | null = null;
  let targetPath: string | null = null;
  for (const token of args) {
    const cMatch = _FINDSTR_C_FLAG_RE.exec(token);
    if (cMatch) {
      if (pattern === null) {
        pattern = cMatch[1]!;
      }
      continue;
    }
    if (_FINDSTR_FLAG_RE.test(token)) {
      continue;
    }
    if (pattern === null) {
      pattern = token;
    } else if (targetPath === null) {
      targetPath = token;
    }
  }
  if (pattern === null) {
    return new BashIntent({ kind: "unknown" });
  }
  return new BashIntent({ kind: "grep", pattern, target_path: targetPath });
}

/** Parse PowerShell Select-String / sls. */
function _parsePsGrep(_binary: string, args: string[]): BashIntent {
  let pattern: string | null = null;
  let targetPath: string | null = null;
  let i = 0;
  while (i < args.length) {
    const token = args[i]!;
    const lower = token.toLowerCase();
    if (lower === "-pattern" && i + 1 < args.length) {
      pattern = args[i + 1]!;
      i += 2;
      continue;
    }
    if (
      (lower === "-path" || lower === "-literalpath") &&
      i + 1 < args.length
    ) {
      targetPath = args[i + 1]!;
      i += 2;
      continue;
    }
    if (token.startsWith("-")) {
      i += 1;
      continue;
    }
    if (pattern === null) {
      pattern = token;
    } else if (targetPath === null) {
      targetPath = token;
    }
    i += 1;
  }
  if (pattern === null) {
    return new BashIntent({ kind: "unknown" });
  }
  return new BashIntent({ kind: "grep", pattern, target_path: targetPath });
}

/** Extract the search pattern from rg/grep/ag argument lists. */
function _parseGrep(_binary: string, args: string[]): BashIntent {
  let i = 0;
  let pattern: string | null = null;
  let targetPath: string | null = null;
  while (i < args.length) {
    const a = args[i]!;
    if (
      (a === "-e" || a === "--regexp" || a === "-f" || a === "--file") &&
      i + 1 < args.length
    ) {
      pattern = args[i + 1]!;
      i += 2;
      continue;
    }
    if (a.startsWith("--regexp=")) {
      pattern = a.slice(a.indexOf("=") + 1);
      i += 1;
      continue;
    }
    if (a.startsWith("-")) {
      i += 1;
      continue;
    }
    if (pattern === null) {
      pattern = a;
    } else if (targetPath === null) {
      targetPath = a;
    }
    i += 1;
  }

  if (pattern === null) {
    return new BashIntent({ kind: "unknown" });
  }

  if (targetPath && (pattern === "" || pattern === ".")) {
    if (_isSystemPath(targetPath)) {
      return new BashIntent({
        kind: "unknown",
        reason: `system path ${targetPath} is not a project file`,
      });
    }
    return _buildReadIntent(targetPath);
  }

  return new BashIntent({ kind: "grep", pattern, target_path: targetPath });
}

/** Annotate intent with filter/limit info from a PowerShell pipeline tail. */
function _applyPowershellPipelineFilters(
  intent: BashIntent,
  pipelineTail: string[],
): void {
  for (const segment of pipelineTail) {
    if (!segment) {
      continue;
    }
    let segTokens: string[];
    try {
      segTokens = _shlexSplit(segment);
    } catch {
      continue;
    }
    if (segTokens.length === 0) {
      continue;
    }
    const cmdlet = segTokens[0]!.toLowerCase();
    const segArgs = segTokens.slice(1);
    if (_PS_PASSTHROUGH_CMDLETS.has(cmdlet)) {
      continue;
    }
    if (_PS_FILTER_CMDLETS.has(cmdlet)) {
      intent.filtered = true;
      const pattern = _extractPsFilterPattern(cmdlet, segArgs, segment);
      if (pattern !== null && intent.filter_pattern === null) {
        intent.filter_pattern = pattern;
      }
      continue;
    }
    if (_PS_LIMIT_CMDLETS.has(cmdlet)) {
      _applyPsSelectObject(intent, segArgs);
      continue;
    }
    // Unknown cmdlet — leave the intent as-is.
  }
}

/** Pull the search pattern out of a PowerShell filter-cmdlet segment. */
function _extractPsFilterPattern(
  cmdlet: string,
  args: string[],
  rawSegment: string,
): string | null {
  if (cmdlet === "select-string" || cmdlet === "sls") {
    let i = 0;
    while (i < args.length) {
      const a = args[i]!;
      const lower = a.toLowerCase();
      if (_PS_PATTERN_FLAGS.has(lower) && i + 1 < args.length) {
        return args[i + 1]!;
      }
      if (a.includes("=") && _PS_PATTERN_FLAGS.has(lower.split("=")[0]!)) {
        return a.slice(a.indexOf("=") + 1);
      }
      if (!a.startsWith("-")) {
        return a;
      }
      i += 1;
    }
    return null;
  }
  if (cmdlet === "where-object" || cmdlet === "where" || cmdlet === "?") {
    const m = _PS_WHERE_MATCH_RE.exec(rawSegment);
    if (m) {
      return m[2]!;
    }
    return null;
  }
  return null;
}

/** Apply Select-Object -First N / -Last N to intent in place. */
function _applyPsSelectObject(intent: BashIntent, args: string[]): void {
  let i = 0;
  while (i < args.length) {
    const a = args[i]!;
    const lower = a.toLowerCase();
    if ((lower === "-first" || lower === "-last") && i + 1 < args.length) {
      const value = _tryParseInt(args[i + 1]!);
      if (value !== null && intent.limit === null) {
        intent.limit = value;
        if (lower === "-first") {
          intent.offset = 1;
        }
      }
      i += 2;
      continue;
    }
    i += 1;
  }
}

/** Extract the root path/pattern from find/fd/ls/eza argument lists. */
function _parseGlob(_binary: string, args: string[]): BashIntent {
  for (const a of args) {
    if (!a.startsWith("-")) {
      return new BashIntent({ kind: "glob", pattern: a });
    }
  }
  return new BashIntent({ kind: "glob" });
}

const _JQ_VALUE_FLAGS = new Set<string>([
  "--arg",
  "--argjson",
  "--slurpfile",
  "--rawfile",
  "--jsonargs",
  "--args",
  "--indent",
  "--tab",
]);

/** Detect jq '.' file.json / yq '.' file.yaml as read-equivalents. */
function _parseJqRead(binary: string, args: string[]): BashIntent {
  const positionalArgs: string[] = [];
  let i = 0;
  while (i < args.length) {
    const a = args[i]!;
    if (_JQ_VALUE_FLAGS.has(a)) {
      i += 2; // skip the flag and its value
      continue;
    }
    if (a.startsWith("-")) {
      i += 1;
      continue;
    }
    positionalArgs.push(a);
    i += 1;
  }

  if (positionalArgs.length === 0) {
    return new BashIntent({
      kind: "unknown",
      reason: `${binary}: no filter or file argument`,
    });
  }

  const filterExpr = positionalArgs[0]!;
  if (!_JQ_TRIVIAL_FILTERS.has(filterExpr)) {
    return new BashIntent({
      kind: "unknown",
      reason: `${binary}: non-trivial filter '${filterExpr}' is not a read-equivalent`,
    });
  }

  const filePaths = positionalArgs.slice(1);
  if (filePaths.length === 0) {
    return new BashIntent({
      kind: "unknown",
      reason: `${binary}: trivial filter but no file argument (reads stdin)`,
    });
  }

  const validPaths = filePaths.filter((p) => !_isSystemPath(p));
  if (validPaths.length === 0) {
    return new BashIntent({
      kind: "unknown",
      reason: `${binary}: all file paths are system paths`,
    });
  }

  const intent = _buildReadIntent(validPaths[0]!);
  if (intent.kind === "read" && validPaths.length > 1) {
    intent.target_paths = validPaths;
  }
  return intent;
}

export const __all__ = ["BashIntent", "parse", "split_compound"];
