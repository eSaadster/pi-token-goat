/**
 * 1:1 port of tests/test_embeddings.py.
 *
 * Port model:
 *  - fastembed has no bundled Node backend, so `is_available()` defaults to
 *    false and the real `embed_texts` raises EmbeddingsUnavailable. The Python
 *    tests `monkeypatch.setattr(emb, "embed_texts", _stub_embed)` /
 *    `patch.object(emb, "is_available", …)` become `vi.spyOn(emb, …)`. Because
 *    the module calls these through `import * as self`, the spies are observed.
 *    The stub-cycle tests spy BOTH embed_texts (stub) AND is_available (true) —
 *    in the Python env fastembed-installed made both work for free.
 *  - sqlite-vec IS available (db.ts loads the optional native extension), so the
 *    vec0 storage + KNN MATCH path runs for REAL under the deterministic stub.
 *  - CLI tests are DEFERRED (it.skip) until the `cli` port lands, same as the
 *    stats-CLI deferrals.
 *  - `_load_existing_chunk_hashes` returns a Map keyed by a NUL-joined
 *    `${file_rel} ${start} ${end}` string (the Python tuple key); tests decode it.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import * as db from "../src/token_goat/db.js";
import * as emb from "../src/token_goat/embeddings.js";
import {
  SearchHit,
  _check_vec_available,
  _pack_vec,
  extract_chunks_for_file,
  is_available,
  merge_nearby_hits,
} from "../src/token_goat/embeddings.js";
import { EmbeddingsUnavailable } from "../src/token_goat/embeddings.js";
import { index_project } from "../src/token_goat/parser.js";
import { make_project_at } from "../src/token_goat/project.js";
import type { Project } from "../src/token_goat/project.js";
import { invoke } from "./_cli_runner.js";

const NUL = "\u0000";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const FIXTURE_DIR = path.resolve(__dirname, "..", "..", "tests", "fixtures");
const _tmpRoots: string[] = [];

function tmpPath(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `tg-emb-${process.pid}-${_tmpRoots.length}-`));
  _tmpRoots.push(dir);
  return dir;
}

let _savedCwd: string | null = null;

afterEach(() => {
  vi.restoreAllMocks();
  if (_savedCwd !== null) {
    try {
      process.chdir(_savedCwd);
    } catch {
      // best-effort
    }
    _savedCwd = null;
  }
  while (_tmpRoots.length) {
    const d = _tmpRoots.pop()!;
    try {
      fs.rmSync(d, { recursive: true, force: true });
    } catch {
      // best-effort
    }
  }
});

function makeProjectAtRoot(root: string): Project {
  fs.mkdirSync(path.join(root, ".git"), { recursive: true });
  return make_project_at(root);
}

/** Copy the ts_sample fixture to a tmp dir, index it, return the Project. */
async function indexedTsProject(): Promise<Project> {
  const projRoot = path.join(tmpPath(), "ts_sample");
  fs.cpSync(path.join(FIXTURE_DIR, "ts_sample"), projRoot, { recursive: true });
  const proj = makeProjectAtRoot(projRoot);
  await index_project(proj, { full: true });
  return proj;
}

/**
 * Deterministic stand-in for embed_texts — no model, no download. Mirrors the
 * Python `_stub_embed`: sha256 → DEFAULT_DIM bytes → L2-normalized vector.
 */
function _stubEmbed(texts: readonly string[]): number[][] {
  const out: number[][] = [];
  for (const text of texts) {
    const digest = crypto.createHash("sha256").update(text, "utf-8").digest();
    const reps = Math.floor(emb.DEFAULT_DIM / digest.length) + 1;
    const repeated = Buffer.concat(Array(reps).fill(digest)).subarray(0, emb.DEFAULT_DIM);
    const vec = Array.from(repeated, (b) => b / 255.0 - 0.5);
    const norm = Math.sqrt(vec.reduce((s, x) => s + x * x, 0)) || 1.0;
    out.push(vec.map((x) => x / norm));
  }
  return out;
}

/** Install the stub embed backend + force is_available true (the Python env default). */
function useStubEmbed(): void {
  vi.spyOn(emb, "embed_texts").mockImplementation(((texts: readonly string[]) =>
    _stubEmbed(texts)) as typeof emb.embed_texts);
  vi.spyOn(emb, "is_available").mockReturnValue(true);
}

// ---------------------------------------------------------------------------
// Unit tests (no model download)
// ---------------------------------------------------------------------------

describe("unit", () => {
  it("test_is_available_default_false", () => {
    // PORT: Python asserts is_available() True because fastembed is installed.
    // No fastembed Node backend is bundled here, so the real-path default is
    // false; the stub-cycle tests spy it to true (mirroring fastembed-installed).
    expect(is_available()).toBe(false);
  });

  it("test_pack_vec_byte_length", () => {
    const result = _pack_vec([1.0, 2.0, 3.0]);
    expect(result.length).toBe(12);
  });

  it("test_pack_vec_round_trips", () => {
    const original = [0.1, 0.5, -0.3, 1.0];
    const packed = _pack_vec(original);
    const unpacked = Array.from(
      new Float32Array(packed.buffer, packed.byteOffset, original.length),
    );
    expect(unpacked.length).toBe(original.length);
    for (let i = 0; i < original.length; i++) {
      expect(Math.abs(unpacked[i]! - original[i]!)).toBeLessThan(1e-5);
    }
  });

  it("test_check_vec_available_true", () => {
    db.openProject("e0bedded0e0bedded0e0bedded0e0bedded00001", (conn) => {
      expect(_check_vec_available(conn as never)).toBe(true);
    });
  });

  it("test_check_vec_available_false", () => {
    const conn = {
      prepare: () => ({
        get: () => {
          throw Object.assign(new Error("no such function: vec_version"), {
            code: "SQLITE_ERROR",
          });
        },
      }),
    };
    expect(_check_vec_available(conn as never)).toBe(false);
  });

  it("test_extract_chunks_for_file_finds_symbols", async () => {
    const ts_project = await indexedTsProject();
    const chunks = db.openProject(ts_project.hash, (conn) =>
      extract_chunks_for_file(ts_project, conn as never, "index.ts"),
    );
    expect(chunks.length).toBeGreaterThanOrEqual(1);
    const kinds = new Set(chunks.map((c) => c.kind));
    const codeKinds = ["function", "class", "method", "interface", "type"];
    expect(codeKinds.some((k) => kinds.has(k))).toBe(true);
  });

  it("test_extract_chunks_greet_content", async () => {
    const ts_project = await indexedTsProject();
    const chunks = db.openProject(ts_project.hash, (conn) =>
      extract_chunks_for_file(ts_project, conn as never, "index.ts"),
    );
    const greet = chunks.filter((c) => c.text.includes("greet") && c.kind === "function");
    expect(greet.length).toBeGreaterThan(0);
    expect(greet[0]!.text.toLowerCase()).toContain("hello");
  });

  it("test_extract_chunks_text_length_bounds", async () => {
    const ts_project = await indexedTsProject();
    const chunks = db.openProject(ts_project.hash, (conn) =>
      extract_chunks_for_file(ts_project, conn as never, "index.ts"),
    );
    for (const chunk of chunks) {
      expect(chunk.text.length).toBeGreaterThanOrEqual(emb.MIN_CHUNK_CHARS);
      expect(chunk.text.length).toBeLessThanOrEqual(emb.MAX_CHUNK_CHARS);
    }
  });

  it("test_extract_chunks_empty_file", async () => {
    const ts_project = await indexedTsProject();
    fs.writeFileSync(path.join(ts_project.root, "empty.ts"), "", "utf-8");
    const chunks = db.openProject(ts_project.hash, (conn) =>
      extract_chunks_for_file(ts_project, conn as never, "empty.ts"),
    );
    expect(chunks).toEqual([]);
  });

  it("test_extract_chunks_missing_file", async () => {
    const ts_project = await indexedTsProject();
    const chunks = db.openProject(ts_project.hash, (conn) =>
      extract_chunks_for_file(ts_project, conn as never, "nonexistent.ts"),
    );
    expect(chunks).toEqual([]);
  });

  it("test_embeddings_unavailable_when_fastembed_missing", async () => {
    const ts_project = await indexedTsProject();
    vi.spyOn(emb, "is_available").mockReturnValue(false);
    expect(() => emb.index_project_embeddings(ts_project)).toThrow(/fastembed not installed/);
  });

  it("test_semantic_search_unavailable_when_fastembed_missing", async () => {
    const ts_project = await indexedTsProject();
    vi.spyOn(emb, "is_available").mockReturnValue(false);
    expect(() => emb.semantic_search(ts_project, "hello world")).toThrow(/fastembed not installed/);
  });

  it("test_semantic_search_unavailable_when_vec_missing", async () => {
    const ts_project = await indexedTsProject();
    const fakeVec = new Array(emb.DEFAULT_DIM).fill(0.1);
    vi.spyOn(emb, "is_available").mockReturnValue(true);
    vi.spyOn(emb, "embed_texts").mockReturnValue([fakeVec]);
    vi.spyOn(emb, "_check_vec_available").mockReturnValue(false);
    expect(() => emb.semantic_search(ts_project, "hello world")).toThrow(/sqlite-vec not loaded/);
  });
});

// ---------------------------------------------------------------------------
// CLI integration tests — DEFERRED until the `cli` port lands.
// ---------------------------------------------------------------------------

describe("cli (semantic command — batch A part 2)", () => {
  it("test_cli_semantic_no_project — exits non-zero with 'project'", async () => {
    const projectMod = await import("../src/token_goat/project.js");
    const spy = projectMod.find_project;
    const findSpy = vi.spyOn(projectMod, "find_project").mockReturnValue(null);
    void spy;
    try {
      const r = await invoke(["semantic", "foo bar"]);
      expect(r.exit_code).not.toBe(0);
      expect(r.output.toLowerCase()).toContain("project");
    } finally {
      findSpy.mockRestore();
    }
  });

  it("test_cli_semantic_no_embeddings — exits 0 with 'embeddings unavailable'", async () => {
    const ts_project = await indexedTsProject();
    _savedCwd = process.cwd();
    process.chdir(ts_project.root);
    // Force embed_texts to raise so we exercise the EmbeddingsUnavailable path.
    vi.spyOn(emb, "embed_texts").mockImplementation(() => {
      throw new EmbeddingsUnavailable("test");
    });
    const r = await invoke(["semantic", "test query"]);
    expect(r.exit_code).toBe(0);
    expect(r.output.toLowerCase()).toContain("embeddings unavailable");
  });

  // test_cli_index_embeddings_no_project: needs the `index --embeddings` command
  // (batch H, not yet ported). Left skipped until index lands.
  it.skip("test_cli_index_embeddings_no_project — needs `index --embeddings` (batch H)", () => {});

  it("test_cli_semantic_with_stub_embeddings — returns results, 'd=' present", async () => {
    const ts_project = await indexedTsProject();
    useStubEmbed();
    emb.index_project_embeddings(ts_project);
    _savedCwd = process.cwd();
    process.chdir(ts_project.root);
    // The stub model produces ~uniform cosine distances (~1.28); pass a generous
    // threshold so this exercises CLI output, not the threshold filter.
    const r = await invoke([
      "semantic",
      "user service greeting",
      "-k",
      "3",
      "--max-distance",
      "99",
      "--full",
    ]);
    expect(r.exit_code).toBe(0);
    expect(r.output).toContain("d=");
  });

  it("test_cli_semantic_with_embeddings — returns results with index.ts + d=", async () => {
    const ts_project = await indexedTsProject();
    useStubEmbed();
    emb.index_project_embeddings(ts_project);
    _savedCwd = process.cwd();
    process.chdir(ts_project.root);
    const r = await invoke([
      "semantic",
      "hello name greeting",
      "-k",
      "3",
      "--max-distance",
      "99",
      "--full",
    ]);
    expect(r.exit_code).toBe(0);
    expect(r.output).toContain("index.ts");
    expect(r.output).toContain("d=");
  });

  it("test_cli_semantic_max_distance_flag — tiny threshold collapses results", async () => {
    const ts_project = await indexedTsProject();
    useStubEmbed();
    emb.index_project_embeddings(ts_project);
    _savedCwd = process.cwd();
    process.chdir(ts_project.root);
    const r = await invoke([
      "semantic",
      "nonsense gibberish xyzzy",
      "-k",
      "5",
      "--max-distance",
      "0.001",
    ]);
    expect(r.exit_code).toBe(0);
    expect(r.output).toContain("(no results)");
  });

  it("test_cli_semantic_keyword_fallback — keyword fallback message", async () => {
    const ts_project = await indexedTsProject();
    _savedCwd = process.cwd();
    process.chdir(ts_project.root);
    vi.spyOn(emb, "embed_texts").mockImplementation(() => {
      throw new EmbeddingsUnavailable("not ready");
    });
    const r = await invoke(["semantic", "greet hello", "-k", "5"]);
    expect(r.exit_code).toBe(0);
    expect(r.output.toLowerCase()).toContain("keyword fallback");
  });

  it("test_cli_semantic_keyword_fallback_json — JSON includes 'fallback' key", async () => {
    const ts_project = await indexedTsProject();
    _savedCwd = process.cwd();
    process.chdir(ts_project.root);
    vi.spyOn(emb, "embed_texts").mockImplementation(() => {
      throw new EmbeddingsUnavailable("not ready");
    });
    const r = await invoke(["semantic", "greet hello", "-k", "5", "--json"]);
    expect(r.exit_code).toBe(0);
    const jsonLine = (r.output.split("\n").reverse() as string[]).find((l) =>
      l.trim().startsWith("{"),
    );
    expect(jsonLine, `no JSON in output: ${JSON.stringify(r.output)}`).toBeTruthy();
    const data = JSON.parse(jsonLine!.trim());
    expect("fallback" in data).toBe(true);
  });

  it("test_cli_semantic_default_k_is_8 (cli half) — --help shows default k=8", async () => {
    const ts_project = await indexedTsProject();
    useStubEmbed();
    emb.index_project_embeddings(ts_project);
    _savedCwd = process.cwd();
    process.chdir(ts_project.root);
    const r = await invoke([
      "semantic",
      "greet hello user service",
      "--max-distance",
      "99",
      "--full",
    ]);
    expect(r.exit_code).toBe(0);
    // Verify the CLI option default is 8 by inspecting --help.
    const help = await invoke(["semantic", "--help"]);
    expect(help.output).toContain("8");
  });

  it("test_cli_semantic_compact_output_includes_kind — [kind] bracket per line", async () => {
    const ts_project = await indexedTsProject();
    useStubEmbed();
    emb.index_project_embeddings(ts_project);
    _savedCwd = process.cwd();
    process.chdir(ts_project.root);
    const r = await invoke([
      "semantic",
      "greet hello",
      "-k",
      "3",
      "--max-distance",
      "99",
    ]);
    expect(r.exit_code).toBe(0);
    const resultLines = r.output
      .split("\n")
      .filter((l) => l.trim().length > 0 && !l.startsWith("("));
    expect(resultLines.length).toBeGreaterThan(0);
    for (const ln of resultLines) {
      expect(ln.includes("[") && ln.includes("]")).toBe(true);
    }
  });

  it("test_cli_semantic_compact_output_first_line_snippet — first non-blank line", async () => {
    const ts_project = await indexedTsProject();
    useStubEmbed();
    emb.index_project_embeddings(ts_project);
    _savedCwd = process.cwd();
    process.chdir(ts_project.root);
    // Pick an exact-match query so we control which chunk surfaces first.
    const row = db.openProject(ts_project.hash, (conn) => {
      return conn.prepare("SELECT text, file_rel, start_line FROM chunks LIMIT 1").get() as {
        text: string;
        file_rel: string;
        start_line: number;
      };
    });
    const r = await invoke(["semantic", row.text, "-k", "1", "--max-distance", "99"]);
    expect(r.exit_code).toBe(0);
    const expectedFirst = (row.text.split(/\r\n|\r|\n/).find((l) => l.trim()) ?? "").trim().slice(0, 120);
    expect(expectedFirst.length).toBeGreaterThan(0);
    expect(r.output).toContain(expectedFirst);
  });
});

// ---------------------------------------------------------------------------
// Stub-model integration: real sqlite-vec storage + query path
// ---------------------------------------------------------------------------

describe("stub-model embed/search cycle", () => {
  it("test_embed_and_search_cycle_with_stub", async () => {
    const ts_project = await indexedTsProject();
    useStubEmbed();

    const result = emb.index_project_embeddings(ts_project);
    expect(result.chunks_embedded).toBeGreaterThan(0);
    expect(result.files_visited).toBeGreaterThanOrEqual(1);

    const result2 = emb.index_project_embeddings(ts_project);
    expect(result2.chunks_embedded).toBe(0);
    expect(result2.chunks_skipped_unchanged).toBe(result.chunks_embedded);

    const row = db.openProject(ts_project.hash, (conn) =>
      conn.prepare("SELECT text, file_rel, start_line FROM chunks LIMIT 1").get() as {
        text: string;
        file_rel: string;
        start_line: number;
      },
    );

    const hits = emb.semantic_search(ts_project, row.text, { k: 5 });
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0]!.text).toBe(row.text);
    expect(hits[0]!.file_rel).toBe(row.file_rel);
    expect(hits[0]!.distance).toBeLessThan(1e-3);
    const sorted = [...hits].sort((a, b) => a.distance - b.distance);
    expect(hits).toEqual(sorted);
  });

  it("test_full_embedding_cycle", async () => {
    const ts_project = await indexedTsProject();
    useStubEmbed();

    const result = emb.index_project_embeddings(ts_project);
    expect(result.chunks_embedded).toBeGreaterThan(0);
    expect(result.model).toBe(emb.DEFAULT_MODEL);
    expect(result.files_visited).toBeGreaterThanOrEqual(1);

    const result2 = emb.index_project_embeddings(ts_project);
    expect(result2.chunks_skipped_unchanged).toBe(result.chunks_embedded);
    expect(result2.chunks_embedded).toBe(0);

    const row = db.openProject(ts_project.hash, (conn) =>
      conn.prepare("SELECT text, file_rel, start_line FROM chunks LIMIT 1").get() as {
        text: string;
        file_rel: string;
        start_line: number;
      },
    );

    const hits = emb.semantic_search(ts_project, row.text, { k: 5 });
    expect(hits.length).toBeGreaterThanOrEqual(1);
    const top = hits[0]!;
    expect(top.text).toBe(row.text);
    expect(top.file_rel).toBe(row.file_rel);
    expect(top.distance).toBeGreaterThanOrEqual(0.0);
    expect(top.distance).toBeLessThanOrEqual(2.0);
  });

  it("test_semantic_search_threshold_drops_noise", async () => {
    const ts_project = await indexedTsProject();
    useStubEmbed();
    emb.index_project_embeddings(ts_project);

    const row = db.openProject(ts_project.hash, (conn) =>
      conn.prepare("SELECT text, file_rel FROM chunks LIMIT 1").get() as {
        text: string;
        file_rel: string;
      },
    );

    const loose = emb.semantic_search(ts_project, row.text, { k: 5, max_distance: null });
    const tight = emb.semantic_search(ts_project, row.text, { k: 5, max_distance: 0.05 });
    expect(tight.length).toBeGreaterThan(0);
    expect(tight[0]!.file_rel).toBe(row.file_rel);
    expect(tight[0]!.distance).toBeLessThan(0.05);
    expect(tight.length).toBeLessThanOrEqual(loose.length);
  });

  it("test_semantic_default_k_is_8", async () => {
    // PORT: Python inspects the signature default (k=8). TS has no introspection
    // of options-object defaults, so verify behaviorally: with no k passed, the
    // default fetch path caps results at 8.
    const ts_project = await indexedTsProject();
    useStubEmbed();
    emb.index_project_embeddings(ts_project);
    const hits = emb.semantic_search(ts_project, "greet hello user service", {
      max_distance: 99,
    });
    expect(hits.length).toBeLessThanOrEqual(8);
  });
});

// ---------------------------------------------------------------------------
// Re-rank helpers: pure-function unit tests
// ---------------------------------------------------------------------------

describe("rerank helpers", () => {
  it("test_is_generated_path_segment_match", () => {
    expect(emb._is_generated_path("node_modules/foo/bar.js")).toBe(true);
    expect(emb._is_generated_path("a/dist/x.js")).toBe(true);
    expect(emb._is_generated_path("src/__pycache__/x.pyc")).toBe(true);
    expect(emb._is_generated_path("a/.venv/lib/x.py")).toBe(true);
    expect(emb._is_generated_path("a\\node_modules\\b.js")).toBe(true);
    expect(emb._is_generated_path("src/my_dist.py")).toBe(false);
    expect(emb._is_generated_path("src/distributed/x.py")).toBe(false);
    expect(emb._is_generated_path("")).toBe(false);
  });

  it("test_extract_query_tokens_splits_case_and_drops_short", () => {
    const toks = emb._extract_query_tokens("RateLimiter retry of N items");
    expect(toks.has("rate")).toBe(true);
    expect(toks.has("limiter")).toBe(true);
    expect(toks.has("ratelimiter")).toBe(true);
    expect(toks.has("retry")).toBe(true);
    expect(toks.has("of")).toBe(false);
    expect(toks.has("n")).toBe(false);
  });

  it("test_extract_query_tokens_empty", () => {
    expect(emb._extract_query_tokens("").size).toBe(0);
    expect(emb._extract_query_tokens("a b c").size).toBe(0);
  });

  it("test_verbatim_boost_caps_at_max", () => {
    const tokens = new Set(["alpha", "beta", "gamma", "delta", "epsilon", "zeta"]);
    const text = [...tokens].join(" ");
    const boost = emb._verbatim_boost(text, tokens);
    expect(boost).toBeCloseTo(emb._MAX_VERBATIM_BOOST);
    expect(boost).toBeGreaterThan(0);
  });

  it("test_verbatim_boost_zero_when_no_overlap", () => {
    expect(emb._verbatim_boost("nothing relevant here", new Set(["foo", "bar"]))).toBe(0.0);
  });

  const row = (
    file_rel: string,
    text: string,
    distance: number,
    start = 1,
    end = 5,
    kind = "function",
  ): { file_rel: string; start_line: number; end_line: number; kind: string; text: string; distance: number } => ({
    file_rel,
    start_line: start,
    end_line: end,
    kind,
    text,
    distance,
  });

  it("test_rerank_demotes_generated_paths", () => {
    const rows = [
      row("node_modules/lib/index.js", "fn doStuff() {}", 0.1),
      row("src/app.ts", "fn doStuff() {}", 0.12),
    ];
    const hits = emb._rerank_hits(rows, "doStuff", {
      k: 5,
      max_distance: null,
      boost_verbatim: false,
      demote_generated: true,
    });
    expect(hits.map((h) => h.file_rel)).toEqual(["src/app.ts", "node_modules/lib/index.js"]);
    const genHit = hits.find((h) => h.file_rel.includes("node_modules"))!;
    expect(genHit.distance).toBeCloseTo(0.1 + 0.5);
  });

  it("test_rerank_verbatim_boost_lifts_exact_match", () => {
    const rows = [
      row("src/a.py", "def throttle_helper(): pass", 0.3),
      row("src/b.py", "class RateLimiter: ...", 0.4),
    ];
    const hits = emb._rerank_hits(rows, "RateLimiter", {
      k: 5,
      max_distance: null,
      boost_verbatim: true,
      demote_generated: false,
    });
    expect(hits[0]!.file_rel).toBe("src/b.py");
    expect(hits[1]!.file_rel).toBe("src/a.py");
  });

  it("test_rerank_threshold_filters_low_confidence", () => {
    const rows = [
      row("src/a.py", "good match", 0.2),
      row("src/b.py", "marginal", 0.8),
      row("src/c.py", "noise", 1.5),
    ];
    const hits = emb._rerank_hits(rows, "good", {
      k: 5,
      max_distance: 1.0,
      boost_verbatim: false,
      demote_generated: false,
    });
    const files = hits.map((h) => h.file_rel);
    expect(files).toContain("src/a.py");
    expect(files).toContain("src/b.py");
    expect(files).not.toContain("src/c.py");
  });

  it("test_rerank_threshold_none_disables_filter", () => {
    const rows = Array.from({ length: 5 }, (_, i) => row(`src/${i}.py`, "x", i));
    const hits = emb._rerank_hits(rows, "x", {
      k: 10,
      max_distance: null,
      boost_verbatim: false,
      demote_generated: false,
    });
    expect(hits.length).toBe(5);
  });

  it("test_rerank_truncates_to_k", () => {
    const rows = Array.from({ length: 10 }, (_, i) => row(`src/${i}.py`, "x", i * 0.1));
    const hits = emb._rerank_hits(rows, "x", {
      k: 3,
      max_distance: null,
      boost_verbatim: false,
      demote_generated: false,
    });
    expect(hits.length).toBe(3);
    const sorted = [...hits].sort((a, b) => a.distance - b.distance);
    expect(hits).toEqual(sorted);
  });
});

// ---------------------------------------------------------------------------
// merge_nearby_hits: pure-function unit tests
// ---------------------------------------------------------------------------

describe("merge_nearby_hits", () => {
  const makeHit = (file_rel: string, start: number, end: number, distance = 0.5): SearchHit =>
    new SearchHit({ file_rel, start_line: start, end_line: end, kind: "function", text: "x", distance });

  it("test_merge_nearby_hits_empty", () => {
    expect(merge_nearby_hits([])).toEqual([]);
  });

  it("test_merge_nearby_hits_single", () => {
    const h = makeHit("a.py", 1, 10);
    expect(merge_nearby_hits([h])).toEqual([h]);
  });

  it("test_merge_nearby_hits_overlapping_same_file", () => {
    const merged = merge_nearby_hits([makeHit("a.py", 1, 30, 0.3), makeHit("a.py", 25, 50, 0.4)]);
    expect(merged.length).toBe(1);
    expect(merged[0]!.start_line).toBe(1);
    expect(merged[0]!.end_line).toBe(50);
    expect(merged[0]!.distance).toBeCloseTo(0.3);
  });

  it("test_merge_nearby_hits_within_proximity", () => {
    const merged = merge_nearby_hits([makeHit("a.py", 1, 10, 0.3), makeHit("a.py", 25, 35, 0.2)], 20);
    expect(merged.length).toBe(1);
    expect(merged[0]!.start_line).toBe(1);
    expect(merged[0]!.end_line).toBe(35);
    expect(merged[0]!.distance).toBeCloseTo(0.2);
  });

  it("test_merge_nearby_hits_beyond_proximity_not_merged", () => {
    const merged = merge_nearby_hits([makeHit("a.py", 1, 10), makeHit("a.py", 50, 60)], 20);
    expect(merged.length).toBe(2);
  });

  it("test_merge_nearby_hits_different_files_not_merged", () => {
    const merged = merge_nearby_hits([makeHit("a.py", 1, 10), makeHit("b.py", 5, 15)]);
    expect(merged.length).toBe(2);
  });

  it("test_merge_nearby_hits_sorted_by_distance", () => {
    const merged = merge_nearby_hits([makeHit("a.py", 1, 10, 0.8), makeHit("b.py", 1, 10, 0.3)]);
    expect(merged.length).toBe(2);
    expect(merged[0]!.file_rel).toBe("b.py");
    expect(merged[1]!.file_rel).toBe("a.py");
  });

  it("test_merge_nearby_hits_three_chunk_function", () => {
    const merged = merge_nearby_hits([
      makeHit("a.py", 1, 30, 0.4),
      makeHit("a.py", 25, 60, 0.3),
      makeHit("a.py", 55, 90, 0.5),
    ]);
    expect(merged.length).toBe(1);
    expect(merged[0]!.start_line).toBe(1);
    expect(merged[0]!.end_line).toBe(90);
    expect(merged[0]!.distance).toBeCloseTo(0.3);
  });
});

// ---------------------------------------------------------------------------
// _load_existing_chunk_hashes with file_rels filtering
// ---------------------------------------------------------------------------

describe("_load_existing_chunk_hashes", () => {
  it("test_load_chunk_hashes_all_files", async () => {
    const ts_project = await indexedTsProject();
    useStubEmbed();
    emb.index_project_embeddings(ts_project);

    const all_hashes = db.openProject(ts_project.hash, (conn) =>
      emb._load_existing_chunk_hashes(conn as never, null),
    );

    expect(all_hashes.size).toBeGreaterThan(0);
    for (const key of all_hashes.keys()) {
      const parts = key.split(NUL);
      expect(parts.length).toBe(3);
      expect(typeof parts[0]).toBe("string");
      expect(Number.isInteger(Number(parts[1]))).toBe(true);
      expect(Number.isInteger(Number(parts[2]))).toBe(true);
    }
  });

  it("test_load_chunk_hashes_specific_file", async () => {
    const ts_project = await indexedTsProject();
    useStubEmbed();
    emb.index_project_embeddings(ts_project);

    const all_rels = db.openProject(ts_project.hash, (conn) =>
      [
        ...new Set(
          (conn.prepare("SELECT DISTINCT file_rel FROM chunks").all() as Array<{ file_rel: string }>).map(
            (r) => r.file_rel,
          ),
        ),
      ].sort(),
    );
    expect(all_rels.length).toBeGreaterThan(0);
    const target = all_rels[0]!;

    const { filtered, full } = db.openProject(ts_project.hash, (conn) => ({
      filtered: emb._load_existing_chunk_hashes(conn as never, [target]),
      full: emb._load_existing_chunk_hashes(conn as never, null),
    }));

    for (const key of filtered.keys()) {
      expect(key.split(NUL)[0]).toBe(target);
    }
    // filtered is a subset of full (same key → same value).
    for (const [k, v] of filtered) {
      expect(full.get(k)).toBe(v);
    }
    if (all_rels.length > 1) {
      expect(filtered.size).toBeLessThan(full.size);
    }
  });

  it("test_load_chunk_hashes_empty_list_returns_empty_no_sql", () => {
    const prepare = vi.fn();
    const conn = { prepare };
    const result = emb._load_existing_chunk_hashes(conn as never, []);
    expect(result.size).toBe(0);
    expect(prepare).not.toHaveBeenCalled();
  });

  it("test_load_chunk_hashes_large_project_filtered", () => {
    const proj = make_project_at(tmpPath());

    db.openProject(proj.hash, (conn) => {
      const nTotal = 1500;
      const fileStmt = conn.prepare(
        "INSERT OR IGNORE INTO files(rel_path, mtime, content_sha256, language, size, line_count, indexed_at)" +
          " VALUES (?, ?, ?, 'python', ?, ?, ?)",
      );
      const chunkStmt = conn.prepare(
        "INSERT OR IGNORE INTO chunks(file_rel, start_line, end_line, content_sha256, kind, text) VALUES (?, ?, ?, ?, ?, ?)",
      );
      const tx = conn.transaction(() => {
        for (let i = 0; i < nTotal; i++) {
          fileStmt.run(
            `src/file_${i}.py`,
            0.0,
            crypto.createHash("sha256").update(`file_${i}`).digest("hex"),
            0,
            10,
            0,
          );
          chunkStmt.run(
            `src/file_${i}.py`,
            0,
            10,
            crypto.createHash("sha256").update(`chunk_${i}`).digest("hex"),
            "function",
            `def f_${i}(): pass`,
          );
        }
      });
      tx();
    });

    const target_rels = Array.from({ length: 10 }, (_, i) => `src/file_${i}.py`);
    const result = db.openProject(proj.hash, (conn) =>
      emb._load_existing_chunk_hashes(conn as never, target_rels),
    );

    expect(result.size).toBe(10);
    for (const key of result.keys()) {
      expect(target_rels).toContain(key.split(NUL)[0]);
    }
  });
});

// ---------------------------------------------------------------------------
// New file-type coverage (SQL, GraphQL, Proto, CSS, Makefile)
// ---------------------------------------------------------------------------

describe("file-type coverage", () => {
  it("test_code_symbol_kinds_includes_new_file_types", () => {
    const K = emb._CODE_SYMBOL_KINDS;
    for (const k of [
      "sql_table", "sql_view", "sql_function", "sql_trigger",
      "graphql_type", "graphql_input", "graphql_query", "graphql_mutation",
      "proto_message", "proto_service", "proto_enum",
      "css_class", "css_keyframes",
      "makefile_target", "makefile_define",
    ]) {
      expect(K.has(k)).toBe(true);
    }
  });

  it("test_window_langs_includes_new_file_types", () => {
    const L = emb._WINDOW_LANGS;
    for (const lang of ["typescript", "python", "go", "sql", "graphql", "proto", "css", "makefile"]) {
      expect(L.has(lang)).toBe(true);
    }
  });

  it("test_extract_chunks_sql_file", async () => {
    const projRoot = path.join(tmpPath(), "sql_proj");
    fs.mkdirSync(projRoot, { recursive: true });
    const sqlContent = `CREATE TABLE users (
    id SERIAL PRIMARY KEY,
    email VARCHAR(255) NOT NULL UNIQUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE posts (
    id SERIAL PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id),
    title TEXT NOT NULL,
    body TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE FUNCTION get_user_posts(user_id INTEGER)
RETURNS TABLE(title TEXT, created_at TIMESTAMPTZ) AS $$
    SELECT title, created_at FROM posts WHERE user_id = $1;
$$ LANGUAGE SQL;
`;
    fs.writeFileSync(path.join(projRoot, "schema.sql"), sqlContent, "utf-8");
    const proj = makeProjectAtRoot(projRoot);
    await index_project(proj, { full: true });

    const chunks = db.openProject(proj.hash, (conn) =>
      extract_chunks_for_file(proj, conn as never, "schema.sql"),
    );
    expect(chunks.length).toBeGreaterThanOrEqual(1);
    const kinds = new Set(chunks.map((c) => c.kind));
    const expected = ["section", "sql_table", "sql_function", "sql_view", "sql_trigger", "window"];
    expect(expected.some((k) => kinds.has(k))).toBe(true);
  });

  it("test_extract_chunks_graphql_file", async () => {
    const projRoot = path.join(tmpPath(), "gql_proj");
    fs.mkdirSync(projRoot, { recursive: true });
    const gqlContent = `type User {
  id: ID!
  email: String!
  posts: [Post!]!
}

type Post {
  id: ID!
  title: String!
  body: String
  author: User!
}

type Query {
  user(id: ID!): User
  posts: [Post!]!
}

type Mutation {
  createPost(title: String!, body: String): Post!
}
`;
    fs.writeFileSync(path.join(projRoot, "schema.graphql"), gqlContent, "utf-8");
    const proj = makeProjectAtRoot(projRoot);
    await index_project(proj, { full: true });

    const chunks = db.openProject(proj.hash, (conn) =>
      extract_chunks_for_file(proj, conn as never, "schema.graphql"),
    );
    expect(chunks.length).toBeGreaterThanOrEqual(1);
    const kinds = new Set(chunks.map((c) => c.kind));
    const expected = ["section", "graphql_type", "graphql_query", "graphql_mutation", "window"];
    expect(expected.some((k) => kinds.has(k))).toBe(true);
  });
});
