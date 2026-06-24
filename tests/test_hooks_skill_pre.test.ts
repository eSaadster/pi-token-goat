/**
 * Tests for hooks_skill.pre_skill — PreToolUse(Skill) hook.
 *
 * Faithful TS port of tests/test_hooks_skill_pre.py.
 *
 * Covers:
 * 1. Pass-through cases: no session, unknown tool, disabled config, first load with
 *    first_load_compact=False (default).
 * 2. Repeat-load dedup: deny with compact; deny with recall-pointer when no compact;
 *    allow reload when compaction occurred after the skill load.
 * 3. First-load compact (opt-in): deny with compact when COMPACT_END marker present;
 *    allow when marker absent; allow when file not found.
 * 4. _normalize_skill_name: path stripping, .md stripping, empty-after-normalization.
 * 5. _compaction_occurred_after: sentinel absent, sentinel older, sentinel newer.
 *
 * Porting notes:
 *  - Python's `patch.object(session, "lookup_skill_entry")` -> vi.spyOn(session, ...).
 *  - `patch.object(skill_cache, "get_compact")` -> inject a fake SkillCacheModule via
 *    hooks_skill._setSkillCacheModule (skill_cache.ts is Layer 6, not yet ported).
 *  - `patch("...hooks_skill._compaction_occurred_after")` /
 *    `patch("...hooks_skill._resolve_skill_body_path")` -> the dedicated test seams
 *    _setCompactionOccurredAfterOverride / _setResolveSkillBodyPathOverride.
 *  - `_patch_cfg(monkeypatch, ...)` -> vi.spyOn(config, "load") returning a fake
 *    config object with the chosen skill_preservation fields.
 *  - The first-load-compact tests rely on the real
 *    skill_cache.extract_compact_from_marker; that parser is replicated in the fake
 *    injected skill_cache module so the behaviour is byte-for-byte faithful.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import * as session from "../src/token_goat/session.js";
import * as config from "../src/token_goat/config.js";
import * as paths from "../src/token_goat/paths.js";
import {
  pre_skill,
  _compaction_occurred_after,
  _normalize_skill_name,
  _setSkillCacheModule,
  _setCompactionOccurredAfterOverride,
  _setResolveSkillBodyPathOverride,
  type SkillCacheModule,
} from "../src/token_goat/hooks_skill.js";
import type { ConfigSchema, SkillPreservationConfig } from "../src/token_goat/types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const _SESSION = "test-session-pre-skill";

const _COMPACT_BODY = "# Compact\n\n- CRITICAL: do the thing.\n- MUST: always test.\n";
const _FULL_BODY =
  _COMPACT_BODY + "\n<!-- COMPACT_END -->\n\n## Detail\n\n" + "detail. ".repeat(500);

function _payload(
  skill: string,
  opts: { session_id?: string; tool_name?: string } = {},
): Record<string, unknown> {
  return {
    tool_name: opts.tool_name ?? "Skill",
    tool_input: { skill },
    session_id: opts.session_id ?? _SESSION,
  };
}

function _make_skill_entry(
  skill_name = "ralph",
  opts: { run_count?: number; ts?: number; body_bytes?: number; content_sha?: string } = {},
): session.SkillEntry {
  return new session.SkillEntry({
    skill_name,
    output_id: "out-id",
    content_sha: opts.content_sha ?? "abc123",
    ts: opts.ts ?? Date.now() / 1000 - 60,
    body_bytes: opts.body_bytes ?? 40_000,
    run_count: opts.run_count ?? 1,
  });
}

// ---------------------------------------------------------------------------
// Config factory + spy
// ---------------------------------------------------------------------------

function _make_cfg(overrides: Partial<SkillPreservationConfig> = {}): SkillPreservationConfig {
  const defaults: SkillPreservationConfig = {
    enabled: true,
    max_cache_bytes: 5 * 1024 * 1024,
    orphan_sweep_enabled: false,
    orphan_age_secs: 604800,
    truncation_budget_tokens: 800,
    compress_bodies: false,
    compress_min_bytes: 16 * 1024,
    inline_snippets: true,
    pre_skill_enabled: true,
    first_load_compact: false,
    post_compact_full_loads: false,
  };
  return { ...defaults, ...overrides };
}

function _patch_cfg(overrides: Partial<SkillPreservationConfig> = {}): void {
  const cfg_obj = _make_cfg(overrides);
  const fake_config = {
    skill_preservation: cfg_obj,
    // hints.pre_skill_advisory defaults false here so the non-blocking advisory
    // path (2a) never fires in the dedup / pass-through tests.
    hints: { pre_skill_advisory: false },
  } as unknown as ConfigSchema;
  vi.spyOn(config, "load").mockReturnValue(fake_config);
}

// ---------------------------------------------------------------------------
// Fake skill_cache module (skill_cache.ts is Layer 6, not yet ported).
// ---------------------------------------------------------------------------

const _COMPACT_END_MARKER = "<!-- COMPACT_END -->";

/** Faithful replica of skill_cache.extract_compact_from_marker. */
function _extract_compact_from_marker(body: string): string | null {
  if (!body || !body.includes(_COMPACT_END_MARKER)) {
    return null;
  }
  let in_code_block = false;
  const lines = body.split(/\r\n|\r|\n/);
  for (let i = 0; i < lines.length; i++) {
    const stripped = (lines[i] ?? "").trim();
    if (stripped.startsWith("```") || stripped.startsWith("~~~")) {
      in_code_block = !in_code_block;
      continue;
    }
    if (in_code_block) {
      continue;
    }
    if (stripped === _COMPACT_END_MARKER) {
      const pre_marker = lines.slice(0, i).join("\n").trim();
      return pre_marker ? pre_marker : null;
    }
  }
  return null;
}

/** Build a fake SkillCacheModule with overridable get_compact. */
function makeFakeSkillCache(getCompact: (s: string, n: string) => string | null): SkillCacheModule {
  return {
    content_hash: (text: string) => `sha-${text.length}`,
    generate_compact_summary: () => null,
    store_compact: () => undefined,
    get_compact: getCompact,
    get_compact_any_session: () => null,
    extract_compact_source_sha: () => null,
    extract_compact_from_marker: _extract_compact_from_marker,
    store_output: () => null,
    write_sidecar: () => undefined,
  };
}

// ---------------------------------------------------------------------------
// 1. Pass-through cases
// ---------------------------------------------------------------------------

describe("TestPreSkillPassThrough", () => {
  beforeEach(() => {
    _patch_cfg();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("test_non_skill_tool_name_passes_through", () => {
    const resp = pre_skill(_payload("ralph", { tool_name: "Bash" }));
    expect(resp.continue).toBe(true);
    expect("hookSpecificOutput" in resp).toBe(false);
  });

  it("test_no_session_id_passes_through", () => {
    const payload = { tool_name: "Skill", tool_input: { skill: "ralph" } };
    const resp = pre_skill(payload);
    expect(resp.continue).toBe(true);
    expect("hookSpecificOutput" in resp).toBe(false);
  });

  it("test_disabled_pre_skill_passes_through", () => {
    _patch_cfg({ pre_skill_enabled: false });
    const resp = pre_skill(_payload("ralph"));
    expect(resp.continue).toBe(true);
    expect("hookSpecificOutput" in resp).toBe(false);
  });

  it("test_disabled_overall_passes_through", () => {
    _patch_cfg({ enabled: false });
    const resp = pre_skill(_payload("ralph"));
    expect(resp.continue).toBe(true);
    expect("hookSpecificOutput" in resp).toBe(false);
  });

  it("test_missing_skill_name_passes_through", () => {
    const payload = { tool_name: "Skill", tool_input: {}, session_id: _SESSION };
    const resp = pre_skill(payload);
    expect(resp.continue).toBe(true);
  });

  it("test_empty_skill_name_after_normalization_passes_through", () => {
    const resp = pre_skill(_payload("/", { session_id: _SESSION }));
    expect(resp.continue).toBe(true);
  });

  it("test_first_load_no_prior_entry_first_load_compact_false", () => {
    _patch_cfg({ first_load_compact: false });
    vi.spyOn(session, "lookup_skill_entry").mockReturnValue(null);
    const resp = pre_skill(_payload("ralph"));
    expect(resp.continue).toBe(true);
    expect("hookSpecificOutput" in resp).toBe(false);
  });

  it("test_non_dict_payload_passes_through", () => {
    const resp = pre_skill("not a dict" as unknown as Record<string, unknown>);
    expect(resp.continue).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 2. Repeat-load dedup
// ---------------------------------------------------------------------------

describe("TestPreSkillRepeatLoadDedup", () => {
  beforeEach(() => {
    _patch_cfg();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("test_repeat_load_with_compact_denies", () => {
    const entry = _make_skill_entry("ralph", { run_count: 2 });
    vi.spyOn(session, "lookup_skill_entry").mockReturnValue(entry);
    _setSkillCacheModule(makeFakeSkillCache(() => _COMPACT_BODY));
    _setCompactionOccurredAfterOverride(() => false);

    const resp = pre_skill(_payload("ralph"));

    expect(resp.continue).toBe(true);
    const hso = (resp.hookSpecificOutput ?? {}) as Record<string, unknown>;
    expect(hso["permissionDecision"]).toBe("deny");
    const ctx = String(hso["additionalContext"] ?? "");
    expect(ctx).toContain("ralph");
    expect(ctx).toContain("already in context");
    expect(ctx).toContain(_COMPACT_BODY.trim().slice(0, 30));
  });

  it("test_repeat_load_without_compact_denies_with_recall_pointer", () => {
    const entry = _make_skill_entry("brainstorming", { run_count: 1 });
    vi.spyOn(session, "lookup_skill_entry").mockReturnValue(entry);
    _setSkillCacheModule(makeFakeSkillCache(() => null));
    _setCompactionOccurredAfterOverride(() => false);

    const resp = pre_skill(_payload("brainstorming"));

    expect(resp.continue).toBe(true);
    const hso = (resp.hookSpecificOutput ?? {}) as Record<string, unknown>;
    expect(hso["permissionDecision"]).toBe("deny");
    const ctx = String(hso["additionalContext"] ?? "");
    expect(ctx).toContain("brainstorming");
    expect(ctx).toContain("skill-body");
  });

  it("test_repeat_load_after_compaction_serves_compact_by_default", () => {
    // Default (post_compact_full_loads=False) + compact available: deny with compact.
    const entry = _make_skill_entry("ralph", { run_count: 1, ts: Date.now() / 1000 - 120 });
    vi.spyOn(session, "lookup_skill_entry").mockReturnValue(entry);
    _setSkillCacheModule(makeFakeSkillCache(() => _COMPACT_BODY));
    _setCompactionOccurredAfterOverride(() => true);

    const resp = pre_skill(_payload("ralph"));

    expect(resp.continue).toBe(true);
    const hso = (resp.hookSpecificOutput ?? {}) as Record<string, unknown>;
    expect(hso["permissionDecision"]).toBe("deny");
    expect(String(hso["additionalContext"] ?? "")).toContain(_COMPACT_BODY.trim().slice(0, 30));
  });

  it("test_repeat_load_after_compaction_no_compact_allows_reload", () => {
    // Default (post_compact_full_loads=False) + NO compact: allow full reload.
    const entry = _make_skill_entry("ralph", { run_count: 1, ts: Date.now() / 1000 - 120 });
    vi.spyOn(session, "lookup_skill_entry").mockReturnValue(entry);
    _setSkillCacheModule(makeFakeSkillCache(() => null));
    _setCompactionOccurredAfterOverride(() => true);

    const resp = pre_skill(_payload("ralph"));

    expect(resp.continue).toBe(true);
    expect("hookSpecificOutput" in resp).toBe(false);
  });

  it("test_repeat_load_after_compaction_allows_reload_opt_in", () => {
    // post_compact_full_loads=True: full body reload allowed after compaction.
    _patch_cfg({ post_compact_full_loads: true });
    const entry = _make_skill_entry("ralph", { run_count: 1, ts: Date.now() / 1000 - 120 });
    vi.spyOn(session, "lookup_skill_entry").mockReturnValue(entry);
    _setCompactionOccurredAfterOverride(() => true);

    const resp = pre_skill(_payload("ralph"));

    expect(resp.continue).toBe(true);
    expect("hookSpecificOutput" in resp).toBe(false);
  });

  it("test_deny_reason_includes_run_count", () => {
    const entry = _make_skill_entry("superman", { run_count: 3 });
    vi.spyOn(session, "lookup_skill_entry").mockReturnValue(entry);
    _setSkillCacheModule(makeFakeSkillCache(() => null));
    _setCompactionOccurredAfterOverride(() => false);

    const resp = pre_skill(_payload("superman"));

    const hso = resp.hookSpecificOutput as Record<string, unknown>;
    const reason = String(hso["permissionDecisionReason"] ?? "");
    expect(reason.includes("3") || reason.includes("3×")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 3. First-load compact (opt-in)
// ---------------------------------------------------------------------------

describe("TestPreSkillFirstLoadCompact", () => {
  let tmpRoot: string;

  beforeEach(() => {
    _patch_cfg();
    tmpRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "tg-skill-")));
  });
  afterEach(() => {
    vi.restoreAllMocks();
    try {
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    } catch {
      // best-effort
    }
  });

  function _write_skill_file(skill_name: string, body: string): string {
    const skill_dir = path.join(tmpRoot, ".claude", "skills", skill_name);
    fs.mkdirSync(skill_dir, { recursive: true });
    const skill_file = path.join(skill_dir, "SKILL.md");
    fs.writeFileSync(skill_file, body, "utf-8");
    return skill_file;
  }

  it("test_first_load_compact_enabled_with_marker_denies", () => {
    _patch_cfg({ first_load_compact: true });
    const skill_file = _write_skill_file("ralph", _FULL_BODY);

    vi.spyOn(session, "lookup_skill_entry").mockReturnValue(null);
    _setResolveSkillBodyPathOverride(() => skill_file);
    // _read_first_load_compact needs skill_cache.extract_compact_from_marker.
    _setSkillCacheModule(makeFakeSkillCache(() => null));

    const resp = pre_skill(_payload("ralph"));

    expect(resp.continue).toBe(true);
    const hso = (resp.hookSpecificOutput ?? {}) as Record<string, unknown>;
    expect(hso["permissionDecision"]).toBe("deny");
    const ctx = String(hso["additionalContext"] ?? "");
    expect(ctx).toContain("Compact operative summary");
    expect(ctx).toContain("CRITICAL: do the thing");
    // Detail section must not appear (it's after the marker).
    expect(ctx).not.toContain("detail.");
  });

  it("test_first_load_compact_enabled_no_marker_passes_through", () => {
    _patch_cfg({ first_load_compact: true });
    const body_no_marker = "# Skill\n\n" + "content. ".repeat(200);
    const skill_file = _write_skill_file("no-marker-skill", body_no_marker);

    vi.spyOn(session, "lookup_skill_entry").mockReturnValue(null);
    _setResolveSkillBodyPathOverride(() => skill_file);
    _setSkillCacheModule(makeFakeSkillCache(() => null));

    const resp = pre_skill(_payload("no-marker-skill"));

    expect(resp.continue).toBe(true);
    expect("hookSpecificOutput" in resp).toBe(false);
  });

  it("test_first_load_compact_enabled_file_not_found_passes_through", () => {
    _patch_cfg({ first_load_compact: true });
    vi.spyOn(session, "lookup_skill_entry").mockReturnValue(null);
    _setResolveSkillBodyPathOverride(() => "");
    _setSkillCacheModule(makeFakeSkillCache(() => null));

    const resp = pre_skill(_payload("unknown-skill"));

    expect(resp.continue).toBe(true);
    expect("hookSpecificOutput" in resp).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 4. _normalize_skill_name
// ---------------------------------------------------------------------------

describe("TestNormalizeSkillName", () => {
  const cases: Array<[string, string]> = [
    ["ralph", "ralph"],
    ["  ralph  ", "ralph"],
    ["RALPH", "ralph"],
    ["ralph.md", "ralph"],
    ["RALPH.MD", "ralph"],
    ["/home/user/.claude/skills/ralph/SKILL.md", "skill"],
    ["~/.claude/skills/ralph", "ralph"],
    ["ralph/SKILL.md", "skill"],
    ["/", ""],
    ["/.md", ""],
    ["brainstorming", "brainstorming"],
  ];

  it.each(cases)("test_normalization(%j)->%j", (raw, expected) => {
    expect(_normalize_skill_name(raw)).toBe(expected);
  });
});

// ---------------------------------------------------------------------------
// 5. _compaction_occurred_after
// ---------------------------------------------------------------------------

describe("TestCompactionOccurredAfter", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("test_no_sentinel_returns_false", () => {
    expect(_compaction_occurred_after("no-such-session", Date.now() / 1000 - 60)).toBe(false);
  });

  it("test_sentinel_older_than_skill_returns_false", () => {
    const sidecar = paths.manifestShaSidecarPath("sess-compaction");
    fs.mkdirSync(path.dirname(sidecar), { recursive: true });
    fs.writeFileSync(sidecar, "sha|fp|0", "utf-8");
    // Set sentinel mtime to 2 minutes ago.
    const old_time = Date.now() / 1000 - 120;
    fs.utimesSync(sidecar, old_time, old_time);
    // Skill loaded 1 minute ago (more recent than sentinel).
    const skill_ts = Date.now() / 1000 - 60;
    expect(_compaction_occurred_after("sess-compaction", skill_ts)).toBe(false);
  });

  it("test_sentinel_newer_than_skill_returns_true", () => {
    const sidecar = paths.manifestShaSidecarPath("sess-compaction-new");
    fs.mkdirSync(path.dirname(sidecar), { recursive: true });
    fs.writeFileSync(sidecar, "sha|fp|0", "utf-8");
    // Skill loaded 5 minutes ago, sentinel just written (now).
    const skill_ts = Date.now() / 1000 - 300;
    expect(_compaction_occurred_after("sess-compaction-new", skill_ts)).toBe(true);
  });
});
