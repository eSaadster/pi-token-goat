/**
 * Semantic search using a pluggable embedding backend + sqlite-vec storage.
 *
 * 1:1 port of src/token_goat/embeddings.py.
 *
 * Port model — the two heavy Python dependencies have no bundled Node analogue,
 * so they are handled as fail-soft seams (the gdrive pattern):
 *  - **fastembed** (the ONNX model) is NOT ported. `is_available()` returns
 *    false by default (no Node model backend is bundled) and the real
 *    `embed_texts` path raises EmbeddingsUnavailable via `_get_model`. Both are
 *    exported and invoked through `import * as self`, so tests inject a
 *    deterministic stub with `vi.spyOn` exactly as the Python tests
 *    `monkeypatch.setattr(emb, "embed_texts", _stub_embed)` /
 *    `patch.object(emb, "is_available", …)`.
 *  - **sqlite-vec** (the `vec0` vector store) IS available: db.ts loads the
 *    optional `sqlite-vec` native extension, so the storage + KNN MATCH path
 *    runs for real. Both db.py and db.ts create the `embeddings` table as bare
 *    `vec0(chunk_id, embedding FLOAT[384])` with no `distance_metric`, so both
 *    default to L2 distance (on the L2-normalised vectors the model/stub emit,
 *    L2 is monotonic in cosine and sits in [0, 2] — matching the "cosine
 *    distance" the docstrings describe).
 *
 * Other seams: `array.array("f", vec).tobytes()` → `Buffer.from(Float32Array)`;
 * `db.open_project(h)`/`project_writer_lock` → the callback openers; sqlite3.Row
 * → plain better-sqlite3 rows; `cur.lastrowid` → `run().lastInsertRowid`;
 * `executemany` → a prepared-statement loop; `hashlib.sha256` → `node:crypto`;
 * `str.splitlines()`/`len(str)` (code points) via small `_py*` helpers.
 * `_load_existing_chunk_hashes` returns a `Map` keyed by a NUL-joined
 * `${file_rel}\u0000${start}\u0000${end}` string (the Python tuple key).
 */
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

import * as config from "./config.js";
import * as db from "./db.js";
import * as paths from "./paths.js";
import type { Project } from "./project.js";
import { getLogger } from "./util.js";

import * as self from "./embeddings.js";

// ---------------------------------------------------------------------------
// Public result type
// ---------------------------------------------------------------------------

/** Result of index_project_embeddings operation. Ported from the TypedDict. */
export interface EmbeddingsResult {
  files_visited: number;
  chunks_embedded: number;
  chunks_skipped_unchanged: number;
  duration_sec: number;
  model: string;
}

const _LOG = getLogger("embeddings");

export const DEFAULT_MODEL = "BAAI/bge-small-en-v1.5";
export const DEFAULT_DIM = 384;

export const MIN_CHUNK_CHARS = 50;
export const MAX_CHUNK_CHARS = 8000;

const WINDOW_LINES = 100;

export const _CODE_SYMBOL_KINDS: ReadonlySet<string> = new Set([
  // Universal code kinds
  "function", "method", "class", "interface",
  "trait", "type", "enum", "impl", "abi_export",
  // SQL schema kinds
  "sql_table", "sql_view", "sql_function", "sql_procedure",
  "sql_trigger", "sql_type", "sql_schema", "sql_index",
  // GraphQL kinds
  "graphql_type", "graphql_input", "graphql_interface", "graphql_enum",
  "graphql_union", "graphql_scalar", "graphql_directive", "graphql_fragment",
  "graphql_query", "graphql_mutation", "graphql_subscription", "graphql_extend",
  "graphql_schema",
  // Protocol Buffer kinds
  "proto_message", "proto_enum", "proto_service", "proto_rpc",
  "proto_oneof", "proto_extend",
  // CSS / SCSS / Less kinds
  "css_class", "css_id", "css_keyframes", "css_mixin", "css_atrule",
  "css_custom_property",
  // Makefile kinds
  "makefile_target", "makefile_define",
]);

export const _WINDOW_LANGS: ReadonlySet<string> = new Set([
  "typescript", "javascript", "python", "go", "rust",
  "sql", "graphql", "proto", "css", "makefile",
]);

// ---------------------------------------------------------------------------
// Search-time tunables
// ---------------------------------------------------------------------------

export const DEFAULT_DISTANCE_THRESHOLD = 1.2;

const _GENERATED_PATH_SEGMENTS: ReadonlySet<string> = new Set([
  "node_modules", "dist", "build", "__pycache__", ".next", ".nuxt",
  ".turbo", ".cache", "coverage", "out", "target", "vendor",
  ".venv", "venv", ".tox", "site-packages", "bower_components",
  ".pytest_cache", ".mypy_cache", ".ruff_cache",
]);

const _GENERATED_PATH_PENALTY = 0.5;

const _VERBATIM_TOKEN_BOOST = 0.05;
export const _MAX_VERBATIM_BOOST = 0.25;

const _MIN_TOKEN_LEN = 3;

const _OVER_FETCH_FACTOR = 4;
const _MAX_OVER_FETCH = 100;

// ---------------------------------------------------------------------------
// Errors + data classes
// ---------------------------------------------------------------------------

/** Raised when fastembed/model/sqlite-vec are not usable. */
export class EmbeddingsUnavailable extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EmbeddingsUnavailable";
  }
}

/** A contiguous code or text segment suitable for embedding (@dataclass Chunk). */
export class Chunk {
  file_rel: string;
  start_line: number;
  end_line: number;
  text: string;
  kind: string;

  constructor(file_rel: string, start_line: number, end_line: number, text: string, kind: string) {
    this.file_rel = file_rel;
    this.start_line = start_line;
    this.end_line = end_line;
    this.text = text;
    this.kind = kind;
  }
}

/** Result of a semantic search query against indexed chunks (@dataclass SearchHit). */
export class SearchHit {
  file_rel: string;
  start_line: number;
  end_line: number;
  kind: string;
  text: string;
  distance: number;

  constructor(args: {
    file_rel: string;
    start_line: number;
    end_line: number;
    kind: string;
    text: string;
    distance: number;
  }) {
    this.file_rel = args.file_rel;
    this.start_line = args.start_line;
    this.end_line = args.end_line;
    this.kind = args.kind;
    this.text = args.text;
    this.distance = args.distance;
  }
}

/** A symbol semantically similar to the query symbol (@dataclass SimilarSymbolHit). */
export class SimilarSymbolHit {
  file: string;
  name: string;
  kind: string;
  similarity_score: number;

  constructor(args: { file: string; name: string; kind: string; similarity_score: number }) {
    this.file = args.file;
    this.name = args.name;
    this.kind = args.kind;
    this.similarity_score = args.similarity_score;
  }
}

// ---------------------------------------------------------------------------
// Python-semantics helpers
// ---------------------------------------------------------------------------

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

/** Python `round(x, 2)` — round to 2 decimals, ties-to-even. */
function _round2(value: number): number {
  if (!Number.isFinite(value)) return value;
  const scaled = value * 100;
  const floor = Math.floor(scaled);
  const diff = scaled - floor;
  const EPS = 1e-9;
  let rounded: number;
  if (diff > 0.5 + EPS) rounded = floor + 1;
  else if (diff < 0.5 - EPS) rounded = floor;
  else rounded = floor % 2 === 0 ? floor : floor + 1;
  return rounded / 100;
}

/** Encode the (file_rel, start_line, end_line) tuple key as a NUL-joined string. */
function _chunkKey(file_rel: string, start_line: number, end_line: number): string {
  return `${file_rel}\u0000${start_line}\u0000${end_line}`;
}

/** A minimal better-sqlite3 connection shape (real conn + test fakes satisfy it). */
interface _Conn {
  prepare(sql: string): {
    all(...params: unknown[]): unknown[];
    get(...params: unknown[]): unknown;
    run(...params: unknown[]): { lastInsertRowid: number | bigint; changes: number };
  };
}

// ---------------------------------------------------------------------------
// Re-ranking helpers
// ---------------------------------------------------------------------------

/** Return True if any POSIX path segment of file_rel is a known generated/build dir. */
export function _is_generated_path(file_rel: string): boolean {
  if (!file_rel) return false;
  const segments = file_rel.replace(/\\/g, "/").split("/");
  return segments.some((seg) => _GENERATED_PATH_SEGMENTS.has(seg));
}

/** Tokenize the query into lowercase identifier-like tokens for verbatim boost. */
export function _extract_query_tokens(query: string): ReadonlySet<string> {
  if (!query) return new Set();
  const tokens = new Set<string>();
  const raw = query.toLowerCase().match(/\w+/g) ?? [];
  for (const tok of raw) {
    if (tok.length >= _MIN_TOKEN_LEN) tokens.add(tok);
  }
  // Split camelCase / PascalCase variants present in the original query.
  for (const tok of query.match(/\w+/g) ?? []) {
    const parts = tok.match(/[A-Z]?[a-z]+|[A-Z]+(?=[A-Z]|$)/g) ?? [];
    for (const part of parts) {
      const lower = part.toLowerCase();
      if (lower.length >= _MIN_TOKEN_LEN) tokens.add(lower);
    }
  }
  return tokens;
}

/** Return distance reduction (positive value) for verbatim token hits in text. */
export function _verbatim_boost(text: string, tokens: ReadonlySet<string>): number {
  if (tokens.size === 0 || !text) return 0.0;
  const textLower = text.toLowerCase();
  let hits = 0;
  for (const tok of tokens) if (textLower.includes(tok)) hits += 1;
  return Math.min(hits * _VERBATIM_TOKEN_BOOST, _MAX_VERBATIM_BOOST);
}

/** Merge consecutive same-file hits whose line ranges overlap / sit within proximity. */
export function merge_nearby_hits(hits: SearchHit[], proximity = 20): SearchHit[] {
  if (hits.length <= 1) return hits;

  const by_file = new Map<string, SearchHit[]>();
  for (const h of hits) {
    let lst = by_file.get(h.file_rel);
    if (lst === undefined) by_file.set(h.file_rel, (lst = []));
    lst.push(h);
  }

  const merged: SearchHit[] = [];
  for (const file_hits of by_file.values()) {
    file_hits.sort((a, b) => a.start_line - b.start_line);
    let current = file_hits[0]!;
    let cur_start = current.start_line;
    let cur_end = current.end_line;
    let cur_dist = current.distance;
    let cur_kind = current.kind;
    let cur_text = current.text;

    for (let i = 1; i < file_hits.length; i++) {
      const nxt = file_hits[i]!;
      if (nxt.start_line <= cur_end + proximity) {
        cur_end = Math.max(cur_end, nxt.end_line);
        if (nxt.distance < cur_dist) {
          cur_dist = nxt.distance;
          cur_kind = nxt.kind;
          cur_text = nxt.text;
        }
      } else {
        merged.push(
          new SearchHit({
            file_rel: current.file_rel,
            start_line: cur_start,
            end_line: cur_end,
            kind: cur_kind,
            text: cur_text,
            distance: cur_dist,
          }),
        );
        current = nxt;
        cur_start = nxt.start_line;
        cur_end = nxt.end_line;
        cur_dist = nxt.distance;
        cur_kind = nxt.kind;
        cur_text = nxt.text;
      }
    }

    merged.push(
      new SearchHit({
        file_rel: current.file_rel,
        start_line: cur_start,
        end_line: cur_end,
        kind: cur_kind,
        text: cur_text,
        distance: cur_dist,
      }),
    );
  }

  merged.sort((a, b) => a.distance - b.distance);
  return merged;
}

interface _RerankRow {
  file_rel: string;
  start_line: number;
  end_line: number;
  kind: string;
  text: string;
  distance: number;
}

/** Apply verbatim-token boost, generated-path penalty, threshold filter, sort. */
export function _rerank_hits(
  rows: _RerankRow[],
  query: string,
  opts: {
    k: number;
    max_distance: number | null;
    boost_verbatim: boolean;
    demote_generated: boolean;
  },
): SearchHit[] {
  const { k, max_distance, boost_verbatim, demote_generated } = opts;
  const tokens = boost_verbatim ? _extract_query_tokens(query) : new Set<string>();
  const scored: Array<[number, _RerankRow]> = [];
  for (const r of rows) {
    const raw_dist = Number(r.distance);
    let eff = raw_dist;
    if (demote_generated && _is_generated_path(r.file_rel)) eff += _GENERATED_PATH_PENALTY;
    if (boost_verbatim) eff -= _verbatim_boost(r.text, tokens);
    if (eff < 0.0) eff = 0.0;
    if (max_distance !== null && eff > max_distance) continue;
    scored.push([eff, r]);
  }
  scored.sort((a, b) => a[0] - b[0]);
  return scored.slice(0, k).map(
    ([eff, r]) =>
      new SearchHit({
        file_rel: r.file_rel,
        start_line: r.start_line,
        end_line: r.end_line,
        kind: r.kind,
        text: r.text,
        distance: eff,
      }),
  );
}

// ---------------------------------------------------------------------------
// Model lifecycle (fail-soft seam — no bundled Node model backend)
// ---------------------------------------------------------------------------

/**
 * Load the embedding model. There is no bundled Node fastembed analogue, so the
 * real path always raises EmbeddingsUnavailable; tests inject a deterministic
 * `embed_texts` stub via vi.spyOn instead. Kept for structural parity.
 */
function _get_model(model_name: string = DEFAULT_MODEL): never {
  throw new EmbeddingsUnavailable(
    `fastembed not installed: no bundled Node embedding backend for ${model_name}`,
  );
}

/**
 * Quick check — does not download or load the model. No fastembed Node backend
 * is bundled, so this returns false by default; the test suite spies it to true
 * alongside the stub embed (mirroring the Python env where fastembed installed
 * makes both is_available() and embed_texts() work). Invoked via `self.` so the
 * spy is observed.
 */
export function is_available(): boolean {
  return false;
}

/** Embed a batch of texts to fixed-dimension semantic vectors. */
export function embed_texts(
  texts: readonly string[],
  opts: { model_name?: string } = {},
): number[][] {
  const model_name = opts.model_name ?? DEFAULT_MODEL;
  if (!texts.length) return [];
  // No bundled Node model backend; _get_model raises EmbeddingsUnavailable.
  // (Tests replace this whole function with a deterministic stub.)
  _get_model(model_name);
}

// ---------------------------------------------------------------------------
// Chunk extraction
// ---------------------------------------------------------------------------

interface _SymRow {
  name: string;
  kind: string;
  line: number;
  end_line: number | null;
}
interface _SecRow {
  heading: string;
  line: number;
  end_line: number | null;
}

/** Fetch symbols, sections, and file language in one cursor operation. */
function _fetch_chunk_metadata(
  conn: _Conn,
  rel_path: string,
): [_SymRow[], _SecRow[], string] {
  const sym_rows = conn
    .prepare(
      "SELECT name, kind, line, end_line FROM symbols" +
        " WHERE file_rel = ? AND end_line IS NOT NULL ORDER BY line",
    )
    .all(rel_path) as _SymRow[];

  const sec_rows = conn
    .prepare(
      "SELECT heading, line, end_line FROM sections" +
        " WHERE file_rel = ? AND end_line IS NOT NULL ORDER BY line",
    )
    .all(rel_path) as _SecRow[];

  const file_lang_row = conn
    .prepare("SELECT language FROM files WHERE rel_path = ?")
    .get(rel_path) as { language: string } | undefined;
  const language = file_lang_row ? file_lang_row.language : "other";

  return [sym_rows, sec_rows, language];
}

/** Build embeddable chunks for a single file using a three-pass strategy. */
export function extract_chunks_for_file(
  project: Project,
  conn: _Conn,
  rel_path: string,
): Chunk[] {
  if (!paths.isSafeRelPath(rel_path)) {
    _LOG.warning(`rejected unsafe rel_path: ${rel_path}`);
    return [];
  }
  const abs_path = path.join(project.root, rel_path);
  let text: string;
  try {
    text = fs.readFileSync(abs_path, "utf-8");
  } catch (e) {
    _LOG.warning(`read failed for ${abs_path}: ${String(e)}`);
    return [];
  }
  const lines = _splitlines(text);
  if (lines.length === 0) return [];

  const chunks: Chunk[] = [];
  const covered: Array<[number, number]> = [];

  const [sym_rows, sec_rows, language] = _fetch_chunk_metadata(conn, rel_path);

  // 1) Symbol-based chunks.
  for (const row of sym_rows) {
    if (!_CODE_SYMBOL_KINDS.has(row.kind)) continue;
    const start = row.line;
    const end = row.end_line as number;
    if (end <= start) continue;
    const chunk_text = lines.slice(start - 1, end).join("\n");
    const len = _cpLen(chunk_text);
    if (!(MIN_CHUNK_CHARS <= len && len <= MAX_CHUNK_CHARS)) continue;
    chunks.push(new Chunk(rel_path, start, end, chunk_text, row.kind));
    covered.push([start, end]);
  }

  // 2) Section-based chunks.
  for (const row of sec_rows) {
    const start = row.line;
    const end = row.end_line as number;
    if (end <= start) continue;
    const chunk_text = lines.slice(start - 1, end).join("\n");
    const len = _cpLen(chunk_text);
    if (!(MIN_CHUNK_CHARS <= len && len <= MAX_CHUNK_CHARS)) continue;
    chunks.push(new Chunk(rel_path, start, end, chunk_text, "section"));
    covered.push([start, end]);
  }

  // 3) Sliding-window fallback for uncovered ranges (code files only).
  if (_WINDOW_LANGS.has(language)) {
    covered.sort((a, b) => (a[0] - b[0] !== 0 ? a[0] - b[0] : a[1] - b[1]));
    const n = lines.length;
    let line_no = 1;
    let covered_idx = 0;

    while (line_no <= n) {
      while (covered_idx < covered.length && covered[covered_idx]![1] < line_no) {
        covered_idx += 1;
      }
      const line_is_covered =
        covered_idx < covered.length &&
        covered[covered_idx]![0] <= line_no &&
        line_no <= covered[covered_idx]![1];

      if (line_is_covered) {
        line_no += 1;
        continue;
      }

      const window_end = Math.min(line_no + WINDOW_LINES - 1, n);
      const chunk_text = lines.slice(line_no - 1, window_end).join("\n");
      const len = _cpLen(chunk_text);
      if (MIN_CHUNK_CHARS <= len && len <= MAX_CHUNK_CHARS) {
        chunks.push(new Chunk(rel_path, line_no, window_end, chunk_text, "window"));
      }
      line_no = window_end + 1;
    }
  }

  return chunks;
}

// ---------------------------------------------------------------------------
// sqlite-vec storage helpers
// ---------------------------------------------------------------------------

/** Pack a float vector into the binary format expected by sqlite-vec (IEEE 754 floats). */
export function _pack_vec(vec: readonly number[]): Buffer {
  return Buffer.from(Float32Array.from(vec).buffer);
}

/** Return True if the sqlite-vec extension is loaded and vec_version() responds. */
export function _check_vec_available(conn: _Conn): boolean {
  try {
    conn.prepare("SELECT vec_version()").get();
    return true;
  } catch (exc) {
    if (!_isOperationalError(exc)) throw exc;
    return false;
  }
}

/** Return a map of `${file_rel}\u0000${start}\u0000${end}` -> content_sha256. */
export function _load_existing_chunk_hashes(
  conn: _Conn,
  file_rels: string[] | null = null,
): Map<string, string> {
  if (file_rels !== null && file_rels.length === 0) return new Map();

  const existing = new Map<string, string>();

  if (file_rels === null) {
    for (const row of conn
      .prepare("SELECT file_rel, start_line, end_line, content_sha256 FROM chunks")
      .all() as Array<{
      file_rel: string;
      start_line: number;
      end_line: number;
      content_sha256: string;
    }>) {
      existing.set(_chunkKey(row.file_rel, row.start_line, row.end_line), row.content_sha256);
    }
    return existing;
  }

  const _SQLITE_BATCH_SIZE = 500;
  for (let batch_start = 0; batch_start < file_rels.length; batch_start += _SQLITE_BATCH_SIZE) {
    const batch = file_rels.slice(batch_start, batch_start + _SQLITE_BATCH_SIZE);
    const placeholders = batch.map(() => "?").join(",");
    for (const row of conn
      .prepare(
        "SELECT file_rel, start_line, end_line, content_sha256 FROM chunks" +
          ` WHERE file_rel IN (${placeholders})`,
      )
      .all(...batch) as Array<{
      file_rel: string;
      start_line: number;
      end_line: number;
      content_sha256: string;
    }>) {
      existing.set(_chunkKey(row.file_rel, row.start_line, row.end_line), row.content_sha256);
    }
  }
  return existing;
}

/** Insert chunk rows and return (chunk_id, packed_vec) pairs for bulk embedding insert.
 *
 * chunk_id is returned as a BigInt: the `embeddings` vec0 virtual table validates
 * its INTEGER PRIMARY KEY strictly, and better-sqlite3 binds plain JS numbers as
 * SQLITE_FLOAT — only a BigInt binds as SQLITE_INTEGER, which vec0 requires. */
function _insert_chunks_and_collect_embed_rows(
  conn: _Conn,
  batch: Array<[Chunk, string]>,
  vecs: number[][],
): Array<[bigint, Buffer]> {
  const embed_rows: Array<[bigint, Buffer]> = [];
  const stmt = conn.prepare(
    "INSERT INTO chunks" +
      " (file_rel, start_line, end_line, content_sha256, kind, text)" +
      " VALUES (?, ?, ?, ?, ?, ?)",
  );
  for (let i = 0; i < batch.length; i++) {
    const [ch, sha] = batch[i]!;
    const vec = vecs[i]!;
    const info = stmt.run(ch.file_rel, ch.start_line, ch.end_line, sha, ch.kind, ch.text);
    const chunk_id = BigInt(info.lastInsertRowid);
    embed_rows.push([chunk_id, _pack_vec(vec)]);
  }
  return embed_rows;
}

/** Delete chunks and their embeddings for the given (file_rel, start, end) keys. */
function _delete_stale_chunks(conn: _Conn, batch_keys: Array<[string, number, number]>): number {
  const key_placeholders = batch_keys.map(() => "(?,?,?)").join(",");
  const flat: unknown[] = [];
  for (const key of batch_keys) for (const v of key) flat.push(v);
  const stale_ids = (
    conn
      .prepare(
        `SELECT id FROM chunks WHERE (file_rel, start_line, end_line) IN (${key_placeholders})`,
      )
      .all(...flat) as Array<{ id: number }>
  ).map((row) => row.id);
  if (stale_ids.length === 0) return 0;
  const id_placeholders = stale_ids.map(() => "?").join(",");
  conn.prepare(`DELETE FROM embeddings WHERE chunk_id IN (${id_placeholders})`).run(...stale_ids);
  conn.prepare(`DELETE FROM chunks WHERE id IN (${id_placeholders})`).run(...stale_ids);
  _LOG.debug(`cleaned ${stale_ids.length} stale chunks for re-embed`);
  return stale_ids.length;
}

// ---------------------------------------------------------------------------
// Incremental indexing
// ---------------------------------------------------------------------------

/** Compute embeddings for chunks in a project. Idempotent on chunk SHA256. */
export function index_project_embeddings(
  project: Project,
  opts: {
    model_name?: string;
    batch_size?: number;
    progress?: ((done: number, total: number) => void) | null;
    file_rels?: string[] | null;
  } = {},
): EmbeddingsResult {
  const model_name = opts.model_name ?? DEFAULT_MODEL;
  const batch_size = opts.batch_size ?? 32;
  const progress = opts.progress ?? null;
  const file_rels = opts.file_rels ?? null;

  if (!self.is_available()) {
    _LOG.debug("embeddings unavailable: fastembed not installed");
    throw new EmbeddingsUnavailable("fastembed not installed");
  }

  const t0 = Date.now() / 1000;
  let n_files = 0;
  let n_chunks_new = 0;
  let n_chunks_skipped = 0;
  let n_stale_deleted = 0;
  let earlyResult: EmbeddingsResult | null = null;
  _LOG.info(`starting embedding index for project ${project.hash.slice(0, 8)} (model=${model_name})`);

  db.projectWriterLock(
    project.hash,
    () => {
      db.openProject(project.hash, (rawConn) => {
        const conn = rawConn as unknown as _Conn;
        if (!self._check_vec_available(conn)) {
          throw new EmbeddingsUnavailable("sqlite-vec not loaded; embeddings disabled");
        }

        const existing = _load_existing_chunk_hashes(conn, file_rels);
        let file_rows: Array<{ rel_path: string; size: number | null }>;
        if (file_rels === null) {
          file_rows = conn.prepare("SELECT rel_path, size FROM files").all() as Array<{
            rel_path: string;
            size: number | null;
          }>;
        } else if (file_rels.length) {
          const placeholders = file_rels.map(() => "?").join(",");
          file_rows = conn
            .prepare(`SELECT rel_path, size FROM files WHERE rel_path IN (${placeholders})`)
            .all(...file_rels) as Array<{ rel_path: string; size: number | null }>;
        } else {
          file_rows = [];
        }
        n_files = file_rows.length;

        let _embed_symbol_only_threshold: number;
        try {
          _embed_symbol_only_threshold =
            (config.load().indexing?.large_file_symbol_only_kb ?? 0) * 1024;
        } catch {
          _embed_symbol_only_threshold = 0;
        }

        const new_chunks: Array<[Chunk, string]> = [];
        let n_symbol_only_skipped = 0;
        for (const fi_row of file_rows) {
          const rel = fi_row.rel_path;
          if (_embed_symbol_only_threshold > 0) {
            let _file_size: number;
            const raw = fi_row.size;
            _file_size = typeof raw === "number" && Number.isFinite(raw) ? raw : 0;
            if (_file_size > _embed_symbol_only_threshold) {
              n_symbol_only_skipped += 1;
              _LOG.debug(`embeddings: skipping symbol-only file ${rel} (${_file_size} bytes)`);
              continue;
            }
          }
          for (const ch of extract_chunks_for_file(project, conn, rel)) {
            const sha = crypto.createHash("sha256").update(ch.text, "utf-8").digest("hex");
            const key = _chunkKey(ch.file_rel, ch.start_line, ch.end_line);
            if (existing.get(key) === sha) {
              n_chunks_skipped += 1;
              continue;
            }
            new_chunks.push([ch, sha]);
          }
        }

        const n_pending_embed = new_chunks.length;
        if (n_symbol_only_skipped > 0) {
          _LOG.info(
            `embeddings: skipped ${n_symbol_only_skipped} symbol-only file(s) ` +
              `(size > ${_embed_symbol_only_threshold} bytes)`,
          );
        }
        if (n_pending_embed === 0) {
          const duration = Date.now() / 1000 - t0;
          _LOG.info(
            `embeddings up-to-date: project=${project.hash.slice(0, 8)} files=${n_files} ` +
              `chunks_skipped=${n_chunks_skipped} symbol_only_skipped=${n_symbol_only_skipped} ` +
              `duration=${duration.toFixed(2)}s`,
          );
          earlyResult = {
            files_visited: n_files,
            chunks_embedded: 0,
            chunks_skipped_unchanged: n_chunks_skipped,
            duration_sec: _round2(duration),
            model: model_name,
          };
          return;
        }
        const total_batches = Math.floor((n_pending_embed + batch_size - 1) / batch_size);
        _LOG.info(
          `processing ${n_pending_embed} new chunks in ${total_batches} batches ` +
            `(project=${project.hash.slice(0, 8)})`,
        );
        for (let i = 0; i < n_pending_embed; i += batch_size) {
          const batch = new_chunks.slice(i, i + batch_size);
          const texts = batch.map(([ch]) => ch.text);
          const vecs = self.embed_texts(texts, { model_name });
          const batch_keys = batch.map(
            ([ch]) => [ch.file_rel, ch.start_line, ch.end_line] as [string, number, number],
          );
          n_stale_deleted += _delete_stale_chunks(conn, batch_keys);

          const embed_rows = _insert_chunks_and_collect_embed_rows(conn, batch, vecs);
          n_chunks_new += embed_rows.length;
          const embStmt = conn.prepare(
            "INSERT INTO embeddings (chunk_id, embedding) VALUES (?, ?)",
          );
          for (const [chunk_id, vecBytes] of embed_rows) embStmt.run(chunk_id, vecBytes);
          if (progress) progress(i + batch.length, n_pending_embed);
        }

        const metaStmt = conn.prepare("INSERT OR REPLACE INTO meta(key, value) VALUES (?, ?)");
        metaStmt.run("embedding_model", model_name);
        metaStmt.run("embedding_dim", String(DEFAULT_DIM));
      });
    },
    { timeoutSec: 30.0 },
  );

  if (earlyResult !== null) return earlyResult;

  const duration = Date.now() / 1000 - t0;
  _LOG.info(
    `embeddings complete: project=${project.hash.slice(0, 8)} files=${n_files} ` +
      `chunks_new=${n_chunks_new} chunks_skipped=${n_chunks_skipped} ` +
      `stale_deleted=${n_stale_deleted} duration=${duration.toFixed(2)}s`,
  );
  return {
    files_visited: n_files,
    chunks_embedded: n_chunks_new,
    chunks_skipped_unchanged: n_chunks_skipped,
    duration_sec: _round2(duration),
    model: model_name,
  };
}

// ---------------------------------------------------------------------------
// Semantic search
// ---------------------------------------------------------------------------

/** Find semantically similar code/text chunks via vector similarity search. */
export function semantic_search(
  project: Project,
  query: string,
  opts: {
    k?: number;
    model_name?: string;
    max_distance?: number | null;
    boost_verbatim?: boolean;
    demote_generated?: boolean;
  } = {},
): SearchHit[] {
  const k = opts.k ?? 8;
  const model_name = opts.model_name ?? DEFAULT_MODEL;
  const max_distance = opts.max_distance === undefined ? DEFAULT_DISTANCE_THRESHOLD : opts.max_distance;
  const boost_verbatim = opts.boost_verbatim ?? true;
  const demote_generated = opts.demote_generated ?? true;

  if (!self.is_available()) {
    _LOG.debug("embeddings unavailable: fastembed not installed");
    throw new EmbeddingsUnavailable("fastembed not installed");
  }
  if (!query || !query.trim()) {
    _LOG.debug("semantic_search: empty query; returning no results");
    return [];
  }
  const results = self.embed_texts([query], { model_name });
  if (!results.length) throw new EmbeddingsUnavailable("embed_texts returned no vectors for query");
  const qvec = results[0]!;
  if (!qvec.length) throw new EmbeddingsUnavailable("embed_texts returned empty vector for query");

  const fetch_k = Math.min(Math.max(k * _OVER_FETCH_FACTOR, k), _MAX_OVER_FETCH);

  const rows = db.openProject(project.hash, (rawConn) => {
    const conn = rawConn as unknown as _Conn;
    if (!self._check_vec_available(conn)) throw new EmbeddingsUnavailable("sqlite-vec not loaded");
    return conn
      .prepare(
        `
            SELECT c.file_rel, c.start_line, c.end_line, c.kind, c.text, e.distance
            FROM embeddings e
            JOIN chunks c ON c.id = e.chunk_id
            WHERE e.embedding MATCH ?
              AND k = ?
            ORDER BY e.distance
            `,
      )
      .all(_pack_vec(qvec), fetch_k) as _RerankRow[];
  });

  let hits = _rerank_hits(rows, query, { k, max_distance, boost_verbatim, demote_generated });
  hits = merge_nearby_hits(hits);

  if (rows.length) {
    _LOG.info(
      `semantic search completed: query_len=${query.length} k=${k} fetched=${rows.length} ` +
        `returned=${hits.length} dist_min=${rows[0]!.distance} dist_max=${rows[rows.length - 1]!.distance} ` +
        `threshold=${max_distance === null ? "off" : max_distance.toFixed(2)}`,
    );
  } else {
    _LOG.info(
      `semantic search completed: query_len=${query.length} k=${k} fetched=0 returned=0`,
    );
  }

  return hits;
}

// ---------------------------------------------------------------------------
// Per-symbol similarity
// ---------------------------------------------------------------------------

/** Find the top-k most semantically similar symbols to the given symbol (fail-soft). */
export function find_similar_symbols(
  project_hash: string,
  file_path: string,
  symbol_name: string,
  top_k = 5,
): SimilarSymbolHit[] {
  try {
    return _find_similar_symbols_impl(project_hash, file_path, symbol_name, top_k);
  } catch (e) {
    _LOG.debug(`find_similar_symbols failed for ${file_path}::${symbol_name}: ${String(e)}`);
    return [];
  }
}

/** Inner implementation; exceptions propagate to the fail-soft wrapper. */
export function _find_similar_symbols_impl(
  project_hash: string,
  file_path: string,
  symbol_name: string,
  top_k: number,
): SimilarSymbolHit[] {
  if (!self.is_available()) throw new EmbeddingsUnavailable("fastembed not installed");

  const fetch_k = Math.min(Math.max(top_k * _OVER_FETCH_FACTOR, top_k + 10), _MAX_OVER_FETCH);

  return db.openProject(project_hash, (rawConn) => {
    const conn = rawConn as unknown as _Conn;
    if (!self._check_vec_available(conn)) throw new EmbeddingsUnavailable("sqlite-vec not loaded");

    const sym_row = conn
      .prepare("SELECT line, end_line FROM symbols WHERE file_rel = ? AND name = ? LIMIT 1")
      .get(file_path, symbol_name) as { line: number; end_line: number | null } | undefined;
    if (sym_row === undefined) {
      _LOG.debug(`find_similar_symbols: symbol ${symbol_name} not found in ${file_path}`);
      return [];
    }

    const sym_line = sym_row.line;
    const sym_end = sym_row.end_line !== null ? sym_row.end_line : sym_line;

    const chunk_row = conn
      .prepare(
        `
            SELECT id, embedding
            FROM (
                SELECT c.id, e.embedding
                FROM chunks c
                JOIN embeddings e ON e.chunk_id = c.id
                WHERE c.file_rel = ?
                  AND c.start_line <= ?
                  AND c.end_line   >= ?
                ORDER BY ABS(c.start_line - ?) ASC
                LIMIT 1
            )
            `,
      )
      .get(file_path, sym_end, sym_line, sym_line) as
      | { id: number; embedding: Buffer }
      | undefined;

    if (chunk_row === undefined) {
      _LOG.debug(
        `find_similar_symbols: no indexed chunk for ${file_path}::${symbol_name} ` +
          `(lines ${sym_line}-${sym_end})`,
      );
      return [];
    }

    const query_chunk_id = chunk_row.id;
    const query_embedding_bytes = chunk_row.embedding;

    const rows = conn
      .prepare(
        `
            SELECT c.file_rel, c.start_line, c.end_line, c.kind, e.distance, e.chunk_id
            FROM embeddings e
            JOIN chunks c ON c.id = e.chunk_id
            WHERE e.embedding MATCH ?
              AND k = ?
            ORDER BY e.distance
            `,
      )
      .all(query_embedding_bytes, fetch_k) as Array<{
      file_rel: string;
      start_line: number;
      end_line: number;
      kind: string;
      distance: number;
      chunk_id: number;
    }>;

    const results: SimilarSymbolHit[] = [];
    const seen = new Set<string>([`${file_path}\u0000${symbol_name}`]);
    for (const row of rows) {
      if (results.length >= top_k) break;
      if (row.chunk_id === query_chunk_id) continue;
      const c_file = row.file_rel;
      const c_start = row.start_line;
      const c_end = row.end_line;
      const sym = conn
        .prepare(
          `
                SELECT name, kind,
                       (COALESCE(end_line, line) - line) AS span
                FROM symbols
                WHERE file_rel = ?
                  AND line <= ?
                  AND (end_line IS NULL OR end_line >= ?)
                ORDER BY span ASC, ABS(line - ?) ASC
                LIMIT 1
                `,
        )
        .get(c_file, c_end, c_start, c_start) as { name: string; kind: string; span: number } | undefined;
      if (sym === undefined) continue;
      const key = `${c_file}\u0000${sym.name}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const raw_dist = Number(row.distance);
      const similarity = Math.max(0.0, Math.min(1.0, 1.0 - raw_dist / 2.0));
      results.push(
        new SimilarSymbolHit({ file: c_file, name: sym.name, kind: sym.kind, similarity_score: similarity }),
      );
    }

    return results;
  });
}
