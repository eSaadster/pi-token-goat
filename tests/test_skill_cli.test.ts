/**
 * CLI dispatch + behavior tests for cli batch D (skills + doc-compact), covering
 * the 7 commands without a dedicated Python CLI test file of their own:
 * skill-body, skill-compact, skill-history, skill-diff, baseline, compact-doc,
 * skill-list. (skill-size has its own ported file: test_skill_size.test.ts.)
 *
 * Skills are seeded via `_seed` = skill_cache.store_output + write_sidecar (the
 * PostToolUse(Skill) hook does both; skill-body/skill-compact/skill-diff resolve
 * bodies through read_sidecar / lookup_all_by_name, which need the sidecar).
 * CLAUDE_SESSION_ID is cleared per test so skill-compact --all takes the
 * deterministic "no session → scan whole cache" branch. install.pregen_skill_compacts
 * is spied so --all does not scan the real ~/.claude/skills tree.
 */
import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { invoke } from "./_cli_runner.js";
import * as skill_cache from "../src/token_goat/skill_cache.js";
import * as install from "../src/token_goat/install.js";

/** store_output + write_sidecar — mirrors what hooks_skill.post_skill does. */
function _seed(sid: string, name: string, body: string): skill_cache.SkillMeta | null {
  const meta = skill_cache.store_output(sid, name, body);
  if (meta) skill_cache.write_sidecar(meta);
  return meta;
}

let _savedSid: string | undefined;
beforeEach(() => {
  _savedSid = process.env["CLAUDE_SESSION_ID"];
  delete process.env["CLAUDE_SESSION_ID"];
});
afterEach(() => {
  if (_savedSid === undefined) delete process.env["CLAUDE_SESSION_ID"];
  else process.env["CLAUDE_SESSION_ID"] = _savedSid;
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// skill-body
// ---------------------------------------------------------------------------

describe("skill-body", () => {
  it("recalls a cached body (default, text)", async () => {
    _seed("sb-sess-1", "recall-me", "# Recall Me\n\nThe quick brown fox.\n");
    const r = await invoke(["skill-body", "recall-me"]);
    expect(r.exit_code).toBe(0);
    expect(r.stdout).toContain("The quick brown fox.");
  });

  it("emits JSON with --json", async () => {
    _seed("sb-sess-2", "json-skill", "# JSON Skill\n\nbody line one\nbody line two\n");
    const r = await invoke(["skill-body", "json-skill", "--json"]);
    expect(r.exit_code).toBe(0);
    const data = JSON.parse(r.stdout) as Record<string, unknown>;
    expect(data["skill_name"]).toBe("json-skill");
    expect(data).toHaveProperty("text");
    expect(data).toHaveProperty("total_lines");
  });

  it("extracts a single section with --section", async () => {
    const body = "# Skill\n\n## Overview\n\noverview text\n\n## DoD\n\ndod requirement here\n";
    _seed("sb-sess-3", "sectioned", body);
    const r = await invoke(["skill-body", "sectioned", "--section", "DoD"]);
    expect(r.exit_code).toBe(0);
    expect(r.stdout).toContain("dod requirement here");
  });

  it("returns a compact summary with --compact", async () => {
    const body = "# Skill\n\n## Rules\n\n**MUST** do the thing.\nNEVER skip steps.\n";
    _seed("sb-sess-4", "compactable", body);
    const r = await invoke(["skill-body", "compactable", "--compact"]);
    expect(r.exit_code).toBe(0);
    expect(r.stdout).toContain("compact form");
  });

  it("exits 1 for an unknown skill", async () => {
    const r = await invoke(["skill-body", "does-not-exist-anywhere"]);
    expect(r.exit_code).toBe(1);
    expect(r.output).toContain("no cached body");
  });
});

// ---------------------------------------------------------------------------
// skill-compact
// ---------------------------------------------------------------------------

describe("skill-compact", () => {
  it("generates a compact for a cached skill (text)", async () => {
    _seed("sc-sess-1", "to-compact", "# Skill\n\n## DoD\n\n**MUST** pass tests.\n");
    const r = await invoke(["skill-compact", "to-compact"]);
    expect(r.exit_code).toBe(0);
    expect(r.stdout).toContain("compact form");
  });

  it("emits JSON with quality with --json", async () => {
    _seed("sc-sess-2", "to-compact-json", "# Skill\n\n## Rules\n\n**MUST** do X.\n");
    const r = await invoke(["skill-compact", "to-compact-json", "--json"]);
    expect(r.exit_code).toBe(0);
    const data = JSON.parse(r.stdout) as Record<string, unknown>;
    expect(data["skill_name"]).toBe("to-compact-json");
    expect(data["compact"]).toBe(true);
    expect(data).toHaveProperty("compact_quality");
  });

  it("errors when given neither NAME nor --all", async () => {
    const r = await invoke(["skill-compact"]);
    expect(r.exit_code).toBe(1);
    expect(r.output).toContain("Provide a skill NAME");
  });

  it("--all processes cached skills (pregen spied)", async () => {
    vi.spyOn(install, "pregen_skill_compacts").mockReturnValue("0 pre-generated");
    _seed("sc-all-1", "alpha-skill", "# Alpha\n\n## DoD\n\n**MUST** ship.\n");
    const r = await invoke(["skill-compact", "--all"]);
    expect(r.exit_code).toBe(0);
    expect(r.stdout).toContain("Done:");
  });

  it("--all rejects a NAME argument", async () => {
    vi.spyOn(install, "pregen_skill_compacts").mockReturnValue("0 pre-generated");
    const r = await invoke(["skill-compact", "somename", "--all"]);
    expect(r.exit_code).toBe(1);
    expect(r.output).toContain("Cannot combine");
  });
});

// ---------------------------------------------------------------------------
// skill-history
// ---------------------------------------------------------------------------

describe("skill-history", () => {
  it("lists cached bodies (text)", async () => {
    _seed("sh-sess-1", "hist-skill", "# Hist\n\nbody\n");
    const r = await invoke(["skill-history"]);
    expect(r.exit_code).toBe(0);
    expect(r.stdout).toContain("hist-skill");
  });

  it("emits a JSON array with --json", async () => {
    _seed("sh-sess-2", "hist-json", "# Hist JSON\n\nbody\n");
    const r = await invoke(["skill-history", "--json"]);
    expect(r.exit_code).toBe(0);
    const data = JSON.parse(r.stdout) as unknown[];
    expect(Array.isArray(data)).toBe(true);
  });

  it("prints the empty message when nothing is cached", async () => {
    const r = await invoke(["skill-history"]);
    expect(r.exit_code).toBe(0);
    expect(r.stdout).toContain("no cached Skill bodies");
  });
});

// ---------------------------------------------------------------------------
// skill-diff
// ---------------------------------------------------------------------------

describe("skill-diff", () => {
  it("diffs the two most recent cached versions", async () => {
    _seed("sd-1", "difftest", "version one\nshared line\n");
    _seed("sd-2", "difftest", "version two\nshared line\n");
    const r = await invoke(["skill-diff", "difftest"]);
    expect(r.exit_code).toBe(0);
    // Unified diff should contain at least one +/- data line.
    const hasDiff = r.stdout.split("\n").some((ln) => ln.startsWith("+") || ln.startsWith("-"));
    expect(hasDiff).toBe(true);
  });

  it("reports when only one version exists", async () => {
    _seed("sd-only", "single-version", "only body\n");
    const r = await invoke(["skill-diff", "single-version"]);
    expect(r.exit_code).toBe(0);
    expect(r.stdout).toContain("nothing to diff");
  });

  it("exits 1 for an unknown skill", async () => {
    const r = await invoke(["skill-diff", "no-such-skill"]);
    expect(r.exit_code).toBe(1);
    expect(r.output).toContain("no cached versions found");
  });
});

// ---------------------------------------------------------------------------
// skill-list
// ---------------------------------------------------------------------------

describe("skill-list", () => {
  it("lists skills for a session (text)", async () => {
    _seed("sl-sess-1", "list-skill", "# List\n\nbody content here\n");
    const r = await invoke(["skill-list", "--session-id", "sl-sess-1"]);
    expect(r.exit_code).toBe(0);
    expect(r.stdout).toContain("list-skill");
  });

  it("emits JSON with coverage with --json", async () => {
    _seed("sl-sess-2", "list-json", "# List JSON\n\nbody\n");
    const r = await invoke(["skill-list", "--session-id", "sl-sess-2", "--json"]);
    expect(r.exit_code).toBe(0);
    const data = JSON.parse(r.stdout) as Record<string, unknown>;
    expect(data["session_id"]).toBe("sl-sess-2");
    expect(data).toHaveProperty("compact_coverage_pct");
    expect(Array.isArray(data["skills"])).toBe(true);
  });

  it("reports an empty session", async () => {
    const r = await invoke(["skill-list", "--session-id", "empty-session"]);
    expect(r.exit_code).toBe(0);
    expect(r.stdout).toContain("No cached skills for session");
  });
});

// ---------------------------------------------------------------------------
// baseline
// ---------------------------------------------------------------------------

describe("baseline", () => {
  it("runs and produces output (text)", async () => {
    const r = await invoke(["baseline"]);
    expect(r.exit_code).toBe(0);
    expect(r.stdout.length).toBeGreaterThan(0);
  });

  it("emits parseable JSON with --json", async () => {
    const r = await invoke(["baseline", "--json"]);
    expect(r.exit_code).toBe(0);
    const data = JSON.parse(r.stdout) as Record<string, unknown>;
    expect(data).toHaveProperty("session_id");
  });
});

// ---------------------------------------------------------------------------
// compact-doc (guard paths — the happy path is covered by test_doc_compact)
// ---------------------------------------------------------------------------

describe("compact-doc", () => {
  it("exits 1 when the file does not exist", async () => {
    const r = await invoke(["compact-doc", "/no/such/file.md"]);
    expect(r.exit_code).toBe(1);
    expect(r.output).toContain("File not found");
  });

  it("exits 1 for a non-markdown extension", async () => {
    // An existing file with a non-.md extension trips the suffix guard.
    const txt = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "tg-cd-")), "notes.txt");
    fs.writeFileSync(txt, "plain text, not markdown\n");
    const r = await invoke(["compact-doc", txt]);
    expect(r.exit_code).toBe(1);
    expect(r.output.toLowerCase()).toContain("only .md");
  });
});
