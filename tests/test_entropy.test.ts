/**
 * Unit tests for token_goat/entropy. 1:1 port of tests/test_entropy.py.
 *
 * Every Python `def test_*` maps to a vitest `it()` with the same name, the
 * same assertion polarity, and the same inline rationale comments. The design's
 * pytest.mark.parametrize -> it.test.each migration is not needed here (no
 * parametrize in the source), but the file-level-fork isolation from
 * vitest.config.ts already reproduces pytest-xdist --dist=loadscope.
 */
import { describe, expect, it } from "vitest";

import {
  _ENTROPY_MIN_LEN,
  _ENTROPY_THRESHOLD,
  hasHighEntropyToken,
  scoreEntropy,
} from "../src/token_goat/entropy.js";

describe("scoreEntropy / hasHighEntropyToken (port of tests/test_entropy.py)", () => {
  it("test_uuid_high_entropy", () => {
    expect(scoreEntropy("550e8400-e29b-41d4-a716-446655440000")).toBeGreaterThanOrEqual(0.85);
  });

  it("test_all_same_char_zero_entropy", () => {
    // Single unique character -> charset size < 2 -> returns 0.0
    expect(scoreEntropy("a".repeat(64))).toBe(0.0);
  });

  it("test_varied_hex_high_entropy", () => {
    // 64-char hex string with varied digit distribution
    const hexVal =
      "d2f4e5b8c1a39f06d2e4b5c8a1f3e7d9b2a5c8e1f4d7a0b3c6e9f2a5d8b1c4e7";
    expect(scoreEntropy(hexVal)).toBeGreaterThanOrEqual(0.85);
  });

  it("test_hello_below_min_length", () => {
    // "hello" is 5 chars, below the default min_length of 8
    expect(hasHighEntropyToken("hello")).toBe(false);
  });

  it("test_skewed_distribution_low_entropy", () => {
    // Heavily skewed distribution -> normalized entropy well below 0.85
    expect(scoreEntropy("aaaaaaab")).toBeLessThan(0.85);
  });

  it("test_jwt_header_high_entropy", () => {
    expect(scoreEntropy("eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9")).toBeGreaterThanOrEqual(0.85);
  });

  it("test_line_with_uuid_true", () => {
    expect(hasHighEntropyToken("request_id=550e8400-e29b-41d4-a716-446655440000")).toBe(true);
  });

  it("test_line_without_high_entropy_false", () => {
    // Splits on '=' and whitespace -> tokens are "status", "ok", "count", "5" (all < 8 chars)
    expect(hasHighEntropyToken("status=ok count=5")).toBe(false);
  });

  it("test_empty_string_entropy", () => {
    expect(scoreEntropy("")).toBe(0.0);
  });

  it("test_single_char_repeated_entropy", () => {
    expect(scoreEntropy("aaaaaaa")).toBe(0.0);
  });

  it("test_entropy_threshold_constant", () => {
    expect(_ENTROPY_THRESHOLD).toBe(0.85);
  });

  it("test_entropy_min_len_constant", () => {
    expect(_ENTROPY_MIN_LEN).toBe(8);
  });

  it("test_custom_min_length_respected", () => {
    // "a1b2c3" is 6 chars with high entropy and non-alpha chars;
    // lowering min_length to 5 lets it be scored (default is 8)
    expect(hasHighEntropyToken("a1b2c3", 0.85, 5)).toBe(true);
  });

  it("test_custom_threshold_respected", () => {
    // Raise threshold above 1.0 — nothing can ever qualify
    expect(
      hasHighEntropyToken("550e8400-e29b-41d4-a716-446655440000", 1.1, 8),
    ).toBe(false);
  });

  it("test_pure_english_word_no_entropy_flag", () => {
    // "successfully" and "implemented" have high entropy (many unique chars)
    // but are pure alphabetic, so they should NOT be flagged
    expect(hasHighEntropyToken("successfully implemented")).toBe(false);
  });

  it("test_pure_alphabetic_token_no_entropy_flag", () => {
    // "admin" token is pure alphabetic, even in a key=value pair; should NOT be flagged
    expect(hasHighEntropyToken("credentials=admin")).toBe(false);
  });

  it("test_colon_separator_and_uuid", () => {
    // Colon should now split "host:uuid" into two tokens; uuid token has digits and hyphens
    expect(hasHighEntropyToken("host:550e8400-e29b-41d4-a716-446655440000")).toBe(true);
  });
});
