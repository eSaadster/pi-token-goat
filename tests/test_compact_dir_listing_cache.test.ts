/**
 * Tests for the process-local directory listing cache in skill_cache (iter 8/10).
 *
 * 1:1 port of tests/test_compact_dir_listing_cache.py.
 *
 * Deliberately skipped (empty placeholder bodies + module-private symbols):
 *  - The Python test imports ENTIRELY from `token_goat.skill_cache`:
 *      _DIR_LISTING_CACHE_TTL_SECS, _get_skills_dir_listing, _skill_outputs_dir,
 *      get_compact_any_session, store_compact
 *    plus it mutates the module-global `skill_cache._dir_listing_cache`.
 *    skill_cache.ts is now ported and exports _DIR_LISTING_CACHE_TTL_SECS /
 *    _get_skills_dir_listing / get_compact_any_session / store_compact, BUT
 *    `_skill_outputs_dir` and the `_dir_listing_cache` module global are
 *    module-PRIVATE (not in `__all__`, no `export`), and the `it.skip` bodies
 *    below were never ported (they are empty placeholders). Un-skipping needs the
 *    dedicated skill_cache test-body port (which may also need those private
 *    symbols exported) — out of scope for the seam wiring.
 *  - compact.ts exposes a `_setSkillCacheModule` injection seam, BUT that seam
 *    only covers the four functions compact's own manifest builders call
 *    (get_compact, get_compact_any_session, extract_compact_source_sha,
 *    _strip_compact_header — see compact.ts `_SkillCacheModule`). It does NOT
 *    expose the actual subjects of THIS file: _get_skills_dir_listing,
 *    _skill_outputs_dir, store_compact, or the _DIR_LISTING_CACHE_TTL_SECS
 *    constant / _dir_listing_cache module global. Stubbing those through the seam
 *    would mean reimplementing the very dir-listing cache under test inside the
 *    test file — i.e. asserting against a fake, not the code under test. That
 *    breaks behavior parity, so the tests are deferred rather than faked.
 *  Each of the 9 `def test_*` is marked it.skip with a
 *  "// PORT: deferred — token_goat.skill_cache (Layer 6)" tag and counted, per
 *  the port convention (never silently drop a knowingly-deferred test).
 *
 * Every Python `def test_*` maps to a vitest `it()` with the same name and
 * assertion polarity; each Python `class Test*` maps to a `describe(...)`.
 * The DirListingMixin (data-dir isolation + dir-listing cache reset) is a
 * cross-cutting fixture that would attach to each class once skill_cache lands.
 */
import { describe, it } from "vitest";

describe("TestDirListingBasic", () => {
  // PORT: deferred — token_goat.skill_cache (Layer 6); _get_skills_dir_listing /
  // _skill_outputs_dir / store_compact are not yet ported (no module to import,
  // and compact's _setSkillCacheModule seam does not expose these symbols).

  it.skip("test_returns_existing_compact_file", () => {
    // PORT: deferred — token_goat.skill_cache (Layer 6).
  });

  it.skip("test_returns_empty_for_empty_dir", () => {
    // PORT: deferred — token_goat.skill_cache (Layer 6).
  });
});

describe("TestDirListingCacheHit", () => {
  // PORT: deferred — token_goat.skill_cache (Layer 6).

  it.skip("test_second_call_returns_same_list_object", () => {
    // PORT: deferred — token_goat.skill_cache (Layer 6).
  });

  it.skip("test_iterdir_called_only_once_for_rapid_calls", () => {
    // PORT: deferred — token_goat.skill_cache (Layer 6).
  });
});

describe("TestDirListingCacheExpiry", () => {
  // PORT: deferred — token_goat.skill_cache (Layer 6); mutates the module-global
  // skill_cache._dir_listing_cache + reads _DIR_LISTING_CACHE_TTL_SECS, neither
  // of which exists in ts/src or behind the compact seam.

  it.skip("test_cache_refreshes_after_ttl", () => {
    // PORT: deferred — token_goat.skill_cache (Layer 6).
  });

  it.skip("test_new_file_visible_after_ttl", () => {
    // PORT: deferred — token_goat.skill_cache (Layer 6).
  });
});

describe("TestGetCompactAnySessionWithCache", () => {
  // PORT: deferred — token_goat.skill_cache (Layer 6); exercises the REAL
  // get_compact_any_session + store_compact + dir-listing cache, not the
  // compact-side stub surface.

  it.skip("test_returns_compact_for_any_session", () => {
    // PORT: deferred — token_goat.skill_cache (Layer 6).
  });

  it.skip("test_multiple_skills_same_scan", () => {
    // PORT: deferred — token_goat.skill_cache (Layer 6).
  });
});

describe("TestDirListingFailSoft", () => {
  // PORT: deferred — token_goat.skill_cache (Layer 6).

  it.skip("test_returns_empty_list_on_oserror", () => {
    // PORT: deferred — token_goat.skill_cache (Layer 6).
  });
});
