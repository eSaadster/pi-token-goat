/**
 * Tests for the Markdown extractor.
 *
 * Faithful 1:1 port of tests/test_parser_md.py. Strict NodeNext ESM.
 *
 * The Python tests read fixtures from `Path(__file__).parent / "fixtures" /
 * "md_sample"`. The TS port keeps the SAME fixture files (under the repo's
 * top-level tests/fixtures/, shared with the Python suite) by resolving the
 * path relative to this compiled test module: from
 *   <root>/ts/tests/test_parser_md.test.ts
 * walk up two parents to the repo root, then into tests/fixtures/md_sample.
 * This avoids duplicating fixture bytes and keeps the port byte-identical to
 * the Python source.
 */
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { extract } from "../src/token_goat/languages/markdown.js";
import type { Section, Symbol } from "../src/token_goat/parser.js";

const _HERE = path.dirname(fileURLToPath(import.meta.url));
// <root>/ts/tests -> <root>/ts -> <root>; then into the shared Python fixtures.
const _REPO_ROOT = path.resolve(_HERE, "..", "..");
const FIXTURE_DIR = path.join(_REPO_ROOT, "tests", "fixtures", "md_sample");
const ARTICLE_MD = path.join(FIXTURE_DIR, "article.md");

/** Faithful analogue of the `md_source` pytest fixture (reads bytes). */
function md_source(): Buffer {
  return fs.readFileSync(ARTICLE_MD);
}

/** Faithful analogue of the `md_extracted` pytest fixture. */
function md_extracted(): [Symbol[], unknown[], unknown[], Section[]] {
  return extract(md_source(), "article.md");
}

describe("Markdown extractor", () => {
  it("extract returns four lists", () => {
    const [symbols, refs, imports, sections] = md_extracted();
    expect(Array.isArray(symbols)).toBe(true);
    expect(Array.isArray(refs)).toBe(true);
    expect(Array.isArray(imports)).toBe(true);
    expect(Array.isArray(sections)).toBe(true);
  });

  it("frontmatter title extracted", () => {
    const [symbols] = md_extracted();
    const names = new Set(symbols.map((s) => s.name));
    expect(names.has("Test Article")).toBe(true);
    const titleSym = symbols.find((s) => s.name === "Test Article")!;
    expect(titleSym.kind).toBe("md_title");
  });

  it("h1 heading extracted", () => {
    const [, , , sections] = md_extracted();
    const headings = new Set(sections.map((s) => s.heading));
    expect(headings.has("Top Level")).toBe(true);
  });

  it("h2 Methodology extracted", () => {
    const [, , , sections] = md_extracted();
    const headings = new Set(sections.map((s) => s.heading));
    expect(headings.has("Methodology")).toBe(true);
  });

  it("h3 subsection extracted", () => {
    const [, , , sections] = md_extracted();
    const headings = new Set(sections.map((s) => s.heading));
    expect(headings.has("Subsection")).toBe(true);
  });

  it("h2 Results extracted", () => {
    const [, , , sections] = md_extracted();
    const headings = new Set(sections.map((s) => s.heading));
    expect(headings.has("Results")).toBe(true);
  });

  it("heading symbols created", () => {
    const [symbols] = md_extracted();
    const headingSymbols = symbols.filter((s) => s.kind === "heading");
    expect(headingSymbols.length).toBeGreaterThanOrEqual(3);
  });

  it("Methodology end_line computed", () => {
    const [, , , sections] = md_extracted();
    const methodology = sections.find((s) => s.heading === "Methodology")!;
    // Results heading comes after, so end_line should be before Results
    const results = sections.find((s) => s.heading === "Results")!;
    expect(methodology.end_line!).toBeLessThan(results.line);
  });

  // -------------------------------------------------------------------------
  // Precision improvements: fenced-code heading skip + trailing-blank trim
  // -------------------------------------------------------------------------

  it("fenced ATX heading is not indexed as heading", () => {
    const src = Buffer.from(
      "# Real Heading\n" +
        "\n" +
        "Intro.\n" +
        "\n" +
        "```python\n" +
        "# This is a comment, not a heading\n" +
        "## Also not a heading\n" +
        "def foo():\n" +
        "    pass\n" +
        "```\n" +
        "\n" +
        "## Real Subsection\n" +
        "\n" +
        "Content.\n",
    );
    const [, , , sections] = extract(src, "fenced.md");
    const headings = new Set(sections.map((s) => s.heading));
    expect(headings.has("Real Heading")).toBe(true);
    expect(headings.has("Real Subsection")).toBe(true);
    // The two in-fence lines must be excluded.
    expect(headings.has("This is a comment, not a heading")).toBe(false);
    expect(headings.has("Also not a heading")).toBe(false);
  });

  it("fenced ATX heading does not truncate outer section", () => {
    const src = Buffer.from(
      "# Outer\n" +
        "\n" +
        "intro\n" +
        "\n" +
        "```\n" +
        "## Fake H2\n" +
        "```\n" +
        "\n" +
        "more text\n" +
        "\n" +
        "# Next Top\n",
    );
    const [, , , sections] = extract(src, "fenced2.md");
    const outer = sections.find((s) => s.heading === "Outer")!;
    const nextTop = sections.find((s) => s.heading === "Next Top")!;
    // Outer must extend to at least line 9 ("more text"), not stop at line 6.
    expect(outer.end_line).not.toBeNull();
    expect(outer.end_line!).toBeGreaterThanOrEqual(9);
    expect(outer.end_line!).toBeLessThan(nextTop.line);
  });

  it("tilde fenced code block also skipped", () => {
    const src = Buffer.from(
      "# Real\n" + "\n" + "~~~\n" + "## Fake In Tilde\n" + "~~~\n" + "\n" + "## Real Sub\n",
    );
    const [, , , sections] = extract(src, "tilde.md");
    const headings = new Set(sections.map((s) => s.heading));
    expect(headings.has("Fake In Tilde")).toBe(false);
    expect(headings.has("Real Sub")).toBe(true);
  });

  it("section end_line trims trailing blank lines", () => {
    const src = Buffer.from(
      "## A\n" + "\n" + "Aaa.\n" + "\n" + "\n" + "\n" + "## B\n" + "\n" + "Bbb.\n",
    );
    const [, , , sections] = extract(src, "trim.md");
    const a = sections.find((s) => s.heading === "A")!;
    // Section A is heading on line 1, content "Aaa." on line 3, blanks 4-6, B on line 7.
    // end_line must be 3 (last non-blank content line), not 6 (last blank before B).
    expect(a.end_line).toBe(3);
  });

  it("trim preserves heading-only section", () => {
    // Use sibling-level headings so the section terminates at the next one.
    const src = Buffer.from("## Only heading\n\n\n## Next\n");
    const [, , , sections] = extract(src, "only.md");
    const only = sections.find((s) => s.heading === "Only heading")!;
    // No body — end_line must still be at the heading line, never lower.
    expect(only.end_line).toBe(1);
  });

  it("trim does not apply when section contains nested subheading", () => {
    const src = Buffer.from(
      "# Outer\n" + "\n" + "Outer intro.\n" + "\n" + "## Inner\n" + "\n" + "Inner body.\n",
    );
    const [, , , sections] = extract(src, "nested.md");
    const outer = sections.find((s) => s.heading === "Outer")!;
    const inner = sections.find((s) => s.heading === "Inner")!;
    // Outer wraps Inner, so it ends at the last non-blank line of Inner (7).
    expect(outer.end_line).not.toBeNull();
    expect(outer.end_line!).toBeGreaterThanOrEqual(inner.line);
    // Inner has body "Inner body." on line 7 -> end_line should be exactly 7.
    expect(inner.end_line).toBe(7);
  });

  it("fenced skip does not drop heading with hash before fence", () => {
    // Sanity: a real `# Heading` line that happens to immediately precede a
    // fenced block must still be indexed.
    const src = Buffer.from("# Heading Before Fence\n" + "```\n" + "# fake\n" + "```\n");
    const [, , , sections] = extract(src, "before.md");
    const headings = new Set(sections.map((s) => s.heading));
    expect(headings.has("Heading Before Fence")).toBe(true);
    expect(headings.has("fake")).toBe(false);
  });

  // -------------------------------------------------------------------------
  // Setext-style heading support (Title\n=== for H1, Title\n--- for H2)
  // -------------------------------------------------------------------------

  it("setext h1 extracted", () => {
    // `Title\n===` must produce an H1 section at the *text* line.
    const src = Buffer.from("Some Big Title\n" + "==============\n" + "\n" + "body text\n");
    const [, , , sections] = extract(src, "setext1.md");
    const titles = sections.filter((s) => s.heading === "Some Big Title");
    expect(titles.length).toBe(1);
    expect(titles[0]!.level).toBe(1);
    expect(titles[0]!.line).toBe(1);
  });

  it("setext h2 extracted", () => {
    // `Title\n---` must produce an H2 section when the line above is non-blank.
    const src = Buffer.from("H2 Subtitle\n" + "-----------\n" + "\n" + "body\n");
    const [, , , sections] = extract(src, "setext2.md");
    const subs = sections.filter((s) => s.heading === "H2 Subtitle");
    expect(subs.length).toBe(1);
    expect(subs[0]!.level).toBe(2);
  });

  it("setext h2 not confused with hr", () => {
    // A `---` that follows a blank line is a horizontal rule, not setext.
    const src = Buffer.from("Some paragraph.\n" + "\n" + "---\n" + "\n" + "More text.\n");
    const [, , , sections] = extract(src, "hr.md");
    expect(sections.some((s) => s.heading === "Some paragraph.")).toBe(false);
  });

  it("setext skipped inside fence", () => {
    // A setext underline inside a code fence must not promote the line above.
    const src = Buffer.from("```\n" + "Fake Title\n" + "==========\n" + "```\n" + "\n" + "# Real\n");
    const [, , , sections] = extract(src, "setextfence.md");
    expect(sections.some((s) => s.heading === "Fake Title")).toBe(false);
    expect(sections.some((s) => s.heading === "Real")).toBe(true);
  });

  it("setext skipped when text is blockquote", () => {
    // `> Quoted\n---` is content inside a blockquote, not a setext heading.
    const src = Buffer.from("> Quoted text\n" + "-------------\n");
    const [, , , sections] = extract(src, "setextquote.md");
    expect(sections.some((s) => s.heading === "> Quoted text")).toBe(false);
  });

  it("setext and atx interleaved end lines", () => {
    // Setext + ATX in the same doc must yield correct end_lines in doc order.
    const src = Buffer.from(
      "Top\n" +
        "===\n" +
        "\n" +
        "intro\n" +
        "\n" +
        "## Sub A\n" +
        "\n" +
        "aaa\n" +
        "\n" +
        "Sub B\n" +
        "-----\n" +
        "\n" +
        "bbb\n",
    );
    const [, , , sections] = extract(src, "mix.md");
    const top = sections.find((s) => s.heading === "Top")!;
    const subA = sections.find((s) => s.heading === "Sub A")!;
    const subB = sections.find((s) => s.heading === "Sub B")!;
    // Top is H1 and should wrap both H2s.  Sub A ends before Sub B starts.
    expect(top.line).toBeLessThan(subA.line);
    expect(subA.line).toBeLessThan(subB.line);
    expect(subA.end_line).not.toBeNull();
    expect(subA.end_line!).toBeLessThan(subB.line);
  });

  // -------------------------------------------------------------------------
  // Blockquote / list-prefixed ATX-looking lines must be skipped
  // -------------------------------------------------------------------------

  it("blockquoted ATX not extracted", () => {
    // `> ## Quoted` is content inside a blockquote, not a section.
    const src = Buffer.from(
      "# Real\n" + "\n" + "> ## Quoted heading\n" + "> more quote\n" + "\n" + "## Real Sub\n",
    );
    const [, , , sections] = extract(src, "quoted.md");
    const headings = new Set(sections.map((s) => s.heading));
    expect(headings.has("Real")).toBe(true);
    expect(headings.has("Real Sub")).toBe(true);
    expect(headings.has("Quoted heading")).toBe(false);
  });

  it("list item ATX not extracted", () => {
    // `- ## item` and `1. ## item` are list content, not sections.
    const src = Buffer.from(
      "# Real\n" +
        "\n" +
        "- ## list item heading\n" +
        "- another\n" +
        "\n" +
        "1. ## ordered item\n" +
        "\n" +
        "## Real Sub\n",
    );
    const [, , , sections] = extract(src, "listitem.md");
    const headings = new Set(sections.map((s) => s.heading));
    expect(headings.has("list item heading")).toBe(false);
    expect(headings.has("ordered item")).toBe(false);
    expect(headings.has("Real Sub")).toBe(true);
  });

  // -------------------------------------------------------------------------
  // Front-matter exposed as synthetic `__frontmatter__` section
  // -------------------------------------------------------------------------

  it("frontmatter synthetic section", () => {
    // YAML front-matter must produce a `__frontmatter__` section covering its span.
    const src = Buffer.from(
      "---\n" +
        "title: Hello\n" +
        "author: Someone\n" +
        "---\n" +
        "\n" +
        "# Body\n" +
        "\n" +
        "text\n",
    );
    const [, , , sections] = extract(src, "fm.md");
    const fm = sections.find((s) => s.heading === "__frontmatter__");
    expect(fm, "expected synthetic __frontmatter__ section").toBeDefined();
    expect(fm!.line).toBe(1);
    // Closing `---` is on line 4; end_line must cover at least line 4 and not
    // extend into the body.
    expect(fm!.end_line).not.toBeNull();
    expect(fm!.end_line!).toBeGreaterThanOrEqual(3);
    // Body H1 must still be extracted normally.
    expect(sections.some((s) => s.heading === "Body")).toBe(true);
  });

  it("no frontmatter means no synthetic section", () => {
    // Files without front-matter must not get a `__frontmatter__` section.
    const src = Buffer.from("# Title\n\nbody\n");
    const [, , , sections] = extract(src, "no-fm.md");
    expect(sections.some((s) => s.heading === "__frontmatter__")).toBe(false);
  });

  // -------------------------------------------------------------------------
  // GitHub-flavored Markdown <details><summary>...</summary>...</details> blocks
  // -------------------------------------------------------------------------

  it("details block with summary extracted", () => {
    // `<details><summary>Title</summary>body</details>` is a section named "Title".
    const src = Buffer.from(
      "# Real Heading\n" +
        "\n" +
        "<details>\n" +
        "<summary>Click to expand</summary>\n" +
        "\n" +
        "Hidden body content.\n" +
        "\n" +
        "</details>\n" +
        "\n" +
        "## After\n",
    );
    const [, , , sections] = extract(src, "details.md");
    const headings = new Set(sections.map((s) => s.heading));
    expect(headings.has("Click to expand")).toBe(true);
    const detail = sections.find((s) => s.heading === "Click to expand")!;
    // level=99 sentinel keeps it out of ATX/Setext hierarchy.
    expect(detail.level).toBe(99);
    // Block starts on line 3 (the `<details>` opener).
    expect(detail.line).toBe(3);
    // end_line must cover through the `</details>` closer on line 8.
    expect(detail.end_line).not.toBeNull();
    expect(detail.end_line!).toBeGreaterThanOrEqual(8);
  });

  it("details block heading symbol created", () => {
    // Detail summaries must be findable via `token-goat symbol <summary>`.
    const src = Buffer.from("<details><summary>Findable Title</summary>body</details>\n");
    const [symbols] = extract(src, "ds.md");
    const names = new Set(
      symbols.filter((s) => s.kind === "heading").map((s) => s.name),
    );
    expect(names.has("Findable Title")).toBe(true);
  });

  it("details block without summary uses synthetic name", () => {
    // `<details>` with no `<summary>` produces a `__details__` section.
    const src = Buffer.from("<details>\n" + "No summary here.\n" + "</details>\n");
    const [, , , sections] = extract(src, "ds-nosum.md");
    const headings = new Set(sections.map((s) => s.heading));
    expect(headings.has("__details__")).toBe(true);
  });

  it("details block strips inline markup from summary", () => {
    // Inline HTML inside `<summary>` (e.g. <b>, <i>) must be stripped from the name.
    const src = Buffer.from(
      "<details>\n" +
        "<summary><b>Bold</b> and <i>italic</i> text</summary>\n" +
        "body\n" +
        "</details>\n",
    );
    const [, , , sections] = extract(src, "ds-markup.md");
    const headings = new Set(sections.map((s) => s.heading));
    // The visible label is "Bold and italic text", not "<b>Bold</b>...".
    expect(headings.has("Bold and italic text")).toBe(true);
  });

  it("nested details emits outer only", () => {
    // A nested `<details>` inside another must not corrupt the outer's end_line.
    const src = Buffer.from(
      "<details>\n" +
        "<summary>Outer</summary>\n" +
        "\n" +
        "<details>\n" +
        "<summary>Inner</summary>\n" +
        "inner body\n" +
        "</details>\n" +
        "\n" +
        "</details>\n",
    );
    const [, , , sections] = extract(src, "ds-nested.md");
    const headings = new Set(sections.map((s) => s.heading));
    expect(headings.has("Outer")).toBe(true);
    // Inner is intentionally not emitted as a separate section.
    expect(headings.has("Inner")).toBe(false);
    const outer = sections.find((s) => s.heading === "Outer")!;
    // Outer must extend through the *outer* closing </details> on line 9.
    expect(outer.end_line).not.toBeNull();
    expect(outer.end_line!).toBeGreaterThanOrEqual(9);
  });

  it("details inside fenced code block skipped", () => {
    // A literal `<details>` example inside a ``` fence is documentation, not a section.
    const src = Buffer.from(
      "# Real\n" +
        "\n" +
        "```html\n" +
        "<details>\n" +
        "<summary>Fake</summary>\n" +
        "example body\n" +
        "</details>\n" +
        "```\n" +
        "\n" +
        "## After\n",
    );
    const [, , , sections] = extract(src, "ds-fenced.md");
    const headings = new Set(sections.map((s) => s.heading));
    expect(headings.has("Fake")).toBe(false);
    expect(headings.has("Real")).toBe(true);
    expect(headings.has("After")).toBe(true);
  });

  it("details open tag with attributes handled", () => {
    // `<details open class="foo">` must still be recognized as an opener.
    const src = Buffer.from(
      '<details open class="foo">\n' +
        "<summary>Attr Title</summary>\n" +
        "body\n" +
        "</details>\n",
    );
    const [, , , sections] = extract(src, "ds-attr.md");
    const headings = new Set(sections.map((s) => s.heading));
    expect(headings.has("Attr Title")).toBe(true);
  });

  it("details summary with attributes handled", () => {
    // `<summary class="foo">Title</summary>` must be parsed.
    const src = Buffer.from(
      "<details>\n" + '<summary class="bold">Has Attrs</summary>\n' + "body\n" + "</details>\n",
    );
    const [, , , sections] = extract(src, "ds-sattr.md");
    const headings = new Set(sections.map((s) => s.heading));
    expect(headings.has("Has Attrs")).toBe(true);
  });

  it("details inline one liner", () => {
    // One-line `<details><summary>X</summary>body</details>` must be recognized.
    const src = Buffer.from("<details><summary>Inline</summary>body</details>\n");
    const [, , , sections] = extract(src, "ds-inline.md");
    const headings = new Set(sections.map((s) => s.heading));
    expect(headings.has("Inline")).toBe(true);
    const inline = sections.find((s) => s.heading === "Inline")!;
    // Single-line block: start and end line are both 1.
    expect(inline.line).toBe(1);
    expect(inline.end_line).toBe(1);
  });

  it("details does not break surrounding headings", () => {
    // ATX headings before/after a `<details>` block must still parse normally.
    const src = Buffer.from(
      "# Before\n" +
        "\n" +
        "<details>\n" +
        "<summary>Mid</summary>\n" +
        "body\n" +
        "</details>\n" +
        "\n" +
        "## After\n" +
        "\n" +
        "after body\n",
    );
    const [, , , sections] = extract(src, "ds-sandwich.md");
    const headings = new Set(sections.map((s) => s.heading));
    expect(headings.has("Before")).toBe(true);
    expect(headings.has("After")).toBe(true);
    expect(headings.has("Mid")).toBe(true);
  });

  it("stray close details is ignored", () => {
    // A bare `</details>` with no opener must not crash and not produce a section.
    const src = Buffer.from("# Real\n" + "</details>\n" + "\n" + "text\n");
    // Must not raise; result should contain Real and no synthetic details section.
    const [, , , sections] = extract(src, "ds-stray.md");
    const headings = new Set(sections.map((s) => s.heading));
    expect(headings.has("Real")).toBe(true);
    expect(headings.has("__details__")).toBe(false);
  });

  it("details with empty summary falls back to synthetic", () => {
    // `<summary></summary>` (or whitespace only) falls back to `__details__`.
    const src = Buffer.from(
      "<details>\n" + "<summary>   </summary>\n" + "body\n" + "</details>\n",
    );
    const [, , , sections] = extract(src, "ds-empty-sum.md");
    const headings = new Set(sections.map((s) => s.heading));
    expect(headings.has("__details__")).toBe(true);
  });
});
