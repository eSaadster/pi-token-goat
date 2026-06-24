/**
 * bash_compress E2E TEST-RUNNER FILTERS — TypeScript port of the
 * PlaywrightFilter / CypressFilter subclasses from src/token_goat/bash_compress.py.
 *
 * Two filters subclass the concrete Filter base from ./framework.js:
 *   - PlaywrightFilter — `playwright` / `npx playwright` / `pnpx` / `bunx`
 *                       (test/show-trace/codegen/screenshot/pdf/install).
 *                       Overrides matches() (binary + subcommand gating, incl.
 *                       npx/pnpx/bunx prefix handling) and compress() (suppress
 *                       ✓/✔ passed-test lines + browser-download progress).
 *   - CypressFilter    — `cypress` / `npx cypress` (run/open). Overrides
 *                       matches() (same prefix handling) and compress() (a
 *                       NORMAL/PRE_BOX/IN_BOX/IN_VIDEO/IN_SUMMARY state machine
 *                       that drops the Run-Starting metadata box, per-spec
 *                       Results boxes, the Video section, cosmetic separators,
 *                       and — on exit 0 — passing test lines).
 *
 * REGISTRY ORDER (critical): PlaywrightFilter MUST precede BunFilter and
 * NodePackageFilter so `bunx playwright test` / `npx playwright test` route here
 * rather than the generic bun/npx handlers. Python places the pair at registry
 * positions 8-9 (right after NpmInstallFilter, before TscFilter); the barrel
 * inserts them at that exact slot.
 *
 * ---------------------------------------------------------------------------
 * Parity notes (Python -> TS)
 * ---------------------------------------------------------------------------
 *  - Python identifiers preserved EXACTLY: PascalCase class names; snake_case
 *    methods/fields (matches, compress, _SUBCMDS); snake_case module-private
 *    regex constants (_PW_PASS_RE, _PW_DOWNLOAD_RE, _CY_SEPARATOR_RE,
 *    _CY_RUN_START_RE, _CY_RESULTS_RE, _CY_VIDEO_RE, _CY_RUN_FINISH_RE,
 *    _CY_BOX_TOP_RE, _CY_BOX_SIDE_RE, _CY_BOX_BOTTOM_RE, _CY_PASS_TEST_RE).
 *  - re.compile(...) -> top-level RegExp compiled once. re.IGNORECASE -> "i".
 *  - Python re.Pattern.match(line) is START-anchored (NOT end-anchored); emulated
 *    via _reMatch (non-global clone + index===0). Every regex here also carries
 *    an explicit ^ so a plain .test would agree, but _reMatch is the faithful
 *    match() translation and is robust if an anchor is ever dropped.
 *  - Python `Path(s.replace("\\", "/")).stem.lower()` -> node:path
 *    `path.parse(s.replace(/\\/g, "/")).name.toLowerCase()` (final path
 *    component, last suffix stripped — identical stem semantics).
 *  - Python `str.splitlines(keepends=True)` -> _splitlinesKeepends (splits on
 *    \n \r\n \r \v \f \x1c \x1d \x1e \x85 U+2028 U+2029, terminators retained,
 *    NO trailing empty element — verified against CPython).
 *  - Python `line.rstrip("\n")` -> line.replace(/\n+$/g, "") (trailing \n run
 *    only, \r preserved — matches rstrip("\n")). `line.rstrip()` ->
 *    line.trimEnd() (all trailing whitespace).
 *  - Python f-strings -> JS template literals. `not argv[1:]` -> argv.length<=1.
 *    `"error" in s.lower()` -> s.toLowerCase().includes("error").
 *  - frozenset([…]) subcommand tables -> ReadonlySet<string> instance fields.
 *  - framework is a SIBLING (./framework.js). verbatimModuleSyntax is on ->
 *    nothing here is type-only. noImplicitOverride is on -> every overridden
 *    member carries `override`.
 *  - Module-global mutable state: NONE. Every counter/list is a local inside
 *    compress(); no registerReset seam is needed.
 */

import * as path from "node:path";

import { Filter, _maybe_note } from "./framework.js";

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
  const m = _nonGlobal(re).exec(line);
  return m !== null && m.index === 0;
}

/**
 * Python str.splitlines(keepends=True): split at line boundaries and KEEP each
 * terminator on its line. Boundaries mirrored from CPython: \n \r\n \r \v \f
 * \x1c \x1d \x1e \x85 U+2028 U+2029. A final line with no terminator is still
 * emitted; a trailing terminator produces NO extra empty element (unlike
 * str.split). Returns [] for the empty string.
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

// ===========================================================================
// Playwright E2E test runner — Python ~23831-23917
// ===========================================================================

// Passing-test line: indent + ✓/✔ unicode check mark + whitespace + content.
// Python: re.compile(r"^\s+[✓✔]\s")
const _PW_PASS_RE: RegExp = /^\s+[✓✔]\s/;

// Browser-download / install-progress lines from `playwright install`.
// Python: re.compile(r"^\s*(Downloading|Downloaded|Installing)\s+\w"
//                   r"|^\s*[\d.]+\s+[KMG]b\s+\[", re.IGNORECASE)
const _PW_DOWNLOAD_RE: RegExp =
  /^\s*(Downloading|Downloaded|Installing)\s+\w|^\s*[\d.]+\s+[KMG]b\s+\[/i;

export class PlaywrightFilter extends Filter {
  override name = "playwright";
  override binaries: ReadonlySet<string> = new Set(["playwright"]);

  readonly _SUBCMDS: ReadonlySet<string> = new Set([
    "test",
    "show-trace",
    "codegen",
    "screenshot",
    "pdf",
    "install",
  ]);

  override matches(argv: string[]): boolean {
    const _base = (s: string): string =>
      path.parse(s.replace(/\\/g, "/")).name.toLowerCase();

    if (argv.length === 0) {
      return false;
    }
    const base = _base(argv[0]!);
    if (base === "playwright") {
      return argv.length <= 1 || this._SUBCMDS.has(argv[1]!.toLowerCase());
    }
    if (base === "npx" || base === "pnpx" || base === "bunx") {
      const rest = argv.slice(1).filter((a) => !a.startsWith("-"));
      if (rest.length > 0 && _base(rest[0]!) === "playwright") {
        return rest.length <= 1 || this._SUBCMDS.has(rest[1]!.toLowerCase());
      }
    }
    return false;
  }

  override compress(
    stdout: string,
    stderr: string,
    _exit_code: number,
    _argv: string[],
  ): string {
    const lines = _splitlinesKeepends(stdout + stderr);
    const kept: string[] = [];
    let suppressed = 0;
    for (const line of lines) {
      const stripped = line.replace(/\n+$/g, "");
      if (_reMatch(_PW_PASS_RE, stripped)) {
        suppressed += 1;
        continue;
      }
      if (_reMatch(_PW_DOWNLOAD_RE, stripped)) {
        suppressed += 1;
        continue;
      }
      kept.push(line);
    }
    const notes: string[] = [];
    _maybe_note(
      notes,
      suppressed,
      `suppressed ${suppressed} passed-test / install-progress lines`,
    );
    Filter._emit_notes(kept, notes);
    return Filter._finalize(kept);
  }
}

// ===========================================================================
// Cypress E2E test runner — Python ~23921-24078
// ===========================================================================

// Pure separator lines: 30+ horizontal-rule (U+2500) or equals characters.
// Python: re.compile(r"^\s*[─=]{30,}\s*$")
const _CY_SEPARATOR_RE: RegExp = /^\s*[─=]{30,}\s*$/;

// Section headers emitted by Cypress run.
const _CY_RUN_START_RE: RegExp = /^\s*\(Run Starting\)\s*$/;
const _CY_RESULTS_RE: RegExp = /^\s*\(Results\)\s*$/;
const _CY_VIDEO_RE: RegExp = /^\s*\(Video\)\s*$/;
const _CY_RUN_FINISH_RE: RegExp = /^\s*\(Run Finished\)\s*$/;

// Box-drawing characters (Unicode U+2500 block): top/bottom borders, side bars.
const _CY_BOX_TOP_RE: RegExp = /^\s*┌[─]+┐\s*$/;
const _CY_BOX_SIDE_RE: RegExp = /^\s*│/;
const _CY_BOX_BOTTOM_RE: RegExp = /^\s*└[─]+┘\s*$/;

// Passing test line: indent + ✓/✔ unicode check mark + non-space content.
// Python: re.compile(r"^\s+[✓✔]\s+\S")
const _CY_PASS_TEST_RE: RegExp = /^\s+[✓✔]\s+\S/;

export class CypressFilter extends Filter {
  override name = "cypress";
  override binaries: ReadonlySet<string> = new Set(["cypress"]);

  readonly _SUBCMDS: ReadonlySet<string> = new Set(["run", "open"]);

  override matches(argv: string[]): boolean {
    const _base = (s: string): string =>
      path.parse(s.replace(/\\/g, "/")).name.toLowerCase();

    if (argv.length === 0) {
      return false;
    }
    const base = _base(argv[0]!);
    if (base === "cypress") {
      return argv.length <= 1 || this._SUBCMDS.has(argv[1]!.toLowerCase());
    }
    if (base === "npx" || base === "pnpx" || base === "bunx") {
      const rest = argv.slice(1).filter((a) => !a.startsWith("-"));
      if (rest.length > 0 && _base(rest[0]!) === "cypress") {
        return rest.length <= 1 || this._SUBCMDS.has(rest[1]!.toLowerCase());
      }
    }
    return false;
  }

  override compress(
    stdout: string,
    stderr: string,
    exit_code: number,
    _argv: string[],
  ): string {
    const lines = _splitlinesKeepends(stdout + stderr);
    const kept: string[] = [];

    // State machine: NORMAL | PRE_BOX | IN_BOX | IN_VIDEO | IN_SUMMARY
    let state: "NORMAL" | "PRE_BOX" | "IN_BOX" | "IN_VIDEO" | "IN_SUMMARY" =
      "NORMAL";

    let n_header = 0; // lines from Run Starting / Results boxes
    let n_sep = 0; // separator lines
    let n_video = 0; // video-section lines
    let n_pass = 0; // passing test lines

    for (const line of lines) {
      const s = line.trimEnd();

      if (state === "IN_SUMMARY") {
        kept.push(line);
        continue;
      }

      if (state === "IN_VIDEO") {
        if (_reMatch(_CY_RUN_FINISH_RE, s)) {
          state = "IN_SUMMARY";
          kept.push(line);
        } else if (s.toLowerCase().includes("error")) {
          kept.push(line);
        } else {
          n_video += 1;
        }
        continue;
      }

      if (state === "IN_BOX") {
        if (!s.toLowerCase().includes("error")) {
          n_header += 1;
          if (_reMatch(_CY_BOX_BOTTOM_RE, s)) {
            state = "NORMAL";
          }
        } else {
          kept.push(line);
          if (_reMatch(_CY_BOX_BOTTOM_RE, s)) {
            state = "NORMAL";
          }
        }
        continue;
      }

      if (state === "PRE_BOX") {
        if (_reMatch(_CY_BOX_TOP_RE, s)) {
          if (!s.toLowerCase().includes("error")) {
            n_header += 1;
          } else {
            kept.push(line);
          }
          state = "IN_BOX";
        } else if (s === "") {
          n_header += 1;
        } else {
          kept.push(line);
          state = "NORMAL";
        }
        continue;
      }

      // NORMAL state
      if (_reMatch(_CY_RUN_START_RE, s) || _reMatch(_CY_RESULTS_RE, s)) {
        if (!s.toLowerCase().includes("error")) {
          n_header += 1;
          state = "PRE_BOX";
        } else {
          kept.push(line);
        }
        continue;
      }

      if (_reMatch(_CY_VIDEO_RE, s)) {
        if (!s.toLowerCase().includes("error")) {
          n_video += 1;
          state = "IN_VIDEO";
        } else {
          kept.push(line);
        }
        continue;
      }

      if (_reMatch(_CY_RUN_FINISH_RE, s)) {
        state = "IN_SUMMARY";
        kept.push(line);
        continue;
      }

      if (_reMatch(_CY_SEPARATOR_RE, s)) {
        if (!s.toLowerCase().includes("error")) {
          n_sep += 1;
        } else {
          kept.push(line);
        }
        continue;
      }

      if (
        exit_code === 0 &&
        _reMatch(_CY_PASS_TEST_RE, s) &&
        !s.toLowerCase().includes("error")
      ) {
        n_pass += 1;
        continue;
      }

      kept.push(line);
    }

    // EOF guard: if the state machine is still in a non-NORMAL state, the input
    // was truncated (a box/video section never closed). Emit a note so the
    // caller knows the output may be incomplete.
    if (state === "IN_BOX" || state === "PRE_BOX") {
      kept.push("[token-goat] warning: cypress output truncated inside header box");
    } else if (state === "IN_VIDEO") {
      kept.push(
        "[token-goat] warning: cypress output truncated inside video section",
      );
    }

    const notes: string[] = [];
    _maybe_note(notes, n_header, `suppressed ${n_header} cypress header/results box lines`);
    _maybe_note(notes, n_sep, `suppressed ${n_sep} separator lines`);
    _maybe_note(notes, n_video, `suppressed ${n_video} video processing lines`);
    _maybe_note(notes, n_pass, `suppressed ${n_pass} passing test lines`);
    Filter._emit_notes(kept, notes);
    return Filter._finalize(kept);
  }
}
