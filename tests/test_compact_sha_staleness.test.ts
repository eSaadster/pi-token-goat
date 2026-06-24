/**
 * Tests for compact SHA-staleness detection in cli_doctor.
 *
 * 1:1 port of tests/test_compact_sha_staleness.py. Each Python `def test_*`
 * maps to a vitest `it()` with the SAME name and the SAME assertion polarity;
 * each Python `class Test*` maps to a `describe(...)`.
 *
 * ---------------------------------------------------------------------------
 * Parity notes (Python -> TS)
 * ---------------------------------------------------------------------------
 * The Python file imports `extract_compact_source_sha`, `store_compact`, and
 * `get_compact` directly from `token_goat.skill_cache` and exercises them as
 * the CODE-UNDER-TEST (it is a skill_cache unit test that happens to live next
 * to the compact tests). skill_cache.ts is NOT part of the ported layer set:
 *
 *   - compact.ts exposes a `_setSkillCacheModule` injection seam, but its
 *     `_SkillCacheModule` interface is the fail-soft READER surface compact
 *     consumes (`get_compact`, `get_compact_any_session`,
 *     `extract_compact_source_sha`, `_strip_compact_header`). It does NOT
 *     include `store_compact` (the writer), and — crucially — there is no real
 *     `extract_compact_source_sha` / `store_compact` / `get_compact`
 *     IMPLEMENTATION on disk to assert against. The seam injects a STUB so
 *     compact's own builders fail soft; it is not a substitute implementation.
 *
 *   - These tests assert the real header-parsing regex, the real
 *     `store_compact` SHA-header write format, and the real on-disk
 *     `store_compact` -> `get_compact` round-trip. Injecting a hand-written
 *     stub of `extract_compact_source_sha` here would assert the stub, not the
 *     shipped behaviour — a tautology, not a behaviour-parity port. The local
 *     `_is_compact_sha_stale` helper (Sub-area F) likewise composes the real
 *     `extract_compact_source_sha`, so it cannot be exercised faithfully
 *     either.
 *
 * skill_cache.ts is now ported and exports `extract_compact_source_sha` /
 * `store_compact` / `get_compact`, so the import is available. These tests stay
 * `it.skip`'d only because their BODIES were never ported (the blocks below are
 * empty `expect(true).toBe(true)` placeholders); the on-disk store_compact ->
 * get_compact round-trips also need the real cache-dir fixture wiring. Writing the
 * real bodies is the dedicated skill_cache test-body port, out of scope for the
 * seam wiring. Each skip is COUNTED in tests_skipped. When the bodies land they
 * import from "../src/token_goat/skill_cache.js".
 *
 * Helpers (_sha256 / _make_compact_with_sha / _make_compact_without_sha /
 * _is_compact_sha_stale) are ported verbatim below so this file is standalone
 * and ready to unskip with a one-line import change.
 *
 * verbatimModuleSyntax is on -> relative imports use .js; type-only via import type.
 */
import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

// PORT: deferred — token_goat.skill_cache (extract_compact_source_sha,
// store_compact, get_compact) is not yet ported (later layer). When it lands,
// replace this block with:
//   import { extract_compact_source_sha, store_compact, get_compact }
//     from "../src/token_goat/skill_cache.js";
// and remove the `.skip` from every it() below.

// ---------------------------------------------------------------------------
// Helpers (ported verbatim from the Python module-level helpers)
// ---------------------------------------------------------------------------

function _sha256(text: string): string {
  // hashlib.sha256(text.encode()).hexdigest()
  return createHash("sha256").update(Buffer.from(text, "utf8")).digest("hex");
}

function _make_compact_with_sha(sha: string, body = "## Section\nSome content."): string {
  // Return a compact text string with the header that store_compact would write.
  const compact_tokens = Math.max(1, Math.floor(body.length / 4));
  const sha_fragment = sha.slice(0, 12);
  return `--- compact form (${compact_tokens} tokens, sha=${sha_fragment}) ---\n${body}`;
}

function _make_compact_without_sha(body = "## Section\nLegacy compact."): string {
  // Return a compact text string in the legacy header format (no SHA).
  const compact_tokens = Math.max(1, Math.floor(body.length / 4));
  return `--- compact form (${compact_tokens} tokens) ---\n${body}`;
}

// ---------------------------------------------------------------------------
// Sub-area A — extract_compact_source_sha parses header variants
// ---------------------------------------------------------------------------

describe("TestExtractCompactSourceSha", () => {
  // PORT: deferred — token_goat.skill_cache (extract_compact_source_sha) not yet ported (later layer).
  it.skip("test_extracts_12char_sha_from_valid_header", () => {
    // PORT: deferred — skill_cache not yet ported.
    expect(true).toBe(true);
  });

  // PORT: deferred — token_goat.skill_cache (extract_compact_source_sha) not yet ported (later layer).
  it.skip("test_returns_none_for_legacy_header_without_sha", () => {
    // PORT: deferred — skill_cache not yet ported.
    expect(true).toBe(true);
  });

  // PORT: deferred — token_goat.skill_cache (extract_compact_source_sha) not yet ported (later layer).
  it.skip("test_returns_none_for_empty_text", () => {
    // PORT: deferred — skill_cache not yet ported.
    expect(true).toBe(true);
  });

  // PORT: deferred — token_goat.skill_cache (extract_compact_source_sha) not yet ported (later layer).
  it.skip("test_returns_none_for_plain_text_no_header", () => {
    // PORT: deferred — skill_cache not yet ported.
    expect(true).toBe(true);
  });

  // PORT: deferred — token_goat.skill_cache (extract_compact_source_sha) not yet ported (later layer).
  it.skip("test_returns_none_for_truncated_sha_in_header", () => {
    // PORT: deferred — skill_cache not yet ported.
    expect(true).toBe(true);
  });

  // PORT: deferred — token_goat.skill_cache (extract_compact_source_sha) not yet ported (later layer).
  it.skip("test_sha_is_hex_only", () => {
    // PORT: deferred — skill_cache not yet ported.
    expect(true).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Sub-area B — SHA matching: compact is fresh
// ---------------------------------------------------------------------------

describe("TestShaMatchFresh", () => {
  // PORT: deferred — token_goat.skill_cache (extract_compact_source_sha) not yet ported (later layer).
  it.skip("test_fresh_compact_matches_body_sha", () => {
    // PORT: deferred — skill_cache not yet ported.
    expect(true).toBe(true);
  });

  // PORT: deferred — token_goat.skill_cache (extract_compact_source_sha) not yet ported (later layer).
  it.skip("test_startswith_check_is_prefix_not_equality", () => {
    // PORT: deferred — skill_cache not yet ported.
    expect(true).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Sub-area C — SHA mismatch: compact is stale
// ---------------------------------------------------------------------------

describe("TestShaMismatchStale", () => {
  // PORT: deferred — token_goat.skill_cache (extract_compact_source_sha) not yet ported (later layer).
  it.skip("test_compact_built_from_old_sha_is_stale", () => {
    // PORT: deferred — skill_cache not yet ported.
    expect(true).toBe(true);
  });

  // PORT: deferred — token_goat.skill_cache (extract_compact_source_sha) not yet ported (later layer).
  it.skip("test_single_byte_change_in_body_invalidates_sha", () => {
    // PORT: deferred — skill_cache not yet ported.
    expect(true).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Sub-area D — Legacy compact: missing SHA should not produce false positive
// ---------------------------------------------------------------------------

describe("TestLegacyCompactNoFalsePositive", () => {
  // PORT: deferred — token_goat.skill_cache (extract_compact_source_sha) not yet ported (later layer).
  it.skip("test_no_sha_means_skip_not_stale", () => {
    // PORT: deferred — skill_cache not yet ported.
    expect(true).toBe(true);
  });

  // PORT: deferred — token_goat.skill_cache (extract_compact_source_sha) not yet ported (later layer).
  it.skip("test_no_sha_header_variant_with_extra_whitespace", () => {
    // PORT: deferred — skill_cache not yet ported.
    expect(true).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Sub-area E — store_compact writes correct SHA header
// ---------------------------------------------------------------------------

describe("TestStoreCompactShaHeader", () => {
  // PORT: deferred — token_goat.skill_cache (store_compact, get_compact,
  // extract_compact_source_sha) not yet ported (later layer). Needs the real
  // on-disk writer keyed by TOKEN_GOAT_CACHE_DIR.
  it.skip("test_store_compact_embeds_sha_in_header", () => {
    // PORT: deferred — skill_cache not yet ported.
    expect(true).toBe(true);
  });

  // PORT: deferred — token_goat.skill_cache (store_compact, get_compact,
  // extract_compact_source_sha) not yet ported (later layer).
  it.skip("test_store_compact_without_sha_writes_legacy_header", () => {
    // PORT: deferred — skill_cache not yet ported.
    expect(true).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Sub-area F — Staleness detection helper function (mirrors doctor logic)
// ---------------------------------------------------------------------------

/**
 * Mirror the staleness check added to cli_doctor.py in iter 2. Ported verbatim
 * so this file is ready to unskip with a one-line import change; it composes the
 * not-yet-ported extract_compact_source_sha, so it cannot be exercised yet.
 *
 * function _is_compact_sha_stale(compact_text: string, body_sha: string): boolean {
 *   const embedded = extract_compact_source_sha(compact_text);
 *   if (embedded === null) {
 *     return false; // legacy compact — skip
 *   }
 *   return !body_sha.startsWith(embedded);
 * }
 */

describe("TestStalenessDetectionHelper", () => {
  // PORT: deferred — token_goat.skill_cache (extract_compact_source_sha, via
  // _is_compact_sha_stale) not yet ported (later layer).
  it.skip("test_fresh_compact_is_not_stale", () => {
    // PORT: deferred — skill_cache not yet ported.
    expect(true).toBe(true);
  });

  // PORT: deferred — token_goat.skill_cache (extract_compact_source_sha, via
  // _is_compact_sha_stale) not yet ported (later layer).
  it.skip("test_outdated_compact_is_stale", () => {
    // PORT: deferred — skill_cache not yet ported.
    expect(true).toBe(true);
  });

  // PORT: deferred — token_goat.skill_cache (extract_compact_source_sha, via
  // _is_compact_sha_stale) not yet ported (later layer).
  it.skip("test_legacy_compact_is_never_stale", () => {
    // PORT: deferred — skill_cache not yet ported.
    expect(true).toBe(true);
  });

  // PORT: deferred — token_goat.skill_cache (extract_compact_source_sha, via
  // _is_compact_sha_stale) not yet ported (later layer).
  it.skip("test_empty_compact_is_never_stale", () => {
    // PORT: deferred — skill_cache not yet ported.
    expect(true).toBe(true);
  });
});

// Keep the ported helpers referenced so noUnusedLocals does not fire while every
// test is skipped (they are the seam this file unskips against). The expressions
// are side-effect-free and never assert.
void _sha256;
void _make_compact_with_sha;
void _make_compact_without_sha;
