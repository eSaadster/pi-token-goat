/**
 * Tests for the JSON extractor.
 *
 * 1:1 port of tests/test_parser_json.py. Strict NodeNext ESM.
 *
 * Port notes
 * -----------
 *  - Python's pytest ``tmp_path`` -> a per-test ``fs.mkdtempSync`` + realpathSync
 *    (macOS /var -> /private/var symlink parity, same convention the rest of the
 *    TS suite uses). pytest's `tmp_path` is function-scoped; each ``it`` gets a
 *    fresh dir via beforeEach.
 *  - Python's `json.dumps` / `json.loads` -> JSON.stringify / JSON.parse for
 *    building the LARGE test payloads (these are test-only inputs, not the
 *    code-under-test, so Node's builtin JSON is fine and byte-identical for the
 *    ASCII payloads here). The order-preserving parse the adapter itself ships is
 *    exercised through the adapter; the test inputs only need canonical JSON.
 *  - The Python `small_json_source` fixture read
 *    tests/fixtures/json_sample/config.json; the TS fixture mirrors it at the
 *    same relative path under ts/tests/fixtures/json_sample/config.json.
 *  - `test_large_json_respects_max_symbols_budget` imports `_MAX_SYMBOLS` from
 *    the json_idx module. The TS port currently declares `_MAX_SYMBOLS` as a
 *    module-private ``const`` (NOT exported), so the import is not available.
 *    See ``missingExports`` in the run report. The faithful equivalent is the
 *    documented cap of 200 (the Python and TS sources both hard-code 200); the
 *    test asserts against that literal, which is the same invariant.
 */
import { beforeEach, describe, expect, it } from "vitest";

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { fileURLToPath } from "node:url";

import { extract } from "../src/token_goat/languages/json_idx.js";

// ---------------------------------------------------------------------------
// Fixture: small JSON source (config.json)
// ---------------------------------------------------------------------------

const _THIS_DIR = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_DIR = path.join(_THIS_DIR, "fixtures", "json_sample");
const CONFIG_JSON = path.join(FIXTURE_DIR, "config.json");

/** Python ``small_json_source`` fixture: the bytes of config.json. */
function smallJsonSource(): Buffer {
  return fs.readFileSync(CONFIG_JSON);
}

// The json_idx adapter caps symbol emission at this many entries (mirrors the
// Python ``_MAX_SYMBOLS = 200`` constant, which is not re-exported by the TS
// module). Asserting on the literal preserves the same invariant the Python
// test checked via the imported constant.
const _MAX_SYMBOLS = 200;

// Minimum JSON file size the adapter indexes (mirrors the Python constant of
// the same name in json_idx.py). Used to size large test payloads past the gate.
const _MIN_JSON_SIZE = 50_000;

// ---------------------------------------------------------------------------
// Shared per-test tmp dir (Python's tmp_path fixture analogue).
// ---------------------------------------------------------------------------

let tmpPath: string;

beforeEach(() => {
  tmpPath = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "tg-json-")));
});

// ===========================================================================
// Tests
// ===========================================================================

describe("test_parser_json", () => {
  it("test_extract_returns_four_lists", () => {
    const [symbols, refs, imports, sections] = extract(
      smallJsonSource(),
      "config.json",
    );
    expect(Array.isArray(symbols)).toBe(true);
    expect(Array.isArray(refs)).toBe(true);
    expect(Array.isArray(imports)).toBe(true);
    expect(Array.isArray(sections)).toBe(true);
  });

  it("test_small_json_not_indexed", () => {
    // config.json is small (<50 KB), should not be indexed (no symbols).
    const [symbols] = extract(smallJsonSource(), "config.json");
    expect(symbols.length).toBe(0);
  });

  it("test_large_json_indexed", () => {
    // Create a large JSON file (>50 KB).
    const largeData: Record<string, string> = {};
    for (let i = 0; i < 200; i++) {
      largeData[`key_${i}`] = `value_${i}`.repeat(100);
    }
    const jsonStr = JSON.stringify(largeData);
    expect(Buffer.byteLength(jsonStr, "utf-8")).toBeGreaterThan(_MIN_JSON_SIZE);

    const largeJsonFile = path.join(tmpPath, "large.json");
    fs.writeFileSync(largeJsonFile, jsonStr, "utf-8");

    const [symbols] = extract(fs.readFileSync(largeJsonFile), "large.json");
    expect(symbols.length).toBeGreaterThan(0);
    const names = new Set(symbols.map((s) => s.name));
    expect([...names].some((name) => name.includes("key_"))).toBe(true);
  });

  it("test_large_json_array_indexed", () => {
    // Create a large JSON array.
    const largeArray: Array<{ id: number; name: string }> = [];
    for (let i = 0; i < 2000; i++) {
      largeArray.push({ id: i, name: `item_${i}`.repeat(10) });
    }
    const jsonStr = JSON.stringify(largeArray);
    expect(Buffer.byteLength(jsonStr, "utf-8")).toBeGreaterThan(_MIN_JSON_SIZE);

    const largeJsonFile = path.join(tmpPath, "array.json");
    fs.writeFileSync(largeJsonFile, jsonStr, "utf-8");

    const [symbols] = extract(fs.readFileSync(largeJsonFile), "array.json");
    expect(symbols.length).toBeGreaterThan(0);
    // Should have one array summary symbol.
    const arraySymbols = symbols.filter((s) => s.kind === "json_array");
    expect(arraySymbols.length).toBe(1);
    expect(arraySymbols[0]!.name).toContain("2000");
  });

  it("test_large_minified_json_falls_back_to_permissive_regex", () => {
    // Minified large JSON has no newlines; a strict `^`-anchored regex would
    // return zero hits. The permissive fallback must capture the keys.
    //
    // Regression for the case where json.loads fails on a huge minified blob
    // (e.g. trailing garbage in an API dump) — the original fallback regex was
    // anchored at column 0 with re.MULTILINE, which captures nothing when the
    // entire file is on a single line.
    //
    // Build a large minified blob, then append garbage so the parse fails.
    const payload: Record<string, number> = {};
    for (let i = 0; i < 6000; i++) {
      payload[`k${i}`] = i;
    }
    // Compact separators (no spaces) — mirrors Python json.dumps(separators=(",", ":")).
    const minified = JSON.stringify(payload);
    const withGarbage = minified + "<<<garbage>>>"; // forces a JSONDecodeError
    expect(withGarbage.includes("\n")).toBe(false);
    expect(Buffer.byteLength(withGarbage, "utf-8")).toBeGreaterThan(_MIN_JSON_SIZE);

    const f = path.join(tmpPath, "minified_bad.json");
    fs.writeFileSync(f, withGarbage, "utf-8");

    const [symbols] = extract(fs.readFileSync(f), "minified_bad.json");
    // Permissive fallback must extract at least some keys.
    expect(symbols.length).toBeGreaterThan(0);
    const names = new Set(symbols.map((s) => s.name));
    expect(names.has("k0")).toBe(true);
    // De-duplication: each key appears at most once even though the source may
    // contain repeating "id"-style tokens across millions of bytes.
    expect(names.size).toBe(symbols.length);
  });

  it("test_large_json_nested_dict_emits_parent_child_symbols", () => {
    // Top-level dict values that are also dicts contribute parent.child nested-
    // key symbols, up to the nested-budget cap.
    //
    // Two top-level keys, each a nested object. Pad with filler to exceed the
    // 50 KB indexing threshold.
    const payload: Record<string, unknown> = {
      database: { host: "localhost", port: 5432, name: "prod" },
      auth: { issuer: "https://idp.example", audience: "api" },
      filler: "x".repeat(60_000),
    };
    const f = path.join(tmpPath, "config_nested.json");
    fs.writeFileSync(f, JSON.stringify(payload, null, 2), "utf-8");

    const [symbols] = extract(fs.readFileSync(f), "config_nested.json");
    const names = new Set(symbols.map((s) => s.name));
    // Top-level keys present.
    expect(names.has("database")).toBe(true);
    expect(names.has("auth")).toBe(true);
    // Nested children present.
    expect(names.has("database.host")).toBe(true);
    expect(names.has("database.port")).toBe(true);
    expect(names.has("auth.issuer")).toBe(true);
    // Nested kind is distinct from top-level.
    const kinds = new Set(
      symbols.filter((s) => s.name.includes(".")).map((s) => s.kind),
    );
    expect(kinds).toEqual(new Set(["json_nested_key"]));
  });

  it("test_large_json_array_of_objects_peeks_element_keys", () => {
    // Arrays whose first element is a dict get [].key schema symbols.
    const records: Array<Record<string, unknown>> = [];
    for (let i = 0; i < 2000; i++) {
      records.push({
        id: i,
        name: `u${i}`,
        active: true,
        score: i * 1.5,
      });
    }
    const f = path.join(tmpPath, "records.json");
    fs.writeFileSync(f, JSON.stringify(records), "utf-8");

    const [symbols] = extract(fs.readFileSync(f), "records.json");
    const names = new Set(symbols.map((s) => s.name));
    // Array summary still present.
    expect(symbols.some((s) => s.kind === "json_array")).toBe(true);
    // First-element schema is exposed.
    expect(names.has("[].id")).toBe(true);
    expect(names.has("[].name")).toBe(true);
    expect(names.has("[].active")).toBe(true);
    expect(names.has("[].score")).toBe(true);
    const elemKinds = new Set(
      symbols.filter((s) => s.name.startsWith("[].")).map((s) => s.kind),
    );
    expect(elemKinds).toEqual(new Set(["json_array_element_key"]));
  });

  it("test_large_json_array_of_primitives_no_element_keys", () => {
    // Arrays of primitives should NOT trigger element-key peeking — only the
    // summary symbol is emitted.
    //
    // An array of ~30K integers — well above the size gate but no schema to peek.
    const data: number[] = [];
    for (let i = 0; i < 30_000; i++) {
      data.push(i);
    }
    const f = path.join(tmpPath, "ints.json");
    fs.writeFileSync(f, JSON.stringify(data), "utf-8");

    const [symbols] = extract(fs.readFileSync(f), "ints.json");
    expect(symbols.length).toBe(1);
    expect(symbols[0]!.kind).toBe("json_array");
  });

  it("test_large_json_respects_max_symbols_budget", () => {
    // Combined top-level + nested-key emission must never exceed _MAX_SYMBOLS.
    //
    // 300 top-level keys each with a nested dict. Top-level alone would emit
    // 300 entries, well above the 200 cap; verify the cap holds.
    const payload: Record<string, Record<string, number>> = {};
    for (let i = 0; i < 300; i++) {
      payload[`k${i}`] = { sub_a: i, sub_b: i * 2 };
    }
    const f = path.join(tmpPath, "huge.json");
    fs.writeFileSync(f, JSON.stringify(payload), "utf-8");

    const [symbols] = extract(fs.readFileSync(f), "huge.json");
    expect(symbols.length).toBeLessThanOrEqual(_MAX_SYMBOLS);
  });
});
