/**
 * Faithful TS port of tests/test_skill_iter10_integration.py.
 *
 * Covers:
 * 1. Full round-trip integration: PostToolUse(Skill) hook -> compact stored ->
 *    session_start(source="compact") writes sidecar -> pre_read injects sidecar.
 *    Ported (hooks_skill, skill_cache, hooks_session, paths, hooks_read).
 * 2. install.py CLAUDE.md / SKILL.md skill commands (DEFERRED — install not ported).
 * 3. skill-list CLI reflects hook-registered skills (DEFERRED — cli not ported).
 *
 * Porting notes:
 *  - tmp_data_dir fixture -> handled by tests/setup.ts (per-test tmp data dir).
 *  - conftest.fire_skill_hook -> local fire_skill_hook calling hooks_skill.post_skill.
 *  - hook_helpers.assert_continue -> local _assert_continue.
 *  - paths.recovery_pending_path -> paths.recoveryPendingPath (camelCase TS port).
 *  - hooks_read.pre_read is ASYNC in the TS port; awaited here.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import fs from "node:fs";

import { invoke } from "./_cli_runner.js";
import * as hooks_read from "../src/token_goat/hooks_read.js";
import * as hooks_skill from "../src/token_goat/hooks_skill.js";
import * as hooks_session from "../src/token_goat/hooks_session.js";
import * as install from "../src/token_goat/install.js";
import * as paths from "../src/token_goat/paths.js";
import * as skill_cache from "../src/token_goat/skill_cache.js";
import type { HookPayload, HookResponse } from "../src/token_goat/types.js";

afterEach(() => {
  vi.restoreAllMocks();
});

function fire_skill_hook(
  session_id: string,
  skill_name: string,
  body: string,
): HookResponse {
  const payload = {
    session_id,
    tool_name: "Skill",
    tool_input: { skill: skill_name },
    tool_response: body,
  } as unknown as HookPayload;
  return hooks_skill.post_skill(payload);
}

function _assert_continue(result: { continue?: boolean }): void {
  expect(result.continue).toBe(true);
}

// ---------------------------------------------------------------------------
// Realistic large skill fixture (>4000 bytes so the hook triggers compact storage)
// ---------------------------------------------------------------------------

const _SKILL_COMPACT_SECTION = `# test-skill

Skill for integration testing.

## Key Rules

- CRITICAL: Always run tests before claiming done.
- MUST: Commit after each validated step.
- NEVER: Claim success without evidence.
- RULE: Zero lint warnings before shipping.

## DoD

1. All tests pass.
2. Lint clean.
3. Types pass.
`;

const _SKILL_DETAIL_SECTION =
  "\n## Extended Reference\n\n" +
  "This section provides deep background on how the skill phases work.\n\n" +
  "### Phase 1\n\nExplore the codebase without writing files.\n\n" +
  "### Phase 2\n\nDraft a multi-step plan with atomic, verifiable steps.\n\n" +
  "### Phase 3\n\nImplement one step at a time. Validate after each.\n\n" +
  "Extended detail content for padding. ".repeat(150);

const _LARGE_SKILL_BODY_WITH_MARKER =
  _SKILL_COMPACT_SECTION + "\n<!-- COMPACT_END -->\n" + _SKILL_DETAIL_SECTION;

const _LARGE_SKILL_BODY_NO_MARKER =
  "# no-marker-skill\n\n## DoD\n\n- CRITICAL: All tests pass.\n- MUST: Lint clean.\n\n" +
  "## Background\n\nThis skill has no COMPACT_END marker.\n\n" +
  "Background content for padding. ".repeat(200);

// ---------------------------------------------------------------------------
// 1. Full round-trip: hook -> session -> session_start(compact) -> pre_read inject
// ---------------------------------------------------------------------------

describe("TestFullSkillRoundTrip", () => {
  it("test_hook_to_sidecar_with_marker_skill", () => {
    const sid = "e2e-marker-sidecar";

    // Step 1: PostToolUse Skill fires — stores body + compact.
    const resp = fire_skill_hook(sid, "test-skill", _LARGE_SKILL_BODY_WITH_MARKER);
    expect(resp.continue).toBe(true);

    // Verify compact was stored (precondition for the sidecar to mention compact).
    const stored_compact = skill_cache.get_compact(sid, "test-skill");
    expect(stored_compact).not.toBeNull();

    // Step 2: session_start with source="compact" writes the sidecar.
    const result = hooks_session.session_start({
      session_id: sid,
      source: "compact",
      cwd: "/proj",
    } as unknown as HookPayload);
    _assert_continue(result);

    const sidecar = paths.recoveryPendingPath(sid);
    expect(fs.existsSync(sidecar)).toBe(true);

    const content = fs.readFileSync(sidecar, "utf-8");
    expect(content.includes("test-skill")).toBe(true);
    expect(content.includes("token-goat skill-body")).toBe(true);
  });

  it("test_hook_to_pre_read_injection", async () => {
    const sid = "e2e-pre-read-inject";

    // Step 1: fire hook.
    fire_skill_hook(sid, "test-skill", _LARGE_SKILL_BODY_WITH_MARKER);

    // Step 2: session_start(compact) writes sidecar.
    const result = hooks_session.session_start({
      session_id: sid,
      source: "compact",
      cwd: "/proj",
    } as unknown as HookPayload);
    _assert_continue(result);
    expect(fs.existsSync(paths.recoveryPendingPath(sid))).toBe(true);

    // Step 3: pre_read injects the hint.
    const pre_read_resp = await hooks_read.pre_read({
      session_id: sid,
      tool_name: "Read",
      tool_input: { file_path: "/proj/src/main.py" },
    } as unknown as HookPayload);
    _assert_continue(pre_read_resp);

    const hso = pre_read_resp.hookSpecificOutput;
    expect(hso).not.toBeNull();
    expect(hso).not.toBeUndefined();
    const ctx = String((hso as Record<string, unknown>)["additionalContext"] ?? "");
    expect(ctx.includes("test-skill")).toBe(true);

    // Sidecar must be cleaned up.
    expect(fs.existsSync(paths.recoveryPendingPath(sid))).toBe(false);
  });

  it("test_hook_to_pre_read_no_double_injection", async () => {
    const sid = "e2e-no-double-inject";

    fire_skill_hook(sid, "test-skill", _LARGE_SKILL_BODY_WITH_MARKER);
    hooks_session.session_start({
      session_id: sid,
      source: "compact",
      cwd: "/proj",
    } as unknown as HookPayload);

    // First call injects.
    const r1 = await hooks_read.pre_read({
      session_id: sid,
      tool_name: "Read",
      tool_input: { file_path: "/proj/src/main.py" },
    } as unknown as HookPayload);
    _assert_continue(r1);
    expect(r1.hookSpecificOutput).not.toBeNull();
    expect(r1.hookSpecificOutput).not.toBeUndefined();

    // Second call must NOT inject again.
    const r2 = await hooks_read.pre_read({
      session_id: sid,
      tool_name: "Read",
      tool_input: { file_path: "/proj/src/other.py" },
    } as unknown as HookPayload);
    _assert_continue(r2);
    const hso2 = r2.hookSpecificOutput;
    // hookSpecificOutput may be present for other reasons (e.g. a read hint),
    // but it must NOT contain the Post-Compact Recovery header again.
    if (hso2) {
      const ctx2 = String((hso2 as Record<string, unknown>)["additionalContext"] ?? "");
      expect(ctx2.includes("Post-Compact Recovery")).toBe(false);
    }
  });

  it("test_no_marker_skill_also_surfaces_in_sidecar", () => {
    const sid = "e2e-no-marker-sidecar";

    fire_skill_hook(sid, "no-marker-skill", _LARGE_SKILL_BODY_NO_MARKER);
    hooks_session.session_start({
      session_id: sid,
      source: "compact",
      cwd: "/proj",
    } as unknown as HookPayload);

    const sidecar = paths.recoveryPendingPath(sid);
    expect(fs.existsSync(sidecar)).toBe(true);
    const content = fs.readFileSync(sidecar, "utf-8");
    expect(content.includes("no-marker-skill")).toBe(true);
  });

  it("test_two_skills_both_in_sidecar", () => {
    const sid = "e2e-two-skills-sidecar";

    fire_skill_hook(sid, "test-skill", _LARGE_SKILL_BODY_WITH_MARKER);
    fire_skill_hook(sid, "no-marker-skill", _LARGE_SKILL_BODY_NO_MARKER);

    hooks_session.session_start({
      session_id: sid,
      source: "compact",
      cwd: "/proj",
    } as unknown as HookPayload);

    const content = fs.readFileSync(paths.recoveryPendingPath(sid), "utf-8");
    expect(content.includes("test-skill")).toBe(true);
    expect(content.includes("no-marker-skill")).toBe(true);
  });

  it("test_compact_stored_survives_round_trip", async () => {
    const sid = "e2e-compact-survives";

    fire_skill_hook(sid, "test-skill", _LARGE_SKILL_BODY_WITH_MARKER);

    // Compact must be readable before and after the session_start + pre_read cycle.
    const before = skill_cache.get_compact(sid, "test-skill");
    expect(before).not.toBeNull();
    expect(before!.includes("CRITICAL")).toBe(true);

    hooks_session.session_start({
      session_id: sid,
      source: "compact",
      cwd: "/proj",
    } as unknown as HookPayload);
    await hooks_read.pre_read({
      session_id: sid,
      tool_name: "Read",
      tool_input: { file_path: "/proj/src/main.py" },
    } as unknown as HookPayload);

    const after = skill_cache.get_compact(sid, "test-skill");
    expect(after).not.toBeNull();
    expect(after).toBe(before);
  });
});

// ---------------------------------------------------------------------------
// 2. install.py CLAUDE.md and SKILL.md must document skill commands
//
// CLAUDE_MD_CONTENT, SKILL_MD_CONTENT and CODEX_AGENTS_MD_CONTENT are exported
// from install.ts. `_ROUTING_ROWS` is module-private in the TS port (not
// exported), so test_routing_table_includes_powershell_row observes the same
// invariant through CLAUDE_MD_CONTENT, which is rendered 1:1 from that table.
// ---------------------------------------------------------------------------

describe("TestInstallSkillCommandDocumentation", () => {
  it("test_claude_md_content_has_skill_body", () => {
    expect(install.CLAUDE_MD_CONTENT).toContain("skill-body");
  });

  it("test_claude_md_content_has_skill_compact", () => {
    expect(install.CLAUDE_MD_CONTENT).toContain("skill-compact");
  });

  it("test_claude_md_content_has_skill_list", () => {
    expect(install.CLAUDE_MD_CONTENT).toContain("skill-list");
  });

  it("test_claude_md_content_has_skill_size", () => {
    expect(install.CLAUDE_MD_CONTENT).toContain("skill-size");
  });

  it("test_claude_md_content_has_skill_section", () => {
    expect(install.CLAUDE_MD_CONTENT).toContain("skill-section");
  });

  it("test_claude_md_content_mentions_get_content", () => {
    expect(install.CLAUDE_MD_CONTENT).toContain("Get-Content");
  });

  it("test_skill_md_content_has_skill_body", () => {
    expect(install.SKILL_MD_CONTENT).toContain("skill-body");
  });

  it("test_skill_md_content_has_skill_compact", () => {
    expect(install.SKILL_MD_CONTENT).toContain("skill-compact");
  });

  it("test_skill_md_content_has_skill_list", () => {
    expect(install.SKILL_MD_CONTENT).toContain("skill-list");
  });

  it("test_skill_md_content_has_skill_size", () => {
    expect(install.SKILL_MD_CONTENT).toContain("skill-size");
  });

  it("test_skill_md_content_has_skill_section", () => {
    expect(install.SKILL_MD_CONTENT).toContain("skill-section");
  });

  it("test_skill_md_content_mentions_get_content", () => {
    expect(install.SKILL_MD_CONTENT).toContain("Get-Content");
  });

  it("test_routing_table_includes_powershell_row", () => {
    // Python imports the private _ROUTING_ROWS list and asserts a row mentions
    // "PowerShell" or "Get-Content". That list is module-private in the TS
    // port; CLAUDE_MD_CONTENT is rendered entirely from it, so the rendered
    // table includes the PowerShell Get-Content row iff the source row exists.
    const hasPsRow =
      install.CLAUDE_MD_CONTENT.includes("PowerShell") ||
      install.CLAUDE_MD_CONTENT.includes("Get-Content");
    expect(hasPsRow).toBe(true);
  });

  it("test_all_three_routing_tables_have_get_content", () => {
    for (const [name, content] of [
      ["CLAUDE_MD_CONTENT", install.CLAUDE_MD_CONTENT],
      ["SKILL_MD_CONTENT", install.SKILL_MD_CONTENT],
      ["CODEX_AGENTS_MD_CONTENT", install.CODEX_AGENTS_MD_CONTENT],
    ] as const) {
      expect(content, `${name} is missing the PowerShell Get-Content row`).toContain("Get-Content");
    }
  });

  it("test_claude_md_skill_commands_have_one_line_descriptions", () => {
    for (const cmd of ["skill-body", "skill-compact", "skill-list", "skill-size", "skill-section"]) {
      const linesWithCmd = install.CLAUDE_MD_CONTENT.split("\n").filter((ln) => ln.includes(cmd));
      expect(linesWithCmd.length, `No line containing '${cmd}' found in CLAUDE_MD_CONTENT`).toBeGreaterThan(0);
      // At least one line must have more content than just the command name.
      const hasDescription = linesWithCmd.some(
        (ln) => ln.trim().length > `\`token-goat ${cmd}\``.length + 5,
      );
      expect(hasDescription, `Command '${cmd}' in CLAUDE_MD_CONTENT has no description on the same line`).toBe(true);
    }
  });

  it("test_skill_md_skill_commands_section_present", () => {
    expect(install.SKILL_MD_CONTENT).toContain("## Skill commands");
  });
});

// ---------------------------------------------------------------------------
// 3. skill-list CLI reflects skills registered via the hook
//
// Ported: cli (commander app) + the in-process invoke() CliRunner analogue.
// Python monkeypatch.setenv("CLAUDE_SESSION_ID", sid) -> save/restore env here.
// ---------------------------------------------------------------------------

describe("TestSkillListCLIAfterHook", () => {
  let _savedSid: string | undefined;
  function _setSessionId(sid: string): void {
    _savedSid = process.env["CLAUDE_SESSION_ID"];
    process.env["CLAUDE_SESSION_ID"] = sid;
  }
  afterEach(() => {
    if (_savedSid === undefined) delete process.env["CLAUDE_SESSION_ID"];
    else process.env["CLAUDE_SESSION_ID"] = _savedSid;
    _savedSid = undefined;
  });

  it("test_skill_list_shows_hook_loaded_skill", async () => {
    const sid = "skill-list-hook-1";
    _setSessionId(sid);
    fire_skill_hook(sid, "test-skill", _LARGE_SKILL_BODY_WITH_MARKER);

    const result = await invoke(["skill-list", "--session-id", sid]);
    expect(result.exit_code, `skill-list failed: ${result.stdout}`).toBe(0);
    expect(result.stdout.includes("test-skill")).toBe(true);
  });

  it("test_skill_list_shows_compact_yes_for_marker_skill", async () => {
    const sid = "skill-list-hook-compact";
    _setSessionId(sid);
    fire_skill_hook(sid, "test-skill", _LARGE_SKILL_BODY_WITH_MARKER);

    const result = await invoke(["skill-list", "--session-id", sid, "--json"]);
    expect(result.exit_code, `skill-list --json failed: ${result.stdout}`).toBe(0);
    const data = JSON.parse(result.stdout) as { skills?: Array<Record<string, unknown>> };
    const skills = data.skills ?? [];
    const entry = skills.find((s) => s["name"] === "test-skill");
    expect(entry, `test-skill not in JSON output: ${JSON.stringify(skills)}`).not.toBeUndefined();
    // skill-list --json uses "has_compact" as the key name.
    expect(entry!["has_compact"]).toBe(true);
  });

  it("test_skill_list_two_skills_after_two_hooks", async () => {
    const sid = "skill-list-hook-two";
    _setSessionId(sid);
    fire_skill_hook(sid, "test-skill", _LARGE_SKILL_BODY_WITH_MARKER);
    fire_skill_hook(sid, "no-marker-skill", _LARGE_SKILL_BODY_NO_MARKER);

    const result = await invoke(["skill-list", "--session-id", sid]);
    expect(result.exit_code, `skill-list failed: ${result.stdout}`).toBe(0);
    expect(result.stdout.includes("test-skill")).toBe(true);
    expect(result.stdout.includes("no-marker-skill")).toBe(true);
  });
});
