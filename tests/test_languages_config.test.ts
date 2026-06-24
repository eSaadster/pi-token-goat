/**
 * Tests for the TOML / YAML / JSON section extractors.
 *
 * 1:1 port of tests/test_languages_config.py. Strict NodeNext ESM.
 *
 * Port notes
 * -----------
 *  - Pure extractor unit tests against toml_idx / yaml_idx / json_idx `.extract`.
 *    Buffer inputs, destructured 4-tuples. No fixtures, no DB, no project.
 *  - TestTomlExtractor.test_simple_tables carries a precedence-sensitive Python
 *    assertion:
 *        a.end_line is not None and a.end_line < b.line or a.end_line == b.line - 1
 *    Python boolean operator precedence binds this as
 *        (a.end_line is not None and a.end_line < b.line) or (a.end_line == b.line - 1)
 *    The TS port reproduces that exact grouping with explicit parentheses so the
 *    invariant under test is unchanged.
 */
import { describe, expect, it } from "vitest";

import * as json_idx from "../src/token_goat/languages/json_idx.js";
import * as toml_idx from "../src/token_goat/languages/toml_idx.js";
import * as yaml_idx from "../src/token_goat/languages/yaml_idx.js";

// ===========================================================================
// TestTomlExtractor
// ===========================================================================

describe("TestTomlExtractor", () => {
  it("test_simple_tables", () => {
    const src = Buffer.from(
      "\n[tool.ruff]\nline-length = 100\n\n[tool.ruff.format]\nquote-style = \"double\"\n\n[[some.array]]\nkey = 1\n",
    );
    const [symbols, refs, imps, sections] = toml_idx.extract(
      src,
      "pyproject.toml",
    );
    expect(refs).toEqual([]);
    expect(imps).toEqual([]);
    const headings = sections.map((s) => s.heading);
    expect(headings).toContain("tool.ruff");
    expect(headings).toContain("tool.ruff.format");
    expect(headings).toContain("some.array");
    // Sections have ascending start lines and non-overlapping end lines.
    for (let i = 0; i + 1 < sections.length; i++) {
      const a = sections[i]!;
      const b = sections[i + 1]!;
      expect(a.line).toBeLessThanOrEqual(b.line);
      // Python: a.end_line is not None and a.end_line < b.line or a.end_line == b.line - 1
      expect(
        (a.end_line !== null && a.end_line < b.line) ||
          a.end_line === b.line - 1,
      ).toBe(true);
    }
  });

  it("test_no_headers_yields_empty", () => {
    const src = Buffer.from('name = "thing"\nversion = "0.1"\n');
    const sections = toml_idx.extract(src, "Cargo.toml")[3];
    expect(sections).toEqual([]);
  });

  it("test_malformed_brackets_ignored", () => {
    const src = Buffer.from("[a]\nok = 1\n[bad\nnot = 'a section'\n");
    const sections = toml_idx.extract(src, "x.toml")[3];
    expect(sections.map((s) => s.heading)).toEqual(["a"]);
  });

  it("test_quoted_table_name", () => {
    const src = Buffer.from('["tool.ruff"]\nkey = "x"\n');
    const sections = toml_idx.extract(src, "x.toml")[3];
    expect(sections.some((s) => s.heading === "tool.ruff")).toBe(true);
  });
});

// ===========================================================================
// TestYamlExtractor
// ===========================================================================

describe("TestYamlExtractor", () => {
  it("test_top_level_keys_emitted", () => {
    const src = Buffer.from(
      "name: my-action\nruns:\n  using: composite\n  steps:\n    - run: echo\n",
    );
    const sections = yaml_idx.extract(src, "action.yml")[3];
    const headings = sections.map((s) => s.heading);
    expect(headings).toContain("name");
    expect(headings).toContain("runs");
  });

  it("test_nested_keys_emitted", () => {
    const src = Buffer.from(
      "spec:\n  replicas: 3\n  selector: foo\n  template:\n    metadata: x\n",
    );
    const sections = yaml_idx.extract(src, "deploy.yaml")[3];
    const headings = sections.map((s) => s.heading);
    expect(headings).toContain("spec");
    // Nested keys are emitted with parent.child dotted form.
    expect(headings).toContain("spec.replicas");
    expect(headings).toContain("spec.selector");
  });

  it("test_list_items_not_emitted_as_keys", () => {
    const src = Buffer.from("items:\n  - one\n  - two\n  - three\n");
    const sections = yaml_idx.extract(src, "list.yml")[3];
    const headings = sections.map((s) => s.heading);
    // Only "items" is a real key; the list dashes should not become keys.
    expect(headings).toEqual(["items"]);
  });

  it("test_multi_document_resets_state", () => {
    const src = Buffer.from("a: 1\n---\nb: 2\n");
    const sections = yaml_idx.extract(src, "multi.yml")[3];
    const headings = sections.map((s) => s.heading);
    expect(headings).toContain("a");
    expect(headings).toContain("b");
  });
});

// ===========================================================================
// TestJsonSections
// ===========================================================================

describe("TestJsonSections", () => {
  it("test_pretty_printed_json_emits_sections", () => {
    const src = Buffer.from(
      '{\n  "name": "my-pkg",\n  "version": "1.0.0",\n  "scripts": {\n    "test": "vitest",\n    "build": "vite build"\n  },\n  "dependencies": {\n    "react": "^18"\n  }\n}\n',
    );
    const sections = json_idx.extract(src, "package.json")[3];
    const headings = sections.map((s) => s.heading);
    expect(headings).toEqual(["name", "version", "scripts", "dependencies"]);
    // End lines bound each section to the line before the next heading.
    const scriptsSec = sections.find((s) => s.heading === "scripts")!;
    const depsSec = sections.find((s) => s.heading === "dependencies")!;
    expect(scriptsSec.end_line).not.toBeNull();
    expect(scriptsSec.end_line!).toBeLessThan(depsSec.line);
  });

  it("test_minified_json_no_sections", () => {
    const src = Buffer.from('{"name":"x","version":"1.0.0","deps":{"a":"b"}}');
    const sections = json_idx.extract(src, "min.json")[3];
    expect(sections).toEqual([]);
  });

  it("test_nested_keys_not_in_sections", () => {
    // The 'test' key inside 'scripts' must not become a top-level section.
    const src = Buffer.from('{\n  "scripts": {\n    "test": "vitest"\n  }\n}\n');
    const sections = json_idx.extract(src, "p.json")[3];
    const headings = sections.map((s) => s.heading);
    // Only the top-level "scripts" key is a section; "test" (depth 2) is not.
    expect(headings).toEqual(["scripts"]);
  });
});
