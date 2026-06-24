/**
 * bash_compress FORMATTERS + SYSTEM-PACKAGE FILTERS — TypeScript port of the
 * BlackIsortFilter, SysPackageFilter, ProtocFilter, and PrettierFilter Filter
 * subclasses from src/token_goat/bash_compress.py (plus their module-level
 * regexes).
 *
 * Four filters subclass the concrete Filter base from ./framework.js:
 *   - BlackIsortFilter — `black` / `isort` formatters. Dispatches on argv[0]
 *                       binary stem: black and isort each have their own
 *                       compressor. Overrides compress() only (default
 *                       binaries-based matches()).
 *   - SysPackageFilter  — `apt-get` / `apt` / `apt-cache` / `apk` / `brew`.
 *                         Dispatches on argv[0] binary stem: apt / apk / brew
 *                         each have their own compressor. Overrides compress()
 *                         only.
 *   - ProtocFilter      — `protoc` / `protoc-gen-go` / `protoc-gen-grpc` /
 *                         `buf`. Drops libprotobuf INFO log lines, dedups
 *                         repeated identical WARNING/diagnostic lines, keeps
 *                         every file.proto:N:N: error/warning diagnostic and
 *                         the "N errors generated." summary. Overrides
 *                         compress() only.
 *   - PrettierFilter    — `prettier` (and `npx prettier` / `pnpx prettier`).
 *                         Samples first 5 changed-file lines, drops
 *                         "(unchanged)" file lines, keeps summary/warn/error
 *                         lines. Overrides matches() (npx/pnpx dispatch) and
 *                         compress().
 *
 * ---------------------------------------------------------------------------
 * Parity notes (Python -> TS)
 * ---------------------------------------------------------------------------
 *  - Python identifiers preserved EXACTLY: PascalCase class names and the
 *    snake_case module-private regex names (_BLACK_*, _ISORT_*, _APT_*,
 *    _APK_*, _BREW_*, _PROTOC_*, _PRETTIER_*) and instance members
 *    (matches, compress, _compress_black, _compress_isort, _compress_apt,
 *    _compress_apk, _compress_brew, _SAMPLE_SIZE, _FAIL_TASK_SAMPLE not used
 *    here).
 *  - re.compile(...) -> top-level RegExp compiled once. re.IGNORECASE -> "i".
 *  - Python re.Pattern.match(line) is START-anchored (NOT end-anchored);
 *    emulated via _reMatch (non-global clone + index===0). .search() ->
 *    _reSearch (non-global clone, .exec anywhere).
 *  - _ERROR_SIGNAL_RE is framework-PRIVATE (not exported by framework.ts); it
 *    is re-declared MODULE-PRIVATE here (NOT exported) to avoid a
 *    duplicate-export ambiguity (TS2308) across the barrel export* chain.
 *  - Python `Path(argv[0]).stem.lower()` -> local _pathStemLower (final path
 *    component with its LAST suffix removed, lowercased), matching the
 *    framework's _pathStem semantics.
 *  - Python `binary = Path(argv[0]).stem.lower() if argv else "<default>"`
 *    -> argv.length > 0 ? _pathStemLower(argv[0]!) : "<default>".
 *  - Python `if line in warn_seen` (dict membership on the full line) ->
 *    Map.has(line). warn_seen[line] += 1 -> set(line, get(line)+1). Insertion
 *    order is irrelevant because the FIRST occurrence is always kept verbatim
 *    and subsequent repeats are only counted.
 *  - _maybe_note / Filter._emit_notes / Filter._finalize are framework-PUBLIC
 *    and imported. _combine_output is an INSTANCE method on Filter.
 *  - Module-global mutable state: NONE. Every counter/dict/list is a local
 *    inside compress()/helpers; no registerReset seam is needed.
 *
 * detect_from_command gating (per filter, after _strip_prefixes / matches):
 *  - black-isort : binaries {black, isort}; any subcommand.
 *  - sys-pkg     : binaries {apt-get, apt, apt-cache, apk, brew}; any
 *                  subcommand.
 *  - protoc      : binaries {protoc, protoc-gen-go, protoc-gen-grpc, buf};
 *                  any subcommand.
 *  - prettier    : binaries {prettier} OR stem in {npx, pnpx} with argv[1]
 *                  lowercased === "prettier" (overridden matches()).
 *
 * NOTE on import depth: this file lives in the bash_compress/ SUBDIR; the
 * framework is a SIBLING (./framework.js). verbatimModuleSyntax is on ->
 * nothing imported here is type-only. noImplicitOverride is on -> every
 * overridden member carries `override`.
 */

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
  const r = _nonGlobal(re);
  const m = r.exec(line);
  return m !== null && m.index === 0;
}

/** Python re.Pattern.search(line) — boolean "matches anywhere". */
function _reSearch(re: RegExp, line: string): boolean {
  return _nonGlobal(re).test(line);
}

/**
 * pathlib.Path(s.replace("\\","/")).stem.lower() — the lowercased final path
 * component with its LAST suffix removed. Matches framework._pathStem
 * semantics (a leading-dot dotfile keeps its name; a trailing dot is not a
 * suffix).
 */
function _pathStemLower(s: string): string {
  const norm = s.replace(/\\/g, "/");
  const trimmed = norm.replace(/\/+$/, "");
  const idx = trimmed.lastIndexOf("/");
  const name = idx >= 0 ? trimmed.slice(idx + 1) : trimmed;
  const dot = name.lastIndexOf(".");
  if (dot <= 0 || dot === name.length - 1) {
    return name.toLowerCase();
  }
  return name.slice(0, dot).toLowerCase();
}

// ===========================================================================
// Module-private framework regexes re-declared here (framework does NOT export
// _ERROR_SIGNAL_RE — re-exporting it would create a TS2308 ambiguity).
// ===========================================================================

/** Python _ERROR_SIGNAL_RE (framework-private) — re-declared module-private. */
const _ERROR_SIGNAL_RE: RegExp =
  /error:|Error:|ERROR|FAILED|failed|fatal:|Traceback|exception:|Exception:|AssertionError|assert |panic:/i;

// ===========================================================================
// Black / isort regexes (Python ~16918-16945).
// ===========================================================================

/** black "reformatted" line: "reformatted path/to/file.py". */
const _BLACK_REFORMATTED_RE: RegExp = /^reformatted\s+\S/;
/** black "would reformat" (check mode): "would reformat path/to/file.py". */
const _BLACK_WOULD_REFORMAT_RE: RegExp = /^would reformat\s+\S/i;
/** black summary line: "All done! ✨ 🍰 ✨" / "N files reformatted". */
const _BLACK_SUMMARY_RE: RegExp =
  /^All done!|^\d+ files? (?:reformatted|left unchanged|would be reformatted)/;
/** black "Oh no!" error header / "error:" / "cannot format". */
const _BLACK_ERROR_RE: RegExp = /^Oh no!|^error:|^cannot format/i;
/** black "error: cannot format" detail line. */
const _BLACK_CANNOT_FORMAT_RE: RegExp = /^error: cannot format\s+\S/i;
/** isort "Fixing <file>" line. */
const _ISORT_FIXING_RE: RegExp = /^Fixing\s+\S/;
/** isort "Skipped N files" summary line. */
const _ISORT_SKIPPED_RE: RegExp = /^Skipped\s+\d+\s+files?/i;

// ===========================================================================
// BlackIsortFilter (Python ~16948-17044)
// ===========================================================================

/**
 * Compress `black` and `isort` formatter output.
 *
 * Both formatters emit one line per file they touch plus a summary. On a large
 * codebase `black .` can produce hundreds of "reformatted …" lines before the
 * summary. The agent only needs the summary and any error lines.
 *
 * black: drop reformatted/would-reformat lines beyond the first 5 (keep first
 * 5 as a sample, count the rest); keep error lines and the summary. isort:
 * drop "Fixing <file>" lines beyond the first 5; keep error lines and the
 * "Skipped N files" summary.
 */
export class BlackIsortFilter extends Filter {
  override name = "black-isort";
  override binaries: ReadonlySet<string> = new Set(["black", "isort"]);

  _SAMPLE_SIZE: number = 5;

  override compress(stdout: string, stderr: string, _exit_code: number, argv: string[]): string {
    const binary = argv.length > 0 ? _pathStemLower(argv[0]!) : "black";
    if (binary === "isort") {
      return this._compress_isort(stdout, stderr);
    }
    return this._compress_black(stdout, stderr);
  }

  /** Compress black output: sample first 5 reformatted files, keep errors/summary. */
  _compress_black(stdout: string, stderr: string): string {
    const merged = this._combine_output(stdout, stderr);
    const lines = merged.split("\n");
    const kept: string[] = [];
    const reformat_sample: string[] = [];
    let reformat_extra = 0;
    for (const line of lines) {
      if (_reMatch(_BLACK_ERROR_RE, line) || _reMatch(_BLACK_CANNOT_FORMAT_RE, line)) {
        kept.push(line);
        continue;
      }
      if (_reMatch(_BLACK_SUMMARY_RE, line)) {
        kept.push(line);
        continue;
      }
      if (_reMatch(_BLACK_REFORMATTED_RE, line) || _reMatch(_BLACK_WOULD_REFORMAT_RE, line)) {
        if (reformat_sample.length < this._SAMPLE_SIZE) {
          reformat_sample.push(line);
        } else {
          reformat_extra += 1;
        }
        continue;
      }
      kept.push(line);
    }

    // Prepend the sample (files are load-bearing: tells the agent which files
    // changed) followed by the error + summary lines.
    const out: string[] = [];
    out.push(...reformat_sample);
    if (reformat_extra) {
      out.push(
        `[token-goat: +${reformat_extra} more reformatted files; ` +
          `disable via TOKEN_GOAT_BASH_COMPRESS for full list]`,
      );
    }
    out.push(...kept);
    return Filter._finalize(out);
  }

  /** Compress isort output: sample first 5 fixed files, keep errors/summary. */
  _compress_isort(stdout: string, stderr: string): string {
    const merged = this._combine_output(stdout, stderr);
    const lines = merged.split("\n");
    const kept: string[] = [];
    const fix_sample: string[] = [];
    let fix_extra = 0;
    for (const line of lines) {
      if (_reSearch(_ERROR_SIGNAL_RE, line)) {
        kept.push(line);
        continue;
      }
      if (_reMatch(_ISORT_SKIPPED_RE, line)) {
        kept.push(line);
        continue;
      }
      if (_reMatch(_ISORT_FIXING_RE, line)) {
        if (fix_sample.length < this._SAMPLE_SIZE) {
          fix_sample.push(line);
        } else {
          fix_extra += 1;
        }
        continue;
      }
      kept.push(line);
    }

    const out: string[] = [];
    out.push(...fix_sample);
    if (fix_extra) {
      out.push(
        `[token-goat: +${fix_extra} more fixed files; ` +
          `disable via TOKEN_GOAT_BASH_COMPRESS for full list]`,
      );
    }
    out.push(...kept);
    return Filter._finalize(out);
  }
}

// ===========================================================================
// System package managers (apt-get / apt / apk / brew) regexes
// (Python ~17049-17103).
// ===========================================================================

/** apt/apt-get progress lines: "Get:1 http://... Packages [xxx kB]". */
const _APT_GET_RE: RegExp = /^Get:\d+\s+http/i;
/** apt "Fetched X MB in Ys (Z kB/s)" summary line. */
const _APT_FETCHED_RE: RegExp = /^Fetched\s+\d/;
/** apt "Reading package lists…" / "Building dependency tree…" boilerplate. */
const _APT_BOILERPLATE_RE: RegExp =
  /^(?:Reading package lists|Building dependency tree|Reading state information|Calculating upgrade|Correcting dependencies|Hit:\d+\s)/;
/** apt "Unpacking / Setting up / Preparing / Selecting" installation progress. */
const _APT_INSTALL_PROGRESS_RE: RegExp =
  /^(?:Unpacking |Setting up |Preparing to unpack |Selecting previously unselected)/;
/** apt "Processing triggers for …" post-install hooks. */
const _APT_TRIGGERS_RE: RegExp = /^Processing triggers for /i;
/** apt "The following NEW packages will be installed:" / "upgraded:" summary. */
const _APT_PKG_LIST_HDR_RE: RegExp =
  /^The following (?:NEW|extra|additional) packages|^The following packages will be (?:upgraded|removed|installed|REMOVED)|^NEW packages the following|^\d+ upgraded,\s+\d+ newly installed/i;
/** apk "fetch http://..." download lines. */
const _APK_FETCH_RE: RegExp = /^fetch\s+http/i;
/** apk "(N/N) Installing / Upgrading / Purging / Reinstalling …" lines. */
const _APK_INSTALLING_RE: RegExp =
  /^\(\s*\d+\/\d+\)\s+(?:Installing|Upgrading|Purging|Reinstalling)\s+\S/i;
/** apk "OK: N packages, N dirs" summary line. */
const _APK_OK_RE: RegExp = /^OK:\s+\d+/i;
/** brew "==> Downloading / Fetching / Installing / Pouring" progress lines. */
const _BREW_PROGRESS_RE: RegExp =
  /^==> (?:Downloading|Fetching|Installing|Pouring|Tapping|Untapping|Auto-updated|Updating|Cloning)/i;
/** brew "Already installed" or "is already installed" messages. */
const _BREW_ALREADY_RE: RegExp = /already installed/i;
/** brew summary / warning / error lines (keep always). */
const _BREW_SUMMARY_RE: RegExp =
  /^Warning:|^Error:|^==> Summary|^🍺|^\s*[\w\-]+\s+\d+\.\d/i;

// ===========================================================================
// SysPackageFilter (Python ~17106-17241)
// ===========================================================================

/**
 * Compress `apt-get` / `apt` / `apk` / `brew` package-manager output.
 *
 * System package managers produce verbose multi-line progress: apt "Get:N"
 * download + "Unpacking"/"Setting up" lines; apk "(N/N) Installing …" lines;
 * brew "==> Downloading / Pouring" lines per package. All of this is pure
 * progress noise when the install succeeds.
 *
 * apt/apt-get: collapse Get:N download lines, Unpacking/Setting up/Processing
 * triggers to counts; keep package-list headers and the Fetched summary; keep
 * all error/warning lines. apk: collapse fetch + Installing to counts; keep
 * OK: summary and errors. brew: sample first 3 progress lines + count; keep
 * Summary and all error/warning lines.
 */
export class SysPackageFilter extends Filter {
  override name = "sys-pkg";
  override binaries: ReadonlySet<string> = new Set([
    "apt-get",
    "apt",
    "apt-cache",
    "apk",
    "brew",
  ]);

  override compress(stdout: string, stderr: string, _exit_code: number, argv: string[]): string {
    const binary = argv.length > 0 ? _pathStemLower(argv[0]!) : "apt-get";
    if (binary === "apt-get" || binary === "apt" || binary === "apt-cache") {
      return this._compress_apt(stdout, stderr);
    }
    if (binary === "apk") {
      return this._compress_apk(stdout, stderr);
    }
    return this._compress_brew(stdout, stderr);
  }

  /** Compress apt / apt-get output: collapse downloads + install progress to counts. */
  _compress_apt(stdout: string, stderr: string): string {
    const merged = this._combine_output(stdout, stderr);
    const lines = merged.split("\n");
    const kept: string[] = [];
    let dl_count = 0;
    let install_progress = 0;
    let trigger_count = 0;
    for (const line of lines) {
      if (_reSearch(_ERROR_SIGNAL_RE, line)) {
        kept.push(line);
        continue;
      }
      if (_reMatch(_APT_GET_RE, line)) {
        dl_count += 1;
        continue;
      }
      if (_reMatch(_APT_BOILERPLATE_RE, line)) {
        // Keep boilerplate but don't count it — it's short and provides context.
        kept.push(line);
        continue;
      }
      if (_reMatch(_APT_PKG_LIST_HDR_RE, line)) {
        // Keep package-list summary headers verbatim.
        kept.push(line);
        continue;
      }
      if (_reMatch(_APT_FETCHED_RE, line)) {
        kept.push(line);
        continue;
      }
      if (_reMatch(_APT_INSTALL_PROGRESS_RE, line)) {
        install_progress += 1;
        continue;
      }
      if (_reMatch(_APT_TRIGGERS_RE, line)) {
        trigger_count += 1;
        continue;
      }
      kept.push(line);
    }

    const notes: string[] = [];
    _maybe_note(notes, dl_count, `collapsed ${dl_count} 'Get:N' download lines`);
    _maybe_note(notes, install_progress, `collapsed ${install_progress} 'Unpacking/Setting up' lines`);
    _maybe_note(notes, trigger_count, `collapsed ${trigger_count} 'Processing triggers' lines`);
    Filter._emit_notes(kept, notes);
    return Filter._finalize(kept);
  }

  /** Compress apk output: collapse fetch + Installing to counts. */
  _compress_apk(stdout: string, stderr: string): string {
    const merged = this._combine_output(stdout, stderr);
    const lines = merged.split("\n");
    const kept: string[] = [];
    let fetch_count = 0;
    let install_count = 0;
    for (const line of lines) {
      if (_reSearch(_ERROR_SIGNAL_RE, line)) {
        kept.push(line);
        continue;
      }
      if (_reMatch(_APK_OK_RE, line)) {
        kept.push(line);
        continue;
      }
      if (_reMatch(_APK_FETCH_RE, line)) {
        fetch_count += 1;
        continue;
      }
      if (_reMatch(_APK_INSTALLING_RE, line)) {
        install_count += 1;
        continue;
      }
      kept.push(line);
    }

    const notes: string[] = [];
    _maybe_note(notes, fetch_count, `collapsed ${fetch_count} 'fetch' download lines`);
    _maybe_note(notes, install_count, `collapsed ${install_count} 'Installing' progress lines`);
    Filter._emit_notes(kept, notes);
    return Filter._finalize(kept);
  }

  /** Compress brew output: sample first 3 progress lines + count rest. */
  _compress_brew(stdout: string, stderr: string): string {
    const merged = this._combine_output(stdout, stderr);
    const lines = merged.split("\n");
    const kept: string[] = [];
    const progress_sample: string[] = [];
    let progress_extra = 0;
    const _SAMPLE = 3;
    for (const line of lines) {
      if (_reSearch(_ERROR_SIGNAL_RE, line) || _reMatch(_BREW_SUMMARY_RE, line)) {
        kept.push(line);
        continue;
      }
      if (_reSearch(_BREW_ALREADY_RE, line)) {
        kept.push(line);
        continue;
      }
      if (_reMatch(_BREW_PROGRESS_RE, line)) {
        if (progress_sample.length < _SAMPLE) {
          progress_sample.push(line);
        } else {
          progress_extra += 1;
        }
        continue;
      }
      kept.push(line);
    }

    const out: string[] = [];
    out.push(...progress_sample);
    if (progress_extra) {
      out.push(`[token-goat: +${progress_extra} more brew progress lines collapsed]`);
    }
    out.push(...kept);
    return Filter._finalize(out);
  }
}

// ===========================================================================
// protoc regexes (Python ~17246-17267).
// ===========================================================================

/** libprotobuf INFO log lines: "[libprotobuf INFO file.cc:N] message". */
const _PROTOC_INFO_RE: RegExp = /^\[libprotobuf INFO /;
/** libprotobuf WARNING/ERROR log lines — always keep. */
const _PROTOC_LIB_WARN_RE: RegExp = /^\[libprotobuf (?:WARNING|ERROR) /;
/** Proto file diagnostic: "path/to/file.proto:N:N: error/warning: message". */
const _PROTOC_DIAG_RE: RegExp = /^[^\s:][^:]*\.proto:\d+:\d+: (?:warning|error):/i;
/** File-not-found errors: "path/to/file.proto: File not found." */
const _PROTOC_NOT_FOUND_RE: RegExp = /^[^\s:][^:]*\.proto: File not found\./;
/** "N errors generated." / "N warnings generated." summary lines. */
const _PROTOC_SUMMARY_RE: RegExp = /^\d+ (?:errors?|warnings?) generated\./i;

// ===========================================================================
// ProtocFilter (Python ~17270-17350)
// ===========================================================================

/**
 * Compress `protoc` (Protocol Buffer compiler) output.
 *
 * protoc generates one line per file it processes and emits verbose
 * "[libprotobuf INFO ...]" log lines at the default INFO log level. On a large
 * proto tree with many imports this can produce hundreds of lines of noise
 * before a single diagnostic.
 *
 * Drop INFO libprotobuf log lines; keep WARNING/ERROR libprotobuf lines,
 * file.proto:N:N: diagnostics, "File not found." errors, and the
 * "N errors/warnings generated." summary. Collapse repeated identical
 * warning/diagnostic lines to a count (protoc can emit the same "no syntax
 * specified" warning dozens of times for deeply nested import graphs).
 */
export class ProtocFilter extends Filter {
  override name = "protoc";
  override binaries: ReadonlySet<string> = new Set([
    "protoc",
    "protoc-gen-go",
    "protoc-gen-grpc",
    "buf",
  ]);

  override compress(stdout: string, stderr: string, _exit_code: number, _argv: string[]): string {
    const merged = this._combine_output(stdout, stderr);
    const lines = merged.split("\n");

    const kept: string[] = [];
    let dropped_info = 0;
    // Track repeated identical warning lines; value = repeat count.
    const warn_seen = new Map<string, number>();
    let deduped_warns = 0;

    for (const line of lines) {
      // Always keep error signals from the generic helper — UNLESS this is a
      // libprotobuf INFO line (which would otherwise match "error:"/"ERROR"
      // substrings inside an INFO message). INFO lines are dropped below.
      if (_reSearch(_ERROR_SIGNAL_RE, line) && !_reMatch(_PROTOC_INFO_RE, line)) {
        kept.push(line);
        continue;
      }
      // Drop INFO-level libprotobuf log lines.
      if (_reMatch(_PROTOC_INFO_RE, line)) {
        dropped_info += 1;
        continue;
      }
      // Always keep WARNING/ERROR libprotobuf lines (dedup repeats).
      if (_reMatch(_PROTOC_LIB_WARN_RE, line)) {
        if (warn_seen.has(line)) {
          warn_seen.set(line, (warn_seen.get(line) ?? 0) + 1);
          deduped_warns += 1;
          continue;
        }
        warn_seen.set(line, 1);
        kept.push(line);
        continue;
      }
      // Keep proto diagnostics (file.proto:N:N: error/warning:) — dedup repeats.
      if (_reMatch(_PROTOC_DIAG_RE, line)) {
        if (warn_seen.has(line)) {
          warn_seen.set(line, (warn_seen.get(line) ?? 0) + 1);
          deduped_warns += 1;
          continue;
        }
        warn_seen.set(line, 1);
        kept.push(line);
        continue;
      }
      // Keep "File not found." errors.
      if (_reMatch(_PROTOC_NOT_FOUND_RE, line)) {
        kept.push(line);
        continue;
      }
      // Keep summary lines.
      if (_reMatch(_PROTOC_SUMMARY_RE, line)) {
        kept.push(line);
        continue;
      }
      // Keep everything else (short output, custom plugin stderr, etc.).
      kept.push(line);
    }

    const notes: string[] = [];
    _maybe_note(notes, dropped_info, `dropped ${dropped_info} [libprotobuf INFO] lines`);
    _maybe_note(notes, deduped_warns, `collapsed ${deduped_warns} duplicate warning/diagnostic lines`);
    Filter._emit_notes(kept, notes);
    return Filter._finalize(kept);
  }
}

// ===========================================================================
// Prettier regexes (Python ~17599-17614).
// ===========================================================================

/**
 * Prettier --write emits one line per processed file, optionally with a timing:
 *   "src/foo.ts 203ms"
 *   "src/bar/index.js 12ms (unchanged)"
 *   "src/baz.css 45ms"
 * In --check mode it emits:
 *   "Checking formatting..."
 *   "src/foo.ts"
 *   "src/bar.ts"
 *   "Code style issues found in N files. Forgot to run Prettier?"
 */
const _PRETTIER_FILE_RE: RegExp =
  // A file line: optional leading spaces, a path (contains '/' or '.'),
  // optional timing (e.g. "203ms") and optional status annotation.
  // Excludes lines starting with '[' (token-goat notes) or pure text.
  /^(?!\[)\s*\S+[./]\S*\s*(?:\d+ms)?\s*(?:\(unchanged\))?\s*$/;
/** Prettier summary / error lines — always keep. */
const _PRETTIER_SUMMARY_RE: RegExp =
  /^(?:All matched files|Code style issues found|Checking formatting|Pretty-Format:|prettier \[warn\]|prettier \[error\]|\[warn\]|\[error\])/i;
/** Prettier "unchanged" annotation: keep files with (unchanged) as a sample too. */
const _PRETTIER_UNCHANGED_RE: RegExp = /\(unchanged\)\s*$/;

// ===========================================================================
// PrettierFilter (Python ~17617-17693)
// ===========================================================================

/**
 * Compress `prettier --write` / `prettier --check` output.
 *
 * `prettier --write .` emits one line per processed file (with optional timing
 * like `203ms`). On a large project this is hundreds of lines before the
 * summary.
 *
 * Sample changed-file lines (keep first 5, collapse the rest to a count); drop
 * `(unchanged)` file lines entirely; keep all summary/warning/error lines
 * and any line matching the generic error signal.
 */
export class PrettierFilter extends Filter {
  override name = "prettier";
  override binaries: ReadonlySet<string> = new Set(["prettier", "npx", "pnpx"]);

  override matches(argv: string[]): boolean {
    if (argv.length === 0) {
      return false;
    }
    const stem = _pathStemLower(argv[0]!);
    if (stem === "prettier") {
      return true;
    }
    // npx prettier ... / pnpx prettier ...
    return (
      (stem === "npx" || stem === "pnpx") &&
      argv.length > 1 &&
      argv[1]!.toLowerCase() === "prettier"
    );
  }

  _SAMPLE_SIZE: number = 5;

  override compress(stdout: string, stderr: string, _exit_code: number, _argv: string[]): string {
    const combined = this._combine_output(stdout, stderr);
    const lines = combined.split("\n");
    const kept: string[] = [];
    const changed_sample: string[] = [];
    let changed_extra = 0;
    let dropped_unchanged = 0;

    for (const line of lines) {
      // Always keep error signals
      if (_reSearch(_ERROR_SIGNAL_RE, line)) {
        kept.push(line);
        continue;
      }
      // Always keep summary / warning / error annotation lines
      if (_reMatch(_PRETTIER_SUMMARY_RE, line)) {
        kept.push(line);
        continue;
      }
      // File lines with (unchanged) — drop
      if (_reMatch(_PRETTIER_FILE_RE, line) && _reSearch(_PRETTIER_UNCHANGED_RE, line)) {
        dropped_unchanged += 1;
        continue;
      }
      // Changed file lines — sample
      if (_reMatch(_PRETTIER_FILE_RE, line)) {
        if (changed_sample.length < this._SAMPLE_SIZE) {
          changed_sample.push(line);
        } else {
          changed_extra += 1;
        }
        continue;
      }
      kept.push(line);
    }

    const out: string[] = [];
    out.push(...changed_sample);
    if (changed_extra) {
      out.push(
        `[token-goat: +${changed_extra} more formatted files; ` +
          `disable via TOKEN_GOAT_BASH_COMPRESS for full list]`,
      );
    }
    out.push(...kept);
    const notes: string[] = [];
    _maybe_note(notes, dropped_unchanged, `dropped ${dropped_unchanged} unchanged-file lines`);
    Filter._emit_notes(out, notes);
    return Filter._finalize(out);
  }
}
