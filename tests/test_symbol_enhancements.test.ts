/**
 * 1:1 port of tests/test_symbol_enhancements.py.
 *
 * Two flavours:
 *  (a) Pure unit tests on the helpers (_is_glob_pattern, _glob_to_sql_like,
 *      _symbol_kind_filter, _rank_symbol_results, _symbol_json_snippet,
 *      _enrich_symbols_with_snippets) — imported directly.
 *  (b) CLI integration tests that monkeypatch the project + DB boundaries.
 *      Python patches `cli._require_project` / `cli._query_project` /
 *      `cli._project_symbol_pool` / `read_commands._not_indexed_hint`. The TS
 *      port spies on the SAME names off the `cliLookup` / `read_commands`
 *      namespaces; cli_lookup.ts routes these through `import * as self`, so
 *      the spies are observed (ESM live-binding).
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import * as cliLookup from "../src/token_goat/cli_lookup.js";
import * as read_commands from "../src/token_goat/read_commands.js";
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

function tmpPath(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `tg-semb-${process.pid}-${_tmpRoots.length}-`));
  _tmpRoots.push(dir);
  return dir;
}

// ---------------------------------------------------------------------------
// TestIsGlobPattern
// ---------------------------------------------------------------------------

describe("TestIsGlobPattern", () => {
  it("test_star_is_glob", () => {
    expect(cliLookup._is_glob_pattern("get_*")).toBe(true);
  });
  it("test_question_mark_is_glob", () => {
    expect(cliLookup._is_glob_pattern("get_?")).toBe(true);
  });
  it("test_plain_name_is_not_glob", () => {
    expect(cliLookup._is_glob_pattern("getUser")).toBe(false);
  });
  it("test_empty_string_is_not_glob", () => {
    expect(cliLookup._is_glob_pattern("")).toBe(false);
  });
  it("test_trailing_star_is_glob", () => {
    expect(cliLookup._is_glob_pattern("*")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// TestGlobToSqlLike
// ---------------------------------------------------------------------------

describe("TestGlobToSqlLike", () => {
  it("test_star_becomes_percent", () => {
    // literal _ is escaped to \_ before * becomes %
    expect(cliLookup._glob_to_sql_like("get_*")).toBe("get\\_%");
  });
  it("test_question_becomes_underscore", () => {
    expect(cliLookup._glob_to_sql_like("get_?")).toBe("get\\__");
  });
  it("test_literal_percent_is_escaped", () => {
    expect(cliLookup._glob_to_sql_like("foo%bar")).toBe("foo\\%bar");
  });
  it("test_literal_underscore_is_escaped", () => {
    expect(cliLookup._glob_to_sql_like("foo_bar")).toBe("foo\\_bar");
  });
  it("test_no_special_chars_unchanged", () => {
    expect(cliLookup._glob_to_sql_like("getUser")).toBe("getUser");
  });
  it("test_prefix_glob", () => {
    expect(cliLookup._glob_to_sql_like("get*")).toBe("get%");
  });
});

// ---------------------------------------------------------------------------
// TestSymbolKindFilter
// ---------------------------------------------------------------------------

describe("TestSymbolKindFilter", () => {
  it("test_fn_expands_to_function", () => {
    expect(cliLookup._symbol_kind_filter(["fn"])).toEqual(["function"]);
  });
  it("test_func_expands_to_function", () => {
    expect(cliLookup._symbol_kind_filter(["func"])).toEqual(["function"]);
  });
  it("test_multiple_kinds_preserved", () => {
    expect(cliLookup._symbol_kind_filter(["fn", "class"])).toEqual(["function", "class"]);
  });
  it("test_duplicate_deduplication", () => {
    expect(cliLookup._symbol_kind_filter(["fn", "func"])).toEqual(["function"]);
  });
  it("test_passthrough_for_unknown", () => {
    expect(cliLookup._symbol_kind_filter(["method"])).toEqual(["method"]);
  });
  it("test_case_insensitive", () => {
    expect(cliLookup._symbol_kind_filter(["FN"])).toEqual(["function"]);
  });
  it("test_empty_list", () => {
    expect(cliLookup._symbol_kind_filter([])).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// TestRankSymbolResults
// ---------------------------------------------------------------------------

function _makeRow(name: string, kind = "function"): Record<string, unknown> {
  return { name, kind, file: "a.py", line: 1, signature: "" };
}

describe("TestRankSymbolResults", () => {
  it("test_exact_match_first", () => {
    const rows = [
      _makeRow("get_user_by_id"),
      _makeRow("get_user"),
      _makeRow("_get_user"),
    ];
    const ranked = cliLookup._rank_symbol_results(rows, "get_user");
    expect(ranked[0]!.name).toBe("get_user");
  });

  it("test_prefix_before_substring", () => {
    const rows = [
      _makeRow("_get_user"),
      _makeRow("get_user_by_id"),
      _makeRow("get_user"),
    ];
    const ranked = cliLookup._rank_symbol_results(rows, "get_user");
    const names = ranked.map((r) => r.name);
    expect(names[0]).toBe("get_user");
    expect(names[1]).toBe("get_user_by_id");
    expect(names[2]).toBe("_get_user");
  });

  it("test_case_insensitive_tier_assignment", () => {
    const rows = [_makeRow("GetUser"), _makeRow("getUser")];
    const ranked = cliLookup._rank_symbol_results(rows, "getuser");
    expect(["GetUser", "getUser"]).toContain(ranked[0]!.name);
  });

  it("test_glob_query_returns_original_order", () => {
    const rows = [_makeRow("get_z"), _makeRow("get_a"), _makeRow("get_m")];
    const ranked = cliLookup._rank_symbol_results(rows, "get_*");
    expect(ranked.map((r) => r.name)).toEqual(["get_z", "get_a", "get_m"]);
  });

  it("test_empty_results_returns_empty", () => {
    expect(cliLookup._rank_symbol_results([], "foo")).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// TestSymbolTypeFilter — CLI integration with stubbed DB
// ---------------------------------------------------------------------------

const _FAKE_PROJECT = {
  hash: "0".repeat(64),
  root: "/fake/root",
  marker: ".git",
};

/**
 * Install stubs that record the SQL/params the symbol command builds, and
 * return empty rows. Python patched `cli._require_project` + `cli._query_project`
 * + `read_commands._not_indexed_hint`; the TS port spies on the same names on
 * the cliLookup + read_commands namespaces (cli_lookup routes through `self`).
 */
function _installRecordingQuery(): { sqls: string[]; params: unknown[][] } {
  const sqls: string[] = [];
  const params: unknown[][] = [];
  vi.spyOn(cliLookup, "_require_project").mockResolvedValue(_FAKE_PROJECT);
  vi.spyOn(cliLookup, "_query_project").mockImplementation((_h, sql, p) => {
    sqls.push(sql);
    params.push([...p]);
    return [];
  });
  vi.spyOn(read_commands, "_not_indexed_hint").mockReturnValue(null);
  return { sqls, params };
}

describe("TestSymbolTypeFilter", () => {
  it("test_type_filter_fn_excludes_non_functions", async () => {
    const { sqls, params } = _installRecordingQuery();
    const r = await invoke(["symbol", "login", "--type", "fn"]);
    expect(r.exit_code).toBe(0);
    expect(sqls.length).toBeGreaterThan(0);
    expect(sqls[0]!.includes("kind IN")).toBe(true);
    expect(params[0]!.includes("function")).toBe(true);
  });

  it("test_multiple_type_flags", async () => {
    const { params } = _installRecordingQuery();
    const r = await invoke(["symbol", "login", "--type", "fn", "--type", "method"]);
    expect(r.exit_code).toBe(0);
    expect(params.length).toBeGreaterThan(0);
    expect(params[0]!.includes("function")).toBe(true);
    expect(params[0]!.includes("method")).toBe(true);
  });

  it("test_no_type_flag_no_kind_clause", async () => {
    const { sqls } = _installRecordingQuery();
    const r = await invoke(["symbol", "login"]);
    expect(r.exit_code).toBe(0);
    expect(sqls.length === 0 || !sqls[0]!.includes("kind IN")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// TestSymbolGlobCli
// ---------------------------------------------------------------------------

describe("TestSymbolGlobCli", () => {
  it("test_glob_uses_like_in_sql", async () => {
    const { sqls, params } = _installRecordingQuery();
    const r = await invoke(["symbol", "get_*"]);
    expect(r.exit_code).toBe(0);
    expect(sqls.length).toBeGreaterThan(0);
    expect(sqls[0]!.includes("LIKE")).toBe(true);
    // literal _ in the query is escaped to \_ before * becomes %
    expect(params[0]!.includes("get\\_%")).toBe(true);
  });

  it("test_glob_skips_close_match_redirect", async () => {
    vi.spyOn(cliLookup, "_require_project").mockResolvedValue(_FAKE_PROJECT);
    vi.spyOn(cliLookup, "_query_project").mockReturnValue([]);
    const poolCalled: boolean[] = [];
    vi.spyOn(cliLookup, "_project_symbol_pool").mockImplementation(() => {
      poolCalled.push(true);
      return ["get_user", "set_user"];
    });
    vi.spyOn(read_commands, "_not_indexed_hint").mockReturnValue(null);

    const r = await invoke(["symbol", "get_*"]);
    expect(r.exit_code).toBe(0);
    expect(poolCalled.length).toBe(0); // pool must not be queried for globs
  });

  it("test_exact_name_uses_equality", async () => {
    const { sqls } = _installRecordingQuery();
    const r = await invoke(["symbol", "getUser"]);
    expect(r.exit_code).toBe(0);
    expect(sqls.length).toBeGreaterThan(0);
    expect(sqls[0]!.includes("LIKE")).toBe(false);
    expect(sqls[0]!.includes("name = ?")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// TestSymbolJsonSnippet
// ---------------------------------------------------------------------------

describe("TestSymbolJsonSnippet", () => {
  it("test_returns_first_lines_of_function", () => {
    const tmp = tmpPath();
    const src = "def greet(name):\n    return f'hello {name}'\n\n\ndef other():\n    pass\n";
    fs.writeFileSync(path.join(tmp, "sample.py"), src, "utf-8");
    const snippet = cliLookup._symbol_json_snippet(tmp, "sample.py", 1, 2);
    expect(snippet).not.toBeNull();
    expect(snippet!).toContain("def greet");
    expect(snippet!).toContain("return");
  });

  it("test_missing_file_returns_none", () => {
    const tmp = tmpPath();
    const result = cliLookup._symbol_json_snippet(tmp, "nonexistent.py", 1, 5);
    expect(result).toBeNull();
  });

  it("test_caps_at_max_snippet_lines", () => {
    const tmp = tmpPath();
    const lines = Array.from({ length: 50 }, (_, i) => `line_${i} = ${i}\n`);
    fs.writeFileSync(path.join(tmp, "big.py"), lines.join(""), "utf-8");
    const snippet = cliLookup._symbol_json_snippet(tmp, "big.py", 1, 50, 5);
    expect(snippet).not.toBeNull();
    // ≤ 5 lines means ≤ 4 newlines inside.
    expect(snippet!.split("\n").length - 1).toBeLessThan(5);
  });
});

// ---------------------------------------------------------------------------
// TestEnrichSymbolsWithSnippets
// ---------------------------------------------------------------------------

describe("TestEnrichSymbolsWithSnippets", () => {
  it("test_adds_symbol_key", () => {
    const tmp = tmpPath();
    const results: Array<Record<string, unknown>> = [
      { name: "foo", file: "nonexistent.py", line: 1 },
    ];
    cliLookup._enrich_symbols_with_snippets(results, tmp, new Map());
    expect(results[0]!.symbol).toBe("foo");
  });

  it("test_adds_snippet_from_source", () => {
    const tmp = tmpPath();
    const src = "def compute(x):\n    return x * 2\n";
    fs.writeFileSync(path.join(tmp, "calc.py"), src, "utf-8");
    const results: Array<Record<string, unknown>> = [
      { name: "compute", file: "calc.py", line: 1 },
    ];
    const end_lines = new Map<string, number | null>([["calc.py 1", 2]]);
    cliLookup._enrich_symbols_with_snippets(results, tmp, end_lines);
    expect((results[0]!.snippet as string | null) ?? "").toContain("def compute");
  });

  it("test_snippet_none_for_missing_file", () => {
    const tmp = tmpPath();
    const results: Array<Record<string, unknown>> = [
      { name: "missing_fn", file: "ghost.py", line: 5 },
    ];
    cliLookup._enrich_symbols_with_snippets(results, tmp, new Map());
    expect(results[0]!.snippet).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// TestSymbolJsonCliOutput — symbol --json includes symbol + snippet
// ---------------------------------------------------------------------------

describe("TestSymbolJsonCliOutput", () => {
  function setupFakeProject(tmp: string): void {
    const src = "def hello_world():\n    return 'hello'\n";
    fs.writeFileSync(path.join(tmp, "greet.py"), src, "utf-8");
    const fakeRow = {
      name: "hello_world",
      kind: "function",
      file_rel: "greet.py",
      line: 1,
      end_line: 2,
      signature: "()",
    };
    const fakeProject = { hash: "a".repeat(64), root: tmp, marker: ".git" };
    vi.spyOn(cliLookup, "_require_project").mockResolvedValue(fakeProject);
    vi.spyOn(cliLookup, "_query_project").mockReturnValue([fakeRow]);
    vi.spyOn(read_commands, "_not_indexed_hint").mockReturnValue(null);
  }

  it("test_json_output_has_symbol_key", async () => {
    const tmp = tmpPath();
    setupFakeProject(tmp);
    const r = await invoke(["symbol", "hello_world", "--json"]);
    expect(r.exit_code).toBe(0);
    const data = JSON.parse(r.stdout.trim());
    expect(data).toBeTypeOf("object");
    expect(data.query).toBe("hello_world");
    expect(data.results.length).toBeGreaterThanOrEqual(1);
    expect(data.results[0].symbol).toBe("hello_world");
  });

  it("test_json_output_has_snippet_key", async () => {
    const tmp = tmpPath();
    setupFakeProject(tmp);
    const r = await invoke(["symbol", "hello_world", "--json"]);
    expect(r.exit_code).toBe(0);
    const data = JSON.parse(r.stdout.trim());
    expect(data).toBeTypeOf("object");
    expect(data.results.length).toBeGreaterThanOrEqual(1);
    const snippet = data.results[0].snippet;
    expect(snippet).not.toBeNull();
    expect(snippet).toContain("hello_world");
  });
});
