/**
 * Tree-sitter orchestration: walks a project, dispatches to per-language
 * extractors, writes to DB.
 *
 * Faithful port of src/token_goat/parser.py. Strict NodeNext ESM.
 *
 * -----
 * Port model
 * -----
 *  - The Python @dataclasses (Symbol, Ref, ImpExp, Section, FileIndex) become
 *    plain TS classes with a constructor that accepts an options object. This
 *    keeps the call-site ergonomics close to Python's keyword construction
 *    (e.g. `new Symbol({ name, kind, line })`) while giving every field a
 *    real runtime slot (so `instanceof` and field mutation work exactly as the
 *    Python adapters expect — they mutate `sym.line`, set `sec.end_line`, …).
 *  - LargeFileInfo is a NamedTuple in Python; here it is an interface (a plain
 *    object literal), since callers only read its fields.
 *  - IndexProjectResult is a TypedDict -> an interface.
 *  - The lazy `importlib.import_module` used by Python's `_language_importer`
 *    becomes a FAIL-SOFT dynamic `import("./languages/<lang>.js")` wrapped in
 *    try/catch: a not-yet-ported grammar adapter (or a missing tree-sitter
 *    runtime) degrades to `null` rather than a hard tsc/runtime dependency.
 *    Because dynamic import is async, `get_extractor` is async in this port;
 *    `index_file` / `index_project` are async too. (Python was sync because
 *    importlib is sync; the observable indexing behaviour is identical.)
 *  - sqlite3.Connection -> better-sqlite3 Database (the `DatabaseType` alias).
 *    Python's `conn.execute(sql, params)` -> `conn.prepare(sql).run(...params)`;
 *    `conn.executemany(sql, rows)` -> a prepared statement run in a loop;
 *    `conn.execute(...).fetchall()` -> `conn.prepare(sql).all()`. BEGIN/COMMIT/
 *    ROLLBACK are issued via `conn.exec(...)` (matching git_history.ts).
 *  - `typer.echo` (verbose CLI output) -> `process.stdout.write(... + "\n")`.
 *
 * -----
 * Byte-offset parity
 * -----
 * Python tree-sitter works in BYTE offsets. `_line_count_from_bytes` counts
 * `\n` bytes over the raw Buffer (byte-accurate). content_sha256 is computed
 * over the raw bytes via node:crypto sha256 (byte-identical to hashlib).
 *
 * -----
 * Module-global caches
 * -----
 *  - The extractor registry/cache mirror Python's `_EXTRACTOR_REGISTRY` /
 *    `_EXTRACTOR_CACHE`.
 *  - The extraction-result LRU (`_RESULT_CACHE`) is registered with reset.ts so
 *    `clearModuleCaches()` (every test's beforeEach) wipes it — Python's tests
 *    call `parser_cache_clear()`; the reset registration makes the TS suite's
 *    blanket cache-wipe cover it too. There is no thread lock (Node is
 *    single-threaded for this synchronous-style code path; the Python Lock
 *    guarded a ThreadPoolExecutor that has no TS analogue here).
 */

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import type { Database as DatabaseType } from "better-sqlite3";

import * as db from "./db.js";
import type { Project } from "./project.js";
import { getLogger } from "./util.js";
import { registerReset } from "./reset.js";
// Self-namespace import so index_project's internal calls to iter_source_files
// go through the live module binding — the ESM analogue of Python's
// monkeypatch.setattr, letting tests vi.spyOn(parser, "iter_source_files").
import * as self from "./parser.js";

const _LOG = getLogger("parser");

// ===========================================================================
// Extension / basename -> language maps
// ===========================================================================

/** Extension -> language_key. */
export const LANG_BY_EXT: Record<string, string> = {
  ".ts": "typescript",
  ".tsx": "typescript",
  ".mts": "typescript",
  ".cts": "typescript",
  ".js": "javascript",
  ".jsx": "javascript",
  ".mjs": "javascript",
  ".cjs": "javascript",
  ".py": "python",
  ".pyi": "python",
  ".go": "go",
  ".rs": "rust",
  ".java": "java",
  ".kt": "kotlin",
  ".kts": "kotlin",
  ".cs": "csharp",
  ".cpp": "cpp",
  ".cc": "cpp",
  ".cxx": "cpp",
  ".c": "c",
  ".h": "cpp",
  ".hpp": "cpp",
  ".hxx": "cpp",
  ".rb": "ruby",
  ".php": "php",
  ".phtml": "php",
  ".liquid": "liquid",
  ".md": "markdown",
  ".markdown": "markdown",
  ".html": "html",
  ".htm": "html",
  ".json": "json",
  ".toml": "toml",
  ".yaml": "yaml",
  ".yml": "yaml",
  ".ini": "ini",
  ".cfg": "ini",
  ".dockerfile": "dockerfile",
  ".css": "css",
  ".scss": "css",
  ".less": "css",
  ".sql": "sql",
  ".pgsql": "sql",
  ".psql": "sql",
  ".graphql": "graphql",
  ".gql": "graphql",
  ".proto": "proto",
  ".mk": "makefile",
};

/**
 * Files identified by full basename rather than suffix. Dotfiles like `.env`
 * and `.envrc` have an empty suffix, so the standard suffix lookup would
 * silently skip them. Resolved by lowercase basename, falling through to the
 * suffix-based LANG_BY_EXT path when no match is found. `Dockerfile` and
 * `Containerfile` are recognised by basename because the conventional spelling
 * has no extension.
 */
const LANG_BY_BASENAME: Record<string, string> = {
  ".env": "env",
  ".envrc": "env",
  ".env.example": "env_file",
  ".env.sample": "env_file",
  ".env.local": "env_file",
  ".env.test": "env_file",
  ".env.development": "env_file",
  ".env.production": "env_file",
  ".env.staging": "env_file",
  dockerfile: "dockerfile",
  containerfile: "dockerfile",
  makefile: "makefile",
  gnumakefile: "makefile",
  "makefile.am": "makefile",
  "makefile.in": "makefile",
};

/** Set view of LANG_BY_BASENAME keys (already lowercase). */
export const _KNOWN_BASENAMES: ReadonlySet<string> = new Set(Object.keys(LANG_BY_BASENAME));

/** Set of all known extensions (already lowercase). Fast O(1) membership test. */
export const _KNOWN_EXTENSIONS: ReadonlySet<string> = new Set(Object.keys(LANG_BY_EXT));

/** Directories that should never be indexed. */
export const SKIP_DIRS: ReadonlySet<string> = new Set([
  "node_modules", ".git", ".hg", ".svn", ".bzr",
  ".next", "dist", "build", ".venv", "venv", "env",
  "__pycache__", ".pytest_cache", ".ruff_cache", ".mypy_cache",
  "target", "out", "coverage", ".turbo", ".vercel", ".svelte-kit",
  ".cache", ".idea", ".vscode", ".DS_Store", ".angular",
  ".nuxt", ".tox", ".eggs", "htmlcov", "bower_components", "vendor",
]);

/**
 * Exact basenames (lowercase) that should never be indexed. Generated
 * lockfiles or OS metadata that match an extension in LANG_BY_EXT but carry no
 * semantic content the LLM would care about.
 */
const SKIP_FILE_BASENAMES: ReadonlySet<string> = new Set([
  "package-lock.json", "yarn.lock", "pnpm-lock.yaml", "npm-shrinkwrap.json",
  "poetry.lock", "uv.lock", "pdm.lock", "pipfile.lock",
  "cargo.lock", "composer.lock", "gemfile.lock",
  ".ds_store", "thumbs.db", "desktop.ini",
]);

/**
 * File-suffix markers that indicate a generated/minified artifact. Checked
 * against the lowercased basename.
 */
const SKIP_FILE_SUFFIXES: readonly string[] = [
  ".min.js", ".min.css", ".min.mjs",
  ".bundle.js", ".bundle.mjs",
  ".js.map", ".mjs.map", ".css.map", ".ts.map",
  "-lock.json", // catches package-lock.json variants and similar
];

/**
 * Default skip threshold (bytes) for oversized files — overridden at runtime by
 * config.indexing.large_file_skip_kb. Hard-coded fallback used when config is
 * unavailable. 2 MB (matches default large_file_skip_kb=2048).
 */
export const MAX_FILE_SIZE = 2_000_000;

/**
 * Hard cap on the number of symbols stored per file. Generated files can
 * contain tens of thousands of identifiers; storing them all would balloon the
 * project DB. When a file exceeds this limit the first MAX_SYMBOLS_PER_FILE
 * symbols (in source order) are kept and the rest are silently dropped.
 */
export const MAX_SYMBOLS_PER_FILE = 1_000;

/**
 * Return True when `name` (a file basename) is a known generated/lock artifact.
 *
 * Combines the exact-basename and suffix-pattern checks. Matching is
 * case-insensitive (Windows-friendly).
 */
export function _is_generated_filename(name: string): boolean {
  const lower = name.toLowerCase();
  if (SKIP_FILE_BASENAMES.has(lower)) {
    return true;
  }
  return SKIP_FILE_SUFFIXES.some((suf) => lower.endsWith(suf));
}

// ===========================================================================
// Content / symbol model (Python @dataclasses -> TS classes)
// ===========================================================================

/** Construction options for {@link Symbol}. */
export interface SymbolInit {
  name: string;
  kind: string;
  line: number;
  col?: number;
  end_line?: number | null;
  signature?: string | null;
  parent_name?: string | null;
}

/**
 * Represents a named entity (function, class, variable, etc.) in source code.
 *
 * Mirrors the Python @dataclass Symbol field-for-field. Defaults: col=0,
 * end_line=null, signature=null, parent_name=null.
 */
export class Symbol {
  name: string;
  /** function|class|method|type|interface|const|enum|var|arrow_fn|… */
  kind: string;
  /** 1-indexed line number where the symbol definition begins. */
  line: number;
  /** 0-based column offset (default 0). */
  col: number;
  /** 1-indexed line where the symbol definition ends, or null. */
  end_line: number | null;
  /** Parsed signature string for callables, or null. */
  signature: string | null;
  /** Enclosing scope name for nested symbols (methods, inner fns), or null. */
  parent_name: string | null;

  constructor(init: SymbolInit) {
    this.name = init.name;
    this.kind = init.kind;
    this.line = init.line;
    this.col = init.col ?? 0;
    this.end_line = init.end_line ?? null;
    this.signature = init.signature ?? null;
    this.parent_name = init.parent_name ?? null;
  }
}

/** Construction options for {@link Ref}. */
export interface RefInit {
  name: string;
  line: number;
  col?: number;
  context?: string | null;
}

/**
 * Represents a reference to a symbol in source code (usage or mention).
 *
 * Mirrors the Python @dataclass Ref. Defaults: col=0, context=null.
 */
export class Ref {
  name: string;
  /** 1-indexed line where the reference occurs. */
  line: number;
  /** 0-based column offset (default 0). */
  col: number;
  /** Contextual snippet around the reference, or null. */
  context: string | null;

  constructor(init: RefInit) {
    this.name = init.name;
    this.line = init.line;
    this.col = init.col ?? 0;
    this.context = init.context ?? null;
  }
}

/** Construction options for {@link ImpExp}. */
export interface ImpExpInit {
  kind: string;
  target: string;
  line: number;
}

/**
 * An import or export relationship extracted from a source file.
 *
 * Mirrors the Python @dataclass ImpExp. `kind` is one of "import" | "export" |
 * "reexport".
 */
export class ImpExp {
  /** import|export|reexport */
  kind: string;
  /** Module path or symbol being imported/exported (as written in source). */
  target: string;
  /** 1-indexed line number where the relationship appears. */
  line: number;

  constructor(init: ImpExpInit) {
    this.kind = init.kind;
    this.target = init.target;
    this.line = init.line;
  }
}

/** Construction options for {@link Section}. */
export interface SectionInit {
  heading: string;
  level: number;
  line: number;
  end_line?: number | null;
}

/**
 * Represents a heading/section in a document (markdown, HTML, etc.).
 *
 * Mirrors the Python @dataclass Section. Default end_line=null.
 */
export class Section {
  /** Heading text (e.g. "Installation", "API Reference"). */
  heading: string;
  /** Heading hierarchy level (1 = top-level). */
  level: number;
  /** 1-indexed line number where the heading appears. */
  line: number;
  /** 1-indexed line where this section's content ends, or null. */
  end_line: number | null;

  constructor(init: SectionInit) {
    this.heading = init.heading;
    this.level = init.level;
    this.line = init.line;
    this.end_line = init.end_line ?? null;
  }
}

/**
 * Describes a file that was skipped or received reduced indexing due to size.
 *
 * Python NamedTuple -> interface (callers only read fields). `reason` is
 * "skipped" (file too large to index at all) or "symbol_only" (indexed for
 * symbols but not embedded).
 */
export interface LargeFileInfo {
  /** Path relative to the project root (POSIX-style). */
  rel_path: string;
  /** File size in bytes at index time. */
  size_bytes: number;
  /** "skipped" | "symbol_only" */
  reason: string;
}

/** Construction options for {@link FileIndex}. */
export interface FileIndexInit {
  rel_path: string;
  language: string;
  size: number;
  line_count: number;
  mtime: number;
  content_sha256: string;
  symbols?: Symbol[];
  refs?: Ref[];
  imports_exports?: ImpExp[];
  sections?: Section[];
  symbol_only?: boolean;
}

/**
 * Complete analysis of a single file: symbols, references, imports/exports, and
 * sections. Produced by index_file() and persisted in the SQLite DB.
 *
 * Mirrors the Python @dataclass FileIndex. The list fields default to fresh
 * empty arrays; symbol_only defaults to false.
 */
export class FileIndex {
  /** Path to the file, relative to project root (POSIX style). */
  rel_path: string;
  /** Detected language ('python', 'typescript', 'go', …). */
  language: string;
  /** File size in bytes. */
  size: number;
  /** Exact number of newline-delimited lines in the file. */
  line_count: number;
  /** Last-modified timestamp (unix epoch, float). */
  mtime: number;
  /** SHA256 hash of file content. */
  content_sha256: string;
  /** Named definitions in the file. */
  symbols: Symbol[];
  /** Symbol references (usages) within the file. */
  refs: Ref[];
  /** Import/export statements. */
  imports_exports: ImpExp[];
  /** Headings/sections (document formats only). */
  sections: Section[];
  /**
   * When True, this file exceeded the large_file_symbol_only_kb threshold and
   * was indexed for symbols only — the embedding/chunking pass is skipped.
   */
  symbol_only: boolean;

  constructor(init: FileIndexInit) {
    this.rel_path = init.rel_path;
    this.language = init.language;
    this.size = init.size;
    this.line_count = init.line_count;
    this.mtime = init.mtime;
    this.content_sha256 = init.content_sha256;
    this.symbols = init.symbols ?? [];
    this.refs = init.refs ?? [];
    this.imports_exports = init.imports_exports ?? [];
    this.sections = init.sections ?? [];
    this.symbol_only = init.symbol_only ?? false;
  }
}

/**
 * Each language module exposes:
 *   extract(source: Buffer, rel_path: string) ->
 *     [Symbol[], Ref[], ImpExp[], Section[]]
 *
 * Mirrors Python's `Extractor = Callable[[bytes, str], tuple[...]]`. The TS
 * tuple is a fixed 4-element tuple type. Extractors are synchronous (they do
 * pure in-memory parsing).
 */
export type Extractor = (
  source: Buffer,
  rel_path: string,
) => [Symbol[], Ref[], ImpExp[], Section[]];

/** Result of index_project operation (Python TypedDict). */
export interface IndexProjectResult {
  total_files: number;
  indexed: number;
  skipped_unchanged: number;
  errors: number;
  languages: string[];
  duration_sec: number;
  total_symbols: number;
  large_files: LargeFileInfo[];
  /** extension -> count of files indexed (e.g. {".py": 45, ".ts": 12}). */
  ext_counts: Record<string, number>;
}

// ===========================================================================
// Extractor registry (lazy, fail-soft dynamic import)
// ===========================================================================

/**
 * Zero-arg async factory that lazily imports `languages/<module_name>.<attr>`.
 *
 * FAIL-SOFT: the dynamic `import("./languages/<module>.js")` is wrapped so a
 * not-yet-ported adapter (the 10 grammar adapters python/java/typescript/cpp/
 * csharp/go/ruby/rust/php/kotlin are NOT present this run, nor is the
 * tree-sitter runtime) resolves to a thrown ImportError-shaped Error that
 * get_extractor() catches and degrades to null. The Python version raised a
 * real ImportError from importlib; we mirror that by throwing here so the
 * get_extractor try/catch logs and returns null identically.
 *
 * @param module_name submodule under languages/ (e.g. "typescript", "json_idx")
 * @param attr        named export to return (default "extract")
 */
// Static literal-import loaders for the ported adapter modules. A *variable*
// dynamic import (`import(`./languages/${m}.js`)`) is not statically analysable
// by Vite/vitest ("Unknown variable dynamic import") and the .js glob never
// matches the .ts sources, so every extractor load failed under the test runner.
// Literal specifiers resolve identically in vitest, Node, and the esbuild CLI
// bundle, and keep tsc clean (no import of the not-yet-ported grammar modules).
// Grammar adapters (typescript/python/go/…) are intentionally absent until the
// tree-sitter run lands them — a missing entry degrades to null, exactly like
// Python's ImportError branch. Add their loaders here when those modules ship.
const _LANG_MODULE_LOADERS: Record<string, () => Promise<Record<string, unknown>>> = {
  // --- GRAMMAR adapters (web-tree-sitter). Each exports an async getExtractor()
  // factory, resolved via _grammar_importer below (NOT _language_importer, whose
  // attr is the sync `extract`). Only python.ts is written this run; the other 9
  // literal-import thunks point at modules that do not yet exist, so the dynamic
  // import rejects at runtime and get_extractor degrades to null (fail-soft) —
  // exactly the ImportError branch the flat loaders use. Literal specifiers keep
  // tsc clean and stay statically analysable by vitest (a variable dynamic
  // import is "Unknown variable dynamic import"). Add the remaining adapters'
  // modules to disk to light them up; no change needed here.
  python: () => import("./languages/python.js") as Promise<Record<string, unknown>>,
  java: () => import("./languages/java.js") as Promise<Record<string, unknown>>,
  typescript: () => import("./languages/typescript.js") as Promise<Record<string, unknown>>,
  cpp: () => import("./languages/cpp.js") as Promise<Record<string, unknown>>,
  csharp: () => import("./languages/csharp.js") as Promise<Record<string, unknown>>,
  go: () => import("./languages/go.js") as Promise<Record<string, unknown>>,
  ruby: () => import("./languages/ruby.js") as Promise<Record<string, unknown>>,
  rust: () => import("./languages/rust.js") as Promise<Record<string, unknown>>,
  php: () => import("./languages/php.js") as Promise<Record<string, unknown>>,
  kotlin: () => import("./languages/kotlin.js") as Promise<Record<string, unknown>>,
  // --- flat / regex adapters (already ported) ---
  markdown: () => import("./languages/markdown.js") as Promise<Record<string, unknown>>,
  html: () => import("./languages/html.js") as Promise<Record<string, unknown>>,
  liquid: () => import("./languages/liquid.js") as Promise<Record<string, unknown>>,
  json_idx: () => import("./languages/json_idx.js") as Promise<Record<string, unknown>>,
  toml_idx: () => import("./languages/toml_idx.js") as Promise<Record<string, unknown>>,
  yaml_idx: () => import("./languages/yaml_idx.js") as Promise<Record<string, unknown>>,
  ini_idx: () => import("./languages/ini_idx.js") as Promise<Record<string, unknown>>,
  env_idx: () => import("./languages/env_idx.js") as Promise<Record<string, unknown>>,
  dockerfile_idx: () => import("./languages/dockerfile_idx.js") as Promise<Record<string, unknown>>,
  css_idx: () => import("./languages/css_idx.js") as Promise<Record<string, unknown>>,
  sql_idx: () => import("./languages/sql_idx.js") as Promise<Record<string, unknown>>,
  graphql_idx: () => import("./languages/graphql_idx.js") as Promise<Record<string, unknown>>,
  proto_idx: () => import("./languages/proto_idx.js") as Promise<Record<string, unknown>>,
  makefile_idx: () => import("./languages/makefile_idx.js") as Promise<Record<string, unknown>>,
};

function _language_importer(
  module_name: string,
  attr: string = "extract",
): () => Promise<Extractor> {
  return async (): Promise<Extractor> => {
    // The adapters live in ./languages/<module>.js. A missing loader (a
    // not-yet-ported grammar adapter) throws an ImportError-like error,
    // propagated to get_extractor's catch, which degrades to null exactly like
    // Python's ImportError branch.
    const loader = _LANG_MODULE_LOADERS[module_name];
    let mod: Record<string, unknown>;
    try {
      if (loader === undefined) {
        throw new Error(`no loader registered (module not ported)`);
      }
      mod = await loader();
    } catch (err) {
      // Re-shape as an ImportError-like Error so get_extractor's handler logs
      // the "missing grammar binary?" message and returns null.
      throw new _ImportError(
        `_language_importer: cannot import languages/${module_name}: ${_errMsg(err)}`,
        { cause: err },
      );
    }
    const fn = mod[attr];
    if (typeof fn !== "function") {
      throw new _ImportError(
        `_language_importer: languages/${module_name} has no callable export "${attr}"`,
      );
    }
    return fn as Extractor;
  };
}

/**
 * Like {@link _language_importer} but for GRAMMAR adapters: those modules expose
 * `export async function getExtractor(): Promise<Extractor>` (web-tree-sitter
 * must init/load the grammar asynchronously first), not a sync `extract`. This
 * factory imports the module, awaits getExtractor(), and returns the resolved
 * sync Extractor. A missing module (9 of the 10 are not written yet) or a
 * getExtractor() that throws (e.g. wasm load failure) surfaces as an
 * ImportError-like Error so get_extractor degrades to null — identical fail-soft
 * to the flat loaders, and to Python's ImportError branch when the grammar
 * binary is absent.
 *
 * @param module_name submodule under languages/ (e.g. "python", "typescript").
 */
function _grammar_importer(module_name: string): () => Promise<Extractor> {
  return async (): Promise<Extractor> => {
    const loader = _LANG_MODULE_LOADERS[module_name];
    let mod: Record<string, unknown>;
    try {
      if (loader === undefined) {
        throw new Error(`no loader registered (grammar module not ported)`);
      }
      mod = await loader();
    } catch (err) {
      throw new _ImportError(
        `_grammar_importer: cannot import languages/${module_name}: ${_errMsg(err)}`,
        { cause: err },
      );
    }
    const factory = mod["getExtractor"];
    if (typeof factory !== "function") {
      throw new _ImportError(
        `_grammar_importer: languages/${module_name} has no async getExtractor()`,
      );
    }
    try {
      // getExtractor() awaits Parser.init() + the grammar load, then returns the
      // sync Extractor. A wasm load failure rejects here -> ImportError -> null.
      return (await (factory as () => Promise<Extractor>)()) as Extractor;
    } catch (err) {
      throw new _ImportError(
        `_grammar_importer: languages/${module_name}.getExtractor() failed: ${_errMsg(err)}`,
        { cause: err },
      );
    }
  };
}

/**
 * ImportError analogue. Python distinguishes `ImportError` (missing module /
 * grammar binary) from other exceptions in get_extractor; this lets the TS
 * handler reproduce that two-branch log without sniffing message strings.
 */
class _ImportError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "ImportError";
  }
}

function _errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Registry: language key -> zero-arg async factory that imports and returns the
 * extractor. javascript reuses the typescript extractor (same grammar/rules).
 */
const _EXTRACTOR_REGISTRY: Map<string, () => Promise<Extractor>> = new Map<
  string,
  () => Promise<Extractor>
>([
  // GRAMMAR languages -> web-tree-sitter adapters via _grammar_importer (async
  // getExtractor factory). javascript reuses the typescript grammar adapter; c
  // reuses the cpp grammar adapter. Only python.ts exists this run — the other
  // 9 import-reject and degrade to null, leaving the registry tsc-clean.
  ["typescript", _grammar_importer("typescript")],
  ["javascript", _grammar_importer("typescript")],
  ["python", _grammar_importer("python")],
  ["go", _grammar_importer("go")],
  ["rust", _grammar_importer("rust")],
  ["java", _grammar_importer("java")],
  ["kotlin", _grammar_importer("kotlin")],
  ["csharp", _grammar_importer("csharp")],
  ["cpp", _grammar_importer("cpp")],
  ["c", _grammar_importer("cpp")],
  ["ruby", _grammar_importer("ruby")],
  ["php", _grammar_importer("php")],
  ["liquid", _language_importer("liquid")],
  ["markdown", _language_importer("markdown")],
  ["html", _language_importer("html")],
  ["json", _language_importer("json_idx")],
  ["toml", _language_importer("toml_idx")],
  ["yaml", _language_importer("yaml_idx")],
  ["ini", _language_importer("ini_idx")],
  ["env", _language_importer("ini_idx", "extract_env")],
  ["env_file", _language_importer("env_idx")],
  ["dockerfile", _language_importer("dockerfile_idx")],
  ["css", _language_importer("css_idx")],
  ["sql", _language_importer("sql_idx")],
  ["graphql", _language_importer("graphql_idx")],
  ["proto", _language_importer("proto_idx")],
  ["makefile", _language_importer("makefile_idx")],
]);

/** Cache resolved extractors so each language module is imported at most once. */
const _EXTRACTOR_CACHE: Map<string, Extractor> = new Map();

// ---------------------------------------------------------------------------
// Extraction-result LRU cache (in-memory, per-process)
// ---------------------------------------------------------------------------
// Caches the [symbols, refs, imports_exports, sections] tuple by content-SHA so
// a second extract() with the same bytes skips tree-sitter entirely. 256
// entries is generous; total memory ceiling is well under 1 MB. No thread lock:
// Node is single-threaded for this code path (Python's Lock guarded a
// ThreadPoolExecutor that has no TS analogue here).

const _RESULT_CACHE_MAX = 256;
type _ResultTuple = [Symbol[], Ref[], ImpExp[], Section[]];

/**
 * JS Map preserves insertion order, so it doubles as an LRU: re-inserting a key
 * (delete + set) moves it to the end (Python's OrderedDict.move_to_end), and
 * the first key from keys() is the oldest (popitem(last=False)).
 */
const _RESULT_CACHE: Map<string, _ResultTuple> = new Map();
const _RESULT_CACHE_STATS: { hits: number; misses: number; evictions: number } = {
  hits: 0,
  misses: 0,
  evictions: 0,
};

function _resultCacheKey(language: string, sha: string): string {
  // A single string key with a NUL separator avoids tuple-key hashing; NUL
  // cannot appear in a language name or a hex sha, so the join is unambiguous.
  return `${language}\u0000${sha}`;
}

/**
 * Return the cached extraction tuple for (language, sha), or null.
 *
 * On hit, the entry is moved to the end of the LRU. Returns shallow copies of
 * the symbol/ref/imp/section lists so callers cannot mutate the cached payload.
 */
function _result_cache_get(language: string, sha: string): _ResultTuple | null {
  const key = _resultCacheKey(language, sha);
  const hit = _RESULT_CACHE.get(key);
  if (hit === undefined) {
    _RESULT_CACHE_STATS.misses += 1;
    return null;
  }
  // move_to_end: delete + re-set keeps insertion-order LRU semantics.
  _RESULT_CACHE.delete(key);
  _RESULT_CACHE.set(key, hit);
  _RESULT_CACHE_STATS.hits += 1;
  const [symbols, refs, imp_exp, sections] = hit;
  return [symbols.slice(), refs.slice(), imp_exp.slice(), sections.slice()];
}

/**
 * Store `payload` under (language, sha); evicts oldest entry on overflow.
 *
 * Stores defensive copies of each list so that callers who mutate the lists
 * returned via FileIndex do not corrupt the cached payload.
 */
function _result_cache_put(
  language: string,
  sha: string,
  payload: _ResultTuple,
): void {
  const [symbols, refs, imp_exp, sections] = payload;
  const key = _resultCacheKey(language, sha);
  // Re-set moves an existing key to the end (LRU), and inserts a new one there.
  _RESULT_CACHE.delete(key);
  _RESULT_CACHE.set(key, [symbols.slice(), refs.slice(), imp_exp.slice(), sections.slice()]);
  while (_RESULT_CACHE.size > _RESULT_CACHE_MAX) {
    // popitem(last=False): the first key in iteration order is the oldest.
    const oldest = _RESULT_CACHE.keys().next().value as string | undefined;
    if (oldest === undefined) {
      break;
    }
    _RESULT_CACHE.delete(oldest);
    _RESULT_CACHE_STATS.evictions += 1;
  }
}

/** Return a snapshot of {hits, misses, evictions, size} for the result LRU. */
export function parser_cache_stats(): {
  hits: number;
  misses: number;
  evictions: number;
  size: number;
} {
  return {
    hits: _RESULT_CACHE_STATS.hits,
    misses: _RESULT_CACHE_STATS.misses,
    evictions: _RESULT_CACHE_STATS.evictions,
    size: _RESULT_CACHE.size,
  };
}

/** Reset the result LRU and its counters (test helper, also safe at runtime). */
export function parser_cache_clear(): void {
  _RESULT_CACHE.clear();
  _RESULT_CACHE_STATS.hits = 0;
  _RESULT_CACHE_STATS.misses = 0;
  _RESULT_CACHE_STATS.evictions = 0;
}

// Register the result LRU + extractor cache reset so clearModuleCaches() (every
// test's beforeEach) wipes them back to a freshly-imported state. Python tests
// call parser_cache_clear() explicitly; this makes the TS suite's blanket
// cache-wipe cover the parser too. The extractor cache is also cleared so a
// test that registers a custom extractor does not leak into the next test.
registerReset(() => {
  parser_cache_clear();
  _EXTRACTOR_CACHE.clear();
});

// Test-only re-exports of the private cache helpers, so the parser test (and
// reset.ts wiring) can drive the LRU directly the way the Python tests reach
// _result_cache_get / _result_cache_put. Underscored to mark them internal.
export { _result_cache_get, _result_cache_put };

// ===========================================================================
// get_extractor / register_extractor
// ===========================================================================

/**
 * Return the extractor for `language`, or null if unsupported / unavailable.
 *
 * Imports the language module lazily on first call (fail-soft: a missing
 * adapter or absent tree-sitter runtime degrades to null); subsequent calls
 * return the cached extractor without re-importing.
 *
 * Async because the underlying adapter import is dynamic. Python was sync
 * (importlib is sync); the observable behaviour — null for grammar languages
 * when tree-sitter is absent — is identical.
 */
export async function get_extractor(language: string): Promise<Extractor | null> {
  const cached = _EXTRACTOR_CACHE.get(language);
  if (cached !== undefined) {
    return cached;
  }
  const factory = _EXTRACTOR_REGISTRY.get(language);
  if (factory === undefined) {
    return null;
  }
  const t0 = Date.now();
  let extractor: Extractor;
  try {
    extractor = await factory();
  } catch (exc) {
    if (exc instanceof _ImportError) {
      _LOG.error(
        "get_extractor: failed to import %s language module (missing grammar binary?): %s",
        language,
        _errMsg(exc),
      );
      return null;
    }
    _LOG.error(
      "get_extractor: unexpected error loading %s extractor (%s): %s",
      language,
      exc instanceof Error ? exc.constructor.name : typeof exc,
      _errMsg(exc),
    );
    return null;
  }
  const elapsed = (Date.now() - t0) / 1000;
  _LOG.debug("extractor loaded: language=%s elapsed=%ss", language, elapsed.toFixed(3));
  _EXTRACTOR_CACHE.set(language, extractor);
  return extractor;
}

/**
 * Register a custom extractor factory for `language`.
 *
 * Clears any cached extractor for that language so the new factory takes effect
 * on the next call to get_extractor(). Useful for plugins and tests. The
 * factory may be sync (returning an Extractor) or async (returning a Promise);
 * get_extractor awaits it either way.
 */
export function register_extractor(
  language: string,
  factory: () => Extractor | Promise<Extractor>,
): void {
  _EXTRACTOR_REGISTRY.set(language, async () => factory());
  _EXTRACTOR_CACHE.delete(language);
}

// ===========================================================================
// File walk
// ===========================================================================

/**
 * Options for {@link iter_source_files}.
 */
export interface IterSourceFilesOptions {
  /** Files larger than this many bytes are skipped entirely (default MAX_FILE_SIZE). */
  skip_threshold?: number;
  /** When set, only yield files whose lowercased suffix is in this set. */
  ext_filter?: ReadonlySet<string> | null;
  /** Additional directory basenames to skip, merged with SKIP_DIRS. */
  extra_skip_dirs?: ReadonlySet<string>;
}

/**
 * Yield absolute paths of indexable source files under the project root.
 *
 * Symlinks are not followed during the directory walk. Individual file symlinks
 * that resolve outside the project root are skipped (data-leak + correctness
 * guard). Returns an array (Python returned a lazy generator; every TS caller
 * materialises the list, so eager is faithful to usage).
 *
 * @param project Project whose root to walk.
 */
export function iter_source_files(
  project: Project,
  options: IterSourceFilesOptions = {},
): string[] {
  const skip_threshold = options.skip_threshold ?? MAX_FILE_SIZE;
  const ext_filter = options.ext_filter ?? null;
  const extra_skip_dirs = options.extra_skip_dirs ?? new Set<string>();

  const root = project.root;
  let resolved_root: string;
  try {
    resolved_root = fs.realpathSync(root);
  } catch {
    // If the root itself cannot be resolved, treat it as its literal path; the
    // walk below will simply yield nothing (readdir throws -> caught).
    resolved_root = root;
  }
  const _effective_skip_dirs: ReadonlySet<string> =
    extra_skip_dirs.size > 0
      ? new Set<string>([...SKIP_DIRS, ...extra_skip_dirs])
      : SKIP_DIRS;

  let skipped_dirs = 0;
  let skipped_symlinks = 0;
  let skipped_oversized = 0;
  let skipped_generated = 0;
  const out: string[] = [];

  // Iterative os.walk equivalent: a manual stack so we never follow symlink
  // directories (readdir withFileTypes + isDirectory() on the dirent, which does
  // not follow the link). Directory order: os.walk yields top-down; we push
  // children and process via a stack. The within-directory file order matches
  // readdirSync order (os.scandir order on the same FS).
  const stack: string[] = [root];
  while (stack.length > 0) {
    const dirpath = stack.pop() as string;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dirpath, { withFileTypes: true });
    } catch {
      // Permission / vanished dir: os.walk silently skips unreadable dirs.
      continue;
    }
    const subdirs: string[] = [];
    const files: string[] = [];
    for (const entry of entries) {
      // isDirectory() on the dirent does not follow symlinks (matches os.walk's
      // default of not descending into symlinked dirs).
      if (entry.isDirectory()) {
        subdirs.push(entry.name);
      } else {
        files.push(entry.name);
      }
    }
    const kept_subdirs = subdirs.filter((d) => !_effective_skip_dirs.has(d));
    skipped_dirs += subdirs.length - kept_subdirs.length;
    // Push kept subdirs so they are walked (order is not load-bearing for the
    // returned set, only for determinism of progress logging; we push in
    // reverse so the stack pops them in directory order).
    for (let i = kept_subdirs.length - 1; i >= 0; i--) {
      stack.push(path.join(dirpath, kept_subdirs[i] as string));
    }

    for (const name of files) {
      if (_effective_skip_dirs.has(name)) {
        continue;
      }
      // Skip generated/lockfile artifacts before the extension check.
      if (_is_generated_filename(name)) {
        skipped_generated += 1;
        continue;
      }
      const filePath = path.join(dirpath, name);
      const name_lower = name.toLowerCase();
      if (!_KNOWN_BASENAMES.has(name_lower)) {
        const suffix = _suffixOf(name);
        if (!_KNOWN_EXTENSIONS.has(suffix) && !_KNOWN_EXTENSIONS.has(suffix.toLowerCase())) {
          continue;
        }
        // Optional extension filter (e.g. --ext py).
        if (ext_filter !== null && !ext_filter.has(suffix.toLowerCase())) {
          continue;
        }
      }
      // Reject symlinks whose resolved target escapes the project root.
      let isSymlink = false;
      try {
        isSymlink = fs.lstatSync(filePath).isSymbolicLink();
      } catch {
        // stat failed -> treat as a regular file path; the stat() below will
        // re-attempt and skip on error.
        isSymlink = false;
      }
      if (isSymlink) {
        try {
          const resolved = fs.realpathSync(filePath);
          if (resolved !== resolved_root && !resolved.startsWith(resolved_root + path.sep)) {
            skipped_symlinks += 1;
            _LOG.debug(
              "iter_source_files: skipping symlink outside project root: %s",
              filePath,
            );
            continue;
          }
        } catch {
          skipped_symlinks += 1;
          _LOG.debug(
            "iter_source_files: skipping symlink outside project root: %s",
            filePath,
          );
          continue;
        }
      }
      let file_size: number;
      try {
        file_size = fs.statSync(filePath).size;
      } catch {
        continue;
      }
      if (file_size > skip_threshold) {
        _LOG.debug(
          "iter_source_files: skipping oversized file %s (%d bytes > %d limit)",
          name,
          file_size,
          skip_threshold,
        );
        skipped_oversized += 1;
        continue;
      }
      out.push(filePath);
    }
  }

  if (skipped_dirs > 0) {
    _LOG.debug("file walk excluded %d skip-listed directories", skipped_dirs);
  }
  if (skipped_symlinks > 0) {
    _LOG.debug("file walk skipped %d symlinks pointing outside project root", skipped_symlinks);
  }
  if (skipped_oversized > 0) {
    _LOG.info("file walk skipped %d oversized files (> %d bytes)", skipped_oversized, skip_threshold);
  }
  if (skipped_generated > 0) {
    _LOG.debug("file walk skipped %d generated/lockfile artifacts", skipped_generated);
  }
  return out;
}

/**
 * Return the final extension of a basename, including the leading dot, matching
 * Python's `Path.suffix` semantics:
 *   - "foo.tar.gz" -> ".gz"
 *   - "foo" -> ""
 *   - ".env" -> "" (a leading-dot-only name has no suffix in pathlib)
 *   - "foo." -> "" (pathlib returns "" for a trailing dot)
 */
function _suffixOf(name: string): string {
  const dot = name.lastIndexOf(".");
  // No dot, or dot is the first char (dotfile like ".env"), or trailing dot.
  if (dot <= 0 || dot === name.length - 1) {
    return "";
  }
  return name.slice(dot);
}

/** Return the exact number of newline-delimited lines in `raw` (byte buffer). */
function _line_count_from_bytes(raw: Buffer): number {
  if (raw.length === 0) {
    return 0;
  }
  let count = 0;
  for (let i = 0; i < raw.length; i++) {
    if (raw[i] === 0x0a) {
      count += 1;
    }
  }
  // Python: raw.count(b"\n") + (0 if raw.endswith(b"\n") else 1)
  return count + (raw[raw.length - 1] === 0x0a ? 0 : 1);
}

// ===========================================================================
// index_file
// ===========================================================================

/** Options for {@link index_file}. */
export interface IndexFileOptions {
  /**
   * When > 0 and the file is larger than this many bytes, the returned
   * FileIndex.symbol_only is set to true. Default 0 disables the threshold.
   */
  symbol_only_threshold?: number;
}

/**
 * A synchronous extractor resolver: language -> Extractor | null. Used by the
 * synchronous index_file core so the whole index_project per-file loop can run
 * inside the (synchronous) better-sqlite3 connection callback. index_project
 * pre-resolves every needed extractor via get_extractor (the only async step)
 * before opening the connection, then hands the loop a resolver that reads the
 * pre-built map. The public async index_file builds a one-shot resolver around
 * get_extractor.
 */
export type ExtractorResolver = (language: string) => Extractor | null;

/**
 * Index a single file: read, detect language, dispatch to language extractor,
 * return FileIndex. Returns null if the file cannot be read, language is
 * unsupported, or the extractor crashes. Does not write to DB.
 *
 * Async because get_extractor is async (dynamic adapter import). Delegates to
 * the synchronous core once the extractor is resolved.
 *
 * @param project   Project containing the file.
 * @param file_path Absolute path to the file.
 */
export async function index_file(
  project: Project,
  file_path: string,
  options: IndexFileOptions = {},
): Promise<FileIndex | null> {
  // Resolve the (at most one) extractor this file needs up front so the core is
  // synchronous. Detect the language exactly as the core does so we ask
  // get_extractor for the right key; the core re-detects but uses the cached
  // map entry, so there is no double dynamic import.
  const basename_lower = path.basename(file_path).toLowerCase();
  const suffix_lower = _suffixOf(path.basename(file_path)).toLowerCase();
  const language = LANG_BY_BASENAME[basename_lower] ?? LANG_BY_EXT[suffix_lower] ?? null;
  const resolved: Map<string, Extractor | null> = new Map();
  if (language !== null) {
    resolved.set(language, await get_extractor(language));
  }
  const resolver: ExtractorResolver = (lang) => resolved.get(lang) ?? null;
  return _index_file_sync(project, file_path, options, resolver);
}

/**
 * Synchronous core of index_file. Identical logic to the Python index_file,
 * except the extractor is looked up through the supplied synchronous
 * `resolveExtractor` (Python called get_extractor inline, which was sync there).
 */
function _index_file_sync(
  project: Project,
  file_path: string,
  options: IndexFileOptions,
  resolveExtractor: ExtractorResolver,
): FileIndex | null {
  const symbol_only_threshold = options.symbol_only_threshold ?? 0;
  const t0 = Date.now();

  let pre_mtime: number | null;
  try {
    pre_mtime = fs.statSync(file_path).mtimeMs / 1000;
  } catch {
    pre_mtime = null;
  }

  let raw: Buffer;
  try {
    raw = fs.readFileSync(file_path);
  } catch (e) {
    _LOG.warning("read failed: %s: %s", file_path, _errMsg(e));
    return null;
  }

  const rel = _relPosix(project.root, file_path);
  if (rel === null) {
    _LOG.warning(
      "index_file: path not under project root (skipping): %s",
      file_path,
    );
    return null;
  }

  const suffix_lower = _suffixOf(path.basename(file_path)).toLowerCase();
  const basename_lower = path.basename(file_path).toLowerCase();
  // Basename match wins over suffix match: `.env` has an empty suffix but a
  // meaningful basename.
  const language =
    LANG_BY_BASENAME[basename_lower] ?? LANG_BY_EXT[suffix_lower] ?? null;
  if (language === null) {
    _LOG.debug(
      "index_file: unsupported file %s (basename=%s suffix=%s) for %s (skipping)",
      basename_lower,
      basename_lower,
      suffix_lower,
      rel,
    );
    return null;
  }

  const line_count = _line_count_from_bytes(raw);
  // Compute SHA up front so we can consult the in-memory extraction cache before
  // paying the tree-sitter parse cost.
  const content_sha = crypto.createHash("sha256").update(raw).digest("hex");

  let symbols: Symbol[];
  let refs: Ref[];
  let imp_exp: ImpExp[];
  let sections: Section[];

  const cached = _result_cache_get(language, content_sha);
  if (cached !== null) {
    [symbols, refs, imp_exp, sections] = cached;
    _LOG.debug("index_file: result-cache hit for %s (lang=%s)", rel, language);
  } else {
    const extractor = resolveExtractor(language);
    if (extractor === null) {
      _LOG.debug("no extractor for %s (%s)", rel, language);
      return null;
    }
    try {
      [symbols, refs, imp_exp, sections] = extractor(raw, rel);
    } catch (exc) {
      _LOG.error("extractor crashed on %s: %s", rel, _errMsg(exc));
      return null;
    }
    // Only cache successful extracts; failed parses must re-run so a future
    // grammar fix is picked up without manual cache invalidation.
    _result_cache_put(language, content_sha, [symbols, refs, imp_exp, sections]);
  }

  if (
    symbols.length === 0 &&
    !["markdown", "html", "json", "css", "sql"].includes(language)
  ) {
    _LOG.debug(
      "index_file: 0 symbols extracted from %s (language=%s, %d bytes) — parser may not cover this file's constructs",
      rel,
      language,
      raw.length,
    );
  }

  let stat: fs.Stats;
  try {
    stat = fs.statSync(file_path);
  } catch (e) {
    _LOG.warning("stat failed after reading: %s: %s", file_path, _errMsg(e));
    return null;
  }
  const post_mtime = stat.mtimeMs / 1000;

  if (pre_mtime !== null && post_mtime !== pre_mtime) {
    _LOG.debug(
      "index_file: mtime changed during read (pre=%s post=%s) — skipping %s (will retry on next write)",
      pre_mtime.toFixed(6),
      post_mtime.toFixed(6),
      rel,
    );
    return null;
  }

  const elapsed = (Date.now() - t0) / 1000;
  _LOG.debug(
    "indexed %s: symbols=%d refs=%d imports=%d sections=%d size=%d elapsed=%ss",
    rel,
    symbols.length,
    refs.length,
    imp_exp.length,
    sections.length,
    stat.size,
    elapsed.toFixed(3),
  );

  const is_symbol_only =
    symbol_only_threshold > 0 && stat.size > symbol_only_threshold;
  if (is_symbol_only) {
    _LOG.debug(
      "index_file: symbol-only mode for %s (%d bytes > %d symbol_only_threshold)",
      rel,
      stat.size,
      symbol_only_threshold,
    );
  }

  return new FileIndex({
    rel_path: rel,
    language,
    size: stat.size,
    line_count,
    mtime: post_mtime,
    content_sha256: content_sha,
    symbols,
    refs,
    imports_exports: imp_exp,
    sections,
    symbol_only: is_symbol_only,
  });
}

// ===========================================================================
// write_file_index
// ===========================================================================

/** Insert or replace a single key/value row in the project meta table. */
function _upsert_meta(conn: DatabaseType, key: string, value: string): void {
  conn
    .prepare("INSERT OR REPLACE INTO meta(key, value) VALUES (?, ?)")
    .run(key, value);
}

/**
 * Replace all indexed rows for `fi.rel_path` with fresh data from `fi`.
 *
 * DELETE + INSERT strategy. The files table DELETE cascades to all child tables
 * via ON DELETE CASCADE. Malformed rows (empty name/kind, null target) are
 * filtered at insert time. Wrapped in an explicit transaction (BEGIN/COMMIT)
 * because better-sqlite3 connections are autocommit; a best-effort ROLLBACK on
 * error mirrors the Python read-only-sandbox fallback.
 */
export function write_file_index(conn: DatabaseType, fi: FileIndex): void {
  const t0 = Date.now();
  const now = Math.floor(t0 / 1000);
  let in_txn = false;
  try {
    conn.exec("BEGIN");
    in_txn = true;
  } catch (e) {
    _LOG.debug("write_file_index: BEGIN skipped (%s); using autocommit", _errMsg(e));
  }
  try {
    // Delete old rows (cascade handles symbols/refs/imports_exports/sections).
    conn.prepare("DELETE FROM files WHERE rel_path = ?").run(fi.rel_path);
    conn
      .prepare(
        "INSERT INTO files (rel_path, language, size, line_count, mtime, content_sha256, indexed_at) " +
          "VALUES (?, ?, ?, ?, ?, ?, ?)",
      )
      .run(
        fi.rel_path,
        fi.language,
        fi.size,
        fi.line_count,
        fi.mtime,
        fi.content_sha256,
        now,
      );

    // Batch insert symbols (filter malformed rows, apply per-file cap).
    if (fi.symbols.length > 0) {
      let valid_syms = fi.symbols.filter((sym) => sym.name && sym.kind);
      if (valid_syms.length > MAX_SYMBOLS_PER_FILE) {
        _LOG.warning(
          "write_file_index: %s produced %d symbols (cap=%d); truncating to first %d — file may be generated/minified",
          fi.rel_path,
          valid_syms.length,
          MAX_SYMBOLS_PER_FILE,
          MAX_SYMBOLS_PER_FILE,
        );
        valid_syms = valid_syms.slice(0, MAX_SYMBOLS_PER_FILE);
      }
      const stmt = conn.prepare(
        "INSERT INTO symbols (name, kind, file_rel, line, col, end_line, signature, parent_id) " +
          "VALUES (?, ?, ?, ?, ?, ?, ?, NULL)",
      );
      for (const sym of valid_syms) {
        stmt.run(
          sym.name,
          sym.kind,
          fi.rel_path,
          sym.line,
          sym.col,
          sym.end_line,
          sym.signature,
        );
      }
    }

    // Batch insert refs (filter empty names).
    if (fi.refs.length > 0) {
      const stmt = conn.prepare(
        "INSERT INTO refs (symbol_name, file_rel, line, col, context) VALUES (?, ?, ?, ?, ?)",
      );
      for (const ref of fi.refs) {
        if (!ref.name) {
          continue;
        }
        stmt.run(ref.name, fi.rel_path, ref.line, ref.col, ref.context);
      }
    }

    // Batch insert imports/exports (filter invalid rows).
    if (fi.imports_exports.length > 0) {
      const stmt = conn.prepare(
        "INSERT INTO imports_exports (file_rel, kind, target, line) VALUES (?, ?, ?, ?)",
      );
      for (const ie of fi.imports_exports) {
        if (!ie.kind || ie.target === null || ie.target === undefined) {
          continue;
        }
        stmt.run(fi.rel_path, ie.kind, ie.target, ie.line);
      }
    }

    // Batch insert sections (filter empty headings).
    if (fi.sections.length > 0) {
      const stmt = conn.prepare(
        "INSERT INTO sections (file_rel, heading, level, line, end_line) VALUES (?, ?, ?, ?, ?)",
      );
      for (const sec of fi.sections) {
        if (!sec.heading) {
          continue;
        }
        stmt.run(fi.rel_path, sec.heading, sec.level, sec.line, sec.end_line);
      }
    }

    if (in_txn) {
      try {
        conn.exec("COMMIT");
      } catch {
        // suppress(sqlite3.OperationalError)
      }
    }
  } catch (err) {
    if (in_txn) {
      try {
        conn.exec("ROLLBACK");
      } catch {
        // suppress(sqlite3.OperationalError)
      }
    }
    throw err;
  }

  const elapsed = (Date.now() - t0) / 1000;
  if (elapsed >= 0.5) {
    _LOG.warning(
      "write_file_index slow: %s symbols=%d refs=%d sections=%d elapsed=%ss",
      fi.rel_path,
      fi.symbols.length,
      fi.refs.length,
      fi.sections.length,
      elapsed.toFixed(3),
    );
  } else {
    _LOG.debug(
      "write_file_index: %s symbols=%d refs=%d sections=%d elapsed=%ss",
      fi.rel_path,
      fi.symbols.length,
      fi.refs.length,
      fi.sections.length,
      elapsed.toFixed(3),
    );
  }
}

// ===========================================================================
// index_project
// ===========================================================================

/** Options for {@link index_project}. */
export interface IndexProjectOptions {
  /** Full re-index (default true) vs incremental (mtime+SHA skip). */
  full?: boolean;
  /** Progress callback invoked every 100 files: progress(indexedSoFar, total). */
  progress?: ((done: number, total: number) => void) | null;
  /** When true, print each indexed file with its symbol count. */
  verbose?: boolean;
  /** When set, only index files whose lowercased suffix is in this set. */
  ext_filter?: ReadonlySet<string> | null;
}

/** Row shape returned by the project DB files SELECT. */
interface _FilesRow {
  rel_path: string;
  mtime: number;
  content_sha256: string;
}

/**
 * Index all source files in a project: full or incremental scan and persist to
 * DB. Returns IndexProjectResult.
 *
 * Async because index_file is async (dynamic adapter import). The DB
 * connections are opened via the db module's callback openers; index_file is
 * awaited OUTSIDE those callbacks would break the connection lifetime, so the
 * whole per-file loop runs inside the openProject callback and each index_file
 * is awaited there. better-sqlite3's connection object is created once and the
 * callback body is synchronous from the DB's perspective; awaiting a Promise
 * that resolves synchronously (the extractor path is sync, and get_extractor is
 * effectively sync after the first import) keeps the connection valid for the
 * loop duration.
 */
export async function index_project(
  project: Project,
  options: IndexProjectOptions = {},
): Promise<IndexProjectResult> {
  const full = options.full ?? true;
  const progress = options.progress ?? null;
  const verbose = options.verbose ?? false;
  const ext_filter = options.ext_filter ?? null;

  _LOG.info(
    "index_project started: mode=%s path=%s",
    full ? "full" : "incremental",
    project.root,
  );

  // Load configurable large-file thresholds. Fail soft: fall back to hardcoded
  // defaults if config is unavailable.
  let _extra_skip_dirs: ReadonlySet<string> = new Set<string>();
  let _skip_threshold: number;
  let _symbol_only_threshold: number;
  try {
    const _config = await import("./config.js");
    const _idx_cfg = _config.load().indexing ?? {};
    _skip_threshold = (_idx_cfg.large_file_skip_kb ?? 2048) * 1024;
    _symbol_only_threshold = (_idx_cfg.large_file_symbol_only_kb ?? 500) * 1024;
    _extra_skip_dirs = new Set<string>(_idx_cfg.skip_dirs ?? []);
  } catch {
    _skip_threshold = MAX_FILE_SIZE;
    _symbol_only_threshold = 0;
  }

  // Register the project in the global registry up front, before the file walk.
  db.openGlobal((gconn: DatabaseType): void => {
    const nowSec = Math.floor(Date.now() / 1000);
    gconn
      .prepare(
        "INSERT INTO projects(hash, root, marker, first_seen, last_seen, file_count, languages) " +
          "VALUES (?, ?, ?, ?, ?, 0, '') " +
          "ON CONFLICT(hash) DO UPDATE SET last_seen=excluded.last_seen, marker=excluded.marker",
      )
      .run(project.hash, _asPosix(project.root), project.marker, nowSec, nowSec);
  });

  // Collect files that exceed the skip threshold so they appear in the
  // large-file report even though iter_source_files dropped them.
  const _skipped_large: LargeFileInfo[] = [];
  if (_skip_threshold < MAX_FILE_SIZE * 100) {
    try {
      const bigList = self.iter_source_files(project, {
        skip_threshold: MAX_FILE_SIZE * 100,
        extra_skip_dirs: _extra_skip_dirs,
      });
      for (const _lp of bigList) {
        let _lp_size: number;
        try {
          _lp_size = fs.statSync(_lp).size;
        } catch {
          continue;
        }
        if (_lp_size > _skip_threshold) {
          const _lp_rel = _relPosix(project.root, _lp);
          if (_lp_rel === null) {
            continue;
          }
          _skipped_large.push({
            rel_path: _lp_rel,
            size_bytes: _lp_size,
            reason: "skipped",
          });
          _LOG.warning(
            "index_project: skipping large file %s (%d bytes > %d skip threshold)",
            _lp_rel,
            _lp_size,
            _skip_threshold,
          );
        }
      }
    } catch {
      // fail-soft: large-file scanning must never abort indexing.
    }
  }

  const files = self.iter_source_files(project, {
    skip_threshold: _skip_threshold,
    ext_filter,
    extra_skip_dirs: _extra_skip_dirs,
  });
  const n_total = files.length;
  if (n_total === 0) {
    _LOG.debug(
      "index_project: no source files found under %s — check project root and SKIP_DIRS",
      project.root,
    );
  }
  _LOG.debug(
    "index walk: found %d source files (mode=%s)",
    n_total,
    full ? "full" : "incremental",
  );

  let n_indexed = 0;
  let n_skipped_unchanged = 0;
  let n_errors = 0;
  let n_symbols = 0;
  const languages: Set<string> = new Set();
  const ext_counts: Record<string, number> = {};
  const on_disk: Set<string> = new Set();
  const large_files: LargeFileInfo[] = [];
  const t0 = Date.now();

  // Pre-resolve every extractor the candidate files might need BEFORE opening
  // the (synchronous) DB connection. get_extractor is the only async step
  // (dynamic adapter import); resolving it up front lets the entire per-file
  // loop run synchronously inside the better-sqlite3 callback, so the
  // connection is never closed out from under an awaited Promise. In this run
  // (no tree-sitter, no adapters) every resolution is null, which is exactly
  // the Python "no language pack" degradation — grammar files are skipped.
  const _resolved_extractors: Map<string, Extractor | null> = new Map();
  for (const fp of files) {
    const bn = path.basename(fp).toLowerCase();
    const sx = _suffixOf(path.basename(fp)).toLowerCase();
    const lang = LANG_BY_BASENAME[bn] ?? LANG_BY_EXT[sx] ?? null;
    if (lang !== null && !_resolved_extractors.has(lang)) {
      _resolved_extractors.set(lang, await get_extractor(lang));
    }
  }
  const _resolver: ExtractorResolver = (lang) => _resolved_extractors.get(lang) ?? null;

  db.projectWriterLock(
    project.hash,
    () => {
      db.openProject(project.hash, (conn: DatabaseType): void => {
        // For incremental: pre-load existing mtimes + SHAs.
        let existing_sha: Map<string, string> | null = null;
        let existing_mtime: Map<string, number> | null = null;
        if (!full) {
          existing_sha = new Map();
          existing_mtime = new Map();
          const rows = conn
            .prepare("SELECT rel_path, mtime, content_sha256 FROM files")
            .all() as _FilesRow[];
          for (const row of rows) {
            existing_sha.set(row.rel_path, row.content_sha256);
            existing_mtime.set(row.rel_path, row.mtime);
          }
          _LOG.debug(
            "incremental mode: loaded %d cached mtimes+hashes",
            existing_sha.size,
          );
        }

        for (let i = 0; i < files.length; i++) {
          const fp = files[i] as string;
          const rel = _relPosix(project.root, fp);
          if (rel === null) {
            // Path moved out from under us between walk and loop; skip.
            continue;
          }
          on_disk.add(rel);

          // Two-layer incremental check (mtime fast-path, SHA fallback).
          if (existing_mtime !== null && existing_mtime.has(rel)) {
            try {
              const st_mtime = fs.statSync(fp).mtimeMs / 1000;
              if (st_mtime === existing_mtime.get(rel)) {
                n_skipped_unchanged += 1;
                _LOG.debug("skipped unchanged (mtime): %s", rel);
                if (progress && (i + 1) % 100 === 0) {
                  progress(i + 1, n_total);
                }
                continue;
              }
            } catch (e) {
              _LOG.debug(
                "mtime check failed for %s (will reindex): %s",
                rel,
                _errMsg(e),
              );
            }
          }

          const fi = _index_file_sync(
            project,
            fp,
            { symbol_only_threshold: _symbol_only_threshold },
            _resolver,
          );
          if (fi === null) {
            n_errors += 1;
          } else {
            // SHA check guards against same-mtime content changes.
            const sha_unchanged =
              existing_sha !== null &&
              existing_sha.get(fi.rel_path) === fi.content_sha256;
            if (sha_unchanged) {
              n_skipped_unchanged += 1;
              _LOG.debug("skipped unchanged (sha): %s", fi.rel_path);
            } else {
              write_file_index(conn, fi);
              n_indexed += 1;
              n_symbols += fi.symbols.length;
              languages.add(fi.language);
              const _ext = _suffixOf(path.basename(fp)).toLowerCase() || path.basename(fp).toLowerCase();
              ext_counts[_ext] = (ext_counts[_ext] ?? 0) + 1;
              if (verbose) {
                const sym_word = fi.symbols.length === 1 ? "symbol" : "symbols";
                process.stdout.write(
                  `indexed: ${fi.rel_path} (${fi.symbols.length} ${sym_word})\n`,
                );
              }
              if (existing_sha !== null) {
                _LOG.debug("updated changed file: %s", fi.rel_path);
              }
            }
            // Track symbol-only files regardless of whether they changed.
            if (fi.symbol_only) {
              large_files.push({
                rel_path: fi.rel_path,
                size_bytes: fi.size,
                reason: "symbol_only",
              });
            }
          }
          if (progress && (i + 1) % 100 === 0) {
            progress(i + 1, n_total);
          }
        }

        // Prune index entries for files that no longer exist on disk.
        let db_rel_paths: Set<string>;
        if (existing_sha !== null) {
          db_rel_paths = new Set(existing_sha.keys());
        } else {
          const rows = conn.prepare("SELECT rel_path FROM files").all() as {
            rel_path: string;
          }[];
          db_rel_paths = new Set(rows.map((r) => r.rel_path));
        }
        const stale: string[] = [];
        for (const p of db_rel_paths) {
          if (!on_disk.has(p)) {
            stale.push(p);
          }
        }
        if (stale.length > 0) {
          const ph = stale.map(() => "?").join(",");
          conn.prepare(`DELETE FROM files WHERE rel_path IN (${ph})`).run(...stale);
          _LOG.info(
            "pruned %d deleted file(s) from index: %s",
            stale.length,
            _nsmallest(stale, 5).join(", "),
          );
        }

        // Update project meta.
        _upsert_meta(conn, "last_full_index_at", String(Math.floor(Date.now() / 1000)));
        _upsert_meta(conn, "project_root", _asPosix(project.root));
        _upsert_meta(conn, "project_marker", project.marker);
        _upsert_meta(
          conn,
          "skipped_large_files",
          _jsonDumpsCompact(
            _skipped_large.map((lf) => ({
              rel_path: lf.rel_path,
              size_bytes: lf.size_bytes,
            })),
          ),
        );
      });

      // Update global registry.
      db.openGlobal((gconn: DatabaseType): void => {
        const nowSec = Math.floor(Date.now() / 1000);
        gconn
          .prepare(
            "INSERT INTO projects(hash, root, marker, first_seen, last_seen, file_count, languages) " +
              "VALUES (?, ?, ?, ?, ?, ?, ?) " +
              "ON CONFLICT(hash) DO UPDATE SET last_seen=excluded.last_seen, " +
              "file_count=excluded.file_count, languages=excluded.languages, marker=excluded.marker",
          )
          .run(
            project.hash,
            _asPosix(project.root),
            project.marker,
            nowSec,
            nowSec,
            n_total,
            [...languages].sort().join(","),
          );
        // Refresh global symbols snapshot.
        gconn
          .prepare("DELETE FROM symbols_global WHERE project_hash = ?")
          .run(project.hash);
        const rows = db.openProject(
          project.hash,
          (pconn: DatabaseType): {
            name: string;
            kind: string;
            file_rel: string;
            line: number;
            signature: string | null;
          }[] => {
            return pconn
              .prepare("SELECT name, kind, file_rel, line, signature FROM symbols")
              .all() as {
              name: string;
              kind: string;
              file_rel: string;
              line: number;
              signature: string | null;
            }[];
          },
        );
        const insGlobal = gconn.prepare(
          "INSERT INTO symbols_global(project_hash, name, kind, file_rel, line, signature) " +
            "VALUES (?, ?, ?, ?, ?, ?)",
        );
        for (const r of rows) {
          insGlobal.run(project.hash, r.name, r.kind, r.file_rel, r.line, r.signature);
        }
      });
    },
    { timeoutSec: 30.0 },
  );

  const elapsed = (Date.now() - t0) / 1000;
  // Merge skipped-large (from pre-scan) with symbol-only (collected during indexing).
  const all_large_files = [..._skipped_large, ...large_files];
  const result: IndexProjectResult = {
    total_files: n_total,
    indexed: n_indexed,
    skipped_unchanged: n_skipped_unchanged,
    errors: n_errors,
    languages: [...languages].sort(),
    duration_sec: _round2(elapsed),
    total_symbols: n_symbols,
    large_files: all_large_files,
    ext_counts,
  };

  const files_per_sec = elapsed > 0 ? n_total / elapsed : 0.0;
  _LOG.info(
    "index_project completed: project=%s total_files=%d indexed=%d skipped=%d errors=%d " +
      "large_skipped=%d large_symbol_only=%d languages=%s duration=%ss throughput=%s files/s",
    project.hash.slice(0, 8),
    n_total,
    n_indexed,
    n_skipped_unchanged,
    n_errors,
    all_large_files.filter((lf) => lf.reason === "skipped").length,
    all_large_files.filter((lf) => lf.reason === "symbol_only").length,
    [...languages].sort().join(","),
    elapsed.toFixed(2),
    files_per_sec.toFixed(1),
  );
  return result;
}

// ===========================================================================
// Local helpers (path / json / math parity)
// ===========================================================================

/**
 * Return the POSIX-style path of `child` relative to `root`, or null when
 * `child` is not under `root` (Python's `Path.relative_to` raising ValueError).
 *
 * Both inputs are first normalised; the comparison is purely lexical (it does
 * not resolve symlinks — matching `Path.relative_to`, which is also lexical).
 */
function _relPosix(root: string, child: string): string | null {
  const rootNorm = path.resolve(root);
  const childNorm = path.resolve(child);
  const rel = path.relative(rootNorm, childNorm);
  // path.relative yields a string starting with ".." (or an absolute path on
  // Windows when the drives differ) when child is not under root.
  if (rel === "" ) {
    return ".";
  }
  if (rel.startsWith("..") || path.isAbsolute(rel)) {
    return null;
  }
  return rel.split(path.sep).join("/");
}

/** Convert a filesystem path to POSIX separators (Python's Path.as_posix). */
function _asPosix(p: string): string {
  return p.split(path.sep).join("/");
}

/**
 * `json.dumps(obj, separators=(",", ":"))` for the narrow shape this module
 * serialises (a list of {rel_path: str, size_bytes: int}). JSON.stringify with
 * no spacing already produces the compact `,`/`:` separators; for this
 * all-ASCII-key, string+integer payload it is byte-identical to Python's
 * compact json.dumps (no float `.0` and no non-ASCII escaping concerns arise
 * for these values — rel_paths are POSIX path strings; a non-ASCII char in a
 * path would be emitted verbatim by both since Python here does not pass
 * ensure_ascii, but the default json.dumps DOES escape non-ASCII — see note).
 *
 * NOTE: Python's default json.dumps uses ensure_ascii=True, escaping non-ASCII
 * to \\uXXXX. To match byte-for-byte for paths containing non-ASCII, we
 * post-process the JSON.stringify output to escape any code point >= 0x80,
 * reproducing Python's \\uXXXX (and surrogate-pair) emission.
 */
function _jsonDumpsCompact(obj: unknown): string {
  const raw = JSON.stringify(obj);
  // Escape any non-ASCII to \uXXXX, matching json.dumps ensure_ascii default.
  // JSON.stringify already emits surrogate pairs as two UTF-16 code units, so a
  // simple per-code-unit escape reproduces Python's surrogate-pair \uXXXX\uXXXX.
  let out = "";
  for (let i = 0; i < raw.length; i++) {
    const code = raw.charCodeAt(i);
    if (code >= 0x80) {
      out += "\\u" + code.toString(16).padStart(4, "0");
    } else {
      out += raw[i];
    }
  }
  return out;
}

/**
 * Python `round(x, 2)` — banker's rounding (round-half-to-even) at 2 decimals.
 * JS Math.round is round-half-up and operates on integers, so we scale, apply
 * half-even, and unscale.
 */
function _round2(x: number): number {
  const scaled = x * 100;
  const floor = Math.floor(scaled);
  const diff = scaled - floor;
  let rounded: number;
  if (diff > 0.5) {
    rounded = floor + 1;
  } else if (diff < 0.5) {
    rounded = floor;
  } else {
    // Exactly .5 -> round to even.
    rounded = floor % 2 === 0 ? floor : floor + 1;
  }
  return rounded / 100;
}

/**
 * Return the `n` smallest strings of `items` in ascending order — the analogue
 * of Python's `heapq.nsmallest(n, items)` used only for a log preview. For the
 * tiny n (5) this module uses, a full sort + slice is equivalent and clearer.
 */
function _nsmallest(items: string[], n: number): string[] {
  return [...items].sort().slice(0, n);
}
