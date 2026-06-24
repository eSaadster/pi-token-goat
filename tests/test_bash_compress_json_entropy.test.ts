/**
 * Tests for JsonArrayFilter preserving objects with high-entropy values.
 *
 * 1:1 port of tests/test_bash_compress_json_entropy.py. Every Python
 * `def test_*` maps to a vitest `it()` with the SAME name and assertion
 * polarity; the Python module-level functions map to a single `describe()`
 * block named after the Python file's integration-test intent.
 *
 * Test-seam mapping (Python -> TS):
 *  - `from token_goat.bash_compress import JsonArrayFilter`
 *      -> import JsonArrayFilter from the barrel
 *        "../src/token_goat/bash_compress.js" (re-exported from tail_filters).
 *  - Python module-level `_F = JsonArrayFilter()` -> a fresh `const f = new
 *    JsonArrayFilter()` constructed inside each `it()` (mirrors the
 *    per-test-instance convention used by the other TS ports).
 *  - Python `_compress(stdout, stderr="", exit_code=0)` module helper calls
 *    `_F.compress(stdout, stderr, exit_code, ["gh", "api", "/repos"])` and
 *    returns the compressed string. The TS port calls
 *    `f.compress(stdout, stderr, exit_code, ["gh", "api", "/repos"])` directly
 *    (argv is ignored by JsonArrayFilter.compress — it inspects stdout only —
 *    but the argv shape is preserved for parity with the Python helper).
 *  - Python `json.dumps(data)` (no indent) -> JSON.stringify(data) (no
 *    spaces). Python `json.loads(result)` -> JSON.parse(result).
 *  - Python `result.split("\n[")[0]` strips the trailing dedup suffix line(s)
 *    the filter appends after the JSON body; TS keeps the identical split so
 *    the JSON.parse sees exactly the same body the Python test parses.
 *
 * Byte-exactness: the assertions are `not in` substring checks on the
 * returned string plus a `json.loads` round-trip count. JsonArrayFilter emits
 * a `[... N duplicate objects with keys {k1, k2} omitted]` suffix line when it
 * deduplicates; the no-dedup branch returns the pretty-printed JSON body
 * alone (JSON.stringify(.., null, 2) in TS). The fixtures are pure ASCII so
 * Python `len` (code points) equals JS `.length` for these inputs.
 */
import { describe, expect, it } from "vitest";

import { JsonArrayFilter } from "../src/token_goat/bash_compress.js";

// ---------------------------------------------------------------------------
// Local _compress helper (port of the Python module-level _compress). Runs the
// filter's compress() directly with the same argv shape the Python helper used
// (["gh", "api", "/repos"]); JsonArrayFilter ignores argv and inspects stdout.
// ---------------------------------------------------------------------------
function _compress(stdout: string, stderr = "", exit_code = 0): string {
  const f = new JsonArrayFilter();
  return f.compress(stdout, stderr, exit_code, ["gh", "api", "/repos"]);
}

describe("TestBashCompressJsonEntropy", () => {
  it("test_uuid_value_prevents_dedup", () => {
    // Two objects share the same key-set; the second has a UUID value -> both must be emitted.
    const data = [
      { id: 1, token: "plain" },
      { id: 2, token: "550e8400-e29b-41d4-a716-446655440000" },
    ];
    const result = _compress(JSON.stringify(data));
    // No dedup suffix should appear -- both objects must survive
    expect(result).not.toContain("[... 1 duplicate");
    const parsed = JSON.parse(result) as Array<{ token: string }>;
    expect(parsed.length).toBe(2);
    expect(parsed.some((item) => item.token === "550e8400-e29b-41d4-a716-446655440000")).toBe(true);
  });

  it("test_non_uuid_values_deduplicated_normally", () => {
    // Three objects with the same key-set, no high-entropy values -> normal dedup.
    // Use short values (<8 chars) so the entropy guard never fires.
    const data = [
      { status: "ok", code: 200 },
      { status: "ok", code: 200 },
      { status: "ok", code: 200 },
    ];
    const result = _compress(JSON.stringify(data));
    expect(result).toContain("[... 2 duplicate objects with keys {code, status} omitted]");
    const body = result.split("\n[")[0]!;
    const parsed = JSON.parse(body) as Array<{ status: string; code: number }>;
    expect(parsed.length).toBe(1);
  });

  it("test_git_sha_value_prevents_dedup", () => {
    // Object whose value is a 40-char git SHA must not be deduplicated.
    const sha = "d2f4e5b8c1a39f06d2e4b5c8a1f3e7d9b2a5c8e1";
    const data = [
      { commit: "abc", hash: "none" },
      { commit: "def", hash: sha },
    ];
    const result = _compress(JSON.stringify(data));
    expect(result).not.toContain("[... 1 duplicate");
    const parsed = JSON.parse(result) as Array<{ hash: string }>;
    expect(parsed.length).toBe(2);
    expect(parsed.some((item) => item.hash === sha)).toBe(true);
  });

  it("test_mixed_array_some_uuid_some_plain", () => {
    // Short (<8 char) ref values never trigger the entropy guard -> normal dedup applies.
    // Only the UUID item (36 chars, high entropy) is preserved unconditionally.
    const uuid = "550e8400-e29b-41d4-a716-446655440000";
    const data = [
      { id: 1, ref: "plain" }, // 5 chars < 8 -> preserve=False, first seen
      { id: 2, ref: uuid }, // UUID value -> preserve=True
      { id: 3, ref: "check" }, // 5 chars < 8 -> preserve=False -> deduped
    ];
    const result = _compress(JSON.stringify(data));
    // Third object must be deduped
    expect(result).toContain("[... 1 duplicate");
    // Both the plain first and the UUID second must appear
    const body = result.split("\n[")[0]!;
    const parsed = JSON.parse(body) as Array<{ ref: string }>;
    expect(parsed.length).toBe(2);
    const refs = new Set(parsed.map((item) => item.ref));
    expect(refs.has(uuid)).toBe(true);
    expect(refs.has("plain")).toBe(true);
  });

  it("test_jwt_value_prevents_dedup", () => {
    const jwt = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9";
    const data = [
      { user: "alice", token: "low" },
      { user: "bob", token: jwt },
    ];
    const result = _compress(JSON.stringify(data));
    expect(result).not.toContain("[... 1 duplicate");
    const parsed = JSON.parse(result) as Array<unknown>;
    expect(parsed.length).toBe(2);
  });
});
