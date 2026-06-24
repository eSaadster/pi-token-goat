/**
 * Tests for `token-goat index --watch` (polling file watcher) — 1:1 port of
 * tests/test_index_watch.py.
 *
 * Targets `_watch_project` (cli_index.ts) + the `index --watch` CLI. The Python
 * suite patches `token_goat.cli.time` (sleep); the TS port uses cli_index's
 * `_setSleep` seam + `KeyboardInterrupt` class. `_watch_project` is async → every
 * case awaits it. `index_file` / `index_project` are the REAL parser fns (the
 * python grammar adapter IS ported, so foo.py extracts `hello`/`bye`).
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import * as cliIndex from "../src/token_goat/cli_index.js";
import * as db from "../src/token_goat/db.js";
import * as parser from "../src/token_goat/parser.js";
import { make_project_at } from "../src/token_goat/project.js";
import type { Project } from "../src/token_goat/project.js";
import { invoke } from "./_cli_runner.js";

afterEach(() => {
  cliIndex._setSleep(null);
  vi.restoreAllMocks();
});

/** Create a tmp project root containing foo.py (Python _make_proj). */
async function makeProj(): Promise<Project> {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "tg-watch-")));
  fs.writeFileSync(path.join(root, "foo.py"), "def hello(): pass\n", "utf8");
  const proj = make_project_at(root);
  await parser.index_project(proj, { full: true });
  return proj;
}

describe("TestWatchProject", () => {
  it("exits on keyboard interrupt", async () => {
    const proj = await makeProj();
    cliIndex._setSleep(() => {
      throw new cliIndex.KeyboardInterrupt();
    });
    // Should not throw — KeyboardInterrupt is caught internally.
    await expect(cliIndex._watch_project(proj)).resolves.toBeUndefined();
  });

  it("reindexes changed file", async () => {
    const proj = await makeProj();
    const pyFile = path.join(proj.root, "foo.py");

    let callCount = 0;
    cliIndex._setSleep(() => {
      callCount += 1;
      if (callCount === 1) {
        // Simulate a file change by bumping the content (→ mtime changes).
        fs.writeFileSync(pyFile, "def hello(): pass\ndef bye(): pass\n", "utf8");
      } else {
        throw new cliIndex.KeyboardInterrupt();
      }
    });

    await cliIndex._watch_project(proj);

    // Verify the DB has the updated symbol count after one change cycle.
    const rows = db.openProjectReadonly(proj.hash, (conn) =>
      conn.prepare("SELECT name FROM symbols WHERE file_rel = 'foo.py'").all() as Array<{
        name: string;
      }>,
    );
    const names = new Set(rows.map((r) => r.name));
    expect(names.has("hello")).toBe(true);
    expect(names.has("bye")).toBe(true);
  });

  it("no reindex when unchanged", async () => {
    const proj = await makeProj();
    let callCount = 0;
    cliIndex._setSleep(() => {
      callCount += 1;
      if (callCount >= 2) throw new cliIndex.KeyboardInterrupt();
    });
    const spy = vi.spyOn(parser, "index_file");

    await cliIndex._watch_project(proj);

    expect(spy).not.toHaveBeenCalled();
  });

  it("skips generated files", async () => {
    const proj = await makeProj();
    const lockfile = path.join(proj.root, "package-lock.json");
    fs.writeFileSync(lockfile, "{}", "utf8");
    await parser.index_project(proj, { full: true });

    let callCount = 0;
    cliIndex._setSleep(() => {
      callCount += 1;
      if (callCount === 1) {
        fs.writeFileSync(lockfile, '{"updated": true}', "utf8");
      } else {
        throw new cliIndex.KeyboardInterrupt();
      }
    });
    const spy = vi.spyOn(parser, "index_file");

    await cliIndex._watch_project(proj);

    expect(spy).not.toHaveBeenCalled();
  });
});

describe("TestIndexWatchCli", () => {
  it("watch flag accepted", async () => {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "tg-watchcli-")));
    fs.writeFileSync(path.join(root, "mod.py"), "x = 1\n", "utf8");
    const proj = make_project_at(root);
    await parser.index_project(proj, { full: true });

    cliIndex._setSleep(() => {
      throw new cliIndex.KeyboardInterrupt();
    });

    const result = await invoke(["index", "--root", root, "--watch"]);
    expect(result.exit_code).toBe(0);
    expect(result.output.match(/Watching|Stopped/)).not.toBeNull();
  });
});
