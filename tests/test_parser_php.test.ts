/**
 * Tests for the PHP symbol extractor (web-tree-sitter grammar adapter).
 *
 * There is no tests/test_parser_php.py in the Python suite to port 1:1; this
 * file is the TS-native analogue, modelled on tests/test_parser_ruby.py and
 * locking in the documented php.py / php.ts hybrid behaviour:
 *
 *   PASS 1 (engine structure walk): class_declaration -> class,
 *   interface_declaration -> interface, enum_declaration -> enum,
 *   method_declaration -> method (parent = enclosing class/interface/enum),
 *   function_definition -> function. trait_declaration / namespace_definition
 *   are TRANSPARENT containers (descended through; their children inherit the
 *   enclosing parent, not the trait/namespace name).
 *
 *   PASS 2 (regex post-pass): namespace -> "namespace" symbol; use / require /
 *   include -> import rows; trait -> "trait" symbol; class const -> "const" with
 *   the enclosing class as parent; global const / define() -> "const"; typed
 *   visibility property -> "var" with the enclosing class as parent. Anonymous /
 *   arrow functions are skipped.
 *
 * The fixture (tests/fixtures/php_sample/shapes.php) exercises every one of
 * these constructs. As with the grammar adapters generally, the module exposes
 * `getExtractor()` (async, resolves the web-tree-sitter parser once) returning a
 * SYNC extract closure; the suite resolves it once in beforeAll.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { beforeAll, describe, expect, it } from "vitest";

import type { Extractor, ImpExp, Ref, Section, Symbol } from "../src/token_goat/parser.js";
import { getExtractor } from "../src/token_goat/languages/php.js";

type Extracted = [Symbol[], Ref[], ImpExp[], Section[]];

const FIXTURE = fileURLToPath(
  new URL("./fixtures/php_sample/shapes.php", import.meta.url),
);

let extract: Extractor;
let phpSource: Buffer;
let phpExtracted: Extracted;

beforeAll(async () => {
  extract = await getExtractor();
  phpSource = readFileSync(FIXTURE);
  phpExtracted = extract(phpSource, "shapes.php") as Extracted;
});

describe("test_parser_php (PHP grammar adapter)", () => {
  it("test_returns_four_lists", () => {
    for (const lst of phpExtracted) {
      expect(Array.isArray(lst)).toBe(true);
    }
  });

  it("test_namespace_extracted", () => {
    const [symbols] = phpExtracted;
    const ns = symbols.find((s) => s.name === "App\\Models");
    expect(ns).not.toBeUndefined();
    expect(ns!.kind).toBe("namespace");
  });

  it("test_interface_extracted", () => {
    const [symbols] = phpExtracted;
    const iface = symbols.find((s) => s.name === "Shape" && s.kind === "interface");
    expect(iface).not.toBeUndefined();
  });

  it("test_class_extracted", () => {
    const [symbols] = phpExtracted;
    const cls = symbols.find((s) => s.name === "Base" && s.kind === "class");
    expect(cls).not.toBeUndefined();
  });

  it("test_enum_extracted", () => {
    const [symbols] = phpExtracted;
    const en = symbols.find((s) => s.name === "Suit" && s.kind === "enum");
    expect(en).not.toBeUndefined();
  });

  it("test_trait_extracted", () => {
    const [symbols] = phpExtracted;
    const tr = symbols.find((s) => s.name === "Greetable" && s.kind === "trait");
    expect(tr).not.toBeUndefined();
  });

  it("test_method_extracted_with_parent", () => {
    const [symbols] = phpExtracted;
    const ctor = symbols.find((s) => s.name === "__construct" && s.kind === "method");
    expect(ctor).not.toBeUndefined();
    expect(ctor!.parent_name).toBe("Base");
    const helper = symbols.find((s) => s.name === "helper" && s.kind === "method");
    expect(helper).not.toBeUndefined();
    expect(helper!.parent_name).toBe("Base");
  });

  it("test_interface_method_extracted", () => {
    const [symbols] = phpExtracted;
    const area = symbols.find((s) => s.name === "area" && s.parent_name === "Shape");
    expect(area).not.toBeUndefined();
    expect(area!.kind).toBe("method");
  });

  it("test_top_level_function_extracted", () => {
    const [symbols] = phpExtracted;
    const fn = symbols.find((s) => s.name === "topLevel");
    expect(fn).not.toBeUndefined();
    expect(fn!.kind).toBe("function");
    expect(fn!.parent_name).toBeNull();
  });

  it("test_global_const_extracted", () => {
    const [symbols] = phpExtracted;
    const names = new Set(
      symbols.filter((s) => s.kind === "const" && s.parent_name === null).map((s) => s.name),
    );
    // define('VERSION', ...) and a top-level `const GLOBAL_C = 5;`.
    expect(names.has("VERSION")).toBe(true);
    expect(names.has("GLOBAL_C")).toBe(true);
  });

  it("test_class_const_extracted", () => {
    const [symbols] = phpExtracted;
    const max = symbols.find((s) => s.name === "MAX" && s.kind === "const");
    expect(max).not.toBeUndefined();
    expect(max!.parent_name).toBe("Base");
  });

  it("test_property_extracted", () => {
    const [symbols] = phpExtracted;
    const prop = symbols.find((s) => s.name === "count" && s.kind === "var");
    expect(prop).not.toBeUndefined();
    expect(prop!.parent_name).toBe("Base");
  });

  it("test_anonymous_functions_skipped", () => {
    const [symbols] = phpExtracted;
    // `$fn = function($x) {...}` and `$arrow = fn($x) => ...` must not surface
    // a named function/method symbol.
    const names = new Set(symbols.map((s) => s.name));
    expect(names.has("fn")).toBe(false);
    expect(names.has("function")).toBe(false);
  });

  it("test_imports_extracted", () => {
    const [, , impExp] = phpExtracted;
    const targets = new Set(impExp.filter((ie) => ie.kind === "import").map((ie) => ie.target));
    // `use App\Contracts\Repository;` keeps the full namespace target.
    expect(targets.has("App\\Contracts\\Repository")).toBe(true);
    // `use App\Support\Str as S;` records the source path, not the alias.
    expect(targets.has("App\\Support\\Str")).toBe(true);
    // `require_once 'bootstrap.php';`
    expect(targets.has("bootstrap.php")).toBe(true);
  });

  it("test_engine_emits_no_imports_regex_does", () => {
    const [, , impExp] = phpExtracted;
    // PHP imports come entirely from the regex pass; every row is kind "import".
    for (const ie of impExp) {
      expect(ie.kind).toBe("import");
    }
    expect(impExp.length).toBeGreaterThanOrEqual(3);
  });

  it("test_line_numbers_one_indexed", () => {
    const [symbols] = phpExtracted;
    for (const s of symbols) {
      expect(s.line, `symbol ${JSON.stringify(s.name)} has line ${s.line}`).toBeGreaterThanOrEqual(1);
    }
  });

  it("test_no_single_char_refs", () => {
    const [, refs] = phpExtracted;
    for (const r of refs) {
      expect([...r.name].length).toBeGreaterThan(1);
    }
  });

  it("test_call_refs_extracted", () => {
    const [, refs] = phpExtracted;
    const names = new Set(refs.map((r) => r.name));
    // Plain call sites that survive the _CALL_NOISE filter.
    expect(names.has("compute")).toBe(true);
    expect(names.has("process")).toBe(true);
    expect(names.has("greeting")).toBe(true);
  });

  it("test_empty_file", () => {
    const result = extract(Buffer.from(""), "empty.php") as Extracted;
    for (const lst of result) {
      expect(Array.isArray(lst)).toBe(true);
      expect(lst).toEqual([]);
    }
  });

  it("test_invalid_source", () => {
    const result = extract(
      Buffer.from([0xff, 0xfe, 0x20, 0x67, 0x61, 0x72, 0x62, 0x61, 0x67, 0x65]),
      "bad.php",
    ) as Extracted;
    for (const lst of result) {
      expect(Array.isArray(lst)).toBe(true);
    }
  });
});
