/**
 * Tests for the Ruby symbol extractor (web-tree-sitter grammar adapter).
 *
 * Faithful 1:1 port of tests/test_parser_ruby.py. Strict NodeNext ESM.
 *
 * The Python adapter exposes a synchronous `extract(source, rel_path)`. The TS
 * grammar adapter instead exposes `export async function getExtractor()` that
 * resolves the web-tree-sitter parser once and returns the SYNC extract closure
 * (per the Layer-7 grammar-adapter contract). So the suite resolves the closure
 * once in `beforeAll` and every case calls it synchronously, exactly mirroring
 * the Python `extract` calls.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { beforeAll, describe, expect, it } from "vitest";

import type { Extractor, ImpExp, Ref, Section, Symbol } from "../src/token_goat/parser.js";
import { getExtractor } from "../src/token_goat/languages/ruby.js";

type Extracted = [Symbol[], Ref[], ImpExp[], Section[]];

const FIXTURE = fileURLToPath(
  new URL("../../tests/fixtures/ruby_sample/animal.rb", import.meta.url),
);

let extract: Extractor;
let rbSource: Buffer;
let rbExtracted: Extracted;

beforeAll(async () => {
  extract = await getExtractor();
  rbSource = readFileSync(FIXTURE);
  rbExtracted = extract(rbSource, "animal.rb") as Extracted;
});

describe("test_parser_ruby (port of tests/test_parser_ruby.py)", () => {
  it("test_returns_four_lists", () => {
    for (const lst of rbExtracted) {
      expect(Array.isArray(lst)).toBe(true);
    }
  });

  it("test_module_extracted", () => {
    const [symbols] = rbExtracted;
    const mod = symbols.find((s) => s.name === "Animals");
    expect(mod).not.toBeUndefined();
    expect(mod!.kind).toBe("const");
  });

  it("test_class_extracted", () => {
    const [symbols] = rbExtracted;
    const cls = symbols.find((s) => s.name === "Animal" && s.kind === "class");
    expect(cls).not.toBeUndefined();
  });

  it("test_subclass_extracted", () => {
    const [symbols] = rbExtracted;
    const cls = symbols.find((s) => s.name === "Dog" && s.kind === "class");
    expect(cls).not.toBeUndefined();
  });

  it("test_instance_method_extracted", () => {
    const [symbols] = rbExtracted;
    const names = new Set(symbols.filter((s) => s.kind === "method").map((s) => s.name));
    expect(names.has("speak")).toBe(true);
    expect(names.has("bark")).toBe(true);
    expect(names.has("initialize")).toBe(true);
  });

  it("test_class_method_extracted", () => {
    const [symbols] = rbExtracted;
    const mth = symbols.find((s) => s.name === "create");
    expect(mth).not.toBeUndefined();
    expect(mth!.kind).toBe("method");
    expect(mth!.parent_name).toBe("Animal");
  });

  it("test_method_parent_name", () => {
    const [symbols] = rbExtracted;
    const speak = symbols.find((s) => s.name === "speak");
    expect(speak).not.toBeUndefined();
    expect(speak!.parent_name).toBe("Animal");
  });

  it("test_constant_extracted", () => {
    const [symbols] = rbExtracted;
    const names = new Set(symbols.filter((s) => s.kind === "const").map((s) => s.name));
    expect(names.has("KINGDOM")).toBe(true);
    expect(names.has("MAX_AGE")).toBe(true);
  });

  it("test_struct_new_extracted", () => {
    const [symbols] = rbExtracted;
    const pt = symbols.find((s) => s.name === "Point");
    expect(pt).not.toBeUndefined();
    expect(pt!.kind).toBe("type");
  });

  it("test_attr_reader_extracted", () => {
    const [symbols] = rbExtracted;
    const attrNames = new Set(symbols.filter((s) => s.kind === "var").map((s) => s.name));
    expect(attrNames.has("name")).toBe(true);
    expect(attrNames.has("age")).toBe(true);
  });

  it("test_attr_accessor_extracted", () => {
    const [symbols] = rbExtracted;
    const attrNames = new Set(symbols.filter((s) => s.kind === "var").map((s) => s.name));
    expect(attrNames.has("status")).toBe(true);
  });

  it("test_imports_extracted", () => {
    const [, , impExp] = rbExtracted;
    const targets = new Set(impExp.filter((ie) => ie.kind === "import").map((ie) => ie.target));
    expect(targets.has("json")).toBe(true);
    expect(targets.has("../lib/utils")).toBe(true);
  });

  it("test_line_numbers_one_indexed", () => {
    const [symbols] = rbExtracted;
    for (const s of symbols) {
      expect(s.line, `symbol ${JSON.stringify(s.name)} has line ${s.line}`).toBeGreaterThanOrEqual(1);
    }
  });

  it("test_no_single_char_refs", () => {
    const [, refs] = rbExtracted;
    for (const r of refs) {
      expect([...r.name].length).toBeGreaterThan(1);
    }
  });

  it("test_empty_file", () => {
    const result = extract(Buffer.from(""), "empty.rb") as Extracted;
    for (const lst of result) {
      expect(Array.isArray(lst)).toBe(true);
      expect(lst).toEqual([]);
    }
  });

  it("test_invalid_source", () => {
    const result = extract(Buffer.from([0xff, 0xfe, 0x20, 0x67, 0x61, 0x72, 0x62, 0x61, 0x67, 0x65]), "bad.rb") as Extracted;
    for (const lst of result) {
      expect(Array.isArray(lst)).toBe(true);
    }
  });
});
