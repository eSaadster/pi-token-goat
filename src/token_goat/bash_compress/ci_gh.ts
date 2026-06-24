/**
 * bash_compress GITHUB-CLI / CI FILTERS — TypeScript port of the GitHub CLI and
 * CI-log Filter subclasses from src/token_goat/bash_compress.py.
 *
 * Six filters subclass the concrete Filter base from ./framework.js. They are
 * scattered across the Python source and ported here by NAME:
 *   - GhFilter         (~4839) — generic `gh` (GitHub CLI). `gh run view` step
 *                       collapse, `gh pr/run/issue list` row cap, base64 content
 *                       redaction. Overrides compress() directly.
 *   - GhRunLogFilter   (~5002) — `gh run view --log` raw GitHub Actions logs.
 *                       step-prefix + timestamp strip, group collapse, setup /
 *                       boilerplate / cleanup / command-echo drop. matches()
 *                       override; PRECEDES GhFilter in the registry (it claims
 *                       only `gh run view … --log`).
 *   - ActFilter        (~5172) — `act` (local GitHub Actions runner). job-prefix
 *                       strip, docker-pull + matrix collapse, status verbatim.
 *   - GenericCIFilter  (~5265) — catch-all for `--log` / `logs` / `pipeline` /
 *                       `workflow` commands (custom matches(), empty binaries).
 *                       timestamp + ANSI strip, DEBUG/heartbeat collapse.
 *   - GhCopilotFilter  (~22489) — `gh copilot explain` / `suggest`. spinner /
 *                       banner / disclaimer drop. error_passthrough = true;
 *                       matches() override; PRECEDES GhFilter for `gh copilot …`.
 *   - CopilotFilter    (~22575) — standalone `copilot` binary (explain / suggest /
 *                       workspace). same noise classes + workspace + token stats.
 *                       error_passthrough = true; matches() override.
 *
 * Registry ordering (GhRunLog / GhCopilot BEFORE the generic Gh; Copilot claims
 * only the bare `copilot` stem) is wired by the barrel one level up (out of scope
 * here); this module ports each class's matches() / detection logic verbatim.
 *
 * ---------------------------------------------------------------------------
 * Parity notes (Python -> TS)
 * ---------------------------------------------------------------------------
 *  - Python identifiers preserved EXACTLY: PascalCase class names; snake_case
 *    methods/fields (matches, compress, _compress_body); snake_case module
 *    helpers (_redact_gh_base64_content, _compress_gh_run_view, _compress_gh_list);
 *    snake_case module-private regex constants (_GH_RUN_*, _GH_LOG_*, _ACT_*,
 *    _CI_*, _GH_COPILOT_*, _COPILOT_*, _GH_CONTENT_B64_RE, _GH_BASE64_MIN_LEN).
 *  - re.compile(...) -> top-level RegExp compiled once at module load. IGNORECASE
 *    -> "i". Python re.Pattern.match(line) is anchored at the START (not
 *    end-anchored); emulated via _reMatch (non-global clone + index===0).
 *    .search() -> _reSearch (non-global clone, .test anywhere). Named capture
 *    groups (?P<job> / ?P<body>) -> JS (?<job> / ?<body>) read off groups.
 *  - Path(argv[0].replace("\\","/")).stem.lower() / .name.lower() -> local
 *    _pathStemLower / _pathNameLower (final path component after backslash norm,
 *    last suffix stripped for stem, lowercased) — matching framework _pathStem/Name.
 *  - Framework helpers: Filter, _positional_args, _maybe_note, _strip_timestamps,
 *    _squeeze_blank_lines are framework-PUBLIC and imported from ./framework.js.
 *    _ERROR_SIGNAL_RE is framework-PRIVATE (not exported there); it is re-declared
 *    MODULE-PRIVATE here (NOT exported) to avoid a duplicate-export ambiguity
 *    across the barrel export* chain.
 *  - Filter._emit_notes / Filter._finalize are static framework methods invoked as
 *    Filter._emit_notes(...) / Filter._finalize(...) (matching the Python
 *    `Filter._emit_notes(...)` / `self._finalize(...)` calls).
 *  - _redact_gh_base64_content: json.loads -> JSON.parse; json.dumps(data,
 *    indent=2 if pretty else None) -> JSON.stringify(data, null, 2) for the pretty
 *    branch and a compact-with-", "/": "-separators serialiser (_pyCompactJson)
 *    for the non-pretty branch, matching Python's default json.dumps separators
 *    (item ", ", key ": "). base64 byte count via Buffer.from(val, "base64").
 *    Reported in parity_notes.
 *  - Module-global mutable state: NONE. Every per-call counter/list is a local
 *    inside compress()/_compress_body() or a module helper; no registerReset seam.
 *
 * NOTE on import depth: this file lives in the bash_compress/ SUBDIR; the
 * framework is a SIBLING (./framework.js). verbatimModuleSyntax is on -> nothing
 * imported here is type-only. noImplicitOverride is on -> every overridden member
 * carries `override`.
 */

import { Buffer } from "node:buffer";

import {
  Filter,
  _maybe_note,
  _positional_args,
  _squeeze_blank_lines,
  _strip_timestamps,
} from "./framework.js";

// ===========================================================================
// Internal Python-builtin / stdlib shims local to this module.
// ===========================================================================

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
 * Python re.Pattern.match(line) returning the match object (or null) for callers
 * that read capture groups. Anchored at the START: a non-anchored hit is treated
 * as no match.
 */
function _reMatchObj(re: RegExp, line: string): RegExpExecArray | null {
  const m = _nonGlobal(re).exec(line);
  return m !== null && m.index === 0 ? m : null;
}

/** Python re.Pattern.search(line) — boolean "matches anywhere". */
function _reSearch(re: RegExp, line: string): boolean {
  return _nonGlobal(re).test(line);
}

/**
 * Python Path(p).stem.lower() — the final path component (after normalising
 * backslashes to forward slashes) with its LAST suffix removed, lowercased.
 */
function _pathStemLower(p: string): string {
  const norm = p.replace(/\\/g, "/").replace(/\/+$/, "");
  const idx = norm.lastIndexOf("/");
  const name = idx >= 0 ? norm.slice(idx + 1) : norm;
  const dot = name.lastIndexOf(".");
  if (dot <= 0 || dot === name.length - 1) {
    return name.toLowerCase();
  }
  return name.slice(0, dot).toLowerCase();
}

/** Python Path(p).name.lower() — final path component (after backslash norm), lowercased. */
function _pathNameLower(p: string): string {
  const norm = p.replace(/\\/g, "/").replace(/\/+$/, "");
  const idx = norm.lastIndexOf("/");
  const name = idx >= 0 ? norm.slice(idx + 1) : norm;
  return name.toLowerCase();
}

// Framework-PRIVATE in framework.ts (not exported there). Re-declared
// MODULE-PRIVATE here (NOT exported) to avoid a duplicate-export ambiguity
// across the barrel export* chain.
// Python: re.compile(r"error:|Error:|ERROR|FAILED|failed|fatal:|Traceback
//   |exception:|Exception:|AssertionError|assert |panic:", re.IGNORECASE)
const _ERROR_SIGNAL_RE: RegExp =
  /error:|Error:|ERROR|FAILED|failed|fatal:|Traceback|exception:|Exception:|AssertionError|assert |panic:/i;

// ===========================================================================
// GitHub CLI (gh) — base64 content redaction + run-view / list compression.
// ===========================================================================

// `gh run view <id>` prints step-by-step CI logs with status glyphs (`✓` /
// `X` / `*`) per step, and long blocks of repeated noise like ``Run actions/...``
// preamble lines. We collapse passing step blocks, dedupe identical noise
// lines, and preserve every line that signals a failure.
const _GH_RUN_PASS_STEP_RE: RegExp = /^\s*[✓√]\s/;
const _GH_RUN_FAIL_STEP_RE: RegExp = /^\s*[X✗❌]\s|^\s*FAIL(:|ED|URE)\b|^\s*Error:\s/;

// Matches strings composed solely of base64 alphabet characters and newlines.
const _GH_CONTENT_B64_RE: RegExp = /^[A-Za-z0-9+/=\n]+$/;
// Minimum length for a value to be treated as base64 content (avoids false positives).
const _GH_BASE64_MIN_LEN = 200;

/**
 * Serialise a value the way Python's json.dumps(data) does with indent=None:
 * compact records using the default separators (", " between items, ": " between
 * key and value) — which differ from JSON.stringify's no-space default.
 */
function _pyCompactJson(value: unknown): string {
  if (value === null) {
    return "null";
  }
  if (typeof value === "number") {
    return String(value);
  }
  if (typeof value === "boolean") {
    return value ? "true" : "false";
  }
  if (typeof value === "string") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return "[" + value.map((v) => _pyCompactJson(v)).join(", ") + "]";
  }
  if (typeof value === "object") {
    const obj = value as Record<string, unknown>;
    const parts: string[] = [];
    for (const k of Object.keys(obj)) {
      parts.push(`${JSON.stringify(k)}: ${_pyCompactJson(obj[k])}`);
    }
    return "{" + parts.join(", ") + "}";
  }
  return JSON.stringify(value);
}

/**
 * Replace base64-encoded ``content`` fields in GitHub API JSON stdout.
 *
 * ``gh api repos/<owner>/<repo>/contents/<path>`` returns a JSON object with a
 * ``content`` key holding the raw base64-encoded file bytes. Those blobs are
 * enormous and useless in context. This helper detects and redacts them before
 * the output goes through the rest of the GhFilter pipeline.
 */
export function _redact_gh_base64_content(stdout: string): string {
  const stripped = stdout.trim();
  if (stripped === "" || (stripped[0] !== "{" && stripped[0] !== "[")) {
    return stdout;
  }
  let data: unknown;
  try {
    data = JSON.parse(stdout);
  } catch {
    return stdout;
  }

  const _is_b64_content = (val: unknown): boolean =>
    typeof val === "string" &&
    val.length > _GH_BASE64_MIN_LEN &&
    _reMatch(_GH_CONTENT_B64_RE, val);

  const _redact_obj = (obj: Record<string, unknown>): Record<string, unknown> => {
    const raw = obj["content"];
    if (!_is_b64_content(raw)) {
      return obj;
    }
    let n_bytes = 0;
    try {
      n_bytes = Buffer.from(raw as string, "base64").length;
    } catch {
      n_bytes = 0;
    }
    return { ...obj, content: `<base64 content: ${n_bytes} bytes decoded>` };
  };

  const _isPlainObject = (v: unknown): v is Record<string, unknown> =>
    typeof v === "object" && v !== null && !Array.isArray(v);

  let changed = false;
  if (_isPlainObject(data)) {
    const redacted = _redact_obj(data);
    changed = redacted !== data;
    data = redacted;
  } else if (Array.isArray(data)) {
    const new_list: unknown[] = [];
    for (const item of data) {
      const new_item = _isPlainObject(item) ? _redact_obj(item) : item;
      if (new_item !== item) {
        changed = true;
      }
      new_list.push(new_item);
    }
    if (changed) {
      data = new_list;
    }
  }

  if (!changed) {
    return stdout;
  }
  const pretty = stripped.includes("\n");
  return pretty ? JSON.stringify(data, null, 2) : _pyCompactJson(data);
}

/**
 * Collapse passing ``✓`` step headers in ``gh run view`` output.
 *
 * Keeps every line under a failing step and the final ``Annotations`` block;
 * drops the long lists of ``Run actions/foo@v1`` action-preamble lines that
 * appear under each passing step.
 */
export function _compress_gh_run_view(text: string): string {
  const lines = text.split("\n");
  const kept: string[] = [];
  let pass_steps = 0;
  let dropped_preamble = 0;
  // When True, we are inside a passing step block and should drop the indented
  // child lines (the action preamble) until the next non-indented line. Failing
  // steps are always preserved verbatim.
  let in_pass_block = false;
  for (const line of lines) {
    if (_reMatch(_GH_RUN_PASS_STEP_RE, line)) {
      pass_steps += 1;
      in_pass_block = true;
      continue;
    }
    if (_reMatch(_GH_RUN_FAIL_STEP_RE, line)) {
      in_pass_block = false;
      kept.push(line);
      continue;
    }
    if (in_pass_block && (line.startsWith("  ") || line.startsWith("\t"))) {
      dropped_preamble += 1;
      continue;
    }
    // A non-indented line closes any open pass block.
    if (line !== "" && !_isSpace(line[0]!)) {
      in_pass_block = false;
    }
    kept.push(line);
  }
  const notes: string[] = [];
  _maybe_note(notes, pass_steps, `collapsed ${pass_steps} passing step headers`);
  _maybe_note(notes, dropped_preamble, `dropped ${dropped_preamble} action-preamble lines`);
  Filter._emit_notes(kept, notes);
  return _squeeze_blank_lines(kept.join("\n"));
}

/** Python str.isspace() for a single char (the chars bash output carries). */
function _isSpace(c: string): boolean {
  return c === " " || c === "\t" || c === "\n" || c === "\r" || c === "\f" || c === "\v";
}

/**
 * Truncate ``gh pr/run/issue list`` output to first 30 rows + count.
 *
 * These commands produce tabular output where each row represents a distinct
 * resource. When listing many items, output can exceed 100 lines. We keep the
 * first 30 rows (preserving search ability for recent items) and emit a count
 * summary of remaining items.
 */
export function _compress_gh_list(text: string, subcommand: string): string {
  const lines = text.split("\n");
  // Find header line (usually the first non-empty line).
  let header_idx = 0;
  for (let i = 0; i < lines.length; i += 1) {
    if (lines[i]!.trim() !== "") {
      header_idx = i;
      break;
    }
  }
  // Count data rows (lines after header until blank or end).
  const data_start = header_idx + 1;
  let data_end = lines.length;
  for (let i = data_start; i < lines.length; i += 1) {
    if (lines[i]!.trim() === "") {
      data_end = i;
      break;
    }
  }
  const total_data_rows = data_end - data_start;
  const max_rows = 30;
  if (total_data_rows <= max_rows) {
    return _squeeze_blank_lines(text);
  }
  // Keep header + first N data rows.
  const kept_lines = [
    ...lines.slice(0, data_start),
    ...lines.slice(data_start, data_start + max_rows),
  ];
  const notes = [`showing first ${max_rows} of ${total_data_rows} ${subcommand}s`];
  Filter._emit_notes(kept_lines, notes);
  return _squeeze_blank_lines(kept_lines.join("\n"));
}

/**
 * Compress ``gh`` (GitHub CLI) output.
 *
 * `gh run view` collapses passing-step headers; `gh pr/run/issue list` truncates
 * to the first 30 rows + count; everything else passes through with blank-line
 * squeezing (after base64 content redaction).
 */
export class GhFilter extends Filter {
  override name = "gh";
  override binaries: ReadonlySet<string> = new Set(["gh"]);

  override compress(stdout: string, stderr: string, _exit_code: number, argv: string[]): string {
    stdout = _redact_gh_base64_content(stdout);
    const positionals = _positional_args(argv.slice(1));
    const subcommand = positionals.length > 0 ? positionals[0]! : "";
    const action = positionals.length > 1 ? positionals[1]! : "";
    const merged = this._combine_output(stdout, stderr);
    if (subcommand === "run" && action === "view") {
      return _compress_gh_run_view(merged);
    }
    if ((subcommand === "pr" || subcommand === "run" || subcommand === "issue") && action === "list") {
      return _compress_gh_list(merged, subcommand);
    }
    // Everything else passes through with just blank-line squeezing.
    return _squeeze_blank_lines(merged);
  }
}

// ===========================================================================
// GitHub Actions log (gh run view --log).
// ===========================================================================

// ISO-8601 timestamp prefix as emitted by ``gh run view --log``:
// ``2024-01-15T12:34:56.1234567Z ``
const _GH_LOG_TIMESTAMP_RE: RegExp = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d+Z\s?/;
// ``##[group]Step name`` / ``##[endgroup]``
const _GH_LOG_GROUP_RE: RegExp = /^##\[group\](.*)/;
const _GH_LOG_ENDGROUP_RE: RegExp = /^##\[endgroup\]/;
// ``##[command]echo "Hello"`` — command-echo lines emitted by the runner shell
// for every step command. They are purely structural noise: the agent already
// sees the command in the workflow YAML.
const _GH_LOG_COMMAND_RE: RegExp = /^##\[command\]/;
// ``gh run view --log`` output format: each line is prefixed with the step name
// followed by a TAB character before the timestamp. We strip everything up to
// and including the first tab so that the timestamp stripper can then remove the
// timestamp prefix normally.
const _GH_LOG_STEP_PREFIX_RE: RegExp = /^[^\t]+\t/;
// ``Run actions/checkout@v3`` setup lines (appear at the start of action runs).
const _GH_LOG_SETUP_ACTION_RE: RegExp = /^Run [a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+@/;
// Post-run cleanup steps emitted by the runner after the job.
const _GH_LOG_POST_STEP_RE: RegExp =
  /^Post job cleanup\.|^Cleaning up orphan processes|^Post Run /;
// Runner boilerplate lines.
const _GH_LOG_BOILERPLATE_RE: RegExp =
  /^Setting up runner|^Runner version |^Operating System\s+:\s|^Virtual Environment|^Prepare all required actions|^Getting action download info|^Download action repository|^Complete job name:/;
// Failure indicators — always keep verbatim.
const _GH_LOG_FAILURE_RE: RegExp =
  /error:|Error:|ERROR|FAILED|failed|##\[error\]|##\[warning\]|Process completed with exit code [^0]/i;

/**
 * Compress ``gh run view --log`` GitHub Actions raw log output.
 *
 * Strips the step-name TAB prefix and ISO-8601 timestamps; drops ``##[command]``
 * echo lines, boilerplate, and post-run cleanup; collapses oversized failure-free
 * ``##[group]`` bodies and setup-action runs; keeps every failure verbatim.
 */
export class GhRunLogFilter extends Filter {
  override name = "gh-run-log";
  override binaries: ReadonlySet<string> = new Set(["gh"]);

  override matches(argv: string[]): boolean {
    if (argv.length === 0) {
      return false;
    }
    const stem = _pathStemLower(argv[0]!);
    const name = _pathNameLower(argv[0]!);
    if (stem !== "gh" && name !== "gh") {
      return false;
    }
    const positionals = _positional_args(argv.slice(1));
    // Must be ``gh run view`` with ``--log`` flag.
    return (
      positionals.length >= 2 &&
      positionals[0] === "run" &&
      positionals[1] === "view" &&
      argv.includes("--log")
    );
  }

  override compress(stdout: string, stderr: string, _exit_code: number, _argv: string[]): string {
    const merged = this._combine_output(stdout, stderr);
    // ``gh run view --log`` prefixes each line with a step-name column separated
    // by a TAB from the timestamp. Strip that prefix first so the shared
    // timestamp stripper can find the ISO-8601 prefix normally.
    const raw_lines = merged.split("\n");
    const step_stripped = raw_lines.map((ln) => ln.replace(_nonGlobal(_GH_LOG_STEP_PREFIX_RE), ""));
    // Strip timestamp prefixes upfront using the shared helper so the rest of the
    // loop works on clean, prefix-free lines.
    const lines = _strip_timestamps(step_stripped);
    const kept: string[] = [];
    const setup_actions: string[] = [];
    let dropped_boilerplate = 0;
    let dropped_cleanup = 0;
    let dropped_commands = 0;
    let collapsed_groups = 0;

    // Group-collapse state.
    let in_group = false;
    let group_name = "";
    let group_lines: string[] = [];
    let group_has_failure = false;
    const GROUP_COLLAPSE_THRESHOLD = 20;

    const _flush_group = (): void => {
      if (group_lines.length === 0) {
        return;
      }
      if (group_has_failure || group_lines.length <= GROUP_COLLAPSE_THRESHOLD) {
        kept.push(...group_lines);
      } else {
        kept.push(
          `[group: ${group_name} — ${group_lines.length} lines collapsed by token-goat]`,
        );
        collapsed_groups += 1;
      }
    };

    for (const line of lines) {
      // Boilerplate — drop.
      if (_reMatch(_GH_LOG_BOILERPLATE_RE, line)) {
        dropped_boilerplate += 1;
        continue;
      }

      // Post-run cleanup — drop.
      if (_reMatch(_GH_LOG_POST_STEP_RE, line)) {
        dropped_cleanup += 1;
        continue;
      }

      // Command-echo lines (##[command]…) — pure noise; the agent can read the
      // workflow YAML for the command definition. Keep them when they contain a
      // failure signal (unusual but possible with error traps).
      if (_reMatch(_GH_LOG_COMMAND_RE, line) && !_reSearch(_GH_LOG_FAILURE_RE, line)) {
        dropped_commands += 1;
        continue;
      }

      // Group markers.
      const m_group = _reMatchObj(_GH_LOG_GROUP_RE, line);
      if (m_group) {
        // Flush any previous open group before starting a new one.
        _flush_group();
        in_group = true;
        group_name = m_group[1]!.trim();
        group_lines = [];
        group_has_failure = false;
        continue;
      }

      if (_reMatch(_GH_LOG_ENDGROUP_RE, line)) {
        _flush_group();
        in_group = false;
        group_lines = [];
        continue;
      }

      // Setup action lines ("Run actions/checkout@v3") — collect for summary.
      if (_reMatch(_GH_LOG_SETUP_ACTION_RE, line)) {
        setup_actions.push(line);
        continue;
      }

      // All other lines: if we're inside a group, buffer them.
      if (in_group) {
        if (_reSearch(_GH_LOG_FAILURE_RE, line)) {
          group_has_failure = true;
        }
        group_lines.push(line);
      } else {
        kept.push(line);
      }
    }

    // Flush any group that wasn't closed before EOF.
    _flush_group();

    // Emit setup actions summary.
    if (setup_actions.length > 0) {
      kept.push(`[token-goat: Setup: ${setup_actions.length} action(s) collapsed]`);
    }

    const notes: string[] = [];
    _maybe_note(notes, dropped_boilerplate, `dropped ${dropped_boilerplate} boilerplate lines`);
    _maybe_note(notes, dropped_commands, `dropped ${dropped_commands} ##[command] echo lines`);
    _maybe_note(notes, dropped_cleanup, `dropped ${dropped_cleanup} cleanup lines`);
    _maybe_note(notes, collapsed_groups, `collapsed ${collapsed_groups} log group(s)`);
    Filter._emit_notes(kept, notes);
    return Filter._finalize(kept);
  }
}

// ===========================================================================
// act (local GitHub Actions runner).
// ===========================================================================

// ``act`` log lines look like: ``[job-name/step-name]   | output here``
// or ``[job-name/step-name] ✅`` / ``[job-name/step-name] ❌``
const _ACT_JOB_PREFIX_RE: RegExp = /^\[(?<job>[^\]]+)\]\s+\|\s*(?<body>.*)/;
const _ACT_STATUS_RE: RegExp = /^\[(?<job>[^\]]+)\]\s+(?<status>[✅❌✓✗])/;
// Docker pull progress inside act (same shape as DockerFilter progress).
const _ACT_DOCKER_PULL_RE: RegExp =
  /^\[(?:[^\]]+)\]\s+\|\s*(?:Pulling |Waiting\s*$|Verifying |Extracting |Pull complete|Digest:|Status:|Unable to find image)/i;
// Verbose matrix expansion: ``[matrix: {"os": "ubuntu-latest", "node": "18"}]``
const _ACT_MATRIX_EXPAND_RE: RegExp = /^\[.*\]\s+Matrix:/;

/**
 * Compress ``act`` (local GitHub Actions runner) output.
 *
 * Strips the ``[job/step] | `` prefix from body lines, collapses docker-pull
 * progress and verbose matrix-expansion lines to counts, and keeps ``✅`` / ``❌``
 * status lines and every failure line verbatim.
 */
export class ActFilter extends Filter {
  override name = "act";
  override binaries: ReadonlySet<string> = new Set(["act"]);

  override compress(stdout: string, stderr: string, _exit_code: number, _argv: string[]): string {
    const merged = this._combine_output(stdout, stderr);
    const lines = merged.split("\n");
    const kept: string[] = [];
    let docker_pull_dropped = 0;
    const matrix_lines: string[] = [];

    for (const line of lines) {
      // Always keep status lines (✅ ❌) verbatim (they carry the prefix
      // intentionally to show which job passed/failed).
      if (_reMatch(_ACT_STATUS_RE, line)) {
        kept.push(line);
        continue;
      }

      // Docker pull progress — collapse.
      if (_reMatch(_ACT_DOCKER_PULL_RE, line)) {
        docker_pull_dropped += 1;
        continue;
      }

      // Matrix expansion lines — collect for summary.
      if (_reMatch(_ACT_MATRIX_EXPAND_RE, line)) {
        matrix_lines.push(line);
        continue;
      }

      // Strip ``[job/step] | `` prefix from body lines before further checks.
      const m = _reMatchObj(_ACT_JOB_PREFIX_RE, line);
      const body = m ? m.groups!["body"]! : line;

      // Failure lines — keep stripped body verbatim.
      if (_reSearch(_GH_LOG_FAILURE_RE, body)) {
        kept.push(body);
        continue;
      }

      kept.push(body);
    }

    const notes: string[] = [];
    _maybe_note(notes, docker_pull_dropped, `collapsed ${docker_pull_dropped} docker-pull progress lines`);
    _maybe_note(notes, matrix_lines.length, `collapsed ${matrix_lines.length} matrix expansion lines`);
    Filter._emit_notes(kept, notes);
    return Filter._finalize(kept);
  }
}

// ===========================================================================
// GenericCIFilter (catch-all for CI log patterns).
// ===========================================================================

// ISO-8601 or date-time-like timestamp prefix in generic CI/pipeline logs.
const _CI_TIMESTAMP_RE: RegExp = /^\[?\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:\.\d+)?Z?\]?\s+/;
// ANSI escape sequence (any CSI sequence or OSC sequence). Python: re.compile(
//   r"\x1b(?:\[[0-9;]*[mABCDEFGHJKSTf]|\](?:[^\x07\x1b]|\x1b[^\\])*(?:\x07|\x1b\\))").
// Global so .sub replaces every occurrence per line (matching Python re.sub).
const _CI_ANSI_RE: RegExp =
  /\x1b(?:\[[0-9;]*[mABCDEFGHJKSTf]|\](?:[^\x07\x1b]|\x1b[^\\])*(?:\x07|\x1b\\))/g;
// Heartbeat / ping / health-check log lines.
const _CI_HEARTBEAT_RE: RegExp = /\b(?:heartbeat|ping|health.?check|keepalive|keep.alive)\b/i;
// Log level prefixes.
const _CI_DEBUG_RE: RegExp = /^\s*(?:DEBUG|TRACE|VERBOSE)\b[\s:]/i;
const _CI_INFO_RE: RegExp = /^\s*INFO\b[\s:]/i;
// Keywords that trigger GenericCIFilter matching.
const _CI_COMMAND_KEYWORDS: ReadonlySet<string> = new Set([
  "--log",
  "logs",
  "pipeline",
  "workflow",
]);

/**
 * Catch-all filter for CI log patterns not covered by specific filters.
 *
 * Fires when the raw command contains any of: ``--log``, ``logs``, ``pipeline``,
 * ``workflow``. Strips timestamp + stray ANSI; collapses DEBUG/TRACE and
 * heartbeat/health-check lines to counts; keeps INFO and every failure verbatim.
 */
export class GenericCIFilter extends Filter {
  override name = "generic-ci";
  override binaries: ReadonlySet<string> = new Set<string>(); // Matched via custom matches() only.

  override matches(argv: string[]): boolean {
    if (argv.length === 0) {
      return false;
    }
    const cmd_str = argv.join(" ").toLowerCase();
    for (const kw of _CI_COMMAND_KEYWORDS) {
      if (cmd_str.includes(kw)) {
        return true;
      }
    }
    return false;
  }

  override compress(stdout: string, stderr: string, _exit_code: number, _argv: string[]): string {
    const merged = this._combine_output(stdout, stderr);
    // Strip timestamp prefixes upfront using the shared helper.
    const lines = _strip_timestamps(merged.split("\n"));
    const kept: string[] = [];
    let debug_count = 0;
    let heartbeat_count = 0;

    for (let line of lines) {
      // Strip stray ANSI escapes (non-interactive CI output). _CI_ANSI_RE is
      // global; String.replace with a global regex ignores lastIndex, so reusing
      // the shared instance is safe.
      line = line.replace(_CI_ANSI_RE, "");

      // Always keep failure lines.
      if (_reSearch(_GH_LOG_FAILURE_RE, line)) {
        kept.push(line);
        continue;
      }

      // Heartbeat / health-check lines — collapse.
      if (_reSearch(_CI_HEARTBEAT_RE, line)) {
        heartbeat_count += 1;
        continue;
      }

      // DEBUG / TRACE — collapse to count.
      if (_reMatch(_CI_DEBUG_RE, line)) {
        debug_count += 1;
        continue;
      }

      kept.push(line);
    }

    const notes: string[] = [];
    _maybe_note(notes, debug_count, `collapsed ${debug_count} DEBUG/TRACE lines`);
    _maybe_note(notes, heartbeat_count, `collapsed ${heartbeat_count} heartbeat/health-check lines`);
    Filter._emit_notes(kept, notes);
    return Filter._finalize(kept);
  }
}

// ===========================================================================
// gh copilot / standalone copilot.
// ===========================================================================

// gh copilot "Explanation:" section header
const _GH_COPILOT_EXPLAIN_HDR_RE: RegExp =
  /^\s*(?:Explanation\s*:|Welcome to GitHub Copilot)/i;
// gh copilot disclaimer / legal lines
const _GH_COPILOT_DISCLAIMER_RE: RegExp =
  /^\s*(?:Disclaimer:|This response was|GitHub Copilot|The commands?\s+(?:above|below)|Please review|Always review|Remember to|Note:|Tip:)/i;
// gh copilot spinner/progress lines
const _GH_COPILOT_SPINNER_RE: RegExp =
  /^\s*(?:Asking GitHub Copilot|Generating|Thinking|Fetching)\s*\.{0,3}\s*$/i;
// gh copilot / standalone copilot banner lines. Matches "Welcome to GitHub
// Copilot in the CLI", "Using GitHub Copilot", "Authenticated as: …", and the
// standalone binary's "GitHub Copilot v1.x.x" line.
const _GH_COPILOT_BANNER_RE: RegExp =
  /^\s*(?:Welcome to GitHub Copilot|Using GitHub Copilot|Authenticated as|GitHub Copilot\s+v\d+)/i;

/**
 * Compress ``gh copilot explain`` and ``gh copilot suggest`` output.
 *
 * Drops spinner/progress, welcome/auth banner, and disclaimer/review footer
 * lines; keeps the actual explanation/suggestion body and every error line
 * verbatim. error_passthrough = true (non-zero exit preserves raw stderr).
 */
export class GhCopilotFilter extends Filter {
  override error_passthrough = true;
  override name = "gh-copilot";
  override binaries: ReadonlySet<string> = new Set(["gh"]);

  override matches(argv: string[]): boolean {
    if (argv.length === 0) {
      return false;
    }
    const stem = _pathStemLower(argv[0]!);
    const name = _pathNameLower(argv[0]!);
    if (stem !== "gh" && name !== "gh") {
      return false;
    }
    const positionals = _positional_args(argv.slice(1));
    // Must be ``gh copilot explain`` or ``gh copilot suggest``.
    return (
      positionals.length >= 2 &&
      positionals[0] === "copilot" &&
      (positionals[1] === "explain" || positionals[1] === "suggest")
    );
  }

  override _compress_body(stdout: string, stderr: string, _exit_code: number, _argv: string[]): string {
    const combined = this._combine_output(stdout, stderr);
    const lines = combined.split("\n");
    const kept: string[] = [];
    let dropped_noise = 0;

    for (const line of lines) {
      // Error signals — always keep.
      if (_reSearch(_ERROR_SIGNAL_RE, line)) {
        kept.push(line);
        continue;
      }
      // Spinner / progress lines — drop.
      if (_reMatch(_GH_COPILOT_SPINNER_RE, line)) {
        dropped_noise += 1;
        continue;
      }
      // Welcome/auth banners — drop.
      if (_reMatch(_GH_COPILOT_BANNER_RE, line)) {
        dropped_noise += 1;
        continue;
      }
      // Disclaimer/review footers — drop.
      if (_reMatch(_GH_COPILOT_DISCLAIMER_RE, line)) {
        dropped_noise += 1;
        continue;
      }
      kept.push(line);
    }

    const notes: string[] = [];
    _maybe_note(notes, dropped_noise, `dropped ${dropped_noise} boilerplate/disclaimer line(s)`);
    Filter._emit_notes(kept, notes);
    return Filter._finalize(kept);
  }
}

// copilot workspace mode startup/loading noise lines
const _COPILOT_WORKSPACE_NOISE_RE: RegExp =
  /^\s*(?:Starting\s+Copilot\s+workspace|Loading\s+model:|Copilot\s+workspace\s+(?:starting|loaded|ready)|Streaming\.\.\.|▌\s*$|Turn\s+\d+\s*:)/i;
// copilot workspace mode completion/prompt token stats
const _COPILOT_COMPLETION_STATS_RE: RegExp =
  /^\s*(?:Completion\s+tokens:|Prompt\s+tokens:|Total\s+tokens:|Input\s+tokens:|Output\s+tokens:)\s*\d/i;

/**
 * Compress output from the standalone ``copilot`` binary.
 *
 * Same boilerplate classes as :class:`GhCopilotFilter` plus workspace-mode
 * startup noise (collapsed) and completion/token stats (summarised as a
 * last-seen note). Does NOT match ``gh copilot …`` (the bare ``copilot`` stem
 * only). error_passthrough = true.
 */
export class CopilotFilter extends Filter {
  override error_passthrough = true;
  override name = "copilot";
  override binaries: ReadonlySet<string> = new Set(["copilot"]);

  override matches(argv: string[]): boolean {
    if (argv.length === 0) {
      return false;
    }
    const stem = _pathStemLower(argv[0]!);
    return stem === "copilot";
  }

  override _compress_body(stdout: string, stderr: string, _exit_code: number, _argv: string[]): string {
    const combined = this._combine_output(stdout, stderr);
    const lines = combined.split("\n");
    const kept: string[] = [];
    const stat_lines: string[] = [];
    let dropped_noise = 0;

    for (const line of lines) {
      // Error signals — always keep.
      if (_reSearch(_ERROR_SIGNAL_RE, line)) {
        kept.push(line);
        continue;
      }
      // Workspace startup/loading noise — drop.
      if (_reMatch(_COPILOT_WORKSPACE_NOISE_RE, line)) {
        dropped_noise += 1;
        continue;
      }
      // Completion/prompt token stats — accumulate for summary note.
      if (_reMatch(_COPILOT_COMPLETION_STATS_RE, line)) {
        stat_lines.push(line.trim());
        continue;
      }
      // Spinner / progress lines — drop.
      if (_reMatch(_GH_COPILOT_SPINNER_RE, line)) {
        dropped_noise += 1;
        continue;
      }
      // Version/auth banners — drop.
      if (_reMatch(_GH_COPILOT_BANNER_RE, line)) {
        dropped_noise += 1;
        continue;
      }
      // Disclaimer/review footers — drop.
      if (_reMatch(_GH_COPILOT_DISCLAIMER_RE, line)) {
        dropped_noise += 1;
        continue;
      }
      kept.push(line);
    }

    const notes: string[] = [];
    if (stat_lines.length > 0) {
      notes.push(`stats: ${stat_lines[stat_lines.length - 1]!}`);
    }
    _maybe_note(notes, dropped_noise, `dropped ${dropped_noise} boilerplate/disclaimer line(s)`);
    Filter._emit_notes(kept, notes);
    return Filter._finalize(kept);
  }
}
