/**
 * Regression tests: token budgets for the recovery hint and pre-compact manifest.
 *
 * 1:1 port of tests/test_compaction_size_budgets.py. Each Python `class Test*`
 * maps to a vitest `describe(...)`; each `def test_*` maps to an `it(...)` with
 * the SAME name and the SAME assertion polarity.
 *
 * These tests are guard-rails on top of the existing behaviour suites
 * (test_post_compact_recovery.py and test_compact.py). They lock in the
 * token-savings improvements so a future edit that re-bloats either artifact
 * fails CI before shipping rather than silently eating into the live compaction
 * budget.
 *
 * ---------------------------------------------------------------------------
 * Mapping notes (Python -> TS)
 * ---------------------------------------------------------------------------
 *  - Session-cache fixtures are built with the shipped session.ts API
 *    (mark_file_read / mark_file_edited / mark_grep / mark_bash_run /
 *    mark_web_fetch / load / save). Python kwargs map positionally:
 *      mark_file_read(sid, p, offset=O, limit=L)   -> mark_file_read(sid, p, O, L)
 *      mark_file_read(sid, p, symbol="X")          -> mark_file_read(sid, p, null, null, {symbol:"X"})
 *      mark_bash_run(session_id=sid, cmd_sha=..., cmd_preview=..., output_id=...,
 *                    stdout_bytes=..., stderr_bytes=..., exit_code=..., truncated=...)
 *                                                   -> positional args in the same order
 *      mark_web_fetch(session_id=sid, url_sha=..., url_preview=..., output_id=...,
 *                     body_bytes=..., status_code=..., truncated=...)
 *                                                   -> positional args in the same order
 *      mark_grep(sid, pat, root)                    -> mark_grep(sid, pat, root)
 *  - compact.build_manifest_with_count(sid, max_tokens=N) -> build_manifest_with_count(sid, {max_tokens:N}).
 *  - estimate_tokens: Python imports `from token_goat.repomap import
 *    estimate_tokens`. repomap.ts is NOT ported (Layer 7), but compact.ts
 *    exports its own byte-identical inlined `estimate_tokens`
 *    (max(1, len // 3 + 1)) — the same function the production manifest path
 *    uses. The sibling shipped tests use `compact.estimate_tokens`; this port
 *    does too. Reported in parity_notes.
 *  - `time.time()` -> Date.now() / 1000.
 *  - Per-test tmp data dir + cache clearing is handled by tests/setup.ts
 *    (beforeEach -> setDataDirOverride + clearModuleCaches), the analogue of the
 *    Python tmp_data_dir autouse fixture.
 *
 * Deferred (not-yet-ported dependencies):
 *  - TestRecoveryHintBudget imports `token_goat.hooks_session` and calls
 *    `hooks_session._build_recovery_hint(sid)`. hooks_session.ts is a Layer 5
 *    module not yet ported, and _build_recovery_hint is the load-bearing
 *    code-under-test (no compact.ts seam reproduces it), so both tests are
 *    it.skip with a PORT reason and counted.
 *  - TestUncommittedChangesCap imports `from token_goat.compact import
 *    _get_uncommitted_changes` and calls it directly. In compact.ts
 *    `_get_uncommitted_changes` is module-private (a non-exported `function`,
 *    compact.ts:1250), so it cannot be imported. The single test is it.skip with
 *    a PORT reason and counted.
 */
import { describe, expect, it } from "vitest";

import * as compact from "../src/token_goat/compact.js";
import * as session from "../src/token_goat/session.js";

// ---------------------------------------------------------------------------
// Budgets — adjust deliberately if behaviour intentionally changes.
// ---------------------------------------------------------------------------

// Saturated hint is now hard-capped at 400 tokens by _truncate_recovery_hint
// (reduced from the prior 800-token budget to keep overhead modest).
// Observed ~439 tokens at saturation; 460 gives ~21-token cushion.
const _RECOVERY_HINT_SATURATED_BUDGET = 460;
// Files-only hint is one-line-per-file with no IDs plus ### Key Commands.
// With .py files the Key Commands section adds symbol/read commands too.
// Observed ~218 tokens; 240 gives ~22-token headroom.
const _RECOVERY_HINT_LOPSIDED_BUDGET = 240;
const _MANIFEST_BUDGET = 420; // slack above the 400-token configured ceiling

/** time.time() analogue (float seconds). */
function _time(): number {
  return Date.now() / 1000;
}

// ---------------------------------------------------------------------------
// Recovery-hint budget tests
// ---------------------------------------------------------------------------

describe("TestRecoveryHintBudget", () => {
  // PORT: deferred — token_goat.hooks_session (Layer 5). _build_recovery_hint is
  // the load-bearing code-under-test; hooks_session.ts is not ported and no
  // compact.ts seam reproduces it.
  it.skip("test_saturated_recovery_hint_under_budget", () => {
    // PORT: deferred — hooks_session._build_recovery_hint not yet ported (Layer 5).
  });

  // PORT: deferred — token_goat.hooks_session (Layer 5).
  it.skip("test_lopsided_files_only_hint_under_tighter_budget", () => {
    // PORT: deferred — hooks_session._build_recovery_hint not yet ported (Layer 5).
  });
});

// ---------------------------------------------------------------------------
// Pre-compact manifest budget tests
// ---------------------------------------------------------------------------

/** Populate a session that activates every manifest section. */
function _seed_saturated_manifest_state(sid: string): void {
  // Edited files — top priority, always rendered first.
  for (let i = 0; i < 15; i++) {
    const nn = String(i).padStart(2, "0");
    session.mark_file_edited(sid, `/proj/src/edited_${nn}.py`);
    // Edit-after-read produces the "Outdated File Snapshots" section.
    session.mark_file_read(sid, `/proj/src/edited_${nn}.py`, 0, 40);
  }
  // Symbol reads — produces "**Symbols Accessed:**".
  for (let i = 0; i < 10; i++) {
    const nn = String(i).padStart(2, "0");
    session.mark_file_read(sid, `/proj/src/symbols_${nn}.py`, null, null, {
      symbol: `handle_event_${nn}`,
    });
  }
  // Plain file reads — produces "**Files:**".
  for (let i = 0; i < 15; i++) {
    const nn = String(i).padStart(2, "0");
    session.mark_file_read(sid, `/proj/src/read_${nn}.py`, 0, 100);
  }
  // Grep patterns — produces "**Patterns Searched:**".
  for (let i = 0; i < 10; i++) {
    const nn = String(i).padStart(2, "0");
    session.mark_grep(sid, `distinct_pattern_${nn}`, "/proj/src");
  }
  // Bash history — produces "**Recent Commands:**" and "Cold Outputs".
  for (let i = 0; i < 20; i++) {
    const nn = String(i).padStart(2, "0");
    const cmd_sha = `manishabc${nn}${"x".repeat(8)}`.slice(0, 16);
    session.mark_bash_run(
      sid,
      cmd_sha,
      `cargo test --package goat -- module_${nn}`,
      `${sid.slice(0, 16)}-${String(i).padStart(13, "0")}-${cmd_sha}`,
      6000,
      400,
      0,
      false,
    );
  }
}

describe("TestManifestBudget", () => {
  it("test_saturated_manifest_under_budget", () => {
    const sid = "manifest-budget-saturated";
    _seed_saturated_manifest_state(sid);

    const [manifest] = compact.build_manifest_with_count(sid, { max_tokens: 400 });

    expect(manifest).toBeTruthy(); // saturated session must produce a non-empty manifest
    // The header is the anchor every other test in the project checks too.
    expect(manifest.includes("## Token-Goat Session Manifest")).toBe(true);

    // Highest-priority sections must survive trimming. Lower-priority sections
    // (Patterns Searched / Cold Outputs / Key Files Read / Commands Run) get
    // trimmed off the tail when the 400-token budget binds, which is correct
    // trim-pass behaviour and not a regression — this test only asserts the two
    // sections that always survive regardless of budget pressure.
    // Item 16: when edited/read overlap >= 50%, both sections merge into **Files:**.
    const edited_present = manifest.includes("**Edited:**") || manifest.includes("**Files:**");
    expect(edited_present).toBe(true);
    expect(manifest.includes("**Symbols Accessed:**")).toBe(true);

    const tokens = compact.estimate_tokens(manifest);
    expect(tokens).toBeLessThanOrEqual(_MANIFEST_BUDGET);
  });

  it("test_commands_run_appears_at_larger_budget", () => {
    const sid = "manifest-budget-bash";
    _seed_saturated_manifest_state(sid);
    // Backdate to mature tier (>60 min) so the bash section is not suppressed by
    // the age-tier guard (young sessions skip bash/web sections).
    const cache = session.load(sid);
    cache.created_ts = _time() - 7200;
    session.save(cache);
    // Use a 700-token budget — what compute_adaptive_budget gives a heavily
    // saturated mature session — so bash section is not crowded out.
    const [manifest] = compact.build_manifest_with_count(sid, { max_tokens: 700 });
    expect(manifest.includes("**Recent Commands:**")).toBe(true);
  });

  it("test_manifest_respects_lower_max_tokens", () => {
    const sid = "manifest-budget-tight";
    _seed_saturated_manifest_state(sid);

    const [manifest] = compact.build_manifest_with_count(sid, { max_tokens: 200 });

    expect(manifest).toBeTruthy(); // even a tight manifest must surface something
    const tokens = compact.estimate_tokens(manifest);
    // Allow a small slack for the header + the highest-priority section the trim
    // pass refuses to drop. Slack raised from 240->251: the "# as-of: ..." suffix
    // adds ~11 tokens after trim.
    expect(tokens).toBeLessThanOrEqual(251);
  });
});

// ---------------------------------------------------------------------------
// Section-specific cap enforcement tests
// ---------------------------------------------------------------------------

/**
 * Seed a session with `n_edited` edited files.
 *
 * `name_len` controls path length:
 *  - "short" -> /proj/src/mod_NN.py   (~20 chars)
 *  - "long"  -> /proj/src/very_long_module_name_component_xyz_NN.py  (~52 chars)
 */
function _seed_large_edited_files_session(sid: string, n_edited: number, name_len = "short"): void {
  for (let i = 0; i < n_edited; i++) {
    const nn = String(i).padStart(2, "0");
    const path = name_len === "long"
      ? `/proj/src/very_long_module_name_component_xyz_${nn}.py`
      : `/proj/src/mod_${nn}.py`;
    session.mark_file_edited(sid, path);
  }
}

describe("TestEditedFilesCap", () => {
  // The edited-files section must never individually list more than
  // _MAX_EDITED_FILES_SHOWN entries; excess files get a '+N more' overflow line.

  it("test_overflow_notice_appears_beyond_cap", () => {
    // 50 edited files: only 20 appear by name; overflow line shows +30.
    const sid = "edited-cap-overflow";
    _seed_large_edited_files_session(sid, 50, "short");

    const [manifest] = compact.build_manifest_with_count(sid, { max_tokens: 400 });

    expect(
      manifest.includes("**Staged/Uncommitted:**") ||
        manifest.includes("**Edited:**") ||
        manifest.includes("**Files:**"),
    ).toBe(true);
    const edit_lines = manifest.split("\n").filter((ln) => ln.startsWith("- ✎"));
    expect(edit_lines.length).toBeLessThanOrEqual(20);
    expect(
      manifest.includes("…+") &&
        (manifest.includes("more edited") || manifest.includes("more staged")),
    ).toBe(true);
  });

  it("test_no_overflow_at_exactly_cap", () => {
    // Exactly 20 edited files: all 20 appear, no overflow notice.
    const sid = "edited-cap-exact";
    _seed_large_edited_files_session(sid, 20, "short");

    const [manifest] = compact.build_manifest_with_count(sid, { max_tokens: 400 });

    // Directory grouping collapses same-dir files into one line, so "- ✎" line
    // count may be 0 even when all files are present. Accept either 20 individual
    // lines or a single "(20 files)" grouped entry.
    const edit_lines = manifest.split("\n").filter((ln) => ln.includes("- ✎"));
    const grouped = manifest.split("\n").filter((ln) => ln.includes("(20 files)"));
    expect(edit_lines.length === 20 || grouped.length >= 1).toBe(true);
    expect(manifest.includes("more edited")).toBe(false);
  });

  it("test_large_edited_section_preserves_symbols_section", () => {
    // 30 long-named edited files must not crowd out Symbols Accessed.
    //
    // Before the _MAX_EDITED_FILES_SHOWN cap was added, the uncapped edited-files
    // block consumed the entire 400-token budget, leaving no room for the Symbols
    // Accessed section. This test is the regression guard.
    const sid = "edited-cap-crowdout";
    _seed_large_edited_files_session(sid, 30, "long");
    // Add 8 symbol reads so Symbols Accessed has content to render.
    for (let i = 0; i < 8; i++) {
      const nn = String(i).padStart(2, "0");
      session.mark_file_read(sid, `/proj/src/lib_${nn}.py`, null, null, { symbol: `handle_event_${i}` });
    }

    const [manifest] = compact.build_manifest_with_count(sid, { max_tokens: 400 });

    expect(manifest.includes("**Symbols Accessed:**")).toBe(true);
  });

  it("test_manifest_under_500_tokens_with_50_edited_and_blockers", () => {
    // Hard regression guard: even the worst realistic case stays under 500 tokens.
    //
    // Scenario: 50 edited files with long paths + 3 active blockers + 10 symbol
    // reads + 10 grep patterns, rendered at the default 400-token budget. The
    // safety trim in _render() enforces the global ceiling; this test verifies
    // that ceiling is well below 500 tokens so future additions have a clear red
    // line to trip.
    const sid = "edited-cap-hard-500";
    // 50 long-named edited files — triggers the _MAX_EDITED_FILES_SHOWN cap.
    _seed_large_edited_files_session(sid, 50, "long");
    // 3 failed bash commands (Current Blockers section).
    for (let i = 0; i < 3; i++) {
      const sha = `fail${String(i).padStart(13, "0")}`;
      session.mark_bash_run(
        sid,
        sha,
        `uv run mypy src/token_goat/module_${i}.py --strict`,
        `fail-${String(i).padStart(13, "0")}`,
        800,
        1200,
        1,
        false,
      );
    }
    // 10 symbol reads.
    for (let i = 0; i < 10; i++) {
      const nn = String(i).padStart(2, "0");
      session.mark_file_read(sid, `/proj/src/lib_${nn}.py`, null, null, { symbol: `EventHandler${nn}` });
    }
    // 10 grep patterns.
    for (let i = 0; i < 10; i++) {
      const nn = String(i).padStart(2, "0");
      session.mark_grep(sid, `distinct_pattern_${nn}`, "/proj/src");
    }
    // Mature tier — enables bash/web sections.
    const cache = session.load(sid);
    cache.created_ts = _time() - 7200;
    session.save(cache);

    const [manifest] = compact.build_manifest_with_count(sid, { max_tokens: 400 });

    expect(manifest).toBeTruthy(); // saturated session must produce a non-empty manifest
    const tokens = compact.estimate_tokens(manifest);
    expect(tokens).toBeLessThanOrEqual(500);
  });
});

describe("TestBlockersCap", () => {
  // Current Blockers section must never show more than 3 entries (_MAX_BLOCKER_ENTRIES).

  it("test_blockers_capped_at_three", () => {
    // 6 recent bash failures: manifest shows at most 3 in Current Blockers.
    const sid = "blockers-cap-six";
    for (let i = 0; i < 6; i++) {
      const nn = String(i).padStart(2, "0");
      const sha = `fail${String(i).padStart(13, "0")}`;
      session.mark_bash_run(
        sid,
        sha,
        `uv run pytest tests/test_module_${nn}.py -x`,
        `fail-${String(i).padStart(13, "0")}`,
        500,
        300,
        1,
        false,
      );
    }
    // Backdate so failures are within the 60-min blocker window.
    const cache = session.load(sid);
    cache.created_ts = _time() - 1800;
    session.save(cache);

    const [manifest] = compact.build_manifest_with_count(sid, { max_tokens: 400 });

    const blocker_lines = manifest.split("\n").filter((ln) => ln.startsWith("- ✗"));
    expect(blocker_lines.length).toBeLessThanOrEqual(3);
  });
});

describe("TestUncommittedChangesCap", () => {
  // Uncommitted Changes section is capped at 8 lines / 200 chars inside
  // _get_uncommitted_changes; the manifest never sees an unbounded git diff.

  // PORT: deferred — Python imports `from token_goat.compact import
  // _get_uncommitted_changes` and calls it directly. In compact.ts that helper
  // is module-private (non-exported `function`, compact.ts:1250) so it cannot be
  // imported; the helper IS the load-bearing code-under-test here.
  it.skip("test_uncommitted_section_tokens_are_bounded", () => {
    // PORT: deferred — compact._get_uncommitted_changes is not exported.
  });
});

// ---------------------------------------------------------------------------
// Priority-aware safety-trim tests
// ---------------------------------------------------------------------------

describe("TestPriorityAwareSafetyTrim", () => {
  // When estimate_tokens(manifest) > max_tokens the trim pass drops low-signal
  // sections wholesale before resorting to bottom-line popping.

  it("test_no_orphan_section_header_after_trim", () => {
    // A trim cut must drop a whole section, not just its entries.
    const sid = "trim-no-orphan-header";
    _seed_saturated_manifest_state(sid);

    // Tight budget forces the safety trim path.
    const [manifest] = compact.build_manifest_with_count(sid, { max_tokens: 180 });

    const lines = manifest.split("\n");
    // Known section headers that could orphan.
    const header_markers = [
      "**Files:**",
      "**Patterns Searched:**",
      "**Web Fetches:**",
      "**Symbols Accessed:**",
      "**Recent Commands:**",
      "**Cold:**",
      "**Skills:**",
      "**Decisions:**",
      "### Cold Outputs",
      "### Diff Summary",
      "### Commits This Session",
      "### TODOs",
      "Directory Scans",
    ];
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]!;
      if (!header_markers.some((m) => line.startsWith(m))) {
        continue;
      }
      // Check whether the next non-empty line is content (`- `, `  `, or `#### `)
      // or another header (which means the current one is orphan).
      for (let j = i + 1; j < lines.length; j++) {
        const nxt = lines[j]!;
        if (!nxt.trim()) {
          continue;
        }
        // Content lines start with these prefixes for sections.
        if (
          nxt.startsWith("- ") ||
          nxt.startsWith("  ") ||
          nxt.startsWith("#### ") ||
          nxt.startsWith("**Pending:**")
        ) {
          break; // has content — not orphan
        }
        if (header_markers.some((m) => nxt.startsWith(m))) {
          // Two headers back-to-back — outer is orphan.
          throw new Error(
            `orphan section header at line ${i}: ${JSON.stringify(line)} ` +
              `followed by header at line ${j}: ${JSON.stringify(nxt)}\n` +
              `full manifest:\n${manifest}`,
          );
        }
        // Other content (e.g. Legend, a free text line) — section ended cleanly.
        break;
      }
    }
  });

  it("test_legend_survives_aggressive_trim", () => {
    // When the body uses marker symbols (✎ → ⚠ ❄), the Legend line that explains
    // them must survive even a very tight budget — otherwise the compaction LLM
    // sees orphan symbols with no key.
    const sid = "trim-legend-survives";
    _seed_saturated_manifest_state(sid);

    const [manifest] = compact.build_manifest_with_count(sid, { max_tokens: 200 });
    // Check that if any marker symbol appears in body, the legend appears.
    const markers_in_body = ["✎", "→", "⚠", "❄"].some((sym) => manifest.includes(sym));
    if (markers_in_body) {
      // Either single-marker bare line or "Legend: ..." prefix.
      const legendBares = new Set(["edited=✎", "read=→", "stale=⚠", "cold=❄", "skill=🧠"]);
      const has_legend =
        manifest.includes("Legend: ") ||
        manifest.split("\n").some((line) => legendBares.has(line.trim()));
      expect(has_legend).toBe(true);
    }
  });

  it("test_protected_sections_survive_tight_budget", () => {
    // Sealed block + header + edited files (the highest-signal sections) must
    // always survive the trim, even at a budget too tight for everything.
    const sid = "trim-protected";
    _seed_saturated_manifest_state(sid);

    // +11 vs original 150 to keep effective body_budget at 150 after
    // _AS_OF_TOKEN_RESERVE subtraction.
    const [manifest] = compact.build_manifest_with_count(sid, { max_tokens: 161 });

    expect(manifest).toBeTruthy(); // trimmed manifest must not be empty
    // Sealed block + header anchor every post-compact recovery — never drop.
    expect(manifest.includes("## Token-Goat Session Manifest")).toBe(true);
    // Edited section is protected — must appear in some form.
    expect(
      manifest.includes("**Edited:**") || manifest.includes("**Files:**"), // merged-section variant
    ).toBe(true);
  });

  it("test_low_priority_dropped_before_high", () => {
    // Under budget pressure, low-priority sections (Grep, Files-read, TODOs) must
    // be dropped before high-priority sections (Bash, Stale).
    const sid = "trim-priority-order";
    _seed_saturated_manifest_state(sid);
    // Mature tier so bash section is eligible (young sessions skip it).
    const cache = session.load(sid);
    cache.created_ts = _time() - 7200;
    session.save(cache);

    // Budget tight enough to force *some* drops but not all sections.
    const [manifest] = compact.build_manifest_with_count(sid, { max_tokens: 400 });

    // If Patterns Searched was dropped (low priority), Bash should still be
    // present (higher priority). This guards the priority ordering.
    const grep_dropped = !manifest.includes("**Patterns Searched:**");
    const bash_dropped = !manifest.includes("**Recent Commands:**");
    if (grep_dropped && !bash_dropped) {
      // correct: low dropped first
    } else if (!grep_dropped && bash_dropped) {
      throw new Error(
        "priority inversion: **Recent Commands:** dropped while **Patterns Searched:** survived; " +
          `rendered:\n${manifest}`,
      );
    }
    // else: both present or both absent — both are fine outcomes here.
  });
});
