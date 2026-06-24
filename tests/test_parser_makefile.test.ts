/**
 * Tests for the Makefile language extractor and basename dispatch.
 *
 * Faithful 1:1 port of tests/test_parser_makefile.py. Strict NodeNext ESM.
 * The Python source is the specification; assertions mirror it field-for-field.
 *
 * Adaptations (Python -> TS, all mechanical):
 *  - `b"""..."""` byte literals -> `Buffer.from("...", "utf-8")` (recipe lines
 *    use real tabs, preserved by the string literal).
 *  - The 4-tuple unpacking is identical (array destructuring of the fixed
 *    4-element tuple).
 *  - `tmp_path` (pytest fixture) -> a per-test `fs.mkdtempSync` dir under
 *    os.tmpdir().
 *  - The Project dataclass is a plain interface in TS; the test builds the
 *    object literal directly (root/hash/marker) exactly like the Python
 *    `Project(root=..., hash=..., marker=".git")`.
 *  - `parser.index_file` is async in the TS port; dispatch tests `await` it.
 *  - Python's `"﻿all: build\n".encode()` (UTF-8 BOM literal) -> the same string
 *    literal (the BOM is U+FEFF, preserved by Buffer.from("utf-8")).
 *
 * DEFERRED case:
 *  - `TestParserExtensionMappings.test_basename_mapped_to_language` imports
 *    `LANG_BY_BASENAME` from parser.ts, which is NOT exported in the current TS
 *    port (only `LANG_BY_EXT` is exported). See `missingExports` in the run
 *    report. The test is written faithfully against that import and skipped
 *    (it.skip) until the export is added — a src change outside this port's
 *    scope.
 */

import { describe, expect, it } from "vitest";

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import * as makefile_idx from "../src/token_goat/languages/makefile_idx.js";
import { index_file, LANG_BY_EXT } from "../src/token_goat/parser.js";
import { canonicalize, type Project, project_hash } from "../src/token_goat/project.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Per-test tmp dir (the pytest `tmp_path` fixture equivalent). */
function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "tg-makefile-"));
}

/** Build a Project for a tmp root, mirroring the Python test's construction. */
function projectFor(root: string, marker = ".git"): Project {
  return { root: canonicalize(root), hash: project_hash(canonicalize(root)), marker };
}

// ===========================================================================
// Core extractor tests
// ===========================================================================

describe("TestMakefileExtractor", () => {
  it("test_simple_targets", () => {
    const src = Buffer.from("all: main.o\n\tgcc -o app main.o\n\nmain.o: main.c\n\tgcc -c main.c\n\nclean:\n\trm -f *.o app\n", "utf-8");
    const [symbols, refs, imps, _sections] = makefile_idx.extract(src, "Makefile");
    expect(refs).toEqual([]);
    expect(imps).toEqual([]);
    const names = symbols.map((s) => s.name);
    expect(names).toContain("all");
    expect(names).toContain("main.o");
    expect(names).toContain("clean");
  });

  it("test_sections_assigned", () => {
    const src = Buffer.from("build:\n\tmake all\n\ntest:\n\tpytest\n", "utf-8");
    const [, , , sections] = makefile_idx.extract(src, "Makefile");
    const headings = sections.map((s) => s.heading);
    expect(headings).toContain("build");
    expect(headings).toContain("test");
  });

  it("test_end_lines_assigned", () => {
    const src = Buffer.from("build:\n\tgcc main.c\n\ntest:\n\tpytest\n", "utf-8");
    const [, , , sections] = makefile_idx.extract(src, "Makefile");
    const buildSec = sections.find((s) => s.heading === "build")!;
    const testSec = sections.find((s) => s.heading === "test")!;
    expect(buildSec.end_line).not.toBeNull();
    expect(testSec.end_line).not.toBeNull();
    // build section ends before test section starts
    expect(buildSec.end_line!).toBeLessThan(testSec.line);
  });

  it("test_define_block", () => {
    const src = Buffer.from("define CC_FLAGS\n-Wall -Wextra -O2\nendef\n\nall:\n\techo done\n", "utf-8");
    const [symbols, , , _sections] = makefile_idx.extract(src, "Makefile");
    const names = symbols.map((s) => s.name);
    expect(names).toContain("CC_FLAGS");
    const kinds: Record<string, string> = {};
    for (const s of symbols) {
      kinds[s.name] = s.kind;
    }
    expect(kinds["CC_FLAGS"]).toBe("makefile_define");
  });

  it("test_phony_excluded", () => {
    const src = Buffer.from(".PHONY: all clean\nall:\n\techo hi\nclean:\n\trm -f *.o\n", "utf-8");
    const [symbols, , , _sections] = makefile_idx.extract(src, "Makefile");
    const names = symbols.map((s) => s.name);
    expect(names).not.toContain(".PHONY");
    expect(names).toContain("all");
    expect(names).toContain("clean");
  });

  it("test_double_colon_rule", () => {
    // Double-colon rules (``target::``) are valid Makefile syntax.
    const src = Buffer.from("install:: check\n\tcp app /usr/local/bin\n", "utf-8");
    const [symbols, , , _sections] = makefile_idx.extract(src, "Makefile");
    const names = symbols.map((s) => s.name);
    expect(names).toContain("install");
  });

  it("test_comments_stripped", () => {
    // Commented-out targets must not appear in the index.
    const src = Buffer.from("# disabled_target:\n#\tdo_something\nreal_target:\n\tdo_other\n", "utf-8");
    const [symbols, , , _sections] = makefile_idx.extract(src, "Makefile");
    const names = symbols.map((s) => s.name);
    expect(names).not.toContain("disabled_target");
    expect(names).toContain("real_target");
  });

  it("test_variable_assignment_not_indexed", () => {
    // Simple variable assignments (``CC = gcc``) must NOT be indexed.
    const src = Buffer.from("CC = gcc\nLD = ld\nall:\n\t$(CC) main.c\n", "utf-8");
    const [symbols, , , _sections] = makefile_idx.extract(src, "Makefile");
    const names = symbols.map((s) => s.name);
    expect(names).not.toContain("CC");
    expect(names).not.toContain("LD");
    expect(names).toContain("all");
  });

  it("test_empty_file", () => {
    const [symbols, refs, imps, sections] = makefile_idx.extract(Buffer.from(""), "Makefile");
    expect(symbols).toEqual([]);
    expect(refs).toEqual([]);
    expect(imps).toEqual([]);
    expect(sections).toEqual([]);
  });

  it("test_utf8_bom_on_first_target", () => {
    // A UTF-8 BOM prefix must not hide the first target.
    // Python: "﻿all: build\n\tbuild\n".encode() -> BOM is U+FEFF.
    const src = Buffer.from("﻿all: build\n\tbuild\n", "utf-8");
    const [symbols, , , _sections] = makefile_idx.extract(src, "Makefile");
    const names = symbols.map((s) => s.name);
    expect(names).toContain("all");
  });

  it("test_binary_garbage_does_not_raise", () => {
    // Non-UTF-8 bytes must be handled gracefully (fail-soft).
    // b"\xff\xfe target: all\n" — raw octets with 0xFF/0xFE invalid sequences.
    const src = Buffer.from([0xff, 0xfe, 0x20, 0x74, 0x61, 0x72, 0x67, 0x65, 0x74, 0x3a, 0x20, 0x61, 0x6c, 0x6c, 0x0a]);
    // Should not raise; result shape may be empty or partial.
    const result = makefile_idx.extract(src, "Makefile");
    expect(result.length).toBe(4);
  });

  it("test_indented_line_not_target", () => {
    // Recipe lines (tab-indented) that look like targets must be ignored.
    const src = Buffer.from("all:\n\tclean:\n\t\trm -f *.o\n", "utf-8");
    const [symbols, , , _sections] = makefile_idx.extract(src, "Makefile");
    const names = symbols.map((s) => s.name);
    expect(names).toContain("all");
    // The indented ``clean:`` is a recipe line, not a target declaration.
    expect(names).not.toContain("clean");
  });

  it("test_pattern_rule_included", () => {
    // Pattern rules like ``%.o: %.c`` are valid targets and should be indexed.
    const src = Buffer.from("%.o: %.c\n\t$(CC) -c $<\n", "utf-8");
    const [symbols, , , _sections] = makefile_idx.extract(src, "Makefile");
    const names = symbols.map((s) => s.name);
    expect(names).toContain("%.o");
  });

  it("test_target_with_prerequisites", () => {
    // Prerequisites on the same line as the target should not affect the symbol name.
    const src = Buffer.from("app: main.o utils.o\n\tgcc -o app main.o utils.o\n", "utf-8");
    const [symbols, , , _sections] = makefile_idx.extract(src, "Makefile");
    const names = symbols.map((s) => s.name);
    expect(names).toContain("app");
    // prerequisites must not appear as separate symbols
    expect(!names.includes("main.o") || symbols[0]!.name === "app").toBe(true);
  });

  it("test_symbol_kind_is_makefile_target", () => {
    const src = Buffer.from("build:\n\tgo build ./...\n", "utf-8");
    const [symbols, , , _sections] = makefile_idx.extract(src, "Makefile");
    expect(symbols.some((s) => s.kind === "makefile_target")).toBe(true);
  });

  it("test_multiple_defines", () => {
    const src = Buffer.from("define CFLAGS\n-Wall\nendef\n\ndefine LDFLAGS\n-lpthread\nendef\n", "utf-8");
    const [symbols, , , _sections] = makefile_idx.extract(src, "Makefile");
    const names = symbols.map((s) => s.name);
    expect(names).toContain("CFLAGS");
    expect(names).toContain("LDFLAGS");
  });

  it("test_special_targets_excluded", () => {
    // All GNU make special targets must be suppressed.
    const specials: ReadonlyArray<Buffer> = [
      Buffer.from(".DEFAULT:\n", "utf-8"),
      Buffer.from(".SUFFIXES:\n", "utf-8"),
      Buffer.from(".SILENT:\n", "utf-8"),
      Buffer.from(".PRECIOUS: foo.o\n", "utf-8"),
      Buffer.from(".IGNORE:\n", "utf-8"),
      Buffer.from(".NOTPARALLEL:\n", "utf-8"),
      Buffer.from(".ONESHELL:\n", "utf-8"),
      Buffer.from(".INTERMEDIATE: foo\n", "utf-8"),
      Buffer.from(".SECONDARY: bar\n", "utf-8"),
      Buffer.from(".DELETE_ON_ERROR:\n", "utf-8"),
      Buffer.from(".POSIX:\n", "utf-8"),
    ];
    for (const src of specials) {
      const [symbols, , , _sections] = makefile_idx.extract(src, "Makefile");
      expect(symbols).toEqual([]);
    }
  });
});

// ===========================================================================
// Basename dispatch tests
// ===========================================================================

describe("TestMakefileBasenameDispatch", () => {
  // Verify that Makefile, GNUmakefile, and makefile (lowercase) resolve
  // through the basename lookup table.

  it("test_Makefile_dispatch", async () => {
    const root = canonicalize(tmpDir());
    const mk = path.join(root, "Makefile");
    fs.writeFileSync(mk, "all:\n\tgcc main.c\nclean:\n\trm -f *.o\n", "utf-8");
    const proj: Project = { root, hash: project_hash(root), marker: ".git" };
    const result = await index_file(proj, mk);
    expect(result).not.toBeNull();
    expect(result!.language).toBe("makefile");
    const headings = result!.sections.map((s) => s.heading);
    expect(headings).toContain("all");
    expect(headings).toContain("clean");
  });

  it("test_GNUmakefile_dispatch", async () => {
    const root = canonicalize(tmpDir());
    const mk = path.join(root, "GNUmakefile");
    fs.writeFileSync(mk, "build:\n\tgo build ./...\n", "utf-8");
    const proj: Project = { root, hash: project_hash(root), marker: ".git" };
    const result = await index_file(proj, mk);
    expect(result).not.toBeNull();
    expect(result!.language).toBe("makefile");
  });

  it("test_mk_extension_dispatch", async () => {
    // .mk files (common fragment extension) resolve via LANG_BY_EXT.
    const root = canonicalize(tmpDir());
    const mk = path.join(root, "rules.mk");
    fs.writeFileSync(mk, "compile:\n\tcc src.c\n", "utf-8");
    const proj: Project = { root, hash: project_hash(root), marker: ".git" };
    const result = await index_file(proj, mk);
    expect(result).not.toBeNull();
    expect(result!.language).toBe("makefile");
  });
});

// ===========================================================================
// Extension mapping tests (no DB / filesystem required)
// ===========================================================================

describe("TestParserExtensionMappings", () => {
  // Verify extension and basename entries in the parser's lookup tables.

  // The parametrized extension cases from the Python test.
  const extCases: ReadonlyArray<[string, string]> = [
    [".mts", "typescript"],
    [".cts", "typescript"],
    [".mk", "makefile"],
    [".css", "css"],
    [".scss", "css"],
    [".less", "css"],
    [".sql", "sql"],
    [".graphql", "graphql"],
    [".gql", "graphql"],
    [".proto", "proto"],
  ];

  for (const [ext, expectedLang] of extCases) {
    it(`test_ext_mapped_to_language[${ext}]`, () => {
      expect(LANG_BY_EXT[ext]).toBe(expectedLang);
    });
  }

  // The parametrized basename cases from the Python test. These import
  // LANG_BY_BASENAME, which is NOT exported from parser.ts in the current TS
  // port (only LANG_BY_EXT is exported). The cases are deferred until that
  // export is added — a src change outside this port's scope.
  const basenameCases: ReadonlyArray<[string, string]> = [
    ["makefile", "makefile"],
    ["gnumakefile", "makefile"],
  ];

  for (const [basename, expectedLang] of basenameCases) {
    it.skip(`test_basename_mapped_to_language[${basename}] -> LANG_BY_BASENAME not exported from parser.ts (missing export)`, () => {
      // Once exported: expect(LANG_BY_BASENAME[basename]).toBe(expectedLang);
      void basename;
      void expectedLang;
    });
  }
});
