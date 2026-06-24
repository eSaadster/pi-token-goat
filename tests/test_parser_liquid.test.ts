/**
 * Tests for the Liquid extractor.
 *
 * Faithful 1:1 port of tests/test_parser_liquid.py. Strict NodeNext ESM.
 *
 * Fixtures are shared with the Python suite (see test_parser_md.test.ts header
 * for the path-resolution rationale): from this module's directory
 *   <root>/ts/tests/
 * walk up two parents to the repo root, then into tests/fixtures/liquid_sample.
 */
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { extract } from "../src/token_goat/languages/liquid.js";
import type { ImpExp, Section, Symbol } from "../src/token_goat/parser.js";

const _HERE = path.dirname(fileURLToPath(import.meta.url));
const _REPO_ROOT = path.resolve(_HERE, "..", "..");
const FIXTURE_DIR = path.join(_REPO_ROOT, "tests", "fixtures", "liquid_sample");
const HEADER_LIQUID = path.join(FIXTURE_DIR, "sections", "header.liquid");
const SOCIAL_LIQUID = path.join(FIXTURE_DIR, "snippets", "social-icons.liquid");

/** Faithful analogue of the `header_source` pytest fixture (reads bytes). */
function header_source(): Buffer {
  return fs.readFileSync(HEADER_LIQUID);
}

/** Faithful analogue of the `header_extracted` pytest fixture. */
function header_extracted(): [Symbol[], unknown[], ImpExp[], Section[]] {
  return extract(header_source(), "sections/header.liquid");
}

describe("Liquid extractor", () => {
  it("extract returns four lists", () => {
    const [symbols, refs, imports, sections] = header_extracted();
    expect(Array.isArray(symbols)).toBe(true);
    expect(Array.isArray(refs)).toBe(true);
    expect(Array.isArray(imports)).toBe(true);
    expect(Array.isArray(sections)).toBe(true);
  });

  it("schema symbol extracted", () => {
    const [symbols] = header_extracted();
    const names = new Set(symbols.map((s) => s.name));
    expect(names.has("Header")).toBe(true);
    const headerSym = symbols.find((s) => s.name === "Header")!;
    expect(headerSym.kind).toBe("liquid_schema");
    expect(headerSym.line).toBeGreaterThanOrEqual(1);
  });

  it("section file symbol", () => {
    const [symbols] = header_extracted();
    const names = new Set(symbols.map((s) => s.name));
    expect(names.has("header")).toBe(true);
    const headerFile = symbols.find((s) => s.name === "header")!;
    expect(headerFile.kind).toBe("liquid_section_file");
  });

  it("include import extracted", () => {
    const [, , imports] = header_extracted();
    const targets = new Set(imports.map((imp) => imp.target));
    expect(targets.has("social-icons")).toBe(true);
    const includeImp = imports.find((i) => i.target === "social-icons")!;
    expect(includeImp.kind).toBe("liquid_include");
  });

  it("section import extracted", () => {
    const [, , imports] = header_extracted();
    const targets = new Set(imports.map((imp) => imp.target));
    expect(targets.has("navigation")).toBe(true);
    const sectionImp = imports.find((i) => i.target === "navigation")!;
    expect(sectionImp.kind).toBe("liquid_section");
  });

  it("h1 section extracted", () => {
    const [, , , sections] = header_extracted();
    const headings = new Set(sections.map((s) => s.heading));
    // The h1 content is "{{ shop.name }}"
    expect([...headings].some((h) => h.includes("shop.name") || h.includes("{{"))).toBe(true);
  });

  it("social render import", () => {
    const source = fs.readFileSync(SOCIAL_LIQUID);
    const [, , imports] = extract(source, "snippets/social-icons.liquid");
    const targets = new Set(imports.map((imp) => imp.target));
    expect(targets.has("icon")).toBe(true);
    const renderImp = imports.find((i) => i.target === "icon")!;
    expect(renderImp.kind).toBe("liquid_render");
  });

  it("liquid h5 h6 headings extracted", () => {
    // Liquid templates with `<h5>`/`<h6>` must also yield Section entries.
    const src = Buffer.from(
      "{% comment %}intro{% endcomment %}\n" +
        "<h5>Deep Liquid 5</h5>\n" +
        "<h6>Deepest Liquid 6</h6>\n",
    );
    const [, , , sections] = extract(src, "sections/deep.liquid");
    const headings = new Set(sections.map((s) => s.heading));
    expect(headings.has("Deep Liquid 5")).toBe(true);
    expect(headings.has("Deepest Liquid 6")).toBe(true);
  });

  it("liquid heading with anchor id", () => {
    // Anchor-id-aware extraction works in Liquid templates too.
    const src = Buffer.from('<h2 id="install-section">Install Section</h2>\n');
    const [, , , sections] = extract(src, "sections/anchor.liquid");
    const headings = new Set(sections.map((s) => s.heading));
    expect(headings.has("Install Section")).toBe(true);
    expect(headings.has("install-section")).toBe(true);
  });
});
