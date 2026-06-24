/**
 * Port of tests/test_hooks_user_prompt_subagent.py — UserPromptSubmit and
 * SubagentStop hook handlers.
 *
 * The Python file calls hooks_cli.user_prompt_submit / subagent_stop /
 * dispatch(...); those are thin wrappers that resolve to the same bare handlers
 * exported by hooks_session. This port calls hooks_session.user_prompt_submit /
 * subagent_stop directly (the dispatch-routing cases are covered by the
 * hooks_cli dispatch tests; here we re-express them as direct handler calls
 * that must return continue:true).
 *
 * Test-seam mapping (Python -> TS):
 *  - patch("subprocess.run", ...) -> vi.spyOn(util, "runGit"). Both handlers
 *    call git via util.runGit.
 *  - patch.object(real_session, "safe_load", return_value=mock_cache) ->
 *    vi.spyOn(session, "safe_load").mockReturnValue(mock_cache). The handler
 *    imports session statically so the spy is observed.
 *  - MagicMock cache with edited_files as a set / bash_history dict ->
 *    a plain object with the same fields. _getAttr reads object props the way
 *    Python getattr reads MagicMock attributes; _isEmptyEdited handles the Set.
 *  - monkeypatch.setattr(paths, "data_dir", lambda: tmp_path) -> the per-test
 *    data dir override (tests/setup.ts) already isolates sessionsDir(); the
 *    sidecar lands under paths.sessionsDir().
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import * as util from "../src/token_goat/util.js";
import type { CompletedProcess } from "../src/token_goat/util.js";
import * as session from "../src/token_goat/session.js";
import * as paths from "../src/token_goat/paths.js";
import type { SessionCache } from "../src/token_goat/session.js";
import * as hooks_session from "../src/token_goat/hooks_session.js";
import { _SUBAGENT_HALLUCINATION_SIDECAR } from "../src/token_goat/hooks_session.js";

function cp(stdout: string, returncode = 0): CompletedProcess {
  return { args: [], stdout, stderr: "", returncode };
}

function tmpdir(): string {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "tg-ups-")));
}

/** A MagicMock-style cache stand-in (only the fields the handlers read). */
function fakeCache(fields: Record<string, unknown>): SessionCache {
  return fields as unknown as SessionCache;
}

afterEach(() => {
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// UserPromptSubmit — no session_id
// ---------------------------------------------------------------------------
describe("user_prompt_submit", () => {
  it("test_user_prompt_submit_no_session_id", () => {
    const result = hooks_session.user_prompt_submit({});
    expect(result.continue).toBe(true);
    expect(result.hookSpecificOutput).toBeUndefined();
  });

  it("test_user_prompt_submit_additionalContext_format", () => {
    const mock_cache = fakeCache({
      edited_files: new Set(["file1.py", "file2.py"]),
      bash_history: { cmd1: { ts: 1000.0, exit_code: 0 } },
    });
    vi.spyOn(util, "runGit").mockReturnValue(cp("feature-branch\n", 0));
    vi.spyOn(session, "safe_load").mockReturnValue(mock_cache);

    const result = hooks_session.user_prompt_submit({
      session_id: "test-sess-456",
      cwd: tmpdir(),
    });
    expect(result.continue).toBe(true);
    const hso = result.hookSpecificOutput as Record<string, unknown> | undefined;
    if (hso) {
      const ctx = String(hso["additionalContext"] ?? "");
      expect(ctx.startsWith("[")).toBe(true);
      expect(ctx.endsWith("]")).toBe(true);
      expect(ctx).toContain("edits:");
    }
  });

  it("test_user_prompt_submit_git_failure_still_returns_continue", () => {
    const mock_cache = fakeCache({ edited_files: new Set(), bash_history: {} });
    vi.spyOn(util, "runGit").mockImplementation(() => {
      throw new Error("git not found");
    });
    vi.spyOn(session, "safe_load").mockReturnValue(mock_cache);

    const result = hooks_session.user_prompt_submit({
      session_id: "test-sess-789",
      cwd: tmpdir(),
    });
    expect(result.continue).toBe(true);
  });

  it("test_user_prompt_submit_no_session_cache_returns_continue", () => {
    vi.spyOn(util, "runGit").mockImplementation(() => {
      throw new Error("git not found");
    });
    vi.spyOn(session, "safe_load").mockReturnValue(null);

    const result = hooks_session.user_prompt_submit({
      session_id: "test-sess-000",
      cwd: tmpdir(),
    });
    expect(result.continue).toBe(true);
    expect(result.hookSpecificOutput).toBeUndefined();
  });

  it("test_user_prompt_submit_short_prompt_early_returns", () => {
    for (const short_prompt of ["k", "yes", "no", "/help", "ok", "y", "       "]) {
      const result = hooks_session.user_prompt_submit({
        session_id: "short-prompt-sess",
        cwd: tmpdir(),
        prompt: short_prompt,
      });
      expect(result.continue, `Failed for prompt=${short_prompt}`).toBe(true);
      expect(result.hookSpecificOutput, `hso must be absent for ${short_prompt}`).toBeUndefined();
    }
  });

  it("test_user_prompt_submit_long_enough_prompt_proceeds", () => {
    const mock_cache = fakeCache({
      edited_files: new Set(["a.py"]),
      bash_history: { cmd: { ts: 1000.0, exit_code: 0 } },
    });
    vi.spyOn(util, "runGit").mockReturnValue(cp("main\n", 0));
    vi.spyOn(session, "safe_load").mockReturnValue(mock_cache);

    const result = hooks_session.user_prompt_submit({
      session_id: "long-prompt-sess",
      cwd: tmpdir(),
      prompt: "Please fix the login bug", // 24 chars
    });
    expect(result.continue).toBe(true);
    const hso = result.hookSpecificOutput as Record<string, unknown> | undefined;
    expect(hso).not.toBeUndefined();
    expect(hso!["additionalContext"]).not.toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// SubagentStop
// ---------------------------------------------------------------------------
describe("subagent_stop", () => {
  it("test_subagent_stop_no_session_id", () => {
    const result = hooks_session.subagent_stop({});
    expect(result.continue).toBe(true);
  });

  it("test_subagent_stop_no_edited_files_skips_flag", () => {
    const mock_cache = fakeCache({ edited_files: new Set() });
    vi.spyOn(session, "safe_load").mockReturnValue(mock_cache);
    const result = hooks_session.subagent_stop({
      session_id: "sub-sess-001",
      cwd: tmpdir(),
    });
    expect(result.continue).toBe(true);
  });

  it("test_subagent_stop_disk_changes_no_flag", () => {
    const mock_cache = fakeCache({ edited_files: new Set(["some_file.py"]) });
    vi.spyOn(session, "safe_load").mockReturnValue(mock_cache);
    vi.spyOn(util, "runGit").mockReturnValue(cp(" M some_file.py\n", 0));
    const result = hooks_session.subagent_stop({
      session_id: "sub-sess-002",
      cwd: tmpdir(),
    });
    expect(result.continue).toBe(true);
  });

  it("test_subagent_stop_no_disk_changes_writes_sidecar", () => {
    const dir = tmpdir();
    const mock_cache = fakeCache({ edited_files: new Set(["some_file.py"]) });
    vi.spyOn(session, "safe_load").mockReturnValue(mock_cache);
    vi.spyOn(util, "runGit").mockReturnValue(cp("", 0)); // clean working tree

    const result = hooks_session.subagent_stop({
      session_id: "sub-sess-003",
      cwd: dir,
    });
    expect(result.continue).toBe(true);

    const sidecar = path.join(paths.sessionsDir(), _SUBAGENT_HALLUCINATION_SIDECAR);
    expect(fs.existsSync(sidecar)).toBe(true);
    const lines = fs
      .readFileSync(sidecar, "utf-8")
      .split("\n")
      .filter((ln) => ln.trim().length > 0);
    expect(lines.length).toBe(1);
    const record = JSON.parse(lines[0]!) as Record<string, unknown>;
    expect(record["session_id"]).toBe("sub-sess-003");
    expect(record["trigger"]).toBe("SubagentStop");
  });

  it("test_subagent_stop_git_failure_returns_continue", () => {
    const mock_cache = fakeCache({ edited_files: new Set(["file.py"]) });
    vi.spyOn(session, "safe_load").mockReturnValue(mock_cache);
    // util.runGit never throws on a spawn failure — it folds ENOENT/timeout into
    // returncode -1 with empty stdout (the TS contract). The handler then treats
    // the empty status as "no disk changes" and flags, but never crashes.
    vi.spyOn(util, "runGit").mockReturnValue(cp("", -1));
    const result = hooks_session.subagent_stop({
      session_id: "sub-sess-004",
      cwd: tmpdir(),
    });
    expect(result.continue).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Integration: handlers always return continue:true (dispatch routing is
// covered by the hooks_cli dispatch tests; here we exercise the handlers).
// ---------------------------------------------------------------------------
describe("dispatch routing", () => {
  it("test_dispatch_user_prompt_submit_routes", () => {
    const result = hooks_session.user_prompt_submit({
      session_id: "dispatch-test",
      cwd: tmpdir(),
    });
    expect(result.continue).toBe(true);
  });

  it("test_dispatch_subagent_stop_routes", () => {
    const result = hooks_session.subagent_stop({
      session_id: "dispatch-test-2",
      cwd: tmpdir(),
    });
    expect(result.continue).toBe(true);
  });
});
