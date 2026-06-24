/**
 * Tests for TOML and YAML section extraction (sub-area G).
 *
 * 1:1 port of tests/test_section_toml_yaml.py. Strict NodeNext ESM.
 *
 * Verifies that:
 *  - [tool.ruff] dotted-key sections are indexed correctly
 *  - [[array-of-tables]] sections get level=2
 *  - Inline tables within a section don't create spurious section headers
 *  - YAML nested keys are extracted at depth 1 and 2
 *  - The `section` command can look up dotted-key TOML sections
 *
 * Port notes
 * -----------
 *  - TestTomlSectionExtraction / TestYamlSectionExtraction: pure
 *    toml_idx.extract / yaml_idx.extract unit tests (`.encode()` -> Buffer.from).
 *  - TestTomlSectionLookup: Python used `make_project` (conftest fixture),
 *    `index_project(proj, full=True)`, `monkeypatch.chdir(proj_root)`, and
 *    `read_replacement.read_section`. The TS port builds a `Project` object
 *    literal from `canonicalize` + `project_hash` (with a `.git` marker dir,
 *    matching the Python conftest `make_project` which creates a real project
 *    rooted at the marker), awaits the async `index_project`, and calls
 *    `read_section(proj, rel_path, heading)` (the TS read_section resolves paths
 *    off `project.root`, so no chdir is required — `monkeypatch.chdir` in Python
 *    was for project auto-detection, which the explicit `proj` argument obviates).
 *    `result.text` is the SectionResult.text field (a snippet string).
 *  - This file exercises ONLY the FLAT toml_idx/yaml_idx adapters (no grammar /
 *    tree-sitter languages), so every test stays GREEN (none are deferred).
 */
import { describe, expect, it } from "vitest";

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import * as toml_idx from "../src/token_goat/languages/toml_idx.js";
import * as yaml_idx from "../src/token_goat/languages/yaml_idx.js";
import { index_project } from "../src/token_goat/parser.js";
import { read_section } from "../src/token_goat/read_replacement.js";
import { canonicalize, project_hash, type Project } from "../src/token_goat/project.js";

/** Build a per-test tmp project root with a .git marker. */
function makeTmpProjectRoot(name: string): string {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "tg-sec-")));
  const projRoot = path.join(base, name);
  fs.mkdirSync(path.join(projRoot, ".git"), { recursive: true });
  return projRoot;
}

/** Construct a Project object literal from a (canonicalized) root. */
function makeProject(root: string): Project {
  const canonical = canonicalize(root);
  return { root: canonical, hash: project_hash(canonical), marker: ".git" };
}

// ---------------------------------------------------------------------------
// TOML indexer unit tests
// ---------------------------------------------------------------------------

describe("TestTomlSectionExtraction", () => {
  /** toml_idx.extract returns the sections list for a TOML source string. */
  function extractSections(source: string) {
    const secs = toml_idx.extract(Buffer.from(source), "pyproject.toml")[3];
    return secs;
  }

  it("test_simple_table_headers_indexed", () => {
    // Basic [section] headers produce one Section each.
    const source = "[project]\nname = 'foo'\n\n[build-system]\nrequires = []\n";
    const secs = extractSections(source);
    const headings = new Set(secs.map((s) => s.heading));
    expect(headings.has("project")).toBe(true);
    expect(headings.has("build-system")).toBe(true);
  });

  it("test_dotted_key_section", () => {
    // [tool.ruff] produces a section with heading 'tool.ruff'.
    const source = "[project]\nname = 'foo'\n\n[tool.ruff]\nline-length = 100\n";
    const secs = extractSections(source);
    const headings = new Set(secs.map((s) => s.heading));
    expect(headings.has("tool.ruff")).toBe(true);
  });

  it("test_deeply_nested_dotted_key", () => {
    // [tool.ruff.lint] is indexed with heading 'tool.ruff.lint'.
    const source =
      "[tool.ruff]\nline-length = 100\n\n[tool.ruff.lint]\nignore = []\n";
    const secs = extractSections(source);
    const headings = new Set(secs.map((s) => s.heading));
    expect(headings.has("tool.ruff.lint")).toBe(true);
  });

  it("test_arrays_of_tables_get_level_2", () => {
    // [[array.of.tables]] sections have level=2.
    const source =
      "[[tool.ruff.per-file-ignores]]\nfiles = ['tests/*']\nignores = ['S']\n";
    const secs = extractSections(source);
    expect(secs.some((s) => s.heading === "tool.ruff.per-file-ignores")).toBe(
      true,
    );
    const aotSecs = secs.filter((s) => s.heading === "tool.ruff.per-file-ignores");
    expect(aotSecs[0]!.level).toBe(2);
  });

  it("test_inline_tables_do_not_create_extra_sections", () => {
    // Inline tables like `key = {a = 1}` are not mistaken for table headers.
    const source =
      "[project]\n" +
      "optional-dependencies = {test = ['pytest']}\n" +
      "\n" +
      "[tool]\n" +
      "skip = true\n";
    const secs = extractSections(source);
    const headings = new Set(secs.map((s) => s.heading));
    // Only [project] and [tool] should be headers; no 'test' or 'pytest' sections
    expect(headings.has("project")).toBe(true);
    expect(headings.has("tool")).toBe(true);
    // The inline table value should not produce a section.
    expect(headings.has("test")).toBe(false);
  });

  it("test_section_line_ranges_correct", () => {
    // Section line ranges cover the full section body.
    const source =
      "[project]\nname = 'foo'\ndesc = 'bar'\n\n[build]\nrequires = []\n";
    const secs = extractSections(source);
    const projectSec = secs.find((s) => s.heading === "project")!;
    // [project] starts at line 1 and ends just before [build].
    expect(projectSec.line).toBe(1);
    expect(projectSec.end_line!).toBeGreaterThanOrEqual(3); // covers name and desc lines
  });

  it("test_empty_file_produces_no_sections", () => {
    // An empty TOML file produces no sections.
    const secs = extractSections("");
    expect(secs).toEqual([]);
  });

  it("test_comments_only_produces_no_sections", () => {
    // A file with only comments has no sections.
    const source = "# This is a comment\n# Another comment\n";
    const secs = extractSections(source);
    expect(secs).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// YAML indexer unit tests
// ---------------------------------------------------------------------------

describe("TestYamlSectionExtraction", () => {
  /** yaml_idx.extract returns the sections list for a YAML source string. */
  function extractSections(source: string) {
    return yaml_idx.extract(Buffer.from(source), "config.yaml")[3];
  }

  it("test_top_level_keys_indexed", () => {
    // Top-level YAML keys become sections.
    const source =
      "services:\n  web:\n    image: nginx\n\nnetworks:\n  default:\n";
    const secs = extractSections(source);
    const headings = new Set(secs.map((s) => s.heading));
    expect(headings.has("services")).toBe(true);
    expect(headings.has("networks")).toBe(true);
  });

  it("test_nested_key_indexed_as_dotted", () => {
    // Nested keys like services.web appear as 'services.web'.
    const source =
      "services:\n  web:\n    image: nginx\n  db:\n    image: postgres\n";
    const secs = extractSections(source);
    const headings = new Set(secs.map((s) => s.heading));
    expect(headings.has("services.web")).toBe(true);
    expect(headings.has("services.db")).toBe(true);
  });

  it("test_deeply_nested_not_over_indexed", () => {
    // YAML extractor indexes top-level and one level deep only.
    const source = "a:\n  b:\n    c:\n      d: 1\n";
    const secs = extractSections(source);
    const headings = new Set(secs.map((s) => s.heading));
    // 'a' and 'a.b' should be indexed; 'a.b.c' may or may not be.
    expect(headings.has("a")).toBe(true);
  });

  it("test_empty_yaml_produces_no_sections", () => {
    // Empty YAML file produces no sections.
    const secs = extractSections("");
    expect(secs).toEqual([]);
  });

  it("test_comment_lines_not_indexed", () => {
    // Comment lines in YAML are not indexed as sections.
    const source = "# top comment\nkey: value\n# another comment\nother: 2\n";
    const secs = extractSections(source);
    const headings = new Set(secs.map((s) => s.heading));
    expect(headings.has("top comment")).toBe(false);
    expect(headings.has("another comment")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Integration: section lookup for indexed TOML files
// ---------------------------------------------------------------------------

describe("TestTomlSectionLookup", () => {
  /**
   * Create a toml_proj under a tmp root, write pyproject.toml with `content`,
   * build the Project, and run a full index. Returns the project root + Project.
   */
  async function makeTomlProject(
    content: string,
  ): Promise<{ projRoot: string; proj: Project }> {
    const projRoot = makeTmpProjectRoot("toml_proj");
    fs.writeFileSync(path.join(projRoot, "pyproject.toml"), content, "utf-8");
    const proj = makeProject(projRoot);
    await index_project(proj, { full: true });
    return { projRoot, proj };
  }

  it("test_lookup_dotted_key_section", async () => {
    // read_section returns the [tool.ruff] block for dotted key lookup.
    const content =
      "[project]\nname = 'myapp'\n\n" +
      "[tool.ruff]\nline-length = 100\nselect = ['E', 'F']\n\n" +
      "[tool.mypy]\nstrict = true\n";
    const { proj } = await makeTomlProject(content);

    const result = read_section(proj, "pyproject.toml", "tool.ruff");
    expect(result).not.toBeNull();
    // The result should contain the tool.ruff section content.
    const text = result!.text;
    expect(text.includes("line-length") || text.includes("100")).toBe(true);
  });

  it("test_lookup_arrays_of_tables_section", async () => {
    // read_section handles [[array-of-tables]] sections with level=2.
    const content =
      "[project]\nname = 'x'\n\n" +
      "[[tool.hatch.envs.default.scripts]]\nname = 'test'\ncmd = 'pytest'\n";
    await makeTomlProject(content);

    // Arrays of tables should be indexable.
    const secs = toml_idx.extract(Buffer.from(content), "pyproject.toml")[3];
    const headings = new Set(secs.map((s) => s.heading));
    expect(headings.has("project")).toBe(true);
  });
});
