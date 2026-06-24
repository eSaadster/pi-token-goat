/**
 * 1:1 port of tests/test_bash_already_read.py.
 *
 * Subject module: token_goat.hooks_read._handle_bash_already_read — the
 * cross-tool cat/Read session-cache short-circuit. The Python suite exercises
 * the advisory hint emitted when a bash `cat`/`bat` re-reads a file already
 * recorded in session.files (simulating a prior Read tool call).
 *
 * PORT STATUS — un-deferred for the _handle_bash_already_read cases.
 *   hooks_read is now ported (src/token_goat/hooks_read.ts exports
 *   _handle_bash_already_read), so the eight positive/negative cases run live.
 *
 *   The lone stats test (TestBashAlreadyReadStatGroup) targets
 *   render/stats_renderer._kind_group_label. That symbol IS ported but is
 *   module-private (not exported, not on any barrel surface), so it cannot be
 *   imported without editing stats_renderer.ts's export surface — out of scope
 *   for this un-defer pass (no src edits). It remains deferred.
 *
 * Test seam mapping:
 *   - tmp_data_dir / tmp_path fixtures -> setup.ts's per-test setDataDirOverride
 *     already isolates the data dir; relative-path tests mkdtemp under
 *     node:os.tmpdir() exactly like the Python tmp_path test did.
 *   - sess.mark_file_read(sid, path) -> session.mark_file_read (snake_case).
 *   - result.get("hookSpecificOutput", {}).get("additionalContext", "")
 *     -> the `_ctx` helper below.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, it, expect } from "vitest";

import * as sess from "../src/token_goat/session.js";
import { _handle_bash_already_read } from "../src/token_goat/hooks_read.js";

// ---------------------------------------------------------------------------
// Helper (ported verbatim from the Python module-level `_ctx`).
// ---------------------------------------------------------------------------
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function _ctx(result: any): string {
  return result?.hookSpecificOutput?.additionalContext ?? "";
}

describe("TestHandleBashAlreadyReadPositive (port of tests/test_bash_already_read.py)", () => {
  it("test_cat_after_read_tool_returns_advisory", () => {
    // After a file is recorded in session.files (simulating a Read tool call),
    // cat on that file should return an advisory hint.
    const sid = "bar-already-read-1";
    const p = "/proj/src/foo.py";
    sess.mark_file_read(sid, p);

    const payload = {
      session_id: sid,
      tool_name: "Bash",
      tool_input: { command: `cat ${p}` },
      cwd: "/proj",
    };
    const result = _handle_bash_already_read(payload as never) as Record<string, unknown> | null;
    expect(result).not.toBeNull();
    const ctx = _ctx(result);
    expect(ctx.includes("already read")).toBe(true);
    expect(ctx.includes("token-goat")).toBe(true);
    // Must be advisory, not deny.
    expect((result as Record<string, unknown>)["action"]).not.toBe("deny");
    const hso = ((result as Record<string, unknown>)["hookSpecificOutput"] ?? {}) as Record<string, unknown>;
    expect("permissionDecision" in hso).toBe(false);
  });

  it("test_read_count_2_defers_to_streak_hint", () => {
    // read_count=2 must return None so the streak hint (read_count >= 2) handles
    // it instead.
    const sid = "bar-already-read-count2";
    const p = "/proj/src/foo.py";
    sess.mark_file_read(sid, p);
    sess.mark_file_read(sid, p); // second read → read_count=2

    const payload = {
      session_id: sid,
      tool_name: "Bash",
      tool_input: { command: `cat ${p}` },
      cwd: "/proj",
    };
    const result = _handle_bash_already_read(payload as never);
    expect(result, "read_count=2 must defer to _handle_bash_streak_hint (fires for >= 2)").toBeNull();
  });

  it("test_bat_after_read_tool_returns_advisory", () => {
    // bat (a cat alternative) targeting an already-read file also fires the hint.
    const sid = "bar-already-read-bat";
    const p = "/proj/src/utils.py";
    sess.mark_file_read(sid, p);

    const payload = {
      session_id: sid,
      tool_name: "Bash",
      tool_input: { command: `bat ${p}` },
      cwd: "/proj",
    };
    const result = _handle_bash_already_read(payload as never);
    expect(result).not.toBeNull();
    expect(_ctx(result).includes("already read")).toBe(true);
  });

  it("test_relative_path_resolved_via_cwd", () => {
    // cat with a relative path hits the session entry stored under the resolved
    // absolute path.
    const tmpPath = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "tg-bar-")));
    const srcDir = path.join(tmpPath, "src");
    fs.mkdirSync(srcDir);
    fs.writeFileSync(path.join(srcDir, "foo.py"), "# content", "utf-8");
    const absPath = path.join(srcDir, "foo.py");
    const sid = "bar-cwd-fallback";
    sess.mark_file_read(sid, absPath);

    const payload = {
      session_id: sid,
      tool_name: "Bash",
      tool_input: { command: "cat src/foo.py" },
      cwd: tmpPath,
    };
    const result = _handle_bash_already_read(payload as never);
    expect(result, "relative path must resolve to session entry via cwd fallback").not.toBeNull();
    expect(_ctx(result).includes("already read")).toBe(true);
  });
});

describe("TestHandleBashAlreadyReadNegative (port of tests/test_bash_already_read.py)", () => {
  it("test_first_time_cat_returns_none", () => {
    // No prior read in session → no hint.
    const payload = {
      session_id: "bar-no-prior-read",
      tool_name: "Bash",
      tool_input: { command: "cat /proj/src/new_file.py" },
      cwd: "/proj",
    };
    const result = _handle_bash_already_read(payload as never);
    expect(result).toBeNull();
  });

  it("test_non_read_command_returns_none", () => {
    // Non-read bash commands (npm install) are not handled.
    const payload = {
      session_id: "bar-non-read",
      tool_name: "Bash",
      tool_input: { command: "npm install" },
      cwd: "/proj",
    };
    const result = _handle_bash_already_read(payload as never);
    expect(result).toBeNull();
  });

  it("test_no_session_id_returns_none", () => {
    const payload = {
      tool_name: "Bash",
      tool_input: { command: "cat /proj/src/foo.py" },
      cwd: "/proj",
    };
    const result = _handle_bash_already_read(payload as never);
    expect(result).toBeNull();
  });

  it("test_non_bash_tool_returns_none", () => {
    const payload = {
      session_id: "bar-read-tool",
      tool_name: "Read",
      tool_input: { file_path: "/proj/src/foo.py" },
      cwd: "/proj",
    };
    const result = _handle_bash_already_read(payload as never);
    expect(result).toBeNull();
  });
});

describe("TestBashAlreadyReadStatGroup (port of tests/test_bash_already_read.py)", () => {
  // PORT: deferred — render/stats_renderer._kind_group_label is module-private
  // (not exported / not on a barrel surface); cannot import without changing
  // stats_renderer's export surface (no src edits in this un-defer pass).
  it.skip("test_bash_read_equiv_already_read_in_bash_group", () => {
    // PORT: deferred — _kind_group_label not exported from stats_renderer.
  });
});
