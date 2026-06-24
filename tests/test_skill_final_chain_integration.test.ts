/**
 * Faithful TS port of tests/test_skill_final_chain_integration.py.
 *
 * Exercises the complete chain: PostToolUse(Skill) hook -> body + compact cached
 * -> stale detection via skill-list --json -> skill-compact --all regeneration ->
 * skill-list --json confirms compact_stale=False.
 *
 * Porting notes:
 *  - tmp_data_dir fixture -> handled by tests/setup.ts (per-test tmp data dir).
 *  - conftest.fire_skill_hook -> local fire_skill_hook calling hooks_skill.post_skill.
 *  - CliRunner().invoke(cli.app, ["skill-list", ...]) / ["skill-compact", "--all"]:
 *    the token_goat CLI (Typer app) is NOT ported. Every test that drives the CLI
 *    is DEFERRED. The hook/store/compact paths that DON'T touch the CLI are ported.
 *  - build_manifest(sid, max_tokens=N) -> build_manifest(sid, { max_tokens: N }).
 */
import { describe, expect, it, afterEach, beforeEach, vi } from "vitest";

import { invoke } from "./_cli_runner.js";
import * as skill_cache from "../src/token_goat/skill_cache.js";
import * as hooks_skill from "../src/token_goat/hooks_skill.js";
import * as session from "../src/token_goat/session.js";
import * as compact from "../src/token_goat/compact.js";
import * as install from "../src/token_goat/install.js";
import type { HookPayload, HookResponse } from "../src/token_goat/types.js";

// CLAUDE_SESSION_ID drives skill-compact --all's session-vs-cache branch; capture
// the ambient value once and reset to a clean slate around every test (Steps 3/4
// set it explicitly per the Python monkeypatch.setenv).
const _ORIG_SID = process.env["CLAUDE_SESSION_ID"];
beforeEach(() => {
  delete process.env["CLAUDE_SESSION_ID"];
});
afterEach(() => {
  if (_ORIG_SID === undefined) delete process.env["CLAUDE_SESSION_ID"];
  else process.env["CLAUDE_SESSION_ID"] = _ORIG_SID;
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

// ---------------------------------------------------------------------------
// Shared fixture: large skill body with COMPACT_END marker (>4000 bytes)
// ---------------------------------------------------------------------------

const _COMPACT_SECTION = `# chain-skill

Skill for final chain integration tests.

## Key Rules

- CRITICAL: Run all tests before marking complete.
- MUST: Commit after each validated checkpoint.
- NEVER: Claim done without evidence.
- RULE: Zero lint warnings before shipping.

## DoD

1. Full test suite passes.
2. Lint clean.
3. Types pass.
`;

const _DETAIL_SECTION =
  "\n## Detail\n\n" +
  "Padding text to push the detail section past the 4000-byte threshold. ".repeat(
    80,
  );

const _LARGE_SKILL_BODY =
  _COMPACT_SECTION + "\n<!-- COMPACT_END -->\n" + _DETAIL_SECTION;

// ---------------------------------------------------------------------------
// Step 1: PostToolUse(Skill) → body cached + compact generated
// ---------------------------------------------------------------------------

describe("TestStep1HookCachesSkill", () => {
  it("test_hook_stores_body", () => {
    const sid = "chain-step1-body";
    const resp = fire_skill_hook(sid, "chain-skill", _LARGE_SKILL_BODY);
    expect(resp.continue).toBe(true);

    // Body must be loadable from the cache.
    const entries = skill_cache.list_by_session(sid);
    expect(entries.length).toBeGreaterThan(0);
    const body = skill_cache.load_output(entries[0]!.output_id);
    expect(body).toBeTruthy();
    expect(body!.includes("CRITICAL")).toBe(true);
  });

  it("test_hook_stores_compact", () => {
    const sid = "chain-step1-compact";
    fire_skill_hook(sid, "chain-skill", _LARGE_SKILL_BODY);

    const stored_compact = skill_cache.get_compact(sid, "chain-skill");
    expect(stored_compact).not.toBeNull();
    expect(stored_compact!.includes("CRITICAL")).toBe(true);
    // Detail section must NOT appear in the compact.
    expect(stored_compact!.includes("Padding text")).toBe(false);
  });

  it("test_hook_registers_session_entry", () => {
    const sid = "chain-step1-session";
    fire_skill_hook(sid, "chain-skill", _LARGE_SKILL_BODY);

    const cache = session.load(sid);
    expect("chain-skill" in cache.skill_history).toBe(true);
  });

  it("test_compact_has_source_sha_header", () => {
    const sid = "chain-step1-sha";
    fire_skill_hook(sid, "chain-skill", _LARGE_SKILL_BODY);

    const stored_compact = skill_cache.get_compact(sid, "chain-skill");
    expect(stored_compact).not.toBeNull();
    // extract_compact_source_sha returns a non-empty string when SHA is embedded.
    const sha = skill_cache.extract_compact_source_sha(stored_compact!);
    expect(sha).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// Step 2: Stale compact detection via skill-list --json
// ---------------------------------------------------------------------------

function _store_fresh_skill(session_id: string, skill_name: string): string {
  const meta = skill_cache.store_output(session_id, skill_name, _LARGE_SKILL_BODY);
  expect(meta).not.toBeNull();
  skill_cache.write_sidecar(meta!);
  const body_sha = skill_cache.content_hash(_LARGE_SKILL_BODY);
  const compact_body = skill_cache.extract_compact_from_marker(_LARGE_SKILL_BODY);
  expect(compact_body).not.toBeNull();
  skill_cache.store_compact(session_id, skill_name, compact_body!, body_sha);
  return body_sha;
}

function _make_stale(session_id: string, skill_name: string): void {
  const updated_body = _LARGE_SKILL_BODY.replaceAll("chain-skill", "chain-skill-updated");
  const meta = skill_cache.store_output(session_id, skill_name, updated_body);
  expect(meta).not.toBeNull();
  skill_cache.write_sidecar(meta!);
  // The compact remains from the previous SHA — now stale.
}

describe("TestStep2StaleDetection", () => {
  it("test_fresh_compact_shows_compact_stale_false", async () => {
    const sid = "chain-step2-fresh";
    _store_fresh_skill(sid, "chain-skill");

    const r = await invoke(["skill-list", "--json", "--session-id", sid]);
    expect(r.exit_code).toBe(0);
    const data = JSON.parse(r.stdout) as Record<string, unknown>;
    const rows = (data["skills"] as Array<Record<string, unknown>>) ?? [];
    expect(rows.length).toBeGreaterThan(0);
    expect(rows[0]).toHaveProperty("compact_stale");
    expect(rows[0]!["compact_stale"]).toBe(false);
  });

  it("test_stale_compact_shows_compact_stale_true", async () => {
    const sid = "chain-step2-stale";
    _store_fresh_skill(sid, "chain-skill");
    _make_stale(sid, "chain-skill");

    const r = await invoke(["skill-list", "--json", "--session-id", sid]);
    expect(r.exit_code).toBe(0);
    const data = JSON.parse(r.stdout) as Record<string, unknown>;
    const rows = (data["skills"] as Array<Record<string, unknown>>) ?? [];
    expect(rows.length).toBeGreaterThan(0);
    expect(rows[0]).toHaveProperty("compact_stale");
    // True or null are both acceptable; not False.
    expect(rows[0]!["compact_stale"]).not.toBe(false);
  });

  it("test_no_compact_shows_compact_stale_null", async () => {
    const sid = "chain-step2-null";
    const meta = skill_cache.store_output(sid, "chain-skill", _LARGE_SKILL_BODY);
    expect(meta).not.toBeNull();
    skill_cache.write_sidecar(meta!);
    // Deliberately do NOT store a compact.

    const r = await invoke(["skill-list", "--json", "--session-id", sid]);
    expect(r.exit_code).toBe(0);
    const data = JSON.parse(r.stdout) as Record<string, unknown>;
    const rows = (data["skills"] as Array<Record<string, unknown>>) ?? [];
    expect(rows.length).toBeGreaterThan(0);
    expect(rows[0]!["compact_stale"]).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Step 3: skill-compact --all regenerates stale compacts
//
// pregen_skill_compacts is spied so --all does not scan the real ~/.claude/skills.
// ---------------------------------------------------------------------------

function _store_skill_with_stale_compact(session_id: string, skill_name: string): void {
  const meta = skill_cache.store_output(session_id, skill_name, _LARGE_SKILL_BODY);
  expect(meta).not.toBeNull();
  skill_cache.write_sidecar(meta!);
  const stale_sha = "000000000000"; // does not match body SHA
  const compact_body = "# Stale compact\n\nOld rule: this is outdated.";
  skill_cache.store_compact(session_id, skill_name, compact_body, stale_sha);
}

describe("TestStep3SkillCompactAll", () => {
  it("test_skill_compact_all_exits_zero", async () => {
    vi.spyOn(install, "pregen_skill_compacts").mockReturnValue("0 pre-generated");
    const sid = "chain-step3-noop";
    process.env["CLAUDE_SESSION_ID"] = sid;
    const meta = skill_cache.store_output(sid, "chain-skill", _LARGE_SKILL_BODY);
    expect(meta).not.toBeNull();
    skill_cache.write_sidecar(meta!);

    const r = await invoke(["skill-compact", "--all"]);
    expect(r.exit_code).toBe(0);
  });

  it("test_skill_compact_all_regenerates_stale", async () => {
    vi.spyOn(install, "pregen_skill_compacts").mockReturnValue("0 pre-generated");
    const sid = "chain-step3-stale";
    process.env["CLAUDE_SESSION_ID"] = sid;
    _store_skill_with_stale_compact(sid, "chain-skill");

    const old_compact = skill_cache.get_compact(sid, "chain-skill");
    expect(old_compact).not.toBeNull();
    const old_sha = skill_cache.extract_compact_source_sha(old_compact!);
    const body_sha = skill_cache.content_hash(_LARGE_SKILL_BODY);
    expect(old_sha).not.toBe(body_sha.slice(0, (old_sha ?? "").length));

    const r = await invoke(["skill-compact", "--all"]);
    expect(r.exit_code).toBe(0);

    const new_compact = skill_cache.get_compact(sid, "chain-skill");
    expect(new_compact).not.toBeNull();
    const new_sha = skill_cache.extract_compact_source_sha(new_compact!);
    expect(new_sha).toBeTruthy();
    expect(body_sha.startsWith(new_sha!)).toBe(true);
  });

  it("test_skill_compact_all_skips_fresh_compact", async () => {
    vi.spyOn(install, "pregen_skill_compacts").mockReturnValue("0 pre-generated");
    const sid = "chain-step3-skip";
    process.env["CLAUDE_SESSION_ID"] = sid;

    const meta = skill_cache.store_output(sid, "chain-skill", _LARGE_SKILL_BODY);
    expect(meta).not.toBeNull();
    skill_cache.write_sidecar(meta!);
    const body_sha = skill_cache.content_hash(_LARGE_SKILL_BODY);
    const compact_body = "# Fresh compact\n\nRule: everything is current.";
    skill_cache.store_compact(sid, "chain-skill", compact_body, body_sha);

    const before = skill_cache.get_compact(sid, "chain-skill");
    expect(before).not.toBeNull();

    const r = await invoke(["skill-compact", "--all"]);
    expect(r.exit_code).toBe(0);
    const lower = r.stdout.toLowerCase();
    expect(
      lower.includes("skip") ||
        lower.includes("fresh") ||
        lower.includes("up-to-date") ||
        lower.includes("already"),
    ).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Step 4: Full chain — hook → stale → --all → skill-list shows compact_stale=False
// ---------------------------------------------------------------------------

describe("TestStep4FullChain", () => {
  it("test_full_chain", async () => {
    vi.spyOn(install, "pregen_skill_compacts").mockReturnValue("0 pre-generated");
    const sid = "chain-full-e2e";
    process.env["CLAUDE_SESSION_ID"] = sid;

    // --- 1. Hook fires: body + compact cached -------------------------
    const resp = fire_skill_hook(sid, "chain-skill", _LARGE_SKILL_BODY);
    expect(resp.continue).toBe(true);

    const stored_compact = skill_cache.get_compact(sid, "chain-skill");
    expect(stored_compact).not.toBeNull();
    const initial_sha = skill_cache.extract_compact_source_sha(stored_compact!);
    expect(initial_sha).toBeTruthy();

    // --- 2. Body updated → compact becomes stale ----------------------
    const updated_body = _LARGE_SKILL_BODY.replace("chain-skill\n", "chain-skill (v2)\n");
    const meta2 = skill_cache.store_output(sid, "chain-skill", updated_body);
    expect(meta2).not.toBeNull();
    skill_cache.write_sidecar(meta2!);

    const r_before = await invoke(["skill-list", "--json", "--session-id", sid]);
    expect(r_before.exit_code).toBe(0);
    const data_before = JSON.parse(r_before.stdout) as Record<string, unknown>;
    const rows_before = (data_before["skills"] as Array<Record<string, unknown>>) ?? [];
    expect(rows_before.length).toBeGreaterThan(0);
    expect(rows_before[0]).toHaveProperty("compact_stale");

    // --- 3. skill-compact --all regenerates the stale compact ----------
    const r_all = await invoke(["skill-compact", "--all"]);
    expect(r_all.exit_code).toBe(0);

    // --- 4. skill-list --json now shows compact_stale=False ------------
    const r_after = await invoke(["skill-list", "--json", "--session-id", sid]);
    expect(r_after.exit_code).toBe(0);
    const data_after = JSON.parse(r_after.stdout) as Record<string, unknown>;
    const rows_after = (data_after["skills"] as Array<Record<string, unknown>>) ?? [];
    expect(rows_after.length).toBeGreaterThan(0);
    expect(rows_after[0]!["compact_stale"]).toBe(false);
  });

  it("test_full_chain_manifest_includes_refreshed_compact", async () => {
    vi.spyOn(install, "pregen_skill_compacts").mockReturnValue("0 pre-generated");
    const sid = "chain-manifest-e2e";
    process.env["CLAUDE_SESSION_ID"] = sid;

    fire_skill_hook(sid, "chain-skill", _LARGE_SKILL_BODY);

    const r = await invoke(["skill-compact", "--all"]);
    expect(r.exit_code).toBe(0);

    const m = compact.build_manifest(sid, { max_tokens: 800 });
    expect(m.includes("chain-skill")).toBe(true);
    expect(m.includes("CRITICAL") || m.includes("MUST")).toBe(true);
  });
});
