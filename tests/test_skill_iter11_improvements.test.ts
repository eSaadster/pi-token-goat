/**
 * Faithful TS port of tests/test_skill_iter11_improvements.py.
 *
 * Covers:
 * 1. Pre-read hook path normalization for nested subdir layout
 *    (hooks_read._detect_skill_name_from_path).
 * 2. hooks_skill._resolve_skill_body_path handles nested subdir layout.
 * 3. hooks_skill.post_skill accepts alternative field names (skillName, name).
 * 4. Doctor compact coverage ratio guard (unit test of the ratio math).
 *
 * Porting notes:
 *  - Python `monkeypatch.setattr("token_goat.hooks_skill.Path.home", lambda: tmp)`
 *    -> override process.env.HOME for the duration of the call. hooks_skill
 *    resolves the home root via `os.homedir()` (an `import * as os` namespace
 *    whose `homedir` property is non-configurable and therefore NOT spyable);
 *    Node's POSIX `os.homedir()` honours $HOME, so setting process.env.HOME is
 *    the faithful, working equivalent of the Python home patch on this platform.
 *  - Python `patch("token_goat.hooks_read.load_session_safe", ...)` ->
 *    vi.spyOn(hooks_common, "load_session_safe"). hooks_read imports
 *    load_session_safe from hooks_common as a live ESM binding, so spying the
 *    hooks_common export is observed inside pre_read.
 *  - hooks_read.pre_read is ASYNC in the TS port (returns Promise); awaited here.
 *  - session.lookup_skill_entry / mark_skill_loaded and skill_cache.store_output
 *    / get_compact are spied on their module namespaces (post_skill reaches
 *    skill_cache via a seam that defaults to the real module object).
 *  - mark_skill_loaded is positional in TS (skill_name is arg index 1), unlike
 *    the Python `_mark(**kw)`; the capture reads the 2nd positional arg.
 *  - `f"{ratio:.0%}"` -> `${Math.round(ratio * 100)}%`.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import * as hooks_read from "../src/token_goat/hooks_read.js";
import * as hooks_skill from "../src/token_goat/hooks_skill.js";
import * as hooks_common from "../src/token_goat/hooks_common.js";
import * as session from "../src/token_goat/session.js";
import * as skill_cache from "../src/token_goat/skill_cache.js";
import { SkillEntry } from "../src/token_goat/session.js";
import type { HookPayload, HookResponse } from "../src/token_goat/types.js";

afterEach(() => {
  vi.restoreAllMocks();
});

/** Make a per-test temporary directory (realpath-resolved for macOS /var). */
function mkTmp(): string {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "iter11-")));
}

/**
 * Run *fn* with process.env.HOME temporarily set to *home* (the working
 * equivalent of monkeypatch.setattr("...Path.home", lambda: home), since
 * os.homedir() on POSIX honours $HOME and the os namespace homedir cannot be
 * spied). Restores the prior HOME afterwards.
 */
function withHome<T>(home: string, fn: () => T): T {
  const prev = process.env.HOME;
  process.env.HOME = home;
  try {
    return fn();
  } finally {
    if (prev === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = prev;
    }
  }
}

// ---------------------------------------------------------------------------
// Improvement 1: nested subdir path detection in _detect_skill_name_from_path
// ---------------------------------------------------------------------------

describe("TestNestedSubdirPathDetection", () => {
  it("test_nested_subdir_standard_skill", () => {
    const result = hooks_read._detect_skill_name_from_path(
      "/home/user/.claude/skills/brainstorming/brainstorming/SKILL.md",
    );
    expect(result).toBe("brainstorming");
  });

  it("test_nested_subdir_improve_skill", () => {
    const result = hooks_read._detect_skill_name_from_path(
      "/home/user/.claude/skills/improve/improve/SKILL.md",
    );
    expect(result).toBe("improve");
  });

  it("test_nested_subdir_windows_backslash", () => {
    const result = hooks_read._detect_skill_name_from_path(
      "C:\\Users\\user\\.claude\\skills\\improve\\improve\\SKILL.md",
    );
    expect(result).toBe("improve");
  });

  it("test_nested_subdir_hyphenated_name", () => {
    const result = hooks_read._detect_skill_name_from_path(
      "/home/user/.claude/skills/agent-memory-mcp/agent-memory-mcp/SKILL.md",
    );
    expect(result).toBe("agent-memory-mcp");
  });

  it("test_standard_layouts_still_work", () => {
    expect(
      hooks_read._detect_skill_name_from_path(
        "/home/user/.claude/skills/ralph/SKILL.md",
      ),
    ).toBe("ralph");
    expect(
      hooks_read._detect_skill_name_from_path(
        "/home/user/.claude/skills/improve.md",
      ),
    ).toBe("improve");
    expect(
      hooks_read._detect_skill_name_from_path(
        "C:\\Users\\user\\.claude\\skills\\ralph\\SKILL.md",
      ),
    ).toBe("ralph");
  });

  it("test_non_skill_files_return_none", () => {
    expect(
      hooks_read._detect_skill_name_from_path("/home/user/.claude/settings.json"),
    ).toBeNull();
    expect(
      hooks_read._detect_skill_name_from_path("/home/user/project/src/main.py"),
    ).toBeNull();
    expect(hooks_read._detect_skill_name_from_path("")).toBeNull();
  });

  it("test_marketplace_layout_unaffected", () => {
    const result = hooks_read._detect_skill_name_from_path(
      "/home/user/.claude/plugins/cache/registry.example.com/myplugin/1.0.0/skills/ralph/SKILL.md",
    );
    expect(result).toBe("ralph");
  });

  it("test_hint_emitted_for_nested_path", async () => {
    const sid = "iter11-nested-path-hint";
    // Load a mock skill entry into session for 'brainstorming'.
    const entry = new SkillEntry({
      skill_name: "brainstorming",
      output_id: "abc-brainstorming-000",
      content_sha: "abc123",
      ts: 1000.0,
      body_bytes: 20000,
    });
    vi.spyOn(session, "lookup_skill_entry").mockImplementation(
      (_sid: string, name: string) => (name === "brainstorming" ? entry : null),
    );

    const nested_path =
      "/home/user/.claude/skills/brainstorming/brainstorming/SKILL.md";

    const _read_payload = (sid_: string, fp: string): HookPayload =>
      ({
        session_id: sid_,
        tool_name: "Read",
        tool_input: { file_path: fp },
      }) as unknown as HookPayload;

    // Mock cache with the skill entry and hint-fingerprint stubs.
    const mock_cache = {
      skill_history: { brainstorming: entry },
      has_hint_fingerprint: (_: string) => false,
      mark_hint_seen: (_: string) => undefined,
    };

    vi.spyOn(hooks_common, "load_session_safe").mockReturnValue(
      mock_cache as never,
    );

    const resp: HookResponse = await hooks_read.pre_read(
      _read_payload(sid, nested_path),
    );

    const hook_out =
      (resp as Record<string, unknown>)["hookSpecificOutput"] ?? {};
    const ctx =
      typeof hook_out === "object" && hook_out !== null
        ? String((hook_out as Record<string, unknown>)["additionalContext"] ?? "")
        : "";
    expect(ctx.includes("skill-body")).toBe(true);
    expect(ctx.includes("brainstorming")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Improvement 2: _resolve_skill_body_path checks nested subdir layout
// ---------------------------------------------------------------------------

describe("TestResolveSkillBodyPathNestedLayout", () => {
  it("test_nested_subdir_candidate_included", () => {
    const tmp_path = mkTmp();
    const skills_dir = path.join(
      tmp_path,
      ".claude",
      "skills",
      "brainstorming",
      "brainstorming",
    );
    fs.mkdirSync(skills_dir, { recursive: true });
    fs.writeFileSync(
      path.join(skills_dir, "SKILL.md"),
      "# Brainstorming skill body",
      "utf-8",
    );

    const result = withHome(tmp_path, () =>
      hooks_skill._resolve_skill_body_path("brainstorming"),
    );
    expect(result).not.toBe("");
    expect(result.replace(/\\/g, "/").toLowerCase().includes("brainstorming")).toBe(
      true,
    );
  });

  it("test_standard_layout_still_preferred", () => {
    const tmp_path = mkTmp();
    const standard_dir = path.join(tmp_path, ".claude", "skills", "ralph");
    fs.mkdirSync(standard_dir, { recursive: true });
    fs.writeFileSync(
      path.join(standard_dir, "SKILL.md"),
      "# Ralph standard layout",
      "utf-8",
    );

    const nested_dir = path.join(tmp_path, ".claude", "skills", "ralph", "ralph");
    fs.mkdirSync(nested_dir, { recursive: true });
    fs.writeFileSync(
      path.join(nested_dir, "SKILL.md"),
      "# Ralph nested layout",
      "utf-8",
    );

    const result = withHome(tmp_path, () =>
      hooks_skill._resolve_skill_body_path("ralph"),
    );
    expect(result).not.toBe("");
    const normalized = result.replace(/\\/g, "/");
    expect(normalized.endsWith("ralph/SKILL.md")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Improvement 3: post_skill accepts alternative skill name field names
// ---------------------------------------------------------------------------

function _make_post_skill_payload(
  tool_input: Record<string, unknown>,
  output_text = "# skill body ".repeat(50),
): HookPayload {
  return {
    tool_name: "Skill",
    session_id: "iter11-fieldname-test",
    tool_input,
    tool_response: { output: output_text },
  } as unknown as HookPayload;
}

describe("TestPostSkillAlternativeFieldNames", () => {
  /**
   * Shared helper: run post_skill and return the list of captured skill names.
   * setup.ts already isolates data_dir per test (== Python tmp_data_dir).
   */
  function _run_post_skill_and_capture_name(
    tool_input: Record<string, unknown>,
    skill_name: string,
  ): string[] {
    const captured_names: string[] = [];

    vi.spyOn(session, "lookup_skill_entry").mockReturnValue(null);

    // mark_skill_loaded is positional in TS; skill_name is the 2nd arg.
    vi.spyOn(session, "mark_skill_loaded").mockImplementation(
      ((...args: unknown[]) => {
        captured_names.push(String(args[1] ?? ""));
        return undefined as never;
      }) as never,
    );

    const fakeMeta = {
      output_id: `sid-${skill_name}-abc`,
      skill_name,
      content_sha: "abc",
      ts: 1.0,
      body_bytes: 500,
      truncated: false,
      source_path: "",
    };
    vi.spyOn(skill_cache, "store_output").mockReturnValue(fakeMeta as never);
    vi.spyOn(skill_cache, "get_compact").mockReturnValue(null);

    const payload = _make_post_skill_payload(tool_input);
    const resp: HookResponse = hooks_skill.post_skill(payload);

    expect(resp.continue).toBe(true);
    return captured_names;
  }

  it("test_skill_field_standard", () => {
    const names = _run_post_skill_and_capture_name({ skill: "ralph" }, "ralph");
    expect(names.includes("ralph")).toBe(true);
  });

  it("test_skillname_camelcase_field", () => {
    const names = _run_post_skill_and_capture_name(
      { skillName: "ralph" },
      "ralph",
    );
    expect(names.includes("ralph")).toBe(true);
  });

  it("test_name_field_fallback", () => {
    const names = _run_post_skill_and_capture_name(
      { name: "improve" },
      "improve",
    );
    expect(names.includes("improve")).toBe(true);
  });

  it("test_missing_all_fields_skips_gracefully", () => {
    const payload = _make_post_skill_payload({});
    const resp: HookResponse = hooks_skill.post_skill(payload);
    expect(resp.continue).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Improvement 4: compact coverage ratio guard (unit test)
// ---------------------------------------------------------------------------

describe("TestCompactCoverageRatioGuard", () => {
  it("test_ratio_below_threshold_flags_warning", () => {
    const body_size = 30_000;
    const compact_size = 1_000;

    const ratio = compact_size / body_size;
    expect(ratio < 0.2).toBe(true);
  });

  it("test_ratio_above_threshold_is_healthy", () => {
    const body_size = 10_000;
    const compact_size = 3_000;

    const ratio = compact_size / body_size;
    expect(ratio >= 0.2).toBe(true);
  });

  it("test_ratio_edge_exactly_twenty_percent", () => {
    const body_size = 10_000;
    const compact_size = 2_000;

    const ratio = compact_size / body_size;
    expect(ratio).toBe(0.2);
    expect(ratio < 0.2).toBe(false);
  });

  it("test_zero_compact_is_skipped", () => {
    const compact_size = 0;
    expect(compact_size).toBe(0);
  });

  it("test_zero_body_is_skipped", () => {
    const body_size = 0;
    expect(body_size).toBe(0);
  });

  it("test_ratio_format_string", () => {
    const ratio = 0.133;
    const formatted = `${Math.round(ratio * 100)}%`;
    expect(formatted).toBe("13%");
  });
});
