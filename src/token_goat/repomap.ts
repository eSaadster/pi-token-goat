/**
 * PageRank-based repo map: token-budgeted overview of a project.
 *
 * 1:1 port of src/token_goat/repomap.py.
 *
 * PageRank is used as the ranking strategy because it captures *architectural
 * centrality*: a file that is imported or referenced by many other files
 * receives a high score, just as a web page linked by many pages does. The
 * damping factor (0.85, networkx default) is the standard Wikipedia-era value.
 *
 * Port model:
 *  - networkx is not available in Node. The two graph types this module uses
 *    (MultiDiGraph for the dependency graph, weighted DiGraph for PageRank
 *    input) are re-implemented below as minimal insertion-ordered classes.
 *    compute_ranks() ports networkx's pure-Python `_pagerank_python` power
 *    iteration + `stochastic_graph` reweighting byte-faithfully (same node /
 *    edge iteration order, same float accumulation order) so ranks match the
 *    Python oracle to well within the 3-decimal precision the output exposes.
 *  - `@lru_cache` on `_is_excluded_path_cached` → a Map-backed memo with a
 *    `.cache_clear()` method (registered with reset.ts for the test harness).
 *  - `db.open_project(hash)` context manager → `db.openProject(hash, body)`.
 *    sqlite3.Row → plain better-sqlite3 row objects. `sqlite3.OperationalError`
 *    (missing/!schema table) → a better-sqlite3 SqliteError whose `.code`
 *    starts with "SQLITE_"; `_isOperationalError` re-raises anything else so
 *    only the graceful-degrade case is swallowed, matching Python.
 *  - `project.root.name` (pathlib basename) → `_pyName(project.root)`.
 *  - `Path(rel).suffix` / `.name`, `str.capitalize()`, `round()` (banker's),
 *    `len(str)` (code points), `str.splitlines()`/`.strip()` are all reproduced
 *    by the small `_py*` helpers below.
 *  - `changed_files_since` is invoked through `self.changed_files_since` so the
 *    test suite can monkeypatch it (vi.spyOn) exactly like Python patch.object.
 */
import * as config from "./config.js";
import * as db from "./db.js";
import type { Project } from "./project.js";
import { registerReset } from "./reset.js";
import { getLogger, runGit } from "./util.js";

import * as self from "./repomap.js";

// ---------------------------------------------------------------------------
// Minimal graph types (networkx replacements)
// ---------------------------------------------------------------------------

/**
 * Raised when the PageRank power iteration fails to converge within max_iter.
 * Analogue of networkx.PowerIterationFailedConvergence.
 */
export class PowerIterationFailedConvergence extends Error {
  num_iterations: number;
  constructor(num_iterations: number) {
    super(`power iteration failed to converge within ${num_iterations} iterations.`);
    this.name = "PowerIterationFailedConvergence";
    this.num_iterations = num_iterations;
  }
}

/**
 * Insertion-ordered directed multigraph (parallel edges collapsed to a count).
 *
 * Only the operations repomap actually performs are implemented. Nodes keep
 * first-insertion order (networkx dict semantics); adjacency keeps first-seen
 * order of distinct successors — the only ordering that flows into PageRank.
 */
export class MultiDiGraph {
  private _nodes: Map<string, true> = new Map();
  // node -> (successor -> parallel-edge count), both insertion-ordered.
  private _adj: Map<string, Map<string, number>> = new Map();

  add_node(n: string): void {
    if (!this._nodes.has(n)) {
      this._nodes.set(n, true);
      this._adj.set(n, new Map());
    }
  }

  add_edge(u: string, v: string): void {
    this.add_node(u);
    this.add_node(v);
    const a = this._adj.get(u)!;
    a.set(v, (a.get(v) ?? 0) + 1);
  }

  nodes(): string[] {
    return [...this._nodes.keys()];
  }

  number_of_nodes(): number {
    return this._nodes.size;
  }

  number_of_edges(): number {
    let total = 0;
    for (const a of this._adj.values()) {
      for (const c of a.values()) total += c;
    }
    return total;
  }

  has_edge(u: string, v: string): boolean {
    return (this._adj.get(u)?.get(v) ?? 0) > 0;
  }

  /**
   * Yield one `[src, dst]` pair per parallel edge, grouped by successor in
   * first-seen order — matching networkx MultiDiGraph.edges enumeration for
   * the purpose of the (src, dst) Counter built in
   * _multigraph_to_weighted_digraph (distinct-pair first-seen order is what
   * determines the collapsed adjacency order, and that is identical here).
   */
  *edges(): IterableIterator<[string, string]> {
    for (const [n, a] of this._adj) {
      for (const [nbr, count] of a) {
        for (let i = 0; i < count; i++) yield [n, nbr];
      }
    }
  }
}

/** Insertion-ordered simple weighted digraph (one edge per ordered pair). */
class DiGraph {
  private _nodes: Map<string, true> = new Map();
  // node -> (successor -> weight), both insertion-ordered.
  private _adj: Map<string, Map<string, number>> = new Map();

  add_node(n: string): void {
    if (!this._nodes.has(n)) {
      this._nodes.set(n, true);
      this._adj.set(n, new Map());
    }
  }

  add_edge(u: string, v: string, weight: number): void {
    this.add_node(u);
    this.add_node(v);
    this._adj.get(u)!.set(v, weight);
  }

  add_edges_from(ebunch: Iterable<[string, string, { weight: number }]>): void {
    for (const [u, v, d] of ebunch) this.add_edge(u, v, d.weight);
  }

  nodes(): string[] {
    return [...this._nodes.keys()];
  }

  number_of_nodes(): number {
    return this._nodes.size;
  }

  /** Out-edges of `n` as `[successor, weight]` pairs in adjacency order. */
  out_edges(n: string): Iterable<[string, number]> {
    return (this._adj.get(n) ?? new Map<string, number>()).entries();
  }
}

// ---------------------------------------------------------------------------
// Python-semantics helpers
// ---------------------------------------------------------------------------

/** pathlib `PurePath(p).name` — final path component (trailing slashes stripped). */
function _pyName(p: string): string {
  let s = p;
  while (s.length > 1 && s.endsWith("/")) s = s.slice(0, -1);
  const i = s.lastIndexOf("/");
  return i >= 0 ? s.slice(i + 1) : s;
}

/** pathlib `PurePath(p).suffix` — extension of the final component, incl. dot. */
function _pySuffix(p: string): string {
  const name = _pyName(p);
  const i = name.lastIndexOf(".");
  return i > 0 && i < name.length - 1 ? name.slice(i) : "";
}

/** Python `str.capitalize()` — first char upper, the rest lower. */
function _pyCapitalize(s: string): string {
  return s.length ? s[0]!.toUpperCase() + s.slice(1).toLowerCase() : "";
}

/** Python `round(x)` to nearest int with ties-to-even (banker's rounding). */
function _pyRoundInt(value: number): number {
  if (!Number.isFinite(value)) return value;
  const floor = Math.floor(value);
  const diff = value - floor;
  const EPS = 1e-9;
  if (diff > 0.5 + EPS) return floor + 1;
  if (diff < 0.5 - EPS) return floor;
  return floor % 2 === 0 ? floor : floor + 1;
}

/** Python `len(str)` — number of Unicode code points (not UTF-16 units). */
function _cpLen(s: string): number {
  let n = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff && i + 1 < s.length) {
      const d = s.charCodeAt(i + 1);
      if (d >= 0xdc00 && d <= 0xdfff) i++;
    }
    n++;
  }
  return n;
}

/** Lexicographic comparison by Unicode code point (Python str ordering). */
function _cmpCodepoints(a: string, b: string): number {
  const ai = Array.from(a);
  const bi = Array.from(b);
  const n = Math.min(ai.length, bi.length);
  for (let i = 0; i < n; i++) {
    const ca = ai[i]!.codePointAt(0)!;
    const cb = bi[i]!.codePointAt(0)!;
    if (ca !== cb) return ca < cb ? -1 : 1;
  }
  return ai.length === bi.length ? 0 : ai.length < bi.length ? -1 : 1;
}

/**
 * Python `Counter.most_common()` — items sorted by count descending, ties
 * broken by first-insertion order (stable). `entries` must be in insertion
 * order (a JS Map satisfies this).
 */
function _mostCommon(counts: Map<string, number>): Array<[string, number]> {
  return [...counts.entries()].sort((a, b) => b[1] - a[1]);
}

/** Python `str.splitlines()` — split on universal newlines, drop trailing empty. */
function _splitlines(s: string): string[] {
  if (s === "") return [];
  const parts = s.split(/\r\n|\r|\n|\v|\f|\x1c|\x1d|\x1e|\x85|\u2028|\u2029/);
  if (parts.length > 0 && parts[parts.length - 1] === "") parts.pop();
  return parts;
}

/** True when `err` is the better-sqlite3 analogue of sqlite3.OperationalError. */
function _isOperationalError(err: unknown): boolean {
  const code = (err as { code?: unknown } | null)?.code;
  return typeof code === "string" && code.startsWith("SQLITE_");
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Raw file metadata loaded from the `files` table of a project DB. */
interface _FileInfo {
  language: string;
  size: number;
  mtime: number;
}

/**
 * Structured representation of a single file in the repo map (JSON output form).
 * Ported from the Python TypedDict FileMapItem.
 */
export interface FileMapItem {
  path: string;
  language: string;
  rank: number;
  symbols: Array<Record<string, string>>;
  sections: string[];
  approx_lines: number;
}

/** Intermediate result from `_load_and_rank` — all data needed to render. */
export class _RankedProjectData {
  files: Map<string, _FileInfo>;
  symbols_by_file: Map<string, Array<[string, string]>>;
  sections_by_file: Map<string, Array<[number, string]>>;
  ranked: Array<[string, _FileInfo]>;
  ranks: Map<string, number>;
  // (rel_path, mtime, size) → rendered text. Key is encoded with NUL separators.
  summary_cache: Map<string, string>;
  using_size_fallback: boolean;

  constructor(args: {
    files: Map<string, _FileInfo>;
    symbols_by_file: Map<string, Array<[string, string]>>;
    sections_by_file: Map<string, Array<[number, string]>>;
    ranked: Array<[string, _FileInfo]>;
    ranks: Map<string, number>;
    summary_cache: Map<string, string>;
    using_size_fallback?: boolean;
  }) {
    this.files = args.files;
    this.symbols_by_file = args.symbols_by_file;
    this.sections_by_file = args.sections_by_file;
    this.ranked = args.ranked;
    this.ranks = args.ranks;
    this.summary_cache = args.summary_cache;
    this.using_size_fallback = args.using_size_fallback ?? false;
  }
}

/** PageRank-weighted summary of a single file. Ported from @dataclass FileSummary. */
export class FileSummary {
  rel_path: string;
  language: string;
  rank: number;
  top_symbols: Array<[string, string]>;
  top_sections: string[];
  line_count: number;

  constructor(args: {
    rel_path: string;
    language: string;
    rank: number;
    top_symbols: Array<[string, string]>;
    top_sections: string[];
    line_count: number;
  }) {
    this.rel_path = args.rel_path;
    this.language = args.language;
    this.rank = args.rank;
    this.top_symbols = args.top_symbols;
    this.top_sections = args.top_sections;
    this.line_count = args.line_count;
  }
}

const _LOG = getLogger("repomap");

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const _MIN_DISPLAY_LINES = 4;
const _MAX_NAMES_PER_KIND = 6;

const _EXCLUDED_PREFIXES_BASE: readonly string[] = [
  ".uv-cache/",
  ".uv-cache-local/",
  "dist/",
  "build/",
  "node_modules/",
  ".next/",
  ".nuxt/",
  "__pycache__/",
  ".pytest_cache/",
  ".mypy_cache/",
  ".ruff_cache/",
  "target/",
  "out/",
  ".output/",
  "vendor/",
  ".venv/",
  "venv/",
  "env/",
  ".tox/",
  "htmlcov/",
  "site/",
];

const _EXCLUDED_PREFIXES_TESTS: readonly string[] = [
  "tests/fixtures/",
  "tests/",
  "__tests__/",
  "test/",
  "spec/",
  "e2e/",
];

const _EXCLUDED_SUBSTRINGS: readonly string[] = ["/.tmp", "/__pycache__/"];

const _EXCLUDED_BASENAMES: ReadonlySet<string> = new Set([
  "coverage.json",
  "coverage.xml",
  ".coverage",
  "lcov.info",
]);

const _EXCLUDED_SUFFIXES: readonly string[] = [
  ".min.js",
  ".min.css",
  ".bundle.js",
  ".js.map",
  ".css.map",
  ".pyc",
  ".pyo",
  ".pyd",
];

const _BYTES_PER_APPROX_LINE = 50;

const _PAGERANK_MAX_ITER_NORMAL = 200;
const _PAGERANK_MAX_ITER_FALLBACK = 500;
const _PAGERANK_TOL_NORMAL = 1e-6;
const _PAGERANK_TOL_FALLBACK = 1e-4;

/** Symbol kinds in priority order (which to show first in a file summary). */
export const KIND_PRIORITY: Record<string, number> = {
  class: 0,
  interface: 0,
  trait: 0,
  type: 1,
  enum: 1,
  function: 2,
  method: 3,
  const: 4,
  var: 5,
  import: 9,
  heading: 1,
  liquid_schema: 1,
  abi_export: 5,
  sql_table: 0,
  sql_view: 1,
  sql_function: 2,
  sql_procedure: 2,
  sql_type: 1,
  sql_trigger: 3,
  sql_index: 4,
  sql_schema: 0,
  graphql_type: 0,
  graphql_interface: 0,
  graphql_input: 1,
  graphql_enum: 1,
  graphql_union: 1,
  graphql_scalar: 2,
  graphql_extend: 3,
  proto_message: 0,
  proto_enum: 1,
  proto_service: 0,
  css_selector: 2,
  css_rule: 3,
  css_var: 4,
  css_keyframe: 3,
  css_mixin: 2,
  makefile_target: 2,
  makefile_define: 3,
  dockerfile_stage: 2,
};

/** Short tags emitted in the dense text format instead of full kind names. */
export const _KIND_TAG: Record<string, string> = {
  class: "cls",
  interface: "iface",
  trait: "trait",
  type: "ty",
  enum: "enum",
  function: "fn",
  method: "m",
  const: "k",
  var: "v",
  import: "imp",
  heading: "h",
  liquid_schema: "lqs",
  abi_export: "abi",
  sql_table: "tbl",
  sql_view: "view",
  sql_function: "fn",
  sql_procedure: "proc",
  sql_type: "ty",
  sql_trigger: "trig",
  sql_index: "idx",
  sql_schema: "schema",
  graphql_type: "ty",
  graphql_interface: "iface",
  graphql_input: "input",
  graphql_enum: "enum",
  graphql_union: "union",
  graphql_scalar: "scalar",
  graphql_extend: "ext",
  proto_message: "msg",
  proto_enum: "enum",
  proto_service: "svc",
  css_selector: "sel",
  css_rule: "rule",
  css_var: "var",
  css_keyframe: "kf",
  css_mixin: "mix",
  makefile_target: "tgt",
  makefile_define: "def",
  dockerfile_stage: "stage",
};

const _AUTO_COMPACT_BUDGET = 300;

// ---------------------------------------------------------------------------
// Path exclusion
// ---------------------------------------------------------------------------

/**
 * Return the active prefix exclusion tuple, including/excluding tests per config.
 *
 * `TOKEN_GOAT_REPOMAP_EXCLUDE_TESTS` env var overrides config; default True.
 */
function _get_excluded_prefixes(): readonly string[] {
  const envVal = (process.env["TOKEN_GOAT_REPOMAP_EXCLUDE_TESTS"] ?? "").trim().toLowerCase();
  let exclude_tests: boolean;
  if (["0", "false", "no", "off"].includes(envVal)) {
    exclude_tests = false;
  } else if (["1", "true", "yes", "on"].includes(envVal)) {
    exclude_tests = true;
  } else {
    try {
      exclude_tests = config.load().repomap!.exclude_tests!;
    } catch {
      exclude_tests = true;
    }
  }
  if (exclude_tests) {
    return [..._EXCLUDED_PREFIXES_BASE, ..._EXCLUDED_PREFIXES_TESTS];
  }
  return _EXCLUDED_PREFIXES_BASE;
}

// lru_cache(maxsize=4096) over (rel_path, prefixes). The result is a pure
// function of the inputs, so the cache only affects performance.
const _EXCL_CACHE = new Map<string, boolean>();
const _EXCL_CACHE_MAXSIZE = 4096;

function _compute_is_excluded(rel_path: string, prefixes: readonly string[]): boolean {
  const posix = rel_path.includes("\\") ? rel_path.replace(/\\/g, "/") : rel_path;
  const slash = posix.lastIndexOf("/");
  const basename = (slash >= 0 ? posix.slice(slash + 1) : posix).toLowerCase();
  // 1. basename
  if (_EXCLUDED_BASENAMES.has(basename)) return true;
  // 2. suffix
  for (const s of _EXCLUDED_SUFFIXES) if (basename.endsWith(s)) return true;
  // 3. prefix
  for (const p of prefixes) if (posix.startsWith(p)) return true;
  // 4. substring
  for (const s of _EXCLUDED_SUBSTRINGS) if (posix.includes(s)) return true;
  return false;
}

interface CachedExcluded {
  (rel_path: string, prefixes: readonly string[]): boolean;
  cache_clear(): void;
}

/** Cached inner implementation of the path-exclusion predicate (see `_is_excluded_path`). */
export const _is_excluded_path_cached: CachedExcluded = Object.assign(
  function _is_excluded_path_cached(rel_path: string, prefixes: readonly string[]): boolean {
    const key = rel_path + "\u0000" + prefixes.join("\u0001");
    const hit = _EXCL_CACHE.get(key);
    if (hit !== undefined) {
      // LRU touch.
      _EXCL_CACHE.delete(key);
      _EXCL_CACHE.set(key, hit);
      return hit;
    }
    const result = _compute_is_excluded(rel_path, prefixes);
    _EXCL_CACHE.set(key, result);
    if (_EXCL_CACHE.size > _EXCL_CACHE_MAXSIZE) {
      const oldest = _EXCL_CACHE.keys().next().value;
      if (oldest !== undefined) _EXCL_CACHE.delete(oldest);
    }
    return result;
  },
  { cache_clear: (): void => void _EXCL_CACHE.clear() },
);
registerReset(() => _EXCL_CACHE.clear());

/** Return True if rel_path should be excluded from the repo map. */
export function _is_excluded_path(rel_path: string): boolean {
  return _is_excluded_path_cached(rel_path, _get_excluded_prefixes());
}

/** Return True if this file should appear in the repo map. */
export function _is_map_worthy(rel_path: string, approx_lines: number): boolean {
  if (_is_excluded_path(rel_path)) return false;
  return approx_lines >= _MIN_DISPLAY_LINES;
}

/** Rough token estimate for a string (~3.5 chars/token), at least 1. */
export function estimate_tokens(text: string): number {
  return Math.max(1, Math.floor(_cpLen(text) / 3) + 1);
}

// ---------------------------------------------------------------------------
// DB loading
// ---------------------------------------------------------------------------

type _Conn = {
  prepare(sql: string): {
    all(...params: unknown[]): unknown[];
    run(...params: unknown[]): unknown;
  };
};

/** Load all indexed data for a project: files, symbols, sections, reverse-index. */
function _load_project_data(
  conn: _Conn,
): [
  Map<string, _FileInfo>,
  Map<string, Array<[string, string]>>,
  Map<string, Array<[number, string]>>,
  Map<string, Set<string>>,
] {
  const files = new Map<string, _FileInfo>();
  try {
    for (const row of conn
      .prepare("SELECT rel_path, language, size, mtime FROM files")
      .all() as Array<{ rel_path: string; language: string; size: number; mtime: number }>) {
      files.set(row.rel_path, {
        language: row.language,
        size: row.size,
        mtime: row.mtime,
      });
    }
  } catch (exc) {
    if (!_isOperationalError(exc)) throw exc;
    _LOG.error(`repomap: failed to read files table: ${String(exc)}`);
    return [new Map(), new Map(), new Map(), new Map()];
  }

  const symbols_by_file = new Map<string, Array<[string, string]>>();
  const name_to_files = new Map<string, Set<string>>();
  try {
    for (const row of conn
      .prepare("SELECT name, kind, file_rel FROM symbols")
      .all() as Array<{ name: string; kind: string; file_rel: string }>) {
      let lst = symbols_by_file.get(row.file_rel);
      if (lst === undefined) symbols_by_file.set(row.file_rel, (lst = []));
      lst.push([row.kind, row.name]);
      let s = name_to_files.get(row.name);
      if (s === undefined) name_to_files.set(row.name, (s = new Set()));
      s.add(row.file_rel);
    }
  } catch (exc) {
    if (!_isOperationalError(exc)) throw exc;
    _LOG.warning(`repomap: failed to read symbols table (map will have no symbols): ${String(exc)}`);
  }

  const sections_by_file = new Map<string, Array<[number, string]>>();
  try {
    for (const row of conn
      .prepare("SELECT file_rel, heading, level FROM sections ORDER BY level, line")
      .all() as Array<{ file_rel: string; heading: string; level: number }>) {
      let lst = sections_by_file.get(row.file_rel);
      if (lst === undefined) sections_by_file.set(row.file_rel, (lst = []));
      lst.push([row.level, row.heading]);
    }
  } catch (exc) {
    if (!_isOperationalError(exc)) throw exc;
    _LOG.warning(
      `repomap: failed to read sections table (map will have no sections): ${String(exc)}`,
    );
  }

  return [files, symbols_by_file, sections_by_file, name_to_files];
}

/** Build a directed dependency graph: edge A→B if A references a symbol defined in B. */
export function _build_graph(
  conn: _Conn,
  files: Map<string, _FileInfo>,
  name_to_files: Map<string, Set<string>>,
): MultiDiGraph {
  const graph = new MultiDiGraph();

  for (const file_path of files.keys()) graph.add_node(file_path);

  let ref_rows: Array<{ symbol_name: string; file_rel: string }>;
  try {
    ref_rows = conn
      .prepare("SELECT symbol_name, file_rel FROM refs")
      .all() as Array<{ symbol_name: string; file_rel: string }>;
  } catch (exc) {
    if (!_isOperationalError(exc)) throw exc;
    _LOG.warning(`repomap: failed to read refs table (graph will have no edges): ${String(exc)}`);
    return graph;
  }

  for (const row of ref_rows) {
    const referenced_symbol = row.symbol_name;
    const referencing_file = row.file_rel;
    if (!files.has(referencing_file)) continue;
    const definition_files = name_to_files.get(referenced_symbol);
    if (definition_files === undefined) continue;
    for (const definition_file of definition_files) {
      if (definition_file !== referencing_file && files.has(definition_file)) {
        graph.add_edge(referencing_file, definition_file);
      }
    }
  }

  _LOG.debug(
    `_build_graph: nodes=${graph.number_of_nodes()} edges=${graph.number_of_edges()} refs_processed=${ref_rows.length}`,
  );
  return graph;
}

/** Collapse a multigraph to a simple weighted DiGraph for PageRank input. */
function _multigraph_to_weighted_digraph(multigraph: MultiDiGraph): DiGraph {
  const simple_graph = new DiGraph();

  for (const node of multigraph.nodes()) simple_graph.add_node(node);

  // Count parallel edges (Counter over (src, dst)) in a single pass, preserving
  // first-seen order, then add them all at once.
  const edge_weights = new Map<string, number>();
  const order: Array<[string, string]> = [];
  for (const [src, dst] of multigraph.edges()) {
    const key = src + "\u0000" + dst;
    if (!edge_weights.has(key)) order.push([src, dst]);
    edge_weights.set(key, (edge_weights.get(key) ?? 0) + 1);
  }
  simple_graph.add_edges_from(
    order.map(
      ([src, dst]) =>
        [src, dst, { weight: edge_weights.get(src + "\u0000" + dst)! }] as [
          string,
          string,
          { weight: number },
        ],
    ),
  );

  return simple_graph;
}

/**
 * networkx pure-Python `_pagerank_python` + `stochastic_graph`, ported
 * byte-faithfully. Throws PowerIterationFailedConvergence on non-convergence.
 */
function _pagerank_python(
  simple: DiGraph,
  alpha: number,
  max_iter: number,
  tol: number,
): Map<string, number> {
  const nodes = simple.nodes();
  const N = nodes.length;
  if (N === 0) return new Map();

  // stochastic_graph: weighted out-degree per node (adjacency-order sum), then
  // normalize each out-edge weight by it.
  const degree = new Map<string, number>();
  for (const u of nodes) {
    let d = 0;
    for (const [, w] of simple.out_edges(u)) d += w;
    degree.set(u, d);
  }
  const W = new Map<string, Array<[string, number]>>();
  for (const u of nodes) {
    const du = degree.get(u)!;
    const arr: Array<[string, number]> = [];
    for (const [nbr, w] of simple.out_edges(u)) arr.push([nbr, du === 0 ? 0 : w / du]);
    W.set(u, arr);
  }

  const inv = 1.0 / N;
  let x = new Map<string, number>();
  for (const n of nodes) x.set(n, inv);
  const p = new Map<string, number>();
  for (const n of nodes) p.set(n, inv);
  // dangling_weights = p
  const dangling_nodes = nodes.filter((n) => degree.get(n) === 0);

  for (let it = 0; it < max_iter; it++) {
    const xlast = x;
    x = new Map<string, number>();
    for (const n of nodes) x.set(n, 0);
    let danglesumInner = 0;
    for (const n of dangling_nodes) danglesumInner += xlast.get(n)!;
    const danglesum = alpha * danglesumInner;
    for (const n of nodes) {
      const xln = xlast.get(n)!;
      for (const [nbr, wt] of W.get(n)!) {
        x.set(nbr, x.get(nbr)! + alpha * xln * wt);
      }
      const pn = p.get(n) ?? 0;
      x.set(n, x.get(n)! + danglesum * pn + (1.0 - alpha) * pn);
    }
    let err = 0;
    for (const n of nodes) err += Math.abs(x.get(n)! - xlast.get(n)!);
    if (err < N * tol) return x;
  }
  throw new PowerIterationFailedConvergence(max_iter);
}

/** Run PageRank on the multigraph (collapsed to a simple graph). */
export function compute_ranks(graph: MultiDiGraph, alpha = 0.85): Map<string, number> {
  if (graph.number_of_nodes() === 0) return new Map();

  const simple_graph = _multigraph_to_weighted_digraph(graph);

  const _uniform_ranks = (): Map<string, number> => {
    const node_count = simple_graph.number_of_nodes();
    const rank = node_count ? 1.0 / node_count : 1.0;
    const m = new Map<string, number>();
    for (const node of simple_graph.nodes()) m.set(node, rank);
    return m;
  };

  // The Python ImportError path (falling back to nx.pagerank with scipy when
  // the private _pagerank_python symbol is gone) is unreachable here — the
  // power iteration is shipped in-module — so only the convergence + uniform
  // fallbacks are ported.
  try {
    return _pagerank_python(
      simple_graph,
      alpha,
      _PAGERANK_MAX_ITER_NORMAL,
      _PAGERANK_TOL_NORMAL,
    );
  } catch (exc) {
    if (exc instanceof PowerIterationFailedConvergence) {
      _LOG.debug(
        `PageRank did not converge at tol=${_PAGERANK_TOL_NORMAL}; retrying with relaxed parameters`,
      );
      try {
        return _pagerank_python(
          simple_graph,
          alpha,
          _PAGERANK_MAX_ITER_FALLBACK,
          _PAGERANK_TOL_FALLBACK,
        );
      } catch (exc2) {
        if (exc2 instanceof PowerIterationFailedConvergence) {
          _LOG.warning(
            `PageRank failed to converge even with relaxed parameters ` +
              `(max_iter=${_PAGERANK_MAX_ITER_FALLBACK}, tol=${_PAGERANK_TOL_FALLBACK}); using uniform ranks`,
          );
          return _uniform_ranks();
        }
        _LOG.warning(`PageRank raised unexpected error (${String(exc2)}); using uniform ranks`);
        return _uniform_ranks();
      }
    }
    _LOG.warning(`PageRank raised unexpected error (${String(exc)}); using uniform ranks`);
    return _uniform_ranks();
  }
}

// ---------------------------------------------------------------------------
// Summaries
// ---------------------------------------------------------------------------

/** Produce a concise FileSummary for a single file. */
function _summarize_file(
  rel: string,
  info: _FileInfo,
  symbols: Array<[string, string]>,
  sections: Array<[number, string]>,
  rank: number,
  max_symbols = 8,
  max_sections = 5,
): FileSummary {
  // heapq.nsmallest(max_symbols*4, symbols, key=(priority, name)) is equivalent
  // to a stable sort by that key truncated to the over-fetch window.
  const sorted = [...symbols].sort((a, b) => {
    const pa = KIND_PRIORITY[a[0]] ?? 99;
    const pb = KIND_PRIORITY[b[0]] ?? 99;
    if (pa !== pb) return pa - pb;
    return _cmpCodepoints(a[1], b[1]);
  });
  const top_n = sorted.slice(0, max_symbols * 4);

  const top_symbols: Array<[string, string]> = [];
  const seen = new Set<string>();
  for (const [kind, name] of top_n) {
    const entry = kind + "\u0000" + name;
    if (!seen.has(entry)) {
      seen.add(entry);
      top_symbols.push([kind, name]);
      if (top_symbols.length >= max_symbols) break;
    }
  }

  const top_sections = sections
    .filter(([lvl]) => lvl <= 2)
    .map(([, h]) => h)
    .slice(0, max_sections);
  const approx_lines = Math.max(1, Math.floor(info.size / _BYTES_PER_APPROX_LINE));
  return new FileSummary({
    rel_path: rel,
    language: info.language,
    rank,
    top_symbols,
    top_sections,
    line_count: approx_lines,
  });
}

/** Render a single file summary as text. */
export function render_summary(summary: FileSummary, compact = false): string {
  const head = `${summary.rel_path} [${summary.language},${summary.line_count},r=${summary.rank.toFixed(3)}]`;
  if (compact) return head;
  const lines = [head];
  if (summary.top_symbols.length) {
    const by_kind = new Map<string, string[]>();
    for (const [kind, name] of summary.top_symbols) {
      let lst = by_kind.get(kind);
      if (lst === undefined) by_kind.set(kind, (lst = []));
      lst.push(name);
    }
    const kinds = [...by_kind.keys()].sort(
      (a, b) => (KIND_PRIORITY[a] ?? 99) - (KIND_PRIORITY[b] ?? 99),
    );
    for (const kind of kinds) {
      const tag = _KIND_TAG[kind] ?? kind;
      const names = by_kind.get(kind)!.slice(0, _MAX_NAMES_PER_KIND).join(",");
      lines.push(` ${tag}:${names}`);
    }
  }
  if (summary.top_sections.length) {
    lines.push(` sec:${summary.top_sections.join(">")}`);
  }
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Summary cache (repomap_cache table)
// ---------------------------------------------------------------------------

/** Encode a summary-cache key as (rel_path, mtime, size) with NUL separators. */
function _cacheKey(rel: string, mtime: number, size: number): string {
  return `${rel}\u0000${mtime}\u0000${size}`;
}

/** Load all cached summary texts keyed on (rel_path, mtime, size). */
export function _load_summary_cache(conn: _Conn): Map<string, string> {
  const cache = new Map<string, string>();
  try {
    for (const row of conn
      .prepare("SELECT rel_path, mtime, size, summary_text FROM repomap_cache")
      .all() as Array<{ rel_path: string; mtime: number; size: number; summary_text: string }>) {
      cache.set(_cacheKey(row.rel_path, row.mtime, row.size), row.summary_text);
    }
  } catch (exc) {
    if (!_isOperationalError(exc)) throw exc;
    _LOG.debug(`repomap_cache table unavailable (older schema?): ${String(exc)}`);
  }
  return cache;
}

/** Persist new cache entries as (rel_path, mtime, size, summary_text). */
export function _write_summary_cache(
  conn: _Conn,
  entries: Array<[string, number, number, string]>,
): void {
  if (entries.length === 0) return;
  const now = Math.floor(Date.now() / 1000);
  try {
    const stmt = conn.prepare(
      "INSERT OR REPLACE INTO repomap_cache " +
        "(rel_path, mtime, size, summary_text, created_at) " +
        "VALUES (?, ?, ?, ?, ?)",
    );
    for (const [rel, mtime, size, text] of entries) {
      stmt.run(rel, mtime, size, text, now);
    }
  } catch (exc) {
    if (!_isOperationalError(exc)) throw exc;
    // suppress(sqlite3.OperationalError)
  }
}

/** Remove cache entries for files no longer in the files table. */
function _evict_stale_cache(conn: _Conn, current_files: Map<string, _FileInfo>): void {
  if (current_files.size === 0) return;
  try {
    const keys = [...current_files.keys()];
    const ph = keys.map(() => "?").join(",");
    conn.prepare(`DELETE FROM repomap_cache WHERE rel_path NOT IN (${ph})`).run(...keys);
  } catch (exc) {
    if (!_isOperationalError(exc)) throw exc;
    _LOG.debug(
      `repomap_cache eviction skipped (table absent or schema mismatch): ${String(exc)}`,
    );
  }
}

// ---------------------------------------------------------------------------
// Load + rank
// ---------------------------------------------------------------------------

/** Load project data, filter, compute PageRank, and return sorted ranking. */
export function _load_and_rank(project: Project): _RankedProjectData | null {
  let loaded: {
    map_worthy_files: Map<string, _FileInfo>;
    symbols_by_file: Map<string, Array<[string, string]>>;
    sections_by_file: Map<string, Array<[number, string]>>;
    graph: MultiDiGraph;
    summary_cache: Map<string, string>;
    total_file_count: number;
  } | null;
  try {
    loaded = db.openProject(project.hash, (conn) => {
      const [all_files, symbols_by_file, sections_by_file, name_to_files] =
        _load_project_data(conn as _Conn);
      if (all_files.size === 0) {
        _LOG.debug(`_load_and_rank: no indexed files for project ${_pyName(project.root)}`);
        return null;
      }
      const total_file_count = all_files.size;
      const map_worthy_files = new Map<string, _FileInfo>();
      for (const [rel, info] of all_files) {
        if (_is_map_worthy(rel, Math.max(1, Math.floor(info.size / _BYTES_PER_APPROX_LINE)))) {
          map_worthy_files.set(rel, info);
        }
      }
      const graph = _build_graph(conn as _Conn, map_worthy_files, name_to_files);
      const summary_cache = _load_summary_cache(conn as _Conn);
      _evict_stale_cache(conn as _Conn, map_worthy_files);
      return {
        map_worthy_files,
        symbols_by_file,
        sections_by_file,
        graph,
        summary_cache,
        total_file_count,
      };
    });
  } catch (exc) {
    _LOG.error(
      `_load_and_rank: failed to load project data for ${_pyName(project.root)}: ${String(exc)}`,
    );
    return null;
  }
  if (loaded === null) return null;

  const { map_worthy_files, symbols_by_file, sections_by_file, graph, summary_cache } = loaded;

  let ranks = compute_ranks(graph);
  // Fallback: if every node has the same rank (no edges), break ties by file size.
  const rankValues = [...ranks.values()];
  const all_ranks_equal =
    ranks.size === 0 || Math.min(...rankValues) === Math.max(...rankValues);
  if (all_ranks_equal) {
    _LOG.debug(
      `_load_and_rank: PageRank produced uniform scores (no edges or empty); ` +
        `falling back to file-size ranking for ${_pyName(project.root)} (${map_worthy_files.size} files)`,
    );
    ranks = new Map();
    for (const [rel, info] of map_worthy_files) ranks.set(rel, info.size);
  }

  const ranked = [...map_worthy_files.entries()].sort((a, b) => {
    const ra = ranks.get(a[0]) ?? 0.0;
    const rb = ranks.get(b[0]) ?? 0.0;
    return rb - ra;
  });

  return new _RankedProjectData({
    files: map_worthy_files,
    symbols_by_file,
    sections_by_file,
    ranked,
    ranks,
    summary_cache,
    using_size_fallback: all_ranks_equal,
  });
}

/** Return the rendered text for one file and whether it was a cache hit. */
function _get_rendered_summary(
  rel: string,
  info: _FileInfo,
  data: _RankedProjectData,
  cache_writes: Array<[string, number, number, string]>,
  compact = false,
): [string, boolean] {
  const mtime = info.mtime;
  const size = info.size;
  if (!compact) {
    const cached_text = data.summary_cache.get(_cacheKey(rel, mtime, size));
    if (cached_text !== undefined) return [cached_text, true];
  }

  _LOG.debug(`repomap summary cache miss: ${rel} (mtime=${mtime} size=${size})`);
  const summary = _summarize_file(
    rel,
    info,
    data.symbols_by_file.get(rel) ?? [],
    data.sections_by_file.get(rel) ?? [],
    data.ranks.get(rel) ?? 0.0,
  );
  const rendered = render_summary(summary, compact) + "\n";
  if (!compact) cache_writes.push([rel, mtime, size, rendered]);
  return [rendered, false];
}

/** Return the 1-line file-list preamble used when compact mode suppresses the full list. */
export function _build_compact_file_summary(
  ranked: Array<[string, _FileInfo]>,
  total: number,
  top_n = 3,
  include_ext_counts = false,
): string {
  if (top_n < 1) top_n = 1;
  const top = ranked.slice(0, top_n).map(([rel]) => _pyName(rel));
  const rest = total - top.length;
  let modules_str = top.join(", ");
  if (rest > 0) modules_str += ` (+${rest} more)`;

  if (!include_ext_counts) {
    return `${total} files indexed. Top modules: ${modules_str}\n`;
  }

  const ext_counts = new Map<string, number>();
  for (const [rel] of ranked) {
    const suffix = _pySuffix(rel).toLowerCase();
    const key = suffix ? suffix : "(no ext)";
    ext_counts.set(key, (ext_counts.get(key) ?? 0) + 1);
  }
  const _MAX_EXT_COLS = 4;
  const ext_ranked = _mostCommon(ext_counts);
  let ext_str: string;
  if (ext_ranked.length <= _MAX_EXT_COLS) {
    ext_str = ext_ranked.map(([e, c]) => `${c} ${e}`).join(", ");
  } else {
    const top_ext = ext_ranked.slice(0, _MAX_EXT_COLS);
    const rest_types = ext_ranked.length - _MAX_EXT_COLS;
    ext_str = top_ext.map(([e, c]) => `${c} ${e}`).join(", ") + ` (+${rest_types} more types)`;
  }
  return `${total} files: ${ext_str}. Top: ${modules_str}\n`;
}

// ---------------------------------------------------------------------------
// build_map
// ---------------------------------------------------------------------------

/** Build the repo map text under the token budget. */
export function build_map(
  project: Project,
  opts: {
    budget_tokens?: number;
    include_unranked_tail?: boolean;
    compact?: boolean | null;
    full?: boolean;
    compact_file_threshold?: number | null;
    top_n?: number | null;
  } = {},
): string {
  const budget_tokens = opts.budget_tokens ?? 4000;
  const include_unranked_tail = opts.include_unranked_tail ?? true;
  const compact = opts.compact ?? null;
  const full = opts.full ?? false;
  let compact_file_threshold = opts.compact_file_threshold ?? null;
  let top_n = opts.top_n ?? null;

  const data = _load_and_rank(project);
  if (data === null) {
    return (
      `# ${_pyName(project.root)}\n\n` + "(no files indexed — run `token-goat index --full`)\n"
    );
  }

  // When --top N is set, return only the top N files in compact (score) format.
  if (top_n !== null && top_n > 0) {
    if (top_n > data.ranked.length) top_n = data.ranked.length;
    const out: string[] = [];
    for (const [rel] of data.ranked.slice(0, top_n)) {
      const score = data.ranks.get(rel) ?? 0.0;
      out.push(`${rel} (rank: ${score.toFixed(3)})\n`);
    }
    return out.join("");
  }

  const use_compact = compact !== null ? compact : budget_tokens < _AUTO_COMPACT_BUDGET;

  if (compact_file_threshold === null) {
    compact_file_threshold = config.load().repomap!.compact_file_threshold!;
  }

  const lang_set = [...new Set([...data.files.values()].map((info) => info.language))].sort(
    _cmpCodepoints,
  );
  const header = `# ${_pyName(project.root)} (${data.files.size},${lang_set.join(",")})\n`;
  const out: string[] = [header];
  let used = estimate_tokens(header);
  let included = 0;
  let cache_hits = 0;
  let cache_misses = 0;

  const cache_writes: Array<[string, number, number, string]> = [];

  const use_summary_line =
    use_compact &&
    !full &&
    compact_file_threshold > 0 &&
    data.ranked.length > compact_file_threshold;

  if (use_summary_line) {
    if (budget_tokens < 400) top_n = 3;
    else if (budget_tokens < 800) top_n = 5;
    else if (budget_tokens < 2000) top_n = 8;
    else top_n = 12;
    const include_ext_counts = lang_set.length > 1;
    const summary_line = _build_compact_file_summary(
      data.ranked,
      data.ranked.length,
      top_n,
      include_ext_counts,
    );
    out.push(summary_line);
    used += estimate_tokens(summary_line);
  } else {
    const _LOW_RANK_THRESHOLD = 0.05;
    const _MIN_MINOR_FILES = 5;
    let minor_file_count = 0;
    if (use_compact && !data.using_size_fallback) {
      for (const [rel] of data.ranked) {
        if ((data.ranks.get(rel) ?? 0.0) < _LOW_RANK_THRESHOLD) minor_file_count += 1;
      }
    }

    for (const [rel, info] of data.ranked) {
      if (used >= budget_tokens) break;

      if (
        use_compact &&
        minor_file_count >= _MIN_MINOR_FILES &&
        (data.ranks.get(rel) ?? 0.0) < _LOW_RANK_THRESHOLD
      ) {
        continue;
      }

      const [rendered, is_hit] = _get_rendered_summary(rel, info, data, cache_writes, use_compact);
      if (is_hit) cache_hits += 1;
      else cache_misses += 1;

      const rendered_tokens = estimate_tokens(rendered);
      if (used + rendered_tokens > budget_tokens) break;
      out.push(rendered);
      used += rendered_tokens;
      included += 1;
    }

    if (include_unranked_tail && included < data.ranked.length) {
      const omitted = data.ranked.length - included;
      if (use_compact && minor_file_count >= _MIN_MINOR_FILES && omitted > 0) {
        const budget_truncated = omitted - minor_file_count;
        if (budget_truncated <= 0) {
          out.push(`(+${omitted} minor files)\n`);
        } else {
          out.push(`+${budget_truncated} more (+${minor_file_count} minor)\n`);
        }
      } else {
        out.push(`+${omitted} more\n`);
      }
    }
  }

  if (!use_summary_line && lang_set.length > 1) {
    const breakdown = lang_breakdown(data.files);
    if (breakdown) out.push(`${breakdown}\n`);
  }

  if (cache_writes.length) {
    try {
      db.openProject(project.hash, (conn) => {
        _write_summary_cache(conn as _Conn, cache_writes);
      });
      _LOG.debug(`repomap_cache: wrote ${cache_writes.length} new entries`);
    } catch {
      _LOG.debug("repomap_cache write failed (non-fatal)");
    }
  }

  void cache_hits;
  void cache_misses;
  return out.join("");
}

// ---------------------------------------------------------------------------
// build_map_since
// ---------------------------------------------------------------------------

/** Return POSIX-relative paths of files changed since *ref*. */
export function changed_files_since(project: Project, ref: string): ReadonlySet<string> {
  try {
    const result = runGit(["diff", "--name-only", ref], {
      cwd: project.root,
      timeout: 10,
    });
    if (result.returncode !== 0) {
      _LOG.debug(`changed_files_since: git diff failed for ref=${ref}: ${result.stderr.trim()}`);
      return new Set();
    }
    const paths = new Set<string>();
    for (const line of _splitlines(result.stdout)) {
      const p = line.trim();
      if (p) paths.add(p);
    }
    return paths;
  } catch {
    _LOG.debug(`changed_files_since: unexpected error for ref=${ref}`);
    return new Set();
  }
}

/** Build a repo map filtered to files changed since *ref*. */
export function build_map_since(
  project: Project,
  ref: string,
  opts: { budget_tokens?: number; compact?: boolean | null; full?: boolean } = {},
): string {
  const budget_tokens = opts.budget_tokens ?? 4000;
  const compact = opts.compact ?? null;

  const changed = self.changed_files_since(project, ref);
  if (changed.size === 0) {
    return (
      `# ${_pyName(project.root)} — changes since ${ref}\n\n` +
      `(no changed files found, or \`${ref}\` is not a valid git ref)\n`
    );
  }

  const data = _load_and_rank(project);
  if (data === null) {
    return (
      `# ${_pyName(project.root)} — changes since ${ref}\n\n` +
      "(no files indexed — run `token-goat index --full`)\n"
    );
  }

  const use_compact = compact !== null ? compact : budget_tokens < _AUTO_COMPACT_BUDGET;

  const header = `# ${_pyName(project.root)} — ${changed.size} file(s) changed since \`${ref}\`\n`;
  const out: string[] = [header];
  let used = estimate_tokens(header);
  let included = 0;
  const cache_writes: Array<[string, number, number, string]> = [];

  for (const [rel, info] of data.ranked) {
    if (!changed.has(rel)) continue;
    if (used >= budget_tokens) break;

    let [rendered] = _get_rendered_summary(rel, info, data, cache_writes, use_compact);
    rendered = `[changed] ${rendered}`;

    const rendered_tokens = estimate_tokens(rendered);
    if (used + rendered_tokens > budget_tokens) break;
    out.push(rendered);
    used += rendered_tokens;
    included += 1;
  }

  const indexed_rels = new Set(data.ranked.map(([rel]) => rel));
  const unindexed = [...changed].filter((rel) => !indexed_rels.has(rel)).sort(_cmpCodepoints);
  if (unindexed.length) {
    const unindexed_block =
      "Unindexed changed files:\n" + unindexed.map((p) => `  ${p}\n`).join("");
    out.push(unindexed_block);
  }

  let indexed_changed_count = 0;
  for (const rel of changed) if (indexed_rels.has(rel)) indexed_changed_count += 1;
  if (included < indexed_changed_count) {
    const omitted = indexed_changed_count - included;
    out.push(`+${omitted} more changed files (budget exhausted)\n`);
  }

  if (cache_writes.length) {
    try {
      db.openProject(project.hash, (conn) => {
        _write_summary_cache(conn as _Conn, cache_writes);
      });
    } catch {
      // best-effort
    }
  }

  return out.join("");
}

// ---------------------------------------------------------------------------
// build_map_json
// ---------------------------------------------------------------------------

/** Return the full ranked file list as structured dicts rather than text. */
export function build_map_json(project: Project): FileMapItem[] {
  const data = _load_and_rank(project);
  if (data === null) return [];
  const out: FileMapItem[] = [];
  for (const [rel, info] of data.ranked) {
    const summary = _summarize_file(
      rel,
      info,
      data.symbols_by_file.get(rel) ?? [],
      data.sections_by_file.get(rel) ?? [],
      data.ranks.get(rel) ?? 0.0,
    );
    out.push({
      path: summary.rel_path,
      language: summary.language,
      rank: summary.rank,
      symbols: summary.top_symbols.map(([k, n]) => ({ kind: k, name: n })),
      sections: summary.top_sections,
      approx_lines: summary.line_count,
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// lang_breakdown
// ---------------------------------------------------------------------------

/** Return a one-line language breakdown string, e.g. `Python: 60%  TypeScript: 40%`. */
export function lang_breakdown(files: Map<string, _FileInfo>): string {
  if (files.size === 0) return "";
  const counts = new Map<string, number>();
  for (const info of files.values()) {
    const lang = info.language || "unknown";
    const key = _pyCapitalize(lang);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  let total = 0;
  for (const c of counts.values()) total += c;
  const ranked = _mostCommon(counts);
  const _MAX_LANG_COLS = 4;
  let buckets: Array<[string, number]>;
  let other_count: number;
  if (ranked.length <= _MAX_LANG_COLS) {
    buckets = ranked;
    other_count = 0;
  } else {
    buckets = ranked.slice(0, _MAX_LANG_COLS);
    let sumBuckets = 0;
    for (const [, c] of buckets) sumBuckets += c;
    other_count = total - sumBuckets;
  }
  const parts: string[] = [];
  for (const [lang, count] of buckets) {
    const pct = _pyRoundInt((count * 100) / total);
    parts.push(`${lang}: ${pct}%`);
  }
  if (other_count) {
    const pct = _pyRoundInt((other_count * 100) / total);
    parts.push(`Other: ${pct}%`);
  }
  return parts.join("  ");
}

// ---------------------------------------------------------------------------
// build_map_mermaid
// ---------------------------------------------------------------------------

/** Return a Mermaid `graph TD` diagram of the top-*n* files by PageRank. */
export function build_map_mermaid(project: Project, opts: { top_n?: number } = {}): string {
  const top_n = opts.top_n ?? 20;

  const data = _load_and_rank(project);
  if (data === null) {
    return 'graph TD\n    empty["No files indexed — run `token-goat index --full`"]\n';
  }

  const top_files = new Set(data.ranked.slice(0, top_n).map(([rel]) => rel));

  const lines: string[] = ["graph TD"];

  for (const [rel, info] of data.ranked.slice(0, top_n)) {
    const node_id = _mermaid_id(rel);
    const basename = _pyName(rel);
    const approx_lines = Math.max(1, Math.floor(info.size / _BYTES_PER_APPROX_LINE));
    const lang = info.language || "?";
    lines.push(`    ${node_id}["${basename}<br/>${lang}, ~${approx_lines}L"]`);
  }

  let ref_rows: Array<{ symbol_name: string; file_rel: string }>;
  try {
    ref_rows = db.openProject(project.hash, (conn) => {
      try {
        return (conn as _Conn)
          .prepare("SELECT symbol_name, file_rel FROM refs")
          .all() as Array<{ symbol_name: string; file_rel: string }>;
      } catch {
        return [];
      }
    });
  } catch {
    ref_rows = [];
  }

  const name_to_files = new Map<string, Set<string>>();
  for (const [rel] of data.ranked) {
    for (const [, name] of data.symbols_by_file.get(rel) ?? []) {
      let s = name_to_files.get(name);
      if (s === undefined) name_to_files.set(name, (s = new Set()));
      s.add(rel);
    }
  }

  const seen_edges = new Set<string>();
  for (const row of ref_rows) {
    const src = row.file_rel;
    const sym = row.symbol_name;
    if (!top_files.has(src)) continue;
    for (const dst of name_to_files.get(sym) ?? []) {
      if (dst !== src && top_files.has(dst)) {
        const edge = src + "\u0000" + dst;
        if (!seen_edges.has(edge)) {
          seen_edges.add(edge);
          lines.push(`    ${_mermaid_id(src)} --> ${_mermaid_id(dst)}`);
        }
      }
    }
  }

  const breakdown = lang_breakdown(data.files);
  if (breakdown) {
    lines.push("    classDef note fill:#f9f,stroke:#333");
    lines.push(`    langs["${breakdown}"]:::note`);
  }

  return lines.join("\n") + "\n";
}

/** Convert a relative file path to a safe Mermaid node identifier. */
export function _mermaid_id(rel_path: string): string {
  let safe = "";
  for (const c of rel_path) {
    safe += /[\p{L}\p{N}]/u.test(c) || c === "_" ? c : "_";
  }
  return `f_${safe}`;
}

// Internal exports surfaced for the test suite (Python module-private symbols
// the tests reach into directly).
export { _MIN_DISPLAY_LINES, _load_project_data, _evict_stale_cache, _get_rendered_summary };
