/**
 * Unit tests for token_goat/hints — part 4/4 of the 1:1 port of
 * tests/test_hints.py.
 *
 * Covers the Python classes (source lines ~3658-5328):
 *   TestGetIndexedSymbolsNullEndLine, TestSurgicalIntentGuardOffsetZero,
 *   TestStructuredFileHintsNewTypes, TestStructuredHintSymbolInterpolation,
 *   TestCoreadSuggestions, TestHintPriorityOrdering, TestSlimHintText,
 *   TestTestFileHint, TestSha256Hex, TestMinSessionHintSavingsBytes.
 *
 * Each Python `def test_*` maps to a vitest `it()` with the SAME name and the
 * SAME assertion polarity; each Python class maps to a `describe()`.
 *
 * ReadHint API (per hints.ts header): Python `"x" in hint` → `hint.text.includes("x")`,
 * `hint.lower()` → `hint.text.toLowerCase()`, `str(hint)` → `hint.text`,
 * `hint.tokens_saved` → `hint.tokens_saved`, `hint.hint_priority`/`hint.text`
 * for HintItem. `apply_hint_priority_limit` returns plain strings.
 *
 * Indexing seam: the Python suite issues raw `db.open_project(h) as conn` SQL
 * INSERTs into files/symbols/imports_exports/projects. The TS port issues the
 * same SQL through the shipped db.ts callback API (db.openProject / db.openGlobal),
 * exactly as tests/test_read_replacement.test.ts builds its index rows.
 *
 * Per-test tmp data dir + cache clearing is handled by tests/setup.ts
 * (beforeEach → setDataDirOverride + clearModuleCaches), mirroring the Python
 * tmp_data_dir autouse fixture.
 *
 * DEFERRED (it.skip): the Python tests in TestStructuredHintSymbolInterpolation
 * and the two direct TestCoreadSuggestions tests monkeypatch or call
 * module-private functions that hints.ts does NOT export (and which internal
 * callers reference via local bindings, so a vi.spyOn could not be observed):
 * _lookup_top_indexed_symbol, _structured_read_or_outline, _get_unread_coread_files,
 * _build_coread_suggestion_hint, and the named-import find_project. Those are
 * skipped with a PORT note; the end-to-end coread tests (which drive the real DB
 * through build_read_hint) ARE ported.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type { Database as DatabaseType } from "better-sqlite3";

import {
  HINT_MAX_PER_TOOL_CALL,
  HINT_PRIORITY_CRITICAL,
  HINT_PRIORITY_HIGH,
  HINT_PRIORITY_LOW,
  HINT_PRIORITY_MEDIUM,
  HintItem,
  ReadHint,
  _get_indexed_symbols_and_line_count,
  _hint_fingerprint,
  _sanitize_hint_symbol,
  _sha256_hex,
  apply_hint_priority_limit,
  build_index_only_file_hint,
  build_read_hint,
  build_structured_file_hint,
  build_test_file_hint,
  slim_hint_text,
} from "../src/token_goat/hints.js";
import * as db from "../src/token_goat/db.js";
import * as session from "../src/token_goat/session.js";
import * as config from "../src/token_goat/config.js";
import { find_project, make_project_at } from "../src/token_goat/project.js";
import type { Project } from "../src/token_goat/project.js";
import {
  clearConfigPathOverride,
  setConfigPathOverride,
} from "../src/token_goat/paths.js";

// ---------------------------------------------------------------------------
// _SLIM_HINT_MAX_CHARS is a module-private constant in hints.ts (not exported).
// The TS impl pins it to 250 (`const _SLIM_HINT_MAX_CHARS = 250`); the two
// TestSlimHintText tests that reference it need the literal value, so it is
// mirrored here VERBATIM. (Reported in parity_notes.)
// ---------------------------------------------------------------------------
const _SLIM_HINT_MAX_CHARS = 250;

// ---------------------------------------------------------------------------
// tmp_path analogue: unique throwaway dir under the OS tmp root, cleaned up
// after each test (Python's function-scoped tmp_path fixture).
// ---------------------------------------------------------------------------
let _tmpCounter = 0;
const _tmpRoots: string[] = [];
function tmpPath(): string {
  // realpathSync resolves macOS's /var -> /private/var symlink to match find_project's
  // canonical project root (else the index-hint containment check fails).
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), `tg-h4-${process.pid}-${_tmpCounter++}-`)));
  _tmpRoots.push(dir);
  return dir;
}

afterEach(() => {
  while (_tmpRoots.length) {
    const d = _tmpRoots.pop()!;
    try {
      fs.rmSync(d, { recursive: true, force: true });
    } catch {
      // best-effort
    }
  }
});

/** make_project fixture analogue: canonicalize + hash a root via project.ts. */
function makeProject(root: string): Project {
  return make_project_at(root);
}

/** _make_file / _make_large_file helper: write `size` bytes of 'x' to name. */
function makeFile(dir: string, name: string, size: number): string {
  const p = path.join(dir, name);
  fs.writeFileSync(p, Buffer.alloc(size, "x"));
  return p;
}

// ===========================================================================
// TestGetIndexedSymbolsNullEndLine
// ===========================================================================

describe("TestGetIndexedSymbolsNullEndLine (port of tests/test_hints.py)", () => {
  it("test_null_end_line_rows_excluded_not_crash", () => {
    const proj_root = path.join(tmpPath(), "null_end_line_proj");
    fs.mkdirSync(proj_root, { recursive: true });
    const proj = makeProject(proj_root);

    const file_rel = "src/sample.py";

    db.openProject(proj.hash, (conn: DatabaseType) => {
      conn
        .prepare(
          "INSERT INTO files (rel_path, language, size, mtime, content_sha256, indexed_at)" +
            " VALUES (?, ?, ?, ?, ?, ?)",
        )
        .run(file_rel, "python", 100, 0.0, "abc123", 0);
      // Symbol with valid end_line — should be returned.
      conn
        .prepare(
          "INSERT INTO symbols (name, kind, file_rel, line, end_line, signature)" +
            " VALUES (?, ?, ?, ?, ?, ?)",
        )
        .run("good_func", "function", file_rel, 1, 10, "def good_func():");
      // Symbol with NULL end_line — must be silently excluded, not crash.
      conn
        .prepare(
          "INSERT INTO symbols (name, kind, file_rel, line, end_line, signature)" +
            " VALUES (?, ?, ?, ?, ?, ?)",
        )
        .run("stub_func", "function", file_rel, 12, null, "def stub_func():");
    });

    const [syms] = _get_indexed_symbols_and_line_count(file_rel, proj.hash);

    expect(syms.length).toBe(1); // only the non-NULL end_line symbol should be returned
    expect(syms[0]!.name).toBe("good_func");
  });
});

// ===========================================================================
// TestSurgicalIntentGuardOffsetZero
// ===========================================================================

describe("TestSurgicalIntentGuardOffsetZero", () => {
  function makeLargeFile(dir: string, name: string, size = 500_000): string {
    return makeFile(dir, name, size);
  }

  it("test_index_only_hint_suppressed_when_offset_zero_and_limit", () => {
    const large_lock = makeLargeFile(tmpPath(), "package-lock.json");
    // offset=0 with a limit — surgical intent; must NOT emit a hint.
    const result = build_index_only_file_hint({ file_path: large_lock, offset: 0, limit: 100 });
    expect(result).toBeNull(); // offset=0 + limit should suppress index-only hint
  });

  it("test_index_only_hint_emits_when_no_offset", () => {
    const large_lock = makeLargeFile(tmpPath(), "package-lock.json");
    // No offset — unsurgical read; may emit a hint.
    const result = build_index_only_file_hint({ file_path: large_lock, offset: null, limit: null });
    expect(result).not.toBeNull(); // no offset/limit should emit index-only hint for large lockfile
  });

  it("test_structured_hint_suppressed_when_offset_zero_and_limit", () => {
    const large_csv = makeLargeFile(tmpPath(), "data.csv");
    const result = build_structured_file_hint({ file_path: large_csv, offset: 0, limit: 50 });
    expect(result).toBeNull(); // offset=0 + limit should suppress structured-file hint
  });

  it("test_structured_hint_emits_when_no_offset", () => {
    const large_csv = makeLargeFile(tmpPath(), "data.csv");
    const result = build_structured_file_hint({ file_path: large_csv, offset: null, limit: null });
    expect(result).not.toBeNull(); // no offset/limit should emit structured-file hint for large CSV
  });
});

// ===========================================================================
// TestStructuredFileHintsNewTypes
// ===========================================================================

describe("TestStructuredFileHintsNewTypes", () => {
  // ── CSS / SCSS / Sass ──────────────────────────────────────────────────

  it("test_css_hint_fires_for_large_css_file", () => {
    const f = makeFile(tmpPath(), "styles.css", 15_000);
    const result = build_structured_file_hint({ file_path: f, offset: null, limit: null });
    expect(result).not.toBeNull();
    const text = String(result);
    expect(text.toLowerCase().includes("css")).toBe(true);
    expect(text.includes("token-goat")).toBe(true);
  });

  it("test_scss_hint_fires_for_large_scss_file", () => {
    const f = makeFile(tmpPath(), "app.scss", 12_000);
    const result = build_structured_file_hint({ file_path: f, offset: null, limit: null });
    expect(result).not.toBeNull();
    const text = String(result);
    expect(text.toLowerCase().includes("scss")).toBe(true);
  });

  it("test_sass_hint_fires_for_large_sass_file", () => {
    const f = makeFile(tmpPath(), "theme.sass", 11_000);
    const result = build_structured_file_hint({ file_path: f, offset: null, limit: null });
    expect(result).not.toBeNull();
    const text = String(result);
    expect(text.toLowerCase().includes("sass")).toBe(true);
  });

  it("test_css_hint_suppressed_for_small_file", () => {
    const f = makeFile(tmpPath(), "tiny.css", 500);
    const result = build_structured_file_hint({ file_path: f, offset: null, limit: null });
    expect(result).toBeNull();
  });

  it("test_css_hint_suppressed_when_surgical", () => {
    const f = makeFile(tmpPath(), "styles.css", 20_000);
    const result = build_structured_file_hint({ file_path: f, offset: 0, limit: 100 });
    expect(result).toBeNull();
  });

  it("test_css_hint_suggests_surgical_recall", () => {
    const f = makeFile(tmpPath(), "main.css", 15_000);
    const result = build_structured_file_hint({ file_path: f, offset: null, limit: null });
    expect(result).not.toBeNull();
    const text = String(result).toLowerCase();
    expect(text.includes("token-goat section") || text.includes("token-goat read")).toBe(true);
    expect(text.includes("token-goat outline")).toBe(false);
    expect(text.includes("::.class-name")).toBe(false);
  });

  // ── SQL ────────────────────────────────────────────────────────────────

  it("test_sql_hint_fires_for_large_sql_file", () => {
    const f = makeFile(tmpPath(), "schema.sql", 8_000);
    const result = build_structured_file_hint({ file_path: f, offset: null, limit: null });
    expect(result).not.toBeNull();
    const text = String(result);
    expect(text.toLowerCase().includes("sql")).toBe(true);
    expect(text.includes("token-goat")).toBe(true);
  });

  it("test_sql_hint_suppressed_for_small_file", () => {
    const f = makeFile(tmpPath(), "tiny.sql", 200);
    const result = build_structured_file_hint({ file_path: f, offset: null, limit: null });
    expect(result).toBeNull();
  });

  it("test_sql_hint_suppressed_when_surgical", () => {
    const f = makeFile(tmpPath(), "migrations.sql", 10_000);
    const result = build_structured_file_hint({ file_path: f, offset: 0, limit: 50 });
    expect(result).toBeNull();
  });

  // ── GraphQL ────────────────────────────────────────────────────────────

  it("test_graphql_hint_fires_for_large_graphql_file", () => {
    const f = makeFile(tmpPath(), "schema.graphql", 3_000);
    const result = build_structured_file_hint({ file_path: f, offset: null, limit: null });
    expect(result).not.toBeNull();
    const text = String(result);
    expect(text.toLowerCase().includes("graphql")).toBe(true);
    expect(text.includes("token-goat")).toBe(true);
  });

  it("test_gql_hint_fires_for_large_gql_file", () => {
    const f = makeFile(tmpPath(), "queries.gql", 2_500);
    const result = build_structured_file_hint({ file_path: f, offset: null, limit: null });
    expect(result).not.toBeNull();
    const text = String(result);
    expect(text.toLowerCase().includes("graphql")).toBe(true);
  });

  it("test_graphql_hint_suppressed_for_small_file", () => {
    const f = makeFile(tmpPath(), "tiny.graphql", 100);
    const result = build_structured_file_hint({ file_path: f, offset: null, limit: null });
    expect(result).toBeNull();
  });

  it("test_graphql_hint_suppressed_when_surgical", () => {
    const f = makeFile(tmpPath(), "schema.graphql", 5_000);
    const result = build_structured_file_hint({ file_path: f, offset: 10, limit: 30 });
    expect(result).toBeNull();
  });

  // ── Protocol Buffers ───────────────────────────────────────────────────

  it("test_proto_hint_fires_for_large_proto_file", () => {
    const f = makeFile(tmpPath(), "service.proto", 3_000);
    const result = build_structured_file_hint({ file_path: f, offset: null, limit: null });
    expect(result).not.toBeNull();
    const text = String(result);
    expect(text.toLowerCase().includes("proto")).toBe(true);
    expect(text.includes("token-goat")).toBe(true);
  });

  it("test_proto_hint_suppressed_for_small_file", () => {
    const f = makeFile(tmpPath(), "tiny.proto", 100);
    const result = build_structured_file_hint({ file_path: f, offset: null, limit: null });
    expect(result).toBeNull();
  });

  it("test_proto_hint_suppressed_when_surgical", () => {
    const f = makeFile(tmpPath(), "api.proto", 4_000);
    const result = build_structured_file_hint({ file_path: f, offset: 0, limit: 25 });
    expect(result).toBeNull();
  });

  // ── .env files ─────────────────────────────────────────────────────────

  it("test_env_hint_fires_for_env_file", () => {
    const f = makeFile(tmpPath(), ".env", 1_000);
    const result = build_structured_file_hint({ file_path: f, offset: null, limit: null });
    expect(result).not.toBeNull();
    const text = String(result);
    expect(text.toLowerCase().includes("env")).toBe(true);
    expect(text.includes("token-goat")).toBe(true);
  });

  it("test_env_example_hint_fires", () => {
    const f = makeFile(tmpPath(), ".env.example", 800);
    const result = build_structured_file_hint({ file_path: f, offset: null, limit: null });
    expect(result).not.toBeNull();
  });

  it("test_env_local_hint_fires", () => {
    const f = makeFile(tmpPath(), ".env.local", 600);
    const result = build_structured_file_hint({ file_path: f, offset: null, limit: null });
    expect(result).not.toBeNull();
  });

  it("test_env_hint_suppressed_for_tiny_file", () => {
    const f = makeFile(tmpPath(), ".env", 100);
    const result = build_structured_file_hint({ file_path: f, offset: null, limit: null });
    expect(result).toBeNull();
  });

  it("test_env_hint_suppressed_when_surgical", () => {
    const f = makeFile(tmpPath(), ".env", 2_000);
    const result = build_structured_file_hint({ file_path: f, offset: 0, limit: 20 });
    expect(result).toBeNull();
  });

  it("test_env_hint_suggests_variable_lookup", () => {
    const f = makeFile(tmpPath(), ".env.example", 1_500);
    const result = build_structured_file_hint({ file_path: f, offset: null, limit: null });
    expect(result).not.toBeNull();
    const text = String(result).toLowerCase();
    expect(text.includes("outline") || text.includes("grep") || text.includes("variable")).toBe(
      true,
    );
    expect(text.includes("::var_name")).toBe(false);
  });

  // ── Makefile ───────────────────────────────────────────────────────────

  it("test_makefile_hint_fires", () => {
    const f = makeFile(tmpPath(), "Makefile", 2_000);
    const result = build_structured_file_hint({ file_path: f, offset: null, limit: null });
    expect(result).not.toBeNull();
    const text = String(result);
    expect(text.toLowerCase().includes("makefile") || text.toLowerCase().includes("target")).toBe(
      true,
    );
    expect(text.includes("token-goat")).toBe(true);
  });

  it("test_gnumakefile_hint_fires", () => {
    const f = makeFile(tmpPath(), "GNUmakefile", 1_500);
    const result = build_structured_file_hint({ file_path: f, offset: null, limit: null });
    expect(result).not.toBeNull();
  });

  it("test_makefile_hint_suppressed_for_tiny_file", () => {
    const f = makeFile(tmpPath(), "Makefile", 200);
    const result = build_structured_file_hint({ file_path: f, offset: null, limit: null });
    expect(result).toBeNull();
  });

  it("test_makefile_hint_suppressed_when_surgical", () => {
    const f = makeFile(tmpPath(), "Makefile", 3_000);
    const result = build_structured_file_hint({ file_path: f, offset: 5, limit: 30 });
    expect(result).toBeNull();
  });

  // ── Regression: legacy types still work correctly ──────────────────────

  it("test_legacy_csv_still_fires", () => {
    const f = makeFile(tmpPath(), "data.csv", 100_000);
    const result = build_structured_file_hint({ file_path: f, offset: null, limit: null });
    expect(result).not.toBeNull();
  });

  it("test_legacy_yaml_still_fires", () => {
    const f = makeFile(tmpPath(), "config.yaml", 60_000);
    const result = build_structured_file_hint({ file_path: f, offset: null, limit: null });
    expect(result).not.toBeNull();
  });

  it("test_unknown_extension_still_silent", () => {
    const f = makeFile(tmpPath(), "data.xyz", 500_000);
    const result = build_structured_file_hint({ file_path: f, offset: null, limit: null });
    expect(result).toBeNull();
  });
});

// ===========================================================================
// TestStructuredHintSymbolInterpolation
// ===========================================================================

describe("TestStructuredHintSymbolInterpolation", () => {
  it.skip("test_interpolates_real_symbol_for_each_type", () => {
    // PORT: deferred — monkeypatches hints._lookup_top_indexed_symbol, a
    // module-private function hints.ts does not export (internal callers use the
    // local binding, so a vi.spyOn could not be observed).
  });

  it.skip("test_fallback_command_when_no_symbol", () => {
    // PORT: deferred — monkeypatches the non-exported hints._lookup_top_indexed_symbol.
  });

  it.skip("test_symbol_name_double_quote_rendered_safely", () => {
    // PORT: deferred — monkeypatches the non-exported named-import hints.find_project
    // and hints._get_indexed_symbols_and_line_count via the local binding.
  });

  it("test_sanitize_hint_symbol_neutralises_double_quotes", () => {
    expect(_sanitize_hint_symbol('[type="submit"]')).toBe("[type='submit']");
    // Newline/CR stripping is inherited from _sanitize_hint_path.
    const out = _sanitize_hint_symbol('a"b\nc\rd');
    expect(out.includes('"')).toBe(false);
    expect(out.includes("\n")).toBe(false);
    expect(out.includes("\r")).toBe(false);
  });

  it.skip("test_structured_read_or_outline_section_fallback", () => {
    // PORT: deferred — calls the non-exported hints._structured_read_or_outline.
  });

  it.skip("test_structured_read_or_outline_outline_fallback_is_default", () => {
    // PORT: deferred — calls the non-exported hints._structured_read_or_outline.
  });

  it.skip("test_lookup_returns_top_symbol", () => {
    // PORT: deferred — calls the non-exported hints._lookup_top_indexed_symbol.
  });

  it.skip("test_lookup_sanitizes_newline_in_rel_path", () => {
    // PORT: deferred — calls the non-exported hints._lookup_top_indexed_symbol.
  });

  it.skip("test_lookup_returns_none_when_no_symbols", () => {
    // PORT: deferred — calls the non-exported hints._lookup_top_indexed_symbol.
  });

  it.skip("test_lookup_returns_none_for_relative_path", () => {
    // PORT: deferred — calls the non-exported hints._lookup_top_indexed_symbol.
  });

  it.skip("test_lookup_returns_none_when_no_project", () => {
    // PORT: deferred — calls the non-exported hints._lookup_top_indexed_symbol.
  });

  it.skip("test_lookup_returns_none_when_file_outside_project_root", () => {
    // PORT: deferred — calls the non-exported hints._lookup_top_indexed_symbol.
  });
});

// ===========================================================================
// TestCoreadSuggestions
// ===========================================================================

describe("TestCoreadSuggestions", () => {
  it.skip("test_coread_hint_uses_real_top_symbol", () => {
    // PORT: deferred — monkeypatches the non-exported hints._get_unread_coread_files
    // and calls the non-exported hints._build_coread_suggestion_hint.
  });

  it.skip("test_coread_hint_falls_back_to_outline_without_indexed_symbol", () => {
    // PORT: deferred — monkeypatches the non-exported hints._get_unread_coread_files
    // and calls the non-exported hints._build_coread_suggestion_hint.
  });

  it("test_coread_hint_fires_on_first_read_of_py_file", () => {
    const root = tmpPath();
    fs.mkdirSync(path.join(root, ".git"), { recursive: true });

    const src_file = path.join(root, "auth.py");
    const session_file = path.join(root, "session.py");
    fs.writeFileSync(src_file, "# auth module\ndef login(): pass\n", "utf8");
    fs.writeFileSync(session_file, "# session module\nclass SessionCache: pass\n", "utf8");

    const proj = find_project(root);
    expect(proj).not.toBeNull();

    db.openProject(proj!.hash, (conn: DatabaseType) => {
      conn
        .prepare(
          "INSERT INTO files (rel_path, language, size, mtime, content_sha256, indexed_at) " +
            "VALUES (?, ?, ?, ?, ?, ?)",
        )
        .run("auth.py", "python", 100, 0.0, "abc123", 0);
      conn
        .prepare(
          "INSERT INTO files (rel_path, language, size, mtime, content_sha256, indexed_at) " +
            "VALUES (?, ?, ?, ?, ?, ?)",
        )
        .run("session.py", "python", 50, 0.0, "def456", 0);
      conn
        .prepare("INSERT INTO imports_exports (file_rel, kind, target, line) VALUES (?, ?, ?, ?)")
        .run("auth.py", "import", "session", 1);
      conn
        .prepare("INSERT INTO symbols (name, kind, file_rel, line, end_line) VALUES (?, ?, ?, ?, ?)")
        .run("SessionCache", "class", "session.py", 2, 2);
    });

    const hint = build_read_hint({
      session_id: "s_coread_1",
      file_path: src_file,
      offset: null,
      limit: null,
      cwd: root,
    });

    expect(hint).not.toBeNull();
    expect(String(hint).toLowerCase().includes("session")).toBe(true);
    expect(String(hint).includes('token-goat read "session.py::SessionCache"')).toBe(true);
    expect(String(hint).includes("::ClassName")).toBe(false);
  });

  it("test_coread_hint_not_fired_on_cached_file", () => {
    const root = tmpPath();
    fs.mkdirSync(path.join(root, ".git"), { recursive: true });

    const src_file = path.join(root, "auth.py");
    const session_file = path.join(root, "session.py");
    fs.writeFileSync(src_file, "# auth\nimport session\n", "utf8");
    fs.writeFileSync(session_file, "# session\n", "utf8");

    const proj = find_project(root);
    expect(proj).not.toBeNull();

    db.openProject(proj!.hash, (conn: DatabaseType) => {
      conn
        .prepare(
          "INSERT INTO files (rel_path, language, size, mtime, content_sha256, indexed_at) " +
            "VALUES (?, ?, ?, ?, ?, ?)",
        )
        .run("auth.py", "python", 50, 0.0, "abc123", 0);
      conn
        .prepare(
          "INSERT INTO files (rel_path, language, size, mtime, content_sha256, indexed_at) " +
            "VALUES (?, ?, ?, ?, ?, ?)",
        )
        .run("session.py", "python", 50, 0.0, "def456", 0);
      conn
        .prepare("INSERT INTO imports_exports (file_rel, kind, target, line) VALUES (?, ?, ?, ?)")
        .run("auth.py", "import", "session", 1);
    });

    // Mark the file as already read in session.
    const session_id = "s_coread_cached";
    session.mark_file_read(session_id, src_file, 0, 100);

    const hint = build_read_hint({
      session_id,
      file_path: src_file,
      offset: null,
      limit: null,
      cwd: root,
    });

    // If there's a hint, it should be a cache hint (already-read), not coread.
    if (hint !== null) {
      expect(
        !String(hint).toLowerCase().includes("session") ||
          String(hint).toLowerCase().includes("already read"),
      ).toBe(true);
    }
  });

  it("test_coread_hint_not_fired_for_non_py_files", () => {
    const root = tmpPath();
    const src_file = path.join(root, "config.toml");
    fs.writeFileSync(src_file, "[project]\nname = 'test'\n", "utf8");

    const hint = build_read_hint({
      session_id: "s_coread_toml",
      file_path: src_file,
      offset: null,
      limit: null,
      cwd: root,
    });

    // No hint expected for TOML files.
    expect(hint === null || !String(hint).toLowerCase().includes("import")).toBe(true);
  });

  it("test_coread_hint_suppressed_when_all_imports_read", () => {
    const root = tmpPath();
    fs.mkdirSync(path.join(root, ".git"), { recursive: true });

    const src_file = path.join(root, "auth.py");
    const session_file = path.join(root, "session.py");
    fs.writeFileSync(src_file, "import session\n", "utf8");
    fs.writeFileSync(session_file, "class Session: pass\n", "utf8");

    const proj = find_project(root);
    expect(proj).not.toBeNull();

    db.openProject(proj!.hash, (conn: DatabaseType) => {
      conn
        .prepare(
          "INSERT INTO files (rel_path, language, size, mtime, content_sha256, indexed_at) " +
            "VALUES (?, ?, ?, ?, ?, ?)",
        )
        .run("auth.py", "python", 50, 0.0, "abc123", 0);
      conn
        .prepare(
          "INSERT INTO files (rel_path, language, size, mtime, content_sha256, indexed_at) " +
            "VALUES (?, ?, ?, ?, ?, ?)",
        )
        .run("session.py", "python", 50, 0.0, "def456", 0);
      conn
        .prepare("INSERT INTO imports_exports (file_rel, kind, target, line) VALUES (?, ?, ?, ?)")
        .run("auth.py", "import", "session", 1);
    });

    const session_id = "s_coread_all_read";
    // Mark both files as read.
    session.mark_file_read(session_id, src_file, 0, 100);
    session.mark_file_read(session_id, session_file, 0, 50);

    const hint = build_read_hint({
      session_id,
      file_path: src_file,
      offset: null,
      limit: null,
      cwd: root,
    });

    // Cache hint expected, not coread suggestion.
    if (hint !== null) {
      expect(
        !String(hint).toLowerCase().includes("session") ||
          String(hint).toLowerCase().includes("already"),
      ).toBe(true);
    }
  });

  it("test_coread_hint_limits_to_three_suggestions", () => {
    const root = tmpPath();
    fs.mkdirSync(path.join(root, ".git"), { recursive: true });

    const src_file = path.join(root, "main.py");
    fs.writeFileSync(src_file, "import a, b, c, d, e\n", "utf8");

    const proj = find_project(root);
    expect(proj).not.toBeNull();

    db.openProject(proj!.hash, (conn: DatabaseType) => {
      conn
        .prepare(
          "INSERT INTO files (rel_path, language, size, mtime, content_sha256, indexed_at) " +
            "VALUES (?, ?, ?, ?, ?, ?)",
        )
        .run("main.py", "python", 50, 0.0, "abc123", 0);
      // Insert 5 imported modules.
      for (const mod of ["a", "b", "c", "d", "e"]) {
        conn
          .prepare(
            "INSERT INTO files (rel_path, language, size, mtime, content_sha256, indexed_at) " +
              "VALUES (?, ?, ?, ?, ?, ?)",
          )
          .run(`${mod}.py`, "python", 20, 0.0, `sha_${mod}`, 0);
        conn
          .prepare("INSERT INTO imports_exports (file_rel, kind, target, line) VALUES (?, ?, ?, ?)")
          .run("main.py", "import", mod, 1);
      }
    });

    const hint = build_read_hint({
      session_id: "s_coread_limit",
      file_path: src_file,
      offset: null,
      limit: null,
      cwd: root,
    });

    // Should get hint with max 3 suggestions.
    if (hint !== null) {
      const hint_str = String(hint);
      expect(hint_str.includes("(unread)")).toBe(true);
      const parts = hint_str.split("imports");
      if (parts.length >= 2) {
        const suggestion_part = parts[1]!.split("(unread)")[0]!;
        // Count occurrences of ".py" which marks each module name.
        const module_count = (suggestion_part.match(/\.py/g) ?? []).length;
        expect(module_count).toBeLessThanOrEqual(3);
      }
    }
  });

  it.skip("test_coread_hint_not_fired_without_project", () => {
    // PORT: deferred — patches the non-exported named-import hints.find_project
    // (return_value=None); the local binding cannot be observed by vi.spyOn.
  });

  it("test_coread_hint_ts_relative_import", () => {
    const root = tmpPath();
    fs.mkdirSync(path.join(root, ".git"), { recursive: true });
    const src_dir = path.join(root, "src", "components");
    fs.mkdirSync(src_dir, { recursive: true });

    const button_file = path.join(src_dir, "Button.tsx");
    const styles_file = path.join(src_dir, "styles.ts");
    fs.writeFileSync(
      button_file,
      "import styles from './styles';\nexport const Button = () => null;\n",
      "utf8",
    );
    fs.writeFileSync(styles_file, "export const cls = 'btn';\n", "utf8");

    const proj = find_project(root);
    expect(proj).not.toBeNull();

    db.openProject(proj!.hash, (conn: DatabaseType) => {
      conn
        .prepare(
          "INSERT INTO files (rel_path, language, size, mtime, content_sha256, indexed_at) VALUES (?, ?, ?, ?, ?, ?)",
        )
        .run("src/components/Button.tsx", "typescript", 80, 0.0, "sha_btn", 0);
      conn
        .prepare(
          "INSERT INTO files (rel_path, language, size, mtime, content_sha256, indexed_at) VALUES (?, ?, ?, ?, ?, ?)",
        )
        .run("src/components/styles.ts", "typescript", 30, 0.0, "sha_sty", 0);
      conn
        .prepare("INSERT INTO imports_exports (file_rel, kind, target, line) VALUES (?, ?, ?, ?)")
        .run("src/components/Button.tsx", "import", "./styles", 1);
      conn
        .prepare("INSERT INTO symbols (name, kind, file_rel, line, end_line) VALUES (?, ?, ?, ?, ?)")
        .run("cls", "constant", "src/components/styles.ts", 1, 1);
    });

    const hint = build_read_hint({
      session_id: "s_coread_ts_rel",
      file_path: button_file,
      offset: null,
      limit: null,
      cwd: root,
    });

    expect(hint).not.toBeNull();
    expect(String(hint).includes("styles.ts")).toBe(true);
    expect(String(hint).includes('token-goat read "src/components/styles.ts::cls"')).toBe(true);
    expect(String(hint).includes("::ClassName")).toBe(false);
  });

  it("test_coread_hint_ts_external_import_excluded", () => {
    const root = tmpPath();
    fs.mkdirSync(path.join(root, ".git"), { recursive: true });
    const src_file = path.join(root, "App.tsx");
    fs.writeFileSync(
      src_file,
      "import React from 'react';\nimport { useState } from 'react';\n",
      "utf8",
    );

    const proj = find_project(root);
    expect(proj).not.toBeNull();

    db.openProject(proj!.hash, (conn: DatabaseType) => {
      conn
        .prepare(
          "INSERT INTO files (rel_path, language, size, mtime, content_sha256, indexed_at) VALUES (?, ?, ?, ?, ?, ?)",
        )
        .run("App.tsx", "typescript", 80, 0.0, "sha_app", 0);
      conn
        .prepare("INSERT INTO imports_exports (file_rel, kind, target, line) VALUES (?, ?, ?, ?)")
        .run("App.tsx", "import", "react", 1);
    });

    const hint = build_read_hint({
      session_id: "s_coread_ts_ext",
      file_path: src_file,
      offset: null,
      limit: null,
      cwd: root,
    });

    expect(hint === null || !String(hint).toLowerCase().includes("react")).toBe(true);
  });

  it("test_coread_hint_ts_parent_relative_import", () => {
    const root = tmpPath();
    fs.mkdirSync(path.join(root, ".git"), { recursive: true });
    const src_dir = path.join(root, "src", "components");
    const utils_dir = path.join(root, "src");
    fs.mkdirSync(src_dir, { recursive: true });

    const btn_file = path.join(src_dir, "Button.tsx");
    const utils_file = path.join(utils_dir, "utils.ts");
    fs.writeFileSync(btn_file, "import { cn } from '../utils';\n", "utf8");
    fs.writeFileSync(utils_file, "export const cn = () => '';\n", "utf8");

    const proj = find_project(root);
    expect(proj).not.toBeNull();

    db.openProject(proj!.hash, (conn: DatabaseType) => {
      conn
        .prepare(
          "INSERT INTO files (rel_path, language, size, mtime, content_sha256, indexed_at) VALUES (?, ?, ?, ?, ?, ?)",
        )
        .run("src/components/Button.tsx", "typescript", 50, 0.0, "sha_btn2", 0);
      conn
        .prepare(
          "INSERT INTO files (rel_path, language, size, mtime, content_sha256, indexed_at) VALUES (?, ?, ?, ?, ?, ?)",
        )
        .run("src/utils.ts", "typescript", 30, 0.0, "sha_utils", 0);
      conn
        .prepare("INSERT INTO imports_exports (file_rel, kind, target, line) VALUES (?, ?, ?, ?)")
        .run("src/components/Button.tsx", "import", "../utils", 1);
    });

    const hint = build_read_hint({
      session_id: "s_coread_ts_parent",
      file_path: btn_file,
      offset: null,
      limit: null,
      cwd: root,
    });

    expect(hint).not.toBeNull();
    expect(String(hint).includes("utils.ts")).toBe(true);
  });

  it("test_coread_hint_go_intramodule_import", () => {
    const root = tmpPath();
    fs.mkdirSync(path.join(root, ".git"), { recursive: true });
    fs.writeFileSync(path.join(root, "go.mod"), "module github.com/myorg/myapp\n\ngo 1.21\n", "utf8");

    const main_file = path.join(root, "main.go");
    const cache_dir = path.join(root, "internal", "cache");
    fs.mkdirSync(cache_dir, { recursive: true });
    const cache_file = path.join(cache_dir, "cache.go");
    fs.writeFileSync(
      main_file,
      'package main\nimport "github.com/myorg/myapp/internal/cache"\n',
      "utf8",
    );
    fs.writeFileSync(cache_file, "package cache\n", "utf8");

    const proj = find_project(root);
    expect(proj).not.toBeNull();

    // Register project root in global DB so _get_go_module_prefix can find it.
    const now = Math.trunc(Date.now() / 1000);
    db.openGlobal((g_conn: DatabaseType) => {
      g_conn
        .prepare(
          "INSERT INTO projects (hash, root, marker, first_seen, last_seen) VALUES (?, ?, ?, ?, ?) " +
            "ON CONFLICT(hash) DO UPDATE SET root=excluded.root",
        )
        .run(proj!.hash, root, "git", now, now);
    });
    db.openProject(proj!.hash, (conn: DatabaseType) => {
      conn
        .prepare(
          "INSERT INTO files (rel_path, language, size, mtime, content_sha256, indexed_at) VALUES (?, ?, ?, ?, ?, ?)",
        )
        .run("main.go", "go", 80, 0.0, "sha_main", 0);
      conn
        .prepare(
          "INSERT INTO files (rel_path, language, size, mtime, content_sha256, indexed_at) VALUES (?, ?, ?, ?, ?, ?)",
        )
        .run("internal/cache/cache.go", "go", 30, 0.0, "sha_cache", 0);
      conn
        .prepare("INSERT INTO imports_exports (file_rel, kind, target, line) VALUES (?, ?, ?, ?)")
        .run("main.go", "import", "github.com/myorg/myapp/internal/cache", 2);
      conn
        .prepare("INSERT INTO symbols (name, kind, file_rel, line, end_line) VALUES (?, ?, ?, ?, ?)")
        .run("New", "function", "internal/cache/cache.go", 1, 1);
    });

    const hint = build_read_hint({
      session_id: "s_coread_go_mod",
      file_path: main_file,
      offset: null,
      limit: null,
      cwd: root,
    });

    expect(hint).not.toBeNull();
    expect(String(hint).toLowerCase().includes("cache")).toBe(true);
    expect(String(hint).includes('token-goat read "internal/cache/cache.go::New"')).toBe(true);
    expect(String(hint).includes("::ClassName")).toBe(false);
  });

  it("test_coread_hint_go_stdlib_excluded", () => {
    const root = tmpPath();
    fs.mkdirSync(path.join(root, ".git"), { recursive: true });
    fs.writeFileSync(path.join(root, "go.mod"), "module github.com/myorg/myapp\n\ngo 1.21\n", "utf8");

    const main_file = path.join(root, "main.go");
    fs.writeFileSync(main_file, 'package main\nimport "fmt"\n', "utf8");

    const proj = find_project(root);
    expect(proj).not.toBeNull();

    const now = Math.trunc(Date.now() / 1000);
    db.openGlobal((g_conn: DatabaseType) => {
      g_conn
        .prepare(
          "INSERT INTO projects (hash, root, marker, first_seen, last_seen) VALUES (?, ?, ?, ?, ?) " +
            "ON CONFLICT(hash) DO UPDATE SET root=excluded.root",
        )
        .run(proj!.hash, root, "git", now, now);
    });
    db.openProject(proj!.hash, (conn: DatabaseType) => {
      conn
        .prepare(
          "INSERT INTO files (rel_path, language, size, mtime, content_sha256, indexed_at) VALUES (?, ?, ?, ?, ?, ?)",
        )
        .run("main.go", "go", 40, 0.0, "sha_main2", 0);
      conn
        .prepare("INSERT INTO imports_exports (file_rel, kind, target, line) VALUES (?, ?, ?, ?)")
        .run("main.go", "import", "fmt", 2);
    });

    const hint = build_read_hint({
      session_id: "s_coread_go_std",
      file_path: main_file,
      offset: null,
      limit: null,
      cwd: root,
    });

    expect(hint === null || !String(hint).toLowerCase().includes("fmt")).toBe(true);
  });
});

// ===========================================================================
// TestHintPriorityOrdering
// ===========================================================================

describe("TestHintPriorityOrdering", () => {
  it("test_priority_constants_ordered", () => {
    expect(HINT_PRIORITY_CRITICAL < HINT_PRIORITY_HIGH).toBe(true);
    expect(HINT_PRIORITY_HIGH < HINT_PRIORITY_MEDIUM).toBe(true);
    expect(HINT_PRIORITY_MEDIUM < HINT_PRIORITY_LOW).toBe(true);
  });

  it("test_empty_list_returns_empty", () => {
    expect(apply_hint_priority_limit([])).toEqual([]);
  });

  it("test_single_hint_returned_as_is", () => {
    const items = [new HintItem("only hint", HINT_PRIORITY_MEDIUM)];
    const result = apply_hint_priority_limit(items);
    expect(result).toEqual(["only hint"]);
  });

  it("test_sorts_by_priority_ascending", () => {
    const items = [
      new HintItem("low hint", HINT_PRIORITY_LOW),
      new HintItem("medium hint", HINT_PRIORITY_MEDIUM),
      new HintItem("critical hint", HINT_PRIORITY_CRITICAL),
      new HintItem("high hint", HINT_PRIORITY_HIGH),
    ];
    const result = apply_hint_priority_limit(items, 10);
    expect(result[0]).toBe("critical hint");
    expect(result[1]).toBe("high hint");
    expect(result[2]).toBe("medium hint");
    expect(result[3]).toBe("low hint");
  });

  it("test_max_hints_cap_drops_lowest_priority", () => {
    const items = [
      new HintItem("low hint", HINT_PRIORITY_LOW),
      new HintItem("critical hint", HINT_PRIORITY_CRITICAL),
      new HintItem("medium hint", HINT_PRIORITY_MEDIUM),
      new HintItem("high hint", HINT_PRIORITY_HIGH),
    ];
    const result = apply_hint_priority_limit(items, 3);
    // Should get the 3 highest-priority hints: CRITICAL, HIGH, MEDIUM.
    expect(result.length).toBe(3);
    expect(result[0]).toBe("critical hint");
    expect(result[1]).toBe("high hint");
    // The last emitted hint gets the suppression footer.
    expect(result[2]!.includes("medium hint")).toBe(true);
    expect(result[2]!.includes("+1 more hints suppressed")).toBe(true);
  });

  it("test_suppression_footer_appended_to_last_emitted", () => {
    const items = [
      new HintItem("hint A", HINT_PRIORITY_CRITICAL),
      new HintItem("hint B", HINT_PRIORITY_MEDIUM),
      new HintItem("hint C", HINT_PRIORITY_LOW),
      new HintItem("hint D", HINT_PRIORITY_LOW),
    ];
    const result = apply_hint_priority_limit(items, 2);
    expect(result.length).toBe(2);
    expect(result[0]).toBe("hint A");
    // Footer mentions 2 suppressed hints (C and D).
    expect(result[1]!.includes("+2 more hints suppressed")).toBe(true);
  });

  it("test_no_footer_when_at_or_under_cap", () => {
    const items = [
      new HintItem("hint A", HINT_PRIORITY_CRITICAL),
      new HintItem("hint B", HINT_PRIORITY_HIGH),
      new HintItem("hint C", HINT_PRIORITY_MEDIUM),
    ];
    const result = apply_hint_priority_limit(items, 3);
    expect(result.length).toBe(3);
    for (const text of result) {
      expect(text.includes("suppressed")).toBe(false);
    }
  });

  it("test_stable_sort_within_same_priority", () => {
    const items = [
      new HintItem("first medium", HINT_PRIORITY_MEDIUM),
      new HintItem("second medium", HINT_PRIORITY_MEDIUM),
      new HintItem("third medium", HINT_PRIORITY_MEDIUM),
    ];
    const result = apply_hint_priority_limit(items, 10);
    expect(result).toEqual(["first medium", "second medium", "third medium"]);
  });

  it("test_hint_item_has_priority_attribute", () => {
    const item = new HintItem("diff hint", HINT_PRIORITY_HIGH);
    expect(item.hint_priority).toBe(HINT_PRIORITY_HIGH);
    expect(item.text).toBe("diff hint");
  });

  it("test_default_max_is_hint_max_per_tool_call", () => {
    // Create more hints than the cap.
    const items = Array.from(
      { length: HINT_MAX_PER_TOOL_CALL + 2 },
      (_, i) => new HintItem(`hint ${i}`, HINT_PRIORITY_LOW),
    );
    const result = apply_hint_priority_limit(items);
    expect(result.length).toBe(HINT_MAX_PER_TOOL_CALL);
    // Last emitted hint should carry the suppression footer.
    expect(result[result.length - 1]!.includes("suppressed")).toBe(true);
  });
});

// ===========================================================================
// TestSlimHintText
// ===========================================================================

describe("TestSlimHintText", () => {
  it("test_cool_tier_unchanged", () => {
    const text = "Line one.\n\nParagraph two detail.";
    expect(slim_hint_text(text, "cool")).toBe(text);
  });

  it("test_warm_tier_unchanged", () => {
    const text = "Line one.\n\nParagraph two detail.";
    expect(slim_hint_text(text, "warm")).toBe(text);
  });

  it("test_hot_keeps_first_paragraph", () => {
    const text = "Actionable line here.\n\nVerbose explanation that costs tokens.";
    expect(slim_hint_text(text, "hot")).toBe("Actionable line here.");
  });

  it("test_critical_keeps_first_paragraph", () => {
    const text = "`foo.py` read 4x — use `token-goat outline foo.py`.\n\nExtra detail.";
    const result = slim_hint_text(text, "critical");
    expect(result.includes("Extra detail")).toBe(false);
    expect(result.includes("token-goat outline")).toBe(true);
  });

  it("test_single_paragraph_unchanged_at_hot", () => {
    const text = "Single-para hint with no blank lines.";
    expect(slim_hint_text(text, "hot")).toBe(text);
  });

  it("test_long_multiline_first_paragraph_truncated_with_ellipsis", () => {
    // Only multi-line first paras hit the char cap; single-line are exempt.
    const long_line = "x".repeat(_SLIM_HINT_MAX_CHARS + 50);
    const multi_para_text = `${long_line}\nmore text in same paragraph`;
    const result = slim_hint_text(multi_para_text, "hot");
    expect(result.endsWith("…")).toBe(true);
    expect(result.length).toBeLessThanOrEqual(_SLIM_HINT_MAX_CHARS + 1); // +1 for the ellipsis char
  });

  it("test_single_line_first_paragraph_not_capped", () => {
    // Single-line first paragraphs are command lines — never char-capped.
    const long_cmd = "`" + "a".repeat(_SLIM_HINT_MAX_CHARS + 100) + "` for surgical access.";
    const text = long_cmd + "\n\nParagraph two detail.";
    const result = slim_hint_text(text, "hot");
    expect(result.endsWith("…")).toBe(false); // command should not be truncated
    expect(result).toBe(long_cmd);
  });

  it("test_empty_text_returns_original", () => {
    expect(slim_hint_text("", "hot")).toBe("");
  });

  it("test_whitespace_only_text_returns_original", () => {
    expect(slim_hint_text("   \n\n   ", "hot")).toBe("   \n\n   ");
  });

  it("test_unknown_tier_unchanged", () => {
    const text = "Para one.\n\nPara two.";
    expect(slim_hint_text(text, "future_tier")).toBe(text);
  });

  it("test_apply_hint_priority_limit_slims_at_hot", () => {
    const multi_para = "First actionable line.\n\nVerbose detail that wastes tokens.";
    const items = [new HintItem(multi_para, HINT_PRIORITY_LOW)];
    const result = apply_hint_priority_limit(items, HINT_MAX_PER_TOOL_CALL, { tier: "hot" });
    expect(result.length).toBe(1);
    expect(result[0]!.includes("Verbose detail")).toBe(false);
    expect(result[0]!.includes("First actionable")).toBe(true);
  });

  it("test_apply_hint_priority_limit_preserves_at_cool", () => {
    const multi_para = "First line.\n\nSecond paragraph.";
    const items = [new HintItem(multi_para, HINT_PRIORITY_LOW)];
    const result = apply_hint_priority_limit(items, HINT_MAX_PER_TOOL_CALL, { tier: "cool" });
    expect(result[0]!.includes("Second paragraph")).toBe(true);
  });
});

// ===========================================================================
// TestTestFileHint
// ===========================================================================

describe("TestTestFileHint", () => {
  it("test_impl_file_found_not_read_returns_hint", () => {
    const root = tmpPath();
    fs.mkdirSync(path.join(root, "src", "token_goat"), { recursive: true });
    fs.mkdirSync(path.join(root, "tests"), { recursive: true });

    const impl_file = path.join(root, "src", "token_goat", "worker.py");
    fs.writeFileSync(impl_file, "# implementation", "utf8");

    const test_file = path.join(root, "tests", "test_worker.py");
    fs.writeFileSync(test_file, "# test", "utf8");

    // Create session cache (empty, no reads yet).
    const sid = "test-session-1";
    const cache = session.load(sid);

    const hint = build_test_file_hint(test_file, cache, root);

    expect(hint).not.toBeNull();
    expect(hint!.hint_priority).toBe(HINT_PRIORITY_LOW);
    expect(hint!.text.includes("worker.py")).toBe(true);
    expect(hint!.text.includes("Implementation") || hint!.text.includes("implementation")).toBe(
      true,
    );
  });

  it("test_impl_file_already_read_returns_none", () => {
    const root = tmpPath();
    fs.mkdirSync(path.join(root, "src", "token_goat"), { recursive: true });
    fs.mkdirSync(path.join(root, "tests"), { recursive: true });

    const impl_file = path.join(root, "src", "token_goat", "worker.py");
    fs.writeFileSync(impl_file, "# implementation", "utf8");

    const test_file = path.join(root, "tests", "test_worker.py");
    fs.writeFileSync(test_file, "# test", "utf8");

    // Create session cache and mark impl file as read.
    const sid = "test-session-2";
    session.mark_file_read(sid, impl_file, 0, 100);
    const cache = session.load(sid);

    const hint = build_test_file_hint(test_file, cache, root);

    // Should return None because impl file was already read.
    expect(hint).toBeNull();
  });

  it("test_impl_file_not_found_returns_none", () => {
    const root = tmpPath();
    fs.mkdirSync(path.join(root, "tests"), { recursive: true });
    const test_file = path.join(root, "tests", "test_nonexistent.py");
    fs.writeFileSync(test_file, "# test", "utf8");

    const sid = "test-session-3";
    const cache = session.load(sid);

    const hint = build_test_file_hint(test_file, cache, root);

    // Should return None because impl file doesn't exist.
    expect(hint).toBeNull();
  });

  it("test_non_test_file_returns_none", () => {
    const root = tmpPath();
    fs.mkdirSync(path.join(root, "src"), { recursive: true });
    const regular_file = path.join(root, "src", "worker.py");
    fs.writeFileSync(regular_file, "# regular file", "utf8");

    const sid = "test-session-4";
    const cache = session.load(sid);

    const hint = build_test_file_hint(regular_file, cache, root);

    // Should return None because it's not a test file.
    expect(hint).toBeNull();
  });

  it("test_no_session_cache_returns_none", () => {
    const root = tmpPath();
    fs.mkdirSync(path.join(root, "src", "token_goat"), { recursive: true });
    fs.mkdirSync(path.join(root, "tests"), { recursive: true });

    const impl_file = path.join(root, "src", "token_goat", "worker.py");
    fs.writeFileSync(impl_file, "# implementation", "utf8");

    const test_file = path.join(root, "tests", "test_worker.py");
    fs.writeFileSync(test_file, "# test", "utf8");

    // Call with None cache.
    const hint = build_test_file_hint(test_file, null, root);

    expect(hint).toBeNull();
  });

  it("test_resolve_impl_file_underscore_handling", () => {
    const root = tmpPath();
    fs.mkdirSync(path.join(root, "src", "token_goat"), { recursive: true });
    fs.mkdirSync(path.join(root, "tests"), { recursive: true });

    const impl_file = path.join(root, "src", "token_goat", "cache_common.py");
    fs.writeFileSync(impl_file, "# implementation", "utf8");

    const test_file = path.join(root, "tests", "test_cache_common.py");
    fs.writeFileSync(test_file, "# test", "utf8");

    const sid = "test-session-5";
    const cache = session.load(sid);

    const hint = build_test_file_hint(test_file, cache, root);

    expect(hint).not.toBeNull();
    expect(hint!.text.includes("cache_common.py")).toBe(true);
  });
});

// ===========================================================================
// TestSha256Hex
// ===========================================================================

describe("TestSha256Hex", () => {
  it("test_default_length_is_12", () => {
    const result = _sha256_hex("hello");
    expect(result.length).toBe(12);
    expect(/^[0-9a-z]+$/.test(result)).toBe(true); // hex chars (str.isalnum analogue)
  });

  it("test_explicit_length", () => {
    for (const n of [8, 12, 16, 32, 64]) {
      const result = _sha256_hex("test", n);
      expect(result.length).toBe(n);
    }
  });

  it("test_deterministic", () => {
    expect(_sha256_hex("abc")).toBe(_sha256_hex("abc"));
  });

  it("test_different_inputs_differ", () => {
    expect(_sha256_hex("foo")).not.toBe(_sha256_hex("bar"));
  });

  it("test_empty_string", () => {
    const result = _sha256_hex("", 8);
    expect(result.length).toBe(8);
  });

  it("test_hint_fingerprint_uses_sha256_hex", () => {
    // _hint_fingerprint delegates to _sha256_hex so the outputs are consistent.
    const fp = _hint_fingerprint("some hint text");
    expect(fp.length).toBe(12);
    // Verify the fingerprint is stable and matches the raw helper with same key.
    expect(fp).toBe(_sha256_hex("some hint text", 12));
  });
});

// ===========================================================================
// TestMinSessionHintSavingsBytes
// ===========================================================================

describe("TestMinSessionHintSavingsBytes", () => {
  afterEach(() => {
    delete process.env.TOKEN_GOAT_SESSION_HINT_MIN_BYTES;
    config.clearConfigCache();
    clearConfigPathOverride();
  });

  it("test_default_threshold_is_512", () => {
    // Python instantiates HintsConfig() directly (default 512). HintsConfig is a
    // plain interface in TS (not constructable), so the default is asserted via
    // config.load() with no TOML — the same 512 default the loader applies.
    setConfigPathOverride(path.join(tmpPath(), "missing.toml"));
    config.clearConfigCache();
    const cfg = config.load();
    expect(cfg.hints?.min_session_hint_savings_bytes).toBe(512);
  });

  it("test_threshold_zero_disables_suppression", () => {
    // With threshold=0, even a tiny hint (tokens_saved=1) is not suppressed.
    process.env.TOKEN_GOAT_SESSION_HINT_MIN_BYTES = "0";
    // Invalidate config cache.
    config.clearConfigCache();

    const cfg = config.load();
    expect(cfg.hints?.min_session_hint_savings_bytes).toBe(0);
  });

  it("test_hint_suppressed_below_threshold", () => {
    // When tokens_saved * 3 < min_session_hint_savings_bytes, the hint returns None.
    process.env.TOKEN_GOAT_SESSION_HINT_MIN_BYTES = "600";
    config.clearConfigCache();

    // Build a ReadHint with tokens_saved=100 → estimated_bytes = 300 < 600.
    const small_hint = new ReadHint("already read this file", 100);

    // Simulate the threshold check inline (mimics build_read_hint behavior).
    const cfg = config.load();
    const threshold = cfg.hints!.min_session_hint_savings_bytes!;
    const estimated_bytes = small_hint.tokens_saved * 3;
    expect(estimated_bytes < threshold).toBe(true); // precondition: below threshold

    // The hint should be suppressed (result should be None) per the threshold logic.
    const suppressed = estimated_bytes < threshold;
    expect(suppressed).toBe(true);
  });

  it("test_hint_passes_above_threshold", () => {
    process.env.TOKEN_GOAT_SESSION_HINT_MIN_BYTES = "100";
    config.clearConfigCache();

    // Build a ReadHint with tokens_saved=500 → estimated_bytes = 1500 > 100.
    const big_hint = new ReadHint("you already read lines 1-200 of this file", 500);

    const cfg = config.load();
    const threshold = cfg.hints!.min_session_hint_savings_bytes!;
    const estimated_bytes = big_hint.tokens_saved * 3;
    expect(estimated_bytes >= threshold).toBe(true); // precondition: passes threshold

    const suppressed = estimated_bytes < threshold;
    expect(suppressed).toBe(false);
  });

  it("test_env_var_overrides_config", () => {
    process.env.TOKEN_GOAT_SESSION_HINT_MIN_BYTES = "1024";
    config.clearConfigCache();

    const cfg = config.load();
    expect(cfg.hints?.min_session_hint_savings_bytes).toBe(1024);
  });
});
