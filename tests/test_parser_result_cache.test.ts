/**
 * Tests for the SHA-keyed extraction result LRU cache in parser.ts.
 *
 * Faithful 1:1 port of tests/test_parser_result_cache.py. Strict NodeNext ESM.
 *
 * These tests focus on call-count assertions rather than wall-clock — the
 * cache's value is "we don't call the extractor twice for the same bytes",
 * which is invariant across hardware.
 *
 * -----
 * Port notes / adaptations (all faithful to the cache contract)
 * -----
 *  - The Python `_isolate_result_cache` autouse fixture snapshots and restores
 *    `parser._EXTRACTOR_REGISTRY` / `parser._EXTRACTOR_CACHE` around each test.
 *    In the TS port those two module-private Maps are NOT exported (only
 *    `_result_cache_get` / `_result_cache_put` / `parser_cache_clear` /
 *    `parser_cache_stats` / `register_extractor` / `get_extractor` are). The
 *    per-test reset is instead handled by tests/setup.ts's beforeEach, which
 *    calls `clearModuleCaches()` — and parser.ts registers BOTH the result LRU
 *    AND the extractor cache with reset.ts (see registerReset at the bottom of
 *    the cache block), so every test starts with a clean cache graph. The
 *    explicit `parser_cache_clear()` at the top of each test mirrors the
 *    Python fixture's leading clear.
 *  - `py_project_unindexed` (a pytest fixture) is reproduced locally by
 *    `makePyProjectUnindexed()`: copy tests/fixtures/py_sample to a fresh tmp
 *    dir, build a Project via canonicalize + project_hash (mirroring conftest's
 *    make_project_from_root). The python GRAMMAR adapter is NOT ported this run
 *    (its extractor is null), but EVERY cache test that needs an extractor
 *    registers a FAKE one via register_extractor("python", ...) — exactly as
 *    the Python tests do — so the null real adapter never matters. The cache
 *    mechanism under test is language-agnostic; the fake extractor stands in.
 *  - `parser._RESULT_CACHE_MAX` is NOT exported (hardcoded 256). The Python
 *    `test_lru_evicts_oldest_entry` shrinks it to 3; here we instead insert
 *    _RESULT_CACHE_MAX + 2 entries to force exactly 2 evictions — the SAME
 *    observable contract (oldest evicted, newest retained, eviction count
 *    incremented). Reported as a missingExport (the mutable max) but the test
 *    stays GREEN by exercising the real ceiling.
 *  - `patch.object(parser._LOG, "exception")` (unittest.mock) has no vitest
 *    analogue against a non-exported logger. The log suppression in the Python
 *    test only quiets a simulated-crash stack trace; it does not affect any
 *    assertion. We let the error log emit (vitest captures stderr) and assert
 *    on the call count + cache stats, which is what the test actually verifies.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import * as parser from "../src/token_goat/parser.js";
import {
  ImpExp,
  Ref,
  Section,
  Symbol,
  type FileIndex,
  type Extractor,
  _result_cache_get,
  _result_cache_put,
  get_extractor,
  index_file,
  parser_cache_clear,
  parser_cache_stats,
  register_extractor,
} from "../src/token_goat/parser.js";
import { canonicalize, project_hash, type Project } from "../src/token_goat/project.js";

// ---------------------------------------------------------------------------
// py_project_unindexed analogue
// ---------------------------------------------------------------------------

/** Absolute path to the Python sample fixture (shared with the Python suite). */
const PY_SAMPLE = path.resolve(
  path.join(import.meta.dirname, "..", "..", "tests", "fixtures", "py_sample"),
);

/** Per-test tmp root; recreated in beforeEach so each test gets a clean tree. */
let tmpRoot = "";

beforeEach(() => {
  // setup.ts already gives us a per-test data dir; this tmp root is for the
  // project tree (copied py_sample). mkdtempSync guarantees uniqueness.
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "tg-rcache-"));
  // Start every test from a clean result LRU + extractor cache. setup.ts's
  // clearModuleCaches() already does this, but the Python fixture calls
  // parser_cache_clear() explicitly too — mirror it for parity.
  parser_cache_clear();
});

afterEach(() => {
  try {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  } catch {
    // best-effort
  }
});

/**
 * Copy py_sample into a fresh tmp dir, create a minimal .git marker, and build
 * a Project. Mirrors conftest._make_sample_project(indexed=False) +
 * make_project_from_root.
 */
function makePyProjectUnindexed(): Project {
  const projRoot = path.join(tmpRoot, "py_sample");
  fs.cpSync(PY_SAMPLE, projRoot, { recursive: true });
  fs.mkdirSync(path.join(projRoot, ".git"), { recursive: true });
  const canon = canonicalize(projRoot);
  return { root: canon, hash: project_hash(canon), marker: ".git" };
}

/** Recursively find the first file matching a predicate under *root*. */
function findFirst(root: string, predicate: (p: string) => boolean): string | null {
  const stack = [root];
  while (stack.length > 0) {
    const dir = stack.pop() as string;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        stack.push(full);
      } else if (predicate(full)) {
        return full;
      }
    }
  }
  return null;
}

/** `next(proj.root.rglob("*.py"))` — first .py file under the project root. */
function firstPy(proj: Project): string {
  const found = findFirst(proj.root, (p) => p.toLowerCase().endsWith(".py"));
  if (found === null) {
    throw new Error("no .py file found under py_sample fixture");
  }
  return found;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("test_parser_result_cache (port of tests/test_parser_result_cache.py)", () => {
  it("test_result_cache_starts_empty", () => {
    const stats = parser_cache_stats();
    expect(stats).toEqual({ hits: 0, misses: 0, evictions: 0, size: 0 });
  });

  it("test_same_bytes_hits_cache_and_skips_extractor", async () => {
    // Indexing the same file twice must only invoke the extractor once.
    const proj = makePyProjectUnindexed();
    const filePath = firstPy(proj);

    const callCount = { n: 0 };
    const realExtract = await get_extractor("python");
    // Python asserts `real_extract is not None`; in this port the real python
    // adapter is null (grammar not ported), but the test registers a counting
    // wrapper around WHATEVER get_extractor returns (real or a synthetic). The
    // cache contract under test is the same either way: the wrapper is the
    // registered extractor, and the second index_file must NOT call it.
    const countingExtract: Extractor = (source, rel) => {
      callCount.n += 1;
      if (realExtract !== null) {
        return realExtract(source, rel);
      }
      // Synthetic non-empty payload so the cache hit has something to mirror.
      return [[new Symbol({ name: "x", kind: "function", line: 1 })], [], [], []];
    };

    register_extractor("python", () => countingExtract);

    const fi1 = await index_file(proj, filePath);
    const fi2 = await index_file(proj, filePath);

    expect(fi1).not.toBeNull();
    expect(fi2).not.toBeNull();
    expect(callCount.n).toBe(1);
    expect(parser_cache_stats().hits).toBe(1);
    expect(parser_cache_stats().misses).toBe(1);
    // Cached result mirrors the live result.
    const fi1n = new Set((fi1 as FileIndex).symbols.map((s) => s.name));
    const fi2n = new Set((fi2 as FileIndex).symbols.map((s) => s.name));
    expect(fi1n).toEqual(fi2n);
  });

  it("test_content_change_misses_cache", async () => {
    // Different bytes produce a different SHA — the cache must NOT short-circuit.
    const proj = makePyProjectUnindexed();
    const filePath = firstPy(proj);
    const original = fs.readFileSync(filePath);

    const callCount = { n: 0 };
    const fakeExtract: Extractor = () => {
      callCount.n += 1;
      return [[new Symbol({ name: "x", kind: "function", line: 1 })], [], [], []];
    };

    register_extractor("python", () => fakeExtract);
    // Python does `parser._EXTRACTOR_CACHE.pop("python", None)` here to force a
    // fresh resolution; register_extractor already clears the cache for the
    // language, so the pop is redundant and omitted (the missing _EXTRACTOR_CACHE
    // export is tracked separately).

    await index_file(proj, filePath);
    fs.writeFileSync(filePath, Buffer.concat([original, Buffer.from("\n# tweak\n")]));
    await index_file(proj, filePath);

    expect(callCount.n).toBe(2);
    const stats = parser_cache_stats();
    expect(stats.misses).toBe(2);
    expect(stats.hits).toBe(0);
  });

  it("test_cache_returns_independent_lists", async () => {
    // Cached payload must be copy-safe: mutating one FileIndex's list must not
    // corrupt subsequent cache hits.
    const proj = makePyProjectUnindexed();
    const filePath = firstPy(proj);

    // Register a fake extractor that returns a non-empty payload so the
    // copy-safety assertion (len > 0 after clearing the first result) can hold.
    register_extractor("python", (): Extractor => () => [
      [new Symbol({ name: "x", kind: "function", line: 1 })],
      [],
      [],
      [],
    ]);

    const fi1 = await index_file(proj, filePath);
    expect(fi1).not.toBeNull();
    (fi1 as FileIndex).symbols.length = 0;
    (fi1 as FileIndex).refs.length = 0;
    const fi2 = await index_file(proj, filePath);
    expect(fi2).not.toBeNull();
    // Second hit must still have full symbol/ref payloads.
    expect(
      (fi2 as FileIndex).symbols.length > 0 || (fi2 as FileIndex).refs.length > 0,
    ).toBe(true);
  });

  it("test_lru_evicts_oldest_entry", () => {
    // When the LRU exceeds its ceiling, the least-recently-used entry evicts.
    //
    // ADAPTATION: Python shrank `parser._RESULT_CACHE_MAX` to 3 and inserted 5
    // entries, asserting size==3 / evictions==2. The TS port hardcodes the max
    // at 256 and does NOT export it for mutation (missingExport tracked). To
    // exercise the SAME eviction contract against the real ceiling we insert
    // (max + 2) entries: after the loop, size == max and evictions == 2. The
    // earliest entry (sha0) is gone; the most recent (sha{max+1}) remains.
    const MAX = 256; // parser.ts _RESULT_CACHE_MAX (not exported)
    for (let i = 0; i < MAX + 2; i++) {
      _result_cache_put("fake", `sha${i}`, [
        [new Symbol({ name: `s${i}`, kind: "var", line: 1 })],
        [],
        [],
        [],
      ]);
    }
    const stats = parser_cache_stats();
    expect(stats.size).toBe(MAX);
    expect(stats.evictions).toBe(2);
    // Earliest entries gone, most recent retained.
    expect(_result_cache_get("fake", "sha0")).toBeNull();
    expect(_result_cache_get(`fake`, `sha${MAX + 1}`)).not.toBeNull();
  });

  it("test_parser_cache_clear_resets_stats", () => {
    _result_cache_put("x", "abc", [
      [new Symbol({ name: "a", kind: "var", line: 1 })],
      [],
      [],
      [],
    ]);
    _result_cache_get("x", "abc"); // hit
    _result_cache_get("x", "missing"); // miss
    const sBefore = parser_cache_stats();
    expect(sBefore.hits).toBeGreaterThanOrEqual(1);
    expect(sBefore.misses).toBeGreaterThanOrEqual(1);

    parser_cache_clear();
    const sAfter = parser_cache_stats();
    expect(sAfter).toEqual({ hits: 0, misses: 0, evictions: 0, size: 0 });
  });

  it("test_cache_key_includes_language", () => {
    // Same bytes-SHA but different language must be cached independently.
    const sha = "deadbeef";
    const payloadA: [Symbol[], Ref[], ImpExp[], Section[]] = [
      [new Symbol({ name: "A", kind: "function", line: 1 })],
      [],
      [],
      [],
    ];
    const payloadB: [Symbol[], Ref[], ImpExp[], Section[]] = [
      [new Symbol({ name: "B", kind: "class", line: 1 })],
      [],
      [],
      [],
    ];
    _result_cache_put("python", sha, payloadA);
    _result_cache_put("typescript", sha, payloadB);

    const hitA = _result_cache_get("python", sha);
    const hitB = _result_cache_get("typescript", sha);
    expect(hitA).not.toBeNull();
    expect((hitA as [Symbol[], Ref[], ImpExp[], Section[]])[0][0]!.name).toBe("A");
    expect(hitB).not.toBeNull();
    expect((hitB as [Symbol[], Ref[], ImpExp[], Section[]])[0][0]!.name).toBe("B");
  });

  it("test_extractor_failure_is_not_cached", async () => {
    // When the extractor crashes, the next call must retry — never cache a
    // failed parse, otherwise a transient bug becomes sticky.
    const proj = makePyProjectUnindexed();
    const filePath = firstPy(proj);

    const callCount = { n: 0 };
    const crashingExtract: Extractor = () => {
      callCount.n += 1;
      throw new RuntimeError("simulated grammar fault");
    };

    register_extractor("python", () => crashingExtract);
    // Python: `parser._EXTRACTOR_CACHE.pop("python", None)` — redundant after
    // register_extractor (which clears the cache); omitted.
    // Python: `with patch.object(parser._LOG, "exception")` — quiets the error
    // log; no vitest analogue against the non-exported logger. The error log
    // is captured by vitest's stderr sink and does not affect assertions.

    await index_file(proj, filePath);
    await index_file(proj, filePath);

    expect(callCount.n).toBe(2);
    expect(parser_cache_stats().hits).toBe(0);
  });
});

/** Stand-in for Python's `RuntimeError` so the thrown type reads faithfully. */
class RuntimeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RuntimeError";
  }
}
