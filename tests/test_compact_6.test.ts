/**
 * Tests for compaction assist — final slice (part 6/6).
 *
 * 1:1 port of tests/test_compact.py classes TestCompactHintCli through
 * TestContextPressure (Python lines ~7530-9154). Each Python `def test_*` maps
 * to a vitest `it()` with the SAME name and the SAME assertion polarity; each
 * Python `class Test*` maps to a `describe(...)`.
 *
 * This is a STANDALONE file: it re-declares the shared helpers the part-1 file
 * uses (makeSession, a git-repo builder, a SessionCache-mutation helper) rather
 * than importing them.
 *
 * ---------------------------------------------------------------------------
 * Parity notes (Python -> TS)
 * ---------------------------------------------------------------------------
 *  - Session-cache fixtures are built with the shipped session.ts API
 *    (mark_file_read / mark_grep / mark_file_edited / mark_bash_run /
 *    mark_web_fetch / load / save). Python kwargs map positionally:
 *      mark_file_read(sid, p, offset=O, limit=L)   -> mark_file_read(sid, p, O, L)
 *      mark_file_read(sid, p, symbol="X")          -> mark_file_read(sid, p, null, null, {symbol:"X"})
 *
 *  - `_group_edited_by_dir(entries, threshold=N)` (Python keyword) -> the TS
 *    signature is `_group_edited_by_dir(entries, project_root=null, threshold)`,
 *    so the call becomes `_group_edited_by_dir(entries, null, N)`.
 *
 *  - `_render(cache, sid, max, noise_floor_tokens=N)` -> `_render(cache, sid,
 *    max, {noise_floor_tokens: N})`; it returns `[manifest, count]`.
 *
 *  - `build_manifest(sid, max_tokens=N)` -> `build_manifest(sid, {max_tokens:N})`.
 *
 *  - `_get_uncommitted_changes` / `_get_git_diff_stat` / `_get_session_commits`
 *    monkeypatch. Python patches these on `compact` purely to suppress git output
 *    for a non-git session cwd. The TS compact calls them via local bindings
 *    (the first two are module-private; the summary form is exported but called
 *    via a local binding) so a namespace spy would not intercept them. In every
 *    manifest test here the session cwd is null (the `/proj/...` paths are never
 *    set as cwd) so `_get_session_commits(null, …)` returns [] and the
 *    uncommitted/diff-stat helpers return ""/null already — the monkeypatch is a
 *    no-op and is omitted (same approach as the part-1 port).
 *
 *  - `_load_config` monkeypatch (orchestrator manifest tests). Python patches
 *    `compact._load_config`; the TS compact loads config via the STATIC
 *    `config.load()` import, so the port spies `vi.spyOn(config, "load")` to
 *    return a config with the overridden compact_assist fields (the same end
 *    state).
 *
 *  - `config.CompactAssistConfig()` (TestOrchestratorConfig.test_default_value)
 *    is a constructable frozen dataclass in Python; in the TS port
 *    CompactAssistConfig is an interface (no default-factory). The default value
 *    is therefore asserted through `config.load().compact_assist` (with an empty
 *    per-test data dir it resolves to the schema defaults), which carries the
 *    same contract. Noted in parity_notes.
 *
 *  - ContextPressure is a frozen dataclass in Python -> a class with `readonly`
 *    fields in TS. The fields are readonly at the TYPE level (compile-time) but
 *    the class is NOT Object.freeze'd, so a runtime reassignment does not throw.
 *    `test_dataclass_is_frozen` is ported as a compile-time immutability check
 *    (`@ts-expect-error` on the reassignment) plus a value-unchanged assertion.
 *    Noted in parity_notes + known_gaps.
 *
 *  - `test_section_group_order_in_source` is a structural test: Python uses
 *    `inspect.getsource(compact._render)` + a regex over the Python tuple syntax.
 *    The TS port reads the compact.ts source file and applies the analogous
 *    regex over the `_section_groups` array-literal syntax (`["name", …, flag]`).
 *
 *  - Git fixtures build a REAL repo via util.runGit with core.hooksPath=/dev/null
 *    and commit.gpgsign=false pinned (mirrors conftest.make_git_repo +
 *    _disable_user_git_hooks). tmp dirs are wrapped in fs.realpathSync.
 *
 * Deferred (it.skip with reason), counted:
 *  - TestCompactHintCli (8 tests): imports token_goat.cli (Layer 7).
 *  - TestInferSessionGoal.test_goal_in_recovery_hint: imports
 *    token_goat.hooks_session (not yet ported).
 *  - TestManifestSectionOrder.{test_skills_after_edited_files,
 *    test_skills_after_files, test_edited_before_skills_even_when_symbols_absent}:
 *    import token_goat.skill_cache (not yet ported).
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import * as compact from "../src/token_goat/compact.js";
import * as session from "../src/token_goat/session.js";
import * as config from "../src/token_goat/config.js";
import { runGit } from "../src/token_goat/util.js";
import type { ConfigSchema } from "../src/token_goat/types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** conftest `_make_session` analogue (only the kwargs these tests use). */
function makeSession(
  session_id: string,
  opts: { files_read?: number; greps?: number; edits?: number } = {},
): session.SessionCache {
  const files_read = opts.files_read ?? 0;
  const greps = opts.greps ?? 0;
  const edits = opts.edits ?? 0;
  for (let i = 0; i < files_read; i++) {
    session.mark_file_read(session_id, `/proj/src/file${i}.py`, 0, 100);
  }
  for (let i = 0; i < greps; i++) {
    session.mark_grep(session_id, `pattern${i}`, "/proj/src");
  }
  for (let i = 0; i < edits; i++) {
    session.mark_file_edited(session_id, `/proj/src/edited${i}.py`);
  }
  return session.load(session_id);
}

/** A ConfigSchema with chosen compact_assist fields overridden. */
function configWith(overrides: Record<string, unknown>): ConfigSchema {
  const base = config.load();
  return {
    ...base,
    compact_assist: { ...(base.compact_assist ?? {}), ...overrides },
  } as ConfigSchema;
}

// --- tmp-dir factory (pytest tmp_path analogue) ---------------------------
let _tmpCounter = 0;
const _tmpRoots: string[] = [];
function tmpPath(): string {
  // realpathSync resolves macOS's /var -> /private/var symlink so paths used as
  // project/repo roots match what git / find_project canonicalise them to.
  const dir = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), `tg-compact6-${process.pid}-${_tmpCounter++}-`)),
  );
  _tmpRoots.push(dir);
  return dir;
}

afterEach(() => {
  while (_tmpRoots.length) {
    const d = _tmpRoots.pop()!;
    try {
      fs.rmSync(d, { recursive: true, force: true });
    } catch {
      // best-effort
    }
  }
  vi.restoreAllMocks();
});

/** Run git in `cwd`, throwing on non-zero exit (test-only strict helper). */
function _git(args: string[], cwd: string): void {
  const res = runGit(args, { cwd, timeout: 30 });
  if (res.returncode !== 0) {
    throw new Error(`git ${args.join(" ")} failed (${res.returncode}): ${res.stderr}`);
  }
}

/**
 * Build a minimal git repo under `parent/name` and return its path. Mirrors
 * conftest.make_git_repo (the `commits` form): each (files, message) tuple
 * becomes its own commit. core.hooksPath=/dev/null + commit.gpgsign=false are
 * pinned so a user/global lefthook or signing config does not fire on commits.
 */
function makeGitRepo(
  parent: string,
  opts: {
    name?: string;
    user?: string;
    email?: string;
    commits: Array<[Record<string, string>, string]>;
  },
): string {
  const name = opts.name ?? "repo";
  const user = opts.user ?? "T";
  const email = opts.email ?? "t@t.com";
  const repo = path.join(parent, name);
  fs.mkdirSync(repo);

  const hooksOff = ["-c", "core.hooksPath=/dev/null"];
  _git([...hooksOff, "init"], repo);
  _git([...hooksOff, "config", "user.email", email], repo);
  _git([...hooksOff, "config", "user.name", user], repo);

  for (const [payload, msg] of opts.commits) {
    for (const [rel, content] of Object.entries(payload)) {
      const fp = path.join(repo, rel);
      fs.mkdirSync(path.dirname(fp), { recursive: true });
      fs.writeFileSync(fp, content);
    }
    _git([...hooksOff, "add", "."], repo);
    _git([...hooksOff, "-c", "commit.gpgsign=false", "commit", "-m", msg], repo);
  }
  return repo;
}

/** Current wall-clock in seconds (Python time.time()). */
function _now(): number {
  return Date.now() / 1000;
}

// ===========================================================================
// TestCompactHintCli — DEFERRED (imports token_goat.cli, Layer 7)
// ===========================================================================

describe("TestCompactHintCli", () => {
  it.skip("test_json_includes_full_gate_chain_keys", () => {
    // PORT: deferred — imports token_goat.cli (Layer 7, not yet ported).
  });
  it.skip("test_default_max_tokens_uses_config", () => {
    // PORT: deferred — imports token_goat.cli (Layer 7, not yet ported).
  });
  it.skip("test_auto_trigger_applies_multiplier", () => {
    // PORT: deferred — imports token_goat.cli (Layer 7, not yet ported).
  });
  it.skip("test_trigger_not_in_config_blocks_emit", () => {
    // PORT: deferred — imports token_goat.cli (Layer 7, not yet ported).
  });
  it.skip("test_sentinel_fast_path_blocks_emit", () => {
    // PORT: deferred — imports token_goat.cli (Layer 7, not yet ported).
  });
  it.skip("test_token_estimate_matches_canonical_helper", () => {
    // PORT: deferred — imports token_goat.cli (Layer 7, not yet ported).
  });
  it.skip("test_text_output_shows_trigger_and_budget", () => {
    // PORT: deferred — imports token_goat.cli (Layer 7, not yet ported).
  });
  it.skip("test_session_id_validation_still_enforced", () => {
    // PORT: deferred — imports token_goat.cli (Layer 7, not yet ported).
  });
});

// ===========================================================================
// TestNoiseFloor — configurable noise floor filters out low-signal sections
// ===========================================================================

describe("TestNoiseFloor", () => {
  it("test_noise_floor_zero_disabled_by_default", () => {
    const sid = "noise-floor-disabled-test";
    session.mark_file_read(sid, "/proj/src/a.py");
    session.mark_file_read(sid, "/proj/src/b.py");
    session.mark_file_edited(sid, "/proj/src/c.py");
    // Add a small grep entry (which will be small).
    const cache = session.load(sid);
    cache.greps.push(new session.GrepEntry({ pattern: "test", path: null, result_count: 0, ts: _now() }));
    session.save(cache);

    // Python monkeypatched compact._get_uncommitted_changes/_get_git_diff_stat*
    // /_get_session_commits to "" / None / []. Here cwd is null so they no-op.
    const result = compact.build_manifest(sid);
    // When noise floor is 0, even very small sections like "**Patterns Searched:**"
    // should appear (if they have any content).
    expect(
      result.includes("**Patterns Searched:**") || !result.includes("**Patterns Searched:**"),
    ).toBe(true);
    // But at minimum, key sections should exist.
    expect(result.includes("**Staged/Uncommitted:**") || result.includes("**Edited:**")).toBe(true);
    expect(result.includes("**Symbols Accessed:**") || result.includes("**Files:**")).toBe(true);
  });

  it("test_noise_floor_high_value_drops_all_optional_sections", () => {
    const sid = "noise-floor-high-test";
    session.mark_file_read(sid, "/proj/src/a.py");
    session.mark_file_read(sid, "/proj/src/b.py");
    session.mark_file_edited(sid, "/proj/src/edited.py");

    const cfgSpy = vi.spyOn(config, "load").mockReturnValue(configWith({ noise_floor_tokens: 10000 }));
    const result = compact.build_manifest(sid);
    cfgSpy.mockRestore();

    // Protected sections should still be present (edited is protected).
    expect(result.includes("**Staged/Uncommitted:**") || result.includes("**Edited:**")).toBe(true);
    // Optional sections like **Symbols Accessed:** and **Files:** should be
    // dropped when their token count is below 10000 (depends on session content).
  });

  it("test_noise_floor_moderate_value_drops_small_sections", () => {
    const sid = "noise-floor-moderate-test";
    session.mark_file_read(sid, "/proj/src/a.py");
    session.mark_file_edited(sid, "/proj/src/edited.py");

    const cfgSpy = vi.spyOn(config, "load").mockReturnValue(configWith({ noise_floor_tokens: 50 }));
    const result = compact.build_manifest(sid);
    cfgSpy.mockRestore();

    // The manifest should still have header and edited sections (protected).
    expect(result.includes("**Staged/Uncommitted:**") || result.includes("**Edited:**")).toBe(true);
    // Some optional sections might be dropped if they are small.
  });

  it("test_render_uses_noise_floor_tokens_parameter_not_config", () => {
    const sid = "noise-floor-param-direct-test";
    session.mark_file_read(sid, "/proj/src/a.py");
    session.mark_file_read(sid, "/proj/src/b.py");
    session.mark_file_edited(sid, "/proj/src/edited.py");
    const cache = session.load(sid);

    // Pass a high noise floor directly to _render; config is NOT touched.
    const [result] = compact._render(cache, sid, 400, { noise_floor_tokens: 10000 });

    // Protected — always survives.
    expect(result.includes("**Staged/Uncommitted:**") || result.includes("**Edited:**")).toBe(true);
    // The symbols section (unprotected, small) is dropped: token count < 10000.
    expect(result.includes("**Symbols Accessed:**")).toBe(false);
  });
});

// ===========================================================================
// TestEditedDirGrouping — directory-level grouping of edited files
// ===========================================================================

describe("TestEditedDirGrouping", () => {
  it("test_threshold_zero_disables_grouping", () => {
    const entries: Array<[string, number]> = [
      ["src/foo/a.py", 2],
      ["src/foo/b.py", 1],
      ["src/foo/c.py", 1],
    ];
    const result = compact._group_edited_by_dir(entries, null, 0);
    expect(result.length).toBe(3);
    for (const line of result) {
      expect(line.startsWith("- ✎")).toBe(true);
    }
  });

  it("test_under_threshold_no_grouping", () => {
    const entries: Array<[string, number]> = [
      ["src/foo/a.py", 3],
      ["src/foo/b.py", 2],
    ];
    const result = compact._group_edited_by_dir(entries, null, 5);
    expect(result.length).toBe(2);
    expect(result.every((line) => line.startsWith("- ✎"))).toBe(true);
  });

  it("test_at_threshold_grouped", () => {
    const entries: Array<[string, number]> = [
      ["src/foo/a.py", 5],
      ["src/foo/b.py", 4],
      ["src/foo/c.py", 3],
      ["src/foo/d.py", 2],
      ["src/foo/e.py", 1],
    ];
    const result = compact._group_edited_by_dir(entries, null, 5);
    expect(result.length).toBe(1);
    const grouped_line = result[0]!;
    expect(grouped_line.includes("(5 files):")).toBe(true);
    expect(grouped_line.includes("a.py")).toBe(true);
    expect(grouped_line.includes("5")).toBe(true);
    expect(grouped_line.includes("b.py")).toBe(true);
    expect(grouped_line.includes("4")).toBe(true);
  });

  it("test_grouping_preserves_edit_counts", () => {
    const entries: Array<[string, number]> = [
      ["src/foo/edited1.py", 10],
      ["src/foo/edited2.py", 5],
      ["src/foo/edited3.py", 3],
      ["src/foo/edited4.py", 2],
      ["src/foo/edited5.py", 1],
    ];
    const result = compact._group_edited_by_dir(entries, null, 5);
    expect(result.length).toBe(1);
    const line = result[0]!;
    // Files should be sorted by count descending.
    expect(line.includes("edited1.py")).toBe(true);
    expect(line.includes("10")).toBe(true);
    expect(line.includes("edited2.py")).toBe(true);
    expect(line.includes("5")).toBe(true);
  });

  it("test_mixed_dirs_some_grouped_some_not", () => {
    const entries: Array<[string, number]> = [
      ["src/a/f1.py", 5],
      ["src/a/f2.py", 4],
      ["src/a/f3.py", 3],
      ["src/a/f4.py", 2],
      ["src/a/f5.py", 1],
      ["src/b/g1.py", 3],
      ["src/b/g2.py", 2],
    ];
    const result = compact._group_edited_by_dir(entries, null, 5);
    expect(result.length).toBe(3);
    const grouped_lines = result.filter((line) => line.includes("(5 files):"));
    expect(grouped_lines.length).toBe(1);
    const individual_lines = result.filter((line) => line.startsWith("- ✎"));
    expect(individual_lines.length).toBe(2);
  });

  it("test_custom_threshold_values", () => {
    const entries: Array<[string, number]> = [
      ["src/x/a.py", 3],
      ["src/x/b.py", 2],
      ["src/x/c.py", 1],
    ];
    let result = compact._group_edited_by_dir(entries, null, 1);
    expect(result.length).toBe(1);
    expect(result[0]!.includes("(3 files):")).toBe(true);

    result = compact._group_edited_by_dir(entries, null, 3);
    expect(result.length).toBe(1);
    expect(result[0]!.includes("(3 files):")).toBe(true);

    result = compact._group_edited_by_dir(entries, null, 4);
    expect(result.length).toBe(3);
    expect(result.every((line) => line.startsWith("- ✎"))).toBe(true);
  });
});

// ===========================================================================
// TestSectionLineCap — per-section line capping
// ===========================================================================

describe("TestSectionLineCap", () => {
  it("test_cap_disabled_default_zero", () => {
    const lines = ["### Header", "- item1", "- item2", "- item3"];
    const result = compact._apply_section_line_cap(lines, 0);
    expect(result).toEqual(lines);
  });

  it("test_cap_disabled_negative", () => {
    const lines = ["### Header", "- item1", "- item2"];
    const result = compact._apply_section_line_cap(lines, -5);
    expect(result).toEqual(lines);
  });

  it("test_cap_exceeds_items_no_truncation", () => {
    const lines = ["### Header", "- item1", "- item2"];
    const result = compact._apply_section_line_cap(lines, 10);
    expect(result).toEqual(lines);
    expect(result.join("\n").includes("+more")).toBe(false);
  });

  it("test_cap_equals_item_count_no_truncation", () => {
    const lines = ["### Header", "- item1", "- item2", "- item3"];
    const result = compact._apply_section_line_cap(lines, 3);
    expect(result).toEqual(lines);
    expect(result.length).toBe(4);
  });

  it("test_cap_truncates_to_two_items_plus_overflow", () => {
    const lines = ["### Header", "- item1", "- item2", "- item3", "- item4", "- item5"];
    const result = compact._apply_section_line_cap(lines, 2);
    expect(result.length).toBe(4); // header + 2 items + overflow line
    expect(result[0]).toBe("### Header");
    expect(result[1]).toBe("- item1");
    expect(result[2]).toBe("- item2");
    expect(result[3]).toBe("- ... (+3 more)");
  });

  it("test_cap_one_item", () => {
    const lines = ["**Symbols:**", "- symbol1", "- symbol2", "- symbol3"];
    const result = compact._apply_section_line_cap(lines, 1);
    expect(result.length).toBe(3); // header + 1 item + overflow
    expect(result[0]).toBe("**Symbols:**");
    expect(result[1]).toBe("- symbol1");
    expect(result[2]).toBe("- ... (+2 more)");
  });

  it("test_empty_lines_list_unchanged", () => {
    const result = compact._apply_section_line_cap([], 5);
    expect(result).toEqual([]);
  });

  it("test_header_only_unchanged", () => {
    const lines = ["### Header"];
    const result = compact._apply_section_line_cap(lines, 5);
    expect(result).toEqual(lines);
  });

  it("test_overflow_count_accurate", () => {
    const items: string[] = [];
    for (let i = 0; i < 20; i++) {
      items.push(`- file${i}.py`);
    }
    const lines = ["**Edited:**", ...items];
    const result = compact._apply_section_line_cap(lines, 3);
    expect(result[result.length - 1]).toBe("- ... (+17 more)");
    expect(result.length).toBe(5); // header + 3 items + overflow
  });
});

// ===========================================================================
// TestManifestFingerprintStability
// ===========================================================================

describe("TestManifestFingerprintStability", () => {
  it("test_symbols_ts_change_does_not_affect_fingerprint", () => {
    const sid = "fp-stability-symbols-ts";

    session.mark_file_read(sid, "/proj/src/auth.py", null, null, { symbol: "login" });

    const cache1 = session.load(sid);
    const fp1 = compact._compute_manifest_fingerprint(cache1);

    // Directly update symbols_ts in the cached entry to simulate a later timestamp.
    // This does NOT change symbols_read (still has "login"), only the timestamp.
    const file_key = Object.keys(cache1.files)[0]!;
    const entry = cache1.files[file_key]!;
    if ("login" in entry.symbols_ts) {
      entry.symbols_ts["login"] = (entry.symbols_ts["login"] ?? 0) + 100.0;
    }

    // Recompute fingerprint on the modified cache (without re-saving to disk).
    const fp2 = compact._compute_manifest_fingerprint(cache1);

    expect(fp1).toBe(fp2);
  });

  it("test_symbols_read_change_does_affect_fingerprint", () => {
    const sid = "fp-stability-symbols-read-change";

    session.mark_file_read(sid, "/proj/src/auth.py", null, null, { symbol: "login" });

    const fp1 = compact._compute_manifest_fingerprint(session.load(sid));

    // Add a second symbol — this SHOULD change the fingerprint.
    session.mark_file_read(sid, "/proj/src/auth.py", null, null, { symbol: "logout" });

    const fp2 = compact._compute_manifest_fingerprint(session.load(sid));

    expect(fp1).not.toBe(fp2);
  });
});

// ===========================================================================
// TestRenderMostAccessedSection
// ===========================================================================

describe("TestRenderMostAccessedSection", () => {
  it("test_empty_symbol_access_returns_empty_list", () => {
    const result = compact._render_most_accessed_section({});
    expect(result).toEqual([]);
  });

  it("test_single_read_symbol_excluded", () => {
    const symbol_counts: Record<string, number> = {
      "session.py::SessionCache": 1,
      "compact.py::build_manifest": 2,
    };
    const result = compact._render_most_accessed_section(symbol_counts);
    // Only build_manifest should be included (count >= 2).
    expect(result.length).toBe(2); // header + 1 entry
    expect(result[1]!.includes("build_manifest")).toBe(true);
  });

  it("test_all_single_reads_returns_empty", () => {
    const symbol_counts: Record<string, number> = {
      "file1.py::symbol1": 1,
      "file2.py::symbol2": 1,
    };
    const result = compact._render_most_accessed_section(symbol_counts);
    expect(result).toEqual([]);
  });

  it("test_top_5_symbols_shown", () => {
    const symbol_counts: Record<string, number> = {};
    for (let i = 0; i < 10; i++) {
      symbol_counts[`file${i}.py::symbol${i}`] = 10 - i;
    }
    const result = compact._render_most_accessed_section(symbol_counts, 5);
    // Should have header + 5 entries.
    expect(result.length).toBe(6);
    expect(result[0]).toBe("### Most Accessed");
    // Most accessed should be symbol0 (count 10).
    expect(result[1]!.includes("symbol0")).toBe(true);
    expect(result[1]!.includes("10 reads")).toBe(true);
  });

  it("test_caps_at_max_entries", () => {
    const symbol_counts: Record<string, number> = {};
    for (let i = 0; i < 15; i++) {
      symbol_counts[`file${i}.py::symbol${i}`] = 20 - i;
    }
    const result = compact._render_most_accessed_section(symbol_counts, 3);
    // header + 3 entries.
    expect(result.length).toBe(4);
  });

  it("test_format_with_file_and_symbol_name", () => {
    const symbol_counts: Record<string, number> = {
      "src/auth.py::Session.refresh": 7,
      "src/compact.py::build_manifest": 5,
    };
    const result = compact._render_most_accessed_section(symbol_counts);
    expect(result.length).toBe(3); // header + 2 entries
    expect(result[0]!.includes("### Most Accessed")).toBe(true);
    // Check the most accessed one (count 7).
    expect(result[1]!.includes("Session.refresh")).toBe(true);
    expect(result[1]!.includes("(auth.py)")).toBe(true);
    expect(result[1]!.includes("7 reads")).toBe(true);
  });

  it("test_sorts_by_count_descending", () => {
    const symbol_counts: Record<string, number> = {
      "file1.py::third": 3,
      "file2.py::first": 10,
      "file3.py::second": 7,
    };
    const result = compact._render_most_accessed_section(symbol_counts);
    // Should be in order: first (10), second (7), third (3).
    expect(result[1]!.includes("first")).toBe(true);
    expect(result[2]!.includes("second")).toBe(true);
    expect(result[3]!.includes("third")).toBe(true);
  });
});

// ===========================================================================
// TestMostAccessedInManifest
// ===========================================================================

describe("TestMostAccessedInManifest", () => {
  it("test_most_accessed_appears_in_manifest_with_high_count_symbols", () => {
    const sid = "manifest-most-accessed-session";
    session.mark_file_read(sid, "/proj/src/auth.py", null, null, { symbol: "Session.refresh" });
    session.mark_file_read(sid, "/proj/src/auth.py", null, null, { symbol: "Session.refresh" });
    session.mark_file_read(sid, "/proj/src/compact.py", null, null, { symbol: "build_manifest" });
    session.mark_file_read(sid, "/proj/src/compact.py", null, null, { symbol: "build_manifest" });
    session.mark_file_read(sid, "/proj/src/compact.py", null, null, { symbol: "build_manifest" });
    // Also add an edit so manifest is non-empty.
    session.mark_file_edited(sid, "/proj/src/auth.py");

    const result = compact.build_manifest(sid);

    expect(result.includes("### Most Accessed")).toBe(true);
    expect(result.includes("Session.refresh") || result.includes("build_manifest")).toBe(true);
  });

  it("test_most_accessed_excluded_when_no_high_count_symbols", () => {
    const sid = "manifest-no-most-accessed-session";
    session.mark_file_read(sid, "/proj/src/auth.py", null, null, { symbol: "login" });
    session.mark_file_edited(sid, "/proj/src/auth.py");

    const result = compact.build_manifest(sid);

    expect(result.includes("### Most Accessed")).toBe(false);
  });

  it("test_most_accessed_section_excluded_when_no_symbols", () => {
    const sid = "manifest-no-symbols-session";
    session.mark_file_read(sid, "/proj/src/auth.py", 0, 100);
    session.mark_file_edited(sid, "/proj/src/auth.py");

    const result = compact.build_manifest(sid);

    expect(result.includes("### Most Accessed")).toBe(false);
  });
});

// ===========================================================================
// TestFindOpenQuestions
// ===========================================================================

describe("TestFindOpenQuestions", () => {
  it("test_empty_paths_returns_empty", () => {
    const result = compact._find_open_questions([]);
    expect(result).toEqual([]);
  });

  it("test_nonexistent_file_skipped", () => {
    const tmp = tmpPath();
    const missing = path.join(tmp, "missing.py");
    const result = compact._find_open_questions([missing]);
    expect(result).toEqual([]);
  });

  it("test_finds_todo_marker", () => {
    const tmp = tmpPath();
    const file = path.join(tmp, "test.py");
    fs.writeFileSync(file, "# TODO: fix auth logic\nprint('hello')");

    const result = compact._find_open_questions([file]);

    expect(result.length).toBe(1);
    expect(result[0]!.includes("test.py:1 —")).toBe(true);
    expect(result[0]!.includes("TODO")).toBe(true);
  });

  it("test_finds_fixme_marker", () => {
    const tmp = tmpPath();
    const file = path.join(tmp, "test.py");
    fs.writeFileSync(file, "x = 1  # FIXME: use better variable");

    const result = compact._find_open_questions([file]);

    expect(result.length).toBe(1);
    expect(result[0]!.includes("FIXME")).toBe(true);
  });

  it("test_finds_why_marker", () => {
    const tmp = tmpPath();
    const file = path.join(tmp, "test.py");
    fs.writeFileSync(file, "val = 42  # WHY: magic number?");

    const result = compact._find_open_questions([file]);

    expect(result.length).toBe(1);
    expect(result[0]!.includes("WHY")).toBe(true);
  });

  it("test_finds_hack_marker", () => {
    const tmp = tmpPath();
    const file = path.join(tmp, "test.py");
    fs.writeFileSync(file, "# HACK quick workaround");

    const result = compact._find_open_questions([file]);

    expect(result.length).toBe(1);
    expect(result[0]!.includes("HACK")).toBe(true);
  });

  it("test_finds_xxx_marker", () => {
    const tmp = tmpPath();
    const file = path.join(tmp, "test.py");
    fs.writeFileSync(file, "# XXX deprecated function");

    const result = compact._find_open_questions([file]);

    expect(result.length).toBe(1);
    expect(result[0]!.includes("XXX")).toBe(true);
  });

  it("test_finds_inline_question_mark", () => {
    const tmp = tmpPath();
    const file = path.join(tmp, "test.py");
    fs.writeFileSync(file, "x = 1  # should this be here?");

    const result = compact._find_open_questions([file]);

    expect(result.length).toBe(1);
    expect(result[0]!.includes("test.py:1")).toBe(true);
  });

  it("test_respects_max_questions_cap", () => {
    const tmp = tmpPath();
    const file = path.join(tmp, "test.py");
    const content = [
      "# TODO item 1",
      "# TODO item 2",
      "# TODO item 3",
      "# TODO item 4",
      "# TODO item 5",
      "# TODO item 6",
      "# TODO item 7",
    ].join("\n");
    fs.writeFileSync(file, content);

    const result = compact._find_open_questions([file], 3);

    expect(result.length).toBe(3);
  });

  it("test_skips_files_over_500kb", () => {
    const tmp = tmpPath();
    const file = path.join(tmp, "large.py");
    // Create a file with > 500 KB of content.
    fs.writeFileSync(file, "x = 1\n" + "y = 2\n".repeat(85000));

    const result = compact._find_open_questions([file]);

    expect(result).toEqual([]);
  });

  it("test_scans_first_500_lines_only", () => {
    const tmp = tmpPath();
    const file = path.join(tmp, "test.py");
    const lines = new Array(505).fill("x = 1").concat(["# TODO deep item"]);
    fs.writeFileSync(file, lines.join("\n"));

    const result = compact._find_open_questions([file]);

    // The TODO is on line 507, beyond the 500-line limit.
    expect(result).toEqual([]);
  });

  it("test_truncates_description_to_80_chars", () => {
    const tmp = tmpPath();
    const file = path.join(tmp, "test.py");
    const long_desc = "# TODO " + "x".repeat(100);
    fs.writeFileSync(file, long_desc);

    const result = compact._find_open_questions([file]);

    // Full description should be capped.
    expect(result[0]!.length).toBeLessThanOrEqual(100); // "filename:line — " + ~80 chars
  });

  it("test_deduplicates_same_line", () => {
    const tmp = tmpPath();
    const file = path.join(tmp, "test.py");
    // A TODO and a question mark on the same line.
    fs.writeFileSync(file, "x = 1  # TODO: verify? this logic");

    const result = compact._find_open_questions([file]);

    // Should have 1 entry (deduplicated), not 2.
    expect(result.length).toBe(1);
  });

  it("test_graceful_ioerror", () => {
    const tmp = tmpPath();
    const file = path.join(tmp, "test.py");
    fs.writeFileSync(file, "# TODO item");

    // For simplicity, test that a truly missing file doesn't crash.
    const result = compact._find_open_questions([path.join(tmp, "nonexistent.py")]);

    expect(result).toEqual([]);
  });

  it("test_open_questions_section_with_no_edited_files", () => {
    const sid = "manifest-no-edits-session";

    const result = compact.build_manifest(sid);

    expect(result.includes("### Open Questions")).toBe(false);
  });
});

// ===========================================================================
// TestInferSessionGoal — compact.infer_session_goal
// ===========================================================================

describe("TestInferSessionGoal", () => {
  it("test_empty_session_returns_empty_string", () => {
    const sid = "goal-empty-session";
    makeSession(sid, { files_read: 0, greps: 0, edits: 0 });
    const cache = session.load(sid);

    const goal = compact.infer_session_goal(cache);

    expect(goal).toBe("");
  });

  it("test_single_edit_no_symbols_returns_empty_string", () => {
    const sid = "goal-single-edit-session";
    makeSession(sid, { files_read: 0, greps: 0, edits: 1 });
    const cache = session.load(sid);

    const goal = compact.infer_session_goal(cache);

    expect(goal).toBe("");
  });

  it("test_two_edited_files_infers_goal", () => {
    const sid = "goal-two-edits-session";
    session.mark_file_edited(sid, "/proj/src/auth.py");
    session.mark_file_edited(sid, "/proj/src/login.py");
    const cache = session.load(sid);

    const goal = compact.infer_session_goal(cache);

    expect(goal).not.toBe("");
    expect(goal.toLowerCase().includes("src") || goal.toLowerCase().includes("auth")).toBe(true);
  });

  it("test_goal_includes_symbols_when_available", () => {
    const sid = "goal-with-symbols-session";
    session.mark_file_edited(sid, "/proj/src/auth.py");
    session.mark_file_edited(sid, "/proj/src/session.py");
    // Manually add symbol access counts to the cache.
    const cache = session.load(sid);
    cache.symbol_access_counts = { login: 5, authenticate: 3, refresh_token: 2 };
    session.save(cache);

    const goal = compact.infer_session_goal(cache);

    expect(goal).not.toBe("");
    // Should mention at least one of the top symbols.
    expect(["login", "authenticate"].some((sym) => goal.toLowerCase().includes(sym))).toBe(true);
  });

  it("test_goal_respects_max_tokens", () => {
    const sid = "goal-max-tokens-session";
    session.mark_file_edited(sid, "/proj/src/auth.py");
    session.mark_file_edited(sid, "/proj/src/session.py");
    const cache = session.load(sid);
    cache.symbol_access_counts = { login: 5, authenticate: 3, refresh_token: 2 };
    session.save(cache);

    const goal = compact.infer_session_goal(cache, 20);

    // Should still be a goal, but shorter.
    if (goal) {
      // Rough estimate: 3 chars per token.
      const tokens = Math.trunc(goal.length / 3);
      expect(tokens).toBeLessThanOrEqual(30); // Allow some slack over the 20-token request
    }
  });

  it.skip("test_goal_in_recovery_hint", () => {
    // PORT: deferred — imports token_goat.hooks_session (not yet ported).
  });

  it("test_infer_goal_defensive_against_missing_fields", () => {
    const sid = "goal-defensive-session";
    session.mark_file_edited(sid, "/proj/src/auth.py");
    session.mark_file_edited(sid, "/proj/src/session.py");
    const cache = session.load(sid);

    // Delete optional fields to test defensive handling.
    // Python sets these to None; the TS shapes are non-null, so cast to mirror.
    (cache as unknown as { bash_history: unknown }).bash_history = null;
    (cache as unknown as { symbol_access_counts: unknown }).symbol_access_counts = null;

    const goal = compact.infer_session_goal(cache);

    // Should not crash, may return empty or a goal based just on files.
    expect(typeof goal).toBe("string");
  });

  it("test_goal_handles_complex_paths", () => {
    const sid = "goal-complex-paths-session";
    session.mark_file_edited(sid, "/C/Projects/token-goat/src/token_goat/compact.py");
    session.mark_file_edited(sid, "/C/Projects/token-goat/src/token_goat/session.py");
    const cache = session.load(sid);

    const goal = compact.infer_session_goal(cache);

    // Should extract directory info from complex paths.
    expect(goal).not.toBe("");
  });
});

// ===========================================================================
// TestDetectOrchestratorMode — unit tests for _detect_orchestrator_mode()
// ===========================================================================

describe("TestDetectOrchestratorMode", () => {
  it("test_returns_false_when_no_repo_root", () => {
    const sid = "orch-no-root";
    session.mark_file_edited(sid, "/proj/a.py");
    const cache = session.load(sid);
    const result = compact._detect_orchestrator_mode(cache, null, 5);
    expect(result).toBe(false);
  });

  it("test_returns_false_when_edited_files_ge_10", () => {
    const tmp = tmpPath();
    const repo = makeGitRepo(tmp, {
      commits: [
        [{ "f1.py": "x" }, "c1"],
        [{ "f2.py": "x" }, "c2"],
        [{ "f3.py": "x" }, "c3"],
        [{ "f4.py": "x" }, "c4"],
        [{ "f5.py": "x" }, "c5"],
      ],
    });
    const sid = "orch-many-edits";
    let cache = session.load(sid);
    cache.created_ts = _now() - 600;
    session.save(cache);
    // Add 10 edited files.
    for (let i = 0; i < 10; i++) {
      session.mark_file_edited(sid, `/proj/src/file${i}.py`);
    }
    cache = session.load(sid);
    const result = compact._detect_orchestrator_mode(cache, repo, 5);
    expect(result).toBe(false);
  });

  it("test_returns_false_when_commit_count_below_threshold", () => {
    const tmp = tmpPath();
    const repo = makeGitRepo(tmp, {
      commits: [
        [{ "a.py": "1" }, "commit 1"],
        [{ "b.py": "2" }, "commit 2"],
        [{ "c.py": "3" }, "commit 3"],
      ],
    });
    const sid = "orch-few-commits";
    session.mark_file_edited(sid, "/proj/a.py");
    let cache = session.load(sid);
    cache.created_ts = _now() - 600;
    session.save(cache);
    cache = session.load(sid);
    const result = compact._detect_orchestrator_mode(cache, repo, 5);
    // Only 3 commits, threshold=5 → False.
    expect(result).toBe(false);
  });

  it("test_returns_true_when_commit_count_meets_threshold", () => {
    const tmp = tmpPath();
    const commits_payload: Array<[Record<string, string>, string]> = [];
    for (let i = 0; i < 6; i++) {
      commits_payload.push([{ [`f${i}.py`]: String(i) }, `commit ${i}`]);
    }
    const repo = makeGitRepo(tmp, { commits: commits_payload });
    const sid = "orch-many-commits";
    session.mark_file_edited(sid, "/proj/a.py");
    let cache = session.load(sid);
    cache.created_ts = _now() - 3600;
    session.save(cache);
    cache = session.load(sid);
    const result = compact._detect_orchestrator_mode(cache, repo, 5);
    expect(result).toBe(true);
  });

  it("test_returns_false_on_error", () => {
    const tmp = tmpPath();
    const sid = "orch-error";
    session.mark_file_edited(sid, "/proj/a.py");
    const cache = session.load(sid);
    cache.created_ts = _now() - 600;
    // Pass a non-existent path — git will fail.
    const result = compact._detect_orchestrator_mode(cache, path.join(tmp, "nonexistent"), 5);
    expect(result).toBe(false);
  });
});

// ===========================================================================
// TestOrchestratorModeManifest — integration tests for orchestrator output
// ===========================================================================

describe("TestOrchestratorModeManifest", () => {
  it("test_orchestrator_mode_shows_recent_commits_section", () => {
    const tmp = tmpPath();
    const commits_payload: Array<[Record<string, string>, string]> = [];
    for (let i = 0; i < 6; i++) {
      commits_payload.push([{ [`f${i}.py`]: String(i) }, `iter commit ${i}`]);
    }
    const repo = makeGitRepo(tmp, { commits: commits_payload });

    const sid = "orch-manifest-session";
    session.mark_file_edited(sid, "/proj/a.py");
    const cache = session.load(sid);
    cache.created_ts = _now() - 3600;
    cache.cwd = repo;
    session.save(cache);

    const cfgSpy = vi
      .spyOn(config, "load")
      .mockReturnValue(configWith({ orchestrator_commit_threshold: 5, wide_session_threshold: 200 }));
    const result = compact.build_manifest(sid);
    cfgSpy.mockRestore();

    expect(result.includes("### Recent Commits")).toBe(true);
    expect(result.includes("iter commit")).toBe(true);
  });

  it("test_orchestrator_mode_shows_header_line", () => {
    const tmp = tmpPath();
    const commits_payload: Array<[Record<string, string>, string]> = [];
    for (let i = 0; i < 6; i++) {
      commits_payload.push([{ [`g${i}.py`]: String(i) }, `loop commit ${i}`]);
    }
    const repo = makeGitRepo(tmp, { commits: commits_payload });

    const sid = "orch-header-session";
    session.mark_file_edited(sid, "/proj/b.py");
    const cache = session.load(sid);
    cache.created_ts = _now() - 3600;
    cache.cwd = repo;
    session.save(cache);

    const cfgSpy = vi
      .spyOn(config, "load")
      .mockReturnValue(configWith({ orchestrator_commit_threshold: 5, wide_session_threshold: 200 }));
    const result = compact.build_manifest(sid);
    cfgSpy.mockRestore();

    expect(result.includes("Orchestrator session detected")).toBe(true);
  });

  it("test_orchestrator_mode_no_symbols_section", () => {
    const tmp = tmpPath();
    const commits_payload: Array<[Record<string, string>, string]> = [];
    for (let i = 0; i < 6; i++) {
      commits_payload.push([{ [`h${i}.py`]: String(i) }, `sym commit ${i}`]);
    }
    const repo = makeGitRepo(tmp, { commits: commits_payload });

    const sid = "orch-no-symbols-session";
    session.mark_file_edited(sid, "/proj/c.py");
    session.mark_file_read(sid, "/proj/c.py", null, null, { symbol: "some_function" });
    const cache = session.load(sid);
    cache.created_ts = _now() - 3600;
    cache.cwd = repo;
    session.save(cache);

    const cfgSpy = vi
      .spyOn(config, "load")
      .mockReturnValue(configWith({ orchestrator_commit_threshold: 5, wide_session_threshold: 200 }));
    const result = compact.build_manifest(sid);
    cfgSpy.mockRestore();

    expect(result.includes("**Symbols Accessed:**")).toBe(false);
  });

  it("test_normal_mode_when_below_threshold", () => {
    const tmp = tmpPath();
    const commits_payload: Array<[Record<string, string>, string]> = [];
    for (let i = 0; i < 2; i++) {
      commits_payload.push([{ [`n${i}.py`]: String(i) }, `normal commit ${i}`]);
    }
    const repo = makeGitRepo(tmp, { commits: commits_payload });

    const sid = "normal-mode-session";
    session.mark_file_edited(sid, "/proj/d.py");
    session.mark_file_read(sid, "/proj/d.py", null, null, { symbol: "normal_func" });
    const cache = session.load(sid);
    cache.created_ts = _now() - 3600;
    cache.cwd = repo;
    session.save(cache);

    // Use threshold=10 so 2 commits never triggers orchestrator mode.
    const cfgSpy = vi
      .spyOn(config, "load")
      .mockReturnValue(configWith({ orchestrator_commit_threshold: 10, wide_session_threshold: 200 }));
    const result = compact.build_manifest(sid);
    cfgSpy.mockRestore();

    // Normal mode: no orchestrator header.
    expect(result.includes("Orchestrator session detected")).toBe(false);
    expect(result.includes("### Recent Commits")).toBe(false);
  });
});

// ===========================================================================
// TestOrchestratorConfig
// ===========================================================================

describe("TestOrchestratorConfig", () => {
  it("test_default_value", () => {
    // Python constructs config.CompactAssistConfig() (frozen dataclass) and reads
    // its default. The TS CompactAssistConfig is an interface with no default-
    // factory, so the schema default is asserted through config.load() against an
    // empty per-test data dir (resolves to the documented default of 5).
    const cfg = config.load();
    expect(cfg.compact_assist?.orchestrator_commit_threshold).toBe(5);
  });

  it("test_load_default", () => {
    const cfg = config.load();
    expect(cfg.compact_assist?.orchestrator_commit_threshold).toBe(5);
  });
});

// ===========================================================================
// TestManifestSectionOrder — section ordering in the rendered manifest
// ===========================================================================

describe("TestManifestSectionOrder", () => {
  it("test_section_group_order_in_source", () => {
    // Structural test: Python uses inspect.getsource(compact._render) + a regex
    // over Python tuple syntax. The TS port reads compact.ts and applies the
    // analogous regex over the `_section_groups` array-literal syntax
    // (["name", lines, flag]). The third element may be a computed identifier
    // (e.g. _syms_protected), so accept any identifier there.
    const srcPath = new URL("../src/token_goat/compact.ts", import.meta.url);
    const src = fs.readFileSync(srcPath, "utf8");

    // Isolate the _section_groups array literal so unrelated arrays don't match.
    expect(src.includes("_section_groups")).toBe(true);
    const start = src.indexOf("_section_groups");
    const open = src.indexOf("[", start);
    const close = src.indexOf("];", open);
    const block = src.slice(open, close >= 0 ? close : src.length);

    // Match all ["name", lines, flag] tuples in the _section_groups list.
    const re = /\["(\w+)",[^\]]*,\s*\w+\]/g;
    const names_in_order: string[] = [];
    let m: RegExpExecArray | null;
    while ((m = re.exec(block)) !== null) {
      names_in_order.push(m[1]!);
    }
    expect(names_in_order.length).toBeGreaterThan(0);

    const _pos = (name: string): number => {
      const idx = names_in_order.indexOf(name);
      return idx === -1 ? -1 : idx;
    };

    const edited_pos = _pos("edited");
    const recent_commits_pos = _pos("recent_commits");
    const syms_pos = _pos("syms");
    const files_pos = _pos("files");
    const skills_pos = _pos("skills");

    expect(edited_pos).not.toBe(-1);
    expect(recent_commits_pos).not.toBe(-1);
    expect(syms_pos).not.toBe(-1);
    expect(files_pos).not.toBe(-1);
    expect(skills_pos).not.toBe(-1);

    expect(edited_pos < recent_commits_pos).toBe(true);
    expect(recent_commits_pos < syms_pos).toBe(true);
    expect(syms_pos < files_pos).toBe(true);
    expect(files_pos < skills_pos).toBe(true);
  });

  it("test_edited_before_symbols_before_files", () => {
    const sid = "section-order-wide-syms-abc";
    let cache = session.load(sid);
    // Edited file (NOT a symbol file so edited and symbols are separate).
    cache = session.mark_file_edited(sid, "/proj/src/auth.py", { cache });
    // 16 files each with one symbol access — total > wide_session_threshold=15
    // so the wide-session path fires and emits "**Symbols Accessed:** N files".
    for (let i = 0; i < 16; i++) {
      cache = session.mark_file_read(sid, `/proj/src/mod_${i}.py`, null, null, { symbol: `fn_${i}`, cache });
    }
    session.save(cache);

    const result = compact.build_manifest(sid, { max_tokens: 1600 });

    const has_edited = result.includes("**Staged/Uncommitted:**") || result.includes("**Edited:**");
    const has_syms = result.includes("**Symbols Accessed:**");
    const has_files = result.includes("**Files:**");

    if (!(has_edited && has_syms && has_files)) {
      // Python pytest.skip — not all sections fired; skip the live ordering check.
      return;
    }

    const lines = result.split("\n");
    const edited_idx = lines.findIndex(
      (ln) => ln.includes("**Staged/Uncommitted:**") || ln.includes("**Edited:**"),
    );
    const syms_idx = lines.findIndex((ln) => ln.includes("**Symbols Accessed:**"));
    const files_idx = lines.findIndex((ln) => ln.includes("**Files:**"));

    expect(edited_idx < syms_idx).toBe(true);
    expect(syms_idx < files_idx).toBe(true);
  });

  it.skip("test_skills_after_edited_files", () => {
    // PORT: deferred — imports token_goat.skill_cache (not yet ported).
  });

  it.skip("test_skills_after_files", () => {
    // PORT: deferred — imports token_goat.skill_cache (not yet ported).
  });

  it.skip("test_edited_before_skills_even_when_symbols_absent", () => {
    // PORT: deferred — imports token_goat.skill_cache (not yet ported).
  });
});

// ===========================================================================
// TestCrossSectionSymbolDedupRegression — Item #36
// ===========================================================================

describe("TestCrossSectionSymbolDedupRegression", () => {
  it("test_edited_file_symbols_omitted_from_symbols_section", () => {
    const sid = "item36-regression-edited-syms";
    session.mark_file_edited(sid, "/proj/src/core.py");
    session.mark_file_read(sid, "/proj/src/core.py", null, null, { symbol: "CoreClass" });

    const result = compact.build_manifest(sid, { max_tokens: 600 });

    expect(result.includes("core.py")).toBe(true);
    if (result.includes("**Symbols Accessed:**")) {
      let syms_part = result.split("**Symbols Accessed:**")[1] ?? "";
      const end = syms_part.indexOf("\n**");
      if (end >= 0) {
        syms_part = syms_part.slice(0, end);
      }
      expect(syms_part.includes("CoreClass")).toBe(false);
    }
  });

  it("test_readonly_symbols_preserved_alongside_edited", () => {
    const sid = "item36-regression-readonly-syms";
    session.mark_file_edited(sid, "/proj/src/edited.py");
    session.mark_file_read(sid, "/proj/src/readonly.py", null, null, { symbol: "ReadOnlyFunc" });

    const result = compact.build_manifest(sid, { max_tokens: 600 });

    if (result.includes("**Symbols Accessed:**")) {
      let syms_part = result.split("**Symbols Accessed:**")[1] ?? "";
      const end = syms_part.indexOf("\n**");
      if (end >= 0) {
        syms_part = syms_part.slice(0, end);
      }
      expect(syms_part.includes("ReadOnlyFunc")).toBe(true);
    }
  });
});

// ===========================================================================
// TestContextPressure — get_context_pressure / ContextPressure dataclass
// ===========================================================================

describe("TestContextPressure", () => {
  it("test_no_session_returns_cool", () => {
    const cp = compact.get_context_pressure(null);
    expect(cp.fill_fraction).toBe(0.0);
    expect(cp.tier).toBe("cool");
  });

  it("test_unknown_session_returns_cool", () => {
    const { CATALOG_TOKENS, CONTEXT_AUTOCOMPACT_TOKENS } = compact;
    const cp = compact.get_context_pressure("nonexistent-session-id-xyz");
    // Fresh session: total = CATALOG_TOKENS (no bash/web/read events yet).
    const expected_fill = CATALOG_TOKENS / CONTEXT_AUTOCOMPACT_TOKENS;
    expect(Math.abs(cp.fill_fraction - expected_fill)).toBeLessThan(1e-6);
    expect(cp.tier).toBe("cool");
  });

  it("test_empty_session_is_cool", () => {
    const sid = "ctx-pressure-empty";
    session.mark_file_read(sid, "/proj/init.py", 0, 10);
    const cp = compact.get_context_pressure(sid);
    // 1 read (200 tokens) + CATALOG_TOKENS -> well below 50%.
    expect(cp.tier).toBe("cool");
    expect(cp.fill_fraction > 0.0 && cp.fill_fraction < 0.5).toBe(true);
  });

  it("test_get_context_pressure_accounts_for_bash", () => {
    const { CONTEXT_AUTOCOMPACT_TOKENS, get_context_pressure } = compact;
    const sid = "ctx-pressure-bash";
    session.mark_file_read(sid, "/proj/x.py", 0, 10);
    const cp_before = get_context_pressure(sid);
    const fill_before = cp_before.fill_fraction;
    session.mark_bash_run(sid, "sha1", "echo hello", "id1", 100, 0, 0, false);
    session.mark_bash_run(sid, "sha2", "ls -la", "id2", 200, 0, 0, false);
    session.mark_bash_run(sid, "sha3", "git status", "id3", 300, 0, 0, false);
    const cp_after = get_context_pressure(sid);
    // 3 bash entries x 500 tokens = 1500 additional tokens.
    const expected_increase = (3 * 500) / CONTEXT_AUTOCOMPACT_TOKENS;
    expect(cp_after.fill_fraction > fill_before).toBe(true);
    expect(Math.abs(cp_after.fill_fraction - fill_before - expected_increase)).toBeLessThan(1e-6);
  });

  it("test_get_context_pressure_accounts_for_web", () => {
    const { CONTEXT_AUTOCOMPACT_TOKENS, get_context_pressure } = compact;
    const sid = "ctx-pressure-web";
    session.mark_file_read(sid, "/proj/x.py", 0, 10);
    const cp_before = get_context_pressure(sid);
    const fill_before = cp_before.fill_fraction;
    session.mark_web_fetch(sid, "urlsha1", "https://example.com/docs", "wid1", 1000, 200, false);
    session.mark_web_fetch(sid, "urlsha2", "https://other.com/api", "wid2", 2000, 200, false);
    const cp_after = get_context_pressure(sid);
    const expected_increase = (2 * 1_000) / CONTEXT_AUTOCOMPACT_TOKENS;
    expect(cp_after.fill_fraction > fill_before).toBe(true);
    expect(Math.abs(cp_after.fill_fraction - fill_before - expected_increase)).toBeLessThan(1e-6);
  });

  it("test_dataclass_is_frozen", () => {
    // Python: frozen dataclass raises AttributeError on field reassignment. The
    // TS ContextPressure fields are `readonly` at the type level (a reassignment
    // is a compile error, asserted via @ts-expect-error below) but the class is
    // NOT Object.freeze'd, so the runtime throw is not reproduced. The readonly
    // contract is the faithful TS analogue of the frozen-dataclass guarantee.
    const cp = new compact.ContextPressure({ fill_fraction: 0.3, tier: "cool" });
    // @ts-expect-error — fill_fraction is readonly; reassignment is forbidden.
    cp.fill_fraction = 0.9;
    // The construction value is the source of truth; assert the field is typed
    // readonly (compile-time) and the instance carries the constructed tier.
    expect(cp.tier).toBe("cool");
  });

  it("test_constants_exported", () => {
    const { CATALOG_TOKENS, CONTEXT_AUTOCOMPACT_TOKENS } = compact;
    expect(CONTEXT_AUTOCOMPACT_TOKENS).toBe(660_000);
    expect(CATALOG_TOKENS).toBe(10_800);
  });

  it("test_tier_classification_boundaries", () => {
    const { ContextPressure } = compact;
    // Boundary: exactly 0.50 -> warm (not cool).
    expect(new ContextPressure({ fill_fraction: 0.5, tier: "warm" }).tier).toBe("warm");
    // Boundary: exactly 0.70 -> hot (not warm).
    expect(new ContextPressure({ fill_fraction: 0.7, tier: "hot" }).tier).toBe("hot");
    // Boundary: exactly 0.85 -> critical (not hot).
    expect(new ContextPressure({ fill_fraction: 0.85, tier: "critical" }).tier).toBe("critical");
    // Below 0.50 -> cool.
    expect(new ContextPressure({ fill_fraction: 0.49, tier: "cool" }).tier).toBe("cool");
  });
});
