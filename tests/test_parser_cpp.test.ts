/**
 * Tests for the C / C++ extractor.
 *
 * Faithful 1:1 port of tests/test_parser_cpp.py. Strict NodeNext ESM.
 *
 * cpp.py is regex-based and exports synchronous extract / extract_c; the TS port
 * re-exports those names directly, so (unlike the tree-sitter grammar adapters)
 * no async getExtractor handshake is needed here.
 *
 * Fixtures are shared with the Python suite: from this module's directory
 *   <root>/ts/tests/
 * walk up two parents to the repo root, then into tests/fixtures/cpp_sample.
 */
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { extract, extract_c } from "../src/token_goat/languages/cpp.js";
import type { ImpExp, Ref, Section, Symbol } from "../src/token_goat/parser.js";

const _HERE = path.dirname(fileURLToPath(import.meta.url));
const _REPO_ROOT = path.resolve(_HERE, "..", "..");
const CPP_FIXTURE = path.join(_REPO_ROOT, "tests", "fixtures", "cpp_sample", "sample.cpp");
const C_FIXTURE = path.join(_REPO_ROOT, "tests", "fixtures", "cpp_sample", "sample.c");

type Extracted = [Symbol[], Ref[], ImpExp[], Section[]];

function cpp_extracted(): Extracted {
  return extract(fs.readFileSync(CPP_FIXTURE), "sample.cpp");
}

function c_extracted(): Extracted {
  return extract_c(fs.readFileSync(C_FIXTURE), "sample.c");
}

// --- C++ tests ---

describe("C++ extractor", () => {
  it("returns four lists", () => {
    for (const lst of cpp_extracted()) {
      expect(Array.isArray(lst)).toBe(true);
    }
  });

  it("macro uppercase extracted", () => {
    const [symbols] = cpp_extracted();
    const names = new Set(symbols.filter((s) => s.kind === "const").map((s) => s.name));
    expect(names.has("MAX_SIZE")).toBe(true);
    expect(names.has("MIN_VAL")).toBe(true);
  });

  it("macro lowercase excluded", () => {
    const [symbols] = cpp_extracted();
    const names = new Set(symbols.map((s) => s.name));
    expect(names.has("debug_log")).toBe(false);
  });

  it("struct extracted", () => {
    const [symbols] = cpp_extracted();
    const st = symbols.find((s) => s.name === "Point" && s.kind === "type");
    expect(st).toBeDefined();
  });

  it("enum extracted", () => {
    const [symbols] = cpp_extracted();
    const en = symbols.find((s) => s.name === "Color");
    expect(en).toBeDefined();
    expect(en!.kind).toBe("type");
  });

  it("function extracted", () => {
    const [symbols] = cpp_extracted();
    const fn = symbols.find((s) => s.name === "add" && s.kind === "function");
    expect(fn).toBeDefined();
  });

  it("static function extracted", () => {
    const [symbols] = cpp_extracted();
    const fn = symbols.find((s) => s.name === "helper" && s.kind === "function");
    expect(fn).toBeDefined();
  });

  it("class extracted", () => {
    const [symbols] = cpp_extracted();
    const cls = symbols.find((s) => s.name === "Calculator");
    expect(cls).toBeDefined();
    expect(["class", "type"]).toContain(cls!.kind);
  });

  it("namespace extracted", () => {
    const [symbols] = cpp_extracted();
    const ns = symbols.find((s) => s.name === "MyNS");
    expect(ns).toBeDefined();
  });

  it("out-of-class method", () => {
    const [symbols] = cpp_extracted();
    const mth = symbols.find((s) => s.name === "multiply" && s.kind === "method");
    expect(mth).toBeDefined();
    expect(mth!.parent_name).toBe("Calculator");
  });

  it("extern extracted", () => {
    const [symbols] = cpp_extracted();
    const ext = symbols.find((s) => s.name === "external_api");
    expect(ext).toBeDefined();
    expect(ext!.kind).toBe("function");
  });

  it("includes extracted", () => {
    const [, , imp_exp] = cpp_extracted();
    const targets = new Set(imp_exp.filter((ie) => ie.kind === "import").map((ie) => ie.target));
    expect(targets.has("stdio.h")).toBe(true);
    expect(targets.has("vector")).toBe(true);
  });

  it("line numbers are one-indexed", () => {
    const [symbols] = cpp_extracted();
    for (const s of symbols) {
      expect(s.line, `symbol ${JSON.stringify(s.name)} has line ${s.line}`).toBeGreaterThanOrEqual(1);
    }
  });

  it("no single-char refs", () => {
    const [, refs] = cpp_extracted();
    for (const r of refs) {
      expect(r.name.length).toBeGreaterThan(1);
    }
  });
});

// --- C tests ---

describe("C extractor", () => {
  it("returns four lists", () => {
    for (const lst of c_extracted()) {
      expect(Array.isArray(lst)).toBe(true);
    }
  });

  it("macro extracted", () => {
    const [symbols] = c_extracted();
    const names = new Set(symbols.filter((s) => s.kind === "const").map((s) => s.name));
    expect(names.has("BUFFER_SIZE")).toBe(true);
    expect(names.has("MAX_RETRIES")).toBe(true);
  });

  it("typedef struct extracted", () => {
    const [symbols] = c_extracted();
    const st = symbols.find((s) => s.name === "Vector2");
    expect(st).toBeDefined();
    expect(st!.kind).toBe("type");
  });

  it("struct extracted", () => {
    const [symbols] = c_extracted();
    const st = symbols.find((s) => s.name === "Queue");
    expect(st).toBeDefined();
  });

  it("enum extracted", () => {
    const [symbols] = c_extracted();
    const en = symbols.find((s) => s.name === "Direction");
    expect(en).toBeDefined();
    expect(en!.kind).toBe("type");
  });

  it("function extracted", () => {
    const [symbols] = c_extracted();
    const names = new Set(symbols.filter((s) => s.kind === "function").map((s) => s.name));
    expect(names.has("add")).toBe(true);
    expect(names.has("process")).toBe(true);
  });

  it("static function extracted", () => {
    const [symbols] = c_extracted();
    const fn = symbols.find((s) => s.name === "compare");
    expect(fn).toBeDefined();
  });

  it("extern extracted", () => {
    const [symbols] = c_extracted();
    const ext = symbols.find((s) => s.name === "platform_init");
    expect(ext).toBeDefined();
  });

  it("includes extracted", () => {
    const [, , imp_exp] = c_extracted();
    const targets = new Set(imp_exp.map((ie) => ie.target));
    expect(targets.has("stdio.h")).toBe(true);
    expect(targets.has("stdlib.h")).toBe(true);
  });

  it("no class extracted", () => {
    const [symbols] = c_extracted();
    const classes = symbols.filter((s) => s.kind === "class");
    expect(classes.length).toBe(0);
  });

  it("no namespace extracted", () => {
    const [symbols] = c_extracted();
    const ns = symbols.filter((s) => s.name === "namespace");
    expect(ns.length).toBe(0);
  });
});

describe("C/C++ edge cases", () => {
  it("empty file cpp", () => {
    const result = extract(Buffer.from(""), "empty.cpp");
    for (const lst of result) {
      expect(Array.isArray(lst)).toBe(true);
      expect(lst).toEqual([]);
    }
  });

  it("empty file c", () => {
    const result = extract_c(Buffer.from(""), "empty.c");
    for (const lst of result) {
      expect(Array.isArray(lst)).toBe(true);
      expect(lst).toEqual([]);
    }
  });

  it("invalid source cpp", () => {
    const result = extract(Buffer.from([0xff, 0xfe, 0x20, 0x67, 0x61, 0x72, 0x62, 0x61, 0x67, 0x65]), "bad.cpp");
    for (const lst of result) {
      expect(Array.isArray(lst)).toBe(true);
    }
  });
});
