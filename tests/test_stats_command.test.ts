/**
 * Tests for `token-goat stats --session-id / --global` and get_compression_stats().
 *
 * Port of tests/test_stats_command.py.
 *
 * Split:
 *  - TestGetCompressionStats — pure db.get_compression_stats() unit tests. These
 *    are fully portable (DB-only, no clock seam, no cli). The tmp data dir +
 *    cache reset are applied by tests/setup.ts's beforeEach, so the Python
 *    `tmp_data_dir` fixture parameter has no TS counterpart in the signatures.
 *  - TestStatsCLI — every case invokes `cli.app` via Typer's CliRunner. The cli
 *    module is NOT yet ported (Layer 7), so the whole class is it.skip'd.
 *
 * Parity notes:
 *  - db.record_stat(None, kind, tokens_saved=.., bytes_saved=.., detail=..) maps
 *    to db.recordStat(undefined, kind, { tokensSaved, bytesSaved, detail }).
 *  - get_compression_stats() maps to db.get_compression_stats() (snake_case
 *    alias in db.ts).
 *
 * Session scoping (FIXED 2026-06-21): db.getCompressionStats now restricts to
 * rows with `ts >= session.started_ts` when a sessionId is passed (loading
 * session.safe_load → started_ts; mirrors Python db.py:2141-2152).
 * test_session_scoping_excludes_old_events runs live; session=undefined is the
 * all-time path.
 */
import { describe, expect, it } from "vitest";
import fs from "node:fs";

import { invoke } from "./_cli_runner.js";
import * as db from "../src/token_goat/db.js";
import * as session from "../src/token_goat/session.js";
import * as paths from "../src/token_goat/paths.js";

// ===========================================================================
// get_compression_stats() unit tests
// ===========================================================================

describe("TestGetCompressionStats", () => {
  it("test_empty_db_returns_zero_counts", () => {
    // No stats rows exist; every field must be 0 and no error raised.
    const result = db.get_compression_stats();
    expect(result.tokens_saved).toBe(0);
    expect(result.outputs_compressed).toBe(0);
    expect(result.reread_denies).toBe(0);
    expect(result.images_shrunk).toBe(0);
    expect(result.top_filters).toEqual([]);
  });

  it("test_all_expected_keys_present", () => {
    const result = db.get_compression_stats();
    expect(new Set(Object.keys(result))).toEqual(
      new Set([
        "tokens_saved",
        "outputs_compressed",
        "reread_denies",
        "images_shrunk",
        "top_filters",
      ]),
    );
  });

  it("test_bash_output_cached_counted", () => {
    db.recordStat(undefined, "bash_output_cached", {
      tokensSaved: 100,
      bytesSaved: 400,
      detail: "pytest",
    });
    db.recordStat(undefined, "bash_output_cached", {
      tokensSaved: 200,
      bytesSaved: 800,
      detail: "pytest",
    });
    const result = db.get_compression_stats();
    expect(result.outputs_compressed).toBe(2);
    expect(result.tokens_saved).toBeGreaterThanOrEqual(300);
  });

  it("test_reread_deny_counted", () => {
    db.recordStat(undefined, "reread_deny", {
      tokensSaved: 50,
      bytesSaved: 200,
      detail: "src/foo.py",
    });
    const result = db.get_compression_stats();
    expect(result.reread_denies).toBe(1);
  });

  it("test_image_shrink_and_cache_hit_both_counted", () => {
    db.recordStat(undefined, "image_shrink", { tokensSaved: 80, bytesSaved: 320 });
    db.recordStat(undefined, "image_shrink_cache_hit", {
      tokensSaved: 80,
      bytesSaved: 320,
    });
    const result = db.get_compression_stats();
    expect(result.images_shrunk).toBe(2);
  });

  it("test_overhead_rows_excluded_from_tokens_saved", () => {
    db.recordStat(undefined, "reread_deny", { tokensSaved: 100, bytesSaved: 400 });
    db.recordStat(undefined, "reread_deny_overhead", {
      tokensSaved: -10,
      bytesSaved: -40,
    });
    const result = db.get_compression_stats();
    // overhead row is negative and excluded; only the positive row counts.
    expect(result.tokens_saved).toBe(100);
  });

  it("test_top_filters_sorted_desc", () => {
    db.recordStat(undefined, "symbol_read", { tokensSaved: 500, bytesSaved: 2000 });
    db.recordStat(undefined, "reread_deny", { tokensSaved: 300, bytesSaved: 1200 });
    db.recordStat(undefined, "bash_output_cached", { tokensSaved: 100, bytesSaved: 400 });
    const result = db.get_compression_stats();
    const filters = result.top_filters;
    expect(filters.length).toBeLessThanOrEqual(3);
    // Must be in descending order of tokens_saved.
    for (let i = 0; i < filters.length - 1; i++) {
      expect(filters[i]!.tokens_saved).toBeGreaterThanOrEqual(filters[i + 1]!.tokens_saved);
    }
    expect(filters[0]!.filter).toBe("symbol_read");
  });

  it("test_session_scoping_excludes_old_events", () => {
    // Seed a stat row in the past, then create a session starting after it.
    db.recordStat(undefined, "reread_deny", { tokensSaved: 999, bytesSaved: 3996 });
    // Build a session with started_ts in the future relative to the seeded row.
    const sid = "aabbccdd11223344aabbccdd11223344";
    const futureTs = Date.now() / 1000 + 3600;
    const cache = new session.SessionCache({
      session_id: sid,
      started_ts: futureTs,
      last_activity_ts: futureTs,
    });
    paths.ensureDir(paths.sessionsDir());
    fs.writeFileSync(paths.sessionCachePath(sid), cache.to_json(), "utf-8");
    session._proc_load_cache.delete(sid);

    const result = db.getCompressionStats(sid);
    // The row was inserted before session started_ts, so it must be excluded.
    expect(result.reread_denies).toBe(0);
    expect(result.tokens_saved).toBe(0);
  });

  it("test_session_none_returns_alltime", () => {
    db.recordStat(undefined, "reread_deny", { tokensSaved: 42, bytesSaved: 168 });
    const result = db.get_compression_stats(undefined);
    expect(result.reread_denies).toBe(1);
    expect(result.tokens_saved).toBe(42);
  });
});

// ===========================================================================
// CLI integration tests — `stats --global` / `--session-id` / `--json`
//
// Ported from the Python `TestStatsCLI` class. `runner.invoke(cli.app, ...)`
// maps to the in-process `invoke([...])` harness (tests/_cli_runner.ts), which
// spies process.stdout/stderr; `result.stdout`/`result.exit_code` carry over.
// The focused compression-metrics branch (cli_stats.cmd_stats) prints the four
// labels and, with --json, db.getCompressionStats(...) + hook_timing as JSON.
// ===========================================================================

describe("TestStatsCLI", () => {
  it("test_global_flag_exits_zero_empty_db", async () => {
    const result = await invoke(["stats", "--global"]);
    expect(result.exit_code).toBe(0);
  });

  it("test_global_flag_shows_all_four_metrics", async () => {
    const result = await invoke(["stats", "--global"]);
    expect(result.stdout).toContain("Bash outputs compressed");
    expect(result.stdout).toContain("Estimated tokens saved");
    expect(result.stdout).toContain("Reread denies");
    expect(result.stdout).toContain("Images shrunk");
  });

  it("test_json_flag_with_global_returns_valid_json", async () => {
    const result = await invoke(["stats", "--global", "--json"]);
    expect(result.exit_code).toBe(0);
    const data = JSON.parse(result.stdout);
    expect(data).toHaveProperty("tokens_saved");
    expect(data).toHaveProperty("outputs_compressed");
    expect(data).toHaveProperty("reread_denies");
    expect(data).toHaveProperty("images_shrunk");
    expect(data).toHaveProperty("top_filters");
  });

  it("test_global_shows_nonzero_after_seeding", async () => {
    db.recordStat(undefined, "bash_output_cached", { tokensSaved: 77, bytesSaved: 308 });
    db.recordStat(undefined, "reread_deny", { tokensSaved: 33, bytesSaved: 132 });
    const result = await invoke(["stats", "--global"]);
    expect(result.exit_code).toBe(0);
    // tokens_saved total (77 alone or 110 combined).
    expect(result.stdout.includes("77") || result.stdout.includes("110")).toBe(true);
  });

  it("test_session_id_flag_with_valid_session", async () => {
    const sid = "ccddee00112233ccddee001122334455";
    const ts = Date.now() / 1000;
    const cache = new session.SessionCache({
      session_id: sid,
      started_ts: ts,
      last_activity_ts: ts,
    });
    paths.ensureDir(paths.sessionsDir());
    fs.writeFileSync(paths.sessionCachePath(sid), cache.to_json(), "utf-8");
    session._proc_load_cache.delete(sid);

    const result = await invoke(["stats", "--session-id", sid]);
    expect(result.exit_code).toBe(0);
    expect(result.stdout).toContain("Token savings");
  });

  it("test_no_flags_falls_through_to_full_stats", async () => {
    // Without --global or --session-id, the existing full stats path runs.
    const result = await invoke(["stats"]);
    expect(result.exit_code).toBe(0);
  });

  it("test_global_option_is_functional", async () => {
    // Verifies --global is registered and accepted (not a help-text parse).
    const result = await invoke(["stats", "--global"]);
    expect(result.exit_code).toBe(0);
  });
});
