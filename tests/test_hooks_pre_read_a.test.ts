/**
 * Tests for the pre_read hook handler and its dispatcher integration — part A.
 *
 * 1:1 port of tests/test_hooks_pre_read.py (split into _a/_b by class boundary
 * to keep each file under ~1500 LOC). Part A covers the direct-handler,
 * dispatcher, real-world-spike, glob-dedup, written-not-read, grep-written,
 * glob-cache-cap, structured-file, index-only-file, and unchanged-file classes.
 * Part B (test_hooks_pre_read_b.test.ts) covers the curator, surgical-read,
 * grep-symbol-redirect, flush-regression, safe-load and fast-path classes.
 *
 * Seam mapping (Python -> TS):
 *  - hooks_cli.pre_read / post_read / post_bash  -> these live in hooks_read.ts
 *    in the TS port (sync functions). hooks_cli.dispatch is the async dispatcher.
 *  - tmp_data_dir autouse fixture -> setup.ts (setDataDirOverride + clearModuleCaches).
 *  - tmp_path fixture -> fs.mkdtempSync wrapped in fs.realpathSync (macOS /var
 *    symlink vs find_project realpath).
 *  - db.open_global() context-manager + raw SQL -> db.openGlobalReadonly((conn) =>
 *    conn.prepare(sql).all()).
 *  - monkeypatch("token_goat.project.find_project", ...) -> vi.spyOn(project, "find_project").
 *  - hint text: the TS port emits "fewer tok" (not "fewer tokens") and an en-dash
 *    range; assertions key off symbol names / command strings, not the trimmed words.
 *
 * Deferred (it.skip with seam comment):
 *  - the subprocess-CLI cases (spawn `token_goat.cli`) require the CLI entrypoint
 *    + a Python interpreter; the TS port has no equivalent subprocess harness.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import * as hooks_read from "../src/token_goat/hooks_read.js";
import * as hooks_cli from "../src/token_goat/hooks_cli.js";
import * as session from "../src/token_goat/session.js";
import * as snapshots from "../src/token_goat/snapshots.js";
import * as db from "../src/token_goat/db.js";
import * as bash_cache from "../src/token_goat/bash_cache.js";
import * as project from "../src/token_goat/project.js";
import { build_read_hint, build_unchanged_file_hint, _GLOB_DEDUP_MIN_RESULT_COUNT } from "../src/token_goat/hints.js";
import crypto from "node:crypto";
import { bytes_to_tokens } from "../src/token_goat/hooks_common.js";
import type { HookPayload } from "../src/token_goat/types.js";

// pre_read in the TS port lives in hooks_read; alias it as the Python suite's
// hooks_cli.pre_read for a 1:1 read of the test bodies.
const pre_read = hooks_read.pre_read;
const post_read = hooks_read.post_read;

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

/** Verbatim port of hook_helpers.assert_continue. */
function _assert_continue(result: Record<string, unknown>): void {
  expect(result["continue"]).toBe(true);
}

/** Throwaway tmp dir (pytest tmp_path analogue), realpath-resolved. */
function tmpPath(prefix = "tg-prr-"): string {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
}

const _tmpRoots: string[] = [];
function makeTmp(prefix = "tg-prr-"): string {
  const d = tmpPath(prefix);
  _tmpRoots.push(d);
  return d;
}

afterEach(() => {
  vi.restoreAllMocks();
  while (_tmpRoots.length) {
    const d = _tmpRoots.pop()!;
    try {
      fs.rmSync(d, { recursive: true, force: true });
    } catch {
      // best-effort
    }
  }
});

/** Query the global stats table (db.open_global() + raw SQL analogue).
 *
 * Python's db.open_global() creates the DB on open; the TS openGlobalReadonly
 * throws when global.db is absent. When nothing was recorded the table never
 * exists — which is equivalent to zero matching rows, so swallow the
 * "not found" error and return []. */
function queryStats(kinds: string[]): Array<{ kind: string; detail: string | null; tokens_saved: number; bytes_saved: number }> {
  const placeholders = kinds.map(() => "?").join(", ");
  try {
    return db.openGlobalReadonly((conn) =>
      conn
        .prepare(
          `SELECT kind, detail, tokens_saved, bytes_saved FROM stats ` +
            `WHERE kind IN (${placeholders}) ORDER BY kind`,
        )
        .all(...kinds) as Array<{ kind: string; detail: string | null; tokens_saved: number; bytes_saved: number }>,
    );
  } catch (exc) {
    if (exc instanceof Error && exc.message.includes("global.db not found")) {
      return [];
    }
    throw exc;
  }
}

// ---------------------------------------------------------------------------
// Direct handler tests
// ---------------------------------------------------------------------------

describe("TestPreReadHandlerDirect", () => {
  it("test_non_read_tool_passes_through", async () => {
    const payload: HookPayload = {
      session_id: "s1",
      tool_name: "Grep",
      tool_input: { pattern: "foo" },
    };
    const result = await pre_read(payload);
    _assert_continue(result);
    expect("hookSpecificOutput" in result).toBe(false);
  });

  it("test_file_not_in_cache_nonexistent_file_no_hint", async () => {
    const tmp = makeTmp();
    vi.spyOn(project, "find_project").mockReturnValue(null);
    const payload: HookPayload = {
      session_id: "s2",
      tool_name: "Read",
      tool_input: { file_path: path.join(tmp, "ghost.py"), offset: 0, limit: 100 },
      cwd: tmp,
    };
    const result = await pre_read(payload);
    _assert_continue(result);
    expect("hookSpecificOutput" in result).toBe(false);
  });

  it("test_cached_file_produces_hint", async () => {
    const sid = "s3";
    const p = "C:/proj/cached.py";
    session.mark_file_read(sid, p, 0, 200);

    const payload: HookPayload = {
      session_id: sid,
      tool_name: "Read",
      tool_input: { file_path: p, offset: 0, limit: 200 },
      cwd: "C:/proj",
    };
    const result = await pre_read(payload);
    _assert_continue(result);
    expect("hookSpecificOutput" in result).toBe(true);
    const ctx = result["hookSpecificOutput"] as Record<string, unknown>;
    expect(ctx["hookEventName"]).toBe("PreToolUse");
    expect("additionalContext" in ctx).toBe(true);
    expect((ctx["additionalContext"] as string).length).toBeGreaterThan(10);
  });

  it("test_garbage_payload_returns_continue", async () => {
    // Python's hooks_cli.pre_read is the fail_soft-wrapped handler (resolved via
    // module __getattr__). The bare hooks_read.pre_read is unwrapped and would
    // throw on a None payload. getLazyAttr("pre_read") returns the same
    // fail_soft-wrapped handler hooks_cli.pre_read exposes.
    const wrapped = await hooks_cli.getLazyAttr("pre_read");
    expect(wrapped).not.toBeNull();
    const result = await wrapped!(null as unknown as HookPayload);
    _assert_continue(result as Record<string, unknown>);
  });

  it("test_hint_records_session_hint_stat", async () => {
    const sid = "stat_smoke";
    const p = "C:/proj/cached.py";
    session.mark_file_read(sid, p, 0, 200);

    const payload: HookPayload = {
      session_id: sid,
      tool_name: "Read",
      tool_input: { file_path: p, offset: 0, limit: 200 },
      cwd: "C:/proj",
    };
    const result = await pre_read(payload);
    expect("hookSpecificOutput" in result).toBe(true);

    const rows = queryStats(["session_hint", "session_hint_overhead"]);
    expect(rows.length).toBe(2);
    expect(rows[0]!.detail).toBe(p);
    expect(rows[1]!.detail).toBe(p);
    expect(rows[0]!.kind).toBe("session_hint");
    expect(rows[1]!.kind).toBe("session_hint_overhead");
  });

  it("test_session_hint_stat_is_net_of_injection_cost", async () => {
    const sid = "net_acct";
    const p = "C:/proj/cached.py";
    session.mark_file_read(sid, p, 0, 200);

    const hint = build_read_hint({ session_id: sid, file_path: p, offset: 0, limit: 200, cwd: "C:/proj" });
    expect(hint).not.toBeNull();
    const hint_text = String(hint);
    const injection_bytes = Buffer.byteLength(hint_text, "utf-8");
    const injection_cost = bytes_to_tokens(injection_bytes);
    expect(injection_cost).toBeGreaterThan(0);
    const tokens_saved = (hint as { tokens_saved: number }).tokens_saved;
    const expected_net_tokens = tokens_saved - injection_cost;
    const expected_net_bytes = tokens_saved * 4 - injection_bytes;

    const payload: HookPayload = {
      session_id: sid,
      tool_name: "Read",
      tool_input: { file_path: p, offset: 0, limit: 200 },
      cwd: "C:/proj",
    };
    const result = await pre_read(payload);
    expect("hookSpecificOutput" in result).toBe(true);

    const rows = queryStats(["session_hint", "session_hint_overhead"]);
    expect(rows.length).toBe(2);
    const [gross_row, overhead_row] = rows;
    expect(gross_row!.kind).toBe("session_hint");
    expect(gross_row!.tokens_saved).toBe(tokens_saved);
    expect(gross_row!.bytes_saved).toBe(tokens_saved * 4);
    expect(overhead_row!.kind).toBe("session_hint_overhead");
    expect(overhead_row!.tokens_saved).toBe(-injection_cost);
    expect(overhead_row!.bytes_saved).toBe(-injection_bytes);
    expect(gross_row!.tokens_saved + overhead_row!.tokens_saved).toBe(expected_net_tokens);
    expect(gross_row!.bytes_saved + overhead_row!.bytes_saved).toBe(expected_net_bytes);
  });

  it("test_suggestion_hint_records_nothing", async () => {
    const sid = "neg_net";
    const p = "C:/proj/syms.py";
    session.mark_file_read(sid, p, null, null, { symbol: "some_func" });

    const payload: HookPayload = {
      session_id: sid,
      tool_name: "Read",
      tool_input: { file_path: p, offset: 0, limit: 2000 },
      cwd: "C:/proj",
    };
    const result = await pre_read(payload);
    expect("hookSpecificOutput" in result).toBe(true);

    const rows = queryStats(["session_hint", "session_hint_overhead"]);
    expect(rows.length).toBe(0);
  });

  it("test_missing_tool_name_passes_through", async () => {
    const payload = { session_id: "s4", tool_input: { file_path: "foo.py" } } as unknown as HookPayload;
    const result = await pre_read(payload);
    _assert_continue(result);
  });

  it("test_no_session_id_no_hint", async () => {
    const payload = {
      tool_name: "Read",
      tool_input: { file_path: "foo.py", offset: 0, limit: 100 },
    } as unknown as HookPayload;
    const result = await pre_read(payload);
    _assert_continue(result);
  });
});

// ---------------------------------------------------------------------------
// Dispatcher integration
// ---------------------------------------------------------------------------

describe("TestDispatcherPreRead", () => {
  it("test_dispatch_pre_read_non_read_tool", async () => {
    const payload: HookPayload = {
      session_id: "d1",
      tool_name: "Write",
      tool_input: { file_path: "x.py" },
    };
    const result = await hooks_cli.dispatch("pre-read", payload);
    _assert_continue(result);
  });

  it("test_dispatch_pre_read_cached_file_has_hint", async () => {
    const sid = "d2";
    const p = "C:/some/source.py";
    session.mark_file_read(sid, p, 0, 500);

    const payload: HookPayload = {
      session_id: sid,
      tool_name: "Read",
      tool_input: { file_path: p, offset: 0, limit: 500 },
    };
    const result = await hooks_cli.dispatch("pre-read", payload);
    _assert_continue(result);
    expect("hookSpecificOutput" in result).toBe(true);
    expect("additionalContext" in (result["hookSpecificOutput"] as Record<string, unknown>)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Subprocess / CLI integration — DEFERRED (no TS subprocess CLI harness).
// ---------------------------------------------------------------------------

describe("TestPreReadCli", () => {
  it.skip("test_cli_non_read_tool_no_hint — DEFER: subprocess CLI (token_goat.cli) not ported", () => {});
  it.skip("test_cli_garbage_payload_continue — DEFER: subprocess CLI (token_goat.cli) not ported", () => {});
});

// ---------------------------------------------------------------------------
// Real-world spike: mark -> pre-read -> hint
// ---------------------------------------------------------------------------

describe("TestRealWorldSpike", () => {
  it("test_mark_then_pre_read_yields_hint", async () => {
    const sid = "spike_s1";
    const p = "C:/spike/module.py";
    session.mark_file_read(sid, p, 0, 300);

    const payload: HookPayload = {
      session_id: sid,
      tool_name: "Read",
      tool_input: { file_path: p, offset: 0, limit: 300 },
      cwd: "C:/spike",
    };
    const result = await hooks_cli.dispatch("pre-read", payload);
    _assert_continue(result);
    expect("hookSpecificOutput" in result).toBe(true);
    const hint = (result["hookSpecificOutput"] as Record<string, unknown>)["additionalContext"] as string;
    expect(hint).toContain("⌘");
    expect(hint).toContain("wasted");
  });
});

// ---------------------------------------------------------------------------
// Glob dispatch tests
// ---------------------------------------------------------------------------

describe("TestGlobDedup", () => {
  function globPayload(sid: string, pattern: string, p?: string): HookPayload {
    const tool_input: Record<string, unknown> = { pattern };
    if (p !== undefined) {
      tool_input["path"] = p;
    }
    return { session_id: sid, tool_name: "Glob", tool_input };
  }

  it("test_first_glob_passes_through", async () => {
    const result = await hooks_cli.dispatch("pre-read", globPayload("glob-new", "**/*.py"));
    _assert_continue(result);
    expect("hookSpecificOutput" in result).toBe(false);
  });

  it("test_glob_dedup_hit_injects_hint", async () => {
    const sid = "glob-dedup-hit";
    const pattern = "**/*.py";
    session.mark_glob_run(sid, pattern, null, _GLOB_DEDUP_MIN_RESULT_COUNT + 5);

    const result = await hooks_cli.dispatch("pre-read", globPayload(sid, pattern));
    _assert_continue(result);
    expect("hookSpecificOutput" in result).toBe(true);
    const ctx = (result["hookSpecificOutput"] as Record<string, unknown>)["additionalContext"] as string;
    expect(ctx).toContain("Glob");
    expect(ctx).toContain(pattern);
  });

  it("test_glob_dedup_different_pattern_no_hint", async () => {
    const sid = "glob-diff-pattern";
    session.mark_glob_run(sid, "**/*.ts", null, 20);

    const result = await hooks_cli.dispatch("pre-read", globPayload(sid, "**/*.py"));
    _assert_continue(result);
    expect("hookSpecificOutput" in result).toBe(false);
  });

  it("test_glob_dedup_below_threshold_no_hint", async () => {
    const sid = "glob-below-thresh";
    const pattern = "src/**/*.js";
    session.mark_glob_run(sid, pattern, null, _GLOB_DEDUP_MIN_RESULT_COUNT - 1);

    const result = await hooks_cli.dispatch("pre-read", globPayload(sid, pattern));
    _assert_continue(result);
    expect("hookSpecificOutput" in result).toBe(false);
  });

  it("test_glob_dedup_with_path_scope", async () => {
    const sid = "glob-with-path";
    const pattern = "**/*.rs";
    const p = "src/";
    session.mark_glob_run(sid, pattern, p, _GLOB_DEDUP_MIN_RESULT_COUNT + 3);

    const result = await hooks_cli.dispatch("pre-read", globPayload(sid, pattern, p));
    _assert_continue(result);
    expect("hookSpecificOutput" in result).toBe(true);
  });

  it("test_glob_dedup_path_mismatch_no_hint", async () => {
    const sid = "glob-path-mismatch";
    const pattern = "**/*.py";
    session.mark_glob_run(sid, pattern, "src/", _GLOB_DEDUP_MIN_RESULT_COUNT + 5);

    const result = await hooks_cli.dispatch("pre-read", globPayload(sid, pattern, "tests/"));
    _assert_continue(result);
    expect("hookSpecificOutput" in result).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Written-not-read hint tests
// ---------------------------------------------------------------------------

describe("TestWrittenNotReadHint", () => {
  function readPayload(sid: string, p: string): HookPayload {
    return {
      session_id: sid,
      tool_name: "Read",
      tool_input: { file_path: p, offset: 0, limit: 100 },
      cwd: "/proj",
    };
  }

  it("test_written_not_read_emits_hint", async () => {
    const sid = "written-not-read-hint";
    const p = "/proj/src/new_module.py";
    session.mark_file_edited(sid, p);

    const result = await pre_read(readPayload(sid, p));
    _assert_continue(result);
    expect("hookSpecificOutput" in result).toBe(true);
    const ctx = (result["hookSpecificOutput"] as Record<string, unknown>)["additionalContext"] as string;
    expect(ctx.toLowerCase()).toContain("written");
    expect(ctx).toContain("new_module.py");
  });

  it("test_read_before_write_no_extra_hint", async () => {
    const sid = "read-then-written";
    const p = "/proj/src/existing.py";
    session.mark_file_read(sid, p, 0, 200);
    session.mark_file_edited(sid, p);

    const result = await pre_read(readPayload(sid, p));
    _assert_continue(result);
    if ("hookSpecificOutput" in result) {
      const ctx = ((result["hookSpecificOutput"] as Record<string, unknown>)["additionalContext"] as string) ?? "";
      expect(!ctx.toLowerCase().includes("written") || ctx.includes("⌘")).toBe(true);
    }
  });

  it("test_never_written_never_read_no_hint", async () => {
    const sid = "pristine-session";
    const p = "/proj/src/pristine.py";

    const result = await pre_read(readPayload(sid, p));
    _assert_continue(result);
    expect("hookSpecificOutput" in result).toBe(false);
  });

  it("test_written_multiple_times_count_in_hint", async () => {
    const sid = "multi-write";
    const p = "/proj/src/hotfile.py";
    for (let i = 0; i < 3; i++) {
      session.mark_file_edited(sid, p);
    }

    const result = await pre_read(readPayload(sid, p));
    _assert_continue(result);
    expect("hookSpecificOutput" in result).toBe(true);
    const ctx = (result["hookSpecificOutput"] as Record<string, unknown>)["additionalContext"] as string;
    expect(ctx).toContain("3");
  });
});

// ---------------------------------------------------------------------------
// Grep written-not-read hint tests
// ---------------------------------------------------------------------------

describe("TestGrepWrittenNotReadHint", () => {
  function grepPayload(sid: string, p: string, pattern = "def "): HookPayload {
    return {
      session_id: sid,
      tool_name: "Grep",
      tool_input: { pattern, path: p },
      cwd: "/proj",
    };
  }

  it("test_grep_written_not_read_emits_hint", async () => {
    const sid = "grep-written-not-read";
    const p = "/proj/src/new_service.py";
    session.mark_file_edited(sid, p);

    const result = await pre_read(grepPayload(sid, p));
    _assert_continue(result);
    expect("hookSpecificOutput" in result).toBe(true);
    const ctx = (result["hookSpecificOutput"] as Record<string, unknown>)["additionalContext"] as string;
    expect(ctx.toLowerCase()).toContain("written");
    expect(ctx).toContain("new_service.py");
  });

  it("test_grep_after_read_no_hint", async () => {
    const sid = "grep-read-then-written";
    const p = "/proj/src/already_read.py";
    session.mark_file_read(sid, p, 0, 200);
    session.mark_file_edited(sid, p);

    const result = await pre_read(grepPayload(sid, p));
    _assert_continue(result);
    if ("hookSpecificOutput" in result) {
      const ctx = ((result["hookSpecificOutput"] as Record<string, unknown>)["additionalContext"] as string) ?? "";
      expect(!ctx.toLowerCase().includes("written") || ctx.includes("⌘")).toBe(true);
    }
  });

  it("test_grep_no_path_no_hint", async () => {
    const sid = "grep-no-path";
    const p = "/proj/src/written_file.py";
    session.mark_file_edited(sid, p);

    const payload: HookPayload = {
      session_id: sid,
      tool_name: "Grep",
      tool_input: { pattern: "def " },
      cwd: "/proj",
    };
    const result = await pre_read(payload);
    _assert_continue(result);
    if ("hookSpecificOutput" in result) {
      const ctx = ((result["hookSpecificOutput"] as Record<string, unknown>)["additionalContext"] as string) ?? "";
      expect(ctx.toLowerCase()).not.toContain("written");
    }
  });

  it("test_grep_never_written_no_hint", async () => {
    const sid = "grep-pristine";
    const p = "/proj/src/untouched.py";

    const result = await pre_read(grepPayload(sid, p));
    _assert_continue(result);
    expect("hookSpecificOutput" in result).toBe(false);
  });

  it("test_grep_dir_written_not_read_emits_hint", async () => {
    const sid = "grep-dir-written-nr";
    const dir_path = "/proj/src";
    for (let i = 0; i < 7; i++) {
      session.mark_file_edited(sid, `/proj/src/module_${i}.py`);
    }

    const payload: HookPayload = {
      session_id: sid,
      tool_name: "Grep",
      tool_input: { pattern: "def ", path: dir_path },
      cwd: "/proj",
    };
    const result = await pre_read(payload);
    _assert_continue(result);
    expect("hookSpecificOutput" in result).toBe(true);
    const ctx = (result["hookSpecificOutput"] as Record<string, unknown>)["additionalContext"] as string;
    expect(ctx.toLowerCase()).toContain("written");
    expect(ctx).toContain("(+2 more edited)");
  });

  it("test_grep_dir_at_cap_no_overflow", async () => {
    const sid = "grep-dir-at-cap";
    const dir_path = "/proj/src";
    for (let i = 0; i < 5; i++) {
      session.mark_file_edited(sid, `/proj/src/file_${i}.py`);
    }

    const payload: HookPayload = {
      session_id: sid,
      tool_name: "Grep",
      tool_input: { pattern: "class ", path: dir_path },
    };
    const result = await pre_read(payload);
    _assert_continue(result);
    expect("hookSpecificOutput" in result).toBe(true);
    const ctx = (result["hookSpecificOutput"] as Record<string, unknown>)["additionalContext"] as string;
    expect(ctx).not.toContain("more edited");
  });

  it("test_grep_dir_no_edited_files_no_hint", async () => {
    const sid = "grep-dir-clean";
    const result = await pre_read({
      session_id: sid,
      tool_name: "Grep",
      tool_input: { pattern: "import", path: "/proj/src" },
    });
    _assert_continue(result);
    expect("hookSpecificOutput" in result).toBe(false);
  });

  it("test_grep_dir_all_already_read_no_hint", async () => {
    const sid = "grep-dir-all-read";
    const p = "/proj/src/already.py";
    session.mark_file_edited(sid, p);
    session.mark_file_read(sid, p, 0, 200);

    const result = await pre_read({
      session_id: sid,
      tool_name: "Grep",
      tool_input: { pattern: "def ", path: "/proj/src" },
    });
    _assert_continue(result);
    if ("hookSpecificOutput" in result) {
      const ctx = ((result["hookSpecificOutput"] as Record<string, unknown>)["additionalContext"] as string) ?? "";
      expect(ctx.toLowerCase()).not.toContain("written");
    }
  });
});

// ---------------------------------------------------------------------------
// Glob cache cap tests (item A13)
// ---------------------------------------------------------------------------

describe("TestGlobCacheCap", () => {
  function postGlob(sid: string, pattern: string, result_text: string, p?: string): void {
    const tool_input: Record<string, unknown> = { pattern };
    if (p) {
      tool_input["path"] = p;
    }
    const payload: HookPayload = {
      session_id: sid,
      tool_name: "Glob",
      tool_input,
      tool_result_content: [{ type: "text", text: result_text }],
      cwd: "/proj",
    } as unknown as HookPayload;
    post_read(payload);
    bash_cache.store_glob_result(sid, pattern, p ?? null, result_text);
  }

  async function preGlob(sid: string, pattern: string, p?: string): Promise<Record<string, unknown>> {
    const tool_input: Record<string, unknown> = { pattern };
    if (p) {
      tool_input["path"] = p;
    }
    return await pre_read({ session_id: sid, tool_name: "Glob", tool_input });
  }

  // _GLOB_ROLLUP_THRESHOLD is module-private in hooks_read.ts (not exported);
  // mirror its verbatim value (40) so the parity surface is preserved.
  const _GLOB_ROLLUP_THRESHOLD = 40;

  it("test_glob_cache_rolls_up_large_results", async () => {
    const total = _GLOB_ROLLUP_THRESHOLD + 15;
    const sid = "glob-rollup-55";
    const pattern = "**/*.py";
    const files: string[] = [];
    const half = Math.trunc(total / 2);
    for (let i = 0; i < half; i++) {
      files.push(`src/core/file_${String(i).padStart(3, "0")}.py`);
    }
    for (let i = 0; i < total - half; i++) {
      files.push(`src/util/file_${String(i).padStart(3, "0")}.py`);
    }
    const result_text = files.join("\n") + "\n";
    postGlob(sid, pattern, result_text);

    const result = await preGlob(sid, pattern);
    _assert_continue(result);
    const hso = result["hookSpecificOutput"] as Record<string, unknown> | undefined;
    if (hso == null) {
      return;
    }
    const ctx = (hso["additionalContext"] as string) ?? "";
    if (!ctx.includes("cached result")) {
      return;
    }
    expect(ctx).toContain(String(total));
    expect(ctx).toContain("director");
    expect(ctx).toContain("Directory breakdown");
    expect(ctx).not.toContain("(+10 more)");
  });

  it("test_glob_cache_under_cap_shows_all", async () => {
    const sid = "glob-cap-10";
    const pattern = "**/*.ts";
    const files: string[] = [];
    for (let i = 0; i < 10; i++) {
      files.push(`src/component_${i}.ts`);
    }
    const result_text = files.join("\n") + "\n";
    postGlob(sid, pattern, result_text);

    const result = await preGlob(sid, pattern);
    _assert_continue(result);
    const hso = result["hookSpecificOutput"] as Record<string, unknown> | undefined;
    if (hso == null) {
      return;
    }
    const ctx = (hso["additionalContext"] as string) ?? "";
    if (!ctx.includes("cached result")) {
      return;
    }
    expect(ctx).toContain("src/component_0.ts");
    expect(ctx).toContain("src/component_9.ts");
    expect(ctx).not.toContain("(+0 more)");
    expect(ctx).not.toContain("more)");
  });
});

// ---------------------------------------------------------------------------
// Structured-file hint tests
// ---------------------------------------------------------------------------

describe("TestStructuredFileHint", () => {
  function readPayload(sid: string, p: string, offset?: number, limit?: number): HookPayload {
    const tool_input: Record<string, unknown> = { file_path: p };
    if (offset !== undefined) {
      tool_input["offset"] = offset;
    }
    if (limit !== undefined) {
      tool_input["limit"] = limit;
    }
    return { session_id: sid, tool_name: "Read", tool_input, cwd: "/proj" };
  }

  function makeLargeFile(dir: string, ext: string, size_bytes = 100_000): string {
    const full = path.join(dir, `data${ext}`);
    const row = Buffer.from("col1,col2,col3\n");
    const reps = Math.trunc(size_bytes / row.length) + 1;
    const content = Buffer.concat(Array(reps).fill(row)).subarray(0, size_bytes);
    fs.writeFileSync(full, content);
    return full;
  }

  it("test_large_csv_hint_fires", async () => {
    const tmp = makeTmp();
    const fpath = makeLargeFile(tmp, ".csv");
    const result = await pre_read(readPayload("struct-csv", fpath));
    _assert_continue(result);
    expect("hookSpecificOutput" in result).toBe(true);
    const ctx = (result["hookSpecificOutput"] as Record<string, unknown>)["additionalContext"] as string;
    expect(ctx.toLowerCase()).toContain("csv");
    expect(ctx).toContain("KB");
    expect(ctx.toLowerCase().includes("offset") || ctx.toLowerCase().includes("token-goat")).toBe(true);
  });

  it("test_large_json_hint_fires", async () => {
    const tmp = makeTmp();
    const fpath = makeLargeFile(tmp, ".json");
    const result = await pre_read(readPayload("struct-json", fpath));
    _assert_continue(result);
    expect("hookSpecificOutput" in result).toBe(true);
    const ctx = (result["hookSpecificOutput"] as Record<string, unknown>)["additionalContext"] as string;
    expect(ctx.toLowerCase()).toContain("json");
    expect(ctx).toContain("KB");
    expect(ctx.includes("jq") || ctx.includes("token-goat")).toBe(true);
  });

  it("test_large_log_hint_fires", async () => {
    const tmp = makeTmp();
    const fpath = makeLargeFile(tmp, ".log");
    const result = await pre_read(readPayload("struct-log", fpath));
    _assert_continue(result);
    expect("hookSpecificOutput" in result).toBe(true);
    const ctx = (result["hookSpecificOutput"] as Record<string, unknown>)["additionalContext"] as string;
    expect(ctx.toLowerCase()).toContain("log");
    expect(ctx).toContain("KB");
    const lower = ctx.toLowerCase();
    expect(lower.includes("tail") || lower.includes("head") || lower.includes("grep")).toBe(true);
  });

  it("test_surgical_read_no_hint", async () => {
    const tmp = makeTmp();
    const fpath = makeLargeFile(tmp, ".csv");
    const result = await pre_read(readPayload("struct-surgical", fpath, 10, 20));
    _assert_continue(result);
    if ("hookSpecificOutput" in result) {
      const ctx = ((result["hookSpecificOutput"] as Record<string, unknown>)["additionalContext"] as string) ?? "";
      expect(!ctx.includes("📊") && !ctx.toLowerCase().includes("large")).toBe(true);
    }
  });

  it("test_small_file_no_hint", async () => {
    const tmp = makeTmp();
    const small = path.join(tmp, "tiny.csv");
    fs.writeFileSync(small, "a,b,c\n1,2,3\n");
    const result = await pre_read(readPayload("struct-small", small));
    _assert_continue(result);
    if ("hookSpecificOutput" in result) {
      const ctx = ((result["hookSpecificOutput"] as Record<string, unknown>)["additionalContext"] as string) ?? "";
      expect(ctx).not.toContain("📊");
    }
  });

  it("test_session_dedup_within_verbose_window", async () => {
    const tmp = makeTmp();
    const fpath = makeLargeFile(tmp, ".csv");
    const sid = "struct-dedup";
    const payload = readPayload(sid, fpath);

    const result1 = await pre_read(payload);
    _assert_continue(result1);
    expect("hookSpecificOutput" in result1).toBe(true);

    const result2 = await pre_read(payload);
    _assert_continue(result2);
    expect("hookSpecificOutput" in result2).toBe(true);
    const ctx2 = ((result2["hookSpecificOutput"] as Record<string, unknown>)["additionalContext"] as string) ?? "";
    expect(ctx2.toLowerCase().includes("csv") || ctx2.includes("📊")).toBe(true);
  });

  it("test_session_dedup_emits_stub_past_verbose_window", async () => {
    const tmp = makeTmp();
    const fpath = makeLargeFile(tmp, ".csv");
    const sid = "struct-dedup-stub";
    const payload = readPayload(sid, fpath);

    for (let i = 0; i < 2; i++) {
      pre_read(payload);
    }
    const result3 = await pre_read(payload);
    _assert_continue(result3);
    if ("hookSpecificOutput" in result3) {
      const ctx3 = ((result3["hookSpecificOutput"] as Record<string, unknown>)["additionalContext"] as string) ?? "";
      expect(!ctx3.includes("📊") && !ctx3.toLowerCase().includes("large csv")).toBe(true);
    }
  });

  it("test_jsonl_treated_as_tabular", async () => {
    const tmp = makeTmp();
    const fpath = makeLargeFile(tmp, ".jsonl");
    const result = await pre_read(readPayload("struct-jsonl", fpath));
    _assert_continue(result);
    expect("hookSpecificOutput" in result).toBe(true);
    const ctx = (result["hookSpecificOutput"] as Record<string, unknown>)["additionalContext"] as string;
    expect(ctx.toLowerCase()).toContain("jsonl");
    expect(ctx).not.toContain("jq");
  });

  it("test_csv_includes_headers", async () => {
    const tmp = makeTmp();
    const csv_file = path.join(tmp, "data.csv");
    let content = "id,name,email,created_at\n1,Alice,alice@example.com,2025-01-01\n";
    content += "2,Bob,bob@example.com,2025-01-02\n".repeat(5000);
    fs.writeFileSync(csv_file, content);

    const result = await pre_read(readPayload("struct-csv-headers", csv_file));
    _assert_continue(result);
    expect("hookSpecificOutput" in result).toBe(true);
    const ctx = (result["hookSpecificOutput"] as Record<string, unknown>)["additionalContext"] as string;
    expect(ctx).toContain("id");
    expect(ctx).toContain("name");
    expect(ctx).toContain("email");
    expect(ctx.toLowerCase()).toContain("columns:");
  });

  it("test_ndjson_includes_first_record_schema", async () => {
    const tmp = makeTmp();
    const ndjson_file = path.join(tmp, "events.ndjson");
    const first_record = '{"event": "click", "ts": 1234567890, "user_id": "u123", "session": "s456"}\n';
    let content = first_record;
    for (let i = 0; i < 5000; i++) {
      content += `{"event": "scroll", "ts": ${1234567890 + i}, "user_id": "u${i}", "session": "s${i}"}\n`;
    }
    fs.writeFileSync(ndjson_file, content);

    const result = await pre_read(readPayload("struct-ndjson-schema", ndjson_file));
    _assert_continue(result);
    expect("hookSpecificOutput" in result).toBe(true);
    const ctx = (result["hookSpecificOutput"] as Record<string, unknown>)["additionalContext"] as string;
    expect(ctx.toLowerCase()).toContain("schema:");
    expect(["event", "ts", "user_id"].some((k) => ctx.includes(k))).toBe(true);
  });

  it("test_json_array_includes_schema", async () => {
    const tmp = makeTmp();
    const json_file = path.join(tmp, "data.json");
    const obj0 = { id: 1, name: "Alice", active: true, score: 95.5 };
    let full_content = "[" + Array(5000).fill(JSON.stringify(obj0)).join(", ") + "]";
    while (Buffer.byteLength(full_content, "utf-8") < 100_000) {
      full_content = full_content.slice(0, -1) + ", " + JSON.stringify(obj0) + "]";
    }
    fs.writeFileSync(json_file, full_content);

    const result = await pre_read(readPayload("struct-json-schema", json_file));
    _assert_continue(result);
    expect("hookSpecificOutput" in result).toBe(true);
    const ctx = (result["hookSpecificOutput"] as Record<string, unknown>)["additionalContext"] as string;
    expect(ctx.toLowerCase()).toContain("array schema:");
    expect(["id", "name", "active", "score"].some((k) => ctx.includes(k))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Index-only file hint tests
// ---------------------------------------------------------------------------

describe("TestIndexOnlyFileHint", () => {
  function readPayload(session_id: string, file_path: string, offset?: number, limit?: number): HookPayload {
    const inp: Record<string, unknown> = { file_path };
    if (offset !== undefined) {
      inp["offset"] = offset;
    }
    if (limit !== undefined) {
      inp["limit"] = limit;
    }
    return { tool_name: "Read", tool_input: inp, session_id, cwd: "/proj" };
  }

  function makeLockfile(dir: string, name: string, size_bytes = 60_000): string {
    const p = path.join(dir, name);
    const row = Buffer.from('# dep entry\nname = "foo"\nversion = "1.0.0"\n');
    const reps = Math.trunc(size_bytes / row.length) + 1;
    const content = Buffer.concat(Array(reps).fill(row)).subarray(0, size_bytes);
    fs.writeFileSync(p, content);
    return p;
  }

  it("test_uv_lock_fires", async () => {
    const tmp = makeTmp();
    const fpath = makeLockfile(tmp, "uv.lock");
    const result = await pre_read(readPayload("io-uv", fpath));
    _assert_continue(result);
    expect("hookSpecificOutput" in result).toBe(true);
    const ctx = (result["hookSpecificOutput"] as Record<string, unknown>)["additionalContext"] as string;
    expect(ctx).toContain("uv.lock");
    expect(ctx.toLowerCase()).toContain("lockfile");
  });

  it("test_package_lock_json_fires", async () => {
    const tmp = makeTmp();
    const fpath = makeLockfile(tmp, "package-lock.json");
    const result = await pre_read(readPayload("io-pkglock", fpath));
    _assert_continue(result);
    expect("hookSpecificOutput" in result).toBe(true);
    const ctx = (result["hookSpecificOutput"] as Record<string, unknown>)["additionalContext"] as string;
    expect(ctx).toContain("package-lock.json");
    expect(ctx.toLowerCase()).toContain("lockfile");
  });

  it("test_min_js_fires", async () => {
    const tmp = makeTmp();
    const p = path.join(tmp, "app.min.js");
    fs.writeFileSync(p, "!function(){}".repeat(1000));
    const result = await pre_read(readPayload("io-minjs", p));
    _assert_continue(result);
    expect("hookSpecificOutput" in result).toBe(true);
    const ctx = ((result["hookSpecificOutput"] as Record<string, unknown>)["additionalContext"] as string).toLowerCase();
    expect(ctx.includes("min") || ctx.includes("minified") || ctx.includes("bundle")).toBe(true);
  });

  it("test_regular_py_does_not_fire", async () => {
    const tmp = makeTmp();
    const p = path.join(tmp, "regular.py");
    fs.writeFileSync(p, "def foo(): pass\n".repeat(5000));
    const result = await pre_read(readPayload("io-py", p));
    _assert_continue(result);
    if ("hookSpecificOutput" in result) {
      const ctx = (((result["hookSpecificOutput"] as Record<string, unknown>)["additionalContext"] as string) ?? "").toLowerCase();
      expect(ctx).not.toContain("lockfile");
      expect(ctx).not.toContain("minified");
    }
  });

  it("test_surgical_read_no_hint", async () => {
    const tmp = makeTmp();
    const fpath = makeLockfile(tmp, "uv.lock");
    const result = await pre_read(readPayload("io-surgical", fpath, 10, 20));
    _assert_continue(result);
    if ("hookSpecificOutput" in result) {
      const ctx = (((result["hookSpecificOutput"] as Record<string, unknown>)["additionalContext"] as string) ?? "").toLowerCase();
      expect(ctx).not.toContain("lockfile");
    }
  });

  it("test_tiny_lockfile_no_hint", async () => {
    const tmp = makeTmp();
    const p = path.join(tmp, "uv.lock");
    fs.writeFileSync(p, "# tiny\n".repeat(10));
    const result = await pre_read(readPayload("io-tiny", p));
    _assert_continue(result);
    if ("hookSpecificOutput" in result) {
      const ctx = (((result["hookSpecificOutput"] as Record<string, unknown>)["additionalContext"] as string) ?? "").toLowerCase();
      expect(ctx).not.toContain("lockfile");
    }
  });

  it("test_session_dedup_within_verbose_window", async () => {
    const tmp = makeTmp();
    const fpath = makeLockfile(tmp, "cargo.lock");
    const payload = readPayload("io-dedup", fpath);

    const result1 = await pre_read(payload);
    _assert_continue(result1);
    expect("hookSpecificOutput" in result1).toBe(true);
    const ctx1 = ((result1["hookSpecificOutput"] as Record<string, unknown>)["additionalContext"] as string).toLowerCase();
    expect(ctx1).toContain("lockfile");

    const result2 = await pre_read(payload);
    _assert_continue(result2);
    expect("hookSpecificOutput" in result2).toBe(true);
    const ctx2 = (((result2["hookSpecificOutput"] as Record<string, unknown>)["additionalContext"] as string) ?? "").toLowerCase();
    expect(ctx2).toContain("lockfile");
  });

  it("test_session_dedup_emits_stub_past_verbose_window", async () => {
    const tmp = makeTmp();
    const fpath = makeLockfile(tmp, "cargo.lock");
    const payload = readPayload("io-dedup-stub", fpath);

    for (let i = 0; i < 2; i++) {
      pre_read(payload);
    }
    const result3 = await pre_read(payload);
    _assert_continue(result3);
    if ("hookSpecificOutput" in result3) {
      const ctx3 = (((result3["hookSpecificOutput"] as Record<string, unknown>)["additionalContext"] as string) ?? "").toLowerCase();
      expect(ctx3).not.toContain("lockfile");
    }
  });
});

// ---------------------------------------------------------------------------
// Content-unchanged short-circuit hint tests
// ---------------------------------------------------------------------------

describe("TestUnchangedFileHint", () => {
  function makeFile(dir: string, name: string, content?: Buffer): string {
    const p = path.join(dir, name);
    const c = content ?? Buffer.from("x = 1\n".repeat(200));
    fs.writeFileSync(p, c);
    return p;
  }

  function readPayload(sid: string, p: string, offset?: number, limit?: number): HookPayload {
    const tool_input: Record<string, unknown> = { file_path: p };
    if (offset !== undefined) {
      tool_input["offset"] = offset;
    }
    if (limit !== undefined) {
      tool_input["limit"] = limit;
    }
    return { session_id: sid, tool_name: "Read", tool_input, cwd: p };
  }

  function sha256hex(buf: Buffer): string {
    return crypto.createHash("sha256").update(buf).digest("hex");
  }

  it("test_unchanged_hint_fires_after_edit", async () => {
    const tmp = makeTmp();
    const sid = "unchanged-basic";
    const fpath = makeFile(tmp, "mod.py");
    const content = fs.readFileSync(fpath);

    session.mark_file_read(sid, fpath, null, null);
    snapshots.store(sid, fpath, content);
    session.set_snapshot_sha(sid, fpath, sha256hex(content));
    session.mark_file_edited(sid, fpath);

    const result = await pre_read(readPayload(sid, fpath));
    _assert_continue(result);
    expect("hookSpecificOutput" in result).toBe(true);
    const ctx = (result["hookSpecificOutput"] as Record<string, unknown>)["additionalContext"] as string;
    expect(ctx.toLowerCase()).toContain("unchanged");
    expect(ctx).toContain("mod.py");
  });

  it("test_no_hint_when_offset_supplied", async () => {
    const tmp = makeTmp();
    const sid = "unchanged-offset";
    const fpath = makeFile(tmp, "partial.py");
    const content = fs.readFileSync(fpath);

    session.mark_file_read(sid, fpath, null, null);
    snapshots.store(sid, fpath, content);
    session.set_snapshot_sha(sid, fpath, sha256hex(content));
    session.mark_file_edited(sid, fpath);

    const result = await pre_read(readPayload(sid, fpath, 10));
    _assert_continue(result);
    if ("hookSpecificOutput" in result) {
      const ctx = (((result["hookSpecificOutput"] as Record<string, unknown>)["additionalContext"] as string) ?? "").toLowerCase();
      expect(ctx).not.toContain("unchanged");
    }
  });

  it("test_no_hint_when_limit_supplied", async () => {
    const tmp = makeTmp();
    const sid = "unchanged-limit";
    const fpath = makeFile(tmp, "sliced.py");
    const content = fs.readFileSync(fpath);

    session.mark_file_read(sid, fpath, null, null);
    snapshots.store(sid, fpath, content);
    session.set_snapshot_sha(sid, fpath, sha256hex(content));
    session.mark_file_edited(sid, fpath);

    const result = await pre_read(readPayload(sid, fpath, undefined, 50));
    _assert_continue(result);
    if ("hookSpecificOutput" in result) {
      const ctx = (((result["hookSpecificOutput"] as Record<string, unknown>)["additionalContext"] as string) ?? "").toLowerCase();
      expect(ctx).not.toContain("unchanged");
    }
  });

  it("test_no_hint_when_content_changed", async () => {
    const tmp = makeTmp();
    const sid = "unchanged-mutated";
    const fpath = makeFile(tmp, "mutated.py");
    const original = fs.readFileSync(fpath);

    session.mark_file_read(sid, fpath, null, null);
    snapshots.store(sid, fpath, original);
    session.set_snapshot_sha(sid, fpath, sha256hex(original));
    session.mark_file_edited(sid, fpath);

    fs.appendFileSync(fpath, "\n# external change\n");

    const result = await pre_read(readPayload(sid, fpath));
    _assert_continue(result);
    if ("hookSpecificOutput" in result) {
      const ctx = (((result["hookSpecificOutput"] as Record<string, unknown>)["additionalContext"] as string) ?? "").toLowerCase();
      expect(ctx).not.toContain("unchanged");
    }
  });

  it("test_no_hint_when_no_snapshot", async () => {
    const tmp = makeTmp();
    const sid = "unchanged-no-snap";
    const fpath = makeFile(tmp, "nosnap.py");

    session.mark_file_read(sid, fpath, null, null);
    session.mark_file_edited(sid, fpath);

    const result = await pre_read(readPayload(sid, fpath));
    _assert_continue(result);
    if ("hookSpecificOutput" in result) {
      const ctx = (((result["hookSpecificOutput"] as Record<string, unknown>)["additionalContext"] as string) ?? "").toLowerCase();
      expect(ctx).not.toContain("unchanged");
    }
  });

  it("test_no_hint_when_not_edited", async () => {
    const tmp = makeTmp();
    const sid = "unchanged-no-edit";
    const fpath = makeFile(tmp, "noedit.py");
    const content = fs.readFileSync(fpath);

    session.mark_file_read(sid, fpath, null, null);
    snapshots.store(sid, fpath, content);
    session.set_snapshot_sha(sid, fpath, sha256hex(content));

    const result = await pre_read(readPayload(sid, fpath));
    _assert_continue(result);
    if ("hookSpecificOutput" in result) {
      const ctx = (((result["hookSpecificOutput"] as Record<string, unknown>)["additionalContext"] as string) ?? "").toLowerCase();
      expect(ctx).not.toContain("unchanged");
    }
  });

  it("test_unchanged_hint_carries_token_saving", async () => {
    const tmp = makeTmp();
    const sid = "unchanged-tokens";
    const fpath = makeFile(tmp, "big.py");
    const content = fs.readFileSync(fpath);

    session.mark_file_read(sid, fpath, null, null);
    snapshots.store(sid, fpath, content);
    session.set_snapshot_sha(sid, fpath, sha256hex(content));
    session.mark_file_edited(sid, fpath);

    const hint = build_unchanged_file_hint({ session_id: sid, file_path: fpath });
    expect(hint).not.toBeNull();
    expect((hint as { tokens_saved: number }).tokens_saved).toBeGreaterThan(0);
  });

  it("test_unchanged_hint_includes_sha_prefix", async () => {
    const tmp = makeTmp();
    const sid = "unchanged-sha-prefix";
    const fpath = makeFile(tmp, "sha_check.py");
    const content = fs.readFileSync(fpath);

    const expected_sha = sha256hex(content).slice(0, 8);

    session.mark_file_read(sid, fpath, null, null);
    snapshots.store(sid, fpath, content);
    session.set_snapshot_sha(sid, fpath, sha256hex(content));
    session.mark_file_edited(sid, fpath);

    const hint = build_unchanged_file_hint({ session_id: sid, file_path: fpath });
    expect(hint).not.toBeNull();
    const hint_text = String(hint);
    expect(hint_text).toContain(`sha:${expected_sha}`);
    expect(/sha:[0-9a-f]{8}/.test(hint_text)).toBe(true);
  });
});
