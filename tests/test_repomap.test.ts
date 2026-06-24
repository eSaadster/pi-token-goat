/**
 * 1:1 port of tests/test_repomap.py.
 *
 * PageRank graph, budget enforcement, JSON output, path exclusion, density.
 *
 * Port model:
 *  - `nx.MultiDiGraph` → `repomap.MultiDiGraph` (the in-module networkx
 *    replacement). `compute_ranks` returns a `Map<string, number>`, so the
 *    Python `ranks["C"]` index becomes `ranks.get("C")!` and `== {}` becomes
 *    `.size === 0`.
 *  - kwargs → an options object: `build_map(p, budget_tokens=4000)` becomes
 *    `build_map(p, { budget_tokens: 4000 })`; same for build_map_since /
 *    build_map_mermaid.
 *  - `index_project` is async; every test that indexes awaits it. setup.ts
 *    isolates the data dir per `it()`, so the Python module-scoped `ts_project`
 *    fixture becomes a fresh per-test `indexedTsProject()` build.
 *  - pytest `tmp_path` / `make_project` / `tmp_data_dir` fixtures → inline tmp
 *    dirs + `make_project_at` (the data dir is already isolated by setup.ts).
 *  - `patch.object(repomap, "changed_files_since", ...)` → `vi.spyOn`; the
 *    module calls it through `import * as self`, so the spy is observed.
 *  - `repomap.FileSummary(rel_path=…)` → `new repomap.FileSummary({ rel_path: … })`,
 *    symbol tuples → 2-element arrays.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import Database from "better-sqlite3";

import * as db from "../src/token_goat/db.js";
import * as repomap from "../src/token_goat/repomap.js";
import { index_project } from "../src/token_goat/parser.js";
import { make_project_at } from "../src/token_goat/project.js";
import type { Project } from "../src/token_goat/project.js";
import * as config from "../src/token_goat/config.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const FIXTURE_DIR = path.resolve(__dirname, "..", "..", "tests", "fixtures");

const _tmpRoots: string[] = [];

function tmpPath(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `tg-repomap-${process.pid}-${_tmpRoots.length}-`));
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

/** Make a Project rooted at `root`, with a minimal .git so it is detected. */
function makeProjectAtRoot(root: string): Project {
  fs.mkdirSync(path.join(root, ".git"), { recursive: true });
  return make_project_at(root);
}

/** Copy the ts_sample fixture to a tmp dir, index it, return the Project. */
async function indexedTsProject(): Promise<Project> {
  const base = tmpPath();
  const projRoot = path.join(base, "ts_sample");
  fs.cpSync(path.join(FIXTURE_DIR, "ts_sample"), projRoot, { recursive: true });
  const proj = makeProjectAtRoot(projRoot);
  await index_project(proj, { full: true });
  return proj;
}

/** Build + index a synthetic project with `nFiles` padded Python files. */
async function makeSyntheticProject(nFiles: number): Promise<Project> {
  const projRoot = path.join(tmpPath(), `synth_${nFiles}`);
  const src = path.join(projRoot, "src");
  fs.mkdirSync(src, { recursive: true });
  const pad = "# padding line to clear _MIN_DISPLAY_LINES threshold\n".repeat(6);
  for (let i = 0; i < nFiles; i++) {
    fs.writeFileSync(
      path.join(src, `mod_${String(i).padStart(3, "0")}.py`),
      `${pad}` +
        `def fn_${i}_a():\n    pass\n\n` +
        `def fn_${i}_b():\n    pass\n\n` +
        `class Cls_${i}:\n    pass\n`,
    );
  }
  const proj = makeProjectAtRoot(projRoot);
  await index_project(proj, { full: true });
  return proj;
}

/** Python `str.splitlines()` analogue for assertions (drops trailing empty). */
function splitlines(s: string): string[] {
  if (s === "") return [];
  const parts = s.split("\n");
  if (parts.length > 0 && parts[parts.length - 1] === "") parts.pop();
  return parts;
}

// ---------------------------------------------------------------------------
// 1-2. compute_ranks basics
// ---------------------------------------------------------------------------

describe("compute_ranks", () => {
  it("test_compute_ranks_empty_graph", () => {
    const g = new repomap.MultiDiGraph();
    const result = repomap.compute_ranks(g);
    expect(result.size).toBe(0);
  });

  it("test_compute_ranks_linear_graph", () => {
    const g = new repomap.MultiDiGraph();
    g.add_edge("A", "B");
    g.add_edge("B", "C");
    const ranks = repomap.compute_ranks(g);
    // C is pointed to by B which is pointed to by A — highest PageRank.
    expect(ranks.get("C")!).toBeGreaterThan(ranks.get("B")!);
    expect(ranks.get("B")!).toBeGreaterThan(ranks.get("A")!);
  });

  it("test_compute_ranks_with_self_loops", () => {
    const g = new repomap.MultiDiGraph();
    g.add_edge("A", "A");
    g.add_edge("A", "B");
    const ranks = repomap.compute_ranks(g);
    expect(ranks.has("A")).toBe(true);
    expect(ranks.has("B")).toBe(true);
    expect(typeof ranks.get("A")).toBe("number");
    expect(typeof ranks.get("B")).toBe("number");
  });

  it("test_compute_ranks_isolated_nodes", () => {
    const g = new repomap.MultiDiGraph();
    g.add_node("X");
    g.add_node("Y");
    g.add_node("Z");
    const ranks = repomap.compute_ranks(g);
    expect(ranks.has("X")).toBe(true);
    expect(ranks.has("Y")).toBe(true);
    expect(ranks.has("Z")).toBe(true);
    expect(Math.abs(ranks.get("X")! - ranks.get("Y")!)).toBeLessThan(0.01);
    expect(Math.abs(ranks.get("Y")! - ranks.get("Z")!)).toBeLessThan(0.01);
  });
});

// ---------------------------------------------------------------------------
// 3-7. End-to-end build_map on ts_sample
// ---------------------------------------------------------------------------

describe("build_map end-to-end", () => {
  it("test_build_map_end_to_end", async () => {
    const ts_project = await indexedTsProject();
    const text = repomap.build_map(ts_project, { budget_tokens: 4000 });
    expect(text.trim()).toBeTruthy();
    expect(text).toContain("ts_sample");
    expect(text).toContain("index.ts");
  });

  it("test_build_map_budget_enforced", async () => {
    const ts_project = await indexedTsProject();
    const short = repomap.build_map(ts_project, { budget_tokens: 20 });
    const long_ = repomap.build_map(ts_project, { budget_tokens: 10000 });
    expect(short.length).toBeLessThan(long_.length);
  });

  it("test_build_map_no_edges_fallback", async () => {
    const ts_project = await indexedTsProject();
    const text = repomap.build_map(ts_project, { budget_tokens: 4000 });
    expect(text).toContain("index.ts");
  });

  it("test_build_map_header", async () => {
    const ts_project = await indexedTsProject();
    const text = repomap.build_map(ts_project, { budget_tokens: 4000 });
    expect(text).toContain("ts_sample");
    expect(text).toContain("(1,");
  });

  it("test_build_map_zero_budget", async () => {
    const ts_project = await indexedTsProject();
    const text = repomap.build_map(ts_project, { budget_tokens: 0 });
    expect(typeof text).toBe("string");
  });
});

// ---------------------------------------------------------------------------
// 5, 9, 16, 18, 19. build_map_json
// ---------------------------------------------------------------------------

describe("build_map_json", () => {
  it("test_build_map_json_structure", async () => {
    const ts_project = await indexedTsProject();
    const data = repomap.build_map_json(ts_project);
    expect(Array.isArray(data)).toBe(true);
    expect(data.length).toBeGreaterThanOrEqual(1);
    const requiredKeys = ["path", "language", "rank", "symbols", "approx_lines"];
    for (const entry of data) {
      for (const k of requiredKeys) expect(k in entry).toBe(true);
      expect(Array.isArray(entry.symbols)).toBe(true);
      expect(typeof entry.rank).toBe("number");
    }
  });

  it("test_build_map_json_serialisable", async () => {
    const ts_project = await indexedTsProject();
    const data = repomap.build_map_json(ts_project);
    const loaded = JSON.parse(JSON.stringify(data));
    expect(loaded).toEqual(data);
  });

  it("test_build_map_json_rank_values_positive", async () => {
    const ts_project = await indexedTsProject();
    const data = repomap.build_map_json(ts_project);
    for (const entry of data) {
      expect(entry.rank).toBeGreaterThanOrEqual(0.0);
      expect(typeof entry.rank).toBe("number");
    }
  });

  it("test_build_map_json_language_field", async () => {
    const ts_project = await indexedTsProject();
    const data = repomap.build_map_json(ts_project);
    for (const entry of data) {
      expect("language" in entry).toBe(true);
      expect(["string", "object"]).toContain(typeof entry.language);
    }
  });

  it("test_build_map_json_line_counts", async () => {
    const ts_project = await indexedTsProject();
    const data = repomap.build_map_json(ts_project);
    for (const entry of data) {
      expect(entry.approx_lines).toBeGreaterThanOrEqual(0);
      expect(entry.approx_lines).toBeLessThan(1000000);
    }
  });
});

// ---------------------------------------------------------------------------
// 8, 10-12, 17. estimate_tokens
// ---------------------------------------------------------------------------

describe("estimate_tokens", () => {
  it("test_estimate_tokens_sanity", () => {
    const t = repomap.estimate_tokens("a".repeat(350));
    expect(t).toBeGreaterThanOrEqual(80);
    expect(t).toBeLessThanOrEqual(140);
  });

  it("test_estimate_tokens_empty_string", () => {
    const t = repomap.estimate_tokens("");
    expect(t).toBeGreaterThanOrEqual(0);
    expect(Number.isInteger(t)).toBe(true);
  });

  it("test_estimate_tokens_large_text", () => {
    const small = repomap.estimate_tokens("a".repeat(100));
    const large = repomap.estimate_tokens("a".repeat(10000));
    expect(large).toBeGreaterThan(small);
    expect(large).toBeGreaterThan(100 * Math.floor(small / 2));
  });

  it("test_estimate_tokens_with_whitespace", () => {
    const t1 = repomap.estimate_tokens("a b c d e f g h i j");
    const t2 = repomap.estimate_tokens("abcdefghij");
    expect(Math.abs(t1 - t2)).toBeLessThan(5);
  });

  it("test_estimate_tokens_deterministic", () => {
    const text = "The quick brown fox jumps over the lazy dog.\nLine 2.\n";
    expect(repomap.estimate_tokens(text)).toBe(repomap.estimate_tokens(text));
  });
});

// ---------------------------------------------------------------------------
// 20. _is_map_worthy
// ---------------------------------------------------------------------------

describe("_is_map_worthy", () => {
  it("test_is_map_worthy_excludes_fixture_paths", () => {
    expect(repomap._is_map_worthy("tests/fixtures/ts_sample/index.ts", 100)).toBe(false);
    expect(repomap._is_map_worthy("tests/fixtures/some_stub.py", 500)).toBe(false);
  });

  it("test_is_map_worthy_windows_paths_normalized", () => {
    expect(repomap._is_map_worthy("tests\\fixtures\\ts_sample\\index.ts", 100)).toBe(false);
  });

  it("test_is_map_worthy_excludes_tiny_files", () => {
    expect(repomap._is_map_worthy("src/token_goat/__init__.py", 2)).toBe(false);
    expect(repomap._is_map_worthy("src/foo.py", 0)).toBe(false);
  });

  it("test_is_map_worthy_accepts_normal_source_files", () => {
    expect(repomap._is_map_worthy("src/token_goat/cli.py", 50)).toBe(true);
    expect(repomap._is_map_worthy("src/token_goat/worker.py", 10)).toBe(true);
  });

  it("test_is_map_worthy_boundary_at_min_lines", () => {
    expect(repomap._is_map_worthy("src/foo.py", repomap._MIN_DISPLAY_LINES)).toBe(true);
    expect(repomap._is_map_worthy("src/foo.py", repomap._MIN_DISPLAY_LINES - 1)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 21. _build_graph
// ---------------------------------------------------------------------------

describe("_build_graph", () => {
  it("test_build_graph_no_ghost_nodes", () => {
    const con = new Database(":memory:");
    con.exec(`
      CREATE TABLE files (rel_path TEXT, language TEXT, size INTEGER);
      CREATE TABLE symbols (name TEXT, kind TEXT, file_rel TEXT);
      CREATE TABLE refs (symbol_name TEXT, file_rel TEXT);
      CREATE TABLE sections (file_rel TEXT, heading TEXT, level INTEGER, line INTEGER);

      INSERT INTO files VALUES ('src/a.py', 'python', 500);
      INSERT INTO files VALUES ('src/b.py', 'python', 500);

      INSERT INTO symbols VALUES ('MyClass', 'class', 'src/b.py');

      INSERT INTO refs VALUES ('MyClass', 'tests/fixtures/stub.py');
      INSERT INTO refs VALUES ('MyClass', 'src/a.py');
    `);

    const files = new Map<string, { language: string; size: number; mtime: number }>([
      ["src/a.py", { language: "python", size: 500, mtime: 0 }],
      ["src/b.py", { language: "python", size: 500, mtime: 0 }],
    ]);
    const name_to_files = new Map<string, Set<string>>([["MyClass", new Set(["src/b.py"])]]);

    const g = repomap._build_graph(con as unknown as Parameters<typeof repomap._build_graph>[0], files, name_to_files);

    expect(new Set(g.nodes())).toEqual(new Set(["src/a.py", "src/b.py"]));
    expect(g.has_edge("src/a.py", "src/b.py")).toBe(true);
    con.close();
  });
});

// ---------------------------------------------------------------------------
// 22. repomap_cache
// ---------------------------------------------------------------------------

describe("repomap_cache", () => {
  it("test_build_map_cache_populates_on_first_call", async () => {
    const ts_project = await indexedTsProject();
    repomap.build_map(ts_project, { budget_tokens: 4000 });
    const count = db.openProject(ts_project.hash, (conn) =>
      (conn.prepare("SELECT COUNT(*) AS n FROM repomap_cache").get() as { n: number }).n,
    );
    expect(count).toBeGreaterThanOrEqual(1);
  });

  it("test_build_map_cache_hit_on_second_call", async () => {
    const ts_project = await indexedTsProject();
    const first = repomap.build_map(ts_project, { budget_tokens: 4000 });
    const second = repomap.build_map(ts_project, { budget_tokens: 4000 });
    expect(first).toBe(second);
  });

  it("test_build_map_cache_stale_entries_evicted", async () => {
    const ts_project = await indexedTsProject();
    // Seed a phantom cache entry with no matching files row (FK off so it sticks).
    db.openProject(ts_project.hash, (conn) => {
      conn.exec("PRAGMA foreign_keys = OFF");
      conn
        .prepare(
          "INSERT OR REPLACE INTO repomap_cache " +
            "(rel_path, mtime, size, summary_text, created_at) VALUES (?, ?, ?, ?, ?)",
        )
        .run("ghost/phantom.py", 1.0, 999, "phantom summary\n", 1);
      conn.exec("PRAGMA foreign_keys = ON");
    });

    await index_project(ts_project, { full: true });
    repomap.build_map(ts_project, { budget_tokens: 4000 });

    const count = db.openProject(ts_project.hash, (conn) =>
      (
        conn
          .prepare("SELECT COUNT(*) AS n FROM repomap_cache WHERE rel_path = 'ghost/phantom.py'")
          .get() as { n: number }
      ).n,
    );
    expect(count).toBe(0);
  });

  it("test_load_summary_cache_graceful_on_missing_table", () => {
    const con = new Database(":memory:");
    const result = repomap._load_summary_cache(
      con as unknown as Parameters<typeof repomap._load_summary_cache>[0],
    );
    expect(result.size).toBe(0);
    con.close();
  });

  it("test_write_summary_cache_graceful_on_missing_table", () => {
    const con = new Database(":memory:");
    expect(() =>
      repomap._write_summary_cache(
        con as unknown as Parameters<typeof repomap._write_summary_cache>[0],
        [["src/a.py", 1.0, 100, "rendered\n"]],
      ),
    ).not.toThrow();
    con.close();
  });
});

// ---------------------------------------------------------------------------
// 23. Density: render_summary
// ---------------------------------------------------------------------------

function makeSummary(args: {
  rel_path?: string;
  language?: string;
  rank?: number;
  symbols?: Array<[string, string]>;
  sections?: string[];
  line_count?: number;
}): repomap.FileSummary {
  return new repomap.FileSummary({
    rel_path: args.rel_path ?? "src/foo.py",
    language: args.language ?? "python",
    rank: args.rank ?? 0.1234,
    top_symbols: args.symbols ?? [],
    top_sections: args.sections ?? [],
    line_count: args.line_count ?? 100,
  });
}

describe("render_summary density", () => {
  it("test_render_summary_uses_short_rank_label", () => {
    const text = repomap.render_summary(makeSummary({ rank: 0.5 }));
    expect(text).toContain("r=");
    expect(text).not.toContain("rank=");
  });

  it("test_render_summary_uses_short_kind_tags", () => {
    const text = repomap.render_summary(
      makeSummary({ symbols: [["function", "do_thing"], ["class", "Widget"]] }),
    );
    expect(text).toContain("fn:");
    expect(text).toContain("cls:");
    expect(text).not.toContain("function: ");
    expect(text).not.toContain("class: ");
  });

  it("test_render_summary_compact_mode_drops_symbol_lines", () => {
    const s = makeSummary({ symbols: [["function", "a"], ["class", "B"]], sections: ["Intro"] });
    const full = repomap.render_summary(s, false);
    const compact = repomap.render_summary(s, true);
    expect(compact).not.toContain("\n");
    expect(full).toContain("fn:");
    expect(compact).not.toContain("fn:");
    expect(compact).not.toContain("sec:");
    expect(compact.length).toBeLessThan(full.length);
  });

  it("test_render_summary_compact_is_much_smaller", () => {
    const s = makeSummary({
      symbols: [
        ["function", "alpha"],
        ["function", "beta"],
        ["function", "gamma"],
        ["class", "Foo"],
        ["class", "Bar"],
      ],
      sections: ["A", "B"],
    });
    const full = repomap.render_summary(s, false);
    const compact = repomap.render_summary(s, true);
    expect(compact.length).toBeLessThanOrEqual(full.length * 0.6);
  });
});

describe("build_map density", () => {
  it("test_build_map_header_density", async () => {
    const ts_project = await indexedTsProject();
    const text = repomap.build_map(ts_project, { budget_tokens: 4000 });
    const headerLine = splitlines(text)[0]!;
    expect(headerLine.length).toBeLessThan(50);
  });

  it("test_build_map_auto_compact_engages_at_low_budget", async () => {
    const ts_project = await indexedTsProject();
    const tight = repomap.build_map(ts_project, { budget_tokens: 80 });
    const full = repomap.build_map(ts_project, { budget_tokens: 4000 });
    for (const line of splitlines(tight)) {
      expect(line.startsWith(" ")).toBe(false);
    }
    expect(splitlines(full).some((line) => line.startsWith(" "))).toBe(true);
  });

  it("test_build_map_explicit_compact_flag", async () => {
    const ts_project = await indexedTsProject();
    const text = repomap.build_map(ts_project, { budget_tokens: 10000, compact: true });
    for (const line of splitlines(text)) {
      expect(line.startsWith(" ")).toBe(false);
    }
  });

  it("test_build_map_compact_fits_more_files_per_token", async () => {
    const projRoot = path.join(tmpPath(), "density_sample");
    const src = path.join(projRoot, "src");
    fs.mkdirSync(src, { recursive: true });
    const pad = "# padding line to clear _MIN_DISPLAY_LINES threshold for the map\n".repeat(6);
    for (let i = 0; i < 6; i++) {
      fs.writeFileSync(
        path.join(src, `mod_${i}.py`),
        `${pad}def fn_${i}_a():\n    pass\n\ndef fn_${i}_b():\n    pass\n\nclass Cls_${i}:\n    pass\n`,
      );
    }
    const proj = makeProjectAtRoot(projRoot);
    await index_project(proj, { full: true });

    const budget = 120;
    const fullText = repomap.build_map(proj, { budget_tokens: budget, compact: false });
    const compactText = repomap.build_map(proj, { budget_tokens: budget, compact: true });

    const countEntries = (text: string): number =>
      splitlines(text).filter((line) => line.includes("[python,")).length;

    expect(countEntries(compactText)).toBeGreaterThan(countEntries(fullText));
  });

  it("test_build_map_density_chars_per_file_bound", async () => {
    const projRoot = path.join(tmpPath(), "density_bound");
    const src = path.join(projRoot, "src");
    fs.mkdirSync(src, { recursive: true });
    const pad = "# padding line to clear _MIN_DISPLAY_LINES threshold for the map\n".repeat(6);
    for (let i = 0; i < 5; i++) {
      fs.writeFileSync(
        path.join(src, `a_${i}.py`),
        `${pad}def fn_${i}():\n    pass\n\nclass C_${i}:\n    pass\n\nclass D_${i}:\n    pass\n`,
      );
    }
    const proj = makeProjectAtRoot(projRoot);
    await index_project(proj, { full: true });

    const text = repomap.build_map(proj, { budget_tokens: 10000, compact: true });
    const fileLines = splitlines(text).filter((line) => line.includes("[python,"));
    expect(fileLines.length).toBeGreaterThan(0);
    for (const line of fileLines) {
      expect(line.length).toBeLessThanOrEqual(80);
    }
  });
});

// ---------------------------------------------------------------------------
// Compact file-list preamble truncation
// ---------------------------------------------------------------------------

describe("compact file-list threshold", () => {
  it("test_compact_under_threshold_emits_full_list", async () => {
    const proj = await makeSyntheticProject(30);
    const text = repomap.build_map(proj, {
      budget_tokens: 10000,
      compact: true,
      compact_file_threshold: 50,
    });
    const fileLines = splitlines(text).filter((line) => line.includes("[python,"));
    expect(fileLines.length).toBe(30);
    expect(text).not.toContain("files indexed. Top modules:");
  });

  it("test_compact_over_threshold_emits_summary_line", async () => {
    const proj = await makeSyntheticProject(80);
    const text = repomap.build_map(proj, {
      budget_tokens: 300,
      compact: true,
      compact_file_threshold: 50,
    });
    expect(text).toContain("80 files indexed. Top modules:");

    const m = text.match(/Top modules: ([^\n]+)/);
    expect(m).not.toBeNull();
    const modulesPart = m![1]!;
    const namesRaw = modulesPart.replace(/\s*\(\+\d+ more\)/, "");
    const names = namesRaw
      .split(",")
      .map((n) => n.trim())
      .filter((n) => n);
    expect(names.length).toBe(3);
    for (const name of names) expect(name.endsWith(".py")).toBe(true);

    const fileLines = splitlines(text).filter((line) => line.includes("[python,"));
    expect(fileLines.length).toBe(0);
    expect(text).toContain("(+77 more)");
  });

  it("test_compact_summary_scales_top_n_with_budget", async () => {
    const proj = await makeSyntheticProject(80);
    const cases: Array<[number, number]> = [
      [300, 3],
      [500, 5],
      [1500, 8],
      [4000, 12],
    ];
    for (const [budget, expectedTopN] of cases) {
      const text = repomap.build_map(proj, {
        budget_tokens: budget,
        compact: true,
        compact_file_threshold: 50,
      });
      const m = text.match(/Top modules: ([^\n]+)/);
      expect(m, `summary line missing at budget=${budget}`).not.toBeNull();
      const namesRaw = m![1]!.replace(/\s*\(\+\d+ more\)/, "");
      const names = namesRaw
        .split(",")
        .map((n) => n.trim())
        .filter((n) => n);
      expect(names.length, `budget=${budget}`).toBe(expectedTopN);
    }
  });

  it("test_compact_over_threshold_full_flag_restores_list", async () => {
    const proj = await makeSyntheticProject(80);
    const text = repomap.build_map(proj, {
      budget_tokens: 10000,
      compact: true,
      full: true,
      compact_file_threshold: 50,
    });
    expect(text).not.toContain("files indexed. Top modules:");
    const fileLines = splitlines(text).filter((line) => line.includes("[python,"));
    expect(fileLines.length).toBe(80);
  });

  it("test_compact_threshold_env_override", async () => {
    const proj = await makeSyntheticProject(10);

    const prev = process.env["TOKEN_GOAT_REPOMAP_COMPACT_THRESHOLD"];
    try {
      process.env["TOKEN_GOAT_REPOMAP_COMPACT_THRESHOLD"] = "5";
      const cfg = config.load();
      expect(cfg.repomap!.compact_file_threshold).toBe(5);

      const text = repomap.build_map(proj, {
        budget_tokens: 10000,
        compact: true,
        compact_file_threshold: cfg.repomap!.compact_file_threshold!,
      });
      expect(text).toContain("10 files indexed. Top modules:");

      process.env["TOKEN_GOAT_REPOMAP_COMPACT_THRESHOLD"] = "20";
      const cfg2 = config.load();
      expect(cfg2.repomap!.compact_file_threshold).toBe(20);

      const text2 = repomap.build_map(proj, {
        budget_tokens: 10000,
        compact: true,
        compact_file_threshold: cfg2.repomap!.compact_file_threshold!,
      });
      expect(text2).not.toContain("files indexed. Top modules:");
    } finally {
      if (prev === undefined) delete process.env["TOKEN_GOAT_REPOMAP_COMPACT_THRESHOLD"];
      else process.env["TOKEN_GOAT_REPOMAP_COMPACT_THRESHOLD"] = prev;
    }
  });
});

// ---------------------------------------------------------------------------
// Item A20: low-PageRank file collapse in compact mode
// ---------------------------------------------------------------------------

describe("low-rank collapse", () => {
  it("test_compact_mode_collapses_low_rank_files", async () => {
    const projRoot = path.join(tmpPath(), "collapseproj");
    const src = path.join(projRoot, "src");
    fs.mkdirSync(src, { recursive: true });
    const hub = "def hub_fn():\n    pass\n\ndef another_fn():\n    pass\n";
    for (const name of ["hub_a.py", "hub_b.py", "hub_c.py"]) {
      fs.writeFileSync(path.join(src, name), hub, "utf-8");
    }
    for (let i = 0; i < 8; i++) {
      fs.writeFileSync(
        path.join(src, `isolated_${String(i).padStart(2, "0")}.py`),
        `# isolated module ${i}\n\ndef isolated_fn_${i}():\n    return ${i}\n`,
        "utf-8",
      );
    }
    const proj = makeProjectAtRoot(projRoot);
    await index_project(proj, { full: true });

    const text = repomap.build_map(proj, {
      budget_tokens: 10000,
      compact: true,
      compact_file_threshold: 200,
    });
    expect(text).toBeTruthy();

    if (text.includes("(+8 minor files)") || text.includes("minor")) {
      expect(/\(\+\d+ minor files?\)|more \(\+\d+ minor\)/.test(text)).toBe(true);
    }
  });

  it("test_compact_mode_no_collapse_when_few_low_rank", async () => {
    const projRoot = path.join(tmpPath(), "nocollapseproj");
    const src = path.join(projRoot, "src");
    fs.mkdirSync(src, { recursive: true });
    for (let i = 0; i < 4; i++) {
      fs.writeFileSync(path.join(src, `lone_${i}.py`), `def fn_${i}():\n    return ${i}\n`, "utf-8");
    }
    const proj = makeProjectAtRoot(projRoot);
    await index_project(proj, { full: true });

    const text = repomap.build_map(proj, {
      budget_tokens: 10000,
      compact: true,
      compact_file_threshold: 200,
    });
    expect(text).toBeTruthy();
    expect(text).not.toContain("minor files");
  });

  it("test_compact_false_no_collapse", async () => {
    const projRoot = path.join(tmpPath(), "fullmodeproj");
    const src = path.join(projRoot, "src");
    fs.mkdirSync(src, { recursive: true });
    for (let i = 0; i < 8; i++) {
      fs.writeFileSync(path.join(src, `iso_${i}.py`), `def fn_${i}():\n    return ${i}\n`, "utf-8");
    }
    const proj = makeProjectAtRoot(projRoot);
    await index_project(proj, { full: true });

    const text = repomap.build_map(proj, {
      budget_tokens: 10000,
      compact: false,
      compact_file_threshold: 200,
    });
    expect(text).toBeTruthy();
    expect(text).not.toContain("minor files");
  });
});

// ---------------------------------------------------------------------------
// Path-exclusion
// ---------------------------------------------------------------------------

describe("TestExcludedPaths", () => {
  // _is_excluded_path_cached is memoized; clear before each case.
  const reset = (): void => repomap._is_excluded_path_cached.cache_clear();

  it("test_tests_fixtures_excluded", () => {
    reset();
    expect(repomap._is_excluded_path("tests/fixtures/foo.py")).toBe(true);
    expect(repomap._is_excluded_path("tests/fixtures/sub/bar.py")).toBe(true);
  });

  it("test_tests_dir_excluded_by_default", () => {
    reset();
    expect(repomap._is_excluded_path("tests/test_repomap.py")).toBe(true);
    expect(repomap._is_excluded_path("__tests__/foo.test.ts")).toBe(true);
    expect(repomap._is_excluded_path("spec/my_spec.rb")).toBe(true);
  });

  it("test_normal_source_not_excluded", () => {
    reset();
    expect(repomap._is_excluded_path("src/token_goat/parser.py")).toBe(false);
    expect(repomap._is_excluded_path("README.md")).toBe(false);
  });

  it("test_uv_cache_root_excluded", () => {
    reset();
    expect(repomap._is_excluded_path(".uv-cache/x.py")).toBe(true);
    expect(repomap._is_excluded_path(".uv-cache-local/x.py")).toBe(true);
    expect(
      repomap._is_excluded_path(".uv-cache-local/.tmpHZ08Ai/python/packaging/_manylinux.py"),
    ).toBe(true);
  });

  it("test_uv_tmp_subdir_excluded_anywhere", () => {
    reset();
    expect(repomap._is_excluded_path(".uv-cache/.tmp2VqIvs/wheel.py")).toBe(true);
    expect(repomap._is_excluded_path("some/path/.tmpABC/inner.py")).toBe(true);
  });

  it("test_coverage_artifacts_excluded", () => {
    reset();
    expect(repomap._is_excluded_path("coverage.json")).toBe(true);
    expect(repomap._is_excluded_path("coverage.xml")).toBe(true);
    expect(repomap._is_excluded_path("lcov.info")).toBe(true);
    expect(repomap._is_excluded_path("subproj/coverage.json")).toBe(true);
  });

  it("test_basename_match_is_case_insensitive", () => {
    reset();
    expect(repomap._is_excluded_path("Coverage.JSON")).toBe(true);
    expect(repomap._is_excluded_path("LCOV.info")).toBe(true);
  });

  it("test_windows_backslash_paths_normalized", () => {
    reset();
    expect(repomap._is_excluded_path(".uv-cache\\foo.py")).toBe(true);
    expect(repomap._is_excluded_path("tests\\fixtures\\foo.py")).toBe(true);
  });

  it("test_build_output_dirs_excluded", () => {
    reset();
    expect(repomap._is_excluded_path("dist/index.js")).toBe(true);
    expect(repomap._is_excluded_path("build/main.py")).toBe(true);
    expect(repomap._is_excluded_path("node_modules/react/index.js")).toBe(true);
    expect(repomap._is_excluded_path("target/debug/myapp")).toBe(true);
    expect(repomap._is_excluded_path(".venv/lib/python3.11/site.py")).toBe(true);
  });

  it("test_generated_suffixes_excluded", () => {
    reset();
    expect(repomap._is_excluded_path("src/app.min.js")).toBe(true);
    expect(repomap._is_excluded_path("src/bundle.js.map")).toBe(true);
    expect(repomap._is_excluded_path("src/compiled.pyc")).toBe(true);
    expect(repomap._is_excluded_path("src/app.min.css")).toBe(true);
    expect(repomap._is_excluded_path("dist/chunk.bundle.js")).toBe(true);
  });

  it("test_pycache_excluded_anywhere", () => {
    reset();
    expect(repomap._is_excluded_path("src/token_goat/__pycache__/db.cpython-312.pyc")).toBe(true);
    expect(repomap._is_excluded_path("__pycache__/cli.pyc")).toBe(true);
  });

  it("test_ci_cache_dirs_excluded", () => {
    reset();
    expect(repomap._is_excluded_path(".pytest_cache/v/cache/nodeids")).toBe(true);
    expect(repomap._is_excluded_path(".mypy_cache/3.12/token_goat/db.data.json")).toBe(true);
    expect(repomap._is_excluded_path(".ruff_cache/0.1.0/foo")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Compact summary top_n widening (_build_compact_file_summary)
// ---------------------------------------------------------------------------

describe("TestBuildCompactFileSummary", () => {
  const ranked = (n: number): Array<[string, { language: string; size: number; mtime: number }]> =>
    Array.from({ length: n }, (_, i) => [
      `src/mod_${i}.py`,
      { language: "python", size: 1000, mtime: 0.0 },
    ]);

  it("test_default_top_n_is_three", () => {
    const out = repomap._build_compact_file_summary(ranked(20), 20);
    expect(out).toContain("Top modules: mod_0.py, mod_1.py, mod_2.py");
    expect(out).toContain("(+17 more)");
  });

  it("test_top_n_widens", () => {
    const out = repomap._build_compact_file_summary(ranked(20), 20, 5);
    const modules = out.split("Top modules: ", 2)[1]!.split(" (+")[0]!;
    expect((modules.match(/,/g) ?? []).length).toBe(4);
    expect(out).toContain("(+15 more)");
  });

  it("test_top_n_floor_one", () => {
    const out = repomap._build_compact_file_summary(ranked(20), 20, 0);
    expect(out).toContain("Top modules: mod_0.py (+19 more)");
  });

  it("test_top_n_capped_by_available_files", () => {
    const out = repomap._build_compact_file_summary(ranked(2), 2, 10);
    expect(out.split("indexed. ", 2)[1]).toBe("Top modules: mod_0.py, mod_1.py\n");
  });
});

// ---------------------------------------------------------------------------
// size-fallback path: minor-file collapsing disabled
// ---------------------------------------------------------------------------

describe("size fallback", () => {
  it("test_build_map_size_fallback_no_minor_file_collapse", async () => {
    const projRoot = path.join(tmpPath(), "sizefallbackproj");
    const src = path.join(projRoot, "src");
    fs.mkdirSync(src, { recursive: true });
    for (let i = 0; i < 8; i++) {
      fs.writeFileSync(
        path.join(src, `iso_${String(i).padStart(2, "0")}.py`),
        `# isolated ${i}\ndef fn_${i}(): return ${i}\n`,
        "utf-8",
      );
    }
    const proj = makeProjectAtRoot(projRoot);
    await index_project(proj, { full: true });

    const data = repomap._load_and_rank(proj);
    expect(data).not.toBeNull();
    expect(data!.using_size_fallback).toBe(true);

    const text = repomap.build_map(proj, {
      budget_tokens: 10000,
      compact: true,
      compact_file_threshold: 200,
    });
    expect(text).toBeTruthy();
    expect(text).not.toContain("minor files");
  });
});

// ---------------------------------------------------------------------------
// lang_breakdown
// ---------------------------------------------------------------------------

describe("lang_breakdown", () => {
  const files = (
    entries: Array<[string, { language: string; size: number; mtime: number }]>,
  ): Map<string, { language: string; size: number; mtime: number }> => new Map(entries);

  it("test_lang_breakdown_single_language", () => {
    const result = repomap.lang_breakdown(
      files([
        ["src/a.py", { language: "python", size: 100, mtime: 1.0 }],
        ["src/b.py", { language: "python", size: 200, mtime: 1.0 }],
      ]),
    );
    expect(result).toContain("Python: 100%");
  });

  it("test_lang_breakdown_two_languages", () => {
    const result = repomap.lang_breakdown(
      files([
        ["src/a.py", { language: "python", size: 100, mtime: 1.0 }],
        ["src/b.ts", { language: "typescript", size: 100, mtime: 1.0 }],
      ]),
    );
    expect(result).toContain("Python");
    expect(result.toLowerCase()).toContain("typescript");
    expect(result).toContain("50%");
  });

  it("test_lang_breakdown_empty_files", () => {
    expect(repomap.lang_breakdown(new Map())).toBe("");
  });

  it("test_lang_breakdown_folds_many_languages_into_other", () => {
    const result = repomap.lang_breakdown(
      files(
        Array.from({ length: 10 }, (_, i) => [
          `src/f${i}.x`,
          { language: `lang${i}`, size: 100, mtime: 1.0 },
        ]),
      ),
    );
    expect(result).toContain("Other");
  });

  it("test_lang_breakdown_four_languages_no_other", () => {
    const result = repomap.lang_breakdown(
      files([
        ["a.py", { language: "python", size: 100, mtime: 1.0 }],
        ["b.ts", { language: "typescript", size: 100, mtime: 1.0 }],
        ["c.go", { language: "go", size: 100, mtime: 1.0 }],
        ["d.rs", { language: "rust", size: 100, mtime: 1.0 }],
      ]),
    );
    expect(result).not.toContain("Other");
  });

  it("test_lang_breakdown_in_build_map_footer", async () => {
    const ts_project = await indexedTsProject();
    const text = repomap.build_map(ts_project, { budget_tokens: 4000 });
    expect(text.toLowerCase()).toContain("typescript");
    expect(text).not.toContain("100%");
  });
});

// ---------------------------------------------------------------------------
// build_map_mermaid
// ---------------------------------------------------------------------------

describe("build_map_mermaid", () => {
  it("test_build_map_mermaid_starts_with_graph_td", async () => {
    const ts_project = await indexedTsProject();
    const diagram = repomap.build_map_mermaid(ts_project);
    expect(diagram.startsWith("graph TD")).toBe(true);
  });

  it("test_build_map_mermaid_contains_file_node", async () => {
    const ts_project = await indexedTsProject();
    const diagram = repomap.build_map_mermaid(ts_project);
    expect(diagram).toContain("index");
  });

  it("test_build_map_mermaid_is_string", async () => {
    const ts_project = await indexedTsProject();
    const diagram = repomap.build_map_mermaid(ts_project);
    expect(typeof diagram).toBe("string");
    expect(diagram.length).toBeGreaterThan(10);
  });

  it("test_build_map_mermaid_top_n_limits_nodes", async () => {
    const projRoot = path.join(tmpPath(), "mermaid_topn");
    const src = path.join(projRoot, "src");
    fs.mkdirSync(src, { recursive: true });
    const pad = "# padding\n".repeat(6);
    for (let i = 0; i < 15; i++) {
      fs.writeFileSync(path.join(src, `mod_${String(i).padStart(2, "0")}.py`), `${pad}def fn_${i}(): pass\n`);
    }
    const proj = makeProjectAtRoot(projRoot);
    await index_project(proj, { full: true });

    const diagram5 = repomap.build_map_mermaid(proj, { top_n: 5 });
    const diagram15 = repomap.build_map_mermaid(proj, { top_n: 15 });
    const nodeLines5 = splitlines(diagram5).filter((ln) => ln.includes('["') && !ln.includes("-->"));
    const nodeLines15 = splitlines(diagram15).filter((ln) => ln.includes('["') && !ln.includes("-->"));
    expect(nodeLines5.length).toBeLessThanOrEqual(nodeLines15.length);
    expect(nodeLines5.length).toBeLessThanOrEqual(5);
  });

  it("test_mermaid_id_replaces_slashes", () => {
    const nodeId = repomap._mermaid_id("src/token_goat/db.py");
    expect(nodeId).not.toContain("/");
    expect(nodeId).not.toContain(".");
    expect(nodeId.startsWith("f_")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// build_map_since omitted-count correctness
// ---------------------------------------------------------------------------

describe("build_map_since", () => {
  it("test_build_map_since_omitted_excludes_unindexed_files", async () => {
    const projRoot = path.join(tmpPath(), "since_test");
    const src = path.join(projRoot, "src");
    fs.mkdirSync(src, { recursive: true });
    for (let i = 0; i < 3; i++) {
      fs.writeFileSync(path.join(src, `mod_${i}.py`), `def fn_${i}():\n    pass\n`);
    }
    const proj = makeProjectAtRoot(projRoot);
    await index_project(proj, { full: true });

    const changedSet = new Set([
      "src/mod_0.py",
      "src/mod_1.py",
      "new_file.py",
      "deleted_file.py",
    ]);

    const spy = vi.spyOn(repomap, "changed_files_since").mockReturnValue(changedSet);
    let text: string;
    try {
      text = repomap.build_map_since(proj, "HEAD~1", { budget_tokens: 50 });
    } finally {
      spy.mockRestore();
    }

    expect(text).toContain("Unindexed changed files:");
    expect(text.includes("new_file.py") || text.includes("deleted_file.py")).toBe(true);

    if (text.includes("+") && text.includes("more changed files")) {
      for (const line of splitlines(text)) {
        if (line.includes("more changed files")) {
          const m = line.match(/\+(\d+) more changed files/);
          expect(m).not.toBeNull();
          expect(Number(m![1])).toBeLessThanOrEqual(2);
        }
      }
    }
  });
});

// ---------------------------------------------------------------------------
// build_map --top N
// ---------------------------------------------------------------------------

describe("build_map top_n", () => {
  it("test_build_map_top_n_limit", async () => {
    const ts_project = await indexedTsProject();
    const text = repomap.build_map(ts_project, { top_n: 1 });
    const fileLines = splitlines(text)
      .map((l) => l.trim())
      .filter((l) => l && l.includes("rank:"));
    expect(fileLines.length).toBe(1);
  });

  it("test_build_map_top_n_five_files", async () => {
    const ts_project = await indexedTsProject();
    const text = repomap.build_map(ts_project, { top_n: 5 });
    const fileLines = splitlines(text)
      .map((l) => l.trim())
      .filter((l) => l && l.includes("rank:"));
    expect(fileLines.length).toBeGreaterThanOrEqual(1);
    expect(fileLines.length).toBeLessThanOrEqual(5);
  });

  it("test_build_map_top_n_format", async () => {
    const ts_project = await indexedTsProject();
    const text = repomap.build_map(ts_project, { top_n: 1 });
    const fileLines = splitlines(text).filter((line) => line.includes("rank:"));
    expect(fileLines.length).toBe(1);
    const line = fileLines[0]!;
    expect(line).toContain("(");
    expect(line).toContain(")");
    expect(line).toContain("rank:");
    expect(/^[^(]+\s*\(rank:\s*[\d.]+\)/.test(line)).toBe(true);
  });

  it("test_build_map_top_n_exceeds_available", async () => {
    const ts_project = await indexedTsProject();
    const allFiles = repomap.build_map(ts_project, { top_n: 1000 });
    const fileCount = splitlines(allFiles).filter((line) => line.includes("rank:")).length;
    expect(fileCount).toBe(1);
  });

  it("test_build_map_top_n_zero_invalid", () => {
    // top_n=0 falls through to normal build_map — no crash. (No-op in Python.)
    expect(true).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// KIND_PRIORITY / _KIND_TAG coverage
// ---------------------------------------------------------------------------

describe("KIND_PRIORITY / _KIND_TAG", () => {
  it("test_kind_priority_covers_sql_kinds", () => {
    const sqlKinds = [
      "sql_table",
      "sql_view",
      "sql_function",
      "sql_procedure",
      "sql_type",
      "sql_trigger",
      "sql_index",
      "sql_schema",
    ];
    for (const kind of sqlKinds) {
      expect(kind in repomap.KIND_PRIORITY).toBe(true);
      if (kind === "sql_table" || kind === "sql_schema") {
        expect(repomap.KIND_PRIORITY[kind]!).toBeLessThanOrEqual(1);
      }
    }
  });

  it("test_kind_priority_covers_graphql_kinds", () => {
    const graphqlKinds = [
      "graphql_type",
      "graphql_interface",
      "graphql_input",
      "graphql_enum",
      "graphql_union",
      "graphql_scalar",
      "graphql_extend",
    ];
    for (const kind of graphqlKinds) expect(kind in repomap.KIND_PRIORITY).toBe(true);
  });

  it("test_kind_priority_covers_proto_kinds", () => {
    for (const kind of ["proto_message", "proto_enum", "proto_service"]) {
      expect(kind in repomap.KIND_PRIORITY).toBe(true);
      expect(repomap.KIND_PRIORITY[kind]!).toBeLessThanOrEqual(2);
    }
  });

  it("test_kind_priority_covers_css_kinds", () => {
    for (const kind of ["css_selector", "css_rule", "css_var", "css_keyframe", "css_mixin"]) {
      expect(kind in repomap.KIND_PRIORITY).toBe(true);
    }
  });

  it("test_kind_priority_covers_make_docker_kinds", () => {
    expect("makefile_target" in repomap.KIND_PRIORITY).toBe(true);
    expect("dockerfile_stage" in repomap.KIND_PRIORITY).toBe(true);
  });

  it("test_kind_tag_covers_all_new_kinds", () => {
    for (const kind of Object.keys(repomap.KIND_PRIORITY)) {
      expect(kind in repomap._KIND_TAG).toBe(true);
    }
  });

  it("test_kind_tag_sql_short_form", () => {
    expect(repomap._KIND_TAG["sql_table"]).toBe("tbl");
    expect(repomap._KIND_TAG["sql_view"]).toBe("view");
    expect(repomap._KIND_TAG["sql_procedure"]).toBe("proc");
    expect(repomap._KIND_TAG["sql_trigger"]).toBe("trig");
  });

  it("test_kind_tag_graphql_proto_short_form", () => {
    expect(repomap._KIND_TAG["proto_message"]).toBe("msg");
    expect(repomap._KIND_TAG["proto_service"]).toBe("svc");
    expect(repomap._KIND_TAG["graphql_extend"]).toBe("ext");
  });

  it("test_render_summary_new_kinds_use_short_tags", () => {
    const s = new repomap.FileSummary({
      rel_path: "schema.sql",
      language: "sql",
      rank: 0.5,
      top_symbols: [
        ["sql_table", "users"],
        ["sql_view", "active_users"],
        ["sql_function", "get_user"],
      ],
      top_sections: [],
      line_count: 80,
    });
    const text = repomap.render_summary(s);
    expect(text).toContain("tbl:");
    expect(text).toContain("view:");
    expect(text).not.toContain("sql_table:");
    expect(text).not.toContain("sql_view:");
    expect(text).not.toContain("sql_function:");
  });

  it("test_render_summary_graphql_kinds_short_tags", () => {
    const s = new repomap.FileSummary({
      rel_path: "schema.graphql",
      language: "graphql",
      rank: 0.3,
      top_symbols: [
        ["graphql_type", "User"],
        ["graphql_interface", "Node"],
        ["graphql_enum", "Status"],
      ],
      top_sections: [],
      line_count: 60,
    });
    const text = repomap.render_summary(s);
    expect(text.includes("ty:") || text.includes("iface:") || text.includes("enum:")).toBe(true);
    expect(text).not.toContain("graphql_type:");
    expect(text).not.toContain("graphql_interface:");
  });
});

// ---------------------------------------------------------------------------
// _build_compact_file_summary extension-count format
// ---------------------------------------------------------------------------

describe("_build_compact_file_summary ext counts", () => {
  const ranked = (
    paths: string[],
  ): Array<[string, { language: string; size: number; mtime: number }]> =>
    paths.map((p) => [p, { language: "python", size: 0, mtime: 0 }]);

  it("test_build_compact_file_summary_default_format", () => {
    const line = repomap._build_compact_file_summary(ranked(["src/a.py", "src/b.py", "src/c.py"]), 3, 2);
    expect(line.startsWith("3 files indexed. Top modules:")).toBe(true);
    expect(line.includes("a.py") || line.includes("b.py")).toBe(true);
  });

  it("test_build_compact_file_summary_ext_counts_single_extension", () => {
    const line = repomap._build_compact_file_summary(
      ranked(["src/a.py", "src/b.py", "src/c.py"]),
      3,
      2,
      true,
    );
    expect(line.startsWith("3 files:")).toBe(true);
    expect(line).toContain(".py");
    expect(line).toContain("3 .py");
  });

  it("test_build_compact_file_summary_ext_counts_polyglot", () => {
    const line = repomap._build_compact_file_summary(
      ranked(["src/a.py", "src/b.py", "src/c.py", "src/d.ts", "src/e.ts", "db/schema.sql"]),
      6,
      2,
      true,
    );
    expect(line.startsWith("6 files:")).toBe(true);
    expect(line).toContain(".py");
    expect(line).toContain(".ts");
    expect(line).toContain(".sql");
    expect(line).toContain("3 .py");
    expect(line).toContain("2 .ts");
    expect(line).toContain("1 .sql");
  });

  it("test_build_compact_file_summary_ext_counts_collapses_many_types", () => {
    const line = repomap._build_compact_file_summary(
      ranked(["a.py", "b.ts", "c.sql", "d.graphql", "e.proto", "f.css"]),
      6,
      2,
      true,
    );
    expect(line.includes("+2 more types") || line.includes("+1 more types")).toBe(true);
  });

  it("test_build_compact_file_summary_ext_counts_format_has_top_modules", () => {
    const line = repomap._build_compact_file_summary(ranked(["src/main.py", "src/helper.ts"]), 2, 1, true);
    expect(line).toContain("Top:");
  });
});

// ---------------------------------------------------------------------------
// Polyglot vs monolingual compact summary
// ---------------------------------------------------------------------------

describe("polyglot compact summary", () => {
  it("test_build_map_polyglot_compact_summary_uses_ext_counts", async () => {
    const projRoot = path.join(tmpPath(), "polyglot_compact");
    const src = path.join(projRoot, "src");
    fs.mkdirSync(src, { recursive: true });
    const pyPad = "# padding to clear min-lines threshold\n".repeat(6);
    const tsPad = "// padding to clear min-lines threshold\n".repeat(6);
    for (let i = 0; i < 30; i++) {
      fs.writeFileSync(path.join(src, `mod_${String(i).padStart(3, "0")}.py`), `${pyPad}def fn_${i}():\n    pass\n`);
    }
    for (let i = 0; i < 25; i++) {
      fs.writeFileSync(
        path.join(src, `mod_${String(i).padStart(3, "0")}.ts`),
        `${tsPad}export function fn${i}(): void {}\n`,
      );
    }
    const proj = makeProjectAtRoot(projRoot);
    await index_project(proj, { full: true });

    const text = repomap.build_map(proj, {
      budget_tokens: 300,
      compact: true,
      compact_file_threshold: 50,
    });
    expect(text).toContain("files:");
    expect(text).toContain(".py");
    expect(text).toContain(".ts");
  });

  it("test_build_map_monolingual_compact_summary_uses_legacy_format", async () => {
    const projRoot = path.join(tmpPath(), "mono_compact");
    const src = path.join(projRoot, "src");
    fs.mkdirSync(src, { recursive: true });
    const pad = "# padding to clear min-lines threshold\n".repeat(6);
    for (let i = 0; i < 60; i++) {
      fs.writeFileSync(path.join(src, `mod_${String(i).padStart(3, "0")}.py`), `${pad}def fn_${i}():\n    pass\n`);
    }
    const proj = makeProjectAtRoot(projRoot);
    await index_project(proj, { full: true });

    const text = repomap.build_map(proj, {
      budget_tokens: 300,
      compact: true,
      compact_file_threshold: 50,
    });
    expect(text).toContain("files indexed. Top modules:");
  });
});
