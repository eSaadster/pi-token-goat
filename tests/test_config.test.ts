/**
 * Unit tests for token_goat/config. 1:1 port of the Python config test suite.
 *
 * Sources ported (the meaningful, non-CLI subset):
 *  - tests/test_config.py                  — mtime cache, unknown-section warn,
 *    WebFetch/BashCache/Hints round-trips, SkillPreservation round-trip + fwd
 *    compat, _env_int helper, _validated_int_list sorted-ascending, type
 *    validation end-to-end, WorkerMaxPoolWorkers, OverflowGuardConfig.
 *  - tests/test_config_bash_compress.py    — [bash_compress] defaults, TOML
 *    overrides, env-disable variants, round-trip.
 *  - tests/test_config_defaults_tuning.py  — compact_assist.min_events default
 *    (the repomap/worker sections pin constants in modules not yet ported, so
 *    only the config-owned min_events default is asserted here).
 *  - tests/test_config_worker_envvars.py   — TOKEN_GOAT_WORKER_WATCHDOG falsy
 *    variants, TOML/env precedence, malformed-TOML fallback.
 *
 * Sources deliberately skipped:
 *  - tests/test_config_cli.py — exercises `token-goat config get/set/list/...`
 *    via typer's CliRunner. The TS CLI layer is not yet ported; these tests
 *    land with it. (See parity_notes / known_gaps in the task report.)
 *
 * Test-seam mapping (Python → TS):
 *  - monkeypatch.setattr(paths, "config_path", lambda: tmp/"config.toml")
 *      → setConfigPathOverride(tmp + "/config.toml") from paths.js. The
 *        per-test beforeEach in setup.ts already calls clearModuleCaches(),
 *        which runs clearConfigPathOverride, so each test starts cold and the
 *        override does not leak to the next.
 *  - cfg_mod._config_mtime_cache = None
 *      → clearConfigCache() (also runs automatically via setup.ts's
 *        clearModuleCaches, but called explicitly where the Python test did so
 *        for parity).
 *  - monkeypatch.setenv / delenv
 *      → direct process.env assignment / delete. setup.ts snapshots and
 *        restores env per test, so leaks are impossible.
 *  - caplog.at_level(WARNING, logger="token_goat.config")
 *      → vi.spyOn(console, "warn") / console.info captures. The util.ts
 *        ConsoleLogger forwards WARNING→console.warn, INFO→console.info with a
 *        `[token_goat.config] <msg>` prefix, so substring assertions on the
 *        forwarded args translate directly.
 *  - os.utime(file, (t, t)) to bump mtime
 *      → fs.utimesSync(file, atime, mtime) with mtime bumped by 1s+; some
 *        filesystems have 1s mtime resolution so we force a delta exactly as
 *        the Python test did.
 *  - tmp_path fixture
 *      → setup.ts's setDataDirOverride already gives each test a throwaway
 *        data dir; we resolve per-test config files inside it via path.join.
 *
 * Every Python `def test_*` maps to a vitest `it()` with the same name and
 * assertion polarity. parametrize is unrolled into it.each where present.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  CONFIG_SCHEMA_VERSION,
  WORKER_MAX_POOL_CEILING,
  _KNOWN_SECTIONS,
  _envInt,
  _validatedBool,
  _validatedFloat,
  _validatedInt,
  _validatedIntList,
  _validatedStrList,
  clearConfigCache,
  load,
  save,
} from "../src/token_goat/config.js";
import {
  clearConfigPathOverride,
  setConfigPathOverride,
} from "../src/token_goat/paths.js";

// ---------------------------------------------------------------------------
// Per-test helpers.
// ---------------------------------------------------------------------------

/**
 * Write `body` to a tmp config file under the OS tmp dir and redirect
 * configPath() to it. Returns the file path.
 *
 * Mirrors the Python pattern of `tmp_path / "config.toml"` + monkeypatch. Uses
 * a process-unique tmp subdir so concurrent fork workers do not collide.
 */
function writeConfig(body: string, name = "config.toml"): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tg-cfg-"));
  const file = path.join(dir, name);
  fs.writeFileSync(file, body, "utf8");
  setConfigPathOverride(file);
  return file;
}

/** Non-existent config file path (for "file absent" tests). */
function missingConfigFile(name = "missing.toml"): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tg-cfg-miss-"));
  return path.join(dir, name);
}

/**
 * Snapshot of process.env taken in beforeEach and restored in afterEach.
 *
 * Python's tests used `monkeypatch.setenv`/`delenv`, which is function-scoped:
 * each test's env mutations are auto-reverted when the test ends. setup.ts's
 * own beforeEach/afterEach only snapshots+restores the two ENV_DEFAULTS keys
 * (TOKEN_GOAT_HARNESS_OVERRIDE, TOKEN_GOAT_NO_WORKER_SPAWN), so an arbitrary
 * `process.env.TOKEN_GOAT_BASH_COMPRESS = "0"` set by one test in this file
 * would leak into the next test in the same file (vitest runs tests in a single
 * fork worker per file, so they share process.env). The config suite sets
 * ~15 different TOKEN_GOAT_* env vars across its tests, so a full per-test env
 * snapshot is required to reproduce monkeypatch's function-scoped isolation.
 */
let _envSnapshot: Record<string, string | undefined> = {};

beforeEach(() => {
  // Snapshot the ENTIRE process.env so any key a test mutates is restored.
  _envSnapshot = { ...process.env };
  // setup.ts already ran clearModuleCaches (which clears the config cache and
  // the configPath override). Re-assert a cold cache + no override explicitly
  // so a test that bails before its own clearConfigCache still starts clean.
  clearConfigCache();
  clearConfigPathOverride();
});

afterEach(() => {
  // Restore process.env to its pre-test state first so teardown of later seams
  // sees the original world. Replace the entire env map: process.env assignment
  // is the canonical Node way to bulk-restore (deleting keys one-by-one misses
  // any a test added; assigning a fresh object drops the additions).
  for (const k of Object.keys(process.env)) {
    if (!(k in _envSnapshot)) delete process.env[k];
  }
  for (const [k, v] of Object.entries(_envSnapshot)) {
    if (v === undefined) {
      delete process.env[k];
    } else {
      process.env[k] = v;
    }
  }
  _envSnapshot = {};
  // Belt-and-braces: drop any override + cache a test forgot to clear.
  // setup.ts's own afterEach will also clear, but doing it here keeps the
  // failure mode local when a test throws mid-body.
  clearConfigPathOverride();
  clearConfigCache();
  vi.restoreAllMocks();
});

// ===========================================================================
// Item 1: process-level mtime cache (singleton identity).
// ===========================================================================

describe("TestConfigMtimeCache (port of tests/test_config.py)", () => {
  it("test_repeated_calls_return_same_object", () => {
    // Second call returns the cached ConfigSchema object (identity check).
    setConfigPathOverride(missingConfigFile());
    const c1 = load();
    const c2 = load();
    expect(c1).toBe(c2); // `is` →.toBe (reference equality)
  });

  it("test_cache_miss_on_mtime_change", () => {
    // Writing the config file invalidates the cache (mtime changes).
    const file = writeConfig("");
    const c1 = load();

    // Write a config that changes a value.
    fs.writeFileSync(file, "[compact_assist]\nmin_events = 7\n", "utf8");
    // Force mtime to differ (some filesystems have 1s resolution).
    const newMtime = (fs.statSync(file).mtimeMs / 1000) + 5;
    const atime = newMtime;
    fs.utimesSync(file, atime, newMtime);

    const c2 = load();
    expect(c1).not.toBe(c2);
    expect(c2.compact_assist?.min_events).toBe(7);
  });

  it("test_absent_file_cached_too", () => {
    // Absent config file also produces a cached result (mtime == 0).
    setConfigPathOverride(missingConfigFile());
    const c1 = load();
    const c2 = load();
    expect(c1).toBe(c2);
  });

  it("test_five_calls_use_single_parse", () => {
    setConfigPathOverride(missingConfigFile());
    const results: ReturnType<typeof load>[] = [];
    for (let i = 0; i < 5; i++) results.push(load());
    for (let i = 1; i < 5; i++) {
      expect(results[i]).toBe(results[0]);
    }
  });

  it("test_save_invalidates_cache", () => {
    const file = writeConfig("");
    const c1 = load();
    save(c1);
    // After save the cache must be empty so the next load() re-reads.
    // We observe this indirectly: a second load() after save must return a
    // fresh object (not the pre-save cached one).
    const c2 = load();
    expect(c2).not.toBe(c1); // cache was busted by save()
  });

  it("test_cache_tuple_has_four_fields", async () => {
    // The cache entry shape is [Config, mtime, envFingerprint, monotonic].
    // We import the live cache binding dynamically so we read the post-load
    // value (a `let` export is a live binding from the module's side).
    setConfigPathOverride(missingConfigFile());
    load();
    const { _configMtimeCache } = await import("../src/token_goat/config.js");
    expect(_configMtimeCache).toBeDefined();
    const entry = _configMtimeCache!;
    expect(entry).toHaveLength(4);
    const [, mtimeVal, envFp, monoVal] = entry;
    expect(typeof mtimeVal).toBe("number");
    expect(typeof envFp).toBe("string");
    expect(typeof monoVal).toBe("number");
    expect(monoVal).toBeGreaterThan(0);
  });
});

// ===========================================================================
// Unknown-section typo warnings.
// ===========================================================================

describe("TestConfigUnknownSectionWarning", () => {
  it("test_typo_section_emits_warning", () => {
    // Intentional typo: 'compact_assit' instead of 'compact_assist'.
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    writeConfig("[compact_assit]\nmin_events = 5\n");
    load();
    const calls = warnSpy.mock.calls.map((c) => c.map(String).join(" "));
    expect(
      calls.some((s) => s.includes("compact_assit")),
      `expected a warning mentioning 'compact_assit'; got: ${calls}`,
    ).toBe(true);
  });

  it("test_valid_sections_no_warning", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    writeConfig("[compact_assist]\nmin_events = 3\n[bash_compress]\nenabled = true\n");
    load();
    const unknownWarnings = warnSpy.mock.calls
      .map((c) => c.map(String).join(" "))
      .filter((s) => s.includes("unknown config section"));
    expect(unknownWarnings, `unexpected unknown-section warnings`).toHaveLength(0);
  });

  it("test_typo_does_not_crash_or_affect_other_sections", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    writeConfig(
      "[compact_assit]\nmin_events = 99\n[compact_assist]\nmin_events = 7\n",
    );
    const cfg = load();
    expect(cfg.compact_assist?.min_events).toBe(7);
    const calls = warnSpy.mock.calls.map((c) => c.map(String).join(" "));
    expect(calls.some((s) => s.includes("compact_assit"))).toBe(true);
  });
});

// ===========================================================================
// WebFetch config.
// ===========================================================================

describe("TestWebFetchConfig", () => {
  it("test_webfetch_defaults", () => {
    setConfigPathOverride(missingConfigFile());
    const wf = load().webfetch!;
    expect(wf.max_file_count).toBe(4096);
    expect(wf.max_bytes).toBe(32 * 1024 * 1024);
    expect(wf.allow).toEqual([]);
    expect(wf.deny).toEqual([]);
  });

  it("test_webfetch_config_from_toml", () => {
    writeConfig("[webfetch]\nmax_file_count = 2048\nmax_bytes = 16777216\n");
    const wf = load().webfetch!;
    expect(wf.max_file_count).toBe(2048);
    expect(wf.max_bytes).toBe(16777216);
  });

  it("test_webfetch_env_override_files", () => {
    writeConfig("[webfetch]\nmax_file_count = 2048\n");
    process.env.TOKEN_GOAT_WEB_CACHE_MAX_FILES = "512";
    const wf = load().webfetch!;
    expect(wf.max_file_count).toBe(512);
  });

  it("test_webfetch_env_override_bytes", () => {
    writeConfig("[webfetch]\nmax_bytes = 16777216\n");
    process.env.TOKEN_GOAT_WEB_CACHE_MAX_BYTES = "8388608";
    const wf = load().webfetch!;
    expect(wf.max_bytes).toBe(8388608);
  });
});

// ===========================================================================
// Hints round-trip.
// ===========================================================================

describe("TestHintsConfigRoundTrip", () => {
  it("test_verbose_until_seen_count_loads_from_toml", () => {
    writeConfig("[hints]\nverbose_until_seen_count = 7\n");
    expect(load().hints?.verbose_until_seen_count).toBe(7);
  });

  it("test_min_file_lines_for_hint_loads_from_toml", () => {
    writeConfig("[hints]\nmin_file_lines_for_hint = 50\n");
    expect(load().hints?.min_file_lines_for_hint).toBe(50);
  });

  it("test_all_hints_fields_survive_save_load_roundtrip", () => {
    const file = writeConfig("");
    const cfg = load();
    const h = cfg.hints!;
    h.suppress_after_ignored = 3;
    h.quiet_hours = "22:00-07:00";
    h.json_sidecar = true;
    h.verbose_until_seen_count = 5;
    h.min_file_lines_for_hint = 30;
    h.bash_dedup_min_bytes = 500;
    h.web_dedup_min_bytes = 600;
    h.grep_dedup_min_matches = 10;
    save(cfg);
    clearConfigCache();

    const reloaded = load().hints!;
    expect(reloaded.suppress_after_ignored).toBe(3);
    expect(reloaded.quiet_hours).toBe("22:00-07:00");
    expect(reloaded.json_sidecar).toBe(true);
    expect(reloaded.verbose_until_seen_count).toBe(5);
    expect(reloaded.min_file_lines_for_hint).toBe(30);
    expect(reloaded.bash_dedup_min_bytes).toBe(500);
    expect(reloaded.web_dedup_min_bytes).toBe(600);
    expect(reloaded.grep_dedup_min_matches).toBe(10);
  });
});

// ===========================================================================
// SkillPreservation round-trip + forward-compat.
// ===========================================================================

describe("TestSkillPreservationRoundTrip", () => {
  it("test_orphan_sweep_enabled_round_trips", () => {
    writeConfig("");
    const cfg = load();
    cfg.skill_preservation!.orphan_sweep_enabled = false;
    save(cfg);
    clearConfigCache();
    expect(load().skill_preservation?.orphan_sweep_enabled).toBe(false);
  });

  it("test_orphan_age_secs_round_trips", () => {
    writeConfig("");
    const cfg = load();
    cfg.skill_preservation!.orphan_age_secs = 86400;
    save(cfg);
    clearConfigCache();
    expect(load().skill_preservation?.orphan_age_secs).toBe(86400);
  });
});

describe("TestSkillPreservationForwardCompat", () => {
  it("test_unknown_key_does_not_crash", () => {
    // Unknown keys inside [skill_preservation] must be silently tolerated.
    writeConfig(
      "[skill_preservation]\nenabled = true\nfuture_key_not_yet_known = 999\nanother_future_option = \"hello\"\n",
    );
    const cfg = load();
    expect(cfg.skill_preservation?.enabled).toBe(true);
  });

  it("test_known_keys_survive_alongside_unknown", () => {
    writeConfig(
      "[skill_preservation]\ntruncation_budget_tokens = 1200\ncompress_bodies = false\ncompress_min_bytes = 8192\nunknown_future_flag = true\n",
    );
    const sp = load().skill_preservation!;
    expect(sp.truncation_budget_tokens).toBe(1200);
    expect(sp.compress_bodies).toBe(false);
    expect(sp.compress_min_bytes).toBe(8192);
  });

  it("test_all_known_keys_round_trip", () => {
    writeConfig("");
    const cfg = load();
    const sp = cfg.skill_preservation!;
    sp.enabled = true;
    sp.orphan_sweep_enabled = false;
    sp.orphan_age_secs = 172800;
    sp.truncation_budget_tokens = 600;
    sp.compress_bodies = false;
    sp.compress_min_bytes = 4096;
    save(cfg);
    clearConfigCache();

    const sp2 = load().skill_preservation!;
    expect(sp2.enabled).toBe(true);
    expect(sp2.orphan_sweep_enabled).toBe(false);
    expect(sp2.orphan_age_secs).toBe(172800);
    expect(sp2.truncation_budget_tokens).toBe(600);
    expect(sp2.compress_bodies).toBe(false);
    expect(sp2.compress_min_bytes).toBe(4096);
  });
});

// ===========================================================================
// Bash cache config.
// ===========================================================================

describe("TestBashCacheConfig", () => {
  it("test_defaults", () => {
    setConfigPathOverride(missingConfigFile());
    const bc = load().bash_compress!;
    expect(bc.cache_max_file_count).toBe(4096);
    expect(bc.cache_max_bytes).toBe(16 * 1024 * 1024);
  });

  it("test_cache_max_file_count_from_toml", () => {
    writeConfig("[bash_compress]\ncache_max_file_count = 512\n");
    expect(load().bash_compress?.cache_max_file_count).toBe(512);
  });

  it("test_cache_max_bytes_from_toml", () => {
    writeConfig("[bash_compress]\ncache_max_bytes = 8388608\n");
    expect(load().bash_compress?.cache_max_bytes).toBe(8388608);
  });

  it("test_env_override_max_files", () => {
    writeConfig("[bash_compress]\ncache_max_file_count = 2048\n");
    process.env.TOKEN_GOAT_BASH_CACHE_MAX_FILES = "256";
    expect(load().bash_compress?.cache_max_file_count).toBe(256);
  });

  it("test_env_override_max_bytes", () => {
    writeConfig("[bash_compress]\ncache_max_bytes = 8388608\n");
    process.env.TOKEN_GOAT_BASH_CACHE_MAX_BYTES = "4194304";
    expect(load().bash_compress?.cache_max_bytes).toBe(4194304);
  });

  it("test_round_trip", () => {
    writeConfig("");
    const cfg = load();
    cfg.bash_compress!.cache_max_file_count = 1024;
    cfg.bash_compress!.cache_max_bytes = 4 * 1024 * 1024;
    save(cfg);
    clearConfigCache();

    const reloaded = load().bash_compress!;
    expect(reloaded.cache_max_file_count).toBe(1024);
    expect(reloaded.cache_max_bytes).toBe(4 * 1024 * 1024);
  });

  it("test_env_override_max_files_out_of_range_ignored", () => {
    writeConfig("");
    process.env.TOKEN_GOAT_BASH_CACHE_MAX_FILES = "0";
    expect(load().bash_compress?.cache_max_file_count).toBe(4096);
  });

  it("test_env_override_max_bytes_out_of_range_ignored", () => {
    writeConfig("");
    process.env.TOKEN_GOAT_BASH_CACHE_MAX_BYTES = "0";
    expect(load().bash_compress?.cache_max_bytes).toBe(16 * 1024 * 1024);
  });
});

// ===========================================================================
// WebFetch cache config (TOML validation + env range guards).
// ===========================================================================

describe("TestWebFetchCacheConfig", () => {
  it("test_webfetch_max_file_count_from_toml", () => {
    writeConfig("[webfetch]\nmax_file_count = 128\n");
    expect(load().webfetch?.max_file_count).toBe(128);
  });

  it("test_webfetch_max_bytes_from_toml", () => {
    writeConfig("[webfetch]\nmax_bytes = 1048576\n");
    expect(load().webfetch?.max_bytes).toBe(1048576);
  });

  it("test_webfetch_max_file_count_invalid_toml_falls_back_to_default", () => {
    // Non-integer TOML value falls back to the default (via _validatedInt).
    writeConfig('[webfetch]\nmax_file_count = "lots"\n');
    expect(load().webfetch?.max_file_count).toBe(4096);
  });

  it("test_webfetch_env_override_max_files_out_of_range_ignored", () => {
    writeConfig("");
    process.env.TOKEN_GOAT_WEB_CACHE_MAX_FILES = "0";
    expect(load().webfetch?.max_file_count).toBe(4096);
  });

  it("test_webfetch_env_override_max_bytes_out_of_range_ignored", () => {
    writeConfig("");
    process.env.TOKEN_GOAT_WEB_CACHE_MAX_BYTES = "0";
    expect(load().webfetch?.max_bytes).toBe(32 * 1024 * 1024);
  });
});

// ===========================================================================
// _envInt helper (DRY consolidation).
// ===========================================================================

describe("TestEnvIntHelper", () => {
  const KEY = "TOKEN_GOAT_TEST_VAR";

  afterEach(() => {
    delete process.env[KEY];
  });

  it("test_env_int_unset_returns_default", () => {
    delete process.env[KEY];
    expect(_envInt(KEY, 42, 0, 100, "test.var")).toBe(42);
  });

  it("test_env_int_empty_string_returns_default", () => {
    process.env[KEY] = "";
    expect(_envInt(KEY, 42, 0, 100, "test.var")).toBe(42);
  });

  it("test_env_int_whitespace_only_returns_default", () => {
    process.env[KEY] = "   \t  ";
    expect(_envInt(KEY, 42, 0, 100, "test.var")).toBe(42);
  });

  it("test_env_int_valid_value_in_range", () => {
    process.env[KEY] = "75";
    expect(_envInt(KEY, 42, 0, 100, "test.var")).toBe(75);
  });

  it("test_env_int_valid_value_at_lower_bound", () => {
    process.env[KEY] = "0";
    expect(_envInt(KEY, 42, 0, 100, "test.var")).toBe(0);
  });

  it("test_env_int_valid_value_at_upper_bound", () => {
    process.env[KEY] = "100";
    expect(_envInt(KEY, 42, 0, 100, "test.var")).toBe(100);
  });

  it("test_env_int_value_below_range_returns_default", () => {
    process.env[KEY] = "-1";
    expect(_envInt(KEY, 42, 0, 100, "test.var")).toBe(42);
  });

  it("test_env_int_value_above_range_returns_default", () => {
    process.env[KEY] = "101";
    expect(_envInt(KEY, 42, 0, 100, "test.var")).toBe(42);
  });

  it("test_env_int_non_numeric_value_returns_default", () => {
    process.env[KEY] = "not-a-number";
    expect(_envInt(KEY, 42, 0, 100, "test.var")).toBe(42);
  });

  it("test_env_int_float_string_rejected", () => {
    // int() rejects float strings; the TS port matches via /^[+-]?\d+$/.
    process.env[KEY] = "75.0";
    expect(_envInt(KEY, 42, 0, 100, "test.var")).toBe(42);
  });

  it("test_env_int_float_with_decimal_rejected", () => {
    process.env[KEY] = "75.7";
    expect(_envInt(KEY, 42, 0, 100, "test.var")).toBe(42);
  });

  it("test_env_int_with_whitespace_padding", () => {
    process.env[KEY] = "  75  ";
    expect(_envInt(KEY, 42, 0, 100, "test.var")).toBe(75);
  });

  it("test_env_int_logs_on_invalid", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    process.env[KEY] = "not-a-number";
    _envInt(KEY, 42, 0, 100, "test.var");
    const calls = warnSpy.mock.calls.map((c) => c.map(String).join(" "));
    expect(calls.some((s) => s.includes("not an int"))).toBe(true);
  });

  it("test_env_int_logs_on_out_of_range", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    process.env[KEY] = "999";
    _envInt(KEY, 42, 0, 100, "test.var");
    const calls = warnSpy.mock.calls.map((c) => c.map(String).join(" "));
    expect(calls.some((s) => s.includes("out of range"))).toBe(true);
  });

  it("test_env_int_logs_on_success", () => {
    const infoSpy = vi.spyOn(console, "info").mockImplementation(() => {});
    process.env[KEY] = "75";
    _envInt(KEY, 42, 0, 100, "test.var");
    const calls = infoSpy.mock.calls.map((c) => c.map(String).join(" "));
    expect(calls.some((s) => s.includes("overridden by environment"))).toBe(true);
  });
});

// ===========================================================================
// _validatedIntList sorted-ascending contract.
// ===========================================================================

describe("TestValidatedIntListSortedAscending", () => {
  it("test_sorted_input_returned_unchanged", () => {
    expect(_validatedIntList([1, 3, 10, 30], [1, 3, 10, 30], "hints.backoff_thresholds")).toEqual([
      1, 3, 10, 30,
    ]);
  });

  it("test_unsorted_input_is_sorted_and_warns", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const result = _validatedIntList([30, 1, 10, 3], [1, 3, 10, 30], "hints.backoff_thresholds");
    expect(result).toEqual([1, 3, 10, 30]);
    const calls = warnSpy.mock.calls.map((c) => c.map(String).join(" "));
    expect(calls.some((s) => s.includes("sorted"))).toBe(true);
  });

  it("test_duplicate_values_accepted_and_sorted", () => {
    const result = _validatedIntList([10, 3, 3, 1], [1, 3, 10, 30], "hints.backoff_thresholds");
    expect(result).toEqual([...result].sort((a, b) => a - b));
  });

  it("test_empty_list_accepted_without_warning", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const result = _validatedIntList([], [1, 3, 10, 30], "hints.backoff_thresholds");
    expect(result).toEqual([]);
    const calls = warnSpy.mock.calls.map((c) => c.map(String).join(" "));
    expect(calls.some((s) => s.includes("sorted"))).toBe(false);
  });

  it("test_backoff_thresholds_loaded_from_toml_out_of_order", () => {
    writeConfig("[hints]\nbackoff_thresholds = [30, 10, 3, 1]\n");
    expect(load().hints?.backoff_thresholds).toEqual([1, 3, 10, 30]);
  });

  it("test_max_manifest_chars_zero_is_valid", () => {
    writeConfig("[compact_assist]\nmax_manifest_chars = 0\n");
    expect(load().compact_assist?.max_manifest_chars).toBe(0);
  });

  it("test_cache_min_bytes_zero_is_valid", () => {
    writeConfig("[bash_compress]\ncache_min_bytes = 0\n");
    expect(load().bash_compress?.cache_min_bytes).toBe(0);
  });
});

// ===========================================================================
// _validatedNumeric / _validatedInt / _validatedFloat / _validatedBool.
// ===========================================================================

describe("TestValidatedNumeric", () => {
  const vi_ = (val: unknown, def: number, lo: number, hi: number) =>
    _validatedInt(val, def, lo, hi, "test.field");
  const vf = (val: unknown, def: number, lo: number, hi: number) =>
    _validatedFloat(val, def, lo, hi, "test.field");

  it("test_int_valid_value", () => expect(vi_(5, 3, 0, 10)).toBe(5));
  it("test_int_coerces_from_string", () => expect(vi_("7", 3, 0, 10)).toBe(7));
  it("test_int_coerces_from_float", () => expect(vi_(4.9, 3, 0, 10)).toBe(4));
  it("test_int_rejects_bool", () => expect(vi_(true, 3, 0, 10)).toBe(3));
  it("test_int_rejects_out_of_range", () => expect(vi_(99, 3, 0, 10)).toBe(3));
  it("test_int_rejects_non_numeric_string", () => expect(vi_("bad", 3, 0, 10)).toBe(3));
  it("test_int_rejects_list", () => expect(vi_([1, 2], 3, 0, 10)).toBe(3));

  it("test_float_valid_value", () => expect(vf(1.5, 1.0, 0.0, 2.0)).toBe(1.5));
  it("test_float_coerces_from_string", () => expect(vf("0.8", 1.0, 0.0, 2.0)).toBeCloseTo(0.8));
  it("test_float_rejects_bool", () => expect(vf(false, 1.0, 0.0, 2.0)).toBe(1.0));
  it("test_float_rejects_out_of_range", () => expect(vf(5.0, 1.0, 0.0, 2.0)).toBe(1.0));
  it("test_float_boundary_values_accepted", () => {
    expect(vf(0.0, 1.0, 0.0, 2.0)).toBe(0.0);
    expect(vf(2.0, 1.0, 0.0, 2.0)).toBe(2.0);
  });
});

// ===========================================================================
// End-to-end type validation via load().
// ===========================================================================

describe("TestConfigTypeValidationEndToEnd", () => {
  /** Write toml to a tmp file, load, return Config. Cache is cleared first. */
  function loadFromToml(toml: string): ReturnType<typeof load> {
    clearConfigCache();
    writeConfig(toml);
    const cfg = load();
    clearConfigCache();
    return cfg;
  }

  it("test_auto_trigger_multiplier_string_falls_back_to_default", () => {
    const cfg = loadFromToml('[compact_assist]\nauto_trigger_multiplier = "banana"\n');
    expect(cfg.compact_assist?.auto_trigger_multiplier).toBe(2.0);
  });

  it("test_auto_trigger_multiplier_bool_falls_back_to_default", () => {
    const cfg = loadFromToml("[compact_assist]\nauto_trigger_multiplier = true\n");
    expect(cfg.compact_assist?.auto_trigger_multiplier).toBe(2.0);
  });

  it("test_auto_trigger_multiplier_out_of_range_falls_back_to_default", () => {
    const cfg = loadFromToml("[compact_assist]\nauto_trigger_multiplier = 99.9\n");
    expect(cfg.compact_assist?.auto_trigger_multiplier).toBe(2.0);
  });

  it("test_min_events_string_falls_back_to_default", () => {
    const cfg = loadFromToml('[compact_assist]\nmin_events = "lots"\n');
    expect(cfg.compact_assist?.min_events).toBe(3);
  });

  it("test_max_manifest_tokens_bool_falls_back_to_default", () => {
    const cfg = loadFromToml("[compact_assist]\nmax_manifest_tokens = false\n");
    expect(cfg.compact_assist?.max_manifest_tokens).toBe(400);
  });

  it("test_watchdog_ms_string_falls_back_to_default", () => {
    const cfg = loadFromToml('[hooks]\nwatchdog_ms = "fast"\n');
    expect(cfg.hooks?.watchdog_ms).toBe(5000);
  });

  it("test_enabled_int_coerced_to_bool", () => {
    // `enabled = 0` (TOML integer) coerces to false without a warning.
    const cfg = loadFromToml("[compact_assist]\nenabled = 0\n");
    expect(cfg.compact_assist?.enabled).toBe(false);
  });

  it("test_enabled_string_falls_back_to_default", () => {
    // `enabled = "yes"` (string, not TOML bool) uses default true.
    const cfg = loadFromToml('[compact_assist]\nenabled = "yes"\n');
    expect(cfg.compact_assist?.enabled).toBe(true);
  });

  it("test_bad_type_values_log_warning", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    clearConfigCache();
    writeConfig('[compact_assist]\nauto_trigger_multiplier = "banana"\n');
    load();
    const msgs = warnSpy.mock.calls.map((c) => c.map(String).join(" "));
    expect(
      msgs.some((s) => s.includes("auto_trigger_multiplier")),
      `expected a WARNING about 'auto_trigger_multiplier'; got: ${msgs}`,
    ).toBe(true);
    clearConfigCache();
  });

  it("test_valid_toml_overrides_are_applied", () => {
    const cfg = loadFromToml(
      "[compact_assist]\nmin_events = 7\nauto_trigger_multiplier = 3.5\n",
    );
    expect(cfg.compact_assist?.min_events).toBe(7);
    expect(cfg.compact_assist?.auto_trigger_multiplier).toBe(3.5);
  });
});

// ===========================================================================
// Worker.max_pool_workers — load, env, ceiling.
// ===========================================================================

describe("TestWorkerMaxPoolWorkers", () => {
  function loadFromToml(toml: string): ReturnType<typeof load> {
    clearConfigCache();
    writeConfig(toml);
    const cfg = load();
    clearConfigCache();
    return cfg;
  }

  it("test_default_is_four", () => {
    expect(loadFromToml("").worker?.max_pool_workers).toBe(4);
  });

  it("test_toml_value_is_respected", () => {
    expect(loadFromToml("[worker]\nmax_pool_workers = 2\n").worker?.max_pool_workers).toBe(2);
  });

  it("test_toml_value_above_ceiling_falls_back_to_default", () => {
    const above = WORKER_MAX_POOL_CEILING + 10;
    // _validatedInt rejects out-of-range → default 4.
    expect(loadFromToml(`[worker]\nmax_pool_workers = ${above}\n`).worker?.max_pool_workers).toBe(4);
  });

  it("test_env_override_applied", () => {
    process.env.TOKEN_GOAT_WORKER_MAX_POOL = "3";
    expect(loadFromToml("").worker?.max_pool_workers).toBe(3);
  });

  it("test_env_override_out_of_range_uses_default", () => {
    const above = WORKER_MAX_POOL_CEILING + 100;
    process.env.TOKEN_GOAT_WORKER_MAX_POOL = String(above);
    expect(loadFromToml("").worker!.max_pool_workers).toBeLessThanOrEqual(WORKER_MAX_POOL_CEILING);
  });

  it("test_ceiling_constant_is_eight", () => {
    expect(WORKER_MAX_POOL_CEILING).toBe(8);
  });

  it("test_save_roundtrip_preserves_max_pool_workers", () => {
    writeConfig("");
    const base = load();
    base.worker!.max_pool_workers = 2;
    save(base);
    clearConfigCache();
    expect(load().worker?.max_pool_workers).toBe(2);
  });
});

// ===========================================================================
// OverflowGuardConfig.
// ===========================================================================

describe("TestOverflowGuardConfig", () => {
  it("test_defaults", () => {
    setConfigPathOverride(missingConfigFile());
    const og = load().overflow_guard!;
    expect(og.enabled).toBe(true);
    expect(og.max_tokens).toBe(25000);
  });

  it("test_section_is_known", () => {
    expect(_KNOWN_SECTIONS.has("overflow_guard")).toBe(true);
  });

  it("test_enabled_from_toml", () => {
    writeConfig("[overflow_guard]\nenabled = false\n");
    expect(load().overflow_guard?.enabled).toBe(false);
  });

  it("test_max_tokens_from_toml", () => {
    writeConfig("[overflow_guard]\nmax_tokens = 12000\n");
    expect(load().overflow_guard?.max_tokens).toBe(12000);
  });

  it("test_env_disable", () => {
    writeConfig("[overflow_guard]\nenabled = true\n");
    process.env.TOKEN_GOAT_OVERFLOW_GUARD = "0";
    expect(load().overflow_guard?.enabled).toBe(false);
  });

  it("test_env_max_tokens_override", () => {
    writeConfig("[overflow_guard]\nmax_tokens = 25000\n");
    process.env.TOKEN_GOAT_OVERFLOW_MAX_TOKENS = "500";
    expect(load().overflow_guard?.max_tokens).toBe(500);
  });

  it("test_round_trip", () => {
    writeConfig("");
    const cfg = load();
    cfg.overflow_guard!.enabled = false;
    cfg.overflow_guard!.max_tokens = 1234;
    save(cfg);
    clearConfigCache();
    const reloaded = load().overflow_guard!;
    expect(reloaded.enabled).toBe(false);
    expect(reloaded.max_tokens).toBe(1234);
  });
});

// ===========================================================================
// [bash_compress] section (port of test_config_bash_compress.py).
// ===========================================================================

describe("TestBashCompressDefaults (from test_config_bash_compress.py)", () => {
  it("test_load_no_toml", () => {
    setConfigPathOverride(missingConfigFile());
    delete process.env.TOKEN_GOAT_BASH_COMPRESS;
    const bc = load().bash_compress!;
    expect(bc.enabled).toBe(true);
    expect(bc.disabled_filters).toEqual([]);
  });
});

describe("TestBashCompressTomlOverrides", () => {
  // All tests in this class delenv TOKEN_GOAT_BASH_COMPRESS so an ambient env
  // var can never flip the section off unexpectedly.
  beforeEach(() => delete process.env.TOKEN_GOAT_BASH_COMPRESS);

  it("test_disable_via_toml", () => {
    writeConfig("[bash_compress]\nenabled = false\n");
    expect(load().bash_compress?.enabled).toBe(false);
  });

  it("test_disabled_filters_list", () => {
    writeConfig('[bash_compress]\ndisabled_filters = ["pytest", "docker"]\n');
    expect(load().bash_compress?.disabled_filters).toEqual(["pytest", "docker"]);
  });

  it("test_non_string_filter_entries_dropped", () => {
    writeConfig('[bash_compress]\ndisabled_filters = ["git", 42, "npm"]\n');
    expect(load().bash_compress?.disabled_filters).toEqual(["git", "npm"]);
  });

  it("test_max_lines_override", () => {
    writeConfig("[bash_compress]\nmax_lines = 250\n");
    expect(load().bash_compress?.max_lines).toBe(250);
  });

  it("test_max_lines_clamped_to_valid_range", () => {
    // Below lo bound (50) → falls back to default 1000.
    writeConfig("[bash_compress]\nmax_lines = 10\n");
    expect(load().bash_compress?.max_lines).toBe(1000);
  });

  it("test_max_bytes_override", () => {
    writeConfig("[bash_compress]\nmax_bytes = 32768\n");
    expect(load().bash_compress?.max_bytes).toBe(32768);
  });

  it("test_timeout_override", () => {
    writeConfig("[bash_compress]\ntimeout_seconds = 30\n");
    expect(load().bash_compress?.timeout_seconds).toBe(30);
  });
});

describe("TestBashCompressEnvOverride", () => {
  // Python used @pytest.mark.parametrize("val", ["0","false","no","off"]).
  it.each(["0", "false", "no", "off"])("test_env_var_disables val=%s", (val) => {
    setConfigPathOverride(missingConfigFile());
    process.env.TOKEN_GOAT_BASH_COMPRESS = val;
    expect(load().bash_compress?.enabled).toBe(false);
  });

  it("test_env_truthy_does_not_force_enable", () => {
    // Even with env set to "1", a TOML enabled=false must win — env only
    // flips false; truthy values do not override TOML.
    writeConfig("[bash_compress]\nenabled = false\n");
    process.env.TOKEN_GOAT_BASH_COMPRESS = "1";
    expect(load().bash_compress?.enabled).toBe(false);
  });
});

describe("TestRoundTrip (bash_compress)", () => {
  it("test_save_then_load_preserves_bash_compress", () => {
    writeConfig("");
    delete process.env.TOKEN_GOAT_BASH_COMPRESS;
    const cfg = load();
    cfg.bash_compress!.disabled_filters = ["docker", "kubectl"];
    cfg.bash_compress!.max_lines = 500;
    cfg.bash_compress!.timeout_seconds = 120;
    save(cfg);
    clearConfigCache();

    const reloaded = load().bash_compress!;
    expect(reloaded.disabled_filters).toEqual(["docker", "kubectl"]);
    expect(reloaded.max_lines).toBe(500);
    expect(reloaded.timeout_seconds).toBe(120);
  });
});

// ===========================================================================
// Default-tuning pins (port of test_config_defaults_tuning.py — config-owned
// subset only; repomap._AUTO_COMPACT_BUDGET and worker.PERIODIC_REINDEX_MAX_FILES
// live in modules not yet ported).
// ===========================================================================

describe("TestCompactAssistMinEventsDefault (from test_config_defaults_tuning.py)", () => {
  it("test_load_returns_three_when_no_toml", () => {
    setConfigPathOverride(missingConfigFile());
    expect(load().compact_assist?.min_events).toBe(3);
  });

  it("test_toml_override_to_legacy_value_still_works", () => {
    writeConfig("[compact_assist]\nmin_events = 5\n");
    expect(load().compact_assist?.min_events).toBe(5);
  });

  it("test_toml_override_to_zero_disables_threshold", () => {
    writeConfig("[compact_assist]\nmin_events = 0\n");
    expect(load().compact_assist?.min_events).toBe(0);
  });
});

// ===========================================================================
// Worker env-var overrides (port of test_config_worker_envvars.py).
// ===========================================================================

describe("TestWorkerWatchdogEnvVar (from test_config_worker_envvars.py)", () => {
  beforeEach(() => writeConfig(""));

  it("test_watchdog_enabled_by_default", () => {
    delete process.env.TOKEN_GOAT_WORKER_WATCHDOG;
    expect(load().worker?.watchdog_enabled).toBe(true);
  });

  it.each(["0", "false", "no", "off"])("test_watchdog_disabled_by_env_%s", (val) => {
    process.env.TOKEN_GOAT_WORKER_WATCHDOG = val;
    expect(load().worker?.watchdog_enabled).toBe(false);
  });

  it("test_watchdog_toml_false_kept_without_env", () => {
    writeConfig("[worker]\nwatchdog_enabled = false\n");
    delete process.env.TOKEN_GOAT_WORKER_WATCHDOG;
    expect(load().worker?.watchdog_enabled).toBe(false);
  });

  it("test_watchdog_env_overrides_toml_true", () => {
    writeConfig("[worker]\nwatchdog_enabled = true\n");
    process.env.TOKEN_GOAT_WORKER_WATCHDOG = "0";
    expect(load().worker?.watchdog_enabled).toBe(false);
  });
});

describe("TestMalformedTomlFallsBackToDefaults", () => {
  it("test_malformed_toml_returns_default_config", () => {
    writeConfig("this is not valid toml = [[[\n");
    // Must not throw — load() catches TomlError and uses defaults.
    const cfg = load();
    expect(cfg.worker?.watchdog_enabled).toBe(true);
    expect(cfg.worker?.max_pool_workers).toBe(4);
  });

  it("test_malformed_toml_logs_warning", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    writeConfig("[broken\n");
    load();
    const msgs = warnSpy.mock.calls.map((c) => c.map(String).join(" "));
    expect(
      msgs.some((s) => s.includes("load failed")),
      `expected a warning about config load failure; got: ${msgs}`,
    ).toBe(true);
  });
});

// ===========================================================================
// Additional sanity: schema_version + full save/load of every persisted section.
// ===========================================================================

describe("TestConfigSchemaVersion (config.ts parity extras)", () => {
  it("CONFIG_SCHEMA_VERSION is 1", () => {
    expect(CONFIG_SCHEMA_VERSION).toBe(1);
  });

  it("save writes schema_version = 1 to the TOML file", () => {
    const file = writeConfig("");
    const cfg = load();
    save(cfg);
    clearConfigCache();
    const text = fs.readFileSync(file, "utf8");
    expect(text).toMatch(/schema_version\s*=\s*1/);
  });

  it("_KNOWN_SECTIONS includes every section the loader builds", () => {
    // Guards the two-place update bug: a section added to load()/save() but
    // missing from _KNOWN_SECTIONS would be flagged as unknown on every load.
    const expected = new Set([
      "schema_version",
      "compact_assist",
      "bash_compress",
      "session_brief",
      "skill_preservation",
      "image_shrink",
      "curator",
      "hint_budget",
      "repomap",
      "overflow_guard",
      "stats",
      "hints",
      "hooks",
      "webfetch",
      "worker",
      "indexing",
      "compression",
      "context",
      "bash_diff",
      "bash_severity_log",
    ]);
    for (const s of expected) {
      expect(_KNOWN_SECTIONS.has(s), `missing known section: ${s}`).toBe(true);
    }
  });
});

describe("TestConfigCacheBustsOnEnvChange (config.ts parity extra)", () => {
  it("changing a config env var between loads returns a fresh Config", () => {
    setConfigPathOverride(missingConfigFile());
    const c1 = load();
    // Setting a config-affecting env var must bust the cache (the fingerprint
    // is part of the cache key), so the next load returns a new object.
    process.env.TOKEN_GOAT_BASH_COMPRESS = "0";
    const c2 = load();
    expect(c2).not.toBe(c1);
    expect(c2.bash_compress?.enabled).toBe(false);
  });
});

// ===========================================================================
// _validatedStrList direct unit coverage (parity with Python's implicit tests).
// ===========================================================================

describe("TestValidatedStrList (config.ts parity extra)", () => {
  it("returns default copy when val is not an array", () => {
    expect(_validatedStrList("nope", ["a", "b"], "test.field")).toEqual(["a", "b"]);
  });

  it("drops non-string entries", () => {
    expect(_validatedStrList(["a", 1, "b", true], [], "test.field")).toEqual(["a", "b"]);
  });

  it("accepts empty list as meaningful", () => {
    expect(_validatedStrList([], ["default"], "test.field")).toEqual([]);
  });
});

describe("TestValidatedBool (config.ts parity extra)", () => {
  it("accepts bool directly", () => {
    expect(_validatedBool(true, false, "x")).toBe(true);
    expect(_validatedBool(false, true, "x")).toBe(false);
  });

  it("coerces int 0 to false, non-zero to true", () => {
    expect(_validatedBool(0, true, "x")).toBe(false);
    expect(_validatedBool(5, false, "x")).toBe(true);
  });

  it("falls back to default for other types", () => {
    expect(_validatedBool("yes", true, "x")).toBe(true);
    expect(_validatedBool("no", true, "x")).toBe(true); // string → default (true)
  });
});
