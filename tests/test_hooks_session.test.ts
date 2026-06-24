/**
 * Port of the hooks_session-targeting portions of tests/test_hooks_session.py.
 *
 * The Python file mixes tests for several modules. Only the classes that target
 * token_goat.hooks_session are ported here:
 *   - TestSessionStartHookIntegration  (session_start cache reset + auto-index)
 *   - TestSessionBriefSkipsLogOnCleanMain
 *   - TestParseStatusZB
 *   - TestSessionBriefTimeoutReturnsNone
 *   - TestDeferredImports (adapted: compact is a fail-soft seam in TS, so the
 *     "compact not imported on plain startup" invariant is expressed as
 *     "session_start(startup) continues without the compact seam injected")
 *   - TestRecoveryHintPytestCollapse
 *
 * The post_read / dispatch / CLI / pre_compact classes target other modules
 * (hooks_read, hooks_cli, cli, hooks_compact) and are ported with those modules.
 *
 * Test-seam mapping (Python -> TS):
 *  - patch("subprocess.run", side_effect=...) -> vi.spyOn(util, "runGit"). The
 *    ported _build_session_brief / subagent_stop call git via util.runGit.
 *  - monkeypatch.setattr(db, "file_count", throw) -> vi.spyOn(db, "fileCount")
 *    .mockImplementation(throw); auto-index must use the cheap projectHasFiles
 *    probe, never fileCount.
 *  - monkeypatch.setattr(worker, "spawn_index_detached"/"ensure_running") ->
 *    hooks_session._setWorkerModule({...}). worker is not yet ported; the
 *    fail-soft seam stands in for it.
 *  - session.mark_* drive the real ported session cache (tmp data dir per test
 *    via setup.ts).
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import * as util from "../src/token_goat/util.js";
import type { CompletedProcess } from "../src/token_goat/util.js";
import * as session from "../src/token_goat/session.js";
import * as db from "../src/token_goat/db.js";
import * as project from "../src/token_goat/project.js";
import * as hooks_session from "../src/token_goat/hooks_session.js";

function cp(stdout: string, returncode = 0): CompletedProcess {
  return { args: [], stdout, stderr: "", returncode };
}

function tmpdir(): string {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "tg-hs-")));
}

function assertContinue(result: { continue?: boolean }): void {
  expect(result.continue).toBe(true);
}

afterEach(() => {
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// TestSessionStartHookIntegration
// ---------------------------------------------------------------------------
describe("TestSessionStartHookIntegration", () => {
  it("test_session_start_resets_cache", () => {
    const s_id = "hook_s5";
    session.mark_file_read(s_id, "f.py");
    expect(Object.keys(session.load(s_id).files).length).toBeGreaterThan(0);

    // No real worker; inject a no-op seam so _ensure_worker_running stays quiet.
    hooks_session._setWorkerModule({ ensure_running: () => 1, spawn_index_detached: () => 1 });
    const result = hooks_session.session_start({ session_id: s_id, cwd: "/some/path" });
    assertContinue(result);

    const fresh = session.load(s_id);
    expect(fresh.files).toEqual({});
    expect(fresh.greps).toEqual([]);
  });

  it("test_session_start_auto_indexes_without_counting_files", () => {
    const root = tmpdir();
    const proj_root = path.join(root, "proj");
    fs.mkdirSync(proj_root);
    fs.mkdirSync(path.join(proj_root, ".git"));
    const proj = project.find_project(proj_root);
    expect(proj).not.toBeNull();

    // db.fileCount must NOT be called — auto-index uses the cheap presence probe.
    vi.spyOn(db, "fileCount").mockImplementation(() => {
      throw new Error("count called");
    });
    vi.spyOn(db, "projectHasFiles").mockReturnValue(false);
    vi.spyOn(db, "touchProjectLastSeen").mockImplementation(() => {});

    const spawned: Array<[string, string]> = [];
    hooks_session._setWorkerModule({
      ensure_running: () => 99999,
      spawn_index_detached: (root_arg: string, project_hash: string) => {
        spawned.push([root_arg, project_hash]);
        return 4321;
      },
    });

    const result = hooks_session.session_start({ session_id: "hook_s6", cwd: proj_root });
    assertContinue(result);
    expect(spawned).toEqual([[proj!.root, proj!.hash]]);
  });
});

// ---------------------------------------------------------------------------
// TestSessionBriefSkipsLogOnCleanMain
// ---------------------------------------------------------------------------
describe("TestSessionBriefSkipsLogOnCleanMain", () => {
  const REAL_SHA = "a".repeat(40);

  function makeFakeRun(
    branch: string,
    status_out: string,
    local_sha: string,
    origin_sha: string,
  ): (args: string[]) => CompletedProcess {
    const porcelainToZB = (porcelain: string, br: string): string => {
      const header = `## ${br}`;
      const parts = [header];
      for (let line of porcelain.split("\n")) {
        line = line.replace(/\n$/, "");
        if (line) {
          parts.push(line);
        }
      }
      return parts.join("\0") + (parts.length > 1 ? "\0" : "");
    };
    return (args: string[]): CompletedProcess => {
      const cmd_str = args.join(" ");
      if (cmd_str.includes("-z") && cmd_str.includes("-b")) {
        return cp(porcelainToZB(status_out, branch), 0);
      }
      if (cmd_str.includes("rev-parse") && cmd_str.includes("origin/")) {
        return cp(origin_sha + "\n", 0);
      }
      if (cmd_str.includes("rev-parse")) {
        return cp(local_sha + "\n", 0);
      }
      if (cmd_str.includes("log")) {
        return cp("abc1234 some commit\n", 0);
      }
      return cp("", 0);
    };
  }

  it("test_clean_main_synced_to_origin_skips_log", () => {
    vi.spyOn(util, "runGit").mockImplementation(makeFakeRun("main", "", REAL_SHA, REAL_SHA));
    const brief = hooks_session._build_session_brief(tmpdir());
    expect(brief === null || !(brief ?? "").includes("Recent:")).toBe(true);
  });

  it("test_dirty_main_includes_log", () => {
    vi.spyOn(util, "runGit").mockImplementation(
      makeFakeRun("main", " M src/foo.py\n", REAL_SHA, REAL_SHA),
    );
    const brief = hooks_session._build_session_brief(tmpdir());
    expect(brief).not.toBeNull();
    expect(brief!).toContain(" — ");
    expect(brief!).toContain("abc1234");
  });

  it("test_feature_branch_includes_log", () => {
    vi.spyOn(util, "runGit").mockImplementation(
      makeFakeRun("feature/my-branch", "", REAL_SHA, REAL_SHA),
    );
    const brief = hooks_session._build_session_brief(tmpdir());
    expect(brief).not.toBeNull();
    expect(brief!).toContain(" — ");
    expect(brief!).toContain("abc1234");
  });
});

// ---------------------------------------------------------------------------
// TestParseStatusZB
// ---------------------------------------------------------------------------
describe("TestParseStatusZB", () => {
  it("test_clean_repo", () => {
    const [branch, lines, total] = hooks_session._parse_status_z_b("## main...origin/main\0");
    expect(branch).toBe("main");
    expect(lines).toEqual([]);
    expect(total).toBe(0);
  });

  it("test_branch_with_untracked_and_modified", () => {
    const output = "## feature/foo...origin/feature/foo\0?? new_file.py\0 M src/bar.py\0";
    const [branch, lines, total] = hooks_session._parse_status_z_b(output);
    expect(branch).toBe("feature/foo");
    expect(lines.length).toBe(2);
    expect(total).toBe(2);
    expect(lines.some((ln) => ln.startsWith("??"))).toBe(true);
    expect(lines.some((ln) => ln.slice(1, 2) === "M")).toBe(true);
  });

  it("test_detached_head", () => {
    const output = "## HEAD (no branch)\0 M src/foo.py\0";
    const [branch, lines, total] = hooks_session._parse_status_z_b(output);
    expect(branch).toBe("HEAD");
    expect(lines.length).toBe(1);
    expect(total).toBe(1);
  });

  it("test_no_commits_yet", () => {
    const output = "## No commits yet on main\0";
    const [branch, lines, total] = hooks_session._parse_status_z_b(output);
    expect(branch).toBe("main");
    expect(lines).toEqual([]);
    expect(total).toBe(0);
  });

  it("test_capped_at_50_entries_total_reported", () => {
    const entries = Array.from({ length: 80 }, (_v, i) => `?? file${i}.py\0`).join("");
    const output = `## main\0${entries}`;
    const [branch, lines, total] = hooks_session._parse_status_z_b(output);
    expect(branch).toBe("main");
    expect(lines.length).toBe(50);
    expect(total).toBe(80);
  });

  it("test_empty_output", () => {
    const [branch, lines, total] = hooks_session._parse_status_z_b("");
    expect(branch).toBe("unknown");
    expect(lines).toEqual([]);
    expect(total).toBe(0);
  });

  it("test_staged_file", () => {
    const output = "## main\0M  src/staged.py\0";
    const [branch, lines, total] = hooks_session._parse_status_z_b(output);
    expect(branch).toBe("main");
    expect(lines.length).toBe(1);
    expect(total).toBe(1);
    expect(lines[0]!.slice(0, 1)).toBe("M");
  });

  it("test_rename_old_name_not_counted", () => {
    const output = "## main\0R  new_name.py\0old_name.py\0M  other.py\0";
    const [branch, lines, total] = hooks_session._parse_status_z_b(output);
    expect(branch).toBe("main");
    expect(total).toBe(2);
    expect(lines.length).toBe(2);
    const path_fields = lines.map((ln) => ln.slice(3));
    expect(path_fields).toContain("new_name.py");
    expect(path_fields).not.toContain("old_name.py");
    expect(path_fields).toContain("other.py");
  });

  it("test_copy_old_name_not_counted", () => {
    const output = "## main\0C  dest.py\0source.py\0";
    const [branch, lines, total] = hooks_session._parse_status_z_b(output);
    expect(total).toBe(1);
    expect(lines.length).toBe(1);
    expect(lines[0]!.slice(3)).toBe("dest.py");
  });
});

// ---------------------------------------------------------------------------
// TestSessionBriefTimeoutReturnsNone
// ---------------------------------------------------------------------------
describe("TestSessionBriefTimeoutReturnsNone", () => {
  it("test_timeout_returns_none", () => {
    vi.spyOn(util, "runGit").mockImplementation(() => {
      throw new Error("TimeoutExpired");
    });
    expect(hooks_session._build_session_brief(tmpdir())).toBeNull();
  });

  it("test_timeout_no_exception_propagates", () => {
    vi.spyOn(util, "runGit").mockImplementation(() => {
      throw new Error("TimeoutExpired");
    });
    expect(() => hooks_session._build_session_brief(tmpdir())).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// TestDeferredImports — compact is a fail-soft seam in TS (not statically
// imported). A plain SessionStart (non-compact) must continue cleanly without
// ever needing the compact seam injected.
// ---------------------------------------------------------------------------
describe("TestDeferredImports", () => {
  it("test_compact_not_imported_on_session_start", () => {
    hooks_session._setWorkerModule({ ensure_running: () => 1, spawn_index_detached: () => 1 });
    hooks_session._setCompactModule(null); // compact NOT available
    const result = hooks_session.session_start({
      session_id: "deferred_test_1",
      cwd: tmpdir(),
      source: "startup",
    });
    expect(result.continue).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// TestRecoveryHintPytestCollapse
// ---------------------------------------------------------------------------
describe("TestRecoveryHintPytestCollapse", () => {
  const OUTPUT_BYTES = 1000; // above _RECOVERY_MIN_BYTES (400)

  function makeBashEntry(
    sid: string,
    cmd_preview: string,
    exit_code: number,
    output_id?: string,
  ): void {
    const oid = output_id ?? `${sid.slice(0, 16)}-0000000000001-abc123def45678`;
    session.mark_bash_run(sid, "abc123def4567890", cmd_preview, oid, OUTPUT_BYTES, 0, exit_code, false);
  }

  it("test_green_pytest_with_edits_collapses", () => {
    const sid = "pytest-collapse-1";
    makeBashEntry(sid, "pytest tests/", 0);
    session.mark_file_edited(sid, "/proj/src/foo.py");

    const hint = hooks_session._build_recovery_hint(sid);
    expect(hint).not.toBeNull();
    expect(hint!).toContain("✓ pytest passed @");
    expect(hint!).toContain("token-goat bash-output");
    expect(hint!).not.toContain("`pytest tests/`");
  });

  it("test_green_pytest_no_edits_full_pointer", () => {
    const sid = "pytest-collapse-2";
    makeBashEntry(sid, "pytest tests/", 0);

    const hint = hooks_session._build_recovery_hint(sid);
    expect(hint).not.toBeNull();
    expect(hint!).not.toContain("✓ pytest passed @");
    expect(hint!).toContain("`pytest tests/`");
  });

  it("test_red_pytest_with_edits_full_pointer", () => {
    const sid = "pytest-collapse-3";
    makeBashEntry(sid, "pytest tests/", 1);
    session.mark_file_edited(sid, "/proj/src/foo.py");

    const hint = hooks_session._build_recovery_hint(sid);
    expect(hint).not.toBeNull();
    expect(hint!).not.toContain("✓ pytest passed @");
    expect(hint!).toContain("`pytest tests/`");
  });

  it("test_non_pytest_with_edits_full_pointer", () => {
    const sid = "pytest-collapse-4";
    makeBashEntry(sid, "npm run build", 0);
    session.mark_file_edited(sid, "/proj/src/foo.py");

    const hint = hooks_session._build_recovery_hint(sid);
    expect(hint).not.toBeNull();
    expect(hint!).not.toContain("✓ pytest passed @");
    expect(hint!).toContain("`npm run build`");
  });

  it("test_all_three_prefix_variants_collapse", () => {
    const prefixes = ["pytest tests/", "uv run pytest tests/", "python -m pytest tests/"];
    prefixes.forEach((prefix, i) => {
      const sid = `pytest-collapse-prefix-${i}`;
      const oid = `${sid.slice(0, 16)}-000000000000${i + 1}-abc123def45678${i}`;
      session.mark_bash_run(
        sid,
        `sha${String(i).padStart(16, "0")}`,
        prefix,
        oid,
        OUTPUT_BYTES,
        0,
        0,
        false,
      );
      session.mark_file_edited(sid, "/proj/src/foo.py");

      const hint = hooks_session._build_recovery_hint(sid);
      expect(hint, `No hint for prefix ${prefix}`).not.toBeNull();
      expect(hint!, `Prefix ${prefix} not collapsed:\n${hint}`).toContain("✓ pytest passed @");
    });
  });
});
