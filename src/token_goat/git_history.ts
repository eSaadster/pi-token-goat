/**
 * Git history indexing and hint generation for pre-read context.
 *
 * Faithful port of src/token_goat/git_history.py to TypeScript.
 *
 * Indexes recent commit messages and their changed-file lists into the
 * per-project SQLite DB, then surfaces the most-relevant commits as a compact
 * hint when the agent reads a file that was recently changed.
 *
 * Design decisions (verbatim from the Python original)
 * ====================================================
 *  - Shallow index — 200 most-recent commits only.
 *  - Fail-soft — every public function catches and returns an empty result
 *    rather than propagating. Git may be absent, the repo may be shallow, or
 *    the project root may not be a git repo; none should interrupt a hook.
 *  - Async-safe — indexing is triggered from session-start in a background
 *    daemon thread and never blocks the hook response. (Node has no such
 *    thread here; the function is sync and safe to call from a worker.)
 *  - Deduplication — commits are keyed by the first 12 chars of their hash;
 *    re-indexing is idempotent (INSERT OR IGNORE).
 *  - Staleness guard — git_history_meta records the last index timestamp so
 *    re-indexing is skipped for _REINDEX_STALENESS_SECS after the last run.
 *
 * Parity notes (Python -> TS)
 * ===========================
 *  - sqlite3.Connection -> the better-sqlite3 Database (DatabaseType). The
 *    Python source used conn.execute(sql, params).fetchone()/.fetchall()/
 *    .rowcount, conn.executescript(...), and conn.commit(). better-sqlite3 has
 *    no execute/fetchone/rowcount; the SQL strings and parameters are preserved
 *    byte-for-byte but routed through prepare()/run()/get()/all()/exec(). The
 *    cursor.rowcount used for dedup detection maps to RunResult.changes.
 *  - time.time() (seconds, float) -> Date.now() / 1000 (seconds, float). Both
 *    are wall-clock Unix seconds.
 *  - json.dumps(list[str]) -> JSON.stringify(list). Python's default separators
 *    on a list of strings produce ["a", "b"] (with a space after the comma);
 *    JSON.stringify produces ["a","b"] (no space). The DB stores the array and
 *    SQLite's json_each parses BOTH forms identically, so the stored value is
 *    semantically equal and every query/test below is unaffected. (No test
 *    asserts on the raw stored JSON text.)
 *  - db.open_project / db.open_project_readonly were Python context managers;
 *    the TS twins are callback-style HOFs (openProject(hash, (conn)=>...)). The
 *    bodies below pass a callback exactly as db.ts expects.
 *  - re.compile(...) -> top-level RegExp literals compiled once at module load.
 *  - datetime.fromtimestamp(ts, tz=UTC).strftime("%Y-%m-%d") -> a Date built
 *    from ts*1000 with the UTC getters formatted as YYYY-MM-DD.
 *
 * verbatimModuleSyntax is on -> all type-only imports use `import type`.
 * exactOptionalPropertyTypes is on -> optional fields are `T | undefined`.
 * noUncheckedIndexedAccess is on -> every indexed access is narrowed.
 */

import fs from "node:fs";

import type { Database as DatabaseType } from "better-sqlite3";

import { getLogger } from "./util.js";
import { runGit as _utilRunGit } from "./util.js";

// Sibling modules used inside the inner functions. Imported as namespaces so a
// test can spy on them via vi.spyOn(...), exactly as the Python source did its
// lazy `from . import db` inside the function body.
import * as db from "./db.js";
import * as paths from "./paths.js";
import * as project from "./project.js";

// Self-namespace import. The Python tests patch git_history._run_git and
// git_history._parse_log; under native ESM a bare internal call to those
// functions is NOT interceptable by vi.spyOn on the module namespace, so the
// call sites a test patches route through `self.` (the same pattern bridges.ts
// uses for its internal-fn spies). Verbatim semantics — `self.fn(...)` is the
// identical call, just dispatched through the live module binding.
import * as self from "./git_history.js";

/**
 * Public symbol surface, mirroring Python's `git_history.__all__`. Kept as a
 * runtime array using the Python snake_case names so any test that greps the
 * surface ports one-for-one.
 */
export const __all__ = [
  "index_project_history",
  "find_commits_for_file",
  "build_hint",
  "get_changed_symbols",
  "get_changed_symbols_db",
  "blame_symbol",
] as const;

const _LOG = getLogger("git_history");

// Number of recent commits to index.
export const _HISTORY_DEPTH: number = 200;

// Maximum file-change records per commit stored in changed_files JSON.
export const _MAX_FILES_PER_COMMIT: number = 40;

// How many related commits to surface in a hint.
export const _MAX_HINT_COMMITS: number = 3;

// Maximum age of commits to include in the index.
export const _MAX_COMMIT_AGE_DAYS: number = 60;

// Minimum commit summary length to index. Single-word commits ("wip", "fix")
// carry no useful signal.
export const _MIN_SUMMARY_LEN: number = 6;

// Minimum elapsed seconds before re-indexing an already-indexed project.
// Tracks wall-clock time since the last successful index run (stored in
// git_history_meta), NOT the age of commits in the repo.
export const _REINDEX_STALENESS_SECS: number = 3_600; // 1 hour

/**
 * Shape of a parsed commit record. Field names match the Python dict keys
 * exactly so callers and tests port one-for-one. `author_ts` is typed `unknown`
 * because the Python source stored an int but a regression test injects a
 * non-bindable object() to force every INSERT to raise; the TS twin must accept
 * that same poison value, so the field is intentionally widened.
 */
export interface ParsedCommit {
  commit_short: string;
  summary: string;
  author_ts: unknown;
  changed_files: string[];
}

/** A commit row returned by find_commits_for_file. */
export interface CommitRow {
  commit_short: string;
  summary: string;
  author_ts: number;
}

/**
 * Run a git command and return stdout, or null on any failure.
 *
 * Delegates to util.runGit for consistent kwargs (encoding, errors, lock
 * avoidance). Mirrors the Python `_run_git(args, cwd, timeout=10)` signature;
 * `cwd` is a string here (Python passed a Path then str()-ed it).
 */
export function _run_git(
  args: string[],
  cwd: string,
  timeout: number = 10,
): string | null {
  try {
    const result = _utilRunGit(args, { cwd, timeout });
    if (result.returncode !== 0) {
      _LOG.debug(
        `git ${args[0]} exited ${result.returncode}: ${result.stderr.slice(0, 200)}`,
      );
      return null;
    }
    return result.stdout;
  } catch (exc) {
    _LOG.debug(`git ${args[0]} failed: ${String(exc)}`);
    return null;
  }
}

/**
 * Parse `git log --format=%x00%H%x01%s%x01%at --name-only` output.
 *
 * The null-byte separator between commits avoids ambiguity with newlines in
 * commit messages. Each record is a ParsedCommit.
 */
export function _parse_log(raw: string): ParsedCommit[] {
  const commits: ParsedCommit[] = [];
  for (let block of raw.split("\x00")) {
    block = block.trim();
    if (!block) {
      continue;
    }
    // header, _, rest = block.partition("\n")
    const nlIdx = block.indexOf("\n");
    const header = nlIdx === -1 ? block : block.slice(0, nlIdx);
    const rest = nlIdx === -1 ? "" : block.slice(nlIdx + 1);
    const parts = header.split("\x01");
    if (parts.length < 3) {
      continue;
    }
    const full_hash = parts[0]!;
    const summary = parts[1]!;
    const ts_str = parts[2]!;
    let ts: number;
    // Python: int(ts_str.strip()); ValueError -> 0. parseInt is too lenient
    // (it stops at the first non-digit) so use the same strict integer test the
    // util.envInt helper uses: optional sign + ASCII digits only.
    const tsTrimmed = ts_str.trim();
    if (/^[+-]?\d+$/.test(tsTrimmed)) {
      ts = Number(tsTrimmed);
    } else {
      ts = 0;
    }
    if (!summary || summary.length < _MIN_SUMMARY_LEN) {
      continue;
    }
    // changed = [ln.strip() for ln in rest.splitlines()
    //            if ln.strip() and not ln.startswith(" ")][:_MAX_FILES_PER_COMMIT]
    const changed: string[] = [];
    for (const ln of _splitlines(rest)) {
      const stripped = ln.trim();
      if (stripped && !ln.startsWith(" ")) {
        changed.push(stripped);
        if (changed.length >= _MAX_FILES_PER_COMMIT) {
          break;
        }
      }
    }
    commits.push({
      commit_short: full_hash.slice(0, 12),
      summary: summary.slice(0, 200),
      author_ts: ts,
      changed_files: changed,
    });
  }
  return commits;
}

/**
 * Split `text` on line boundaries the way Python's str.splitlines() does: on
 * \n, \r, and \r\n, WITHOUT a trailing empty element for a final newline. We
 * only need the LF / CRLF / CR cases git emits.
 */
function _splitlines(text: string): string[] {
  if (text === "") {
    return [];
  }
  // Normalise CRLF and CR to LF, then split. Drop a single trailing empty
  // element so "a\nb\n".splitlines() == ["a", "b"] (matching Python).
  const normalised = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const out = normalised.split("\n");
  if (out.length > 0 && out[out.length - 1] === "") {
    out.pop();
  }
  return out;
}

/** Create git history tables if they don't exist. */
export function _ensure_schema(conn: DatabaseType): void {
  conn.exec(`
        CREATE TABLE IF NOT EXISTS git_commits (
            commit_short  TEXT PRIMARY KEY,
            summary       TEXT NOT NULL,
            author_ts     INTEGER NOT NULL,
            changed_files TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS git_commits_ts ON git_commits(author_ts DESC);

        CREATE TABLE IF NOT EXISTS git_history_meta (
            key   TEXT PRIMARY KEY,
            value TEXT NOT NULL
        );
    `);
  // conn.commit() — better-sqlite3 exec() commits implicitly (autocommit).
}

/**
 * Return True when the git history index is stale or absent.
 *
 * Staleness is measured against the last index write time stored in
 * git_history_meta — not the age of the newest commit.
 */
export function _needs_reindex(conn: DatabaseType): boolean {
  try {
    const row = conn
      .prepare(
        "SELECT value FROM git_history_meta WHERE key = 'last_indexed_at'",
      )
      .get() as { value: string } | undefined;
    if (row === undefined) {
      return true;
    }
    const age = _now() - Number(row.value);
    return age > _REINDEX_STALENESS_SECS;
  } catch {
    return true;
  }
}

/**
 * Index recent git history for `project_root` into the per-project DB.
 *
 * Returns the number of commits indexed (0 on any failure or skip). Safe to
 * call from a background context.
 */
export function index_project_history(
  project_root: string,
  project_hash: string,
): number {
  try {
    return _index_history_inner(project_root, project_hash);
  } catch {
    _LOG.debug("git_history: index_project_history failed");
    return 0;
  }
}

function _index_history_inner(
  project_root: string,
  project_hash: string,
): number {
  const db_path = paths.projectDbPath(project_hash);
  // Python: if not db_path.exists()
  if (!_pathExists(db_path)) {
    _LOG.debug(`git_history: project DB not found, skipping: ${db_path}`);
    return 0;
  }

  const fresh = db.openProject(project_hash, (conn) => {
    _ensure_schema(conn);
    return !_needs_reindex(conn);
  });
  if (fresh) {
    _LOG.debug("git_history: index is fresh, skipping reindex");
    return 0;
  }

  const raw = self._run_git(
    [
      "log",
      `--max-count=${_HISTORY_DEPTH}`,
      `--after=${_MAX_COMMIT_AGE_DAYS} days ago`,
      "--no-merges",
      "--format=%x00%H%x01%s%x01%at",
      "--name-only",
      "--diff-filter=d", // skip deleted-only commits
    ],
    project_root,
  );
  if (!raw) {
    _LOG.debug(`git_history: git log returned nothing for ${project_root}`);
    return 0;
  }

  const commits = self._parse_log(raw);
  if (commits.length === 0) {
    return 0;
  }

  const stored = db.openProject(project_hash, (conn) => {
    _ensure_schema(conn);
    let storedInner = 0;
    // Wrap the whole batch in one transaction: connections open in autocommit
    // mode, so without an explicit BEGIN each INSERT commits on its own —
    // re-acquiring the writer lock and fsyncing once per row instead of once
    // per batch.
    let in_txn = false;
    try {
      conn.exec("BEGIN");
      in_txn = true;
    } catch (exc) {
      _LOG.debug(`git_history: BEGIN skipped (${String(exc)}); using autocommit`);
    }
    let n_errors = 0;
    try {
      for (const commit of commits) {
        try {
          const res = conn
            .prepare(
              "INSERT OR IGNORE INTO git_commits" +
                "(commit_short, summary, author_ts, changed_files) " +
                "VALUES (?, ?, ?, ?)",
            )
            .run(
              commit.commit_short,
              commit.summary,
              // author_ts is `unknown` (a regression test injects a poison
              // object()). better-sqlite3's run() rejects a non-bindable value
              // with a TypeError, exactly as Python's sqlite3 raised — so the
              // surrounding try/catch fires identically and stored stays 0.
              commit.author_ts as never,
              JSON.stringify(commit.changed_files),
            );
          // cur.rowcount -> RunResult.changes (1 for new insert, 0 for ignored
          // duplicate).
          storedInner += res.changes;
        } catch (exc) {
          n_errors += 1;
          _LOG.debug(
            `git_history: failed to store commit ${commit.commit_short}: ${String(exc)}`,
          );
        }
      }
      // Stamp last_indexed_at when the index is up-to-date: either new commits
      // were stored, or all commits were already present (all-duplicates =
      // already fresh). Only skip the timestamp when every insert failed with
      // an exception (wholly-failed batch) so the next cycle retries instead of
      // being suppressed for _REINDEX_STALENESS_SECS.
      if (storedInner > 0 || n_errors < commits.length) {
        conn
          .prepare(
            "INSERT OR REPLACE INTO git_history_meta(key, value) " +
              "VALUES ('last_indexed_at', ?)",
          )
          .run(String(_now()));
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
    return storedInner;
  });

  _LOG.info(
    `git_history: indexed ${stored} commits for project=${project_hash.slice(0, 8)}`,
  );
  return stored;
}

/**
 * Return recent commits that touched `rel_path`, ordered by recency.
 *
 * Falls back to an empty list on any failure, including when the index has not
 * been built yet (a missing project DB raises, mirroring Python's
 * FileNotFoundError branch).
 */
export function find_commits_for_file(
  project_hash: string,
  rel_path: string,
  opts: { limit?: number | undefined } = {},
): CommitRow[] {
  const limit = opts.limit ?? _MAX_HINT_COMMITS;
  try {
    return _find_commits_inner(project_hash, rel_path, limit);
  } catch (err) {
    // db.openProjectReadonly throws a plain Error whose message contains
    // "project db not found" when the per-project DB is absent — the TS twin of
    // Python's FileNotFoundError. Swallow that case silently.
    if (_isProjectDbNotFound(err)) {
      return [];
    }
    _LOG.debug("git_history: find_commits_for_file failed");
    return [];
  }
}

function _find_commits_inner(
  project_hash: string,
  rel_path: string,
  limit: number,
): CommitRow[] {
  const rows = db.openProjectReadonly(project_hash, (conn) => {
    try {
      // json_each provides exact element matching — avoids the false positives
      // that LIKE-based substring search produces when one path is a suffix of
      // another (e.g. "foo.py" inside "bar/foo.py").
      return conn
        .prepare(
          `
                SELECT DISTINCT c.commit_short, c.summary, c.author_ts
                FROM   git_commits c, json_each(c.changed_files) AS f
                WHERE  f.value = ?
                ORDER  BY c.author_ts DESC
                LIMIT  ?
                `,
        )
        .raw()
        .all(rel_path, limit) as Array<[string, string, number]>;
    } catch {
      return [] as Array<[string, string, number]>;
    }
  });

  return rows.map((row) => ({
    commit_short: row[0],
    summary: row[1],
    author_ts: row[2],
  }));
}

/**
 * Build a compact git-history hint for `rel_path`.
 *
 * Returns null when there are no relevant commits or the index is absent. The
 * hint is short (<80 tokens) and structured for easy scanning.
 */
export function build_hint(
  project_hash: string,
  rel_path: string,
): string | null {
  const commits = find_commits_for_file(project_hash, rel_path, {
    limit: _MAX_HINT_COMMITS,
  });
  if (commits.length === 0) {
    return null;
  }

  const now = _now();
  const lines: string[] = [`git: ${rel_path}`];
  for (const c of commits) {
    // int((now - float(str(c["author_ts"]))) / 86_400)
    const age_days = Math.trunc((now - Number(String(c.author_ts))) / 86_400);
    const age_str = age_days > 0 ? `${age_days}d` : "today";
    const summary = String(c.summary).slice(0, 72);
    const short = String(c.commit_short).slice(0, 8);
    lines.push(`  ${short} ${summary} (${age_str})`);
  }
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Changed symbols — diff-based symbol extraction
// ---------------------------------------------------------------------------

// Regex matching a unified-diff hunk header line:
//   @@ -old_start[,old_count] +new_start[,new_count] @@ [optional context]
const _HUNK_RE = /^@@ -\d+(?:,(\d+))? \+\d+(?:,(\d+))? @@ ?(.*)$/;

// Extended regex that also captures the new-file start line and count.
// Groups: (new_start, new_count_or_none, context)
const _HUNK_RANGE_RE = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@ ?(.*)$/;

// Regex matching a +++ b/<file> line (new-file side of a diff header).
const _FILE_RE = /^\+\+\+ b\/(.+)$/;

// Leading language keywords to strip when extracting a bare symbol name.
const _SYMBOL_STRIP_PREFIXES = [
  "async def ",
  "def ",
  "func ",
  "function ",
  "class ",
  "fn ",
  "pub fn ",
  "pub async fn ",
] as const;

/**
 * Extract a bare symbol name from the hunk context text (after the fourth @@).
 *
 * Returns null when the context is empty or produces only noise.
 */
export function _parse_symbol_from_hunk_context(context: string): string | null {
  const raw = context.trim();
  if (!raw) {
    return null;
  }
  // Drop parameter list and brace noise: "def foo(a, b):" -> "def foo"
  let name_part = raw.split("(")[0]!.split("{")[0]!.trim();
  // Strip leading language keywords.
  for (const kw of _SYMBOL_STRIP_PREFIXES) {
    if (name_part.startsWith(kw)) {
      name_part = name_part.slice(kw.length);
      break;
    }
  }
  // Strip trailing colon (Python class/def) and surrounding whitespace.
  name_part = _rstripColon(name_part.trim());
  return name_part ? name_part : null;
}

/** Python str.rstrip(":") — strip every trailing ":" character. */
function _rstripColon(s: string): string {
  let end = s.length;
  while (end > 0 && s.charAt(end - 1) === ":") {
    end -= 1;
  }
  return s.slice(0, end);
}

/** A (file, symbol) changed-symbol record (diff-context based). */
export interface ChangedSymbol {
  file: string;
  symbol: string;
  lines_added: number;
  lines_removed: number;
}

/**
 * Return symbols that changed between `since_ref` and HEAD.
 *
 * Runs `git diff --unified=0 <since_ref>..HEAD -- "*.py"` and parses each hunk
 * header for the optional context text (the name git infers for the
 * surrounding function or class).
 *
 * Fail-soft: returns [] on git error, missing repo, invalid ref, or any other
 * exception. Never raises.
 */
export function get_changed_symbols(
  repo_root: string,
  since_ref: string = "HEAD~5",
  limit: number = 50,
): ChangedSymbol[] {
  try {
    return _get_changed_symbols_inner(String(repo_root), since_ref, limit);
  } catch {
    _LOG.debug("get_changed_symbols failed");
    return [];
  }
}

function _get_changed_symbols_inner(
  repo_root: string,
  since_ref: string,
  limit: number,
): ChangedSymbol[] {
  const raw = _run_git(
    ["diff", "--unified=0", `${since_ref}..HEAD`, "--", "*.py"],
    repo_root,
    30,
  );
  if (!raw) {
    return [];
  }

  // Accumulate counts per (file, symbol) — preserve insertion order via a
  // separate key list for stable output. The Map key is a "file\x00symbol"
  // join since JS Maps can't key on a tuple by value.
  const counts = new Map<string, { lines_added: number; lines_removed: number }>();
  const key_order: Array<[string, string]> = [];

  let current_file: string | null = null;

  for (const line of _splitlines(raw)) {
    const m_file = _FILE_RE.exec(line);
    if (m_file) {
      current_file = m_file[1]!;
      continue;
    }
    if (current_file === null) {
      continue;
    }
    const m_hunk = _HUNK_RE.exec(line);
    if (!m_hunk) {
      continue;
    }
    const removed_str = m_hunk[1];
    const added_str = m_hunk[2];
    const context = m_hunk[3]!;
    // group(1) is undefined when the count is absent (meaning 1 line).
    const lines_removed = removed_str !== undefined ? Number(removed_str) : 1;
    const lines_added = added_str !== undefined ? Number(added_str) : 1;
    const symbol = _parse_symbol_from_hunk_context(context);
    if (!symbol) {
      continue;
    }
    const mapKey = `${current_file}\x00${symbol}`;
    let entry = counts.get(mapKey);
    if (entry === undefined) {
      entry = { lines_added: 0, lines_removed: 0 };
      counts.set(mapKey, entry);
      key_order.push([current_file, symbol]);
    }
    entry.lines_added += lines_added;
    entry.lines_removed += lines_removed;
  }

  const result: ChangedSymbol[] = [];
  for (const [file_path, symbol] of key_order) {
    if (result.length >= limit) {
      break;
    }
    const entry = counts.get(`${file_path}\x00${symbol}`)!;
    result.push({
      file: file_path,
      symbol,
      lines_added: entry.lines_added,
      lines_removed: entry.lines_removed,
    });
  }

  // Sort by file then symbol for stable, scannable output.
  result.sort((a, b) => {
    const fa = String(a.file);
    const fb = String(b.file);
    if (fa < fb) return -1;
    if (fa > fb) return 1;
    const sa = String(a.symbol);
    const sb = String(b.symbol);
    if (sa < sb) return -1;
    if (sa > sb) return 1;
    return 0;
  });
  return result;
}

/** A per-file changed-symbol record (DB-index based). */
export interface ChangedSymbolDb {
  file: string;
  symbols: string[];
  symbol_count: number;
}

/**
 * Return symbols changed between `since_ref` and HEAD, resolved via the DB
 * index.
 *
 * Unlike get_changed_symbols (which relies on git's hunk-context text), this
 * queries the tree-sitter symbol index for symbols whose line ranges overlap
 * each changed hunk.
 *
 * Fail-soft: returns [] on any error. Never raises.
 */
export function get_changed_symbols_db(
  repo_root: string,
  since_ref: string = "HEAD~1",
  limit: number = 50,
): ChangedSymbolDb[] {
  try {
    return _get_changed_symbols_db_inner(String(repo_root), since_ref, limit);
  } catch {
    _LOG.debug("get_changed_symbols_db failed");
    return [];
  }
}

function _get_changed_symbols_db_inner(
  repo_root: string,
  since_ref: string,
  limit: number,
): ChangedSymbolDb[] {
  const raw = _run_git(
    ["diff", "--unified=0", `${since_ref}..HEAD`],
    repo_root,
    30,
  );
  if (!raw) {
    return [];
  }

  // Parse hunk headers to build: file -> list of (new_start, new_end) line
  // ranges. new_end is inclusive; a hunk with count 0 means a pure deletion (no
  // new lines), so we still record the insertion point as a 1-line range.
  const file_ranges = new Map<string, Array<[number, number]>>();
  let current_file: string | null = null;

  for (const line of _splitlines(raw)) {
    const m_file = _FILE_RE.exec(line);
    if (m_file) {
      current_file = m_file[1]!;
      continue;
    }
    if (current_file === null) {
      continue;
    }
    const m_hunk = _HUNK_RANGE_RE.exec(line);
    if (!m_hunk) {
      continue;
    }
    const new_start = Number(m_hunk[1]!);
    const new_count_str = m_hunk[2];
    // When count is absent, git means "1 line"; count "0" means pure deletion.
    const new_count = new_count_str === undefined ? 1 : Number(new_count_str);
    // A hunk with new_count=0 is a pure deletion — use the surrounding line.
    const new_end = Math.max(new_start, new_start + new_count - 1);
    let ranges = file_ranges.get(current_file);
    if (ranges === undefined) {
      ranges = [];
      file_ranges.set(current_file, ranges);
    }
    ranges.push([new_start, new_end]);
  }

  if (file_ranges.size === 0) {
    return [];
  }

  // Resolve the project to get its DB.
  const proj = project.find_project(repo_root);
  if (proj === null) {
    _LOG.debug(`get_changed_symbols_db: no project found at ${repo_root}`);
    return [];
  }

  const result: ChangedSymbolDb[] = [];

  try {
    db.openProjectReadonly(proj.hash, (conn) => {
      // sorted(file_ranges.items()) — sort by file path.
      const sortedFiles = Array.from(file_ranges.entries()).sort((a, b) => {
        if (a[0] < b[0]) return -1;
        if (a[0] > b[0]) return 1;
        return 0;
      });
      for (const [file_rel, ranges] of sortedFiles) {
        if (result.length >= limit) {
          break;
        }
        // Build a WHERE clause that checks overlap for any of the ranges.
        // Symbol overlaps range if: sym_start <= range_end AND sym_end >= range_start
        // (sym_end may be NULL for top-level assignments — exclude those).
        const where_parts: string[] = [];
        const params: Array<string | number> = [file_rel];
        for (const [rng_start, rng_end] of ranges) {
          where_parts.push("(line <= ? AND end_line >= ?)");
          params.push(rng_end, rng_start);
        }

        const where_clause = where_parts.join(" OR ");
        const rows = conn
          .prepare(
            "SELECT DISTINCT name FROM symbols " +
              `WHERE file_rel = ? AND end_line IS NOT NULL AND (${where_clause}) ` +
              "ORDER BY line",
          )
          .all(...params) as Array<{ name: string }>;

        if (rows.length === 0) {
          continue;
        }

        const symbol_names = rows.map((r) => String(r.name));
        result.push({
          file: file_rel,
          symbols: symbol_names,
          symbol_count: symbol_names.length,
        });
      }
    });
  } catch {
    _LOG.debug("get_changed_symbols_db: DB query failed");
    return [];
  }

  return result;
}

// ---------------------------------------------------------------------------
// blame_symbol — git blame for a specific line range
// ---------------------------------------------------------------------------

/** A single blame line record. */
export interface BlameLine {
  line_no: number;
  commit_hash: string;
  author: string;
  date: string;
  content: string;
}

/**
 * Return git blame information for `file_path` lines `start_line`-`end_line`.
 *
 * Runs `git blame -L {start_line},{end_line} --porcelain {file_path}` and parses
 * the porcelain output into a list of dicts, one per line.
 *
 * Fail-soft: returns [] on any git error, missing repo, or parse failure. Never
 * raises.
 */
export function blame_symbol(
  repo_root: string,
  file_path: string,
  start_line: number,
  end_line: number,
): BlameLine[] {
  try {
    return _blame_symbol_inner(String(repo_root), file_path, start_line, end_line);
  } catch {
    _LOG.debug("blame_symbol failed");
    return [];
  }
}

function _blame_symbol_inner(
  repo_root: string,
  file_path: string,
  start_line: number,
  end_line: number,
): BlameLine[] {
  const raw = _run_git(
    ["blame", `-L${start_line},${end_line}`, "--porcelain", file_path],
    repo_root,
    30,
  );
  if (!raw) {
    return [];
  }
  return _parse_blame_porcelain(raw, start_line);
}

// Regex that matches the opening line of a porcelain blame block:
//   <40-char-hash> <orig_line> <final_line> [<count>]
const _BLAME_HEADER_RE = /^([0-9a-f]{40}) \d+ (\d+)(?: \d+)?$/;

/**
 * Parse `git blame --porcelain` output into a list of line dicts.
 *
 * Lines that have been grouped (same commit, consecutive) reuse the previously
 * seen commit metadata; only the first occurrence of a hash emits the full
 * header block.
 */
export function _parse_blame_porcelain(
  raw: string,
  start_line: number,
): BlameLine[] {
  const lines = _splitlines(raw);
  const entries: BlameLine[] = [];

  // Cached metadata per commit hash (porcelain omits headers for repeated
  // commits).
  const commit_cache = new Map<string, { author?: string; date?: string }>();
  let current_hash = "";
  let current_meta: { author?: string; date?: string } = {};
  let current_line_no: number = start_line;

  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;

    const m = _BLAME_HEADER_RE.exec(line);
    if (m) {
      current_hash = m[1]!;
      current_line_no = Number(m[2]!);
      const cached = commit_cache.get(current_hash);
      if (cached !== undefined) {
        current_meta = cached;
      } else {
        current_meta = {};
        commit_cache.set(current_hash, current_meta);
      }
      i += 1;
      continue;
    }

    if (line.startsWith("author ") && !line.startsWith("author-")) {
      current_meta.author = line.slice(7);
      i += 1;
      continue;
    }

    if (line.startsWith("author-time ")) {
      // Python: int(line[12:].strip()) then fromtimestamp(ts, UTC).strftime.
      const tsStr = line.slice(12).trim();
      if (/^[+-]?\d+$/.test(tsStr)) {
        const ts = Number(tsStr);
        current_meta.date = _formatUtcDate(ts);
      } else {
        current_meta.date = "";
      }
      i += 1;
      continue;
    }

    // Content line — tab-prefixed.
    if (line.startsWith("\t")) {
      const content = line.slice(1); // strip leading tab
      entries.push({
        line_no: current_line_no,
        commit_hash: current_hash,
        author: current_meta.author ?? "",
        date: current_meta.date ?? "",
        content,
      });
      i += 1;
      continue;
    }

    // Any other header field (summary, committer, filename, …) — skip.
    i += 1;
  }

  return entries;
}

// ---------------------------------------------------------------------------
// Local helpers (no Python analogue — bridge the sqlite/time/path seams)
// ---------------------------------------------------------------------------

/** Wall-clock Unix seconds as a float (Python's time.time()). */
function _now(): number {
  return Date.now() / 1000;
}

/**
 * Format a Unix timestamp (seconds) as "YYYY-MM-DD" in UTC — the TS twin of
 * datetime.fromtimestamp(ts, tz=UTC).strftime("%Y-%m-%d"). On an out-of-range
 * timestamp (NaN/overflow) the Date getters return NaN; the caller treats that
 * via the same try/catch-equivalent (the regex guard above), so this only ever
 * sees a finite integer.
 */
function _formatUtcDate(ts: number): string {
  const d = new Date(ts * 1000);
  const y = d.getUTCFullYear();
  const m = d.getUTCMonth() + 1;
  const day = d.getUTCDate();
  if (!Number.isFinite(y)) {
    return "";
  }
  const mm = String(m).padStart(2, "0");
  const dd = String(day).padStart(2, "0");
  return `${y}-${mm}-${dd}`;
}

/** True if `p` exists on disk (Python's Path.exists()). */
function _pathExists(p: string): boolean {
  return fs.existsSync(p);
}

/**
 * True when `err` is the "per-project DB not found" error db.openProjectReadonly
 * throws (the TS twin of Python's FileNotFoundError). db.ts throws a plain
 * Error with the message `project db not found: <path>`.
 */
function _isProjectDbNotFound(err: unknown): boolean {
  return err instanceof Error && err.message.includes("project db not found");
}
