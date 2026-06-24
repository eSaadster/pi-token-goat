/**
 * Tests for environmental-baseline attribution (`token-goat baseline`) and the
 * once-per-session SessionStart advisory — TS port of tests/test_baseline.py.
 *
 * The integration tests build a synthetic Claude Code session tree under a tmp
 * dir and spy on the two `paths` resolvers the scanners rely on
 * (`claudeProjectsDir` and `claudeConfigDir`) so the scan runs entirely against
 * fixture files of known sizes — no dependence on the real ~/.claude. This is
 * the TS analogue of the Python monkeypatch.setattr(paths, ...).
 *
 * Token assertions exercise the bytes // 4 convention directly (the figure that
 * must reconcile with `token-goat doctor`). Advisory assertions check behaviour
 * — fires above budget, silent below, deduped within a session — not exact
 * wording.
 *
 * Parity divergences from the Python test (architecture, not behaviour):
 *  - The Python advisory reads the budget from the TOKEN_GOAT_BASELINE_BUDGET
 *    _TOKENS env var directly; the TS hooks_session reads it via config.load()
 *    (which itself consults that env var), so the same env-var setenv drives it.
 *  - The Python advisory monkeypatches baseline.collect_baseline; the TS
 *    hooks_session uses an injected _setBaselineModule seam, so the stub is
 *    installed there instead.
 *  - macOS /var -> /private/var symlink: tmp dirs are realpath'd so the
 *    project-dir resolution (which compares resolved paths) matches.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import * as baseline from "../src/token_goat/baseline.js";
import {
  BaselineReport,
  BaselineRow,
  _AVG_SKILL_LISTING_ENTRY_BYTES,
  _memoryIsAlreadyLazy,
  _parseSkillMdFrontmatter,
  _readEnabledPluginNames,
  _readMcpServerNames,
  _skillListingEntryBytes,
  _tallyToolCalls,
  _tokensFromBytes,
  collectBaseline,
  scanTranscriptUsage,
} from "../src/token_goat/baseline.js";
import * as hooksSession from "../src/token_goat/hooks_session.js";
import * as paths from "../src/token_goat/paths.js";

const _SESSION_ID = "sess-0123456789abcdef";

// An identical dump re-fired three times (a per-start "subscription"); content
// carries the "vercel" keyword so owner attribution resolves to plugin:vercel.
const _VERCEL_HEADER = Buffer.from("# Vercel Knowledge Graph\n");
const _VERCEL_DUMP = Buffer.concat([
  _VERCEL_HEADER,
  Buffer.from("v".repeat(4000 - _VERCEL_HEADER.length)),
]);
// A single one-off push; no plugin keyword -> plugin:unknown, kind variable.
const _ONEOFF_HEADER = Buffer.from("# One-off Push\n");
const _ONEOFF_DUMP = Buffer.concat([
  _ONEOFF_HEADER,
  Buffer.from("r".repeat(1000 - _ONEOFF_HEADER.length)),
]);

// ---------------------------------------------------------------------------
// Tmp dir factory (realpath'd for the macOS /var symlink).
// ---------------------------------------------------------------------------

let _tmpDirs: string[] = [];

function makeTmp(): string {
  const d = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "tg-baseline-")));
  _tmpDirs.push(d);
  return d;
}

beforeEach(() => {
  _tmpDirs = [];
});

afterEach(() => {
  vi.restoreAllMocks();
  for (const d of _tmpDirs) {
    try {
      fs.rmSync(d, { recursive: true, force: true });
    } catch {
      // best-effort
    }
  }
  _tmpDirs = [];
});

// ---------------------------------------------------------------------------
// Synthetic session fixture.
// ---------------------------------------------------------------------------

interface SynthSession {
  cwd: string;
  session_id: string;
  tool_results: string;
  projects_root: string;
}

/**
 * Redirect the whole Claude-paths tree at a fake home.
 *
 * Python's test monkeypatched paths.claude_config_dir + paths.claude_projects
 * _dir directly; those Python resolvers call each other through the module
 * global, so one patch flows everywhere. In TS the resolvers call each other via
 * local bindings, so spying claudeConfigDir would NOT propagate to
 * claudeProjectsDir / claudeSkillsDir / claudeSessionToolResultsDir. Instead we
 * spy the single shared root — os.homedir — so every claude* path resolves under
 * <fakeHome>/.claude consistently (more faithful than the per-function patch).
 *
 * Returns the <fakeHome>/.claude directory (the global config dir).
 */
function wireFakeHome(home: string): string {
  vi.spyOn(os, "homedir").mockReturnValue(home);
  return path.join(home, ".claude");
}

/**
 * Build a synthetic session tree and point the path resolvers at it.
 *
 *   <home>/.claude/projects/<slug>/<session>/tool-results/hook-*-stdout.txt
 *   <home>/.claude/projects/<slug>/memory/MEMORY.md  (+ sibling => "already lazy")
 *   <home>/.claude/CLAUDE.md                          (global)
 *   <home>/work/CLAUDE.md                              (project)
 *   <home>/work/.mcp.json                              (2 MCP servers)
 */
function synthSession(): SynthSession {
  const tmp = makeTmp();
  const claudeCfg = wireFakeHome(tmp);
  const projectsRoot = path.join(claudeCfg, "projects");
  const slug = "proj-slug";
  const projDir = path.join(projectsRoot, slug);
  const toolResults = path.join(projDir, _SESSION_ID, "tool-results");
  fs.mkdirSync(toolResults, { recursive: true });

  // Three byte-identical Vercel dumps + one distinct one-off + a non-hook file.
  fs.writeFileSync(path.join(toolResults, "hook-aaaa-stdout.txt"), _VERCEL_DUMP);
  fs.writeFileSync(path.join(toolResults, "hook-bbbb-stdout.txt"), _VERCEL_DUMP);
  fs.writeFileSync(path.join(toolResults, "hook-cccc-stdout.txt"), _VERCEL_DUMP);
  fs.writeFileSync(path.join(toolResults, "hook-dddd-stdout.txt"), _ONEOFF_DUMP);
  fs.writeFileSync(
    path.join(toolResults, "random-tool-output.txt"),
    Buffer.from("z".repeat(9999)),
  );

  // MEMORY.md as an index over a sibling fact file => already lazy.
  const memoryDir = path.join(projDir, "memory");
  fs.mkdirSync(memoryDir, { recursive: true });
  fs.writeFileSync(path.join(memoryDir, "MEMORY.md"), Buffer.from("m".repeat(800)));
  fs.writeFileSync(path.join(memoryDir, "some-fact.md"), Buffer.from("fact"));

  // Global + project CLAUDE.md and a project .mcp.json.
  fs.mkdirSync(claudeCfg, { recursive: true });
  fs.writeFileSync(path.join(claudeCfg, "CLAUDE.md"), Buffer.from("g".repeat(2000)));
  const cwd = path.join(tmp, "work");
  fs.mkdirSync(cwd);
  fs.writeFileSync(path.join(cwd, "CLAUDE.md"), Buffer.from("p".repeat(1200)));
  fs.writeFileSync(
    path.join(cwd, ".mcp.json"),
    JSON.stringify({ mcpServers: { alpha: {}, beta: {} } }),
    "utf-8",
  );

  delete process.env.CLAUDE_SESSION_ID;

  return {
    cwd,
    session_id: _SESSION_ID,
    tool_results: toolResults,
    projects_root: projectsRoot,
  };
}

function rowBy(rows: BaselineRow[], substr: string): BaselineRow {
  const matches = rows.filter((r) =>
    r.source.toLowerCase().includes(substr.toLowerCase()),
  );
  expect(matches.length, `expected exactly one row matching ${substr}`).toBe(1);
  return matches[0]!;
}

// ---------------------------------------------------------------------------
// Costing convention
// ---------------------------------------------------------------------------

describe("_tokensFromBytes matches doctor convention", () => {
  it.each([
    [0, 0],
    [3, 0],
    [4, 1],
    [4000, 1000],
    [-50, 0],
  ])("bytes=%d -> tokens=%d", (nBytes, expected) => {
    expect(_tokensFromBytes(nBytes)).toBe(expected);
  });
});

// ---------------------------------------------------------------------------
// collectBaseline — integration against the synthetic tree
// ---------------------------------------------------------------------------

describe("collectBaseline integration", () => {
  it("dedupes and buckets hook dumps", () => {
    const s = synthSession();
    const report = collectBaseline(s.cwd, s.session_id);

    // Three identical Vercel dumps collapse to ONE row.
    const vercel = rowBy(report.rows, "Vercel Knowledge Graph");
    expect(vercel.owner).toBe("plugin:vercel");
    expect(vercel.fix).toBe("disable-hook");
    expect(vercel.kind).toBe("fixed");
    expect(vercel.n_bytes).toBe(4000);
    expect(vercel.tokens).toBe(1000);
    expect(vercel.detail).toContain("3");

    const oneoff = rowBy(report.rows, "One-off Push");
    expect(oneoff.kind).toBe("variable");
    expect(oneoff.owner).toBe("plugin:unknown");
  });

  it("ignores non-hook files", () => {
    const s = synthSession();
    const report = collectBaseline(s.cwd, s.session_id);
    expect(report.rows.every((r) => r.n_bytes !== 9999)).toBe(true);
  });

  it("emits CLAUDE.md rows", () => {
    const s = synthSession();
    const report = collectBaseline(s.cwd, s.session_id);

    const glob = rowBy(report.rows, "CLAUDE.md (global)");
    expect(glob.owner).toBe("you");
    expect(glob.fix).toBe("slim");
    expect(glob.kind).toBe("fixed");
    expect(glob.n_bytes).toBe(2000);
    expect(glob.tokens).toBe(500);

    const proj = rowBy(report.rows, "CLAUDE.md (project)");
    expect(proj.n_bytes).toBe(1200);
    expect(proj.tokens).toBe(300);
  });

  it("marks an already-lazy MEMORY.md fix=none", () => {
    const s = synthSession();
    const report = collectBaseline(s.cwd, s.session_id);
    const mem = rowBy(report.rows, "MEMORY.md");
    expect(mem.owner).toBe("you");
    expect(mem.kind).toBe("fixed");
    expect(mem.fix).toBe("none");
    expect(mem.detail.toLowerCase()).toContain("index");
  });

  it("emits one 0-token row per MCP server", () => {
    const s = synthSession();
    const report = collectBaseline(s.cwd, s.session_id);
    const alpha = rowBy(report.rows, "MCP: alpha");
    const beta = rowBy(report.rows, "MCP: beta");
    for (const mcp of [alpha, beta]) {
      expect(mcp.owner).toBe("harness");
      expect(mcp.fix).toBe("disable-mcp");
      expect(mcp.tokens).toBe(0);
      expect(mcp.n_bytes).toBe(0);
      expect(mcp.kind).toBe("fixed");
      expect(mcp.detail).toContain("server");
    }
  });

  it("token sums and bucketing reconcile", () => {
    const s = synthSession();
    const report = collectBaseline(s.cwd, s.session_id);

    for (const r of report.rows) {
      expect(r.tokens).toBe(Math.floor(r.n_bytes / 4));
    }
    expect(report.total_tokens).toBe(
      report.rows.reduce((acc, r) => acc + r.tokens, 0),
    );
    expect(report.fixed_tokens).toBe(
      report.rows.filter((r) => r.kind === "fixed").reduce((a, r) => a + r.tokens, 0),
    );
    // The variable one-off is excluded from the fixed total.
    expect(report.fixed_tokens).toBe(
      report.total_tokens - _tokensFromBytes(_ONEOFF_DUMP.length),
    );
  });

  it("sorts rows by tokens descending", () => {
    const s = synthSession();
    const report = collectBaseline(s.cwd, s.session_id);
    const tokens = report.rows.map((r) => r.tokens);
    const sorted = [...tokens].sort((a, b) => b - a);
    expect(tokens).toEqual(sorted);
  });

  it("reports session and points to the doctor", () => {
    const s = synthSession();
    const report = collectBaseline(s.cwd, s.session_id);
    expect(report.session_id).toBe(_SESSION_ID);
    expect(report.tool_results_available).toBe(true);
    expect(report.notes.some((n) => n.includes("doctor"))).toBe(true);
    expect(
      report.rows.some((r) => r.source.toLowerCase().includes("skill catalog")),
    ).toBe(false);
  });

  it("notes unavailable when no session resolves", () => {
    const tmp = makeTmp();
    const claudeCfg = wireFakeHome(tmp);
    fs.mkdirSync(path.join(claudeCfg, "projects"), { recursive: true });
    delete process.env.CLAUDE_SESSION_ID;

    const report = collectBaseline(path.join(tmp, "work"));
    expect(report.tool_results_available).toBe(false);
    expect(report.session_id).toBeNull();
    expect(report.notes.some((n) => n.includes("tool-results"))).toBe(true);
  });

  it("round-trips as JSON", () => {
    const s = synthSession();
    const report = collectBaseline(s.cwd, s.session_id);
    const blob = JSON.stringify(report.as_dict());
    const parsed = JSON.parse(blob);
    expect(parsed.session_id).toBe(_SESSION_ID);
    expect(parsed.fixed_tokens).toBe(report.fixed_tokens);
    expect(parsed.rows.length).toBe(report.rows.length);
  });
});

// ---------------------------------------------------------------------------
// formatReport — the subagent view excludes variable rows
// ---------------------------------------------------------------------------

describe("formatReport", () => {
  it("subagent view excludes variable rows", () => {
    const s = synthSession();
    const report = collectBaseline(s.cwd, s.session_id);

    const full = baseline.formatReport(report, { subagent: false }).join("\n");
    const sub = baseline.formatReport(report, { subagent: true }).join("\n");

    expect(full).toContain("Vercel Knowledge Graph");
    expect(sub).toContain("Vercel Knowledge Graph");
    expect(full).toContain("One-off Push");
    expect(sub).not.toContain("One-off Push");
  });
});

// ---------------------------------------------------------------------------
// _memoryIsAlreadyLazy
// ---------------------------------------------------------------------------

describe("_memoryIsAlreadyLazy", () => {
  it("true with a sibling .md", () => {
    const tmp = makeTmp();
    fs.writeFileSync(path.join(tmp, "MEMORY.md"), "index");
    fs.writeFileSync(path.join(tmp, "a-fact.md"), "fact");
    expect(_memoryIsAlreadyLazy(path.join(tmp, "MEMORY.md"))).toBe(true);
  });

  it("false when alone", () => {
    const tmp = makeTmp();
    fs.writeFileSync(path.join(tmp, "MEMORY.md"), "everything inline");
    expect(_memoryIsAlreadyLazy(path.join(tmp, "MEMORY.md"))).toBe(false);
  });

  it("non-lazy MEMORY.md uses lazy-load fix", () => {
    const tmp = makeTmp();
    const claudeCfg = wireFakeHome(tmp);
    const projectsRoot = path.join(claudeCfg, "projects");
    const proj = path.join(projectsRoot, "slug");
    const tr = path.join(proj, _SESSION_ID, "tool-results");
    fs.mkdirSync(tr, { recursive: true });
    fs.mkdirSync(path.join(proj, "memory"), { recursive: true });
    fs.writeFileSync(path.join(proj, "memory", "MEMORY.md"), Buffer.from("x".repeat(400)));
    delete process.env.CLAUDE_SESSION_ID;

    const report = collectBaseline(path.join(tmp, "work"), _SESSION_ID);
    const mem = rowBy(report.rows, "MEMORY.md");
    expect(mem.fix).toBe("lazy-load");
  });
});

// ---------------------------------------------------------------------------
// _readMcpServerNames — both config shapes
// ---------------------------------------------------------------------------

describe("_readMcpServerNames", () => {
  it("project shape", () => {
    const tmp = makeTmp();
    const p = path.join(tmp, ".mcp.json");
    fs.writeFileSync(p, JSON.stringify({ mcpServers: { a: {}, b: {} } }), "utf-8");
    expect(_readMcpServerNames(p).sort()).toEqual(["a", "b"]);
  });

  it("user shape with projects", () => {
    const tmp = makeTmp();
    const p = path.join(tmp, ".claude.json");
    fs.writeFileSync(
      p,
      JSON.stringify({
        mcpServers: { x: {} },
        projects: { "/p": { mcpServers: { y: {} } } },
      }),
      "utf-8",
    );
    expect(_readMcpServerNames(p).sort()).toEqual(["x", "y"]);
  });

  it("malformed and missing", () => {
    const tmp = makeTmp();
    const bad = path.join(tmp, "bad.json");
    fs.writeFileSync(bad, "{not valid json", "utf-8");
    expect(_readMcpServerNames(bad)).toEqual([]);
    expect(_readMcpServerNames(path.join(tmp, "does-not-exist.json"))).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// paths helpers backing the feature
// ---------------------------------------------------------------------------

describe("paths helpers", () => {
  it("rejects unsafe session ids", () => {
    expect(paths.claudeSessionToolResultsDir("")).toBeUndefined();
    expect(paths.claudeSessionToolResultsDir("..")).toBeUndefined();
    expect(paths.claudeSessionToolResultsDir("a/b")).toBeUndefined();
    expect(paths.claudeSessionToolResultsDir("a\\b")).toBeUndefined();
    expect(paths.claudeSessionToolResultsDir("a\x00b")).toBeUndefined();
  });

  it("finds the owning project", () => {
    const tmp = makeTmp();
    const claudeCfg = wireFakeHome(tmp);
    const projectsRoot = path.join(claudeCfg, "projects");
    const tr = path.join(projectsRoot, "some-slug", _SESSION_ID, "tool-results");
    fs.mkdirSync(tr, { recursive: true });
    expect(paths.claudeSessionToolResultsDir(_SESSION_ID)).toBe(tr);
    expect(paths.claudeSessionToolResultsDir("no-such-session")).toBeUndefined();
  });

  it("baseline advisory sent path is stable and under sentinels", () => {
    const a = paths.baselineAdvisorySentPath(_SESSION_ID);
    const b = paths.baselineAdvisorySentPath(_SESSION_ID);
    expect(a).toBe(b);
    expect(path.dirname(a)).toBe(paths.sentinelsDir());
    expect(path.basename(a)).toContain(_SESSION_ID);
  });
});

// ---------------------------------------------------------------------------
// SessionStart advisory — _maybe_baseline_advisory
// ---------------------------------------------------------------------------

/** Force the injected baseline module to report a controlled fixed-token total. */
function stubFixed(fixedTokens: number): void {
  hooksSession._setBaselineModule({
    collect_baseline(_base: string, sessionId: string) {
      const row = new BaselineRow({
        source: "stub",
        n_bytes: fixedTokens * 4,
        tokens: fixedTokens,
        owner: "you",
        fix: "slim",
        kind: "fixed",
      });
      const report = new BaselineReport({
        rows: [row],
        window_tokens: 200_000,
        session_id: sessionId,
        tool_results_available: true,
        notes: [],
      });
      return { fixed_tokens: report.fixed_tokens };
    },
  });
}

describe("SessionStart advisory", () => {
  it("silent when budget unset", () => {
    delete process.env.TOKEN_GOAT_BASELINE_BUDGET_TOKENS;
    stubFixed(50_000);
    expect(hooksSession._maybe_baseline_advisory(_SESSION_ID, null)).toBeNull();
  });

  it("silent below budget", () => {
    process.env.TOKEN_GOAT_BASELINE_BUDGET_TOKENS = "10000";
    stubFixed(50);
    try {
      expect(hooksSession._maybe_baseline_advisory(_SESSION_ID, null)).toBeNull();
    } finally {
      delete process.env.TOKEN_GOAT_BASELINE_BUDGET_TOKENS;
    }
  });

  it("fires once above budget then dedupes", () => {
    process.env.TOKEN_GOAT_BASELINE_BUDGET_TOKENS = "100";
    stubFixed(5000);
    try {
      const first = hooksSession._maybe_baseline_advisory(_SESSION_ID, null);
      expect(first).not.toBeNull();
      expect(first!.includes("\n")).toBe(false);
      expect(first).toContain("token-goat baseline");
      expect(fs.existsSync(paths.baselineAdvisorySentPath(_SESSION_ID))).toBe(true);
      expect(hooksSession._maybe_baseline_advisory(_SESSION_ID, null)).toBeNull();
    } finally {
      delete process.env.TOKEN_GOAT_BASELINE_BUDGET_TOKENS;
    }
  });

  it("requires a session id", () => {
    process.env.TOKEN_GOAT_BASELINE_BUDGET_TOKENS = "100";
    stubFixed(5000);
    try {
      expect(hooksSession._maybe_baseline_advisory(null, null)).toBeNull();
    } finally {
      delete process.env.TOKEN_GOAT_BASELINE_BUDGET_TOKENS;
    }
  });
});

// ---------------------------------------------------------------------------
// _parseSkillMdFrontmatter
// ---------------------------------------------------------------------------

describe("_parseSkillMdFrontmatter", () => {
  it("full frontmatter", () => {
    const tmp = makeTmp();
    const skillMd = path.join(tmp, "SKILL.md");
    fs.writeFileSync(
      skillMd,
      '---\nname: ralph\nversion: "7"\ndescription: A rapid iteration framework\n---\n\n# Body\n',
      "utf-8",
    );
    const [name, desc] = _parseSkillMdFrontmatter(skillMd);
    expect(name).toBe("ralph");
    expect(desc).toContain("rapid iteration");
  });

  it("multiline description", () => {
    const tmp = makeTmp();
    const skillMd = path.join(tmp, "SKILL.md");
    fs.writeFileSync(
      skillMd,
      "---\nname: foo\ndescription: |\n  First line of desc.\n  Second line.\n---\n",
      "utf-8",
    );
    const [name, desc] = _parseSkillMdFrontmatter(skillMd);
    expect(name).toBe("foo");
    expect(desc).toContain("First line");
  });

  it("no frontmatter", () => {
    const tmp = makeTmp();
    const skillMd = path.join(tmp, "SKILL.md");
    fs.writeFileSync(skillMd, "# No frontmatter here\n\nBody text.\n", "utf-8");
    expect(_parseSkillMdFrontmatter(skillMd)).toEqual(["", ""]);
  });

  it("missing file", () => {
    const tmp = makeTmp();
    expect(_parseSkillMdFrontmatter(path.join(tmp, "SKILL.md"))).toEqual(["", ""]);
  });
});

// ---------------------------------------------------------------------------
// _skillListingEntryBytes
// ---------------------------------------------------------------------------

describe("_skillListingEntryBytes", () => {
  it("with frontmatter", () => {
    const tmp = makeTmp();
    const skillDir = path.join(tmp, "ralph");
    fs.mkdirSync(skillDir);
    fs.writeFileSync(
      path.join(skillDir, "SKILL.md"),
      "---\nname: ralph\ndescription: A rapid iteration framework\n---\n",
      "utf-8",
    );
    const n = _skillListingEntryBytes(skillDir);
    expect(n).toBeGreaterThan(0);
  });

  it("fallback when no SKILL.md", () => {
    const tmp = makeTmp();
    const skillDir = path.join(tmp, "unnamed");
    fs.mkdirSync(skillDir);
    expect(_skillListingEntryBytes(skillDir)).toBe(_AVG_SKILL_LISTING_ENTRY_BYTES);
  });
});

// ---------------------------------------------------------------------------
// _readEnabledPluginNames
// ---------------------------------------------------------------------------

describe("_readEnabledPluginNames", () => {
  it("returns true keys", () => {
    const tmp = makeTmp();
    const settings = path.join(tmp, "settings.json");
    fs.writeFileSync(
      settings,
      '{"enabledPlugins": {"foo@market": true, "bar@market": false, "baz@market": true}}',
      "utf-8",
    );
    expect(_readEnabledPluginNames(settings).sort()).toEqual([
      "baz@market",
      "foo@market",
    ]);
  });

  it("missing file", () => {
    const tmp = makeTmp();
    expect(_readEnabledPluginNames(path.join(tmp, "no-settings.json"))).toEqual([]);
  });

  it("malformed", () => {
    const tmp = makeTmp();
    const settings = path.join(tmp, "settings.json");
    fs.writeFileSync(settings, "not json", "utf-8");
    expect(_readEnabledPluginNames(settings)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// _scanSkillListing via collectBaseline
// ---------------------------------------------------------------------------

describe("_scanSkillListing", () => {
  it("no skills dir adds a note", () => {
    const s = synthSession();
    const report = collectBaseline(s.cwd, s.session_id);
    expect(report.rows.some((r) => r.source.includes("Skill listing"))).toBe(false);
    expect(report.notes.some((n) => n.toLowerCase().includes("skill"))).toBe(true);
  });

  it("row added when skills exist", () => {
    const tmp = makeTmp();
    const claudeCfg = wireFakeHome(tmp);
    const skillsDir = path.join(claudeCfg, "skills");
    for (const skillName of ["ralph", "superman"]) {
      const sd = path.join(skillsDir, skillName);
      fs.mkdirSync(sd, { recursive: true });
      fs.writeFileSync(
        path.join(sd, "SKILL.md"),
        `---\nname: ${skillName}\ndescription: ${skillName} skill desc\n---\n`,
        "utf-8",
      );
    }
    fs.mkdirSync(path.join(claudeCfg, "projects"), { recursive: true });
    delete process.env.CLAUDE_SESSION_ID;

    const cwd = path.join(tmp, "work");
    fs.mkdirSync(cwd);

    const report = collectBaseline(cwd);
    const skillRow = rowBy(report.rows, "Skill listing");
    expect(skillRow.tokens).toBeGreaterThan(0);
    expect(skillRow.tokens).toBe(Math.floor(skillRow.n_bytes / 4));
    expect(skillRow.owner).toBe("you");
    expect(skillRow.fix).toBe("archive-unused");
    expect(skillRow.kind).toBe("fixed");
    expect(skillRow.source).toContain("2");
    expect(skillRow.detail).toContain("user");
  });

  it("usage annotation", () => {
    const tmp = makeTmp();
    const claudeCfg = wireFakeHome(tmp);
    const skillsDir = path.join(claudeCfg, "skills");
    for (const skillName of ["ralph", "superman", "unused-skill"]) {
      const sd = path.join(skillsDir, skillName);
      fs.mkdirSync(sd, { recursive: true });
      fs.writeFileSync(
        path.join(sd, "SKILL.md"),
        `---\nname: ${skillName}\ndescription: desc\n---\n`,
        "utf-8",
      );
    }
    fs.mkdirSync(path.join(claudeCfg, "projects"), { recursive: true });
    delete process.env.CLAUDE_SESSION_ID;

    const cwd = path.join(tmp, "work");
    fs.mkdirSync(cwd);

    const skillUsage = { ralph: 5, superman: 2 };
    vi.spyOn(baseline, "scanTranscriptUsage").mockReturnValue([skillUsage, {}]);
    const report = collectBaseline(cwd, null, { usage: true });

    const skillRow = rowBy(report.rows, "Skill listing");
    expect(skillRow.detail).toContain("2/3");
    expect(skillRow.detail).toContain("unused-skill");
  });
});

// ---------------------------------------------------------------------------
// _tallyToolCalls + scanTranscriptUsage
// ---------------------------------------------------------------------------

describe("_tallyToolCalls", () => {
  it("counts skill invocations", () => {
    const skillCounts: Record<string, number> = {};
    const mcpCounts: Record<string, number> = {};
    const line =
      '{"message": {"content": [{"type": "tool_use", "name": "Skill", "input": {"skill": "ralph"}}]}}';
    _tallyToolCalls(line, skillCounts, mcpCounts);
    expect(skillCounts).toEqual({ ralph: 1 });
    expect(mcpCounts).toEqual({});
  });

  it("counts mcp invocations", () => {
    const skillCounts: Record<string, number> = {};
    const mcpCounts: Record<string, number> = {};
    const line =
      '{"message": {"content": [{"type": "tool_use", "name": "mcp__vercel__deploy", "input": {}}]}}';
    _tallyToolCalls(line, skillCounts, mcpCounts);
    expect(mcpCounts).toEqual({ vercel: 1 });
    expect(skillCounts).toEqual({});
  });

  it("ignores non-tool_use blocks", () => {
    const skillCounts: Record<string, number> = {};
    const mcpCounts: Record<string, number> = {};
    const line =
      '{"message": {"content": [{"type": "text", "text": "Skill mcp__ just some text"}]}}';
    _tallyToolCalls(line, skillCounts, mcpCounts);
    expect(skillCounts).toEqual({});
    expect(mcpCounts).toEqual({});
  });

  it("ignores malformed json", () => {
    const skillCounts: Record<string, number> = {};
    const mcpCounts: Record<string, number> = {};
    _tallyToolCalls("not json at all", skillCounts, mcpCounts);
    expect(skillCounts).toEqual({});
    expect(mcpCounts).toEqual({});
  });
});

describe("scanTranscriptUsage", () => {
  it("reads jsonl", () => {
    const tmp = makeTmp();
    const proj = path.join(tmp, "projects", "slug", "sess-abc");
    fs.mkdirSync(proj, { recursive: true });
    const jsonl = path.join(proj, "transcript.jsonl");
    fs.writeFileSync(
      jsonl,
      '{"message": {"content": [{"type": "tool_use", "name": "Skill", "input": {"skill": "ralph"}}]}}\n' +
        '{"message": {"content": [{"type": "tool_use", "name": "Skill", "input": {"skill": "ralph"}}]}}\n' +
        '{"message": {"content": [{"type": "tool_use", "name": "mcp__stripe__charge", "input": {}}]}}\n',
      "utf-8",
    );
    const [skillCounts, mcpCounts] = scanTranscriptUsage(path.join(tmp, "projects"));
    expect(skillCounts["ralph"]).toBe(2);
    expect(mcpCounts["stripe"]).toBe(1);
  });

  it("missing root returns empty", () => {
    const tmp = makeTmp();
    const [skillCounts, mcpCounts] = scanTranscriptUsage(path.join(tmp, "no-such-dir"));
    expect(skillCounts).toEqual({});
    expect(mcpCounts).toEqual({});
  });
});

describe("collectBaseline MCP usage annotation", () => {
  it("annotates used vs zero-use servers", () => {
    const tmp = makeTmp();
    const claudeCfg = wireFakeHome(tmp);
    fs.mkdirSync(claudeCfg, { recursive: true });
    const cwd = path.join(tmp, "work");
    fs.mkdirSync(cwd);
    fs.writeFileSync(
      path.join(cwd, ".mcp.json"),
      '{"mcpServers": {"used-server": {}, "zero-server": {}}}',
      "utf-8",
    );
    fs.mkdirSync(path.join(claudeCfg, "projects"), { recursive: true });
    delete process.env.CLAUDE_SESSION_ID;

    const mcpUsage = { used_server: 3 }; // normalised: "used-server" -> "used_server"
    vi.spyOn(baseline, "scanTranscriptUsage").mockReturnValue([{}, mcpUsage]);
    const report = collectBaseline(cwd, null, { usage: true });

    const used = rowBy(report.rows, "MCP: used-server");
    const zero = rowBy(report.rows, "MCP: zero-server");
    expect(used.detail.includes("3") || used.detail.includes("calls")).toBe(true);
    expect(zero.detail).toContain("removal candidate");
  });
});
