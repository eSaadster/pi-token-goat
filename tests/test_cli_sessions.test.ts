/**
 * Tests for `token-goat sessions` and `token-goat sessions-show` — TS port of
 * tests/test_cli_sessions.py.
 *
 * setup.ts sets a per-test throwaway data dir via setDataDirOverride(); since
 * paths.sessionsDir() = dataDir/sessions, each test writes session JSON files
 * directly under that tmp dir. The `_writeSession` helper mirrors the Python
 * `_write_session` helper (same payload shape).
 */
import { describe, it, expect, afterEach, vi } from "vitest";

import fs from "node:fs";
import path from "node:path";

import { invoke } from "./_cli_runner.js";
import * as paths from "../src/token_goat/paths.js";

interface WriteSessionOpts {
  cwd?: string;
  lastActive?: number | null;
  files?: Record<string, unknown> | null;
  edited?: Record<string, number> | null;
  hints?: number;
  bash?: Record<string, unknown> | null;
  web?: Record<string, unknown> | null;
}

/**
 * Write a session JSON file under <dataDir>/sessions/<id>.json. Mirrors the
 * Python `_write_session` payload (the fields the sessions/sessions-show
 * commands read + a few required-by-the-loader fields for forward-compat).
 */
function _writeSession(sessionId: string, o: WriteSessionOpts = {}): void {
  const sessionsDir = paths.sessionsDir();
  fs.mkdirSync(sessionsDir, { recursive: true });
  const now = Date.now() / 1000;
  const lastActive = o.lastActive ?? null;
  const ts = lastActive !== null ? lastActive : now;
  const payload: Record<string, unknown> = {
    schema_version: 1,
    created_by: "token-goat",
    session_id: sessionId,
    started_ts: ts - 60,
    last_activity_ts: ts,
    created_ts: ts - 60,
    cwd: o.cwd ?? "",
    files: o.files ?? {},
    edited_files: o.edited ?? {},
    hints_emitted: o.hints ?? 0,
    hints_ignored: 0,
    greps: [],
    bash_history: o.bash ?? {},
    web_history: o.web ?? {},
    skill_history: {},
    decisions: [],
    result_cache: {},
    glob_history: [],
    snapshot_shas: {},
    hints_seen: {},
    bash_dedup_emitted_ids: [],
    structured_hints_emitted: 0,
    index_only_hints_emitted: 0,
    hints_emitted_by_type: {},
    hints_suppressed_by_type: {},
    recent_hints: [],
    last_manifest_sha: "",
    last_manifest_ts: 0.0,
    version: 1,
    hint_category_history: {},
    image_shrink_count: {},
  };
  fs.writeFileSync(
    path.join(sessionsDir, `${sessionId}.json`),
    JSON.stringify(payload),
    "utf8",
  );
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("sessions command (port of test_cli_sessions.py TestSessionsCommand)", () => {
  it("test_empty_sessions — no sessions dir yields the empty hint", async () => {
    const r = await invoke(["sessions"]);
    expect(r.exit_code).toBe(0);
    expect(r.stdout.toLowerCase()).toContain("no sessions");
  });

  it("test_lists_sessions — session id + project name appear", async () => {
    _writeSession("abc123", { cwd: "/projects/myapp", hints: 5 });
    const r = await invoke(["sessions"]);
    expect(r.exit_code).toBe(0);
    expect(r.stdout).toContain("abc123");
    expect(r.stdout).toContain("myapp");
  });

  it("test_sorts_newest_first — newer session lists above older", async () => {
    const now = Date.now() / 1000;
    _writeSession("older-session", { cwd: "/p/a", lastActive: now - 7200 });
    _writeSession("newer-session", { cwd: "/p/b", lastActive: now - 60 });
    const r = await invoke(["sessions"]);
    expect(r.exit_code).toBe(0);
    const newerPos = r.stdout.indexOf("newer-session");
    const olderPos = r.stdout.indexOf("older-session");
    expect(newerPos).toBeGreaterThanOrEqual(0);
    expect(olderPos).toBeGreaterThanOrEqual(0);
    expect(newerPos).toBeLessThan(olderPos);
  });

  it("test_limit_flag — only N newest rows shown", async () => {
    const now = Date.now() / 1000;
    for (let i = 0; i < 5; i++) {
      _writeSession(`sess-${String(i).padStart(3, "0")}`, { lastActive: now - i * 10 });
    }
    const r = await invoke(["sessions", "--limit", "2"]);
    expect(r.exit_code).toBe(0);
    const dataLines = r.stdout.split("\n").filter((l) => l.includes("sess-"));
    expect(dataLines.length).toBe(2);
  });

  it("test_json_output — structured payload with counts", async () => {
    _writeSession("json-test-sess", {
      cwd: "/p/proj",
      hints: 3,
      files: { "a.py": { rel_or_abs: "a.py", last_read_ts: 0, read_count: 2 } },
      edited: { "b.py": 1 },
    });
    const r = await invoke(["sessions", "--json"]);
    expect(r.exit_code).toBe(0);
    const payload = JSON.parse(r.stdout) as Array<Record<string, unknown>>;
    expect(Array.isArray(payload)).toBe(true);
    expect(payload.length).toBe(1);
    const row = payload[0]!;
    expect(row["session_id"]).toBe("json-test-sess");
    expect(row["file_count"]).toBe(1);
    expect(row["edit_count"]).toBe(1);
    expect(row["hints_emitted"]).toBe(3);
  });

  it("test_project_filter_matches — only the matching project lists", async () => {
    _writeSession("match-sess", { cwd: "/projects/alpha" });
    _writeSession("nomatch-sess", { cwd: "/projects/beta" });
    const r = await invoke(["sessions", "--project", "/projects/alpha"]);
    expect(r.exit_code).toBe(0);
    expect(r.stdout).toContain("match-sess");
    expect(r.stdout).not.toContain("nomatch-sess");
  });

  it("test_project_filter_no_results — non-matching filter → empty hint", async () => {
    _writeSession("any-sess", { cwd: "/projects/other" });
    const r = await invoke(["sessions", "--project", "/projects/nonexistent"]);
    expect(r.exit_code).toBe(0);
    expect(r.stdout.toLowerCase()).toContain("no sessions");
  });

  it("test_shows_edit_and_hint_counts — summed edit count + hints render", async () => {
    _writeSession("counts-sess", { edited: { "x.py": 7, "y.py": 3 }, hints: 12 });
    const r = await invoke(["sessions"]);
    expect(r.exit_code).toBe(0);
    expect(r.stdout).toContain("counts-sess");
    // edit count should be 10 (7+3), hints 12.
    expect(r.stdout).toContain("10");
    expect(r.stdout).toContain("12");
  });
});

describe("sessions-show command (port of test_cli_sessions.py TestSessionsShowCommand)", () => {
  it("test_shows_session_details — id, project, and files render", async () => {
    _writeSession("detail-sess", {
      cwd: "/projects/demo",
      files: { "main.py": { rel_or_abs: "main.py", last_read_ts: Date.now() / 1000, read_count: 3 } },
      edited: { "main.py": 2 },
      hints: 4,
    });
    const r = await invoke(["sessions-show", "detail-sess"]);
    expect(r.exit_code).toBe(0);
    expect(r.stdout).toContain("detail-sess");
    expect(r.stdout).toContain("/projects/demo");
    expect(r.stdout).toContain("main.py");
  });

  it("test_prefix_match — short prefix resolves to the full id", async () => {
    _writeSession("abcdef123456", { cwd: "/p/x" });
    const r = await invoke(["sessions-show", "abcdef"]);
    expect(r.exit_code).toBe(0);
    expect(r.stdout).toContain("abcdef123456");
  });

  it("test_ambiguous_prefix_errors — two matches → non-zero exit + 'ambiguous'", async () => {
    _writeSession("prefix-alpha", { cwd: "/p/a" });
    _writeSession("prefix-beta", { cwd: "/p/b" });
    const r = await invoke(["sessions-show", "prefix"]);
    expect(r.exit_code).not.toBe(0);
    expect(r.output.toLowerCase()).toContain("ambiguous");
  });

  it("test_missing_session_errors — no match → non-zero exit + 'no session found'", async () => {
    _writeSession("some-other-session");
    const r = await invoke(["sessions-show", "does-not-exist"]);
    expect(r.exit_code).not.toBe(0);
    expect(r.output.toLowerCase()).toContain("no session found");
  });

  it("test_json_output — raw session JSON echoed", async () => {
    _writeSession("json-show-sess", { cwd: "/p/x", hints: 7 });
    const r = await invoke(["sessions-show", "json-show-sess", "--json"]);
    expect(r.exit_code).toBe(0);
    const payload = JSON.parse(r.stdout) as Record<string, unknown>;
    expect(payload["session_id"]).toBe("json-show-sess");
    expect(payload["hints_emitted"]).toBe(7);
  });

  it("test_shows_bash_history — bash preview + 'Bash history' header render", async () => {
    const bash = {
      sha1: {
        cmd_sha: "sha1",
        cmd_preview: "pytest -v",
        output_id: "o1",
        ts: Date.now() / 1000,
        stdout_bytes: 100,
        stderr_bytes: 0,
        run_count: 2,
      },
    };
    _writeSession("bash-hist-sess", { bash });
    const r = await invoke(["sessions-show", "bash-hist-sess"]);
    expect(r.exit_code).toBe(0);
    expect(r.stdout).toContain("pytest -v");
    expect(r.stdout).toContain("Bash history");
  });

  it("test_shows_web_history — web preview + 'Web history' header render", async () => {
    const web = {
      sha1: {
        url_sha: "sha1",
        url_preview: "https://example.com/docs",
        output_id: "w1",
        ts: Date.now() / 1000,
        body_bytes: 500,
      },
    };
    _writeSession("web-hist-sess", { web });
    const r = await invoke(["sessions-show", "web-hist-sess"]);
    expect(r.exit_code).toBe(0);
    expect(r.stdout).toContain("example.com");
    expect(r.stdout).toContain("Web history");
  });

  it("test_no_sessions_dir — missing sessions dir → non-zero exit", async () => {
    const r = await invoke(["sessions-show", "anything"]);
    expect(r.exit_code).not.toBe(0);
  });
});
