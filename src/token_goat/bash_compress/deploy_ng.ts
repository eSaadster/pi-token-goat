/**
 * bash_compress DEPLOY + NG (ANGULAR CLI) FILTERS — TypeScript port of the
 * ErlangFilter, FlyFilter, ForgeFilter, and NgFilter Filter subclasses from
 * src/token_goat/bash_compress.py (plus their module-private _REBAR3_* / _FLY_*
 * / _FORGE_* / _NG_* regex constants and the _NG_TABLE_KEEP_EACH int).
 *
 * Four filters subclass the concrete Filter base from ./framework.js:
 *   - ErlangFilter — `rebar3` / `rebar` (compile/eunit/ct): collapse per-file
 *                    Compiling lines, dependency-fetch noise, and passing-test
 *                    lines to counts; keep step headers, summaries, failures.
 *   - FlyFilter    — `fly` / `flyctl` deploy/status: collapse Docker build
 *                    step + per-machine-wait lines to counts; drop DNS/polling
 *                    noise; keep step headers + deploy summary.
 *   - ForgeFilter  — `forge` (Foundry) build/test: collapse Solidity Compiling
 *                    step lines and [PASS]/[OK] test lines to counts; drop
 *                    gas-report table separator rows; keep suite headers,
 *                    summaries, footers, [FAIL]/[ERROR] lines.
 *   - NgFilter     — `ng` (Angular CLI) build/serve/test: collapse new-builder
 *                    chunk tables + old webpack chunk runs to head/tail + count;
 *                    drop Karma INFO log noise + build progress; keep budget
 *                    warnings, bundle-complete, build-at, Karma results/TOTAL.
 *
 * All four set `error_passthrough = true` and override _compress_body (NOT
 * compress) — the framework's compress() template-method short-circuits to the
 * raw stderr on non-zero exit before delegating to _compress_body. None of the
 * four overrides matches(); they rely on the default binaries + subcommands
 * dispatch from the Filter base.
 *
 * ---------------------------------------------------------------------------
 * Parity notes (Python -> TS)
 * ---------------------------------------------------------------------------
 *  - Python identifiers preserved EXACTLY: PascalCase class names; snake_case
 *    methods/fields (_compress_body, _compress_build, _compress_test); the
 *    nested _flush_rows closure in NgFilter._compress_build becomes a local
 *    arrow function (mutating captured accumulators) mirroring the Python
 *    `nonlocal collapsed_rows` closure. snake_case module-private regex/const
 *    names (_REBAR3_*, _FLY_*, _FORGE_*, _NG_*, _NG_TABLE_KEEP_EACH).
 *  - re.compile(...) -> top-level RegExp compiled once. re.IGNORECASE -> "i".
 *  - Python re.Pattern.match(line) is START-anchored (NOT end-anchored); emulated
 *    via _reMatch (non-global clone + index===0). .search() -> _reSearch
 *    (non-global clone, .test anywhere).
 *  - _ERROR_SIGNAL_RE is framework-PRIVATE (not exported by framework.ts); it is
 *    re-declared MODULE-PRIVATE here (NOT exported) to avoid a duplicate-export
 *    ambiguity (TS2308) across the barrel export* chain.
 *  - NgFilter._compress_build's nested `def _flush_rows(rows, label)` reads the
 *    enclosing `kept` list and `collapsed_rows` int via `nonlocal`. In TS the
 *    closure captures `kept` (mutable array — passed by reference) and a
 *    one-element box `collapsedRows` for the integer (JS closures cannot rebind
 *    an outer `let` from inside an arrow without boxing it; a [number] tuple
 *    mirrors the Python `nonlocal` mutation exactly).
 *  - Python `subcommand in ("build", "serve", "")` -> explicit === checks
 *    including the empty-string case (bare `ng` invocation dispatches to build).
 *  - Python `positionals[0].lower() if positionals else ""` -> ternary on length.
 *  - _maybe_note / cap_bytes / _positional_args are framework-PUBLIC and
 *    imported. _combine_output is an INSTANCE method; _finalize / _emit_notes
 *    are STATIC methods on Filter.
 *  - Python list `kept.extend(rows[:n])` -> kept.push(...rows.slice(0, n)).
 *  - Module-global mutable state: NONE. Every counter/list is a local inside
 *    _compress_body / helpers; no registerReset seam is needed.
 *
 * detect_from_command gating (per filter, via the default binaries + subcommands
 * matches() after _strip_prefixes):
 *  - rebar3 / rebar : binaries {rebar3, rebar}; subcommand in {compile, test,
 *                      eunit, ct, cover, dialyzer, deps, upgrade, release,
 *                      escriptize, shell, clean, xref, check, as}.
 *  - fly / flyctl   : binaries {fly, flyctl}; subcommand in {deploy, status,
 *                      apps, machines, logs, scale, secrets, volumes, regions,
 *                      releases, info, launch, destroy, resume, suspend, open}.
 *  - forge          : binaries {forge}; subcommand in {build, test, script,
 *                      verify-contract, flatten, inspect, coverage, snapshot,
 *                      clean, install, update, remove, init, compile}.
 *  - ng             : binaries {ng}; subcommands EMPTY -> any `ng` invocation
 *                      matches (NgFilter._compress_body branches on the
 *                      subcommand itself, short-circuiting short subcommands to
 *                      a byte cap).
 *
 * NOTE on import depth: this file lives in the bash_compress/ SUBDIR; the
 * framework is a SIBLING (./framework.js). verbatimModuleSyntax is on -> nothing
 * imported here is type-only. noImplicitOverride is on -> every overridden
 * member carries `override`.
 */

import {
  Filter,
  _maybe_note,
  _positional_args,
  cap_bytes,
} from "./framework.js";

// ===========================================================================
// Internal Python-builtin shims local to this module.
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

/** Python re.Pattern.search(line) — boolean "matches anywhere". */
function _reSearch(re: RegExp, line: string): boolean {
  return _nonGlobal(re).test(line);
}

// ===========================================================================
// Module-private framework regex re-declared here (framework does NOT export
// _ERROR_SIGNAL_RE — re-exporting it would create a TS2308 ambiguity).
// ===========================================================================

/** Python _ERROR_SIGNAL_RE (framework-private) — re-declared module-private. */
const _ERROR_SIGNAL_RE: RegExp =
  /error:|Error:|ERROR|FAILED|failed|fatal:|Traceback|exception:|Exception:|AssertionError|assert |panic:/i;

// ===========================================================================
// rebar3 / Erlang regexes (Python ~21913-21959).
// ===========================================================================

/** rebar3 compile per-file + step header: `==> app (compile)` / `Compiling foo.erl`. */
const _REBAR3_COMPILING_RE: RegExp =
  /^==>\s+\S+\s+\(compile\)|^Compiling\s+\S+\.erl\b/i;
/** rebar3 dependency-fetch progress: `Fetching foo 1.2.3` / `Already up-to-date`. */
const _REBAR3_FETCH_RE: RegExp =
  /^(?:Fetching|Downloading|Resolving|Locking)\s+\S|^\s*Already\s+up-to-date\b|^\s*All\s+dependencies\s+already\s+locked\b/i;
/** rebar3 `===> Verifying dependencies` / `===> Analyzing applications` noise. */
const _REBAR3_STEP_NOISE_RE: RegExp =
  /^===>\s+(?:Verifying\s+dependencies|Analyzing\s+applications|Building\s+rebar3\b|Compiling\s+rebar3\b|Using\s+locked\s+dependencies|Updating\s+base\s+application\b)/i;
/** EUnit individual test pass: `  foo_tests:bar_test...ok`. */
const _REBAR3_EUNIT_PASS_RE: RegExp = /^\s+\S+_tests?:\S+\.\.\.(ok|passed)\s*$/i;
/** Common Test `PASSED` test case lines. */
const _REBAR3_CT_PASS_RE: RegExp =
  /^\s+(?:tc_passed|PASSED|ok)\s+\S+\s*$|^\s+\d+\s+tests?,\s+\d+\s+(?:passed|ok)\b/i;
/** rebar3 `===> Tests passed` / `===> N tests passed` summary (always keep). */
const _REBAR3_SUMMARY_RE: RegExp =
  /^===>\s+(?:Tests?\s+passed|Done\.|Finished\.|\d+\s+tests?\s+passed|All\s+\d+\s+tests?\s+passed)|^\s*All\s+\d+\s+tests?\s+passed\b|^\s*\d+\s+tests?,\s+\d+\s+(?:failed|errors?)\b|Test\s+Summary\s*:.*passed\b/i;
/** rebar3 failure markers (always keep). */
const _REBAR3_FAILURE_RE: RegExp =
  /^===>\s+(?:ERROR|FAILED|Test\s+Failed|Tests?\s+Failed)|^\s*(?:FAILED|ERROR|failed|error)\s*$|^\s*\*\*\*/i;

// ===========================================================================
// ErlangFilter (Python ~21962-22046)
// ===========================================================================

/**
 * Compress `rebar3` Erlang/OTP build and test output.
 *
 * `rebar3 compile` emits one line per `.erl` source file compiled; a medium
 * project with 50+ modules produces 50+ near-identical lines. `rebar3 eunit`
 * and `rebar3 ct` emit one line per passing test case.
 *
 * Compression model: per-file Compiling lines + dependency-fetch noise + EUnit/CT
 * passing-test lines collapsed to counts; step-noise lines dropped; `==> app
 * (compile)` step header, test summaries, failure lines, and error blocks always
 * kept. Errors (exit_code != 0): preserve all stderr unchanged (via the
 * framework error_passthrough template-method).
 */
export class ErlangFilter extends Filter {
  override error_passthrough = true;

  override name = "rebar3";
  override binaries: ReadonlySet<string> = new Set(["rebar3", "rebar"]);
  override subcommands: ReadonlySet<string> = new Set([
    "compile", "test", "eunit", "ct", "cover", "dialyzer",
    "deps", "upgrade", "release", "escriptize", "shell",
    "clean", "xref", "check", "as",
  ]);

  override _compress_body(
    stdout: string, stderr: string, _exit_code: number, _argv: string[],
  ): string {
    const combined = this._combine_output(stdout, stderr);
    const lines = combined.split("\n");
    const kept: string[] = [];
    let compiling_count = 0;
    let fetch_count = 0;
    let pass_count = 0;
    let dropped_noise = 0;

    for (const line of lines) {
      // Error signals and failure markers — always keep.
      if (_reSearch(_ERROR_SIGNAL_RE, line) || _reMatch(_REBAR3_FAILURE_RE, line)) {
        kept.push(line);
        continue;
      }
      // Summary lines — always keep.
      if (_reSearch(_REBAR3_SUMMARY_RE, line)) {
        kept.push(line);
        continue;
      }
      // Per-file compilation lines — count.
      if (_reMatch(_REBAR3_COMPILING_RE, line)) {
        compiling_count += 1;
        continue;
      }
      // Dependency-fetch noise — count.
      if (_reMatch(_REBAR3_FETCH_RE, line)) {
        fetch_count += 1;
        continue;
      }
      // Step-noise lines — drop.
      if (_reMatch(_REBAR3_STEP_NOISE_RE, line)) {
        dropped_noise += 1;
        continue;
      }
      // EUnit/CT passing test lines — count.
      if (_reMatch(_REBAR3_EUNIT_PASS_RE, line) || _reMatch(_REBAR3_CT_PASS_RE, line)) {
        pass_count += 1;
        continue;
      }
      kept.push(line);
    }

    const out: string[] = [];
    if (compiling_count) {
      out.push(
        `[token-goat: ${compiling_count} .erl compilation line(s) collapsed; ` +
          `disable via TOKEN_GOAT_BASH_COMPRESS for full output]`,
      );
    }
    if (fetch_count) {
      out.push(`[token-goat: ${fetch_count} dependency-fetch line(s) collapsed]`);
    }
    out.push(...kept);

    const notes: string[] = [];
    _maybe_note(notes, pass_count, `collapsed ${pass_count} passing test line(s)`);
    _maybe_note(notes, dropped_noise, `dropped ${dropped_noise} rebar3 step-noise line(s)`);
    Filter._emit_notes(out, notes);
    return Filter._finalize(out);
  }
}

// ===========================================================================
// Fly.io deploy CLI regexes (Python ~22054-22098).
// ===========================================================================

/** fly deploy `==> Releasing` step header (always keep). */
const _FLY_STEP_HEADER_RE: RegExp =
  /^==>\s+(?:Releasing|Building|Creating|Validating|Updating|Destroying|Monitoring)/i;
/** fly deploy per-machine status/progress (keep 1st occurrence per machine id). */
const _FLY_MACHINE_WAIT_RE: RegExp =
  /^(?:-->?\s+Waiting\s+for|\s*Machine\s+[0-9a-zA-Z]+\s+is\s+now\s+in|\s*\[[\s\d]+\]\s+Machine\s+[0-9a-zA-Z]+)/i;
/** fly build step noise: `Sending build context`, `Step N/M :`, `--->`. */
const _FLY_BUILD_STEP_RE: RegExp =
  /^\s*(?:Sending\s+build\s+context|Step\s+\d+\/\d+\s*:|-{3}>\s*\w|Successfully\s+built\s+[0-9a-f]{8,}|Successfully\s+tagged\s+\S+)/i;
/** fly deploy image layer progress: `#N DONE` / `transferring context`. */
const _FLY_LAYER_PROGRESS_RE: RegExp =
  /^\s*#\d+\s+(?:CACHED|DONE|sha256:|transferring)|^\s*CACHED\s+\[/i;
/** fly deploy summary (Watch/Visit/Deployed/Release succeeded) — always keep. */
const _FLY_SUMMARY_RE: RegExp =
  /(?:Watch\s+your\s+deployment|Visit\s+your\s+newly\s+deployed|Deployed\s+\S+\s+v\d|v\d+\s+deployed\s+successfully|Release\s+command\s+succeeded|Monitoring\s+deployment\s+\(Ctrl-C\))/i;
/** fly `Checking DNS configuration` and other polling dots — drop. */
const _FLY_POLLING_RE: RegExp =
  /^\s*(?:Checking\s+DNS\s+configuration|Waiting\s+for\s+IPv[46]|The\s+above\s+IP\s+address\s+may\s+need)/i;

// ===========================================================================
// FlyFilter (Python ~22101-22180)
// ===========================================================================

/**
 * Compress `fly` (flyctl) deployment and status output.
 *
 * `fly deploy` emits Docker build layers, per-machine wait messages, polling
 * dots and DNS-check lines that dwarf the useful deploy summary. Compression
 * model: Docker build step lines + per-machine wait lines collapsed to counts;
 * DNS/polling noise dropped; step headers + deploy summary + error lines always
 * kept. Errors (exit_code != 0): preserve all stderr unchanged.
 */
export class FlyFilter extends Filter {
  override error_passthrough = true;

  override name = "fly";
  override binaries: ReadonlySet<string> = new Set(["fly", "flyctl"]);
  override subcommands: ReadonlySet<string> = new Set([
    "deploy", "status", "apps", "machines", "logs", "scale",
    "secrets", "volumes", "regions", "releases", "info",
    "launch", "destroy", "resume", "suspend", "open",
  ]);

  override _compress_body(
    stdout: string, stderr: string, _exit_code: number, _argv: string[],
  ): string {
    const combined = this._combine_output(stdout, stderr);
    const lines = combined.split("\n");
    const kept: string[] = [];
    let build_step_count = 0;
    let machine_wait_count = 0;
    let dropped_noise = 0;

    for (const line of lines) {
      // Error signals — always keep.
      if (_reSearch(_ERROR_SIGNAL_RE, line)) {
        kept.push(line);
        continue;
      }
      // Deploy summary and step headers — always keep.
      if (_reSearch(_FLY_SUMMARY_RE, line) || _reMatch(_FLY_STEP_HEADER_RE, line)) {
        kept.push(line);
        continue;
      }
      // Docker build step noise — count.
      if (_reMatch(_FLY_BUILD_STEP_RE, line) || _reMatch(_FLY_LAYER_PROGRESS_RE, line)) {
        build_step_count += 1;
        continue;
      }
      // Per-machine wait lines — count.
      if (_reMatch(_FLY_MACHINE_WAIT_RE, line)) {
        machine_wait_count += 1;
        continue;
      }
      // DNS / polling noise — drop.
      if (_reMatch(_FLY_POLLING_RE, line)) {
        dropped_noise += 1;
        continue;
      }
      kept.push(line);
    }

    const out: string[] = [];
    if (build_step_count) {
      out.push(
        `[token-goat: ${build_step_count} Docker build step line(s) collapsed; ` +
          `disable via TOKEN_GOAT_BASH_COMPRESS for full output]`,
      );
    }
    if (machine_wait_count) {
      out.push(`[token-goat: ${machine_wait_count} per-machine wait line(s) collapsed]`);
    }
    out.push(...kept);

    const notes: string[] = [];
    _maybe_note(notes, dropped_noise, `dropped ${dropped_noise} DNS/polling noise line(s)`);
    Filter._emit_notes(out, notes);
    return Filter._finalize(out);
  }
}

// ===========================================================================
// Foundry / Forge regexes (Python ~22189-22233).
// ===========================================================================

/** forge compile per-file progress: `Compiling N files with solc 0.8.24`. */
const _FORGE_COMPILING_RE: RegExp =
  /^\s*Compiling\s+\d+\s+(?:file[s]?\s+with|Solidity\s+file[s]?)|^\s*Solc\s+\S+\s+finished\s+in\s+\d/i;
/** forge test passing test lines: `[PASS] testFoo() (gas: 12345)`. */
const _FORGE_PASS_TEST_RE: RegExp = /^\s*\[(?:PASS|OK)\]\s+\S+\s+\(gas:/i;
/** forge test suite header: `Running N tests for src/Foo.t.sol:FooTest`. */
const _FORGE_SUITE_HEADER_RE: RegExp = /^\s*Running\s+\d+\s+test[s]?\s+for\s+\S+/i;
/** forge test summary: `Test result: ok. N passed; ...`. */
const _FORGE_SUMMARY_RE: RegExp =
  /^\s*(?:Test\s+result|Suite\s+result|Overall\s+result)\s*:/i;
/** forge compile done: `Compiler run successful` / `Nothing to compile`. */
const _FORGE_COMPILE_DONE_RE: RegExp =
  /^\s*(?:Compiler\s+run\s+successful|Nothing\s+to\s+compile|Compiled\s+\d+\s+Solidity\s+file[s]?)/i;
/** forge failure header: `[FAIL. Counterexample: ...]` / `[FAIL]`. */
const _FORGE_FAILURE_RE: RegExp = /^\s*\[(?:FAIL|ERROR)\]/i;
/** forge gas-report table separator rows only: `| ----- | ----- |` (cosmetic). */
const _FORGE_GAS_TABLE_RE: RegExp = /^\s*\|[-\s|]+\|\s*$/;
/** forge `Ran N test suites` footer (always keep). */
const _FORGE_FOOTER_RE: RegExp = /^\s*Ran\s+\d+\s+test\s+suite[s]?\s+in\s+\d/i;

// ===========================================================================
// ForgeFilter (Python ~22236-22316)
// ===========================================================================

/**
 * Compress Foundry `forge build` / `forge test` output.
 *
 * Foundry emits one `Compiling N files with solc` line per compiler version, one
 * `[PASS] testFoo() (gas: ...)` line per passing test, and verbose gas-report
 * table separators — all of which dwarf any failures. Compression model:
 * compilation step lines + passing test lines collapsed to counts; gas-report
 * table separator rows dropped; `Compiler run successful`, suite headers,
 * summaries, footers, `[FAIL]`/`[ERROR]` lines always kept. Errors (exit_code !=
 * 0): preserve all stderr unchanged.
 */
export class ForgeFilter extends Filter {
  override error_passthrough = true;

  override name = "forge";
  override binaries: ReadonlySet<string> = new Set(["forge"]);
  override subcommands: ReadonlySet<string> = new Set([
    "build", "test", "script", "verify-contract", "flatten",
    "inspect", "coverage", "snapshot", "clean", "install",
    "update", "remove", "init", "compile",
  ]);

  override _compress_body(
    stdout: string, stderr: string, _exit_code: number, _argv: string[],
  ): string {
    const combined = this._combine_output(stdout, stderr);
    const lines = combined.split("\n");
    const kept: string[] = [];
    let compiling_count = 0;
    let pass_count = 0;
    let dropped_gas_sep = 0;

    for (const line of lines) {
      // Error signals and failure headers — always keep.
      if (_reSearch(_ERROR_SIGNAL_RE, line) || _reMatch(_FORGE_FAILURE_RE, line)) {
        kept.push(line);
        continue;
      }
      // Compile-done / suite headers / summaries / footer — always keep.
      if (
        _reMatch(_FORGE_COMPILE_DONE_RE, line) ||
        _reMatch(_FORGE_SUITE_HEADER_RE, line) ||
        _reMatch(_FORGE_SUMMARY_RE, line) ||
        _reMatch(_FORGE_FOOTER_RE, line)
      ) {
        kept.push(line);
        continue;
      }
      // Compilation step lines — count.
      if (_reMatch(_FORGE_COMPILING_RE, line)) {
        compiling_count += 1;
        continue;
      }
      // Passing test lines — count.
      if (_reMatch(_FORGE_PASS_TEST_RE, line)) {
        pass_count += 1;
        continue;
      }
      // Gas-report table separator rows — drop (cosmetic noise).
      if (_reMatch(_FORGE_GAS_TABLE_RE, line)) {
        dropped_gas_sep += 1;
        continue;
      }
      kept.push(line);
    }

    const out: string[] = [];
    if (compiling_count) {
      out.push(
        `[token-goat: ${compiling_count} Solidity compilation step line(s) collapsed; ` +
          `disable via TOKEN_GOAT_BASH_COMPRESS for full output]`,
      );
    }
    out.push(...kept);

    const notes: string[] = [];
    _maybe_note(notes, pass_count, `collapsed ${pass_count} passing test line(s)`);
    _maybe_note(notes, dropped_gas_sep, `dropped ${dropped_gas_sep} gas-report table separator row(s)`);
    Filter._emit_notes(out, notes);
    return Filter._finalize(out);
  }
}

// ===========================================================================
// Angular CLI (ng) regexes (Python ~24307-24369).
// ===========================================================================

/** Old webpack-based ng build: `chunk {0} polyfills.js (polyfills) 141 kB ...`. */
const _NG_WEBPACK_CHUNK_RE: RegExp = /^chunk \{\d+\} /;
/** New application-builder chunk data row: `main.abc123.js | main | 172 kB | 45 kB`. */
const _NG_CHUNK_ROW_RE: RegExp = /^\S+\.(?:js|css|mjs)\s+\|/;
/** Table section header emitted by the new application builder. */
const _NG_TABLE_HEADER_RE: RegExp =
  /^(?:Initial [Cc]hunk [Ff]iles|Lazy [Cc]hunk [Ff]iles)\s+\|/i;
/** Build summary lines: `Build at: ...` (new) / `Date: ...` (old webpack). */
const _NG_BUILD_AT_RE: RegExp = /^(?:Build at:|Date:)\s/;
/** `Application bundle generation complete.` (with optional leading check-mark). */
const _NG_BUNDLE_COMPLETE_RE: RegExp =
  /(?:Browser application bundle|Application bundle) generation complete/i;
/** Build progress / spinner prefix lines to drop (they duplicate the summary). */
const _NG_BUILD_PROGRESS_RE: RegExp =
  /^- (?:Generating|Building)\s|^Building\.\.\.\s*$|^Generating browser application bundles/;
/** Budget warning lines emitted by ng build — always keep (actionable). */
const _NG_BUDGET_WARN_RE: RegExp =
  /budget\s+exceeded|exceeded\s+(?:maximum\s+)?budget|Warning:\s+budget/i;
/** Karma / ng test: timestamped INFO/DEBUG/WARN log lines produced by Karma. */
const _NG_KARMA_LOG_RE: RegExp =
  /^\d{2} \d{2} \d{4} \d{2}:\d{2}:\d{2}[.:]\d{3}:(?:INFO|DEBUG|WARN)\s|^(?:INFO|WARN)\s+\[(?:karma|launcher|karma-server|Chrome|Firefox|Safari)/i;
/** Karma per-browser result line: `Chrome Headless ... Executed 134 of 134 SUCCESS`. */
const _NG_KARMA_RESULT_RE: RegExp =
  /(?:Chrome|Firefox|Safari|HeadlessChrome|ChromeHeadless)\s.*Executed\s+\d+\s+of\s+\d+/i;
/** Karma aggregate summary: `TOTAL: 134 SUCCESS` / `TOTAL: 2 FAILED`. */
const _NG_KARMA_TOTAL_RE: RegExp = /^TOTAL:\s+\d+\s+(?:SUCCESS|FAILED)/i;

/** Rows to keep at each end of a chunk table section before collapsing the middle. */
const _NG_TABLE_KEEP_EACH: number = 3;

// ===========================================================================
// NgFilter (Python ~24372-24539)
// ===========================================================================

/**
 * Compress Angular CLI (`ng`) build, serve, and test output.
 *
 * `ng build` emits a chunk-file table listing every generated JS/CSS asset; large
 * apps produce 50+ lazy-chunk rows. The legacy webpack builder emits `chunk {N}`
 * lines in the same fashion. `ng test` runs Karma and emits timestamped
 * `INFO [karma]: ...` log lines with no signal.
 *
 * Compression model: chunk tables (new builder) + webpack chunk runs (old
 * builder) keep head+tail `_NG_TABLE_KEEP_EACH` rows per section and collapse the
 * middle to a count; budget warnings + build summary (`Build at:` /
 * `Application bundle generation complete.`) + error lines always kept; build
 * progress + Karma INFO log noise dropped; Karma per-browser result + `TOTAL:`
 * lines always kept. Short subcommands (generate/add/update/lint/version) get a
 * light byte cap only. Errors (exit_code != 0): preserve all output unchanged.
 */
export class NgFilter extends Filter {
  override error_passthrough = true;

  override name = "ng";
  override binaries: ReadonlySet<string> = new Set(["ng"]);
  // subcommands intentionally EMPTY — NgFilter._compress_body branches on the
  // subcommand itself, so any `ng <anything>` invocation is accepted.

  override _compress_body(
    stdout: string, stderr: string, _exit_code: number, argv: string[],
  ): string {
    const positionals = _positional_args(argv.slice(1));
    const subcommand = positionals.length > 0 ? positionals[0]!.toLowerCase() : "";

    const combined = this._combine_output(stdout, stderr);
    const lines = combined.split("\n");

    if (subcommand === "test") {
      return this._compress_test(lines);
    }
    if (subcommand === "build" || subcommand === "serve" || subcommand === "") {
      return this._compress_build(lines);
    }
    // Short subcommands (generate, add, update, lint, version, ...)
    return cap_bytes(combined, 8_192);
  }

  /** Collapse chunk tables; preserve budget warnings and build summary. */
  _compress_build(lines: string[]): string {
    const kept: string[] = [];
    let table_rows: string[] = []; // buffered new-builder chunk rows for current section
    let in_table = false;
    let webpack_run: string[] = []; // buffered consecutive old-webpack chunk lines
    const collapsed_rows: [number] = [0]; // box for the closure's `nonlocal` write
    let dropped_progress = 0;

    const _flush_rows = (rows: string[], label: string): void => {
      const n = _NG_TABLE_KEEP_EACH;
      if (rows.length <= n * 2) {
        kept.push(...rows);
      } else {
        kept.push(...rows.slice(0, n));
        const mid_count = rows.length - n * 2;
        kept.push(`[token-goat: collapsed ${mid_count} ${label}]`);
        collapsed_rows[0] += mid_count;
        kept.push(...rows.slice(rows.length - n));
      }
    };

    for (const line of lines) {
      // End an open webpack-chunk run when a non-chunk line appears.
      if (webpack_run.length > 0 && !_reMatch(_NG_WEBPACK_CHUNK_RE, line)) {
        _flush_rows(webpack_run, "webpack chunk lines");
        webpack_run = [];
      }

      // End an open new-builder table section when a non-chunk-row appears.
      if (in_table && !_reMatch(_NG_CHUNK_ROW_RE, line)) {
        _flush_rows(table_rows, "chunk table rows");
        table_rows = [];
        in_table = false;
      }

      // Budget warnings — always keep.
      if (_reSearch(_NG_BUDGET_WARN_RE, line)) {
        kept.push(line);
        continue;
      }

      // Error/warning diagnostics — always keep.
      if (_reSearch(_ERROR_SIGNAL_RE, line)) {
        kept.push(line);
        continue;
      }

      // Build summary lines — always keep.
      if (_reMatch(_NG_BUILD_AT_RE, line) || _reSearch(_NG_BUNDLE_COMPLETE_RE, line)) {
        kept.push(line);
        continue;
      }

      // Table section header (new application builder).
      if (_reMatch(_NG_TABLE_HEADER_RE, line)) {
        kept.push(line);
        in_table = true;
        table_rows = [];
        continue;
      }

      // New-builder chunk data row (only accepted inside a table section).
      if (in_table && _reMatch(_NG_CHUNK_ROW_RE, line)) {
        table_rows.push(line);
        continue;
      }

      // Old webpack chunk line — accumulate into a run.
      if (_reMatch(_NG_WEBPACK_CHUNK_RE, line)) {
        webpack_run.push(line);
        continue;
      }

      // Build progress / spinner lines.
      if (_reMatch(_NG_BUILD_PROGRESS_RE, line)) {
        dropped_progress += 1;
        continue;
      }

      kept.push(line);
    }

    // Flush any open runs at EOF.
    if (webpack_run.length > 0) {
      _flush_rows(webpack_run, "webpack chunk lines");
    }
    if (in_table && table_rows.length > 0) {
      _flush_rows(table_rows, "chunk table rows");
    }

    const notes: string[] = [];
    _maybe_note(notes, dropped_progress, `dropped ${dropped_progress} build progress lines`);
    Filter._emit_notes(kept, notes);
    return Filter._finalize(kept);
  }

  /** Drop Karma info/debug log noise; keep test results and error lines. */
  _compress_test(lines: string[]): string {
    const kept: string[] = [];
    let dropped_karma = 0;

    for (const line of lines) {
      // Karma per-browser result and TOTAL summary — always keep (checked
      // before noise drop because result lines can carry an INFO prefix).
      if (_reSearch(_NG_KARMA_RESULT_RE, line) || _reMatch(_NG_KARMA_TOTAL_RE, line)) {
        kept.push(line);
        continue;
      }
      // Error/warning diagnostics — always keep.
      if (_reSearch(_ERROR_SIGNAL_RE, line)) {
        kept.push(line);
        continue;
      }
      // Bundle-complete line (appears before Karma starts) — keep.
      if (_reSearch(_NG_BUNDLE_COMPLETE_RE, line)) {
        kept.push(line);
        continue;
      }
      // Karma log noise — drop (after result/error guards above).
      if (_reSearch(_NG_KARMA_LOG_RE, line)) {
        dropped_karma += 1;
        continue;
      }
      kept.push(line);
    }

    const notes: string[] = [];
    _maybe_note(notes, dropped_karma, `dropped ${dropped_karma} Karma log lines`);
    Filter._emit_notes(kept, notes);
    return Filter._finalize(kept);
  }
}
