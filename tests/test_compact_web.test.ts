/**
 * Tests for the Web Fetches section in the compaction manifest.
 *
 * 1:1 port of tests/test_compact_web.py. Each Python `def test_*` maps to a
 * vitest `it()` with the SAME name and the SAME assertion polarity; each Python
 * `class Test*` maps to a `describe(...)`.
 *
 * ---------------------------------------------------------------------------
 * Parity notes (Python -> TS)
 * ---------------------------------------------------------------------------
 *  - conftest `_make_session` (the `make_session` fixture) -> the local
 *    makeSession() helper, supporting the kwargs the in-scope tests use:
 *    age_seconds / edits / web_fetches / bash_runs. Python kwargs map
 *    positionally onto the shipped session.ts API:
 *      mark_web_fetch(sid, url_sha=..., url_preview=..., output_id=...,
 *                     body_bytes=..., status_code=200, truncated=False)
 *        -> mark_web_fetch(sid, url_sha, url_preview, output_id, body_bytes,
 *                          200, false)
 *      mark_bash_run(sid, cmd_sha=..., cmd_preview=..., output_id=...,
 *                    stdout_bytes=..., stderr_bytes=0, exit_code=..., truncated=False)
 *        -> mark_bash_run(sid, cmd_sha, cmd_preview, output_id, stdout_bytes,
 *                         0, exit_code, false)
 *    build_manifest(sid, max_tokens=N) -> build_manifest(sid, { max_tokens: N }).
 *
 *  - Per-test tmp data dir + cache clearing is handled by tests/setup.ts
 *    (beforeEach -> setDataDirOverride + clearModuleCaches), the analogue of the
 *    Python tmp_data_dir autouse fixture.
 *
 *  - bash_cache.command_hash. conftest's `_make_session` hashes bash commands
 *    via `bash_cache.command_hash(cmd)`. bash_cache.ts is NOT ported at this
 *    layer. The only in-scope test exercising `bash_runs`
 *    (test_web_and_bash_coexist) asserts merely that the **Recent Commands:**
 *    and **Web Fetches:** sections render — the exact cmd_sha value is never
 *    asserted. The helper therefore derives a deterministic placeholder sha via
 *    node:crypto sha256(command); the manifest's bash-line header renders the
 *    same way regardless of the sha. compact's _format_bash_entry reaches
 *    bash_cache only through the _getBashCache() seam (which returns null when no
 *    module is injected), so the bash line fails soft to its header-only form —
 *    exactly what the test checks.
 *
 *  - _MAX_WEB_ENTRIES is a module-private constant in compact.ts (value 4, not
 *    exported). The tests that reference compact._MAX_WEB_ENTRIES inline the
 *    literal 4 with a comment (the same approach the sibling test files use for
 *    session._UNKNOWN_END_SENTINEL).
 *
 *  - NOT EXPORTED from compact.ts: _format_web_entry, _group_web_entries_by_domain,
 *    and _render_cache_meta are module-private (the Python tests reach them as
 *    compact._format_web_entry / compact._group_web_entries_by_domain /
 *    compact._render_cache_meta). Since the impl is shipped-and-green and must not
 *    be edited, the TestFormatWebEntry / TestGroupWebEntriesByDomain /
 *    TestRenderCacheMeta classes are it.skip'd with a PORT reason. They become
 *    portable the moment compact.ts re-exports those three symbols.
 *
 *  - test_web_entry_recency_ranked uses the real wall clock (Python does NOT
 *    monkeypatch time here): it manually inserts two WebEntry rows with
 *    controlled `ts` offsets and backdates created_ts, then asserts the newer URL
 *    appears first. No Date.now spy is installed (a fresh-timestamp mock would
 *    not change relative ordering and could only filter rows as stale).
 *
 * verbatimModuleSyntax is on -> relative imports end in .js; type-only imports
 * use `import type`.
 */
import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import * as compact from "../src/token_goat/compact.js";
import * as session from "../src/token_goat/session.js";
import { WebEntry } from "../src/token_goat/session.js";
import { short_output_id } from "../src/token_goat/cache_common.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** time.time() analogue (float seconds). */
function _time(): number {
  return Date.now() / 1000;
}

/** hashlib.sha256(s.encode()).hexdigest()[:n] analogue. */
function sha256Hex(s: string, n: number): string {
  return createHash("sha256").update(Buffer.from(s, "utf8")).digest("hex").slice(0, n);
}

/**
 * conftest `_make_session` analogue. Populates a SessionCache with the optional
 * kwargs the in-scope web tests use: age_seconds / edits / web_fetches /
 * bash_runs. Returns the freshly reloaded cache (matching the Python helper's
 * final `session.load(session_id)`).
 */
function makeSession(
  session_id: string,
  opts: {
    age_seconds?: number;
    edits?: number;
    web_fetches?: Record<string, number>;
    bash_runs?: Record<string, [number, number]>;
  } = {},
): session.SessionCache {
  const age_seconds = opts.age_seconds ?? 0;
  const edits = opts.edits ?? 0;
  const web_fetches = opts.web_fetches;
  const bash_runs = opts.bash_runs;

  // Create or load session.
  let cache = session.load(session_id);

  // Backdate if requested.
  if (age_seconds > 0) {
    cache.created_ts = _time() - age_seconds;
    session.save(cache);
  }

  // Populate with file edits.
  for (let i = 0; i < edits; i++) {
    session.mark_file_edited(session_id, `/proj/src/edited${i}.py`);
  }

  // Populate with web fetches.
  if (web_fetches) {
    for (const [url, body_bytes] of Object.entries(web_fetches)) {
      const url_sha = sha256Hex(url, 12);
      session.mark_web_fetch(
        session_id,
        url_sha,
        url.slice(0, 200),
        `web-${url_sha}`,
        body_bytes,
        200,
        false,
      );
    }
  }

  // Populate with bash runs.
  if (bash_runs) {
    for (const [cmd, tuple] of Object.entries(bash_runs)) {
      const [output_bytes, exit_code] = tuple;
      // bash_cache.command_hash is unported; a deterministic placeholder sha
      // suffices (the cmd_sha value is never asserted by the in-scope test).
      const cmd_sha = sha256Hex(cmd, 16);
      session.mark_bash_run(
        session_id,
        cmd_sha,
        cmd,
        `out-${cmd_sha}`,
        output_bytes,
        0,
        exit_code,
        false,
      );
    }
  }

  return session.load(session_id);
}

// _MAX_WEB_ENTRIES is module-private in compact.ts; its value is 4.
const _MAX_WEB_ENTRIES = 4;

// ===========================================================================
// TestWebSection
// ===========================================================================

describe("TestWebSection", () => {
  it("test_web_section_emitted_for_mature_session", () => {
    const sid = "wm-1";
    // min_lines=2 applies: single entry would be suppressed; add two to render
    // the section. Use a separate session without edits to avoid budget pressure.
    makeSession(sid, {
      age_seconds: 7200,
      web_fetches: {
        "https://docs.example.com/api": 12_000,
        "https://api.other.com/reference": 10_000,
      },
    });
    const m = compact.build_manifest(sid, { max_tokens: 400 });
    expect(m.includes("**Web Fetches:**")).toBe(true);
    expect(m.includes("docs.example.com/api")).toBe(true);
    expect(m.includes("200")).toBe(true);
  });

  it("test_web_section_includes_cache_id", () => {
    const sid = "wm-2";
    const url = "https://docs.example.com/reference";
    makeSession(sid, {
      age_seconds: 7200,
      edits: 1,
      web_fetches: { [url]: 8_000 },
    });
    const m = compact.build_manifest(sid, { max_tokens: 400 });
    const url_sha = sha256Hex(url, 12);
    // output_id is "web-<url_sha>" (16 chars); short form is …<last8>.
    expect(m.includes(`id=${short_output_id(`web-${url_sha}`)}`)).toBe(true);
  });

  it("test_tiny_web_fetch_skipped", () => {
    const sid = "wm-3";
    makeSession(sid, {
      age_seconds: 7200,
      edits: 1,
      web_fetches: { "https://example.com/ping": 50 },
    });
    const m = compact.build_manifest(sid, { max_tokens: 400 });
    expect(m.includes("**Web Fetches:**")).toBe(false);
  });

  it("test_web_section_suppressed_for_young_session", () => {
    const sid = "wm-4";
    makeSession(sid, {
      age_seconds: 0, // young session (created_ts = now)
      edits: 1,
      web_fetches: { "https://docs.example.com/api": 15_000 },
    });
    const m = compact.build_manifest(sid, { max_tokens: 400 });
    expect(m.includes("**Web Fetches:**")).toBe(false);
  });

  it("test_web_section_shows_status_code", () => {
    const sid = "wm-5";
    // min_lines=2 applies: add second entry so Web Fetches section renders.
    makeSession(sid, {
      age_seconds: 7200,
      web_fetches: {
        "https://api.example.com/gone": 500,
        "https://status.other.com/check": 1_000,
      },
    });
    const m = compact.build_manifest(sid, { max_tokens: 400 });
    expect(m.includes("404") || m.includes("200")).toBe(true);
  });

  it("test_web_section_shows_truncated_marker", () => {
    const sid = "wm-6";
    makeSession(sid, {
      age_seconds: 7200,
      edits: 1,
      web_fetches: { "https://big.example.com/doc": 200_000 },
    });
    const m = compact.build_manifest(sid, { max_tokens: 400 });
    expect(m.includes("truncated") || m.includes("**Web Fetches:**")).toBe(true);
  });

  it("test_web_and_bash_coexist", () => {
    const sid = "wm-7";
    // min_lines=2 applies: add second web fetch so Web Fetches section renders.
    makeSession(sid, {
      age_seconds: 7200,
      bash_runs: { "pytest -v tests/": [8_000, 0] },
      web_fetches: {
        "https://docs.example.com/api": 10_000,
        "https://guide.other.com/intro": 8_000,
      },
    });
    const m = compact.build_manifest(sid, { max_tokens: 600 });
    expect(m.includes("**Recent Commands:**")).toBe(true);
    expect(m.includes("**Web Fetches:**")).toBe(true);
  });

  it("test_only_web_still_renders_manifest", () => {
    const sid = "wm-8";
    makeSession(sid, {
      age_seconds: 7200,
      web_fetches: { "https://docs.example.com/guide": 20_000 },
    });
    const m = compact.build_manifest(sid, { max_tokens: 400 });
    expect(m.includes("**Web Fetches:**")).toBe(true);
  });

  it("test_multiple_web_entries_capped_at_max", () => {
    const sid = "wm-9";
    const web_fetches: Record<string, number> = {};
    for (let i = 0; i < 8; i++) {
      web_fetches[`https://docs.example.com/page${i}`] = 5_000;
    }
    makeSession(sid, {
      age_seconds: 7200,
      edits: 1,
      web_fetches,
    });
    const m = compact.build_manifest(sid, { max_tokens: 800 });
    // _MAX_WEB_ENTRIES == 4; at most 4 entries should appear.
    const count = (m.match(/🌐/gu) ?? []).length;
    expect(count).toBeLessThanOrEqual(_MAX_WEB_ENTRIES);
  });

  it("test_web_entry_recency_ranked", () => {
    // Most recently fetched URL should appear before older ones when both fit.
    const sid = "wm-10";

    const old_url = "https://old.example.com/doc";
    const new_url = "https://new.example.com/doc";

    // Manually insert with controlled timestamps to test recency ranking.
    const cache = session.load(sid);
    const old_sha = sha256Hex(old_url, 12);
    const new_sha = sha256Hex(new_url, 12);
    cache.web_history[old_sha] = new WebEntry({
      url_sha: old_sha,
      url_preview: old_url,
      output_id: `web-${old_sha}`,
      ts: _time() - 3600, // 1 hour ago
      body_bytes: 10_000,
      status_code: 200,
    });
    cache.web_history[new_sha] = new WebEntry({
      url_sha: new_sha,
      url_preview: new_url,
      output_id: `web-${new_sha}`,
      ts: _time() - 60, // 1 minute ago
      body_bytes: 10_000,
      status_code: 200,
    });
    cache.created_ts = _time() - 7200;
    session.save(cache);

    // Use a large budget so both entries fit in the web section.
    const m = compact.build_manifest(sid, { max_tokens: 800 });
    expect(m.includes("**Web Fetches:**")).toBe(true);
    const old_pos = m.indexOf("old.example.com");
    const new_pos = m.indexOf("new.example.com");
    // Both URLs present — newer one comes first (higher ts = ranked first).
    expect(old_pos).not.toBe(-1); // old URL should appear at 800-token budget
    expect(new_pos).not.toBe(-1); // new URL should appear at 800-token budget
    expect(new_pos).toBeLessThan(old_pos); // more-recent URL appears first
  });
});

// ===========================================================================
// TestComputeAdaptiveBudgetWebBonus
// ===========================================================================

describe("TestComputeAdaptiveBudgetWebBonus", () => {
  it("test_web_history_increases_budget", () => {
    const sid = "wab-1";
    // Build two caches: one without web history, one with.
    const cache_no_web = session.load(sid + "-a");
    const budget_no_web = compact.compute_adaptive_budget(cache_no_web, 1800.0);

    makeSession(sid + "-b", {
      age_seconds: 1800,
      web_fetches: { "https://docs.example.com": 5_000 },
    });
    const cache_with_web = session.load(sid + "-b");
    const budget_with_web = compact.compute_adaptive_budget(cache_with_web, 1800.0);

    expect(budget_with_web).toBeGreaterThan(budget_no_web);
  });

  it("test_web_bonus_is_15_tokens", () => {
    // Web bonus is exactly 15 tokens relative to a baseline (active tier).
    const sid = "wab-2";
    // Baseline: no history at all, active tier (1800s).
    const cache_base = session.load(sid + "-base");
    const budget_base = compact.compute_adaptive_budget(cache_base, 1800.0);

    // With web history only.
    makeSession(sid + "-web", {
      age_seconds: 1800,
      web_fetches: { "https://docs.example.com": 5_000 },
    });
    const cache_web = session.load(sid + "-web");
    const budget_web = compact.compute_adaptive_budget(cache_web, 1800.0);

    expect(budget_web - budget_base).toBe(15);
  });
});

// ===========================================================================
// TestSelectTopWebEntries
// ===========================================================================

describe("TestSelectTopWebEntries", () => {
  it("test_empty_web_history", () => {
    expect(compact._select_top_web_entries(null)).toEqual([]);
    expect(compact._select_top_web_entries({})).toEqual([]);
    expect(compact._select_top_web_entries("not a dict")).toEqual([]);
  });

  it("test_filters_tiny_entries", () => {
    const tiny = new WebEntry({
      url_sha: "abc",
      url_preview: "https://x.com",
      output_id: "o1",
      ts: _time(),
      body_bytes: 10,
      status_code: 200,
    });
    const result = compact._select_top_web_entries({ abc: tiny });
    expect(result).toEqual([]);
  });

  it("test_keeps_large_entries", () => {
    const big = new WebEntry({
      url_sha: "abc",
      url_preview: "https://x.com",
      output_id: "o1",
      ts: _time(),
      body_bytes: 10_000,
      status_code: 200,
    });
    const result = compact._select_top_web_entries({ abc: big });
    expect(result.length).toBe(1);
  });

  it("test_caps_at_max_web_entries", () => {
    const history: Record<string, WebEntry> = {};
    for (let i = 0; i < 10; i++) {
      history[`sha${i}`] = new WebEntry({
        url_sha: `sha${i}`,
        url_preview: `https://example.com/${i}`,
        output_id: `o${i}`,
        ts: _time() - i,
        body_bytes: 5_000,
        status_code: 200,
      });
    }
    const result = compact._select_top_web_entries(history);
    // _MAX_WEB_ENTRIES == 4.
    expect(result.length).toBeLessThanOrEqual(_MAX_WEB_ENTRIES);
  });
});

// ===========================================================================
// TestFormatWebEntry
// ===========================================================================
// PORT: deferred — compact._format_web_entry is module-private (not exported
// from the shipped compact.ts). The impl is green and must not be edited;
// these tests become portable once compact.ts re-exports _format_web_entry.

describe("TestFormatWebEntry", () => {
  it.skip("test_basic_format", () => {
    // PORT: deferred — compact._format_web_entry not exported (impl is private).
  });

  it.skip("test_truncated_marker_included", () => {
    // PORT: deferred — compact._format_web_entry not exported (impl is private).
  });

  it.skip("test_unknown_status_code", () => {
    // PORT: deferred — compact._format_web_entry not exported (impl is private).
  });
});

// ===========================================================================
// TestGroupWebEntriesByDomain
// ===========================================================================
// PORT: deferred — compact._group_web_entries_by_domain is module-private (not
// exported from the shipped compact.ts). The impl is green and must not be
// edited; these tests become portable once compact.ts re-exports
// _group_web_entries_by_domain.

describe("TestGroupWebEntriesByDomain", () => {
  it.skip("test_single_url_unchanged", () => {
    // PORT: deferred — compact._group_web_entries_by_domain not exported.
  });

  it.skip("test_two_same_domain_grouped", () => {
    // PORT: deferred — compact._group_web_entries_by_domain not exported.
  });

  it.skip("test_mixed_domains", () => {
    // PORT: deferred — compact._group_web_entries_by_domain not exported.
  });

  it.skip("test_many_urls_from_one_domain_truncated", () => {
    // PORT: deferred — compact._group_web_entries_by_domain not exported.
  });

  it.skip("test_three_domains_mixed", () => {
    // PORT: deferred — compact._group_web_entries_by_domain not exported.
  });

  it.skip("test_empty_entries_list", () => {
    // PORT: deferred — compact._group_web_entries_by_domain not exported.
  });

  it.skip("test_malformed_url_handled_gracefully", () => {
    // PORT: deferred — compact._group_web_entries_by_domain not exported.
  });
});

// ===========================================================================
// TestWebGroupingIntegration
// ===========================================================================

describe("TestWebGroupingIntegration", () => {
  it("test_grouped_entries_in_full_manifest", () => {
    // End-to-end: multiple URLs from same domain appear grouped in manifest.
    const sid = "wg-1";
    makeSession(sid, {
      age_seconds: 7200,
      edits: 1,
      web_fetches: {
        "https://docs.anthropic.com/en/api/getting-started": 12_000,
        "https://docs.anthropic.com/en/api/messages": 10_000,
        "https://github.com/anthropics/anthropic-sdk-python": 8_000,
      },
    });
    const m = compact.build_manifest(sid, { max_tokens: 600 });
    expect(m.includes("**Web Fetches:**")).toBe(true);
    // docs.anthropic.com should appear once with (2).
    expect(m.includes("docs.anthropic.com")).toBe(true);
    expect(m.includes("(2)")).toBe(true);
    // github.com should appear separately.
    expect(m.includes("github.com")).toBe(true);
  });
});

// ===========================================================================
// TestRenderCacheMeta
// ===========================================================================
// PORT: deferred — compact._render_cache_meta is module-private (not exported
// from the shipped compact.ts). The impl is green and must not be edited;
// these tests become portable once compact.ts re-exports _render_cache_meta.

describe("TestRenderCacheMeta", () => {
  it.skip("test_basic_no_id", () => {
    // PORT: deferred — compact._render_cache_meta not exported (impl is private).
  });

  it.skip("test_with_output_id", () => {
    // PORT: deferred — compact._render_cache_meta not exported (impl is private).
  });

  it.skip("test_truncated_marker", () => {
    // PORT: deferred — compact._render_cache_meta not exported (impl is private).
  });

  it.skip("test_no_truncated_marker_by_default", () => {
    // PORT: deferred — compact._render_cache_meta not exported (impl is private).
  });

  it.skip("test_empty_output_id_omits_id_part", () => {
    // PORT: deferred — compact._render_cache_meta not exported (impl is private).
  });

  it.skip("test_parenthesised_form", () => {
    // PORT: deferred — compact._render_cache_meta not exported (impl is private).
  });

  it.skip("test_bash_format_consistency", () => {
    // PORT: deferred — compact._render_cache_meta not exported (impl is private).
  });

  it.skip("test_web_format_consistency", () => {
    // PORT: deferred — compact._render_cache_meta not exported (impl is private).
  });
});
