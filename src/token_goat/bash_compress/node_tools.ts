/**
 * bash_compress BUILD-TOOLS FILTERS — TypeScript port of the cross-ecosystem
 * dependency-listing filter plus the TypeScript-compiler and JS/TS monorepo
 * orchestrator Filter subclasses from src/token_goat/bash_compress.py:
 *
 *   - DepListFilter (Python lines ~10182-10258): cross-ecosystem dependency
 *     listings (`pip list`, `pip freeze`, `npm ls`, `cargo tree`, `poetry show`,
 *     ...). It PRECEDES the cargo/node install filters in the FILTERS registry,
 *     so a `cargo tree` / `npm ls` style listing subcommand routes HERE rather
 *     than to the per-ecosystem install filter.
 *   - TscFilter (Python lines ~5653-5801, regexes/helpers ~5593-5651, command
 *     detector _is_tsc_cmd at ~3057): TypeScript compiler (tsc) — type-check,
 *     watch, and build modes.
 *   - NxFilter (Python lines ~17417-17507, regexes ~17353-17387): Nx monorepo
 *     orchestrator (npx-routed: `nx`, `npx nx`, `pnpx nx`).
 *   - LernaFilter (Python lines ~17510-17585, regexes ~17389-17414): Lerna
 *     monorepo task runner.
 *   - TurboFilter (Python lines ~17734-17833, regexes ~17700-17731): Turborepo
 *     (npx-routed: `turbo`, `npx turbo`, `pnpx turbo`).
 *
 * All five subclass the concrete Filter base from ./framework.js. They are
 * appended to the FILTERS registry (and __all__) by the barrel one level up.
 * There are no dedicated Python tests for these five classes, so this port is
 * done with extra parity care — every constant, regex, threshold, and branch is
 * copied verbatim from the Python source.
 *
 * ---------------------------------------------------------------------------
 * Parity notes (Python -> TS)
 * ---------------------------------------------------------------------------
 *  - Python identifiers are preserved EXACTLY: PascalCase class names
 *    (DepListFilter, TscFilter, NxFilter, LernaFilter, TurboFilter), the
 *    snake_case module-private regex/constant names (_DEP_LIST_THRESHOLD,
 *    _TSC_*, _NX_*, _LERNA_*, _TURBO_*), the snake_case helper _is_tsc_cmd /
 *    _is_tsc_context_line, and the snake_case methods/fields on each class
 *    (_compress_typecheck, _compress_watch, _compress_build, _dep_cmd_hint,
 *    _MAX_PER_CODE, _FAIL_TASK_SAMPLE, _SAMPLE_SIZE, _BODY_SAMPLE, _PKG_MGR_STEMS).
 *  - re.compile(...) -> top-level RegExp compiled once at module load. IGNORECASE
 *    -> "i". None of these patterns use MULTILINE/DOTALL. Patterns matched per
 *    line via .match(line) go through _reMatch (a non-global clone + index===0
 *    check) so lastIndex never leaks; patterns searched anywhere via .search(line)
 *    go through _reTest (non-global clone .test). One pattern with a capture group
 *    (_TURBO_TASK_LINE_RE) is read via _reMatchObj.
 *  - _ERROR_SIGNAL_RE is module-private in the Python source (NOT in __all__) and
 *    is NOT exported by framework.ts, so its verbatim source is re-declared here
 *    (mirroring framework's own copy) for the .search(line) calls in NxFilter and
 *    TurboFilter. Reported in parity_notes.
 *  - DepListFilter.error_passthrough = True: it overrides _compress_body (NOT
 *    compress), so the framework Filter.compress short-circuits to the raw
 *    stderr-on-error output BEFORE _compress_body runs — exactly as in Python.
 *  - DepListFilter / TscFilter / NxFilter / TurboFilter override matches() with
 *    custom dispatch. matches uses Path(argv[0]).stem.lower() in Python; the TS
 *    _pathStem reproduces pathlib stem semantics (final component, last suffix
 *    stripped). _is_tsc_cmd / DepListFilter.matches / Nx/Turbo matches re-derive
 *    the binary base inline exactly as the Python helpers do.
 *  - _positional_args is imported from framework.js (it is exported there and is
 *    the same module-level helper the Python source calls), not re-implemented.
 *  - Path(argv[0]).stem.lower() -> _pathStem(argv[0]).toLowerCase(); _is_tsc_cmd's
 *    local _base(s) (rsplit on "/" then strip .exe/.cmd) and Nx/Turbo's inline
 *    Path(...).stem are reproduced faithfully.
 *  - String building / pluralisation is byte-for-byte: f"...{n}...{'s' if …}" maps
 *    to template literals with the same ternary. sorted(code_dropped, key=…) maps
 *    to a stable .sort with the same int-or-0 key.
 *  - Line/byte caps and blank-line squeezing are delegated to the framework via
 *    Filter._finalize / Filter._emit_notes / _maybe_note / _squeeze_blank_lines —
 *    nothing is re-implemented.
 *  - Module-global state: NONE. These filters hold only per-call locals plus the
 *    immutable compiled regexes and class-constant fields, so there is no
 *    registerReset seam to wire (mirroring test_runners.ts).
 *
 * NOTE on import depth: this file lives in the bash_compress/ SUBDIR; the
 * framework is a SIBLING (./framework.js). verbatimModuleSyntax is on -> nothing
 * imported here is type-only. noImplicitOverride is on -> every overridden member
 * carries `override`.
 */

import {
  Filter,
  _maybe_note,
  _positional_args,
  _squeeze_blank_lines,
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
 * Python re.Pattern.match(line) returning the match object (or null), for the
 * one filter that reads a capture group. Non-global clone so lastIndex never
 * leaks.
 */
function _reMatchObj(re: RegExp, line: string): RegExpExecArray | null {
  const r = _nonGlobal(re);
  const m = r.exec(line);
  return m !== null && m.index === 0 ? m : null;
}

/** Python re.search(...) — unanchored search anywhere in the string. */
function _reTest(re: RegExp, text: string): boolean {
  return _nonGlobal(re).test(text);
}

/**
 * pathlib.PurePath(p).name — final path component after normalising backslashes
 * to forward slashes (Python's source uses str.replace("\\", "/") before the
 * Path call). A trailing slash is ignored (PurePath("a/b/").name == "b").
 */
function _pathName(p: string): string {
  const norm = p.replace(/\\/g, "/");
  const trimmed = norm.replace(/\/+$/, "");
  const idx = trimmed.lastIndexOf("/");
  return idx >= 0 ? trimmed.slice(idx + 1) : trimmed;
}

/**
 * pathlib.PurePath(p).stem — the final component with its LAST suffix removed.
 * Path.stem strips only the final extension (".tar.gz" -> "archive.tar"); a
 * leading-dot dotfile with no other dot keeps its name (".bashrc" -> ".bashrc");
 * a trailing dot is not a suffix ("foo." -> "foo.").
 */
function _pathStem(p: string): string {
  const name = _pathName(p);
  const dot = name.lastIndexOf(".");
  if (dot <= 0) {
    return name;
  }
  if (dot === name.length - 1) {
    return name;
  }
  return name.slice(0, dot);
}

/** Python str.strip() — strip leading and trailing whitespace. */
function _strip(s: string): string {
  return s.replace(/^\s+/u, "").replace(/\s+$/u, "");
}

/** Python str.rstrip() — strip trailing whitespace. */
function _rstrip(s: string): string {
  return s.replace(/\s+$/u, "");
}

/** Python str.isdigit() for a (possibly empty) string of ASCII/Unicode digits. */
function _isDigitStr(s: string): boolean {
  return s.length > 0 && /^\d+$/.test(s);
}

// Error/failure signal regex — re-declared verbatim from framework.ts (where it
// is module-private and NOT exported). Used by NxFilter / TurboFilter via
// .search(line). Python: re.compile(r"error:|Error:|ERROR|FAILED|failed|fatal:|
//   Traceback|exception:|Exception:|AssertionError|assert |panic:", re.IGNORECASE)
const _ERROR_SIGNAL_RE: RegExp =
  /error:|Error:|ERROR|FAILED|failed|fatal:|Traceback|exception:|Exception:|AssertionError|assert |panic:/i;

// ===========================================================================
// DepListFilter (Python lines ~10180-10258)
// ===========================================================================

/** Threshold above which dependency-listing output is truncated. */
const _DEP_LIST_THRESHOLD = 30;

/**
 * Compress verbose dependency-listing output from package managers.
 *
 * When `pip list`, `pip freeze`, `npm list`, `poetry show`, `cargo tree`, and
 * similar listing commands produce more than 30 lines of output, truncate to the
 * first 30 lines and append a `...[N more packages]` count trailer. Short output
 * (<= 30 lines) and error output (non-zero exit code) pass through unchanged.
 *
 * See the Python docstring for the full matched-command table and compression
 * model. error_passthrough is true, so the framework Filter.compress preserves
 * raw stderr-on-error before _compress_body runs.
 */
export class DepListFilter extends Filter {
  override error_passthrough = true;

  override name = "dep-list";
  override binaries: ReadonlySet<string> = new Set(["pip", "pip3", "uv", "poetry"]);
  override subcommands: ReadonlySet<string> = new Set(["list", "freeze", "show", "ls", "tree"]);

  // npm, pnpm, and yarn are intentionally absent from `binaries` so that
  // bash_detect routes those binaries to their dedicated install filters (the
  // install fast-path wins the sync table). We still compress their listing
  // subcommands (list / ls / etc.), so we check them explicitly here.
  _PKG_MGR_STEMS: ReadonlySet<string> = new Set(["npm", "pnpm", "yarn", "cargo"]);

  override matches(argv: string[]): boolean {
    if (argv.length > 0 && this._PKG_MGR_STEMS.has(_pathStem(argv[0]!).toLowerCase())) {
      const positionals = _positional_args(argv.slice(1)).slice(0, 3);
      return positionals.some((tok) => this.subcommands.has(tok));
    }
    return super.matches(argv);
  }

  override _compress_body(
    stdout: string,
    stderr: string,
    _exit_code: number,
    argv: string[],
  ): string {
    const merged = this._combine_output(stdout, stderr);
    const lines = merged.split("\n");
    // Strip only trailing blank lines; keep internal package-list formatting.
    while (lines.length > 0 && _rstrip(lines[lines.length - 1]!) === "") {
      lines.pop();
    }
    if (lines.length <= _DEP_LIST_THRESHOLD) {
      return lines.join("\n");
    }
    const n_more = lines.length - _DEP_LIST_THRESHOLD;
    const shown = lines.slice(0, _DEP_LIST_THRESHOLD);
    const hint = DepListFilter._dep_cmd_hint(argv);
    const trailer = `...[${n_more} more packages — use '${hint}' to see full output]`;
    return shown.join("\n") + "\n" + trailer;
  }

  /**
   * Return a short `'cmd subcmd'` hint from argv for the trailer.
   *
   * For three-token forms such as `uv pip list`, include all three tokens so the
   * hint is immediately actionable.
   */
  static _dep_cmd_hint(argv: string[]): string {
    if (argv.length === 0) {
      return "the original command";
    }
    const stem = _pathStem(argv[0]!).toLowerCase();
    const positionals = _positional_args(argv.slice(1));
    // `uv pip list` / `uv pip freeze` — include all three tokens.
    if (stem === "uv" && positionals.length >= 2) {
      return `uv ${positionals[0]} ${positionals[1]}`;
    }
    const subcmd = positionals.length > 0 ? positionals[0]! : "";
    return _strip(`${stem} ${subcmd}`);
  }
}

// ===========================================================================
// TypeScript Compiler (tsc) — detector, regexes, context helper
// (Python lines ~3057-3098 and ~5593-5651)
// ===========================================================================

/**
 * Return True if the command is a TypeScript compiler (tsc) invocation.
 *
 * Handles: bare `tsc`, `npx tsc`, `npx --yes tsc`, `yarn tsc`, `pnpm tsc`,
 * `pnpm exec tsc`, and path-resolved binaries like `./node_modules/.bin/tsc` or
 * `tsc.cmd`. All tsc flags (--build, --noEmit, --watch, etc.) are ignored for
 * detection purposes.
 */
export function _is_tsc_cmd(argv: string[]): boolean {
  if (argv.length === 0) {
    return false;
  }

  const _base = (s: string): string => {
    let b = s.replace(/\\/g, "/").split("/").pop()!.toLowerCase();
    for (const ext of [".exe", ".cmd"]) {
      if (b.endsWith(ext)) {
        b = b.slice(0, b.length - ext.length);
        break;
      }
    }
    return b;
  };

  const b0 = _base(argv[0]!);
  // Direct invocation: tsc, ./node_modules/.bin/tsc, tsc.cmd, etc.
  if (b0 === "tsc") {
    return true;
  }
  // Package manager wrappers: npx tsc, yarn tsc, pnpm tsc, pnpm exec tsc
  if (b0 === "npx" || b0 === "yarn" || b0 === "pnpm") {
    let i = 1;
    while (i < argv.length) {
      const tok = argv[i]!;
      if (tok.startsWith("-")) {
        // --package / -p consume next token as value
        if (tok === "--package" || tok === "-p") {
          i += 2;
        } else {
          i += 1;
        }
      } else {
        // For pnpm, "exec" is a sub-command prefix; skip it and continue
        if (b0 === "pnpm" && tok === "exec") {
          i += 1;
          continue;
        }
        return _base(tok) === "tsc";
      }
    }
    return false;
  }
  return false;
}

// Timestamp prefix emitted in --watch / --build modes: "[10:30:00 PM] "
const _TSC_TS_PREFIX_RE: RegExp = /^\[\d{1,2}:\d{2}:\d{2} [AP]M\] /;
// Watch mode: initial "Starting compilation in watch mode..."
const _TSC_WATCH_INIT_RE: RegExp =
  /^\[\d{1,2}:\d{2}:\d{2} [AP]M\] Starting compilation in watch mode\.\.\.$/;
// Watch mode: incremental restart "File change detected. Starting incremental compilation..."
const _TSC_WATCH_CYCLE_RE: RegExp =
  /^\[\d{1,2}:\d{2}:\d{2} [AP]M\] (?:File change detected\. )?Starting incremental compilation\.\.\.$/;
// Build mode: "Projects in this build:" listing header
const _TSC_BUILD_PROJECTS_HDR_RE: RegExp =
  /^\[\d{1,2}:\d{2}:\d{2} [AP]M\] Projects in this build:$/;
// Build mode: project listing item "    * packages/foo/tsconfig.json"
const _TSC_BUILD_PROJECT_ITEM_RE: RegExp = /^\s+\*\s+\S/;
// Build mode: "Project 'X' is up to date because oldest output..."
const _TSC_BUILD_UPTODATE_RE: RegExp =
  /^\[\d{1,2}:\d{2}:\d{2} [AP]M\] Project '.+' is up to date/;
// Old-format error: `src/foo.ts(10,5): error TS2345: …`
const _TSC_ERROR_OLD_RE: RegExp =
  /^\S+\.tsx?\(\d+,\d+\): (?:error|warning|message) TS\d+:/;
// New-format error: `src/foo.ts:10:5 - error TS2345: …`
const _TSC_ERROR_NEW_RE: RegExp =
  /^\S+\.tsx?:\d+:\d+ - (?:error|warning|message) TS\d+:/;
// Extract TS error code from an error line
const _TSC_ERROR_CODE_RE: RegExp = /\bTS(\d+)\b/;
// Final summary: "Found N errors." (no "Watching" suffix)
const _TSC_SUMMARY_RE: RegExp = /^Found \d+ errors?\.$/;

// Reference the parity-only constants so they are not flagged as unused (the
// Python source declares them as module-level Finals; _TSC_TS_PREFIX_RE and
// _TSC_SUMMARY_RE are documented/declared but not consulted by these methods).
void _TSC_TS_PREFIX_RE;
void _TSC_SUMMARY_RE;

// Numbered-source-line prefix used by _is_tsc_context_line. Python: re.match(r"^\d+\s", line).
const _TSC_CONTEXT_NUMBERED_RE: RegExp = /^\d+\s/;

/**
 * Return True for blank, numbered-source, or underline lines following a tsc
 * error.
 *
 * tsc new-format errors emit 2-3 context lines after the error header: a blank
 * line, a numbered source-code line ("10   const x = foo();"), and an underline
 * ("         ~~~").
 */
function _is_tsc_context_line(line: string): boolean {
  if (_strip(line) === "") {
    return true;
  }
  if (_reMatch(_TSC_CONTEXT_NUMBERED_RE, line)) {
    return true;
  }
  const stripped = _strip(line);
  if (stripped !== "" && [...stripped].every((c) => c === "~" || c === "^" || c === " ")) {
    return true;
  }
  // Prose continuation: indented message text that follows the error header
  // (e.g. "  Object literal may only specify known properties…").
  const lstripped = line.replace(/^\s+/u, "");
  return (
    line.startsWith("  ") &&
    !_reMatch(_TSC_ERROR_OLD_RE, lstripped) &&
    !_reMatch(_TSC_ERROR_NEW_RE, lstripped)
  );
}

// ===========================================================================
// TscFilter (Python lines ~5653-5801)
// ===========================================================================

/**
 * Compress TypeScript compiler (tsc) output across type-check / watch / build
 * modes.
 *
 * See the Python docstring for the full compression model: type-check dedups
 * error stanzas by TS diagnostic code (keep first _MAX_PER_CODE per code); watch
 * mode keeps the first + last cycle and collapses the rest; build mode drops
 * up-to-date project lines and the projects-in-this-build listing.
 */
export class TscFilter extends Filter {
  override name = "tsc";
  override binaries: ReadonlySet<string> = new Set(["tsc"]);
  /** Maximum error stanzas per TS diagnostic code to keep verbatim. */
  _MAX_PER_CODE = 3;

  override matches(argv: string[]): boolean {
    return _is_tsc_cmd(argv);
  }

  override compress(stdout: string, stderr: string, _exit_code: number, argv: string[]): string {
    const argv_flags = new Set(argv.slice(1).map((a) => a.toLowerCase()));
    const is_watch = argv_flags.has("-w") || argv_flags.has("--watch");
    const is_build = argv_flags.has("-b") || argv_flags.has("--build");

    const combined = this._combine_output(stdout, stderr);

    if (is_watch) {
      return this._compress_watch(combined);
    }
    if (is_build) {
      return this._compress_build(combined);
    }
    return this._compress_typecheck(combined);
  }

  /** Deduplicate errors by TS diagnostic code; preserve context lines. */
  _compress_typecheck(combined: string): string {
    const lines = combined.split("\n");
    const kept: string[] = [];
    const code_kept = new Map<string, number>();
    const code_dropped = new Map<string, number>();

    let i = 0;
    while (i < lines.length) {
      const line = lines[i]!;
      if (_reMatch(_TSC_ERROR_OLD_RE, line) || _reMatch(_TSC_ERROR_NEW_RE, line)) {
        const m = _nonGlobal(_TSC_ERROR_CODE_RE).exec(line);
        const code = m ? m[1]! : "";
        // Gather stanza: error header + any immediately following context lines.
        const stanza = [line];
        let j = i + 1;
        while (j < lines.length && _is_tsc_context_line(lines[j]!)) {
          stanza.push(lines[j]!);
          j += 1;
        }
        const n = code_kept.get(code) ?? 0;
        if (n < this._MAX_PER_CODE) {
          kept.push(...stanza);
          if (code) {
            code_kept.set(code, n + 1);
          }
        } else {
          code_dropped.set(code, (code_dropped.get(code) ?? 0) + 1);
        }
        i = j;
      } else {
        kept.push(line);
        i += 1;
      }
    }

    // Append one dedup note per suppressed code.
    const sorted_codes = [...code_dropped.keys()].sort(
      (a, b) => (_isDigitStr(a) ? Number(a) : 0) - (_isDigitStr(b) ? Number(b) : 0),
    );
    for (const code of sorted_codes) {
      const n = code_dropped.get(code)!;
      const pl = n > 1 ? "s" : "";
      kept.push(
        `[token-goat: dropped ${n} more TS${code} error${pl}` +
          ` (kept first ${this._MAX_PER_CODE})]`,
      );
    }
    return _squeeze_blank_lines(kept.join("\n"));
  }

  /** Retain first + last watch cycles; collapse all intermediate ones. */
  _compress_watch(combined: string): string {
    const lines = combined.split("\n");
    const cycles: string[][] = [];
    let current: string[] = [];

    for (const line of lines) {
      if (_reMatch(_TSC_WATCH_INIT_RE, line) || _reMatch(_TSC_WATCH_CYCLE_RE, line)) {
        if (current.length > 0) {
          cycles.push(current);
        }
        current = [line];
      } else {
        current.push(line);
      }
    }
    if (current.length > 0) {
      cycles.push(current);
    }

    // Nothing to drop when there are at most 2 cycles.
    if (cycles.length <= 2) {
      return _squeeze_blank_lines(combined);
    }

    const dropped = cycles.length - 2;
    const pl = dropped > 1 ? "s" : "";
    const kept_lines: string[] = [...cycles[0]!];
    kept_lines.push(`[token-goat: dropped ${dropped} intermediate watch cycle${pl}]`);
    kept_lines.push(...cycles[cycles.length - 1]!);
    return _squeeze_blank_lines(kept_lines.join("\n"));
  }

  /** Drop up-to-date project lines; keep build / error / summary lines. */
  _compress_build(combined: string): string {
    const lines = combined.split("\n");
    const kept: string[] = [];
    let uptodate_count = 0;
    let in_projects_hdr = false;

    for (const line of lines) {
      if (_reMatch(_TSC_BUILD_PROJECTS_HDR_RE, line)) {
        in_projects_hdr = true;
        continue;
      }
      if (in_projects_hdr) {
        if (_reMatch(_TSC_BUILD_PROJECT_ITEM_RE, line) || _strip(line) === "") {
          continue;
        }
        in_projects_hdr = false;
      }
      if (_reMatch(_TSC_BUILD_UPTODATE_RE, line)) {
        uptodate_count += 1;
        continue;
      }
      kept.push(line);
    }

    const notes: string[] = [];
    if (uptodate_count) {
      const pl = uptodate_count > 1 ? "s" : "";
      notes.push(`dropped ${uptodate_count} up-to-date project line${pl}`);
    }
    TscFilter._emit_notes(kept, notes);
    return _squeeze_blank_lines(kept.join("\n"));
  }
}

// ===========================================================================
// Nx / Lerna (monorepo build orchestrators) — regexes (Python lines ~17353-17414)
// ===========================================================================

// NX target header: "NX  Running target build for project foo and 3 tasks it depends on"
const _NX_HEADER_RE: RegExp =
  /^(?:\s*>?\s*)?NX\s+(?:Running target|Affected|Running N?x|Finishing|Finished|Ran target|Successfully ran)/i;
// NX per-project success/failure status lines:
//   "✔  nx run @myorg/lib:build (4s)"
//   "✖  nx run @myorg/app:build (failed)"
//   "✓  1/4 succeeded"
// Note: do NOT include '>' here — task-header lines start with '> nx run …'
// and must be handled by _NX_TASK_HEADER_RE instead.
const _NX_STATUS_RE: RegExp = /^\s*[✔✖✓✗×]\s+(?:nx run|(?:\d+\/\d+ (?:succeeded|failed)))/;
// NX cache hit lines: "... [existing outputs match the cache, left as is]"
const _NX_CACHE_HIT_RE: RegExp = /\[existing outputs match the cache|cache hit\]/i;
// NX separator / decoration lines: long dash/equals lines, blank "> " lines
const _NX_SEPARATOR_RE: RegExp = /^[\s>]*[—\-─═]{10,}\s*$|^>\s*$/;
// NX "Nx run target" task header (per-project task start, verbose mode):
//   "> nx run @myorg/lib:build"
const _NX_TASK_HEADER_RE: RegExp = /^>\s*(?:nx|NX)\s+run\s+\S+:\S+/;
// NX summary: "Ran target X for N projects (Xs)" / "N/M succeeded"
const _NX_SUMMARY_RE: RegExp =
  /^\s*[✔✖✓✗]?\s*\d+\/\d+\s+(?:succeeded|failed)|Ran target|Successfully ran/i;

// Lerna info/verbose lines we want to drop (timing, npm script echoes)
const _LERNA_VERBOSE_RE: RegExp = /^lerna\s+(?:verb|verbose|timing)\s/i;
// Lerna "info" lines: keep only certain important ones
const _LERNA_INFO_RE: RegExp = /^lerna\s+info\s/i;
// Lerna per-package "Ran npm script" / "run Ran npm script" lines (verbose run output)
const _LERNA_RAN_RE: RegExp = /^lerna\s+info\s+run\s+Ran npm script/i;
// Lerna success/error lines — always keep
const _LERNA_OUTCOME_RE: RegExp = /^lerna\s+(?:success|error|ERR!)\b/i;
// Lerna "notice" lines (changelog, git, publish noise).
// Match "lerna notice" with optional trailing whitespace/content.
const _LERNA_NOTICE_RE: RegExp = /^lerna\s+notice(?:\s|$)/i;

// ===========================================================================
// NxFilter (Python lines ~17417-17507)
// ===========================================================================

/**
 * Compress `nx` Nx monorepo build/test/lint output.
 *
 * Keeps NX header, per-project status, and summary lines; drops separator /
 * cache-hit / successful-task-header noise; keeps up to _FAIL_TASK_SAMPLE failed
 * task headers on a non-zero exit. See the Python docstring for the full model.
 */
export class NxFilter extends Filter {
  override name = "nx";
  override binaries: ReadonlySet<string> = new Set(["nx", "npx", "pnpx"]);

  override matches(argv: string[]): boolean {
    if (argv.length === 0) {
      return false;
    }
    const stem = _pathStem(argv[0]!).toLowerCase();
    if (stem === "nx") {
      return true;
    }
    // npx nx ... / pnpx nx ...
    return (stem === "npx" || stem === "pnpx") && argv.length > 1 && argv[1]!.toLowerCase() === "nx";
  }

  /** Show up to this many failed task headers. */
  _FAIL_TASK_SAMPLE = 5;

  override compress(stdout: string, stderr: string, exit_code: number, _argv: string[]): string {
    const combined = this._combine_output(stdout, stderr);
    const lines = combined.split("\n");
    const kept: string[] = [];
    let dropped_separators = 0;
    let dropped_cache = 0;
    let dropped_task_headers = 0;
    let fail_task_count = 0;

    for (const line of lines) {
      // Always keep NX main header lines
      if (_reMatch(_NX_HEADER_RE, line)) {
        kept.push(line);
        continue;
      }
      // Per-project status lines (✔ / ✖ / ✓ / ✗)
      if (_reMatch(_NX_STATUS_RE, line)) {
        kept.push(line);
        continue;
      }
      // Summary lines
      if (_reMatch(_NX_SUMMARY_RE, line)) {
        kept.push(line);
        continue;
      }
      // Separator / decoration lines — drop silently
      if (_reMatch(_NX_SEPARATOR_RE, line)) {
        dropped_separators += 1;
        continue;
      }
      // Cache-hit annotations — check BEFORE task-header because a cache
      // line looks like "> nx run @scope/pkg:target  [existing outputs…]"
      // which would match _NX_TASK_HEADER_RE first if we don't short-circuit.
      if (_reTest(_NX_CACHE_HIT_RE, line)) {
        dropped_cache += 1;
        continue;
      }
      // Per-task headers ("> nx run @scope/pkg:target") — keep a few failed ones
      if (_reMatch(_NX_TASK_HEADER_RE, line)) {
        if (exit_code !== 0 && fail_task_count < this._FAIL_TASK_SAMPLE) {
          kept.push(line);
          fail_task_count += 1;
        } else {
          dropped_task_headers += 1;
        }
        continue;
      }
      // Always keep error signals
      if (_reTest(_ERROR_SIGNAL_RE, line)) {
        kept.push(line);
        continue;
      }
      kept.push(line);
    }

    const notes: string[] = [];
    _maybe_note(notes, dropped_separators, `dropped ${dropped_separators} separator/decoration lines`);
    _maybe_note(notes, dropped_cache, `dropped ${dropped_cache} cache-hit annotation lines`);
    _maybe_note(notes, dropped_task_headers, `dropped ${dropped_task_headers} per-task header lines`);
    NxFilter._emit_notes(kept, notes);
    return NxFilter._finalize(kept);
  }
}

// ===========================================================================
// LernaFilter (Python lines ~17510-17585)
// ===========================================================================

/**
 * Compress `lerna` monorepo task runner output.
 *
 * Drops verbose/timing and notice lines; samples the first _SAMPLE_SIZE
 * "Ran npm script" per-package lines and counts the rest; keeps outcome and
 * general info lines. See the Python docstring for the full model.
 */
export class LernaFilter extends Filter {
  override name = "lerna";
  override binaries: ReadonlySet<string> = new Set(["lerna"]);

  _SAMPLE_SIZE = 5;

  override compress(stdout: string, stderr: string, _exit_code: number, _argv: string[]): string {
    const combined = this._combine_output(stdout, stderr);
    const lines = combined.split("\n");
    const kept: string[] = [];
    let dropped_verbose = 0;
    let dropped_notice = 0;
    const ran_sample: string[] = [];
    let ran_extra = 0;

    for (const line of lines) {
      // Drop verbose timing lines
      if (_reMatch(_LERNA_VERBOSE_RE, line)) {
        dropped_verbose += 1;
        continue;
      }
      // Drop notice lines (changelog, publish, git-tag noise)
      if (_reMatch(_LERNA_NOTICE_RE, line)) {
        dropped_notice += 1;
        continue;
      }
      // Per-package "Ran npm script" info timing lines — sample
      if (_reMatch(_LERNA_RAN_RE, line)) {
        if (ran_sample.length < this._SAMPLE_SIZE) {
          ran_sample.push(line);
        } else {
          ran_extra += 1;
        }
        continue;
      }
      // Always keep outcome lines
      if (_reMatch(_LERNA_OUTCOME_RE, line)) {
        kept.push(line);
        continue;
      }
      // Keep other lerna info lines (general status, package counts)
      if (_reMatch(_LERNA_INFO_RE, line)) {
        kept.push(line);
        continue;
      }
      // Keep everything else (npm script output, error text)
      kept.push(line);
    }

    const out: string[] = [];
    out.push(...ran_sample);
    if (ran_extra) {
      out.push(
        `[token-goat: +${ran_extra} more 'Ran npm script' lines; ` +
          `disable via TOKEN_GOAT_BASH_COMPRESS for full list]`,
      );
    }
    out.push(...kept);
    const notes: string[] = [];
    _maybe_note(notes, dropped_verbose, `dropped ${dropped_verbose} lerna verb/timing lines`);
    _maybe_note(notes, dropped_notice, `dropped ${dropped_notice} lerna notice lines`);
    LernaFilter._emit_notes(out, notes);
    return LernaFilter._finalize(out);
  }
}

// ===========================================================================
// Turborepo — regexes (Python lines ~17700-17731)
// ===========================================================================

// Turbo task header: "• Packages in scope: app-a, app-b, ..."
const _TURBO_SCOPE_RE: RegExp = /^[•*] Packages in scope:/;
// Turbo task start line: "• Running build in 3 packages"  or  "tasks: 4"
const _TURBO_RUNNING_RE: RegExp = /^(?:[•*] Running \w+ in \d+|tasks:\s*\d+)/;
// Turbo per-package task line: "  @scope/pkg:build: ..." (any line from a task).
// Group 1 captures the "package:task" task key (e.g. "docs:build").
// Lines are typically indented by 2 spaces.
const _TURBO_TASK_LINE_RE: RegExp = /^\s*([\w@/-]+:[\w-]+):\s/;
// Turbo cache-hit replay lines — always drop (noise)
const _TURBO_CACHE_HIT_RE: RegExp = /cache hit,\s*replaying\s+(?:output|logs)/i;
// Turbo cache miss lines — keep (useful: shows what had to rebuild)
const _TURBO_CACHE_MISS_RE: RegExp = /cache miss/i;
// Turbo summary line: " Tasks:    5 successful, 5 total"
const _TURBO_SUMMARY_RE: RegExp = /^\s*(?:Tasks|Time|Cached):\s/;
// Turbo decorator / separator lines
const _TURBO_SEPARATOR_RE: RegExp = /^(?:\s*[─━═\-]{10,}\s*|>>> FULL TURBO)$/;

// Reference the parity-only constant (declared in Python but not consulted by
// TurboFilter.compress) so it is not flagged as unused.
void _TURBO_CACHE_MISS_RE;

// ===========================================================================
// TurboFilter (Python lines ~17734-17833)
// ===========================================================================

/**
 * Compress `turbo run` Turborepo task output.
 *
 * Keeps scope/running headers and the summary table; keeps cache-miss task
 * lines; drops cache-hit replay lines and the body lines of known cache-hit
 * tasks (surfacing error signals even from those). See the Python docstring for
 * the full model.
 */
export class TurboFilter extends Filter {
  override name = "turbo";
  override binaries: ReadonlySet<string> = new Set(["turbo", "npx", "pnpx"]);

  override matches(argv: string[]): boolean {
    if (argv.length === 0) {
      return false;
    }
    const stem = _pathStem(argv[0]!).toLowerCase();
    if (stem === "turbo") {
      return true;
    }
    // npx turbo ... / pnpx turbo ...
    return (
      (stem === "npx" || stem === "pnpx") && argv.length > 1 && argv[1]!.toLowerCase() === "turbo"
    );
  }

  // Maximum number of per-package verbose output lines to keep per package
  // (applies only to the non-cache-hit task body lines)
  _BODY_SAMPLE = 20;

  override compress(stdout: string, stderr: string, _exit_code: number, _argv: string[]): string {
    const combined = this._combine_output(stdout, stderr);
    const lines = combined.split("\n");
    const kept: string[] = [];
    let dropped_cache_hit = 0;
    let dropped_task_body = 0;
    // Set of "package:task" keys whose output should be dropped (cache hits)
    const cache_hit_tasks = new Set<string>();

    for (const line of lines) {
      // Scope / running header — always keep
      if (_reMatch(_TURBO_SCOPE_RE, line) || _reMatch(_TURBO_RUNNING_RE, line)) {
        kept.push(line);
        continue;
      }
      // Summary table — always keep
      if (_reMatch(_TURBO_SUMMARY_RE, line)) {
        kept.push(line);
        continue;
      }
      // Separator lines — drop silently
      if (_reMatch(_TURBO_SEPARATOR_RE, line)) {
        continue;
      }
      // Per-task line: any line from a package (header OR body)
      const tm = _reMatchObj(_TURBO_TASK_LINE_RE, line);
      if (tm) {
        const task_key = tm[1]!;
        if (_reTest(_TURBO_CACHE_HIT_RE, line)) {
          // Cache-hit announcement — record and drop
          cache_hit_tasks.add(task_key);
          dropped_cache_hit += 1;
          continue;
        }
        if (cache_hit_tasks.has(task_key)) {
          // Body line from a known cache-hit task — drop
          // Always surface error signals even from cache-hit tasks
          if (_reTest(_ERROR_SIGNAL_RE, line)) {
            kept.push(line);
          } else {
            dropped_task_body += 1;
          }
          continue;
        }
        // Cache-miss task header or body — keep
        kept.push(line);
        continue;
      }
      // Error lines — always keep regardless of mode
      if (_reTest(_ERROR_SIGNAL_RE, line)) {
        kept.push(line);
        continue;
      }
      kept.push(line);
    }

    const notes: string[] = [];
    if (dropped_cache_hit) {
      notes.push(
        `dropped ${dropped_cache_hit} cache-hit task header` +
          `${dropped_cache_hit !== 1 ? "s" : ""}`,
      );
    }
    if (dropped_task_body) {
      notes.push(
        `dropped ${dropped_task_body} cache-hit task body line` +
          `${dropped_task_body !== 1 ? "s" : ""}`,
      );
    }
    TurboFilter._emit_notes(kept, notes);
    return TurboFilter._finalize(kept);
  }
}
