/**
 * CLI tests for the batch-H indexing commands (cli_index.ts): index, memory,
 * export, git-history. (`_watch_project` has its own test_index_watch.test.ts.)
 *
 * Port of the CLI-level cases from tests/test_index_*.py / test_cli_export.py /
 * test_cli_history.py that drive the commands via the Typer app. Uses the
 * in-process `invoke` runner.
 *
 * Project setup: `find_project` walks up for a PROJECT_MARKERS file (.git /
 * package.json / pyproject.toml); planting `pyproject.toml` in a tmp root makes
 * it detectable. `index --root` uses `make_project_at` (no marker needed) and
 * shares the project hash with `find_project(canonicalize(root))`, so
 * `index --root <r>` then `export/memory --project <r>` hit the same DB.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import * as paths from "../src/token_goat/paths.js";
import { invoke } from "./_cli_runner.js";

afterEach(() => {
  vi.restoreAllMocks();
});

/** A tmp project root with a pyproject.toml marker (find_project-detectable). */
function makeProjectRoot(files: Record<string, string> = {}): string {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "tg-cli-idx-")));
  fs.writeFileSync(path.join(root, "pyproject.toml"), "[project]\nname = 'x'\n", "utf8");
  for (const [name, content] of Object.entries(files)) {
    fs.writeFileSync(path.join(root, name), content, "utf8");
  }
  return root;
}

// ---------------------------------------------------------------------------
// index --check (dirty queue)
// ---------------------------------------------------------------------------

describe("TestIndexCheck", () => {
  it("empty queue exits 0", async () => {
    // dirtyQueuePath() resolves under the per-test data dir — absent by default.
    const result = await invoke(["index", "--check"]);
    expect(result.exit_code).toBe(0);
    expect(result.output).toContain("0 files pending");
  });

  it("non-empty queue exits 1", async () => {
    const queuePath = paths.dirtyQueuePath();
    fs.mkdirSync(path.dirname(queuePath), { recursive: true });
    fs.writeFileSync(queuePath, JSON.stringify({ file_rel: "foo.py" }) + "\n", "utf8");

    const result = await invoke(["index", "--check"]);
    expect(result.exit_code).toBe(1);
    expect(result.output).toContain("1 files pending");
  });
});

// ---------------------------------------------------------------------------
// index --root / no-project
// ---------------------------------------------------------------------------

describe("TestIndexRootCli", () => {
  it("indexes a directory and prints summary", async () => {
    const root = makeProjectRoot({ "mod.py": "def foo():\n    return 1\n" });
    const result = await invoke(["index", "--root", root]);
    expect(result.exit_code).toBe(0);
    expect(result.output).toContain("Indexed ");
  });

  it("non-directory root exits 2", async () => {
    const root = makeProjectRoot();
    const notDir = path.join(root, "not-a-dir");
    fs.writeFileSync(notDir, "x", "utf8");
    const result = await invoke(["index", "--root", notDir]);
    expect(result.exit_code).toBe(2);
  });

  it("no project detected (no --root, no marker at cwd) exits 1", async () => {
    // Run from a fresh non-project tmp dir via process.chdir.
    const cwdSave = process.cwd();
    const nowhere = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "tg-noproj-")));
    try {
      process.chdir(nowhere);
      const result = await invoke(["index"]);
      expect(result.exit_code).toBe(1);
      expect(result.output).toContain("no project detected");
    } finally {
      process.chdir(cwdSave);
    }
  });
});

// ---------------------------------------------------------------------------
// memory
// ---------------------------------------------------------------------------

describe("TestMemoryCli", () => {
  it("set then show then unset then clear round-trip", async () => {
    const root = makeProjectRoot();

    const setShow = await invoke(["memory", "set", "key", "value", "--project", root]);
    expect(setShow.exit_code).toBe(0);
    expect(setShow.output).toContain("Set 'key'");

    const show = await invoke(["memory", "show", "--project", root]);
    expect(show.exit_code).toBe(0);
    expect(show.output).toContain("key: value");

    const unset = await invoke(["memory", "unset", "key", "--project", root]);
    expect(unset.exit_code).toBe(0);
    expect(unset.output).toContain("Removed 'key'");

    const showAfter = await invoke(["memory", "show", "--project", root]);
    expect(showAfter.exit_code).toBe(0);
    expect(showAfter.output).toContain("(no memory entries)");

    const cleared = await invoke(["memory", "clear", "--project", root]);
    expect(cleared.exit_code).toBe(0);
    expect(cleared.output).toContain("Memory cleared.");
  });

  it("empty show prints no-entries message", async () => {
    const root = makeProjectRoot();
    const result = await invoke(["memory", "show", "--project", root]);
    expect(result.exit_code).toBe(0);
    expect(result.output).toContain("(no memory entries)");
  });

  it("unknown action exits 1", async () => {
    const root = makeProjectRoot();
    const result = await invoke(["memory", "frobnicate", "--project", root]);
    expect(result.exit_code).toBe(1);
    expect(result.output).toContain("Unknown action");
  });

  it("set without value exits 1", async () => {
    const root = makeProjectRoot();
    const result = await invoke(["memory", "set", "key", "--project", root]);
    expect(result.exit_code).toBe(1);
    expect(result.output).toContain("Usage:");
  });

  it("no project detected exits 1", async () => {
    const nowhere = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "tg-noproj-")));
    const result = await invoke(["memory", "show", "--project", nowhere]);
    expect(result.exit_code).toBe(1);
    expect(result.output).toContain("Not in an indexed project root");
  });
});

// ---------------------------------------------------------------------------
// export
// ---------------------------------------------------------------------------

describe("TestExportCli", () => {
  it("unknown format exits 1", async () => {
    const root = makeProjectRoot({ "mod.py": "def foo():\n    pass\n" });
    const result = await invoke(["export", "--project", root, "--format", "xml"]);
    expect(result.exit_code).toBe(1);
    expect(result.output).toContain("unknown format");
  });

  it("no project detected exits 1", async () => {
    const nowhere = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "tg-noproj-")));
    const result = await invoke(["export", "--project", nowhere]);
    expect(result.exit_code).toBe(1);
    expect(result.output).toContain("no project detected");
  });

  it("json export of an indexed project returns a JSON array", async () => {
    const root = makeProjectRoot({ "mod.py": "def foo():\n    return 1\n" });
    // Index first so the symbols DB exists. (The grammar adapters aren't active
    // in the test env — wasm not bundled — so 0 symbols are extracted; this
    // still exercises the query + JSON-array rendering path.)
    const idx = await invoke(["index", "--root", root]);
    expect(idx.exit_code).toBe(0);

    const result = await invoke(["export", "--project", root, "--format", "json"]);
    expect(result.exit_code).toBe(0);
    const data = JSON.parse(result.output);
    expect(Array.isArray(data)).toBe(true);
  });

  it("csv export writes a header row", async () => {
    const root = makeProjectRoot({ "mod.py": "def foo():\n    pass\n" });
    await invoke(["index", "--root", root]);
    const result = await invoke(["export", "--project", root, "--format", "csv"]);
    expect(result.exit_code).toBe(0);
    const lines = result.output.split("\n").filter((l) => l.length > 0);
    expect(lines[0]).toBe("name,kind,file,start_line,end_line,parent_name");
  });

  it("ctags export emits the sorted/format preamble", async () => {
    const root = makeProjectRoot({ "mod.py": "def foo():\n    pass\n" });
    await invoke(["index", "--root", root]);
    const result = await invoke(["export", "--project", root, "--format", "ctags"]);
    expect(result.exit_code).toBe(0);
    expect(result.output).toContain("!_TAG_FILE_SORTED");
    expect(result.output).toContain("!_TAG_FILE_FORMAT");
  });

  it("--output writes to a file and reports to stderr", async () => {
    const root = makeProjectRoot({ "mod.py": "def foo():\n    pass\n" });
    await invoke(["index", "--root", root]);
    const outFile = path.join(root, "symbols.json");
    const result = await invoke([
      "export",
      "--project",
      root,
      "--format",
      "json",
      "--output",
      outFile,
    ]);
    expect(result.exit_code).toBe(0);
    expect(fs.existsSync(outFile)).toBe(true);
    expect(result.output).toContain("exported");
  });
});

// ---------------------------------------------------------------------------
// git-history (registration smoke; full coverage is in test_git_history.test.ts
// at the library level)
// ---------------------------------------------------------------------------

describe("TestGitHistoryCli", () => {
  it("command is registered", async () => {
    const result = await invoke(["git-history", "--help"]);
    expect(result.exit_code).toBe(0);
    expect(result.output).toContain("git");
  });
});
