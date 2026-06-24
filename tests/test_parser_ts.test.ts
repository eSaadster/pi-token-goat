/**
 * Tests for the TypeScript extractor (web-tree-sitter grammar adapter).
 *
 * Faithful 1:1 port of tests/test_parser_ts.py. Strict NodeNext ESM.
 *
 * Async shape: the Python suite imports a SYNC `extract`; the TS grammar adapter
 * exposes `getExtractor(): Promise<Extractor>` (web-tree-sitter must init and
 * load the typescript/tsx/javascript wasm asynchronously). We resolve the
 * extractor ONCE in beforeAll, then every test calls the resulting SYNC
 * extract(source, rel) — exactly how parser.ts's get_extractor caches it. The
 * fixtures are the SAME bytes the Python suite reads (shared
 * <root>/tests/fixtures/ts_sample/index.ts), resolved relative to this module so
 * no fixture is duplicated.
 */
import { describe, it, expect, beforeAll } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { getExtractor } from "../src/token_goat/languages/typescript.js";
import type { Extractor, ImpExp, Ref, Section, Symbol } from "../src/token_goat/parser.js";

const _HERE = path.dirname(fileURLToPath(import.meta.url));
// <root>/ts/tests -> <root>/ts -> <root>; then into the shared TS fixtures.
const _REPO_ROOT = path.resolve(_HERE, "..", "..");
const FIXTURE_DIR = path.join(_REPO_ROOT, "tests", "fixtures", "ts_sample");
const INDEX_TS = path.join(FIXTURE_DIR, "index.ts");

// Resolved once (await getExtractor()), mirroring get_extractor's cache.
let extract: Extractor;

beforeAll(async () => {
  extract = await getExtractor();
});

/** Faithful analogue of the `ts_source` pytest fixture (reads bytes). */
function ts_source(): Buffer {
  return fs.readFileSync(INDEX_TS);
}

/** Faithful analogue of the `ts_extracted` pytest fixture. */
function ts_extracted(): [Symbol[], Ref[], ImpExp[], Section[]] {
  return extract(ts_source(), "index.ts");
}

describe("TypeScript extractor", () => {
  it("extract returns three lists", () => {
    const [symbols, refs, imp_exp] = ts_extracted();
    expect(Array.isArray(symbols)).toBe(true);
    expect(Array.isArray(refs)).toBe(true);
    expect(Array.isArray(imp_exp)).toBe(true);
  });

  it("greet function extracted", () => {
    const [symbols] = ts_extracted();
    const names = new Set(symbols.map((s) => s.name));
    expect(names.has("greet")).toBe(true);
    const greet = symbols.find((s) => s.name === "greet")!;
    expect(greet.kind).toBe("function");
    expect(greet.line).toBe(4);
  });

  it("UserService class extracted", () => {
    const [symbols] = ts_extracted();
    const names = new Set(symbols.map((s) => s.name));
    expect(names.has("UserService")).toBe(true);
    const svc = symbols.find((s) => s.name === "UserService")!;
    expect(svc.kind).toBe("class");
  });

  it("hello method extracted", () => {
    const [symbols] = ts_extracted();
    const names = new Set(symbols.map((s) => s.name));
    expect(names.has("hello")).toBe(true);
    const hello = symbols.find((s) => s.name === "hello")!;
    expect(hello.kind).toBe("method");
    expect(hello.parent_name).toBe("UserService");
  });

  it("User interface extracted", () => {
    const [symbols] = ts_extracted();
    const names = new Set(symbols.map((s) => s.name));
    expect(names.has("User")).toBe(true);
    const user = symbols.find((s) => s.name === "User")!;
    expect(user.kind).toBe("interface");
  });

  it("UserId type extracted", () => {
    const [symbols] = ts_extracted();
    const names = new Set(symbols.map((s) => s.name));
    expect(names.has("UserId")).toBe(true);
    const uid = symbols.find((s) => s.name === "UserId")!;
    expect(uid.kind).toBe("type");
  });

  it("router const extracted", () => {
    const [symbols] = ts_extracted();
    const names = new Set(symbols.map((s) => s.name));
    expect(names.has("router")).toBe(true);
    const router = symbols.find((s) => s.name === "router")!;
    expect(router.kind).toBe("const");
  });

  it("greet has signature", () => {
    const [symbols] = ts_extracted();
    const greet = symbols.find((s) => s.name === "greet")!;
    expect(greet.signature).not.toBeNull();
    expect(greet.signature!).toContain("greet");
    expect(greet.signature!).toContain("name");
  });

  it("imports include node:path", () => {
    const [, , imp_exp] = ts_extracted();
    const import_targets = new Set(
      imp_exp.filter((ie) => ie.kind === "import").map((ie) => ie.target),
    );
    expect(import_targets.has("node:path")).toBe(true);
  });

  it("imports include express", () => {
    const [, , imp_exp] = ts_extracted();
    const import_targets = new Set(
      imp_exp.filter((ie) => ie.kind === "import").map((ie) => ie.target),
    );
    expect(import_targets.has("express")).toBe(true);
  });

  it("exports include greet", () => {
    const [, , imp_exp] = ts_extracted();
    const export_targets = new Set(
      imp_exp.filter((ie) => ie.kind === "export").map((ie) => ie.target),
    );
    expect(export_targets.has("greet")).toBe(true);
  });

  it("refs include greet call", () => {
    const [, refs] = ts_extracted();
    const ref_names = new Set(refs.map((r) => r.name));
    // greet is called inside hello()
    expect(ref_names.has("greet")).toBe(true);
  });

  it("refs include express call", () => {
    const [, refs] = ts_extracted();
    const ref_names = new Set(refs.map((r) => r.name));
    expect(ref_names.has("express")).toBe(true);
  });

  it("ref has line and context", () => {
    const [, refs] = ts_extracted();
    const greet_refs = refs.filter((r) => r.name === "greet");
    expect(greet_refs.length).toBeGreaterThan(0);
    for (const r of greet_refs) {
      expect(r.line).toBeGreaterThan(0);
      expect(r.context).not.toBeNull();
    }
  });

  it("no single char refs", () => {
    const [, refs] = ts_extracted();
    for (const r of refs) {
      expect(r.name.length).toBeGreaterThan(1);
    }
  });

  it("line numbers are one-indexed", () => {
    const [symbols] = ts_extracted();
    for (const s of symbols) {
      expect(s.line).toBeGreaterThanOrEqual(1);
    }
  });

  it("tsx extension accepted", () => {
    // tsx files should parse without error.
    const source = Buffer.from("export const Comp = () => <div>hello</div>;\n");
    const [symbols] = extract(source, "comp.tsx");
    expect(Array.isArray(symbols)).toBe(true);
  });

  it("js extension accepted", () => {
    // Plain .js files should parse.
    const source = Buffer.from("export function foo() { return 1; }\n");
    const [symbols] = extract(source, "util.js");
    const names = new Set(symbols.map((s) => s.name));
    expect(names.has("foo")).toBe(true);
  });

  // -------------------------------------------------------------------------
  // Precision: TypeScript decorator lines must be included in the symbol's
  // start_line. Mirrors the Python adapter's _extend_starts_for_decorators
  // post-pass.
  // -------------------------------------------------------------------------

  it("single decorator extends class start_line", () => {
    // @Injectable()-decorated class: start_line must point at the decorator.
    const src = Buffer.from("@Injectable()\nexport class Foo {\n  x = 1;\n}\n");
    const [symbols] = extract(src, "deco_single.ts");
    const foo = symbols.find((s) => s.name === "Foo")!;
    expect(foo.line).toBe(1);
  });

  it("multiline decorator extends class start_line", () => {
    // @Component({ … }) spanning multiple lines: start_line at the @ line.
    const src = Buffer.from(
      "@Component({\n" +
        "  selector: 'x-foo',\n" +
        "  template: '<div></div>',\n" +
        "})\n" +
        "export class Foo {}\n",
    );
    const [symbols] = extract(src, "deco_multiline.ts");
    const foo = symbols.find((s) => s.name === "Foo")!;
    expect(foo.line).toBe(1);
  });

  it("stacked decorators extend start_line", () => {
    // Multiple stacked TS decorators: start_line is the topmost @ line.
    const src = Buffer.from(
      "@First\n@Second('arg')\n@Third\nexport class Foo {}\n",
    );
    const [symbols] = extract(src, "deco_stacked.ts");
    const foo = symbols.find((s) => s.name === "Foo")!;
    expect(foo.line).toBe(1);
  });

  it("method decorator extends start_line", () => {
    // A decorated method inside a class also gets start_line moved up.
    const src = Buffer.from(
      "export class C {\n" +
        "  @log\n" +
        "  hello(): string {\n" +
        "    return 'hi';\n" +
        "  }\n" +
        "}\n",
    );
    const [symbols] = extract(src, "deco_method.ts");
    const hello = symbols.find((s) => s.name === "hello")!;
    // @log is on line 2; the method def is on line 3 — start should be 2.
    expect(hello.line).toBe(2);
  });

  it("undecorated class unchanged", () => {
    // No decorator → start_line is the `class` line as before.
    const src = Buffer.from("export class Plain {\n  x = 1;\n}\n");
    const [symbols] = extract(src, "plain.ts");
    const plain = symbols.find((s) => s.name === "Plain")!;
    expect(plain.line).toBe(1);
  });

  it("comment above class is not treated as decorator", () => {
    // Only @ lines (and their argument continuations) are pulled in.
    const src = Buffer.from("// docs above\nexport class Foo {}\n");
    const [symbols] = extract(src, "comment.ts");
    const foo = symbols.find((s) => s.name === "Foo")!;
    expect(foo.line).toBe(2); // the // comment must stay outside
  });

  it("class methods have parent_name", () => {
    // All methods on a class should carry parent_name = class name.
    const src = Buffer.from(
      "export class MyService {\n" +
        "  constructor(private url: string) {}\n" +
        "\n" +
        "  async fetchData(id: number): Promise<string> {\n" +
        "    return '';\n" +
        "  }\n" +
        "\n" +
        "  render(): void {}\n" +
        "}\n",
    );
    const [symbols] = extract(src, "service.ts");
    const methods = new Map(
      symbols.filter((s) => s.kind === "method").map((s) => [s.name, s]),
    );
    expect(methods.has("fetchData")).toBe(true);
    expect(methods.has("render")).toBe(true);
    expect(methods.get("fetchData")!.parent_name).toBe("MyService");
    expect(methods.get("render")!.parent_name).toBe("MyService");
  });

  it("class methods are not top-level functions", () => {
    // Class methods should not be emitted with kind='function'.
    const src = Buffer.from(
      "export class Calc {\n" +
        "  add(a: number, b: number): number { return a + b; }\n" +
        "  sub(a: number, b: number): number { return a - b; }\n" +
        "}\n" +
        "\n" +
        "export function topLevel(): void {}\n",
    );
    const [symbols] = extract(src, "calc.ts");
    const top = symbols.find((s) => s.name === "topLevel")!;
    expect(top.kind).toBe("function");
    expect(top.parent_name).toBeNull();

    const add = symbols.find((s) => s.name === "add") ?? null;
    if (add) {
      expect(add.kind).toBe("method");
      expect(add.parent_name).toBe("Calc");
    }
  });
});
