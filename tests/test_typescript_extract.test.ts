/**
 * Tests for arrow-const export promotion in the TypeScript extractor.
 *
 * Faithful 1:1 port of tests/test_typescript_extract.py. Strict NodeNext ESM.
 *
 * Modern React/TS modules frequently expose their public surface entirely as
 * `export const fn = () => {}` arrow-function exports. These must be promoted to
 * kind="function" symbols so skeleton / outline (which filter to structural
 * kinds and exclude plain const) do not report (0 symbols).
 *
 * Async shape: the TS grammar adapter exposes getExtractor(): Promise<Extractor>
 * (web-tree-sitter inits/loads the wasm asynchronously). We resolve the
 * extractor ONCE in beforeAll, then every test calls the resulting SYNC
 * extract(source, rel). The Python @pytest.mark.parametrize tables become
 * it.each loops.
 */
import { describe, it, expect, beforeAll } from "vitest";

import { getExtractor } from "../src/token_goat/languages/typescript.js";
import type { Extractor } from "../src/token_goat/parser.js";

// Resolved once (await getExtractor()), mirroring get_extractor's cache.
let extract: Extractor;

beforeAll(async () => {
  extract = await getExtractor();
});

/** Port of the module-level `_names_to_kinds` helper. */
function _names_to_kinds(source: string, rel_path = "arrows.ts"): Record<string, string> {
  const [symbols] = extract(Buffer.from(source, "utf-8"), rel_path);
  const out: Record<string, string> = {};
  for (const s of symbols) {
    out[s.name] = s.kind;
  }
  return out;
}

// Arrow-const exports only — the exact shape that previously yielded (0 symbols).
const ARROW_ONLY_SOURCE = `export const getClickCursor = (): string => { return 'pointer'; }
export const getDefaultCursor = async (): Promise<string> => { return 'default'; }
export const baz = (x: string): number => x.length;
`;

describe("TypeScript arrow-const export promotion", () => {
  it("arrow const exports become function symbols", () => {
    const kinds = _names_to_kinds(ARROW_ONLY_SOURCE);
    expect(new Set(Object.keys(kinds))).toEqual(
      new Set(["getClickCursor", "getDefaultCursor", "baz"]),
    );
    for (const name of ["getClickCursor", "getDefaultCursor", "baz"]) {
      expect(kinds[name]).toBe("function");
    }
  });

  it("arrow const exports produce three symbols", () => {
    const [symbols] = extract(Buffer.from(ARROW_ONLY_SOURCE, "utf-8"), "arrows.ts");
    const func_syms = symbols.filter((s) => s.kind === "function");
    expect(func_syms.length).toBe(3);
  });

  it.each([
    ["export const f = () => 1;", "f"],
    ["export const g = async () => 1;", "g"],
    ["export const h = (a, b) => a + b;", "h"],
    ["export const single = x => x * 2;", "single"],
    ["export const typed = (n: number): number => n + 1;", "typed"],
    ["export const fnExpr = function () { return 1; };", "fnExpr"],
    ["export let mutable = () => 'm';", "mutable"],
  ])("individual arrow/function-expression export %s -> function", (stmt, name) => {
    const kinds = _names_to_kinds(stmt);
    expect(kinds[name]).toBe("function");
  });

  it.each([
    ["export const PORT = 3000;", "PORT"],
    ["export const router = express();", "router"],
    ["export const config = { a: 1, b: 2 };", "config"],
    ["export const list = [1, 2, 3];", "list"],
    ["export const label = 'hello';", "label"],
  ])("non-function const export %s stays const", (stmt, name) => {
    const kinds = _names_to_kinds(stmt);
    expect(kinds[name]).toBe("const");
  });

  it("object with inner arrow is not promoted", () => {
    // The arrow lives inside an object literal — the export itself is a const.
    const kinds = _names_to_kinds("export const handlers = { onClick: () => 1 };");
    expect(kinds["handlers"]).toBe("const");
  });

  it("mixed module skeleton surface", () => {
    const source = `import { useState } from 'react';

export const useCounter = () => {
  const [n, setN] = useState(0);
  return { n, inc: () => setN(n + 1) };
};

export function helper(x: number): number {
  return x * 2;
}

export const VERSION = '1.0.0';
`;
    const kinds = _names_to_kinds(source, "hook.ts");
    expect(kinds["useCounter"]).toBe("function");
    expect(kinds["helper"]).toBe("function");
    expect(kinds["VERSION"]).toBe("const");
  });

  it("multiline arrow export is function", () => {
    // Prettier wraps long parameter lists across lines. tree-sitter's export pass
    // truncates `export const f =` to the first line and classifies it "const";
    // the source fallback must upgrade it to "function" once it sees the `=>`.
    const source = "export const f = (\n  a: string,\n  b: number,\n) => {}\n";
    const kinds = _names_to_kinds(source);
    expect(kinds["f"]).toBe("function");
  });

  it("inline value after eq multiline arrow", () => {
    // The `=` and the arrow head sit on different lines, so the first-line view
    // is just `export const h =` — again classified "const" until the fallback.
    const source = "export const h =\n  async (req, res) => {}\n";
    const kinds = _names_to_kinds(source);
    expect(kinds["h"]).toBe("function");
  });

  it("template literal export not phantom", () => {
    // An `export const … =>` written inside a backtick template (e.g. a code
    // sample) must not surface a phantom symbol. Only the real export survives.
    const source =
      "export const realFn = () => 1;\n" +
      "const code = `\n" +
      "export const phantom = () => 2\n" +
      "`;\n";
    const [symbols] = extract(Buffer.from(source, "utf-8"), "tmpl.ts");
    const names = new Set(symbols.map((s) => s.name));
    expect(names.has("realFn")).toBe(true);
    expect(names.has("phantom")).toBe(false);
  });
});
