/**
 * Tests for the Go extractor (web-tree-sitter grammar adapter).
 *
 * Faithful 1:1 port of tests/test_parser_go.py. Strict NodeNext ESM.
 *
 * Async shape: the Python suite imports a SYNC `extract`; the TS grammar adapter
 * exposes `getExtractor(): Promise<Extractor>` (web-tree-sitter must init and
 * load the go wasm asynchronously). We resolve the extractor ONCE in beforeAll,
 * then every test calls the resulting SYNC extract(source, rel) — exactly how
 * parser.ts's get_extractor caches it. The fixtures are the SAME bytes the
 * Python suite reads (shared <root>/tests/fixtures/go_sample/main.go), resolved
 * relative to this module so no fixture is duplicated.
 */
import { describe, it, expect, beforeAll } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { getExtractor } from "../src/token_goat/languages/go.js";
import type { Extractor, ImpExp, Ref, Section, Symbol } from "../src/token_goat/parser.js";

const _HERE = path.dirname(fileURLToPath(import.meta.url));
// <root>/ts/tests -> <root>/ts -> <root>; then into the shared Go fixtures.
const _REPO_ROOT = path.resolve(_HERE, "..", "..");
const FIXTURE_DIR = path.join(_REPO_ROOT, "tests", "fixtures", "go_sample");
const MAIN_GO = path.join(FIXTURE_DIR, "main.go");

// Resolved once (await getExtractor()), mirroring get_extractor's cache.
let extract: Extractor;

beforeAll(async () => {
  extract = await getExtractor();
});

/** Faithful analogue of the `go_source` pytest fixture (reads bytes). */
function go_source(): Buffer {
  return fs.readFileSync(MAIN_GO);
}

/** Faithful analogue of the `go_extracted` pytest fixture. */
function go_extracted(): [Symbol[], Ref[], ImpExp[], Section[]] {
  return extract(go_source(), "main.go");
}

describe("Go extractor", () => {
  it("test_extract_returns_three_lists", () => {
    const [symbols, refs, imp_exp] = go_extracted();
    expect(Array.isArray(symbols)).toBe(true);
    expect(Array.isArray(refs)).toBe(true);
    expect(Array.isArray(imp_exp)).toBe(true);
  });

  it("test_main_function_extracted", () => {
    const [symbols] = go_extracted();
    const names = new Set(symbols.map((s) => s.name));
    expect(names.has("main")).toBe(true);
    const main = symbols.find((s) => s.name === "main")!;
    expect(main.kind).toBe("function");
  });

  it("test_newserver_function_extracted", () => {
    const [symbols] = go_extracted();
    const names = new Set(symbols.map((s) => s.name));
    expect(names.has("NewServer")).toBe(true);
    const ns = symbols.find((s) => s.name === "NewServer")!;
    expect(ns.kind).toBe("function");
  });

  it("test_run_method_extracted", () => {
    const [symbols] = go_extracted();
    const names = new Set(symbols.map((s) => s.name));
    expect(names.has("Run")).toBe(true);
    const run = symbols.find((s) => s.name === "Run")!;
    expect(run.kind).toBe("method");
  });

  it("test_server_struct_extracted", () => {
    const [symbols] = go_extracted();
    const names = new Set(symbols.map((s) => s.name));
    expect(names.has("Server")).toBe(true);
    const server = symbols.find((s) => s.name === "Server")!;
    expect(server.kind).toBe("type");
  });

  it("test_handler_interface_extracted", () => {
    const [symbols] = go_extracted();
    const names = new Set(symbols.map((s) => s.name));
    expect(names.has("Handler")).toBe(true);
    const handler = symbols.find((s) => s.name === "Handler")!;
    expect(handler.kind).toBe("interface");
  });

  it("test_version_const_extracted", () => {
    const [symbols] = go_extracted();
    const names = new Set(symbols.map((s) => s.name));
    expect(names.has("Version")).toBe(true);
    const version = symbols.find((s) => s.name === "Version")!;
    expect(version.kind).toBe("const");
  });

  it("test_defaultport_var_extracted", () => {
    const [symbols] = go_extracted();
    const names = new Set(symbols.map((s) => s.name));
    expect(names.has("defaultPort")).toBe(true);
    const dp = symbols.find((s) => s.name === "defaultPort")!;
    expect(dp.kind).toBe("var");
  });

  it("test_imports_include_fmt", () => {
    const [, , imp_exp] = go_extracted();
    const import_targets = new Set(
      imp_exp.filter((ie) => ie.kind === "import").map((ie) => ie.target),
    );
    expect(import_targets.has("fmt")).toBe(true);
  });

  it("test_imports_include_errors", () => {
    const [, , imp_exp] = go_extracted();
    const import_targets = new Set(
      imp_exp.filter((ie) => ie.kind === "import").map((ie) => ie.target),
    );
    expect(import_targets.has("errors")).toBe(true);
  });

  it("test_refs_include_newserver_call", () => {
    const [, refs] = go_extracted();
    const ref_names = new Set(refs.map((r) => r.name));
    expect(ref_names.has("NewServer")).toBe(true);
  });

  it("test_ref_has_line_and_context", () => {
    const [, refs] = go_extracted();
    const ns_refs = refs.filter((r) => r.name === "NewServer");
    expect(ns_refs.length).toBeGreaterThan(0);
    for (const r of ns_refs) {
      expect(r.line).toBeGreaterThan(0);
      expect(r.context).not.toBeNull();
    }
  });

  it("test_function_has_signature", () => {
    const [symbols] = go_extracted();
    const ns = symbols.find((s) => s.name === "NewServer")!;
    expect(ns.signature).not.toBeNull();
    expect(ns.signature!).toContain("NewServer");
  });

  it("test_method_has_signature", () => {
    const [symbols] = go_extracted();
    const run = symbols.find((s) => s.name === "Run")!;
    expect(run.signature).not.toBeNull();
    expect(run.signature!).toContain("Run");
  });

  it("test_no_single_char_refs", () => {
    const [, refs] = go_extracted();
    for (const r of refs) {
      expect(r.name.length).toBeGreaterThan(1);
    }
  });

  it("test_line_numbers_are_one_indexed", () => {
    const [symbols] = go_extracted();
    for (const s of symbols) {
      expect(s.line).toBeGreaterThanOrEqual(1);
    }
  });

  it("test_invalid_source_returns_empty", () => {
    const result = extract(
      Buffer.from([0xff, 0xfe, 0x20, 0x67, 0x61, 0x72, 0x62, 0x61, 0x67, 0x65, 0x20, 0x00, 0x01]),
      "bad.go",
    );
    for (const lst of result) {
      expect(Array.isArray(lst)).toBe(true);
    }
  });

  it("test_const_block_extraction", () => {
    // Multiple names in a const () block should each be a separate symbol.
    const src = Buffer.from(
      "package main\n\nconst (\n    MaxConn = 10\n    Debug = false\n    AppName = \"myapp\"\n)\n",
    );
    const [symbols] = extract(src, "consts.go");
    const names = new Set(symbols.filter((s) => s.kind === "const").map((s) => s.name));
    expect(names.has("MaxConn")).toBe(true);
    expect(names.has("Debug")).toBe(true);
    expect(names.has("AppName")).toBe(true);
  });

  it("test_interface_method_extracted", () => {
    // Methods inside a Go interface should be emitted as individual method symbols.
    const src = Buffer.from(
      "package io\n\ntype Reader interface {\n    Read(p []byte) (n int, err error)\n}\n",
    );
    const [symbols] = extract(src, "reader.go");
    const names = new Set(symbols.map((s) => s.name));
    expect(names.has("Read")).toBe(true);
    const read = symbols.find((s) => s.name === "Read")!;
    expect(read.kind).toBe("method");
    expect(read.parent_name).toBe("Reader");
  });

  it("test_interface_method_parent_name_set", () => {
    // Interface method symbols carry the enclosing interface name as parent_name.
    const src = Buffer.from(
      "package net\n\ntype Conn interface {\n    Read(b []byte) (n int, err error)\n    Write(b []byte) (n int, err error)\n    Close() error\n}\n",
    );
    const [symbols] = extract(src, "conn.go");
    const method_syms = new Map(
      symbols.filter((s) => s.kind === "method").map((s) => [s.name, s]),
    );
    expect(method_syms.has("Read")).toBe(true);
    expect(method_syms.has("Write")).toBe(true);
    expect(method_syms.has("Close")).toBe(true);
    expect(method_syms.get("Read")!.parent_name).toBe("Conn");
    expect(method_syms.get("Write")!.parent_name).toBe("Conn");
    expect(method_syms.get("Close")!.parent_name).toBe("Conn");
  });

  it("test_receiver_method_parent_name_set", () => {
    // Receiver methods should have parent_name set to the receiver type.
    const src = Buffer.from(
      "package main\n\ntype Server struct {\n    Port int\n}\n\nfunc (s *Server) Run() error {\n    return nil\n}\n",
    );
    const [symbols] = extract(src, "server.go");
    const run = symbols.find((s) => s.name === "Run") ?? null;
    expect(run).not.toBeNull();
    expect(run!.kind).toBe("method");
    expect(run!.parent_name).toBe("Server");
  });

  it("test_interface_method_line_numbers", () => {
    // Interface method symbols should have accurate 1-indexed line numbers.
    const src = Buffer.from(
      "package io\n\ntype Writer interface {\n    Write(p []byte) (n int, err error)\n}\n",
    );
    const [symbols] = extract(src, "writer.go");
    const write = symbols.find((s) => s.name === "Write") ?? null;
    expect(write).not.toBeNull();
    expect(write!.line).toBe(4);
  });

  it("test_embedded_interface_not_extracted_as_method", () => {
    // Embedded interface names inside an interface body are not emitted as methods.
    const src = Buffer.from(
      "package io\n\ntype Reader interface {\n    Read(p []byte) (n int, err error)\n}\n\ntype ReadWriter interface {\n    Reader\n    Write(p []byte) (n int, err error)\n}\n",
    );
    const [symbols] = extract(src, "rw.go");
    const method_names = new Set(
      symbols
        .filter((s) => s.kind === "method" && s.parent_name === "ReadWriter")
        .map((s) => s.name),
    );
    expect(method_names.has("Write")).toBe(true);
    expect(method_names.has("Reader")).toBe(false);
  });

  it("test_handler_interface_method_in_fixture", () => {
    // The fixture's Handler.Serve method should be extracted as a symbol.
    const [symbols] = go_extracted();
    const serve = symbols.find((s) => s.name === "Serve") ?? null;
    expect(serve).not.toBeNull();
    expect(serve!.kind).toBe("method");
    expect(serve!.parent_name).toBe("Handler");
  });

  it("test_run_method_has_receiver_parent", () => {
    // The fixture's Server.Run receiver method should have parent_name='Server'.
    const [symbols] = go_extracted();
    const run = symbols.find((s) => s.name === "Run")!;
    expect(run.parent_name).toBe("Server");
  });
});
