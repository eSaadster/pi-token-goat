/**
 * Tests for resume.build_resume_packet. 1:1 port of tests/test_resume.py.
 *
 * Exercises the happy path (all four sections), the empty/unavailable-session
 * short-circuits, budget capping, and each section's presence in the output.
 *
 * Test-seam mapping (Python -> TS):
 *  - patch("token_goat.session.load", ...)
 *      -> vi.spyOn(session, "load"). build_resume_packet reaches session.load
 *         through the static `import * as session`, so the spy intercepts it.
 *  - patch("token_goat.resume._load_bash_output" / "._inline_diff" /
 *    "._git_diff_stat", ...)
 *      -> vi.spyOn(resume, "<fn>"). resume.ts routes those call sites through a
 *         static `import * as self from "./resume.js"`, so a namespace-level
 *         spy intercepts them (the git_history.ts / bridges.ts self-spy pattern).
 *  - patch("token_goat.skill_cache.load_output" /
 *    ".extract_checklist_section", ...)
 *      -> skill_cache.ts is NOT yet ported. resume.ts mirrors compact.ts with a
 *         _setSkillCacheModule injection seam; the test injects a mock
 *         {load_output, extract_checklist_section} and clears it in afterEach.
 *         This reproduces the patched-module behavior without the real module.
 *  - tmp_data_dir fixture
 *      -> setup.ts's setDataDirOverride gives each test a throwaway data dir;
 *         session reads/writes resolve under it via paths.ts.
 *  - _write_cwd helper (write cache json + pop session._proc_load_cache)
 *      -> writeCwd(): cache.cwd = ...; write to paths.sessionCachePath; delete
 *         the process load-cache entry so the next load sees the new cwd.
 *
 * Every Python `def test_*` maps to a vitest `it()` with the same name and
 * assertion polarity.
 */
import fs from "node:fs";

import { afterEach, describe, expect, it, vi } from "vitest";

import * as session from "../src/token_goat/session.js";
import * as paths from "../src/token_goat/paths.js";
import * as resume from "../src/token_goat/resume.js";
import {
  _MAX_RESUME_CHARS,
  _SKILL_MAX_CHARS_EACH,
  build_resume_packet,
} from "../src/token_goat/resume.js";

// ---------------------------------------------------------------------------
// Helpers.
// ---------------------------------------------------------------------------

/** Add *count* bash entries and return their output_ids. */
function _seed_bash(sid: string, opts: { count?: number } = {}): string[] {
  const count = opts.count ?? 1;
  const ids: string[] = [];
  for (let i = 0; i < count; i++) {
    const sha = `cmd${i.toString(16).padStart(12, "0")}`;
    const oid = `${sha}-output`;
    session.mark_bash_run(
      sid,
      sha, // cmd_sha
      `pytest -v test_${i}.py`, // cmd_preview
      oid, // output_id
      500, // stdout_bytes
      0, // stderr_bytes
      0, // exit_code
      false, // truncated
    );
    ids.push(oid);
  }
  return ids;
}

/** Add a skill entry and return its output_id. */
function _seed_skill(sid: string, name = "ralph"): string {
  const oid = `skill_${name}_out`;
  session.mark_skill_loaded(
    sid,
    name, // skill_name
    oid, // output_id
    "deadbeef", // content_sha
    2000, // body_bytes
    false, // truncated
  );
  return oid;
}

/** Persist a cwd value into the session cache on disk + bust the load cache. */
function _write_cwd(sid: string, cwd: string): void {
  const cache = session.load(sid);
  cache.cwd = cwd;
  const cache_path = paths.sessionCachePath(sid);
  paths.ensureDir(require_dirname(cache_path));
  fs.writeFileSync(cache_path, cache.to_json(), "utf8");
  // Bust the process-local load cache so the next load sees the new cwd.
  session._proc_load_cache.delete(sid);
}

/** Python os.path.dirname for the session cache path. */
function require_dirname(p: string): string {
  const idx = p.lastIndexOf("/");
  return idx >= 0 ? p.slice(0, idx) : ".";
}

/**
 * Inject a mock skill_cache module via the resume.ts seam, mirroring
 * patch("token_goat.skill_cache.load_output" / ".extract_checklist_section").
 */
function patchSkillCache(impl: {
  load_output: (output_id: string) => string | null;
  extract_checklist_section?: (body: string) => string | null;
}): void {
  resume._setSkillCacheModule({
    load_output: impl.load_output,
    extract_checklist_section: impl.extract_checklist_section ?? (() => null),
  });
}

afterEach(() => {
  vi.restoreAllMocks();
  resume._setSkillCacheModule(undefined);
  resume._setBashCacheModule(undefined);
});

// ---------------------------------------------------------------------------
// Empty / unavailable session
// ---------------------------------------------------------------------------

describe("TestEmptySession", () => {
  it("test_unknown_session_returns_empty", () => {
    const result = build_resume_packet("nonexistent-session-id");
    expect(result).toBe("");
  });

  it("test_fresh_session_with_no_history_returns_empty", () => {
    const sid = "fresh-no-history";
    session.load(sid); // creates the session file
    const result = build_resume_packet(sid);
    expect(result).toBe("");
  });

  it("test_session_load_exception_returns_empty", () => {
    // OSError from session.load must not propagate — return '' gracefully.
    vi.spyOn(session, "load").mockImplementation(() => {
      throw new Error("disk full");
    });
    const result = build_resume_packet("boom-sid");
    expect(result).toBe("");
  });

  it("test_unavailable_session_returns_empty", () => {
    // A session that reports unavailable must short-circuit to ''.
    const unavail_cache = { unavailable: true } as unknown as ReturnType<typeof session.load>;
    vi.spyOn(session, "load").mockReturnValue(unavail_cache);
    const result = build_resume_packet("unavail-sid");
    expect(result).toBe("");
  });
});

// ---------------------------------------------------------------------------
// Packet header
// ---------------------------------------------------------------------------

describe("TestPacketHeader", () => {
  it("test_header_contains_session_prefix", () => {
    const sid = "header-test-session-1234";
    _seed_bash(sid);
    const result = build_resume_packet(sid);
    expect(result.startsWith("## Resume")).toBe(true);
    expect(result.includes("header-t")).toBe(true); // first 8 chars of session id
  });

  it("test_header_contains_as_of_time", () => {
    const sid = "hdr-time-session";
    _seed_bash(sid);
    const result = build_resume_packet(sid);
    expect(result.includes("as of")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Bash section
// ---------------------------------------------------------------------------

describe("TestBashSection", () => {
  it("test_bash_section_present", () => {
    const sid = "bash-present-session";
    _seed_bash(sid);
    const result = build_resume_packet(sid);
    expect(result.includes("### Bash outputs")).toBe(true);
  });

  it("test_bash_command_preview_appears", () => {
    const sid = "bash-preview-session";
    _seed_bash(sid);
    const result = build_resume_packet(sid);
    expect(result.includes("pytest -v test_0.py")).toBe(true);
  });

  it("test_bash_output_body_included_when_cache_hit", () => {
    // When bash_cache has the output, its text appears in the packet.
    const sid = "bash-cache-hit-session";
    _seed_bash(sid);
    const fake_output = Array.from({ length: 10 }, (_, i) => `line ${i}`).join("\n");
    vi.spyOn(resume, "_load_bash_output").mockReturnValue(fake_output);
    const result = build_resume_packet(sid);
    expect(result.includes("line 0")).toBe(true);
  });

  it("test_bash_evicted_output_shows_fallback", () => {
    // When _load_bash_output returns None, a 'body evicted' fallback appears.
    const sid = "bash-evicted-session";
    _seed_bash(sid);
    vi.spyOn(resume, "_load_bash_output").mockReturnValue(null);
    const result = build_resume_packet(sid);
    // Either the output_id reference or an "evicted" note must appear.
    expect(result.includes("evicted") || result.includes("bash-output")).toBe(true);
  });

  it("test_bash_head_tail_gap_marker", () => {
    // Long bash outputs get head + gap + tail, not the full text.
    const sid = "bash-headtail-session";
    _seed_bash(sid);
    const many_lines = Array.from({ length: 60 }, (_, i) => `output line ${i}`).join("\n");
    vi.spyOn(resume, "_load_bash_output").mockReturnValue(many_lines);
    const result = build_resume_packet(sid);
    expect(result.includes("lines omitted")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Skill section
// ---------------------------------------------------------------------------

describe("TestSkillSection", () => {
  it("test_skill_section_present_when_checklist_available", () => {
    const sid = "skill-section-session";
    _seed_skill(sid, "ralph");
    const fake_checklist = "## DoD\n- [ ] Tests pass\n- [ ] Lint clean";
    patchSkillCache({
      load_output: () => "full body text",
      extract_checklist_section: () => fake_checklist,
    });
    const result = build_resume_packet(sid);
    expect(result.includes("### Skills")).toBe(true);
    expect(result.includes("ralph")).toBe(true);
  });

  it("test_skill_section_fallback_when_no_body", () => {
    // When skill body is missing, a recall-command fallback appears.
    const sid = "skill-no-body-session";
    _seed_skill(sid, "superman");
    patchSkillCache({ load_output: () => null });
    const result = build_resume_packet(sid);
    expect(result.includes("### Skills")).toBe(true);
    expect(result.includes("superman")).toBe(true);
    expect(result.includes("skill-body")).toBe(true); // recall command hint
  });

  it("test_skill_section_fallback_when_no_checklist", () => {
    // When body exists but checklist extract returns None, fallback appears.
    const sid = "skill-no-checklist-session";
    _seed_skill(sid, "humanizer");
    patchSkillCache({
      load_output: () => "body text",
      extract_checklist_section: () => null,
    });
    const result = build_resume_packet(sid);
    expect(result.includes("### Skills")).toBe(true);
    expect(result.includes("humanizer")).toBe(true);
  });

  it("test_skill_checklist_truncated_at_per_skill_budget", () => {
    // Checklists longer than _SKILL_MAX_CHARS_EACH are truncated with ellipsis.
    const sid = "skill-truncate-session";
    _seed_skill(sid, "ralph");
    const long_checklist = "x".repeat(_SKILL_MAX_CHARS_EACH + 200);
    patchSkillCache({
      load_output: () => "body",
      extract_checklist_section: () => long_checklist,
    });
    const result = build_resume_packet(sid);
    expect(result.includes("…")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Diffs section
// ---------------------------------------------------------------------------

describe("TestDiffsSection", () => {
  it("test_diffs_section_present", () => {
    const sid = "diffs-present-session";
    session.mark_file_edited(sid, "/proj/src/auth.py");
    _write_cwd(sid, "/proj");
    const fake_diff = "- old line\n+ new line";
    vi.spyOn(resume, "_inline_diff").mockReturnValue(fake_diff);
    const result = build_resume_packet(sid);
    expect(result.includes("### Diffs")).toBe(true);
    expect(result.includes("auth.py")).toBe(true);
  });

  it("test_diffs_section_absent_without_cwd", () => {
    // When cwd is None, no diff section is emitted.
    const sid = "diffs-no-cwd-session";
    session.mark_file_edited(sid, "/proj/src/auth.py");
    // cwd stays None (default)
    vi.spyOn(resume, "_inline_diff").mockReturnValue("some diff");
    const result = build_resume_packet(sid);
    expect(result.includes("### Diffs")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Git stat section
// ---------------------------------------------------------------------------

describe("TestGitStatSection", () => {
  it("test_stat_section_present", () => {
    const sid = "stat-present-session";
    _seed_bash(sid);
    _write_cwd(sid, "/proj");
    const fake_stat = " src/auth.py | 3 ++-\n 1 file changed";
    vi.spyOn(resume, "_git_diff_stat").mockReturnValue(fake_stat);
    const result = build_resume_packet(sid);
    expect(result.includes("### Git stat")).toBe(true);
    expect(result.includes("file changed")).toBe(true);
  });

  it("test_stat_section_absent_when_stat_empty", () => {
    // Empty git stat string -> section is silently skipped.
    const sid = "stat-empty-session";
    _seed_bash(sid);
    _write_cwd(sid, "/proj");
    vi.spyOn(resume, "_git_diff_stat").mockReturnValue("");
    const result = build_resume_packet(sid);
    expect(result.includes("### Git stat")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Budget cap
// ---------------------------------------------------------------------------

describe("TestBudgetCap", () => {
  it("test_packet_within_hard_cap", () => {
    const sid = "budget-cap-session";
    _seed_bash(sid, { count: 2 });
    const huge_output = Array.from({ length: 500 }, (_, i) => `out line ${i}`).join("\n");
    vi.spyOn(resume, "_load_bash_output").mockReturnValue(huge_output);
    const result = build_resume_packet(sid);
    expect(result.length).toBeLessThanOrEqual(_MAX_RESUME_CHARS);
  });
});
