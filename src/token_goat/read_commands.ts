/**
 * Command helpers for the read/section/deps CLI path.
 *
 * Faithful 1:1 TypeScript port of src/token_goat/read_commands.py — same
 * logic, same output, same edge cases.
 *
 * Output seam (Python `typer.echo` / `raise typer.Exit`) routes through
 * cli_common.ts (`_echo` / `CliExit`) so the cli wrappers and the test runner
 * observe output identically to the Python originals.
 *
 * Internal helpers another function in this module calls are invoked via
 * `self.fnName(...)` (a static `import * as self`) — the ESM live-binding
 * analogue of Python module-attribute patching, so tests that `vi.spyOn`
 * these boundaries see the patched implementation.
 */
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { spawnSync } from "node:child_process";

import * as db from "./db.js";
import * as hints from "./hints.js";
import * as overflow_guard from "./overflow_guard.js";
import * as read_replacement from "./read_replacement.js";
import * as session from "./session.js";
import { find_project } from "./project.js";
import type { Project } from "./project.js";
import { getLogger } from "./util.js";
import { get_close_matches } from "./difflib.js";
import { _echo, CliExit } from "./cli_common.js";

// Lazily-imported sibling modules (Python `from . import X` inside the body).
// Imported statically here as namespaces — ESM has no per-call lazy import that
// vitest can resolve from a variable; a static literal import is the faithful
// analogue and keeps tree-shaking honest.
import * as paths from "./paths.js";
import * as worker from "./worker.js";
import * as parser from "./parser.js";
import * as compact from "./compact.js";
import * as skill_cache from "./skill_cache.js";
import * as embeddings from "./embeddings.js";
import * as git_history from "./git_history.js";

import * as self from "./read_commands.js";

import type { SymbolResult, SectionResult, LineRangeResult } from "./types.js";

const _LOG = getLogger("read_commands");

// ---------------------------------------------------------------------------
// Python-semantics parity helpers
// ---------------------------------------------------------------------------

/**
 * Reproduce Python `str.splitlines()`: split on universal newlines and DROP a
 * trailing empty element (a final "\n" does NOT yield a trailing "").
 * Splits on \n \r \r\n \v \f \x1c \x1d \x1e \x85    .
 */
function _splitlines(s: string): string[] {
  if (s === "") return [];
  const out: string[] = [];
  let cur = "";
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    const code = s.charCodeAt(i);
    const isBreak =
      ch === "\n" ||
      ch === "\r" ||
      ch === "" ||
      ch === "" ||
      code === 0x1c ||
      code === 0x1d ||
      code === 0x1e ||
      code === 0x85 ||
      ch === " " ||
      ch === " ";
    if (isBreak) {
      out.push(cur);
      cur = "";
      // \r\n counts as a single break.
      if (ch === "\r" && i + 1 < s.length && s[i + 1] === "\n") {
        i++;
      }
    } else {
      cur += ch;
    }
  }
  if (cur !== "") {
    out.push(cur);
  }
  return out;
}

/** Count Unicode CODE POINTS (Python `len(str)`), not UTF-16 units. */
function _cpLen(s: string): number {
  let n = 0;
  for (const _ of s) n++;
  return n;
}

/** Byte length of a string as UTF-8 (Python `len(s.encode())`). */
function _byteLen(s: string): number {
  return Buffer.byteLength(s, "utf-8");
}

/**
 * True when *err* is a SQLite operational/DB error that the Python code
 * catches as `sqlite3.OperationalError` / `sqlite3.DatabaseError` (e.g. a
 * missing table). better-sqlite3 raises a SqliteError whose `.code` starts
 * with "SQLITE_". Re-raise anything else so genuine bugs surface.
 */
function _isOperationalError(err: unknown): boolean {
  const code = (err as { code?: unknown })?.code;
  if (typeof code === "string" && code.startsWith("SQLITE_")) {
    return true;
  }
  // db.openProjectReadonly throws a plain Error("project db not found: …")
  // when the DB file is absent — the Python FileNotFoundError analogue.
  const msg = (err as { message?: unknown })?.message;
  if (typeof msg === "string" && /not found/.test(msg)) {
    return true;
  }
  if (err instanceof db.DBError) {
    return true;
  }
  return false;
}

/** True when stdout is an interactive terminal (Python `sys.stdout.isatty()`). */
function _isatty(): boolean {
  return process.stdout.isTTY === true;
}

// ---------------------------------------------------------------------------
// db forward-dependencies not yet ported in db.ts (count_symbols_for_file +
// get_type_definitions / _classify_class). Inlined here as faithful 1:1 ports
// of the Python db.py originals so the read commands that depend on them work
// without modifying db.ts. (When db.ts gains these, swap the calls back.)
// ---------------------------------------------------------------------------

/** How many symbols are indexed for a single file (Python db.count_symbols_for_file). */
function _count_symbols_for_file(project_hash: string, file_rel: string): number {
  try {
    return db.openProjectReadonly(project_hash, (conn) => {
      const row = conn.prepare("SELECT COUNT(*) AS n FROM symbols WHERE file_rel = ?").get(file_rel) as
        | { n?: number }
        | undefined;
      return row ? Number(row.n) : 0;
    });
  } catch (exc) {
    if (_isOperationalError(exc)) return 0; // DB does not exist yet
    _LOG.warning(
      "count_symbols_for_file(%s…, %s) failed, returning 0: %s",
      project_hash.slice(0, 8),
      file_rel,
      exc,
    );
    return 0;
  }
}

// Type-definition classification regexes (Python db.py _RE_* constants).
const _RE_TYPED_DICT_BASE = /\bTypedDict\b/;
const _RE_PROTOCOL_BASE = /\bProtocol\b/;
const _RE_DATACLASS_DECO = /@\s*dataclass\b/;
const _RE_NAMEDTUPLE_ASSIGN = /\bnamedtuple\s*\(/;
const _RE_NAMEDTUPLE_TYPED = /\bNamedTuple\b/;
const _RE_PYDANTIC_BASE = /\b(?:BaseModel|RootModel|BaseSettings|SQLModel|GenericModel)\b/;
const _RE_FIELD_LINE = /^[ \t]+([A-Za-z_][A-Za-z0-9_]*)\s*:/;
const _DECO_SCAN_LINES = 6;
const _FIELD_SCAN_LINES = 80;

/** Classify a class symbol and extract its field names (Python db._classify_class). */
function _classify_class(
  source_lines: string[],
  start_line: number,
  end_line: number,
): [string, string[]] {
  const n = source_lines.length;
  const header_idx = Math.max(0, start_line - 1);

  const scan_start = Math.max(0, header_idx - _DECO_SCAN_LINES);
  const header_region = source_lines.slice(scan_start, header_idx + 1).join("\n");

  const body_end = Math.min(n, end_line);
  const body_start = header_idx + 1;
  const body_lines = source_lines.slice(body_start, Math.min(body_end, body_start + _FIELD_SCAN_LINES));

  let type_kind = "";
  if (_RE_TYPED_DICT_BASE.test(header_region)) {
    type_kind = "TypedDict";
  } else if (_RE_NAMEDTUPLE_ASSIGN.test(header_region)) {
    type_kind = "namedtuple";
  } else if (_RE_NAMEDTUPLE_TYPED.test(header_region)) {
    type_kind = "NamedTuple";
  } else if (_RE_PROTOCOL_BASE.test(header_region)) {
    type_kind = "Protocol";
  } else if (_RE_DATACLASS_DECO.test(header_region)) {
    type_kind = "dataclass";
  } else if (_RE_PYDANTIC_BASE.test(header_region)) {
    type_kind = "pydantic";
  }

  const fields: string[] = [];
  if (type_kind) {
    for (const line of body_lines) {
      const m = _RE_FIELD_LINE.exec(line);
      if (m) {
        const name = m[1]!;
        if (!name.startsWith("_")) {
          fields.push(name);
        }
      }
    }
  }

  return [type_kind, fields];
}

/** Return type definition symbols from the project (Python db.get_type_definitions). */
function _get_type_definitions(
  project_hash: string,
  file_path: string | null = null,
): Array<Record<string, unknown>> {
  let rows: Array<Record<string, unknown>>;
  try {
    rows = db.openProjectReadonly(project_hash, (conn) => {
      if (file_path !== null) {
        return conn
          .prepare(
            "SELECT name, kind, file_rel, line, end_line " +
              "FROM symbols " +
              "WHERE kind = 'class' AND file_rel LIKE ? AND end_line IS NOT NULL " +
              "ORDER BY file_rel, line",
          )
          .all(`%${file_path}%`) as Array<Record<string, unknown>>;
      }
      return conn
        .prepare(
          "SELECT name, kind, file_rel, line, end_line " +
            "FROM symbols " +
            "WHERE kind = 'class' AND end_line IS NOT NULL " +
            "ORDER BY file_rel, line",
        )
        .all() as Array<Record<string, unknown>>;
    });
  } catch (exc) {
    if (_isOperationalError(exc)) return [];
    return [];
  }

  if (rows.length === 0) {
    return [];
  }

  // Get the project root so we can read source files.
  let project_root: string | null = null;
  try {
    const proj_row = db.openGlobalReadonly((gconn) => {
      return gconn.prepare("SELECT root FROM projects WHERE hash = ?").get(project_hash) as
        | Record<string, unknown>
        | undefined;
    });
    project_root = proj_row ? String(proj_row["root"]) : null;
  } catch {
    project_root = null;
  }

  // Group rows by file_rel to minimise file reads (insertion order preserved).
  const rows_by_file = new Map<string, Array<Record<string, unknown>>>();
  for (const row of rows) {
    const fr = String(row["file_rel"]);
    if (!rows_by_file.has(fr)) rows_by_file.set(fr, []);
    rows_by_file.get(fr)!.push(row);
  }

  const results: Array<Record<string, unknown>> = [];
  for (const [file_rel, file_rows] of rows_by_file) {
    let source_lines: string[] = [];
    if (project_root !== null) {
      try {
        const abs_path = path.join(project_root, file_rel);
        source_lines = _splitlines(fs.readFileSync(abs_path, "utf-8"));
      } catch {
        // OSError suppressed
      }
    }

    for (const row of file_rows) {
      const start = Number(row["line"]);
      const end = Number(row["end_line"]);
      const name = String(row["name"]);

      let type_kind: string;
      let fields: string[];
      if (source_lines.length > 0) {
        [type_kind, fields] = _classify_class(source_lines, start, end);
      } else {
        type_kind = "";
        fields = [];
      }

      if (!type_kind) {
        continue; // plain class — skip
      }

      results.push({
        name,
        type_kind,
        file: file_rel,
        start_line: start,
        fields,
      });
    }
  }

  return results;
}

// ===========================================================================
// Optional ``--session-id`` / ``-s`` option mirror — kept as a no-op constant
// for signature parity with the Python module (cli.py owns the real option).
// ===========================================================================

/** One node in the transitive dependency BFS result. */
interface _DepNode {
  depth: number;
  via: string;
  symbols: Set<string>;
}

// Module-level key functions avoid allocating a new closure on every sort call.
function _key_dep_by_size(item: [string, Set<string>]): [number, string] {
  return [-item[1].size, item[0]];
}

function _key_transitive_by_depth(item: [string, _DepNode]): [number, string] {
  return [item[1].depth, item[0]];
}

/** Compare two `[number, string]` sort keys lexicographically. */
function _cmpKey(a: [number, string], b: [number, string]): number {
  if (a[0] !== b[0]) return a[0] - b[0];
  if (a[1] < b[1]) return -1;
  if (a[1] > b[1]) return 1;
  return 0;
}

/**
 * Faithful inline of worker._index_spawn_active (which is not exported).
 *
 * The marker holds ``pid\ntimestamp``. It is "active" only when the timestamp
 * is within INDEX_SPAWN_TTL and the PID is still alive. The cmdline-recycling
 * guard the Python uses relies on psutil; Node has no portable cmdline API
 * (worker._procCmdline returns null in production), so we trust the PID + TTL,
 * exactly as the Python falls back to on AccessDenied.
 */
function _index_spawn_active(marker: string): boolean {
  let pid: number;
  let ts: number;
  try {
    const raw = fs.readFileSync(marker, "utf-8");
    const nl = raw.indexOf("\n");
    if (nl < 0) {
      return false;
    }
    pid = Number.parseInt(raw.slice(0, nl), 10);
    ts = Number.parseFloat(raw.slice(nl + 1).trim());
    if (!Number.isInteger(pid) || !Number.isFinite(ts)) {
      return false;
    }
  } catch {
    return false; // missing or malformed marker — not active
  }
  if (Date.now() / 1000 - ts > worker.INDEX_SPAWN_TTL) {
    return false; // stale — a hung index; allow a fresh spawn
  }
  if (!db._pidAlive(pid)) {
    return false;
  }
  // cmdline unavailable in Node — trust the PID + TTL (Python AccessDenied path).
  return true;
}

/**
 * Return a one-line hint when this project has no indexed files.
 */
export function _not_indexed_hint(project_hash: string): string | null {
  try {
    if (!db.project_has_files(project_hash)) {
      const marker = path.join(paths.locksDir(), `${project_hash}.indexing`);
      if (_index_spawn_active(marker)) {
        return (
          "(indexing is currently in progress — try again in a moment, " +
          "or run `token-goat index --full` to force synchronous indexing.)"
        );
      }

      if (fs.existsSync(marker)) {
        return (
          "(a previous indexing attempt may have failed — " +
          "run `token-goat index --full` to retry, or check the logs.)"
        );
      }

      return (
        "(project not yet indexed. auto-indexing started in the " +
        "background on first SessionStart; if it has not finished, " +
        "rerun in a moment, or run `token-goat index --full` to force " +
        "synchronous indexing.)"
      );
    }
  } catch (exc) {
    _LOG.warning("failed to check project index status: %s", exc);
    return (
      "(unable to check whether this project is indexed right now; " +
      "run `token-goat index --full` again or check the logs.)"
    );
  }
  return null;
}

// Maximum bytes hashed when computing a file-content SHA for the in-session cache.
const _SHA_MAX_BYTES = 2_000_000;

/** Return the hex SHA-1 of the file's contents, or "" on any I/O error. */
export function _file_sha1(abs_path: string): string {
  let data: Buffer;
  try {
    const fd = fs.openSync(abs_path, "r");
    try {
      const buf = Buffer.alloc(_SHA_MAX_BYTES);
      const n = fs.readSync(fd, buf, 0, _SHA_MAX_BYTES, 0);
      data = buf.subarray(0, n);
    } finally {
      fs.closeSync(fd);
    }
  } catch (exc) {
    _LOG.debug("_file_sha1: cannot read %s: %s", abs_path, exc);
    return "";
  }
  return crypto.createHash("sha1").update(data).digest("hex");
}

// Max number of "did you mean…?" suggestions and difflib cutoff.
const _DIDYOUMEAN_LIMIT = 3;
const _DIDYOUMEAN_CUTOFF = 0.6;

/**
 * Return up to _DIDYOUMEAN_LIMIT values from ``column`` in ``table`` that are
 * close lexical matches for ``query_term``. Empty list on any DB error.
 */
export function _close_db_matches(
  project: Project,
  rel_path: string,
  query_term: string,
  opts: { table: string; column: string; kind: string },
): string[] {
  const { table, column, kind } = opts;
  let rows: Array<Record<string, unknown>>;
  try {
    rows = db.openProjectReadonly(project.hash, (conn) => {
      return conn
        .prepare(
          `SELECT DISTINCT ${column} FROM ${table}` +
            ` WHERE file_rel = ? AND ${column} IS NOT NULL`,
        )
        .all(rel_path) as Array<Record<string, unknown>>;
    });
  } catch (exc) {
    if (!_isOperationalError(exc)) throw exc;
    _LOG.debug("close-match query failed for %s in %s: %s", kind, rel_path, exc);
    return [];
  }
  const candidates: string[] = [];
  for (const r of rows) {
    const v = r[column];
    if (v) candidates.push(String(v));
  }
  return get_close_matches(query_term, candidates, _DIDYOUMEAN_LIMIT, _DIDYOUMEAN_CUTOFF);
}

/** Close symbol-name matches in *rel_path*. Empty list on any DB error. */
export function _close_symbol_matches(project: Project, rel_path: string, symbol: string): string[] {
  return self._close_db_matches(project, rel_path, symbol, {
    table: "symbols",
    column: "name",
    kind: "symbol",
  });
}

/** Close section-heading matches in *rel_path*. Empty list on any DB error. */
export function _close_section_matches(project: Project, rel_path: string, heading: string): string[] {
  return self._close_db_matches(project, rel_path, heading, {
    table: "sections",
    column: "heading",
    kind: "section",
  });
}

/**
 * Return up to _DIDYOUMEAN_LIMIT indexed file paths whose basename is a close
 * lexical match for the basename of *file_part*.
 */
export function _close_file_matches(project: Project, file_part: string): string[] {
  const basename = path.posix.basename(file_part.replace(/\\/g, "/"));
  if (!basename) {
    return [];
  }
  let rows: Array<Record<string, unknown>>;
  try {
    rows = db.openProjectReadonly(project.hash, (conn) => {
      return conn
        .prepare("SELECT rel_path FROM files WHERE rel_path IS NOT NULL")
        .all() as Array<Record<string, unknown>>;
    });
  } catch (exc) {
    if (!_isOperationalError(exc)) throw exc;
    _LOG.debug("close-file-match query failed for %s: %s", file_part, exc);
    return [];
  }
  const all_rel_paths: string[] = [];
  for (const r of rows) {
    if (r["rel_path"]) all_rel_paths.push(String(r["rel_path"]));
  }
  // basename→rel_path map; last one wins (matches Python dict comprehension).
  const basename_to_rel = new Map<string, string>();
  for (const rp of all_rel_paths) {
    basename_to_rel.set(path.posix.basename(rp.replace(/\\/g, "/")), rp);
  }
  const close_basenames = get_close_matches(
    basename,
    Array.from(basename_to_rel.keys()),
    _DIDYOUMEAN_LIMIT,
    _DIDYOUMEAN_CUTOFF,
  );
  return close_basenames.map((b) => basename_to_rel.get(b)!);
}

/** Return files recorded as skipped during indexing for exceeding the size cap. */
export function _load_skipped_large(project_hash: string): Array<Record<string, unknown>> {
  let row: Record<string, unknown> | undefined;
  try {
    row = db.openProjectReadonly(project_hash, (conn) => {
      return conn
        .prepare("SELECT value FROM meta WHERE key = ?")
        .get("skipped_large_files") as Record<string, unknown> | undefined;
    });
  } catch (exc) {
    if (!_isOperationalError(exc)) throw exc;
    _LOG.debug("skipped-large meta query failed for %s: %s", project_hash.slice(0, 8), exc);
    return [];
  }
  const raw = row !== undefined ? row["value"] : null;
  if (!raw) {
    return [];
  }
  let data: unknown;
  try {
    data = JSON.parse(String(raw));
  } catch {
    return [];
  }
  if (!Array.isArray(data)) {
    return [];
  }
  return data.filter((e): e is Record<string, unknown> => typeof e === "object" && e !== null);
}

/**
 * Return an actionable hint when *file_part* names a file that exists in the
 * project but was skipped at index time for exceeding the size cap.
 */
export function over_cap_file_hint(file_part: string, project: Project | null): string | null {
  if (project === null || !file_part) {
    return null;
  }
  const entries = self._load_skipped_large(project.hash);
  if (entries.length === 0) {
    return null;
  }
  for (const entry of entries) {
    const rel = String(entry["rel_path"] ?? "");
    if (rel && self._path_part_matches(file_part, rel)) {
      const limit_mb = parser.MAX_FILE_SIZE / 1024 / 1024;
      return (
        `File '${rel}' exists but was not indexed ` +
        `(file size exceeds the ${limit_mb.toFixed(0)} MB limit). ` +
        `Use line-range reads: \`token-goat read "${rel}::1-200"\` to read sections.`
      );
    }
  }
  return null;
}

/** Note shown for an indexed file that has zero symbols. */
export function no_indexed_symbols_note(file_rel: string): string {
  return (
    `Note: ${file_rel} has no indexed symbols ` +
    "— it may be a config file or too small to parse"
  );
}

/** Hint to emit after a symbol miss that resolved to a single indexed file. */
export function skeleton_or_empty_hint(project_hash: string, file_rel: string): string {
  if (_count_symbols_for_file(project_hash, file_rel) === 0) {
    return self.no_indexed_symbols_note(file_rel);
  }
  return `Try: token-goat skeleton "${file_rel}" to see what's indexed`;
}

/** Resolve a partial ``--file`` scope (escaped LIKE pattern) to a single path. */
export function resolve_scoped_file(project_hash: string, like_param: string): string | null {
  let rows: Array<Record<string, unknown>>;
  try {
    rows = db.openProjectReadonly(project_hash, (conn) => {
      return conn
        .prepare("SELECT rel_path FROM files WHERE rel_path LIKE ? ESCAPE '\\' LIMIT 2")
        .all(like_param) as Array<Record<string, unknown>>;
    });
  } catch (exc) {
    if (!_isOperationalError(exc)) throw exc;
    return null;
  }
  if (rows.length === 1) {
    return String(rows[0]!["rel_path"]);
  }
  return null;
}

/** Path-aware, case-insensitive match shared by over_cap and the disk fallback. */
export function _path_part_matches(file_part: string, rel_path: string): boolean {
  let needle = file_part.replace(/\\/g, "/").toLowerCase();
  if (needle.startsWith("./")) {
    needle = needle.slice(2);
  }
  if (!needle) {
    return false;
  }
  const rel_norm = rel_path.replace(/\\/g, "/").toLowerCase();
  if (!rel_norm) {
    return false;
  }
  const needle_base = needle.includes("/") ? needle.slice(needle.lastIndexOf("/") + 1) : needle;
  const rel_base = rel_norm.includes("/") ? rel_norm.slice(rel_norm.lastIndexOf("/") + 1) : rel_norm;
  return (
    rel_norm === needle ||
    rel_norm.endsWith("/" + needle) ||
    (Boolean(needle_base) && needle_base === rel_base)
  );
}

/** Resolve *candidate* and return it only if it stays inside *root*. */
export function _safe_resolve_within(candidate: string, root: string): string | null {
  let resolved: string;
  try {
    resolved = fs.realpathSync(candidate);
  } catch {
    // Python Path.resolve() does not require existence; realpath does. Fall
    // back to a lexical resolution so a not-yet-realpathable path still gets
    // the containment check (and the caller's is_file() gate rejects misses).
    resolved = path.resolve(candidate);
  }
  const rel = path.relative(root, resolved);
  if (rel.startsWith("..") || path.isAbsolute(rel)) {
    return null;
  }
  return resolved;
}

/** Resolve the (project_hash, root) pairs the disk fallback may scan. */
export function _disk_fallback_search_roots(
  current_project: Project | null,
): Array<[string, string]> {
  if (current_project !== null) {
    const root = current_project.root;
    try {
      if (!fs.statSync(root).isDirectory()) {
        return [];
      }
    } catch {
      return [];
    }
    return [[current_project.hash, root]];
  }

  let rows: Array<Record<string, unknown>>;
  try {
    rows = db.openGlobalReadonly((gconn) => {
      return gconn.prepare("SELECT hash, root FROM projects").all() as Array<
        Record<string, unknown>
      >;
    });
  } catch (exc) {
    if (!_isOperationalError(exc)) throw exc;
    _LOG.debug("disk-fallback: global project list unavailable: %s", exc);
    return [];
  }
  const targets: Array<[string, string]> = [];
  for (const row of rows) {
    const proj_hash = row["hash"] ? String(row["hash"]) : "";
    const root_raw = row["root"] ? String(row["root"]) : "";
    if (!proj_hash || !root_raw) {
      continue;
    }
    let root: string;
    try {
      root = fs.realpathSync(root_raw);
    } catch {
      continue;
    }
    try {
      if (fs.statSync(root).isDirectory()) {
        targets.push([proj_hash, root]);
      }
    } catch {
      continue;
    }
  }
  return targets;
}

/** Locate an unindexed (e.g. over-cap) file on disk inside an indexed project. */
export function _find_unindexed_file_on_disk(
  file_part: string,
  current_project: Project | null = null,
): [string, string, string] | null {
  let needle = file_part.replace(/\\/g, "/").trim();
  if (needle.startsWith("./")) {
    needle = needle.slice(2);
  }
  if (!needle) {
    return null;
  }
  for (const [proj_hash, root] of self._disk_fallback_search_roots(current_project)) {
    for (const entry of self._load_skipped_large(proj_hash)) {
      const rel = String(entry["rel_path"] ?? "").replace(/\\/g, "/");
      if (rel && self._path_part_matches(file_part, rel)) {
        const resolved = self._safe_resolve_within(path.join(root, rel), root);
        if (resolved !== null && _isFile(resolved)) {
          return [resolved, path.relative(root, resolved).split(path.sep).join("/"), root];
        }
      }
    }
    const resolved = self._safe_resolve_within(path.join(root, needle), root);
    if (resolved !== null && _isFile(resolved)) {
      return [resolved, path.relative(root, resolved).split(path.sep).join("/"), root];
    }
  }
  return null;
}

/** fs.statSync(...).isFile() with no throw. */
function _isFile(p: string): boolean {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

/** Stream lines *start*..*end* (1-based, inclusive) from *abs_path*. */
export function _read_disk_line_range(abs_path: string, start: number, end: number): string[] | null {
  const collected: string[] = [];
  let raw: string;
  try {
    raw = fs.readFileSync(abs_path, "utf-8");
    // Strip a UTF-8 BOM (Python utf-8-sig).
    if (raw.charCodeAt(0) === 0xfeff) {
      raw = raw.slice(1);
    }
  } catch (exc) {
    _LOG.warning("disk-fallback read failed: %s: %s", abs_path, exc);
    return null;
  }
  // Python iterates universal-newline text lines; .split keeps line content
  // without the trailing newline. Splitlines drops a trailing empty (matching
  // Python's per-line iteration, which yields no empty trailing entry).
  const allLines = _splitlines(raw);
  for (let lineno = 1; lineno <= allLines.length; lineno++) {
    if (lineno < start) {
      continue;
    }
    if (lineno > end) {
      break;
    }
    collected.push(allLines[lineno - 1]!);
  }
  if (collected.length === 0) {
    return null;
  }
  return collected;
}

/** Emit a structured read error in either text or JSON form. */
export function _emit_read_error(opts: {
  code: string;
  message: string;
  json_output: boolean;
  candidates?: ReadonlyArray<string>;
  err?: boolean;
  details?: Record<string, unknown>;
}): void {
  const { code, message, json_output } = opts;
  const candidates = opts.candidates ?? [];
  const err = opts.err ?? false;
  const details = opts.details ?? {};

  if (json_output) {
    const error: Record<string, unknown> = { code, message };
    if (candidates.length > 0) {
      error["candidates"] = [...candidates];
    }
    for (const [k, v] of Object.entries(details)) {
      error[k] = v;
    }
    _echo(JSON.stringify({ ok: false, error }));
    return;
  }

  _echo(message, { err });
  for (const candidate of candidates) {
    _echo(`  - ${candidate}`, { err });
  }
}

/** Emit a structured error when a file name matches multiple indexed paths. */
export function _emit_ambiguous_file_match(
  file_part: string,
  candidates: ReadonlyArray<string>,
  opts: { json_output: boolean },
): void {
  self._emit_read_error({
    code: "ambiguous_file",
    message: `Ambiguous file match: ${file_part}`,
    candidates,
    json_output: opts.json_output,
    details: { file_part },
  });
}

/** Emit a structured error when file resolution returns no match. */
export function _emit_file_not_found_error(
  file_part: string,
  current_proj: Project | null,
  opts: { json_output: boolean },
): void {
  const json_output = opts.json_output;
  if (current_proj === null) {
    self._emit_read_error({
      code: "no_project",
      message: "No project detected.",
      json_output,
      details: { file_part },
    });
  } else {
    const hint = self._not_indexed_hint(current_proj.hash);
    if (hint) {
      self._emit_read_error({
        code: "project_not_indexed",
        message: hint,
        json_output,
        details: { file_part, project_hash: current_proj.hash },
      });
    } else {
      const over_cap = self.over_cap_file_hint(file_part, current_proj);
      if (over_cap !== null) {
        self._emit_read_error({
          code: "file_over_cap",
          message: over_cap,
          json_output,
          details: { file_part, project_hash: current_proj.hash },
        });
        throw new CliExit(1);
      }
      const suggestions = self._close_file_matches(current_proj, file_part);
      let base_message = `File not found in any indexed project: ${file_part}`;
      if (suggestions.length > 0 && !json_output) {
        base_message = base_message + "\nDid you mean:";
      }
      self._emit_read_error({
        code: "file_not_found",
        message: base_message,
        json_output,
        candidates: suggestions,
        details: { file_part, project_hash: current_proj.hash },
      });
    }
  }
}

// ---------------------------------------------------------------------------
// dependency graph collectors
// ---------------------------------------------------------------------------

type Conn = Parameters<Parameters<typeof db.openProject>[1]>[0];

/** Return file-level dependency edges and unresolved refs for the given file. */
export function _collect_dependency_graph(
  conn: Conn,
  rel_path: string,
): [Map<string, Set<string>>, Map<string, Set<string>>, string[]] {
  const outgoing = new Map<string, Set<string>>();
  for (const row of conn
    .prepare(
      `
        SELECT DISTINCT s.file_rel, r.symbol_name
          FROM refs r
          JOIN symbols s ON s.name = r.symbol_name AND s.file_rel != r.file_rel
         WHERE r.file_rel = ?
           AND r.symbol_name != ''
        `,
    )
    .all(rel_path) as Array<Record<string, unknown>>) {
    const fr = String(row["file_rel"]);
    if (!outgoing.has(fr)) outgoing.set(fr, new Set());
    outgoing.get(fr)!.add(String(row["symbol_name"]));
  }

  const incoming = new Map<string, Set<string>>();
  for (const row of conn
    .prepare(
      `
        SELECT DISTINCT r.file_rel, s.name AS symbol_name
          FROM symbols s
          JOIN refs r ON r.symbol_name = s.name AND r.file_rel != s.file_rel
         WHERE s.file_rel = ?
        `,
    )
    .all(rel_path) as Array<Record<string, unknown>>) {
    const fr = String(row["file_rel"]);
    if (!incoming.has(fr)) incoming.set(fr, new Set());
    incoming.get(fr)!.add(String(row["symbol_name"]));
  }

  const unresolved: string[] = (
    conn
      .prepare(
        `
            SELECT DISTINCT r.symbol_name
              FROM refs r
              LEFT JOIN symbols s ON s.name = r.symbol_name
             WHERE r.file_rel = ?
               AND r.symbol_name != ''
               AND s.name IS NULL
             ORDER BY r.symbol_name
            `,
      )
      .all(rel_path) as Array<Record<string, unknown>>
  ).map((row) => String(row["symbol_name"]));

  return [outgoing, incoming, unresolved];
}

/** Return only the outgoing file-level edges for rel_path. */
export function _collect_outgoing_edges(conn: Conn, rel_path: string): Map<string, Set<string>> {
  const outgoing = new Map<string, Set<string>>();
  for (const row of conn
    .prepare(
      `
        SELECT DISTINCT s.file_rel, r.symbol_name
          FROM refs r
          JOIN symbols s ON s.name = r.symbol_name AND s.file_rel != r.file_rel
         WHERE r.file_rel = ?
           AND r.symbol_name != ''
        `,
    )
    .all(rel_path) as Array<Record<string, unknown>>) {
    const fr = String(row["file_rel"]);
    if (!outgoing.has(fr)) outgoing.set(fr, new Set());
    outgoing.get(fr)!.add(String(row["symbol_name"]));
  }
  return outgoing;
}

/** BFS over outgoing dependency edges up to max_depth levels. */
export function _collect_transitive_outgoing(
  conn: Conn,
  start_rel: string,
  max_depth: number,
): Map<string, _DepNode> {
  const result = new Map<string, _DepNode>();
  const bfs_queue: Array<[string, number]> = [[start_rel, 0]];
  const visited = new Set<string>([start_rel]);

  while (bfs_queue.length > 0) {
    const [current, depth] = bfs_queue.shift()!;
    const next_depth = depth + 1;
    if (max_depth && next_depth > max_depth) {
      continue;
    }
    for (const [dep_file, symbols] of self._collect_outgoing_edges(conn, current)) {
      if (!visited.has(dep_file)) {
        visited.add(dep_file);
        result.set(dep_file, { depth: next_depth, via: current, symbols });
        bfs_queue.push([dep_file, next_depth]);
      } else if (result.has(dep_file) && result.get(dep_file)!.depth === next_depth) {
        const node = result.get(dep_file)!;
        for (const s of symbols) node.symbols.add(s);
      }
    }
  }

  return result;
}

/** Human-readable summary of file and edge counts, with correct plurals. */
export function _edge_summary(file_count: number, edge_count: number): string {
  const files_noun = file_count === 1 ? "file" : "files";
  const edges_noun = edge_count === 1 ? "edge" : "edges";
  return `${file_count} ${files_noun}, ${edge_count} ${edges_noun}`;
}

/** Format a dependency entry showing a file and symbols referenced from it. */
export function _format_dependency_line(file_rel: string, symbols: Set<string>): string {
  const symbol_list = Array.from(symbols).sort().join(", ");
  const count = symbols.size;
  const noun = count === 1 ? "symbol" : "symbols";
  if (symbol_list) {
    return `  - ${file_rel} (${count} ${noun}: ${symbol_list})`;
  }
  return `  - ${file_rel} (${count} ${noun})`;
}

/** Result of resolving a file-name pattern to a concrete project-relative path. */
export interface _FileTarget {
  project: Project | null;
  rel_path: string | null;
  current_project: Project | null;
}

/** Resolve a file name pattern to a concrete project-relative path. */
export function _resolve_file_target(file_part: string): _FileTarget {
  const proj = find_project(process.cwd());
  if (proj !== null) {
    const rel = read_replacement.resolve_file_rel(proj, file_part);
    if (rel !== null) {
      _LOG.debug("resolved %s -> %s (current project %s)", file_part, rel, proj.hash.slice(0, 8));
      return { project: proj, rel_path: rel, current_project: proj };
    }
    _LOG.debug(
      "file %s not found in current project %s; trying cross-project fallback",
      file_part,
      proj.hash.slice(0, 8),
    );
  } else {
    _LOG.debug("no current project detected for cwd; trying cross-project fallback for %s", file_part);
  }

  const cross = read_replacement.find_in_all_projects(file_part);
  if (cross !== null) {
    _LOG.info(
      "cross-project fallback: resolved %s -> %s (project %s)",
      file_part,
      cross[1],
      cross[0].hash.slice(0, 8),
    );
    return { project: cross[0], rel_path: cross[1], current_project: proj };
  }
  _LOG.debug("file %s not found in any indexed project", file_part);
  return { project: null, rel_path: null, current_project: proj };
}

// ANSI escape for dim/faint text (context gutter rendering).
const _ANSI_DIM = "\u001b[2m";
const _ANSI_RESET = "\u001b[0m";

/** Return *text* with context lines visually distinguished from the core body. */
export function _apply_context_gutter(
  text: string,
  context_before: number,
  context_after: number,
  opts: { no_color: boolean },
): string {
  const no_color = opts.no_color;
  if (no_color || (context_before === 0 && context_after === 0)) {
    return text;
  }
  const lines = text.split("\n");
  const total = lines.length;
  const result: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const is_context = i < context_before || i >= total - context_after;
    if (is_context) {
      result.push(`${_ANSI_DIM}│ ${line}${_ANSI_RESET}`);
    } else {
      result.push(`  ${line}`);
    }
  }
  return result.join("\n");
}

/** Emit *text* to stdout, optionally prefixed with a ``## …`` header. */
export function _emit_text_result(
  text: string,
  rel_path: string,
  item: string,
  separator_label: string,
  no_header: boolean,
  opts: { context_before?: number; context_after?: number; no_color?: boolean } = {},
): void {
  const context_before = opts.context_before ?? 0;
  const context_after = opts.context_after ?? 0;
  const no_color = opts.no_color ?? false;

  const token_header = read_replacement.token_estimate_header(text);
  if (!no_header && _isatty()) {
    _echo(`## ${rel_path} — ${separator_label}: ${item}`);
  }
  _echo(token_header);
  const is_tty = _isatty();
  const apply_color = is_tty && !no_color;
  let display_text = self._apply_context_gutter(text, context_before, context_after, {
    no_color: !apply_color,
  });
  display_text = overflow_guard.guard(display_text, { command: separator_label });
  _echo(display_text);
}

/** Return (context_before, context_after) line counts from a read result dict. */
export function _context_bounds(result: Record<string, unknown>): [number, number] {
  const core_start = result["core_start_line"];
  const core_end = result["core_end_line"];
  if (core_start === undefined || core_start === null || core_end === undefined || core_end === null) {
    return [0, 0];
  }
  const start = result["start_line"] ?? core_start;
  const end = result["end_line"] ?? core_end;
  const before = Math.max(0, Number(core_start) - Number(start));
  const after = Math.max(0, Number(end) - Number(core_end));
  return [before, after];
}

// Reader callable: read_symbol / read_section signature shape.
type _ReaderCallable = (
  project: Project,
  rel_path: string,
  item: string,
  opts: { context_lines?: number },
) => SymbolResult | SectionResult | null;

//: Internal stat fields stored in result dicts, never forwarded to callers.
const _INTERNAL_RESULT_FIELDS: ReadonlySet<string> = new Set(["bytes_total", "bytes_extracted"]);

/** Strip internal stat fields from a result dict (Python dict comprehension). */
function _stripInternal(result: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(result)) {
    if (!_INTERNAL_RESULT_FIELDS.has(k)) {
      out[k] = v;
    }
  }
  return out;
}

/** Unified handler for read/section CLI commands. */
export function _run_read_like_command(opts: {
  target: string;
  session_id: string | null;
  json_output: boolean;
  context_lines: number;
  separator_label: string;
  missing_label: string;
  stat_kind: string;
  reader: _ReaderCallable;
  no_header?: boolean;
  no_color?: boolean;
  full?: boolean;
}): void {
  const {
    target,
    session_id,
    json_output,
    context_lines,
    separator_label,
    missing_label,
    stat_kind,
    reader,
  } = opts;
  const no_header = opts.no_header ?? false;
  const no_color = opts.no_color ?? false;
  const full = opts.full ?? false;

  if (!target.includes("::")) {
    self._emit_read_error({
      code: "invalid_target",
      message: `Error: target must be '<file>::<${separator_label}>'`,
      json_output,
      err: true,
      details: { target },
    });
    throw new CliExit(2);
  }

  const sepIdx = target.indexOf("::");
  const file_part = target.slice(0, sepIdx);
  const item_part = target.slice(sepIdx + 2);

  let file_target: _FileTarget;
  try {
    file_target = self._resolve_file_target(file_part);
  } catch (exc) {
    if (exc instanceof read_replacement.ProjectIndexUnavailable) {
      self._emit_read_error({
        code: exc.code,
        message: String(exc.message),
        json_output,
        details: { file_part },
      });
      throw new CliExit(0);
    }
    if (exc instanceof read_replacement.AmbiguousFileMatch) {
      self._emit_ambiguous_file_match(file_part, exc.candidates, { json_output });
      throw new CliExit(0);
    }
    throw exc;
  }

  if (file_target.rel_path === null) {
    db.recordMiss(file_part, "");
    self._emit_file_not_found_error(file_part, file_target.current_project, { json_output });
    if (db.getMissCount(file_part, "") >= 3 && !json_output) {
      _echo(
        `[hint] Searched for '${file_part}' 3+ times without a match.` +
          " Consider: token-goat map --compact to check what's indexed," +
          " or add an alias in CLAUDE.md.",
      );
    }
    throw new CliExit(0);
  }

  const project = file_target.project!;
  db.resetMiss(file_part, "");

  // In-session result cache.
  const cache_kind = separator_label === "heading" ? "section" : "symbol";
  const cache_item_key = `${item_part}\u001ec=${context_lines}`;
  let cached_result: Record<string, unknown> | null = null;
  let file_sha = "";
  if (session_id) {
    const abs_path = path.join(project.root, file_target.rel_path);
    file_sha = self._file_sha1(abs_path);
    if (file_sha) {
      cached_result = session.get_result_cache(
        session_id,
        file_target.rel_path,
        cache_item_key,
        cache_kind,
        file_sha,
      );
    }
  }
  if (cached_result !== null && session_id) {
    _LOG.debug(
      "%s cache hit: %s::%s (kind=%s)",
      stat_kind,
      file_target.rel_path,
      item_part,
      cache_kind,
    );
    session.mark_file_read(session_id, file_target.rel_path, null, null, { symbol: item_part });
    if (json_output) {
      let out = _stripInternal(cached_result);
      const display_text = read_replacement.truncate_symbol_body(String(out["text"] ?? ""), {
        full,
      });
      out = { ...out };
      out["text"] = display_text;
      _echo(JSON.stringify(out));
    } else {
      const [cb, ca] = self._context_bounds(cached_result);
      let display_text = read_replacement.truncate_symbol_body(String(cached_result["text"]), {
        full,
      });
      if (separator_label === "symbol") {
        const footer = read_replacement.format_callers_footer(
          project,
          String(cached_result["symbol"] ?? item_part),
        );
        if (footer) {
          display_text = `${display_text}\n\n${footer}`;
        }
      }
      self._emit_text_result(display_text, file_target.rel_path, item_part, separator_label, no_header, {
        context_before: cb,
        context_after: ca,
        no_color,
      });
    }
    return;
  }

  const result = reader(project, file_target.rel_path, item_part, { context_lines }) as
    | Record<string, unknown>
    | null;
  if (result === null) {
    const _label_lower = missing_label.toLowerCase();
    let suggestions: string[];
    if (_label_lower === "symbol") {
      suggestions = self._close_symbol_matches(project, file_target.rel_path, item_part);
    } else if (_label_lower === "section") {
      suggestions = self._close_section_matches(project, file_target.rel_path, item_part);
    } else {
      suggestions = [];
    }
    let base_message = `${missing_label} not found: ${item_part} (in ${file_target.rel_path})`;
    if (suggestions.length > 0 && !json_output) {
      base_message = base_message + "\nDid you mean:";
    } else if (!json_output && _label_lower === "symbol") {
      base_message =
        base_message +
        `\nHint: run \`token-goat outline "${file_target.rel_path}"\`` +
        " to list available symbols";
    }
    db.recordMiss(item_part, file_target.rel_path || "");
    if (db.getMissCount(item_part, file_target.rel_path || "") >= 3 && !json_output) {
      base_message +=
        `\n[hint] Searched for '${item_part}' 3+ times without a match.` +
        " Consider: token-goat map --compact to check what's indexed," +
        " or add an alias in CLAUDE.md.";
    }
    self._emit_read_error({
      code: `${_label_lower}_not_found`,
      message: base_message,
      json_output,
      candidates: suggestions,
      details: { rel_path: file_target.rel_path, item: item_part, item_kind: _label_lower },
    });
    throw new CliExit(1);
  }

  db.resetMiss(item_part, file_target.rel_path || "");
  if (session_id) {
    session.mark_file_read(session_id, file_target.rel_path, null, null, { symbol: item_part });
    if (file_sha) {
      session.put_result_cache(
        session_id,
        file_target.rel_path,
        cache_item_key,
        cache_kind,
        file_sha,
        { ...result },
      );
    }
  }

  const bytes_saved = Number(result["bytes_saved"] ?? 0);
  const tokens_saved = bytes_saved > 0 ? Math.max(1, Math.floor(bytes_saved / 3) + 1) : 0;
  _LOG.debug(
    "%s served: %s::%s bytes_saved=%d tokens_saved=%d",
    stat_kind,
    file_target.rel_path,
    item_part,
    bytes_saved,
    tokens_saved,
  );
  db.recordStat(project.hash, stat_kind, {
    tokensSaved: tokens_saved,
    bytesSaved: bytes_saved,
    detail: `${file_target.rel_path}::${item_part}`,
  });

  let display_text = read_replacement.truncate_symbol_body(String(result["text"]), { full });

  if (session_id && separator_label === "symbol") {
    const _sym_name = String(result["symbol"] || item_part);
    const stale_hint = hints.build_symbol_stale_hint({
      session_id,
      file_path: path.join(project.root, file_target.rel_path),
      symbol_name: _sym_name,
      current_start_line: Number(result["start_line"] ?? 1),
      current_end_line: Number(result["end_line"] ?? 1),
      current_text: String(result["text"] ?? ""),
    });
    if (stale_hint) {
      _echo(stale_hint, { err: true });
    }
  }

  if (separator_label === "symbol" && !json_output) {
    const footer = read_replacement.format_callers_footer(
      project,
      String(result["symbol"] || item_part),
    );
    if (footer) {
      display_text = `${display_text}\n\n${footer}`;
    }
  }

  if (project !== file_target.current_project && file_target.current_project !== null) {
    const note = `[from project: ${project.root}]`;
    if (json_output) {
      const out = _stripInternal(result);
      out["_project_root"] = String(project.root);
      out["text"] = display_text;
      _echo(JSON.stringify(out));
      return;
    }
    const [cb, ca] = self._context_bounds(result);
    _echo(note, { err: true });
    self._emit_text_result(display_text, file_target.rel_path, item_part, separator_label, no_header, {
      context_before: cb,
      context_after: ca,
      no_color,
    });
    return;
  }

  if (json_output) {
    const out = _stripInternal(result);
    out["text"] = display_text;
    _echo(JSON.stringify(out));
    return;
  }
  const [cb, ca] = self._context_bounds(result);
  self._emit_text_result(display_text, file_target.rel_path, item_part, separator_label, no_header, {
    context_before: cb,
    context_after: ca,
    no_color,
  });
}

/** Show dependency graph for file. */
export function deps(
  file: string,
  opts: { json_output?: boolean; depth?: number } = {},
): void {
  const json_output = opts.json_output ?? false;
  const depth = opts.depth ?? 1;

  let file_target: _FileTarget;
  try {
    file_target = self._resolve_file_target(file);
  } catch (exc) {
    if (exc instanceof read_replacement.ProjectIndexUnavailable) {
      self._emit_read_error({
        code: exc.code,
        message: String(exc.message),
        json_output,
        details: { file_part: file },
      });
      return;
    }
    throw exc;
  }

  if (file_target.rel_path === null) {
    self._emit_file_not_found_error(file, file_target.current_project, { json_output });
    return;
  }

  const project = file_target.project!;
  const rel_path = file_target.rel_path;
  const [outgoing, incoming, unresolved, transitive] = db.openProject(project.hash, (conn) => {
    const [og, ic, un] = self._collect_dependency_graph(conn, rel_path);
    let tr = new Map<string, _DepNode>();
    if (depth !== 1) {
      tr = self._collect_transitive_outgoing(conn, rel_path, depth);
    }
    return [og, ic, un, tr] as const;
  });

  let outgoing_edge_count = 0;
  for (const v of outgoing.values()) outgoing_edge_count += v.size;
  const outgoing_file_count = outgoing.size;
  let incoming_edge_count = 0;
  for (const v of incoming.values()) incoming_edge_count += v.size;
  const incoming_file_count = incoming.size;
  _LOG.debug(
    "deps graph for %s: out=%d files/%d edges in=%d files/%d edges unresolved=%d transitive=%d",
    rel_path,
    outgoing_file_count,
    outgoing_edge_count,
    incoming_file_count,
    incoming_edge_count,
    unresolved.length,
    transitive.size,
  );

  const outgoing_sorted = Array.from(outgoing.entries()).sort((a, b) =>
    _cmpKey(_key_dep_by_size(a), _key_dep_by_size(b)),
  );
  const incoming_sorted = Array.from(incoming.entries()).sort((a, b) =>
    _cmpKey(_key_dep_by_size(a), _key_dep_by_size(b)),
  );

  if (json_output) {
    const dependencies: Record<string, string[]> = {};
    for (const [dep, syms] of outgoing_sorted) {
      dependencies[dep] = Array.from(syms).sort();
    }
    const dependents: Record<string, string[]> = {};
    for (const [dep, syms] of incoming_sorted) {
      dependents[dep] = Array.from(syms).sort();
    }
    const payload: Record<string, unknown> = {
      file: rel_path,
      depth,
      dependency_file_count: outgoing_file_count,
      dependency_edge_count: outgoing_edge_count,
      dependent_file_count: incoming_file_count,
      dependent_edge_count: incoming_edge_count,
      unresolved_ref_count: unresolved.length,
      dependencies,
      dependents,
      unresolved_refs: unresolved,
    };
    if (transitive.size > 0) {
      const all_dependencies: Record<string, unknown> = {};
      const transitive_sorted = Array.from(transitive.entries()).sort((a, b) =>
        _cmpKey(_key_transitive_by_depth(a), _key_transitive_by_depth(b)),
      );
      for (const [f, v] of transitive_sorted) {
        all_dependencies[f] = {
          depth: v.depth,
          via: v.via,
          symbols: Array.from(v.symbols).sort(),
        };
      }
      payload["all_dependencies"] = all_dependencies;
    }
    _echo(JSON.stringify(payload));
    return;
  }

  const outgoing_summary = self._edge_summary(outgoing_file_count, outgoing_edge_count);
  const incoming_summary = self._edge_summary(incoming_file_count, incoming_edge_count);
  _echo(`Dependency graph for ${rel_path}`);
  _echo(`Dependencies (${outgoing_summary}):`);
  if (outgoing.size > 0) {
    for (const [dep_rel, symbols] of outgoing_sorted) {
      _echo(self._format_dependency_line(dep_rel, symbols));
    }
  } else {
    _echo("  (none)");
  }

  if (transitive.size > 0) {
    const transitive_only = new Map<string, _DepNode>();
    for (const [f, v] of transitive) {
      if (!outgoing.has(f)) transitive_only.set(f, v);
    }
    if (transitive_only.size > 0) {
      _echo(
        `Transitive dependencies (depth 2–${depth || "∞"}, ${transitive_only.size} more files):`,
      );
      const to_sorted = Array.from(transitive_only.entries()).sort((a, b) =>
        _cmpKey(_key_transitive_by_depth(a), _key_transitive_by_depth(b)),
      );
      for (const [dep_rel, info] of to_sorted) {
        const indent = "    ".repeat(info.depth - 1);
        const via_note = info.via !== rel_path ? `  via ${info.via}` : "";
        _echo(`${indent}${self._format_dependency_line(dep_rel, info.symbols)}${via_note}`);
      }
    }
  }

  _echo(`Dependents (${incoming_summary}):`);
  if (incoming.size > 0) {
    for (const [dep_rel, symbols] of incoming_sorted) {
      _echo(self._format_dependency_line(dep_rel, symbols));
    }
  } else {
    _echo("  (none)");
  }

  if (unresolved.length > 0) {
    const noun = unresolved.length === 1 ? "ref" : "refs";
    _echo(
      `Unresolved ${noun} (${unresolved.length}): ${unresolved.slice(0, 20).join(", ")}` +
        (unresolved.length > 20 ? " ..." : ""),
    );
  }
}

const _DISK_FALLBACK_MAX_LINES = 5000;

/** Emit a bounded raw line-range read for an unindexed/over-cap on-disk file. */
export function _run_disk_fallback_line_range(opts: {
  abs_path: string;
  rel_path: string;
  start: number;
  end: number;
  item_part: string;
  session_id: string | null;
  json_output: boolean;
  no_header: boolean;
  source_root?: string | null;
}): void {
  const { abs_path, rel_path, start, end, item_part, session_id, json_output, no_header } = opts;
  const source_root = opts.source_root ?? null;

  const span = end - start + 1;
  if (span > _DISK_FALLBACK_MAX_LINES) {
    self._emit_read_error({
      code: "disk_fallback_range_too_large",
      message:
        `Line range ${start}-${end} spans ${span} lines, exceeding the ` +
        `${_DISK_FALLBACK_MAX_LINES}-line disk-fallback cap for unindexed files. ` +
        `Narrow the range (≤${_DISK_FALLBACK_MAX_LINES} lines per call).`,
      json_output,
      err: true,
      details: { rel_path, item: item_part },
    });
    throw new CliExit(2);
  }

  const lines = self._read_disk_line_range(abs_path, start, end);
  if (lines === null) {
    self._emit_read_error({
      code: "line_range_out_of_bounds",
      message: `Line range ${start}-${end} is out of bounds for ${rel_path}`,
      json_output,
      details: { rel_path, item: item_part },
    });
    throw new CliExit(0);
  }

  if (session_id) {
    session.mark_file_read(session_id, rel_path);
  }

  const text = lines.join("\n");
  const end_line = start + lines.length - 1;
  if (json_output) {
    const out: Record<string, unknown> = {
      file: rel_path,
      start_line: start,
      end_line,
      text,
      disk_fallback: true,
    };
    if (source_root !== null) {
      out["_project_root"] = String(source_root);
    }
    _echo(JSON.stringify(out));
    return;
  }

  if (source_root !== null) {
    _echo(`[disk-fallback: ${rel_path} from ${source_root} (not indexed)]`, { err: true });
  } else {
    _echo(`[disk-fallback: ${rel_path} (not indexed)]`, { err: true });
  }
  self._emit_text_result(text, rel_path, item_part, "lines", no_header);
}

/** Handle ``token-goat read file::N-M`` (line-range variant). */
export function _run_read_line_range(opts: {
  target: string;
  session_id: string | null;
  json_output: boolean;
  no_header: boolean;
}): void {
  const { target, session_id, json_output, no_header } = opts;
  const sepIdx = target.indexOf("::");
  const file_part = target.slice(0, sepIdx);
  const item_part = target.slice(sepIdx + 2);
  const range_parsed = read_replacement.parse_line_range(item_part);
  if (range_parsed === null) {
    self._emit_read_error({
      code: "invalid_target",
      message: `Error: line range '${item_part}' is invalid (expected 'N-M' with N≥1 and M≥N)`,
      json_output,
      details: { target },
      err: true,
    });
    throw new CliExit(2);
  }

  const [start, end] = range_parsed;

  let file_target: _FileTarget;
  try {
    file_target = self._resolve_file_target(file_part);
  } catch (exc) {
    if (exc instanceof read_replacement.ProjectIndexUnavailable) {
      self._emit_read_error({
        code: exc.code,
        message: String(exc.message),
        json_output,
        details: { file_part },
      });
      throw new CliExit(0);
    }
    if (exc instanceof read_replacement.AmbiguousFileMatch) {
      self._emit_ambiguous_file_match(file_part, exc.candidates, { json_output });
      throw new CliExit(0);
    }
    throw exc;
  }

  if (file_target.rel_path === null) {
    const disk_match = self._find_unindexed_file_on_disk(file_part, file_target.current_project);
    if (disk_match !== null) {
      const [abs_path, rel_path, source_root] = disk_match;
      const disclose_root = file_target.current_project === null ? source_root : null;
      self._run_disk_fallback_line_range({
        abs_path,
        rel_path,
        start,
        end,
        item_part,
        session_id,
        json_output,
        no_header,
        source_root: disclose_root,
      });
      return;
    }
    self._emit_file_not_found_error(file_part, file_target.current_project, { json_output });
    throw new CliExit(0);
  }

  const project = file_target.project!;

  const result = read_replacement.read_line_range(project, file_target.rel_path, start, end) as
    | (LineRangeResult & Record<string, unknown>)
    | null;
  if (result === null) {
    self._emit_read_error({
      code: "line_range_out_of_bounds",
      message: `Line range ${start}-${end} is out of bounds for ${file_target.rel_path}`,
      json_output,
      details: { rel_path: file_target.rel_path, item: item_part },
    });
    throw new CliExit(0);
  }

  if (session_id) {
    session.mark_file_read(session_id, file_target.rel_path);
  }

  const bytes_saved = Number(result["bytes_saved"] ?? 0);
  db.recordStat(project.hash, "read_replacement", {
    tokensSaved: bytes_saved > 0 ? Math.max(1, Math.floor(bytes_saved / 3) + 1) : 0,
    bytesSaved: bytes_saved,
    detail: `${file_target.rel_path}::${item_part}`,
  });

  const cross_project =
    project !== file_target.current_project && file_target.current_project !== null;
  if (json_output) {
    const out = _stripInternal(result as Record<string, unknown>);
    if (cross_project) {
      out["_project_root"] = String(project.root);
    }
    _echo(JSON.stringify(out));
    return;
  }

  if (cross_project) {
    _echo(`[from project: ${project.root}]`, { err: true });
  }
  self._emit_text_result(String(result["text"]), file_target.rel_path, item_part, "lines", no_header);
}

/** Read just <symbol> from <file>, not the whole file. */
export function read(
  target: string,
  opts: {
    session_id?: string | null;
    json_output?: boolean;
    context_lines?: number;
    no_header?: boolean;
    header?: boolean;
    no_color?: boolean;
    full?: boolean;
  } = {},
): void {
  const session_id = opts.session_id ?? null;
  const json_output = opts.json_output ?? false;
  const context_lines = opts.context_lines ?? 0;
  const no_header = opts.no_header ?? false;
  const header = opts.header ?? false;
  const no_color = opts.no_color ?? false;
  const full = opts.full ?? false;

  const _no_header = no_header || (!header && !_isatty());

  if (target.includes("::")) {
    const sepIdx = target.indexOf("::");
    const item_part = target.slice(sepIdx + 2);
    if (read_replacement.parse_line_range(item_part) !== null) {
      self._run_read_line_range({
        target,
        session_id,
        json_output,
        no_header: _no_header,
      });
      return;
    }
  }

  self._run_read_like_command({
    target,
    session_id,
    json_output,
    context_lines,
    separator_label: "symbol",
    missing_label: "Symbol",
    stat_kind: "read_replacement",
    reader: read_replacement.read_symbol as unknown as _ReaderCallable,
    no_header: _no_header,
    no_color,
    full,
  });
}

/** Extract just <heading> section from <file>, not the whole file. */
export function section(
  target: string,
  opts: {
    session_id?: string | null;
    json_output?: boolean;
    context_lines?: number;
    no_header?: boolean;
    header?: boolean;
    no_color?: boolean;
  } = {},
): void {
  const session_id = opts.session_id ?? null;
  const json_output = opts.json_output ?? false;
  const context_lines = opts.context_lines ?? 0;
  const no_header = opts.no_header ?? false;
  const header = opts.header ?? false;
  const no_color = opts.no_color ?? false;

  self._run_read_like_command({
    target,
    session_id,
    json_output,
    context_lines,
    separator_label: "heading",
    missing_label: "Section",
    stat_kind: "section_replacement",
    reader: read_replacement.read_section as unknown as _ReaderCallable,
    no_header: no_header || (!header && !_isatty()),
    no_color,
  });
}

/** Extract a named heading section from an installed or cached skill file. */
export function skill_section(
  skill_name: string,
  heading: string,
  opts: {
    session_id?: string | null;
    json_output?: boolean;
    context_lines?: number;
    no_header?: boolean;
    no_color?: boolean;
  } = {},
): void {
  const json_output = opts.json_output ?? false;
  const no_header = opts.no_header ?? false;
  const no_color = opts.no_color ?? false;

  let body: string | null = null;
  let source_label = `skills/${skill_name}`;

  // Strategy 1: resolve to an on-disk file and read it.
  const skill_path = skill_cache.get_skill_file_path(skill_name);
  if (skill_path !== null) {
    try {
      body = fs.readFileSync(skill_path, "utf-8");
      source_label = String(skill_path);
    } catch (exc) {
      self._emit_read_error({
        code: "skill_read_error",
        message: `Could not read skill file '${skill_path}': ${exc}`,
        json_output,
      });
      throw new CliExit(1);
    }
  }

  // Strategy 2: fall back to the skill body cache.
  if (body === null) {
    for (const candidate of skill_cache.lookup_all_by_name(skill_name)) {
      const cached_body = skill_cache.load_output(candidate.output_id);
      if (cached_body !== null) {
        body = cached_body;
        source_label = `cache:${candidate.output_id.slice(0, 16)}`;
        break;
      }
    }
  }

  if (body === null) {
    self._emit_read_error({
      code: "skill_not_found",
      message:
        `Skill '${skill_name}' not found on disk or in cache. ` +
        "Index with: token-goat index --root ~/.claude/skills/",
      json_output,
    });
    throw new CliExit(1);
  }

  const section_text = skill_cache.extract_named_section(body, heading);
  if (section_text === null) {
    const all_headings = skill_cache.extract_all_headings(body, 4);
    let msg: string;
    if (all_headings.length > 0) {
      const heading_labels = all_headings.map(([level, title]) =>
        level >= 4 ? `    ${title}` : level >= 3 ? `  ${title}` : title,
      );
      msg =
        `Section ${_pyRepr(heading)} not found in skill ${_pyRepr(skill_name)}. ` +
        `Available (##, ###, ####): ${heading_labels.join(", ")}`;
    } else {
      msg = `Section ${_pyRepr(heading)} not found in skill ${_pyRepr(skill_name)} (no headings detected)`;
    }
    self._emit_read_error({
      code: "section_not_found",
      message: msg,
      json_output,
    });
    throw new CliExit(1);
  }

  const body_bytes = _byteLen(body);
  const returned_bytes = _byteLen(section_text);
  const saved_bytes = Math.max(0, body_bytes - returned_bytes);
  const _tokens_saved = Math.max(
    0,
    compact.estimate_tokens(body) - compact.estimate_tokens(section_text),
  );
  db.recordStat(undefined, "section_replacement", {
    bytesSaved: saved_bytes,
    tokensSaved: _tokens_saved,
    detail: `${skill_name.slice(0, 40)}::${heading.slice(0, 16)}`,
  });

  if (json_output) {
    const payload: Record<string, unknown> = {
      ok: true,
      skill_name,
      heading,
      source: source_label,
      text: section_text,
      body_bytes,
    };
    _echo(JSON.stringify(payload));
    return;
  }

  const rel_label = `skills/${skill_name}`;
  self._emit_text_result(section_text, rel_label, heading, "heading", no_header || !_isatty(), {
    context_before: 0,
    context_after: 0,
    no_color,
  });
}

/** Python `repr()` of a string for error messages (single-quote preferred). */
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

// Symbol kinds worth including in a skeleton view.
const _STUB_VIEW_INCLUDE_KINDS: ReadonlySet<string> = new Set([
  "function",
  "method",
  "class",
  "interface",
  "struct",
  "trait",
  "enum",
  "type_alias",
  "constructor",
  "property",
  "decorator",
]);

const _STUB_VIEW_MAX_SYMBOLS = 80;

/** Render one symbol entry for the skeleton view. */
export function _format_stub_line(
  name: string,
  kind: string,
  line: number,
  signature: string | null,
): string {
  const sig = signature ? `  ${signature}` : "";
  return `  ${String(line).padStart(5)}  ${kind.padEnd(12)}  ${name}${sig}`;
}

// ---------------------------------------------------------------------------
// outline
// ---------------------------------------------------------------------------

const _OUTLINE_DOCSTRING_MAX_CHARS = 80;
const _OUTLINE_DOCSTRING_SCAN_LINES = 5;

const _OUTLINE_INCLUDE_KINDS: ReadonlySet<string> = new Set([
  "function",
  "async_function",
  "class",
  "interface",
  "struct",
  "trait",
  "enum",
  "type_alias",
  "constructor",
]);

const _OUTLINE_DEPTH1_KINDS: ReadonlySet<string> = new Set(["method", "constructor"]);

const _OUTLINE_ALL_KINDS: ReadonlySet<string> = new Set([
  ..._OUTLINE_INCLUDE_KINDS,
  ..._OUTLINE_DEPTH1_KINDS,
]);

const _OUTLINE_MAX_SYMBOLS = 200;

/** Return the first meaningful line of the symbol's docstring, or null. */
export function _extract_docstring_first_line(
  source_lines: string[],
  symbol_start: number,
  symbol_end: number,
): string | null {
  const scan_end = Math.min(
    symbol_start + _OUTLINE_DOCSTRING_SCAN_LINES,
    symbol_end,
    source_lines.length,
  );
  let inside_triple_quote = false;
  for (let lineno = symbol_start + 1; lineno <= scan_end; lineno++) {
    const raw = source_lines[lineno - 1]!;
    const stripped = _pyStrip(raw);
    if (!stripped) {
      continue;
    }

    // Python triple-quote: """..., '''...
    let matchedTripleQuote = false;
    for (const q of ['"""', "'''"]) {
      if (stripped.startsWith(q)) {
        matchedTripleQuote = true;
        let inner = stripped.slice(3);
        if (inner.endsWith(q)) {
          inner = inner.slice(0, -3);
        }
        const content = _pyStrip(inner);
        if (content) {
          return _cpSlice(content, _OUTLINE_DOCSTRING_MAX_CHARS);
        }
        inside_triple_quote = true;
        break;
      }
    }
    if (matchedTripleQuote) {
      continue;
    }

    // No triple-quote match on this line — Python `for/else` branch.
    if (inside_triple_quote) {
      if (stripped !== '"""' && stripped !== "'''") {
        return _cpSlice(stripped, _OUTLINE_DOCSTRING_MAX_CHARS);
      }
      return null;
    }

    // Single-line doc comment styles: // #
    for (const prefix of ["//", "#"]) {
      if (stripped.startsWith(prefix)) {
        const content = _pyStrip(stripped.slice(prefix.length));
        if (content) {
          return _cpSlice(content, _OUTLINE_DOCSTRING_MAX_CHARS);
        }
      }
    }
    // Block-comment styles: /** or /* or leading *
    if (stripped.startsWith("/**") || stripped.startsWith("/*")) {
      let inner = _pyStrip(stripped.slice(stripped.indexOf("*") + 1));
      inner = _pyLStrip(inner, "*");
      inner = _pyStrip(inner);
      if (inner && !inner.startsWith("/")) {
        return _cpSlice(inner, _OUTLINE_DOCSTRING_MAX_CHARS);
      }
    }
    if (stripped.startsWith("*") && !stripped.startsWith("*/")) {
      const inner = _pyStrip(stripped.slice(1));
      if (inner) {
        return _cpSlice(inner, _OUTLINE_DOCSTRING_MAX_CHARS);
      }
    }
    // First non-comment, non-empty line that matches no doc pattern — stop.
    break;
  }
  return null;
}

/** Python str.strip() — strips ASCII whitespace + the Python whitespace set. */
function _pyStrip(s: string): string {
  return s.replace(/^[\s ]+/, "").replace(/[\s ]+$/, "");
}

/** Python str.lstrip(chars) — strip leading run of any char in *chars*. */
function _pyLStrip(s: string, chars: string): string {
  let i = 0;
  while (i < s.length && chars.includes(s[i]!)) i++;
  return s.slice(i);
}

/** Slice the first *n* CODE POINTS of *s* (Python `s[:n]`). */
function _cpSlice(s: string, n: number): string {
  if (_cpLen(s) <= n) return s;
  let out = "";
  let i = 0;
  for (const ch of s) {
    if (i >= n) break;
    out += ch;
    i++;
  }
  return out;
}

/** Render one symbol entry for the outline view. */
export function _format_outline_line(
  name: string,
  kind: string,
  start_line: number,
  end_line: number,
  docstring_line: string | null,
  opts: { depth?: number; show_line_count?: boolean } = {},
): string {
  const depth = opts.depth ?? 0;
  const show_line_count = opts.show_line_count ?? true;
  const indent = "  ".repeat(depth);
  const range_str = `${start_line}-${end_line}`;
  const line_count = end_line - start_line + 1;
  const count_part = show_line_count ? `  (${line_count} lines)` : "";
  const doc_part = docstring_line ? `  # ${docstring_line}` : "";
  return `${indent}  ${range_str.padEnd(10)}  ${kind.padEnd(16)}  ${name}${count_part}${doc_part}`;
}

/** List symbols in <file> with line ranges, line counts, and docstring hints. */
export function outline(
  file: string,
  opts: { json_output?: boolean; max_depth?: number | null; quiet?: boolean; min_lines?: number } = {},
): void {
  const json_output = opts.json_output ?? false;
  const max_depth = opts.max_depth ?? null;
  const quiet = opts.quiet ?? false;
  const min_lines = opts.min_lines ?? 0;

  const target = self._resolve_file_target(file);
  if (target.project === null || target.rel_path === null) {
    const over_cap = self.over_cap_file_hint(file, target.current_project);
    if (over_cap !== null) {
      _echo(over_cap);
      throw new CliExit(1);
    }
    _echo(`File not found in any indexed project: ${file}`);
    const hint = target.current_project ? self._not_indexed_hint(target.current_project.hash) : null;
    if (hint) {
      _echo(hint);
    }
    throw new CliExit(1);
  }

  const proj = target.project;
  const file_rel = target.rel_path;

  const effective_max_depth = max_depth === null || max_depth <= 0 ? 0 : max_depth;

  let rows: Array<Record<string, unknown>>;
  try {
    rows = db.openProjectReadonly(proj.hash, (conn) => {
      return conn
        .prepare(
          "SELECT name, kind, line, end_line " +
            "FROM symbols " +
            "WHERE file_rel = ? AND end_line IS NOT NULL " +
            "ORDER BY line",
        )
        .all(file_rel) as Array<Record<string, unknown>>;
    });
  } catch (exc) {
    if (!_isOperationalError(exc)) throw exc;
    rows = [];
  }

  const _kind_depth = (kind: string): number => (_OUTLINE_DEPTH1_KINDS.has(kind) ? 1 : 0);

  let rows_with_depth: Array<[Record<string, unknown>, number]> = [];
  for (const row of rows) {
    const kind = String(row["kind"]);
    if (_OUTLINE_ALL_KINDS.has(kind) && _kind_depth(kind) <= effective_max_depth) {
      rows_with_depth.push([row, _kind_depth(kind)]);
    }
  }

  if (min_lines > 0) {
    rows_with_depth = rows_with_depth.filter(
      ([row]) => Number(row["end_line"]) - Number(row["line"]) + 1 >= min_lines,
    );
  }

  if (rows_with_depth.length === 0) {
    if (json_output) {
      _echo(JSON.stringify({ file: file_rel, symbols: [], results: [], total: 0 }));
    } else if (!quiet) {
      if (_count_symbols_for_file(proj.hash, file_rel) === 0) {
        _echo(self.no_indexed_symbols_note(file_rel));
      } else {
        _echo(`No indexed top-level symbols found for ${file_rel}.`);
        _echo("(Run `token-goat index --full` if this file has not been indexed yet.)");
      }
    }
    return;
  }

  const filtered = rows_with_depth.slice(0, _OUTLINE_MAX_SYMBOLS);

  if (filtered.length === 0) {
    if (json_output) {
      _echo(JSON.stringify({ file: file_rel, symbols: [], results: [], total: 0 }));
    } else if (!quiet) {
      _echo(`No structural top-level symbols found for ${file_rel}.`);
    }
    return;
  }

  let source_lines: string[] = [];
  const abs_path = path.join(proj.root, file_rel);
  try {
    source_lines = _splitlines(fs.readFileSync(abs_path, "utf-8"));
  } catch {
    // OSError suppressed (Python contextlib.suppress(OSError)).
  }

  if (json_output) {
    const out: Array<Record<string, unknown>> = [];
    for (const [row, depth] of filtered) {
      const doc =
        source_lines.length > 0
          ? self._extract_docstring_first_line(source_lines, Number(row["line"]), Number(row["end_line"]))
          : null;
      const line_count = Number(row["end_line"]) - Number(row["line"]) + 1;
      out.push({
        name: row["name"],
        kind: row["kind"],
        start_line: row["line"],
        end_line: row["end_line"],
        line_count,
        depth,
        docstring: doc,
      });
    }
    _echo(JSON.stringify({ file: file_rel, symbols: out, results: out, total: out.length }));
    return;
  }

  const rendered_outline: string[] = [];
  for (const [row, depth] of filtered) {
    const doc =
      source_lines.length > 0
        ? self._extract_docstring_first_line(source_lines, Number(row["line"]), Number(row["end_line"]))
        : null;
    rendered_outline.push(
      self._format_outline_line(
        String(row["name"]),
        String(row["kind"]),
        Number(row["line"]),
        Number(row["end_line"]),
        doc,
        { depth },
      ),
    );
  }

  if (!quiet) {
    _echo(`# Outline: ${file_rel}  (${filtered.length} symbols)`);
  }
  for (const line of rendered_outline) {
    _echo(line);
  }

  try {
    const src_bytes = fs.statSync(abs_path).size;
    let outline_bytes = 0;
    for (const line of rendered_outline) outline_bytes += _byteLen(line);
    const saved = Math.max(0, src_bytes - outline_bytes);
    db.recordStat(undefined, "outline", {
      bytesSaved: saved,
      tokensSaved: saved > 0 ? Math.max(1, Math.floor(saved / 3) + 1) : 0,
      detail: file_rel,
    });
  } catch {
    // pass (Python bare except).
  }
}

// ---------------------------------------------------------------------------
// scope
// ---------------------------------------------------------------------------

const _SCOPE_MAX_IMPORTS = 15;

const _SCOPE_ENCLOSING_KINDS: ReadonlySet<string> = new Set([
  "function",
  "async_function",
  "method",
  "class",
  "interface",
  "struct",
  "trait",
  "enum",
  "constructor",
  "css_selector",
  "css_mixin",
  "css_keyframe",
  "css_rule",
  "sql_function",
  "sql_procedure",
  "sql_trigger",
  "sql_table",
  "sql_view",
  "graphql_type",
  "graphql_interface",
  "graphql_input",
  "graphql_enum",
  "graphql_union",
  "graphql_fragment",
  "graphql_query",
  "graphql_mutation",
  "graphql_subscription",
  "graphql_extend",
  "makefile_target",
  "makefile_define",
]);

/** Show what symbols are in scope at <file>:<line>. */
export function scope(target: string, opts: { json_output?: boolean } = {}): void {
  const json_output = opts.json_output ?? false;

  if (!target.includes(":")) {
    _echo("Error: target must be '<file>:<line>' — e.g., 'src/foo.py:42'", { err: true });
    throw new CliExit(2);
  }

  const last_colon = target.lastIndexOf(":");
  const file_part = target.slice(0, last_colon);
  const line_part = target.slice(last_colon + 1);

  let target_line: number;
  if (!_isPyInt(line_part)) {
    _echo(`Error: line number must be a positive integer, got '${line_part}'`, { err: true });
    throw new CliExit(2);
  }
  target_line = Number.parseInt(line_part, 10);
  if (target_line < 1) {
    _echo(`Error: line number must be a positive integer, got '${line_part}'`, { err: true });
    throw new CliExit(2);
  }

  const file_target = self._resolve_file_target(file_part);
  if (file_target.rel_path === null) {
    self._emit_file_not_found_error(file_part, file_target.current_project, { json_output });
    throw new CliExit(0);
  }

  const proj = file_target.project!;
  const file_rel = file_target.rel_path;

  let enclosing_rows: Array<Record<string, unknown>> = [];
  let import_rows: Array<Record<string, unknown>> = [];
  let out_of_range = false;

  db.openProjectReadonly(proj.hash, (conn) => {
    try {
      const file_row = conn
        .prepare("SELECT line_count FROM files WHERE rel_path = ?")
        .get(file_rel) as Record<string, unknown> | undefined;
      if (
        file_row !== undefined &&
        file_row["line_count"] !== null &&
        file_row["line_count"] !== undefined &&
        target_line > Number(file_row["line_count"])
      ) {
        out_of_range = true;
      }
    } catch (exc) {
      if (!_isOperationalError(exc)) throw exc;
    }

    try {
      enclosing_rows = conn
        .prepare(
          "SELECT name, kind, line, end_line " +
            "FROM symbols " +
            "WHERE file_rel = ? " +
            "  AND line <= ? AND end_line >= ? " +
            "  AND end_line IS NOT NULL " +
            "ORDER BY line ASC",
        )
        .all(file_rel, target_line, target_line) as Array<Record<string, unknown>>;
    } catch (exc) {
      if (!_isOperationalError(exc)) throw exc;
      enclosing_rows = [];
    }

    enclosing_rows = enclosing_rows.filter((r) => _SCOPE_ENCLOSING_KINDS.has(String(r["kind"])));

    try {
      import_rows = conn
        .prepare(
          "SELECT target, line " +
            "FROM imports_exports " +
            "WHERE file_rel = ? AND kind = 'import' " +
            "ORDER BY line ASC",
        )
        .all(file_rel) as Array<Record<string, unknown>>;
    } catch (exc) {
      if (!_isOperationalError(exc)) throw exc;
      import_rows = [];
    }
  });

  if (out_of_range) {
    const warn_msg =
      `Warning: line ${target_line} is beyond the end of ${file_rel}; ` +
      "showing module-level scope only.";
    if (json_output) {
      _LOG.warning(warn_msg);
    } else {
      _echo(warn_msg, { err: true });
    }
    enclosing_rows = [];
  }

  let innermost_fn: string | null = null;
  for (let i = enclosing_rows.length - 1; i >= 0; i--) {
    const row = enclosing_rows[i]!;
    const kind = String(row["kind"]);
    if (kind === "function" || kind === "async_function" || kind === "method") {
      innermost_fn = String(row["name"]);
      break;
    }
  }

  const total_imports = import_rows.length;
  const display_imports = import_rows.slice(0, _SCOPE_MAX_IMPORTS);
  const truncated_imports = total_imports - display_imports.length;

  if (json_output) {
    const enclosing_out = enclosing_rows.map((row) => ({
      name: row["name"],
      kind: row["kind"],
      start_line: row["line"],
      end_line: row["end_line"],
    }));
    const imports_out = display_imports.map((r) => r["target"]);
    const result: Record<string, unknown> = {
      file: file_rel,
      line: target_line,
      enclosing: enclosing_out,
      imports: imports_out,
    };
    if (truncated_imports) {
      result["imports_truncated"] = truncated_imports;
    }
    if (innermost_fn) {
      result["suggestion"] = `token-goat read "${file_rel}::${innermost_fn}"`;
    }
    _echo(JSON.stringify(result));
    return;
  }

  _echo(`# Scope at ${file_rel}:${target_line}`);
  _echo("");

  _echo("Enclosing scope:");
  if (enclosing_rows.length > 0) {
    for (const row of enclosing_rows) {
      _echo(
        `  ${String(row["kind"]).padEnd(16)}  ${row["name"]}  (lines ${row["line"]}–${row["end_line"]})`,
      );
    }
  } else {
    _echo("  (module level — no enclosing function or class)");
  }

  _echo("");
  _echo("Module-level imports:");
  if (display_imports.length > 0) {
    for (const imp of display_imports) {
      _echo(`  ${imp["target"]}`);
    }
    if (truncated_imports) {
      _echo(`  ... and ${truncated_imports} more`);
    }
  } else {
    _echo("  (none)");
  }

  if (innermost_fn) {
    _echo("");
    _echo(`Suggestion: token-goat read "${file_rel}::${innermost_fn}"`);
  }
}

/** Python `int(s)` acceptance: optional sign, decimal digits, surrounding ws. */
function _isPyInt(s: string): boolean {
  const t = _pyStrip(s);
  return /^[+-]?\d+$/.test(t);
}

// ---------------------------------------------------------------------------
// stub_view (skeleton)
// ---------------------------------------------------------------------------

const _DIR_LISTING_MAX = 200;

/** Return every project recorded in the global index DB (fail-soft). */
export function _all_indexed_projects(): Project[] {
  let rows: Array<Record<string, unknown>>;
  try {
    rows = db.openGlobalReadonly((gconn) => {
      return gconn.prepare("SELECT hash, root, marker FROM projects").all() as Array<
        Record<string, unknown>
      >;
    });
  } catch (exc) {
    if (!_isOperationalError(exc)) {
      // Python: `except Exception` also swallows everything — never let a
      // cross-project lookup crash the command.
    }
    return [];
  }
  const projects: Project[] = [];
  for (const row of rows) {
    try {
      projects.push({
        root: String(row["root"]),
        hash: String(row["hash"]),
        marker: String(row["marker"]),
      });
    } catch {
      continue;
    }
  }
  return projects;
}

/** Return indexed rel_paths in *project* that live under directory *prefix*. */
export function _indexed_paths_under(project: Project, prefix: string): string[] {
  const like = read_replacement._escape_like_pattern(prefix) + "%";
  let rows: Array<Record<string, unknown>>;
  try {
    rows = db.openProjectReadonly(project.hash, (conn) => {
      return conn
        .prepare("SELECT rel_path FROM files WHERE rel_path LIKE ? ESCAPE '\\' ORDER BY rel_path")
        .all(like) as Array<Record<string, unknown>>;
    });
  } catch (exc) {
    if (!_isOperationalError(exc)) throw exc;
    return [];
  }
  return rows.map((row) => String(row["rel_path"]));
}

/** Treat *file_part* as a directory and list indexed files beneath it. */
export function _indexed_dir_listing(file_part: string, target: _FileTarget): string[] | null {
  let norm = file_part.replace(/\\/g, "/").trim();
  norm = norm.replace(/\/+$/, "");
  if (!norm) {
    return null;
  }
  const prefix = norm + "/";

  const seen_hashes = new Set<string>();
  const projects: Project[] = [];
  if (target.current_project !== null) {
    projects.push(target.current_project);
    seen_hashes.add(target.current_project.hash);
  }
  for (const proj of self._all_indexed_projects()) {
    if (!seen_hashes.has(proj.hash)) {
      projects.push(proj);
      seen_hashes.add(proj.hash);
    }
  }

  let matches: string[] = [];
  for (const proj of projects) {
    const found = self._indexed_paths_under(proj, prefix);
    if (found.length > 0) {
      matches = found;
      break;
    }
  }

  if (matches.length > 0) {
    return Array.from(new Set(matches)).sort();
  }

  try {
    if (fs.statSync(file_part).isDirectory()) {
      return [];
    }
  } catch {
    // pass
  }
  return null;
}

/** Print the indexed-directory result for *file_part* to stdout (exit 0). */
export function _echo_dir_listing(file_part: string, files: string[]): void {
  if (files.length === 0) {
    _echo(`token-goat: '${file_part}' is a directory with no indexed files.`);
    return;
  }
  const shown = files.slice(0, _DIR_LISTING_MAX);
  _echo(`token-goat: '${file_part}' is a directory. Indexed files under it:`);
  for (const rel of shown) {
    _echo(`  ${rel}`);
  }
  if (files.length > shown.length) {
    _echo(
      `  ... and ${files.length - shown.length} more (showing first ${shown.length} of ${files.length}).`,
    );
  }
}

/** Show all signatures in <file> without bodies. */
export function stub_view(
  file: string,
  opts: { json_output?: boolean; include_private?: boolean } = {},
): void {
  const json_output = opts.json_output ?? false;
  const include_private = opts.include_private ?? false;

  const target = self._resolve_file_target(file);
  if (target.project === null || target.rel_path === null) {
    const listing = self._indexed_dir_listing(file, target);
    if (listing !== null) {
      self._echo_dir_listing(file, listing);
      return;
    }
    _echo(`File not found in any indexed project: ${file}`);
    throw new CliExit(1);
  }

  const proj = target.project;
  const file_rel = target.rel_path;

  let rows: Array<Record<string, unknown>>;
  try {
    rows = db.openProjectReadonly(proj.hash, (conn) => {
      return conn
        .prepare(
          "SELECT name, kind, line, signature " +
            "FROM symbols " +
            "WHERE file_rel = ? AND end_line IS NOT NULL " +
            "ORDER BY line",
        )
        .all(file_rel) as Array<Record<string, unknown>>;
    });
  } catch (exc) {
    if (!_isOperationalError(exc)) throw exc;
    rows = [];
  }

  if (rows.length === 0) {
    _echo(`No indexed symbols found for ${file_rel}.`);
    return;
  }

  const filtered = rows
    .filter(
      (row) =>
        _STUB_VIEW_INCLUDE_KINDS.has(String(row["kind"])) &&
        (include_private || !String(row["name"]).startsWith("_")),
    )
    .slice(0, _STUB_VIEW_MAX_SYMBOLS);

  if (json_output) {
    const out = filtered.map((row) => ({
      name: row["name"],
      kind: row["kind"],
      line: row["line"],
      signature: row["signature"],
    }));
    _echo(JSON.stringify(out));
    return;
  }

  const rendered_lines = filtered.map((row) =>
    self._format_stub_line(
      String(row["name"]),
      String(row["kind"]),
      Number(row["line"]),
      row["signature"] === null || row["signature"] === undefined ? null : String(row["signature"]),
    ),
  );
  _echo(`# Skeleton: ${file_rel}  (${filtered.length} symbols)`);
  for (const line of rendered_lines) {
    _echo(line);
  }

  try {
    const abs_path = path.join(proj.root, file_rel);
    const src_bytes = fs.statSync(abs_path).size;
    let stub_bytes = 0;
    for (const line of rendered_lines) stub_bytes += _byteLen(line);
    const saved = Math.max(0, src_bytes - stub_bytes);
    db.recordStat(undefined, "stub_view", {
      bytesSaved: saved,
      tokensSaved: saved > 0 ? Math.max(1, Math.floor(saved / 3) + 1) : 0,
      detail: file_rel,
    });
  } catch {
    // pass
  }
}

// ---------------------------------------------------------------------------
// exports
// ---------------------------------------------------------------------------

/** List public (exported) symbols from <file> with types and docstring hints. */
export function exports(file: string, opts: { json_output?: boolean } = {}): void {
  const json_output = opts.json_output ?? false;

  const target = self._resolve_file_target(file);
  if (target.project === null || target.rel_path === null) {
    _echo(`File not found in any indexed project: ${file}`);
    const hint = target.current_project ? self._not_indexed_hint(target.current_project.hash) : null;
    if (hint) {
      _echo(hint);
    }
    throw new CliExit(1);
  }

  const proj = target.project;
  const file_rel = target.rel_path;

  const export_rows = db.get_file_exports(proj.hash, file_rel);

  let source_lines: string[] = [];
  const abs_path = path.join(proj.root, file_rel);
  try {
    source_lines = _splitlines(fs.readFileSync(abs_path, "utf-8"));
  } catch {
    // OSError suppressed
  }

  if (json_output) {
    const out: Array<Record<string, unknown>> = [];
    for (const row of export_rows) {
      const start = Number(row.start_line);
      const end = row.end_line !== null ? Number(row.end_line) : start;
      const doc =
        source_lines.length > 0
          ? self._extract_docstring_first_line(source_lines, start, end)
          : null;
      out.push({
        name: row.name,
        kind: row.kind,
        start_line: start,
        end_line: row.end_line,
        docstring: doc,
      });
    }
    _echo(JSON.stringify({ file: file_rel, symbols: out }));
    return;
  }

  const count = export_rows.length;
  if (count === 0) {
    _echo(`No public symbols found for ${file_rel}.`);
    _echo("(Run `token-goat index --full` if this file has not been indexed yet.)");
    return;
  }

  _echo(`# Exports: ${file_rel}  (${count} public symbol${count !== 1 ? "s" : ""})`);
  for (const row of export_rows) {
    const start = Number(row.start_line);
    const end = row.end_line !== null ? Number(row.end_line) : start;
    const doc =
      source_lines.length > 0 ? self._extract_docstring_first_line(source_lines, start, end) : null;
    _echo(self._format_outline_line(String(row.name), String(row.kind), start, end, doc));
  }

  try {
    const src_bytes = fs.statSync(abs_path).size;
    let export_bytes = 0;
    for (const r of export_rows) {
      const sl = Number(r.start_line);
      const el = r.end_line !== null ? Number(r.end_line) : sl;
      export_bytes += _byteLen(
        self._format_outline_line(String(r.name), String(r.kind), sl, el, null),
      );
    }
    const saved = Math.max(0, src_bytes - export_bytes);
    db.recordStat(undefined, "exports", {
      bytesSaved: saved,
      tokensSaved: saved > 0 ? Math.max(1, Math.floor(saved / 3) + 1) : 0,
      detail: file_rel,
    });
  } catch {
    // pass
  }
}

// ---------------------------------------------------------------------------
// imports
// ---------------------------------------------------------------------------

/** Show the import graph for *file_target* one level deep. */
export function imports(file_target: string, opts: { json_output?: boolean } = {}): void {
  const json_output = opts.json_output ?? false;

  const target = self._resolve_file_target(file_target);
  if (target.project === null || target.rel_path === null) {
    _echo(`File not found in any indexed project: ${file_target}`);
    const hint = target.current_project ? self._not_indexed_hint(target.current_project.hash) : null;
    if (hint) {
      _echo(hint);
    }
    throw new CliExit(1);
  }

  const proj = target.project;
  const file_rel = target.rel_path;

  const imports_from = db.get_file_imports(proj.hash, file_rel);
  const imported_by = db.get_file_importers(proj.hash, file_rel);

  if (json_output) {
    _echo(
      JSON.stringify({
        file: file_rel,
        imports_from,
        imported_by,
      }),
    );
    return;
  }

  _echo(`Imports from (${imports_from.length}):`);
  if (imports_from.length > 0) {
    for (const p of imports_from) {
      _echo(`  ${p}`);
    }
  } else {
    _echo("  (none)");
  }

  _echo(`Imported by (${imported_by.length}):`);
  if (imported_by.length > 0) {
    for (const p of imported_by) {
      _echo(`  ${p}`);
    }
  } else {
    _echo("  (none)");
  }
}

// ---------------------------------------------------------------------------
// refs
// ---------------------------------------------------------------------------

/** Show all call-sites that reference a symbol defined in <file>. */
export function refs(
  target: string,
  opts: { limit?: number; json_output?: boolean; callers?: boolean } = {},
): void {
  const limit = opts.limit ?? 50;
  const json_output = opts.json_output ?? false;
  const callers = opts.callers ?? false;

  if (!target.includes("::")) {
    _echo(
      `Invalid format ${_pyRepr(target)} — expected <file>::<symbol>  ` +
        "(e.g. 'src/auth.py::login')",
      { err: true },
    );
    throw new CliExit(1);
  }

  const sepIdx = target.indexOf("::");
  const file_part_raw = target.slice(0, sepIdx);
  const symbol_name_raw = target.slice(sepIdx + 2);
  const symbol_name = _pyStrip(symbol_name_raw);
  const file_part = _pyStrip(file_part_raw);

  if (!file_part || !symbol_name) {
    _echo("Both <file> and <symbol> must be non-empty in <file>::<symbol>", { err: true });
    throw new CliExit(1);
  }

  const file_target = self._resolve_file_target(file_part);
  if (file_target.project === null || file_target.rel_path === null) {
    _echo(`File not found in any indexed project: ${file_part}`);
    const hint = file_target.current_project
      ? self._not_indexed_hint(file_target.current_project.hash)
      : null;
    if (hint) {
      _echo(hint);
    }
    throw new CliExit(1);
  }

  const proj = file_target.project;
  const file_rel = file_target.rel_path;

  let rows: Array<Record<string, unknown>>;
  if (callers) {
    rows = db.get_refs_with_callers(proj.hash, file_rel, symbol_name, limit) as Array<
      Record<string, unknown>
    >;
  } else {
    rows = db.get_symbol_refs(proj.hash, file_rel, symbol_name, limit) as Array<
      Record<string, unknown>
    >;
  }

  if (json_output) {
    _echo(
      JSON.stringify({
        query: target,
        results: rows,
        total: rows.length,
        file: file_rel,
        symbol: symbol_name,
        refs: rows,
      }),
    );
    return;
  }

  const count = rows.length;
  if (count === 0) {
    _echo(`No references found for ${file_rel}::${symbol_name}`);
    return;
  }

  try {
    const _bytes_saved = count * 80;
    db.recordStat(proj.hash, "symbol_read", {
      bytesSaved: _bytes_saved,
      tokensSaved: Math.max(1, Math.floor(_bytes_saved / 3) + 1),
      detail: `${file_rel}::${symbol_name}`,
    });
  } catch {
    // best-effort
  }

  _echo(`${count} reference${count !== 1 ? "s" : ""} to ${file_rel}::${symbol_name}`);

  if (callers) {
    self._render_refs_with_callers(rows);
  } else {
    const use_tty_color = _isatty();
    for (const row of rows) {
      const p = row["path"];
      const line = row["line"];
      const ctx = String(row["context"] ?? "").trim();
      const loc = `${p}:${line}`;
      if (ctx) {
        if (use_tty_color) {
          _echo(`${loc}: \u001b[2m${ctx}\u001b[0m`);
        } else {
          _echo(`${loc}: ${ctx}`);
        }
      } else {
        _echo(loc);
      }
    }
  }
}

/** Render ``--callers`` output grouped by file. */
export function _render_refs_with_callers(rows: Array<Record<string, unknown>>): void {
  // Group rows by path, preserving insertion order (Map iteration order).
  const groups = new Map<string, Array<Record<string, unknown>>>();
  for (const row of rows) {
    const p = String(row["path"]);
    if (!groups.has(p)) groups.set(p, []);
    groups.get(p)!.push(row);
  }

  const use_tty_color = _isatty();
  for (const [p, file_rows] of groups) {
    if (use_tty_color) {
      _echo(`\u001b[1m${p}\u001b[0m:`);
    } else {
      _echo(`${p}:`);
    }
    for (const row of file_rows) {
      const line = Number(row["line"]);
      const caller_name = row["caller_name"];
      let entry: string;
      if (caller_name) {
        entry = `  ${caller_name}() at line ${line}`;
      } else {
        entry = `  <module level> at line ${line}`;
      }
      if (use_tty_color) {
        _echo(`\u001b[2m${entry}\u001b[0m`);
      } else {
        _echo(entry);
      }
    }
  }
}

// ---------------------------------------------------------------------------
// changed
// ---------------------------------------------------------------------------

/** List symbols that changed since *since_ref*. */
export function changed(
  opts: {
    since_ref?: string;
    json_output?: boolean;
    limit?: number;
    symbol_mode?: boolean;
    quiet?: boolean;
  } = {},
): void {
  const since_ref = opts.since_ref ?? "HEAD~5";
  const json_output = opts.json_output ?? false;
  const limit = opts.limit ?? 50;
  const symbol_mode = opts.symbol_mode ?? false;
  const quiet = opts.quiet ?? false;

  const cwd = process.cwd();

  if (symbol_mode) {
    const file_entries = git_history.get_changed_symbols_db(cwd, since_ref, limit);

    try {
      const _n = file_entries.length;
      const _bs = _n * 400;
      db.recordStat(undefined, "changed_lookup", {
        bytesSaved: _bs,
        tokensSaved: _bs > 0 ? Math.max(1, Math.floor(_bs / 3) + 1) : 0,
        detail: `since=${since_ref} mode=symbol hits=${_n}`,
      });
    } catch {
      // best-effort
    }

    if (json_output) {
      _echo(
        JSON.stringify({
          since: since_ref,
          query: since_ref,
          results: file_entries,
          total: file_entries.length,
          count: file_entries.length,
          files: file_entries,
        }),
      );
      return;
    }

    if (file_entries.length === 0) {
      if (!quiet) {
        _echo(`No symbol changes since ${since_ref} (--symbol mode)`);
      }
      return;
    }

    const count = file_entries.length;
    const noun = count === 1 ? "file changed" : "files changed";
    if (!quiet) {
      _echo(`${count} ${noun} since ${since_ref}`);
      _echo("");
    }

    for (const entry of file_entries) {
      const sym_list = entry.symbols;
      const sym_count = entry.symbol_count;
      const sym_noun = sym_count === 1 ? "symbol changed" : "symbols changed";
      const sym_display = sym_list.map((s) => `${s}()`).join(", ");
      _echo(`  ${entry.file}: ${sym_display} — ${sym_count} ${sym_noun}`);
    }
    return;
  }

  const entries = git_history.get_changed_symbols(cwd, since_ref, limit);

  try {
    const _n = entries.length;
    const _bs = _n * 400;
    db.recordStat(undefined, "changed_lookup", {
      bytesSaved: _bs,
      tokensSaved: _bs > 0 ? Math.max(1, Math.floor(_bs / 3) + 1) : 0,
      detail: `since=${since_ref} mode=default hits=${_n}`,
    });
  } catch {
    // best-effort
  }

  if (json_output) {
    _echo(
      JSON.stringify({
        since: since_ref,
        query: since_ref,
        results: entries,
        total: entries.length,
        count: entries.length,
        symbols: entries,
      }),
    );
    return;
  }

  if (entries.length === 0) {
    if (!quiet) {
      _echo(`No symbol changes since ${since_ref}`);
    }
    return;
  }

  const count = entries.length;
  const noun = count === 1 ? "symbol change" : "symbol changes";
  if (!quiet) {
    _echo(`${count} ${noun} since ${since_ref}`);
    _echo("");
  }

  let file_w = Math.max(...entries.map((e) => _cpLen(String(e.file))));
  let sym_w = Math.max(...entries.map((e) => _cpLen(String(e.symbol))));
  file_w = Math.min(file_w, 50);
  sym_w = Math.min(sym_w, 40);

  for (const entry of entries) {
    const file_col = _ljust(_cpSlice(String(entry.file), file_w), file_w);
    const sym_col = _ljust(_cpSlice(String(entry.symbol), sym_w), sym_w);
    const added = entry.lines_added;
    const removed = entry.lines_removed;
    _echo(`  ${file_col}  ${sym_col}  +${added} -${removed}`);
  }
}

/** Python str.ljust(width) — pad with spaces to *width* code points. */
function _ljust(s: string, width: number): string {
  const len = _cpLen(s);
  if (len >= width) return s;
  return s + " ".repeat(width - len);
}

// ---------------------------------------------------------------------------
// blame
// ---------------------------------------------------------------------------

/** Show git blame for the lines of *target* (``file::symbol`` format). */
export function blame(target: string, opts: { json_output?: boolean } = {}): void {
  const json_output = opts.json_output ?? false;

  if (!target.includes("::")) {
    self._emit_read_error({
      code: "invalid_target",
      message: "Error: target must be '<file>::<symbol>'",
      json_output,
      details: { target },
      err: true,
    });
    throw new CliExit(2);
  }

  const sepIdx = target.indexOf("::");
  const file_part = _pyStrip(target.slice(0, sepIdx));
  const symbol_name = _pyStrip(target.slice(sepIdx + 2));

  if (!file_part || !symbol_name) {
    self._emit_read_error({
      code: "invalid_target",
      message: "Error: both <file> and <symbol> must be non-empty",
      json_output,
      details: { target },
      err: true,
    });
    throw new CliExit(2);
  }

  let file_target: _FileTarget;
  try {
    file_target = self._resolve_file_target(file_part);
  } catch (exc) {
    if (exc instanceof read_replacement.ProjectIndexUnavailable) {
      self._emit_read_error({
        code: exc.code,
        message: String(exc.message),
        json_output,
        details: { file_part },
      });
      throw new CliExit(0);
    }
    if (exc instanceof read_replacement.AmbiguousFileMatch) {
      self._emit_ambiguous_file_match(file_part, exc.candidates, { json_output });
      throw new CliExit(0);
    }
    throw exc;
  }

  if (file_target.rel_path === null) {
    self._emit_file_not_found_error(file_part, file_target.current_project, { json_output });
    throw new CliExit(0);
  }

  const proj = file_target.project!;
  const file_rel = file_target.rel_path;

  let row: Record<string, unknown> | null = null;
  try {
    row = db.openProjectReadonly(proj.hash, (conn) => {
      return (conn
        .prepare(
          "SELECT line, end_line FROM symbols " +
            "WHERE file_rel = ? AND name = ? AND end_line IS NOT NULL " +
            "ORDER BY line LIMIT 1",
        )
        .get(file_rel, symbol_name) ?? null) as Record<string, unknown> | null;
    });
  } catch {
    row = null;
  }

  if (row === null) {
    const suggestions = self._close_symbol_matches(proj, file_rel, symbol_name);
    let base_message = `Symbol not found: ${symbol_name} (in ${file_rel})`;
    if (suggestions.length > 0 && !json_output) {
      base_message = base_message + "\nDid you mean:";
    }
    self._emit_read_error({
      code: "symbol_not_found",
      message: base_message,
      json_output,
      candidates: suggestions,
      details: { rel_path: file_rel, item: symbol_name },
    });
    throw new CliExit(0);
  }

  const start_line = Number(row["line"]);
  const end_line = Number(row["end_line"]);

  let repo_root = process.cwd();
  if (proj !== null) {
    repo_root = String(proj.root);
  }

  const blame_lines = git_history.blame_symbol(repo_root, file_rel, start_line, end_line);

  if (blame_lines.length === 0) {
    const msg = `git blame returned no output for ${file_rel} lines ${start_line}-${end_line}`;
    if (json_output) {
      _echo(JSON.stringify({ ok: false, error: msg }));
    } else {
      _echo(msg);
    }
    throw new CliExit(0);
  }

  if (json_output) {
    _echo(
      JSON.stringify({
        file: file_rel,
        symbol: symbol_name,
        start_line,
        end_line,
        lines: blame_lines,
      }),
    );
    return;
  }

  const hash_width = 8;
  for (const entry of blame_lines) {
    const short_hash = String(entry.commit_hash).slice(0, hash_width);
    const author = String(entry.author);
    const date = String(entry.date);
    const line_no = Number(entry.line_no);
    const content = String(entry.content);
    _echo(`${short_hash} (${author} ${date}) ${line_no}: ${content}`);
  }
}

// ---------------------------------------------------------------------------
// test_for
// ---------------------------------------------------------------------------

const _TEST_FOR_INLINE_CAP = 10;

/** Return test function names from *test_rel* (fail-soft). */
export function _get_test_functions(project_hash: string, test_rel: string): string[] {
  try {
    return db.openProjectReadonly(project_hash, (conn) => {
      const rows = conn
        .prepare(
          "SELECT name FROM symbols " +
            "WHERE file_rel = ? AND kind IN ('function', 'async_function') " +
            "AND name LIKE 'test_%' " +
            "ORDER BY line",
        )
        .all(test_rel) as Array<Record<string, unknown>>;
      return rows.map((r) => String(r["name"]));
    });
  } catch {
    return [];
  }
}

/** Return (rel_path, source) pairs for test files corresponding to *module*. */
export function _find_test_files_for(proj: Project, module: string): Array<[string, string]> {
  const found: Array<[string, string]> = [];
  const seen = new Set<string>();

  const _add = (rel: string, source: string): void => {
    if (seen.has(rel)) {
      return;
    }
    let row: unknown = null;
    try {
      row = db.openProjectReadonly(proj.hash, (conn) => {
        return conn.prepare("SELECT 1 FROM files WHERE rel_path = ? LIMIT 1").get(rel) ?? null;
      });
    } catch (exc) {
      if (!_isOperationalError(exc)) throw exc;
      row = null;
    }
    if (row !== null) {
      seen.add(rel);
      found.push([rel, source]);
    } else {
      const abs_path = path.join(proj.root, rel);
      if (_isFile(abs_path)) {
        seen.add(rel);
        found.push([rel, source]);
      }
    }
  };

  // Heuristic a.
  _add(`tests/test_${module}.py`, "heuristic-a");

  // Heuristic b.
  if (found.length === 0) {
    try {
      const rows = db.openProjectReadonly(proj.hash, (conn) => {
        return conn
          .prepare(
            "SELECT rel_path FROM files " +
              "WHERE rel_path LIKE ? AND rel_path LIKE '%.py' " +
              "ORDER BY rel_path",
          )
          .all(`%test_${module}.py`) as Array<Record<string, unknown>>;
      });
      for (const r of rows) {
        const rel = String(r["rel_path"]);
        if (!seen.has(rel)) {
          seen.add(rel);
          found.push([rel, "heuristic-b"]);
        }
      }
    } catch (exc) {
      if (!_isOperationalError(exc)) throw exc;
    }
  }

  // Heuristic c.
  if (found.length === 0) {
    try {
      const rows = db.openProjectReadonly(proj.hash, (conn) => {
        return conn
          .prepare(
            "SELECT DISTINCT caller_file FROM refs " +
              "WHERE caller_file LIKE '%test%.py' " +
              "AND (target_module LIKE ? OR target_module LIKE ?) " +
              "ORDER BY caller_file",
          )
          .all(`%.${module}`, `%${module}`) as Array<Record<string, unknown>>;
      });
      for (const r of rows) {
        const rel = String(r["caller_file"]);
        if (!seen.has(rel)) {
          seen.add(rel);
          found.push([rel, "heuristic-c"]);
        }
      }
    } catch (exc) {
      if (!_isOperationalError(exc)) throw exc;
    }
  }

  return found;
}

/** Given an implementation file, find the corresponding test file(s). */
export function test_for(file_target: string, opts: { json_output?: boolean } = {}): void {
  const json_output = opts.json_output ?? false;

  const target = self._resolve_file_target(file_target);
  if (target.project === null || target.rel_path === null) {
    _echo(`File not found in any indexed project: ${file_target}`);
    const hint = target.current_project ? self._not_indexed_hint(target.current_project.hash) : null;
    if (hint) {
      _echo(hint);
    }
    throw new CliExit(1);
  }

  const proj = target.project;
  const impl_rel = target.rel_path;

  // Module stem: basename without extension.
  const base = path.posix.basename(impl_rel.replace(/\\/g, "/"));
  const dot = base.lastIndexOf(".");
  const module = dot > 0 ? base.slice(0, dot) : base;

  const test_entries = self._find_test_files_for(proj, module);

  if (json_output) {
    const result_list: Array<Record<string, unknown>> = [];
    for (const [test_rel] of test_entries) {
      const fns = self._get_test_functions(proj.hash, test_rel);
      result_list.push({
        path: test_rel,
        test_count: fns.length,
        tests: fns,
      });
    }
    _echo(JSON.stringify({ impl: impl_rel, test_files: result_list }));
    return;
  }

  if (test_entries.length === 0) {
    _echo(
      `No test file found for ${impl_rel}.\n` +
        `Expected: tests/test_${module}.py or test_${module}.py`,
    );
    return;
  }

  for (const [test_rel] of test_entries) {
    const fns = self._get_test_functions(proj.hash, test_rel);
    const count = fns.length;
    if (count === 0) {
      _echo(`${test_rel} — 0 tests`);
      continue;
    }
    const noun = count === 1 ? "test" : "tests";
    let names_str: string;
    if (count <= _TEST_FOR_INLINE_CAP) {
      names_str = fns.join(", ");
    } else {
      names_str = fns.slice(0, _TEST_FOR_INLINE_CAP).join(", ") + ", …";
    }
    _echo(`${test_rel} — ${count} ${noun}: ${names_str}`);
  }
}

// ---------------------------------------------------------------------------
// types
// ---------------------------------------------------------------------------

const _TYPE_KIND_LABEL: Record<string, string> = {
  TypedDict: "TypedDict",
  Protocol: "Protocol",
  dataclass: "dataclass",
  namedtuple: "namedtuple",
  NamedTuple: "NamedTuple",
  pydantic: "pydantic",
};

const _TYPES_FIELDS_INLINE_CAP = 6;

/** List type definitions in a file or project. */
export function types(
  file_target: string | null = null,
  opts: { json_output?: boolean } = {},
): void {
  const json_output = opts.json_output ?? false;

  const proj = find_project(process.cwd());
  if (proj === null) {
    _echo("Not inside an indexed project.");
    throw new CliExit(1);
  }

  let file_rel: string | null = null;
  if (file_target !== null) {
    const ft = self._resolve_file_target(file_target);
    if (ft.rel_path === null) {
      _echo(`File not found in any indexed project: ${file_target}`);
      const hint = self._not_indexed_hint(proj.hash);
      if (hint) {
        _echo(hint);
      }
      throw new CliExit(1);
    }
    file_rel = ft.rel_path;
  }

  const type_defs = _get_type_definitions(proj.hash, file_rel);

  if (json_output) {
    const scope_label = file_rel ? file_rel : String(proj.root);
    _echo(JSON.stringify({ project: scope_label, types: type_defs }, _jsonSetReplacer));
    return;
  }

  if (type_defs.length === 0) {
    if (file_rel) {
      _echo(`No type definitions found in ${file_rel}.`);
    } else {
      _echo("No type definitions found in this project.");
    }
    return;
  }

  const scope_desc = file_rel ? file_rel : "project";
  _echo(`# Type definitions: ${scope_desc}  (${type_defs.length} found)\n`);

  let max_kind = 0;
  let max_name = 0;
  let max_loc = 0;
  for (const t of type_defs) {
    const kl = _TYPE_KIND_LABEL[String(t["type_kind"])] ?? String(t["type_kind"]);
    max_kind = Math.max(max_kind, _cpLen(kl));
    max_name = Math.max(max_name, _cpLen(String(t["name"])));
    max_loc = Math.max(max_loc, _cpLen(`${t["file"]}:${t["start_line"]}`));
  }

  for (const t of type_defs) {
    const kind_label = _TYPE_KIND_LABEL[String(t["type_kind"])] ?? String(t["type_kind"]);
    const name = String(t["name"]);
    const loc = `${t["file"]}:${t["start_line"]}`;
    const fields = (t["fields"] as string[]) ?? [];
    let fields_part: string;
    if (fields.length > 0) {
      let fields_str: string;
      if (fields.length <= _TYPES_FIELDS_INLINE_CAP) {
        fields_str = fields.join(", ");
      } else {
        fields_str = fields.slice(0, _TYPES_FIELDS_INLINE_CAP).join(", ") + ", …";
      }
      fields_part = `  fields: ${fields_str}`;
    } else {
      fields_part = "  (no annotated fields)";
    }
    _echo(`  ${_ljust(kind_label, max_kind)}  ${_ljust(name, max_name)}  ${_ljust(loc, max_loc)}${fields_part}`);
  }
}

/** JSON replacer that serialises a Set as an array (Python json default=list). */
function _jsonSetReplacer(_key: string, value: unknown): unknown {
  if (value instanceof Set) {
    return Array.from(value);
  }
  return value;
}

// ---------------------------------------------------------------------------
// grep
// ---------------------------------------------------------------------------

const _GREP_MAX_LINES = 200;
const _GREP_HEAD_LINES = 100;
const _GREP_TAIL_LINES = 20;

/** Compress *lines* to at most _GREP_MAX_LINES lines. */
export function _compress_grep_output(lines: string[]): string[] {
  const total = lines.length;
  if (total <= _GREP_MAX_LINES) {
    return lines;
  }
  const omitted = total - _GREP_HEAD_LINES - _GREP_TAIL_LINES;
  return [
    ...lines.slice(0, _GREP_HEAD_LINES),
    `... ${omitted} more lines ...`,
    ...lines.slice(total - _GREP_TAIL_LINES),
  ];
}

/** Return an 8-hex-char content hash for *output*. */
export function _grep_output_hash(output: string): string {
  return crypto.createHash("sha1").update(Buffer.from(output, "utf-8")).digest("hex").slice(0, 8);
}

/** Session-aware grep wrapper: run ``rg`` and cache result hashes. */
export function grep(
  pattern: string,
  opts: { path?: string; session_id?: string | null; json_output?: boolean } = {},
): void {
  const p = opts.path ?? ".";
  const session_id = opts.session_id ?? null;
  const json_output = opts.json_output ?? false;

  let cache: session.SessionCache | null = null;
  if (session_id) {
    cache = session.load(session_id);
  }

  let elapsed_seconds = 0;
  let seen_before = false;
  if (cache !== null && !cache.unavailable) {
    const norm_path = p || ".";
    for (let i = cache.greps.length - 1; i >= 0; i--) {
      const entry = cache.greps[i]!;
      const entry_path = entry.path || ".";
      if (entry.pattern === pattern && entry_path === norm_path) {
        elapsed_seconds = Math.max(0, Math.floor(Date.now() / 1000 - entry.ts));
        seen_before = true;
        break;
      }
    }
  }

  // Run rg.
  let raw_output: string;
  const proc = spawnSync("rg", [pattern, p], { encoding: "utf-8" });
  if (proc.error !== undefined && (proc.error as NodeJS.ErrnoException).code === "ENOENT") {
    const error_msg = "rg (ripgrep) not found — install ripgrep to use token-goat grep";
    if (json_output) {
      _echo(JSON.stringify({ ok: false, error: error_msg }));
    } else {
      _echo(error_msg, { err: true });
    }
    return;
  }
  raw_output = typeof proc.stdout === "string" ? proc.stdout : "";
  // rg exits 1 with no matches (treat as empty); 2 is an actual error.
  if (proc.status === 2) {
    const error_msg = (typeof proc.stderr === "string" ? proc.stderr : "").trim() || "rg returned exit code 2";
    if (json_output) {
      _echo(JSON.stringify({ ok: false, error: error_msg }));
    } else {
      _echo(`grep error: ${error_msg}`, { err: true });
    }
    return;
  }

  const output_lines = _splitlines(raw_output);
  const total_lines = output_lines.length;
  const result_hash = self._grep_output_hash(raw_output);

  let cache_hit = false;
  if (seen_before && cache !== null && !cache.unavailable) {
    const stored_pattern = cache.get_grep_result_pattern(result_hash);
    if (stored_pattern !== null) {
      cache_hit = true;
    }
  }

  const compressed_lines = self._compress_grep_output(output_lines);
  const compressed_output = compressed_lines.join("\n");

  if (json_output) {
    const payload: Record<string, unknown> = {
      ok: true,
      pattern,
      path: p,
      total_lines,
      lines_shown: compressed_lines.length,
      cache_hit,
      output: compressed_output,
    };
    if (cache_hit) {
      payload["cache_age_seconds"] = elapsed_seconds;
    }
    _echo(JSON.stringify(payload));
  } else {
    if (cache_hit) {
      _echo(
        `⚡ Cached grep result (session hit) — same results as ${elapsed_seconds} seconds ago`,
      );
    }
    _echo(compressed_output);
  }

  if (session_id) {
    const updated_cache = session.mark_grep(session_id, pattern, p !== "." ? p : null, total_lines);
    if (!updated_cache.unavailable) {
      updated_cache.record_grep_result_hash(result_hash, pattern);
      session.save(updated_cache);
    }
  }
}

// ---------------------------------------------------------------------------
// recent
// ---------------------------------------------------------------------------

/** Return up to *limit* (file_rel, commit_label) pairs from recent git history. */
export function _get_recent_git_files(project_hash: string, limit: number): Array<[string, string]> {
  let rows: Array<Record<string, unknown>>;
  try {
    rows = db.openProjectReadonly(project_hash, (conn) => {
      try {
        return conn
          .prepare(
            "SELECT commit_short, summary, author_ts, changed_files " +
              "FROM git_commits " +
              "ORDER BY author_ts DESC " +
              "LIMIT 50",
          )
          .all() as Array<Record<string, unknown>>;
      } catch (exc) {
        if (!_isOperationalError(exc)) throw exc;
        // Table not yet created (history never indexed).
        return [] as Array<Record<string, unknown>>;
      }
    });
  } catch (exc) {
    if (!_isOperationalError(exc)) throw exc;
    return [];
  }

  const seen = new Map<string, string>(); // file_rel -> label
  let commit_idx = 1;
  for (const row of rows) {
    if (seen.size >= limit) {
      break;
    }
    let files: string[];
    try {
      const parsed = JSON.parse(String(row["changed_files"] ?? "[]"));
      files = Array.isArray(parsed) ? (parsed as string[]) : [];
    } catch {
      files = [];
    }
    const label = `${commit_idx} commit${commit_idx > 1 ? "s" : ""} ago`;
    for (const f of files) {
      if (!seen.has(f)) {
        seen.set(f, label);
      }
    }
    commit_idx++;
  }

  return Array.from(seen.entries()).slice(0, limit);
}

const _RECENT_STRUCT_KINDS: ReadonlySet<string> = new Set([
  "function",
  "async_function",
  "method",
  "class",
  "interface",
  "struct",
  "trait",
  "enum",
  "type_alias",
]);

/** Return changed/accessed symbol names for *file_rel*. */
export function _symbols_for_file(
  project_hash: string,
  file_rel: string,
  session_cache: session.SessionCache | null,
): string[] {
  const symbols: string[] = [];

  if (session_cache !== null && !session_cache.unavailable) {
    const prefix = `${file_rel}::`;
    for (const key of Object.keys(session_cache.symbol_access_counts)) {
      if (key.startsWith(prefix)) {
        const sym_name = key.slice(prefix.length);
        if (sym_name && !symbols.includes(sym_name)) {
          symbols.push(sym_name);
        }
      }
    }
  }

  if (symbols.length > 0) {
    return symbols;
  }

  try {
    return db.openProjectReadonly(project_hash, (conn) => {
      const placeholders = Array.from(_RECENT_STRUCT_KINDS).map(() => "?").join(",");
      const rows = conn
        .prepare(
          `SELECT DISTINCT name FROM symbols ` +
            `WHERE file_rel = ? AND kind IN (${placeholders}) ` +
            `ORDER BY line LIMIT 10`,
        )
        .all(file_rel, ...Array.from(_RECENT_STRUCT_KINDS)) as Array<Record<string, unknown>>;
      return rows.map((r) => String(r["name"]));
    });
  } catch {
    return [];
  }
}

/** Show the N most recently edited/accessed files from this session and git. */
export function recent(
  opts: { n?: number; session_id?: string | null; json_output?: boolean } = {},
): void {
  const n = opts.n ?? 10;
  const session_id = opts.session_id ?? null;
  const json_output = opts.json_output ?? false;

  const cwd = process.cwd();
  const proj = find_project(cwd);

  let sess: session.SessionCache | null = null;
  if (session_id) {
    sess = session.load(session_id);
    if (sess !== null && sess.unavailable) {
      sess = null;
    }
  }

  // Source 1: session edited files.
  const session_entries: Array<[string, string]> = [];
  if (sess !== null) {
    for (const raw_path of Object.keys(sess.edited_files)) {
      let rel: string;
      if (proj !== null) {
        rel = _relativeToOr(raw_path, proj.root, raw_path);
      } else {
        rel = raw_path;
      }
      session_entries.push([rel, "edited this session"]);
    }
  }

  // Source 2: session read files (not edited).
  const edited_paths_normalized = new Set<string>();
  if (sess !== null) {
    for (const raw_path of Object.keys(sess.edited_files)) {
      edited_paths_normalized.add(_asPosix(raw_path).toLowerCase());
    }
  }

  const session_read_entries: Array<[string, string, number]> = [];
  if (sess !== null) {
    for (const file_entry of Object.values(sess.files)) {
      const raw_path = file_entry.rel_or_abs;
      if (edited_paths_normalized.has(_asPosix(raw_path).toLowerCase())) {
        continue;
      }
      let rel: string;
      if (proj !== null) {
        rel = _relativeToOr(raw_path, proj.root, raw_path);
      } else {
        rel = raw_path;
      }
      session_read_entries.push([rel, "read this session", file_entry.last_read_ts]);
    }
  }

  // Sort by most-recently read first (stable, descending ts).
  session_read_entries.sort((a, b) => b[2] - a[2]);

  // Source 3: recent git commits.
  let git_entries: Array<[string, string]> = [];
  if (proj !== null) {
    git_entries = self._get_recent_git_files(proj.hash, n * 2);
  }

  // Merge.
  const seen = new Set<string>();
  const merged: Array<[string, string]> = [];

  for (const [rel, label] of session_entries) {
    if (!seen.has(rel)) {
      seen.add(rel);
      merged.push([rel, label]);
    }
    if (merged.length >= n) {
      break;
    }
  }

  for (const [rel, label] of session_read_entries) {
    if (!seen.has(rel) && merged.length < n) {
      seen.add(rel);
      merged.push([rel, label]);
    }
  }

  for (const [rel, label] of git_entries) {
    if (!seen.has(rel) && merged.length < n) {
      seen.add(rel);
      merged.push([rel, label]);
    }
  }

  const project_hash = proj !== null ? proj.hash : "";
  const results: Array<Record<string, unknown>> = [];
  for (const [file_rel, source_label] of merged) {
    const syms = project_hash ? self._symbols_for_file(project_hash, file_rel, sess) : [];
    results.push({
      path: file_rel,
      source: source_label,
      symbols: syms,
    });
  }

  if (json_output) {
    _echo(JSON.stringify({ files: results }));
    return;
  }

  if (results.length === 0) {
    _echo("No recently edited or committed files found.");
    return;
  }

  for (const entry of results) {
    const path_str = String(entry["path"]);
    const label = String(entry["source"]);
    _echo(`${path_str}  (${label})`);
    const syms = entry["symbols"] as string[];
    if (syms.length > 0) {
      _echo(`  ${syms.join(", ")}`);
    }
  }
}

/** Path.as_posix(): backslashes -> forward slashes (no normalisation). */
function _asPosix(p: string): string {
  return p.replace(/\\/g, "/");
}

/**
 * Python ``Path(raw).relative_to(root).as_posix()`` with a fallback on
 * ValueError (raw not under root). Mirrors the indexer's POSIX path storage.
 */
function _relativeToOr(raw: string, root: string, fallback: string): string {
  const rel = path.relative(root, raw);
  if (rel === "" || rel.startsWith("..") || path.isAbsolute(rel)) {
    return fallback;
  }
  return rel.split(path.sep).join("/");
}

// ---------------------------------------------------------------------------
// find
// ---------------------------------------------------------------------------

/** Unified search: symbol (exact/fuzzy) + semantic search, merged. */
export function find(query: string, opts: { json_output?: boolean } = {}): void {
  const json_output = opts.json_output ?? false;

  const cwd = process.cwd();
  const proj = find_project(cwd);
  if (proj === null) {
    _echo("Not inside an indexed project.  Run `token-goat index` first.");
    return;
  }

  const _SECTION_LIMIT = 5;

  // Branch 1 — symbol (exact + fuzzy) search.
  const sym_sql = "SELECT name, kind, file_rel, line, signature FROM symbols WHERE name = ? LIMIT ?";

  let exact_rows: Array<Record<string, unknown>> = [];
  let fuzzy_rows: Array<Record<string, unknown>> = [];
  try {
    db.openProject(proj.hash, (conn) => {
      exact_rows = conn.prepare(sym_sql).all(query, _SECTION_LIMIT * 2) as Array<
        Record<string, unknown>
      >;

      if (exact_rows.length < _SECTION_LIMIT) {
        const like_sql =
          "SELECT name, kind, file_rel, line, signature " +
          "FROM symbols WHERE name LIKE ? AND name != ? LIMIT ?";
        const like_param = `%${query}%`;
        const fuzzy_rows_raw = conn.prepare(like_sql).all(like_param, query, _SECTION_LIMIT * 2) as Array<
          Record<string, unknown>
        >;
        fuzzy_rows = fuzzy_rows_raw.map((r) => ({
          file: r["file_rel"],
          line: r["line"],
          kind: r["kind"],
          name: r["name"],
          signature: r["signature"],
        }));
      }
    });
  } catch (exc) {
    if (!(exc instanceof db.DBError)) throw exc;
  }

  // Combine: exact first, then fuzzy, deduplicate by (file_rel, name), limit 5.
  let sym_results: Array<Record<string, unknown>> = [];
  const seen_sym = new Set<string>();
  for (const r of exact_rows) {
    const key = `${r["file_rel"]}\u0000${r["name"]}`;
    if (!seen_sym.has(key)) {
      seen_sym.add(key);
      sym_results.push({
        file: r["file_rel"],
        line: r["line"],
        kind: r["kind"],
        name: r["name"],
        signature: r["signature"],
      });
    }
  }
  for (const rd of fuzzy_rows) {
    const key = `${rd["file"]}\u0000${rd["name"]}`;
    if (!seen_sym.has(key) && sym_results.length < _SECTION_LIMIT) {
      seen_sym.add(key);
      sym_results.push(rd);
    }
  }

  sym_results = sym_results.slice(0, _SECTION_LIMIT);

  // Branch 2 — semantic search.
  const sem_results: Array<Record<string, unknown>> = [];
  try {
    const hits = embeddings.semantic_search(proj, query, {
      k: _SECTION_LIMIT * 2,
      max_distance: embeddings.DEFAULT_DISTANCE_THRESHOLD,
    });
    const sym_locations = new Set<string>();
    for (const r of sym_results) {
      sym_locations.add(`${r["file"]}\u0000${r["line"]}`);
    }
    for (const h of hits) {
      if (sem_results.length >= _SECTION_LIMIT) {
        break;
      }
      if (sym_locations.has(`${h.file_rel}\u0000${h.start_line}`)) {
        continue;
      }
      sem_results.push({
        file: h.file_rel,
        start: h.start_line,
        end: h.end_line,
        kind: h.kind,
        distance: h.distance,
        preview: _cpSlice(h.text, 200),
      });
    }
  } catch {
    // Embeddings not available — semantic section stays empty.
  }

  if (json_output) {
    _echo(
      JSON.stringify({
        query,
        symbol_matches: sym_results,
        semantic_matches: sem_results,
      }),
    );
    return;
  }

  if (sym_results.length > 0) {
    _echo("Exact/fuzzy matches:");
    for (const r of sym_results) {
      const sig = r["signature"] ? `  ${r["signature"]}` : "";
      _echo(`  ${r["file"]}:${r["line"]}: ${r["kind"]} ${r["name"]}${sig}`);
    }
  } else {
    _echo("Exact/fuzzy matches: (none)");
  }

  if (sem_results.length > 0) {
    _echo("Semantic matches:");
    for (const r of sem_results) {
      const snippet = _cpSlice(String(r["preview"] ?? "").replace(/\n/g, " "), 100);
      _echo(`  ${r["file"]}:${r["start"]}  ${snippet}`);
    }
  } else {
    _echo("Semantic matches: (none)");
  }
}

// ---------------------------------------------------------------------------
// similar
// ---------------------------------------------------------------------------

/** Find the top-k symbols most semantically similar to ``file::symbol``. */
export function similar(
  target: string,
  opts: { json_output?: boolean; top_k?: number } = {},
): void {
  const json_output = opts.json_output ?? false;
  const top_k = opts.top_k ?? 5;

  if (!target.includes("::")) {
    _echo(
      "Error: target must be in 'file::symbol' format, " +
        `e.g. 'src/auth.py::login'. Got: ${_pyRepr(target)}`,
      { err: true },
    );
    throw new CliExit(1);
  }

  const sepIdx = target.indexOf("::");
  const file_part = _pyStrip(target.slice(0, sepIdx));
  const symbol_part = _pyStrip(target.slice(sepIdx + 2));

  if (!file_part || !symbol_part) {
    _echo("Error: both file and symbol must be non-empty in 'file::symbol'.", { err: true });
    throw new CliExit(1);
  }

  const cwd = process.cwd();
  const proj = find_project(cwd);
  if (proj === null) {
    _echo("Not inside an indexed project.  Run `token-goat index` first.");
    return;
  }

  // Normalise file path to project-relative form.
  let rel_path: string;
  if (path.isAbsolute(file_part)) {
    const rel = path.relative(proj.root, file_part);
    if (rel === "" || rel.startsWith("..") || path.isAbsolute(rel)) {
      rel_path = file_part;
    } else {
      rel_path = rel;
    }
  } else {
    rel_path = file_part;
  }
  rel_path = rel_path.replace(/\\/g, "/");

  let symbol_found = false;
  try {
    db.openProject(proj.hash, (conn) => {
      const row = conn
        .prepare("SELECT 1 FROM symbols WHERE file_rel = ? AND name = ? LIMIT 1")
        .get(rel_path, symbol_part);
      symbol_found = row !== undefined;
    });
  } catch (exc) {
    if (!(exc instanceof db.DBError)) throw exc;
  }

  if (!symbol_found) {
    const msg =
      `Symbol ${_pyRepr(symbol_part)} not found in ${_pyRepr(rel_path)}. ` +
      "Run `token-goat index` to (re-)index the project.";
    if (json_output) {
      _echo(JSON.stringify({ error: msg, results: [] }));
    } else {
      _echo(msg);
    }
    return;
  }

  const hits = embeddings.find_similar_symbols(proj.hash, rel_path, symbol_part, top_k);

  if (json_output) {
    _echo(
      JSON.stringify({
        query: target,
        results: hits.map((h) => ({
          file: h.file,
          name: h.name,
          kind: h.kind,
          similarity_score: _pyRound(h.similarity_score, 4),
        })),
      }),
    );
    return;
  }

  if (hits.length === 0) {
    _echo(
      `No similar symbols found for ${_pyRepr(target)}. ` +
        "Run `token-goat index --embeddings` to build the embedding index.",
    );
    return;
  }

  for (const h of hits) {
    const pct = Math.trunc(_pyRound(h.similarity_score * 100, 0));
    _echo(`${h.file} — ${h.name} (${h.kind}) — ${pct}% similar`);
  }
}

/** Python round() — banker's rounding (round-half-to-even) to *ndigits*. */
function _pyRound(value: number, ndigits: number): number {
  const factor = Math.pow(10, ndigits);
  const scaled = value * factor;
  const floor = Math.floor(scaled);
  const diff = scaled - floor;
  let rounded: number;
  if (diff < 0.5) {
    rounded = floor;
  } else if (diff > 0.5) {
    rounded = floor + 1;
  } else {
    // exactly .5 — round to even
    rounded = floor % 2 === 0 ? floor : floor + 1;
  }
  return rounded / factor;
}
