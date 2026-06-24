/**
 * Tests for the Kotlin extractor.
 *
 * Faithful 1:1 port of tests/test_parser_kotlin.py. Strict NodeNext ESM.
 *
 * kotlin.py is regex-based (no tree-sitter) and the TS port exposes the same
 * pipeline through the async getExtractor() factory; the returned closure is
 * synchronous. The Python `extract` import maps here to that resolved closure
 * (awaited once in beforeAll).
 *
 * Fixtures are shared with the Python suite: from this module's directory
 *   <root>/ts/tests/
 * walk up two parents to the repo root, then into tests/fixtures/kotlin_sample.
 */
import { describe, it, expect, beforeAll } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { getExtractor } from "../src/token_goat/languages/kotlin.js";
import type { Extractor, ImpExp, Ref, Section, Symbol } from "../src/token_goat/parser.js";

const _HERE = path.dirname(fileURLToPath(import.meta.url));
const _REPO_ROOT = path.resolve(_HERE, "..", "..");
const FIXTURE_DIR = path.join(_REPO_ROOT, "tests", "fixtures", "kotlin_sample");
const MAIN_KT = path.join(
  FIXTURE_DIR,
  "src",
  "main",
  "kotlin",
  "com",
  "example",
  "UserService.kt",
);
const REL = "src/main/kotlin/com/example/UserService.kt";

type Extracted = [Symbol[], Ref[], ImpExp[], Section[]];

let extract: Extractor;

beforeAll(async () => {
  extract = await getExtractor();
});

function kotlin_extracted(): Extracted {
  return extract(fs.readFileSync(MAIN_KT), REL) as Extracted;
}

describe("Kotlin extractor", () => {
  it("extract returns four lists", () => {
    const [symbols, refs, imp_exp, sections] = kotlin_extracted();
    expect(Array.isArray(symbols)).toBe(true);
    expect(Array.isArray(refs)).toBe(true);
    expect(Array.isArray(imp_exp)).toBe(true);
    expect(Array.isArray(sections)).toBe(true);
  });

  it("class extracted", () => {
    const [symbols] = kotlin_extracted();
    const cls = symbols.find((s) => s.name === "UserService" && s.kind === "class");
    expect(cls).toBeDefined();
  });

  it("interface extracted", () => {
    const [symbols] = kotlin_extracted();
    const iface = symbols.find((s) => s.name === "Processor");
    expect(iface).toBeDefined();
    expect(iface!.kind).toBe("class");
  });

  it("enum class extracted", () => {
    const [symbols] = kotlin_extracted();
    const status = symbols.find((s) => s.name === "Status");
    expect(status).toBeDefined();
    expect(status!.kind).toBe("class");
  });

  it("object extracted", () => {
    const [symbols] = kotlin_extracted();
    const obj = symbols.find((s) => s.name === "Singleton");
    expect(obj).toBeDefined();
    expect(obj!.kind).toBe("class");
  });

  it("data class extracted", () => {
    const [symbols] = kotlin_extracted();
    const user = symbols.find((s) => s.name === "User");
    expect(user).toBeDefined();
    expect(user!.kind).toBe("class");
  });

  it("method extracted", () => {
    const [symbols] = kotlin_extracted();
    const m = symbols.find((s) => s.name === "getName");
    expect(m).toBeDefined();
    expect(m!.kind).toBe("method");
    expect(m!.parent_name).toBe("UserService");
  });

  it("private method extracted", () => {
    const [symbols] = kotlin_extracted();
    const m = symbols.find((s) => s.name === "count");
    expect(m).toBeDefined();
    expect(m!.kind).toBe("method");
    expect(m!.parent_name).toBe("UserService");
  });

  it("interface method extracted", () => {
    const [symbols] = kotlin_extracted();
    const m = symbols.find((s) => s.name === "process");
    expect(m).toBeDefined();
    expect(m!.kind).toBe("method");
    expect(m!.parent_name).toBe("Processor");
  });

  it("enum method extracted", () => {
    const [symbols] = kotlin_extracted();
    const m = symbols.find((s) => s.name === "isActive");
    expect(m).toBeDefined();
    expect(m!.kind).toBe("method");
    expect(m!.parent_name).toBe("Status");
  });

  it("companion const extracted", () => {
    const [symbols] = kotlin_extracted();
    const v = symbols.find((s) => s.name === "VERSION");
    expect(v).toBeDefined();
    expect(v!.kind).toBe("const");
    expect(v!.parent_name).toBe("UserService");
  });

  it("top-level function extracted", () => {
    const [symbols] = kotlin_extracted();
    const fn = symbols.find((s) => s.name === "topLevelFn");
    expect(fn).toBeDefined();
    expect(fn!.kind).toBe("function");
    expect(fn!.parent_name).toBeNull();
  });

  it("imports extracted", () => {
    const [, , imp_exp] = kotlin_extracted();
    const targets = new Set(imp_exp.filter((ie) => ie.kind === "import").map((ie) => ie.target));
    expect(targets.has("java.util.List")).toBe(true);
    expect(targets.has("java.util.HashMap")).toBe(true);
  });

  it("line numbers are one-indexed", () => {
    const [symbols] = kotlin_extracted();
    for (const s of symbols) {
      expect(s.line, `symbol ${JSON.stringify(s.name)} has zero-indexed line ${s.line}`).toBeGreaterThanOrEqual(1);
    }
  });

  it("no single-char refs", () => {
    const [, refs] = kotlin_extracted();
    for (const r of refs) {
      expect(r.name.length, `single-char ref ${JSON.stringify(r.name)} should be filtered`).toBeGreaterThan(1);
    }
  });

  it("invalid source returns empty", () => {
    const result = extract(
      Buffer.from([0xff, 0xfe, 0x20, 0x67, 0x61, 0x72, 0x62, 0x61, 0x67, 0x65, 0x20, 0x00, 0x01]),
      "bad.kt",
    ) as Extracted;
    for (const lst of result) {
      expect(Array.isArray(lst)).toBe(true);
    }
  });

  it("empty file returns empty", () => {
    const result = extract(Buffer.from(""), "empty.kt") as Extracted;
    for (const lst of result) {
      expect(Array.isArray(lst)).toBe(true);
      expect(lst).toEqual([]);
    }
  });
});
