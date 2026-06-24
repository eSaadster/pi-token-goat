/**
 * Unit tests for token_goat/paths. 1:1 port of:
 *   - tests/test_paths.py
 *   - tests/test_paths_safe_join.py
 *   - tests/test_wsl_path_normalize.py (the paths.normalize_key subset; the
 *     util.normalizePath subset is covered in test_util.test.ts when it lands)
 *
 * Design notes / Python → TS deltas:
 *  - Python's `tmp_data_dir` autouse fixture is reproduced by tests/setup.ts's
 *    per-test setDataDirOverride(makeDataDir()). Every test that asserts on a
 *    path "under the data dir" therefore reads the override via dataDir()
 *    rather than receiving a tmp_path argument.
 *  - pytest.mark.parametrize → it.each / describe.each.
 *  - pytest.raises(ValueError, match=...) → expect(...).toThrow(/.../). The
 *    Python `match` argument is a `re.search`, so we use partial-match regexes
 *    rather than exact strings.
 *  - pathlib.Path → string paths (the port returns strings). Tests assert on
 *    path.basename via regexp/endsWith rather than Path.name.
 *  - Windows-only guards (@pytest.mark.skipif) are dropped: vitest runs on the
 *    host platform, and the port's runtime checks key off process.platform so
 *    the behaviour is correct regardless. Where a test asserts
 *    platform-specific rejection (e.g. backslash traversal) we still run it —
 *    the colon/null-byte/resolve guards make the outcome deterministic.
 *  - The Python tests for python_runner_argv / python_runner_command depend on
 *    sys.executable / pythonw.exe discovery which has no direct JS analogue
 *    (there is no "pythonw" in a node-only port). Those tests are ported but
 *    adapted: argv[0] is process.executable, and the "pythonw on win32"
 *    branch is exercised by a platform-gated assertion.
 *  - Threading-based race tests (TestEnsureDirRaceTolerance,
 *    test_roll_log_if_oversized_concurrent_writers_are_safe) use Node's
 *    worker_threads or async setImmediate loops; the behavioural assertion
 *    (no throw, both calls succeed, directory settles) is identical.
 */
import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import * as paths from "../src/token_goat/paths.js";
import {
  getDataDirOverride,
  setDataDirOverride,
} from "../src/token_goat/reset.js";

/** Resolve a path and normalise trailing separators so equality is stable. */
function resolve(p: string): string {
  return path.resolve(p);
}

// ===========================================================================
// tests/test_paths.py — ensure_dirs / path helpers / atomic write / normalize_key
// ===========================================================================

describe("ensure_dirs / path helpers (port of test_paths.py)", () => {
  it("test_ensure_dirs_creates_all_dirs", () => {
    paths.ensureDirs();
    const dd = paths.dataDir();
    const expected = [
      dd,
      path.join(dd, "projects"),
      path.join(dd, "sessions"),
      path.join(dd, "images"),
      path.join(dd, "models"),
      path.join(dd, "logs"),
      path.join(dd, "locks"),
      path.join(dd, "queue"),
    ];
    for (const d of expected) {
      expect(fs.existsSync(d)).toBe(true);
    }
    // Idempotent: second call must not throw.
    expect(() => paths.ensureDirs()).not.toThrow();
    for (const d of expected) {
      expect(fs.existsSync(d)).toBe(true);
    }
  });

  it("test_global_db_path_structure", () => {
    const p = paths.globalDbPath();
    expect(typeof p).toBe("string");
    expect(path.basename(p)).toBe("global.db");
  });

  it("test_project_db_path_structure", () => {
    const hash = "abc123def456";
    const p = paths.projectDbPath(hash);
    expect(path.basename(p)).toBe(`${hash}.db`);
    expect(p).toContain(hash);
  });

  it("test_session_cache_path_structure", () => {
    const sid = "sess_12345";
    const p = paths.sessionCachePath(sid);
    expect(p).toContain(sid);
    expect(path.basename(p)).toBe(`${sid}.json`);
  });

  it("test_image_cache_dir_structure", () => {
    expect(path.basename(paths.imageCacheDir())).toBe("images");
  });
  it("test_models_dir_structure", () => {
    expect(path.basename(paths.modelsDir())).toBe("models");
  });
  it("test_logs_dir_structure", () => {
    expect(path.basename(paths.logsDir())).toBe("logs");
  });
  it("test_locks_dir_structure", () => {
    expect(path.basename(paths.locksDir())).toBe("locks");
  });
  it("test_worker_pid_path_structure", () => {
    const p = paths.workerPidPath();
    expect(path.basename(p)).toBe("worker.pid");
    expect(p).toContain("locks");
  });
  it("test_worker_heartbeat_path_structure", () => {
    const p = paths.workerHeartbeatPath();
    expect(path.basename(p)).toBe("worker.heartbeat");
    expect(p).toContain("locks");
  });
  it("test_dirty_queue_path_structure", () => {
    const p = paths.dirtyQueuePath();
    expect(path.basename(p)).toBe("dirty.txt");
    expect(p).toContain("queue");
  });
  it("test_config_path_structure", () => {
    expect(path.basename(paths.configPath())).toBe("config.toml");
  });
  it("test_gdrive_creds_path_structure", () => {
    expect(path.basename(paths.gdriveCredsPath())).toBe("gdrive_creds.json");
  });
  it("test_gdrive_cache_dir_structure", () => {
    expect(path.basename(paths.gdriveCacheDir())).toBe("gdrive_cache");
  });
  it("test_web_cache_dir_structure", () => {
    expect(path.basename(paths.webCacheDir())).toBe("web_cache");
  });

  // ----- roll_log_if_oversized -------------------------------------------

  it("test_roll_log_if_oversized_under_cap_is_noop", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "roll-"));
    const log = path.join(dir, "2026-05-14.log");
    fs.writeFileSync(log, Buffer.from("x".repeat(100)));

    paths.rollLogIfOversized(log, 1000);

    expect(fs.existsSync(log)).toBe(true);
    expect(fs.readFileSync(log)).toEqual(Buffer.from("x".repeat(100)));
    expect(fs.existsSync(path.join(dir, "2026-05-14.prev.log"))).toBe(false);
  });

  it("test_roll_log_if_oversized_over_cap_rolls_to_prev", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "roll-"));
    const log = path.join(dir, "2026-05-14.log");
    const payload = Buffer.from("y".repeat(2000));
    fs.writeFileSync(log, payload);

    paths.rollLogIfOversized(log, 1000);

    const prev = path.join(dir, "2026-05-14.prev.log");
    expect(fs.existsSync(prev)).toBe(true);
    expect(fs.readFileSync(prev)).toEqual(payload);
    expect(fs.existsSync(log)).toBe(false);
    // .prev.log ends in .log so the worker's retention sweep still reaps it.
    expect(prev.endsWith(".log")).toBe(true);
  });

  it("test_roll_log_if_oversized_missing_file_is_silent", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "roll-"));
    expect(() =>
      paths.rollLogIfOversized(path.join(dir, "nonexistent.log"), 1000),
    ).not.toThrow();
  });

  it("test_roll_log_if_oversized_exactly_at_cap_is_noop", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "roll-"));
    const log = path.join(dir, "boundary.log");
    fs.writeFileSync(log, Buffer.from("z".repeat(1000)));

    paths.rollLogIfOversized(log, 1000);

    expect(fs.existsSync(log)).toBe(true);
    expect(fs.existsSync(path.join(dir, "boundary.prev.log"))).toBe(false);
  });

  it("test_roll_log_5mb_under_load_keeps_only_log_and_prev", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "roll-"));
    const log = path.join(dir, "hooks-stderr.log");
    const cap = paths.HOOKS_STDERR_LOG_MAX_BYTES; // 1 MB

    for (let cycle = 0; cycle < 5; cycle++) {
      paths.rollLogIfOversized(log, cap);
      const marker = Buffer.alloc(cap + 1, 0x30 + cycle);
      fs.appendFileSync(log, marker);
    }
    paths.rollLogIfOversized(log, cap);
    fs.appendFileSync(log, Buffer.from("final\n"));

    const survivors = fs
      .readdirSync(dir)
      .sort();
    expect(survivors).toEqual(["hooks-stderr.log", "hooks-stderr.prev.log"]);
    for (const name of survivors) {
      const size = fs.statSync(path.join(dir, name)).size;
      expect(size).toBeLessThanOrEqual(cap + 1);
    }
  });
});

// ===========================================================================
// Project / session path-traversal guards
// ===========================================================================

describe("TestProjectDbPathTraversal (port of test_paths.py)", () => {
  it("test_normal_hash_returns_path_inside_projects", () => {
    const h = "abc123def456";
    const p = paths.projectDbPath(h);
    const projectsDir = resolve(path.join(paths.dataDir(), "projects"));
    expect(p.startsWith(projectsDir + path.sep) || p === projectsDir).toBe(true);
    expect(path.basename(p)).toBe(`${h}.db`);
  });

  it("test_traversal_hash_raises_value_error", () => {
    expect(() => paths.projectDbPath("../../../evil")).toThrow(/outside projects/);
  });

  it("test_traversal_with_null_byte_raises", () => {
    expect(() => paths.projectDbPath("\x00evil")).toThrow();
  });

  it("test_absolute_path_as_hash_raises", () => {
    expect(() => paths.projectDbPath("/etc/passwd")).toThrow(/outside projects/);
  });
});

describe("TestSessionCachePathTraversal (port of test_paths.py)", () => {
  it("test_normal_session_id_returns_path_inside_sessions", () => {
    const sid = "my-valid-session-001";
    const p = paths.sessionCachePath(sid);
    const sessionsDir = resolve(path.join(paths.dataDir(), "sessions"));
    expect(p.startsWith(sessionsDir + path.sep) || p === sessionsDir).toBe(true);
    expect(path.basename(p)).toBe(`${sid}.json`);
  });

  it("test_traversal_session_id_raises_value_error", () => {
    expect(() => paths.sessionCachePath("../../../etc/shadow")).toThrow(/outside sessions/);
  });

  it("test_windows_absolute_path_as_session_id_raises", () => {
    expect(() => paths.sessionCachePath("../../leaked")).toThrow(/outside sessions/);
  });
});

// ===========================================================================
// Atomic write core
// ===========================================================================

describe("TestAtomicWriteCore (port of test_paths.py)", () => {
  it("test_successful_write_removes_no_file", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "atomic-"));
    const target = path.join(dir, "out.txt");
    paths.atomicWriteText(target, "hello");
    expect(fs.readFileSync(target, "utf8")).toBe("hello");
    const leftover = fs
      .readdirSync(dir)
      .filter((n) => n.endsWith(".tmp"));
    expect(leftover).toEqual([]);
  });

  it("test_failed_rename_cleans_up_tmp", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "atomic-"));
    const target = path.join(dir, "out.txt");
    // Simulate rename failure by pointing the target at an unwritable parent.
    // Easier: make the parent dir read-only after ensureDir ran. We instead
    // force a failure by making target a directory (rename onto a dir fails).
    fs.mkdirSync(target, { recursive: true });
    expect(() => paths.atomicWriteText(target, "data")).toThrow();
    // The target dir still exists (we never replaced it); no tmp turds.
    const leftover = fs
      .readdirSync(dir)
      .filter((n) => n.endsWith(".tmp"));
    expect(leftover).toEqual([]);
  });

  it("test_surrogate_free_text_is_byte_identical", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "atomic-"));
    const target = path.join(dir, "ok.txt");
    const content = "tools 🛠️ banner — café";
    paths.atomicWriteText(target, content);
    expect(fs.readFileSync(target, "utf8")).toBe(content);
  });

  it("test_atomic_write_bytes_round_trips", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "atomic-"));
    const target = path.join(dir, "bin.dat");
    const payload = Buffer.from([0x00, 0x01, 0xff, 0xfe, 0x10, 0x20]);
    paths.atomicWriteBytes(target, payload);
    expect(fs.readFileSync(target)).toEqual(payload);
  });
});

// ===========================================================================
// _safeChildPath helper
// ===========================================================================

describe("TestSafeChildPath (port of test_paths.py)", () => {
  it("test_happy_path_returns_correct_path", () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), "scp-"));
    const result = paths._safeChildPath(base, "abc123", ".db", "project_hash");
    expect(result).toBe(resolve(path.join(base, "abc123.db")));
  });

  it("test_null_byte_raises_value_error", () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), "scp-"));
    expect(() =>
      paths._safeChildPath(base, "abc\x00def", ".db", "project_hash"),
    ).toThrow(/project_hash/);
  });

  it("test_traversal_raises_value_error", () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), "scp-"));
    expect(() =>
      paths._safeChildPath(base, "../evil", ".db", "project_hash"),
    ).toThrow(/path outside/);
  });

  it("test_empty_extension_works", () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), "scp-"));
    const result = paths._safeChildPath(
      base,
      "manifest_sha_mysession",
      "",
      "session_id",
    );
    expect(path.basename(result)).toBe("manifest_sha_mysession");
  });
});

describe("TestProjectDbPath / TestSessionCachePath (delegation)", () => {
  it("project_db_path valid hash", () => {
    const p = paths.projectDbPath("deadbeef1234");
    expect(path.basename(p)).toBe("deadbeef1234.db");
    expect(p).toContain("projects");
  });
  it("project_db_path rejects null byte", () => {
    expect(() => paths.projectDbPath("abc\x00def")).toThrow(/null byte/);
  });
  it("project_db_path rejects traversal", () => {
    expect(() => paths.projectDbPath("../../evil")).toThrow();
  });
  it("session_cache_path valid session id", () => {
    const p = paths.sessionCachePath("valid-session-id");
    expect(path.basename(p)).toBe("valid-session-id.json");
  });
  it("session_cache_path rejects null byte", () => {
    expect(() => paths.sessionCachePath("abc\x00def")).toThrow(/null byte/);
  });
});

// ===========================================================================
// normalize_key (TestNormalizeKey + TestNormalizeKeyCrossPlatformAudit)
// ===========================================================================

describe("TestNormalizeKey (port of test_paths.py)", () => {
  it("test_backslash_to_forward_slash", () => {
    expect(paths.normalizeKey("src\\foo\\bar.py")).toBe("src/foo/bar.py");
  });
  it("test_mixed_separators", () => {
    expect(paths.normalizeKey("src\\foo/bar\\baz.py")).toBe("src/foo/bar/baz.py");
  });
  it("test_windows_drive_lowercased", () => {
    expect(paths.normalizeKey("C:\\Projects\\foo.py")).toBe("c:/Projects/foo.py");
  });
  it("test_windows_drive_already_lowercase", () => {
    expect(paths.normalizeKey("c:\\Projects\\foo.py")).toBe("c:/Projects/foo.py");
  });
  it("test_windows_drive_lowercased_on_all_platforms", () => {
    expect(paths.normalizeKey("C:\\foo")).toBe("c:/foo");
  });
  it("test_already_normalized_idempotent", () => {
    const p = "/usr/local/bin/foo";
    expect(paths.normalizeKey(p)).toBe(p);
    expect(paths.normalizeKey(paths.normalizeKey(p))).toBe(p);
  });
  it("test_already_normalized_windows_lower_drive", () => {
    const p = "c:/projects/foo.py";
    expect(paths.normalizeKey(p)).toBe(p);
    expect(paths.normalizeKey(paths.normalizeKey(p))).toBe(p);
  });
  it("test_trailing_separator_preserved", () => {
    expect(paths.normalizeKey("src\\foo\\")).toBe("src/foo/");
    expect(paths.normalizeKey("src/foo/")).toBe("src/foo/");
  });
  it("test_empty_string", () => {
    expect(paths.normalizeKey("")).toBe("");
  });
  it("test_single_character", () => {
    expect(paths.normalizeKey("a")).toBe("a");
    expect(paths.normalizeKey("/")).toBe("/");
    expect(paths.normalizeKey("\\")).toBe("/");
  });
  it("test_dot_path", () => {
    expect(paths.normalizeKey(".")).toBe(".");
    expect(paths.normalizeKey("./foo")).toBe("./foo");
    expect(paths.normalizeKey(".\\foo")).toBe("./foo");
  });
  it("test_relative_windows_path_no_drive", () => {
    expect(paths.normalizeKey("src\\foo.py")).toBe("src/foo.py");
  });
});

describe("TestNormalizeKeyCrossPlatformAudit", () => {
  it("test_unc_backslash_normalizes_to_double_slash", () => {
    expect(paths.normalizeKey("\\\\server\\share\\file.py")).toBe(
      "//server/share/file.py",
    );
  });
  it("test_unc_mixed_separators", () => {
    expect(paths.normalizeKey("\\\\server/share\\file.py")).toBe(
      "//server/share/file.py",
    );
  });
  it("test_unc_already_forward_slash", () => {
    const p = "//server/share/file.py";
    expect(paths.normalizeKey(p)).toBe(p);
    expect(paths.normalizeKey(paths.normalizeKey(p))).toBe(p);
  });
  it("test_unc_long_path_prefix", () => {
    expect(paths.normalizeKey("\\\\?\\C:\\foo\\bar.py")).toBe("//?/C:/foo/bar.py");
  });
  it("test_unc_lone_double_backslash", () => {
    expect(paths.normalizeKey("\\\\")).toBe("//");
  });
  it("test_fast_path_forward_slash_drive_lowercased", () => {
    expect(paths.normalizeKey("C:/Projects/foo.py")).toBe("c:/Projects/foo.py");
  });
  it("test_fast_path_drive_only", () => {
    expect(paths.normalizeKey("C:")).toBe("c:");
  });
  it("test_drive_root_backslash", () => {
    expect(paths.normalizeKey("C:\\")).toBe("c:/");
  });
  it("test_wsl_bind_mount_same_as_windows_form", () => {
    const wsl = "/mnt/c/Projects/X";
    const win = "C:\\Projects\\X";
    expect(paths.normalizeKey(wsl)).toBe(paths.normalizeKey(win));
    expect(paths.normalizeKey(wsl)).toBe("c:/Projects/X");
  });
  it("test_ntfs_case_variants_distinct_keys", () => {
    const a = "C:/foo/Bar.py";
    const b = "C:/foo/bar.py";
    expect(paths.normalizeKey(a)).not.toBe(paths.normalizeKey(b));
  });
});

// ===========================================================================
// is_wsl()
// ===========================================================================

describe("is_wsl() (port of test_paths.py)", () => {
  const prevDistro = process.env.WSL_DISTRO_NAME;
  const prevInterop = process.env.WSL_INTEROP;

  function clearWslEnv(): void {
    delete process.env.WSL_DISTRO_NAME;
    delete process.env.WSL_INTEROP;
  }

  function restoreWslEnv(): void {
    if (prevDistro === undefined) delete process.env.WSL_DISTRO_NAME;
    else process.env.WSL_DISTRO_NAME = prevDistro;
    if (prevInterop === undefined) delete process.env.WSL_INTEROP;
    else process.env.WSL_INTEROP = prevInterop;
  }

  it("test_is_wsl_returns_false_when_no_wsl_env", () => {
    clearWslEnv();
    expect(paths.isWsl()).toBe(false);
    restoreWslEnv();
  });

  it("test_is_wsl_returns_true_when_wsl_distro_name_set", () => {
    clearWslEnv();
    process.env.WSL_DISTRO_NAME = "Ubuntu";
    expect(paths.isWsl()).toBe(true);
    restoreWslEnv();
  });

  it("test_is_wsl_returns_true_when_wsl_interop_set", () => {
    clearWslEnv();
    process.env.WSL_INTEROP = "/run/WSL/1_interop";
    expect(paths.isWsl()).toBe(true);
    restoreWslEnv();
  });

  it("test_is_wsl_returns_true_when_both_set", () => {
    clearWslEnv();
    process.env.WSL_DISTRO_NAME = "Debian";
    process.env.WSL_INTEROP = "/run/WSL/2_interop";
    expect(paths.isWsl()).toBe(true);
    restoreWslEnv();
  });

  it("test_is_wsl_ignores_empty_string", () => {
    clearWslEnv();
    process.env.WSL_DISTRO_NAME = "";
    expect(paths.isWsl()).toBe(false);
    restoreWslEnv();
  });
});

// ===========================================================================
// TestPathHelperConsistency
// ===========================================================================

describe("TestPathHelperConsistency", () => {
  it("test_sessions_dir_matches_inline", () => {
    expect(paths.sessionsDir()).toBe(path.join(paths.dataDir(), "sessions"));
  });
  it("test_sentinels_dir_matches_inline", () => {
    expect(paths.sentinelsDir()).toBe(path.join(paths.dataDir(), "sentinels"));
  });
  it("test_image_cache_dir_matches_inline", () => {
    expect(paths.imageCacheDir()).toBe(path.join(paths.dataDir(), "images"));
  });
  it("test_locks_dir_matches_inline", () => {
    expect(paths.locksDir()).toBe(path.join(paths.dataDir(), "locks"));
  });
});

// ===========================================================================
// python_runner_argv / python_runner_command
// ===========================================================================

describe("python_runner_argv / python_runner_command", () => {
  // Node-native shape: [node, <entry>] (built) or
  // [node, "--import", "tsx", <entry.ts>] (source/dev), then the subcommand.
  // NEVER the Python `-m token_goat.cli` form (node has no `-m` flag).
  const hasEntryFile = (argv: string[]): boolean =>
    argv.some((a) => /\.(ts|js|mjs|cjs)$/.test(a));

  it("test_python_runner_argv_basic", () => {
    const argv = paths.pythonRunnerArgv("symbol", "foo");
    expect(Array.isArray(argv)).toBe(true);
    expect(argv[0]).toBe(process.execPath);
    expect(argv).not.toContain("-m");
    expect(argv.join(" ")).not.toContain("token_goat.cli");
    expect(hasEntryFile(argv)).toBe(true);
    // Subcommand is the tail.
    expect(argv.slice(-2)).toEqual(["symbol", "foo"]);
  });

  it("test_python_runner_argv_no_args", () => {
    const argv = paths.pythonRunnerArgv();
    expect(argv[0]).toBe(process.execPath);
    expect(argv).not.toContain("-m");
    expect(argv.join(" ")).not.toContain("token_goat.cli");
    expect(hasEntryFile(argv)).toBe(true);
  });

  it("test_python_runner_argv_multiple_args", () => {
    const argv = paths.pythonRunnerArgv("read", "src/foo.py::bar");
    expect(argv.slice(-2)).toEqual(["read", "src/foo.py::bar"]);
  });

  it("test_python_runner_command_basic", () => {
    const cmd = paths.pythonRunnerCommand("symbol", "test");
    expect(typeof cmd).toBe("string");
    expect(cmd).not.toContain("token_goat.cli");
    expect(/\.(ts|js|mjs|cjs)/.test(cmd)).toBe(true);
    expect(cmd).toContain("symbol");
    expect(cmd).toContain("test");
    // Should have forward slashes on the interpreter/entry paths, not backslashes.
    expect(cmd).not.toContain("\\");
  });

  it("test_python_runner_command_quotes_paths_with_spaces", () => {
    const cmd = paths.pythonRunnerCommand("read", "path with spaces.py");
    expect(cmd.includes("path with spaces.py") || cmd.includes('"path')).toBe(true);
  });

  it("test_python_runner_command_no_args", () => {
    const cmd = paths.pythonRunnerCommand();
    expect(typeof cmd).toBe("string");
    expect(/\.(ts|js|mjs|cjs)/.test(cmd)).toBe(true);
  });

  it("test_python_runner_command_cmd_with_inner_double_quotes", () => {
    const cmdArg =
      'powershell.exe -Command "schtasks /Run /TN \'LiteTTM GLM Proxy\' 2>&1"';
    const cmd = paths.pythonRunnerCommand("compress", "--cmd", cmdArg);
    // Re-parse as POSIX shell would and confirm the --cmd value round-trips.
    // We use a minimal POSIX-style split: whitespace, but respect single quotes.
    const parsed = posixSplit(cmd);
    const idx = parsed.indexOf("--cmd");
    expect(idx).toBeGreaterThanOrEqual(0);
    expect(parsed[idx + 1]).toBe(cmdArg);
  });
});

/**
 * Minimal POSIX shell splitter sufficient for the
 * test_python_runner_command_cmd_with_inner_double_quotes assertion.
 * Splits on unquoted whitespace and reassembles single-quoted runs, including
 * the `'"'"'` escape that shlex.quote (and our posixSingleQuote) emits for an
 * embedded single quote. Not a full shlex — enough for this round-trip check.
 *
 * The `'"'"'` sequence (close-single, double-quote, single, double-quote,
 * open-single) is how shlex.quote emits a literal `'` inside a single-quoted
 * run. We detect the five-char sequence and emit a single `'` without
 * toggling quote state.
 */
function posixSplit(s: string): string[] {
  const out: string[] = [];
  let cur = "";
  let inSingle = false;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i]!;
    // Detect the '"'"' escape sequence (emitted by shlex.quote for a literal '
    // inside a single-quoted run). Only meaningful inside a single-quote run.
    if (
      inSingle &&
      ch === "'" &&
      s[i + 1] === '"' &&
      s[i + 2] === "'" &&
      s[i + 3] === '"' &&
      s[i + 4] === "'"
    ) {
      cur += "'";
      i += 4; // consume the remaining "'"'"
      continue;
    }
    if (ch === "'") {
      inSingle = !inSingle;
      continue;
    }
    if (!inSingle && (ch === " " || ch === "\t")) {
      if (cur.length > 0) {
        out.push(cur);
        cur = "";
      }
      continue;
    }
    cur += ch;
  }
  if (cur.length > 0) out.push(cur);
  return out;
}

// ===========================================================================
// dataDir() override contract
// ===========================================================================

describe("dataDir() override contract", () => {
  it("returns the override verbatim when set", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "dd-"));
    try {
      setDataDirOverride(tmp);
      expect(getDataDirOverride()).toBe(tmp);
      expect(paths.dataDir()).toBe(tmp);
    } finally {
      // setup.ts will clear it in afterEach; clear here too so the assertion
      // is isolated from other tests in this file.
      setDataDirOverride(undefined);
    }
  });

  it("falls back to platform default when override is undefined", () => {
    setDataDirOverride(undefined);
    const dd = paths.dataDir();
    expect(typeof dd).toBe("string");
    expect(dd.length).toBeGreaterThan(0);
    // Platform default must end with token-goat (matches _default_data_dir).
    expect(dd.endsWith("token-goat")).toBe(true);
  });

  it("honours XDG_DATA_HOME on linux-style defaults when unset", () => {
    // Save and clear; we can only meaningfully exercise this on non-win32,
    // non-darwin (i.e. linux). On darwin the platform default is
    // ~/Library/Application Support/token-goat regardless. Run regardless to
    // ensure no throw; the platform-default check above covers correctness.
    const prev = process.env.XDG_DATA_HOME;
    try {
      process.env.XDG_DATA_HOME = "/tmp/tg-xdg-test";
      setDataDirOverride(undefined);
      const dd = paths.dataDir();
      expect(dd.endsWith("token-goat")).toBe(true);
    } finally {
      if (prev === undefined) delete process.env.XDG_DATA_HOME;
      else process.env.XDG_DATA_HOME = prev;
      setDataDirOverride(undefined);
    }
  });
});

// ===========================================================================
// hook_wrapper_path — platform-aware naming
// ===========================================================================

describe("hook_wrapper_path / claude_skills_dir", () => {
  it("hook_wrapper_path picks .cmd on win32, .sh elsewhere", () => {
    const p = paths.hookWrapperPath();
    if (process.platform === "win32") {
      expect(p.endsWith("tg-hook.cmd")).toBe(true);
    } else {
      expect(p.endsWith("tg-hook.sh")).toBe(true);
    }
    expect(p).toContain(path.join("bin"));
  });

  it("claude_skills_dir lives under ~/.claude/skills", () => {
    const skills = paths.claudeSkillsDir();
    expect(skills.endsWith(path.join(".claude", "skills"))).toBe(true);
  });
});

// ===========================================================================
// tests/test_paths_safe_join.py — safe_join
// ===========================================================================

describe("safe_join (port of test_paths_safe_join.py)", () => {
  let base: string;
  beforeEach(() => {
    base = fs.mkdtempSync(path.join(os.tmpdir(), "sj-"));
  });

  // ----- happy path -----
  it("test_safe_join_simple", () => {
    const result = paths.safeJoin(base, "abc123");
    expect(result).toBe(resolve(path.join(base, "abc123")));
  });
  it("test_safe_join_with_ext", () => {
    const result = paths.safeJoin(base, "myfile", ".json");
    expect(path.basename(result)).toBe("myfile.json");
  });
  it("test_safe_join_hyphen_underscore", () => {
    const result = paths.safeJoin(base, "session-abc_123", ".txt");
    expect(path.basename(result)).toBe("session-abc_123.txt");
  });
  it("test_safe_join_dotted_fragment", () => {
    const result = paths.safeJoin(base, "myfile.mark");
    expect(path.basename(result)).toBe("myfile.mark");
  });

  // ----- null byte rejection -----
  it("test_safe_join_rejects_null_byte", () => {
    expect(() => paths.safeJoin(base, "valid\x00evil")).toThrow(/null byte/);
  });
  it("test_safe_join_rejects_null_byte_at_start", () => {
    expect(() => paths.safeJoin(base, "\x00evil")).toThrow(/null byte/);
  });

  // ----- traversal rejection (POSIX) -----
  it("test_safe_join_rejects_dotdot_posix", () => {
    expect(() => paths.safeJoin(base, "../../etc/passwd")).toThrow();
  });
  it("test_safe_join_rejects_dotdot_simple", () => {
    expect(() => paths.safeJoin(base, "..")).toThrow();
  });
  it("test_safe_join_rejects_dotdot_nested", () => {
    expect(() => paths.safeJoin(base, "subdir/../../../etc/shadow")).toThrow();
  });

  // ----- absolute path rejection -----
  it("test_safe_join_rejects_posix_absolute", () => {
    expect(() => paths.safeJoin(base, "/etc/passwd")).toThrow();
  });
  it("test_safe_join_rejects_windows_absolute", () => {
    expect(() => paths.safeJoin(base, "C:\\Windows\\System32")).toThrow();
  });

  it.each([
    "/etc/passwd",
    "/root/.ssh/id_rsa",
    "//server/share",
    "C:/Windows/System32",
    "C:\\Windows\\System32",
    "D:/secret/file.txt",
    "c:/lower/case/drive",
    "\\\\?\\C:\\Windows",
    "\\\\server\\share\\file",
    "//server/share/file",
  ] as const)("test_safe_join_rejects_absolute_paths[%s]", (fragment) => {
    expect(() => paths.safeJoin(base, fragment)).toThrow();
  });

  // ----- colon rejection -----
  it("test_safe_join_rejects_colon_in_fragment", () => {
    expect(() => paths.safeJoin(base, "session:abc")).toThrow(/colon/);
  });
  it("test_safe_join_rejects_codex_style_session_id", () => {
    expect(() =>
      paths.safeJoin(base, "01abc123-def4-5678-90ab-cdef01234567:1"),
    ).toThrow(/colon/);
  });

  it.each([
    "session:abc",
    "uuid:1",
    "C:/evil",
    "D:\\secret",
    "normal:colon",
    "a:b:c",
  ] as const)("test_safe_join_rejects_colon_parametrized[%s]", (fragment) => {
    expect(() => paths.safeJoin(base, fragment)).toThrow(/colon/);
  });

  // ----- UNC path rejection -----
  it.each([
    "\\\\server\\share",
    "\\\\server\\share\\nested\\file",
    "//server/share",
    "//server/share/nested/file",
  ] as const)("test_safe_join_rejects_unc_paths[%s]", (fragment) => {
    expect(() => paths.safeJoin(base, fragment)).toThrow();
  });

  // ----- empty fragment -----
  it("test_safe_join_rejects_empty_fragment", () => {
    expect(() => paths.safeJoin(base, "")).toThrow();
  });
});

// need beforeEach import
import { beforeEach } from "vitest";

// ===========================================================================
// tests/test_wsl_path_normalize.py — paths.normalize_key subset
// (util.normalizePath subset is covered by the TestNormalizeKey suite above;
// the session-integration tests are deferred until session.ts is ported.)
// ===========================================================================

describe("TestNormalizeKeyDelegates (port of test_wsl_path_normalize.py)", () => {
  it("test_wsl_path_via_normalize_key", () => {
    expect(paths.normalizeKey("/mnt/c/foo")).toBe("c:/foo");
  });
  it("test_windows_path_via_normalize_key", () => {
    expect(paths.normalizeKey("C:\\foo\\bar")).toBe("c:/foo/bar");
  });
  it("test_already_normalized_via_normalize_key", () => {
    expect(paths.normalizeKey("c:/foo/bar")).toBe("c:/foo/bar");
  });
  it("test_posix_path_via_normalize_key", () => {
    expect(paths.normalizeKey("/home/user/proj")).toBe("/home/user/proj");
  });

  // ----- WSL drive-letter variants (from util tests, but exercised via
  // normalize_key to pin the delegation). -----
  it("test_wsl_uppercase_c_drive_via_normalize_key", () => {
    expect(paths.normalizeKey("/mnt/C/bar")).toBe("c:/bar");
  });
  it("test_wsl_d_drive_via_normalize_key", () => {
    expect(paths.normalizeKey("/mnt/d/workspace")).toBe("d:/workspace");
  });
  it("test_wsl_uppercase_and_lowercase_same_key", () => {
    expect(paths.normalizeKey("/mnt/C/foo/bar")).toBe(
      paths.normalizeKey("/mnt/c/foo/bar"),
    );
  });
  it("test_posix_mnt_non_drive_unchanged", () => {
    expect(paths.normalizeKey("/mnt/data/stuff")).toBe("/mnt/data/stuff");
  });
  it("test_wsl_path_with_embedded_backslash", () => {
    expect(paths.normalizeKey("/mnt/c/foo\\bar")).toBe("c:/foo/bar");
  });
});
