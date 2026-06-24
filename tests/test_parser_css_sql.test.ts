/**
 * Tests for the CSS and SQL language extractors.
 *
 * Faithful 1:1 port of tests/test_parser_css_sql.py. Strict NodeNext ESM.
 * The Python source is the specification; assertions mirror it field-for-field.
 *
 * Adaptations (Python -> TS, all mechanical):
 *  - `b"..."` byte literals -> `Buffer.from("...", "utf-8")`.
 *  - The 4-tuple unpacking `symbols, refs, imps, sections = ...extract(...)` is
 *    identical in TS (array destructuring of the fixed 4-element tuple).
 *  - `len(result) == 4` (Python tuple length) -> `result.length === 4`.
 *  - `tmp_path` (pytest function-scoped fixture) -> a per-test `fs.mkdtempSync`
 *    directory under os.tmpdir() (vitest's setupFiles provides no tmp_path).
 *  - The Project dataclass is a plain interface in TS; the test builds the
 *    object literal directly (root/hash/marker) exactly like the Python
 *    `Project(root=..., hash=..., marker=".git")`.
 *  - `parser.index_file` is async in the TS port (dynamic adapter import); the
 *    dispatch tests `await` it.
 *  - Python's `"﻿.hero {...}".encode()` (UTF-8 BOM literal in the Python source)
 *    -> the same string literal (the BOM is U+FEFF, preserved by Buffer.from
 *    with the "utf-8" encoding).
 *  - `it.todo` / `it.skip` is NOT used: every case here exercises a FLAT
 *    (regex) language (css/sql), which is ported and live this run.
 */

import { describe, expect, it } from "vitest";

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import * as css_idx from "../src/token_goat/languages/css_idx.js";
import * as sql_idx from "../src/token_goat/languages/sql_idx.js";
import { index_file } from "../src/token_goat/parser.js";
import { canonicalize, type Project, project_hash } from "../src/token_goat/project.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Per-test tmp dir (the pytest `tmp_path` fixture equivalent). */
function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "tg-css-sql-"));
}

/** Build a Project for a tmp root, mirroring the Python test's construction. */
function projectFor(root: string, marker = ".git"): Project {
  return { root: canonicalize(root), hash: project_hash(canonicalize(root)), marker };
}

// ===========================================================================
// CSS extractor
// ===========================================================================

describe("TestCssClassSelectors", () => {
  it("test_class_selector", () => {
    const src = Buffer.from(".btn-primary { color: red; }\n", "utf-8");
    const [symbols, refs, imps, _sections] = css_idx.extract(src, "style.css");
    expect(refs).toEqual([]);
    expect(imps).toEqual([]);
    const names = symbols.map((s) => s.name);
    expect(names).toContain(".btn-primary");
  });

  it("test_multiple_class_selectors", () => {
    const src = Buffer.from(".foo { }\n.bar { }\n.baz { }\n", "utf-8");
    const [symbols] = css_idx.extract(src, "style.css");
    const names = symbols.map((s) => s.name);
    expect(names).toContain(".foo");
    expect(names).toContain(".bar");
    expect(names).toContain(".baz");
  });

  it("test_id_selector", () => {
    const src = Buffer.from("#header { margin: 0; }\n", "utf-8");
    const [symbols] = css_idx.extract(src, "style.css");
    const names = symbols.map((s) => s.name);
    expect(names).toContain("#header");
  });

  it("test_selector_kind_is_css_selector", () => {
    const src = Buffer.from(".btn { color: blue; }\n", "utf-8");
    const [symbols] = css_idx.extract(src, "style.css");
    const kinds = new Set(symbols.filter((s) => s.name === ".btn").map((s) => s.kind));
    expect(kinds).toEqual(new Set(["css_selector"]));
  });
});

describe("TestCssCustomProperties", () => {
  it("test_custom_property_in_root", () => {
    const src = Buffer.from(":root {\n  --primary-color: #333;\n  --font-size: 16px;\n}\n", "utf-8");
    const [symbols] = css_idx.extract(src, "style.css");
    const names = symbols.map((s) => s.name);
    expect(names).toContain("--primary-color");
    expect(names).toContain("--font-size");
  });

  it("test_custom_property_kind", () => {
    const src = Buffer.from(":root { --brand: red; }\n", "utf-8");
    const [symbols] = css_idx.extract(src, "style.css");
    const kinds = new Set(symbols.filter((s) => s.name === "--brand").map((s) => s.kind));
    expect(kinds).toEqual(new Set(["css_var"]));
  });

  it("test_duplicate_custom_property_deduped", () => {
    // Same --var appearing multiple times should produce one symbol.
    const src = Buffer.from(":root { --color: red; }\n.dark { --color: blue; }\n", "utf-8");
    const [symbols] = css_idx.extract(src, "style.css");
    const count = symbols.filter((s) => s.name === "--color").length;
    expect(count).toBe(1);
  });
});

describe("TestCssAtRules", () => {
  it("test_keyframes", () => {
    const src = Buffer.from("@keyframes slide-in { from { opacity: 0; } to { opacity: 1; } }\n", "utf-8");
    const [symbols] = css_idx.extract(src, "style.css");
    const names = symbols.map((s) => s.name);
    expect(names).toContain("@keyframes slide-in");
  });

  it("test_keyframes_kind", () => {
    const src = Buffer.from("@keyframes spin { }\n", "utf-8");
    const [symbols] = css_idx.extract(src, "style.css");
    const kinds = new Set(symbols.filter((s) => s.name.includes("spin")).map((s) => s.kind));
    expect(kinds).toEqual(new Set(["css_keyframe"]));
  });

  it("test_mixin", () => {
    const src = Buffer.from("@mixin flex-center { display: flex; align-items: center; }\n", "utf-8");
    const [symbols] = css_idx.extract(src, "style.css");
    const names = symbols.map((s) => s.name);
    expect(names).toContain("@mixin flex-center");
  });

  it("test_mixin_kind", () => {
    const src = Buffer.from("@mixin button-base { }\n", "utf-8");
    const [symbols] = css_idx.extract(src, "style.css");
    const kinds = new Set(symbols.filter((s) => s.name.includes("button-base")).map((s) => s.kind));
    expect(kinds).toEqual(new Set(["css_mixin"]));
  });

  it("test_media_query", () => {
    const src = Buffer.from("@media (max-width: 768px) { .col { width: 100%; } }\n", "utf-8");
    const [symbols] = css_idx.extract(src, "style.css");
    const names = symbols.map((s) => s.name);
    expect(names.some((n) => n.includes("media"))).toBe(true);
  });

  it("test_media_query_kind", () => {
    const src = Buffer.from("@media screen { }\n", "utf-8");
    const [symbols] = css_idx.extract(src, "style.css");
    const kinds = new Set(symbols.filter((s) => s.name.includes("media")).map((s) => s.kind));
    expect(kinds).toEqual(new Set(["css_rule"]));
  });
});

describe("TestCssSections", () => {
  it("test_sections_match_symbols", () => {
    const src = Buffer.from(".foo { color: red; }\n.bar { color: blue; }\n", "utf-8");
    const [symbols, _refs, _imps, sections] = css_idx.extract(src, "style.css");
    const symNames = new Set(symbols.map((s) => s.name));
    const secNames = new Set(sections.map((s) => s.heading));
    expect(symNames).toEqual(secNames);
  });

  it("test_end_lines_assigned", () => {
    const src = Buffer.from(".a { }\n.b { }\n", "utf-8");
    const [, , , sections] = css_idx.extract(src, "style.css");
    for (const sec of sections) {
      expect(sec.end_line).not.toBeNull();
    }
  });

  it("test_line_numbers_are_one_based", () => {
    const src = Buffer.from("/* header */\n.target { color: red; }\n", "utf-8");
    const [symbols] = css_idx.extract(src, "style.css");
    const target = symbols.find((s) => s.name === ".target") ?? null;
    expect(target).not.toBeNull();
    expect(target!.line).toBe(2);
  });

  it("test_comment_stripped_no_false_positive", () => {
    // Selectors inside comments must not be extracted.
    const src = Buffer.from("/* .inside-comment { } */\n.real { color: red; }\n", "utf-8");
    const [symbols] = css_idx.extract(src, "style.css");
    const names = symbols.map((s) => s.name);
    expect(names).not.toContain(".inside-comment");
    expect(names).toContain(".real");
  });
});

describe("TestCssImports", () => {
  it("test_css_import_double_quote", () => {
    const src = Buffer.from('@import "variables.css";\n.btn { color: red; }\n', "utf-8");
    const [, , imps] = css_idx.extract(src, "style.css");
    const targets = imps.map((i) => i.target);
    expect(targets).toContain("variables.css");
  });

  it("test_css_import_single_quote", () => {
    const src = Buffer.from("@import 'reset.css';\n", "utf-8");
    const [, , imps] = css_idx.extract(src, "style.css");
    const targets = imps.map((i) => i.target);
    expect(targets).toContain("reset.css");
  });

  it("test_css_import_url_form", () => {
    const src = Buffer.from('@import url("fonts.css");\n', "utf-8");
    const [, , imps] = css_idx.extract(src, "style.css");
    const targets = imps.map((i) => i.target);
    expect(targets).toContain("fonts.css");
  });

  it("test_scss_use_directive", () => {
    const src = Buffer.from('@use "sass:math";\n@use "mixins/flex";\n', "utf-8");
    const [, , imps] = css_idx.extract(src, "main.scss");
    const targets = imps.map((i) => i.target);
    expect(targets).toContain("sass:math");
    expect(targets).toContain("mixins/flex");
  });

  it("test_scss_forward_directive", () => {
    const src = Buffer.from('@forward "components/button";\n', "utf-8");
    const [, , imps] = css_idx.extract(src, "_index.scss");
    const targets = imps.map((i) => i.target);
    expect(targets).toContain("components/button");
  });

  it("test_import_kind_is_import", () => {
    const src = Buffer.from('@import "base.css";\n', "utf-8");
    const [, , imps] = css_idx.extract(src, "style.css");
    expect(imps.every((i) => i.kind === "import")).toBe(true);
  });

  it("test_import_line_number", () => {
    const src = Buffer.from("/* preamble */\n@import 'vars.css';\n", "utf-8");
    const [, , imps] = css_idx.extract(src, "style.css");
    expect(imps.some((i) => i.line === 2)).toBe(true);
  });

  it("test_multiple_imports", () => {
    const src = Buffer.from(
      '@import "reset.css";\n@import "vars.css";\n@import "components.css";\n',
      "utf-8",
    );
    const [, , imps] = css_idx.extract(src, "style.css");
    const targets = new Set(imps.map((i) => i.target));
    expect(targets).toEqual(new Set(["reset.css", "vars.css", "components.css"]));
  });

  it("test_no_import_in_plain_css", () => {
    const src = Buffer.from(".btn { color: red; }\n#header { margin: 0; }\n", "utf-8");
    const [, , imps] = css_idx.extract(src, "style.css");
    expect(imps).toEqual([]);
  });

  it("test_import_inside_comment_not_extracted", () => {
    // @import inside a block comment must not produce an import edge.
    const src = Buffer.from('/* @import "should-not-appear.css"; */\n@import "real.css";\n', "utf-8");
    const [, , imps] = css_idx.extract(src, "style.css");
    const targets = imps.map((i) => i.target);
    expect(targets).not.toContain("should-not-appear.css");
    expect(targets).toContain("real.css");
  });
});

describe("TestCssEdgeCases", () => {
  it("test_empty_file", () => {
    const [symbols, _refs, _imps, sections] = css_idx.extract(Buffer.from(""), "empty.css");
    expect(symbols).toEqual([]);
    expect(sections).toEqual([]);
  });

  it("test_invalid_utf8_does_not_crash", () => {
    // Replace invalid bytes — must not raise. The invalid 0xFF byte is encoded
    // as a raw octet (matching Python's b"...'\xff'..."); Buffer.from of a byte
    // array preserves the octet exactly.
    const src = Buffer.from(
      ".btn { content: '".split("").map((c) => c.charCodeAt(0))
        .concat([0xff])
        .concat("'; }\n".split("").map((c) => c.charCodeAt(0))),
    );
    const result = css_idx.extract(src, "bad.css");
    expect(result.length).toBe(4);
  });

  it("test_utf8_bom_on_first_symbol", () => {
    // A UTF-8 BOM prefix must not swallow the first symbol.
    // Python: "﻿.hero {...}".encode() -> the BOM is the literal U+FEFF.
    const src = Buffer.from("﻿.hero { color: blue; }\n", "utf-8");
    const [symbols] = css_idx.extract(src, "style.css");
    const names = symbols.map((s) => s.name);
    expect(names).toContain(".hero");
  });

  it("test_scss_extension_uses_same_extractor", () => {
    const src = Buffer.from("@mixin rounded($r: 4px) { border-radius: $r; }\n", "utf-8");
    const [symbols] = css_idx.extract(src, "theme.scss");
    const names = symbols.map((s) => s.name);
    expect(names).toContain("@mixin rounded");
  });
});

// ===========================================================================
// SQL extractor
// ===========================================================================

describe("TestSqlTables", () => {
  it("test_create_table", () => {
    const src = Buffer.from("CREATE TABLE users (id INTEGER PRIMARY KEY);\n", "utf-8");
    const [symbols, refs, imps, _sections] = sql_idx.extract(src, "schema.sql");
    expect(refs).toEqual([]);
    expect(imps).toEqual([]);
    const names = symbols.map((s) => s.name);
    expect(names).toContain("users");
  });

  it("test_create_table_kind", () => {
    const src = Buffer.from("CREATE TABLE orders (id INT);\n", "utf-8");
    const [symbols] = sql_idx.extract(src, "schema.sql");
    const kinds = new Set(symbols.filter((s) => s.name === "orders").map((s) => s.kind));
    expect(kinds).toEqual(new Set(["sql_table"]));
  });

  it("test_create_table_if_not_exists", () => {
    const src = Buffer.from("CREATE TABLE IF NOT EXISTS settings (key TEXT, value TEXT);\n", "utf-8");
    const [symbols] = sql_idx.extract(src, "schema.sql");
    const names = symbols.map((s) => s.name);
    expect(names).toContain("settings");
  });

  it("test_create_temp_table", () => {
    const src = Buffer.from("CREATE TEMP TABLE tmp_data (val INT);\n", "utf-8");
    const [symbols] = sql_idx.extract(src, "schema.sql");
    const names = symbols.map((s) => s.name);
    expect(names).toContain("tmp_data");
  });

  it("test_create_temporary_table", () => {
    const src = Buffer.from("CREATE TEMPORARY TABLE staging (id INT);\n", "utf-8");
    const [symbols] = sql_idx.extract(src, "schema.sql");
    const names = symbols.map((s) => s.name);
    expect(names).toContain("staging");
  });

  it("test_schema_qualified_table", () => {
    const src = Buffer.from("CREATE TABLE public.events (id INT);\n", "utf-8");
    const [symbols] = sql_idx.extract(src, "schema.sql");
    const names = symbols.map((s) => s.name);
    expect(names).toContain("public.events");
  });
});

describe("TestSqlViews", () => {
  it("test_create_view", () => {
    const src = Buffer.from("CREATE VIEW active_users AS SELECT * FROM users WHERE active=1;\n", "utf-8");
    const [symbols] = sql_idx.extract(src, "schema.sql");
    const names = symbols.map((s) => s.name);
    expect(names).toContain("active_users");
  });

  it("test_create_view_kind", () => {
    const src = Buffer.from("CREATE VIEW vw_orders AS SELECT id FROM orders;\n", "utf-8");
    const [symbols] = sql_idx.extract(src, "schema.sql");
    const kinds = new Set(symbols.filter((s) => s.name === "vw_orders").map((s) => s.kind));
    expect(kinds).toEqual(new Set(["sql_view"]));
  });

  it("test_create_or_replace_view", () => {
    const src = Buffer.from("CREATE OR REPLACE VIEW summary AS SELECT count(*) FROM users;\n", "utf-8");
    const [symbols] = sql_idx.extract(src, "schema.sql");
    const names = symbols.map((s) => s.name);
    expect(names).toContain("summary");
  });
});

describe("TestSqlFunctions", () => {
  it("test_create_function", () => {
    const src = Buffer.from(
      "CREATE FUNCTION get_user(user_id INT) RETURNS TEXT AS $$ BEGIN END $$ LANGUAGE plpgsql;\n",
      "utf-8",
    );
    const [symbols] = sql_idx.extract(src, "schema.sql");
    const names = symbols.map((s) => s.name);
    expect(names).toContain("get_user");
  });

  it("test_create_function_kind", () => {
    const src = Buffer.from(
      "CREATE FUNCTION add_numbers(a INT, b INT) RETURNS INT AS $$ SELECT a+b; $$ LANGUAGE SQL;\n",
      "utf-8",
    );
    const [symbols] = sql_idx.extract(src, "schema.sql");
    const kinds = new Set(symbols.filter((s) => s.name === "add_numbers").map((s) => s.kind));
    expect(kinds).toEqual(new Set(["sql_function"]));
  });

  it("test_create_or_replace_function", () => {
    const src = Buffer.from(
      "CREATE OR REPLACE FUNCTION compute_tax(amount NUMERIC) RETURNS NUMERIC AS $$ BEGIN RETURN amount * 0.1; END; $$ LANGUAGE plpgsql;\n",
      "utf-8",
    );
    const [symbols] = sql_idx.extract(src, "schema.sql");
    const names = symbols.map((s) => s.name);
    expect(names).toContain("compute_tax");
  });

  it("test_create_procedure", () => {
    const src = Buffer.from(
      "CREATE PROCEDURE update_status(id INT) AS BEGIN UPDATE t SET s=1 WHERE id=id; END;\n",
      "utf-8",
    );
    const [symbols] = sql_idx.extract(src, "schema.sql");
    const names = symbols.map((s) => s.name);
    expect(names).toContain("update_status");
  });

  it("test_create_procedure_kind", () => {
    const src = Buffer.from(
      "CREATE PROCEDURE cleanup_old() AS BEGIN DELETE FROM logs WHERE ts < NOW()-7; END;\n",
      "utf-8",
    );
    const [symbols] = sql_idx.extract(src, "schema.sql");
    const kinds = new Set(symbols.filter((s) => s.name === "cleanup_old").map((s) => s.kind));
    expect(kinds).toEqual(new Set(["sql_procedure"]));
  });
});

describe("TestSqlIndexes", () => {
  it("test_create_index", () => {
    const src = Buffer.from("CREATE INDEX idx_users_email ON users(email);\n", "utf-8");
    const [symbols] = sql_idx.extract(src, "schema.sql");
    const names = symbols.map((s) => s.name);
    expect(names).toContain("idx_users_email");
  });

  it("test_create_unique_index", () => {
    const src = Buffer.from("CREATE UNIQUE INDEX ux_users_email ON users(email);\n", "utf-8");
    const [symbols] = sql_idx.extract(src, "schema.sql");
    const names = symbols.map((s) => s.name);
    expect(names).toContain("ux_users_email");
  });

  it("test_create_index_kind", () => {
    const src = Buffer.from("CREATE INDEX idx_orders_user ON orders(user_id);\n", "utf-8");
    const [symbols] = sql_idx.extract(src, "schema.sql");
    const kinds = new Set(symbols.filter((s) => s.name === "idx_orders_user").map((s) => s.kind));
    expect(kinds).toEqual(new Set(["sql_index"]));
  });

  it("test_create_index_if_not_exists", () => {
    const src = Buffer.from("CREATE INDEX IF NOT EXISTS idx_tmp ON tmp(col);\n", "utf-8");
    const [symbols] = sql_idx.extract(src, "schema.sql");
    const names = symbols.map((s) => s.name);
    expect(names).toContain("idx_tmp");
  });
});

describe("TestSqlTriggers", () => {
  it("test_create_trigger", () => {
    const src = Buffer.from(
      "CREATE TRIGGER trg_audit AFTER INSERT ON users FOR EACH ROW EXECUTE FUNCTION log_insert();\n",
      "utf-8",
    );
    const [symbols] = sql_idx.extract(src, "schema.sql");
    const names = symbols.map((s) => s.name);
    expect(names).toContain("trg_audit");
  });

  it("test_create_trigger_kind", () => {
    const src = Buffer.from(
      "CREATE TRIGGER trg_check BEFORE UPDATE ON orders FOR EACH ROW EXECUTE PROCEDURE validate();\n",
      "utf-8",
    );
    const [symbols] = sql_idx.extract(src, "schema.sql");
    const kinds = new Set(symbols.filter((s) => s.name === "trg_check").map((s) => s.kind));
    expect(kinds).toEqual(new Set(["sql_trigger"]));
  });
});

describe("TestSqlSections", () => {
  it("test_sections_match_symbols", () => {
    const src = Buffer.from("CREATE TABLE a (id INT);\nCREATE TABLE b (id INT);\n", "utf-8");
    const [symbols, _refs, _imps, sections] = sql_idx.extract(src, "schema.sql");
    const symNames = new Set(symbols.map((s) => s.name));
    const secNames = new Set(sections.map((s) => s.heading));
    expect(symNames).toEqual(secNames);
  });

  it("test_end_lines_assigned", () => {
    const src = Buffer.from("CREATE TABLE x (id INT);\nCREATE TABLE y (id INT);\n", "utf-8");
    const [, , , sections] = sql_idx.extract(src, "schema.sql");
    for (const sec of sections) {
      expect(sec.end_line).not.toBeNull();
    }
  });

  it("test_line_numbers_are_one_based", () => {
    const src = Buffer.from("-- migration\nCREATE TABLE tasks (id INT);\n", "utf-8");
    const [symbols] = sql_idx.extract(src, "schema.sql");
    const taskSym = symbols.find((s) => s.name === "tasks") ?? null;
    expect(taskSym).not.toBeNull();
    expect(taskSym!.line).toBe(2);
  });

  it("test_comment_stripped_no_false_positive", () => {
    // Table names inside SQL comments must not be extracted.
    const src = Buffer.from(
      "-- CREATE TABLE ghost (id INT);\nCREATE TABLE real_table (id INT);\n",
      "utf-8",
    );
    const [symbols] = sql_idx.extract(src, "schema.sql");
    const names = symbols.map((s) => s.name);
    expect(names).not.toContain("ghost");
    expect(names).toContain("real_table");
  });

  it("test_block_comment_stripped", () => {
    const src = Buffer.from(
      "/* CREATE TABLE ghost (id INT); */\nCREATE TABLE visible (id INT);\n",
      "utf-8",
    );
    const [symbols] = sql_idx.extract(src, "schema.sql");
    const names = symbols.map((s) => s.name);
    expect(names).not.toContain("ghost");
    expect(names).toContain("visible");
  });
});

describe("TestSqlEdgeCases", () => {
  it("test_empty_file", () => {
    const [symbols, _refs, _imps, sections] = sql_idx.extract(Buffer.from(""), "empty.sql");
    expect(symbols).toEqual([]);
    expect(sections).toEqual([]);
  });

  it("test_invalid_utf8_does_not_crash", () => {
    // b"CREATE TABLE bad\xff_name (id INT);\n" — raw octets with the invalid
    // 0xFF byte preserved exactly like Python's byte literal.
    const src = Buffer.from(
      "CREATE TABLE bad".split("").map((c) => c.charCodeAt(0))
        .concat([0xff])
        .concat("_name (id INT);\n".split("").map((c) => c.charCodeAt(0))),
    );
    const result = sql_idx.extract(src, "bad.sql");
    expect(result.length).toBe(4);
  });

  it("test_utf8_bom_on_first_symbol", () => {
    // A UTF-8 BOM prefix must not swallow the first CREATE TABLE.
    // Python: "﻿CREATE TABLE accounts (id INT);\n".encode() -> BOM is U+FEFF.
    const src = Buffer.from("﻿CREATE TABLE accounts (id INT);\n", "utf-8");
    const [symbols] = sql_idx.extract(src, "schema.sql");
    const names = symbols.map((s) => s.name);
    expect(names).toContain("accounts");
  });

  it("test_double_quoted_name", () => {
    const src = Buffer.from('CREATE TABLE "MyTable" (id INT);\n', "utf-8");
    const [symbols] = sql_idx.extract(src, "schema.sql");
    const names = symbols.map((s) => s.name);
    expect(names).toContain("MyTable");
  });

  it("test_backtick_quoted_name", () => {
    const src = Buffer.from("CREATE TABLE `my_table` (id INT);\n", "utf-8");
    const [symbols] = sql_idx.extract(src, "schema.sql");
    const names = symbols.map((s) => s.name);
    expect(names).toContain("my_table");
  });

  it("test_multiple_statements", () => {
    const src = Buffer.from(
      "CREATE TABLE users (id INT);\n" +
        "CREATE TABLE orders (id INT);\n" +
        "CREATE INDEX idx_orders ON orders(id);\n" +
        "CREATE VIEW active AS SELECT * FROM users;\n",
      "utf-8",
    );
    const [symbols] = sql_idx.extract(src, "schema.sql");
    const names = symbols.map((s) => s.name);
    expect(names).toContain("users");
    expect(names).toContain("orders");
    expect(names).toContain("idx_orders");
    expect(names).toContain("active");
  });
});

// ===========================================================================
// Integration: parser dispatch
// ===========================================================================

describe("TestParserDispatch", () => {
  // The parametrized cases from the Python test. Each is a tuple of
  // (filename, content, expected_lang, expected_symbol).
  const cases: ReadonlyArray<[string, string, string, string]> = [
    ["style.css", ".btn { color: red; }\n", "css", ".btn"],
    ["theme.scss", "@mixin flex-center { display: flex; }\n", "css", "@mixin flex-center"],
    ["schema.sql", "CREATE TABLE accounts (id INT);\n", "sql", "accounts"],
    ["styles.less", "#main { color: black; }\n", "css", "#main"],
  ];

  for (const [filename, content, expectedLang, expectedSymbol] of cases) {
    it(`test_extension_dispatches[${filename}]`, async () => {
      // canonicalize so the source path and the (canonicalized) project root
      // agree under macOS /var -> /private/var; else index_file skips it as
      // "not under project root".
      const root = canonicalize(tmpDir());
      const srcFile = path.join(root, filename);
      fs.writeFileSync(srcFile, content, "utf-8");
      const proj = projectFor(root);
      const result = await index_file(proj, srcFile);
      expect(result).not.toBeNull();
      expect(result!.language).toBe(expectedLang);
      const names = result!.symbols.map((s) => s.name);
      expect(names).toContain(expectedSymbol);
    });
  }
});
