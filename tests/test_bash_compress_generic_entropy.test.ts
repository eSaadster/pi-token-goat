/**
 * Tests: GenericFilter entropy bypass in consecutive dedup.
 *
 * 1:1 port of tests/test_bash_compress_generic_entropy.py. Every Python
 * `def test_*` maps to a vitest `it()` with the SAME name and assertion
 * polarity. The Python module has no test class, so each `it()` sits at the
 * top level under one `describe()` named after the file.
 *
 * Test-seam mapping (Python -> TS):
 *  - `from token_goat.bash_compress import GenericFilter`
 *      -> import { GenericFilter } from the barrel
 *        "../src/token_goat/bash_compress.js".
 *  - `_F = GenericFilter()` (module-level singleton) -> module-level
 *    `const _F = new GenericFilter()`. The Python filter is stateless across
 *    calls (compress() reads no instance fields), so a shared instance is
 *    observably identical to per-test `new GenericFilter()`.
 *  - `_compress(stdout, stderr="")` calls `_F.compress(stdout, stderr, 0,
 *    ["cmd"])` DIRECTLY (not `.apply()`). Mirrored exactly: `.compress()`
 *    returns the body string (no CompressedOutput wrapper). The `.apply()`
 *    wrapper would run the ANSI/CR normaliser first, but these fixtures are
 *    pure ASCII with no control chars, so `.compress()` and `.apply().text`
 *    produce byte-identical output here.
 *
 * Byte-exactness: assertions are `.count(sub)` and `sub in out` checks on
 * ASCII fixtures. Python `str.count` (non-overlapping) -> local `_count`.
 * Code-unit length equals byte length for ASCII; no Buffer arithmetic.
 *
 * The dedup format emitted by dedupe_consecutive is `"<line>  (×<N>)"` (two
 * spaces, U+00D7 MULTIPLICATION SIGN). The Python asserts on the literal
 * `"  (×3)"` / `"  (×2)"` / `"×3"` substrings; mirrored verbatim below.
 */
import { describe, expect, it } from "vitest";

import { GenericFilter } from "../src/token_goat/bash_compress.js";

const _F = new GenericFilter();

/** Mirror of Python module-level _compress(stdout, stderr=""). */
function _compress(stdout: string, stderr = ""): string {
  return _F.compress(stdout, stderr, 0, ["cmd"]);
}

/** Python str.count(sub) — count of non-overlapping occurrences. */
function _count(haystack: string, needle: string): number {
  if (needle === "") {
    return haystack.length + 1;
  }
  let n = 0;
  let idx = haystack.indexOf(needle);
  while (idx !== -1) {
    n += 1;
    idx = haystack.indexOf(needle, idx + needle.length);
  }
  return n;
}

describe("test_bash_compress_generic_entropy", () => {
  // 1. Baseline: identical plain lines ARE deduplicated.
  it("test_plain_lines_deduped", () => {
    const out = _compress("foo\nfoo\nfoo");
    expect(out).toContain("foo  (×3)");
    // only the collapsed form — "foo" appears once (inside the collapse marker).
    expect(_count(out, "foo")).toBe(1);
  });

  // 2. UUID lines are NOT deduplicated.
  it("test_uuid_not_deduped", () => {
    const line = "transaction_id=550e8400-e29b-41d4-a716-446655440000";
    const out = _compress(`${line}\n${line}`);
    expect(_count(out, line)).toBe(2);
  });

  // 3. SHA-256 hex lines are NOT deduplicated.
  it("test_sha256_not_deduped", () => {
    const line =
      "checksum=e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
    const out = _compress(`${line}\n${line}`);
    expect(_count(out, line)).toBe(2);
  });

  // 4. JWT-like token lines are NOT deduplicated.
  it("test_jwt_not_deduped", () => {
    const line =
      "token=eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiJ1c2VyMTIzIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c";
    const out = _compress(`${line}\n${line}`);
    expect(_count(out, line)).toBe(2);
  });

  // 5. 40-char git hash lines are NOT deduplicated.
  it("test_git_hash_not_deduped", () => {
    const line = "commit a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2";
    const out = _compress(`${line}\n${line}`);
    expect(_count(out, line)).toBe(2);
  });

  // 6. Regression: plain identical English lines still get deduplicated.
  it("test_plain_english_still_deduped", () => {
    const out = _compress(
      "warning: deprecated\nwarning: deprecated\nwarning: deprecated",
    );
    expect(out).toContain("warning: deprecated  (×3)");
  });

  // 7. Mix: 3 identical UUID lines all emitted; 3 identical plain lines collapse to 1.
  it("test_mix_uuid_and_plain", () => {
    const uuid_line = "id=550e8400-e29b-41d4-a716-446655440000";
    const plain_line = "done";
    const stdout = [
      ...Array(3).fill(uuid_line),
      ...Array(3).fill(plain_line),
    ].join("\n");
    const out = _compress(stdout);
    expect(_count(out, uuid_line)).toBe(3);
    expect(out).toContain(`${plain_line}  (×3)`);
    expect(_count(out, plain_line)).toBe(1);
  });

  // 8. Short high-entropy-looking token (< 8 chars) does NOT prevent dedup.
  it("test_short_token_still_deduped", () => {
    // "abc123" is only 6 chars — below the min_length gate in entropy.ts
    // (_ENTROPY_MIN_LEN=8).
    const line = "result=abc123";
    const out = _compress(`${line}\n${line}\n${line}`);
    expect(out).toContain("×3");
  });
});
