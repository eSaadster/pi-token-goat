/**
 * Property and fuzz tests for language extractor robustness with malformed source.
 *
 * Faithful 1:1 port of tests/test_parser_malformed.py. Strict NodeNext ESM.
 *
 * All extractors must satisfy two invariants regardless of input:
 *   1. Never raise — return ([], [], [], []) on any error.
 *   2. All returned objects pass structural validity checks (line >= 1, etc.).
 *
 * -----
 * LIVE NOW (grammar adapters landed)
 * -----
 *  - GRAMMAR (tree-sitter) extractors: python / typescript / go / rust. Those
 *    adapters are now ported. They expose `getExtractor()` (async, resolving the
 *    web-tree-sitter parser once) returning a SYNC extract closure rather than a
 *    module-level sync `extract` like the Python source. So `TestExtractorRobustness`
 *    and `TestPythonEdgeCases` resolve the closure via `getExtractor()` in a
 *    per-block beforeAll and then call it synchronously — the never-raise +
 *    structural-validity invariants are now locked in live.
 *
 * -----
 * STILL DEFERRED
 * -----
 *  - Hypothesis / fast-check property tests: the TS suite has NO
 *    property-testing framework installed (fast-check is referenced only as a
 *    future plan in tests/setup.ts). All `@given(...)`-decorated tests are
 *    DEFERRED. Where the property is also covered by a fixed edge case that
 *    DOES run (the flat-config robustness matrix), that coverage stays live.
 *
 * -----
 * LIVE categories this run
 * -----
 *  - `TestFlatConfigRobustness` (8 cases x 5 flat adapters = 40 tests): toml /
 *    yaml / json / ini / dockerfile. These adapters ARE ported and share the
 *    common.ts decode/BOM-strip/end-line plumbing; the never-raise invariant
 *    is locked in live.
 *  - `TestFlatConfigDeterminism` (1 case x 5 adapters = 5 tests): same-input =>
 *    same-output ordering, live.
 *
 * The parametrized classes become `describe.each` blocks; vitest's
 * `describe.each(table)` fans out one nested describe per row exactly like
 * pytest's `@pytest.mark.parametrize` on a class.
 */
import { beforeAll, describe, expect, it } from "vitest";

import { getExtractor as goGetExtractor } from "../src/token_goat/languages/go.js";
import { getExtractor as pyGetExtractor } from "../src/token_goat/languages/python.js";
import { getExtractor as rustGetExtractor } from "../src/token_goat/languages/rust.js";
import { getExtractor as tsGetExtractor } from "../src/token_goat/languages/typescript.js";
import type { Extractor } from "../src/token_goat/parser.js";

import { extract as dockerfile_extract } from "../src/token_goat/languages/dockerfile_idx.js";
import { extract as ini_extract } from "../src/token_goat/languages/ini_idx.js";
import { extract as json_extract } from "../src/token_goat/languages/json_idx.js";
import { extract as toml_extract } from "../src/token_goat/languages/toml_idx.js";
import { extract as yaml_extract } from "../src/token_goat/languages/yaml_idx.js";

// ===========================================================================
// Helpers
// ===========================================================================

/**
 * Assert structural validity on all returned objects.
 *
 * Faithful port of _assert_valid_results. Operates on the 4-tuple
 * [symbols, refs, imp_exp, sections] every extractor returns.
 */
function _assertValidResults(
  symbols: unknown[],
  refs: unknown[],
  impExp: unknown[],
  sections: unknown[],
  label: string,
): void {
  expect(Array.isArray(symbols)).toBe(true);
  expect(Array.isArray(refs)).toBe(true);
  expect(Array.isArray(impExp)).toBe(true);
  expect(Array.isArray(sections)).toBe(true);

  for (const sym of symbols as Array<{
    name: string;
    kind: string;
    line: number;
    end_line?: number | null;
  }>) {
    expect(sym.line).toBeGreaterThanOrEqual(1);
    expect([...sym.name].length).toBeGreaterThanOrEqual(1);
    if (sym.end_line !== undefined && sym.end_line !== null) {
      expect(sym.end_line).toBeGreaterThanOrEqual(sym.line);
    }
  }

  for (const ref of refs as Array<{ name: string; line: number }>) {
    expect(ref.line).toBeGreaterThanOrEqual(1);
    expect([...ref.name].length).toBeGreaterThan(1);
  }

  for (const ie of impExp as Array<{ kind: string; target: string }>) {
    expect(ie.kind === "import" || ie.kind === "export").toBe(true);
    expect([...ie.target].length).toBeGreaterThanOrEqual(1);
  }

  for (const sec of sections as Array<{ heading?: string; title?: string; line: number }>) {
    const headingLabel = sec.heading ?? sec.title ?? "<no name>";
    expect(sec.line).toBeGreaterThanOrEqual(1);
    void headingLabel;
  }
}

// ===========================================================================
// Grammar extractors — LIVE (python/typescript/go/rust adapters ported)
// ===========================================================================

// name -> getExtractor factory. The TS grammar adapters expose an async
// getExtractor() (resolving the web-tree-sitter parser once) returning a SYNC
// extract closure, rather than the module-level sync `extract` of the Python
// source. Each closure is resolved once and cached per name.
const GRAMMAR_FACTORIES: Record<string, () => Promise<Extractor>> = {
  python: pyGetExtractor,
  typescript: tsGetExtractor,
  go: goGetExtractor,
  rust: rustGetExtractor,
};

const GRAMMAR_EXTRACTORS = [
  ["python", "src/app.py"],
  ["typescript", "src/app.ts"],
  ["go", "main.go"],
  ["rust", "src/main.rs"],
] as const;

// Resolved sync extractor per grammar name (populated by the per-block beforeAll).
const _resolvedExtractors: Record<string, Extractor> = {};

async function _resolveExtractor(name: string): Promise<Extractor> {
  if (_resolvedExtractors[name] === undefined) {
    _resolvedExtractors[name] = await GRAMMAR_FACTORIES[name]!();
  }
  return _resolvedExtractors[name]!;
}

// ===========================================================================
// Parametrized fixed edge cases — GRAMMAR extractors (LIVE)
// ===========================================================================

describe.each(GRAMMAR_EXTRACTORS)(
  "TestExtractorRobustness [%s] (grammar)",
  (name, relPath) => {
    let extract: Extractor;

    beforeAll(async () => {
      extract = await _resolveExtractor(name);
    });

    it("test_empty_bytes", () => {
      const result = extract(Buffer.from(""), relPath);
      _assertValidResults(...(result as [any, any, any, any]), `${name}/empty`);
    });

    it("test_null_bytes", () => {
      const result = extract(Buffer.alloc(64, 0x00), relPath);
      _assertValidResults(...(result as [any, any, any, any]), `${name}/nulls`);
    });

    it("test_invalid_utf8", () => {
      const bad = Buffer.concat(Array.from({ length: 20 }, () => Buffer.from([0xff, 0xfe, 0x80, 0x81, 0x82])));
      const result = extract(bad, relPath);
      _assertValidResults(...(result as [any, any, any, any]), `${name}/invalid_utf8`);
    });

    it("test_truncated_mid_token", () => {
      const snippet = Buffer.from(
        "def foo(x, y):\n    return x + y\n\nclass Bar:\n    def me",
      );
      const result = extract(snippet, relPath);
      _assertValidResults(...(result as [any, any, any, any]), `${name}/truncated`);
    });

    it("test_only_whitespace", () => {
      const result = extract(Buffer.from("   \n\t\n   \n"), relPath);
      _assertValidResults(...(result as [any, any, any, any]), `${name}/whitespace`);
    });

    it("test_only_comments", () => {
      const result = extract(Buffer.from("# comment\n// comment\n/* comment */\n"), relPath);
      _assertValidResults(...(result as [any, any, any, any]), `${name}/comments`);
    });

    it("test_deeply_nested_braces", () => {
      // 50 levels of nesting — enough to exercise the recursive path without
      // hitting the native stack limit inside tree-sitter's C runtime.
      const source = Buffer.concat([
        Buffer.concat(Array.from({ length: 50 }, () => Buffer.from("{\n"))),
        Buffer.concat(Array.from({ length: 50 }, () => Buffer.from("}\n"))),
      ]);
      const result = extract(source, relPath);
      _assertValidResults(...(result as [any, any, any, any]), `${name}/deep_nesting`);
    });

    it("test_very_long_line", () => {
      // ~500 tokens — enough to stress the parser without hitting the C stack limit.
      const source = Buffer.concat([
        Buffer.from("x = "),
        Buffer.concat(Array.from({ length: 500 }, () => Buffer.from("1 + "))),
        Buffer.from("0\n"),
      ]);
      const result = extract(source, relPath);
      _assertValidResults(...(result as [any, any, any, any]), `${name}/long_line`);
    });

    it("test_mixed_binary_and_text", () => {
      const allBytes = Buffer.alloc(256);
      for (let i = 0; i < 256; i++) allBytes[i] = i;
      const source = Buffer.concat([
        Buffer.from("def foo():\n    pass\n"),
        allBytes,
        Buffer.from("\ndef bar():\n    pass\n"),
      ]);
      const result = extract(source, relPath);
      _assertValidResults(...(result as [any, any, any, any]), `${name}/mixed_binary`);
    });

    it("test_wrong_language_source", () => {
      // Feed each extractor valid source from a different language.
      const foreign: Record<string, Buffer> = {
        python: Buffer.from('fn main() { println!("hello"); }\n'),
        typescript: Buffer.from("package main\nfunc main() {}\n"),
        go: Buffer.from("class Foo { void bar() {} }\n"),
        rust: Buffer.from("def foo():\n    pass\n"),
      };
      const result = extract(foreign[name]!, relPath);
      _assertValidResults(...(result as [any, any, any, any]), `${name}/wrong_language`);
    });

    it("test_nul_embedded_in_valid_source", () => {
      const source = Buffer.from("def foo():\n    x = \u0000'hello'\n    return x\n");
      const result = extract(source, relPath);
      _assertValidResults(...(result as [any, any, any, any]), `${name}/embedded_nul`);
    });

    it("test_extremely_long_identifier", () => {
      const ident = Buffer.alloc(10000).fill("a".charCodeAt(0));
      const source = Buffer.concat([Buffer.from("def "), ident, Buffer.from("():\n    pass\n")]);
      const result = extract(source, relPath);
      _assertValidResults(...(result as [any, any, any, any]), `${name}/long_ident`);
    });

    it("test_unicode_identifiers", () => {
      const source = Buffer.from("def héllo_wörld(αβγ):\n    return αβγ\n", "utf-8");
      const result = extract(source, relPath);
      _assertValidResults(...(result as [any, any, any, any]), `${name}/unicode_idents`);
    });

    it("test_no_newline_at_eof", () => {
      const result = extract(Buffer.from("def foo(): pass"), relPath);
      _assertValidResults(...(result as [any, any, any, any]), `${name}/no_eof_newline`);
    });
  },
);

// ===========================================================================
// Cross-language: Python-specific edge cases — LIVE (python grammar)
// ===========================================================================

describe("TestPythonEdgeCases (python grammar)", () => {
  let py_extract: Extractor;

  beforeAll(async () => {
    py_extract = await _resolveExtractor("python");
  });

  it("test_decorator_with_args", () => {
    const src = Buffer.from("@app.route('/foo', methods=['GET'])\ndef view():\n    pass\n");
    const [syms, refs] = py_extract(src, "views.py");
    _assertValidResults(syms, refs, [], [], "py/decorator");
  });

  it("test_nested_classes", () => {
    const src = Buffer.from(
      "class Outer:\n    class Inner:\n        def method(self):\n            pass\n",
    );
    const [syms] = py_extract(src, "nested.py");
    const names = new Set(syms.map((s: any) => s.name));
    expect(names.has("Outer")).toBe(true);
    expect(names.has("Inner")).toBe(true);
  });

  it("test_multiline_string_does_not_create_fake_refs", () => {
    const src = Buffer.from(
      'def foo():\n    x = """\n    bar()\n    baz()\n    """\n    return x\n',
    );
    const [, refs] = py_extract(src, "multi.py");
    // bar/baz are inside a string literal — they may or may not appear but must
    // not crash and any that appear must be valid.
    for (const r of refs) {
      expect(r.line).toBeGreaterThanOrEqual(1);
    }
  });

  it("test_walrus_operator", () => {
    const src = Buffer.from("def foo(data):\n    if n := len(data):\n        return n\n");
    const result = py_extract(src, "walrus.py");
    _assertValidResults(...(result as [any, any, any, any]), "py/walrus");
  });

  it("test_type_alias", () => {
    const src = Buffer.from(
      "type Vector = list[float]\n\ndef scale(v: Vector) -> Vector:\n    return v\n",
    );
    const result = py_extract(src, "alias.py");
    _assertValidResults(...(result as [any, any, any, any]), "py/type_alias");
  });
});

// ===========================================================================
// Hypothesis property tests — DEFERRED (no fast-check)
// ===========================================================================

const PROPERTY_REASON =
  "DEFERRED: property test requires a property-testing framework (hypothesis " +
  "in Python; fast-check is not installed in the TS suite). Re-enable when " +
  "fast-check is wired up. The fixed-edge-case matrices above/below provide the " +
  "live never-raise coverage in the meantime.";

describe("Hypothesis property tests (DEFERRED)", () => {
  it.skip("test_py_extract_never_raises_on_arbitrary_bytes", () => void PROPERTY_REASON);
  it.skip("test_ts_extract_never_raises_on_arbitrary_bytes", () => void PROPERTY_REASON);
  it.skip("test_go_extract_never_raises_on_arbitrary_bytes", () => void PROPERTY_REASON);
  it.skip("test_rust_extract_never_raises_on_arbitrary_bytes", () => void PROPERTY_REASON);
  it.skip("test_py_extract_never_raises_on_printable_text", () => void PROPERTY_REASON);
  it.skip("test_ts_extract_never_raises_on_printable_text", () => void PROPERTY_REASON);
  it.skip("test_go_extract_never_raises_on_printable_text", () => void PROPERTY_REASON);
  it.skip("test_rust_extract_never_raises_on_printable_text", () => void PROPERTY_REASON);

  it.skip("test_extract_refs_from_source_never_raises", () => void PROPERTY_REASON);

  it.skip("test_toml_extract_never_raises_on_arbitrary_bytes", () => void PROPERTY_REASON);
  it.skip("test_yaml_extract_never_raises_on_arbitrary_bytes", () => void PROPERTY_REASON);
  it.skip("test_json_extract_never_raises_on_arbitrary_bytes", () => void PROPERTY_REASON);
  it.skip("test_ini_extract_never_raises_on_arbitrary_bytes", () => void PROPERTY_REASON);
  it.skip("test_dockerfile_extract_never_raises_on_arbitrary_bytes", () => void PROPERTY_REASON);
  it.skip("test_toml_extract_never_raises_on_printable_text", () => void PROPERTY_REASON);
  it.skip("test_yaml_extract_never_raises_on_printable_text", () => void PROPERTY_REASON);
  it.skip("test_json_extract_never_raises_on_printable_text", () => void PROPERTY_REASON);
  it.skip("test_ini_extract_never_raises_on_printable_text", () => void PROPERTY_REASON);
  it.skip("test_dockerfile_extract_never_raises_on_printable_text", () => void PROPERTY_REASON);

  it.skip("test_py_extract_is_deterministic", () => void PROPERTY_REASON);
});

// ===========================================================================
// Flat-config adapters — fixed edge cases (LIVE: toml/yaml/json/ini/dockerfile)
// ===========================================================================

const FLAT_CONFIG_EXTRACTORS = [
  ["toml", toml_extract, "pyproject.toml"],
  ["yaml", yaml_extract, ".github/workflows/ci.yml"],
  ["json", json_extract, "package.json"],
  ["ini", ini_extract, "setup.cfg"],
  ["dockerfile", dockerfile_extract, "Dockerfile"],
] as const;

describe.each(FLAT_CONFIG_EXTRACTORS)(
  "TestFlatConfigRobustness [%s]",
  (name, extractFn, relPath) => {
    it("test_empty_bytes", () => {
      const result = extractFn(Buffer.from(""), relPath);
      _assertValidResults(...(result as [any, any, any, any]), `${name}/empty`);
    });

    it("test_null_bytes", () => {
      const result = extractFn(Buffer.alloc(64, 0x00), relPath);
      _assertValidResults(...(result as [any, any, any, any]), `${name}/nulls`);
    });

    it("test_invalid_utf8", () => {
      const bad = Buffer.concat(
        Array.from({ length: 20 }, () => Buffer.from([0xff, 0xfe, 0x80, 0x81, 0x82])),
      );
      const result = extractFn(bad, relPath);
      _assertValidResults(...(result as [any, any, any, any]), `${name}/invalid_utf8`);
    });

    it("test_utf8_bom_only", () => {
      // BOM-only file exercises the BOM-strip helper in common.ts without any
      // content to follow it — a common Windows editor output for a newly
      // created config file.
      const result = extractFn(Buffer.from([0xef, 0xbb, 0xbf]), relPath);
      _assertValidResults(...(result as [any, any, any, any]), `${name}/bom_only`);
    });

    it("test_huge_single_line", () => {
      // 200 KB single-line input — exercises the per-file/heading caps in the
      // adapters and ensures none of them blow up on absent newlines.
      const result = extractFn(Buffer.alloc(200_000).fill("x".charCodeAt(0)), relPath);
      _assertValidResults(...(result as [any, any, any, any]), `${name}/huge_oneline`);
    });

    it("test_crlf_line_endings", () => {
      // Windows CRLF — common in real-world config files; the common.ts
      // end-line helper must treat \r\n and \n identically.
      const source = Buffer.concat(
        Array.from({ length: 10 }, () => Buffer.from("[section]\r\nkey=value\r\n")),
      );
      const result = extractFn(source, relPath);
      _assertValidResults(...(result as [any, any, any, any]), `${name}/crlf`);
    });

    it("test_unicode_section_names", () => {
      // Section / table / heading names with non-ASCII content; each adapter
      // has its own regex but they all share the decode path.
      const source = Buffer.from("[héllo_wörld]\nkey=value\n", "utf-8");
      const result = extractFn(source, relPath);
      _assertValidResults(...(result as [any, any, any, any]), `${name}/unicode_section`);
    });

    it("test_no_newline_at_eof", () => {
      const result = extractFn(Buffer.from("[section]\nkey=value"), relPath);
      _assertValidResults(...(result as [any, any, any, any]), `${name}/no_eof_newline`);
    });
  },
);

// ===========================================================================
// Flat-config determinism (LIVE)
// ===========================================================================

describe.each(FLAT_CONFIG_EXTRACTORS)(
  "TestFlatConfigDeterminism [%s]",
  (name, extractFn, relPath) => {
    it("test_same_input_same_output_counts", () => {
      // Use a representative format-specific payload; each adapter sees a mix
      // of valid headers and noise so symbol + section counts are > 0 for at
      // least one adapter (any non-empty count exercises ordering).
      const sources: Record<string, Buffer> = {
        toml: Buffer.from(
          "[tool.ruff]\nline-length = 100\n\n[[tool.mypy.overrides]]\nmodule = 'x'\n",
        ),
        yaml: Buffer.from(
          "name: ci\non:\n  push:\n    branches: [main]\njobs:\n  test:\n    runs-on: ubuntu-latest\n",
        ),
        json: Buffer.from(
          '{"name": "pkg", "scripts": {"build": "tsc"}, "dependencies": {"a": "1.0"}}',
        ),
        ini: Buffer.from(
          "[section1]\nkey1=value1\n\n[section2]\nkey2=value2\n",
        ),
        dockerfile: Buffer.from(
          "FROM python:3.12-slim\nRUN apt-get update\nWORKDIR /app\nCOPY . .\n",
        ),
      };
      const source = sources[name]!;
      const r1 = extractFn(source, relPath);
      const r2 = extractFn(source, relPath);
      const [syms1, refs1, ie1, sec1] = r1;
      const [syms2, refs2, ie2, sec2] = r2;
      expect(syms1.length).toBe(syms2.length);
      expect(refs1.length).toBe(refs2.length);
      expect(ie1.length).toBe(ie2.length);
      expect(sec1.length).toBe(sec2.length);
      // Ordering also matters — line numbers must come out in the same sequence
      // so DB upsert keys stay stable across re-indexes.
      expect(syms1.map((s) => s.line)).toEqual(syms2.map((s) => s.line));
      expect(sec1.map((s) => s.line)).toEqual(sec2.map((s) => s.line));
    });
  },
);
