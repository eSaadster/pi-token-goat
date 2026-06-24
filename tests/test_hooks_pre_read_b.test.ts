/**
 * Tests for the pre_read hook handler — part B (curator counting, surgical-read
 * hint, grep-symbol/dotted redirect, flush regressions, safe-load regression,
 * Bash fast-path). 1:1 port of tests/test_hooks_pre_read.py; see part A's header
 * for the shared seam mapping.
 *
 * DB-fake mapping: Python monkeypatches `db.open_project_readonly` with a
 * @contextmanager yielding a fake conn exposing `.execute(sql, params).fetchall()`.
 * The TS port's db.openProjectReadonly(hash, body) instead invokes `body(conn)`
 * where conn is a better-sqlite3 handle with `.prepare(sql).all(...)`. So we
 * vi.spyOn(db, "openProjectReadonly") with `(hash, body) => body(fakeConn)` and
 * give fakeConn a `.prepare(sql).all(...)` returning the desired rows.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import * as hooks_read from "../src/token_goat/hooks_read.js";
import * as hooks_cli from "../src/token_goat/hooks_cli.js";
import * as session from "../src/token_goat/session.js";
import * as db from "../src/token_goat/db.js";
import * as bash_cache from "../src/token_goat/bash_cache.js";
import * as project from "../src/token_goat/project.js";
import * as read_replacement from "../src/token_goat/read_replacement.js";
import * as snapshots from "../src/token_goat/snapshots.js";
import * as hints from "../src/token_goat/hints.js";
import { ReadHint } from "../src/token_goat/hints.js";
import { getDataDirOverride } from "../src/token_goat/reset.js";
import type { HookPayload } from "../src/token_goat/types.js";
import type { Project } from "../src/token_goat/project.js";

const pre_read = hooks_read.pre_read;
const post_bash = hooks_read.post_bash;
const post_read = hooks_read.post_read;

function _assert_continue(result: Record<string, unknown>): void {
  expect(result["continue"]).toBe(true);
}

const _tmpRoots: string[] = [];
function makeTmp(prefix = "tg-prrb-"): string {
  const d = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
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

/** The per-test data dir setup.ts installed; the Python tmp_data_dir analogue. */
function dataDir(): string {
  const d = getDataDirOverride();
  if (d === undefined) {
    throw new Error("no data dir override installed (setup.ts beforeEach should set one)");
  }
  return d;
}

/** Build a fake Project rooted at a directory (Project(root=..., hash=..., marker=...)). */
function fakeProject(root: string): Project {
  return { root, hash: "deadbeef", marker: ".git" } as Project;
}

/**
 * Install a fake db.openProjectReadonly that calls the body with a conn whose
 * prepare(sql).all(...) returns `rows`. Returns the spy.
 */
function spyDbRows(rows: Array<Record<string, unknown>>): void {
  const fakeConn = {
    prepare(_sql: string) {
      return {
        all(..._params: unknown[]) {
          return rows;
        },
      };
    },
  };
  vi.spyOn(db, "openProjectReadonly").mockImplementation(
    (<T>(_hash: string, body: (conn: unknown) => T): T => body(fakeConn)) as typeof db.openProjectReadonly,
  );
}

/** Capture the params the SQL prepare(...).all(...) receives. */
function spyDbCapture(rows: Array<Record<string, unknown>>, captured: unknown[][]): void {
  const fakeConn = {
    prepare(_sql: string) {
      return {
        all(...params: unknown[]) {
          captured.push(params);
          return rows;
        },
      };
    },
  };
  vi.spyOn(db, "openProjectReadonly").mockImplementation(
    (<T>(_hash: string, body: (conn: unknown) => T): T => body(fakeConn)) as typeof db.openProjectReadonly,
  );
}

// ---------------------------------------------------------------------------
// Curator: ignored-hint counting via _check_ignored_hint
// ---------------------------------------------------------------------------

describe("TestCuratorIgnoredHintCounting", () => {
  it("test_hint_then_read_increments_ignored", async () => {
    const sid = "curator_ignored_1";
    const cache = session.load(sid);
    const norm_path = "/proj/foo.py";
    cache.recent_hints = [[norm_path, Date.now() / 1000]];
    cache.hints_emitted = 1;
    cache.hints_ignored = 0;
    cache._invalidate_json_cache();

    hooks_read._check_ignored_hint(cache, norm_path);

    expect(cache.hints_ignored).toBe(1);
    expect(cache.recent_hints.every(([p]) => p !== norm_path)).toBe(true);
  });

  it("test_no_hint_for_path_does_not_increment", async () => {
    const sid = "curator_ignored_2";
    const cache = session.load(sid);
    cache.recent_hints = [["/proj/other.py", 0.0]];
    cache.hints_ignored = 0;
    cache._invalidate_json_cache();

    hooks_read._check_ignored_hint(cache, "/proj/foo.py");

    expect(cache.hints_ignored).toBe(0);
  });

  it("test_empty_recent_hints_does_not_increment", async () => {
    const sid = "curator_ignored_3";
    const cache = session.load(sid);
    cache.hints_ignored = 0;

    hooks_read._check_ignored_hint(cache, "/proj/foo.py");

    expect(cache.hints_ignored).toBe(0);
  });

  it("test_second_read_same_path_does_not_double_count", async () => {
    const sid = "curator_ignored_4";
    const cache = session.load(sid);
    const norm_path = "/proj/bar.py";
    cache.recent_hints = [[norm_path, Date.now() / 1000]];
    cache.hints_emitted = 1;
    cache.hints_ignored = 0;
    cache._invalidate_json_cache();

    hooks_read._check_ignored_hint(cache, norm_path);
    expect(cache.hints_ignored).toBe(1);

    hooks_read._check_ignored_hint(cache, norm_path);
    expect(cache.hints_ignored).toBe(1);
  });

  it("test_hints_ignored_persisted_for_large_file", async () => {
    const tmp = makeTmp();
    const sid = "curator_ignored_large_file";
    const fpath = path.join(tmp, "big.py");
    fs.writeFileSync(fpath, Buffer.alloc(snapshots.MAX_SNAPSHOT_BYTES + 1, "x"));

    const cache = session.load(sid);
    const norm_path = session._normalize_path(fpath);
    cache.recent_hints = [[norm_path, Date.now() / 1000]];
    cache.hints_emitted = 1;
    cache.hints_ignored = 0;
    cache._invalidate_json_cache();
    session.save(cache);

    const payload: HookPayload = {
      session_id: sid,
      tool_name: "Read",
      tool_input: { file_path: fpath },
      cwd: tmp,
    };
    post_read(payload);

    const reloaded = session.load(sid);
    expect(reloaded.hints_ignored).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Curator: _check_ignored_hint_by_key shared helper
// ---------------------------------------------------------------------------

describe("TestCheckIgnoredHintByKey", () => {
  it("test_matching_key_increments_ignored", async () => {
    const cache = session.load("by_key_1");
    const key = "abc123";
    cache.recent_hints = [[key, Date.now() / 1000]];
    cache.hints_ignored = 0;
    cache._invalidate_json_cache();

    hooks_read._check_ignored_hint_by_key(cache, key, "test_label");

    expect(cache.hints_ignored).toBe(1);
    expect(cache.recent_hints.every(([k]) => k !== key)).toBe(true);
  });

  it("test_non_matching_key_no_change", async () => {
    const cache = session.load("by_key_2");
    cache.recent_hints = [["other_key", 0.0]];
    cache.hints_ignored = 0;
    cache._invalidate_json_cache();

    hooks_read._check_ignored_hint_by_key(cache, "target_key", "label");

    expect(cache.hints_ignored).toBe(0);
  });

  it("test_empty_ring_buffer_no_change", async () => {
    const cache = session.load("by_key_3");
    cache.hints_ignored = 0;

    hooks_read._check_ignored_hint_by_key(cache, "any_key", "label");

    expect(cache.hints_ignored).toBe(0);
  });

  it("test_second_call_no_double_count", async () => {
    const cache = session.load("by_key_4");
    const key = "dedup_sha";
    cache.recent_hints = [[key, Date.now() / 1000]];
    cache.hints_ignored = 0;
    cache._invalidate_json_cache();

    hooks_read._check_ignored_hint_by_key(cache, key, "label");
    expect(cache.hints_ignored).toBe(1);

    hooks_read._check_ignored_hint_by_key(cache, key, "label");
    expect(cache.hints_ignored).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Curator: ignored-hint counting via _check_ignored_bash_hint
// ---------------------------------------------------------------------------

describe("TestCuratorIgnoredBashHintCounting", () => {
  function makeCacheWithBashHint(sid: string, command: string): [ReturnType<typeof session.load>, string] {
    const cache = session.load(sid);
    const cmd_sha = bash_cache.command_hash(command);
    cache.recent_hints = [[cmd_sha, Date.now() / 1000]];
    cache.hints_emitted = 1;
    cache.hints_ignored = 0;
    cache._invalidate_json_cache();
    return [cache, cmd_sha];
  }

  it("test_bash_rerun_increments_ignored", async () => {
    const sid = "bash_ignored_1";
    const command = "pytest -v tests/";
    const [cache, cmd_sha] = makeCacheWithBashHint(sid, command);

    hooks_read._check_ignored_bash_hint(cache, command);

    expect(cache.hints_ignored).toBe(1);
    expect(cache.recent_hints.every(([k]) => k !== cmd_sha)).toBe(true);
  });

  it("test_no_prior_hint_does_not_increment", async () => {
    const sid = "bash_ignored_2";
    const cache = session.load(sid);
    cache.recent_hints = [];
    cache.hints_ignored = 0;
    cache._invalidate_json_cache();

    hooks_read._check_ignored_bash_hint(cache, "pytest -v tests/");

    expect(cache.hints_ignored).toBe(0);
  });

  it("test_different_command_does_not_increment", async () => {
    const sid = "bash_ignored_3";
    const command_hinted = "rg foo src/";
    const command_run = "pytest -v tests/";
    const [cache] = makeCacheWithBashHint(sid, command_hinted);

    hooks_read._check_ignored_bash_hint(cache, command_run);

    expect(cache.hints_ignored).toBe(0);
  });

  it("test_second_rerun_does_not_double_count", async () => {
    const sid = "bash_ignored_4";
    const command = "npm test";
    const [cache] = makeCacheWithBashHint(sid, command);

    hooks_read._check_ignored_bash_hint(cache, command);
    expect(cache.hints_ignored).toBe(1);

    hooks_read._check_ignored_bash_hint(cache, command);
    expect(cache.hints_ignored).toBe(1);
  });

  it("test_post_bash_increments_ignored_via_hook", async () => {
    const sid = "bash_ignored_hook_1";
    const command = "git log --oneline -10";
    const cmd_sha = bash_cache.command_hash(command);

    const cache = session.load(sid);
    cache.recent_hints = [[cmd_sha, Date.now() / 1000]];
    cache.hints_emitted = 1;
    cache.hints_ignored = 0;
    cache._invalidate_json_cache();
    session.save(cache);

    const payload: HookPayload = {
      session_id: sid,
      tool_name: "Bash",
      tool_input: { command },
      tool_response: "abc123 Add feature\n",
    } as unknown as HookPayload;
    post_bash(payload);

    const reloaded = session.load(sid);
    expect(reloaded.hints_ignored).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Surgical-read hint + its integration into pre_read
// ---------------------------------------------------------------------------

describe("TestSurgicalReadHint", () => {
  it("test_hint_fires_when_symbols_overlap_range", async () => {
    vi.spyOn(hooks_read, "_try_surgical_read_hint").mockReturnValue(
      'Lines 10–30 of `auth.py` span `login`. ' +
        'Use `token-goat read "src/auth.py::login"` for a surgical read (~90% fewer tokens on repeat access).',
    );

    const payload: HookPayload = {
      session_id: "surg-1",
      tool_name: "Read",
      tool_input: { file_path: "/proj/src/auth.py", offset: 10, limit: 21 },
      cwd: "/proj",
    };
    const result = await pre_read(payload);
    const hso = (result["hookSpecificOutput"] ?? {}) as Record<string, unknown>;
    const ctx = (hso["additionalContext"] as string) ?? "";
    expect(ctx).toContain("token-goat read");
    expect(ctx).toContain("login");
  });

  it("test_hint_deduped_on_second_read", async () => {
    vi.spyOn(hooks_read, "_try_surgical_read_hint").mockReturnValue(
      'Lines 10–30 of `auth.py` span `login`. Use `token-goat read "src/auth.py::login"` for a surgical read (~90% fewer tokens on repeat access).',
    );

    const payload: HookPayload = {
      session_id: "surg-2",
      tool_name: "Read",
      tool_input: { file_path: "/proj/src/auth.py", offset: 10, limit: 21 },
      cwd: "/proj",
    };
    pre_read(payload);
    const result2 = await pre_read(payload);
    const hso2 = (result2["hookSpecificOutput"] ?? {}) as Record<string, unknown>;
    const ctx2 = (hso2["additionalContext"] as string) ?? "";
    expect(!ctx2.includes("token-goat read") || !ctx2.includes("login")).toBe(true);
  });

  it("test_no_hint_when_no_offset_limit", async () => {
    const called: Array<[number, number]> = [];
    vi.spyOn(hooks_read, "_try_surgical_read_hint").mockImplementation(
      (_fp: string, offset: number, limit: number) => {
        called.push([offset, limit]);
        return null;
      },
    );

    const payload: HookPayload = {
      session_id: "surg-3",
      tool_name: "Read",
      tool_input: { file_path: "/proj/src/auth.py" },
      cwd: "/proj",
    };
    pre_read(payload);
    expect(called.length).toBe(0);
  });

  it("test_try_surgical_read_hint_returns_none_when_no_project", async () => {
    const result = hooks_read._try_surgical_read_hint("/some/random/file.py", 10, 20, "/some/random");
    expect(result).toBeNull();
  });

  it("test_try_surgical_read_hint_returns_none_on_db_error", async () => {
    const data = dataDir();
    vi.spyOn(project, "find_project").mockReturnValue(fakeProject(data));
    vi.spyOn(read_replacement, "resolve_file_rel").mockReturnValue("src/auth.py");
    vi.spyOn(db, "openProjectReadonly").mockImplementation((() => {
      throw new Error("DB unavailable");
    }) as typeof db.openProjectReadonly);

    const result = hooks_read._try_surgical_read_hint("/proj/src/auth.py", 10, 20, data);
    expect(result).toBeNull();
  });

  it("test_try_surgical_read_hint_names_symbol", async () => {
    const data = dataDir();
    vi.spyOn(project, "find_project").mockReturnValue(fakeProject(data));
    vi.spyOn(read_replacement, "resolve_file_rel").mockReturnValue("src/auth.py");
    spyDbRows([{ name: "login", kind: "function" }]);

    const result = hooks_read._try_surgical_read_hint("/proj/src/auth.py", 10, 21, data);
    expect(result).not.toBeNull();
    expect(result!).toContain("login");
    expect(result!).toContain("token-goat read");
    expect(result!).toContain("src/auth.py::login");
  });

  it("test_try_surgical_read_hint_returns_none_for_too_many_symbols", async () => {
    const data = dataDir();
    vi.spyOn(project, "find_project").mockReturnValue(fakeProject(data));
    vi.spyOn(read_replacement, "resolve_file_rel").mockReturnValue("src/auth.py");
    spyDbRows([
      { name: "a", kind: "function" },
      { name: "b", kind: "function" },
      { name: "c", kind: "function" },
      { name: "d", kind: "function" },
    ]);

    const result = hooks_read._try_surgical_read_hint("/proj/src/auth.py", 1, 500, data);
    expect(result).toBeNull();
  });

  it("test_try_surgical_read_hint_sql_params_are_1indexed", async () => {
    const data = dataDir();
    vi.spyOn(project, "find_project").mockReturnValue(fakeProject(data));
    vi.spyOn(read_replacement, "resolve_file_rel").mockReturnValue("src/auth.py");
    const captured: unknown[][] = [];
    spyDbCapture([{ name: "init_module", kind: "function" }], captured);

    hooks_read._try_surgical_read_hint("/proj/src/auth.py", 0, 50, data);

    expect(captured.length).toBeGreaterThan(0);
    // params is (file_rel, req_end, req_start) per the SQL WHERE clause order.
    const params = captured[0]!;
    const [, req_end, req_start] = params;
    expect(req_start).toBe(1);
    expect(req_end).toBe(50);
  });

  it("test_try_surgical_read_hint_3_symbols_fires", async () => {
    const data = dataDir();
    vi.spyOn(project, "find_project").mockReturnValue(fakeProject(data));
    vi.spyOn(read_replacement, "resolve_file_rel").mockReturnValue("src/auth.py");
    spyDbRows([
      { name: "alpha", kind: "function" },
      { name: "beta", kind: "function" },
      { name: "gamma", kind: "function" },
    ]);

    const result = hooks_read._try_surgical_read_hint("/proj/src/auth.py", 10, 60, data);
    expect(result).not.toBeNull();
    expect(result!).toContain("alpha");
    expect(result!).toContain("beta");
    expect(result!).toContain("gamma");
    expect(result!).toContain("token-goat read");
  });

  it("test_try_surgical_read_hint_limit_is_sentinel_shows_eof", async () => {
    const data = dataDir();
    vi.spyOn(project, "find_project").mockReturnValue(fakeProject(data));
    vi.spyOn(read_replacement, "resolve_file_rel").mockReturnValue("src/auth.py");
    spyDbRows([{ name: "login", kind: "function" }]);

    const result = hooks_read._try_surgical_read_hint("/proj/src/auth.py", 9, 2000, data, {
      limit_is_sentinel: true,
    });
    expect(result).not.toBeNull();
    expect(result!).toContain("EOF");
    expect(result!).not.toContain("2000");
    expect(result!).not.toContain("2009");
    expect(result!).toContain("Lines 10–EOF");
    expect(result!).toContain("token-goat read");
    expect(result!).toContain("src/auth.py::login");
  });

  it("test_tail_skip_triggers_surgical_hint_with_eof_range", async () => {
    const received: Array<[number, number, boolean]> = [];
    vi.spyOn(hooks_read, "_try_surgical_read_hint").mockImplementation(
      (_fp: string, offset: number, _limit: number, _cwd: string | null, opts?: { limit_is_sentinel?: boolean }) => {
        const sentinel = opts?.limit_is_sentinel ?? false;
        received.push([offset, _limit, sentinel]);
        if (sentinel) {
          return (
            `Lines ${offset + 1}–EOF of \`auth.py\` span \`login\`. ` +
            'Use `token-goat read "src/auth.py::login"` for a surgical read (~90% fewer tokens on repeat access).'
          );
        }
        return null;
      },
    );

    const payload: HookPayload = {
      session_id: "surg-tail-skip-1",
      tool_name: "Bash",
      tool_input: { command: "tail -n +10 /proj/src/auth.py" },
      cwd: "/proj",
    };
    const result = await pre_read(payload);

    expect(received.length).toBeGreaterThan(0);
    const [offset_seen, limit_seen, sentinel_seen] = received[0]!;
    expect(offset_seen).toBe(9);
    expect(limit_seen).toBe(2000);
    expect(sentinel_seen).toBe(true);

    const hso = (result["hookSpecificOutput"] ?? {}) as Record<string, unknown>;
    const ctx = (hso["additionalContext"] as string) ?? "";
    expect(ctx).toContain("EOF");
    expect(!ctx.includes("2009") && !ctx.includes("2000")).toBe(true);
  });

  it("test_sed_command_triggers_surgical_hint", async () => {
    const received: Array<[number, number, boolean]> = [];
    vi.spyOn(hooks_read, "_try_surgical_read_hint").mockImplementation(
      (_fp: string, offset: number, limit: number, _cwd: string | null, opts?: { limit_is_sentinel?: boolean }) => {
        received.push([offset, limit, opts?.limit_is_sentinel ?? false]);
        return (
          'Lines 10–30 of `auth.py` span `login`. ' +
          'Use `token-goat read "src/auth.py::login"` for a surgical read (~90% fewer tokens on repeat access).'
        );
      },
    );

    const payload: HookPayload = {
      session_id: "surg-sed-1",
      tool_name: "Bash",
      tool_input: { command: "sed -n '10,30p' /proj/src/auth.py" },
      cwd: "/proj",
    };
    const result = await pre_read(payload);
    const hso = (result["hookSpecificOutput"] ?? {}) as Record<string, unknown>;
    const ctx = (hso["additionalContext"] as string) ?? "";
    expect(ctx).toContain("token-goat read");
    expect(ctx).toContain("login");

    expect(received.length).toBeGreaterThan(0);
    const [offset_seen, limit_seen, sentinel_seen] = received[0]!;
    expect(offset_seen).toBe(9);
    expect(limit_seen).toBe(21);
    expect(sentinel_seen).toBe(false);
  });

  it("test_offset_zero_does_not_suppress_hint", async () => {
    const data = dataDir();
    vi.spyOn(project, "find_project").mockReturnValue(fakeProject(data));
    vi.spyOn(read_replacement, "resolve_file_rel").mockReturnValue("src/auth.py");
    spyDbRows([{ name: "module_init", kind: "function" }]);

    const result = hooks_read._try_surgical_read_hint("/proj/src/auth.py", 0, 50, data);
    expect(result).not.toBeNull();
    expect(result!).toContain("module_init");
    expect(result!).toContain("token-goat read");
  });
});

// ---------------------------------------------------------------------------
// Grep symbol / dotted redirect
// ---------------------------------------------------------------------------

describe("TestGrepSymbolRedirect", () => {
  it("test_hint_fires_for_indexed_identifier", async () => {
    vi.spyOn(hooks_read, "_try_grep_symbol_hint").mockImplementation((pattern: string) => {
      if (pattern === "my_function") {
        return (
          "Symbol `my_function` is indexed — use `token-goat symbol my_function` " +
          "to jump directly to its definition(s) (`auth.py:42` (function)) " +
          "instead of scanning files with grep (~95% fewer tokens)."
        );
      }
      return null;
    });

    const payload: HookPayload = {
      session_id: "grep-sym-1",
      tool_name: "Grep",
      tool_input: { pattern: "my_function", path: "src/" },
      cwd: "/proj",
    };
    const result = await pre_read(payload);
    const hso = (result["hookSpecificOutput"] ?? {}) as Record<string, unknown>;
    const ctx = (hso["additionalContext"] as string) ?? "";
    expect(ctx).toContain("token-goat symbol");
    expect(ctx).toContain("my_function");
  });

  it("test_hint_deduped_on_second_grep", async () => {
    vi.spyOn(hooks_read, "_try_grep_symbol_hint").mockReturnValue(
      "Symbol `my_function` is indexed — use `token-goat symbol my_function` " +
        "to jump directly to its definition(s) (`auth.py:42` (function)) " +
        "instead of scanning files with grep (~95% fewer tokens).",
    );

    const payload: HookPayload = {
      session_id: "grep-sym-2",
      tool_name: "Grep",
      tool_input: { pattern: "my_function" },
      cwd: "/proj",
    };
    pre_read(payload);
    const result2 = await pre_read(payload);
    const hso2 = (result2["hookSpecificOutput"] ?? {}) as Record<string, unknown>;
    const ctx2 = (hso2["additionalContext"] as string) ?? "";
    expect(ctx2).not.toContain("token-goat symbol");
  });

  it("test_no_hint_for_regex_pattern", async () => {
    const called: string[] = [];
    vi.spyOn(hooks_read, "_try_grep_symbol_hint").mockImplementation((pattern: string) => {
      called.push(pattern);
      return null;
    });

    for (const regex_pattern of ["def\\s+foo", "import.*os", "foo.bar", "foo|bar"]) {
      pre_read({
        session_id: "grep-sym-3",
        tool_name: "Grep",
        tool_input: { pattern: regex_pattern },
        cwd: "/proj",
      });
    }
    expect(called.length).toBe(0);
  });

  it("test_try_grep_symbol_hint_rejects_short_pattern", async () => {
    expect(hooks_read._try_grep_symbol_hint("ab", "/proj")).toBeNull();
    expect(hooks_read._try_grep_symbol_hint("_x", "/proj")).toBeNull();
  });

  it("test_try_grep_symbol_hint_rejects_regex_metacharacters", async () => {
    expect(hooks_read._try_grep_symbol_hint("foo.bar", "/proj")).toBeNull();
    expect(hooks_read._try_grep_symbol_hint("foo|bar", "/proj")).toBeNull();
    expect(hooks_read._try_grep_symbol_hint("def.*foo", "/proj")).toBeNull();
    expect(hooks_read._try_grep_symbol_hint("my func", "/proj")).toBeNull();
  });

  it("test_try_grep_symbol_hint_names_symbol", async () => {
    const data = dataDir();
    vi.spyOn(project, "find_project").mockReturnValue(fakeProject(data));
    spyDbRows([{ name: "my_function", kind: "function", file_rel: "src/auth.py", line: 42 }]);

    const result = hooks_read._try_grep_symbol_hint("my_function", data);
    expect(result).not.toBeNull();
    expect(result!).toContain("token-goat read");
    expect(result!).toContain("auth.py::my_function");
    expect(result!).toContain("token-goat symbol my_function");
    expect(result!).toContain("auth.py:42");
  });

  it("test_try_grep_symbol_hint_returns_none_for_too_many_symbols", async () => {
    const data = dataDir();
    vi.spyOn(project, "find_project").mockReturnValue(fakeProject(data));
    const rows = Array.from({ length: 6 }, (_v, i) => ({
      name: "func",
      kind: "function",
      file_rel: `src/mod${i}.py`,
      line: i * 10,
    }));
    spyDbRows(rows);

    const result = hooks_read._try_grep_symbol_hint("func", data);
    expect(result).toBeNull();
  });

  it("test_try_grep_symbol_hint_5_symbols_fires", async () => {
    const data = dataDir();
    vi.spyOn(project, "find_project").mockReturnValue(fakeProject(data));
    const rows = Array.from({ length: 5 }, (_v, i) => ({
      name: "func",
      kind: "function",
      file_rel: `src/mod${i}.py`,
      line: i * 10,
    }));
    spyDbRows(rows);

    const result = hooks_read._try_grep_symbol_hint("func", data);
    expect(result).not.toBeNull();
    expect(result!).toContain("token-goat symbol func");
    expect(result!).toContain("mod0.py");
    expect(result!).not.toContain("token-goat read");
  });

  it("test_try_grep_symbol_hint_2_symbols_uses_symbol_command", async () => {
    const data = dataDir();
    vi.spyOn(project, "find_project").mockReturnValue(fakeProject(data));
    spyDbRows([
      { name: "parse", kind: "function", file_rel: "src/mod0.py", line: 5 },
      { name: "parse", kind: "function", file_rel: "src/mod1.py", line: 15 },
    ]);

    const result = hooks_read._try_grep_symbol_hint("parse", data);
    expect(result).not.toBeNull();
    expect(result!).toContain("token-goat symbol parse");
    expect(result!).toContain("mod0.py");
    expect(result!).not.toContain("token-goat read");
  });

  it("test_hint_fires_for_dotted_pattern", async () => {
    vi.spyOn(hooks_read, "_try_grep_dotted_hint").mockImplementation((pattern: string) => {
      if (pattern === "Session.load") {
        return (
          "For `Session.load`, `load` is indexed — use `token-goat symbol load` " +
          "to jump to its definition(s) (`session.py:42` (function)) " +
          "instead of scanning files with grep (~95% fewer tokens)."
        );
      }
      return null;
    });

    const payload: HookPayload = {
      session_id: "grep-dotted-1",
      tool_name: "Grep",
      tool_input: { pattern: "Session.load" },
      cwd: "/proj",
    };
    const result = await pre_read(payload);
    const hso = (result["hookSpecificOutput"] ?? {}) as Record<string, unknown>;
    const ctx = (hso["additionalContext"] as string) ?? "";
    expect(ctx).toContain("token-goat symbol load");
    expect(ctx).toContain("Session.load");
  });

  it("test_dotted_hint_deduped_on_second_grep", async () => {
    vi.spyOn(hooks_read, "_try_grep_dotted_hint").mockReturnValue(
      "For `Session.load`, `load` is indexed — use `token-goat symbol load` " +
        "to jump to its definition(s) (`session.py:42` (function)) " +
        "instead of scanning files with grep (~95% fewer tokens).",
    );

    const payload: HookPayload = {
      session_id: "grep-dotted-2",
      tool_name: "Grep",
      tool_input: { pattern: "Session.load" },
      cwd: "/proj",
    };
    pre_read(payload);
    const result2 = await pre_read(payload);
    const hso2 = (result2["hookSpecificOutput"] ?? {}) as Record<string, unknown>;
    const ctx2 = (hso2["additionalContext"] as string) ?? "";
    expect(ctx2).not.toContain("token-goat symbol load");
  });

  it("test_try_grep_dotted_hint_prefers_qualifier_match", async () => {
    const data = dataDir();
    vi.spyOn(project, "find_project").mockReturnValue(fakeProject(data));
    spyDbRows([
      { name: "load", kind: "function", file_rel: "src/session.py", line: 42 },
      { name: "load", kind: "function", file_rel: "src/config.py", line: 100 },
    ]);

    const result = hooks_read._try_grep_dotted_hint("Session.load", data);
    expect(result).not.toBeNull();
    expect(result!).toContain("session.py:42");
    expect(result!).not.toContain("config.py");
    expect(result!).toContain("token-goat read");
    expect(result!).toContain("src/session.py::load");
  });

  it("test_try_grep_dotted_hint_1_preferred_row_uses_read_command", async () => {
    const data = dataDir();
    vi.spyOn(project, "find_project").mockReturnValue(fakeProject(data));
    spyDbRows([{ name: "refresh", kind: "method", file_rel: "src/auth/token.py", line: 77 }]);

    const result = hooks_read._try_grep_dotted_hint("Token.refresh", data);
    expect(result).not.toBeNull();
    expect(result!).toContain("token-goat read");
    expect(result!).toContain("src/auth/token.py::refresh");
    expect(result!).toContain("token.py:77");
    expect(result!).not.toContain("token-goat symbol");
  });

  it("test_try_grep_dotted_hint_2_preferred_rows_uses_symbol_command", async () => {
    const data = dataDir();
    vi.spyOn(project, "find_project").mockReturnValue(fakeProject(data));
    spyDbRows([
      { name: "load", kind: "function", file_rel: "src/session.py", line: 42 },
      { name: "load", kind: "function", file_rel: "src/session_mgr.py", line: 77 },
    ]);

    const result = hooks_read._try_grep_dotted_hint("Session.load", data);
    expect(result).not.toBeNull();
    expect(result!).toContain("token-goat symbol load");
    expect(result!).toContain("session.py:42");
    expect(result!).toContain("session_mgr.py:77");
    expect(result!).not.toContain("token-goat read");
  });

  function dottedHintRows(stem_prefix: string, count: number): Array<Record<string, unknown>> {
    return Array.from({ length: count }, (_v, i) => ({
      name: "load",
      kind: "function",
      file_rel: `src/${stem_prefix}_${i}.py`,
      line: i * 10 + 5,
    }));
  }

  it("test_try_grep_dotted_hint_3_preferred_rows_fires", async () => {
    const data = dataDir();
    vi.spyOn(project, "find_project").mockReturnValue(fakeProject(data));
    spyDbRows(dottedHintRows("session", 3));

    const result = hooks_read._try_grep_dotted_hint("Session.load", data);
    expect(result).not.toBeNull();
    expect(result!).toContain("token-goat symbol load");
    expect(result!).not.toContain("token-goat read");
  });

  it("test_try_grep_dotted_hint_4_preferred_rows_returns_none", async () => {
    const data = dataDir();
    vi.spyOn(project, "find_project").mockReturnValue(fakeProject(data));
    spyDbRows(dottedHintRows("session", 4));

    const result = hooks_read._try_grep_dotted_hint("Session.load", data);
    expect(result).toBeNull();
  });

  it("test_try_grep_dotted_hint_returns_none_for_non_dotted_pattern", async () => {
    expect(hooks_read._try_grep_dotted_hint("my_function", "/proj")).toBeNull();
    expect(hooks_read._try_grep_dotted_hint("foo.bar.baz", "/proj")).toBeNull();
    expect(hooks_read._try_grep_dotted_hint("foo.", "/proj")).toBeNull();
    expect(hooks_read._try_grep_dotted_hint(".bar", "/proj")).toBeNull();
  });

  it("test_try_grep_dotted_hint_suppresses_self_like_qualifiers", async () => {
    const data = dataDir();
    vi.spyOn(project, "find_project").mockReturnValue(fakeProject(data));
    spyDbRows([{ name: "load", kind: "function", file_rel: "src/auth.py", line: 42 }]);

    for (const self_like_pattern of ["self.load", "cls.load", "this.load", "obj.load"]) {
      const result = hooks_read._try_grep_dotted_hint(self_like_pattern, data);
      expect(result).toBeNull();
    }
  });

  it("test_grep_symbol_redirect_hint_delivered_when_session_save_raises", async () => {
    vi.spyOn(hooks_read, "_try_grep_symbol_hint").mockReturnValue(
      'Symbol `compute` is indexed — use `token-goat read "src/util.py::compute"`...',
    );

    const data = dataDir();
    const original_save = session.save;
    const save_calls: number[] = [];
    vi.spyOn(session, "save").mockImplementation((cache) => {
      save_calls.push(1);
      if (save_calls.length >= 2) {
        throw new Error("disk full");
      }
      return original_save(cache);
    });

    const payload: HookPayload = {
      session_id: "save-error-1",
      tool_name: "Grep",
      tool_input: { pattern: "compute" },
      cwd: data,
    };
    const result = await pre_read(payload);

    const hso = (result["hookSpecificOutput"] ?? {}) as Record<string, unknown>;
    const ctx = (hso["additionalContext"] as string) ?? "";
    expect(ctx).toContain("token-goat read");
    expect(save_calls.length).toBeGreaterThanOrEqual(2);
  });

  it("test_grep_dedup_takes_priority_over_symbol_redirect", async () => {
    const symbol_redirect_called: string[] = [];
    vi.spyOn(hooks_read, "_try_grep_symbol_hint").mockImplementation((pattern: string) => {
      symbol_redirect_called.push(pattern);
      return "Symbol `my_function` is indexed — use `token-goat symbol my_function`...";
    });

    const sid = "grep-priority-1";
    session.mark_grep(sid, "my_function", null, 50);

    const payload: HookPayload = {
      session_id: sid,
      tool_name: "Grep",
      tool_input: { pattern: "my_function" },
      cwd: "/proj",
    };
    const result = await pre_read(payload);
    const hso = (result["hookSpecificOutput"] ?? {}) as Record<string, unknown>;
    const ctx = (hso["additionalContext"] as string) ?? "";
    expect(ctx).toBeTruthy();
    expect(symbol_redirect_called.length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Unchanged-file hint flush regression
// ---------------------------------------------------------------------------

describe("TestUnchangedFileHintFlushRegression", () => {
  it("test_unchanged_file_path_flushes_pending_save", async () => {
    const sid = "unchanged_flush_regression";
    const cache = session.load(sid);
    cache._pending_hint_save = true;

    const save_calls: unknown[] = [];
    vi.spyOn(session, "save").mockImplementation((c: unknown) => {
      save_calls.push(c);
      if ((c as { _pending_hint_save?: boolean })?._pending_hint_save) {
        (c as { _pending_hint_save: boolean })._pending_hint_save = false;
      }
    });
    vi.spyOn(session, "load").mockReturnValue(cache);

    const fake_hint = new ReadHint("`mod.py` unchanged since your edit. Already in context.", 50);
    vi.spyOn(hints, "build_unchanged_file_hint").mockReturnValue(fake_hint);
    vi.spyOn(db, "recordStat").mockImplementation(() => {});

    const payload: HookPayload = {
      session_id: sid,
      tool_name: "Read",
      tool_input: { file_path: "/proj/mod.py" },
      cwd: "/proj",
    };
    const result = await pre_read(payload);

    expect("hookSpecificOutput" in result).toBe(true);
    const ctx = result["hookSpecificOutput"] as Record<string, unknown>;
    expect((ctx["additionalContext"] as string) ?? "").toContain("unchanged since");
    expect(save_calls.length).toBeGreaterThanOrEqual(1);
  });

  it("test_pre_read_flushes_hint_save_on_early_recovery_return", async () => {
    const sid = "recovery_flush_regression";
    const recovery_text = "Recovery hint injected";

    const cache = session.load(sid);
    cache._pending_hint_save = true;

    const save_calls: unknown[] = [];
    vi.spyOn(session, "save").mockImplementation((c: unknown) => {
      save_calls.push(c);
      if ((c as { _pending_hint_save?: boolean })?._pending_hint_save) {
        (c as { _pending_hint_save: boolean })._pending_hint_save = false;
      }
    });
    vi.spyOn(session, "load").mockReturnValue(cache);
    vi.spyOn(hooks_read, "_check_recovery_pending").mockReturnValue(recovery_text);

    const payload: HookPayload = {
      session_id: sid,
      tool_name: "Read",
      tool_input: { file_path: "/proj/test.py" },
      cwd: "/proj",
    };
    const result = await pre_read(payload);

    expect("hookSpecificOutput" in result).toBe(true);
    expect((result["hookSpecificOutput"] as Record<string, unknown>)["additionalContext"]).toContain(recovery_text);
    expect(save_calls.length).toBeGreaterThanOrEqual(1);
  });

  it("test_pre_read_try_finally_guarantees_flush_on_any_return", async () => {
    const sid = "finally_flush_invariant";
    const cache = session.load(sid);
    cache._pending_hint_save = true;

    const save_calls: unknown[] = [];
    vi.spyOn(session, "save").mockImplementation((c: unknown) => {
      save_calls.push(c);
      if ((c as { _pending_hint_save?: boolean })?._pending_hint_save) {
        (c as { _pending_hint_save: boolean })._pending_hint_save = false;
      }
    });
    vi.spyOn(session, "load").mockReturnValue(cache);
    vi.spyOn(hooks_read, "_handle_index_only_file").mockReturnValue({ continue: true });

    const payload: HookPayload = {
      session_id: sid,
      tool_name: "Read",
      tool_input: { file_path: "/proj/uv.lock" },
      cwd: "/proj",
    };
    const result = await pre_read(payload);

    expect(result["continue"]).toBe(true);
    expect(save_calls.length).toBeGreaterThanOrEqual(1);
  });
});

// ---------------------------------------------------------------------------
// Regression: pre_read Bash branch uses safe_load, not bare load
// ---------------------------------------------------------------------------

describe("TestPreReadBashSafeLoadRegression", () => {
  it("test_corrupt_session_does_not_crash_bash_pre_read", async () => {
    vi.spyOn(session, "safe_load").mockReturnValue(null);

    const payload: HookPayload = {
      session_id: "corrupt_bash_sess",
      tool_name: "Bash",
      tool_input: { command: "pytest tests/" },
      cwd: "/proj",
    };
    const result = await pre_read(payload);
    expect(result).not.toBeNull();
    expect(result["continue"]).toBe(true);
  });

  it("test_safe_load_called_in_bash_branch", async () => {
    const safe_load_calls: string[] = [];
    const original_safe_load = session.safe_load;
    vi.spyOn(session, "safe_load").mockImplementation((sid: string, ...rest: unknown[]) => {
      safe_load_calls.push(sid);
      return (original_safe_load as (...a: unknown[]) => unknown)(sid, ...rest) as ReturnType<typeof session.safe_load>;
    });

    const payload: HookPayload = {
      session_id: "bash_load_tracking",
      tool_name: "Bash",
      tool_input: { command: "pytest tests/" },
      cwd: "/proj",
    };
    pre_read(payload);
    expect(safe_load_calls).toContain("bash_load_tracking");
  });
});

// ---------------------------------------------------------------------------
// Bash fast-path early exit
// ---------------------------------------------------------------------------

describe("TestBashFastPath", () => {
  it("test_unrecognized_binary_skips_session_load", async () => {
    const calls: string[] = [];
    const orig = session.safe_load;
    vi.spyOn(session, "safe_load").mockImplementation((sid: string, ...rest: unknown[]) => {
      calls.push(sid);
      return (orig as (...a: unknown[]) => unknown)(sid, ...rest) as ReturnType<typeof session.safe_load>;
    });

    for (const cmd of ["chmod +x script.sh", "rm -rf /tmp/junk", "mkdir -p /srv/data"]) {
      const payload: HookPayload = {
        session_id: "fp-1",
        tool_name: "Bash",
        tool_input: { command: cmd },
      };
      const result = await pre_read(payload);
      _assert_continue(result);
      expect("hookSpecificOutput" in result).toBe(false);
    }
    expect(calls).toEqual([]);
  });

  it("test_fast_path_exclude_reaches_handler_chain", async () => {
    const calls: string[] = [];
    const orig = session.safe_load;
    vi.spyOn(session, "safe_load").mockImplementation((sid: string, ...rest: unknown[]) => {
      calls.push(sid);
      return (orig as (...a: unknown[]) => unknown)(sid, ...rest) as ReturnType<typeof session.safe_load>;
    });

    const payload: HookPayload = {
      session_id: "fp-2",
      tool_name: "Bash",
      tool_input: { command: "which node" },
    };
    pre_read(payload);
    expect(calls).toContain("fp-2");
  });

  it("test_compound_command_not_fast_pathed", async () => {
    const calls: string[] = [];
    const orig = session.safe_load;
    vi.spyOn(session, "safe_load").mockImplementation((sid: string, ...rest: unknown[]) => {
      calls.push(sid);
      return (orig as (...a: unknown[]) => unknown)(sid, ...rest) as ReturnType<typeof session.safe_load>;
    });

    const payload: HookPayload = {
      session_id: "fp-3",
      tool_name: "Bash",
      tool_input: {
        command:
          "chmod +x script.sh' && C:/Projects/token-goat/.venv/Scripts/pythonw.exe -m token_goat.cli compress --filter tail-trunc --timeout 600 --profile balanced --max-tokens 8000 --cmd './script.sh",
      },
    };
    const result = await pre_read(payload);
    _assert_continue(result);
    expect(calls).toContain("fp-3");
  });
});
