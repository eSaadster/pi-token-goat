/**
 * User-facing CLI: the `token-goat` subcommand app.
 *
 * Port of src/token_goat/cli.py (8650 LOC, 92 commands). The architectural
 * keystone (commander app + CliRunner harness + main()) + the cheapest groups
 * land here; the ~70 heavy commands fan out as batches A–L (see PORT-PLAN).
 *
 * Framework: Python `typer` (on `click`) → TypeScript `commander`. The shared
 * output seam (`_echo`/`_error`/`_warn`/`_emit_json`/`CliExit`) lives in
 * cli_common.ts so read_commands.ts (the surgical-read command bodies) can emit
 * through it without an import cycle. The test CliRunner (tests/_cli_runner.ts)
 * captures output by spying `process.stdout`/`stderr.write`.
 *  - `typer.echo(msg, err=)` → `_echo`; `raise typer.Exit(code)` → `CliExit`.
 *  - `safe_run` is ASYNC, so dispatch is async (`parseAsync`); run/main async.
 *  - `no_args_is_help` → empty argv / groupless prints help, exits 0.
 *  - hook `context_settings={ignore_unknown_options, allow_extra_args}` →
 *    `.allowUnknownOption().allowExcessArguments()`.
 */
import { Command, CommanderError, Option } from "commander";

import { CliExit, _echo, _emit_json, _error, _warn } from "./cli_common.js";
import * as hookRegistry from "./hook_registry.js";
import * as hooksCli from "./hooks_cli.js";
import { getLogger } from "./util.js";
import { __version__ } from "./version.js";

import type { Project } from "./project.js";

const _LOG = getLogger("cli");

// Re-export the shared output seam so importers keep resolving these off `cli`
// (the seam itself now lives in cli_common.ts, shared with read_commands.ts).
export { CliExit, _echo, _error, _warn, _emit_json };

// ---------------------------------------------------------------------------
// Shared command helpers (used by the foundation + every later batch)
// ---------------------------------------------------------------------------

/** Return the current project or exit with code 1 (lazy-imports project). */
async function _require_project(
  msg = "no project detected — run from a project directory",
): Promise<Project> {
  const { find_project } = await import("./project.js");
  const proj = find_project(process.cwd());
  if (proj === null) {
    _error(msg);
    throw new CliExit(1);
  }
  return proj;
}

/** Validate a session id or exit with code 1 (lazy-imports session). */
async function _validate_session_id(session_id: string): Promise<void> {
  const session = await import("./session.js");
  try {
    session.validate_session_id(session_id);
  } catch (exc) {
    _error(`invalid session ID: ${exc instanceof Error ? exc.message : String(exc)}`);
    throw new CliExit(1);
  }
}

// Foundation keeps these referenced for the later batches that consume them.
void _warn;
void _emit_json;
void _require_project;
void _validate_session_id;

// ---------------------------------------------------------------------------
// Hook subapp (batch M) — thin delegators to the (already-ported) hooks_cli
// ---------------------------------------------------------------------------

const _VALID_HARNESSES: ReadonlySet<string> = new Set(["claude", "codex", "gemini"]);

/** Validate + narrow a raw CLI harness string; unknown → "claude" (safe default). */
function _parse_harness(raw: string): hooksCli.Harness {
  if (_VALID_HARNESSES.has(raw)) return raw as hooksCli.Harness;
  _LOG.debug("unknown harness %s; defaulting to 'claude'", raw);
  return "claude";
}

// Every hook subcommand shares this shape: --input-file + --harness, accept any
// unknown options/extra args, and delegate to safe_run (which always emits valid
// JSON and never throws). The CLI event name is the hyphenated form.
const _HOOK_EVENTS: readonly string[] = [
  "session-start",
  "pre-read",
  "pre-fetch",
  "post-edit",
  "post-read",
  "post-bash",
  "post-fetch",
  "pre-compact",
  "user-prompt-submit",
  "subagent-stop",
  "pre-skill",
  "post-skill",
  "pre-screenshot",
];

function _buildHookApp(): Command {
  const hookApp = new Command("hook");
  hookApp.description("Hook event dispatchers (internal).");
  // no_args_is_help: `token-goat hook` with no event prints the hook help.
  hookApp.action(() => {
    hookApp.outputHelp();
    throw new CliExit(0);
  });
  for (const event of _HOOK_EVENTS) {
    hookApp
      .command(event)
      .description(`Hook: ${event} event.`)
      .allowUnknownOption(true)
      .allowExcessArguments(true)
      .option("--input-file <path>", "Path to a JSON payload file (else stdin).")
      .option("--harness <harness>", "Hook harness: claude, codex, or gemini.", "claude")
      .action(async (opts: { inputFile?: string; harness?: string }) => {
        await hooksCli.safe_run(event, opts.inputFile, _parse_harness(opts.harness ?? "claude"));
      });
  }
  return hookApp;
}

/** Verify every registry event has a matching hook subcommand (import-time drift guard). */
function _assert_hook_registry_aligned(hookApp: Command): void {
  const registered = new Set<string>();
  for (const cmd of hookApp.commands) registered.add(cmd.name());
  hookRegistry.assert_typer_subcommands_aligned(registered);
}

// ---------------------------------------------------------------------------
// Batch A — surgical reads (thin wrappers over read_commands)
// ---------------------------------------------------------------------------

// Lazy + memoized read_commands import (matches the Python `from . import
// read_commands` deferred-import: keeps the hook-only path from loading
// db/hints/read_replacement/session).
let _rcMod: typeof import("./read_commands.js") | null = null;
async function _readCommands(): Promise<typeof import("./read_commands.js")> {
  return (_rcMod ??= await import("./read_commands.js"));
}

// Lazy + memoized cli_lookup import (batch-A part 2: symbol/ref/refs/semantic —
// these carry inline logic in cli.py rather than delegating to read_commands).
let _lookupMod: typeof import("./cli_lookup.js") | null = null;
async function _cliLookup(): Promise<typeof import("./cli_lookup.js")> {
  return (_lookupMod ??= await import("./cli_lookup.js"));
}

// Lazy + memoized cli_config import (batch L — the `config *` subapp). Kept
// lazy so the hook-only path (which never touches config) does not load
// smol-toml / difflib transitively.
let _cfgMod: typeof import("./cli_config.js") | null = null;
async function _cliConfig(): Promise<typeof import("./cli_config.js")> {
  return (_cfgMod ??= await import("./cli_config.js"));
}

// Lazy + memoized cli_map import (batch B — the `map` command). Kept lazy so
// the hook-only path does not load repomap/compact/session/skill_cache.
let _mapMod: typeof import("./cli_map.js") | null = null;
async function _cliMap(): Promise<typeof import("./cli_map.js")> {
  return (_mapMod ??= await import("./cli_map.js"));
}

// Lazy + memoized cli_sessions import (batch C1 — the 10 session/compaction
// commands). Kept lazy so the hook-only path does not load session/compact/
// resume/hooks_session/stats/db transitively.
let _sessionsMod: typeof import("./cli_sessions.js") | null = null;
async function _cliSessions(): Promise<typeof import("./cli_sessions.js")> {
  return (_sessionsMod ??= await import("./cli_sessions.js"));
}

// Lazy + memoized cli_skills import (batch D — skills + doc-compact, 8 cmds).
let _skillsMod: typeof import("./cli_skills.js") | null = null;
async function _cliSkills(): Promise<typeof import("./cli_skills.js")> {
  return (_skillsMod ??= await import("./cli_skills.js"));
}

// Lazy + memoized cli_gdrive import (batch E — gdrive, 4 cmds).
let _gdriveMod: typeof import("./cli_gdrive.js") | null = null;
async function _cliGdrive(): Promise<typeof import("./cli_gdrive.js")> {
  return (_gdriveMod ??= await import("./cli_gdrive.js"));
}

// Lazy + memoized cli_image import (batch G — fetch-image/image-shrink/caption-instead;
// `compress` deferred — needs the not-yet-ported bash_runner).
let _imageMod: typeof import("./cli_image.js") | null = null;
async function _cliImage(): Promise<typeof import("./cli_image.js")> {
  return (_imageMod ??= await import("./cli_image.js"));
}

// Lazy + memoized cli_clean import (batch J — clean-cache/prune-cache/clean).
let _cleanMod: typeof import("./cli_clean.js") | null = null;
async function _cliClean(): Promise<typeof import("./cli_clean.js")> {
  return (_cleanMod ??= await import("./cli_clean.js"));
}

// Lazy + memoized cli_history import (batch F — bash/web/mcp output+history + history).
let _historyMod: typeof import("./cli_history.js") | null = null;
async function _cliHistory(): Promise<typeof import("./cli_history.js")> {
  return (_historyMod ??= await import("./cli_history.js"));
}

// Lazy + memoized cli_index import (batch H — memory/git-history/export/index).
let _indexMod: typeof import("./cli_index.js") | null = null;
async function _cliIndex(): Promise<typeof import("./cli_index.js")> {
  return (_indexMod ??= await import("./cli_index.js"));
}

// Lazy + memoized cli_lifecycle import (batch I — install/uninstall/worker/context-stats).
let _lifecycleMod: typeof import("./cli_lifecycle.js") | null = null;
async function _cliLifecycle(): Promise<typeof import("./cli_lifecycle.js")> {
  return (_lifecycleMod ??= await import("./cli_lifecycle.js"));
}

// Lazy + memoized cli_doctor import (batch I — doctor).
let _doctorMod: typeof import("./cli_doctor.js") | null = null;
async function _cliDoctor(): Promise<typeof import("./cli_doctor.js")> {
  return (_doctorMod ??= await import("./cli_doctor.js"));
}

// Lazy + memoized cli_stats import (batch K — stats/cost/diff).
let _statsMod: typeof import("./cli_stats.js") | null = null;
async function _cliStats(): Promise<typeof import("./cli_stats.js")> {
  return (_statsMod ??= await import("./cli_stats.js"));
}

// Lazy + memoized cli_compress import (compress — wraps bash_runner).
let _compressMod: typeof import("./cli_compress.js") | null = null;
async function _cliCompress(): Promise<typeof import("./cli_compress.js")> {
  return (_compressMod ??= await import("./cli_compress.js"));
}

/** commander float option parser (option values arrive as strings). */
function _float(v: string): number {
  return parseFloat(v);
}

/** commander int option parser (option values arrive as strings). */
function _int(v: string): number {
  return parseInt(v, 10);
}

/**
 * Register the surgical-read command group (batch A). These delegate to
 * read_commands, which emits output through the shared cli_common seam.
 *
 * Deferred to batch-A part 2 (they carry cli.py-side logic, not pure
 * delegation): `symbol`, `ref`, `refs` (its non-`::` path queries db directly),
 * and `semantic` (embeddings + keyword fallback).
 */
function _registerSurgicalReads(app: Command): void {
  app
    .command("deps")
    .description("Show the dependency graph (imports and references) for a file.")
    .argument("<file>", "File to inspect.")
    .option("--json", "Output structured JSON instead of human-readable text.")
    .option("-d, --depth <n>", "Transitive depth (1=direct, 0=unlimited).", _int, 1)
    .action(async (file: string, opts: { json?: boolean; depth?: number }) => {
      const rc = await _readCommands();
      rc.deps(file, { json_output: Boolean(opts.json), depth: opts.depth ?? 1 });
    });

  app
    .command("read")
    .description("Read just <symbol> from <file>, not the whole file.")
    .argument("<target>", "<file>::<symbol>")
    .option("-s, --session-id <id>", "Session id.")
    .option("--json", "Output structured JSON instead of human-readable text.")
    .option("-c, --context <n>", "Extra lines before/after.", _int, 0)
    .option("-f, --full", "Return the complete symbol body without smart truncation.")
    .action(
      async (
        target: string,
        opts: { sessionId?: string; json?: boolean; context?: number; full?: boolean },
      ) => {
        if (opts.sessionId) await _validate_session_id(opts.sessionId);
        const rc = await _readCommands();
        rc.read(target, {
          session_id: opts.sessionId ?? null,
          json_output: Boolean(opts.json),
          context_lines: opts.context ?? 0,
          full: Boolean(opts.full),
        });
      },
    );

  app
    .command("section")
    .description("Extract just <heading> section from <file>, not the whole file.")
    .argument("<target>", "<file>::<heading> (append #N to disambiguate).")
    .option("-s, --session-id <id>", "Session id.")
    .option("--json", "Output structured JSON instead of human-readable text.")
    .option("-c, --context <n>", "Extra lines before/after.", _int, 0)
    .action(
      async (target: string, opts: { sessionId?: string; json?: boolean; context?: number }) => {
        if (opts.sessionId) await _validate_session_id(opts.sessionId);
        const rc = await _readCommands();
        rc.section(target, {
          session_id: opts.sessionId ?? null,
          json_output: Boolean(opts.json),
          context_lines: opts.context ?? 0,
        });
      },
    );

  app
    .command("skill-section")
    .description("Extract a named section from an installed skill file.")
    .argument("<skill_name>", "Skill name (e.g. 'ralph', 'plugin:improve').")
    .argument("<heading>", "Section heading to extract (case-insensitive prefix match).")
    .option("-s, --session-id <id>", "Session id.")
    .option("--json", "Output structured JSON instead of human-readable text.")
    .option("-c, --context <n>", "Extra lines before/after.", _int, 0)
    .action(
      async (
        skill_name: string,
        heading: string,
        opts: { sessionId?: string; json?: boolean; context?: number },
      ) => {
        if (opts.sessionId) await _validate_session_id(opts.sessionId);
        const rc = await _readCommands();
        rc.skill_section(skill_name, heading, {
          session_id: opts.sessionId ?? null,
          json_output: Boolean(opts.json),
          context_lines: opts.context ?? 0,
        });
      },
    );

  app
    .command("skeleton")
    .description("Show all signatures in <file> without bodies.")
    .argument("<file>", "File to show signatures for.")
    .option("--json", "Output structured JSON instead of human-readable text.")
    .option("-p, --private", "Include _private names.")
    .action(async (file: string, opts: { json?: boolean; private?: boolean }) => {
      const rc = await _readCommands();
      rc.stub_view(file, { json_output: Boolean(opts.json), include_private: Boolean(opts.private) });
    });

  app
    .command("outline")
    .description("List symbols in <file> with line ranges, line counts, and docstring hints.")
    .argument("<file>", "File to outline.")
    .option("--json", "Output structured JSON instead of human-readable text.")
    .option("-d, --max-depth <n>", "Maximum nesting depth to include (0 = top-level only).", _int, 0)
    .option("-q, --quiet", "Suppress the '# Outline:' header line.")
    .option("--min-lines <n>", "Only show symbols whose body spans at least N lines.", _int, 0)
    .action(
      async (
        file: string,
        opts: { json?: boolean; maxDepth?: number; quiet?: boolean; minLines?: number },
      ) => {
        const rc = await _readCommands();
        rc.outline(file, {
          json_output: Boolean(opts.json),
          max_depth: opts.maxDepth ?? 0,
          quiet: Boolean(opts.quiet),
          min_lines: opts.minLines ?? 0,
        });
      },
    );

  app
    .command("exports")
    .description("List public (exported) symbols from <file> with types and docstring hints.")
    .argument("<file>", "File to inspect.")
    .option("--json", "Output structured JSON instead of human-readable text.")
    .action(async (file: string, opts: { json?: boolean }) => {
      const rc = await _readCommands();
      rc.exports(file, { json_output: Boolean(opts.json) });
    });

  app
    .command("scope")
    .description("Show symbols in scope at <file>:<line>.")
    .argument("<target>", "<file>:<line>")
    .option("--json", "Output structured JSON instead of human-readable text.")
    .action(async (target: string, opts: { json?: boolean }) => {
      const rc = await _readCommands();
      rc.scope(target, { json_output: Boolean(opts.json) });
    });

  app
    .command("changed")
    .description("List symbols that changed since a git ref.")
    .option("--since <ref>", "Git ref to compare against.", "HEAD~5")
    .option("--json", "Output structured JSON instead of human-readable text.")
    .option("-q, --quiet", "Suppress count/summary lines.")
    .option("--limit <n>", "Maximum number of symbol entries to return.", _int, 50)
    .option("--symbol", "Use the DB index to find symbols overlapping changed line ranges.")
    .action(
      async (opts: {
        since?: string;
        json?: boolean;
        quiet?: boolean;
        limit?: number;
        symbol?: boolean;
      }) => {
        const rc = await _readCommands();
        rc.changed({
          since_ref: opts.since ?? "HEAD~5",
          json_output: Boolean(opts.json),
          limit: opts.limit ?? 50,
          symbol_mode: Boolean(opts.symbol),
          quiet: Boolean(opts.quiet),
        });
      },
    );

  app
    .command("blame")
    .description("Show git blame for the lines of a specific symbol.")
    .argument("<target>", "<file>::<symbol>")
    .option("--json", "Output structured JSON instead of human-readable text.")
    .action(async (target: string, opts: { json?: boolean }) => {
      const rc = await _readCommands();
      rc.blame(target, { json_output: Boolean(opts.json) });
    });

  app
    .command("recent")
    .description("Show the N most recently edited/accessed files with their symbols.")
    .option("--n <n>", "Number of files to show.", _int, 10)
    .option("-s, --session-id <id>", "Session id.")
    .option("--json", "Output structured JSON instead of human-readable text.")
    .action(async (opts: { n?: number; sessionId?: string; json?: boolean }) => {
      const rc = await _readCommands();
      rc.recent({
        n: opts.n ?? 10,
        session_id: opts.sessionId ?? null,
        json_output: Boolean(opts.json),
      });
    });

  app
    .command("find")
    .description("Unified search: symbol (exact/fuzzy) + semantic, merged and ranked.")
    .argument("<query>", "Search term — name, keyword, or natural-language phrase.")
    .option("--json", "Output structured JSON instead of human-readable text.")
    .action(async (query: string, opts: { json?: boolean }) => {
      const rc = await _readCommands();
      rc.find(query, { json_output: Boolean(opts.json) });
    });

  app
    .command("similar")
    .description("Find the top-k symbols most semantically similar to <file>::<symbol>.")
    .argument("<target>", "Symbol to compare — 'file::symbol'.")
    .option("-k <n>", "Number of similar symbols to return.", _int, 5)
    .option("--json", "Output structured JSON instead of human-readable text.")
    .action(async (target: string, opts: { k?: number; json?: boolean }) => {
      const rc = await _readCommands();
      rc.similar(target, { json_output: Boolean(opts.json), top_k: opts.k ?? 5 });
    });

  app
    .command("test-for")
    .description("Find test file(s) for an implementation file and list their test functions.")
    .argument("<file>", "Implementation file.")
    .option("--json", "Output structured JSON instead of human-readable text.")
    .action(async (file: string, opts: { json?: boolean }) => {
      const rc = await _readCommands();
      rc.test_for(file, { json_output: Boolean(opts.json) });
    });

  app
    .command("types")
    .description("List type definitions in a file or project.")
    .argument("[file]", "File to inspect (omit for project-wide search).")
    .option("--json", "Output structured JSON instead of human-readable text.")
    .action(async (file: string | undefined, opts: { json?: boolean }) => {
      const rc = await _readCommands();
      rc.types(file ?? null, { json_output: Boolean(opts.json) });
    });

  app
    .command("imports")
    .description("Show the import graph for <file> one level deep.")
    .argument("<file>", "File to inspect.")
    .option("--json", "Output structured JSON instead of human-readable text.")
    .action(async (file: string, opts: { json?: boolean }) => {
      const rc = await _readCommands();
      rc.imports(file, { json_output: Boolean(opts.json) });
    });

  app
    .command("grep")
    .description("Session-aware grep: run rg and cache results within the session.")
    .argument("<pattern>", "Regex pattern to search for (forwarded to rg).")
    .argument("[path]", "Directory or file to search.", ".")
    .option("-s, --session-id <id>", "Session id.")
    .option("--json", "Output structured JSON instead of human-readable text.")
    .action(
      async (
        pattern: string,
        path: string,
        opts: { sessionId?: string; json?: boolean },
      ) => {
        const rc = await _readCommands();
        rc.grep(pattern, {
          path,
          session_id: opts.sessionId ?? null,
          json_output: Boolean(opts.json),
        });
      },
    );

  // -------------------------------------------------------------------
  // Batch A part 2 — symbol / ref / refs / semantic (carry inline logic;
  // delegate to cli_lookup.ts). Registered here so they share the group.
  // -------------------------------------------------------------------

  app
    .command("symbol")
    .description("Find a symbol definition by name (function, class, method, type, constant, etc.).")
    .argument("<name>", "Symbol name to find (supports glob: get_*).")
    .argument("[file]", "Optional file path to scope the search (partial, case-insensitive).")
    .option("--all-projects", "Search across all indexed projects.")
    .option("--json", "Output structured JSON instead of human-readable text.")
    .option("--limit <n>", "Maximum number of results.", _int, 50)
    .option("--strict", "Disable close-match auto-redirect on a miss.")
    .option("--refs", "Annotate each result with its reference count: [N refs].")
    .option(
      "-t, --type <kind>",
      "Filter by symbol kind (fn, class, method, const, ...). Repeatable.",
      (v: string, acc: string[]) => [...acc, v],
      [] as string[],
    )
    .option("-f, --full", "Accepted but has no effect on the search itself.")
    .option("-q, --quiet", "Suppress non-essential output (count lines, hints).")
    .option("-C, --context <n>", "Show N lines before and after each symbol's definition.", _int, 0)
    .action(
      async (
        name: string,
        file: string | undefined,
        opts: {
          allProjects?: boolean;
          json?: boolean;
          limit?: number;
          strict?: boolean;
          refs?: boolean;
          type?: string[];
          full?: boolean;
          quiet?: boolean;
          context?: number;
        },
      ) => {
        const lk = await _cliLookup();
        await lk.symbol(name, {
          all_projects: Boolean(opts.allProjects),
          as_json: Boolean(opts.json),
          limit: opts.limit ?? 50,
          strict: Boolean(opts.strict),
          show_refs: Boolean(opts.refs),
          filter_types: opts.type ?? [],
          full: Boolean(opts.full),
          quiet: Boolean(opts.quiet),
          context_lines: opts.context ?? 0,
          file: file ?? null,
        });
      },
    );

  app
    .command("ref")
    .description("Find all code references to a symbol by name.")
    .argument("<name>", "Symbol name.")
    .option("--json", "Output structured JSON instead of human-readable text.")
    .option("--limit <n>", "Cap results.", _int, 100)
    .action(async (name: string, opts: { json?: boolean; limit?: number }) => {
      const lk = await _cliLookup();
      await lk.ref(name, { as_json: Boolean(opts.json), limit: opts.limit ?? 100 });
    });

  app
    .command("refs")
    .description("Show all files and line numbers where a symbol is referenced.")
    .argument("<symbol>", "Symbol name, or <file>::<symbol> for targeted refs.")
    .option("-f, --file <path>", "Only show refs in this file (partial path match).")
    .option("-n, --limit <n>", "Cap results.", _int, 50)
    .option("--json", "Output structured JSON instead of human-readable text.")
    .option("-q, --quiet", "Suppress count/summary lines.")
    .option("--callers", "Resolve enclosing function/method (requires <file>::<symbol>).")
    .action(
      async (
        symbol: string,
        opts: {
          file?: string;
          limit?: number;
          json?: boolean;
          quiet?: boolean;
          callers?: boolean;
        },
      ) => {
        const lk = await _cliLookup();
        await lk.refs(symbol, {
          file: opts.file ?? null,
          limit: opts.limit ?? 50,
          as_json: Boolean(opts.json),
          quiet: Boolean(opts.quiet),
          show_callers: Boolean(opts.callers),
        });
      },
    );

  app
    .command("semantic")
    .description("Semantic search using local embeddings (fastembed + sqlite-vec).")
    .argument("<query>", "Natural-language search query.")
    .option("-k <n>", "Top-k results.", _int, 8)
    .option("--json", "Output structured JSON instead of human-readable text.")
    .option(
      "--max-distance <d>",
      "Effective-distance threshold (negative = library default; large = disable).",
      _float,
      -1.0,
    )
    .option("--no-rerank", "Disable verbatim-token boost and generated-path demotion.")
    .option("--full", "Verbose two-line output with kind and distance.")
    .option("--all-projects", "Search across all indexed projects.")
    .action(
      async (
        query: string,
        opts: {
          k?: number;
          json?: boolean;
          maxDistance?: number;
          noRerank?: boolean;
          full?: boolean;
          allProjects?: boolean;
        },
      ) => {
        const lk = await _cliLookup();
        await lk.semantic(query, {
          k: opts.k ?? 8,
          json_output: Boolean(opts.json),
          max_distance: opts.maxDistance ?? -1.0,
          no_rerank: opts.noRerank ?? false,
          // --compact/--full: Python default compact=true; --full sets compact=false.
          // commander exposes --no-X for a boolean defaulting true, but we model
          // --full as the negation here to match Python's "--compact/--full" pair.
          compact: !(opts.full ?? false),
          all_projects: Boolean(opts.allProjects),
        });
      },
    );
}

// ---------------------------------------------------------------------------
// App construction
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Batch C1 — session/compaction commands (thin delegators over cli_sessions)
// ---------------------------------------------------------------------------

/**
 * Register the 10 session/compaction commands (batch C1). Each delegates to
 * the corresponding cli_sessions.ts impl, which emits through the shared
 * cli_common seam. Panels match Python's `rich_help_panel`:
 *  - Core:     decision, pinned, resume, recovery, sessions, sessions-show
 *  - Advanced: cache-audit, session-touched, session-summary
 *  - hidden:   session-mark
 *
 * `compact-hint` is deferred to batch C2 (~768 LOC + a --watch poll loop).
 *
 * NOTE: commander does not have rich-style panels, so the panel grouping is
 * informational here (every command is a flat top-level subcommand, matching
 * how typer flattens panels at parse time). `session-mark` is registered with
 * `.hidden(true)` to preserve the `hidden=True` Python flag.
 */
function _registerSessionCommands(app: Command): void {
  // ---- Advanced panel ------------------------------------------------------

  app
    .command("cache-audit")
    .description("Audit Claude Code config for patterns that bust the prompt cache.")
    .action(async () => {
      const s = await _cliSessions();
      await s.cache_audit();
    });

  app
    .command("session-touched")
    .description("List files already read in the given Claude session.")
    .requiredOption("-s, --session-id <id>", "Claude session_id.")
    .option("--json", "Output structured JSON instead of human-readable text.")
    .action(async (opts: { sessionId?: string; json?: boolean }) => {
      const s = await _cliSessions();
      s.session_touched({
        session_id: opts.sessionId ?? "",
        json_output: Boolean(opts.json),
      });
    });

  app
    .command("session-summary")
    .description(
      "Compact one-liner about current session state for orchestrators.",
    )
    .option("-s, --session-id <id>", "Session id (defaults to detected current session).")
    .option("--json", "Output structured JSON instead of human-readable text.")
    .action(async (opts: { sessionId?: string; json?: boolean }) => {
      const s = await _cliSessions();
      await s.session_summary({
        session_id: opts.sessionId ?? null,
        json_output: Boolean(opts.json),
      });
    });

  // ---- hidden --------------------------------------------------------------

  app
    .command("session-mark", "", { hidden: true })
    .description(
      "Manually mark a file/range as read for the given session. (Mostly used by hooks.)",
    )
    .argument("<file>", "File path to mark as read.")
    .requiredOption("-s, --session-id <id>", "Session id.")
    .option("--offset <n>", "Byte/line offset (0 = none).", _int, 0)
    .option("--limit <n>", "Line limit (0 = unlimited).", _int, 0)
    .action(
      async (
        file: string,
        opts: { sessionId?: string; offset?: number; limit?: number },
      ) => {
        const s = await _cliSessions();
        s.session_mark({
          file_path: file,
          session_id: opts.sessionId ?? "",
          offset: opts.offset ?? 0,
          limit: opts.limit ?? 0,
        });
      },
    );

  // ---- Core panel ----------------------------------------------------------

  app
    .command("decision")
    .description("Record or list opt-in decisions for the current session.")
    .argument("[text]", "Decision text (empty with --list to inspect the log).")
    .option("-s, --session-id <id>", "Session to record against (defaults to most-recent).")
    .option("-t, --tag <tag>", "Optional short label ('rationale', 'ruled-out', 'invariant').")
    .option("--list", "List recent decisions instead of appending one.")
    .option("--limit <n>", "When --list, max entries to display (newest last).", _int, 10)
    .action(
      async (
        text: string | undefined,
        opts: {
          sessionId?: string;
          tag?: string;
          list?: boolean;
          limit?: number;
        },
      ) => {
        const s = await _cliSessions();
        s.decision({
          text: text ?? "",
          session_id: opts.sessionId ?? "",
          tag: opts.tag ?? "",
          list_log: Boolean(opts.list),
          limit: opts.limit ?? 10,
        });
      },
    );

  app
    .command("pinned")
    .description("Manage pinned symbols for the current session.")
    .argument("<action>", "Sub-command: 'add', 'remove', or 'list'.")
    .argument("[spec]", "Symbol spec in '<file>::<symbol>' format (required for add/remove).")
    .option("-s, --session-id <id>", "Session to operate against (defaults to most-recent).")
    .action(
      async (
        action: string,
        spec: string | undefined,
        opts: { sessionId?: string },
      ) => {
        const s = await _cliSessions();
        s.pinned({
          action,
          spec: spec ?? "",
          session_id: opts.sessionId ?? "",
        });
      },
    );

  app
    .command("resume")
    .description("Emit a single-command post-compact restoration packet.")
    .argument("<session_id>", "Session ID (full or 8-char short form) to restore context from.")
    .action(async (session_id: string) => {
      const s = await _cliSessions();
      s.resume_cmd(session_id);
    });

  app
    .command("recovery")
    .description("Inspect the post-compact recovery hint for a session.")
    .argument("<session_id>", "Session ID (full or 8-char short form) to inspect.")
    .option("--pending", "Read the deferred recovery sidecar if present.")
    .action(async (session_id: string, opts: { pending?: boolean }) => {
      const s = await _cliSessions();
      s.recovery(session_id, { pending: Boolean(opts.pending) });
    });

  app
    .command("sessions")
    .description("List recent sessions with per-session stats.")
    .option("-n, --limit <n>", "Maximum sessions to show (newest first).", _int, 20)
    .option("--project <path>", "Filter to sessions for this project root path.")
    .option("--json", "Output structured JSON instead of human-readable text.")
    .action(
      async (opts: { limit?: number; project?: string; json?: boolean }) => {
        const s = await _cliSessions();
        s.sessions({
          limit: opts.limit ?? 20,
          project: opts.project ?? null,
          json_output: Boolean(opts.json),
        });
      },
    );

  app
    .command("sessions-show")
    .description("Show full details for one session: edited files, bash history, and web history.")
    .argument("<session_id>", "Session ID to inspect (prefix match accepted).")
    .option("--json", "Output structured JSON instead of human-readable text.")
    .action(async (session_id: string, opts: { json?: boolean }) => {
      const s = await _cliSessions();
      s.sessions_show(session_id, { json_output: Boolean(opts.json) });
    });

  // ---- batch C2 — compact-hint (Advanced panel) ----------------------------
  // The 11th C1 command, carved out for its ~768-LOC body + --watch poll loop.
  // `--watch-interval` mirrors Python's `hidden=True` via Option.hideHelp().
  app
    .command("compact-hint")
    .description("Show the compaction manifest token-goat would inject for a session.")
    .option(
      "-s, --session-id <id>",
      "Claude session_id to inspect.  Pass 'auto' (or omit and use --auto) to auto-detect.",
      "",
    )
    .option("--auto", "Auto-detect the most-recently-modified session and use it.")
    .option("--json", "Output structured JSON instead of human-readable text.")
    .option(
      "--max-tokens <n>",
      "Override token budget for the manifest (0 = use config.max_manifest_tokens).",
      _int,
      0,
    )
    .option(
      "--trigger <trigger>",
      "Simulate the PreCompact trigger that fired the hook ('manual' or 'auto').",
      "manual",
    )
    .option(
      "--explain-skip",
      "Show a detailed breakdown of why the compact-skip sentinel fired (or didn't).",
    )
    .option(
      "--diff",
      "Show a unified diff between the manifest emitted NOW and the last emit.",
    )
    .option(
      "--sections",
      "List just the section names + estimated token counts (no full text).",
    )
    .option(
      "--score",
      "Print the manifest quality score with a per-section breakdown.",
    )
    .option(
      "-w, --watch",
      "Poll continuously: regenerate the manifest every 60s and show a +/- diff.",
    )
    .addOption(
      new Option(
        "--watch-interval <n>",
        "Seconds between watch cycles (default: 60).",
      )
        .argParser(_int)
        .default(60)
        .hideHelp(),
    )
    .action(
      async (opts: {
        sessionId?: string;
        auto?: boolean;
        json?: boolean;
        maxTokens?: number;
        trigger?: string;
        explainSkip?: boolean;
        diff?: boolean;
        sections?: boolean;
        score?: boolean;
        watch?: boolean;
        watchInterval?: number;
      }) => {
        const s = await _cliSessions();
        await s.compact_hint({
          session_id: opts.sessionId ?? "",
          auto: Boolean(opts.auto),
          json_output: Boolean(opts.json),
          max_tokens: opts.maxTokens ?? 0,
          trigger: opts.trigger ?? "manual",
          explain_skip: Boolean(opts.explainSkip),
          show_diff: Boolean(opts.diff),
          show_sections: Boolean(opts.sections),
          show_score: Boolean(opts.score),
          watch: Boolean(opts.watch),
          watch_interval: opts.watchInterval ?? 60,
        });
      },
    );
}

// ---------------------------------------------------------------------------
// Batch D — skills + doc-compact commands (thin delegators over cli_skills)
// ---------------------------------------------------------------------------

/**
 * Register the 8 skill/doc-compact commands (batch D), all on the Core panel:
 * skill-body, skill-compact, compact-doc, skill-history, skill-diff,
 * skill-size, baseline, skill-list. Each delegates to cli_skills.ts.
 */
function _registerSkillCommands(app: Command): void {
  app
    .command("skill-body")
    .description("Retrieve a sliced view of a cached Skill body.")
    .argument("<name>", "Skill name (e.g. 'ralph', 'plugin:improve').")
    .option("--head <n>", "Show first N lines (0 = no head limit).", _int, 0)
    .option("--tail <n>", "Show last N lines (0 = no tail limit).", _int, 0)
    .option("-g, --grep <pattern>", "Show only lines matching a regex pattern (case-insensitive; literal fallback).")
    .option("--full", "Return the entire cached body (disables smart-default head+tail).")
    .option("--json", "Output structured JSON instead of human-readable text.")
    .option("--section <name>", "Extract only the named H2/H3/H4 section (case-insensitive prefix match).")
    .option("--compact", "Return a compact summary (~400 tokens) instead of the full body.")
    .action(
      async (
        name: string,
        opts: {
          head?: number;
          tail?: number;
          grep?: string;
          full?: boolean;
          json?: boolean;
          section?: string;
          compact?: boolean;
        },
      ) => {
        const s = await _cliSkills();
        s.skill_body({
          name,
          head: opts.head ?? 0,
          tail: opts.tail ?? 0,
          grep: opts.grep ?? null,
          full: Boolean(opts.full),
          json_output: Boolean(opts.json),
          section: opts.section ?? null,
          compact: Boolean(opts.compact),
        });
      },
    );

  app
    .command("skill-compact")
    .description("Generate and print a compact summary (~400 tokens) for a cached skill body.")
    .argument("[name]", "Skill name. Omit with --all to process every cached skill.")
    .option("--json", "Output structured JSON instead of human-readable text.")
    .option("--all", "Regenerate compacts for every cached skill whose compact is stale or absent.")
    .action(async (name: string | undefined, opts: { json?: boolean; all?: boolean }) => {
      const s = await _cliSkills();
      s.skill_compact({
        name: name ?? null,
        json_output: Boolean(opts.json),
        all_skills: Boolean(opts.all),
      });
    });

  app
    .command("compact-doc")
    .description("Create an extractive compact sidecar for a large reference document.")
    .argument("<path>", "Path to the reference document to compact (.md / .markdown).")
    .option("-f, --force", "Overwrite an existing compact even if it is already fresh.")
    .option("-s, --sentences <n>", "Content lines to extract per section heading (default 2).", _int, 2)
    .option("--show", "Print the compact body to stdout after writing.")
    .action(
      async (
        pathArg: string,
        opts: { force?: boolean; sentences?: number; show?: boolean },
      ) => {
        const s = await _cliSkills();
        s.compact_doc({
          path: pathArg,
          force: Boolean(opts.force),
          sentences: opts.sentences ?? 2,
          show: Boolean(opts.show),
        });
      },
    );

  app
    .command("skill-history")
    .description("List cached Skill bodies, newest first.")
    .option("--json", "Output structured JSON instead of human-readable text.")
    .option("-n, --limit <n>", "Maximum entries to show (newest first).", _int, 20)
    .action(async (opts: { json?: boolean; limit?: number }) => {
      const s = await _cliSkills();
      s.skill_history({ json_output: Boolean(opts.json), limit: opts.limit ?? 20 });
    });

  app
    .command("skill-diff")
    .description("Show a unified diff between the two most recent cached versions of a Skill.")
    .argument("<name>", "Skill name to diff (e.g. 'ralph', 'plugin:improve').")
    .action(async (name: string) => {
      const s = await _cliSkills();
      s.skill_diff({ name });
    });

  app
    .command("skill-size")
    .description("Show size and estimated per-session overhead for all cached skills.")
    .option("-s, --session-id <id>", "Filter to this session (default: all sessions).")
    .option("--json", "Output structured JSON instead of human-readable text.")
    .action(async (opts: { sessionId?: string; json?: boolean }) => {
      const s = await _cliSkills();
      s.skill_size({ session_id: opts.sessionId ?? null, json_output: Boolean(opts.json) });
    });

  app
    .command("baseline")
    .description("Attribute the session's environmental context baseline (the \"expense report\").")
    .option("-s, --session-id <id>", "Session id (default: detected / most-recent).")
    .option("--json", "Output structured JSON instead of human-readable text.")
    .option("--subagent", "Show only the fixed sources a freshly spawned subagent inherits.")
    // Default 200000 == baseline.DEFAULT_WINDOW_TOKENS (the model window).
    .option("--window <n>", "Context-window size (tokens) used as the pct-of-window denominator.", _int, 200000)
    .option("--usage", "Annotate rows with historical call counts; flag zero-use removal candidates.")
    .action(
      async (opts: {
        sessionId?: string;
        json?: boolean;
        subagent?: boolean;
        window?: number;
        usage?: boolean;
      }) => {
        const s = await _cliSkills();
        s.baseline({
          session_id: opts.sessionId ?? null,
          json_output: Boolean(opts.json),
          subagent: Boolean(opts.subagent),
          window: opts.window ?? 200000,
          usage: Boolean(opts.usage),
        });
      },
    );

  app
    .command("skill-list")
    .description("List skills cached in the current (or specified) session.")
    .option("-s, --session-id <id>", "Session to inspect (default: most-recently active).")
    .option("--json", "Output structured JSON instead of human-readable text.")
    .action(async (opts: { sessionId?: string; json?: boolean }) => {
      const s = await _cliSkills();
      s.skill_list({ session_id: opts.sessionId ?? null, json_output: Boolean(opts.json) });
    });
}

// ---------------------------------------------------------------------------
// Batch E — gdrive commands (thin delegators over cli_gdrive)
// ---------------------------------------------------------------------------

/**
 * Register the 4 gdrive commands (batch E). Panels match Python's
 * `rich_help_panel` (commander has no panels — the grouping is informational,
 * every command is a flat top-level subcommand):
 *  - Core:   gdrive-sections, gdrive-list
 *  - hidden: gdrive-fetch, gdrive-auth
 * `gdrive-fetch` / `gdrive-auth` are registered with `{ hidden: true }` to
 * preserve the Python `hidden=True` flag (mirrors `session-mark`).
 */
function _registerGdriveCommands(app: Command): void {
  app
    .command("gdrive-fetch", "", { hidden: true })
    .description("Fetch a Google Drive file (image gets auto-shrunk). Returns the local path.")
    .argument("<file_id>", "Drive file ID.")
    .option("--json", "Output structured JSON instead of human-readable text.")
    .action(async (fileId: string, opts: { json?: boolean }) => {
      const g = await _cliGdrive();
      await g.gdrive_fetch({ file_id: fileId, json_output: Boolean(opts.json) });
    });

  app
    .command("gdrive-sections")
    .description(
      "Download a Drive doc and emit its section index (heading structure), not the body.",
    )
    .argument("<file_id>", "Drive file ID.")
    .option("--json", "Output structured JSON instead of human-readable text.")
    .option(
      "--max-sections <n>",
      "Maximum number of sections to list (rest are summarised). Keeps the hint compact.",
      _int,
      80,
    )
    .action(async (fileId: string, opts: { json?: boolean; maxSections?: number }) => {
      const g = await _cliGdrive();
      await g.gdrive_sections({
        file_id: fileId,
        json_output: Boolean(opts.json),
        max_sections: opts.maxSections ?? 80,
      });
    });

  app
    .command("gdrive-list")
    .description("List accessible Google Drive files.")
    .option("--folder <id>", "Filter to files in a specific folder (by folder ID).")
    .option("--max <n>", "Maximum files to list.", _int, 20)
    .option("--json", "Output structured JSON instead of human-readable text.")
    .action(
      async (opts: { folder?: string; max?: number; json?: boolean }) => {
        const g = await _cliGdrive();
        g.gdrive_list({
          folder: opts.folder ?? null,
          max_results: opts.max ?? 20,
          json_output: Boolean(opts.json),
        });
      },
    );

  app
    .command("gdrive-auth", "", { hidden: true })
    .description("One-time Google Drive auth setup. Tries ADC first, then OAuth flow.")
    .option("--client-secrets <path>", "Path to OAuth client_secrets.json.")
    .action(async (opts: { clientSecrets?: string }) => {
      const g = await _cliGdrive();
      g.gdrive_auth({ client_secrets: opts.clientSecrets ?? null });
    });
}

// ---------------------------------------------------------------------------
// Batch G — image commands (thin delegators over cli_image)
// ---------------------------------------------------------------------------

/**
 * Register the 3 image commands (batch G). All three are `hidden=True` in
 * Python (agent-facing via hooks, not user-typed), so registered with
 * `{ hidden: true }` like `gdrive-fetch` / `session-mark`. (`compress`, the 4th
 * batch-G command, is deferred until `bash_runner` is ported.)
 */
function _registerImageCommands(app: Command): void {
  app
    .command("fetch-image", "", { hidden: true })
    .description("Fetch an image URL (auto-shrunk). Returns the local cached path.")
    .argument("<url>", "Image URL to fetch.")
    .option("--json", "Output structured JSON instead of human-readable text.")
    .action(async (url: string, opts: { json?: boolean }) => {
      const m = await _cliImage();
      await m.fetch_image({ url, json_output: Boolean(opts.json) });
    });

  app
    .command("image-shrink", "", { hidden: true })
    .description("Manually shrink an image (also used by hooks).")
    .argument("<src>", "Path to the image to shrink.")
    .option("--json", "Output structured JSON instead of human-readable text.")
    .action(async (src: string, opts: { json?: boolean }) => {
      const m = await _cliImage();
      await m.image_shrink_cmd({ src, json_output: Boolean(opts.json) });
    });

  app
    .command("caption-instead", "", { hidden: true })
    .description("Generate text caption instead of image (v2 feature).")
    .argument("<path>", "Path to the image.")
    .action(async (pathArg: string) => {
      const m = await _cliImage();
      m.caption_instead({ path: pathArg });
    });
}

// ---------------------------------------------------------------------------
// Batch J — clean/prune commands (thin delegators over cli_clean)
// ---------------------------------------------------------------------------

/**
 * Register the 3 cache-cleaning commands (batch J), all on the Advanced panel
 * (commander has no panels — every command is a flat top-level subcommand):
 * clean-cache, prune-cache, clean.
 */
function _registerCleanCommands(app: Command): void {
  app
    .command("clean-cache")
    .description("Prune on-disk caches to their configured floor.")
    .option("--images", "Prune the image shrink cache to its configured floor.")
    .option("--json", "Output structured JSON instead of human-readable text.")
    .action(async (opts: { images?: boolean; json?: boolean }) => {
      const c = await _cliClean();
      c.clean_cache({ images: Boolean(opts.images), json_output: Boolean(opts.json) });
    });

  app
    .command("prune-cache")
    .description("Manually trigger cache eviction across all cache directories.")
    .option("--dry-run", "Show what would be removed without deleting.")
    .option("--json", "Output structured JSON instead of human-readable text.")
    .action(async (opts: { dryRun?: boolean; json?: boolean }) => {
      const c = await _cliClean();
      c.prune_cache({ dry_run: Boolean(opts.dryRun), json_output: Boolean(opts.json) });
    });

  app
    .command("clean")
    .description("Clear caches to free disk space.")
    .option("--images", "Clear the image shrink cache.")
    .option("--bash", "Clear the bash output cache.")
    .option("--web", "Clear the web output cache.")
    .option("--sessions", "Remove session files older than --older-than days.")
    .option("--all", "Clear all caches (equivalent to --images --bash --web --sessions).")
    .option("--dry-run", "Print what would be deleted without deleting.")
    .option("--older-than <n>", "Only delete files older than N days (applies to all categories).", _int, 7)
    .action(
      async (opts: {
        images?: boolean;
        bash?: boolean;
        web?: boolean;
        sessions?: boolean;
        all?: boolean;
        dryRun?: boolean;
        olderThan?: number;
      }) => {
        const c = await _cliClean();
        c.clean({
          images: Boolean(opts.images),
          bash: Boolean(opts.bash),
          web: Boolean(opts.web),
          sessions: Boolean(opts.sessions),
          all: Boolean(opts.all),
          dry_run: Boolean(opts.dryRun),
          older_than: opts.olderThan ?? 7,
        });
      },
    );
}

// ---------------------------------------------------------------------------
// Batch F — history + output-recall commands (thin delegators over cli_history)
// ---------------------------------------------------------------------------

/**
 * Register the 7 history/recall commands (batch F), all Core panel. The three
 * `-output` recall commands share the head/tail/grep/grep-max/case-sensitive/
 * full/head-tail/section/json flag set; bash-output adds --diff; web-output
 * adds --list/--from-session. The three history commands take --limit/-n
 * (bash-history adds --since). `history` takes --session-id (required) +
 * --bash/--web/--grep/--limit/--json.
 */
function _registerHistoryCommands(app: Command): void {
  app
    .command("bash-output")
    .description("Retrieve a sliced view of a cached Bash output.")
    .argument("<output_id>", "ID returned by the post-bash hook or `bash-history`.")
    .option("--head <n>", "Show first N lines (0 = no head limit).", _int, 0)
    .option("--tail <n>", "Show last N lines (0 = no tail limit).", _int, 0)
    .option("-g, --grep <pattern>", "Show only lines matching a regex pattern.")
    .option("--grep-max <n>", "Max matching lines to show with --grep (0 = no cap).", _int, 20)
    .option("--case-sensitive", "Make --grep matching case-sensitive.")
    .option("--full", "Return the entire cached output (disables smart-default head+tail).")
    .option("--head-tail", "Emit first+last 20 lines with an omission marker.")
    .option("-s, --section <heading>", "Extract a specific markdown section by heading text.")
    .option("--json", "Output structured JSON instead of human-readable text.")
    .option("--diff", "Show unified diff of what was elided by the smart-default trimming.")
    .action(
      async (
        outputId: string,
        opts: {
          head?: number;
          tail?: number;
          grep?: string;
          grepMax?: number;
          caseSensitive?: boolean;
          full?: boolean;
          headTail?: boolean;
          section?: string;
          json?: boolean;
          diff?: boolean;
        },
      ) => {
        const h = await _cliHistory();
        h.bash_output({
          output_id: outputId,
          head: opts.head ?? 0,
          tail: opts.tail ?? 0,
          grep: opts.grep ?? null,
          grep_max: opts.grepMax ?? 20,
          case_sensitive: Boolean(opts.caseSensitive),
          full: Boolean(opts.full),
          head_tail: Boolean(opts.headTail),
          section: opts.section ?? null,
          json_output: Boolean(opts.json),
          diff: Boolean(opts.diff),
        });
      },
    );

  app
    .command("web-output")
    .description("Retrieve a sliced view of a cached WebFetch response body.")
    .argument("[output_id]", "ID from the post-fetch hook or `web-history`. Omit with --from-session/--list.")
    .option("--head <n>", "Show first N lines (0 = no head limit).", _int, 0)
    .option("--tail <n>", "Show last N lines (0 = no tail limit).", _int, 0)
    .option("-g, --grep <pattern>", "Show only lines matching a regex pattern.")
    .option("--grep-max <n>", "Max matching lines to show with --grep (0 = no cap).", _int, 20)
    .option("--case-sensitive", "Make --grep matching case-sensitive.")
    .option("--full", "Return the entire cached output.")
    .option("--head-tail", "Emit first+last 20 lines with an omission marker.")
    .option("-s, --section <heading>", "Extract a specific markdown section by heading text.")
    .option("--json", "Output structured JSON instead of human-readable text.")
    .option("--from-session <id>", "List all web outputs cached during SESSION_ID.")
    .option("--list", "List all cached web outputs (URL, age, size).")
    .action(
      async (
        outputId: string | undefined,
        opts: {
          head?: number;
          tail?: number;
          grep?: string;
          grepMax?: number;
          caseSensitive?: boolean;
          full?: boolean;
          headTail?: boolean;
          section?: string;
          json?: boolean;
          fromSession?: string;
          list?: boolean;
        },
      ) => {
        const h = await _cliHistory();
        h.web_output({
          output_id: outputId ?? null,
          head: opts.head ?? 0,
          tail: opts.tail ?? 0,
          grep: opts.grep ?? null,
          grep_max: opts.grepMax ?? 20,
          case_sensitive: Boolean(opts.caseSensitive),
          full: Boolean(opts.full),
          head_tail: Boolean(opts.headTail),
          section: opts.section ?? null,
          json_output: Boolean(opts.json),
          from_session: opts.fromSession ?? null,
          list_all: Boolean(opts.list),
        });
      },
    );

  app
    .command("mcp-output")
    .description("Retrieve a sliced view of a cached MCP tool result.")
    .argument("<output_id>", "ID returned by the post-fetch hook or `mcp-history`.")
    .option("--head <n>", "Show first N lines (0 = no head limit).", _int, 0)
    .option("--tail <n>", "Show last N lines (0 = no tail limit).", _int, 0)
    .option("-g, --grep <pattern>", "Show only lines matching a regex pattern.")
    .option("--grep-max <n>", "Max matching lines to show with --grep (0 = no cap).", _int, 20)
    .option("--case-sensitive", "Make --grep matching case-sensitive.")
    .option("--full", "Return the entire cached output.")
    .option("--head-tail", "Emit first+last 20 lines with an omission marker.")
    .option("-s, --section <heading>", "Extract a specific markdown section by heading text.")
    .option("--json", "Output structured JSON instead of human-readable text.")
    .action(
      async (
        outputId: string,
        opts: {
          head?: number;
          tail?: number;
          grep?: string;
          grepMax?: number;
          caseSensitive?: boolean;
          full?: boolean;
          headTail?: boolean;
          section?: string;
          json?: boolean;
        },
      ) => {
        const h = await _cliHistory();
        h.mcp_output({
          output_id: outputId,
          head: opts.head ?? 0,
          tail: opts.tail ?? 0,
          grep: opts.grep ?? null,
          grep_max: opts.grepMax ?? 20,
          case_sensitive: Boolean(opts.caseSensitive),
          full: Boolean(opts.full),
          head_tail: Boolean(opts.headTail),
          section: opts.section ?? null,
          json_output: Boolean(opts.json),
        });
      },
    );

  app
    .command("bash-history")
    .description("List cached Bash outputs, newest first.")
    .option("-n, --limit <n>", "Maximum entries to show (newest first).", _int, 20)
    .option("--json", "Output structured JSON instead of human-readable text.")
    .option("--since <duration>", "Only show entries newer than this duration (e.g. '30m', '2h', '1d').")
    .action(async (opts: { limit?: number; json?: boolean; since?: string }) => {
      const h = await _cliHistory();
      h.bash_history({
        json_output: Boolean(opts.json),
        limit: opts.limit ?? 20,
        since: opts.since ?? null,
      });
    });

  app
    .command("web-history")
    .description("List cached WebFetch responses, newest first.")
    .option("-n, --limit <n>", "Maximum entries to show (newest first).", _int, 20)
    .option("--json", "Output structured JSON instead of human-readable text.")
    .action(async (opts: { limit?: number; json?: boolean }) => {
      const h = await _cliHistory();
      h.web_history({ json_output: Boolean(opts.json), limit: opts.limit ?? 20 });
    });

  app
    .command("mcp-history")
    .description("List cached MCP tool results, newest first.")
    .option("-n, --limit <n>", "Maximum entries to show (newest first).", _int, 20)
    .option("--json", "Output structured JSON instead of human-readable text.")
    .action(async (opts: { limit?: number; json?: boolean }) => {
      const h = await _cliHistory();
      h.mcp_history({ json_output: Boolean(opts.json), limit: opts.limit ?? 20 });
    });

  app
    .command("history")
    .description("Show current session access history: bash commands, URLs, and grep patterns.")
    .option("-s, --session-id <id>", "Session id (required).")
    .option("--bash", "Show bash command history only.")
    .option("--web", "Show URL fetch history only.")
    .option("--grep", "Show grep pattern history only.")
    .option("-n, --limit <n>", "Maximum entries per section (default 10).", _int, 10)
    .option("--json", "Output structured JSON instead of human-readable text.")
    .action(
      async (opts: {
        sessionId?: string;
        bash?: boolean;
        web?: boolean;
        grep?: boolean;
        limit?: number;
        json?: boolean;
      }) => {
        const h = await _cliHistory();
        h.history({
          session_id: opts.sessionId ?? null,
          bash: Boolean(opts.bash),
          web: Boolean(opts.web),
          grep: Boolean(opts.grep),
          limit: opts.limit ?? 10,
          json_output: Boolean(opts.json),
        });
      },
    );
}

// ---------------------------------------------------------------------------
// Batch H — indexing commands (thin delegators over cli_index)
// ---------------------------------------------------------------------------

/**
 * Register the 4 indexing commands (batch H), all Core panel:
 * memory, git-history, export, index (+ index --watch via _watch_project).
 */
function _registerIndexCommands(app: Command): void {
  app
    .command("memory")
    .description("Manage persistent per-project memory facts injected at session start.")
    .argument("<action>", "show | set | unset | clear")
    .argument("[key]", "Memory key (required for set/unset).")
    .argument("[value]", "Memory value (required for set).")
    .option("-p, --project <dir>", "Project root (default: cwd).")
    .action(
      async (
        action: string,
        key: string | undefined,
        value: string | undefined,
        opts: { project?: string },
      ) => {
        const m = await _cliIndex();
        m.memory_cmd({
          action,
          key: key ?? null,
          value: value ?? null,
          project_dir: opts.project ?? null,
        });
      },
    );

  app
    .command("git-history")
    .description("Show recent git commits that touched <file> (from the indexed git history).")
    .argument("<file>", "File path to look up in git history.")
    .option("-n, --limit <n>", "Number of commits to show.", _int, 5)
    .action(async (file: string, opts: { limit?: number }) => {
      const m = await _cliIndex();
      m.git_history_cmd({ file, limit: opts.limit ?? 5 });
    });

  app
    .command("export")
    .description("Export the indexed symbol database for a project (json/csv/ctags).")
    .option("-f, --format <fmt>", "Output format: json, csv, or ctags.", "json")
    .option("-o, --output <file>", "Write output to FILE instead of stdout.")
    .option("-p, --project <dir>", "Project root (default: current directory).")
    .action(async (opts: { format?: string; output?: string; project?: string }) => {
      const m = await _cliIndex();
      m.cmd_export({
        fmt: opts.format ?? "json",
        output: opts.output ?? null,
        project: opts.project ?? null,
      });
    });

  app
    .command("index")
    .description("Rebuild project/global indices.")
    .option("--full", "Force a full re-index (default; --full is incremental-off).")
    .option("--embeddings", "Also (re)index semantic embeddings.")
    .option("--root <dir>", "Index an arbitrary directory (skips project detection).")
    .option("--skills", "Index ~/.claude/skills/.")
    .option("--plugins", "Index ~/.claude/plugins/.")
    .option("--watch", "Watch for file changes and reindex automatically (Ctrl+C to stop).")
    .option("--report-large", "Print a table of files skipped/symbol-only due to size.")
    .option("-v, --verbose", "Print each file as it's indexed with symbol count.")
    .option("--check", "Report pending dirty files without indexing. Exit 1 if dirty, 0 if clean.")
    .option(
      "--ext <ext>",
      "Only (re-)index files with this extension. May be repeated (--ext py --ext ts).",
      (value: string, previous: string[]) => previous.concat([value]),
      [] as string[],
    )
    .action(
      async (opts: {
        full?: boolean;
        embeddings?: boolean;
        root?: string;
        skills?: boolean;
        plugins?: boolean;
        watch?: boolean;
        reportLarge?: boolean;
        verbose?: boolean;
        check?: boolean;
        ext?: string[] | string;
      }) => {
        const m = await _cliIndex();
        // commander collects repeated --ext as an array when .argParser pushes; a
        // single pass arrives as a string — normalise to string[] | null.
        const extRaw = opts.ext;
        const ext: string[] | null = Array.isArray(extRaw)
          ? extRaw
          : extRaw
            ? [extRaw]
            : null;
        await m.index_cmd({
          full: Boolean(opts.full),
          embeddings: Boolean(opts.embeddings),
          root: opts.root ?? null,
          skills: Boolean(opts.skills),
          plugins: Boolean(opts.plugins),
          watch: Boolean(opts.watch),
          report_large: Boolean(opts.reportLarge),
          verbose: Boolean(opts.verbose),
          check: Boolean(opts.check),
          ext,
        });
      },
    );
}

// ---------------------------------------------------------------------------
// Batch I — lifecycle commands (thin delegators over cli_lifecycle)
// ---------------------------------------------------------------------------

/**
 * Register the 5 lifecycle commands (batch I): install / uninstall /
 * context-stats / doctor (Install panel, visible) + worker (hidden). `doctor`
 * is now registered via cli_doctor (the 2585-LOC health-check module).
 */
function _registerLifecycleCommands(app: Command): void {
  app
    .command("install")
    .description("One-time setup: scheduled tasks, settings.json, CLAUDE.md, skill, watchdog.")
    .option("--codex", "Also install Codex CLI integration.")
    .option("--opencode", "Also install opencode plugin bridge.")
    .option("--openclaw", "Also install openclaw plugin bridge.")
    .option("--pi", "Also install pi extension bridge (global ~/.pi/agent/extensions).")
    .option("--target <tool>", "Install hooks for a specific tool (claude/codex/gemini/opencode/openclaw/pi/all). May be repeated.", (value: string, previous: string[]) => previous.concat([value]), [] as string[])
    .option("--dry-run", "Print what would change; make no changes.")
    .option("--verify", "After install, run a structured self-check.")
    .option("--check", "Print current autostart registration and interpreter match; no side effects.")
    .action(
      async (opts: {
        codex?: boolean;
        opencode?: boolean;
        openclaw?: boolean;
        pi?: boolean;
        target?: string[];
        dryRun?: boolean;
        verify?: boolean;
        check?: boolean;
      }) => {
        const m = await _cliLifecycle();
        m.cmd_install({
          codex: Boolean(opts.codex),
          opencode: Boolean(opts.opencode),
          openclaw: Boolean(opts.openclaw),
          pi: Boolean(opts.pi),
          target: opts.target && opts.target.length > 0 ? opts.target : null,
          dry_run: Boolean(opts.dryRun),
          verify: Boolean(opts.verify),
          check: Boolean(opts.check),
        });
      },
    );

  app
    .command("uninstall")
    .description("Cleanly reverse install.")
    .option("--purge", "Also delete the data dir.")
    .option("--codex", "Also remove Codex CLI integration.")
    .option("--gemini", "Also remove Gemini CLI hook integration.")
    .option("--opencode", "Also remove opencode plugin bridge.")
    .option("--openclaw", "Also remove openclaw plugin bridge.")
    .option("--pi", "Also remove pi extension bridge (global ~/.pi/agent/extensions).")
    .action(
      async (opts: {
        purge?: boolean;
        codex?: boolean;
        gemini?: boolean;
        opencode?: boolean;
        openclaw?: boolean;
        pi?: boolean;
      }) => {
        const m = await _cliLifecycle();
        m.cmd_uninstall({
          purge: Boolean(opts.purge),
          codex: Boolean(opts.codex),
          gemini: Boolean(opts.gemini),
          opencode: Boolean(opts.opencode),
          openclaw: Boolean(opts.openclaw),
          pi: Boolean(opts.pi),
        });
      },
    );

  app
    .command("context-stats")
    .description(
      "Show startup context footprint and optionally prune stale MEMORY.md entries.",
    )
    .option(
      "--fix",
      "Apply safe structural pruning: remove dead links and exact-duplicate entries from MEMORY.md.",
    )
    .option("--json", "Machine-readable output.")
    .option("--project <dir>", "Project root to analyse (defaults to CWD).")
    .action(async (opts: { fix?: boolean; json?: boolean; project?: string }) => {
      const m = await _cliLifecycle();
      m.context_stats({
        fix: Boolean(opts.fix),
        json_output: Boolean(opts.json),
        project: opts.project ?? null,
      });
    });

  app
    .command("worker", "", { hidden: true })
    .description("Internal: background worker daemon (invoked by the SessionStart watchdog).")
    .option("--daemon", "Run as background daemon (otherwise interactive).")
    .option("--status", "Show worker status and exit.")
    .option("--check", "Check for a running worker; exit 1 if a duplicate (different interpreter) is detected.")
    .option("--kill-duplicate", "Kill a running worker whose interpreter differs from the current one.")
    .action(
      async (opts: { daemon?: boolean; status?: boolean; check?: boolean; killDuplicate?: boolean }) => {
        const m = await _cliLifecycle();
        await m.cmd_worker({
          daemon: Boolean(opts.daemon),
          status: Boolean(opts.status),
          check: Boolean(opts.check),
          kill_duplicate: Boolean(opts.killDuplicate),
        });
      },
    );

  app
    .command("doctor")
    .description("Diagnose indexing health.")
    .option("--fix", "Clear stale index-spawn markers that doctor flags.")
    .option("--crashes", "Show the last 5 hook crash entries from hooks-stderr.log.")
    .option("--context", "Always show the Context footprint section.")
    .action(async (opts: { fix?: boolean; crashes?: boolean; context?: boolean }) => {
      const m = await _cliDoctor();
      await m.doctor({
        fix: Boolean(opts.fix),
        crashes: Boolean(opts.crashes),
        context: Boolean(opts.context),
      });
    });
}

// ---------------------------------------------------------------------------
// Batch K — stats / cost / diff (cli_stats) + compress (cli_compress).
// ---------------------------------------------------------------------------

/**
 * Register batch K (stats / cost / diff, Core) + `compress` (Advanced). stats/
 * cost/diff delegate to cli_stats; compress wraps bash_runner via cli_compress.
 * `compress` mirrors cli.py's `context_settings={ignore_unknown_options,
 * allow_extra_args}` via `.allowUnknownOption().allowExcessArguments()`.
 */
function _registerStatsCommands(app: Command): void {
  app
    .command("stats")
    .description("Show cumulative token savings.")
    .option("-w, --window <n>", "Days to include (0 = all time)", _int, 30)
    .option("--json", "Machine-readable output.")
    .option("--by-project", "Show per-project breakdown table.")
    .option("--by-command", "Show per-CLI-command breakdown table.")
    .option("--top <n>", "Number of projects to show with --by-project.", _int, 10)
    .option("--since <n>", "Show data for the last N days only (alias for --window).", _int)
    .option("--session-id <id>", "Show focused compression metrics for one session.")
    .option("--global", "Show all-time compression metrics instead of the session-scoped view.")
    .action(
      async (opts: {
        window?: number;
        json?: boolean;
        byProject?: boolean;
        byCommand?: boolean;
        top?: number;
        since?: number;
        sessionId?: string;
        global?: boolean;
      }) => {
        const m = await _cliStats();
        m.cmd_stats({
          window: opts.window ?? 30,
          json_output: Boolean(opts.json),
          by_project: Boolean(opts.byProject),
          by_command: Boolean(opts.byCommand),
          top: opts.top ?? 10,
          since: opts.since ?? null,
          session_id: opts.sessionId ?? null,
          global_: Boolean(opts.global),
        });
      },
    );

  app
    .command("cost")
    .description("Show estimated tokens saved (session or all-time).")
    .option(
      "-s, --session <id>",
      "Show savings for a specific session (full or 8-char short form). When omitted, shows all-time summary.",
    )
    .action(async (opts: { session?: string }) => {
      const m = await _cliStats();
      m.cost({ session: opts.session ?? null });
    });

  app
    .command("diff")
    .description("Show files changed since a git ref, with optional symbol-level context.")
    .option("--since <ref>", "Git ref to diff against (commit, branch, tag).", "HEAD~1")
    .option("-s, --session <id>", "Show files edited in this session instead of running git diff.")
    .option("--symbols", "List changed symbols (functions/classes) for each file.")
    .option("--json", "Machine-readable output.")
    .action(
      async (opts: { since?: string; session?: string; symbols?: boolean; json?: boolean }) => {
        const m = await _cliStats();
        m.cmd_diff({
          since: opts.since ?? "HEAD~1",
          session_id: opts.session ?? null,
          symbols: Boolean(opts.symbols),
          json_output: Boolean(opts.json),
        });
      },
    );

  app
    .command("compress")
    .description("Run a shell command and emit a compressed view of its output.")
    .allowUnknownOption()
    .allowExcessArguments()
    .requiredOption(
      "-c, --cmd <cmd>",
      "The original shell command to run, captured into a single string.",
    )
    .option(
      "-f, --filter <name>",
      "Filter name (pytest, jest, git, ...). Auto-detected from the command when omitted.",
    )
    .option("--timeout <secs>", "Wall-clock timeout in seconds (0 = use built-in default).", _int, 0)
    .option("--no-compress", "Skip compression and stream output raw (for debugging the wrapper).")
    .option(
      "--profile <profile>",
      "Compression profile: aggressive / balanced / minimal. Overrides config and auto-detection.",
    )
    .option(
      "--max-tokens <n>",
      "Post-compress token cap (0 = no cap). Passed by the pre-Bash hook to tighten output at high context pressure.",
      _int,
      0,
    )
    .action(
      async (opts: {
        cmd: string;
        filter?: string;
        timeout?: number;
        compress?: boolean;
        profile?: string;
        maxTokens?: number;
      }) => {
        const m = await _cliCompress();
        // commander's --no-compress sets opts.compress = false (negatable option).
        await m.cmd_compress({
          cmd: opts.cmd,
          filter_name: opts.filter ?? null,
          timeout: opts.timeout ?? 0,
          no_compress: opts.compress === false,
          profile: opts.profile ?? null,
          max_tokens: opts.maxTokens ?? 0,
        });
      },
    );
}

// ---------------------------------------------------------------------------
// Batch L — `config *` subapp (thin delegators over cli_config)
// ---------------------------------------------------------------------------

/**
 * Build the `config` subapp (batch L). Mirrors the `_buildHookApp()` pattern:
 * a `config` Command with `list`/`validate`/`get`/`set`/`reset`/`path`
 * subcommands, each delegating to the corresponding cli_config.ts impl.
 * `no_args_is_help` → bare `config` prints help + exits 0 (the `.action()`
 * override throws CliExit(0) after outputting help, matching the hook app).
 */
function _buildConfigApp(): Command {
  const configApp = new Command("config");
  configApp.description("Inspect and edit token-goat's config.toml.");
  // no_args_is_help: `token-goat config` with no subcommand prints help.
  configApp.action(() => {
    configApp.outputHelp();
    throw new CliExit(0);
  });

  configApp
    .command("list")
    .description("List all config keys with their current values and defaults.")
    .option("--json", "Output structured JSON instead of human-readable text.")
    .action(async (opts: { json?: boolean }) => {
      const cfg = await _cliConfig();
      cfg.config_list({ json_output: Boolean(opts.json) });
    });

  configApp
    .command("validate")
    .description("Validate config.toml and report unknown keys with did-you-mean suggestions.")
    .option("--json", "Output structured JSON instead of human-readable text.")
    .action(async (opts: { json?: boolean }) => {
      const cfg = await _cliConfig();
      cfg.config_validate({ json_output: Boolean(opts.json) });
    });

  configApp
    .command("get")
    .description(
      "Show current config value(s). With no KEY, dumps the full config in TOML.",
    )
    .argument("[key]", "Dotted key to retrieve (e.g. compact_assist.enabled).")
    .action(async (key: string | undefined) => {
      const cfg = await _cliConfig();
      cfg.config_get({ key });
    });

  configApp
    .command("set")
    .description("Set a config value, creating config.toml if it does not exist.")
    .argument("<key>", "Dotted key to set (e.g. compact_assist.enabled).")
    .argument("<value>", "Value (coerced to the correct type automatically).")
    .action(async (key: string, value: string) => {
      const cfg = await _cliConfig();
      cfg.config_set({ key, value });
    });

  configApp
    .command("reset")
    .description("Reset config to defaults — one key or everything.")
    .argument("[key]", "Dotted key to reset. Omit to reset ALL settings.")
    .option("-y, --yes", "Skip confirmation prompt.")
    .action(async (key: string | undefined, opts: { yes?: boolean }) => {
      const cfg = await _cliConfig();
      cfg.config_reset({ key, yes: Boolean(opts.yes) });
    });

  configApp
    .command("path")
    .description("Print the path to token-goat's config.toml.")
    .action(async () => {
      const cfg = await _cliConfig();
      cfg.config_path();
    });

  return configApp;
}

/** Build a fresh `token-goat` commander program (fresh per invoke for test isolation). */
export function buildApp(): Command {
  const app = new Command("token-goat");
  app.description(
    "token-goat — token optimizer for Claude Code, Codex CLI, opencode, and openclaw.",
  );

  const hookApp = _buildHookApp();
  _assert_hook_registry_aligned(hookApp);
  app.addCommand(hookApp, { hidden: true });

  // version (subcommand form — `token-goat version [--json]`).
  app
    .command("version")
    .description("Print the installed token-goat version.")
    .option("--json", "Output structured JSON instead of human-readable text.")
    .action((opts: { json?: boolean }) => {
      if (opts.json) {
        _echo(JSON.stringify({ version: __version__ }));
      } else {
        _echo(__version__);
      }
    });

  // map (batch B — PageRank-ranked repo overview). Top-level Core command.
  app
    .command("map")
    .description(
      "Generate a PageRank-ranked, token-budgeted overview of the current project.",
    )
    .option("-b, --budget <n>", "Approximate token budget.", _int, 4000)
    .option("--json", "Legacy alias for --format json.")
    .option(
      "-f, --format <fmt>",
      "Output format: text (default), json, or mermaid.",
      "text",
    )
    .option(
      "--compact",
      "One line per file (no symbol detail). Auto-engages below ~300 token budget.",
    )
    .option(
      "--full",
      "Restore the full per-file list even when --compact is active.",
    )
    .option(
      "--top <n>",
      "Limit output to the top N most important files by PageRank score.",
      _int,
    )
    .option("--top-n <n>", "Number of top files to include in the mermaid diagram.", _int, 20)
    .option("--since <ref>", "Show only files changed since this git ref.")
    .option("--filter <glob>", "Limit output to files whose path matches this glob pattern.")
    .option(
      "--since-minutes <n>",
      "Show only files modified in the last N minutes (filesystem mtime).",
      _int,
    )
    .action(
      async (opts: {
        budget?: number;
        json?: boolean;
        format?: string;
        compact?: boolean;
        full?: boolean;
        top?: number;
        topN?: number;
        since?: string;
        filter?: string;
        sinceMinutes?: number;
      }) => {
        const m = await _cliMap();
        const mapOpts: Record<string, unknown> = {
          json_output: Boolean(opts.json),
          fmt: opts.format,
          compact: Boolean(opts.compact),
          full: Boolean(opts.full),
          top: opts.top ?? null,
          top_n: opts.topN ?? 20,
          since: opts.since ?? null,
          filter_glob: opts.filter ?? null,
          since_minutes: opts.sinceMinutes ?? null,
        };
        if (opts.budget !== undefined) mapOpts["budget"] = opts.budget;
        await m.map(mapOpts as Parameters<typeof m.map>[0]);
      },
    );

  _registerSurgicalReads(app);

  _registerSessionCommands(app);

  _registerSkillCommands(app);

  _registerGdriveCommands(app);

  _registerImageCommands(app);

  _registerCleanCommands(app);

  _registerHistoryCommands(app);

  _registerIndexCommands(app);

  _registerLifecycleCommands(app);

  _registerStatsCommands(app);

  const configApp = _buildConfigApp();
  app.addCommand(configApp);

  return app;
}

/** Recursively enable exitOverride so usage errors / help / version throw a
 *  CommanderError instead of calling process.exit. Output uses commander's
 *  default process-stream writers, which the CliRunner captures via its spy. */
function _applyExitOverride(cmd: Command): void {
  cmd.exitOverride();
  for (const sub of cmd.commands) _applyExitOverride(sub);
}

/**
 * Run the CLI with `argv` (a user argv slice, no node/script prefix). Returns
 * the exit code. Never calls process.exit — the CliRunner harness and `main`
 * own that. Output goes to the process streams (captured by the harness spy).
 */
export async function run(argv: string[]): Promise<number> {
  // Eager root --version / -V: fires only when given before any subcommand
  // (matches typer's is_eager root option). Stop at the first non-option token.
  for (const a of argv) {
    if (a === "--version" || a === "-V") {
      _echo(`token-goat ${__version__}`);
      return 0;
    }
    if (!a.startsWith("-")) break;
  }

  // no_args_is_help: bare `token-goat` prints help and exits 0.
  if (argv.length === 0) {
    const app = buildApp();
    _applyExitOverride(app);
    app.outputHelp();
    return 0;
  }

  const app = buildApp();
  _applyExitOverride(app);
  try {
    await app.parseAsync(argv, { from: "user" });
    return 0;
  } catch (e) {
    if (e instanceof CliExit) return e.code;
    if (e instanceof CommanderError) {
      // help / version display exit 0; usage errors carry their own exitCode.
      return typeof e.exitCode === "number" ? e.exitCode : 1;
    }
    throw e;
  }
}

/**
 * Process entry point. Wraps `run` so hook subcommands NEVER propagate a
 * non-zero exit even when commander rejects unknown arguments before safe_run:
 * we emit a `{"continue": true}` placeholder and exit 0 so a hook harness
 * (Codex in particular) stays happy. Non-hook commands keep normal exit codes.
 */
export async function main(argv: string[] = process.argv.slice(2)): Promise<number> {
  const code = await run(argv);
  if (code !== 0) {
    const isHookCall = argv.length > 0 && argv[0] === "hook";
    if (isHookCall) {
      try {
        process.stdout.write('{"continue": true}');
      } catch (e) {
        _LOG.debug("failed to emit hook response: %s", String(e));
      }
      return 0;
    }
  }
  return code;
}
