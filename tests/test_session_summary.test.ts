/**
 * Tests for the `token-goat session-summary` CLI command — TS port of
 * tests/test_session_summary.py.
 *
 * Seeds real SessionCache objects via session.save() (the Python test does the
 * same), then invokes the command through the CliRunner. setup.ts isolates the
 * data dir per test, so session.save() writes to <tmp>/sessions/<id>.json.
 *
 * The auto-detect test backdates a session file's mtime via fs.utimesSync
 * (Python: os.utime). The env-var test sets CLAUDE_SESSION_ID via a saved/env
 * pair (vi.stubEnv is not restored by restoreAllMocks, so we save/restore
 * manually to keep the afterEach in setup.ts clean).
 *
 * This file REPLACES the prior deferred-stub (every test was it.skip pending
 * the CLI layer; the CLI layer is now ported as cli_sessions.session_summary).
 */
import { describe, it, expect, afterEach, vi } from "vitest";

import fs from "node:fs";

import { invoke } from "./_cli_runner.js";
import * as session from "../src/token_goat/session.js";
import * as paths from "../src/token_goat/paths.js";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("session-summary command (port of test_session_summary.py)", () => {
  it("test_text_output_format — text follows the expected format", async () => {
    const sessionId = "test-session-abc123";
    const now = Date.now() / 1000;
    const sess = new session.SessionCache({
      session_id: sessionId,
      started_ts: now - 300,
      last_activity_ts: now,
    });
    sess.files = {
      "src/foo.py": new session.FileEntry({
        rel_or_abs: "src/foo.py",
        read_count: 2,
        line_ranges: [[1, 50]],
        symbols_read: [],
        last_read_ts: now,
      }),
      "src/bar.py": new session.FileEntry({
        rel_or_abs: "src/bar.py",
        read_count: 1,
        line_ranges: [[10, 20]],
        symbols_read: [],
        last_read_ts: now,
      }),
    };
    sess.edited_files = { "src/baz.py": 3, "src/qux.py": 1 };
    session.save(sess);

    const r = await invoke(["session-summary", "--session-id", sessionId]);
    expect(r.exit_code).toBe(0);
    expect(r.stdout).toContain("Session");
    expect(r.stdout).toContain("test-session"); // short id (first 12 chars)
    expect(r.stdout).toContain("2 files read");
    expect(r.stdout).toContain("2 edited");
    expect(r.stdout).toContain("commits");
    expect(r.stdout).toContain("tokens saved");
  });

  it("test_json_output_structure — JSON has correct structure", async () => {
    const sessionId = "test-json-session";
    const now = Date.now() / 1000;
    const sess = new session.SessionCache({
      session_id: sessionId,
      started_ts: now - 100,
      last_activity_ts: now,
    });
    sess.files = {
      "src/a.py": new session.FileEntry({
        rel_or_abs: "src/a.py",
        read_count: 1,
        line_ranges: [],
        symbols_read: [],
        last_read_ts: now,
      }),
    };
    sess.edited_files = { "src/b.py": 2 };
    session.save(sess);

    const r = await invoke(["session-summary", "--session-id", sessionId, "--json"]);
    expect(r.exit_code).toBe(0);
    const data = JSON.parse(r.stdout) as Record<string, unknown>;
    expect(data["session_id"]).toBe(sessionId);
    expect(data["files_read"]).toBe(1);
    expect(data["files_edited"]).toBe(1);
    expect("commits_this_session" in data).toBe(true);
    expect(typeof data["commits_this_session"]).toBe("number");
    expect("tokens_saved_estimate" in data).toBe(true);
    expect(typeof data["tokens_saved_estimate"]).toBe("number");
  });

  it("test_no_session_text_message — graceful text when no session exists", async () => {
    const r = await invoke(["session-summary", "--session-id", "nonexistent-session-xyz"]);
    expect(r.exit_code).toBe(0);
    expect(r.stdout).toContain("No active session");
  });

  it("test_no_session_json_message — JSON output when no session exists", async () => {
    const r = await invoke([
      "session-summary",
      "--session-id",
      "nonexistent-session-xyz",
      "--json",
    ]);
    expect(r.exit_code).toBe(0);
    const data = JSON.parse(r.stdout) as Record<string, unknown>;
    expect(data["session_id"]).toBe("nonexistent-session-xyz");
    expect(data["files_read"]).toBe(0);
    expect(data["files_edited"]).toBe(0);
    // Python asserts: "message" in data OR commits_this_session == 0.
    expect("message" in data || data["commits_this_session"] === 0).toBe(true);
  });

  it("test_auto_detect_most_recent_session — picks newer of two sessions", async () => {
    const now = Date.now() / 1000;
    const sessionId1 = "old-session-1";
    const sessionId2 = "new-session-2";

    const sess1 = new session.SessionCache({
      session_id: sessionId1,
      started_ts: now - 1000,
      last_activity_ts: now - 1000,
    });
    sess1.files = {
      "src/old.py": new session.FileEntry({
        rel_or_abs: "src/old.py",
        read_count: 1,
        line_ranges: [],
        symbols_read: [],
        last_read_ts: now,
      }),
    };
    session.save(sess1);

    // Backdate sess1's file mtime so sess2 is unambiguously newer without sleeping.
    const sess1Path = paths.sessionCachePath(sessionId1);
    const stat = fs.statSync(sess1Path);
    const pastTs = stat.mtimeMs / 1000 - 2.0;
    fs.utimesSync(sess1Path, pastTs, pastTs);

    const sess2 = new session.SessionCache({
      session_id: sessionId2,
      started_ts: now - 100,
      last_activity_ts: now,
    });
    sess2.files = {
      "src/new.py": new session.FileEntry({
        rel_or_abs: "src/new.py",
        read_count: 2,
        line_ranges: [],
        symbols_read: [],
        last_read_ts: now,
      }),
    };
    sess2.edited_files = { "src/new2.py": 1 };
    session.save(sess2);

    // Auto-detect (no --session-id).
    const r = await invoke(["session-summary"]);
    expect(r.exit_code).toBe(0);
    // Should pick the newer session (sess2).
    expect(
      r.stdout.includes("new-session-2") ||
        r.stdout.includes("2 files read") ||
        r.stdout.includes("1 edited"),
    ).toBe(true);
  });

  it("test_env_var_detection — CLAUDE_SESSION_ID env var resolves the session", async () => {
    const sessionId = "env-test-session";
    const now = Date.now() / 1000;
    const sess = new session.SessionCache({
      session_id: sessionId,
      started_ts: now,
      last_activity_ts: now,
    });
    sess.files = {
      "src/x.py": new session.FileEntry({
        rel_or_abs: "src/x.py",
        read_count: 1,
        line_ranges: [],
        symbols_read: [],
        last_read_ts: now,
      }),
    };
    session.save(sess);

    // Set env var (save/restore — vi.stubEnv isn't restored by restoreAllMocks).
    const prev = process.env["CLAUDE_SESSION_ID"];
    process.env["CLAUDE_SESSION_ID"] = sessionId;
    try {
      const r = await invoke(["session-summary"]);
      expect(r.exit_code).toBe(0);
      // Session ID truncated to 12 chars in output.
      const shortId = sessionId.slice(0, 12);
      expect(r.stdout).toContain(shortId);
    } finally {
      if (prev === undefined) delete process.env["CLAUDE_SESSION_ID"];
      else process.env["CLAUDE_SESSION_ID"] = prev;
    }
  });

  it("test_short_id_in_output — session id truncated to 12 chars", async () => {
    const longSessionId = "this-is-a-very-long-session-id-that-exceeds-twelve-chars";
    const now = Date.now() / 1000;
    const sess = new session.SessionCache({
      session_id: longSessionId,
      started_ts: now,
      last_activity_ts: now,
    });
    session.save(sess);

    const r = await invoke(["session-summary", "--session-id", longSessionId]);
    expect(r.exit_code).toBe(0);
    const shortExpected = longSessionId.slice(0, 12);
    expect(r.stdout).toContain(shortExpected);
  });

  it("test_empty_session — 0 files / 0 edits / 0 commits", async () => {
    const sessionId = "empty-session";
    const now = Date.now() / 1000;
    const sess = new session.SessionCache({
      session_id: sessionId,
      started_ts: now,
      last_activity_ts: now,
    });
    session.save(sess);

    const r = await invoke(["session-summary", "--session-id", sessionId]);
    expect(r.exit_code).toBe(0);
    expect(r.stdout).toContain("0 files read");
    expect(r.stdout).toContain("0 edited");
    expect(r.stdout).toContain("0 commits");
  });

  it("test_json_always_has_required_keys — required keys present even for empty sessions", async () => {
    const sessionId = "minimal-session";
    const now = Date.now() / 1000;
    const sess = new session.SessionCache({
      session_id: sessionId,
      started_ts: now,
      last_activity_ts: now,
    });
    session.save(sess);

    const r = await invoke(["session-summary", "--session-id", sessionId, "--json"]);
    expect(r.exit_code).toBe(0);
    const data = JSON.parse(r.stdout) as Record<string, unknown>;
    const requiredKeys = new Set([
      "session_id",
      "files_read",
      "files_edited",
      "commits_this_session",
      "tokens_saved_estimate",
    ]);
    const missing = [...requiredKeys].filter((k) => !(k in data));
    expect(missing, `Missing keys: ${missing.join(", ")}`).toEqual([]);
  });
});
