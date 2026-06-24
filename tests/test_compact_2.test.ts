/**
 * 1:1 port of tests/test_compact.py part 2/6 — classes TestSymbolRankingByRecency
 * through TestSectionBudgets (Python lines ~1553-3113).
 *
 * Each Python `class Test*` maps to a vitest `describe(...)`; each `def test_*`
 * maps to an `it(...)` with the SAME name and the SAME assertion polarity.
 *
 * Mapping notes (Python -> TS):
 *   - compact.<fn>                       -> the statically-imported `compact`
 *     namespace (so vi.spyOn(compact, "fn") is observed).
 *   - session.mark_file_read(sid, p, offset=O, limit=L)   -> mark_file_read(sid, p, O, L)
 *   - session.mark_file_read(sid, p, symbol="X")          -> mark_file_read(sid, p, null, null, {symbol:"X"})
 *   - session.mark_grep(sid, pat, root)                   -> mark_grep(sid, pat, root)
 *   - session.mark_bash_run(sid, sha, cmd, oid, so, se, ec, trunc)
 *                                                          -> mark_bash_run(sid, sha, cmd, oid, so, se, ec, trunc)
 *   - the `cache=cache` batching kwarg                     -> { cache } opt on each mark_*.
 *
 * Deterministic timestamps: the Python tests patch `session.time.time` with an
 * `itertools.count(start, 0.01)` so the strictly-increasing read timestamps make
 * the recency sort deterministic. The TS session reads `Date.now() / 1000`; under
 * a tight loop those reads tie, which would break the recency-ordering assertions.
 * The faithful analogue is a `vi.spyOn(Date, "now")` returning a monotonically
 * increasing counter (see `installMonotonicClock`). It is the direct twin of the
 * Python clock patch and is installed only in the tests that patched the clock.
 *
 * Config override: Python patches `compact._load_config` to bump
 * `wide_session_threshold`. The TS compact module has no `_load_config` seam — it
 * calls `config.load()` directly (static `import * as config`). So the twin is
 * `vi.spyOn(config, "load")` returning the real config with the one field bumped.
 * Reported in parity_notes.
 *
 * bash_cache seam: TestBuildSealedBlock has four tests that
 * `monkeypatch.setattr(bash_cache, "load_output", ...)`. bash_cache.ts is not
 * ported, but compact.ts exposes the `_setBashCacheModule` injection seam (the
 * port mirror of Python's lazy `from . import bash_cache`). Those tests inject a
 * stub bash_cache via `compact._setBashCacheModule({...})` rather than being
 * skipped, since the seam reproduces the patched-loader behaviour faithfully.
 *
 * The orphaned class whose `class` declaration was lost in the Python source
 * (docstring "Token-efficient manifest path display by stripping common
 * prefixes", lines ~2447-2637) is ported under the describe name
 * `TestShortPathStripping` (the only sensible name from its docstring + members).
 *
 * Per-test tmp data dir + cache clearing is handled by tests/setup.ts.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import * as compact from "../src/token_goat/compact.js";
import * as config from "../src/token_goat/config.js";
import * as session from "../src/token_goat/session.js";
import * as db from "../src/token_goat/db.js";
import * as hooks_cli from "../src/token_goat/hooks_cli.js";
import * as paths from "../src/token_goat/paths.js";
import { runGit } from "../src/token_goat/util.js";

import type { ConfigSchema } from "../src/token_goat/types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const _tmpRoots: string[] = [];

/**
 * Unique tmp dir (pytest tmp_path analogue). realpathSync resolves macOS's
 * /var -> /private/var symlink so the path matches what find_project()
 * canonicalises a project root to.
 */
let _tmpCounter = 0;
function tmpPath(): string {
  const dir = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), `tg-compact2-${process.pid}-${_tmpCounter++}-`)),
  );
  _tmpRoots.push(dir);
  return dir;
}

afterEach(() => {
  // Clear any injected bash_cache stub so it cannot leak across tests.
  compact._setBashCacheModule(undefined);
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

/**
 * Install a monotonic Date.now() spy: the TS twin of Python's
 * `itertools.count(start, 0.01)` clock patch. Each session read stamps a strictly
 * increasing `last_read_ts`, making the recency sort deterministic. Returns the
 * spy so callers may inspect/restore it (afterEach also restores all mocks).
 *
 * `start` is in SECONDS (the Python count starts at 1e9 s); Date.now is in ms, so
 * the counter is kept in ms and advanced by 10 ms per call (≈ the 0.01 s step).
 */
function installMonotonicClock(startSeconds = 1_000_000_000.0): void {
  let ms = startSeconds * 1000;
  vi.spyOn(Date, "now").mockImplementation(() => {
    const cur = ms;
    ms += 10;
    return cur;
  });
}

/** Spy config.load so compact sees wide_session_threshold = `n`. */
function patchWideSessionThreshold(n: number): void {
  const real = config.load();
  const patched: ConfigSchema = {
    ...real,
    compact_assist: { ...(real.compact_assist ?? {}), wide_session_threshold: n },
  };
  vi.spyOn(config, "load").mockReturnValue(patched);
}

/**
 * Build a minimal git repo under `parent/name`. Mirrors conftest.make_git_repo
 * (single-commit `files` form). core.hooksPath=/dev/null + commit.gpgsign=false
 * are pinned so a user/global lefthook/gpg does not fire on each commit.
 */
function makeGitRepo(
  parent: string,
  name: string,
  opts: {
    files?: Record<string, string>;
    email?: string;
    user?: string;
    commitMessage?: string;
  } = {},
): string {
  const email = opts.email ?? "t@t.com";
  const user = opts.user ?? "T";
  const commitMessage = opts.commitMessage ?? "init";
  const repo = path.join(parent, name);
  fs.mkdirSync(repo);

  const hooksOff = ["-c", "core.hooksPath=/dev/null"];
  _git([...hooksOff, "init"], repo);
  _git([...hooksOff, "config", "user.email", email], repo);
  _git([...hooksOff, "config", "user.name", user], repo);

  if (opts.files) {
    for (const [rel, content] of Object.entries(opts.files)) {
      const fp = path.join(repo, rel);
      fs.mkdirSync(path.dirname(fp), { recursive: true });
      fs.writeFileSync(fp, content);
    }
    _git([...hooksOff, "add", "."], repo);
    _git([...hooksOff, "-c", "commit.gpgsign=false", "commit", "-m", commitMessage], repo);
  }
  return repo;
}

function _git(args: string[], cwd: string): void {
  const res = runGit(args, { cwd, timeout: 30 });
  if (res.returncode !== 0) {
    throw new Error(`git ${args.join(" ")} failed (${res.returncode}): ${res.stderr}`);
  }
}

/** time.time() analogue (float seconds). */
function _time(): number {
  return Date.now() / 1000;
}

// --- SimpleNamespace-style entry builders (TestBuildSealedBlock helpers). -----
// The Python helpers build types.SimpleNamespace; the TS compact reads attributes
// via getattr-style accessors, so plain objects with the same own-enumerable
// fields are faithful stand-ins.

interface BashEntryLike {
  cmd_preview: string;
  exit_code: number;
  ts: number;
  output_id: string;
  stdout_bytes: number;
  stderr_bytes: number;
}

function makeBashEntry(cmd: string, exit_code: number, ts: number): BashEntryLike {
  return { cmd_preview: cmd, exit_code, ts, output_id: "", stdout_bytes: 500, stderr_bytes: 0 };
}

interface SkillEntryLike {
  skill_name: string;
  ts: number;
  body_bytes: number;
  run_count: number;
  truncated: boolean;
  content_sha?: string;
  output_id?: string;
}

function makeSkillEntry(name: string, ts: number): SkillEntryLike {
  return { skill_name: name, ts, body_bytes: 1024, run_count: 1, truncated: false };
}

/** Spy config.load to return a fake compact_assist config (pre_compact tests). */
function patchConfigLoad(multiplier: number): void {
  const fake_cfg = {
    compact_assist: {
      enabled: true,
      triggers: ["manual", "auto"],
      max_manifest_tokens: 400,
      min_events: 0,
      auto_trigger_multiplier: multiplier,
    },
  } as unknown as ConfigSchema;
  vi.spyOn(config, "load").mockReturnValue(fake_cfg);
}

/** make_fake_session_cache analogue (young session, no history). */
function makeFakeSessionCache(): Record<string, unknown> {
  return {
    created_ts: _time(),
    edited_files: {},
    files: {},
    bash_history: null,
    web_history: null,
  };
}

/**
 * Spy compact.build_manifest_with_count, capturing the second positional arg
 * (the Python `max_tokens` kwarg). pre_compact calls it positionally as
 * `build_manifest_with_count(sessionId, effective_tokens)` — a NUMBER second
 * arg — so the captured value is read from `arguments[1]`. The TS twin of
 * `side_effect=_capture` capturing `max_tokens`.
 */
function spyBuildManifestWithCountCapture(captured: { max_tokens?: number }): void {
  const impl = (..._args: unknown[]): [string, number] => {
    const second = _args[1];
    const v = typeof second === "number" ? second : (second as { max_tokens?: number } | undefined)?.max_tokens;
    if (v !== undefined) {
      captured.max_tokens = v;
    }
    return ["## manifest body", 10];
  };
  vi.spyOn(compact, "build_manifest_with_count").mockImplementation(
    impl as unknown as typeof compact.build_manifest_with_count,
  );
}

// ===========================================================================
// TestSymbolRankingByRecency
// ===========================================================================

describe("TestSymbolRankingByRecency", () => {
  it("test_recent_symbol_file_appears_before_older", () => {
    patchWideSessionThreshold(200);
    installMonotonicClock();

    const sid = "symbol-recency-session-abc";
    // Suppress intermediate saves: batch via the `cache` opt and save once.
    const saveSpy = vi.spyOn(session, "save").mockReturnValue(undefined);
    let cache: session.SessionCache | null = null;
    // Older symbol read
    cache = session.mark_file_read(sid, "/proj/src/older.py", null, null, { symbol: "old_sym", cache });
    // Many intervening files-with-symbols
    for (let i = 0; i < 3; i++) {
      cache = session.mark_file_read(sid, `/proj/src/mid${i}.py`, null, null, { symbol: `mid_sym_${i}`, cache });
    }
    // Most-recent symbol read
    cache = session.mark_file_read(sid, "/proj/src/recent.py", null, null, { symbol: "recent_sym", cache });
    // Padding: heavily-read no-symbol files dominate **Files:**.
    for (let i = 0; i < 16; i++) {
      for (let r = 0; r < 8; r++) {
        cache = session.mark_file_read(sid, `/proj/src/noise${String(i).padStart(2, "0")}.py`, 0, 600, { cache });
      }
    }
    saveSpy.mockRestore();
    if (cache !== null) {
      session.save(cache);
    }

    const result = compact.build_manifest(sid);
    let symbols_section = result.includes("**Symbols Accessed:**")
      ? result.split("**Symbols Accessed:**")[1]!
      : result;
    symbols_section = symbols_section.split("**")[0]!;
    expect(symbols_section.includes("recent.py")).toBe(true);
    expect(symbols_section.includes("older.py")).toBe(true);
    expect(symbols_section.indexOf("recent.py")).toBeLessThan(symbols_section.indexOf("older.py"));
  });

  it("test_edited_file_symbols_appear_before_readonly", () => {
    patchWideSessionThreshold(200);
    installMonotonicClock();

    const sid = "edited-symbols-priority-session";
    const saveSpy = vi.spyOn(session, "save").mockReturnValue(undefined);
    let cache: session.SessionCache | null = null;
    // Read-only file accessed FIRST (older timestamp)
    cache = session.mark_file_read(sid, "/proj/src/readonly.py", null, null, { symbol: "readonly_sym", cache });
    // Edited file accessed SECOND (newer timestamp) with symbols
    cache = session.mark_file_edited(sid, "/proj/src/edited.py", { cache });
    cache = session.mark_file_read(sid, "/proj/src/edited.py", null, null, { symbol: "edited_sym", cache });
    // Padding
    for (let i = 0; i < 16; i++) {
      for (let r = 0; r < 8; r++) {
        cache = session.mark_file_read(sid, `/proj/src/noise${String(i).padStart(2, "0")}.py`, 0, 600, { cache });
      }
    }
    saveSpy.mockRestore();
    if (cache !== null) {
      session.save(cache);
    }

    const result = compact.build_manifest(sid);

    expect(result.includes("edited.py")).toBe(true);

    if (result.includes("**Symbols Accessed:**")) {
      const symbols_section = result.split("**Symbols Accessed:**")[1]!.split("**")[0]!;
      expect(symbols_section.includes("readonly.py")).toBe(true);
      expect(symbols_section.includes("edited_sym")).toBe(false);
    }
  });

  it("test_symbol_order_preserved_within_groups", () => {
    patchWideSessionThreshold(200);
    installMonotonicClock();

    const sid = "symbol-group-order-session";
    const saveSpy = vi.spyOn(session, "save").mockReturnValue(undefined);
    let cache: session.SessionCache | null = null;
    // Read-only files (older)
    cache = session.mark_file_read(sid, "/proj/src/readonly1.py", null, null, { symbol: "ro1_sym", cache });
    cache = session.mark_file_read(sid, "/proj/src/readonly2.py", null, null, { symbol: "ro2_sym", cache });
    // Edited files (newer)
    cache = session.mark_file_edited(sid, "/proj/src/edited1.py", { cache });
    cache = session.mark_file_read(sid, "/proj/src/edited1.py", null, null, { symbol: "ed1_sym", cache });
    cache = session.mark_file_edited(sid, "/proj/src/edited2.py", { cache });
    cache = session.mark_file_read(sid, "/proj/src/edited2.py", null, null, { symbol: "ed2_sym", cache });
    // Padding
    for (let i = 0; i < 16; i++) {
      for (let r = 0; r < 8; r++) {
        cache = session.mark_file_read(sid, `/proj/src/noise${String(i).padStart(2, "0")}.py`, 0, 600, { cache });
      }
    }
    saveSpy.mockRestore();
    if (cache !== null) {
      session.save(cache);
    }

    const result = compact.build_manifest(sid);

    for (const fname of ["edited1.py", "edited2.py"]) {
      expect(result.includes(fname)).toBe(true);
    }

    if (result.includes("**Symbols Accessed:**")) {
      const symbols_section = result.split("**Symbols Accessed:**")[1]!.split("**")[0]!;
      for (const fname of ["readonly1.py", "readonly2.py"]) {
        expect(symbols_section.includes(fname)).toBe(true);
      }
      for (const sym of ["ed1_sym", "ed2_sym"]) {
        expect(symbols_section.includes(sym)).toBe(false);
      }
    }
  });
});

// ===========================================================================
// TestConfigLoad — config.load / config.save
// ===========================================================================

describe("TestConfigLoad", () => {
  it("test_defaults_when_no_file", () => {
    // setup.ts isolates the data dir; configPath points under it with no file.
    const cfg = config.load();
    expect(cfg.compact_assist?.enabled).toBe(true);
    expect(cfg.compact_assist?.triggers).toContain("manual");
    expect(cfg.compact_assist?.triggers).toContain("auto");
    expect(cfg.compact_assist?.min_events).toBe(3);
    expect(cfg.compact_assist?.max_manifest_tokens).toBe(400);
  });

  it("test_env_var_disables_compact_assist", () => {
    for (const val of ["0", "false", "no", "off"]) {
      process.env["TOKEN_GOAT_COMPACT_ASSIST"] = val;
      try {
        const cfg = config.load();
        expect(cfg.compact_assist?.enabled).toBe(false);
      } finally {
        delete process.env["TOKEN_GOAT_COMPACT_ASSIST"];
      }
    }
  });

  it("test_env_var_blank_leaves_enabled", () => {
    process.env["TOKEN_GOAT_COMPACT_ASSIST"] = "";
    try {
      const cfg = config.load();
      expect(cfg.compact_assist?.enabled).toBe(true);
    } finally {
      delete process.env["TOKEN_GOAT_COMPACT_ASSIST"];
    }
  });

  it("test_toml_overrides_defaults", () => {
    const cfg_path = config_path_for_test();
    fs.writeFileSync(
      cfg_path,
      "[compact_assist]\nenabled = false\nmin_events = 10\nmax_manifest_tokens = 200\n",
      "utf8",
    );
    delete process.env["TOKEN_GOAT_COMPACT_ASSIST"];
    const cfg = config.load();
    expect(cfg.compact_assist?.enabled).toBe(false);
    expect(cfg.compact_assist?.min_events).toBe(10);
    expect(cfg.compact_assist?.max_manifest_tokens).toBe(200);
  });

  it("test_corrupt_toml_falls_back_to_defaults", () => {
    const cfg_path = config_path_for_test();
    fs.writeFileSync(cfg_path, "this is not valid toml }{{{", "utf8");
    delete process.env["TOKEN_GOAT_COMPACT_ASSIST"];
    const cfg = config.load();
    expect(cfg.compact_assist?.enabled).toBe(true);
  });

  it("test_wide_session_threshold_default", () => {
    const cfg = config.load();
    expect(cfg.compact_assist?.wide_session_threshold).toBe(15);
  });

  it("test_wide_session_threshold_from_toml", () => {
    const cfg_path = config_path_for_test();
    fs.writeFileSync(cfg_path, "[compact_assist]\nwide_session_threshold = 5\n", "utf8");
    const cfg = config.load();
    expect(cfg.compact_assist?.wide_session_threshold).toBe(5);
  });

  it("test_wide_session_threshold_respected_by_build_manifest", () => {
    // Use threshold=3: a session with 3 files flips into wide mode.
    patchWideSessionThreshold(3);
    const sid = "wide-cfg-threshold-abc";
    for (let i = 0; i < 3; i++) {
      session.mark_file_read(sid, `src/cfg_${i}.py`, null, null, { symbol: `fn_${i}` });
    }
    session.mark_file_edited(sid, "src/anchor.py");
    const result = compact.build_manifest(sid, { max_tokens: 2000 });
    expect(result.includes("**Symbols Accessed:**")).toBe(true);
    const syms_line = result.split("\n").find((ln) => ln.includes("**Symbols Accessed:**"));
    expect(syms_line).not.toBeUndefined();
    expect(syms_line!.includes("files accessed")).toBe(true);
  });
});

/**
 * Resolve the per-test config.toml path under the isolated data dir and ensure
 * its parent exists. The Python tests monkeypatch paths.config_path to a tmp
 * file; here setup.ts already redirects paths to the isolated data dir, so we
 * write to the real config path config.load() will read.
 */
function config_path_for_test(): string {
  // paths.configPath() resolves under the data dir override set by setup.ts.
  const p = paths.configPath();
  fs.mkdirSync(path.dirname(p), { recursive: true });
  return p;
}

// ===========================================================================
// TestBuildSealedBlock — _build_sealed_block + skill/blocker helpers
// ===========================================================================

describe("TestBuildSealedBlock", () => {
  it("test_empty_inputs_returns_empty_list", () => {
    const result = compact._build_sealed_block({}, [], {});
    expect(result).toEqual([]);
  });

  it("test_block_present_when_edited_files", () => {
    const result = compact._build_sealed_block({ "/proj/src/auth.py": 2 }, [], {});
    expect(result).not.toEqual([]);
    const text = result.join("\n");
    expect(text.includes("### MUST_PRESERVE")).toBe(true);
    expect(text.includes("<<preserve>>")).toBe(true);
    expect(text.includes("<</preserve>>")).toBe(true);
  });

  it("test_block_present_when_blocker", () => {
    const entry = makeBashEntry("pytest tests/", 1, _time());
    const result = compact._build_sealed_block({}, [entry], {});
    const text = result.join("\n");
    expect(text.includes("### MUST_PRESERVE")).toBe(true);
    expect(text.includes("<<preserve>>")).toBe(true);
    expect(text.includes("pytest")).toBe(true);
  });

  it("test_block_present_when_skills", () => {
    const skill = makeSkillEntry("ralph", _time());
    const result = compact._build_sealed_block({}, [], { ralph: skill });
    const text = result.join("\n");
    expect(text.includes("### MUST_PRESERVE")).toBe(true);
    expect(text.includes("<<preserve>>")).toBe(true);
    expect(text.includes("ralph")).toBe(true);
  });

  it("test_edit_slot_shows_at_most_three_files", () => {
    const edited = { "/proj/a.py": 5, "/proj/b.py": 3, "/proj/c.py": 2, "/proj/d.py": 1 };
    const result = compact._build_sealed_block(edited, [], {});
    const text = result.join("\n");
    expect(text.includes("a.py")).toBe(true);
    expect(text.includes("b.py")).toBe(true);
    expect(text.includes("c.py")).toBe(true);
    expect(text.includes("d.py")).toBe(false);
  });

  it("test_edit_slot_includes_count_suffix_when_gt_one", () => {
    const edited = { "/proj/src/compact.py": 4 };
    const result = compact._build_sealed_block(edited, [], {});
    const text = result.join("\n");
    expect(text.includes("×4")).toBe(true);
  });

  it("test_blocker_slot_uses_most_recent_failure", () => {
    const now = _time();
    const older = makeBashEntry("make build", 2, now - 120);
    const newer = makeBashEntry("pytest tests/compact", 1, now - 10);
    const result = compact._build_sealed_block({}, [older, newer], {});
    const text = result.join("\n");
    expect(text.includes("pytest")).toBe(true);
  });

  it("test_skill_slot_shows_at_most_two_skills", () => {
    const now = _time();
    const skills = {
      ralph: makeSkillEntry("ralph", now - 10),
      improve: makeSkillEntry("improve", now - 20),
      superman: makeSkillEntry("superman", now - 30),
    };
    const result = compact._build_sealed_block({}, [], skills);
    const text = result.join("\n");
    expect(text.includes("ralph")).toBe(true);
    expect(text.includes("improve")).toBe(true);
    expect(text.includes("superman")).toBe(false);
  });

  it("test_block_bounded_at_80_tokens", () => {
    const now = _time();
    const edited: Record<string, number> = {};
    for (let i = 0; i < 5; i++) {
      edited[`/proj/src/very_long_filename_${String(i).padStart(3, "0")}.py`] = i + 1;
    }
    const entry = makeBashEntry("pytest --timeout=60 tests/test_very_long_module.py", 1, now);
    const skills = {
      ralph: makeSkillEntry("ralph", now),
      improve: makeSkillEntry("improve", now - 5),
    };
    const result = compact._build_sealed_block(edited, [entry], skills);
    const text = result.join("\n");
    expect(text.length).toBeLessThanOrEqual(320);
  });

  it("test_all_three_slots_survive_top_only_truncation", () => {
    const now = _time();
    const edited = { "/proj/src/auth.py": 3 };
    const entry = makeBashEntry("pytest tests/", 1, now);
    const skills = { ralph: makeSkillEntry("ralph", now) };
    const block_lines = compact._build_sealed_block(edited, [entry], skills);
    const text = block_lines.join("\n");
    expect(text.includes("auth.py")).toBe(true);
    expect(text.includes("pytest")).toBe(true);
    expect(text.includes("ralph")).toBe(true);
  });

  it("test_manifest_starts_with_sealed_block_when_data_present", () => {
    const sid = "sealed-block-manifest-test-abc";
    session.mark_file_edited(sid, "/proj/src/auth.py");
    const result = compact.build_manifest(sid);
    expect(result.startsWith("### MUST_PRESERVE")).toBe(true);
  });

  it("test_manifest_omits_sealed_block_when_no_data", () => {
    const sid = "sealed-block-absent-test-abc";
    session.mark_file_read(sid, "/proj/src/db.py", 0, 100);
    const result = compact.build_manifest(sid);
    expect(result.includes("### MUST_PRESERVE")).toBe(false);
  });

  it("test_files_edited_section_still_present_with_sealed_block", () => {
    const sid = "sealed-coexist-test-abc";
    session.mark_file_edited(sid, "/proj/src/compact.py");
    const result = compact.build_manifest(sid);
    expect(result.includes("### MUST_PRESERVE")).toBe(true);
    expect(result.includes("<<preserve>>")).toBe(true);
    expect(result.includes("**Staged/Uncommitted:**") || result.includes("**Edited:**")).toBe(true);
  });

  it("test_sealed_block_tokens_within_max_tokens", () => {
    const sid = "sealed-budget-test-abc";
    for (const name of ["authentication_service.py", "database_connection.py", "session_manager.py"]) {
      session.mark_file_edited(sid, `/proj/src/services/${name}`);
    }
    session.mark_bash_run(sid, "bash_sha_budget", "pytest tests/", "out_budget", 1500, 600, 1, false);

    const max_tokens = 200;
    const result = compact.build_manifest(sid, { max_tokens });
    expect(result).toBeTruthy();
    const actual_tokens = compact.estimate_tokens(result);
    expect(actual_tokens).toBeLessThanOrEqual(max_tokens);
  });

  it("test_save_and_reload", () => {
    delete process.env["TOKEN_GOAT_COMPACT_ASSIST"];
    const original = config.load();
    original.compact_assist!.enabled = false;
    original.compact_assist!.min_events = 99;
    config.save(original);

    const reloaded = config.load();
    expect(reloaded.compact_assist?.enabled).toBe(false);
    expect(reloaded.compact_assist?.min_events).toBe(99);
  });

  it("test_resume_pointer_uses_top_edited_basename", () => {
    const edited = { "/proj/src/auth.py": 5, "/proj/src/db.py": 2 };
    const result = compact._build_sealed_block(edited, [], {});
    const text = result.join("\n");
    expect(text.includes("🎯 RESUME: auth.py")).toBe(true);
  });

  it("test_resume_pointer_falls_back_to_blocker_cmd", () => {
    const entry: BashEntryLike = {
      cmd_preview: "FOO=bar pytest tests/compact_test.py",
      exit_code: 1,
      ts: _time(),
      output_id: "",
      stdout_bytes: 0,
      stderr_bytes: 0,
    };
    const result = compact._build_sealed_block({}, [entry], {});
    const text = result.join("\n");
    expect(text.includes("🎯 RESUME: re-run pytest")).toBe(true);
  });

  it("test_resume_pointer_omitted_for_skill_only_block", () => {
    const skill: SkillEntryLike = {
      skill_name: "ralph",
      ts: _time(),
      body_bytes: 1024,
      run_count: 1,
      truncated: false,
    };
    const result = compact._build_sealed_block({}, [], { ralph: skill });
    const text = result.join("\n");
    expect(text.includes("🎯 RESUME:")).toBe(false);
  });

  it("test_blocker_slot_uses_error_preview_when_available", () => {
    const fake_output =
      "running tests...\n" +
      "test_foo PASSED\n" +
      "test_bar FAILED\n" +
      "AssertionError: expected 5, got 4\n" +
      "1 failed in 0.02s\n";
    compact._setBashCacheModule({
      load_output: () => fake_output,
      get_recent_error_outputs: () => [],
    });
    compact._blocker_preview_cache.clear();

    const entry: BashEntryLike = {
      cmd_preview: "pytest",
      exit_code: 1,
      ts: _time(),
      output_id: "abc123",
      stdout_bytes: 200,
      stderr_bytes: 0,
    };
    const result = compact._build_sealed_block({}, [entry], {});
    const text = result.join("\n");
    expect(text.includes("AssertionError") || text.includes("FAILED")).toBe(true);
  });

  it("test_format_blocker_entry_appends_error_preview", () => {
    const fake_output = "ModuleNotFoundError: No module named 'foo'\n";
    compact._setBashCacheModule({
      load_output: () => fake_output,
      get_recent_error_outputs: () => [],
    });
    compact._blocker_preview_cache.clear();

    const entry: BashEntryLike = {
      cmd_preview: "python -m pytest tests/test_x.py",
      exit_code: 1,
      ts: _time(),
      output_id: "def456",
      stdout_bytes: 100,
      stderr_bytes: 0,
    };
    const line = compact._format_blocker_entry(entry);
    expect(line.includes("ModuleNotFoundError")).toBe(true);
    expect(line.includes("(exit 1)")).toBe(true);
  });

  it("test_format_blocker_entry_silent_on_cache_miss", () => {
    compact._setBashCacheModule({
      load_output: () => null,
      get_recent_error_outputs: () => [],
    });
    compact._blocker_preview_cache.clear();

    const entry: BashEntryLike = {
      cmd_preview: "make build",
      exit_code: 2,
      ts: _time(),
      output_id: "ghi789",
      stdout_bytes: 0,
      stderr_bytes: 0,
    };
    const line = compact._format_blocker_entry(entry);
    expect(line).toBe("- ✗ make build  (exit 2)");
  });

  it("test_extract_blocker_error_preview_fail_soft_on_exception", () => {
    compact._setBashCacheModule({
      load_output: () => {
        throw new Error("synthetic disk failure");
      },
      get_recent_error_outputs: () => [],
    });
    compact._blocker_preview_cache.clear();

    const entry = { output_id: "boom_id" };
    const result = compact._extract_blocker_error_preview(entry);
    expect(result).toBe("");
  });

  it("test_block_bounded_at_80_tokens_with_long_skill_name", () => {
    const now = _time();
    const long_name = "plugin:very-long-skill-name-" + "x".repeat(40);
    const skill = makeSkillEntry(long_name, now);

    const edited: Record<string, number> = {};
    for (let i = 0; i < 3; i++) {
      edited[`/proj/src/component_${i}.py`] = i + 1;
    }
    const entry = makeBashEntry("pytest --timeout=60 tests/test_very_long_suite.py", 1, now);

    const result = compact._build_sealed_block(edited, [entry], { s: skill });
    const text = result.join("\n");
    const token_count = compact._token_count(text);
    expect(token_count).toBeLessThanOrEqual(80);
  });

  it("test_stale_skills_filtered_from_manifest", () => {
    const now = _time();
    const recent_skill = makeSkillEntry("ralph", now - 60);
    const stale_skill = makeSkillEntry("improve", now - 31 * 60);

    const result = compact._build_sealed_block({}, [], { ralph: recent_skill, improve: stale_skill });
    const text = result.join("\n");
    expect(text.includes("ralph")).toBe(true);
    expect(text.includes("improve")).toBe(false);
  });

  it("test_all_skills_stale_results_in_empty_manifest", () => {
    const now = _time();
    const stale1 = makeSkillEntry("ralph", now - 31 * 60);
    const stale2 = makeSkillEntry("improve", now - 45 * 60);

    const result = compact._build_sealed_block({}, [], { ralph: stale1, improve: stale2 });
    const text = result.join("\n");
    expect(text.includes("**Skills:**")).toBe(false);
  });

  it("test_deduplicates_skills_by_name_keeping_most_recent", () => {
    const now = _time();
    const ralph_v1 = makeSkillEntry("ralph", now - 300);
    ralph_v1.content_sha = "sha_v1";
    ralph_v1.output_id = "out_v1";

    const ralph_v2 = makeSkillEntry("ralph", now - 60);
    ralph_v2.content_sha = "sha_v2";
    ralph_v2.output_id = "out_v2";

    const skill_history = { ralph: ralph_v2 };
    const selected = compact._select_top_skill_entries(skill_history);

    expect(selected.length).toBe(1);
    expect((selected[0] as SkillEntryLike).skill_name).toBe("ralph");
    expect((selected[0] as SkillEntryLike).output_id).toBe("out_v2");
  });

  it("test_format_skill_entry_flags_stale_skills", () => {
    const now = _time();

    const recent = makeSkillEntry("ralph", now - 3600);
    const formatted = compact._format_skill_entry(recent);
    expect(formatted.includes("(stale:")).toBe(false);
    expect(formatted.includes("recall:")).toBe(true);

    const old = makeSkillEntry("improve", now - 7 * 3600);
    const formatted_old = compact._format_skill_entry(old);
    expect(formatted_old.includes("(stale: 7h)")).toBe(true);
    expect(formatted_old.includes("recall:")).toBe(true);
  });

  it("test_format_skill_entry_shows_truncation_marker", () => {
    const now = _time();
    const skill = makeSkillEntry("ralph", now);
    skill.truncated = true;

    const formatted = compact._format_skill_entry(skill);
    expect(formatted.includes("*)")).toBe(true);
  });

  it("test_format_skill_entry_shows_run_count", () => {
    const now = _time();
    const skill = makeSkillEntry("ralph", now);
    skill.run_count = 3;

    const formatted = compact._format_skill_entry(skill);
    expect(formatted.includes("×3")).toBe(true);
  });
});

// ===========================================================================
// TestPreCompactPressureAwareSizing
// ===========================================================================

describe("TestPreCompactPressureAwareSizing", () => {
  it("test_auto_trigger_doubles_budget_by_default", async () => {
    const captured: { max_tokens?: number } = {};
    patchConfigLoad(3.0);
    vi.spyOn(session, "safe_load").mockReturnValue(makeFakeSessionCache() as unknown as session.SessionCache);
    spyBuildManifestWithCountCapture(captured);

    const payload = { session_id: "auto_boost_sess", trigger: "auto" };
    const result = await hooks_cli.pre_compact(payload);

    expect(result.continue).toBe(true);
    expect(captured.max_tokens).toBe(600);
  });

  it("test_manual_trigger_keeps_base_budget", async () => {
    const captured: { max_tokens?: number } = {};
    patchConfigLoad(2.0);
    vi.spyOn(session, "safe_load").mockReturnValue(makeFakeSessionCache() as unknown as session.SessionCache);
    spyBuildManifestWithCountCapture(captured);

    const payload = { session_id: "manual_sess", trigger: "manual" };
    const result = await hooks_cli.pre_compact(payload);

    expect(result.continue).toBe(true);
    expect(captured.max_tokens).toBe(200);
  });

  it("test_multiplier_1_disables_boost", async () => {
    const captured: { max_tokens?: number } = {};
    patchConfigLoad(1.0);
    vi.spyOn(session, "safe_load").mockReturnValue(makeFakeSessionCache() as unknown as session.SessionCache);
    spyBuildManifestWithCountCapture(captured);

    const payload = { session_id: "no_boost_sess", trigger: "auto" };
    await hooks_cli.pre_compact(payload);

    expect(captured.max_tokens).toBe(200);
  });

  it("test_telemetry_row_written_on_successful_emit", async () => {
    // manifest_text = "x" * 600 -> estimate_tokens = max(1, 600//3 + 1) = 201
    const manifest_text = "x".repeat(600);
    patchConfigLoad(1.0);
    vi.spyOn(session, "safe_load").mockReturnValue(makeFakeSessionCache() as unknown as session.SessionCache);
    vi.spyOn(compact, "build_manifest_with_count").mockReturnValue([manifest_text, 10]);

    const payload = { session_id: "telemetry_sess", trigger: "manual" };
    const result = await hooks_cli.pre_compact(payload);
    expect(result.continue).toBe(true);

    const rows = db.openGlobal((conn) =>
      conn.prepare("SELECT detail FROM stats WHERE kind = ?").all("compact_manifest") as Array<{ detail: string }>,
    );
    expect(rows.length).toBe(1);
    const detail = rows[0]!.detail;
    expect(detail.includes("budget=200")).toBe(true);
    expect(detail.includes("actual=201")).toBe(true);
    expect(detail.includes("trigger=manual")).toBe(true);
    expect(detail.includes("events=10")).toBe(true);
  });

  it("test_telemetry_records_boosted_budget_under_auto", async () => {
    patchConfigLoad(2.0);
    vi.spyOn(session, "safe_load").mockReturnValue(makeFakeSessionCache() as unknown as session.SessionCache);
    vi.spyOn(compact, "build_manifest_with_count").mockReturnValue(["## manifest body " + "y".repeat(100), 20]);

    const payload = { session_id: "tele_auto_sess", trigger: "auto" };
    await hooks_cli.pre_compact(payload);

    const rows = db.openGlobal((conn) =>
      conn.prepare("SELECT detail FROM stats WHERE kind = ?").all("compact_manifest") as Array<{ detail: string }>,
    );
    expect(rows.length).toBe(1);
    const detail = rows[0]!.detail;
    expect(detail.includes("budget=400")).toBe(true);
    expect(detail.includes("trigger=auto")).toBe(true);
  });
});

// ===========================================================================
// TestShortPathStripping — token-efficient manifest path display
// (Python class declaration was lost in the source; docstring names it.)
// ===========================================================================

describe("TestShortPathStripping", () => {
  it("test_extract_path_from_edited_line", () => {
    const line = "- ✎ token_goat/compact.py  ×2";
    expect(compact._extract_path_from_line(line)).toBe("token_goat/compact.py");
  });

  it("test_extract_path_from_read_line", () => {
    const line = "- → token_goat/hints.py  L:1-100";
    expect(compact._extract_path_from_line(line)).toBe("token_goat/hints.py");
  });

  it("test_extract_path_from_stale_line", () => {
    const line = "- ⚠ token_goat/session.py";
    expect(compact._extract_path_from_line(line)).toBe("token_goat/session.py");
  });

  it("test_extract_path_from_symbol_line", () => {
    const line = "- token_goat/session.py → FileEntry, SessionCache";
    expect(compact._extract_path_from_line(line)).toBe("token_goat/session.py");
  });

  it("test_extract_path_returns_none_for_header", () => {
    expect(compact._extract_path_from_line("### Files Edited")).toBeNull();
    expect(compact._extract_path_from_line("Legend: edited=✎")).toBeNull();
    expect(compact._extract_path_from_line("")).toBeNull();
  });

  it("test_extract_path_returns_none_for_command_line", () => {
    const line = "- `pytest -v` (exit 0)";
    expect(compact._extract_path_from_line(line)).toBeNull();
  });

  it("test_find_common_prefix_same_directory", () => {
    const paths_in = ["token_goat/compact.py", "token_goat/hints.py", "token_goat/session.py"];
    expect(compact._find_common_prefix(paths_in)).toBe("token_goat/");
  });

  it("test_find_common_prefix_nested_directory", () => {
    const paths_in = ["src/token_goat/compact.py", "src/token_goat/hints.py"];
    expect(compact._find_common_prefix(paths_in)).toBe("src/token_goat/");
  });

  it("test_find_common_prefix_no_common_prefix", () => {
    const paths_in = ["src/foo.py", "tests/bar.py"];
    expect(compact._find_common_prefix(paths_in)).toBeNull();
  });

  it("test_find_common_prefix_single_segment_paths", () => {
    const paths_in = ["compact.py", "hints.py"];
    expect(compact._find_common_prefix(paths_in)).toBeNull();
  });

  it("test_find_common_prefix_empty_list", () => {
    expect(compact._find_common_prefix([])).toBeNull();
  });

  it("test_find_common_prefix_single_path", () => {
    const paths_in = ["token_goat/compact.py"];
    const result = compact._find_common_prefix(paths_in);
    expect(result === "token_goat/" || result === null).toBe(true);
  });

  it("test_strip_common_prefix_from_sections", () => {
    const sections = [
      "## Token-Goat Session Manifest",
      "Session: abc12345  |  2026-05-21 10:00",
      "### Files Edited (preserve in summary)",
      "- ✎ token_goat/compact.py  ×2",
      "- ✎ token_goat/hints.py",
    ];
    const result = compact._strip_common_prefix_from_sections(sections, "token_goat/");
    expect(result.some((line) => line.includes("token_goat/") && line.includes("relative to"))).toBe(true);
    const joined = result.join("\n");
    expect(joined.includes("compact.py")).toBe(true);
    expect(joined.includes("hints.py")).toBe(true);
    const path_lines = result.filter((line) => line.startsWith("- ✎"));
    for (const line of path_lines) {
      expect(line.includes("token_goat/compact.py")).toBe(false);
      expect(line.includes("token_goat/hints.py")).toBe(false);
    }
  });

  it("test_strip_common_prefix_from_sections_no_session_header", () => {
    const sections = [
      "### Files Edited (preserve in summary)",
      "- ✎ token_goat/compact.py  ×2",
      "- ✎ token_goat/hints.py",
      "- ✎ token_goat/session.py",
    ];
    const result = compact._strip_common_prefix_from_sections(sections, "token_goat/");
    expect(result.length).toBe(sections.length);
    const path_lines = result.filter((line) => line.startsWith("- ✎"));
    for (const line of path_lines) {
      expect(line.includes("token_goat/")).toBe(false);
    }
  });

  it("test_manifest_strips_common_prefix_when_3plus_paths", () => {
    const sid = "prefix-strip-session-abc";
    session.mark_file_edited(sid, "/proj/src/token_goat/compact.py");
    session.mark_file_edited(sid, "/proj/src/token_goat/hints.py");
    session.mark_file_edited(sid, "/proj/src/token_goat/session.py");
    session.mark_file_edited(sid, "/proj/src/token_goat/config.py");
    session.mark_file_edited(sid, "/proj/src/token_goat/util.py");
    const result = compact.build_manifest(sid);
    expect(result.includes("(5 files)")).toBe(true);
    expect(result.includes("token_goat/")).toBe(true);
    expect(result.includes("compact.py") && result.includes("hints.py") && result.includes("session.py")).toBe(true);
  });

  it("test_manifest_no_strip_when_fewer_than_3_paths", () => {
    const sid = "no-strip-few-paths-session";
    session.mark_file_edited(sid, "/proj/src/token_goat/compact.py");
    session.mark_file_edited(sid, "/proj/src/token_goat/hints.py");
    const result = compact.build_manifest(sid);
    expect(result.includes("relative to")).toBe(false);
  });

  it("test_manifest_no_strip_when_no_common_prefix", () => {
    const sid = "no-strip-no-prefix-session";
    session.mark_file_edited(sid, "/proj/src/auth.py");
    session.mark_file_edited(sid, "/proj/tests/test_auth.py");
    session.mark_file_edited(sid, "/proj/docs/readme.md");
    const result = compact.build_manifest(sid);
    expect(result.includes("relative to")).toBe(false);
  });

  it("test_manifest_no_strip_prefix_too_short", () => {
    const sid = "no-strip-short-prefix-session";
    session.mark_file_edited(sid, "/x/y/file1.py");
    session.mark_file_edited(sid, "/x/y/file2.py");
    session.mark_file_edited(sid, "/x/y/file3.py");
    const result = compact.build_manifest(sid);
    expect(result.includes("relative to")).toBe(false);
  });

  it("test_manifest_no_strip_when_prefix_covers_less_than_70_percent", () => {
    const sid = "no-strip-low-coverage-session";
    session.mark_file_edited(sid, "/proj/src/token_goat/compact.py");
    session.mark_file_edited(sid, "/proj/src/token_goat/hints.py");
    session.mark_file_edited(sid, "/proj/src/parser.py");
    session.mark_file_edited(sid, "/proj/src/helpers.py");
    session.mark_file_edited(sid, "/proj/src/utils.py");
    const result = compact.build_manifest(sid);
    expect(result.includes("(stripped)")).toBe(false);
  });

  it("test_prefix_stripping_preserves_all_path_information", () => {
    const sid = "prefix-preservation-session";
    session.mark_file_edited(sid, "/proj/src/token_goat/compact.py");
    session.mark_file_edited(sid, "/proj/src/token_goat/hints.py");
    session.mark_file_edited(sid, "/proj/src/token_goat/session.py");
    session.mark_file_read(sid, "/proj/src/token_goat/utils.py", null, null, { symbol: "FileEntry" });
    const result = compact.build_manifest(sid);
    expect(result.includes("compact.py")).toBe(true);
    expect(result.includes("hints.py")).toBe(true);
    expect(result.includes("session.py")).toBe(true);
    expect(result.includes("utils.py")).toBe(true);
  });
});

// ===========================================================================
// TestSessionAgeInManifest
// ===========================================================================

describe("TestSessionAgeInManifest", () => {
  it("test_format_duration_minutes", () => {
    expect(compact._format_duration(65)).toBe("1m");
    expect(compact._format_duration(300)).toBe("5m");
    expect(compact._format_duration(3599)).toBe("59m");
  });

  it("test_format_duration_hours_and_minutes", () => {
    expect(compact._format_duration(3665)).toBe("1h 1m");
    expect(compact._format_duration(7200)).toBe("2h");
    expect(compact._format_duration(7260)).toBe("2h 1m");
    expect(compact._format_duration(3600)).toBe("1h");
  });

  it("test_manifest_includes_age_when_session_is_old", () => {
    const sid = "age-test-session";
    const cache = session.load(sid);
    cache.created_ts = _time() - 7200;
    session.save(cache);
    session.mark_file_read(sid, "file.py");
    const result = compact.build_manifest(sid);
    expect(result.includes("Session:")).toBe(false);
    expect(result.includes("age:")).toBe(false);
    expect(result.includes("## Token-Goat Session Manifest")).toBe(true);
  });

  it("test_manifest_omits_age_when_session_is_very_young", () => {
    const sid = "young-session";
    const cache = session.load(sid);
    cache.created_ts = _time() - 30;
    session.save(cache);
    session.mark_file_read(sid, "file.py");
    const result = compact.build_manifest(sid);
    expect(result.includes("Session:")).toBe(false);
    expect(result.includes("## Token-Goat Session Manifest")).toBe(true);
  });

  it("test_manifest_age_format_with_min_threshold", () => {
    const sid = "threshold-session";
    const cache = session.load(sid);
    cache.created_ts = _time() - 60;
    session.save(cache);
    session.mark_file_read(sid, "file.py");
    const result = compact.build_manifest(sid);
    expect(result.includes("age:")).toBe(false);
    expect(compact._format_duration(60)).toBe("1m");
  });
});

// ===========================================================================
// TestHotFileConsolidation
// ===========================================================================

describe("TestHotFileConsolidation", () => {
  it("test_hot_files_collapsed_to_single_line", () => {
    const sid = "hot-file-collapse-session";
    for (let i = 0; i < 6; i++) {
      session.mark_file_read(sid, "/proj/src/hot.py", 0, 50);
    }
    const result = compact.build_manifest(sid);
    expect(result.includes("Hot (5+×):")).toBe(true);
    expect(result.includes("hot.py")).toBe(true);
  });

  it("test_hot_file_not_listed_individually", () => {
    const sid = "hot-file-no-dup-session";
    for (let i = 0; i < 7; i++) {
      session.mark_file_read(sid, "/proj/src/frequent.py", 0, 50);
    }
    const result = compact.build_manifest(sid);
    expect(result.includes("Hot (5+×):")).toBe(true);
    expect((result.match(/frequent\.py/g) ?? []).length).toBe(1);
  });

  it("test_normal_files_still_get_individual_entries", () => {
    const sid = "normal-file-individual-session";
    for (let i = 0; i < 3; i++) {
      session.mark_file_read(sid, "/proj/src/normal.py", 0, 50);
    }
    const result = compact.build_manifest(sid);
    expect(result.includes("Hot (5+×):")).toBe(false);
    expect(result.includes("- → ")).toBe(true);
    expect(result.includes("normal.py")).toBe(true);
  });

  it("test_hot_line_appears_before_normal_entries", () => {
    const sid = "hot-before-normal-session";
    for (let i = 0; i < 5; i++) {
      session.mark_file_read(sid, "/proj/src/hot.py", 0, 50);
    }
    for (let i = 0; i < 2; i++) {
      session.mark_file_read(sid, "/proj/src/normal.py", 0, 50);
    }
    const result = compact.build_manifest(sid);
    expect(result.includes("Hot (5+×):")).toBe(true);
    expect(result.includes("normal.py")).toBe(true);
    expect(result.indexOf("Hot (5+×):")).toBeLessThan(result.indexOf("normal.py"));
  });

  it("test_more_than_six_hot_files_shows_overflow", () => {
    const sid = "hot-overflow-session";
    const saveSpy = vi.spyOn(session, "save").mockReturnValue(undefined);
    let cache: session.SessionCache | null = session.load(sid);
    for (let i = 0; i < 8; i++) {
      for (let r = 0; r < 5; r++) {
        cache = session.mark_file_read(sid, `/proj/src/hot${i}.py`, 0, 50, { cache });
      }
    }
    saveSpy.mockRestore();
    session.save(cache);
    const result = compact.build_manifest(sid);
    expect(result.includes("Hot (5+×):")).toBe(true);
    expect(result.includes("+2 more") || result.includes("+ more") || result.includes("more")).toBe(true);
  });

  it("test_exactly_six_hot_files_no_overflow", () => {
    const sid = "hot-exactly-six-session";
    const saveSpy = vi.spyOn(session, "save").mockReturnValue(undefined);
    let cache: session.SessionCache | null = session.load(sid);
    for (let i = 0; i < 6; i++) {
      for (let r = 0; r < 5; r++) {
        cache = session.mark_file_read(sid, `/proj/src/file${i}.py`, 0, 50, { cache });
      }
    }
    saveSpy.mockRestore();
    session.save(cache);
    const result = compact.build_manifest(sid);
    expect(result.includes("Hot (5+×):")).toBe(true);
    expect(result.includes("+0 more")).toBe(false);
    for (let i = 0; i < 6; i++) {
      expect(result.includes(`file${i}.py`)).toBe(true);
    }
  });
});

// ===========================================================================
// TestTrimRefillPass
// ===========================================================================

describe("TestTrimRefillPass", () => {
  it("test_refill_recovers_lines_under_accurate_budget", () => {
    const sid = "refill-session-abc";
    for (let i = 0; i < 15; i++) {
      session.mark_file_read(sid, `/proj/src/module${String(i).padStart(2, "0")}.py`, 0, 100);
    }
    session.mark_file_edited(sid, "/proj/src/edited.py");

    const budget = 80;
    const result = compact.build_manifest(sid, { max_tokens: budget });

    const actual_tokens = compact.estimate_tokens(result);
    expect(actual_tokens).toBeLessThanOrEqual(budget);
    expect(result.length).toBeGreaterThan(0);
  });
});

// ===========================================================================
// TestSessionCommits
// ===========================================================================

describe("TestSessionCommits", () => {
  it("test_get_session_commits_with_no_cwd_returns_empty_list", () => {
    const result = compact._get_session_commits(null, _time());
    expect(result).toEqual([]);
  });

  it("test_get_session_commits_with_zero_timestamp_returns_empty_list", () => {
    const result = compact._get_session_commits("/some/path", 0.0);
    expect(result).toEqual([]);
  });

  it("test_get_session_commits_handles_missing_git", () => {
    const result = compact._get_session_commits("/nonexistent/path/to/repo", _time() - 3600);
    expect(result).toEqual([]);
  });

  it("test_get_session_commits_returns_commits_when_available", () => {
    const tmp = tmpPath();
    const repo_path = makeGitRepo(tmp, "test_repo", {
      files: { "test.txt": "content" },
      email: "test@example.com",
      user: "Test User",
      commitMessage: "test commit",
    });

    const past_timestamp = _time() - 3600;
    const result = compact._get_session_commits(repo_path, past_timestamp);

    expect(result.length).toBeGreaterThan(0);
    expect(result.every((line) => !line.startsWith("- "))).toBe(true);
    expect(result[0]!.includes("test commit")).toBe(true);
  });

  // PORT: deferred — Python patches `compact._get_session_commits` and relies on
  // `build_manifest` calling it through the module namespace. The TS
  // `_build_manifest_from_cache` invokes `_get_session_commits` via a LOCAL
  // binding (compact.ts:4866), which a vi.spyOn on the ESM namespace cannot
  // intercept (the ESM self-reference limitation). The mock return is
  // load-bearing here (it injects the commit lines the assertions look for), so
  // there is no faithful way to drive the section without an injection seam.
  it.skip("test_manifest_includes_commits_section_when_present", () => {
    // see PORT note above
  });

  it("test_manifest_omits_commits_section_when_no_commits", () => {
    // The Python patch makes _get_session_commits return []. The TS spy cannot
    // intercept the internal local-binding call, but the real
    // _get_session_commits("/some/repo", ...) also returns [] (the dir is not a
    // git repo), so the observed outcome — no "Commits This Session" section —
    // is identical. The assertion is therefore faithful without the (no-op)
    // spy, which is omitted.
    const sid = "no-new-commits-session";
    session.mark_file_edited(sid, "/proj/src/app.py");

    const cache = session.load(sid);
    cache.cwd = "/some/repo";
    cache.created_ts = _time() - 3600;
    session.save(cache);

    const result = compact.build_manifest(sid);

    expect(result.includes("Commits This Session")).toBe(false);
  });
});

// ===========================================================================
// TestSectionBudgets
// ===========================================================================

describe("TestSectionBudgets", () => {
  it("test_proportions_sum_to_total_remaining", () => {
    const budgets = compact._section_budgets(600, 0);
    const sum = Object.values(budgets).reduce((s, v) => s + v, 0);
    expect(sum).toBeLessThanOrEqual(600);
    expect(sum).toBeGreaterThanOrEqual(600 - 6);
  });

  it("test_symbols_gets_thirtyeight_percent", () => {
    const budgets = compact._section_budgets(400, 0);
    expect(budgets["symbols"]).toBe(Math.trunc(400 * 0.38));
  });

  it("test_files_gets_twentytwo_percent", () => {
    const budgets = compact._section_budgets(400, 0);
    expect(budgets["files"]).toBe(Math.trunc(400 * 0.22));
  });

  it("test_greps_gets_fifteen_percent", () => {
    const budgets = compact._section_budgets(400, 0);
    expect(budgets["greps"]).toBe(Math.trunc(400 * 0.15));
  });

  it("test_bash_gets_ten_percent", () => {
    const budgets = compact._section_budgets(400, 0);
    expect(budgets["bash"]).toBe(Math.trunc(400 * 0.1));
  });

  it("test_web_gets_ten_percent", () => {
    const budgets = compact._section_budgets(400, 0);
    expect(budgets["web"]).toBe(Math.trunc(400 * 0.1));
  });

  it("test_edited_tokens_reduce_remaining", () => {
    const budgets_no_edit = compact._section_budgets(1000, 0);
    const budgets_with_edit = compact._section_budgets(1000, 400);
    for (const key of ["symbols", "files", "greps", "bash", "web", "glob"]) {
      expect(budgets_with_edit[key]!).toBeLessThan(budgets_no_edit[key]!);
    }
  });

  it("test_minimum_section_tokens_enforced", () => {
    const budgets = compact._section_budgets(10, 9);
    for (const key of ["symbols", "files", "greps", "bash", "web", "glob"]) {
      expect(budgets[key]!).toBeGreaterThanOrEqual(20);
    }
  });

  it("test_zero_remaining_gives_minimums", () => {
    const budgets = compact._section_budgets(400, 500);
    for (const key of ["symbols", "files", "greps", "bash", "web", "glob"]) {
      expect(budgets[key]!).toBeGreaterThanOrEqual(20);
    }
  });

  it("test_returns_all_six_keys", () => {
    const budgets = compact._section_budgets(400, 100);
    expect(new Set(Object.keys(budgets))).toEqual(
      new Set(["symbols", "files", "greps", "bash", "web", "glob"]),
    );
  });

  it("test_content_aware_empty_section_gets_zero_allocation", () => {
    const empty_counts = { symbols: 0, files: 0, greps: 0, bash: 0, web: 0, glob: 0 };
    const budgets = compact._section_budgets(400, 0, empty_counts);
    for (const key of ["symbols", "files", "greps", "bash", "web", "glob"]) {
      expect(budgets[key]).toBe(0);
    }
  });

  it("test_content_aware_only_web_gets_allocation", () => {
    const counts = { symbols: 0, files: 0, greps: 0, bash: 0, web: 5, glob: 0 };
    const budgets = compact._section_budgets(200, 0, counts);
    expect(budgets["web"]!).toBeGreaterThan(0);
    for (const key of ["symbols", "files", "greps", "bash", "glob"]) {
      expect(budgets[key]).toBe(0);
    }
  });

  it("test_content_aware_redistributes_empty_section_budget", () => {
    const counts = { symbols: 2, files: 3, greps: 0, bash: 0, web: 0, glob: 0 };
    const budgets_aware = compact._section_budgets(600, 0, counts);
    expect(budgets_aware["symbols"]!).toBeGreaterThan(budgets_aware["files"]!);
    expect(budgets_aware["greps"]).toBe(0);
    expect(budgets_aware["bash"]).toBe(0);
    expect(budgets_aware["web"]).toBe(0);
    expect(budgets_aware["glob"]).toBe(0);
    const total_aware = Object.values(budgets_aware).reduce((s, v) => s + v, 0);
    expect(total_aware).toBeLessThanOrEqual(600);
  });

  it("test_manifest_stays_within_budget_simple_session", () => {
    const sid = "section-budget-simple";
    for (let i = 0; i < 5; i++) {
      session.mark_file_read(sid, `/proj/src/module${i}.py`, 0, 100);
    }
    session.mark_file_edited(sid, "/proj/src/app.py");
    session.mark_grep(sid, "def handle", "/proj/src");

    const budget = 200;
    const result = compact.build_manifest(sid, { max_tokens: budget });
    expect(result).toBeTruthy();
    expect(compact.estimate_tokens(result)).toBeLessThanOrEqual(budget);
  });

  it("test_manifest_stays_within_budget_saturated_session", () => {
    const sid = "section-budget-saturated";
    const saveSpy = vi.spyOn(session, "save").mockReturnValue(undefined);
    let cache: session.SessionCache | null = session.load(sid);
    for (let i = 0; i < 20; i++) {
      cache = session.mark_file_edited(sid, `/proj/src/edited_${String(i).padStart(2, "0")}.py`, { cache });
    }
    for (let i = 0; i < 15; i++) {
      cache = session.mark_file_read(sid, `/proj/src/sym_${String(i).padStart(2, "0")}.py`, null, null, {
        symbol: `fn_${i}`,
        cache,
      });
    }
    for (let i = 0; i < 20; i++) {
      cache = session.mark_file_read(sid, `/proj/src/read_${String(i).padStart(2, "0")}.py`, 0, 100, { cache });
    }
    for (let i = 0; i < 10; i++) {
      cache = session.mark_grep(sid, `pattern_${i}`, "/proj/src", null, { cache });
    }
    saveSpy.mockRestore();
    session.save(cache);

    const budget = 400;
    const result = compact.build_manifest(sid, { max_tokens: budget });
    expect(result).toBeTruthy();
    const actual = compact.estimate_tokens(result);
    expect(actual).toBeLessThanOrEqual(budget);
  });

  it("test_bash_section_included_when_files_section_is_small", () => {
    const sid = "section-budget-bash-not-crowded";
    session.mark_file_read(sid, "/proj/src/only.py", 0, 50);
    session.mark_bash_run(sid, "abc123def456", "pytest tests/ -x", "output-id-001", 2000, 100, 0, false);
    const cache = session.load(sid);
    cache.created_ts = _time() - 7200;
    session.save(cache);

    const result = compact.build_manifest(sid, { max_tokens: 400 });
    expect(result.includes("**Recent Commands:**")).toBe(true);
    expect(compact.estimate_tokens(result)).toBeLessThanOrEqual(400);
  });

  it("test_token_count_helper", () => {
    expect(compact._token_count("")).toBe(0);
    expect(compact._token_count("a".repeat(8))).toBe(2);
    expect(compact._token_count("a".repeat(100))).toBe(25);
  });
});
