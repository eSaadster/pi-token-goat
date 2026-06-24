/**
 * cli batch A (surgical reads) — wrapper dispatch smoke tests.
 *
 * These verify the commander wrappers parse args + flags and dispatch to
 * read_commands, whose output flows through the shared cli_common seam and is
 * captured by the CliRunner. read_commands' internals are validated separately
 * (test_read_commands). Each command runs against a real indexed project (the
 * python grammar adapter is ported, so the .py file yields real symbols).
 *
 * The commands resolve the project from the cwd, so each test chdir's into the
 * indexed project root (saved/restored around the invoke).
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

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

/** Build + index a tmp Python project, chdir into it, return its (realpath'd) root. */
async function indexedPyProject(): Promise<string> {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), `tg-cliA-${process.pid}-${_tmpRoots.length}-`));
  _tmpRoots.push(base);
  const root = fs.realpathSync(base);
  fs.mkdirSync(path.join(root, ".git"), { recursive: true });
  fs.writeFileSync(
    path.join(root, "mod.py"),
    [
      "def greet(name):",
      '    """Return a friendly greeting."""',
      '    return f"hello, {name}"',
      "",
      "",
      "class Widget:",
      '    """A small widget."""',
      "    def render(self):",
      '        return "widget"',
      "",
      "",
      "def _private_helper():",
      "    return 1",
      "",
    ].join("\n"),
    "utf-8",
  );
  const proj = make_project_at(root);
  await index_project(proj, { full: true });
  _savedCwd = process.cwd();
  process.chdir(root);
  return root;
}

describe("cli batch A surgical-reads dispatch", () => {
  it("outline dispatches and lists symbols", async () => {
    await indexedPyProject();
    const r = await invoke(["outline", "mod.py"]);
    expect(r.exit_code).toBe(0);
    expect(r.output).toContain("greet");
  });

  it("outline --json dispatches (json path raises CliExit(0))", async () => {
    await indexedPyProject();
    const r = await invoke(["outline", "mod.py", "--json"]);
    expect(r.exit_code).toBe(0);
    // The json branch emits a JSON document; it must parse.
    const firstJsonLine = r.stdout.split("\n").find((l) => l.trim().startsWith("[") || l.trim().startsWith("{"));
    expect(firstJsonLine, `expected JSON in output: ${r.stdout.slice(0, 200)}`).toBeTruthy();
    expect(() => JSON.parse(firstJsonLine!.trim())).not.toThrow();
  });

  it("skeleton dispatches", async () => {
    await indexedPyProject();
    const r = await invoke(["skeleton", "mod.py"]);
    expect(r.exit_code).toBe(0);
    expect(r.output).toContain("greet");
  });

  it("exports dispatches and excludes _private", async () => {
    await indexedPyProject();
    const r = await invoke(["exports", "mod.py"]);
    expect(r.exit_code).toBe(0);
    expect(r.output).toContain("greet");
    // _private_helper starts with "_" → not an export.
    expect(r.output).not.toContain("_private_helper");
  });

  it("read <file>::<symbol> returns the symbol body", async () => {
    await indexedPyProject();
    const r = await invoke(["read", "mod.py::greet"]);
    expect(r.exit_code).toBe(0);
    expect(r.output).toContain("hello");
  });

  it("types dispatches with no file arg (project-wide)", async () => {
    await indexedPyProject();
    const r = await invoke(["types"]);
    // Project-wide types scan must not crash; exit 0.
    expect(r.exit_code).toBe(0);
  });

  it("unknown flag on a batch A command is a usage error (non-zero)", async () => {
    await indexedPyProject();
    const r = await invoke(["outline", "mod.py", "--no-such-flag"]);
    expect(r.exit_code).not.toBe(0);
  });
});
