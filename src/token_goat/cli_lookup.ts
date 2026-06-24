/**
 * Command helpers + implementations for the 4 deferred batch-A surgical-lookup
 * commands: `symbol`, `ref`, `refs` (its non-`::` plain-path branch), and
 * `semantic`.
 *
 * Faithful 1:1 TypeScript port of src/token_goat/cli.py lines 126–741 (the
 * module-level helper block), 1456–1518 (`_keyword_fallback_hits`), and the
 * four command bodies (symbol 742–1272, ref 1274–1324, refs 1326–1454,
 * semantic 1521–1776).
 *
 * Unlike the other 17 batch-A commands (thin wrappers that delegate to
 * `read_commands`), these four carry their logic INLINE in `cli.py`, so they
 * need their own TS home (this file) plus the ported helper block.
 *
 * Output seam (Python `typer.echo` / `raise typer.Exit`) routes through
 * cli_common.ts (`_echo` / `_error` / `_warn` / `CliExit`) — identical to
 * read_commands.ts. Internal helpers invoked from this module are called via
 * `self.fnName(...)` (a static `import * as self`) so tests that `vi.spyOn`
 * these boundaries observe the patched implementation (the ESM live-binding
 * analogue of Python module-attribute monkeypatching).
 */
import * as fs from "node:fs";
import * as path from "node:path";

import * as db from "./db.js";
import * as embeddings from "./embeddings.js";
import * as parser from "./parser.js";
import * as read_commands from "./read_commands.js";
import * as paths from "./paths.js";
import { find_project, make_project_at } from "./project.js";
import type { Project } from "./project.js";
import { get_close_matches } from "./difflib.js";
import { render_list } from "./render/common.js";
import { _echo, _error, _warn, CliExit } from "./cli_common.js";
import { getLogger } from "./util.js";
import { roundHalfEven } from "./skill_cache.js";

import * as self from "./cli_lookup.js";

const _LOG = getLogger("cli_lookup");

// ---------------------------------------------------------------------------
// Python-semantics parity helpers
// ---------------------------------------------------------------------------

/**
 * Reproduce Python `str.splitlines()`: split on universal newlines and DROP a
 * trailing empty element (a final "\n" does NOT yield a trailing "").
 */
function _splitlines(s: string): string[] {
  if (s === "") return [];
  const parts = s.split(/\r\n|\r|\n|\v|\f|\x1c|\x1d|\x1e|\x85|\u2028|\u2029/);
  if (parts.length > 0 && parts[parts.length - 1] === "") parts.pop();
  return parts;
}

/** Byte length of a string as UTF-8 (Python `len(s.encode())`). */
function _byteLen(s: string): number {
  return Buffer.byteLength(s, "utf-8");
}

/** Python `repr()` of a string (single-quote preferred). */
function _pyRepr(s: string): string {
  const hasSingle = s.includes("'");
  const hasDouble = s.includes('"');
  let quote = "'";
  if (hasSingle && !hasDouble) {
    quote = '"';
  }
  let out = "";
  for (const ch of s) {
    if (ch === "\\") out += "\\\\";
    else if (ch === quote) out += "\\" + quote;
    else if (ch === "\n") out += "\\n";
    else if (ch === "\r") out += "\\r";
    else if (ch === "\t") out += "\\t";
    else out += ch;
  }
  return `${quote}${out}${quote}`;
}

/**
 * Python `f"{x:.4f}"` — fixed 4-decimal formatting with banker's-half-even
 * rounding (Python's default round mode for `format`). JS `Number.toFixed` is
 * half-away-from-zero, which diverges on exact half-pennies; port the
 * true-decimal rounding via scaled integer math.
 */
function _toFixed4(x: number): string {
  if (!Number.isFinite(x)) {
    return x > 0 ? "inf" : x < 0 ? "-inf" : "nan";
  }
  // Python f"{x:.4f}" rounds half-to-even on the TRUE decimal expansion and
  // pads to exactly 4 fractional digits. The scaled-integer `x*1e4` approach is
  // NOT faithful (float scaling discards the tie-break — see skill_cache's
  // coverage_ratio bug). roundHalfEven rounds on the true `toFixed` expansion
  // (0-divergence vs CPython, shared with skill_cache); the result is already at
  // 4 decimals so toFixed(4) just pads unambiguously. Semantic distances are
  // always >= 0, so there is no negative-zero concern.
  return roundHalfEven(x, 4).toFixed(4);
}

/** True when *err* is a SQLite operational/DB error (better-sqlite3 analogue). */
function _isOperationalError(err: unknown): boolean {
  const code = (err as { code?: unknown } | null)?.code;
  if (typeof code === "string" && code.startsWith("SQLITE_")) return true;
  if (err instanceof db.DBError) return true;
  const msg = (err as { message?: unknown } | null)?.message;
  if (typeof msg === "string" && /not found/.test(msg)) return true;
  return false;
}

// ---------------------------------------------------------------------------
// Constants (Python cli.py:204–215, 249, 531, 598–608)
// ---------------------------------------------------------------------------

// Close-match thresholds for "did you mean…?" suggestions on a symbol miss.
export const _SYMBOL_DIDYOUMEAN_LIMIT = 5;
export const _SYMBOL_DIDYOUMEAN_CUTOFF = 0.6;
// Confidence cutoff for the auto-redirect path (fires on near-typos only).
export const _SYMBOL_AUTO_REDIRECT_CUTOFF = 0.85;
// Hard ceiling on rows pulled into memory for fuzzy matching.
export const _SYMBOL_DIDYOUMEAN_POOL = 50_000;
// How recently a file must have been modified to qualify for on-the-fly parse.
export const _INLINE_INDEX_RECENCY_SECS = 60;

export const _SYMBOL_KIND_ALIASES: ReadonlyMap<string, readonly string[]> = new Map([
  ["fn", ["function"]],
  ["func", ["function"]],
  ["class", ["class"]],
  ["method", ["method"]],
  ["const", ["const"]],
  ["interface", ["interface"]],
  ["enum", ["enum"]],
  ["var", ["var"]],
  ["type", ["type"]],
]);

// ---------------------------------------------------------------------------
// Close-match + pool helpers (Python cli.py:218–327)
// ---------------------------------------------------------------------------

/**
 * Return the unambiguous high-confidence close match, or null. Fires only when
 * exactly one candidate is at/above the redirect cutoff and it is not the
 * exact query itself.
 */
export function _auto_redirect_target(name: string, candidate_pool: readonly string[]): string | null {
  if (candidate_pool.length === 0 || !name) return null;
  const highConf = get_close_matches(name, candidate_pool, 2, _SYMBOL_AUTO_REDIRECT_CUTOFF);
  if (highConf.length !== 1) return null;
  const target = highConf[0]!;
  if (target === name) return null;
  return target;
}

/** Return the deduplicated symbol-name pool for *proj_hash*, capped at 50k. */
export function _project_symbol_pool(proj_hash: string): string[] {
  try {
    const rows = db.openProjectReadonly(proj_hash, (conn) => {
      return conn
        .prepare("SELECT DISTINCT name FROM symbols WHERE name IS NOT NULL LIMIT ?")
        .all(_SYMBOL_DIDYOUMEAN_POOL) as Array<{ name: string | null }>;
    });
    const out: string[] = [];
    for (const r of rows) {
      if (r.name) out.push(r.name);
    }
    return out;
  } catch (exc) {
    if (!_isOperationalError(exc)) {
      _LOG.debug("symbol pool query failed for project %s: %s", proj_hash.slice(0, 8), exc);
    } else {
      _LOG.debug("symbol pool query failed for project %s: %s", proj_hash.slice(0, 8), exc);
    }
    return [];
  }
}

/** Up to _SYMBOL_DIDYOUMEAN_LIMIT close matches for *name* in this project. */
export function _project_close_symbol_matches(proj_hash: string, name: string): string[] {
  const names = self._project_symbol_pool(proj_hash);
  return get_close_matches(name, names, _SYMBOL_DIDYOUMEAN_LIMIT, _SYMBOL_DIDYOUMEAN_CUTOFF);
}

/** Return the deduplicated symbol-name pool across the global index, capped. */
export function _global_symbol_pool(): string[] {
  try {
    const rows = db.openGlobalReadonly((gconn) => {
      return gconn
        .prepare("SELECT DISTINCT name FROM symbols_global WHERE name IS NOT NULL LIMIT ?")
        .all(_SYMBOL_DIDYOUMEAN_POOL) as Array<{ name: string | null }>;
    });
    const out: string[] = [];
    for (const r of rows) {
      if (r.name) out.push(r.name);
    }
    return out;
  } catch (exc) {
    _LOG.debug("global symbol pool query failed: %s", exc);
    return [];
  }
}

/** Up to _SYMBOL_DIDYOUMEAN_LIMIT close matches for *name* across all projects. */
export function _global_close_symbol_matches(name: string): string[] {
  const names = self._global_symbol_pool();
  return get_close_matches(name, names, _SYMBOL_DIDYOUMEAN_LIMIT, _SYMBOL_DIDYOUMEAN_CUTOFF);
}

// ---------------------------------------------------------------------------
// DB helpers (Python cli.py:330–455)
// ---------------------------------------------------------------------------

/** Run a SELECT against the project DB, exiting on DBError. */
export function _query_project(
  proj_hash: string,
  sql: string,
  params: readonly unknown[],
): Array<Record<string, unknown>> {
  try {
    return db.openProject(proj_hash, (conn) => {
      return conn.prepare(sql).all(...params) as Array<Record<string, unknown>>;
    });
  } catch (exc) {
    if (exc instanceof db.DBError || _isOperationalError(exc)) {
      _error(`project index unavailable: ${exc}. Run \`token-goat index --full\` to rebuild.`);
      throw new CliExit(1);
    }
    throw exc;
  }
}

/** Sum of files.size for the given file_rels in one project (best-effort). */
export function _sum_file_sizes(project_hash: string, file_rels: readonly string[]): number {
  if (file_rels.length === 0 || !project_hash) return 0;
  try {
    const unique_rels = Array.from(new Set(file_rels));
    const placeholders = unique_rels.map(() => "?").join(",");
    const sql = `SELECT COALESCE(SUM(size), 0) AS total FROM files WHERE rel_path IN (${placeholders})`;
    const row = db.openProjectReadonly(project_hash, (conn) => {
      return conn.prepare(sql).get(...unique_rels) as { total: number } | undefined;
    });
    return row ? Number(row.total) : 0;
  } catch (exc) {
    _LOG.debug(
      "_sum_file_sizes failed project=%s: %s",
      project_hash.slice(0, 8) || "",
      exc,
    );
    return 0;
  }
}

/** Sum of files.size for every file in *project_hash* (best-effort). */
export function _total_project_bytes(project_hash: string): number {
  if (!project_hash) return 0;
  try {
    const row = db.openProjectReadonly(project_hash, (conn) => {
      return conn.prepare("SELECT COALESCE(SUM(size), 0) AS total FROM files").get() as
        | { total: number }
        | undefined;
    });
    return row ? Number(row.total) : 0;
  } catch (exc) {
    _LOG.debug("_total_project_bytes failed project=%s: %s", project_hash.slice(0, 8) || "", exc);
    return 0;
  }
}

/**
 * Record an adoption-tracking stat for a CLI lookup command. Best-effort: a DB
 * error must never block the user-visible command output.
 */
export function _record_lookup_stat(
  kind: string,
  query_text: string,
  result_count: number,
  opts: { scope: string; project_hash?: string; bytes_saved?: number },
): void {
  const scope = opts.scope;
  const project_hash = opts.project_hash;
  const bytes_saved = opts.bytes_saved ?? 0;
  try {
    // Detail capped to ~200 chars (Python truncates query_text[:180] + "…").
    const q = [...query_text].slice(0, 180).join("") + (query_text.length > 180 ? "…" : "");
    const detail = `q=${_pyRepr(q)} scope=${scope} hits=${result_count}`;
    const tokens_saved = bytes_saved > 0 ? Math.max(1, Math.floor(bytes_saved / 3) + 1) : 0;
    db.recordStat(project_hash, kind, {
      bytesSaved: bytes_saved,
      tokensSaved: tokens_saved,
      detail,
    });
  } catch (exc) {
    _LOG.debug("record lookup stat failed kind=%s: %s", kind, exc);
  }
}

// ---------------------------------------------------------------------------
// Inline symbol search (Python cli.py:534–595)
// ---------------------------------------------------------------------------

/**
 * Parse recently-modified unindexed files and search for *name*.
 *
 * Async because `index_file` is async (tree-sitter grammar adapters resolve
 * asynchronously). Returns an empty list on any error.
 */
export async function _inline_symbol_search(
  name: string,
  proj: Project,
  opts: { kind_filter?: readonly string[] | null } = {},
): Promise<Array<Record<string, unknown>>> {
  const kind_filter = opts.kind_filter ?? null;
  try {
    const is_glob = self._is_glob_pattern(name);
    const cutoff = Date.now() / 1000 - _INLINE_INDEX_RECENCY_SECS;
    const results: Array<Record<string, unknown>> = [];
    const root = proj.root;
    const candidates = _walkKnownFiles(root);
    for (const candidate of candidates) {
      const rel = path.relative(root, candidate).split(path.sep).join("/");
      const parts = rel.split("/");
      // Skip if any path component is a SKIP_DIR.
      if (parts.some((p) => parser.SKIP_DIRS.has(p))) continue;
      const suffix = path.extname(candidate).toLowerCase();
      const basename = path.basename(candidate).toLowerCase();
      if (!parser._KNOWN_BASENAMES.has(basename) && !parser._KNOWN_EXTENSIONS.has(suffix)) {
        continue;
      }
      try {
        const st = fs.statSync(candidate);
        if (st.mtimeMs / 1000 < cutoff) continue;
      } catch {
        continue;
      }
      const fi = await parser.index_file(proj, candidate);
      if (fi === null) continue;
      for (const sym of fi.symbols) {
        const nameMatch = is_glob
          ? _fnmatchCase(sym.name, name)
          : sym.name === name;
        if (!nameMatch) continue;
        if (kind_filter && !kind_filter.includes(sym.kind)) continue;
        results.push({
          file: fi.rel_path,
          line: sym.line,
          kind: sym.kind,
          name: sym.name,
          signature: sym.signature,
          not_indexed: true,
        });
      }
    }
    return self._rank_symbol_results(results, name);
  } catch (exc) {
    _LOG.debug("_inline_symbol_search failed for %s: %s", name, exc);
    return [];
  }
}

/** Recursively walk files under *root* (returns absolute paths). */
function _walkKnownFiles(root: string): string[] {
  const out: string[] = [];
  const stack: string[] = [root];
  while (stack.length > 0) {
    const dir = stack.pop()!;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!parser.SKIP_DIRS.has(entry.name)) {
          stack.push(full);
        }
      } else if (entry.isFile()) {
        out.push(full);
      }
    }
  }
  return out;
}

/** Case-sensitive glob match (Python fnmatch.fnmatchcase). Supports * and ?. */
export function _fnmatchCase(name: string, pattern: string): boolean {
  // Translate the glob to a regex. fnmatch translates * → .*, ? → ., and
  // escapes all other regex metacharacters (including [ ] when not a class).
  let re = "^";
  for (const ch of pattern) {
    if (ch === "*") re += ".*";
    else if (ch === "?") re += ".";
    else re += ch.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }
  re += "$";
  return new RegExp(re).test(name);
}

// ---------------------------------------------------------------------------
// Kind filter / glob / ranking helpers (Python cli.py:611–693)
// ---------------------------------------------------------------------------

/** Expand user-supplied --type values to canonical DB kind strings. */
export function _symbol_kind_filter(types: readonly string[]): string[] {
  const out: string[] = [];
  for (const t of types) {
    const aliases = self._SYMBOL_KIND_ALIASES.get(t.toLowerCase());
    if (aliases) {
      out.push(...aliases);
    } else {
      out.push(t.toLowerCase());
    }
  }
  // Dedup preserving order (Python list(dict.fromkeys(out))).
  return Array.from(new Set(out));
}

/** True when *query* contains a glob wildcard (* or ?). */
export function _is_glob_pattern(query: string): boolean {
  return query.includes("*") || query.includes("?");
}

/** Translate a glob query to a SQL LIKE pattern (escape % and _ first). */
export function _glob_to_sql_like(query: string): string {
  const escaped = query.replace(/%/g, "\\%").replace(/_/g, "\\_");
  return escaped.replace(/\*/g, "%").replace(/\?/g, "_");
}

/**
 * Sort results by match tier: exact name → prefix → substring. Within each
 * tier, non-test files rank above test files. Wildcard queries skip tiering.
 */
export function _rank_symbol_results(
  results: Array<Record<string, unknown>>,
  query: string,
): Array<Record<string, unknown>> {
  if (self._is_glob_pattern(query)) return results;
  const q_lower = query.toLowerCase();
  const _sortKey = (row: Record<string, unknown>): [number, number] => {
    const n = String(row["name"] ?? "").toLowerCase();
    let tier: number;
    if (n === q_lower) tier = 0;
    else if (n.startsWith(q_lower)) tier = 1;
    else tier = 2;
    const file_path = String(row["file"] ?? "");
    const is_test = self._is_test_path(file_path);
    return [tier, is_test ? 1 : 0];
  };
  // Array.prototype.sort is stable in modern engines — preserves DB order on ties.
  return results.slice().sort((a, b) => {
    const ka = _sortKey(a);
    const kb = _sortKey(b);
    if (ka[0] !== kb[0]) return ka[0] - kb[0];
    return ka[1] - kb[1];
  });
}

/** True when *file_path* looks like a test or spec file. */
export function _is_test_path(file_path: string): boolean {
  const normed = file_path.replace(/\\/g, "/");
  const parts = normed.split("/");
  const testDirs = new Set(["tests", "test", "spec", "__tests__"]);
  for (let i = 0; i < parts.length - 1; i++) {
    if (testDirs.has(parts[i]!.toLowerCase())) return true;
  }
  const basename = parts.length > 0 ? parts[parts.length - 1]!.toLowerCase() : "";
  if (basename.startsWith("test_")) return true;
  const testSuffixes = [
    "_test.py",
    "_test.go",
    "_spec.rb",
    ".test.ts",
    ".test.js",
    ".spec.ts",
    ".spec.js",
    ".test.tsx",
    ".spec.tsx",
  ];
  return testSuffixes.some((s) => basename.endsWith(s));
}

// ---------------------------------------------------------------------------
// JSON snippet enrichment (Python cli.py:696–740)
// ---------------------------------------------------------------------------

/**
 * Extract a short source snippet for a symbol for JSON output. Returns the
 * first *max_snippet_lines* lines of the symbol's body, trailing-whitespace
 * stripped and blank-only lines omitted. Returns null if unreadable.
 */
export function _symbol_json_snippet(
  proj_root: string,
  file_rel: string,
  line: number,
  end_line: number | null,
  max_snippet_lines = 8,
): string | null {
  let src: string;
  try {
    src = fs.readFileSync(path.join(proj_root, file_rel), "utf-8");
  } catch {
    return null;
  }
  const src_lines = _splitlines(src);
  const start_idx = Math.max(0, line - 1);
  const stop_idx = Math.min(src_lines.length, end_line ? end_line : start_idx + max_snippet_lines);
  const chunk = src_lines.slice(start_idx, stop_idx).slice(0, max_snippet_lines);
  // Drop trailing blank lines (Python while chunk and not chunk[-1].strip()).
  while (chunk.length > 0 && chunk[chunk.length - 1]!.trim() === "") {
    chunk.pop();
  }
  return chunk.length > 0 ? chunk.join("\n") : null;
}

/** Mutate *results* in-place: add symbol + snippet keys for JSON output. */
export function _enrich_symbols_with_snippets(
  results: Array<Record<string, unknown>>,
  proj_root: string,
  end_lines: Map<string, number | null>,
): void {
  for (const r of results) {
    if (!("symbol" in r)) r["symbol"] = r["name"] ?? "";
    const file = String(r["file"] ?? "");
    const lineNum = Number(r["line"] ?? 0);
    const end_line = end_lines.get(`${file}\u0000${lineNum}`) ?? null;
    r["snippet"] = self._symbol_json_snippet(proj_root, file, lineNum, end_line);
  }
}

// ---------------------------------------------------------------------------
// keyword fallback (Python cli.py:1456–1518)
// ---------------------------------------------------------------------------

/**
 * Keyword grep fallback when embeddings are unavailable. Tokenises the query
 * into words (>=3 chars), builds a case-insensitive pattern from the first two
 * distinct tokens, and scans indexed project files for matching lines.
 */
export function _keyword_fallback_hits(
  proj: Project,
  query: string,
  k: number,
): Array<Record<string, unknown>> {
  const tokens = (query.match(/\w+/g) ?? [])
    .map((w) => w.toLowerCase())
    .filter((w) => [...w].length >= 3);
  if (tokens.length === 0) return [];

  // OR-pattern from up to two distinct tokens.
  const distinct: string[] = Array.from(new Set(tokens.slice(0, 2)));
  const pattern = new RegExp(
    distinct.map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|"),
    "i",
  );

  let file_rows: Array<{ rel_path: string }>;
  try {
    file_rows = db.openProjectReadonly(proj.hash, (conn) => {
      return conn.prepare("SELECT rel_path FROM files ORDER BY rel_path").all() as Array<{
        rel_path: string;
      }>;
    });
  } catch {
    return [];
  }

  const results: Array<Record<string, unknown>> = [];
  for (const frow of file_rows) {
    if (results.length >= k) break;
    const rel = frow.rel_path;
    let text: string;
    try {
      text = fs.readFileSync(path.join(proj.root, rel), "utf-8");
    } catch {
      continue;
    }
    const lines = _splitlines(text);
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]!;
      if (pattern.test(line)) {
        const snippet = [...line.trim()].slice(0, 120).join("");
        results.push({
          file: rel,
          start: i + 1,
          end: i + 1,
          kind: "keyword",
          distance: 0.0,
          preview: snippet,
        });
        if (results.length >= k) break;
      }
    }
  }
  return results;
}

// ===========================================================================
// Command implementations
// ===========================================================================

/** Options shape for the symbol command. */
export interface SymbolOpts {
  all_projects?: boolean;
  as_json?: boolean;
  limit?: number;
  strict?: boolean;
  show_refs?: boolean;
  filter_types?: readonly string[];
  full?: boolean;
  quiet?: boolean;
  context_lines?: number;
  /** The optional positional file scope. */
  file?: string | null;
}

/**
 * Find a symbol definition by name.
 *
 * Port of cli.py `symbol` (742–1272). Emits via the shared cli_common seam and
 * throws CliExit(code) where Python does `raise typer.Exit(code)`.
 */
export async function symbol(name: string, opts: SymbolOpts = {}): Promise<void> {
  const all_projects = opts.all_projects ?? false;
  const as_json = opts.as_json ?? false;
  const limit = opts.limit ?? 50;
  const strict = opts.strict ?? false;
  const show_refs = opts.show_refs ?? false;
  const full = opts.full ?? false;
  void full; // accepted but has no effect on the search itself (parity comment).
  const quiet = opts.quiet ?? false;
  const context_lines = opts.context_lines ?? 0;
  const file = opts.file ?? null;

  const kind_filter = opts.filter_types && opts.filter_types.length > 0 ? self._symbol_kind_filter(opts.filter_types) : [];
  const is_glob = self._is_glob_pattern(name);

  const _file_needle = file ? file.replace(/\\/g, "/").toLowerCase() : null;
  // Pre-built SQL LIKE pattern: escape % and _ so the needle matches literally,
  // then wrap %...%. Backslashes already normalized to /, so '\' is a safe ESCAPE.
  let _file_like_param: string | null = null;
  if (_file_needle !== null) {
    const _escaped_needle = _file_needle
      .replace(/\\/g, "\\\\")
      .replace(/%/g, "\\%")
      .replace(/_/g, "\\_");
    _file_like_param = `%${_escaped_needle}%`;
  }

  const _apply_file_scope = (
    rows: Array<Record<string, unknown>>,
  ): Array<Record<string, unknown>> => {
    if (_file_needle === null) return rows;
    return rows.filter((r) => {
      const f = String(r["file"] ?? "").replace(/\\/g, "/").toLowerCase();
      return f.includes(_file_needle);
    });
  };

  const use_tty_color = process.stdout.isTTY === true && !as_json;

  const _context_block = (
    row: Record<string, unknown>,
    n: number,
    projRootOverride: string | null,
  ): string[] | null => {
    let proj_root: string;
    if (projRootOverride !== null) {
      proj_root = projRootOverride;
    } else {
      proj_root = proj!.root;
    }
    const file_rel = String(row["file"] ?? "");
    const sym_start = Number(row["line"] ?? 1);
    const sym_end_raw = row["end_line"];
    const sym_end = sym_end_raw ? Number(sym_end_raw) : sym_start;

    let src: string;
    try {
      src = fs.readFileSync(path.join(proj_root, file_rel), "utf-8");
    } catch {
      return null;
    }
    const src_lines = _splitlines(src);
    const total = src_lines.length;
    const first_idx = Math.max(0, sym_start - 1 - n);
    const last_idx = Math.min(total, sym_end + n); // exclusive

    const output: string[] = [];
    for (let i = first_idx; i < last_idx; i++) {
      const lineno = i + 1;
      const text = src_lines[i] ?? "";
      const is_body = sym_start <= lineno && lineno <= sym_end;
      if (use_tty_color) {
        const marker = is_body ? " " : ">";
        output.push(`${marker}${String(lineno).padStart(6)}: ${text}`);
      } else {
        output.push(`${String(lineno).padStart(6)}: ${text}`);
      }
    }
    return output;
  };

  const _fmt_plain = (rows: Array<Record<string, unknown>>): void => {
    for (const row of rows) {
      const project_prefix =
        row["project"] !== undefined ? `[${row["project"]}] ` : "";
      const sig_part = row["signature"] ? `  ${row["signature"]}` : "";
      let kind_name = `${row["kind"]} ${row["name"]}`;
      const not_indexed_suffix = row["not_indexed"] ? " (not yet indexed)" : "";
      const ref_count = row["ref_count"];
      let ref_suffix = ref_count !== undefined && ref_count !== null ? `  [${ref_count} refs]` : "";
      if (use_tty_color) {
        kind_name = `[90m${kind_name}[0m`;
        let colored_sig = sig_part;
        if (sig_part) colored_sig = `[2m${sig_part}[0m`;
        let colored_not_indexed = not_indexed_suffix;
        if (not_indexed_suffix) colored_not_indexed = `[33m${not_indexed_suffix}[0m`;
        let colored_ref = ref_suffix;
        if (ref_suffix) colored_ref = `[36m${ref_suffix}[0m`;
        _echo(
          `${project_prefix}${row["file"]}:${row["line"]}: ${kind_name}${colored_sig}${colored_ref}${colored_not_indexed}`,
        );
      } else {
        _echo(
          `${project_prefix}${row["file"]}:${row["line"]}: ${kind_name}${sig_part}${ref_suffix}${not_indexed_suffix}`,
        );
      }
      if (context_lines > 0) {
        const block = _context_block(row, context_lines, row["project"] !== undefined ? String(row["project"]) : null);
        if (block) _echo(block.join("\n"));
      }
    }
  };

  const _emit_results = (
    results: Array<Record<string, unknown>>,
    emitOpts: {
      not_found_extra?: string | null;
      close_matches?: string[];
      redirected_from?: string | null;
      over_cap_hint?: string | null;
      file_scope_hint?: string | null;
    } = {},
  ): void => {
    const not_found_extra = emitOpts.not_found_extra ?? null;
    const close_matches = emitOpts.close_matches ?? [];
    const redirected_from = emitOpts.redirected_from ?? null;
    const over_cap_hint = emitOpts.over_cap_hint ?? null;
    const file_scope_hint = emitOpts.file_scope_hint ?? null;

    if (as_json) {
      if (context_lines > 0 && results.length > 0) {
        for (const r of results) {
          const block = _context_block(r, context_lines, r["project"] !== undefined ? String(r["project"]) : null);
          if (block !== null) r["context"] = block.join("\n");
        }
      }
      const envelope: Record<string, unknown> = {
        query: name,
        results,
        total: results.length,
      };
      if (redirected_from !== null) envelope["redirected_from"] = redirected_from;
      if (file && results.length === 0 && over_cap_hint !== null) {
        envelope["over_cap"] = over_cap_hint;
      }
      if (file && results.length === 0 && file_scope_hint !== null) {
        envelope["file_hint"] = file_scope_hint;
      }
      _echo(JSON.stringify(envelope));
    } else if (results.length > 0) {
      if (redirected_from !== null) {
        let marker = `(redirected from: ${_pyRepr(redirected_from)})`;
        if (use_tty_color) marker = `[33m${marker}[0m`;
        _echo(marker);
      }
      _fmt_plain(results);
    } else {
      if (!quiet) {
        if (file) {
          if (over_cap_hint) {
            _echo(over_cap_hint);
          } else {
            _echo(`No symbol ${_pyRepr(name)} found in files matching ${_pyRepr(file)}`);
            if (file_scope_hint) _echo(file_scope_hint);
          }
        } else {
          _echo(not_found_extra ? not_found_extra : `No matches for ${_pyRepr(name)}`);
          if (close_matches.length > 0 && !not_found_extra) {
            _echo("Did you mean:");
            _echo(render_list(close_matches, "", "-"));
          }
        }
      }
    }
  };

  const _global_query = (target: string): Array<Record<string, unknown>> => {
    const _is_glob_q = self._is_glob_pattern(target);
    const name_op = _is_glob_q ? "LIKE" : "=";
    const name_param = _is_glob_q ? self._glob_to_sql_like(target) : target;
    let kind_clause = "";
    const kind_params: unknown[] = [];
    if (kind_filter.length > 0) {
      const placeholders = kind_filter.map(() => "?").join(",");
      kind_clause = ` AND sg.kind IN (${placeholders})`;
      kind_params.push(...kind_filter);
    }
    let file_clause = "";
    const file_params: unknown[] = [];
    if (_file_like_param !== null) {
      file_clause = " AND sg.file_rel LIKE ? ESCAPE '\\'";
      file_params.push(_file_like_param);
    }
    const sql =
      "SELECT sg.project_hash, p.root, sg.name, sg.kind, sg.file_rel, sg.line, sg.signature " +
      "FROM symbols_global sg " +
      "JOIN projects p ON p.hash = sg.project_hash " +
      `WHERE sg.name ${name_op} ?${kind_clause}${file_clause} LIMIT ?`;
    let rows_raw_inner: Array<Record<string, unknown>>;
    try {
      rows_raw_inner = db.openGlobal((gconn) => {
        return gconn.prepare(sql).all(name_param, ...kind_params, ...file_params, limit) as Array<
          Record<string, unknown>
        >;
      });
    } catch (exc) {
      if (exc instanceof db.DBError || _isOperationalError(exc)) {
        _error(`global index unavailable: ${exc}. Run \`token-goat index\` first.`);
        throw new CliExit(1);
      }
      throw exc;
    }
    const raw = rows_raw_inner.map((r) => ({
      project: r["root"],
      file: r["file_rel"],
      line: r["line"],
      kind: r["kind"],
      name: r["name"],
      signature: r["signature"],
    }));
    return self._rank_symbol_results(raw, target);
  };

  if (all_projects) {
    let results: Array<Record<string, unknown>>;
    try {
      results = _global_query(name);
    } catch (exc) {
      if (exc instanceof CliExit) throw exc;
      if (exc instanceof db.DBError || _isOperationalError(exc)) {
        _error(`global index unavailable: ${exc}. Run \`token-goat index\` first.`);
        throw new CliExit(1);
      }
      throw exc;
    }

    let close: string[] = [];
    let redirected: string | null = null;
    if (results.length === 0 && !is_glob) {
      const pool = self._global_symbol_pool();
      if (!strict) {
        const redirect_target = self._auto_redirect_target(name, pool);
        if (redirect_target !== null) {
          try {
            const redirect_results = _global_query(redirect_target);
            if (redirect_results.length > 0) {
              results = redirect_results;
              redirected = name;
              _LOG.info("symbol --all-projects: auto-redirected %s -> %s", name, redirect_target);
            }
          } catch (exc) {
            if (exc instanceof CliExit) throw exc;
            if (exc instanceof db.DBError || _isOperationalError(exc)) {
              _error(`global index unavailable: ${exc}. Run \`token-goat index\` first.`);
              throw new CliExit(1);
            }
            throw exc;
          }
        }
      }
      if (results.length === 0) {
        close = get_close_matches(name, pool, _SYMBOL_DIDYOUMEAN_LIMIT, _SYMBOL_DIDYOUMEAN_CUTOFF);
      }
    }

    // Savings: aggregate file sizes across results' source files.
    let _sym_bytes_saved = 0;
    if (results.length > 0) {
      const results_by_proj = new Map<string, string[]>();
      for (const r of results) {
        const proj_root = String(r["project"] ?? "");
        if (!results_by_proj.has(proj_root)) results_by_proj.set(proj_root, []);
        results_by_proj.get(proj_root)!.push(String(r["file"] ?? ""));
      }
      let _sym_file_total = 0;
      for (const [proj_root, file_rels] of results_by_proj) {
        try {
          const ph_row = db.openGlobal((gconn) => {
            return gconn.prepare("SELECT hash FROM projects WHERE root = ?").get(proj_root) as
              | { hash: string }
              | undefined;
          });
          if (ph_row) {
            _sym_file_total += self._sum_file_sizes(ph_row.hash, file_rels);
          }
        } catch {
          // pass
        }
      }
      const _sym_output_bytes = Math.max(
        80 * results.length,
        _byteLen(JSON.stringify(results)),
      );
      _sym_bytes_saved = Math.max(0, _sym_file_total - _sym_output_bytes);
    }
    self._record_lookup_stat("symbol_lookup", name, results.length, {
      scope: "all_projects",
      bytes_saved: _sym_bytes_saved,
    });
    _emit_results(results, { close_matches: close, redirected_from: redirected });
    if (file && results.length === 0) throw new CliExit(1);
    return;
  }

  const proj = await self._require_project();

  const _project_query = (target: string): Array<Record<string, unknown>> => {
    const _is_glob_q = self._is_glob_pattern(target);
    const name_op = _is_glob_q ? "LIKE" : "=";
    const name_param = _is_glob_q ? self._glob_to_sql_like(target) : target;
    let kind_clause = "";
    const kind_params: unknown[] = [];
    if (kind_filter.length > 0) {
      const placeholders = kind_filter.map(() => "?").join(",");
      kind_clause = ` AND kind IN (${placeholders})`;
      kind_params.push(...kind_filter);
    }
    let file_clause = "";
    const file_params: unknown[] = [];
    if (_file_like_param !== null) {
      file_clause = " AND file_rel LIKE ? ESCAPE '\\'";
      file_params.push(_file_like_param);
    }
    const sql = `SELECT name, kind, file_rel, line, end_line, signature FROM symbols WHERE name ${name_op} ?${kind_clause}${file_clause} LIMIT ?`;
    const rows_raw_inner = self._query_project(proj.hash, sql, [
      name_param,
      ...kind_params,
      ...file_params,
      limit,
    ]);
    const raw = rows_raw_inner.map((r) => ({
      file: r["file_rel"],
      line: r["line"],
      end_line: r["end_line"] ?? null,
      kind: r["kind"],
      name: r["name"],
      signature: r["signature"],
    }));
    return self._rank_symbol_results(raw, target);
  };

  let results = _project_query(name);

  if (show_refs && results.length > 0) {
    let ref_count_val: number | null = null;
    try {
      const count_row = db.openProjectReadonly(proj.hash, (conn) => {
        return conn.prepare("SELECT COUNT(*) AS cnt FROM refs WHERE symbol_name = ?").get(name) as
          | { cnt: number }
          | undefined;
      });
      ref_count_val = count_row ? Number(count_row.cnt) : null;
    } catch {
      ref_count_val = null;
    }
    if (ref_count_val !== null) {
      for (const r of results) r["ref_count"] = ref_count_val;
    }
  }

  const hint = read_commands._not_indexed_hint(proj.hash);
  let inline_hit = false;
  let close: string[] = [];
  let redirected: string | null = null;
  if (results.length === 0 && !hint) {
    const inline = _apply_file_scope(
      await self._inline_symbol_search(name, proj, {
        kind_filter: kind_filter.length > 0 ? kind_filter : null,
      }),
    );
    if (inline.length > 0) {
      results = inline;
      inline_hit = true;
      _LOG.info(
        "symbol: inline fallback found %d match(es) for %s in recently-modified files",
        inline.length,
        name,
      );
    }
  }

  if (results.length === 0 && !hint && !inline_hit && !is_glob) {
    const pool = self._project_symbol_pool(proj.hash);
    if (!strict) {
      const redirect_target = self._auto_redirect_target(name, pool);
      if (redirect_target !== null) {
        const redirect_results = _project_query(redirect_target);
        if (redirect_results.length > 0) {
          results = redirect_results;
          redirected = name;
          _LOG.info(
            "symbol: auto-redirected %s -> %s in project %s",
            name,
            redirect_target,
            proj.hash.slice(0, 8),
          );
        }
      }
    }
    if (results.length === 0) {
      close = get_close_matches(name, pool, _SYMBOL_DIDYOUMEAN_LIMIT, _SYMBOL_DIDYOUMEAN_CUTOFF);
    }
  }

  // Enrich JSON output with symbol + snippet fields.
  if (as_json && results.length > 0) {
    const end_lines_map = new Map<string, number | null>();
    for (const r of results) {
      end_lines_map.set(`${r["file"]}\u0000${Number(r["line"])}`, (r["end_line"] as number | null) ?? null);
    }
    self._enrich_symbols_with_snippets(results, proj.root, end_lines_map);
  }

  // Savings: sum(file sizes) − compact metadata output size.
  const _sym_file_rels = results.map((r) => String(r["file"] ?? "")).filter((f) => f.length > 0);
  const _sym_file_total = self._sum_file_sizes(proj.hash, _sym_file_rels);
  const _sym_output_bytes = Math.max(80 * results.length, _byteLen(JSON.stringify(results)));
  const _sym_bytes_saved = Math.max(0, _sym_file_total - _sym_output_bytes);
  self._record_lookup_stat("symbol_lookup", name, results.length, {
    scope: "project",
    project_hash: proj.hash,
    bytes_saved: _sym_bytes_saved,
  });

  let not_found_extra = hint;
  if (inline_hit && !not_found_extra) not_found_extra = null;
  const over_cap_hint =
    file && results.length === 0 ? read_commands.over_cap_file_hint(file, proj) : null;
  let file_scope_hint: string | null = null;
  if (file && results.length === 0 && over_cap_hint === null && _file_like_param !== null) {
    const _matched_file = read_commands.resolve_scoped_file(proj.hash, _file_like_param);
    if (_matched_file !== null) {
      file_scope_hint = read_commands.skeleton_or_empty_hint(proj.hash, _matched_file);
    }
  }
  _emit_results(results, {
    not_found_extra,
    close_matches: close,
    redirected_from: redirected,
    over_cap_hint,
    file_scope_hint,
  });
  if (file && results.length === 0) throw new CliExit(1);
}

// ---------------------------------------------------------------------------
// ref command (Python cli.py:1274–1324)
// ---------------------------------------------------------------------------

/** Find all code references to a symbol by name. */
export async function ref(name: string, opts: { as_json?: boolean; limit?: number } = {}): Promise<void> {
  const as_json = opts.as_json ?? false;
  const limit = opts.limit ?? 100;
  const proj = await self._require_project();

  const rows_raw = self._query_project(
    proj.hash,
    "SELECT file_rel, line, col, context FROM refs WHERE symbol_name = ? LIMIT ?",
    [name, limit],
  );

  const results = rows_raw.map((r) => ({
    name,
    file: r["file_rel"],
    line: r["line"],
    col: r["col"],
    context: r["context"],
  }));

  if (as_json) {
    _echo(
      JSON.stringify({ query: name, results, total: results.length }),
    );
  } else if (results.length > 0) {
    const use_tty_color = process.stdout.isTTY === true;
    for (const row of results) {
      let ctx = row["context"] ? `  ${row["context"]}` : "";
      if (use_tty_color && ctx) ctx = `[2m${ctx}[0m`;
      _echo(`${row["file"]}:${row["line"]}: ref ${_pyRepr(name)}${ctx}`);
    }
  } else {
    const hint = read_commands._not_indexed_hint(proj.hash);
    if (hint) {
      _echo(hint);
    } else {
      _echo(`No references found for ${_pyRepr(name)}`);
    }
  }
}

// ---------------------------------------------------------------------------
// refs command (Python cli.py:1326–1454) — plain-path branch; :: delegates
// ---------------------------------------------------------------------------

/** Show all files and line numbers where a symbol is referenced. */
export async function refs(
  symbol_name: string,
  opts: {
    file?: string | null;
    limit?: number;
    as_json?: boolean;
    quiet?: boolean;
    show_callers?: boolean;
  } = {},
): Promise<void> {
  const file = opts.file ?? null;
  const limit = opts.limit ?? 50;
  const as_json = opts.as_json ?? false;
  const quiet = opts.quiet ?? false;
  const show_callers = opts.show_callers ?? false;

  // <file>::<symbol> format: delegate to targeted refs lookup (already ported).
  if (symbol_name.includes("::")) {
    read_commands.refs(symbol_name, { limit, json_output: as_json, callers: show_callers });
    return;
  }

  if (show_callers) {
    _echo(
      "--callers requires the <file>::<symbol> format " +
        "(e.g. 'src/auth.py::login --callers').  " +
        "Plain symbol refs do not resolve enclosing functions.",
      { err: true },
    );
    throw new CliExit(1);
  }

  const proj = await self._require_project();

  let rows_raw: Array<Record<string, unknown>>;
  if (file !== null) {
    rows_raw = self._query_project(
      proj.hash,
      "SELECT file_rel, line, col, context FROM refs " +
        "WHERE symbol_name = ? AND file_rel LIKE ? " +
        "ORDER BY file_rel, line LIMIT ?",
      [symbol_name, `%${file}%`, limit],
    );
  } else {
    rows_raw = self._query_project(
      proj.hash,
      "SELECT file_rel, line, col, context FROM refs " +
        "WHERE symbol_name = ? " +
        "ORDER BY file_rel, line LIMIT ?",
      [symbol_name, limit],
    );
  }

  const results = rows_raw.map((r) => ({
    symbol: symbol_name,
    file: r["file_rel"],
    line: r["line"],
    col: r["col"],
    context: r["context"],
  }));

  if (as_json) {
    _echo(
      JSON.stringify({ query: symbol_name, results, total: results.length }),
    );
    return;
  }

  if (results.length === 0) {
    const hint = read_commands._not_indexed_hint(proj.hash);
    if (hint) {
      if (!quiet) _echo(hint);
    } else if (file !== null) {
      if (!quiet) _echo(`No references to ${_pyRepr(symbol_name)} found in files matching ${_pyRepr(file)}`);
    } else {
      if (!quiet) _echo(`No references found for ${_pyRepr(symbol_name)}`);
    }
    return;
  }

  const use_tty_color = process.stdout.isTTY === true;
  for (const row of results) {
    const loc = `${row["file"]}:${row["line"]}`;
    const ctx = String(row["context"] ?? "");
    const ctx_stripped = ctx.trim();
    let ctx_part: string;
    if (ctx_stripped) {
      const sep = "  ";
      ctx_part = use_tty_color ? `${sep}[2m${ctx_stripped}[0m` : `${sep}${ctx_stripped}`;
    } else {
      ctx_part = "";
    }
    _echo(`${loc}${ctx_part}`);
  }
}

// ---------------------------------------------------------------------------
// semantic command (Python cli.py:1521–1776)
// ---------------------------------------------------------------------------

/** Semantic search using local embeddings (fastembed + sqlite-vec). */
export async function semantic(
  query: string,
  opts: {
    k?: number;
    json_output?: boolean;
    max_distance?: number;
    no_rerank?: boolean;
    compact?: boolean;
    all_projects?: boolean;
  } = {},
): Promise<void> {
  const k = opts.k ?? 8;
  const json_output = opts.json_output ?? false;
  const max_distance = opts.max_distance ?? -1.0;
  const no_rerank = opts.no_rerank ?? false;
  const compact = opts.compact ?? true;
  const all_projects = opts.all_projects ?? false;

  // Negative sentinel means "use library default"; >= 0 is an explicit threshold.
  const threshold: number = max_distance < 0 ? embeddings.DEFAULT_DISTANCE_THRESHOLD : max_distance;

  if (all_projects) {
    const project_hashes = db.listAllProjectHashes();
    if (project_hashes.length === 0) {
      _echo("(no indexed projects found — run `token-goat index` first)");
      throw new CliExit(0);
    }

    const all_hits: Array<[string, embeddings.SearchHit]> = []; // [project_root, hit]
    const seen_dedup = new Set<string>();
    for (const ph of project_hashes) {
      try {
        const row = db.openGlobalReadonly((gconn) => {
          return gconn.prepare("SELECT root FROM projects WHERE hash = ?").get(ph) as
            | { root: string }
            | undefined;
        });
        if (row === undefined) continue;
        const proj_root = String(row.root);
        const proj = make_project_at(proj_root);
        const proj_hits = embeddings.semantic_search(proj, query, {
          k,
          max_distance: threshold,
          boost_verbatim: !no_rerank,
          demote_generated: !no_rerank,
        });
        for (const h of proj_hits) {
          const dedup_key = `${ph}\u0000${h.file_rel}\u0000${h.start_line}`;
          if (!seen_dedup.has(dedup_key)) {
            seen_dedup.add(dedup_key);
            all_hits.push([proj_root, h]);
          }
        }
      } catch {
        // Skip projects without embeddings or unavailable DBs.
        continue;
      }
    }

    // Sort globally by effective distance, take top-k.
    all_hits.sort((a, b) => a[1].distance - b[1].distance);
    const top_hits = all_hits.slice(0, k);

    // Savings: aggregate file sizes across results' source files.
    let _sem_bytes_saved = 0;
    if (top_hits.length > 0) {
      const results_by_proj = new Map<string, string[]>();
      for (const [proj_root, h] of top_hits) {
        if (!results_by_proj.has(proj_root)) results_by_proj.set(proj_root, []);
        results_by_proj.get(proj_root)!.push(h.file_rel);
      }
      let _sem_file_total = 0;
      for (const [proj_root, file_rels] of results_by_proj) {
        try {
          const ph_row = db.openGlobal((gconn) => {
            return gconn.prepare("SELECT hash FROM projects WHERE root = ?").get(proj_root) as
              | { hash: string }
              | undefined;
          });
          if (ph_row) {
            _sem_file_total += self._sum_file_sizes(ph_row.hash, file_rels);
          }
        } catch {
          // pass
        }
      }
      const _sem_output_bytes = top_hits.reduce((sum, [, h]) => sum + _byteLen(h.text), 0);
      _sem_bytes_saved = Math.max(0, _sem_file_total - _sem_output_bytes);
    }
    self._record_lookup_stat("semantic_search", query, top_hits.length, {
      scope: "all_projects",
      bytes_saved: _sem_bytes_saved,
    });

    if (json_output) {
      const out = top_hits.map(([pr, h]) => ({
        project: pr,
        file: h.file_rel,
        start: h.start_line,
        end: h.end_line,
        kind: h.kind,
        distance: h.distance,
        preview: [...h.text].slice(0, 200).join(""),
      }));
      _echo(
        JSON.stringify({ query, results: out, total: out.length }),
      );
      return;
    }

    if (top_hits.length === 0) {
      _echo("(no results)");
      return;
    }

    for (const [proj_root, h] of top_hits) {
      if (compact) {
        const first_line = _firstNonblankLineOrSlice(h.text, 120);
        _echo(`[${proj_root}] ${h.file_rel}:${h.start_line} [${h.kind}]  ${first_line}`);
      } else {
        const preview = [...h.text.replace(/\n/g, " ")].slice(0, 120).join("");
        _echo(
          `[${proj_root}] ${h.file_rel}:${h.start_line}-${h.end_line} (${h.kind}, d=${_toFixed4(h.distance)})`,
        );
        _echo(`  ${preview}`);
      }
    }
    return;
  }

  const proj = await self._require_project();

  let hits: embeddings.SearchHit[];
  try {
    hits = embeddings.semantic_search(proj, query, {
      k,
      max_distance: threshold,
      boost_verbatim: !no_rerank,
      demote_generated: !no_rerank,
    });
  } catch (e) {
    if (e instanceof embeddings.EmbeddingsUnavailable) {
      _warn(
        `embeddings unavailable (${e.message || e}). Falling back to keyword search ` +
          "(run `token-goat index --embeddings` for full semantic search).",
      );
      const fallback = self._keyword_fallback_hits(proj, query, k);
      self._record_lookup_stat("semantic_search", query, fallback.length, {
        scope: "project",
        project_hash: proj.hash,
      });
      if (json_output) {
        const note = "(keyword fallback — embeddings not ready)";
        _echo(
          JSON.stringify({
            query,
            results: fallback,
            total: fallback.length,
            fallback: note,
          }),
        );
        return;
      }
      if (fallback.length === 0) {
        _echo("(no results)");
        return;
      }
      _echo("(keyword fallback — embeddings not ready)");
      for (const r of fallback) {
        const snippet = [...String(r["preview"] ?? "")].slice(0, 100).join("");
        _echo(`${r["file"]}:${r["start"]}  ${snippet}`);
      }
      return;
    }
    throw e;
  }

  // Savings: unique source files minus the snippet chunks actually returned.
  const _sem_file_rels = Array.from(new Set(hits.map((h) => h.file_rel)));
  const _sem_file_total = self._sum_file_sizes(proj.hash, _sem_file_rels);
  const _sem_output_bytes = hits.reduce((sum, h) => sum + _byteLen(h.text), 0);
  const _sem_bytes_saved = Math.max(0, _sem_file_total - _sem_output_bytes);
  self._record_lookup_stat("semantic_search", query, hits.length, {
    scope: "project",
    project_hash: proj.hash,
    bytes_saved: _sem_bytes_saved,
  });

  if (json_output) {
    const out = hits.map((h) => ({
      file: h.file_rel,
      start: h.start_line,
      end: h.end_line,
      kind: h.kind,
      distance: h.distance,
      preview: [...h.text].slice(0, 200).join(""),
    }));
    _echo(
      JSON.stringify({ query, results: out, total: out.length }),
    );
    return;
  }

  if (hits.length === 0) {
    _echo("(no results)");
    return;
  }

  if (compact) {
    for (const h of hits) {
      const first_line = _firstNonblankLineOrSlice(h.text, 120);
      _echo(`${h.file_rel}:${h.start_line} [${h.kind}]  ${first_line}`);
    }
  } else {
    for (const h of hits) {
      const preview = [...h.text.replace(/\n/g, " ")].slice(0, 120).join("");
      _echo(
        `${h.file_rel}:${h.start_line}-${h.end_line} (${h.kind}, d=${_toFixed4(h.distance)})`,
      );
      _echo(`  ${preview}`);
    }
  }
}

/** Return the first non-blank line (stripped), else a flat 120-cp slice. */
function _firstNonblankLineOrSlice(text: string, max_cps: number): string {
  for (const ln of _splitlines(text)) {
    const stripped = ln.trim();
    if (stripped) return [...stripped].slice(0, max_cps).join("");
  }
  return [...text.replace(/\n/g, " ")].slice(0, max_cps).join("");
}

// ---------------------------------------------------------------------------
// Shared project resolver (mirrors cli.ts `_require_project` but sync→async)
// ---------------------------------------------------------------------------

/**
 * Return the current project or exit with code 1. Lives here (not imported
 * from cli.ts) to avoid a cli_lookup → cli import cycle; cli.ts lazy-imports
 * this module instead.
 */
export async function _require_project(
  msg = "no project detected — run from a project directory",
): Promise<Project> {
  const proj = find_project(process.cwd());
  if (proj === null) {
    _error(msg);
    throw new CliExit(1);
  }
  return proj;
}

// paths import retained for parity with read_commands (used by future map cmd).
void paths;
