/**
 * bash_compress GO-TOOLCHAIN FILTERS — TypeScript port of the Go toolchain
 * Filter subclasses from src/token_goat/bash_compress.py (Python lines
 * ~7804-8394): the go-test/go/golangci-lint trio plus the module-level regexes
 * they share.
 *
 * Three filters subclass the concrete Filter base from ./framework.js and
 * override matches() / compress() with per-tool structural compression:
 *   - GoTestFilter        — `go test` (per-testcase RUN/PASS/FAIL collapsing,
 *                            `-json` passthrough, `-race` data-race block keep).
 *   - GoFilter            — `go build` / `run` / `get` / `mod` / `install` /
 *                            `clean` / `generate` / `vet` / `env` / `fix`
 *                            (download collapsing, package-header suppression).
 *   - GolangciLintFilter  — `golangci-lint run` (per-(file,linter) dedup,
 *                            structured-log noise suppression, placeholders).
 *
 * GoTestFilter is registered BEFORE GoFilter so `go test` is claimed by the
 * test filter; GoFilter's _GO_SUBCOMMANDS deliberately omits "test". This file
 * preserves that ordering only insofar as it ports the per-class matches()
 * logic verbatim — the FILTERS registry ordering is wired by the barrel one
 * level up (out of scope here).
 *
 * ---------------------------------------------------------------------------
 * Parity notes (Python -> TS)
 * ---------------------------------------------------------------------------
 *  - Python identifiers are preserved EXACTLY: PascalCase class names
 *    (GoTestFilter, GoFilter, GolangciLintFilter), snake_case methods/fields
 *    (matches, compress, _compress_go_build_like, _compress_go_get,
 *    _compress_go_mod_tidy, _compress_go_vet_like, _GO_SUBCOMMANDS,
 *    _GOROUTINE_HEADER_RE, _MAX_ISSUES_PER_FILE_LINTER, _KEEP_FIRST_N), and the
 *    module-private regex constants (_GO_TEST_*, _GO_RACE_*, _GO_BUILD_*,
 *    _GO_MOD_*, _GO_GET_*, _GO_VET_*, _GO_GENERATE_*, _GO_PKG_*, _GO_ERROR_RE,
 *    _GOLANGCI_*).
 *  - re.compile(...) -> top-level RegExp compiled once at module load. IGNORECASE
 *    -> "i". The named groups in _GOLANGCI_ISSUE_RE / _GOLANGCI_LINTER_HEADER_RE
 *    are ported as JS named groups (?<file>...) so m.groups.file etc. read 1:1.
 *  - Python re.Pattern.match(line) is anchored at the START (not end-anchored);
 *    emulated via _reMatch (non-global clone + index===0). re.match returning a
 *    match object (GolangciLintFilter reads capture groups) goes through
 *    _reMatchObj.
 *  - Path(argv[0]).stem.lower() -> _pathStemLower (final path component after
 *    normalising backslashes, last extension stripped, lowercased) — matching
 *    the framework's _pathStem semantics for the cases the Go matches() exercise
 *    ("go", "go.exe", "/usr/local/go/bin/go", "golangci-lint").
 *  - _positional_args is imported from ./framework.js (the framework re-exports
 *    the module-level helper the Python source uses for subcommand detection).
 *  - Byte/line caps and blank-line squeezing are delegated to the framework via
 *    Filter._finalize / Filter._emit_notes / _maybe_note / _combine_output — no
 *    framework helper is re-implemented here.
 *  - Module-global mutable state: NONE. All per-call counters/dicts are locals
 *    inside compress(); the GolangciLintFilter issue_counts map is a per-call
 *    Map, so no registerReset seam is needed.
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
 * filters that read capture groups. Non-global clone so lastIndex never leaks.
 */
function _reMatchObj(re: RegExp, line: string): RegExpExecArray | null {
  const r = _nonGlobal(re);
  const m = r.exec(line);
  return m !== null && m.index === 0 ? m : null;
}

/**
 * Python Path(p).stem.lower() — the final path component (after normalising
 * backslashes to forward slashes) with its LAST suffix removed, lowercased.
 * Mirrors the framework's _pathStem: a leading-dot dotfile keeps its name and a
 * trailing dot is not a suffix.
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

// ===========================================================================
// Go test regexes (Python lines ~7804-7848).
//
// `go test [-v] ./...` emits a distinctive line shape per testcase that is
// disjoint from `go build` output, so it warrants dedicated handling.  The
// patterns below match the official `testing` package format documented at
// https://pkg.go.dev/testing#hdr-Subtests_and_Sub_benchmarks.
// ===========================================================================

// Python: re.compile(r"^=== (RUN|PAUSE|CONT|NAME)\s")
const _GO_TEST_RUN_RE: RegExp = /^=== (RUN|PAUSE|CONT|NAME)\s/;
// `go test -race` data-race report fences: "==================" lines that
// surround a WARNING: DATA RACE block.
// Python: re.compile(r"^={10,}\s*$")
const _GO_RACE_FENCE_RE: RegExp = /^={10,}\s*$/;
// Python: re.compile(r"^WARNING: DATA RACE")
const _GO_RACE_WARNING_RE: RegExp = /^WARNING: DATA RACE/;
// Python: re.compile(r"^\s*--- PASS:\s")
const _GO_TEST_PASS_RE: RegExp = /^\s*--- PASS:\s/;
// Python: re.compile(r"^\s*--- FAIL:\s")
const _GO_TEST_FAIL_RE: RegExp = /^\s*--- FAIL:\s/;
// Final per-package result lines: `ok pkg 1.234s` / `FAIL pkg 0.5s` /
// `?  pkg [no test files]`.  Preserved verbatim so the agent sees per-package
// outcomes.
// Python: re.compile(r"^(ok|FAIL|---\sFAIL|\?)\s+\S")
const _GO_TEST_PKG_RESULT_RE: RegExp = /^(ok|FAIL|---\sFAIL|\?)\s+\S/;
// Pass A: unconditional RUN/PAUSE/CONT suppression (NAME kept for sub-test labeling)
// Python: re.compile(r"^=== (RUN|PAUSE|CONT)\s")
const _GO_TEST_RPC_RE: RegExp = /^=== (RUN|PAUSE|CONT)\s/;

// go build / go mod / go vet / go generate patterns
// Python: re.compile(r"^#\s+[a-zA-Z0-9./\-]+")
const _GO_BUILD_PKG_HEADER_RE: RegExp = /^#\s+[a-zA-Z0-9./\-]+/;
// Python: re.compile(r"^go: (downloading|extracting) ")
const _GO_MOD_DOWNLOADING_RE: RegExp = /^go: (downloading|extracting) /;
// Python: re.compile(r"^go: vet ")
const _GO_VET_PROGRESS_RE: RegExp = /^go: vet /;
// Python: re.compile(r"^go:generate ")
const _GO_GENERATE_TRIGGER_RE: RegExp = /^go:generate /;
// Generic go error pattern: file:line:col: error|warning message
// Python: re.compile(r"^[^:\s]+:\d+:\d+:\s+(?:error|warning):")
const _GO_ERROR_RE: RegExp = /^[^:\s]+:\d+:\d+:\s+(?:error|warning):/;

// ===========================================================================
// GoTestFilter (Python lines ~7851-8058).
// ===========================================================================

/**
 * Compress `go test` output.
 *
 * Go test emits a line per testcase plus pass/fail summaries. When tests pass,
 * the output is hundreds of lines of `=== RUN TestName` / `--- PASS: TestName`
 * pairs plus final summary. Failures emit stderr blocks interleaved with the
 * pass/fail lines.
 *
 * Compression model:
 *
 *  - Keep: FAIL / ERROR blocks (entire stderr captured under the RUN line).
 *  - Keep: Final summary (ok, FAILED, coverage %).
 *  - Drop: All `=== RUN / PAUSE / CONT / NAME` lines outside FAIL blocks
 *    (count them).
 *  - Drop: All `--- PASS: TestName` lines (count them).
 *  - Drop: `go: downloading ...` lines (often hundreds when deps aren't cached).
 *  - Skip: `-json` output — already machine-readable and compact; pass through
 *    unchanged so the caller can parse it (compression would corrupt JSON).
 *  - SKIP lines: collapsed separately since they indicate intentionally skipped
 *    tests (not failures); count reported in notes.
 *  - Race detector blocks (`go test -race`): `==================` /
 *    `WARNING: DATA RACE` fence blocks are kept verbatim as they are critical
 *    signal.  Goroutine stack frames inside a race block are collapsed to the
 *    first 5 frames + count marker to limit line count on deep stacks.
 */
export class GoTestFilter extends Filter {
  override name = "go-test";
  override binaries: ReadonlySet<string> = new Set(["go"]);

  // Python: re.compile(r"^(?:Goroutine \d+|Previous|Current)\s")
  static readonly _GOROUTINE_HEADER_RE: RegExp = /^(?:Goroutine \d+|Previous|Current)\s/;

  override matches(argv: string[]): boolean {
    if (argv.length === 0) {
      return false;
    }
    const stem = _pathStemLower(argv[0]!);
    if (stem !== "go") {
      return false;
    }
    // Fire only for `go test` subcommand; other go subcommands fall through.
    const positionals = _positional_args(argv.slice(1));
    return positionals.slice(0, 1).length === 1 && positionals[0] === "test";
  }

  override compress(stdout: string, stderr: string, _exit_code: number, argv: string[]): string {
    // `go test -json` emits JSON objects one per line.  These are already
    // compact and machine-readable; compressing them would corrupt the JSON
    // stream and break any downstream parser (e.g. gotestsum).  Pass through.
    if (argv.includes("-json")) {
      const mergedJson = this._combine_output(stdout, stderr);
      return mergedJson;
    }

    const merged = this._combine_output(stdout, stderr);
    const lines = merged.split("\n");
    const kept: string[] = [];
    let pass_count = 0;
    let skip_count = 0;
    let in_fail_block = false;
    let dropped_run = 0;
    let dropped_download = 0;
    // Race detector state: a race block spans from "==================" before
    // "WARNING: DATA RACE" through the closing "==================".
    let in_race_block = false;
    let race_block_lines: string[] = [];
    let race_pending_fence = false; // leading "==================" before WARNING seen
    const _MAX_RACE_GOROUTINE_FRAMES = 5;
    let race_count = 0;

    const _GOROUTINE_HEADER_RE = GoTestFilter._GOROUTINE_HEADER_RE;

    /** Emit a race block with goroutine-stack frame collapsing. */
    const _flush_race_block = (): void => {
      // Walk the block, collapsing goroutine stack frames > limit.
      let in_goroutine = false;
      let goroutine_frame_count = 0;
      let goroutine_frames_dropped = 0;
      for (const rline of race_block_lines) {
        if (_reMatch(_GOROUTINE_HEADER_RE, rline)) {
          // Flush frame-drop note for the previous goroutine section.
          if (goroutine_frames_dropped) {
            kept.push(
              `    [token-goat: +${goroutine_frames_dropped} goroutine frames omitted]`,
            );
          }
          in_goroutine = true;
          goroutine_frame_count = 0;
          goroutine_frames_dropped = 0;
          kept.push(rline);
          continue;
        }
        if (in_goroutine) {
          // Stack frame lines are indented with whitespace.
          if ((rline.startsWith(" ") || rline.startsWith("\t")) && rline.trim()) {
            goroutine_frame_count += 1;
            if (goroutine_frame_count <= _MAX_RACE_GOROUTINE_FRAMES) {
              kept.push(rline);
            } else {
              goroutine_frames_dropped += 1;
            }
            continue;
          } else {
            // Leaving goroutine section.
            if (goroutine_frames_dropped) {
              kept.push(
                `    [token-goat: +${goroutine_frames_dropped} goroutine frames omitted]`,
              );
            }
            in_goroutine = false;
            goroutine_frame_count = 0;
            goroutine_frames_dropped = 0;
          }
        }
        kept.push(rline);
      }
      // Final flush.
      if (goroutine_frames_dropped) {
        kept.push(
          `    [token-goat: +${goroutine_frames_dropped} goroutine frames omitted]`,
        );
      }
    };

    for (const line of lines) {
      if (line.startsWith("go: downloading")) {
        dropped_download += 1;
        continue;
      }

      // --- Race detector block handling ---
      // A race block: "==================" → "WARNING: DATA RACE" → ... → "==================".
      if (_reMatch(_GO_RACE_FENCE_RE, line)) {
        if (in_race_block) {
          // Closing fence — flush the collected block.
          race_block_lines.push(line);
          _flush_race_block();
          race_block_lines = [];
          in_race_block = false;
          race_pending_fence = false;
        } else if (!race_pending_fence) {
          // Opening fence — hold it until we confirm this is a race block.
          race_pending_fence = true;
          race_block_lines = [line];
        } else {
          // Two consecutive fences without WARNING in between — not a race block.
          kept.push(...race_block_lines);
          kept.push(line);
          race_block_lines = [];
          race_pending_fence = false;
        }
        continue;
      }

      if (race_pending_fence) {
        race_block_lines.push(line);
        if (_reMatch(_GO_RACE_WARNING_RE, line)) {
          in_race_block = true;
          race_count += 1;
          race_pending_fence = false;
        } else if (!line.trim()) {
          // Blank line right after fence = not a race block.
          kept.push(...race_block_lines);
          race_block_lines = [];
          race_pending_fence = false;
        }
        continue;
      }

      if (in_race_block) {
        race_block_lines.push(line);
        continue;
      }

      // Pass A: unconditionally suppress RUN/PAUSE/CONT outside and inside fail blocks
      if (_reMatch(_GO_TEST_RPC_RE, line)) {
        dropped_run += 1;
        continue;
      }
      // FAIL opens a multi-line block preserved until next testcase.
      if (_reMatch(_GO_TEST_FAIL_RE, line)) {
        in_fail_block = true;
        kept.push(line);
        continue;
      }
      if (_reMatch(_GO_TEST_PASS_RE, line)) {
        in_fail_block = false;
        pass_count += 1;
        continue;
      }
      // SKIP lines — not failures, not passes; count separately.
      if (_reMatch(/^\s*--- SKIP:\s/, line)) {
        skip_count += 1;
        continue;
      }
      if (_reMatch(_GO_TEST_RUN_RE, line)) {
        // === RUN / PAUSE / CONT inside a FAIL block: close block, keep line
        // for structure.  Outside a FAIL block: drop entirely.
        if (in_fail_block) {
          in_fail_block = false;
        } else {
          dropped_run += 1;
          continue;
        }
      }
      // Indented continuation lines under a FAIL block — preserve.
      if (in_fail_block && (line.startsWith("    ") || line.startsWith("\t") || !line.trim())) {
        kept.push(line);
        continue;
      }
      // Anything else: preserve and exit fail block.
      in_fail_block = false;
      kept.push(line);
    }

    // Flush any unclosed race block (e.g. truncated output).
    if (race_block_lines.length > 0) {
      _flush_race_block();
    }

    // Pass C: append aggregate package summary when both ok and FAIL packages present
    let _go_ok_count = 0;
    for (const _l of kept) {
      if (_reMatch(/^ok\s+\S+\s+\d/, _l)) {
        _go_ok_count += 1;
      }
    }
    let _go_fail_count = 0;
    for (const _l of kept) {
      if (_reMatch(/^FAIL\t\S+/, _l)) {
        _go_fail_count += 1;
      }
    }
    if (_go_ok_count + _go_fail_count >= 2) {
      kept.push(`[${_go_ok_count} packages passed, ${_go_fail_count} packages failed]`);
    }

    const notes: string[] = [];
    _maybe_note(notes, race_count, `kept ${race_count} DATA RACE block(s) verbatim (goroutine stacks collapsed)`);
    _maybe_note(notes, pass_count, `collapsed ${pass_count} PASS testcases`);
    _maybe_note(notes, skip_count, `collapsed ${skip_count} SKIP testcases`);
    _maybe_note(notes, dropped_run, `dropped ${dropped_run} === RUN/PAUSE/CONT lines`);
    _maybe_note(notes, dropped_download, `dropped ${dropped_download} 'go: downloading' lines`);
    GoTestFilter._emit_notes(kept, notes);
    return Filter._finalize(kept);
  }
}

// ===========================================================================
// GoFilter (go build / run / get / mod / install / clean) — Python lines
// ~8061-8250.
// ===========================================================================

// `go get` / `go mod download`: "go: downloading module@version"
// Python: re.compile(r"^go: (downloading|extracting|finding|fetching)\s")
const _GO_GET_DOWNLOADING_RE: RegExp = /^go: (downloading|extracting|finding|fetching)\s/;
// `go mod tidy` / `go get` informational lines (non-error)
// Python: re.compile(r"^go: found\s|^go: added\s|^go: upgraded\s|^go: downgraded\s|^go: removed\s")
const _GO_MOD_INFO_RE: RegExp = /^go: found\s|^go: added\s|^go: upgraded\s|^go: downgraded\s|^go: removed\s/;
// `go run` header / build phase noise
// Python: re.compile(r"^go: building\s|^go: warning:")
const _GO_RUN_BUILDING_RE: RegExp = /^go: building\s|^go: warning:/;
// `go test ./...` package-level result: "ok  pkg Xs" or "FAIL pkg Xs" or "?   pkg"
// Python: re.compile(r"^ok\s+\S")
const _GO_PKG_OK_RE: RegExp = /^ok\s+\S/;
// Python: re.compile(r"^(?:FAIL|---)\s+\S")
const _GO_PKG_FAIL_RE: RegExp = /^(?:FAIL|---)\s+\S/;
// Generic go error line (reuses _GO_ERROR_RE for file:line:col pattern)
// but also covers plain "go build: ..." error messages
// Python: re.compile(r"^go\s+\w+:|^# .*\(exit status")
const _GO_BUILD_ERROR_PLAIN_RE: RegExp = /^go\s+\w+:|^# .*\(exit status/;

/**
 * Compress `go build`, `go run`, `go get`, `go mod`, `go install` and `go clean`
 * output.
 *
 * These subcommands emit download-progress spam, `# pkg/path` package header
 * lines that carry no signal on success, and `go: downloading …` dependency-fetch
 * lines that can number in the hundreds. Signal is concentrated in error/warning
 * diagnostics and the final status line.
 *
 * Compression model:
 *
 *  - go build / go install / go run (pre-build phase): drop `# pkg/path`
 *    package-header lines when the build succeeds (they have no error following
 *    them); keep all file:line:col error and warning lines verbatim.
 *  - go get / go mod download: collapse `go: downloading …` / `go: extracting …`
 *    / `go: finding …` lines to a single count note.
 *  - go mod tidy: keep `go: found/added/upgraded/downgraded/removed …`
 *    module-change lines (these carry signal); collapse repetitive download lines.
 *  - go test ./... (package-level results only — per-test detail is handled by
 *    GoTestFilter): collapse `ok  pkg Xs` passing-package lines to a count; keep
 *    all `FAIL pkg` lines verbatim.
 *
 * `go test` is explicitly excluded from this filter's matches() so that
 * GoTestFilter (registered first) handles it.
 */
export class GoFilter extends Filter {
  override name = "go";
  override binaries: ReadonlySet<string> = new Set(["go"]);

  // Subcommands handled by this filter.  `test` is intentionally absent so
  // GoTestFilter (registered before GoFilter) wins for `go test`.
  static readonly _GO_SUBCOMMANDS: ReadonlySet<string> = new Set([
    "build", "run", "get", "mod", "install", "clean", "generate",
    "vet", "env", "fix",
  ]);

  override matches(argv: string[]): boolean {
    if (argv.length === 0) {
      return false;
    }
    const stem = _pathStemLower(argv[0]!);
    if (stem !== "go") {
      return false;
    }
    const positionals = _positional_args(argv.slice(1));
    // No subcommand (bare `go`) or unrecognised — don't match, let MakeFilter
    // catch it as a generic build tool.
    if (positionals.length === 0) {
      return false;
    }
    return GoFilter._GO_SUBCOMMANDS.has(positionals[0]!);
  }

  override compress(stdout: string, stderr: string, exit_code: number, argv: string[]): string {
    const positionals = _positional_args(argv.slice(1));
    const subcommand = positionals.length > 0 ? positionals[0]! : "";

    const merged = this._combine_output(stdout, stderr);
    const lines = merged.split("\n");

    if (
      subcommand === "get" ||
      (subcommand === "mod" && positionals.length > 1 && positionals[1] === "download")
    ) {
      return this._compress_go_get(lines);
    }
    if (subcommand === "mod") {
      return this._compress_go_mod_tidy(lines);
    }
    if (["build", "install", "run", "clean", "fix", "env"].includes(subcommand)) {
      return this._compress_go_build_like(lines, exit_code);
    }
    if (subcommand === "vet" || subcommand === "generate") {
      return this._compress_go_vet_like(lines, subcommand);
    }
    // Fallback: apply download-line collapsing only.
    return this._compress_go_get(lines);
  }

  // ------------------------------------------------------------------
  // Subcommand helpers
  // ------------------------------------------------------------------

  /** `go build` / `go install` / `go run`: drop headers, keep errors. */
  _compress_go_build_like(lines: string[], _exit_code: number): string {
    const kept: string[] = [];
    let dropped_headers = 0;
    let dropped_downloads = 0;

    for (const line of lines) {
      if (_reMatch(_GO_GET_DOWNLOADING_RE, line) || _reMatch(_GO_MOD_DOWNLOADING_RE, line)) {
        dropped_downloads += 1;
        continue;
      }
      if (_reMatch(_GO_BUILD_PKG_HEADER_RE, line)) {
        // On success these carry no info.  On failure they precede the actual
        // error lines which we always keep, so suppress them unconditionally —
        // the errors that follow are enough context.
        dropped_headers += 1;
        continue;
      }
      kept.push(line);
    }

    const notes: string[] = [];
    _maybe_note(notes, dropped_headers, `suppressed ${dropped_headers} package header lines`);
    _maybe_note(notes, dropped_downloads, `collapsed ${dropped_downloads} 'go: downloading' lines`);
    GoFilter._emit_notes(kept, notes);
    return Filter._finalize(kept);
  }

  /** `go get` / `go mod download`: collapse download lines to count. */
  _compress_go_get(lines: string[]): string {
    const kept: string[] = [];
    let dropped_downloads = 0;

    for (const line of lines) {
      if (_reMatch(_GO_GET_DOWNLOADING_RE, line) || _reMatch(_GO_MOD_DOWNLOADING_RE, line)) {
        dropped_downloads += 1;
        continue;
      }
      kept.push(line);
    }

    if (dropped_downloads) {
      kept.push(
        `[token-goat: collapsed ${dropped_downloads} ` +
          `'go: downloading/extracting' lines]`,
      );
    }
    return Filter._finalize(kept);
  }

  /** `go mod tidy`: keep module-change lines, collapse downloads. */
  _compress_go_mod_tidy(lines: string[]): string {
    const kept: string[] = [];
    let dropped_downloads = 0;

    for (const line of lines) {
      if (_reMatch(_GO_GET_DOWNLOADING_RE, line) || _reMatch(_GO_MOD_DOWNLOADING_RE, line)) {
        dropped_downloads += 1;
        continue;
      }
      // Module-change informational lines are always kept (signal).
      kept.push(line);
    }

    if (dropped_downloads) {
      kept.push(
        `[token-goat: collapsed ${dropped_downloads} ` +
          `'go: downloading/extracting' lines]`,
      );
    }
    return Filter._finalize(kept);
  }

  /** `go vet` / `go generate`: drop progress noise, keep warnings. */
  _compress_go_vet_like(lines: string[], subcommand: string): string {
    const kept: string[] = [];
    let dropped_progress = 0;

    for (const line of lines) {
      if (_reMatch(_GO_VET_PROGRESS_RE, line)) {
        dropped_progress += 1;
        continue;
      }
      if (_reMatch(_GO_GENERATE_TRIGGER_RE, line)) {
        dropped_progress += 1;
        continue;
      }
      kept.push(line);
    }

    if (dropped_progress) {
      kept.push(
        `[token-goat: dropped ${dropped_progress} '${subcommand}' progress lines]`,
      );
    }
    return Filter._finalize(kept);
  }
}

// ===========================================================================
// golangci-lint (Python lines ~8253-8394).
// ===========================================================================

// golangci-lint issue line: "file.go:12:34: message (lintername)"
// Python: re.compile(r"^(?P<file>[^:\s][^:]*\.go):(?P<line>\d+)(?::\d+)?:\s+(?P<msg>.+?)\s+\((?P<linter>[^)]+)\)\s*$")
const _GOLANGCI_ISSUE_RE: RegExp =
  /^(?<file>[^:\s][^:]*\.go):(?<line>\d+)(?::\d+)?:\s+(?<msg>.+?)\s+\((?<linter>[^)]+)\)\s*$/;
// golangci-lint summary line: "Found N issues."  or "Issues found."
// Python: re.compile(r"^(?:Found \d+ issues?\.|Issues? found\.|Run with --fix)|^(?:ERRO\s|WARN\s)", re.IGNORECASE)
const _GOLANGCI_SUMMARY_RE: RegExp =
  /^(?:Found \d+ issues?\.|Issues? found\.|Run with --fix)|^(?:ERRO\s|WARN\s)/i;
// golangci-lint section header emitted in `--out-format=text` (default):
// "  [file.go:12] message" block grouping markers are not present; but some CI
// setups print "Level XX: ..." or linter-name headers.
// Python: re.compile(r"^(?:\s*\[(?P<linter>[a-z0-9_-]+)\]\s*$|linter:\s+(?P<linter2>[a-z0-9_-]+)\s*$)", re.IGNORECASE)
const _GOLANGCI_LINTER_HEADER_RE: RegExp =
  /^(?:\s*\[(?<linter>[a-z0-9_-]+)\]\s*$|linter:\s+(?<linter2>[a-z0-9_-]+)\s*$)/i;
// golangci-lint version / configuration lines to drop (noise on success).
// Python: re.compile(r"^(?:golangci-lint\s+version|time=|level=(?:info|debug)|msg=\"(?:Running|Starting|Finishing))", re.IGNORECASE)
const _GOLANGCI_NOISE_RE: RegExp =
  /^(?:golangci-lint\s+version|time=|level=(?:info|debug)|msg="(?:Running|Starting|Finishing))/i;

/**
 * Compress `golangci-lint run` output.
 *
 * golangci-lint is a meta-linter that aggregates many Go linters and can emit
 * thousands of lines on a large codebase.  The dominant noise patterns:
 *
 *  - Repeated issues in the same file from the same linter (e.g. 50 `unused`
 *    issues in one file).
 *  - `time=...  level=info  msg=...` structured log lines from `--verbose` or CI
 *    configurations.
 *  - A large number of `(lintername)` tags repeated on every line.
 *
 * Compression model:
 *
 *  - Per-(file, linter) deduplication: when >10 issues share the same file and
 *    linter, keep the first 3 + a count marker.  The first issue always carries
 *    the file:line context the developer needs.
 *  - Drop `time=... level=info/debug msg=...` structured log lines.
 *  - Keep all error/warning/fatal log lines (`level=error`, `ERRO`).
 *  - Keep the final summary line verbatim.
 *  - Keep issues from different linters in separate groups so the agent sees
 *    linter-level signal rather than raw issue counts.
 *
 * Matches `golangci-lint run …` and `npx golangci-lint run …`.
 */
export class GolangciLintFilter extends Filter {
  override name = "golangci-lint";
  override binaries: ReadonlySet<string> = new Set(["golangci-lint"]);

  static readonly _MAX_ISSUES_PER_FILE_LINTER = 10;
  static readonly _KEEP_FIRST_N = 3;

  override matches(argv: string[]): boolean {
    if (argv.length === 0) {
      return false;
    }
    const stem = _pathStemLower(argv[0]!);
    // Direct invocation: golangci-lint run / golangci-lint
    if (stem === "golangci-lint") {
      return true;
    }
    // npx golangci-lint run
    return (stem === "npx" || stem === "pnpx") && argv.length > 1 && argv[1]!.includes("golangci-lint");
  }

  override compress(stdout: string, stderr: string, _exit_code: number, _argv: string[]): string {
    const merged = this._combine_output(stdout, stderr);
    const lines = merged.split("\n");

    // Per-(file, linter) issue counter.
    const issue_counts = new Map<string, number>();
    const kept: string[] = [];
    let noise_dropped = 0;
    let issues_collapsed = 0;

    for (const line of lines) {
      // Drop structured-log noise lines (info/debug level).
      if (_reMatch(_GOLANGCI_NOISE_RE, line)) {
        noise_dropped += 1;
        continue;
      }

      // Always keep summary / error log lines.
      if (_reMatch(_GOLANGCI_SUMMARY_RE, line)) {
        kept.push(line);
        continue;
      }

      const m = _reMatchObj(_GOLANGCI_ISSUE_RE, line);
      if (m) {
        const file_path = m.groups!["file"]!;
        const linter = m.groups!["linter"]!;
        const key = _issueKey(file_path, linter);
        const count = issue_counts.get(key) ?? 0;
        issue_counts.set(key, count + 1);
        if (count < GolangciLintFilter._KEEP_FIRST_N) {
          kept.push(line);
        } else if (count === GolangciLintFilter._KEEP_FIRST_N) {
          // Emit placeholder — actual total not known yet; will be updated at
          // end via post-pass.
          kept.push(`[token-goat: __placeholder__${file_path}__${linter}__]`);
          issues_collapsed += 1;
        }
        // else: drop additional issues for this (file, linter) pair.
        continue;
      }

      kept.push(line);
    }

    // Replace placeholders with actual counts.
    const final: string[] = [];
    for (const line of kept) {
      if (line.startsWith("[token-goat: __placeholder__")) {
        // Extract file and linter from the placeholder.
        const rest = line.slice("[token-goat: __placeholder__".length, -2); // strip prefix + "]"
        const parts = rest.split("__");
        if (parts.length >= 2) {
          const fp = parts[0]!;
          const lnt = parts[1]!;
          const total = issue_counts.get(_issueKey(fp, lnt)) ?? GolangciLintFilter._KEEP_FIRST_N + 1;
          const extra = total - GolangciLintFilter._KEEP_FIRST_N;
          final.push(
            `[token-goat: +${extra} more ${lnt} issues in ${fp} omitted]`,
          );
        } else {
          final.push(line);
        }
      } else {
        final.push(line);
      }
    }

    const notes: string[] = [];
    _maybe_note(notes, noise_dropped, `dropped ${noise_dropped} structured-log noise lines`);
    if (issues_collapsed) {
      let total_issues = 0;
      for (const v of issue_counts.values()) {
        total_issues += v;
      }
      let kept_issues = 0;
      for (const v of issue_counts.values()) {
        kept_issues += Math.min(v, GolangciLintFilter._KEEP_FIRST_N);
      }
      notes.push(
        `collapsed ${total_issues - kept_issues} issues ` +
          `(${issues_collapsed} file/linter groups exceeded ${GolangciLintFilter._MAX_ISSUES_PER_FILE_LINTER})`,
      );
    }
    GolangciLintFilter._emit_notes(final, notes);
    return Filter._finalize(final);
  }
}

/**
 * Composite (file, linter) key for the GolangciLintFilter issue counter.
 *
 * Python uses a tuple `(file_path, linter)` as the dict key; JS Maps key by
 * identity for objects, so a stable string join is used. "\x00" cannot appear
 * in either component (file paths and linter names are printable), so it is an
 * unambiguous separator.
 */
function _issueKey(file_path: string, linter: string): string {
  return `${file_path}\x00${linter}`;
}

// Re-exports for the Python __all__ surface / test imports. The regex constants
// are module-private in Python (leading underscore) but exported here so a later
// barrel phase and any white-box test can reference them by their exact Python
// name without re-deriving the pattern.
export {
  _GO_TEST_RUN_RE,
  _GO_RACE_FENCE_RE,
  _GO_RACE_WARNING_RE,
  _GO_TEST_PASS_RE,
  _GO_TEST_FAIL_RE,
  _GO_TEST_PKG_RESULT_RE,
  _GO_TEST_RPC_RE,
  _GO_BUILD_PKG_HEADER_RE,
  _GO_MOD_DOWNLOADING_RE,
  _GO_VET_PROGRESS_RE,
  _GO_GENERATE_TRIGGER_RE,
  _GO_ERROR_RE,
  _GO_GET_DOWNLOADING_RE,
  _GO_MOD_INFO_RE,
  _GO_RUN_BUILDING_RE,
  _GO_PKG_OK_RE,
  _GO_PKG_FAIL_RE,
  _GO_BUILD_ERROR_PLAIN_RE,
  _GOLANGCI_ISSUE_RE,
  _GOLANGCI_SUMMARY_RE,
  _GOLANGCI_LINTER_HEADER_RE,
  _GOLANGCI_NOISE_RE,
};
