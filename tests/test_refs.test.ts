/**
 * 1:1 port of tests/test_refs.py.
 *
 * Tests db.get_symbol_refs / db.get_refs_with_callers, the refs <file>::<symbol>
 * CLI command (delegates to read_commands.refs), the plain-symbol refs command,
 * and the --callers flag. Uses the shared ts_sample fixture indexed into a tmp
 * project, same as test_symbol_cli.test.ts.
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
  const base = fs.mkdtempSync(path.join(os.tmpdir(), `tg-refs-${process.pid}-${_tmpRoots.length}-`));
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

// ---------------------------------------------------------------------------
// db.get_symbol_refs
// ---------------------------------------------------------------------------

describe("db.get_symbol_refs", () => {
  it("test_get_symbol_refs_returns_list", async () => {
    const { proj_hash } = await indexedTsDir();
    const rows = db.get_symbol_refs(proj_hash, "index.ts", "greet");
    expect(Array.isArray(rows)).toBe(true);
  });

  it("test_get_symbol_refs_finds_callers", async () => {
    const { proj_hash } = await indexedTsDir();
    const rows = db.get_symbol_refs(proj_hash, "index.ts", "greet");
    expect(rows.length).toBeGreaterThanOrEqual(1);
    const row = rows[0]!;
    expect("path" in row).toBe(true);
    expect("line" in row).toBe(true);
    expect(typeof row.line).toBe("number");
    expect("context" in row).toBe(true);
  });

  it("test_get_symbol_refs_unknown_symbol_returns_empty", async () => {
    const { proj_hash } = await indexedTsDir();
    const rows = db.get_symbol_refs(proj_hash, "index.ts", "__no_such_symbol_xyz__");
    expect(rows).toEqual([]);
  });

  it("test_get_symbol_refs_unknown_project_returns_empty", async () => {
    // Non-existent project hash returns [] (fail-soft, no throw).
    const rows = db.get_symbol_refs("nonexistent_project_hash_abc123", "index.ts", "greet");
    expect(rows).toEqual([]);
  });

  it("test_get_symbol_refs_respects_limit", async () => {
    const { proj_hash } = await indexedTsDir();
    const rows = db.get_symbol_refs(proj_hash, "index.ts", "greet", 1);
    expect(rows.length).toBeLessThanOrEqual(1);
  });
});

// ---------------------------------------------------------------------------
// read_commands.refs — plain text output (via the refs CLI command, :: format)
// ---------------------------------------------------------------------------

describe("refs <file>::<symbol> command (read_commands.refs)", () => {
  it("test_refs_command_finds_results", async () => {
    await indexedTsDir();
    const r = await invoke(["refs", "index.ts::greet"]);
    expect(r.exit_code).toBe(0);
    expect(r.output.toLowerCase()).toContain("reference");
    const lines = r.output.split("\n").filter((l) => l.includes(":") && !l.startsWith("#"));
    expect(lines.length).toBeGreaterThanOrEqual(1);
  });

  it("test_refs_command_output_format", async () => {
    await indexedTsDir();
    const r = await invoke(["refs", "index.ts::greet"]);
    expect(r.exit_code).toBe(0);
    const refLines = r.output
      .split("\n")
      .filter((l) => l.length > 0 && l.includes(":") && !l.toLowerCase().includes("reference"));
    for (const line of refLines) {
      const parts = line.split(":");
      expect(parts.length).toBeGreaterThanOrEqual(2);
    }
  });

  it("test_refs_command_no_refs — 'no references'", async () => {
    await indexedTsDir();
    const r = await invoke(["refs", "index.ts::__no_such_symbol_xyz__"]);
    expect(r.exit_code).toBe(0);
    expect(r.output.toLowerCase()).toContain("no references");
  });

  it("test_refs_command_invalid_format — empty symbol after ::", async () => {
    await indexedTsDir();
    const r = await invoke(["refs", "index.ts::"]);
    expect(r.exit_code).not.toBe(0);
  });
});

// ---------------------------------------------------------------------------
// --json mode
// ---------------------------------------------------------------------------

describe("refs --json", () => {
  it("test_refs_json_output", async () => {
    await indexedTsDir();
    const r = await invoke(["refs", "index.ts::greet", "--json"]);
    expect(r.exit_code).toBe(0);
    const data = JSON.parse(r.stdout.trim());
    expect("file" in data).toBe(true);
    expect("symbol" in data).toBe(true);
    expect("refs" in data).toBe(true);
    expect(data.symbol).toBe("greet");
    expect(Array.isArray(data.refs)).toBe(true);
  });

  it("test_refs_json_refs_have_expected_keys", async () => {
    await indexedTsDir();
    const r = await invoke(["refs", "index.ts::greet", "--json"]);
    expect(r.exit_code).toBe(0);
    const data = JSON.parse(r.stdout.trim());
    if (data.refs.length > 0) {
      const row = data.refs[0];
      expect("path" in row).toBe(true);
      expect("line" in row).toBe(true);
      expect(typeof row.line).toBe("number");
      expect("context" in row).toBe(true);
    }
  });

  it("test_refs_json_no_refs — empty refs list", async () => {
    await indexedTsDir();
    const r = await invoke(["refs", "index.ts::__no_such_symbol_xyz__", "--json"]);
    expect(r.exit_code).toBe(0);
    const data = JSON.parse(r.stdout.trim());
    expect(data.refs).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Backward compat: plain refs command still works
// ---------------------------------------------------------------------------

describe("refs plain symbol (no ::)", () => {
  it("test_refs_plain_symbol_still_works", async () => {
    await indexedTsDir();
    const r = await invoke(["refs", "greet"]);
    expect(r.exit_code).toBe(0);
    const lines = r.output.split("\n").filter((l) => l.trim().length > 0);
    expect(lines.length).toBeGreaterThanOrEqual(1);
  });
});

// ---------------------------------------------------------------------------
// --callers flag — db.get_refs_with_callers
// ---------------------------------------------------------------------------

describe("db.get_refs_with_callers", () => {
  it("test_get_refs_with_callers_returns_list", async () => {
    const { proj_hash } = await indexedTsDir();
    const rows = db.get_refs_with_callers(proj_hash, "index.ts", "greet");
    expect(Array.isArray(rows)).toBe(true);
  });

  it("test_get_refs_with_callers_row_keys", async () => {
    const { proj_hash } = await indexedTsDir();
    const rows = db.get_refs_with_callers(proj_hash, "index.ts", "greet");
    expect(rows.length).toBeGreaterThanOrEqual(1);
    const row = rows[0]!;
    expect("path" in row).toBe(true);
    expect("line" in row).toBe(true);
    expect("context" in row).toBe(true);
    expect("caller_name" in row).toBe(true);
    expect("caller_kind" in row).toBe(true);
  });

  it("test_get_refs_with_callers_finds_enclosing_method — 'hello'", async () => {
    const { proj_hash } = await indexedTsDir();
    const rows = db.get_refs_with_callers(proj_hash, "index.ts", "greet");
    expect(rows.length).toBeGreaterThanOrEqual(1);
    const callersFound = rows.filter((r) => r.caller_name !== null);
    expect(callersFound.length).toBeGreaterThanOrEqual(1);
    const callerNames = new Set(callersFound.map((r) => r.caller_name));
    expect(callerNames.has("hello")).toBe(true);
  });

  it("test_get_refs_with_callers_unknown_symbol_returns_empty", async () => {
    const { proj_hash } = await indexedTsDir();
    const rows = db.get_refs_with_callers(proj_hash, "index.ts", "__no_such_symbol_xyz__");
    expect(rows).toEqual([]);
  });

  it("test_get_refs_with_callers_unknown_project_returns_empty", async () => {
    const rows = db.get_refs_with_callers("nonexistent_project_hash_abc123", "index.ts", "greet");
    expect(rows).toEqual([]);
  });

  it("test_get_refs_with_callers_respects_limit", async () => {
    const { proj_hash } = await indexedTsDir();
    const rows = db.get_refs_with_callers(proj_hash, "index.ts", "greet", 1);
    expect(rows.length).toBeLessThanOrEqual(1);
  });
});

// ---------------------------------------------------------------------------
// --callers CLI flag
// ---------------------------------------------------------------------------

describe("refs --callers CLI flag", () => {
  it("test_refs_callers_flag_output_format", async () => {
    await indexedTsDir();
    const r = await invoke(["refs", "index.ts::greet", "--callers"]);
    expect(r.exit_code).toBe(0);
    expect(r.output.toLowerCase()).toContain("reference");
    // File group header: a line ending with ':' that doesn't start with a space.
    const fileHeaderLines = r.output
      .split("\n")
      .filter((l) => l.endsWith(":") && !l.startsWith(" "));
    expect(fileHeaderLines.length).toBeGreaterThanOrEqual(1);
    // Indented caller entry.
    const indentedLines = r.output.split("\n").filter((l) => l.startsWith("  "));
    expect(indentedLines.length).toBeGreaterThanOrEqual(1);
    for (const line of indentedLines) {
      expect(line.includes("at line")).toBe(true);
    }
  });

  it("test_refs_callers_flag_shows_enclosing_method — 'hello()'", async () => {
    await indexedTsDir();
    const r = await invoke(["refs", "index.ts::greet", "--callers"]);
    expect(r.exit_code).toBe(0);
    expect(r.output).toContain("hello()");
  });

  it("test_refs_callers_no_refs — 'no references'", async () => {
    await indexedTsDir();
    const r = await invoke(["refs", "index.ts::__no_such_symbol_xyz__", "--callers"]);
    expect(r.exit_code).toBe(0);
    expect(r.output.toLowerCase()).toContain("no references");
  });

  it("test_refs_callers_requires_file_symbol_format — plain symbol errors", async () => {
    await indexedTsDir();
    const r = await invoke(["refs", "greet", "--callers"]);
    expect(r.exit_code).not.toBe(0);
  });

  it("test_refs_callers_json_includes_caller_fields", async () => {
    await indexedTsDir();
    const r = await invoke(["refs", "index.ts::greet", "--callers", "--json"]);
    expect(r.exit_code).toBe(0);
    const data = JSON.parse(r.stdout.trim());
    expect("refs" in data).toBe(true);
    expect(data.refs.length).toBeGreaterThanOrEqual(1);
    const row = data.refs[0];
    expect("caller_name" in row).toBe(true);
    expect("caller_kind" in row).toBe(true);
  });
});
