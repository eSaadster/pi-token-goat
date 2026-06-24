/**
 * Tests for compaction assist: manifest generation, config, and budgets.
 *
 * 1:1 port of tests/test_compact.py part 1/6 (classes TestEventCount through
 * TestComputeAdaptiveBudgetDiffBonus, Python lines ~33-1551). Each Python
 * `def test_*` maps to a vitest `it()` with the SAME name and the SAME
 * assertion polarity; each Python `class Test*` maps to a `describe(...)`.
 *
 * ---------------------------------------------------------------------------
 * Parity notes (Python -> TS)
 * ---------------------------------------------------------------------------
 *  - Session-cache fixtures are built with the shipped session.ts API
 *    (mark_file_read / mark_grep / mark_file_edited / mark_bash_run /
 *    mark_skill_loaded / load / save). Python kwargs map positionally:
 *      mark_file_read(sid, p, offset=O, limit=L)   -> mark_file_read(sid, p, O, L)
 *      mark_file_read(sid, p, symbol="X")          -> mark_file_read(sid, p, null, null, {symbol:"X"})
 *      mark_grep(sid, pat, "/p", result_count=N)   -> mark_grep(sid, pat, "/p", N)
 *  - `_make_session` (conftest) -> the local makeSession() helper.
 *  - Per-test tmp data dir + cache clearing is handled by tests/setup.ts
 *    (beforeEach -> setDataDirOverride + clearModuleCaches), the analogue of the
 *    Python tmp_data_dir autouse fixture.
 *
 *  - TIME MONKEYPATCHING. Python does `monkeypatch.setattr(session.time, "time",
 *    ...)` to feed a strictly-increasing fake clock so recency ordering is
 *    deterministic. session.ts has no `time` module — it reads `Date.now()/1000`
 *    directly — so the TS port spies `Date.now` with a monotonic counter during
 *    the marking phase, then RESTORES it before build_manifest(). Python only
 *    patches session's clock (not compact's), so compact sees real wall-clock;
 *    restoring Date.now before build_manifest reproduces that exactly: the stored
 *    per-entry `ts` values carry the injected monotonic order while compact's own
 *    `_now()` is the real wall-clock. Relative ordering is preserved either way.
 *
 *  - `_load_config` monkeypatch. Python patches `compact._load_config`; the TS
 *    compact loads config via the STATIC `config.load()` import, so the port
 *    spies `vi.spyOn(config, "load")` to return a config with
 *    `wide_session_threshold` overridden (the same end state).
 *
 *  - `_get_git_diff_stat` / `_get_git_diff_stat_summary` monkeypatch. Python
 *    patches these on `compact` purely to suppress git output when the session
 *    cwd is a non-git dir. The TS compact calls `_get_git_diff_stat` (module-
 *    private) and `_get_git_diff_stat_summary` (exported but called via a local
 *    binding) so a namespace spy would not intercept the internal call. In every
 *    ported test the session cwd is null (the `/proj/...` paths are never set as
 *    cwd), so `_get_git_diff_stat_summary(null)` returns "" and
 *    `_get_uncommitted_changes(null)` returns null already — the monkeypatch is a
 *    no-op. The patches are therefore omitted and the behaviour is unchanged.
 *
 *  - `session._UNKNOWN_END_SENTINEL` is module-private in session.ts (not
 *    exported). Its value is 99_999 (mirrored by compact's `_FULL_READ_SENTINEL_
 *    GAP`); the sentinel-range tests inline `1 + 99_999` with a comment.
 *
 * Tests importing token_goat.bash_cache (command_hash) are SKIPPED with a
 * reason: bash_cache.ts is not ported at this layer.
 */
import { describe, expect, it, vi } from "vitest";

import * as compact from "../src/token_goat/compact.js";
import * as session from "../src/token_goat/session.js";
import * as config from "../src/token_goat/config.js";
import { short_output_id } from "../src/token_goat/cache_common.js";
import { BashEntry, WebEntry } from "../src/token_goat/session.js";
import type { ConfigSchema } from "../src/token_goat/types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * conftest `_make_session` analogue. Populates a SessionCache with the given
 * number of file reads / greps / edits (the only kwargs the ported tests use).
 */
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

/**
 * Spy `Date.now` with a strictly-increasing clock (start seconds, step seconds),
 * mirroring Python's `itertools.count(start, step)` fed to `session.time.time`.
 * Returns the spy so the caller can `.mockRestore()` before build_manifest().
 */
function mockMonotonicNow(start = 1_000_000_000.0, step = 0.01): ReturnType<typeof vi.spyOn> {
  let cur = start;
  const spy = vi.spyOn(Date, "now").mockImplementation(() => {
    const v = cur;
    cur += step;
    return v * 1000; // Date.now() is ms; session divides by 1000.
  });
  return spy;
}

/** clear_process_guard(sid) — evict sid from the per-process manifest-SHA set. */
function clearProcessGuard(sid: string): void {
  compact._manifest_sha_written_this_process.delete(sid);
}

/** A config with compact_assist.wide_session_threshold overridden. */
function configWithWideThreshold(threshold: number): ConfigSchema {
  const base = config.load();
  return {
    ...base,
    compact_assist: { ...(base.compact_assist ?? {}), wide_session_threshold: threshold },
  };
}

// ---------------------------------------------------------------------------
// compact.event_count
// ---------------------------------------------------------------------------

describe("TestEventCount", () => {
  it("test_empty_session_returns_zero", () => {
    expect(compact.event_count("empty-session-abc")).toBe(0);
  });

  it("test_counts_files_greps_and_edits", () => {
    const sid = "evcount-session-xyz";
    makeSession(sid, { files_read: 3, greps: 2, edits: 1 });
    // event_count = len(files) + len(greps) + len(edited_files)
    expect(compact.event_count(sid)).toBe(6);
  });

  it("test_only_edits_counted", () => {
    const sid = "only-edits-session-abc";
    session.mark_file_edited(sid, "/proj/app.py");
    session.mark_file_edited(sid, "/proj/app.py"); // same file, same key
    // edited_files is path->count dict, so same path = 1 entry
    expect(compact.event_count(sid)).toBe(1);
  });

  it("test_invalid_session_id_returns_zero", () => {
    // Handles load failures gracefully
    expect(compact.event_count("a".repeat(300))).toBe(0); // too long -> validation fails -> caught
  });
});

// ---------------------------------------------------------------------------
// compact.build_manifest
// ---------------------------------------------------------------------------

describe("TestBuildManifest", () => {
  it("test_empty_session_returns_empty_string", () => {
    const result = compact.build_manifest("no-activity-session");
    expect(result).toBe("");
  });

  it("test_manifest_contains_header", () => {
    const sid = "manifest-header-session";
    makeSession(sid, { files_read: 2, greps: 1, edits: 1 });
    const result = compact.build_manifest(sid);
    expect(result.includes("## Token-Goat Session Manifest")).toBe(true);
  });

  it("test_manifest_header_is_lightweight", () => {
    const sid = "header-lightweight-session";
    makeSession(sid, { files_read: 1, edits: 1 });
    const result = compact.build_manifest(sid);

    expect(result.includes("## Token-Goat Session Manifest")).toBe(true);

    const lines = result.split("\n");
    let sealed_end_idx: number | null = null;
    for (let i = 0; i < lines.length; i++) {
      if ((lines[i] ?? "").trim() === "<</preserve>>") {
        sealed_end_idx = i;
        break;
      }
    }

    if (sealed_end_idx !== null) {
      const post_sealed = lines.slice(sealed_end_idx + 1);
      const header_lines = post_sealed.slice(0, 5).filter((ln) => ln.trim());
      if (header_lines.length > 0) {
        expect(header_lines[0]!.includes("## Token-Goat Session Manifest")).toBe(true);
      }
    } else {
      const header_lines = lines.slice(0, 5).filter((ln) => ln.trim());
      expect(header_lines[0]!.includes("## Token-Goat Session Manifest")).toBe(true);
    }

    expect(result.includes("Session:")).toBe(false);
  });

  it("test_edited_files_section_present", () => {
    const sid = "edited-files-session-abc";
    session.mark_file_edited(sid, "/proj/src/auth.py");
    session.mark_file_read(sid, "/proj/src/auth.py", 0, 50);
    const result = compact.build_manifest(sid);
    expect(result.includes("**Staged/Uncommitted:**") || result.includes("**Edited:**")).toBe(true);
    expect(result.includes("auth.py")).toBe(true);
  });

  it("test_symbols_section_present", () => {
    // Item #8: a symbol-bearing file that also appears in **Files:** has its
    // symbol-detail line suppressed. Pad the session with many plain reads so the
    // symbol file falls out of **Files:** and its detail surfaces in **Symbols
    // Accessed:**. wide_session_threshold=200 keeps the session out of wide mode.
    const cfgSpy = vi.spyOn(config, "load").mockReturnValue(configWithWideThreshold(200));

    const sid = "symbols-session-abc";
    let cache = session.load(sid);
    const saveSpy = vi.spyOn(session, "save").mockImplementation(() => undefined);
    for (let i = 0; i < 16; i++) {
      for (let r = 0; r < 5; r++) {
        cache = session.mark_file_read(sid, `/proj/src/noise${String(i).padStart(2, "0")}.py`, 0, 400, {
          cache,
        });
      }
    }
    saveSpy.mockRestore();
    session.save(cache);
    session.mark_file_read(sid, "/proj/src/parser.py", null, null, { symbol: "index_project" });
    const result = compact.build_manifest(sid);
    cfgSpy.mockRestore();
    expect(result.includes("**Symbols Accessed:**")).toBe(true);
    expect(result.includes("index_project")).toBe(true);
  });

  it("test_symbol_detail_suppressed_when_file_in_files_section", () => {
    const sid = "sym-suppress-session-abc";
    session.mark_file_read(sid, "/proj/src/lonely.py", null, null, { symbol: "solo_symbol" });
    const result = compact.build_manifest(sid);
    expect(result.includes("lonely.py")).toBe(true);
    if (result.includes("**Symbols Accessed:**")) {
      const syms_part = result.split("**Symbols Accessed:**")[1]!.split("\n**")[0]!;
      expect(syms_part.includes("solo_symbol")).toBe(false);
    }
  });

  it("test_symbols_dropped_from_edited_files", () => {
    const sid = "sym-edited-dedup-session-abc";
    session.mark_file_edited(sid, "/proj/src/edited_with_symbols.py");
    session.mark_file_read(sid, "/proj/src/edited_with_symbols.py", null, null, {
      symbol: "func_from_edited",
    });
    const result = compact.build_manifest(sid);
    expect(result.includes("edited_with_symbols.py")).toBe(true);
    expect(result.includes("**Staged/Uncommitted:**") || result.includes("**Edited:**")).toBe(true);
    if (result.includes("**Symbols Accessed:**")) {
      const syms_part = result.split("**Symbols Accessed:**")[1]!.split("\n**")[0]!;
      expect(syms_part.includes("func_from_edited")).toBe(false);
    }
  });

  it("test_symbols_retained_for_read_only_files", () => {
    const sid = "sym-readonly-session-abc";
    session.mark_file_edited(sid, "/proj/src/edited.py");
    session.mark_file_read(sid, "/proj/src/readonly.py", null, null, { symbol: "readonly_func" });
    const result = compact.build_manifest(sid);
    expect(result.includes("edited.py")).toBe(true);
    expect(result.includes("readonly.py")).toBe(true);
    if (result.includes("**Symbols Accessed:**")) {
      const syms_part = result.split("**Symbols Accessed:**")[1]!.split("\n**")[0]!;
      expect(syms_part.includes("readonly_func")).toBe(true);
    }
  });

  it("test_no_edited_files_preserves_all_symbols", () => {
    const sid = "sym-no-edits-session-abc";
    session.mark_file_read(sid, "/proj/src/file1.py", null, null, { symbol: "symbol1" });
    session.mark_file_read(sid, "/proj/src/file2.py", null, null, { symbol: "symbol2" });
    const result = compact.build_manifest(sid);
    if (result.includes("**Symbols Accessed:**")) {
      const syms_part = result.split("**Symbols Accessed:**")[1]!.split("\n**")[0]!;
      expect(syms_part.includes("symbol1")).toBe(true);
    }
  });

  it("test_key_files_section_present", () => {
    const sid = "keyfiles-session-abc";
    session.mark_file_read(sid, "/proj/src/db.py", 0, 200);
    const result = compact.build_manifest(sid);
    expect(result.includes("**Files:**")).toBe(true);
    expect(result.includes("db.py")).toBe(true);
  });

  it("test_manifest_respects_token_budget", () => {
    const sid = "budget-session-abc";
    let cache = session.load(sid);
    const saveSpy = vi.spyOn(session, "save").mockImplementation(() => undefined);
    for (let i = 0; i < 20; i++) {
      cache = session.mark_file_read(sid, `/proj/src/bigfile${String(i).padStart(2, "0")}.py`, 0, 500, {
        cache,
      });
    }
    saveSpy.mockRestore();
    session.save(cache);
    const result = compact.build_manifest(sid, { max_tokens: 50 });
    const max_chars = 50 * 4;
    expect(result.length).toBeLessThanOrEqual(max_chars);
  });

  it("test_manifest_400_token_budget_enforced_with_skills", () => {
    const sid = "budget-skills-session-xyz";
    for (let i = 0; i < 15; i++) {
      session.mark_file_read(sid, `/proj/src/module${String(i).padStart(2, "0")}.py`, 0, 300);
    }
    for (let i = 0; i < 5; i++) {
      session.mark_grep(sid, `pattern${i}`, "/proj/src");
    }
    for (let i = 0; i < 3; i++) {
      session.mark_file_edited(sid, `/proj/src/edited${String(i).padStart(2, "0")}.py`);
    }

    session.mark_skill_loaded(sid, "ralph", "ralph-out-abc", "abc123def456", 32000, false);
    session.mark_skill_loaded(sid, "improve", "improve-out-def", "def789abc012", 18000, false);
    session.mark_skill_loaded(sid, "superman", "superman-out-bcd", "bcd456def890", 24000, false);

    const result = compact.build_manifest(sid, { max_tokens: 400 });

    const max_chars = 400 * 4;
    expect(result.length).toBeLessThanOrEqual(max_chars);
    expect(result.includes("ralph") || result.includes("improve") || result.includes("superman")).toBe(
      true,
    );
  });

  it("test_edited_files_sorted_by_edit_count", () => {
    const sid = "sort-edits-session-abc";
    session.mark_file_edited(sid, "/proj/a.py");
    session.mark_file_edited(sid, "/proj/b.py");
    session.mark_file_edited(sid, "/proj/b.py");
    session.mark_file_edited(sid, "/proj/b.py");
    const result = compact.build_manifest(sid);
    // b.py was edited 3x — should appear before a.py
    expect(result.indexOf("b.py")).toBeLessThan(result.indexOf("a.py"));
  });

  it("test_edited_files_sorted_by_recency_beats_count", () => {
    // a.py edited many times (high count) but long ago; b.py once but recently.
    // Recency must win: b.py before a.py.
    const sid = "recency-beats-count-session-abc";

    // Edit a.py 5x at a simulated old timestamp (1 hour ago).
    const oldTs = Date.now() / 1000 - 3600.0; // 1 hour ago
    {
      const spy = vi.spyOn(Date, "now").mockImplementation(() => oldTs * 1000);
      for (let i = 0; i < 5; i++) {
        session.mark_file_edited(sid, "/proj/a.py");
      }
      session.mark_file_read(sid, "/proj/a.py", 0, 10);
      session.mark_file_edited(sid, "/proj/a.py");
      spy.mockRestore();
    }

    const recentTs = Date.now() / 1000 - 5.0; // 5 seconds ago
    {
      const spy = vi.spyOn(Date, "now").mockImplementation(() => recentTs * 1000);
      session.mark_file_edited(sid, "/proj/b.py");
      session.mark_file_read(sid, "/proj/b.py", 0, 10);
      session.mark_file_edited(sid, "/proj/b.py");
      spy.mockRestore();
    }

    const result = compact.build_manifest(sid);
    let edited_idx = result.indexOf("**Staged/Uncommitted:**");
    if (edited_idx < 0) {
      edited_idx = result.indexOf("**Edited:**");
    }
    expect(edited_idx).toBeGreaterThanOrEqual(0);
    const edited_section = result.slice(edited_idx);
    expect(edited_section.indexOf("b.py")).toBeLessThan(edited_section.indexOf("a.py"));
  });

  it("test_edit_count_suffix_in_manifest", () => {
    const sid = "suffix-session-abc";
    for (let i = 0; i < 4; i++) {
      session.mark_file_edited(sid, "/proj/hot.py");
    }
    const result = compact.build_manifest(sid);
    expect(result.includes("×4")).toBe(true);
  });

  it("test_manifest_is_string", () => {
    const sid = "str-check-session";
    makeSession(sid, { files_read: 3, greps: 2, edits: 1 });
    const result = compact.build_manifest(sid);
    expect(typeof result).toBe("string");
  });
});

// ---------------------------------------------------------------------------
// compact.build_manifest — delta-cache (item #19)
// ---------------------------------------------------------------------------

describe("TestManifestDeltaCache", () => {
  it("test_first_call_returns_full_manifest", () => {
    const sid = "delta-first-call";
    session.mark_file_edited(sid, "/proj/src/auth.py");
    const result = compact.build_manifest(sid);
    expect(result.includes("## Token-Goat Session Manifest")).toBe(true);
    const cache = session.load(sid);
    expect(cache.last_manifest_sha).not.toBe("");
    expect(cache.last_manifest_ts).toBeGreaterThan(0.0);
  });

  it("test_second_call_no_changes_returns_stub", () => {
    const sid = "delta-no-change";
    session.mark_file_edited(sid, "/proj/src/utils.py");
    const first = compact.build_manifest(sid);
    expect(first.includes("## Token-Goat Session Manifest")).toBe(true);
    clearProcessGuard(sid);
    const second = compact.build_manifest(sid);
    expect(second.includes("unchanged since")).toBe(true);
    expect(second.includes("## Token-Goat Session Manifest")).toBe(false);
  });

  it("test_second_call_after_read_count_change_returns_full", () => {
    const sid = "delta-read-count-change";
    session.mark_file_read(sid, "/proj/src/app.py", 0, 50);
    const first = compact.build_manifest(sid);
    expect(first.includes("## Token-Goat Session Manifest")).toBe(true);

    const cache = session.load(sid);
    const only_file = Object.values(cache.files)[0]!;
    only_file.read_count += 1;
    session.save(cache);

    clearProcessGuard(sid);
    const second = compact.build_manifest(sid);
    expect(second.includes("## Token-Goat Session Manifest")).toBe(true);
    expect(second.includes("unchanged since")).toBe(false);
  });

  it("test_second_call_with_new_edit_returns_full", () => {
    const sid = "delta-with-edit";
    session.mark_file_edited(sid, "/proj/src/api.py");
    const first = compact.build_manifest(sid);
    expect(first.includes("## Token-Goat Session Manifest")).toBe(true);
    session.mark_file_edited(sid, "/proj/src/new_file.py");
    clearProcessGuard(sid);
    const second = compact.build_manifest(sid);
    expect(second.includes("## Token-Goat Session Manifest")).toBe(true);
    expect(second.includes("unchanged since")).toBe(false);
  });

  it("test_second_call_after_ttl_returns_full", async () => {
    const sid = "delta-ttl-expired";
    session.mark_file_edited(sid, "/proj/src/worker.py");
    const first = compact.build_manifest(sid);
    expect(first.includes("## Token-Goat Session Manifest")).toBe(true);

    // The TTL is checked against the sidecar file's timestamp. Backdate it.
    const paths = await import("../src/token_goat/paths.js");
    const fs = await import("node:fs");
    const sidecar = paths.manifestShaSidecarPath(sid);
    const data = JSON.parse(fs.readFileSync(sidecar, "utf8")) as Record<string, unknown>;
    data["ts"] = Date.now() / 1000 - 700.0; // 700s > 600s TTL
    fs.writeFileSync(sidecar, JSON.stringify(data), "utf8");
    clearProcessGuard(sid);
    const second = compact.build_manifest(sid);
    expect(second.includes("## Token-Goat Session Manifest")).toBe(true);
    expect(second.includes("unchanged since")).toBe(false);
  });

  it("test_stub_records_age_in_seconds", () => {
    const sid = "delta-age-text";
    session.mark_file_read(sid, "/proj/src/db.py", 0, 50);
    compact.build_manifest(sid);
    clearProcessGuard(sid);
    const stub = compact.build_manifest(sid);
    expect(stub.includes("unchanged since")).toBe(true);
    expect(stub.includes("token-goat compact-hint")).toBe(true);
  });

  it("test_same_process_second_call_returns_full_not_stub", () => {
    const sid = "delta-same-process";
    session.mark_file_edited(sid, "/proj/src/api.py");
    const first = compact.build_manifest(sid);
    expect(first.includes("## Token-Goat Session Manifest")).toBe(true);
    // No guard clear: second call in same process returns full manifest
    const second = compact.build_manifest(sid);
    expect(second.includes("## Token-Goat Session Manifest")).toBe(true);
    expect(second.includes("unchanged since")).toBe(false);
  });
});

describe("TestComputeAdaptiveBudget", () => {
  it("test_empty_session_returns_base_budget", () => {
    const sid = "empty-adaptive-session";
    const cache = session.load(sid);
    const budget = compact.compute_adaptive_budget(cache, 1800);
    expect(budget).toBe(200);
  });

  it("test_one_edited_file_adds_fifty", () => {
    const sid = "one-edit-session";
    session.mark_file_edited(sid, "/proj/a.py");
    const cache = session.load(sid);
    const budget = compact.compute_adaptive_budget(cache, 1800);
    expect(budget).toBe(250);
  });

  it("test_four_edited_files_reaches_edit_cap", () => {
    const sid = "four-edits-session";
    for (let i = 0; i < 4; i++) {
      session.mark_file_edited(sid, `/proj/edit${i}.py`);
    }
    const cache = session.load(sid);
    const budget = compact.compute_adaptive_budget(cache, 1800);
    expect(budget).toBe(400);
  });

  it("test_ten_edited_files_capped_at_edit_limit", () => {
    const sid = "many-edits-session";
    for (let i = 0; i < 10; i++) {
      session.mark_file_edited(sid, `/proj/edit${i}.py`);
    }
    const cache = session.load(sid);
    const budget = compact.compute_adaptive_budget(cache, 1800);
    // 200 base + min(200, 10*50=500) = 200 + 200 = 400
    expect(budget).toBe(400);
  });

  it("test_symbols_accessed_add_bonus", () => {
    const sid = "symbols-session";
    session.mark_file_read(sid, "/proj/a.py", null, null, { symbol: "func_a" });
    session.mark_file_read(sid, "/proj/b.py", null, null, { symbol: "func_b" });
    const cache = session.load(sid);
    const budget = compact.compute_adaptive_budget(cache, 1800);
    // 200 base + (2 files with symbols * 30) = 260
    expect(budget).toBe(260);
  });

  it("test_five_symbol_files_reaches_symbols_cap", () => {
    const sid = "five-symbols-session";
    for (let i = 0; i < 5; i++) {
      session.mark_file_read(sid, `/proj/s${i}.py`, null, null, { symbol: `func_${i}` });
    }
    const cache = session.load(sid);
    const budget = compact.compute_adaptive_budget(cache, 1800);
    expect(budget).toBe(350);
  });

  it("test_many_symbol_files_capped_at_symbols_limit", () => {
    const sid = "many-symbols-session";
    for (let i = 0; i < 10; i++) {
      session.mark_file_read(sid, `/proj/s${i}.py`, null, null, { symbol: `func_${i}` });
    }
    const cache = session.load(sid);
    const budget = compact.compute_adaptive_budget(cache, 1800);
    // 200 base + min(150, 10*30=300) = 350
    expect(budget).toBe(350);
  });

  it("test_bash_history_adds_twenty", () => {
    const sid = "bash-history-session";
    session.mark_bash_run(sid, "cmd_sha_1", "pytest -v", "id123", 1000, 500, 0, false);
    const cache = session.load(sid);
    const budget = compact.compute_adaptive_budget(cache, 1800);
    // 200 base + 20 bash bonus = 220
    expect(budget).toBe(220);
  });

  it("test_complex_session_combines_bonuses", () => {
    const sid = "complex-session";
    session.mark_file_edited(sid, "/proj/edit1.py");
    session.mark_file_edited(sid, "/proj/edit2.py");
    for (let i = 0; i < 3; i++) {
      session.mark_file_read(sid, `/proj/sym${i}.py`, null, null, { symbol: `sym_${i}` });
    }
    session.mark_bash_run(sid, "cmd_sha_2", "pytest", "id456", 1500, 600, 0, false);
    const cache = session.load(sid);
    const budget = compact.compute_adaptive_budget(cache, 1800);
    // 200 + 100 + 90 + 20 = 410
    expect(budget).toBe(410);
  });

  it("test_budget_never_below_minimum", () => {
    const sid = "minimum-session";
    const cache = session.load(sid);
    const budget = compact.compute_adaptive_budget(cache, 1800);
    expect(budget).toBeGreaterThanOrEqual(200);
  });

  it("test_budget_never_exceeds_maximum", () => {
    const sid = "maximum-session";
    for (let i = 0; i < 20; i++) {
      session.mark_file_edited(sid, `/proj/e${i}.py`);
    }
    for (let i = 0; i < 20; i++) {
      session.mark_file_read(sid, `/proj/s${i}.py`, null, null, { symbol: `s${i}` });
    }
    session.mark_bash_run(sid, "cmd_sha_3", "cmd", "id789", 2000, 1000, 1, false);
    const cache = session.load(sid);
    // Use mature tier (x 1.4) to push toward the ceiling
    const budget = compact.compute_adaptive_budget(cache, 7200);
    expect(budget).toBeLessThanOrEqual(800);
  });

  it("test_maximum_budget_example", () => {
    const sid = "max-example-session";
    for (let i = 0; i < 4; i++) {
      session.mark_file_edited(sid, `/proj/e${i}.py`);
    }
    for (let i = 0; i < 5; i++) {
      session.mark_file_read(sid, `/proj/s${i}.py`, null, null, { symbol: `s${i}` });
    }
    session.mark_bash_run(sid, "cmd_sha_4", "pytest", "maxid", 2000, 1000, 0, false);
    const cache = session.load(sid);
    const budget = compact.compute_adaptive_budget(cache, 1800);
    // 200 + min(200, 4*50=200) + min(150, 5*30=150) + 20 = 570
    expect(budget).toBe(570);
  });
});

describe("TestBuildManifestAdaptive", () => {
  it("test_empty_session_returns_empty", () => {
    const result = compact.build_manifest_adaptive("empty-adaptive");
    expect(result).toBe("");
  });

  it("test_adaptive_with_simple_session", () => {
    const sid = "simple-adaptive";
    session.mark_file_edited(sid, "/proj/app.py");
    const result = compact.build_manifest_adaptive(sid);
    expect(result.includes("Token-Goat Session Manifest") || result === "").toBe(true);
  });

  it("test_adaptive_with_complex_session", () => {
    const sid = "complex-adaptive";
    for (let i = 0; i < 3; i++) {
      session.mark_file_edited(sid, `/proj/edit${i}.py`);
    }
    for (let i = 0; i < 4; i++) {
      session.mark_file_read(sid, `/proj/src${i}.py`, null, null, { symbol: `sym_${i}` });
    }
    session.mark_bash_run(sid, "cmd_sha_5", "pytest -v", "bid123", 1500, 800, 0, false);
    const result = compact.build_manifest_adaptive(sid);
    expect(result.includes("Token-Goat Session Manifest")).toBe(true);
  });

  it("test_adaptive_budget_applied_correctly", () => {
    const sid = "budget-check";
    session.mark_file_edited(sid, "/proj/a.py");
    session.mark_file_edited(sid, "/proj/b.py");
    const result = compact.build_manifest_adaptive(sid);
    expect(result.length).toBeLessThanOrEqual(750);
  });

  it("test_adaptive_invalid_session_returns_empty", () => {
    const result = compact.build_manifest_adaptive("x".repeat(300)); // too long
    expect(result).toBe("");
  });
});

describe("TestNoisePathFilter", () => {
  const noisePaths = [
    "/proj/src/foo.pyc",
    "/proj/src/foo.pyo",
    "/proj/build/libfoo.so",
    "C:/proj/foo.dll",
    "/proj/package-lock.json",
    "/proj/uv.lock",
    "/proj/Cargo.lock",
    "/proj/.DS_Store",
    "/proj/Thumbs.db",
    "/proj/src/__pycache__/foo.cpython-311.pyc",
    "/proj/.git/HEAD",
    "/proj/node_modules/react/index.js",
    "/proj/.venv/lib/site-packages/x.py",
    "/proj/.mypy_cache/x.json",
    "/proj/.next/server/chunks/0.js",
    "/proj/.nuxt/dist/app.mjs",
    "/proj/.svelte-kit/output/app.js",
    "/proj/.turbo/log",
    "/proj/target/debug/foo",
    "/proj/.tox/py311/lib/x.py",
    "/proj/.cache/pip/wheels/x.whl",
    "/proj/.parcel-cache/abc.json",
    "/proj/coverage/lcov.info",
    "/proj/.nyc_output/123.json",
    "/proj/mypkg.egg-info/PKG-INFO",
    "/proj/venv/lib/site-packages/numpy/x.py",
    "/proj/.coverage",
    "/proj/coverage.xml",
    "/proj/lcov.info",
    "/proj/worker.pid",
    "/proj/projects/abc.lock",
    "C:\\proj\\__pycache__\\x.py",
    ".improve-state-general.json",
    "/proj/.improve-state-my-feature.json",
    "C:\\proj\\.improve-state-foo.json",
    "improve_commit_msg_foo_2.txt",
    "/tmp/improve_commit_msg_general_1.txt",
    "C:\\tmp\\improve_commit_msg_x.txt",
    "/tmp/anything.py",
    "/tmp/scratch.json",
    "C:/Users/x/AppData/Local/Temp/foo.txt",
    "C:\\Users\\x\\AppData\\Roaming\\bar.json",
  ];
  it.each(noisePaths)("test_noise_path_is_detected[%s]", (path) => {
    expect(compact.is_noise_path(path)).toBe(true);
  });

  const realPaths = [
    "/proj/src/auth.py",
    "/proj/tests/test_x.py",
    "README.md",
    "",
    "C:\\proj\\src\\auth.py",
  ];
  it.each(realPaths)("test_real_source_file_passes[%s]", (path) => {
    expect(compact.is_noise_path(path)).toBe(false);
  });

  it("test_noise_files_excluded_from_manifest", () => {
    const sid = "noise-filter-session-abc";
    session.mark_file_read(sid, "/proj/src/real.py", 0, 50);
    session.mark_file_read(sid, "/proj/src/__pycache__/real.cpython-311.pyc", 0, 50);
    session.mark_file_read(sid, "/proj/uv.lock", 0, 50);
    session.mark_file_read(sid, "/proj/.DS_Store", 0, 50);
    const result = compact.build_manifest(sid);
    expect(result.includes("real.py")).toBe(true);
    expect(result.includes("uv.lock")).toBe(false);
    expect(result.includes(".DS_Store")).toBe(false);
    expect(result.includes("__pycache__")).toBe(false);
  });

  it("test_noise_edits_excluded_from_manifest", () => {
    const sid = "noise-edit-filter-session-abc";
    session.mark_file_edited(sid, "/proj/src/real.py");
    session.mark_file_edited(sid, "/proj/build/.pyc"); // noise extension
    session.mark_file_edited(sid, "/proj/poetry.lock");
    const result = compact.build_manifest(sid);
    expect(result.includes("real.py")).toBe(true);
    expect(result.includes("poetry.lock")).toBe(false);
  });

  it("test_automation_edits_excluded_from_manifest", () => {
    const sid = "noise-automation-session-abc";
    session.mark_file_edited(sid, "/proj/src/real.py");
    session.mark_file_edited(sid, "/tmp/improve_commit_msg_general_1.txt");
    session.mark_file_edited(sid, "/proj/.improve-state-general.json");
    session.mark_file_edited(sid, "C:/Users/x/AppData/Local/Temp/scratch.txt");
    const result = compact.build_manifest(sid);
    expect(result.includes("real.py")).toBe(true);
    expect(result.includes("improve_commit_msg")).toBe(false);
    expect(result.includes("improve-state")).toBe(false);
    expect(result.includes("AppData")).toBe(false);
    expect(result.includes("/tmp/")).toBe(false);
  });
});

describe("TestActivityMarkers", () => {
  it("test_edited_files_prefixed_with_edit_marker", () => {
    const sid = "marker-edit-session-abc";
    session.mark_file_edited(sid, "/proj/src/auth.py");
    const result = compact.build_manifest(sid);
    expect(result.includes("✎")).toBe(true);
  });

  it("test_read_files_prefixed_with_read_marker", () => {
    const sid = "marker-read-session-abc";
    session.mark_file_read(sid, "/proj/src/db.py", 0, 100);
    const result = compact.build_manifest(sid);
    // The read-files prefix is "- → " at line start.
    expect(result.includes("- → ")).toBe(true);
  });

  it("test_manifest_has_legend", () => {
    // Legend only appears when 2+ marker kinds are present (#22).
    const sid = "legend-session-abc";
    session.mark_file_edited(sid, "/proj/src/auth.py");
    session.mark_file_read(sid, "/proj/src/db.py");
    const result = compact.build_manifest(sid);
    expect(result.includes("Legend:")).toBe(true);
  });
});

describe("TestFormatRanges", () => {
  // session._UNKNOWN_END_SENTINEL is module-private (not exported); its value is
  // 99_999 (mirrored by compact._FULL_READ_SENTINEL_GAP). Inlined here.
  const _UNKNOWN_END_SENTINEL = 99_999;

  it("test_sentinel_range_annotated_as_full", () => {
    const sentinel_end = 1 + _UNKNOWN_END_SENTINEL;
    const result = compact._format_ranges([[1, sentinel_end]]);
    expect(result).toBe("  (full)");
  });

  it("test_partial_ranges_still_shown", () => {
    const result = compact._format_ranges([[10, 50]]);
    expect(result.includes("10-50")).toBe(true);
  });

  it("test_sentinel_wins_over_partial_ranges", () => {
    const sentinel_end = 1 + _UNKNOWN_END_SENTINEL;
    const result = compact._format_ranges([
      [1, sentinel_end],
      [200, 300],
    ]);
    expect(result).toBe("  (full)");
    expect(result.includes("200-300")).toBe(false);
    expect(result.includes("100000")).toBe(false);
  });

  it("test_build_manifest_full_annotation_appears", () => {
    const sid = "sentinel-e2e-session-abc";
    session.mark_file_read(sid, "/proj/src/big.py");
    const result = compact.build_manifest(sid);
    expect(result.includes("big.py")).toBe(true);
    expect(result.includes("(full)")).toBe(true);
    expect(result.includes("100000")).toBe(false);
  });
});

describe("TestKeyFilesRecencySort", () => {
  it("test_more_recently_read_file_appears_first_when_counts_tie", () => {
    const sid = "recency-sort-session-abc";
    const spy = mockMonotonicNow();
    // Both files read exactly once — order must be by recency, not insertion.
    session.mark_file_read(sid, "/proj/src/older.py", 0, 50);
    session.mark_file_read(sid, "/proj/src/newer.py", 0, 50);
    spy.mockRestore();
    const result = compact.build_manifest(sid);
    expect(result.includes("older.py") && result.includes("newer.py")).toBe(true);
    expect(result.indexOf("newer.py")).toBeLessThan(result.indexOf("older.py"));
  });

  it("test_higher_read_count_still_wins_over_recency", () => {
    const sid = "count-beats-recency-session-abc";
    const spy = mockMonotonicNow();
    for (let i = 0; i < 3; i++) {
      session.mark_file_read(sid, "/proj/src/frequent.py", 0, 50);
    }
    session.mark_file_read(sid, "/proj/src/rare.py", 0, 50);
    spy.mockRestore();
    const result = compact.build_manifest(sid);
    expect(result.indexOf("frequent.py")).toBeLessThan(result.indexOf("rare.py"));
  });
});

describe("TestGrepSection", () => {
  it("test_grep_section_present_when_greps_exist", () => {
    const sid = "grep-section-session-abc";
    session.mark_grep(sid, "mark_file_read", "/proj/src");
    const result = compact.build_manifest(sid);
    expect(result.includes("**Patterns Searched:**")).toBe(true);
    expect(result.includes("mark_file_read")).toBe(true);
  });

  it("test_grep_section_absent_when_no_greps", () => {
    const sid = "no-grep-session-abc";
    session.mark_file_read(sid, "/proj/src/db.py", 0, 100);
    const result = compact.build_manifest(sid);
    expect(result.includes("**Patterns Searched:**")).toBe(false);
  });

  it("test_grep_section_includes_path_scope", () => {
    const sid = "grep-path-session-abc";
    session.mark_grep(sid, "shrink", "/proj/src/token_goat");
    const result = compact.build_manifest(sid);
    expect(result.includes("shrink")).toBe(true);
    expect(result.includes("token_goat")).toBe(true);
  });

  it("test_grep_section_deduplicates_same_pattern", () => {
    const sid = "grep-dedup-session-abc";
    for (let i = 0; i < 4; i++) {
      session.mark_grep(sid, "duplicate_pattern", "/proj/src");
    }
    const result = compact.build_manifest(sid);
    expect(result.split("duplicate_pattern").length - 1).toBe(1);
  });

  it("test_grep_dedup_by_pattern_ignores_different_paths", () => {
    const sid = "grep-scope-dedup-session-abc";
    const spy = mockMonotonicNow();
    session.mark_grep(sid, "find_me", "/proj/src");
    session.mark_grep(sid, "find_me", "/proj/tests");
    // Mock must stay active through build_manifest (see test_grep_most_recent_shown_first).
    const result = compact.build_manifest(sid);
    spy.mockRestore();
    expect(result.split("find_me").length - 1).toBe(1);
  });

  it("test_grep_result_count_shown_when_available", () => {
    const sid = "grep-count-session-abc";
    session.mark_grep(sid, "needle", "/proj/src", 7);
    const result = compact.build_manifest(sid);
    // Item #3: bare ``(N)``.
    expect(result.includes("(7)")).toBe(true);
  });

  it("test_grep_zero_result_count_shown", () => {
    const sid = "grep-zero-session-abc";
    session.mark_grep(sid, "dead_end", "/proj/src", 0);
    const result = compact.build_manifest(sid);
    expect(result.includes("(0)")).toBe(true);
  });

  it("test_grep_result_count_singular", () => {
    const sid = "grep-singular-session-abc";
    session.mark_grep(sid, "unique_hit", "/proj/src", 1);
    const result = compact.build_manifest(sid);
    expect(result.includes("(1)")).toBe(true);
    expect(result.includes("1 result")).toBe(false);
  });

  it("test_grep_no_count_when_unknown", () => {
    const sid = "grep-no-count-session-abc";
    session.mark_grep(sid, "unknown_count", "/proj/src", null);
    const result = compact.build_manifest(sid);
    expect(result.includes("unknown_count")).toBe(true);
    const grep_line = result.split("\n").find((ln) => ln.includes("unknown_count")) ?? "";
    const tail = grep_line.includes("unknown_count") ? grep_line.split("unknown_count")[1]! : "";
    expect(tail.includes("(")).toBe(false);
  });

  it("test_grep_most_recent_shown_first", () => {
    const sid = "grep-recency-session-abc";
    const spy = mockMonotonicNow();
    session.mark_grep(sid, "old_pattern", "/proj/src");
    session.mark_grep(sid, "new_pattern", "/proj/src");
    // Keep the clock mock active THROUGH build_manifest — Python's monkeypatch
    // undoes at test teardown, not before build_manifest, so the manifest's
    // staleness filter sees these greps as fresh (ts ≈ now). Restoring early
    // makes them look ~24 years stale and they get filtered out.
    const result = compact.build_manifest(sid);
    spy.mockRestore();
    expect(result.indexOf("new_pattern")).toBeLessThan(result.indexOf("old_pattern"));
  });

  it("test_grep_stale_patterns_filtered_from_manifest", () => {
    const sid = "grep-staleness-session-abc";
    const stale_age = 3 * 3600 + 60; // 3 hours + 1 minute
    session.mark_grep(sid, "stale_pattern", "/proj/src");

    const cache = session.load(sid);
    if (cache && cache.greps.length > 0) {
      const stale_grep = cache.greps[0]!;
      stale_grep.ts = Date.now() / 1000 - stale_age;
      session.save(cache);
    }

    session.mark_grep(sid, "fresh_pattern", "/proj/src");
    const result = compact.build_manifest(sid);
    expect(result.includes("fresh_pattern")).toBe(true);
    expect(result.includes("stale_pattern")).toBe(false);
  });

  it("test_grep_fresh_patterns_included_in_manifest", () => {
    const sid = "grep-fresh-session-abc";
    session.mark_grep(sid, "fresh_pattern", "/proj/src");
    const result = compact.build_manifest(sid);
    expect(result.includes("fresh_pattern")).toBe(true);
  });

  it("test_grep_dedup_by_pattern_keeps_most_recent", () => {
    // Monotonically increasing fake timestamps via Date.now spy.
    let ts = 1000.0;
    const spy = vi.spyOn(Date, "now").mockImplementation(() => {
      ts += 1.0;
      return ts * 1000;
    });

    const sid = "grep-dedup-most-recent-abc";
    session.mark_grep(sid, "target_fn", "/proj/src", 3);
    session.mark_grep(sid, "target_fn", "/proj/tests", 7);
    spy.mockRestore();

    const result = compact.build_manifest(sid);
    expect(result.split("target_fn").length - 1).toBe(1);
    expect(result.includes("(7)")).toBe(true);
  });

  it("test_grep_stale_45min_dropped_fresh_kept", () => {
    const sid = "grep-stale-45min-abc";
    session.mark_grep(sid, "old_search", "/proj/src");
    const stale_age = 2700 + 120; // 47 min
    const cache = session.load(sid);
    cache.greps[cache.greps.length - 1]!.ts = Date.now() / 1000 - stale_age;
    session.save(cache);

    session.mark_grep(sid, "new_search", "/proj/src");
    const result = compact.build_manifest(sid);
    expect(result.includes("new_search")).toBe(true);
    expect(result.includes("old_search")).toBe(false);
  });

  it("test_grep_all_stale_keeps_two_most_recent", () => {
    const sid = "grep-all-stale-fallback-abc";
    const patterns = ["oldest", "middle", "newest"];
    for (const pat of patterns) {
      session.mark_grep(sid, pat, "/proj/src");
    }

    const cache = session.load(sid);
    const now = Date.now() / 1000;
    const ages = [3600 * 3, 3600 * 2, 3600]; // 3h, 2h, 1h — all stale
    const last3 = cache.greps.slice(-3);
    for (let i = 0; i < last3.length && i < ages.length; i++) {
      last3[i]!.ts = now - ages[i]!;
    }
    session.save(cache);

    const result = compact.build_manifest(sid);
    expect(result.includes("newest")).toBe(true);
    expect(result.includes("middle")).toBe(true);
    expect(result.includes("oldest")).toBe(false);
  });

  it("test_grep_high_match_count_ranked_above_low_match_similar_age", () => {
    const sid = "grep-match-rank-abc";
    const spy = mockMonotonicNow();
    session.mark_grep(sid, "rich_search", "/proj/src", 50);
    session.mark_grep(sid, "thin_search", "/proj/src", 1);

    // Mock must stay active through build_manifest (see test_grep_most_recent_shown_first).
    const result = compact.build_manifest(sid);
    spy.mockRestore();
    expect(result.includes("rich_search")).toBe(true);
    expect(result.includes("thin_search")).toBe(true);
    expect(result.indexOf("rich_search")).toBeLessThan(result.indexOf("thin_search"));
  });

  it("test_grep_zero_results_filtered_out", () => {
    const sid = "grep-zero-filter-abc";
    session.mark_grep(sid, "real_pattern", "/proj/src", 5);
    session.mark_grep(sid, "dead_pattern", "/proj/src", 0);
    const result = compact.build_manifest(sid);
    expect(result.includes("real_pattern")).toBe(true);
    expect(result.includes("dead_pattern")).toBe(false);
  });

  it("test_grep_all_zero_results_still_surface", () => {
    const sid = "grep-all-zero-abc";
    session.mark_grep(sid, "blank_one", "/proj/src", 0);
    session.mark_grep(sid, "blank_two", "/proj/src", 0);
    const result = compact.build_manifest(sid);
    expect(result.includes("blank_one") || result.includes("blank_two")).toBe(true);
  });

  it("test_grep_section_omitted_when_all_zero_and_session_mature", () => {
    // #35: all-zero + session >5 min old -> drop the Patterns Searched section.
    const sid = "grep-all-zero-mature-abc";
    session.mark_grep(sid, "blank_alpha", "/proj/src", 0);
    session.mark_grep(sid, "blank_beta", "/proj/src", 0);

    const cache = session.load(sid);
    cache.created_ts = Date.now() / 1000 - 400; // 6 min 40 s old
    session.save(cache);

    // Python patched compact._get_git_diff_stat[_summary]; here cwd is null so
    // both already no-op (see file header).
    const result = compact.build_manifest(sid);
    expect(result.includes("**Patterns Searched:**")).toBe(false);
  });

  it("test_grep_section_kept_when_all_zero_but_session_young", () => {
    const sid = "grep-all-zero-young-abc";
    session.mark_grep(sid, "blank_x", "/proj/src", 0);
    // Session is fresh — created_ts defaults to now, so age < 5 min.
    const result = compact.build_manifest(sid);
    expect(result.includes("**Patterns Searched:**")).toBe(true);
  });

  it("test_grep_overflow_count_excludes_filtered_entries", () => {
    const sid = "grep-overflow-count-abc";
    session.mark_grep(sid, "live_pattern", "/proj/src", 5);

    const stale_ts = Date.now() / 1000 - (3 * 3600 + 60);
    for (let i = 0; i < 5; i++) {
      session.mark_grep(sid, `stale_pattern_${i}`, "/proj/src", 1);
    }
    const cache = session.load(sid);
    for (const grep of cache.greps.slice(1)) {
      // index 0 is live_pattern
      grep.ts = stale_ts;
    }
    session.save(cache);

    const result = compact.build_manifest(sid);
    expect(result.includes("live_pattern")).toBe(true);
    expect(result.includes("more patterns")).toBe(false);
  });
});

describe("TestColdOutputs", () => {
  it("test_failed_command_not_in_cold_outputs", () => {
    const sid = "cold-failed-session-abc";
    const old_ts = Date.now() / 1000 - 1801; // 30 min + 1 s
    session.mark_bash_run(sid, "cmd_sha_failed", "pytest --tb=short", "failed_id_001", 1000, 500, 1, false);

    const cache = session.load(sid);
    cache.created_ts = Date.now() / 1000 - 7200; // 2 hours -> mature tier
    if (cache.bash_history) {
      for (const bash_entry of Object.values(cache.bash_history)) {
        if (bash_entry.output_id === "failed_id_001") {
          bash_entry.ts = old_ts;
        }
      }
    }
    session.save(cache);

    const result = compact.build_manifest(sid);
    // Item #11: header is the bold-label "**Cold:**".
    expect(!result.includes("**Cold:**") || !result.includes("failed_id_001")).toBe(true);
  });

  it("test_successful_cold_command_in_cold_outputs", () => {
    const sid = "cold-success-session-abc";
    const old_ts = Date.now() / 1000 - 1801; // 30 min + 1 s
    const runs: Array<[string, string, string]> = [
      ["cmd_sha_success", "pytest", "success_id_001"],
      ["cmd_sha_success2", "ruff check", "success_id_002"],
    ];
    for (const [sha, cmd, oid] of runs) {
      session.mark_bash_run(sid, sha, cmd, oid, 1000, 0, 0, false);
    }

    const cache = session.load(sid);
    cache.created_ts = Date.now() / 1000 - 7200; // 2 hours -> mature tier
    if (cache.bash_history) {
      for (const bash_entry of Object.values(cache.bash_history)) {
        bash_entry.ts = old_ts;
      }
    }
    session.save(cache);

    const result = compact.build_manifest(sid, { max_tokens: 800 });
    expect(result.includes("**Cold:**")).toBe(true);
    expect(result.includes(short_output_id("success_id_001"))).toBe(true);
  });
});

describe("TestDedupAcrossSections", () => {
  it("test_edited_file_not_repeated_in_key_files_read", () => {
    const sid = "dedup-session-abc";
    for (let i = 0; i < 5; i++) {
      session.mark_file_read(sid, "/proj/src/shared.py", 0, 100);
    }
    session.mark_file_edited(sid, "/proj/src/shared.py");
    const result = compact.build_manifest(sid);
    let body = result;
    if (result.includes("<</preserve>>")) {
      body = result.slice(result.indexOf("<</preserve>>") + "<</preserve>>".length);
    }
    expect(body.split("shared.py").length - 1).toBe(1);
  });
});

describe("TestBlockerDedupFromBashHistory", () => {
  // PORT: deferred — imports token_goat.bash_cache (command_hash); bash_cache.ts
  // is not ported at this layer.
  it.skip("test_failed_command_appears_once", () => {
    // PORT: deferred — bash_cache not yet ported.
  });
});

describe("TestDedupHintEmittedIdsFilterBash", () => {
  // PORT: deferred — imports token_goat.bash_cache (command_hash); bash_cache.ts
  // is not ported at this layer.
  it.skip("test_dedup_hinted_entry_absent_from_manifest", () => {
    // PORT: deferred — bash_cache not yet ported.
  });

  // PORT: deferred — imports token_goat.bash_cache (command_hash); bash_cache.ts
  // is not ported at this layer.
  it.skip("test_dedup_hinted_but_blocker_still_present", () => {
    // PORT: deferred — bash_cache not yet ported.
  });

  // The three header tests below belong to this class (the missing `class
  // TestSectionHeaders:` line in the Python source leaves them as methods of
  // TestDedupHintEmittedIdsFilterBash). They do NOT use bash_cache, so they are
  // ported. Python monkeypatched compact._get_git_diff_stat[_summary]; cwd is
  // null here so both already no-op (see file header).
  it("test_files_edited_header_has_no_preserve_suffix", () => {
    const sid = "header-no-preserve-abc";
    session.mark_file_edited(sid, "/proj/src/compact.py");
    const result = compact.build_manifest(sid);
    expect(result.includes("**Staged/Uncommitted:**") || result.includes("**Edited:**")).toBe(true);
    expect(result.includes("**Edited:** (preserve)")).toBe(false);
  });

  it("test_commands_run_header_has_no_cached_qualifier", () => {
    const sid = "header-no-cached-output-abc";
    const cache = session.load(sid);
    const be = new BashEntry({
      cmd_sha: "aabbccdd",
      cmd_preview: "pytest tests/",
      output_id: "aabbccdd",
      ts: Date.now() / 1000 - 700,
      exit_code: 0,
      stdout_bytes: 1200,
      stderr_bytes: 0,
    });
    cache.bash_history = { aabbccdd: be };
    cache.created_ts = Date.now() / 1000 - 700;
    session.save(cache);
    const result = compact.build_manifest(sid);
    expect(result.includes("**Recent Commands:**")).toBe(true);
    expect(result.includes("(cached output)")).toBe(false);
  });

  it("test_web_fetches_header_has_no_cached_qualifier", () => {
    const sid = "header-no-cached-body-abc";
    const cache = session.load(sid);
    const now = Date.now() / 1000;
    cache.created_ts = now - 1200;
    const we1 = new WebEntry({
      url_sha: "we000001",
      url_preview: "https://docs.example.com/api",
      output_id: "we000001",
      ts: now - 600,
      status_code: 200,
      body_bytes: 2000,
    });
    const we2 = new WebEntry({
      url_sha: "we000002",
      url_preview: "https://other.example.org/ref",
      output_id: "we000002",
      ts: now - 500,
      status_code: 200,
      body_bytes: 1800,
    });
    cache.web_history = { we000001: we1, we000002: we2 };
    session.save(cache);
    const result = compact.build_manifest(sid);
    expect(result.includes("**Web Fetches:**")).toBe(true);
    expect(result.includes("(cached body)")).toBe(false);
  });
});

describe("TestLegendSuppression", () => {
  it("test_legend_prefix_dropped_for_single_marker_kind", () => {
    const sid = "legend-single-kind-abc";
    session.mark_file_edited(sid, "/proj/src/foo.py");
    const result = compact.build_manifest(sid);
    expect(result.includes("foo.py")).toBe(true);
    expect(result.includes("edited=✎")).toBe(true);
    expect(result.includes("Legend:")).toBe(false);
  });

  it("test_legend_present_for_multiple_marker_kinds", () => {
    const sid = "legend-multi-kind-abc";
    session.mark_file_edited(sid, "/proj/src/bar.py");
    session.mark_file_read(sid, "/proj/src/utils.py");
    const result = compact.build_manifest(sid);
    expect(result.includes("Legend:")).toBe(true);
  });
});

describe("TestComputeAdaptiveBudgetDiffBonus", () => {
  it("test_diff_bonus_adds_fifty_tokens", () => {
    const sid = "diff-bonus-test-abc";
    session.mark_file_read(sid, "/proj/src/a.py");
    const cache = session.load(sid);

    const age = 1800.0; // active tier -> factor 1.0, so delta is unscaled
    const budget_without = compact.compute_adaptive_budget(cache, age, { has_pending_diff: false });
    const budget_with = compact.compute_adaptive_budget(cache, age, { has_pending_diff: true });
    expect(budget_with).toBe(budget_without + 50);
  });

  it("test_diff_bonus_false_by_default", () => {
    const sid = "diff-bonus-default-test-abc";
    session.mark_file_read(sid, "/proj/src/b.py");
    const cache = session.load(sid);

    const age = 1800.0;
    const budget_default = compact.compute_adaptive_budget(cache, age);
    const budget_explicit = compact.compute_adaptive_budget(cache, age, { has_pending_diff: false });
    expect(budget_default).toBe(budget_explicit);
  });
});
