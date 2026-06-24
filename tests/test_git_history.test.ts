/**
 * Unit tests for token_goat/git_history — 1:1 port of tests/test_git_history.py.
 *
 * Every Python `def test_*` maps to a vitest `it()` with the same name and the
 * same assertion polarity. The Python test classes (TestParseLog, ...) map to
 * describe() blocks.
 *
 * Test-seam mapping (Python → TS):
 *  - sqlite3.connect(":memory:") + _ensure_schema  → new Database(":memory:")
 *    (better-sqlite3) + gitHistory._ensure_schema. The git_history module is
 *    written against the better-sqlite3 Database API, so the in-memory
 *    connections the tests build use the same native API (prepare/exec/run).
 *  - @contextmanager patch("token_goat.db.open_project_readonly", _cm) →
 *    vi.spyOn(db, "openProjectReadonly").mockImplementation((_hash, body) =>
 *    body(conn)). The HOF form is the TS twin of the Python context manager:
 *    both hand the body the in-memory connection.
 *  - patch("token_goat.db.open_project", side_effect=_fake_open) →
 *    vi.spyOn(db, "openProject").mockImplementation((_hash, body) => body(conn))
 *    with a single shared real-file connection, mirroring the Python fixture
 *    that yields the same connection from every open.
 *  - patch("token_goat.paths.project_db_path", return_value=db_path) →
 *    vi.spyOn(paths, "projectDbPath").mockReturnValue(dbPath).
 *  - patch("token_goat.git_history._run_git", _capturing_run_git) →
 *    vi.spyOn(gitHistory, "_run_git") wrapping the original to capture args.
 *  - patch("token_goat.git_history._parse_log", return_value=[bad_commit]) →
 *    vi.spyOn(gitHistory, "_parse_log").mockReturnValue([badCommit]).
 *  - conftest.make_git_repo fixture → makeGitRepo() helper below, driving real
 *    `git` via util.runGit in a tmp dir. Because setup.ts does not yet pin
 *    GIT_* to disable user hooks (that seam is deferred), the repo is created
 *    with core.hooksPath=/dev/null and commits run with that override so a
 *    global lefthook does not fire on each commit.
 *  - time.time() → Date.now() / 1000 inside git_history; tests assert on the
 *    same wall-clock seconds.
 *
 * The per-test tmp data dir + cache clearing is handled by tests/setup.ts.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import Database from "better-sqlite3";
import type { Database as DatabaseType } from "better-sqlite3";

import * as db from "../src/token_goat/db.js";
import * as paths from "../src/token_goat/paths.js";
import { runGit } from "../src/token_goat/util.js";
import * as gitHistory from "../src/token_goat/git_history.js";
import {
  _MAX_COMMIT_AGE_DAYS,
  _REINDEX_STALENESS_SECS,
  _ensure_schema,
  _needs_reindex,
  _parse_log,
  build_hint,
  find_commits_for_file,
  index_project_history,
} from "../src/token_goat/git_history.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Return an in-memory SQLite connection with git history schema applied. */
function _mem_conn(): DatabaseType {
  const conn = new Database(":memory:");
  _ensure_schema(conn);
  return conn;
}

interface SeedCommit {
  commit_short: string;
  summary: string;
  author_ts: number;
  changed_files: string[];
}

/** Insert rows into git_commits. */
function _seed(conn: DatabaseType, commits: SeedCommit[]): void {
  for (const c of commits) {
    conn
      .prepare(
        "INSERT INTO git_commits(commit_short, summary, author_ts, changed_files) " +
          "VALUES (?, ?, ?, ?)",
      )
      .run(
        c.commit_short,
        c.summary,
        c.author_ts,
        JSON.stringify(c.changed_files),
      );
  }
}

/**
 * Patch db.openProjectReadonly to yield the given in-memory connection.
 *
 * The TS twin of the Python @contextmanager _fake_readonly. The mock ignores
 * the hash and routes the body to the shared connection. afterEach's
 * vi.restoreAllMocks() undoes it, so no handle is returned.
 */
function _fake_readonly(conn: DatabaseType): void {
  vi.spyOn(db, "openProjectReadonly").mockImplementation(
    (<T>(_hash: string, body: (c: DatabaseType) => T): T => body(conn)),
  );
}

/**
 * Wraps a better-sqlite3 Database, recording every SQL string passed through
 * exec()/prepare(). The TS twin of the Python _RecordingConn (which recorded
 * conn.execute() SQL). git_history routes BEGIN/COMMIT/ROLLBACK through exec()
 * and every INSERT/SELECT through prepare(), so recording both surfaces every
 * statement the batch loop issues.
 */
function makeRecordingConn(conn: DatabaseType): {
  conn: DatabaseType;
  executed: string[];
} {
  const executed: string[] = [];
  const proxy = new Proxy(conn, {
    get(target, prop, receiver) {
      if (prop === "exec") {
        return (sql: string) => {
          executed.push(sql);
          return target.exec(sql);
        };
      }
      if (prop === "prepare") {
        return (sql: string) => {
          executed.push(sql);
          return target.prepare(sql);
        };
      }
      const value = Reflect.get(target, prop, receiver);
      if (typeof value === "function") {
        return value.bind(target);
      }
      return value;
    },
  });
  return { conn: proxy as DatabaseType, executed };
}

/**
 * Build a minimal git repo under `parent/name` and return its path. Mirrors
 * conftest.make_git_repo (the `commits` form): each (files, message) tuple
 * becomes its own commit.
 *
 * core.hooksPath is pinned to /dev/null so a user/global lefthook does not fire
 * on each commit (the _disable_user_git_hooks seam is deferred in setup.ts).
 */
function makeGitRepo(
  parent: string,
  opts: {
    name?: string;
    user?: string;
    email?: string;
    initBranch?: string;
    commits: Array<[Record<string, string>, string]>;
  },
): string {
  const name = opts.name ?? "repo";
  const user = opts.user ?? "T";
  const email = opts.email ?? "t@t.com";
  const repo = path.join(parent, name);
  fs.mkdirSync(repo);

  const hooksOff = ["-c", "core.hooksPath=/dev/null"];
  const initArgs = ["init"];
  if (opts.initBranch) {
    initArgs.push("-b", opts.initBranch);
  }
  _git([...hooksOff, ...initArgs], repo);
  _git([...hooksOff, "config", "user.email", email], repo);
  _git([...hooksOff, "config", "user.name", user], repo);

  for (const [payload, msg] of opts.commits) {
    for (const [rel, content] of Object.entries(payload)) {
      const fp = path.join(repo, rel);
      fs.mkdirSync(path.dirname(fp), { recursive: true });
      fs.writeFileSync(fp, content);
    }
    _git([...hooksOff, "add", "."], repo);
    _git(
      [...hooksOff, "-c", "commit.gpgsign=false", "commit", "-m", msg],
      repo,
    );
  }
  return repo;
}

/** Run git in `cwd`, throwing on non-zero exit (test-only strict helper). */
function _git(args: string[], cwd: string): void {
  const res = runGit(args, { cwd, timeout: 30 });
  if (res.returncode !== 0) {
    throw new Error(
      `git ${args.join(" ")} failed (${res.returncode}): ${res.stderr}`,
    );
  }
}

/** Create a unique tmp dir for a test (used for the on-disk project DB). */
function makeTmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "tg-githist-"));
}

afterEach(() => {
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// _parse_log
// ---------------------------------------------------------------------------

describe("TestParseLog", () => {
  it("test_single_commit", () => {
    const raw =
      "\x00abc123def456789\x01add auth module\x0115000000\nmy/auth.py\nmy/utils.py\n";
    const commits = _parse_log(raw);
    expect(commits.length).toBe(1);
    const c = commits[0]!;
    expect(c.commit_short).toBe("abc123def456");
    expect(c.summary).toBe("add auth module");
    expect(c.author_ts).toBe(15000000);
    expect(c.changed_files).toEqual(["my/auth.py", "my/utils.py"]);
  });

  it("test_multiple_commits", () => {
    const raw =
      "\x00aaaa\x01first change\x011000\nfile_a.py\n" +
      "\x00bbbb\x01second change\x012000\nfile_b.py\n";
    const commits = _parse_log(raw);
    expect(commits.length).toBe(2);
    expect(commits[0]!.commit_short).toBe("aaaa");
    expect(commits[1]!.commit_short).toBe("bbbb");
  });

  it("test_summary_too_short_skipped", () => {
    // "wip" is 3 chars < _MIN_SUMMARY_LEN=6
    const raw = "\x00aaaa\x01wip\x011000\nfile.py\n";
    const commits = _parse_log(raw);
    expect(commits).toEqual([]);
  });

  it("test_empty_raw", () => {
    expect(_parse_log("")).toEqual([]);
  });

  it("test_only_null_bytes", () => {
    expect(_parse_log("\x00\x00\x00")).toEqual([]);
  });

  it("test_hash_truncated_to_12", () => {
    const raw = "\x00" + "a".repeat(40) + "\x01some long summary here\x011000\nf.py\n";
    const commits = _parse_log(raw);
    expect(commits[0]!.commit_short).toBe("a".repeat(12));
  });

  it("test_changed_files_capped_at_40", () => {
    const files = Array.from({ length: 60 }, (_, i) => `src/f${i}.py`);
    const raw =
      "\x00abc\x01big commit message\x011000\n" + files.join("\n") + "\n";
    const commits = _parse_log(raw);
    expect(commits[0]!.changed_files.length).toBe(40);
  });

  it("test_invalid_timestamp_defaults_zero", () => {
    const raw = "\x00abc\x01valid summary here\x01not-a-number\nfile.py\n";
    const commits = _parse_log(raw);
    expect(commits[0]!.author_ts).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// _needs_reindex
// ---------------------------------------------------------------------------

describe("TestNeedsReindex", () => {
  it("test_fresh_index_not_stale", () => {
    const conn = _mem_conn();
    conn
      .prepare(
        "INSERT INTO git_history_meta(key, value) VALUES ('last_indexed_at', ?)",
      )
      .run(String(Date.now() / 1000));
    expect(_needs_reindex(conn)).toBe(false);
  });

  it("test_stale_index_triggers_reindex", () => {
    const conn = _mem_conn();
    const old_ts = Date.now() / 1000 - _REINDEX_STALENESS_SECS - 1;
    conn
      .prepare(
        "INSERT INTO git_history_meta(key, value) VALUES ('last_indexed_at', ?)",
      )
      .run(String(old_ts));
    expect(_needs_reindex(conn)).toBe(true);
  });

  it("test_missing_meta_entry_triggers_reindex", () => {
    const conn = _mem_conn();
    expect(_needs_reindex(conn)).toBe(true);
  });

  it("test_git_history_meta_table_missing_triggers_reindex", () => {
    // No schema applied — table doesn't exist.
    const conn = new Database(":memory:");
    expect(_needs_reindex(conn)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// find_commits_for_file  (via patched db.openProjectReadonly)
// ---------------------------------------------------------------------------

describe("TestFindCommitsForFile", () => {
  it("test_exact_match_only", () => {
    // json_each must match exactly — no false positives from partial paths.
    const conn = _mem_conn();
    _seed(conn, [
      {
        commit_short: "aaa",
        summary: "exact match",
        author_ts: 3000,
        changed_files: ["src/foo.py"],
      },
      {
        commit_short: "bbb",
        summary: "longer path",
        author_ts: 2000,
        changed_files: ["src/bar/src/foo.py"], // different file, shares suffix
      },
      {
        commit_short: "ccc",
        summary: "backup file",
        author_ts: 1000,
        changed_files: ["src/foo.py.bak"], // extension variant
      },
    ]);
    _fake_readonly(conn);
    const results = find_commits_for_file("fakehash", "src/foo.py");
    expect(results.length).toBe(1);
    expect(results[0]!.commit_short).toBe("aaa");
  });

  it("test_ordered_by_recency", () => {
    const conn = _mem_conn();
    _seed(conn, [
      {
        commit_short: "old",
        summary: "older commit",
        author_ts: 1000,
        changed_files: ["x.py"],
      },
      {
        commit_short: "new",
        summary: "newer commit",
        author_ts: 9000,
        changed_files: ["x.py"],
      },
    ]);
    _fake_readonly(conn);
    const results = find_commits_for_file("fakehash", "x.py", { limit: 10 });
    expect(results[0]!.commit_short).toBe("new");
    expect(results[1]!.commit_short).toBe("old");
  });

  it("test_limit_respected", () => {
    const conn = _mem_conn();
    _seed(
      conn,
      Array.from({ length: 10 }, (_, i) => ({
        commit_short: `c${String(i).padStart(3, "0")}`,
        summary: `commit ${i}`,
        author_ts: i,
        changed_files: ["f.py"],
      })),
    );
    _fake_readonly(conn);
    const results = find_commits_for_file("fakehash", "f.py", { limit: 3 });
    expect(results.length).toBe(3);
  });

  it("test_no_match_returns_empty", () => {
    const conn = _mem_conn();
    _seed(conn, [
      {
        commit_short: "aaa",
        summary: "some commit",
        author_ts: 1000,
        changed_files: ["other.py"],
      },
    ]);
    _fake_readonly(conn);
    const results = find_commits_for_file("fakehash", "missing.py");
    expect(results).toEqual([]);
  });

  it("test_missing_project_db_returns_empty", () => {
    // FileNotFoundError from open_project_readonly must be swallowed. db.ts
    // throws `project db not found: <path>` for the missing-DB case.
    vi.spyOn(db, "openProjectReadonly").mockImplementation(() => {
      throw new Error("project db not found");
    });
    const results = find_commits_for_file("badhash", "any.py");
    expect(results).toEqual([]);
  });

  it("test_result_fields_present", () => {
    const conn = _mem_conn();
    _seed(conn, [
      {
        commit_short: "abc123",
        summary: "fix bug",
        author_ts: 5000,
        changed_files: ["a.py"],
      },
    ]);
    _fake_readonly(conn);
    const results = find_commits_for_file("fakehash", "a.py");
    expect(results.length).toBe(1);
    const r = results[0]!;
    expect(r.commit_short).toBe("abc123");
    expect(r.summary).toBe("fix bug");
    expect(r.author_ts).toBe(5000);
  });
});

// ---------------------------------------------------------------------------
// build_hint
// ---------------------------------------------------------------------------

describe("TestBuildHint", () => {
  it("test_returns_none_when_no_commits", () => {
    const conn = _mem_conn();
    _fake_readonly(conn);
    expect(build_hint("fakehash", "missing.py")).toBe(null);
  });

  it("test_hint_contains_file_path", () => {
    const conn = _mem_conn();
    _seed(conn, [
      {
        commit_short: "deadbeef1234",
        summary: "refactor auth",
        author_ts: 1000,
        changed_files: ["src/auth.py"],
      },
    ]);
    _fake_readonly(conn);
    const hint = build_hint("fakehash", "src/auth.py");
    expect(hint).not.toBe(null);
    expect(hint!).toContain("src/auth.py");
  });

  it("test_hint_contains_short_hash", () => {
    const conn = _mem_conn();
    _seed(conn, [
      {
        commit_short: "deadbeef1234",
        summary: "refactor auth",
        author_ts: 1000,
        changed_files: ["src/auth.py"],
      },
    ]);
    _fake_readonly(conn);
    const hint = build_hint("fakehash", "src/auth.py");
    expect(hint!).toContain("deadbeef");
  });

  it("test_today_label_for_recent_commit", () => {
    const conn = _mem_conn();
    _seed(conn, [
      {
        commit_short: "abc",
        summary: "recent change",
        author_ts: Math.trunc(Date.now() / 1000),
        changed_files: ["f.py"],
      },
    ]);
    _fake_readonly(conn);
    const hint = build_hint("fakehash", "f.py");
    expect(hint!).toContain("today");
  });

  it("test_age_days_shown_for_old_commit", () => {
    const conn = _mem_conn();
    const ts_5d_ago = Math.trunc(Date.now() / 1000) - 5 * 86_400;
    _seed(conn, [
      {
        commit_short: "abc",
        summary: "old change here",
        author_ts: ts_5d_ago,
        changed_files: ["f.py"],
      },
    ]);
    _fake_readonly(conn);
    const hint = build_hint("fakehash", "f.py");
    expect(hint!).toContain("5d");
  });

  it("test_summary_truncated_to_80_chars", () => {
    const long_summary = "x".repeat(120);
    const conn = _mem_conn();
    _seed(conn, [
      {
        commit_short: "abc",
        summary: long_summary,
        author_ts: 1000,
        changed_files: ["f.py"],
      },
    ]);
    _fake_readonly(conn);
    const hint = build_hint("fakehash", "f.py");
    expect(hint).not.toBe(null);
    // The summary line is "  - abcdefgh: <summary> (Nd ago)"
    // It must not contain more than 80 x chars (truncated at 80).
    expect(hint!.includes("x".repeat(81))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// index_project_history  (integration — requires a real temp git repo)
// ---------------------------------------------------------------------------

describe("TestIndexProjectHistory", () => {
  let tmpDir: string;
  let gitRepo: string;

  beforeEach(() => {
    tmpDir = makeTmpDir();
    gitRepo = makeGitRepo(tmpDir, {
      initBranch: "main",
      user: "Test",
      commits: [
        [{ "a.py": "x = 1" }, "add a module"],
        [{ "b.py": "y = 2" }, "add b module"],
      ],
    });
  });

  afterEach(() => {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // best-effort
    }
  });

  it("test_indexes_commits_and_writes_meta", () => {
    // index_project_history stores commits and updates last_indexed_at.
    const dbPath = path.join(tmpDir, "project.db");
    const projHash = "a".repeat(40);

    vi.spyOn(paths, "projectDbPath").mockReturnValue(dbPath);
    const conn = new Database(dbPath);
    vi.spyOn(db, "openProject").mockImplementation(
      (<T>(_hash: string, body: (c: DatabaseType) => T): T => body(conn)),
    );

    const count = index_project_history(gitRepo, projHash);

    expect(count).toBe(2);
    const row = conn
      .prepare(
        "SELECT value FROM git_history_meta WHERE key = 'last_indexed_at'",
      )
      .get() as { value: string } | undefined;
    expect(row).not.toBeUndefined();
    // Timestamp should be recent (within last 10 seconds).
    expect(Math.abs(Date.now() / 1000 - Number(row!.value))).toBeLessThan(10);
    conn.close();
  });

  it("test_skips_reindex_when_fresh", () => {
    // Second call within staleness window returns 0 without running git.
    const dbPath = path.join(tmpDir, "project.db");

    vi.spyOn(paths, "projectDbPath").mockReturnValue(dbPath);
    const conn = new Database(dbPath);
    vi.spyOn(db, "openProject").mockImplementation(
      (<T>(_hash: string, body: (c: DatabaseType) => T): T => body(conn)),
    );

    _ensure_schema(conn);
    // Simulate a recent index.
    conn
      .prepare(
        "INSERT OR REPLACE INTO git_history_meta(key, value) " +
          "VALUES ('last_indexed_at', ?)",
      )
      .run(String(Date.now() / 1000));
    const count = index_project_history(gitRepo, "a".repeat(40));

    expect(count).toBe(0); // skipped — index is fresh
    conn.close();
  });

  it("test_returns_zero_when_db_missing", () => {
    // No project DB → returns 0 without raising.
    const missing = path.join(tmpDir, "nonexistent.db");
    vi.spyOn(paths, "projectDbPath").mockReturnValue(missing);
    const count = index_project_history(tmpDir, "a".repeat(40));
    expect(count).toBe(0);
  });

  it("test_no_merges_flag_present", () => {
    // git log must include --no-merges so merge commits are excluded.
    const dbPath = path.join(tmpDir, "project.db");
    const capturedArgs: string[][] = [];

    // Wrap the original _run_git via a static-import spy so the capturing
    // wrapper still drives the real git command (mirrors the Python
    // original_run_git delegation).
    const originalRunGit = gitHistory._run_git;
    vi.spyOn(gitHistory, "_run_git").mockImplementation(
      (args: string[], cwd: string, timeout?: number) => {
        capturedArgs.push(args);
        return originalRunGit(args, cwd, timeout);
      },
    );

    vi.spyOn(paths, "projectDbPath").mockReturnValue(dbPath);
    const conn = new Database(dbPath);
    vi.spyOn(db, "openProject").mockImplementation(
      (<T>(_hash: string, body: (c: DatabaseType) => T): T => body(conn)),
    );

    index_project_history(gitRepo, "a".repeat(40));

    const allArgs = capturedArgs.flat();
    expect(allArgs).toContain("--no-merges");
    conn.close();
  });

  it("test_git_log_after_uses_string_format", () => {
    // Verify the git log command uses '60 days ago' format, not raw Unix int.
    const dbPath = path.join(tmpDir, "project.db");
    const capturedArgs: string[][] = [];

    const originalRunGit = gitHistory._run_git;
    vi.spyOn(gitHistory, "_run_git").mockImplementation(
      (args: string[], cwd: string, timeout?: number) => {
        capturedArgs.push(args);
        return originalRunGit(args, cwd, timeout);
      },
    );

    vi.spyOn(paths, "projectDbPath").mockReturnValue(dbPath);
    const conn = new Database(dbPath);
    vi.spyOn(db, "openProject").mockImplementation(
      (<T>(_hash: string, body: (c: DatabaseType) => T): T => body(conn)),
    );

    index_project_history(gitRepo, "a".repeat(40));

    // Find the --after flag in captured args.
    const afterFlags = capturedArgs
      .flat()
      .filter((arg) => arg.startsWith("--after="));
    expect(afterFlags.length).toBe(1);
    expect(afterFlags[0]).toBe(`--after=${_MAX_COMMIT_AGE_DAYS} days ago`);
    // Must NOT be a raw integer.
    const afterValue = afterFlags[0]!.split("=").slice(1).join("=");
    expect(/^-*\d+$/.test(afterValue)).toBe(false);
    conn.close();
  });

  it("test_failed_batch_does_not_stamp_last_indexed_at", () => {
    // A batch where every commit insert fails must leave the index stale.
    // An object() author_ts cannot be bound, so every INSERT raises and stored
    // stays 0.
    const dbPath = path.join(tmpDir, "project.db");
    const badCommit = {
      commit_short: "abc123abc123",
      summary: "valid summary here",
      author_ts: {} as unknown, // unbindable — every INSERT raises
      changed_files: ["x.py"],
    };

    vi.spyOn(paths, "projectDbPath").mockReturnValue(dbPath);
    const conn = new Database(dbPath);
    vi.spyOn(db, "openProject").mockImplementation(
      (<T>(_hash: string, body: (c: DatabaseType) => T): T => body(conn)),
    );
    vi.spyOn(gitHistory, "_parse_log").mockReturnValue([badCommit]);

    const count = index_project_history(gitRepo, "a".repeat(40));

    expect(count).toBe(0);
    const row = conn
      .prepare(
        "SELECT value FROM git_history_meta WHERE key = 'last_indexed_at'",
      )
      .get() as { value: string } | undefined;
    expect(row).toBeUndefined();
    const stored = conn
      .prepare("SELECT COUNT(*) AS n FROM git_commits")
      .get() as { n: number };
    expect(stored.n).toBe(0);
    conn.close();
  });

  it("test_batch_inserts_run_in_a_single_transaction", () => {
    // All commit inserts must be wrapped in exactly one BEGIN/COMMIT.
    const dbPath = path.join(tmpDir, "project.db");

    vi.spyOn(paths, "projectDbPath").mockReturnValue(dbPath);
    const rec = makeRecordingConn(new Database(dbPath));
    vi.spyOn(db, "openProject").mockImplementation(
      (<T>(_hash: string, body: (c: DatabaseType) => T): T => body(rec.conn)),
    );

    const count = index_project_history(gitRepo, "a".repeat(40));

    expect(count).toBe(2);
    expect(rec.executed.filter((s) => s === "BEGIN").length).toBe(1);
    expect(rec.executed).toContain("COMMIT");
    rec.conn.close();
  });

  it("test_duplicate_commits_return_zero_stored_but_stamp_meta", () => {
    // Re-indexing an already-indexed project: stored == 0, last_indexed_at
    // still stamped.
    const dbPath = path.join(tmpDir, "project.db");
    const projHash = "a".repeat(40);

    vi.spyOn(paths, "projectDbPath").mockReturnValue(dbPath);
    const conn = new Database(dbPath);
    const openSpy = vi
      .spyOn(db, "openProject")
      .mockImplementation(
        (<T>(_hash: string, body: (c: DatabaseType) => T): T => body(conn)),
      );

    // First run: indexes 2 commits and stamps last_indexed_at.
    const count1 = index_project_history(gitRepo, projHash);
    expect(count1).toBe(2);

    // Reset the staleness guard so the second run actually re-indexes.
    conn
      .prepare(
        "INSERT OR REPLACE INTO git_history_meta(key, value) VALUES ('last_indexed_at', ?)",
      )
      .run(String(Date.now() / 1000 - _REINDEX_STALENESS_SECS - 1));

    // Second run: all commits already present — stored must be 0.
    void openSpy;
    const count2 = index_project_history(gitRepo, projHash);

    expect(count2).toBe(0);
    // last_indexed_at must still be refreshed so the staleness guard works.
    const row = conn
      .prepare(
        "SELECT value FROM git_history_meta WHERE key = 'last_indexed_at'",
      )
      .get() as { value: string } | undefined;
    expect(row).not.toBeUndefined();
    expect(Math.abs(Date.now() / 1000 - Number(row!.value))).toBeLessThan(10);
    conn.close();
  });
});
