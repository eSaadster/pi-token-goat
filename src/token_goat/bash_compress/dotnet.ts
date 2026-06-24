/**
 * bash_compress .NET / DENO / MESON FILTERS — TypeScript port of the
 * Dotnet / MSBuild / NuGet / PowerShell / Deno / Meson Filter subclasses from
 * src/token_goat/bash_compress.py.
 *
 * Six filters subclass the concrete Filter base from ./framework.js:
 *   - DotnetFilter    — `dotnet` (.NET CLI). Overrides matches() (stem == dotnet)
 *                       and compress() (per-subcommand dispatch: test / restore /
 *                       build|publish|pack / format; run/ef/tool pass through with
 *                       dedupe_consecutive). Helper methods _compress_restore /
 *                       _compress_format / _compress_build / _compress_test.
 *   - MSBuildFilter   — `msbuild` / `msbuild.exe`. Overrides matches() (stem ==
 *                       msbuild OR name == msbuild.exe) and compress().
 *   - NuGetFilter     — `nuget` / `nuget.exe`. Overrides matches() and compress().
 *   - PowerShellFilter— `pwsh` / `powershell` / `powershell.exe`. Overrides
 *                       matches() and compress(); _dedup_lines for WARNING dedup.
 *   - DenoFilter      — `deno`. Overrides compress() (per-subcommand dispatch:
 *                       test / compile|bundle / check|lint|fmt / generic). Uses the
 *                       default Filter.matches() (binaries match).
 *   - MesonFilter     — `meson`. error_passthrough = true; overrides matches()
 *                       (stem == meson) and _compress_body() (NOT compress).
 *
 * ---------------------------------------------------------------------------
 * Parity notes (Python -> TS)
 * ---------------------------------------------------------------------------
 *  - Python identifiers preserved EXACTLY: PascalCase class names (DotnetFilter,
 *    MSBuildFilter, NuGetFilter, PowerShellFilter, DenoFilter, MesonFilter);
 *    snake_case methods/fields (matches, compress, _compress_body,
 *    _compress_restore, _compress_format, _compress_build, _compress_test,
 *    _compress_compile, _compress_check, _compress_generic); snake_case
 *    module-private regex constants (_DOTNET_*, _MSBUILD_*, _NUGET_*, _PWSH_*,
 *    _DENO_*, _MESON_*).
 *  - re.compile(...) -> top-level RegExp compiled once. re.IGNORECASE -> "i".
 *  - Python re.Pattern.match(line) is START-anchored (NOT end-anchored); emulated
 *    via _reMatch (non-global clone + index===0). .search() -> _reSearch
 *    (non-global clone, .test anywhere). The MSBuild warning capture group (code)
 *    is read via _reMatchObj.
 *  - _ERROR_SIGNAL_RE is framework-PRIVATE (not exported by framework.ts); it is
 *    re-declared MODULE-PRIVATE here (NOT exported) to avoid a duplicate-export
 *    ambiguity (TS2308) across the barrel export* chain.
 *  - Path(argv[0]).stem.lower() / .name.lower() -> local _pathStemLower /
 *    _pathNameLower (final component after backslash-norm, last suffix stripped for
 *    stem, lowercased) — matching framework _pathStem/_pathName.
 *  - _maybe_note / _positional_args / dedupe_consecutive / _squeeze_blank_lines /
 *    _dedup_lines are framework-PUBLIC and imported. _combine_output is an
 *    INSTANCE method; _finalize / _emit_notes are STATIC methods on Filter.
 *  - DenoFilter._compress_test / _compress_check use the Python `text.rstrip()`
 *    short-circuit for <= 30 non-empty lines -> _rstrip (full-whitespace rstrip).
 *  - Python set[str] (seen_warning_codes) -> JS Set<string>; str.upper() ->
 *    .toUpperCase(); str.strip() -> .trim().
 *  - DotnetFilter._compress_build two-pass "Build succeeded." collapse: gather the
 *    indices, drop all but the last via a drop-set filter (set semantics
 *    preserved).
 *  - Module-global mutable state: NONE. Every counter/dict/list/set is a local
 *    inside compress()/helpers; no registerReset seam is needed.
 *
 * NOTE on import depth: this file lives in the bash_compress/ SUBDIR; the
 * framework is a SIBLING (./framework.js). verbatimModuleSyntax is on -> nothing
 * imported here is type-only. noImplicitOverride is on -> every overridden member
 * carries `override`.
 */

import {
  Filter,
  _dedup_lines,
  _maybe_note,
  _positional_args,
  _squeeze_blank_lines,
  dedupe_consecutive,
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

/** Python str.rstrip() — strip trailing ASCII+Unicode whitespace. */
function _rstrip(s: string): string {
  return s.replace(/\s+$/u, "");
}

// ===========================================================================
// Module-private framework regexes re-declared here (framework does NOT export
// _ERROR_SIGNAL_RE — re-exporting it would create a TS2308 ambiguity).
// ===========================================================================

/** Python _ERROR_SIGNAL_RE (framework-private) — re-declared module-private. */
const _ERROR_SIGNAL_RE: RegExp =
  /error:|Error:|ERROR|FAILED|failed|fatal:|Traceback|exception:|Exception:|AssertionError|assert |panic:/i;

// ===========================================================================
// dotnet (MSBuild / .NET CLI) regexes (Python ~12362-12425).
// ===========================================================================

// MSBuild-style build output: "  Foo -> /path/to/Foo.dll"
const _DOTNET_BUILD_ARROW_RE: RegExp = /^\s+\S+ ->\s+/;
// Restore/download progress lines
const _DOTNET_RESTORE_RE: RegExp =
  /^\s*(Determining projects|Writing assets|Restoring packages for|Installing|Generating|OK https?:\/\/|log\s+:\s+Restore[d]? |MSBuild auto-detection|Feeds used:)\b/i;
// Per-project build summary repetition lines — "Build succeeded" repeats once per
// project in multi-project solutions; the final occurrence is the only one that matters.
const _DOTNET_BUILD_SUCCEEDED_RE: RegExp = /^Build succeeded\.\s*$/i;
// MSBuild project evaluation noise
const _DOTNET_MSBUILD_NOISE_RE: RegExp =
  /^\s*(Project|Target|Task|Using|Overriding) "|^\s*MSBuild version/i;
// Test result lines
const _DOTNET_TEST_PASS_RE: RegExp = /^\s*(Passed|passed)\s+\S/;
const _DOTNET_TEST_FAIL_RE: RegExp = /^\s*(Failed|failed|Error)\s+\S/;
const _DOTNET_TEST_SUMMARY_RE: RegExp =
  /^\s*(Test Run|Total tests|Passed:|Failed:|Skipped:|Test results file)/;
// ``dotnet format`` per-file output lines.
const _DOTNET_FORMAT_FILE_RE: RegExp =
  /^\s*(Formatted code in|Fixed code style violations in|Fixing code style in|Fixed whitespace in|Fixing whitespace in|Fixing analyzer violations in|Fixed analyzer violations in)\s+'/i;
const _DOTNET_FORMAT_SUMMARY_RE: RegExp =
  /^\s*(Format complete|Completed format|dotnet-format.*complete|\d+ file\(s\) (?:were )?reformatted|No violations found|Format.*succeeded|Format.*failed)/i;
// Additional ``dotnet restore`` noise lines not covered by _DOTNET_RESTORE_RE.
const _DOTNET_RESTORE_EXTRA_RE: RegExp =
  /^\s*(Resolving conflicts for|Lock file|Acquiring lock|Reading project file|Cache file|Checking compatibility|HTTP\s+GET|HTTP\s+OK|HTTP\s+NotFound|Source\s+:\s+|PackageReference|Writing lock file)\b/i;

// ===========================================================================
// DotnetFilter
// ===========================================================================

export class DotnetFilter extends Filter {
  override name = "dotnet";
  override binaries: ReadonlySet<string> = new Set(["dotnet"]);

  override matches(argv: string[]): boolean {
    if (argv.length === 0) {
      return false;
    }
    const stem = _pathStemLower(argv[0]!);
    return stem === "dotnet";
  }

  override compress(stdout: string, stderr: string, _exit_code: number, argv: string[]): string {
    const positionals = _positional_args(argv.slice(1));
    const subcommand = positionals.length > 0 ? positionals[0]!.toLowerCase() : "";

    const merged = this._combine_output(stdout, stderr);
    const lines = merged.split("\n");

    if (subcommand === "test") {
      return this._compress_test(lines);
    }
    if (subcommand === "restore") {
      return this._compress_restore(lines);
    }
    if (subcommand === "build" || subcommand === "publish" || subcommand === "pack") {
      return this._compress_build(lines);
    }
    if (subcommand === "format") {
      return this._compress_format(lines);
    }
    // run, ef, tool, etc. — pass through with basic dedup
    return _squeeze_blank_lines(dedupe_consecutive(lines).join("\n"));
  }

  _compress_restore(lines: string[]): string {
    const kept: string[] = [];
    let dropped = 0;
    for (const line of lines) {
      if (_reSearch(_ERROR_SIGNAL_RE, line)) {
        kept.push(line);
        continue;
      }
      if (_reMatch(_DOTNET_RESTORE_RE, line) || _reMatch(_DOTNET_RESTORE_EXTRA_RE, line)) {
        dropped += 1;
        continue;
      }
      kept.push(line);
    }
    const notes = dropped ? [`dropped ${dropped} restore-progress lines`] : [];
    Filter._emit_notes(kept, notes);
    return Filter._finalize(kept);
  }

  /**
   * Compress ``dotnet format`` output.
   *
   * ``dotnet format`` emits one ``Formatted code in 'path/to/File.cs'.`` or
   * ``Fixed code style violations in 'path/to/File.cs'.`` line per modified file,
   * followed by a ``Format complete`` summary. On clean code it emits only the
   * summary. The per-file lines are pure noise — only violations (``error IDE…`` /
   * ``warning IDE…`` lines) and the summary matter.
   */
  _compress_format(lines: string[]): string {
    const kept: string[] = [];
    let formatted_count = 0;
    for (const line of lines) {
      // Keep violations / errors even inside format output.
      if (_reSearch(_ERROR_SIGNAL_RE, line)) {
        kept.push(line);
        continue;
      }
      // Keep the final summary line(s).
      if (_reMatch(_DOTNET_FORMAT_SUMMARY_RE, line)) {
        kept.push(line);
        continue;
      }
      // Drop per-file "Formatted code in …" progress lines.
      if (_reMatch(_DOTNET_FORMAT_FILE_RE, line)) {
        formatted_count += 1;
        continue;
      }
      kept.push(line);
    }
    const notes = formatted_count
      ? [`collapsed ${formatted_count} per-file 'Formatted …' lines`]
      : [];
    Filter._emit_notes(kept, notes);
    return Filter._finalize(kept);
  }

  _compress_build(lines: string[]): string {
    // Two-pass: first collect all lines with standard per-line drops, then
    // collapse repeated "Build succeeded." lines (common in multi-project
    // solutions where MSBuild emits one per project before the final global
    // summary).
    let kept: string[] = [];
    let arrow_count = 0;
    let dropped_arrows = 0;
    let dropped_msbuild = 0;
    for (const line of lines) {
      if (_reMatch(_DOTNET_MSBUILD_NOISE_RE, line) && !_reSearch(_ERROR_SIGNAL_RE, line)) {
        dropped_msbuild += 1;
        continue;
      }
      if (_reMatch(_DOTNET_BUILD_ARROW_RE, line) && !_reSearch(_ERROR_SIGNAL_RE, line)) {
        arrow_count += 1;
        if (arrow_count <= 5) {
          kept.push(line);
        } else {
          dropped_arrows += 1;
        }
        continue;
      }
      kept.push(line);
    }

    // Collapse repeated "Build succeeded." lines: keep only the last occurrence.
    const succeeded_indices: number[] = [];
    for (let i = 0; i < kept.length; i += 1) {
      if (_reMatch(_DOTNET_BUILD_SUCCEEDED_RE, kept[i]!)) {
        succeeded_indices.push(i);
      }
    }
    let dropped_succeeded = 0;
    if (succeeded_indices.length > 1) {
      const drop_set = new Set<number>(succeeded_indices.slice(0, -1));
      kept = kept.filter((_ln, i) => !drop_set.has(i));
      dropped_succeeded = drop_set.size;
    }

    const notes: string[] = [];
    _maybe_note(notes, dropped_arrows, `collapsed ${dropped_arrows} additional project-output arrows`);
    _maybe_note(notes, dropped_msbuild, `dropped ${dropped_msbuild} MSBuild evaluation lines`);
    _maybe_note(notes, dropped_succeeded, `collapsed ${dropped_succeeded} repeated 'Build succeeded' lines`);
    Filter._emit_notes(kept, notes);
    return Filter._finalize(kept);
  }

  _compress_test(lines: string[]): string {
    const kept: string[] = [];
    let pass_count = 0;
    let in_fail_block = false;
    for (const line of lines) {
      if (_reMatch(_DOTNET_TEST_FAIL_RE, line)) {
        in_fail_block = true;
        kept.push(line);
        continue;
      }
      if (_reMatch(_DOTNET_TEST_PASS_RE, line)) {
        in_fail_block = false;
        pass_count += 1;
        continue;
      }
      if (_reMatch(_DOTNET_TEST_SUMMARY_RE, line)) {
        in_fail_block = false;
        kept.push(line);
        continue;
      }
      if (in_fail_block && (line.startsWith("  ") || line.startsWith("\t") || line.trim() === "")) {
        kept.push(line);
        continue;
      }
      in_fail_block = false;
      kept.push(line);
    }
    const notes = pass_count ? [`collapsed ${pass_count} passing test lines`] : [];
    Filter._emit_notes(kept, notes);
    return Filter._finalize(kept);
  }
}

// ===========================================================================
// MSBuild regexes (Python ~15287-15335).
// ===========================================================================

/** "Build started" / project-is-building header lines */
const _MSBUILD_BUILD_STARTED_RE: RegExp = /^\s*Build started/i;
/** "Project ... is building" project header (multi-project parallel builds) */
const _MSBUILD_PROJECT_BUILDING_RE: RegExp = /^\s*Project\s+".+"\s+\(targets?\)/i;
/** "Copying file from ... to ..." lines */
const _MSBUILD_COPY_RE: RegExp = /^\s*Copying file from\s+/i;
/** "Creating directory ..." lines */
const _MSBUILD_MKDIR_RE: RegExp = /^\s*Creating directory\s+/i;
/** Task name lines like "  GenerateResource:" / "  Csc:" / "  Link:" */
const _MSBUILD_TASK_RE: RegExp = /^\s{2,4}[A-Z][A-Za-z0-9]+:\s*$/;
/** "Build succeeded." line */
const _MSBUILD_SUCCEEDED_RE: RegExp = /^\s*Build succeeded\.\s*$/i;
/** "X Error(s) / Warning(s)" summary lines */
const _MSBUILD_SUMMARY_COUNT_RE: RegExp = /^\s*\d+\s+(?:Error|Warning)\(s\)\s*$/i;
/** MSBuild error line with (file:line) location  e.g. "file.cs(10,5): error CS0001: ..." */
const _MSBUILD_ERROR_RE: RegExp = /.*\(\d+(?:,\d+)?\)\s*:\s*error\s+/i;
/** MSBuild warning line with (file:line) location */
const _MSBUILD_WARNING_RE: RegExp = /.*\(\d+(?:,\d+)?\)\s*:\s*warning\s+(\w+)/i;
/** General MSBuild "done building" / "target ... skipped" noise lines */
const _MSBUILD_NOISE_RE: RegExp =
  /^\s*(?:Done building|Target\s+".+"\s+skipped|Time Elapsed)\b/i;

// ===========================================================================
// MSBuildFilter
// ===========================================================================

export class MSBuildFilter extends Filter {
  override name = "msbuild";
  override binaries: ReadonlySet<string> = new Set(["msbuild", "msbuild.exe"]);

  override matches(argv: string[]): boolean {
    if (argv.length === 0) {
      return false;
    }
    const stem = _pathStemLower(argv[0]!);
    const name = _pathNameLower(argv[0]!);
    return stem === "msbuild" || name === "msbuild.exe";
  }

  override compress(stdout: string, stderr: string, exit_code: number, _argv: string[]): string {
    const merged = this._combine_output(stdout, stderr);
    const lines = merged.split("\n");

    const kept: string[] = [];
    let build_started_count = 0;
    let copy_count = 0;
    let mkdir_count = 0;
    let task_count = 0;
    let dropped_noise = 0;
    const seen_warning_codes = new Set<string>();
    let dup_warning_count = 0;

    for (const line of lines) {
      // Error lines: always keep
      if (_reMatch(_MSBUILD_ERROR_RE, line)) {
        kept.push(line);
        continue;
      }
      // Summary count lines and build-succeeded: always keep
      if (_reMatch(_MSBUILD_SUCCEEDED_RE, line) || _reMatch(_MSBUILD_SUMMARY_COUNT_RE, line)) {
        kept.push(line);
        continue;
      }
      // Warning lines: keep, but deduplicate same warning code
      const m = _reMatchObj(_MSBUILD_WARNING_RE, line);
      if (m) {
        const code = m[1]!.toUpperCase();
        if (seen_warning_codes.has(code)) {
          dup_warning_count += 1;
        } else {
          seen_warning_codes.add(code);
          kept.push(line);
        }
        continue;
      }
      // "Build started" headers: keep first, collapse repeats
      if (_reMatch(_MSBUILD_BUILD_STARTED_RE, line) || _reMatch(_MSBUILD_PROJECT_BUILDING_RE, line)) {
        build_started_count += 1;
        if (build_started_count === 1) {
          kept.push(line);
        }
        continue;
      }
      // Copying file lines
      if (_reMatch(_MSBUILD_COPY_RE, line)) {
        copy_count += 1;
        continue;
      }
      // Creating directory lines
      if (_reMatch(_MSBUILD_MKDIR_RE, line)) {
        mkdir_count += 1;
        continue;
      }
      // Task-name-only lines (e.g. "  Csc:")
      if (_reMatch(_MSBUILD_TASK_RE, line)) {
        task_count += 1;
        continue;
      }
      // Noise lines on success
      if (_reMatch(_MSBUILD_NOISE_RE, line) && exit_code === 0) {
        dropped_noise += 1;
        continue;
      }
      kept.push(line);
    }

    const notes: string[] = [];
    if (build_started_count > 1) {
      notes.push(`collapsed ${build_started_count - 1} repeated build-started headers`);
    }
    _maybe_note(notes, copy_count, `collapsed ${copy_count} file-copy lines`);
    _maybe_note(notes, mkdir_count, `collapsed ${mkdir_count} directory-creation lines`);
    _maybe_note(notes, task_count, `collapsed ${task_count} task-name lines`);
    _maybe_note(notes, dropped_noise, `dropped ${dropped_noise} noise lines`);
    _maybe_note(notes, dup_warning_count, `deduplicated ${dup_warning_count} repeated warnings`);
    Filter._emit_notes(kept, notes);
    return Filter._finalize(kept);
  }
}

// ===========================================================================
// NuGet regexes (Python ~15446-15470).
// ===========================================================================

/** "Installing PackageName version X.Y.Z" lines */
const _NUGET_INSTALLING_RE: RegExp = /^\s*Installing\s+\S+\s+\d+\.\d+/i;
/** "Restoring packages for ..." lines */
const _NUGET_RESTORING_RE: RegExp = /^\s*Restoring packages for\b/i;
/** "OK https://..." download-confirmation lines */
const _NUGET_OK_HTTPS_RE: RegExp = /^\s*OK\s+https?:\/\//i;
/** "Package X [version] is already installed" lines */
const _NUGET_ALREADY_INSTALLED_RE: RegExp = /^\s*Package\s+\S+.*\bis already installed/i;
/** "Successfully installed 'Package Version'" lines */
const _NUGET_SUCCESS_INSTALL_RE: RegExp = /^\s*Successfully installed\s+/i;

// ===========================================================================
// NuGetFilter
// ===========================================================================

export class NuGetFilter extends Filter {
  override name = "nuget";
  override binaries: ReadonlySet<string> = new Set(["nuget", "nuget.exe"]);

  override matches(argv: string[]): boolean {
    if (argv.length === 0) {
      return false;
    }
    const stem = _pathStemLower(argv[0]!);
    const name_lower = _pathNameLower(argv[0]!);
    return stem === "nuget" || name_lower === "nuget.exe";
  }

  override compress(stdout: string, stderr: string, _exit_code: number, _argv: string[]): string {
    const merged = this._combine_output(stdout, stderr);
    const lines = merged.split("\n");

    const kept: string[] = [];
    let installing_count = 0;
    const restoring_paths: string[] = [];
    let ok_download_count = 0;
    let already_installed_count = 0;
    let success_install_count = 0;

    for (const line of lines) {
      // Error lines: always keep
      if (_reSearch(_ERROR_SIGNAL_RE, line)) {
        kept.push(line);
        continue;
      }
      if (_reMatch(_NUGET_INSTALLING_RE, line)) {
        installing_count += 1;
        continue;
      }
      if (_reMatch(_NUGET_RESTORING_RE, line)) {
        restoring_paths.push(line.trim());
        continue;
      }
      if (_reMatch(_NUGET_OK_HTTPS_RE, line)) {
        ok_download_count += 1;
        continue;
      }
      if (_reMatch(_NUGET_ALREADY_INSTALLED_RE, line)) {
        already_installed_count += 1;
        continue;
      }
      if (_reMatch(_NUGET_SUCCESS_INSTALL_RE, line)) {
        success_install_count += 1;
        continue;
      }
      kept.push(line);
    }

    // Emit a single "Restoring packages" line if any were seen
    if (restoring_paths.length > 0) {
      if (restoring_paths.length === 1) {
        kept.unshift(restoring_paths[0]!);
      } else {
        kept.unshift(`Restoring packages for ${restoring_paths.length} projects`);
      }
    }

    const notes: string[] = [];
    _maybe_note(notes, installing_count, `collapsed ${installing_count} package-install lines`);
    _maybe_note(notes, ok_download_count, `collapsed ${ok_download_count} package-download lines`);
    _maybe_note(notes, already_installed_count, `collapsed ${already_installed_count} already-installed lines`);
    _maybe_note(notes, success_install_count, `collapsed ${success_install_count} successfully-installed lines`);
    Filter._emit_notes(kept, notes);
    return Filter._finalize(kept);
  }
}

// ===========================================================================
// PowerShell regexes (Python ~15554-15582).
// ===========================================================================

/** "VERBOSE: ..." lines (Set-PSDebug -Trace or $VerbosePreference) */
const _PWSH_VERBOSE_RE: RegExp = /^VERBOSE:\s/i;
/** "DEBUG: ..." lines */
const _PWSH_DEBUG_RE: RegExp = /^DEBUG:\s/i;
/** "WARNING: ..." lines */
const _PWSH_WARNING_RE: RegExp = /^WARNING:\s/i;
/** Install-Module progress lines ("PackageManagement\...") or "Install-Module: ..." */
const _PWSH_INSTALL_MODULE_RE: RegExp =
  /^(?:Install-Module:|PackageManagement\\|Installing package)\s/i;
/** Progress-record lines e.g. "Processing record X of Y" / "PROGRESS: X% complete" */
const _PWSH_PROGRESS_RECORD_RE: RegExp =
  /^(?:Processing record\s+\d+\s+of\s+\d+|PROGRESS:\s+\d+%)/i;
/** Terminating error indicator lines ("At line:", "CategoryInfo:", "FullyQualifiedErrorId:") */
const _PWSH_TERMINATING_ERROR_RE: RegExp =
  /^(?:At\s+\S+:\d+\s+char:\d+|CategoryInfo\s*:|FullyQualifiedErrorId\s*:|\+\s+~~~)/;

// ===========================================================================
// PowerShellFilter
// ===========================================================================

export class PowerShellFilter extends Filter {
  override name = "powershell";
  override binaries: ReadonlySet<string> = new Set(["pwsh", "powershell", "powershell.exe"]);

  override matches(argv: string[]): boolean {
    if (argv.length === 0) {
      return false;
    }
    const stem = _pathStemLower(argv[0]!);
    const name_lower = _pathNameLower(argv[0]!);
    return stem === "pwsh" || stem === "powershell" || name_lower === "powershell.exe";
  }

  override compress(stdout: string, stderr: string, _exit_code: number, _argv: string[]): string {
    const merged = this._combine_output(stdout, stderr);
    const lines = merged.split("\n");

    const kept: string[] = [];
    let verbose_count = 0;
    let debug_count = 0;
    let install_module_count = 0;
    let progress_count = 0;
    const warning_lines: string[] = [];

    for (const line of lines) {
      // Terminating error detail lines: always keep
      if (_reMatch(_PWSH_TERMINATING_ERROR_RE, line)) {
        kept.push(line);
        continue;
      }
      // General error signals: always keep
      if (_reSearch(_ERROR_SIGNAL_RE, line)) {
        kept.push(line);
        continue;
      }
      // VERBOSE lines
      if (_reMatch(_PWSH_VERBOSE_RE, line)) {
        verbose_count += 1;
        continue;
      }
      // DEBUG lines
      if (_reMatch(_PWSH_DEBUG_RE, line)) {
        debug_count += 1;
        continue;
      }
      // WARNING lines: collect for deduplication.
      if (_reMatch(_PWSH_WARNING_RE, line)) {
        warning_lines.push(line);
        continue;
      }
      // Install-Module progress lines
      if (_reMatch(_PWSH_INSTALL_MODULE_RE, line)) {
        install_module_count += 1;
        continue;
      }
      // Progress-record lines
      if (_reMatch(_PWSH_PROGRESS_RECORD_RE, line)) {
        progress_count += 1;
        continue;
      }
      kept.push(line);
    }

    // Deduplicate WARNING lines (keep first occurrence) and append after body.
    let deduped: string[];
    let dup_warning_count: number;
    if (warning_lines.length > 0) {
      [deduped, dup_warning_count] = _dedup_lines(warning_lines, 1);
    } else {
      [deduped, dup_warning_count] = [[], 0];
    }
    kept.push(...deduped);

    const notes: string[] = [];
    _maybe_note(notes, verbose_count, `collapsed ${verbose_count} VERBOSE lines`);
    _maybe_note(notes, debug_count, `collapsed ${debug_count} DEBUG lines`);
    _maybe_note(notes, install_module_count, `collapsed ${install_module_count} Install-Module progress lines`);
    _maybe_note(notes, progress_count, `collapsed ${progress_count} progress-record lines`);
    _maybe_note(notes, dup_warning_count, `deduplicated ${dup_warning_count} repeated warnings`);
    Filter._emit_notes(kept, notes);
    return Filter._finalize(kept);
  }
}

// ===========================================================================
// Deno regexes (Python ~18299-18333).
// ===========================================================================

/** deno test pass lines: "ok | test name ... N ms" */
const _DENO_TEST_PASS_RE: RegExp = /^\s*(?:ok\s+\||\bpassed\b|✓)\s+/i;
/** deno test fail lines — keep */
const _DENO_TEST_FAIL_RE: RegExp = /^\s*(?:FAILED|not\s+ok\s+\||✗|failed)\s*/i;
/** deno test summary line: "test result: ok. N passed; N failed ..." */
const _DENO_TEST_SUMMARY_RE: RegExp = /^test\s+result:|^(?:ok\.|FAILED\.)\s+\d+\s+passed/i;
/** deno compile / check progress: "Check file://..." */
const _DENO_CHECK_PROGRESS_RE: RegExp = /^Check\s+(?:file:\/\/|https?:\/\/)/i;
/** deno permission warnings */
const _DENO_PERM_WARN_RE: RegExp =
  /^(?:Deno\s+requests|Warning:\s+(?:--allow-|Deno\.|Granted))/i;
/** deno download / cache lines: "Download https://..." */
const _DENO_DOWNLOAD_RE: RegExp = /^Download\s+https?:\/\//i;
/** deno compile output artifacts: "Compile file://... -> ./binary" */
const _DENO_COMPILE_RE: RegExp = /^Compile\s+/i;

// ===========================================================================
// DenoFilter
// ===========================================================================

export class DenoFilter extends Filter {
  override name = "deno";
  override binaries: ReadonlySet<string> = new Set(["deno"]);

  override compress(stdout: string, stderr: string, _exit_code: number, argv: string[]): string {
    const positionals = argv.slice(1).filter((tok) => !tok.startsWith("-"));
    const subcmd = positionals.length > 0 ? positionals[0]!.toLowerCase() : "";

    const merged = this._combine_output(stdout, stderr);

    if (subcmd === "test") {
      return this._compress_test(merged);
    }
    if (subcmd === "compile" || subcmd === "bundle") {
      return this._compress_compile(merged);
    }
    if (subcmd === "check" || subcmd === "lint" || subcmd === "fmt") {
      return this._compress_check(merged);
    }

    // Generic: drop download lines; pass through the rest.
    return this._compress_generic(merged);
  }

  _compress_test(text: string): string {
    const lines = text.split("\n");
    const non_empty = lines.filter((ln) => ln.trim() !== "");
    if (non_empty.length <= 30) {
      return _rstrip(text);
    }

    const kept: string[] = [];
    let passes_dropped = 0;
    let downloads_dropped = 0;

    for (const line of lines) {
      if (_reSearch(_ERROR_SIGNAL_RE, line)) {
        kept.push(line);
        continue;
      }
      if (_reMatch(_DENO_TEST_FAIL_RE, line)) {
        kept.push(line);
        continue;
      }
      if (_reMatch(_DENO_TEST_SUMMARY_RE, line)) {
        kept.push(line);
        continue;
      }
      if (_reMatch(_DENO_PERM_WARN_RE, line)) {
        kept.push(line);
        continue;
      }
      if (_reMatch(_DENO_DOWNLOAD_RE, line)) {
        downloads_dropped += 1;
        continue;
      }
      if (_reMatch(_DENO_TEST_PASS_RE, line)) {
        passes_dropped += 1;
        continue;
      }
      kept.push(line);
    }

    const notes: string[] = [];
    _maybe_note(notes, passes_dropped, `collapsed ${passes_dropped} passing test lines`);
    _maybe_note(notes, downloads_dropped, `dropped ${downloads_dropped} module download/cache lines`);
    Filter._emit_notes(kept, notes);
    return Filter._finalize(kept);
  }

  _compress_compile(text: string): string {
    const lines = text.split("\n");
    const kept: string[] = [];
    let downloads_dropped = 0;

    for (const line of lines) {
      if (_reSearch(_ERROR_SIGNAL_RE, line)) {
        kept.push(line);
        continue;
      }
      if (_reMatch(_DENO_PERM_WARN_RE, line)) {
        kept.push(line);
        continue;
      }
      if (_reMatch(_DENO_COMPILE_RE, line)) {
        kept.push(line);
        continue;
      }
      if (_reMatch(_DENO_DOWNLOAD_RE, line)) {
        downloads_dropped += 1;
        continue;
      }
      kept.push(line);
    }

    const notes: string[] = [];
    _maybe_note(notes, downloads_dropped, `dropped ${downloads_dropped} module download lines`);
    Filter._emit_notes(kept, notes);
    return Filter._finalize(kept);
  }

  _compress_check(text: string): string {
    const lines = text.split("\n");
    const non_empty = lines.filter((ln) => ln.trim() !== "");
    if (non_empty.length <= 30) {
      return _rstrip(text);
    }

    const kept: string[] = [];
    let check_dropped = 0;
    let downloads_dropped = 0;

    for (const line of lines) {
      if (_reSearch(_ERROR_SIGNAL_RE, line)) {
        kept.push(line);
        continue;
      }
      if (_reMatch(_DENO_PERM_WARN_RE, line)) {
        kept.push(line);
        continue;
      }
      if (_reMatch(_DENO_CHECK_PROGRESS_RE, line)) {
        check_dropped += 1;
        continue;
      }
      if (_reMatch(_DENO_DOWNLOAD_RE, line)) {
        downloads_dropped += 1;
        continue;
      }
      kept.push(line);
    }

    const notes: string[] = [];
    _maybe_note(notes, check_dropped, `dropped ${check_dropped} Check progress lines`);
    _maybe_note(notes, downloads_dropped, `dropped ${downloads_dropped} module download lines`);
    Filter._emit_notes(kept, notes);
    return Filter._finalize(kept);
  }

  _compress_generic(text: string): string {
    const lines = text.split("\n");
    const kept: string[] = [];
    let downloads_dropped = 0;

    for (const line of lines) {
      if (_reMatch(_DENO_PERM_WARN_RE, line)) {
        kept.push(line);
        continue;
      }
      if (_reMatch(_DENO_DOWNLOAD_RE, line)) {
        downloads_dropped += 1;
        continue;
      }
      kept.push(line);
    }

    const notes: string[] = [];
    _maybe_note(notes, downloads_dropped, `dropped ${downloads_dropped} module download lines`);
    Filter._emit_notes(kept, notes);
    return Filter._finalize(kept);
  }
}

// ===========================================================================
// Meson build system regexes (Python ~23725-23760).
// ===========================================================================

/** meson setup: important header and project metadata lines — always keep */
const _MESON_KEEP_RE: RegExp =
  /^(?:The Meson build system$|Version:\s|Source dir:\s|Build dir:\s|Build type:\s|Project name:\s|Project version:\s|Build targets in project:\s|(?:C|C\+\+|Fortran|Rust|D|Go) compiler for the host machine:\s)/;
/** meson setup: indented compiler/toolchain detail lines — suppress */
const _MESON_COMPILER_DETAIL_RE: RegExp =
  /^  (?:Compiler|ld|linker|libtool|ar|ranlib|objcopy|objdump|strip|dlltool)\b|^    [a-z]/;
/** meson setup: "Found ninja-X.Y.Z at /path" — suppress (not actionable) */
const _MESON_FOUND_TOOL_RE: RegExp = /^Found (?:ninja|cmake|pkg-config)\b/;
/** meson setup: dependency/header/program probe lines — suppress, count */
const _MESON_PROBE_RE: RegExp =
  /^(?:Has (?:header|function|type|symbol|member)\s+'|Dependency \S|Program \S[^:]+found:|Library \S)/;
/** meson compile: "[N/M] Compiling ..." progress lines — suppress, count */
const _MESON_COMPILE_PROGRESS_RE: RegExp = /^\[\s*\d+\/\d+\] Compiling /;
/** meson compile: "[N/M] Linking ..." — keep (significant link step) */
const _MESON_LINK_RE: RegExp = /^\[\s*\d+\/\d+\] Linking /;

// ===========================================================================
// MesonFilter
// ===========================================================================

export class MesonFilter extends Filter {
  override error_passthrough = true;

  override name = "meson";
  override binaries: ReadonlySet<string> = new Set(["meson"]);

  override matches(argv: string[]): boolean {
    if (argv.length === 0) {
      return false;
    }
    const _base = (s: string): string => {
      const norm = s.replace(/\\/g, "/").replace(/\/+$/, "");
      const idx = norm.lastIndexOf("/");
      const name = idx >= 0 ? norm.slice(idx + 1) : norm;
      const dot = name.lastIndexOf(".");
      if (dot <= 0 || dot === name.length - 1) {
        return name.toLowerCase();
      }
      return name.slice(0, dot).toLowerCase();
    };
    return _base(argv[0]!) === "meson";
  }

  override _compress_body(stdout: string, stderr: string, _exit_code: number, _argv: string[]): string {
    const combined = this._combine_output(stdout, stderr);
    const lines = combined.split("\n");
    const kept: string[] = [];
    let compile_count = 0;
    let probe_count = 0;
    let detail_count = 0;

    for (const line of lines) {
      // Always keep error/warning diagnostics.
      if (_reSearch(_ERROR_SIGNAL_RE, line)) {
        kept.push(line);
        continue;
      }
      // Keep important setup metadata / summary lines.
      if (_reMatch(_MESON_KEEP_RE, line)) {
        kept.push(line);
        continue;
      }
      // Compile phase: [N/M] Linking — keep verbatim.
      if (_reMatch(_MESON_LINK_RE, line)) {
        kept.push(line);
        continue;
      }
      // Compile phase: [N/M] Compiling — count and suppress.
      if (_reMatch(_MESON_COMPILE_PROGRESS_RE, line)) {
        compile_count += 1;
        continue;
      }
      // Setup phase: indented compiler/toolchain detail lines — suppress.
      if (_reMatch(_MESON_COMPILER_DETAIL_RE, line)) {
        detail_count += 1;
        continue;
      }
      // Setup phase: dependency/probe lines — count and suppress.
      if (_reMatch(_MESON_PROBE_RE, line)) {
        probe_count += 1;
        continue;
      }
      // Setup phase: "Found ninja/cmake/pkg-config" — suppress.
      if (_reMatch(_MESON_FOUND_TOOL_RE, line)) {
        continue;
      }
      kept.push(line);
    }

    const notes: string[] = [];
    _maybe_note(notes, compile_count, `collapsed ${compile_count} [N/M] Compiling progress lines`);
    _maybe_note(notes, probe_count, `collapsed ${probe_count} dependency/probe check lines`);
    _maybe_note(notes, detail_count, `suppressed ${detail_count} compiler toolchain detail lines`);
    Filter._emit_notes(kept, notes);
    return Filter._finalize(kept);
  }
}
