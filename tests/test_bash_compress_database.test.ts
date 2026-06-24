/**
 * Tests for database CLI filters: PsqlFilter, MySQLFilter, Sqlite3Filter,
 * RedisCLIFilter in token_goat.bash_compress.
 *
 * 1:1 port of tests/test_bash_compress_database.py. Every Python `def test_*`
 * maps to a vitest `it()` with the SAME name and assertion polarity; the Python
 * test classes (TestPsqlFilter, TestMySQLFilter, TestSqlite3Filter,
 * TestRedisCLIFilter) map to `describe()` blocks of the same name.
 *
 * Test-seam mapping (Python -> TS):
 *  - `from token_goat import bash_compress as bc`
 *      -> import the barrel "../src/token_goat/bash_compress.js" as `bc`
 *        (re-exports PsqlFilter / MySQLFilter / Sqlite3Filter / RedisCLIFilter
 *        + select_filter).
 *  - Each Python test calls `f.apply(stdout, stderr, exit_code, argv)` directly
 *    and reads `.text`; the TS port calls `f.apply(...)` with the same positional
 *    args and reads `.text` (apply() returns a CompressedOutput whose `.text` is
 *    the body). Python `result.text` -> TS `result.text`.
 *  - Python `result.compressed_bytes < result.original_bytes` -> direct field
 *    comparison on the same CompressedOutput fields.
 *  - `isinstance(bc.select_filter(argv), bc.XFilter)` -> `select_filter(argv)
 *    instanceof XFilter`.
 *
 * Byte-exactness: these filters operate on whole lines, aligned-table borders,
 * pipe-separated rows, and substring markers ("30 rows", "showing first 5",
 * "5 tables", "2 indexes", "30 items", "showing first 10", "10 OK", ...). The
 * assertions are substring / `.count()` checks on the returned string, matching
 * the Python `in` / `not in` / `.count(...)` checks. The fixtures are pure ASCII
 * so code-unit length equals byte length; no Buffer arithmetic is needed here.
 *
 * Parity notes on the synthetic table builders (Python -> TS):
 *  - psql aligned table: header " id | name ", separator "----+------", rows
 *    `  {i} | row{i} `, footer `({n} rows)`. `range(1, n+1)` -> Array.from over
 *    1..n inclusive.
 *  - mysql box-drawn table: border "+---------+----------+", header
 *    "| id      | name     |", rows `| {i:<7} | row{i:<5} |` (left-justified in
 *    7/5 cols via String.padEnd), footer `{n} rows in set (0.00 sec)`.
 *  - sqlite3 pipe rows: `{i}|row{i}`.
 *  - redis KEYS/LRANGE: `{i}) "key:{i}"` / `{i}) "value{i}"`.
 */
import { describe, expect, it } from "vitest";

import * as bc from "../src/token_goat/bash_compress.js";
import {
  MySQLFilter,
  PsqlFilter,
  RedisCLIFilter,
  Sqlite3Filter,
} from "../src/token_goat/bash_compress.js";

// ---------------------------------------------------------------------------
// Synthetic fixture builders (ports of the module-level Python helpers).
// ---------------------------------------------------------------------------

const _PSQL_ARGV = ["psql", "-U", "postgres", "mydb"];

/** Build a synthetic psql aligned-table SELECT result with n data rows. */
function _psqlTable(nRows: number): string {
  const header = " id | name ";
  const sep = "----+------";
  const rows: string[] = [];
  for (let i = 1; i <= nRows; i++) {
    rows.push(`  ${i} | row${i} `);
  }
  const footer = `(${nRows} rows)`;
  return [header, sep, ...rows, sep, footer].join("\n");
}

const _MYSQL_ARGV = ["mysql", "-u", "root", "mydb"];
const _MYSQLDUMP_ARGV = ["mysqldump", "-u", "root", "mydb"];

/** Build a synthetic mysql aligned-table result with n data rows. */
function _mysqlTable(nRows: number): string {
  const border = "+---------+----------+";
  const header = "| id      | name     |";
  const rows: string[] = [];
  for (let i = 1; i <= nRows; i++) {
    // Python f"| {i:<7} | row{i:<5} |" — left-justify i in 7 cols, row{i} in 5.
    rows.push(`| ${String(i).padEnd(7)} | row${String(i).padEnd(5)} |`);
  }
  const footer = `${nRows} rows in set (0.00 sec)`;
  return [border, header, border, ...rows, border, footer].join("\n");
}

const _SQLITE3_ARGV = ["sqlite3", "mydb.sqlite"];

/** Build pipe-separated sqlite3 output with n rows. */
function _sqlite3Rows(n: number): string {
  const rows: string[] = [];
  for (let i = 1; i <= n; i++) {
    rows.push(`${i}|row${i}`);
  }
  return rows.join("\n");
}

const _REDIS_ARGV = ["redis-cli"];

/** Build a redis-cli KEYS * response with n key entries. */
function _redisKeys(n: number): string {
  const lines: string[] = [];
  for (let i = 1; i <= n; i++) {
    lines.push(`${i}) "key:${i}"`);
  }
  return lines.join("\n");
}

/** Build a redis-cli LRANGE response with n items. */
function _redisList(n: number): string {
  const lines: string[] = [];
  for (let i = 1; i <= n; i++) {
    lines.push(`${i}) "value${i}"`);
  }
  return lines.join("\n");
}

// ===========================================================================
// PsqlFilter
// ===========================================================================

describe("TestPsqlFilter", () => {
  it("test_matches", () => {
    const f = new PsqlFilter();
    expect(f.matches(["psql", "-U", "postgres", "db"])).toBe(true);
    expect(f.matches(["mysql"])).toBe(false);
  });

  it("test_select_filter", () => {
    expect(bc.select_filter(["psql", "-U", "postgres", "db"]) instanceof PsqlFilter).toBe(true);
  });

  it("test_short_table_kept_intact", () => {
    const out = _psqlTable(5);
    const f = new PsqlFilter();
    const r = f.apply(out, "", 0, _PSQL_ARGV);
    // All 5 data rows should be present.
    expect(r.text).toContain("row5");
  });

  it("test_long_table_collapsed", () => {
    const out = _psqlTable(30);
    const f = new PsqlFilter();
    const r = f.apply(out, "", 0, _PSQL_ARGV);
    expect(r.text).toContain("30 rows");
    expect(r.text).toContain("showing first 5");
    // Row 6 onwards should be elided.
    expect(r.text).not.toContain("row6");
  });

  it("test_long_table_keeps_first_rows", () => {
    const out = _psqlTable(30);
    const f = new PsqlFilter();
    const r = f.apply(out, "", 0, _PSQL_ARGV);
    expect(r.text).toContain("row1");
    expect(r.text).toContain("row5");
  });

  it("test_timing_kept", () => {
    const out = "SELECT 1\nTime: 3.412 ms";
    const f = new PsqlFilter();
    const r = f.apply(out, "", 0, _PSQL_ARGV);
    expect(r.text).toContain("Time: 3.412 ms");
  });

  it("test_dml_tag_kept", () => {
    const out = "INSERT 0 5";
    const f = new PsqlFilter();
    const r = f.apply(out, "", 0, _PSQL_ARGV);
    expect(r.text).toContain("INSERT 0 5");
  });

  it("test_update_tag_kept", () => {
    const out = "UPDATE 3";
    const f = new PsqlFilter();
    const r = f.apply(out, "", 0, _PSQL_ARGV);
    expect(r.text).toContain("UPDATE 3");
  });

  it("test_delete_tag_kept", () => {
    const out = "DELETE 7";
    const f = new PsqlFilter();
    const r = f.apply(out, "", 0, _PSQL_ARGV);
    expect(r.text).toContain("DELETE 7");
  });

  it("test_notice_kept", () => {
    const out = 'NOTICE:  table "foo" does not exist, skipping';
    const f = new PsqlFilter();
    const r = f.apply(out, "", 0, _PSQL_ARGV);
    expect(r.text).toContain("NOTICE");
  });

  it("test_warning_kept", () => {
    const out = "WARNING:  there is already a transaction in progress";
    const f = new PsqlFilter();
    const r = f.apply(out, "", 0, _PSQL_ARGV);
    expect(r.text).toContain("WARNING");
  });

  it("test_error_kept_verbatim", () => {
    const out = 'ERROR:  relation "foo" does not exist\nLINE 1: SELECT * FROM foo;';
    const f = new PsqlFilter();
    const r = f.apply(out, "", 1, _PSQL_ARGV);
    expect(r.text).toContain("ERROR");
    expect(r.text).toContain('relation "foo"');
  });

  it("test_connection_error_kept", () => {
    const err = "psql: error: connection to server on socket failed";
    const f = new PsqlFilter();
    const r = f.apply("", err, 2, _PSQL_ARGV);
    expect(r.text).toContain("psql: error:");
  });

  it("test_migration_collapsed", () => {
    const ddlLines: string[] = [];
    for (let i = 0; i < 5; i++) {
      ddlLines.push(`CREATE TABLE t${i} (id int);`);
    }
    const out = ddlLines.join("\n");
    const f = new PsqlFilter();
    const r = f.apply(out, "", 0, _PSQL_ARGV);
    expect(r.text).toContain("5 tables");
    // Individual table names should be collapsed.
    expect(r.text).not.toContain("CREATE TABLE t4");
  });

  it("test_migration_with_indexes", () => {
    const lines: string[] = [];
    for (let i = 0; i < 3; i++) {
      lines.push("CREATE TABLE orders (id int);");
    }
    for (let i = 0; i < 2; i++) {
      lines.push("CREATE INDEX idx_orders_id ON orders (id);");
    }
    const out = lines.join("\n");
    const f = new PsqlFilter();
    const r = f.apply(out, "", 0, _PSQL_ARGV);
    expect(r.text).toContain("3 tables");
    expect(r.text).toContain("2 indexes");
  });

  it("test_empty_output", () => {
    const f = new PsqlFilter();
    const r = f.apply("", "", 0, _PSQL_ARGV);
    expect(typeof r.text).toBe("string");
  });

  it("test_compression_on_long_table", () => {
    const out = _psqlTable(50);
    const f = new PsqlFilter();
    const r = f.apply(out, "", 0, _PSQL_ARGV);
    expect(r.compressed_bytes).toBeLessThan(r.original_bytes);
  });
});

// ===========================================================================
// MySQLFilter
// ===========================================================================

describe("TestMySQLFilter", () => {
  it("test_matches_mysql", () => {
    const f = new MySQLFilter();
    expect(f.matches(["mysql", "-u", "root", "db"])).toBe(true);
    expect(f.matches(["psql"])).toBe(false);
  });

  it("test_matches_mysqldump", () => {
    const f = new MySQLFilter();
    expect(f.matches(["mysqldump", "-u", "root", "db"])).toBe(true);
  });

  it("test_select_filter_mysql", () => {
    expect(bc.select_filter(["mysql", "-u", "root", "db"]) instanceof MySQLFilter).toBe(true);
  });

  it("test_select_filter_mysqldump", () => {
    expect(bc.select_filter(["mysqldump", "-u", "root", "db"]) instanceof MySQLFilter).toBe(true);
  });

  it("test_short_table_intact", () => {
    const out = _mysqlTable(5);
    const f = new MySQLFilter();
    const r = f.apply(out, "", 0, _MYSQL_ARGV);
    expect(r.text).toContain("row5");
  });

  it("test_long_table_collapsed", () => {
    const out = _mysqlTable(30);
    const f = new MySQLFilter();
    const r = f.apply(out, "", 0, _MYSQL_ARGV);
    expect(r.text).toContain("30 rows");
    expect(r.text).toContain("showing first 5");
    expect(r.text).not.toContain("row6");
  });

  it("test_long_table_keeps_first_rows", () => {
    const out = _mysqlTable(30);
    const f = new MySQLFilter();
    const r = f.apply(out, "", 0, _MYSQL_ARGV);
    expect(r.text).toContain("row1");
    expect(r.text).toContain("row5");
  });

  it("test_rows_in_set_kept", () => {
    const out = _mysqlTable(3);
    const f = new MySQLFilter();
    const r = f.apply(out, "", 0, _MYSQL_ARGV);
    expect(r.text).toContain("rows in set");
  });

  it("test_warning_kept", () => {
    const out = "WARNING: Using a password on the command line interface can be insecure.";
    const f = new MySQLFilter();
    const r = f.apply(out, "", 0, _MYSQL_ARGV);
    expect(r.text).toContain("WARNING");
  });

  it("test_error_kept_verbatim", () => {
    const out = "ERROR 1045 (28000): Access denied for user 'root'@'localhost'";
    const f = new MySQLFilter();
    const r = f.apply(out, "", 1, _MYSQL_ARGV);
    expect(r.text).toContain("ERROR 1045");
  });

  it("test_mysqldump_banner_kept", () => {
    const out =
      "-- MySQL dump 10.13  Distrib 8.0.30\n-- Host: localhost    Database: mydb\n";
    const f = new MySQLFilter();
    const r = f.apply(out, "", 0, _MYSQLDUMP_ARGV);
    expect(r.text).toContain("MySQL dump");
  });

  it("test_mysqldump_collapse_many_tables", () => {
    // 5 table structure blocks; only first 3 should be kept verbatim.
    const blocks: string[] = [];
    for (let i = 0; i < 5; i++) {
      blocks.push(`-- Table structure for table \`t${i}\``);
      blocks.push(`CREATE TABLE \`t${i}\` (id int);`);
      blocks.push("");
    }
    const out = blocks.join("\n");
    const f = new MySQLFilter();
    const r = f.apply(out, "", 0, _MYSQLDUMP_ARGV);
    // The summary note should mention 5 tables.
    expect(r.text).toContain("5 tables");
  });

  it("test_mysqldump_keeps_first_n_tables", () => {
    const blocks: string[] = [];
    for (let i = 0; i < 5; i++) {
      blocks.push(`-- Table structure for table \`t${i}\``);
      blocks.push(`CREATE TABLE \`t${i}\` (id int);`);
      blocks.push("");
    }
    const out = blocks.join("\n");
    const f = new MySQLFilter();
    const r = f.apply(out, "", 0, _MYSQLDUMP_ARGV);
    // First 3 CREATE TABLE lines should be present.
    expect(r.text).toContain("CREATE TABLE `t0`");
    expect(r.text).toContain("CREATE TABLE `t2`");
  });

  it("test_empty_output", () => {
    const f = new MySQLFilter();
    const r = f.apply("", "", 0, _MYSQL_ARGV);
    expect(typeof r.text).toBe("string");
  });

  it("test_compression_on_long_table", () => {
    const out = _mysqlTable(50);
    const f = new MySQLFilter();
    const r = f.apply(out, "", 0, _MYSQL_ARGV);
    expect(r.compressed_bytes).toBeLessThan(r.original_bytes);
  });
});

// ===========================================================================
// Sqlite3Filter
// ===========================================================================

describe("TestSqlite3Filter", () => {
  it("test_matches", () => {
    const f = new Sqlite3Filter();
    expect(f.matches(["sqlite3", "db.sqlite"])).toBe(true);
    expect(f.matches(["mysql"])).toBe(false);
  });

  it("test_select_filter", () => {
    expect(bc.select_filter(["sqlite3", "db.sqlite"]) instanceof Sqlite3Filter).toBe(true);
  });

  it("test_short_output_intact", () => {
    const out = _sqlite3Rows(5);
    const f = new Sqlite3Filter();
    const r = f.apply(out, "", 0, _SQLITE3_ARGV);
    expect(r.text).toContain("row5");
  });

  it("test_long_output_collapsed", () => {
    const out = _sqlite3Rows(30);
    const f = new Sqlite3Filter();
    const r = f.apply(out, "", 0, _SQLITE3_ARGV);
    expect(r.text).toContain("30 rows");
    expect(r.text).toContain("showing first 5");
    expect(r.text).not.toContain("row6");
  });

  it("test_long_output_keeps_first_rows", () => {
    const out = _sqlite3Rows(30);
    const f = new Sqlite3Filter();
    const r = f.apply(out, "", 0, _SQLITE3_ARGV);
    expect(r.text).toContain("row1");
    expect(r.text).toContain("row5");
  });

  it("test_schema_output_kept", () => {
    const out =
      "CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT);\n" +
      "CREATE TABLE orders (id INTEGER PRIMARY KEY, user_id INTEGER);\n" +
      "CREATE INDEX idx_orders_user ON orders(user_id);\n";
    const f = new Sqlite3Filter();
    const r = f.apply(out, "", 0, _SQLITE3_ARGV);
    expect(r.text).toContain("CREATE TABLE users");
    expect(r.text).toContain("CREATE TABLE orders");
  });

  it("test_error_kept_verbatim", () => {
    const err = "Error: no such table: missing_table";
    const f = new Sqlite3Filter();
    const r = f.apply("", err, 1, _SQLITE3_ARGV);
    expect(r.text).toContain("Error:");
    expect(r.text).toContain("missing_table");
  });

  it("test_parse_error_kept", () => {
    const err = 'Parse error: near "SELEC": syntax error';
    const f = new Sqlite3Filter();
    const r = f.apply("", err, 1, _SQLITE3_ARGV);
    expect(r.text).toContain("Parse error:");
  });

  it("test_empty_output", () => {
    const f = new Sqlite3Filter();
    const r = f.apply("", "", 0, _SQLITE3_ARGV);
    expect(typeof r.text).toBe("string");
  });

  it("test_compression_on_long_output", () => {
    const out = _sqlite3Rows(50);
    const f = new Sqlite3Filter();
    const r = f.apply(out, "", 0, _SQLITE3_ARGV);
    expect(r.compressed_bytes).toBeLessThan(r.original_bytes);
  });
});

// ===========================================================================
// RedisCLIFilter
// ===========================================================================

describe("TestRedisCLIFilter", () => {
  it("test_matches", () => {
    const f = new RedisCLIFilter();
    expect(f.matches(["redis-cli"])).toBe(true);
    expect(f.matches(["mysql"])).toBe(false);
  });

  it("test_select_filter", () => {
    expect(bc.select_filter(["redis-cli"]) instanceof RedisCLIFilter).toBe(true);
  });

  it("test_short_keys_intact", () => {
    const out = _redisKeys(5);
    const f = new RedisCLIFilter();
    const r = f.apply(out, "", 0, _REDIS_ARGV);
    expect(r.text).toContain('"key:5"');
  });

  it("test_long_keys_collapsed", () => {
    const out = _redisKeys(30);
    const f = new RedisCLIFilter();
    const r = f.apply(out, "", 0, _REDIS_ARGV);
    expect(r.text).toContain("30");
    expect(
      r.text.includes("showing first 10") || r.text.includes("keys total"),
    ).toBe(true);
  });

  it("test_long_keys_elides_tail", () => {
    const out = _redisKeys(30);
    const f = new RedisCLIFilter();
    const r = f.apply(out, "", 0, _REDIS_ARGV);
    expect(r.text).not.toContain('"key:30"');
  });

  it("test_bulk_ok_collapsed", () => {
    const out = Array.from({ length: 10 }, () => "OK").join("\n");
    const f = new RedisCLIFilter();
    const r = f.apply(out, "", 0, _REDIS_ARGV);
    expect(r.text).toContain("10 OK");
    // Individual OK lines should not appear verbatim 10 times.
    // Python r.text.count("\nOK\n") < 5 — count of non-overlapping "\nOK\n".
    const needle = "\nOK\n";
    let occurrences = 0;
    let idx = r.text.indexOf(needle);
    while (idx !== -1) {
      occurrences += 1;
      idx = r.text.indexOf(needle, idx + needle.length);
    }
    expect(occurrences).toBeLessThan(5);
  });

  it("test_long_list_collapsed", () => {
    const out = _redisList(30);
    const f = new RedisCLIFilter();
    const r = f.apply(out, "", 0, _REDIS_ARGV);
    expect(r.text).toContain("30 items");
    expect(r.text).toContain("showing first 10");
  });

  it("test_long_list_keeps_first_items", () => {
    const out = _redisList(30);
    const f = new RedisCLIFilter();
    const r = f.apply(out, "", 0, _REDIS_ARGV);
    expect(r.text).toContain('"value1"');
    expect(r.text).toContain('"value10"');
    expect(r.text).not.toContain('"value11"');
  });

  it("test_error_kept_verbatim", () => {
    const out =
      "(error) WRONGTYPE Operation against a key holding the wrong kind of value";
    const f = new RedisCLIFilter();
    const r = f.apply(out, "", 1, _REDIS_ARGV);
    expect(r.text).toContain("WRONGTYPE");
  });

  it("test_scan_output_collapsed", () => {
    // Simulate two SCAN pages with a cursor and key list.
    const out =
      "1) (integer) 42\n" +
      '2) 1) "alpha"\n' +
      '   2) "beta"\n' +
      '   3) "gamma"\n' +
      "1) (integer) 0\n" +
      '2) 1) "delta"\n' +
      '   2) "epsilon"\n';
    const f = new RedisCLIFilter();
    const r = f.apply(out, "", 0, _REDIS_ARGV);
    // Should produce a compact summary, not raw cursor output.
    expect(typeof r.text).toBe("string");
    // Original was verbose SCAN output; text should be shorter or a summary.
    expect(r.text.length).toBeLessThanOrEqual(out.length + 200); // allow for summary line overhead
  });

  it("test_empty_output", () => {
    const f = new RedisCLIFilter();
    const r = f.apply("", "", 0, _REDIS_ARGV);
    expect(typeof r.text).toBe("string");
  });

  it("test_compression_on_long_keys", () => {
    const out = _redisKeys(50);
    const f = new RedisCLIFilter();
    const r = f.apply(out, "", 0, _REDIS_ARGV);
    expect(r.compressed_bytes).toBeLessThan(r.original_bytes);
  });
});
