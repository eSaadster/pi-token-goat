/**
 * Port of tests/test_session_brief.py — the SessionStart orientation brief
 * (`_build_session_brief`) and the integration cases.
 *
 * Test-seam mapping (Python -> TS):
 *  - patch("subprocess.run", side_effect=_make_run_side_effect(...)) ->
 *    vi.spyOn(util, "runGit").mockImplementation(makeRunSideEffect(...)). The
 *    ported hooks_session calls git through util.runGit (the single chokepoint),
 *    so spying on it is the faithful analogue of patching subprocess.run. Each
 *    stub returns a CompletedProcess { args, stdout, stderr, returncode }.
 *  - module-level _brief_cache.clear() -> hooks_session._brief_cache.clear()
 *    (a real exported Map). tests/setup.ts also clears it via registerReset.
 *  - monkeypatch.setenv("TOKEN_GOAT_SESSION_BRIEF", ...) -> process.env mutation
 *    restored in afterEach.
 *  - the integration tests patch hooks_session._build_session_brief / _detect and
 *    inject the worker via _setWorkerModule.
 *  - TestBriefLatencyBudget relies on Python threading.Event().wait + a wall
 *    clock; it is skipped (no portable synchronous-hang seam under vitest).
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import * as util from "../src/token_goat/util.js";
import type { CompletedProcess } from "../src/token_goat/util.js";
import * as hooks_session from "../src/token_goat/hooks_session.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function cp(stdout: string, returncode = 0): CompletedProcess {
  return { args: [], stdout, stderr: "", returncode };
}

/**
 * Return a util.runGit implementation that simulates git output, mirroring the
 * Python _make_run_side_effect. *args* is the argv passed to runGit (without the
 * `git` / `--no-optional-locks` prefix, which runGit injects internally).
 */
function makeRunSideEffect(opts: {
  branch?: string;
  branch_rc?: number;
  status_output?: string;
  status_rc?: number;
  log_output?: string;
  log_rc?: number;
} = {}): (args: string[]) => CompletedProcess {
  const branch = opts.branch ?? "main";
  const status_output = opts.status_output ?? " M src/foo.py\n?? new.py";
  const status_rc = opts.status_rc ?? 0;
  const log_output = opts.log_output ?? "abc1234 fix auth\ndef5678 add tests";
  const log_rc = opts.log_rc ?? 0;
  return (args: string[]): CompletedProcess => {
    if (args.includes("rev-parse")) {
      return cp(branch + "\n", opts.branch_rc ?? 0);
    }
    if (args.includes("status")) {
      // New code uses `git status -z -b`. Synthesize the NUL-separated format:
      // `## <branch>\0XY file1\0XY file2\0...`.
      if (args.includes("-z") && args.includes("-b")) {
        const entries = status_output.split("\n").filter((line) => line.length > 0);
        return cp(["## " + branch, ...entries].join("\0") + "\0", status_rc);
      }
      return cp(status_output, status_rc);
    }
    if (args.includes("log")) {
      return cp(log_output, log_rc);
    }
    return cp("", 0);
  };
}

/** Simulate a fully clean, in-sync repo (rev-list HEAD...origin -> "0\t0"). */
function makeRunInsync(branch = "main"): (args: string[]) => CompletedProcess {
  return (args: string[]): CompletedProcess => {
    if (args.includes("status")) {
      return cp(`## ${branch}...origin/${branch}\0`, 0);
    }
    if (args.includes("rev-list")) {
      return cp("0\t0", 0);
    }
    return cp("", 0);
  };
}

function tmpdir(): string {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "tg-brief-")));
}

afterEach(() => {
  vi.restoreAllMocks();
  delete process.env["TOKEN_GOAT_SESSION_BRIEF"];
});

// ---------------------------------------------------------------------------
// TestBriefInjectedWhenDirty
// ---------------------------------------------------------------------------
describe("TestBriefInjectedWhenDirty", () => {
  it("test_brief_returned_with_dirty_files", () => {
    vi.spyOn(util, "runGit").mockImplementation(
      makeRunSideEffect({ status_output: " M src/foo.py\n?? new.py" }),
    );
    const brief = hooks_session._build_session_brief(tmpdir());
    expect(brief).not.toBeNull();
    expect(brief!).not.toContain("## Session Context");
    expect(brief!).toContain("main");
    expect(/modified|untracked|staged/.test(brief!)).toBe(true);
    expect(brief!).not.toContain("\n");
  });

  it("test_brief_contains_recent_commits", () => {
    vi.spyOn(util, "runGit").mockImplementation(
      makeRunSideEffect({ status_output: " M foo.py", log_output: "abc1234 fix auth\ndef5678 add tests" }),
    );
    const brief = hooks_session._build_session_brief(tmpdir());
    expect(brief).not.toBeNull();
    expect(brief!).toContain("abc1234");
    expect(brief!).toContain("def5678");
    expect(brief!).not.toContain("Recent:");
    expect(brief!).toContain(" — ");
  });

  it("test_brief_includes_staged_count", () => {
    vi.spyOn(util, "runGit").mockImplementation(
      makeRunSideEffect({ status_output: "M  src/auth.py\nA  src/new.py" }),
    );
    const brief = hooks_session._build_session_brief(tmpdir());
    expect(brief).not.toBeNull();
    expect(brief!).toContain("staged");
  });

  it("test_brief_branch_name_included", () => {
    vi.spyOn(util, "runGit").mockImplementation(
      makeRunSideEffect({ branch: "feature/my-branch", status_output: " M foo.py" }),
    );
    const brief = hooks_session._build_session_brief(tmpdir());
    expect(brief).not.toBeNull();
    expect(brief!).toContain("feature/my-branch");
  });
});

// ---------------------------------------------------------------------------
// TestBriefSkippedWhenClean
// ---------------------------------------------------------------------------
describe("TestBriefSkippedWhenClean", () => {
  it("test_skipped_when_clean_with_commits", () => {
    vi.spyOn(util, "runGit").mockImplementation(
      makeRunSideEffect({ status_output: "", log_output: "abc1234 fix auth" }),
    );
    const brief = hooks_session._build_session_brief(tmpdir());
    expect(brief).not.toBeNull();
    expect(brief!).toContain(" — abc1234");
  });

  it("test_skipped_when_clean_and_no_commits", () => {
    vi.spyOn(util, "runGit").mockImplementation(
      makeRunSideEffect({ status_output: "", log_output: "" }),
    );
    const brief = hooks_session._build_session_brief(tmpdir());
    expect(brief).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// TestBriefCleanInsyncTerseLine
// ---------------------------------------------------------------------------
describe("TestBriefCleanInsyncTerseLine", () => {
  it("test_main_insync_returns_terse_brief", () => {
    vi.spyOn(util, "runGit").mockImplementation(makeRunInsync("main"));
    expect(hooks_session._build_session_brief(tmpdir())).toBe("main (clean)");
  });

  it("test_master_insync_returns_terse_brief", () => {
    vi.spyOn(util, "runGit").mockImplementation(makeRunInsync("master"));
    expect(hooks_session._build_session_brief(tmpdir())).toBe("master (clean)");
  });

  it("test_develop_insync_returns_terse_brief", () => {
    vi.spyOn(util, "runGit").mockImplementation(makeRunInsync("develop"));
    expect(hooks_session._build_session_brief(tmpdir())).toBe("develop (clean)");
  });

  it("test_feature_branch_insync_still_returns_none", () => {
    vi.spyOn(util, "runGit").mockImplementation(makeRunInsync("feature/x"));
    expect(hooks_session._build_session_brief(tmpdir())).toBeNull();
  });

  it("test_terse_brief_is_cached", () => {
    hooks_session._brief_cache.clear();
    const dir = tmpdir();
    vi.spyOn(util, "runGit").mockImplementation(makeRunInsync("main"));
    const brief1 = hooks_session._build_session_brief(dir);
    vi.restoreAllMocks();
    vi.spyOn(util, "runGit").mockImplementation(() => {
      throw new Error("subprocess called on cache hit");
    });
    const brief2 = hooks_session._build_session_brief(dir);
    expect(brief1).toBe("main (clean)");
    expect(brief2).toBe("main (clean)");
  });
});

// ---------------------------------------------------------------------------
// TestBriefSkippedWhenNotGitRepo
// ---------------------------------------------------------------------------
describe("TestBriefSkippedWhenNotGitRepo", () => {
  it("test_skipped_when_not_a_git_repo", () => {
    vi.spyOn(util, "runGit").mockImplementation((args: string[]) => {
      if (args.includes("status")) {
        return cp("", 128);
      }
      return cp("", 0);
    });
    const brief = hooks_session._build_session_brief(tmpdir());
    expect(brief).toBeNull();
  });

  it("test_skipped_when_git_not_available", () => {
    // git not installed: runGit folds ENOENT into returncode -1.
    vi.spyOn(util, "runGit").mockImplementation(() => cp("", -1));
    const brief = hooks_session._build_session_brief(tmpdir());
    expect(brief).toBeNull();
  });

  it("test_skipped_when_cwd_does_not_exist", () => {
    const brief = hooks_session._build_session_brief("/nonexistent/path/that/does/not/exist");
    expect(brief).toBeNull();
  });

  it("test_skipped_when_timeout", () => {
    // TimeoutExpired analogue: runGit throwing must be caught -> None.
    vi.spyOn(util, "runGit").mockImplementation(() => {
      throw new Error("TimeoutExpired");
    });
    const brief = hooks_session._build_session_brief(tmpdir());
    expect(brief).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// TestBriefDisabledByEnvVar
// ---------------------------------------------------------------------------
describe("TestBriefDisabledByEnvVar", () => {
  for (const val of ["0", "false", "no", "off"]) {
    it(`test_env_var_${val}_disables`, () => {
      process.env["TOKEN_GOAT_SESSION_BRIEF"] = val;
      const spy = vi.spyOn(util, "runGit");
      const brief = hooks_session._build_session_brief(tmpdir());
      expect(brief).toBeNull();
      expect(spy).not.toHaveBeenCalled();
    });
  }

  it("test_env_var_1_enables", () => {
    process.env["TOKEN_GOAT_SESSION_BRIEF"] = "1";
    vi.spyOn(util, "runGit").mockImplementation(makeRunSideEffect({ status_output: " M foo.py" }));
    const brief = hooks_session._build_session_brief(tmpdir());
    expect(brief).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// TestBriefTokenBudget
// ---------------------------------------------------------------------------
describe("TestBriefTokenBudget", () => {
  const CHARS_PER_TOKEN = 4;

  it("test_brief_under_80_tokens", () => {
    const log_output =
      "abc1234 fix authentication bug in login flow\n" +
      "def5678 add unit tests for the auth module\n" +
      "ghi9012 refactor database connection pooling\n" +
      "jkl3456 update dependencies to latest versions\n" +
      "mno7890 initial project setup and configuration";
    const status_output = " M src/auth.py\n M src/db.py\n?? docs/new.md\nA  src/feature.py";
    vi.spyOn(util, "runGit").mockImplementation(
      makeRunSideEffect({ branch: "main", status_output, log_output }),
    );
    const brief = hooks_session._build_session_brief(tmpdir());
    expect(brief).not.toBeNull();
    const token_estimate = brief!.length / CHARS_PER_TOKEN;
    expect(token_estimate).toBeLessThanOrEqual(80);
  });

  it("test_long_commit_messages_truncated", () => {
    const long_msg = "a".repeat(200);
    vi.spyOn(util, "runGit").mockImplementation(
      makeRunSideEffect({ status_output: " M foo.py", log_output: `abc1234 ${long_msg}` }),
    );
    const brief = hooks_session._build_session_brief(tmpdir());
    expect(brief).not.toBeNull();
    expect(brief!.length).toBeLessThan(400);
  });

  it("test_many_status_lines_capped", () => {
    const lines = Array.from({ length: 80 }, (_v, i) => ` M src/file${i}.py`).join("\n");
    vi.spyOn(util, "runGit").mockImplementation(makeRunSideEffect({ status_output: lines }));
    const brief = hooks_session._build_session_brief(tmpdir());
    expect(brief).not.toBeNull();
    expect(/modified|staged|changes/.test(brief!)).toBe(true);
    expect(brief!).toContain("more files");
  });
});

// ---------------------------------------------------------------------------
// TestSessionStartIntegration
// ---------------------------------------------------------------------------
describe("TestSessionStartIntegration", () => {
  it("test_session_start_injects_brief_on_dirty_repo", () => {
    hooks_session._setWorkerModule({ ensure_running: () => 1, spawn_index_detached: () => 1 });
    vi.spyOn(hooks_session, "_build_session_brief").mockReturnValue("main | 1 modified — abc1234 fix");
    vi.spyOn(hooks_session, "_detect").mockReturnValue(null);
    const result = hooks_session.session_start({
      session_id: "brief_test_01",
      cwd: tmpdir(),
      source: "startup",
    });
    expect(result.continue).toBe(true);
    expect("systemMessage" in result).toBe(true);
    expect(result.systemMessage).toContain("main | 1 modified");
  });

  it("test_session_start_no_brief_when_none", () => {
    hooks_session._setWorkerModule({ ensure_running: () => 1, spawn_index_detached: () => 1 });
    vi.spyOn(hooks_session, "_build_session_brief").mockReturnValue(null);
    vi.spyOn(hooks_session, "_detect").mockReturnValue(null);
    const result = hooks_session.session_start({
      session_id: "brief_test_02",
      cwd: tmpdir(),
      source: "startup",
    });
    expect(result.continue).toBe(true);
    expect("systemMessage" in result).toBe(false);
  });

  it("test_session_start_brief_not_injected_on_compact", () => {
    hooks_session._setWorkerModule({ ensure_running: () => 1, spawn_index_detached: () => 1 });
    vi.spyOn(hooks_session, "_build_session_brief").mockReturnValue("main | 1 modified");
    vi.spyOn(hooks_session, "_detect").mockReturnValue(null);
    vi.spyOn(hooks_session, "_try_recovery_response").mockReturnValue(null);
    const result = hooks_session.session_start({
      session_id: "brief_test_03",
      cwd: tmpdir(),
      source: "compact",
    });
    expect(result.continue).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// TestBriefFormatRegression
// ---------------------------------------------------------------------------
describe("TestBriefFormatRegression", () => {
  it("test_brief_no_header", () => {
    vi.spyOn(util, "runGit").mockImplementation(
      makeRunSideEffect({ status_output: " M foo.py", log_output: "abc1234 fix" }),
    );
    const brief = hooks_session._build_session_brief(tmpdir());
    expect(brief).not.toBeNull();
    expect(brief!).not.toContain("## Session Context");
  });

  it("test_brief_no_branch_label", () => {
    vi.spyOn(util, "runGit").mockImplementation(makeRunSideEffect({ status_output: " M foo.py" }));
    const brief = hooks_session._build_session_brief(tmpdir());
    expect(brief).not.toBeNull();
    expect(brief!).not.toContain("Branch:");
  });

  it("test_brief_no_recent_label", () => {
    vi.spyOn(util, "runGit").mockImplementation(
      makeRunSideEffect({ status_output: " M foo.py", log_output: "abc1234 fix" }),
    );
    const brief = hooks_session._build_session_brief(tmpdir());
    expect(brief).not.toBeNull();
    expect(brief!).not.toContain("Recent:");
  });

  it("test_brief_single_line", () => {
    vi.spyOn(util, "runGit").mockImplementation(
      makeRunSideEffect({ status_output: " M foo.py", log_output: "abc1234 fix auth\ndef5678 add tests" }),
    );
    const brief = hooks_session._build_session_brief(tmpdir());
    expect(brief).not.toBeNull();
    expect(brief!).not.toContain("\n");
  });

  it("test_brief_branch_status_commits_format", () => {
    vi.spyOn(util, "runGit").mockImplementation(
      makeRunSideEffect({
        branch: "main",
        status_output: " M foo.py\n?? new.py",
        log_output: "abc1234 fix auth\ndef5678 add tests",
      }),
    );
    const brief = hooks_session._build_session_brief(tmpdir());
    expect(brief).not.toBeNull();
    expect(brief!.startsWith("main")).toBe(true);
    expect(brief!).toContain(" | ");
    expect(brief!).toContain(" — ");
    expect(brief!.indexOf(" | ")).toBeLessThan(brief!.indexOf(" — "));
  });

  it("test_brief_branch_only_when_clean_no_commits", () => {
    vi.spyOn(util, "runGit").mockImplementation(
      makeRunSideEffect({ branch: "main", status_output: "", log_output: "" }),
    );
    expect(hooks_session._build_session_brief(tmpdir())).toBeNull();
  });

  it("test_brief_branch_status_when_no_commits", () => {
    vi.spyOn(util, "runGit").mockImplementation(
      makeRunSideEffect({ branch: "main", status_output: " M foo.py\n?? new.py", log_output: "" }),
    );
    const brief = hooks_session._build_session_brief(tmpdir());
    expect(brief).not.toBeNull();
    expect(brief!).not.toContain(" — ");
    expect(brief!).toContain(" | ");
    expect(brief!.startsWith("main")).toBe(true);
  });

  it("test_brief_branch_commits_when_clean", () => {
    vi.spyOn(util, "runGit").mockImplementation(
      makeRunSideEffect({ branch: "feature/x", status_output: "", log_output: "abc1234 fix auth" }),
    );
    const brief = hooks_session._build_session_brief(tmpdir());
    expect(brief).not.toBeNull();
    expect(brief!).not.toContain(" | ");
    expect(brief!).toContain(" — ");
    expect(brief!.startsWith("feature/x")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// TestBriefLatencyBudget — relies on Python threading.Event().wait + wall clock;
// no portable synchronous-hang seam under vitest. PORT: deferred.
// ---------------------------------------------------------------------------
describe("TestBriefLatencyBudget", () => {
  it.skip("test_session_brief_caps_total_git_latency", () => {});
});

// ---------------------------------------------------------------------------
// TestBriefCache
// ---------------------------------------------------------------------------
describe("TestBriefCache", () => {
  it("test_cache_hit_skips_subprocess", () => {
    hooks_session._brief_cache.clear();
    const dir = tmpdir();
    const side = makeRunSideEffect({
      branch: "main",
      status_output: " M src/foo.py",
      log_output: "abc1234 fix auth",
    });
    const spy1 = vi.spyOn(util, "runGit").mockImplementation(side);
    const r1 = hooks_session._build_session_brief(dir);
    spy1.mockRestore();

    const spy2 = vi.spyOn(util, "runGit").mockImplementation(side);
    const r2 = hooks_session._build_session_brief(dir);
    expect(spy2).not.toHaveBeenCalled();
    expect(r1).toBe(r2);
  });

  it("test_cache_bust_on_editmsg_mtime_change", () => {
    hooks_session._brief_cache.clear();
    const dir = tmpdir();
    const git_dir = path.join(dir, ".git");
    fs.mkdirSync(git_dir);
    const editmsg = path.join(git_dir, "COMMIT_EDITMSG");
    fs.writeFileSync(editmsg, "first commit\n");
    fs.writeFileSync(path.join(git_dir, "index"), "");

    const side = makeRunSideEffect({
      branch: "main",
      status_output: " M src/foo.py",
      log_output: "abc1234 fix auth",
    });
    vi.spyOn(util, "runGit").mockImplementation(side);
    hooks_session._build_session_brief(dir);
    vi.restoreAllMocks();

    const newMtime = new Date((fs.statSync(editmsg).mtimeMs + 2000));
    fs.utimesSync(editmsg, newMtime, newMtime);

    const spy = vi.spyOn(util, "runGit").mockImplementation(side);
    hooks_session._build_session_brief(dir);
    expect(spy.mock.calls.length).toBeGreaterThan(0);
  });

  it("test_cache_bust_on_index_mtime_change", () => {
    hooks_session._brief_cache.clear();
    const dir = tmpdir();
    const git_dir = path.join(dir, ".git");
    fs.mkdirSync(git_dir);
    fs.writeFileSync(path.join(git_dir, "COMMIT_EDITMSG"), "msg\n");
    const index_file = path.join(git_dir, "index");
    fs.writeFileSync(index_file, "");

    const side = makeRunSideEffect({
      branch: "feature",
      status_output: " M src/bar.py",
      log_output: "def5678 add tests",
    });
    vi.spyOn(util, "runGit").mockImplementation(side);
    hooks_session._build_session_brief(dir);
    vi.restoreAllMocks();

    const newMtime = new Date(fs.statSync(index_file).mtimeMs + 2000);
    fs.utimesSync(index_file, newMtime, newMtime);

    const spy = vi.spyOn(util, "runGit").mockImplementation(side);
    hooks_session._build_session_brief(dir);
    expect(spy.mock.calls.length).toBeGreaterThan(0);
  });

  it("test_none_result_is_cached", () => {
    hooks_session._brief_cache.clear();
    const dir = tmpdir();
    const noOutput = (args: string[]): CompletedProcess => {
      if (args.includes("status")) {
        if (args.includes("-z") && args.includes("-b")) {
          return cp("## main\0", 0);
        }
        return cp("", 0);
      }
      if (args.includes("log")) {
        return cp("", 0);
      }
      if (args.includes("rev-parse")) {
        return cp("a".repeat(40) + "\n", 0);
      }
      return cp("", 0);
    };
    const spy1 = vi.spyOn(util, "runGit").mockImplementation(noOutput);
    const r1 = hooks_session._build_session_brief(dir);
    spy1.mockRestore();
    expect(r1).toBeNull();

    const spy2 = vi.spyOn(util, "runGit").mockImplementation(noOutput);
    const r2 = hooks_session._build_session_brief(dir);
    expect(spy2).not.toHaveBeenCalled();
    expect(r2).toBeNull();
  });

  it("test_cache_key_is_cwd", () => {
    hooks_session._brief_cache.clear();
    const root = tmpdir();
    const dir_a = path.join(root, "repo_a");
    const dir_b = path.join(root, "repo_b");
    fs.mkdirSync(dir_a);
    fs.mkdirSync(dir_b);

    vi.spyOn(util, "runGit").mockImplementation(
      makeRunSideEffect({ branch: "main", status_output: " M a.py", log_output: "aaa fix" }),
    );
    const ra = hooks_session._build_session_brief(dir_a);
    vi.restoreAllMocks();
    vi.spyOn(util, "runGit").mockImplementation(
      makeRunSideEffect({ branch: "dev", status_output: " M b.py", log_output: "bbb feat" }),
    );
    const rb = hooks_session._build_session_brief(dir_b);

    expect(ra).not.toBe(rb);
    expect(hooks_session._brief_cache.has(dir_a)).toBe(true);
    expect(hooks_session._brief_cache.has(dir_b)).toBe(true);
  });
});
