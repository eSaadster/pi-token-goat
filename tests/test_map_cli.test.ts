/**
 * cli batch B — the `map` command.
 *
 * Ports the 5 map tests from tests/test_cli_new_commands.py
 * (test_map_happy_path, test_map_invalid_format, test_map_top_n_happy_path,
 * test_map_top_zero_error, test_map_top_negative_error) PLUS the 7 map
 * --filter / --since-minutes OUTPUT tests from
 * tests/test_skill_iter_context_savings.py Sub-area E (TestMapFilter × 4,
 * TestMapSinceMinutes × 3) — those are the ONLY coverage of those two modes,
 * and they assert map OUTPUT behavior (which files appear, header lines, the
 * "no recently modified files" message).
 *
 * Mock pattern (translated from Python patch(...)):
 *  - vi.spyOn(cliLookup, "_require_project").mockResolvedValue(fakeProj)
 *    (cli_map calls cliLookup._require_project via the namespace).
 *  - vi.spyOn(repomap, "build_map" / "_load_and_rank" / ...).mockReturnValue(...).
 *  - vi.spyOn(cliLookup, "_record_lookup_stat").mockImplementation(() => {})
 *    so it does not hit the DB.
 *  - vi.spyOn(cliMap, "_build_map_skills_footer").mockReturnValue("") to
 *    deterministically suppress the footer (the python tests isolate the data
 *    dir via tmp_data_dir; here we spy the helper directly).
 *
 * Output is captured via the CliRunner (`invoke` → process.stdout spy).
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import * as cliLookup from "../src/token_goat/cli_lookup.js";
import * as cliMap from "../src/token_goat/cli_map.js";
import * as repomap from "../src/token_goat/repomap.js";
import { invoke } from "./_cli_runner.js";

const _tmpRoots: string[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  while (_tmpRoots.length) {
    const d = _tmpRoots.pop()!;
    try {
      fs.rmSync(d, { recursive: true, force: true });
    } catch {
      // best-effort
    }
  }
});

/** Fake project matching Python `_FAKE_PROJ` (root basename used for headers). */
const _FAKE_PROJ = {
  hash: "deadbeef",
  root: "/tmp/test-proj",
  marker: ".git",
};

/** Install the common happy-path spies (project + no-op stat + empty footer). */
function _installCommonSpies(): void {
  vi.spyOn(cliLookup, "_require_project").mockResolvedValue(_FAKE_PROJ);
  vi.spyOn(cliLookup, "_record_lookup_stat").mockImplementation(() => {
    // no-op — avoid hitting the DB
  });
  vi.spyOn(cliLookup, "_total_project_bytes").mockReturnValue(1000);
  vi.spyOn(cliMap, "_build_map_skills_footer").mockReturnValue("");
}

/** Make a fresh realpath'd tmp dir and register it for teardown. */
function _mkTmpDir(): string {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), `tg-map-${process.pid}-${_tmpRoots.length}-`));
  const root = fs.realpathSync(base);
  _tmpRoots.push(root);
  return root;
}

// ---------------------------------------------------------------------------
// map — happy path (text mode)
// ---------------------------------------------------------------------------

describe("map (batch B)", () => {
  it("returns the repomap text when project and repomap are available", async () => {
    const fakeMapText = "# Repo Map\n[100 tokens]\nsrc/foo.py [function, class]";
    _installCommonSpies();
    vi.spyOn(repomap, "build_map").mockReturnValue(fakeMapText);

    const result = await invoke(["map"]);

    expect(result.exit_code).toBe(0);
    expect(result.stdout).toContain("Repo Map");
  });

  // -------------------------------------------------------------------------
  // map — error path (invalid --format value)
  // -------------------------------------------------------------------------

  it("exits non-zero when --format is not one of text/json/mermaid", async () => {
    _installCommonSpies();

    const result = await invoke(["map", "--format", "xml"]);

    expect(result.exit_code).not.toBe(0);
  });

  // -------------------------------------------------------------------------
  // map — --top N flag
  // -------------------------------------------------------------------------

  it("--top 5 limits output to top 5 files by PageRank", async () => {
    const fakeMapText = "src/a.py (rank: 0.050)\nsrc/b.py (rank: 0.040)\n";
    _installCommonSpies();
    vi.spyOn(repomap, "build_map").mockReturnValue(fakeMapText);

    const result = await invoke(["map", "--top", "5"]);

    expect(result.exit_code).toBe(0);
    expect(result.stdout).toContain("rank:");
  });

  it("--top 0 should error", async () => {
    _installCommonSpies();

    const result = await invoke(["map", "--top", "0"]);

    expect(result.exit_code).not.toBe(0);
    expect(result.stderr).toContain("positive integer");
  });

  it("--top -5 should error", async () => {
    _installCommonSpies();

    const result = await invoke(["map", "--top", "-5"]);

    expect(result.exit_code).not.toBe(0);
    expect(result.stderr).toContain("positive integer");
  });
});

// ---------------------------------------------------------------------------
// map --filter GLOB (from test_skill_iter_context_savings.py Sub-area E)
// ---------------------------------------------------------------------------

describe("map --filter GLOB", () => {
  /**
   * Mirror the python `_mock_project` helper: patch build_map to return the
   * given synthetic text and suppress the footer.
   */
  function _mockProject(mapText: string): void {
    _installCommonSpies();
    vi.spyOn(repomap, "build_map").mockReturnValue(mapText);
  }

  it("'*.py' should only show .py file lines", async () => {
    const mapText = [
      "# myproject",
      "src/main.py  (functions: main, helper)",
      "src/utils.py  (functions: util)",
      "README.md  (sections: Overview)",
      "config.toml  (keys: name, version)",
      "",
    ].join("\n");
    _mockProject(mapText);

    const result = await invoke(["map", "--filter", "*.py"]);

    expect(result.exit_code).toBe(0);
    // Python files should appear
    expect(result.stdout).toContain("main.py");
    expect(result.stdout).toContain("utils.py");
    // Non-python files should not appear
    expect(result.stdout).not.toContain("README.md");
    expect(result.stdout).not.toContain("config.toml");
  });

  it("header lines (# prefix) are kept even when --filter is active", async () => {
    const mapText = [
      "# myproject",
      "src/main.py  (functions: main)",
      "README.md  (sections: Overview)",
      "",
    ].join("\n");
    _mockProject(mapText);

    const result = await invoke(["map", "--filter", "*.py"]);

    expect(result.exit_code).toBe(0);
    expect(result.stdout).toContain("# myproject");
  });

  it("'*.ts' filters to TypeScript files only", async () => {
    const mapText = [
      "# frontend",
      "src/App.tsx  (components: App)",
      "src/utils.ts  (functions: formatDate)",
      "src/styles.css  ()",
      "public/index.html  ()",
      "",
    ].join("\n");
    _mockProject(mapText);

    const result = await invoke(["map", "--filter", "*.ts"]);

    expect(result.exit_code).toBe(0);
    expect(result.stdout).toContain("utils.ts");
    expect(result.stdout).not.toContain("styles.css");
    expect(result.stdout).not.toContain("index.html");
  });

  it("'src/*.py' limits to src/ directory Python files", async () => {
    const mapText = [
      "# myproject",
      "src/main.py  (functions: main)",
      "tests/test_main.py  (functions: test_main)",
      "README.md  (sections: Overview)",
      "",
    ].join("\n");
    _mockProject(mapText);

    const result = await invoke(["map", "--filter", "src/*.py"]);

    expect(result.exit_code).toBe(0);
    expect(result.stdout).toContain("src/main.py");
    expect(result.stdout).not.toContain("tests/test_main.py");
  });
});

// ---------------------------------------------------------------------------
// map --since-minutes N (from test_skill_iter_context_savings.py Sub-area E)
// ---------------------------------------------------------------------------

describe("map --since-minutes N", () => {
  /**
   * Build a fake ranked_data shape matching repomap._RankedProjectData
   * (only `.ranked` is read by cli_map): an array of [rel_path, info] pairs.
   */
  function _fakeRanked(relPaths: string[]): { ranked: Array<[string, unknown]> } {
    return { ranked: relPaths.map((p) => [p, {}] as [string, unknown]) };
  }

  it("files modified within the window should appear in output", async () => {
    const tmp = _mkTmpDir();
    const recentFile = path.join(tmp, "new_file.py");
    const oldFile = path.join(tmp, "old_file.py");
    fs.writeFileSync(recentFile, "print('hello')", "utf8");
    fs.writeFileSync(oldFile, "print('old')", "utf8");

    // Make old_file appear 2 hours old.
    const twoHoursAgo = Date.now() / 1000 - 7200;
    fs.utimesSync(oldFile, twoHoursAgo, twoHoursAgo);

    const proj = { hash: "def456", root: tmp, marker: ".git" };
    vi.spyOn(cliLookup, "_require_project").mockResolvedValue(proj);
    vi.spyOn(cliLookup, "_record_lookup_stat").mockImplementation(() => {});
    vi.spyOn(cliLookup, "_total_project_bytes").mockReturnValue(1000);
    vi.spyOn(repomap, "_load_and_rank").mockReturnValue(
      _fakeRanked(["new_file.py", "old_file.py"]) as ReturnType<
        typeof repomap._load_and_rank
      >,
    );

    const result = await invoke(["map", "--since-minutes", "30"]);

    expect(result.exit_code).toBe(0);
    expect(result.stdout).toContain("new_file.py");
    expect(result.stdout).not.toContain("old_file.py");
  });

  it("when no files are recent, output says no files found", async () => {
    const tmp = _mkTmpDir();
    const oldFile = path.join(tmp, "old.py");
    fs.writeFileSync(oldFile, "x = 1", "utf8");
    const twoHoursAgo = Date.now() / 1000 - 7200;
    fs.utimesSync(oldFile, twoHoursAgo, twoHoursAgo);

    const proj = { hash: "def456", root: tmp, marker: ".git" };
    vi.spyOn(cliLookup, "_require_project").mockResolvedValue(proj);
    vi.spyOn(cliLookup, "_record_lookup_stat").mockImplementation(() => {});
    vi.spyOn(cliLookup, "_total_project_bytes").mockReturnValue(1000);
    vi.spyOn(repomap, "_load_and_rank").mockReturnValue(
      _fakeRanked(["old.py"]) as ReturnType<typeof repomap._load_and_rank>,
    );

    const result = await invoke(["map", "--since-minutes", "5"]);

    expect(result.exit_code).toBe(0);
    expect(result.stdout.toLowerCase()).toContain("no recently modified");
  });

  it("output header shows the number of recently modified files", async () => {
    const tmp = _mkTmpDir();
    const recentFile = path.join(tmp, "fresh.py");
    fs.writeFileSync(recentFile, "# new content", "utf8");

    const proj = { hash: "def456", root: tmp, marker: ".git" };
    vi.spyOn(cliLookup, "_require_project").mockResolvedValue(proj);
    vi.spyOn(cliLookup, "_record_lookup_stat").mockImplementation(() => {});
    vi.spyOn(cliLookup, "_total_project_bytes").mockReturnValue(1000);
    vi.spyOn(repomap, "_load_and_rank").mockReturnValue(
      _fakeRanked(["fresh.py"]) as ReturnType<typeof repomap._load_and_rank>,
    );

    const result = await invoke(["map", "--since-minutes", "10"]);

    expect(result.exit_code).toBe(0);
    // Header should mention the time window.
    expect(result.stdout).toContain("10");
  });
});
