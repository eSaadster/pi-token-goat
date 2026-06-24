/**
 * Tests for the hook dispatcher's fail-soft and dispatch behavior.
 *
 * 1:1 port of tests/test_hooks_dispatcher.py — PART 1/2.
 *
 * Scope of this file (matches the Python source, lines ~1-694):
 *   - the top-level dispatch-mechanism test functions (unknown-event, fail_soft,
 *     read_payload, emit)
 *   - TestReadPayloadEdgeCases
 *   - TestSafeRun
 *   - TestNormalizePayload
 *   - TestSetupLogging
 *
 * Deferred / skipped (each carries a "// PORT:" reason, counted in the report):
 *   - The session-start / post-edit dispatch tests route to Layer-5 handler
 *     modules (hooks_session / hooks_edit) that are NOT YET PORTED. The lazy
 *     proxy degrades them to CONTINUE, so the *mechanism* (continue:true) still
 *     holds, but the tests assert behaviours owned by those handlers (project
 *     marker detection, dirty-queue enqueue, worker watchdog). They land with
 *     Layer 5/6.
 *   - The TestSafeRun tests that `monkeypatch.setattr(hc, "dispatch", …)` /
 *     `denormalize_response` / `read_payload`: in Python safe_run looks those
 *     names up on the module object, so a monkeypatch is observed. In the TS
 *     port safe_run calls the LEXICALLY-bound dispatch/denormalize_response/
 *     read_payload (not via a self-namespace), so a vi.spyOn on the module
 *     export is invisible to safe_run. Reproducing the test would require an
 *     implementation change (route those calls through a self `import * as`),
 *     which is out of scope for a 1:1 test port. Skipped with a reason.
 *   - TestSetupLogging exercises Python's logging.Handler / NullHandler fallback.
 *     The TS _setup_logging is console-backed (util.getLogger) — it has no
 *     `_LOG.handlers` list and never installs a NullHandler; its fail-soft
 *     contract is "swallow OSError and keep the console logger", a different
 *     internal shape. The two handler-list assertions have no TS analogue.
 *
 * Test-seam mapping (Python → TS), mirroring tests/test_config.test.ts:
 *   - tmp_path                  → fs.mkdtempSync under os.tmpdir()
 *   - capsys.readouterr().out   → a vi.spyOn(process.stdout, "write") capture
 *                                 (emit() writes UTF-8 bytes then text; we decode
 *                                 every recorded chunk and concatenate).
 *   - monkeypatch.setattr(sys.stdin, …) for the empty-stdin read_payload test →
 *     read_payload(undefined) reads fd 0 synchronously; under vitest fd 0 is not
 *     a readable pipe, so readStdinSync() returns "" — the same empty-input path
 *     the StringIO("") monkeypatch produced. (Asserted as {} below.)
 *   - assert_continue helper    → ported verbatim as _assert_continue.
 *   - dispatch / safe_run are ASYNC in the TS port (the watchdog races the
 *     handler promise against a timer) → every test that calls them uses an
 *     async it() and awaits.
 */
import { describe, it, expect, vi, afterEach } from "vitest";

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import * as hooks_cli from "../src/token_goat/hooks_cli.js";
import * as worker from "../src/token_goat/worker.js";
import * as project_mod from "../src/token_goat/project.js";
import * as paths from "../src/token_goat/paths.js";
import { canonicalize, project_hash } from "../src/token_goat/project.js";

// ---------------------------------------------------------------------------
// Shared helpers (port of tests/hook_helpers.py assert_continue + tmp_path).
// ---------------------------------------------------------------------------

/**
 * Assert `continue: true`, tolerating extra diagnostic fields from dispatch.
 * Verbatim port of hook_helpers.assert_continue.
 */
function _assert_continue(result: Record<string, unknown>): void {
  expect(result["continue"]).toBe(true);
}

/** Throwaway tmp dir (pytest tmp_path analogue). */
function tmpDir(prefix = "tg-hooksdisp-"): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

/**
 * Install a vi.spyOn capture on process.stdout.write and return a reader that
 * decodes every recorded chunk (Buffer or string) and concatenates them —
 * the analogue of capsys.readouterr().out. emit() writes raw UTF-8 bytes first
 * (and falls back to a text write), so chunks may be Buffer or string.
 */
function captureStdout(): { read: () => string; restore: () => void } {
  const chunks: string[] = [];
  const spy = vi
    .spyOn(process.stdout, "write")
    .mockImplementation((chunk: unknown): boolean => {
      if (typeof chunk === "string") {
        chunks.push(chunk);
      } else if (chunk instanceof Uint8Array) {
        chunks.push(Buffer.from(chunk).toString("utf8"));
      } else {
        chunks.push(String(chunk));
      }
      return true;
    });
  return {
    read: () => chunks.join(""),
    restore: () => spy.mockRestore(),
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

// ===========================================================================
// Top-level dispatch-mechanism tests (Python lines ~11-103).
// ===========================================================================

it("test_unknown_event_returns_continue", async () => {
  const result = await hooks_cli.dispatch("not-a-real-event", {});
  _assert_continue(result);
});

it.skip(
  "test_session_start_no_cwd_does_not_crash",
  async () => {
    // PORT: deferred — session-start routes to the Layer-5 hooks_session
    // handler (not yet ported); the lazy proxy degrades to CONTINUE so the
    // assertion would pass vacuously. Lands with hooks_session (Layer 5).
  },
);

it.skip(
  "test_session_start_with_project_marker",
  async () => {
    // PORT: deferred — exercises the Layer-5 hooks_session project-marker
    // detection path (not yet ported). Lands with hooks_session (Layer 5).
  },
);

it.skip(
  "test_session_start_with_unknown_cwd_no_crash",
  async () => {
    // PORT: deferred — Layer-5 hooks_session handler path (not yet ported).
    // Lands with hooks_session (Layer 5).
  },
);

it("test_fail_soft_swallows_exceptions", async () => {
  // If a handler raises, dispatch must still return continue:true with error info.
  const boom = hooks_cli.fail_soft((_payload) => {
    throw new Error("intentional");
  });
  const result = await boom({ any: "payload" });
  expect(result["continue"]).toBe(true);
  expect("_tg_error" in result).toBe(true);
  // Python asserts "RuntimeError" in the summary; the TS analogue of a bare
  // RuntimeError("...") raise is `new Error(...)`, whose constructor name is
  // "Error" — fail_soft formats it as "Error: intentional".
  expect(String(result["_tg_error"])).toContain("Error");
});

it("test_fail_soft_catches_base_exception_memory_error", async () => {
  // BaseException subclasses like MemoryError must also be caught. JS has no
  // MemoryError; the faithful analogue is "fail_soft catches every thrown
  // value, not just a particular subclass". Throw a custom error class whose
  // name stands in for MemoryError and assert it is caught + named.
  class MemoryError extends Error {
    constructor(message?: string) {
      super(message);
      this.name = "MemoryError";
    }
  }
  const explode = hooks_cli.fail_soft((_payload) => {
    throw new MemoryError("out of memory");
  });
  const result = await explode({ any: "payload" });
  expect(result["continue"]).toBe(true);
  expect(String(result["_tg_error"])).toContain("MemoryError");
});

it.skip(
  "test_fail_soft_re_raises_system_exit",
  async () => {
    // PORT: deferred — SystemExit / process-control propagation has no JS
    // analogue thrown from this path. The TS fail_soft deliberately broadens to
    // catch EVERY thrown value (there is no KeyboardInterrupt/SystemExit to
    // re-raise), so "must propagate" is not expressible. Documented in the
    // implementation's fail_soft doc comment.
  },
);

it.skip(
  "test_fail_soft_re_raises_keyboard_interrupt",
  async () => {
    // PORT: deferred — KeyboardInterrupt has no JS analogue; see
    // test_fail_soft_re_raises_system_exit. The TS fail_soft catches every
    // thrown value by design.
  },
);

it("test_read_payload_from_file", () => {
  const f = path.join(tmpDir(), "payload.json");
  fs.writeFileSync(f, '{"session_id": "abc", "tool_name": "Read"}', "utf8");
  const payload = hooks_cli.read_payload(f);
  expect(payload["session_id"]).toBe("abc");
});

it("test_read_payload_empty_stdin_returns_empty_dict", () => {
  // Python monkeypatched sys.stdin to io.StringIO(""). The TS analogue is the
  // _set_stdin_reader seam — inject empty input so read_payload() takes the same
  // empty-input branch (returns {}) WITHOUT a real synchronous fd-0 read (which
  // would block forever under the test runner). clearModuleCaches() in setup.ts
  // restores the default fd-0 reader before the next test.
  hooks_cli._set_stdin_reader(() => "");
  expect(hooks_cli.read_payload()).toEqual({});
});

it("test_emit_writes_json", () => {
  const cap = captureStdout();
  try {
    hooks_cli.emit({ continue: true, hookSpecificOutput: { x: 1 } });
  } finally {
    cap.restore();
  }
  const parsed = JSON.parse(cap.read());
  expect(parsed["continue"]).toBe(true);
  expect(parsed["hookSpecificOutput"]["x"]).toBe(1);
});

// ===========================================================================
// post_edit — must enqueue edited files for incremental reindex
// (Python lines ~110-281). Route to the ported hooks_edit handler + the worker
// module. TOKEN_GOAT_NO_WORKER_SPAWN=1 (set in setup.ts) keeps ensure_running's
// spawn_detached a no-op so no real daemon is forked.
// ===========================================================================

it("test_post_edit_enqueues_dirty_file", async () => {
  // Regression: post_edit must append the edited file to the dirty queue.
  // realpath the tmp root so it matches find_project's canonicalized
  // project.root (macOS /var → /private/var symlink), keeping the relative-path
  // containment check from escaping the root.
  const proj_root = path.join(fs.realpathSync(tmpDir()), "myproj");
  fs.mkdirSync(proj_root, { recursive: true });
  fs.mkdirSync(path.join(proj_root, ".git"), { recursive: true });
  const editedDir = path.join(proj_root, "src");
  fs.mkdirSync(editedDir, { recursive: true });
  const edited = path.join(editedDir, "module.py");
  fs.writeFileSync(edited, "def f(): pass\n", "utf8");

  const result = await hooks_cli.dispatch("post-edit", {
    session_id: "sess-1",
    cwd: proj_root,
    tool_name: "Edit",
    tool_input: { file_path: edited },
  });
  _assert_continue(result);

  const queue_path = paths.dirtyQueuePath();
  expect(fs.existsSync(queue_path), "dirty queue file was not created").toBe(true);
  const lines = fs
    .readFileSync(queue_path, "utf8")
    .split("\n")
    .filter((ln) => ln.trim());
  expect(lines.length, `expected exactly one queued entry, got: ${lines}`).toBe(1);
  const entry = JSON.parse(lines[0]!);
  expect(entry["path"]).toBe("src/module.py");
  expect(entry["project_hash"]).toBe(project_hash(canonicalize(proj_root)));
  expect("ts" in entry).toBe(true);
});

it("test_post_edit_file_outside_project_does_not_enqueue", async () => {
  // A file with no detectable project must not crash and must not enqueue.
  // Force "no project" deterministically (a stray ancestor marker could
  // otherwise be detected on the test machine's temp dir).
  const findSpy = vi.spyOn(project_mod, "find_project").mockReturnValue(null);
  // ensure_running is a no-op spy so the watchdog cannot fork a daemon.
  const runSpy = vi.spyOn(worker, "ensure_running").mockReturnValue(null);

  const base = tmpDir();
  const stray = path.join(base, "stray.py");
  fs.writeFileSync(stray, "x = 1\n", "utf8");

  const result = await hooks_cli.dispatch("post-edit", {
    session_id: "sess-2",
    cwd: base,
    tool_name: "Edit",
    tool_input: { file_path: stray },
  });
  _assert_continue(result);

  const queue_path = paths.dirtyQueuePath();
  const queued = fs.existsSync(queue_path) && fs.readFileSync(queue_path, "utf8").trim();
  expect(Boolean(queued), "no project detected — nothing should have been enqueued").toBe(false);

  findSpy.mockRestore();
  runSpy.mockRestore();
});

it("test_post_edit_nudges_worker_when_heartbeat_missing", async () => {
  // post_edit feeds the dirty queue, so it must make sure something will drain
  // it: with no fresh heartbeat, the watchdog calls ensure_running().
  vi.spyOn(project_mod, "find_project").mockReturnValue(null);
  const called: boolean[] = [];
  vi.spyOn(worker, "ensure_running").mockImplementation(() => {
    called.push(true);
    return null;
  });

  const base = tmpDir();
  const stray = path.join(base, "edited.py");
  fs.writeFileSync(stray, "x = 1\n", "utf8");
  // No heartbeat file → worker considered down.

  const result = await hooks_cli.dispatch("post-edit", {
    session_id: "sess-hb-missing",
    cwd: base,
    tool_name: "Edit",
    tool_input: { file_path: stray },
  });
  _assert_continue(result);
  expect(called, "a down worker must be respawned from post_edit").toEqual([true]);
});

it("test_post_edit_skips_nudge_when_heartbeat_fresh", async () => {
  // A fresh heartbeat means the worker is alive — the watchdog must not respawn
  // it (the common path stays a single stat() with no respawn).
  vi.spyOn(project_mod, "find_project").mockReturnValue(null);
  const called: boolean[] = [];
  vi.spyOn(worker, "ensure_running").mockImplementation(() => {
    called.push(true);
    return null;
  });

  paths.ensureDirs();
  fs.writeFileSync(paths.workerHeartbeatPath(), String(Date.now() / 1000), "utf8");

  const base = tmpDir();
  const stray = path.join(base, "edited.py");
  fs.writeFileSync(stray, "x = 1\n", "utf8");

  const result = await hooks_cli.dispatch("post-edit", {
    session_id: "sess-hb-fresh",
    cwd: base,
    tool_name: "Edit",
    tool_input: { file_path: stray },
  });
  _assert_continue(result);
  expect(called, "a live worker must not be respawned").toEqual([]);
});

it("test_post_edit_nudges_worker_when_heartbeat_stale", async () => {
  // A heartbeat file that exists but is older than the freshness window means
  // the worker hung or died — post_edit must respawn it, same as a missing one.
  vi.spyOn(project_mod, "find_project").mockReturnValue(null);
  const called: boolean[] = [];
  vi.spyOn(worker, "ensure_running").mockImplementation(() => {
    called.push(true);
    return null;
  });

  paths.ensureDirs();
  const hb = paths.workerHeartbeatPath();
  fs.writeFileSync(hb, "stale", "utf8");
  // Backdate the heartbeat well past the freshness window.
  const old = Date.now() / 1000 - 600;
  fs.utimesSync(hb, old, old);

  const base = tmpDir();
  const stray = path.join(base, "edited.py");
  fs.writeFileSync(stray, "x = 1\n", "utf8");

  const result = await hooks_cli.dispatch("post-edit", {
    session_id: "sess-hb-stale",
    cwd: base,
    tool_name: "Edit",
    tool_input: { file_path: stray },
  });
  _assert_continue(result);
  expect(called, "a worker with a stale heartbeat must be respawned").toEqual([true]);
});

// ===========================================================================
// read_payload — JSON decode error and OSError paths (Python lines ~288-324).
// ===========================================================================

describe("TestReadPayloadEdgeCases", () => {
  it("test_invalid_json_returns_empty_dict", () => {
    // A file with invalid JSON must return {} rather than raising.
    const bad = path.join(tmpDir(), "bad.json");
    fs.writeFileSync(bad, "{ not valid json !!!}", "utf8");
    expect(hooks_cli.read_payload(bad)).toEqual({});
  });

  it("test_non_dict_json_returns_empty_dict", () => {
    // A JSON array (valid JSON but not a dict) must coerce to {}.
    const arr = path.join(tmpDir(), "arr.json");
    fs.writeFileSync(arr, "[1, 2, 3]", "utf8");
    expect(hooks_cli.read_payload(arr)).toEqual({});
  });

  it("test_json_null_returns_empty_dict", () => {
    // JSON null payload coerces to {}.
    const nullf = path.join(tmpDir(), "null.json");
    fs.writeFileSync(nullf, "null", "utf8");
    expect(hooks_cli.read_payload(nullf)).toEqual({});
  });

  it("test_missing_file_returns_empty_dict", () => {
    // An OSError reading the payload file must return {} not raise.
    const missing = path.join(tmpDir(), "does_not_exist.json");
    expect(hooks_cli.read_payload(missing)).toEqual({});
  });

  it("test_valid_json_dict_is_returned", () => {
    // A valid dict payload is returned as-is.
    const f = path.join(tmpDir(), "ok.json");
    fs.writeFileSync(f, '{"session_id": "s1", "tool_name": "Write"}', "utf8");
    const result = hooks_cli.read_payload(f);
    expect(result["session_id"]).toBe("s1");
    expect(result["tool_name"]).toBe("Write");
  });
});

// ===========================================================================
// safe_run — end-to-end harness path (Python lines ~331-492).
// ===========================================================================

describe("TestSafeRun", () => {
  it("test_safe_run_unknown_event_emits_continue", async () => {
    // safe_run with an unknown event must emit {"continue": true} to stdout.
    const payloadFile = path.join(tmpDir(), "payload.json");
    fs.writeFileSync(payloadFile, '{"session_id": "x"}', "utf8");
    const cap = captureStdout();
    try {
      await hooks_cli.safe_run("no-such-event", payloadFile);
    } finally {
      cap.restore();
    }
    const parsed = JSON.parse(cap.read());
    expect(parsed["continue"]).toBe(true);
  });

  it("test_safe_run_known_event_emits_continue", async () => {
    // safe_run with a known event (session-start, no cwd) still exits cleanly.
    // session-start routes to a not-yet-ported Layer-5 handler whose lazy proxy
    // degrades to CONTINUE — the emitted {"continue": true} is identical either
    // way, so this dispatch-MECHANISM test ports live.
    const payloadFile = path.join(tmpDir(), "payload.json");
    fs.writeFileSync(payloadFile, '{"session_id": "abc"}', "utf8");
    const cap = captureStdout();
    try {
      await hooks_cli.safe_run("session-start", payloadFile);
    } finally {
      cap.restore();
    }
    const parsed = JSON.parse(cap.read());
    expect(parsed["continue"]).toBe(true);
  });

  it.skip(
    "test_safe_run_codex_harness_denormalizes_output",
    async () => {
      // PORT: deferred — monkeypatches hc.dispatch to return a fixed dict. The
      // TS safe_run calls the LEXICALLY-bound dispatch (not via a self
      // `import * as`), so a vi.spyOn(hooks_cli, "dispatch") is invisible to
      // safe_run. Porting would require routing safe_run's dispatch call through
      // the module namespace — an implementation change out of scope for a 1:1
      // test port. (denormalize_response's codex camelCase/_tg_* stripping is
      // covered directly elsewhere.)
    },
  );

  it("test_safe_run_with_invalid_payload_file_emits_continue", async () => {
    // safe_run must emit continue:true even when the payload file is corrupt.
    const bad = path.join(tmpDir(), "bad.json");
    fs.writeFileSync(bad, "not-json", "utf8");
    const cap = captureStdout();
    try {
      await hooks_cli.safe_run("session-start", bad);
    } finally {
      cap.restore();
    }
    const parsed = JSON.parse(cap.read());
    expect(parsed["continue"]).toBe(true);
  });

  it.skip(
    "test_safe_run_denormalize_failure_emits_dispatch_output",
    async () => {
      // PORT: deferred — monkeypatches both hc.dispatch and hc.denormalize_response.
      // safe_run calls both lexically (not via a self-namespace), so vi.spyOn on
      // the module exports is invisible to it. See
      // test_safe_run_codex_harness_denormalizes_output.
    },
  );

  it.skip(
    "test_safe_run_crash_writes_hooks_stderr_log",
    async () => {
      // PORT: deferred — forces a crash by monkeypatching hc.dispatch to raise.
      // safe_run calls the lexical dispatch, so vi.spyOn cannot make it throw,
      // and a handler that throws is swallowed by dispatch's fail_soft/safety
      // net (never propagates to safe_run's outer try/catch). The crash-sink
      // write path is therefore unreachable from a 1:1 test without an
      // implementation change.
    },
  );

  it.skip(
    "test_safe_run_crash_log_rolls_over_when_oversized",
    async () => {
      // PORT: deferred — same root cause as test_safe_run_crash_writes_hooks_stderr_log:
      // the crash path requires making the lexically-bound dispatch raise, which
      // a vi.spyOn on the export cannot do.
    },
  );
});

// ===========================================================================
// normalize_payload — codex harness path (Python lines ~499-516).
// ===========================================================================

describe("TestNormalizePayload", () => {
  it("test_claude_harness_returns_payload_unchanged", () => {
    const payload = { session_id: "s", tool_name: "Read", turn_id: "t1" };
    const result = hooks_cli.normalize_payload(payload, "claude");
    // normalize_payload stamps _tg_harness; original keys must survive.
    expect(result["session_id"]).toBe("s");
    expect(result["tool_name"]).toBe("Read");
    expect(result["_tg_harness"]).toBe("claude");
  });

  it("test_codex_harness_returns_payload_unchanged", () => {
    // Codex payload is structurally identical; normalize_payload stamps _tg_harness.
    const payload = { session_id: "s", tool_name: "Read", turn_id: "t1" };
    const result = hooks_cli.normalize_payload(payload, "codex");
    expect(result["session_id"]).toBe("s");
    expect(result["tool_name"]).toBe("Read");
    expect(result["_tg_harness"]).toBe("codex");
  });
});

// ===========================================================================
// _setup_logging — OSError fallback installs NullHandler (Python lines ~523-603).
// ===========================================================================

describe("TestSetupLogging", () => {
  it.skip(
    "test_setup_logging_fallback_on_oserror",
    () => {
      // PORT: deferred — asserts that a NullHandler is installed on the
      // "token_goat.hooks" logger when paths.ensure_dirs() raises OSError. The TS
      // _setup_logging is console-backed (util.getLogger): it has no `_LOG.handlers`
      // list and never constructs a logging.NullHandler. Its OSError fallback is
      // "swallow and keep the console logger working" (a try/catch with no
      // observable handler-list mutation), so the handler-list assertion has no
      // TS analogue.
    },
  );

  it.skip(
    "test_setup_logging_idempotent",
    () => {
      // PORT: deferred — asserts no duplicate logging.Handler is added on a
      // second call by inspecting `_LOG.handlers`. The TS _setup_logging guards
      // on a cached date string (_log_date_cached), not a handler list, and the
      // console logger has no handler-list surface to assert against. The
      // idempotence shape differs; no faithful 1:1 assertion exists.
    },
  );
});
