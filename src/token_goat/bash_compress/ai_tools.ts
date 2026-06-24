/**
 * bash_compress AI-TOOLING FILTERS — TypeScript port of the AiderFilter,
 * GeminiCliFilter, ClaudeCliFilter, CursorFilter, WindsurfFilter,
 * OpenCodeFilter, ContinueFilter, ClineFilter, and CodexExecFilter Filter
 * subclasses from src/token_goat/bash_compress.py (plus the module-level
 * _AIDER_*, _GEMINI_*, _CLAUDE_CLI_*, _CURSOR_*, _WINDSURF_*, _OPENCODE_*,
 * _CONTINUE_*, _CLINE_*, _CODEX_* regexes).
 *
 * Nine filters subclass the concrete Filter base from ./framework.js. Each one
 * sets error_passthrough = true and overrides _compress_body (NOT compress):
 * the Filter.compress template method short-circuits to the raw combined error
 * output when the command exits non-zero and stderr is non-empty, so the body
 * compressor only runs on successful invocations.
 *
 *   - AiderFilter    — `aider` terminal AI coding assistant. Collapses token/
 *                      cost lines to last-seen, counts "Applying edits"
 *                      spinners, drops repo-map/banner/footer noise, keeps
 *                      diffs and errors.
 *   - GeminiCliFilter — `gemini` (Google Gemini CLI). Counts startup-status +
 *                      tool-call spinner lines, keeps last token-usage meter,
 *                      drops banner/thinking/footer noise.
 *   - ClaudeCliFilter — `claude` (Claude Code CLI). Drops session headers +
 *                      spinners + footers, counts tool-call log lines, keeps
 *                      last stats + context meter. Overrides matches() to
 *                      skip install/update/doctor/config/login/logout.
 *   - CursorFilter   — `cursor` (Cursor AI editor CLI). Drops extension-host
 *                      startup, telemetry, and version-banner noise.
 *   - WindsurfFilter — `windsurf` (Codeium Windsurf editor CLI). Drops VS Code
 *                      startup + Codeium activation + Cascade status/spinner +
 *                      workspace-loading noise, counts Cascade tool-call
 *                      lines, keeps last context meter.
 *   - OpenCodeFilter — `opencode` AI CLI. Drops banner/spinner/session-save
 *                      noise, counts tool-call/result arrows, keeps last
 *                      provider/model/context.
 *   - ContinueFilter — `continue` (Continue.dev CLI). Counts indexing-progress
 *                      lines, drops model-load/config/banner noise, keeps last
 *                      token-stats line.
 *   - ClineFilter    — `cline` / `claude-dev`. Drops banner/spinner/startup/
 *                      MCP-status noise, counts file-read progress lines, keeps
 *                      last tokens/cost/context, always keeps "Cline wants to
 *                      execute:" approval requests.
 *   - CodexExecFilter — `codex` (OpenAI Codex CLI). Parses the banner /
 *                      separator / config / separator / transcript structure,
 *                      extracts the model + token count + the final codex
 *                      answer body; passes through unrecognised formats.
 *
 * ---------------------------------------------------------------------------
 * Parity notes (Python -> TS)
 * ---------------------------------------------------------------------------
 *  - Python identifiers preserved EXACTLY: PascalCase class names; snake_case
 *    methods/fields (matches, _compress_body, subcommands); snake_case
 *    module-private regex constants (_AIDER_*, _GEMINI_*, _CLAUDE_CLI_*,
 *    _CURSOR_*, _WINDSURF_*, _OPENCODE_*, _CONTINUE_*, _CLINE_*, _CODEX_*).
 *  - re.compile(...) -> top-level RegExp compiled once at module load.
 *    re.IGNORECASE -> "i" flag. The ClaudeCli spinner regex and the
 *    Gemini/Cline/opencode spinner regexes intentionally omit "i" where the
 *    Python source omits it (case-sensitive on box-drawing / arrow runs).
 *  - Python re.Pattern.match(line) is START-anchored (NOT end-anchored);
 *    emulated via _reMatch (non-global clone + index===0). .search() ->
 *    _reSearch (non-global clone, .exec anywhere). Named capture group
 *    (?P<model>...) -> (?<model>...), read via _reMatchObj(...).groups["model"].
 *  - _ERROR_SIGNAL_RE is framework-PRIVATE (not exported by framework.ts); it
 *    is re-declared MODULE-PRIVATE here (NOT exported) to avoid a
 *    duplicate-export ambiguity (TS2308) across the barrel export * chain.
 *  - Path(argv[0]).stem.lower() -> local _pathStemLower (final path component
 *    with last suffix stripped, backslash-normalised, lowercased) — mirrors the
 *    framework's _pathStem semantics.
 *  - _positional_args / _maybe_note are framework-PUBLIC and imported.
 *    _combine_output is an INSTANCE method; _finalize / _emit_notes are STATIC
 *    methods on Filter.
 *  - error_passthrough = true + override _compress_body: the Python classes
 *    define `def _compress_body(...)` and rely on the base Filter.compress
 *    template method to short-circuit on (exit_code != 0 AND stderr). The TS
 *    Filter.compress (framework.ts line 1555) does exactly this, so each class
 *    sets `override error_passthrough = true` and `override _compress_body`.
 *  - Python `line.strip()` -> local _strip; str.casefold() == "codex" ->
 *    line.trim().toLowerCase() === "codex".
 *  - Module-global mutable state: NONE. Every counter/list is a local inside
 *    _compress_body(); no registerReset seam is needed.
 *
 * detect_from_command gating (per filter, after _strip_prefixes / matches):
 *  - aider       : binaries {aider}; stem == aider.
 *  - gemini-cli  : binaries {gemini}; stem == gemini.
 *  - claude-cli  : binaries {claude}; stem == claude AND first positional NOT
 *                  in {install, update, doctor, config, login, logout}.
 *  - cursor      : binaries {cursor}; stem == cursor.
 *  - windsurf    : binaries {windsurf}; stem == windsurf.
 *  - opencode    : binaries {opencode}; stem == opencode.
 *  - continue    : binaries {continue}; stem == continue.
 *  - cline       : binaries {cline, claude-dev}; stem in that set.
 *  - codex-exec  : binaries {codex}; stem == codex.
 *
 * NOTE on import depth: this file lives in the bash_compress/ SUBDIR; the
 * framework is a SIBLING (./framework.js). verbatimModuleSyntax is on ->
 * nothing imported here is type-only. noImplicitOverride is on -> every
 * overridden member carries `override`.
 */

import { Filter, _maybe_note, _positional_args } from "./framework.js";

// ===========================================================================
// Internal Python-builtin / stdlib shims local to this module.
// ===========================================================================

/** Python str.strip() — strip leading and trailing whitespace. */
function _strip(s: string): string {
  return s.replace(/^\s+/u, "").replace(/\s+$/u, "");
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
 * Python re.Pattern.match(line) returning the match object (or null) for the
 * callers that read capture groups. Non-global clone so lastIndex never leaks;
 * index===0 enforces the START-anchored semantics of .match().
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
 * Python pathlib.Path(s.replace("\\","/")).stem.lower() — the lowercased final
 * path component with its LAST suffix removed. Matches framework._pathStem
 * semantics (a leading-dot dotfile keeps its name; a trailing dot is not a
 * suffix).
 */
function _pathStemLower(s: string): string {
  const norm = s.replace(/\\/g, "/").replace(/\/+$/, "");
  const idx = norm.lastIndexOf("/");
  const name = idx >= 0 ? norm.slice(idx + 1) : norm;
  const dot = name.lastIndexOf(".");
  if (dot <= 0 || dot === name.length - 1) {
    return name.toLowerCase();
  }
  return name.slice(0, dot).toLowerCase();
}

// ===========================================================================
// Module-private framework regex re-declared here (framework does NOT export
// _ERROR_SIGNAL_RE — re-exporting it would create a TS2308 ambiguity).
// ===========================================================================

/** Python _ERROR_SIGNAL_RE (framework-private) — re-declared module-private. */
const _ERROR_SIGNAL_RE: RegExp =
  /error:|Error:|ERROR|FAILED|failed|fatal:|Traceback|exception:|Exception:|AssertionError|assert |panic:/i;

// ===========================================================================
// aider regexes (Python ~22331-22367)
// ===========================================================================

/** aider "Applying edits to …" / "Applied edit to …" progress spinner. */
const _AIDER_APPLYING_RE: RegExp =
  /^\s*(?:Applying\s+edit(?:s)?(?:\s+to\s+\S+)?|Applied\s+edit\s+to\s+\S+)\s*\.{0,3}\s*$/i;
/** aider token usage line: "Tokens: 1234 sent, 567 received.". */
const _AIDER_TOKENS_RE: RegExp =
  /^\s*Tokens:\s+\d[\d,]*\s+sent,\s+\d[\d,]*\s+received/i;
/** aider cost line: "Cost: $0.0012 message, $0.0034 session.". */
const _AIDER_COST_RE: RegExp =
  /^\s*Cost:\s+\$[\d.]+\s+message,\s+\$[\d.]+\s+session/i;
/** aider repo-map / context-loading noise. */
const _AIDER_REPOMAP_RE: RegExp =
  /^\s*(?:Repo-map:|Added\s+\S+\s+to\s+the\s+chat|Removed\s+\S+\s+from\s+the\s+chat|Loading\s+repo\s+map|Updating\s+repo\s+map|Scanning\s+repo\s+contents|Using\s+\d+\s+tokens\s+of\s+repo\s+map)/i;
/** aider "aider v1.x.x" version banner. */
const _AIDER_BANNER_RE: RegExp = /^\s*aider\s+v\d+\.\d+/i;
/** aider "Use ctrl-c" / "Run with --help" footer noise. */
const _AIDER_FOOTER_NOISE_RE: RegExp =
  /^\s*(?:Use\s+ctrl-c|Run\s+with\s+--help|You\s+can\s+skip\s+this|Tip:|Note:)/i;
/** aider diff/edit block start: "Applied edits to N file(s):" or "Diff:". */
const _AIDER_DIFF_HEADER_RE: RegExp =
  /^\s*(?:Applied\s+edits?\s+to\s+\d+\s+file|Diff\s*:)/i;

// ===========================================================================
// AiderFilter (Python ~22370-22460)
// ===========================================================================

/**
 * Compress `aider` terminal AI coding assistant output.
 *
 * aider emits verbose output for every AI edit session: token usage and cost
 * per message, repo-map loading progress, "applying edits" spinners, version
 * banners, and footer tips. The useful content is the actual edit summary
 * (diffs applied, errors, warnings).
 *
 * Token/cost lines collapse to a single last-seen summary; "Applying edits"
 * progress lines collapse to a count; repo-map / banner / footer noise is
 * dropped; diff headers and error lines are always kept. Errors (exit_code != 0
 * with stderr) short-circuit to raw combined output via error_passthrough.
 */
export class AiderFilter extends Filter {
  override error_passthrough = true;

  override name = "aider";
  override binaries: ReadonlySet<string> = new Set(["aider"]);
  override subcommands: ReadonlySet<string> = new Set<string>();

  override matches(argv: string[]): boolean {
    if (argv.length === 0) {
      return false;
    }
    return _pathStemLower(argv[0]!) === "aider";
  }

  override _compress_body(
    stdout: string,
    stderr: string,
    _exit_code: number,
    _argv: string[],
  ): string {
    const combined = this._combine_output(stdout, stderr);
    const lines = combined.split("\n");
    const kept: string[] = [];
    const token_lines: string[] = [];
    const cost_lines: string[] = [];
    let applying_count = 0;
    let dropped_noise = 0;

    for (const line of lines) {
      // Error signals — always keep.
      if (_reSearch(_ERROR_SIGNAL_RE, line)) {
        kept.push(line);
        continue;
      }
      // Token usage lines — accumulate for summary.
      if (_reMatch(_AIDER_TOKENS_RE, line)) {
        token_lines.push(_strip(line));
        continue;
      }
      // Cost lines — accumulate for summary.
      if (_reMatch(_AIDER_COST_RE, line)) {
        cost_lines.push(_strip(line));
        continue;
      }
      // Applying edits progress — count.
      if (_reMatch(_AIDER_APPLYING_RE, line)) {
        applying_count += 1;
        continue;
      }
      // Repo-map noise — drop.
      if (_reMatch(_AIDER_REPOMAP_RE, line)) {
        dropped_noise += 1;
        continue;
      }
      // Version banner and footer tips — drop.
      if (_reMatch(_AIDER_BANNER_RE, line) || _reMatch(_AIDER_FOOTER_NOISE_RE, line)) {
        dropped_noise += 1;
        continue;
      }
      // Diff headers — always keep.
      if (_reMatch(_AIDER_DIFF_HEADER_RE, line)) {
        kept.push(line);
        continue;
      }
      kept.push(line);
    }

    const out: string[] = [];
    if (applying_count) {
      out.push(
        `[token-goat: ${applying_count} 'applying edits' progress line(s) collapsed; ` +
          "disable via TOKEN_GOAT_BASH_COMPRESS for full output]",
      );
    }
    out.push(...kept);

    const notes: string[] = [];
    if (token_lines.length > 0) {
      // Emit last token usage line (most recent = current session total).
      notes.push(`token usage: ${token_lines[token_lines.length - 1]!}`);
    }
    if (cost_lines.length > 0) {
      notes.push(`cost: ${cost_lines[cost_lines.length - 1]!}`);
    }
    _maybe_note(notes, dropped_noise, `dropped ${dropped_noise} noise line(s)`);
    Filter._emit_notes(out, notes);
    return Filter._finalize(out);
  }
}

// ===========================================================================
// gemini (Google Gemini CLI) regexes (Python ~22660-22688)
// ===========================================================================

/** Gemini CLI "✓ Model: …" / "✓ Theme: …" startup status lines. */
const _GEMINI_STARTUP_RE: RegExp =
  /^\s*(?:[✓✗►]|>)\s*(?:Model:|Theme:|Tools:|Sandbox:|Checkpointing:|Context(?:\s+limit)?:|Version:|Authenticated(?:\s+as)?:|Connecting)/i;
/** Gemini CLI "Gemini CLI vN.N.N" version banner. */
const _GEMINI_BANNER_RE: RegExp = /^\s*Gemini\s+CLI\s+v\d+/i;
/** Gemini CLI "Token usage: X / Y (Z%)" context meter. */
const _GEMINI_TOKEN_METER_RE: RegExp =
  /^\s*(?:Token\s+usage|Context|Tokens):\s+[\d,]+\s*\/\s*[\d,]+/i;
/**
 * Gemini CLI tool-call spinner: "⠋ Calling run_shell_command…" /
 * "✓ Called read_file". Case-sensitive (matches Python: no IGNORECASE).
 */
const _GEMINI_TOOL_SPINNER_RE: RegExp =
  /^\s*(?:[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏✓✗►✦])\s+(?:Call(?:ing|ed)|Execut(?:ing|ed)|Running)\s+\S+/;
/** Gemini CLI "Type /help for commands" footer. */
const _GEMINI_FOOTER_RE: RegExp = /^\s*(?:Type\s+\/help|Press\s+Ctrl|Use\s+Ctrl|Tip:|Note:)/i;
/** Gemini CLI "Thinking…" / "Generating…" spinner text line. */
const _GEMINI_THINKING_RE: RegExp = /^\s*(?:Thinking|Generating|Processing)\s*\.{0,3}\s*$/i;

// ===========================================================================
// GeminiCliFilter (Python ~22691-22783)
// ===========================================================================

/**
 * Compress `gemini` (Google Gemini CLI) command output.
 *
 * Startup status blocks (model, theme, tools, context) collapse to a count;
 * the version banner, "Thinking…"/"Generating…" spinners, and footer tips are
 * dropped; token-usage meters are kept as the last seen value; tool-call
 * spinner lines collapse to a count. The actual AI response body is kept
 * verbatim. Errors short-circuit to raw output via error_passthrough.
 */
export class GeminiCliFilter extends Filter {
  override error_passthrough = true;

  override name = "gemini-cli";
  override binaries: ReadonlySet<string> = new Set(["gemini"]);
  override subcommands: ReadonlySet<string> = new Set<string>();

  override matches(argv: string[]): boolean {
    if (argv.length === 0) {
      return false;
    }
    return _pathStemLower(argv[0]!) === "gemini";
  }

  override _compress_body(
    stdout: string,
    stderr: string,
    _exit_code: number,
    _argv: string[],
  ): string {
    const combined = this._combine_output(stdout, stderr);
    const lines = combined.split("\n");
    const kept: string[] = [];
    let startup_count = 0;
    let tool_spinner_count = 0;
    let last_token_meter: string | null = null;
    let dropped_noise = 0;

    for (const line of lines) {
      // Error signals — always keep.
      if (_reSearch(_ERROR_SIGNAL_RE, line)) {
        kept.push(line);
        continue;
      }
      // Version banner — drop.
      if (_reMatch(_GEMINI_BANNER_RE, line)) {
        dropped_noise += 1;
        continue;
      }
      // Startup status lines — count.
      if (_reMatch(_GEMINI_STARTUP_RE, line)) {
        startup_count += 1;
        continue;
      }
      // Token-usage meter — keep last seen.
      if (_reMatch(_GEMINI_TOKEN_METER_RE, line)) {
        last_token_meter = _strip(line);
        continue;
      }
      // Tool-call spinners — count.
      if (_reMatch(_GEMINI_TOOL_SPINNER_RE, line)) {
        tool_spinner_count += 1;
        continue;
      }
      // "Thinking…" / "Generating…" spinners — drop.
      if (_reMatch(_GEMINI_THINKING_RE, line)) {
        dropped_noise += 1;
        continue;
      }
      // Footer tips — drop.
      if (_reMatch(_GEMINI_FOOTER_RE, line)) {
        dropped_noise += 1;
        continue;
      }
      kept.push(line);
    }

    const out: string[] = [];
    if (startup_count) {
      out.push(
        `[token-goat: ${startup_count} Gemini CLI startup status line(s) collapsed; ` +
          "disable via TOKEN_GOAT_BASH_COMPRESS for full output]",
      );
    }
    if (tool_spinner_count) {
      out.push(`[token-goat: ${tool_spinner_count} tool-call spinner line(s) collapsed]`);
    }
    out.push(...kept);

    const notes: string[] = [];
    _maybe_note(notes, last_token_meter, `context: ${last_token_meter}`);
    _maybe_note(notes, dropped_noise, `dropped ${dropped_noise} noise line(s)`);
    Filter._emit_notes(out, notes);
    return Filter._finalize(out);
  }
}

// ===========================================================================
// claude CLI (Claude Code) regexes (Python ~22788-22815)
// ===========================================================================

/** claude CLI "◆ claude-sonnet-4-5 (API)" / "◇ claude-opus" session header. */
const _CLAUDE_CLI_MODEL_HDR_RE: RegExp = /^\s*(?:[◆◇►✦])\s+claude-/i;
/**
 * claude CLI token/cost stats line: "↑ 1234 ↓ 567 tokens · $0.0012".
 * Case-insensitive (matches Python: re.IGNORECASE — the "tokens" label may be
 * upper- or lower-case).
 */
const _CLAUDE_CLI_STATS_RE: RegExp =
  /^\s*[↑↓⇑⇓]\s*\d[\d,]*\s*[↑↓⇑⇓]?\s*\d[\d,]*\s*tokens/i;
/** claude CLI "Token limit: X / Y (Z%)" context meter. */
const _CLAUDE_CLI_CONTEXT_RE: RegExp =
  /^\s*(?:Context(?:\s+window)?|Token\s+limit):\s+[\d,]+\s*\/\s*[\d,]+/i;
/** claude CLI "Press Ctrl-C" / "Enter / to show menu" footer. */
const _CLAUDE_CLI_FOOTER_RE: RegExp =
  /^\s*(?:Press\s+Ctrl|Enter\s+\/|Type\s+\/|Use\s+Ctrl|Tip:|Note:)/i;
/**
 * claude CLI "◎ Thinking…" / "◎ Generating…" spinner. Case-sensitive (matches
 * Python: no IGNORECASE — the spinner glyph + verb are fixed-case).
 */
const _CLAUDE_CLI_SPINNER_RE: RegExp =
  /^\s*(?:[◎⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏])\s+(?:Thinking|Generating|Processing|Running)\s*\.{0,3}\s*$/;
/** claude CLI "> Using tool:" / "✓ Tool result:" tool call lines. */
const _CLAUDE_CLI_TOOL_LOG_RE: RegExp =
  /^\s*(?:>\s+Using\s+tool:|✓\s+Tool\s+result:|◎\s+Tool:)/i;

// ===========================================================================
// ClaudeCliFilter (Python ~22818-22913)
// ===========================================================================

/**
 * Compress `claude` (Claude Code CLI) terminal output.
 *
 * Session headers (model name) are dropped; token/cost stat lines and
 * context-window meters are kept as the last seen value per run; "Thinking…"
 * spinners and footer tips are dropped; tool-call log lines collapse to a
 * count. The actual AI response body is kept verbatim. matches() skips the
 * install/update/doctor/config/login/logout subcommands (different output).
 * Errors short-circuit to raw output via error_passthrough.
 */
export class ClaudeCliFilter extends Filter {
  override error_passthrough = true;

  override name = "claude-cli";
  override binaries: ReadonlySet<string> = new Set(["claude"]);
  override subcommands: ReadonlySet<string> = new Set<string>();

  override matches(argv: string[]): boolean {
    if (argv.length === 0) {
      return false;
    }
    const stem = _pathStemLower(argv[0]!);
    // Only match the `claude` binary invoked with no subcommands or with
    // `--print` / `-p` (non-interactive single-turn mode). Avoid claiming
    // claude-related sub-tools (claude-code, etc.) unless the stem is exactly
    // "claude".
    if (stem !== "claude") {
      return false;
    }
    // Skip installation/setup subcommands that produce different output.
    const positionals = _positional_args(argv.slice(1));
    const skip_subcmds = new Set(["install", "update", "doctor", "config", "login", "logout"]);
    return !(positionals.length > 0 && skip_subcmds.has(positionals[0]!));
  }

  override _compress_body(
    stdout: string,
    stderr: string,
    _exit_code: number,
    _argv: string[],
  ): string {
    const combined = this._combine_output(stdout, stderr);
    const lines = combined.split("\n");
    const kept: string[] = [];
    let tool_log_count = 0;
    let last_stats: string | null = null;
    let last_context: string | null = null;
    let dropped_noise = 0;

    for (const line of lines) {
      // Error signals — always keep.
      if (_reSearch(_ERROR_SIGNAL_RE, line)) {
        kept.push(line);
        continue;
      }
      // Session header — drop.
      if (_reMatch(_CLAUDE_CLI_MODEL_HDR_RE, line)) {
        dropped_noise += 1;
        continue;
      }
      // Token/cost stats — keep last.
      if (_reMatch(_CLAUDE_CLI_STATS_RE, line)) {
        last_stats = _strip(line);
        continue;
      }
      // Context meter — keep last.
      if (_reMatch(_CLAUDE_CLI_CONTEXT_RE, line)) {
        last_context = _strip(line);
        continue;
      }
      // "Thinking…" spinners — drop.
      if (_reMatch(_CLAUDE_CLI_SPINNER_RE, line)) {
        dropped_noise += 1;
        continue;
      }
      // Tool-call log lines — count.
      if (_reMatch(_CLAUDE_CLI_TOOL_LOG_RE, line)) {
        tool_log_count += 1;
        continue;
      }
      // Footer tips — drop.
      if (_reMatch(_CLAUDE_CLI_FOOTER_RE, line)) {
        dropped_noise += 1;
        continue;
      }
      kept.push(line);
    }

    const out: string[] = [...kept];

    const notes: string[] = [];
    _maybe_note(notes, tool_log_count, `collapsed ${tool_log_count} tool-call log line(s)`);
    _maybe_note(notes, last_stats, `stats: ${last_stats}`);
    _maybe_note(notes, last_context, `context: ${last_context}`);
    _maybe_note(notes, dropped_noise, `dropped ${dropped_noise} noise line(s)`);
    Filter._emit_notes(out, notes);
    return Filter._finalize(out);
  }
}

// ===========================================================================
// cursor regexes (Python ~22918-22941)
// ===========================================================================

/** Cursor startup / extension host lines (VSCode-derived CLI startup noise). */
const _CURSOR_STARTUP_RE: RegExp =
  /^\s*(?:Extension\s+host\s+(?:started|starting)|Extension\s+'cursor[^']*'\s+activated|Starting\s+debug\s+adapter|Opening\s+folder\s*\.*\s*$|Restoring\s+(?:windows?|session)|Reusing\s+existing\s+extension\s+host|Connection\s+(?:established|to\s+remote)|Tunnel\s+(?:connected|connecting|status))/i;
/** Cursor telemetry / analytics lines. */
const _CURSOR_TELEMETRY_RE: RegExp =
  /^\s*(?:Telemetry\s+is\s+(?:disabled|enabled)|Crash\s+reporter|Sending\s+telemetry|Analytics:)/i;
/** Cursor version banner: "Cursor 0.42.3" or "Cursor v0.42.3". */
const _CURSOR_BANNER_RE: RegExp = /^\s*Cursor\s+v?\d+\.\d+/i;

// ===========================================================================
// CursorFilter (Python ~22944-23003)
// ===========================================================================

/**
 * Compress `cursor` (Cursor AI editor) CLI output.
 *
 * The cursor CLI (built on VS Code) emits extension host startup lines,
 * telemetry notices, extension activation messages, and tunnel/connection
 * status lines that surround the actual editor output or error messages. All
 * of that noise is dropped; error lines are always kept. Errors short-circuit
 * to raw output via error_passthrough.
 */
export class CursorFilter extends Filter {
  override error_passthrough = true;

  override name = "cursor";
  override binaries: ReadonlySet<string> = new Set(["cursor"]);
  override subcommands: ReadonlySet<string> = new Set<string>();

  override matches(argv: string[]): boolean {
    if (argv.length === 0) {
      return false;
    }
    return _pathStemLower(argv[0]!) === "cursor";
  }

  override _compress_body(
    stdout: string,
    stderr: string,
    _exit_code: number,
    _argv: string[],
  ): string {
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
      // Version banner — drop.
      if (_reMatch(_CURSOR_BANNER_RE, line)) {
        dropped_noise += 1;
        continue;
      }
      // Startup / extension host lines — drop.
      if (_reMatch(_CURSOR_STARTUP_RE, line)) {
        dropped_noise += 1;
        continue;
      }
      // Telemetry lines — drop.
      if (_reMatch(_CURSOR_TELEMETRY_RE, line)) {
        dropped_noise += 1;
        continue;
      }
      kept.push(line);
    }

    const notes: string[] = [];
    _maybe_note(notes, dropped_noise, `dropped ${dropped_noise} startup/telemetry noise line(s)`);
    Filter._emit_notes(kept, notes);
    return Filter._finalize(kept);
  }
}

// ===========================================================================
// windsurf regexes (Python ~23008-23067)
// ===========================================================================

/** Windsurf startup / extension activation lines. */
const _WINDSURF_STARTUP_RE: RegExp =
  /^\s*(?:Extension\s+host\s+(?:started|starting)|Extension\s+'\S+'\s+activated|Starting\s+debug\s+adapter|Opening\s+folder\s*\.*\s*$|Restoring\s+(?:windows?|session)|Reusing\s+existing\s+extension\s+host)/i;
/** Windsurf Codeium-specific noise lines. */
const _WINDSURF_CODEIUM_NOISE_RE: RegExp =
  /^\s*(?:Codeium\s*(?::\s*)?(?:Activating|Activated|index(?:ing)?:?\s*loading|index\s+(?:loaded|ready)|Extension\s+loaded)|Connecting\s+to\s+Codeium\s+server|Authentication\s+status\s*:|Model\s+status\s*:|Codeium\s+(?:ready|connected|disconnected))/i;
/** Windsurf version banner: "Windsurf 1.2.3" or "Windsurf v1.2.3". */
const _WINDSURF_BANNER_RE: RegExp = /^\s*Windsurf\s+v?\d+\.\d+/i;
/** Windsurf telemetry lines. */
const _WINDSURF_TELEMETRY_RE: RegExp =
  /^\s*(?:Telemetry\s+is\s+(?:disabled|enabled)|Crash\s+reporter)/i;
/** Windsurf Cascade AI status lines. */
const _WINDSURF_CASCADE_STATUS_RE: RegExp =
  /^\s*(?:Cascade\s*(?::\s*)?(?:connected|disconnected|ready|connecting|starting|model\s+loaded|indexing\s+workspace|context\s+limit|[a-z]+\.{3})|Cascade\s+v?\d+|AI\s+assistant\s+(?:ready|loaded|connecting))/i;
/** Windsurf Cascade tool-call lines. */
const _WINDSURF_CASCADE_TOOL_RE: RegExp =
  /^\s*Cascade\s+(?:is\s+)?(?:reading|writing|running|executed|modified|created|deleted)\s+/i;
/** Windsurf Cascade thinking/spinner lines. */
const _WINDSURF_CASCADE_SPINNER_RE: RegExp =
  /^\s*(?:Thinking|Generating|Cascade\s+is\s+thinking|Processing\s+request)\s*\.{0,3}\s*$/i;
/** Windsurf context window meter: "Context: 45678 / 200000 tokens". */
const _WINDSURF_CONTEXT_RE: RegExp =
  /^\s*(?:Context(?:\s+window)?|Token\s+(?:usage|count))\s*:\s*[\d,]+\s*\/\s*[\d,]+/i;
/** Windsurf session/workspace loading lines. */
const _WINDSURF_WORKSPACE_RE: RegExp =
  /^\s*(?:Loading\s+workspace|Indexing\s+workspace|Workspace\s+(?:indexed|ready|loading)|Scanning\s+files|File\s+watcher)/i;

// ===========================================================================
// WindsurfFilter (Python ~23070-23174)
// ===========================================================================

/**
 * Compress `windsurf` (Codeium Windsurf AI editor) CLI output.
 *
 * The windsurf CLI emits VS Code–style startup noise, Codeium-specific
 * activation and index-loading lines, and Cascade AI status/tool-call lines.
 * Startup/Codeium/telemetry/Cascade-status/Cascade-spinner/workspace-loading
 * noise is dropped; Cascade tool-call lines collapse to a count; context-window
 * meters are kept as the last seen value. Errors short-circuit to raw output
 * via error_passthrough.
 */
export class WindsurfFilter extends Filter {
  override error_passthrough = true;

  override name = "windsurf";
  override binaries: ReadonlySet<string> = new Set(["windsurf"]);
  override subcommands: ReadonlySet<string> = new Set<string>();

  override matches(argv: string[]): boolean {
    if (argv.length === 0) {
      return false;
    }
    return _pathStemLower(argv[0]!) === "windsurf";
  }

  override _compress_body(
    stdout: string,
    stderr: string,
    _exit_code: number,
    _argv: string[],
  ): string {
    const combined = this._combine_output(stdout, stderr);
    const lines = combined.split("\n");
    const kept: string[] = [];
    let dropped_noise = 0;
    let cascade_tool_count = 0;
    let last_context: string | null = null;

    for (const line of lines) {
      // Error signals — always keep.
      if (_reSearch(_ERROR_SIGNAL_RE, line)) {
        kept.push(line);
        continue;
      }
      // Version banner — drop.
      if (_reMatch(_WINDSURF_BANNER_RE, line)) {
        dropped_noise += 1;
        continue;
      }
      // Startup / extension host lines — drop.
      if (_reMatch(_WINDSURF_STARTUP_RE, line)) {
        dropped_noise += 1;
        continue;
      }
      // Codeium-specific noise — drop.
      if (_reMatch(_WINDSURF_CODEIUM_NOISE_RE, line)) {
        dropped_noise += 1;
        continue;
      }
      // Telemetry lines — drop.
      if (_reMatch(_WINDSURF_TELEMETRY_RE, line)) {
        dropped_noise += 1;
        continue;
      }
      // Cascade AI status lines — drop.
      if (_reMatch(_WINDSURF_CASCADE_STATUS_RE, line)) {
        dropped_noise += 1;
        continue;
      }
      // Cascade spinner lines — drop.
      if (_reMatch(_WINDSURF_CASCADE_SPINNER_RE, line)) {
        dropped_noise += 1;
        continue;
      }
      // Cascade tool-call lines — count.
      if (_reMatch(_WINDSURF_CASCADE_TOOL_RE, line)) {
        cascade_tool_count += 1;
        continue;
      }
      // Context window meter — keep last seen.
      if (_reMatch(_WINDSURF_CONTEXT_RE, line)) {
        last_context = _strip(line);
        continue;
      }
      // Workspace loading lines — drop.
      if (_reMatch(_WINDSURF_WORKSPACE_RE, line)) {
        dropped_noise += 1;
        continue;
      }
      kept.push(line);
    }

    const out: string[] = [...kept];

    const notes: string[] = [];
    if (cascade_tool_count) {
      notes.push(
        `collapsed ${cascade_tool_count} Cascade tool-call line(s); ` +
          "disable via TOKEN_GOAT_BASH_COMPRESS for full output",
      );
    }
    _maybe_note(notes, last_context, `context: ${last_context}`);
    _maybe_note(notes, dropped_noise, `dropped ${dropped_noise} startup/activation noise line(s)`);
    Filter._emit_notes(out, notes);
    return Filter._finalize(out);
  }
}

// ===========================================================================
// opencode regexes (Python ~23178-23209)
// ===========================================================================

/** opencode version banner: "OpenCode v0.3.1" or "opencode 0.3.1". */
const _OPENCODE_BANNER_RE: RegExp = /^\s*(?:Open[Cc]ode|opencode)\s+v?\d+\.\d+/i;
/** opencode provider/model status lines: "Provider: openai" / "Model: gpt-4o". */
const _OPENCODE_STATUS_RE: RegExp = /^\s*(?:Provider|Model|Mode)\s*:\s*\S/i;
/** opencode context/token meter: "Context: 1234 / 128000 tokens". */
const _OPENCODE_CONTEXT_RE: RegExp = /^\s*Context\s*:\s*[\d,]+\s*\/\s*[\d,]+/i;
/** opencode tool call outbound: "→ tool_name(…)" or "-> tool_name". */
const _OPENCODE_TOOL_CALL_RE: RegExp = /^\s*(?:→|->)\s+\w+\s*\(/;
/** opencode tool result inbound: "← result (N chars)" or "<- result". */
const _OPENCODE_TOOL_RESULT_RE: RegExp = /^\s*(?:←|<-)\s+\S.*\(\d+\s+chars?\)/;
/** opencode spinner dots: bare line of dots "..." or "⠋" / "⠙". */
const _OPENCODE_SPINNER_RE: RegExp = /^\s*(?:[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]|\.{2,})\s*$/;
/** opencode session-saved footer. */
const _OPENCODE_SESSION_SAVE_RE: RegExp = /^\s*Session\s+saved\s+to\s+\S+/i;

// ===========================================================================
// OpenCodeFilter (Python ~23212-23308)
// ===========================================================================

/**
 * Compress `opencode` (opencode AI CLI) terminal output.
 *
 * opencode emits a TUI-style session header, provider/model status lines,
 * per-turn context meters, tool call I/O arrows, spinner frames, and a
 * session-saved footer. The banner, spinner dots, and session-save footer are
 * dropped; tool-call/result arrow lines collapse to a count; the last provider,
 * model, and context values are kept for debugging. Errors short-circuit to
 * raw output via error_passthrough.
 */
export class OpenCodeFilter extends Filter {
  override error_passthrough = true;

  override name = "opencode";
  override binaries: ReadonlySet<string> = new Set(["opencode"]);
  override subcommands: ReadonlySet<string> = new Set<string>();

  override matches(argv: string[]): boolean {
    if (argv.length === 0) {
      return false;
    }
    return _pathStemLower(argv[0]!) === "opencode";
  }

  override _compress_body(
    stdout: string,
    stderr: string,
    _exit_code: number,
    _argv: string[],
  ): string {
    const combined = this._combine_output(stdout, stderr);
    const lines = combined.split("\n");
    const kept: string[] = [];
    let tool_call_count = 0;
    let last_provider: string | null = null;
    let last_model: string | null = null;
    let last_context: string | null = null;
    let dropped_noise = 0;

    for (const line of lines) {
      // Error signals — always keep.
      if (_reSearch(_ERROR_SIGNAL_RE, line)) {
        kept.push(line);
        continue;
      }
      // Version banner — drop.
      if (_reMatch(_OPENCODE_BANNER_RE, line)) {
        dropped_noise += 1;
        continue;
      }
      // Provider/model status — keep last seen.
      if (_reMatch(_OPENCODE_STATUS_RE, line)) {
        const stripped = _strip(line);
        const lower = stripped.toLowerCase();
        if (lower.startsWith("provider")) {
          last_provider = stripped;
        } else if (lower.startsWith("model")) {
          last_model = stripped;
        } else {
          dropped_noise += 1;
        }
        continue;
      }
      // Context meter — keep last seen.
      if (_reMatch(_OPENCODE_CONTEXT_RE, line)) {
        last_context = _strip(line);
        continue;
      }
      // Tool call / result arrows — count.
      if (_reMatch(_OPENCODE_TOOL_CALL_RE, line) || _reMatch(_OPENCODE_TOOL_RESULT_RE, line)) {
        tool_call_count += 1;
        continue;
      }
      // Spinner dots — drop.
      if (_reMatch(_OPENCODE_SPINNER_RE, line)) {
        dropped_noise += 1;
        continue;
      }
      // Session-saved footer — drop.
      if (_reMatch(_OPENCODE_SESSION_SAVE_RE, line)) {
        dropped_noise += 1;
        continue;
      }
      kept.push(line);
    }

    const out: string[] = [...kept];
    if (tool_call_count) {
      out.push(
        `[token-goat: ${tool_call_count} tool call/result line(s) collapsed; ` +
          "disable via TOKEN_GOAT_BASH_COMPRESS for full output]",
      );
    }

    const notes: string[] = [];
    _maybe_note(notes, last_provider, `provider: ${last_provider}`);
    _maybe_note(notes, last_model, `model: ${last_model}`);
    _maybe_note(notes, last_context, `context: ${last_context}`);
    _maybe_note(notes, dropped_noise, `dropped ${dropped_noise} noise line(s)`);
    Filter._emit_notes(out, notes);
    return Filter._finalize(out);
  }
}

// ===========================================================================
// continue (Continue.dev) regexes (Python ~23313-23336)
// ===========================================================================

/** Continue.dev indexing progress: "Indexing: 42/1234 files…". */
const _CONTINUE_INDEXING_RE: RegExp = /^\s*Indexing\s*:\s*\d+\s*\/\s*\d+\s*files?/i;
/** Continue.dev model loading noise: "Loading model: codestral…". */
const _CONTINUE_MODEL_LOAD_RE: RegExp = /^\s*Loading\s+model\s*:\s*\S/i;
/** Continue.dev config-loaded lines. */
const _CONTINUE_CONFIG_RE: RegExp = /^\s*Config\s+(?:loaded\s+from|reloaded|initializ)/i;
/** Continue.dev token stats. */
const _CONTINUE_TOKENS_RE: RegExp =
  /^\s*Tokens\s*:\s*\d[\d,]*\s+prompt,\s+\d[\d,]*\s+completion/i;
/** Continue.dev version banner. */
const _CONTINUE_BANNER_RE: RegExp = /^\s*Continue(?:\.dev)?\s+v?\d+\.\d+/i;

// ===========================================================================
// ContinueFilter (Python ~23339-23421)
// ===========================================================================

/**
 * Compress `continue` (Continue.dev AI CLI) terminal output.
 *
 * The Continue.dev CLI emits indexing progress lines, model-loading notices,
 * config-loaded messages, and token stats lines around the actual AI response.
 * Indexing-progress lines collapse to a single summary (final count + last
 * line); model-load / config / banner noise is dropped; token stats are kept as
 * the last seen value. Errors short-circuit to raw output via error_passthrough.
 */
export class ContinueFilter extends Filter {
  override error_passthrough = true;

  override name = "continue";
  override binaries: ReadonlySet<string> = new Set(["continue"]);
  override subcommands: ReadonlySet<string> = new Set<string>();

  override matches(argv: string[]): boolean {
    if (argv.length === 0) {
      return false;
    }
    return _pathStemLower(argv[0]!) === "continue";
  }

  override _compress_body(
    stdout: string,
    stderr: string,
    _exit_code: number,
    _argv: string[],
  ): string {
    const combined = this._combine_output(stdout, stderr);
    const lines = combined.split("\n");
    const kept: string[] = [];
    let indexing_count = 0;
    let last_indexing_line: string | null = null;
    let last_tokens: string | null = null;
    let dropped_noise = 0;

    for (const line of lines) {
      // Error signals — always keep.
      if (_reSearch(_ERROR_SIGNAL_RE, line)) {
        kept.push(line);
        continue;
      }
      // Version banner — drop.
      if (_reMatch(_CONTINUE_BANNER_RE, line)) {
        dropped_noise += 1;
        continue;
      }
      // Indexing progress — count, keep last seen.
      if (_reMatch(_CONTINUE_INDEXING_RE, line)) {
        indexing_count += 1;
        last_indexing_line = _strip(line);
        continue;
      }
      // Model-loading noise — drop.
      if (_reMatch(_CONTINUE_MODEL_LOAD_RE, line)) {
        dropped_noise += 1;
        continue;
      }
      // Config-loaded lines — drop.
      if (_reMatch(_CONTINUE_CONFIG_RE, line)) {
        dropped_noise += 1;
        continue;
      }
      // Token stats — keep last seen.
      if (_reMatch(_CONTINUE_TOKENS_RE, line)) {
        last_tokens = _strip(line);
        continue;
      }
      kept.push(line);
    }

    const out: string[] = [...kept];
    if (indexing_count) {
      const summary = last_indexing_line ?? `${indexing_count} indexing progress line(s)`;
      out.push(
        `[token-goat: ${indexing_count} indexing progress line(s) collapsed; ` +
          `last: ${summary}; disable via TOKEN_GOAT_BASH_COMPRESS for full output]`,
      );
    }

    const notes: string[] = [];
    _maybe_note(notes, last_tokens, `tokens: ${last_tokens}`);
    _maybe_note(notes, dropped_noise, `dropped ${dropped_noise} noise line(s)`);
    Filter._emit_notes(out, notes);
    return Filter._finalize(out);
  }
}

// ===========================================================================
// cline regexes (Python ~23426-23469)
// ===========================================================================

/** Cline version banner: "Cline v3.x.x" / "claude-dev v3.x.x". */
const _CLINE_BANNER_RE: RegExp = /^\s*(?:Cline|claude-dev)\s+v\d+\.\d+/i;
/** Cline token usage line: "Tokens: 12,345 (↑ 5,432 in, ↓ 6,913 out)". */
const _CLINE_TOKENS_RE: RegExp = /^\s*Tokens\s*:\s*[\d,]+\s*\(/i;
/** Cline API cost line: "API Cost: $0.0456". */
const _CLINE_COST_RE: RegExp = /^\s*API\s+Cost\s*:\s*\$[\d.]+/i;
/** Cline context window meter. */
const _CLINE_CONTEXT_RE: RegExp =
  /^\s*Context\s+Window\s*:\s*[\d,]+\s*\/\s*[\d,]+\s+tokens/i;
/** Cline spinner / progress lines. */
const _CLINE_SPINNER_RE: RegExp =
  /^\s*(?:Thinking|Processing|Streaming\s+response)\s*\.{0,3}\s*$/i;
/** Cline startup noise. */
const _CLINE_STARTUP_RE: RegExp =
  /^\s*(?:Loading\s+workspace|Initializing\s+Cline|Starting\s+Cline)\s*\.{0,3}\s*$/i;
/** Cline MCP server status. */
const _CLINE_MCP_STATUS_RE: RegExp = /^\s*MCP\s+Server\s+['"]?\w/i;
/** Cline file-read progress (no content). */
const _CLINE_FILE_READ_RE: RegExp = /^\s*Reading\s+file\s*:\s*\S+\s*\.{0,3}\s*$/i;
/** Cline "Cline wants to execute:" user-approval request — always keep. */
const _CLINE_WANTS_EXECUTE_RE: RegExp =
  /^\s*Cline\s+wants\s+to\s+(?:execute|run|write|read|create|delete|use)\s*:/i;

// ===========================================================================
// ClineFilter (Python ~23472-23579)
// ===========================================================================

/**
 * Compress `cline` (Cline AI coding assistant) terminal output.
 *
 * Cline (formerly Claude Dev / claude-dev) emits version banners, per-turn
 * token usage and API cost lines, context-window meters, "Thinking…" spinners,
 * MCP server connection status, file-read progress lines, and startup noise.
 * The banner, spinner, startup, and MCP-status noise is dropped; file-read
 * progress lines collapse to a count; tokens / cost / context are kept as the
 * last seen value; "Cline wants to execute:" approval requests are always kept.
 * Errors short-circuit to raw output via error_passthrough.
 */
export class ClineFilter extends Filter {
  override error_passthrough = true;

  override name = "cline";
  override binaries: ReadonlySet<string> = new Set(["cline", "claude-dev"]);
  override subcommands: ReadonlySet<string> = new Set<string>();

  override matches(argv: string[]): boolean {
    if (argv.length === 0) {
      return false;
    }
    const stem = _pathStemLower(argv[0]!);
    return stem === "cline" || stem === "claude-dev";
  }

  override _compress_body(
    stdout: string,
    stderr: string,
    _exit_code: number,
    _argv: string[],
  ): string {
    const combined = this._combine_output(stdout, stderr);
    const lines = combined.split("\n");
    const kept: string[] = [];
    let last_tokens: string | null = null;
    let last_cost: string | null = null;
    let last_context: string | null = null;
    let file_read_count = 0;
    let dropped_noise = 0;

    for (const line of lines) {
      // Error signals — always keep.
      if (_reSearch(_ERROR_SIGNAL_RE, line)) {
        kept.push(line);
        continue;
      }
      // "Cline wants to execute:" — always keep (user approval requests).
      if (_reMatch(_CLINE_WANTS_EXECUTE_RE, line)) {
        kept.push(line);
        continue;
      }
      // Version banner — drop.
      if (_reMatch(_CLINE_BANNER_RE, line)) {
        dropped_noise += 1;
        continue;
      }
      // Token usage — keep last seen.
      if (_reMatch(_CLINE_TOKENS_RE, line)) {
        last_tokens = _strip(line);
        continue;
      }
      // API cost — keep last seen.
      if (_reMatch(_CLINE_COST_RE, line)) {
        last_cost = _strip(line);
        continue;
      }
      // Context window meter — keep last seen.
      if (_reMatch(_CLINE_CONTEXT_RE, line)) {
        last_context = _strip(line);
        continue;
      }
      // Spinner / progress lines — drop.
      if (_reMatch(_CLINE_SPINNER_RE, line)) {
        dropped_noise += 1;
        continue;
      }
      // Startup noise — drop.
      if (_reMatch(_CLINE_STARTUP_RE, line)) {
        dropped_noise += 1;
        continue;
      }
      // MCP server status — drop.
      if (_reMatch(_CLINE_MCP_STATUS_RE, line)) {
        dropped_noise += 1;
        continue;
      }
      // File-read progress (no content) — count.
      if (_reMatch(_CLINE_FILE_READ_RE, line)) {
        file_read_count += 1;
        continue;
      }
      kept.push(line);
    }

    const out: string[] = [...kept];
    if (file_read_count) {
      out.push(
        `[token-goat: ${file_read_count} file-read progress line(s) collapsed; ` +
          "disable via TOKEN_GOAT_BASH_COMPRESS for full output]",
      );
    }

    const notes: string[] = [];
    _maybe_note(notes, last_tokens, `tokens: ${last_tokens}`);
    _maybe_note(notes, last_cost, `cost: ${last_cost}`);
    _maybe_note(notes, last_context, `context: ${last_context}`);
    _maybe_note(notes, dropped_noise, `dropped ${dropped_noise} noise line(s)`);
    Filter._emit_notes(out, notes);
    return Filter._finalize(out);
  }
}

// ===========================================================================
// codex-exec regexes (Python ~23584-23606)
// ===========================================================================

/** Codex CLI version banner: "OpenAI Codex v0.137.0". */
const _CODEX_BANNER_RE: RegExp = /^OpenAI Codex v\d+/i;
/** Codex separator line: "--------" (4+ dashes). */
const _CODEX_SEPARATOR_RE: RegExp = /^-{4,}$/;
/** Codex header config key=value: "model: gpt-5.4-mini". */
const _CODEX_MODEL_RE: RegExp = /^model\s*:\s*(?<model>\S+)/i;
/** Codex token count footer: "tokens used" label (next line holds the count). */
const _CODEX_TOKENS_USED_RE: RegExp = /^tokens used$/i;
// NOTE: Python also declares `_CODEX_ROLE_RE = re.compile(r"^(?:user|codex)$",
// re.IGNORECASE) at line 23603, but it is DEAD CODE — never referenced anywhere
// in the 26k-LOC source (CodexExecFilter uses the inline
// `lines[i].strip().casefold() == "codex"` check instead). Not ported to avoid
// an unused-const lint/tsc error; the inline check below is the faithful port.

// ===========================================================================
// CodexExecFilter (Python ~23609-23720)
// ===========================================================================

/**
 * Compress `codex` (OpenAI Codex CLI) command output.
 *
 * The Codex CLI emits a verbose header block on every invocation: a version
 * banner, a separator line, a block of session config (workdir, model,
 * provider, approval, sandbox, reasoning settings, session id), a second
 * separator, and then a multi-turn conversation transcript (user / codex)
 * followed by a "tokens used" footer. Only the substantive AI answer is useful.
 *
 * The header block is replaced by a one-line `[codex: model=<m>, tokens=<N>]`
 * summary; the prompt/user turn is dropped; the AI answer (after the final
 * `codex` role label, before `tokens used`) is kept verbatim. Unrecognised
 * formats (missing separators or role labels) pass through unchanged. Errors
 * short-circuit to raw output via error_passthrough.
 */
export class CodexExecFilter extends Filter {
  override error_passthrough = true;

  override name = "codex-exec";
  override binaries: ReadonlySet<string> = new Set(["codex"]);
  override subcommands: ReadonlySet<string> = new Set<string>();

  override matches(argv: string[]): boolean {
    if (argv.length === 0) {
      return false;
    }
    return _pathStemLower(argv[0]!) === "codex";
  }

  override _compress_body(
    stdout: string,
    stderr: string,
    _exit_code: number,
    _argv: string[],
  ): string {
    const combined = this._combine_output(stdout, stderr);
    if (_strip(combined) === "") {
      return combined;
    }

    const lines = combined.split("\n");

    let first_sep_idx: number | null = null;
    let second_sep_idx: number | null = null;
    for (let i = 0; i < Math.min(20, lines.length); i += 1) {
      if (_reMatch(_CODEX_SEPARATOR_RE, lines[i]!.trim())) {
        if (first_sep_idx === null) {
          first_sep_idx = i;
        } else {
          second_sep_idx = i;
          break;
        }
      }
    }
    // Require both separators — without the full --------/config/--------
    // structure we cannot safely bound the transcript region.
    if (second_sep_idx === null) {
      return combined; // unrecognised format — passthrough
    }

    // first_sep_idx is guaranteed set when second_sep_idx is set.
    const firstSep = first_sep_idx!;

    // Extract model from the config block (between the two separators).
    let model = "unknown";
    for (let i = firstSep + 1; i < second_sep_idx; i += 1) {
      const m = _reMatchObj(_CODEX_MODEL_RE, lines[i]!.trim());
      if (m) {
        model = m.groups!["model"]!;
        break;
      }
    }

    // Find the last "codex" role label restricted to the transcript region
    // (after the second separator). Constraining the scan prevents answer
    // content that happens to be the bare word "codex" from being mistaken
    // for a role marker and truncating the extracted answer.
    let last_codex_idx: number | null = null;
    for (let i = second_sep_idx + 1; i < lines.length; i += 1) {
      if (lines[i]!.trim().toLowerCase() === "codex") {
        last_codex_idx = i;
      }
    }

    if (last_codex_idx === null) {
      // No "codex" role label found — unrecognised format, passthrough.
      return combined;
    }

    // Find "tokens used" by scanning backward from the end of output. Codex
    // always emits this footer in the last handful of lines; scanning backward
    // avoids truncating answers that contain the phrase.
    let tokens_line_idx: number | null = null;
    let tokens_count = "?";
    const search_floor = Math.max(last_codex_idx + 1, lines.length - 6);
    for (let i = lines.length - 1; i >= search_floor; i -= 1) {
      if (_reMatch(_CODEX_TOKENS_USED_RE, lines[i]!.trim())) {
        tokens_line_idx = i;
        // The count is on the very next non-blank line.
        for (let j = i + 1; j < Math.min(i + 3, lines.length); j += 1) {
          const candidate = lines[j]!.trim();
          if (candidate !== "") {
            tokens_count = candidate;
            break;
          }
        }
        break;
      }
    }

    // Extract the answer body.
    const answer_end = tokens_line_idx !== null ? tokens_line_idx : lines.length;
    const answer_lines = lines.slice(last_codex_idx + 1, answer_end);

    // Strip leading/trailing blank lines from the answer.
    while (answer_lines.length > 0 && _strip(answer_lines[0]!) === "") {
      answer_lines.shift();
    }
    while (answer_lines.length > 0 && _strip(answer_lines[answer_lines.length - 1]!) === "") {
      answer_lines.pop();
    }

    const summary = `[codex: model=${model}, tokens=${tokens_count}]`;
    const out: string[] = [summary, ...answer_lines];
    return Filter._finalize(out);
  }
}
