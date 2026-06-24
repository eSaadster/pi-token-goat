/**
 * Tests for the Rust extractor (web-tree-sitter grammar adapter).
 *
 * Faithful 1:1 port of tests/test_parser_rust.py. Strict NodeNext ESM.
 *
 * Async shape: the Python suite imports a SYNC `extract`; the TS grammar adapter
 * exposes `getExtractor(): Promise<Extractor>` (web-tree-sitter must init and
 * load the rust wasm asynchronously). We resolve the extractor ONCE in
 * beforeAll, then every test calls the resulting SYNC extract(source, rel). The
 * fixtures are the SAME bytes the Python suite reads (shared
 * <root>/tests/fixtures/rust_sample/src/main.rs).
 */
import { describe, it, expect, beforeAll } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { getExtractor } from "../src/token_goat/languages/rust.js";
import type { Extractor, ImpExp, Ref, Section, Symbol } from "../src/token_goat/parser.js";

const _HERE = path.dirname(fileURLToPath(import.meta.url));
// <root>/ts/tests -> <root>/ts -> <root>; then into the shared Rust fixtures.
const _REPO_ROOT = path.resolve(_HERE, "..", "..");
const FIXTURE_DIR = path.join(_REPO_ROOT, "tests", "fixtures", "rust_sample");
const MAIN_RS = path.join(FIXTURE_DIR, "src", "main.rs");

// Resolved once (await getExtractor()), mirroring get_extractor's cache.
let extract: Extractor;

beforeAll(async () => {
  extract = await getExtractor();
});

/** Faithful analogue of the `rust_source` pytest fixture (reads bytes). */
function rust_source(): Buffer {
  return fs.readFileSync(MAIN_RS);
}

/** Faithful analogue of the `rust_extracted` pytest fixture. */
function rust_extracted(): [Symbol[], Ref[], ImpExp[], Section[]] {
  return extract(rust_source(), "src/main.rs");
}

describe("Rust extractor", () => {
  it("test_extract_returns_three_lists", () => {
    const [symbols, refs, imp_exp] = rust_extracted();
    expect(Array.isArray(symbols)).toBe(true);
    expect(Array.isArray(refs)).toBe(true);
    expect(Array.isArray(imp_exp)).toBe(true);
  });

  it("test_main_function_extracted", () => {
    const [symbols] = rust_extracted();
    const names = new Set(symbols.map((s) => s.name));
    expect(names.has("main")).toBe(true);
    const main = symbols.find((s) => s.name === "main")!;
    expect(main.kind).toBe("function");
  });

  it("test_server_struct_extracted", () => {
    const [symbols] = rust_extracted();
    const names = new Set(symbols.map((s) => s.name));
    expect(names.has("Server")).toBe(true);
    const server = symbols.find((s) => s.name === "Server" && s.kind === "type")!;
    expect(server.kind).toBe("type");
  });

  it("test_handler_trait_extracted", () => {
    const [symbols] = rust_extracted();
    const names = new Set(symbols.map((s) => s.name));
    expect(names.has("Handler")).toBe(true);
    const handler = symbols.find((s) => s.name === "Handler")!;
    expect(handler.kind).toBe("interface");
  });

  it("test_error_enum_extracted", () => {
    const [symbols] = rust_extracted();
    const names = new Set(symbols.map((s) => s.name));
    expect(names.has("Error")).toBe(true);
    const error = symbols.find((s) => s.name === "Error" && s.kind === "enum")!;
    expect(error.kind).toBe("enum");
  });

  it("test_new_method_extracted", () => {
    const [symbols] = rust_extracted();
    const names = new Set(symbols.map((s) => s.name));
    expect(names.has("new")).toBe(true);
    const newSym = symbols.find((s) => s.name === "new")!;
    expect(newSym.kind).toBe("method");
    expect(newSym.parent_name).toBe("Server");
  });

  it("test_run_method_extracted", () => {
    const [symbols] = rust_extracted();
    const names = new Set(symbols.map((s) => s.name));
    expect(names.has("run")).toBe(true);
    const run = symbols.find((s) => s.name === "run")!;
    expect(run.kind).toBe("method");
    expect(run.parent_name).toBe("Server");
  });

  it("test_version_const_extracted", () => {
    const [symbols] = rust_extracted();
    const names = new Set(symbols.map((s) => s.name));
    expect(names.has("VERSION")).toBe(true);
    const v = symbols.find((s) => s.name === "VERSION")!;
    expect(v.kind).toBe("const");
  });

  it("test_imports_include_hashmap", () => {
    const [, , imp_exp] = rust_extracted();
    const import_targets = new Set(
      imp_exp.filter((ie) => ie.kind === "import").map((ie) => ie.target),
    );
    expect([...import_targets].some((t) => t.includes("HashMap"))).toBe(true);
  });

  it("test_imports_include_fmt", () => {
    const [, , imp_exp] = rust_extracted();
    const import_targets = new Set(
      imp_exp.filter((ie) => ie.kind === "import").map((ie) => ie.target),
    );
    expect([...import_targets].some((t) => t.includes("fmt"))).toBe(true);
  });

  it("test_method_has_signature", () => {
    const [symbols] = rust_extracted();
    const newSym = symbols.find((s) => s.name === "new" && s.kind === "method")!;
    expect(newSym.signature).not.toBeNull();
    expect(newSym.signature!).toContain("fn new");
  });

  it("test_no_single_char_refs", () => {
    const [, refs] = rust_extracted();
    for (const r of refs) {
      expect(r.name.length).toBeGreaterThan(1);
    }
  });

  it("test_line_numbers_are_one_indexed", () => {
    const [symbols] = rust_extracted();
    for (const s of symbols) {
      expect(s.line).toBeGreaterThanOrEqual(1);
    }
  });

  it("test_impl_block_recorded", () => {
    // The impl Server block should produce an 'impl' symbol.
    const [symbols] = rust_extracted();
    const impl_syms = symbols.filter((s) => s.kind === "impl");
    expect(impl_syms.length).toBeGreaterThanOrEqual(1);
    expect(impl_syms.some((s) => s.name === "Server")).toBe(true);
  });

  it("test_trait_method_serve_extracted", () => {
    const [symbols] = rust_extracted();
    const serve = symbols.filter((s) => s.name === "serve");
    expect(serve.length).toBeGreaterThan(0);
    expect(serve[0]!.kind).toBe("method");
    expect(serve[0]!.parent_name).toBe("Handler");
  });

  it("test_trait_method_preflight_extracted", () => {
    const [symbols] = rust_extracted();
    const preflight = symbols.filter((s) => s.name === "preflight");
    expect(preflight.length).toBeGreaterThan(0);
    expect(preflight[0]!.kind).toBe("method");
    expect(preflight[0]!.parent_name).toBe("Handler");
  });

  it("test_static_extracted", () => {
    const [symbols] = rust_extracted();
    const statics = symbols.filter((s) => s.name === "MAX_CONNECTIONS");
    expect(statics.length).toBeGreaterThan(0);
    expect(statics[0]!.kind).toBe("const");
  });

  it("test_trait_methods_not_duplicated", () => {
    const [symbols] = rust_extracted();
    const serve_syms = symbols.filter((s) => s.name === "serve");
    expect(serve_syms.length).toBe(1);
  });

  it("test_invalid_source_returns_empty", () => {
    const result = extract(
      Buffer.from([0xff, 0xfe, 0x20, 0x67, 0x61, 0x72, 0x62, 0x61, 0x67, 0x65, 0x20, 0x00, 0x01]),
      "bad.rs",
    );
    for (const lst of result) {
      expect(Array.isArray(lst)).toBe(true);
    }
  });
});
