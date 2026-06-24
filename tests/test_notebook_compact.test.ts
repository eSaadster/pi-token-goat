/**
 * Tests for notebook output stripping (notebook_compact.ts).
 *
 * 1:1 port of tests/test_notebook_compact.py — the strip_notebook unit tests
 * and the get_or_create_sidecar unit tests. Each Python `def test_*` maps to a
 * vitest `it()` with the same name and assertion polarity; the Python test
 * classes (TestStripNotebook / TestGetOrCreateSidecar) become describe() blocks.
 *
 * Test-seam mapping (Python → TS):
 *  - tmp_path fixture → a per-test throwaway directory under the data dir that
 *    setup.ts already isolates (resolved via fs.mkdtempSync under dataDir()).
 *    notebook_compact takes cacheRoot as an explicit string arg, so we pass that
 *    dir directly; the module touches no global path state.
 *  - json.dumps(...).encode() → Buffer.from(JSON.stringify(...), "utf8") — both
 *    produce the UTF-8 bytes the SHA-256 hashes. The hash only needs to be
 *    stable & content-sensitive within a single test run (cache-hit / different-
 *    content tests compare two hashes computed by the SAME encoder), so the byte
 *    layout matching the Python json.dumps exactly is not required.
 *  - json.loads(sidecar.read_bytes()) → JSON.parse(fs.readFileSync(...,"utf8")).
 *  - sidecar.stat().st_mtime → fs.statSync(sidecar).mtimeMs.
 *  - pytest.raises((ValueError, json.JSONDecodeError)) → expect(() => ...).toThrow()
 *    (JS JSON.parse throws SyntaxError; the polarity "it throws" is preserved).
 *  - pytest.raises(ValueError, match="Not a notebook") → toThrow("Not a notebook").
 *
 * Deferred (NOT ported here):
 *  - The TestNotebookPreRead integration class exercises hooks_read.pre_read,
 *    which depends on the not-yet-ported hooks_read module. Those tests land with
 *    that layer; they are written below as it.skip and counted in tests_skipped.
 */
import { describe, expect, it } from "vitest";

import fs from "node:fs";
import path from "node:path";
import { Buffer } from "node:buffer";

import { dataDir } from "../src/token_goat/paths.js";
import {
  get_or_create_sidecar,
  strip_notebook,
} from "../src/token_goat/notebook_compact.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface NbDict {
  nbformat: number;
  nbformat_minor: number;
  metadata: Record<string, unknown>;
  cells: Array<Record<string, unknown>>;
  [key: string]: unknown;
}

/** Build a minimal notebook dict. */
function _nb(opts?: { n_code?: number; output_size?: number }): NbDict {
  const nCode = opts?.n_code ?? 2;
  const outputSize = opts?.output_size ?? 5000;
  const filler = "x".repeat(outputSize);
  const cells: Array<Record<string, unknown>> = [];
  for (let i = 0; i < nCode; i++) {
    cells.push({
      cell_type: "code",
      source: [`print(${i})`],
      execution_count: i + 1,
      outputs: [{ output_type: "stream", text: [filler] }],
      metadata: {},
    });
  }
  return { nbformat: 4, nbformat_minor: 5, metadata: {}, cells };
}

function _md_cell(text: string = "# Title"): Record<string, unknown> {
  return { cell_type: "markdown", source: [text], metadata: {} };
}

/** Allocate a throwaway directory for a test (the tmp_path analogue). */
function makeTmpPath(): string {
  return fs.mkdtempSync(path.join(dataDir(), "tmp-"));
}

// ---------------------------------------------------------------------------
// strip_notebook unit tests
// ---------------------------------------------------------------------------

describe("TestStripNotebook", () => {
  it("test_code_cell_outputs_cleared", () => {
    const original = _nb({ n_code: 1, output_size: 100 });
    const stripped = strip_notebook(original);
    expect((stripped["cells"] as Array<Record<string, unknown>>)[0]!["outputs"]).toEqual([]);
  });

  it("test_code_cell_execution_count_nulled", () => {
    const original = _nb({ n_code: 1, output_size: 100 });
    const stripped = strip_notebook(original);
    expect((stripped["cells"] as Array<Record<string, unknown>>)[0]!["execution_count"]).toBeNull();
  });

  it("test_code_cell_source_preserved", () => {
    const original = _nb({ n_code: 1, output_size: 100 });
    const stripped = strip_notebook(original);
    expect((stripped["cells"] as Array<Record<string, unknown>>)[0]!["source"]).toEqual(["print(0)"]);
  });

  it("test_markdown_cell_untouched", () => {
    const original = {
      nbformat: 4,
      nbformat_minor: 5,
      metadata: {},
      cells: [_md_cell("# Hello")],
    };
    const stripped = strip_notebook(original);
    expect((stripped["cells"] as Array<Record<string, unknown>>)[0]).toEqual(_md_cell("# Hello"));
  });

  it("test_original_not_mutated", () => {
    const original = _nb({ n_code: 1, output_size: 100 });
    strip_notebook(original);
    expect(original.cells[0]!["outputs"]).not.toEqual([]);
  });

  it("test_multiple_code_cells", () => {
    const original = _nb({ n_code: 3, output_size: 100 });
    const stripped = strip_notebook(original);
    for (const cell of stripped["cells"] as Array<Record<string, unknown>>) {
      expect(cell["outputs"]).toEqual([]);
      expect(cell["execution_count"]).toBeNull();
    }
  });

  it("test_empty_cells_list", () => {
    const original = { nbformat: 4, nbformat_minor: 5, metadata: {}, cells: [] };
    const stripped = strip_notebook(original);
    expect(stripped["cells"]).toEqual([]);
  });

  it("test_notebook_level_metadata_preserved", () => {
    const meta = { kernelspec: { name: "python3" } };
    const original = { nbformat: 4, nbformat_minor: 5, metadata: meta, cells: [] };
    const stripped = strip_notebook(original);
    expect(stripped["metadata"]).toEqual(meta);
  });
});

// ---------------------------------------------------------------------------
// get_or_create_sidecar unit tests
// ---------------------------------------------------------------------------

describe("TestGetOrCreateSidecar", () => {
  it("test_creates_sidecar_for_new_content", () => {
    const tmp_path = makeTmpPath();
    const raw = Buffer.from(JSON.stringify(_nb({ n_code: 1, output_size: 100 })), "utf8");
    const [sidecar, created] = get_or_create_sidecar(raw, tmp_path);
    expect(created).toBe(true);
    expect(fs.existsSync(sidecar)).toBe(true);
  });

  it("test_sidecar_contains_stripped_content", () => {
    const tmp_path = makeTmpPath();
    const original = _nb({ n_code: 1, output_size: 100 });
    const raw = Buffer.from(JSON.stringify(original), "utf8");
    const [sidecar] = get_or_create_sidecar(raw, tmp_path);
    const result = JSON.parse(fs.readFileSync(sidecar, "utf8")) as Record<string, unknown>;
    expect((result["cells"] as Array<Record<string, unknown>>)[0]!["outputs"]).toEqual([]);
  });

  it("test_cache_hit_skips_rewrite", () => {
    const tmp_path = makeTmpPath();
    const raw = Buffer.from(JSON.stringify(_nb({ n_code: 1, output_size: 100 })), "utf8");
    const [sidecar1, created1] = get_or_create_sidecar(raw, tmp_path);
    expect(created1).toBe(true);
    const mtimeAfterFirst = fs.statSync(sidecar1).mtimeMs;
    const [sidecar2, created2] = get_or_create_sidecar(raw, tmp_path);
    expect(created2).toBe(false);
    expect(sidecar2).toBe(sidecar1);
    expect(fs.statSync(sidecar2).mtimeMs).toBe(mtimeAfterFirst);
  });

  it("test_different_content_different_sidecar", () => {
    const tmp_path = makeTmpPath();
    const rawA = Buffer.from(JSON.stringify(_nb({ n_code: 1, output_size: 100 })), "utf8");
    const rawB = Buffer.from(JSON.stringify(_nb({ n_code: 2, output_size: 100 })), "utf8");
    const [sidecarA] = get_or_create_sidecar(rawA, tmp_path);
    const [sidecarB] = get_or_create_sidecar(rawB, tmp_path);
    expect(sidecarA).not.toBe(sidecarB);
  });

  it("test_raises_for_invalid_json", () => {
    const tmp_path = makeTmpPath();
    expect(() => get_or_create_sidecar(Buffer.from("not json"), tmp_path)).toThrow();
  });

  it("test_raises_for_non_notebook_json", () => {
    const tmp_path = makeTmpPath();
    expect(() =>
      get_or_create_sidecar(Buffer.from(JSON.stringify({ foo: "bar" }), "utf8"), tmp_path),
    ).toThrow("Not a notebook");
  });
});

// ---------------------------------------------------------------------------
// pre_read integration tests
// ---------------------------------------------------------------------------

describe("TestNotebookPreRead", () => {
  // PORT: deferred to Layer 4 (depends on hooks_read.pre_read, not yet ported).
  it.skip("test_denies_notebook_with_large_outputs", () => {});
  // PORT: deferred to Layer 4 (depends on hooks_read.pre_read, not yet ported).
  it.skip("test_deny_context_has_sidecar_path", () => {});
  // PORT: deferred to Layer 4 (depends on hooks_read.pre_read, not yet ported).
  it.skip("test_small_notebook_passes_through", () => {});
  // PORT: deferred to Layer 4 (depends on hooks_read.pre_read, not yet ported).
  it.skip("test_non_notebook_file_passes_through", () => {});
  // PORT: deferred to Layer 4 (depends on hooks_read.pre_read, not yet ported).
  it.skip("test_windowed_read_exempt", () => {});
  // PORT: deferred to Layer 4 (depends on hooks_read.pre_read, not yet ported).
  it.skip("test_missing_notebook_passes_through", () => {});
  // PORT: deferred to Layer 4 (depends on hooks_read.pre_read, not yet ported).
  it.skip("test_fail_soft_on_corrupt_notebook", () => {});
});
