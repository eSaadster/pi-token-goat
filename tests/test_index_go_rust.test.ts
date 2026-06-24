/**
 * Integration tests for Go and Rust index pipeline.
 *
 * Faithful 1:1 port of tests/test_index_go_rust.py. Strict NodeNext ESM.
 *
 * Port model (mirrors test_index_pipeline.test.ts):
 *  - Python's `go_project` / `rust_project` fixtures copy a sample tree (with
 *    tmp_data_dir + make_project) and the tests index it. The TS port copies the
 *    shared fixture tree to a tmp dir via cpSync, adds a minimal .git so
 *    find_project treats it as a project, and builds the Project with
 *    make_project_at — exactly the pipeline test's makeSampleProject.
 *  - `index_project` is async in TS (dynamic adapter import); tests await it. The
 *    go / rust grammar adapters ARE ported, so index_file returns a real
 *    FileIndex and the symbols/imports/global-registry rows are written.
 *  - db.open_project / db.open_global -> db.openProjectReadonly /
 *    db.openGlobalReadonly (the shipped callback openers). `conn.execute(sql)`
 *    row iteration -> `conn.prepare(sql).all()`; row["col"] access is identical.
 */
import { describe, expect, it } from "vitest";
import { afterEach } from "vitest";

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type { Database as DatabaseType } from "better-sqlite3";

import * as db from "../src/token_goat/db.js";
import { index_project } from "../src/token_goat/parser.js";
import { make_project_at } from "../src/token_goat/project.js";
import type { Project } from "../src/token_goat/project.js";

const FIXTURE_DIR = path.resolve(__dirname, "..", "..", "tests", "fixtures");
const GO_SAMPLE = "go_sample";
const RUST_SAMPLE = "rust_sample";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const _tmpRoots: string[] = [];

function tmpPath(): string {
  const dir = fs.mkdtempSync(
    path.join(os.tmpdir(), `tg-gorust-${process.pid}-${_tmpRoots.length}-`),
  );
  _tmpRoots.push(dir);
  return dir;
}

afterEach(() => {
  while (_tmpRoots.length) {
    const d = _tmpRoots.pop()!;
    try {
      fs.rmSync(d, { recursive: true, force: true });
    } catch {
      // best-effort
    }
  }
});

/** Copy a fixture sample to a tmp dir; return the Project (Python make_project). */
function makeSampleProject(sampleName: string): Project {
  const base = tmpPath();
  const projRoot = path.join(base, sampleName);
  fs.cpSync(path.join(FIXTURE_DIR, sampleName), projRoot, { recursive: true });
  // Minimal .git dir so find_project detects this as a project.
  fs.mkdirSync(path.join(projRoot, ".git"), { recursive: true });
  return make_project_at(projRoot);
}

// ===========================================================================
// Go project indexing
// ===========================================================================

describe("Go project indexing", () => {
  it("test_go_index_runs", async () => {
    const go_project = makeSampleProject(GO_SAMPLE);
    const summary = await index_project(go_project, { full: true });
    expect(summary.total_files).toBeGreaterThanOrEqual(1);
    expect(summary.indexed).toBeGreaterThanOrEqual(1);
    expect(summary.errors).toBe(0);
    expect(summary.languages).toContain("go");
  });

  it("test_go_index_populates_symbols", async () => {
    const go_project = makeSampleProject(GO_SAMPLE);
    await index_project(go_project, { full: true });
    const names = db.openProjectReadonly(go_project.hash, (conn: DatabaseType) => {
      const rows = conn.prepare("SELECT name FROM symbols").all() as Array<{ name: string }>;
      return new Set(rows.map((r) => r.name));
    });
    expect(names.has("main")).toBe(true);
    expect(names.has("NewServer")).toBe(true);
    expect(names.has("Server")).toBe(true);
  });

  it("test_go_index_populates_imports", async () => {
    const go_project = makeSampleProject(GO_SAMPLE);
    await index_project(go_project, { full: true });
    const targets = db.openProjectReadonly(go_project.hash, (conn: DatabaseType) => {
      const rows = conn
        .prepare("SELECT target FROM imports_exports WHERE kind='import'")
        .all() as Array<{ target: string }>;
      return new Set(rows.map((r) => r.target));
    });
    expect(targets.has("fmt")).toBe(true);
    expect(targets.has("errors")).toBe(true);
  });

  it("test_go_index_symbol_kinds", async () => {
    const go_project = makeSampleProject(GO_SAMPLE);
    await index_project(go_project, { full: true });
    const kind_by_name = db.openProjectReadonly(go_project.hash, (conn: DatabaseType) => {
      const rows = conn.prepare("SELECT name, kind FROM symbols").all() as Array<{
        name: string;
        kind: string;
      }>;
      const m = new Map<string, string>();
      for (const r of rows) {
        m.set(r.name, r.kind);
      }
      return m;
    });
    expect(kind_by_name.get("Server")).toBe("type");
    expect(kind_by_name.get("Handler")).toBe("interface");
    expect(kind_by_name.get("Version")).toBe("const");
    expect(kind_by_name.get("defaultPort")).toBe("var");
    expect(kind_by_name.get("NewServer")).toBe("function");
    expect(kind_by_name.get("Run")).toBe("method");
  });

  it("test_go_index_updates_global_registry", async () => {
    const go_project = makeSampleProject(GO_SAMPLE);
    await index_project(go_project, { full: true });
    const row = db.openGlobalReadonly((gconn: DatabaseType) =>
      gconn.prepare("SELECT * FROM projects WHERE hash=?").get(go_project.hash) as
        | { languages: string }
        | undefined,
    );
    expect(row).not.toBeUndefined();
    expect(row!.languages).toContain("go");
  });
});

// ===========================================================================
// Rust project indexing
// ===========================================================================

describe("Rust project indexing", () => {
  it("test_rust_index_runs", async () => {
    const rust_project = makeSampleProject(RUST_SAMPLE);
    const summary = await index_project(rust_project, { full: true });
    expect(summary.total_files).toBeGreaterThanOrEqual(1);
    expect(summary.indexed).toBeGreaterThanOrEqual(1);
    expect(summary.errors).toBe(0);
    expect(summary.languages).toContain("rust");
  });

  it("test_rust_index_populates_symbols", async () => {
    const rust_project = makeSampleProject(RUST_SAMPLE);
    await index_project(rust_project, { full: true });
    const names = db.openProjectReadonly(rust_project.hash, (conn: DatabaseType) => {
      const rows = conn.prepare("SELECT name FROM symbols").all() as Array<{ name: string }>;
      return new Set(rows.map((r) => r.name));
    });
    expect(names.has("main")).toBe(true);
    expect(names.has("Server")).toBe(true);
    expect(names.has("new")).toBe(true);
    expect(names.has("run")).toBe(true);
  });

  it("test_rust_index_populates_imports", async () => {
    const rust_project = makeSampleProject(RUST_SAMPLE);
    await index_project(rust_project, { full: true });
    const targets = db.openProjectReadonly(rust_project.hash, (conn: DatabaseType) => {
      const rows = conn
        .prepare("SELECT target FROM imports_exports WHERE kind='import'")
        .all() as Array<{ target: string }>;
      return new Set(rows.map((r) => r.target));
    });
    expect([...targets].some((t) => t.includes("HashMap"))).toBe(true);
    expect([...targets].some((t) => t.includes("fmt"))).toBe(true);
  });

  it("test_rust_index_symbol_kinds", async () => {
    const rust_project = makeSampleProject(RUST_SAMPLE);
    await index_project(rust_project, { full: true });
    const kind_by_name = db.openProjectReadonly(rust_project.hash, (conn: DatabaseType) => {
      const rows = conn.prepare("SELECT name, kind FROM symbols").all() as Array<{
        name: string;
        kind: string;
      }>;
      const m = new Map<string, string[]>();
      for (const r of rows) {
        if (!m.has(r.name)) {
          m.set(r.name, []);
        }
        m.get(r.name)!.push(r.kind);
      }
      return m;
    });
    expect(kind_by_name.get("Server") ?? []).toContain("type");
    expect(kind_by_name.get("Handler") ?? []).toContain("interface");
    expect(kind_by_name.get("Error") ?? []).toContain("enum");
    expect(kind_by_name.get("VERSION") ?? []).toContain("const");
    expect(kind_by_name.get("new") ?? []).toContain("method");
    expect(kind_by_name.get("run") ?? []).toContain("method");
  });

  it("test_rust_index_updates_global_registry", async () => {
    const rust_project = makeSampleProject(RUST_SAMPLE);
    await index_project(rust_project, { full: true });
    const row = db.openGlobalReadonly((gconn: DatabaseType) =>
      gconn.prepare("SELECT * FROM projects WHERE hash=?").get(rust_project.hash) as
        | { languages: string }
        | undefined,
    );
    expect(row).not.toBeUndefined();
    expect(row!.languages).toContain("rust");
  });

  it("test_rust_index_trait_methods", async () => {
    const rust_project = makeSampleProject(RUST_SAMPLE);
    await index_project(rust_project, { full: true });
    const rows = db.openProjectReadonly(rust_project.hash, (conn: DatabaseType) =>
      conn.prepare("SELECT name, kind FROM symbols WHERE name='serve'").all() as Array<{
        name: string;
        kind: string;
      }>,
    );
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.some((r) => r.kind === "method")).toBe(true);
  });

  it("test_rust_index_static", async () => {
    const rust_project = makeSampleProject(RUST_SAMPLE);
    await index_project(rust_project, { full: true });
    const rows = db.openProjectReadonly(rust_project.hash, (conn: DatabaseType) =>
      conn
        .prepare("SELECT name, kind FROM symbols WHERE name='MAX_CONNECTIONS'")
        .all() as Array<{ name: string; kind: string }>,
    );
    expect(rows.length).toBeGreaterThan(0);
    expect(rows[0]!.kind).toBe("const");
  });
});
