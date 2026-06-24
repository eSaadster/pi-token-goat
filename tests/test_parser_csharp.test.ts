/**
 * Tests for the C# extractor.
 *
 * Faithful 1:1 port of tests/test_parser_csharp.py. Strict NodeNext ESM.
 *
 * csharp.py is a tree-sitter grammar adapter; the TS port exposes the async
 * getExtractor() factory (Parser.init + c_sharp grammar load) which resolves to
 * a synchronous extract(source, rel) closure. The Python `extract` import maps
 * here to that resolved closure (awaited once in beforeAll), reproducing the
 * sync per-file contract the pytest fixtures rely on.
 *
 * Fixtures are shared with the Python suite: from this module's directory
 *   <root>/ts/tests/
 * walk up two parents to the repo root, then into tests/fixtures/csharp_sample.
 */
import { describe, it, expect, beforeAll } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { getExtractor } from "../src/token_goat/languages/csharp.js";
import type { Extractor, ImpExp, Ref, Section, Symbol } from "../src/token_goat/parser.js";

const _HERE = path.dirname(fileURLToPath(import.meta.url));
const _REPO_ROOT = path.resolve(_HERE, "..", "..");
const FIXTURE = path.join(_REPO_ROOT, "tests", "fixtures", "csharp_sample", "UserService.cs");

type Extracted = [Symbol[], Ref[], ImpExp[], Section[]];

let extract: Extractor;

beforeAll(async () => {
  extract = await getExtractor();
});

function cs_extracted(): Extracted {
  return extract(fs.readFileSync(FIXTURE), "UserService.cs") as Extracted;
}

describe("C# extractor", () => {
  it("returns four lists", () => {
    for (const lst of cs_extracted()) {
      expect(Array.isArray(lst)).toBe(true);
    }
  });

  it("interface extracted", () => {
    const [symbols] = cs_extracted();
    const iface = symbols.find((s) => s.name === "IUserService");
    expect(iface).toBeDefined();
    expect(iface!.kind).toBe("interface");
  });

  it("class extracted", () => {
    const [symbols] = cs_extracted();
    const cls = symbols.find((s) => s.name === "UserService" && s.kind === "class");
    expect(cls).toBeDefined();
  });

  it("struct extracted", () => {
    const [symbols] = cs_extracted();
    const st = symbols.find((s) => s.name === "Point");
    expect(st).toBeDefined();
    expect(["type", "class"]).toContain(st!.kind);
  });

  it("abstract class extracted", () => {
    const [symbols] = cs_extracted();
    const ab = symbols.find((s) => s.name === "AbstractBase");
    expect(ab).toBeDefined();
    expect(ab!.kind).toBe("class");
  });

  it("enum extracted", () => {
    const [symbols] = cs_extracted();
    const en = symbols.find((s) => s.name === "Status");
    expect(en).toBeDefined();
    expect(en!.kind).toBe("enum");
  });

  it("interface methods extracted", () => {
    const [symbols] = cs_extracted();
    const names = new Set(symbols.filter((s) => s.kind === "method").map((s) => s.name));
    expect(names.has("GetUser")).toBe(true);
    expect(names.has("DeleteUser")).toBe(true);
  });

  it("constructor extracted", () => {
    const [symbols] = cs_extracted();
    const ctors = symbols.filter((s) => s.name === "UserService" && s.kind === "method");
    expect(ctors.length, "constructor should be extracted as a method").toBeGreaterThan(0);
    expect(ctors[0]!.parent_name).toBe("UserService");
  });

  it("property extracted", () => {
    const [symbols] = cs_extracted();
    const prop = symbols.find((s) => s.name === "ServiceName");
    expect(prop).toBeDefined();
    expect(prop!.kind).toBe("var");
    expect(prop!.parent_name).toBe("UserService");
  });

  it("delegate extracted", () => {
    const [symbols] = cs_extracted();
    const d = symbols.find((s) => s.name === "UserChangedHandler");
    expect(d).toBeDefined();
    expect(d!.kind).toBe("interface");
  });

  it("namespace extracted", () => {
    const [symbols] = cs_extracted();
    const ns = symbols.find((s) => s.name === "MyApp.Services");
    expect(ns).toBeDefined();
  });

  it("imports extracted", () => {
    const [, , imp_exp] = cs_extracted();
    const targets = new Set(imp_exp.filter((ie) => ie.kind === "import").map((ie) => ie.target));
    expect(targets.has("System")).toBe(true);
    expect(targets.has("System.Collections.Generic")).toBe(true);
    expect(targets.has("System.Threading.Tasks")).toBe(true);
  });

  it("line numbers one-indexed", () => {
    const [symbols] = cs_extracted();
    for (const s of symbols) {
      expect(s.line, `symbol ${JSON.stringify(s.name)} has zero-indexed line ${s.line}`).toBeGreaterThanOrEqual(1);
    }
  });

  it("no single-char refs", () => {
    const [, refs] = cs_extracted();
    for (const r of refs) {
      expect(r.name.length, `single-char ref ${JSON.stringify(r.name)} should be filtered`).toBeGreaterThan(1);
    }
  });

  it("empty file returns empty", () => {
    const result = extract(Buffer.from(""), "empty.cs") as Extracted;
    for (const lst of result) {
      expect(Array.isArray(lst)).toBe(true);
      expect(lst).toEqual([]);
    }
  });

  it("invalid source returns empty", () => {
    const result = extract(
      Buffer.from([0xff, 0xfe, 0x20, 0x67, 0x61, 0x72, 0x62, 0x61, 0x67, 0x65]),
      "bad.cs",
    ) as Extracted;
    for (const lst of result) {
      expect(Array.isArray(lst)).toBe(true);
    }
  });
});
