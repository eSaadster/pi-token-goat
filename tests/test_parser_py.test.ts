/**
 * Tests for the Python extractor (web-tree-sitter grammar adapter).
 *
 * Faithful 1:1 port of tests/test_parser_py.py. Strict NodeNext ESM.
 *
 * Async shape: the Python suite imports a SYNC `extract`; the TS grammar adapter
 * exposes `getExtractor(): Promise<Extractor>` (web-tree-sitter must init and
 * load the python wasm asynchronously). We resolve the extractor ONCE in
 * beforeAll, then every test calls the resulting SYNC extract(source, rel) —
 * exactly how parser.ts's get_extractor caches it. The fixtures are the SAME
 * bytes the Python suite reads (shared <root>/tests/fixtures/py_sample/app.py),
 * resolved relative to this module so no fixture is duplicated.
 */
import { describe, it, expect, beforeAll } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { getExtractor } from "../src/token_goat/languages/python.js";
import type { Extractor, ImpExp, Ref, Section, Symbol } from "../src/token_goat/parser.js";

const _HERE = path.dirname(fileURLToPath(import.meta.url));
// <root>/ts/tests -> <root>/ts -> <root>; then into the shared Python fixtures.
const _REPO_ROOT = path.resolve(_HERE, "..", "..");
const FIXTURE_DIR = path.join(_REPO_ROOT, "tests", "fixtures", "py_sample");
const APP_PY = path.join(FIXTURE_DIR, "app.py");

// Resolved once (await getExtractor()), mirroring get_extractor's cache.
let extract: Extractor;

beforeAll(async () => {
  extract = await getExtractor();
});

/** Faithful analogue of the `py_source` pytest fixture (reads bytes). */
function py_source(): Buffer {
  return fs.readFileSync(APP_PY);
}

/** Faithful analogue of the `py_extracted` pytest fixture. */
function py_extracted(): [Symbol[], Ref[], ImpExp[], Section[]] {
  return extract(py_source(), "app.py");
}

describe("Python extractor", () => {
  it("extract returns three lists", () => {
    const [symbols, refs, imp_exp] = py_extracted();
    expect(Array.isArray(symbols)).toBe(true);
    expect(Array.isArray(refs)).toBe(true);
    expect(Array.isArray(imp_exp)).toBe(true);
  });

  it("greet function extracted", () => {
    const [symbols] = py_extracted();
    const names = new Set(symbols.map((s) => s.name));
    expect(names.has("greet")).toBe(true);
    const greet = symbols.find((s) => s.name === "greet")!;
    expect(greet.kind).toBe("function");
    expect(greet.line).toBeGreaterThanOrEqual(1);
  });

  it("UserService class extracted", () => {
    const [symbols] = py_extracted();
    const names = new Set(symbols.map((s) => s.name));
    expect(names.has("UserService")).toBe(true);
    const svc = symbols.find((s) => s.name === "UserService")!;
    expect(svc.kind).toBe("class");
  });

  it("__init__ method extracted", () => {
    const [symbols] = py_extracted();
    const names = new Set(symbols.map((s) => s.name));
    expect(names.has("__init__")).toBe(true);
    const init = symbols.find((s) => s.name === "__init__")!;
    expect(init.kind).toBe("method");
    expect(init.parent_name).toBe("UserService");
  });

  it("hello method extracted", () => {
    const [symbols] = py_extracted();
    const names = new Set(symbols.map((s) => s.name));
    expect(names.has("hello")).toBe(true);
    const hello = symbols.find((s) => s.name === "hello")!;
    expect(hello.kind).toBe("method");
    expect(hello.parent_name).toBe("UserService");
  });

  it("greet has signature", () => {
    const [symbols] = py_extracted();
    const greet = symbols.find((s) => s.name === "greet")!;
    expect(greet.signature).not.toBeNull();
    expect(greet.signature!).toContain("greet");
  });

  it("import os extracted", () => {
    const [, , imp_exp] = py_extracted();
    const import_targets = new Set(
      imp_exp.filter((ie) => ie.kind === "import").map((ie) => ie.target),
    );
    expect(import_targets.has("os")).toBe(true);
  });

  it("import pathlib extracted", () => {
    const [, , imp_exp] = py_extracted();
    const import_targets = new Set(
      imp_exp.filter((ie) => ie.kind === "import").map((ie) => ie.target),
    );
    // from pathlib import Path -> pathlib.Path
    expect([...import_targets].some((t) => t.includes("pathlib"))).toBe(true);
  });

  it("refs include greet call", () => {
    const [, refs] = py_extracted();
    const ref_names = new Set(refs.map((r) => r.name));
    expect(ref_names.has("greet")).toBe(true);
  });

  it("ref has line and context", () => {
    const [, refs] = py_extracted();
    const greet_refs = refs.filter((r) => r.name === "greet");
    expect(greet_refs.length).toBeGreaterThan(0);
    for (const r of greet_refs) {
      expect(r.line).toBeGreaterThan(0);
      expect(r.context).not.toBeNull();
    }
  });

  it("no single char refs", () => {
    const [, refs] = py_extracted();
    for (const r of refs) {
      expect(r.name.length).toBeGreaterThan(1);
    }
  });

  it("line numbers are one-indexed", () => {
    const [symbols] = py_extracted();
    for (const s of symbols) {
      expect(s.line).toBeGreaterThanOrEqual(1);
    }
  });

  it("end_line >= start_line", () => {
    const [symbols] = py_extracted();
    for (const s of symbols) {
      if (s.end_line !== null) {
        expect(s.end_line).toBeGreaterThanOrEqual(s.line);
      }
    }
  });

  it("class end_line spans methods", () => {
    const [symbols] = py_extracted();
    const svc = symbols.find((s) => s.name === "UserService")!;
    expect(svc.end_line).not.toBeNull();
    // Class must extend past the line where __init__ and hello are defined.
    const init = symbols.find((s) => s.name === "__init__")!;
    expect(svc.end_line!).toBeGreaterThanOrEqual(init.line);
  });

  it("invalid source returns empty", () => {
    // Truncated/invalid source should return empty lists rather than raise.
    const result = extract(Buffer.from([0xff, 0xfe, 0x20, 0x67, 0x61, 0x72, 0x62, 0x61, 0x67, 0x65, 0x20, 0x00, 0x01]), "bad.py");
    for (const lst of result) {
      expect(Array.isArray(lst)).toBe(true);
    }
  });

  // -------------------------------------------------------------------------
  // Precision: decorator lines must be included in the symbol's start_line.
  // -------------------------------------------------------------------------

  it("single decorator extends start_line", () => {
    // @cache-decorated function: start_line must point at the decorator, not def.
    const src = Buffer.from("@cache\ndef fn():\n    return 1\n");
    const [symbols] = extract(src, "deco_single.py");
    const fn = symbols.find((s) => s.name === "fn")!;
    expect(fn.line).toBe(1);
  });

  it("multiple decorators extend start_line", () => {
    const src = Buffer.from(
      "@first\n@second(arg)\n@third(\"string\")\ndef fn():\n    return 1\n",
    );
    const [symbols] = extract(src, "deco_multi.py");
    const fn = symbols.find((s) => s.name === "fn")!;
    expect(fn.line).toBe(1);
  });

  it("class decorator extends start_line", () => {
    const src = Buffer.from("@dataclass\nclass Foo:\n    x: int\n");
    const [symbols] = extract(src, "deco_class.py");
    const foo = symbols.find((s) => s.name === "Foo")!;
    expect(foo.line).toBe(1);
  });

  it("method decorator extends start_line", () => {
    const src = Buffer.from(
      "class C:\n    @property\n    def name(self):\n        return self._n\n",
    );
    const [symbols] = extract(src, "deco_method.py");
    const name = symbols.find((s) => s.name === "name")!;
    // @property is on line 2; def is on line 3 — start should be 2.
    expect(name.line).toBe(2);
  });

  it("undecorated function unchanged", () => {
    const src = Buffer.from("def plain():\n    return 1\n");
    const [symbols] = extract(src, "plain.py");
    const plain = symbols.find((s) => s.name === "plain")!;
    expect(plain.line).toBe(1); // already line 1; nothing to change
  });

  it("comment above def is not treated as decorator", () => {
    const src = Buffer.from("# This is a comment about fn\ndef fn():\n    return 1\n");
    const [symbols] = extract(src, "comment.py");
    const fn = symbols.find((s) => s.name === "fn")!;
    // Comment must NOT be pulled in — start_line stays at the def line (2).
    expect(fn.line).toBe(2);
  });

  it("blank gap between decorators tolerated", () => {
    const src = Buffer.from("@first\n\n@second\ndef fn():\n    return 1\n");
    const [symbols] = extract(src, "deco_gap.py");
    const fn = symbols.find((s) => s.name === "fn")!;
    expect(fn.line).toBe(1);
  });

  it("no decorator extension for const/var", () => {
    const src = Buffer.from("# top comment\nMY_CONST = 42\n");
    const [symbols] = extract(src, "const.py");
    const mc = symbols.filter((s) => s.name === "MY_CONST");
    if (mc.length > 0) {
      // Whatever line it reports, it must not be the comment line.
      expect(mc[0]!.line).toBe(2);
    }
  });

  it("property/classmethod/staticmethod extracted as method", () => {
    const src = Buffer.from(
      "class MyClass:\n" +
        "    def __init__(self, x):\n" +
        "        self._x = x\n" +
        "\n" +
        "    @property\n" +
        "    def value(self):\n" +
        "        return self._x\n" +
        "\n" +
        "    @classmethod\n" +
        "    def create(cls, x):\n" +
        "        return cls(x)\n" +
        "\n" +
        "    @staticmethod\n" +
        "    def helper():\n" +
        "        return 42\n",
    );
    const [symbols] = extract(src, "cls.py");
    const by_name = new Map(
      symbols.filter((s) => s.parent_name === "MyClass").map((s) => [s.name, s]),
    );
    expect(by_name.has("value")).toBe(true);
    expect(by_name.has("create")).toBe(true);
    expect(by_name.has("helper")).toBe(true);
    expect(by_name.get("value")!.kind).toBe("method");
    expect(by_name.get("create")!.kind).toBe("method");
    expect(by_name.get("helper")!.kind).toBe("method");
  });

  it("property method parent_name set", () => {
    const src = Buffer.from(
      "class Config:\n" +
        "    @property\n" +
        "    def debug(self) -> bool:\n" +
        "        return self._debug\n",
    );
    const [symbols] = extract(src, "cfg.py");
    const debug = symbols.find((s) => s.name === "debug") ?? null;
    expect(debug).not.toBeNull();
    expect(debug!.parent_name).toBe("Config");
    expect(debug!.kind).toBe("method");
  });
});
