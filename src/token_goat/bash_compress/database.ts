/**
 * bash_compress DATABASE FILTERS — TypeScript port of the PsqlFilter,
 * MySQLFilter, Sqlite3Filter, and RedisCLIFilter Filter subclasses from
 * src/token_goat/bash_compress.py (plus the module-level psql / mysql /
 * mysqldump / sqlite3 / redis-cli regexes these classes reference).
 *
 * Four filters subclass the concrete Filter base from ./framework.js:
 *   - PsqlFilter      — `psql` (collapse SELECT tables >20 rows to header +
 *                       first 5 + footer; collapse bulk-migration DDL blocks
 *                       with >=3 CREATE TABLE lines to a summary; keep timing,
 *                       DML tags, NOTICE/ERROR/connection-error lines).
 *   - MySQLFilter     — `mysql` / `mysqldump` (collapse tabular query results
 *                       via a 0/1/2/3-phase border state machine; keep first 3
 *                       CREATE TABLE blocks in dump output, collapse the rest).
 *   - Sqlite3Filter   — `sqlite3` (pass through .schema-majority output;
 *                       collapse query results >20 rows to first 5 + count;
 *                       keep Error/Parse error/Runtime error lines).
 *   - RedisCLIFilter  — `redis-cli` (collapse KEYS/LRANGE/SMEMBERS/HGETALL
 *                       lists >20 items to first 10 + count; collapse repeated
 *                       OK lines and SCAN cursor pages to totals).
 *
 * ---------------------------------------------------------------------------
 * Parity notes (Python -> TS)
 * ---------------------------------------------------------------------------
 *  - Python identifiers preserved EXACTLY: PascalCase class names; snake_case
 *    methods/fields (compress, _compress_psql, _compress_query, _compress_dump,
 *    _compress_scan, _compress_bulk_ok, _compress_list, _is_scan_output); the
 *    snake_case module-private regex constants (_PSQL_*, _MYSQL*,
 *    _MYSQLDUMP_*, _SQLITE3_*, _REDIS_*). The per-class int thresholds keep
 *    their UPPER_SNAKE names (_TABLE_ROW_THRESHOLD, _TABLE_KEEP_ROWS,
 *    _DUMP_KEEP_TABLES, _ROW_THRESHOLD, _KEEP_ROWS, _LIST_THRESHOLD,
 *    _LIST_KEEP).
 *  - re.compile(...) -> top-level RegExp compiled once. re.IGNORECASE -> "i".
 *  - Python re.Pattern.match(line) is START-anchored (NOT end-anchored);
 *    emulated via _reMatch (non-global clone + index===0). .match() calls that
 *    read capture groups go through _reMatchObj. Python re.match(literal, ...)
 *    inline calls (e.g. `re.match(r"^[-+]+$", stripped)` in PsqlFilter, and the
 *    SCAN-cursor / quoted-key literals in RedisCLIFilter) are written as local
 *    module-private regexes so the anchored-match semantics are explicit.
 *  - Python re.Pattern.search(line) (unanchored) -> _reSearch. None of the four
 *    classes uses .search() directly; they all use .match() and inline
 *    re.match(...) literals.
 *  - Python `Path(argv[0]).name.lower()` (MySQLFilter binary dispatch) ->
 *    local _pathNameLower (final path component, backslash-normed, lowercased).
 *  - Python `m.group(1)` on a named/positional capture -> the RegExpExecArray
 *    indexer (m[1]). _PSQL_ROWS_RE captures the row count but PsqlFilter only
 *    treats the match as a boolean (the `rows_m` truthiness), so the group is
 *    preserved for parity but never indexed here.
 *  - Python str.strip() -> _strip; str.rstrip() -> _rstrip. `line.strip()`
 *    appears repeatedly (is_border, rows_m, non_empty filters) — shims mirror
 *    Python's Unicode-whitespace semantics via the "u" flag.
 *  - Python `f"{n}..."` interpolation -> template literals. `", ".join(parts)`
 *    -> parts.join(", "). `list.insert(0, x)` -> Array.prototype.unshift(x).
 *  - Python nested closure `flush_table()` mutating `nonlocal` state —
 *    rewritten as a closure over mutable locals (header_lines / data_rows /
 *    phase stored in a 1-tuple box where the closure reassigns them). JS
 *    closures can reassign outer `let` bindings directly (no nonlocal needed),
 *    so the PSQL/MySQL flush_table helpers close over plain `let` variables.
 *  - Python list comprehension `sum(1 for ln in lines if cond)` -> JS
 *    `lines.filter(cond).length` (matches the integer count). `[ln for ln in
 *    lines if cond]` -> lines.filter(...).
 *  - _maybe_note / _finalize / _emit_notes are framework-PUBLIC and imported
 *    (_maybe_note) or invoked statically (Filter._finalize /
 *    Filter._emit_notes). _combine_output is an INSTANCE method on Filter.
 *  - MySQLFilter._compress_dump note emits a trailing "..." that Python writes
 *    verbatim via the f-string `f"Dumping {a + b} tables..."` — preserved.
 *
 * detect_from_command gating (per filter, after _strip_prefixes / matches):
 *  - psql       : binaries {psql}; any subcommand (default binaries-based
 *                 matches() — MySQLFilter is the only one that overrides
 *                 compress() to dispatch on argv[0]; psql/sqlite3/redis-cli
 *                 use the inherited binaries-based matches()).
 *  - mysql      : binaries {mysql, mysqldump}; compress() branches on argv[0]
 *                 name (mysqldump -> _compress_dump, else _compress_query).
 *  - sqlite3    : binaries {sqlite3}; any subcommand.
 *  - redis-cli  : binaries {redis-cli}; any subcommand.
 *
 * NOTE on import depth: this file lives in the bash_compress/ SUBDIR; the
 * framework is a SIBLING (./framework.js). verbatimModuleSyntax is on ->
 * nothing imported here is type-only. noImplicitOverride is on -> every
 * overridden member carries `override`.
 *
 * MODULE-GLOBAL STATE: none. Every counter/list/phase is a local inside
 * compress()/helpers; no registerReset seam is needed.
 */

import {
  Filter,
  _maybe_note,
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

/** Python str.strip() — strip leading and trailing whitespace. */
function _strip(s: string): string {
  return s.replace(/^\s+/u, "").replace(/\s+$/u, "");
}

/** Python Path(p).name.lower() — final path component (after backslash norm), lowercased. */
function _pathNameLower(p: string): string {
  const norm = p.replace(/\\/g, "/").replace(/\/+$/, "");
  const idx = norm.lastIndexOf("/");
  const name = idx >= 0 ? norm.slice(idx + 1) : norm;
  return name.toLowerCase();
}

// ===========================================================================
// psql regexes (Python ~16346-16378).
// ===========================================================================

/** psql connection error prefix emitted before any query result. */
// Python: re.compile(r"^psql:\s+error:", re.IGNORECASE)
const _PSQL_CONN_ERROR_RE: RegExp = /^psql:\s+error:/i;
/** psql \timing output: "Time: 3.412 ms". */
// Python: re.compile(r"^Time:\s+[\d.]+\s+ms", re.IGNORECASE)
const _PSQL_TIMING_RE: RegExp = /^Time:\s+[\d.]+\s+ms/i;
/** DML result lines: "INSERT 0 5", "UPDATE 3", "CREATE TABLE", etc. */
// Python: re.compile(r"^(INSERT|UPDATE|DELETE|TRUNCATE|SELECT|CREATE|DROP|ALTER|COPY|
//                     DO|GRANT|REVOKE|SET|BEGIN|COMMIT|ROLLBACK)\b", re.IGNORECASE)
const _PSQL_CMD_TAG_RE: RegExp =
  /^(INSERT|UPDATE|DELETE|TRUNCATE|SELECT|CREATE|DROP|ALTER|COPY|DO|GRANT|REVOKE|SET|BEGIN|COMMIT|ROLLBACK)\b/i;
/** psql NOTICE / WARNING / HINT / DETAIL server messages. */
// Python: re.compile(r"^(NOTICE|WARNING|HINT|DETAIL):", re.IGNORECASE)
const _PSQL_NOTICE_RE: RegExp = /^(NOTICE|WARNING|HINT|DETAIL):/i;
/** psql ERROR lines — kept verbatim. */
// Python: re.compile(r"^(ERROR|FATAL|PANIC):", re.IGNORECASE)
const _PSQL_ERROR_RE: RegExp = /^(ERROR|FATAL|PANIC):/i;
/**
 * psql "N rows" footer. The capture group is preserved for parity but
 * PsqlFilter only uses the match as a boolean (the `rows_m` truthiness).
 */
// Python: re.compile(r"^\((\d+) rows?\)$")
const _PSQL_ROWS_RE: RegExp = /^\((\d+) rows?\)$/;
/** Migration DDL lines: CREATE TABLE / INDEX / SEQUENCE / etc. */
// Python: re.compile(r"^(CREATE TABLE|CREATE INDEX|CREATE UNIQUE INDEX|CREATE SEQUENCE|
//                     CREATE TYPE|CREATE FUNCTION|CREATE VIEW|CREATE TRIGGER|ALTER TABLE|
//                     ADD CONSTRAINT)\b", re.IGNORECASE)
const _PSQL_CREATE_RE: RegExp =
  /^(CREATE TABLE|CREATE INDEX|CREATE UNIQUE INDEX|CREATE SEQUENCE|CREATE TYPE|CREATE FUNCTION|CREATE VIEW|CREATE TRIGGER|ALTER TABLE|ADD CONSTRAINT)\b/i;
/**
 * Inline `re.match(r"^[-+]+$", stripped)` from PsqlFilter._compress_psql —
 * an ASCII table top/bottom border ("------+------"). Module-private so the
 * anchored-match semantics are explicit.
 */
const _PSQL_BORDER_INLINE_RE: RegExp = /^[-+]+$/;

// ===========================================================================
// mysql / mysqldump regexes (Python ~16523-16553).
// ===========================================================================

/** "N rows in set (0.00 sec)" — keep. Python: re.compile(r"^\d+ rows? in set", re.IGNORECASE) */
const _MYSQL_ROWS_IN_SET_RE: RegExp = /^\d+ rows? in set/i;
/** "N row affected (0.00 sec)" — keep. Python: re.compile(r"^\d+ rows? affected", re.IGNORECASE) */
const _MYSQL_ROWS_AFFECTED_RE: RegExp = /^\d+ rows? affected/i;
/** MySQL WARNING line (from mysql CLI). Python: re.compile(r"^(WARNING|WARN)\b", re.IGNORECASE) */
const _MYSQL_WARNING_RE: RegExp = /^(WARNING|WARN)\b/i;
/** MySQL ERROR line. Python: re.compile(r"^(ERROR|FATAL)\b", re.IGNORECASE) */
const _MYSQL_ERROR_RE: RegExp = /^(ERROR|FATAL)\b/i;
/** mysqldump "-- Table structure for table `foo`" comment. */
// Python: re.compile(r"^-- Table structure for table\b", re.IGNORECASE)
const _MYSQLDUMP_TABLE_STRUCT_RE: RegExp = /^-- Table structure for table\b/i;
/** mysqldump header banner lines ("-- MySQL dump …", "-- Host:", "-- Server version:"). */
// Python: re.compile(r"^-- (MySQL dump|Host:|Server version:|Dump completed)", re.IGNORECASE)
const _MYSQLDUMP_BANNER_RE: RegExp =
  /^-- (MySQL dump|Host:|Server version:|Dump completed)/i;
/** mysqldump "-- Dumping data for table" comment. */
// Python: re.compile(r"^-- Dumping (data|events|routines|triggers) for\b", re.IGNORECASE)
const _MYSQLDUMP_DATA_RE: RegExp = /^-- Dumping (data|events|routines|triggers) for\b/i;
/** MySQL table border line in tabular query output. Python: re.compile(r"^\+-+") */
const _MYSQL_TABLE_BORDER_RE: RegExp = /^\+-+/;

// ===========================================================================
// sqlite3 regexes (Python ~16726-16734).
// ===========================================================================

/** sqlite3 error lines. Python: re.compile(r"^(Error:|Parse error:|Runtime error:)", re.IGNORECASE) */
const _SQLITE3_ERROR_RE: RegExp = /^(Error:|Parse error:|Runtime error:)/i;
/** sqlite3 .schema / .tables output opener (CREATE TABLE / INDEX / etc.). */
// Python: re.compile(r"^(CREATE TABLE|CREATE INDEX|CREATE UNIQUE INDEX|CREATE VIEW|CREATE TRIGGER)\b",
//                     re.IGNORECASE)
const _SQLITE3_SCHEMA_RE: RegExp =
  /^(CREATE TABLE|CREATE INDEX|CREATE UNIQUE INDEX|CREATE VIEW|CREATE TRIGGER)\b/i;

// ===========================================================================
// redis-cli regexes (Python ~16789-16799) + inline literals.
// ===========================================================================

/** redis-cli error lines ("ERR ...", "WRONGTYPE ...", "(error) ..."). */
// Python: re.compile(r"^(\(error\)|ERR |WRONGTYPE |NOAUTH |NOSCRIPT |BUSYKEY |MISCONF )",
//                     re.IGNORECASE)
const _REDIS_ERROR_RE: RegExp =
  /^(\(error\)|ERR |WRONGTYPE |NOAUTH |NOSCRIPT |BUSYKEY |MISCONF )/i;
/** A single "OK" line (from SET / HSET / etc.). Python: re.compile(r"^OK$") */
const _REDIS_OK_RE: RegExp = /^OK$/;
/** SCAN output: "1) (cursor)" line or "2) 1) key" list lines. */
// Python: re.compile(r"^\d+\) \(integer\) \d+")
const _REDIS_SCAN_CURSOR_RE: RegExp = /^\d+\) \(integer\) \d+/;
/** Individual key/value lines in list output: "1) \"key\"" or " 1) \"key\"". */
// Python: re.compile(r"^\s*\d+\)\s+")
const _REDIS_LIST_ITEM_RE: RegExp = /^\s*\d+\)\s+/;
/**
 * Inline `re.match(r'^\s*\d+\)\s+"(.+)"', line)` from
 * RedisCLIFilter._compress_scan — extracts the quoted key text. Module-private
 * so the anchored-match + capture-group semantics are explicit.
 */
const _REDIS_SCAN_KEY_INLINE_RE: RegExp = /^\s*\d+\)\s+"(.+)"/;

// ===========================================================================
// PsqlFilter (Python ~16381-16518)
// ===========================================================================

/**
 * Compress `psql` PostgreSQL CLI output.
 *
 * - **Keep** `\timing` output (`Time: Xms`).
 * - **Keep** DML result tags (`INSERT N`, `UPDATE N`, `DELETE N`, etc.).
 * - **Keep** NOTICE / WARNING / HINT / DETAIL messages.
 * - **Keep** ERROR / FATAL / PANIC messages verbatim.
 * - **Keep** `psql: error:` connection errors verbatim.
 * - **Collapse** SELECT table output with >20 rows: keep headers + first 5 data
 *   rows + `(N rows)` footer.
 * - **Collapse** long migration output (>=3 CREATE TABLE lines): summarise as
 *   `Created N tables, N indexes`.
 */
export class PsqlFilter extends Filter {
  override name = "psql";
  override binaries: ReadonlySet<string> = new Set(["psql"]);

  _TABLE_ROW_THRESHOLD: number = 20;
  _TABLE_KEEP_ROWS: number = 5;

  override compress(
    stdout: string,
    stderr: string,
    _exit_code: number,
    _argv: string[],
  ): string {
    const merged = this._combine_output(stdout, stderr);
    return this._compress_psql(merged);
  }

  _compress_psql(text: string): string {
    const lines = text.split("\n");

    // Check for migration-style output first (bulk DDL).
    const create_tables = lines.filter((ln) => _reMatch(/^CREATE TABLE\b/i, ln)).length;
    const create_indexes = lines.filter((ln) =>
      _reMatch(/^CREATE (UNIQUE )?INDEX\b/i, ln),
    ).length;
    if (create_tables >= 3) {
      // Summarise the bulk DDL block; keep non-DDL lines.
      const non_ddl: string[] = [];
      for (const ln of lines) {
        if (_reMatch(_PSQL_CREATE_RE, ln)) {
          continue;
        }
        non_ddl.push(ln);
      }
      const summary_parts = [`${create_tables} tables`];
      if (create_indexes) {
        summary_parts.push(`${create_indexes} indexes`);
      }
      non_ddl.unshift(`[token-goat: Created ${summary_parts.join(", ")}]`);
      return Filter._finalize(non_ddl);
    }

    // Pass for SELECT table output: detect header separator and data rows.
    const kept: string[] = [];
    // State: collecting a tabular SELECT result.
    let in_table = false;
    let header_lines: string[] = []; // column header + separator border
    let data_rows: string[] = [];
    let after_header = false;

    const flush_table = (): void => {
      if (header_lines.length === 0) {
        in_table = false;
        return;
      }
      const total_rows = data_rows.length;
      kept.push(...header_lines);
      if (total_rows > this._TABLE_ROW_THRESHOLD) {
        kept.push(...data_rows.slice(0, this._TABLE_KEEP_ROWS));
        kept.push(
          `[token-goat: ${total_rows} rows (showing first ${this._TABLE_KEEP_ROWS})]`,
        );
      } else {
        kept.push(...data_rows);
      }
      in_table = false;
      header_lines = [];
      data_rows = [];
      after_header = false;
    };

    for (const line of lines) {
      // Always keep connection errors, errors, timing, DML tags, notices.
      if (
        _reMatch(_PSQL_CONN_ERROR_RE, line) ||
        _reMatch(_PSQL_ERROR_RE, line) ||
        _reMatch(_PSQL_TIMING_RE, line) ||
        _reMatch(_PSQL_CMD_TAG_RE, line) ||
        _reMatch(_PSQL_NOTICE_RE, line)
      ) {
        if (in_table) {
          flush_table();
        }
        kept.push(line);
        continue;
      }

      // Detect start of ASCII table (top border or column header border).
      // psql renders: " col1 | col2 \n------+------\n val | val \n------+------\n(N rows)"
      // The first dashes-only line after the column names is the separator.
      const stripped = _strip(line);

      // Top border of aligned table output (e.g. "------+------").
      const is_border = _reMatch(_PSQL_BORDER_INLINE_RE, stripped);
      // "N rows" footer.
      const rows_m = _reMatchObj(_PSQL_ROWS_RE, stripped);

      if (rows_m) {
        // Footer of a SELECT result.
        if (in_table) {
          flush_table();
        }
        kept.push(line);
        continue;
      }

      if (is_border) {
        if (!in_table) {
          // Beginning of a table: the line before this was the header.
          // Move last kept line into header_lines.
          if (kept.length > 0) {
            header_lines.push(kept.pop()!);
          }
          header_lines.push(line);
          in_table = true;
          after_header = true;
        } else {
          if (after_header) {
            header_lines.push(line);
            after_header = false;
          } else {
            // Closing border — flush.
            flush_table();
            kept.push(line);
          }
        }
        continue;
      }

      if (in_table) {
        data_rows.push(line);
      } else {
        kept.push(line);
      }
    }

    if (in_table) {
      flush_table();
    }

    return Filter._finalize(kept);
  }
}

// ===========================================================================
// MySQLFilter (Python ~16555-16721)
// ===========================================================================

/**
 * Compress `mysql` and `mysqldump` output.
 *
 * mysql query results:
 * - **Collapse** SELECT table results with >20 rows: keep headers + first 5
 *   rows + `"X rows in set"` footer.
 * - **Keep** `"N rows in set"` / `"N rows affected"` summary lines.
 * - **Keep** WARNING lines.
 * - **Keep** ERROR lines verbatim.
 *
 * mysqldump:
 * - **Keep** the dump header banner.
 * - **Keep** the first 3 CREATE TABLE blocks; collapse the rest to a count.
 * - **Keep** `-- Dumping data for table` markers.
 * - **Keep** ERROR lines verbatim.
 */
export class MySQLFilter extends Filter {
  override name = "mysql";
  override binaries: ReadonlySet<string> = new Set(["mysql", "mysqldump"]);

  _TABLE_ROW_THRESHOLD: number = 20;
  _TABLE_KEEP_ROWS: number = 5;
  _DUMP_KEEP_TABLES: number = 3;

  override compress(
    stdout: string,
    stderr: string,
    _exit_code: number,
    argv: string[],
  ): string {
    const binary_name = argv.length > 0 ? _pathNameLower(argv[0]!) : "";
    const merged = this._combine_output(stdout, stderr);
    if (binary_name.includes("mysqldump")) {
      return this._compress_dump(merged);
    }
    return this._compress_query(merged);
  }

  /** Compress tabular mysql query results. */
  _compress_query(text: string): string {
    const lines = text.split("\n");
    const kept: string[] = [];
    // State machine phases:
    //   0 = outside table
    //   1 = saw top border
    //   2 = saw column header row
    //   3 = saw second border (now collecting data rows)
    let phase = 0;
    let header_lines: string[] = [];
    let data_rows: string[] = [];

    const flush_table = (): void => {
      kept.push(...header_lines);
      const total = data_rows.length;
      if (total > this._TABLE_ROW_THRESHOLD) {
        kept.push(...data_rows.slice(0, this._TABLE_KEEP_ROWS));
        kept.push(
          `[token-goat: ${total} rows (showing first ${this._TABLE_KEEP_ROWS})]`,
        );
      } else {
        kept.push(...data_rows);
      }
      phase = 0;
      header_lines = [];
      data_rows = [];
    };

    for (const line of lines) {
      // Always keep signal lines.
      if (
        _reMatch(_MYSQL_ERROR_RE, line) ||
        _reMatch(_MYSQL_WARNING_RE, line) ||
        _reMatch(_MYSQL_ROWS_IN_SET_RE, line) ||
        _reMatch(_MYSQL_ROWS_AFFECTED_RE, line)
      ) {
        if (phase > 0) {
          flush_table();
        }
        kept.push(line);
        continue;
      }

      const stripped = _strip(line);
      const is_border = _reMatch(_MYSQL_TABLE_BORDER_RE, stripped);

      if (is_border) {
        if (phase === 0) {
          // Top border: start collecting header.
          phase = 1;
          header_lines.push(line);
        } else if (phase === 1) {
          // Second border immediately after top: malformed; keep.
          header_lines.push(line);
          phase = 2;
        } else if (phase === 2) {
          // Border after column name row: this is the header separator.
          header_lines.push(line);
          phase = 3;
        } else {
          // phase === 3: closing border.
          flush_table();
          kept.push(line);
        }
        continue;
      }

      if (phase === 0) {
        kept.push(line);
      } else if (phase === 1) {
        // Column name row.
        header_lines.push(line);
        phase = 2;
      } else if (phase === 2) {
        // Should be the separator border; treat as column row just in case.
        header_lines.push(line);
      } else {
        // phase === 3: data rows.
        data_rows.push(line);
      }
    }

    if (phase > 0) {
      flush_table();
    }

    return Filter._finalize(kept);
  }

  /** Compress mysqldump output: keep first N CREATE TABLE blocks. */
  _compress_dump(text: string): string {
    const lines = text.split("\n");
    const kept: string[] = [];
    let tables_kept = 0;
    let tables_collapsed = 0;
    let in_create = false; // inside a CREATE TABLE block
    let skip_block = false; // skipping a collapsed CREATE TABLE block

    for (const line of lines) {
      // Always keep errors.
      if (_reMatch(_MYSQL_ERROR_RE, line)) {
        kept.push(line);
        continue;
      }

      // mysqldump banner / data markers — always keep.
      if (_reMatch(_MYSQLDUMP_BANNER_RE, line) || _reMatch(_MYSQLDUMP_DATA_RE, line)) {
        kept.push(line);
        continue;
      }

      // "-- Table structure for table `name`" comment — keep with first N tables.
      if (_reMatch(_MYSQLDUMP_TABLE_STRUCT_RE, line)) {
        if (tables_kept < this._DUMP_KEEP_TABLES) {
          tables_kept += 1;
          in_create = true;
          skip_block = false;
          kept.push(line);
        } else {
          tables_collapsed += 1;
          in_create = true;
          skip_block = true;
        }
        continue;
      }

      if (in_create) {
        // A blank line between table blocks closes the block.
        if (_strip(line) === "") {
          in_create = false;
          skip_block = false;
          if (!skip_block) {
            kept.push(line);
          }
          continue;
        }
        if (!skip_block) {
          kept.push(line);
        }
        continue;
      }

      kept.push(line);
    }

    const notes: string[] = [];
    _maybe_note(notes, tables_collapsed, `Dumping ${tables_kept + tables_collapsed} tables...`);
    MySQLFilter._emit_notes(kept, notes);
    return Filter._finalize(kept);
  }
}

// ===========================================================================
// Sqlite3Filter (Python ~16737-16784)
// ===========================================================================

/**
 * Compress `sqlite3` CLI output.
 *
 * - **Collapse** long SELECT results (>20 rows): keep first 5 + count marker.
 * - **Keep** `.schema` output as-is (usually compact; only truncate when giant
 *   via the universal line cap).
 * - **Keep** error lines (`Error:`, `Parse error:`, `Runtime error:`) verbatim.
 */
export class Sqlite3Filter extends Filter {
  override name = "sqlite3";
  override binaries: ReadonlySet<string> = new Set(["sqlite3"]);

  _ROW_THRESHOLD: number = 20;
  _KEEP_ROWS: number = 5;

  override compress(
    stdout: string,
    stderr: string,
    _exit_code: number,
    _argv: string[],
  ): string {
    const merged = this._combine_output(stdout, stderr);
    const lines = merged.split("\n");
    // Schema output (detected by majority of lines starting with CREATE): pass through.
    const non_empty = lines.filter((ln) => _strip(ln) !== "");
    const schema_lines = non_empty.filter((ln) => _reMatch(_SQLITE3_SCHEMA_RE, ln));
    if (non_empty.length > 0 && schema_lines.length / non_empty.length >= 0.5) {
      // Majority is schema — keep as-is; line cap handles giant files.
      return merged;
    }

    // For query results: keep errors always; collapse long output.
    const errors = lines.filter((ln) => _reMatch(_SQLITE3_ERROR_RE, ln));
    const data_lines = lines.filter((ln) => !_reMatch(_SQLITE3_ERROR_RE, ln));
    const non_empty_data = data_lines.filter((ln) => _strip(ln) !== "");

    const kept: string[] = [];
    kept.push(...errors);

    if (non_empty_data.length > this._ROW_THRESHOLD) {
      kept.push(...non_empty_data.slice(0, this._KEEP_ROWS));
      kept.push(
        `[token-goat: ${non_empty_data.length} rows (showing first ${this._KEEP_ROWS})]`,
      );
    } else {
      kept.push(...data_lines);
    }

    return Filter._finalize(kept);
  }
}

// ===========================================================================
// RedisCLIFilter (Python ~16802-16913)
// ===========================================================================

/**
 * Compress `redis-cli` output.
 *
 * - **Collapse** `KEYS *` output with >20 keys: keep first 10 + count.
 * - **Collapse** `LRANGE` / `SMEMBERS` / `HGETALL` results with >20 items:
 *   keep first 10 + count.
 * - **Collapse** bulk `OK` lines (repeated SET operations): count summary.
 * - **Collapse** `SCAN` cursor pages: emit final key total.
 * - **Keep** error lines verbatim.
 */
export class RedisCLIFilter extends Filter {
  override name = "redis-cli";
  override binaries: ReadonlySet<string> = new Set(["redis-cli"]);

  _LIST_THRESHOLD: number = 20;
  _LIST_KEEP: number = 10;

  override compress(
    stdout: string,
    stderr: string,
    _exit_code: number,
    _argv: string[],
  ): string {
    const merged = this._combine_output(stdout, stderr);
    const lines = merged.split("\n");

    // Detect SCAN output: multiple cursor blocks.
    if (this._is_scan_output(lines)) {
      return this._compress_scan(lines);
    }

    // Detect bulk OK (multiple consecutive OK lines).
    const ok_count = lines.filter((ln) => _reMatch(_REDIS_OK_RE, _strip(ln))).length;
    if (ok_count >= 5) {
      return this._compress_bulk_ok(lines, ok_count);
    }

    // Detect long list-style output (numbered items).
    const list_items = lines.filter((ln) => _reMatch(_REDIS_LIST_ITEM_RE, ln));
    if (list_items.length > this._LIST_THRESHOLD) {
      return this._compress_list(lines, list_items);
    }

    // Default: keep everything; errors always pass through.
    return Filter._finalize(lines);
  }

  /**
   * Return true when output looks like one or more SCAN cursor responses.
   *
   * SCAN responses have the distinctive shape:
   *   1) (integer) <cursor>   <- cursor line
   *   2) 1) "key1"            <- start of key sublist
   *      2) "key2"
   * The cursor line matches `^\d+\) \(integer\) \d+`. Plain list output
   * (LRANGE / SMEMBERS) never has that cursor pattern.
   */
  _is_scan_output(lines: string[]): boolean {
    return lines.some((ln) => _reMatch(_REDIS_SCAN_CURSOR_RE, ln));
  }

  /** Collapse SCAN pages to a total key count. */
  _compress_scan(lines: string[]): string {
    const all_keys: string[] = [];
    const errors: string[] = [];
    // Collect all quoted key entries from the nested list.
    for (const line of lines) {
      if (_reMatch(_REDIS_ERROR_RE, line)) {
        errors.push(line);
        continue;
      }
      // Key entries look like: `1) "keyname"` (indented or not).
      const m = _reMatchObj(_REDIS_SCAN_KEY_INLINE_RE, line);
      if (m) {
        all_keys.push(m[1]!);
      }
    }

    const kept: string[] = [...errors];
    const total = all_keys.length;
    if (total > this._LIST_KEEP) {
      kept.push(...all_keys.slice(0, this._LIST_KEEP).map((k) => `"${k}"`));
      kept.push(
        `[token-goat: ${total} keys total (showing first ${this._LIST_KEEP})]`,
      );
    } else {
      kept.push(...all_keys.map((k) => `"${k}"`));
    }
    return Filter._finalize(kept);
  }

  /** Collapse repeated OK lines to a count; keep non-OK lines. */
  _compress_bulk_ok(lines: string[], ok_count: number): string {
    const kept: string[] = [];
    for (const line of lines) {
      if (_reMatch(_REDIS_OK_RE, _strip(line))) {
        continue;
      }
      if (_reMatch(_REDIS_ERROR_RE, line)) {
        kept.push(line);
        continue;
      }
      kept.push(line);
    }
    kept.push(`[token-goat: ${ok_count} OK responses]`);
    return Filter._finalize(kept);
  }

  /** Collapse long list output to first N items + count. */
  _compress_list(lines: string[], list_items: string[]): string {
    const kept: string[] = [];
    let item_count = 0;
    const total = list_items.length;
    for (const line of lines) {
      if (_reMatch(_REDIS_ERROR_RE, line)) {
        kept.push(line);
        continue;
      }
      if (_reMatch(_REDIS_LIST_ITEM_RE, line)) {
        if (item_count < this._LIST_KEEP) {
          kept.push(line);
        }
        item_count += 1;
      } else {
        kept.push(line);
      }
    }
    if (total > this._LIST_KEEP) {
      kept.push(`[token-goat: ${total} items (showing first ${this._LIST_KEEP})]`);
    }
    return Filter._finalize(kept);
  }
}
