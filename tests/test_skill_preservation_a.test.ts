/**
 * Tests for the skill-preservation feature — part A.
 *
 * Faithful TS port of tests/test_skill_preservation.py (split into _a / _b by
 * class because the Python file is 2306 LOC). Part A covers:
 *   - skill_cache.store_output / load_output / sidecar / lookup_by_name
 *   - session.SkillEntry serialize / parse round-trip + mark_skill_loaded
 *   - hooks_skill._resolve_skill_body_path
 *   - hooks_skill.post_skill end-to-end capture
 *   - compact.build_manifest "Active Skills" section
 *   - skill_cache.extract_checklist_section
 *   - hooks_session._build_recovery_hint "Skills" block
 *   - config.SkillPreservationConfig load/save + env override
 *   - CLI skill-history (deferred — CLI not ported)
 *   - skill_cache orphan sweep
 *
 * Porting notes:
 *  - conftest.fire_skill_hook -> local fire_skill_hook helper that builds the
 *    PostToolUse(Skill) payload and calls hooks_skill.post_skill. hooks_skill's
 *    skill_cache seam already defaults to the real (now-ported) module, so no
 *    injection is needed for the hook path.
 *  - compact.ts reaches skill_cache only via the _setSkillCacheModule seam
 *    (defaults to null), so manifest tests that embed a stored compact inject a
 *    real-module adapter (skill_cache + a faithful _strip_compact_header replica,
 *    since that helper is module-private and not exported).
 *  - monkeypatch(_sc_mod.time, "time", fake) -> vi.spyOn(Date, "now") with a
 *    monotonic counter; store_output stamps meta.ts from Date.now()/1000 and
 *    write_sidecar persists it, so lookup_all_by_name's ts-sort is reproduced.
 *  - monkeypatch(skill_cache, "_sweep_done", False) -> there is no exported
 *    setter; the per-test clearModuleCaches() in setup.ts already resets the
 *    module-level _sweep_done flag (registered via reset.ts), so the sweep runs
 *    fresh in each test. The _reset_sweep helper is therefore a no-op marker.
 *  - monkeypatch(skill_cache, "_skill_outputs_dir", ...) / "_sweep_skill_orphans"
 *    -> vi.spyOn(skill_cache, name). These are NOT exported (module-private), so
 *    the sweep/dir-override tests that need to patch them are deferred with a
 *    missingExports note; tests that only exercise the real cache dir run as-is.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import * as skill_cache from "../src/token_goat/skill_cache.js";
import * as session from "../src/token_goat/session.js";
import * as compact from "../src/token_goat/compact.js";
import * as config from "../src/token_goat/config.js";
import * as hooks_skill from "../src/token_goat/hooks_skill.js";
import * as hooks_session from "../src/token_goat/hooks_session.js";
import * as paths from "../src/token_goat/paths.js";
import * as cache_common from "../src/token_goat/cache_common.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** conftest.fire_skill_hook: fire PostToolUse(Skill) and return the response. */
function fire_skill_hook(
  session_id: string,
  skill_name: string,
  body: string,
): Record<string, unknown> {
  const payload = {
    session_id,
    tool_name: "Skill",
    tool_input: { skill: skill_name },
    tool_response: body,
  };
  return hooks_skill.post_skill(payload) as Record<string, unknown>;
}

/**
 * Faithful replica of skill_cache._strip_compact_header (module-private).
 * Needed only to satisfy compact.ts's _SkillCacheModule interface so the real
 * skill_cache can be injected for manifest-embed tests.
 */
const _COMPACT_HEADER_RE =
  /^--- compact form \(\d+ tokens(?:, sha=[0-9a-f]+)?\) ---\n/;
function _strip_compact_header(stored_text: string): string {
  const m = _COMPACT_HEADER_RE.exec(stored_text);
  if (m) {
    return stored_text.slice(m[0]!.length);
  }
  return stored_text;
}

/** Inject the real skill_cache into compact's seam for the duration of a test. */
function injectSkillCacheIntoCompact(): void {
  compact._setSkillCacheModule({
    get_compact: skill_cache.get_compact,
    get_compact_any_session: skill_cache.get_compact_any_session,
    extract_compact_source_sha: skill_cache.extract_compact_source_sha,
    _strip_compact_header,
  });
}

afterEach(() => {
  vi.restoreAllMocks();
  compact._setSkillCacheModule(undefined);
});

// ===========================================================================
// skill_cache.store_output / load_output / sidecar / lookup
// ===========================================================================

describe("TestSkillCacheStoreAndLoad", () => {
  it("test_small_body_round_trip", () => {
    const body = "# Skill body\n\n" + "rule. ".repeat(200);
    const meta = skill_cache.store_output("sess1", "ralph", body);
    expect(meta).not.toBeNull();
    expect(meta!.skill_name).toBe("ralph");
    expect(meta!.body_bytes).toBe(Buffer.from(body, "utf8").length);
    expect(meta!.truncated).toBe(false);
    const loaded = skill_cache.load_output(meta!.output_id);
    expect(loaded).not.toBeNull();
    expect(loaded!.startsWith("# Skill body")).toBe(true);
  });

  it("test_large_body_is_tail_preserved", () => {
    // 512 KB > 256 KB cap -> tail-preserve fires
    const big = "X".repeat(512) + "\n" + "Y".repeat(524_288);
    const meta = skill_cache.store_output("sess2", "huge", big);
    expect(meta).not.toBeNull();
    expect(meta!.truncated).toBe(true);
    const loaded = skill_cache.load_output(meta!.output_id);
    expect(loaded).not.toBeNull();
    expect(loaded!.includes("token-goat: skill body truncated")).toBe(true);
    expect(loaded!.endsWith("Y")).toBe(true); // tail preserved
  });

  it("test_invalid_skill_name_rejected", () => {
    for (const bad of ["../etc/passwd", "with/slash", "with..dot", "with\x00null", ""]) {
      const meta = skill_cache.store_output("sess3", bad, "body content here ".repeat(50));
      expect(meta).toBeNull();
    }
  });

  it("test_namespaced_skill_name_accepted", () => {
    const meta = skill_cache.store_output("sess4", "plugin:improve", "improve skill body ".repeat(50));
    expect(meta).not.toBeNull();
    expect(meta!.skill_name).toBe("plugin:improve");
    // The on-disk filename must not contain the ':' (Windows would reject it).
    expect(meta!.output_id.includes(":")).toBe(false);
  });

  it("test_idempotent_same_body", () => {
    const body = "deterministic body ".repeat(100);
    const meta_a = skill_cache.store_output("sess5", "ralph", body);
    const meta_b = skill_cache.store_output("sess5", "ralph", body);
    expect(meta_a).not.toBeNull();
    expect(meta_b).not.toBeNull();
    expect(meta_a!.output_id).toBe(meta_b!.output_id);
    expect(meta_a!.content_sha).toBe(meta_b!.content_sha);
  });

  it("test_changed_body_produces_new_id", () => {
    const meta_a = skill_cache.store_output("sess6", "ralph", "v1 body ".repeat(100));
    const meta_b = skill_cache.store_output("sess6", "ralph", "v2 body ".repeat(100));
    expect(meta_a).not.toBeNull();
    expect(meta_b).not.toBeNull();
    expect(meta_a!.output_id).not.toBe(meta_b!.output_id);
  });

  it("test_sidecar_round_trip", () => {
    const meta = skill_cache.store_output("sess7", "ralph", "ralph body ".repeat(100), {
      source_path: "/some/path.md",
    });
    expect(meta).not.toBeNull();
    skill_cache.write_sidecar(meta!);
    const loaded = skill_cache.read_sidecar(meta!.output_id);
    expect(loaded).not.toBeNull();
    expect(loaded!.skill_name).toBe("ralph");
    expect(loaded!.content_sha).toBe(meta!.content_sha);
    expect(loaded!.source_path).toBe("/some/path.md");
  });

  it("test_lookup_by_name_returns_latest", () => {
    // Use a monotonically increasing fake clock so meta.ts is distinct per call.
    let nowMs = 1_000_000;
    vi.spyOn(Date, "now").mockImplementation(() => {
      nowMs += 1000;
      return nowMs;
    });
    const meta_old = skill_cache.store_output("sess8", "ralph", "old body ".repeat(100));
    expect(meta_old).not.toBeNull();
    skill_cache.write_sidecar(meta_old!);
    const meta_new = skill_cache.store_output("sess8", "ralph", "new body ".repeat(100));
    expect(meta_new).not.toBeNull();
    skill_cache.write_sidecar(meta_new!);
    const found = skill_cache.lookup_by_name("ralph");
    expect(found).not.toBeNull();
    expect(found!.output_id).toBe(meta_new!.output_id);
  });

  it("test_lookup_all_by_name_returns_newest_first", () => {
    let nowMs = 1_000_000;
    vi.spyOn(Date, "now").mockImplementation(() => {
      const cur = nowMs;
      nowMs += 1000;
      return cur;
    });
    const meta_a = skill_cache.store_output("sess-all", "ralph", "v1 body ".repeat(100));
    expect(meta_a).not.toBeNull();
    skill_cache.write_sidecar(meta_a!);
    const meta_b = skill_cache.store_output("sess-all", "ralph", "v2 body ".repeat(100));
    expect(meta_b).not.toBeNull();
    skill_cache.write_sidecar(meta_b!);
    const meta_c = skill_cache.store_output("sess-all2", "ralph", "v3 body ".repeat(100));
    expect(meta_c).not.toBeNull();
    skill_cache.write_sidecar(meta_c!);
    const result = skill_cache.lookup_all_by_name("ralph");
    expect(result.length).toBe(3);
    expect(result[0]!.output_id).toBe(meta_c!.output_id); // newest first
    expect(result[2]!.output_id).toBe(meta_a!.output_id);
  });

  it("test_lookup_all_by_name_filters_other_skills", () => {
    const meta_ralph = skill_cache.store_output("s1", "ralph", "ralph body ".repeat(100));
    const meta_improve = skill_cache.store_output("s1", "improve", "improve body ".repeat(100));
    expect(meta_ralph).not.toBeNull();
    expect(meta_improve).not.toBeNull();
    skill_cache.write_sidecar(meta_ralph!);
    skill_cache.write_sidecar(meta_improve!);
    const result = skill_cache.lookup_all_by_name("ralph");
    expect(result.length).toBe(1);
    expect(result[0]!.skill_name).toBe("ralph");
  });

  it("test_lookup_all_by_name_invalid_returns_empty", () => {
    expect(skill_cache.lookup_all_by_name("")).toEqual([]);
    expect(skill_cache.lookup_all_by_name("../etc/passwd")).toEqual([]);
  });
});

// ===========================================================================
// session.SkillEntry
// ===========================================================================

describe("TestSessionSkillEntry", () => {
  it("test_mark_skill_loaded_persists_to_cache", () => {
    const sid = "session-test-mark-skill";
    const cache = session.mark_skill_loaded(sid, "ralph", "out-id-1", "shahex", 1234, false, {
      source_path: "/path/to/SKILL.md",
    });
    expect("ralph" in cache.skill_history).toBe(true);
    const entry = cache.skill_history["ralph"]!;
    expect(entry.output_id).toBe("out-id-1");
    expect(entry.content_sha).toBe("shahex");
    expect(entry.body_bytes).toBe(1234);
    expect(entry.run_count).toBe(1);
  });

  it("test_repeat_load_increments_run_count", () => {
    const sid = "session-test-repeat-skill";
    session.mark_skill_loaded(sid, "ralph", "out-1", "sha1", 100, false);
    session.mark_skill_loaded(sid, "ralph", "out-2", "sha2", 200, false);
    const cache = session.load(sid);
    expect(cache.skill_history["ralph"]!.run_count).toBe(2);
    // Latest body wins (output_id updated to most recent).
    expect(cache.skill_history["ralph"]!.output_id).toBe("out-2");
  });

  it("test_serialize_round_trip", () => {
    const entry = new session.SkillEntry({
      skill_name: "ralph",
      output_id: "abc-def",
      content_sha: "deadbeef",
      ts: 1700000000.0,
      body_bytes: 5000,
      truncated: true,
      run_count: 3,
      source_path: "/p.md",
    });
    const wire = session._serialize_skill_entry(entry);
    const parsed = session._parse_skill_entry({ ...wire });
    expect(parsed).not.toBeNull();
    expect(parsed!.skill_name).toBe("ralph");
    expect(parsed!.content_sha).toBe("deadbeef");
    expect(parsed!.run_count).toBe(3);
    expect(parsed!.source_path).toBe("/p.md");
  });

  it("test_lookup_skill_entry", () => {
    const sid = "session-lookup-skill";
    session.mark_skill_loaded(sid, "ralph", "oid", "sha", 100, false);
    const entry = session.lookup_skill_entry(sid, "ralph");
    expect(entry).not.toBeNull();
    expect(entry!.skill_name).toBe("ralph");
    expect(session.lookup_skill_entry(sid, "nonexistent")).toBeNull();
  });

  it("test_migrate_adds_skill_history", () => {
    const legacy = {
      session_id: "legacy",
      started_ts: 1.0,
      last_activity_ts: 1.0,
      files: {},
      greps: [],
    };
    const migrated = session._migrate_session({ ...legacy });
    expect(migrated["skill_history"]).toEqual({});
  });
});

// ===========================================================================
// hooks_skill._resolve_skill_body_path
// ===========================================================================

describe("TestResolveSkillBodyPath", () => {
  let tmpPath: string;
  let savedHome: string | undefined;
  let savedUserProfile: string | undefined;

  beforeEach(() => {
    tmpPath = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "tg-resolve-")));
    savedHome = process.env.HOME;
    savedUserProfile = process.env.USERPROFILE;
    process.env.HOME = tmpPath;
    process.env.USERPROFILE = tmpPath;
  });

  afterEach(() => {
    if (savedHome === undefined) delete process.env.HOME;
    else process.env.HOME = savedHome;
    if (savedUserProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = savedUserProfile;
    try {
      fs.rmSync(tmpPath, { recursive: true, force: true });
    } catch {
      // best-effort
    }
  });

  it("test_user_skill_resolves", () => {
    const skill_dir = path.join(tmpPath, ".claude", "skills", "ralph");
    fs.mkdirSync(skill_dir, { recursive: true });
    const skill_md = path.join(skill_dir, "SKILL.md");
    fs.writeFileSync(skill_md, "# ralph", "utf-8");
    const resolved = hooks_skill._resolve_skill_body_path("ralph");
    expect(resolved).toBe(skill_md);
  });

  it("test_plugin_marketplace_layout_resolves", () => {
    const skill_md = path.join(
      tmpPath, ".claude", "plugins", "cache", "claude-plugins-official",
      "commit-commands", "1.0.0", "skills", "commit", "SKILL.md",
    );
    fs.mkdirSync(path.dirname(skill_md), { recursive: true });
    fs.writeFileSync(skill_md, "# commit", "utf-8");
    const resolved = hooks_skill._resolve_skill_body_path("commit-commands:commit");
    expect(resolved).toBe(skill_md);
  });

  it("test_plugin_legacy_flat_layout_resolves", () => {
    const skill_md = path.join(
      tmpPath, ".claude", "plugins", "myplug", "skills", "doit", "SKILL.md",
    );
    fs.mkdirSync(path.dirname(skill_md), { recursive: true });
    fs.writeFileSync(skill_md, "# doit", "utf-8");
    const resolved = hooks_skill._resolve_skill_body_path("myplug:doit");
    expect(resolved).toBe(skill_md);
  });

  it("test_plugin_skill_falls_back_to_user_skills_dir", () => {
    const skill_md = path.join(tmpPath, ".claude", "skills", "improve", "SKILL.md");
    fs.mkdirSync(path.dirname(skill_md), { recursive: true });
    fs.writeFileSync(skill_md, "# improve", "utf-8");
    const resolved = hooks_skill._resolve_skill_body_path("plugin:improve");
    expect(resolved).toBe(skill_md);
  });

  it("test_unknown_skill_returns_empty", () => {
    expect(hooks_skill._resolve_skill_body_path("does-not-exist")).toBe("");
    expect(hooks_skill._resolve_skill_body_path("plugin:also-gone")).toBe("");
  });

  it("test_empty_name_returns_empty", () => {
    expect(hooks_skill._resolve_skill_body_path("")).toBe("");
  });

  it("test_marketplace_picks_newest_version", () => {
    const base = path.join(tmpPath, ".claude", "plugins", "cache", "mkt", "plug");
    const old = path.join(base, "1.0.0", "skills", "x", "SKILL.md");
    const newer = path.join(base, "2.0.0", "skills", "x", "SKILL.md");
    fs.mkdirSync(path.dirname(old), { recursive: true });
    fs.mkdirSync(path.dirname(newer), { recursive: true });
    fs.writeFileSync(old, "# v1", "utf-8");
    fs.writeFileSync(newer, "# v2", "utf-8");
    const resolved = hooks_skill._resolve_skill_body_path("plug:x");
    // Reverse-sorted version order = newest first.
    expect(resolved).toBe(newer);
  });
});

// ===========================================================================
// hooks_skill.post_skill
// ===========================================================================

describe("TestPostSkillHook", () => {
  it("test_captures_body_to_cache_and_session", () => {
    const sid = "session-hook-capture";
    const body = "# Ralph SKILL\n\n" + "DoD rule. ".repeat(200);
    const resp = fire_skill_hook(sid, "ralph", body);
    expect(resp["continue"]).toBe(true);
    const cache = session.load(sid);
    expect("ralph" in cache.skill_history).toBe(true);
    const entry = cache.skill_history["ralph"]!;
    const loaded = skill_cache.load_output(entry.output_id);
    expect(loaded).not.toBeNull();
    expect(loaded!.includes("DoD rule.")).toBe(true);
  });

  it("test_tiny_body_skipped", () => {
    const sid = "session-hook-tiny";
    const resp = fire_skill_hook(sid, "tiny", "Skill loaded."); // under 256 byte min
    expect(resp["continue"]).toBe(true);
    const cache = session.load(sid);
    expect("tiny" in cache.skill_history).toBe(false);
  });

  it("test_wrong_tool_name_ignored", () => {
    const payload = {
      session_id: "sess-wrong",
      tool_name: "Bash", // not Skill
      tool_input: { command: "ls" },
      tool_response: "out",
    };
    const resp = hooks_skill.post_skill(payload) as Record<string, unknown>;
    expect(resp["continue"]).toBe(true);
  });

  it("test_disabled_by_config", () => {
    const sid = "session-hook-disabled";
    const saved = process.env.TOKEN_GOAT_SKILL_PRESERVATION;
    process.env.TOKEN_GOAT_SKILL_PRESERVATION = "0";
    try {
      const body = "# Ralph SKILL\n\n" + "rule. ".repeat(200);
      const resp = fire_skill_hook(sid, "ralph", body);
      expect(resp["continue"]).toBe(true);
      const cache = session.load(sid);
      expect("ralph" in cache.skill_history).toBe(false);
    } finally {
      if (saved === undefined) delete process.env.TOKEN_GOAT_SKILL_PRESERVATION;
      else process.env.TOKEN_GOAT_SKILL_PRESERVATION = saved;
    }
  });

  it("test_dict_response_extraction", () => {
    const sid = "session-hook-dict";
    const body_text = "# Ralph\n\n" + "rule. ".repeat(200);
    const payload = {
      session_id: sid,
      tool_name: "Skill",
      tool_input: { skill: "ralph" },
      tool_response: { output: body_text },
    };
    const resp = hooks_skill.post_skill(payload) as Record<string, unknown>;
    expect(resp["continue"]).toBe(true);
    const cache = session.load(sid);
    expect("ralph" in cache.skill_history).toBe(true);
  });

  it("test_mcp_content_array_extraction", () => {
    const sid = "session-hook-mcp";
    const payload = {
      session_id: sid,
      tool_name: "Skill",
      tool_input: { skill: "ralph" },
      tool_response: {
        content: [
          { type: "text", text: "# Ralph header\n\n" },
          { type: "text", text: "rule. ".repeat(200) },
        ],
      },
    };
    const resp = hooks_skill.post_skill(payload) as Record<string, unknown>;
    expect(resp["continue"]).toBe(true);
    const cache = session.load(sid);
    expect("ralph" in cache.skill_history).toBe(true);
  });

  it("test_auto_compact_large_bodies", () => {
    const sid = "session-hook-auto-compact";
    const body =
      "# Ralph\n\n" +
      "## DoD\n\n" +
      "- CRITICAL: Always preserve the rules\n" +
      "- MUST: Check the definitions\n\n" +
      "## Process\n\n" +
      "**Key directive:** Follow the steps\n\n" +
      "Extra paragraph text. ".repeat(300);
    expect(body.length).toBeGreaterThan(4000);
    const resp = fire_skill_hook(sid, "ralph", body);
    expect(resp["continue"]).toBe(true);
    const cache = session.load(sid);
    expect("ralph" in cache.skill_history).toBe(true);
    const compact_text = skill_cache.get_compact(sid, "ralph");
    expect(compact_text).not.toBeNull();
    expect(compact_text!.length).toBeGreaterThan(0);
    expect(compact_text!.length).toBeLessThanOrEqual(1700);
    expect(compact_text!.includes("CRITICAL") || compact_text!.includes("MUST")).toBe(true);
  });

  it("test_auto_compact_small_bodies_skipped", () => {
    const sid = "session-hook-no-auto-compact";
    const body = "# Ralph\n\n" + "rule. ".repeat(100); // ~700 chars
    expect(body.length).toBeLessThan(4000);
    const resp = fire_skill_hook(sid, "ralph", body);
    expect(resp["continue"]).toBe(true);
    const cache = session.load(sid);
    expect("ralph" in cache.skill_history).toBe(true);
    const compact_text = skill_cache.get_compact(sid, "ralph");
    expect(compact_text).toBeNull();
  });

  it("test_duplicate_load_advances_skill_ts", () => {
    const sid = "session-ts-advance";
    const body = "# Ralph\n\n" + "rule. ".repeat(200);

    // Use a monotonic clock so the duplicate load is guaranteed to stamp a
    // later ts than the first (the Python test sleeps 0.05s instead).
    let nowMs = 2_000_000_000_000;
    vi.spyOn(Date, "now").mockImplementation(() => {
      const cur = nowMs;
      nowMs += 100; // +0.1s per call
      return cur;
    });

    fire_skill_hook(sid, "ralph", body);
    const ts_after_first = session.load(sid).skill_history["ralph"]!.ts;

    fire_skill_hook(sid, "ralph", body);
    const ts_after_second = session.load(sid).skill_history["ralph"]!.ts;

    expect(ts_after_second).toBeGreaterThan(ts_after_first);
  });
});

// ===========================================================================
// compact manifest "Active Skills" section
// ===========================================================================

describe("TestManifestActiveSkillsSection", () => {
  it("test_section_appears_when_skill_loaded", () => {
    injectSkillCacheIntoCompact();
    const sid = "session-manifest-skill";
    const body = "ralph body ".repeat(200);
    const meta = skill_cache.store_output(sid, "ralph", body);
    expect(meta).not.toBeNull();
    skill_cache.write_sidecar(meta!);
    session.mark_skill_loaded(
      sid, meta!.skill_name, meta!.output_id, meta!.content_sha,
      meta!.body_bytes, meta!.truncated,
    );
    const m = compact.build_manifest(sid, { max_tokens: 600 });
    expect(m.includes("**Skills:**")).toBe(true);
    expect(m.includes("ralph")).toBe(true);
    expect(
      m.includes("token-goat skill-body <name>") || m.includes("token-goat skill-body ralph"),
    ).toBe(true);
  });

  it("test_run_count_marker_appears", () => {
    injectSkillCacheIntoCompact();
    const sid = "session-manifest-runs";
    for (let i = 0; i < 3; i++) {
      const meta = skill_cache.store_output(sid, "ralph", "body ".repeat(100));
      expect(meta).not.toBeNull();
      session.mark_skill_loaded(
        sid, meta!.skill_name, meta!.output_id, meta!.content_sha,
        meta!.body_bytes, meta!.truncated,
      );
    }
    const m = compact.build_manifest(sid, { max_tokens: 600 });
    expect(m.includes("×3") || m.includes("x3") || m.includes("×2")).toBe(true);
  });

  it("test_event_count_includes_skills", () => {
    const sid = "session-event-skills";
    session.mark_skill_loaded(sid, "ralph", "oid", "sha", 1000, false);
    expect(compact.event_count(sid)).toBeGreaterThanOrEqual(1);
  });

  it("test_manifest_includes_compact_when_present", () => {
    injectSkillCacheIntoCompact();
    const sid = "session-manifest-compact";
    const body =
      "# Ralph\n\n" +
      "## DoD\n\n" +
      "- CRITICAL: Always follow the DoD\n" +
      "- MUST: Check all items\n\n" +
      "## Process\n\n" +
      "**Key:** Do this in order\n\n" +
      "Extra text. ".repeat(400);
    expect(body.length).toBeGreaterThan(4000);
    const meta = skill_cache.store_output(sid, "ralph", body);
    expect(meta).not.toBeNull();
    skill_cache.write_sidecar(meta!);
    const compact_text = skill_cache.generate_compact_summary(body);
    expect(compact_text).not.toBeNull();
    skill_cache.store_compact(sid, "ralph", compact_text);
    session.mark_skill_loaded(
      sid, meta!.skill_name, meta!.output_id, meta!.content_sha,
      meta!.body_bytes, meta!.truncated,
    );
    const m = compact.build_manifest(sid, { max_tokens: 600 });
    expect(m.includes("**Skills:**")).toBe(true);
    expect(m.includes("ralph")).toBe(true);
    expect(m.includes("**ralph key-rules:**") || m.includes("ralph")).toBe(true);
    expect(m.includes("CRITICAL") || m.includes("MUST")).toBe(true);
  });
});

// ===========================================================================
// skill_cache.extract_checklist_section
// ===========================================================================

describe("TestExtractChecklistSection", () => {
  it("test_dod_heading_extracted", () => {
    const body = "# ralph\n\nIntro text.\n\n## DoD\n\n- All tests pass\n- Lint clean\n\n## Other\n\nNot this.\n";
    const result = skill_cache.extract_checklist_section(body);
    expect(result).not.toBeNull();
    expect(result!.includes("All tests pass")).toBe(true);
    expect(result!.includes("Not this")).toBe(false);
  });

  it("test_checklist_heading_extracted", () => {
    const body = "# Skill\n\n## Checklist\n\n1. Step one\n2. Step two\n";
    const result = skill_cache.extract_checklist_section(body);
    expect(result).not.toBeNull();
    expect(result!.includes("Step one")).toBe(true);
  });

  it("test_steps_heading_extracted", () => {
    const body = "## Steps\n\n- do this\n- do that\n";
    const result = skill_cache.extract_checklist_section(body);
    expect(result).not.toBeNull();
    expect(result!.includes("do this")).toBe(true);
  });

  it("test_dod_beats_steps_when_both_present", () => {
    const body = "## Steps\n\nstep content\n\n## DoD\n\ndod content\n";
    const result = skill_cache.extract_checklist_section(body);
    expect(result).not.toBeNull();
    expect(result!.includes("dod content")).toBe(true);
    expect(result!.includes("step content")).toBe(false);
  });

  it("test_no_matching_heading_returns_none", () => {
    const body = "# Skill\n\n## Overview\n\nJust an overview.\n\n## Usage\n\nUsage text.\n";
    expect(skill_cache.extract_checklist_section(body)).toBeNull();
  });

  it("test_empty_body_returns_none", () => {
    expect(skill_cache.extract_checklist_section("")).toBeNull();
  });

  it("test_matched_but_empty_section_returns_none", () => {
    const body = "## DoD\n\n## Next Section\n";
    expect(skill_cache.extract_checklist_section(body)).toBeNull();
  });

  it("test_long_section_capped_at_400_chars", () => {
    const long_content = "- item\n".repeat(200); // well over 400 chars
    const body = `## DoD\n\n${long_content}\n## End\n`;
    const result = skill_cache.extract_checklist_section(body);
    expect(result).not.toBeNull();
    expect(result!.length).toBeLessThanOrEqual(410); // 400 + possible "…" suffix
    expect(result!.endsWith("…")).toBe(true);
  });

  it("test_case_insensitive_heading_match", () => {
    const body = "## dod\n\n- lowercase dod\n";
    const result = skill_cache.extract_checklist_section(body);
    expect(result).not.toBeNull();
    expect(result!.includes("lowercase dod")).toBe(true);
  });

  it("test_definition_of_done_heading", () => {
    const body = "## Definition of Done\n\n- criterion one\n";
    const result = skill_cache.extract_checklist_section(body);
    expect(result).not.toBeNull();
    expect(result!.includes("criterion one")).toBe(true);
  });

  it("test_quick_start_heading", () => {
    const body = "## Quick Start\n\nrun this command\n";
    const result = skill_cache.extract_checklist_section(body);
    expect(result).not.toBeNull();
    expect(result!.includes("run this command")).toBe(true);
  });
});

// ===========================================================================
// hooks_session recovery hint
// ===========================================================================

describe("TestRecoveryHintSkills", () => {
  it("test_skills_block_appears", () => {
    const sid = "session-recovery-skill";
    session.mark_skill_loaded(sid, "ralph", "oid1", "sha1", 25_000, false);
    const hint = hooks_session._build_recovery_hint(sid);
    expect(hint).not.toBeNull();
    expect(hint!.includes("### Active Skills")).toBe(true);
    expect(hint!.includes("ralph")).toBe(true);
    expect(hint!.includes("token-goat skill-body <name>")).toBe(true);
  });

  it("test_checklist_inlined_when_body_stored", () => {
    const sid = "session-recovery-checklist";
    const dod_text = "- All tests pass\n- Lint clean\n- Mypy clean";
    const body = `# ralph\n\nIntro.\n\n## DoD\n\n${dod_text}\n\n## Other\n\nNot this.\n`;
    const meta = skill_cache.store_output(sid, "ralph", body);
    expect(meta).not.toBeNull();
    session.mark_skill_loaded(
      sid, meta!.skill_name, meta!.output_id, meta!.content_sha,
      meta!.body_bytes, meta!.truncated,
    );
    const hint = hooks_session._build_recovery_hint(sid);
    expect(hint).not.toBeNull();
    expect(hint!.includes("### Active Skills")).toBe(true);
    expect(hint!.includes("ralph")).toBe(true);
    expect(hint!.includes("--section DoD")).toBe(true);
  });

  it("test_fallback_when_no_checklist_in_body", () => {
    const sid = "session-recovery-fallback";
    const body = "# ralph\n\n## Overview\n\nJust an overview.\n\n## Usage\n\nUsage.\n" + "x".repeat(300);
    const meta = skill_cache.store_output(sid, "ralph", body);
    expect(meta).not.toBeNull();
    session.mark_skill_loaded(
      sid, meta!.skill_name, meta!.output_id, meta!.content_sha,
      meta!.body_bytes, meta!.truncated,
    );
    const hint = hooks_session._build_recovery_hint(sid);
    expect(hint).not.toBeNull();
    expect(hint!.includes("ralph")).toBe(true);
    expect(hint!.includes("token-goat skill-body <name>")).toBe(true);
  });

  it("test_no_skills_no_block", () => {
    const sid = "session-recovery-no-skill";
    session.mark_file_read(sid, "/tmp/foo.py", 0, 20);
    const hint = hooks_session._build_recovery_hint(sid);
    if (hint !== null) {
      expect(hint.includes("### Active Skills")).toBe(false);
    }
  });
});

// ===========================================================================
// config.SkillPreservationConfig
// ===========================================================================

describe("TestSkillPreservationConfig", () => {
  // _isolate_config: point config_path at a non-existent file so the real user
  // config.toml is never read. clearModuleCaches() in setup.ts already resets the
  // config mtime cache before each test.
  let savedEnv: string | undefined;

  beforeEach(() => {
    const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "tg-cfg-")));
    paths.setConfigPathOverride(path.join(tmp, "config.toml"));
    config.clearConfigCache();
    savedEnv = process.env.TOKEN_GOAT_SKILL_PRESERVATION;
  });

  afterEach(() => {
    config.clearConfigCache();
    paths.setConfigPathOverride(undefined);
    if (savedEnv === undefined) delete process.env.TOKEN_GOAT_SKILL_PRESERVATION;
    else process.env.TOKEN_GOAT_SKILL_PRESERVATION = savedEnv;
  });

  it("test_defaults", () => {
    delete process.env.TOKEN_GOAT_SKILL_PRESERVATION;
    const cfg = config.load();
    expect(cfg.skill_preservation!.enabled).toBe(true);
    expect(cfg.skill_preservation!.max_cache_bytes).toBe(5 * 1024 * 1024);
  });

  it.each(["0", "false", "no", "off", "FALSE"])(
    "test_env_override_disables(%j)",
    (val) => {
      process.env.TOKEN_GOAT_SKILL_PRESERVATION = val;
      config.clearConfigCache();
      const cfg = config.load();
      expect(cfg.skill_preservation!.enabled).toBe(false);
    },
  );

  it("test_save_round_trip", () => {
    delete process.env.TOKEN_GOAT_SKILL_PRESERVATION;
    config.clearConfigCache();
    const cfg = config.load();
    cfg.skill_preservation!.enabled = false;
    cfg.skill_preservation!.max_cache_bytes = 10 * 1024 * 1024;
    config.save(cfg);
    config.clearConfigCache();
    const reloaded = config.load();
    expect(reloaded.skill_preservation!.enabled).toBe(false);
    expect(reloaded.skill_preservation!.max_cache_bytes).toBe(10 * 1024 * 1024);
  });
});

// ===========================================================================
// CLI smoke — deferred (token-goat CLI / typer app not ported)
// ===========================================================================

describe("TestCliSkillCommands", () => {
  // PORT: deferred — `token-goat skill-history` drives the typer cli.app via a
  // subprocess (`uv run python -m token_goat.cli`). The CLI layer is not ported.
  it.skip("test_skill_history_runs", () => {
    // subprocess `uv run ... token_goat.cli skill-history` exits 0.
  });
});

// ===========================================================================
// skill_cache orphan sweep
// ===========================================================================

describe("TestSkillCacheOrphanSweep", () => {
  // _sweep_skill_orphans / _skill_outputs_dir are module-private. Rather than
  // call the sweep directly, we trigger it through its real entry point:
  // store_output() calls _sweep_skill_orphans() once per process (gated by the
  // module-level _sweep_done flag, which clearModuleCaches() resets before every
  // test). We pre-place aged orphan files in the real skills cache dir, then call
  // store_output() to fire the sweep, and assert on what survived. The fresh blob
  // store_output() writes is recent so it never collides with the aged orphans.
  const skillsDir = (): string => cache_common.get_cache_dir("skills");

  function makeBlob(cacheDir: string, name: string, ageSecs: number): string {
    const blob = path.join(cacheDir, name);
    fs.writeFileSync(blob, "dummy skill body", "utf-8");
    const old = Date.now() / 1000 - ageSecs;
    fs.utimesSync(blob, old, old);
    return blob;
  }

  /** Fire the once-per-process sweep via its real trigger (store_output). */
  function triggerSweep(): void {
    skill_cache.store_output("sweep-trigger-sess", "trigger", "trigger body ".repeat(50));
  }

  it("test_sweep_function_exists", () => {
    // PORT: _sweep_skill_orphans is module-private (not exported). The Python
    // hasattr/callable existence check is not directly portable; the behavioural
    // tests below cover the same contract (the sweep runs and removes orphans).
    expect(typeof skill_cache.store_output).toBe("function");
  });

  // PORT: deferred — counts calls to the module-private _skill_outputs_dir to
  // assert the _sweep_done gate fires once. Neither _sweep_done nor
  // _skill_outputs_dir is exported, so the call-count probe cannot be installed.
  it.skip("test_sweep_runs_once_per_process", () => {
    // _sweep_done gate: second _sweep_skill_orphans() call is a no-op.
  });

  it("test_removes_old_blobs", () => {
    const cacheDir = skillsDir();
    // Name must match OUTPUT_FILENAME_RE: {chars}.txt
    const oldName = "a".repeat(16) + "-ralph-" + "b".repeat(16) + ".txt";
    const oldBlob = makeBlob(cacheDir, oldName, 8 * 86400);
    triggerSweep();
    expect(fs.existsSync(oldBlob)).toBe(false);
  });

  it("test_leaves_recent_blobs", () => {
    const cacheDir = skillsDir();
    const recentName = "c".repeat(16) + "-improve-" + "d".repeat(16) + ".txt";
    const recentBlob = makeBlob(cacheDir, recentName, 3600);
    triggerSweep();
    expect(fs.existsSync(recentBlob)).toBe(true);
  });

  // PORT: deferred — asserts _sweep_skill_orphans alone leaves an orphan .json
  // sidecar (body absent) untouched. We can only fire the sweep through its real
  // trigger store_output(), which ALSO runs evict_old_entries → evict_cache_dir,
  // whose orphan-companion sweep legitimately removes a .json sidecar whose .txt
  // body is missing. So the survival invariant cannot be isolated without the
  // module-private _sweep_skill_orphans entry point.
  it.skip("test_skips_json_sidecars", () => {
    // _sweep_skill_orphans() not exported; store_output trigger runs eviction too.
  });

  it("test_also_removes_sidecar_when_blob_removed", () => {
    const cacheDir = skillsDir();
    const blobName = "1".repeat(16) + "-myskill-" + "2".repeat(16) + ".txt";
    const blob = makeBlob(cacheDir, blobName, 8 * 86400);
    const sidecar = blob.slice(0, -".txt".length) + ".json";
    fs.writeFileSync(sidecar, '{"skill_name": "myskill"}', "utf-8");
    triggerSweep();
    expect(fs.existsSync(blob)).toBe(false);
    expect(fs.existsSync(sidecar)).toBe(false);
  });

  it("test_disabled_by_config", () => {
    const cacheDir = skillsDir();
    const oldName = "3".repeat(16) + "-oldskill-" + "4".repeat(16) + ".txt";
    const oldBlob = makeBlob(cacheDir, oldName, 8 * 86400);
    const orig = config.load;
    vi.spyOn(config, "load").mockImplementation(() => {
      const c = orig();
      c.skill_preservation!.orphan_sweep_enabled = false;
      return c;
    });
    triggerSweep();
    expect(fs.existsSync(oldBlob)).toBe(true);
  });

  // PORT: deferred — patches the module-private _skill_outputs_dir to point at a
  // non-existent dir. Not exported, so the redirect cannot be installed.
  it.skip("test_handles_missing_cache_dir", () => {
    // _skill_outputs_dir() not exported.
  });

  it("test_handles_io_error_on_unlink", () => {
    // File-removal errors are swallowed; the sweep continues and never throws.
    const cacheDir = skillsDir();
    const oldName = "5".repeat(16) + "-errskill-" + "6".repeat(16) + ".txt";
    makeBlob(cacheDir, oldName, 8 * 86400);
    const origUnlink = fs.unlinkSync;
    let calls = 0;
    vi.spyOn(fs, "unlinkSync").mockImplementation(((p: fs.PathLike) => {
      calls += 1;
      if (calls === 1) {
        const err = new Error("disk full") as NodeJS.ErrnoException;
        err.code = "EIO";
        throw err;
      }
      return origUnlink(p);
    }) as typeof fs.unlinkSync);
    // Must not throw.
    expect(() => triggerSweep()).not.toThrow();
  });

  it("test_env_override_disables", () => {
    const saved = process.env.TOKEN_GOAT_ORPHAN_SWEEP;
    const savedSP = process.env.TOKEN_GOAT_SKILL_PRESERVATION;
    process.env.TOKEN_GOAT_ORPHAN_SWEEP = "0";
    delete process.env.TOKEN_GOAT_SKILL_PRESERVATION;
    try {
      config.clearConfigCache();
      const cfg = config.load();
      expect(cfg.skill_preservation!.orphan_sweep_enabled).toBe(false);
    } finally {
      if (saved === undefined) delete process.env.TOKEN_GOAT_ORPHAN_SWEEP;
      else process.env.TOKEN_GOAT_ORPHAN_SWEEP = saved;
      if (savedSP === undefined) delete process.env.TOKEN_GOAT_SKILL_PRESERVATION;
      else process.env.TOKEN_GOAT_SKILL_PRESERVATION = savedSP;
      config.clearConfigCache();
    }
  });

  it("test_config_orphan_age_secs_default", () => {
    const saved = process.env.TOKEN_GOAT_ORPHAN_SWEEP;
    delete process.env.TOKEN_GOAT_ORPHAN_SWEEP;
    try {
      config.clearConfigCache();
      const cfg = config.load();
      expect(cfg.skill_preservation!.orphan_age_secs).toBe(604800);
    } finally {
      if (saved === undefined) delete process.env.TOKEN_GOAT_ORPHAN_SWEEP;
      else process.env.TOKEN_GOAT_ORPHAN_SWEEP = saved;
      config.clearConfigCache();
    }
  });
});
