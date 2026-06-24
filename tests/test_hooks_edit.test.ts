/**
 * Tests for hooks_edit — post-edit hook: session mark, queue enqueue, worker nudge.
 *
 * 1:1 port of tests/test_hooks_edit.py.
 *
 * Test-seam mapping (Python -> TS):
 *  - tmp_data_dir fixture        -> setup.ts's setDataDirOverride gives each test
 *                                   a throwaway data dir automatically.
 *  - tmp_path fixture            -> fs.mkdtempSync under os.tmpdir(), wrapped in
 *                                   fs.realpathSync (macOS /var -> /private/var)
 *                                   so find_project's canonicalisation matches.
 *  - hook_helpers.assert_continue -> ported verbatim as _assert_continue.
 *  - patch("token_goat.worker.ensure_running", ...) and the real worker module
 *    -> the worker module is NOT YET PORTED. hooks_edit reaches it through the
 *    _setWorkerModule fail-soft seam. Each test installs a small worker stub
 *    that mirrors the exact slice of the real worker the hook calls:
 *      * is_heartbeat_stale_for_nudge() reads the real worker heartbeat path and
 *        applies the same 2*interval+grace staleness threshold;
 *      * enqueue_dirty() replicates worker.enqueue_dirty's append-only write to
 *        queue/dirty.txt (so the queue can be read back / made to raise);
 *      * ensure_running() is a vi.fn() the test asserts on.
 *  - patch.object(paths, "worker_heartbeat_path", side_effect=RuntimeError) ->
 *    the stub's is_heartbeat_stale_for_nudge throws, exercising the outer
 *    try/catch fail-soft path.
 *  - patch.object(Path, "open", side_effect=OSError) -> the stub's enqueue_dirty
 *    throws, exercising the OSError-logged-not-raised branch.
 *  - os.utime(hb, (0,0)) -> fs.utimesSync(hb, 0, 0).
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import * as hooks_edit from "../src/token_goat/hooks_edit.js";
import * as paths from "../src/token_goat/paths.js";
import * as session from "../src/token_goat/session.js";
import type { HookPayload } from "../src/token_goat/types.js";

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

/** Verbatim port of hook_helpers.assert_continue. */
function _assert_continue(result: Record<string, unknown>): void {
  expect(result["continue"]).toBe(true);
}

/** Throwaway tmp dir (pytest tmp_path analogue), realpath-resolved. */
function tmpPath(prefix = "tg-hooksedit-"): string {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
}

// Worker staleness threshold mirrors worker.heartbeat_stale_threshold():
// 2 * HEARTBEAT_INTERVAL(30) + HEARTBEAT_GRACE_SECONDS(5).
const HEARTBEAT_INTERVAL = 30.0;
const HEARTBEAT_GRACE_SECONDS = 5.0;
function heartbeatStaleThreshold(): number {
  return 2 * HEARTBEAT_INTERVAL + HEARTBEAT_GRACE_SECONDS;
}

/**
 * Build a worker stub mirroring the slice of worker hooks_edit calls. Faithful
 * to worker.is_heartbeat_stale_for_nudge / enqueue_dirty.
 */
function makeWorkerStub(
  overrides: Partial<hooks_edit.WorkerModule> = {},
): hooks_edit.WorkerModule {
  const base: hooks_edit.WorkerModule = {
    is_heartbeat_stale_for_nudge(): boolean {
      const hb = paths.workerHeartbeatPath();
      let mtime: number;
      try {
        mtime = fs.statSync(hb).mtimeMs / 1000;
      } catch {
        // Missing heartbeat -> stale (worker never started / crashed early).
        return true;
      }
      const age = Date.now() / 1000 - mtime;
      return age > heartbeatStaleThreshold();
    },
    ensure_running(): number | null {
      return null;
    },
    enqueue_dirty(
      rel_path: string,
      project_hash?: string | null,
      opts?: { project_root?: string | null; project_marker?: string | null },
    ): void {
      // Mirror worker.enqueue_dirty's append-only write.
      const queuePath = paths.dirtyQueuePath();
      paths.ensureDir(path.dirname(queuePath));
      const entry: Record<string, unknown> = {
        path: rel_path,
        project_hash: project_hash ?? null,
        ts: Date.now() / 1000,
      };
      if (opts?.project_root != null) {
        entry["project_root"] = opts.project_root;
      }
      if (opts?.project_marker != null) {
        entry["project_marker"] = opts.project_marker;
      }
      fs.appendFileSync(queuePath, JSON.stringify(entry) + "\n", {
        encoding: "utf-8",
      });
    },
    WORKER_RESTART_THROTTLE_SECS: 30.0,
  };
  return { ...base, ...overrides };
}

afterEach(() => {
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// _nudge_worker_if_down
// ---------------------------------------------------------------------------

describe("TestNudgeWorkerIfDown", () => {
  it("test_fresh_heartbeat_skips_respawn", () => {
    paths.ensureDirs();
    const hb = paths.workerHeartbeatPath();
    fs.writeFileSync(hb, "x", { encoding: "utf-8" });

    const ensure = vi.fn(() => 12345 as number | null);
    hooks_edit._setWorkerModule(makeWorkerStub({ ensure_running: ensure }));
    hooks_edit._nudge_worker_if_down();
    expect(ensure).not.toHaveBeenCalled();
  });

  it("test_stale_heartbeat_calls_ensure_running", () => {
    paths.ensureDirs();
    const hb = paths.workerHeartbeatPath();
    fs.writeFileSync(hb, "x", { encoding: "utf-8" });
    fs.utimesSync(hb, 0, 0); // epoch — ancient mtime

    const ensure = vi.fn(() => 12345 as number | null);
    hooks_edit._setWorkerModule(makeWorkerStub({ ensure_running: ensure }));
    hooks_edit._nudge_worker_if_down();
    expect(ensure).toHaveBeenCalledOnce();
  });

  it("test_stale_heartbeat_no_pid_logs_warning", () => {
    paths.ensureDirs();
    const hb = paths.workerHeartbeatPath();
    fs.writeFileSync(hb, "x", { encoding: "utf-8" });
    fs.utimesSync(hb, 0, 0);

    hooks_edit._setWorkerModule(makeWorkerStub({ ensure_running: () => 0 }));
    // Must not raise.
    expect(() => hooks_edit._nudge_worker_if_down()).not.toThrow();
  });

  it("test_exception_in_nudge_is_swallowed", () => {
    hooks_edit._setWorkerModule(
      makeWorkerStub({
        is_heartbeat_stale_for_nudge() {
          throw new Error("boom");
        },
      }),
    );
    // Any exception inside _nudge_worker_if_down must be swallowed (fail-soft).
    expect(() => hooks_edit._nudge_worker_if_down()).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// _enqueue_for_reindex
// ---------------------------------------------------------------------------

describe("TestEnqueueForReindex", () => {
  it("test_relative_path_resolved_against_project_root", () => {
    const tp = tmpPath();
    fs.mkdirSync(path.join(tp, ".git"));
    const src = path.join(tp, "src", "app.py");
    fs.mkdirSync(path.dirname(src));
    fs.writeFileSync(src, "x", { encoding: "utf-8" });

    hooks_edit._setWorkerModule(makeWorkerStub());
    hooks_edit._enqueue_for_reindex("src/app.py", tp);

    const queue = paths.dirtyQueuePath();
    expect(fs.existsSync(queue)).toBe(true);
    const entry = JSON.parse(fs.readFileSync(queue, "utf-8").trim()) as {
      path: string;
    };
    expect(entry.path).toBe("src/app.py");
  });

  it("test_file_outside_project_root_skipped", () => {
    const tp = tmpPath();
    fs.mkdirSync(path.join(tp, ".git"));
    // Relative path with ../ traversal: find_project succeeds (tp has .git) but
    // the resolved abs_path ends up outside the project root -> null -> return.
    hooks_edit._setWorkerModule(makeWorkerStub());
    hooks_edit._enqueue_for_reindex("../../outside/file.py", tp);

    expect(fs.existsSync(paths.dirtyQueuePath())).toBe(false);
  });

  it("test_oserror_on_queue_write_is_logged_not_raised", () => {
    const tp = tmpPath();
    fs.mkdirSync(path.join(tp, ".git"));
    const src = path.join(tp, "file.py");
    fs.writeFileSync(src, "x", { encoding: "utf-8" });

    hooks_edit._setWorkerModule(
      makeWorkerStub({
        enqueue_dirty() {
          throw new Error("disk full");
        },
      }),
    );
    // Must not raise.
    expect(() => hooks_edit._enqueue_for_reindex(src, tp)).not.toThrow();
  });

  it("test_no_project_returns_early", () => {
    const tp = tmpPath();
    hooks_edit._setWorkerModule(makeWorkerStub());
    hooks_edit._enqueue_for_reindex(path.join(tp, "file.py"), tp);
    expect(fs.existsSync(paths.dirtyQueuePath())).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// post_edit
// ---------------------------------------------------------------------------

describe("TestPostEdit", () => {
  it("test_records_session_edit_and_enqueues", () => {
    const tp = tmpPath();
    fs.mkdirSync(path.join(tp, ".git"));
    const fp = path.join(tp, "mod.py");
    fs.writeFileSync(fp, "x", { encoding: "utf-8" });

    hooks_edit._setWorkerModule(makeWorkerStub());
    const payload: HookPayload = {
      session_id: "s-edit-1",
      tool_input: { file_path: fp },
      cwd: tp,
    };
    const result = hooks_edit.post_edit(payload);
    _assert_continue(result as Record<string, unknown>);

    const cache = session.load("s-edit-1");
    const editedKeys = new Set(
      Object.keys(cache.edited_files ?? {}).map((k) =>
        k.toLowerCase().replace(/\\/g, "/"),
      ),
    );
    const want = fp.toLowerCase().replace(/\\/g, "/");
    const hit =
      editedKeys.has(want) || [...editedKeys].some((k) => k.includes(want));
    expect(hit).toBe(true);
  });

  it("test_missing_file_path_returns_continue", () => {
    hooks_edit._setWorkerModule(makeWorkerStub());
    const result = hooks_edit.post_edit({
      session_id: "s-edit-2",
      tool_input: {},
    });
    _assert_continue(result as Record<string, unknown>);
  });

  it("test_no_session_id_still_returns_continue", () => {
    const tp = tmpPath();
    const fp = path.join(tp, "noss.py");
    fs.writeFileSync(fp, "x", { encoding: "utf-8" });
    hooks_edit._setWorkerModule(makeWorkerStub());
    const result = hooks_edit.post_edit({
      tool_input: { file_path: fp },
      cwd: tp,
    });
    _assert_continue(result as Record<string, unknown>);
  });

  it("test_multi_edit_records_all_files", () => {
    const tp = tmpPath();
    fs.mkdirSync(path.join(tp, ".git"));
    const fp1 = path.join(tp, "a.py");
    const fp2 = path.join(tp, "b.py");
    fs.writeFileSync(fp1, "x", { encoding: "utf-8" });
    fs.writeFileSync(fp2, "y", { encoding: "utf-8" });

    hooks_edit._setWorkerModule(makeWorkerStub());
    const sid = "s-multiedit-1";
    const result = hooks_edit.post_edit({
      session_id: sid,
      tool_name: "MultiEdit",
      tool_input: {
        edits: [
          { file_path: fp1, old_string: "x", new_string: "x2" },
          { file_path: fp2, old_string: "y", new_string: "y2" },
        ],
      },
      cwd: tp,
    });
    _assert_continue(result as Record<string, unknown>);

    const cache = session.load(sid);
    const editedKeys = new Set(
      Object.keys(cache.edited_files ?? {}).map((k) =>
        k.toLowerCase().replace(/\\/g, "/"),
      ),
    );
    expect(editedKeys.has(fp1.toLowerCase().replace(/\\/g, "/"))).toBe(true);
    expect(editedKeys.has(fp2.toLowerCase().replace(/\\/g, "/"))).toBe(true);
  });

  it("test_multi_edit_deduplicates_same_file", () => {
    const tp = tmpPath();
    fs.mkdirSync(path.join(tp, ".git"));
    const fp = path.join(tp, "dup.py");
    fs.writeFileSync(fp, "x", { encoding: "utf-8" });

    hooks_edit._setWorkerModule(makeWorkerStub());
    const sid = "s-multiedit-dup";
    const result = hooks_edit.post_edit({
      session_id: sid,
      tool_name: "MultiEdit",
      tool_input: {
        edits: [
          { file_path: fp, old_string: "x", new_string: "x2" },
          { file_path: fp, old_string: "x2", new_string: "x3" },
        ],
      },
      cwd: tp,
    });
    _assert_continue(result as Record<string, unknown>);

    const cache = session.load(sid);
    const editedKeys = new Set(
      Object.keys(cache.edited_files ?? {}).map((k) =>
        k.toLowerCase().replace(/\\/g, "/"),
      ),
    );
    expect(editedKeys.has(fp.toLowerCase().replace(/\\/g, "/"))).toBe(true);
  });

  it("test_multi_edit_empty_edits_returns_continue", () => {
    hooks_edit._setWorkerModule(makeWorkerStub());
    const result = hooks_edit.post_edit({
      session_id: "s-multiedit-empty",
      tool_name: "MultiEdit",
      tool_input: { edits: [] },
    });
    _assert_continue(result as Record<string, unknown>);
  });

  it("test_multi_edit_malformed_edits_entries_skipped", () => {
    const tp = tmpPath();
    fs.mkdirSync(path.join(tp, ".git"));
    const fp = path.join(tp, "c.py");
    fs.writeFileSync(fp, "z", { encoding: "utf-8" });

    hooks_edit._setWorkerModule(makeWorkerStub());
    const sid = "s-multiedit-bad";
    const result = hooks_edit.post_edit({
      session_id: sid,
      tool_name: "MultiEdit",
      tool_input: {
        edits: [
          "not-a-dict",
          null,
          { file_path: fp, old_string: "z", new_string: "z2" },
        ],
      },
      cwd: tp,
    });
    _assert_continue(result as Record<string, unknown>);

    const cache = session.load(sid);
    const editedKeys = new Set(
      Object.keys(cache.edited_files ?? {}).map((k) =>
        k.toLowerCase().replace(/\\/g, "/"),
      ),
    );
    expect(editedKeys.has(fp.toLowerCase().replace(/\\/g, "/"))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// _extract_edited_paths
// ---------------------------------------------------------------------------

describe("TestExtractEditedPaths", () => {
  it("test_single_file_path", () => {
    expect(hooks_edit._extract_edited_paths({ file_path: "/src/foo.py" })).toEqual([
      "/src/foo.py",
    ]);
  });

  it("test_empty_tool_input", () => {
    expect(hooks_edit._extract_edited_paths({})).toEqual([]);
  });

  it("test_multiedit_edits_array", () => {
    const result = hooks_edit._extract_edited_paths({
      edits: [
        { file_path: "/src/a.py", old_string: "x", new_string: "y" },
        { file_path: "/src/b.py", old_string: "a", new_string: "b" },
      ],
    });
    expect(result).toEqual(["/src/a.py", "/src/b.py"]);
  });

  it("test_multiedit_deduplicates", () => {
    const result = hooks_edit._extract_edited_paths({
      edits: [
        { file_path: "/src/a.py", old_string: "x", new_string: "y" },
        { file_path: "/src/a.py", old_string: "y", new_string: "z" },
      ],
    });
    expect(result).toEqual(["/src/a.py"]);
  });

  it("test_multiedit_empty_edits", () => {
    expect(hooks_edit._extract_edited_paths({ edits: [] })).toEqual([]);
  });

  it("test_multiedit_non_dict_entries_skipped", () => {
    const result = hooks_edit._extract_edited_paths({
      edits: ["not-a-dict", null, { file_path: "/src/c.py" }],
    });
    expect(result).toEqual(["/src/c.py"]);
  });

  it("test_file_path_takes_precedence_over_edits", () => {
    const result = hooks_edit._extract_edited_paths({
      file_path: "/src/foo.py",
      edits: [{ file_path: "/src/bar.py" }],
    });
    expect(result).toEqual(["/src/foo.py"]);
  });
});
