/**
 * bash_compress BARREL — TypeScript port of the dispatch + registry surface of
 * src/token_goat/bash_compress.py (the 26,234-LOC compression mega-module).
 *
 * This file is the public module callers and tests import as
 * "../src/token_goat/bash_compress.js" (mirroring Python's `from token_goat
 * import bash_compress as bc`). It:
 *   1. Re-exports the FRAMEWORK public surface from ./bash_compress/framework.js
 *      (constants, helpers, CompressedOutput, BaseFilter, Filter, GenericFilter,
 *      PythonFilter).
 *   2. Defines the FILTERS registry, SEEDED with just the foundational filters
 *      available now (GenericFilter + PythonFilter). The ~150 tool-specific
 *      filters (CargoFilter, DockerFilter, GitFilter, PytestFilter, ...) get
 *      appended here in LATER RUNS as they are ported into sibling modules; a
 *      clearly-marked anchor below marks the append point.
 *   3. Defines the dispatch: select_filter / detect_from_command /
 *      compress_output / filter_by_name + the compound-segment wrapper
 *      (try_wrap_compound_segments), the canonical entry points the wrapper
 *      subprocess and the pre-bash hook call.
 *   4. Defines the __all__ array (the framework + base-filter names now; the
 *      ~150 filter names are appended by later runs).
 *
 * Mirrors the barrel/aggregation style of compact.ts / hooks_cli.ts (re-export
 * the submodule surface, keep a runtime __all__ array for the membership tests).
 *
 * ---------------------------------------------------------------------------
 * Parity notes (Python -> TS)
 * ---------------------------------------------------------------------------
 *  - The Python module is ONE file with the framework, all filters, and the
 *    dispatch interleaved. The TS port splits it: framework.ts holds the base
 *    classes + shared helpers + the two foundational filters; this barrel holds
 *    the registry + dispatch and re-exports the framework. Later runs add one
 *    module per filter family and append their instances to FILTERS here. This
 *    split is the only structural divergence; the runtime surface is identical
 *    (`bc.FILTERS`, `bc.compress_output`, `bc.GenericFilter`, ... all resolve).
 *  - FILTERS is `list[Filter]` in Python — order matters (first match wins).
 *    The seed order here is cosmetic (GenericFilter then PythonFilter) because
 *    in the FULL registry these two foundational fallbacks sit near the END
 *    (PythonFilter is mid-list; GenericFilter is the catch-all just before the
 *    TailTruncFilter). Later runs MUST insert the tool-specific filters AHEAD of
 *    these two at the marked anchor to preserve the Python first-match ordering.
 *    Reported in known_gaps.
 *  - select_filter / detect_from_command / compress_output / filter_by_name /
 *    try_wrap_compound_segments are copied verbatim from Python lines ~25652-
 *    25805. shlex.split(cmd, posix=True) -> framework._shlexSplit(cmd) (posix is
 *    the default). The raw-string operator guards (&&, ||, $(, `, |, ;) and the
 *    _REDIRECT_TOKEN_RE post-split check are byte-for-byte ports.
 *  - The dispatch helpers that the Python file places AFTER compress_output but
 *    that depend ONLY on framework symbols (try_wrap_compound_segments,
 *    _detect_single_segment, filter_by_name) ship here so the dispatch surface
 *    is complete in one place.
 *
 * verbatimModuleSyntax is on -> type-only imports use `import type`.
 * exactOptionalPropertyTypes is on -> optional fields are `T | undefined`.
 * noUncheckedIndexedAccess is on -> every indexed access is narrowed.
 */

import {
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_LINES,
  Filter,
  PythonFilter,
  TailTruncFilter,
  _shlexSplit,
  _strip_prefixes,
  getBashCompressLogger,
} from "./bash_compress/framework.js";

import { PytestFilter, JestFilter, VitestFilter, WebpackFilter } from "./bash_compress/test_runners.js";
import { CargoFilter } from "./bash_compress/cargo.js";
import { GoTestFilter, GoFilter, GolangciLintFilter } from "./bash_compress/go.js";
import { NpmInstallFilter, PnpmFilter, YarnFilter, BunFilter, NodePackageFilter, NodeFilter } from "./bash_compress/node_pm.js";
import { PlaywrightFilter, CypressFilter } from "./bash_compress/e2e.js";
import { DepListFilter, TscFilter, NxFilter, LernaFilter, TurboFilter } from "./bash_compress/node_tools.js";
import { GitFilter, GitLogFilter, GitStatusVerboseFilter, GitBlameFilter, GitCommitFilter, GitPushFilter } from "./bash_compress/git.js";
import { GitDiffFilter } from "./bash_compress/git_diff.js";
import { DockerFilter, DockerComposeFilter, KubectlFilter, KubectlLogsFilter, HelmFilter } from "./bash_compress/containers.js";
import { AwsCliFilter, AwsFilter, GcloudFilter, AzureCliFilter } from "./bash_compress/cloud.js";
import { RuffFilter, MypyFilter, ESLintFilter, LinterFilter } from "./bash_compress/linters.js";
import { PylintFilter, OxlintFilter, BiomeFilter } from "./bash_compress/linters2.js";
import { GhFilter, GhRunLogFilter, GhCopilotFilter, CopilotFilter, ActFilter, GenericCIFilter } from "./bash_compress/ci_gh.js";
import { RgFilter, GrepFilter } from "./bash_compress/search.js";
import { GradleFilter, MavenFilter, JavacFilter, AntFilter, BazelFilter, SbtFilter, MakeFilter } from "./bash_compress/jvm.js";
import { TerraformFilter, PulumiFilter, CdkFilter, WasmPackFilter, WranglerFilter, HardhatFilter, ServerlessFilter } from "./bash_compress/iac.js";
import { FlutterFilter, DartFilter, PubFilter, SwiftFilter, XcodeFilter, SwiftLintFilter } from "./bash_compress/mobile.js";
import { RubyFilter, BundlerFilter, CmakeFilter, MixFilter, ComposerFilter, PhpStanFilter } from "./bash_compress/ruby_php.js";
import { DotnetFilter, MSBuildFilter, NuGetFilter, PowerShellFilter, DenoFilter, MesonFilter } from "./bash_compress/dotnet.js";
import { AnsibleFilter, PreCommitFilter, PipFilter, GemFilter, UvFilter, CondaFilter } from "./bash_compress/pkg.js";
import { CurlFilter, RsyncFilter, FfmpegFilter, DotenvFilter } from "./bash_compress/utils.js";

// ---- Run 9: filter-family modules (CLI-utils / security / db / formatters /
// lang-misc / infra / cpp / deploy-ng / ai-tools / tail-filters) ----
import { DiffFilter, LsFilter, EzaFilter, FdFilter, WcFilter, TreeFilter } from "./bash_compress/cli_utils_a.js";
import { BatFilter, DeltaFilter, FzfFilter, LazyGitFilter, JqFilter, YqFilter } from "./bash_compress/cli_utils_b.js";
import { BanditFilter, TrivyFilter, SnykFilter, SemgrepFilter } from "./bash_compress/security.js";
import { PsqlFilter, MySQLFilter, Sqlite3Filter, RedisCLIFilter } from "./bash_compress/database.js";
import { BlackIsortFilter, PrettierFilter, SysPackageFilter, ProtocFilter } from "./bash_compress/formatters_sys.js";
import { KtlintFilter, ZigFilter, SassFilter, ElmFilter, JuliaFilter, ToxFilter, NoxFilter, CrystalFilter } from "./bash_compress/lang_misc.js";
import { VaultFilter, PackerFilter, NixFilter, HaskellFilter, RCmdFilter } from "./bash_compress/infra.js";
import { ConanFilter, VcpkgFilter, CppcheckFilter, ClangTidyFilter } from "./bash_compress/cpp.js";
import { ErlangFilter, FlyFilter, ForgeFilter, NgFilter } from "./bash_compress/deploy_ng.js";
import { AiderFilter, GeminiCliFilter, ClaudeCliFilter, CursorFilter, WindsurfFilter, OpenCodeFilter, ContinueFilter, ClineFilter, CodexExecFilter } from "./bash_compress/ai_tools.js";
import { EnvFilter, JsonArrayFilter, BinaryInspectFilter, FileTypeFilter, PsFilter, SeverityLogFilter } from "./bash_compress/tail_filters.js";

// ---- post_bash standalone helpers (Run 9 follow-up): the 28 class-less
// module-level detectors + dispatch predicates + 3 lightweight compressors that
// hooks_read.post_bash reaches via _bcFn/_bcRe on this barrel namespace. No
// filter INSTANCES live here, so nothing is appended to FILTERS — only the
// re-export below + the __all__ names. ----
import "./bash_compress/post_bash_helpers.js";

import type { CompressedOutput } from "./bash_compress/framework.js";

// Re-export the entire framework public surface so callers that import
// "bash_compress" reach every framework symbol (constants, helpers,
// CompressedOutput, BaseFilter, Filter, GenericFilter, PythonFilter) by either
// the snake_case/PascalCase Python name or its camelCase alias.
export * from "./bash_compress/framework.js";
// Re-export each filter category so `bc.<FilterName>` resolves (the import above
// binds them only for the FILTERS registry). LATER RUNS add an export line per
// filter module here.
export * from "./bash_compress/test_runners.js";
export * from "./bash_compress/cargo.js";
export * from "./bash_compress/go.js";
export * from "./bash_compress/node_pm.js";
export * from "./bash_compress/e2e.js";
export * from "./bash_compress/node_tools.js";
export * from "./bash_compress/git.js";
export * from "./bash_compress/git_diff.js";
export * from "./bash_compress/containers.js";
export * from "./bash_compress/cloud.js";
export * from "./bash_compress/linters.js";
export * from "./bash_compress/linters2.js";
export * from "./bash_compress/ci_gh.js";
export * from "./bash_compress/search.js";
export * from "./bash_compress/jvm.js";
export * from "./bash_compress/iac.js";
export * from "./bash_compress/mobile.js";
export * from "./bash_compress/ruby_php.js";
export * from "./bash_compress/dotnet.js";
export * from "./bash_compress/pkg.js";
export * from "./bash_compress/utils.js";
export * from "./bash_compress/cli_utils_a.js";
export * from "./bash_compress/cli_utils_b.js";
export * from "./bash_compress/security.js";
export * from "./bash_compress/database.js";
export * from "./bash_compress/formatters_sys.js";
export * from "./bash_compress/lang_misc.js";
export * from "./bash_compress/infra.js";
export * from "./bash_compress/cpp.js";
export * from "./bash_compress/deploy_ng.js";
export * from "./bash_compress/ai_tools.js";
export * from "./bash_compress/tail_filters.js";
// post_bash standalone helpers — the 28 detectors/predicates/compressors +
// _VT_PASSED_LINE_RE that hooks_read.post_bash looks up by name on this barrel.
export * from "./bash_compress/post_bash_helpers.js";

const _LOG = getBashCompressLogger();

// ===========================================================================
// Filter registry
// ===========================================================================

/**
 * Ordered registry of filter instances. First match wins (select_filter scans
 * top-to-bottom and returns the first whose matches(argv) is true).
 *
 * SEEDED with just the foundational fallback filters available in this run.
 * LATER RUNS append the ~150 tool-specific filter instances at the marked
 * anchor BELOW the framework comment but ABOVE these two fallbacks (the Python
 * registry orders the specific filters first and the generic fallbacks last —
 * see compact.ts-style parity notes in the header).
 *
 * Typed `Filter[]` (mutable) so later runs can `FILTERS.unshift(...)` /
 * `FILTERS.splice(...)` the tool-specific filters into position, or rebuild the
 * array. The Python type is `list[Filter]`.
 */
export const FILTERS: Filter[] = [
  // LATER RUNS append filter instances here (ahead of the two fallbacks below,
  // to preserve Python's first-match ordering where the tool-specific filters
  // precede GenericFilter / the trailing catch-alls).
  new PytestFilter(),
  new JestFilter(),
  new VitestFilter(),
  new WebpackFilter(),
  new DepListFilter(),
  new CargoFilter(),
  new NpmInstallFilter(),
  new PlaywrightFilter(),
  new CypressFilter(),
  new TscFilter(),
  new PnpmFilter(),
  new YarnFilter(),
  new BunFilter(),
  new NodePackageFilter(),
  new NodeFilter(),
  new NxFilter(),
  new LernaFilter(),
  new TurboFilter(),
  new DockerComposeFilter(),
  new DockerFilter(),
  new KubectlLogsFilter(),
  new HelmFilter(),
  new KubectlFilter(),
  new AwsCliFilter(),
  new AwsFilter(),
  new GcloudFilter(),
  new AzureCliFilter(),
  new GhCopilotFilter(),
  new CopilotFilter(),
  new GhRunLogFilter(),
  new GhFilter(),
  new ActFilter(),
  new GenericCIFilter(),
  new RuffFilter(),
  new MypyFilter(),
  new PylintFilter(),
  new OxlintFilter(),
  new ESLintFilter(),
  new BiomeFilter(),
  new LinterFilter(),
  new RgFilter(),
  new GrepFilter(),
  new GitLogFilter(),
  new GitDiffFilter(),
  new GitStatusVerboseFilter(),
  new GitBlameFilter(),
  new GitCommitFilter(),
  new GitPushFilter(),
  new GitFilter(),
  new GoTestFilter(),
  new GoFilter(),
  new GolangciLintFilter(),
  new GradleFilter(),
  new MavenFilter(),
  new JavacFilter(),
  new AntFilter(),
  new BazelFilter(),
  new SbtFilter(),
  new MakeFilter(),
  new TerraformFilter(),
  new PulumiFilter(),
  new CdkFilter(),
  new WasmPackFilter(),
  new WranglerFilter(),
  new HardhatFilter(),
  new ServerlessFilter(),
  new AnsibleFilter(),
  new PreCommitFilter(),
  new DotenvFilter(),
  new FlutterFilter(),
  new DartFilter(),
  new PubFilter(),
  new SwiftFilter(),
  new XcodeFilter(),
  new PipFilter(),
  new GemFilter(),
  new UvFilter(),
  new CondaFilter(),
  new CurlFilter(),
  new RsyncFilter(),
  new FfmpegFilter(),
  new DotnetFilter(),
  new MSBuildFilter(),
  new NuGetFilter(),
  new PowerShellFilter(),
  new RubyFilter(),
  new BundlerFilter(),
  new MixFilter(),
  new ComposerFilter(),
  new PhpStanFilter(),
  new SwiftLintFilter(),
  new DenoFilter(),
  new CmakeFilter(),
  new MesonFilter(),
  // ---- Run 9: CLI-utils (pre-PythonFilter; Python order Diff->Yq) ----
  new DiffFilter(),
  new LsFilter(),
  new EzaFilter(),
  new FdFilter(),
  new WcFilter(),
  new TreeFilter(),
  new BatFilter(),
  new DeltaFilter(),
  new FzfFilter(),
  new LazyGitFilter(),
  new JqFilter(),
  new YqFilter(),
  // ---- PythonFilter: REPOSITIONED from last to its Python mid-list slot (after Yq, before Bandit) ----
  new PythonFilter(),
  // ---- Run 9: post-PythonFilter tail (EXACT Python registry order) ----
  new BanditFilter(),
  new TrivyFilter(),
  new SnykFilter(),
  new SemgrepFilter(),
  new PsqlFilter(),
  new MySQLFilter(),
  new Sqlite3Filter(),
  new RedisCLIFilter(),
  new BlackIsortFilter(),
  new PrettierFilter(),
  new SysPackageFilter(),
  new ProtocFilter(),
  new KtlintFilter(),
  new ZigFilter(),
  new SassFilter(),
  new ElmFilter(),
  new JuliaFilter(),
  new ToxFilter(),
  new NoxFilter(),
  new CrystalFilter(),
  new VaultFilter(),
  new PackerFilter(),
  new NixFilter(),
  new HaskellFilter(),
  new RCmdFilter(),
  new ConanFilter(),
  new VcpkgFilter(),
  new CppcheckFilter(),
  new ClangTidyFilter(),
  new ErlangFilter(),
  new FlyFilter(),
  new ForgeFilter(),
  new AiderFilter(),
  new GeminiCliFilter(),
  new ClaudeCliFilter(),
  new CursorFilter(),
  new WindsurfFilter(),
  new OpenCodeFilter(),
  new ContinueFilter(),
  new ClineFilter(),
  new CodexExecFilter(),
  new NgFilter(),            // NOTE: Python places Ng AFTER CodexExec (post-AI), NOT with Erlang/Fly/Forge
  new EnvFilter(),
  new JsonArrayFilter(),
  new BinaryInspectFilter(),
  new FileTypeFilter(),
  new PsFilter(),
  new SeverityLogFilter(),
  // ---- Python true catch-all LAST. GenericFilter is intentionally NOT in this
  // registry (CPython's FILTERS has 156 entries and never registers it): it has
  // no binaries so it could never be selected by select_filter anyway, and
  // including it only diverged filter_by_name("generic") (→ the filter in TS vs
  // None in CPython). It stays exported as a class (reachable by direct
  // construction), matching CPython exactly. ----
  new TailTruncFilter(),
];

// ===========================================================================
// Dispatch
// ===========================================================================

// Shell redirect tokens: >, <, >>, 2>, 2>>, >&, &>, 1>, 1>>. Compiled at module
// level because detect_from_command() is on the critical path.
// Python: re.compile(r"^(\d*)(>>?|<<?).*$|^&>$|^>&.*$")
const _REDIRECT_TOKEN_RE: RegExp = /^(\d*)(>>?|<<?).*$|^&>$|^>&.*$/;

// Python: re.compile(r"\s*&&\s*")
const _COMPOUND_AND_RE: RegExp = /\s*&&\s*/;

/**
 * Python re.Pattern.match(tok) — anchored at the START of the string. JS regex
 * .test is unanchored; the patterns here are written with ^ so .test already
 * anchors at the front (and the | alternations each carry their own ^), so a
 * plain .test is the faithful match() equivalent.
 */
function _redirectMatch(tok: string): boolean {
  // Fresh test; _REDIRECT_TOKEN_RE has no global flag so lastIndex never leaks.
  return _REDIRECT_TOKEN_RE.test(tok);
}

/**
 * Return the first registered filter whose matches(argv) is true.
 *
 * Returns null when no filter applies; callers should NOT wrap such commands in
 * the compression subprocess (the overhead would be pure cost).
 *
 * The argv is prefix-stripped first via _strip_prefixes so `sudo time python -m
 * pytest` resolves to a pytest filter.
 */
export function select_filter(argv: string[]): Filter | null {
  if (argv.length === 0) {
    return null;
  }
  let resolved = _strip_prefixes(argv);
  if (resolved.length === 0) {
    // Prefix-stripping consumed the entire argv (e.g. bare `env`, `env -0`).
    // Fall back to the first original token so standalone env-dump commands can
    // still be routed to a dedicated filter.
    resolved = argv.slice(0, 1);
    if (resolved.length === 0) {
      return null;
    }
  }
  for (const f of FILTERS) {
    try {
      if (f.matches(resolved)) {
        return f;
      }
    } catch (exc) {
      // never let a custom filter break dispatch
      _LOG.error("filter %s raised during matches()", f.name, exc);
    }
  }
  return null;
}

/**
 * Parse a shell command string and return [filter, argv] or null.
 *
 * Convenience wrapper for the hook layer: the hook receives one string from the
 * harness, and dispatch needs both the filter and the argv. Returns null when:
 *  - the command exceeds 64 KiB,
 *  - _shlexSplit fails (unbalanced quotes: leave it alone),
 *  - the command is empty after prefix stripping,
 *  - no filter matches,
 *  - the command contains unquoted shell control operators (pipeline / sequence /
 *    substitution / redirect) that cannot be safely wrapped.
 */
export function detect_from_command(command: string): [Filter, string[]] | null {
  if (!command || command.length > 65_536) {
    return null;
  }
  // Raw-string checks: these operators can never appear as bare tokens AND be
  // "just part of an argument" in normal shell usage, so checking the raw string
  // is safe for them.
  if (["&&", "||", "$(", "`"].some((op) => command.includes(op))) {
    return null;
  }
  // Pipe and semicolon: a lone | or ; signals a pipeline / command list.
  if (command.includes("|") || command.includes(";")) {
    return null;
  }
  let argv: string[];
  try {
    argv = _shlexSplit(command, { posix: true });
  } catch {
    return null;
  }
  // Post-split redirect check: after shlex removes quotes, a bare > or < token
  // means shell redirect.
  if (argv.some((tok) => _redirectMatch(tok))) {
    return null;
  }
  const filter_ = select_filter(argv);
  if (filter_ === null) {
    return null;
  }
  return [filter_, _strip_prefixes(argv)];
}

/**
 * Like detect_from_command but for a single &&-split segment (no compound guard).
 *
 * Callers guarantee the segment was obtained by splitting on && and contains no
 * further compound operators. Still rejects ||, |, ;, $(), and backtick
 * substitution inside the segment.
 */
export function _detect_single_segment(segment: string): [Filter, string[]] | null {
  const seg = segment.trim();
  if (!seg || seg.length > 65_536) {
    return null;
  }
  if (["||", "$(", "`"].some((op) => seg.includes(op))) {
    return null;
  }
  if (seg.includes("|") || seg.includes(";")) {
    return null;
  }
  let argv: string[];
  try {
    argv = _shlexSplit(seg, { posix: true });
  } catch {
    return null;
  }
  if (argv.some((tok) => _redirectMatch(tok))) {
    return null;
  }
  const filter_ = select_filter(argv);
  if (filter_ === null) {
    return null;
  }
  return [filter_, _strip_prefixes(argv)];
}

/**
 * Wrap each &&-joined segment of a compound command independently.
 *
 * For a command like `git diff && git log --oneline -5`, each segment is
 * individually recognised and rewritten through the compression wrapper so the
 * full compound still executes but its output lands compressed in context.
 *
 * wrapper_args(filter_name, segment) returns the wrapped command string for one
 * segment, or null to leave that segment unchanged.
 *
 * Returns the rewritten compound command when at least one segment was wrapped,
 * or null when the command is not a safe &&-compound or no segment matched a
 * filter.
 */
export function try_wrap_compound_segments(
  command: string,
  opts: { wrapper_args: (filter_name: string, segment: string) => string | null },
): string | null {
  const { wrapper_args } = opts;
  if (!command || command.includes("||") || command.includes("|") || command.includes(";")) {
    return null;
  }
  if (command.includes("$(") || command.includes("`")) {
    return null;
  }
  if (!command.includes("&&")) {
    return null;
  }
  const segments = command.split(_COMPOUND_AND_RE).map((s) => s.trim());
  if (!(segments.length >= 2 && segments.length <= 8)) {
    return null;
  }
  const wrapped_segments: string[] = [];
  let any_wrapped = false;
  for (const seg of segments) {
    if (!seg) {
      return null; // empty segment (e.g. trailing &&) — bail
    }
    const detected = _detect_single_segment(seg);
    if (detected !== null) {
      const [filter_] = detected;
      const wrapped = wrapper_args(filter_.name, seg);
      if (wrapped !== null) {
        wrapped_segments.push(wrapped);
        any_wrapped = true;
        continue;
      }
    }
    wrapped_segments.push(seg);
  }
  if (!any_wrapped) {
    return null;
  }
  return wrapped_segments.join(" && ");
}

// Profile -> effective max_lines. Module-level constant (Python builds this dict
// inside compress_output; hoisting it is a harmless micro-optimisation that
// changes no behaviour).
const _PROFILE_CAPS: Readonly<Record<string, number>> = {
  aggressive: 50,
  balanced: 200,
  minimal: 500,
};

/**
 * Run filter_ over the captured output and return a CompressedOutput.
 *
 * This is the canonical entry point for the wrapper subprocess. Always succeeds
 * (the filter's own apply() catches exceptions and falls back to a head/tail
 * truncation).
 *
 * @param compression_profile One of "aggressive" (50 lines), "balanced" (200
 *   lines — the default), "minimal" (500 lines, skip dot-progress filtering).
 *   Any other value is treated as "balanced". The effective max_lines is
 *   min(max_lines, profile_cap) so the caller-supplied cap is still respected
 *   when it is tighter than the profile cap.
 */
export function compress_output(
  filter_: Filter,
  stdout: string,
  stderr: string,
  exit_code: number,
  argv: string[],
  opts?: {
    max_lines?: number;
    max_bytes?: number;
    compression_profile?: string;
  },
): CompressedOutput {
  const max_lines = opts?.max_lines ?? DEFAULT_MAX_LINES;
  const max_bytes = opts?.max_bytes ?? DEFAULT_MAX_BYTES;
  const compression_profile = opts?.compression_profile ?? "balanced";

  // Map profile -> effective max_lines and skip_progress flag.
  let effective_max_lines = _PROFILE_CAPS[compression_profile] ?? 200;
  // Respect the explicit caller cap when it is tighter.
  if (max_lines < effective_max_lines) {
    effective_max_lines = max_lines;
  }
  const skip_progress = compression_profile === "minimal";
  return filter_.apply(stdout, stderr, exit_code, argv, {
    max_lines: effective_max_lines,
    max_bytes,
    skip_progress,
  });
}

/**
 * Look up a registered filter by its Filter.name.
 *
 * Used when the hook layer has already detected the filter and the wrapper just
 * needs to reconstruct it from a CLI flag. Returns null for unknown names; the
 * wrapper should then fall back to select_filter.
 */
export function filter_by_name(name: string): Filter | null {
  for (const f of FILTERS) {
    if (f.name === name) {
      return f;
    }
  }
  return null;
}

// ===========================================================================
// __all__ — public symbol surface (parity with Python's bash_compress.__all__).
// ===========================================================================
// Kept as a runtime array so a test that asserts membership ports one-for-one.
// The names use the Python snake_case/PascalCase form (the canonical contract).
// SEEDED with the framework + base-filter + dispatch names available now; the
// ~150 tool-specific filter names are appended by later runs as their modules
// land (CargoFilter, DockerFilter, GitFilter, PytestFilter, ...). Reported in
// known_gaps.
export const __all__ = [
  "DEFAULT_MAX_BYTES",
  "DEFAULT_MAX_INPUT_BYTES",
  "DEFAULT_MAX_LINES",
  "CompressedOutput",
  "BaseFilter",
  "Filter",
  "FILTERS",
  "_safe_decode",
  "_collapse_to_count",
  "_dedup_lines",
  "_is_diff_add",
  "_is_diff_remove",
  "_keep_errors_verbatim",
  "_strip_timestamps",
  "bytes_to_tokens",
  "cap_bytes",
  "cap_tokens",
  "compress_output",
  "dedupe_consecutive",
  "dedupe_numeric_runs",
  "detect_from_command",
  "select_filter",
  "strip_ansi",
  "strip_progress",
  "truncate_middle",
  "PythonFilter",
  "GenericFilter",
  "PytestFilter",
  "JestFilter",
  "VitestFilter",
  "WebpackFilter",
  "DepListFilter",
  "CargoFilter",
  "NpmInstallFilter",
  "PlaywrightFilter",
  "CypressFilter",
  "TscFilter",
  "PnpmFilter",
  "YarnFilter",
  "BunFilter",
  "NodePackageFilter",
  "NodeFilter",
  "NxFilter",
  "LernaFilter",
  "TurboFilter",
  "DockerComposeFilter",
  "DockerFilter",
  "KubectlLogsFilter",
  "HelmFilter",
  "KubectlFilter",
  "AwsCliFilter",
  "AwsFilter",
  "GcloudFilter",
  "AzureCliFilter",
  "GitLogFilter",
  "GitDiffFilter",
  "GitStatusVerboseFilter",
  "GitBlameFilter",
  "GitCommitFilter",
  "GitPushFilter",
  "GitFilter",
  "GoTestFilter",
  "GoFilter",
  "GolangciLintFilter",
  "RuffFilter",
  "MypyFilter",
  "PylintFilter",
  "OxlintFilter",
  "ESLintFilter",
  "BiomeFilter",
  "LinterFilter",
  "GhCopilotFilter",
  "CopilotFilter",
  "GhRunLogFilter",
  "GhFilter",
  "ActFilter",
  "GenericCIFilter",
  "RgFilter",
  "GrepFilter",
  "GradleFilter",
  "MavenFilter",
  "JavacFilter",
  "AntFilter",
  "BazelFilter",
  "SbtFilter",
  "MakeFilter",
  "TerraformFilter",
  "PulumiFilter",
  "CdkFilter",
  "WasmPackFilter",
  "WranglerFilter",
  "HardhatFilter",
  "ServerlessFilter",
  "AnsibleFilter",
  "PreCommitFilter",
  "DotenvFilter",
  "FlutterFilter",
  "DartFilter",
  "PubFilter",
  "SwiftFilter",
  "XcodeFilter",
  "PipFilter",
  "GemFilter",
  "UvFilter",
  "CondaFilter",
  "CurlFilter",
  "RsyncFilter",
  "FfmpegFilter",
  "DotnetFilter",
  "MSBuildFilter",
  "NuGetFilter",
  "PowerShellFilter",
  "RubyFilter",
  "BundlerFilter",
  "MixFilter",
  "ComposerFilter",
  "PhpStanFilter",
  "SwiftLintFilter",
  "DenoFilter",
  "CmakeFilter",
  "MesonFilter",
  // ---- Run 9: CLI-utils (pre-PythonFilter; Python order Diff->Yq) ----
  "DiffFilter",
  "LsFilter",
  "EzaFilter",
  "FdFilter",
  "WcFilter",
  "TreeFilter",
  "BatFilter",
  "DeltaFilter",
  "FzfFilter",
  "LazyGitFilter",
  "JqFilter",
  "YqFilter",
  // ---- post-PythonFilter tail (EXACT Python registry order) ----
  "BanditFilter",
  "TrivyFilter",
  "SnykFilter",
  "SemgrepFilter",
  "PsqlFilter",
  "MySQLFilter",
  "Sqlite3Filter",
  "RedisCLIFilter",
  "BlackIsortFilter",
  "PrettierFilter",
  "SysPackageFilter",
  "ProtocFilter",
  "KtlintFilter",
  "ZigFilter",
  "SassFilter",
  "ElmFilter",
  "JuliaFilter",
  "ToxFilter",
  "NoxFilter",
  "CrystalFilter",
  "VaultFilter",
  "PackerFilter",
  "NixFilter",
  "HaskellFilter",
  "RCmdFilter",
  "ConanFilter",
  "VcpkgFilter",
  "CppcheckFilter",
  "ClangTidyFilter",
  "ErlangFilter",
  "FlyFilter",
  "ForgeFilter",
  "AiderFilter",
  "GeminiCliFilter",
  "ClaudeCliFilter",
  "CursorFilter",
  "WindsurfFilter",
  "OpenCodeFilter",
  "ContinueFilter",
  "ClineFilter",
  "CodexExecFilter",
  "NgFilter",
  "EnvFilter",
  "JsonArrayFilter",
  "BinaryInspectFilter",
  "FileTypeFilter",
  "PsFilter",
  "SeverityLogFilter",
  // ---- fallbacks ----
  "TailTruncFilter",
  // ---- post_bash standalone helpers (28 detectors/predicates/compressors) ----
  // Class-less module-level functions hooks_read.post_bash resolves by name via
  // _bcFn(...) on this barrel; plus the _VT_PASSED_LINE_RE regex (via _bcRe).
  "_dir_listing_cmd_type",
  "_sleep_cmd_type",
  "_watch_cmd_info",
  "_is_git_log_cmd",
  "_is_pkg_install_cmd",
  "_is_env_list_cmd",
  "_is_container_log_cmd",
  "_is_poll_loop_cmd",
  "_is_junit_xml_output",
  "_is_verbose_test_cmd",
  "_VT_PASSED_LINE_RE",
  "_is_cargo_compile_cmd",
  "_is_go_test_verbose_cmd",
  "_is_make_cmd",
  "_is_python_script_cmd",
  "_is_minified_file",
  "_has_minified_grep_hit",
  "_is_grep_cmd",
  "_is_jest_cmd",
  "_has_jest_output",
  "_has_vitest_output",
  "compress_jest_output",
  "_is_curl_verbose_cmd",
  "_has_curl_verbose_output",
  "compress_curl_verbose",
  "_is_docker_build_cmd",
  "_has_docker_build_output",
  "compress_docker_build",
] as const;
