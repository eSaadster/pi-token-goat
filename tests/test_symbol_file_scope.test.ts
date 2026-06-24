/**
 * 1:1 port of tests/test_symbol_file_scope.py.
 *
 * Tests the optional FILE positional that scopes `token-goat symbol NAME FILE`.
 * The Python suite installs a fake `_query_project` that runs the actual SQL
 * against an in-memory sqlite3 table (so the filter-then-LIMIT ordering is
 * exercised for real). The TS port mirrors this with better-sqlite3 `:memory:`.
 *
 * Monkeypatch map: Python `cli._require_project` / `cli._project_symbol_pool`
 * / `cli._query_project` / `read_commands._not_indexed_hint` → TS spies on the
 * same names off the cliLookup + read_commands namespaces (cli_lookup routes
 * through `import * as self`, so spies are observed).
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import Database from "better-sqlite3";

import * as cliLookup from "../src/token_goat/cli_lookup.js";
import * as read_commands from "../src/token_goat/read_commands.js";
import { index_project } from "../src/token_goat/parser.js";
import { make_project_at } from "../src/token_goat/project.js";
import { invoke } from "./_cli_runner.js";

const _tmpRoots: string[] = [];
let _savedCwd: string | null = null;

afterEach(() => {
  vi.restoreAllMocks();
  if (_savedCwd !== null) {
    try {
      process.chdir(_savedCwd);
    } catch {
      // best-effort
    }
    _savedCwd = null;
  }
  while (_tmpRoots.length) {
    const d = _tmpRoots.pop()!;
    try {
      fs.rmSync(d, { recursive: true, force: true });
    } catch {
      // best-effort
    }
  }
});

const _FAKE_PROJECT = {
  hash: "0".repeat(64),
  root: "/fake/root",
  marker: ".git",
};

/** Build fake _query_project rows for MyClass across the given files. */
function _rowsIn(...fileRels: string[]): Array<Record<string, unknown>> {
  return fileRels.map((rel) => ({
    name: "MyClass",
    kind: "class",
    file_rel: rel,
    line: 10,
    signature: "",
  }));
}

/**
 * Install a fake _query_project that runs the command's SQL against a throwaway
 * in-memory symbols table (so WHERE/LIMIT ordering is exercised for real).
 */
function _installQuery(rows: Array<Record<string, unknown>>): void {
  vi.spyOn(cliLookup, "_require_project").mockResolvedValue(_FAKE_PROJECT);
  vi.spyOn(cliLookup, "_project_symbol_pool").mockReturnValue(["MyClass"]);
  vi.spyOn(read_commands, "_not_indexed_hint").mockReturnValue(null);

  vi.spyOn(cliLookup, "_query_project").mockImplementation((_hash, sql, params) => {
    const conn = new Database(":memory:");
    conn.exec(
      "CREATE TABLE symbols " +
        "(name TEXT, kind TEXT, file_rel TEXT, line INTEGER, end_line INTEGER, signature TEXT)",
    );
    const insert = conn.prepare(
      "INSERT INTO symbols (name, kind, file_rel, line, end_line, signature) " +
        "VALUES (@name, @kind, @file_rel, @line, @end_line, @signature)",
    );
    const insertMany = conn.transaction((rs: Array<Record<string, unknown>>) => {
      for (const r of rs) {
        insert.run({
          name: r.name,
          kind: r.kind,
          file_rel: r.file_rel,
          line: r.line,
          end_line: r.end_line ?? null,
          signature: r.signature,
        });
      }
    });
    insertMany(rows);
    try {
      return conn.prepare(sql).all(...params) as Array<Record<string, unknown>>;
    } finally {
      conn.close();
    }
  });
}

describe("symbol --file scope", () => {
  it("test_symbol_with_file_scope_filters_to_file", async () => {
    _installQuery(_rowsIn("src/auth/service.py", "src/admin/service.py"));
    const r = await invoke(["symbol", "MyClass", "auth/service.py"]);
    expect(r.exit_code).toBe(0);
    expect(r.stdout).toContain("src/auth/service.py");
    expect(r.stdout).not.toContain("src/admin/service.py");
  });

  it("test_symbol_with_file_scope_partial_path_match", async () => {
    _installQuery(_rowsIn("src/auth/service.py"));
    const r = await invoke(["symbol", "MyClass", "auth/service.py"]);
    expect(r.exit_code).toBe(0);
    expect(r.stdout).toContain("src/auth/service.py");
  });

  it("test_symbol_with_file_scope_no_match — exits 1, suppresses Did you mean", async () => {
    _installQuery(_rowsIn("src/admin/service.py"));
    const r = await invoke(["symbol", "MyClass", "billing/service.py"]);
    expect(r.exit_code).toBe(1);
    expect(r.stdout).toContain("MyClass");
    expect(r.stdout).toContain("billing/service.py");
    // The cross-file close-match suggestion must be suppressed under a file scope.
    expect(r.stdout).not.toContain("Did you mean");
  });

  it("test_symbol_without_file_scope_searches_all", async () => {
    _installQuery(_rowsIn("src/auth/service.py", "src/admin/service.py"));
    const r = await invoke(["symbol", "MyClass"]);
    expect(r.exit_code).toBe(0);
    expect(r.stdout).toContain("src/auth/service.py");
    expect(r.stdout).toContain("src/admin/service.py");
  });

  it("test_symbol_file_scope_json_output", async () => {
    _installQuery(_rowsIn("src/auth/service.py", "src/admin/service.py"));
    const r = await invoke(["symbol", "MyClass", "auth/service.py", "--json"]);
    expect(r.exit_code).toBe(0);
    const payload = JSON.parse(r.stdout);
    expect(payload.total).toBe(1);
    expect(payload.results[0].file).toBe("src/auth/service.py");
  });

  it("test_symbol_file_scope_json_no_match_exits_one", async () => {
    _installQuery(_rowsIn("src/admin/service.py"));
    const r = await invoke(["symbol", "MyClass", "billing/service.py", "--json"]);
    expect(r.exit_code).toBe(1);
    const payload = JSON.parse(r.stdout);
    expect(payload.total).toBe(0);
    expect(payload.results).toEqual([]);
  });

  it("test_symbol_file_scope_sql_not_limit_truncated — file scope pushed into SQL", async () => {
    // Three real files each define class Widget. Scoping to file_b.py with
    // --limit 1 must still return file_b.py. Uses the genuine indexed-DB query
    // path (not a mock) so the filter-before-LIMIT ordering is exercised for real.
    const base = fs.mkdtempSync(path.join(os.tmpdir(), `tg-sfs-${process.pid}-`));
    _tmpRoots.push(base);
    const root = fs.realpathSync(base);
    const projRoot = path.join(root, "widgets");
    fs.mkdirSync(path.join(projRoot, ".git"), { recursive: true });
    for (const fname of ["file_a.py", "file_b.py", "file_c.py"]) {
      fs.writeFileSync(path.join(projRoot, fname), "class Widget:\n    pass\n", "utf-8");
    }
    const proj = make_project_at(projRoot);
    await index_project(proj, { full: true });

    _savedCwd = process.cwd();
    process.chdir(projRoot);
    vi.spyOn(cliLookup, "_require_project").mockResolvedValue(proj);

    const r = await invoke(["symbol", "Widget", "file_b.py", "--limit", "1"]);
    expect(r.exit_code).toBe(0);
    expect(r.stdout).toContain("file_b.py");
    expect(r.stdout).not.toContain("file_a.py");
    expect(r.stdout).not.toContain("file_c.py");
  });
});
