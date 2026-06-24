/**
 * 1:1 port of tests/test_zero_symbol_hint.py.
 *
 * Tests the zero-indexed-symbols hint guard: when a `symbol NAME --file F`
 * lookup misses, or `outline F` finds nothing, the post-miss guidance must not
 * point at skeleton/outline for a file that has zero indexed symbols.
 *
 * The Python suite calls db.count_symbols_for_file; that helper is inlined as
 * read_commands._count_symbols_for_file (not exported) in the TS port, so these
 * tests read the symbol count directly via the DB (identical observable result).
 * The hint helpers tested (skeleton_or_empty_hint, resolve_scoped_file) and the
 * outline zero-symbol branch are already ported in read_commands.ts.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import * as db from "../src/token_goat/db.js";
import * as read_commands from "../src/token_goat/read_commands.js";
import { index_project } from "../src/token_goat/parser.js";
import { make_project_at } from "../src/token_goat/project.js";
import { invoke } from "./_cli_runner.js";

// app.py carries one real symbol; config_blank.py is indexed but symbol-free.
const _FILES: Record<string, string> = {
  "app.py": "def handler():\n    return 1\n",
  "config_blank.py": "# config only, no indexed symbols here\n",
};

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

/** Index a throwaway project containing *files* (rel name → content). */
async function _makeZshProject(
  files: Record<string, string> = _FILES,
): Promise<{ root: string; proj_hash: string }> {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), `tg-zsh-${process.pid}-`));
  _tmpRoots.push(base);
  const root = fs.realpathSync(base);
  const projRoot = path.join(root, "zsh_proj");
  fs.mkdirSync(path.join(projRoot, ".git"), { recursive: true });
  for (const [name, content] of Object.entries(files)) {
    const filePath = path.join(projRoot, name);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, content, "utf-8");
  }
  const proj = make_project_at(projRoot);
  await index_project(proj, { full: true });
  return { root: projRoot, proj_hash: proj.hash };
}

/** Count indexed symbols for a single file (read_commands._count_symbols_for_file inline). */
function countSymbolsForFile(projectHash: string, fileRel: string): number {
  try {
    return db.openProjectReadonly(projectHash, (conn) => {
      const row = conn.prepare("SELECT COUNT(*) AS n FROM symbols WHERE file_rel = ?").get(fileRel) as
        | { n?: number }
        | undefined;
      return row ? Number(row.n) : 0;
    });
  } catch {
    return 0;
  }
}

// ---------------------------------------------------------------------------
// Preconditions: count_symbols_for_file distinguishes symbol-free from missing
// ---------------------------------------------------------------------------

describe("TestCountSymbolsForFile", () => {
  it("test_counts_distinguish_symbol_and_blank_files", async () => {
    const { proj_hash } = await _makeZshProject();
    expect(countSymbolsForFile(proj_hash, "app.py")).toBeGreaterThanOrEqual(1);
    expect(countSymbolsForFile(proj_hash, "config_blank.py")).toBe(0);
  });

  it("test_missing_db_returns_zero", () => {
    // A project hash with no DB on disk must read as 0, not raise.
    expect(countSymbolsForFile("deadbeef".repeat(8), "whatever.py")).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// skeleton_or_empty_hint + resolve_scoped_file helpers
// ---------------------------------------------------------------------------

describe("TestHintHelpers", () => {
  it("test_skeleton_hint_for_file_with_symbols", async () => {
    const { proj_hash } = await _makeZshProject();
    const hint = read_commands.skeleton_or_empty_hint(proj_hash, "app.py");
    expect(hint).toContain("skeleton");
    expect(hint).toContain("app.py");
    expect(hint).not.toContain("no indexed symbols");
  });

  it("test_note_for_zero_symbol_file", async () => {
    const { proj_hash } = await _makeZshProject();
    const hint = read_commands.skeleton_or_empty_hint(proj_hash, "config_blank.py");
    expect(hint).toContain("no indexed symbols");
    expect(hint).toContain("config_blank.py");
    // The misleading skeleton suggestion must be gone for a symbol-free file.
    expect(hint).not.toContain("skeleton");
  });

  it("test_resolve_scoped_file_single_match", async () => {
    const { proj_hash } = await _makeZshProject();
    expect(read_commands.resolve_scoped_file(proj_hash, "%app.py%")).toBe("app.py");
    // Resolves a symbol-free file too — it queries the files table, not symbols.
    expect(read_commands.resolve_scoped_file(proj_hash, "%config_blank.py%")).toBe("config_blank.py");
  });

  it("test_resolve_scoped_file_ambiguous_and_missing_return_none", async () => {
    const { proj_hash } = await _makeZshProject();
    // ".py" matches both files — ambiguous scope must not resolve to one.
    expect(read_commands.resolve_scoped_file(proj_hash, "%.py%")).toBeNull();
    // A scope matching no indexed file resolves to None.
    expect(read_commands.resolve_scoped_file(proj_hash, "%nosuchfile.py%")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// symbol --file miss path (CLI)
// ---------------------------------------------------------------------------

describe("TestSymbolFileScopeMiss", () => {
  async function runFromRoot(root: string, args: string[]) {
    _savedCwd = process.cwd();
    process.chdir(root);
    return invoke(args);
  }

  it("test_file_with_symbols_shows_skeleton_hint", async () => {
    const { root } = await _makeZshProject();
    const r = await runFromRoot(root, ["symbol", "nonexistent", "app.py"]);
    expect(r.exit_code).toBe(1);
    expect(r.output).toContain("No symbol 'nonexistent' found");
    expect(r.output).toContain("skeleton");
    expect(r.output).not.toContain("no indexed symbols");
  });

  it("test_zero_symbol_file_shows_note", async () => {
    const { root } = await _makeZshProject();
    const r = await runFromRoot(root, ["symbol", "nonexistent", "config_blank.py"]);
    expect(r.exit_code).toBe(1);
    expect(r.output).toContain("no indexed symbols");
    // The skeleton suggestion must be suppressed for the symbol-free file.
    expect(r.output).not.toContain("token-goat skeleton");
  });

  it("test_unmatched_file_scope_unchanged", async () => {
    const { root } = await _makeZshProject();
    const r = await runFromRoot(root, ["symbol", "anything", "nosuchfile.py"]);
    expect(r.exit_code).toBe(1);
    expect(r.output).toContain("No symbol 'anything' found in files matching 'nosuchfile.py'");
    // No file resolved, so neither the skeleton hint nor the note appears.
    expect(r.output).not.toContain("skeleton");
    expect(r.output).not.toContain("no indexed symbols");
  });

  it("test_zero_symbol_file_json_carries_file_hint", async () => {
    const { root } = await _makeZshProject();
    const r = await runFromRoot(root, ["symbol", "--json", "nonexistent", "config_blank.py"]);
    const data = JSON.parse(r.stdout.trim());
    expect(data.total).toBe(0);
    expect(data.file_hint).toContain("no indexed symbols");
  });
});

// ---------------------------------------------------------------------------
// outline zero-symbol branch
// ---------------------------------------------------------------------------

describe("TestOutlineZeroSymbol", () => {
  it("test_outline_zero_symbol_file_emits_note", async () => {
    const { root } = await _makeZshProject();
    _savedCwd = process.cwd();
    process.chdir(root);
    const r = await invoke(["outline", path.join(root, "config_blank.py")]);
    expect(r.output).toContain("no indexed symbols");
    // The generic "run index --full" guidance must not be shown for an indexed,
    // symbol-free file.
    expect(r.output).not.toContain("index --full");
  });

  it("test_outline_filtered_symbols_keeps_existing_message", async () => {
    // app.py HAS a symbol; --min-lines filters it out so rows_with_depth is
    // empty while count > 0. The branch must keep the original message.
    const { root } = await _makeZshProject();
    _savedCwd = process.cwd();
    process.chdir(root);
    const r = await invoke(["outline", "--min-lines", "100", path.join(root, "app.py")]);
    expect(r.output).toContain("No indexed top-level symbols found");
    expect(r.output).not.toContain("no indexed symbols —");
  });
});
