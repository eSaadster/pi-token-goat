/**
 * Tests for `token-goat cost` — faithful port of tests/test_cli_cost.py.
 *
 * Harness seams:
 *  - `invoke([...])` is the TS CliRunner (tests/_cli_runner.ts): captures
 *    stdout/output + exit_code.
 *  - `tmp_data_dir` is automatic (tests/setup.ts isolates the data dir per
 *    test); the sessions dir resolves under it via `paths.sessionsDir()`.
 *  - Session seeding: build a fresh cache via `session.load(sid)`, write it to
 *    `paths.sessionCachePath(sid)` with `cache.to_json()`, then bust the in-proc
 *    cache (`session._proc_load_cache.delete(sid)`) so `safe_load` re-reads from
 *    disk. (TS analogue of the Python test writing `SessionCache.to_dict()` JSON
 *    into `tmp_data_dir / "sessions"`.)
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import * as fs from "node:fs";

import * as paths from "../src/token_goat/paths.js";
import * as session from "../src/token_goat/session.js";

import { invoke } from "./_cli_runner.js";

/** Write a minimal session cache to disk (mirrors the Python test's setup). */
function _seedSession(sid: string): void {
  const cache = session.load(sid); // fresh cache (empty files/greps/bash/web)
  paths.ensureDir(paths.sessionsDir());
  fs.writeFileSync(paths.sessionCachePath(sid), cache.to_json(), "utf-8");
  session._proc_load_cache.delete(sid);
}

describe("cost command", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("test_cost_alltime_exits_zero", async () => {
    // cost without --session exits 0 and shows the all-time summary.
    const r = await invoke(["cost"]);
    expect(r.exit_code).toBe(0);
    expect(r.stdout.toLowerCase()).toContain("tokens");
    expect(r.stdout.toLowerCase()).toContain("all-time");
  });

  it("test_cost_session_flag_with_valid_session", async () => {
    const session_id = "abc123def456789abcdef0123456789";
    _seedSession(session_id);

    const r = await invoke(["cost", "--session", session_id]);
    expect(r.exit_code).toBe(0);
    expect(r.stdout.toLowerCase()).toContain("tokens");
    expect(r.stdout.toLowerCase()).toContain("session");
  });

  it("test_cost_session_flag_short_form", async () => {
    const session_id = "abc123def456789abcdef0123456789";
    _seedSession(session_id);

    const r = await invoke(["cost", "--session", "abc123de"]);
    expect(r.exit_code).toBe(0);
    expect(r.stdout.toLowerCase()).toContain("tokens");
  });

  it("test_cost_session_flag_not_found", async () => {
    paths.ensureDir(paths.sessionsDir());
    const r = await invoke(["cost", "--session", "nonexistent"]);
    expect(r.exit_code).toBe(1);
  });

  it("test_cost_contains_tokens_keyword", async () => {
    const r = await invoke(["cost"]);
    expect(r.exit_code).toBe(0);
    expect(r.stdout.toLowerCase()).toContain("tokens");
  });
});
