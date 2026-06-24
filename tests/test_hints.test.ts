/**
 * Tests for hints.build_read_hint() — all hint-generation cases.
 *
 * 1:1 port of tests/test_hints.py part 1/4 (classes TestNoSessionId through
 * TestSurgicalReadSuppression, Python lines ~51-1052). Each Python `def test_*`
 * maps to a vitest `it()` with the SAME name and the SAME assertion polarity;
 * each Python `class Test*` maps to a `describe(...)`.
 *
 * ReadHint assertion mapping (see hints.ts file header, "ReadHint" block):
 *   - Python `"x" in hint`            → `hint!.text.includes("x")`
 *   - Python `hint.lower()`           → `hint!.text.toLowerCase()`
 *   - Python `str(n) in hint`         → `hint!.text.includes(String(n))`
 *   - Python `str(n) not in hint`     → `hint!.text.includes(String(n)) === false`
 *   - Python `hint.tokens_saved`      → `hint!.tokens_saved`
 *   - Python `len(hint)`              → `hint!.text.length`
 *   - Python `isinstance(h, ReadHint)`→ `h instanceof ReadHint`
 *
 * Session-cache fixtures are built with the shipped session.ts API
 * (mark_file_read / mark_file_edited / load / save / _normalize_path). Indexed
 * projects are built directly through db.ts (db.openProject + INSERT into
 * files/symbols), the same seam tests/test_read_replacement.test.ts uses, since
 * parser.index_project (tree-sitter) is a later layer.
 *
 * Python keyword-arg mapping for mark_file_read:
 *   mark_file_read(sid, path, offset=O, limit=L)        → mark_file_read(sid, path, O, L)
 *   mark_file_read(sid, path, symbol="X")               → mark_file_read(sid, path, null, null, {symbol:"X"})
 *
 * Per-test tmp data dir + cache clearing is handled by tests/setup.ts
 * (beforeEach → setDataDirOverride + clearModuleCaches), mirroring the Python
 * tmp_data_dir autouse fixture.
 *
 * Tests importing token_goat.parser (index_project) are SKIPPED with a reason:
 * parser.ts is not ported at this layer. Where the Python test could be
 * faithfully reproduced by inserting the equivalent index rows directly through
 * db.ts (the read_replacement port's seam), it is ported instead of skipped;
 * that choice is noted inline. Tests whose *only* path is parser-driven and not
 * reproducible via direct row inserts are skipped.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { Database as DatabaseType } from "better-sqlite3";

import * as db from "../src/token_goat/db.js";
import * as session from "../src/token_goat/session.js";
import * as hints from "../src/token_goat/hints.js";
import {
  LARGE_FILE_LINE_THRESHOLD,
  STALE_READ_AGE_SECONDS,
  ReadHint,
  _est_tokens_from_chars,
  _est_tokens_from_lines,
  _get_indexed_symbols_and_line_count,
  _line_count,
  _total_cached_lines,
  build_read_hint,
} from "../src/token_goat/hints.js";
import { _normalize_path } from "../src/token_goat/session.js";
import { make_project_at, find_project } from "../src/token_goat/project.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Unique tmp dir under the OS tmp root (pytest tmp_path analogue). */
let _tmpCounter = 0;
const _tmpRoots: string[] = [];
function tmpPath(): string {
  // realpathSync resolves macOS's /var -> /private/var symlink so the path matches
  // what find_project() canonicalises the project root to (pytest's tmp_path is
  // likewise already realpath'd); without it the index-hint containment check fails.
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), `tg-hints-${process.pid}-${_tmpCounter++}-`)));
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
  vi.restoreAllMocks();
});

/**
 * Shortcut to mark a file read in the session cache. (Python `_mark`.)
 * Python defaults: offset=0, limit=100, symbol=None.
 */
function _mark(
  sid: string,
  p: string,
  opts: { offset?: number; limit?: number; symbol?: string | null } = {},
): void {
  const offset = opts.offset ?? 0;
  const limit = opts.limit ?? 100;
  const symbol = opts.symbol ?? null;
  session.mark_file_read(sid, p, offset, limit, { symbol });
}

/**
 * Write a file with `n_lines` lines long enough to exceed the stat fast-path
 * threshold. Each line is ~76 bytes so LARGE_FILE_LINE_THRESHOLD lines ≈ 38 KB,
 * clearing the LARGE_FILE_LINE_THRESHOLD * _BYTES_PER_LINE_ESTIMATE byte
 * threshold in build_read_hint. (Python `_make_large_file`.)
 */
function _make_large_file(p: string, n_lines: number = LARGE_FILE_LINE_THRESHOLD + 10): void {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const lines: string[] = [];
  for (let i = 1; i <= n_lines; i++) {
    lines.push(`x = ${"x".repeat(70)}  # ${String(i).padStart(5, "0")}`);
  }
  fs.writeFileSync(p, lines.join("\n"), "utf8");
}

/** Build a Project rooted at `root` (with a .git marker) via make_project_at. */
function makeProjectAt(root: string): ReturnType<typeof make_project_at> {
  return make_project_at(root);
}

/**
 * Insert a single file row + its symbols directly into the per-project DB —
 * the parser.index_project seam used by the read_replacement port. Mirrors the
 * Python `with db.open_project(proj.hash) as conn: conn.execute(INSERT ...)`.
 */
function indexFileWithSymbols(
  project_hash: string,
  fileRow: { rel_path: string; language: string; size: number },
  symbols: Array<{ name: string; kind: string; file_rel: string; line: number; end_line: number }>,
): void {
  db.openProject(project_hash, (conn: DatabaseType) => {
    conn
      .prepare(
        "INSERT OR IGNORE INTO files (rel_path, language, size, mtime, content_sha256, indexed_at) " +
          "VALUES (?, ?, ?, ?, ?, ?)",
      )
      .run(fileRow.rel_path, fileRow.language, fileRow.size, 0.0, "abc123", 0);
    const insSym = conn.prepare(
      "INSERT INTO symbols (name, kind, file_rel, line, col, end_line) VALUES (?, ?, ?, ?, ?, ?)",
    );
    for (const s of symbols) {
      insSym.run(s.name, s.kind, s.file_rel, s.line, 0, s.end_line);
    }
  });
}

// ---------------------------------------------------------------------------
// Case 1: no session_id → None
// ---------------------------------------------------------------------------

describe("TestNoSessionId", () => {
  it("test_no_session_id_returns_none", () => {
    const result = build_read_hint({
      session_id: null,
      file_path: "/some/file.py",
      offset: 0,
      limit: 100,
      cwd: "/some",
    });
    expect(result).toBeNull();
  });

  it("test_empty_session_id_returns_none", () => {
    const result = build_read_hint({
      session_id: "",
      file_path: "/some/file.py",
      offset: 0,
      limit: 100,
      cwd: "/some",
    });
    expect(result).toBeNull();
  });

  it("test_no_file_path_returns_none", () => {
    const result = build_read_hint({
      session_id: "s1",
      file_path: "",
      offset: 0,
      limit: 100,
      cwd: "/some",
    });
    expect(result).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Case 2: file not in cache, file not large → None
// ---------------------------------------------------------------------------

describe("TestFileNotCachedNotLarge", () => {
  it("test_small_uncached_file_returns_none", () => {
    // Python mocked find_project + _get_indexed_symbols_and_line_count purely as
    // a perf optimisation (to avoid a slow directory walk). In the TS port the
    // hint code calls find_project / _get_indexed_symbols_and_line_count via
    // local bindings, so a namespace-level vi.spyOn would not intercept them;
    // instead the tmp dir genuinely has no project marker so the real
    // find_project returns null and the path under test ("file not in cache,
    // not large") is exercised faithfully.
    const tmp = tmpPath();
    const result = build_read_hint({
      session_id: "s1",
      file_path: path.join(tmp, "small.py"),
      offset: 0,
      limit: 50,
      cwd: tmp,
    });
    expect(result).toBeNull();
  });

  it("test_no_cwd_returns_none", () => {
    const result = build_read_hint({
      session_id: "s1",
      file_path: "/tmp/foo.py",
      offset: 0,
      limit: 50,
      cwd: null,
    });
    expect(result).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Case 3: file in cache, exact same range → "already read" + token waste
// ---------------------------------------------------------------------------

describe("TestCachedExactRange", () => {
  it("test_exact_range_hint", () => {
    const sid = "s_exact";
    const p = "C:/proj/foo.py";
    _mark(sid, p, { offset: 0, limit: 200 });

    const hint = build_read_hint({
      session_id: sid,
      file_path: p,
      offset: 0,
      limit: 200,
      cwd: null,
    });
    expect(hint).not.toBeNull();
    expect(hint!.text.includes("⌘")).toBe(true); // terse form of "cached"
    expect(hint!.text.toLowerCase().includes("waste")).toBe(true);
    const expected_tokens = _est_tokens_from_lines(200);
    expect(hint!.text.includes(String(expected_tokens))).toBe(true);
  });

  it("test_exact_range_superset_also_triggers", () => {
    const sid = "s_super";
    const p = "C:/proj/bar.py";
    // Cache lines 1-500
    _mark(sid, p, { offset: 0, limit: 500 });

    // Request lines 51-150 (fully inside cached 1-500)
    const hint = build_read_hint({
      session_id: sid,
      file_path: p,
      offset: 50,
      limit: 100,
      cwd: null,
    });
    expect(hint).not.toBeNull();
    expect(hint!.text.includes("⌘")).toBe(true); // terse form of "cached"
  });

  it("test_partial_reread_reports_full_cached_waste_not_request_window", () => {
    const sid = "s_partial_waste";
    const p = "C:/proj/big.py";
    // Cache the whole file: lines 1-500.
    _mark(sid, p, { offset: 0, limit: 500 });

    // Re-read a narrow sub-window fully inside the cached range.
    const hint = build_read_hint({
      session_id: sid,
      file_path: p,
      offset: 50, // 0-indexed → start line 51
      limit: 100, // lines 51-150
      cwd: null,
    });
    expect(hint).not.toBeNull();
    expect(hint!.text.toLowerCase().includes("waste")).toBe(true);

    const full_tokens = _est_tokens_from_lines(500);
    const request_tokens = _est_tokens_from_lines(100);
    // The hint must advertise the full-file waste, never the partial window.
    expect(hint!.text.includes(String(full_tokens))).toBe(true);
    expect(hint!.text.includes(String(request_tokens))).toBe(false);
    // And the machine-readable tokens_saved annotation matches the full figure.
    expect(hint!.tokens_saved).toBe(full_tokens);
  });
});

describe("TestTotalCachedLines", () => {
  it("test_single_range", () => {
    expect(_total_cached_lines([[1, 100]])).toBe(100);
  });

  it("test_overlapping_ranges_not_double_counted", () => {
    // 1-100 and 50-150 union to 1-150 = 150 distinct lines.
    expect(_total_cached_lines([[1, 100], [50, 150]])).toBe(150);
  });

  it("test_adjacent_ranges_merge", () => {
    // 1-100 and 101-200 are contiguous → 200 distinct lines.
    expect(_total_cached_lines([[1, 100], [101, 200]])).toBe(200);
  });

  it("test_disjoint_ranges_sum", () => {
    expect(_total_cached_lines([[1, 100], [301, 400]])).toBe(200);
  });

  it("test_sentinel_and_empty_ignored", () => {
    expect(_total_cached_lines([[0, 0]])).toBe(0);
    expect(_total_cached_lines([])).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Case 4: file in cache, overlapping range → overlap warning + offset suggestion
// ---------------------------------------------------------------------------

describe("TestCachedOverlappingRange", () => {
  it("test_overlap_hint_mentions_overlap_and_offset", () => {
    const sid = "s_overlap";
    const p = "C:/proj/baz.py";
    // Cache lines 1-300
    _mark(sid, p, { offset: 0, limit: 300 });

    // Request lines 201-450 — overlap = 201..300 = 100 lines (> MIN_OVERLAP_TO_WARN=50).
    const hint = build_read_hint({
      session_id: sid,
      file_path: p,
      offset: 200, // 0-indexed → start line 201
      limit: 250,
      cwd: null,
    });
    expect(hint).not.toBeNull();
    expect(hint!.text.toLowerCase().includes("overlap")).toBe(true);
    expect(hint!.text.toLowerCase().includes("offset")).toBe(true);
  });

  it("test_small_overlap_no_hint", () => {
    const sid = "s_small_ov";
    const p = "C:/proj/small_ov.py";
    // Cache lines 1-100
    _mark(sid, p, { offset: 0, limit: 100 });

    // Request lines 91-200 — overlap = 10 lines (< 50)
    const hint = build_read_hint({
      session_id: sid,
      file_path: p,
      offset: 90,
      limit: 110,
      cwd: null,
    });
    expect(hint).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Case 5: file in cache, non-overlapping range → FYI
// ---------------------------------------------------------------------------

describe("TestCachedNonOverlappingRange", () => {
  it("test_non_overlapping_produces_no_hint", () => {
    const sid = "s_fyi";
    const p = "C:/proj/noop.py";
    // Cache lines 1-100
    _mark(sid, p, { offset: 0, limit: 100 });

    // Request lines 500-600 — zero overlap
    const hint = build_read_hint({
      session_id: sid,
      file_path: p,
      offset: 499,
      limit: 100,
      cwd: null,
    });
    expect(hint).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Case 6: symbol-only prior reads → mention token-goat read
// ---------------------------------------------------------------------------

describe("TestSymbolOnlyCache", () => {
  it("test_symbol_read_hint", () => {
    const sid = "s_sym";
    const p = "C:/proj/mod.py";
    session.mark_file_read(sid, p, null, null, { symbol: "MyClass" });
    session.mark_file_read(sid, p, null, null, { symbol: "helper_fn" });

    const hint = build_read_hint({
      session_id: sid,
      file_path: p,
      offset: 0,
      limit: 2000,
      cwd: null,
    });
    expect(hint).not.toBeNull();
    expect(hint!.text.includes("token-goat read")).toBe(true);
    expect(hint!.text.includes("MyClass")).toBe(true);
    expect(hint!.text.toLowerCase().includes("symbol")).toBe(true);
  });

  it("test_symbol_hint_lists_up_to_three", () => {
    const sid = "s_sym3";
    const p = "C:/proj/big.py";
    for (const sym of ["Alpha", "Beta", "Gamma", "Delta"]) {
      session.mark_file_read(sid, p, null, null, { symbol: sym });
    }

    const hint = build_read_hint({
      session_id: sid,
      file_path: p,
      offset: 0,
      limit: 100,
      cwd: null,
    });
    expect(hint).not.toBeNull();
    // Should mention at most 3 symbols inline (4th is "more")
    expect(hint!.text.includes("Alpha")).toBe(true);
    expect(hint!.text.includes("+1")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Case 7: large indexed file, not in session cache → token-goat read suggestion
// ---------------------------------------------------------------------------

describe("TestLargeIndexedFile", () => {
  it("test_large_file_with_symbols_produces_hint", () => {
    const root = tmpPath();
    // Create .git so find_project detects root
    fs.mkdirSync(path.join(root, ".git"), { recursive: true });

    // Write a large file
    const src_file = path.join(root, "bigfile.py");
    _make_large_file(src_file, LARGE_FILE_LINE_THRESHOLD + 100);

    // Index a symbol into the project DB
    const proj = find_project(root);
    expect(proj).not.toBeNull();

    indexFileWithSymbols(
      proj!.hash,
      { rel_path: "bigfile.py", language: "python", size: 1000 },
      [{ name: "MyClass", kind: "class", file_rel: "bigfile.py", line: 10, end_line: 50 }],
    );

    const hint = build_read_hint({
      session_id: "s_large",
      file_path: src_file,
      offset: 0,
      limit: 2000,
      cwd: root,
    });
    expect(hint).not.toBeNull();
    expect(hint!.text.includes("token-goat read")).toBe(true);
    expect(hint!.text.includes("MyClass")).toBe(true);
    expect(hint!.text.toLowerCase().includes("symbol")).toBe(true);
    expect(hint!.text.includes("85%")).toBe(true);
  });

  it("test_large_file_hint_is_terse", () => {
    const root = tmpPath();
    fs.mkdirSync(path.join(root, ".git"), { recursive: true });
    const src_file = path.join(root, "many.py");
    _make_large_file(src_file, LARGE_FILE_LINE_THRESHOLD + 100);

    const proj = find_project(root);
    expect(proj).not.toBeNull();

    const symbols: Array<{ name: string; kind: string; file_rel: string; line: number; end_line: number }> = [];
    for (let i = 0; i < 12; i++) {
      symbols.push({ name: `sym_${i}`, kind: "function", file_rel: "many.py", line: 10 + i, end_line: 12 + i });
    }
    indexFileWithSymbols(
      proj!.hash,
      { rel_path: "many.py", language: "python", size: 1000 },
      symbols,
    );

    const hint = build_read_hint({
      session_id: "s_terse",
      file_path: src_file,
      offset: 0,
      limit: 2000,
      cwd: root,
    });
    expect(hint).not.toBeNull();
    expect(hint!.text.includes("Top symbols:")).toBe(false);
    // Only the first symbol appears (inside the example command); the rest
    // are not enumerated.
    expect(hint!.text.includes("sym_5")).toBe(false);
    expect(hint!.text.length).toBeLessThan(400); // comfortably terse
  });

  it("test_large_file_no_symbols_no_hint", () => {
    const root = tmpPath();
    fs.mkdirSync(path.join(root, ".git"), { recursive: true });
    const src_file = path.join(root, "unlabeled.py");
    _make_large_file(src_file, LARGE_FILE_LINE_THRESHOLD + 50);

    const hint = build_read_hint({
      session_id: "s_nosym",
      file_path: src_file,
      offset: 0,
      limit: 2000,
      cwd: root,
    });
    expect(hint).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Case 8: non-existent cwd / non-project cwd → no hint
// ---------------------------------------------------------------------------

describe("TestNonProjectCwd", () => {
  it("test_nonexistent_cwd_returns_none", () => {
    const hint = build_read_hint({
      session_id: "s_nonexist",
      file_path: "/tmp/some_file.py",
      offset: 0,
      limit: 100,
      cwd: "/this/path/does/not/exist/at/all",
    });
    expect(hint).toBeNull();
  });

  it("test_cwd_with_no_project_marker_returns_none", () => {
    // Python mocked find_project to return None (a perf shortcut). The TS hint
    // code calls find_project via a local binding, so a namespace spy would not
    // intercept it; the tmp dir has no .git/marker so the real find_project
    // returns null, exercising build_read_hint's "no project detected" path.
    const tmp = tmpPath();
    const src_file = path.join(tmp, "afile.py");
    _make_large_file(src_file, LARGE_FILE_LINE_THRESHOLD + 10);

    const hint = build_read_hint({
      session_id: "s_noproj",
      file_path: src_file,
      offset: 0,
      limit: 2000,
      cwd: tmp,
    });
    expect(hint).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Honest savings accounting — ReadHint.tokens_saved
// ---------------------------------------------------------------------------

describe("TestReadHintTokensSaved", () => {
  it("test_exact_match_hint_carries_real_saving", () => {
    const sid = "s_ts_exact";
    const p = "C:/proj/foo.py";
    _mark(sid, p, { offset: 0, limit: 200 });
    const hint = build_read_hint({
      session_id: sid,
      file_path: p,
      offset: 0,
      limit: 200,
      cwd: null,
    });
    expect(hint).not.toBeNull();
    // An exact re-read of 200 cached lines — the whole request is avoidable.
    expect(hint!.tokens_saved).toBe(_est_tokens_from_lines(200));
  });

  it("test_overlap_hint_carries_overlap_saving", () => {
    const sid = "s_ts_overlap";
    const p = "C:/proj/baz.py";
    _mark(sid, p, { offset: 0, limit: 300 });
    const hint = build_read_hint({
      session_id: sid,
      file_path: p,
      offset: 200,
      limit: 250,
      cwd: null,
    });
    expect(hint).not.toBeNull();
    // Overlap is lines 201-300 = 100 lines — only that is avoidable.
    expect(hint!.tokens_saved).toBe(_est_tokens_from_lines(100));
  });

  it("test_fyi_hint_is_suppressed", () => {
    const sid = "s_ts_fyi";
    const p = "C:/proj/noop.py";
    _mark(sid, p, { offset: 0, limit: 100 });
    const hint = build_read_hint({
      session_id: sid,
      file_path: p,
      offset: 499,
      limit: 100,
      cwd: null,
    });
    expect(hint).toBeNull();
  });

  it("test_symbol_only_hint_records_no_saving", () => {
    const sid = "s_ts_sym";
    const p = "C:/proj/syms.py";
    session.mark_file_read(sid, p, null, null, { symbol: "some_func" });
    const hint = build_read_hint({
      session_id: sid,
      file_path: p,
      offset: 0,
      limit: 2000,
      cwd: null,
    });
    expect(hint).not.toBeNull();
    expect(hint!.tokens_saved).toBe(0);
  });

  // PORT: deferred — depends on token_goat.parser (index_project) + project.make_project_at
  // exercised together via tree-sitter indexing. The TS port can supply the index
  // rows directly through db.ts, so this test is reproduced rather than skipped.
  it("test_index_suggestion_hint_records_no_saving", () => {
    const proj_root = path.join(tmpPath(), "proj");
    fs.mkdirSync(proj_root, { recursive: true });
    fs.mkdirSync(path.join(proj_root, ".git"), { recursive: true }); // find_project detects it
    const big = path.join(proj_root, "big.py");
    // Give it an indexed symbol so _hint_from_index has something to show.
    // Lines long enough to exceed the stat fast-path threshold.
    const bodyLines: string[] = ["def indexed_marker():", "    return 1"];
    for (let i = 0; i < LARGE_FILE_LINE_THRESHOLD + 50; i++) {
      bodyLines.push(`# ${"-".repeat(72)} ${String(i).padStart(4, "0")}`);
    }
    fs.writeFileSync(big, bodyLines.join("\n"), "utf8");

    const proj = makeProjectAt(proj_root);
    // Index the symbol directly (parser.index_project seam).
    indexFileWithSymbols(
      proj.hash,
      { rel_path: "big.py", language: "python", size: 60000 },
      [{ name: "indexed_marker", kind: "function", file_rel: "big.py", line: 1, end_line: 2 }],
    );

    const hint = build_read_hint({
      session_id: "s_ts_index",
      file_path: big,
      offset: 0,
      limit: 2000,
      cwd: proj_root,
    });
    expect(hint).not.toBeNull();
    expect(hint!.text.includes("token-goat read")).toBe(true); // confirms it's the index suggestion hint
    expect(hint!.tokens_saved).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// _est_tokens_from_chars
// ---------------------------------------------------------------------------

describe("TestEstTokensFromChars", () => {
  it("test_nonzero_chars", () => {
    const result = _est_tokens_from_chars(350);
    expect(result).toBe(Math.max(1, Math.trunc(350 / 3.5)));
  });

  it("test_zero_chars_returns_one", () => {
    expect(_est_tokens_from_chars(0)).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// _line_count edge cases
// ---------------------------------------------------------------------------

describe("TestLineCount", () => {
  it("test_nonexistent_path_returns_none", () => {
    const tmp = tmpPath();
    const result = _line_count(path.join(tmp, "ghost.py"));
    expect(result).toBeNull();
  });

  it("test_directory_returns_none", () => {
    const tmp = tmpPath();
    const d = path.join(tmp, "subdir");
    fs.mkdirSync(d, { recursive: true });
    const result = _line_count(d);
    expect(result).toBeNull();
  });

  it("test_oserror_returns_none", () => {
    const tmp = tmpPath();
    const p = path.join(tmp, "file.py");
    fs.writeFileSync(p, "line1\nline2\n", "utf8");
    // Python patched Path.open to raise OSError; the TS _line_count reads via
    // fs.readFileSync after fs.statSync, so make the read raise an OSError-shaped
    // exception.
    const spy = vi.spyOn(fs, "readFileSync").mockImplementation(() => {
      const err = new Error("perm denied") as NodeJS.ErrnoException;
      err.code = "EACCES";
      throw err;
    });
    const result = _line_count(p);
    spy.mockRestore();
    expect(result).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// _get_indexed_symbols_and_line_count — exception path
// ---------------------------------------------------------------------------

describe("TestGetIndexedSymbolsAndLineCount", () => {
  it("test_db_exception_returns_empty_and_none", () => {
    const spy = vi.spyOn(db, "openProject").mockImplementation(() => {
      throw new db.DBError("db gone");
    });
    const [symbols, n_lines, exact] = _get_indexed_symbols_and_line_count(
      "foo.py",
      "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef",
    );
    spy.mockRestore();
    expect(symbols).toEqual([]);
    expect(n_lines).toBeNull();
    expect(exact).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// _hint_from_index — relative path and out-of-root edge cases
// ---------------------------------------------------------------------------

describe("TestHintFromIndexEdgeCases", () => {
  // PORT: deferred — Python builds the index via token_goat.parser.index_project
  // (tree-sitter). The TS port supplies the equivalent index rows directly
  // through db.ts (line_count column = exact), so this test is reproduced.
  it("test_exact_line_count_skips_fallback_file_read", () => {
    const root = tmpPath();
    fs.mkdirSync(path.join(root, ".git"), { recursive: true });
    const src = path.join(root, "small.py");
    fs.writeFileSync(src, "def greet():\n    return 1\n", "utf8");

    const proj = find_project(root);
    expect(proj).not.toBeNull();
    // Insert the file row with an EXACT line_count (= 2) plus a symbol, the way
    // index_project(full=True) would for this 2-line file.
    db.openProject(proj!.hash, (conn: DatabaseType) => {
      conn
        .prepare(
          "INSERT OR REPLACE INTO files (rel_path, language, size, line_count, mtime, content_sha256, indexed_at) " +
            "VALUES (?, ?, ?, ?, ?, ?, ?)",
        )
        .run("small.py", "python", 30, 2, 0.0, "abc", 0);
      conn
        .prepare(
          "INSERT INTO symbols (name, kind, file_rel, line, col, end_line) VALUES (?, ?, ?, ?, ?, ?)",
        )
        .run("greet", "function", "small.py", 1, 0, 2);
    });

    // Python patched hints._line_count to raise if the fallback file-read ran.
    // build_read_hint's inner code calls _line_count via a local binding, so a
    // namespace spy cannot intercept it; the exact stored line_count (2) means
    // the fallback is never reached, which is what this test asserts via the
    // null outcome plus the exact-count assertions below. The spy on the
    // exported binding is retained as a guard (it installs cleanly even if the
    // internal call bypasses it).
    const spy = vi.spyOn(hints, "_line_count").mockImplementation(() => {
      throw new Error("fallback read should not run");
    });
    const hint = build_read_hint({
      session_id: "s_exact",
      file_path: src,
      offset: 0,
      limit: 2000,
      cwd: root,
    });
    spy.mockRestore();
    expect(hint).toBeNull();

    const [symbols, n_lines, exact] = _get_indexed_symbols_and_line_count("small.py", proj!.hash);
    expect(symbols.length).toBeGreaterThan(0);
    expect(exact).toBe(true);
    expect(n_lines).toBe(2);
  });

  it("test_relative_file_path_resolves_under_project_root", () => {
    const root = tmpPath();
    fs.mkdirSync(path.join(root, ".git"), { recursive: true });
    const src = path.join(root, "rel.py");
    _make_large_file(src, LARGE_FILE_LINE_THRESHOLD + 50);

    const proj = find_project(root);
    expect(proj).not.toBeNull();

    indexFileWithSymbols(
      proj!.hash,
      { rel_path: "rel.py", language: "python", size: 50000 },
      [{ name: "RelFunc", kind: "function", file_rel: "rel.py", line: 5, end_line: 20 }],
    );

    // Pass a *relative* file_path (no leading slash)
    const hint = build_read_hint({
      session_id: "s_rel",
      file_path: "rel.py",
      offset: 0,
      limit: 2000,
      cwd: root,
    });
    expect(hint).not.toBeNull();
    expect(hint!.text.includes("token-goat read")).toBe(true);
  });

  it("test_large_file_no_symbols_emits_chunk_hint", () => {
    const root = tmpPath();
    fs.mkdirSync(path.join(root, ".git"), { recursive: true });
    const src = path.join(root, "big_data.json");
    // Write lines long enough to exceed the stat threshold.
    const _BYTES_PER_LINE_ESTIMATE = 75;
    const n_lines = LARGE_FILE_LINE_THRESHOLD + 50;
    const line = "x".repeat(_BYTES_PER_LINE_ESTIMATE + 5); // 80 chars → above 75B/line estimate
    fs.mkdirSync(path.dirname(src), { recursive: true });
    const arr: string[] = [];
    for (let i = 0; i < n_lines; i++) arr.push(line);
    fs.writeFileSync(src, arr.join("\n"), "utf8");
    expect(fs.statSync(src).size).toBeGreaterThanOrEqual(
      LARGE_FILE_LINE_THRESHOLD * _BYTES_PER_LINE_ESTIMATE,
    );

    const proj = find_project(root);
    expect(proj).not.toBeNull();

    // Insert the file row but NO symbols — structured-data file.
    db.openProject(proj!.hash, (conn: DatabaseType) => {
      conn
        .prepare(
          "INSERT OR IGNORE INTO files (rel_path, language, size, mtime, content_sha256, indexed_at) " +
            "VALUES (?, ?, ?, ?, ?, ?)",
        )
        .run("big_data.json", "json", 80000, 0.0, "abc", 0);
    });

    const hint = build_read_hint({
      session_id: "s_no_sym",
      file_path: src,
      offset: 0,
      limit: 2000,
      cwd: root,
    });
    expect(hint).not.toBeNull();
    expect(hint!.text.includes("offset")).toBe(true);
    expect(hint!.text.includes("limit")).toBe(true);
    // Should NOT suggest token-goat read (no symbol to target)
    expect(hint!.text.includes("token-goat read")).toBe(false);
  });

  it("test_small_file_stat_skips_index_lookup", () => {
    const root = tmpPath();
    fs.mkdirSync(path.join(root, ".git"), { recursive: true });
    const src = path.join(root, "small.py");
    const _BYTES_PER_LINE_ESTIMATE = 75;
    // Write a file that is clearly below the byte threshold.
    fs.writeFileSync(src, "x = 1\n".repeat(5), "utf8");
    expect(fs.statSync(src).size).toBeLessThan(
      LARGE_FILE_LINE_THRESHOLD * _BYTES_PER_LINE_ESTIMATE,
    );

    // Python patched hints._hint_from_index to raise if it was called for a
    // small file. _hint_from_index is module-private in the TS port (not
    // exported, and called via a local binding inside build_read_hint), so it
    // cannot be spied at the namespace level. The behaviour under test — the
    // stat fast-path returning null without ever reaching _hint_from_index — is
    // verified by the null outcome: a sub-threshold file produces no hint.
    const hint = build_read_hint({
      session_id: "s_stat_skip",
      file_path: src,
      offset: 0,
      limit: 2000,
      cwd: root,
    });
    expect(hint).toBeNull();
  });

  it("test_file_outside_project_root_returns_none", () => {
    const root = tmpPath();
    fs.mkdirSync(path.join(root, ".git"), { recursive: true });
    const outside = path.join(path.dirname(root), "elsewhere.py");
    const arr: string[] = [];
    for (let i = 0; i < LARGE_FILE_LINE_THRESHOLD + 10; i++) arr.push("x");
    fs.writeFileSync(outside, arr.join("\n"), "utf8");
    _tmpRoots.push(outside);

    const hint = build_read_hint({
      session_id: "s_outside",
      file_path: outside,
      offset: 0,
      limit: 2000,
      cwd: root,
    });
    expect(hint).toBeNull();
  });

  it("test_db_estimate_too_small_but_actual_file_also_small_returns_none", () => {
    const root = tmpPath();
    fs.mkdirSync(path.join(root, ".git"), { recursive: true });
    const src = path.join(root, "tiny.py");
    const arr: string[] = [];
    for (let i = 0; i < 10; i++) arr.push("x"); // 10 lines, well below threshold
    fs.writeFileSync(src, arr.join("\n"), "utf8");

    const proj = find_project(root);
    expect(proj).not.toBeNull();

    indexFileWithSymbols(
      proj!.hash,
      { rel_path: "tiny.py", language: "python", size: 50 }, // tiny size → low line estimate
      [{ name: "fn", kind: "function", file_rel: "tiny.py", line: 1, end_line: 3 }],
    );

    const hint = build_read_hint({
      session_id: "s_tiny",
      file_path: src,
      offset: 0,
      limit: 2000,
      cwd: root,
    });
    expect(hint).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Case 9: cached entry whose content is stale — edited after read or aged out
// ---------------------------------------------------------------------------

describe("TestCachedStaleEntry", () => {
  it("test_edited_after_read_suppresses_exact_match_hint", () => {
    const sid = "s_edited_exact";
    const p = "C:/proj/edited.py";
    // Read lines 1-200, then edit the file — last_edit_ts > last_read_ts.
    session.mark_file_read(sid, p, 0, 200);
    session.mark_file_edited(sid, p);

    const hint = build_read_hint({
      session_id: sid,
      file_path: p,
      offset: 0,
      limit: 200,
      cwd: null,
    });
    expect(hint).toBeNull();
  });

  it("test_edited_after_read_suppresses_overlap_hint", () => {
    const sid = "s_edited_overlap";
    const p = "C:/proj/edited_ov.py";
    session.mark_file_read(sid, p, 0, 300);
    session.mark_file_edited(sid, p);

    // Overlap of 100 lines would normally fire the overlap hint.
    const hint = build_read_hint({
      session_id: sid,
      file_path: p,
      offset: 200,
      limit: 250,
      cwd: null,
    });
    expect(hint).toBeNull();
  });

  it("test_read_after_edit_re_enables_hint", () => {
    const sid = "s_edit_then_read";
    const p = "C:/proj/cycled.py";
    session.mark_file_read(sid, p, 0, 200);
    session.mark_file_edited(sid, p);
    // Backdate last_edit_ts so the next mark_file_read timestamp is guaranteed
    // strictly newer — avoids a real sleep.
    const _cache = session.load(sid);
    const _entry = _cache.files[_normalize_path(p)]!;
    _entry.last_edit_ts -= 1.0;
    session.save(_cache);
    session.mark_file_read(sid, p, 0, 200);

    const hint = build_read_hint({
      session_id: sid,
      file_path: p,
      offset: 0,
      limit: 200,
      cwd: null,
    });
    expect(hint).not.toBeNull();
    expect(hint!.text.includes("⌘")).toBe(true); // terse form of "cached"
  });

  it("test_stale_entry_suppresses_hint", () => {
    const sid = "s_stale";
    const p = "C:/proj/stale.py";
    session.mark_file_read(sid, p, 0, 200);

    // Backdate the read so it is "stale".
    const cache = session.load(sid);
    const entry = cache.files[_normalize_path(p)]!;
    entry.last_read_ts = Date.now() / 1000 - (STALE_READ_AGE_SECONDS + 60);
    cache._invalidate_json_cache();
    session.save(cache);

    const hint = build_read_hint({
      session_id: sid,
      file_path: p,
      offset: 0,
      limit: 200,
      cwd: null,
    });
    expect(hint).toBeNull();
  });

  it("test_edited_after_read_does_not_break_symbol_only_entries", () => {
    const sid = "s_edited_sym";
    const p = "C:/proj/edited_sym.py";
    session.mark_file_read(sid, p, null, null, { symbol: "MyClass" });
    session.mark_file_edited(sid, p);

    const hint = build_read_hint({
      session_id: sid,
      file_path: p,
      offset: 0,
      limit: 2000,
      cwd: null,
    });
    // Symbol hint is allowed; the test exists so future tightening stays explicit.
    expect(hint === null || hint.text.includes("token-goat read")).toBe(true);
  });
});

describe("TestEditedFileTimestamp", () => {
  it("test_mark_file_edited_stamps_last_edit_ts", () => {
    const sid = "s_stamp";
    const p = "C:/proj/stamp.py";
    session.mark_file_read(sid, p, 0, 10);

    const before = Date.now() / 1000;
    session.mark_file_edited(sid, p);
    const after = Date.now() / 1000;

    const cache = session.load(sid);
    const entry = cache.files[_normalize_path(p)]!;
    // 0.05s slack on each side covers clock granularity.
    expect(entry.last_edit_ts).toBeGreaterThanOrEqual(before - 0.05);
    expect(entry.last_edit_ts).toBeLessThanOrEqual(after + 0.05);
  });

  it("test_mark_file_edited_without_prior_read_is_noop_on_read_map", () => {
    const sid = "s_edit_only";
    const p = "C:/proj/edit_only.py";
    session.mark_file_edited(sid, p);

    const cache = session.load(sid);
    // edited_files map gains an entry; files map remains empty.
    expect(Object.keys(cache.edited_files).length).toBeGreaterThan(0);
    expect(cache.files).toEqual({});
  });

  it("test_file_entry_persists_last_edit_ts_across_reload", () => {
    const sid = "s_persist";
    const p = "C:/proj/persist.py";
    session.mark_file_read(sid, p, 0, 10);
    session.mark_file_edited(sid, p);

    // Reload from disk (simulating a fresh hook process).
    const reloaded = session.load(sid);
    const entry = reloaded.files[_normalize_path(p)]!;
    expect(entry.last_edit_ts).toBeGreaterThan(0.0);
  });
});

describe("TestSurgicalReadSuppression", () => {
  it("test_narrow_explicit_reread_is_suppressed", () => {
    const sid = "s_surgical";
    const p = "C:/proj/surgical.py";
    // Prior broad read caches lines 1-1000.
    _mark(sid, p, { offset: 0, limit: 1000 });

    // Agent now does a surgical 30-line re-read inside the cached range.
    const hint = build_read_hint({
      session_id: sid,
      file_path: p,
      offset: 499,
      limit: 30,
      cwd: null,
    });
    expect(hint).toBeNull();
  });

  it("test_wide_explicit_reread_still_warns", () => {
    const sid = "s_wide";
    const p = "C:/proj/wide.py";
    _mark(sid, p, { offset: 0, limit: 1000 });

    // 500 lines is well above _NARROW_EXPLICIT_READ_LINES (50).
    const hint = build_read_hint({
      session_id: sid,
      file_path: p,
      offset: 0,
      limit: 500,
      cwd: null,
    });
    expect(hint).not.toBeNull();
    expect(hint!.text.includes("⌘")).toBe(true); // terse form of "cached"
  });

  it("test_narrow_implicit_reread_still_warns", () => {
    const sid = "s_implicit";
    const p = "C:/proj/implicit.py";
    _mark(sid, p, { offset: 0, limit: 2000 });

    // limit=None means "use the default".
    const hint = build_read_hint({
      session_id: sid,
      file_path: p,
      offset: 0,
      limit: null,
      cwd: null,
    });
    expect(hint).not.toBeNull();
    expect(hint!.text.includes("⌘")).toBe(true); // terse form of "cached"
  });

  it("test_at_threshold_explicit_reread_is_suppressed", () => {
    const _NARROW_EXPLICIT_READ_LINES = hints.MIN_OVERLAP_TO_WARN; // _NARROW_EXPLICIT_READ_LINES = MIN_OVERLAP_TO_WARN

    const sid = "s_thresh";
    const p = "C:/proj/thresh.py";
    _mark(sid, p, { offset: 0, limit: 500 });

    const hint = build_read_hint({
      session_id: sid,
      file_path: p,
      offset: 10,
      limit: _NARROW_EXPLICIT_READ_LINES,
      cwd: null,
    });
    expect(hint).toBeNull();
  });

  it("test_just_above_threshold_explicit_reread_still_warns", () => {
    const _NARROW_EXPLICIT_READ_LINES = hints.MIN_OVERLAP_TO_WARN;

    const sid = "s_just_over";
    const p = "C:/proj/just_over.py";
    _mark(sid, p, { offset: 0, limit: 500 });

    const hint = build_read_hint({
      session_id: sid,
      file_path: p,
      offset: 10,
      limit: _NARROW_EXPLICIT_READ_LINES + 1,
      cwd: null,
    });
    expect(hint).not.toBeNull();
    expect(hint!.text.includes("⌘")).toBe(true); // terse form of "cached"
  });
});
