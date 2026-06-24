/**
 * Unit tests for token_goat/read_replacement — 1:1 port of
 * tests/test_read_replacement.py.
 *
 * Each Python `def test_*` maps to a vitest `it()` with the same name and the
 * same assertion polarity. Tests that exercise the CLI (typer.testing.CliRunner),
 * read_commands, the parser's index_project, or the session result-cache are
 * SKIPPED with `it.skip(...)` and a "// PORT: deferred" comment, because those
 * modules are not yet ported at this layer. They are retained so the parity
 * surface stays visible and can be re-enabled when those layers land.
 *
 * Indexing seam: the Python suite builds an indexed project DB by calling
 * `token_goat.parser.index_project(proj, full=True)` (tree-sitter). parser.ts
 * is a later layer, so here we build the equivalent index rows directly through
 * the shipped db.ts API (db.openProject + INSERT into files/symbols/sections/
 * refs), exactly as tests/test_db.test.ts builds its symbol tables. The row
 * shapes (line, end_line, kind, heading, level) mirror what the real indexer
 * emits for each fixture so the line-number assertions in the Python tests hold.
 *
 * Per-test tmp data dir + cache clearing is handled by tests/setup.ts
 * (beforeEach → setDataDirOverride + clearModuleCaches), mirroring the Python
 * tmp_data_dir autouse fixture.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type { Database as DatabaseType } from "better-sqlite3";

import * as read_replacement from "../src/token_goat/read_replacement.js";
import * as db from "../src/token_goat/db.js";
import { canonicalize, project_hash, make_project_at } from "../src/token_goat/project.js";
import type { Project } from "../src/token_goat/project.js";

// ---------------------------------------------------------------------------
// Helpers: build a Project + manually index it through the db.ts API.
// ---------------------------------------------------------------------------

/** Build a Project from a root directory (conftest make_project_from_root). */
function makeProject(root: string): Project {
  const canon = canonicalize(root);
  return { root: canon, hash: project_hash(canon), marker: ".git" };
}

/** Unique tmp dir under the OS tmp root (conftest tmp_path analogue). */
let _tmpCounter = 0;
const _tmpRoots: string[] = [];
function tmpPath(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `tg-rr-${process.pid}-${_tmpCounter++}-`));
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

interface FileRow {
  rel_path: string;
  language?: string;
}
interface SymRow {
  name: string;
  kind: string;
  file_rel: string;
  line: number;
  end_line: number | null;
  signature?: string | null;
  col?: number;
}
interface SecRow {
  file_rel: string;
  heading: string;
  level: number;
  line: number;
  end_line: number | null;
}
interface RefRow {
  symbol_name: string;
  file_rel: string;
  line: number;
}

/** Insert index rows into the per-project DB (the parser.index_project seam). */
function indexRows(
  proj: Project,
  files: FileRow[],
  symbols: SymRow[],
  sections: SecRow[] = [],
  refs: RefRow[] = [],
): void {
  db.openProject(proj.hash, (conn: DatabaseType) => {
    const insertFile = conn.prepare(
      "INSERT OR REPLACE INTO files (rel_path, language, size, line_count, mtime, content_sha256, indexed_at) VALUES (?, ?, 1, 1, 0.0, '', 0)",
    );
    for (const f of files) {
      insertFile.run(f.rel_path, f.language ?? "python");
    }
    const insertSym = conn.prepare(
      "INSERT INTO symbols (name, kind, file_rel, line, col, end_line, signature) VALUES (?, ?, ?, ?, ?, ?, ?)",
    );
    for (const s of symbols) {
      insertSym.run(
        s.name,
        s.kind,
        s.file_rel,
        s.line,
        s.col ?? 0,
        s.end_line,
        s.signature ?? null,
      );
    }
    const insertSec = conn.prepare(
      "INSERT INTO sections (file_rel, heading, level, line, end_line) VALUES (?, ?, ?, ?, ?)",
    );
    for (const sec of sections) {
      insertSec.run(sec.file_rel, sec.heading, sec.level, sec.line, sec.end_line);
    }
    const insertRef = conn.prepare(
      "INSERT INTO refs (symbol_name, file_rel, line, col) VALUES (?, ?, ?, 0)",
    );
    for (const r of refs) {
      insertRef.run(r.symbol_name, r.file_rel, r.line);
    }
  });
}

const TS_INDEX_SRC =
  "import { join } from 'node:path';\n" +
  "import express from 'express';\n" +
  "\n" +
  "export function greet(name: string): string {\n" +
  "  return `hello, ${name}`;\n" +
  "}\n" +
  "\n" +
  "export class UserService {\n" +
  "  constructor(private name: string) {}\n" +
  "  hello(): string {\n" +
  "    return greet(this.name);\n" +
  "  }\n" +
  "}\n" +
  "\n" +
  "export interface User {\n" +
  "  id: number;\n" +
  "  name: string;\n" +
  "}\n" +
  "\n" +
  "export type UserId = number;\n" +
  "\n" +
  "const PORT = 3000;\n" +
  "export const router = express();\n";

const PY_APP_SRC =
  "import os\n" +
  "from pathlib import Path\n" +
  "\n" +
  'DEFAULT_PORT = int(os.getenv("PORT", "8080"))\n' +
  "BASE_DIR = Path(__file__).parent\n" +
  "\n" +
  "\n" +
  "def greet(name: str) -> str:\n" +
  '    return f"hello, {name}"\n' +
  "\n" +
  "\n" +
  "class UserService:\n" +
  "    def __init__(self, name: str) -> None:\n" +
  "        self.name = name\n" +
  "\n" +
  "    def hello(self) -> str:\n" +
  "        return greet(self.name)\n";

const MD_ARTICLE_SRC =
  "---\n" +
  "title: Test Article\n" +
  "date: 2026-01-01\n" +
  "---\n" +
  "\n" +
  "# Top Level\n" +
  "\n" +
  "Some content.\n" +
  "\n" +
  "## Methodology\n" +
  "\n" +
  "How we did it.\n" +
  "\n" +
  "### Subsection\n" +
  "\n" +
  "Details.\n" +
  "\n" +
  "## Results\n" +
  "\n" +
  "What we found.\n";

/** Build + index the ts_sample project (index.ts). */
function makeTsProject(): [string, Project] {
  const root = tmpPath();
  fs.mkdirSync(path.join(root, ".git"), { recursive: true });
  fs.writeFileSync(path.join(root, "index.ts"), TS_INDEX_SRC, "utf8");
  const proj = makeProject(root);
  indexRows(
    proj,
    [{ rel_path: "index.ts", language: "typescript" }],
    [
      { name: "greet", kind: "function", file_rel: "index.ts", line: 4, end_line: 6, signature: "function greet(name: string): string" },
      { name: "UserService", kind: "class", file_rel: "index.ts", line: 8, end_line: 13 },
      { name: "hello", kind: "method", file_rel: "index.ts", line: 10, end_line: 12 },
      { name: "User", kind: "interface", file_rel: "index.ts", line: 15, end_line: 18 },
      { name: "UserId", kind: "type", file_rel: "index.ts", line: 20, end_line: 20 },
      { name: "PORT", kind: "const", file_rel: "index.ts", line: 22, end_line: 22 },
      { name: "router", kind: "const", file_rel: "index.ts", line: 23, end_line: 23 },
    ],
    [],
    // greet is called inside UserService.hello at line 11; router calls express().
    [{ symbol_name: "greet", file_rel: "index.ts", line: 11 }],
  );
  return [proj.root, proj];
}

/** Build + index the py_sample project (app.py). */
function makePyProject(): [string, Project] {
  const root = tmpPath();
  fs.mkdirSync(path.join(root, ".git"), { recursive: true });
  fs.writeFileSync(path.join(root, "app.py"), PY_APP_SRC, "utf8");
  const proj = makeProject(root);
  indexRows(
    proj,
    [{ rel_path: "app.py", language: "python" }],
    [
      { name: "DEFAULT_PORT", kind: "var", file_rel: "app.py", line: 4, end_line: 4 },
      { name: "BASE_DIR", kind: "var", file_rel: "app.py", line: 5, end_line: 5 },
      { name: "greet", kind: "function", file_rel: "app.py", line: 8, end_line: 9 },
      { name: "UserService", kind: "class", file_rel: "app.py", line: 12, end_line: 17 },
      { name: "__init__", kind: "method", file_rel: "app.py", line: 13, end_line: 14 },
      { name: "hello", kind: "method", file_rel: "app.py", line: 16, end_line: 17 },
    ],
  );
  return [proj.root, proj];
}

/** Build + index the md_sample project (article.md). */
function makeMdProject(): [string, Project] {
  const root = tmpPath();
  fs.mkdirSync(path.join(root, ".git"), { recursive: true });
  fs.writeFileSync(path.join(root, "article.md"), MD_ARTICLE_SRC, "utf8");
  const proj = makeProject(root);
  indexRows(
    proj,
    [{ rel_path: "article.md", language: "markdown" }],
    [],
    [
      { file_rel: "article.md", heading: "Top Level", level: 1, line: 6, end_line: 9 },
      { file_rel: "article.md", heading: "Methodology", level: 2, line: 10, end_line: 13 },
      { file_rel: "article.md", heading: "Subsection", level: 3, line: 14, end_line: 17 },
      { file_rel: "article.md", heading: "Results", level: 2, line: 18, end_line: 20 },
    ],
  );
  return [proj.root, proj];
}

/** Build + index an ambiguous project: a/<rel> and b/<rel> (with sections). */
function makeAmbiguousProject(
  relName: string,
  contentA: string,
  contentB: string,
  sectionsA: SecRow[] = [],
  sectionsB: SecRow[] = [],
): [string, Project] {
  const root = tmpPath();
  fs.mkdirSync(path.join(root, "a"), { recursive: true });
  fs.mkdirSync(path.join(root, "b"), { recursive: true });
  fs.writeFileSync(path.join(root, "a", relName), contentA, "utf8");
  fs.writeFileSync(path.join(root, "b", relName), contentB, "utf8");
  const proj = makeProject(root);
  indexRows(
    proj,
    [
      { rel_path: `a/${relName}` },
      { rel_path: `b/${relName}` },
    ],
    [],
    [...sectionsA, ...sectionsB],
  );
  return [proj.root, proj];
}

// ===========================================================================
// resolve_file_rel tests
// ===========================================================================

describe("token_goat.read_replacement (port of tests/test_read_replacement.py)", () => {
  it("test_resolve_exact_match", () => {
    const [, proj] = makeTsProject();
    const rel = read_replacement.resolve_file_rel(proj, "index.ts");
    expect(rel).toBe("index.ts");
  });

  it("test_resolve_bare_filename", () => {
    const [, proj] = makeTsProject();
    const rel = read_replacement.resolve_file_rel(proj, "index.ts");
    expect(rel).not.toBeNull();
    expect(rel!.endsWith("index.ts")).toBe(true);
  });

  it("test_resolve_absolute_path", () => {
    const [proj_root, proj] = makeTsProject();
    const abs_path = path.join(proj_root, "index.ts");
    const rel = read_replacement.resolve_file_rel(proj, abs_path);
    expect(rel).toBe("index.ts");
  });

  it("test_resolve_garbage_returns_none", () => {
    const [, proj] = makeTsProject();
    const rel = read_replacement.resolve_file_rel(proj, "totally_nonexistent_xyz_abc.ts");
    expect(rel).toBeNull();
  });

  it("test_resolve_ambiguous_bare_filename_raises", () => {
    const [, proj] = makeAmbiguousProject(
      "index.ts",
      "export const a = 1;\n",
      "export const b = 2;\n",
    );
    let caught: unknown;
    try {
      read_replacement.resolve_file_rel(proj, "index.ts");
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(read_replacement.AmbiguousFileMatch);
    const exc = caught as read_replacement.AmbiguousFileMatch;
    expect(exc.code).toBe("ambiguous_file");
    expect(exc.file_part).toBe("index.ts");
    expect(exc.candidates).toEqual(["a/index.ts", "b/index.ts"]);
  });

  it("test_resolve_bare_filename_with_literal_sql_like_chars", () => {
    const root = tmpPath();
    fs.mkdirSync(path.join(root, "src"), { recursive: true });
    fs.writeFileSync(path.join(root, "src", "a%file.ts"), "export const a = 1;\n", "utf8");
    fs.writeFileSync(path.join(root, "src", "afile.ts"), "export const b = 2;\n", "utf8");
    const proj = makeProject(root);
    indexRows(proj, [{ rel_path: "src/a%file.ts" }, { rel_path: "src/afile.ts" }], []);

    const rel = read_replacement.resolve_file_rel(proj, "a%file.ts");
    expect(rel).toBe("src/a%file.ts");
  });

  it.each([
    ["/etc/passwd"],
    ["C:\\Windows\\win.ini"],
    ["\\\\server\\share\\file.txt"],
    ["../escape.py"],
    ["..\\escape.py"],
  ])("test_safe_rel_path_rejects_absolute_and_traversal[%s]", (path_value) => {
    // _is_safe_rel_path now lives in token_goat.paths and is re-exported by
    // read_replacement; embeddings no longer owns its own copy.
    expect(read_replacement._is_safe_rel_path(path_value)).toBe(false);
  });

  // ===========================================================================
  // read_symbol tests
  // ===========================================================================

  it("test_read_symbol_greet_text", () => {
    const [, proj] = makeTsProject();
    const result = read_replacement.read_symbol(proj, "index.ts", "greet");
    expect(result).not.toBeNull();
    expect(result!.text).toContain("function greet");
    expect(result!.text).toContain("return");
  });

  it("test_read_symbol_greet_lines", () => {
    const [, proj] = makeTsProject();
    const result = read_replacement.read_symbol(proj, "index.ts", "greet");
    expect(result).not.toBeNull();
    // greet is on lines 4-6 per DB
    expect(result!.start_line).toBe(4);
    expect(result!.end_line).toBe(6);
  });

  it("test_read_symbol_nonexistent_returns_none", () => {
    const [, proj] = makeTsProject();
    const result = read_replacement.read_symbol(proj, "index.ts", "__totally_nonexistent__");
    expect(result).toBeNull();
  });

  it("test_read_symbol_context_lines", () => {
    const [, proj] = makeTsProject();
    const result_no_ctx = read_replacement.read_symbol(proj, "index.ts", "greet");
    const result_with_ctx = read_replacement.read_symbol(proj, "index.ts", "greet", {
      context_lines: 2,
    });
    expect(result_with_ctx).not.toBeNull();
    expect(result_with_ctx!.start_line).toBeLessThanOrEqual(result_no_ctx!.start_line);
    expect(result_with_ctx!.end_line).toBeGreaterThanOrEqual(result_no_ctx!.end_line);
    expect(result_with_ctx!.text.length).toBeGreaterThanOrEqual(result_no_ctx!.text.length);
  });

  it("test_read_symbol_userservice_class", () => {
    const [, proj] = makeTsProject();
    const result = read_replacement.read_symbol(proj, "index.ts", "UserService");
    expect(result).not.toBeNull();
    expect(result!.kind).toBe("class");
    expect(result!.text).toContain("UserService");
  });

  it("test_read_symbol_bytes_saved_positive", () => {
    const [, proj] = makeTsProject();
    const result = read_replacement.read_symbol(proj, "index.ts", "greet");
    expect(result).not.toBeNull();
    expect(result!.bytes_saved).toBeGreaterThan(0);
    expect(result!.bytes_total).toBeGreaterThan(result!.bytes_extracted);
  });

  it("test_read_symbol_result_fields", () => {
    const [, proj] = makeTsProject();
    const result = read_replacement.read_symbol(proj, "index.ts", "greet");
    expect(result).not.toBeNull();
    for (const key of [
      "file",
      "symbol",
      "kind",
      "start_line",
      "end_line",
      "text",
      "signature",
      "bytes_total",
      "bytes_extracted",
      "bytes_saved",
    ]) {
      expect(key in result!).toBe(true);
    }
  });

  // ===========================================================================
  // read_section tests
  // ===========================================================================

  it("test_read_section_methodology", () => {
    const [, proj] = makeMdProject();
    const result = read_replacement.read_section(proj, "article.md", "Methodology");
    expect(result).not.toBeNull();
    expect(result!.text).toContain("Methodology");
  });

  it("test_read_section_case_insensitive", () => {
    const [, proj] = makeMdProject();
    const result = read_replacement.read_section(proj, "article.md", "methodology");
    expect(result).not.toBeNull();
    expect(result!.text).toContain("Methodology");
  });

  it("test_read_section_nonexistent_returns_none", () => {
    const [, proj] = makeMdProject();
    const result = read_replacement.read_section(proj, "article.md", "Nonexistent Section XYZ");
    expect(result).toBeNull();
  });

  it("test_read_section_bytes_saved_positive", () => {
    const [, proj] = makeMdProject();
    const result = read_replacement.read_section(proj, "article.md", "Methodology");
    expect(result).not.toBeNull();
    expect(result!.bytes_saved).toBeGreaterThan(0);
  });

  it("test_read_section_result_fields", () => {
    const [, proj] = makeMdProject();
    const result = read_replacement.read_section(proj, "article.md", "Methodology");
    expect(result).not.toBeNull();
    for (const key of [
      "file",
      "heading",
      "level",
      "start_line",
      "end_line",
      "text",
      "bytes_total",
      "bytes_extracted",
      "bytes_saved",
    ]) {
      expect(key in result!).toBe(true);
    }
  });

  // ===========================================================================
  // Qualified Class.method symbol lookup
  // ===========================================================================

  /** Project with a free function and a class method that share a name. */
  function makeMethodCollisionProject(): [string, Project] {
    const root = tmpPath();
    fs.mkdirSync(path.join(root, ".git"), { recursive: true });
    fs.writeFileSync(
      path.join(root, "app.py"),
      "def hello() -> str:\n" +
        "    return 'free'\n" +
        "\n" +
        "\n" +
        "class Greeter:\n" +
        "    def hello(self) -> str:\n" +
        "        return 'method'\n",
      "utf8",
    );
    const proj = makeProject(root);
    indexRows(
      proj,
      [{ rel_path: "app.py" }],
      [
        { name: "hello", kind: "function", file_rel: "app.py", line: 1, end_line: 2 },
        { name: "Greeter", kind: "class", file_rel: "app.py", line: 5, end_line: 7 },
        { name: "hello", kind: "method", file_rel: "app.py", line: 6, end_line: 7 },
      ],
    );
    return [proj.root, proj];
  }

  it("test_read_symbol_qualified_picks_method", () => {
    const [, proj] = makeMethodCollisionProject();
    const result = read_replacement.read_symbol(proj, "app.py", "Greeter.hello");
    expect(result).not.toBeNull();
    expect(result!.kind).toBe("method");
    expect(result!.start_line).toBeGreaterThanOrEqual(6);
    expect(result!.text).toContain("method");
  });

  it("test_read_symbol_unqualified_falls_back_to_priority", () => {
    const [, proj] = makeMethodCollisionProject();
    const result = read_replacement.read_symbol(proj, "app.py", "hello");
    expect(result).not.toBeNull();
    // Free function ranks higher than method in _KIND_PRIORITY.
    expect(result!.kind).toBe("function");
    expect(result!.text).toContain("free");
  });

  it("test_read_symbol_qualified_wrong_class_falls_back", () => {
    const [, proj] = makeMethodCollisionProject();
    const result = read_replacement.read_symbol(proj, "app.py", "Nope.hello");
    expect(result).not.toBeNull();
    expect(result!.kind).toBe("function");
  });

  it("test_split_qualified_symbol_handles_bare_name", () => {
    const [qualifier, leaf] = read_replacement._split_qualified_symbol("hello");
    expect(qualifier).toBeNull();
    expect(leaf).toBe("hello");
  });

  it("test_split_qualified_symbol_handles_nested_qualifier", () => {
    const [qualifier, leaf] = read_replacement._split_qualified_symbol("Outer.Inner.method");
    expect(qualifier).toBe("Inner");
    expect(leaf).toBe("method");
  });

  // ===========================================================================
  // Section ordinal disambiguation (Heading#N)
  // ===========================================================================

  /** Doc with two ## Example headings to exercise ordinal selection. */
  function makeDuplicateSectionProject(): [string, Project] {
    const root = tmpPath();
    fs.mkdirSync(path.join(root, ".git"), { recursive: true });
    fs.writeFileSync(
      path.join(root, "doc.md"),
      "# Top\n" +
        "\n" +
        "## Example\n" +
        "\n" +
        "first example body\n" +
        "\n" +
        "## Other\n" +
        "\n" +
        "filler\n" +
        "\n" +
        "## Example\n" +
        "\n" +
        "second example body\n",
      "utf8",
    );
    const proj = makeProject(root);
    indexRows(
      proj,
      [{ rel_path: "doc.md" }],
      [],
      [
        { file_rel: "doc.md", heading: "Top", level: 1, line: 1, end_line: 13 },
        { file_rel: "doc.md", heading: "Example", level: 2, line: 3, end_line: 6 },
        { file_rel: "doc.md", heading: "Other", level: 2, line: 7, end_line: 10 },
        { file_rel: "doc.md", heading: "Example", level: 2, line: 11, end_line: 13 },
      ],
    );
    return [proj.root, proj];
  }

  it("test_read_section_duplicate_returns_first_with_warning", () => {
    const [, proj] = makeDuplicateSectionProject();
    const spy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const result = read_replacement.read_section(proj, "doc.md", "Example");
    const calls = spy.mock.calls.map((c) => String(c[0]));
    spy.mockRestore();
    expect(result).not.toBeNull();
    expect(result!.text).toContain("first example body");
    // A warning must explain how to pick the second occurrence.
    expect(calls.some((m) => m.includes("share heading"))).toBe(true);
  });

  it("test_read_section_ordinal_picks_nth", () => {
    const [, proj] = makeDuplicateSectionProject();
    const result = read_replacement.read_section(proj, "doc.md", "Example#2");
    expect(result).not.toBeNull();
    expect(result!.text).toContain("second example body");
  });

  it("test_read_section_ordinal_out_of_range_returns_none", () => {
    const [, proj] = makeDuplicateSectionProject();
    const result = read_replacement.read_section(proj, "doc.md", "Example#99");
    expect(result).toBeNull();
  });

  it("test_parse_section_ordinal_rejects_zero_and_negatives", () => {
    expect(read_replacement._parse_section_ordinal("Example#0")).toEqual(["Example#0", null]);
    expect(read_replacement._parse_section_ordinal("Example#-1")).toEqual(["Example#-1", null]);
  });

  it("test_parse_section_ordinal_rejects_nondigit_suffix", () => {
    expect(read_replacement._parse_section_ordinal("Foo#bar")).toEqual(["Foo#bar", null]);
  });

  it("test_parse_section_ordinal_empty_base_is_left_intact", () => {
    expect(read_replacement._parse_section_ordinal("#42")).toEqual(["#42", null]);
  });

  // ===========================================================================
  // CLI tests via typer.testing.CliRunner — deferred (cli/read_commands)
  // ===========================================================================

  it.skip("test_cli_read_greet_emits_body", () => {
    // PORT: deferred — depends on token_goat.cli / read_commands (not ported)
  });
  it.skip("test_cli_read_nonexistent_symbol_exit_nonzero", () => {
    // PORT: deferred — depends on token_goat.cli / read_commands (not ported)
  });
  it.skip("test_cli_read_missing_separator_exit_2", () => {
    // PORT: deferred — depends on token_goat.cli (not ported)
  });
  it.skip("test_cli_section_methodology", () => {
    // PORT: deferred — depends on token_goat.cli (not ported)
  });
  it.skip("test_cli_read_json_output", () => {
    // PORT: deferred — depends on token_goat.cli (not ported)
  });
  it.skip("test_cli_read_with_session_id", () => {
    // PORT: deferred — depends on token_goat.cli / session (not ported here)
  });

  // ===========================================================================
  // format_callers_footer
  // ===========================================================================

  it("test_format_callers_footer_with_callers", () => {
    const [, proj] = makeTsProject();
    const footer = read_replacement.format_callers_footer(proj, "greet");
    // greet is called inside UserService.hello — should appear in the footer
    expect(footer.startsWith("Refs:")).toBe(true);
    expect(footer).toContain("index.ts");
    expect(footer).toContain(":11"); // line 11: return greet(this.name);
  });

  it("test_format_callers_footer_no_callers", () => {
    const [, proj] = makeTsProject();
    // UserService is defined but never called in the fixture file
    const footer = read_replacement.format_callers_footer(proj, "UserService");
    expect(footer).toBe("");
  });

  it("test_format_callers_footer_db_error", () => {
    const [, proj] = makeTsProject();
    const spy = vi.spyOn(db, "get_symbol_callers").mockImplementation(() => {
      throw new Error("simulated DB failure");
    });
    const footer = read_replacement.format_callers_footer(proj, "anything");
    spy.mockRestore();
    expect(footer).toBe("");
  });

  it("test_format_callers_footer_and_more", () => {
    const [, proj] = makeTsProject();
    const spy = vi.spyOn(db, "get_symbol_callers").mockImplementation(() => {
      // 4 rows → has_more is True for limit=3
      return [1, 2, 3, 4].map((i) => ({ file_rel: `file${i}.py`, line: i * 10 }));
    });
    const footer = read_replacement.format_callers_footer(proj, "something", 3);
    spy.mockRestore();
    expect(footer).toContain("and more");
    expect((footer.match(/,/g) ?? []).length).toBe(2); // only first 3 shown
  });

  it("test_format_callers_footer_exactly_at_limit", () => {
    const [, proj] = makeTsProject();
    const spy = vi.spyOn(db, "get_symbol_callers").mockImplementation(() => {
      // exactly 3 rows — has_more is False for limit=3
      return [1, 2, 3].map((i) => ({ file_rel: `f${i}.py`, line: i }));
    });
    const footer = read_replacement.format_callers_footer(proj, "something", 3);
    spy.mockRestore();
    expect(footer).not.toContain("and more");
    expect(footer.startsWith("Refs:")).toBe(true);
  });

  it.skip("test_cli_section_json_output", () => {
    // PORT: deferred — depends on token_goat.cli (not ported)
  });
  it.skip("test_cli_read_reports_ambiguous_file_match", () => {
    // PORT: deferred — depends on token_goat.cli (not ported)
  });
  it.skip("test_cli_read_reports_structured_json_error_for_ambiguous_match", () => {
    // PORT: deferred — depends on token_goat.cli (not ported)
  });
  it.skip("test_cli_read_reports_structured_json_error_for_missing_symbol", () => {
    // PORT: deferred — depends on token_goat.cli (not ported)
  });
  it.skip("test_cli_read_reports_structured_json_error_for_project_not_indexed", () => {
    // PORT: deferred — depends on token_goat.cli (not ported)
  });
  it.skip("test_cli_deps_reports_dependency_graph", () => {
    // PORT: deferred — depends on token_goat.cli / read_commands (not ported)
  });
  it.skip("test_cli_deps_json_output", () => {
    // PORT: deferred — depends on token_goat.cli / read_commands (not ported)
  });
  it.skip("test_cli_deps_transitive_json_output", () => {
    // PORT: deferred — depends on token_goat.cli / read_commands (not ported)
  });

  it("test_cli_read_reports_index_unavailable", () => {
    // The CLI wiring is deferred, but the core behaviour — find_in_all_projects
    // raising ProjectIndexUnavailable — is portable. Mirror the spirit by
    // asserting find_in_all_projects re-raises when the global DB read fails.
    const spy = vi.spyOn(db, "openGlobalReadonly").mockImplementation(() => {
      throw new (class extends Error {
        code = "EIO";
      })("disk I/O error");
    });
    let caught: unknown;
    try {
      read_replacement.find_in_all_projects("missing.ts");
    } catch (e) {
      caught = e;
    }
    spy.mockRestore();
    expect(caught).toBeInstanceOf(read_replacement.ProjectIndexUnavailable);
  });

  it.skip("test_cli_deps_reports_index_unavailable", () => {
    // PORT: deferred — depends on token_goat.cli (not ported)
  });
  it.skip("test_cli_section_reports_ambiguous_file_match", () => {
    // PORT: deferred — depends on token_goat.cli (not ported)
  });
  it.skip("test_cli_section_reports_structured_json_error_for_missing_heading", () => {
    // PORT: deferred — depends on token_goat.cli (not ported)
  });

  // ===========================================================================
  // read_commands._not_indexed_hint — deferred (read_commands)
  // ===========================================================================

  it.skip("TestNotIndexedHint::test_returns_hint_for_empty_project", () => {
    // PORT: deferred — depends on token_goat.read_commands (not ported)
  });
  it.skip("TestNotIndexedHint::test_returns_none_for_indexed_project", () => {
    // PORT: deferred — depends on token_goat.read_commands (not ported)
  });
  it.skip("TestNotIndexedHint::test_detects_indexing_in_progress", () => {
    // PORT: deferred — depends on token_goat.read_commands / worker (not ported)
  });
  it.skip("TestNotIndexedHint::test_detects_indexing_failed", () => {
    // PORT: deferred — depends on token_goat.read_commands / worker (not ported)
  });
  it.skip("TestNotIndexedHint::test_detects_not_yet_started", () => {
    // PORT: deferred — depends on token_goat.read_commands / worker (not ported)
  });
  it.skip("TestNotIndexedHint::test_handles_malformed_marker", () => {
    // PORT: deferred — depends on token_goat.read_commands (not ported)
  });
  it.skip("TestNotIndexedHint::test_handles_missing_locks_dir", () => {
    // PORT: deferred — depends on token_goat.read_commands (not ported)
  });
  it.skip("TestNotIndexedHint::test_returns_diagnostic_on_db_error", () => {
    // PORT: deferred — Python test is itself @pytest.mark.skip (CI flake)
  });

  it("test_find_in_all_projects_raises_when_global_db_unavailable", () => {
    const spy = vi.spyOn(db, "openGlobalReadonly").mockImplementation(() => {
      throw new (class extends Error {
        code = "EIO";
      })("disk I/O error");
    });
    let caught: unknown;
    try {
      read_replacement.find_in_all_projects("index.ts");
    } catch (e) {
      caught = e;
    }
    spy.mockRestore();
    expect(caught).toBeInstanceOf(read_replacement.ProjectIndexUnavailable);
  });

  // ===========================================================================
  // read_commands — "no project detected" / cross-project — deferred
  // ===========================================================================

  it.skip("TestReadCommandNoProject::test_read_no_project_exits_cleanly", () => {
    // PORT: deferred — depends on token_goat.cli (not ported)
  });
  it.skip("TestReadCommandNoProject::test_section_no_project_exits_cleanly", () => {
    // PORT: deferred — depends on token_goat.cli (not ported)
  });
  it.skip("TestResolveFileCrossProject::test_read_resolves_cross_project_symbol", () => {
    // PORT: deferred — depends on token_goat.cli / read_commands (not ported)
  });
  it.skip("TestDepsCommandErrors::test_deps_missing_file_exits_without_error", () => {
    // PORT: deferred — depends on token_goat.cli (not ported)
  });

  // ===========================================================================
  // File-resolution cache (item 8) and specificity ranking (item 14)
  // ===========================================================================

  describe("TestMatchSpecificity", () => {
    it("test_bare_filename_scores_above_partial_path", () => {
      const score_deep = read_replacement._match_specificity("parser.py", "src/token_goat/parser.py");
      const score_shallow = read_replacement._match_specificity("parser.py", "vendor/parser.py");
      expect(score_deep[0]).toBe(1);
      expect(score_shallow[0]).toBe(1);
      // neg_path_depth closer to 0 → shallow > deep lexicographically
      expect(tupleGt(score_shallow, score_deep)).toBe(true);
    });

    it("test_longer_suffix_wins", () => {
      const score_short = read_replacement._match_specificity("parser.py", "src/token_goat/parser.py");
      const score_long = read_replacement._match_specificity(
        "token_goat/parser.py",
        "src/token_goat/parser.py",
      );
      expect(tupleGt(score_long, score_short)).toBe(true);
    });

    it("test_pick_best_match_resolves_unambiguous", () => {
      const candidates = ["src/token_goat/parser.py", "vendor/lib/parser.py"];
      const best = read_replacement._pick_best_match("token_goat/parser.py", candidates);
      expect(best).toBe("src/token_goat/parser.py");
    });

    it("test_pick_best_match_returns_none_on_tie", () => {
      const candidates = ["a/foo.py", "b/foo.py"];
      expect(read_replacement._pick_best_match("foo.py", candidates)).toBeNull();
    });

    it("test_pick_best_match_single_candidate", () => {
      expect(read_replacement._pick_best_match("foo.py", ["src/foo.py"])).toBe("src/foo.py");
    });

    it("test_pick_best_match_empty", () => {
      expect(read_replacement._pick_best_match("foo.py", [])).toBeNull();
    });
  });

  describe("TestResolveFileCache", () => {
    // setup_method: clear the resolve cache before each test in this group.
    function clearCache(): void {
      read_replacement._RESOLVE_CACHE_obj().clear();
    }

    it("test_cache_miss_returns_sentinel", () => {
      clearCache();
      const result = read_replacement._resolve_cache_lookup("proj-abc", "src/foo.py");
      expect(result).toBe(read_replacement._CACHE_MISS);
    });

    it("test_cache_put_and_hit", () => {
      clearCache();
      read_replacement._resolve_cache_put("proj-abc", "foo.py", "src/foo.py");
      const result = read_replacement._resolve_cache_lookup("proj-abc", "foo.py");
      expect(result).not.toBe(read_replacement._CACHE_MISS);
      expect(result).toBe("src/foo.py");
    });

    it("test_cache_stores_none_result", () => {
      clearCache();
      read_replacement._resolve_cache_put("proj-abc", "missing.py", null);
      const result = read_replacement._resolve_cache_lookup("proj-abc", "missing.py");
      expect(result).not.toBe(read_replacement._CACHE_MISS);
      expect(result).toBeNull();
    });

    it("test_invalidate_clears_only_that_project", () => {
      clearCache();
      read_replacement._resolve_cache_put("proj-A", "foo.py", "src/foo.py");
      read_replacement._resolve_cache_put("proj-B", "foo.py", "lib/foo.py");
      const count = read_replacement.invalidate_file_cache("proj-A");
      expect(count).toBe(1);
      expect(read_replacement._resolve_cache_lookup("proj-A", "foo.py")).toBe(
        read_replacement._CACHE_MISS,
      );
      expect(read_replacement._resolve_cache_lookup("proj-B", "foo.py")).not.toBe(
        read_replacement._CACHE_MISS,
      );
    });

    it("test_cache_evicts_oldest_when_full", () => {
      clearCache();
      const cache = read_replacement._RESOLVE_CACHE_obj();
      const MAX = read_replacement._RESOLVE_CACHE_MAX;
      const EVICT = read_replacement._RESOLVE_CACHE_EVICT;
      for (let i = 0; i < MAX; i++) {
        read_replacement._resolve_cache_put("proj", `file${i}.py`, `src/file${i}.py`);
      }
      expect(cache.size).toBe(MAX);
      read_replacement._resolve_cache_put("proj", "new.py", "src/new.py");
      expect(cache.size).toBe(MAX - EVICT + 1);
      expect(read_replacement._resolve_cache_lookup("proj", "file0.py")).toBe(
        read_replacement._CACHE_MISS,
      );
      expect(read_replacement._resolve_cache_lookup("proj", "new.py")).toBe("src/new.py");
    });

    it("test_resolve_file_rel_uses_cache", () => {
      read_replacement._RESOLVE_CACHE_obj().clear();
      const [, proj] = makePyProject();

      const rel1 = read_replacement.resolve_file_rel(proj, "app.py");
      expect(rel1).toBe("app.py");
      expect(read_replacement._RESOLVE_CACHE_obj().has(`${proj.hash}\x00app.py`)).toBe(true);

      // Corrupt DB path to ensure second call uses cache (not DB).
      const spy = vi.spyOn(read_replacement, "_resolve_file_rel_db").mockImplementation(() => {
        throw new Error("should not be called");
      });
      const rel2 = read_replacement.resolve_file_rel(proj, "app.py");
      spy.mockRestore();
      expect(rel2).toBe("app.py");
    });
  });

  // ===========================================================================
  // section command — edge cases (CLI parts deferred; direct calls ported)
  // ===========================================================================

  it.skip("TestSectionEdgeCases::test_section_top_level_heading", () => {
    // PORT: deferred — depends on token_goat.cli (not ported)
  });
  it.skip("TestSectionEdgeCases::test_section_nested_h3_heading", () => {
    // PORT: deferred — depends on token_goat.cli (not ported)
  });
  it.skip("TestSectionEdgeCases::test_section_results_heading", () => {
    // PORT: deferred — depends on token_goat.cli (not ported)
  });
  it.skip("TestSectionEdgeCases::test_section_json_contains_level", () => {
    // PORT: deferred — depends on token_goat.cli (not ported)
  });
  it.skip("TestSectionEdgeCases::test_section_missing_separator_exits_2", () => {
    // PORT: deferred — depends on token_goat.cli (not ported)
  });
  it.skip("TestSectionEdgeCases::test_section_nonexistent_heading_text_output", () => {
    // PORT: deferred — depends on token_goat.cli (not ported)
  });

  it("TestSectionEdgeCases::test_read_section_subsection_direct", () => {
    const [, proj] = makeMdProject();
    const result = read_replacement.read_section(proj, "article.md", "Subsection");
    expect(result).not.toBeNull();
    expect(result!.heading.includes("Subsection") || result!.text.includes("Details")).toBe(true);
  });

  it("TestSectionEdgeCases::test_read_section_results_returns_text", () => {
    const [, proj] = makeMdProject();
    const result = read_replacement.read_section(proj, "article.md", "Results");
    expect(result).not.toBeNull();
    expect(result!.text.trim()).not.toBe("");
  });

  // ===========================================================================
  // deps --depth + _collect_transitive_outgoing — deferred (read_commands)
  // ===========================================================================

  it.skip("TestDepsDepthTextOutput::test_deps_depth_1_no_transitive_section", () => {
    // PORT: deferred — depends on token_goat.cli / read_commands (not ported)
  });
  it.skip("TestDepsDepthTextOutput::test_deps_depth_2_shows_transitive_section", () => {
    // PORT: deferred — depends on token_goat.cli / read_commands (not ported)
  });
  it.skip("TestDepsDepthTextOutput::test_deps_depth_0_unlimited_header_uses_infinity_symbol", () => {
    // PORT: deferred — depends on token_goat.cli / read_commands (not ported)
  });
  it.skip("TestDepsDepthTextOutput::test_deps_depth_2_text_shows_via_annotation", () => {
    // PORT: deferred — depends on token_goat.cli / read_commands (not ported)
  });
  it.skip("TestCollectTransitiveOutgoing::test_depth_1_does_not_include_c", () => {
    // PORT: deferred — depends on token_goat.read_commands (not ported)
  });
  it.skip("TestCollectTransitiveOutgoing::test_depth_2_includes_c", () => {
    // PORT: deferred — depends on token_goat.read_commands (not ported)
  });
  it.skip("TestCollectTransitiveOutgoing::test_depth_0_unlimited_finds_all", () => {
    // PORT: deferred — depends on token_goat.read_commands (not ported)
  });
  it.skip("TestCollectTransitiveOutgoing::test_cycle_does_not_loop_forever", () => {
    // PORT: deferred — depends on token_goat.read_commands (not ported)
  });

  // ===========================================================================
  // Surgical-read CLI ergonomics: "did you mean…?" — deferred (cli)
  // ===========================================================================

  it.skip("TestSurgicalReadSuggestionsOnMiss::test_read_miss_lists_close_symbol_in_same_file", () => {
    // PORT: deferred — depends on token_goat.cli (not ported)
  });
  it.skip("TestSurgicalReadSuggestionsOnMiss::test_read_miss_json_carries_candidates", () => {
    // PORT: deferred — depends on token_goat.cli (not ported)
  });
  it.skip("TestSurgicalReadSuggestionsOnMiss::test_read_miss_with_no_close_match_omits_didyoumean", () => {
    // PORT: deferred — depends on token_goat.cli (not ported)
  });
  it.skip("TestSurgicalReadSuggestionsOnMiss::test_section_miss_lists_close_heading_in_same_file", () => {
    // PORT: deferred — depends on token_goat.cli (not ported)
  });
  it.skip("TestSurgicalReadSuggestionsOnMiss::test_section_miss_json_carries_candidates", () => {
    // PORT: deferred — depends on token_goat.cli (not ported)
  });
  it.skip("TestSurgicalReadSuggestionsOnMiss::test_symbol_typo_auto_redirects_to_real_match", () => {
    // PORT: deferred — depends on token_goat.cli (not ported)
  });
  it.skip("TestSurgicalReadSuggestionsOnMiss::test_symbol_typo_strict_mode_falls_back_to_didyoumean", () => {
    // PORT: deferred — depends on token_goat.cli (not ported)
  });
  it.skip("TestSurgicalReadSuggestionsOnMiss::test_symbol_miss_with_no_close_match_omits_didyoumean", () => {
    // PORT: deferred — depends on token_goat.cli (not ported)
  });

  // ===========================================================================
  // In-session result cache integration — deferred (cli/session)
  // ===========================================================================

  it.skip("TestInSessionResultCache::test_second_read_hits_cache", () => {
    // PORT: deferred — depends on token_goat.cli (not ported)
  });
  it.skip("TestInSessionResultCache::test_file_edit_invalidates_cache", () => {
    // PORT: deferred — depends on token_goat.cli (not ported)
  });
  it.skip("TestInSessionResultCache::test_no_session_id_skips_cache", () => {
    // PORT: deferred — depends on token_goat.cli (not ported)
  });

  // ===========================================================================
  // _resolve_file_rel_db LIKE query limit tests
  // ===========================================================================

  it("test_resolve_bare_extension_returns_at_most_limit", () => {
    const root = tmpPath();
    fs.mkdirSync(path.join(root, ".git"), { recursive: true });
    const files: FileRow[] = [];
    for (let i = 0; i < 60; i++) {
      const name = `module_${String(i).padStart(3, "0")}.py`;
      fs.writeFileSync(path.join(root, name), `# Module ${i}\ndef func_${i}(): pass\n`, "utf8");
      files.push({ rel_path: name });
    }
    const proj = makeProject(root);
    indexRows(proj, files, []);

    const rows = db.openProject(proj.hash, (conn: DatabaseType) => {
      return conn
        .prepare("SELECT rel_path FROM files WHERE rel_path LIKE ? ESCAPE '\\' LIMIT ?")
        .all(
          `%${read_replacement._escape_like_pattern(".py")}`,
          read_replacement._LIKE_MATCH_LIMIT,
        ) as Array<{ rel_path: string }>;
    });

    expect(rows.length).toBe(read_replacement._LIKE_MATCH_LIMIT);
    expect(rows.every((r) => r.rel_path.endsWith(".py"))).toBe(true);
  });

  it("test_resolve_path_containing_suffix_uses_fast_path", () => {
    const root = tmpPath();
    fs.mkdirSync(path.join(root, ".git"), { recursive: true });
    fs.mkdirSync(path.join(root, "src"), { recursive: true });
    fs.mkdirSync(path.join(root, "tests"), { recursive: true });
    fs.writeFileSync(path.join(root, "src", "main.py"), "def main(): pass\n", "utf8");
    fs.writeFileSync(path.join(root, "tests", "main.py"), "def test_main(): pass\n", "utf8");
    fs.writeFileSync(path.join(root, "main.py"), "# root main\n", "utf8");
    const proj = makeProject(root);
    indexRows(
      proj,
      [{ rel_path: "src/main.py" }, { rel_path: "tests/main.py" }, { rel_path: "main.py" }],
      [],
    );

    const result = read_replacement.resolve_file_rel(proj, "src/main.py");
    expect(result).toBe("src/main.py");
  });

  it("test_resolve_exact_suffix_miss_falls_back_to_like", () => {
    const root = tmpPath();
    fs.mkdirSync(path.join(root, ".git"), { recursive: true });
    fs.mkdirSync(path.join(root, "src"), { recursive: true });
    fs.writeFileSync(path.join(root, "src", "utils.py"), "def util(): pass\n", "utf8");
    fs.writeFileSync(path.join(root, "src", "main.py"), "def main(): pass\n", "utf8");
    const proj = makeProject(root);
    indexRows(proj, [{ rel_path: "src/utils.py" }, { rel_path: "src/main.py" }], []);

    const result = read_replacement.resolve_file_rel(proj, "utils.py");
    expect(result).toBe("src/utils.py");
  });

  // ===========================================================================
  // Line range support (file::N-M)
  // ===========================================================================

  it("test_parse_line_range_valid", () => {
    expect(read_replacement.parse_line_range("1-5")).toEqual([1, 5]);
    expect(read_replacement.parse_line_range("10-10")).toEqual([10, 10]);
    expect(read_replacement.parse_line_range("100-200")).toEqual([100, 200]);
  });

  it("test_parse_line_range_invalid", () => {
    expect(read_replacement.parse_line_range("greet")).toBeNull();
    expect(read_replacement.parse_line_range("MY-CONST")).toBeNull();
    expect(read_replacement.parse_line_range("0-5")).toBeNull();
    expect(read_replacement.parse_line_range("5-3")).toBeNull();
    expect(read_replacement.parse_line_range("-5")).toBeNull();
    expect(read_replacement.parse_line_range("5-")).toBeNull();
    expect(read_replacement.parse_line_range("")).toBeNull();
  });

  it("test_read_line_range_basic", () => {
    const [, proj] = makeTsProject();
    const result = read_replacement.read_line_range(proj, "index.ts", 1, 3);
    expect(result).not.toBeNull();
    expect(result!.start_line).toBe(1);
    expect(result!.end_line).toBe(3);
    expect(result!.text).toContain("import");
  });

  it("test_read_line_range_clamps_to_file_length", () => {
    const [, proj] = makeTsProject();
    const result = read_replacement.read_line_range(proj, "index.ts", 1, 99999);
    expect(result).not.toBeNull();
    expect(result!.end_line).toBeGreaterThan(1);
  });

  it("test_read_line_range_out_of_bounds_returns_none", () => {
    const [, proj] = makeTsProject();
    const result = read_replacement.read_line_range(proj, "index.ts", 99999, 99999);
    expect(result).toBeNull();
  });

  it("test_read_line_range_bytes_saved_positive", () => {
    const [, proj] = makeTsProject();
    const result = read_replacement.read_line_range(proj, "index.ts", 1, 2);
    expect(result).not.toBeNull();
    expect(result!.bytes_saved).toBeGreaterThan(0);
  });

  it.skip("test_cli_read_line_range", () => {
    // PORT: deferred — depends on token_goat.cli (not ported)
  });
  it.skip("test_cli_read_line_range_json", () => {
    // PORT: deferred — depends on token_goat.cli (not ported)
  });
  it.skip("test_cli_read_line_range_out_of_bounds", () => {
    // PORT: deferred — depends on token_goat.cli (not ported)
  });

  // ===========================================================================
  // Cross-project attribution — CLI deferred
  // ===========================================================================

  it.skip("test_cli_read_cross_project_emits_attribution", () => {
    // PORT: deferred — depends on token_goat.cli (not ported)
  });
  it.skip("test_cli_read_cross_project_json_includes_project_root", () => {
    // PORT: deferred — depends on token_goat.cli (not ported)
  });

  // ===========================================================================
  // UTF-8 BOM handling regression test
  // ===========================================================================

  it("test_read_line_range_strips_utf8_bom", () => {
    const root = tmpPath();
    fs.mkdirSync(root, { recursive: true });
    // Write a Python file with UTF-8 BOM (as Notepad would produce on Windows).
    const bomFile = path.join(root, "bom_file.py");
    fs.writeFileSync(
      bomFile,
      Buffer.from([0xef, 0xbb, 0xbf, ...Buffer.from("def greet():\n    return 'hello'\n", "utf8")]),
    );

    const proj = make_project_at(root);
    const result = read_replacement.read_line_range(proj, "bom_file.py", 1, 2);

    expect(result).not.toBeNull();
    const first_line = result!.text.split("\n")[0]!;
    expect(first_line.includes("﻿")).toBe(false);
    expect(first_line).toBe("def greet():");
  });

  // ===========================================================================
  // truncate_symbol_body tests
  // ===========================================================================

  function makeLongPythonFunction(nBodyLines: number = 70): string {
    const lines = ["def long_function(x, y):"];
    lines.push('    """A long function docstring."""');
    for (let i = 0; i < nBodyLines; i++) {
      lines.push(`    x = x + ${i}  # body line ${i}`);
    }
    lines.push("    return x");
    return lines.join("\n");
  }

  describe("TestTruncateSymbolBody", () => {
    it("test_short_body_unchanged", () => {
      const short = Array.from({ length: 60 }, (_, i) => `line ${i}`).join("\n");
      expect(read_replacement.truncate_symbol_body(short)).toBe(short);
    });

    it("test_exactly_threshold_unchanged", () => {
      const text = Array.from(
        { length: read_replacement.TRUNCATE_THRESHOLD },
        (_, i) => `line ${i}`,
      ).join("\n");
      expect(read_replacement.truncate_symbol_body(text)).toBe(text);
    });

    it("test_one_over_threshold_may_truncate", () => {
      const n = read_replacement.TRUNCATE_THRESHOLD + 1;
      const text = Array.from({ length: n }, (_, i) => `line ${i}`).join("\n");
      const result = read_replacement.truncate_symbol_body(text);
      expect(result.length).toBeLessThanOrEqual(text.length);
    });

    it("test_long_body_contains_ellipsis", () => {
      const text = makeLongPythonFunction(70);
      const result = read_replacement.truncate_symbol_body(text);
      expect(result).toContain("lines truncated");
    });

    it("test_long_body_truncated_line_count", () => {
      const text = makeLongPythonFunction(80);
      const result = read_replacement.truncate_symbol_body(text);
      const original_lines = countChar(text, "\n") + 1;
      const result_lines = countChar(result, "\n") + 1;
      expect(result_lines).toBeLessThan(original_lines - 20);
    });

    it("test_full_flag_bypasses_truncation", () => {
      const text = makeLongPythonFunction(80);
      const result = read_replacement.truncate_symbol_body(text, { full: true });
      expect(result).toBe(text);
    });

    it("test_full_flag_on_short_body", () => {
      const text = "def f():\n    return 1\n";
      expect(read_replacement.truncate_symbol_body(text, { full: true })).toBe(text);
    });

    it("test_signature_preserved_in_truncated_output", () => {
      const text = makeLongPythonFunction(70);
      const result = read_replacement.truncate_symbol_body(text);
      expect(result.startsWith("def long_function(x, y):")).toBe(true);
    });

    it("test_tail_preserved_in_truncated_output", () => {
      const text = makeLongPythonFunction(70);
      const result = read_replacement.truncate_symbol_body(text);
      expect(result.replace(/\s+$/, "").endsWith("return x")).toBe(true);
    });

    it("test_docstring_included", () => {
      const text = makeLongPythonFunction(70);
      const result = read_replacement.truncate_symbol_body(text);
      expect(result).toContain("A long function docstring.");
    });

    it("test_ellipsis_count_correct", () => {
      const text = makeLongPythonFunction(80);
      const result = read_replacement.truncate_symbol_body(text);
      const m = /\((\d+) lines truncated\)/.exec(result);
      expect(m).not.toBeNull();
      const count = parseInt(m![1]!, 10);
      expect(count).toBeGreaterThan(0);
    });

    it("test_empty_string_unchanged", () => {
      expect(read_replacement.truncate_symbol_body("")).toBe("");
    });

    it("test_single_line_unchanged", () => {
      const text = "SOME_CONST = 42";
      expect(read_replacement.truncate_symbol_body(text)).toBe(text);
    });

    it("test_large_docstring_small_body_is_capped", () => {
      const doc_lines = Array.from(
        { length: 70 },
        (_, i) => `    line ${i} of a very long docstring`,
      ).join("\n");
      const text = `def f(x):\n    """\n${doc_lines}\n    """\n    x = x + 1\n    return x`;
      const original_lines = countChar(text, "\n") + 1;
      expect(original_lines).toBeGreaterThan(read_replacement.TRUNCATE_THRESHOLD);
      const result = read_replacement.truncate_symbol_body(text);
      const result_lines = countChar(result, "\n") + 1;
      expect(result_lines).toBeLessThan(original_lines);
      expect(result).toContain("(docstring truncated)");
      expect(result).not.toContain("line 60 of a very long docstring");
      expect(result.startsWith("def f(x):")).toBe(true);
      expect(result).toContain("return x");
    });

    it("test_small_body_without_docstring_returned_verbatim", () => {
      const sig =
        "def f(x,\n" +
        Array.from({ length: 60 }, (_, i) => `    arg${i},`).join("\n") +
        "\n    y):";
      const text = `${sig}\n    x = 1\n    return x\n`;
      expect(countChar(text, "\n") + 1).toBeGreaterThan(read_replacement.TRUNCATE_THRESHOLD);
      const result = read_replacement.truncate_symbol_body(text);
      expect(result).toBe(text);
    });

    it("test_multiline_signature_fully_preserved", () => {
      const sig = "def long_function(x,\n                  y,\n                  z):";
      const body = Array.from(
        { length: 70 },
        (_, i) => `    x = x + ${i}  # body line ${i}`,
      ).join("\n");
      const text = `${sig}\n    return x + y + z\n${body}\n    return x`;
      const result = read_replacement.truncate_symbol_body(text);
      expect(result.startsWith(sig)).toBe(true);
      expect(result).toContain("def long_function(x,");
      expect(result).toContain("                  y,");
      expect(result).toContain("                  z):");
      expect(result).toContain("lines truncated");
    });
  });

  describe("TestTokenEstimateHeader", () => {
    it("test_format", () => {
      const text = "line1\nline2\nline3";
      const header = read_replacement.token_estimate_header(text);
      expect(/^# \d+ lines \(~\d+ tok\)$/.test(header)).toBe(true);
    });

    it("test_line_count", () => {
      const text = "a\nb\nc\nd";
      const header = read_replacement.token_estimate_header(text);
      expect(header.startsWith("# 4 lines")).toBe(true);
    });

    it("test_token_estimate_approx", () => {
      const text = "x".repeat(400);
      const header = read_replacement.token_estimate_header(text);
      expect(header).toContain("(~100 tok)");
    });

    it("test_empty_string", () => {
      const header = read_replacement.token_estimate_header("");
      expect(header).toContain("(~0 tok)");
    });

    it("test_single_line", () => {
      const header = read_replacement.token_estimate_header("hello world");
      expect(header.startsWith("# 1 lines")).toBe(true);
    });
  });

  // ===========================================================================
  // --full flag CLI integration — deferred (cli)
  // ===========================================================================

  it.skip("TestReadCommandFullFlag::test_read_includes_token_estimate_in_output", () => {
    // PORT: deferred — depends on token_goat.cli (not ported)
  });
  it.skip("TestReadCommandFullFlag::test_read_truncates_long_body_by_default", () => {
    // PORT: deferred — depends on token_goat.cli (not ported)
  });
  it.skip("TestReadCommandFullFlag::test_read_full_flag_bypasses_truncation", () => {
    // PORT: deferred — depends on token_goat.cli (not ported)
  });
  it.skip("TestReadCommandFullFlag::test_read_short_flag_f_bypasses_truncation", () => {
    // PORT: deferred — depends on token_goat.cli (not ported)
  });
  it.skip("TestReadCommandFullFlag::test_read_full_flag_in_json_output", () => {
    // PORT: deferred — depends on token_goat.cli (not ported)
  });

  // ===========================================================================
  // Fuzzy file matching via partial path (basename or suffix)
  // ===========================================================================

  function makeNestedProject(): [string, Project] {
    const root = tmpPath();
    fs.mkdirSync(path.join(root, "src", "utils"), { recursive: true });
    fs.mkdirSync(path.join(root, ".git"), { recursive: true });
    fs.writeFileSync(
      path.join(root, "src", "utils", "parser.py"),
      "def parse(text):\n    return text.split()\n",
      "utf8",
    );
    const proj = makeProject(root);
    indexRows(
      proj,
      [{ rel_path: "src/utils/parser.py" }],
      [{ name: "parse", kind: "function", file_rel: "src/utils/parser.py", line: 1, end_line: 2 }],
    );
    return [proj.root, proj];
  }

  describe("TestPartialPathResolution", () => {
    it("test_partial_path_resolves_in_module", () => {
      const [, proj] = makeNestedProject();
      const rel = read_replacement.resolve_file_rel(proj, "utils/parser.py");
      expect(rel).toBe("src/utils/parser.py");
    });

    it("test_bare_basename_resolves_when_unique", () => {
      const [, proj] = makeNestedProject();
      const rel = read_replacement.resolve_file_rel(proj, "parser.py");
      expect(rel).toBe("src/utils/parser.py");
    });

    it.skip("test_cli_read_with_partial_path", () => {
      // PORT: deferred — depends on token_goat.cli (not ported)
    });
    it.skip("test_cli_read_with_bare_filename", () => {
      // PORT: deferred — depends on token_goat.cli (not ported)
    });
  });

  // ===========================================================================
  // File-not-found "did you mean?" suggestions — deferred (read_commands/cli)
  // ===========================================================================

  it.skip("TestFileNotFoundSuggestions::test_file_typo_shows_did_you_mean_text", () => {
    // PORT: deferred — depends on token_goat.cli (not ported)
  });
  it.skip("TestFileNotFoundSuggestions::test_file_typo_json_carries_candidates", () => {
    // PORT: deferred — depends on token_goat.cli (not ported)
  });
  it.skip("TestFileNotFoundSuggestions::test_unrelated_filename_omits_did_you_mean", () => {
    // PORT: deferred — depends on token_goat.cli (not ported)
  });
  it.skip("TestFileNotFoundSuggestions::test_close_file_matches_returns_empty_on_db_error", () => {
    // PORT: deferred — depends on token_goat.read_commands (not ported)
  });
});

// ---------------------------------------------------------------------------
// Local comparators mirroring Python tuple ordering / str.count.
// ---------------------------------------------------------------------------

/** Lexicographic `a > b` for [int, int] tuples (Python tuple comparison). */
function tupleGt(a: [number, number], b: [number, number]): boolean {
  if (a[0] !== b[0]) return a[0] > b[0];
  return a[1] > b[1];
}

/** str.count for a single-char needle. */
function countChar(s: string, ch: string): number {
  let count = 0;
  for (let i = 0; i < s.length; i++) {
    if (s[i] === ch) count += 1;
  }
  return count;
}
