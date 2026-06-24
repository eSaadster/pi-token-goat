/**
 * 1:1 port of tests/test_compact_advanced.py — advanced compact features added
 * in improvement iteration 27:
 *   1. Progressive section dropping (truncate-before-drop in safety trim).
 *   2. _compute_budget_multiplier (adaptive budget escalation).
 *   3. Manifest fingerprint improvement (edited_count + bash_count in payload).
 *   4. Symbol cross-reference hints in the recovery hint (DEFERRED — see below).
 *   5. Safety-trim drop order — overflow guard completeness.
 *
 * Each Python `class Test*` maps to a vitest `describe(...)`; each `def test_*`
 * maps to an `it(...)` with the SAME name and the SAME assertion polarity.
 *
 * ---------------------------------------------------------------------------
 * Mapping / parity notes (Python -> TS)
 * ---------------------------------------------------------------------------
 *  - compact.<fn>                       -> the statically-imported `compact`
 *    namespace. _apply_section_line_cap / _compute_budget_multiplier /
 *    _compute_manifest_fingerprint are all exported (`export function ...`).
 *
 *  - compact_test_helpers (Python module) -> the local builders below
 *    (makeBashEntry / makeBashHistory / makeFileEntry / makeCache). The Python
 *    helpers build MagicMock objects; the TS compact reads attributes via
 *    getattr-style accessors (_attr/_isDict/Object.entries), so plain objects
 *    with the same own-enumerable fields are faithful stand-ins. _make_cache's
 *    MagicMock auto-populates every history field with {}/[]/set() defaults; the
 *    TS makeCache mirrors those exact defaults.
 *
 *  - bash_cache seam: TestComputeBudgetMultiplier has two tests that
 *    `patch("token_goat.bash_cache.load_output", ...)`. bash_cache.ts is not
 *    ported, but compact.ts exposes the `_setBashCacheModule` injection seam (the
 *    port mirror of Python's lazy `from . import bash_cache`). Those tests inject
 *    a stub bash_cache via `compact._setBashCacheModule({...})` (cleared in
 *    afterEach) implementing only `load_output` (+ a no-op `get_recent_error_
 *    outputs` to satisfy the seam interface). The seam reproduces the patched-
 *    loader behaviour faithfully, so they are ported, not skipped.
 *
 *  - TestRecoveryHintSymbols (6 tests): every test calls
 *    `token_goat.hooks_session._build_recovery_hint`. hooks_session.ts is NOT
 *    ported at this layer (no module on disk), and the mock returns are
 *    load-bearing, so all 6 are `it.skip(...)` with a PORT note + counted.
 *
 *  - test_open_questions_dropped_before_bash: Python patches
 *    `compact._find_open_questions` and relies on `build_manifest_with_count`
 *    calling it through the module namespace. The TS `_render` invokes
 *    `_find_open_questions` via a LOCAL binding (compact.ts:5288), which a
 *    vi.spyOn on the ESM namespace cannot intercept (the ESM self-reference
 *    limitation). The mock return is load-bearing (it injects the questions the
 *    open_questions section needs to fire), so the ordering scenario cannot be
 *    driven faithfully without an injection seam. It is `it.skip(...)` with a
 *    PORT note + counted.
 *
 *  - Source-inspection tests (test_droppable_names_covers_all_unprotected_
 *    sections + the three ordering tests): Python uses
 *    `inspect.getsource(compact._render)` then regex-greps the list literal. TS
 *    has no per-function source introspection, so the twin reads the
 *    compact.ts SOURCE file from disk (resolved relative to this test via
 *    import.meta.url) and applies the same regex to the
 *    `_droppable_names_in_drop_order = [...]` literal. The TS literal uses
 *    double-quoted strings ("open_questions", ...), matching the Python regex
 *    `"([^"]+)"` exactly.
 *
 * Per-test tmp data dir + cache clearing is handled by tests/setup.ts.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import * as compact from "../src/token_goat/compact.js";
import * as session from "../src/token_goat/session.js";

// ---------------------------------------------------------------------------
// compact_test_helpers analogues (plain objects standing in for MagicMock).
// ---------------------------------------------------------------------------

/** time.time() analogue (float seconds). */
function _time(): number {
  return Date.now() / 1000;
}

interface BashEntryLike {
  cmd_preview: string;
  output_id: string;
  exit_code: number;
  ts: number;
  stdout_bytes: number;
  stderr_bytes: number;
  run_count: number;
  truncated: boolean;
  elapsed_ms: number;
}

/**
 * make_bash_entry(cmd_preview, output_id="out-0", *, exit_code, ts, ...).
 * The keyword-only extras map to an opts object; positional output_id keeps its
 * "out-0" default.
 */
function makeBashEntry(
  cmd_preview: string,
  opts: {
    output_id?: string;
    exit_code?: number;
    ts?: number | null;
    stdout_bytes?: number;
    stderr_bytes?: number;
    run_count?: number;
    elapsed_ms?: number;
  } = {},
): BashEntryLike {
  return {
    cmd_preview,
    output_id: opts.output_id ?? "out-0",
    exit_code: opts.exit_code ?? 0,
    ts: opts.ts === undefined || opts.ts === null ? _time() : opts.ts,
    stdout_bytes: opts.stdout_bytes ?? 5000,
    stderr_bytes: opts.stderr_bytes ?? 0,
    run_count: opts.run_count ?? 1,
    truncated: false,
    elapsed_ms: opts.elapsed_ms ?? 0,
  };
}

/** make_bash_history(*entries) -> {"0": e0, "1": e1, ...} keyed by index. */
function makeBashHistory(...entries: BashEntryLike[]): Record<string, BashEntryLike> {
  const out: Record<string, BashEntryLike> = {};
  for (let i = 0; i < entries.length; i++) {
    out[String(i)] = entries[i]!;
  }
  return out;
}

interface FileEntryLike {
  rel_or_abs: string;
  symbols_read: string[];
  symbols_ts: Record<string, number>;
  read_count: number;
  last_read_ts: number;
  last_edit_ts: number;
  line_ranges: Array<[number, number]>;
}

/** make_file_entry(rel_or_abs, *, symbols, read_count, ts, edited). */
function makeFileEntry(
  rel_or_abs: string,
  opts: { symbols?: string[]; read_count?: number; ts?: number | null; edited?: boolean } = {},
): FileEntryLike {
  const _ts = opts.ts === undefined || opts.ts === null ? _time() : opts.ts;
  const symbols = opts.symbols ?? [];
  const symbols_ts: Record<string, number> = {};
  for (const s of symbols) {
    symbols_ts[s] = _ts;
  }
  return {
    rel_or_abs,
    symbols_read: [...symbols],
    symbols_ts,
    read_count: opts.read_count ?? 1,
    last_read_ts: _ts,
    last_edit_ts: opts.edited ? _ts + 100.0 : 0.0,
    line_ranges: [],
  };
}

/**
 * make_cache(**kwargs) — the MagicMock's defaults are {}/[]/set() for every
 * history field; the TS plain object mirrors those exactly so _isDict / Object
 * accessors behave like the Python getattr reads.
 */
interface CacheLike {
  edited_files: Record<string, number> | null;
  bash_history: Record<string, unknown>;
  files: Record<string, unknown>;
  web_history: Record<string, unknown>;
  greps: unknown[];
  glob_history: unknown[];
  skill_history: Record<string, unknown>;
  decisions: unknown[];
  cwd: string | null;
  created_ts: number;
  hints_emitted: number;
  hints_suppressed_by_type: Record<string, number>;
  bash_dedup_emitted_ids: Set<unknown>;
}

function makeCache(
  opts: {
    edited_files?: Record<string, number> | null;
    bash_history?: Record<string, unknown>;
    files?: Record<string, unknown>;
    web_history?: Record<string, unknown>;
    greps?: unknown[];
    glob_history?: unknown[];
    skill_history?: Record<string, unknown>;
    decisions?: unknown[];
    cwd?: string | null;
    created_ts?: number | null;
    hints_emitted?: number;
    hints_suppressed_by_type?: Record<string, number>;
    bash_dedup_emitted_ids?: Set<unknown>;
  } = {},
): CacheLike {
  return {
    edited_files: opts.edited_files !== undefined ? opts.edited_files : {},
    bash_history: opts.bash_history ?? {},
    files: opts.files ?? {},
    web_history: opts.web_history ?? {},
    greps: opts.greps ?? [],
    glob_history: opts.glob_history ?? [],
    skill_history: opts.skill_history ?? {},
    decisions: opts.decisions ?? [],
    cwd: opts.cwd ?? null,
    created_ts: opts.created_ts === undefined || opts.created_ts === null ? _time() : opts.created_ts,
    hints_emitted: opts.hints_emitted ?? 0,
    hints_suppressed_by_type: opts.hints_suppressed_by_type ?? {},
    bash_dedup_emitted_ids: opts.bash_dedup_emitted_ids ?? new Set(),
  };
}

/** _make_plain_bash_entry — plain dict that passes through the fingerprint. */
function makePlainBashEntry(cmd: string, ts = 1_700_000_000.0): Record<string, unknown> {
  return { cmd, ts, exit_code: 0 };
}

afterEach(() => {
  // Clear any injected bash_cache stub so it cannot leak across tests.
  compact._setBashCacheModule(undefined);
});

// ===========================================================================
// 1. Progressive section dropping
// ===========================================================================

describe("TestProgressiveSectionDropping", () => {
  it("test_truncate_before_drop_recovers_budget", () => {
    const lines = ["### Key Files Read"];
    for (let i = 0; i < 20; i++) {
      lines.push(`- file${i}.py  L:1-100`);
    }
    const truncated = compact._apply_section_line_cap(lines, 3);
    expect(truncated.length).toBe(5); // header + 3 items + "+N more"
    expect(truncated[truncated.length - 1]!.startsWith("- ...")).toBe(true);
    expect(truncated[truncated.length - 1]!.includes("+17 more")).toBe(true);
  });

  it("test_section_header_survives_truncation", () => {
    const lines = ["### Grep Patterns"];
    for (let i = 0; i < 10; i++) {
      lines.push(`- pattern${i}`);
    }
    const truncated = compact._apply_section_line_cap(lines, 3);
    expect(truncated[0]).toBe("### Grep Patterns");
  });

  it("test_no_truncation_when_already_fits", () => {
    const lines = ["### Section"];
    for (let i = 0; i < 2; i++) {
      lines.push(`- item${i}`);
    }
    const result = compact._apply_section_line_cap(lines, 3);
    expect(result).toBe(lines); // identity preserved
  });

  it("test_progressive_trim_produces_truncated_section_not_empty", () => {
    const lines = ["### Files Read"];
    for (let i = 0; i < 50; i++) {
      lines.push(`- src/mod${i}.py  L:1-200`);
    }
    const truncated = compact._apply_section_line_cap(lines, 3);
    expect(truncated[0]).toBe("### Files Read");
    const item_lines = truncated.slice(1).filter((ln) => !ln.startsWith("- ..."));
    expect(item_lines.length).toBe(3);
    const overflow_lines = truncated.filter((ln) => ln.startsWith("- ..."));
    expect(overflow_lines.length).toBe(1);
    expect(overflow_lines[0]!.includes("+47 more")).toBe(true);
  });

  it("test_droppable_section_removed_when_truncation_insufficient", () => {
    const lines = ["### Header"];
    for (let i = 0; i < 5; i++) {
      lines.push(`- item${i}`);
    }
    const result = compact._apply_section_line_cap(lines, 0);
    expect(result).toBe(lines); // cap disabled -> unchanged
  });

  it("test_overflow_count_correct", () => {
    const n_items = 15;
    const keep = 3;
    const lines = ["### Header"];
    for (let i = 0; i < n_items; i++) {
      lines.push(`- item${i}`);
    }
    const truncated = compact._apply_section_line_cap(lines, keep);
    const expected_overflow = n_items - keep;
    expect(truncated[truncated.length - 1]!.includes(`+${expected_overflow} more`)).toBe(true);
  });

  it("test_empty_section_unchanged", () => {
    expect(compact._apply_section_line_cap([], 3)).toEqual([]);
  });

  it("test_header_only_section_unchanged", () => {
    const lines = ["### Header"];
    const result = compact._apply_section_line_cap(lines, 3);
    expect(result).toBe(lines);
  });
});

// ===========================================================================
// 2. _compute_budget_multiplier
// ===========================================================================

describe("TestComputeBudgetMultiplier", () => {
  it("test_light_session_returns_base", () => {
    const cache = makeCache({ edited_files: { "file1.py": 1, "file2.py": 2 }, bash_history: {} });
    const result = compact._compute_budget_multiplier(cache as unknown as session.SessionCache, 2.0);
    expect(result).toBe(2.0);
  });

  it("test_many_edited_files_escalates_to_2_5", () => {
    const edited: Record<string, number> = {};
    for (let i = 0; i < 11; i++) {
      edited[`src/file${i}.py`] = i + 1;
    }
    const cache = makeCache({ edited_files: edited, bash_history: {} });
    const result = compact._compute_budget_multiplier(cache as unknown as session.SessionCache, 2.0);
    expect(result).toBe(2.5);
  });

  it("test_exactly_10_edited_files_does_not_escalate", () => {
    const edited: Record<string, number> = {};
    for (let i = 0; i < 10; i++) {
      edited[`src/file${i}.py`] = 1;
    }
    const cache = makeCache({ edited_files: edited, bash_history: {} });
    const result = compact._compute_budget_multiplier(cache as unknown as session.SessionCache, 2.0);
    expect(result).toBe(2.0);
  });

  it("test_many_test_failures_escalates", () => {
    const failureLines: string[] = [];
    for (let i = 0; i < 6; i++) {
      failureLines.push(`FAILED tests/test_mod.py::test_case_${i}`);
    }
    const pytest_output = failureLines.join("\n");
    const be = makeBashEntry("pytest tests/", { exit_code: 1 });
    const bash_hist = makeBashHistory(be);
    const cache = makeCache({ edited_files: {}, bash_history: bash_hist });
    compact._setBashCacheModule({
      load_output: () => pytest_output,
      get_recent_error_outputs: () => [],
    });
    const result = compact._compute_budget_multiplier(cache as unknown as session.SessionCache, 2.0);
    expect(result).toBe(2.5);
  });

  it("test_exactly_5_failures_does_not_escalate", () => {
    const failureLines: string[] = [];
    for (let i = 0; i < 5; i++) {
      failureLines.push(`FAILED tests/test_mod.py::test_case_${i}`);
    }
    const pytest_output = failureLines.join("\n");
    const be = makeBashEntry("pytest tests/", { exit_code: 1 });
    const bash_hist = makeBashHistory(be);
    const cache = makeCache({ edited_files: {}, bash_history: bash_hist });
    compact._setBashCacheModule({
      load_output: () => pytest_output,
      get_recent_error_outputs: () => [],
    });
    const result = compact._compute_budget_multiplier(cache as unknown as session.SessionCache, 2.0);
    expect(result).toBe(2.0);
  });

  it("test_returns_base_when_not_escalated", () => {
    const cache = makeCache({ edited_files: {}, bash_history: {} });
    for (const base of [1.0, 1.5, 2.0, 3.0]) {
      expect(compact._compute_budget_multiplier(cache as unknown as session.SessionCache, base)).toBe(base);
    }
  });

  it("test_escalation_does_not_reduce_high_base", () => {
    const edited: Record<string, number> = {};
    for (let i = 0; i < 20; i++) {
      edited[`file${i}.py`] = 1;
    }
    const cache = makeCache({ edited_files: edited, bash_history: {} });
    const result = compact._compute_budget_multiplier(cache as unknown as session.SessionCache, 3.0);
    expect(result).toBe(3.0); // max(3.0, 2.5) == 3.0
  });

  it("test_empty_edited_files_no_escalation", () => {
    const cache = makeCache({ edited_files: {}, bash_history: {} });
    expect(compact._compute_budget_multiplier(cache as unknown as session.SessionCache, 2.0)).toBe(2.0);
  });

  it("test_non_dict_edited_files_treated_as_zero", () => {
    const cache = makeCache({ bash_history: {} });
    cache.edited_files = null; // override to non-dict
    expect(compact._compute_budget_multiplier(cache as unknown as session.SessionCache, 2.0)).toBe(2.0);
  });
});

// ===========================================================================
// 3. Manifest fingerprint improvement
// ===========================================================================

describe("TestManifestFingerprintImprovement", () => {
  it("test_fingerprint_changes_when_edited_count_increases", () => {
    const cache_a = makeCache({ edited_files: { "a.py": 1 } });
    const cache_b = makeCache({ edited_files: { "a.py": 1, "b.py": 2 } });
    const fp_a = compact._compute_manifest_fingerprint(cache_a as unknown as session.SessionCache);
    const fp_b = compact._compute_manifest_fingerprint(cache_b as unknown as session.SessionCache);
    expect(fp_a).not.toBe(fp_b);
  });

  it("test_fingerprint_changes_when_bash_count_increases", () => {
    const be = makePlainBashEntry("pytest");
    const cache_a = makeCache({ bash_history: {} });
    const cache_b = makeCache({ bash_history: { "0": be } });
    const fp_a = compact._compute_manifest_fingerprint(cache_a as unknown as session.SessionCache);
    const fp_b = compact._compute_manifest_fingerprint(cache_b as unknown as session.SessionCache);
    expect(fp_a).not.toBe(fp_b);
  });

  it("test_fingerprint_stable_for_identical_cache", () => {
    const be = makePlainBashEntry("ruff check", 1_700_000_000.0);
    const cache = makeCache({ edited_files: { "src/foo.py": 3 }, bash_history: { k1: be } });
    const fp1 = compact._compute_manifest_fingerprint(cache as unknown as session.SessionCache);
    const fp2 = compact._compute_manifest_fingerprint(cache as unknown as session.SessionCache);
    expect(fp1).toBe(fp2);
  });

  it("test_fingerprint_is_hex_string_of_expected_length", () => {
    const cache = makeCache();
    const fp = compact._compute_manifest_fingerprint(cache as unknown as session.SessionCache);
    expect(typeof fp).toBe("string");
    expect(fp.length).toBe(16);
    expect([...fp].every((c) => "0123456789abcdef".includes(c))).toBe(true);
  });

  it("test_empty_vs_nonempty_edited_differ", () => {
    const cache_empty = makeCache({ edited_files: {} });
    const cache_one = makeCache({ edited_files: { "x.py": 1 } });
    expect(compact._compute_manifest_fingerprint(cache_empty as unknown as session.SessionCache)).not.toBe(
      compact._compute_manifest_fingerprint(cache_one as unknown as session.SessionCache),
    );
  });

  it("test_empty_vs_nonempty_bash_differ", () => {
    const be = makePlainBashEntry("uv run pytest");
    const cache_empty = makeCache({ bash_history: {} });
    const cache_one = makeCache({ bash_history: { "0": be } });
    expect(compact._compute_manifest_fingerprint(cache_empty as unknown as session.SessionCache)).not.toBe(
      compact._compute_manifest_fingerprint(cache_one as unknown as session.SessionCache),
    );
  });

  it("test_fingerprint_changes_when_file_count_drops", () => {
    const be = makePlainBashEntry("ruff check");
    const cache_two = makeCache({ bash_history: { "0": be, "1": be } });
    const cache_one = makeCache({ bash_history: { "0": be } });
    const fp_two = compact._compute_manifest_fingerprint(cache_two as unknown as session.SessionCache);
    const fp_one = compact._compute_manifest_fingerprint(cache_one as unknown as session.SessionCache);
    expect(fp_two).not.toBe(fp_one);
  });
});

// ===========================================================================
// 4. Symbol cross-reference hints in recovery hint
// ===========================================================================
// PORT: deferred — every test in this class calls
// token_goat.hooks_session._build_recovery_hint; hooks_session.ts is NOT ported
// at this layer (no module on disk) and the patched session/bash_cache returns
// are load-bearing. (Layer N — hooks_session.)

describe("TestRecoveryHintSymbols", () => {
  // PORT: deferred — hooks_session._build_recovery_hint not yet ported (Layer N).
  it.skip("test_symbols_section_present_when_symbols_exist", () => {
    // see PORT note above
  });

  // PORT: deferred — hooks_session._build_recovery_hint not yet ported (Layer N).
  it.skip("test_symbols_section_absent_when_no_symbols", () => {
    // see PORT note above
  });

  // PORT: deferred — hooks_session._build_recovery_hint not yet ported (Layer N).
  it.skip("test_symbols_capped_at_10", () => {
    // see PORT note above
  });

  // PORT: deferred — hooks_session._build_recovery_hint not yet ported (Layer N).
  it.skip("test_symbols_include_filename", () => {
    // see PORT note above
  });

  // PORT: deferred — hooks_session._build_recovery_hint not yet ported (Layer N).
  it.skip("test_symbols_deduped_across_files", () => {
    // see PORT note above
  });

  // PORT: deferred — hooks_session._build_recovery_hint not yet ported (Layer N).
  it.skip("test_recovery_hint_includes_symbols_alongside_bash", () => {
    // see PORT note above
  });
});

// ===========================================================================
// 5. Safety-trim drop order — overflow guard completeness
// ===========================================================================

describe("TestSafetyTrimDropOrder", () => {
  // Resolve the compact.ts SOURCE file relative to this test file. The Python
  // tests use inspect.getsource(compact._render); TS has no per-function source
  // introspection, so we read the source text and regex the list literal — the
  // _droppable_names_in_drop_order list uses double-quoted strings, matching the
  // Python `"([^"]+)"` extraction exactly.
  const _thisDir = path.dirname(fileURLToPath(import.meta.url));
  const _compactSrcPath = path.join(_thisDir, "..", "src", "token_goat", "compact.ts");

  function _renderSource(): string {
    return fs.readFileSync(_compactSrcPath, "utf8");
  }

  function _extractDropOrder(): string[] {
    const src = _renderSource();
    // Find the assignment block: _droppable_names_in_drop_order = [ ... ]
    const match = /_droppable_names_in_drop_order\s*=\s*\[([\s\S]*?)\]/.exec(src);
    expect(match).not.toBeNull();
    const names: string[] = [];
    const nameRe = /"([^"]+)"/g;
    let m: RegExpExecArray | null;
    while ((m = nameRe.exec(match![1]!)) !== null) {
      names.push(m[1]!);
    }
    return names;
  }

  it("test_droppable_names_covers_all_unprotected_sections", () => {
    const src = _renderSource();
    const previously_missing = [
      "open_questions",
      "active_errors",
      "session_goal",
      "most_accessed",
      "recent_commits",
    ];
    for (const name of previously_missing) {
      expect(src.includes(`"${name}"`)).toBe(true);
    }
  });

  // PORT: deferred — Python patches compact._find_open_questions and relies on
  // build_manifest_with_count calling it through the module namespace. The TS
  // _render invokes _find_open_questions via a LOCAL binding (compact.ts:5288),
  // which a vi.spyOn on the ESM namespace cannot intercept (the ESM self-
  // reference limitation). The mock return is load-bearing here — it injects the
  // questions the open_questions section needs to fire — so there is no faithful
  // way to drive the ordering scenario without an injection seam. (Layer N.)
  it.skip("test_open_questions_dropped_before_bash", () => {
    // see PORT note above
  });

  it("test_session_goal_dropped_before_syms", () => {
    const order = _extractDropOrder();
    expect(order.includes("session_goal")).toBe(true);
    expect(order.includes("syms")).toBe(true);
    expect(order.indexOf("session_goal")).toBeLessThan(order.indexOf("syms"));
  });

  it("test_recent_commits_dropped_before_syms", () => {
    const order = _extractDropOrder();
    expect(order.includes("recent_commits")).toBe(true);
    expect(order.includes("syms")).toBe(true);
    expect(order.indexOf("recent_commits")).toBeLessThan(order.indexOf("syms"));
  });

  it("test_active_errors_dropped_before_bash", () => {
    const order = _extractDropOrder();
    expect(order.includes("active_errors")).toBe(true);
    expect(order.includes("bash")).toBe(true);
    expect(order.indexOf("active_errors")).toBeLessThan(order.indexOf("bash"));
  });
});
