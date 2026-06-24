/**
 * Tests for the HTML extractor.
 *
 * Faithful 1:1 port of tests/test_parser_html.py. Strict NodeNext ESM.
 *
 * Fixtures are shared with the Python suite (see test_parser_md.test.ts header
 * for the path-resolution rationale): from this module's directory
 *   <root>/ts/tests/
 * walk up two parents to the repo root, then into tests/fixtures/html_sample.
 */
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { extract } from "../src/token_goat/languages/html.js";
import type { ImpExp, Section, Symbol } from "../src/token_goat/parser.js";

const _HERE = path.dirname(fileURLToPath(import.meta.url));
const _REPO_ROOT = path.resolve(_HERE, "..", "..");
const FIXTURE_DIR = path.join(_REPO_ROOT, "tests", "fixtures", "html_sample");
const ARTICLE_HTML = path.join(FIXTURE_DIR, "article.html");

/** Faithful analogue of the `html_source` pytest fixture (reads bytes). */
function html_source(): Buffer {
  return fs.readFileSync(ARTICLE_HTML);
}

/** Faithful analogue of the `html_extracted` pytest fixture. */
function html_extracted(): [Symbol[], unknown[], ImpExp[], Section[]] {
  return extract(html_source(), "article.html");
}

describe("HTML extractor", () => {
  it("extract returns four lists", () => {
    const [symbols, refs, imports, sections] = html_extracted();
    expect(Array.isArray(symbols)).toBe(true);
    expect(Array.isArray(refs)).toBe(true);
    expect(Array.isArray(imports)).toBe(true);
    expect(Array.isArray(sections)).toBe(true);
  });

  it("h1 heading extracted", () => {
    const [, , , sections] = html_extracted();
    const headings = new Set(sections.map((s) => s.heading));
    expect(headings.has("Main Heading")).toBe(true);
  });

  it("h2 section one extracted", () => {
    const [, , , sections] = html_extracted();
    const headings = new Set(sections.map((s) => s.heading));
    expect(headings.has("Section One")).toBe(true);
  });

  it("h2 section two extracted", () => {
    const [, , , sections] = html_extracted();
    const headings = new Set(sections.map((s) => s.heading));
    expect(headings.has("Section Two")).toBe(true);
  });

  it("id attribute extracted", () => {
    const [symbols] = html_extracted();
    const names = new Set(
      symbols.filter((s) => s.kind === "html_id").map((s) => s.name),
    );
    expect(names.has("masthead")).toBe(true);
    const masthead = symbols.find((s) => s.name === "masthead")!;
    expect(masthead.kind).toBe("html_id");
  });

  it("class attribute extracted", () => {
    const [symbols] = html_extracted();
    const names = new Set(
      symbols.filter((s) => s.kind === "html_class").map((s) => s.name),
    );
    expect(names.has("article-body")).toBe(true);
  });

  it("link import extracted", () => {
    const [, , imports] = html_extracted();
    const targets = new Set(imports.map((imp) => imp.target));
    expect(targets.has("/style.css")).toBe(true);
    const link = imports.find((i) => i.target === "/style.css")!;
    expect(link.kind).toBe("html_link");
  });

  it("script import extracted", () => {
    const [, , imports] = html_extracted();
    const targets = new Set(imports.map((imp) => imp.target));
    expect(targets.has("/main.js")).toBe(true);
    const script = imports.find((i) => i.target === "/main.js")!;
    expect(script.kind).toBe("html_script");
  });

  it("noise filter skips common ids", () => {
    const [symbols] = html_extracted();
    const names = new Set(
      symbols.filter((s) => s.kind === "html_id").map((s) => s.name),
    );
    // Common classes like "container", "main" should be filtered.
    expect(names.has("container")).toBe(false);
    expect(names.has("main")).toBe(false);
  });

  // -------------------------------------------------------------------------
  // H1-H6 coverage and anchor-id-aware heading sections
  // -------------------------------------------------------------------------

  it("h5 and h6 headings extracted", () => {
    // `<h5>` and `<h6>` were dropped under the prior `[1-4]` cap.
    const src = Buffer.from(
      "<html><body>\n" +
        "<h5>Deep Heading 5</h5>\n" +
        "<h6>Deepest Heading 6</h6>\n" +
        "</body></html>\n",
    );
    const [, , , sections] = extract(src, "deep.html");
    const headings = new Set(sections.map((s) => s.heading));
    expect(headings.has("Deep Heading 5")).toBe(true);
    expect(headings.has("Deepest Heading 6")).toBe(true);
    const h5 = sections.find((s) => s.heading === "Deep Heading 5")!;
    const h6 = sections.find((s) => s.heading === "Deepest Heading 6")!;
    expect(h5.level).toBe(5);
    expect(h6.level).toBe(6);
  });

  it("heading with anchor id extracted under both keys", () => {
    // `<h2 id="install">Install</h2>` is reachable by text *and* by anchor id.
    const src = Buffer.from(
      "<html><body>\n" + '<h2 id="install">Install</h2>\n' + "<p>Run pip.</p>\n" + "</body></html>\n",
    );
    const [, , , sections] = extract(src, "anchor.html");
    const headings = new Set(sections.map((s) => s.heading));
    expect(headings.has("Install")).toBe(true);
    expect(headings.has("install")).toBe(true);
  });

  it("heading with inline tags strips them", () => {
    // `<h2><a href="...">Title</a></h2>` must yield heading text "Title".
    const src = Buffer.from(
      "<html><body>\n" + '<h2><a href="#x">My Title</a></h2>\n' + "</body></html>\n",
    );
    const [, , , sections] = extract(src, "inner.html");
    expect(sections.some((s) => s.heading === "My Title")).toBe(true);
  });

  it("heading spanning multiple lines collapsed", () => {
    // A heading whose inner text spans multiple lines must be a single space-joined token.
    const src = Buffer.from("<html><body>\n<h2>\n  Wrapped\n  Title\n</h2>\n</body></html>\n");
    const [, , , sections] = extract(src, "wrap.html");
    expect(sections.some((s) => s.heading === "Wrapped Title")).toBe(true);
  });
});
