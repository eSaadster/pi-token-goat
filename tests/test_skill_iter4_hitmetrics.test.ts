/**
 * Tests for iteration 4 skill improvements:
 *
 *   1. Per-session compact hit metrics (compact_served_count on SkillEntry).
 *   2. Manifest skill ordering by recency + frequency composite score.
 *   3. token-goat map Active skills footer.
 *
 * 1:1 port of tests/test_skill_iter4_hitmetrics.py (class->describe, def->it,
 * same names + assertion polarity).
 *
 * Port notes:
 *  - Python SkillEntry(positional kwargs) -> TS new SkillEntry({ ... }) (the TS
 *    dataclass-port takes an init object).
 *  - Python `from token_goat.session import SkillEntry, _serialize_skill_entry,
 *    _parse_skill_entry, record_skill_compact_hit, get_skill_history` — all
 *    exported from session.ts.
 *  - The Python TestRecordSkillCompactHit / TestGetSkillHistory tests patch
 *    session._resolve_cache / _commit_mutation and call session._fresh_cache.
 *    Those three helpers are MODULE-PRIVATE in session.ts (not exported), so the
 *    patches cannot be reproduced. They are unnecessary in TS: _resolve_cache(
 *    sid, cache) returns the SAME cache object when cache.session_id === sid, and
 *    _commit_mutation persists to the per-test tmp data dir (setup.ts) and
 *    returns that same object. So each test builds a real SessionCache for the
 *    session id via `new SessionCache({...})`, seeds skill_history, and calls the
 *    real exported function with { cache } — the behaviour under test is
 *    identical and observed on the returned cache. The Python `_fresh_cache(sid)`
 *    construction maps to `new SessionCache({ session_id: sid, started_ts: now,
 *    last_activity_ts: now })`.
 *  - skill_history is a Record<string, SkillEntry>; Python `.get(name)` ->
 *    `skill_history[name]` (undefined when absent).
 *  - TestSkillManifestOrdering: compact._select_top_skill_entries is NOT in the
 *    ported compact.ts -> DEFERRED.
 *  - TestBuildMapSkillsFooter: cli._build_map_skills_footer is in the unported
 *    cli/app module -> DEFERRED.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import { _build_map_skills_footer } from "../src/token_goat/cli_map.js";
import { _select_top_skill_entries } from "../src/token_goat/compact.js";
import * as session from "../src/token_goat/session.js";
import * as skill_cache from "../src/token_goat/skill_cache.js";

afterEach(() => {
  vi.restoreAllMocks();
});
import {
  SessionCache,
  SkillEntry,
  _parse_skill_entry,
  _serialize_skill_entry,
} from "../src/token_goat/session.js";

/** tests/test_skill_iter4_hitmetrics.py:_make_entry — a SkillEntry with run_count. */
function _make_entry(name: string, ts: number, run_count = 1): SkillEntry {
  return new SkillEntry({
    skill_name: name,
    output_id: `oid_${name}`,
    content_sha: `sha_${name}`,
    ts,
    body_bytes: 500,
    run_count,
  });
}

/** Build a fresh SessionCache for *sid* (Python session._fresh_cache(sid)). */
function freshCache(sid: string): SessionCache {
  const now = Date.now() / 1000;
  return new SessionCache({ session_id: sid, started_ts: now, last_activity_ts: now });
}

// ── 1. compact_served_count on SkillEntry ─────────────────────────────────────

describe("TestCompactServedCount", () => {
  it("test_skill_entry_has_compact_served_count", () => {
    const entry = new SkillEntry({
      skill_name: "ralph",
      output_id: "abc123",
      content_sha: "sha1",
      ts: Date.now() / 1000,
      body_bytes: 1000,
    });
    expect(entry.compact_served_count).toBe(0);
  });

  it("test_compact_served_count_nonzero", () => {
    const entry = new SkillEntry({
      skill_name: "ralph",
      output_id: "abc123",
      content_sha: "sha1",
      ts: Date.now() / 1000,
      body_bytes: 1000,
      compact_served_count: 3,
    });
    expect(entry.compact_served_count).toBe(3);
  });

  it("test_serialize_omits_zero", () => {
    const entry = new SkillEntry({
      skill_name: "ralph",
      output_id: "abc123",
      content_sha: "sha1",
      ts: Date.now() / 1000,
      body_bytes: 1000,
      compact_served_count: 0,
    });
    const d = _serialize_skill_entry(entry);
    expect("compact_served_count" in d).toBe(false);
  });

  it("test_serialize_includes_nonzero", () => {
    const entry = new SkillEntry({
      skill_name: "ralph",
      output_id: "abc123",
      content_sha: "sha1",
      ts: Date.now() / 1000,
      body_bytes: 1000,
      compact_served_count: 5,
    });
    const d = _serialize_skill_entry(entry);
    expect(d["compact_served_count"]).toBe(5);
  });

  it("test_parse_roundtrip", () => {
    const original = new SkillEntry({
      skill_name: "improve",
      output_id: "xyz789",
      content_sha: "deadbeef",
      ts: 1700000000.0,
      body_bytes: 2048,
      compact_served_count: 7,
    });
    const wire = _serialize_skill_entry(original);
    const parsed = _parse_skill_entry(wire as Record<string, unknown>);
    expect(parsed).not.toBeNull();
    expect(parsed?.compact_served_count).toBe(7);
  });

  it("test_parse_missing_field_defaults_to_zero", () => {
    const wire = {
      skill_name: "ralph",
      output_id: "abc123",
      content_sha: "sha1",
      ts: 1700000000.0,
      body_bytes: 1000,
      truncated: false,
      run_count: 1,
    };
    const parsed = _parse_skill_entry(wire);
    expect(parsed).not.toBeNull();
    expect(parsed?.compact_served_count).toBe(0);
  });
});

describe("TestRecordSkillCompactHit", () => {
  it("test_increments_count", () => {
    const sid = "test_compact_hit_0001";
    const entry = new SkillEntry({
      skill_name: "ralph",
      output_id: "abc123",
      content_sha: "sha1",
      ts: Date.now() / 1000,
      body_bytes: 1000,
      compact_served_count: 0,
    });
    const cache = freshCache(sid);
    cache.skill_history["ralph"] = entry;

    const result = session.record_skill_compact_hit(sid, "ralph", { cache });
    const updated_entry = result.skill_history["ralph"];
    expect(updated_entry).not.toBeUndefined();
    expect(updated_entry?.compact_served_count).toBe(1);
  });

  it("test_increments_again", () => {
    const sid = "test_compact_hit_0002";
    const entry = new SkillEntry({
      skill_name: "improve",
      output_id: "def456",
      content_sha: "sha2",
      ts: Date.now() / 1000,
      body_bytes: 500,
      compact_served_count: 4,
    });
    const cache = freshCache(sid);
    cache.skill_history["improve"] = entry;

    const result = session.record_skill_compact_hit(sid, "improve", { cache });
    const updated = result.skill_history["improve"];
    expect(updated).not.toBeUndefined();
    expect(updated?.compact_served_count).toBe(5);
  });

  it("test_missing_entry_is_noop", () => {
    const sid = "test_compact_hit_0003";
    const cache = freshCache(sid);
    // skill_history is empty — calling record_skill_compact_hit must not raise.
    const result = session.record_skill_compact_hit(sid, "nonexistent", { cache });
    expect(result).toBe(cache); // returns unchanged cache
  });
});

describe("TestGetSkillHistory", () => {
  it("test_returns_dict", () => {
    const sid = "test_get_history_0001";
    const entry = new SkillEntry({
      skill_name: "ralph",
      output_id: "abc",
      content_sha: "sha",
      ts: Date.now() / 1000,
      body_bytes: 100,
    });
    const cache = freshCache(sid);
    cache.skill_history["ralph"] = entry;

    const result = session.get_skill_history(sid, { cache });
    expect(result).not.toBeNull();
    expect(result !== null && "ralph" in result).toBe(true);
  });

  it("test_empty_history_returns_none", () => {
    const sid = "test_get_history_0002";
    const cache = freshCache(sid);
    // skill_history is empty dict → should return None (falsy).
    const result = session.get_skill_history(sid, { cache });
    expect(result).toBeNull();
  });
});

// ── 2. Manifest ordering: recency + frequency composite score ─────────────────

describe("TestSkillManifestOrdering", () => {
  // compact._select_top_skill_entries is ported + exported from compact.ts.
  it("test_more_recent_wins_over_older_with_equal_run_count", () => {
    const now = Date.now() / 1000;
    const history = {
      old: _make_entry("old", now - 120, 1),
      new: _make_entry("new", now - 10, 1),
    };
    const result = _select_top_skill_entries(history, { session_started_ts: now - 3600 });
    const names = result.map((e) => String((e as { skill_name?: string }).skill_name ?? ""));
    expect(names.indexOf("new")).toBeLessThan(names.indexOf("old"));
  });

  it("test_high_run_count_can_promote_slightly_older", () => {
    // run_count=4 loaded 3 min ago (score = now) should outrank run_count=1
    // loaded 2 min ago (score = now-120). Each extra load is worth +60 s.
    const now = Date.now() / 1000;
    const history = {
      heavily_used: _make_entry("heavily_used", now - 180, 4),
      barely_used: _make_entry("barely_used", now - 120, 1),
    };
    const result = _select_top_skill_entries(history, { session_started_ts: now - 3600 });
    const names = result.map((e) => String((e as { skill_name?: string }).skill_name ?? ""));
    expect(names.indexOf("heavily_used")).toBeLessThan(names.indexOf("barely_used"));
  });

  it("test_much_more_recent_still_wins_despite_lower_run_count", () => {
    // new_once (now-10, rc=1) score=now-10 beats old_frequent (now-600, rc=6)
    // score=now-300.
    const now = Date.now() / 1000;
    const history = {
      old_frequent: _make_entry("old_frequent", now - 600, 6),
      new_once: _make_entry("new_once", now - 10, 1),
    };
    const result = _select_top_skill_entries(history, { session_started_ts: now - 3600 });
    const names = result.map((e) => String((e as { skill_name?: string }).skill_name ?? ""));
    expect(names.indexOf("new_once")).toBeLessThan(names.indexOf("old_frequent"));
  });

  it("test_stable_order_with_equal_score", () => {
    const now = Date.now() / 1000;
    const history = {
      a: _make_entry("a", now - 60, 2),
      b: _make_entry("b", now - 60, 2),
    };
    const result = _select_top_skill_entries(history, { session_started_ts: now - 3600 });
    const names = new Set(result.map((e) => String((e as { skill_name?: string }).skill_name ?? "")));
    expect(names.has("a")).toBe(true);
    expect(names.has("b")).toBe(true);
  });
});

// ── 3. token-goat map Active skills footer ────────────────────────────────────

describe("TestBuildMapSkillsFooter", () => {
  // cli._build_map_skills_footer is ported + exported from cli_map.ts. The
  // Python patch("token_goat.X.fn") sites map to vi.spyOn(module, "fn") — the
  // impl calls list_outputs / get_skill_history / safe_load / get_compact via
  // the skill_cache.* / session.* module namespaces, so the spies intercept.
  it("test_returns_empty_when_no_outputs", () => {
    vi.spyOn(skill_cache, "list_outputs").mockReturnValue([]);
    const result = _build_map_skills_footer();
    expect(result).toBe("");
  });

  it("test_returns_empty_when_skill_history_empty", () => {
    const mock_output = [{ output_id: "abcdef0123456789", mtime: Date.now() / 1000 }];
    vi.spyOn(skill_cache, "list_outputs").mockReturnValue(mock_output);
    vi.spyOn(session, "get_skill_history").mockReturnValue(null);
    const result = _build_map_skills_footer();
    expect(result).toBe("");
  });

  it("test_returns_footer_with_skill_names", () => {
    const now = Date.now() / 1000;
    const entry = new SkillEntry({
      skill_name: "ralph",
      output_id: "abcdef0123456789",
      content_sha: "sha1",
      ts: now,
      body_bytes: 30000,
      run_count: 2,
    });
    const mock_output = [{ output_id: "abcdef0123456789", mtime: now }];

    vi.spyOn(skill_cache, "list_outputs").mockReturnValue(mock_output);
    vi.spyOn(session, "get_skill_history").mockReturnValue({ ralph: entry });
    vi.spyOn(session, "safe_load").mockReturnValue({ started_ts: now - 3600 } as unknown as SessionCache);
    vi.spyOn(skill_cache, "get_compact").mockReturnValue(null);

    const result = _build_map_skills_footer();
    expect(result).toContain("Active skills");
    expect(result).toContain("ralph");
    expect(result).toContain("skill-body ralph");
  });

  it("test_footer_shows_run_count_multiplier", () => {
    const now = Date.now() / 1000;
    const entry = new SkillEntry({
      skill_name: "improve",
      output_id: "abcdef0123456789",
      content_sha: "sha1",
      ts: now,
      body_bytes: 10000,
      run_count: 3,
    });
    const mock_output = [{ output_id: "abcdef0123456789", mtime: now }];

    vi.spyOn(skill_cache, "list_outputs").mockReturnValue(mock_output);
    vi.spyOn(session, "get_skill_history").mockReturnValue({ improve: entry });
    vi.spyOn(session, "safe_load").mockReturnValue({ started_ts: now - 3600 } as unknown as SessionCache);
    vi.spyOn(skill_cache, "get_compact").mockReturnValue(null);

    const result = _build_map_skills_footer();
    expect(result).toContain("×3");
  });

  it("test_footer_shows_compact_token_count", () => {
    const now = Date.now() / 1000;
    const entry = new SkillEntry({
      skill_name: "ralph",
      output_id: "abcdef0123456789",
      content_sha: "sha1",
      ts: now,
      body_bytes: 30000,
      run_count: 1,
    });
    const mock_output = [{ output_id: "abcdef0123456789", mtime: now }];
    const compact_text = "# ralph compact\n- MUST do X\n- NEVER do Y\n".repeat(10);

    vi.spyOn(skill_cache, "list_outputs").mockReturnValue(mock_output);
    vi.spyOn(session, "get_skill_history").mockReturnValue({ ralph: entry });
    vi.spyOn(session, "safe_load").mockReturnValue({ started_ts: now - 3600 } as unknown as SessionCache);
    vi.spyOn(skill_cache, "get_compact").mockReturnValue(compact_text);

    const result = _build_map_skills_footer();
    expect(result).toContain("compact:");
    expect(result).toContain("tok");
  });

  it("test_footer_suppressed_when_exception_in_list_outputs", () => {
    vi.spyOn(skill_cache, "list_outputs").mockImplementation(() => {
      throw new Error("disk full");
    });
    const result = _build_map_skills_footer();
    expect(result).toBe("");
  });
});
