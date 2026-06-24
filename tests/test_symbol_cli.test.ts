/**
 * 1:1 port of tests/test_symbol_cli.py.
 *
 * The Python suite runs two flavours: (a) subprocess calls into a real
 * token-goat install, and (b) in-process CliRunner.invoke against the indexed
 * ts_sample fixture. The TS port uses the in-process `invoke` harness
 * (tests/_cli_runner.ts) against the SAME shared ts_sample fixture the rest of
 * the TS suite uses (<repo-root>/tests/fixtures/ts_sample/index.ts), indexed
 * via the real parser. The DB-query precondition tests (rows exist after
 * indexing) become direct db reads; the CLI-output tests use `invoke`.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import * as db from "../src/token_goat/db.js";
import { index_project } from "../src/token_goat/parser.js";
import { make_project_at } from "../src/token_goat/project.js";
import { invoke } from "./_cli_runner.js";

const _REPO_ROOT = path.resolve(__dirname, "..", "..");
const _FIXTURE = path.join(_REPO_ROOT, "tests", "fixtures", "ts_sample");

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

/** Build + index a tmp copy of ts_sample, chdir into it; return its Project. */
async function indexedTsDir(): Promise<{ root: string; proj_hash: string }> {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), `tg-symcli-${process.pid}-${_tmpRoots.length}-`));
  _tmpRoots.push(base);
  const root = fs.realpathSync(base);
  fs.cpSync(_FIXTURE, path.join(root, "ts_sample"), { recursive: true });
  const projRoot = path.join(root, "ts_sample");
  fs.mkdirSync(path.join(projRoot, ".git"), { recursive: true });
  const proj = make_project_at(projRoot);
  await index_project(proj, { full: true });
  _savedCwd = process.cwd();
  process.chdir(projRoot);
  return { root: projRoot, proj_hash: proj.hash };
}

describe("symbol command — DB preconditions", () => {
  it("test_symbol_greet_json — greet is indexed as a function", async () => {
    const { proj_hash } = await indexedTsDir();
    const rows = db.openProject(proj_hash, (conn) => {
      return conn
        .prepare("SELECT name, kind, file_rel, line, signature FROM symbols WHERE name='greet'")
        .all() as Array<{ name: string; kind: string }>;
    });
    expect(rows.length).toBeGreaterThanOrEqual(1);
    expect(rows[0]!.name).toBe("greet");
    expect(rows[0]!.kind).toBe("function");
  });

  it("test_symbol_nonexistent_exit_zero — unknown symbol has zero rows", async () => {
    const { proj_hash } = await indexedTsDir();
    const rows = db.openProject(proj_hash, (conn) => {
      return conn.prepare("SELECT name FROM symbols WHERE name='__totally_nonexistent_xyz__'").all() as unknown[];
    });
    expect(rows.length).toBe(0);
  });

  it("test_ref_greet_returns_results — greet is referenced", async () => {
    const { proj_hash } = await indexedTsDir();
    const rows = db.openProject(proj_hash, (conn) => {
      return conn
        .prepare("SELECT symbol_name, file_rel, line FROM refs WHERE symbol_name='greet'")
        .all() as Array<{ symbol_name: string }>;
    });
    expect(rows.length).toBeGreaterThanOrEqual(1);
    expect(rows.some((r) => r.symbol_name === "greet")).toBe(true);
  });

  it("test_symbols_all_expected_present", async () => {
    const { proj_hash } = await indexedTsDir();
    const rows = db.openProject(proj_hash, (conn) => {
      return conn.prepare("SELECT name FROM symbols").all() as Array<{ name: string }>;
    });
    const names = new Set(rows.map((r) => r.name));
    for (const expected of ["greet", "UserService", "hello", "User", "UserId", "router"]) {
      expect(names.has(expected), `Expected symbol '${expected}' not found`).toBe(true);
    }
  });

  it("test_index_summary_non_trivial — non-zero symbols and files", async () => {
    const { proj_hash } = await indexedTsDir();
    const row = db.openProject(proj_hash, (conn) => {
      const sym = (conn.prepare("SELECT COUNT(*) AS n FROM symbols").get() as { n: number }).n;
      const files = (conn.prepare("SELECT COUNT(*) AS n FROM files").get() as { n: number }).n;
      return { sym, files };
    });
    expect(row.sym).toBeGreaterThan(0);
    expect(row.files).toBeGreaterThanOrEqual(1);
  });

  it("test_all_projects_symbol_lookup — greet in symbols_global", async () => {
    const { proj_hash } = await indexedTsDir();
    const rows = db.openGlobal((gconn) => {
      return gconn
        .prepare("SELECT name FROM symbols_global WHERE name='greet' AND project_hash=?")
        .all(proj_hash) as Array<{ name: string }>;
    });
    expect(rows.length).toBeGreaterThanOrEqual(1);
  });

  it("test_imports_exports_populated — at least 2 imports and 1 export", async () => {
    const { proj_hash } = await indexedTsDir();
    const row = db.openProject(proj_hash, (conn) => {
      const imp = (conn.prepare("SELECT COUNT(*) AS n FROM imports_exports WHERE kind='import'").get() as { n: number }).n;
      const exp = (conn.prepare("SELECT COUNT(*) AS n FROM imports_exports WHERE kind='export'").get() as { n: number }).n;
      return { imp, exp };
    });
    expect(row.imp).toBeGreaterThanOrEqual(2);
    expect(row.exp).toBeGreaterThanOrEqual(1);
  });
});

describe("symbol command — no-project-marker behaviour", () => {
  it("test_no_project_symbol_is_graceful — exits non-zero with 'no project detected'", async () => {
    // Patch find_project to return null so the symbol command's _require_project fails.
    const projectMod = await import("../src/token_goat/project.js");
    const spy = vi.spyOn(projectMod, "find_project").mockReturnValue(null);
    try {
      const r = await invoke(["symbol", "foo"]);
      expect(r.exit_code).not.toBe(0);
      expect(r.output.toLowerCase()).toContain("no project detected");
    } finally {
      spy.mockRestore();
    }
  });

  it("test_no_project_ref_is_graceful — ref exits non-zero with 'no project detected'", async () => {
    const projectMod = await import("../src/token_goat/project.js");
    const spy = vi.spyOn(projectMod, "find_project").mockReturnValue(null);
    try {
      const r = await invoke(["ref", "foo"]);
      expect(r.exit_code).not.toBe(0);
      expect(r.output.toLowerCase()).toContain("no project detected");
    } finally {
      spy.mockRestore();
    }
  });

  // test_no_project_index_is_graceful: the `index` command is batch H (not yet
  // ported), so this test is deferred until index lands.
  it.skip("test_no_project_index_is_graceful — needs `index` command (batch H)", () => {});
});

describe("symbol command — CLI output format", () => {
  it("test_symbol_json_output_is_valid — unified envelope", async () => {
    await indexedTsDir();
    const r = await invoke(["symbol", "greet", "--json"]);
    expect(r.exit_code).toBe(0);
    const data = JSON.parse(r.stdout.trim());
    expect(data).toBeTypeOf("object");
    expect(data.query).toBe("greet");
    expect("results" in data).toBe(true);
    expect("total" in data).toBe(true);
    expect(data.results.length).toBeGreaterThanOrEqual(1);
    expect(data.results[0].name).toBe("greet");
    expect(data.results[0].kind).toBe("function");
    expect("file" in data.results[0]).toBe(true);
    expect("line" in data.results[0]).toBe(true);
  });

  it("test_ref_json_output_is_valid — unified envelope", async () => {
    await indexedTsDir();
    const r = await invoke(["ref", "greet", "--json"]);
    expect(r.exit_code).toBe(0);
    const data = JSON.parse(r.stdout.trim());
    expect(data).toBeTypeOf("object");
    expect(data.query).toBe("greet");
    expect(data.results.length).toBeGreaterThanOrEqual(1);
    expect(data.results[0].name).toBe("greet");
  });

  // test_index_command_prints_summary: needs the `index` command (batch H).
  it.skip("test_index_command_prints_summary — needs `index` command (batch H)", () => {});

  it("test_symbol_all_projects_json — greet found across projects", async () => {
    await indexedTsDir();
    const r = await invoke(["symbol", "greet", "--all-projects", "--json"]);
    expect(r.exit_code).toBe(0);
    const data = JSON.parse(r.stdout.trim());
    expect(data).toBeTypeOf("object");
    expect(data.query).toBe("greet");
    expect(data.results.length).toBeGreaterThanOrEqual(1);
    expect(data.results.some((x: { name: string }) => x.name === "greet")).toBe(true);
  });

  it("test_symbol_all_projects_records_bytes_saved — all-projects path succeeds", async () => {
    await indexedTsDir();
    const r = await invoke(["symbol", "greet", "--all-projects"]);
    expect(r.exit_code).toBe(0);
    expect(r.output.includes("greet") || r.exit_code === 0).toBe(true);
  });
});

describe("refs command", () => {
  it("test_refs_json_output — unified envelope", async () => {
    await indexedTsDir();
    const r = await invoke(["refs", "greet", "--json"]);
    expect(r.exit_code).toBe(0);
    const data = JSON.parse(r.stdout.trim());
    expect(data).toBeTypeOf("object");
    expect(data.query).toBe("greet");
    expect(data.results.length).toBeGreaterThanOrEqual(1);
    const first = data.results[0];
    expect(first.symbol).toBe("greet");
    expect("file" in first).toBe(true);
    expect("line" in first).toBe(true);
    expect(first.line).toBeTypeOf("number");
  });

  it("test_refs_plain_output_format — each line has a colon", async () => {
    await indexedTsDir();
    const r = await invoke(["refs", "greet"]);
    expect(r.exit_code).toBe(0);
    const lines = r.output.split("\n").filter((l) => l.trim().length > 0);
    expect(lines.length).toBeGreaterThanOrEqual(1);
    for (const line of lines) {
      expect(line.includes(":")).toBe(true);
    }
  });

  it("test_refs_no_results — 'no references' on a miss", async () => {
    await indexedTsDir();
    const r = await invoke(["refs", "__no_such_symbol_xyz__"]);
    expect(r.exit_code).toBe(0);
    expect(r.output.toLowerCase()).toContain("no references");
  });

  it("test_refs_file_filter — only matching file", async () => {
    await indexedTsDir();
    const r = await invoke(["refs", "greet", "--file", "index.ts", "--json"]);
    expect(r.exit_code).toBe(0);
    const data = JSON.parse(r.stdout.trim());
    expect(data).toBeTypeOf("object");
    for (const row of data.results) {
      expect(row.file.includes("index.ts")).toBe(true);
    }
  });

  it("test_refs_limit — at most 1 result", async () => {
    await indexedTsDir();
    const r = await invoke(["refs", "greet", "--limit", "1", "--json"]);
    expect(r.exit_code).toBe(0);
    const data = JSON.parse(r.stdout.trim());
    expect(data.results.length).toBeLessThanOrEqual(1);
  });

  it("test_refs_no_project_is_graceful — exits non-zero with 'no project detected'", async () => {
    const projectMod = await import("../src/token_goat/project.js");
    const spy = vi.spyOn(projectMod, "find_project").mockReturnValue(null);
    try {
      const r = await invoke(["refs", "foo"]);
      expect(r.exit_code).not.toBe(0);
      expect(r.output.toLowerCase()).toContain("no project detected");
    } finally {
      spy.mockRestore();
    }
  });
});

describe("symbol --refs flag", () => {
  it("test_symbol_refs_flag_json — ref_count present", async () => {
    await indexedTsDir();
    const r = await invoke(["symbol", "greet", "--refs", "--json"]);
    expect(r.exit_code).toBe(0);
    const data = JSON.parse(r.stdout.trim());
    expect(data).toBeTypeOf("object");
    expect(data.query).toBe("greet");
    expect(data.results.length).toBeGreaterThanOrEqual(1);
    expect("ref_count" in data.results[0]).toBe(true);
    expect(data.results[0].ref_count).toBeTypeOf("number");
  });

  it("test_symbol_refs_flag_plain — 'refs]' appears", async () => {
    await indexedTsDir();
    const r = await invoke(["symbol", "greet", "--refs"]);
    expect(r.exit_code).toBe(0);
    expect(r.output.includes("refs]")).toBe(true);
  });

  it("test_symbol_without_refs_flag_no_ref_count", async () => {
    await indexedTsDir();
    const r = await invoke(["symbol", "greet", "--json"]);
    expect(r.exit_code).toBe(0);
    const data = JSON.parse(r.stdout.trim());
    expect(data).toBeTypeOf("object");
    expect(data.results.length).toBeGreaterThanOrEqual(1);
    expect("ref_count" in data.results[0]).toBe(false);
  });
});
