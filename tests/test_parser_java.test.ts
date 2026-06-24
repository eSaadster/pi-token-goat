/**
 * Tests for the Java extractor (web-tree-sitter grammar adapter).
 *
 * Faithful 1:1 port of tests/test_parser_java.py. Strict NodeNext ESM.
 *
 * Async shape: the Python suite imports a SYNC `extract`; the TS grammar adapter
 * exposes `getExtractor(): Promise<Extractor>` (web-tree-sitter must init and
 * load the java wasm asynchronously). We resolve the extractor ONCE in
 * beforeAll, then every test calls the resulting SYNC extract(source, rel) —
 * exactly how parser.ts's get_extractor caches it. The fixtures are the SAME
 * bytes the Python suite reads (shared <root>/tests/fixtures/java_sample/...),
 * resolved relative to this module so no fixture is duplicated.
 */
import { describe, it, expect, beforeAll } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { getExtractor } from "../src/token_goat/languages/java.js";
import type { Extractor, ImpExp, Ref, Section, Symbol } from "../src/token_goat/parser.js";

const _HERE = path.dirname(fileURLToPath(import.meta.url));
// <root>/ts/tests -> <root>/ts -> <root>; then into the shared Java fixtures.
const _REPO_ROOT = path.resolve(_HERE, "..", "..");
const FIXTURE_DIR = path.join(_REPO_ROOT, "tests", "fixtures", "java_sample");
const MAIN_JAVA = path.join(
  FIXTURE_DIR,
  "src",
  "main",
  "java",
  "com",
  "example",
  "UserService.java",
);

// Resolved once (await getExtractor()), mirroring get_extractor's cache.
let extract: Extractor;

beforeAll(async () => {
  extract = await getExtractor();
});

/** Faithful analogue of the `java_source` pytest fixture (reads bytes). */
function java_source(): Buffer {
  return fs.readFileSync(MAIN_JAVA);
}

/** Faithful analogue of the `java_extracted` pytest fixture. */
function java_extracted(): [Symbol[], Ref[], ImpExp[], Section[]] {
  return extract(java_source(), "src/main/java/com/example/UserService.java");
}

describe("Java extractor", () => {
  it("extract returns four lists", () => {
    const [symbols, refs, imp_exp, sections] = java_extracted();
    expect(Array.isArray(symbols)).toBe(true);
    expect(Array.isArray(refs)).toBe(true);
    expect(Array.isArray(imp_exp)).toBe(true);
    expect(Array.isArray(sections)).toBe(true);
  });

  it("class extracted", () => {
    const [symbols] = java_extracted();
    const names = new Set(symbols.map((s) => s.name));
    expect(names.has("UserService")).toBe(true);
    const cls = symbols.find((s) => s.name === "UserService" && s.kind === "class")!;
    expect(cls.kind).toBe("class");
  });

  it("interface extracted", () => {
    const [symbols] = java_extracted();
    const names = new Set(symbols.map((s) => s.name));
    expect(names.has("Processor")).toBe(true);
    const iface = symbols.find((s) => s.name === "Processor")!;
    expect(iface.kind).toBe("interface");
  });

  it("enum extracted", () => {
    const [symbols] = java_extracted();
    const status = symbols.find((s) => s.name === "Status") ?? null;
    expect(status).not.toBeNull();
    expect(status!.kind).toBe("enum");
  });

  it("abstract class extracted", () => {
    const [symbols] = java_extracted();
    const base = symbols.find((s) => s.name === "AbstractBase") ?? null;
    expect(base).not.toBeNull();
    expect(base!.kind).toBe("class");
  });

  it("constructor extracted", () => {
    const [symbols] = java_extracted();
    const ctors = symbols.filter((s) => s.name === "UserService" && s.kind === "method");
    expect(ctors.length).toBeGreaterThan(0);
    expect(ctors[0]!.parent_name).toBe("UserService");
  });

  it("method getName extracted", () => {
    const [symbols] = java_extracted();
    const m = symbols.find((s) => s.name === "getName") ?? null;
    expect(m).not.toBeNull();
    expect(m!.kind).toBe("method");
    expect(m!.parent_name).toBe("UserService");
  });

  it("static method extracted", () => {
    const [symbols] = java_extracted();
    const m = symbols.find((s) => s.name === "count") ?? null;
    expect(m).not.toBeNull();
    expect(m!.kind).toBe("method");
    expect(m!.parent_name).toBe("UserService");
  });

  it("interface method extracted", () => {
    const [symbols] = java_extracted();
    const m = symbols.find((s) => s.name === "process") ?? null;
    expect(m).not.toBeNull();
    expect(m!.kind).toBe("method");
    expect(m!.parent_name).toBe("Processor");
  });

  it("default interface method extracted", () => {
    const [symbols] = java_extracted();
    const m = symbols.find((s) => s.name === "preprocess") ?? null;
    expect(m).not.toBeNull();
    expect(m!.kind).toBe("method");
  });

  it("enum method extracted", () => {
    const [symbols] = java_extracted();
    const m = symbols.find((s) => s.name === "isActive") ?? null;
    expect(m).not.toBeNull();
    expect(m!.kind).toBe("method");
    expect(m!.parent_name).toBe("Status");
  });

  it("constant extracted", () => {
    const [symbols] = java_extracted();
    const v = symbols.find((s) => s.name === "VERSION") ?? null;
    expect(v).not.toBeNull();
    expect(v!.kind).toBe("const");
    expect(v!.parent_name).toBe("UserService");
  });

  it("private constant extracted", () => {
    const [symbols] = java_extracted();
    const m = symbols.find((s) => s.name === "MAX_SIZE") ?? null;
    expect(m).not.toBeNull();
    expect(m!.kind).toBe("const");
  });

  it("annotation type extracted", () => {
    const [symbols] = java_extracted();
    const ann = symbols.find((s) => s.name === "MyAnnotation") ?? null;
    expect(ann).not.toBeNull();
    expect(ann!.kind).toBe("interface");
  });

  it("imports extracted", () => {
    const [, , imp_exp] = java_extracted();
    const targets = new Set(
      imp_exp.filter((ie) => ie.kind === "import").map((ie) => ie.target),
    );
    expect(targets.has("java.util.List")).toBe(true);
    expect(targets.has("java.util.HashMap")).toBe(true);
  });

  it("line numbers are one-indexed", () => {
    const [symbols] = java_extracted();
    for (const s of symbols) {
      expect(s.line).toBeGreaterThanOrEqual(1);
    }
  });

  it("no single char refs", () => {
    const [, refs] = java_extracted();
    for (const r of refs) {
      expect(r.name.length).toBeGreaterThan(1);
    }
  });

  it("invalid source returns empty", () => {
    const result = extract(
      Buffer.from([0xff, 0xfe, 0x20, 0x67, 0x61, 0x72, 0x62, 0x61, 0x67, 0x65, 0x20, 0x00, 0x01]),
      "bad.java",
    );
    for (const lst of result) {
      expect(Array.isArray(lst)).toBe(true);
    }
  });

  it("empty file returns empty", () => {
    const result = extract(Buffer.from(""), "empty.java");
    for (const lst of result) {
      expect(Array.isArray(lst)).toBe(true);
      expect(lst).toEqual([]);
    }
  });
});
