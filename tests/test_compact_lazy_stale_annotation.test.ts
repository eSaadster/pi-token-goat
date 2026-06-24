/**
 * 1:1 port of tests/test_compact_lazy_stale_annotation.py — the stale-compact
 * annotation in lazy skill-injection pointer lines (iter 7/10).
 *
 * Each Python `class Test*` maps to a vitest `describe(...)`; each `def test_*`
 * maps to an `it(...)` with the SAME name + SAME assertion polarity.
 *
 * ---------------------------------------------------------------------------
 * What the suite covers (Python module docstring)
 * ---------------------------------------------------------------------------
 *  A. Fresh compact  (embedded SHA matches session content_sha) -> no [stale].
 *  B. Stale compact  (embedded SHA mismatch)                    -> [stale].
 *  C. Compact w/o a SHA header (old format)                     -> no [stale]
 *     (unknown is not stale).
 *  D. No compact at all                                         -> bare pointer,
 *     no [stale].
 *  E. The [stale] token sits INSIDE the parenthesised token count, not as a
 *     separate word: "name (N tok [stale])".
 *
 * ---------------------------------------------------------------------------
 * Mapping notes (Python -> TS)
 * ---------------------------------------------------------------------------
 *  - SKILL_CACHE SEAM. The Python test drives the *real* skill_cache pipeline:
 *    `fire_skill_hook(...)` (PostToolUse(Skill) hook -> hooks_skill.post_skill)
 *    records the skill into the session AND auto-generates a compact whose header
 *    embeds the source SHA, and `store_compact(..., source_sha=...)` overwrites it
 *    with a chosen SHA. skill_cache.ts / hooks_skill.ts are NOT ported, but
 *    compact.ts exposes the `_setSkillCacheModule` injection seam (the port mirror
 *    of Python's lazy `from . import skill_cache`). The lazy pointer-line builder
 *    in compact._render reads exactly four skill_cache functions:
 *        get_compact, get_compact_any_session, _strip_compact_header,
 *        extract_compact_source_sha
 *    so each sub-area reproduces the Python end-state by (1) recording a skill via
 *    session.mark_skill_loaded with a known content_sha, and (2) injecting a stub
 *    skill_cache through the seam whose extract_compact_source_sha returns a SHA
 *    that matches (fresh), mismatches (stale), or is null (no header) — or whose
 *    get_compact* return null (no compact at all). This is the designated
 *    mechanism for an unported sibling and is faithful to the patched-loader
 *    behaviour, so NONE of these tests are skipped.
 *
 *  - The staleness decision in compact._render is:
 *        _entry_sha = skill_entry.content_sha
 *        _compact_sha = extract_compact_source_sha(compact_text)
 *        stale iff (_compact_sha and _entry_sha and
 *                   not _entry_sha.startsWith(_compact_sha))
 *    i.e. a fresh compact embeds a SHA that is a PREFIX of the session's recorded
 *    content_sha (Python store_compact embeds only the first 12 hex chars). The
 *    fresh stub therefore returns a prefix of the entry's content_sha; the stale
 *    stub returns "000000000000" (never a prefix); the no-header stub returns
 *    null.
 *
 *  - `_lazy_config()` (Python: lazy_skill_injection=True + inline_snippets=False)
 *    -> a `config.load` spy returning the real config with skill_preservation
 *    .inline_snippets=false and compact_assist.lazy_skill_injection=true. compact
 *    derives `lazy = inline_snippets ? false : (lazy_skill_injection ?? true)`, so
 *    inline_snippets=false + lazy_skill_injection=true forces the lazy path. The
 *    Python patch targets `compact._load_config`; the TS compact calls
 *    `config.load()` via the STATIC `import * as config`, so the twin spies
 *    config.load (the same end state). Reported in parity_notes.
 *
 *  - DataDirMixin (Python) -> the per-test tmp data dir is provided by
 *    tests/setup.ts (setDataDirOverride in beforeEach), so no per-class fixture is
 *    needed; each describe just builds its session in-place.
 *
 *  - `extract_compact_source_sha` / `get_compact` are imported in the Python test
 *    from token_goat.skill_cache to assert the auto-generated compact has a SHA
 *    header before driving the manifest. With the stub seam we *are* the
 *    skill_cache, so the equivalent precondition holds by construction (the fresh
 *    stub returns a non-null compact with a non-null SHA), and the Python
 *    `pytest.skip(...)` guards (compact not auto-generated / stored without a sha
 *    header) can never trigger — they are commented at the call site.
 *
 *  - `_skill_outputs_dir()` + the "delete every *-compact file" loop in sub-area D
 *    (Python) reach into the real skill_cache on-disk layout. With the stub seam
 *    the no-compact state is expressed directly: the stub's get_compact /
 *    get_compact_any_session return null. Reported in parity_notes.
 *
 * No clock mock is needed: the SHA-mismatch [stale] annotation does not depend on
 * timestamps, and the recorded skill (ts = real now) is well within the
 * _select_top_skill_entries session window, so it always survives into the lazy
 * pointer-line path.
 *
 * Per-test tmp data dir + cache/seam clearing is handled by tests/setup.ts;
 * afterEach below additionally clears the injected skill_cache stub.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import * as compact from "../src/token_goat/compact.js";
import * as config from "../src/token_goat/config.js";
import * as session from "../src/token_goat/session.js";

import type { ConfigSchema } from "../src/token_goat/types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// The Python _SKILL_BODY is a long skill body fed to the real hook; with the
// stub seam the body text is irrelevant (the stub controls the compact + SHA),
// but it is kept verbatim for documentation parity. Only its existence as a
// loaded skill matters here.
const _SKILL_BODY =
  "---\ndescription: Lazy stale annotation test skill.\n---\n\n" +
  "## Rules\n\nCRITICAL: always test.\nMUST: never skip.\n\n" +
  "## Details\n\n" +
  "Detail line. ".repeat(400);

// A compact body to overwrite the auto-generated one (Python _FRESH_COMPACT).
// The stub returns this from get_compact in every sub-area that has a compact.
const _FRESH_COMPACT =
  "## Rules\n\nCRITICAL: always test.\nMUST: never skip.\n\n" +
  "## Details\n\nOverwritten compact for test purposes.\n";

// The full content_sha recorded for the skill (the session's content_sha). The
// fresh embedded SHA is a 12-char prefix of this (mirrors store_compact's
// source_sha[:12] embedding); the stale embedded SHA is "000000000000".
const _ENTRY_CONTENT_SHA = "abc123def456789012345678";
const _FRESH_EMBEDDED_SHA = _ENTRY_CONTENT_SHA.slice(0, 12); // "abc123def456"
const _STALE_EMBEDDED_SHA = "000000000000";

/**
 * The four-function skill_cache surface compact._render consumes on the lazy
 * path. Mirrors the compact.ts `_SkillCacheModule` interface; each sub-area
 * supplies the variant it needs.
 */
interface SkillCacheStub {
  get_compact(session_id: string, skill_name: string): string | null;
  get_compact_any_session(skill_name: string): string | null;
  extract_compact_source_sha(compact_text: string): string | null;
  _strip_compact_header(compact_text: string): string;
}

/**
 * Build a skill_cache stub. `compact` is the text get_compact* return (null for
 * the no-compact case); `embeddedSha` is what extract_compact_source_sha returns
 * (null for the old-format / no-header case). _strip_compact_header is the
 * identity (the bare-compact token estimate is not asserted on here).
 */
function makeSkillCacheStub(opts: {
  compactText: string | null;
  embeddedSha: string | null;
}): SkillCacheStub {
  return {
    get_compact: () => opts.compactText,
    get_compact_any_session: () => opts.compactText,
    extract_compact_source_sha: () => opts.embeddedSha,
    _strip_compact_header: (t: string) => t,
  };
}

/**
 * Spy config.load so compact derives the lazy (recall-only) skill-injection
 * path: inline_snippets=false + lazy_skill_injection=true. Python `_lazy_config`.
 */
function patchLazyConfig(): void {
  const real = config.load();
  const patched: ConfigSchema = {
    ...real,
    compact_assist: { ...(real.compact_assist ?? {}), lazy_skill_injection: true },
    skill_preservation: { ...(real.skill_preservation ?? {}), inline_snippets: false },
  };
  vi.spyOn(config, "load").mockReturnValue(patched);
}

afterEach(() => {
  // Clear the injected skill_cache stub so it cannot leak across tests.
  compact._setSkillCacheModule(undefined);
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// Sub-area A — fresh compact (SHA match) -> no [stale] annotation
// ---------------------------------------------------------------------------

describe("TestFreshCompactNoStaleAnnotation", () => {
  it("test_fresh_compact_no_stale_flag", () => {
    // When the compact's embedded SHA matches the session content_sha, no [stale].
    const sid = "lazy7-fresh-01";
    // fire_skill_hook(sid, "freshskill", _SKILL_BODY) -> record the skill load
    // (the body itself is irrelevant once the stub controls the compact + SHA).
    void _SKILL_BODY;
    session.mark_skill_loaded(sid, "freshskill", "freshskill-out", _ENTRY_CONTENT_SHA, 32000, false);

    // Python guards: get_compact(...) is not None and extract_compact_source_sha
    // is not None. With the fresh stub both hold by construction (no pytest.skip).
    compact._setSkillCacheModule(
      makeSkillCacheStub({ compactText: _FRESH_COMPACT, embeddedSha: _FRESH_EMBEDDED_SHA }),
    );

    patchLazyConfig();
    const m = compact.build_manifest(sid, { max_tokens: 50_000 });

    // Fresh compact: no stale annotation expected.
    expect(m.includes("[stale]")).toBe(false);
    expect(m.includes("freshskill")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Sub-area B — stale compact (SHA mismatch) -> [stale] annotation present
// ---------------------------------------------------------------------------

describe("TestStaleCompactAnnotation", () => {
  it("test_stale_compact_shows_stale_annotation", () => {
    // When the embedded SHA differs from the session content_sha, [stale] appears.
    const sid = "lazy7-stale-01";
    session.mark_skill_loaded(sid, "staleskill", "staleskill-out", _ENTRY_CONTENT_SHA, 32000, false);

    // store_compact(sid, "staleskill", _FRESH_COMPACT, source_sha="000000000000")
    // -> the compact embeds a SHA that won't match the session's content_sha.
    compact._setSkillCacheModule(
      makeSkillCacheStub({ compactText: _FRESH_COMPACT, embeddedSha: _STALE_EMBEDDED_SHA }),
    );

    patchLazyConfig();
    const m = compact.build_manifest(sid, { max_tokens: 50_000 });

    expect(m.includes("staleskill")).toBe(true);
    expect(m.includes("[stale]")).toBe(true);
  });

  it("test_stale_annotation_inside_parens", () => {
    // The [stale] annotation appears inside the token count parentheses.
    const sid = "lazy7-stale-02";
    session.mark_skill_loaded(sid, "parencheck", "parencheck-out", _ENTRY_CONTENT_SHA, 32000, false);

    compact._setSkillCacheModule(
      makeSkillCacheStub({ compactText: _FRESH_COMPACT, embeddedSha: _STALE_EMBEDDED_SHA }),
    );

    patchLazyConfig();
    const m = compact.build_manifest(sid, { max_tokens: 50_000 });

    // Should match: "parencheck (N tok [stale])"
    expect(/parencheck \(\d+ tok \[stale\]\)/.test(m)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Sub-area C — compact without SHA header -> no [stale] annotation
// ---------------------------------------------------------------------------

describe("TestCompactWithoutShaHeader", () => {
  it("test_no_stale_when_no_sha_header", () => {
    // Compacts written without a SHA header (old format) are not flagged stale.
    const sid = "lazy7-nosha-01";
    session.mark_skill_loaded(sid, "noshaskill", "noshaskill-out", _ENTRY_CONTENT_SHA, 32000, false);

    // store_compact(..., source_sha=None) omits the sha header ->
    // extract_compact_source_sha returns null (unknown, not stale).
    compact._setSkillCacheModule(
      makeSkillCacheStub({ compactText: _FRESH_COMPACT, embeddedSha: null }),
    );

    patchLazyConfig();
    const m = compact.build_manifest(sid, { max_tokens: 50_000 });

    expect(m.includes("noshaskill")).toBe(true);
    // No SHA to compare against -> cannot determine staleness -> no [stale] flag.
    expect(m.includes("[stale]")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Sub-area D — no compact at all -> bare pointer, no [stale]
// ---------------------------------------------------------------------------

describe("TestNoCompactNoBareStale", () => {
  it("test_bare_pointer_has_no_stale_flag", () => {
    // When no compact exists at all, the bare pointer line has no [stale].
    const sid = "lazy7-bare-01";
    session.mark_skill_loaded(sid, "bareskill", "bareskill-out", _ENTRY_CONTENT_SHA, 32000, false);

    // Python deletes every "*-compact" file from _skill_outputs_dir(); with the
    // stub seam the no-compact state is expressed by get_compact* returning null.
    compact._setSkillCacheModule(
      makeSkillCacheStub({ compactText: null, embeddedSha: null }),
    );

    patchLazyConfig();
    const m = compact.build_manifest(sid, { max_tokens: 50_000 });

    expect(m.includes("bareskill")).toBe(true);
    expect(m.includes("[stale]")).toBe(false);
  });
});
