/**
 * Unit tests for token_goat/bash_cache. 1:1 port of tests/test_bash_cache.py.
 *
 * Test-seam mapping (Python -> TS):
 *  - tmp_data_dir fixture -> setup.ts's setDataDirOverride already gives each
 *    test a throwaway data dir; bash_cache writes under dataDir()/bash_outputs,
 *    so no per-test path juggling is needed.
 *  - monkeypatch.setattr(bash_cache, "evict_old_entries", fn) -> vi.spyOn on the
 *    live module namespace. store_output / store_glob_result / store_grep_result
 *    call evict_old_entries through the self-namespace import (self.evict_old_*),
 *    so the spy intercepts exactly as Python's monkeypatch.setattr does.
 *  - monkeypatch.setattr(bash_cache, "_last_eviction_ts", 0.0) -> the module's
 *    `_setLastEvictionTs(0.0)` test seam (the float is module-private mutable).
 *  - monkeypatch.setattr(bash_cache, "_bash_outputs_dir", bad_dir) -> vi.spyOn;
 *    get_recent_error_outputs reads the dir via self._bash_outputs_dir() so the
 *    spy intercepts.
 *  - patch.object(Path, "stat", flaky_stat) -> vi.spyOn(fs, "statSync") raising
 *    OSError for the targeted sidecar; find_cached_for_command's mtime sort goes
 *    through path_mtime_key -> fs.statSync, which swallows the OSError and sorts
 *    that entry to the bottom (TOCTOU tolerance).
 *  - inspect.signature default check -> assert against the exported constant.
 *
 * Sources deliberately skipped (hooks_read.post_bash not yet ported):
 *  - TestPostBashHook  (hooks_read.post_bash + session.load)
 *
 * Every ported Python `def test_*` maps to a vitest `it()` with the same name
 * and assertion polarity.
 */
import fs from "node:fs";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import * as bash_cache from "../src/token_goat/bash_cache.js";
import * as session from "../src/token_goat/session.js";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("TestStoreAndLoad", () => {
  it("test_small_output_round_trip", () => {
    const meta = bash_cache.store_output(
      "sess1",
      "ls -lh",
      "total 16\n-rw-r--r-- 1 user user x".repeat(10),
      "",
      0,
    );
    expect(meta).not.toBeNull();
    const body = bash_cache.load_output(meta!.output_id);
    expect(body).not.toBeNull();
    expect(body!.includes("total 16")).toBe(true);
    expect(meta!.stdout_bytes).toBeGreaterThan(0);
    expect(meta!.exit_code).toBe(0);
    expect(meta!.truncated).toBe(false);
  });

  it("test_large_output_is_tail_preserved", () => {
    const big = "A".repeat(3 * 1024 * 1024);
    const meta = bash_cache.store_output("sess2", "yes A", big, "", 0);
    expect(meta).not.toBeNull();
    expect(meta!.truncated).toBe(true);
    const body = bash_cache.load_output(meta!.output_id);
    expect(body).not.toBeNull();
    expect(body!.includes("token-goat: bash output truncated")).toBe(true);
    expect(body!.endsWith("A")).toBe(true);
  });

  it("test_utf8_truncation_bounded_by_bytes_not_chars", () => {
    const big_cjk = "中".repeat(1_000_000);
    const meta = bash_cache.store_output("utf8-sess", "echo cjk", big_cjk, "", 0);
    expect(meta).not.toBeNull();
    expect(meta!.truncated).toBe(true);

    const body = bash_cache.load_output(meta!.output_id);
    expect(body).not.toBeNull();
    const marker_end = body!.indexOf("]\n") + 2;
    const kept = body!.slice(marker_end);
    const kept_bytes = Buffer.from(kept, "utf8").length;
    const max_stored = 2 * 1024 * 1024;
    expect(kept_bytes).toBeLessThanOrEqual(max_stored);
  });

  it("test_id_format_rejects_traversal", () => {
    expect(bash_cache.load_output("../../etc/passwd")).toBeNull();
    expect(bash_cache.load_output("sess/with/slash")).toBeNull();
  });

  it("test_load_missing_returns_none", () => {
    expect(bash_cache.load_output("nonexistent-id")).toBeNull();
  });

  it("test_sidecar_round_trip", () => {
    const meta = bash_cache.store_output("sess3", "pytest -v", "PASS x".repeat(200), "warn\n", 0);
    expect(meta).not.toBeNull();
    bash_cache.write_sidecar(meta!);
    const loaded = bash_cache.read_sidecar(meta!.output_id);
    expect(loaded).not.toBeNull();
    expect(loaded!.cmd_sha).toBe(meta!.cmd_sha);
    expect(loaded!.exit_code).toBe(0);
  });

  it("test_evict_old_entries_respects_cap", () => {
    for (let i = 0; i < 5; i++) {
      bash_cache.store_output(`sess${i}`, `echo ${i}`, "X".repeat(200_000), "", 0);
    }
    const evicted = bash_cache.evict_old_entries({ max_total_bytes: 300_000 });
    expect(evicted).toBeGreaterThanOrEqual(1);
  });

  it("test_evict_removes_paired_sidecars", () => {
    const metas: bash_cache.BashOutputMeta[] = [];
    for (let i = 0; i < 5; i++) {
      const m = bash_cache.store_output(`sess${i}`, `echo ${i}`, "X".repeat(200_000), "", 0);
      expect(m).not.toBeNull();
      bash_cache.write_sidecar(m!);
      metas.push(m!);
    }

    // Sanity: every body has a sidecar before eviction.
    for (const m of metas) {
      const sp = bash_cache.sidecar_meta_path(m.output_id);
      expect(sp).not.toBeNull();
      expect(fs.existsSync(sp!)).toBe(true);
    }

    bash_cache.evict_old_entries({ max_total_bytes: 300_000 });

    // For any body removed, the sidecar must also be gone.
    for (const m of metas) {
      const body = path.join(bash_cache._bash_outputs_dir(), `${m.output_id}.txt`);
      const sp = bash_cache.sidecar_meta_path(m.output_id);
      expect(sp).not.toBeNull();
      if (!fs.existsSync(body)) {
        expect(fs.existsSync(sp!)).toBe(false);
      }
    }
  });

  it("test_orphan_sidecar_sweep", () => {
    const m = bash_cache.store_output("sess0", "ls", "X".repeat(500), "", 0);
    expect(m).not.toBeNull();
    bash_cache.write_sidecar(m!);

    // Plant an orphan sidecar with no matching body.
    const orphan = path.join(
      bash_cache._bash_outputs_dir(),
      "anon-0000000000000-deadbeefcafebabe.json",
    );
    fs.writeFileSync(orphan, "{}", "utf8");
    expect(fs.existsSync(orphan)).toBe(true);

    bash_cache.evict_old_entries({ max_total_bytes: 1 });
    expect(fs.existsSync(orphan)).toBe(false);
  });

  it("test_evict_old_entries_respects_max_file_count", () => {
    for (let i = 0; i < 5; i++) {
      bash_cache.store_output(`sess_fc_${i}`, `echo ${i}`, "hello", "", 0, {
        max_total_bytes: 999_999_999,
        max_file_count: 999_999,
      });
    }
    const evicted = bash_cache.evict_old_entries({
      max_total_bytes: 999_999_999,
      max_file_count: 2,
    });
    expect(evicted).toBeGreaterThanOrEqual(3);
  });

  it("test_evict_old_entries_default_max_file_count_is_constant", () => {
    // The Python checks the function signature default equals the constant; the
    // TS evict_old_entries defaults max_file_count to DEFAULT_MAX_FILE_COUNT.
    expect(bash_cache.DEFAULT_MAX_FILE_COUNT).toBe(4096);
  });

  it("test_store_output_strips_ansi_from_stdout", () => {
    const ansi_stdout =
      "\x1b[38;2;56;56;56m╭─────────────╮\x1b[m\n\x1b[1mbold text\x1b[0m\n";
    const meta = bash_cache.store_output("sess-ansi-1", "lefthook run", ansi_stdout, "", 0);
    expect(meta).not.toBeNull();
    const body = bash_cache.load_output(meta!.output_id);
    expect(body).not.toBeNull();
    expect(body!.includes("\x1b")).toBe(false);
    expect(body!.includes("╭─────────────╮")).toBe(true);
    expect(body!.includes("bold text")).toBe(true);
  });

  it("test_store_output_strips_ansi_from_stderr", () => {
    const ansi_stderr = "\x1b[31mERROR:\x1b[0m something went wrong\n";
    const meta = bash_cache.store_output("sess-ansi-2", "make build", "", ansi_stderr, 1);
    expect(meta).not.toBeNull();
    const body = bash_cache.load_output(meta!.output_id);
    expect(body).not.toBeNull();
    expect(body!.includes("\x1b")).toBe(false);
    expect(body!.includes("ERROR:")).toBe(true);
    expect(body!.includes("something went wrong")).toBe(true);
  });

  it("test_store_output_ansi_strip_is_idempotent", () => {
    const clean = "plain output line 1\nplain output line 2\n";
    const meta = bash_cache.store_output("sess-ansi-3", "echo plain", clean, "", 0);
    expect(meta).not.toBeNull();
    const body = bash_cache.load_output(meta!.output_id);
    expect(body).not.toBeNull();
    expect(body!.includes("plain output line 1")).toBe(true);
    expect(body!.includes("plain output line 2")).toBe(true);
  });

  it("test_store_output_eviction_oserror_does_not_discard_write", () => {
    // A confirmed write must return metadata even if eviction raises OSError.
    vi.spyOn(bash_cache, "evict_old_entries").mockImplementation(() => {
      const err = new Error("antivirus lock simulation") as NodeJS.ErrnoException;
      err.code = "EACCES";
      throw err;
    });
    // Ensure the throttle window allows eviction to fire on this call.
    bash_cache._setLastEvictionTs(0.0);

    const meta = bash_cache.store_output("sess_evict_err", "ls -lh", "output here", "", 0);
    expect(meta).not.toBeNull();
    const body = bash_cache.load_output(meta!.output_id);
    expect(body).not.toBeNull();
    expect(body!.includes("output here")).toBe(true);
  });

  it("test_output_below_min_threshold_not_cached", () => {
    const meta = bash_cache.store_output("sess-min-threshold", "echo hi", "X".repeat(500), "", 0, {
      min_cache_bytes: 1024,
    });
    expect(meta).toBeNull();
  });

  it("test_output_above_max_threshold_not_cached", () => {
    const large_output = "X".repeat(60 * 1024 * 1024);
    const meta = bash_cache.store_output(
      "sess-max-threshold",
      "cat huge.log",
      large_output,
      "",
      0,
      { max_cache_bytes: 50 * 1024 * 1024 },
    );
    expect(meta).toBeNull();
  });

  it("test_output_within_threshold_is_cached", () => {
    const meta = bash_cache.store_output("sess-within-threshold", "ls -la", "X".repeat(2048), "", 0, {
      min_cache_bytes: 1024,
      max_cache_bytes: 50 * 1024 * 1024,
    });
    expect(meta).not.toBeNull();
    const body = bash_cache.load_output(meta!.output_id);
    expect(body).not.toBeNull();
    expect(body!.length).toBeGreaterThan(0);
  });

  it("test_threshold_zero_min_caches_all", () => {
    const meta = bash_cache.store_output("sess-min-zero", "true", "X".repeat(100), "", 0, {
      min_cache_bytes: 0,
    });
    expect(meta).not.toBeNull();
    const body = bash_cache.load_output(meta!.output_id);
    expect(body).not.toBeNull();
  });
});

describe("TestSessionLookup", () => {
  it("test_mark_and_lookup", () => {
    const sha = bash_cache.command_hash("git log -20");
    session.mark_bash_run("lookup-1", sha, "git log -20", "out-1", 12345, 0, 0, false);
    const entry = session.lookup_bash_entry("lookup-1", sha);
    expect(entry).not.toBeNull();
    expect(entry!.output_id).toBe("out-1");
    expect(entry!.stdout_bytes).toBe(12345);
  });

  it("test_lookup_missing_returns_none", () => {
    expect(session.lookup_bash_entry("lookup-2", "deadbeef")).toBeNull();
  });
});

describe("TestNormalizeCommandForCacheKey", () => {
  const N = bash_cache.normalize_command_for_cache_key;

  it("test_strip_leading_trailing_whitespace", () => {
    expect(N("  pytest tests  ")).toBe("pytest tests");
    expect(N("\t\necho hello\n\t")).toBe("echo hello");
  });

  it("test_normalize_internal_whitespace_runs", () => {
    expect(N("pytest  tests")).toBe("pytest tests");
    expect(N("pytest\t\ttests")).toBe("pytest tests");
    expect(N("pytest\n\ntests")).toBe("pytest tests");
    expect(N("pytest  \t  tests")).toBe("pytest tests");
  });

  it("test_normalize_windows_path_separators", () => {
    expect(N("cd C:\\foo")).toBe("cd C:/foo");
    expect(N("rg pattern src\\lib")).toBe("rg pattern src/lib");
    expect(N("cat C:\\foo/bar\\baz")).toBe("cat C:/foo/bar/baz");
  });

  it("test_normalize_path_separators_in_flags", () => {
    expect(N("find . -path src\\tests")).toBe("find . -path src/tests");
  });

  it("test_pytest_flag_sorting", () => {
    expect(N("pytest -x -q tests/")).toBe("pytest -q -x tests");
    expect(N("pytest -q -x tests/")).toBe("pytest -q -x tests");
    expect(N("pytest -v -q tests/")).toBe("pytest -q -v tests");
  });

  it("test_pytest_with_uv_run", () => {
    expect(N("uv run pytest -x -q tests/")).toBe("uv run pytest -q -x tests");
  });

  it("test_rg_flag_sorting", () => {
    expect(N("rg -o -i pattern")).toBe("rg -i -o pattern");
    expect(N("rg -i -o pattern")).toBe("rg -i -o pattern");
    expect(N("rg -x -y -z pattern")).toBe("rg -x -y -z pattern");
    expect(N("rg pattern -o -i")).toBe("rg pattern -o -i");
  });

  it("test_grep_flag_sorting", () => {
    expect(N("grep -r -n file")).toBe("grep -n -r file");
    expect(N("grep -n -r file")).toBe("grep -n -r file");
  });

  it("test_git_flag_sorting", () => {
    expect(N("git log -20 -n")).toBe("git log -20 -n");
    expect(N("git log -p -v")).toBe("git log -p -v");
  });

  it("test_flags_only_before_first_positional", () => {
    expect(N("pytest -q -x tests/ -v")).toBe("pytest -q -x tests -v");
  });

  it("test_ignores_long_flags", () => {
    expect(N("pytest --verbose -q tests/")).toBe("pytest --verbose -q tests");
    expect(N("rg -i --type py")).toBe("rg -i --type py");
  });

  it("test_no_sorting_for_unknown_tools", () => {
    expect(N("ls -l -h")).toBe("ls -l -h");
  });

  it("test_empty_command", () => {
    expect(N("")).toBe("");
    expect(N("   ")).toBe("");
  });

  it("test_combined_normalizations", () => {
    expect(N("  uv run pytest  -x  -q  C:\\tests  ")).toBe("uv run pytest -q -x C:/tests");
  });

  it("test_real_world_example_1", () => {
    const cmd1 = "uv run pytest -q -x tests/";
    const cmd2 = "uv run pytest  -x  -q  tests/";
    expect(N(cmd1)).toBe(N(cmd2));
  });

  it("test_real_world_example_2", () => {
    const cmd1 = "rg -i -o pattern src\\lib";
    const cmd2 = "rg -o -i pattern src/lib";
    expect(N(cmd1)).toBe(N(cmd2));
  });

  it("test_numeric_single_char_flags", () => {
    expect(N("grep -1 -2 pattern")).toBe("grep -1 -2 pattern");
  });

  it("test_preserves_command_semantics", () => {
    const cmd = "pytest -q -x tests/";
    const normalized_once = N(cmd);
    const normalized_twice = N(normalized_once);
    expect(normalized_once).toBe(normalized_twice);
  });

  it("test_dot_slash_prefix_stripped", () => {
    expect(N("cat ./src/auth.py")).toBe("cat src/auth.py");
    expect(N("python ./script.py")).toBe("python script.py");
    expect(N("node ./index.js")).toBe("node index.js");
  });

  it("test_dot_slash_dedup_produces_same_hash", () => {
    expect(bash_cache.command_hash("cat ./src/auth.py")).toBe(
      bash_cache.command_hash("cat src/auth.py"),
    );
    expect(bash_cache.command_hash("pytest ./tests/")).toBe(
      bash_cache.command_hash("pytest tests"),
    );
  });

  it("test_dot_dot_slash_not_stripped", () => {
    expect(N("cat ../parent.py")).toBe("cat ../parent.py");
    expect(bash_cache.command_hash("cat ../parent.py")).not.toBe(
      bash_cache.command_hash("cat parent.py"),
    );
  });

  it("test_trailing_slash_stripped", () => {
    expect(N("pytest tests/")).toBe("pytest tests");
    expect(N("rg pattern src/")).toBe("rg pattern src");
  });

  it("test_filesystem_root_not_stripped", () => {
    expect(N("ls /")).toBe("ls /");
    expect(N("ls /etc")).toBe("ls /etc");
  });

  it("test_flags_not_affected_by_path_normalisation", () => {
    expect(N("rg -i ./src/")).toBe("rg -i src");
    expect(N("rg --include=./foo")).toBe("rg --include=./foo");
  });

  it("test_shell_operators_not_affected", () => {
    const result = N("cd ./project && pytest ./tests/");
    expect(result).toBe("cd project && pytest tests");
  });

  it("test_bare_dot_slash_becomes_dot", () => {
    expect(N("ls ./")).toBe("ls .");
    expect(N("ls -la ./")).toBe("ls -la .");
  });

  it("test_dot_slash_normalisation_is_idempotent", () => {
    const cmds = ["cat ./src/auth.py", "pytest ./tests/", "rg -i ./src/", "ls ./"];
    for (const cmd of cmds) {
      const n1 = N(cmd);
      const n2 = N(n1);
      expect(n1).toBe(n2);
    }
  });
});

describe("TestCommandHashCwdScoping", () => {
  it("test_same_command_different_cwd_different_hash", () => {
    const h1 = bash_cache.command_hash("pytest tests/", "/home/user/projectA");
    const h2 = bash_cache.command_hash("pytest tests/", "/home/user/projectB");
    expect(h1).not.toBe(h2);
  });

  it("test_same_command_no_cwd_is_stable", () => {
    const h_none = bash_cache.command_hash("pytest tests/");
    const h_none2 = bash_cache.command_hash("pytest tests/", null);
    expect(h_none).toBe(h_none2);
  });

  it("test_cwd_none_differs_from_empty_cwd", () => {
    const h_none = bash_cache.command_hash("pytest tests/", null);
    const h_empty = bash_cache.command_hash("pytest tests/", "");
    expect(h_none).not.toBe(h_empty);
  });

  it("test_normalized_commands_produce_same_hash", () => {
    const h1 = bash_cache.command_hash("pytest  -x  -q  tests/");
    const h2 = bash_cache.command_hash("pytest -q -x tests/");
    expect(h1).toBe(h2);
  });

  it("test_normalized_with_path_separators", () => {
    const h1 = bash_cache.command_hash("cd C:\\foo && pytest tests/");
    const h2 = bash_cache.command_hash("cd C:/foo && pytest tests/");
    expect(h1).toBe(h2);
  });

  it("test_normalization_respects_cwd_scope", () => {
    const h1 = bash_cache.command_hash("pytest  -x  -q  tests/", "/home/projectA");
    const h2 = bash_cache.command_hash("pytest -q -x tests/", "/home/projectB");
    expect(h1).not.toBe(h2);

    const h3 = bash_cache.command_hash("pytest  -x  -q  tests/", "/home/projectA");
    expect(h3).toBe(h1);
  });

  it("test_find_cached_for_command_scoped_to_cwd", () => {
    const cmd = "pytest tests/";
    const cwd_a = "/home/user/projectA";
    const cwd_b = "/home/user/projectB";

    const meta_a = bash_cache.store_output("sess-cwd-a", cmd, "X".repeat(500), "", 0, { cwd: cwd_a });
    expect(meta_a).not.toBeNull();
    bash_cache.write_sidecar(meta_a!);

    const result = bash_cache.find_cached_for_command(cmd, cwd_b);
    expect(result).toBeNull();

    const result2 = bash_cache.find_cached_for_command(cmd, cwd_a);
    expect(result2).not.toBeNull();
    expect(result2!.cmd_sha).toBe(meta_a!.cmd_sha);
  });

  it("test_find_cached_for_command_tolerates_concurrent_deletion", () => {
    const cmd = "pytest tests/";
    const cwd = "/home/user/project";

    const meta1 = bash_cache.store_output("sess-del-a", cmd, "Z".repeat(500), "", 0, { cwd });
    expect(meta1).not.toBeNull();
    bash_cache.write_sidecar(meta1!);
    const meta2 = bash_cache.store_output("sess-del-b", cmd, "Z".repeat(600), "", 0, { cwd });
    expect(meta2).not.toBeNull();
    bash_cache.write_sidecar(meta2!);

    // Simulate one sidecar being deleted during the sort by raising OSError on
    // statSync for that file (path_mtime_key swallows it -> sorts to bottom).
    const realStatSync = fs.statSync.bind(fs);
    vi.spyOn(fs, "statSync").mockImplementation(((p: fs.PathLike, opts?: fs.StatSyncOptions) => {
      const sp = String(p);
      if (sp.endsWith(".json") && sp.includes("sess-del-a")) {
        const err = new Error("simulated concurrent deletion") as NodeJS.ErrnoException;
        err.code = "ENOENT";
        throw err;
      }
      return realStatSync(p as fs.PathLike, opts as fs.StatSyncOptions);
    }) as typeof fs.statSync);

    const result = bash_cache.find_cached_for_command(cmd, cwd);

    expect(result).not.toBeNull();
    expect(result!.cmd_sha).toBe(bash_cache.command_hash(cmd, cwd));
  });

  it("test_cwd_drive_letter_case_shares_hash", () => {
    const h_upper = bash_cache.command_hash("git status", "C:/Projects/token-goat");
    const h_lower = bash_cache.command_hash("git status", "c:/Projects/token-goat");
    expect(h_upper).toBe(h_lower);
  });

  it("test_cwd_path_separator_shares_hash", () => {
    const h_back = bash_cache.command_hash("git status", "C:\\Projects\\token-goat");
    const h_fwd = bash_cache.command_hash("git status", "c:/Projects/token-goat");
    expect(h_back).toBe(h_fwd);
  });

  it("test_cwd_wsl_form_shares_hash_with_windows_form", () => {
    const h_wsl = bash_cache.command_hash("git status", "/mnt/c/Projects/token-goat");
    const h_win = bash_cache.command_hash("git status", "C:\\Projects\\token-goat");
    expect(h_wsl).toBe(h_win);
  });

  it("test_cwd_posix_case_variance_stays_distinct", () => {
    const h1 = bash_cache.command_hash("git status", "/srv/Foo");
    const h2 = bash_cache.command_hash("git status", "/srv/foo");
    expect(h1).not.toBe(h2);
  });

  it("test_find_cached_for_command_matches_across_cwd_representation", () => {
    const cmd = "git status";
    const meta = bash_cache.store_output("sess-pathvar", cmd, "X".repeat(500), "", 0, {
      cwd: "C:\\Projects\\token-goat",
    });
    expect(meta).not.toBeNull();
    bash_cache.write_sidecar(meta!);

    const result = bash_cache.find_cached_for_command(cmd, "c:/Projects/token-goat");
    expect(result).not.toBeNull();
    expect(result!.cmd_sha).toBe(meta!.cmd_sha);
  });
});

describe("TestGetRecentErrorOutputs", () => {
  it("test_empty_cache_returns_empty_list", () => {
    const result = bash_cache.get_recent_error_outputs("sess-empty");
    expect(result).toEqual([]);
  });

  it("test_non_zero_exit_code_detected", () => {
    const meta = bash_cache.store_output("sess-error-1", "pytest tests/", "output\n", "", 1);
    expect(meta).not.toBeNull();
    bash_cache.write_sidecar(meta!);

    const result = bash_cache.get_recent_error_outputs("sess-error-1", 5);
    expect(result.length).toBe(1);
    expect(result[0]!.command).toBe("pytest tests/");
    expect(result[0]!.error_summary.includes("exit 1")).toBe(true);
  });

  it("test_error_pattern_in_output_detected", () => {
    const output = "running tests...\nError: assertion failed on line 42\ndone\n";
    const meta = bash_cache.store_output("sess-error-2", "pytest tests/", output, "", 0);
    expect(meta).not.toBeNull();
    bash_cache.write_sidecar(meta!);

    const result = bash_cache.get_recent_error_outputs("sess-error-2", 5);
    expect(result.length).toBe(1);
    expect(result[0]!.error_summary.includes("assertion failed on line 42")).toBe(true);
  });

  it("test_traceback_pattern_detected", () => {
    const output = "Traceback (most recent call last):\n  File 'test.py', line 5\nerror\n";
    const meta = bash_cache.store_output("sess-error-3", "python test.py", output, "", 1);
    expect(meta).not.toBeNull();
    bash_cache.write_sidecar(meta!);

    const result = bash_cache.get_recent_error_outputs("sess-error-3", 5);
    expect(result.length).toBe(1);
    expect(result[0]!.error_summary.includes("Traceback")).toBe(true);
  });

  it("test_failed_pattern_detected", () => {
    const output = "test_foo.py::test_bar FAILED - AssertionError\n";
    const meta = bash_cache.store_output("sess-error-4", "pytest test_foo.py", output, "", 1);
    expect(meta).not.toBeNull();
    bash_cache.write_sidecar(meta!);

    const result = bash_cache.get_recent_error_outputs("sess-error-4", 5);
    expect(result.length).toBe(1);
    expect(
      result[0]!.error_summary.includes("FAILED") ||
        result[0]!.error_summary.includes("AssertionError"),
    ).toBe(true);
  });

  it("test_lowercase_error_pattern_detected", () => {
    const output = "Processing complete with error: file not found\n";
    const meta = bash_cache.store_output("sess-error-5", "tool process", output, "", 0);
    expect(meta).not.toBeNull();
    bash_cache.write_sidecar(meta!);

    const result = bash_cache.get_recent_error_outputs("sess-error-5", 5);
    expect(result.length).toBe(1);
    expect(result[0]!.error_summary.includes("error:")).toBe(true);
  });

  it("test_max_entries_limit", () => {
    for (let i = 0; i < 5; i++) {
      const meta = bash_cache.store_output(
        "sess-error-limit",
        `cmd${i}`,
        `Error: code ${i}\n`,
        "",
        (i % 2) + 1,
      );
      expect(meta).not.toBeNull();
      bash_cache.write_sidecar(meta!);
    }

    const result = bash_cache.get_recent_error_outputs("sess-error-limit", 2);
    expect(result.length).toBeLessThanOrEqual(2);
  });

  it("test_successful_commands_ignored", () => {
    const meta = bash_cache.store_output("sess-success", "ls -la /tmp", "file1\nfile2\n", "", 0);
    expect(meta).not.toBeNull();
    bash_cache.write_sidecar(meta!);

    const result = bash_cache.get_recent_error_outputs("sess-success", 5);
    expect(result).toEqual([]);
  });

  it("test_wrong_session_id_ignored", () => {
    const meta = bash_cache.store_output("sess-error-a", "pytest", "Error: failed\n", "", 1);
    expect(meta).not.toBeNull();
    bash_cache.write_sidecar(meta!);

    const result = bash_cache.get_recent_error_outputs("sess-error-b", 5);
    expect(result).toEqual([]);
  });

  it("test_fail_soft_on_missing_cache_dir", () => {
    vi.spyOn(bash_cache, "_bash_outputs_dir").mockImplementation(() => {
      const err = new Error("no permission") as NodeJS.ErrnoException;
      err.code = "EACCES";
      throw err;
    });
    const result = bash_cache.get_recent_error_outputs("sess-error-fail", 5);
    expect(result).toEqual([]);
  });
});

describe("TestEvictionThrottleRegression", () => {
  it("test_eviction_not_called_twice_within_throttle_window", () => {
    let call_count = 0;
    vi.spyOn(bash_cache, "evict_old_entries").mockImplementation(() => {
      call_count += 1;
      return 0;
    });
    bash_cache._setLastEvictionTs(0.0);

    bash_cache.store_output("thr-sess-1", "pytest", "pass\n", "", 0);
    bash_cache.store_output("thr-sess-1", "pytest", "pass2\n", "", 0);

    expect(call_count).toBe(1);
  });

  it("test_eviction_called_once_per_window", () => {
    let call_count = 0;
    vi.spyOn(bash_cache, "evict_old_entries").mockImplementation(() => {
      call_count += 1;
      return 0;
    });
    bash_cache._setLastEvictionTs(0.0);

    bash_cache.store_output("thr-sess-2", "pytest", "pass\n", "", 0);
    expect(call_count).toBe(1);

    bash_cache._setLastEvictionTs(0.0);

    bash_cache.store_output("thr-sess-2", "pytest", "pass2\n", "", 0);
    expect(call_count).toBe(2);
  });

  it("test_eviction_skipped_within_window", () => {
    let call_count = 0;
    vi.spyOn(bash_cache, "evict_old_entries").mockImplementation(() => {
      call_count += 1;
      return 0;
    });
    // Set last eviction to "just now" so the next call is within the window.
    bash_cache._setLastEvictionTs(bash_cache._monotonic());

    bash_cache.store_output("thr-sess-3", "ls", "file.py\n", "", 0);

    expect(call_count).toBe(0);
  });
});
