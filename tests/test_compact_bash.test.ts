/**
 * 1:1 port of tests/test_compact_bash.py — the "Commands Run" / Bash-section
 * manifest tests.
 *
 * Each Python `class Test*` maps to a vitest `describe(...)`; each `def test_*`
 * maps to an `it(...)` with the SAME name and the SAME assertion polarity.
 *
 * ---------------------------------------------------------------------------
 * Mapping notes (Python -> TS)
 * ---------------------------------------------------------------------------
 *  - `_make_session` (conftest) -> the local `makeSession()` helper. The Python
 *    fixture computes the per-command hash via `bash_cache.command_hash(cmd)`.
 *    bash_cache.ts is NOT ported, and compact.ts does not consume command_hash
 *    (the _BashCacheModule seam exposes only load_output / get_recent_error_
 *    outputs). The hash is purely an internal session-history key, so the port
 *    uses a deterministic local `commandHash()` (cache_common.short_content_hash
 *    over the raw command). The same helper is reused by the three tests that
 *    reference `bash_cache.command_hash` directly (blk-3, blk-5, noop-5) so the
 *    history-key lookup matches what makeSession stored. The exact hash VALUE
 *    differs from Python's (Python normalises the command first), but no ported
 *    assertion depends on the literal sha — only on per-command stability.
 *
 *  - bash_cache fail-soft. The Python make_session writes only history entries
 *    (mark_bash_run); it never caches the command OUTPUT to disk, so the real
 *    bash_cache.load_output returns None for every entry. compact.ts's null
 *    bash_cache resolver (_getBashCache() -> null when no override is injected)
 *    reproduces that exactly: no inline snippet, no blocker error-preview,
 *    no test-failure extraction. The manifest-render tests therefore inject NO
 *    stub — the null path IS the faithful equivalent of Python's empty real
 *    cache. (Reported in parity_notes.)
 *
 *  - Direct cache mutation (blk-3, blk-5): `session.load(sid)` returns a freshly
 *    deserialized cache whose `_json_cache` is null, so mutating a field then
 *    `session.save(cache)` re-serializes fresh — no manual _invalidate needed
 *    (matches the shipped TestColdOutputs pattern in test_compact.test.ts).
 *    object.__setattr__(entry, "ts", ...) -> a plain `entry.ts = ...` assignment.
 *
 *  - Per-test tmp data dir + cache clearing is handled by tests/setup.ts (the
 *    tmp_data_dir autouse-fixture analogue).
 *
 * ---------------------------------------------------------------------------
 * Deferred / skipped (counted honestly, never silently dropped)
 * ---------------------------------------------------------------------------
 *  - bash_compress.ts is NOT ported at this layer. Every test that does
 *    `from token_goat import bash_compress` is skipped with a PORT reason:
 *    TestAnsiStrippingInTokenCap (2), TestFilterChainEdgeCases (7),
 *    TestPythonFilter (7) = 16 tests.
 *
 *  - Five compact helpers the Python tests call directly are module-private in
 *    the shipped compact.ts (plain `function`, not exported, not in __all__):
 *    `_select_top_glob_entries`, `_format_glob_entry`, `_select_top_entries`,
 *    `_classify_bash_entry`, `_render_bash_grouped`. This is a PURE TEST PORT —
 *    editing src to widen the export surface is out of scope — so the classes
 *    that exercise only those private functions are skipped with a reason:
 *    TestSelectTopGlobEntries (6), TestFormatGlobEntry (5), TestSelectTopEntries
 *    (9), TestClassifyBashEntry (8), TestRenderBashGrouped (7) = 35 tests.
 *
 *  Totals: 87 Python tests = 36 ported + 51 skipped (16 bash_compress + 35
 *  private-helper).
 */
import { describe, expect, it } from "vitest";

import { createHash } from "node:crypto";

import * as compact from "../src/token_goat/compact.js";
import * as session from "../src/token_goat/session.js";
import { short_output_id } from "../src/token_goat/cache_common.js";
import { BashEntry } from "../src/token_goat/session.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Deterministic per-command hash standing in for the unported
 * `bash_cache.command_hash`. compact.ts never consumes command_hash, so any
 * stable function suffices; the same helper is reused everywhere a Python test
 * referenced `bash_cache.command_hash(cmd)` so the bash_history key matches.
 *
 * cache_common.short_content_hash is sha256(text)[:16]; replicated inline here
 * to avoid coupling to that export's name (it mirrors the Python idiom exactly).
 */
function commandHash(command: string): string {
  return createHash("sha256").update(Buffer.from(command, "utf8")).digest("hex").slice(0, 16);
}

/** Tuple type for bash_runs values: [output_bytes, exit_code]. */
type BashRun = readonly [number, number | null];

/**
 * conftest `_make_session` analogue. Populates a SessionCache with optional
 * backdating, file reads, greps, edits, and bash runs (the kwargs the ported
 * tests use; web_fetches is unused here and omitted).
 */
function makeSession(
  session_id: string,
  opts: {
    age_seconds?: number;
    files_read?: number;
    greps?: number;
    edits?: number;
    bash_runs?: Record<string, BashRun>;
  } = {},
): session.SessionCache {
  const age_seconds = opts.age_seconds ?? 0.0;
  const files_read = opts.files_read ?? 0;
  const greps = opts.greps ?? 0;
  const edits = opts.edits ?? 0;
  const bash_runs = opts.bash_runs ?? null;

  let cache = session.load(session_id);

  if (age_seconds > 0) {
    cache.created_ts = Date.now() / 1000 - age_seconds;
    session.save(cache);
  }

  for (let i = 0; i < files_read; i++) {
    session.mark_file_read(session_id, `/proj/src/file${i}.py`, 0, 100);
  }
  for (let i = 0; i < greps; i++) {
    session.mark_grep(session_id, `pattern${i}`, "/proj/src");
  }
  for (let i = 0; i < edits; i++) {
    session.mark_file_edited(session_id, `/proj/src/edited${i}.py`);
  }

  if (bash_runs) {
    for (const [cmd, run] of Object.entries(bash_runs)) {
      const [output_bytes, exit_code] = run;
      const cmd_sha = commandHash(cmd);
      session.mark_bash_run(
        session_id,
        cmd_sha,
        cmd,
        `out-${cmd_sha}`,
        output_bytes,
        0,
        exit_code,
        false,
      );
    }
  }

  return session.load(session_id);
}

// ===========================================================================
// TestEventCountIncludesBash
// ===========================================================================
describe("TestEventCountIncludesBash", () => {
  it("test_bash_alone_counts", () => {
    const sid = "ec-bash-1";
    makeSession(sid, { bash_runs: { "pytest -v": [8_000, 0] } });
    expect(compact.event_count(sid)).toBe(1);
  });

  it("test_bash_added_to_other_events", () => {
    const sid = "ec-bash-2";
    makeSession(sid, { files_read: 1, bash_runs: { "pytest -v": [8_000, 0] } });
    expect(compact.event_count(sid)).toBe(2);
  });
});

// ===========================================================================
// TestManifestBashSection
// ===========================================================================
describe("TestManifestBashSection", () => {
  it("test_bash_section_emitted", () => {
    const sid = "mb-1";
    // A failed run goes to "**Blocked:**"; a successful run goes to
    // "**Recent Commands:**". Both must appear for this test to pass.
    makeSession(sid, {
      age_seconds: 7200,
      edits: 1,
      bash_runs: {
        "pytest -v tests/": [12000, 1], // failed -> Current Blockers
        "uv run ruff check src/": [5000, 0], // success -> Commands Run
      },
    });
    const m = compact.build_manifest(sid, { max_tokens: 600 });
    expect(m.includes("**Blocked:**")).toBe(true);
    expect(m.includes("pytest -v tests/")).toBe(true);
    expect(m.includes("exit 1")).toBe(true); // blocker format uses full "exit X"
    expect(m.includes("**Recent Commands:**")).toBe(true);
    expect(m.includes("ruff check")).toBe(true);
    // Exit code metadata appears in Commands Run for the successful run.
    expect(m.includes("e=0")).toBe(true);
  });

  it("test_tiny_bash_skipped", () => {
    const sid = "mb-2";
    makeSession(sid, { edits: 1, bash_runs: { ls: [20, 0] } });
    const m = compact.build_manifest(sid, { max_tokens: 400 });
    // Output too small to be useful — section omitted.
    expect(m.includes("**Recent Commands:**")).toBe(false);
  });

  it("test_only_bash_still_renders_manifest", () => {
    const sid = "mb-3";
    // Even when nothing was read or edited, a meaningful Bash output alone
    // should produce a manifest. Either outcome is acceptable; what we guard
    // against is a crash.
    makeSession(sid, { bash_runs: { "make build": [20000, 0] } });
    const m = compact.build_manifest(sid, { max_tokens: 400 });
    expect(typeof m === "string").toBe(true);
  });

  it("test_humanize_bytes", () => {
    expect(compact._humanize_bytes(120)).toBe("120B");
    expect(compact._humanize_bytes(2048).startsWith("2.0KB")).toBe(true);
    expect(compact._humanize_bytes(5 * 1024 * 1024).startsWith("5.0MB")).toBe(true);
  });
});

// ===========================================================================
// TestNoopBashFiltering
// ===========================================================================
describe("TestNoopBashFiltering", () => {
  it("test_git_status_filtered_from_manifest", () => {
    // git status commands consume budget with zero compaction value.
    const sid = "noop-1";
    makeSession(sid, {
      age_seconds: 7200,
      edits: 1,
      bash_runs: {
        "pytest -v tests/": [12000, 0],
        "git status": [5000, 0],
      },
    });
    const m = compact.build_manifest(sid, { max_tokens: 400 });
    // pytest should appear, git status should not
    expect(m.includes("pytest -v tests/")).toBe(true);
    expect(m.includes("git status")).toBe(false);
  });

  it("test_pwd_filtered_from_manifest", () => {
    // pwd is a no-op (< 5 chars, inaudible).
    const sid = "noop-2";
    makeSession(sid, {
      age_seconds: 7200,
      edits: 1,
      bash_runs: { pytest: [12000, 0], pwd: [1000, 0] },
    });
    const m = compact.build_manifest(sid, { max_tokens: 400 });
    expect(m.includes("pytest")).toBe(true);
    expect(m.includes("pwd")).toBe(false);
  });

  it("test_echo_filtered_from_manifest", () => {
    // echo is a no-op.
    const sid = "noop-3";
    makeSession(sid, {
      age_seconds: 7200,
      edits: 1,
      bash_runs: { "npm test": [8000, 0], "echo hello": [500, 0] },
    });
    const m = compact.build_manifest(sid, { max_tokens: 400 });
    expect(m.includes("npm test")).toBe(true);
    expect(m.includes("echo hello")).toBe(false);
  });

  it("test_cat_with_tiny_output_filtered", () => {
    // cat on small files (< 200 bytes) is inaudible.
    const sid = "noop-4";
    makeSession(sid, {
      age_seconds: 7200,
      edits: 1,
      bash_runs: { pytest: [8000, 0], "cat config.txt": [100, 0] },
    });
    const m = compact.build_manifest(sid, { max_tokens: 400 });
    expect(m.includes("pytest")).toBe(true);
    expect(m.includes("cat config.txt")).toBe(false);
  });

  it("test_cat_with_large_output_not_filtered", () => {
    // cat on larger files (>= 200 bytes) may be useful.
    const sid = "noop-5";
    makeSession(sid, {
      age_seconds: 7200,
      edits: 1,
      bash_runs: { pytest: [8000, 0], "cat large_log.txt": [2000, 0] },
    });
    const m = compact.build_manifest(sid, { max_tokens: 400 });
    expect(m.includes("pytest")).toBe(true);
    // cat with large output passes the filter (may or may not appear based on
    // budget). The key is it's not filtered as a no-op.
    const cat_sha = commandHash("cat large_log.txt");
    const short_cat_id = `id=${short_output_id(`out-${cat_sha}`)}`;
    // Either it appears or budget constraints exclude it, but not the no-op filter.
    expect(m.includes("cat large_log.txt") || !m.includes(short_cat_id)).toBe(true);
  });
});

// ===========================================================================
// TestAnsiStrippingInTokenCap — PORT: deferred (bash_compress not ported)
// ===========================================================================
describe("TestAnsiStrippingInTokenCap", () => {
  // PORT: deferred — token_goat.bash_compress (cap_tokens / strip_ansi) is not
  // ported at this layer.
  it.skip("test_ansi_stripped_before_token_measurement", () => {});
  it.skip("test_clean_text_token_cap_still_works", () => {});
});

// ===========================================================================
// TestCurrentBlockersSection
// ===========================================================================
describe("TestCurrentBlockersSection", () => {
  it("test_recent_failure_produces_blockers_section", () => {
    // A recent failed command surfaces in a 'Current Blockers' section.
    const sid = "blk-1";
    makeSession(sid, {
      age_seconds: 7200,
      edits: 1,
      bash_runs: { "pytest tests/": [8000, 1] },
    });
    const m = compact.build_manifest(sid, { max_tokens: 400 });
    expect(m.includes("**Blocked:**")).toBe(true);
    expect(m.includes("pytest tests/")).toBe(true);
    expect(m.includes("exit 1")).toBe(true);
  });

  it("test_no_failures_omits_blockers_header", () => {
    // When all commands succeeded, 'Current Blockers' header is absent.
    const sid = "blk-2";
    makeSession(sid, {
      age_seconds: 7200,
      edits: 1,
      bash_runs: { "pytest tests/": [8000, 0] },
    });
    const m = compact.build_manifest(sid, { max_tokens: 400 });
    expect(m.includes("**Blocked:**")).toBe(false);
  });

  it("test_stale_failure_omits_blockers_header", () => {
    // A failure older than 60 minutes is not treated as an active blocker.
    const sid = "blk-3";
    makeSession(sid, {
      age_seconds: 7200,
      edits: 1,
      bash_runs: { "make build": [8000, 2] },
    });
    const cache = session.load(sid);
    const sha = commandHash("make build");
    const entry = cache.bash_history[sha]!;
    // Mutate the timestamp to 90 minutes in the past.
    entry.ts = Date.now() / 1000 - 5400;
    session.save(cache);
    const m = compact.build_manifest(sid, { max_tokens: 400 });
    expect(m.includes("**Blocked:**")).toBe(false);
  });

  it("test_unknown_exit_code_not_treated_as_blocker", () => {
    // Commands with exit_code=None (unknown) are not surfaced as blockers.
    const sid = "blk-4";
    makeSession(sid, {
      age_seconds: 7200,
      edits: 1,
      bash_runs: { "cargo build": [8000, null] },
    });
    const m = compact.build_manifest(sid, { max_tokens: 400 });
    expect(m.includes("**Blocked:**")).toBe(false);
  });

  it("test_blockers_appear_before_edited_files", () => {
    // Current Blockers section must precede Files Edited in the manifest.
    const sid = "blk-5";
    // Use a non-noise path so the Files Edited section actually appears.
    session.mark_file_edited(sid, "/home/user/project/src/module.py");
    const cache = session.load(sid);
    cache.created_ts = Date.now() / 1000 - 7200;
    session.save(cache);
    const cmd_sha = commandHash("pytest tests/");
    session.mark_bash_run(
      sid,
      cmd_sha,
      "pytest tests/",
      `out-${cmd_sha}`,
      8000,
      0,
      1,
      false,
    );
    const m = compact.build_manifest(sid, { max_tokens: 400 });
    expect(m.includes("**Blocked:**")).toBe(true);
    // Uncommitted edits show as Staged/Uncommitted; committed show as Edited.
    const edited_header = m.includes("**Staged/Uncommitted:**")
      ? "**Staged/Uncommitted:**"
      : "**Edited:**";
    expect(m.includes(edited_header)).toBe(true);
    const blockers_pos = m.indexOf("**Blocked:**");
    const edited_pos = m.indexOf(edited_header);
    expect(blockers_pos < edited_pos).toBe(true);
  });

  it("test_success_exit_zero_not_a_blocker", () => {
    // exit_code=0 is never a blocker regardless of output size.
    const sid = "blk-6";
    makeSession(sid, {
      age_seconds: 7200,
      edits: 1,
      bash_runs: { "npm install": [50000, 0] },
    });
    const m = compact.build_manifest(sid, { max_tokens: 400 });
    expect(m.includes("**Blocked:**")).toBe(false);
  });

  it("test_multiple_failures_capped_at_three", () => {
    // At most 3 blocker entries are shown even when more commands failed.
    const sid = "blk-7";
    const bash_runs: Record<string, BashRun> = {};
    for (let i = 0; i < 5; i++) {
      bash_runs[`pytest test_${i}.py`] = [5000, 1];
    }
    makeSession(sid, { age_seconds: 7200, edits: 1, bash_runs });
    const m = compact.build_manifest(sid, { max_tokens: 800 });
    // Count occurrences of the failure marker in the blockers section.
    const lines = m.split("\n");
    const blocker_section_lines: string[] = [];
    let in_blockers = false;
    for (const line of lines) {
      if (line.startsWith("**Blocked:**")) {
        in_blockers = true;
        continue;
      }
      if (in_blockers && line.startsWith("**")) {
        break;
      }
      if (in_blockers && line.startsWith("- ✗")) {
        blocker_section_lines.push(line);
      }
    }
    expect(blocker_section_lines.length).toBeLessThanOrEqual(3);
  });

  it("test_blocker_format_includes_exit_code", () => {
    // Each blocker line shows the command preview and exit code.
    const sid = "blk-8";
    makeSession(sid, {
      age_seconds: 7200,
      edits: 1,
      bash_runs: { "mypy src/": [6000, 2] },
    });
    const m = compact.build_manifest(sid, { max_tokens: 400 });
    expect(m.includes("✗ mypy src/")).toBe(true);
    expect(m.includes("exit 2")).toBe(true);
  });
});

// ===========================================================================
// TestFilterChainEdgeCases — PORT: deferred (bash_compress not ported)
// ===========================================================================
describe("TestFilterChainEdgeCases", () => {
  // PORT: deferred — token_goat.bash_compress (Filter / PythonFilter / cap_tokens
  // / strip_ansi / DEFAULT_MAX_BYTES) is not ported at this layer.
  it.skip("test_filter_chain_near_cap_output", () => {});
  it.skip("test_stderr_only_output_through_filter_chain", () => {});
  it.skip("test_combined_stdout_stderr_near_cap", () => {});
  it.skip("test_empty_output_through_filter_chain", () => {});
  it.skip("test_ansi_heavy_output_measured_after_strip", () => {});
  it.skip("test_python_filter_passthrough_non_python", () => {});
  it.skip("test_python_filter_multiple_tracebacks", () => {});
});

// ===========================================================================
// TestPythonFilter — PORT: deferred (bash_compress not ported)
// ===========================================================================
describe("TestPythonFilter", () => {
  // PORT: deferred — token_goat.bash_compress.PythonFilter is not ported at this
  // layer.
  it.skip("test_traceback_compression_keeps_innermost_frame", () => {});
  it.skip("test_traceback_over_10_frames_keeps_first_and_last", () => {});
  it.skip("test_repeated_lines_deduplicated", () => {});
  it.skip("test_warning_spam_compression", () => {});
  it.skip("test_python_filter_matches_python_binary", () => {});
  it.skip("test_python_filter_does_not_match_non_python", () => {});
  it.skip("test_empty_traceback_passthrough", () => {});
});

// ===========================================================================
// TestFormatBashEntryRunCount
// ===========================================================================
describe("TestFormatBashEntryRunCount", () => {
  // _format_bash_entry shows [×N] when run_count > 1.
  function makeEntry(run_count = 1, exit_code: number | null = 0): BashEntry {
    return new BashEntry({
      cmd_sha: "abc123",
      cmd_preview: "pytest -v tests/",
      output_id: "out-abc123",
      ts: 0.0,
      stdout_bytes: 5000,
      stderr_bytes: 0,
      exit_code,
      truncated: false,
      run_count,
    });
  }

  it("test_run_count_1_no_marker", () => {
    const line = compact._format_bash_entry(makeEntry(1));
    expect(line.includes("[×")).toBe(false);
    expect(line.includes("pytest -v tests/")).toBe(true);
  });

  it("test_run_count_3_shows_marker", () => {
    const line = compact._format_bash_entry(makeEntry(3));
    expect(line.includes("[×3]")).toBe(true);
    expect(line.includes("pytest -v tests/")).toBe(true);
  });

  it("test_run_count_10_shows_marker", () => {
    const line = compact._format_bash_entry(makeEntry(10));
    expect(line.includes("[×10]")).toBe(true);
  });

  it("test_run_count_marker_before_parens", () => {
    const line = compact._format_bash_entry(makeEntry(5, 1));
    // Marker appears between the command preview and the parenthesised metadata.
    const marker_pos = line.indexOf("[×5]");
    const paren_pos = line.indexOf("(e=1");
    expect(marker_pos < paren_pos).toBe(true);
  });
});

// ===========================================================================
// TestSelectTopGlobEntries — PORT: deferred (private compact helper)
// ===========================================================================
describe("TestSelectTopGlobEntries", () => {
  // PORT: deferred — compact._select_top_glob_entries is module-private in the
  // shipped TS port (not exported / not in __all__); a pure test port must not
  // widen src's export surface.
  it.skip("test_empty_list_returns_empty", () => {});
  it.skip("test_none_returns_empty", () => {});
  it.skip("test_trivial_patterns_excluded", () => {});
  it.skip("test_non_trivial_patterns_included", () => {});
  it.skip("test_caps_at_max_glob_entries", () => {});
  it.skip("test_returns_most_recent", () => {});
});

// ===========================================================================
// TestFormatGlobEntry — PORT: deferred (private compact helper)
// ===========================================================================
describe("TestFormatGlobEntry", () => {
  // PORT: deferred — compact._format_glob_entry is module-private in the shipped
  // TS port (not exported / not in __all__).
  it.skip("test_pattern_only", () => {});
  it.skip("test_with_path_scope", () => {});
  it.skip("test_with_result_count", () => {});
  it.skip("test_with_path_and_count", () => {});
  it.skip("test_no_count_when_none", () => {});
});

// ===========================================================================
// TestSelectTopEntries — PORT: deferred (private compact helper)
// ===========================================================================
describe("TestSelectTopEntries", () => {
  // PORT: deferred — compact._select_top_entries is module-private in the shipped
  // TS port (not exported / not in __all__).
  it.skip("test_non_dict_input_returns_empty", () => {});
  it.skip("test_empty_dict_returns_empty", () => {});
  it.skip("test_below_min_bytes_filtered", () => {});
  it.skip("test_above_min_bytes_included", () => {});
  it.skip("test_exclude_fn_removes_entries", () => {});
  it.skip("test_exclude_fn_none_keeps_all", () => {});
  it.skip("test_max_n_caps_result", () => {});
  it.skip("test_returns_most_recent_by_ts", () => {});
  it.skip("test_missing_ts_defaults_to_zero", () => {});
});

// ===========================================================================
// TestMiddleTruncate
// ===========================================================================
describe("TestMiddleTruncate", () => {
  // Unit tests for compact._middle_truncate.
  it("test_short_text_unchanged", () => {
    // Text with fewer lines than max_lines is returned verbatim.
    const text = Array.from({ length: 10 }, (_v, i) => `line ${i}`).join("\n");
    expect(compact._middle_truncate(text, 20)).toBe(text);
  });

  it("test_exact_max_lines_unchanged", () => {
    // Text with exactly max_lines lines is returned verbatim.
    const text = Array.from({ length: 20 }, (_v, i) => `line ${i}`).join("\n");
    expect(compact._middle_truncate(text, 20)).toBe(text);
  });

  it("test_long_output_truncated", () => {
    // Text exceeding max_lines is truncated to fewer lines than the original.
    const text = Array.from({ length: 50 }, (_v, i) => `line ${i}`).join("\n");
    const result = compact._middle_truncate(text, 20);
    expect(result.split("\n").length).toBeLessThan(50);
  });

  it("test_omission_marker_present", () => {
    // Middle-truncated output contains the omission marker.
    const text = Array.from({ length: 50 }, (_v, i) => `line ${i}`).join("\n");
    const result = compact._middle_truncate(text, 20);
    expect(result.includes("lines omitted")).toBe(true);
  });

  it("test_first_and_last_lines_preserved", () => {
    // The very first and very last lines of the input survive truncation.
    const lines = Array.from({ length: 50 }, (_v, i) => `line ${i}`);
    const text = lines.join("\n");
    const result = compact._middle_truncate(text, 20);
    const result_lines = result.split("\n");
    expect(result_lines[0]).toBe(lines[0]);
    expect(result_lines[result_lines.length - 1]).toBe(lines[lines.length - 1]);
  });

  it("test_omitted_count_correct", () => {
    // The marker accurately reports how many lines were dropped.
    const n = 50;
    const max_lines = 20;
    const keep = Math.ceil(max_lines * 0.4);
    const expected_omitted = n - keep * 2;
    const text = Array.from({ length: n }, (_v, i) => `line ${i}`).join("\n");
    const result = compact._middle_truncate(text, max_lines);
    expect(result.includes(`[${expected_omitted} lines omitted]`)).toBe(true);
  });
});

// ===========================================================================
// TestFormatBashEntryInlineSnippet
// ===========================================================================
describe("TestFormatBashEntryInlineSnippet", () => {
  // _format_bash_entry inline_snippet parameter controls snippet emission.
  function makeEntry(
    stdout_bytes = 5000,
    exit_code: number | null = 0,
    output_id = "out-abc123",
  ): BashEntry {
    return new BashEntry({
      cmd_sha: "abc123",
      cmd_preview: "pytest -v tests/",
      output_id,
      ts: 0.0,
      stdout_bytes,
      stderr_bytes: 0,
      exit_code,
      truncated: false,
      run_count: 1,
    });
  }

  it("test_inline_snippet_false_no_indented_block", () => {
    // When inline_snippet=False the rendered entry has no indented body.
    const entry = makeEntry();
    const line = compact._format_bash_entry(entry, false);
    expect(line.includes("\n  ")).toBe(false);
  });

  it("test_inline_snippet_false_header_still_present", () => {
    // Header line (command preview + metadata) is always emitted regardless of
    // inline_snippet.
    const entry = makeEntry();
    const line = compact._format_bash_entry(entry, false);
    expect(line.includes("pytest -v tests/")).toBe(true);
    expect(line.includes("e=0")).toBe(true); // exit code metadata present
  });

  it("test_inline_snippet_true_default_behaviour_preserved", () => {
    // inline_snippet=True (the default) preserves existing rendering path.
    const entry = makeEntry();
    const line_default = compact._format_bash_entry(entry);
    const line_true = compact._format_bash_entry(entry, true);
    expect(line_default).toBe(line_true);
  });

  it("test_inline_snippet_false_single_line", () => {
    // inline_snippet=False always returns exactly one line.
    const entry = makeEntry(50_000);
    const line = compact._format_bash_entry(entry, false);
    expect(line.includes("\n")).toBe(false);
  });

  it("test_small_entry_no_snippet_in_manifest", () => {
    // Commands under 600 bytes get no inline snippet in the manifest. The entry
    // still appears (header line) but without an indented block.
    const sid = "snip-small-1";
    makeSession(sid, {
      age_seconds: 7200,
      edits: 1,
      bash_runs: { "uv run ruff check src/": [500, 0] },
    });
    const m = compact.build_manifest(sid, { max_tokens: 800 });
    expect(m.includes("ruff check")).toBe(true);
    // No indented snippet block — every line after the header must start with
    // "- " or "###" (manifest structure), not "  " (snippet indent).
    const lines = m.split("\n");
    let in_commands_run = false;
    for (const line of lines) {
      if (line.startsWith("**Recent Commands:**")) {
        in_commands_run = true;
        continue;
      }
      if (in_commands_run && line.startsWith("**")) {
        break;
      }
      if (in_commands_run && line.startsWith("  ") && line.trim()) {
        throw new Error(`Found indented snippet for small (<600B) entry: ${JSON.stringify(line)}`);
      }
    }
  });

  it("test_large_entry_gets_snippet_in_manifest", () => {
    // Commands >= 600 bytes include inline snippet in the manifest.
    const sid = "snip-large-1";
    makeSession(sid, {
      age_seconds: 7200,
      edits: 1,
      bash_runs: { "uv run pytest tests/": [8000, 0] },
    });
    const m = compact.build_manifest(sid, { max_tokens: 1200 });
    expect(m.includes("pytest tests/")).toBe(true);
    // The bash_cache for this test session won't have real file content, so the
    // snippet may not appear even for large entries — what matters is no crash
    // and the header line is present.
    expect(m.includes("e=0") || m.includes("e=?")).toBe(true);
  });

  it("test_blocker_always_inline_regardless_of_size", () => {
    // Blocker entries (exit_code != 0) always emit the inline_snippet=True path.
    // Blockers appear in the Current Blockers section (not Commands Run), so this
    // test validates that build_manifest does not crash and the blocker itself is
    // present.
    const sid = "snip-blk-1";
    makeSession(sid, {
      age_seconds: 7200,
      edits: 1,
      bash_runs: { "pytest tests/": [450, 1] }, // small but failing
    });
    const m = compact.build_manifest(sid, { max_tokens: 800 });
    expect(m.includes("**Blocked:**")).toBe(true);
    expect(m.includes("pytest tests/")).toBe(true);
    expect(m.includes("exit 1")).toBe(true);
  });
});

// ===========================================================================
// TestClassifyBashEntry — PORT: deferred (private compact helper)
// ===========================================================================
describe("TestClassifyBashEntry", () => {
  // PORT: deferred — compact._classify_bash_entry is module-private in the
  // shipped TS port (not exported / not in __all__). BashEntry also has no
  // elapsed_ms field in the TS session model, so the slow/ok cases are
  // unreachable without the private function.
  it.skip("test_failed_when_exit_nonzero", () => {});
  it.skip("test_failed_when_exit_negative", () => {});
  it.skip("test_ok_when_exit_zero_and_fast", () => {});
  it.skip("test_ok_when_exit_unknown", () => {});
  it.skip("test_slow_when_exit_zero_and_elapsed_above_threshold", () => {});
  it.skip("test_ok_when_exit_zero_at_threshold", () => {});
  it.skip("test_failed_overrides_slow", () => {});
  it.skip("test_missing_elapsed_fields_defaults_ok", () => {});
});

// ===========================================================================
// TestRenderBashGrouped — PORT: deferred (private compact helper)
// ===========================================================================
describe("TestRenderBashGrouped", () => {
  // PORT: deferred — compact._render_bash_grouped is module-private in the
  // shipped TS port (not exported / not in __all__).
  it.skip("test_only_failed_entries_emit_failed_header", () => {});
  it.skip("test_mixed_failed_and_ok_no_slow_header", () => {});
  it.skip("test_all_ok_omits_ok_subheader", () => {});
  it.skip("test_all_three_groups_emit_in_priority_order", () => {});
  it.skip("test_empty_entries_returns_empty_output", () => {});
  it.skip("test_zero_budget_emits_nothing", () => {});
  it.skip("test_preserves_within_group_order", () => {});
});
