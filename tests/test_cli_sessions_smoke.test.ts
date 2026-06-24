/**
 * Wrapper dispatch smoke tests for the 7 batch-C1 session commands WITHOUT a
 * dedicated CLI test in the Python suite: cache-audit, session-touched,
 * session-mark, decision, pinned, resume, recovery.
 *
 * Mirrors test_cli_surgical's dispatch-smoke style: seed a real session (via
 * session.save, same pattern as test_session_summary), invoke the command
 * through the CliRunner, and assert basic exit-code + output behavior. The
 * heavy module internals (resume packet body, recovery-hint body) are validated
 * by their own module tests; here we only verify the commander wrapper parses
 * args/flags and dispatches to the right impl with the right exit semantics.
 *
 * `decision`/`pinned`/`resume`/`recovery` resolve the session by scanning the
 * sessions dir, so seeding a real session file is enough (no project/git work).
 * `session-touched`/`session-mark` take an explicit --session-id and validate
 * it via cli_sessions.validateSessionId. `cache-audit` reads settings.json /
 * CLAUDE.md (absent under the isolated data dir → reports "not found").
 */
import { describe, it, expect, afterEach, vi } from "vitest";

import { invoke } from "./_cli_runner.js";
import * as session from "../src/token_goat/session.js";
import * as paths from "../src/token_goat/paths.js";

afterEach(() => {
  vi.restoreAllMocks();
});

/** Seed a minimal session with one read file and return its id. */
function _seedSession(sessionId: string): string {
  const now = Date.now() / 1000;
  const sess = new session.SessionCache({
    session_id: sessionId,
    started_ts: now - 60,
    last_activity_ts: now,
  });
  sess.files = {
    "src/foo.py": new session.FileEntry({
      rel_or_abs: "src/foo.py",
      read_count: 1,
      line_ranges: [[1, 10]],
      symbols_read: ["greet"],
      last_read_ts: now,
    }),
  };
  sess.cwd = paths.dataDir();
  session.save(sess);
  return sessionId;
}

describe("cli batch C1 smoke — cache-audit", () => {
  it("dispatches and reports when settings.json is absent", async () => {
    // Under the isolated data dir, no Claude settings.json exists, so the
    // command reports the not-found issue and exits 0.
    const r = await invoke(["cache-audit"]);
    expect(r.exit_code).toBe(0);
    // Either the "issues found" path or the "no patterns" path is acceptable.
    expect(
      r.stdout.includes("Cache-busting issues found:") ||
        r.stdout.includes("No obvious cache-busting patterns detected."),
    ).toBe(true);
  });
});

describe("cli batch C1 smoke — session-touched", () => {
  it("dispatches and lists touched files for a real session", async () => {
    const sid = _seedSession("smoke-touched-sess");
    const r = await invoke(["session-touched", "-s", sid]);
    expect(r.exit_code).toBe(0);
    expect(r.stdout).toContain("src/foo.py");
    expect(r.stdout).toContain("reads=1");
  });

  it("dispatches --json and emits a compact JSON array", async () => {
    const sid = _seedSession("smoke-touched-json");
    const r = await invoke(["session-touched", "-s", sid, "--json"]);
    expect(r.exit_code).toBe(0);
    const arr = JSON.parse(r.stdout) as Array<Record<string, unknown>>;
    expect(Array.isArray(arr)).toBe(true);
    expect(arr.length).toBe(1);
    expect(arr[0]!["path"]).toBe("src/foo.py");
  });

  it("rejects an invalid session id with exit 1", async () => {
    // An id with a path separator is invalid (session.validate_session_id rejects).
    const r = await invoke(["session-touched", "-s", "bad/id"]);
    expect(r.exit_code).toBe(1);
  });
});

describe("cli batch C1 smoke — session-mark (hidden)", () => {
  it("dispatches, marks a file read, and echoes 'ok'", async () => {
    const sid = _seedSession("smoke-mark-sess");
    const r = await invoke([
      "session-mark",
      "src/new.py",
      "-s",
      sid,
      "--offset",
      "5",
      "--limit",
      "20",
    ]);
    expect(r.exit_code).toBe(0);
    expect(r.stdout).toContain("ok");
    // Verify the mark persisted.
    const reloaded = session.safe_load(sid);
    expect(reloaded).not.toBeNull();
    expect(Object.keys(reloaded!.files)).toContain("src/new.py");
  });

  it("rejects an invalid session id with exit 1", async () => {
    const r = await invoke(["session-mark", "src/x.py", "-s", "bad id"]);
    expect(r.exit_code).toBe(1);
  });
});

describe("cli batch C1 smoke — decision", () => {
  it("dispatches and records a decision for the resolved session", async () => {
    const sid = _seedSession("smoke-decision-sess");
    const r = await invoke([
      "decision",
      "Picked option A over B",
      "-s",
      sid,
      "-t",
      "rationale",
    ]);
    expect(r.exit_code).toBe(0);
    expect(r.stdout).toContain("recorded decision");
    // Verify the decision persisted.
    const reloaded = session.safe_load(sid);
    expect(reloaded).not.toBeNull();
    expect(reloaded!.decisions.length).toBe(1);
    expect(reloaded!.decisions[0]!.text).toBe("Picked option A over B");
    expect(reloaded!.decisions[0]!.tag).toBe("rationale");
  });

  it("dispatches --list and shows recorded decisions", async () => {
    const sid = _seedSession("smoke-decision-list");
    // Record one decision first.
    session.mark_decision(sid, "First decision", { tag: "invariant" });
    const r = await invoke(["decision", "--list", "-s", sid]);
    expect(r.exit_code).toBe(0);
    expect(r.stdout).toContain("[invariant] First decision");
  });

  it("dispatches --list on a session with no decisions and exits 0", async () => {
    const sid = _seedSession("smoke-decision-empty");
    const r = await invoke(["decision", "--list", "-s", sid]);
    expect(r.exit_code).toBe(0);
    expect(r.stdout).toContain("no decisions recorded");
  });

  it("errors on empty text without --list (exit 1)", async () => {
    const sid = _seedSession("smoke-decision-emptytext");
    // commander: an omitted optional positional arrives as undefined → the
    // wrapper passes "" (the Python default). Empty text without --list errors.
    const r = await invoke(["decision", "-s", sid]);
    expect(r.exit_code).toBe(1);
  });
});

describe("cli batch C1 smoke — pinned", () => {
  it("dispatches 'add' and pins a symbol spec", async () => {
    const sid = _seedSession("smoke-pinned-add");
    const r = await invoke(["pinned", "add", "src/foo.py::greet", "-s", sid]);
    expect(r.exit_code).toBe(0);
    expect(r.stdout).toContain("pinned: src/foo.py::greet");
    const reloaded = session.safe_load(sid);
    expect(reloaded!.pinned_symbols).toContain("src/foo.py::greet");
  });

  it("dispatches 'list' and shows pinned symbols", async () => {
    const sid = _seedSession("smoke-pinned-list");
    const cache = session.safe_load(sid)!;
    cache.add_pinned("src/foo.py::greet");
    session.save(cache);
    const r = await invoke(["pinned", "list", "-s", sid]);
    expect(r.exit_code).toBe(0);
    expect(r.stdout).toContain("src/foo.py::greet");
  });

  it("dispatches 'remove' and unpins a symbol spec", async () => {
    const sid = _seedSession("smoke-pinned-remove");
    const cache = session.safe_load(sid)!;
    cache.add_pinned("src/foo.py::greet");
    session.save(cache);
    const r = await invoke(["pinned", "remove", "src/foo.py::greet", "-s", sid]);
    expect(r.exit_code).toBe(0);
    expect(r.stdout).toContain("unpinned: src/foo.py::greet");
    const reloaded = session.safe_load(sid);
    expect(reloaded!.pinned_symbols).not.toContain("src/foo.py::greet");
  });

  it("errors on an unknown action (exit 1)", async () => {
    const sid = _seedSession("smoke-pinned-badaction");
    const r = await invoke(["pinned", "frobnicate", "-s", sid]);
    expect(r.exit_code).toBe(1);
  });
});

describe("cli batch C1 smoke — resume", () => {
  it("dispatches and resolves a full session id (packet or no-state warning)", async () => {
    const sid = _seedSession("smoke-resume-sess");
    // build_resume_packet may return a non-empty packet or "" (no recoverable
    // state) depending on bash_cache/skill_cache side data; both are valid.
    const r = await invoke(["resume", sid]);
    expect([0]).toContain(r.exit_code);
    // Either a packet body or the no-state warning appears.
    expect(r.stdout.length > 0 || r.stderr.length > 0).toBe(true);
  });

  it("errors on an unresolvable short id (exit 1)", async () => {
    const r = await invoke(["resume", "nonexistent-short-id"]);
    expect(r.exit_code).toBe(1);
    expect(r.output.toLowerCase()).toContain("no session found");
  });
});

describe("cli batch C1 smoke — recovery", () => {
  it("dispatches and resolves a full session id (hint or no-state warning)", async () => {
    const sid = _seedSession("smoke-recovery-sess");
    // _build_recovery_hint may return a hint or null (no qualifying entries);
    // both exit 0 (hint echoed, or no-state warning).
    const r = await invoke(["recovery", sid]);
    expect([0]).toContain(r.exit_code);
    expect(r.stdout.length > 0 || r.stderr.length > 0).toBe(true);
  });

  it("dispatches --pending and warns when no sidecar exists (exit 0)", async () => {
    const sid = _seedSession("smoke-recovery-pending");
    const r = await invoke(["recovery", sid, "--pending"]);
    expect(r.exit_code).toBe(0);
    expect(r.stderr.toLowerCase()).toContain("no deferred recovery sidecar");
  });

  it("errors on an unresolvable short id (exit 1)", async () => {
    const r = await invoke(["recovery", "nonexistent-short-id"]);
    expect(r.exit_code).toBe(1);
    expect(r.output.toLowerCase()).toContain("no session found");
  });
});
