/**
 * 1:1 port of tests/test_compact.py part 5/6 — classes TestHumanizeBytes
 * through TestManifestDelta (Python lines ~6159-7524). Each Python `class
 * Test*` maps to a `describe(...)`; each `def test_*` maps to an `it()` with
 * the SAME name + assertion polarity.
 *
 * Per-test tmp data dir + module-cache clearing is handled by tests/setup.ts
 * (beforeEach -> setDataDirOverride + clearModuleCaches), the analogue of the
 * Python `tmp_data_dir` autouse fixture. Files/manifests/sessions resolve under
 * the data dir via paths.ts, overridden per test there.
 *
 * Fixture mapping (Python -> TS):
 *   - tmp_data_dir         -> setup.ts beforeEach (no inline helper needed).
 *   - make_session(...)    -> the inline `make_session(sid, opts)` helper below,
 *                             a faithful port of conftest._make_session.
 *   - monkeypatch.setattr(compact, "f", g)  -> vi.spyOn(compact, "f").mockImplementation(g).
 *   - _clear_process_guard(sid)  -> compact._manifest_sha_written_this_process.delete(sid)
 *                                   (the Python helper is exactly
 *                                   compact._manifest_sha_written_this_process.discard(sid)).
 *
 * compact._humanize_bytes is the SAME object as util._humanizeBytes (compact.ts
 * re-exports `_humanize_bytes`), so the re-export identity test compares them.
 *
 * Deferred tests: those that import `token_goat.skill_cache` (store_output /
 * write_sidecar). skill_cache.ts is NOT yet ported, so they are it.skip with a
 * PORT note, matching the convention for tests depending on an unported module.
 */
import fs from "node:fs";

import { describe, expect, it, vi, afterEach } from "vitest";

import * as compact from "../src/token_goat/compact.js";
import * as session from "../src/token_goat/session.js";
import * as config from "../src/token_goat/config.js";
import * as paths from "../src/token_goat/paths.js";
import { _humanizeBytes } from "../src/token_goat/util.js";
import { FileEntry } from "../src/token_goat/session.js";

afterEach(() => {
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Faithful port of conftest._make_session: create + populate a SessionCache,
 * optionally backdating created_ts and recording reads/greps/edits/web/bash.
 *
 * Python signature:
 *   make_session(sid, *, age_seconds=0, files_read=0, greps=0, edits=0,
 *                web_fetches=None, bash_runs=None)
 * web_fetches: {url: body_bytes}; bash_runs: {cmd: (output_bytes, exit_code)}.
 *
 * The Python helper hashes urls/cmds via hashlib/bash_cache; here we use a
 * trivial index-based sha (the manifest tests assert on rendered labels, never
 * on the exact sha), keeping each url/cmd a distinct history key.
 */
function make_session(
  sid: string,
  opts: {
    age_seconds?: number;
    files_read?: number;
    greps?: number;
    edits?: number;
    web_fetches?: Record<string, number>;
    bash_runs?: Record<string, [number, number]>;
  } = {},
): void {
  const age_seconds = opts.age_seconds ?? 0.0;
  const files_read = opts.files_read ?? 0;
  const greps = opts.greps ?? 0;
  const edits = opts.edits ?? 0;
  const web_fetches = opts.web_fetches ?? null;
  const bash_runs = opts.bash_runs ?? null;

  const cache = session.load(sid);
  if (age_seconds > 0) {
    cache.created_ts = Date.now() / 1000 - age_seconds;
    session.save(cache);
  }

  for (let i = 0; i < files_read; i++) {
    session.mark_file_read(sid, `/proj/src/file${i}.py`, 0, 100);
  }
  for (let i = 0; i < greps; i++) {
    session.mark_grep(sid, `pattern${i}`, "/proj/src");
  }
  for (let i = 0; i < edits; i++) {
    session.mark_file_edited(sid, `/proj/src/edited${i}.py`);
  }

  if (web_fetches) {
    let idx = 0;
    for (const [url, body_bytes] of Object.entries(web_fetches)) {
      const url_sha = `web${idx++}`;
      session.mark_web_fetch(sid, url_sha, url.slice(0, 200), `web-${url_sha}`, body_bytes, 200, false);
    }
  }

  if (bash_runs) {
    let idx = 0;
    for (const [cmd, tuple] of Object.entries(bash_runs)) {
      const [output_bytes, exit_code] = tuple;
      const cmd_sha = `cmd${idx++}`;
      session.mark_bash_run(sid, cmd_sha, cmd, `out-${cmd_sha}`, output_bytes, 0, exit_code, false);
    }
  }
}

/** _clear_process_guard(sid): compact._manifest_sha_written_this_process.discard(sid). */
function _clear_process_guard(sid: string): void {
  compact._manifest_sha_written_this_process.delete(sid);
}

// ---------------------------------------------------------------------------
// _humanize_bytes (canonical helper in util, re-exported via compact)
// ---------------------------------------------------------------------------

describe("TestHumanizeBytes", () => {
  it("test_bytes_below_1024", () => {
    expect(_humanizeBytes(0)).toBe("0B");
    expect(_humanizeBytes(512)).toBe("512B");
    expect(_humanizeBytes(1023)).toBe("1023B");
  });

  it("test_kilobytes", () => {
    expect(_humanizeBytes(1024)).toBe("1.0KB");
    expect(_humanizeBytes(2048)).toBe("2.0KB");
    expect(_humanizeBytes(1536)).toBe("1.5KB");
  });

  it("test_megabytes", () => {
    const mb = 1024 * 1024;
    expect(_humanizeBytes(mb)).toBe("1.0MB");
    expect(_humanizeBytes(mb * 2)).toBe("2.0MB");
  });

  it("test_gigabytes", () => {
    const gb = 1024 * 1024 * 1024;
    expect(_humanizeBytes(gb)).toBe("1.0GB");
    expect(_humanizeBytes(gb * 3)).toBe("3.0GB");
  });

  it("test_compact_re_export", () => {
    // compact._humanize_bytes must resolve to the same object as util._humanizeBytes.
    expect(compact._humanize_bytes).toBe(_humanizeBytes);
  });
});

// ---------------------------------------------------------------------------
// Bold inline section labels (**X:**) instead of ### H3 headers.
//
// NOTE: Python lines ~6196-6285 are a class body whose `class ...:` header line
// was elided in the source (the docstring + tests hang under TestHumanizeBytes's
// trailing region). The tests below mirror those `def test_*` faithfully under a
// dedicated describe so each retains its 1:1 name + polarity.
// ---------------------------------------------------------------------------

describe("TestBoldSectionLabels", () => {
  it("test_edited_section_uses_bold_label", () => {
    const sid = "bold-edited-abc";
    session.mark_file_edited(sid, "src/foo.py");
    const result = compact.build_manifest(sid);
    // Uncommitted edits show as Staged/Uncommitted; committed show as Edited
    expect(result.includes("**Staged/Uncommitted:**") || result.includes("**Edited:**")).toBe(true);
    expect(result.includes("### Files Edited")).toBe(false);
  });

  it("test_syms_section_uses_bold_label", () => {
    const sid = "bold-syms-abc";
    // Read symbols from a read-only file (not edited)
    session.mark_file_read(sid, "src/foo.py", null, null, { symbol: "my_func" });
    // Edit a different file so the manifest is non-empty
    session.mark_file_edited(sid, "src/bar.py");
    const result = compact.build_manifest(sid);
    if (result.includes("Symbols Accessed")) {
      expect(result.includes("**Symbols Accessed:**")).toBe(true);
      expect(result.includes("### Symbols Accessed")).toBe(false);
    }
  });

  it("test_ran_section_uses_bold_label", () => {
    const sid = "bold-ran-abc";
    make_session(sid, { age_seconds: 7200, edits: 1, bash_runs: { "pytest tests/": [12_000, 0] } });
    const result = compact.build_manifest(sid);
    expect(result.includes("**Recent Commands:**")).toBe(true);
    expect(result.includes("### Commands Run")).toBe(false);
  });

  it("test_grep_section_uses_bold_label", () => {
    const sid = "bold-grep-abc";
    session.mark_file_edited(sid, "src/foo.py");
    session.mark_grep(sid, "my_pattern", "/proj/src");
    session.mark_grep(sid, "another_pattern", "/proj/src");
    const result = compact.build_manifest(sid);
    expect(result.includes("**Patterns Searched:**")).toBe(true);
    expect(result.includes("### Patterns Searched")).toBe(false);
  });

  it("test_web_section_uses_bold_label", () => {
    const sid = "bold-web-abc";
    make_session(sid, {
      age_seconds: 7200,
      edits: 1,
      web_fetches: { "https://docs.example.com/api": 12_000 },
    });
    const result = compact.build_manifest(sid);
    expect(result.includes("**Web Fetches:**")).toBe(true);
    expect(result.includes("### Web Fetches")).toBe(false);
  });

  it("test_files_section_uses_bold_label", () => {
    const sid = "bold-files-abc";
    session.mark_file_edited(sid, "src/foo.py");
    session.mark_file_read(sid, "src/bar.py", 0, 50);
    const result = compact.build_manifest(sid);
    expect(result.includes("**Files:**")).toBe(true);
    expect(result.includes("### Key Files Read")).toBe(false);
  });

  it("test_blocked_section_uses_bold_label", () => {
    const sid = "bold-blocked-abc";
    make_session(sid, { age_seconds: 7200, edits: 1, bash_runs: { "pytest tests/": [12_000, 1] } });
    const result = compact.build_manifest(sid);
    expect(result.includes("**Blocked:**")).toBe(true);
    expect(result.includes("### Current Blockers")).toBe(false);
  });

  it("test_no_h3_headers_in_manifest", () => {
    // No ### H3 section headers except ### MUST_PRESERVE and the top-level ##.
    const sid = "bold-no-h3-abc";
    make_session(sid, { age_seconds: 7200, edits: 1, bash_runs: { "pytest tests/": [12_000, 0] } });
    session.mark_file_read(sid, "src/foo.py", 0, 50);
    const result = compact.build_manifest(sid);
    const h3_lines = result.split("\n").filter((ln) => ln.startsWith("### "));
    // Only ### MUST_PRESERVE and ### Compact Directives are allowed
    const allowed_h3 = new Set(["### MUST_PRESERVE", "### Compact Directives"]);
    const unexpected = h3_lines.filter((ln) => !allowed_h3.has(ln));
    expect(unexpected).toEqual([]);
  });

  // PORT: deferred — depends on token_goat.skill_cache (store_output /
  // write_sidecar); skill_cache.ts is not ported at this layer.
  it.skip("test_skills_section_uses_bold_label", () => {
    // **Skills:** label is emitted when a skill is recorded.
  });
});

// ---------------------------------------------------------------------------
// Item 11 — Order-preserving symbol dedup with (+N dupes removed) annotation
// ---------------------------------------------------------------------------

describe("TestSymbolDedup", () => {
  it("test_dedup_removes_duplicates", () => {
    const sid = "dedup-basic-abc";
    // Read the same symbol 4 times — should appear once
    for (let i = 0; i < 4; i++) {
      session.mark_file_read(sid, "src/foo.py", null, null, { symbol: "my_func" });
    }
    session.mark_file_edited(sid, "src/foo.py");
    const result = compact.build_manifest(sid);
    // my_func should appear at most twice (once in Syms, possibly once in Edited)
    const count = result.split("my_func").length - 1;
    expect(count).toBeLessThanOrEqual(2);
  });

  it("test_dedup_preserves_order", () => {
    const sid = "dedup-order-abc";
    session.mark_file_read(sid, "src/foo.py", null, null, { symbol: "alpha_func" });
    session.mark_file_read(sid, "src/foo.py", null, null, { symbol: "beta_func" });
    session.mark_file_read(sid, "src/foo.py", null, null, { symbol: "alpha_func" }); // dupe
    session.mark_file_read(sid, "src/foo.py", null, null, { symbol: "gamma_func" });
    session.mark_file_edited(sid, "src/foo.py");
    const result = compact.build_manifest(sid);
    // All three symbols must survive the dedup pass (only one copy each).
    if (result.includes("**Symbols Accessed:**")) {
      const syms_section = result.split("**Symbols Accessed:**")[1]!.split("**")[0]!;
      expect(syms_section.split("alpha_func").length - 1).toBe(1);
      expect(syms_section.split("beta_func").length - 1).toBe(1);
      expect(syms_section.split("gamma_func").length - 1).toBe(1);
    }
  });

  it("test_dupe_annotation_appears_when_three_or_more_removed", () => {
    // Render-time dedup is a safety net for cross-file duplicates that bypass
    // session.mark_file_read (which already dedups at storage). We construct the
    // duplicate symbol list directly via the lower-level cache shape.
    // Item #36: Edited files are excluded from symbols section, so use a read-only file.
    const sid = "dedup-annotate-abc";
    let cache = session.load(sid);
    cache.files["src/foo.py"] = new FileEntry({
      rel_or_abs: "src/foo.py",
      last_read_ts: 0.0,
      read_count: 4,
      line_ranges: [],
      symbols_read: ["dup_func", "dup_func", "dup_func", "dup_func"],
    });
    // Add an edit to another file to make the manifest non-empty
    cache = session.mark_file_edited(sid, "src/bar.py", { cache });
    session.save(cache);

    const result = compact.build_manifest(sid);
    // Dedup annotation should appear for the read-only file with dupes
    if (result.includes("**Symbols Accessed:**")) {
      expect(result.includes("(+3 dupes)")).toBe(true);
    }
  });

  it("test_dupe_annotation_absent_when_fewer_than_three_removed", () => {
    const sid = "dedup-no-annotate-abc";
    // 2 reads → 1 dupe removed (< 3 threshold)
    session.mark_file_read(sid, "src/foo.py", null, null, { symbol: "unique_func" });
    session.mark_file_read(sid, "src/foo.py", null, null, { symbol: "unique_func" });
    session.mark_file_edited(sid, "src/foo.py");
    const result = compact.build_manifest(sid);
    expect(!result.includes("(+") || !result.includes("dupes)")).toBe(true);
  });

  it("test_no_dupes_no_annotation", () => {
    const sid = "dedup-clean-abc";
    session.mark_file_read(sid, "src/foo.py", null, null, { symbol: "func_a" });
    session.mark_file_read(sid, "src/foo.py", null, null, { symbol: "func_b" });
    session.mark_file_read(sid, "src/foo.py", null, null, { symbol: "func_c" });
    session.mark_file_edited(sid, "src/foo.py");
    const result = compact.build_manifest(sid);
    expect(!result.includes("(+") || !result.includes("dupes)")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Item 33 — Cross-file symbol deduplication and stale filtering
// ---------------------------------------------------------------------------

describe("TestCrossFileSymbolDedup", () => {
  it("test_cross_file_symbol_dedup_keeps_most_recent", () => {
    // Item #33+#36: When same symbol appears in multiple files, keep only
    // most-recent reference. If most-recent is from an edited file, drop it.
    const sid = "xfile-dedup-abc";
    session.mark_file_read(sid, "src/a.py", 0, 10, { symbol: "foo" });
    session.mark_file_read(sid, "src/b.py", 0, 10, { symbol: "foo" }); // more recent
    session.mark_file_edited(sid, "src/a.py");
    const result = compact.build_manifest(sid);
    // Manifest is valid; may have symbols or files section
    expect(result.includes("## Token-Goat Session Manifest")).toBe(true);
  });

  it("test_stale_symbols_filtered_when_budget_tight", () => {
    // Item #34: stale symbols (>60 min old) filtered when budget < 80 tokens.
    const sid = "stale-sym-abc";
    const now = Date.now() / 1000;
    // Read a symbol now
    session.mark_file_read(sid, "src/recent.py", 0, 10, { symbol: "fresh_fn" });
    // Manually add a stale symbol to the cache
    let cache = session.load(sid);
    cache.files["src/old.py"] = new FileEntry({
      rel_or_abs: "src/old.py",
      last_read_ts: now - 7200, // 2 hours ago
      read_count: 1,
      line_ranges: [],
      symbols_read: ["stale_fn"],
      symbols_ts: { stale_fn: now - 7200 },
    });
    session.save(cache);
    cache = session.load(sid);
    cache.edited_files = { "src/a.py": 1 };
    session.save(cache);
    // With tight budget (< 80), stale symbols should be filtered
    const result = compact.build_manifest(sid, { max_tokens: 200 });
    // Verification: passing if no exception is thrown (robust tight-budget handling)
    expect(result.includes("## Token-Goat Session Manifest")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Item 35 — Adaptive directory grouping
// ---------------------------------------------------------------------------

describe("TestAdaptiveDirectoryGrouping", () => {
  it("test_many_edited_files_grouped_more_aggressively", () => {
    // 15+ edited files → grouping threshold reduced from 3 to 2.
    //
    // The Python test mocks compact._get_git_diff_stat_summary /
    // _get_inline_diff_for_file / _get_git_diff_stat / _get_session_commits to
    // avoid real git calls. _build_manifest_from_cache invokes those via LOCAL
    // bindings (no self-namespace import in compact.ts), so a vi.spyOn on the
    // ESM namespace cannot intercept them — BUT with cwd="/proj" (a non-existent,
    // non-git dir) the real functions return exactly what the mocks return:
    // _get_git_diff_stat_summary -> "" (not a git repo via _is_git_repo),
    // _get_inline_diff_for_file -> null (no whole-repo diff), and
    // _get_session_commits -> [] (not a git repo). The observed outcome is
    // therefore identical, so the (no-op) spies are omitted.
    const sid = "many-edits-abc";
    // Create 18 edited files in 4 directories — batch via the cache kwarg.
    let cache = session.load(sid);
    for (let i = 0; i < 5; i++) {
      cache = session.mark_file_edited(sid, `src/dir1/file${i}.py`, { cache });
    }
    for (let i = 0; i < 5; i++) {
      cache = session.mark_file_edited(sid, `src/dir2/file${i}.py`, { cache });
    }
    for (let i = 0; i < 4; i++) {
      cache = session.mark_file_edited(sid, `src/dir3/file${i}.py`, { cache });
    }
    for (let i = 0; i < 4; i++) {
      cache = session.mark_file_edited(sid, `src/dir4/file${i}.py`, { cache });
    }
    session.save(cache);

    cache = session.load(sid);
    cache.cwd = "/proj";
    session.save(cache);
    // With 18 edited files, grouping should be more aggressive
    const manifest = compact._build_manifest_from_cache(cache, sid, 800);
    // Result varies by implementation; key is that no exception is raised.
    expect(manifest.includes("**Edited:**") || manifest.includes("### MUST_PRESERVE")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Item 13 — Skip **Pending:** when nearly all files have inline diffs
// ---------------------------------------------------------------------------

describe("TestSkipPendingChangesWhenInline", () => {
  // PORT: deferred — all three tests patch compact's internal git helpers
  // (_get_whole_repo_diff / _get_inline_diff_for_file / _get_git_diff_stat_summary)
  // and the mocked return values are LOAD-BEARING: they inject the inline-diff
  // text + "N file changed" summary the **Pending:** suppression logic keys off.
  // _build_manifest_from_cache calls those helpers through LOCAL bindings
  // (compact.ts has no self-namespace import), so a vi.spyOn on the ESM namespace
  // cannot intercept them, and the real helpers return null/"" for cwd="/proj"
  // (not a git repo). There is no faithful way to drive the suppression branches
  // without an injection seam — same precedent as test_compact_2's
  // test_manifest_includes_commits_section_when_present.

  it.skip("test_pending_suppressed_when_single_file_inlined", () => {
    // see PORT note above — load-bearing _get_whole_repo_diff mock.
  });

  it.skip("test_pending_present_when_no_inline_diff", () => {
    // see PORT note above — load-bearing _get_git_diff_stat_summary mock.
  });

  it.skip("test_pending_suppressed_when_multi_file_all_inlined", () => {
    // see PORT note above — load-bearing _get_inline_diff_for_file mock.
  });
});

// ---------------------------------------------------------------------------
// Item 21 — StringIO write-buffer for manifest assembly
// ---------------------------------------------------------------------------

describe("TestStringIOAssembly", () => {
  it("test_manifest_has_no_leading_trailing_whitespace", () => {
    const sid = "sio-trim-abc";
    session.mark_file_edited(sid, "src/foo.py");
    const result = compact.build_manifest(sid);
    if (result) {
      expect(result).toBe(result.trim());
    }
  });

  it("test_manifest_sections_separated_by_single_newline", () => {
    const sid = "sio-newline-abc";
    make_session(sid, { age_seconds: 7200, edits: 1, bash_runs: { "pytest tests/": [12_000, 0] } });
    const result = compact.build_manifest(sid);
    // No double-blank lines should appear (StringIO assembly joins with \n)
    expect(result.includes("\n\n\n")).toBe(false);
  });

  it("test_manifest_nonempty_for_active_session", () => {
    const sid = "sio-nonempty-abc";
    session.mark_file_edited(sid, "src/foo.py");
    const result = compact.build_manifest(sid);
    expect(typeof result).toBe("string");
    // The edited file must appear in the manifest.
    expect(result.includes("foo.py")).toBe(true);
  });

  it("test_manifest_empty_for_empty_session", () => {
    const sid = "sio-empty-abc";
    const result = compact.build_manifest(sid);
    expect(result).toBe("");
  });
});

// ---------------------------------------------------------------------------
// Item 23 — Dynamic max_files_read based on edited file count
// ---------------------------------------------------------------------------

describe("TestDynamicMaxFilesRead", () => {
  it("test_ten_or_more_edits_limits_key_files_to_four", () => {
    const sid = "dynmax-10-abc";
    // 10 edited files → dynamic max = 4. Batch via cache kwarg.
    let cache = session.load(sid);
    const saveSpy = vi.spyOn(session, "save").mockReturnValue(undefined);
    for (let i = 0; i < 10; i++) {
      cache = session.mark_file_edited(sid, `src/edit_${String(i).padStart(2, "0")}.py`, { cache });
    }
    for (let i = 0; i < 12; i++) {
      cache = session.mark_file_read(sid, `src/read_${String(i).padStart(2, "0")}.py`, 0, 50, { cache });
    }
    saveSpy.mockRestore();
    session.save(cache);
    const result = compact.build_manifest(sid, { max_tokens: 2000 });
    if (result.includes("**Files:**")) {
      // Stop the slice at the next ### header so its bullets aren't miscounted.
      const files_section = result.split("**Files:**")[1]!.split("**")[0]!.split("\n### ")[0]!;
      const file_entries = files_section.split("\n").filter((ln) => ln.trim().startsWith("-"));
      expect(file_entries.length).toBeLessThanOrEqual(6); // 4 + 2 mature bonus max
    }
  });

  it("test_five_to_nine_edits_limits_key_files_to_six", () => {
    const sid = "dynmax-5-abc";
    // 7 edited files → dynamic max = 6. Batch via cache kwarg.
    let cache = session.load(sid);
    const saveSpy = vi.spyOn(session, "save").mockReturnValue(undefined);
    for (let i = 0; i < 7; i++) {
      cache = session.mark_file_edited(sid, `src/edit_${String(i).padStart(2, "0")}.py`, { cache });
    }
    for (let i = 0; i < 12; i++) {
      cache = session.mark_file_read(sid, `src/read_${String(i).padStart(2, "0")}.py`, 0, 50, { cache });
    }
    saveSpy.mockRestore();
    session.save(cache);
    const result = compact.build_manifest(sid, { max_tokens: 2000 });
    if (result.includes("**Files:**")) {
      const files_section = result.split("**Files:**")[1]!.split("**")[0]!.split("\n### ")[0]!;
      const file_entries = files_section.split("\n").filter((ln) => ln.trim().startsWith("-"));
      expect(file_entries.length).toBeLessThanOrEqual(8); // 6 + 2 mature bonus max
    }
  });

  it("test_fewer_than_five_edits_uses_default_max", () => {
    const sid = "dynmax-few-abc";
    // 2 edited files → dynamic max = _MAX_FILES_READ (10). Batch via cache kwarg.
    let cache = session.load(sid);
    const saveSpy = vi.spyOn(session, "save").mockReturnValue(undefined);
    for (let i = 0; i < 2; i++) {
      cache = session.mark_file_edited(sid, `src/edit_${String(i).padStart(2, "0")}.py`, { cache });
    }
    for (let i = 0; i < 15; i++) {
      cache = session.mark_file_read(sid, `src/read_${String(i).padStart(2, "0")}.py`, 0, 50, { cache });
    }
    saveSpy.mockRestore();
    session.save(cache);
    const result = compact.build_manifest(sid, { max_tokens: 3000 });
    if (result.includes("**Files:**")) {
      const files_section = result.split("**Files:**")[1]!.split("**")[0]!.split("\n### ")[0]!;
      const file_entries = files_section.split("\n").filter((ln) => ln.trim().startsWith("-"));
      // With default max (10) + mature bonus (2), up to 12 entries are allowed
      expect(file_entries.length).toBeLessThanOrEqual(12);
    }
  });

  it("test_dynamic_max_constant_boundary_ten", () => {
    // Exactly 10 edited files hits the >=10 branch (max=4), not the >=5 branch (max=6).
    const sid = "dynmax-boundary-abc";
    let cache = session.load(sid);
    const saveSpy = vi.spyOn(session, "save").mockReturnValue(undefined);
    for (let i = 0; i < 10; i++) {
      cache = session.mark_file_edited(sid, `src/e_${String(i).padStart(2, "0")}.py`, { cache });
    }
    for (let i = 0; i < 15; i++) {
      cache = session.mark_file_read(sid, `src/r_${String(i).padStart(2, "0")}.py`, 0, 50, { cache });
    }
    saveSpy.mockRestore();
    session.save(cache);
    const result = compact.build_manifest(sid, { max_tokens: 2000 });
    if (result.includes("**Files:**")) {
      const files_section = result.split("**Files:**")[1]!.split("**")[0]!.split("\n### ")[0]!;
      const file_entries = files_section.split("\n").filter((ln) => ln.trim().startsWith("-"));
      // >=10 path: max=4, mature bonus=+2 → max 6
      expect(file_entries.length).toBeLessThanOrEqual(6);
    }
  });
});

// ---------------------------------------------------------------------------
// Item 9 — Skills section collapse to summary when recovery hint will fire
// ---------------------------------------------------------------------------

describe("TestSkillsSectionCollapse", () => {
  // PORT: deferred — depends on token_goat.skill_cache (store_output /
  // write_sidecar); skill_cache.ts is not ported at this layer.
  it.skip("test_collapsed_when_active", () => {
    // High-activity session: skill lines collapse to a single summary line.
  });

  // PORT: deferred — depends on token_goat.skill_cache (store_output /
  // write_sidecar); skill_cache.ts is not ported at this layer.
  it.skip("test_summary_format_always_used", () => {
    // Skills are always emitted as a single summary line regardless of activity.
  });
});

// ---------------------------------------------------------------------------
// Item 16 — Merge Files Edited + Key Files Read at >= 50% overlap
// ---------------------------------------------------------------------------

describe("TestFilesEditedReadMerge", () => {
  it("test_high_overlap_produces_merged_section", () => {
    // When >= 50% of edited files also appear in the read set, sections merge.
    const sid = "merge-high-overlap-abc";
    // Edit 2 files and read them (overlap = 100% of edited set).
    session.mark_file_edited(sid, "src/alpha.py");
    session.mark_file_edited(sid, "src/beta.py");
    for (let i = 0; i < 3; i++) {
      session.mark_file_read(sid, "src/alpha.py", 0, 50);
      session.mark_file_read(sid, "src/beta.py", 0, 50);
    }
    // Add 2 non-edited reads so **Files:** section is populated.
    session.mark_file_read(sid, "src/gamma.py", 0, 50);
    session.mark_file_read(sid, "src/delta.py", 0, 50);

    const result = compact.build_manifest(sid, { max_tokens: 600 });

    // When merged, a single **Files:** section appears (not separate Edited/Files).
    expect(result.includes("**Files:**")).toBe(true);
    // Merged lines carry the ✎ edit annotation for edited files.
    let files_section = result.split("**Files:**")[1]!;
    const end = files_section.indexOf("\n**");
    if (end >= 0) {
      files_section = files_section.slice(0, end);
    }
    expect(files_section.includes("✎")).toBe(true);
    // The **Edited:** header should NOT appear separately (merged away).
    expect(result.includes("**Edited:**")).toBe(false);
  });

  it("test_low_overlap_keeps_separate_sections", () => {
    // When < 50% overlap, separate **Edited:** and **Files:** sections are kept.
    const sid = "merge-low-overlap-abc";
    // Edit 4 files, but only read 1 of them (overlap = 25% < 50%).
    for (let i = 0; i < 4; i++) {
      session.mark_file_edited(sid, `src/edit_${i}.py`);
    }
    // Read the first edited file once (overlap = 1/4 = 25%).
    session.mark_file_read(sid, "src/edit_0.py", 0, 50);
    // Also read several unrelated files so **Files:** section is populated.
    for (let i = 0; i < 5; i++) {
      session.mark_file_read(sid, `src/read_${i}.py`, 0, 50);
    }

    const result = compact.build_manifest(sid, { max_tokens: 800 });

    // Separate sections: Edited uses **Edited:** header.
    expect(result.includes("**Staged/Uncommitted:**") || result.includes("**Edited:**")).toBe(true);
  });

  it("test_edits_only_no_merge", () => {
    // With edits but no reads in top-files, no merge is attempted.
    const sid = "merge-edits-only-abc";
    session.mark_file_edited(sid, "src/foo.py");
    session.mark_file_edited(sid, "src/bar.py");
    // No reads recorded.
    const result = compact.build_manifest(sid, { max_tokens: 600 });
    // Edits appear under **Edited:** (not merged).
    expect(result.includes("**Staged/Uncommitted:**") || result.includes("**Edited:**")).toBe(true);
    // **Files:** should not appear (no read entries to merge), but tolerate absence.
    if (result.includes("**Files:**")) {
      // If it somehow appears, no overlap — that's fine.
    }
  });
});

// ---------------------------------------------------------------------------
// Item 24 — Map pointer replaces symbol list in wide sessions
// ---------------------------------------------------------------------------

describe("TestWideSessionSymbolReplacement", () => {
  it("test_under_threshold_emits_full_symbol_section", () => {
    // Fewer than threshold files: per-file symbol list is emitted normally.
    const sid = "wide-under-threshold-abc";
    const threshold = config.load().compact_assist?.wide_session_threshold ?? 15;
    // Stay under threshold: read (threshold - 2) files, each with a symbol.
    const n = Math.max(1, threshold - 2);
    let cache = session.load(sid);
    const saveSpy = vi.spyOn(session, "save").mockReturnValue(undefined);
    for (let i = 0; i < n; i++) {
      cache = session.mark_file_read(sid, `src/mod_${String(i).padStart(2, "0")}.py`, null, null, {
        symbol: `func_${i}`,
        cache,
      });
    }
    cache = session.mark_file_edited(sid, "src/target.py", { cache });
    saveSpy.mockRestore();
    session.save(cache);

    const result = compact.build_manifest(sid, { max_tokens: 2000 });

    // Should use the per-file format (contains "→" inside **Symbols Accessed:** section).
    if (result.includes("**Symbols Accessed:**")) {
      const syms_part = result.split("**Symbols Accessed:**")[1]!;
      const end = syms_part.indexOf("\n**");
      const syms_content = end >= 0 ? syms_part.slice(0, end) : syms_part;
      // Per-file entries use "→" as the separator between path and symbols.
      expect(syms_content.includes("→")).toBe(true);
      // Wide-session one-liner would say "files accessed".
      expect(syms_content.includes("files accessed")).toBe(false);
    }
  });

  it("test_at_threshold_emits_map_pointer", () => {
    // Exactly at threshold files: symbol section replaced by map pointer.
    const sid = "wide-at-threshold-abc";
    const threshold = config.load().compact_assist?.wide_session_threshold ?? 15;

    // Read exactly `threshold` files — batch via cache kwarg.
    let cache = session.load(sid);
    const saveSpy = vi.spyOn(session, "save").mockReturnValue(undefined);
    for (let i = 0; i < threshold; i++) {
      cache = session.mark_file_read(sid, `src/wide_${String(i).padStart(2, "0")}.py`, null, null, {
        symbol: `fn_${i}`,
        cache,
      });
    }
    cache = session.mark_file_edited(sid, "src/anchor.py", { cache });
    saveSpy.mockRestore();
    session.save(cache);

    const result = compact.build_manifest(sid, { max_tokens: 2000 });

    // The map-pointer one-liner must appear.
    expect(result.includes("**Symbols Accessed:**")).toBe(true);
    const syms_line = result.split("\n").find((ln) => ln.includes("**Symbols Accessed:**"));
    expect(syms_line).not.toBeUndefined();
    expect(syms_line!.includes("files accessed")).toBe(true);
    expect(syms_line!.includes("token-goat map --compact")).toBe(true);
    // Must NOT list individual per-file symbol entries.
    expect(syms_line!.includes("→")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Sidecar-based manifest cache: fingerprint check short-circuits full render.
// ---------------------------------------------------------------------------

describe("TestManifestCacheStub", () => {
  it("test_first_compact_builds_full_manifest_and_creates_sidecar", () => {
    // First PreCompact call renders the full manifest and writes the sidecar.
    const sid = "stub-first-compact-abc";
    session.mark_file_edited(sid, "/proj/src/auth.py");
    session.mark_file_edited(sid, "/proj/src/utils.py");

    const result = compact.build_manifest(sid);

    // Full manifest returned (has the standard header).
    expect(result.includes("## Token-Goat Session Manifest")).toBe(true);

    // Sidecar must exist after the first call.
    const sidecar = paths.manifestShaSidecarPath(sid);
    expect(fs.existsSync(sidecar)).toBe(true);

    // Sidecar must contain valid JSON with expected keys.
    const data = JSON.parse(fs.readFileSync(sidecar, "utf8")) as Record<string, unknown>;
    expect("sha" in data).toBe(true);
    expect("fp" in data).toBe(true);
    expect("ts" in data).toBe(true);
    expect(typeof data["ts"]).toBe("number");
    // sha is the first 16 hex chars of SHA-256.
    const sha = String(data["sha"]);
    expect(sha.length).toBe(16);
    expect([...sha].every((c) => "0123456789abcdef".includes(c))).toBe(true);
    // fp must be a non-empty string fingerprint.
    expect(String(data["fp"]).length).toBeGreaterThan(0);
  });

  it("test_second_compact_same_inputs_within_ttl_returns_stub", () => {
    // Second PreCompact with identical session state returns the 1-line stub.
    const sid = "stub-second-same-inputs";
    session.mark_file_edited(sid, "/proj/src/parser.py");

    // First call: full manifest.
    const first = compact.build_manifest(sid);
    expect(first.includes("## Token-Goat Session Manifest")).toBe(true);

    // Simulate new hook process (cross-process cache-hit path).
    _clear_process_guard(sid);

    // Second call: same session state, sidecar is fresh → stub.
    const second = compact.build_manifest(sid);
    expect(second.includes("## Token-Goat Manifest — unchanged since")).toBe(true);
    expect(second.includes("token-goat compact-hint --session-id")).toBe(true);
    // Must NOT contain the full manifest header.
    expect(second.includes("## Token-Goat Session Manifest")).toBe(false);
    // Stub is a single line.
    expect(second.split("\n").length - 1).toBe(0);
  });

  it("test_second_compact_sidecar_mtime_unchanged", () => {
    // Cache hit must NOT overwrite the sidecar (mtime stays the same).
    const sid = "stub-mtime-check";
    session.mark_file_edited(sid, "/proj/src/db.py");

    compact.build_manifest(sid);
    const sidecar = paths.manifestShaSidecarPath(sid);
    const mtime_after_first = fs.statSync(sidecar).mtimeMs;

    _clear_process_guard(sid);

    compact.build_manifest(sid);
    const mtime_after_second = fs.statSync(sidecar).mtimeMs;

    expect(mtime_after_first).toBe(mtime_after_second);
  });

  it("test_new_bash_exit_code_busts_cache", () => {
    // A new bash entry with non-zero exit_code changes the fingerprint → full rebuild.
    const sid = "stub-exit-code-bust";
    session.mark_file_edited(sid, "/proj/src/worker.py");

    const first = compact.build_manifest(sid);
    expect(first.includes("## Token-Goat Session Manifest")).toBe(true);

    // Record a new bash entry with exit_code=1 (a failing test).
    session.mark_bash_run(sid, "abcd1234", "pytest tests/", "out-001", 512, 0, 1, false);

    _clear_process_guard(sid);

    // Second call: fingerprint changed due to new bash entry → full manifest.
    const second = compact.build_manifest(sid);
    expect(second.includes("## Token-Goat Session Manifest")).toBe(true);
    expect(second.includes("unchanged since")).toBe(false);
  });

  it("test_changed_edited_files_busts_cache", () => {
    // Adding a new edited file changes the fingerprint → full manifest rebuilt.
    const sid = "stub-edit-bust";
    session.mark_file_edited(sid, "/proj/src/api.py");

    const first = compact.build_manifest(sid);
    expect(first.includes("## Token-Goat Session Manifest")).toBe(true);

    // Add a new edit — sorted edited_files keys change.
    session.mark_file_edited(sid, "/proj/src/new_module.py");

    _clear_process_guard(sid);

    const second = compact.build_manifest(sid);
    expect(second.includes("## Token-Goat Session Manifest")).toBe(true);
    expect(second.includes("unchanged since")).toBe(false);
  });

  it("test_expired_sidecar_triggers_full_rebuild", () => {
    // Sidecar older than _MANIFEST_CACHE_TTL_SECS triggers a full manifest rebuild.
    const sid = "stub-ttl-expired";
    session.mark_file_edited(sid, "/proj/src/config.py");

    // First call: write sidecar.
    const first = compact.build_manifest(sid);
    expect(first.includes("## Token-Goat Session Manifest")).toBe(true);

    // Overwrite sidecar with a stale timestamp (700s > 600s TTL).
    const sidecar = paths.manifestShaSidecarPath(sid);
    const data = JSON.parse(fs.readFileSync(sidecar, "utf8")) as Record<string, unknown>;
    data["ts"] = Date.now() / 1000 - 700.0;
    fs.writeFileSync(sidecar, JSON.stringify(data), "utf8");

    _clear_process_guard(sid);

    // Second call: sidecar age > TTL → full manifest.
    const second = compact.build_manifest(sid);
    expect(second.includes("## Token-Goat Session Manifest")).toBe(true);
    expect(second.includes("unchanged since")).toBe(false);
  });

  it("test_same_process_guard_prevents_stub", () => {
    // Within a single process, two calls always return the full manifest.
    const sid = "stub-same-process-guard";
    session.mark_file_edited(sid, "/proj/src/render.py");

    const first = compact.build_manifest(sid);
    expect(first.includes("## Token-Goat Session Manifest")).toBe(true);

    // No guard clear — second call in same process must return full manifest.
    const second = compact.build_manifest(sid);
    expect(second.includes("## Token-Goat Session Manifest")).toBe(true);
    expect(second.includes("unchanged since")).toBe(false);
  });

  it("test_future_dated_sidecar_forces_full_rebuild", () => {
    // A sidecar with ts in the future must NOT be treated as a fresh cache.
    const sid = "stub-future-skew";
    session.mark_file_edited(sid, "/proj/src/skew.py");

    const first = compact.build_manifest(sid);
    expect(first.includes("## Token-Goat Session Manifest")).toBe(true);

    // Backdate the sidecar to 1 day in the future.
    const sidecar = paths.manifestShaSidecarPath(sid);
    const data = JSON.parse(fs.readFileSync(sidecar, "utf8")) as Record<string, unknown>;
    data["ts"] = Date.now() / 1000 + 86400.0;
    fs.writeFileSync(sidecar, JSON.stringify(data), "utf8");

    _clear_process_guard(sid);

    const second = compact.build_manifest(sid);
    // Must be full manifest, not a stub.
    expect(second.includes("## Token-Goat Session Manifest")).toBe(true);
    expect(second.includes("unchanged since")).toBe(false);
  });

  it("test_zero_ts_sidecar_forces_full_rebuild", () => {
    // A sidecar with ts <= 0 (corrupted / legacy zero) must force a rebuild.
    const sid = "stub-zero-ts";
    session.mark_file_edited(sid, "/proj/src/zero.py");

    const first = compact.build_manifest(sid);
    expect(first.includes("## Token-Goat Session Manifest")).toBe(true);

    // Corrupt the sidecar with a zero timestamp.
    const sidecar = paths.manifestShaSidecarPath(sid);
    const data = JSON.parse(fs.readFileSync(sidecar, "utf8")) as Record<string, unknown>;
    data["ts"] = 0.0;
    fs.writeFileSync(sidecar, JSON.stringify(data), "utf8");

    _clear_process_guard(sid);

    const second = compact.build_manifest(sid);
    expect(second.includes("## Token-Goat Session Manifest")).toBe(true);
    expect(second.includes("unchanged since")).toBe(false);
  });

  it("test_nan_ts_sidecar_treated_as_unreadable", () => {
    // A sidecar with NaN/inf ts must be ignored entirely (cache rebuilds).
    const sid = "stub-nan-ts";
    session.mark_file_edited(sid, "/proj/src/nan.py");
    compact.build_manifest(sid);

    const sidecar = paths.manifestShaSidecarPath(sid);
    const data = JSON.parse(fs.readFileSync(sidecar, "utf8")) as Record<string, unknown>;
    // "NaN" string → Number("NaN") downstream yields NaN, which the reader rejects.
    data["ts"] = "NaN";
    fs.writeFileSync(sidecar, JSON.stringify(data), "utf8");

    _clear_process_guard(sid);

    const rebuilt = compact.build_manifest(sid);
    expect(rebuilt.includes("## Token-Goat Session Manifest")).toBe(true);
    expect(rebuilt.includes("unchanged since")).toBe(false);
  });

  it("test_empty_sha_or_fp_sidecar_treated_as_unreadable", () => {
    // A sidecar with empty `sha` or `fp` strings must be rejected.
    const sid = "stub-empty-sha";
    session.mark_file_edited(sid, "/proj/src/empty.py");
    compact.build_manifest(sid);

    const sidecar = paths.manifestShaSidecarPath(sid);
    const data = JSON.parse(fs.readFileSync(sidecar, "utf8")) as Record<string, unknown>;
    data["sha"] = ""; // corrupted blank
    fs.writeFileSync(sidecar, JSON.stringify(data), "utf8");

    _clear_process_guard(sid);
    const rebuilt = compact.build_manifest(sid);
    expect(rebuilt.includes("## Token-Goat Session Manifest")).toBe(true);
    expect(rebuilt.includes("unchanged since")).toBe(false);
  });

  it("test_far_future_ts_does_not_emit_delta_line", () => {
    // A future-dated sidecar discards prior_counts → no misleading delta line.
    const sid = "stub-future-skew-no-delta";
    // First compact populates the sidecar with counts.
    session.mark_file_edited(sid, "/proj/src/d1.py");
    session.mark_bash_run(sid, "ab", "pytest", "oA", 10, 0, 0, false);
    compact.build_manifest(sid);

    // Future-date the sidecar so the cache hit is rejected.
    const sidecar = paths.manifestShaSidecarPath(sid);
    const data = JSON.parse(fs.readFileSync(sidecar, "utf8")) as Record<string, unknown>;
    data["ts"] = Date.now() / 1000 + 3600.0; // 1 hour in the future
    fs.writeFileSync(sidecar, JSON.stringify(data), "utf8");

    // Mutate session so the rebuild would normally show +N deltas.
    session.mark_file_edited(sid, "/proj/src/d2.py");
    _clear_process_guard(sid);

    const rebuilt = compact.build_manifest(sid);
    expect(rebuilt.includes("## Token-Goat Session Manifest")).toBe(true);
    // prior_counts must be discarded → no Δ line on the rebuilt manifest.
    expect(rebuilt.includes("Δ since last compact")).toBe(false);
  });

  it("test_sidecar_uses_atomic_write_text", () => {
    // _save_manifest_sha_sidecar must call paths.atomicWriteText, not write_text.
    const atomic_calls: Array<[unknown, string]> = [];
    const original_atomic = paths.atomicWriteText;

    vi.spyOn(paths, "atomicWriteText").mockImplementation((p: string, content: string) => {
      if (String(p).includes("manifest_sha")) {
        atomic_calls.push([p, content]);
      }
      original_atomic(p, content);
    });

    const sid = "sidecar-atomic-test-001";
    compact._manifest_sha_written_this_process.delete(sid);
    // Give the session edited files so build_manifest emits a full manifest
    // (and therefore writes the sidecar) rather than hitting the activity floor.
    session.mark_file_edited(sid, "/proj/src/auth.py");
    session.mark_file_edited(sid, "/proj/src/utils.py");
    compact.build_manifest(sid);

    expect(atomic_calls.length).toBeGreaterThan(0);
    const payload = atomic_calls[0]![1];
    const data = JSON.parse(payload) as Record<string, unknown>;
    expect("sha" in data && "fp" in data).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Item #26 — **Δ since last compact:** mini-section at top of manifest.
// ---------------------------------------------------------------------------

describe("TestManifestDelta", () => {
  it("test_first_compact_emits_no_delta_line", () => {
    // First-ever compact has no prior sidecar — Δ line must be absent.
    const sid = "delta-first-compact";
    session.mark_file_edited(sid, "/proj/src/auth.py");
    const result = compact.build_manifest(sid);
    expect(result.includes("## Token-Goat Session Manifest")).toBe(true);
    expect(result.includes("Δ since last compact")).toBe(false);
  });

  it("test_subsequent_compact_with_growth_emits_delta", () => {
    // Adding bash + edited entries between compacts surfaces +N counts.
    const sid = "delta-with-growth";
    session.mark_file_edited(sid, "/proj/src/auth.py");
    const first = compact.build_manifest(sid);
    expect(first.includes("Δ since last compact")).toBe(false);

    // Grow the session: +1 edited, +2 bash.
    session.mark_file_edited(sid, "/proj/src/new.py");
    session.mark_bash_run(sid, "aa", "pytest", "o1", 10, 0, 0, false);
    session.mark_bash_run(sid, "bb", "ruff", "o2", 10, 0, 0, false);

    _clear_process_guard(sid);
    const second = compact.build_manifest(sid);
    // Delta line must be the first line of the manifest.
    expect(second.startsWith("**Δ since last compact:**")).toBe(true);
    expect(second.includes("+1 edited")).toBe(true);
    expect(second.includes("+2 bash")).toBe(true);
    // Full manifest still follows the delta line.
    expect(second.includes("## Token-Goat Session Manifest")).toBe(true);
  });

  it("test_delta_omitted_when_no_change", () => {
    // If section counts are unchanged between compacts, no Δ line.
    const sid = "delta-no-change";
    session.mark_file_edited(sid, "/proj/src/auth.py");
    compact.build_manifest(sid);

    // Force a TTL-expired rebuild without changing session state.
    const sidecar = paths.manifestShaSidecarPath(sid);
    const data = JSON.parse(fs.readFileSync(sidecar, "utf8")) as Record<string, unknown>;
    data["ts"] = Date.now() / 1000 - 700.0; // > _MANIFEST_CACHE_TTL_SECS
    fs.writeFileSync(sidecar, JSON.stringify(data), "utf8");
    _clear_process_guard(sid);

    const second = compact.build_manifest(sid);
    // Full rebuild because TTL expired, but counts identical → no Δ line.
    expect(second.includes("## Token-Goat Session Manifest")).toBe(true);
    expect(second.includes("Δ since last compact")).toBe(false);
  });

  it("test_v1_sidecar_treated_as_no_prior_counts", () => {
    // Legacy v1 sidecar (no `counts` key) gracefully degrades to no Δ line.
    const sid = "delta-v1-sidecar";
    const sidecar_path = paths.manifestShaSidecarPath(sid);
    paths.ensureDir(require_dirname(sidecar_path));
    // Write a v1 sidecar by hand — no `v`, no `counts`.
    fs.writeFileSync(
      sidecar_path,
      JSON.stringify({
        sha: "abc123",
        fp: "different-fp-so-no-cache-hit",
        ts: Date.now() / 1000 - 10.0,
      }),
      "utf8",
    );

    // Build a manifest — sidecar's fp won't match so we go through render.
    session.mark_file_edited(sid, "/proj/src/auth.py");
    const result = compact.build_manifest(sid);
    expect(result.includes("## Token-Goat Session Manifest")).toBe(true);
    // No Δ line because prior_counts was null for the v1 sidecar.
    expect(result.includes("Δ since last compact")).toBe(false);
  });

  it("test_malformed_counts_payload_treated_as_no_prior_counts", () => {
    // A sidecar with garbage in `counts` must not crash — treat as missing.
    const sid = "delta-malformed-counts";
    const sidecar_path = paths.manifestShaSidecarPath(sid);
    paths.ensureDir(require_dirname(sidecar_path));
    fs.writeFileSync(
      sidecar_path,
      JSON.stringify({
        v: 2,
        sha: "abc123",
        fp: "different-fp",
        ts: Date.now() / 1000 - 10.0,
        counts: "not-a-dict", // malformed
      }),
      "utf8",
    );

    session.mark_file_edited(sid, "/proj/src/auth.py");
    // Must not raise — _read_manifest_sidecar swallows malformed counts.
    const result = compact.build_manifest(sid);
    expect(result.includes("## Token-Goat Session Manifest")).toBe(true);
    expect(result.includes("Δ since last compact")).toBe(false);
  });

  it("test_format_manifest_delta_no_prior", () => {
    // Unit: prior=null returns null (no delta line).
    const result = compact._format_manifest_delta(null, { edited: 5 });
    expect(result).toBeNull();
  });

  it("test_format_manifest_delta_no_change", () => {
    // Unit: identical counts return null (omit Δ line entirely).
    const result = compact._format_manifest_delta({ edited: 3 }, { edited: 3 });
    expect(result).toBeNull();
  });

  it("test_format_manifest_delta_growth_and_shrink", () => {
    // Unit: combined +/- deltas in stable section order.
    const prior = { edited: 3, bash: 5, grep: 2 };
    const current = { edited: 5, bash: 4, grep: 2 };
    const result = compact._format_manifest_delta(prior, current);
    expect(result).not.toBeNull();
    expect(result!.startsWith("**Δ since last compact:**")).toBe(true);
    expect(result!.includes("+2 edited")).toBe(true);
    expect(result!.includes("-1 bash")).toBe(true);
    expect(result!.includes("grep")).toBe(false); // unchanged → omitted
  });

  it("test_compute_section_counts_symbols_nonzero_when_symbols_read", () => {
    // _compute_section_counts returns symbols > 0 when files have symbols_read.
    const cache = {
      edited_files: {},
      files: {
        "a.py": { symbols_read: ["foo", "bar"] },
        "b.py": { symbols_read: ["baz"] },
        "c.py": { symbols_read: [] },
      },
      bash_history: {},
      web_history: {},
      greps: [],
      glob_history: [],
      skill_history: {},
      decisions: [],
    };
    const counts = compact._compute_section_counts(cache);
    expect(counts["symbols"]).toBe(2); // a.py and b.py have non-empty symbols_read; c.py is falsy
  });

  it("test_compute_section_counts_symbols_zero_when_no_symbols_read", () => {
    // _compute_section_counts returns symbols == 0 when no file has symbols_read.
    const cache = {
      edited_files: {},
      files: {
        "a.py": { symbols_read: [] },
        "b.py": { symbols_read: null },
      },
      bash_history: {},
      web_history: {},
      greps: [],
      glob_history: [],
      skill_history: {},
      decisions: [],
    };
    const counts = compact._compute_section_counts(cache);
    expect(counts["symbols"]).toBe(0);
  });

  it("test_format_manifest_delta_includes_symbol_growth", () => {
    // _format_manifest_delta surfaces symbol-count growth in the delta line.
    const prior = { edited: 1, symbols: 0 };
    const current = { edited: 1, symbols: 4 };
    const result = compact._format_manifest_delta(prior, current);
    expect(result).not.toBeNull();
    expect(result!.includes("+4 symbols")).toBe(true);
  });

  it("test_format_manifest_delta_symbols_unchanged_omitted", () => {
    // _format_manifest_delta omits the symbols field when unchanged.
    const prior = { edited: 2, symbols: 3 };
    const current = { edited: 3, symbols: 3 };
    const result = compact._format_manifest_delta(prior, current);
    expect(result).not.toBeNull();
    expect(result!.includes("symbols")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Local helper: Python `sidecar_path.parent` (dirname of a path string).
// ---------------------------------------------------------------------------
function require_dirname(p: string): string {
  const norm = p.replace(/\\/g, "/");
  const idx = norm.lastIndexOf("/");
  return idx >= 0 ? norm.slice(0, idx) : ".";
}
