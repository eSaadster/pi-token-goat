/**
 * Faithful TS port of tests/test_skill_iter3_improvements.py.
 *
 * Covers:
 * 1. Session-level duplicate skill load hint (post_skill emits systemMessage on re-load)
 * 2. Compact slice header ('--- compact form (N tokens) ---')
 * 3. Skill name normalization (path prefix, .md suffix, casing)
 * 4. Pre-read hook intercepts direct reads of skill body files
 *
 * Porting notes:
 *  - tmp_data_dir fixture -> handled by tests/setup.ts (per-test tmp data dir).
 *  - hooks_read.pre_read is ASYNC in the TS port (returns Promise); awaited here.
 *  - assert resp.get("continue") is True -> expect(resp.continue).toBe(true).
 *  - All four modules (hooks_read, hooks_skill, session, skill_cache) are ported.
 */
import { describe, expect, it } from "vitest";

import os from "node:os";

import * as hooks_read from "../src/token_goat/hooks_read.js";
import * as hooks_skill from "../src/token_goat/hooks_skill.js";
import * as session from "../src/token_goat/session.js";
import * as skill_cache from "../src/token_goat/skill_cache.js";
import type { HookPayload, HookResponse } from "../src/token_goat/types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const _LARGE_BODY =
  "# Ralph\n\n" +
  "## Key Rules\n\n" +
  "CRITICAL: Never skip a DoD gate.\n" +
  "MUST: Always check.\n\n" +
  "padding ".repeat(600);

const _SMALL_BODY = "# Skill\n\n" + "content ".repeat(200);

function _skill_payload(
  sid: string,
  skill_name: string,
  body: string = _LARGE_BODY,
): HookPayload {
  return {
    session_id: sid,
    tool_name: "Skill",
    tool_input: { skill: skill_name },
    tool_response: body,
  } as unknown as HookPayload;
}

function _read_payload(sid: string, file_path: string): HookPayload {
  return {
    session_id: sid,
    tool_name: "Read",
    tool_input: { file_path },
  } as unknown as HookPayload;
}

// ---------------------------------------------------------------------------
// Improvement 1: Session-level duplicate skill load hint
// ---------------------------------------------------------------------------

describe("TestDuplicateSkillLoadHint", () => {
  it("test_first_load_no_reload_hint", () => {
    const sid = "iter3-first-load";
    const resp = hooks_skill.post_skill(_skill_payload(sid, "ralph"));
    expect(resp.continue).toBe(true);
    const sys_msg = resp.systemMessage ?? "";
    expect(sys_msg.includes("already loaded")).toBe(false);
  });

  it("test_second_load_emits_reload_hint", () => {
    const sid = "iter3-second-load";
    hooks_skill.post_skill(_skill_payload(sid, "ralph"));
    const resp = hooks_skill.post_skill(_skill_payload(sid, "ralph"));
    expect(resp.continue).toBe(true);
    const sys_msg = resp.systemMessage ?? "";
    expect(sys_msg.includes("already loaded")).toBe(true);
    expect(sys_msg.includes("token-goat skill-body ralph")).toBe(true);
  });

  it("test_reload_hint_includes_token_count", () => {
    const sid = "iter3-reload-tokens";
    hooks_skill.post_skill(_skill_payload(sid, "ralph"));
    const resp = hooks_skill.post_skill(_skill_payload(sid, "ralph"));
    const sys_msg = resp.systemMessage ?? "";
    expect(sys_msg.includes("token")).toBe(true);
  });

  it("test_different_skills_no_cross_hint", () => {
    const sid = "iter3-different-skills";
    hooks_skill.post_skill(_skill_payload(sid, "ralph"));
    const resp = hooks_skill.post_skill(_skill_payload(sid, "brainstorming"));
    const sys_msg = resp.systemMessage ?? "";
    // Brainstorming is a first load — no reload hint.
    expect(sys_msg.includes("already loaded")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Improvement 2: Compact slice header
// ---------------------------------------------------------------------------

describe("TestCompactSliceHeader", () => {
  it("test_header_present_in_stored_compact", () => {
    skill_cache.store_compact("iter3-hdr", "ralph", "Some compact content here.");
    const result = skill_cache.get_compact("iter3-hdr", "ralph");
    expect(result).not.toBeNull();
    expect(result!.startsWith("--- compact form (")).toBe(true);
    expect(result!.includes("tokens) ---")).toBe(true);
  });

  it("test_header_token_count_positive", () => {
    const text = "CRITICAL: Always do this.\nMUST: Never skip that.";
    skill_cache.store_compact("iter3-hdr2", "testskill", text);
    const result = skill_cache.get_compact("iter3-hdr2", "testskill") ?? "";
    const m = /compact form \((\d+) tokens\)/.exec(result);
    expect(m).not.toBeNull();
    expect(parseInt(m![1]!, 10)).toBeGreaterThanOrEqual(1);
  });

  it("test_compact_body_follows_header", () => {
    const text = "CRITICAL: Rule A.\nMUST: Rule B.";
    skill_cache.store_compact("iter3-hdr3", "myskill", text);
    const result = skill_cache.get_compact("iter3-hdr3", "myskill") ?? "";
    const lines = result.split("\n");
    expect(lines[0]!.startsWith("--- compact form (")).toBe(true);
    const body_part = lines.slice(1).join("\n");
    expect(body_part.includes("CRITICAL: Rule A.")).toBe(true);
  });

  it("test_empty_compact_has_header", () => {
    skill_cache.store_compact("iter3-hdr4", "tiny", "x");
    const result = skill_cache.get_compact("iter3-hdr4", "tiny") ?? "";
    expect(result.includes("compact form")).toBe(true);
    expect(result.includes("x")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Improvement 3: Skill name normalization in hooks_skill
// ---------------------------------------------------------------------------

describe("TestSkillNameNormalization", () => {
  it("test_path_prefix_stripped", () => {
    const sid = "iter3-norm-path";
    const resp = hooks_skill.post_skill(
      _skill_payload(sid, "~/.claude/skills/ralph", _SMALL_BODY),
    );
    expect(resp.continue).toBe(true);
    const cache = session.load(sid);
    expect("ralph" in cache.skill_history).toBe(true);
    // No entry with slashes or tilde.
    expect(
      Object.keys(cache.skill_history).every(
        (k) => !k.includes("/") && !k.includes("~"),
      ),
    ).toBe(true);
  });

  it("test_md_suffix_stripped", () => {
    const sid = "iter3-norm-md";
    const resp = hooks_skill.post_skill(
      _skill_payload(sid, "ralph.md", _SMALL_BODY),
    );
    expect(resp.continue).toBe(true);
    const cache = session.load(sid);
    expect("ralph" in cache.skill_history).toBe(true);
    expect("ralph.md" in cache.skill_history).toBe(false);
  });

  it("test_uppercase_normalized_to_lower", () => {
    const sid = "iter3-norm-case";
    const resp = hooks_skill.post_skill(
      _skill_payload(sid, "Ralph", _SMALL_BODY),
    );
    expect(resp.continue).toBe(true);
    const cache = session.load(sid);
    expect("ralph" in cache.skill_history).toBe(true);
    expect("Ralph" in cache.skill_history).toBe(false);
  });

  it("test_windows_path_stripped", () => {
    const sid = "iter3-norm-win";
    const resp = hooks_skill.post_skill(
      _skill_payload(sid, "C:\\Users\\user\\.claude\\skills\\ralph", _SMALL_BODY),
    );
    expect(resp.continue).toBe(true);
    const cache = session.load(sid);
    expect("ralph" in cache.skill_history).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Improvement 4: Pre-read hook intercepts direct reads of skill body files
// ---------------------------------------------------------------------------

describe("TestSkillFileReadHint", () => {
  function _load_skill(sid: string, skill_name = "ralph"): void {
    hooks_skill.post_skill(_skill_payload(sid, skill_name, _SMALL_BODY));
  }

  function _ctx(resp: HookResponse): string {
    const hook_out = resp.hookSpecificOutput;
    if (hook_out !== null && typeof hook_out === "object" && !Array.isArray(hook_out)) {
      return String((hook_out as Record<string, unknown>)["additionalContext"] ?? "");
    }
    return "";
  }

  it("test_skill_file_read_emits_hint_when_loaded", async () => {
    const sid = "iter3-skill-read-hint";
    _load_skill(sid, "ralph");
    const home = os.homedir();
    const skill_md = `${home}/.claude/skills/ralph/SKILL.md`;
    const resp = await hooks_read.pre_read(_read_payload(sid, skill_md));
    expect(resp.continue).toBe(true);
    const ctx = _ctx(resp);
    expect(ctx.includes("token-goat skill-body ralph")).toBe(true);
    expect(ctx.includes("in context")).toBe(true);
  });

  it("test_skill_file_read_no_hint_when_not_loaded", async () => {
    const sid = "iter3-skill-read-no-hint";
    const home = os.homedir();
    const skill_md = `${home}/.claude/skills/brainstorming/SKILL.md`;
    const resp = await hooks_read.pre_read(_read_payload(sid, skill_md));
    expect(resp.continue).toBe(true);
    const ctx = _ctx(resp);
    expect(ctx.includes("skill-body")).toBe(false);
  });

  it("test_detect_skill_name_from_path_bare", () => {
    const result = hooks_read._detect_skill_name_from_path(
      "/home/user/.claude/skills/ralph/SKILL.md",
    );
    expect(result).toBe("ralph");
  });

  it("test_detect_skill_name_from_path_flat", () => {
    const result = hooks_read._detect_skill_name_from_path(
      "/home/user/.claude/skills/improve.md",
    );
    expect(result).toBe("improve");
  });

  it("test_detect_skill_name_windows_separators", () => {
    const result = hooks_read._detect_skill_name_from_path(
      "C:\\Users\\user\\.claude\\skills\\ralph\\SKILL.md",
    );
    expect(result).toBe("ralph");
  });

  it("test_detect_skill_name_non_skill_file_returns_none", () => {
    const result = hooks_read._detect_skill_name_from_path(
      "/home/user/.claude/settings.json",
    );
    expect(result).toBeNull();
  });

  it("test_detect_skill_name_plugin_layout", () => {
    const result = hooks_read._detect_skill_name_from_path(
      "/home/user/.claude/plugins/myplugin/skills/ralph/SKILL.md",
    );
    expect(result).toBe("ralph");
  });

  it("test_hint_deduped_on_repeat_read", async () => {
    const sid = "iter3-skill-read-dedup";
    _load_skill(sid, "ralph");
    const home = os.homedir();
    const skill_md = `${home}/.claude/skills/ralph/SKILL.md`;
    // First read: hint fires.
    const resp1 = await hooks_read.pre_read(_read_payload(sid, skill_md));
    const ctx1 = _ctx(resp1);
    expect(ctx1.includes("skill-body")).toBe(true);

    // Second read: hint should be suppressed (fingerprint dedup).
    const resp2 = await hooks_read.pre_read(_read_payload(sid, skill_md));
    const ctx2 = _ctx(resp2);
    expect(ctx2.includes("skill-body")).toBe(false);
  });
});
